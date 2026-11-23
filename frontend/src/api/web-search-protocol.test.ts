/**
 * ============================================================================
 * FILE: web-search-protocol.test.ts
 * LOCATION: frontend/src/api/web-search-protocol.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify frontend web-search wire guards, provider order, bounds, and URL rules.
 *
 * ROLE IN PROJECT:
 *    Prevents raw credentials, client overrides, oversized payloads, invalid
 *    connection states, or non-HTTP(S) URLs from entering UI state.
 *
 * KEY COMPONENTS:
 *    - Status, provider catalog, and request/response guards
 *    - WebSourceReference and WebSearchActivity bounds and invariants
 *    - OAuth URL validation and callback parameter extraction/scrubbing
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_SEARCH_ENABLED,
  DEFAULT_WEB_SEARCH_LIMITS,
  WEB_SEARCH_HTTP_ERROR_CODES,
  WEB_SEARCH_HTTP_ERRORS,
  WEB_SEARCH_POLICY,
  WEB_SEARCH_PROVIDER_CATALOG,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_ROUTES,
  extractAndScrubWebSearchOAuthCallback,
  isWebPresentationEvent,
  isWebSearchActivity,
  isWebSearchActivityList,
  isWebSearchConnectRequest,
  isWebSearchDisconnectRequest,
  isWebSearchHttpError,
  isBlockedWebDomain,
  isWebSearchLimits,
  normalizeBlockedWebDomain,
  isWebSearchOAuthCompleteRequest,
  isWebSearchOAuthStartResponse,
  isWebSearchPublicStatus,
  isWebSearchSettingsRequest,
  isWebSourceReference,
  isWebSourceReferenceList,
  type WebSearchPublicStatus,
} from './web-search-protocol.ts';

function disconnectedStatus(): WebSearchPublicStatus {
  return {
    protocolVersion: 1,
    revision: 0,
    enabled: false,
    effectiveEnabled: false,
    providers: WEB_SEARCH_PROVIDERS.map((provider) => ({
      provider,
      state: 'not-connected',
      authMethod: null,
      authSupport: { apiKey: 'unverified', browserAuthorization: 'unverified' },
      capabilities: { browse: false, fetch: false },
      lastValidatedAt: null,
    })),
  };
}

const sourceFixture = {
  sourceId: 'src_1',
  toolCallId: 'call_1',
  provider: 'exa' as const,
  kind: 'browse' as const,
  title: 'Example Docs',
  url: 'https://example.com/docs',
  retrievedAt: '2026-11-14T00:00:00.000Z',
};

describe('web-search-protocol', () => {
  it('freezes default-off policy, 5/5 defaults, routes, and ordered provider catalog', () => {
    expect(DEFAULT_WEB_SEARCH_ENABLED).toBe(false);
    expect(DEFAULT_WEB_SEARCH_LIMITS).toEqual({ maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 });
    expect(WEB_SEARCH_PROVIDERS).toEqual(['tinyfish', 'keenable', 'exa', 'tavily', 'firecrawl']);
    expect(WEB_SEARCH_PROVIDER_CATALOG.map((item) => item.provider)).toEqual([...WEB_SEARCH_PROVIDERS]);
    expect(WEB_SEARCH_ROUTES.status).toBe('/plugins/web-search/status');
    expect(WEB_SEARCH_ROUTES.settings).toBe('/plugins/web-search/settings');
    expect(WEB_SEARCH_ROUTES.connect('exa')).toBe('/plugins/web-search/providers/exa/connect');
    expect(WEB_SEARCH_ROUTES.disconnect('tavily')).toBe('/plugins/web-search/providers/tavily/disconnect');
    expect(WEB_SEARCH_ROUTES.oauthStart('tinyfish')).toBe('/plugins/web-search/providers/tinyfish/oauth/start');
    expect(WEB_SEARCH_ROUTES.oauthComplete('firecrawl')).toBe('/plugins/web-search/providers/firecrawl/oauth/complete');
    for (const entry of WEB_SEARCH_PROVIDER_CATALOG) {
      expect(entry.consoleUrl.startsWith('https://')).toBe(true);
    }
  });

  it('validates WebSearchLimits integers bounded 1..20', () => {
    expect(isWebSearchLimits({ maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 })).toBe(true);
    expect(isWebSearchLimits({ maxSearchesPerTurn: 1, maxFetchesPerTurn: 20 })).toBe(true);
    for (const bad of [
      { maxSearchesPerTurn: 0, maxFetchesPerTurn: 5 },
      { maxSearchesPerTurn: 21, maxFetchesPerTurn: 5 },
      { maxSearchesPerTurn: 1.5, maxFetchesPerTurn: 5 },
      { maxSearchesPerTurn: 5, maxFetchesPerTurn: 5, extra: true },
    ]) {
      expect(isWebSearchLimits(bad)).toBe(false);
    }
  });

  it('normalizes URLs and bare domains for blockedDomains while rejecting invalid inputs', () => {
    expect(normalizeBlockedWebDomain('https://www.Reddit.com/r/programming?sort=top')).toBe('reddit.com');
    expect(normalizeBlockedWebDomain('http://old.reddit.com/r/news')).toBe('old.reddit.com');
    expect(normalizeBlockedWebDomain('  pinterest.com/ideas/  ')).toBe('pinterest.com');
    expect(normalizeBlockedWebDomain('docs.example.co.uk.')).toBe('docs.example.co.uk');
    expect(isBlockedWebDomain('reddit.com')).toBe(true);
    for (const bad of ['', '   ', 'localhost', '127.0.0.1', 'ftp://example.com', 'https://user:pass@example.com', '*.example.com', 'not a url']) {
      expect(normalizeBlockedWebDomain(bad)).toBeNull();
    }
  });

  it('validates public status order, effectiveEnabled invariant, capabilities, and secret rejection', () => {
    const base = disconnectedStatus();
    expect(isWebSearchPublicStatus(base)).toBe(true);
    expect(isWebSearchPublicStatus({ ...base, effectiveEnabled: true })).toBe(false);
    expect(isWebSearchPublicStatus({ ...base, enabled: true })).toBe(true);
    expect(isWebSearchPublicStatus({ ...base, enabled: true, effectiveEnabled: true })).toBe(false);
    expect(isWebSearchPublicStatus({ ...base, providers: [...base.providers].reverse() })).toBe(false);
    expect(isWebSearchPublicStatus({ ...base, providers: base.providers.slice(1) })).toBe(false);

    const withConnected: WebSearchPublicStatus = {
      ...base,
      revision: 2,
      enabled: true,
      effectiveEnabled: true,
      providers: base.providers.map((item) =>
        item.provider === 'exa'
          ? {
              ...item,
              state: 'connected',
              authMethod: 'api-key',
              authSupport: { apiKey: 'supported', browserAuthorization: 'unsupported' },
              capabilities: { browse: true, fetch: true },
              lastValidatedAt: sourceFixture.retrievedAt,
            }
          : item,
      ),
    };
    expect(isWebSearchPublicStatus(withConnected)).toBe(true);

    const noCapabilities = {
      ...withConnected,
      providers: withConnected.providers.map((item) =>
        item.provider === 'exa' ? { ...item, capabilities: { browse: false, fetch: false } } : item,
      ),
    };
    expect(isWebSearchPublicStatus(noCapabilities)).toBe(false);

    for (const secretField of ['candidate', 'apiKey', 'accessToken', 'refreshToken', 'envelope', 'userId', 'endpoint']) {
      expect(isWebSearchPublicStatus({ ...withConnected, [secretField]: 'leaked' })).toBe(false);
      expect(
        isWebSearchPublicStatus({
          ...withConnected,
          providers: withConnected.providers.map((item, idx) =>
            idx === 0 ? { ...item, [secretField]: 'leaked' } : item,
          ),
        }),
      ).toBe(false);
    }
  });

  it('validates write-only mutations, bounded candidates, HTTP errors, and HTTPS OAuth responses', () => {
    expect(isWebSearchSettingsRequest({ protocolVersion: 1, expectedRevision: 0, enabled: true })).toBe(true);
    expect(isWebSearchSettingsRequest({ protocolVersion: 1, expectedRevision: 0, enabled: true, userId: 'u' })).toBe(false);
    expect(isWebSearchConnectRequest({ protocolVersion: 1, expectedRevision: 1, candidate: 'key-123' })).toBe(true);
    for (const candidate of ['', ' key ', 'a\nb', 'x'.repeat(WEB_SEARCH_POLICY.maxApiKeyBytes + 1), '😀'.repeat(1025)]) {
      expect(isWebSearchConnectRequest({ protocolVersion: 1, expectedRevision: 1, candidate })).toBe(false);
    }
    expect(isWebSearchDisconnectRequest({ protocolVersion: 1, expectedRevision: 1, confirm: true })).toBe(true);
    expect(isWebSearchDisconnectRequest({ protocolVersion: 1, expectedRevision: 1, confirm: false })).toBe(false);

    expect(
      isWebSearchOAuthStartResponse({
        protocolVersion: 1,
        authorizationUrl: 'https://provider.example.com/oauth/authorize?state=public',
        expiresAt: sourceFixture.retrievedAt,
      }),
    ).toBe(true);
    for (const url of [
      'http://provider.example.com/oauth',
      'javascript:alert(1)',
      'https://u:p@provider.example.com/oauth',
      'https://provider.example.com/oauth?access_token=secret',
      'https://provider.example.com/oauth?apiKey=secret',
    ]) {
      expect(
        isWebSearchOAuthStartResponse({
          protocolVersion: 1,
          authorizationUrl: url,
          expiresAt: sourceFixture.retrievedAt,
        }),
      ).toBe(false);
    }
    expect(isWebSearchOAuthCompleteRequest({ protocolVersion: 1, rawQuery: 'code=abc&state=xyz' })).toBe(true);
    expect(isWebSearchOAuthCompleteRequest({ protocolVersion: 1, rawQuery: 'x'.repeat(4097) })).toBe(false);

    for (const code of WEB_SEARCH_HTTP_ERROR_CODES) {
      expect(
        isWebSearchHttpError({
          protocolVersion: 1,
          error: { code, retryable: WEB_SEARCH_HTTP_ERRORS[code].retryable, currentRevision: null },
        }),
      ).toBe(true);
    }
    expect(
      isWebSearchHttpError({
        protocolVersion: 1,
        error: { code: 'WEB_INVALID_KEY', retryable: false, currentRevision: 1, message: 'raw' },
      }),
    ).toBe(false);
  });

  it('enforces WebSourceReference, WebSearchActivity, and WebPresentationEvent bounds and invariants', () => {
    expect(isWebSourceReference(sourceFixture)).toBe(true);
    expect(isWebSourceReference({ ...sourceFixture, url: 'javascript:alert(1)' })).toBe(false);
    expect(isWebSourceReference({ ...sourceFixture, url: 'https://example.com/?apiKey=secret' })).toBe(false);
    expect(isWebSourceReferenceList([sourceFixture, sourceFixture])).toBe(false);
    expect(
      isWebSourceReferenceList(
        Array.from({ length: WEB_SEARCH_POLICY.maxSourcesPerMessage + 1 }, (_, i) => ({
          ...sourceFixture,
          sourceId: `src_${i}`,
        })),
      ),
    ).toBe(false);
    expect(
      isWebSourceReferenceList(
        Array.from({ length: 15 }, (_, i) => ({
          ...sourceFixture,
          sourceId: `src_${i}`,
          title: '界'.repeat(160),
          url: `https://example.com/${'x'.repeat(950)}`,
        })),
      ),
    ).toBe(false);

    const browseOk = {
      toolCallId: 'call_1',
      mode: 'browse' as const,
      phase: 'searching' as const,
      provider: 'tinyfish' as const,
      code: null,
    };
    const fetchOk = {
      toolCallId: 'call_2',
      mode: 'fetch' as const,
      phase: 'reading' as const,
      provider: 'exa' as const,
      code: null,
    };
    const failedOk = {
      toolCallId: 'call_3',
      mode: 'fetch' as const,
      phase: 'failed' as const,
      provider: 'exa' as const,
      code: 'WEB_URL_UNSAFE',
    };
    expect(isWebSearchActivity(browseOk)).toBe(true);
    expect(isWebSearchActivity(fetchOk)).toBe(true);
    expect(isWebSearchActivity(failedOk)).toBe(true);
    expect(isWebSearchActivity({ ...browseOk, phase: 'reading' })).toBe(false);
    expect(isWebSearchActivity({ ...fetchOk, phase: 'searching' })).toBe(false);
    expect(isWebSearchActivity({ ...browseOk, phase: 'failed', code: null })).toBe(false);
    expect(isWebSearchActivity({ ...browseOk, phase: 'completed', code: 'WEB_URL_UNSAFE' })).toBe(false);
    expect(isWebSearchActivity({ ...browseOk, query: 'leak' })).toBe(false);
    expect(
      isWebSearchActivityList(
        Array.from({ length: WEB_SEARCH_POLICY.maxActivitiesPerMessage + 1 }, (_, i) => ({
          ...browseOk,
          toolCallId: `call_${i}`,
        })),
      ),
    ).toBe(false);

    expect(isWebPresentationEvent({ type: 'web-activity', activity: browseOk })).toBe(true);
    expect(isWebPresentationEvent({ type: 'web-sources', sources: [sourceFixture] })).toBe(true);
    expect(isWebPresentationEvent({ type: 'web-activity', activity: browseOk, extra: true })).toBe(false);
  });

  it('extracts and scrubs Web Search OAuth callback parameters without touching Calendar callbacks', () => {
    expect(
      extractAndScrubWebSearchOAuthCallback(
        'http://127.0.0.1:5173/?plugin=google-calendar&oauth=connected&code=secret&state=nonce',
      ),
    ).toBeNull();

    expect(
      extractAndScrubWebSearchOAuthCallback(
        'http://127.0.0.1:5173/?plugin=web-search&provider=exa&code=oauth_code&state=oauth_state&keep=1',
      ),
    ).toEqual({
      kind: 'complete-query',
      provider: 'exa',
      rawQuery: 'plugin=web-search&provider=exa&code=oauth_code&state=oauth_state&keep=1',
      scrubbedPathAndSearch: '/?keep=1',
    });

    expect(
      extractAndScrubWebSearchOAuthCallback(
        'http://127.0.0.1:5173/?section=web-search&provider=tavily&oauth=connected',
      ),
    ).toEqual({
      kind: 'resolved',
      provider: 'tavily',
      outcome: 'connected',
      scrubbedPathAndSearch: '/',
    });
  });
});
