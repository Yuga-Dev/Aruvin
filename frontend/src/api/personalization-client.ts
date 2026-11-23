/**
 * ============================================================================
 * FILE: personalization-client.ts
 * LOCATION: frontend/src/api/personalization-client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Bounded, no-store HTTP client for GET/PUT /api/personalization and reset.
 *
 * ROLE IN PROJECT:
 *    Mirrors AdminConfigClient safety patterns (bounded UTF-8 decoding, safe
 *    request validation, abort/timeout classification, closed error mapping).
 *
 * KEY COMPONENTS:
 *    - createPersonalizationClient: GET / PUT / POST reset factory.
 *    - PersonalizationClientError: Closed client error with fieldErrors & revision.
 * ============================================================================
 */

import {
  isPersonalizationErrorBody,
  isPersonalizationResponse,
  isPersonalizationSettings,
  isReverseGeocodeResponse,
  isSavedUserLocation,
  MAX_PERSONALIZATION_BODY_BYTES,
  normalizeCustomInstructions,
  normalizeSavedLocation,
  PERSONALIZATION_PROTOCOL_VERSION,
  PERSONALIZATION_ROUTES,
  utf8ByteLength,
  type PersonalizationErrorCode,
  type PersonalizationFieldError,
  type PersonalizationPutRequest,
  type PersonalizationResetRequest,
  type PersonalizationResponse,
  type ReverseGeocodeRequest,
  type ReverseGeocodeResponse,
  type SavedUserLocation,
} from './personalization-protocol.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32_768;
const SAFE_MESSAGE = 'Personalization request could not be completed.';

export type PersonalizationClientErrorCode =
  | PersonalizationErrorCode
  | 'NETWORK_ERROR'
  | 'ABORTED'
  | 'PERSONALIZATION_REQUEST_TIMEOUT'
  | 'INVALID_PERSONALIZATION_RESPONSE'
  | 'INVALID_PERSONALIZATION_REQUEST'
  | 'HTTP_ERROR';

export class PersonalizationClientError extends Error {
  readonly code: PersonalizationClientErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly currentRevision: number | null;
  readonly fieldErrors: PersonalizationFieldError[];

  constructor(options: {
    code: PersonalizationClientErrorCode;
    message?: string;
    status?: number;
    retryable?: boolean;
    currentRevision?: number | null;
    fieldErrors?: PersonalizationFieldError[];
  }) {
    super(options.message ?? SAFE_MESSAGE);
    this.name = 'PersonalizationClientError';
    this.code = options.code;
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.currentRevision = options.currentRevision ?? null;
    this.fieldErrors = options.fieldErrors ?? [];
  }
}

export type PersonalizationClient = {
  read(signal?: AbortSignal): Promise<PersonalizationResponse>;
  save(request: PersonalizationPutRequest, signal?: AbortSignal): Promise<PersonalizationResponse>;
  reset(request: PersonalizationResetRequest, signal?: AbortSignal): Promise<PersonalizationResponse>;
  reverseGeocode(
    request: ReverseGeocodeRequest,
    signal?: AbortSignal,
  ): Promise<ReverseGeocodeResponse>;
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
  throw new PersonalizationClientError({ code: 'INVALID_PERSONALIZATION_REQUEST' });
}

function assertPutRequest(request: PersonalizationPutRequest): PersonalizationPutRequest {
  if (!request || typeof request !== 'object') invalidRequest();
  if (request.protocolVersion !== PERSONALIZATION_PROTOCOL_VERSION) invalidRequest();
  if (
    typeof request.expectedRevision !== 'number' ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0
  ) {
    invalidRequest();
  }
  if (!request.settings || typeof request.settings !== 'object') invalidRequest();
  if (typeof request.settings.customInstructions !== 'string') invalidRequest();
  const rawLocation = request.settings.location;
  let normalizedLocation: SavedUserLocation | null;
  if (rawLocation === null) {
    normalizedLocation = null;
  } else if (isSavedUserLocation(rawLocation)) {
    normalizedLocation = normalizeSavedLocation(rawLocation);
  } else {
    invalidRequest();
  }
  const normalized = {
    warmth: request.settings.warmth,
    enthusiasm: request.settings.enthusiasm,
    emoji: request.settings.emoji,
    customInstructions: normalizeCustomInstructions(request.settings.customInstructions),
    location: normalizedLocation,
  };
  if (!isPersonalizationSettings(normalized)) {
    invalidRequest();
  }
  const body: PersonalizationPutRequest = {
    protocolVersion: PERSONALIZATION_PROTOCOL_VERSION,
    expectedRevision: request.expectedRevision,
    settings: normalized,
  };
  if (utf8ByteLength(JSON.stringify(body)) > MAX_PERSONALIZATION_BODY_BYTES) invalidRequest();
  return body;
}

