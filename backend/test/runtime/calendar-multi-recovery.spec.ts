/**
 * ============================================================================
 * FILE: calendar-multi-recovery.spec.ts
 * LOCATION: backend/test/runtime/calendar-multi-recovery.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove that an interrupted multi-calendar turn is continued from its
 *    durable evidence alone, never from free-form history and never with a
 *    paid or write replay.
 *
 * ROLE IN PROJECT:
 *    The continuation classifier decides what a crashed turn may do next from
 *    the saved decision, the saved result, the consumed proposal and the saved
 *    operation. The crash-window tests hold that the runtime never creates a
 *    second event and never charges a second logical tool while the original
 *    effect is still unknown.
 *
 * KEY COMPONENTS:
 *    - Classifier tests: One branch per durable evidence shape.
 *    - Crash windows: proposal save, proposal consume, logical debit, create debit.
 * ============================================================================
 */

import { BSON, type MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import {
  classifyCalendarContinuationV2,
  pendingCalendarOperation,
} from '../../src/chat-runtime/calendar-recovery.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { operationEventV2Schema, operationRecordSchema, operationRecordV2Schema } from '../../src/contracts/calendar-operations.js';
import { calendarInputSchemas } from '../../src/contracts/calendar-tools.js';
import { MongoCalendarConnections } from '../../src/persistence/calendar-connections.js';
import { MongoCalendarOperations } from '../../src/persistence/calendar-operations.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { connectedCalendarMemory, connectionV2, directOperation } from '../persistence/calendar-multi-fixtures.js';
import { operationV1 } from '../contracts/calendar-multi-fixtures.js';
import { calendarFixture, createWire, skillWire, textWire } from './calendar-runtime.fixture.js';
import { busy, disclose, event } from './calendar-multi-fixture.js';

const action = calendarInputSchemas.calendar_create_event.parse({
  summary: 'Planning', start: '2026-11-03T10:00:00+00:00',
  end: '2026-11-03T11:00:00+00:00', timeZone: 'Etc/UTC',
});
const request = 'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.';

const base = {
  sealed: false, decisionId: null, toolCallId: null, intentId: null, operationId: null,
  operationState: null, resultRetained: false, resultExpired: false, proposalConsumed: false,
  consumptionConfirmed: false, dispatchedWithoutDecision: false, deadlinePassed: false,
};

describe('Calendar continuation classifier', () => {
  it('reuses the exact saved decision when no tool effect happened', () => {
    expect(classifyCalendarContinuationV2({ ...base, decisionId: 'decision-1' }))
      .toEqual({ kind: 'reuse-decision', decisionId: 'decision-1' });
  });

  it('rebuilds the group from a saved complete retained result', () => {
    expect(classifyCalendarContinuationV2({
      ...base, decisionId: 'decision-1', toolCallId: 'call-1', resultRetained: true,
    })).toEqual({ kind: 'reuse-result', decisionId: 'decision-1', toolCallId: 'call-1' });
  });

  it('repairs a consumed proposal from its confirmed consumption', () => {
    expect(classifyCalendarContinuationV2({
      ...base, intentId: 'intent-1', proposalConsumed: true, consumptionConfirmed: true,
    })).toEqual({ kind: 'repair-consumption', intentId: 'intent-1' });
  });

  it('interrupts when the consumption confirmation was lost', () => {
    expect(classifyCalendarContinuationV2({
      ...base, intentId: 'intent-1', proposalConsumed: true, consumptionConfirmed: false,
    })).toEqual({ kind: 'interrupt', code: 'EVIDENCE_MISSING' });
  });

  it('requires a fresh final check before the first dispatch of a planned operation', () => {
    expect(classifyCalendarContinuationV2({
      ...base, operationId: 'operation-1', operationState: 'planned',
    })).toEqual({ kind: 'dispatch-planned', operationId: 'operation-1' });
  });

  it('allows only the original readback for a dispatched or unknown operation', () => {
    for (const state of ['dispatching', 'unknown']) {
      expect(classifyCalendarContinuationV2({
        ...base, operationId: 'operation-1', operationState: state,
      })).toEqual({ kind: 'reconcile-operation', operationId: 'operation-1' });
    }
  });

  it('publishes a succeeded operation and a sealed turn', () => {
    expect(classifyCalendarContinuationV2({
      ...base, operationId: 'operation-1', operationState: 'succeeded',
    })).toEqual({ kind: 'publish', seal: null });
    expect(() => classifyCalendarContinuationV2({ ...base, sealed: true })).toThrow();
  });

  it('interrupts an inference whose outcome is unknown', () => {
    expect(classifyCalendarContinuationV2({ ...base, dispatchedWithoutDecision: true }))
      .toEqual({ kind: 'interrupt', code: 'INFERENCE_OUTCOME_UNKNOWN' });
  });

  it('interrupts an expired result and an expired deadline', () => {
    expect(classifyCalendarContinuationV2({ ...base, resultExpired: true }))
      .toEqual({ kind: 'interrupt', code: 'EVIDENCE_EXPIRED' });
    expect(classifyCalendarContinuationV2({ ...base, deadlinePassed: true }))
      .toEqual({ kind: 'interrupt', code: 'TURN_DEADLINE_EXCEEDED' });
  });
});

describe('Calendar crash windows', () => {
  it('never charges a second logical tool or creates a second event', async () => {
    const h = calendarFixture();
    try {
      const ids = await h.submit(request);
      h.modelWires.push(createWire(action, 'create-one'));
      h.failOnce('create-debit');
      await expect(h.execute(ids)).rejects.toBeDefined();
      // The create was refused by its own durable debit: no event was written.
      expect(h.effects.filter(e => e.kind === 'create')).toHaveLength(0);
      const budget = await h.p.calendarAccountingV2.getBudget(h.identity.userId, ids.sessionId, ids.turnId);
      expect(budget?.creates).toBe(0);
      const operation = await h.p.calendarOperationsV2.getByTurn(h.identity.userId, ids.sessionId, ids.turnId);
      expect(operation).toBeNull();
    } finally { await h.dispose(); }
  });

  it('keeps a consumed proposal without an operation from creating an event', async () => {
    const h = calendarFixture();
    try {
      h.setAvailability({ busy: [busy('2026-11-03T10:15:00Z', '2026-11-03T10:30:00Z')] });
      const first = await disclose(h, request, event());
      expect(first.proposal.purpose).toBe('conflict');
      const reply = await h.reply(first.proposal, 'Yes, go ahead', first.ids.sessionId);
      // The consumption is durable, the operation never is.
      h.failOnce('operation-reserve');
      await expect(h.execute(reply)).rejects.toBeDefined();
      expect(h.effects.filter(e => e.kind === 'create')).toHaveLength(0);
      const operation = await h.p.calendarOperationsV2.getByTurn(h.identity.userId, reply.sessionId, reply.turnId);
      expect(operation).toBeNull();
      // The approval was consumed once and is never replayed.
      expect((await h.proposalAuthority(first.proposal)).state).toBe('consumed');
    } finally { await h.dispose(); }
  });

  it('never charges the logical tool twice for the same model decision', async () => {
    const h = calendarFixture();
    try {
      const ids = await h.submit('Read event abcde');
      h.modelWires.push(
        skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_get_event'] }, 'load'),
        skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_get_event',
          arguments: { eventId: 'abcde' } }, 'get'), textWire('Found it.'));
      h.failOnce('logical-debit');
      await expect(h.execute(ids)).rejects.toBeDefined();
      const budget = await h.p.calendarAccountingV2.getBudget(h.identity.userId, ids.sessionId, ids.turnId);
      expect(budget?.logicalTools).toBe(0);
      // The refused logical tool never reached the provider.
      expect(h.effects.filter(e => e.kind === 'get')).toHaveLength(0);
    } finally { await h.dispose(); }
  });
});

