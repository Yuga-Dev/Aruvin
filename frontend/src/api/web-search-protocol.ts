/**
 * ============================================================================
 * FILE: web-search-protocol.ts
 * LOCATION: frontend/src/api/web-search-protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Provide secret-free Web Search wire contracts, provider catalog metadata,
 *    runtime structural guards, and OAuth callback scrubbing for the browser.
 *
 * ROLE IN PROJECT:
 *    Mirrors frozen P1 backend web-search policy and wire shapes using pure
 *    runtime guards without Zod or backend runtime imports.
 *
 * KEY COMPONENTS:
 *    - WEB_SEARCH_PROVIDERS / WEB_SEARCH_PROVIDER_CATALOG: Priority 1..5 providers.
 *    - WEB_SEARCH_ROUTES / WEB_SEARCH_HTTP_ERRORS: REST routes and closed errors.
 *    - isWebSearchPublicStatus / isWebPresentationEvent: Strict boundary guards.
 *    - extractAndScrubWebSearchOAuthCallback: OAuth query capture & history scrub.
 * ============================================================================
 */

import { isSafeHttpsUrl, sanitizeWebSourceUrl } from '../features/chat/markdown/sanitize-url.ts';

export const WEB_SEARCH_PROTOCOL_VERSION = 1 as const;

export const WEB_SEARCH_PROVIDERS = [
  'tinyfish',
  'keenable',
  'exa',
  'tavily',
  'firecrawl',
] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

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
const DOMAIN_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export function isBlockedWebDomain(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > MAX_WEB_SEARCH_BLOCKED_DOMAIN_CHARS
  ) {
    return false;
  }
  if (value !== value.trim() || value !== value.toLowerCase() || DOMAIN_CONTROL_CHARS.test(value)) {
    return false;
  }
  const labels = value.split('.');
  if (labels.length < 2) return false;
  if (!DOMAIN_TLD.test(labels[labels.length - 1])) return false;
  return labels.every((part) => DOMAIN_LABEL.test(part));
}

export function normalizeBlockedWebDomain(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048 || DOMAIN_CONTROL_CHARS.test(trimmed)) {
    return null;
  }
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

export const DEFAULT_WEB_SEARCH_LIMITS: Readonly<WebSearchLimits> = Object.freeze({
  maxSearchesPerTurn: 5,
  maxFetchesPerTurn: 5,
});

export const WEB_SEARCH_POLICY = Object.freeze({
  maxSourcesPerMessage: 15,
  maxSourceProvenanceBytes: 12_000,
  maxActivitiesPerMessage: 40,
  maxActivityProjectionBytes: 12_000,
  maxTitleChars: 160,
  maxSourceUrlChars: 1_024,
  maxHttpBodyBytes: 16_384,
  maxApiKeyBytes: 4_096,
  maxOAuthRawQueryBytes: 4_096,
  oauthStateTtlMs: 600_000,
});

export const WEB_SEARCH_ROUTES = {
  status: '/plugins/web-search/status',
  settings: '/plugins/web-search/settings',
  connect: (provider: WebSearchProvider) => `/plugins/web-search/providers/${provider}/connect`,
  disconnect: (provider: WebSearchProvider) => `/plugins/web-search/providers/${provider}/disconnect`,
  oauthStart: (provider: WebSearchProvider) => `/plugins/web-search/providers/${provider}/oauth/start`,
  oauthCallback: (provider: WebSearchProvider) => `/plugins/web-search/providers/${provider}/oauth/callback`,
  oauthComplete: (provider: WebSearchProvider) => `/plugins/web-search/providers/${provider}/oauth/complete`,
} as const;

export type WebSearchAuthSupport = 'supported' | 'unsupported' | 'unverified';
export type WebSearchAuthMethod = 'api-key' | 'oauth';

export const WEB_SEARCH_CONNECTION_STATES = [
  'not-connected',
  'connecting',
  'connected',
  'invalid-key',
  'unavailable',
  'reconnect-required',
  'unsupported',
] as const;
export type WebSearchConnectionState = (typeof WEB_SEARCH_CONNECTION_STATES)[number];

