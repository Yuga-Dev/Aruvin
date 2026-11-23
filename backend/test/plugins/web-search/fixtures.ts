/**
 * ============================================================================
 * FILE: fixtures.ts
 * LOCATION: backend/test/plugins/web-search/fixtures.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Provide deterministic in-memory stores, clocks, and MCP sessions for P2.
 *
 * ROLE IN PROJECT:
 *    Exercises real connection/cipher/runtime services with fake storage and
 *    provider boundaries so no live database, MCP, or OAuth request is made.
 *
 * KEY COMPONENTS:
 *    - connectionFixture: Real connections service, fake store/MCP, counters.
 *    - gate: Deferred barrier used for held saves, reads, and prepares.
 *    - Fake store: Bounded account CAS and single-use OAuth state.
 * ============================================================================
 */

import { Buffer } from 'node:buffer';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AuthFault } from '../../../src/auth/errors.js';
import { AppError } from '../../../src/platform/errors/app-error.js';
import type { AuthPrincipal } from '../../../src/contracts/auth.js';
import type { WebSearchHttpErrorCode, WebSearchPublicStatus } from '../../../src/contracts/web-search-wire.js';
import { WebSearchSecretCipher } from '../../../src/platform/crypto/web-search-secret-cipher.js';
import { WebSearchConnections } from '../../../src/plugins/web-search/connection.js';
import { WebSearchFault } from '../../../src/plugins/web-search/errors.js';
import { WebToolFault } from '../../../src/plugins/web-search/errors.js';
import type { PreparedMcpSession, WebMcpClient } from '../../../src/plugins/web-search/mcp-client.js';
import { oauthCookieName, WebSearchOAuth } from '../../../src/plugins/web-search/oauth.js';
import { WebSearchModule } from '../../../src/plugins/web-search/module.js';
import { providerDefinition } from '../../../src/plugins/web-search/providers.js';
import { WebSearchRuntime } from '../../../src/plugins/web-search/runtime.js';
import type {
  PreparedProvider, StoredWebAccount, StoredWebOAuthState, WebSearchStore,
  WebSearchOAuthApi,
} from '../../../src/plugins/web-search/types.js';
import type { WebSearchProvider } from '../../../src/contracts/web-search-policy.js';
import type { WebToolArguments, WebToolResult } from '../../../src/contracts/web-search-tools.js';
import type {
  ValidatedWebInput, WebCallContext,
} from '../../../src/plugins/web-search/types.js';
import type { WebSearchActivity, WebToolErrorCode } from '../../../src/contracts/web-search-wire.js';

export type Gate = { promise: Promise<void>; entered: Promise<void>; release: () => void };

export function gate(): Gate {
  let release!: () => void;
  let enter!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  return { promise, entered, release, enter };
}

const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
const requestBody = (body: BodyInit | null | undefined): string => {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  return body instanceof URLSearchParams ? body.toString() : '';
};

export type ConnectionFixture = {
  service: WebSearchConnections;
  store: WebSearchStore;
  calls: { reads: number; writes: number; prepares: number; closes: number };
  connect(provider: PreparedProvider['provider'], userId?: string): Promise<WebSearchPublicStatus>;
  setEnabled(enabled: boolean, userId?: string): Promise<WebSearchPublicStatus>;
  failNextSave(outcome: 'uncertain' | 'conflict'): void;
  holdNextSave(): { release(): void; entered: Promise<void> };
  rejectNextPrepare(code: WebSearchHttpErrorCode): void;
  holdNextPrepare(): { release(): void; entered: Promise<void> };
  holdNextRead(): { release(): void; entered: Promise<void> };
  setNow(value: Date): void;
  records: Map<string, StoredWebAccount>;
  sessions: Map<string, PreparedMcpSession>;
};

