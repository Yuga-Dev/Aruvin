/**
 * ============================================================================
 * FILE: types.ts
 * LOCATION: backend/src/plugins/web-search/types.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define plugin-private durable records, ports, and prepared authority types.
 *
 * ROLE IN PROJECT:
 *    Keeps secret-bearing prepared state and strict storage schemas inside the
 *    web-search plugin while importing the frozen P1 public contracts.
 *
 * KEY COMPONENTS:
 *    - SecretEnvelope / SecretBinding / CredentialBundle: Encrypted secret domain.
 *    - StoredWebAccount / StoredWebOAuthState: Strict bounded durable records.
 *    - WebSearchStore / PreparedWebAccount / WebSearchPort: Storage and runtime ports.
 *    - WebSearchModuleOptions / WebSearchConnectionsApi / WebSearchOAuthApi: Wiring.
 * ============================================================================
 */

import { z } from 'zod';
import type { AuthPrincipal } from '../../contracts/auth.js';
import { idSchema, isoDateSchema } from '../../contracts/identifiers.js';
import {
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
} from '../../contracts/web-search-policy.js';
import type { WebToolArguments, WebToolResult } from '../../contracts/web-search-tools.js';
import type {
  WebSearchActivity, WebSearchHttpErrorCode, WebSearchPublicStatus,
} from '../../contracts/web-search-wire.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const base64 = z.string().min(1).max(32_768).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const url = (max: number) => z.string().min(1).max(max).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
});
const boundedText = (max: number) => z.string().min(1).max(max)
  .refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));

export type SecretEnvelope = {
  version: 1; iv: string; tag: string; ciphertext: string;
};
export type SecretBinding = {
  userId: string; provider: WebSearchProvider; connectionId: string;
  credentialVersion: number; tokenKind: 'credential-bundle' | 'pkce';
};
export type OAuthBinding = {
  issuer: string; resource: string; redirectUri: string; clientId: string;
  authorizationEndpoint: string; tokenEndpoint: string;
  registrationEndpoint: string | null; scope: string;
};
export type CredentialBundle =
  | { method: 'api-key'; apiKey: string }
  | { method: 'oauth'; accessToken: string; refreshToken: string | null;
      expiresAt: string; binding: OAuthBinding };
export type ModeCapabilities = Readonly<{ browse: boolean; fetch: boolean }>;
export type StoredWebConnection = {
  connectionId: string; credentialVersion: number;
  authMethod: 'api-key' | 'oauth'; secret: SecretEnvelope;
  capabilities: ModeCapabilities; schemaDigest: string;
  lastValidatedAt: string; capabilitiesExpireAt: string;
  state: 'connected' | 'reconnect-required';
  oauthRefresh: 'idle' | 'dispatching' | 'reconnect-required';
};
export type StoredWebAccount = {
  kind: 'account'; schemaVersion: 1; userId: string; revision: number;
  enabled: boolean; updatedAt: string;
  connections: Partial<Record<WebSearchProvider, StoredWebConnection>>;
};
export type StoredWebOAuthState = {
  kind: 'oauth-state'; schemaVersion: 1; userId: string;
  provider: WebSearchProvider; expectedRevision: number;
  connectionId: string; credentialVersion: number;
  stateHash: string; browserHash: string; sessionHash: string;
  encryptedVerifier: SecretEnvelope; binding: OAuthBinding;
  createdAt: string; expiresAt: Date; consumedAt: string | null;
};
export type WebAccountCas =
  | { outcome: 'confirmed'; record: StoredWebAccount }
  | { outcome: 'conflict'; currentRevision: number }
  | { outcome: 'uncertain' };
