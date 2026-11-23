/**
 * ============================================================================
 * FILE: user-memory-client.ts
 * LOCATION: frontend/src/api/user-memory-client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Bounded, no-store HTTP client for /api/personalization/memory* routes.
 *
 * ROLE IN PROJECT:
 *    Mirrors PersonalizationClient safety patterns (pre-network validation,
 *    bounded UTF-8 decoding, abort/timeout classification, closed errors).
 *
 * KEY COMPONENTS:
 *    - createUserMemoryClient: GET, PATCH enabled, POST edit, and POST clear.
 *    - UserMemoryClientError: Closed client error with code and currentRevision.
 * ============================================================================
 */

import { utf8ByteLength } from './personalization-protocol.ts';
import {
  isUserMemoryEditResponse,
  isUserMemoryErrorBody,
  isUserMemoryResponse,
  MAX_USER_MEMORY_BODY_BYTES,
  USER_MEMORY_PROTOCOL_VERSION,
  USER_MEMORY_ROUTES,
  validateMemoryInstruction,
  type UserMemoryClearRequest,
  type UserMemoryEditRequest,
  type UserMemoryEditResponse,
  type UserMemoryEnabledRequest,
  type UserMemoryErrorCode,
  type UserMemoryResponse,
} from './user-memory-protocol.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32_768;
const SAFE_MESSAGE = 'Memory request could not be completed.';

export type UserMemoryClientErrorCode =
  | UserMemoryErrorCode
  | 'NETWORK_ERROR'
  | 'ABORTED'
  | 'USER_MEMORY_REQUEST_TIMEOUT'
  | 'INVALID_USER_MEMORY_RESPONSE'
  | 'INVALID_USER_MEMORY_REQUEST'
  | 'HTTP_ERROR';

export class UserMemoryClientError extends Error {
  readonly code: UserMemoryClientErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly currentRevision: number | null;

  constructor(options: {
    code: UserMemoryClientErrorCode;
    message?: string;
    status?: number;
    retryable?: boolean;
    currentRevision?: number | null;
  }) {
    super(options.message ?? SAFE_MESSAGE);
    this.name = 'UserMemoryClientError';
    this.code = options.code;
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.currentRevision = options.currentRevision ?? null;
  }
}

export type UserMemoryClient = {
  read(signal?: AbortSignal): Promise<UserMemoryResponse>;
  setEnabled(request: UserMemoryEnabledRequest, signal?: AbortSignal): Promise<UserMemoryResponse>;
  edit(request: UserMemoryEditRequest, signal?: AbortSignal): Promise<UserMemoryEditResponse>;
  clear(request: UserMemoryClearRequest, signal?: AbortSignal): Promise<UserMemoryResponse>;
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
  throw new UserMemoryClientError({ code: 'INVALID_USER_MEMORY_REQUEST' });
}

function assertBaseRequest(request: unknown): number {
  if (!request || typeof request !== 'object') invalidRequest();
  const rec = request as Record<string, unknown>;
  if (rec.protocolVersion !== USER_MEMORY_PROTOCOL_VERSION) invalidRequest();
  const rev = rec.expectedRevision;
  if (
    typeof rev !== 'number' ||
    !Number.isSafeInteger(rev) ||
    rev < 0 ||
    rev > Number.MAX_SAFE_INTEGER - 1
  ) {
    invalidRequest();
  }
  return rev;
}

function assertEnabledRequest(request: UserMemoryEnabledRequest): UserMemoryEnabledRequest {
  const expectedRevision = assertBaseRequest(request);
  if (typeof request.enabled !== 'boolean') invalidRequest();
  return {
    protocolVersion: USER_MEMORY_PROTOCOL_VERSION,
    expectedRevision,
    enabled: request.enabled,
  };
}

function assertEditRequest(request: UserMemoryEditRequest): UserMemoryEditRequest {
  const expectedRevision = assertBaseRequest(request);
  if (typeof request.instruction !== 'string') invalidRequest();
  const checked = validateMemoryInstruction(request.instruction);
  if (checked.error !== null) invalidRequest();
  const body: UserMemoryEditRequest = {
    protocolVersion: USER_MEMORY_PROTOCOL_VERSION,
    expectedRevision,
    instruction: checked.normalized,
  };
  if (utf8ByteLength(JSON.stringify(body)) > MAX_USER_MEMORY_BODY_BYTES) invalidRequest();
  return body;
}