export const WEB_SEARCH_ACTIVITY_PHASES = [
  'searching',
  'reading',
  'fallback',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WebSearchActivityPhase = (typeof WEB_SEARCH_ACTIVITY_PHASES)[number];

export const WEB_TOOL_ERROR_CODES = [
  'WEB_SCHEMA_INVALID', 'WEB_SCHEMA_REPAIR_EXHAUSTED',
  'WEB_DISABLED', 'WEB_CONNECTION_REQUIRED', 'WEB_MODEL_UNSUPPORTED', 'WEB_URL_UNSAFE',
  'WEB_SEARCH_LIMIT', 'WEB_FETCH_LIMIT', 'WEB_DEADLINE_EXCEEDED', 'WEB_CONTEXT_LIMIT',
  'WEB_CANCELLED', 'WEB_INTERRUPTED', 'WEB_PROVIDER_AUTH', 'WEB_PROVIDER_CREDITS',
  'WEB_PROVIDER_RATE_LIMITED', 'WEB_PROVIDER_TIMEOUT', 'WEB_PROVIDER_UNAVAILABLE',
  'WEB_UNUSABLE_RESULT', 'WEB_PROVIDERS_EXHAUSTED',
] as const;
export type WebToolErrorCode = (typeof WEB_TOOL_ERROR_CODES)[number];

export type WebSearchPublicProvider = {
  provider: WebSearchProvider;
  state: WebSearchConnectionState;
  authMethod: WebSearchAuthMethod | null;
  authSupport: {
    apiKey: WebSearchAuthSupport;
    browserAuthorization: WebSearchAuthSupport;
  };
  capabilities: {
    browse: boolean;
    fetch: boolean;
  };
  lastValidatedAt: string | null;
};

export type WebSearchPublicStatus = {
  protocolVersion: 1;
  revision: number;
  enabled: boolean;
  effectiveEnabled: boolean;
  providers: WebSearchPublicProvider[];
};

export type WebSearchSettingsRequest = {
  protocolVersion: 1;
  expectedRevision: number;
  enabled: boolean;
};

export type WebSearchConnectRequest = {
  protocolVersion: 1;
  expectedRevision: number;
  candidate: string;
};

export type WebSearchDisconnectRequest = {
  protocolVersion: 1;
  expectedRevision: number;
  confirm: true;
};

export type WebSearchOAuthStartRequest = {
  protocolVersion: 1;
  expectedRevision: number;
};

export type WebSearchOAuthStartResponse = {
  protocolVersion: 1;
  authorizationUrl: string;
  expiresAt: string;
};

export type WebSearchOAuthOutcome = 'connected' | 'denied' | 'expired' | 'failed';

export type WebSearchOAuthCompleteRequest = {
  protocolVersion: 1;
  rawQuery: string;
};

export type WebSearchOAuthCompleteResponse = {
  protocolVersion: 1;
  outcome: WebSearchOAuthOutcome;
};

export const WEB_SEARCH_HTTP_ERRORS = {
  WEB_INVALID_REQUEST: { status: 400, retryable: false },
  WEB_INPUT_TOO_LARGE: { status: 413, retryable: false },
  WEB_SETTINGS_CONFLICT: { status: 409, retryable: false },
  WEB_CONNECTION_REQUIRED: { status: 409, retryable: false },
  WEB_INVALID_KEY: { status: 422, retryable: false },
  WEB_AUTH_UNSUPPORTED: { status: 422, retryable: false },
  WEB_CAPABILITY_UNSUPPORTED: { status: 422, retryable: false },
  WEB_OAUTH_BINDING_MISMATCH: { status: 403, retryable: false },
  WEB_OAUTH_STATE_INVALID: { status: 400, retryable: false },
  WEB_OAUTH_EXPIRED: { status: 410, retryable: false },
  WEB_RATE_LIMITED: { status: 429, retryable: true },
  WEB_PROVIDER_UNAVAILABLE: { status: 502, retryable: true },
  WEB_SETUP_TIMEOUT: { status: 504, retryable: true },
  WEB_STORAGE_UNAVAILABLE: { status: 503, retryable: true },
  WEB_WRITE_UNCERTAIN: { status: 503, retryable: false },
  WEB_ENCRYPTION_UNAVAILABLE: { status: 503, retryable: false },
} as const;

export type WebSearchHttpErrorCode = keyof typeof WEB_SEARCH_HTTP_ERRORS;
export const WEB_SEARCH_HTTP_ERROR_CODES = Object.keys(
  WEB_SEARCH_HTTP_ERRORS,
) as WebSearchHttpErrorCode[];

export type WebSearchHttpError = {
  protocolVersion: 1;
  error: {
    code: WebSearchHttpErrorCode;
    retryable: boolean;
    currentRevision: number | null;
  };
};

export type WebSourceReference = {
  sourceId: string;
  toolCallId: string;
  provider: WebSearchProvider;
  kind: WebSearchMode;
  title: string;
  url: string;
  retrievedAt: string;
  publishedAt?: string;
  siteName?: string;
};

export type WebSearchActivity = {
  toolCallId: string;
  mode: WebSearchMode;
  phase: WebSearchActivityPhase;
  provider: WebSearchProvider | null;
  code: WebToolErrorCode | null;
};

export type WebPresentationEvent =
  | { type: 'web-activity'; activity: WebSearchActivity }
  | { type: 'web-sources'; sources: WebSourceReference[] };

export type WebSearchProviderCatalogEntry = {
  provider: WebSearchProvider;
  priority: 1 | 2 | 3 | 4 | 5;
  displayName: string;
  consoleUrl: string;
  consoleLabel: string;
  keyInstructions: string;
  compatibilityNote?: string;
};

export const WEB_SEARCH_PROVIDER_CATALOG: readonly WebSearchProviderCatalogEntry[] = Object.freeze([
  {
    provider: 'tinyfish',
    priority: 1,
    displayName: 'TinyFish',
    consoleUrl: 'https://agent.tinyfish.ai/api-keys',
    consoleLabel: 'Open TinyFish Agent',
    keyInstructions: 'Create or copy a TinyFish API key (sk-tinyfish-...) at agent.tinyfish.ai/api-keys and paste it here. Aurvin sends it to the hosted MCP endpoint as Authorization: Bearer <key>.',
    compatibilityNote: 'Bearer API keys are vendor-documented and validated on connect; authenticated compatibility is not live-verified. Browser authorization remains capability-gated.',
  },
  {
    provider: 'keenable',
    priority: 2,
    displayName: 'Keenable',
    consoleUrl: 'https://app.keenable.ai/',
    consoleLabel: 'Open Keenable',
    keyInstructions: 'Sign in at app.keenable.ai, create an API key in the console, copy it before closing the dialog, and paste it here.',
  },
  {
    provider: 'exa',
    priority: 3,
    displayName: 'Exa',
    consoleUrl: 'https://dashboard.exa.ai/api-keys',
    consoleLabel: 'Open Exa API Keys',
    keyInstructions: 'Sign in to dashboard.exa.ai, open API Keys, create a key, copy it, and paste it here.',
  },
  {
    provider: 'tavily',
    priority: 4,
    displayName: 'Tavily',
    consoleUrl: 'https://app.tavily.com/home',
    consoleLabel: 'Open Tavily Dashboard',
    keyInstructions: 'Sign in to app.tavily.com, copy your API key (for example tvly-...), and paste it here.',
  },
  {
    provider: 'firecrawl',
    priority: 5,
    displayName: 'Firecrawl',
    consoleUrl: 'https://www.firecrawl.dev/app/api-keys',
    consoleLabel: 'Open Firecrawl API Keys',
    keyInstructions: 'Sign in to firecrawl.dev/app/api-keys, create or copy your API key (for example fc-...), and paste it here.',
  },
]);

export type WebSearchOAuthCallbackResult =
  | {
      kind: 'complete-query';
      provider: WebSearchProvider;
      rawQuery: string;
      scrubbedPathAndSearch: string;
    }
  | {
      kind: 'resolved';
      provider: WebSearchProvider;
      outcome: WebSearchOAuthOutcome;
      scrubbedPathAndSearch: string;
    };

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'apikey',
  'api_key',
  'authorization',
  'code',
  'code_verifier',
  'refresh_token',
  'secret',
  'token',
]);

