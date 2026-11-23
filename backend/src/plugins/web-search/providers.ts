/**
 * ============================================================================
 * FILE: providers.ts
 * LOCATION: backend/src/plugins/web-search/providers.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Freeze the five fixed MCP endpoints, tool names, argument mapping,
 *    header-only credential construction, and client-guarded fetch admission.
 *
 * ROLE IN PROJECT:
 *    Gives the MCP client, connection setup, and runtime one static allowlist
 *    with no discovered-name selection, REST fallback, or query credentials.
 *
 * KEY COMPONENTS:
 *    - providerDefinition: Exact endpoint/header/tool/origin/fetch-policy table.
 *    - mapCall: Pure browse/fetch argument mapping for each provider.
 *    - credentialHeaders: API-key or OAuth Bearer headers; credentials remain header-only.
 * ============================================================================
 */

import type { WebSearchProvider } from '../../contracts/web-search-policy.js';
import type { WebToolArguments } from '../../contracts/web-search-tools.js';
import { WebSearchFault } from './errors.js';
import type { CredentialBundle } from './types.js';

export type ProviderDefinition = Readonly<{
  provider: WebSearchProvider; apiKeyEndpoint: string; oauthEndpoint: string;
  apiKeyHeader: 'X-API-Key' | 'x-api-key' | 'Authorization' | null;
  browseTool: string; fetchTool: string;
  oauthOrigins: readonly string[]; fetchSafety: 'unverified' | 'verified';
}>;
export type MappedCall = { name: string; arguments: Record<string, unknown> };

/**
 * Fetch admission policy (revised 2026-11-15):
 * - 'verified' means Aurvin's client-side URL guard, public-DNS checks,
 *   provider-returned URL validation, and the untrusted-evidence prompt
 *   guardrail are in place. It does NOT assert provider-side redirect,
 *   DNS-rebinding, or private-network enforcement: the provider fetches from
 *   its own network, so intermediate hops remain outside Aurvin's observation.
 * - 'unverified' keeps fetch disabled.
 */
const DEFINITIONS: Record<WebSearchProvider, ProviderDefinition> = {
  tinyfish: {
    provider: 'tinyfish',
    apiKeyEndpoint: 'https://agent.tinyfish.ai/mcp',
    oauthEndpoint: 'https://agent.tinyfish.ai/mcp',
    apiKeyHeader: 'Authorization',
    browseTool: 'search', fetchTool: 'fetch_content',
    oauthOrigins: ['https://agent.tinyfish.ai', 'https://accounts.tinyfish.ai', 'https://clerk.tinyfish.ai'],
    fetchSafety: 'verified',
  },
  keenable: {
    provider: 'keenable',
    apiKeyEndpoint: 'https://api.keenable.ai/mcp',
    oauthEndpoint: 'https://api.keenable.ai/mcp-oauth',
    apiKeyHeader: 'X-API-Key',
    browseTool: 'search_web_pages', fetchTool: 'fetch_page_content',
    oauthOrigins: ['https://api.keenable.ai', 'https://app.keenable.ai'],
    fetchSafety: 'verified',
  },
  exa: {
    provider: 'exa',
    apiKeyEndpoint: 'https://mcp.exa.ai/mcp',
    oauthEndpoint: 'https://mcp.exa.ai/mcp/oauth',
    apiKeyHeader: 'x-api-key',
    browseTool: 'web_search_exa', fetchTool: 'web_fetch_exa',
    oauthOrigins: ['https://mcp.exa.ai', 'https://auth.exa.ai'],
    fetchSafety: 'verified',
  },
  tavily: {
    provider: 'tavily',
    apiKeyEndpoint: 'https://mcp.tavily.com/mcp/',
    oauthEndpoint: 'https://mcp.tavily.com/mcp/',
    apiKeyHeader: 'Authorization',
    browseTool: 'tavily_search', fetchTool: 'tavily_extract',
    oauthOrigins: ['https://mcp.tavily.com', 'https://app.tavily.com'],
    fetchSafety: 'verified',
  },
  firecrawl: {
    provider: 'firecrawl',
    apiKeyEndpoint: 'https://mcp.firecrawl.dev/v2/mcp',
    oauthEndpoint: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
    apiKeyHeader: 'Authorization',
    browseTool: 'firecrawl_search', fetchTool: 'firecrawl_scrape',
    oauthOrigins: ['https://mcp.firecrawl.dev', 'https://www.firecrawl.dev'],
    fetchSafety: 'verified',
  },
};

