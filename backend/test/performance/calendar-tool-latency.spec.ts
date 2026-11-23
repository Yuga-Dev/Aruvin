/**
 * ============================================================================
 * FILE: calendar-tool-latency.spec.ts
 * LOCATION: backend/test/performance/calendar-tool-latency.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify assembled Calendar tool critical paths and recovery behavior.
 *
 * ROLE IN PROJECT:
 *    P4 integration acceptance coverage for the production application/runtime
 *    composition using deterministic providers and the repository fake driver.
 *
 * KEY COMPONENTS:
 *    - Prepared admission check: Confirms fresh authority failures remain closed.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { setImmediate as flushImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { BSON } from 'mongodb';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { calendarToolLatencyFixture, durableImage } from './calendar-tool-latency-fixture.js';
import { createWire, loadWire, skillWire, textWire } from '../runtime/calendar-runtime.fixture.js';
import { event } from '../runtime/calendar-multi-fixture.js';
import { deferred } from '../assembly/admin-config-fixture.js';

const READS = [
  { tool: 'calendar_list_calendars', args: {}, provider: [] },
  {
    tool: 'calendar_list_events',
    args: { timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', maxResults: 10 },
    provider: [
      { method: 'GET', kind: 'calendar-list' },
      { method: 'GET', kind: 'events' },
    ],
  },
  {
    tool: 'calendar_get_event',
    args: { calendarId: 'personal@example.test', eventId: 'evt123456' },
    provider: [
      { method: 'GET', kind: 'calendar-list' },
      { method: 'GET', kind: 'event' },
    ],
  },
  {
    tool: 'calendar_check_availability',
    args: {
      timeMin: '2026-11-03T10:00:00Z',
      timeMax: '2026-11-03T11:00:00Z',
      timeZone: 'Etc/UTC',
      calendarIds: ['personal@example.test'],
    },
    provider: [{ method: 'POST', kind: 'freeBusy' }],
  },
] as const;

function assertPair(body: Record<string, unknown>, callId: string, input: string) {
  const messages = body.messages as {
    role: string;
    content: string;
    tool_calls?: { id: string }[];
    tool_call_id?: string;
  }[];
  expect(messages.filter(message => message.role === 'user' && message.content === input)).toHaveLength(1);
  expect(messages.flatMap(message => message.tool_calls ?? [])
    .filter(call => call.id === callId)).toHaveLength(1);
  expect(messages.filter(message => message.role === 'tool' && message.tool_call_id === callId))
    .toHaveLength(1);
}

function imageRows(image: ReturnType<typeof durableImage>, collection: string) {
  return (image[collection] ?? []).map(bytes => BSON.deserialize(bytes) as Record<string, unknown>);
}

async function prepareProfileFixture(
  f: Awaited<ReturnType<typeof calendarToolLatencyFixture>>,
  priorTurns: number,
) {
  f.observeArchive();
  for (let index = 0; index < priorTurns; index++) {
    const saves = f.trace.marks.filter(mark => mark.name === 'save-end').length;
    f.modelWires.push(textWire(`Noted ${index}.`));
    const ids = await f.run(() => f.submit(`Note ${index}.`));
    await f.run(() => f.execute(ids));
    await f.pumpUntil(() => f.trace.marks.filter(mark => mark.name === 'save-end').length > saves
      && f.probe.waiting === 0, 'prior archive save');
  }
}

async function measureProfileTurn(
  f: Awaited<ReturnType<typeof calendarToolLatencyFixture>>,
  input: string,
  wires: string[],
  options?: {
    sessionId?: string | null;
    replyTo?: { proposalId: string; revision: number };
  },
) {
  f.resetProfile();
  f.modelWires.push(...wires);
  const realStart = performance.now();
  const ids = await f.run(() => f.submit(
    input,
    options?.sessionId ?? null,
    options?.replyTo,
  ));
  await f.run(() => f.execute(ids));
  const realElapsedMs = performance.now() - realStart;
  await f.pumpUntil(() => f.trace.marks.some(mark => mark.name === 'save-end')
    && f.probe.waiting === 0, 'measured archive save');
  return { ids, snapshot: f.profileSnapshot(), realElapsedMs };
}

function emitProfile(input: {
  scenario: string;
  preparation: string;
  priorTurns: number;
  result: Awaited<ReturnType<typeof measureProfileTurn>>;
  limitations?: string;
}) {
  const { snapshot, realElapsedMs } = input.result;
  console.log('CALENDAR_TOOL_LATENCY', JSON.stringify({
    commitSet: '4c53b47+working-tree',
    scenario: input.scenario,
    mode: 'synthetic-dependency-wave',
    preparation: input.preparation,
    priorTurns: input.priorTurns,
    measurementKind: 'synthetic-dependency-wave',
    fixtureConstants: {
      readMs: 67,
      writeMs: 449,
      clock: '2026-11-03T09:00:00.000Z',
    },
    stages: snapshot.stageRows,
    logicalOperations: snapshot.logicalOperations,
    commandCounts: snapshot.commands,
    providerCounts: snapshot.providerCounts,
    waves: snapshot.waves,
    syntheticElapsedMs: snapshot.syntheticElapsedMs,
    realElapsedMs,
    unresolvedCommands: snapshot.commands.unresolved,
    limitations: input.limitations
      ?? 'Synthetic dependency-wave model; not live latency or native MongoDB.',
  }));
}

it('assembled fixture observes denied fresh admission instead of bypassing it', async () => {
  const f = await calendarToolLatencyFixture();
  try {
    await f.prepare();
    const account = await f.owner.connections.currentAccount();
    const blocked = vi.spyOn(f.p.calendarConnectionsV2, 'get')
      .mockRejectedValue(new Error('synthetic essential storage failure'));
    try {
      await expect(f.owner.connections.requireAccountCurrent(account,
        new AbortController().signal)).rejects.toBeDefined();
      expect(blocked).toHaveBeenCalled();
      expect(f.provider.posts).toHaveLength(0);
    } finally {
      blocked.mockRestore();
    }
  } finally {
    await f.close();
  }
});

it('assembled fixture records command starts before held completion', async () => {
  const f = await calendarToolLatencyFixture();
  const held = f.db.pauseNextUpdate();
  try {
    f.observeArchive();
    f.modelWires.push(textWire('Archive observer check.'));
    const ids = await f.run(() => f.submit('Archive observer check.'));
    const execution = f.execute(ids);
    let entered = false;
    void held.started.then(() => { entered = true; });
    for (let turn = 0; turn < 10_000 && !entered; turn++) {
      await flushImmediate();
      if (f.probe.waiting > 0) f.probe.advance(0, 0);
    }
    expect(entered).toBe(true);
    const command = f.trace.commands.find(row => row.endedAt === null);
    expect(command).toMatchObject({
      origin: { lane: 'archive', attemptId: ids.attemptId },
      endedAt: null,
      failed: null,
    });
    held.resume();
    await f.run(() => execution);
    for (let turn = 0; turn < 10_000; turn++) {
      await flushImmediate();
      if (f.probe.waiting > 0) f.probe.advance(0, 0);
      if (f.trace.marks.some(mark => mark.name === 'save-end') && f.probe.waiting === 0) break;
    }
    expect(f.trace.commands.every(row => row.endedAt !== null)).toBe(true);
    expect(f.trace.commands.some(row =>
      row.origin.lane === 'archive' && row.origin.attemptId === ids.attemptId)).toBe(true);
  } finally {
    held.resume();
    await f.close();
  }
});

it('assembled fixture rejects an unexpected provider destination', async () => {
  const f = await calendarToolLatencyFixture();
  try {
    await expect(f.fetcher('https://unexpected.invalid/calendar', {}))
      .rejects.toThrow('Network destination is not an injected provider fixture');
    expect(f.provider.posts).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it.each(READS)('prepared $tool dispatches and continues with application storage blocked', async spec => {
  const f = await calendarToolLatencyFixture();
  const input = `Run ${spec.tool}`;
  const callId = 'p4-read';
  const save = f.holdNextArchiveSave();
  let storageBlock: ReturnType<typeof f.blockStorage> | undefined;
  let failure: unknown;
  try {
    f.observeArchive();
    f.provider.events.set(JSON.stringify(['personal@example.test', 'evt123456']), {
      id: 'evt123456',
      summary: 'private-event-canary',
      status: 'confirmed',
      start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
      end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' },
      htmlLink: 'https://calendar.google.com/calendar/event?eid=evt123456',
    });
    f.modelWires.push(
      loadWire(spec.tool, 'p4-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: spec.tool,
        arguments: spec.args,
      }, callId),
      textWire('Read complete.'),
      textWire('Follow-up complete.'),
    );
    const before = f.trace.commands.length;
    storageBlock = f.blockStorage();
    const first = await f.run(() => f.submit(input));
    await f.run(() => f.execute(first));
    await save.entered;
    expect(f.status(first)).toMatchObject({
      status: 'completed',
      save: { durableVersion: 0 },
    });
    assertPair(f.modelBodies[2]!, callId, input);
    expect(storageBlock.calls(), storageBlock.firstStack() ?? undefined).toBe(0);
    expect(f.trace.commands).toHaveLength(before);
    expect(f.provider.requests).toEqual(spec.provider);

    storageBlock.restore();
    storageBlock = undefined;
    await f.prepare();
    const beforeFollowUp = f.trace.commands.length;
    storageBlock = f.blockStorage();
    const next = await f.run(() => f.submit('Follow up', first.sessionId));
    await f.run(() => f.execute(next));
    expect(f.status(next)?.status).toBe('completed');
    expect(f.modelBodies).toHaveLength(4);
    assertPair(f.modelBodies[2]!, callId, input);
    expect(f.trace.commands).toHaveLength(beforeFollowUp);
    expect(storageBlock.calls(), storageBlock.firstStack() ?? undefined).toBe(0);
    expect(f.provider.posts).toHaveLength(0);
    expect(JSON.stringify({ commands: f.trace.commands, marks: f.trace.marks }))
      .not.toMatch(/latency-(access|refresh)-canary|private-event-canary/);
  } catch (error) {
    failure = error;
  } finally {
    storageBlock?.restore();
    save.release();
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('repeated prepared owner request preparation does not touch application storage', async () => {
  const f = await calendarToolLatencyFixture();
  const storageBlock = f.blockStorage();
  let failure: unknown;
  try {
    await f.prepare();
    expect(storageBlock.calls(), storageBlock.firstStack() ?? undefined).toBe(0);
  } catch (error) {
    failure = error;
  } finally {
    storageBlock.restore();
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('read continuation and follow-up finish while an actual archive owns persistence', async () => {
  const f = await calendarToolLatencyFixture();
  f.observeArchive();
  const entered = deferred<void>();
  const release = deferred<void>();
  const originalPut = f.p.memory.put.bind(f.p.memory);
  const savedVersions: number[] = [];
  let held = false;
  const putObserver = vi.spyOn(f.p.memory, 'put').mockImplementation(async (record, ...args) => {
    if (!held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    savedVersions.push(record.contextVersion);
    return originalPut(record, ...args);
  });
  let failure: unknown;
  try {
    f.modelWires.push(textWire('Earlier answer.'));
    const earlier = await f.run(() => f.submit('Earlier question.'));
    const earlierExecution = f.execute(earlier);
    await f.driveLifecycle(earlierExecution);
    await f.pumpUntil(() => held, 'first real archive manifest write');

    const session = [...f.db.rows('sessions').values()]
      .find(row => row.sessionId === earlier.sessionId);
    expect(session?.execution.ownerId).toBe(f.p.owner.executorId);
    const commandCount = f.trace.commands.length;

    f.modelWires.push(
      loadWire('calendar_list_events', 'p4-read-load-held'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'p4-read-held'),
      textWire('Read complete.'),
      textWire('Follow-up complete.'),
    );
    const readInput = 'Read calendar events while the archive is held.';
    const read = await f.run(() => f.submit(readInput, earlier.sessionId));
    await f.run(() => f.execute(read));
    expect(f.status(read)).toMatchObject({
      status: 'completed',
      save: { durableVersion: 0 },
    });
    assertPair(f.modelBodies[3]!, 'p4-read-held', readInput);

    const followUp = await f.run(() => f.submit('Follow up while the archive is held.', earlier.sessionId));
    await f.run(() => f.execute(followUp));
    expect(f.status(followUp)?.status).toBe('completed');
    expect(f.modelBodies).toHaveLength(5);
    expect(f.trace.commands).toHaveLength(commandCount);
    expect(f.provider.posts).toHaveLength(0);

    const pendingDrain = await f.driveLifecycle(f.raw.drain(5));
    expect(pendingDrain.drained).toBe(false);
    expect(pendingDrain.unresolvedWrites).toBeGreaterThan(0);

    release.resolve();
    const drained = await f.driveLifecycle(f.raw.drain(500));
    expect(drained.drained).toBe(true);
    putObserver.mockRestore();
    expect(savedVersions).toEqual([1, 2, 3]);
    expect(f.status(followUp)?.save.durableVersion).toBe(3);
  } catch (error) {
    failure = error;
  } finally {
    putObserver.mockRestore();
    release.resolve();
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('direct create crosses its essential barrier while an earlier archive holds ownership', async () => {
  const f = await calendarToolLatencyFixture();
  f.observeArchive();
  const archiveEntered = deferred<void>();
  const archiveRelease = deferred<void>();
  const postEntered = deferred<void>();
  const postRelease = deferred<void>();
  let archiveHeld = false;
  let postImage: ReturnType<typeof durableImage> | null = null;
  const originalPut = f.p.memory.put.bind(f.p.memory);
  const putObserver = vi.spyOn(f.p.memory, 'put').mockImplementation(async (record, ...args) => {
    if (!archiveHeld) {
      archiveHeld = true;
      archiveEntered.resolve();
      await archiveRelease.promise;
    }
    return originalPut(record, ...args);
  });
  f.provider.holdResponses(async info => {
    if (info.method !== 'POST' || info.kind !== 'events') return;
    postImage = durableImage(f.db);
    postEntered.resolve();
    await postRelease.promise;
  });
  let failure: unknown;
  try {
    f.modelWires.push(textWire('Earlier answer.'));
    const earlier = await f.run(() => f.submit('Earlier question.'));
    const earlierExecution = f.execute(earlier);
    await f.driveLifecycle(earlierExecution);
    await f.pumpUntil(() => archiveHeld, 'earlier archive ownership');
    await archiveEntered.promise;

    const createInput = 'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.';
    f.modelWires.push(
      loadWire('calendar_create_event', 'p4-create-load'),
      createWire(event(), 'p4-create'),
      textWire('Created.'),
    );
    const created = await f.run(() => f.submit(createInput, earlier.sessionId));
    const execution = f.execute(created);
    await f.pumpUntil(() => postImage !== null, 'direct Calendar POST');
    await postEntered.promise;

    expect(f.provider.posts).toHaveLength(1);
    const image = postImage!;
    const messages = imageRows(image, 'messages');
    const metadata = imageRows(image, 'metadata');
    const input = messages.find(row =>
      row.role === 'user' && row.turnId === created.turnId && row.content === createInput);
    const attempt = metadata.find(row =>
      row.kind === 'attempt' && row.attemptId === created.attemptId);
    const acceptance = metadata.find(row =>
      row.kind === 'acceptance' && row.attemptId === created.attemptId);
    const budget = metadata.find(row =>
      row.kind === 'calendar-turn-budget' && row.turnId === created.turnId);
    const operation = metadata.find(row =>
      row.kind === 'calendar-operation' && row.schemaVersion === 2
        && row.turnId === created.turnId && row.state === 'dispatching');
    const events = metadata.filter(row =>
      row.kind === 'calendar-operation-event-v2' && row.turnId === created.turnId);

    expect(input).toBeDefined();
    expect(attempt).toMatchObject({ status: 'generating', attemptId: created.attemptId });
    expect(acceptance).toMatchObject({
      kind: 'acceptance',
      userId: f.identity.userId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      attemptId: created.attemptId,
    });
    expect(budget).toMatchObject({ logicalTools: 1, creates: 1 });
    expect(operation).toMatchObject({
      state: 'dispatching',
      sessionId: created.sessionId,
      turnId: created.turnId,
      originatingAttemptId: created.attemptId,
      authorization: {
        acceptedTurnId: created.turnId,
        acceptedUserMessageId: input?.messageId,
        basis: 'explicit-request',
      },
      action: event(),
    });
    expect(events.map(row => row.state)).toEqual(['planned', 'dispatching']);
    expect(JSON.stringify({ commands: f.trace.commands, marks: f.trace.marks }))
      .not.toMatch(/latency-(access|refresh)-canary|private-event-canary/);

    postRelease.resolve();
    await f.driveLifecycle(execution);
    expect(f.provider.posts).toHaveLength(1);
    expect(f.status(created)?.status).toBe('completed');
  } catch (error) {
    failure = error;
  } finally {
    postRelease.resolve();
    archiveRelease.resolve();
    f.provider.holdResponses(null);
    putObserver.mockRestore();
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('proposal confirmation crosses its essential barrier while an earlier archive holds ownership', async () => {
  const f = await calendarToolLatencyFixture();
  f.observeArchive();
  const archiveEntered = deferred<void>();
  const archiveRelease = deferred<void>();
  const postEntered = deferred<void>();
  const postRelease = deferred<void>();
  let archiveHeld = false;
  let postImage: ReturnType<typeof durableImage> | null = null;
  const originalPut = f.p.memory.put.bind(f.p.memory);
  const putObserver = vi.spyOn(f.p.memory, 'put').mockImplementation(async (record, ...args) => {
    if (!archiveHeld) {
      archiveHeld = true;
      archiveEntered.resolve();
      await archiveRelease.promise;
    }
    return originalPut(record, ...args);
  });
  f.provider.holdResponses(async info => {
    if (info.method !== 'POST' || info.kind !== 'events') return;
    postImage = durableImage(f.db);
    postEntered.resolve();
    await postRelease.promise;
  });
  let failure: unknown;
  try {
    f.modelWires.push(textWire('Earlier answer.'));
    const earlier = await f.run(() => f.submit('Earlier question.'));
    const earlierExecution = f.execute(earlier);
    await f.driveLifecycle(earlierExecution);
    await f.pumpUntil(() => archiveHeld, 'earlier archive ownership');
    await archiveEntered.promise;

    f.modelWires.push(
      loadWire('calendar_create_event', 'p4-proposal-load'),
      createWire(event(), 'p4-proposal-create'),
    );
    const proposalTurn = await f.run(() => f.submit('create the event', earlier.sessionId));
    await f.run(() => f.execute(proposalTurn));
    expect(f.provider.posts).toHaveLength(0);
    const proposal = await f.run(() =>
      f.p.calendarProposals.getCurrent(f.identity.userId, proposalTurn.sessionId));
    expect(proposal).not.toBeNull();
    const modelCount = f.modelBodies.length;

    const confirm = await f.run(() => f.submit('yes', proposalTurn.sessionId, {
      proposalId: proposal!.proposalId,
      revision: proposal!.revision,
    }));
    const execution = f.execute(confirm);
    await f.pumpUntil(() => postImage !== null, 'proposal-confirmed Calendar POST');
    await postEntered.promise;

    expect(f.provider.posts).toHaveLength(1);
    const metadata = imageRows(postImage!, 'metadata');
    const messages = imageRows(postImage!, 'messages');
    const acceptedInput = messages.find(row =>
      row.role === 'user' && row.turnId === confirm.turnId && row.content === 'yes');
    const operation = metadata.find(row =>
      row.kind === 'calendar-operation' && row.schemaVersion === 2
        && row.turnId === confirm.turnId && row.state === 'dispatching');
    const events = metadata.filter(row =>
      row.kind === 'calendar-operation-event-v2' && row.turnId === confirm.turnId);
    expect(acceptedInput).toBeDefined();
    expect(operation).toMatchObject({
      state: 'dispatching',
      authorization: {
        acceptedTurnId: confirm.turnId,
        acceptedUserMessageId: acceptedInput?.messageId,
        basis: 'proposal-confirmation',
        proposalId: proposal!.proposalId,
      },
    });
    expect(events.map(row => row.state)).toEqual(['planned', 'dispatching']);

    postRelease.resolve();
    await f.driveLifecycle(execution);
    expect(f.modelBodies).toHaveLength(modelCount);
    expect(f.provider.posts).toHaveLength(1);
    expect(f.status(confirm)?.status).toBe('completed');
  } catch (error) {
    failure = error;
  } finally {
    postRelease.resolve();
    archiveRelease.resolve();
    f.provider.holdResponses(null);
    putObserver.mockRestore();
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('new assembled runtime reconciles an ambiguous create by pinned ID without another POST', async () => {
  const f = await calendarToolLatencyFixture();
  const postEntered = deferred<void>();
  const postRelease = deferred<void>();
  let imageAtPost: ReturnType<typeof durableImage> | null = null;
  let recovered: Awaited<ReturnType<typeof calendarToolLatencyFixture>> | undefined;
  let originalClosed = false;
  let failure: unknown;
  f.provider.holdResponses(async info => {
    if (info.method !== 'POST' || info.kind !== 'events') return;
    imageAtPost = durableImage(f.db);
    postEntered.resolve();
    await postRelease.promise;
  });
  try {
    const input = 'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.';
    f.modelWires.push(
      loadWire('calendar_create_event', 'p4-crash-load'),
      createWire(event(), 'p4-crash-create'),
      textWire('Created.'),
    );
    const created = await f.run(() => f.submit(input));
    const execution = f.execute(created);
    await f.pumpUntil(() => imageAtPost !== null, 'external create before response delivery');
    await postEntered.promise;
    expect(f.provider.posts).toHaveLength(1);

    const image = imageAtPost!;
    const beforeRows = imageRows(image, 'metadata');
    const beforeOperation = beforeRows.find(row =>
      row.kind === 'calendar-operation' && row.schemaVersion === 2
        && row.turnId === created.turnId && row.state === 'dispatching');
    expect(beforeOperation).toBeDefined();
    const originalIdentity = {
      operationId: beforeOperation?.operationId,
      intentId: beforeOperation?.intentId,
      googleEventId: beforeOperation?.googleEventId,
      calendarId: beforeOperation?.calendarId,
      requestHash: beforeOperation?.requestHash,
      attemptId: beforeOperation?.originatingAttemptId,
    };
    expect(f.provider.posts[0]?.eventId).toBe(originalIdentity.googleEventId);

    postRelease.resolve();
    await f.driveLifecycle(execution);
    f.provider.holdResponses(null);
    await f.close();
    originalClosed = true;

    recovered = await calendarToolLatencyFixture({ image, provider: f.provider });
    await recovered.driveLifecycle(recovered.raw.reconcileSession(
      recovered.identity.userId,
      created.sessionId,
    ));
    const after = await recovered.run(() =>
      recovered!.p.calendarOperationsV2.getByTurn(
        recovered!.identity.userId,
        created.sessionId,
        created.turnId,
      ));
    expect(after).toMatchObject({
      operationId: originalIdentity.operationId,
      intentId: originalIdentity.intentId,
      googleEventId: originalIdentity.googleEventId,
      calendarId: originalIdentity.calendarId,
      requestHash: originalIdentity.requestHash,
      originatingAttemptId: originalIdentity.attemptId,
      state: 'succeeded',
    });
    expect(recovered.provider.posts).toHaveLength(1);
    expect(recovered.provider.gets.length).toBeGreaterThan(0);
    expect(recovered.provider.gets.every(row => row.eventId === originalIdentity.googleEventId)).toBe(true);
    expect(recovered.modelBodies).toHaveLength(0);
  } catch (error) {
    failure = error;
  } finally {
    postRelease.resolve();
    f.provider.holdResponses(null);
    if (recovered) {
      try {
        await recovered.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Recovery cleanup failed');
      }
    }
    if (!originalClosed) {
      try {
        await f.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Original cleanup failed');
      }
    }
  }
  if (failure !== undefined) throw failure;
});

it('planned-operation crash recovery may dispatch one original create without model replay', async () => {
  const f = await calendarToolLatencyFixture();
  const barrierEntered = deferred<void>();
  const barrierRelease = deferred<void>();
  const originalCas = f.p.calendarOperationsV2.compareAndSwap.bind(f.p.calendarOperationsV2);
  let crashImage: ReturnType<typeof durableImage> | null = null;
  let recovery: Awaited<ReturnType<typeof calendarToolLatencyFixture>> | undefined;
  let originalClosed = false;
  let failure: unknown;
  const barrier = vi.spyOn(f.p.calendarOperationsV2, 'compareAndSwap').mockImplementation(async input => {
    if (input.next.state === 'dispatching') {
      crashImage = durableImage(f.db);
      barrierEntered.resolve();
      await barrierRelease.promise;
    }
    return originalCas(input);
  });
  try {
    const controller = new AbortController();
    const createInput = 'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.';
    f.modelWires.push(
      loadWire('calendar_create_event', 'p4-planned-load'),
      createWire(event(), 'p4-planned-create'),
      textWire('Created.'),
    );
    const created = await f.run(() => f.submit(createInput));
    const execution = f.execute(created, controller.signal);
    await f.pumpUntil(() => crashImage !== null, 'planned-to-dispatching CAS boundary');
    await barrierEntered.promise;

    const metadata = imageRows(crashImage!, 'metadata');
    const planned = metadata.find(row =>
      row.kind === 'calendar-operation' && row.schemaVersion === 2
        && row.turnId === created.turnId);
    expect(planned).toMatchObject({ state: 'planned', originatingAttemptId: created.attemptId });
    expect(metadata.some(row => row.kind === 'calendar-operation-event-v2'
      && row.turnId === created.turnId && row.state === 'planned')).toBe(true);
    expect(metadata.find(row => row.kind === 'calendar-turn-budget'
      && row.turnId === created.turnId)).toMatchObject({ creates: 1 });

    controller.abort();
    barrierRelease.resolve();
    let originalError: unknown;
    try {
      await f.driveLifecycle(execution);
    } catch (error) {
      originalError = error;
    }
    expect(f.provider.posts).toHaveLength(0);
    expect(f.status(created)?.status).toMatch(/cancelled|failed|interrupted/);
    if (originalError !== undefined) expect(originalError).toBeDefined();

    const originalIdentity = {
      operationId: planned?.operationId,
      intentId: planned?.intentId,
      googleEventId: planned?.googleEventId,
      requestHash: planned?.requestHash,
    };
    barrier.mockRestore();
    await f.close();
    originalClosed = true;

    recovery = await calendarToolLatencyFixture({ image: crashImage!, provider: f.provider });
    await recovery.driveLifecycle(recovery.raw.reconcileSession(
      recovery.identity.userId,
      created.sessionId,
    ));
    const operation = await recovery.run(() =>
      recovery!.p.calendarOperationsV2.getByTurn(
        recovery!.identity.userId,
        created.sessionId,
        created.turnId,
      ));
    expect(operation).toMatchObject({ ...originalIdentity, state: 'succeeded' });
    expect(recovery.provider.posts).toHaveLength(1);
    expect(recovery.modelBodies).toHaveLength(0);
  } catch (error) {
    failure = error;
  } finally {
    barrierRelease.resolve();
    barrier.mockRestore();
    if (recovery) {
      try {
        await recovery.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Recovery cleanup failed');
      }
    }
    if (!originalClosed) {
      try {
        await f.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Original cleanup failed');
      }
    }
  }
  if (failure !== undefined) throw failure;
});

it('missing dispatching-event acknowledgement keeps an essential create barrier closed', async () => {
  const f = await calendarToolLatencyFixture();
  const originalAppend = f.p.calendarOperationsV2.appendEventV2.bind(f.p.calendarOperationsV2);
  const append = vi.spyOn(f.p.calendarOperationsV2, 'appendEventV2').mockImplementation(async record => {
    if (record.state === 'dispatching') throw new Error('synthetic event acknowledgement unavailable');
    return originalAppend(record);
  });
  let failure: unknown;
  try {
    f.modelWires.push(
      loadWire('calendar_create_event', 'p4-barrier-load'),
      createWire(event(), 'p4-barrier-create'),
      textWire('Created.'),
    );
    const created = await f.run(() => f.submit(
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
    ));
    const execution = f.execute(created);
    try {
      await f.driveLifecycle(execution);
    } catch {
      // The assertion below classifies the terminal/persisted result, not the thrown message.
    }
    expect(f.provider.posts).toHaveLength(0);
    expect(['failed', 'cancelled', 'interrupted']).toContain(f.status(created)?.status);
    const operation = await f.run(() =>
      f.p.calendarOperationsV2.getByTurn(f.identity.userId, created.sessionId, created.turnId));
    expect(operation?.state).not.toBe('succeeded');
    const events = operation ? await f.run(() => f.p.calendarOperationsV2.listEventsV2({
      userId: f.identity.userId,
      sessionId: created.sessionId,
      operationId: operation.operationId,
    })) : [];
    expect(events.some(record => record.state === 'dispatching')).toBe(false);
  } catch (error) {
    failure = error;
  } finally {
    append.mockRestore();
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it.each([
  { boundary: 'planned event acknowledgement', committed: false, persisted: 'planned' },
  { boundary: 'planned event acknowledgement', committed: true, persisted: 'planned' },
  { boundary: 'dispatching CAS', committed: false, persisted: 'planned' },
  { boundary: 'dispatching event acknowledgement', committed: false, persisted: 'dispatching' },
  { boundary: 'dispatching event acknowledgement', committed: true, persisted: 'dispatching' },
] as const)('mutation barrier $boundary fails closed when committed: $committed', async spec => {
  const f = await calendarToolLatencyFixture();
  const originalAppend = f.p.calendarOperationsV2.appendEventV2.bind(f.p.calendarOperationsV2);
  const originalCas = f.p.calendarOperationsV2.compareAndSwap.bind(f.p.calendarOperationsV2);
  const append = vi.spyOn(f.p.calendarOperationsV2, 'appendEventV2').mockImplementation(async record => {
    if (spec.boundary === 'planned event acknowledgement' && record.state === 'planned') {
      if (spec.committed) await originalAppend(record);
      throw new Error('synthetic planned acknowledgement unavailable');
    }
    if (spec.boundary === 'dispatching event acknowledgement' && record.state === 'dispatching') {
      if (spec.committed) await originalAppend(record);
      throw new Error('synthetic dispatching acknowledgement unavailable');
    }
    return originalAppend(record);
  });
  const cas = vi.spyOn(f.p.calendarOperationsV2, 'compareAndSwap').mockImplementation(async input => {
    if (spec.boundary === 'dispatching CAS' && input.next.state === 'dispatching') {
      throw new Error('synthetic dispatching CAS unavailable');
    }
    return originalCas(input);
  });
  let failure: unknown;
  try {
    f.modelWires.push(
      loadWire('calendar_create_event', 'p4-fault-load'),
      createWire(event(), 'p4-fault-create'),
      textWire('Created.'),
    );
    const ids = await f.run(() => f.submit(
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
    ));
    try {
      await f.driveLifecycle(f.execute(ids));
    } catch {
      // The assertions below classify the persisted and external result.
    }
    expect(f.provider.posts).toHaveLength(0);
    expect(['failed', 'cancelled', 'interrupted']).toContain(f.status(ids)?.status);
    const operation = await f.run(() =>
      f.p.calendarOperationsV2.getByTurn(f.identity.userId, ids.sessionId, ids.turnId));
    expect(operation?.state).not.toBe('succeeded');
    expect(operation?.state).toBe(spec.persisted);
    expect(operation?.receipt).toBeNull();
    const events = operation ? await f.run(() => f.p.calendarOperationsV2.listEventsV2({
      userId: f.identity.userId,
      sessionId: ids.sessionId,
      operationId: operation.operationId,
    })) : [];
    if (spec.committed) {
      expect(events.some(record => record.state === spec.persisted)).toBe(true);
    } else {
      expect(events.some(record => record.state === 'dispatching')).toBe(false);
    }
    expect(JSON.stringify({ commands: f.trace.commands, marks: f.trace.marks }))
      .not.toMatch(/latency-(access|refresh)-canary|private-event-canary/);
  } catch (error) {
    failure = error;
  } finally {
    cas.mockRestore();
    append.mockRestore();
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('crash window W1 before the essential barrier recovers without a POST or model replay', async () => {
  const f = await calendarToolLatencyFixture();
  const barrierEntered = deferred<void>();
  const barrierRelease = deferred<void>();
  const originalReserve = f.p.calendarOperationsV2.reserveByIntent.bind(f.p.calendarOperationsV2);
  const barrier = vi.spyOn(f.p.calendarOperationsV2, 'reserveByIntent').mockImplementation(async input => {
    if (input.operation.turnId) {
      barrierEntered.resolve();
      await barrierRelease.promise;
    }
    return originalReserve(input);
  });
  let crashImage: ReturnType<typeof durableImage> | null = null;
  let recovery: Awaited<ReturnType<typeof calendarToolLatencyFixture>> | undefined;
  let originalClosed = false;
  let failure: unknown;
  try {
    const controller = new AbortController();
    f.modelWires.push(
      loadWire('calendar_create_event', 'p4-w1-load'),
      createWire(event(), 'p4-w1-create'),
      textWire('Created.'),
    );
    const created = await f.run(() => f.submit(
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
    ));
    const execution = f.execute(created, controller.signal);
    await f.pumpUntil(() => f.probe.waiting === 0 && barrier.mock.calls.length > 0, 'pre-reserve barrier');
    await barrierEntered.promise;

    crashImage = durableImage(f.db);
    const metadata = imageRows(crashImage, 'metadata');
    expect(metadata.some(row => row.kind === 'calendar-operation' && row.turnId === created.turnId)).toBe(false);
    const messages = imageRows(crashImage, 'messages');
    expect(messages.some(row => row.role === 'user' && row.turnId === created.turnId)).toBe(true);
    expect(f.provider.posts).toHaveLength(0);

    controller.abort();
    barrierRelease.resolve();
    await f.driveLifecycle(execution).catch(() => undefined);
    expect(f.provider.posts).toHaveLength(0);
    barrier.mockRestore();
    await f.close();
    originalClosed = true;

    recovery = await calendarToolLatencyFixture({ image: crashImage, provider: f.provider });
    await recovery.driveLifecycle(recovery.raw.reconcileSession(
      recovery.identity.userId,
      created.sessionId,
    ));
    expect(recovery.provider.posts).toHaveLength(0);
    expect(recovery.modelBodies).toHaveLength(0);
    const operation = await recovery.run(() =>
      recovery!.p.calendarOperationsV2.getByTurn(
        recovery!.identity.userId,
        created.sessionId,
        created.turnId,
      ));
    expect(operation).toBeNull();
  } catch (error) {
    failure = error;
  } finally {
    barrierRelease.resolve();
    barrier.mockRestore();
    if (recovery) {
      try {
        await recovery.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Recovery cleanup failed');
      }
    }
    if (!originalClosed) {
      try {
        await f.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Original cleanup failed');
      }
    }
  }
  if (failure !== undefined) throw failure;
});

it('crash window W4 after provider success and operation success recovers the receipt without a second POST', async () => {
  const f = await calendarToolLatencyFixture();
  const eventEntered = deferred<void>();
  const eventRelease = deferred<void>();
  let crashImage: ReturnType<typeof durableImage> | null = null;
  const originalAppend = f.p.calendarOperationsV2.appendEventV2.bind(f.p.calendarOperationsV2);
  const succeededEvent = vi.spyOn(f.p.calendarOperationsV2, 'appendEventV2').mockImplementation(async record => {
    const appended = await originalAppend(record);
    if (record.state === 'succeeded' && record.turnId) {
      crashImage = durableImage(f.db);
      eventEntered.resolve();
      await eventRelease.promise;
    }
    return appended;
  });
  let recovery: Awaited<ReturnType<typeof calendarToolLatencyFixture>> | undefined;
  let originalClosed = false;
  let failure: unknown;
  try {
    f.modelWires.push(
      loadWire('calendar_create_event', 'p4-w4-load'),
      createWire(event(), 'p4-w4-create'),
      textWire('Created.'),
    );
    const created = await f.run(() => f.submit(
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
    ));
    const execution = f.execute(created);
    await f.pumpUntil(() => crashImage !== null, 'succeeded operation event acknowledgement');
    await eventEntered.promise;

    const metadata = imageRows(crashImage!, 'metadata');
    const succeeded = metadata.find(row =>
      row.kind === 'calendar-operation' && row.schemaVersion === 2
        && row.turnId === created.turnId);
    expect(succeeded).toMatchObject({ state: 'succeeded' });
    expect(succeeded?.receipt).toMatchObject({ operationId: succeeded?.operationId });
    const events = metadata.filter(row =>
      row.kind === 'calendar-operation-event-v2' && row.turnId === created.turnId);
    expect(events.map(row => row.state)).toEqual(['planned', 'dispatching', 'succeeded']);
    expect(f.provider.posts).toHaveLength(1);
    const attemptBefore = metadata.find(row =>
      row.kind === 'attempt' && row.attemptId === created.attemptId);
    expect(attemptBefore?.status).toBe('generating');
    const messagesBefore = imageRows(crashImage!, 'messages');
    expect(messagesBefore.some(row =>
      row.role === 'assistant' && row.turnId === created.turnId)).toBe(false);

    eventRelease.resolve();
    await f.driveLifecycle(execution);
    succeededEvent.mockRestore();
    await f.close();
    originalClosed = true;

    recovery = await calendarToolLatencyFixture({ image: crashImage, provider: f.provider });
    await recovery.driveLifecycle(recovery.raw.reconcileSession(
      recovery.identity.userId,
      created.sessionId,
    ));
    const operation = await recovery.run(() =>
      recovery!.p.calendarOperationsV2.getByTurn(
        recovery!.identity.userId,
        created.sessionId,
        created.turnId,
      ));
    expect(operation).toMatchObject({
      operationId: succeeded?.operationId,
      googleEventId: succeeded?.googleEventId,
      state: 'succeeded',
      receipt: { operationId: succeeded?.operationId },
    });
    expect(recovery.provider.posts).toHaveLength(1);
    expect(recovery.provider.gets).toHaveLength(0);
    expect(recovery.modelBodies).toHaveLength(0);
  } catch (error) {
    failure = error;
  } finally {
    eventRelease.resolve();
    succeededEvent.mockRestore();
    if (recovery) {
      try {
        await recovery.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Recovery cleanup failed');
      }
    }
    if (!originalClosed) {
      try {
        await f.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Original cleanup failed');
      }
    }
  }
  if (failure !== undefined) throw failure;
});

it('in-flight Calendar result cannot publish a view or continuation after account invalidation', async () => {
  const f = await calendarToolLatencyFixture();
  const account = await f.run(() => f.owner.connections.currentAccount());
  const originalInvoke = f.owner.execution.invoke.bind(f.owner.execution);
  const invokeEntered = deferred<void>();
  const invokeRelease = deferred<void>();
  const invoke = vi.spyOn(f.owner.execution, 'invoke').mockImplementation(async input => {
    invokeEntered.resolve();
    await invokeRelease.promise;
    return originalInvoke(input);
  });
  const views: unknown[] = [];
  let failure: unknown;
  try {
    f.modelWires.push(
      loadWire('calendar_list_events', 'p4-invalid-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: { timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', maxResults: 10 },
      }, 'p4-invalid-call'),
      textWire('Late Calendar answer that must not publish.'),
    );
    const ids = await f.run(() => f.submit('List my events.'));
    const execution = f.execute(ids, new AbortController().signal);
    const observed = execution.then(() => undefined, () => undefined);
    await f.pumpUntil(() => invoke.mock.calls.length > 0, 'executor entry before invalidation');
    await invokeEntered.promise;
    expect(f.provider.posts).toHaveLength(0);
    invoke.mockRestore();

    f.raw.invalidateCalendarAccount(account, 'disconnect');
    invokeRelease.resolve();
    await f.driveLifecycle(observed);

    const completed = f.frames.filter(frame =>
      (frame as { event?: { type?: string } }).event?.type === 'calendar-view');
    expect(completed).toHaveLength(0);
    views.push(...completed);
    const history = f.raw.memoryFor(f.identity.userId)!.foundation.history(ids.sessionId);
    expect(history.some(message =>
      message.sourceProvenance?.some(source => source.redactedAt === null))).toBe(false);
    expect(f.provider.posts).toHaveLength(0);

    f.modelWires.push(textWire('Unrelated answer.'));
    const followUp = await f.run(() => f.submit('Explain an unrelated topic', ids.sessionId));
    await f.run(() => f.execute(followUp));
    expect(f.status(followUp)?.status).toBe('completed');
    expect(JSON.stringify(f.modelBodies)).not.toMatch(/private-event-canary/);
  } catch (error) {
    failure = error;
  } finally {
    invokeRelease.resolve();
    invoke.mockRestore();
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('mixed read and create in one turn keeps one complete pair and one create effect', async () => {
  const f = await calendarToolLatencyFixture();
  let failure: unknown;
  try {
    f.provider.events.set(JSON.stringify(['personal@example.test', 'evt123456']), {
      id: 'evt123456',
      summary: 'mixed-read-canary',
      status: 'confirmed',
      start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
      end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' },
    });
    const input = 'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.';
    f.modelWires.push(
      loadWire('calendar_list_events', 'mix-load-read'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'mix-read'),
      loadWire('calendar_create_event', 'mix-load-create'),
      createWire(event(), 'mix-create'),
      textWire('Read and created.'),
    );
    const ids = await f.run(() => f.submit(input));
    await f.run(() => f.execute(ids));
    expect(f.status(ids)?.status).toBe('completed');
    expect(f.provider.posts).toHaveLength(1);
    expect(f.provider.requests.filter(row => row.kind === 'events' && row.method === 'GET')).toHaveLength(1);
    expect(f.provider.requests.filter(row => row.kind === 'events' && row.method === 'POST')).toHaveLength(1);
    const readBody = f.modelBodies.find(body =>
      (body.messages as { tool_calls?: { id: string }[] }[])
        .some(message => message.tool_calls?.some(call => call.id === 'mix-read')));
    expect(readBody).toBeDefined();
    assertPair(readBody!, 'mix-read', input);
    expect(f.frames.some(frame =>
      (frame as { event?: { type?: string; operation?: { state?: string } } }).event?.type === 'calendar-operation'
      && (frame as { event?: { operation?: { state?: string } } }).event?.operation?.state === 'succeeded'))
      .toBe(true);
    const metadata = [...f.db.rows('metadata').values()];
    const budget = metadata.find(row =>
      row.kind === 'calendar-turn-budget' && row.turnId === ids.turnId);
    expect(budget).toMatchObject({ logicalTools: 2, creates: 1 });
    const operation = metadata.find(row =>
      row.kind === 'calendar-operation' && row.schemaVersion === 2
        && row.turnId === ids.turnId);
    expect(operation).toMatchObject({ state: 'succeeded', action: event() });
    expect(JSON.stringify({ commands: f.trace.commands, marks: f.trace.marks }))
      .not.toMatch(/mixed-read-canary/);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('competing text tabs keep one active attempt and one model effect', async () => {
  const f = await calendarToolLatencyFixture();
  const model = f.holdNextModel();
  let failure: unknown;
  try {
    f.modelWires.push(textWire('First answer.'));
    const first = await f.run(() => f.submit('First tab question.'));
    const execution = f.execute(first);
    await model.entered;
    await expect(f.run(() => f.submit('Second tab question.', first.sessionId)))
      .rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
    model.release();
    await f.driveLifecycle(execution);
    expect(f.status(first)?.status).toBe('completed');
    expect(f.modelBodies).toHaveLength(1);

    f.modelWires.push(textWire('Third answer.'));
    const third = await f.run(() => f.submit('Third tab question.', first.sessionId));
    await f.run(() => f.execute(third));
    expect(f.status(third)?.status).toBe('completed');
    expect(f.modelBodies).toHaveLength(2);
    expect(f.provider.posts).toHaveLength(0);
  } catch (error) {
    failure = error;
  } finally {
    model.release();
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('concurrent text and live confirmations consume one proposal and create once', async () => {
  const f = await calendarToolLatencyFixture();
  const reserveEntered = deferred<void>();
  const reserveRelease = deferred<void>();
  let liveReservation: Awaited<ReturnType<typeof f.acquireLive>> | undefined;
  let failure: unknown;
  try {
    f.modelWires.push(
      loadWire('calendar_create_event', 'live-conf-load'),
      createWire(event(), 'live-conf-create'),
    );
    const proposalTurn = await f.run(() => f.submit('create the event'));
    await f.run(() => f.execute(proposalTurn));
    const proposal = await f.run(() =>
      f.p.calendarProposals.getCurrent(f.identity.userId, proposalTurn.sessionId));
    expect(proposal).not.toBeNull();
    expect(f.provider.posts).toHaveLength(0);

    const confirm = await f.run(() => f.submit('yes', proposalTurn.sessionId, {
      proposalId: proposal!.proposalId,
      revision: proposal!.revision,
    }));
    const originalReserve = f.p.calendarOperationsV2.reserveByIntent.bind(f.p.calendarOperationsV2);
    let reserveCalled = false;
    let executionError: unknown;
    const reserve = vi.spyOn(f.p.calendarOperationsV2, 'reserveByIntent')
      .mockImplementation(async input => {
        if (input.operation.turnId === confirm.turnId) {
          reserveCalled = true;
          reserveEntered.resolve();
          await reserveRelease.promise;
        }
        return originalReserve(input);
      });
    const execution = f.execute(confirm).catch(error => {
      executionError = error;
      throw error;
    });
    await f.pumpUntil(() => reserveCalled || executionError !== undefined, 'confirmation reserve');
    if (!reserveCalled) throw executionError ?? new Error('Confirmation never reached the create barrier.');
    await expect(f.acquireLive('live-conflict', confirm.sessionId))
      .rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
    reserveRelease.resolve();
    await f.driveLifecycle(execution);
    reserve.mockRestore();
    expect(f.provider.posts).toHaveLength(1);
    expect(f.status(confirm)?.status).toBe('completed');

    liveReservation = await f.acquireLive('live-confirm', confirm.sessionId);
    const liveConfirm = await f.run(() => f.submitLive('yes', liveReservation!, confirm.sessionId, {
      voiceSessionId: 'live-confirm',
      calendarReplyTo: { proposalId: proposal!.proposalId, revision: proposal!.revision },
    }));
    await f.run(() => f.executeLive(liveConfirm, liveReservation!, {
      voiceSessionId: 'live-confirm',
    }).execution).catch(() => undefined);
    expect(f.provider.posts).toHaveLength(1);
    expect(f.status(liveConfirm)?.status).not.toBe('completed');
  } catch (error) {
    failure = error;
  } finally {
    reserveRelease.resolve();
    if (liveReservation) {
      try {
        await f.releaseLive(liveReservation.reservationId);
      } catch {
        // The reservation may already have been released by a failed live turn.
      }
    }
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('crash window W2 blocked variants never dispatch the planned create', { timeout: 30_000 }, async () => {
  const f = await calendarToolLatencyFixture();
  const barrierEntered = deferred<void>();
  const barrierRelease = deferred<void>();
  const originalCas = f.p.calendarOperationsV2.compareAndSwap.bind(f.p.calendarOperationsV2);
  let image: ReturnType<typeof durableImage> | null = null;
  const barrier = vi.spyOn(f.p.calendarOperationsV2, 'compareAndSwap').mockImplementation(async input => {
    if (input.next.state === 'dispatching') {
      image = durableImage(f.db);
      barrierEntered.resolve();
      await barrierRelease.promise;
    }
    return originalCas(input);
  });
  const recoveries: Awaited<ReturnType<typeof calendarToolLatencyFixture>>[] = [];
  let originalClosed = false;
  let failure: unknown;
  try {
    const controller = new AbortController();
    f.modelWires.push(
      loadWire('calendar_create_event', 'w2-load'),
      createWire(event(), 'w2-create'),
      textWire('Created.'),
    );
    const created = await f.run(() => f.submit(
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
    ));
    const execution = f.execute(created, controller.signal);
    await f.pumpUntil(() => image !== null, 'W2 planned-to-dispatching image');
    await barrierEntered.promise;
    const metadata = imageRows(image!, 'metadata');
    const planned = metadata.find(row =>
      row.kind === 'calendar-operation' && row.schemaVersion === 2
        && row.turnId === created.turnId);
    expect(planned).toMatchObject({ state: 'planned', originatingAttemptId: created.attemptId });
    expect(f.provider.posts).toHaveLength(0);

    controller.abort();
    barrierRelease.resolve();
    await f.driveLifecycle(execution).catch(() => undefined);
    barrier.mockRestore();
    await f.close();
    originalClosed = true;

    for (const variant of ['disabled', 'expired', 'role'] as const) {
      const r = await calendarToolLatencyFixture({ image: image!, provider: f.provider });
      recoveries.push(r);
      if (variant === 'disabled') await r.lifecycle.disable();
      if (variant === 'expired') r.advance(DEFAULT_BUDGETS.totalRunTimeoutMs + 60_000);
      if (variant === 'role') {
        r.provider.entry.accessRole = 'reader';
        await r.lifecycle.refreshCalendars();
      }
      await r.driveLifecycle(r.raw.reconcileSession(r.identity.userId, created.sessionId));
      expect(r.provider.posts, variant).toHaveLength(0);
      const operation = await r.run(() =>
        r.p.calendarOperationsV2.getByTurn(r.identity.userId, created.sessionId, created.turnId));
      expect(operation?.state, variant).not.toBe('succeeded');
      expect(r.modelBodies, variant).toHaveLength(0);
      if (variant === 'role') r.provider.entry.accessRole = 'owner';
    }
  } catch (error) {
    failure = error;
  } finally {
    barrierRelease.resolve();
    barrier.mockRestore();
    for (const r of recoveries) {
      try {
        await r.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Recovery cleanup failed');
      }
    }
    if (!originalClosed) {
      try {
        await f.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Original cleanup failed');
      }
    }
  }
  if (failure !== undefined) throw failure;
});

it('crash window W3 before send reads back the pinned ID without a POST', { timeout: 30_000 }, async () => {
  const f = await calendarToolLatencyFixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const originalInvoke = f.invokeOriginal;
  let image: ReturnType<typeof durableImage> | null = null;
  let operationId: string | null = null;
  let googleEventId: string | null = null;
  const invoke = vi.spyOn(f.owner.execution, 'invoke').mockImplementation(async input => {
    if (input.binding.operation?.state === 'dispatching') {
      image = durableImage(f.db);
      operationId = input.binding.operation.operationId;
      googleEventId = input.binding.operation.googleEventId;
      entered.resolve();
      await release.promise;
      throw new Error('synthetic crash before provider send');
    }
    return originalInvoke(input);
  });
  let recovery: Awaited<ReturnType<typeof calendarToolLatencyFixture>> | undefined;
  let originalClosed = false;
  let failure: unknown;
  try {
    f.modelWires.push(
      loadWire('calendar_create_event', 'w3-load'),
      createWire(event(), 'w3-create'),
      textWire('Created.'),
    );
    const created = await f.run(() => f.submit(
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
    ));
    const execution = f.execute(created);
    await f.pumpUntil(() => image !== null, 'W3 pre-send image');
    await entered.promise;
    expect(f.provider.posts).toHaveLength(0);
    release.resolve();
    await f.driveLifecycle(execution).catch(() => undefined);
    expect(f.provider.posts).toHaveLength(0);
    invoke.mockRestore();
    await f.close();
    originalClosed = true;

    recovery = await calendarToolLatencyFixture({ image: image!, provider: f.provider });
    await recovery.driveLifecycle(recovery.raw.reconcileSession(
      recovery.identity.userId,
      created.sessionId,
    ));
    expect(recovery.provider.posts).toHaveLength(0);
    expect(recovery.provider.gets.length).toBeGreaterThan(0);
    expect(recovery.provider.gets.every(row => row.eventId === googleEventId)).toBe(true);
    expect(recovery.modelBodies).toHaveLength(0);
    const operation = await recovery.run(() =>
      recovery!.p.calendarOperationsV2.getByTurn(
        recovery!.identity.userId,
        created.sessionId,
        created.turnId,
      ));
    expect(operation).toMatchObject({
      operationId,
      googleEventId,
      state: 'unknown',
    });
  } catch (error) {
    failure = error;
  } finally {
    release.resolve();
    invoke.mockRestore();
    if (recovery) {
      try {
        await recovery.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Recovery cleanup failed');
      }
    }
    if (!originalClosed) {
      try {
        await f.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Original cleanup failed');
      }
    }
  }
  if (failure !== undefined) throw failure;
});

it('succeeded operation with a missing event repairs the exact event without readback or POST', { timeout: 30_000 }, async () => {
  const f = await calendarToolLatencyFixture();
  const originalAppend = f.p.calendarOperationsV2.appendEventV2.bind(f.p.calendarOperationsV2);
  let image: ReturnType<typeof durableImage> | null = null;
  const append = vi.spyOn(f.p.calendarOperationsV2, 'appendEventV2').mockImplementation(async record => {
    if (record.state === 'succeeded') {
      image = durableImage(f.db);
      throw new Error('synthetic succeeded-event acknowledgement unavailable');
    }
    return originalAppend(record);
  });
  let recovery: Awaited<ReturnType<typeof calendarToolLatencyFixture>> | undefined;
  let originalClosed = false;
  let failure: unknown;
  try {
    f.modelWires.push(
      loadWire('calendar_create_event', 'split-load'),
      createWire(event(), 'split-create'),
      textWire('Created.'),
    );
    const created = await f.run(() => f.submit(
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
    ));
    await f.driveLifecycle(f.execute(created)).catch(() => undefined);
    expect(image).not.toBeNull();
    expect(f.provider.posts).toHaveLength(1);
    const before = imageRows(image!, 'metadata');
    const succeeded = before.find(row =>
      row.kind === 'calendar-operation' && row.schemaVersion === 2
        && row.turnId === created.turnId);
    expect(succeeded).toMatchObject({ state: 'succeeded' });
    expect(before.some(row =>
      row.kind === 'calendar-operation-event-v2' && row.turnId === created.turnId
      && row.state === 'succeeded')).toBe(false);

    append.mockRestore();
    await f.close();
    originalClosed = true;

    recovery = await calendarToolLatencyFixture({ image: image!, provider: f.provider });
    await recovery.driveLifecycle(recovery.raw.reconcileSession(
      recovery.identity.userId,
      created.sessionId,
    ));
    expect(recovery.provider.posts).toHaveLength(1);
    expect(recovery.provider.gets).toHaveLength(0);
    expect(recovery.modelBodies).toHaveLength(0);
    const events = await recovery.run(() =>
      recovery!.p.calendarOperationsV2.listEventsV2({
        userId: recovery!.identity.userId,
        sessionId: created.sessionId,
        operationId: succeeded!.operationId as string,
      }));
    expect(events.some(record => record.state === 'succeeded')).toBe(true);
  } catch (error) {
    failure = error;
  } finally {
    append.mockRestore();
    if (recovery) {
      try {
        await recovery.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Recovery cleanup failed');
      }
    }
    if (!originalClosed) {
      try {
        await f.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Original cleanup failed');
      }
    }
  }
  if (failure !== undefined) throw failure;
});

it.each(['disconnect', 'disable'] as const)('%s invalidates prepared authority before the next read', async mode => {
  const f = await calendarToolLatencyFixture();
  let failure: unknown;
  try {
    const account = await f.run(() => f.owner.connections.currentAccount());
    const requestsBefore = f.provider.requests.length;
    if (mode === 'disconnect') await f.lifecycle.disconnect();
    else await f.lifecycle.disable();
    await expect(f.run(() => f.owner.connections.currentAccount())).rejects.toBeDefined();
    await expect(f.run(() => f.owner.connections.requireAccountCurrent(
      account,
      new AbortController().signal,
    ))).rejects.toBeDefined();
    f.modelWires.push(
      loadWire('calendar_list_events', 'invalid-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'invalid-call'),
      textWire('Calendar unavailable.'),
    );
    const ids = await f.run(() => f.submit('List my events.'));
    await f.run(() => f.execute(ids)).catch(() => undefined);
    expect(f.provider.requests.length).toBe(requestsBefore);
    expect(f.provider.posts).toHaveLength(0);
    expect(f.frames.some(frame =>
      (frame as { event?: { type?: string } }).event?.type === 'calendar-view')).toBe(false);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('implicit default change routes the next create to the new calendar', async () => {
  const f = await calendarToolLatencyFixture();
  let failure: unknown;
  try {
    f.provider.addCalendar({
      calendarId: 'work@example.test',
      label: 'Work',
      primary: false,
      accessRole: 'writer',
      privateAccess: true,
      timeZone: 'Etc/UTC',
      selected: true,
      hidden: false,
      deleted: false,
      capabilities: { readEvents: true, createEvents: true, availability: true },
    });
    await f.lifecycle.refreshCalendars();
    await f.lifecycle.setDefault('work@example.test');
    f.modelWires.push(
      loadWire('calendar_create_event', 'default-load'),
      createWire(event(), 'default-create'),
      textWire('Created.'),
    );
    const ids = await f.run(() => f.submit(
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
    ));
    await f.run(() => f.execute(ids));
    expect(f.provider.posts).toHaveLength(1);
    expect(f.provider.posts[0]?.calendarId).toBe('work@example.test');
    const operation = [...f.db.rows('metadata').values()].find(row =>
      row.kind === 'calendar-operation' && row.turnId === ids.turnId);
    expect(operation).toMatchObject({
      calendarId: 'work@example.test',
      state: 'succeeded',
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('target role loss denies a create before any provider write', async () => {
  const f = await calendarToolLatencyFixture();
  let failure: unknown;
  try {
    f.provider.entry.accessRole = 'reader';
    await f.lifecycle.refreshCalendars();
    f.modelWires.push(
      loadWire('calendar_create_event', 'role-load'),
      createWire(event(), 'role-create'),
      textWire('Calendar is read-only.'),
    );
    const ids = await f.run(() => f.submit(
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
    ));
    await f.run(() => f.execute(ids)).catch(() => undefined);
    expect(f.provider.posts).toHaveLength(0);
    const operation = [...f.db.rows('metadata').values()].find(row =>
      row.kind === 'calendar-operation' && row.turnId === ids.turnId);
    expect(operation?.state).not.toBe('succeeded');
  } catch (error) {
    failure = error;
  } finally {
    f.provider.entry.accessRole = 'owner';
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('source expiry at exactly expiresAt forces a fresh provider read', { timeout: 30_000 }, async () => {
  const sourceLifetimeMs = 24 * 3_600_000;
  const policyLifetimeMs = 2 * sourceLifetimeMs;
  const f = await calendarToolLatencyFixture({
    tokenLifetimeMs: 7 * 24 * 3_600_000,
    policyLifetimeMs,
  });
  const policyDeadline = Date.now() + policyLifetimeMs;
  f.observeArchive();
  let failure: unknown;
  try {
    f.provider.events.set(JSON.stringify(['personal@example.test', 'evt123456']), {
      id: 'evt123456',
      summary: 'expired-source-content',
      status: 'confirmed',
      start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
      end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' },
    });
    f.modelWires.push(
      loadWire('calendar_list_events', 'expiry-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'expiry-call'),
      textWire('First read.'),
    );
    const first = await f.run(() => f.submit('List my events.'));
    await f.run(() => f.execute(first));
    await f.pumpUntil(() => f.trace.marks.some(mark => mark.name === 'save-end')
      && f.probe.waiting === 0, 'first archive save before expiry');
    const completed = f.frames.find(frame =>
      (frame as { event?: { type?: string } }).event?.type === 'completed') as
      { event?: { calendarView?: { expiresAt?: string } } } | undefined;
    const expiresAt = completed?.event?.calendarView?.expiresAt;
    expect(expiresAt).toEqual(expect.any(String));
    expect(Date.parse(expiresAt!)).toBe(Date.now() + sourceLifetimeMs);
    expect(Date.parse(expiresAt!)).toBeLessThan(Date.now() + policyLifetimeMs);
    const requestsBefore = f.provider.requests.length;
    f.advance(Date.parse(expiresAt!) - Date.now());
    expect(Date.now()).toBeLessThan(policyDeadline);
    f.provider.events.set(JSON.stringify(['personal@example.test', 'evt123456']), {
      id: 'evt123456',
      summary: 'fresh-provider-content',
      status: 'confirmed',
      start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
      end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' },
    });
    const modelBodiesBeforeSecondRead = f.modelBodies.length;
    f.modelWires.push(
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'expiry-call-2'),
      textWire('Second read.'),
    );
    const second = await f.run(() => f.submit('List my events again.', first.sessionId));
    await f.run(() => f.execute(second));
    expect(f.status(second)?.status).toBe('completed');
    expect(f.provider.requests.length).toBeGreaterThan(requestsBefore);
    expect(f.provider.requests.slice(requestsBefore)).toContainEqual({ method: 'GET', kind: 'events' });
    const refreshedPrompt = JSON.stringify(f.modelBodies.slice(modelBodiesBeforeSecondRead));
    expect(refreshedPrompt).toContain('fresh-provider-content');
    expect(refreshedPrompt).not.toContain('expired-source-content');
  } catch (error) {
    failure = error;
  } finally {
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('expired policy denies a Calendar read without a provider request or stale content', async () => {
  const f = await calendarToolLatencyFixture({
    tokenLifetimeMs: 7 * 24 * 3_600_000,
  });
  f.observeArchive();
  try {
    f.provider.events.set(JSON.stringify(['personal@example.test', 'evt123456']), {
      id: 'evt123456',
      summary: 'policy-expired-source-content',
      status: 'confirmed',
      start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
      end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' },
    });
    const readWire = (callId: string) => skillWire('call_tool', {
      plugin: 'google-calendar',
      tool: 'calendar_list_events',
      arguments: {
        timeMin: '2026-11-03T10:00:00Z',
        timeMax: '2026-11-03T11:00:00Z',
        maxResults: 10,
      },
    }, callId);
    f.modelWires.push(
      loadWire('calendar_list_events', 'policy-expiry-load'),
      readWire('policy-expiry-call-1'),
      textWire('First read.'),
    );
    const first = await f.run(() => f.submit('List my events.'));
    await f.run(() => f.execute(first));
    await f.pumpUntil(() => f.trace.marks.some(mark => mark.name === 'save-end')
      && f.probe.waiting === 0, 'first archive save before policy expiry');
    const completed = f.frames.find(frame =>
      (frame as { event?: { type?: string } }).event?.type === 'completed') as
      { event?: { calendarView?: { expiresAt?: string } } } | undefined;
    const expiresAt = completed?.event?.calendarView?.expiresAt;
    expect(expiresAt).toEqual(expect.any(String));

    const requestsBefore = f.provider.requests.length;
    const modelBodiesBeforeSecondRead = f.modelBodies.length;
    const framesBefore = f.frames.length;
    f.advance(Date.parse(expiresAt!) - Date.now());
    f.modelWires.push(readWire('policy-expiry-call-2'), textWire('Second read.'));
    const second = await f.run(() => f.submit('List my events again.', first.sessionId));
    await f.run(() => f.execute(second));

    expect(f.status(second)?.status).toBe('completed');
    expect(f.provider.requests.slice(requestsBefore)).toEqual([]);
    const secondFrames = f.frames.slice(framesBefore);
    expect(secondFrames.some(frame =>
      (frame as { event?: { type?: string } }).event?.type === 'calendar-view')).toBe(false);
    expect(JSON.stringify(secondFrames)).toMatch(/not available|not allowed/);
    expect(JSON.stringify(f.modelBodies.slice(modelBodiesBeforeSecondRead)))
      .not.toContain('policy-expired-source-content');
  } finally {
    await f.close();
  }
});

it('expired credentials fail closed without a stale calendar view', async () => {
  const f = await calendarToolLatencyFixture({
    tokenLifetimeMs: 1_000,
    discoveryLifetimeMs: 1_000,
  });
  let failure: unknown;
  try {
    f.advance(1_001);
    f.modelWires.push(
      loadWire('calendar_list_events', 'cred-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'cred-call'),
      textWire('Calendar unavailable.'),
    );
    const ids = await f.run(() => f.submit('List my events.'));
    await f.run(() => f.execute(ids)).catch(() => undefined);
    expect(f.provider.requests).toHaveLength(0);
    expect(f.frames.some(frame =>
      (frame as { event?: { type?: string } }).event?.type === 'calendar-view')).toBe(false);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('account replacement invalidates the old prepared authority and serves the new account', async () => {
  const f = await calendarToolLatencyFixture();
  let failure: unknown;
  try {
    const before = await f.run(() => f.owner.connections.currentAccount());
    await f.lifecycle.replaceAccount();
    const after = await f.run(() => f.owner.connections.currentAccount());
    expect(after.connectionId).not.toBe(before.connectionId);
    expect(after.googleSubjectId).toBe('google-sub-replacement');
    await expect(f.run(() => f.owner.connections.requireAccountCurrent(
      before,
      new AbortController().signal,
    ))).rejects.toBeDefined();
    f.modelWires.push(
      loadWire('calendar_list_events', 'replace-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'replace-call'),
      textWire('Read after replacement.'),
    );
    const ids = await f.run(() => f.submit('List my events.'));
    await f.run(() => f.execute(ids));
    expect(f.status(ids)?.status).toBe('completed');
    expect(f.provider.requests.some(row => row.kind === 'events' && row.method === 'GET')).toBe(true);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('text read and live follow-up share one attempt while an archive is held', { timeout: 30_000 }, async () => {
  const f = await calendarToolLatencyFixture();
  f.observeArchive();
  const save = f.holdNextArchiveSave();
  let reservation: Awaited<ReturnType<typeof f.acquireLive>> | undefined;
  let failure: unknown;
  try {
    f.modelWires.push(textWire('Earlier answer.'));
    const earlier = await f.run(() => f.submit('Earlier question.'));
    await f.run(() => f.execute(earlier));
    await save.entered;

    reservation = await f.acquireLive('live-follow', earlier.sessionId);
    f.provider.events.set(JSON.stringify(['personal@example.test', 'evt123456']), {
      id: 'evt123456',
      summary: 'live-follow-canary',
      status: 'confirmed',
      start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
      end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' },
    });
    f.modelWires.push(
      loadWire('calendar_list_events', 'live-follow-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'live-follow-call'),
      textWire('Live answer.'),
    );
    const liveIds = await f.run(() => f.submitLive(
      'List my events.',
      reservation!,
      earlier.sessionId,
      { voiceSessionId: 'live-follow' },
    ));
    const live = f.executeLive(liveIds, reservation!, { voiceSessionId: 'live-follow' });
    await f.run(() => live.execution);
    expect(f.status(liveIds)?.status).toBe('completed');
    expect(live.spoken.join('')).toBe('Live answer.');
    expect(f.provider.posts).toHaveLength(0);
    expect(f.provider.requests.some(row => row.kind === 'events' && row.method === 'GET')).toBe(true);

    await f.releaseLive(reservation.reservationId);
    reservation = undefined;
    f.modelWires.push(textWire('Text follow-up.'));
    const follow = await f.run(() => f.submit('Text follow-up.', earlier.sessionId));
    await f.run(() => f.execute(follow));
    expect(f.status(follow)?.status).toBe('completed');

    save.release();
    const drained = await f.driveLifecycle(f.raw.drain(500));
    expect(drained.drained).toBe(true);
  } catch (error) {
    failure = error;
  } finally {
    save.release();
    if (reservation) {
      try {
        await f.releaseLive(reservation.reservationId);
      } catch {
        // The reservation may already have been released by a failed live turn.
      }
    }
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it.each([0, 8])('profiles list-events prepared with %s prior turns', { timeout: 30_000 }, async priorTurns => {
  const f = await calendarToolLatencyFixture({ readMs: 67, writeMs: 449 });
  let failure: unknown;
  try {
    await prepareProfileFixture(f, priorTurns);
    f.provider.events.set(JSON.stringify(['personal@example.test', 'evt123456']), {
      id: 'evt123456',
      summary: 'profile-canary',
      status: 'confirmed',
      start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
      end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' },
    });
    const result = await measureProfileTurn(f, 'List my events.', [
      loadWire('calendar_list_events', 'profile-list-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'profile-list-call'),
      textWire('Listed.'),
    ]);
    expect(f.status(result.ids)?.status).toBe('completed');
    expect(f.provider.posts).toHaveLength(0);
    expect(f.provider.requests.some(row => row.kind === 'events' && row.method === 'GET')).toBe(true);
    emitProfile({
      scenario: 'list-events',
      preparation: priorTurns === 0 ? 'prepared-new-session' : 'prepared-warm-session',
      priorTurns,
      result,
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('profiles get-event and availability prepared', { timeout: 30_000 }, async () => {
  const f = await calendarToolLatencyFixture({ readMs: 67, writeMs: 449 });
  let failure: unknown;
  try {
    await prepareProfileFixture(f, 0);
    f.provider.events.set(JSON.stringify(['personal@example.test', 'evt123456']), {
      id: 'evt123456',
      summary: 'profile-canary',
      status: 'confirmed',
      start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
      end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' },
    });
    const getEvent = await measureProfileTurn(f, 'Read event evt123456.', [
      loadWire('calendar_get_event', 'profile-get-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_get_event',
        arguments: { calendarId: 'personal@example.test', eventId: 'evt123456' },
      }, 'profile-get-call'),
      textWire('Read event.'),
    ]);
    expect(f.status(getEvent.ids)?.status).toBe('completed');
    emitProfile({
      scenario: 'get-event',
      preparation: 'prepared-new-session',
      priorTurns: 0,
      result: getEvent,
    });

    const availability = await measureProfileTurn(f, 'Check availability.', [
      loadWire('calendar_check_availability', 'profile-availability-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_check_availability',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          timeZone: 'Etc/UTC',
          calendarIds: ['personal@example.test'],
        },
      }, 'profile-availability-call'),
      textWire('Availability checked.'),
    ]);
    expect(f.status(availability.ids)?.status).toBe('completed');
    emitProfile({
      scenario: 'availability',
      preparation: 'prepared-new-session',
      priorTurns: 0,
      result: availability,
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it.each([0, 8])('profiles direct create prepared with %s prior turns', { timeout: 30_000 }, async priorTurns => {
  const f = await calendarToolLatencyFixture({ readMs: 67, writeMs: 449 });
  let failure: unknown;
  try {
    await prepareProfileFixture(f, priorTurns);
    const result = await measureProfileTurn(f, 'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', [
      loadWire('calendar_create_event', 'profile-create-load'),
      createWire(event(), 'profile-create-call'),
      textWire('Created.'),
    ]);
    expect(f.status(result.ids)?.status).toBe('completed');
    expect(f.provider.posts).toHaveLength(1);
    emitProfile({
      scenario: 'direct-create',
      preparation: priorTurns === 0 ? 'prepared-new-session' : 'prepared-warm-session',
      priorTurns,
      result,
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('profiles proposal confirmation explicit and unreferenced', { timeout: 30_000 }, async () => {
  for (const referenced of [true, false]) {
    const f = await calendarToolLatencyFixture({ readMs: 67, writeMs: 449 });
    let failure: unknown;
    try {
      f.observeArchive();
      f.modelWires.push(
        loadWire('calendar_create_event', 'profile-proposal-load'),
        createWire(event(), 'profile-proposal-call'),
      );
      const proposalTurn = await f.run(() => f.submit('create the event'));
      await f.run(() => f.execute(proposalTurn));
      await f.pumpUntil(() => f.trace.marks.some(mark => mark.name === 'save-end')
        && f.probe.waiting === 0, 'proposal archive save');
      const proposal = await f.run(() =>
        f.p.calendarProposals.getCurrent(f.identity.userId, proposalTurn.sessionId));
      expect(proposal).not.toBeNull();
      const result = await measureProfileTurn(f, 'yes', [], {
        sessionId: proposalTurn.sessionId,
        ...(referenced ? {
          replyTo: { proposalId: proposal!.proposalId, revision: proposal!.revision },
        } : {}),
      });
      expect(f.status(result.ids)?.status).toBe('completed');
      expect(f.provider.posts).toHaveLength(1);
      emitProfile({
        scenario: referenced ? 'proposal-confirmation-referenced' : 'proposal-confirmation-unreferenced',
        preparation: 'prepared-new-session',
        priorTurns: 0,
        result,
      });
    } catch (error) {
      failure = error;
    } finally {
      try {
        await f.close();
      } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
      }
    }
    if (failure !== undefined) throw failure;
  }
});

it('profiles cold existing session with saved history', { timeout: 30_000 }, async () => {
  const warm = await calendarToolLatencyFixture({ readMs: 67, writeMs: 449 });
  let image: ReturnType<typeof durableImage> = {};
  let earlierSessionId: string | null = null;
  let failure: unknown;
  try {
    warm.observeArchive();
    warm.modelWires.push(textWire('Earlier answer.'));
    const earlier = await warm.run(() => warm.submit('Earlier question.'));
    earlierSessionId = earlier.sessionId;
    await warm.run(() => warm.execute(earlier));
    await warm.pumpUntil(() => warm.trace.marks.some(mark => mark.name === 'save-end')
      && warm.probe.waiting === 0, 'cold history save');
  } finally {
    await warm.close();
  }
  image = durableImage(warm.db);
  const cold = await calendarToolLatencyFixture({
    image,
    readMs: 67,
    writeMs: 449,
    startSerial: 1,
  });
  try {
    cold.observeArchive();
    const result = await measureProfileTurn(cold, 'List my events.', [
      loadWire('calendar_list_events', 'profile-cold-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'profile-cold-call'),
      textWire('Listed.'),
    ], { sessionId: earlierSessionId });
    expect(cold.status(result.ids)?.status).toBe('completed');
    expect(JSON.stringify(cold.modelBodies[0])).toContain('Earlier question.');
    expect(cold.provider.posts).toHaveLength(0);
    expect(cold.provider.requests.some(row => row.kind === 'events' && row.method === 'GET')).toBe(true);
    emitProfile({
      scenario: 'list-events',
      preparation: 'cold-existing-session',
      priorTurns: 1,
      result,
      limitations: 'Cold hydration profile; synthetic wave model, not live latency.',
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cold.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('profiles mixed read/create and text/live contention', { timeout: 30_000 }, async () => {
  const mixed = await calendarToolLatencyFixture({ readMs: 67, writeMs: 449 });
  let failure: unknown;
  try {
    mixed.observeArchive();
    mixed.provider.events.set(JSON.stringify(['personal@example.test', 'evt123456']), {
      id: 'evt123456',
      summary: 'profile-canary',
      status: 'confirmed',
      start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
      end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' },
    });
    const result = await measureProfileTurn(mixed,
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', [
        loadWire('calendar_list_events', 'profile-mix-load-read'),
        skillWire('call_tool', {
          plugin: 'google-calendar',
          tool: 'calendar_list_events',
          arguments: {
            timeMin: '2026-11-03T10:00:00Z',
            timeMax: '2026-11-03T11:00:00Z',
            maxResults: 10,
          },
        }, 'profile-mix-read'),
        loadWire('calendar_create_event', 'profile-mix-load-create'),
        createWire(event(), 'profile-mix-create'),
        textWire('Read and created.'),
      ]);
    expect(mixed.status(result.ids)?.status).toBe('completed');
    expect(mixed.provider.posts).toHaveLength(1);
    emitProfile({
      scenario: 'mixed-read-create',
      preparation: 'prepared-new-session',
      priorTurns: 0,
      result,
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await mixed.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;

  const live = await calendarToolLatencyFixture({ readMs: 67, writeMs: 449 });
  let reservation: Awaited<ReturnType<typeof live.acquireLive>> | undefined;
  try {
    live.observeArchive();
    live.provider.events.set(JSON.stringify(['personal@example.test', 'evt123456']), {
      id: 'evt123456',
      summary: 'profile-canary',
      status: 'confirmed',
      start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
      end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' },
    });
    live.resetProfile();
    const liveSession = live.nextLiveSessionId();
    reservation = await live.acquireLive('profile-live');
    reservation = await live.bindLive(reservation.reservationId, liveSession);
    live.modelWires.push(
      loadWire('calendar_list_events', 'profile-live-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'profile-live-call'),
      textWire('Live answer.'),
    );
    const realStart = performance.now();
    const liveIds = await live.run(() => live.submitLive(
      'List my events.',
      reservation!,
      liveSession,
      { voiceSessionId: 'profile-live', freshConversation: true },
    ));
    const execution = live.executeLive(liveIds, reservation!, { voiceSessionId: 'profile-live' });
    await live.run(() => execution.execution);
    const realElapsedMs = performance.now() - realStart;
    await live.pumpUntil(() => live.trace.marks.some(mark => mark.name === 'save-end')
      && live.probe.waiting === 0, 'live profile save');
    expect(live.status(liveIds)?.status).toBe('completed');
    expect(execution.spoken.join('')).toBe('Live answer.');
    expect(live.provider.posts).toHaveLength(0);
    emitProfile({
      scenario: 'text-live-contention',
      preparation: 'prepared-new-session',
      priorTurns: 0,
      result: {
        ids: liveIds,
        snapshot: live.profileSnapshot(),
        realElapsedMs,
      },
      limitations: 'Deterministic live runtime profile; not LiveKit transport or audio certification.',
    });
  } catch (error) {
    failure = error;
  } finally {
    if (reservation) {
      try {
        await live.releaseLive(reservation.reservationId);
      } catch {
        // The reservation may already have been released by a failed live turn.
      }
    }
    try {
      await live.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('two sessions do not share retained Calendar content', async () => {
  const f = await calendarToolLatencyFixture();
  let failure: unknown;
  try {
    f.provider.events.set(JSON.stringify(['personal@example.test', 'evt123456']), {
      id: 'evt123456',
      summary: 'session-isolation-canary',
      status: 'confirmed',
      start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'Etc/UTC' },
      end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' },
    });
    f.modelWires.push(
      loadWire('calendar_list_events', 'isolation-load'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: {
          timeMin: '2026-11-03T10:00:00Z',
          timeMax: '2026-11-03T11:00:00Z',
          maxResults: 10,
        },
      }, 'isolation-call'),
      textWire('Session A read.'),
    );
    const first = await f.run(() => f.submit('List my events.'));
    await f.run(() => f.execute(first));
    expect(f.status(first)?.status).toBe('completed');
    expect(f.provider.posts).toHaveLength(0);

    f.modelWires.push(textWire('Session B answer.'));
    const second = await f.run(() => f.submit('Unrelated question.'));
    await f.run(() => f.execute(second));
    expect(f.status(second)?.status).toBe('completed');
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(JSON.stringify(f.modelBodies.at(-1))).not.toMatch(/session-isolation-canary/);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});

it('provider-confirmed create continues while its result projection is held', async () => {
  const f = await calendarToolLatencyFixture();
  const resultEntered = deferred<void>();
  const resultRelease = deferred<void>();
  const originalPut = f.p.calendarResultsV2.put.bind(f.p.calendarResultsV2);
  let resultImage: ReturnType<typeof durableImage> | null = null;
  const putObserver = vi.spyOn(f.p.calendarResultsV2, 'put').mockImplementation(async record => {
    resultImage = durableImage(f.db);
    resultEntered.resolve();
    await resultRelease.promise;
    return originalPut(record);
  });
  let failure: unknown;
  try {
    f.modelWires.push(
      loadWire('calendar_create_event', 'p4-result-load'),
      createWire(event(), 'p4-result-create'),
      textWire('Follow-up complete.'),
    );
    const created = await f.run(() => f.submit(
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
    ));
    let executionSettled = false;
    let executionFailure: unknown;
    const execution = f.execute(created).then(
      () => { executionSettled = true; },
      error => { executionFailure = error; executionSettled = true; },
    );
    await f.pumpUntil(() => resultImage !== null, 'post-success result projection');
    await resultEntered.promise;
    const operation = imageRows(resultImage!, 'metadata').find(row =>
      row.kind === 'calendar-operation' && row.schemaVersion === 2
        && row.turnId === created.turnId);
    expect(operation).toMatchObject({ state: 'succeeded', receipt: { operationId: operation?.operationId } });
    expect(f.provider.posts).toHaveLength(1);
    for (let turn = 0; turn < 1000 && !executionSettled; turn++) await flushImmediate();
    expect(executionSettled).toBe(true);
    expect(executionFailure).toBeUndefined();
    expect(f.status(created)).toMatchObject({
      status: 'completed',
      save: { durableVersion: 0 },
    });

    const modelCountBeforeFollowUp = f.modelBodies.length;
    const followUp = await f.run(() => f.submit('Follow up before result projection settles.', created.sessionId));
    await f.run(() => f.execute(followUp));
    expect(f.status(followUp)?.status).toBe('completed');
    expect(f.modelBodies).toHaveLength(modelCountBeforeFollowUp + 1);
    expect(f.provider.posts).toHaveLength(1);

    resultRelease.resolve();
    await f.driveLifecycle(execution);
  } catch (error) {
    failure = error;
  } finally {
    resultRelease.resolve();
    putObserver.mockRestore();
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});