const CALLBACK_SCRUB_PARAMS = [
  'plugin',
  'section',
  'provider',
  'oauth',
  'code',
  'state',
  'scope',
  'error',
  'error_description',
] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const PROVIDER_SET = new Set<string>(WEB_SEARCH_PROVIDERS);
const STATE_SET = new Set<string>(WEB_SEARCH_CONNECTION_STATES);
const PHASE_SET = new Set<string>(WEB_SEARCH_ACTIVITY_PHASES);
const AUTH_SUPPORT_SET = new Set<string>(['supported', 'unsupported', 'unverified']);
const OAUTH_OUTCOME_SET = new Set<string>(['connected', 'denied', 'expired', 'failed']);
const HTTP_ERROR_SET = new Set<string>(WEB_SEARCH_HTTP_ERROR_CODES);
const TOOL_ERROR_SET = new Set<string>(WEB_TOOL_ERROR_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isNonEmptyString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxChars &&
    value.trim().length > 0
  );
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_RE.test(value) && Number.isFinite(Date.parse(value));
}

function hasSensitiveQueryParam(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return typeof value === 'string' && PROVIDER_SET.has(value);
}

export function isWebSearchLimits(value: unknown): value is WebSearchLimits {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['maxSearchesPerTurn', 'maxFetchesPerTurn']) &&
    typeof value.maxSearchesPerTurn === 'number' &&
    Number.isSafeInteger(value.maxSearchesPerTurn) &&
    value.maxSearchesPerTurn >= 1 &&
    value.maxSearchesPerTurn <= 20 &&
    typeof value.maxFetchesPerTurn === 'number' &&
    Number.isSafeInteger(value.maxFetchesPerTurn) &&
    value.maxFetchesPerTurn >= 1 &&
    value.maxFetchesPerTurn <= 20
  );
}

