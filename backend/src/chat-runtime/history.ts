/**
 * ============================================================================
 * FILE: history.ts
 * LOCATION: backend/src/chat-runtime/history.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Read complete bounded archives and discover latest-turn attempts.
 *
 * ROLE IN PROJECT:
 *    Prevents newest-page context selection by paging the full session archive
 *    and reconstructing accepted history from markers and terminal attempts.
 *
 * KEY COMPONENTS:
 *    - attemptsFor/archiveRecords: Bounded full-collection page walks.
 *    - acceptedHistory: Marker-confirmed users and non-truncated assistants.
 *    - latestAttempt: Current attempt for a logical turn.
 *    - supersededIds/contextRecords: Edit/regenerate exclusion for model context.
 *    - reviseRefusal: Ordered guards shared by MemoryText.retry and DurableChatRuntime.acceptRetry.
 * ============================================================================
 */

import type { PersistenceBundle } from '../persistence/persistence.js';
import type { MessageRecord } from '../contracts/message.js';
import type { AttemptRecord } from '../contracts/attempt.js';
import { eligible } from '../context/reference-selection.js';
import { AppError } from '../platform/errors/app-error.js';
export async function attemptsFor(p: PersistenceBundle, u: string, s: string): Promise<AttemptRecord[]> {
  let cursor: string | null = null;
  const out: AttemptRecord[] = [];
  for (let page = 0; page < 100; page++) {
    const found = await p.metadata.listAttempts(u, s, { cursor, limit: p.metadata.budgets.maxPageSize });
    out.push(...found.items); cursor = found.nextCursor;
    if (!cursor) return out.sort((a, b) => b.sequence - a.sequence);
  }
  throw new AppError('STORAGE_BUDGET_EXCEEDED', 'This chat has reached its record limit. Start a new chat.');
}
export async function archiveRecords(p: PersistenceBundle, u: string, s: string): Promise<MessageRecord[]> {
  let cursor: string | null = null;
  const out: MessageRecord[] = [];
  for (let page = 0; page < 100; page++) {
    const found = await p.messages.listForContext(u, s, { cursor, limit: p.messages.budgets.maxPageSize });
    out.push(...found.items);
    cursor = found.nextCursor;
    if (!cursor) return out.sort((a, b) => a.sequence - b.sequence);
  }
  throw new AppError('STORAGE_BUDGET_EXCEEDED', 'This chat has reached its record limit. Start a new chat.');
}
export async function acceptedHistory(p: PersistenceBundle, u: string, s: string): Promise<MessageRecord[]> {
  const [attemptsResult, archiveResult] = await Promise.allSettled([
    attemptsFor(p, u, s),
    archiveRecords(p, u, s),
  ]);
  if (attemptsResult.status === 'rejected') throw attemptsResult.reason;
  if (archiveResult.status === 'rejected') throw archiveResult.reason;
  const attempts = attemptsResult.value;
  const rawRecords = archiveResult.value;

  const accepted = new Set<string>();
  const completed = new Set<string>();
  const terminalLive = new Set<string>();
  const markers = new Map<string, Awaited<ReturnType<typeof p.metadata.getAcceptance>>>();
  const bulk = typeof p.metadata.getAcceptances === 'function';
  if (bulk) {
    for (let i = 0; i < attempts.length; i += 500) {
      for (const marker of await p.metadata.getAcceptances(u, s, attempts.slice(i, i + 500).map(a => a.attemptId)))
        markers.set(marker.attemptId, marker);
    }
  }
  for (const a of attempts) {
    const marker = bulk ? markers.get(a.attemptId) : await p.metadata.getAcceptance(u, s, a.attemptId);
    if (marker && marker.turnId === a.turnId && marker.userMessageId === a.causal.userMessageId && marker.payloadHash === a.payloadHash)
      accepted.add(marker.userMessageId);
    if (a.status === 'completed' && !a.truncated) completed.add(a.attemptId);
    if (['completed', 'truncated', 'cancelled', 'interrupted', 'failed'].includes(a.status)) terminalLive.add(a.attemptId);
  }
  return contextRecords(rawRecords).filter(m => eligible(m) && (m.role === 'user' ? accepted.has(m.messageId)
    : m.visibility === 'internal' && m.mode === 'live' ? terminalLive.has(m.attemptId!) : completed.has(m.attemptId!)));
}
export async function latestAttempt(p: PersistenceBundle, u: string, s: string, t: string): Promise<AttemptRecord> {
  const a = typeof p.metadata.latestAttempt === 'function' ? await p.metadata.latestAttempt(u, s, t)
    : (await attemptsFor(p, u, s)).find(item => item.turnId === t);
  if (!a) throw new AppError('NOT_FOUND', 'Turn not found.');
  return a;
}

