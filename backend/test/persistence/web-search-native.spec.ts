/**
 * ============================================================================
 * FILE: web-search-native.spec.ts
 * LOCATION: backend/test/persistence/web-search-native.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify web-search storage against an operator-supplied isolated MongoDB.
 *
 * ROLE IN PROJECT:
 *    Runs only with AURVIN_TEST_MONGODB_URI and the aurvin_p2_test_ prefix;
 *    otherwise reports skipped, never passed, and never touches app data.
 *
 * KEY COMPONENTS:
 *    - Actual web/Calendar index creation and coexistence.
 *    - Per-owner aggregate CAS and single-use OAuth consume.
 *    - Encrypted credential round trip and BSON Date expiry.
 * ============================================================================
 */

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { WebSearchSecretCipher } from '../../src/platform/crypto/web-search-secret-cipher.js';
import { MongoWebSearchConnections } from '../../src/persistence/web-search-connections.js';
import { setupIndexes } from '../../src/persistence/indexes.js';
import { MongoOwnership } from '../../src/persistence/ownership.js';
import { RecordStore } from '../../src/persistence/store.js';
import type { StoredWebAccount, StoredWebOAuthState } from '../../src/plugins/web-search/types.js';
import { nativeDatabase } from './native.js';

const supplied = Boolean(process.env.AURVIN_TEST_MONGODB_URI)
  && process.env.AURVIN_TEST_DB_PREFIX === 'aurvin_p2_test_';

const cipher = () => new WebSearchSecretCipher({
  status: 'ready', key: Buffer.alloc(32, 7),
});

function connection() {
  const secret = cipher().seal({
    userId: 'u_a', provider: 'exa', connectionId: 'conn_a',
    credentialVersion: 1, tokenKind: 'credential-bundle',
  }, JSON.stringify({ method: 'api-key', apiKey: 'fixture-key' }));
  return {
    connectionId: 'conn_a', credentialVersion: 1, authMethod: 'api-key' as const,
    secret, capabilities: { browse: true, fetch: false }, schemaDigest: 'd'.repeat(64),
    lastValidatedAt: '2026-11-14T00:00:00.000Z',
    capabilitiesExpireAt: '2026-11-15T00:00:00.000Z',
    state: 'connected' as const, oauthRefresh: 'idle' as const,
  };
}

function account(overrides: Partial<StoredWebAccount> = {}): StoredWebAccount {
  return {
    kind: 'account', schemaVersion: 1, userId: 'u_a', revision: 1,
    enabled: false, updatedAt: '2026-11-14T00:00:00.000Z',
    connections: { exa: connection() }, ...overrides,
  };
}

function oauthState(overrides: Partial<StoredWebOAuthState> = {}): StoredWebOAuthState {
  return {
    kind: 'oauth-state', schemaVersion: 1, userId: 'u_a', provider: 'exa',
    expectedRevision: 0, connectionId: 'conn_a', credentialVersion: 1,
    stateHash: 'a'.repeat(64), browserHash: 'b'.repeat(64), sessionHash: 'c'.repeat(64),
    encryptedVerifier: cipher().seal({
      userId: 'u_a', provider: 'exa', connectionId: 'conn_a',
      credentialVersion: 1, tokenKind: 'pkce',
    }, 'A'.repeat(43)),
    binding: {
      issuer: 'https://auth.exa.ai', resource: 'https://mcp.exa.ai/mcp/oauth',
      redirectUri: 'https://aurvin.example.com/api/plugins/web-search/providers/exa/oauth/callback',
      clientId: 'client_1', authorizationEndpoint: 'https://auth.exa.ai/authorize',
      tokenEndpoint: 'https://auth.exa.ai/token', registrationEndpoint: null, scope: 'read',
    },
    createdAt: '2026-11-14T00:00:00.000Z',
    expiresAt: new Date(Date.now() + 600_000), consumedAt: null, ...overrides,
  };
}

async function fixture() {
  const database = await nativeDatabase();
  const store = new RecordStore(database.db, 15_000);
  const owner = new MongoOwnership(store);
  await owner.claimExecutor();
  const repository = new MongoWebSearchConnections(store, owner, DEFAULT_BUDGETS);
  return { database, store, owner, repository };
}

describe.skipIf(!supplied)('web-search native isolated storage', () => {
  it('creates actual scoped web indexes alongside Calendar indexes', async () => {
    const f = await fixture();
    try {
      await setupIndexes(f.database.db);
      const indexes = await f.database.db.collection('web_search_connections')
        .listIndexes().toArray();
      expect(indexes.find(index => index.name === 'web_search_account_owner')?.unique).toBe(true);
      expect(indexes.find(index => index.name === 'web_search_oauth_expiry')?.expireAfterSeconds)
        .toBe(0);
      expect(await f.database.db.collection('integration_connections').listIndexes().toArray())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'calendar_owner' })]));
    } finally { await f.database.close(); }
  });

  it('stores and CASes one bounded account aggregate per owner', async () => {
    const f = await fixture();
    try {
      expect(await f.repository.saveAccount(0, account())).toMatchObject({
        outcome: 'confirmed', record: { revision: 1 },
      });
      expect(await f.repository.saveAccount(1, account({ revision: 2, enabled: true })))
        .toMatchObject({ outcome: 'confirmed', record: { enabled: true } });
      expect(await f.repository.saveAccount(1, account({ revision: 2, enabled: false })))
        .toEqual({ outcome: 'conflict', currentRevision: 2 });
      expect(await f.repository.readAccount('u_b')).toBeNull();
    } finally { await f.database.close(); }
  });

  it('consumes OAuth state once and denies exactly at expiry', async () => {
    const f = await fixture();
    try {
      await f.repository.putOAuthState(oauthState());
      const input = {
        userId: 'u_a', provider: 'exa' as const, stateHash: 'a'.repeat(64),
        browserHash: 'b'.repeat(64), sessionHash: 'c'.repeat(64),
        now: new Date().toISOString(),
      };
      expect(await f.repository.consumeOAuthState(input)).toBe('consumed');
      expect(await f.repository.consumeOAuthState(input)).toBe('not-found');
      const expiresAt = new Date(Date.now() + 60_000);
      await f.repository.putOAuthState(oauthState({
        stateHash: 'd'.repeat(64), expiresAt,
      }));
      expect(await f.repository.consumeOAuthState({
        ...input, stateHash: 'd'.repeat(64), now: expiresAt.toISOString(),
      })).toBe('not-found');
    } finally { await f.database.close(); }
  });

  it('round-trips encrypted credentials and stores BSON Date expiry', async () => {
    const f = await fixture();
    try {
      await f.repository.saveAccount(0, account());
      const loaded = await f.repository.readAccount('u_a');
      const secret = loaded!.connections.exa!.secret;
      expect(cipher().open({
        userId: 'u_a', provider: 'exa', connectionId: 'conn_a',
        credentialVersion: 1, tokenKind: 'credential-bundle',
      }, secret)).toContain('fixture-key');
      await f.repository.putOAuthState(oauthState());
      const raw = await f.database.db.collection('web_search_connections').findOne({
        kind: 'oauth-state', stateHash: 'a'.repeat(64),
      });
      expect(raw?.expiresAt).toBeInstanceOf(Date);
    } finally { await f.database.close(); }
  });
});