export function isWebSearchPublicProvider(value: unknown): value is WebSearchPublicProvider {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'provider',
      'state',
      'authMethod',
      'authSupport',
      'capabilities',
      'lastValidatedAt',
    ])
  ) {
    return false;
  }
  if (!isWebSearchProvider(value.provider)) return false;
  if (typeof value.state !== 'string' || !STATE_SET.has(value.state)) return false;
  if (value.authMethod !== null && value.authMethod !== 'api-key' && value.authMethod !== 'oauth') {
    return false;
  }
  if (!isRecord(value.authSupport) || !hasExactKeys(value.authSupport, ['apiKey', 'browserAuthorization'])) {
    return false;
  }
  if (
    typeof value.authSupport.apiKey !== 'string' ||
    !AUTH_SUPPORT_SET.has(value.authSupport.apiKey) ||
    typeof value.authSupport.browserAuthorization !== 'string' ||
    !AUTH_SUPPORT_SET.has(value.authSupport.browserAuthorization)
  ) {
    return false;
  }
  if (!isRecord(value.capabilities) || !hasExactKeys(value.capabilities, ['browse', 'fetch'])) {
    return false;
  }
  if (typeof value.capabilities.browse !== 'boolean' || typeof value.capabilities.fetch !== 'boolean') {
    return false;
  }
  if (value.state === 'connected' && !value.capabilities.browse && !value.capabilities.fetch) {
    return false;
  }
  if (value.lastValidatedAt !== null && !isIsoDateString(value.lastValidatedAt)) {
    return false;
  }
  return true;
}

export function isWebSearchPublicStatus(value: unknown): value is WebSearchPublicStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['protocolVersion', 'revision', 'enabled', 'effectiveEnabled', 'providers'])
  ) {
    return false;
  }
  if (value.protocolVersion !== WEB_SEARCH_PROTOCOL_VERSION) return false;
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    return false;
  }
  if (typeof value.enabled !== 'boolean' || typeof value.effectiveEnabled !== 'boolean') {
    return false;
  }
  if (!Array.isArray(value.providers) || value.providers.length !== WEB_SEARCH_PROVIDERS.length) {
    return false;
  }
  for (let i = 0; i < WEB_SEARCH_PROVIDERS.length; i++) {
    const provider = value.providers[i];
    if (!isWebSearchPublicProvider(provider) || provider.provider !== WEB_SEARCH_PROVIDERS[i]) {
      return false;
    }
  }
  const hasConnected = value.providers.some((item) => item.state === 'connected');
  if (value.effectiveEnabled !== (value.enabled && hasConnected)) return false;
  return true;
}

