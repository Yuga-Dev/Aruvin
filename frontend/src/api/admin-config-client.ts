/**
 * ============================================================================
 * FILE: admin-config-client.ts
 * LOCATION: frontend/src/api/admin-config-client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Bounded, no-store HTTP client for public admin configuration.
 *
 * ROLE IN PROJECT:
 *    Lets the admin dashboard read and mutate settings/credentials without
 *    copying backend secrets or reusing chat ApiClient error forwarding.
 *
 * KEY COMPONENTS:
 *    - createAdminConfigClient: GET/PUT/POST factory with injectable fetch.
 *    - AdminConfigClientError: Closed safe presentation without raw bodies.
 * ============================================================================
 */

import {
  ADMIN_CONFIG_PROTOCOL_VERSION,
  ADMIN_CONFIG_ROUTES,
  DEFAULT_MEMORY_SETTINGS,
  MAX_ADMIN_CONFIG_BODY_BYTES,
  MAX_CREDENTIAL_BYTES,
  isAdminConfigError,
  isDevMode,
  isDevModeResponse,
  isManageableSettings,
  isModelCatalogueResponse,
  isModelCompatibilityResponse,
  isPublicAdminConfig,
  type AdminConfigError,
  type CredentialProvider,
  type CredentialUpdateRequest,
  type DevModeResponse,
  type ModelCatalogueResponse,
  type ModelCompatibilityReport,
  type ModelCompatibilityResponse,
  type PublicAdminConfig,
  type SaveSettingsRequest,
  type SetDevModeRequest,
} from './admin-config-protocol.ts';
import { isAuthErrorResponse } from './auth-protocol.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 65_536;
const SAFE_MESSAGE = 'Configuration could not be completed.';
const PROVIDERS = new Set<CredentialProvider>(['openrouter', 'deepgram']);

export type AdminConfigClientErrorCode =
  | AdminConfigError['error']['code']
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'NOT_READY'
  | 'NETWORK_ERROR'
  | 'ABORTED'
  | 'ADMIN_REQUEST_TIMEOUT'
  | 'INVALID_ADMIN_RESPONSE'
  | 'INVALID_ADMIN_REQUEST';

export class AdminConfigClientError extends Error {
  readonly code: AdminConfigClientErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly currentRevision: number | null;
  readonly fieldErrors: AdminConfigError['error']['fieldErrors'];
  readonly compatibility: ModelCompatibilityReport | null;
  readonly uncertain: boolean;

  constructor(options: {
    code: AdminConfigClientErrorCode;
    status?: number;
    retryable?: boolean;
    currentRevision?: number | null;
    fieldErrors?: AdminConfigError['error']['fieldErrors'];
    compatibility?: ModelCompatibilityReport | null;
    uncertain?: boolean;
  }) {
    super(SAFE_MESSAGE);
    this.name = 'AdminConfigClientError';
    this.code = options.code;
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.currentRevision = options.currentRevision ?? null;
    this.fieldErrors = options.fieldErrors ?? [];
    this.compatibility = options.compatibility ?? null;
    this.uncertain = options.uncertain ?? false;
  }
}

