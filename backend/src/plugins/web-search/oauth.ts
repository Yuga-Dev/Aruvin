/**
 * ============================================================================
 * FILE: oauth.ts
 * LOCATION: backend/src/plugins/web-search/oauth.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Implement capability-gated browser OAuth setup for fixed providers.
 *
 * ROLE IN PROJECT:
 *    Uses SDK discovery/DCR/PKCE/exchange primitives with exact origins,
 *    single-use durable state, and no REST or keyless fallback.
 *
 * KEY COMPONENTS:
 *    - WebSearchOAuth.start: Discovery, registration, PKCE, state save.
 *    - WebSearchOAuth.complete: Strict callback binding, consume, exchange.
 *    - oauthCookie/clearOAuthCookie: Provider-scoped HttpOnly browser binding.
 * ============================================================================
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization,
  registerClient, startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata, OAuthMetadata, OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthPrincipal } from '../../contracts/auth.js';
import { WEB_SEARCH_POLICY, WEB_SEARCH_PROVIDERS } from '../../contracts/web-search-policy.js';
import type { WebSearchProvider } from '../../contracts/web-search-policy.js';
import { WEB_SEARCH_ROUTES, webSearchOAuthStartRequestSchema } from '../../contracts/web-search-wire.js';
import type { WebSearchSecretCipher } from '../../platform/crypto/web-search-secret-cipher.js';
import { acquireSetupSlot, releaseSetupSlot, WebSearchConnections } from './connection.js';
import { WebSearchFault } from './errors.js';
import type { WebMcpClient } from './mcp-client.js';
import { providerDefinition } from './providers.js';
import {
  oauthBindingSchema, storedWebOAuthStateSchema,
  type CredentialBundle, type OAuthBinding, type StoredWebOAuthState,
  type WebSearchOAuthApi, type WebSearchStore,
} from './types.js';

export type WebSearchOAuthOptions = {
  connections: WebSearchConnections; store: () => WebSearchStore | null;
  cipher: WebSearchSecretCipher; mcp: WebMcpClient; frontendOrigin: string;
  secureCookie: boolean; fetch?: typeof globalThis.fetch; now?: () => Date; nowMs?: () => number;
};

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const QUERY_MAX = 8_192;
const METADATA_MAX = 65_536;
const TOKEN_MAX = 32_768;
const ALLOWED_QUERY = new Set([
  'state', 'code', 'error', 'error_description', 'error_uri', 'scope', 'iss',
]);
const SECRET_QUERY = new Set([
  'apikey', 'exaapikey', 'tavilyapikey', 'access_token', 'refresh_token',
  'code_verifier', 'client_secret', 'authorization',
]);
const FIREcrawl_RESOURCE = 'https://api.firecrawl.dev/';

const hash = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const opaque = (): string => randomBytes(32).toString('base64url');

export function oauthCookieName(provider: WebSearchProvider): string {
  return `aurvin_web_search_oauth_${provider}`;
}
export function oauthCookie(
  provider: WebSearchProvider, browser: string, secure: boolean,
): string {
  return `${oauthCookieName(provider)}=${browser}; Path=/api/plugins/web-search/providers/${provider}/oauth; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`;
}
export function clearOAuthCookie(provider: WebSearchProvider, secure: boolean): string {
  return `${oauthCookieName(provider)}=; Path=/api/plugins/web-search/providers/${provider}/oauth; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function uniqueQuery(raw: string): URLSearchParams {
  if (Buffer.byteLength(raw, 'utf8') > QUERY_MAX) throw new WebSearchFault('WEB_INVALID_REQUEST');
  const pairs = raw.length === 0 ? [] : raw.split('&');
  const keys: string[] = [];
  for (const pair of pairs) {
    let key: string;
    try {
      key = decodeURIComponent((pair.split('=')[0] ?? '').replace(/\+/g, ' '));
    } catch {
      throw new WebSearchFault('WEB_INVALID_REQUEST');
    }
    if (!ALLOWED_QUERY.has(key)) throw new WebSearchFault('WEB_INVALID_REQUEST');
    keys.push(key);
  }
  if (new Set(keys).size !== keys.length) throw new WebSearchFault('WEB_INVALID_REQUEST');
  const params = new URLSearchParams(raw);
  if (params.getAll('state').length !== 1) throw new WebSearchFault('WEB_INVALID_REQUEST');
  const code = params.getAll('code').length;
  const error = params.getAll('error').length;
  if ((code === 0) === (error === 0) || code > 1 || error > 1) {
    throw new WebSearchFault('WEB_INVALID_REQUEST');
  }
  return params;
}

function cookieValue(header: string | undefined, provider: WebSearchProvider): string {
  if (header === undefined || header.length === 0) {
    throw new WebSearchFault('WEB_OAUTH_BINDING_MISMATCH');
  }
  const name = oauthCookieName(provider);
  const values = header.split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${name}=`));
  if (values.length !== 1) throw new WebSearchFault('WEB_OAUTH_BINDING_MISMATCH');
  const value = values[0]!.slice(name.length + 1);
  if (!OPAQUE.test(value)) throw new WebSearchFault('WEB_OAUTH_BINDING_MISMATCH');
  return value;
}

async function boundedResponse(response: Response, cap: number): Promise<Response> {
  if (response.status >= 300 && response.status < 400) throw new Error('redirect');
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error('response too large');
    }
    decoder.decode(value, { stream: true });
    chunks.push(value);
  }
  decoder.decode();
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Response(body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

function pinnedMetadata(binding: OAuthBinding): OAuthMetadata {
  return {
    issuer: binding.issuer,
    authorization_endpoint: binding.authorizationEndpoint,
    token_endpoint: binding.tokenEndpoint,
    ...(binding.registrationEndpoint === null
      ? {} : { registration_endpoint: binding.registrationEndpoint }),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    ...(binding.scope === '' ? {} : { scopes_supported: binding.scope.split(' ') }),
  };
}

export class WebSearchOAuth implements WebSearchOAuthApi {
  private readonly connections: WebSearchConnections;
  private readonly store: () => WebSearchStore | null;
  private readonly cipher: WebSearchSecretCipher;
  private readonly mcp: WebMcpClient;
  private readonly frontendOrigin: string;
  private readonly secureCookie: boolean;
  private readonly baseFetch: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly nowMs: () => number;
  private readonly flows = new Map<string, {
    userId: string; provider: WebSearchProvider; lifecycleEpoch: number;
  }>();
  private readonly maintenance = new Map<string, Promise<void>>();
  private readonly maintenanceSlots = new Set<string>();
  private readonly cooldowns = new Map<string, number>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly sweepAbort = new AbortController();

  constructor(options: WebSearchOAuthOptions) {
    this.connections = options.connections;
    this.store = options.store;
    this.cipher = options.cipher;
    this.mcp = options.mcp;
    this.frontendOrigin = options.frontendOrigin;
    this.secureCookie = options.secureCookie;
    this.baseFetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.sweepTimer = setInterval(() => {
      const signal = this.sweepAbort.signal;
      if (signal.aborted) return;
      for (const userId of this.connections.preparedOwners()) {
        if (!this.connections.isEnabled(userId)) continue;
        void this.connections.prepareApiKeySessions(userId, signal).catch(() => undefined);
        void this.maintainOwner(userId, signal).catch(() => undefined);
      }
    }, 60_000);
    this.sweepTimer.unref?.();
  }

  private redirectUri(provider: WebSearchProvider): string {
    const origin = new URL(this.frontendOrigin);
    const loopback = origin.protocol === 'http:'
      && (origin.hostname === '127.0.0.1' || origin.hostname === 'localhost');
    if (origin.protocol !== 'https:' && !loopback) {
      throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    }
    return new URL(`/api${WEB_SEARCH_ROUTES.oauthCallback(provider)}`, this.frontendOrigin).toString();
  }

  private oauthFetch(allowed: ReadonlySet<string>): typeof globalThis.fetch {
    return async (input, init) => {
      const raw = input instanceof URL ? input.toString()
        : typeof input === 'string' ? input : input.url;
      const url = new URL(raw);
      if (!allowed.has(url.origin) || url.username !== '' || url.password !== ''
        || url.hash !== '') throw new Error('origin not allowed');
      const response = await this.baseFetch(url, {
        ...init, redirect: 'error', cache: 'no-store',
      });
      if (response.status >= 300 && response.status < 400) throw new Error('redirect rejected');
      const cap = url.pathname.includes('token') || url.pathname.includes('register')
        ? TOKEN_MAX : METADATA_MAX;
      return boundedResponse(response, cap);
    };
  }

  private assertOrigins(definition: ReturnType<typeof providerDefinition>, value: string): void {
    let url: URL;
    try { url = new URL(value); } catch { throw new WebSearchFault('WEB_AUTH_UNSUPPORTED'); }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
      || !definition.oauthOrigins.includes(url.origin)) {
      throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    }
  }

  private assertMetadata(
    definition: ReturnType<typeof providerDefinition>,
    authorizationServerUrl: string,
    metadata: OAuthMetadata,
    resource: OAuthProtectedResourceMetadata | undefined,
  ): void {
    this.assertOrigins(definition, authorizationServerUrl);
    this.assertOrigins(definition, metadata.issuer);
    this.assertOrigins(definition, metadata.authorization_endpoint);
    this.assertOrigins(definition, metadata.token_endpoint);
    if (metadata.registration_endpoint !== undefined) {
      this.assertOrigins(definition, metadata.registration_endpoint);
    }
    if (new URL(metadata.issuer).toString() !== new URL(authorizationServerUrl).toString()) {
      throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    }
    if (!metadata.response_types_supported.includes('code')
      || !metadata.grant_types_supported?.includes('authorization_code')
      || !metadata.grant_types_supported?.includes('refresh_token')
      || !metadata.code_challenge_methods_supported?.includes('S256')
      || !metadata.token_endpoint_auth_methods_supported?.includes('none')) {
      throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    }
    if (!resource) throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    const acceptedResources = [definition.oauthEndpoint, definition.apiKeyEndpoint,
      ...(definition.provider === 'firecrawl' ? [FIREcrawl_RESOURCE] : [])];
    if (!acceptedResources.includes(resource.resource)) {
      throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    }
    const issuers = resource.authorization_servers ?? [];
    if (!issuers.some(issuer => {
      try { return new URL(issuer).origin === new URL(authorizationServerUrl).origin; } catch { return false; }
    })) throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
  }

  private assertAuthorizationUrl(
    definition: ReturnType<typeof providerDefinition>, value: URL,
  ): void {
    this.assertOrigins(definition, value.toString());
    if (value.hash !== '') throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    for (const key of value.searchParams.keys()) {
      if (SECRET_QUERY.has(key.toLowerCase())) throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    }
  }

  async start(
    principal: AuthPrincipal, provider: WebSearchProvider, raw: unknown, signal: AbortSignal,
  ): Promise<{ authorizationUrl: string; expiresAt: string; browserCookie: string }> {
    const body = webSearchOAuthStartRequestSchema.parse(raw);
    const userId = principal.identity.userId;
    if (signal.aborted) throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
    acquireSetupSlot();
    try {
      const status = this.connections.status(userId);
      if (status.revision !== body.expectedRevision) {
        throw new WebSearchFault('WEB_SETTINGS_CONFLICT', status.revision);
      }
      const definition = providerDefinition(provider);
      const redirectUri = this.redirectUri(provider);
      const lifecycleEpoch = this.connections.lifecycleEpoch(userId);
      const allowed = new Set(definition.oauthOrigins);
      const fetchFn = this.oauthFetch(allowed);
      const info = await discoverOAuthServerInfo(new URL(definition.oauthEndpoint), { fetchFn });
      const metadata = info.authorizationServerMetadata as OAuthMetadata | undefined;
      if (!metadata) throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
      this.assertMetadata(definition, info.authorizationServerUrl, metadata, info.resourceMetadata);
      // TinyFish needs refresh, not OIDC identity or Clerk user metadata scopes.
      const scope = provider === 'tinyfish' ? 'offline_access' : metadata.scopes_supported?.join(' ') ?? '';
      if (provider === 'tinyfish'
        && (!metadata.scopes_supported?.includes(scope)
          || !info.resourceMetadata?.scopes_supported?.includes(scope))) {
        throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
      }
      const clientMetadata: OAuthClientMetadata = {
        client_name: 'Aurvin',
        redirect_uris: [redirectUri],
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
        ...(provider === 'tinyfish' ? { scope } : {}),
      };
      const registration = await registerClient(info.authorizationServerUrl, {
        metadata, clientMetadata, fetchFn,
      });
      if (typeof registration.client_id !== 'string' || registration.client_id.length < 1
        || registration.client_id.length > 512 || registration.client_secret !== undefined) {
        throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
      }
      const state = opaque();
      const browser = opaque();
      const authorization = await startAuthorization(info.authorizationServerUrl, {
        metadata,
        clientInformation: { client_id: registration.client_id, issuer: info.authorizationServerUrl },
        redirectUrl: redirectUri,
        ...(scope === '' ? {} : { scope }),
        state,
        resource: info.resourceMetadata!.resource,
      });
      this.assertAuthorizationUrl(definition, authorization.authorizationUrl);
      const connectionId = randomUUID();
      const credentialVersion = this.connections.credentialVersionFor(userId, provider);
      const binding: OAuthBinding = {
        issuer: info.authorizationServerUrl,
        resource: info.resourceMetadata!.resource,
        redirectUri,
        clientId: registration.client_id,
        authorizationEndpoint: metadata.authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
        registrationEndpoint: metadata.registration_endpoint ?? null,
        scope,
      };
      const at = this.now();
      const record = storedWebOAuthStateSchema.parse({
        kind: 'oauth-state', schemaVersion: 1, userId, provider,
        expectedRevision: body.expectedRevision, connectionId, credentialVersion,
        stateHash: hash(state), browserHash: hash(browser), sessionHash: hash(principal.sessionId),
        encryptedVerifier: this.cipher.seal({
          userId, provider, connectionId, credentialVersion, tokenKind: 'pkce',
        }, authorization.codeVerifier),
        binding: oauthBindingSchema.parse(binding),
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + WEB_SEARCH_POLICY.oauthStateTtlMs),
        consumedAt: null,
      });
      const store = this.store();
      if (!store) throw new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
      let saved: 'confirmed' | 'uncertain';
      try {
        saved = await store.putOAuthState(record);
      } catch {
        throw new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
      }
      if (saved !== 'confirmed') throw new WebSearchFault('WEB_WRITE_UNCERTAIN');
      this.flows.set(record.stateHash, { userId, provider, lifecycleEpoch });
      return {
        authorizationUrl: authorization.authorizationUrl.toString(),
        expiresAt: record.expiresAt.toISOString(),
        browserCookie: oauthCookie(provider, browser, this.secureCookie),
      };
    } catch (error) {
      if (error instanceof WebSearchFault) throw error;
      throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    } finally {
      releaseSetupSlot();
    }
  }

  async complete(
    principal: AuthPrincipal, provider: WebSearchProvider,
    input: { rawQuery: string; cookieHeader: string | undefined },
    signal: AbortSignal,
  ): Promise<'connected' | 'denied' | 'expired' | 'failed'> {
    if (signal.aborted) throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
    if (typeof input.rawQuery !== 'string'
      || Buffer.byteLength(input.rawQuery, 'utf8') > QUERY_MAX) {
      throw new WebSearchFault('WEB_INVALID_REQUEST');
    }
    const params = uniqueQuery(input.rawQuery);
    const state = params.get('state')!;
    if (!OPAQUE.test(state)) throw new WebSearchFault('WEB_OAUTH_STATE_INVALID');
    const cookie = cookieValue(input.cookieHeader, provider);
    const userId = principal.identity.userId;
    const store = this.store();
    if (!store) throw new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
    const stateHash = hash(state);
    const browserHash = hash(cookie);
    const sessionHash = hash(principal.sessionId);
    let record: StoredWebOAuthState | null;
    try {
      record = await store.readOAuthState(userId, provider, stateHash);
    } catch {
      throw new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
    }
    if (!record) throw new WebSearchFault('WEB_OAUTH_STATE_INVALID');
    if (record.userId !== userId || record.provider !== provider
      || record.sessionHash !== sessionHash || record.browserHash !== browserHash) {
      throw new WebSearchFault('WEB_OAUTH_BINDING_MISMATCH');
    }
    if (record.expectedRevision !== this.connections.status(userId).revision) {
      throw new WebSearchFault('WEB_OAUTH_STATE_INVALID');
    }
    const at = this.now();
    if (record.expiresAt.getTime() <= at.getTime()) {
      throw new WebSearchFault('WEB_OAUTH_EXPIRED');
    }
    const iss = params.get('iss');
    if (iss !== null && iss !== record.binding.issuer) {
      throw new WebSearchFault('WEB_OAUTH_BINDING_MISMATCH');
    }
    let consumed: 'consumed' | 'not-found' | 'uncertain';
    try {
      consumed = await store.consumeOAuthState({
        userId, provider, stateHash, browserHash, sessionHash, now: at.toISOString(),
      });
    } catch {
      throw new WebSearchFault('WEB_WRITE_UNCERTAIN');
    }
    if (consumed === 'uncertain') throw new WebSearchFault('WEB_WRITE_UNCERTAIN');
    if (consumed === 'not-found') throw new WebSearchFault('WEB_OAUTH_STATE_INVALID');
    const flow = this.flows.get(stateHash);
    if (flow !== undefined && (flow.userId !== userId || flow.provider !== provider
      || flow.lifecycleEpoch !== this.connections.lifecycleEpoch(userId))) {
      this.flows.delete(stateHash);
      throw new WebSearchFault('WEB_OAUTH_STATE_INVALID');
    }
    try {
      const error = params.get('error');
      if (error !== null) return error === 'access_denied' ? 'denied' : 'failed';
      const code = params.get('code')!;
      if (code.length < 1 || code.length > 512) throw new WebSearchFault('WEB_INVALID_REQUEST');
      let verifier: string;
      try {
        verifier = this.cipher.open({
          userId, provider, connectionId: record.connectionId,
          credentialVersion: record.credentialVersion, tokenKind: 'pkce',
        }, record.encryptedVerifier);
      } catch {
        throw new WebSearchFault('WEB_ENCRYPTION_UNAVAILABLE');
      }
      const definition = providerDefinition(provider);
      const fetchFn = this.oauthFetch(new Set(definition.oauthOrigins));
      let tokens;
      try {
        tokens = await exchangeAuthorization(record.binding.issuer, {
          metadata: pinnedMetadata(record.binding),
          clientInformation: { client_id: record.binding.clientId, issuer: record.binding.issuer },
          authorizationCode: code,
          codeVerifier: verifier,
          redirectUri: record.binding.redirectUri,
          resource: record.binding.resource,
          fetchFn,
        });
      } catch {
        throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
      }
      if (flow !== undefined
        && flow.lifecycleEpoch !== this.connections.lifecycleEpoch(userId)) {
        throw new WebSearchFault('WEB_OAUTH_STATE_INVALID');
      }
      const credentials = this.tokensToCredentials(record.binding, tokens);
      const deadlineAt = this.nowMs() + WEB_SEARCH_POLICY.providerCallTimeoutMs;
      let prepared;
      try {
        prepared = await this.mcp.prepare({
          userId, provider, connectionId: record.connectionId,
          credentialVersion: record.credentialVersion, credentials,
          signal, deadlineAt, probe: true,
        });
      } catch (error) {
        throw error instanceof WebSearchFault ? error : new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
      }
      await this.connections.installOAuth(userId, provider, {
        expectedRevision: record.expectedRevision,
        connectionId: record.connectionId,
        credentialVersion: record.credentialVersion,
        credentials,
        capabilities: prepared.capabilities,
        schemaDigest: prepared.schemaDigest,
        session: prepared.session,
      });
      return 'connected';
    } finally {
      this.flows.delete(stateHash);
    }
  }

  private tokensToCredentials(
    binding: OAuthBinding, tokens: { access_token: string; token_type: string;
      expires_in?: number; refresh_token?: string },
  ): Extract<CredentialBundle, { method: 'oauth' }> {
    if (tokens.token_type.toLowerCase() !== 'bearer'
      || tokens.access_token.length < 1 || tokens.access_token.length > 8_192) {
      throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    }
    const expiresIn = Number(tokens.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86_400) {
      throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    }
    const refreshToken = tokens.refresh_token ?? null;
    if (refreshToken !== null && (refreshToken.length < 1 || refreshToken.length > 8_192)) {
      throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
    }
    return {
      method: 'oauth', accessToken: tokens.access_token, refreshToken,
      expiresAt: new Date(this.now().getTime() + expiresIn * 1_000).toISOString(),
      binding,
    };
  }

  async maintainOwner(userId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const existing = this.maintenance.get(userId);
    if (existing) return existing;
    const job = (async () => {
      if (this.maintenanceSlots.size >= 2) return;
      this.maintenanceSlots.add(userId);
      try {
        await this.runMaintenance(userId, signal);
      } finally {
        this.maintenanceSlots.delete(userId);
      }
    })();
    this.maintenance.set(userId, job);
    try {
      await job;
    } finally {
      this.maintenance.delete(userId);
    }
  }

  private async runMaintenance(userId: string, signal: AbortSignal): Promise<void> {
    await this.connections.warmOwner(userId);
    for (const provider of WEB_SEARCH_PROVIDERS) {
      if (signal.aborted) return;
      const connection = this.connections.oauthConnection(userId, provider);
      if (!connection) continue;
      const key = `${userId}\0${provider}`;
      const cooldown = this.cooldowns.get(key);
      if (cooldown !== undefined && cooldown > this.nowMs()) continue;
      if (connection.oauthRefresh === 'dispatching'
        || connection.oauthRefresh === 'reconnect-required') {
        await this.markReconnect(userId, provider, connection.revision);
        continue;
      }
      const now = this.now().getTime();
      if (Date.parse(connection.credentials.expiresAt) - now <= 60_000) {
        await this.refresh(userId, provider, connection, signal);
        continue;
      }
      const current = this.connections.preparedProvider(userId, provider);
      const session = current ? this.mcp.session(current, userId) : null;
      if (!current || !session || Date.parse(connection.capabilitiesExpireAt) <= now) {
        await this.reopen(userId, provider, connection, signal);
      }
    }
  }

  private async refresh(
    userId: string, provider: WebSearchProvider,
    connection: NonNullable<ReturnType<WebSearchConnections['oauthConnection']>>,
    signal: AbortSignal,
  ): Promise<void> {
    const key = `${userId}\0${provider}`;
    if (connection.credentials.refreshToken === null) {
      await this.markReconnect(userId, provider, connection.revision);
      return;
    }
    let revision: number;
    try {
      revision = await this.connections.updateOAuthRefresh(userId, provider, {
        expectedRevision: connection.revision, oauthRefresh: 'dispatching',
      });
    } catch {
      this.cooldowns.set(key, this.nowMs() + 30_000);
      return;
    }
    let posted = false;
    try {
      posted = true;
      const tokens = await refreshAuthorization(connection.binding.issuer, {
        metadata: pinnedMetadata(connection.binding),
        clientInformation: {
          client_id: connection.binding.clientId, issuer: connection.binding.issuer,
        },
        refreshToken: connection.credentials.refreshToken,
        resource: connection.binding.resource,
        fetchFn: this.oauthFetch(new Set(providerDefinition(provider).oauthOrigins)),
      });
      const credentials = this.tokensToCredentials(connection.binding, tokens);
      const deadlineAt = this.nowMs() + WEB_SEARCH_POLICY.providerCallTimeoutMs;
      const prepared = await this.mcp.prepare({
        userId, provider, connectionId: connection.connectionId,
        credentialVersion: connection.credentialVersion + 1, credentials,
        signal, deadlineAt, probe: false,
      });
      const at = this.now();
      await this.connections.updateOAuthRefresh(userId, provider, {
        expectedRevision: revision, oauthRefresh: 'idle', state: 'connected',
        credentials, capabilities: prepared.capabilities, schemaDigest: prepared.schemaDigest,
        lastValidatedAt: at.toISOString(),
        capabilitiesExpireAt: new Date(at.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
        session: prepared.session,
      });
    } catch {
      if (posted) await this.markReconnect(userId, provider, revision);
      else this.cooldowns.set(key, this.nowMs() + 30_000);
    }
  }

  private async reopen(
    userId: string, provider: WebSearchProvider,
    connection: NonNullable<ReturnType<WebSearchConnections['oauthConnection']>>,
    signal: AbortSignal,
  ): Promise<void> {
    const key = `${userId}\0${provider}`;
    try {
      const prepared = await this.mcp.prepare({
        userId, provider, connectionId: connection.connectionId,
        credentialVersion: connection.credentialVersion, credentials: connection.credentials,
        signal, deadlineAt: this.nowMs() + WEB_SEARCH_POLICY.providerCallTimeoutMs, probe: false,
      });
      const at = this.now();
      await this.connections.updateOAuthRefresh(userId, provider, {
        expectedRevision: connection.revision, oauthRefresh: 'idle', state: 'connected',
        capabilities: prepared.capabilities, schemaDigest: prepared.schemaDigest,
        lastValidatedAt: at.toISOString(),
        capabilitiesExpireAt: new Date(at.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
        session: prepared.session,
      });
    } catch (error) {
      if (error instanceof WebSearchFault
        && (error.code === 'WEB_INVALID_KEY' || error.code === 'WEB_AUTH_UNSUPPORTED')) {
        await this.markReconnect(userId, provider, connection.revision);
      } else {
        this.cooldowns.set(key, this.nowMs() + 30_000);
      }
    }
  }

  private async markReconnect(
    userId: string, provider: WebSearchProvider, expectedRevision: number,
  ): Promise<void> {
    try {
      await this.connections.updateOAuthRefresh(userId, provider, {
        expectedRevision, oauthRefresh: 'reconnect-required', state: 'reconnect-required',
      });
    } catch {
      /* Control-plane reconciliation only; never a turn-path write. */
    }
  }

  invalidate(userId: string, provider?: WebSearchProvider): void {
    for (const [stateHash, flow] of this.flows) {
      if (flow.userId !== userId) continue;
      if (provider !== undefined && flow.provider !== provider) continue;
      this.flows.delete(stateHash);
    }
    for (const key of this.cooldowns.keys()) {
      if (!key.startsWith(`${userId}\0`)) continue;
      if (provider !== undefined && key !== `${userId}\0${provider}`) continue;
      this.cooldowns.delete(key);
    }
  }

  async close(): Promise<void> {
    this.sweepAbort.abort();
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.flows.clear();
    this.cooldowns.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(this.maintenance.values()),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); timer.unref?.(); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }
}
