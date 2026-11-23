/**
 * ============================================================================
 * FILE: connection.ts
 * LOCATION: backend/src/plugins/web-search/connection.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Own per-account prepared web-search authority and control-plane CAS writes.
 *
 * ROLE IN PROJECT:
 *    Keeps one bounded in-memory account snapshot, fences permission changes
 *    synchronously, and publishes credentials only after a confirmed save.
 *
 * KEY COMPONENTS:
 *    - WebSearchConnections: Warm, status, settings, connect, disconnect, evict.
 *    - Prepared authority: Decrypted credentials plus provider generations.
 *    - Permission fences: Disable/disconnect/evict abort in-flight reads.
 * ============================================================================
 */

import { randomUUID } from 'node:crypto';
import { AppError } from '../../platform/errors/app-error.js';
import type { WebSearchSecretCipher } from '../../platform/crypto/web-search-secret-cipher.js';
import { WEB_SEARCH_POLICY, WEB_SEARCH_PROVIDERS } from '../../contracts/web-search-policy.js';
import type { WebSearchMode, WebSearchProvider } from '../../contracts/web-search-policy.js';
import {
  webSearchConnectRequestSchema, webSearchDisconnectRequestSchema,
  webSearchPublicStatusSchema, webSearchSettingsRequestSchema,
  type WebSearchConnectionState, type WebSearchPublicProvider, type WebSearchPublicStatus,
} from '../../contracts/web-search-wire.js';
import { WebSearchFault } from './errors.js';
import type { WebMcpClient, PreparedMcpSession } from './mcp-client.js';
import {
  credentialBundleSchema, oauthBindingSchema, storedWebAccountSchema,
  type CredentialBundle, type ModeCapabilities, type PreparedProvider,
  type PreparedWebAccount, type SecretBinding, type StoredWebAccount,
  type StoredWebConnection, type WebAccountCas, type WebSearchConnectionsApi,
  type WebSearchStore,
} from './types.js';

export type WebSearchConnectionsOptions = {
  store: () => WebSearchStore | null; cipher: WebSearchSecretCipher; mcp: WebMcpClient;
  now?: () => Date; nowMs?: () => number;
};

type ConfirmedConnection = {
  stored: StoredWebConnection;
  credentials: CredentialBundle | null;
  capabilities: ModeCapabilities;
  authMethod: 'api-key' | 'oauth';
  lastValidatedAt: string;
  capabilitiesExpireAt: string;
  state: 'connected' | 'reconnect-required';
};
type TransientView = {
  state: WebSearchConnectionState; authMethod: 'api-key' | 'oauth' | null;
  capabilities: ModeCapabilities; lastValidatedAt: string | null;
};
type ApiKeyCheck = { pending: boolean; retryAt: number; rejected: boolean };
type OwnerEntry = {
  userId: string;
  generation: number;
  denied: boolean;
  prepared: boolean;
  revision: number;
  enabled: boolean;
  connections: Map<WebSearchProvider, ConfirmedConnection>;
  providers: Map<WebSearchProvider, PreparedProvider>;
  providerGenerations: Map<WebSearchProvider, number>;
  controllers: Map<WebSearchProvider, AbortController>;
  inFlight: Set<AbortController>;
  transient: Map<WebSearchProvider, TransientView>;
  oauthSupport: Map<WebSearchProvider, 'supported' | 'unverified'>;
  warming: Promise<void> | null;
  maintenanceRequested: boolean;
};

const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1_000;
const CAPABILITY_RENEW_BEFORE_MS = 5 * 60_000;
const API_KEY_RETRY_MS = 60_000;
const MAX_SETUP_JOBS = 2;
let setupSlots = 0;
export function acquireSetupSlot(): void {
  if (setupSlots >= MAX_SETUP_JOBS) throw new WebSearchFault('WEB_RATE_LIMITED');
  setupSlots += 1;
}
export function releaseSetupSlot(): void {
  setupSlots = Math.max(0, setupSlots - 1);
}
const DEFAULT_CAPABILITIES: ModeCapabilities = { browse: false, fetch: false };

function bindingFor(
  userId: string, provider: WebSearchProvider, stored: StoredWebConnection,
): SecretBinding {
  return {
    userId, provider, connectionId: stored.connectionId,
    credentialVersion: stored.credentialVersion, tokenKind: 'credential-bundle',
  };
}

export class WebSearchConnections implements WebSearchConnectionsApi {
  private readonly entries = new Map<string, OwnerEntry>();
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly tombstones = new Map<string, number>();
  // Keyed by ConfirmedConnection identity, not provider name alone: replacement
  // or account reload must drop stale observations.
  private readonly apiKeyChecks = new WeakMap<ConfirmedConnection, ApiKeyCheck>();
  private maintenance: ((userId: string, signal: AbortSignal) => Promise<void>) | null = null;
  private readonly store: () => WebSearchStore | null;
  private readonly cipher: WebSearchSecretCipher;
  private readonly mcp: WebMcpClient;
  private readonly now: () => Date;
  private readonly nowMs: () => number;

