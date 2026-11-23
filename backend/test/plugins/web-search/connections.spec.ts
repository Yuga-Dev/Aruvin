/**
 * ============================================================================
 * FILE: connections.spec.ts
 * LOCATION: backend/test/plugins/web-search/connections.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify prepared connection authority, CAS, and permission fences.
 *
 * ROLE IN PROJECT:
 *    Proves connect/replace/disconnect/settings semantics, owner isolation,
 *    fail-closed revocations, expiry, and secret-free projections.
 *
 * KEY COMPONENTS:
 *    - Connect does not enable; failed replacement preserves old authority.
 *    - Last-provider removal and reconnection remain off.
 *    - First-setup projections, stale revisions, held/uncertain saves.
 *    - Eviction during warm/prepare, exact expiry, and zero-read warm hits.
 * ============================================================================
 */

import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { WebSearchSecretCipher } from '../../../src/platform/crypto/web-search-secret-cipher.js';
import { WebSearchConnections } from '../../../src/plugins/web-search/connection.js';
import { McpWebClient } from '../../../src/plugins/web-search/mcp-client.js';
import { connectionFixture } from './fixtures.js';
import { mcpFixture } from './mcp-fixture.js';

const signal = () => new AbortController().signal;

it('does not enable on connect and preserves an old connection on failed replacement', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  expect((await f.connect('exa')).enabled).toBe(false);
  await f.setEnabled(true);
  f.rejectNextPrepare('WEB_INVALID_KEY');
  await expect(f.connect('exa')).rejects.toMatchObject({ code: 'WEB_INVALID_KEY' });
  expect(f.service.status('u_a')).toMatchObject({ enabled: true, effectiveEnabled: true });
});

it('last-provider removal stays off after reconnect', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  await f.connect('exa');
  await f.setEnabled(true);
  const status = f.service.status('u_a');
  await f.service.disconnect('u_a', 'exa', {
    protocolVersion: 1, expectedRevision: status.revision, confirm: true,
  }, signal());
  expect((await f.connect('exa')).enabled).toBe(false);
});

it('isolates accounts and cached MCP sessions', async () => {
  const f = connectionFixture();
  await f.connect('exa', 'u_a');
  await f.connect('keenable', 'u_b');
  const a = f.service.status('u_a');
  const b = f.service.status('u_b');
  expect(a.providers.find(provider => provider.provider === 'exa')?.state).toBe('connected');
  expect(b.providers.find(provider => provider.provider === 'exa')?.state).toBe('not-connected');
  expect(b.providers.find(provider => provider.provider === 'keenable')?.state).toBe('connected');
  expect(f.sessions.has('u_a\0exa')).toBe(true);
  expect(f.sessions.has('u_b\0exa')).toBe(false);
  f.service.evict('u_a');
  expect(f.service.status('u_a').revision).toBe(0);
  expect(f.service.status('u_b').providers.find(provider => provider.provider === 'keenable')?.state)
    .toBe('connected');
});

it.each([
  ['WEB_INVALID_KEY', 'invalid-key'],
  ['WEB_AUTH_UNSUPPORTED', 'unsupported'],
  ['WEB_CAPABILITY_UNSUPPORTED', 'unsupported'],
  ['WEB_PROVIDER_UNAVAILABLE', 'unavailable'],
  ['WEB_SETUP_TIMEOUT', 'unavailable'],
] as const)('projects a failed first setup %s as %s without saving', async (code, state) => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  f.rejectNextPrepare(code);
  await expect(f.connect('exa')).rejects.toMatchObject({ code });
  const status = f.service.status('u_a');
  expect(status.providers.find(provider => provider.provider === 'exa')?.state).toBe(state);
  expect(status.enabled).toBe(false);
  expect(status.revision).toBe(0);
  expect(f.records.size).toBe(0);
});

it('requires a connected provider before enabling', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  await expect(f.setEnabled(true)).rejects.toMatchObject({ code: 'WEB_CONNECTION_REQUIRED' });
  expect(f.service.status('u_a').enabled).toBe(false);
});

it('publishes a replacement version and invalidates the old generation', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  await f.connect('exa');
  await f.setEnabled(true);
  const first = f.service.currentEligibleProvider('u_a', 'exa', 'browse');
  expect(first).not.toBeNull();
  await f.connect('exa');
  const second = f.service.currentEligibleProvider('u_a', 'exa', 'browse');
  expect(second).toMatchObject({ credentialVersion: 2 });
  expect(f.service.isCurrent('u_a', first!)).toBe(false);
  expect(f.service.isCurrent('u_a', second!)).toBe(true);
  expect(f.calls.prepares).toBe(2);
  expect(f.calls.closes).toBeGreaterThanOrEqual(1);
});

