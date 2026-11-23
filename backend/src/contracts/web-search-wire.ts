/**
 * ============================================================================
 * FILE: web-search-wire.ts
 * LOCATION: backend/src/contracts/web-search-wire.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define strict secret-free web-search plugin HTTP and provenance contracts.
 *
 * ROLE IN PROJECT:
 *    Freezes public status/mutation routes, bounded source and activity
 *    projections, and closed HTTP failures for provider and UI consumers.
 *
 * KEY COMPONENTS:
 *    - WEB_SEARCH_ROUTES / request schemas: Fixed plugin endpoints and bodies.
 *    - webSearchPublicStatusSchema: Five ordered provider cards without secrets.
 *    - webSourceReferenceSchema / webSearchActivitySchema: Bounded provenance.
 *    - WEB_SEARCH_HTTP_ERRORS: Closed status and retry mapping.
 * ============================================================================
 */

import { z } from 'zod';
import { idSchema } from './identifiers.js';
import {
  isBlockedWebDomain,
  MAX_WEB_SEARCH_BLOCKED_DOMAINS,
  WEB_SEARCH_POLICY as P,
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
} from './web-search-policy.js';

export const WEB_SEARCH_PROTOCOL_VERSION = 1 as const;
export const webSearchProviderSchema = z.enum(WEB_SEARCH_PROVIDERS);
export const webSearchModeSchema = z.enum(['browse', 'fetch']);
export const webSearchLimitsSchema = z.object({
  maxSearchesPerTurn: z.number().finite().int().min(1).max(20),
  maxFetchesPerTurn: z.number().finite().int().min(1).max(20),
}).strict();
export const blockedWebDomainSchema = z.string().refine(
  value => isBlockedWebDomain(value),
  { message: 'invalid blocked domain' },
);
export const webSearchSettingsSchema = webSearchLimitsSchema.extend({
  blockedDomains: z.array(blockedWebDomainSchema).max(MAX_WEB_SEARCH_BLOCKED_DOMAINS)
    .refine(values => new Set(values).size === values.length, { message: 'duplicate blocked domain' }),
}).strict();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const timestamp = z.string().min(1).max(40).refine(v => !Number.isNaN(Date.parse(v)));
export const label = (max: number) => z.string().min(1).max(max)
  .refine(v => v === v.trim() && !/[\u0000-\u001f\u007f]/u.test(v));
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
export const httpUrl = (max: number, httpsOnly = false) => z.string().min(1).max(max).refine(v => {
  try {
    const u = new URL(v);
    return !/[\u0000-\u0020\u007f]/u.test(v) &&
      (httpsOnly ? u.protocol === 'https:' : ['http:', 'https:'].includes(u.protocol)) &&
      u.hostname !== '' && u.username === '' && u.password === '' &&
      ![...u.searchParams.keys()].some(k =>
        ['apikey', 'exaapikey', 'tavilyapikey', 'access_token', 'refresh_token',
          'code_verifier', 'client_secret', 'authorization'].includes(k.toLowerCase())) &&
      (!httpsOnly || u.hash === '');
  } catch { return false; }
});

export const WEB_TOOL_ERROR_CODES = [
  'WEB_SCHEMA_INVALID', 'WEB_SCHEMA_REPAIR_EXHAUSTED',
  'WEB_DISABLED', 'WEB_CONNECTION_REQUIRED', 'WEB_MODEL_UNSUPPORTED', 'WEB_URL_UNSAFE',
  'WEB_SEARCH_LIMIT', 'WEB_FETCH_LIMIT', 'WEB_DEADLINE_EXCEEDED', 'WEB_CONTEXT_LIMIT',
  'WEB_CANCELLED', 'WEB_INTERRUPTED', 'WEB_PROVIDER_AUTH', 'WEB_PROVIDER_CREDITS',
  'WEB_PROVIDER_RATE_LIMITED', 'WEB_PROVIDER_TIMEOUT', 'WEB_PROVIDER_UNAVAILABLE',
  'WEB_UNUSABLE_RESULT', 'WEB_PROVIDERS_EXHAUSTED',
] as const;
export const webToolErrorCodeSchema = z.enum(WEB_TOOL_ERROR_CODES);
export type WebToolErrorCode = z.infer<typeof webToolErrorCodeSchema>;

