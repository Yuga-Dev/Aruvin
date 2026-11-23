/**
 * ============================================================================
 * FILE: calendar-mutation-session.spec.ts
 * LOCATION: backend/test/persistence/calendar-mutation-session.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify narrow Calendar mutation slot claim, assertion, and release on MongoSessions.
 *
 * ROLE IN PROJECT:
 *    Proves session-scoped active-attempt CAS works independently of archive
 *    ownership leases and rejects stale, foreign, archived, or unacknowledged handles.
 *
 * KEY COMPONENTS:
 *    - beginCalendarMutation: Conditional active-attempt claim with readback.
 *    - assertCalendarMutation: Scoped generation/attempt/owner verification.
 *    - finishCalendarMutation: Conditional active-attempt release.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { MongoSessions } from '../../src/persistence/sessions.js';
import { graphThreadId, key } from '../../src/persistence/records.js';
import { calendarMemory } from './calendar-multi-memory.js';

async function seedSession(
  sessions: MongoSessions,
  overrides: {
    userId?: string;
    sessionId?: string;
    lifecycle?: 'active' | 'archived';
    ownerId?: string | null;
    leaseExpiresAt?: string | null;
    activeAttemptId?: string | null;
    generation?: number;
  } = {},
) {
  const userId = overrides.userId ?? 'u';
  const sessionId = overrides.sessionId ?? 's';
  await sessions.createIfAbsent({
    schemaVersion: 1,
    userId,
    sessionId,
    title: 'Calendar',
    createdAt: '2026-11-03T09:00:00.000Z',
    updatedAt: '2026-11-03T09:00:00.000Z',
    lastActivityAt: '2026-11-03T09:00:00.000Z',
    lifecycle: 'active',
    graphThreadId: graphThreadId(userId, sessionId),
    latestTurnId: null,
    execution: {
      ownerId: overrides.ownerId === undefined ? null : overrides.ownerId,
      leaseExpiresAt: overrides.leaseExpiresAt === undefined ? null : overrides.leaseExpiresAt,
      activeAttemptId: overrides.activeAttemptId === undefined ? null : overrides.activeAttemptId,
      generation: overrides.generation ?? 4,
    },
    memoryPublication: { version: 0, sequence: 0, epoch: 'fixture-epoch', fence: 0 },
  });
  if (overrides.lifecycle === 'archived') {
    await sessions.store.collection('sessions').updateOne(
      { _id: key('session', userId, sessionId), userId, sessionId },
      { $set: { lifecycle: 'archived' }, $inc: { _revision: 1 } },
      sessions.store.options(),
    );
  }
}

it('claims mutation ownership without acquiring or releasing an archive lease', async () => {
  const db = calendarMemory(), sessions = new MongoSessions(db.store, DEFAULT_BUDGETS);
  for (const sessionId of ['s', 'other']) await sessions.createIfAbsent({
    schemaVersion: 1, userId: 'u', sessionId, title: 'Calendar',
    createdAt: '2026-11-03T09:00:00.000Z', updatedAt: '2026-11-03T09:00:00.000Z',
    lastActivityAt: '2026-11-03T09:00:00.000Z', lifecycle: 'active',
    graphThreadId: graphThreadId('u', sessionId), latestTurnId: null,
    execution: { ownerId: sessionId === 's' ? 'archive-executor' : null,
      leaseExpiresAt: sessionId === 's' ? '2026-11-03T09:03:00.000Z' : null,
      activeAttemptId: null, generation: 4 },
    memoryPublication: { version: 0, sequence: 0, epoch: 'fixture-epoch', fence: 0 },
  });
  const handle = await sessions.beginCalendarMutation({ userId: 'u', sessionId: 's',
    attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: true });
  expect(handle).toEqual({ userId: 'u', sessionId: 's', attemptId: 'create-a', generation: 4 });
  expect(await sessions.assertCalendarMutation(handle, 'archive-executor')).toBe(true);
  await expect(sessions.beginCalendarMutation({ userId: 'u', sessionId: 's',
    attemptId: 'create-b', executorId: 'archive-executor', archiveOwned: true }))
    .rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
  await sessions.finishCalendarMutation(handle, 'archive-executor');
  expect(await sessions.get('u', 's')).toMatchObject({
    execution: { ownerId: 'archive-executor', generation: 4, activeAttemptId: null },
    memoryPublication: { version: 0 },
  });
  expect(await sessions.get('u', 'other')).toMatchObject({ execution: { activeAttemptId: null } });
});

it('rejects wrong user, session, or executor provenance', async () => {
  const db = calendarMemory(), sessions = new MongoSessions(db.store, DEFAULT_BUDGETS);
  await seedSession(sessions, { ownerId: 'archive-executor', leaseExpiresAt: '2026-11-03T09:03:00.000Z' });
  await expect(sessions.beginCalendarMutation({
    userId: 'other-user', sessionId: 's', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: true,
  })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(sessions.beginCalendarMutation({
    userId: 'u', sessionId: 'missing', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: true,
  })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(sessions.beginCalendarMutation({
    userId: 'u', sessionId: 's', attemptId: 'create-a', executorId: 'wrong-executor', archiveOwned: true,
  })).rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });

  const handle = await sessions.beginCalendarMutation({
    userId: 'u', sessionId: 's', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: true,
  });
  expect(await sessions.assertCalendarMutation(handle, 'wrong-executor')).toBe(false);
  expect(await sessions.assertCalendarMutation({ ...handle, userId: 'other-user' }, 'archive-executor')).toBe(false);
  expect(await sessions.assertCalendarMutation({ ...handle, sessionId: 'other' }, 'archive-executor')).toBe(false);
  await expect(sessions.finishCalendarMutation(handle, 'wrong-executor')).rejects.toMatchObject({ code: 'INTERRUPTED' });
  expect((await sessions.get('u', 's'))?.execution.activeAttemptId).toBe('create-a');
});

it('rejects an unverified same-owner lease when archiveOwned is false', async () => {
  const db = calendarMemory(), sessions = new MongoSessions(db.store, DEFAULT_BUDGETS);
  await seedSession(sessions, { ownerId: 'archive-executor', leaseExpiresAt: '2026-11-03T09:03:00.000Z' });
  await expect(sessions.beginCalendarMutation({
    userId: 'u', sessionId: 's', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: false,
  })).rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
  expect((await sessions.get('u', 's'))?.execution.activeAttemptId).toBeNull();
});

it('rejects a foreign owner', async () => {
  const db = calendarMemory(), sessions = new MongoSessions(db.store, DEFAULT_BUDGETS);
  await seedSession(sessions, { ownerId: 'foreign-executor', leaseExpiresAt: '2026-11-03T09:03:00.000Z' });
  await expect(sessions.beginCalendarMutation({
    userId: 'u', sessionId: 's', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: true,
  })).rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
  expect((await sessions.get('u', 's'))?.execution.activeAttemptId).toBeNull();
});

it('rejects an archived session', async () => {
  const db = calendarMemory(), sessions = new MongoSessions(db.store, DEFAULT_BUDGETS);
  await seedSession(sessions, { lifecycle: 'archived' });
  await expect(sessions.beginCalendarMutation({
    userId: 'u', sessionId: 's', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: false,
  })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('rejects claiming when another attempt is already active and never clears a newer attempt with stale handle', async () => {
  const db = calendarMemory(), sessions = new MongoSessions(db.store, DEFAULT_BUDGETS);
  await seedSession(sessions, { activeAttemptId: 'other-attempt' });
  await expect(sessions.beginCalendarMutation({
    userId: 'u', sessionId: 's', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: false,
  })).rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });

  const staleHandle = { userId: 'u', sessionId: 's', attemptId: 'create-a', generation: 4 };
  expect(await sessions.assertCalendarMutation(staleHandle, 'archive-executor')).toBe(false);
  await expect(sessions.finishCalendarMutation(staleHandle, 'archive-executor')).rejects.toMatchObject({ code: 'INTERRUPTED' });
  expect((await sessions.get('u', 's'))?.execution.activeAttemptId).toBe('other-attempt');
});

it('fences handles after generation replacement', async () => {
  const db = calendarMemory(), sessions = new MongoSessions(db.store, DEFAULT_BUDGETS);
  await seedSession(sessions);
  const handle = await sessions.beginCalendarMutation({
    userId: 'u', sessionId: 's', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: false,
  });
  await sessions.store.collection('sessions').updateOne(
    { _id: key('session', 'u', 's'), userId: 'u', sessionId: 's' },
    { $set: { 'execution.activeAttemptId': 'create-b' }, $inc: { 'execution.generation': 1, _revision: 1 } },
    sessions.store.options(),
  );
  expect(await sessions.assertCalendarMutation(handle, 'archive-executor')).toBe(false);
  await expect(sessions.finishCalendarMutation(handle, 'archive-executor')).rejects.toMatchObject({ code: 'INTERRUPTED' });
  expect((await sessions.get('u', 's'))?.execution).toMatchObject({ generation: 5, activeAttemptId: 'create-b' });
});

it('fails closed on before-write failure and rejects unacknowledged claim', async () => {
  const db = calendarMemory(), sessions = new MongoSessions(db.store, DEFAULT_BUDGETS);
  await seedSession(sessions);
  db.failNext('before-write', { collection: 'sessions', method: 'updateOne' });
  await expect(sessions.beginCalendarMutation({
    userId: 'u', sessionId: 's', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: false,
  })).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
  expect((await sessions.get('u', 's'))?.execution.activeAttemptId).toBeNull();

  const origCollection = db.store.collection.bind(db.store);
  const spy = vi.spyOn(db.store, 'collection').mockImplementation(name => {
    const col = origCollection(name);
    if (name !== 'sessions') return col;
    return {
      ...col,
      updateOne: async () => ({ acknowledged: false, matchedCount: 1, upsertedCount: 0 } as never),
    };
  });
  await expect(sessions.beginCalendarMutation({
    userId: 'u', sessionId: 's', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: false,
  })).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
  spy.mockRestore();
  expect((await sessions.get('u', 's'))?.execution.activeAttemptId).toBeNull();
});

it('confirms exact scoped readback on after-write lost acknowledgement for claim and finish', async () => {
  const db = calendarMemory(), sessions = new MongoSessions(db.store, DEFAULT_BUDGETS);
  await seedSession(sessions, { ownerId: 'archive-executor', leaseExpiresAt: '2026-11-03T09:03:00.000Z' });
  db.failNext('after-write', { collection: 'sessions', method: 'updateOne' });
  const handle = await sessions.beginCalendarMutation({
    userId: 'u', sessionId: 's', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: true,
  });
  expect(handle).toEqual({ userId: 'u', sessionId: 's', attemptId: 'create-a', generation: 4 });
  expect((await sessions.get('u', 's'))?.execution.activeAttemptId).toBe('create-a');

  // Repeat claim is idempotent and allows archive release afterwards.
  const repeat = await sessions.beginCalendarMutation({
    userId: 'u', sessionId: 's', attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: true,
  });
  expect(repeat).toEqual(handle);
  await sessions.store.collection('sessions').updateOne(
    { _id: key('session', 'u', 's'), userId: 'u', sessionId: 's' },
    { $set: { 'execution.ownerId': null, 'execution.leaseExpiresAt': null }, $inc: { _revision: 1 } },
    sessions.store.options(),
  );
  expect(await sessions.assertCalendarMutation(handle, 'archive-executor')).toBe(true);

  db.failNext('before-write', { collection: 'sessions', method: 'updateOne' });
  await expect(sessions.finishCalendarMutation(handle, 'archive-executor')).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
  expect((await sessions.get('u', 's'))?.execution.activeAttemptId).toBe('create-a');

  db.failNext('after-write', { collection: 'sessions', method: 'updateOne' });
  await sessions.finishCalendarMutation(handle, 'archive-executor');
  expect((await sessions.get('u', 's'))?.execution.activeAttemptId).toBeNull();
});

it('listForRecovery discovers active memoryPublication sessions, paginates, and isolates foreign users', async () => {
  const db = calendarMemory(), sessions = new MongoSessions(db.store, DEFAULT_BUDGETS);
  const seed = async (userId: string, sessionId: string, opts: {
    lastActivityAt: string; ownerId?: string | null; activeAttemptId?: string | null; hasMemPub?: boolean;
  }) => {
    await sessions.createIfAbsent({
      schemaVersion: 1,
      userId,
      sessionId,
      title: sessionId,
      createdAt: '2026-11-03T09:00:00.000Z',
      updatedAt: opts.lastActivityAt,
      lastActivityAt: opts.lastActivityAt,
      lifecycle: 'active',
      graphThreadId: graphThreadId(userId, sessionId),
      latestTurnId: null,
      execution: {
        ownerId: opts.ownerId ?? null,
        leaseExpiresAt: opts.ownerId ? '2026-11-03T09:05:00.000Z' : null,
        activeAttemptId: opts.activeAttemptId ?? null,
        generation: 1,
      },
      ...(opts.hasMemPub ? { memoryPublication: { version: 0, sequence: 0, epoch: 'epoch', fence: 0 } } : {}),
    });
  };
  await seed('u', 's-pub-1', { lastActivityAt: '2026-11-03T09:04:00.000Z', hasMemPub: true });
  await seed('u', 's-active', { lastActivityAt: '2026-11-03T09:03:00.000Z', activeAttemptId: 'a-1' });
  await seed('u', 's-owned', { lastActivityAt: '2026-11-03T09:02:00.000Z', ownerId: 'stopped-exec' });
  await seed('u', 's-clean-idle', { lastActivityAt: '2026-11-03T09:05:00.000Z', hasMemPub: false });
  await seed('other', 's-foreign', { lastActivityAt: '2026-11-03T09:06:00.000Z', hasMemPub: true });

  const page1 = await sessions.listForRecovery('u', { limit: 2, cursor: null });
  expect(page1.items.map(s => s.sessionId)).toEqual(['s-pub-1', 's-active']);
  expect(page1.nextCursor).toBeTruthy();

  const page2 = await sessions.listForRecovery('u', { limit: 2, cursor: page1.nextCursor });
  expect(page2.items.map(s => s.sessionId)).toEqual(['s-owned']);
  expect(page2.nextCursor).toBeNull();
});