/**
 * Edit/regenerate bookkeeping (Release 1 Unit B). A record is never modified;
 * a newer record names the one it replaces. `supersedes` is a local shape until
 * the contract field lands (Unit 0); swap this alias for MessageRecord then.
 */
export type RevisableRecord = MessageRecord & { supersedes?: string };

/**
 * Ids hidden from model context: every id named by a `supersedes`, and when the
 * replaced record is a user message (an edit) the whole replaced turn.
 */
export function supersededIds(records: readonly RevisableRecord[]): Set<string> {
  const byId = new Map(records.map(r => [r.messageId, r]));
  const out = new Set<string>();
  for (const r of records) {
    if (!r.supersedes) continue;
    out.add(r.supersedes);
    const old = byId.get(r.supersedes);
    if (old?.role === 'user') for (const x of records) if (x.turnId === old.turnId) out.add(x.messageId);
  }
  return out;
}

/**
 * History eligible as model context. Drops superseded records and, for the turn
 * being generated, any assistant output: selectReferences accepts only that
 * turn's user input, so a regenerate must not see its own earlier answer.
 */
export function contextRecords<T extends RevisableRecord>(records: readonly T[], currentTurnId?: string): T[] {
  const hidden = supersededIds(records);
  return records.filter(r => !hidden.has(r.messageId) && !(r.turnId === currentTurnId && r.role !== 'user'));
}

/** Shared per-turn attempt cap (decision D5): retry, regenerate and edit-of-turn attempts. */
export const MAX_ATTEMPTS_PER_TURN = 5;

export type ReviseFacts = {
  kind: 'regenerate' | 'edit';
  epochMatches: boolean;
  targetTurnId: string; latestTurnId: string | null;
  targetSequence: number; compactedThroughSequence: number | null;
  activeAttempt: boolean; attemptsOnTurn: number;
  /** Prior attempt state; regenerate allows any terminal state, never an unfinished one. */
  priorTerminal: boolean;
  isLiveOrCanvasOnly: boolean;
  originalContent: string; newContent?: string;
  validate: (content: string) => void;
};
export type ReviseRefusal = { code: string; message: string; retryable: boolean };

/**
 * Guard order per plan 6.2. Returns the first refusal, or null. Codes outside
 * the current AppErrorCode union are mapped by the caller until Unit 0 lands.
 * validate() throws AppError itself (INVALID_REQUEST / INPUT_TOO_LARGE).
 */
export function reviseRefusal(f: ReviseFacts): ReviseRefusal | null {
  const no = (code: string, message: string, retryable = false) => ({ code, message, retryable });
  if (!f.epochMatches) return no('INTERRUPTED', 'This request belongs to an earlier server session; its outcome is unknown.');
  if (f.isLiveOrCanvasOnly) return no('INVALID_REQUEST', 'This message cannot be revised.');
  if (f.latestTurnId !== f.targetTurnId) return no('REVISION_NOT_LATEST', 'Only the latest message can be changed.');
  if (f.compactedThroughSequence !== null && f.targetSequence <= f.compactedThroughSequence)
    return no('REVISION_TOO_OLD', 'This message is part of a summarised earlier conversation and cannot be edited.');
  if (f.activeAttempt || !f.priorTerminal) return no('CONFLICT_ACTIVE_TURN', 'Another turn is active.');
  if (f.attemptsOnTurn >= MAX_ATTEMPTS_PER_TURN) return no('INVALID_REQUEST', 'This response cannot be regenerated again.');
  if (f.kind === 'edit') {
    f.validate(f.newContent ?? '');
    if (f.newContent === f.originalContent) return no('INVALID_REQUEST', 'Change the message before saving.');
  } else f.validate(f.originalContent);
  return null;
}
