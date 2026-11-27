/**
 * ============================================================================
 * FILE: user-memory-scheduler.ts
 * LOCATION: backend/src/chat-runtime/user-memory-scheduler.ts
 * PURPOSE: Batch eligible finalized chat turns off the model and transport paths.
 * ROLE IN PROJECT: Coordinates the shared writer and independent session watermark.
 * KEY COMPONENTS: Bounded per-session queue, idle timer, projection, cancellation, and
 * userChanged (drop queued turns after a user edit or delete, keep the watermark).
 * ============================================================================
 */
import { hasDisallowedControlChars, hasSecretPattern } from '../contracts/personalization.js';
import { SpeechProse } from '../voice/agent/speech-prose.js';
import { UserMemoryFault } from '../personalization/errors.js';
import type { MemoryWriterDeltaMessage, MemoryWriterScope } from '../personalization/memory-writer.js';
import { diagnose, type DiagnosticSink } from './ports.js';

export const USER_MEMORY_IDLE_MS = 120_000;
const BATCH = 8;
const MAX_SESSIONS = 32;
const MAX_PENDING_TURNS = 24;
export type PassiveTurn = { turnId: string; messageId: string; sequence: number; version: number;
  userText: string; assistantText: string };
type Slot = { userId: string; sessionId: string; queue: PassiveTurn[]; seen: number; idleAt: number;
  failures: number; running: boolean; overflowed: boolean; urgent: boolean; wake?: ReturnType<typeof setTimeout>;
  abort: AbortController; batch?: { turns: PassiveTurn[]; changed?: boolean; mark?: PassiveTurn } };
type Options = {
  enabled(userId: string): boolean;
  synthesize(userId: string, delta: readonly MemoryWriterDeltaMessage[], scope: MemoryWriterScope):
    Promise<{ changed: boolean }>;
  publish(userId: string, sessionId: string, last: PassiveTurn, changed: boolean,
    signal: AbortSignal, mark?: PassiveTurn): Promise<void>;
  report?: DiagnosticSink;
  /** Subscribe to confirmed user-initiated memory changes (UserMemoryService.onUserChange). */
  userChanges?: (listener: (userId: string) => void) => () => void;
};

const safe = (text: string) => !hasDisallowedControlChars(text) && !hasSecretPattern(text);
function project(turn: PassiveTurn): MemoryWriterDeltaMessage[] {
  if (!turn.userText.trim() || !safe(turn.userText)) return [];
  const result: MemoryWriterDeltaMessage[] = [{ role: 'user', content: turn.userText }];
  if (!turn.assistantText || !safe(turn.assistantText)) return result;
  const prose = new SpeechProse(turn.assistantText.length, undefined, () => false);
  const assistant = Array.from((prose.push(turn.assistantText) + prose.finish()).trim()).slice(0, 400).join('');
  if (assistant && safe(assistant)) result.push({ role: 'assistant', content: assistant });
  return result;
}

export class UserMemoryScheduler {
  private readonly slots = new Map<string, Slot>();
  private closed = false;
  private readonly unsubscribe?: () => void;
  constructor(private readonly options: Options) {
    this.unsubscribe = options.userChanges?.(userId => this.userChanged(userId));
  }
  private key(u: string, s: string) { return JSON.stringify([u, s]); }

  // Callers supply only trusted, successful non-Dev, non-temporary turns.
  completed(u: string, s: string, watermark: number, turn: PassiveTurn): void {
    if (this.closed) return;
    if (!this.options.enabled(u)) { this.cancel(u, s); return; }
    const key = this.key(u, s);
    let slot = this.slots.get(key);
    if (!slot && turn.sequence > watermark) {
      if (this.slots.size >= MAX_SESSIONS) // Slots emptied by userChanged are dormant, not work.
        for (const idle of this.slots.values()) if (!idle.queue.length && !idle.running) this.cancel(idle.userId, idle.sessionId);
      if (this.slots.size >= MAX_SESSIONS) {
        diagnose(this.options.report, { stage: 'runtime-error', state: 'skipped', code: 'CONCURRENCY_LIMIT' });
        return;
      }
      slot = { userId: u, sessionId: s, queue: [], seen: watermark, idleAt: 0, failures: 0,
        running: false, overflowed: false, urgent: false, abort: new AbortController() };
      this.slots.set(key, slot);
    }
    if (!slot || turn.sequence <= Math.max(slot.seen, watermark)) return;
    slot.seen = turn.sequence;
    slot.idleAt = Date.now() + USER_MEMORY_IDLE_MS;
    if (slot.failures >= 2) slot.failures = 0;
    // ponytail: bounded per-process best effort; do not skip over a dropped
    // range in the same process. A durable eligible-turn index would permit catch-up.
    if (slot.overflowed || slot.queue.length >= MAX_PENDING_TURNS) {
      if (!slot.overflowed)
        diagnose(this.options.report, { stage: 'runtime-error', state: 'skipped', code: 'STORAGE_BUDGET_EXCEEDED' });
      slot.overflowed = true;
      if (!slot.wake && slot.queue.length) this.arm(slot, USER_MEMORY_IDLE_MS);
      return;
    }
    slot.queue.push(turn);
    this.arm(slot, slot.urgent || slot.queue.length >= BATCH ? 0 : USER_MEMORY_IDLE_MS);
  }

