/**
 * ============================================================================
 * FILE: ephemeral-purge.spec.ts
 * LOCATION: backend/src/persistence/ephemeral-purge.spec.ts
 * ============================================================================
 * PURPOSE: Verify Temporary Chat navigation, scoped deletion, and expiry.
 * ROLE IN PROJECT: Exercises repository behavior with deterministic Mongo fixtures.
 * KEY COMPONENTS: Keyset exclusion, acknowledged cascade, bounded sweep, markers.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import type { CreateIndexesOptions, Db, Filter, IndexSpecification } from 'mongodb';
import { DEFAULT_BUDGETS } from '../contracts/budgets.js';
import type { SessionRecord } from '../contracts/session.js';
import { calendarMemory } from '../../test/persistence/calendar-multi-memory.js';
import { accounting, message, session } from '../../test/persistence/fixtures.js';
import { setupIndexes } from './indexes.js';
import { MongoMessages } from './messages.js';
import { graphThreadId, key, type StoredDocument } from './records.js';
import { EPHEMERAL_SESSION_MAX_AGE_MS, MongoSessions } from './sessions.js';

function fixture() {
  const mem = calendarMemory();
  const sessions = new MongoSessions(mem.store, DEFAULT_BUDGETS);
  function add(sessionId: string, fields: Partial<SessionRecord> = {}, userId = 'u1') {
    const _id = key('session', userId, sessionId);
    const row = { ...session(userId, sessionId), latestTurnId: 't1', ...fields, _id, _revision: 0 };
    mem.rows('sessions').set(_id, row);
    return row;
  }
  return { ...mem, sessions, add };
}

it('filters Temporary Chat out of every sidebar pin partition before pagination', async () => {
  const f = fixture();
  f.add('z-temp', { ephemeral: true, pinned: true });
  f.add('y-temp', { ephemeral: true, pinned: false });
  f.add('x-temp', { ephemeral: true });
  f.add('pin', { pinned: true, ephemeral: false });
  f.add('legacy');
  const first = await f.sessions.list('u1', { cursor: null, limit: 1 });
  expect(first.items.map(item => item.sessionId)).toEqual(['pin']);
  expect(first.nextCursor).not.toBeNull();
  const second = await f.sessions.list('u1', { cursor: first.nextCursor, limit: 1 });
  expect(second.items.map(item => item.sessionId)).toEqual(['legacy']);
  expect(second.nextCursor).toBeNull();
  expect(f.calls).toHaveLength(6);
  for (const call of f.calls)
    expect(call).toMatchObject({ method: 'find', filter: { ephemeral: { $ne: true } } });
  expect((await f.sessions.get('u1', 'z-temp'))?.ephemeral).toBe(true);
});

function trackDeletes(f: ReturnType<typeof fixture>, failure?: 'unacknowledged' | 'throws') {
  const collection = f.store.collection.bind(f.store);
  const calls: Array<[string, Filter<StoredDocument>]> = [];
  vi.spyOn(f.store, 'collection').mockImplementation(name => {
    const col = collection(name);
    const removeOne = col.deleteOne.bind(col);
    col.deleteOne = (filter, options) => {
      if (!filter) throw new Error('missing purge filter');
      expect(options).toEqual(f.store.options());
      calls.push([name, filter]);
      return removeOne(filter, options);
    };
    col.deleteMany = async (filter, options) => {
      if (!filter) throw new Error('missing purge filter');
      expect(options).toEqual(f.store.options());
      calls.push([name, filter]);
      if (name === 'messages' && failure) {
        const fault = failure;
        failure = undefined;
        if (fault === 'throws') throw new Error('driver detail');
        return { acknowledged: false, deletedCount: 0 };
      }
      let deletedCount = 0;
      for (const [id, row] of f.rows(name)) {
        if (Object.entries(filter).every(([field, value]) => {
          if (field === 'kind' && value && typeof value === 'object' && '$ne' in value)
            return row.kind !== value.$ne;
          return row[field] === value;
        })) {
          f.rows(name).delete(id);
          deletedCount++;
        }
      }
      return { acknowledged: true, deletedCount };
    };
    return col;
  });
  return calls;
}

function seedPurge(f: ReturnType<typeof fixture>) {
  const target = f.add('s1', { ephemeral: true,
    memoryPublication: { version: 1, sequence: 2, epoch: 'epoch', fence: 1 } });
  f.add('s1', {}, 'u2');
  f.add('s2', { ephemeral: false });
  const turns = ['messages', 'agent-memory', 'metadata'] as const;
  for (const col of turns) {
    f.rows(col).set('target', { _id: 'target', userId: 'u1', sessionId: 's1' });
    f.rows(col).set('other-user', { _id: 'other-user', userId: 'u2', sessionId: 's1' });
    f.rows(col).set('other-session', { _id: 'other-session', userId: 'u1', sessionId: 's2' });
  }
  const retained = { ...accounting(), _id: 'usage', _revision: 0 };
  f.rows('metadata').set('usage', retained);
  for (const kind of ['attempt', 'acceptance', 'voice-delivery', 'memory-summary', 'calendar-operation']) {
    f.rows('metadata').set(kind, { _id: kind, kind, userId: 'u1', sessionId: 's1' });
  }
  for (const col of ['checkpoints', 'checkpoint_writes']) {
    f.rows(col).set('target', { _id: 'target', thread_id: target.graphThreadId, checkpoint_ns: '' });
    f.rows(col).set('target-more', { _id: 'target-more', thread_id: target.graphThreadId, checkpoint_ns: 'child' });
    f.rows(col).set('other', { _id: 'other', thread_id: graphThreadId('u2', 's1') });
  }
  return { target, retained };
}

it('hard purges only the owner-scoped ephemeral chat, retains accounting, and deletes the root last', async () => {
  const f = fixture();
  const { target, retained } = seedPurge(f);
  const deletes = trackDeletes(f);
  for (const [userId, sessionId] of [['u2', 's1'], ['u1', 's2'], ['other', 's1']] as const)
    await f.sessions.hardPurgeSession(userId, sessionId);
  expect(deletes).toEqual([]);
  await f.sessions.hardPurgeSession('u1', 's1');
  const scope = { userId: 'u1', sessionId: 's1' };
  const thread = { thread_id: target.graphThreadId };
  expect(deletes).toEqual([
    ['checkpoint_writes', thread], ['checkpoints', thread], ['agent-memory', scope],
    ['messages', scope], ['metadata', { ...scope, kind: { $ne: 'accounting' } }],
    ['sessions', { _id: target._id, ...scope, ephemeral: true, lifecycle: 'archived',
      'execution.ownerId': null, 'execution.activeAttemptId': null }],
  ]);
  for (const col of ['checkpoints', 'checkpoint_writes'])
    expect([...f.rows(col).keys()]).toEqual(['other']);
  for (const col of ['messages', 'agent-memory', 'metadata'])
    expect([...f.rows(col).keys()]).toEqual([
      'other-user', 'other-session', ...(col === 'metadata' ? ['usage'] : []),
    ]);
  expect(f.rows('metadata').get('usage')).toEqual(retained);
  expect(await f.sessions.get('u1', 's1')).toBeNull();
  expect(await f.sessions.get('u1', 's2')).not.toBeNull();
  expect(await f.sessions.get('u2', 's1')).not.toBeNull();
  await f.sessions.hardPurgeSession('u1', 's1');
  expect(deletes).toHaveLength(6);
});

it.each(['unacknowledged', 'throws'] as const)('hard purge leaves a retryable root after %s child deletion', async fault => {
  const f = fixture();
  seedPurge(f);
  const deletes = trackDeletes(f, fault);
  await expect(f.sessions.hardPurgeSession('u1', 's1')).rejects.toMatchObject({
    code: 'PERSISTENCE_ERROR', message: 'Temporary chat deletion could not be confirmed.',
  });
  expect(deletes.map(([name]) => name)).toEqual(['checkpoint_writes', 'checkpoints', 'agent-memory', 'messages']);
  const remaining = await f.sessions.get('u1', 's1');
  expect(remaining).toMatchObject({ lifecycle: 'archived', ephemeral: true });
  expect(remaining).not.toHaveProperty('memoryPublication');
  await f.sessions.hardPurgeSession('u1', 's1');
  expect(deletes.at(-1)?.[0]).toBe('sessions');
  expect(await f.sessions.get('u1', 's1')).toBeNull();
});

it('hard purge refuses a live durable execution marker without touching children', async () => {
  const f = fixture();
  f.add('s1', { ephemeral: true, execution: { ...session().execution,
    ownerId: 'owner', activeAttemptId: 'attempt', leaseExpiresAt: session().createdAt } });
  const deletes = trackDeletes(f);
  await expect(f.sessions.hardPurgeSession('u1', 's1')).rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
  expect(deletes).toEqual([]);
  expect(await f.sessions.get('u1', 's1')).toMatchObject({ lifecycle: 'active' });
});

it('hard purge can be retried after the root delete applies without a reply', async () => {
  const f = fixture();
  seedPurge(f);
  const deletes = trackDeletes(f);
  f.failNext('after-write', { collection: 'sessions', method: 'deleteOne' });
  await expect(f.sessions.hardPurgeSession('u1', 's1')).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
  expect(await f.sessions.get('u1', 's1')).toBeNull();
  await f.sessions.hardPurgeSession('u1', 's1');
  expect(deletes).toHaveLength(6);
  expect(deletes.at(-1)?.[0]).toBe('sessions');
});

it('ephemeral sweep selects and purges only a bounded page strictly older than 24 hours', async () => {
  const f = fixture();
  const now = Date.parse('2026-10-07T00:00:00.000Z');
  const cutoff = '2026-10-06T00:00:00.000Z';
  const oldest = '2026-10-05T23:59:59.997Z';
  expect(new Date(now - EPHEMERAL_SESSION_MAX_AGE_MS).toISOString()).toBe(cutoff);
  f.add('third', { ephemeral: true, lastActivityAt: '2026-10-05T23:59:59.999Z' });
  f.add('retry', { ephemeral: true, lifecycle: 'archived', lastActivityAt: '2026-10-05T23:59:59.998Z' });
  f.add('first', { ephemeral: true, lastActivityAt: oldest }, 'u2');
  f.add('exact', { ephemeral: true, lastActivityAt: cutoff });
  f.add('young', { ephemeral: true, lastActivityAt: '2026-10-06T00:00:00.001Z' });
  f.add('legacy', { lastActivityAt: oldest });
  f.add('persistent', { ephemeral: false, lastActivityAt: oldest });
  trackDeletes(f);
  const selected = await f.sessions.listExpiredEphemeral(cutoff, 2);
  expect(selected.map(row => [row.userId, row.sessionId])).toEqual([['u2', 'first'], ['u1', 'retry']]);
  expect(f.calls[0]).toMatchObject({ collection: 'sessions', method: 'find', filter: {
    lifecycle: { $in: ['active', 'archived'] }, ephemeral: true, lastActivityAt: { $lt: cutoff },
  } });
  for (const row of selected) await f.sessions.hardPurgeSession(row.userId, row.sessionId);
  expect((await f.sessions.listExpiredEphemeral(cutoff, 2)).map(row => row.sessionId)).toEqual(['third']);
  for (const badLimit of [0, 1.5, DEFAULT_BUDGETS.maxPageSize + 1])
    await expect(f.sessions.listExpiredEphemeral(cutoff, badLimit)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(f.sessions.listExpiredEphemeral('not-a-date', 2)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it('ephemeral sweep installs the native compound index without TTL', async () => {
  const calls: Array<[string, IndexSpecification, CreateIndexesOptions]> = [];
  const db = { collection: (name: string) => ({
    createIndex: async (keys: IndexSpecification, options: CreateIndexesOptions) => {
      calls.push([name, keys, options]);
      return options.name;
    },
  }) } as unknown as Db;
  await setupIndexes(db);
  expect(calls.filter(([, , options]) => options.name === 'lifecycle_ephemeral_activity')).toEqual([
    ['sessions', { lifecycle: 1, ephemeral: 1, lastActivityAt: 1 }, { name: 'lifecycle_ephemeral_activity' }],
  ]);
});

it('advances the memory watermark monotonically without advancing chat activity', async () => {
  const f = fixture();
  const normal = f.add('normal');
  f.add('temporary', { ephemeral: true });
  await f.sessions.advanceMemoryWatermark('u1', 'normal', 0);
  f.failNext('after-write', { collection: 'sessions', method: 'updateOne' });
  await f.sessions.advanceMemoryWatermark('u1', 'normal', 9);
  await f.sessions.advanceMemoryWatermark('u1', 'normal', 4);
  expect(await f.sessions.get('u1', 'normal')).toMatchObject({
    memoryWatermarkSequence: 9, updatedAt: normal.updatedAt, lastActivityAt: normal.lastActivityAt,
  });
  await expect(f.sessions.advanceMemoryWatermark('u1', 'normal', -1)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  for (const [userId, sessionId] of [['u2', 'normal'], ['u1', 'temporary']] as const)
    await expect(f.sessions.advanceMemoryWatermark(userId, sessionId, 9)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await f.sessions.get('u1', 'temporary')).not.toHaveProperty('memoryWatermarkSequence');
});

it('marks only a scoped finalized assistant record, then exposes true on transcript readback', async () => {
  const f = fixture();
  const repo = new MongoMessages(f.store, DEFAULT_BUDGETS);
  const assistant = message(1);
  await repo.append(message());
  await repo.append(assistant);
  await repo.append({ ...message(2), completionStatus: 'streaming' });
  await expect(repo.markMemoryUpdated('u2', 's1', 'm1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(repo.markMemoryUpdated('u1', 's1', 'm0')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(repo.markMemoryUpdated('u1', 's1', 'm2')).rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
  f.failNext('after-write', { collection: 'messages', method: 'replaceOne' });
  await repo.markMemoryUpdated('u1', 's1', 'm1');
  await repo.markMemoryUpdated('u1', 's1', 'm1');
  expect(f.calls.filter(call => call.method === 'replaceOne')).toHaveLength(1);
  expect(await repo.get('u1', 's1', 'm1')).toEqual({ ...assistant, memoryUpdated: true });
  const { items } = await repo.list('u1', 's1', { cursor: null, limit: 10 });
  expect(items.find(item => item.messageId === 'm1')).toHaveProperty('memoryUpdated', true);
  expect(items.find(item => item.messageId === 'm0')).not.toHaveProperty('memoryUpdated');
});
