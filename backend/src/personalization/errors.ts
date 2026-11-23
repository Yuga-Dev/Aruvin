/**
 * ============================================================================
 * FILE: errors.ts
 * LOCATION: backend/src/personalization/errors.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Map personalization service and HTTP faults to a closed error protocol.
 *
 * ROLE IN PROJECT:
 *    Prevents raw exception text or database details from leaking to HTTP
 *    callers while exposing safe revision conflicts and field errors.
 *
 * KEY COMPONENTS:
 *    - PersonalizationFault: Closed HTTP status, retryable flag, and body().
 *    - UserMemoryFault: Closed memory status, revision hint, and secret flag.
 * ============================================================================
 */

import {
  PERSONALIZATION_FIELD_ERROR_CODES,
  PERSONALIZATION_FIELD_PATHS,
  PERSONALIZATION_PROTOCOL_VERSION,
  type PersonalizationErrorBody,
  type PersonalizationErrorCode,
  type PersonalizationFieldError,
} from '../contracts/personalization.js';

const STATUS: Record<PersonalizationErrorCode, number> = {
  INVALID_REQUEST: 400,
  PERSONALIZATION_CONFLICT: 409,
  NOT_READY: 503,
  PERSISTENCE_ERROR: 503,
  LOCATION_UNAVAILABLE: 503,
};

const RETRYABLE: ReadonlySet<PersonalizationErrorCode> = new Set([
  'NOT_READY',
  'PERSISTENCE_ERROR',
  'LOCATION_UNAVAILABLE',
]);

const STATIC_MESSAGE: Record<PersonalizationErrorCode, string> = {
  INVALID_REQUEST: 'Personalization settings request is invalid.',
  PERSONALIZATION_CONFLICT: 'Personalization settings were updated elsewhere. Reload and try again.',
  NOT_READY: 'Personalization storage is not ready yet.',
  PERSISTENCE_ERROR: 'Personalization storage failed. Please try again.',
  LOCATION_UNAVAILABLE:
    'Location could not be determined right now. You can enter your city manually.',
};

const ALLOWED_PATHS = new Set<string>(PERSONALIZATION_FIELD_PATHS);
const ALLOWED_FIELD_CODES = new Set<string>(PERSONALIZATION_FIELD_ERROR_CODES);

function sanitizeFieldErrors(
  raw: readonly PersonalizationFieldError[],
): PersonalizationFieldError[] {
  const out: PersonalizationFieldError[] = [];
  for (const item of raw) {
    if (out.length >= 10) break;
    if (!ALLOWED_PATHS.has(item.path) || !ALLOWED_FIELD_CODES.has(item.code)) continue;
    out.push({ path: item.path, code: item.code });
  }
  return out;
}

export class PersonalizationFault extends Error {
  readonly code: PersonalizationErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly currentRevision: number | null;
  readonly fieldErrors: PersonalizationFieldError[];

  constructor(
    code: PersonalizationErrorCode,
    currentRevision: number | null = null,
    fieldErrors: readonly PersonalizationFieldError[] = [],
  ) {
    super(STATIC_MESSAGE[code]);
    this.name = 'PersonalizationFault';
    this.code = code;
    this.status = STATUS[code];
    this.retryable = RETRYABLE.has(code);
    this.currentRevision = currentRevision;
    this.fieldErrors = sanitizeFieldErrors(fieldErrors);
  }

  body(): PersonalizationErrorBody {
    return {
      protocolVersion: PERSONALIZATION_PROTOCOL_VERSION,
      error: {
        code: this.code,
        message: STATIC_MESSAGE[this.code],
        retryable: this.retryable,
        currentRevision: this.currentRevision,
        fieldErrors: this.fieldErrors,
      },
    };
  }
}

const MEMORY_ERRORS = {
  INVALID_REQUEST: [400, 'The user memory request is invalid.'],
  MEMORY_CONFLICT: [409, 'Memory changed elsewhere. Reload and try again.'],
  NOT_READY: [503, 'User memory is not ready.'],
  PERSISTENCE_ERROR: [503, 'User memory could not be saved or read.'],
  MEMORY_WRITER_UNAVAILABLE: [503, 'The memory writer could not apply this request.'],
} as const;

type UserMemoryFaultCode = keyof typeof MEMORY_ERRORS | 'MEMORY_DISABLED';

export class UserMemoryFault extends Error {
  constructor(readonly code: UserMemoryFaultCode,
    readonly currentRevision: number | null = null,
    readonly secretRejected = false) {
    super(MEMORY_ERRORS[code === 'MEMORY_DISABLED' ? 'MEMORY_WRITER_UNAVAILABLE' : code][1]);
    this.name = 'UserMemoryFault';
  }

  private get httpCode(): keyof typeof MEMORY_ERRORS {
    return this.code === 'MEMORY_DISABLED' ? 'MEMORY_WRITER_UNAVAILABLE' : this.code;
  }

  get status(): number { return MEMORY_ERRORS[this.httpCode][0]; }
  get retryable(): boolean {
    return this.status === 503 && this.code !== 'MEMORY_DISABLED' && !this.secretRejected;
  }

  body() {
    return { protocolVersion: 1 as const, error: {
      code: this.httpCode, message: this.message, retryable: this.retryable,
      currentRevision: this.currentRevision,
    } };
  }
}