it('rejects a stale revision without changing confirmed authority', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  await f.connect('exa');
  await expect(f.service.connect('u_a', 'exa', {
    protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key',
  }, signal())).rejects.toMatchObject({ code: 'WEB_SETTINGS_CONFLICT', currentRevision: 1 });
  await expect(f.service.settings('u_a', {
    protocolVersion: 1, expectedRevision: 0, enabled: true,
  }, signal())).rejects.toMatchObject({ code: 'WEB_SETTINGS_CONFLICT', currentRevision: 1 });
});

it('fences a disable synchronously before its held save resolves', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  await f.connect('exa');
  await f.setEnabled(true);
  const held = f.holdNextSave();
  const pending = f.service.settings('u_a', {
    protocolVersion: 1, expectedRevision: 2, enabled: false,
  }, signal());
  await held.entered;
  expect(f.service.status('u_a').enabled).toBe(false);
  expect(f.service.currentEligibleProvider('u_a', 'exa', 'browse')).toBeNull();
  held.release();
  await pending;
  expect(f.service.status('u_a').enabled).toBe(false);
});

it('stays denied when a disable save is uncertain', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  await f.connect('exa');
  await f.setEnabled(true);
  f.failNextSave('uncertain');
  await expect(f.service.settings('u_a', {
    protocolVersion: 1, expectedRevision: 2, enabled: false,
  }, signal())).rejects.toMatchObject({ code: 'WEB_WRITE_UNCERTAIN' });
  expect(f.service.status('u_a').enabled).toBe(false);
  expect(f.service.currentEligibleProvider('u_a', 'exa', 'browse')).toBeNull();
});

it('discards a warm load evicted before it completes', async () => {
  const f = connectionFixture();
  const held = f.holdNextRead();
  const warming = f.service.warmOwner('u_a');
  await held.entered;
  f.service.evict('u_a');
  held.release();
  await warming;
  expect(f.service.isPrepared('u_a')).toBe(false);
  expect(f.service.status('u_a').revision).toBe(0);
});

it('cannot publish a prepared session after eviction', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  const held = f.holdNextPrepare();
  const pending = f.connect('exa');
  await held.entered;
  f.service.evict('u_a');
  held.release();
  await expect(pending).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' });
  expect(f.service.isPrepared('u_a')).toBe(false);
  expect(f.sessions.size).toBe(0);
});

it('preserves the saved preference through a transient replacement outage', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  await f.connect('exa');
  await f.setEnabled(true);
  f.rejectNextPrepare('WEB_PROVIDER_UNAVAILABLE');
  await expect(f.connect('exa')).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' });
  expect(f.service.status('u_a')).toMatchObject({ enabled: true, effectiveEnabled: true });
});

it('restores API-key provider sessions after a process restart', async () => {
  const f = connectionFixture();
  await f.connect('exa');
  await f.setEnabled(true);
  expect(f.service.snapshot('u_a').providers.map(provider => provider.provider)).toEqual(['exa']);
  // A restart keeps the stored account but loses in-memory authority and MCP sessions.
  f.sessions.clear();
  f.service.evict('u_a');
  await f.service.warmOwner('u_a');
  expect(f.service.snapshot('u_a')).toMatchObject({ prepared: true, providers: [] });
  await f.service.prepareApiKeySessions('u_a', signal());
  expect(f.service.snapshot('u_a').providers.map(provider => provider.provider)).toEqual(['exa']);
});

it('expires provider authority exactly at capabilitiesExpireAt', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  await f.connect('exa');
  await f.setEnabled(true);
  const current = f.service.currentEligibleProvider('u_a', 'exa', 'browse');
  expect(current).not.toBeNull();
  f.setNow(new Date(current!.capabilitiesExpireAt));
  expect(f.service.currentEligibleProvider('u_a', 'exa', 'browse')).toBeNull();
  expect(f.service.snapshot('u_a').providers).toEqual([]);
  expect(f.service.status('u_a')).toMatchObject({ enabled: true, effectiveEnabled: false });
});

