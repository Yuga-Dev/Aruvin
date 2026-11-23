/**
 * ============================================================================
 * FILE: user-memory-runtime.spec.ts
 * LOCATION: backend/test/runtime/user-memory-runtime.spec.ts
 * PURPOSE: Prove user-memory and Temporary Chat boundaries with offline fixtures.
 * ROLE IN PROJECT: Exercises real runtime, native adapters, archive, and routes.
 * KEY COMPONENTS: Command trace, provider frames, publication and lifecycle gates.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import type { SubmitTurnResponse } from '../../src/contracts/api.js';
import type { AuthPrincipal } from '../../src/contracts/auth.js';
import type { CalendarCompatibleEnvelope, LiveExecution, RuntimeDependencies } from '../../src/chat-runtime/ports.js';
import type { PinnedUserMemory, StoredUserMemory } from '../../src/contracts/user-memory.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { sessionIdFor } from '../../src/chat-runtime/identity.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { deliveryFixture, createSessionFixture, createSessionResponseFixture }
  from '../../src/contracts/testing/voice-fixtures.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { key } from '../../src/persistence/records.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { textConfigFixture } from './text-config-fixture.js';
import { textSnapshot } from '../model/config-snapshot.js';
import type { MemoryWriterService } from '../../src/personalization/memory-writer.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { graphConfig } from '../../src/chat-runtime/finalization.js';
import { boundaryFor } from '../../src/agent/state.js';
import { readMemoryToolCandidate } from '../../src/model/calendar-validation.js';
import { createWebNativeModelPort } from '../../src/model/web-native.js';
import { createCalendarModelPortV2 } from '../../src/model/calendar-adapter.js';
import { CALENDAR_LIMITS } from '../../src/contracts/calendar-policy.js';
import { UPDATE_USER_MEMORY_NATIVE_TOOL, UPDATE_USER_MEMORY_TOOL_DEFINITION }
  from '../../src/contracts/user-memory.js';
import { calendarBinding, calendarLimits, skillRequest, nativeFrame } from '../model/calendar-fixtures.js';
import { collect, config } from '../model/helpers.js';
import { UserMemoryFault } from '../../src/personalization/errors.js';
import { authority } from './dev-mode-fixture.js';
import { AppService, prepareConfigurationSnapshot } from '../../src/app.service.js';
import { loadModelLimits } from '../../src/model/catalogue.js';
import { document } from '../admin-config/fixtures.js';
import { assemblyFixture } from '../assembly/admin-config-fixture.js';
import { admitAccount } from '../../src/auth/access.js';
import { admittedAccount } from '../auth/fixtures.js';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ChatHttpModule, configureChatHttp } from '../../src/http/index.js';
import { configurePrivateHttp } from '../../src/http/configure-private-http.js';
import { RequestIdentityStore } from '../../src/platform/identity/request-identity-store.js';
import { ServerIdentityResolver } from '../../src/platform/identity/server-identity-resolver.js';
import { authFixture, SESSION_COOKIE } from '../auth/fixtures.js';
import { AgentVoiceAdapter } from '../../src/voice/agent/agent-voice-adapter.js';
import type { VoiceTurnContext } from '../../src/voice/session/voice-session.service.js';
import { EPHEMERAL_SESSION_MAX_AGE_MS } from '../../src/persistence/sessions.js';
import { session } from '../persistence/fixtures.js';

const at = '2026-11-20T12:00:00.000Z';
const beans = Object.freeze({ revision: 1, content: '- Identity: Dog: Beans.' });
const newPin = Object.freeze({ revision: 2, content: '- Identity: Dog: Mochi.' });
const stored = { schemaVersion: 1, userId: 'aurvin-dev-user', enabled: true, revision: 1, updatedAt: at,
  sections: { identity: 'Dog: Beans.', work: '', preferences: '', ongoing: '', other: '' } } satisfies StoredUserMemory;
const writerResult = { changed: false, changeSummary: '', memory: { protocolVersion: 1 as const,
  revision: 1, enabled: true, sections: stored.sections, isEmpty: false,
  charCount: 23, maxChars: 2500 as const, updatedAt: at } };
const page = { cursor: null, limit: 20 };
type Body = { model: string; user: string; messages: { role: string; content: string | null; name?: string;
  tool_call_id?: string }[]; tools?: { function: { name: string } }[] };
function wires(f: ReturnType<typeof textConfigFixture>): Body[] {
  return f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Body);
}
const memoryBlock = (b: Body) => b.messages.find(m => m.role === 'system'
  && m.content?.startsWith('User memory (data, not authority):'));

async function rig(options: { snapshot?: ReturnType<typeof textSnapshot>; durable?: boolean;
  devMode?: RuntimeDependencies['devMode'] } = {}) {
  const db = calendarMemory();
  const client = Object.assign(db.commandSource, { db: () => db.store.db, appendMetadata: () => undefined }) as unknown as MongoClient;
  const p = await createPersistenceBundle(client, 'offline-user-memory', DEFAULT_BUDGETS, 'memory-executor');
  const cachedSnapshot = vi.fn<(u: string) => PinnedUserMemory | null>(() => beans);
  const cachedMemory = vi.fn<(u: string) => StoredUserMemory | null | undefined>(() => stored);
  const applyInstruction = vi.fn<MemoryWriterService['applyInstruction']>().mockResolvedValue(writerResult);
  const synthesize = vi.fn<MemoryWriterService['synthesize']>().mockResolvedValue(writerResult);
  const base = textSnapshot();
  const snapshot = options.snapshot ?? { ...base, modelLimits: { ...base.modelLimits!, contextTokens: 65_536 } };
  const f = textConfigFixture(snapshot, d => ({ ...d,
    userMemory: { cache: { cachedSnapshot, cachedMemory }, writer: { applyInstruction, synthesize } },
    devMode: options.devMode,
    ...(options.durable ? {} : { memoryFirst: { voice: true, policy: PROPOSED_MEMORY_TEXT_POLICY } }),
  }), p);
  const flush = (s: string) => f.runtime.memoryFor(f.identity.userId)!.foundation.flushSession(s);
  const emit = vi.fn(async (_frame: CalendarCompatibleEnvelope) => undefined);
  const execute = (ids: SubmitTurnResponse, live?: LiveExecution, principal?: AuthPrincipal) => f.runtime.executeTurn({
    userId: f.identity.userId, ...ids, signal: new AbortController().signal, emit, emitCalendar: emit, live, principal,
  });
  return { f, p, db, cachedSnapshot, cachedMemory, applyInstruction, synthesize, snapshot, flush, execute, emit };
}

async function liveTurn(r: Awaited<ReturnType<typeof rig>>, keyId: string, existing?: string, heard?: string,
  content = 'Live input') {
  const { f, snapshot } = r;
  const voiceSessionId = 'memory-voice';
  const reserved = await f.runtime.reservations.acquire({ identity: f.identity, conversationId: existing ?? null,
    owner: { kind: 'live', voiceSessionId } });
  const sessionId = existing ?? sessionIdFor(f.identity.userId, null, keyId);
  const reservation = existing ? reserved : await f.runtime.reservations.bindConversation({
    identity: f.identity, reservationId: reserved.reservationId, conversationId: sessionId,
  });
  const cmd = { identity: f.identity, sessionId, content, idempotencyKey: keyId,
    reservation, configSnapshot: snapshot, freshConversation: !existing,
    voice: { voiceSessionId, socketEpoch: 1, providerTurnId: keyId } };
  let terminal: ((text: string) => Promise<void>) | undefined;
  const live: LiveExecution = {
    reservation, delta: async () => {}, finish: async () => {},
    start: async (a, write) => {
      const pending = { ...deliveryFixture(), userId: a.userId, sessionId, turnId: a.turnId,
        attemptId: a.attemptId, voiceSessionId, createdAt: a.createdAt, updatedAt: a.createdAt,
        responseId: key('voice-response', a.userId, sessionId, a.attemptId),
        status: 'pending' as const, textGenerated: '' };
      await write(pending);
      terminal = text => write({ ...pending, sequence: 2,
        status: heard !== undefined && heard !== text ? 'interrupted' : 'completed', textGenerated: text,
        textSpoken: heard ?? text, textRemaining: heard !== undefined ? text.slice(heard.length) : '',
      }, 1);
    },
    settle: async text => { if (!terminal) throw new Error('no voice delivery start'); await terminal(text); },
  };
  return { cmd, live, release: () => f.runtime.reservations.release({
    identity: f.identity, reservationId: reservation.reservationId,
  }) };
}

it('pins on the first accepted turn and freezes the same Text and Voice prefix through archive and restart', async () => {
  const r = await rig();
  const { f, db, cachedSnapshot, p } = r;
  try {
    const seen: number[] = [];
    const provider = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation((...args) => { seen.push(db.calls.length); return provider(...args); });
    const base = db.calls.length;
    const one = await f.submit('My dog has a new toy.');
    cachedSnapshot.mockReturnValue(newPin);
    await r.execute(one);
    expect(seen).toEqual([base]);
    expect(wires(f)).toHaveLength(1);
    expect(r.applyInstruction).not.toHaveBeenCalled();
    expect(r.synthesize).not.toHaveBeenCalled();
    expect(cachedSnapshot.mock.calls).toEqual([[f.identity.userId]]);
    expect(memoryBlock(wires(f)[0])?.content).toContain(beans.content);
    await r.flush(one.sessionId);
    expect((await p.memory.get(f.identity.userId, one.sessionId))?.pinnedUserMemory).toEqual(beans);
    await f.restart();
    await f.runtime.prepareSession(f.identity.userId, one.sessionId);
    const voice = await liveTurn(r, 'voice-pin-0001', one.sessionId);
    const voiceBase = db.calls.length;
    expect(await f.runtime.findLiveSubmission(voice.cmd)).toBeNull();
    const two = await f.runtime.submitLiveTurn(voice.cmd);
    await r.execute(two, voice.live);
    await voice.release();
    expect(seen[1]).toBe(voiceBase);
    expect(wires(f)).toHaveLength(2);
    const prefix = (b: Body) => JSON.stringify(b.messages.slice(0,
      b.messages.findIndex(m => m.content?.startsWith('Response mode:'))));
    expect(prefix(wires(f)[1])).toBe(prefix(wires(f)[0]));
    expect(cachedSnapshot).toHaveBeenCalledTimes(1);
    await r.flush(one.sessionId);
    expect((await p.memory.get(f.identity.userId, one.sessionId))?.pinnedUserMemory).toEqual(beans);
  } finally { await f.dispose(); }
});

it('pins a fresh Live Voice chat before storage and never repins a duplicate or a follow-up', async () => {
  const r = await rig();
  try {
    const voice = await liveTurn(r, 'voice-pin-0002');
    const before = r.db.calls.length;
    const ids = await r.f.runtime.submitLiveTurn(voice.cmd);
    r.cachedSnapshot.mockReturnValue(newPin);
    expect(await r.f.runtime.findLiveSubmission(voice.cmd)).toEqual(ids);
    const provider = r.f.fetcher.getMockImplementation()!;
    r.f.fetcher.mockImplementationOnce((...args) => {
      expect(r.db.calls).toHaveLength(before);
      return provider(...args);
    });
    await r.execute(ids, voice.live);
    await voice.release();
    expect(memoryBlock(wires(r.f)[0])?.content).toContain(beans.content);
    expect(r.cachedSnapshot).toHaveBeenCalledTimes(1);
  } finally { await r.f.dispose(); }
});

it('never reads a pin for Temporary Chat, and hides its RAM and archived rows', async () => {
  const r = await rig();
  const { f, p } = r;
  const c = { identity: f.identity, sessionId: null, content: 'Temporary input',
    idempotencyKey: 'temporary-memory-1', ephemeral: true };
  try {
    const ids = await f.runtime.submitTurn(c);
    await expect(f.runtime.submitTurn({ ...c, ephemeral: false }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    expect(f.runtime.memorySession(f.identity.userId, ids.sessionId)?.ephemeral).toBe(true);
    expect(f.runtime.overlaySessions(f.identity.userId, page, { items: [], nextCursor: null }).items).toEqual([]);
    await r.execute(ids);
    expect(memoryBlock(wires(f)[0])).toBeUndefined();
    expect(r.cachedSnapshot).not.toHaveBeenCalled();
    await r.flush(ids.sessionId);
    expect((await p.sessions.get(f.identity.userId, ids.sessionId))?.ephemeral).toBe(true);
    expect((await p.memory.get(f.identity.userId, ids.sessionId))?.pinnedUserMemory).toBeNull();
    expect((await p.sessions.list(f.identity.userId, page)).items).toEqual([]);
  } finally { await f.dispose(); }
});

function reply(id: string, content: string) {
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  return new Response(data({ id, model: 'fixture/model', choices: [{ index: 0, delta: { content }, finish_reason: null }] })
    + data({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 32, completion_tokens: 16, cost: 0.000064 } }) + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } });
}

it('refreshes the RAM pin at compaction promotion and archives that exact snapshot', async () => {
  const base = textSnapshot();
  const snapshot = { ...base, modelLimits: { ...base.modelLimits!, contextTokens: 65_536 },
    settings: { ...base.settings, compaction: { ...base.settings.compaction, enabled: true } } };
  const r = await rig({ snapshot });
  const { f, p, cachedSnapshot } = r;
  let s: string | null = null;
  const summaryEntered = Promise.withResolvers<void>();
  const summaryRelease = Promise.withResolvers<void>();
  let archiveGate: ReturnType<typeof r.db.pauseNextUpdate> | undefined;
  const saveSummary = p.metadata.putCompactionSummary.bind(p.metadata);
  vi.spyOn(p.metadata, 'putCompactionSummary').mockImplementationOnce(async value => {
    await saveSummary(value);
    archiveGate = r.db.pauseNextUpdate();
  });
  const provider = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (...args) => {
    if (!String(args[1]?.body).includes('Compact the preceding conversation data')) return provider(...args);
    summaryEntered.resolve();
    await summaryRelease.promise;
    return reply('memory-compaction', '<analysis>Retained fixture facts.</analysis>\n<summary>\n' + COMPACTION_SECTIONS.map((label, i) =>
      `## ${i + 1}. ${label}\nA retained fixture fact.`).join('\n\n') + '\n</summary>');
  });
  try {
    for (let i = 0; i < 5; i++) {
      const ids = await f.submit(`Turn ${i}`, s); s = ids.sessionId;
      await r.execute(ids);
    }
    await r.flush(s!);
    const m = f.runtime.memoryFor(f.identity.userId)!;
    m['scheduleCompactionIfNeeded'](s!, snapshot, true);
    await summaryEntered.promise;
    cachedSnapshot.mockReturnValue(newPin);
    summaryRelease.resolve();
    await vi.waitFor(() => expect(cachedSnapshot).toHaveBeenCalledTimes(2));
    // Stall the compaction publication itself, not the compactor's accounting.
    await vi.waitFor(() => expect(archiveGate).toBeDefined());
    await archiveGate!.started;
    cachedSnapshot.mockReturnValue(null);
    const next = await f.submit('After compaction', s);
    await r.execute(next);
    expect(memoryBlock(wires(f).at(-1)!)?.content).toContain(newPin.content);
    archiveGate!.resume();
    await r.flush(next.sessionId);
    const persisted = await p.memory.get(f.identity.userId, next.sessionId);
    expect(persisted).toMatchObject({ activeSummaryRef: expect.any(Object), pinnedUserMemory: newPin });
    const row = (await p.sessions.get(f.identity.userId, next.sessionId))!;
    const graph = await f.runtime.graph({ userId: row.userId, sessionId: row.sessionId,
      ownerId: p.owner.executorId, generation: row.execution.generation, leaseExpiresAt: f.runtime.now() });
    expect((await graph.getState(graphConfig(row.userId, row.sessionId))).values.boundary).toEqual(boundaryFor(persisted!));
  } finally { summaryRelease.resolve(); archiveGate?.resume(); await f.dispose(); }
});

it('preserves the pin on durable completion, replay, and a later interrupted attempt', async () => {
  const r = await rig({ durable: true });
  try {
    const a = await r.f.submit('Durable input');
    r.cachedSnapshot.mockReturnValue(newPin);
    await r.execute(a);
    await r.execute(a);
    const b = await r.f.submit('Later interrupted', a.sessionId);
    await r.f.runtime.cancelTurn({ identity: r.f.identity, ...b });
    expect((await r.p.memory.get(r.f.identity.userId, a.sessionId))?.pinnedUserMemory).toEqual(beans);
    expect(r.cachedSnapshot).toHaveBeenCalledTimes(1);
  } finally { await r.f.dispose(); }
});

it('passes heard Live Voice text to passive memory and marks only after confirmed change', async () => {
  const r = await rig();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const voice = await liveTurn(r, 'voice-passive-1', undefined, 'Hello');
    const ids = await r.f.runtime.submitLiveTurn(voice.cmd);
    await r.execute(ids, voice.live);
    await voice.release();
    await r.flush(ids.sessionId);
    const u = r.f.identity.userId, s = ids.sessionId;
    expect(r.synthesize).not.toHaveBeenCalled();
    expect(r.emit.mock.calls.find(([f]) => f.event.type === 'completed')?.[0].event)
      .not.toHaveProperty('memoryUpdated');
    const written = Promise.withResolvers<void>();
    const advance = r.p.sessions.advanceMemoryWatermark.bind(r.p.sessions);
    const watermark = vi.spyOn(r.p.sessions, 'advanceMemoryWatermark').mockImplementation(async (...args) => {
      await advance(...args); written.resolve();
    });
    r.synthesize.mockResolvedValueOnce({ ...writerResult, changed: true, changeSummary: 'Saved a detail' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.synthesize.mock.calls[0]?.[1]).toEqual([
      { role: 'user', content: 'Live input' }, { role: 'assistant', content: 'Hello' },
    ]);
    await written.promise;
    expect(watermark).toHaveBeenCalledWith(u, s, 1);
    expect((await r.p.sessions.get(u, s))?.memoryWatermarkSequence).toBe(1);
    expect(r.f.runtime.memoryMessages(u, s, page)?.items.at(-1)?.memoryUpdated).toBe(true);
    expect((await r.p.messages.list(u, s, page)).items.at(-1)?.memoryUpdated).toBe(true);
    expect((await r.p.memory.get(u, s))?.contextVersion).toBe(1);
  } finally { vi.useRealTimers(); await r.f.dispose(); }
});

it('compaction refresh and follow-up complete while passive synthesis is still held', async () => {
  const base = textSnapshot();
  const snapshot = { ...base, modelLimits: { ...base.modelLimits!, contextTokens: 65_536 },
    settings: { ...base.settings, compaction: { ...base.settings.compaction, enabled: true } } };
  const r = await rig({ snapshot });
  const provider = r.f.fetcher.getMockImplementation()!;
  r.f.fetcher.mockImplementation((...args) =>
    String(args[1]?.body).includes('Compact the preceding conversation data')
      ? Promise.resolve(reply('async-summary', '<analysis>Retained facts.</analysis>\n<summary>\n' + COMPACTION_SECTIONS.map((label, i) =>
        `## ${i + 1}. ${label}\nRetained fact.`).join('\n\n') + '\n</summary>'))
      : provider(...args));
  const held = Promise.withResolvers<typeof writerResult>();
  r.synthesize.mockReturnValueOnce(held.promise);
  try {
    let s: string | null = null;
    for (let i = 0; i < 5; i++) {
      const ids = await r.f.submit(`Input ${i}`, s); s = ids.sessionId;
      await r.execute(ids);
    }
    const u = r.f.identity.userId, owner = r.f.runtime.memoryFor(u)!;
    await r.flush(s!);
    r.cachedSnapshot.mockReturnValue(newPin);
    owner['scheduleCompactionIfNeeded'](s!, snapshot, true);
    await vi.waitFor(() => expect(r.synthesize).toHaveBeenCalledTimes(1));
    await r.flush(s!); // The summary publishes even while the writer is unresolved.
    const next = await r.f.submit('Continue immediately', s);
    await r.execute(next);
    expect(memoryBlock(wires(r.f).at(-1)!)?.content).toContain(newPin.content);
    expect(r.synthesize.mock.calls[0]?.[1][0]).toEqual({ role: 'user', content: 'Input 0' });
    expect((await r.p.sessions.get(u, s!))?.memoryWatermarkSequence).toBeUndefined();
  } finally { held.resolve(writerResult); await r.f.dispose(); }
});

it('a passive no-op advances the session watermark without touching user memory or marking an assistant', async () => {
  const r = await rig();
  const mark = vi.spyOn(r.p.messages, 'markMemoryUpdated');
  const advance = vi.spyOn(r.p.sessions, 'advanceMemoryWatermark');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const ids = await r.f.submit('A made-up fixture fact');
    await r.execute(ids); await r.flush(ids.sessionId);
    const before = r.db.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    const u = r.f.identity.userId;
    expect(advance).toHaveBeenCalledWith(u, ids.sessionId, 1);
    expect(mark).not.toHaveBeenCalled();
    expect(r.db.calls.slice(before).some(call => call.collection === 'user_memory' || call.collection === 'agent-memory'))
      .toBe(false);
    expect(r.f.runtime.memorySession(u, ids.sessionId)?.memoryWatermarkSequence).toBe(1);
  } finally { vi.useRealTimers(); await r.f.dispose(); }
});

const memoryTool = 'update_user_memory';
function toolReply(raw = '{"instruction":"Remember my dog Beans."}', terminal = 'tool_calls',
  name = memoryTool, id = 'memory-tool-1', generationId = 'memory-tool-generation') {
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  return new Response((nativeFrame({ tool_calls: [{ index: 0, type: 'function', id,
    function: { name, arguments: raw } }] }) + nativeFrame({}, terminal)).replaceAll('gen_fixture', generationId)
    + data({ id: generationId, choices: [], usage: { prompt_tokens: 32, completion_tokens: 16, cost: 0.000064 } })
    + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } });
}

it('validates one memory candidate and never forwards arguments from a secret or an invalid batch', () => {
  const call = { index: 0, id: 'memory-tool-1', type: 'function', name: memoryTool,
    arguments: '{"instruction":"Remember my dog Beans."}', envelopeInvalid: false };
  const batch = { calls: [call], terminal: 'tool_calls', envelopeInvalid: false };
  expect(readMemoryToolCandidate(batch, true, CALENDAR_LIMITS)).toMatchObject({
    kind: 'update_user_memory', envelope: { instruction: 'Remember my dog Beans.' },
  });
  expect(readMemoryToolCandidate(batch, false, CALENDAR_LIMITS)).toEqual({ kind: 'memory-invalid' });
  for (const raw of ['{"instruction":"a","instruction":"b"}', '{"instruction":"a","extra":true}',
    '{"instruction":42}', JSON.stringify({ instruction: 'x'.repeat(501) })]) {
    expect(readMemoryToolCandidate({ ...batch, calls: [{ ...call, arguments: raw }] }, true, CALENDAR_LIMITS))
      .toEqual({ kind: 'memory-invalid' });
  }
  for (const malformed of [{ ...batch, terminal: 'length' },
    { ...batch, calls: [call, { ...call, index: 1, name: 'get_environment' }] }]) {
    expect(readMemoryToolCandidate(malformed, true, CALENDAR_LIMITS)).toEqual({ kind: 'memory-invalid' });
  }
  expect(readMemoryToolCandidate({ ...batch, calls: [{ ...call, arguments: '{"instruction":"sk-or-v1-fixture"}' }] },
    true, CALENDAR_LIMITS)).toEqual({ kind: 'memory-secret', toolCallId: 'memory-tool-1' });
});

it('advertises the canonical opt-in definition and parses the memory decision on both native paths', async () => {
  const seed = skillRequest();
  const settings = config();
  const limits = { ...calendarLimits, tools: true };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => toolReply());
  const adapter = createWebNativeModelPort({ ...settings, sessionId: 's1' }, limits, fetcher);
  const web = await collect(adapter.stream({ ...seed, tools: [UPDATE_USER_MEMORY_TOOL_DEFINITION],
    advertised: false, envAdvertised: false }));
  expect(web.find(c => c.type === 'decision')?.decision.kind).toBe(memoryTool);
  const calendar = createCalendarModelPortV2(settings, limits, calendarBinding(), fetcher, undefined, false, true);
  const chunks = await collect(calendar.stream({
    ...seed, tools: [...seed.tools, UPDATE_USER_MEMORY_NATIVE_TOOL],
  }));
  expect(chunks.find(c => c.type === 'decision')?.decision.kind).toBe(memoryTool);
  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies).toHaveLength(2);
  for (const body of bodies) expect(body.tools.at(-1)).toEqual(UPDATE_USER_MEMORY_TOOL_DEFINITION);
});

function toolSnapshot(capable: boolean) {
  const base = textSnapshot();
  return { ...base, modelLimits: { ...base.modelLimits!, contextTokens: 65_536, tools: capable } };
}
const updated = { ...writerResult, changed: true, changeSummary: 'Updated Identity.' };

it.each([
  ['updated', null, updated, { ok: true, status: 'updated', summary: 'Updated Identity.' }, true],
  ['no-change', null, writerResult, { ok: true, status: 'no_change', summary: '' }, false],
  ['persistence-failure', new UserMemoryFault('PERSISTENCE_ERROR'), null,
    { ok: false, error: { code: 'PERSISTENCE_ERROR', retryable: true } }, false],
  ['writer-failure', new UserMemoryFault('MEMORY_WRITER_UNAVAILABLE'), null,
    { ok: false, error: { code: 'WRITER_UNAVAILABLE', retryable: true } }, false],
  ['durable-updated', null, updated, { ok: true, status: 'updated', summary: 'Updated Identity.' }, true],
] as const)('sends an honest %s receipt and only a confirmed memory marker', async (label, error, result, receipt, mark) => {
  const durable = label === 'durable-updated';
  const r = await rig({ snapshot: toolSnapshot(true), durable });
  if (error) r.applyInstruction.mockRejectedValueOnce(error);
  else r.applyInstruction.mockResolvedValueOnce(result!);
  r.f.fetcher.mockResolvedValueOnce(toolReply()).mockResolvedValueOnce(reply('memory-answer', 'A fixture response.'));
  try {
    const a = await r.f.submit('Remember my dog Beans.');
    await r.execute(a);
    const [first, second] = wires(r.f);
    expect(first.tools?.map(t => t.function.name)).toContain(memoryTool);
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', name: memoryTool, tool_call_id: 'memory-tool-1',
      content: JSON.stringify(receipt) });
    expect(r.applyInstruction).toHaveBeenCalledExactlyOnceWith(r.f.identity.userId, 'Remember my dog Beans.',
      expect.objectContaining({ source: 'tool', sessionId: a.sessionId, turnId: a.turnId, signal: expect.any(AbortSignal) }));
    const complete = r.emit.mock.calls.map(([e]) => e.event).find(e => e.type === 'completed')!;
    if (mark) expect(complete).toHaveProperty('memoryUpdated', true);
    else expect(complete).not.toHaveProperty('memoryUpdated');
    if (!durable) await r.flush(a.sessionId);
    expect((await r.p.sessions.get(r.f.identity.userId, a.sessionId))?.memoryWatermarkSequence).toBeUndefined();
    const messages = await r.p.messages.list(r.f.identity.userId, a.sessionId, page);
    expect(messages.items.at(-1)?.memoryUpdated).toBe(mark ? true : undefined);
    expect(r.synthesize).not.toHaveBeenCalled(); // eligibility is retained for the later idle job
  } finally { await r.f.dispose(); }
});

it('returns a secret receipt without repeating the rejected argument or calling the writer', async () => {
  const r = await rig({ snapshot: toolSnapshot(true) });
  r.f.fetcher.mockResolvedValueOnce(toolReply('{"instruction":"sk-or-v1-fixture"}'))
    .mockResolvedValueOnce(reply('memory-secret-answer', 'I could not save that.'));
  try {
    const ids = await r.f.submit('Remember something.');
    await r.execute(ids);
    const second = wires(r.f)[1];
    expect(second.messages.at(-1)).toMatchObject({ content: JSON.stringify({
      ok: false, error: { code: 'SECRET_REJECTED', retryable: false },
    }) });
    expect(JSON.stringify(second)).not.toContain('sk-or-v1-fixture');
    expect(r.applyInstruction).not.toHaveBeenCalled();
  } finally { await r.f.dispose(); }
});

it('runs the explicit tool and completion on fresh Live Voice; a repeated provider call cannot write again', async () => {
  const r = await rig({ snapshot: toolSnapshot(true) });
  r.applyInstruction.mockResolvedValueOnce(updated);
  r.f.fetcher.mockResolvedValueOnce(toolReply()).mockResolvedValueOnce(
    toolReply(undefined, 'tool_calls', memoryTool, 'second-attempted-tool', 'repeated-tool-generation'));
  try {
    const voice = await liveTurn(r, 'voice-explicit-1', undefined, undefined, 'Remember my dog Beans.');
    const a = await r.f.runtime.submitLiveTurn(voice.cmd);
    await r.execute(a, voice.live);
    await voice.release();
    expect(r.applyInstruction).toHaveBeenCalledTimes(1);
    expect(r.emit.mock.calls.map(([f]) => f.event).find(e => e.type === 'completed'))
      .toMatchObject({ memoryUpdated: true });
    await r.flush(a.sessionId);
    expect(r.f.runtime.memoryMessages(r.f.identity.userId, a.sessionId, page)?.items.at(-1)?.memoryUpdated)
      .toBe(true);
  } finally { await r.f.dispose(); }
});

it.each(['paused', 'unwarmed', 'temporary', 'no-native-capability'] as const)('omits the memory tool for %s', async mode => {
  const r = await rig({ snapshot: toolSnapshot(mode !== 'no-native-capability') });
  if (mode === 'paused') { r.cachedMemory.mockReturnValue({ ...stored, enabled: false }); r.cachedSnapshot.mockReturnValue(null); }
  if (mode === 'unwarmed') { r.cachedMemory.mockReturnValue(undefined); r.cachedSnapshot.mockReturnValue(null); }
  try {
    const ids = await r.f.runtime.submitTurn({ identity: r.f.identity, sessionId: null,
      content: 'Hello', idempotencyKey: 'omit-memory-tool', ...(mode === 'temporary' ? { ephemeral: true } : {}) });
    await r.execute(ids);
    expect(wires(r.f)[0].tools?.map(t => t.function.name) ?? []).not.toContain(memoryTool);
    if (mode !== 'no-native-capability') expect(memoryBlock(wires(r.f)[0])).toBeUndefined();
    expect(r.applyInstruction).not.toHaveBeenCalled();
  } finally { await r.f.dispose(); }
});

it('uses the frozen Dev dispatch to omit memory and never learns from the Dev answer', async () => {
  const a = authority();
  a.mode.setEnabled(true);
  const r = await rig({ snapshot: toolSnapshot(true), devMode: a.mode });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const ids = await r.f.submit('Private Dev text');
    a.mode.select(a.principal, 'dev');
    await r.execute(ids, undefined, a.principal);
    const first = wires(r.f)[0];
    expect(first.tools).toBeUndefined();
    expect(memoryBlock(first)).toBeUndefined();
    expect(first.messages.at(-1)?.content).toContain('[Current mode: Dev]');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.synthesize).not.toHaveBeenCalled();
    expect(r.applyInstruction).not.toHaveBeenCalled();
    await r.flush(ids.sessionId);
    expect((await r.p.memory.get(r.f.identity.userId, ids.sessionId))?.pinnedUserMemory).toEqual(beans);
  } finally { vi.useRealTimers(); await r.f.dispose(); }
});

it('advertises a command for a confirmed empty account without adding a prompt block', async () => {
  const r = await rig({ snapshot: toolSnapshot(true) });
  r.cachedMemory.mockReturnValue(null);
  r.cachedSnapshot.mockReturnValue(null);
  try {
    await r.execute(await r.f.submit('Ordinary text'));
    expect(memoryBlock(wires(r.f)[0])).toBeUndefined();
    expect(wires(r.f)[0].tools?.map(t => t.function.name)).toContain(memoryTool);
    expect(r.applyInstruction).not.toHaveBeenCalled();
  } finally { await r.f.dispose(); }
});

it.each([false, true])('continues a Calendar native memory call without Calendar authority (voice=%s)', async isVoice => {
  const snap = toolSnapshot(true);
  const r = await rig({ snapshot: { ...snap, modelLimits: { ...calendarLimits, tools: true } } });
  r.applyInstruction.mockResolvedValueOnce(updated);
  try {
    const voice = isVoice ? await liveTurn(r, 'voice-calendar-memory', undefined, undefined, 'Remember my dog Beans.') : null;
    const a = voice ? await r.f.runtime.submitLiveTurn(voice.cmd)
      : await r.f.submit('Remember my dog Beans.');
    const dispatchCount = r.db.calls.length;
    r.f.fetcher.mockImplementationOnce(async () => {
      expect(r.db.calls).toHaveLength(dispatchCount);
      return toolReply();
    }).mockResolvedValueOnce(reply('cal-memory-answer', 'I updated your memory.'));
    await r.execute(a, voice?.live);
    await voice?.release();
    const [first, second] = wires(r.f);
    expect(first.tools?.map(t => t.function.name)).toEqual([
      'activate_skill', 'call_tool', 'control_canvas', 'get_environment', memoryTool,
    ]);
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', name: memoryTool,
      tool_call_id: 'memory-tool-1', content: '{"ok":true,"status":"updated","summary":"Updated Identity."}' });
    expect(r.applyInstruction).toHaveBeenCalledTimes(1);
    expect(r.emit.mock.calls.map(([e]) => e.event).find(e => e.type === 'completed'))
      .toMatchObject({ memoryUpdated: true });
    await r.flush(a.sessionId);
    expect(await r.p.sessions.get(r.f.identity.userId, a.sessionId)).not.toHaveProperty('memoryWatermarkSequence');
    expect(JSON.stringify([...r.db.rows('metadata').values()])).not.toContain('[withheld]');
    const next = await r.f.submit('Follow up', a.sessionId);
    await r.execute(next);
    expect(wires(r.f).at(-1)?.messages.some(m => m.name === memoryTool)).toBe(false);
    expect(r.applyInstruction).toHaveBeenCalledTimes(1);
  } finally { await r.f.dispose(); }
});

it('does not execute an advertised memory decision after the account pauses memory', async () => {
  const snap = toolSnapshot(true);
  const r = await rig({ snapshot: { ...snap, modelLimits: { ...calendarLimits, tools: true } } });
  try {
    r.f.fetcher.mockImplementationOnce(async () => {
      r.cachedMemory.mockReturnValue({ ...stored, enabled: false });
      return toolReply();
    }).mockResolvedValueOnce(reply('paused-memory-answer', 'Memory is paused.'));
    const a = await r.f.submit('Remember my dog Beans.');
    await r.execute(a);
    expect(r.applyInstruction).not.toHaveBeenCalled();
    expect(wires(r.f)[1].messages.at(-1)?.content)
      .toBe('{"ok":false,"error":{"code":"MEMORY_DISABLED","retryable":false}}');
    expect(wires(r.f)[1].tools?.some(t => t.function.name === memoryTool)).toBe(false);
    expect(r.emit.mock.calls.map(([e]) => e.event).find(e => e.type === 'completed')).not.toHaveProperty('memoryUpdated');
  } finally { await r.f.dispose(); }
});

const catalogEntry = (id: string, outputCap = 'max_tokens') => ({
  id, architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  endpoints: ['/api/v1/chat/completions'], context_length: 65_536,
  top_provider: { max_completion_tokens: 4096 }, supported_parameters: [outputCap],
});

it('prepares exact distinct writer limits once on activation, never by borrowing the main limits', async () => {
  const f = assemblyFixture();
  const row = document();
  row.settings.openRouter.modelId = 'fixture/model';
  row.settings.openRouter.reasoningEffort = 'provider-default';
  row.settings.memory = { modelMode: 'custom', customModelId: 'fixture/writer' };
  const candidate = { revision: row.revision, settings: row.settings,
    credentials: { openrouter: 'fixture-only', deepgram: null } };
  const read = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    data: [catalogEntry('fixture/model'), catalogEntry('fixture/writer', 'max_completion_tokens')],
  }));
  const prepare = () => prepareConfigurationSnapshot(f.bootstrap, candidate, f.assets,
    loadModelLimits, read, new AbortController().signal);
  const config = await prepare();
  expect(config.memoryModelId).toBe('fixture/writer');
  expect(config.memoryModelLimits).toMatchObject({ modelId: 'fixture/writer', contextTokens: 65_536,
    outputCapParameter: 'max_completion_tokens' });
  expect(config.modelLimits?.modelId).toBe('fixture/model');
  expect(read.mock.calls.every(([url, init]) => String(url).includes('/models?') && init?.method === 'GET')).toBe(true);
  candidate.settings.memory.customModelId = 'fixture/missing';
  await expect(prepare()).rejects.toBeDefined();
});

it('reuses verified main limits for a matching writer id and rejects an expired distinct id', async () => {
  const f = assemblyFixture();
  const row = document();
  row.settings.openRouter.modelId = 'fixture/model';
  row.settings.openRouter.reasoningEffort = 'provider-default';
  row.settings.memory = { modelMode: 'custom', customModelId: 'fixture/model' };
  const candidate = { revision: row.revision, settings: row.settings,
    credentials: { openrouter: 'fixture-only', deepgram: null } };
  const read = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    data: [catalogEntry('fixture/model')],
  }));
  const config = await prepareConfigurationSnapshot(f.bootstrap, candidate, f.assets,
    loadModelLimits, read, new AbortController().signal);
  expect(config.memoryModelId).toBe('fixture/model');
  expect(config.memoryModelLimits).toMatchObject({ modelId: 'fixture/model' });
  expect(read).toHaveBeenCalledTimes(1);
  candidate.settings.memory.customModelId = 'fixture/writer';
  read.mockResolvedValue(Response.json({ data: [
    catalogEntry('fixture/model'), { ...catalogEntry('fixture/writer'), expiration_date: '2026-11-01' },
  ] }));
  await expect(prepareConfigurationSnapshot(f.bootstrap, candidate, f.assets,
    loadModelLimits, read, new AbortController().signal)).rejects.toBeDefined();
});

it('warms once in authenticated owner preparation and uses the active custom writer with native CAS and accounting', async () => {
  const r = await rig();
  const seeded = document();
  seeded.settings.openRouter.modelId = 'fixture/model';
  seeded.settings.openRouter.reasoningEffort = 'provider-default';
  seeded.settings.memory = { modelMode: 'custom', customModelId: 'fixture/writer' };
  const f = assemblyFixture();
  seeded.credentials.openrouter = { envelope: f.credentials.seal('openrouter', 'fixture-only'), validatedAt: at };
  f.seed(seeded);
  f.ports.open = async () => ({ ...r.p, close: async () => {} }) as never;
  const sent: Array<Record<string, unknown>> = [];
  f.ports.fetcher = async (input, init) => {
    if (String(input).includes('/models?'))
      return Response.json({ data: [catalogEntry('fixture/writer', 'max_completion_tokens')] });
    if (!String(input).endsWith('/chat/completions')) throw new Error('Unexpected network fixture');
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return reply('custom-writer-result', JSON.stringify({
      changed: true, changeSummary: 'Saved Identity.',
      sections: { ...stored.sections, identity: 'Dog: Mochi.' },
    }));
  };
  const fromStore = vi.spyOn(r.p.userMemory, 'read');
  const service = await AppService.create(f.bootstrap, f.ports);
  const principal = admitAccount(admittedAccount({ userId: stored.userId }), 'sid_1');
  try {
    await service.prepareOwner(principal);
    await service.prepareOwner(principal);
    expect(fromStore).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    expect(service.userMemory.cachedMemory(stored.userId)).toBeNull();
    await expect(service.memoryWriter.applyInstruction(stored.userId, 'Remember my dog Mochi.', {
      source: 'composer', expectedRevision: 0,
    })).resolves.toMatchObject({ changed: true, memory: { revision: 1 } });
    expect(sent).toEqual([expect.objectContaining({ model: 'fixture/writer', user: stored.userId,
      max_completion_tokens: 1536 })]);
    expect(service.userMemory.cachedSnapshot(stored.userId)?.content).toContain('Dog: Mochi.');
    expect([...r.db.rows('metadata').values()]).toContainEqual(expect.objectContaining({
      kind: 'accounting', purpose: 'memory', userId: stored.userId, requestedModel: 'fixture/writer',
    }));
    await service.onUserDeactivated(stored.userId);
    expect(service.userMemory.cachedMemory(stored.userId)).toBeUndefined();
  } finally { await service.operations.shutdown(); await r.f.dispose(); }
});

function stubCascade(r: Awaited<ReturnType<typeof rig>>) {
  const store = r.p.owner.store;
  const collection = store.collection.bind(store);
  const deletes = vi.fn();
  vi.spyOn(store, 'collection').mockImplementation(name => {
    const col = collection(name);
    col.deleteMany = async filter => {
      if (!filter) throw new Error('Missing scope');
      deletes(name, filter);
      let deletedCount = 0;
      for (const [id, row] of r.db.rows(name)) {
        if (Object.entries(filter).every(([field, value]) => field === 'kind'
          ? value !== null && typeof value === 'object' && '$ne' in value && row.kind !== value.$ne
          : row[field] === value)) {
          r.db.rows(name).delete(id); deletedCount++;
        }
      }
      return { acknowledged: true, deletedCount };
    };
    return col;
  });
  return deletes;
}

it('hard-purges Temporary Chat through private DELETE, not the ordinary soft delete', async () => {
  const r = await rig();
  const u = r.f.identity.userId;
  const auth = await authFixture(admittedAccount({ userId: u }));
  const identities = new RequestIdentityStore();
  const identity = new ServerIdentityResolver(identities);
  const origin = 'http://localhost:5173';
  const deletes = stubCascade(r);
  const normalDelete = vi.spyOn(r.p.sessions, 'delete');
  const module = await Test.createTestingModule({ imports: [ChatHttpModule.register({
    runtime: r.f.runtime, identity, principal: () => identities.principal(), budgets: DEFAULT_BUDGETS,
    sessions: {
      get: r.p.sessions.get.bind(r.p.sessions), list: r.p.sessions.list.bind(r.p.sessions),
      createIfAbsent: r.p.sessions.createIfAbsent.bind(r.p.sessions),
      touchActivity: r.p.sessions.touchActivity.bind(r.p.sessions), update: r.p.sessions.update.bind(r.p.sessions),
      delete: (owner, s) => r.p.sessions.delete(owner, s), hardPurgeSession: (owner, s) => r.f.runtime.purgeEphemeral(owner, s).then(() => undefined),
    },
    messages: r.p.messages,
  })] }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  app.setGlobalPrefix('api');
  configurePrivateHttp(app, { auth: auth.service, identities, frontendOrigin: origin, secureCookie: false });
  configureChatHttp(app, DEFAULT_BUDGETS);
  await app.init();
  const http = request(app.getHttpServer());
  const path = (id: string) => `/api/sessions/${id}`;
  try {
    const make = (content: string, idempotencyKey: string, ephemeral?: boolean) =>
      http.post('/api/sessions').set('Cookie', SESSION_COOKIE).set('Origin', origin)
        .send({ sessionId: null, content, idempotencyKey, ...(ephemeral === undefined ? {} : { ephemeral }) }).expect(202);
    const normal = (await make('Keep this', 'keep-normal-1')).body as SubmitTurnResponse;
    await r.execute(normal); await r.flush(normal.sessionId);
    const temp = (await make('Forget this conversation', 'purge-temp-1', true)).body as SubmitTurnResponse;
    await r.execute(temp); await r.flush(temp.sessionId);
    await http.post(`${path(normal.sessionId)}/turns`).set('Cookie', SESSION_COOKIE).set('Origin', origin)
      .send({ sessionId: normal.sessionId, idempotencyKey: 'late-temp-mode',
        content: 'Do not change mode', ephemeral: true }).expect(400);
    await http.get(path(temp.sessionId)).set('Cookie', SESSION_COOKIE).expect(200)
      .expect(({ body }) => { expect(body.ephemeral).toBe(true); });
    await http.delete(path(temp.sessionId)).set('Cookie', SESSION_COOKIE).set('Origin', 'https://other.example').expect(403);
    expect(deletes).not.toHaveBeenCalled();
    const purge = await http.delete(path(temp.sessionId)).set('Cookie', SESSION_COOKIE).set('Origin', origin).expect(204);
    expect(purge.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    expect(normalDelete).not.toHaveBeenCalled();
    expect(deletes.mock.calls.map(([name]) => name)).toEqual(['checkpoint_writes', 'checkpoints', 'agent-memory', 'messages', 'metadata']);
    expect(await r.p.sessions.get(u, temp.sessionId)).toBeNull();
    expect(r.f.runtime.memorySession(u, temp.sessionId)).toBeNull();
    expect([...r.db.rows('metadata').values()].filter(row => row.sessionId === temp.sessionId))
      .toEqual([expect.objectContaining({ kind: 'accounting' })]);
    await http.get(path(temp.sessionId)).set('Cookie', SESSION_COOKIE).expect(404);
    await http.delete(path(normal.sessionId)).set('Cookie', SESSION_COOKIE).set('Origin', origin).expect(204);
    expect(await r.p.sessions.get(u, normal.sessionId)).toMatchObject({ lifecycle: 'archived' });
  } finally { await app.close(); await r.f.dispose(); }
});

it('waits out a held archive under the Temporary Chat fence and never resurrects it', async () => {
  const r = await rig();
  const deletes = stubCascade(r);
  const gate = r.db.pauseNextUpdate();
  const c = { identity: r.f.identity, sessionId: null, content: 'Temporary input',
    idempotencyKey: 'held-archive-temp', ephemeral: true };
  try {
    const ids = await r.f.runtime.submitTurn(c);
    await r.execute(ids);
    await gate.started;
    expect(await r.f.runtime.purgeEphemeral(c.identity.userId, ids.sessionId, {
      cutoff: new Date(Date.now() + 60_000).toISOString(),
    })).toBe(false);
    const purge = r.f.runtime.purgeEphemeral(c.identity.userId, ids.sessionId);
    await expect(r.f.runtime.submitTurn(c)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(deletes).not.toHaveBeenCalled();
    gate.resume();
    expect(await purge).toBe(true);
    await expect(r.f.runtime.submitTurn(c)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await r.p.sessions.get(c.identity.userId, ids.sessionId)).toBeNull();
    expect(r.f.runtime.memoryMessages(c.identity.userId, ids.sessionId, page)).toBeNull();
  } finally { gate.resume(); await r.f.dispose(); }
});

it('does not enable Temporary Live Voice by accepting an optional wire flag', async () => {
  const f = assemblyFixture();
  const service = await AppService.create(f.bootstrap, f.ports);
  const owner = admitAccount(admittedAccount({ userId: stored.userId }), 'sid_1');
  const admit = vi.spyOn(service.voiceSessions.options, 'admission');
  try {
    await expect(service.voiceSessions.create({ ...createSessionFixture('live'), ephemeral: true },
      f.bootstrap.frontendOrigin, owner)).rejects.toMatchObject({ code: 'INVALID_VOICE_REQUEST' });
    expect(admit).not.toHaveBeenCalled();
  } finally { await service.operations.shutdown(); }
});

it('conditionally forwards trusted temporary mode only when Live Voice creates a new conversation', async () => {
  const r = await rig();
  const initial = await r.f.runtime.reservations.acquire({ identity: r.f.identity, conversationId: null,
    owner: { kind: 'live', voiceSessionId: 'voice-temp-admitted' } });
  const submit = vi.spyOn(r.f.runtime, 'submitLiveTurn');
  try {
    const context: VoiceTurnContext = {
      identity: r.f.identity, voiceConfig: r.snapshot.voice, configSnapshot: r.snapshot,
      response: createSessionResponseFixture('live', { sessionId: 'voice-temp-admitted' }),
      reservation: initial, ephemeral: true,
    };
    const bridge = new AgentVoiceAdapter(r.f.runtime, async (_id, conversationId) => {
      context.reservation = await r.f.runtime.reservations.bindConversation({
        identity: context.identity, reservationId: initial.reservationId, conversationId });
      context.response.conversationId = conversationId;
    });
    const ids = (await bridge.submit(context, { providerSocketEpoch: 1, providerTurnId: 'fresh', text: 'First' }, true))!;
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ ephemeral: true, freshConversation: true });
    expect(r.f.runtime.memorySession(r.f.identity.userId, ids.sessionId)?.ephemeral).toBe(true);
    const next = { providerSocketEpoch: 1, providerTurnId: 'next', text: 'Follow up' };
    await r.f.runtime.cancelLiveTurn({ identity: r.f.identity, ...ids }, context.reservation!);
    await bridge.submit(context, next);
    expect(submit.mock.calls[1]?.[0]).not.toHaveProperty('ephemeral');
    expect(r.cachedSnapshot).not.toHaveBeenCalled();
  } finally { await r.f.dispose(); }
});

it('sweeps a bounded over-24-hour Temporary page at startup and hourly, then stops on shutdown', async () => {
  const r = await rig();
  const f = assemblyFixture();
  const now = Date.now();
  const older = new Date(now - EPHEMERAL_SESSION_MAX_AGE_MS - 1).toISOString();
  const exact = new Date(now - EPHEMERAL_SESSION_MAX_AGE_MS).toISOString();
  const u = r.f.identity.userId;
  stubCascade(r);
  const put = (id: string, lastActivityAt: string, ephemeral: boolean) =>
    r.p.sessions.createIfAbsent({ ...session(u, id), lastActivityAt, ...(ephemeral ? { ephemeral: true } : {}) });
  await put('startup-old', older, true);
  await put('exact-cutoff', exact, true);
  await put('not-temporary', older, false);
  const list = vi.spyOn(r.p.sessions, 'listExpiredEphemeral');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  f.ports.open = async () => ({ ...r.p, close: async () => {} }) as never;
  f.ports.runtime = () => r.f.runtime;
  const service = await AppService.create(f.bootstrap, f.ports);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    await flush();
    expect(await r.p.sessions.get(u, 'startup-old')).toBeNull();
    expect((await r.p.sessions.get(u, 'exact-cutoff'))?.ephemeral).toBe(true);
    expect(list).toHaveBeenCalledExactlyOnceWith(exact, Math.min(50, DEFAULT_BUDGETS.maxPageSize));
    expect(await r.p.sessions.get(u, 'not-temporary')).not.toBeNull();
    clock.mockReturnValue(now + 3_600_000);
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(await r.p.sessions.get(u, 'exact-cutoff')).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
    expect(await service.operations.shutdown()).toMatchObject({ safe: true });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore(); vi.useRealTimers();
    await service.operations.shutdown(); await r.f.dispose();
  }
});

it('holds one in-flight sweep page and starts no further sweep after shutdown', async () => {
  const r = await rig();
  const f = assemblyFixture();
  stubCascade(r);
  const held = Promise.withResolvers<Awaited<ReturnType<typeof r.p.sessions.listExpiredEphemeral>>>();
  const list = vi.spyOn(r.p.sessions, 'listExpiredEphemeral').mockReturnValue(held.promise);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  f.ports.open = async () => ({ ...r.p, close: async () => {} }) as never;
  f.ports.runtime = () => r.f.runtime;
  const service = await AppService.create(f.bootstrap, f.ports);
  try {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(list).toHaveBeenCalledTimes(1);
    const shutdown = service.operations.shutdown();
    held.resolve([]);
    await shutdown;
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    held.resolve([]); vi.useRealTimers();
    await service.operations.shutdown(); await r.f.dispose();
  }
});