export function connectionFixture(options: {
  now?: () => Date; nowMs?: () => number;
} = {}): ConnectionFixture {
  const records = new Map<string, StoredWebAccount>();
  const oauthStates: StoredWebOAuthState[] = [];
  const sessions = new Map<string, PreparedMcpSession>();
  const calls = { reads: 0, writes: 0, prepares: 0, closes: 0 };
  let nextSave: 'uncertain' | 'conflict' | null = null;
  let heldSave: Gate | null = null;
  let heldPrepare: Gate | null = null;
  let heldRead: Gate | null = null;
  let nextPrepareFault: WebSearchHttpErrorCode | null = null;
  let currentNow = options.now ?? (() => new Date('2026-11-14T00:00:00.000Z'));
  const now = () => currentNow();
  const nowMs = options.nowMs ?? (() => performance.now());

  const store: WebSearchStore = {
    async readAccount(userId) {
      calls.reads += 1;
      if (heldRead) { heldRead.enter(); await heldRead.promise; }
      const record = records.get(userId);
      return record ? structuredClone(record) : null;
    },
    async saveAccount(expectedRevision, next) {
      calls.writes += 1;
      if (heldSave) { heldSave.enter(); await heldSave.promise; }
      if (nextSave === 'uncertain') { nextSave = null; return { outcome: 'uncertain' }; }
      if (nextSave === 'conflict') {
        nextSave = null;
        return { outcome: 'conflict', currentRevision: records.get(next.userId)?.revision ?? 0 };
      }
      const current = records.get(next.userId);
      if (expectedRevision === 0) {
        if (current) return { outcome: 'conflict', currentRevision: current.revision };
        records.set(next.userId, structuredClone(next));
        return { outcome: 'confirmed', record: structuredClone(next) };
      }
      if (!current || current.revision !== expectedRevision) {
        return { outcome: 'conflict', currentRevision: current?.revision ?? 0 };
      }
      records.set(next.userId, structuredClone(next));
      return { outcome: 'confirmed', record: structuredClone(next) };
    },
    async putOAuthState(record) {
      calls.writes += 1;
      const index = oauthStates.findIndex(state =>
        state.userId === record.userId && state.provider === record.provider);
      if (index >= 0) oauthStates[index] = structuredClone(record);
      else oauthStates.push(structuredClone(record));
      return 'confirmed';
    },
    async readOAuthState(userId, provider, stateHash) {
      calls.reads += 1;
      const found = oauthStates.find(state => state.userId === userId
        && state.provider === provider && state.stateHash === stateHash);
      return found ? structuredClone(found) : null;
    },
    async consumeOAuthState(input) {
      calls.writes += 1;
      const found = oauthStates.find(state => state.userId === input.userId
        && state.provider === input.provider && state.stateHash === input.stateHash
        && state.browserHash === input.browserHash && state.sessionHash === input.sessionHash
        && state.consumedAt === null && state.expiresAt.getTime() > Date.parse(input.now));
      if (!found) return 'not-found';
      found.consumedAt = input.now;
      return 'consumed';
    },
  };

  const mcp: WebMcpClient = {
    async prepare(input) {
      calls.prepares += 1;
      if (heldPrepare) { heldPrepare.enter(); await heldPrepare.promise; }
      if (nextPrepareFault) {
        const code = nextPrepareFault;
        nextPrepareFault = null;
        throw new WebSearchFault(code);
      }
      const session: PreparedMcpSession = {
        call: async () => ({ content: [] }),
        close: async () => { calls.closes += 1; },
      };
      return {
        session, capabilities: { browse: true, fetch: false },
        schemaDigest: 'd'.repeat(64),
      };
    },
    publish(userId, provider, session) {
      const key = `${userId}\0${provider.provider}`;
      const previous = sessions.get(key);
      if (previous && previous !== session) void previous.close();
      sessions.set(key, session);
    },
    session(provider, userId) {
      return sessions.get(`${userId}\0${provider.provider}`) ?? null;
    },
    invalidate(userId, provider) {
      for (const key of sessions.keys()) {
        if (!key.startsWith(`${userId}\0`)) continue;
        if (provider !== undefined && key !== `${userId}\0${provider}`) continue;
        sessions.delete(key);
      }
    },
    async close() {
      calls.closes += sessions.size;
      sessions.clear();
    },
  };

  const cipher = new WebSearchSecretCipher({ status: 'ready', key: Buffer.alloc(32, 7) });
  const service = new WebSearchConnections({
    store: () => store, cipher, mcp, now, nowMs,
  });

  const statusOf = (userId: string) => service.status(userId);
  return {
    service, store, calls, records, sessions,
    connect(provider, userId = 'u_a') {
      const status = statusOf(userId);
      return service.connect(userId, provider, {
        protocolVersion: 1, expectedRevision: status.revision, candidate: 'fixture-key',
      }, new AbortController().signal);
    },
    setEnabled(enabled, userId = 'u_a') {
      const status = statusOf(userId);
      return service.settings(userId, {
        protocolVersion: 1, expectedRevision: status.revision, enabled,
      }, new AbortController().signal);
    },
    failNextSave(outcome) { nextSave = outcome; },
    holdNextSave() {
      const barrier = gate();
      heldSave = barrier;
      return {
        entered: barrier.entered,
        release: () => { heldSave = null; barrier.release(); },
      };
    },
    rejectNextPrepare(code) { nextPrepareFault = code; },
    holdNextPrepare() {
      const barrier = gate();
      heldPrepare = barrier;
      return {
        entered: barrier.entered,
        release: () => { heldPrepare = null; barrier.release(); },
      };
    },
    holdNextRead() {
      const barrier = gate();
      heldRead = barrier;
      return {
        entered: barrier.entered,
        release: () => { heldRead = null; barrier.release(); },
      };
    },
    setNow(value) { currentNow = () => value; },
  };
}