export const webSourceReferenceSchema = z.object({
  sourceId: idSchema, toolCallId: idSchema,
  provider: webSearchProviderSchema, kind: webSearchModeSchema,
  title: label(P.maxTitleChars), url: httpUrl(P.maxSourceUrlChars),
  retrievedAt: timestamp, publishedAt: timestamp.optional(), siteName: label(80).optional(),
}).strict();
export const webSourcesSchema = z.array(webSourceReferenceSchema).max(P.maxSourcesPerMessage)
  .refine(v => new Set(v.map(s => s.sourceId)).size === v.length)
  .refine(v => bytes(v) <= P.maxSourceProvenanceBytes);
export type WebSourceReference = z.infer<typeof webSourceReferenceSchema>;
export const webSearchActivitySchema = z.object({
  toolCallId: idSchema, mode: webSearchModeSchema,
  phase: z.enum(['searching', 'reading', 'fallback', 'completed', 'failed', 'cancelled']),
  provider: webSearchProviderSchema.nullable(), code: webToolErrorCodeSchema.nullable(),
}).strict().refine(v =>
  (v.phase !== 'searching' || v.mode === 'browse') &&
  (v.phase !== 'reading' || v.mode === 'fetch') &&
  (v.phase !== 'completed' || (v.provider !== null && v.code === null)) &&
  (v.phase !== 'failed' || v.code !== null) &&
  (v.phase !== 'cancelled' || v.code === 'WEB_CANCELLED') &&
  (v.phase !== 'fallback' || (v.provider !== null && v.code !== null &&
    ['WEB_PROVIDER_AUTH', 'WEB_PROVIDER_CREDITS', 'WEB_PROVIDER_RATE_LIMITED',
      'WEB_PROVIDER_TIMEOUT', 'WEB_PROVIDER_UNAVAILABLE', 'WEB_UNUSABLE_RESULT'].includes(v.code))));
export type WebSearchActivity = z.infer<typeof webSearchActivitySchema>;
export const webActivitiesSchema = z.array(webSearchActivitySchema).max(P.maxActivitiesPerMessage)
  .refine(v => new Set(v.map(a => a.toolCallId)).size === v.length)
  .refine(v => bytes(v) <= P.maxActivityProjectionBytes);
export const webActivityEventSchema = z.object({
  type: z.literal('web-activity'), activity: webSearchActivitySchema,
}).strict();
export const webSourcesEventSchema = z.object({
  type: z.literal('web-sources'), sources: webSourcesSchema,
}).strict();
export const webPresentationEventSchema = z.discriminatedUnion('type', [
  webActivityEventSchema, webSourcesEventSchema,
]);
export type WebActivityEvent = z.infer<typeof webActivityEventSchema>;
export type WebSourcesEvent = z.infer<typeof webSourcesEventSchema>;
export type WebPresentationEvent = z.infer<typeof webPresentationEventSchema>;
export function isWebPresentationEvent(v: unknown): v is WebPresentationEvent {
  return webPresentationEventSchema.safeParse(v).success;
}

const base = '/plugins/web-search';
const providerBase = (p: WebSearchProvider) => `${base}/providers/${p}`;
export const WEB_SEARCH_ROUTES = {
  status: `${base}/status`, settings: `${base}/settings`,
  connect: (p: WebSearchProvider) => `${providerBase(p)}/connect`,
  disconnect: (p: WebSearchProvider) => `${providerBase(p)}/disconnect`,
  oauthStart: (p: WebSearchProvider) => `${providerBase(p)}/oauth/start`,
  oauthCallback: (p: WebSearchProvider) => `${providerBase(p)}/oauth/callback`,
  oauthComplete: (p: WebSearchProvider) => `${providerBase(p)}/oauth/complete`,
} as const;
const support = z.enum(['supported', 'unsupported', 'unverified']);
const connectionState = z.enum(['not-connected', 'connecting', 'connected', 'invalid-key',
  'unavailable', 'reconnect-required', 'unsupported']);
