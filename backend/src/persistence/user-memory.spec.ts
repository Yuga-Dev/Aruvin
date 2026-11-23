/**
 * ============================================================================
 * FILE: user-memory.spec.ts
 * LOCATION: backend/src/persistence/user-memory.spec.ts
 * PURPOSE: Exercise bounded user_memory repository operations offline.
 * ROLE IN PROJECT: Verifies scoped Mongo command shapes and certainty rules.
 * KEY COMPONENTS: In-process collection double, revision and ownership cases.
 * ============================================================================
 */
import type { Db } from 'mongodb';
import { expect, it, vi } from 'vitest';
import { DEFAULT_BUDGETS } from '../contracts/budgets.js';
import { AppError } from '../platform/errors/app-error.js';
import { accounting } from '../../test/persistence/fixtures.js';
import { MongoMetadata } from './metadata.js';
import { key } from './records.js';
import { RecordStore } from './store.js';
import { MongoUserMemoryRepository } from './user-memory.js';

const time = '2026-11-20T12:00:00.000Z';
const settings = { enabled: true, sections: {
  identity: 'Dog: Beans.', work: '', preferences: '', ongoing: '', other: '',
} };
type Row = Record<string, unknown> & { _id: string };

function fixture(limit = 16_384) {
  const collections = new Map<string, Map<string, Row>>();
  const findOne = vi.fn(async (name: string, filter: Record<string, unknown>, _options: unknown) =>
    structuredClone([...collections.get(name)!.values()].find(row =>
      Object.entries(filter).every(([k, v]) => row[k] === v)) ?? null));
  const updateOne = vi.fn(async (name: string, filter: { _id: string },
    update: { $setOnInsert: Row }, _options: unknown) => {
    const rows = collections.get(name)!;
    const inserted = !rows.has(filter._id);
    if (inserted) rows.set(filter._id, structuredClone(update.$setOnInsert));
    return { acknowledged: true, upsertedCount: inserted ? 1 : 0 };
  });
  const replaceOne = vi.fn(async (name: string, filter: { _id: string } & Record<string, unknown>,
    replacement: Row, _options: unknown) => {
    const rows = collections.get(name)!;
    const old = rows.get(filter._id);
    const matched = old !== undefined && Object.entries(filter).every(([k, v]) => old[k] === v);
    if (matched) rows.set(filter._id, structuredClone(replacement));
    return { acknowledged: true, matchedCount: matched ? 1 : 0 };
  });
  const db = { collection(name: string) {
    if (!collections.has(name)) collections.set(name, new Map());
    return {
      findOne: (...args: [Record<string, unknown>, unknown]) => findOne(name, ...args),
      updateOne: (...args: [Parameters<typeof updateOne>[1], Parameters<typeof updateOne>[2], unknown]) =>
        updateOne(name, ...args),
      replaceOne: (...args: [Parameters<typeof replaceOne>[1], Row, unknown]) => replaceOne(name, ...args),
    };
  } } as unknown as Db;
  const assertExecutor = vi.fn(async (): Promise<void> => undefined);
  const store = new RecordStore(db, 200);
  const repo = new MongoUserMemoryRepository(store, { assertExecutor }, limit);
  return { repo, store, collections, findOne, updateOne, replaceOne, assertExecutor };
}

it('creates only once, scopes reads/CAS, and reports the winning revision', async () => {
  const f = fixture();
  const _id = key('user-memory', 'alice');
  expect(await f.repo.read('alice')).toBeNull();
  await expect(f.repo.createIfAbsent('alice', settings, time)).resolves.toEqual({
    outcome: 'confirmed', record: { schemaVersion: 1, userId: 'alice', revision: 1,
      updatedAt: time, ...settings },
  });
  expect(f.updateOne).toHaveBeenCalledWith('user_memory', { _id }, {
    $setOnInsert: expect.objectContaining({ _id, userId: 'alice', revision: 1 }),
  }, expect.objectContaining({ upsert: true, writeConcern: { w: 'majority', j: true } }));
  await expect(f.repo.createIfAbsent('alice', settings, time))
    .resolves.toEqual({ outcome: 'conflict', currentRevision: 1 });
  await expect(f.repo.compareAndSwap('alice', 1, { ...settings, enabled: false }, time))
    .resolves.toMatchObject({ outcome: 'confirmed', record: { revision: 2, enabled: false } });
  expect(f.replaceOne).toHaveBeenCalledWith('user_memory', { _id, userId: 'alice', revision: 1 },
    expect.objectContaining({ _id, revision: 2 }), expect.objectContaining({ upsert: false }));
  await expect(f.repo.compareAndSwap('alice', 1, settings, time))
    .resolves.toEqual({ outcome: 'conflict', currentRevision: 2 });
  expect(await f.repo.read('bob')).toBeNull();
  expect(f.findOne).toHaveBeenCalledWith('user_memory', { _id, userId: 'alice' },
    expect.objectContaining({ readPreference: 'primary', readConcern: { level: 'majority' } }));
});

it('rejects invalid revisions, oversize BSON, and ownership loss before mutation', async () => {
  const small = fixture(256);
  await expect(small.repo.createIfAbsent('alice', settings, time))
    .rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
  expect(small.updateOne).not.toHaveBeenCalled();
  const f = fixture();
  await expect(f.repo.compareAndSwap('alice', Number.MAX_SAFE_INTEGER, settings, time))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  f.assertExecutor.mockRejectedValueOnce(new AppError('UNSUPPORTED_TOPOLOGY', 'Fixture fence.'));
  await expect(f.repo.createIfAbsent('alice', settings, time))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_TOPOLOGY' });
  expect(f.updateOne).not.toHaveBeenCalled();
  expect(f.replaceOne).not.toHaveBeenCalled();
});

it('rechecks the fence and confirms ambiguous writes only by exact majority read-back', async () => {
  const f = fixture();
  f.updateOne.mockImplementationOnce(async (name, filter, update) => {
    f.collections.get(name)!.set(filter._id, update.$setOnInsert);
    throw new Error('fixture lost acknowledgement');
  });
  await expect(f.repo.createIfAbsent('alice', settings, time))
    .resolves.toMatchObject({ outcome: 'confirmed', record: { revision: 1 } });
  f.replaceOne.mockRejectedValueOnce(new Error('fixture lost write'));
  await expect(f.repo.compareAndSwap('alice', 1, settings, time)).resolves.toEqual({ outcome: 'uncertain' });
  f.assertExecutor.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('fixture lost owner'));
  await expect(f.repo.compareAndSwap('alice', 1, settings, time)).resolves.toEqual({ outcome: 'uncertain' });
  expect(f.updateOne).toHaveBeenCalledTimes(1);
  expect(f.replaceOne).toHaveBeenCalledTimes(2);
});

it('persists memory-composer accounting without relaxing chat attempt linkage', async () => {
  const f = fixture();
  const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS);
  const record = { ...accounting(), purpose: 'memory' as const, sessionId: 'memory-composer',
    turnId: 'composer-turn', attemptId: 'memory-attempt', outcome: 'completed' as const, endedAt: time };
  await expect(metadata.putAccounting(record)).resolves.toBeUndefined();
  expect(f.collections.get('metadata')!.get(key('accounting', 'u1', 'memory-composer', 'memory-attempt')))
    .toMatchObject({ purpose: 'memory', kind: 'accounting' });
  expect(f.findOne.mock.calls.some(([, filter]) => filter.kind === 'attempt')).toBe(false);
  await expect(metadata.putAccounting({ ...record, purpose: 'chat' }))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
