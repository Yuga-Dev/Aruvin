/**
 * ============================================================================
 * FILE: user-memory.service.spec.ts
 * LOCATION: backend/src/personalization/user-memory.service.spec.ts
 * PURPOSE: Prove the memory cache and write queue with deterministic repositories.
 * ROLE IN PROJECT: Verifies RAM-only lookups, invalidation, and CAS behavior.
 * KEY COMPONENTS: Deferred read/writer gates and scoped repository stubs.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import type { UserMemoryRepository } from '../contracts/repositories.js';
import type { MemoryAuditRecord, StoredUserMemory } from '../contracts/user-memory.js';
import type { MemoryAuditPort } from '../persistence/memory-audit.js';
import { UserMemoryService } from './user-memory.service.js';

const time = '2026-11-20T12:00:00.000Z';
const empty = { identity: '', work: '', preferences: '', ongoing: '', other: '' };
const stored: StoredUserMemory = { schemaVersion: 1, userId: 'alice', enabled: true,
  sections: { ...empty, identity: 'Dog: Beans.' }, revision: 1, updatedAt: time };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const repo = {
    read: vi.fn<UserMemoryRepository['read']>().mockResolvedValue(null),
    createIfAbsent: vi.fn<UserMemoryRepository['createIfAbsent']>().mockResolvedValue({ outcome: 'uncertain' }),
    compareAndSwap: vi.fn<UserMemoryRepository['compareAndSwap']>().mockResolvedValue({ outcome: 'uncertain' }),
  };
  const repository = vi.fn(() => repo);
  return { repo, repository, memory: new UserMemoryService({ repository, now: () => new Date(time) }) };
}

it('coalesces warm, caches absence, and reads frozen state and pre-rendered pins only from RAM', async () => {
  const { repo, repository, memory } = fixture();
  expect(memory.cachedMemory('alice')).toBeUndefined();
  expect(memory.cachedSnapshot('alice')).toBeNull();
  expect(repository).not.toHaveBeenCalled();
  repo.read.mockResolvedValueOnce(stored);
  await Promise.all([memory.warm('alice'), memory.warm('alice')]);
  await memory.warm('bob');
  await memory.warm('bob');
  expect(repo.read.mock.calls).toEqual([['alice'], ['bob']]);
  const pin = memory.cachedSnapshot('alice');
  expect(pin).toEqual({ revision: 1, content: '- Identity: Dog: Beans.' });
  expect(Object.isFrozen(memory.cachedMemory('alice')!.sections)).toBe(true);
  repository.mockImplementation(() => { throw new Error('application storage blocked'); });
  expect(memory.cachedMemory('bob')).toBeNull();
  expect(memory.cachedSnapshot('alice')).toBe(pin);
  await memory.warm('alice');
  expect(repo.read).toHaveBeenCalledTimes(2);
  expect(repository).toHaveBeenCalledTimes(2);
});

it('does not cache errors or republish an evicted in-flight warm', async () => {
  const { repo, memory } = fixture();
  repo.read.mockRejectedValueOnce(new Error('fixture storage down'));
  await memory.warm('alice');
  expect(memory.cachedMemory('alice')).toBeUndefined();
  const pending = deferred<StoredUserMemory | null>();
  const entered = deferred<void>();
  repo.read.mockImplementationOnce(async () => { entered.resolve(undefined); return pending.promise; });
  const warm = memory.warm('alice');
  await entered.promise;
  memory.evict('alice');
  pending.resolve(stored);
  await warm;
  expect(memory.cachedMemory('alice')).toBeUndefined();
  expect(memory.cachedSnapshot('alice')).toBeNull();
  repo.read.mockResolvedValueOnce({ ...stored, enabled: false });
  await memory.warm('alice');
  expect(memory.cachedMemory('alice')).toMatchObject({ enabled: false });
  expect(memory.cachedSnapshot('alice')).toBeNull();
  memory.clearCache();
  expect(memory.cachedMemory('alice')).toBeUndefined();
});

function writableFixture() {
  const f = fixture();
  const rows = new Map([['alice', stored]]);
  f.repo.read.mockImplementation(async userId => rows.get(userId) ?? null);
  const save = async (...[userId, expected, settings, updatedAt]:
    Parameters<UserMemoryRepository['compareAndSwap']>) => {
    const currentRevision = rows.get(userId)?.revision ?? 0;
    if (currentRevision !== expected) return { outcome: 'conflict', currentRevision } as const;
    const record = { ...settings, schemaVersion: 1 as const, userId, revision: expected + 1, updatedAt };
    rows.set(userId, record);
    return { outcome: 'confirmed', record } as const;
  };
  f.repo.createIfAbsent.mockImplementation((userId, settings, updatedAt) => save(userId, 0, settings, updatedAt));
  f.repo.compareAndSwap.mockImplementation(save);
  return { ...f, rows };
}

it('serializes the passive/composer critical section per user while another user progresses', async () => {
  const { repo, memory } = writableFixture();
  const begun = deferred<void>(), release = deferred<void>();
  const passive = memory.applyEdit('alice', { requireEnabled: true }, async sections => {
    begun.resolve(undefined);
    await release.promise;
    return { changed: true, changeSummary: 'New work', sections: { ...sections, work: 'Builds Aurvin.' } };
  });
  await begun.promise;
  const composer = vi.fn(async (sections: StoredUserMemory['sections']) =>
    ({ changed: true, changeSummary: 'New preference', sections: { ...sections, preferences: 'Concise.' } }));
  const stale = memory.applyEdit('alice', { expectedRevision: 1 }, composer);
  const conflict = expect(stale).rejects.toMatchObject({ code: 'MEMORY_CONFLICT', currentRevision: 2 });
  await expect(memory.setEnabled('bob', 0, false)).resolves.toMatchObject({ enabled: false, revision: 1 });
  expect(composer).not.toHaveBeenCalled();
  expect(repo.read.mock.calls).toEqual([['alice'], ['bob']]);
  release.resolve(undefined);
  await passive;
  await conflict;
  expect(composer).not.toHaveBeenCalled();
  await expect(memory.applyEdit('alice', { expectedRevision: 2 }, composer))
    .resolves.toMatchObject({ changed: true, memory: { revision: 3,
      sections: { work: 'Builds Aurvin.', preferences: 'Concise.' } } });
  expect(memory.cachedSnapshot('alice')).toMatchObject({ revision: 3 });
});

it('recomputes once on a definite internal conflict and never retries a second conflict', async () => {
  const { repo, memory, rows } = writableFixture();
  const candidate = vi.fn(async (sections: StoredUserMemory['sections']) =>
    ({ changed: true, changeSummary: 'New work', sections: { ...sections, work: 'Builds Aurvin.' } }));
  repo.compareAndSwap.mockImplementationOnce(async () => {
    rows.set('alice', { ...stored, revision: 2, sections: { ...stored.sections, other: 'New fact.' } });
    return { outcome: 'conflict', currentRevision: 2 };
  });
  await expect(memory.applyEdit('alice', { requireEnabled: true }, candidate))
    .resolves.toMatchObject({ changed: true, memory: { revision: 3, sections: { other: 'New fact.' } } });
  expect(candidate).toHaveBeenCalledTimes(2);
  expect(candidate.mock.calls[1][0].other).toBe('New fact.');

  repo.compareAndSwap.mockClear().mockResolvedValue({ outcome: 'conflict', currentRevision: 4 });
  await expect(memory.applyEdit('alice', { requireEnabled: true }, async sections =>
    ({ changed: true, changeSummary: '', sections: { ...sections, work: 'New project.' } })))
    .rejects.toMatchObject({ code: 'MEMORY_CONFLICT', currentRevision: 4 });
  expect(repo.compareAndSwap).toHaveBeenCalledTimes(2);
  expect(memory.cachedSnapshot('alice')?.revision).toBe(3);
});

it('keeps the last confirmed cache on unknown writes; later paused edit and clear still work', async () => {
  const { repo, memory } = writableFixture();
  await memory.warm('alice');
  repo.compareAndSwap.mockResolvedValueOnce({ outcome: 'uncertain' });
  await expect(memory.setEnabled('alice', 1, false)).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
  expect(repo.compareAndSwap).toHaveBeenCalledTimes(1);
  expect(memory.cachedSnapshot('alice')?.revision).toBe(1);
  await memory.setEnabled('alice', 1, false);
  expect(memory.cachedSnapshot('alice')).toBeNull();
  const writer = vi.fn(async (sections: StoredUserMemory['sections']) =>
    ({ changed: true, changeSummary: 'Added a note', sections: { ...sections, other: 'Cooks.' } }));
  await expect(memory.applyEdit('alice', { requireEnabled: true }, writer))
    .rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
  expect(writer).not.toHaveBeenCalled();
  await expect(memory.applyEdit('alice', { expectedRevision: 2 }, writer))
    .resolves.toMatchObject({ memory: { enabled: false, revision: 3, sections: { other: 'Cooks.' } } });
  await expect(memory.clear('alice', 3)).resolves.toMatchObject({ enabled: false, revision: 4, sections: empty });
  expect(memory.cachedSnapshot('alice')).toBeNull();
});

it('eviction cancels queued work and fences publication of an already dispatched write', async () => {
  const { repo, memory } = writableFixture();
  const begun = deferred<void>(), release = deferred<void>();
  repo.compareAndSwap.mockImplementationOnce(async () => {
    begun.resolve(undefined);
    await release.promise;
    return { outcome: 'confirmed', record: { ...stored, enabled: false, revision: 2 } };
  });
  const write = memory.setEnabled('alice', 1, false);
  const first = expect(write).rejects.toMatchObject({ code: 'NOT_READY' });
  await begun.promise;
  const next = expect(memory.clear('alice', 2)).rejects.toMatchObject({ code: 'NOT_READY' });
  memory.evict('alice');
  release.resolve(undefined);
  await Promise.all([first, next]);
  expect(memory.cachedMemory('alice')).toBeUndefined();
  expect(repo.compareAndSwap).toHaveBeenCalledTimes(1);
});

it('rejects a full per-user queue without dispatching another operation', async () => {
  const { repo, memory } = writableFixture();
  const begun = deferred<void>(), release = deferred<void>();
  repo.read.mockImplementationOnce(async () => {
    begun.resolve(undefined);
    await release.promise;
    return stored;
  });
  const jobs = Array.from({ length: 8 }, () => memory.read('alice'));
  await begun.promise;
  await expect(memory.read('alice')).rejects.toMatchObject({ code: 'NOT_READY' });
  expect(repo.read).toHaveBeenCalledTimes(1);
  release.resolve(undefined);
  await Promise.all(jobs);
  expect(repo.read).toHaveBeenCalledTimes(8);
});

function auditedFixture() {
  const f = writableFixture();
  const records: MemoryAuditRecord[] = [];
  const port: MemoryAuditPort = {
    put: async record => { records.push(record); },
    findByRequestId: async (userId, requestId) =>
      records.find(r => r.userId === userId && r.requestId === requestId) ?? null,
    history: async () => ({ items: [...records].reverse(), nextCursor: null, cursorRevision: null }),
    prune: async () => undefined,
  };
  const memory = new UserMemoryService({ repository: f.repository, audit: () => port, auditRetryMs: 0,
    now: () => new Date(time) });
  return { ...f, memory, records, port };
}

it('edits one section directly and publishes to RAM only after a confirmed write', async () => {
  const { repo, memory, records } = auditedFixture();
  await memory.warm('alice');
  const held = deferred<void>(), entered = deferred<void>();
  const save = repo.compareAndSwap.getMockImplementation()!;
  repo.compareAndSwap.mockImplementationOnce(async (...args) => {
    entered.resolve(undefined);
    await held.promise;
    return save(...args);
  });
  const edit = memory.editSection('alice', 1, 'work', 'Builds Aurvin.', 'req-1');
  await entered.promise;
  expect(memory.cachedMemory('alice')!.sections.work).toBe('');
  expect(memory.cachedSnapshot('alice')!.revision).toBe(1);
  held.resolve(undefined);
  await expect(edit).resolves.toMatchObject({ revision: 2, sections: { identity: 'Dog: Beans.', work: 'Builds Aurvin.' } });
  expect(memory.cachedSnapshot('alice')).toEqual({ revision: 2,
    content: '- Identity: Dog: Beans.\n- Work: Builds Aurvin.' });
  await memory.drainAudit();
  expect(records).toMatchObject([{ memoryRevision: 2, action: 'edit-section', sections: ['work'], requestId: 'req-1' }]);
});

it('a failed or uncertain section edit leaves the RAM cache unchanged', async () => {
  const { repo, memory, records } = auditedFixture();
  await memory.warm('alice');
  repo.compareAndSwap.mockResolvedValueOnce({ outcome: 'uncertain' });
  await expect(memory.editSection('alice', 1, 'work', 'Builds Aurvin.')).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
  repo.compareAndSwap.mockRejectedValueOnce(new Error('driver'));
  await expect(memory.editSection('alice', 1, 'work', 'Builds Aurvin.')).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
  expect(memory.cachedMemory('alice')).toMatchObject({ revision: 1, sections: { work: '' } });
  expect(memory.cachedSnapshot('alice')?.content).toBe('- Identity: Dog: Beans.');
  await memory.drainAudit();
  expect(records).toEqual([]);
});

it('clearing one section keeps the other sections', async () => {
  const { memory, rows, records } = auditedFixture();
  rows.set('alice', { ...stored, sections: { ...stored.sections, work: 'Builds Aurvin.' } });
  await expect(memory.clearSection('alice', 1, 'identity', 'req-c')).resolves.toMatchObject({
    revision: 2, sections: { ...empty, work: 'Builds Aurvin.' } });
  expect(memory.cachedSnapshot('alice')?.content).toBe('- Work: Builds Aurvin.');
  await memory.drainAudit();
  expect(records).toMatchObject([{ action: 'clear-section', sections: ['identity'], charsAfter: 22 }]);
});

it('direct edit rejects secrets and control characters', async () => {
  const { repo, memory } = auditedFixture();
  await memory.warm('alice');
  await expect(memory.editSection('alice', 1, 'work', 'key: sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789'))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST', secretRejected: true });
  await expect(memory.editSection('alice', 1, 'work', 'bad\u0000text'))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(repo.compareAndSwap).not.toHaveBeenCalled();
});

it('direct edit over the rendered cap is rejected', async () => {
  const { repo, memory } = auditedFixture();
  await memory.warm('alice');
  await expect(memory.editSection('alice', 1, 'work', 'x'.repeat(2500)))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(repo.compareAndSwap).not.toHaveBeenCalled();
  await expect(memory.editSection('alice', 1, 'work', 'x'.repeat(2400))).resolves.toMatchObject({ revision: 2 });
});

it('two tabs editing the same revision give one conflict and no lost update', async () => {
  const { memory, rows } = auditedFixture();
  const results = await Promise.allSettled([
    memory.editSection('alice', 1, 'work', 'Tab one.', 'r-one'),
    memory.editSection('alice', 1, 'preferences', 'Tab two.', 'r-two'),
  ]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
  expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'MEMORY_CONFLICT', currentRevision: 2 });
  expect(rows.get('alice')).toMatchObject({ revision: 2, sections: { work: 'Tab one.', preferences: '' } });
});

it('a retried request with the same requestId returns success without a second change', async () => {
  const { repo, memory, rows } = auditedFixture();
  const first = await memory.editSection('alice', 1, 'work', 'Builds Aurvin.', 'req-same');
  const again = await memory.editSection('alice', 1, 'work', 'Builds Aurvin.', 'req-same'); // audit queued or saved
  await memory.drainAudit();
  const afterAudit = await memory.editSection('alice', 1, 'work', 'Builds Aurvin.', 'req-same');
  expect(again).toEqual(first);
  expect(afterAudit).toEqual(first);
  expect(repo.compareAndSwap).toHaveBeenCalledTimes(1);
  expect(rows.get('alice')!.revision).toBe(2);
  await expect(memory.editSection('alice', 1, 'work', 'Other.', 'req-other'))
    .rejects.toMatchObject({ code: 'MEMORY_CONFLICT', currentRevision: 2 });
});

it('a passive write racing a user edit never overwrites the user text', async () => {
  const { memory, rows } = auditedFixture();
  const begun = deferred<void>(), release = deferred<void>();
  const passive = memory.applyEdit('alice', { requireEnabled: true,
    audit: { action: 'passive', source: 'passive', origin: { sessionId: 's1', turnId: 't1' } } }, async sections => {
    begun.resolve(undefined);
    await release.promise;
    return { changed: true, changeSummary: 'x', sections: { ...sections, work: 'Learned passively.' } };
  });
  await begun.promise;
  const user = memory.editSection('alice', 1, 'identity', 'Dog: Mochi.', 'req-u');
  release.resolve(undefined);
  await passive;
  await expect(user).rejects.toMatchObject({ code: 'MEMORY_CONFLICT', currentRevision: 2 });
  const retry = await memory.editSection('alice', 2, 'identity', 'Dog: Mochi.', 'req-u2');
  expect(retry.sections).toMatchObject({ identity: 'Dog: Mochi.', work: 'Learned passively.' });
  expect(rows.get('alice')!.sections.identity).toBe('Dog: Mochi.');
});

it('notifies user-change listeners only for confirmed user-initiated changes', async () => {
  const { memory } = auditedFixture();
  const seen = vi.fn();
  memory.onUserChange(seen);
  await memory.applyEdit('alice', { requireEnabled: true, audit: { action: 'passive', source: 'passive' } },
    async sections => ({ changed: true, changeSummary: '', sections: { ...sections, other: 'x' } }));
  expect(seen).not.toHaveBeenCalled();
  await memory.clearSection('alice', 2, 'other');
  expect(seen).toHaveBeenCalledExactlyOnceWith('alice');
});
