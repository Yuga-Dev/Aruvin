/**
 * ============================================================================
 * FILE: web-search-client.ts
 * LOCATION: frontend/src/api/web-search-client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Bounded, no-store HTTP client for Web Search plugin setup and OAuth flows.
 *
 * ROLE IN PROJECT:
 *    Sends validated non-secret mutations and write-only key submissions to
 *    backend routes without storing keys or echoing provider responses.
 *
 * KEY COMPONENTS:
 *    - WebSearchClient / createWebSearchClient: Status, settings, connect/disconnect, OAuth.
 *    - WebSearchClientError: Closed safe error surface mapping HTTP error codes.
 * ============================================================================
 */

import {
  WEB_SEARCH_ROUTES,
  isWebSearchConnectRequest,
  isWebSearchDisconnectRequest,
  isWebSearchHttpError,
  isWebSearchOAuthCompleteRequest,
  isWebSearchOAuthCompleteResponse,
  isWebSearchOAuthStartRequest,
  isWebSearchOAuthStartResponse,
  isWebSearchProvider,
  isWebSearchPublicStatus,
  isWebSearchSettingsRequest,
  type WebSearchConnectRequest,
  type WebSearchDisconnectRequest,
  type WebSearchHttpErrorCode,
  type WebSearchOAuthCompleteRequest,
  type WebSearchOAuthCompleteResponse,
  type WebSearchOAuthStartRequest,
  type WebSearchOAuthStartResponse,
  type WebSearchProvider,
  type WebSearchPublicStatus,
  type WebSearchSettingsRequest,
} from './web-search-protocol.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 65_536;
const SAFE_MESSAGE = 'Web search request could not be completed.';

export type WebSearchClientErrorCode =
  | WebSearchHttpErrorCode
  | 'NETWORK_ERROR'
  | 'ABORTED'
  | 'INVALID_WEB_RESPONSE'
  | 'WEB_HTTP_ERROR';

export class WebSearchClientError extends Error {
  readonly code: WebSearchClientErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly currentRevision: number | null;
  readonly uncertain: boolean;

  constructor(options: {
    code: WebSearchClientErrorCode;
    status?: number;
    retryable?: boolean;
    currentRevision?: number | null;
    uncertain?: boolean;
  }) {
    super(SAFE_MESSAGE);
    this.name = 'WebSearchClientError';
    this.code = options.code;
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.currentRevision = options.currentRevision ?? null;
    this.uncertain = options.uncertain ?? false;
  }
}

export type WebSearchClient = {
  status(signal?: AbortSignal): Promise<WebSearchPublicStatus>;
  setEnabled(request: WebSearchSettingsRequest, signal?: AbortSignal): Promise<WebSearchPublicStatus>;
  connectProvider(
    provider: WebSearchProvider,
    request: WebSearchConnectRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchPublicStatus>;
  disconnectProvider(
    provider: WebSearchProvider,
    request: WebSearchDisconnectRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchPublicStatus>;
  startOAuth(
    provider: WebSearchProvider,
    request: WebSearchOAuthStartRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchOAuthStartResponse>;
  completeOAuth(
    provider: WebSearchProvider,
    request: WebSearchOAuthCompleteRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchOAuthCompleteResponse>;
};

function readViteApiBase(): string | undefined {
  try {
    const env = import.meta.env as { VITE_API_BASE?: string } | undefined;
    return env?.VITE_API_BASE;
  } catch {
    return undefined;
  }
}

function invalidRequest(): never {
  throw new WebSearchClientError({ code: 'WEB_INVALID_REQUEST' });
}

function invalidResponse(status = 0): never {
  throw new WebSearchClientError({ code: 'INVALID_WEB_RESPONSE', status });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) invalidResponse(response.status);
    return text ? (JSON.parse(text) as unknown) : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          void reader.cancel();
          invalidResponse(response.status);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return text ? (JSON.parse(text) as unknown) : null;
}

export function createWebSearchClient(
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): WebSearchClient {
  const baseUrl = (options.baseUrl ?? readViteApiBase() ?? '/api').replace(/\/+$/, '');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    guard: (value: unknown) => value is T,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    const bounded = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const response = await fetcher(`${baseUrl}${path}`, {
        method,
        signal: bounded,
        cache: 'no-store',
        redirect: 'error',
        credentials: 'same-origin',
        headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const parsed = await readBoundedJson(response).catch((err: unknown) => {
        if (err instanceof WebSearchClientError) throw err;
        if (response.ok) invalidResponse(response.status);
        return null;
      });

      if (!response.ok) {
        if (isWebSearchHttpError(parsed)) {
          throw new WebSearchClientError({
            code: parsed.error.code,
            status: response.status,
            retryable: parsed.error.retryable,
            currentRevision: parsed.error.currentRevision,
            uncertain: parsed.error.code === 'WEB_WRITE_UNCERTAIN',
          });
        }
        throw new WebSearchClientError({
          code: 'WEB_HTTP_ERROR',
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      if (!guard(parsed)) invalidResponse(response.status);
      return parsed;
    } catch (error) {
      if (error instanceof WebSearchClientError) throw error;
      if (signal?.aborted) throw new WebSearchClientError({ code: 'ABORTED' });
      if (timeout.signal.aborted) {
        throw new WebSearchClientError({ code: 'WEB_SETUP_TIMEOUT', retryable: true });
      }
      throw new WebSearchClientError({ code: 'NETWORK_ERROR', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async status(signal) {
      return request(WEB_SEARCH_ROUTES.status, 'GET', isWebSearchPublicStatus, undefined, signal);
    },
    async setEnabled(body, signal) {
      if (!isWebSearchSettingsRequest(body)) invalidRequest();
      return request(WEB_SEARCH_ROUTES.settings, 'PATCH', isWebSearchPublicStatus, body, signal);
    },
    async connectProvider(provider, body, signal) {
      if (!isWebSearchProvider(provider) || !isWebSearchConnectRequest(body)) invalidRequest();
      return request(WEB_SEARCH_ROUTES.connect(provider), 'POST', isWebSearchPublicStatus, body, signal);
    },
    async disconnectProvider(provider, body, signal) {
      if (!isWebSearchProvider(provider) || !isWebSearchDisconnectRequest(body)) invalidRequest();
      return request(WEB_SEARCH_ROUTES.disconnect(provider), 'POST', isWebSearchPublicStatus, body, signal);
    },
    async startOAuth(provider, body, signal) {
      if (!isWebSearchProvider(provider) || !isWebSearchOAuthStartRequest(body)) invalidRequest();
      return request(
        WEB_SEARCH_ROUTES.oauthStart(provider),
        'POST',
        isWebSearchOAuthStartResponse,
        body,
        signal,
      );
    },
    async completeOAuth(provider, body, signal) {
      if (!isWebSearchProvider(provider) || !isWebSearchOAuthCompleteRequest(body)) invalidRequest();
      return request(
        WEB_SEARCH_ROUTES.oauthComplete(provider),
        'POST',
        isWebSearchOAuthCompleteResponse,
        body,
        signal,
      );
    },
  };
}