export function isWebSearchSettingsRequest(value: unknown): value is WebSearchSettingsRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'expectedRevision', 'enabled']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.expectedRevision === 'number' &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    typeof value.enabled === 'boolean'
  );
}

export function isWebSearchCandidateString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    utf8Bytes(value) <= WEB_SEARCH_POLICY.maxApiKeyBytes
  );
}

export function isWebSearchConnectRequest(value: unknown): value is WebSearchConnectRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'expectedRevision', 'candidate']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.expectedRevision === 'number' &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    isWebSearchCandidateString(value.candidate)
  );
}

export function isWebSearchDisconnectRequest(value: unknown): value is WebSearchDisconnectRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'expectedRevision', 'confirm']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.expectedRevision === 'number' &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    value.confirm === true
  );
}

export function isWebSearchOAuthStartRequest(value: unknown): value is WebSearchOAuthStartRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'expectedRevision']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.expectedRevision === 'number' &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0
  );
}

export function isWebSearchOAuthStartResponse(value: unknown): value is WebSearchOAuthStartResponse {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'authorizationUrl', 'expiresAt']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.authorizationUrl === 'string' &&
    isSafeHttpsUrl(value.authorizationUrl, 8_192) &&
    !hasSensitiveQueryParam(value.authorizationUrl) &&
    isIsoDateString(value.expiresAt)
  );
}

export function isWebSearchOAuthCompleteRequest(value: unknown): value is WebSearchOAuthCompleteRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'rawQuery']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.rawQuery === 'string' &&
    value.rawQuery.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value.rawQuery) &&
    utf8Bytes(value.rawQuery) <= WEB_SEARCH_POLICY.maxOAuthRawQueryBytes
  );
}

export function isWebSearchOAuthCompleteResponse(value: unknown): value is WebSearchOAuthCompleteResponse {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'outcome']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.outcome === 'string' &&
    OAUTH_OUTCOME_SET.has(value.outcome)
  );
}

export function isWebSearchHttpError(value: unknown): value is WebSearchHttpError {
  if (!isRecord(value) || !hasExactKeys(value, ['protocolVersion', 'error'])) return false;
  if (value.protocolVersion !== WEB_SEARCH_PROTOCOL_VERSION) return false;
  const err = value.error;
  if (!isRecord(err) || !hasExactKeys(err, ['code', 'retryable', 'currentRevision'])) return false;
  if (typeof err.code !== 'string' || !HTTP_ERROR_SET.has(err.code)) return false;
  if (typeof err.retryable !== 'boolean') return false;
  if (
    err.currentRevision !== null &&
    (typeof err.currentRevision !== 'number' ||
      !Number.isSafeInteger(err.currentRevision) ||
      err.currentRevision < 0)
  ) {
    return false;
  }
  return true;
}

export function isWebSourceReference(value: unknown): value is WebSourceReference {
  if (!isRecord(value)) return false;
  const requiredKeys = ['sourceId', 'toolCallId', 'provider', 'kind', 'title', 'url', 'retrievedAt'];
  const allowedOptionalKeys = ['publishedAt', 'siteName'];
  const actualKeys = Object.keys(value);
  if (!requiredKeys.every((k) => actualKeys.includes(k))) return false;
  if (actualKeys.some((k) => !requiredKeys.includes(k) && !allowedOptionalKeys.includes(k))) {
    return false;
  }
  if (!isNonEmptyString(value.sourceId, 128) || !isNonEmptyString(value.toolCallId, 128)) {
    return false;
  }
  if (!isWebSearchProvider(value.provider)) return false;
  if (value.kind !== 'browse' && value.kind !== 'fetch') return false;
  if (!isNonEmptyString(value.title, WEB_SEARCH_POLICY.maxTitleChars)) return false;
  if (typeof value.url !== 'string' || sanitizeWebSourceUrl(value.url) === '') return false;
  if (hasSensitiveQueryParam(value.url)) return false;
  if (!isIsoDateString(value.retrievedAt)) return false;
  if (value.publishedAt !== undefined && !isNonEmptyString(value.publishedAt, 64)) return false;
  if (value.siteName !== undefined && !isNonEmptyString(value.siteName, 128)) return false;
  return true;
}

