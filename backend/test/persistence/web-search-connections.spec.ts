/**
 * ============================================================================
 * FILE: web-search-connections.spec.ts
 * LOCATION: backend/test/persistence/web-search-connections.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify scoped web-search account CAS, OAuth state consume, and indexes.
 *
 * ROLE IN PROJECT:
 *    Proves owner isolation, revision conflicts, lost-ACK confirmation, bounded
 *    records, and exact expiry without a real MongoDB service.
 *
 * KEY COMPONENTS:
 *    - WEB_SEARCH_INDEXES: Four bounded account/OAuth indexes.
 *    - MongoWebSearchConnections: Fake-collection CAS and consume checks.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import type { BudgetConfig } from '../../src/contracts/budgets.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import type { MongoOwnership } from '../../src/persistence/ownership.js';
import type { RecordStore } from '../../src/persistence/store.js';
import {
  MongoWebSearchConnections,
} from '../../src/persistence/web-search-connections.js';
import { CALENDAR_INDEXES, WEB_SEARCH_INDEXES } from '../../src/persistence/indexes.js';
import { storedWebOAuthStateSchema, type StoredWebAccount } from '../../src/plugins/web-search/types.js';

type Doc = Record<string, unknown> & { _id: string; _revision: number };

function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = key.split('.').reduce<unknown>(
      (value, part) => (value as Record<string, unknown> | undefined)?.[part], doc);
    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      const condition = expected as Record<string, unknown>;
      if ('$gt' in condition) {
        return actual instanceof Date && condition.$gt instanceof Date
          && actual.getTime() > condition.$gt.getTime();
      }
    }
    if (expected instanceof Date) {
      return actual instanceof Date && actual.getTime() === expected.getTime();
    }
    return actual === expected;
  });
}

function fakeStore() {
  const docs: Doc[] = [];
  const collection = {
    findOne: vi.fn(async (filter: Record<string, unknown>) =>
      structuredClone(docs.find(doc => matches(doc, filter)) ?? null)),
    replaceOne: vi.fn(async (
      filter: Record<string, unknown>, replacement: Doc, options?: { upsert?: boolean },
    ) => {
      const index = docs.findIndex(doc => matches(doc, filter));
      if (index < 0) {
        if (options?.upsert) {
          docs.push(structuredClone(replacement));
          return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      docs[index] = structuredClone(replacement);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }),
    updateOne: vi.fn(async (
      filter: Record<string, unknown>,
      update: { $setOnInsert?: Doc; $set?: Record<string, unknown> },
      options?: { upsert?: boolean },
    ) => {
      const index = docs.findIndex(doc => matches(doc, filter));
      if (index >= 0) {
        if (update.$set) Object.assign(docs[index]!, update.$set);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (options?.upsert && update.$setOnInsert) {
        docs.push(structuredClone(update.$setOnInsert));
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }),
    findOneAndUpdate: vi.fn(async (
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown> },
    ) => {
      const index = docs.findIndex(doc => matches(doc, filter));
      if (index < 0) return null;
      if (update.$set) Object.assign(docs[index]!, update.$set);
      return structuredClone(docs[index]!);
    }),
  };
  const store = {
    timeoutMs: 5_000,
    collection: vi.fn(() => collection),
    raw: vi.fn(async (_name: string, filter: Record<string, unknown>) => {
      const found = docs.find(doc => matches(doc, filter));
      return found ? structuredClone(found) : null;
    }),
    options: () => ({ maxTimeMS: 5_000 }),
  };
  return { docs, collection, store };
}

function fixture(budgets: Partial<BudgetConfig> = {}) {
  const fake = fakeStore();
  const owner = { assertExecutor: vi.fn(async () => undefined) };
  const repository = new MongoWebSearchConnections(
    fake.store as unknown as RecordStore,
    owner as unknown as MongoOwnership,
    { ...DEFAULT_BUDGETS, ...budgets },
  );
  return { ...fake, owner, repository };
}

const connection = (overrides: Record<string, unknown> = {}) => ({
  connectionId: 'conn_a', credentialVersion: 1, authMethod: 'api-key' as const,
  secret: { version: 1 as const, iv: 'A'.repeat(16), tag: 'B'.repeat(24), ciphertext: 'C'.repeat(32) },
  capabilities: { browse: true, fetch: false }, schemaDigest: 'd'.repeat(64),
  lastValidatedAt: '2026-11-14T00:00:00.000Z', capabilitiesExpireAt: '2026-11-15T00:00:00.000Z',
  state: 'connected' as const, oauthRefresh: 'idle' as const, ...overrides,
});
const account = (overrides: Partial<StoredWebAccount> = {}): StoredWebAccount => ({
  kind: 'account', schemaVersion: 1, userId: 'u_a', revision: 1,
  enabled: false, updatedAt: '2026-11-14T00:00:00.000Z',
  connections: { exa: connection() }, ...overrides,
});
const oauthState = (overrides: Record<string, unknown> = {}) => ({
  kind: 'oauth-state' as const, schemaVersion: 1 as const, userId: 'u_a', provider: 'exa' as const,
  expectedRevision: 0, connectionId: 'conn_a', credentialVersion: 1,
  stateHash: 'a'.repeat(64), browserHash: 'b'.repeat(64), sessionHash: 'c'.repeat(64),
  encryptedVerifier: { version: 1 as const, iv: 'A'.repeat(16), tag: 'B'.repeat(24), ciphertext: 'C'.repeat(32) },
  binding: {
    issuer: 'https://auth.exa.ai', resource: 'https://mcp.exa.ai/mcp',
    redirectUri: 'https://aurvin.example.com/api/plugins/web-search/providers/exa/oauth/callback',
    clientId: 'client_1', authorizationEndpoint: 'https://auth.exa.ai/authorize',
    tokenEndpoint: 'https://auth.exa.ai/token', registrationEndpoint: null, scope: 'read',
  },
  createdAt: '2026-11-14T00:00:00.000Z', expiresAt: new Date('2026-11-14T00:10:00.000Z'),
  consumedAt: null, ...overrides,
});

it('indexes only bounded web account and expiring OAuth records without Calendar collisions', () => {
  expect(WEB_SEARCH_INDEXES).toHaveLength(4);
  expect(WEB_SEARCH_INDEXES.every(i => i.collection === 'web_search_connections')).toBe(true);
  expect(WEB_SEARCH_INDEXES.find(i => i.options.name === 'web_search_account_owner'))
    .toMatchObject({ keys: { userId: 1, kind: 1 }, options: {
      unique: true, partialFilterExpression: { kind: 'account' } } });
  expect(WEB_SEARCH_INDEXES.find(i => i.options.name === 'web_search_oauth_owner_provider'))
    .toMatchObject({ keys: { userId: 1, provider: 1, kind: 1 }, options: {
      unique: true, partialFilterExpression: { kind: 'oauth-state' } } });
  expect(WEB_SEARCH_INDEXES.find(i => i.options.name === 'web_search_oauth_hash'))
    .toMatchObject({ keys: { stateHash: 1 }, options: {
      unique: true, partialFilterExpression: { kind: 'oauth-state' } } });
  expect(WEB_SEARCH_INDEXES.find(i => i.options.name === 'web_search_oauth_expiry'))
    .toMatchObject({ keys: { expiresAt: 1 }, options: {
      expireAfterSeconds: 0, partialFilterExpression: { kind: 'oauth-state' } } });
  expect(CALENDAR_INDEXES.some(i => i.collection === 'web_search_connections')).toBe(false);
});

it('creates the first account at public revision 1 with no expiresAt field', async () => {
  const f = fixture();
  const created = await f.repository.saveAccount(0, account());
  expect(created).toMatchObject({ outcome: 'confirmed', record: { revision: 1 } });
  expect(f.owner.assertExecutor).toHaveBeenCalled();
  const [filter, update, options] = f.collection.updateOne.mock.calls[0]!;
  expect(filter).toMatchObject({ userId: 'u_a', kind: 'account' });
  expect(options).toMatchObject({ upsert: true, writeConcern: { w: 'majority', j: true } });
  expect((update as { $setOnInsert: Doc }).$setOnInsert).toMatchObject({ revision: 1, _revision: 0 });
  expect((update as { $setOnInsert: Doc }).$setOnInsert).not.toHaveProperty('expiresAt');
  expect(await f.repository.readAccount('u_a')).toMatchObject({ revision: 1, enabled: false });
});

it('isolates owners on read, replace, and OAuth consume', async () => {
  const f = fixture();
  await f.repository.saveAccount(0, account());
  expect(await f.repository.readAccount('u_b')).toBeNull();
  const replaced = await f.repository.saveAccount(1, account({ userId: 'u_b', revision: 2 }));
  expect(replaced.outcome).toBe('uncertain');
  expect(f.docs).toHaveLength(1);
  await f.repository.putOAuthState(oauthState());
  expect(await f.repository.consumeOAuthState({
    userId: 'u_b', provider: 'exa', stateHash: 'a'.repeat(64), browserHash: 'b'.repeat(64),
    sessionHash: 'c'.repeat(64), now: '2026-11-14T00:05:00.000Z',
  })).toBe('not-found');
  expect(f.docs.find(doc => doc.kind === 'oauth-state')?.consumedAt).toBeNull();
});

it('lets only one concurrent writer win the same revision', async () => {
  const f = fixture();
  await f.repository.saveAccount(0, account());
  const first = await f.repository.saveAccount(1, account({ revision: 2, enabled: true }));
  const second = await f.repository.saveAccount(1, account({ revision: 2, enabled: false }));
  expect(first).toMatchObject({ outcome: 'confirmed', record: { enabled: true } });
  expect(second).toEqual({ outcome: 'conflict', currentRevision: 2 });
});

it('confirms one exact lost-ACK reread without a blind retry', async () => {
  const f = fixture();
  await f.repository.saveAccount(0, account());
  const original = f.collection.replaceOne.getMockImplementation()!;
  f.collection.replaceOne.mockImplementationOnce(async (filter, replacement) => {
    await original(filter, replacement);
    throw new Error('lost ack');
  });
  const saved = await f.repository.saveAccount(1, account({ revision: 2, enabled: true }));
  expect(saved).toMatchObject({ outcome: 'confirmed', record: { enabled: true } });
  expect(f.collection.replaceOne).toHaveBeenCalledTimes(1);
  expect(f.store.raw).toHaveBeenCalledTimes(1);
});

it('returns uncertain when the ACK and the exact reread both fail', async () => {
  const f = fixture();
  await f.repository.saveAccount(0, account());
  f.collection.replaceOne.mockRejectedValueOnce(new Error('lost ack'));
  f.store.raw.mockRejectedValueOnce(new Error('unreadable'));
  expect(await f.repository.saveAccount(1, account({ revision: 2, enabled: true })))
    .toEqual({ outcome: 'uncertain' });
});

it('rejects revision overflow and oversized account records', async () => {
  const f = fixture();
  await expect(f.repository.saveAccount(0, account({ revision: Number.MAX_SAFE_INTEGER })))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  const small = fixture({ maxDocumentBytes: 256 });
  await expect(small.repository.saveAccount(0, account()))
    .rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
});

it('consumes OAuth state once and denies exactly at expiry', async () => {
  const f = fixture();
  await f.repository.putOAuthState(oauthState());
  const input = {
    userId: 'u_a', provider: 'exa' as const, stateHash: 'a'.repeat(64),
    browserHash: 'b'.repeat(64), sessionHash: 'c'.repeat(64),
    now: '2026-11-14T00:05:00.000Z',
  };
  expect(await f.repository.consumeOAuthState(input)).toBe('consumed');
  expect(await f.repository.consumeOAuthState(input)).toBe('not-found');
  await f.repository.putOAuthState(oauthState({
    stateHash: 'd'.repeat(64), expiresAt: new Date('2026-11-14T00:05:00.000Z'),
  }));
  expect(await f.repository.consumeOAuthState({ ...input, stateHash: 'd'.repeat(64) }))
    .toBe('not-found');
});

it('stores BSON Date expiry and replaces a previous pending start', async () => {
  const f = fixture();
  const first = storedWebOAuthStateSchema.parse(oauthState());
  expect(first.expiresAt).toBeInstanceOf(Date);
  await f.repository.putOAuthState(first);
  await f.repository.putOAuthState(oauthState({ stateHash: 'e'.repeat(64) }));
  const states = f.docs.filter(doc => doc.kind === 'oauth-state');
  expect(states).toHaveLength(1);
  expect(states[0]?.expiresAt).toBeInstanceOf(Date);
  expect(states[0]?.stateHash).toBe('e'.repeat(64));
  expect(await f.repository.readOAuthState('u_a', 'exa', 'a'.repeat(64))).toBeNull();
  expect(await f.repository.readOAuthState('u_a', 'exa', 'e'.repeat(64)))
    .toMatchObject({ stateHash: 'e'.repeat(64) });
});

it('reports an uncertain OAuth state write without retrying', async () => {
  const f = fixture();
  f.collection.replaceOne.mockRejectedValueOnce(new Error('lost ack'));
  expect(await f.repository.putOAuthState(oauthState())).toBe('uncertain');
  expect(f.collection.replaceOne).toHaveBeenCalledTimes(1);
});
