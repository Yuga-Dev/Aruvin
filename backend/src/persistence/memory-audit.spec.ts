/**
 * ============================================================================
 * FILE: memory-audit.spec.ts
 * LOCATION: backend/src/persistence/memory-audit.spec.ts
 * PURPOSE: Verify bounded, content-free memory audit persistence offline.
 * ROLE IN PROJECT: Proves key, scope, paging, retention, purge isolation and service retry.
 * KEY COMPONENTS: Fault-injectable in-memory store, real repository, real memory service.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import { DEFAULT_BUDGETS } from '../contracts/budgets.js';
import type { UserMemoryRepository } from '../contracts/repositories.js';
import { memoryAuditRecordSchema, type MemoryAuditRecord, type StoredUserMemory } from '../contracts/user-memory.js';
import { UserMemoryService } from '../personalization/user-memory.service.js';
import { calendarMemory } from '../../test/persistence/calendar-multi-memory.js';
import { session } from '../../test/persistence/fixtures.js';
import { MEMORY_AUDIT_KEEP, MEMORY_AUDIT_MAX_AGE_MS, MongoMemoryAudit, findAuditGaps } from './memory-audit.js';
import { key } from './records.js';
import { MongoSessions } from './sessions.js';

const now = Date.parse('2026-11-27T12:00:00.000Z');
const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();

function fixture() {
  const mem = calendarMemory();
  const assertExecutor = vi.fn(async () => undefined);
  const audit = new MongoMemoryAudit(mem.store, { assertExecutor });
  const record = (memoryRevision: number, fields: Partial<MemoryAuditRecord> = {}): MemoryAuditRecord => ({
    schemaVersion: 1, kind: 'memory-audit', userId: 'u1', memoryRevision, at: iso(memoryRevision),
    action: 'edit-section', source: 'user-ui', sections: ['identity'], charsBefore: 0, charsAfter: 12, ...fields });
  return { ...mem, audit, assertExecutor, record };
}

it('writes one bounded audit record per confirmed change keyed by revision', async () => {
  const f = fixture();
  await f.audit.put(f.record(3, { requestId: 'req-1' }));
  await f.audit.put(f.record(3, { requestId: 'req-1' })); // replay is a no-op
  expect(f.assertExecutor).toHaveBeenCalled();
  const rows = [...f.rows('metadata').values()];
  expect(rows).toHaveLength(1);
  expect(rows[0]!._id).toBe(key('memory-audit', 'u1', 3));
  expect(JSON.stringify(rows[0]).length).toBeLessThan(1024);
  const { _id, ...payload } = rows[0]!;
  expect(_id).toBeTruthy();
  expect(memoryAuditRecordSchema.safeParse(payload).success).toBe(true);
  expect(await f.audit.findByRequestId('u1', 'req-1')).toMatchObject({ memoryRevision: 3 });
  expect(await f.audit.findByRequestId('u2', 'req-1')).toBeNull();
  await expect(f.audit.put({ ...f.record(4), sections: ['bogus'] } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it('audit stores counts and section names but never memory text', async () => {
  const f = fixture();
  const service = new UserMemoryService({ repository: () => repo, audit: () => f.audit, auditRetryMs: 0,
    now: () => new Date(now) });
  const rows = new Map<string, StoredUserMemory>();
  const save = async (...[userId, expected, settings, updatedAt]: Parameters<UserMemoryRepository['compareAndSwap']>) => {
    const record = { ...settings, schemaVersion: 1 as const, userId, revision: expected + 1, updatedAt };
    rows.set(userId, record);
    return { outcome: 'confirmed', record } as const;
  };
  const repo: UserMemoryRepository = { read: async u => rows.get(u) ?? null,
    createIfAbsent: (u, s, at) => save(u, 0, s, at), compareAndSwap: save };
  await service.editSection('u1', 0, 'identity', 'Secret-ish fact: owns a dog named Beans.', 'req-a');
  await service.drainAudit();
  const stored = [...f.rows('metadata').values()][0]!;
  expect(stored).toMatchObject({ kind: 'memory-audit', action: 'edit-section', source: 'user-ui',
    sections: ['identity'], charsBefore: 0, requestId: 'req-a', memoryRevision: 1 });
  expect(JSON.stringify(stored)).not.toContain('Beans');
  await service.clearSection('u1', 1, 'identity', 'req-b');
  await service.drainAudit();
  const cleared = [...f.rows('metadata').values()].find(row => row.memoryRevision === 2)!;
  expect(cleared).toMatchObject({ action: 'clear-section', sections: ['identity'], charsAfter: 0 });
  expect(Object.keys(cleared).sort()).toEqual(['_id', 'action', 'at', 'charsAfter', 'charsBefore', 'kind',
    'memoryRevision', 'requestId', 'schemaVersion', 'sections', 'source', 'userId']);
});

it('audit survives hardPurgeSession of the originating chat', async () => {
  const f = fixture();
  const sessions = new MongoSessions(f.store, DEFAULT_BUDGETS);
  const row = { ...session('u1', 's1'), ephemeral: true, latestTurnId: 't1', _id: key('session', 'u1', 's1'), _revision: 0 };
  f.rows('sessions').set(row._id, row);
  await f.audit.put(f.record(1, { action: 'tool', source: 'tool', origin: { sessionId: 's1', turnId: 't1' } }));
  const collection = f.store.collection.bind(f.store);
  vi.spyOn(f.store, 'collection').mockImplementation(name => {
    const col = collection(name);
    col.deleteMany = async filter => {
      let deletedCount = 0;
      for (const [id, doc] of f.rows(name)) {
        if (Object.entries(filter).every(([field, value]) => field === 'kind'
          ? value !== null && typeof value === 'object' && '$ne' in value && doc.kind !== value.$ne
          : doc[field] === value)) { f.rows(name).delete(id); deletedCount++; }
      }
      return { acknowledged: true, deletedCount };
    };
    return col;
  });
  await sessions.hardPurgeSession('u1', 's1');
  expect(await sessions.get('u1', 's1')).toBeNull();
  expect(await f.audit.history('u1', { limit: 10 })).toMatchObject({ items: [{ memoryRevision: 1,
    origin: { sessionId: 's1', turnId: 't1' } }] });
});

it('history pages with a keyset cursor and caps limit at 50', async () => {
  const f = fixture();
  for (let r = 1; r <= 7; r++) await f.audit.put(f.record(r));
  const first = await f.audit.history('u1', { limit: 3 });
  expect(first.items.map(i => i.memoryRevision)).toEqual([7, 6, 5]);
  const second = await f.audit.history('u1', { limit: 3, cursor: first.nextCursor! });
  expect(second.items.map(i => i.memoryRevision)).toEqual([4, 3, 2]);
  const last = await f.audit.history('u1', { limit: 3, cursor: second.nextCursor! });
  expect(last).toMatchObject({ items: [{ memoryRevision: 1 }], nextCursor: null });
  await expect(f.audit.history('u1', { limit: 51 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(f.audit.history('u1', { limit: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(f.audit.history('u1', { limit: 3, cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it('history is scoped to the caller userId', async () => {
  const f = fixture();
  await f.audit.put(f.record(1));
  await f.audit.put(f.record(1, { userId: 'u2', sections: ['work'] }));
  expect((await f.audit.history('u2', { limit: 10 })).items).toMatchObject([{ userId: 'u2', sections: ['work'] }]);
  expect((await f.audit.history('u3', { limit: 10 })).items).toEqual([]);
  const cursor = (await f.audit.history('u1', { limit: 1 })).nextCursor;
  expect(cursor).toBeNull();
  for (let r = 2; r <= 3; r++) await f.audit.put(f.record(r));
  const foreign = (await f.audit.history('u1', { limit: 1 })).nextCursor!;
  await expect(f.audit.history('u2', { limit: 1, cursor: foreign })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it('audit write failure retries and never rolls back the memory change', async () => {
  const f = fixture();
  const report = vi.fn();
  const rows = new Map<string, StoredUserMemory>();
  const save = async (...[userId, expected, settings, updatedAt]: Parameters<UserMemoryRepository['compareAndSwap']>) => {
    const record = { ...settings, schemaVersion: 1 as const, userId, revision: expected + 1, updatedAt };
    rows.set(userId, record);
    return { outcome: 'confirmed', record } as const;
  };
  const repo: UserMemoryRepository = { read: async u => rows.get(u) ?? null,
    createIfAbsent: (u, s, at) => save(u, 0, s, at), compareAndSwap: save };
  const service = new UserMemoryService({ repository: () => repo, audit: () => f.audit, auditRetryMs: 0,
    now: () => new Date(now), report });
  f.failNext('before-write', { collection: 'metadata' });
  const result = await service.editSection('u1', 0, 'work', 'Builds Aurvin.');
  expect(result).toMatchObject({ revision: 1, sections: { work: 'Builds Aurvin.' } });
  await service.drainAudit();
  expect(rows.get('u1')!.sections.work).toBe('Builds Aurvin.'); // change stays
  expect([...f.rows('metadata').values()]).toMatchObject([{ memoryRevision: 1 }]); // second attempt landed
  expect(report).not.toHaveBeenCalled();
  // Every attempt fails: change is kept, a payload-free diagnostic is raised, and history has a gap.
  const failing = { put: vi.fn(async () => { throw new Error('storage down'); }), prune: async () => undefined };
  const broken = new UserMemoryService({ repository: () => repo, audit: () => failing as never, auditRetryMs: 0,
    now: () => new Date(now), report });
  await broken.editSection('u1', 1, 'work', 'Builds Aurvin v2.');
  await broken.drainAudit();
  expect(failing.put).toHaveBeenCalledTimes(3);
  expect(report).toHaveBeenCalledExactlyOnceWith('PERSISTENCE_ERROR');
  expect(rows.get('u1')!.revision).toBe(2);
});

it('history reports a gap when a revision is missing', async () => {
  const f = fixture();
  for (const r of [1, 2, 5, 6]) await f.audit.put(f.record(r));
  const { items } = await f.audit.history('u1', { limit: 10 });
  expect(findAuditGaps(items, 8, true)).toEqual([{ fromRevision: 7, toRevision: 8 }, { fromRevision: 3, toRevision: 4 }]);
  expect(findAuditGaps(items.slice(0, 1), null, true)).toEqual([]);
  expect(findAuditGaps(items.slice(2), 5, false)).toEqual([{ fromRevision: 3, toRevision: 4 }]);
  const service = new UserMemoryService({ repository: () => null, audit: () => f.audit });
  await expect(service.history('u1', { limit: 10 })).resolves.toMatchObject({ nextCursor: null,
    gaps: [{ fromRevision: 3, toRevision: 4 }] });
});

it('retention keeps the newest 200 and drops records older than 180 days', async () => {
  const f = fixture();
  for (let r = 1; r <= MEMORY_AUDIT_KEEP + 5; r++)
    await f.audit.put(f.record(r, { at: iso(-1000 + r) }));
  await f.audit.put(f.record(500, { userId: 'u2' }));
  await f.audit.prune('u1', now);
  const left = (userId: string) => [...f.rows('metadata').values()].filter(row => row.userId === userId);
  expect(left('u1')).toHaveLength(MEMORY_AUDIT_KEEP);
  expect(Math.min(...left('u1').map(row => row.memoryRevision as number))).toBe(6);
  expect(left('u2')).toHaveLength(1);
  // Age rule: a recent revision count but an old timestamp.
  await f.audit.put(f.record(900, { at: iso(-MEMORY_AUDIT_MAX_AGE_MS - 1) }));
  await f.audit.put(f.record(901, { at: iso(-MEMORY_AUDIT_MAX_AGE_MS + 60_000) }));
  await f.audit.prune('u1', now);
  const revisions = left('u1').map(row => row.memoryRevision);
  expect(revisions).toContain(901);
  expect(revisions).not.toContain(900);
});
