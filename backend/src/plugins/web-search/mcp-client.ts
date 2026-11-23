/**
 * ============================================================================
 * FILE: mcp-client.ts
 * LOCATION: backend/src/plugins/web-search/mcp-client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Own guarded Streamable HTTP MCP sessions for the five fixed providers.
 *
 * ROLE IN PROJECT:
 *    Uses the installed SDK for transport and discovery while enforcing exact
 *    endpoints, credential headers, bounded schemas, and no automatic replay.
 *
 * KEY COMPONENTS:
 *    - McpWebClient: Prepare/publish/session/invalidate/close lifecycle.
 *    - guardedFetch: Fixed endpoint, merged headers, no redirects, byte bounds.
 *    - discover/capabilities: Three-page, 100-tool, bounded-schema allowlist.
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types.js';
import { WEB_SEARCH_POLICY } from '../../contracts/web-search-policy.js';
import type { WebSearchProvider } from '../../contracts/web-search-policy.js';
import { WebSearchFault, WebToolFault } from './errors.js';
import {
  credentialHeaders, mapCall, providerDefinition, type MappedCall,
} from './providers.js';
import type { CredentialBundle, ModeCapabilities, PreparedProvider } from './types.js';

export interface PreparedMcpSession {
  call(call: MappedCall, signal: AbortSignal, deadlineAt: number): Promise<unknown>;
  close(): Promise<void>;
}
export interface WebMcpClient {
  prepare(input: { userId: string; provider: WebSearchProvider;
    connectionId: string; credentialVersion: number; credentials: CredentialBundle;
    signal: AbortSignal; deadlineAt: number; probe?: boolean }): Promise<{
      session: PreparedMcpSession; capabilities: ModeCapabilities; schemaDigest: string;
    }>;
  publish(userId: string, provider: PreparedProvider, session: PreparedMcpSession): void;
  session(provider: PreparedProvider, userId: string): PreparedMcpSession | null;
  invalidate(userId: string, provider?: WebSearchProvider): void;
  close(): Promise<void>;
}
export type McpWebClientOptions = { fetch?: typeof globalThis.fetch;
  nowMs?: () => number; now?: () => Date };

type CatalogTool = { name: string; inputSchema: Record<string, unknown> };
type SessionEntry = {
  session: PreparedMcpSession; connectionId: string; credentialVersion: number;
};

const MAX_PAGES = 3;
const MAX_TOOLS = 100;
const MAX_SCHEMA_BYTES = 16_384;
const MAX_SCHEMA_DEPTH = 12;
const KEYLESS = /keyless|anonymous|public\s+mode/i;

function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}
function isTimeout(error: unknown): boolean {
  if (statusOf(error) === -32001) return true;
  return error instanceof Error && /timeout|timed out/i.test(error.message);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export class McpWebClient implements WebMcpClient {
  private readonly baseFetch: typeof globalThis.fetch;
  private readonly nowMs: () => number;
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(options: McpWebClientOptions = {}) {
    this.baseFetch = options.fetch ?? globalThis.fetch;
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  private remaining(deadlineAt: number): number {
    return Math.max(0, Math.floor(deadlineAt - this.nowMs()));
  }

  async prepare(input: {
    userId: string; provider: WebSearchProvider; connectionId: string;
    credentialVersion: number; credentials: CredentialBundle;
    signal: AbortSignal; deadlineAt: number; probe?: boolean;
  }): Promise<{ session: PreparedMcpSession; capabilities: ModeCapabilities; schemaDigest: string }> {
    const definition = providerDefinition(input.provider);
    const endpoint = input.credentials.method === 'oauth'
      ? definition.oauthEndpoint : definition.apiKeyEndpoint;
    const headers = credentialHeaders(input.provider, input.credentials);
    if (input.signal.aborted) throw new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
    const controller = new AbortController();
    const lifecycle = controller.signal;
    const timer = setTimeout(() => controller.abort(), Math.max(1, this.remaining(input.deadlineAt)));
    timer.unref?.();
    let client: Client | null = null;
    let active: AbortController | null = null;
    let failCall: ((fault: WebToolFault) => void) | null = null;
    try {
      const guardedFetch = this.guardedFetch({
        endpoint, headers, lifecycle, active: () => active?.signal ?? null, nowMs: this.nowMs,
        fail: fault => failCall?.(fault),
      });
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        fetch: guardedFetch,
        requestInit: { headers, redirect: 'error', cache: 'no-store' },
        redirectPolicy: 'follow',
        reconnectionOptions: {
          maxRetries: 0, initialReconnectionDelay: 1,
          maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1,
        },
      });
      client = new Client({ name: 'aurvin-web-search', version: '1' }, { capabilities: {} });
      await client.connect(transport, {
        timeout: Math.max(1, Math.min(WEB_SEARCH_POLICY.mcpConnectTimeoutMs, this.remaining(input.deadlineAt))),
        signal: lifecycle,
      });
      if (!client.getServerCapabilities()?.tools) {
        throw new WebSearchFault('WEB_CAPABILITY_UNSUPPORTED');
      }
      const serverInfo = client.getServerVersion();
      // Only an explicit server-name marker is a keyless signal. Provider
      // instructions routinely describe a keyless public tier alongside the
      // authenticated tier, so matching their prose rejects valid keys.
      if (KEYLESS.test(serverInfo?.name ?? '')) {
        throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
      }
      const catalog = await this.discover(client, lifecycle, input.deadlineAt);
      const capabilities = this.capabilities(input.provider, catalog);
      if (!capabilities.browse && !capabilities.fetch) {
        throw new WebSearchFault('WEB_CAPABILITY_UNSUPPORTED');
      }
      if (input.probe && capabilities.browse) {
        await this.probe(client, input.provider, lifecycle, input.deadlineAt);
      }
      const schemaDigest = this.digest(input.provider, catalog);
      const allowed = new Set<string>();
      if (capabilities.browse) allowed.add(definition.browseTool);
      if (capabilities.fetch) allowed.add(definition.fetchTool);
      const connected = client;
      const session: PreparedMcpSession = {
        call: async (mapped, signal, deadlineAt) => {
          if (lifecycle.aborted) throw new WebToolFault('WEB_PROVIDER_UNAVAILABLE');
          if (!allowed.has(mapped.name)) throw new WebToolFault('WEB_CONNECTION_REQUIRED');
          if (signal.aborted) throw new WebToolFault('WEB_CANCELLED');
          const remaining = this.remaining(deadlineAt);
          if (remaining <= 0) throw new WebToolFault('WEB_PROVIDER_TIMEOUT');
          const callController = new AbortController();
          const abort = () => callController.abort();
          signal.addEventListener('abort', abort, { once: true });
          const callTimer = setTimeout(() => callController.abort(), remaining);
          callTimer.unref?.();
          active = callController;
          const failure = new Promise<never>((_, reject) => {
            failCall = fault => reject(fault);
          });
          try {
            return await Promise.race([
              connected.callTool(mapped, CallToolResultSchema, {
                signal: callController.signal, timeout: remaining, maxTotalTimeout: remaining,
                resetTimeoutOnProgress: false,
              }),
              failure,
            ]);
          } catch (error) {
            throw this.callFault(error, signal, lifecycle, deadlineAt);
          } finally {
            clearTimeout(callTimer);
            signal.removeEventListener('abort', abort);
            active = null;
            failCall = null;
          }
        },
        close: async () => {
          controller.abort();
          await connected.close().catch(() => undefined);
        },
      };
      clearTimeout(timer);
      return { session, capabilities, schemaDigest };
    } catch (error) {
      clearTimeout(timer);
      controller.abort();
      if (client) await client.close().catch(() => undefined);
      throw this.setupFault(error, input.signal, input.deadlineAt);
    }
  }

  publish(userId: string, provider: PreparedProvider, session: PreparedMcpSession): void {
    const key = `${userId}\0${provider.provider}`;
    const existing = this.sessions.get(key);
    if (existing) void existing.session.close();
    this.sessions.set(key, {
      session, connectionId: provider.connectionId, credentialVersion: provider.credentialVersion,
    });
  }

  session(provider: PreparedProvider, userId: string): PreparedMcpSession | null {
    const entry = this.sessions.get(`${userId}\0${provider.provider}`);
    if (!entry) return null;
    return entry.connectionId === provider.connectionId
      && entry.credentialVersion === provider.credentialVersion ? entry.session : null;
  }

  invalidate(userId: string, provider?: WebSearchProvider): void {
    for (const [key, entry] of this.sessions) {
      if (!key.startsWith(`${userId}\0`)) continue;
      if (provider !== undefined && key !== `${userId}\0${provider}`) continue;
      this.sessions.delete(key);
      void entry.session.close();
    }
  }

  async close(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(entries.map(entry => entry.session.close()));
  }

  private guardedFetch(input: {
    endpoint: string; headers: Record<string, string>; lifecycle: AbortSignal;
    active: () => AbortSignal | null; nowMs: () => number;
    fail: (fault: WebToolFault) => void;
  }): typeof globalThis.fetch {
    return async (request, init) => {
      const raw = request instanceof URL ? request.toString()
        : typeof request === 'string' ? request : request.url;
      const url = raw;
      if (url !== input.endpoint) throw new Error('endpoint not allowed');
      const signals = [input.lifecycle, init?.signal ?? undefined, input.active() ?? undefined]
        .filter((signal): signal is AbortSignal => signal !== undefined && signal !== null);
      const signal = signals.length === 0 ? undefined
        : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
      if (signal?.aborted) throw new Error('aborted');
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(input.headers)) headers.set(name, value);
      const response = await this.baseFetch(url, {
        ...init, headers, redirect: 'error', cache: 'no-store', signal,
      });
      return this.bounded(response, WEB_SEARCH_POLICY.maxMcpWireResponseBytes, signal, input.fail);
    };
  }

  private bounded(
    response: Response, cap: number, signal: AbortSignal | undefined,
    fail: (fault: WebToolFault) => void,
  ): Response {
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel();
      fail(new WebToolFault('WEB_PROVIDER_UNAVAILABLE'));
      throw new Error('redirect rejected');
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let total = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            decoder.decode();
            controller.close();
            return;
          }
          total += value.byteLength;
          if (total > cap) {
            await reader.cancel().catch(() => undefined);
            fail(new WebToolFault('WEB_PROVIDER_UNAVAILABLE'));
            controller.error(new Error('response too large'));
            return;
          }
          decoder.decode(value, { stream: true });
          controller.enqueue(value);
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          fail(new WebToolFault('WEB_PROVIDER_UNAVAILABLE'));
          controller.error(error);
        }
      },
      cancel(reason) {
        void signal;
        return reader.cancel(reason);
      },
    });
    return new Response(stream, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  }

  private async discover(
    client: Client, signal: AbortSignal, deadlineAt: number,
  ): Promise<CatalogTool[]> {
    const tools: CatalogTool[] = [];
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      if (pages >= MAX_PAGES) throw new WebSearchFault('WEB_CAPABILITY_UNSUPPORTED');
      const remaining = this.remaining(deadlineAt);
      if (remaining <= 0) throw new WebSearchFault('WEB_SETUP_TIMEOUT');
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        signal, timeout: remaining, maxTotalTimeout: remaining, resetTimeoutOnProgress: false,
      });
      pages += 1;
      for (const tool of result.tools) {
        if (tools.length >= MAX_TOOLS) throw new WebSearchFault('WEB_CAPABILITY_UNSUPPORTED');
        tools.push({ name: tool.name, inputSchema: tool.inputSchema });
      }
      if (result.nextCursor === undefined) break;
      if (result.nextCursor === cursor) throw new WebSearchFault('WEB_CAPABILITY_UNSUPPORTED');
      cursor = result.nextCursor;
    }
    return tools;
  }

  private capabilities(provider: WebSearchProvider, tools: CatalogTool[]): ModeCapabilities {
    const definition = providerDefinition(provider);
    const find = (name: string): CatalogTool | null => {
      const matches = tools.filter(tool => tool.name === name);
      return matches.length === 1 ? matches[0]! : null;
    };
    const browseTool = find(definition.browseTool);
    const fetchTool = find(definition.fetchTool);
    const browse = browseTool !== null && this.schemaAccepts(
      browseTool.inputSchema, mapCall(provider, { mode: 'browse', query: 'example' }, 12_000).arguments);
    // 'verified' admits client-guarded fetch; it does not assert provider-side redirect safety.
    const fetch = fetchTool !== null && definition.fetchSafety === 'verified' && this.schemaAccepts(
      fetchTool.inputSchema, mapCall(provider, { mode: 'fetch', url: 'https://example.com/' }, 12_000).arguments);
    return { browse, fetch };
  }

  private schemaAccepts(schema: unknown, args: unknown): boolean {
    if (schema === null || typeof schema !== 'object') return false;
    if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_SCHEMA_BYTES) return false;
    try {
      this.assertBoundedSchema(schema, 0);
    } catch {
      return false;
    }
    try {
      const validator = new AjvJsonSchemaValidator().getValidator(schema as JsonSchemaType);
      return validator(args).valid;
    } catch {
      return false;
    }
  }

  private assertBoundedSchema(value: unknown, depth: number): void {
    if (depth > MAX_SCHEMA_DEPTH) throw new Error('schema depth');
    if (Array.isArray(value)) {
      for (const item of value) this.assertBoundedSchema(item, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === '$ref') throw new Error('remote reference');
        this.assertBoundedSchema(child, depth + 1);
      }
    }
  }

  private digest(provider: WebSearchProvider, tools: CatalogTool[]): string {
    const definition = providerDefinition(provider);
    const selected = [definition.browseTool, definition.fetchTool].map(name => {
      const tool = tools.find(candidate => candidate.name === name);
      return tool === undefined ? null : { name, inputSchema: canonical(tool.inputSchema) };
    });
    return createHash('sha256').update(JSON.stringify(selected), 'utf8').digest('hex');
  }

  private async probe(
    client: Client, provider: WebSearchProvider, signal: AbortSignal, deadlineAt: number,
  ): Promise<void> {
    const remaining = this.remaining(deadlineAt);
    if (remaining <= 0) throw new WebSearchFault('WEB_SETUP_TIMEOUT');
    const mapped = mapCall(provider, { mode: 'browse', query: 'example.com' }, remaining);
    const result = await client.callTool(mapped, CallToolResultSchema, {
      signal, timeout: remaining, maxTotalTimeout: remaining, resetTimeoutOnProgress: false,
    });
    if (result.isError) throw new WebSearchFault('WEB_INVALID_KEY');
  }

  private setupFault(error: unknown, caller: AbortSignal, deadlineAt: number): WebSearchFault {
    if (error instanceof WebSearchFault) return error;
    if (caller.aborted) return new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
    const status = statusOf(error);
    if (status === 401 || status === 403) return new WebSearchFault('WEB_INVALID_KEY');
    if (status === 402) return new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
    if (status === 429) return new WebSearchFault('WEB_RATE_LIMITED');
    if (status === 404) return new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
    if (this.nowMs() >= deadlineAt || isTimeout(error)) return new WebSearchFault('WEB_SETUP_TIMEOUT');
    return new WebSearchFault('WEB_PROVIDER_UNAVAILABLE');
  }

  private callFault(
    error: unknown, caller: AbortSignal, lifecycle: AbortSignal, deadlineAt: number,
  ): WebToolFault {
    if (error instanceof WebToolFault) return error;
    if (caller.aborted) return new WebToolFault('WEB_CANCELLED');
    if (lifecycle.aborted && this.nowMs() < deadlineAt) {
      return new WebToolFault('WEB_PROVIDER_UNAVAILABLE');
    }
    const status = statusOf(error);
    if (status === 401 || status === 403) return new WebToolFault('WEB_PROVIDER_AUTH');
    if (status === 402) return new WebToolFault('WEB_PROVIDER_CREDITS');
    if (status === 429) return new WebToolFault('WEB_PROVIDER_RATE_LIMITED');
    if (status === 404) return new WebToolFault('WEB_PROVIDER_UNAVAILABLE');
    if (this.nowMs() >= deadlineAt || isTimeout(error)) return new WebToolFault('WEB_PROVIDER_TIMEOUT');
    return new WebToolFault('WEB_PROVIDER_UNAVAILABLE');
  }
}
