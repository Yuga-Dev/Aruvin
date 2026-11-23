/**
 * ============================================================================
 * FILE: web-search-policy.ts
 * LOCATION: backend/src/contracts/web-search-policy.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Freeze fixed web-search providers, limits, and pure execution decisions.
 *
 * ROLE IN PROJECT:
 *    Gives the provider, shared text/voice runtime, and frontend workers one
 *    bounded policy source without storage, network, or model ownership.
 *
 * KEY COMPONENTS:
 *    - WEB_SEARCH_PROVIDERS / types: Fixed priority order and mode vocabulary.
 *    - DEFAULT_WEB_SEARCH_LIMITS / WEB_SEARCH_POLICY: Administrator limits and fixed bounds.
 *    - shouldAdvertiseWebTool / webModelAttemptLimit / canRepairWebSchema: Pure decisions.
 * ============================================================================
 */

export const WEB_SEARCH_PROVIDERS = [
  'tinyfish', 'keenable', 'exa', 'tavily', 'firecrawl',
] as const;
export type WebSearchProvider = typeof WEB_SEARCH_PROVIDERS[number];
export type WebSearchMode = 'browse' | 'fetch';
export type WebSearchLimits = {
  maxSearchesPerTurn: number;
  maxFetchesPerTurn: number;
};
export type WebSearchSettings = WebSearchLimits & {
  blockedDomains: string[];
};
export const MAX_WEB_SEARCH_BLOCKED_DOMAINS = 100 as const;
export const MAX_WEB_SEARCH_BLOCKED_DOMAIN_CHARS = 253 as const;

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_TLD = /[a-z]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export function isBlockedWebDomain(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > MAX_WEB_SEARCH_BLOCKED_DOMAIN_CHARS) {
    return false;
  }
  if (value !== value.trim() || value !== value.toLowerCase() || CONTROL_CHARS.test(value)) {
    return false;
  }
  const labels = value.split('.');
  if (labels.length < 2) return false;
  if (!DOMAIN_TLD.test(labels[labels.length - 1]!)) return false;
  return labels.every(part => DOMAIN_LABEL.test(part));
}

export function normalizeBlockedWebDomain(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048 || CONTROL_CHARS.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  let host = parsed.hostname.replace(/\.+$/, '').toLowerCase();
  if (host.startsWith('www.') && host.slice(4).includes('.')) host = host.slice(4);
  return isBlockedWebDomain(host) ? host : null;
}

export const DEFAULT_WEB_SEARCH_ENABLED = false as const;
export const DEFAULT_WEB_SEARCH_LIMITS: Readonly<WebSearchLimits> =
  Object.freeze({ maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 });
export const WEB_SEARCH_POLICY = Object.freeze({
  maxSchemaRepairAttemptsPerTurn: 3,
  maxProviderFallbackAttemptsPerCall: 5,
  maxAttemptsPerProviderPerCall: 1,
  mcpConnectTimeoutMs: 4_000,
  providerCallTimeoutMs: 12_000,
  oauthRefreshTimeoutMs: 4_000,
  maxOAuthRefreshAttemptsPerProviderCall: 1,
  logicalCallTimeoutMs: 25_000,
  turnDeadlineMs: 45_000,
  maxMcpWireResponseBytes: 524_288,
  argumentBytes: 4_096,
  jsonDepth: 4,
  maxQueryChars: 400,
  maxFetchUrlChars: 2_048,
  maxBrowseResults: 5,
  maxTitleChars: 160,
  maxSourceUrlChars: 1_024,
  maxSnippetChars: 320,
  maxFetchContentChars: 4_000,
  maxBrowseResultBytes: 2_400,
  maxFetchResultBytes: 4_600,
  maxTurnWebEvidenceBytes: 24_000,
  synthesisReserveTokens: 1_024,
  maxSourcesPerMessage: 15,
  maxSourceProvenanceBytes: 12_000,
  maxActivitiesPerMessage: 40,
  maxActivityProjectionBytes: 12_000,
  maxRepairFeedbackChars: 1_500,
  oauthStateTtlMs: 600_000,
  maxHttpBodyBytes: 16_384,
  maxApiKeyBytes: 4_096,
} as const);

export function shouldAdvertiseWebTool(state: {
  enabled: boolean; hasEligibleProvider: boolean; credentialsRejected?: boolean;
  modelSupportsTools: boolean | undefined;
}): boolean {
  return state.enabled && (state.hasEligibleProvider || state.credentialsRejected === true)
    && state.modelSupportsTools === true;
}
export function webModelAttemptLimit(limits: WebSearchLimits): number {
  return Math.min(45, 1 + limits.maxSearchesPerTurn + limits.maxFetchesPerTurn + 3 + 1);
}
export function canRepairWebSchema(state: {
  schemaRepairsUsed: number; modelAttemptsRemaining: number;
  hasContextHeadroom: boolean; deadlineRemainingMs: number;
}): boolean {
  return Number.isSafeInteger(state.schemaRepairsUsed) && state.schemaRepairsUsed >= 0 &&
    state.schemaRepairsUsed < WEB_SEARCH_POLICY.maxSchemaRepairAttemptsPerTurn &&
    Number.isSafeInteger(state.modelAttemptsRemaining) && state.modelAttemptsRemaining > 0 &&
    state.hasContextHeadroom && Number.isFinite(state.deadlineRemainingMs) &&
    state.deadlineRemainingMs > 0;
}