function assertReverseGeocodeRequest(request: ReverseGeocodeRequest): ReverseGeocodeRequest {
  if (!request || typeof request !== 'object') invalidRequest();
  if (request.protocolVersion !== PERSONALIZATION_PROTOCOL_VERSION) invalidRequest();
  if (
    typeof request.latitude !== 'number' ||
    !Number.isFinite(request.latitude) ||
    request.latitude < -90 ||
    request.latitude > 90
  ) {
    invalidRequest();
  }
  if (
    typeof request.longitude !== 'number' ||
    !Number.isFinite(request.longitude) ||
    request.longitude < -180 ||
    request.longitude > 180
  ) {
    invalidRequest();
  }
  return {
    protocolVersion: PERSONALIZATION_PROTOCOL_VERSION,
    latitude: request.latitude,
    longitude: request.longitude,
  };
}

function assertResetRequest(request: PersonalizationResetRequest): PersonalizationResetRequest {
  if (!request || typeof request !== 'object') invalidRequest();
  if (request.protocolVersion !== PERSONALIZATION_PROTOCOL_VERSION) invalidRequest();
  if (
    typeof request.expectedRevision !== 'number' ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0
  ) {
    invalidRequest();
  }
  return {
    protocolVersion: PERSONALIZATION_PROTOCOL_VERSION,
    expectedRevision: request.expectedRevision,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new PersonalizationClientError({
      code: 'INVALID_PERSONALIZATION_RESPONSE',
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
      throw new PersonalizationClientError({
        code: 'INVALID_PERSONALIZATION_RESPONSE',
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
    throw new PersonalizationClientError({
      code: 'INVALID_PERSONALIZATION_RESPONSE',
      status: response.status,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PersonalizationClientError({
      code: 'INVALID_PERSONALIZATION_RESPONSE',
      status: response.status,
    });
  }
}

function classifyAbort(
  userSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): PersonalizationClientErrorCode {
  if (userSignal?.aborted && !timeoutSignal.aborted) return 'ABORTED';
  if (timeoutSignal.aborted) return 'PERSONALIZATION_REQUEST_TIMEOUT';
  return 'ABORTED';
}

export function createPersonalizationClient(options?: {
  baseUrl?: string;
  fetch?: typeof fetch;
}): PersonalizationClient {
  const baseUrl = (options?.baseUrl ?? readViteApiBase() ?? '/api').replace(/\/+$/, '');
  const fetcher = options?.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    method: 'GET' | 'PUT' | 'POST',
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
        if (error instanceof PersonalizationClientError) throw error;
        throw new PersonalizationClientError({
          code: 'INVALID_PERSONALIZATION_RESPONSE',
          status: response.status,
        });
      }

      if (response.ok) {
        if (!validate(payload)) {
          throw new PersonalizationClientError({
            code: 'INVALID_PERSONALIZATION_RESPONSE',
            status: response.status,
          });
        }
        return payload;
      }

      if (isPersonalizationErrorBody(payload)) {
        throw new PersonalizationClientError({
          code: payload.error.code,
          message: payload.error.message,
          status: response.status,
          retryable: payload.error.retryable,
          currentRevision: payload.error.currentRevision,
          fieldErrors: payload.error.fieldErrors,
        });
      }

      throw new PersonalizationClientError({
        code: 'HTTP_ERROR',
        status: response.status,
        retryable: response.status >= 500,
      });
    } catch (error) {
      if (error instanceof PersonalizationClientError) throw error;
      if (combined.aborted) {
        throw new PersonalizationClientError({
          code: classifyAbort(signal, timeout.signal),
          retryable: timeout.signal.aborted,
        });
      }
      throw new PersonalizationClientError({ code: 'NETWORK_ERROR', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    read(signal) {
      return request('GET', PERSONALIZATION_ROUTES.root, undefined, signal, isPersonalizationResponse);
    },
    save(putRequest, signal) {
      const validated = assertPutRequest(putRequest);
      return request(
        'PUT',
        PERSONALIZATION_ROUTES.root,
        JSON.stringify(validated),
        signal,
        isPersonalizationResponse,
      );
    },
    reset(resetRequest, signal) {
      const validated = assertResetRequest(resetRequest);
      return request(
        'POST',
        PERSONALIZATION_ROUTES.reset,
        JSON.stringify(validated),
        signal,
        isPersonalizationResponse,
      );
    },
    async reverseGeocode(geoRequest, signal) {
      const validated = assertReverseGeocodeRequest(geoRequest);
      return request(
        'POST',
        PERSONALIZATION_ROUTES.reverseGeocode,
        JSON.stringify(validated),
        signal,
        isReverseGeocodeResponse,
      );
    },
  };
}
