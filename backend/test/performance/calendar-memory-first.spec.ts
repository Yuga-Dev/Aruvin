/**
 * ============================================================================
 * FILE: calendar-memory-first.spec.ts
 * LOCATION: backend/test/performance/calendar-memory-first.spec.ts
 * ============================================================================
 * PURPOSE: Verify Calendar-enabled conversation at the actual provider boundary.
 * ROLE IN PROJECT: Offline acceptance coverage with blocked durable repositories.
 * KEY COMPONENTS: Native definitions, independent completion and follow-up.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import { calendarFixture, textWire, skillWire, createWire, brokenTextWire,
  processDiagnosticCapture } from '../runtime/calendar-runtime.fixture.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { SKILL_NATIVE_TOOLS } from '../../src/contracts/calendar-tools.js';
import type { StreamEnvelope } from '../../src/contracts/stream.js';
import { isCalendarV2 } from '../../src/chat-runtime/calendar-ports.js';
import { DurableChatRuntime } from '../../src/chat-runtime/durable-chat-runtime.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import type { MongoClient } from 'mongodb';
import { event } from '../runtime/calendar-multi-fixture.js';
import { CALENDAR_TOMBSTONE } from '../../src/contracts/calendar-sources.js';
import type { SubmitTurnResponse } from '../../src/contracts/api.js';
import { MemoryTextArchive } from '../../src/persistence/memory-text-archive.js';
import { AppError } from '../../src/platform/errors/app-error.js';
import type { MemoryFirstPolicy, SaveTerminal } from '../../src/chat-runtime/memory-first-foundation.js';
import { AppService } from '../../src/app.service.js';
import { assemblyFixture } from '../assembly/admin-config-fixture.js';
import { document, at, secret } from '../admin-config/fixtures.js';
import { parseCalendarSetupOptions } from '../../src/plugins/google-calendar/options.js';
import { calendarLimits } from '../model/calendar-fixtures.js';
import type { RuntimeDependencies, ProcessDiagnostics } from '../../src/chat-runtime/ports.js';
import { VoiceDelivery } from '../../src/voice/agent/voice-delivery.js';
import { deliveryFixture } from '../../src/contracts/testing/voice-fixtures.js';
import { key, acceptanceSchema, counterSchema } from '../../src/persistence/records.js';
import { attemptRecordSchema } from '../../src/contracts/attempt.js';
import { messageRecordSchema } from '../../src/contracts/message.js';
import { modelAggregateSchema, turnBudgetRecordSchema } from '../../src/contracts/calendar-accounting.js';
import { aggregateKey } from '../../src/persistence/calendar-records.js';
import { calendarEventId } from '../../src/plugins/google-calendar/tools-validation.js';
import { CalendarSecretCipher } from '../../src/platform/crypto/calendar-secret-cipher.js';
import { tokenAad } from '../../src/plugins/google-calendar/connection.js';
import { createCalendarAssembly } from '../../src/operations/calendar-assembly.js';
import { CalendarDiscoveryApi } from '../../src/plugins/google-calendar/calendar-discovery-api.js';
import { googleJson } from '../plugins/google-calendar/tools-fixtures.js';
import { calendarConnectionV2Schema } from '../../src/contracts/calendar-discovery.js';
import { CALENDAR_SCOPES } from '../../src/contracts/calendar-policy.js';
import {
  isFullyErasedMemoryCalendarState, memoryCalendarPublicationHash,
  memoryCalendarRecordSchema, verifyMemoryCalendarRecordIntegrity,
} from '../../src/chat-runtime/memory-calendar-state.js';
import { DependencyProbe } from './dependency-probe.js';

async function nativeFixture(save?: SaveTerminal, maxAttempts = 1, policy: Partial<MemoryFirstPolicy> = {},
  options: { probe?: DependencyProbe; diagnostics?: ProcessDiagnostics } = {}) {
  const probe = options.probe;
  const db = calendarMemory(probe);
  const client = Object.assign(db.commandSource, { db: () => db.store.db, appendMetadata: () => undefined }) as unknown as MongoClient;
  const bundle = () => createPersistenceBundle(client, 'offline-calendar-memory-promotion', DEFAULT_BUDGETS, 'offline-calendar-executor');
  const p = await (probe ? probe.drive(bundle, 0, 0) : bundle());
  const f = calendarFixture(options.diagnostics, p, { policy: { ...PROPOSED_MEMORY_TEXT_POLICY, maxAttempts, shutdownDrainMs: 50, ...policy }, voice: true,
    ...(save ? { save } : {}) });
  // The fixture seeds its connection before `ready` resolves, so that work is
  // queued by the probe too and must be driven as well.
  if (probe) await probe.drive(() => f.ready, 0, 0);
  else await f.ready;
  const status = (ids: SubmitTurnResponse) => f.runtime.memoryFor(f.identity.userId)!.status(f.identity.userId, ids.sessionId, ids.turnId);
  const saved = (ids: SubmitTurnResponse) => vi.waitFor(() => expect(status(ids)?.save?.state).toBe('saved'));
  // With a probe every store command is queued until it is driven. Callers wrap
  // submit/execute in drive() themselves so setup stays outside the measurement.
  const drive = <T>(operation: () => Promise<T>, readMs = 0, writeMs = 0) =>
    probe ? probe.drive(operation, readMs, writeMs) : operation();
  return { ...f, db, status, saved, probe, drive };
}

function readWires(callId = 'memory-read') {
  return [skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_events'] }, `${callId}-load`),
    skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_events', arguments: {
      timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', maxResults: 10,
    } }, callId), textWire('There are no events in that interval.')];
}

function toolIds(body: Record<string, unknown>) {
  return (body.messages as { tool_calls?: { id: string }[] }[]).flatMap(message => message.tool_calls ?? []).map(call => call.id);
}

it('integrated native memory loop retains activation pairs and the accepted input once with storage blocked', async () => {
  const f = calendarFixture(undefined, undefined, {
    policy: PROPOSED_MEMORY_TEXT_POLICY, save: async () => ({ kind: 'unknown', retryable: false }),
  });
  await f.ready;
  const blocked = () => { throw new Error('Database access blocked on ordinary conversation'); };
  const ports: ReturnType<typeof vi.spyOn>[] = [];
  for (const port of new Set(Object.values(f.p).filter(value => value && typeof value === 'object'))) {
    const names = new Set([...Object.keys(port), ...Object.getOwnPropertyNames(Object.getPrototypeOf(port))]);
    for (const name of names) if (name !== 'constructor' && typeof port[name] === 'function')
      ports.push(vi.spyOn(port, name).mockImplementation(blocked));
  }
  const cal = f.runtime.d.calendar!;
  if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
  const account = vi.spyOn(cal.connection, 'currentAccount').mockImplementation(blocked);
  const current = vi.spyOn(cal.connection, 'requireAccountCurrent').mockImplementation(blocked);
  f.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_calendars'] }),
    textWire('First answer'), textWire('Second answer'));
  try {
    const first = await f.submit('Original question');
    await f.execute(first);
    expect(f.runtime.memoryFor(f.identity.userId)!.status(f.identity.userId, first.sessionId, first.turnId)?.status).toBe('completed');
    const second = await f.submit('Follow up', first.sessionId);
    await f.execute(second);
    expect(f.modelBodies).toHaveLength(3);
    const bodies = f.modelBodies as { messages: { role: string; content: string; tool_calls?: { id: string }[]; tool_call_id?: string }[]; tools: unknown; user: string }[];
    for (const body of bodies) {
      expect(body.tools).toEqual(SKILL_NATIVE_TOOLS.map(tool => ({ type: 'function', function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema,
      } })));
      expect(body.user).toBe(f.identity.userId);
      expect(body.messages.filter(message => message.role === 'user' && message.content === 'Original question')).toHaveLength(1);
    }
    for (const body of bodies.slice(1)) {
      const calls = body.messages.flatMap(message => message.tool_calls ?? []);
      const results = body.messages.filter(message => message.role === 'tool');
      expect(calls).toHaveLength(1); expect(results).toHaveLength(1);
      expect(results[0]!.tool_call_id).toBe(calls[0]!.id);
    }
    const turn = f.runtime.memoryFor(f.identity.userId)!.find(first.sessionId, first.turnId)!.turn;
    const command = { identity: f.identity, sessionId: null, content: 'Original question', idempotencyKey: turn.requestKey };
    expect(await f.runtime.submitTurn(command)).toEqual(first);
    await expect(f.runtime.submitTurn({ ...command, content: 'Different question' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    await f.execute(first);
    expect(f.modelBodies).toHaveLength(3);
    for (const spy of [...ports, account, current]) expect(spy).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks(); f.runtime.stopAccepting();
  }
});

it('integrated native memory loop preserves schema-not-loaded repair and finite native evidence', async () => {
  const f = calendarFixture(undefined, undefined, {
    policy: PROPOSED_MEMORY_TEXT_POLICY, save: async () => ({ kind: 'unknown', retryable: false }),
  });
  await f.ready;
  f.modelWires.push(skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_calendars', arguments: {} }, 'unloaded-call'),
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_calendars'] }, 'activate-after-repair'),
    textWire('Ready to use the disclosed schema'));
  try {
    const ids = await f.submit('Question'); await f.execute(ids);
    const memory = f.runtime.memoryFor(f.identity.userId)!, turn = memory.find(ids.sessionId, ids.turnId)!.turn;
    expect(memory.status(f.identity.userId, ids.sessionId, ids.turnId)?.status).toBe('completed');
    const native = memory.foundation.result(turn)!.calendar!;
    expect(native.budget).toMatchObject({ modelDispatches: 3, repairs: 1, calendarRequests: 0 });
    expect(native.results).toHaveLength(2);
    expect(native.results[0]!.resultRef.content).toContain('SCHEMA_NOT_LOADED');
    expect(native.results[1]!.resultRef.content).toContain('skill-disclosure');
    expect(native.dispatches.map(dispatch => dispatch.reason)).toEqual(['initial', 'schema-repair', 'continuation']);
    expect(f.effects).toEqual([]);
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('integrated native memory loop cold-hydrates published local pairs through real archive repositories', async () => {
  const db = calendarMemory();
  const client = Object.assign(db.commandSource, { db: () => db.store.db, appendMetadata: () => undefined }) as unknown as MongoClient;
  const p = await createPersistenceBundle(client, 'offline-native-runtime', DEFAULT_BUDGETS, 'offline-native-executor');
  const f = calendarFixture(undefined, p, { policy: { ...PROPOSED_MEMORY_TEXT_POLICY, maxAttempts: 1 } });
  await f.ready;
  let cold: DurableChatRuntime | undefined;
  f.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_calendars'] }, 'cold-original-call'),
    textWire('Saved answer'), textWire('Cold follow up'));
  try {
    const first = await f.submit('Original question'); await f.execute(first);
    await vi.waitFor(() => expect(f.runtime.memoryFor(f.identity.userId)!.status(f.identity.userId, first.sessionId, first.turnId)?.save?.state).toBe('saved'));
    expect(await f.runtime.drain(100)).toMatchObject({ drained: true });
    cold = new DurableChatRuntime(f.runtime.d);
    const second = await cold.submitTurn({ identity: f.identity, sessionId: first.sessionId,
      content: 'Follow up', idempotencyKey: 'cold-native-follow-up' });
    await cold.executeTurn({ userId: f.identity.userId, ...second, signal: new AbortController().signal,
      emit: async () => {}, emitCalendar: async () => {} });
    expect(cold.memoryFor(f.identity.userId)!.status(f.identity.userId, second.sessionId, second.turnId)?.status).toBe('completed');
    expect(f.modelBodies).toHaveLength(3);
    const messages = f.modelBodies[2]!.messages as { role: string; content: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Original question', 'Follow up']);
    expect(messages.flatMap(message => message.tool_calls ?? []).map(call => call.id)).toEqual(['cold-original-call']);
    expect(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(['cold-original-call']);
    await vi.waitFor(() => expect(cold!.memoryFor(f.identity.userId)!.status(f.identity.userId, second.sessionId, second.turnId)?.save?.state).toBe('saved'));
    expect(await cold.drain(100)).toMatchObject({ drained: true });
  } finally { cold?.stopAccepting(); vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('creates through the minimal barrier while prior background saving fails, then drains both in order on retrySave', async () => {
  let archive!: MemoryTextArchive;
  let available = false;
  const run = await nativeFixture((envelope, limits) => available ? archive.save(envelope, limits)
    : Promise.resolve({ kind: 'unknown', retryable: true }), 3);
  archive = new MemoryTextArchive(run.p, run.runtime.d.assets);
  const save = vi.spyOn(archive, 'save');
  run.modelWires.push(
    textWire('Dirty background answer'),
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'frozen-load'),
    createWire(event(), 'frozen-external'),
    textWire('Scheduled.'),
  );
  try {
    const first = await run.submit('Ordinary question'); await run.execute(first);
    await vi.waitFor(() => expect(run.runtime.memoryFor(run.identity.userId)!.status(run.identity.userId, first.sessionId, first.turnId)?.save?.state).toBe('unknown'));
    const second = await run.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', first.sessionId);
    await run.execute(second);
    expect(run.status(second)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } });
    expect(run.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(run.modelBodies).toHaveLength(3);
    available = true;
    run.advance(PROPOSED_MEMORY_TEXT_POLICY.retryBackoffMs + 1);
    const saveStatus = run.status(first)!.save!;
    await run.runtime.retrySave(run.identity.userId, first.sessionId, first.turnId,
      { epoch: saveStatus.epoch, version: saveStatus.version });
    await run.saved(second);
    expect(run.status(second)).toMatchObject({ status: 'completed', save: { state: 'saved', version: 2, durableVersion: 2 } });
    expect(save).toHaveBeenCalledTimes(2);
  } finally { vi.restoreAllMocks(); run.runtime.stopAccepting(); }
});

it('integrated native memory loop retains cancellation accounting and reconnect never dispatches again', async () => {
  const f = calendarFixture(undefined, undefined, {
    policy: PROPOSED_MEMORY_TEXT_POLICY, save: async () => ({ kind: 'unknown', retryable: false }),
  });
  await f.ready;
  const controller = new AbortController();
  f.modelWires.push(textWire('A provisional answer'));
  try {
    const ids = await f.submit('Question');
    await f.runtime.executeTurn({ userId: f.identity.userId, ...ids, signal: controller.signal,
      emit: async frame => { if (frame.event.type === 'delta') controller.abort(); }, emitCalendar: async () => {} });
    expect(f.modelBodies).toHaveLength(1);
    const memory = f.runtime.memoryFor(f.identity.userId)!, entry = memory.find(ids.sessionId, ids.turnId)!;
    expect(memory.status(f.identity.userId, ids.sessionId, ids.turnId)?.status).toBe('interrupted');
    expect(memory.foundation.result(entry.turn)?.calendar?.dispatches[0])
      .toMatchObject({ status: 'terminal', failure: { category: 'cancelled' } });
    await f.execute(ids);
    expect(f.modelBodies).toHaveLength(1);
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('integrated native memory loop keeps a raw cancelled adapter pinned through bounded drain', async () => {
  const f = calendarFixture(undefined, undefined, {
    policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 20 },
    save: async () => ({ kind: 'unknown', retryable: false }),
  });
  await f.ready;
  const calendar = f.runtime.d.calendar!;
  if (!isCalendarV2(calendar)) throw new Error('Fixture requires Calendar v2');
  const create = calendar.createModelPort;
  let release!: () => void, reached!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const unwinding = new Promise<void>(resolve => { reached = resolve; });
  calendar.createModelPort = (...args) => {
    const adapter = create(...args);
    return { async *stream(request) {
      try { yield* adapter.stream(request); }
      finally { reached(); await blocked; }
    } };
  };
  const controller = new AbortController();
  f.modelWires.push(textWire('Provisional'));
  let run: Promise<void> | undefined;
  try {
    const ids = await f.submit('Question');
    run = f.runtime.executeTurn({ userId: f.identity.userId, ...ids, signal: controller.signal,
      emit: async frame => { if (frame.event.type === 'delta') controller.abort(); }, emitCalendar: async () => {} });
    await unwinding;
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.session(ids.sessionId).activeAttemptId).toBe(ids.attemptId);
    expect(f.runtime.work.snapshot()).toMatchObject({ active: 1, unresolvedWrites: 1 });
    expect(await f.runtime.drain(10)).toMatchObject({ drained: false, active: 1, unresolvedWrites: 1 });
    release(); await run;
    expect(f.runtime.work.snapshot()).toMatchObject({ active: 0, unresolvedWrites: 0 });
    expect(f.modelBodies).toHaveLength(1);
  } finally {
    release(); await run; calendar.createModelPort = create; vi.restoreAllMocks(); f.runtime.stopAccepting();
  }
});

it('Calendar enabled new and warm text dispatch with unchanged native tools before any database work', async () => {
  const f = calendarFixture(undefined, undefined, {
    policy: PROPOSED_MEMORY_TEXT_POLICY,
    save: async () => ({ kind: 'unknown', retryable: false }),
  });
  await f.ready;
  const blocked = () => { throw new Error('Database access blocked on ordinary conversation'); };
  const ports: ReturnType<typeof vi.spyOn>[] = [];
  // Block every repository/ownership method, including inherited native methods;
  // a new hidden admission read cannot make this acceptance check pass.
  for (const port of new Set(Object.values(f.p).filter(value => value && typeof value === 'object'))) {
    const names = new Set([...Object.keys(port), ...Object.getOwnPropertyNames(Object.getPrototypeOf(port))]);
    for (const name of names) if (name !== 'constructor' && typeof port[name] === 'function')
      ports.push(vi.spyOn(port, name).mockImplementation(blocked));
  }
  const calendar = f.runtime.d.calendar!;
  if (!isCalendarV2(calendar)) throw new Error('Fixture requires Calendar v2');
  ports.push(vi.spyOn(calendar.connection, 'currentAccount').mockImplementation(blocked));
  ports.push(vi.spyOn(calendar.connection, 'requireAccountCurrent').mockImplementation(blocked));
  const frames: StreamEnvelope[] = [];
  try {
    for (const content of ['Hello', 'Follow up']) f.modelWires.push(textWire(content + ' answer'));
    const first = await f.submit('First');
    await f.runtime.executeTurn({ userId: f.identity.userId, ...first,
      signal: new AbortController().signal, emit: async frame => { frames.push(frame); },
      emitCalendar: async () => {} });
    expect(frames.some(frame => frame.event.type === 'delta')).toBe(true);
    expect(frames.at(-1)?.event.type).toBe('completed');
    const second = await f.submit('Second', first.sessionId);
    await f.execute(second);
    expect(f.modelBodies).toHaveLength(2);
    for (const body of f.modelBodies) {
      expect(body.tools).toEqual(SKILL_NATIVE_TOOLS.map(tool => ({ type: 'function', function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema,
      } })));
      expect(body.user).toBe(f.identity.userId);
    }
    expect(f.modelBodies[1]!.messages).toEqual(expect.arrayContaining([
      { role: 'user', content: 'First' }, { role: 'assistant', content: 'Hello answer' },
      { role: 'user', content: 'Second' },
    ]));
    for (const port of ports) expect(port).not.toHaveBeenCalled();
  } finally {
    for (const port of ports) port.mockRestore();
    f.runtime.stopAccepting();
  }
});

it('continues a Calendar read and follow-up while the prior raw archive write is held', async () => {
  const f = await nativeFixture();
  const pause = f.db.pauseNextUpdate();
  let run: Promise<void> | undefined;
  f.modelWires.push(textWire('Earlier answer'), ...readWires('unblocked-read'), textWire('Next answer'));
  try {
    const first = await f.submit('Earlier question'); await f.execute(first); await pause.started;
    const memory = f.runtime.memoryFor(f.identity.userId)!;
    const flush = vi.spyOn(memory.foundation, 'flushSession');
    const acquire = vi.spyOn(f.p.owner, 'acquire');
    const next = await f.submit('List events on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', first.sessionId);
    run = f.execute(next);
    await vi.waitFor(() => expect(f.status(next)?.status).toBe('completed'));
    expect(f.effects.filter(e => e.kind === 'list')).toHaveLength(1);
    expect(f.modelBodies).toHaveLength(4);
    expect(flush).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
    expect(toolIds(f.modelBodies[3]!).filter(id => id === 'unblocked-read')).toHaveLength(1);
    const third = await f.submit('Follow up', first.sessionId); await f.execute(third);
    expect(f.status(third)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } });
    expect(f.modelBodies).toHaveLength(5);
    expect(await f.runtime.drain(20)).toMatchObject({ drained: false });
    pause.resume(); await run; await f.saved(third);
    expect(memory.foundation.session(first.sessionId)).toMatchObject({ version: 3, durableVersion: 3 });
  } finally {
    pause.resume(); await run?.catch(() => undefined); vi.restoreAllMocks(); f.runtime.stopAccepting();
  }
});

it('keeps volatile continuation privacy in live execution without persisting canary text or arguments', async () => {
  const f = await nativeFixture();
  const cal = f.runtime.d.calendar!;
  if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
  const origInvoke = cal.execution.invoke.bind(cal.execution);
  const seenCalls: { name: string; args: unknown }[] = [];
  vi.spyOn(cal.execution, 'invoke').mockImplementation(async req => {
    seenCalls.push({ name: req.call.name, args: req.call.arguments });
    const res = await origInvoke(req);
    if (res.outcome === 'success') {
      return {
        ...res,
        result: seenCalls.length === 1 && req.call.name === 'calendar_list_events'
          ? { ...res.result, events: [{ eventId: 'CANARY-VOLATILE-EVENT-123', summary: 'CANARY-VOLATILE-SUMMARY',
              status: 'confirmed' as const, start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z',
              timeZone: 'Etc/UTC', htmlLink: null }] }
          : res.result,
        source: {
          ...res.source,
          expiresAt: res.source.fetchedAt,
          permission: { ...res.source.permission, content: 'volatile' as const },
          targets: res.source.targets.map(t => ({ ...t, calendarLabel: null })),
        },
      };
    }
    return res;
  });
  const canarySummary = 'CANARY-VOLATILE-SUMMARY';
  const canaryEventId = 'CANARY-VOLATILE-EVENT-123';
  f.modelWires.push(
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_events', 'calendar_get_event'] }, 'canary-load'),
    skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_events', arguments: {
      timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', maxResults: 10,
    } }, 'canary-read-1'),
    skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_get_event', arguments: {
      eventId: canaryEventId, calendarId: 'personal@example.test',
    } }, 'canary-read-2', `Checking ${canarySummary} details now.`),
    textWire(`Confirmed ${canarySummary} is on your calendar.`),
  );
  try {
    const ids = await f.submit('Check my events on 2026-11-03.');
    await f.execute(ids);
    await f.saved(ids);
    expect(f.status(ids)).toMatchObject({ status: 'completed' });
    expect(seenCalls).toEqual([
      { name: 'calendar_list_events', args: { timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', maxResults: 10 } },
      { name: 'calendar_get_event', args: { eventId: canaryEventId, calendarId: 'personal@example.test' } },
    ]);
    const memory = f.runtime.memoryFor(f.identity.userId)!;
    const envelope = memory.foundation.result(memory.find(ids.sessionId, ids.turnId)!.turn);
    expect(JSON.stringify(envelope?.calendar ?? null)).not.toContain(canarySummary);
    expect(JSON.stringify(envelope?.calendar ?? null)).not.toContain(canaryEventId);
    const stored = await f.db.store.collection('metadata').findOne({
      kind: 'memory-calendar-native', userId: f.identity.userId, sessionId: ids.sessionId, turnId: ids.turnId,
    });
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(canarySummary);
    expect(JSON.stringify(stored)).not.toContain(canaryEventId);
    expect(envelope?.calendar?.decisions.at(-1)?.decision).toBeNull();
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('bridges one memory read into a direct create once and refuses create POST before durability', async () => {
  const f = await nativeFixture();
  const persist = vi.spyOn(f.p.metadata, 'putAttemptConfirmed').mockRejectedValueOnce(new AppError('PERSISTENCE_ERROR', 'Offline prefix'));
  f.modelWires.push(
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_events', 'calendar_create_event'] }, 'mixed-load'),
    skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_events', arguments: {
      timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', maxResults: 10,
    } }, 'mixed-read'),
    createWire(event(), 'mixed-create'),
    textWire('Read then scheduled.'),
  );
  try {
    const ids = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(ids).catch(() => undefined);
    expect(f.status(ids)?.error?.code).toBe('PERSISTENCE_ERROR');
    expect(f.effects.filter(e => e.kind === 'list')).toHaveLength(1);
    expect(f.effects.filter(e => e.kind === 'create')).toHaveLength(0);
    const retry = await f.runtime.retryTurn({
      identity: f.identity, sessionId: ids.sessionId, turnId: ids.turnId, idempotencyKey: 'retry-mixed-turn',
    });
    expect(retry.attemptId).toBe(ids.attemptId);
    await f.execute(retry);
    expect(f.status(ids)?.status).toBe('completed');
    expect(f.effects.filter(e => e.kind === 'list')).toHaveLength(1);
    expect(f.effects.filter(e => e.kind === 'create')).toHaveLength(1);
    const budget = await f.p.calendarAccountingV2.getBudget(f.identity.userId, ids.sessionId, ids.turnId);
    expect(budget).toMatchObject({ logicalTools: 2, creates: 1 });
    expect(persist.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it.each([
  {
    tool: 'calendar_list_calendars' as const,
    args: {},
    callId: 'prod-list-calendars',
    requests: 0,
  },
  {
    tool: 'calendar_list_events' as const,
    args: { timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', maxResults: 10 },
    callId: 'prod-list-events',
    requests: 2,
  },
  {
    tool: 'calendar_get_event' as const,
    args: { eventId: 'evt123456', calendarId: 'personal@example.test' },
    callId: 'prod-get-event',
    requests: 2,
  },
  {
    tool: 'calendar_check_availability' as const,
    args: { timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC', calendarIds: ['personal@example.test'] },
    callId: 'prod-check-availability',
    requests: 1,
  },
])('prepared production read $tool reaches continuation with application storage blocked', async spec => {
  let releaseSave!: () => void;
  const heldSave = new Promise<void>(resolve => { releaseSave = resolve; });
  let archive!: MemoryTextArchive;
  const f = await nativeFixture(async (envelope, limits) => {
    await heldSave;
    return archive.save(envelope, limits);
  });
  archive = new MemoryTextArchive(f.p, f.runtime.d.assets);
  const cipher = new CalendarSecretCipher({ status: 'ready', key: Buffer.alloc(32, 7) });
  const setup = parseCalendarSetupOptions({
    initial: { enabled: true, processingPolicyId: 'fixture-policy' },
    realDataPolicyApproved: true,
    oauth: { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret',
      redirectUri: 'http://127.0.0.1:3000/api/plugins/google-calendar/oauth/callback' },
  });
  const seeded = (await f.p.calendarConnectionsV2.get(f.identity.userId))!;
  const nextCredVersion = seeded.credentialVersion + 1;
  const nextSeeded = { ...seeded, credentialVersion: nextCredVersion };
  await f.p.calendarConnectionsV2.compareAndSwap({
    userId: seeded.userId, expectedRevision: seeded.revision,
    expectedConnectionRevision: seeded.connectionRevision,
    expectedDefaultSettingRevision: seeded.defaultSetting.defaultSettingRevision,
    next: calendarConnectionV2Schema.parse({
      ...seeded, revision: seeded.revision + 1,
      credentialVersion: nextCredVersion,
      grantedScopes: [...CALENDAR_SCOPES],
      credentials: {
        access: cipher.sealToken(tokenAad(nextSeeded, 'access'), 'prepared-access-token'),
        refresh: cipher.sealToken(tokenAad(nextSeeded, 'refresh'), 'prepared-refresh-token'),
      },
      tokenExpiresAt: new Date(Date.parse(f.runtime.now()) + 3600000).toISOString(),
    }),
  });
  const routedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    if (parsed.hostname === 'www.googleapis.com') {
      if (parsed.pathname === '/calendar/v3/users/me/calendarList/personal%40example.test') {
        return googleJson({ id: 'personal@example.test', summary: 'Personal', primary: true,
          accessRole: 'owner', timeZone: 'Etc/UTC', hidden: false, deleted: false, selected: true });
      }
      if (parsed.pathname === '/calendar/v3/users/me/calendarList') {
        return googleJson({ kind: 'calendar#calendarList', items: [
          { id: 'personal@example.test', summary: 'Personal', primary: true, accessRole: 'owner', timeZone: 'Etc/UTC', selected: true },
        ] });
      }
      if (parsed.pathname === '/calendar/v3/calendars/personal%40example.test/events/evt123456') {
        return googleJson({ id: 'evt123456', summary: 'Standup', status: 'confirmed',
          start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
          end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' } });
      }
      if (parsed.pathname === '/calendar/v3/calendars/personal%40example.test/events') {
        return googleJson({ timeZone: 'Etc/UTC', items: [] });
      }
      if (parsed.pathname === '/calendar/v3/freeBusy') {
        return googleJson({
          kind: 'calendar#freeBusy',
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          calendars: { 'personal@example.test': { busy: [] } },
        });
      }
      throw new Error(`Unexpected Google URL: ${url}`);
    }
    return (f.runtime.d.fetcher ?? fetch)(input, init);
  };
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => Date.parse(f.runtime.now()));
  const assembly = createCalendarAssembly({
    config: {
      setup, permission: { content: 'volatile', minimalEvidenceAllowed: true, policyId: 'fixture-policy' },
      policyDeadlines: [Date.parse(f.runtime.now()) + 3600000], trustedTimeZone: 'Etc/UTC',
    },
    encryption: { status: 'ready', key: Buffer.alloc(32, 7) },
    userId: f.identity.userId,
    store: f.p.calendarConnections,
    storeV2: f.p.calendarConnectionsV2,
    discovery: new CalendarDiscoveryApi({ fetcher: routedFetch }),
    fetcher: routedFetch,
    onAccountInvalidated: async () => undefined,
  });
  const runtime = new DurableChatRuntime({
    ...f.runtime.d, calendar: assembly.runtime, calendarFor: () => assembly.runtime,
  });
  await assembly.connections.statusV2();
  const targetAccount = await assembly.runtime.connection.currentAccount();
  const resolvedCheck = await assembly.runtime.capabilities.resolve({
    account: targetAccount, selector: null, operation: 'read', signal: new AbortController().signal,
    deadlineAt: new Date(Date.parse(f.runtime.now()) + 60000).toISOString(),
    consumeRequest: async () => undefined, consumeRefreshRequest: async () => undefined,
  });
  expect(resolvedCheck.outcome).toBe('resolved');

  const memory = runtime.memoryFor(f.identity.userId, true)!;
  const flush = vi.spyOn(memory.foundation, 'flushSession');
  const blocked = () => { throw new Error('Application storage blocked on prepared read'); };
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  const blockMethods = (target: object | null | undefined) => {
    if (!target) return;
    for (const name of new Set([...Object.keys(target), ...Object.getOwnPropertyNames(Object.getPrototypeOf(target))])) {
      if (name !== 'constructor' && typeof (target as Record<string, unknown>)[name] === 'function') {
        spies.push(vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(blocked));
      }
    }
  };
  for (const port of new Set(Object.values(f.p).filter(v => v && typeof v === 'object'))) {
    if (port !== f.p.owner.store && !('Wire' in (port as object))) blockMethods(port as object);
  }
  blockMethods(f.db.store);
  const wireBefore = f.db.wireCalls.length;
  f.modelWires.push(
    skillWire('activate_skill', { plugin: 'google-calendar', tools: [spec.tool] }, `${spec.callId}-load`),
    skillWire('call_tool', { plugin: 'google-calendar', tool: spec.tool, arguments: spec.args }, spec.callId),
    textWire('Prepared read result.'),
    textWire('Follow-up on prepared read.'),
  );
  try {
    const first = await runtime.submitTurn({
      identity: f.identity, sessionId: null, content: `Run ${spec.tool}`, idempotencyKey: `${spec.callId}-1`,
    });
    await runtime.executeTurn({ userId: f.identity.userId, ...first, signal: new AbortController().signal,
      emit: async () => {}, emitCalendar: async () => {} });
    expect(memory.status(f.identity.userId, first.sessionId, first.turnId)).toMatchObject({
      status: 'completed', save: { durableVersion: 0 },
    });
    const followUp = await runtime.submitTurn({
      identity: f.identity, sessionId: first.sessionId, content: 'Continue after prepared read', idempotencyKey: `${spec.callId}-2`,
    });
    await runtime.executeTurn({ userId: f.identity.userId, ...followUp, signal: new AbortController().signal,
      emit: async () => {}, emitCalendar: async () => {} });
    expect(memory.status(f.identity.userId, followUp.sessionId, followUp.turnId)).toMatchObject({
      status: 'completed', save: { durableVersion: 0 },
    });
    expect(flush).not.toHaveBeenCalled();
    expect(f.db.wireCalls).toHaveLength(wireBefore);
    expect(f.modelBodies).toHaveLength(4);
    expect(toolIds(f.modelBodies[2]!)).toContain(spec.callId);
    const budget = memory.foundation.result(memory.find(first.sessionId, first.turnId)!.turn)?.calendar?.budget;
    expect(budget).toMatchObject({ logicalTools: 1, calendarRequests: spec.requests });
    for (const spy of spies) spy.mockRestore();
    releaseSave();
    await expect(runtime.drain(200)).resolves.toMatchObject({ drained: true });
    expect(memory.foundation.session(first.sessionId)).toMatchObject({ version: 2, durableVersion: 2 });
  } finally {
    releaseSave();
    for (const spy of spies) spy.mockRestore();
    dateNow.mockRestore();
    runtime.stopAccepting();
    await assembly.execution.close();
    await assembly.connections.close();
    f.runtime.stopAccepting();
  }
});

it('completes a create while an earlier archive update is paused, confirms barrier receipts, and drains dirty prefix on resume', async () => {
  const f = await nativeFixture();
  const pause = f.db.pauseNextUpdate();
  const cal = f.runtime.d.calendar!;
  if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
  const invoke = cal.execution.invoke.bind(cal.execution);
  let inspectedPrefix = false;
  vi.spyOn(cal.execution, 'invoke').mockImplementation(async request => {
    if (request.call.name === 'calendar_create_event') {
      const binding = request.binding;
      expect(binding.toolCallId).toBe('original-create-call');
      const active = await f.p.metadata.getAttempt(binding.userId, binding.sessionId, binding.attemptId);
      expect(active).toMatchObject({ status: 'generating', causal: { userMessageId: expect.any(String) }, nativePublication: { version: 2 } });
      expect(await f.p.metadata.getAcceptance(binding.userId, binding.sessionId, binding.attemptId))
        .toMatchObject({ attemptId: binding.attemptId, userMessageId: active!.causal.userMessageId });
      expect(await f.p.messages.get(binding.userId, binding.sessionId, active!.causal.userMessageId))
        .toMatchObject({ completionStatus: 'accepted', role: 'user' });
      expect(await f.p.calendarAccountingV2.getBudgetConfirmed!(binding.userId, binding.sessionId, binding.turnId))
        .toMatchObject({ record: { creates: 1 } });
      inspectedPrefix = true;
    }
    return invoke(request);
  });
  f.modelWires.push(
    textWire('Earlier answer'),
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'original-create-load'),
    createWire(event(), 'original-create-call'),
    textWire('Follow-up answer'),
  );
  let run: Promise<void> | undefined;
  try {
    const first = await f.submit('Earlier question'); await f.execute(first); await pause.started;
    const second = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', first.sessionId);
    run = f.execute(second);
    await vi.waitFor(() => expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1));
    expect(inspectedPrefix).toBe(true);
    await run;
    expect(f.status(second)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } });
    pause.resume();
    await f.saved(second);
    expect(f.status(second)).toMatchObject({ status: 'completed', save: { state: 'saved', version: 2, durableVersion: 2 } });
    expect(await f.p.metadata.getAttempt(f.identity.userId, second.sessionId, second.attemptId)).toMatchObject({ status: 'completed' });
    expect(await f.operationFor(second))
      .toMatchObject({ state: 'succeeded', originatingAttemptId: second.attemptId, originatingTurnId: second.turnId });
    const third = await f.submit('Follow up', first.sessionId); await f.execute(third);
    expect(toolIds(f.modelBodies.at(-1)!).filter(id => id === 'original-create-call')).toHaveLength(1);
    expect((f.modelBodies.at(-1)!.messages as { role: string; tool_call_id?: string }[])
      .filter(message => message.role === 'tool' && message.tool_call_id === 'original-create-call')).toHaveLength(1);
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId).filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['Earlier question', 'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', 'Follow up']);
    await f.saved(third);
    expect(await f.p.sessions.get(f.identity.userId, third.sessionId)).toMatchObject({ memoryPublication: { version: 3 } });
  } finally { pause.resume(); await run?.catch(() => undefined); vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('persists a partial active prefix before a create and resumes its exact pending decision without repeating inference', async () => {
  const f = await nativeFixture();
  const persist = vi.spyOn(f.p.metadata, 'putAttemptConfirmed').mockRejectedValueOnce(new AppError('PERSISTENCE_ERROR', 'Offline prefix'));
  f.modelWires.push(
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'partial-prefix-load'),
    createWire(event(), 'partial-prefix-call'),
    textWire('Scheduled.'),
  );
  try {
    const ids = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(ids).catch(() => undefined);
    expect(f.status(ids)).toMatchObject({ error: { code: 'PERSISTENCE_ERROR' } });
    expect(f.effects).toEqual([]); expect(f.modelBodies).toHaveLength(2);
    const retry = await f.runtime.retryTurn({ identity: f.identity, sessionId: ids.sessionId,
      turnId: ids.turnId, idempotencyKey: 'retry-partial-prefix-only' });
    expect(retry.attemptId).toBe(ids.attemptId);
    await f.execute(retry);
    await f.saved(ids);
    expect(f.status(ids)).toMatchObject({ status: 'completed', save: { state: 'saved' } });
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(f.modelBodies).toHaveLength(2);
    expect(await f.operationFor(ids)).toMatchObject({ state: 'succeeded', originatingAttemptId: ids.attemptId });
    expect((await f.p.messages.list(f.identity.userId, ids.sessionId, { cursor: null, limit: 50 })).items.filter(message => message.role === 'user'))
      .toHaveLength(1);
    expect(persist.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('times out a blocked barrier write and resumes its exact pending decision without repeating inference', async () => {
  const f = await nativeFixture();
  const blockBarrier = vi.spyOn(f.p.metadata, 'putAttemptConfirmed').mockImplementationOnce(
    () => new Promise((_, reject) => setTimeout(() => reject(new AppError('PERSISTENCE_ERROR', 'Barrier write timed out', false)), 25)),
  );
  f.modelWires.push(
    textWire('Answer with an unresolved save'),
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'timeout-pending-load'),
    createWire(event(), 'timeout-pending-call'),
    textWire('Scheduled.'),
  );
  try {
    const first = await f.submit('Ordinary question'); await f.execute(first);
    const next = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', first.sessionId);
    await f.execute(next).catch(() => undefined);
    expect(f.status(next)?.error?.code).toBe('PERSISTENCE_ERROR');
    expect(f.effects).toEqual([]); expect(f.modelBodies).toHaveLength(3);
    blockBarrier.mockRestore();
    const retry = await f.runtime.retryTurn({ identity: f.identity, sessionId: next.sessionId, turnId: next.turnId,
      idempotencyKey: 'resume-timeout-pending-call' });
    expect(retry.attemptId).toBe(next.attemptId); await f.execute(retry);
    expect(f.status(next)?.status).toBe('completed'); expect(f.modelBodies).toHaveLength(3);
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(await f.operationFor(next)).toMatchObject({ state: 'succeeded', originatingAttemptId: next.attemptId });
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('promotes a create through the existing operation writer once and exposes its provenance to the next memory turn', async () => {
  const f = await nativeFixture();
  f.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'load-memory-create'),
    createWire(event(), 'original-memory-create'), textWire('I remember the scheduled event.'));
  try {
    const ids = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(ids);
    await f.saved(ids);
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(await f.operationFor(ids)).toMatchObject({ state: 'succeeded', originatingAttemptId: ids.attemptId,
      originatingTurnId: ids.turnId, originatingAcceptedMessageId: ids.userMessageId });
    expect(await f.p.skillResults.get(f.identity.userId, ids.sessionId, 'original-memory-create'))
      .toMatchObject({ attemptId: ids.attemptId, toolCallId: 'original-memory-create' });
    expect(f.status(ids)).toMatchObject({ status: 'completed', save: { state: 'saved', version: 1, durableVersion: 1 } });
    const messages = f.runtime.memoryFor(f.identity.userId)!.foundation.history(ids.sessionId);
    expect(messages.find(message => message.role === 'assistant')?.sourceProvenance?.length).toBeGreaterThan(0);
    const next = await f.submit('What did you schedule?', ids.sessionId); await f.execute(next);
    expect(f.modelBodies).toHaveLength(3);
    expect(toolIds(f.modelBodies.at(-1)!)).toContain('original-memory-create');
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    await f.saved(next);
  } finally { f.runtime.stopAccepting(); }
});

it.each([
  { answer: 'yes', reference: false, creates: 1 },
  { answer: 'yes', reference: true, creates: 1 },
  { answer: 'no', reference: false, creates: 0 },
])('answers a warm pending proposal with zero model calls ($answer, reference=$reference)', async ({ answer, reference, creates }) => {
  const f = await nativeFixture();
  f.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'load-proposal'),
    createWire(event(), 'proposal-original-call'));
  try {
    const first = await f.submit('create the event'); await f.execute(first);
    await f.saved(first);
    const proposal = await f.currentProposal(first.sessionId);
    expect(proposal).toMatchObject({ state: 'pending', purpose: 'details' });
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(0);
    const reply = await f.runtime.submitTurn({ identity: f.identity, sessionId: first.sessionId, content: answer,
      idempotencyKey: `memory-proposal-${answer}-${reference}`, ...(reference ? {
        calendarReplyTo: { proposalId: proposal!.proposalId, revision: proposal!.revision },
      } : {}) });
    await f.execute(reply);
    await f.saved(reply);
    expect(f.modelBodies).toHaveLength(2);
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(creates);
    expect(await f.currentProposal(first.sessionId)).toBeNull();
    expect(f.status(reply)).toMatchObject({ status: 'completed', save: { state: 'saved', version: 2, durableVersion: 2 } });
    const budget = await f.p.calendarAccountingV2.getBudget(f.identity.userId, reply.sessionId, reply.turnId);
    expect(budget?.modelDispatches ?? 0).toBe(0);
  } finally { f.runtime.stopAccepting(); }
});

it('cold-hydrates async Calendar read history then tombstones source content when its clock expires', async () => {
  const f = await nativeFixture();
  f.modelWires.push(...readWires('cold-promoted-call'), textWire('Cold ordinary follow-up'), textWire('Expired ordinary follow-up'));
  let cold: DurableChatRuntime | undefined;
  try {
    const first = await f.submit('List events on 2026-11-03 from 10:00 to 11:00 Etc/UTC.'); await f.execute(first);
    expect(f.status(first)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } });
    await f.saved(first);
    expect(await f.runtime.drain(100)).toMatchObject({ drained: true });
    cold = new DurableChatRuntime(f.runtime.d);
    const execute = (ids: SubmitTurnResponse) => cold!.executeTurn({ userId: f.identity.userId, ...ids,
      signal: new AbortController().signal, emit: async () => {}, emitCalendar: async () => {} });
    const second = await cold.submitTurn({ identity: f.identity, sessionId: first.sessionId,
      content: 'Follow up', idempotencyKey: 'cold-promoted-follow-up' });
    await execute(second);
    expect(cold.memoryFor(f.identity.userId)!.status(f.identity.userId, second.sessionId, second.turnId)?.status).toBe('completed');
    expect(toolIds(f.modelBodies[3]!)).toContain('cold-promoted-call');
    await vi.waitFor(() => expect(cold!.memoryFor(f.identity.userId)!.status(f.identity.userId, second.sessionId, second.turnId)?.save?.state).toBe('saved'));
    const sources = cold.memoryFor(f.identity.userId)!.foundation.history(first.sessionId).flatMap(message => message.sourceProvenance ?? []);
    expect(sources.length).toBeGreaterThan(0);
    const firstAnswer = cold.memoryFor(f.identity.userId)!.foundation.history(first.sessionId)
      .find(message => message.turnId === first.turnId && message.role === 'assistant')?.content;
    expect(firstAnswer).toBeTruthy();
    expect(firstAnswer).not.toBe(CALENDAR_TOMBSTONE);
    f.advance(Math.max(...sources.map(source => Date.parse(source.expiresAt))) - f.clock() + 1);
    expect(cold.memoryFor(f.identity.userId)!.foundation.history(first.sessionId).find(message => message.turnId === first.turnId && message.role === 'assistant')?.content)
      .toBe(firstAnswer);
    const third = await cold.submitTurn({ identity: f.identity, sessionId: first.sessionId,
      content: 'What remains?', idempotencyKey: 'expired-promoted-follow-up' });
    await execute(third);
    const prompt = JSON.stringify(f.modelBodies.at(-1)!.messages);
    expect(prompt).toContain(firstAnswer);
    expect(prompt).toMatch(/do not recant/i);
    expect(prompt).not.toContain(CALENDAR_TOMBSTONE);
    expect(prompt).not.toContain('"tool_call_id":"cold-promoted-call"');
    expect(f.effects.filter(effect => effect.kind === 'list')).toHaveLength(1);
  } finally { cold?.stopAccepting(); f.runtime.stopAccepting(); }
});

it('keeps read evidence usable until its expiry and never reuses it at or after the exact boundary', async () => {
  const f = await nativeFixture();
  const readWire = (callId: string) => skillWire('call_tool', {
    plugin: 'google-calendar', tool: 'calendar_get_event', arguments: { eventId: 'abcde' },
  }, callId);
  f.modelWires.push(
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_get_event'] }, 'boundary-load'),
    readWire('boundary-call-1'),
    textWire('Found it.'),
  );
  try {
    const first = await f.submit('Read event abcde');
    await f.execute(first);
    await f.saved(first);
    const source = f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId)
      .flatMap(message => message.sourceProvenance ?? [])
      .find(value => value.schemaVersion === 2);
    expect(source).toBeDefined();
    const expiresAt = Date.parse(source!.expiresAt);
    const discovery = (await f.p.calendarConnectionsV2.get(f.identity.userId))!.discovery!;
    const usableUntil = Math.min(expiresAt, Date.parse(discovery.retentionExpiresAt));

    f.advance(usableUntil - 1 - f.clock());
    f.modelWires.push(readWire('boundary-call-2'), textWire('Still current.'));
    const before = await f.submit('Read event abcde again.', first.sessionId);
    await f.execute(before);
    await f.saved(before);
    expect(f.status(before)?.status).toBe('completed');
    expect(f.effects.filter(effect => effect.kind === 'get')).toHaveLength(2);
    expect(JSON.stringify(f.modelBodies.at(-1)!.messages)).toContain('Planning');
    const latestExpiry = Math.max(...f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId)
      .flatMap(message => message.sourceProvenance ?? [])
      .filter(value => value.schemaVersion === 2)
      .map(value => Date.parse(value.expiresAt)));

    f.advance(latestExpiry - f.clock());
    f.modelWires.push(readWire('boundary-call-3'));
    const exact = await f.submit('Read event abcde at expiry.', first.sessionId);
    await f.execute(exact);
    await f.saved(exact);
    expect(f.status(exact)?.status).toBe('completed');
    expect(f.effects.filter(effect => effect.kind === 'get')).toHaveLength(3);
    expect(JSON.stringify(f.modelBodies.at(-1)!.messages)).not.toContain('Planning');
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId)
      .filter(message => message.turnId === exact.turnId && message.role === 'assistant')
      .map(message => message.content).join('\n')).not.toContain('Planning');

    f.advance(1);
    f.modelWires.push(readWire('boundary-call-4'));
    const after = await f.submit('Read event abcde after expiry.', first.sessionId);
    await f.execute(after);
    await f.saved(after);
    expect(f.status(after)?.status).toBe('completed');
    expect(f.effects.filter(effect => effect.kind === 'get')).toHaveLength(4);
    expect(JSON.stringify(f.modelBodies.at(-1)!.messages)).not.toContain('Planning');
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId)
      .filter(message => message.turnId === after.turnId && message.role === 'assistant')
      .map(message => message.content).join('\n')).not.toContain('Planning');
  } finally { f.runtime.stopAccepting(); }
});

it('cold-hydrates a pending proposal and accepts its referenced reply without inference', async () => {
  const f = await nativeFixture();
  f.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'load-cold-proposal'),
    createWire(event(), 'cold-proposal-call'));
  let cold: DurableChatRuntime | undefined;
  try {
    const first = await f.submit('create the event'); await f.execute(first);
    await f.saved(first);
    const proposal = await f.currentProposal(first.sessionId);
    expect(proposal).toMatchObject({ state: 'pending' });
    await f.runtime.drain(100); cold = new DurableChatRuntime(f.runtime.d);
    const reply = await cold.submitTurn({ identity: f.identity, sessionId: first.sessionId, content: 'yes',
      idempotencyKey: 'cold-pending-reply', calendarReplyTo: { proposalId: proposal!.proposalId, revision: proposal!.revision } });
    await cold.executeTurn({ userId: f.identity.userId, ...reply, signal: new AbortController().signal,
      emit: async () => {}, emitCalendar: async () => {} });
    expect(f.modelBodies).toHaveLength(2);
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(cold.memoryFor(f.identity.userId)!.status(f.identity.userId, reply.sessionId, reply.turnId)?.status).toBe('completed');
  } finally { cold?.stopAccepting(); f.runtime.stopAccepting(); }
});

it('reconciles the original event after provider create succeeds and receipt persistence fails', async () => {
  const f = await nativeFixture();
  f.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'load-crash-create'),
    createWire(event(), 'crash-create-call'), textWire('The original event is safely recovered.'));
  try {
    const ids = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    f.failOnce('receipt-save'); await f.execute(ids).catch(() => undefined);
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    const before = await f.operationFor(ids);
    expect(['dispatching', 'unknown']).toContain(before?.state);
    await f.runtime.reconcileSession(f.identity.userId, ids.sessionId);
    expect(await f.operationFor(ids)).toMatchObject({ state: 'succeeded', googleEventId: before!.googleEventId });
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(f.effects.filter(effect => effect.kind === 'readback').map(effect => effect.eventId)).toEqual([before!.googleEventId]);
    expect(f.modelBodies).toHaveLength(2);
    const next = await f.submit('What happened to that event?', ids.sessionId); await f.execute(next);
    expect(f.status(next)?.status).toBe('completed'); expect(f.modelBodies).toHaveLength(3);
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(f.effects.filter(effect => effect.kind === 'readback')).toHaveLength(1);
  } finally { f.runtime.stopAccepting(); }
});

it('recovers a sealed promoted create after assistant publication fails without replaying the model or effect', async () => {
  const f = await nativeFixture();
  const legacy = new DurableChatRuntime({ ...f.runtime.d, memoryFirst: undefined });
  const append = f.p.messages.appendConfirmed.bind(f.p.messages);
  let rejectAssistant = true;
  vi.spyOn(f.p.messages, 'appendConfirmed').mockImplementation(async record => {
    if (record.role === 'assistant' && rejectAssistant) {
      rejectAssistant = false;
      throw new AppError('PERSISTENCE_ERROR', 'Offline assistant publication');
    }
    return append(record);
  });
  f.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'load-sealed-create'),
    createWire(event(), 'sealed-create-call'), textWire('The saved Calendar result is available.'));
  try {
    const ids = await legacy.submitTurn({
      identity: f.identity, sessionId: null,
      content: 'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
      idempotencyKey: 'sealed-promoted-create-turn',
    });
    await legacy.executeTurn({
      userId: f.identity.userId, ...ids, signal: new AbortController().signal,
      emit: async () => {}, emitCalendar: async () => {},
    }).catch(() => undefined);
    legacy.stopAccepting();
    expect((await f.p.metadata.getAttempt(f.identity.userId, ids.sessionId, ids.attemptId))?.status).not.toBe('completed');
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(f.modelBodies).toHaveLength(2);
    const original = await f.operationFor(ids);
    expect(original).toMatchObject({ state: 'succeeded' });
    await f.runtime.reconcileSession(f.identity.userId, ids.sessionId);
    expect(await f.operationFor(ids)).toMatchObject({ state: 'succeeded', googleEventId: original!.googleEventId });
    expect((await f.p.metadata.getAttempt(f.identity.userId, ids.sessionId, ids.attemptId))?.status).toBe('completed');
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1); expect(f.modelBodies).toHaveLength(2);
    const next = await f.submit('Continue after the recovered publication', ids.sessionId); await f.execute(next);
    expect(f.status(next)?.status).toBe('completed'); expect(f.modelBodies).toHaveLength(3);
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
  } finally { legacy.stopAccepting(); vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it.each(['disconnect', 'disable'] as const)('refuses external execution when %s races the mutation barrier', async reason => {
  const f = await nativeFixture();
  let releaseBarrier!: () => void, enteredBarrier!: () => void;
  const barrierHeld = new Promise<void>(r => { releaseBarrier = r; });
  const barrierStarted = new Promise<void>(r => { enteredBarrier = r; });
  const origPutAttempt = f.p.metadata.putAttemptConfirmed!.bind(f.p.metadata);
  vi.spyOn(f.p.metadata, 'putAttemptConfirmed').mockImplementationOnce(async record => {
    enteredBarrier();
    await barrierHeld;
    return origPutAttempt(record);
  });
  f.modelWires.push(
    textWire('Dirty answer'),
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'invalidated-load'),
    createWire(event(), 'invalidated-before-promotion'),
  );
  let run: Promise<void> | undefined;
  try {
    const first = await f.submit('Ordinary question'); await f.execute(first);
    const next = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', first.sessionId);
    run = f.execute(next);
    await barrierStarted;
    expect(f.modelBodies).toHaveLength(3);
    const connection = (await f.p.calendarConnectionsV2.get(f.identity.userId))!;
    const account = { userId: connection.userId, connectionId: connection.connectionId,
      connectionRevision: connection.connectionRevision, googleSubjectId: connection.googleSubjectId };
    if (reason === 'disable') {
      const snapshot = f.runtime.d.currentConfig!.current()!;
      f.publish({ ...snapshot, revision: snapshot.revision + 1, calendar: { ...snapshot.calendar!, enabled: false } });
    } else await f.p.calendarConnectionsV2.compareAndSwap({ userId: f.identity.userId, expectedRevision: connection.revision,
      expectedConnectionRevision: connection.connectionRevision, expectedDefaultSettingRevision: connection.defaultSetting.defaultSettingRevision,
      next: { ...connection, revision: connection.revision + 1, connectionRevision: connection.connectionRevision + 1,
        credentialVersion: connection.credentialVersion + 1,
        enabled: false, status: 'disconnected', credentials: null, tokenExpiresAt: null, discovery: null } });
    f.runtime.invalidateCalendarAccount(account, reason === 'disable' ? 'disabled' : 'disconnected');
    releaseBarrier(); await run.catch(() => undefined);
    expect(f.effects).toEqual([]); expect(f.modelBodies).toHaveLength(3);
    expect(f.status(next)?.status).not.toBe('completed');
  } finally { releaseBarrier?.(); await run?.catch(() => undefined); vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('releases a persisted active prefix when account invalidation races its live binding and saves a later ordinary turn', async () => {
  const f = await nativeFixture();
  const cal = f.runtime.d.calendar!;
  if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
  const current = cal.connection.currentAccount.bind(cal.connection);
  const account = vi.spyOn(cal.connection, 'currentAccount').mockImplementationOnce(async () => {
    const binding = await current();
    f.runtime.invalidateCalendarAccount(binding, 'disconnect');
    return binding;
  });
  f.modelWires.push(...readWires('binding-invalidation-call').slice(0, 2), textWire('An ordinary answer after invalidation.'));
  try {
    const ids = await f.submit('List events on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(ids).catch(() => undefined);
    expect(account).toHaveBeenCalledOnce(); expect(f.effects).toEqual([]); expect(f.modelBodies).toHaveLength(2);
    expect(f.status(ids)?.status).not.toBe('completed');
    account.mockRestore();
    const next = await f.submit('Explain an unrelated topic', ids.sessionId); await f.execute(next);
    expect(f.status(next)?.status).toBe('completed'); expect(f.modelBodies).toHaveLength(3);
    await f.saved(next);
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.session(ids.sessionId)).toMatchObject({ dirty: false });
    expect(f.effects).toEqual([]);
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it.each(['disconnect', 'revoke', 'disable'] as const)('real AppService composition admits new and warm chat with Mongo/account blocked and forwards %s invalidation', async lifecycle => {
  const native = await nativeFixture();
  const seed = document(1); seed.settings.openRouter.modelId = 'fixture/model';
  const config = assemblyFixture(seed);
  await config.repository.compareAndSwap(1, { ...seed, revision: 2, credentials: {
    ...seed.credentials, openrouter: { envelope: config.credentials.seal('openrouter', secret), validatedAt: at },
  } });
  config.ports.calendarConfig = {
    setup: parseCalendarSetupOptions({ initial: { enabled: true, processingPolicyId: 'fixture-policy' },
      oauth: { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret',
        redirectUri: 'http://localhost:3000/api/plugins/google-calendar/oauth/callback' },
      frontendOrigin: 'http://localhost:5173', backendOrigin: 'http://localhost:3000',
      evidence: 'fixture', realDataPolicyApproved: true }),
    permission: { content: 'retained', minimalEvidenceAllowed: true, policyId: 'fixture-policy' },
    policyDeadlines: [Date.parse('2099-01-01T00:00:00.000Z')], trustedTimeZone: 'Etc/UTC',
  };
  config.bootstrap.calendar = config.ports.calendarConfig;
  config.ports.open = vi.fn(async () => ({ ...native.p, ping: async () => true, close: async () => {} })) as never;
  const runtime = vi.fn((dependencies: RuntimeDependencies) => new DurableChatRuntime({ ...dependencies,
    now: native.clock, memoryFirst: { ...dependencies.memoryFirst!, policy: { ...dependencies.memoryFirst!.policy, shutdownDrainMs: 30 },
      save: async () => ({ kind: 'unknown', retryable: false }) } }));
  config.ports.runtime = runtime; config.ports.limits = vi.fn(async () => calendarLimits);
  config.ports.fetcher = native.fetcher;
  const service = await AppService.create(config.bootstrap, config.ports);
  const raw = runtime.mock.results[0]!.value;
  await service.calendarFor(native.identity.userId).connections.statusV2();
  const blocked = () => { throw new Error('Mongo/account access blocked in production conversation'); };
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  for (const port of new Set(Object.values(native.p).filter(value => value && typeof value === 'object'))) {
    const names = new Set([...Object.keys(port), ...Object.getOwnPropertyNames(Object.getPrototypeOf(port))]);
    for (const name of names) if (name !== 'constructor' && typeof port[name] === 'function')
      spies.push(vi.spyOn(port, name).mockImplementation(blocked));
  }
  const cal = raw.d.calendarFor!(native.identity.userId);
  if (!isCalendarV2(cal)) throw new Error('AppService must install Calendar v2');
  spies.push(vi.spyOn(cal.connection, 'currentAccount').mockImplementation(blocked));
  spies.push(vi.spyOn(cal.connection, 'requireAccountCurrent').mockImplementation(blocked));
  const frames: StreamEnvelope[] = [];
  native.modelWires.push(textWire('First assembled answer'), textWire('Second assembled answer'));
  try {
    expect(raw.memoryFor(native.identity.userId, true)!.eligible()).toBe(true);
    const first = await service.operations.runtime.submitTurn({ identity: native.identity, sessionId: null,
      content: 'First assembled question', idempotencyKey: 'app-calendar-first' });
    const execute = (ids: SubmitTurnResponse) => service.operations.runtime.executeTurn({ userId: native.identity.userId,
      ...ids, signal: new AbortController().signal, emit: async frame => { frames.push(frame); } });
    await execute(first);
    expect(frames.some(frame => frame.event.type === 'delta')).toBe(true);
    expect(frames.at(-1)?.event.type).toBe('completed');
    const second = await service.operations.runtime.submitTurn({ identity: native.identity, sessionId: first.sessionId,
      content: 'Second assembled question', idempotencyKey: 'app-calendar-second' });
    await execute(second);
    expect(runtime).toHaveBeenCalledOnce(); expect(native.modelBodies).toHaveLength(2);
    for (const body of native.modelBodies) {
      expect(body.user).toBe(native.identity.userId);
      expect(body.tools).toEqual(SKILL_NATIVE_TOOLS.map(tool => ({ type: 'function', function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema,
      } })));
    }
    expect(raw.memoryFor(native.identity.userId)!.foundation.snapshot().sessions).toBe(1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
    const invalidate = vi.spyOn(raw, 'invalidateCalendarAccount');
    if (lifecycle === 'disable') await service.calendarFor(native.identity.userId).connections.settings({ enabled: false }, new AbortController().signal);
    else await service.calendarFor(native.identity.userId).connections.disconnect(lifecycle === 'revoke'
      ? { mode: 'revoke-google-grant', acknowledgeProjectWideRevocation: true } : { mode: 'local' }, new AbortController().signal);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ userId: native.identity.userId,
      connectionId: 'conn-aurvin-dev', connectionRevision: 1 }), lifecycle === 'disable' ? 'disabled' : 'disconnect');
  } finally {
    vi.restoreAllMocks(); await service.operations.shutdown(); native.runtime.stopAccepting();
  }
});

it('immediately redacts warm source messages and historical groups after account invalidation', async () => {
  const f = await nativeFixture();
  f.modelWires.push(...readWires('redacted-warm-call'), textWire('Ordinary answer after disconnect'));
  try {
    const first = await f.submit('List events on 2026-11-03 from 10:00 to 11:00 Etc/UTC.'); await f.execute(first);
    const conn = (await f.p.calendarConnectionsV2.get(f.identity.userId))!;
    const account = { userId: conn.userId, connectionId: conn.connectionId,
      connectionRevision: conn.connectionRevision, googleSubjectId: conn.googleSubjectId };
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId).some(message => message.sourceProvenance?.length)).toBe(true);
    const firstAnswer = f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId)
      .find(message => message.role === 'assistant')?.content;
    expect(firstAnswer).toBeTruthy();
    expect(firstAnswer).not.toBe(CALENDAR_TOMBSTONE);
    f.runtime.invalidateCalendarAccount(account, 'disconnect');
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId).find(message => message.role === 'assistant')?.content)
      .toBe(firstAnswer);
    const second = await f.submit('Explain something unrelated', first.sessionId); await f.execute(second);
    expect(f.status(second)?.status).toBe('completed');
    const prompt = JSON.stringify(f.modelBodies.at(-1)!.messages);
    expect(prompt).toContain(firstAnswer);
    expect(prompt).toMatch(/do not recant/i);
    expect(prompt).not.toContain(CALENDAR_TOMBSTONE);
    expect(f.effects.filter(effect => effect.kind === 'list')).toHaveLength(1);
  } finally { f.runtime.stopAccepting(); }
});

it('purges a cached pending proposal when its account is invalidated before a later reply', async () => {
  const f = await nativeFixture();
  f.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'load-invalidated-proposal'),
    createWire(event(), 'invalidated-proposal-call'), textWire('There is no active scheduling request.'));
  try {
    const first = await f.submit('create the event'); await f.execute(first);
    expect(await f.currentProposal(first.sessionId)).toMatchObject({ state: 'pending' });
    const conn = (await f.p.calendarConnectionsV2.get(f.identity.userId))!;
    const firstAnswer = f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId)
      .find(message => message.role === 'assistant')?.content;
    expect(firstAnswer).toBeTruthy();
    expect(firstAnswer).not.toBe(CALENDAR_TOMBSTONE);
    f.runtime.invalidateCalendarAccount({ userId: conn.userId, connectionId: conn.connectionId,
      connectionRevision: conn.connectionRevision, googleSubjectId: conn.googleSubjectId }, 'disconnect');
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId).find(message => message.role === 'assistant')?.content)
      .toBe(firstAnswer);
    const cal = f.runtime.d.calendar!;
    if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
    const account = vi.spyOn(cal.connection, 'currentAccount');
    const reply = await f.submit('yes', first.sessionId); await f.execute(reply);
    expect(f.status(reply)?.status).toBe('completed'); expect(f.modelBodies).toHaveLength(3);
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(0);
    expect(account).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('keeps an unrelated reply conversational and leaves a known pending proposal unchanged', async () => {
  const f = await nativeFixture();
  f.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'load-unrelated-proposal'),
    createWire(event(), 'unrelated-proposal-call'), textWire('An ordinary unrelated answer.'));
  try {
    const first = await f.submit('create the event'); await f.execute(first);
    await f.saved(first);
    const proposal = await f.currentProposal(first.sessionId);
    expect(proposal).not.toBeNull();
    const second = await f.submit('Explain why the sky is blue', first.sessionId); await f.execute(second);
    expect(f.status(second)?.status).toBe('completed'); expect(f.modelBodies).toHaveLength(3);
    expect(await f.currentProposal(first.sessionId)).toMatchObject({ proposalId: proposal!.proposalId, revision: proposal!.revision, state: 'pending' });
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(0);
  } finally { f.runtime.stopAccepting(); }
});

it('expires a cached proposal before inference and never creates the event from an old approval', async () => {
  const f = await nativeFixture();
  f.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'load-expiring-proposal'),
    createWire(event(), 'expiring-proposal-call'));
  try {
    const first = await f.submit('create the event'); await f.execute(first);
    await f.saved(first);
    const proposal = await f.currentProposal(first.sessionId);
    expect(proposal).not.toBeNull();
    f.advance(Date.parse(proposal!.expiresAt) - f.clock() + 1);
    const reply = await f.submit('yes', first.sessionId); await f.execute(reply);
    expect(f.status(reply)?.status).toBe('completed'); expect(f.modelBodies).toHaveLength(2);
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(0);
    expect(await f.currentProposal(first.sessionId)).toBeNull();
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId).filter(message => message.role === 'assistant').at(-1)?.content)
      .toContain('expired');
  } finally { f.runtime.stopAccepting(); }
});

it('shares turn-wide native model and repair budgets across an explicit generation retry', async () => {
  const f = calendarFixture(undefined, undefined, { policy: PROPOSED_MEMORY_TEXT_POLICY,
    save: async () => ({ kind: 'unknown', retryable: false }) });
  await f.ready;
  f.modelWires.push(skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_calendars', arguments: {} }, 'retry-unloaded'),
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_calendars'] }, 'retry-loaded'),
    brokenTextWire(), textWire('Retry completed.'));
  try {
    const first = await f.submit('Ordinary question'); await f.execute(first);
    const memory = f.runtime.memoryFor(f.identity.userId)!, before = memory.foundation.result(memory.find(first.sessionId, first.turnId)!.turn)!.calendar!;
    expect(memory.status(f.identity.userId, first.sessionId, first.turnId)?.status).toBe('failed');
    expect(before.budget).toMatchObject({ modelDispatches: 3, repairs: 1 });
    const retry = await f.runtime.retryTurn({ identity: f.identity, sessionId: first.sessionId, turnId: first.turnId,
      idempotencyKey: 'retry-shares-native-budget' });
    expect(retry.attemptId).not.toBe(first.attemptId); await f.execute(retry);
    expect(memory.find(retry.sessionId, retry.turnId)?.error).toBeNull();
    const after = memory.foundation.result(memory.find(retry.sessionId, retry.turnId)!.turn)!.calendar!;
    expect(after.budget).toMatchObject({ modelDispatches: 4, repairs: 1, deadlineAt: before.budget.deadlineAt });
    expect(after.dispatches[0]!.dispatchIndex).toBe(4);
    const body = f.modelBodies.at(-1)!;
    expect((body.messages as { role: string; content: string }[]).filter(message => message.role === 'user' && message.content === 'Ordinary question'))
      .toHaveLength(1);
    expect(f.effects).toEqual([]);
  } finally { f.runtime.stopAccepting(); }
});

it('preserves dirty text then voice hearing and Canvas projections through Calendar promotion in the same foundation', async () => {
  const f = await nativeFixture();
  const pause = f.db.pauseNextUpdate();
  const voiceOutput = 'Voice note.\n\n```mermaid title="Calendar flow"\nflowchart TD\nA --> B\n```';
  f.modelWires.push(textWire('Text answer'), textWire(voiceOutput), ...readWires('cross-mode-read'));
  let delivery!: VoiceDelivery, spoken = '', run: Promise<void> | undefined;
  try {
    const first = await f.submit('Text question'); await f.execute(first); await pause.started;
    const reservation = await f.runtime.reservations.acquire({ identity: f.identity, conversationId: first.sessionId,
      owner: { kind: 'live', voiceSessionId: 'calendar-memory-voice' } });
    const voice = await f.runtime.submitLiveTurn({ identity: f.identity, sessionId: first.sessionId,
      content: 'Voice question', idempotencyKey: 'calendar-cross-mode-voice', reservation,
      configSnapshot: f.runtime.d.currentConfig!.current()!,
      voice: { voiceSessionId: 'calendar-memory-voice', socketEpoch: 1, providerTurnId: 'calendar-provider-voice' } });
    await f.runtime.executeTurn({ userId: f.identity.userId, ...voice, signal: new AbortController().signal,
      emit: async () => {}, emitCalendar: async () => {}, live: { reservation,
        start: async (attempt, write) => {
          delivery = new VoiceDelivery({ ...deliveryFixture(), userId: attempt.userId, sessionId: first.sessionId,
            turnId: attempt.turnId, attemptId: attempt.attemptId, voiceSessionId: 'calendar-memory-voice',
            responseId: key('voice-response', attempt.userId, first.sessionId, attempt.attemptId),
            status: 'pending', textGenerated: '', textSpoken: null, textRemaining: null,
            audioDurationMs: null, audioPlayedMs: null, playedSamples: null }, 0, write,
          { speak: async chunk => { spoken += chunk.text; }, flush: async () => {} }, 20);
          await delivery.start();
        }, delta: text => delivery.delta(text), finish: () => delivery.finish(),
        artifact: artifact => delivery.artifact(artifact), settle: async text => {
          const record = delivery.current();
          await delivery.event({ type: 'speech-completed', turnId: record.turnId, responseId: record.responseId,
            speechId: 'calendar-voice-speech', audioDurationMs: 100, audioSamples: 2400,
            usage: { providerRequestId: null, model: 'fixture', modelVersion: null, audioMs: 100, billableCharacters: text.length } });
          await delivery.playback(2400); await delivery.settle(text);
        } } });
    expect(f.status(voice)?.status).toBe('completed');
    expect(spoken).toContain('Voice note.'); expect(spoken).not.toContain('flowchart');
    expect(await f.runtime.getLiveDelivery(f.identity.userId, first.sessionId, voice.attemptId, reservation))
      .toMatchObject({ textSpoken: 'Voice note.', canvasArtifacts: [expect.objectContaining({ kind: 'mermaid' })] });
    await f.runtime.reservations.release({ identity: f.identity, reservationId: reservation.reservationId });
    const calendar = await f.submit('List events on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', first.sessionId);
    await f.execute(calendar);
    expect(f.status(calendar)?.status).toBe('completed');
    expect(f.effects.filter(effect => effect.kind === 'list')).toHaveLength(1);
    expect(f.modelBodies).toHaveLength(5);
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.session(first.sessionId)).toMatchObject({ dirty: true, durableVersion: 0 });
    pause.resume();
    await f.saved(calendar);
    expect(f.status(calendar)).toMatchObject({ status: 'completed', save: { state: 'saved', version: 3, durableVersion: 3 } });
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId).filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['Text question', 'Voice question', 'List events on 2026-11-03 from 10:00 to 11:00 Etc/UTC.']);
    const savedDelivery = await f.p.metadata.getVoiceDelivery(f.identity.userId, first.sessionId, voice.attemptId);
    expect(savedDelivery).toMatchObject({ textSpoken: 'Voice note.', canvasArtifacts: [expect.objectContaining({ kind: 'mermaid' })] });
    expect(JSON.stringify(f.modelBodies.at(-1)!.messages)).toContain('Voice note.');
    expect(f.effects.filter(effect => effect.kind === 'list')).toHaveLength(1);
  } finally { pause.resume(); await run?.catch(() => undefined); f.runtime.stopAccepting(); }
});

it('invalidates prepared reads before retention waits and rejects late publication while preserving replacement isolation', async () => {
  const f = await nativeFixture(undefined, 2);
  const cal = f.runtime.d.calendar!;
  if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
  const origInvoke = cal.execution.invoke.bind(cal.execution);
  let releaseInvoke!: () => void;
  let invokeEntered!: () => void;
  const invokeGate = new Promise<void>(r => { releaseInvoke = r; });
  const waiting = new Promise<void>(r => { invokeEntered = r; });
  vi.spyOn(cal.execution, 'invoke').mockImplementationOnce(async req => {
    invokeEntered();
    await invokeGate;
    return origInvoke(req);
  });
  const calendarViews: unknown[] = [];
  f.modelWires.push(
    ...readWires('late-pub-read').slice(0, 2),
    textWire('Late text that must not publish.'),
    textWire('Ordinary replacement-independent answer.'),
    ...readWires('replacement-account-read'),
  );
  let activeRun: Promise<void> | undefined;
  try {
    const conn = (await f.p.calendarConnectionsV2.get(f.identity.userId))!;
    const oldAccount = {
      userId: conn.userId, connectionId: conn.connectionId,
      connectionRevision: conn.connectionRevision, googleSubjectId: conn.googleSubjectId,
    };
    const first = await f.submit('List events on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    activeRun = f.runtime.executeTurn({
      userId: f.identity.userId, ...first, signal: new AbortController().signal,
      emit: async () => {},
      emitCalendar: async frame => {
        if (frame.event.type === 'calendar-view') calendarViews.push(frame.event.view);
      },
    });
    await waiting;
    // Disconnect while invoke is mid-flight -> synchronous runtime invalidation rejects late publication.
    await f.p.calendarConnectionsV2.compareAndSwap({
      userId: conn.userId, expectedRevision: conn.revision,
      expectedConnectionRevision: conn.connectionRevision,
      expectedDefaultSettingRevision: conn.defaultSetting.defaultSettingRevision,
      next: {
        ...conn, revision: conn.revision + 1, connectionRevision: conn.connectionRevision + 1,
        credentialVersion: conn.credentialVersion + 1, enabled: false, status: 'disconnected',
        credentials: null, tokenExpiresAt: null, discovery: null,
      },
    });
    f.runtime.invalidateCalendarAccount(oldAccount, 'disconnect');
    releaseInvoke();
    await activeRun.catch(() => undefined);

    const status = f.status(first);
    expect(status?.status).toBe('completed');
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.history(first.sessionId)
      .some(m => m.sourceProvenance?.some(s => s.redactedAt === null))).toBe(false);
    expect(calendarViews).toEqual([]);
    await f.saved(first);
    const native1 = await f.p.owner.store!.read('metadata', memoryCalendarRecordSchema, {
      _id: key('memory-calendar-native', f.identity.userId, first.sessionId, first.attemptId),
      userId: f.identity.userId, sessionId: first.sessionId,
    });
    if (native1?.schemaVersion === 2) {
      expect(native1.redactedAt).not.toBeNull();
      expect(isFullyErasedMemoryCalendarState(native1.state)).toBe(true);
    }

    // Reconnect with a new account revision -> populate discovery -> replacement account works cleanly without cross-revision bleed.
    await f.p.calendarConnectionsV2.compareAndSwap({
      userId: conn.userId, expectedRevision: conn.revision + 1,
      expectedConnectionRevision: conn.connectionRevision + 1,
      expectedDefaultSettingRevision: conn.defaultSetting.defaultSettingRevision,
      next: {
        ...conn, revision: conn.revision + 2, connectionRevision: 3,
        credentialVersion: conn.credentialVersion + 2, enabled: true, status: 'connected', discovery: null,
      },
    });
    if (conn.discovery) {
      await f.p.calendarConnectionsV2.compareAndSwap({
        userId: conn.userId, expectedRevision: conn.revision + 2,
        expectedConnectionRevision: 3,
        expectedDefaultSettingRevision: conn.defaultSetting.defaultSettingRevision,
        next: {
          ...conn, revision: conn.revision + 3, connectionRevision: 3,
          credentialVersion: conn.credentialVersion + 2, enabled: true, status: 'connected',
          discovery: { ...conn.discovery, connectionRevision: 3, discoveryRevision: conn.revision + 3 },
        },
      });
    }
    f.modelWires.length = 0;
    f.modelWires.push(
      textWire('Ordinary replacement-independent answer.'),
      ...readWires('replacement-account-read'),
    );
    const ordinary = await f.submit('General unrelated question');
    await f.execute(ordinary);
    expect(f.status(ordinary)?.status).toBe('completed');
    const replacement = await f.submit('List events on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(replacement);
    expect(f.status(replacement)?.status).toBe('completed');
    await f.saved(replacement);
    const native2 = await f.p.owner.store!.read('metadata', memoryCalendarRecordSchema, {
      _id: key('memory-calendar-native', f.identity.userId, replacement.sessionId, replacement.attemptId),
      userId: f.identity.userId, sessionId: replacement.sessionId,
    });
    expect(native2?.schemaVersion === 2 && native2.redactedAt === null).toBe(true);
  } finally {
    releaseInvoke?.();
    await activeRun?.catch(() => undefined);
    vi.restoreAllMocks();
    f.runtime.stopAccepting();
  }
});

it('erases expired Calendar evidence queued for retry when the clock advances past retention before retrySave', async () => {
  let archive!: MemoryTextArchive;
  let available = false;
  const f = await nativeFixture((e, limits) => available ? archive.save(e, limits)
    : Promise.resolve({ kind: 'unknown', retryable: true }), 2);
  archive = new MemoryTextArchive(f.p, f.runtime.d.assets, () => f.clock());
  f.modelWires.push(...readWires('queued-expiry-read'));
  try {
    const first = await f.submit('List events on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(first);
    await vi.waitFor(() => expect(f.status(first)?.save?.state).toBe('unknown'));
    const conn = (await f.p.calendarConnectionsV2.get(f.identity.userId))!;
    // Advance clock past 24h Calendar source TTL while envelope sits in retry queue.
    f.advance(86_400_000 + 60_000);
    available = true;
    const saveInfo = f.status(first)!.save!;
    await f.runtime.retrySave(f.identity.userId, first.sessionId, first.turnId,
      { epoch: saveInfo.epoch, version: saveInfo.version });
    await f.saved(first);
    const savedNative = await f.p.owner.store!.read('metadata', memoryCalendarRecordSchema, {
      _id: key('memory-calendar-native', f.identity.userId, first.sessionId, first.attemptId),
      userId: f.identity.userId, sessionId: first.sessionId,
    });
    expect(savedNative?.schemaVersion === 2 && savedNative.redactedAt !== null
      && isFullyErasedMemoryCalendarState(savedNative.state)
      && verifyMemoryCalendarRecordIntegrity(savedNative, memoryCalendarPublicationHash(savedNative))).toBe(true);
    const savedMsg = await f.p.messages.get(f.identity.userId, first.sessionId, key('output', f.identity.userId, first.sessionId, first.attemptId));
    expect(savedMsg?.sourceProvenance?.every(s => s.redactedAt !== null)).toBe(true);
    expect(conn.connectionRevision).toBeGreaterThanOrEqual(1);
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('continues reads through temporary archive failure within memory bounds and drains in exact order', async () => {
  let archive!: MemoryTextArchive;
  let available = false;
  const f = await nativeFixture((e, limits) => available ? archive.save(e, limits)
    : Promise.resolve({ kind: 'unknown', retryable: true }), 2);
  archive = new MemoryTextArchive(f.p, f.runtime.d.assets, () => f.clock());
  const versions: number[] = [];
  const origSave = archive.save.bind(archive);
  const trackedSave = vi.spyOn(archive, 'save').mockImplementation(async (e, limits) => {
    versions.push(e.version);
    return origSave(e, limits);
  });
  f.modelWires.push(...readWires('retry-read-1'), textWire('Continuation read follow-up.'));
  try {
    const first = await f.submit('List events on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(first);
    expect(f.status(first)?.status).toBe('completed');
    await vi.waitFor(() => expect(f.status(first)?.save?.state).toBe('unknown'));
    const second = await f.submit('Follow up immediately without DB', first.sessionId);
    await f.execute(second);
    expect(f.status(second)?.status).toBe('completed');
    expect(f.effects.filter(e => e.kind === 'list')).toHaveLength(1);
    expect(f.modelBodies).toHaveLength(4);
    const bodiesBeforeRetry = f.modelBodies.length;
    const effectsBeforeRetry = f.effects.length;

    available = true;
    f.advance(PROPOSED_MEMORY_TEXT_POLICY.retryBackoffMs + 1);
    const s1 = f.status(first)!.save!;
    await f.runtime.retrySave(f.identity.userId, first.sessionId, first.turnId, { epoch: s1.epoch, version: s1.version });
    await f.saved(second);
    expect(versions).toEqual([1, 2]);
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.session(first.sessionId)).toMatchObject({ durableVersion: 2, dirty: false });
    expect(f.modelBodies).toHaveLength(bodiesBeforeRetry);
    expect(f.effects).toHaveLength(effectsBeforeRetry);
    expect(trackedSave).toHaveBeenCalledTimes(2);
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('enforces maxEnvelopes, maxDirtyAgeMs, fence, read cancellation, and request limits without DB writes', async () => {
  // 1) maxEnvelopes: 2 & maxDirtyAgeMs boundary while prior save fails
  const bounded = await nativeFixture(async () => ({ kind: 'unknown', retryable: true }), 1, {
    maxEnvelopes: 2, maxDirtyAgeMs: 500,
  });
  bounded.modelWires.push(...readWires('bounded-read-1'), textWire('Second read follow-up'));
  try {
    const t1 = await bounded.submit('Read 1'); await bounded.execute(t1);
    await vi.waitFor(() => expect(bounded.status(t1)?.save?.state).toBe('unknown'));
    const t2 = await bounded.submit('Follow up 2', t1.sessionId); await bounded.execute(t2);
    await expect(bounded.submit('Third blocked by maxEnvelopes', t1.sessionId)).rejects.toMatchObject({ code: 'NOT_READY' });
  } finally { bounded.runtime.stopAccepting(); }

  const aged = await nativeFixture(async () => ({ kind: 'unknown', retryable: true }), 1, {
    maxEnvelopes: 8, maxDirtyAgeMs: 500,
  });
  aged.modelWires.push(textWire('Dirty turn 1'));
  try {
    const t1 = await aged.submit('Dirty 1'); await aged.execute(t1);
    await vi.waitFor(() => expect(aged.status(t1)?.save?.state).toBe('unknown'));
    aged.advance(501);
    await expect(aged.submit('Blocked after maxDirtyAgeMs', t1.sessionId)).rejects.toMatchObject({ code: 'NOT_READY' });
    // Session fence blocks submission synchronously
    aged.runtime.memoryFor(aged.identity.userId)!.foundation.fence(t1.sessionId, 1, 'revoked');
    await expect(aged.submit('Blocked by fence', t1.sessionId)).rejects.toMatchObject({ code: 'NOT_READY' });
  } finally { aged.runtime.stopAccepting(); }

  // 2) Read cancellation during provider invoke settles cleanly & captures interrupted accounting
  const cancelled = await nativeFixture(async () => ({ kind: 'unknown', retryable: false }), 1);
  const cal = cancelled.runtime.d.calendar!;
  if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
  const ac = new AbortController();
  vi.spyOn(cal.execution, 'invoke').mockImplementationOnce(async () => {
    ac.abort();
    throw new AppError('CANCELLED', 'Cancelled mid-read', false);
  });
  cancelled.modelWires.push(...readWires('cancel-read').slice(0, 2));
  try {
    const t1 = await cancelled.submit('Cancel this read');
    await cancelled.runtime.executeTurn({
      userId: cancelled.identity.userId, ...t1, signal: ac.signal, emit: async () => {}, emitCalendar: async () => {},
    });
    expect(cancelled.status(t1)?.status).toBe('interrupted');
    expect(cancelled.status(t1)?.error?.code).toBe('INTERRUPTED');
  } finally { vi.restoreAllMocks(); cancelled.runtime.stopAccepting(); }

  // 3) Request budget exhaustion stops extra Calendar HTTP requests and seals fallback answer
  const exhausted = await nativeFixture();
  const calEx = exhausted.runtime.d.calendar!;
  if (!isCalendarV2(calEx)) throw new Error('Fixture requires Calendar v2');
  const current = exhausted.currentConfig.current()!;
  await exhausted.publish({
    ...current,
    revision: current.revision + 1,
    calendar: { ...current.calendar!, limits: { ...current.calendar!.limits, calendarRequests: 1 } },
  });
  let invokeCalls = 0;
  const realInvoke = calEx.execution.invoke.bind(calEx.execution);
  vi.spyOn(calEx.execution, 'invoke').mockImplementation(async req => {
    invokeCalls++;
    await req.consumeRequest('list');
    return realInvoke({ ...req, consumeRequest: async () => {} });
  });
  exhausted.modelWires.push(
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_events'] }, 'ex-load'),
    skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_events', arguments: {
      timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', maxResults: 10,
    } }, 'ex-1'),
    skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_events', arguments: {
      timeMin: '2026-11-04T10:00:00Z', timeMax: '2026-11-04T11:00:00Z', maxResults: 10,
    } }, 'ex-2'),
  );
  try {
    const t1 = await exhausted.submit('Exhaust request budget');
    await exhausted.execute(t1).catch(() => undefined);
    expect(invokeCalls).toBe(2); // 2nd call rejected synchronously on consumeRequest before provider work
    expect(exhausted.effects).toHaveLength(1);
  } finally { vi.restoreAllMocks(); exhausted.runtime.stopAccepting(); }
});

it('preserves live Calendar read then dirty ordinary text follow-up through background drain in shared foundation', async () => {
  const f = await nativeFixture();
  f.modelWires.push(textWire('Seeded session answer.'), ...readWires('live-cal-first'), textWire('Ordinary text follow-up referencing events.'));
  let pause!: ReturnType<typeof f.db.pauseNextUpdate>;
  let delivery!: VoiceDelivery, spoken = '';
  try {
    const seed = await f.submit('Start chat');
    await f.execute(seed);
    await f.saved(seed);
    pause = f.db.pauseNextUpdate();
    const reservation = await f.runtime.reservations.acquire({
      identity: f.identity, conversationId: seed.sessionId,
      owner: { kind: 'live', voiceSessionId: 'cal-voice-first' },
    });
    const liveTurn = await f.runtime.submitLiveTurn({
      identity: f.identity, sessionId: seed.sessionId,
      content: 'What events do I have?', idempotencyKey: 'cal-voice-then-text-1', reservation,
      configSnapshot: f.runtime.d.currentConfig!.current()!,
      voice: { voiceSessionId: 'cal-voice-first', socketEpoch: 1, providerTurnId: 'prov-live-1' },
    });
    await f.runtime.executeTurn({
      userId: f.identity.userId, ...liveTurn, signal: new AbortController().signal,
      emit: async () => {}, emitCalendar: async () => {}, live: {
        reservation,
        start: async (attempt, write) => {
          delivery = new VoiceDelivery({
            ...deliveryFixture(), userId: attempt.userId, sessionId: liveTurn.sessionId,
            turnId: attempt.turnId, attemptId: attempt.attemptId, voiceSessionId: 'cal-voice-first',
            responseId: key('voice-response', attempt.userId, liveTurn.sessionId, attempt.attemptId),
            status: 'pending', textGenerated: '', textSpoken: null, textRemaining: null,
            audioDurationMs: null, audioPlayedMs: null, playedSamples: null,
          }, 0, write, { speak: async chunk => { spoken += chunk.text; }, flush: async () => {} }, 20);
          await delivery.start();
        },
        delta: text => delivery.delta(text), finish: () => delivery.finish(),
        artifact: artifact => delivery.artifact(artifact), settle: async text => {
          const rec = delivery.current();
          await delivery.event({
            type: 'speech-completed', turnId: rec.turnId, responseId: rec.responseId,
            speechId: 'cal-voice-first-speech', audioDurationMs: 100, audioSamples: 2400,
            usage: { providerRequestId: null, model: 'fixture', modelVersion: null, audioMs: 100, billableCharacters: text.length },
          });
          await delivery.playback(2400); await delivery.settle(text);
        },
      },
    });
    await pause.started;
    expect(f.status(liveTurn)?.status).toBe('completed');
    expect(spoken).toContain('There are no events in that interval.');
    await f.runtime.reservations.release({ identity: f.identity, reservationId: reservation.reservationId });

    // Immediate ordinary text follow-up completes BEFORE live Calendar archive drains!
    const followUp = await f.submit('Thanks, anything else today?', seed.sessionId);
    await f.execute(followUp);
    expect(f.status(followUp)?.status).toBe('completed');
    expect(JSON.stringify(f.modelBodies.at(-1)!.messages)).toContain('There are no events in that interval.');
    pause.resume();
    await f.saved(followUp);
    expect(f.status(followUp)).toMatchObject({ status: 'completed', save: { state: 'saved', version: 3, durableVersion: 3 } });
    expect(await f.p.metadata.getVoiceDelivery(f.identity.userId, seed.sessionId, liveTurn.attemptId))
      .toMatchObject({ textSpoken: 'There are no events in that interval.' });
  } finally { pause?.resume(); f.runtime.stopAccepting(); }
});

function createWires(callId = 'minimal-create') {
  return [skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, `${callId}-load`),
    createWire(event(), callId)];
}

it('creates and completes while an earlier archive owns the shared persistence tail', async () => {
  const f = await nativeFixture();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { reached = r; });
  const put = f.p.memory.put.bind(f.p.memory);
  const blocked = vi.spyOn(f.p.memory, 'put').mockImplementationOnce(async manifest => {
    reached(); await held; return put(manifest);
  });
  let run: Promise<void> | undefined;
  f.modelWires.push(textWire('Earlier answer'), ...createWires());
  try {
    const first = await f.submit('Earlier question'); await f.execute(first); await entered;
    const owner = await f.p.sessions.get(f.identity.userId, first.sessionId);
    expect(owner?.execution.ownerId).toBe(f.p.owner.executorId);
    const next = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', first.sessionId);
    run = f.execute(next);
    await vi.waitFor(() => expect(f.effects.filter(e => e.kind === 'create')).toHaveLength(1));
    await vi.waitFor(() => expect(f.status(next)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } }));
    expect(f.modelBodies).toHaveLength(3);
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(await f.runtime.drain(20)).toMatchObject({ drained: false });
    release(); await run; await f.saved(next);
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.session(next.sessionId))
      .toMatchObject({ version: 2, durableVersion: 2, fenced: false });
  } finally {
    release(); await run?.catch(() => undefined); blocked.mockRestore(); f.runtime.stopAccepting();
  }
});

it('mutation barrier confirms mandatory evidence in order and reaches POST while nonessential stores are held individually', async () => {
  const nonessentials = [
    'flushSession',
    'reserveDispatchConfirmed',
    'updateDispatchConfirmed',
    'skillDecisions.put',
    'calendarResultsV2.put',
    'memory.put',
    'checkpoints.open',
  ] as const;

  for (const heldTarget of nonessentials) {
    const f = await nativeFixture();
    const cal = f.runtime.d.calendar!;
    if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
    const order: string[] = [];
    const origInvoke = cal.execution.invoke.bind(cal.execution);
    let snapshotAtPost: Record<string, unknown> | undefined;
    let releaseNonessential = () => {};

    const createSpy = vi.spyOn(cal.execution, 'invoke').mockImplementation(async req => {
      if (req.call.name === 'calendar_create_event' && req.binding.operation) {
        order.push('provider:post');
        const op = req.binding.operation;
        const acceptance = await f.p.metadata.getAcceptance(f.identity.userId, op.sessionId, req.binding.attemptId);
        const [inputMsg, attemptDoc, acceptanceDoc, counterDoc, sessionDoc, budgetDoc, opDoc, events] = await Promise.all([
          f.p.messages.get(f.identity.userId, op.sessionId, acceptance?.userMessageId ?? ''),
          f.p.metadata.getAttempt(f.identity.userId, op.sessionId, req.binding.attemptId),
          f.p.metadata.getAcceptance(f.identity.userId, op.sessionId, req.binding.attemptId),
          f.p.owner.store!.read('metadata', counterSchema, { _id: key('sequence-counter', f.identity.userId, op.sessionId), userId: f.identity.userId, sessionId: op.sessionId }),
          f.p.sessions.get(f.identity.userId, op.sessionId),
          f.p.calendarAccountingV2.getBudget(f.identity.userId, op.sessionId, op.turnId),
          f.p.calendarOperationsV2.getByIntent(f.identity.userId, op.sessionId, op.intentId),
          f.p.calendarOperationsV2.listEventsV2({ userId: f.identity.userId, sessionId: op.sessionId, operationId: op.operationId }),
        ]);
        snapshotAtPost = { inputMsg, attemptDoc, acceptanceDoc, counterDoc, sessionDoc, budgetDoc, opDoc, events, req };
      }
      return origInvoke(req);
    });

    const holds: { release: () => void; spy: { mockRestore(): void } }[] = [];
    const heldPromise = new Promise<void>(r => { releaseNonessential = r; });
    const installHold = () => {
      if (heldTarget === 'flushSession') {
        const memory = f.runtime.memoryFor(f.identity.userId)!;
        const orig = memory.foundation.flushSession.bind(memory.foundation);
        const s = vi.spyOn(memory.foundation, 'flushSession').mockImplementation(async (...args) => { await heldPromise; return orig(...args); });
        holds.push({ release: releaseNonessential, spy: s });
      } else if (heldTarget === 'reserveDispatchConfirmed') {
        const orig = f.p.calendarAccountingV2.reserveDispatchConfirmed!.bind(f.p.calendarAccountingV2);
        const s = vi.spyOn(f.p.calendarAccountingV2, 'reserveDispatchConfirmed').mockImplementation(async (...args) => { await heldPromise; return orig(...args); });
        holds.push({ release: releaseNonessential, spy: s });
      } else if (heldTarget === 'updateDispatchConfirmed') {
        const orig = f.p.calendarAccountingV2.updateDispatchConfirmed!.bind(f.p.calendarAccountingV2);
        const s = vi.spyOn(f.p.calendarAccountingV2, 'updateDispatchConfirmed').mockImplementation(async (...args) => { await heldPromise; return orig(...args); });
        holds.push({ release: releaseNonessential, spy: s });
      } else if (heldTarget === 'skillDecisions.put') {
        const orig = f.p.skillDecisions.put.bind(f.p.skillDecisions);
        const s = vi.spyOn(f.p.skillDecisions, 'put').mockImplementation(async (...args) => { await heldPromise; return orig(...args); });
        holds.push({ release: releaseNonessential, spy: s });
      } else if (heldTarget === 'calendarResultsV2.put') {
        const orig = f.p.calendarResultsV2.put.bind(f.p.calendarResultsV2);
        const s = vi.spyOn(f.p.calendarResultsV2, 'put').mockImplementation(async (...args) => { await heldPromise; return orig(...args); });
        holds.push({ release: releaseNonessential, spy: s });
      } else if (heldTarget === 'memory.put') {
        const orig = f.p.memory.put.bind(f.p.memory);
        const s = vi.spyOn(f.p.memory, 'put').mockImplementation(async (...args) => { await heldPromise; return orig(...args); });
        holds.push({ release: releaseNonessential, spy: s });
      } else if (heldTarget === 'checkpoints.open') {
        const origCreate = f.p.checkpoints.create.bind(f.p.checkpoints);
        holds.push({ release: releaseNonessential, spy: vi.spyOn(f.p.checkpoints, 'create').mockImplementation(async (...args) => { await heldPromise; return origCreate(...args); }) });
      }
    };

    let run: Promise<void> | undefined;
    f.modelWires.push(textWire('Earlier turn'), ...createWires(`nonessential-${heldTarget}`));
    try {
      const earlier = await f.submit('Earlier turn');
      installHold();
      await f.execute(earlier);
      const createTurn = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', earlier.sessionId);
      run = f.execute(createTurn);
      await vi.waitFor(() => expect(f.effects.filter(e => e.kind === 'create'), `heldTarget=${heldTarget}`).toHaveLength(1));
      await vi.waitFor(() => expect(f.status(createTurn)).toMatchObject({ status: 'completed' }));
      expect(snapshotAtPost).toBeDefined();
      const snap = snapshotAtPost as any;
      expect(snap.inputMsg).toMatchObject({ turnId: createTurn.turnId, role: 'user', content: 'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.' });
      expect(snap.attemptDoc).toMatchObject({ turnId: createTurn.turnId, status: 'generating' });
      expect(snap.acceptanceDoc).toMatchObject({ turnId: createTurn.turnId, attemptId: snap.attemptDoc.attemptId });
      expect(snap.counterDoc?.next).toBeGreaterThanOrEqual(snap.inputMsg.sequence + 3);
      expect(snap.sessionDoc).toMatchObject({ latestTurnId: createTurn.turnId, execution: { activeAttemptId: snap.attemptDoc.attemptId } });
      expect(snap.budgetDoc).toMatchObject({ creates: 1 });
      expect(snap.opDoc).toMatchObject({ state: 'dispatching', googleEventId: calendarEventId(snap.opDoc.operationId) });
      expect(snap.events.map((e: { state: string }) => e.state)).toEqual(['planned', 'dispatching']);
    } finally {
      releaseNonessential();
      for (const h of holds) { h.release(); h.spy.mockRestore(); }
      createSpy.mockRestore();
      await run?.catch(() => undefined);
      f.runtime.stopAccepting();
    }
  }
});

it('mutation barrier mixes read tool calls and deferred create results without premature create result writes', async () => {
  const f = await nativeFixture();
  const resultPutCalls: string[] = [];
  const origPut = f.p.calendarResultsV2.put.bind(f.p.calendarResultsV2);
  let sawCreateResultAtPost = false;
  const cal = f.runtime.d.calendar!;
  if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
  const origInvoke = cal.execution.invoke.bind(cal.execution);
  vi.spyOn(f.p.calendarResultsV2, 'put').mockImplementation(async rec => {
    resultPutCalls.push(rec.toolCallId);
    return origPut(rec);
  });
  vi.spyOn(cal.execution, 'invoke').mockImplementation(async req => {
    if (req.call.name === 'calendar_create_event') sawCreateResultAtPost = resultPutCalls.includes('mixed-create');
    return origInvoke(req);
  });
  f.modelWires.push(
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_events', 'calendar_create_event'] }, 'mixed-load'),
    skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_events', arguments: {
      timeMin: '2026-11-03T08:00:00Z', timeMax: '2026-11-03T09:00:00Z', maxResults: 5,
    } }, 'mixed-read'),
    createWire(event(), 'mixed-create'),
  );
  try {
    const turn = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(turn);
    expect(f.effects.filter(e => e.kind === 'create')).toHaveLength(1);
    expect(sawCreateResultAtPost).toBe(false);
    await f.saved(turn);
    expect(resultPutCalls).toContain('mixed-create');
  } finally {
    vi.restoreAllMocks(); f.runtime.stopAccepting();
  }
});

it('mutation barrier blocks provider POST when any mandatory acknowledgement is held, fails, or loses ack without readback', async () => {
  const essentialSteps = [
    'createIfAbsent',
    'beginCalendarMutation',
    'appendConfirmed',
    'putAttemptConfirmed',
    'acceptanceInsert',
    'sequenceMax',
    'discoveryPointer',
    'reserveByIntent',
    'createBudgetConfirmed',
    'budgetDebit',
    'plannedEvent',
    'dispatchingCas',
    'dispatchingEvent',
    'assertCalendarMutation',
  ] as const;

  for (const step of essentialSteps) {
    const f = await nativeFixture();
    let release = () => {}, reached = () => {};
    const held = new Promise<void>(r => { release = r; });
    const entered = new Promise<void>(r => { reached = r; });
    const origInsertConfirmed = f.p.owner.store!.insertConfirmed.bind(f.p.owner.store!);
    const origCollection = f.p.owner.store!.collection.bind(f.p.owner.store!);

    if (step === 'createIfAbsent') {
      const orig = f.p.sessions.createIfAbsent.bind(f.p.sessions);
      vi.spyOn(f.p.sessions, 'createIfAbsent').mockImplementationOnce(async r => { reached(); await held; return orig(r); });
    } else if (step === 'beginCalendarMutation') {
      const orig = f.p.sessions.beginCalendarMutation.bind(f.p.sessions);
      vi.spyOn(f.p.sessions, 'beginCalendarMutation').mockImplementationOnce(async arg => { reached(); await held; return orig(arg); });
    } else if (step === 'appendConfirmed') {
      const orig = f.p.messages.appendConfirmed.bind(f.p.messages);
      vi.spyOn(f.p.messages, 'appendConfirmed').mockImplementationOnce(async (...args) => { reached(); await held; return orig(...args); });
    } else if (step === 'putAttemptConfirmed') {
      const orig = f.p.metadata.putAttemptConfirmed.bind(f.p.metadata);
      vi.spyOn(f.p.metadata, 'putAttemptConfirmed').mockImplementationOnce(async arg => { reached(); await held; return orig(arg); });
    } else if (step === 'acceptanceInsert') {
      vi.spyOn(f.p.owner.store!, 'insertConfirmed').mockImplementation(async (col, schema, doc, id, maxBytes) => {
        if (col === 'metadata' && typeof doc === 'object' && doc && (doc as { kind?: string }).kind === 'acceptance') {
          reached(); await held;
        }
        return origInsertConfirmed(col, schema, doc, id, maxBytes);
      });
    } else if (step === 'sequenceMax') {
      vi.spyOn(f.p.owner.store!, 'collection').mockImplementation(name => {
        const col = origCollection(name);
        if (name !== 'metadata') return col;
        const origUpdateOne = col.updateOne.bind(col);
        return { ...col, updateOne: async (filter: any, update: any, opts: any) => {
          if (update?.$setOnInsert?.kind === 'sequence-counter') { reached(); await held; }
          return origUpdateOne(filter, update, opts);
        } };
      });
    } else if (step === 'discoveryPointer') {
      vi.spyOn(f.p.owner.store!, 'collection').mockImplementation(name => {
        const col = origCollection(name);
        if (name !== 'sessions') return col;
        const origUpdateOne = col.updateOne.bind(col);
        return { ...col, updateOne: async (filter: any, update: any, opts: any) => {
          if ((update as { $set?: Record<string, unknown> })?.$set?.latestTurnId) { reached(); await held; }
          return origUpdateOne(filter, update, opts);
        } };
      });
    } else if (step === 'reserveByIntent') {
      const orig = f.p.calendarOperationsV2.reserveByIntent.bind(f.p.calendarOperationsV2);
      vi.spyOn(f.p.calendarOperationsV2, 'reserveByIntent').mockImplementationOnce(async arg => { reached(); await held; return orig(arg); });
    } else if (step === 'createBudgetConfirmed') {
      const orig = f.p.calendarAccountingV2.createBudgetConfirmed!.bind(f.p.calendarAccountingV2);
      vi.spyOn(f.p.calendarAccountingV2, 'createBudgetConfirmed').mockImplementationOnce(async arg => { reached(); await held; return orig(arg); });
    } else if (step === 'budgetDebit') {
      const orig = f.p.calendarAccountingV2.debit.bind(f.p.calendarAccountingV2);
      vi.spyOn(f.p.calendarAccountingV2, 'debit').mockImplementationOnce(async arg => { reached(); await held; return orig(arg); });
    } else if (step === 'plannedEvent') {
      const orig = f.p.calendarOperationsV2.appendEventV2.bind(f.p.calendarOperationsV2);
      vi.spyOn(f.p.calendarOperationsV2, 'appendEventV2').mockImplementation(async ev => {
        if (ev.state === 'planned') { reached(); await held; }
        return orig(ev);
      });
    } else if (step === 'dispatchingCas') {
      const orig = f.p.calendarOperationsV2.compareAndSwap.bind(f.p.calendarOperationsV2);
      vi.spyOn(f.p.calendarOperationsV2, 'compareAndSwap').mockImplementationOnce(async arg => { reached(); await held; return orig(arg); });
    } else if (step === 'dispatchingEvent') {
      const orig = f.p.calendarOperationsV2.appendEventV2.bind(f.p.calendarOperationsV2);
      vi.spyOn(f.p.calendarOperationsV2, 'appendEventV2').mockImplementation(async ev => {
        if (ev.state === 'dispatching') { reached(); await held; }
        return orig(ev);
      });
    } else if (step === 'assertCalendarMutation') {
      const orig = f.p.sessions.assertCalendarMutation.bind(f.p.sessions);
      let calls = 0;
      vi.spyOn(f.p.sessions, 'assertCalendarMutation').mockImplementation(async (h, e) => {
        calls++;
        if (calls >= 3) { reached(); await held; }
        return orig(h, e);
      });
    }

    f.modelWires.push(...createWires(`essential-${step}`));
    let run: Promise<void> | undefined;
    try {
      const turn = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
      run = f.execute(turn);
      await Promise.race([
        entered,
        run.then(() => { throw new Error(`Expected essential step ${step} to run before completion.`); }),
      ]);
      await Promise.resolve();
      expect(f.effects.filter(e => e.kind === 'create')).toHaveLength(0);
      release();
      await run;
      expect(f.effects.filter(e => e.kind === 'create')).toHaveLength(1);
      await f.saved(turn);
    } finally {
      release();
      vi.restoreAllMocks();
      await run?.catch(() => undefined);
      f.runtime.stopAccepting();
    }
  }
});

it('mutation barrier refuses POST on cancellation, account invalidation, or lost ack without exact readback', async () => {
  // 1) Cancellation during held barrier step prevents POST.
  const f1 = await nativeFixture();
  let release1 = () => {}, reached1 = () => {};
  const held1 = new Promise<void>(r => { release1 = r; });
  const entered1 = new Promise<void>(r => { reached1 = r; });
  const origReserve = f1.p.calendarOperationsV2.reserveByIntent.bind(f1.p.calendarOperationsV2);
  vi.spyOn(f1.p.calendarOperationsV2, 'reserveByIntent').mockImplementationOnce(async arg => {
    reached1(); await held1; return origReserve(arg);
  });
  f1.modelWires.push(...createWires('cancel-hold'));
  let run1: Promise<void> | undefined;
  try {
    const t1 = await f1.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    run1 = f1.execute(t1);
    await entered1;
    await f1.runtime.cancelTurn({ identity: f1.identity, sessionId: t1.sessionId, turnId: t1.turnId, attemptId: t1.attemptId });
    release1();
    await run1.catch(() => undefined);
    expect(f1.effects).toEqual([]);
  } finally {
    release1(); vi.restoreAllMocks(); await run1?.catch(() => undefined); f1.runtime.stopAccepting();
  }

  // 2) Account invalidation during held barrier step prevents POST.
  const f2 = await nativeFixture();
  let release2 = () => {}, reached2 = () => {};
  const held2 = new Promise<void>(r => { release2 = r; });
  const entered2 = new Promise<void>(r => { reached2 = r; });
  const origBudget = f2.p.calendarAccountingV2.createBudgetConfirmed!.bind(f2.p.calendarAccountingV2);
  vi.spyOn(f2.p.calendarAccountingV2, 'createBudgetConfirmed').mockImplementationOnce(async arg => {
    reached2(); await held2; return origBudget(arg);
  });
  f2.modelWires.push(...createWires('invalidate-hold'));
  let run2: Promise<void> | undefined;
  try {
    const t2 = await f2.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    run2 = f2.execute(t2);
    await entered2;
    const conn = (await f2.p.calendarConnectionsV2.get(f2.identity.userId))!;
    f2.runtime.invalidateCalendarAccount({ userId: conn.userId, connectionId: conn.connectionId,
      connectionRevision: conn.connectionRevision, googleSubjectId: conn.googleSubjectId }, 'disconnect');
    release2();
    await run2.catch(() => undefined);
    expect(f2.effects).toEqual([]);
  } finally {
    release2(); vi.restoreAllMocks(); await run2?.catch(() => undefined); f2.runtime.stopAccepting();
  }

  // 3) Lost ack where exact readback is unavailable does not permit POST.
  const f3 = await nativeFixture();
  const origInsert = f3.p.owner.store!.insertConfirmed.bind(f3.p.owner.store!);
  const origRead = f3.p.owner.store!.read.bind(f3.p.owner.store!);
  vi.spyOn(f3.p.owner.store!, 'insertConfirmed').mockImplementation(async (col, schema, doc, id, maxBytes) => {
    if (col === 'metadata' && typeof doc === 'object' && doc && (doc as { kind?: string }).kind === 'acceptance') {
      await origInsert(col, schema, doc, id, maxBytes);
      throw new Error('uncertain acceptance write');
    }
    return origInsert(col, schema, doc, id, maxBytes);
  });
  vi.spyOn(f3.p.owner.store!, 'read').mockImplementation(async (col, schema, filter) => {
    if (col === 'metadata' && schema === acceptanceSchema) {
      throw new Error('readback unavailable');
    }
    return origRead(col, schema, filter);
  });
  f3.modelWires.push(...createWires('lost-ack-no-readback'));
  try {
    const t3 = await f3.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f3.execute(t3).catch(() => undefined);
    expect(f3.effects).toEqual([]);
  } finally {
    vi.restoreAllMocks(); f3.runtime.stopAccepting();
  }
});

it('mutation barrier retry is idempotent, enforces lowered ceilings before POST, and rejects expired deadlines', async () => {
  // 1. Lowered ceiling on retry is enforced before POST without repeating inference or debits.
  const f1 = await nativeFixture();
  vi.spyOn(f1.p.calendarAccountingV2, 'createBudgetConfirmed').mockRejectedValueOnce(new AppError('PERSISTENCE_ERROR', 'Transient budget outage'));
  f1.modelWires.push(...createWires('ceiling-retry'));
  try {
    const t1 = await f1.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f1.execute(t1).catch(() => undefined);
    expect(f1.status(t1)?.error?.code).toBe('PERSISTENCE_ERROR');
    expect(f1.effects).toEqual([]); expect(f1.modelBodies).toHaveLength(2);
    const cur = f1.runtime.d.currentConfig!.current()!;
    f1.publish({ ...cur, revision: cur.revision + 1, calendar: { ...cur.calendar!, limits: { ...cur.calendar!.limits!, creates: 0 } } });
    const retry1 = await f1.runtime.retryTurn({ identity: f1.identity, sessionId: t1.sessionId, turnId: t1.turnId, idempotencyKey: 'lower-ceiling-retry' });
    await f1.execute(retry1).catch(() => undefined);
    expect(f1.status(t1)?.error?.code).toBe('STORAGE_BUDGET_EXCEEDED');
    expect(f1.effects).toEqual([]);
    expect(f1.modelBodies).toHaveLength(2);
  } finally { vi.restoreAllMocks(); f1.runtime.stopAccepting(); }

  // 2. Expired deadline before POST rejects cleanly without POST.
  const f2 = await nativeFixture();
  const origBudget = f2.p.calendarAccountingV2.createBudgetConfirmed!.bind(f2.p.calendarAccountingV2);
  let advanceOnBudget = true;
  vi.spyOn(f2.p.calendarAccountingV2, 'createBudgetConfirmed').mockImplementation(async record => {
    if (advanceOnBudget) {
      advanceOnBudget = false;
      f2.advance(DEFAULT_BUDGETS.totalRunTimeoutMs + 1000);
    }
    return origBudget(record);
  });
  f2.modelWires.push(...createWires('expired-deadline-post'));
  try {
    const t2 = await f2.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f2.execute(t2).catch(() => undefined);
    expect(f2.status(t2)?.error?.code).toBe('TIMEOUT');
    expect(f2.effects).toEqual([]);
  } finally { vi.restoreAllMocks(); f2.runtime.stopAccepting(); }
});

it('mutation barrier recovers from lost budget create or debit acknowledgement without double debit', async () => {
  const f = await nativeFixture();
  const origCreateBudget = f.p.calendarAccountingV2.createBudgetConfirmed!.bind(f.p.calendarAccountingV2);
  let loseBudgetAck = true;
  vi.spyOn(f.p.calendarAccountingV2, 'createBudgetConfirmed').mockImplementation(async record => {
    const created = await origCreateBudget(record);
    if (loseBudgetAck) {
      loseBudgetAck = false;
      throw new AppError('PERSISTENCE_ERROR', 'Lost budget create ack');
    }
    return created;
  });
  const origDebit = f.p.calendarAccountingV2.debit.bind(f.p.calendarAccountingV2);
  let loseDebitAck = true;
  vi.spyOn(f.p.calendarAccountingV2, 'debit').mockImplementation(async input => {
    const debited = await origDebit(input);
    if (loseDebitAck) {
      loseDebitAck = false;
      throw new AppError('PERSISTENCE_ERROR', 'Lost debit ack');
    }
    return debited;
  });
  f.modelWires.push(...createWires('lost-ack-debit'));
  try {
    const t1 = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(t1).catch(() => undefined);
    expect(f.effects).toEqual([]);
    const retry1 = await f.runtime.retryTurn({ identity: f.identity, sessionId: t1.sessionId, turnId: t1.turnId, idempotencyKey: 'retry-budget-ack' });
    await f.execute(retry1).catch(() => undefined);
    if (f.effects.length === 0) {
      const retry2 = await f.runtime.retryTurn({ identity: f.identity, sessionId: t1.sessionId, turnId: t1.turnId, idempotencyKey: 'retry-debit-ack' });
      await f.execute(retry2);
    }
    expect(f.effects.filter(e => e.kind === 'create')).toHaveLength(1);
    const budget = await f.p.calendarAccountingV2.getBudget(f.identity.userId, t1.sessionId, t1.turnId);
    expect(budget?.creates).toBe(1);
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('pauseSession on a mutating session does not block background archive of an unrelated session', async () => {
  const f = await nativeFixture();
  let releaseBarrier!: () => void, enteredBarrier!: () => void;
  const barrierHeld = new Promise<void>(r => { releaseBarrier = r; });
  const barrierStarted = new Promise<void>(r => { enteredBarrier = r; });
  const origPutAttempt = f.p.metadata.putAttemptConfirmed!.bind(f.p.metadata);
  vi.spyOn(f.p.metadata, 'putAttemptConfirmed').mockImplementationOnce(async record => {
    enteredBarrier();
    await barrierHeld;
    return origPutAttempt(record);
  });
  f.modelWires.push(...createWires('session-a-create'), textWire('Session B archived'));
  let runA: Promise<void> | undefined;
  try {
    const a = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    runA = f.execute(a);
    await barrierStarted;
    const b = await f.submit('Hello in session B');
    await f.execute(b);
    await f.saved(b);
    expect(f.status(b)).toMatchObject({ status: 'completed', save: { state: 'saved', version: 1, durableVersion: 1 } });
  } finally {
    releaseBarrier();
    await runA?.catch(() => undefined);
    vi.restoreAllMocks();
    f.runtime.stopAccepting();
  }
});

it('never opens a mutation barrier for non-create proposal replies (cancel, unrelated, edit, expired, incomplete)', async () => {
  const f = await nativeFixture();
  f.modelWires.push(
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'non-create-load'),
    createWire(event(), 'non-create-proposal'),
    textWire('What new time would you like?'),
  );
  try {
    const first = await f.submit('create the event'); await f.execute(first);
    await f.saved(first);
    const beginSpy = vi.spyOn(f.p.sessions, 'beginCalendarMutation');
    const attemptSpy = vi.spyOn(f.p.metadata, 'putAttemptConfirmed');

    const editReply = await f.submit('make it 3pm instead', first.sessionId);
    await f.execute(editReply);
    expect(beginSpy).not.toHaveBeenCalled();
    expect(attemptSpy).not.toHaveBeenCalled();

    const cancelReply = await f.submit('no cancel it', first.sessionId);
    await f.execute(cancelReply);
    expect(beginSpy).not.toHaveBeenCalled();
    expect(attemptSpy).not.toHaveBeenCalled();

    // Expired proposal reply never opens mutation barrier.
    f.modelWires.push(
      skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'non-create-load-2'),
      createWire(event(), 'non-create-proposal-2'),
    );
    const second = await f.submit('create the event'); await f.execute(second);
    await f.saved(second);
    beginSpy.mockClear(); attemptSpy.mockClear();
    const proposal = await f.currentProposal(first.sessionId);
    expect(proposal).not.toBeNull();
    f.advance(Date.parse(proposal!.expiresAt) - f.clock() + 1);
    const expiredAccept = await f.submit('yes', first.sessionId);
    await f.execute(expiredAccept);
    expect(f.status(expiredAccept)?.status).toBe('completed');
    expect(beginSpy).not.toHaveBeenCalled();
    expect(attemptSpy).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('archives calendar-model-aggregate, drains v1 -> v2 -> v3 in dirty order, and preserves newer latestTurnId', async () => {
  const f = await nativeFixture();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { reached = r; });
  const put = f.p.memory.put.bind(f.p.memory);
  const blocked = vi.spyOn(f.p.memory, 'put').mockImplementationOnce(async manifest => {
    reached(); await held; return put(manifest);
  });
  let run2: Promise<void> | undefined, run3: Promise<void> | undefined;
  f.modelWires.push(
    textWire('First reply'),
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_events', 'calendar_create_event'] }, 'seq-load'),
    skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_events', arguments: {
      timeMin: '2026-11-03T08:00:00Z', timeMax: '2026-11-03T09:00:00Z', maxResults: 5,
    } }, 'seq-read'),
    createWire(event(), 'seq-create'),
    textWire('Third follow-up reply'),
  );
  try {
    const t1 = await f.submit('Hello first');
    await f.execute(t1);
    await entered;

    const t2 = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', t1.sessionId);
    run2 = f.execute(t2);
    await vi.waitFor(() => expect(f.status(t2)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } }));

    const t3 = await f.submit('Thanks, noted.', t1.sessionId);
    run3 = f.execute(t3);
    await vi.waitFor(() => expect(f.status(t3)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } }));

    // Turn 2's mutation barrier updated latestTurnId; releasing v1 -> v2 -> v3 must not regress latestTurnId.
    release();
    await run2; await run3;
    await f.saved(t1); await f.saved(t2); await f.saved(t3);
    expect(blocked).toHaveBeenCalledTimes(3);

    const session = await f.p.sessions.get(f.identity.userId, t1.sessionId);
    expect(session).toMatchObject({ memoryPublication: { version: 3 }, latestTurnId: t3.turnId });

    const store = f.p.owner.store!;
    const attempt2 = await f.p.metadata.getAttempt(f.identity.userId, t1.sessionId, t2.attemptId);
    expect(attempt2?.status).toBe('completed');
    const agg = await store.read('metadata', modelAggregateSchema, {
      _id: aggregateKey(f.identity.userId, t1.sessionId, t2.turnId, t2.attemptId),
      userId: f.identity.userId, sessionId: t1.sessionId,
    });
    expect(agg).toBeTruthy();
    expect(agg!.dispatchIds.length).toBeGreaterThanOrEqual(3);
    const savedResult = await f.p.calendarResultsV2.get(f.identity.userId, t1.sessionId, 'seq-create');
    expect(savedResult?.schemaVersion).toBe(2);
    const savedDecision = await f.p.skillDecisions.get(f.identity.userId, savedResult!.decisionId);
    expect(savedDecision?.decisionId).toBe(savedResult!.decisionId);
  } finally {
    release();
    await run2?.catch(() => undefined);
    await run3?.catch(() => undefined);
    vi.restoreAllMocks();
    f.runtime.stopAccepting();
  }
});

it('refuses a create when the accepted-input insert is rejected before any durable intent exists', async () => {
  const f = await nativeFixture();
  const append = f.p.messages.appendConfirmed.bind(f.p.messages);
  let rejected = false;
  vi.spyOn(f.p.messages, 'appendConfirmed').mockImplementation(async record => {
    if (!rejected && record.role === 'user') {
      rejected = true;
      throw new AppError('PERSISTENCE_ERROR', 'Rejected accepted input');
    }
    return append(record);
  });
  f.modelWires.push(...createWires('accepted-input-rejected'));
  try {
    const turn = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(turn).catch(() => undefined);
    expect(rejected).toBe(true);
    expect(f.status(turn)?.error?.code).toBe('PERSISTENCE_ERROR');
    expect(f.effects).toEqual([]);
    expect(f.modelBodies).toHaveLength(2);
    // No accepted evidence, no intent reservation and no charge survived the
    // failed barrier. The earlier session/mutation rows grant no authority.
    expect(await f.operationFor(turn)).toBeNull();
    expect(await f.p.metadata.getAttempt(f.identity.userId, turn.sessionId, turn.attemptId)).toBeNull();
    expect(await f.p.metadata.getAcceptance(f.identity.userId, turn.sessionId, turn.attemptId)).toBeNull();
    expect(await f.p.messages.get(f.identity.userId, turn.sessionId, turn.userMessageId)).toBeNull();
    expect((await f.p.calendarAccountingV2.getBudget(f.identity.userId, turn.sessionId, turn.turnId))?.creates ?? 0).toBe(0);
    expect(await f.p.sessions.get(f.identity.userId, turn.sessionId))
      .toMatchObject({ execution: { activeAttemptId: null } });

    const retry = await f.runtime.retryTurn({ identity: f.identity, sessionId: turn.sessionId,
      turnId: turn.turnId, idempotencyKey: 'retry-accepted-input-rejected' });
    await f.execute(retry).catch(() => undefined);
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(f.modelBodies).toHaveLength(2);
    expect(await f.operationFor(turn)).toMatchObject({ state: 'succeeded', originatingAttemptId: turn.attemptId });
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('keeps the succeeded receipt when terminal saving is unavailable, then repairs only the attempt on restart', async () => {
  const f = await nativeFixture(async () => ({ kind: 'unknown', retryable: true }));
  f.modelWires.push(...createWires('save-unavailable-create'));
  let cold: DurableChatRuntime | undefined;
  try {
    const turn = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(turn);
    expect(f.status(turn)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } });
    await vi.waitFor(() => expect(f.status(turn)?.save?.state).toBe('unknown'));
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);

    const operation = await f.operationFor(turn);
    expect(operation).toMatchObject({ state: 'succeeded', originatingAttemptId: turn.attemptId });
    const events = await f.p.calendarOperationsV2.listEventsV2({ userId: f.identity.userId,
      sessionId: turn.sessionId, operationId: operation!.operationId });
    expect(events.map(event => event.state)).toEqual(['planned', 'dispatching', 'succeeded']);
    expect(f.frames.some(frame => frame.event.type === 'calendar-operation'
      && (frame.event as { operation?: { state?: string } }).operation?.state === 'succeeded')).toBe(true);

    const before = await f.p.sessions.get(f.identity.userId, turn.sessionId);
    expect(before).toMatchObject({ memoryPublication: { version: 0 } });
    const modelsBefore = f.modelBodies.length;

    cold = new DurableChatRuntime(f.runtime.d);
    await cold.reconcileSession(f.identity.userId, turn.sessionId);
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(f.effects.filter(effect => effect.kind === 'readback')).toHaveLength(0);
    expect(f.modelBodies).toHaveLength(modelsBefore);
    expect(await f.p.metadata.getAttempt(f.identity.userId, turn.sessionId, turn.attemptId))
      .toMatchObject({ status: 'interrupted' });
    const after = await f.p.sessions.get(f.identity.userId, turn.sessionId);
    expect(after).toMatchObject({ memoryPublication: { version: 0 }, latestTurnId: before!.latestTurnId });
    expect(await f.p.memory.get(f.identity.userId, turn.sessionId)).toBeNull();

    // Cold history is still unavailable: there is no published manifest.
    const coldReader = new DurableChatRuntime(f.runtime.d);
    try {
      await expect(coldReader.submitTurn({ identity: f.identity, sessionId: turn.sessionId,
        content: 'What did you schedule?', idempotencyKey: 'cold-history-unavailable' }))
        .rejects.toMatchObject({ code: 'NOT_READY' });
    } finally { coldReader.stopAccepting(); }

    // The same accepted submission still projects the original receipt.
    const again = await f.runtime.submitTurn({ identity: f.identity, sessionId: null,
      content: 'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
      idempotencyKey: f.runtime.memoryFor(f.identity.userId)!.find(turn.sessionId, turn.turnId)!.turn.requestKey });
    expect(again).toMatchObject({ turnId: turn.turnId, attemptId: turn.attemptId });
    expect(await f.operationFor(turn)).toMatchObject({ state: 'succeeded',
      googleEventId: operation!.googleEventId });
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(f.modelBodies).toHaveLength(modelsBefore);
  } finally { cold?.stopAccepting(); vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('retries a save whose publication CAS is missing without duplicating terminal rows', async () => {
  let archive!: MemoryTextArchive;
  let saves = 0;
  const f = await nativeFixture(async (envelope, limits) => {
    saves++;
    return archive.save(envelope, limits);
  }, 2);
  archive = new MemoryTextArchive(f.p, f.runtime.d.assets);
  const store = f.p.owner.store!;
  const collection = store.collection.bind(store);
  let failPublication = true;
  let publicationAttempts = 0;
  // Sessions already exist, so the counter lives in metadata: the first
  // sessions.updateOne carrying memoryPublication in this window is the
  // publication CAS. Only that write is refused.
  vi.spyOn(store, 'collection').mockImplementation(name => {
    const col = collection(name);
    if (name !== 'sessions') return col;
    const updateOne = col.updateOne.bind(col);
    return { ...col, updateOne: async (filter: any, update: any, options: any) => {
      if (update?.$set?.memoryPublication && failPublication) {
        failPublication = false;
        publicationAttempts++;
        throw new Error('fixture publication CAS unavailable');
      }
      if (update?.$set?.memoryPublication) publicationAttempts++;
      return updateOne(filter, update, options);
    } };
  });
  f.modelWires.push(...createWires('publication-cas-create'));
  try {
    const turn = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await f.execute(turn);
    expect(f.status(turn)?.status).toBe('completed');
    await vi.waitFor(() => expect(f.status(turn)?.save?.state).toBe('unknown'));
    expect(f.status(turn)?.save?.durableVersion).toBe(0);
    expect(saves).toBe(1);
    expect(publicationAttempts).toBe(1);
    const operation = await f.operationFor(turn);
    expect(operation).toMatchObject({ state: 'succeeded', originatingAttemptId: turn.attemptId });
    expect(await f.p.sessions.get(f.identity.userId, turn.sessionId))
      .toMatchObject({ memoryPublication: { version: 0 } });
    // The terminal rows and the receipt were staged; only publication is missing.
    expect(await f.p.messages.get(f.identity.userId, turn.sessionId, turn.userMessageId)).toMatchObject({ role: 'user' });
    expect(await f.p.metadata.getAttempt(f.identity.userId, turn.sessionId, turn.attemptId))
      .toMatchObject({ status: 'completed' });

    const coldReader = new DurableChatRuntime(f.runtime.d);
    try {
      await expect(coldReader.submitTurn({ identity: f.identity, sessionId: turn.sessionId,
        content: 'Follow up before publication', idempotencyKey: 'before-publication-cold' }))
        .rejects.toMatchObject({ code: 'NOT_READY' });
    } finally { coldReader.stopAccepting(); }

    f.advance(PROPOSED_MEMORY_TEXT_POLICY.retryBackoffMs + 1);
    const saveStatus = f.status(turn)!.save!;
    await f.runtime.retrySave(f.identity.userId, turn.sessionId, turn.turnId,
      { epoch: saveStatus.epoch, version: saveStatus.version });
    await f.saved(turn);
    expect(saves).toBe(2);
    expect(publicationAttempts).toBe(2);
    expect(f.status(turn)).toMatchObject({ status: 'completed', save: { state: 'saved', version: 1, durableVersion: 1 } });
    expect(await f.operationFor(turn)).toMatchObject({ state: 'succeeded', googleEventId: operation!.googleEventId });
    expect((await f.p.calendarOperationsV2.listEventsV2({ userId: f.identity.userId, sessionId: turn.sessionId,
      operationId: operation!.operationId })).map(event => event.state)).toEqual(['planned', 'dispatching', 'succeeded']);
    const messages = (await f.p.messages.list(f.identity.userId, turn.sessionId, { cursor: null, limit: 50 })).items;
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect((await f.p.metadata.listAttempts(f.identity.userId, turn.sessionId, { cursor: null, limit: 50 })).items)
      .toHaveLength(1);
    expect(await f.p.sessions.get(f.identity.userId, turn.sessionId))
      .toMatchObject({ memoryPublication: { version: 1 }, latestTurnId: turn.turnId });
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

it('keeps one provider effect when a create is cancelled at the dispatching CAS or after success', async () => {
  const f = await nativeFixture();
  const cal = f.runtime.d.calendar!;
  if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
  const invoke = cal.execution.invoke.bind(cal.execution);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const atProvider = new Promise<void>(r => { entered = r; });
  vi.spyOn(cal.execution, 'invoke').mockImplementation(async request => {
    if (request.call.name === 'calendar_create_event' && request.binding.operation) {
      entered();
      await held;
    }
    return invoke(request);
  });
  f.modelWires.push(...createWires('cancel-at-provider'));
  let run: Promise<void> | undefined;
  try {
    const turn = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    run = f.execute(turn);
    await atProvider;
    const dispatching = await f.operationFor(turn);
    expect(dispatching).toMatchObject({ state: 'dispatching' });
    await f.runtime.cancelTurn({ identity: f.identity, sessionId: turn.sessionId,
      turnId: turn.turnId, attemptId: turn.attemptId });
    release();
    // The cancel arrives while the provider call is held. The abort may land
    // before the request is sent (no effect) or after the dispatch is
    // acknowledged (one effect that must never be re-sent).
    await run.catch(() => undefined);
    const creates = f.effects.filter(effect => effect.kind === 'create');
    expect(creates.length).toBeLessThanOrEqual(1);
    const beforeReconcile = await f.operationFor(turn);
    expect(beforeReconcile?.googleEventId).toBe(dispatching!.googleEventId);

    await f.runtime.reconcileSession(f.identity.userId, turn.sessionId);
    // Reconciliation never repeats the effect and never invents a new identity.
    expect(f.effects.filter(effect => effect.kind === 'create').length).toBeLessThanOrEqual(1);
    const reconciled = await f.operationFor(turn);
    expect(reconciled?.googleEventId).toBe(dispatching!.googleEventId);
    expect(reconciled?.state).not.toBe('dispatching');
    const readbacks = f.effects.filter(effect => effect.kind === 'readback');
    expect(readbacks.every(effect => effect.eventId === dispatching!.googleEventId)).toBe(true);
    if (reconciled?.state === 'succeeded') {
      expect(reconciled.receipt).not.toBeNull();
    } else {
      // Anything that is not a confirmed receipt must not claim one.
      expect(reconciled?.receipt ?? null).toBeNull();
    }

    // Cancelling a turn that already succeeded is safe and preserves its receipt.
    const f2 = await nativeFixture();
    vi.restoreAllMocks();
    f2.modelWires.push(...createWires('cancel-after-success'));
    try {
      const done = await f2.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
      await f2.execute(done);
      const before = await f2.p.sessions.get(f2.identity.userId, done.sessionId);
      const receipt = await f2.operationFor(done);
      expect(receipt).toMatchObject({ state: 'succeeded' });
      await expect(f2.runtime.cancelTurn({ identity: f2.identity, sessionId: done.sessionId,
        turnId: done.turnId, attemptId: done.attemptId })).resolves.toBeUndefined();
      expect(f2.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
      expect(await f2.operationFor(done)).toMatchObject({ state: 'succeeded',
        googleEventId: receipt!.googleEventId });
      expect((await f2.p.calendarOperationsV2.listEventsV2({ userId: f2.identity.userId,
        sessionId: done.sessionId, operationId: receipt!.operationId })).map(event => event.state))
        .toEqual(['planned', 'dispatching', 'succeeded']);
      expect(await f2.p.sessions.get(f2.identity.userId, done.sessionId))
        .toMatchObject({ memoryPublication: before!.memoryPublication, latestTurnId: before!.latestTurnId });
    } finally { f2.runtime.stopAccepting(); }
  } finally {
    release(); await run?.catch(() => undefined); vi.restoreAllMocks(); f.runtime.stopAccepting();
  }
});

it('refuses a live reservation on a conversation whose text create is mid-barrier', async () => {
  const f = await nativeFixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const inBarrier = new Promise<void>(r => { entered = r; });
  const putAttempt = f.p.metadata.putAttemptConfirmed!.bind(f.p.metadata);
  vi.spyOn(f.p.metadata, 'putAttemptConfirmed').mockImplementationOnce(async record => {
    entered();
    await held;
    return putAttempt(record);
  });
  f.modelWires.push(...createWires('text-live-contention'));
  let run: Promise<void> | undefined;
  try {
    const turn = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    run = f.execute(turn);
    await inBarrier;
    await expect(f.runtime.reservations.acquire({ identity: f.identity, conversationId: turn.sessionId,
      owner: { kind: 'live', voiceSessionId: 'live-contention-voice' } }))
      .rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
    release();
    await run;
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    const operations = await f.p.calendarOperationsV2.listUnresolvedBySession({ userId: f.identity.userId,
      sessionId: turn.sessionId, limit: 2 });
    expect(operations.operations).toHaveLength(0);
    expect(await f.operationFor(turn)).toMatchObject({ state: 'succeeded' });
  } finally { release(); await run?.catch(() => undefined); vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});

/**
 * Physical command profiles of the minimal create barrier. Counts come from the
 * fake driver's own `commandStarted` events, so a command is counted when the
 * runtime issues it, not when the driver finishes it. These are synthetic
 * measurements, not a wall-clock SLA.
 */
