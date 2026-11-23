/**
 * ============================================================================
 * FILE: prepared.spec.ts
 * LOCATION: backend/test/plugins/web-search/prepared.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove prepared snapshots and reads avoid storage and provider preparation.
 *
 * ROLE IN PROJECT:
 *    Exercises the isolated P2 port contract with blocked storage/prepare spies
 *    and real SDK mappings; this is not assembled text/voice evidence.
 *
 * KEY COMPONENTS:
 *    - Prepared snapshot/read with zero storage or preparation operations.
 *    - Cold closed snapshot, warm hit, off/unused, and expired credentials.
 *    - Real SDK browse/fetch mappings for all five providers under fixture trust.
 * ============================================================================
 */

import { afterEach, expect, it, vi } from 'vitest';
import {
  WEB_SEARCH_PROVIDERS, type WebSearchProvider,
} from '../../../src/contracts/web-search-policy.js';
import { McpWebClient } from '../../../src/plugins/web-search/mcp-client.js';
import { mapCall, providerDefinition } from '../../../src/plugins/web-search/providers.js';
import { mcpFixture } from './mcp-fixture.js';
import { preparedFixture } from './fixtures.js';

const fixtureTrust = vi.hoisted(() => ({ remoteReadsVerified: false }));
vi.mock('../../../src/plugins/web-search/providers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/plugins/web-search/providers.js')>();
  return {
    ...actual,
    providerDefinition: (provider: WebSearchProvider) => ({
      ...actual.providerDefinition(provider),
      fetchSafety: fixtureTrust.remoteReadsVerified ? 'verified' as const : 'unverified' as const,
    }),
  };
});
afterEach(() => { fixtureTrust.remoteReadsVerified = false; });

it('prepared snapshot and initial dispatch do not touch storage discovery connect or refresh', async () => {
  const f = preparedFixture();
  await f.setupConnectedAccount();
  f.blockStorageAndPreparation();
  const snapshot = f.runtime.snapshot('u_a');
  expect(snapshot.prepared).toBe(true);
  f.markInitialModelDispatch(snapshot);
  expect(f.eventsBeforeDispatch()).toEqual([]);
  expect((await f.executeBrowse()).ok).toBe(true);
  expect(f.storageOperations()).toBe(0);
  expect(f.preparationOperations()).toBe(0);
});

it('warms once and keeps a cold snapshot closed without implicit warm', async () => {
  const cold = preparedFixture();
  expect(cold.runtime.snapshot('u_a')).toMatchObject({ prepared: false, providers: [] });
  expect(cold.storageReads()).toBe(0);

  const warm = preparedFixture();
  await warm.setupConnectedAccount();
  const before = warm.storageReads();
  await warm.connections.warmOwner('u_a');
  await warm.connections.warmOwner('u_a');
  expect(warm.storageReads()).toBe(before);
});

it('progresses a prepared read while application storage is blocked', async () => {
  const f = preparedFixture();
  await f.setupConnectedAccount();
  f.blockStorageAndPreparation();
  expect(f.runtime.snapshot('u_a').providers.map(provider => provider.provider))
    .toEqual(['exa']);
  const result = await f.call({ mode: 'browse', query: 'example' });
  expect(result.ok).toBe(true);
  expect(f.storageOperations()).toBe(0);
  expect(f.preparationOperations()).toBe(0);
});

it('makes no provider call while off or unused', async () => {
  const off = preparedFixture();
  expect(await off.call({ mode: 'browse', query: 'example' })).toMatchObject({
    ok: false, error: { code: 'WEB_CONNECTION_REQUIRED' },
  });
  expect(off.providerCalls()).toEqual([]);

  const unused = preparedFixture();
  await unused.setupConnectedAccount();
  expect(unused.providerCalls()).toEqual([]);
});

it('skips owner credentials at exact capability expiry with zero provider calls', async () => {
  const f = preparedFixture();
  await f.setupConnectedAccount();
  f.advance(24 * 60 * 60 * 1_000);
  expect(await f.call({ mode: 'browse', query: 'example' })).toMatchObject({
    ok: false, error: { code: 'WEB_CONNECTION_REQUIRED' },
  });
  expect(f.providerCalls()).toEqual([]);
});

it.each(WEB_SEARCH_PROVIDERS)('prepares real SDK browse and fetch mappings for %s', async provider => {
  fixtureTrust.remoteReadsVerified = true;
  const definition = providerDefinition(provider);
  const endpoint = definition.apiKeyEndpoint;
  const f = mcpFixture([
    {
      name: definition.browseTool,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    {
      name: definition.fetchTool,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          urls: { type: 'array', items: { type: 'string' } },
          maxCharacters: { type: 'number' },
          max_chars: { type: 'number' },
          formats: { type: 'array', items: { type: 'string' } },
          format: { type: 'string' },
          live: { type: 'boolean' },
          links: { type: 'boolean' },
          image_links: { type: 'boolean' },
          per_url_timeout_ms: { type: 'number' },
          output_format: { type: 'string' },
          extract_depth: { type: 'string' },
          onlyMainContent: { type: 'boolean' },
          blockAds: { type: 'boolean' },
          storeInCache: { type: 'boolean' },
        },
      },
    },
  ], { endpoint });
  const mcp = new McpWebClient({ fetch: f.request });
  try {
    const credentials = { method: 'api-key' as const, apiKey: 'fixture-key' };
    const prepared = await mcp.prepare({
      userId: 'u_a', provider, connectionId: 'c_a', credentialVersion: 1,
      credentials, signal: new AbortController().signal,
      deadlineAt: performance.now() + 12_000,
    });
    expect(prepared.capabilities).toEqual({ browse: true, fetch: true });
    const browse = mapCall(provider, { mode: 'browse', query: 'example' }, 12_000);
    const fetch = mapCall(provider, { mode: 'fetch', url: 'https://example.com/page' }, 12_000);
    expect(browse.name).toBe(definition.browseTool);
    expect(fetch.name).toBe(definition.fetchTool);
    await prepared.session.call(browse, new AbortController().signal, performance.now() + 5_000);
    await prepared.session.call(fetch, new AbortController().signal, performance.now() + 5_000);
    if (provider === 'tinyfish') {
      expect(f.calls.length).toBeGreaterThan(0);
      expect(f.calls.every(call => call.headers.get('authorization') === 'Bearer fixture-key'))
        .toBe(true);
    }
  } finally { await mcp.close(); }
});