  constructor(options: WebSearchConnectionsOptions) {
    this.store = options.store;
    this.cipher = options.cipher;
    this.mcp = options.mcp;
    this.now = options.now ?? (() => new Date());
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  setMaintenance(run: (userId: string, signal: AbortSignal) => Promise<void>): void {
    this.maintenance = run;
  }

  requestMaintenance(userId: string): void {
    const entry = this.entries.get(userId);
    if (entry) entry.maintenanceRequested = true;
  }

  private owner(userId: string): OwnerEntry {
    const existing = this.entries.get(userId);
    if (existing) return existing;
    const entry: OwnerEntry = {
      userId, generation: 0, denied: false, prepared: false, revision: 0, enabled: false,
      connections: new Map(), providers: new Map(), providerGenerations: new Map(),
      controllers: new Map(), inFlight: new Set(), transient: new Map(), oauthSupport: new Map(),
      warming: null, maintenanceRequested: false,
    };
    this.entries.set(userId, entry);
    return entry;
  }

  isPrepared(userId: string): boolean {
    return this.entries.get(userId)?.prepared === true;
  }

  isEnabled(userId: string): boolean {
    const entry = this.entries.get(userId);
    return entry?.prepared === true && entry.enabled && !entry.denied;
  }

  lifecycleEpoch(userId: string): number {
    return (this.entries.get(userId)?.generation ?? 0) + (this.tombstones.get(userId) ?? 0);
  }

  async warmOwner(userId: string): Promise<void> {
    const entry = this.owner(userId);
    if (entry.prepared) return;
    if (entry.warming) return entry.warming;
    const generation = entry.generation;
    entry.warming = (async () => {
      try {
        const store = this.store();
        if (!store) throw new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
        let loaded: StoredWebAccount | null;
        try {
          loaded = await store.readAccount(userId);
        } catch {
          throw new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
        }
        if (this.entries.get(userId) !== entry || entry.generation !== generation) return;
        if (loaded === null) {
          entry.revision = 0;
          entry.prepared = true;
          return;
        }
        const parsed = storedWebAccountSchema.safeParse(loaded);
        if (!parsed.success) throw new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
        entry.revision = parsed.data.revision;
        entry.enabled = parsed.data.enabled;
        for (const provider of Object.keys(parsed.data.connections) as WebSearchProvider[]) {
          const stored = parsed.data.connections[provider];
          if (!stored) continue;
          const credentials = this.openCredentials(userId, provider, stored);
          if (credentials === null) {
            entry.connections.set(provider, {
              stored, credentials: null, capabilities: stored.capabilities,
              authMethod: stored.authMethod, lastValidatedAt: stored.lastValidatedAt,
              capabilitiesExpireAt: stored.capabilitiesExpireAt, state: 'reconnect-required',
            });
            continue;
          }
          entry.connections.set(provider, {
            stored, credentials, capabilities: stored.capabilities,
            authMethod: stored.authMethod, lastValidatedAt: stored.lastValidatedAt,
            capabilitiesExpireAt: stored.capabilitiesExpireAt, state: stored.state,
          });
          if (stored.state === 'connected') {
            const generation = (entry.providerGenerations.get(provider) ?? 0) + 1;
            entry.providerGenerations.set(provider, generation);
            entry.providers.set(provider, {
              provider, connectionId: stored.connectionId,
              credentialVersion: stored.credentialVersion, generation,
              capabilities: stored.capabilities, credentials,
              capabilitiesExpireAt: Date.parse(stored.capabilitiesExpireAt),
              lastValidatedAt: stored.lastValidatedAt,
            });
          }
        }
        entry.prepared = true;
      } finally {
        entry.warming = null;
      }
    })();
    return entry.warming;
  }

  /**
   * Restore and renew live MCP sessions for connected API-key providers. OAuth
   * providers are refreshed and reopened by WebSearchOAuth maintenance. This is
   * the control-plane path used after a process restart, when enabling web
   * search, and by the periodic sweep, so the next chat turn can advertise
   * web_tool immediately. Expiry of Aurvin's validation cache is not evidence
   * that a saved key expired: an authenticated discovery check renews it
   * without writing a new account revision.
   */
  async prepareApiKeySessions(userId: string, signal: AbortSignal): Promise<void> {
    const entry = await this.requirePrepared(userId);
    for (const provider of WEB_SEARCH_PROVIDERS) {
      if (signal.aborted) return;
      const connection = entry.connections.get(provider);
      if (!connection || connection.state !== 'connected'
        || connection.credentials?.method !== 'api-key') continue;
      const now = this.now().getTime();
      const check = this.apiKeyChecks.get(connection);
      if (check?.pending || check?.rejected || (check !== undefined && check.retryAt > now)) continue;
      const current = entry.providers.get(provider);
      if (current && current.capabilitiesExpireAt > now + CAPABILITY_RENEW_BEFORE_MS
        && this.mcp.session(current, userId) !== null) continue;
      const ownerGeneration = entry.generation;
      const providerGeneration = entry.providerGenerations.get(provider) ?? 0;
      const providerController = entry.controllers.get(provider);
      const observation: ApiKeyCheck = { pending: true, retryAt: 0, rejected: false };
      this.apiKeyChecks.set(connection, observation);
      const controller = new AbortController();
      entry.inFlight.add(controller);
      const combined = AbortSignal.any([
        signal, controller.signal, ...(providerController ? [providerController.signal] : []),
      ]);
      let slotHeld = false;
      let candidate: PreparedMcpSession | null = null;
      let published = false;
      try {
        try {
          acquireSetupSlot();
          slotHeld = true;
        } catch {
          observation.pending = false;
          observation.retryAt = now + API_KEY_RETRY_MS;
          continue;
        }
        const prepared = await this.mcp.prepare({
          userId, provider, connectionId: connection.stored.connectionId,
          credentialVersion: connection.stored.credentialVersion,
          credentials: connection.credentials, signal: combined,
          deadlineAt: this.nowMs() + WEB_SEARCH_POLICY.providerCallTimeoutMs,
          probe: false,
        });
        candidate = prepared.session;
        const currentProvider = entry.providers.get(provider);
        const lost = this.entries.get(userId) !== entry || entry.generation !== ownerGeneration
          || entry.denied || combined.aborted
          || entry.connections.get(provider) !== connection
          || (entry.providerGenerations.get(provider) ?? 0) !== providerGeneration;
        if (lost) {
          await candidate.close().catch(() => undefined);
          candidate = null;
          if (!observation.rejected && this.apiKeyChecks.get(connection) === observation) {
            this.apiKeyChecks.delete(connection);
          }
          continue;
        }
        const at = this.now();
        const lastValidatedAt = at.toISOString();
        const capabilitiesExpireAt = at.getTime() + CAPABILITY_TTL_MS;
        connection.capabilities = prepared.capabilities;
        connection.lastValidatedAt = lastValidatedAt;
        connection.capabilitiesExpireAt = new Date(capabilitiesExpireAt).toISOString();
        if (currentProvider && currentProvider.capabilitiesExpireAt > at.getTime()
          && this.mcp.session(currentProvider, userId) !== null) {
          // Proactive renewal keeps the working session: replacing it would
          // close a retrieval already in flight. Refresh only lease metadata.
          entry.providers.set(provider, {
            ...currentProvider, capabilities: prepared.capabilities,
            capabilitiesExpireAt, lastValidatedAt,
          });
          await candidate.close().catch(() => undefined);
          candidate = null;
        } else {
          const nextGeneration = providerGeneration + 1;
          entry.providerGenerations.set(provider, nextGeneration);
          const preparedProvider: PreparedProvider = {
            provider, connectionId: connection.stored.connectionId,
            credentialVersion: connection.stored.credentialVersion,
            generation: nextGeneration,
            capabilities: prepared.capabilities, credentials: connection.credentials,
            capabilitiesExpireAt, lastValidatedAt,
          };
          entry.providers.set(provider, preparedProvider);
          entry.controllers.get(provider)?.abort();
          entry.controllers.set(provider, new AbortController());
          this.mcp.publish(userId, preparedProvider, candidate);
          published = true;
          candidate = null;
        }
        if (!observation.rejected) this.apiKeyChecks.delete(connection);
      } catch (error) {
        if (candidate && !published) await candidate.close().catch(() => undefined);
        const lost = this.entries.get(userId) !== entry || entry.generation !== ownerGeneration
          || entry.denied || entry.connections.get(provider) !== connection
          || (entry.providerGenerations.get(provider) ?? 0) !== providerGeneration;
        if (lost) {
          if (!observation.rejected && this.apiKeyChecks.get(connection) === observation) {
            this.apiKeyChecks.delete(connection);
          }
          continue;
        }
        observation.pending = false;
        if (error instanceof WebSearchFault && error.code === 'WEB_INVALID_KEY') {
          observation.rejected = true;
          this.fenceProvider(entry, provider);
        } else if (!combined.aborted) {
          observation.retryAt = this.now().getTime() + API_KEY_RETRY_MS;
        } else if (!observation.rejected) {
          this.apiKeyChecks.delete(connection);
        }
      } finally {
        if (slotHeld) releaseSetupSlot();
        entry.inFlight.delete(controller);
      }
    }
  }

  private openCredentials(
    userId: string, provider: WebSearchProvider, stored: StoredWebConnection,
  ): CredentialBundle | null {
    try {
      const plaintext = this.cipher.open(bindingFor(userId, provider, stored), stored.secret);
      const parsed = credentialBundleSchema.safeParse(JSON.parse(plaintext));
      if (!parsed.success || parsed.data.method !== stored.authMethod) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  status(userId: string): WebSearchPublicStatus {
    const entry = this.entries.get(userId);
    if (!entry || !entry.prepared) return this.defaultStatus();
    const providers = WEB_SEARCH_PROVIDERS.map(provider => this.publicProvider(entry, provider));
    const enabled = entry.enabled;
    return webSearchPublicStatusSchema.parse({
      protocolVersion: 1, revision: entry.revision, enabled,
      effectiveEnabled: enabled && providers.some(provider => provider.state === 'connected'),
      providers,
    });
  }

  private defaultStatus(): WebSearchPublicStatus {
    return webSearchPublicStatusSchema.parse({
      protocolVersion: 1, revision: 0, enabled: false, effectiveEnabled: false,
      providers: WEB_SEARCH_PROVIDERS.map(provider => this.notConnected(provider)),
    });
  }

  private notConnected(provider: WebSearchProvider): WebSearchPublicProvider {
    return {
      provider, state: 'not-connected', authMethod: null,
      authSupport: {
        apiKey: 'supported',
        browserAuthorization: 'unverified',
      },
      capabilities: { ...DEFAULT_CAPABILITIES }, lastValidatedAt: null,
    };
  }

  private publicProvider(entry: OwnerEntry, provider: WebSearchProvider): WebSearchPublicProvider {
    const authSupport = {
      apiKey: 'supported' as const,
      browserAuthorization: entry.oauthSupport.get(provider) ?? 'unverified' as const,
    };
    const transient = entry.transient.get(provider);
    if (transient) {
      return {
        provider, state: transient.state, authMethod: transient.authMethod,
        authSupport, capabilities: { ...transient.capabilities },
        lastValidatedAt: transient.lastValidatedAt,
      };
    }
    const connection = entry.connections.get(provider);
    if (!connection) return { ...this.notConnected(provider), authSupport };
    const rejected = this.apiKeyChecks.get(connection)?.rejected === true;
    if (entry.enabled) {
      const live = entry.providers.get(provider);
      const usable = live !== undefined && this.isCurrent(entry.userId, live)
        && live.capabilitiesExpireAt > this.now().getTime()
        && this.mcp.session(live, entry.userId) !== null;
      if (usable) {
        return {
          provider, state: 'connected', authMethod: connection.authMethod, authSupport,
          capabilities: { ...live.capabilities }, lastValidatedAt: live.lastValidatedAt,
        };
      }
      const state: WebSearchConnectionState = rejected ? 'invalid-key'
        : connection.state === 'reconnect-required' ? 'reconnect-required' : 'unavailable';
      return {
        provider, state, authMethod: connection.authMethod, authSupport,
        capabilities: { ...connection.capabilities }, lastValidatedAt: connection.lastValidatedAt,
      };
    }
    // Off-account rows stay actionable; effectiveEnabled is false regardless.
    const state: WebSearchConnectionState = rejected ? 'invalid-key' : connection.state;
    return {
      provider, state, authMethod: connection.authMethod, authSupport,
      capabilities: { ...connection.capabilities }, lastValidatedAt: connection.lastValidatedAt,
    };
  }

  snapshot(userId: string): PreparedWebAccount {
    const entry = this.entries.get(userId);
    if (!entry || !entry.prepared) {
      return {
        userId, revision: 0, generation: 0, enabled: false, prepared: false, providers: [],
      };
    }
    const providers: Array<{ provider: WebSearchProvider; capabilities: ModeCapabilities }> = [];
    for (const provider of WEB_SEARCH_PROVIDERS) {
      const current = entry.providers.get(provider);
      if (!current || !this.isCurrent(userId, current)) continue;
      if (current.capabilitiesExpireAt <= this.now().getTime()) continue;
      if (current.credentials.method === 'oauth'
        && Date.parse(current.credentials.expiresAt) <= this.now().getTime()) continue;
      if (this.mcp.session(current, userId) === null) continue;
      providers.push({ provider, capabilities: current.capabilities });
    }
    const credentialsRejected = this.allCredentialsRejected(userId);
    return {
      userId, revision: entry.revision, generation: entry.generation,
      enabled: entry.enabled, prepared: true, providers,
      ...(credentialsRejected ? { credentialsRejected: true } : {}),
    };
  }

  currentEligibleProvider(
    userId: string, provider: WebSearchProvider, mode: WebSearchMode,
  ): PreparedProvider | null {
    const entry = this.entries.get(userId);
    if (!entry || !entry.prepared || entry.denied || !entry.enabled) return null;
    const current = entry.providers.get(provider);
    if (!current || !this.isCurrent(userId, current)) return null;
    if (!current.capabilities[mode]) return null;
    if (current.capabilitiesExpireAt <= this.now().getTime()) return null;
    if (current.credentials.method === 'oauth'
      && Date.parse(current.credentials.expiresAt) <= this.now().getTime()) return null;
    return current;
  }

  hasEligibleProvider(userId: string, mode: WebSearchMode): boolean {
    return WEB_SEARCH_PROVIDERS.some(provider =>
      this.currentEligibleProvider(userId, provider, mode) !== null);
  }

  isCurrent(userId: string, provider: PreparedProvider): boolean {
    const entry = this.entries.get(userId);
    if (!entry || entry.denied) return false;
    const current = entry.providers.get(provider.provider);
    return current !== undefined && current.connectionId === provider.connectionId
      && current.credentialVersion === provider.credentialVersion
      && current.generation === provider.generation;
  }

  /**
   * A provider-confirmed authentication rejection makes this credential
   * version unusable until replacement or account reload. Only the exact
   * current binding can be fenced, and only for an enabled API-key account.
   */
  rejectApiKey(userId: string, current: PreparedProvider): void {
    const entry = this.entries.get(userId);
    if (!entry || !entry.prepared || entry.denied || !entry.enabled) return;
    if (!this.isCurrent(userId, current)) return;
    const connection = entry.connections.get(current.provider);
    if (!connection || connection.credentials?.method !== 'api-key'
      || connection.stored.connectionId !== current.connectionId
      || connection.stored.credentialVersion !== current.credentialVersion) return;
    const check = this.apiKeyChecks.get(connection)
      ?? { pending: false, retryAt: 0, rejected: false };
    check.pending = false;
    check.rejected = true;
    this.apiKeyChecks.set(connection, check);
    this.fenceProvider(entry, current.provider);
  }

  /**
   * True only when every saved connection able to serve `mode` is confirmed
   * rejected and needs user action. Missing sessions, expired leases, and OAuth
   * tokens still eligible for refresh are not confirmed rejections.
   */
  allCredentialsRejected(userId: string, mode?: WebSearchMode): boolean {
    const entry = this.entries.get(userId);
    if (!entry || !entry.prepared || entry.denied || !entry.enabled) return false;
    let candidates = 0;
    for (const connection of entry.connections.values()) {
      if (mode !== undefined && !connection.capabilities[mode]) continue;
      candidates += 1;
      if (!this.credentialRejected(connection)) return false;
    }
    return candidates > 0;
  }

  private credentialRejected(connection: ConfirmedConnection): boolean {
    if (connection.authMethod === 'oauth') {
      return connection.state === 'reconnect-required'
        || connection.stored.oauthRefresh === 'reconnect-required';
    }
    return this.apiKeyChecks.get(connection)?.rejected === true;
  }

  callSignal(userId: string, provider: PreparedProvider): AbortSignal {
    const entry = this.entries.get(userId);
    if (!entry || entry.denied) return AbortSignal.abort();
    const controller = entry.controllers.get(provider.provider);
    return controller?.signal ?? AbortSignal.abort();
  }

  async settings(userId: string, raw: unknown, signal: AbortSignal): Promise<WebSearchPublicStatus> {
    const body = webSearchSettingsRequestSchema.parse(raw);
    if (signal.aborted) throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
    return this.withMutation(userId, async () => {
      const entry = await this.requirePrepared(userId);
      if (body.expectedRevision !== entry.revision) {
        throw new WebSearchFault('WEB_SETTINGS_CONFLICT', entry.revision);
      }
      if (body.enabled) {
        if (!this.hasConnected(entry)) throw new WebSearchFault('WEB_CONNECTION_REQUIRED');
        const next = this.nextAccount(entry, this.storedConnections(entry), true);
        await this.save(entry, body.expectedRevision, next);
        entry.enabled = true;
        entry.denied = false;
        entry.revision = next.revision;
        return this.status(userId);
      }
      this.fenceAll(entry);
      entry.enabled = false;
      entry.denied = true;
      const next = this.nextAccount(entry, this.storedConnections(entry), false);
      await this.save(entry, body.expectedRevision, next);
      entry.revision = next.revision;
      return this.status(userId);
    });
  }

  async connect(
    userId: string, provider: WebSearchProvider, raw: unknown, signal: AbortSignal,
  ): Promise<WebSearchPublicStatus> {
    const body = webSearchConnectRequestSchema.parse(raw);
    if (signal.aborted) throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
    acquireSetupSlot();
    try {
      return await this.withMutation(userId, async () => {
        const entry = await this.requirePrepared(userId);
        if (body.expectedRevision !== entry.revision) {
          throw new WebSearchFault('WEB_SETTINGS_CONFLICT', entry.revision);
        }
        const old = entry.connections.get(provider);
        entry.denied = false;
        if (!old) {
          entry.transient.set(provider, {
            state: 'connecting', authMethod: null, capabilities: DEFAULT_CAPABILITIES,
            lastValidatedAt: null,
          });
        }
        const generation = entry.generation;
        const connectionId = randomUUID();
        const credentialVersion = (old?.stored.credentialVersion ?? 0) + 1;
        const controller = new AbortController();
        entry.inFlight.add(controller);
        const combined = AbortSignal.any([signal, controller.signal]);
        let candidate: PreparedMcpSession | null = null;
        let published = false;
        try {
          const prepared = await this.mcp.prepare({
            userId, provider, connectionId, credentialVersion,
            credentials: { method: 'api-key', apiKey: body.candidate },
            signal: combined,
            deadlineAt: this.nowMs() + WEB_SEARCH_POLICY.providerCallTimeoutMs,
            probe: true,
          });
          candidate = prepared.session;
          if (this.entries.get(userId) !== entry || entry.generation !== generation) {
            throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
          }
          const at = this.now();
          const lastValidatedAt = at.toISOString();
          const capabilitiesExpireAt = new Date(at.getTime() + CAPABILITY_TTL_MS).toISOString();
          const credentials: CredentialBundle = { method: 'api-key', apiKey: body.candidate };
          const stored: StoredWebConnection = {
            connectionId, credentialVersion, authMethod: 'api-key',
            secret: this.cipher.seal({
              userId, provider, connectionId, credentialVersion,
              tokenKind: 'credential-bundle',
            }, JSON.stringify(credentials)),
            capabilities: prepared.capabilities, schemaDigest: prepared.schemaDigest,
            lastValidatedAt, capabilitiesExpireAt, state: 'connected', oauthRefresh: 'idle',
          };
          const next = this.nextAccount(
            entry, this.storedConnections(entry, { [provider]: stored }), entry.enabled);
          await this.save(entry, body.expectedRevision, next);
          if (this.entries.get(userId) !== entry || entry.generation !== generation) {
            throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
          }
          const providerGeneration = (entry.providerGenerations.get(provider) ?? 0) + 1;
          entry.providerGenerations.set(provider, providerGeneration);
          const preparedProvider: PreparedProvider = {
            provider, connectionId, credentialVersion, generation: providerGeneration,
            capabilities: prepared.capabilities, credentials,
            capabilitiesExpireAt: Date.parse(capabilitiesExpireAt), lastValidatedAt,
          };
          entry.connections.set(provider, {
            stored, credentials, capabilities: prepared.capabilities, authMethod: 'api-key',
            lastValidatedAt, capabilitiesExpireAt, state: 'connected',
          });
          entry.providers.set(provider, preparedProvider);
          entry.controllers.get(provider)?.abort();
          entry.controllers.set(provider, new AbortController());
          entry.revision = next.revision;
          entry.denied = false;
          entry.transient.delete(provider);
          this.mcp.publish(userId, preparedProvider, prepared.session);
          published = true;
          return this.status(userId);
        } catch (error) {
          if (candidate && !published) await candidate.close().catch(() => undefined);
          if (old) entry.transient.delete(provider);
          else entry.transient.set(provider, this.transientFor(error));
          throw this.setupFault(error);
        } finally {
          entry.inFlight.delete(controller);
        }
      });
    } finally {
      releaseSetupSlot();
    }
  }

  credentialVersionFor(userId: string, provider: WebSearchProvider): number {
    return (this.entries.get(userId)?.connections.get(provider)?.stored.credentialVersion ?? 0) + 1;
  }

  preparedProvider(userId: string, provider: WebSearchProvider): PreparedProvider | null {
    const entry = this.entries.get(userId);
    const current = entry?.providers.get(provider);
    return current && this.isCurrent(userId, current) ? current : null;
  }

  preparedOwners(): string[] {
    return [...this.entries.values()].filter(entry => entry.prepared).map(entry => entry.userId);
  }

  oauthConnection(userId: string, provider: WebSearchProvider): {
    revision: number; connectionId: string; credentialVersion: number;
    credentials: Extract<CredentialBundle, { method: 'oauth' }>;
    binding: ReturnType<typeof oauthBindingSchema.parse>;
    oauthRefresh: StoredWebConnection['oauthRefresh'];
    capabilities: ModeCapabilities; schemaDigest: string;
    lastValidatedAt: string; capabilitiesExpireAt: string;
  } | null {
    const entry = this.entries.get(userId);
    const connection = entry?.connections.get(provider);
    if (!entry || !connection || connection.credentials?.method !== 'oauth') return null;
    return {
      revision: entry.revision,
      connectionId: connection.stored.connectionId,
      credentialVersion: connection.stored.credentialVersion,
      credentials: connection.credentials,
      binding: connection.credentials.binding,
      oauthRefresh: connection.stored.oauthRefresh,
      capabilities: connection.capabilities,
      schemaDigest: connection.stored.schemaDigest,
      lastValidatedAt: connection.lastValidatedAt,
      capabilitiesExpireAt: connection.capabilitiesExpireAt,
    };
  }

  async updateOAuthRefresh(userId: string, provider: WebSearchProvider, input: {
    expectedRevision: number;
    oauthRefresh: StoredWebConnection['oauthRefresh'];
    state?: StoredWebConnection['state'];
    credentials?: Extract<CredentialBundle, { method: 'oauth' }>;
    capabilities?: ModeCapabilities;
    schemaDigest?: string;
    lastValidatedAt?: string;
    capabilitiesExpireAt?: string;
    session?: PreparedMcpSession;
  }): Promise<number> {
    return this.withMutation(userId, async () => {
      const entry = await this.requirePrepared(userId);
      if (input.expectedRevision !== entry.revision) {
        await input.session?.close().catch(() => undefined);
        throw new WebSearchFault('WEB_SETTINGS_CONFLICT', entry.revision);
      }
      const current = entry.connections.get(provider);
      if (!current || current.credentials?.method !== 'oauth') {
        await input.session?.close().catch(() => undefined);
        throw new WebSearchFault('WEB_CONNECTION_REQUIRED');
      }
      const generation = entry.generation;
      const credentials = input.credentials ?? current.credentials;
      const capabilities = input.capabilities ?? current.capabilities;
      const lastValidatedAt = input.lastValidatedAt ?? current.lastValidatedAt;
      const capabilitiesExpireAt = input.capabilitiesExpireAt ?? current.capabilitiesExpireAt;
      const state = input.state ?? current.state;
      const credentialVersion = input.credentials
        ? current.stored.credentialVersion + 1 : current.stored.credentialVersion;
      let stored: StoredWebConnection;
      try {
        stored = {
          ...current.stored,
          credentialVersion,
          secret: input.credentials
            ? this.cipher.seal({
              userId, provider, connectionId: current.stored.connectionId,
              credentialVersion, tokenKind: 'credential-bundle',
            }, JSON.stringify(input.credentials))
            : current.stored.secret,
          capabilities, schemaDigest: input.schemaDigest ?? current.stored.schemaDigest,
          lastValidatedAt, capabilitiesExpireAt, state, oauthRefresh: input.oauthRefresh,
        };
      } catch (error) {
        await input.session?.close().catch(() => undefined);
        throw this.setupFault(error);
      }
      const next = this.nextAccount(
        entry, this.storedConnections(entry, { [provider]: stored }), entry.enabled);
      try {
        await this.save(entry, input.expectedRevision, next);
      } catch (error) {
        await input.session?.close().catch(() => undefined);
        throw error;
      }
      if (this.entries.get(userId) !== entry || entry.generation !== generation) {
        await input.session?.close().catch(() => undefined);
        throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
      }
      entry.connections.set(provider, {
        stored, credentials, capabilities, authMethod: 'oauth',
        lastValidatedAt, capabilitiesExpireAt, state,
      });
      if (state === 'reconnect-required') {
        entry.providers.delete(provider);
        entry.controllers.get(provider)?.abort();
        entry.controllers.delete(provider);
        this.mcp.invalidate(userId, provider);
      } else if (input.session) {
        const providerGeneration = (entry.providerGenerations.get(provider) ?? 0) + 1;
        entry.providerGenerations.set(provider, providerGeneration);
        const preparedProvider: PreparedProvider = {
          provider, connectionId: stored.connectionId, credentialVersion,
          generation: providerGeneration, capabilities, credentials,
          capabilitiesExpireAt: Date.parse(capabilitiesExpireAt), lastValidatedAt,
        };
        entry.providers.set(provider, preparedProvider);
        entry.controllers.get(provider)?.abort();
        entry.controllers.set(provider, new AbortController());
        this.mcp.publish(userId, preparedProvider, input.session);
      }
      entry.revision = next.revision;
      return next.revision;
    });
  }

  async installOAuth(userId: string, provider: WebSearchProvider, input: {
    expectedRevision: number;
    connectionId: string;
    credentialVersion: number;
    credentials: Extract<CredentialBundle, { method: 'oauth' }>;
    capabilities: ModeCapabilities;
    schemaDigest: string;
    session: PreparedMcpSession;
  }): Promise<WebSearchPublicStatus> {
    return this.withMutation(userId, async () => {
      const entry = await this.requirePrepared(userId);
      if (input.expectedRevision !== entry.revision) {
        await input.session.close().catch(() => undefined);
        throw new WebSearchFault('WEB_SETTINGS_CONFLICT', entry.revision);
      }
      const generation = entry.generation;
      entry.denied = false;
      const at = this.now();
      const lastValidatedAt = at.toISOString();
      const capabilitiesExpireAt = new Date(at.getTime() + CAPABILITY_TTL_MS).toISOString();
      let stored: StoredWebConnection;
      try {
        stored = {
          connectionId: input.connectionId, credentialVersion: input.credentialVersion,
          authMethod: 'oauth',
          secret: this.cipher.seal({
            userId, provider, connectionId: input.connectionId,
            credentialVersion: input.credentialVersion, tokenKind: 'credential-bundle',
          }, JSON.stringify(input.credentials)),
          capabilities: input.capabilities, schemaDigest: input.schemaDigest,
          lastValidatedAt, capabilitiesExpireAt, state: 'connected', oauthRefresh: 'idle',
        };
      } catch (error) {
        await input.session.close().catch(() => undefined);
        throw this.setupFault(error);
      }
      const next = this.nextAccount(
        entry, this.storedConnections(entry, { [provider]: stored }), entry.enabled);
      try {
        await this.save(entry, input.expectedRevision, next);
      } catch (error) {
        await input.session.close().catch(() => undefined);
        throw error;
      }
      if (this.entries.get(userId) !== entry || entry.generation !== generation) {
        await input.session.close().catch(() => undefined);
        throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
      }
      const providerGeneration = (entry.providerGenerations.get(provider) ?? 0) + 1;
      entry.providerGenerations.set(provider, providerGeneration);
      const preparedProvider: PreparedProvider = {
        provider, connectionId: input.connectionId,
        credentialVersion: input.credentialVersion, generation: providerGeneration,
        capabilities: input.capabilities, credentials: input.credentials,
        capabilitiesExpireAt: Date.parse(capabilitiesExpireAt), lastValidatedAt,
      };
      entry.connections.set(provider, {
        stored, credentials: input.credentials, capabilities: input.capabilities,
        authMethod: 'oauth', lastValidatedAt, capabilitiesExpireAt, state: 'connected',
      });
      entry.providers.set(provider, preparedProvider);
      entry.controllers.get(provider)?.abort();
      entry.controllers.set(provider, new AbortController());
      entry.revision = next.revision;
      entry.transient.delete(provider);
      entry.oauthSupport.set(provider, 'supported');
      this.mcp.publish(userId, preparedProvider, input.session);
      return this.status(userId);
    });
  }

  async disconnect(
    userId: string, provider: WebSearchProvider, raw: unknown, signal: AbortSignal,
  ): Promise<WebSearchPublicStatus> {
    const body = webSearchDisconnectRequestSchema.parse(raw);
    if (signal.aborted) throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
    return this.withMutation(userId, async () => {
      const entry = await this.requirePrepared(userId);
      if (body.expectedRevision !== entry.revision) {
        throw new WebSearchFault('WEB_SETTINGS_CONFLICT', entry.revision);
      }
      const old = entry.connections.get(provider);
      if (!old) throw new WebSearchFault('WEB_CONNECTION_REQUIRED');
      const remaining = [...entry.connections.keys()].filter(item => item !== provider);
      const last = remaining.length === 0;
      this.fenceProvider(entry, provider);
      if (last) {
        this.fenceAll(entry);
        entry.enabled = false;
        entry.denied = true;
      }
      const next = this.nextAccount(
        entry, this.storedConnections(entry, { [provider]: null }), last ? false : entry.enabled);
      await this.save(entry, body.expectedRevision, next);
      entry.connections.delete(provider);
      entry.transient.delete(provider);
      entry.revision = next.revision;
      return this.status(userId);
    });
  }

  evict(userId: string): void {
    const entry = this.entries.get(userId);
    if (!entry) return;
    entry.generation += 1;
    entry.denied = true;
    this.fenceAll(entry);
    entry.connections.clear();
    entry.providers.clear();
    entry.transient.clear();
    this.entries.delete(userId);
    this.tombstones.set(userId, (this.tombstones.get(userId) ?? 0) + 1);
    this.mcp.invalidate(userId);
  }

  async close(): Promise<void> {
    for (const entry of this.entries.values()) this.fenceAll(entry);
    this.entries.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.mcp.close(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); timer.unref?.(); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  private fenceProvider(entry: OwnerEntry, provider: WebSearchProvider): void {
    entry.providerGenerations.set(provider, (entry.providerGenerations.get(provider) ?? 0) + 1);
    entry.controllers.get(provider)?.abort();
    entry.controllers.delete(provider);
    entry.providers.delete(provider);
    this.mcp.invalidate(entry.userId, provider);
  }

  private fenceAll(entry: OwnerEntry): void {
    entry.generation += 1;
    for (const controller of entry.controllers.values()) controller.abort();
    entry.controllers.clear();
    entry.providers.clear();
    this.mcp.invalidate(entry.userId);
  }

  private async requirePrepared(userId: string): Promise<OwnerEntry> {
    await this.warmOwner(userId);
    const entry = this.entries.get(userId);
    if (!entry || !entry.prepared) throw new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
    return entry;
  }

  private async withMutation<T>(userId: string, run: () => Promise<T>): Promise<T> {
    if (this.mutations.has(userId)) throw new WebSearchFault('WEB_RATE_LIMITED');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.mutations.set(userId, gate);
    try {
      return await run();
    } finally {
      this.mutations.delete(userId);
      release();
    }
  }

  private hasConnected(entry: OwnerEntry): boolean {
    for (const connection of entry.connections.values()) {
      if (connection.state !== 'connected') continue;
      if (!connection.capabilities.browse && !connection.capabilities.fetch) continue;
      if (this.apiKeyChecks.get(connection)?.rejected === true) continue;
      return true;
    }
    return false;
  }

  private storedConnections(
    entry: OwnerEntry,
    overrides: Partial<Record<WebSearchProvider, StoredWebConnection | null>> = {},
  ): Partial<Record<WebSearchProvider, StoredWebConnection>> {
    const result: Partial<Record<WebSearchProvider, StoredWebConnection>> = {};
    for (const provider of Object.keys(overrides) as WebSearchProvider[]) {
      if (overrides[provider] === null) continue;
      const value = overrides[provider];
      if (value) result[provider] = value;
    }
    for (const [provider, connection] of entry.connections) {
      if (Object.hasOwn(overrides, provider)) continue;
      result[provider] = connection.stored;
    }
    return result;
  }

  private nextAccount(
    entry: OwnerEntry,
    connections: Partial<Record<WebSearchProvider, StoredWebConnection>>,
    enabled: boolean,
  ): StoredWebAccount {
    if (entry.revision >= Number.MAX_SAFE_INTEGER - 1) {
      throw new WebSearchFault('WEB_SETTINGS_CONFLICT', entry.revision);
    }
    return {
      kind: 'account', schemaVersion: 1, userId: entry.userId,
      revision: entry.revision + 1, enabled, updatedAt: this.now().toISOString(), connections,
    };
  }

  private async save(
    entry: OwnerEntry, expectedRevision: number, next: StoredWebAccount,
  ): Promise<WebAccountCas> {
    const store = this.store();
    if (!store) throw new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
    let result: WebAccountCas;
    try {
      result = await store.saveAccount(expectedRevision, next);
    } catch (error) {
      if (error instanceof WebSearchFault) throw error;
      if (error instanceof AppError) throw new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
      throw new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
    }
    if (result.outcome === 'conflict') {
      throw new WebSearchFault('WEB_SETTINGS_CONFLICT', result.currentRevision);
    }
    if (result.outcome === 'uncertain') throw new WebSearchFault('WEB_WRITE_UNCERTAIN');
    return result;
  }

  private setupFault(error: unknown): WebSearchFault {
    if (error instanceof WebSearchFault) return error;
    if (error instanceof AppError) return new WebSearchFault('WEB_STORAGE_UNAVAILABLE');
    return new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
  }

  private transientFor(error: unknown): TransientView {
    const code = error instanceof WebSearchFault ? error.code : 'WEB_PROVIDER_UNAVAILABLE';
    const state: WebSearchConnectionState = code === 'WEB_INVALID_KEY' ? 'invalid-key'
      : code === 'WEB_AUTH_UNSUPPORTED' || code === 'WEB_CAPABILITY_UNSUPPORTED' ? 'unsupported'
        : 'unavailable';
    return {
      state, authMethod: null, capabilities: DEFAULT_CAPABILITIES, lastValidatedAt: null,
    };
  }
}