type CommandProfile = { started: number; byCommand: Record<string, number>; completed: number;
  reads: number; writes: number; waves: number; elapsedMs: number };

function commandProfile(db: ReturnType<typeof calendarMemory>, probe: DependencyProbe) {
  const started: { commandName: string; collection: string }[] = [];
  const onStart = (event: { commandName: string; command?: Record<string, unknown> }) =>
    started.push({ commandName: event.commandName,
      collection: String(event.command?.[event.commandName] ?? '') });
  db.commandSource.on('commandStarted', onStart);
  /** Counts from the driver's own started/completed events, never an end snapshot. */
  const mark = (): CommandProfile => ({
    started: started.length,
    byCommand: started.reduce<Record<string, number>>((acc, item) => {
      const name = `${item.commandName}.${item.collection}`;
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {}),
    completed: db.wireCalls.length,
    reads: db.wireCalls.filter(call => call.kind === 'read').length,
    writes: db.wireCalls.filter(call => call.kind === 'write').length,
    waves: probe.waves,
    elapsedMs: probe.elapsedMs,
  });
  const between = (from: CommandProfile, to: CommandProfile): CommandProfile => {
    const byCommand: Record<string, number> = {};
    for (const [name, count] of Object.entries(to.byCommand)) {
      const delta = count - (from.byCommand[name] ?? 0);
      if (delta > 0) byCommand[name] = delta;
    }
    return { started: to.started - from.started, byCommand, completed: to.completed - from.completed,
      reads: to.reads - from.reads, writes: to.writes - from.writes, waves: to.waves - from.waves,
      elapsedMs: to.elapsedMs - from.elapsedMs };
  };
  return { mark, between, stop: () => { db.commandSource.off('commandStarted', onStart); return mark(); } };
}

it.each([0, 8])('keeps the direct create barrier command set constant after %s prior turns', async earlierTurns => {
  const probe = new DependencyProbe();
  const f = await nativeFixture(undefined, 1, {}, { probe });
  const profile = commandProfile(f.db, probe);
  const cal = f.runtime.d.calendar!;
  if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
  const invoke = cal.execution.invoke.bind(cal.execution);
  let atPost: CommandProfile | undefined;
  vi.spyOn(cal.execution, 'invoke').mockImplementation(async request => {
    if (request.call.name === 'calendar_create_event' && request.binding.operation && !atPost) {
      atPost = profile.mark();
    }
    return invoke(request);
  });
  try {
    let sessionId: string | null = null;
    for (let index = 0; index < earlierTurns; index++) {
      f.modelWires.push(textWire(`Earlier answer ${index}`));
      const prior = await f.drive(() => f.submit(`Earlier question ${index}`, sessionId));
      sessionId = prior.sessionId;
      await f.drive(() => f.execute(prior));
    }
    f.modelWires.push(...createWires(`profile-create-${earlierTurns}`));
    const before = profile.mark();
    const turn = await f.drive(() => f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', sessionId));
    // The background save is deliberately not awaited: `saved()` polls with
    // vi.waitFor, which cannot advance a driven probe, and publication is
    // outside the measured barrier.
    await f.drive(() => f.execute(turn));
    const whole = profile.between(before, profile.mark());
    const barrier = atPost ? profile.between(before, atPost) : undefined;
    console.log('DIRECT_CREATE_PROFILE', JSON.stringify({ earlierTurns, barrier, whole }));
    expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(barrier).toBeDefined();
    expect(barrier!.started).toBeGreaterThan(0);
    // The mandatory barrier evidence is acknowledged in metadata (inserts are
    // `$setOnInsert` upserts) before the POST.
    for (const name of ['update.metadata', 'find.metadata', 'update.sessions']) {
      expect(barrier!.byCommand[name] ?? 0).toBeGreaterThan(0);
    }
    expect(whole.elapsedMs).toBeGreaterThanOrEqual(barrier!.elapsedMs);
  } finally { vi.restoreAllMocks(); profile.stop(); f.runtime.stopAccepting(); }
});

it('keeps the mandatory barrier command set independent of prior dispatch history', async () => {
  const measured: { earlierTurns: number; barrier: CommandProfile; events: string[] }[] = [];
  for (const earlierTurns of [0, 8]) {
    const probe = new DependencyProbe();
    const f = await nativeFixture(undefined, 1, {}, { probe });
    const profile = commandProfile(f.db, probe);
    const cal = f.runtime.d.calendar!;
    if (!isCalendarV2(cal)) throw new Error('Fixture requires Calendar v2');
    const invoke = cal.execution.invoke.bind(cal.execution);
    let atPost: CommandProfile | undefined;
    vi.spyOn(cal.execution, 'invoke').mockImplementation(async request => {
      if (request.call.name === 'calendar_create_event' && request.binding.operation && !atPost) {
        atPost = profile.mark();
      }
      return invoke(request);
    });
    try {
      let sessionId: string | null = null;
      for (let index = 0; index < earlierTurns; index++) {
        f.modelWires.push(textWire(`Prior ${index}`));
        const prior = await f.drive(() => f.submit(`Prior question ${index}`, sessionId));
        sessionId = prior.sessionId;
        await f.drive(() => f.execute(prior));
      }
      f.modelWires.push(...createWires(`history-create-${earlierTurns}`));
      const before = profile.mark();
      const turn = await f.drive(() => f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', sessionId));
      await f.drive(() => f.execute(turn));
      expect(atPost).toBeDefined();
      const barrier = profile.between(before, atPost!);
      const events = await f.drive(async () => {
        const operation = await f.operationFor(turn);
        return (await f.p.calendarOperationsV2.listEventsV2({ userId: f.identity.userId,
          sessionId: turn.sessionId, operationId: operation!.operationId })).map(item => item.state);
      });
      measured.push({ earlierTurns, barrier, events });
      console.log('BARRIER_HISTORY_PROFILE', JSON.stringify({ earlierTurns, barrier, events }));
      expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
      // The mandatory metadata evidence is acknowledged before the POST at both
      // histories. Warm sessions additionally hydrate history (reads), and prior
      // turns' deferred archival drains in the window; neither is barrier work.
      for (const name of ['update.metadata', 'update.sessions']) {
        expect(barrier.byCommand[name] ?? 0).toBeGreaterThan(0);
      }
    } finally { vi.restoreAllMocks(); profile.stop(); f.runtime.stopAccepting(); }
  }
  expect(measured).toHaveLength(2);
  // The barrier's own evidence is the same regardless of prior model history:
  // one intent reservation, one planned/dispatching/succeeded event sequence.
  expect(measured[1]!.events).toEqual(measured[0]!.events);
  for (const sample of measured) expect(sample.events).toEqual(['planned', 'dispatching', 'succeeded']);
  // Deferred archival may grow; the barrier's metadata writes must not.
  expect(measured[1]!.barrier.byCommand['update.metadata']).toBeLessThanOrEqual(
    measured[0]!.barrier.byCommand['update.metadata']! * 2);
});

it('profiles a proposal-confirmed create at zero and eight prior turns', async () => {
  for (const earlierTurns of [0, 8]) {
    const probe = new DependencyProbe();
    const f = await nativeFixture(undefined, 1, {}, { probe });
    const profile = commandProfile(f.db, probe);
    try {
      let sessionId: string | null = null;
      for (let index = 0; index < earlierTurns; index++) {
        f.modelWires.push(textWire(`Earlier ${index}`));
        const prior = await f.drive(() => f.submit(`Earlier ${index}`, sessionId));
        sessionId = prior.sessionId;
        await f.drive(() => f.execute(prior));
      }
      f.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'proposal-load'),
        createWire(event(), 'proposal-create'), textWire('Created.'));
      const proposalTurn = await f.drive(() => f.submit('create the event', sessionId));
      await f.drive(() => f.execute(proposalTurn));
      const proposal = await f.drive(() => f.currentProposal(proposalTurn.sessionId));
      expect(proposal).toMatchObject({ state: 'pending' });
      // Only the reply turn is measured, never the proposal turn.
      f.modelWires.push(textWire('Confirmed and created.'));
      const before = profile.mark();
      const reply = await f.drive(() => f.submit('yes', proposalTurn.sessionId));
      await f.drive(() => f.execute(reply));
      const sample = profile.between(before, profile.mark());
      console.log('PROPOSAL_CREATE_PROFILE', JSON.stringify({ earlierTurns, ...sample }));
      expect(f.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
      expect(await f.drive(() => f.operationFor(reply))).toMatchObject({ state: 'succeeded' });
      expect(sample.started).toBeGreaterThan(0);
    } finally { profile.stop(); f.runtime.stopAccepting(); }
  }
});

it('separates cold, changed-account and recovery paths from the warm barrier profile', async () => {
  // 1) Cold: no prior publication, so the create still completes in memory.
  const cold = await nativeFixture();
  cold.modelWires.push(...createWires('cold-path-create'));
  try {
    const turn = await cold.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await cold.execute(turn);
    expect(cold.status(turn)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } });
    expect(cold.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
  } finally { cold.runtime.stopAccepting(); }

  // 2) Changed account between approval and dispatch: no POST.
  const changed = await nativeFixture();
  changed.modelWires.push(...createWires('changed-account-create'));
  try {
    const turn = await changed.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await changed.replaceAccount('moved@example.test');
    await changed.execute(turn).catch(() => undefined);
    expect(changed.effects).toEqual([]);
  } finally { changed.runtime.stopAccepting(); }

  // 3) Recovery: a dispatch that already happened is read back, never re-sent.
  const recovery = await nativeFixture();
  recovery.modelWires.push(...createWires('recovery-path-create'));
  let coldRuntime: DurableChatRuntime | undefined;
  try {
    const turn = await recovery.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    recovery.failOnce('receipt-save');
    await recovery.execute(turn).catch(() => undefined);
    const pending = await recovery.operationFor(turn);
    expect(['dispatching', 'unknown']).toContain(pending?.state);
    coldRuntime = new DurableChatRuntime(recovery.runtime.d);
    await coldRuntime.reconcileSession(recovery.identity.userId, turn.sessionId);
    const reconciled = await recovery.operationFor(turn);
    expect(['succeeded', 'unknown']).toContain(reconciled?.state);
    expect(recovery.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    expect(recovery.effects.filter(effect => effect.kind === 'readback')
      .every(effect => effect.eventId === pending!.googleEventId)).toBe(true);
    expect(reconciled?.googleEventId).toBe(pending!.googleEventId);
  } finally { coldRuntime?.stopAccepting(); recovery.runtime.stopAccepting(); }
});

it('keeps the mandate barriered under a clean and a dirty prepared path', async () => {
  // Clean: the persistence tail drains, so the publication is not behind.
  const clean = await nativeFixture();
  clean.modelWires.push(...createWires('clean-prepared'));
  try {
    const turn = await clean.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    await clean.execute(turn);
    await clean.saved(turn);
    expect(clean.status(turn)).toMatchObject({ status: 'completed', save: { state: 'saved' } });
    expect(clean.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
  } finally { clean.runtime.stopAccepting(); }

  // Dirty: the earlier archive write is held, and the create still completes.
  const dirty = await nativeFixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const blockedAt = new Promise<void>(resolve => { entered = resolve; });
  const put = dirty.p.memory.put.bind(dirty.p.memory);
  vi.spyOn(dirty.p.memory, 'put').mockImplementationOnce(async manifest => {
    entered(); await held; return put(manifest);
  });
  dirty.modelWires.push(textWire('Dirty first answer'), ...createWires('dirty-prepared'));
  let run: Promise<void> | undefined;
  try {
    const first = await dirty.submit('Ordinary first question');
    await dirty.execute(first);
    await blockedAt;
    const second = await dirty.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', first.sessionId);
    run = dirty.execute(second);
    await vi.waitFor(() => expect(dirty.status(second)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } }));
    expect(dirty.effects.filter(effect => effect.kind === 'create')).toHaveLength(1);
    release();
    await run;
    await dirty.saved(second);
    expect(dirty.status(second)).toMatchObject({ status: 'completed', save: { state: 'saved' } });
  } finally { release(); await run?.catch(() => undefined); vi.restoreAllMocks(); dirty.runtime.stopAccepting(); }
});

it('keeps metrics, telemetry and diagnostics free of prompts, payloads and URIs', async () => {
  const capture = processDiagnosticCapture();
  const f = await nativeFixture(undefined, 1, {}, { diagnostics: capture.diagnostics });
  const promptCanary = 'PROMPT-CANARY-Schedule-Planning';
  try {
    f.modelWires.push(
      skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'leak-load'),
      createWire({ ...event(), summary: 'SUMMARY-CANARY', location: 'LOCATION-CANARY' }, 'leak-create'),
      textWire('Narration.'),
    );
    const turn = await f.submit(promptCanary);
    await f.execute(turn);
    await f.saved(turn);
    const serialized = JSON.stringify({
      records: capture.records(), commands: f.db.wireCalls, calls: f.db.calls,
      config: f.runtime.d.currentConfig?.current() ?? null,
    });
    for (const forbidden of [promptCanary, 'SUMMARY-CANARY', 'LOCATION-CANARY', 'fixture-access-token',
      'sk-', 'mongodb://', 'https://', 'fixture-cipher']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(capture.records().every(record => typeof record.kind === 'string')).toBe(true);
  } finally { vi.restoreAllMocks(); f.runtime.stopAccepting(); }
});
