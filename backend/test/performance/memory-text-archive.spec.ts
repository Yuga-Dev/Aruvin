/**
 * ============================================================================
 * FILE: memory-text-archive.spec.ts
 * LOCATION: backend/test/performance/memory-text-archive.spec.ts
 * ============================================================================
 * PURPOSE: Verify terminal publication, ambiguity, bounded saves and legacy handoff.
 * ROLE IN PROJECT: Real repositories and stock saver over the existing fake driver.
 * KEY COMPONENTS: Blocked native writes, partial visibility, retry IDs and tombstones.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { textConfigFixture } from '../runtime/text-config-fixture.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { MemoryTextArchive } from '../../src/persistence/memory-text-archive.js';
import { DurableChatRuntime } from '../../src/chat-runtime/durable-chat-runtime.js';
import { key, graphThreadId } from '../../src/persistence/records.js';
import { ChatHttpService } from '../../src/http/chat-http.service.js';
import { ServerIdentityResolver } from '../../src/platform/identity/server-identity-resolver.js';
import { RequestIdentityStore } from '../../src/platform/identity/request-identity-store.js';
import { principal } from '../assembly/auth-principal-fixture.js';
import { OperationsService } from '../../src/operations/operations.service.js';
import { AppService } from '../../src/app.service.js';
import { assemblyFixture } from '../assembly/admin-config-fixture.js';
import { document, at, secret } from '../admin-config/fixtures.js';
import {
  MemoryCalendarStage, isFullyErasedMemoryCalendarState, memoryCalendarIntegrity,
  memoryCalendarPublicationHash, memoryCalendarRecordSchema, memoryCalendarStateSchema,
  verifyMemoryCalendarRecordIntegrity,
} from '../../src/chat-runtime/memory-calendar-state.js';
import { MemoryCalendarLedger } from '../../src/chat-runtime/memory-calendar-ledger.js';
import { MemoryFirstFoundation } from '../../src/chat-runtime/memory-first-foundation.js';
import { sourceV2, calendarPage } from '../contracts/calendar-multi-fixtures.js';
import { connectionV2 } from '../persistence/calendar-multi-fixtures.js';
import { calendarLimits, fixturePricing } from '../model/calendar-fixtures.js';
import { CALENDAR_LIMITS } from '../../src/contracts/calendar-policy.js';
import { calendarToolResultRecordV2Schema, sourceReferenceV2Schema } from '../../src/contracts/calendar-sources.js';
import { resumableSkillDecisionSchema } from '../../src/contracts/calendar-model.js';
import { modelAggregateSchema } from '../../src/contracts/calendar-accounting.js';
import { aggregateKey } from '../../src/persistence/calendar-records.js';
import { assets as contextAssets } from '../context/fixtures.js';
import { MongoCalendarRetention } from '../../src/persistence/calendar-retention.js';

async function fixture(policy: Partial<typeof PROPOSED_MEMORY_TEXT_POLICY> = {}) {
  const memory = calendarMemory();
  const client = Object.assign(memory.commandSource, { db: () => memory.store.db, appendMetadata: () => undefined }) as unknown as MongoClient;
  const p = await createPersistenceBundle(client, 'offline-memory-text', DEFAULT_BUDGETS, 'offline-executor');
  const f = textConfigFixture(textSnapshot(1), d => ({ ...d, memoryFirst: {
    policy: { ...PROPOSED_MEMORY_TEXT_POLICY, maxAttempts: 1, shutdownDrainMs: 30, ...policy },
  } }), p);
  const http = new ChatHttpService({ runtime: f.runtime, sessions: p.sessions, messages: p.messages,
    budgets: f.runtime.d.config.budgets,
    identity: { resolve: () => principal(f.identity.userId).identity,
      assertNoClientOverrides: new ServerIdentityResolver(new RequestIdentityStore()).assertNoClientOverrides },
    principal: () => principal(f.identity.userId) });
  const state = (s: string, t: string) => f.runtime.getTurnStatus(f.identity.userId, s, t);
  const settle = async (s: string, t: string, expected = 'saved') => vi.waitFor(async () =>
    expect((await state(s, t)).save?.state).toBe(expected));
  const envelope = (s: string, t: string) => {
    const turn = f.runtime.memoryFor(f.identity.userId)!.foundation.byTurn(s, t)!;
    return f.runtime.memoryFor(f.identity.userId)!.foundation.result(turn)!;
  };
  return { ...f, memory, http, settle, state, envelope };
}

it('streams and dispatches a warm follow-up while the actual storage write is paused', async () => {
  const f = await fixture();
  const paused = f.memory.pauseNextUpdate();
  const a = await f.submit('First'); await f.execute(a); await paused.started;
  const count = f.memory.calls.length;
  expect((await f.http.messages(a.sessionId, {})).items.map(m => m.content)).toEqual(['First', 'Hello 🌍']);
  expect(await f.http.status(a.sessionId, a.turnId)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } });
  const b = await f.submit('Second', a.sessionId); await f.execute(b);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.memory.calls).toHaveLength(count);
  expect(await f.runtime.drain(30)).toMatchObject({ drained: false });
  paused.resume(); await f.settle(b.sessionId, b.turnId);
  expect(await f.runtime.drain(30)).toMatchObject({ drained: true });
});

it.each(['text', 'live'] as const)('prepares cold %s history before submission and dispatches without archive I/O', async mode => {
  const f = await fixture();
  const first = await f.submit('First'); await f.execute(first); await f.settle(first.sessionId, first.turnId);
  const cold = new DurableChatRuntime({ ...f.runtime.d,
    memoryFirst: { ...f.runtime.d.memoryFirst!, voice: true } });
  const http = new ChatHttpService({ ...f.http.o, runtime: cold });
  const reservation = mode === 'live'
    ? await cold.reservations.acquire({ identity: f.identity, conversationId: first.sessionId,
        owner: { kind: 'live', voiceSessionId: 'cold-voice' } })
    : null;
  if (!reservation) expect((await http.messages(first.sessionId, {})).items.map(m => m.content))
    .toEqual(['First', 'Hello 🌍']);
  const command = { identity: f.identity, sessionId: first.sessionId, content: 'Second', idempotencyKey: 'cold-second' };
  const before = f.memory.calls.length;
  let atDispatch = -1;
  const wire = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementationOnce(async (...args) => { atDispatch = f.memory.calls.length; return wire(...args); });
  const liveCommand = reservation ? { ...command, reservation,
    voice: { voiceSessionId: 'cold-voice', socketEpoch: 1, providerTurnId: 'cold-provider' } } : null;
  if (liveCommand) expect(await cold.findLiveSubmission(liveCommand)).toBeNull();
  const second = liveCommand ? await cold.submitLiveTurn(liveCommand) : await http.submit(first.sessionId,
    { sessionId: command.sessionId, content: command.content, idempotencyKey: command.idempotencyKey });
  expect(f.memory.calls).toHaveLength(before);
  await cold.executeTurn({ userId: f.identity.userId, ...second, signal: new AbortController().signal, emit: async () => {},
    ...(reservation ? { live: { reservation, start: async () => {}, delta: async () => {},
      finish: async () => {}, settle: async () => {} } } : {}) });
  expect(atDispatch).toBe(before);
  const body = JSON.parse(f.fetcher.mock.calls[1][1]?.body as string);
  expect(body.messages.filter((m: { role: string }) => m.role !== 'system').map((m: { content: string }) => m.content))
    .toEqual(['First', 'Hello 🌍', 'Second']);
  await vi.waitFor(async () => expect((await (reservation
    ? cold.getLiveTurnStatus(f.identity.userId, second.sessionId, second.turnId, reservation)
    : cold.getTurnStatus(f.identity.userId, second.sessionId, second.turnId))).save?.state).toBe('saved'));
  await cold.drain(1000); await f.dispose();
});

it('keeps the read-only archive available if preparation throws synchronously', async () => {
  const f = await fixture();
  const first = await f.submit('First'); await f.execute(first); await f.settle(first.sessionId, first.turnId);
  const cold = new DurableChatRuntime(f.runtime.d);
  vi.spyOn(cold, 'prepareSession').mockImplementation(() => { throw new Error('Runtime unavailable.'); });
  const http = new ChatHttpService({ ...f.http.o, runtime: cold });
  expect((await http.messages(first.sessionId, {})).items.map(m => m.content)).toEqual(['First', 'Hello 🌍']);
  await f.dispose();
});

it('publishes dependencies before the watermark and hides partial completion from cold readers', async () => {
  const f = await fixture();
  vi.spyOn(f.p.memory, 'put').mockRejectedValueOnce(new Error('offline partial publication'));
  const a = await f.submit(); await f.execute(a); await f.settle(a.sessionId, a.turnId, 'unknown');
  expect(f.memory.rows('messages')?.size).toBe(2);
  expect(await f.p.sessions.get(f.identity.userId, a.sessionId)).toMatchObject({ latestTurnId: null, memoryPublication: { version: 0 } });
  const cold = new DurableChatRuntime(f.runtime.d);
  const http = new ChatHttpService({ ...f.http.o, runtime: cold });
  expect((await http.messages(a.sessionId, {})).items).toEqual([]);
  await expect(http.status(a.sessionId, a.turnId)).rejects.toMatchObject({ code: 'NOT_READY' });
  await expect(cold.submitTurn({ identity: f.identity, sessionId: a.sessionId, content: 'Next', idempotencyKey: 'cold-no-replay' }))
    .rejects.toMatchObject({ code: 'NOT_READY' });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  const adapter = new MemoryTextArchive(f.p, f.runtime.d.assets);
  const result = await adapter.save(f.envelope(a.sessionId, a.turnId), { maxOperations: 32, maxBytes: 524288 });
  expect(result.kind).toBe('saved');
  // The adapter acknowledgement alone does not advance a different owner's ledger.
  expect(await f.state(a.sessionId, a.turnId)).toMatchObject({ status: 'completed', save: { state: 'unknown', durableVersion: 0 } });
  expect(await f.runtime.drain(30)).toMatchObject({ drained: false });
});

it('reconciles commit-then-error immutable writes and never creates duplicate terminal records', async () => {
  const f = await fixture();
  f.memory.failNext('after-write', { collection: 'messages', method: 'updateOne' });
  const a = await f.submit(); await f.execute(a); await f.settle(a.sessionId, a.turnId);
  const adapter = new MemoryTextArchive(f.p, f.runtime.d.assets), e = f.envelope(a.sessionId, a.turnId);
  expect((await adapter.save(e, { maxOperations: 32, maxBytes: 524288 })).kind).toBe('saved');
  expect(f.memory.rows('messages')?.size).toBe(2);
  expect([...f.memory.rows('metadata')!.values()].filter(r => r.kind === 'attempt')).toHaveLength(1);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  await f.dispose();
});

it('preserves rename/pin, rejects stale projection and never resurrects an archived session', async () => {
  const f = await fixture();
  const a = await f.submit(); await f.execute(a); await f.settle(a.sessionId, a.turnId);
  const e = f.envelope(a.sessionId, a.turnId), adapter = new MemoryTextArchive(f.p, f.runtime.d.assets);
  await f.p.sessions.update(f.identity.userId, a.sessionId, { title: 'Renamed', pinned: true });
  expect((await adapter.save(e, { maxOperations: 32, maxBytes: 524288 })).kind).toBe('saved');
  expect(await f.p.sessions.get(f.identity.userId, a.sessionId)).toMatchObject({ title: 'Renamed', pinned: true });
  const b = await f.submit('Second', a.sessionId); await f.execute(b); await f.settle(b.sessionId, b.turnId);
  expect((await adapter.save(e, { maxOperations: 32, maxBytes: 524288 })).kind).toBe('failed');
  expect(await f.p.sessions.get(f.identity.userId, a.sessionId)).toMatchObject({ memoryPublication: { version: 2 }, latestTurnId: b.turnId });
  await f.http.deleteSession(a.sessionId);
  expect((await adapter.save(f.envelope(b.sessionId, b.turnId), { maxOperations: 32, maxBytes: 524288 })).kind).toBe('failed');
  expect(await f.p.sessions.get(f.identity.userId, a.sessionId)).toMatchObject({ lifecycle: 'archived' });
  await f.dispose();
});

it('refuses dirty rename/delete without discarding the authoritative result', async () => {
  const f = await fixture(); const paused = f.memory.pauseNextUpdate();
  const a = await f.submit(); await f.execute(a); await paused.started;
  await expect(f.http.deleteSession(a.sessionId)).rejects.toMatchObject({ code: 'NOT_READY' });
  await expect(f.http.updateSession(a.sessionId, { title: 'New' })).rejects.toMatchObject({ code: 'NOT_READY' });
  expect((await f.http.messages(a.sessionId, {})).items).toHaveLength(2);
  paused.resume(); await f.settle(a.sessionId, a.turnId); await f.dispose();
});

it('hands saved plain history to the legacy graph and refreshes memory after durable execution', async () => {
  const f = await fixture();
  const a = await f.submit('First'); await f.execute(a); await f.settle(a.sessionId, a.turnId);
  const reservation = await f.runtime.reservations.acquire({ identity: f.identity, conversationId: a.sessionId,
    owner: { kind: 'live', voiceSessionId: 'voice-handoff' } });
  await expect(f.submit('blocked', a.sessionId)).rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
  await f.runtime.reservations.release({ identity: f.identity, reservationId: reservation.reservationId });
  // Exercise the unchanged durable text graph as a stand-in for its shared
  // publication boundary; dedicated voice/Calendar fixtures run separately.
  const legacy = new DurableChatRuntime({ ...f.runtime.d, memoryFirst: undefined });
  const b = await legacy.submitTurn({ identity: f.identity, sessionId: a.sessionId, content: 'Durable', idempotencyKey: 'durable-handoff' });
  await legacy.executeTurn({ userId: f.identity.userId, ...b, signal: new AbortController().signal, emit: async () => {} });
  expect(await f.p.sessions.get(f.identity.userId, a.sessionId)).not.toHaveProperty('memoryPublication');
  const c = await f.submit('Third', a.sessionId); await f.execute(c); await f.settle(c.sessionId, c.turnId);
  const body = JSON.parse(f.fetcher.mock.calls.at(-1)![1]?.body as string);
  expect(body.messages.filter((m: {role: string}) => m.role !== 'system').map((m: {content: string}) => m.content))
    .toEqual(['First', 'Hello 🌍', 'Durable', 'Hello 🌍', 'Third']);
  await f.dispose();
});

it('enforces projection limits and payload identity before publishing success', async () => {
  const f = await fixture();
  const a = await f.submit(); await f.execute(a); await f.settle(a.sessionId, a.turnId);
  const e = f.envelope(a.sessionId, a.turnId), adapter = new MemoryTextArchive(f.p, f.runtime.d.assets);
  expect((await adapter.save(e, { maxOperations: 1, maxBytes: 524288 })).kind).toBe('failed');
  expect((await adapter.save(e, { maxOperations: 32, maxBytes: 1 })).kind).toBe('failed');
  expect((await adapter.save({ ...e, output: { ...e.output, content: 'tampered' } }, { maxOperations: 32, maxBytes: 524288 })).kind).toBe('failed');
  expect(f.memory.rows('messages')?.get(key('message', f.identity.userId, a.sessionId, e.output.messageId))?.content).toBe('Hello 🌍');
  await f.dispose();
});

it('retries saving through HTTP without resetting the attempt budget or invoking the model', async () => {
  const f = await fixture({ maxAttempts: 1 });
  vi.spyOn(f.p.memory, 'put').mockRejectedValueOnce(new Error('offline'));
  const a = await f.submit(); await f.execute(a); await f.settle(a.sessionId, a.turnId, 'unknown');
  const status = await f.state(a.sessionId, a.turnId), save = status.save!;
  await expect(f.http.retrySave(a.sessionId, a.turnId, { epoch: save.epoch, version: save.version }))
    .rejects.toMatchObject({ code: 'NOT_READY' });
  await expect(f.http.retrySave(a.sessionId, a.turnId, { epoch: 'old-process', version: save.version }))
    .rejects.toMatchObject({ code: 'INTERRUPTED' });
  await expect(f.http.retrySave(a.sessionId, a.turnId, { epoch: save.epoch, version: save.version, content: 'untrusted' }))
    .rejects.toMatchObject({ code: 'UNKNOWN_FIELD' });
  expect(await f.state(a.sessionId, a.turnId)).toMatchObject({ status: 'completed', save: { state: 'unknown' } });
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it('reduces complete database command and write totals after background publication', async () => {
  const f = await fixture();
  const start = f.memory.wireCalls.length;
  const a = await f.submit('Plain'); await f.execute(a); await f.settle(a.sessionId, a.turnId);
  const plain = f.memory.wireCalls.slice(start);
  await f.runtime.drain(30);
  const durable = new DurableChatRuntime({ ...f.runtime.d, memoryFirst: undefined });
  const legacyStart = f.memory.wireCalls.length;
  const b = await durable.submitTurn({ identity: f.identity, sessionId: null, content: 'Plain', idempotencyKey: 'legacy-baseline' });
  await durable.executeTurn({ userId: f.identity.userId, ...b, signal: new AbortController().signal, emit: async () => {} });
  const legacy = f.memory.wireCalls.slice(legacyStart);
  const counts = { plainCommands: plain.length, plainWrites: plain.filter(c => c.kind === 'write').length,
    durableCommands: legacy.length, durableWrites: legacy.filter(c => c.kind === 'write').length };
  console.info('Offline complete command comparison', counts);
  expect(counts.plainCommands).toBeLessThan(counts.durableCommands);
  expect(counts.plainWrites).toBeLessThan(counts.durableWrites);
  await durable.drain(30);
});

it('reconciles an uncertain ownership release on save-only retry without repeating the model', async () => {
  const f = await fixture({ maxAttempts: 2, retryBackoffMs: 1 });
  const release = vi.spyOn(f.p.owner, 'release').mockRejectedValueOnce(new Error('release acknowledgement lost'));
  const a = await f.submit(); await f.execute(a); await f.settle(a.sessionId, a.turnId);
  expect(release.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.memory.rows('messages').size).toBe(2);
  expect((await f.p.sessions.get(f.identity.userId, a.sessionId))?.execution.ownerId).toBeNull();
  await f.dispose();
});

it('prevents application persistence close while an app-owned raw save remains unresolved', async () => {
  const f = await fixture(), paused = f.memory.pauseNextUpdate();
  const a = await f.submit(); await f.execute(a); await paused.started;
  const closePersistence = vi.fn(async () => {});
  const operations = new OperationsService({ config: f.runtime.d.config, currentConfig: f.currentConfig,
    runtime: () => f.runtime, assetsReady: () => true, modelLimitsReady: () => true,
    ping: async () => true, assertExecutor: async () => {}, closePersistence,
    transportSnapshot: () => ({ active: 0, backpressured: 0 }), writeLog: () => {} });
  expect(await operations.shutdown()).toEqual({ safe: false });
  expect(closePersistence).not.toHaveBeenCalled();
  paused.resume(); await f.settle(a.sessionId, a.turnId);
  expect(await f.runtime.drain(30)).toMatchObject({ drained: true });
});

it('counts retained and hydrated retry identities once and links a third attempt to the latest durable attempt', async () => {
  const f = await fixture();
  const a = await f.submit('First'); await f.runtime.cancelTurn({ identity: f.identity, ...a }); await f.settle(a.sessionId, a.turnId);
  f.runtime.memoryFor(f.identity.userId)!.handoff(a.sessionId);
  const legacy = new DurableChatRuntime({ ...f.runtime.d, memoryFirst: undefined });
  const b = await legacy.retryTurn({ identity: f.identity, sessionId: a.sessionId, turnId: a.turnId, idempotencyKey: 'legacy-retry-second' });
  await legacy.cancelTurn({ identity: f.identity, ...b });
  const c = await f.runtime.retryTurn({ identity: f.identity, sessionId: a.sessionId, turnId: a.turnId, idempotencyKey: 'memory-retry-third' });
  expect(c.userMessageId).toBe(a.userMessageId);
  await f.execute(c); await f.settle(c.sessionId, c.turnId);
  expect(f.envelope(c.sessionId, c.turnId).request.retryOf?.previousAttemptId).toBe(b.attemptId);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  await f.dispose();
});

it('composes exactly one default memory writer in AppService and closes its native bundle once after drain', async () => {
  const native = await fixture(); await native.runtime.drain(30);
  const seed = document(1); seed.settings.openRouter.modelId = 'fixture/model';
  const config = assemblyFixture(seed);
  await config.repository.compareAndSwap(1, { ...seed, revision: 2, credentials: {
    openrouter: { envelope: config.credentials.seal('openrouter', secret), validatedAt: at }, deepgram: null,
  } });
  const close = vi.fn(async () => {}), runtime = vi.fn((d: import('../../src/chat-runtime/ports.js').RuntimeDependencies) => new DurableChatRuntime(d));
  config.ports.open = vi.fn(async () => ({ ...native.p, close })) as never;
  config.ports.runtime = runtime;
  config.ports.fetcher = native.fetcher;
  const service = await AppService.create(config.bootstrap, config.ports);
  const a = await service.operations.runtime.submitTurn({ identity: native.identity, sessionId: null,
    content: 'Default plain path', idempotencyKey: 'app-composition-text' });
  await service.operations.runtime.executeTurn({ userId: native.identity.userId, ...a,
    signal: new AbortController().signal, emit: async () => {} });
  await vi.waitFor(async () => expect(await service.operations.runtime.getTurnStatus(native.identity.userId, a.sessionId, a.turnId))
    .toMatchObject({ status: 'completed', save: { state: 'saved' } }));
  expect(runtime).toHaveBeenCalledOnce();
  expect(runtime.mock.results[0].value.memoryFor(native.identity.userId)!.foundation.snapshot().sessions).toBe(1);
  expect(native.fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(native.fetcher.mock.calls[0][1]?.body as string).tools).toBeUndefined();
  expect(await service.operations.shutdown()).toEqual({ safe: true });
  expect(await service.operations.shutdown()).toEqual({ safe: true });
  expect(close).toHaveBeenCalledOnce();
});

it('projects current Calendar authority, enforces monotonic CAS erasure on retry, and catches mid-save disconnects', async () => {
  const db = calendarMemory();
  const client = Object.assign(db.commandSource, { db: () => db.store.db, appendMetadata: () => undefined }) as unknown as MongoClient;
  const p = await createPersistenceBundle(client, 'offline-archive-authority', DEFAULT_BUDGETS, 'offline-archive-executor');
  const nowMs = Date.parse('2026-10-22T10:01:00.000Z');
  const assets = contextAssets;
  const adapter = new MemoryTextArchive(p, assets, () => nowMs);
  const userId = 'u-archive-auth';
  const fetchedAt = '2026-10-22T10:00:00.000Z';
  const expiresAt = '2026-10-22T10:05:00.000Z';
  const makeCalendarState = async (
    accepted: { sessionId: string; turnId: string; attemptId: string },
    callSuffix: string,
    connectionId = 'conn-archive-1',
    connectionRevision = 1,
  ) => {
    const source = sourceReferenceV2Schema.parse({
      ...sourceV2, sourceId: `archive-auth-source-${callSuffix}`, connectionId, connectionRevision,
      fetchedAt, expiresAt, toolCallIds: [`archive-call-${callSuffix}`], operationIds: [],
    });
    const ledger = new MemoryCalendarLedger({
      identity: {
        userId, sessionId: accepted.sessionId, turnId: accepted.turnId, attemptId: accepted.attemptId,
        openRouterUser: userId, createdAt: fetchedAt, deadlineAt: expiresAt,
      },
      clock: () => nowMs, limits: CALENDAR_LIMITS, modelId: 'fixture/model', pricing: fixturePricing,
      configRevision: 1, maxOutputTokens: 256, processingPolicyId: 'fixture',
      job: { check() {}, signal: new AbortController().signal, wait: promise => promise },
    });
    const dispatch = await ledger.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
    const stage = new MemoryCalendarStage(65536, CALENDAR_LIMITS.modelDispatches);
    const envelope = { plugin: 'google-calendar' as const, tool: 'calendar_list_calendars' as const, arguments: {} };
    stage.putDecision(resumableSkillDecisionSchema.parse({
      schemaVersion: 3, protocolVersion: 'plugin-skills.v1', kind: 'calendar-model-decision',
      userId, sessionId: accepted.sessionId, turnId: accepted.turnId, attemptId: accepted.attemptId,
      decisionId: dispatch.decisionId, dispatchId: dispatch.dispatchId, configRevision: 1,
      connectionId, connectionRevision, schemaRevision: 'google-calendar.v2',
      rejectedDecisionId: null, sources: [source],
      decision: {
        kind: 'call_tool', decisionId: dispatch.decisionId, envelope, assistantContent: null,
        nativeCall: { id: `archive-call-${callSuffix}`, type: 'function',
          function: { name: 'call_tool', arguments: JSON.stringify(envelope) } },
        terminal: 'tool_calls',
      },
      operationId: null, intentId: null, proposalId: null, createdAt: fetchedAt,
    }));
    stage.putResult(calendarToolResultRecordV2Schema.parse({
      schemaVersion: 2, kind: 'calendar-tool-result', userId, sessionId: accepted.sessionId,
      turnId: accepted.turnId, attemptId: accepted.attemptId,
      decisionId: dispatch.decisionId, eventId: `ev-${callSuffix}`, sequence: 0,
      toolCallId: `archive-call-${callSuffix}`, createdAt: fetchedAt,
      resultRef: { storage: 'retained', source, toolCallId: `archive-call-${callSuffix}`, operationId: null,
        result: { ...calendarPage, fetchedAt, expiresAt } },
    }));
    await ledger.finishDispatch(dispatch.dispatchId, null);
    await ledger.aggregate();
    return { source, state: memoryCalendarStateSchema.parse({ ...ledger.freeze(), ...stage.records() }) };
  };

  // 1) No active connection -> initial save persists erased native state + redacted provenance.
  const m1 = new MemoryFirstFoundation({ userId, epoch: 'epoch-auth-1', policy: { ...PROPOSED_MEMORY_TEXT_POLICY, maxAttempts: 1 },
    save: async () => ({ kind: 'unknown', retryable: true }) });
  const a1 = m1.accept({ sessionId: 's-1', requestKey: 'archive-req-1', mode: 'text', content: 'Check events',
    voice: null, calendarReplyTo: null, config: { revision: '1', modelId: 'fixture/model',
      instructionVersion: assets.instructionVersion, knowledgeContentHash: assets.knowledgeContentHash,
      graphSchemaVersion: assets.graphSchemaVersion } });
  const s1Data = await makeCalendarState(a1, '1');
  const e1 = m1.complete(a1, { content: 'Answer 1', status: 'completed', calendar: s1Data.state,
    sourceProvenance: [s1Data.source] });
  expect((await adapter.save(e1, { maxOperations: 32, maxBytes: 524288 })).kind).toBe('saved');
  const native1 = await p.owner.store!.read('metadata', memoryCalendarRecordSchema, {
    _id: key('memory-calendar-native', userId, 's-1', a1.attemptId), userId, sessionId: 's-1',
  });
  expect(native1?.schemaVersion === 2 && native1.redactedAt !== null && isFullyErasedMemoryCalendarState(native1.state)).toBe(true);
  const msg1 = await p.messages.get(userId, 's-1', e1.output.messageId);
  expect(msg1?.sourceProvenance?.[0]?.redactedAt).not.toBeNull();
  m1.stopAdmission(); await m1.drain(20);

  // 2) Active connection -> concurrent retention erases persisted docs -> unredacted retry stays erased & succeeds.
  const conn = connectionV2();
  await p.calendarConnectionsV2.create({ ...conn, userId });
  const m2 = new MemoryFirstFoundation({ userId, epoch: 'epoch-auth-2', policy: { ...PROPOSED_MEMORY_TEXT_POLICY, maxAttempts: 1 },
    save: async () => ({ kind: 'unknown', retryable: true }) });
  const a2 = m2.accept({ sessionId: 's-2', requestKey: 'archive-req-2', mode: 'text', content: 'Check events 2',
    voice: null, calendarReplyTo: null, config: { revision: '1', modelId: 'fixture/model',
      instructionVersion: assets.instructionVersion, knowledgeContentHash: assets.knowledgeContentHash,
      graphSchemaVersion: assets.graphSchemaVersion } });
  const s2Data = await makeCalendarState(a2, '2', conn.connectionId, conn.connectionRevision);
  const e2 = m2.complete(a2, { content: 'Answer 2', status: 'completed', calendar: s2Data.state,
    sourceProvenance: [s2Data.source] });
  vi.spyOn(p.memory, 'put').mockRejectedValueOnce(new Error('partial fail before publication'));
  expect((await adapter.save(e2, { maxOperations: 32, maxBytes: 524288 })).kind).toBe('unknown');

  const retention = new MongoCalendarRetention(p.owner.store!, DEFAULT_BUDGETS, () => nowMs);
  await p.calendarConnectionsV2.compareAndSwap({
    userId, expectedRevision: conn.revision, expectedConnectionRevision: conn.connectionRevision,
    expectedDefaultSettingRevision: conn.defaultSetting.defaultSettingRevision,
    next: { ...conn, userId, revision: conn.revision + 1,
      connectionRevision: conn.connectionRevision + 1, credentialVersion: conn.credentialVersion + 1,
      enabled: false, status: 'disconnected', credentials: null, tokenExpiresAt: null, discovery: null },
  });
  let cursor: string | null = null;
  do {
    cursor = (await retention.invalidateAccountRevisionPage({
      account: { userId, connectionId: s2Data.source.connectionId, connectionRevision: s2Data.source.connectionRevision, googleSubjectId: conn.googleSubjectId },
      now: new Date(nowMs).toISOString(), cursor, limit: 20,
    })).nextCursor;
  } while (cursor !== null);

  // Even a retry carrying unredacted in-memory envelope cannot un-erase the DB record; tampered integrity fails.
  expect((await adapter.save(e2, { maxOperations: 32, maxBytes: 524288 })).kind).toBe('saved');
  const native2 = await p.owner.store!.read('metadata', memoryCalendarRecordSchema, {
    _id: key('memory-calendar-native', userId, 's-2', a2.attemptId), userId, sessionId: 's-2',
  });
  expect(native2?.schemaVersion === 2 && isFullyErasedMemoryCalendarState(native2.state)
    && verifyMemoryCalendarRecordIntegrity(native2, memoryCalendarPublicationHash(native2))).toBe(true);
  expect((await p.messages.get(userId, 's-2', e2.output.messageId))?.sourceProvenance?.[0]?.redactedAt).not.toBeNull();
  const forged = { ...e2, calendarIntegrity: { stateHash: 'f'.repeat(64), erasedHash: 'e'.repeat(64) } };
  expect((await adapter.save(forged, { maxOperations: 32, maxBytes: 524288 })).kind).toBe('failed');
  m2.stopAdmission(); await m2.drain(20);

  // 3) Disconnect mid-save right before final session update -> post-write authority recheck CAS-erases.
  await p.calendarConnectionsV2.compareAndSwap({
    userId, expectedRevision: conn.revision + 1, expectedConnectionRevision: conn.connectionRevision + 1,
    expectedDefaultSettingRevision: conn.defaultSetting.defaultSettingRevision,
    next: { ...conn, userId, revision: conn.revision + 2,
      connectionRevision: 3, credentialVersion: conn.credentialVersion + 2, enabled: true, status: 'connected', discovery: null },
  });
  const m3 = new MemoryFirstFoundation({ userId, epoch: 'epoch-auth-3', policy: { ...PROPOSED_MEMORY_TEXT_POLICY, maxAttempts: 1 },
    save: async () => ({ kind: 'unknown', retryable: true }) });
  const a3 = m3.accept({ sessionId: 's-3', requestKey: 'archive-req-3', mode: 'text', content: 'Mid-save disconnect',
    voice: null, calendarReplyTo: null, config: { revision: '1', modelId: 'fixture/model',
      instructionVersion: assets.instructionVersion, knowledgeContentHash: assets.knowledgeContentHash,
      graphSchemaVersion: assets.graphSchemaVersion } });
  const s3Data = await makeCalendarState(a3, '3', conn.connectionId, 3);
  const e3 = m3.complete(a3, { content: 'Answer 3', status: 'completed', calendar: s3Data.state, sourceProvenance: [s3Data.source] });
  const origPut = p.memory.put.bind(p.memory);
  vi.spyOn(p.memory, 'put').mockImplementationOnce(async manifest => {
    await origPut(manifest);
    await p.calendarConnectionsV2.compareAndSwap({
      userId, expectedRevision: conn.revision + 2, expectedConnectionRevision: 3,
      expectedDefaultSettingRevision: conn.defaultSetting.defaultSettingRevision,
      next: { ...conn, userId, revision: conn.revision + 3,
        connectionRevision: 4, credentialVersion: conn.credentialVersion + 3,
        enabled: false, status: 'disconnected', credentials: null, tokenExpiresAt: null, discovery: null },
    });
  });
  expect((await adapter.save(e3, { maxOperations: 32, maxBytes: 524288 })).kind).toBe('saved');
  const native3 = await p.owner.store!.read('metadata', memoryCalendarRecordSchema, {
    _id: key('memory-calendar-native', userId, 's-3', a3.attemptId), userId, sessionId: 's-3',
  });
  expect(native3?.schemaVersion === 2 && isFullyErasedMemoryCalendarState(native3.state)).toBe(true);
  expect((await p.messages.get(userId, 's-3', e3.output.messageId))?.sourceProvenance?.[0]?.redactedAt).not.toBeNull();
  m3.stopAdmission(); await m3.drain(20);
});

it('tracks ownsSession and yields retryable unknown without clearing an active mutation handle', async () => {
  const db = calendarMemory();
  const client = Object.assign(db.commandSource, { db: () => db.store.db, appendMetadata: () => undefined }) as unknown as MongoClient;
  const p = await createPersistenceBundle(client, 'offline-archive-race', DEFAULT_BUDGETS, 'offline-archive-executor');
  const adapter = new MemoryTextArchive(p, contextAssets, () => Date.parse('2026-11-03T10:00:00.000Z'));
  const userId = 'u-archive-race';
  const sessionId = 's-race';
  const foundation = new MemoryFirstFoundation({ userId, epoch: 'epoch-race', policy: { ...PROPOSED_MEMORY_TEXT_POLICY, maxAttempts: 1 },
    save: async () => ({ kind: 'unknown', retryable: true }) });
  const a1 = foundation.accept({ sessionId, requestKey: 'race-req-1', mode: 'text', content: 'Hello before mutation',
    voice: null, calendarReplyTo: null, config: { revision: '1', modelId: 'fixture/model',
      instructionVersion: contextAssets.instructionVersion, knowledgeContentHash: contextAssets.knowledgeContentHash,
      graphSchemaVersion: contextAssets.graphSchemaVersion } });
  const e1 = foundation.complete(a1, { content: 'Answer 1', status: 'completed' });

  // 1) Active mutation at entry returns retryable unknown without overwriting activeAttemptId.
  await p.sessions.createIfAbsent({
    schemaVersion: 1, userId, sessionId: 's-entry', title: 'Entry',
    createdAt: '2026-11-03T09:00:00.000Z', updatedAt: '2026-11-03T09:00:00.000Z',
    lastActivityAt: '2026-11-03T09:00:00.000Z', lifecycle: 'active',
    graphThreadId: graphThreadId(userId, 's-entry'), latestTurnId: null,
    execution: { ownerId: null, leaseExpiresAt: null, activeAttemptId: 'existing-mut', generation: 1 },
    memoryPublication: { version: 0, sequence: 0, epoch: 'epoch-race', fence: 0 },
  });
  const aEntry = foundation.accept({ sessionId: 's-entry', requestKey: 'race-entry-1', mode: 'text', content: 'Entry',
    voice: null, calendarReplyTo: null, config: { revision: '1', modelId: 'fixture/model',
      instructionVersion: contextAssets.instructionVersion, knowledgeContentHash: contextAssets.knowledgeContentHash,
      graphSchemaVersion: contextAssets.graphSchemaVersion } });
  const eEntry = foundation.complete(aEntry, { content: 'Entry out', status: 'completed' });
  expect(adapter.ownsSession(userId, 's-entry')).toBe(false);
  expect(await adapter.save(eEntry, { maxOperations: 32, maxBytes: 524288 })).toEqual({ kind: 'unknown', retryable: true });
  expect(adapter.ownsSession(userId, 's-entry')).toBe(false);
  expect((await p.sessions.get(userId, 's-entry'))?.execution.activeAttemptId).toBe('existing-mut');

  // 2) Held raw projection write after acquisition allows concurrent mutation claim; final CAS yields retryable unknown.
  let releasePut!: () => void, reachedPut!: () => void;
  const heldPut = new Promise<void>(r => { releasePut = r; });
  const enteredPut = new Promise<void>(r => { reachedPut = r; });
  const origPut = p.memory.put.bind(p.memory);
  const putSpy = vi.spyOn(p.memory, 'put').mockImplementationOnce(async manifest => {
    reachedPut();
    await heldPut;
    return origPut(manifest);
  });

  const saving = adapter.save(e1, { maxOperations: 32, maxBytes: 524288 });
  await enteredPut;
  expect(adapter.ownsSession(userId, sessionId)).toBe(true);
  expect(adapter.ownsSession(userId, 'other-session')).toBe(false);

  const handle = await p.sessions.beginCalendarMutation({
    userId, sessionId, attemptId: 'mut-during-archive',
    executorId: p.owner.executorId, archiveOwned: adapter.ownsSession(userId, sessionId),
  });
  expect(handle.attemptId).toBe('mut-during-archive');

  releasePut();
  expect(await saving).toEqual({ kind: 'unknown', retryable: true });
  expect(putSpy).toHaveBeenCalledTimes(1);
  // Archive released its own lease while the mutation claim stays active and ownsSession is now false.
  expect(adapter.ownsSession(userId, sessionId)).toBe(false);
  expect(await p.sessions.get(userId, sessionId)).toMatchObject({
    execution: { ownerId: null, activeAttemptId: 'mut-during-archive', generation: 1 },
    memoryPublication: { version: 0 },
  });
  expect(await p.sessions.assertCalendarMutation(handle, p.owner.executorId)).toBe(true);

  // 3) Finishing mutation permits retry of the archive save to publish cleanly.
  await p.sessions.finishCalendarMutation(handle, p.owner.executorId);
  expect(await adapter.save(e1, { maxOperations: 32, maxBytes: 524288 })).toMatchObject({
    kind: 'saved', version: 1, sessionId,
  });
  expect(adapter.ownsSession(userId, sessionId)).toBe(false);

  // 4) Failed release retains ownsSession until next save reconciles the uncertain release.
  const a2 = foundation.accept({ sessionId, requestKey: 'race-req-2', mode: 'text', content: 'Release fail test',
    voice: null, calendarReplyTo: null, config: { revision: '1', modelId: 'fixture/model',
      instructionVersion: contextAssets.instructionVersion, knowledgeContentHash: contextAssets.knowledgeContentHash,
      graphSchemaVersion: contextAssets.graphSchemaVersion } });
  const e2 = foundation.complete(a2, { content: 'Answer 2', status: 'completed' });
  vi.spyOn(p.owner, 'release').mockRejectedValueOnce(new Error('release ack lost'));
  expect(await adapter.save(e2, { maxOperations: 32, maxBytes: 524288 })).toEqual({ kind: 'unknown', retryable: true });
  expect(adapter.ownsSession(userId, sessionId)).toBe(true);
  expect(await adapter.save(e2, { maxOperations: 32, maxBytes: 524288 })).toMatchObject({ kind: 'saved', version: 2 });
  expect(adapter.ownsSession(userId, sessionId)).toBe(false);
  foundation.stopAdmission(); await foundation.drain(20);
});

it('archives calendarMutation, enforces byte/op bounds, and downgrades retained create results when expired', async () => {
  let now = Date.parse('2026-10-01T12:00:00.000Z');
  const f = await fixture();
  const { p, memory } = f;
  const userId = f.identity.userId;
  const sessionId = 's-mut-archive';
  const conn = connectionV2('conn-mut-1', 1);
  await memory.store.db.collection('integration_connections').insertOne(
    document(key('calendar-connection', userId, 'google-calendar'), { ...conn, userId }));
  const adapter = new MemoryTextArchive(p, contextAssets, () => now);
  const foundation = new MemoryFirstFoundation({
    userId, epoch: 'epoch-mut-1',
    policy: { ...PROPOSED_MEMORY_TEXT_POLICY, maxAttempts: 1 },
    now: () => now, save: async () => ({ kind: 'unknown', retryable: true }),
  });
  const a1 = foundation.accept({
    sessionId, requestKey: 'mut-req-1', mode: 'text', content: 'Schedule Sprint Review',
    voice: null, calendarReplyTo: null, config: {
      revision: '1', modelId: 'fixture/model',
      instructionVersion: contextAssets.instructionVersion,
      knowledgeContentHash: contextAssets.knowledgeContentHash,
      graphSchemaVersion: contextAssets.graphSchemaVersion,
    },
  });
  const opId = key('op-mut', sessionId, a1.turnId);
  const src = sourceReferenceV2Schema.parse({
    ...sourceV2, sourceId: 'src-create-1',
    connectionId: conn.connectionId, connectionRevision: conn.connectionRevision, operationIds: [opId],
    toolCallIds: ['tc-create-1'], fetchedAt: '2026-10-01T12:00:00.000Z',
    expiresAt: '2026-10-01T12:05:00.000Z', redactedAt: null,
  });
  const targetCal = src.targets[0]!;
  const result = calendarToolResultRecordV2Schema.parse({
    schemaVersion: 2, kind: 'calendar-tool-result', userId, sessionId, turnId: a1.turnId,
    attemptId: a1.attemptId, decisionId: 'dec-create-1', eventId: 'evt-create-1',
    sequence: 0, toolCallId: 'tc-create-1', createdAt: '2026-10-01T12:00:00.000Z',
    resultRef: {
      storage: 'retained', source: src, toolCallId: 'tc-create-1', operationId: opId,
      result: {
        schemaVersion: 2, tool: 'calendar_create_event',
        target: {
          calendarId: targetCal.calendarId,
          calendarLabel: targetCal.calendarLabel!,
          discoveryRevision: src.discoveryRevision,
          privateAccess: false,
        },
        event: {
          eventId: 'gevt-1', summary: 'Sprint Review',
          start: '2026-10-01T14:00:00.000Z', end: '2026-10-01T15:00:00.000Z',
          timeZone: 'Etc/UTC', status: 'confirmed',
          htmlLink: 'https://calendar.google.com/event?eid=1',
        },
      },
    },
  });
  const ledger = new MemoryCalendarLedger({
    identity: {
      userId, sessionId, turnId: a1.turnId, attemptId: a1.attemptId, openRouterUser: userId,
      createdAt: '2026-10-01T12:00:00.000Z', deadlineAt: '2026-10-01T12:10:00.000Z',
    },
    limits: CALENDAR_LIMITS, clock: () => now, modelId: 'fixture/model',
    pricing: fixturePricing, configRevision: 1, maxOutputTokens: 256, processingPolicyId: 'policy-v2',
    job: { check() {}, signal: new AbortController().signal, wait: promise => promise },
  });
  const dispatch = await ledger.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  await ledger.finishDispatch(dispatch.dispatchId, null);
  const aggregate = await ledger.aggregate();
  const prefixCalendar = memoryCalendarStateSchema.parse({
    storage: 'volatile', ...ledger.freeze(), aggregate: null,
    decisions: [], rejected: [], results: [],
  });
  const envelope = foundation.complete(a1, {
    content: 'Created Sprint Review.', status: 'completed',
    calendar: prefixCalendar,
    calendarMutation: { operationId: opId, decision: null, result, aggregate },
  });

  // Byte bound rejection returns non-retryable failed without writing aggregate/result.
  expect(await adapter.save(envelope, { maxOperations: 32, maxBytes: 128 })).toEqual({ kind: 'failed', retryable: false });

  // Advance clock past source expiry before saving: downgrades retained result to tombstone cleanly without calling registerSource.
  now = Date.parse('2026-10-01T12:06:00.000Z');
  const regSpy = vi.spyOn(p.calendarRetention, 'registerSource');
  expect(await adapter.save(envelope, { maxOperations: 32, maxBytes: 524288 })).toMatchObject({ kind: 'saved', version: 1 });
  expect(regSpy).not.toHaveBeenCalled();

  const archivedAgg = await p.owner.store!.read('metadata', modelAggregateSchema, {
    _id: aggregateKey(userId, sessionId, a1.turnId, a1.attemptId), userId, sessionId,
  });
  expect(archivedAgg).toEqual(aggregate);
  const archivedRes = await p.calendarResultsV2.get(userId, sessionId, 'tc-create-1');
  expect(archivedRes?.schemaVersion).toBe(2);
  if (archivedRes?.schemaVersion === 2) {
    expect(archivedRes.resultRef.storage).toBe('tombstone');
    expect(archivedRes.resultRef.source.redactedAt).not.toBeNull();
  }
  regSpy.mockRestore();
  foundation.stopAdmission(); await foundation.drain(20);
});
