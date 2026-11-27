/**
 * ============================================================================
 * FILE: client.ts
 * LOCATION: frontend/src/api/client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Browser HTTP wrapper and SSE stream reader for Aurvin chat endpoints.
 *
 * ROLE IN PROJECT:
 *    Isolates fetch, query pagination, contract validation, error mapping, and
 *    stream framing so UI state can consume P1 protocol types without knowing
 *    transport details. P9 wires this client; P6 implements the server routes.
 *
 * KEY COMPONENTS:
 *    - ApiClientError: Structured client-safe failure with retryability.
 *    - ApiClient: Session, message, turn, retry, cancel, and stream methods.
 * ============================================================================
 */

import {
  parseCalendarCompatibleFrame,
  type CalendarCompatibleEnvelope,
  type CalendarStreamEvent,
  type CalendarStreamEventV3,
} from './calendar-protocol.ts';
import { withClientTimeZoneHeader } from './client-timezone.ts';
import {
  API_ROUTES,
  assertNoClientOverrides,
  isCompactionCheckpointMeta,
  isEditTurnRequest,
  isRegenerateTurnRequest,
  isContextUsageMeta,
  isFeedbackResponse,
  isRetryTurnRequest,
  isSubmitTurnRequest,
  isSubmitTurnResponse,
  isSearchSessionsResponse,
  isVisibleMessageList,
  type EditTurnRequest,
  type FeedbackRating,
  type FeedbackResponse,
  type ListMessagesResponse,
  type RegenerateTurnRequest,
  type SearchSessionsResponse,
  type ListSessionsResponse,
  type RetryTurnRequest,
  type SessionSummary,
  type SubmitTurnRequest,
  type SubmitTurnResponse,
  type TurnStatusResponse,
} from './protocol.ts';

function notImplemented(what: string): ApiClientError {
  return new ApiClientError('NOT_IMPLEMENTED', `${what} is not available yet.`, 0, false);
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export type ApiClientConfig = {
  baseUrl?: string;
  fetch?: typeof fetch;
  recoveryStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
};

export type StreamHandlers = {
  onEnvelope?: (envelope: CalendarCompatibleEnvelope) => void;
  onEvent?: (
    event: CalendarStreamEvent | CalendarStreamEventV3,
    envelope: CalendarCompatibleEnvelope,
  ) => void;
  onComplete?: (outcome: 'completed' | 'truncated') => void;
  onError?: (error: ApiClientError) => void;
  signal?: AbortSignal;
};

export type StreamOptions = {
  signal?: AbortSignal;
};

function readViteApiBase(): string | undefined {
  try {
    const env = import.meta.env as { VITE_API_BASE?: string } | undefined;
    return env?.VITE_API_BASE;
  } catch {
    return undefined;
  }
}

export type PendingRetryRecovery = {
  sessionId: string;
  turnId: string;
  request: RetryTurnRequest;
};

function isBoundedClientId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}

function isPreAdmissionError(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  if (error.status >= 400 && error.status < 500 && error.code !== 'INTERRUPTED') {
    return true;
  }
  return (
    error.code === 'NOT_READY' ||
    error.code === 'CONFIGURATION_ERROR' ||
    error.code === 'UNSUPPORTED_TOPOLOGY'
  );
}