export type OAuthFixture = {
  oauth: WebSearchOAuth;
  connections: WebSearchConnections;
  start(userId?: string): Promise<{ authorizationUrl: string; expiresAt: string; browserCookie: string }>;
  complete(input: {
    state: string; code?: string; error?: string; cookie: string;
    owner?: string; session?: string;
  }): Promise<'connected' | 'denied' | 'expired' | 'failed'>;
  status(): WebSearchPublicStatus;
  statusOf(userId: string): WebSearchPublicStatus;
  tokenPosts(): number;
  refreshPosts(): number;
  advance(ms: number): void;
  expireAccess(): void;
  failNextToken(): void;
  failNextSave(outcome: 'uncertain' | 'conflict'): void;
  maintain(userId?: string): Promise<void>;
  setMetadata(value: Record<string, unknown>): void;
  setResourceMetadata(value: Record<string, unknown>): void;
  defaultMetadata(): Record<string, unknown>;
  setTokenResponse(value: Record<string, unknown>): void;
  loseConsumeAck(): void;
  holdTokenResponse(): { release(): void; entered: Promise<void> };
  requests: Array<{ url: string; method: string; redirect: RequestRedirect | undefined; body: string }>;
  setRegistrationResponse(value: Record<string, unknown>): void;
  records: Map<string, StoredWebAccount>;
  oauthStates: StoredWebOAuthState[];
};

const OAUTH_ORIGINS: Record<string, string> = {
  tinyfish: 'https://clerk.tinyfish.ai',
  keenable: 'https://app.keenable.ai',
  exa: 'https://auth.exa.ai',
  tavily: 'https://app.tavily.com',
  firecrawl: 'https://www.firecrawl.dev',
};
const OAUTH_RESOURCES: Record<string, string> = {
  tinyfish: 'https://agent.tinyfish.ai/mcp',
  keenable: 'https://api.keenable.ai/mcp-oauth',
  exa: 'https://mcp.exa.ai/mcp/oauth',
  tavily: 'https://mcp.tavily.com/mcp/',
  firecrawl: 'https://api.firecrawl.dev/',
};

export function webSearchPrincipal(userId = 'u_a', sessionId = 'session_1'): AuthPrincipal {
  return {
    account: {
      schemaVersion: 1, userId, workosUserId: `workos_${userId}`,
      emailNormalized: `${userId.replaceAll('_', '-')}@example.com`,
      role: 'user', status: 'active', passwordChangeRequired: false,
      currentWorkosSessionId: sessionId, sessionEpoch: 0,
      createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
    },
    sessionId,
    identity: { userId, openRouterUser: userId, source: 'authenticated-session' },
  };
}