describe('Calendar checkpointless operation discovery', () => {
  it.each(['planned', 'dispatching', 'unknown'] as const)(
    'discovers %s v2 operations across empty graph values and unrelated latestTurnId',
    async state => {
      const f = await connectedCalendarMemory();
      const connections = new MongoCalendarConnections(f.store, DEFAULT_BUDGETS);
      await connections.v2.create({ ...connectionV2(), userId: 'other-user' });
      const ops = new MongoCalendarOperations(f.store, DEFAULT_BUDGETS);
      const baseOp = operationRecordV2Schema.parse({
        ...directOperation(),
        turnId: `turn-${state}`,
        intentId: `intent-${state}`,
        operationId: `op-${state}`,
        authorization: { ...directOperation().authorization, acceptedTurnId: `turn-${state}` },
      });
      await ops.v2.reserveByIntent({ operation: baseOp, consumption: null });
      let current = baseOp;
      if (state === 'dispatching' || state === 'unknown') {
        const next = { ...current, revision: current.revision + 1, sequence: current.sequence + 1, state: 'dispatching' as const };
        await ops.v2.compareAndSwap({ expectedRevision: current.revision, next });
        current = next;
      }
      if (state === 'unknown') {
        const next = { ...current, revision: current.revision + 1, sequence: current.sequence + 1, state: 'unknown' as const };
        await ops.v2.compareAndSwap({ expectedRevision: current.revision, next });
        current = next;
      }
      await ops.v2.appendEventV2(operationEventV2Schema.parse({
        schemaVersion: 2,
        kind: 'calendar-operation-event-v2',
        userId: current.userId,
        sessionId: current.sessionId,
        turnId: current.turnId,
        attemptId: current.originatingAttemptId,
        operationId: current.operationId,
        intentId: current.intentId,
        eventId: `event-${current.operationId}-${current.sequence}`,
        sequence: current.sequence,
        state: current.state,
        revision: current.revision,
        createdAt: current.updatedAt,
        failure: null,
      }));
      const otherOp = operationRecordV2Schema.parse({
        ...directOperation(),
        userId: 'other-user',
        sessionId: 'other-session',
        turnId: 'other-turn',
        intentId: 'other-intent',
        operationId: 'other-op',
        authorization: { ...directOperation().authorization, acceptedTurnId: 'other-turn' },
      });
      await ops.v2.reserveByIntent({ operation: otherOp, consumption: null });

      const persistence = { calendarOperationsV2: ops.v2 } as never;
      expect(await pendingCalendarOperation({
        persistence, userId: current.userId, sessionId: current.sessionId, values: {}, latestTurnId: 'unrelated-turn',
      })).toMatchObject({ operationId: current.operationId, state });
      expect(await pendingCalendarOperation({
        persistence, userId: 'other-user', sessionId: 'other-session', values: {}, latestTurnId: 'unrelated-turn',
      })).toMatchObject({ operationId: otherOp.operationId, state: 'planned' });
      expect(await pendingCalendarOperation({
        persistence, userId: current.userId, sessionId: 'other-session', values: {}, latestTurnId: 'unrelated-turn',
      })).toBeNull();
    },
  );

  it('rejects unresolved-query overflow with NOT_READY instead of returning null', async () => {
    const f = await connectedCalendarMemory();
    const ops = new MongoCalendarOperations(f.store, DEFAULT_BUDGETS);
    for (const n of [1, 2, 3]) {
      const op = operationRecordV2Schema.parse({
        ...directOperation(),
        turnId: `turn-${n}`,
        intentId: `intent-${n}`,
        operationId: `op-${n}`,
        sequence: n,
        authorization: { ...directOperation().authorization, acceptedTurnId: `turn-${n}` },
      });
      await ops.v2.reserveByIntent({ operation: op, consumption: null });
    }
    const persistence = { calendarOperationsV2: ops.v2 } as never;
    await expect(pendingCalendarOperation({
      persistence, userId: 'u', sessionId: 's', values: {}, latestTurnId: null,
    })).rejects.toMatchObject({ code: 'NOT_READY' });
  });
});