  compacting(u: string, s: string): void {
    const slot = this.slots.get(this.key(u, s));
    if (slot?.queue.length) { slot.urgent = true; this.arm(slot, 0); }
  }

  cancel(u: string, s: string): void {
    const key = this.key(u, s), slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    clearTimeout(slot.wake);
    slot.abort.abort();
  }
  // A user edit or delete: queued and in-flight passive batches could re-learn a fact the user
  // just removed. Drop them and keep each slot's `seen` watermark so those turns are not replayed;
  // facts the user states again in later turns are learned again.
  userChanged(u: string): void {
    for (const slot of this.slots.values()) {
      if (slot.userId !== u) continue;
      clearTimeout(slot.wake);
      slot.wake = undefined;
      slot.abort.abort();
      slot.abort = new AbortController();
      slot.queue = [];
      slot.batch = undefined;
      slot.overflowed = false;
      slot.urgent = false;
      slot.failures = 0;
    }
  }
  deactivate(u: string): void {
    for (const slot of [...this.slots.values()]) if (slot.userId === u) this.cancel(u, slot.sessionId);
  }
  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    for (const slot of [...this.slots.values()]) this.cancel(slot.userId, slot.sessionId);
  }

  private arm(slot: Slot, delay: number): void {
    if (this.closed || slot.abort.signal.aborted || slot.running || slot.failures >= 2) return;
    clearTimeout(slot.wake);
    slot.wake = setTimeout(() => { slot.wake = undefined; void this.run(slot); }, delay);
    slot.wake.unref?.();
  }
  private async run(slot: Slot): Promise<void> {
    const { userId, sessionId, abort: { signal } } = slot;
    if (signal.aborted || slot.running || slot.failures >= 2 || !slot.queue.length) return;
    if (!this.options.enabled(userId)) { this.cancel(userId, sessionId); return; }
    slot.running = true;
    slot.urgent = false;
    const batch = slot.batch ??= { turns: slot.queue.slice(0, BATCH) };
    const last = batch.turns.at(-1)!;
    try {
      if (batch.changed === undefined) {
        const projected = batch.turns.map(turn => ({ turn, messages: project(turn) }));
        const usable = projected.filter(row => row.messages.length > 0);
        const delta = usable.flatMap(row => row.messages);
        batch.mark = usable.at(-1)?.turn;
        batch.changed = delta.length > 0 &&
          (await this.options.synthesize(userId, delta, { sessionId, turnId: batch.mark!.turnId, signal })).changed;
      }
      if (signal.aborted) return;
      if (!this.options.enabled(userId)) { this.cancel(userId, sessionId); return; }
      if (batch.changed && batch.mark && batch.mark !== last)
        await this.options.publish(userId, sessionId, last, true, signal, batch.mark);
      else await this.options.publish(userId, sessionId, last, batch.changed, signal);
      if (signal.aborted) return;
      slot.queue.splice(0, batch.turns.length);
      slot.batch = undefined;
      slot.failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof UserMemoryFault && error.code === 'MEMORY_DISABLED') {
        this.cancel(userId, sessionId); return;
      }
      slot.failures++;
      diagnose(this.options.report, { stage: 'runtime-error', state: 'error',
        code: batch.changed === undefined ? 'PROVIDER_ERROR' : 'PERSISTENCE_ERROR' });
    } finally {
      slot.running = false;
      const live = !slot.abort.signal.aborted;
      if (live && slot.queue.length)
        this.arm(slot, slot.failures ? USER_MEMORY_IDLE_MS : (slot.urgent || slot.queue.length >= BATCH)
          ? 0 : Math.max(0, slot.idleAt - Date.now()));
      else if (live && !slot.overflowed) this.slots.delete(this.key(userId, sessionId));
    }
  }
}