export function oauthFixture(provider: PreparedProvider['provider']): OAuthFixture {
  const records = new Map<string, StoredWebAccount>();
  const oauthStates: StoredWebOAuthState[] = [];
  const sessions = new Map<string, PreparedMcpSession>();
  const calls = { reads: 0, writes: 0, prepares: 0, closes: 0 };
  let currentNow = new Date('2026-11-14T00:00:00.000Z');
  let consumeOutcome: 'uncertain' | null = null;
  let heldToken: Gate | null = null;
  let tokenPostCount = 0;
  let refreshPostCount = 0;
  let failToken = false;
  let nextSave: 'uncertain' | 'conflict' | null = null;
  const origin = OAUTH_ORIGINS[provider]!;
  const redirectUri = `https://aurvin.example.com/api/plugins/web-search/providers/${provider}/oauth/callback`;
  const requests: OAuthFixture['requests'] = [];
  const defaultMetadata = (): Record<string, unknown> => ({
    issuer: origin,
    authorization_endpoint: `${origin}${provider === 'tinyfish' ? '/oauth' : ''}/authorize`,
    token_endpoint: `${origin}${provider === 'tinyfish' ? '/oauth' : ''}/token`,
    registration_endpoint: `${origin}${provider === 'tinyfish' ? '/oauth' : ''}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: provider === 'tinyfish'
      ? ['client_secret_basic', 'none', 'client_secret_post'] : ['none'],
    scopes_supported: provider === 'tinyfish'
      ? ['openid', 'profile', 'email', 'public_metadata', 'private_metadata', 'offline_access', 'user:org:read']
      : provider === 'firecrawl' ? ['firecrawl:global', 'offline_access'] : ['read'],
  });
  let metadata = defaultMetadata();
  let resourceMetadata: Record<string, unknown> = {
    resource: OAUTH_RESOURCES[provider], authorization_servers: [origin],
    ...(provider === 'tinyfish'
      ? { scopes_supported: ['openid', 'profile', 'email', 'offline_access'] } : {}),
  };
  let tokenResponse: Record<string, unknown> = {
    access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600,
    refresh_token: 'fixture-refresh', scope: provider === 'tinyfish' ? 'offline_access' : 'read',
  };
  let registrationResponse: Record<string, unknown> = {
    client_id: 'client_1', redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  };

  const store: WebSearchStore = {
    async readAccount(userId) {
      calls.reads += 1;
      const record = records.get(userId);
      return record ? structuredClone(record) : null;
    },
    async saveAccount(expectedRevision, next) {
      calls.writes += 1;
      if (nextSave === 'uncertain') { nextSave = null; return { outcome: 'uncertain' }; }
      if (nextSave === 'conflict') {
        nextSave = null;
        return { outcome: 'conflict', currentRevision: records.get(next.userId)?.revision ?? 0 };
      }
      const current = records.get(next.userId);
      if (expectedRevision === 0) {
        if (current) return { outcome: 'conflict', currentRevision: current.revision };
        records.set(next.userId, structuredClone(next));
        return { outcome: 'confirmed', record: structuredClone(next) };
      }
      if (!current || current.revision !== expectedRevision) {
        return { outcome: 'conflict', currentRevision: current?.revision ?? 0 };
      }
      records.set(next.userId, structuredClone(next));
      return { outcome: 'confirmed', record: structuredClone(next) };
    },
    async putOAuthState(record) {
      calls.writes += 1;
      const index = oauthStates.findIndex(state =>
        state.userId === record.userId && state.provider === record.provider);
      if (index >= 0) oauthStates[index] = structuredClone(record);
      else oauthStates.push(structuredClone(record));
      return 'confirmed';
    },
    async readOAuthState(userId, providerName, stateHash) {
      calls.reads += 1;
      const found = oauthStates.find(state => state.userId === userId
        && state.provider === providerName && state.stateHash === stateHash);
      return found ? structuredClone(found) : null;
    },
    async consumeOAuthState(input) {
      calls.writes += 1;
      if (consumeOutcome === 'uncertain') { consumeOutcome = null; return 'uncertain'; }
      const found = oauthStates.find(state => state.userId === input.userId
        && state.provider === input.provider && state.stateHash === input.stateHash
        && state.browserHash === input.browserHash && state.sessionHash === input.sessionHash
        && state.consumedAt === null && state.expiresAt.getTime() > Date.parse(input.now));
      if (!found) return 'not-found';
      found.consumedAt = input.now;
      return 'consumed';
    },
  };

  const mcp: WebMcpClient = {
    async prepare() {
      calls.prepares += 1;
      const session: PreparedMcpSession = {
        call: async () => ({ content: [] }),
        close: async () => { calls.closes += 1; },
      };
      return {
        session, capabilities: { browse: true, fetch: false },
        schemaDigest: 'd'.repeat(64),
      };
    },
    publish(userId, prepared, session) {
      sessions.set(`${userId}\0${prepared.provider}`, session);
    },
    session(prepared, userId) {
      return sessions.get(`${userId}\0${prepared.provider}`) ?? null;
    },
    invalidate(userId, providerName) {
      for (const key of sessions.keys()) {
        if (!key.startsWith(`${userId}\0`)) continue;
        if (providerName !== undefined && key !== `${userId}\0${providerName}`) continue;
        sessions.delete(key);
      }
    },
    async close() { sessions.clear(); },
  };

  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(requestUrl(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({
      url: url.toString(), method, redirect: init?.redirect, body: requestBody(init?.body),
    });
    if (![new URL(providerDefinition(provider).oauthEndpoint).origin, origin].includes(url.origin)) {
      throw new Error('unexpected fixture OAuth origin');
    }
    if (method === 'GET' && url.pathname.includes('oauth-protected-resource')) {
      if (provider === 'tinyfish'
        && url.toString() !== 'https://agent.tinyfish.ai/.well-known/oauth-protected-resource/mcp') {
        return new Response(null, { status: 404 });
      }
      return Response.json(resourceMetadata);
    }
    if (method === 'GET' && (url.pathname.includes('oauth-authorization-server')
      || url.pathname.includes('openid-configuration'))) {
      if (provider === 'tinyfish'
        && url.toString() !== 'https://clerk.tinyfish.ai/.well-known/oauth-authorization-server') {
        return new Response(null, { status: 404 });
      }
      return Response.json(metadata);
    }
    if (method === 'POST' && url.pathname.endsWith('/register')) {
      return Response.json(registrationResponse);
    }
    if (method === 'POST' && url.pathname.endsWith('/token')) {
      tokenPostCount += 1;
      const body = requestBody(init?.body);
      if (body.includes('grant_type=refresh_token')) refreshPostCount += 1;
      if (heldToken) { heldToken.enter(); await heldToken.promise; }
      if (failToken) { failToken = false; throw new Error('lost token response'); }
      return Response.json(tokenResponse);
    }
    return new Response(null, { status: 404 });
  };

  const cipher = new WebSearchSecretCipher({ status: 'ready', key: Buffer.alloc(32, 7) });
  const connections = new WebSearchConnections({
    store: () => store, cipher, mcp, now: () => currentNow,
  });
  const oauth = new WebSearchOAuth({
    connections, store: () => store, cipher, mcp,
    frontendOrigin: 'https://aurvin.example.com', secureCookie: true,
    fetch: fetchFn, now: () => currentNow,
  });

  const browserValue = (cookie: string): string => {
    const eq = cookie.indexOf('=');
    return eq < 0 ? cookie : cookie.slice(eq + 1).split(';', 1)[0]!;
  };

  return {
    oauth, connections, records, oauthStates, requests,
    async start(userId = 'u_a') {
      await connections.warmOwner(userId);
      const status = connections.status(userId);
      return oauth.start(webSearchPrincipal(userId), provider, {
        protocolVersion: 1, expectedRevision: status.revision,
      }, new AbortController().signal);
    },
    complete(input) {
      const params = new URLSearchParams();
      params.set('state', input.state);
      if (input.error !== undefined) params.set('error', input.error);
      else params.set('code', input.code ?? 'fixture-code');
      return oauth.complete(
        webSearchPrincipal(input.owner, input.session), provider,
        {
          rawQuery: params.toString(),
          cookieHeader: `${oauthCookieName(provider)}=${browserValue(input.cookie)}`,
        },
        new AbortController().signal,
      );
    },
    status() { return connections.status('u_a'); },
    statusOf(userId) { return connections.status(userId); },
    tokenPosts() { return tokenPostCount; },
    refreshPosts() { return refreshPostCount; },
    advance(ms) { currentNow = new Date(currentNow.getTime() + ms); },
    expireAccess() { currentNow = new Date(currentNow.getTime() + 3_600_000); },
    failNextToken() { failToken = true; },
    failNextSave(outcome) { nextSave = outcome; },
    maintain(userId = 'u_a') {
      return oauth.maintainOwner(userId, new AbortController().signal);
    },
    setMetadata(value) { metadata = value; },
    setResourceMetadata(value) { resourceMetadata = value; },
    defaultMetadata,
    setTokenResponse(value) { tokenResponse = value; },
    setRegistrationResponse(value) { registrationResponse = value; },
    loseConsumeAck() { consumeOutcome = 'uncertain'; },
    holdTokenResponse() {
      const barrier = gate();
      heldToken = barrier;
      return {
        entered: barrier.entered,
        release: () => { heldToken = null; barrier.release(); },
      };
    },
  };
}

export type RuntimeFixture = {
  runtime: WebSearchRuntime;
  connections: WebSearchConnections;
  connect(providers: WebSearchProvider[]): Promise<void>;
  installOAuth(provider: WebSearchProvider, capabilities?: { browse: boolean; fetch: boolean }): Promise<void>;
  call(args: WebToolArguments): Promise<WebToolResult>;
  validate(args: WebToolArguments): Promise<ValidatedWebInput | Extract<WebToolResult, { ok: false }>>;
  execute(input: ValidatedWebInput, context?: WebCallContext): Promise<WebToolResult>;
  failProvider(provider: WebSearchProvider, code: WebToolErrorCode): void;
  holdProvider(provider: WebSearchProvider): { release(): void; entered: Promise<void> };
  dropSession(provider: WebSearchProvider): void;
  providerCalls(): WebSearchProvider[];
  maxConcurrentProviderCalls(): number;
  storageCallsSincePrepared(): number;
  anyAnonymousRequest(): boolean;
  advance(ms: number): void;
  setWebDeadline(value: number): void;
  abort(): void;
  disable(): Promise<void>;
  disconnect(provider: WebSearchProvider): Promise<void>;
  activities: WebSearchActivity[];
  context: WebCallContext;
  lastDeadline(provider: WebSearchProvider): number | undefined;
  prepares(): number;
  blockStorageAndPreparation(): void;
  storageOperations(): number;
  preparationOperations(): number;
  storageReads(): number;
  markInitialModelDispatch(): void;
  eventsBeforeDispatch(): WebSearchActivity[];
};

export function runtimeFixture(): RuntimeFixture {
  const records = new Map<string, StoredWebAccount>();
  const sessions = new Map<string, PreparedMcpSession>();
  const calls: WebSearchProvider[] = [];
  const failures = new Map<WebSearchProvider, WebToolErrorCode>();
  const holds = new Map<WebSearchProvider, Gate>();
  const deadlines = new Map<WebSearchProvider, number>();
  const activities: WebSearchActivity[] = [];
  let reads = 0;
  let writes = 0;
  let baseline = 0;
  let active = 0;
  let maxActive = 0;
  let prepares = 0;
  let blocked = false;
  let blockedStorage = 0;
  let blockedPrepares = 0;
  let dispatchEvents: WebSearchActivity[] | null = null;
  let currentNow = new Date('2026-11-14T00:00:00.000Z');
  const controller = new AbortController();

  const store: WebSearchStore = {
    async readAccount(userId) {
      if (blocked) { blockedStorage += 1; throw new Error('blocked storage'); }
      reads += 1;
      const record = records.get(userId);
      return record ? structuredClone(record) : null;
    },
    async saveAccount(expectedRevision, next) {
      if (blocked) { blockedStorage += 1; throw new Error('blocked storage'); }
      writes += 1;
      const current = records.get(next.userId);
      if (expectedRevision === 0) {
        if (current) return { outcome: 'conflict', currentRevision: current.revision };
        records.set(next.userId, structuredClone(next));
        return { outcome: 'confirmed', record: structuredClone(next) };
      }
      if (!current || current.revision !== expectedRevision) {
        return { outcome: 'conflict', currentRevision: current?.revision ?? 0 };
      }
      records.set(next.userId, structuredClone(next));
      return { outcome: 'confirmed', record: structuredClone(next) };
    },
    async putOAuthState() { return 'confirmed'; },
    async readOAuthState() { return null; },
    async consumeOAuthState() { return 'not-found'; },
  };

  const payloadFor = (provider: WebSearchProvider, mapped: { name: string; arguments: Record<string, unknown> }) => {
    const definition = providerDefinition(provider);
    const fetchMode = mapped.name === definition.fetchTool;
    if (!fetchMode) {
      switch (provider) {
        case 'tinyfish':
        case 'keenable':
          return { results: [{ title: 'Example', url: 'https://example.com/', snippet: 'Useful' }] };
        case 'exa':
          return { results: [{ title: 'Example', url: 'https://example.com/', highlights: ['Useful'] }] };
        case 'tavily':
          return { results: [{ title: 'Example', url: 'https://example.com/', content: 'Useful' }] };
        case 'firecrawl':
          return { data: { web: [{ title: 'Example', url: 'https://example.com/', description: 'Useful' }] } };
      }
    }
    const raw = mapped.arguments.url ?? (mapped.arguments.urls as string[] | undefined)?.[0]
      ?? 'https://example.com/page';
    switch (provider) {
      case 'tinyfish':
        return { results: [{ url: raw, content: 'Page body', page_metadata: { title: 'Page' } }] };
      case 'keenable':
        return { title: 'Page', url: raw, content: 'Page body' };
      case 'exa':
        return { results: [{ url: raw, title: 'Page', text: 'Page body' }] };
      case 'tavily':
        return { results: [{ url: raw, raw_content: 'Page body' }] };
      case 'firecrawl':
        return { data: { markdown: 'Page body', metadata: { title: 'Page', sourceURL: raw } } };
    }
  };

  const sessionFor = (provider: WebSearchProvider): PreparedMcpSession => ({
    async call(mapped, _signal, deadlineAt) {
      calls.push(provider);
      deadlines.set(provider, deadlineAt);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const hold = holds.get(provider);
        if (hold) { hold.enter(); await hold.promise; }
        const failure = failures.get(provider);
        if (failure) throw new WebToolFault(failure);
        return { content: [{ type: 'text', text: JSON.stringify(payloadFor(provider, mapped)) }] };
      } finally {
        active -= 1;
      }
    },
    async close() { /* fixture session */ },
  });

  const mcp: WebMcpClient = {
    async prepare(input) {
      if (blocked) { blockedPrepares += 1; throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE'); }
      prepares += 1;
      return {
        session: sessionFor(input.provider),
        capabilities: { browse: true, fetch: false },
        schemaDigest: 'd'.repeat(64),
      };
    },
    publish(userId, prepared, session) {
      sessions.set(`${userId}\0${prepared.provider}`, session);
    },
    session(prepared, userId) {
      return sessions.get(`${userId}\0${prepared.provider}`) ?? null;
    },
    invalidate(userId, provider) {
      for (const key of sessions.keys()) {
        if (!key.startsWith(`${userId}\0`)) continue;
        if (provider !== undefined && key !== `${userId}\0${provider}`) continue;
        sessions.delete(key);
      }
    },
    async close() { sessions.clear(); },
  };

  const cipher = new WebSearchSecretCipher({ status: 'ready', key: Buffer.alloc(32, 7) });
  const connections = new WebSearchConnections({
    store: () => store, cipher, mcp, now: () => currentNow,
  });
  const runtime = new WebSearchRuntime({
    connections, mcp,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    now: () => currentNow,
  });
  const context: WebCallContext = {
    userId: 'u_a', turnId: 'turn_1', toolCallId: 'call_1',
    webDeadlineAt: performance.now() + 45_000, signal: controller.signal,
    activity: activity => { activities.push(activity); },
  };
  const signal = () => new AbortController().signal;

  const enable = async () => {
    const status = connections.status('u_a');
    await connections.settings('u_a', {
      protocolVersion: 1, expectedRevision: status.revision, enabled: true,
    }, signal());
    baseline = reads + writes;
  };

  return {
    runtime, connections, activities, context,
    async connect(providers) {
      await connections.warmOwner('u_a');
      for (const provider of providers) {
        const status = connections.status('u_a');
        await connections.connect('u_a', provider, {
          protocolVersion: 1, expectedRevision: status.revision, candidate: 'fixture-key',
        }, signal());
      }
      await enable();
    },
    async installOAuth(provider, capabilities = { browse: true, fetch: false }) {
      await connections.warmOwner('u_a');
      const status = connections.status('u_a');
      await connections.installOAuth('u_a', provider, {
        expectedRevision: status.revision, connectionId: `conn_${provider}`, credentialVersion: 1,
        credentials: {
          method: 'oauth', accessToken: 'fixture-access', refreshToken: null,
          expiresAt: new Date(currentNow.getTime() + 3_600_000).toISOString(),
          binding: {
            issuer: 'https://auth.exa.ai', resource: 'https://mcp.exa.ai/mcp/oauth',
            redirectUri: 'https://aurvin.example.com/api/plugins/web-search/providers/exa/oauth/callback',
            clientId: 'client_1', authorizationEndpoint: 'https://auth.exa.ai/authorize',
            tokenEndpoint: 'https://auth.exa.ai/token', registrationEndpoint: null, scope: 'read',
          },
        },
        capabilities, schemaDigest: 'd'.repeat(64),
        session: sessionFor(provider),
      });
      await enable();
    },
    async call(args) {
      const validated = await runtime.validateInput(args, context);
      if ('ok' in validated) return validated;
      return runtime.execute(validated, context);
    },
    validate(args) { return runtime.validateInput(args, context); },
    execute(input, override) { return runtime.execute(input, override ?? context); },
    failProvider(provider, code) { failures.set(provider, code); },
    holdProvider(provider) {
      const barrier = gate();
      holds.set(provider, barrier);
      return {
        entered: barrier.entered,
        release: () => { holds.delete(provider); barrier.release(); },
      };
    },
    dropSession(provider) { sessions.delete(`u_a\0${provider}`); },
    providerCalls() { return [...calls]; },
    maxConcurrentProviderCalls() { return maxActive; },
    storageCallsSincePrepared() { return reads + writes - baseline; },
    anyAnonymousRequest() { return false; },
    advance(ms) { currentNow = new Date(currentNow.getTime() + ms); },
    setWebDeadline(value) {
      (context as { webDeadlineAt: number }).webDeadlineAt = value;
    },
    abort() { controller.abort(); },
    async disable() {
      const status = connections.status('u_a');
      await connections.settings('u_a', {
        protocolVersion: 1, expectedRevision: status.revision, enabled: false,
      }, signal());
    },
    async disconnect(provider) {
      const status = connections.status('u_a');
      await connections.disconnect('u_a', provider, {
        protocolVersion: 1, expectedRevision: status.revision, confirm: true,
      }, signal());
    },
    lastDeadline(provider) { return deadlines.get(provider); },
    prepares() { return prepares; },
    blockStorageAndPreparation() { blocked = true; },
    storageOperations() { return blockedStorage; },
    preparationOperations() { return blockedPrepares; },
    storageReads() { return reads; },
    markInitialModelDispatch() { dispatchEvents = [...activities]; },
    eventsBeforeDispatch() { return dispatchEvents ?? []; },
  };
}

export type HttpFixture = {
  app: INestApplication;
  connections: WebSearchConnections;
  close(): Promise<void>;
  asOwner(userId: string | null): void;
};

export async function httpFixture(): Promise<HttpFixture> {
  const connection = connectionFixture();
  let currentUser: string | null = 'u_a';
  const principal = (): AuthPrincipal => {
    if (currentUser === null) throw new AuthFault('UNAUTHENTICATED');
    return webSearchPrincipal(currentUser);
  };
  const oauth: WebSearchOAuthApi = {
    async start(_principal, provider) {
      return {
        authorizationUrl: `https://auth.exa.ai/authorize?state=${'A'.repeat(43)}`,
        expiresAt: '2026-11-14T00:10:00.000Z',
        browserCookie: `${oauthCookieName(provider)}=${'B'.repeat(43)}; Path=/api/plugins/web-search/providers/${provider}/oauth; HttpOnly; SameSite=Lax; Max-Age=600; Secure`,
      };
    },
    async complete() { return 'connected'; },
    async maintainOwner() { /* fixture */ },
    invalidate() { /* fixture */ },
    async close() { /* fixture */ },
  };
  const module = await Test.createTestingModule({
    imports: [WebSearchModule.register({
      connections: () => connection.service,
      oauth: () => oauth,
      principal,
      assertNoClientOverrides: (body) => {
        if (body !== null && typeof body === 'object' && 'userId' in body) {
          throw new AppError(
            'IDENTITY_OVERRIDE_REJECTED', 'Identity overrides are not allowed.', false);
        }
      },
      frontendOrigin: 'https://aurvin.example.com',
      secureCookie: true,
    })],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>();
  app.setGlobalPrefix('api');
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/plugins/web-search')) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' && req.headers.origin !== 'https://aurvin.example.com') {
      res.status(403).json({ error: { code: 'INVALID_REQUEST', retryable: false } });
      return;
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(length) && length > 16_384) {
      res.status(413).json({ error: { code: 'INPUT_TOO_LARGE', retryable: false } });
      return;
    }
    next();
  });
  await app.init();
  return {
    app, connections: connection.service,
    async close() {
      await app.close();
      await connection.service.close();
    },
    asOwner(userId) { currentUser = userId; },
  };
}

