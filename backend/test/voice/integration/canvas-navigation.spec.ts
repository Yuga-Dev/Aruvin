/**
 * ============================================================================
 * FILE: canvas-navigation.spec.ts
 * LOCATION: backend/test/voice/integration/canvas-navigation.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Canvas navigation end to end through the admitted offline voice
 *    transport, runtime, native tool pair, and presentation lane.
 *
 * ROLE IN PROJECT:
 *    Proves the feature works with Calendar disabled and no provider/database
 *    prerequisites, distinguishes requesting from target response identity,
 *    keeps text mode rejected, and never redispatches saved navigation history.
 *
 * KEY COMPONENTS:
 *    - Seeded real live generation, bounded inventory delivery, show_canvas pair.
 *    - Optional presentation publish failure containment.
 *    - Cold hydration of the exact source-free pair.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import { integratedFixture } from './integrated-fixture.js';
import type { LivePeer } from './integrated-fixture.js';
import { calendarFixture, skillWire, textWire } from '../../runtime/calendar-runtime.fixture.js';
import { calendarMemory } from '../../persistence/calendar-multi-memory.js';
import { createPersistenceBundle } from '../../../src/persistence/persistence.js';
import { DEFAULT_BUDGETS } from '../../../src/contracts/budgets.js';
import { CalendarTurnLedger } from '../../../src/chat-runtime/calendar-budget.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../../src/chat-runtime/memory-text.js';
import { DurableChatRuntime } from '../../../src/chat-runtime/durable-chat-runtime.js';
import { SKILL_NATIVE_TOOLS } from '../../../src/contracts/calendar-tools.js';
import { ownedCanvasInventory } from '../../../src/chat-runtime/canvas-navigation.js';
import { key } from '../../../src/persistence/records.js';
import type { CanvasInventoryEntry, CanvasSelection } from '../../../src/contracts/canvas-navigation.js';
import type { ExecuteTurn } from '../../../src/chat-runtime/ports.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function durableLiveFixture() {
  const db = calendarMemory();
  const client = Object.assign(db.commandSource, { db: () => db.store.db,
    appendMetadata: () => undefined }) as unknown as MongoClient;
  const p = await createPersistenceBundle(client, 'offline-voice-canvas-navigation-durable',
    DEFAULT_BUDGETS, 'offline-voice-canvas-durable-executor');
  const calendar = calendarFixture(undefined, p);
  await calendar.ready;
  const current = calendar.currentConfig.current()!;
  calendar.publish({ ...current, calendar: { ...current.calendar!, enabled: false } });
  const f = await integratedFixture(calendar);
  return { calendar, f };
}

async function liveFixture(memoryFirstOverride: Partial<NonNullable<Parameters<typeof calendarFixture>[2]>> = {}) {
  const db = calendarMemory();
  const client = Object.assign(db.commandSource, { db: () => db.store.db,
    appendMetadata: () => undefined }) as unknown as MongoClient;
  const p = await createPersistenceBundle(client, 'offline-voice-canvas-navigation',
    DEFAULT_BUDGETS, 'offline-voice-canvas-executor');
  const calendar = calendarFixture(undefined, p, {
    policy: { ...PROPOSED_MEMORY_TEXT_POLICY, maxAttempts: 1, shutdownDrainMs: 50 },
    voice: true,
    ...memoryFirstOverride,
  });
  await calendar.ready;
  const current = calendar.currentConfig.current()!;
  calendar.publish({ ...current, calendar: { ...current.calendar!, enabled: false } });
  const f = await integratedFixture(calendar);
  return { calendar, f };
}

async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function inventory(peer: LivePeer, conversationId: string,
  items: CanvasInventoryEntry[], omitted = 0, selection?: CanvasSelection | null): Promise<void> {
  peer.control({ type: 'canvas.inventory', conversationId, inventory: { items, omitted },
    ...(selection !== undefined ? { selection } : {}) });
  await settle();
}

async function seedCanvas(calendar: ReturnType<typeof calendarFixture>, f: Awaited<ReturnType<typeof liveFixture>>['f'],
  peer: LivePeer, providerTurnId: string) {
  calendar.modelWires.push(textWire('The pricing comparison is below.\n\n'
    + '```mermaid title="Pricing comparison"\nflowchart TD\nA --> B\n```'));
  const ref = await f.startReply(peer, 'Make a pricing comparison.', providerTurnId);
  await f.finishReply(peer, ref);
  const conversationId = f.latest().context.response.conversationId!;
  const memory = calendar.runtime.memoryFor(calendar.identity.userId);
  const assistant = memory
    ? memory.foundation.history(conversationId).find(record => record.turnId === ref.turnId && record.role === 'assistant')!
    : (await calendar.p.messages.listForContext(calendar.identity.userId, conversationId, { cursor: null, limit: 20 }))
      .items.find(record => record.turnId === ref.turnId && record.role === 'assistant')!;
  return { ref, conversationId, assistant,
    artifacts: peer.events().filter(event => event.type === 'canvas.artifact').length };
}

const toolsOf = (body: Record<string, unknown>) =>
  (body.tools as { function: { name: string } }[]).map(tool => tool.function.name);
const messagesOf = (body: Record<string, unknown>) =>
  body.messages as { role: string; content: string; tool_call_id?: string; name?: string }[];
const resultOf = (body: Record<string, unknown>, callId: string) =>
  messagesOf(body).find(message => message.role === 'tool' && message.tool_call_id === callId);

it('navigates an existing seeded Canvas with Calendar disabled and no Calendar effects', async () => {
  const { calendar, f } = await liveFixture();
  const cal = calendar.runtime.d.calendar!;
  const account = vi.spyOn(cal.connection, 'currentAccount');
  const requireAccount = vi.spyOn(cal.connection, 'requireAccountCurrent');
  try {
    const peer = await f.connect('live', null, 'canvas-nav-0001');
    const seeded = await seedCanvas(calendar, f, peer, 'canvas-seed-1');
    const target = `${seeded.assistant.messageId}::canvas::0`;
    const entry: CanvasInventoryEntry = { canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'message', id: seeded.assistant.messageId } };
    await inventory(peer, seeded.conversationId, [entry]);

    calendar.modelWires.push(
      skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-existing-1'),
    );
    const beforeBodies = calendar.modelBodies.length;
    const beforeEffects = calendar.effects.length;
    const beforeSpeak = vi.mocked(f.latest().tts.connection.speak).mock.calls.length;
    const ref = await f.startReply(peer, 'Open the pricing comparison.', 'navigate-pricing-1');
    await f.finishReply(peer, ref);

    const effect = peer.events().find(event => event.type === 'canvas.show'
      && event.navigationId === 'open-existing-1');
    expect(effect).toMatchObject({ type: 'canvas.show', conversationId: seeded.conversationId,
      canvasId: target, turnId: ref.turnId, responseId: ref.responseId });
    expect(calendar.modelBodies.length - beforeBodies).toBe(1);
    expect(calendar.effects.length).toBe(beforeEffects);
    expect(calendar.requestKinds).toEqual([]);
    expect(vi.mocked(f.latest().tts.connection.speak).mock.calls.slice(beforeSpeak)
      .map(([call]) => call.text).join('')).toBe('You are looking at Pricing comparison right now');
    const firstRequest = calendar.modelBodies[beforeBodies]!;
    expect(toolsOf(firstRequest)).toEqual(SKILL_NATIVE_TOOLS.map(tool => tool.name));
    const stateMessage = messagesOf(firstRequest).find(message => message.content?.startsWith(
      'Canvas state (voice-only instantaneous state;'));
    expect(stateMessage?.content).toContain(`"canvas_id":"${target}"`);
    expect(stateMessage?.content).toContain('"title":"Pricing comparison"');
    expect(stateMessage?.content).toContain('"mode":"voice"');
    expect(stateMessage?.content).toContain('"canvas_count":1');
    expect(stateMessage?.content).toContain('"open":false');
    expect(stateMessage?.content).toContain('"fullscreen":false');
    expect(stateMessage?.content).toContain('"zoomable":false');
    expect(stateMessage?.content).not.toContain('current_canvas');
    expect(stateMessage?.content).not.toContain('"revision"');
    expect(stateMessage?.content).not.toContain('"owner"');
    expect(peer.events().filter(event => event.type === 'canvas.artifact')).toHaveLength(seeded.artifacts);
    expect(peer.events().some(event => event.type === 'session.error')).toBe(false);

    // An unknown ID never falls back to another target and speaks deterministic missing confirmation in 1 LLM call.
    const beforeMissingBodies = calendar.modelBodies.length;
    const beforeMissingSpeak = vi.mocked(f.latest().tts.connection.speak).mock.calls.length;
    calendar.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: 'missing::canvas::0' }, 'open-missing-1'));
    const unknown = await f.startReply(peer, 'Open the missing Canvas.', 'navigate-missing-1');
    await f.finishReply(peer, unknown);
    expect(calendar.modelBodies.length - beforeMissingBodies).toBe(1);
    expect(peer.events().filter(event => event.type === 'canvas.show'
      && event.navigationId === 'open-missing-1')).toHaveLength(0);
    expect(vi.mocked(f.latest().tts.connection.speak).mock.calls.slice(beforeMissingSpeak)
      .map(([call]) => call.text).join('')).toBe("I couldn't find that Canvas.");

    expect(account).not.toHaveBeenCalled();
    expect(requireAccount).not.toHaveBeenCalled();
    await f.end(peer);
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('keeps control_canvas advertised without exposing Canvas state in text mode and rejects text mode without a UI effect', async () => {
  const { calendar, f } = await liveFixture();
  try {
    calendar.modelWires.push(
      skillWire('control_canvas', { action: 'open', canvas_id: 'unknown::canvas::0' }, 'open-text-1'),
    );
    const before = calendar.modelBodies.length;
    const firstTurn = await f.text(null, 'Open the pricing comparison.', 'text-navigation-1');
    expect(calendar.modelBodies.length - before).toBe(1);
    const first = calendar.modelBodies[before]!;
    expect(toolsOf(first)).toEqual(['activate_skill', 'call_tool', 'control_canvas', 'get_environment']);
    expect(JSON.stringify(messagesOf(first))).not.toContain('Canvas state');
    expect(JSON.stringify(messagesOf(first))).not.toContain('Canvas inventory');
    expect(calendar.effects).toEqual([]);
    expect(calendar.frames.some(frame => frame.event.type === 'canvas.show')).toBe(false);
    // Subsequent text turn preserves the rejected control_canvas open pair and deterministic explanation.
    calendar.modelWires.push(textWire('Noted.'));
    await f.text(firstTurn.sessionId, 'What happened to that Canvas request?', 'text-navigation-2');
    expect(messagesOf(calendar.modelBodies.at(-1)!)).toContainEqual(expect.objectContaining({
      role: 'tool',
      name: 'control_canvas',
      tool_call_id: 'open-text-1',
      content: JSON.stringify({ kind: 'canvas-control', outcome: 'mode-not-allowed', action: 'open', canvas_id: 'unknown::canvas::0' }),
    }));
    expect(messagesOf(calendar.modelBodies.at(-1)!)).toContainEqual({
      role: 'assistant',
      content: 'Canvas controls are only available in live voice.',
    });
  } finally { await f.close(); }
});

it('contains a lost optional Canvas presentation without pausing media', async () => {
  const { calendar, f } = await liveFixture();
  try {
    const peer = await f.connect('live', null, 'canvas-loss-0001');
    const seeded = await seedCanvas(calendar, f, peer, 'canvas-seed-loss');
    const target = `${seeded.assistant.messageId}::canvas::0`;
    await inventory(peer, seeded.conversationId, [{ canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'message', id: seeded.assistant.messageId } }]);
    const epoch = f.media.last();
    const participant = epoch.rtc.rooms[0]!.localParticipant;
    const base = participant.publishData.getMockImplementation()!;
    participant.publishData.mockImplementation(async (bytes: Uint8Array, options: unknown) => {
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { type?: string };
      if (body.type === 'canvas.show') throw new Error('presentation publish failed');
      return base(bytes, options);
    });
    calendar.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-lost-1'));
    const beforeShows = peer.events().filter(event => event.type === 'canvas.show').length;
    const ref = await f.startReply(peer, 'Open the pricing comparison.', 'navigate-loss-1');
    await f.finishReply(peer, ref);
    expect(peer.events().filter(event => event.type === 'canvas.show')).toHaveLength(beforeShows);
    expect(peer.events().some(event => event.type === 'session.error')).toBe(false);
    expect(peer.events()).toContainEqual(expect.objectContaining({ type: 'audio.watermark',
      turnId: ref.turnId, responseId: ref.responseId, final: true }));
    await f.end(peer);
  } finally { await f.close(); }
});

it('cold-hydrates the exact saved native pair without redispatching navigation', async () => {
  const { calendar, f } = await liveFixture();
  let cold: DurableChatRuntime | undefined;
  try {
    const peer = await f.connect('live', null, 'canvas-cold-0001');
    const seeded = await seedCanvas(calendar, f, peer, 'canvas-seed-cold');
    const target = `${seeded.assistant.messageId}::canvas::0`;
    await inventory(peer, seeded.conversationId, [{ canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'message', id: seeded.assistant.messageId } }]);
    calendar.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-cold-1'));
    const ref = await f.startReply(peer, 'Open the pricing comparison.', 'navigate-cold-1');
    await f.finishReply(peer, ref);
    expect(peer.events().filter(event => event.type === 'canvas.show'
      && event.navigationId === 'open-cold-1')).toHaveLength(1);
    await f.end(peer);
    expect(await calendar.runtime.drain(5000)).toMatchObject({ drained: true });

    cold = new DurableChatRuntime(calendar.runtime.d);
    calendar.modelWires.push(textWire('It was the pricing comparison.'));
    const follow = await cold.submitTurn({ identity: calendar.identity,
      sessionId: seeded.conversationId, content: 'What did you open?', idempotencyKey: 'cold-canvas-follow' });
    await cold.executeTurn({ userId: calendar.identity.userId, ...follow,
      signal: new AbortController().signal, emit: async () => undefined,
      emitCalendar: async () => undefined });
    const body = calendar.modelBodies.at(-1)!;
    const call = messagesOf(body).flatMap(message => (message as never as {
      tool_calls?: { id: string; function: { name: string } }[] }).tool_calls ?? [])
      .find(candidate => candidate.id === 'open-cold-1');
    expect(call?.function.name).toBe('control_canvas');
    expect(resultOf(body, 'open-cold-1')?.content).toBe(JSON.stringify({
      kind: 'canvas-control', outcome: 'requested', action: 'open', canvas_id: target }));
    expect(peer.events().filter(event => event.type === 'canvas.show'
      && event.navigationId === 'open-cold-1')).toHaveLength(1);
    expect(calendar.effects).toEqual([]);
  } finally { cold?.stopAccepting(); await f.close(); }
});

it('server ownership rejects a foreign inventory target before presentation', () => {
  const records = [{ schemaVersion: 1 as const, userId: 'u1', sessionId: 's1', turnId: 't1',
    attemptId: 'a1', messageId: 'm1', eventId: 'e1', sequence: 1, role: 'assistant' as const,
    content: 'Answer', createdAt: '2026-11-12T10:00:00.000Z', completionStatus: 'completed' as const,
    truncated: false }] as never;
  const snapshot = { items: [{ canvasId: 'm2::canvas::0', title: 'Foreign',
    owner: { kind: 'message' as const, id: 'm2' } }], omitted: 0 };
  expect(ownedCanvasInventory(snapshot, records, 'u1', 's1')).toEqual({ items: [], omitted: 1 });
});

it('dispatches scoped canvas.control immediately before speech with Calendar disabled and zero Calendar access', async () => {
  const { calendar, f } = await liveFixture();
  const cal = calendar.runtime.d.calendar!;
  const account = vi.spyOn(cal.connection, 'currentAccount');
  const requireAccount = vi.spyOn(cal.connection, 'requireAccountCurrent');
  try {
    const peer = await f.connect('live', null, 'canvas-ctrl-0001');
    const seeded = await seedCanvas(calendar, f, peer, 'canvas-ctrl-seed-1');
    const target = `${seeded.assistant.messageId}::canvas::0`;
    const entry: CanvasInventoryEntry = { canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'message', id: seeded.assistant.messageId } };
    const selection: CanvasSelection = {
      canvasId: target, revision: 3, open: true, fullscreen: false, mode: 'diagram',
    };
    await inventory(peer, seeded.conversationId, [entry], 0, selection);

    calendar.modelWires.push(skillWire('control_canvas', { action: 'zoom_in' }, 'ctrl-live-1'));
    const beforeBodies = calendar.modelBodies.length;
    const beforeEffects = calendar.effects.length;
    const beforeSpeak = vi.mocked(f.latest().tts.connection.speak).mock.calls.length;

    f.latest().stt.events.push({ type: 'end-of-turn', providerTurnId: 'control-fast-turn', text: 'Zoom in.' });
    await vi.waitFor(() => expect(peer.events().some(e => e.type === 'canvas.control')).toBe(true), { timeout: 5000 });
    const ref = f.latest().bridge!.currentResponse()!;
    expect(ref).toBeTruthy();
    expect(peer.events().some(e => e.type === 'audio.watermark' && e.final && e.turnId === ref.turnId)).toBe(false);

    const effect = peer.events().find(e => e.type === 'canvas.control');
    expect(effect).toMatchObject({
      type: 'canvas.control',
      conversationId: seeded.conversationId,
      turnId: ref.turnId,
      responseId: ref.responseId,
      controlId: key('canvas-control', ref.responseId, 'ctrl-live-1'),
      canvasId: target,
      selectionRevision: 3,
      command: { action: 'zoom_in' },
    });

    await f.awaitReply(peer, beforeSpeak);
    await f.finishReply(peer, ref);

    expect(calendar.modelBodies.length - beforeBodies).toBe(1);
    expect(calendar.effects.length).toBe(beforeEffects);
    expect(calendar.requestKinds).toEqual([]);
    expect(vi.mocked(f.latest().tts.connection.speak).mock.calls.slice(beforeSpeak)
      .map(([call]) => call.text).join('')).toBe('Zoomed in.');
    expect(peer.events().filter(e => e.type === 'canvas.artifact')).toHaveLength(seeded.artifacts);
    expect(peer.events().some(e => e.type === 'session.error')).toBe(false);
    expect(account).not.toHaveBeenCalled();
    expect(requireAccount).not.toHaveBeenCalled();
    await f.end(peer);
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('admits canvas.control before memory-first save and TTS completion gates settle', async () => {
  type SavePort = NonNullable<NonNullable<Parameters<typeof calendarFixture>[2]>['save']>;
  const saveGate = deferred<Awaited<ReturnType<SavePort>>>();
  const speakGate = deferred();
  let holdSave = false;
  let heldSaveCalls = 0;
  let saveSettled = false;
  let speakResolved = false;
  const { calendar, f } = await liveFixture({
    save: async envelope => {
      if (!holdSave) {
        return { kind: 'saved', epoch: envelope.epoch, sessionId: envelope.sessionId,
          version: envelope.version, fence: envelope.fence };
      }
      heldSaveCalls += 1;
      const res = await saveGate.promise;
      saveSettled = true;
      return res;
    },
  });
  const ttsConn = { get ref() { return f.latest().tts.connection; } };
  let baseSpeak: ReturnType<typeof ttsConn.ref.speak['getMockImplementation']> | undefined;
  let instrumentedTts: typeof ttsConn.ref | undefined;
  try {
    const peer = await f.connect('live', null, 'canvas-ctrl-save-0001');
    const seeded = await seedCanvas(calendar, f, peer, 'canvas-ctrl-save-seed');
    const target = `${seeded.assistant.messageId}::canvas::0`;
    await inventory(peer, seeded.conversationId, [{ canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'message', id: seeded.assistant.messageId } }], 0,
      { canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'diagram' });

    instrumentedTts = f.latest().tts.connection;
    const speakMock = vi.mocked(instrumentedTts.speak);
    baseSpeak = speakMock.getMockImplementation() ?? (async () => undefined);
    const prevSpeak = baseSpeak;
    speakMock.mockImplementation(async (...args) => {
      await speakGate.promise;
      const out = await prevSpeak(...args);
      speakResolved = true;
      return out;
    });

    holdSave = true;
    const beforeSpeak = speakMock.mock.calls.length;
    calendar.modelWires.push(skillWire('control_canvas', { action: 'fit_to_view' }, 'ctrl-gate-1'));
    f.latest().stt.events.push({ type: 'end-of-turn', providerTurnId: 'control-gate-turn', text: 'Fit to view.' });

    await vi.waitFor(() => expect(peer.events().some(e => e.type === 'canvas.control')).toBe(true), { timeout: 5000 });
    const ref = f.latest().bridge!.currentResponse()!;
    expect(ref).toBeTruthy();
    expect(saveSettled).toBe(false);
    expect(speakResolved).toBe(false);
    expect(peer.events().some(e => e.type === 'audio.watermark' && e.final && e.turnId === ref.turnId)).toBe(false);

    speakGate.resolve();
    await f.awaitReply(peer, beforeSpeak);
    await f.finishReply(peer, ref);
    await vi.waitFor(() => expect(heldSaveCalls).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    expect(saveSettled).toBe(false);

    // Immediate next voice request proceeds without waiting for holdSave DB flush.
    const nextSpeak = speakMock.mock.calls.length;
    calendar.modelWires.push(skillWire('control_canvas', { action: 'zoom_in' }, 'ctrl-gate-2'));
    f.latest().stt.events.push({ type: 'end-of-turn', providerTurnId: 'control-gate-turn-2', text: 'Zoom in now.' });
    await f.awaitReply(peer, nextSpeak);
    expect(saveSettled).toBe(false);

    holdSave = false;
    saveGate.resolve({ kind: 'unknown', retryable: false });
    await vi.waitFor(() => expect(saveSettled).toBe(true), { timeout: 5000 });
    await f.end(peer);
    const drained = await calendar.runtime.drain(5000);
    expect(drained.drained).toBe(false);
    expect(drained.active).toBe(0);
    expect(drained.unresolvedWrites).toBeGreaterThanOrEqual(1);
    expect(speakResolved).toBe(true);

    const memory = calendar.runtime.memoryFor(calendar.identity.userId)!;
    const turn = memory.find(seeded.conversationId, ref.turnId)?.turn;
    const result = turn ? memory.foundation.result(turn)?.calendar : undefined;
    expect(result?.results[0]?.resultRef.content).toBe(JSON.stringify({
      kind: 'canvas-control', outcome: 'requested', action: 'fit_to_view', canvas_id: target,
    }));
  } finally {
    holdSave = false;
    speakGate.resolve();
    saveGate.resolve({ kind: 'unknown', retryable: false });
    if (instrumentedTts && baseSpeak) vi.mocked(instrumentedTts.speak).mockImplementation(baseSpeak);
    await f.close();
  }
});

it('admits canvas.control before durable observation and decision persistence gates settle', async () => {
  const { calendar, f } = await durableLiveFixture();
  const decisionGate = deferred();
  const resultGate = deferred();
  const ledgerGate = deferred();
  let hold = false;
  let decisionPutSettled = false;
  let resultPutSettled = false;
  let ledgerSettled = false;
  let putDecisionSpy: ReturnType<typeof vi.spyOn> | undefined;
  let putResultSpy: ReturnType<typeof vi.spyOn> | undefined;
  let finishSpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const peer = await f.connect('live', null, 'canvas-ctrl-durable-0001');
    const seeded = await seedCanvas(calendar, f, peer, 'canvas-ctrl-durable-seed');
    const target = `${seeded.assistant.messageId}::canvas::0`;
    await inventory(peer, seeded.conversationId, [{ canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'message', id: seeded.assistant.messageId } }], 0,
      { canvasId: target, revision: 2, open: true, fullscreen: false, mode: 'diagram' });

    const origPutDecision = calendar.p.skillDecisions.put.bind(calendar.p.skillDecisions);
    putDecisionSpy = vi.spyOn(calendar.p.skillDecisions, 'put').mockImplementation(async rec => {
      if (hold) await decisionGate.promise;
      await origPutDecision(rec);
      decisionPutSettled = true;
    });
    const origPutResult = calendar.p.skillResults.put.bind(calendar.p.skillResults);
    putResultSpy = vi.spyOn(calendar.p.skillResults, 'put').mockImplementation(async rec => {
      if (hold) await resultGate.promise;
      await origPutResult(rec);
      resultPutSettled = true;
    });
    const origFinish = CalendarTurnLedger.prototype.finishDispatch;
    finishSpy = vi.spyOn(CalendarTurnLedger.prototype, 'finishDispatch').mockImplementation(async function (
      this: CalendarTurnLedger, ...args
    ) {
      if (hold) await ledgerGate.promise;
      const out = await origFinish.apply(this, args);
      ledgerSettled = true;
      return out;
    });

    hold = true;
    const beforeSpeak = vi.mocked(f.latest().tts.connection.speak).mock.calls.length;
    calendar.modelWires.push(skillWire('control_canvas', { action: 'reset_view' }, 'ctrl-durable-1'));
    f.latest().stt.events.push({ type: 'end-of-turn', providerTurnId: 'control-durable-turn', text: 'Reset view.' });

    await vi.waitFor(() => expect(peer.events().some(e => e.type === 'canvas.control')).toBe(true), { timeout: 5000 });
    expect(decisionPutSettled).toBe(false);
    expect(resultPutSettled).toBe(false);
    expect(ledgerSettled).toBe(false);
    const ref = f.latest().bridge!.currentResponse()!;

    hold = false;
    ledgerGate.resolve();
    decisionGate.resolve();
    resultGate.resolve();
    await f.awaitReply(peer, beforeSpeak);
    await f.finishReply(peer, ref);
    await f.end(peer);
    expect(await calendar.runtime.drain(5000)).toMatchObject({ drained: true });
    expect(decisionPutSettled).toBe(true);
    expect(resultPutSettled).toBe(true);
    expect(ledgerSettled).toBe(true);
  } finally {
    hold = false;
    ledgerGate.resolve();
    decisionGate.resolve();
    resultGate.resolve();
    putDecisionSpy?.mockRestore();
    putResultSpy?.mockRestore();
    finishSpy?.mockRestore();
    await f.close();
  }
});

it('cold-hydrates control pair without redispatch and repairs redundant zoom on scroll-mode Canvas cleanly', async () => {
  const { calendar, f } = await liveFixture();
  let cold: DurableChatRuntime | undefined;
  try {
    const peer = await f.connect('live', null, 'canvas-ctrl-cold-0001');
    const seeded = await seedCanvas(calendar, f, peer, 'canvas-ctrl-cold-seed');
    const target = `${seeded.assistant.messageId}::canvas::0`;
    await inventory(peer, seeded.conversationId, [{ canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'message', id: seeded.assistant.messageId } }], 0,
      { canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'diagram' });

    // 1. Valid control dispatches once cleanly in 1 LLM call.
    calendar.modelWires.push(skillWire('control_canvas', { action: 'zoom_in' }, 'ctrl-cold-1'));
    const ref = await f.startReply(peer, 'Zoom in.', 'control-cold-turn-1');
    await f.finishReply(peer, ref);
    expect(peer.events().filter(e => e.type === 'canvas.control')).toHaveLength(1);

    // 2. Calling zoom_in while scroll-mode selection reports zoomable=false triggers redundant-call repair without canvas.control.
    await inventory(peer, seeded.conversationId, [{ canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'message', id: seeded.assistant.messageId } }], 0,
      { canvasId: target, revision: 2, open: true, fullscreen: false, mode: 'scroll' });
    calendar.modelWires.push(
      skillWire('control_canvas', { action: 'zoom_in' }, 'ctrl-cal-redundant'),
      textWire('Zoom is not supported on Calendar.'),
    );
    const ref2 = await f.startReply(peer, 'Zoom the calendar.', 'control-cal-turn');
    await f.finishReply(peer, ref2);
    expect(calendar.modelBodies.at(-1)!.messages.at(-1)?.content).toContain('answer from that state');
    expect(peer.events().filter(e => e.type === 'canvas.control')).toHaveLength(1);

    // 2b. Calling fullscreen while open=false instructs repair that Canvas is closed and permits opening.
    await inventory(peer, seeded.conversationId, [{ canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'message', id: seeded.assistant.messageId } }], 0,
      { canvasId: target, revision: 2, open: false, fullscreen: false, mode: 'diagram' });
    calendar.modelWires.push(
      skillWire('control_canvas', { action: 'fullscreen', state: 'enter' }, 'ctrl-closed-fs'),
      skillWire('control_canvas', { action: 'open', canvas_id: target }, 'ctrl-closed-open'),
    );
    const ref2b = await f.startReply(peer, 'Open Canvas in fullscreen.', 'control-closed-turn');
    await f.finishReply(peer, ref2b);
    const closedRepairMsg = calendar.modelBodies.at(-1)!.messages.at(-1)?.content ?? '';
    expect(closedRepairMsg).toContain('open is false');
    expect(closedRepairMsg).toContain('open-canvas-first');
    expect(peer.events().filter(e => e.type === 'canvas.show')).toHaveLength(1);

    // 3. Lost optional canvas.control publish keeps media alive without session.error.
    await inventory(peer, seeded.conversationId, [{ canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'message', id: seeded.assistant.messageId } }], 0,
      { canvasId: target, revision: 3, open: true, fullscreen: false, mode: 'diagram' });
    const participant = f.media.last().rtc.rooms[0]!.localParticipant;
    const basePublish = participant.publishData.getMockImplementation()!;
    participant.publishData.mockImplementation(async (bytes: Uint8Array, options: unknown) => {
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { type?: string };
      if (body.type === 'canvas.control') throw new Error('control publish failed');
      return basePublish(bytes, options);
    });
    calendar.modelWires.push(skillWire('control_canvas', { action: 'zoom_out' }, 'ctrl-lost-1'));
    const ref3 = await f.startReply(peer, 'Zoom out.', 'control-lost-turn');
    await f.finishReply(peer, ref3);
    expect(peer.events().some(e => e.type === 'session.error')).toBe(false);
    expect(peer.events()).toContainEqual(expect.objectContaining({ type: 'audio.watermark',
      turnId: ref3.turnId, responseId: ref3.responseId, final: true }));

    // 4. Re-executing the same completed live turn has no effect and dispatches no control.
    const controlEventsBeforeReplay = peer.events().filter(e => e.type === 'canvas.control').length;
    const memTurn = calendar.runtime.memoryFor(calendar.identity.userId)!.find(seeded.conversationId, ref.turnId)!;
    const replayControl = vi.fn(() => true);
    const replayLive: ExecuteTurn['live'] = {
      reservation: f.latest().context.reservation!,
      responseId: ref.responseId,
      emit: async () => undefined,
      canvas: { inventory: () => ({ items: [], omitted: 0 }), active: () => true, show: () => true, control: replayControl },
    };
    await calendar.runtime.executeTurn({
      userId: calendar.identity.userId,
      sessionId: seeded.conversationId,
      turnId: ref.turnId,
      attemptId: memTurn.turn.attemptId,
      signal: new AbortController().signal,
      emit: async () => undefined,
      emitCalendar: async () => undefined,
      live: replayLive,
    });
    expect(replayControl).not.toHaveBeenCalled();
    expect(peer.events().filter(e => e.type === 'canvas.control')).toHaveLength(controlEventsBeforeReplay);

    // 5. End live session, verify text-mode rejection on the same session, drain, and cold-hydrate cleanly.
    await f.end(peer);

    calendar.modelWires.push(skillWire('control_canvas', { action: 'zoom_in' }, 'ctrl-text-1'));
    const textTurn = await f.text(seeded.conversationId, 'Zoom in please.', 'control-text-idem');
    expect(peer.events().filter(e => e.type === 'canvas.control')).toHaveLength(controlEventsBeforeReplay);

    expect(await calendar.runtime.drain(5000)).toMatchObject({ drained: true });
    cold = new DurableChatRuntime(calendar.runtime.d);
    const bodiesBeforeColdReplay = calendar.modelBodies.length;
    await cold.executeTurn({ userId: calendar.identity.userId, ...textTurn,
      signal: new AbortController().signal, emit: async () => undefined, emitCalendar: async () => undefined });
    expect(calendar.modelBodies).toHaveLength(bodiesBeforeColdReplay);
    calendar.modelWires.push(textWire('Already zoomed in.'));
    const follow = await cold.submitTurn({ identity: calendar.identity,
      sessionId: seeded.conversationId, content: 'What control ran?', idempotencyKey: 'cold-ctrl-follow' });
    await cold.executeTurn({ userId: calendar.identity.userId, ...follow,
      signal: new AbortController().signal, emit: async () => undefined, emitCalendar: async () => undefined });
    const body = calendar.modelBodies.at(-1)!;
    const call = messagesOf(body).flatMap(message => (message as never as {
      tool_calls?: { id: string; function: { name: string } }[] }).tool_calls ?? [])
      .find(candidate => candidate.id === 'ctrl-cold-1');
    expect(call?.function.name).toBe('control_canvas');
    expect(resultOf(body, 'ctrl-cold-1')?.content).toBe(JSON.stringify({
      kind: 'canvas-control', outcome: 'requested', action: 'zoom_in', canvas_id: target,
    }));
    expect(peer.events().filter(e => e.type === 'canvas.control')).toHaveLength(controlEventsBeforeReplay);
  } finally { cold?.stopAccepting(); await f.close(); }
});
