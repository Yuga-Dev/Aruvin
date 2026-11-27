/**
 * ============================================================================
 * FILE: user-memory-protocol.ts
 * LOCATION: frontend/src/api/user-memory-protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Mirror the /api/personalization/memory* wire protocol and validation rules.
 *
 * ROLE IN PROJECT:
 *    Provides browser-safe user-memory types, section labels/renderer, composer
 *    instruction validation, and strict response/error guards reusing shared
 *    personalization secret and control-char helpers.
 *
 * KEY COMPONENTS:
 *    - USER_MEMORY_ROUTES / USER_MEMORY_SECTION_KEYS / bounds constants
 *    - validateMemoryInstruction / renderUserMemorySections
 *    - isUserMemoryResponse / isUserMemoryEditResponse / isUserMemoryErrorBody
 * ============================================================================
 */

import {
  hasDisallowedControlChars,
  hasSecretPattern,
  normalizeCustomInstructions,
  utf8ByteLength,
} from './personalization-protocol.ts';

export const USER_MEMORY_PROTOCOL_VERSION = 1 as const;
export const USER_MEMORY_SECTION_KEYS = [
  'identity',
  'work',
  'preferences',
  'ongoing',
  'other',
] as const;
export type UserMemorySectionKey = (typeof USER_MEMORY_SECTION_KEYS)[number];
export type UserMemorySections = Record<UserMemorySectionKey, string>;

export const USER_MEMORY_SECTION_LABELS: Readonly<Record<UserMemorySectionKey, string>> = Object.freeze({
  identity: 'Identity',
  work: 'Work',
  preferences: 'Preferences',
  ongoing: 'Ongoing',
  other: 'Other',
});

export const USER_MEMORY_MAX_CHARS = 2500;
export const USER_MEMORY_MAX_BYTES = 8000;
export const USER_MEMORY_INSTRUCTION_MAX_CHARS = 500;
export const MAX_USER_MEMORY_BODY_BYTES = 16_384;

export const USER_MEMORY_ROUTES = {
  memory: '/personalization/memory',
  enabled: '/personalization/memory/enabled',
  edit: '/personalization/memory/edit',
  clear: '/personalization/memory/clear',
  // Release 5 (M1 contract, plan 3.2). The section key is validated by the client before use.
  section: (key: UserMemorySectionKey) => `/personalization/memory/sections/${key}`,
  history: '/personalization/memory/history',
} as const;

export const USER_MEMORY_ERROR_CODES = [
  'INVALID_REQUEST',
  'MEMORY_CONFLICT',
  'NOT_READY',
  'PERSISTENCE_ERROR',
  'MEMORY_WRITER_UNAVAILABLE',
] as const;
export type UserMemoryErrorCode = (typeof USER_MEMORY_ERROR_CODES)[number];

export type UserMemoryClearRequest = {
  protocolVersion: 1;
  expectedRevision: number;
};

export type UserMemoryEnabledRequest = {
  protocolVersion: 1;
  expectedRevision: number;
  enabled: boolean;
};

export type UserMemoryEditRequest = {
  protocolVersion: 1;
  expectedRevision: number;
  instruction: string;
};

export type UserMemoryResponse = {
  protocolVersion: 1;
  revision: number;
  enabled: boolean;
  sections: UserMemorySections;
  isEmpty: boolean;
  charCount: number;
  maxChars: typeof USER_MEMORY_MAX_CHARS;
  updatedAt: string | null;
};

export type UserMemoryEditResponse = UserMemoryResponse & {
  changeSummary: string;
};

export type UserMemoryErrorBody = {
  protocolVersion: 1;
  error: {
    code: UserMemoryErrorCode;
    message: string;
    retryable: boolean;
    currentRevision: number | null;
  };
};

export type MemoryInstructionError =
  | 'required'
  | 'disallowed_characters'
  | 'secret_pattern'
  | 'out_of_range';

export function emptyUserMemorySections(): UserMemorySections {
  return { identity: '', work: '', preferences: '', ongoing: '', other: '' };
}

export function cloneUserMemorySections(sections: UserMemorySections): UserMemorySections {
  return {
    identity: sections.identity,
    work: sections.work,
    preferences: sections.preferences,
    ongoing: sections.ongoing,
    other: sections.other,
  };
}

export function userMemoryCharCount(value: string): number {
  return Array.from(value).length;
}

export function renderUserMemorySections(sections: UserMemorySections): string {
  return USER_MEMORY_SECTION_KEYS.filter(key => sections[key] !== '')
    .map(key => `- ${USER_MEMORY_SECTION_LABELS[key]}: ${sections[key]}`)
    .join('\n');
}

export function validateMemoryInstruction(raw: string): {
  normalized: string;
  charCount: number;
  error: MemoryInstructionError | null;
} {
  const normalized = normalizeCustomInstructions(raw);
  const charCount = userMemoryCharCount(normalized);
  if (hasDisallowedControlChars(raw)) {
    return { normalized, charCount, error: 'disallowed_characters' };
  }
  if (hasSecretPattern(normalized)) {
    return { normalized, charCount, error: 'secret_pattern' };
  }
  if (normalized.length === 0) {
    return { normalized, charCount: 0, error: 'required' };
  }
  if (
    normalized.length > USER_MEMORY_INSTRUCTION_MAX_CHARS * 2 ||
    charCount > USER_MEMORY_INSTRUCTION_MAX_CHARS
  ) {
    return { normalized, charCount, error: 'out_of_range' };
  }
  return { normalized, charCount, error: null };
}