export interface WebSearchStore {
  readAccount(userId: string): Promise<StoredWebAccount | null>;
  saveAccount(expectedRevision: number, next: StoredWebAccount): Promise<WebAccountCas>;
  putOAuthState(record: StoredWebOAuthState): Promise<'confirmed' | 'uncertain'>;
  readOAuthState(userId: string, provider: WebSearchProvider,
    stateHash: string): Promise<StoredWebOAuthState | null>;
  consumeOAuthState(input: {
    userId: string; provider: WebSearchProvider; stateHash: string;
    browserHash: string; sessionHash: string; now: string;
  }): Promise<'consumed' | 'not-found' | 'uncertain'>;
}
export type PreparedProvider = Readonly<{
  provider: WebSearchProvider; connectionId: string; credentialVersion: number;
  generation: number; capabilities: ModeCapabilities; credentials: CredentialBundle;
  capabilitiesExpireAt: number; lastValidatedAt: string;
}>;
export type PreparedWebAccount = Readonly<{
  userId: string; revision: number; generation: number; enabled: boolean;
  prepared: boolean;
  providers: readonly Readonly<{ provider: WebSearchProvider; capabilities: ModeCapabilities }>[];
  /** Every saved provider for this account is confirmed rejected. */
  credentialsRejected?: boolean;
}>;
export type WebCallContext = Readonly<{
  userId: string; turnId: string; toolCallId: string;
  /** min(existing run deadline, accepted-turn monotonic start + 45_000). */
  webDeadlineAt: number; signal: AbortSignal;
  activity?: (activity: WebSearchActivity) => void;
}>;
export type ValidatedWebInput = Readonly<{
  args: WebToolArguments; userId: string; turnId: string; toolCallId: string;
}>;
export interface WebSearchPort {
  snapshot(userId: string): PreparedWebAccount;
  validateInput(args: WebToolArguments, context: WebCallContext):
    Promise<ValidatedWebInput | Extract<WebToolResult, { ok: false }>>;
  execute(input: ValidatedWebInput, context: WebCallContext): Promise<WebToolResult>;
}
export type WebSearchModuleOptions = {
  connections: () => WebSearchConnectionsApi;
  oauth: () => WebSearchOAuthApi;
  principal: () => AuthPrincipal;
  assertNoClientOverrides: (body: unknown) => void;
  frontendOrigin: string; secureCookie: boolean;
};
export interface WebSearchConnectionsApi {
  status(userId: string): WebSearchPublicStatus;
  warmOwner(userId: string): Promise<void>;
  prepareApiKeySessions(userId: string, signal: AbortSignal): Promise<void>;
  isPrepared(userId: string): boolean;
  settings(userId: string, body: unknown, signal: AbortSignal): Promise<WebSearchPublicStatus>;
  connect(userId: string, provider: WebSearchProvider, body: unknown,
    signal: AbortSignal): Promise<WebSearchPublicStatus>;
  disconnect(userId: string, provider: WebSearchProvider, body: unknown,
    signal: AbortSignal): Promise<WebSearchPublicStatus>;
  evict(userId: string): void;
  close(): Promise<void>;
}
export interface WebSearchOAuthApi {
  start(principal: AuthPrincipal, provider: WebSearchProvider, body: unknown,
    signal: AbortSignal): Promise<{ authorizationUrl: string; expiresAt: string; browserCookie: string }>;
  complete(principal: AuthPrincipal, provider: WebSearchProvider,
    input: { rawQuery: string; cookieHeader: string | undefined },
    signal: AbortSignal): Promise<'connected' | 'denied' | 'expired' | 'failed'>;
  maintainOwner(userId: string, signal: AbortSignal): Promise<void>;
  invalidate(userId: string, provider?: WebSearchProvider): void;
  close(): Promise<void>;
}
export type WebSearchFaultData = {
  code: WebSearchHttpErrorCode; currentRevision: number | null;
};

export const secretEnvelopeSchema = z.object({
  version: z.literal(1), iv: base64, tag: base64, ciphertext: base64,
}).strict();
export const secretBindingSchema = z.object({
  userId: idSchema, provider: z.enum(WEB_SEARCH_PROVIDERS), connectionId: idSchema,
  credentialVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tokenKind: z.enum(['credential-bundle', 'pkce']),
}).strict();
export const oauthBindingSchema = z.object({
  issuer: url(2_048), resource: url(2_048), redirectUri: url(2_048),
  clientId: boundedText(512), authorizationEndpoint: url(2_048),
  tokenEndpoint: url(2_048), registrationEndpoint: url(2_048).nullable(),
  scope: z.string().max(1_024).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
}).strict();
const token = (max: number) => z.string().min(1).max(max)
  .refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
export const credentialBundleSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('api-key'), apiKey: token(4_096) }).strict(),
  z.object({
    method: z.literal('oauth'), accessToken: token(8_192),
    refreshToken: token(8_192).nullable(), expiresAt: isoDateSchema,
    binding: oauthBindingSchema,
  }).strict(),
]);
export const modeCapabilitiesSchema = z.object({
  browse: z.boolean(), fetch: z.boolean(),
}).strict();
export const storedWebConnectionSchema = z.object({
  connectionId: idSchema,
  credentialVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  authMethod: z.enum(['api-key', 'oauth']), secret: secretEnvelopeSchema,
  capabilities: modeCapabilitiesSchema, schemaDigest: sha256,
  lastValidatedAt: isoDateSchema, capabilitiesExpireAt: isoDateSchema,
  state: z.enum(['connected', 'reconnect-required']),
  oauthRefresh: z.enum(['idle', 'dispatching', 'reconnect-required']),
}).strict().refine(value => value.capabilities.browse || value.capabilities.fetch);
export const storedWebAccountSchema = z.object({
  kind: z.literal('account'), schemaVersion: z.literal(1), userId: idSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  enabled: z.boolean(), updatedAt: isoDateSchema,
  connections: z.object({
    tinyfish: storedWebConnectionSchema.optional(),
    keenable: storedWebConnectionSchema.optional(),
    exa: storedWebConnectionSchema.optional(),
    tavily: storedWebConnectionSchema.optional(),
    firecrawl: storedWebConnectionSchema.optional(),
  }).strict(),
}).strict();
export const storedWebOAuthStateSchema = z.object({
  kind: z.literal('oauth-state'), schemaVersion: z.literal(1), userId: idSchema,
  provider: z.enum(WEB_SEARCH_PROVIDERS),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  connectionId: idSchema,
  credentialVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  stateHash: sha256, browserHash: sha256, sessionHash: sha256,
  encryptedVerifier: secretEnvelopeSchema, binding: oauthBindingSchema,
  createdAt: isoDateSchema, expiresAt: z.date(), consumedAt: isoDateSchema.nullable(),
}).strict();