it('renews an expired saved key without changing the account revision', async () => {
  const f = connectionFixture();
  await f.connect('exa');
  await f.setEnabled(true);
  const saved = f.records.get('u_a')!;
  f.setNow(new Date(saved.connections.exa!.capabilitiesExpireAt));
  expect(f.service.snapshot('u_a').providers).toEqual([]);
  expect(f.service.status('u_a').effectiveEnabled).toBe(false);
  await f.service.prepareApiKeySessions('u_a', signal());
  expect(f.service.snapshot('u_a').providers.map(p => p.provider)).toEqual(['exa']);
  expect(f.service.status('u_a')).toMatchObject({
    enabled: true, effectiveEnabled: true, revision: saved.revision,
  });
  expect(f.records.get('u_a')).toEqual(saved);
});

it.each([
  ['WEB_INVALID_KEY', 'invalid-key'],
  ['WEB_PROVIDER_UNAVAILABLE', 'unavailable'],
] as const)('reports %s after a failed renewal without dropping the saved key',
  async (fault, state) => {
    const f = connectionFixture();
    await f.connect('exa');
    await f.setEnabled(true);
    const saved = f.records.get('u_a')!;
    f.setNow(new Date(saved.connections.exa!.capabilitiesExpireAt));
    f.rejectNextPrepare(fault);
    await f.service.prepareApiKeySessions('u_a', signal());
    const status = f.service.status('u_a');
    expect(status).toMatchObject({ enabled: true, effectiveEnabled: false });
    expect(status.providers.find(p => p.provider === 'exa')?.state).toBe(state);
    expect(f.records.get('u_a')).toEqual(saved);
  });

it('shares at most one renewal attempt between overlapping callers', async () => {
  const f = connectionFixture();
  await f.connect('exa');
  await f.setEnabled(true);
  const saved = f.records.get('u_a')!;
  f.setNow(new Date(saved.connections.exa!.capabilitiesExpireAt));
  const before = f.calls.prepares;
  const held = f.holdNextPrepare();
  const first = f.service.prepareApiKeySessions('u_a', signal());
  await held.entered;
  await f.service.prepareApiKeySessions('u_a', signal());
  expect(f.calls.prepares).toBe(before + 1);
  held.release();
  await first;
  expect(f.service.snapshot('u_a').providers.map(p => p.provider)).toEqual(['exa']);
});

it('retries a transient renewal failure only after its cooldown', async () => {
  const f = connectionFixture();
  await f.connect('exa');
  await f.setEnabled(true);
  const saved = f.records.get('u_a')!;
  const expiredAt = new Date(saved.connections.exa!.capabilitiesExpireAt);
  f.setNow(expiredAt);
  f.rejectNextPrepare('WEB_PROVIDER_UNAVAILABLE');
  await f.service.prepareApiKeySessions('u_a', signal());
  const failures = f.calls.prepares;
  await f.service.prepareApiKeySessions('u_a', signal());
  expect(f.calls.prepares).toBe(failures);
  f.setNow(new Date(expiredAt.getTime() + 61_000));
  await f.service.prepareApiKeySessions('u_a', signal());
  expect(f.calls.prepares).toBe(failures + 1);
  expect(f.service.snapshot('u_a').providers.map(p => p.provider)).toEqual(['exa']);
});

it('closes a revalidation candidate when disconnect wins the race', async () => {
  const f = connectionFixture();
  await f.connect('exa');
  await f.setEnabled(true);
  const saved = f.records.get('u_a')!;
  f.setNow(new Date(saved.connections.exa!.capabilitiesExpireAt));
  const held = f.holdNextPrepare();
  const pending = f.service.prepareApiKeySessions('u_a', signal());
  await held.entered;
  const status = f.service.status('u_a');
  await f.service.disconnect('u_a', 'exa', {
    protocolVersion: 1, expectedRevision: status.revision, confirm: true,
  }, signal());
  const closes = f.calls.closes;
  held.release();
  await pending;
  expect(f.calls.closes).toBeGreaterThan(closes);
  expect(f.service.snapshot('u_a').providers).toEqual([]);
  expect(f.sessions.size).toBe(0);
});

it('warms once and keeps status and errors free of candidate secrets', async () => {
  const f = connectionFixture();
  expect(f.service.snapshot('u_a')).toMatchObject({ prepared: false, providers: [] });
  await f.service.warmOwner('u_a');
  await f.service.warmOwner('u_a');
  expect(f.calls.reads).toBe(1);
  const status = await f.connect('exa');
  expect(JSON.stringify(status)).not.toContain('fixture-key');
  f.rejectNextPrepare('WEB_INVALID_KEY');
  try {
    await f.connect('exa');
    expect.fail('expected invalid key');
  } catch (error) {
    expect(JSON.stringify(error)).not.toContain('fixture-key');
  }
});