const SNAPSHOT_COLLECTIONS = [
  'sessions', 'messages', 'agent-memory', 'metadata',
  'checkpoints', 'checkpoint_writes', 'integration_connections',
] as const;

async function snapshotToFreshExecutor(sourceDb: ReturnType<typeof calendarMemory>, executorId = 'recovered-exec') {
  const freshDb = calendarMemory();
  for (const name of SNAPSHOT_COLLECTIONS) {
    const dst = freshDb.rows(name);
    for (const [id, doc] of sourceDb.rows(name)) {
      const cloned = BSON.deserialize(BSON.serialize(doc));
      if (id.startsWith('fixture-')) {
        const nextId = `snap-${id}`;
        cloned._id = nextId;
        dst.set(nextId, cloned);
      } else {
        dst.set(id, cloned);
      }
    }
  }
  const client = Object.assign(freshDb.commandSource, {
    db: () => freshDb.store.db, appendMetadata: () => undefined,
  }) as unknown as MongoClient;
  const persistence = await createPersistenceBundle(client, 'recovery-matrix', DEFAULT_BUDGETS, executorId);
  return { db: freshDb, persistence };
}

describe('Calendar crash/recovery matrix', () => {
  it('preserves legacy v1 unresolved quarantine during checkpointless discovery', async () => {
    const f = await connectedCalendarMemory();
    const ops = new MongoCalendarOperations(f.store, DEFAULT_BUDGETS);
    const v1Planned = operationRecordSchema.parse({
      ...operationV1,
      turnId: 'turn-v1-unknown',
      operationId: 'op-v1-unknown',
      revision: 1,
      sequence: 1,
      state: 'planned',
    });
    await ops.reserve(v1Planned);
    const v1Disp = { ...v1Planned, revision: 2, sequence: 2, state: 'dispatching' as const };
    await ops.compareAndSwap(1, v1Disp);
    await ops.compareAndSwap(2, { ...v1Disp, revision: 3, sequence: 3, state: 'unknown' });
    const persistence = { calendarOperations: ops, calendarOperationsV2: ops.v2 } as never;
    expect(await pendingCalendarOperation({
      persistence, userId: v1Planned.userId, sessionId: v1Planned.sessionId, values: {}, latestTurnId: 'unrelated-turn',
    })).toMatchObject({ schemaVersion: 1, operationId: 'op-v1-unknown', state: 'unknown' });
  });

  it('repairs a consumed proposal without an operation using fresh checks, and interrupts on expiry', async () => {
    const sourceDb = calendarMemory();
    const sourceClient = Object.assign(sourceDb.commandSource, {
      db: () => sourceDb.store.db, appendMetadata: () => undefined,
    }) as unknown as MongoClient;
    const sourceP = await createPersistenceBundle(sourceClient, 'source-exec', DEFAULT_BUDGETS, 'source-exec');
    const h = calendarFixture(undefined, sourceP);
    await h.ready;
    let releaseCrash!: () => void, enteredCrash!: () => void;
    const crashHold = new Promise<void>(r => { releaseCrash = r; });
    const atCrash = new Promise<void>(r => { enteredCrash = r; });
    let run: Promise<void> | undefined;
    try {
      h.setAvailability({ busy: [busy('2026-11-03T10:15:00Z', '2026-11-03T10:30:00Z')] });
      const first = await disclose(h, request, event());
      const reply = await h.reply(first.proposal, 'Yes, go ahead', first.ids.sessionId);

      // Pause cleanly inside reserveByIntent to capture the genuine pre-reserve crash snapshot.
      const origReserve = h.p.calendarOperationsV2.reserveByIntent.bind(h.p.calendarOperationsV2);
      h.p.calendarOperationsV2.reserveByIntent = async input => {
        if (input.operation.turnId === reply.turnId) {
          enteredCrash();
          await crashHold;
        }
        return origReserve(input);
      };
      run = h.execute(reply).catch(() => undefined);
      await atCrash;
      expect(h.effects.filter(e => e.kind === 'create')).toHaveLength(0);
      const authBefore = await h.proposalAuthority(first.proposal);
      expect(authBefore.state).toBe('consumed');
      expect(await sourceP.calendarOperationsV2.getByTurn(h.identity.userId, reply.sessionId, reply.turnId)).toBeNull();

      // Snapshot rows while crashed before operation reserve; then release & dispose source runtime.
      const snap1 = await snapshotToFreshExecutor(sourceDb, 'recovered-1');
      const snap2 = await snapshotToFreshExecutor(sourceDb, 'recovered-2');
      releaseCrash();
      await run;

      // Healthy recovery repairs the exact original intent/action/operation with 1 POST and 0 model replay.
      const r1 = calendarFixture(undefined, snap1.persistence);
      await r1.ready;
      r1.advance(h.clock() - r1.clock());
      r1.setAvailability({ busy: [busy('2026-11-03T10:15:00Z', '2026-11-03T10:30:00Z')] });
      r1.runtime.allowStoppedOwner('source-exec');
      await r1.runtime.reconcileSession(h.identity.userId, first.ids.sessionId);
      const repaired = await snap1.persistence.calendarOperationsV2.getByTurn(
        h.identity.userId, reply.sessionId, reply.turnId,
      );
      expect(repaired).toMatchObject({
        state: 'succeeded',
        intentId: authBefore.proposal.consumedBy.intentId,
        operationId: authBefore.proposal.consumedBy.operationId,
      });
      expect(r1.effects.filter(e => e.kind === 'create')).toHaveLength(1);
      expect(r1.modelBodies).toHaveLength(0);
      r1.runtime.stopAccepting();

      // Expired proposal authority interrupts cleanly with 0 POST.
      const r2 = calendarFixture(undefined, snap2.persistence);
      await r2.ready;
      r2.advance(Date.parse(first.proposal.expiresAt) - r2.clock() + 1000);
      r2.runtime.allowStoppedOwner('source-exec');
      await r2.runtime.reconcileSession(h.identity.userId, first.ids.sessionId);
      expect(r2.effects.filter(e => e.kind === 'create')).toHaveLength(0);
      expect(await snap2.persistence.calendarOperationsV2.getByTurn(
        h.identity.userId, reply.sessionId, reply.turnId,
      )).toBeNull();
      const attempt2 = await snap2.persistence.metadata.getAttempt(h.identity.userId, reply.sessionId, reply.attemptId);
      expect(attempt2?.status).toBe('interrupted');
      r2.runtime.stopAccepting();
    } finally { releaseCrash(); await run?.catch(() => undefined); await h.dispose(); }
  });

  it('repairs missing planned event and gates first POST under fresh account/role/availability/deadline checks', async () => {
    const sourceDb = calendarMemory();
    const sourceClient = Object.assign(sourceDb.commandSource, {
      db: () => sourceDb.store.db, appendMetadata: () => undefined,
    }) as unknown as MongoClient;
    const sourceP = await createPersistenceBundle(sourceClient, 'source-planned', DEFAULT_BUDGETS, 'source-planned');
    const h = calendarFixture(undefined, sourceP);
    await h.ready;
    try {
      const ids = await h.submit(request);
      h.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'load-p'),
        createWire(action, 'create-p'));
      h.failOperationEvent('planned');
      h.failOnce('operation-dispatch');
      await expect(h.execute(ids)).rejects.toBeDefined();
      const before = await h.operationFor(ids);
      expect(before?.state).toBe('planned');
      const eventsBefore = await h.p.calendarOperationsV2.listEventsV2({
        userId: h.identity.userId, sessionId: ids.sessionId, operationId: before!.operationId,
      });
      expect(eventsBefore).toHaveLength(0);

      // Blocked gates must interrupt/clarify with zero POST: revoked account, reader role, busy condition, expired deadline.
      for (const mode of ['replace', 'role', 'busy', 'deadline'] as const) {
        const snap = await snapshotToFreshExecutor(sourceDb, `blocked-${mode}`);
        const rx = calendarFixture(undefined, snap.persistence);
        await rx.ready;
        rx.advance(h.clock() - rx.clock());
        if (mode === 'replace') await rx.replaceAccount();
        if (mode === 'role') await rx.setRole('personal@example.test', 'reader');
        if (mode === 'busy') rx.setAvailability({ busy: [busy('2026-11-03T10:10:00Z', '2026-11-03T10:20:00Z')] });
        if (mode === 'deadline') rx.advance(DEFAULT_BUDGETS.totalRunTimeoutMs + 60000);
        rx.runtime.allowStoppedOwner('source-planned');
        await rx.runtime.reconcileSession(h.identity.userId, ids.sessionId);
        expect(rx.effects.filter(e => e.kind === 'create')).toHaveLength(0);
        expect(rx.modelBodies).toHaveLength(0);
        rx.runtime.stopAccepting();
      }

      // Healthy snapshot repairs the missing planned event and executes the single original create.
      const okSnap = await snapshotToFreshExecutor(sourceDb, 'ok-planned');
      const okRx = calendarFixture(undefined, okSnap.persistence);
      await okRx.ready;
      okRx.advance(h.clock() - okRx.clock());
      okRx.runtime.allowStoppedOwner('source-planned');
      await okRx.runtime.reconcileSession(h.identity.userId, ids.sessionId);
      const after = await okRx.operationFor(ids);
      expect(after).toMatchObject({ state: 'succeeded', googleEventId: before!.googleEventId });
      const eventsAfter = await okSnap.persistence.calendarOperationsV2.listEventsV2({
        userId: h.identity.userId, sessionId: ids.sessionId, operationId: before!.operationId,
      });
      expect(eventsAfter.some(ev => ev.state === 'planned')).toBe(true);
      expect(eventsAfter.some(ev => ev.state === 'succeeded')).toBe(true);
      expect(okRx.effects.filter(e => e.kind === 'create')).toHaveLength(1);
      expect(okRx.modelBodies).toHaveLength(0);
      okRx.runtime.stopAccepting();
    } finally { await h.dispose(); }
  });

  it('keeps dispatching-missing-event strictly readback-only (never replays POST when readback is absent) and repairs succeeded-missing-event without readback', async () => {
    // Dispatching CAS committed with missing event (and crashed before POST reached server) -> readback returns absent, 0 new POST.
    const db1 = calendarMemory();
    const client1 = Object.assign(db1.commandSource, {
      db: () => db1.store.db, appendMetadata: () => undefined,
    }) as unknown as MongoClient;
    const p1 = await createPersistenceBundle(client1, 'disp-src', DEFAULT_BUDGETS, 'disp-src');
    const h1 = calendarFixture(undefined, p1);
    await h1.ready;
    let releaseDispatch!: () => void, enterDispatch!: () => void;
    const dispatchHold = new Promise<void>(r => { releaseDispatch = r; });
    const atDispatch = new Promise<void>(r => { enterDispatch = r; });
    let run1: Promise<void> | undefined;
    try {
      const ids = await h1.submit(request);
      h1.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'load-d'),
        createWire(action, 'create-d'));
      const origAppend = h1.p.calendarOperationsV2.appendEventV2.bind(h1.p.calendarOperationsV2);
      h1.p.calendarOperationsV2.appendEventV2 = async ev => {
        if (ev.state === 'dispatching') {
          enterDispatch();
          await dispatchHold;
        }
        return origAppend(ev);
      };
      run1 = h1.execute(ids).catch(() => undefined);
      await atDispatch;
      const op = await h1.operationFor(ids);
      expect(op?.state).toBe('dispatching');
      expect(h1.effects.filter(e => e.kind === 'create')).toHaveLength(0);
      const snap = await snapshotToFreshExecutor(db1, 'disp-rec');
      releaseDispatch();
      await run1;

      const r = calendarFixture(undefined, snap.persistence);
      await r.ready;
      r.advance(h1.clock() - r.clock());
      r.runtime.allowStoppedOwner('disp-src');
      await r.runtime.reconcileSession(h1.identity.userId, ids.sessionId);
      expect(r.effects.filter(e => e.kind === 'readback').map(e => e.eventId)).toEqual([op!.googleEventId]);
      expect(r.effects.filter(e => e.kind === 'create')).toHaveLength(0);
      expect(await r.operationFor(ids)).toMatchObject({ state: 'unknown', googleEventId: op!.googleEventId });
      r.runtime.stopAccepting();
    } finally { releaseDispatch(); await run1?.catch(() => undefined); await h1.dispose(); }

    // Succeeded receipt CAS committed with missing succeeded event -> repairs exact event without POST or readback.
    const db2 = calendarMemory();
    const client2 = Object.assign(db2.commandSource, {
      db: () => db2.store.db, appendMetadata: () => undefined,
    }) as unknown as MongoClient;
    const p2 = await createPersistenceBundle(client2, 'succ-src', DEFAULT_BUDGETS, 'succ-src');
    const h2 = calendarFixture(undefined, p2);
    await h2.ready;
    try {
      const ids = await h2.submit(request);
      h2.modelWires.push(skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, 'load-s'),
        createWire(action, 'create-s'), textWire('Created cleanly.'));
      h2.failOperationEvent('succeeded');
      // The receipt CAS commits, then the injected succeeded event append fails:
      // the live turn surfaces that persistence error instead of claiming a
      // durable receipt that does not exist yet.
      await expect(h2.execute(ids)).rejects.toBeDefined();
      const op = await h2.operationFor(ids);
      expect(op?.state).toBe('succeeded');
      const beforeEvents = await h2.p.calendarOperationsV2.listEventsV2({
        userId: h2.identity.userId, sessionId: ids.sessionId, operationId: op!.operationId,
      });
      expect(beforeEvents.some(ev => ev.state === 'succeeded')).toBe(false);

      const snap = await snapshotToFreshExecutor(db2, 'succ-rec');
      const r = calendarFixture(undefined, snap.persistence);
      await r.ready;
      r.advance(h2.clock() - r.clock());
      r.runtime.allowStoppedOwner('succ-src');
      await r.runtime.reconcileSession(h2.identity.userId, ids.sessionId);
      const afterEvents = await snap.persistence.calendarOperationsV2.listEventsV2({
        userId: h2.identity.userId, sessionId: ids.sessionId, operationId: op!.operationId,
      });
      expect(afterEvents.some(ev => ev.state === 'succeeded')).toBe(true);
      expect(r.effects).toEqual([]);
      r.runtime.stopAccepting();
    } finally { await h2.dispose(); }
  });
});