export function providerDefinition(provider: WebSearchProvider): ProviderDefinition {
  if (!Object.hasOwn(DEFINITIONS, provider)) {
    throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
  }
  return DEFINITIONS[provider];
}

export function mapCall(
  provider: WebSearchProvider,
  args: WebToolArguments,
  remainingMs: number,
  excludedDomains?: readonly string[],
): MappedCall {
  if (args.mode === 'browse') {
    const excluded = excludedDomains && excludedDomains.length > 0 ? excludedDomains : null;
    switch (provider) {
      case 'tinyfish': return { name: 'search', arguments: {
        query: args.query, ...(excluded ? { exclude_domains: excluded.join(',') } : {}) } };
      case 'keenable': return { name: 'search_web_pages', arguments: {
        query: args.query, max_results: 5, snippet_max_length: 320, output_format: 'json', disable_cards: true,
        ...(excluded ? { exclude_domains: [...excluded] } : {}) } };
      // Exa's default web_search_exa MCP tool does not expose excludeDomains;
      // web_search_advanced_exa requires ?tools=..., which alters the fixed OAuth resource URL.
      case 'exa': return { name: 'web_search_exa', arguments: { query: args.query, numResults: 5 } };
      case 'tavily': return { name: 'tavily_search', arguments: {
        query: args.query, search_depth: 'basic', max_results: 5, include_images: false, include_raw_content: false,
        ...(excluded ? { exclude_domains: [...excluded] } : {}) } };
      case 'firecrawl': return { name: 'firecrawl_search', arguments: {
        query: args.query, limit: 5, ...(excluded ? { excludeDomains: [...excluded] } : {}) } };
    }
  }
  switch (provider) {
    case 'tinyfish': return { name: 'fetch_content', arguments: { urls: [args.url], format: 'markdown',
      links: false, image_links: false, per_url_timeout_ms: Math.min(10000, Math.floor(remainingMs)) } };
    case 'keenable': return { name: 'fetch_page_content', arguments: {
      url: args.url, live: true, max_chars: 4000, output_format: 'json' } };
    case 'exa': return { name: 'web_fetch_exa', arguments: { urls: [args.url], maxCharacters: 4000 } };
    case 'tavily': return { name: 'tavily_extract', arguments: {
      urls: [args.url], extract_depth: 'basic', format: 'markdown' } };
    case 'firecrawl': return { name: 'firecrawl_scrape', arguments: { url: args.url, formats: ['markdown'],
      onlyMainContent: true, blockAds: true, storeInCache: false } };
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const invalidCredential = (): never => {
  throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
};

export function credentialHeaders(
  provider: WebSearchProvider,
  credentials: CredentialBundle,
): Record<string, string> {
  const definition = providerDefinition(provider);
  if (credentials.method === 'oauth') {
    if (credentials.accessToken.length < 1 || credentials.accessToken.length > 8_192
      || credentials.accessToken.trim() !== credentials.accessToken
      || CONTROL.test(credentials.accessToken)) invalidCredential();
    return { Authorization: `Bearer ${credentials.accessToken}` };
  }
  if (definition.apiKeyHeader === null) invalidCredential();
  const header = definition.apiKeyHeader;
  if (credentials.apiKey.length < 1
    || Buffer.byteLength(credentials.apiKey, 'utf8') > 4_096
    || credentials.apiKey.trim() !== credentials.apiKey
    || CONTROL.test(credentials.apiKey)) invalidCredential();
  switch (header) {
    case 'X-API-Key': return { 'X-API-Key': credentials.apiKey };
    case 'x-api-key': return { 'x-api-key': credentials.apiKey };
    case 'Authorization': return { Authorization: `Bearer ${credentials.apiKey}` };
    default: return invalidCredential();
  }
}