it('rejects disconnect for a provider that is not connected', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  await expect(f.service.disconnect('u_a', 'exa', {
    protocolVersion: 1, expectedRevision: 0, confirm: true,
  }, signal())).rejects.toMatchObject({ code: 'WEB_CONNECTION_REQUIRED' });
});

it('reports TinyFish API-key support before warm and after a confirmed key connection', async () => {
  const f = connectionFixture();
  try {
    expect(f.service.status('u_a').providers.find(p => p.provider === 'tinyfish'))
      .toMatchObject({ state: 'not-connected', authSupport: { apiKey: 'supported' } });
    await f.service.warmOwner('u_a');
    expect(f.service.status('u_a').providers.find(p => p.provider === 'tinyfish'))
      .toMatchObject({ state: 'not-connected', authSupport: { apiKey: 'supported' } });
    const status = await f.connect('tinyfish');
    expect(status.providers.find(p => p.provider === 'tinyfish')).toMatchObject({
      state: 'connected', authMethod: 'api-key',
      authSupport: { apiKey: 'supported', browserAuthorization: 'unverified' },
    });
    expect(status).toMatchObject({ revision: 1, enabled: false, effectiveEnabled: false });
    expect(f.records.get('u_a')?.connections.tinyfish?.authMethod).toBe('api-key');
    expect(JSON.stringify(f.records.get('u_a'))).not.toContain('fixture-key');
  } finally { await f.service.close(); }
});

it.each(['accepted', '401', 'probe-rejected'] as const)(
  'TinyFish normal key connect is header-only and fail-closed for %s', async outcome => {
    const storage = connectionFixture();
    const wire = mcpFixture([{
      name: 'search',
      inputSchema: {
        type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
      },
    }], { endpoint: 'https://agent.tinyfish.ai/mcp' });
    if (outcome === '401') wire.setStatus(401);
    if (outcome === 'probe-rejected') {
      wire.setResult({ isError: true, content: [{ type: 'text', text: 'rejected fixture key' }] });
    }
    const mcp = new McpWebClient({ fetch: wire.request });
    const service = new WebSearchConnections({
      store: () => storage.store,
      cipher: new WebSearchSecretCipher({ status: 'ready', key: Buffer.alloc(32, 7) }),
      mcp,
    });
    const candidate = 'sk-tinyfish-fixture-not-a-real-key';
    try {
      const pending = service.connect('u_a', 'tinyfish', {
        protocolVersion: 1, expectedRevision: 0, candidate,
      }, signal());
      if (outcome === 'accepted') {
        const status = await pending;
        expect(status.providers.find(p => p.provider === 'tinyfish'))
          .toMatchObject({ state: 'connected', authMethod: 'api-key' });
        expect(status.enabled).toBe(false);
        expect(storage.records.get('u_a')?.connections.tinyfish).toBeDefined();
        expect(JSON.stringify(storage.records.get('u_a'))).not.toContain(candidate);
      } else {
        await expect(pending).rejects.toMatchObject({ code: 'WEB_INVALID_KEY' });
        expect(storage.records.size).toBe(0);
        expect(storage.calls.writes).toBe(0);
        expect(service.preparedProvider('u_a', 'tinyfish')).toBeNull();
        expect(service.status('u_a')).toMatchObject({
          revision: 0, enabled: false, effectiveEnabled: false,
        });
      }
      expect(wire.calls.filter(c => c.body.method === 'initialize')).toHaveLength(1);
      expect(wire.calls.filter(c => c.body.method === 'tools/call'))
        .toHaveLength(outcome === '401' ? 0 : 1);
      expect(wire.calls.length).toBeGreaterThan(0);
      for (const call of wire.calls) {
        expect(call.url).toBe('https://agent.tinyfish.ai/mcp');
        expect(call.headers.get('authorization')).toBe(`Bearer ${candidate}`);
        expect(call.headers.has('x-api-key')).toBe(false);
        expect(call.url).not.toContain(candidate);
      }
      expect(service.status('u_a').providers
        .filter(p => p.provider !== 'tinyfish')
        .every(p => p.state === 'not-connected')).toBe(true);
    } finally {
      await service.close();
      await storage.service.close();
    }
  },
);