export type AdminConfigClient = {
  read(signal?: AbortSignal): Promise<PublicAdminConfig>;
  readDevMode(signal?: AbortSignal): Promise<DevModeResponse>;
  setDevMode(request: SetDevModeRequest, signal?: AbortSignal): Promise<DevModeResponse>;
  models(signal?: AbortSignal): Promise<ModelCatalogueResponse>;
  checkModelCompatibility(request: SaveSettingsRequest, signal?: AbortSignal): Promise<ModelCompatibilityResponse>;
  saveSettings(request: SaveSettingsRequest, signal?: AbortSignal): Promise<PublicAdminConfig>;
  updateCredential(
    provider: CredentialProvider,
    request: CredentialUpdateRequest,
    signal?: AbortSignal,
  ): Promise<PublicAdminConfig>;
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
  throw new AdminConfigClientError({ code: 'INVALID_ADMIN_REQUEST' });
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertRevision(value: unknown): asserts value is number {
  if (!isSafeInteger(value) || value < 0) invalidRequest();
}

type ReadableAdminConfig = Omit<PublicAdminConfig, 'settings'> & {
  settings: Omit<PublicAdminConfig['settings'], 'memory'> & {
    memory?: PublicAdminConfig['settings']['memory'];
  };
};

function normalizePublicConfig(config: ReadableAdminConfig): PublicAdminConfig {
  return config.settings.memory
    ? (config as PublicAdminConfig)
    : { ...config, settings: { ...config.settings, memory: { ...DEFAULT_MEMORY_SETTINGS } } };
}

function assertSaveRequest(request: SaveSettingsRequest): SaveSettingsRequest {
  if (!request || typeof request !== 'object') invalidRequest();
  if (!exactKeys(request, ['protocolVersion', 'expectedRevision', 'settings'])) invalidRequest();
  if (request.protocolVersion !== ADMIN_CONFIG_PROTOCOL_VERSION) invalidRequest();
  assertRevision(request.expectedRevision);
  if (!request.settings || typeof request.settings !== 'object'
      || !Object.hasOwn(request.settings, 'memory')
      || !isManageableSettings(request.settings)) invalidRequest();
  const body: SaveSettingsRequest = {
    protocolVersion: 1,
    expectedRevision: request.expectedRevision,
    settings: request.settings,
  };
  if (utf8Bytes(JSON.stringify(body)) > MAX_ADMIN_CONFIG_BODY_BYTES) invalidRequest();
  return body;
}

function assertCredentialRequest(request: CredentialUpdateRequest): CredentialUpdateRequest {
  if (!request || typeof request !== 'object') invalidRequest();
  if (request.protocolVersion !== ADMIN_CONFIG_PROTOCOL_VERSION) invalidRequest();
  assertRevision(request.expectedRevision);
  if (request.action === 'replace') {
    if (!exactKeys(request, ['protocolVersion', 'expectedRevision', 'action', 'candidate'])) {
      invalidRequest();
    }
    if (typeof request.candidate !== 'string') invalidRequest();
    if (utf8Bytes(request.candidate) > MAX_CREDENTIAL_BYTES) invalidRequest();
    const body: CredentialUpdateRequest = {
      protocolVersion: 1,
      expectedRevision: request.expectedRevision,
      action: 'replace',
      candidate: request.candidate,
    };
    if (utf8Bytes(JSON.stringify(body)) > MAX_ADMIN_CONFIG_BODY_BYTES) invalidRequest();
    return body;
  }
  if (request.action === 'remove') {
    if (!exactKeys(request, ['protocolVersion', 'expectedRevision', 'action', 'confirm'])) {
      invalidRequest();
    }
    if (request.confirm !== true) invalidRequest();
    return {
      protocolVersion: 1,
      expectedRevision: request.expectedRevision,
      action: 'remove',
      confirm: true,
    };
  }
  invalidRequest();
}

async function readBoundedJson(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AdminConfigClientError({ code: 'INVALID_ADMIN_RESPONSE', status: response.status });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AdminConfigClientError({ code: 'INVALID_ADMIN_RESPONSE', status: response.status });
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
    throw new AdminConfigClientError({ code: 'INVALID_ADMIN_RESPONSE', status: response.status });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdminConfigClientError({ code: 'INVALID_ADMIN_RESPONSE', status: response.status });
  }
}

function classifyAbort(userSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): AdminConfigClientErrorCode {
  if (userSignal?.aborted && !timeoutSignal.aborted) return 'ABORTED';
  if (timeoutSignal.aborted) return 'ADMIN_REQUEST_TIMEOUT';
  return 'ABORTED';
}

