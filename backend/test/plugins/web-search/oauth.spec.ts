/**
 * ============================================================================
 * FILE: oauth.spec.ts
 * LOCATION: backend/test/plugins/web-search/oauth.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify capability-gated OAuth discovery, binding, and single-use completion.
 *
 * ROLE IN PROJECT:
 *    Proves exact-origin discovery, DCR/PKCE, owner/session/browser binding,
 *    denial/expiry/lost-ACK behavior, and no publish after revocation.
 *
 * KEY COMPONENTS:
 *    - Five-provider success fixtures with no automatic enablement.
 *    - Metadata/PKCE/refresh/audience capability denials.
 *    - Wrong binding, malformed query, concurrent completion, held exchange.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { WEB_SEARCH_PROVIDERS } from '../../../src/contracts/web-search-policy.js';
import { oauthFixture, webSearchPrincipal } from './fixtures.js';

const signal = () => new AbortController().signal;

it('binds OAuth to provider owner session browser and one callback exchange', async () => {
  const f = oauthFixture('firecrawl');
  const started = await f.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  expect(new URL(started.authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256');
  await expect(f.complete({ state, code: 'fixture-code', cookie: 'wrong-cookie' }))
    .rejects.toMatchObject({ code: 'WEB_OAUTH_BINDING_MISMATCH' });
  expect(f.tokenPosts()).toBe(0);
  expect(await f.complete({ state, code: 'fixture-code', cookie: started.browserCookie })).toBe('connected');
  await expect(f.complete({ state, code: 'fixture-code', cookie: started.browserCookie }))
    .rejects.toMatchObject({ code: 'WEB_OAUTH_STATE_INVALID' });
  expect(f.tokenPosts()).toBe(1);
  expect(f.status().enabled).toBe(false);
});

it.each(WEB_SEARCH_PROVIDERS)('completes %s OAuth without enabling the account', async provider => {
  const f = oauthFixture(provider);
  const started = await f.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  expect(await f.complete({ state, code: 'fixture-code', cookie: started.browserCookie }))
    .toBe('connected');
  const status = f.status();
  const card = status.providers.find(item => item.provider === provider)!;
  expect(card).toMatchObject({
    state: 'connected', authMethod: 'oauth',
    authSupport: { browserAuthorization: 'supported' },
    capabilities: { browse: true, fetch: false },
  });
  expect(status.enabled).toBe(false);
  expect(f.tokenPosts()).toBe(1);
});

it.each([
  ['missing registration', (metadata: Record<string, unknown>) => ({
    ...metadata, registration_endpoint: undefined })],
  ['unsupported PKCE', (metadata: Record<string, unknown>) => ({
    ...metadata, code_challenge_methods_supported: ['plain'] })],
  ['missing refresh support', (metadata: Record<string, unknown>) => ({
    ...metadata, grant_types_supported: ['authorization_code'] })],
  ['off-origin issuer', (metadata: Record<string, unknown>) => ({
    ...metadata, issuer: 'https://evil.example' })],
  ['off-origin token endpoint', (metadata: Record<string, unknown>) => ({
    ...metadata, token_endpoint: 'https://evil.example/token' })],
] as const)('rejects %s as unsupported', async (_name, patch) => {
  const f = oauthFixture('exa');
  f.setMetadata(patch(f.defaultMetadata()));
  await expect(f.start()).rejects.toMatchObject({ code: 'WEB_AUTH_UNSUPPORTED' });
});

it('rejects a mismatched protected-resource audience', async () => {
  const f = oauthFixture('exa');
  f.setResourceMetadata({ resource: 'https://evil.example/', authorization_servers: ['https://auth.exa.ai'] });
  await expect(f.start()).rejects.toMatchObject({ code: 'WEB_AUTH_UNSUPPORTED' });
  const missing = oauthFixture('exa');
  missing.setResourceMetadata({ resource: 'https://mcp.exa.ai/mcp/oauth' });
  await expect(missing.start()).rejects.toMatchObject({ code: 'WEB_AUTH_UNSUPPORTED' });
});

it('rejects wrong owner, session, provider, and malformed callback queries', async () => {
  const f = oauthFixture('exa');
  const started = await f.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  await expect(f.complete({ state, code: 'c', cookie: started.browserCookie, owner: 'u_b' }))
    .rejects.toMatchObject({ code: 'WEB_OAUTH_STATE_INVALID' });
  await expect(f.complete({ state, code: 'c', cookie: started.browserCookie, session: 'session_2' }))
    .rejects.toMatchObject({ code: 'WEB_OAUTH_BINDING_MISMATCH' });
  await expect(f.oauth.complete(webSearchPrincipal(), 'tavily', {
    rawQuery: `state=${state}&code=c`, cookieHeader: undefined,
  }, signal())).rejects.toMatchObject({ code: 'WEB_OAUTH_BINDING_MISMATCH' });
  for (const rawQuery of ['state=a&state=b&code=c', 'state=a&code=c&code=d',
    'state=a&unknown=x&code=c', 'state=a', 'state=a&code=c&error=denied']) {
    await expect(f.oauth.complete(webSearchPrincipal(), 'exa', {
      rawQuery, cookieHeader: `aurvin_web_search_oauth_exa=${'A'.repeat(43)}`,
    }, signal())).rejects.toMatchObject({ code: 'WEB_INVALID_REQUEST' });
  }
});

it('returns denied without an exchange and expires exactly at the state TTL', async () => {
  const denied = oauthFixture('exa');
  const started = await denied.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  expect(await denied.complete({ state, error: 'access_denied', cookie: started.browserCookie }))
    .toBe('denied');
  expect(denied.tokenPosts()).toBe(0);

  const expired = oauthFixture('exa');
  const pending = await expired.start();
  const pendingState = new URL(pending.authorizationUrl).searchParams.get('state')!;
  expired.advance(600_000);
  await expect(expired.complete({ state: pendingState, code: 'c', cookie: pending.browserCookie }))
    .rejects.toMatchObject({ code: 'WEB_OAUTH_EXPIRED' });
  expect(expired.tokenPosts()).toBe(0);
});

it('never exchanges after a lost consume ACK', async () => {
  const f = oauthFixture('exa');
  const started = await f.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  f.loseConsumeAck();
  await expect(f.complete({ state, code: 'c', cookie: started.browserCookie }))
    .rejects.toMatchObject({ code: 'WEB_WRITE_UNCERTAIN' });
  expect(f.tokenPosts()).toBe(0);
});

it('lets only one simultaneous completion exchange the code', async () => {
  const f = oauthFixture('exa');
  const started = await f.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  const held = f.holdTokenResponse();
  const first = f.complete({ state, code: 'c', cookie: started.browserCookie });
  await held.entered;
  await expect(f.complete({ state, code: 'c', cookie: started.browserCookie }))
    .rejects.toMatchObject({ code: 'WEB_OAUTH_STATE_INVALID' });
  held.release();
  expect(await first).toBe('connected');
  expect(f.tokenPosts()).toBe(1);
});

it('does not publish after eviction during the token exchange', async () => {
  const f = oauthFixture('exa');
  await f.connections.warmOwner('u_a');
  await f.connections.connect('u_a', 'exa', {
    protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key',
  }, signal());
  const started = await f.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  const held = f.holdTokenResponse();
  const pending = f.complete({ state, code: 'c', cookie: started.browserCookie });
  await held.entered;
  f.connections.evict('u_a');
  held.release();
  await expect(pending).rejects.toBeDefined();
  expect(f.status().providers.every(provider => provider.state === 'not-connected')).toBe(true);
  expect(f.status().revision).toBe(0);
});

it('rejects a stale revision before exchanging', async () => {
  const f = oauthFixture('exa');
  const started = await f.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  await f.connections.settings('u_a', {
    protocolVersion: 1, expectedRevision: 0, enabled: false,
  }, signal());
  await expect(f.complete({ state, code: 'c', cookie: started.browserCookie }))
    .rejects.toMatchObject({ code: 'WEB_OAUTH_STATE_INVALID' });
  expect(f.tokenPosts()).toBe(0);
});

it('preserves an old API-key connection when the OAuth flow fails', async () => {
  const f = oauthFixture('exa');
  await f.connections.warmOwner('u_a');
  await f.connections.connect('u_a', 'exa', {
    protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key',
  }, signal());
  const started = await f.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  f.setTokenResponse({ access_token: 'x', token_type: 'Bearer', expires_in: 0 });
  await expect(f.complete({ state, code: 'c', cookie: started.browserCookie }))
    .rejects.toMatchObject({ code: 'WEB_AUTH_UNSUPPORTED' });
  expect(f.status().providers.find(item => item.provider === 'exa'))
    .toMatchObject({ state: 'connected', authMethod: 'api-key' });
});

it('TinyFish Clerk discovery completes with only offline_access and no premature support claim', async () => {
  const f = oauthFixture('tinyfish');
  try {
    expect(f.status().providers.find(p => p.provider === 'tinyfish')?.authSupport.browserAuthorization)
      .toBe('unverified');
    const started = await f.start();
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://clerk.tinyfish.ai/oauth/authorize');
    expect(url.searchParams.get('resource')).toBe('https://agent.tinyfish.ai/mcp');
    expect(url.searchParams.get('scope')).toBe('offline_access');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(f.oauthStates[0]?.binding.scope).toBe('offline_access');
    expect(f.status().providers.find(p => p.provider === 'tinyfish'))
      .toMatchObject({ state: 'not-connected', authSupport: { browserAuthorization: 'unverified' } });
    const registration = f.requests.find(r => r.method === 'POST'
      && r.url === 'https://clerk.tinyfish.ai/oauth/register');
    expect(registration).toBeDefined();
    expect(JSON.parse(registration!.body)).toMatchObject({
      scope: 'offline_access', token_endpoint_auth_method: 'none',
      redirect_uris: [
        'https://aurvin.example.com/api/plugins/web-search/providers/tinyfish/oauth/callback',
      ],
    });
    const state = url.searchParams.get('state')!;
    expect(await f.complete({ state, code: 'fixture-code', cookie: started.browserCookie }))
      .toBe('connected');
    expect(f.status().providers.find(p => p.provider === 'tinyfish')).toMatchObject({
      state: 'connected', authMethod: 'oauth',
      authSupport: { browserAuthorization: 'supported' },
    });
    expect(f.status().enabled).toBe(false);
    expect(f.tokenPosts()).toBe(1);
    expect(f.requests.some(r => r.url === 'https://agent.tinyfish.ai/.well-known/oauth-protected-resource/mcp'))
      .toBe(true);
    expect(f.requests.some(r => r.url === 'https://clerk.tinyfish.ai/.well-known/oauth-authorization-server'))
      .toBe(true);
    expect(f.requests.every(r => r.redirect === 'error')).toBe(true);
    expect(f.requests.filter(r => r.method === 'POST').map(r => r.url)).toEqual([
      'https://clerk.tinyfish.ai/oauth/register', 'https://clerk.tinyfish.ai/oauth/token',
    ]);
  } finally {
    await f.oauth.close();
    await f.connections.close();
  }
});

it.each(['server', 'resource'] as const)(
  'TinyFish refuses missing offline_access in %s metadata instead of broadening scopes', async source => {
    const f = oauthFixture('tinyfish');
    try {
      if (source === 'server') {
        f.setMetadata({ ...f.defaultMetadata(), scopes_supported: ['openid', 'profile', 'email'] });
      } else {
        f.setResourceMetadata({
          resource: 'https://agent.tinyfish.ai/mcp',
          authorization_servers: ['https://clerk.tinyfish.ai'], scopes_supported: ['openid', 'email'],
        });
      }
      await expect(f.start()).rejects.toMatchObject({ code: 'WEB_AUTH_UNSUPPORTED' });
      expect(f.requests.filter(r => r.method === 'POST')).toEqual([]);
      expect(f.oauthStates).toEqual([]);
      expect(f.records.size).toBe(0);
    } finally {
      await f.oauth.close();
      await f.connections.close();
    }
  },
);

it.each(['issuer', 'token_endpoint', 'registration_endpoint'] as const)(
  'TinyFish still rejects off-allowlist %s metadata', async field => {
    const f = oauthFixture('tinyfish');
    try {
      f.setMetadata({ ...f.defaultMetadata(), [field]: `https://clerk.tinyfish.ai.evil.example/${field}` });
      await expect(f.start()).rejects.toMatchObject({ code: 'WEB_AUTH_UNSUPPORTED' });
      expect(f.requests.every(r => !r.url.includes('evil.example'))).toBe(true);
      expect(f.requests.filter(r => r.method === 'POST')).toEqual([]);
      expect(f.oauthStates).toEqual([]);
      expect(f.records.size).toBe(0);
    } finally {
      await f.oauth.close();
      await f.connections.close();
    }
  },
);

it('TinyFish rejects a secret-bearing DCR reply without storing or claiming support', async () => {
  const f = oauthFixture('tinyfish');
  try {
    f.setRegistrationResponse({
      client_id: 'client_1', client_secret: 'fixture-forbidden-secret',
      token_endpoint_auth_method: 'none',
      redirect_uris: [
        'https://aurvin.example.com/api/plugins/web-search/providers/tinyfish/oauth/callback',
      ],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
    await expect(f.start()).rejects.toMatchObject({ code: 'WEB_AUTH_UNSUPPORTED' });
    expect(f.requests.filter(r => r.url === 'https://clerk.tinyfish.ai/oauth/register'))
      .toHaveLength(1);
    expect(f.oauthStates).toEqual([]);
    expect(f.records.size).toBe(0);
    expect(f.tokenPosts()).toBe(0);
    expect(f.status().providers.find(p => p.provider === 'tinyfish')?.authSupport.browserAuthorization)
      .toBe('unverified');
  } finally {
    await f.oauth.close();
    await f.connections.close();
  }
});

async function authorized(provider: 'exa' | 'firecrawl' = 'exa', userId = 'u_a') {
  const f = oauthFixture(provider);
  const started = await f.start(userId);
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  await f.complete({ state, code: 'fixture-code', cookie: started.browserCookie, owner: userId });
  return f;
}

it('renewal is off-turn and coalesces concurrent single-use refresh work', async () => {
  const f = await authorized('firecrawl');
  f.expireAccess();
  expect(f.refreshPosts()).toBe(0);
  f.status();
  expect(f.refreshPosts()).toBe(0);
  const signal = new AbortController().signal;
  await Promise.all([
    f.oauth.maintainOwner('u_a', signal),
    f.oauth.maintainOwner('u_a', signal),
  ]);
  expect(f.refreshPosts()).toBe(1);
  expect(f.records.get('u_a')!.connections.firecrawl).toMatchObject({
    credentialVersion: 2, oauthRefresh: 'idle', state: 'connected',
  });
});

it('skips an expired access token without refreshing until maintenance runs', async () => {
  const f = await authorized('exa');
  const status = f.status();
  await f.connections.settings('u_a', {
    protocolVersion: 1, expectedRevision: status.revision, enabled: true,
  }, signal());
  f.expireAccess();
  expect(f.connections.currentEligibleProvider('u_a', 'exa', 'browse')).toBeNull();
  expect(f.connections.snapshot('u_a').providers).toEqual([]);
  expect(f.status().providers.find(item => item.provider === 'exa')?.state).toBe('connected');
  expect(f.refreshPosts()).toBe(0);
  await f.maintain();
  expect(f.refreshPosts()).toBe(1);
  expect(f.connections.currentEligibleProvider('u_a', 'exa', 'browse')).not.toBeNull();
});

it('marks reconnect-required after a lost refresh response without replay', async () => {
  const f = await authorized('exa');
  f.expireAccess();
  f.failNextToken();
  await f.maintain();
  expect(f.refreshPosts()).toBe(1);
  expect(f.status().providers.find(item => item.provider === 'exa')?.state)
    .toBe('reconnect-required');
  await f.maintain();
  expect(f.refreshPosts()).toBe(1);
});

it('marks reconnect-required when the rotated-token save is uncertain', async () => {
  const f = await authorized('exa');
  f.expireAccess();
  const held = f.holdTokenResponse();
  const pending = f.maintain();
  await held.entered;
  f.failNextSave('uncertain');
  held.release();
  await pending;
  expect(f.refreshPosts()).toBe(1);
  expect(f.status().providers.find(item => item.provider === 'exa')?.state)
    .toBe('reconnect-required');
  await f.maintain();
  expect(f.refreshPosts()).toBe(1);
});

it('never replays a restart with a dispatching refresh marker', async () => {
  const f = await authorized('exa');
  const connection = f.connections.oauthConnection('u_a', 'exa')!;
  await f.connections.updateOAuthRefresh('u_a', 'exa', {
    expectedRevision: connection.revision, oauthRefresh: 'dispatching',
  });
  await f.maintain();
  expect(f.refreshPosts()).toBe(0);
  expect(f.status().providers.find(item => item.provider === 'exa')?.state)
    .toBe('reconnect-required');
});

it('applies a transient cooldown when no refresh POST was sent', async () => {
  const f = await authorized('exa');
  f.expireAccess();
  f.failNextSave('conflict');
  await f.maintain();
  expect(f.refreshPosts()).toBe(0);
  await f.maintain();
  expect(f.refreshPosts()).toBe(0);
});

it('caps maintenance at two owners process-wide', async () => {
  const f = oauthFixture('exa');
  for (const userId of ['u_a', 'u_b', 'u_c']) {
    const started = await f.start(userId);
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    await f.complete({ state, code: 'c', cookie: started.browserCookie, owner: userId });
  }
  f.expireAccess();
  const held = f.holdTokenResponse();
  const first = f.maintain('u_a');
  const second = f.maintain('u_b');
  await held.entered;
  await f.maintain('u_c');
  held.release();
  await Promise.all([first, second]);
  expect(f.refreshPosts()).toBe(2);
});

it('renews an expired API-key lease from the periodic sweep without login preparation', async () => {
  vi.useFakeTimers();
  try {
    const f = oauthFixture('exa');
    await f.connections.connect('u_a', 'exa', {
      protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key',
    }, signal());
    const connected = f.connections.status('u_a');
    await f.connections.settings('u_a', {
      protocolVersion: 1, expectedRevision: connected.revision, enabled: true,
    }, signal());
    const saved = f.records.get('u_a')!;
    f.advance(24 * 60 * 60 * 1_000);
    expect(f.connections.snapshot('u_a').providers).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.connections.snapshot('u_a').providers.map(provider => provider.provider))
      .toEqual(['exa']);
    expect(f.records.get('u_a')).toEqual(saved);
    await f.oauth.close();
  } finally {
    vi.useRealTimers();
  }
});

it('stops the renewal sweep when the plugin closes', async () => {
  vi.useFakeTimers();
  try {
    const f = oauthFixture('exa');
    await f.connections.connect('u_a', 'exa', {
      protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key',
    }, signal());
    const connected = f.connections.status('u_a');
    await f.connections.settings('u_a', {
      protocolVersion: 1, expectedRevision: connected.revision, enabled: true,
    }, signal());
    f.advance(24 * 60 * 60 * 1_000);
    await f.oauth.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.connections.snapshot('u_a').providers).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
