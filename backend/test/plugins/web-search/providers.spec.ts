/**
 * ============================================================================
 * FILE: providers.spec.ts
 * LOCATION: backend/test/plugins/web-search/providers.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the fixed five-provider MCP endpoint, tool, and credential mapping.
 *
 * ROLE IN PROJECT:
 *    Guards the P2 static allowlist so no discovered catalog, alias, REST path,
 *    query credential, or anonymous call can expand the model-facing surface.
 *
 * KEY COMPONENTS:
 *    - Exact provider/tool table and ten browse/fetch argument mappings.
 *    - Header-only credential construction for key and OAuth Bearer modes.
 *    - Client-guarded fetch admission for all five providers.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import { WEB_SEARCH_PROVIDERS } from '../../../src/contracts/web-search-policy.js';
import {
  credentialHeaders, mapCall, providerDefinition,
} from '../../../src/plugins/web-search/providers.js';

it('maps only the exact five search/read tools and header credentials', () => {
  const expected = [
    ['tinyfish', 'search', 'fetch_content'],
    ['keenable', 'search_web_pages', 'fetch_page_content'],
    ['exa', 'web_search_exa', 'web_fetch_exa'],
    ['tavily', 'tavily_search', 'tavily_extract'],
    ['firecrawl', 'firecrawl_search', 'firecrawl_scrape'],
  ];
  expect(WEB_SEARCH_PROVIDERS.map(p => {
    const d = providerDefinition(p); return [p, d.browseTool, d.fetchTool];
  })).toEqual(expected);
  expect(mapCall('exa', { mode: 'fetch', url: 'https://example.com/' }, 12000))
    .toEqual({ name: 'web_fetch_exa', arguments: { urls: ['https://example.com/'], maxCharacters: 4000 } });
  expect(mapCall('firecrawl', { mode: 'browse', query: 'example' }, 12000))
    .toEqual({ name: 'firecrawl_search', arguments: { query: 'example', limit: 5 } });
  expect(credentialHeaders('keenable', { method: 'api-key', apiKey: 'fixture-secret' }))
    .toEqual({ 'X-API-Key': 'fixture-secret' });
  expect(credentialHeaders('tinyfish', { method: 'api-key', apiKey: 'sk-tinyfish-fixture' }))
    .toEqual({ Authorization: 'Bearer sk-tinyfish-fixture' });
  expect(WEB_SEARCH_PROVIDERS.every(p => new URL(providerDefinition(p).apiKeyEndpoint).search === ''))
    .toBe(true);
});

it('maps every browse mode to the exact provider arguments', () => {
  expect(WEB_SEARCH_PROVIDERS.map(provider =>
    mapCall(provider, { mode: 'browse', query: 'example' }, 12000))).toEqual([
    { name: 'search', arguments: { query: 'example' } },
    { name: 'search_web_pages', arguments: {
      query: 'example', max_results: 5, snippet_max_length: 320, output_format: 'json', disable_cards: true } },
    { name: 'web_search_exa', arguments: { query: 'example', numResults: 5 } },
    { name: 'tavily_search', arguments: {
      query: 'example', search_depth: 'basic', max_results: 5, include_images: false, include_raw_content: false } },
    { name: 'firecrawl_search', arguments: { query: 'example', limit: 5 } },
  ]);
});

it('forwards blocked domains natively to supported browse providers only', () => {
  const blocked = ['reddit.com', 'pinterest.com'];
  expect(WEB_SEARCH_PROVIDERS.map(provider =>
    mapCall(provider, { mode: 'browse', query: 'example' }, 12000, blocked))).toEqual([
    { name: 'search', arguments: { query: 'example', exclude_domains: 'reddit.com,pinterest.com' } },
    { name: 'search_web_pages', arguments: {
      query: 'example', max_results: 5, snippet_max_length: 320, output_format: 'json', disable_cards: true,
      exclude_domains: ['reddit.com', 'pinterest.com'] } },
    { name: 'web_search_exa', arguments: { query: 'example', numResults: 5 } },
    { name: 'tavily_search', arguments: {
      query: 'example', search_depth: 'basic', max_results: 5, include_images: false, include_raw_content: false,
      exclude_domains: ['reddit.com', 'pinterest.com'] } },
    { name: 'firecrawl_search', arguments: {
      query: 'example', limit: 5, excludeDomains: ['reddit.com', 'pinterest.com'] } },
  ]);
  expect(mapCall('tavily', { mode: 'browse', query: 'example' }, 12000, []))
    .not.toHaveProperty('arguments.exclude_domains');
  expect(mapCall('tavily', { mode: 'fetch', url: 'https://example.com/' }, 12000, blocked))
    .not.toHaveProperty('arguments.exclude_domains');
});

it('maps every fetch mode to the exact provider arguments and bounded timeout', () => {
  const url = 'https://example.com/page';
  expect(WEB_SEARCH_PROVIDERS.map(provider =>
    mapCall(provider, { mode: 'fetch', url }, 3000))).toEqual([
    { name: 'fetch_content', arguments: { urls: [url], format: 'markdown', links: false,
      image_links: false, per_url_timeout_ms: 3000 } },
    { name: 'fetch_page_content', arguments: {
      url, live: true, max_chars: 4000, output_format: 'json' } },
    { name: 'web_fetch_exa', arguments: { urls: [url], maxCharacters: 4000 } },
    { name: 'tavily_extract', arguments: { urls: [url], extract_depth: 'basic', format: 'markdown' } },
    { name: 'firecrawl_scrape', arguments: { url, formats: ['markdown'],
      onlyMainContent: true, blockAds: true, storeInCache: false } },
  ]);
  expect((mapCall('tinyfish', { mode: 'fetch', url }, 60_000).arguments as {
    per_url_timeout_ms: number;
  }).per_url_timeout_ms).toBe(10_000);
});

it('uses the exact fixed endpoints with no query configuration', () => {
  expect(WEB_SEARCH_PROVIDERS.map(p => {
    const d = providerDefinition(p);
    return [p, d.apiKeyEndpoint, d.oauthEndpoint, d.apiKeyHeader];
  })).toEqual([
    ['tinyfish', 'https://agent.tinyfish.ai/mcp', 'https://agent.tinyfish.ai/mcp', 'Authorization'],
    ['keenable', 'https://api.keenable.ai/mcp', 'https://api.keenable.ai/mcp-oauth', 'X-API-Key'],
    ['exa', 'https://mcp.exa.ai/mcp', 'https://mcp.exa.ai/mcp/oauth', 'x-api-key'],
    ['tavily', 'https://mcp.tavily.com/mcp/', 'https://mcp.tavily.com/mcp/', 'Authorization'],
    ['firecrawl', 'https://mcp.firecrawl.dev/v2/mcp', 'https://mcp.firecrawl.dev/v2/mcp-oauth', 'Authorization'],
  ]);
});

it('overrides the API-key header with OAuth Bearer credentials', () => {
  const credentials = {
    method: 'oauth' as const, accessToken: 'fixture-token', refreshToken: null,
    expiresAt: '2026-11-14T01:00:00.000Z',
    binding: {
      issuer: 'https://auth.example.com', resource: 'https://mcp.example.com/mcp',
      redirectUri: 'https://aurvin.example.com/api/plugins/web-search/providers/exa/oauth/callback',
      clientId: 'client_1', authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token', registrationEndpoint: null, scope: 'read',
    },
  };
  for (const provider of WEB_SEARCH_PROVIDERS) {
    expect(credentialHeaders(provider, credentials)).toEqual({
      Authorization: 'Bearer fixture-token',
    });
  }
});

it('rejects unknown providers, missing credentials, and control characters', () => {
  expect(() => providerDefinition('unknown' as never)).toThrow('WEB_AUTH_UNSUPPORTED');
  expect(() => credentialHeaders('exa', { method: 'api-key', apiKey: '' }))
    .toThrow('WEB_AUTH_UNSUPPORTED');
  expect(() => credentialHeaders('exa', { method: 'api-key', apiKey: 'key\nvalue' }))
    .toThrow('WEB_AUTH_UNSUPPORTED');
  expect(() => credentialHeaders('exa', { method: 'api-key', apiKey: 'x'.repeat(4097) }))
    .toThrow('WEB_AUTH_UNSUPPORTED');
});

it.each(['', ' key', 'key ', 'key\nvalue', 'x'.repeat(4097)])(
  'rejects malformed TinyFish credentials without header construction: %j', apiKey => {
    expect(() => credentialHeaders('tinyfish', { method: 'api-key', apiKey }))
      .toThrow('WEB_AUTH_UNSUPPORTED');
  },
);

it('admits every production fetch under the client-side guard', () => {
  expect(WEB_SEARCH_PROVIDERS.map(p => providerDefinition(p).fetchSafety))
    .toEqual(['verified', 'verified', 'verified', 'verified', 'verified']);
});

it('pins only the approved TinyFish OAuth origins including Clerk', () => {
  expect(providerDefinition('tinyfish').oauthOrigins).toEqual([
    'https://agent.tinyfish.ai', 'https://accounts.tinyfish.ai', 'https://clerk.tinyfish.ai',
  ]);
});

it('uses exact HTTPS OAuth origins without wildcards or userinfo', () => {
  for (const provider of WEB_SEARCH_PROVIDERS) {
    const definition = providerDefinition(provider);
    expect(definition.oauthOrigins.length).toBeGreaterThan(0);
    for (const origin of definition.oauthOrigins) {
      const parsed = new URL(origin);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.origin).toBe(origin);
      expect(parsed.username).toBe('');
      expect(parsed.password).toBe('');
      expect(parsed.pathname).toBe('/');
      expect(parsed.search).toBe('');
      expect(parsed.hash).toBe('');
    }
  }
});