export function isWebSourceReferenceList(value: unknown): value is WebSourceReference[] {
  if (!Array.isArray(value) || value.length > WEB_SEARCH_POLICY.maxSourcesPerMessage) {
    return false;
  }
  const seenIds = new Set<string>();
  for (const item of value) {
    if (!isWebSourceReference(item) || seenIds.has(item.sourceId)) return false;
    seenIds.add(item.sourceId);
  }
  return utf8Bytes(JSON.stringify(value)) <= WEB_SEARCH_POLICY.maxSourceProvenanceBytes;
}

export function isWebSearchActivity(value: unknown): value is WebSearchActivity {
  if (!isRecord(value) || !hasExactKeys(value, ['toolCallId', 'mode', 'phase', 'provider', 'code'])) {
    return false;
  }
  if (!isNonEmptyString(value.toolCallId, 128)) return false;
  if (value.mode !== 'browse' && value.mode !== 'fetch') return false;
  if (typeof value.phase !== 'string' || !PHASE_SET.has(value.phase)) return false;
  if (value.provider !== null && !isWebSearchProvider(value.provider)) return false;
  if (value.phase === 'searching' && value.mode !== 'browse') return false;
  if (value.phase === 'reading' && value.mode !== 'fetch') return false;
  if (value.phase === 'failed') {
    if (
      typeof value.code !== 'string' ||
      !TOOL_ERROR_SET.has(value.code) ||
      !/^WEB_[A-Z0-9_]{1,60}$/.test(value.code)
    ) {
      return false;
    }
  } else if (value.code !== null) {
    return false;
  }
  return true;
}

export function isWebSearchActivityList(value: unknown): value is WebSearchActivity[] {
  if (!Array.isArray(value) || value.length > WEB_SEARCH_POLICY.maxActivitiesPerMessage) {
    return false;
  }
  if (!value.every(isWebSearchActivity)) return false;
  return utf8Bytes(JSON.stringify(value)) <= WEB_SEARCH_POLICY.maxActivityProjectionBytes;
}

export function isWebPresentationEvent(value: unknown): value is WebPresentationEvent {
  if (!isRecord(value)) return false;
  if (value.type === 'web-activity') {
    return hasExactKeys(value, ['type', 'activity']) && isWebSearchActivity(value.activity);
  }
  if (value.type === 'web-sources') {
    return hasExactKeys(value, ['type', 'sources']) && isWebSourceReferenceList(value.sources);
  }
  return false;
}

export function extractAndScrubWebSearchOAuthCallback(urlStr: string): WebSearchOAuthCallbackResult | null {
  let url: URL;
  try {
    url = new URL(urlStr, 'http://127.0.0.1');
  } catch {
    return null;
  }

  const target = url.searchParams.get('plugin') ?? url.searchParams.get('section');
  const providerParam = url.searchParams.get('provider');
  if (target !== 'web-search' || !isWebSearchProvider(providerParam)) {
    return null;
  }

  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const oauthOutcome = url.searchParams.get('oauth');
  const hasCallbackParams =
    url.searchParams.has('code') || url.searchParams.has('state') || url.searchParams.has('error');

  for (const param of CALLBACK_SCRUB_PARAMS) {
    url.searchParams.delete(param);
  }
  const cleanSearch = url.searchParams.toString();
  const scrubbedPathAndSearch = cleanSearch ? `${url.pathname}?${cleanSearch}` : url.pathname;

  if (!hasCallbackParams && oauthOutcome && OAUTH_OUTCOME_SET.has(oauthOutcome)) {
    return {
      kind: 'resolved',
      provider: providerParam,
      outcome: oauthOutcome as WebSearchOAuthOutcome,
      scrubbedPathAndSearch,
    };
  }

  if (hasCallbackParams && utf8Bytes(rawQuery) <= WEB_SEARCH_POLICY.maxOAuthRawQueryBytes && !/[\u0000-\u001f\u007f]/u.test(rawQuery)) {
    return {
      kind: 'complete-query',
      provider: providerParam,
      rawQuery,
      scrubbedPathAndSearch,
    };
  }

  return {
    kind: 'resolved',
    provider: providerParam,
    outcome: 'failed',
    scrubbedPathAndSearch,
  };
}