export type PreparedFixture = {
  runtime: WebSearchRuntime;
  connections: WebSearchConnections;
  setupConnectedAccount(): Promise<void>;
  blockStorageAndPreparation(): void;
  markInitialModelDispatch(snapshot: unknown): void;
  eventsBeforeDispatch(): WebSearchActivity[];
  executeBrowse(): Promise<WebToolResult>;
  storageOperations(): number;
  preparationOperations(): number;
  storageReads(): number;
  call(args: WebToolArguments): Promise<WebToolResult>;
  providerCalls(): WebSearchProvider[];
  advance(ms: number): void;
};

export function preparedFixture(): PreparedFixture {
  const f = runtimeFixture();
  return {
    runtime: f.runtime,
    connections: f.connections,
    setupConnectedAccount: () => f.connect(['exa']),
    blockStorageAndPreparation: () => f.blockStorageAndPreparation(),
    markInitialModelDispatch: () => f.markInitialModelDispatch(),
    eventsBeforeDispatch: () => f.eventsBeforeDispatch(),
    executeBrowse: () => f.call({ mode: 'browse', query: 'example' }),
    storageOperations: () => f.storageOperations(),
    preparationOperations: () => f.preparationOperations(),
    storageReads: () => f.storageReads(),
    call: args => f.call(args),
    providerCalls: () => f.providerCalls(),
    advance: ms => f.advance(ms),
  };
}