function isPendingRetryRecovery(value: unknown): value is PendingRetryRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  return (
    keys.length === 3 &&
    keys.includes('sessionId') &&
    keys.includes('turnId') &&
    keys.includes('request') &&
    isBoundedClientId(v.sessionId) &&
    isBoundedClientId(v.turnId) &&
    isRetryTurnRequest(v.request)
  );
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly recoveryStorage: ApiClientConfig['recoveryStorage'];
  private readonly recoveryKey: string;
  private pendingSubmission: SubmitTurnRequest | null = null;
  private pendingRetry: PendingRetryRecovery | null = null;
  private processEpoch: string | undefined;

  constructor(config: ApiClientConfig = {}) {
    const envBase = config.baseUrl ?? readViteApiBase() ?? '/api';
    this.baseUrl = envBase.replace(/\/+$/, '');
    this.fetcher = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.recoveryKey = `aurvin:submission:v1:${this.baseUrl}`;
    let browserStorage: Storage | null = null;
    try { if (typeof window !== 'undefined') browserStorage = window.sessionStorage; } catch { /* Storage may be disabled. */ }
    this.recoveryStorage = config.recoveryStorage === undefined ? browserStorage : config.recoveryStorage;
    try {
      const raw = this.recoveryStorage?.getItem(this.recoveryKey);
      if (raw && raw.length <= 200_000) {
        const value: unknown = JSON.parse(raw);
        if (value && typeof value === 'object' && !Array.isArray(value) && 'pending' in value && 'epoch' in value) {
          const rec = value as Record<string, unknown>;
          const keysValid = Object.keys(rec).every((k) => k === 'pending' || k === 'retry' || k === 'epoch');
          const pendingValid = rec.pending === null || isSubmitTurnRequest(rec.pending);
          const retryVal = 'retry' in rec ? rec.retry : null;
          const retryValid = retryVal === null || isPendingRetryRecovery(retryVal);
          const epochValid = rec.epoch === null || isBoundedClientId(rec.epoch);
          if (keysValid && pendingValid && retryValid && epochValid && !(rec.pending && retryVal)) {
            this.pendingSubmission = rec.pending as SubmitTurnRequest | null;
            this.pendingRetry = retryVal as PendingRetryRecovery | null;
            if (typeof rec.epoch === 'string') this.processEpoch = rec.epoch;
          }
        }
      }
    } catch { /* Browser recovery is a best-effort display aid. */ }
  }

  get submissionRecovery(): SubmitTurnRequest | null {
    return this.pendingSubmission ? structuredClone(this.pendingSubmission) : null;
  }
  get retryRecovery(): PendingRetryRecovery | null {
    return this.pendingRetry ? structuredClone(this.pendingRetry) : null;
  }
  discardSubmissionRecovery(): void {
    this.pendingSubmission = null; this.pendingRetry = null; this.processEpoch = undefined; this.persistRecovery();
  }
  clearPendingRecovery(): void {
    this.pendingSubmission = null; this.pendingRetry = null; this.persistRecovery();
  }
  clearSubmissionRecovery(): void {
    try {
      this.recoveryStorage?.removeItem(this.recoveryKey);
    } catch {
      // Storage unavailable.
    }
  }
  private persistRecovery(): void {
    try {
      this.recoveryStorage?.setItem(this.recoveryKey, JSON.stringify({
        pending: this.pendingSubmission?.ephemeral ? null : this.pendingSubmission,
        ...(this.pendingRetry ? { retry: this.pendingRetry } : {}),
        epoch: this.processEpoch ?? null,
      }));
    } catch { /* Keep the same request in this client even when browser storage fails. */ }
  }

  private buildUrl(
    path: string,
    params?: Record<string, string | number | null | undefined>,
  ): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${cleanPath}`;
    if (!params) {
      return url;
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) {
        query.set(key, String(value));
      }
    }
    const queryString = query.toString();
    return queryString ? `${url}?${queryString}` : url;
  }

  private resolveUrl(
    path: string,
    params?: Record<string, string | number | null | undefined>,
  ): string {
    if (/^https?:\/\//.test(path) || (this.baseUrl && path.startsWith(`${this.baseUrl}/`)) || path === this.baseUrl) {
      return path;
    }
    return this.buildUrl(path, params);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    params?: Record<string, string | number | null | undefined>,
    parseAs: 'json' | 'blob' = 'json',
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(this.resolveUrl(path, params), {
        ...init,
        cache: init.cache ?? 'no-store',
        credentials: 'same-origin',
      });
    } catch (networkErr: unknown) {
      if (networkErr instanceof Error && networkErr.name === 'AbortError') {
        throw new ApiClientError('ABORTED', 'Request was cancelled', 0, false);
      }
      throw new ApiClientError(
        'NETWORK_ERROR',
        networkErr instanceof Error ? networkErr.message : 'Network request failed',
        0,
        true,
      );
    }

    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      let message = response.statusText || `Request failed with status ${response.status}`;
      let retryable = response.status >= 500 || response.status === 429;

      try {
        const errorJson: unknown = await response.json();
        if (typeof errorJson === 'object' && errorJson !== null) {
          const body = errorJson as Record<string, unknown>;
          if (typeof body.code === 'string') {
            code = body.code;
          }
          if (typeof body.message === 'string') {
            message = body.message;
          }
          if (typeof body.retryable === 'boolean') {
            retryable = body.retryable;
          }
        }
      } catch {
        // Fall back to HTTP status info
      }

      throw new ApiClientError(code, message, response.status, retryable);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (parseAs === 'blob' ? await response.blob() : await response.json()) as T;
  }

  async listSessions(options?: {
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ListSessionsResponse> {
    return this.request<ListSessionsResponse>(
      API_ROUTES.sessions,
      { method: 'GET', signal: options?.signal },
      {
        cursor: options?.cursor,
        limit: options?.limit,
      },
    );
  }

  async getSession(sessionId: string): Promise<SessionSummary> {
    return this.request<SessionSummary>(API_ROUTES.session(sessionId), { method: 'GET' });
  }

  async updateSession(sessionId: string, changes: { title?: string; pinned?: boolean }): Promise<SessionSummary> {
    return this.request<SessionSummary>(API_ROUTES.session(sessionId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
    });
  }

  async deleteSession(sessionId: string, options?: { keepalive?: boolean }): Promise<void> {
    return this.request<void>(API_ROUTES.session(sessionId), {
      method: 'DELETE',
      ...(options?.keepalive ? { keepalive: true } : {}),
    });
  }

  async listMessages(
    sessionId: string,
    options?: { cursor?: string | null; limit?: number },
  ): Promise<ListMessagesResponse> {
    const res = await this.request<ListMessagesResponse>(
      API_ROUTES.messages(sessionId),
      { method: 'GET' },
      {
        cursor: options?.cursor,
        limit: options?.limit,
      },
    );
    if (
      ('compaction' in res && res.compaction !== undefined && !isCompactionCheckpointMeta(res.compaction)) ||
      ('contextUsage' in res && res.contextUsage !== undefined && !isContextUsageMeta(res.contextUsage)) ||
      (res.canvasMessages !== undefined && !isVisibleMessageList(res.canvasMessages))
    ) {
      throw new ApiClientError('INVALID_RESPONSE', 'Invalid context metadata received.', 200, false);
    }
    return res;
  }

  async submitTurn(request: SubmitTurnRequest, options?: { signal?: AbortSignal }): Promise<SubmitTurnResponse> {
    assertNoClientOverrides(request);
    if (!isSubmitTurnRequest(request)) {
      throw new ApiClientError('INVALID_REQUEST', 'Request does not match SubmitTurnRequest contract', 400, false);
    }

    if (this.pendingRetry) {
      throw new ApiClientError('SUBMISSION_PENDING', 'An earlier retry has unknown delivery. Retry it or explicitly start a new attempt.', 0, false);
    }
    const pending = this.pendingSubmission;
    const autoAttachedEpoch = !pending && !request.expectedEpoch && Boolean(this.processEpoch);
    if (pending) {
      if (pending.sessionId !== request.sessionId || pending.content !== request.content ||
        (pending.ephemeral === true) !== (request.ephemeral === true) ||
        pending.calendarProtocol !== request.calendarProtocol || JSON.stringify(pending.calendarReplyTo) !== JSON.stringify(request.calendarReplyTo) ||
        (pending.task === true) !== (request.task === true))
        throw new ApiClientError('SUBMISSION_PENDING', 'An earlier submission has unknown delivery. Retry it or explicitly start a new attempt.', 0, false);
      if (!pending.expectedEpoch)
        throw new ApiClientError('SUBMISSION_UNKNOWN', 'The earlier submission outcome is unknown. A new attempt may generate and charge again.', 0, false);
      request = pending;
    } else if (autoAttachedEpoch) {
      request = { ...request, expectedEpoch: this.processEpoch };
    }
    this.pendingSubmission = structuredClone(request); this.persistRecovery();
    const path = request.sessionId ? API_ROUTES.turns(request.sessionId) : API_ROUTES.sessions;
    try {
      const response = await this.request<SubmitTurnResponse>(path, {
      method: 'POST',
      headers: withClientTimeZoneHeader({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(request),
      signal: options?.signal,
      });
      if (!isSubmitTurnResponse(response)) throw new ApiClientError('INVALID_RESPONSE', 'Submission outcome could not be confirmed.', 0, false);
      this.processEpoch = response.processEpoch ?? this.processEpoch;
      this.pendingSubmission = null; this.persistRecovery();
      return response;
    } catch (error) {
      if (autoAttachedEpoch && error instanceof ApiClientError && error.code === 'INTERRUPTED') {
        this.processEpoch = undefined;
        this.pendingSubmission = null;
        this.persistRecovery();
        const { expectedEpoch: _stale, ...freshRequest } = request;
        return this.submitTurn(freshRequest, options);
      }
      if (isPreAdmissionError(error)) {
        this.pendingSubmission = null; this.persistRecovery();
      }
      throw error;
    }
  }

  async retryTurn(
    sessionId: string,
    turnId: string,
    request: RetryTurnRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SubmitTurnResponse> {
    assertNoClientOverrides(request);
    if (!isBoundedClientId(sessionId) || !isBoundedClientId(turnId) || !isRetryTurnRequest(request)) {
      throw new ApiClientError('INVALID_REQUEST', 'Request does not match RetryTurnRequest contract', 400, false);
    }
    if (this.pendingSubmission) {
      throw new ApiClientError('SUBMISSION_PENDING', 'An earlier submission has unknown delivery. Retry it or explicitly start a new attempt.', 0, false);
    }
    const pending = this.pendingRetry;
    const autoAttachedEpoch = !pending && !request.expectedEpoch && Boolean(this.processEpoch);
    if (pending) {
      if (
        pending.sessionId !== sessionId ||
        pending.turnId !== turnId ||
        pending.request.calendarProtocol !== request.calendarProtocol
      ) {
        throw new ApiClientError('SUBMISSION_PENDING', 'An earlier retry has unknown delivery. Retry it or explicitly start a new attempt.', 0, false);
      }
      if (!pending.request.expectedEpoch) {
        throw new ApiClientError('SUBMISSION_UNKNOWN', 'The earlier retry outcome is unknown. A new attempt may generate and charge again.', 0, false);
      }
      request = pending.request;
    } else if (autoAttachedEpoch) {
      request = { ...request, expectedEpoch: this.processEpoch };
    }
    this.pendingRetry = { sessionId, turnId, request: structuredClone(request) };
    this.persistRecovery();
    try {
      const response = await this.request<SubmitTurnResponse>(API_ROUTES.retryTurn(sessionId, turnId), {
        method: 'POST',
        headers: withClientTimeZoneHeader({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(request),
        signal: options?.signal,
      });
      if (!isSubmitTurnResponse(response)) {
        throw new ApiClientError('INVALID_RESPONSE', 'Retry outcome could not be confirmed.', 0, false);
      }
      this.processEpoch = response.processEpoch ?? this.processEpoch;
      this.pendingRetry = null;
      this.persistRecovery();
      return response;
    } catch (error) {
      if (autoAttachedEpoch && error instanceof ApiClientError && error.code === 'INTERRUPTED') {
        this.processEpoch = undefined;
        this.pendingRetry = null;
        this.persistRecovery();
        const { expectedEpoch: _stale, ...freshRequest } = request;
        return this.retryTurn(sessionId, turnId, freshRequest, options);
      }
      if (isPreAdmissionError(error)) {
        this.pendingRetry = null;
        this.persistRecovery();
      }
      throw error;
    }
  }

  async cancelTurn(sessionId: string, turnId: string, attemptId: string): Promise<void> {
    return this.request<void>(API_ROUTES.cancelTurn(sessionId, turnId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId }),
    });
  }

  /** Skip a not-yet-started step of the running task. The server resolves identity; the body names only the attempt. */
  async skipTaskStep(sessionId: string, turnId: string, stepId: string, attemptId: string): Promise<void> {
    return this.request<void>(API_ROUTES.skipTaskStep(sessionId, turnId, stepId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId }),
    });
  }

  // Release 1 stubs (unit 0): bodies belong to units A (search), B (edit/regenerate) and C (feedback/export).
  // They fail closed so nothing can appear to work before its feature flag and backend exist.
  async searchSessions(query: string, options?: { cursor?: string | null; limit?: number; signal?: AbortSignal }): Promise<SearchSessionsResponse> {
    const response = await this.request<unknown>(API_ROUTES.searchSessions, { method: 'GET', signal: options?.signal },
      { q: query, cursor: options?.cursor, limit: options?.limit });
    if (!isSearchSessionsResponse(response)) throw new ApiClientError('INVALID_RESPONSE', 'Search results could not be read.', 200, false);
    return response;
  }

  async editTurn(sessionId: string, turnId: string, request: EditTurnRequest, options?: { signal?: AbortSignal }): Promise<SubmitTurnResponse> {
    assertNoClientOverrides(request);
    if (!isBoundedClientId(sessionId) || !isBoundedClientId(turnId) || !isEditTurnRequest(request)) {
      throw new ApiClientError('INVALID_REQUEST', 'Request does not match EditTurnRequest contract', 400, false);
    }
    return this.revise(API_ROUTES.editTurn(sessionId, turnId), request, options);
  }

  async regenerateTurn(sessionId: string, turnId: string, request: RegenerateTurnRequest, options?: { signal?: AbortSignal }): Promise<SubmitTurnResponse> {
    assertNoClientOverrides(request);
    if (!isBoundedClientId(sessionId) || !isBoundedClientId(turnId) || !isRegenerateTurnRequest(request)) {
      throw new ApiClientError('INVALID_REQUEST', 'Request does not match RegenerateTurnRequest contract', 400, false);
    }
    return this.revise(API_ROUTES.regenerateTurn(sessionId, turnId), request, options);
  }

  // ponytail: edit/regenerate do not persist ambiguous-delivery recovery the way retry does; an unknown outcome
  // surfaces as an error and the next click uses a new key. Upgrade path: reuse the pendingRetry record.
  private async revise(path: string, request: EditTurnRequest | RegenerateTurnRequest, options?: { signal?: AbortSignal }): Promise<SubmitTurnResponse> {
    if (this.pendingSubmission) {
      throw new ApiClientError('SUBMISSION_PENDING', 'An earlier submission has unknown delivery. Retry it or explicitly start a new attempt.', 0, false);
    }
    const body = request.expectedEpoch || !this.processEpoch ? request : { ...request, expectedEpoch: this.processEpoch };
    const response = await this.request<SubmitTurnResponse>(path, {
      method: 'POST',
      headers: withClientTimeZoneHeader({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!isSubmitTurnResponse(response)) {
      throw new ApiClientError('INVALID_RESPONSE', 'The outcome could not be confirmed.', 0, false);
    }
    this.processEpoch = response.processEpoch ?? this.processEpoch;
    return response;
  }

  async putFeedback(sessionId: string, messageId: string, rating: FeedbackRating | null): Promise<FeedbackResponse> {
    if (!isBoundedClientId(sessionId) || !isBoundedClientId(messageId)) {
      throw new ApiClientError('INVALID_REQUEST', 'Invalid feedback target.', 400, false);
    }
    const response = await this.request<unknown>(API_ROUTES.messageFeedback(sessionId, messageId), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating }),
    });
    if (!isFeedbackResponse(response)) {
      throw new ApiClientError('INVALID_RESPONSE', 'Feedback outcome could not be confirmed.', 0, false);
    }
    return response;
  }

  async exportSession(sessionId: string): Promise<Blob> {
    if (!isBoundedClientId(sessionId)) throw new ApiClientError('INVALID_REQUEST', 'Invalid chat.', 400, false);
    return this.request<Blob>(API_ROUTES.exportSession(sessionId), { method: 'GET' }, undefined, 'blob');
  }

  async getTurnStatus(sessionId: string, turnId: string): Promise<TurnStatusResponse> {
    return this.request<TurnStatusResponse>(API_ROUTES.turnStatus(sessionId, turnId), { method: 'GET' });
  }

  async retrySave(sessionId: string, turnId: string, expected: { epoch: string; version: number }): Promise<TurnStatusResponse> {
    return this.request<TurnStatusResponse>(API_ROUTES.retrySave(sessionId, turnId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(expected),
    });
  }

  async connectTurnStream(
    streamPath: string,
    handlers: StreamHandlers,
    options?: StreamOptions,
  ): Promise<void> {
    const fullUrl = this.resolveUrl(streamPath);
    const signal = options?.signal ?? handlers.signal;

    let response: Response;
    try {
      response = await this.fetcher(fullUrl, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'text/event-stream' },
        signal,
      });
    } catch (err: unknown) {
      if (signal?.aborted) {
        return;
      }
      const apiErr = new ApiClientError(
        'STREAM_CONNECT_FAILED',
        err instanceof Error ? err.message : 'Failed to connect SSE stream',
        0,
        true,
      );
      handlers.onError?.(apiErr);
      return;
    }

    if (!response.ok) {
      const apiErr = new ApiClientError(
        `HTTP_${response.status}`,
        `Stream connection rejected with status ${response.status}`,
        response.status,
        response.status >= 500,
      );
      handlers.onError?.(apiErr);
      return;
    }

    if (!response.body) {
      const apiErr = new ApiClientError('NO_STREAM_BODY', 'Response body is empty', response.status, false);
      handlers.onError?.(apiErr);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let terminalReceived = false;

    const cancelReader = () => {
      void reader.cancel().catch(() => undefined);
    };

    if (signal) {
      if (signal.aborted) {
        cancelReader();
        return;
      }
      signal.addEventListener('abort', cancelReader, { once: true });
    }

    try {
      while (true) {
        if (signal?.aborted) {
          cancelReader();
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) {
            continue;
          }

          if (trimmed.startsWith('data:')) {
            let envelope: CalendarCompatibleEnvelope;
            try {
              envelope = parseCalendarCompatibleFrame(trimmed);
            } catch (parseErr) {
              const apiErr = new ApiClientError(
                'INVALID_STREAM_ENVELOPE',
                parseErr instanceof Error ? parseErr.message : 'Invalid envelope received',
                200,
                false,
              );
              handlers.onError?.(apiErr);
              continue;
            }

            handlers.onEnvelope?.(envelope);
            handlers.onEvent?.(envelope.event, envelope);

            if (envelope.event.type === 'completed') {
              terminalReceived = true;
              handlers.onComplete?.(envelope.event.outcome);
            } else if (envelope.event.type === 'error') {
              terminalReceived = true;
              const apiErr = new ApiClientError(
                envelope.event.code,
                envelope.event.message,
                200,
                envelope.event.retryable,
              );
              handlers.onError?.(apiErr);
            }
          }
        }
      }

      if (!terminalReceived && !signal?.aborted) {
        const apiErr = new ApiClientError(
          'STREAM_INTERRUPTED',
          'Stream terminated prematurely before terminal completed event',
          200,
          true,
        );
        handlers.onError?.(apiErr);
      }
    } catch (readErr: unknown) {
      if (signal?.aborted) {
        return;
      }
      const apiErr = new ApiClientError(
        'STREAM_READ_ERROR',
        readErr instanceof Error ? readErr.message : 'Error while reading stream',
        0,
        true,
      );
      handlers.onError?.(apiErr);
    } finally {
      if (signal) {
        signal.removeEventListener('abort', cancelReader);
      }
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be released after cancel.
      }
    }
  }
}

export function createApiClient(config?: ApiClientConfig): ApiClient {
  return new ApiClient(config);
}

export function clearAllSubmissionRecovery(
  storage: Pick<Storage, 'removeItem'> | null = typeof window !== 'undefined' ? window.sessionStorage : null,
): void {
  try {
    if (!storage) return;
    const base = readViteApiBase() ?? '/api';
    const key = `aurvin:submission:v1:${base.replace(/\/+$/, '')}`;
    storage.removeItem(key);
  } catch {
    // Storage unavailable.
  }
}