export const webSearchPublicProviderSchema = z.object({
  provider: webSearchProviderSchema, state: connectionState,
  authMethod: z.enum(['api-key', 'oauth']).nullable(),
  authSupport: z.object({ apiKey: support, browserAuthorization: support }).strict(),
  capabilities: z.object({ browse: z.boolean(), fetch: z.boolean() }).strict(),
  lastValidatedAt: timestamp.nullable(),
}).strict().refine(v => v.state !== 'connected' ||
  (v.authMethod !== null && v.lastValidatedAt !== null &&
    (v.capabilities.browse || v.capabilities.fetch) &&
    (v.authMethod === 'api-key' ? v.authSupport.apiKey : v.authSupport.browserAuthorization) === 'supported'));
export const webSearchPublicStatusSchema = z.object({
  protocolVersion: z.literal(1), revision, enabled: z.boolean(), effectiveEnabled: z.boolean(),
  providers: z.array(webSearchPublicProviderSchema).length(5),
}).strict().refine(v =>
  v.providers.every((p, i) => p.provider === WEB_SEARCH_PROVIDERS[i]) &&
  v.effectiveEnabled === (v.enabled && v.providers.some(p => p.state === 'connected')));
export type WebSearchAuthSupport = z.infer<typeof support>;
export type WebSearchConnectionState = z.infer<typeof connectionState>;
export type WebSearchPublicProvider = z.infer<typeof webSearchPublicProviderSchema>;
export type WebSearchPublicStatus = z.infer<typeof webSearchPublicStatusSchema>;

const mutation = { protocolVersion: z.literal(1), expectedRevision: revision };
const candidate = z.string().min(1).max(P.maxApiKeyBytes)
  .refine(v => !/[\s\u0000-\u001f\u007f]/u.test(v) &&
    new TextEncoder().encode(v).byteLength <= P.maxApiKeyBytes);
export const webSearchSettingsRequestSchema = z.object({ ...mutation, enabled: z.boolean() }).strict();
export const webSearchConnectRequestSchema = z.object({ ...mutation, candidate }).strict();
export const webSearchDisconnectRequestSchema = z.object({ ...mutation, confirm: z.literal(true) }).strict();
export const webSearchOAuthStartRequestSchema = z.object(mutation).strict();
export const webSearchOAuthStartResponseSchema = z.object({
  protocolVersion: z.literal(1), authorizationUrl: httpUrl(8192, true), expiresAt: timestamp,
}).strict();
export const webSearchOAuthCompleteRequestSchema = z.object({
  protocolVersion: z.literal(1), rawQuery: z.string().max(8192),
}).strict();
export const webSearchOAuthCompleteResponseSchema = z.object({
  protocolVersion: z.literal(1), outcome: z.enum(['connected', 'denied', 'expired', 'failed']),
}).strict();
export type WebSearchSettingsRequest = z.infer<typeof webSearchSettingsRequestSchema>;
export type WebSearchConnectRequest = z.infer<typeof webSearchConnectRequestSchema>;
export type WebSearchDisconnectRequest = z.infer<typeof webSearchDisconnectRequestSchema>;
export type WebSearchOAuthStartRequest = z.infer<typeof webSearchOAuthStartRequestSchema>;
export type WebSearchOAuthStartResponse = z.infer<typeof webSearchOAuthStartResponseSchema>;
export type WebSearchOAuthCompleteRequest = z.infer<typeof webSearchOAuthCompleteRequestSchema>;
export type WebSearchOAuthCompleteResponse = z.infer<typeof webSearchOAuthCompleteResponseSchema>;

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
const httpCode = z.custom<WebSearchHttpErrorCode>(v => typeof v === 'string' &&
  Object.hasOwn(WEB_SEARCH_HTTP_ERRORS, v));
export const webSearchHttpErrorSchema = z.object({
  protocolVersion: z.literal(1),
  error: z.object({ code: httpCode, retryable: z.boolean(), currentRevision: revision.nullable() }).strict(),
}).strict().refine(v => Object.hasOwn(WEB_SEARCH_HTTP_ERRORS, v.error.code) &&
  v.error.retryable === WEB_SEARCH_HTTP_ERRORS[v.error.code].retryable);
export type WebSearchHttpError = z.infer<typeof webSearchHttpErrorSchema>;