function assertClearRequest(request: UserMemoryClearRequest): UserMemoryClearRequest {
  const expectedRevision = assertBaseRequest(request);
  return {
    protocolVersion: USER_MEMORY_PROTOCOL_VERSION,
    expectedRevision,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new UserMemoryClientError({
      code: 'INVALID_USER_MEMORY_RESPONSE',
      status: response.status,
    });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new UserMemoryClientError({
        code: 'INVALID_USER_MEMORY_RESPONSE',
        status: response.status,
      });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UserMemoryClientError({
      code: 'INVALID_USER_MEMORY_RESPONSE',
      status: response.status,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UserMemoryClientError({
      code: 'INVALID_USER_MEMORY_RESPONSE',
      status: response.status,
    });
  }
}

function classifyAbort(
  userSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): UserMemoryClientErrorCode {
  if (userSignal?.aborted && !timeoutSignal.aborted) return 'ABORTED';
  if (timeoutSignal.aborted) return 'USER_MEMORY_REQUEST_TIMEOUT';
  return 'ABORTED';
}

export function createUserMemoryClient(options?: {
  baseUrl?: string;
  fetch?: typeof fetch;
}): UserMemoryClient {
  const baseUrl = (options?.baseUrl ?? readViteApiBase() ?? '/api').replace(/\/+$/, '');
  const fetcher = options?.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    method: 'GET' | 'PATCH' | 'POST',
    path: string,
    body: string | undefined,
    signal: AbortSignal | undefined,
    validate: (payload: unknown) => payload is T,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const init: RequestInit = {
        method,
        cache: 'no-store',
        redirect: 'error',
        credentials: 'same-origin',
        headers: body
          ? { 'Content-Type': 'application/json', Accept: 'application/json' }
          : { Accept: 'application/json' },
        signal: combined,
      };
      if (body !== undefined) init.body = body;
      const response = await fetcher(`${baseUrl}${path}`, init);

      let payload: unknown;
      try {
        payload = await readBoundedJson(response);
      } catch (error) {
        if (error instanceof UserMemoryClientError) throw error;
        throw new UserMemoryClientError({
          code: 'INVALID_USER_MEMORY_RESPONSE',
          status: response.status,
        });
      }

      if (response.ok) {
        if (!validate(payload)) {
          throw new UserMemoryClientError({
            code: 'INVALID_USER_MEMORY_RESPONSE',
            status: response.status,
          });
        }
        return payload;
      }

      if (isUserMemoryErrorBody(payload)) {
        throw new UserMemoryClientError({
          code: payload.error.code,
          message: payload.error.message,
          status: response.status,
          retryable: payload.error.retryable,
          currentRevision: payload.error.currentRevision,
        });
      }

      throw new UserMemoryClientError({
        code: 'HTTP_ERROR',
        status: response.status,
        retryable: response.status >= 500,
      });
    } catch (error) {
      if (error instanceof UserMemoryClientError) throw error;
      if (combined.aborted) {
        throw new UserMemoryClientError({
          code: classifyAbort(signal, timeout.signal),
          retryable: timeout.signal.aborted,
        });
      }
      throw new UserMemoryClientError({ code: 'NETWORK_ERROR', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    read(signal) {
      return request('GET', USER_MEMORY_ROUTES.memory, undefined, signal, isUserMemoryResponse);
    },
    async setEnabled(enabledRequest, signal) {
      const validated = assertEnabledRequest(enabledRequest);
      return request(
        'PATCH',
        USER_MEMORY_ROUTES.enabled,
        JSON.stringify(validated),
        signal,
        isUserMemoryResponse,
      );
    },
    async edit(editRequest, signal) {
      const validated = assertEditRequest(editRequest);
      return request(
        'POST',
        USER_MEMORY_ROUTES.edit,
        JSON.stringify(validated),
        signal,
        isUserMemoryEditResponse,
      );
    },
    async clear(clearRequest, signal) {
      const validated = assertClearRequest(clearRequest);
      return request(
        'POST',
        USER_MEMORY_ROUTES.clear,
        JSON.stringify(validated),
        signal,
        isUserMemoryResponse,
      );
    },
  };
}