export function createAdminConfigClient(options?: {
  baseUrl?: string;
  fetch?: typeof fetch;
}): AdminConfigClient {
  const baseUrl = (options?.baseUrl ?? readViteApiBase() ?? '/api').replace(/\/+$/, '');
  const fetcher = options?.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body: string | undefined,
    signal: AbortSignal | undefined,
    mutation: boolean,
    guard: (value: unknown) => value is T,
    maxBytes = MAX_RESPONSE_BYTES,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    let dispatched = false;
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
      dispatched = mutation;
      const response = await fetcher(`${baseUrl}${path}`, init);
      let payload: unknown;
      try {
        payload = await readBoundedJson(response, maxBytes);
      } catch (error) {
        if (error instanceof AdminConfigClientError) {
          throw new AdminConfigClientError({
            code: error.code,
            status: error.status,
            uncertain: mutation,
          });
        }
        throw new AdminConfigClientError({
          code: 'INVALID_ADMIN_RESPONSE',
          status: response.status,
          uncertain: mutation,
        });
      }
      if (!response.ok) {
        if (isAuthErrorResponse(payload)) {
          const { code, retryable } = payload.error;
          const status = response.status;
          if ((status === 401 && code === 'UNAUTHENTICATED')
              || (status === 403 && (code === 'FORBIDDEN' || code === 'PASSWORD_CHANGE_REQUIRED'))
              || (status === 503 && code === 'NOT_READY')) {
            throw new AdminConfigClientError({ code, status, retryable });
          }
        }
        if (!isAdminConfigError(payload)) {
          throw new AdminConfigClientError({
            code: 'INVALID_ADMIN_RESPONSE',
            status: response.status,
            uncertain: mutation,
          });
        }
        throw new AdminConfigClientError({
          code: payload.error.code,
          status: response.status,
          retryable: payload.error.retryable,
          currentRevision: payload.error.currentRevision,
          fieldErrors: payload.error.fieldErrors,
          compatibility: payload.error.compatibility ?? null,
        });
      }
      if (!guard(payload)) {
        throw new AdminConfigClientError({
          code: 'INVALID_ADMIN_RESPONSE',
          status: response.status,
          uncertain: mutation,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof AdminConfigClientError) throw error;
      const aborted = combined.aborted || (error instanceof DOMException && error.name === 'AbortError')
        || (error instanceof Error && error.name === 'AbortError');
      const code = aborted ? classifyAbort(signal, timeout.signal) : 'NETWORK_ERROR';
      throw new AdminConfigClientError({
        code,
        retryable: code === 'NETWORK_ERROR' || code === 'ADMIN_REQUEST_TIMEOUT',
        uncertain: dispatched,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async read(signal) {
      return normalizePublicConfig(
        await request('GET', ADMIN_CONFIG_ROUTES.config, undefined, signal, false, isPublicAdminConfig),
      );
    },
    async readDevMode(signal) {
      return request('GET', ADMIN_CONFIG_ROUTES.devMode, undefined, signal, false, isDevModeResponse);
    },
    async setDevMode(input, signal) {
      if (!input || typeof input !== 'object' || !exactKeys(input, ['protocolVersion', 'mode'])
          || input.protocolVersion !== ADMIN_CONFIG_PROTOCOL_VERSION || !isDevMode(input.mode)) {
        invalidRequest();
      }
      return request('PUT', ADMIN_CONFIG_ROUTES.devMode,
        JSON.stringify({ protocolVersion: ADMIN_CONFIG_PROTOCOL_VERSION, mode: input.mode }),
        signal, true, isDevModeResponse);
    },
    async models(signal) {
      return request('GET', ADMIN_CONFIG_ROUTES.models, undefined, signal, false, isModelCatalogueResponse, 1_048_576);
    },
    async checkModelCompatibility(requestBody, signal) {
      return request('POST', ADMIN_CONFIG_ROUTES.modelCompatibility,
        JSON.stringify(assertSaveRequest(requestBody)), signal, false, isModelCompatibilityResponse);
    },
    async saveSettings(requestBody, signal) {
      const body = JSON.stringify(assertSaveRequest(requestBody));
      return normalizePublicConfig(
        await request('PUT', ADMIN_CONFIG_ROUTES.config, body, signal, true, isPublicAdminConfig),
      );
    },
    async updateCredential(provider, requestBody, signal) {
      if (!PROVIDERS.has(provider)) invalidRequest();
      const body = JSON.stringify(assertCredentialRequest(requestBody));
      return normalizePublicConfig(await request(
        'POST', ADMIN_CONFIG_ROUTES.credential(provider), body, signal, true, isPublicAdminConfig,
      ));
    },
  };
}