const ERROR_CODE_SET = new Set<string>(USER_MEMORY_ERROR_CODES);
const RESPONSE_KEYS = [
  'protocolVersion',
  'revision',
  'enabled',
  'sections',
  'isEmpty',
  'charCount',
  'maxChars',
  'updatedAt',
] as const;
const EDIT_RESPONSE_KEYS = [...RESPONSE_KEYS, 'changeSummary'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 40 &&
    !Number.isNaN(Date.parse(value))
  );
}

function isSafeMemoryText(value: unknown): value is string {
  return typeof value === 'string' && !hasDisallowedControlChars(value) && !hasSecretPattern(value);
}

export function isUserMemorySections(value: unknown): value is UserMemorySections {
  if (!isRecord(value) || !exactKeys(value, USER_MEMORY_SECTION_KEYS)) return false;
  for (const key of USER_MEMORY_SECTION_KEYS) {
    if (!isSafeMemoryText(value[key])) return false;
  }
  const rendered = renderUserMemorySections(value as UserMemorySections);
  return (
    rendered.length <= USER_MEMORY_MAX_CHARS * 2 &&
    utf8ByteLength(rendered) <= USER_MEMORY_MAX_BYTES &&
    userMemoryCharCount(rendered) <= USER_MEMORY_MAX_CHARS
  );
}

function hasValidBaseResponseFields(value: Record<string, unknown>): boolean {
  if (value.protocolVersion !== USER_MEMORY_PROTOCOL_VERSION) return false;
  if (!isSafeRevision(value.revision)) return false;
  if (typeof value.enabled !== 'boolean') return false;
  if (!isUserMemorySections(value.sections)) return false;
  if (typeof value.isEmpty !== 'boolean') return false;
  if (
    typeof value.charCount !== 'number' ||
    !Number.isSafeInteger(value.charCount) ||
    value.charCount < 0 ||
    value.charCount > USER_MEMORY_MAX_CHARS
  ) {
    return false;
  }
  if (value.maxChars !== USER_MEMORY_MAX_CHARS) return false;
  return value.updatedAt === null || isIsoTimestamp(value.updatedAt);
}

export function isUserMemoryResponse(value: unknown): value is UserMemoryResponse {
  return (
    isRecord(value) &&
    exactKeys(value, RESPONSE_KEYS) &&
    hasValidBaseResponseFields(value)
  );
}

export function isUserMemoryEditResponse(value: unknown): value is UserMemoryEditResponse {
  if (!isRecord(value) || !exactKeys(value, EDIT_RESPONSE_KEYS)) return false;
  if (!hasValidBaseResponseFields(value)) return false;
  if (!isSafeMemoryText(value.changeSummary)) return false;
  return (
    value.changeSummary.length <= USER_MEMORY_INSTRUCTION_MAX_CHARS * 2 &&
    userMemoryCharCount(value.changeSummary) <= USER_MEMORY_INSTRUCTION_MAX_CHARS
  );
}

export function isUserMemoryErrorBody(value: unknown): value is UserMemoryErrorBody {
  if (!isRecord(value) || value.protocolVersion !== USER_MEMORY_PROTOCOL_VERSION) return false;
  if (!isRecord(value.error)) return false;
  const err = value.error;
  if (typeof err.code !== 'string' || !ERROR_CODE_SET.has(err.code)) return false;
  if (typeof err.message !== 'string') return false;
  if (typeof err.retryable !== 'boolean') return false;
  return err.currentRevision === null || isSafeRevision(err.currentRevision);
}

// ---- Release 5 section edit and history (plan 3.2); mirrors the M1 contract. ----

export const USER_MEMORY_HISTORY_MAX_LIMIT = 50;

export type UserMemorySectionRequest = {
  protocolVersion: 1;
  expectedRevision: number;
  requestId: string;
  /** Empty text clears the section. */
  text: string;
};

export const MEMORY_AUDIT_ACTIONS = [
  'edit-section',
  'clear-section',
  'clear-all',
  'enable',
  'disable',
  'instruction',
  'tool',
  'passive',
] as const;
export type MemoryAuditAction = (typeof MEMORY_AUDIT_ACTIONS)[number];
export type MemoryAuditSource = 'user-ui' | 'composer' | 'tool' | 'passive';

/** Counts and names only; the server never returns memory text here (D2). */
export type MemoryAuditView = {
  memoryRevision: number;
  at: string;
  action: MemoryAuditAction;
  source: MemoryAuditSource;
  sections: UserMemorySectionKey[];
  charsBefore: number;
  charsAfter: number;
  origin?: { sessionId: string; turnId: string };
};

export type MemoryHistoryResponse = { items: MemoryAuditView[]; nextCursor: string | null };

const AUDIT_SOURCES = new Set(['user-ui', 'composer', 'tool', 'passive']);

function isAuditView(value: unknown): value is MemoryAuditView {
  if (!isRecord(value)) return false;
  const origin = value.origin;
  return (
    isSafeRevision(value.memoryRevision) &&
    isIsoTimestamp(value.at) &&
    (MEMORY_AUDIT_ACTIONS as readonly string[]).includes(value.action as string) &&
    AUDIT_SOURCES.has(value.source as string) &&
    Array.isArray(value.sections) &&
    value.sections.length <= USER_MEMORY_SECTION_KEYS.length &&
    value.sections.every(k => (USER_MEMORY_SECTION_KEYS as readonly unknown[]).includes(k)) &&
    isSafeRevision(value.charsBefore) &&
    isSafeRevision(value.charsAfter) &&
    (origin === undefined ||
      (isRecord(origin) && typeof origin.sessionId === 'string' && typeof origin.turnId === 'string'))
  );
}

export function isMemoryHistoryResponse(value: unknown): value is MemoryHistoryResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.length <= USER_MEMORY_HISTORY_MAX_LIMIT &&
    value.items.every(isAuditView) &&
    (value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length <= 512))
  );
}
