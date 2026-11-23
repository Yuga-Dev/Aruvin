# Frontend Personalization MemoryCard & Admin Memory Model Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the independent Personalization `MemoryCard` (master toggle, read-only categorized caveman summary, empty state, char budget meter, Claude-style natural-language composer, and `ConfirmDialog` clear-all), close the P1 `admin-config-protocol.ts` mirror transfer, and add the Manage Aurvin Admin Config memory writer model selector in `ConfigFields.tsx`.

**Architecture:** User memory uses a dedicated browser protocol and bounded no-store HTTP client (`/api/personalization/memory*`) paired with a standalone reducer (`user-memory-state.ts`) mounted inside `PersonalizationPanel.tsx` so memory revision, loading, errors, and immediate actions remain completely isolated from Tone/Custom Instructions/Location dirty/Save/Discard state. Admin Config mirrors `backend/src/contracts/admin-config-wire.ts` verbatim into `frontend/src/api/admin-config-protocol.ts` and adds `memory.modelMode` (`main | custom`) plus `memory.customModelId` (`ModelCombobox`) inside the existing `compaction` section (`User memory` fieldset), with an explicit **"Use compaction model"** one-click snapshot copy action rather than inventing a third wire mode.

**Tech Stack:** React 19, TypeScript (`verbatimModuleSyntax`, `erasableSyntaxOnly`, `.ts`/`.tsx` relative imports), Vite, Vitest (Node environment + `react-dom/server` `renderToStaticMarkup`), `oxlint`, CSS custom properties (`--aurvin-*`).

---

## Scope, Ownership & Pre-Execution Approval Note

**P5 Owned Files (from `docs/user-memory-context/state.md`):**
- Create: `frontend/src/api/user-memory-protocol.ts`
- Create: `frontend/src/api/user-memory-client.ts`
- Create: `frontend/src/api/user-memory-client.test.ts`
- Modify: `frontend/src/api/admin-config-protocol.ts`
- Create: `frontend/src/features/personalization/user-memory-state.ts`
- Create: `frontend/src/features/personalization/MemoryCard.tsx`
- Create: `frontend/src/features/personalization/user-memory.test.ts`
- Modify: `frontend/src/features/personalization/PersonalizationPanel.tsx`
- Modify: `frontend/src/features/personalization/personalization.css`
- Modify: `frontend/src/features/admin-config/ConfigFields.tsx`
- Modify: `frontend/src/features/admin-config/config-edit-state.ts`
- Modify: `frontend/src/features/admin-config/config-edit-state.test.ts`

> **Required 2-File Scope Expansion (Parent Approval Needed Before Task 5):**
> Closing the P1 mirror transfer makes `frontend/src/api/admin-config-protocol.ts` match `backend/src/contracts/admin-config-wire.ts` verbatim (`ManageableSettings` gains required `memory: MemorySettings`, while `isPublicAdminConfig` narrows to `ReadablePublicAdminConfig` where `settings.memory` is optional). Immediately after that edit, `frontend` `npm run build` fails in two unowned files (neither is owned by P6 or any other plan):
> 1. `frontend/src/api/admin-config-client.ts`: `read`, `saveSettings`, and `updateCredential` return `Promise<PublicAdminConfig>` from `request(..., isPublicAdminConfig)` (TS2322 until optional `settings.memory` is normalized to `{ ...DEFAULT_MEMORY_SETTINGS }`).
> 2. `frontend/src/features/admin-config/testing/fixtures.ts`: `const settings: ManageableSettings` lacks `memory` (TS2741 until `memory: { ...DEFAULT_MEMORY_SETTINGS }` is added).
>
> Task 5 includes the exact minimal diffs for both files. Obtain orchestrator/parent approval before editing them if not already pre-authorized at worker dispatch.

**Workspace & Git Hygiene:**
- Do **not** touch `frontend/src/api/protocol.ts`, `frontend/src/api/client.ts`, `frontend/src/api/voice-protocol.ts`, `frontend/src/api/voice-limits.ts`, `frontend/src/api/weather-protocol.ts`, `frontend/src/features/voice/**`, or `frontend/src/features/admin-config/AdminDashboard.tsx`.
- Never run `git add .`. Always stage only the explicitly named files for each task.
- All new `.ts`/`.tsx` files include the mandatory repository file header.

---

### Task 1: User Memory Protocol & Bounded HTTP Client

**Files:**
- Create: `frontend/src/api/user-memory-protocol.ts`
- Create: `frontend/src/api/user-memory-client.ts`
- Test: `frontend/src/api/user-memory-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/api/user-memory-client.test.ts`:

```typescript
/**
 * ============================================================================
 * FILE: user-memory-client.test.ts
 * LOCATION: frontend/src/api/user-memory-client.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify user-memory wire guards, instruction validation, and HTTP client.
 *
 * ROLE IN PROJECT:
 *    Locks /api/personalization/memory* routes, pre-network secret/cap checks,
 *    revision conflict handling, and bounded JSON decoding in Node Vitest.
 *
 * KEY COMPONENTS:
 *    - Protocol section rendering, char counting, and strict response guards.
 *    - Client GET / PATCH enabled / POST edit / POST clear and error mapping.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUserMemoryClient,
  UserMemoryClientError,
} from './user-memory-client.ts';
import {
  emptyUserMemorySections,
  isUserMemoryEditResponse,
  isUserMemoryErrorBody,
  isUserMemoryResponse,
  renderUserMemorySections,
  USER_MEMORY_INSTRUCTION_MAX_CHARS,
  USER_MEMORY_MAX_CHARS,
  userMemoryCharCount,
  validateMemoryInstruction,
  type UserMemoryEditResponse,
  type UserMemoryResponse,
} from './user-memory-protocol.ts';

function sampleMemory(overrides: Partial<UserMemoryResponse> = {}): UserMemoryResponse {
  const sections = overrides.sections ?? {
    ...emptyUserMemorySections(),
    identity: 'Name: Peter. Dog: Beans.',
  };
  const rendered = renderUserMemorySections(sections);
  return {
    protocolVersion: 1,
    revision: 1,
    enabled: true,
    sections,
    isEmpty: rendered.length === 0,
    charCount: userMemoryCharCount(rendered),
    maxChars: USER_MEMORY_MAX_CHARS,
    updatedAt: '2026-11-20T12:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('user-memory protocol helpers and guards', () => {
  it('renders non-empty sections in canonical order and counts Unicode code points', () => {
    const sections = {
      ...emptyUserMemorySections(),
      identity: 'Dog: Beans 🐶',
      preferences: 'Concise answers.',
    };
    const rendered = renderUserMemorySections(sections);
    expect(rendered).toBe('- Identity: Dog: Beans 🐶\n- Preferences: Concise answers.');
    expect(userMemoryCharCount('🐶')).toBe(1);
    expect(userMemoryCharCount(rendered)).toBe(Array.from(rendered).length);
  });

  it('validates composer instructions for empty, secret, control chars, and 500-char cap', () => {
    expect(validateMemoryInstruction('   ').error).toBe('required');
    expect(validateMemoryInstruction('Remember my key sk-or-v1-secret123').error).toBe('secret_pattern');
    expect(validateMemoryInstruction('mongodb+srv://user:pass@host/db').error).toBe('secret_pattern');
    expect(validateMemoryInstruction('Bad\u0007bell').error).toBe('disallowed_characters');
    expect(validateMemoryInstruction('a'.repeat(USER_MEMORY_INSTRUCTION_MAX_CHARS)).error).toBeNull();
    expect(validateMemoryInstruction('a'.repeat(USER_MEMORY_INSTRUCTION_MAX_CHARS + 1)).error).toBe('out_of_range');
    expect(validateMemoryInstruction('🐶'.repeat(USER_MEMORY_INSTRUCTION_MAX_CHARS)).error).toBeNull();
  });

  it('validates strict UserMemoryResponse, UserMemoryEditResponse, and UserMemoryErrorBody shapes', () => {
    const base = sampleMemory();
    expect(isUserMemoryResponse(base)).toBe(true);
    expect(isUserMemoryResponse({ ...base, extra: true })).toBe(false);
    expect(isUserMemoryResponse({ ...base, revision: 0, updatedAt: null, isEmpty: true, charCount: 0, sections: emptyUserMemorySections() })).toBe(true);
    expect(isUserMemoryResponse({ ...base, maxChars: 3000 })).toBe(false);

    const editRes: UserMemoryEditResponse = { ...base, changeSummary: 'Added dog Beans to Identity' };
    expect(isUserMemoryEditResponse(editRes)).toBe(true);
    expect(isUserMemoryEditResponse(base)).toBe(false);
    expect(isUserMemoryEditResponse({ ...editRes, changeSummary: 'sk-or-v1-leak' })).toBe(false);

    expect(
      isUserMemoryErrorBody({
        protocolVersion: 1,
        error: {
          code: 'MEMORY_CONFLICT',
          message: 'Memory changed elsewhere. Reload and try again.',
          retryable: false,
          currentRevision: 4,
        },
      }),
    ).toBe(true);
    expect(
      isUserMemoryErrorBody({
        protocolVersion: 1,
        error: { code: 'UNKNOWN', message: 'nope', retryable: false, currentRevision: null },
      }),
    ).toBe(false);
  });
});

describe('user-memory HTTP client', () => {
  it('calls GET, PATCH enabled, POST edit, and POST clear with no-store private fetch options', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createUserMemoryClient({ baseUrl: '/api/', fetch: fetcher });

    const initial = sampleMemory({ revision: 1, enabled: true });
    const paused = sampleMemory({ revision: 2, enabled: false });
    const edited: UserMemoryEditResponse = {
      ...sampleMemory({
        revision: 3,
        enabled: false,
        sections: { ...emptyUserMemorySections(), identity: 'Name: Peter. Dog: Beans.', work: 'Builds Aurvin.' },
      }),
      changeSummary: 'Updated Work',
    };
    const cleared = sampleMemory({
      revision: 4,
      enabled: false,
      sections: emptyUserMemorySections(),
    });

    fetcher
      .mockResolvedValueOnce(jsonResponse(initial))
      .mockResolvedValueOnce(jsonResponse(paused))
      .mockResolvedValueOnce(jsonResponse(edited))
      .mockResolvedValueOnce(jsonResponse(cleared));

    await expect(client.read()).resolves.toEqual(initial);
    await expect(client.setEnabled({ protocolVersion: 1, expectedRevision: 1, enabled: false })).resolves.toEqual(paused);
    await expect(
      client.edit({ protocolVersion: 1, expectedRevision: 2, instruction: '  I build Aurvin.  ' }),
    ).resolves.toEqual(edited);
    await expect(client.clear({ protocolVersion: 1, expectedRevision: 3 })).resolves.toEqual(cleared);

    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/personalization/memory');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      credentials: 'same-origin',
    });

    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/personalization/memory/enabled');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH', cache: 'no-store' });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      protocolVersion: 1,
      expectedRevision: 1,
      enabled: false,
    });

    expect(fetcher.mock.calls[2]?.[0]).toBe('/api/personalization/memory/edit');
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', cache: 'no-store' });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      protocolVersion: 1,
      expectedRevision: 2,
      instruction: 'I build Aurvin.',
    });

    expect(fetcher.mock.calls[3]?.[0]).toBe('/api/personalization/memory/clear');
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({ method: 'POST', cache: 'no-store' });
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({
      protocolVersion: 1,
      expectedRevision: 3,
    });
  });

  it('rejects invalid requests before fetch without hitting the network', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createUserMemoryClient({ fetch: fetcher });

    await expect(
      client.edit({ protocolVersion: 1, expectedRevision: 0, instruction: '   ' }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_MEMORY_REQUEST' });
    await expect(
      client.edit({ protocolVersion: 1, expectedRevision: 0, instruction: 'Use sk-or-v1-secret123' }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_MEMORY_REQUEST' });
    await expect(
      client.edit({ protocolVersion: 1, expectedRevision: 0, instruction: 'x'.repeat(501) }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_MEMORY_REQUEST' });
    await expect(
      client.clear({ protocolVersion: 1, expectedRevision: -1 }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_MEMORY_REQUEST' });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('surfaces 409 MEMORY_CONFLICT with currentRevision, 503 writer errors, and rejects oversized responses', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createUserMemoryClient({ fetch: fetcher });

    fetcher.mockResolvedValueOnce(
      jsonResponse(
        {
          protocolVersion: 1,
          error: {
            code: 'MEMORY_CONFLICT',
            message: 'Memory changed elsewhere. Reload and try again.',
            retryable: false,
            currentRevision: 7,
          },
        },
        409,
      ),
    );
    const conflict = await client
      .clear({ protocolVersion: 1, expectedRevision: 3 })
      .catch(err => err);
    expect(conflict).toBeInstanceOf(UserMemoryClientError);
    expect(conflict).toMatchObject({
      code: 'MEMORY_CONFLICT',
      status: 409,
      retryable: false,
      currentRevision: 7,
    });

    fetcher.mockResolvedValueOnce(
      jsonResponse(
        {
          protocolVersion: 1,
          error: {
            code: 'MEMORY_WRITER_UNAVAILABLE',
            message: 'The memory writer could not apply this request.',
            retryable: true,
            currentRevision: null,
          },
        },
        503,
      ),
    );
    await expect(
      client.edit({ protocolVersion: 1, expectedRevision: 7, instruction: 'Remember I like tea.' }),
    ).rejects.toMatchObject({
      code: 'MEMORY_WRITER_UNAVAILABLE',
      status: 503,
      retryable: true,
    });

    fetcher.mockResolvedValueOnce(new Response('x'.repeat(32_769), { status: 200 }));
    await expect(client.read()).rejects.toMatchObject({
      code: 'INVALID_USER_MEMORY_RESPONSE',
      status: 200,
    });
  });

  it('classifies caller abort and request timeout cleanly', async () => {
    const abort = new AbortController();
    const hanging = vi.fn<typeof fetch>((_url, init) => new Promise((_, reject) => {
      const fail = () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener('abort', fail, { once: true });
    }));
    const client = createUserMemoryClient({ fetch: hanging });

    const abortedRead = client.read(abort.signal);
    abort.abort();
    await expect(abortedRead).rejects.toMatchObject({ code: 'ABORTED', retryable: false });

    vi.useFakeTimers();
    const timedOut = client.read();
    const expectation = expect(timedOut).rejects.toMatchObject({
      code: 'USER_MEMORY_REQUEST_TIMEOUT',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/api/user-memory-client.test.ts`
Expected: FAIL with missing module errors for `./user-memory-client.ts` and `./user-memory-protocol.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/api/user-memory-protocol.ts`:

```typescript
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
```

Create `frontend/src/api/user-memory-client.ts`:

```typescript
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
    setEnabled(enabledRequest, signal) {
      const validated = assertEnabledRequest(enabledRequest);
      return request(
        'PATCH',
        USER_MEMORY_ROUTES.enabled,
        JSON.stringify(validated),
        signal,
        isUserMemoryResponse,
      );
    },
    edit(editRequest, signal) {
      const validated = assertEditRequest(editRequest);
      return request(
        'POST',
        USER_MEMORY_ROUTES.edit,
        JSON.stringify(validated),
        signal,
        isUserMemoryEditResponse,
      );
    },
    clear(clearRequest, signal) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- src/api/user-memory-client.test.ts`
Expected: PASS (7/7 tests passing).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/user-memory-protocol.ts frontend/src/api/user-memory-client.ts frontend/src/api/user-memory-client.test.ts
git commit -m "feat(frontend): add user-memory protocol and bounded HTTP client"
```

---

### Task 2: Independent User Memory Reducer & Selectors (`user-memory-state.ts`)

**Files:**
- Create: `frontend/src/features/personalization/user-memory-state.ts`
- Test: `frontend/src/features/personalization/user-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/personalization/user-memory.test.ts`:

```typescript
/**
 * ============================================================================
 * FILE: user-memory.test.ts
 * LOCATION: frontend/src/features/personalization/user-memory.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify independent user-memory state reducer, budget/composer selectors,
 *    isolation from Tone/Location personalization state, and MemoryCard SSR.
 *
 * ROLE IN PROJECT:
 *    Exercises AC7 Personalization MemoryCard state and markup cleanly in
 *    Vitest's Node environment without browser DOM dependencies.
 *
 * KEY COMPONENTS:
 *    - Reducer transitions: load, toggle, composer edit, clear, 409 conflict.
 *    - Isolation check against personalizationReducer dirty/revision state.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { defaultPersonalizationSettings } from '../../api/personalization-protocol.ts';
import {
  emptyUserMemorySections,
  renderUserMemorySections,
  USER_MEMORY_INSTRUCTION_MAX_CHARS,
  USER_MEMORY_MAX_CHARS,
  userMemoryCharCount,
  type UserMemoryEditResponse,
  type UserMemoryResponse,
} from '../../api/user-memory-protocol.ts';
import {
  initialPersonalizationState,
  isPersonalizationDirty,
  personalizationReducer,
} from './personalization-state.ts';
import {
  canClearMemory,
  canSubmitMemoryEdit,
  clientComposerValidationError,
  formatMemoryApplyStatus,
  initialUserMemoryState,
  memoryBudgetStatus,
  nonEmptyMemorySections,
  userMemoryReducer,
} from './user-memory-state.ts';

function memoryResponse(overrides: Partial<UserMemoryResponse> = {}): UserMemoryResponse {
  const sections = overrides.sections ?? emptyUserMemorySections();
  const rendered = renderUserMemorySections(sections);
  return {
    protocolVersion: 1,
    revision: 0,
    enabled: true,
    sections,
    isEmpty: rendered.length === 0,
    charCount: userMemoryCharCount(rendered),
    maxChars: USER_MEMORY_MAX_CHARS,
    updatedAt: null,
    ...overrides,
  };
}

describe('user-memory state reducer and selectors', () => {
  it('computes non-empty categorized sections and char budget levels accurately', () => {
    const sections = {
      ...emptyUserMemorySections(),
      identity: 'Name: Peter. Dog: Beans.',
      ongoing: 'Shipping Aurvin user memory.',
    };
    expect(nonEmptyMemorySections(sections)).toEqual([
      { key: 'identity', label: 'Identity', text: 'Name: Peter. Dog: Beans.' },
      { key: 'ongoing', label: 'Ongoing', text: 'Shipping Aurvin user memory.' },
    ]);
    expect(nonEmptyMemorySections(emptyUserMemorySections())).toEqual([]);

    expect(memoryBudgetStatus(0, 2500)).toEqual({
      percent: 0,
      level: 'normal',
      label: '0 / 2500 chars',
    });
    expect(memoryBudgetStatus(2125, 2500)).toEqual({
      percent: 85,
      level: 'near',
      label: '2125 / 2500 chars',
    });
    expect(memoryBudgetStatus(2500, 2500)).toEqual({
      percent: 100,
      level: 'full',
      label: '2500 / 2500 chars',
    });
  });

  it('validates composer drafts inline without flagging a pristine empty composer', () => {
    expect(clientComposerValidationError('')).toBeNull();
    expect(clientComposerValidationError('   ')).toBeNull();
    expect(clientComposerValidationError('My dog is named Beans')).toBeNull();
    expect(clientComposerValidationError('Use sk-or-v1-secret123')).toContain('API keys');
    expect(clientComposerValidationError('bad\u0007char')).toContain('control characters');
    expect(clientComposerValidationError('a'.repeat(USER_MEMORY_INSTRUCTION_MAX_CHARS + 1))).toContain(
      String(USER_MEMORY_INSTRUCTION_MAX_CHARS),
    );
    expect(formatMemoryApplyStatus('Updated Identity')).toBe(
      'Updated Identity — applies to new chats.',
    );
    expect(formatMemoryApplyStatus('   ')).toBe('Memory checked — no changes needed.');
  });

  it('handles load, toggle pause, paused edit/clear eligibility, composer apply, and 409 conflict reload', () => {
    let state = initialUserMemoryState();
    expect(state.phase).toBe('loading');
    expect(canClearMemory(state)).toBe(false);
    expect(canSubmitMemoryEdit(state)).toBe(false);

    // Load populated memory
    state = userMemoryReducer(state, {
      type: 'loaded',
      response: memoryResponse({
        revision: 2,
        enabled: true,
        sections: { ...emptyUserMemorySections(), identity: 'Name: Peter.' },
        updatedAt: '2026-11-20T12:00:00.000Z',
      }),
    });
    expect(state.phase).toBe('ready');
    expect(state.revision).toBe(2);
    expect(canClearMemory(state)).toBe(true);
    expect(canSubmitMemoryEdit(state)).toBe(false);

    // Pause memory: edit and clear remain allowed while paused
    state = userMemoryReducer(state, { type: 'begin', kind: 'toggling' });
    expect(state.busy).toBe('toggling');
    state = userMemoryReducer(state, {
      type: 'loaded',
      response: memoryResponse({
        revision: 3,
        enabled: false,
        sections: { ...emptyUserMemorySections(), identity: 'Name: Peter.' },
        updatedAt: '2026-11-20T12:01:00.000Z',
      }),
      statusMessage: 'Memory paused. Existing details stay saved until you clear them.',
    });
    expect(state.enabled).toBe(false);
    expect(state.revision).toBe(3);
    expect(canClearMemory(state)).toBe(true);

    // Type composer instruction while paused and apply
    state = userMemoryReducer(state, { type: 'setComposerDraft', value: 'My dog is Beans' });
    expect(canSubmitMemoryEdit(state)).toBe(true);
    state = userMemoryReducer(state, { type: 'begin', kind: 'editing' });
    expect(canSubmitMemoryEdit(state)).toBe(false);

    const editRes: UserMemoryEditResponse = {
      ...memoryResponse({
        revision: 4,
        enabled: false,
        sections: { ...emptyUserMemorySections(), identity: 'Name: Peter. Dog: Beans.' },
        updatedAt: '2026-11-20T12:02:00.000Z',
      }),
      changeSummary: 'Updated Identity',
    };
    state = userMemoryReducer(state, { type: 'editSucceeded', response: editRes });
    expect(state.revision).toBe(4);
    expect(state.composerDraft).toBe('');
    expect(state.statusMessage).toBe('Updated Identity — applies to new chats.');
    expect(state.sections.identity).toBe('Name: Peter. Dog: Beans.');

    // Failed edit preserves composerDraft; MEMORY_CONFLICT locks mutations until reload
    state = userMemoryReducer(state, { type: 'setComposerDraft', value: 'Prefer dark mode' });
    state = userMemoryReducer(state, { type: 'begin', kind: 'editing' });
    state = userMemoryReducer(state, {
      type: 'failed',
      code: 'MEMORY_CONFLICT',
      message: 'Memory changed elsewhere. Reload and try again.',
      currentRevision: 6,
    });
    expect(state.conflictRevision).toBe(6);
    expect(state.composerDraft).toBe('Prefer dark mode');
    expect(canSubmitMemoryEdit(state)).toBe(false);
    expect(canClearMemory(state)).toBe(false);

    // Reload clears conflict and restores cleared empty state
    state = userMemoryReducer(state, {
      type: 'loaded',
      response: memoryResponse({ revision: 6, enabled: true, sections: emptyUserMemorySections() }),
    });
    expect(state.conflictRevision).toBeNull();
    expect(state.isEmpty).toBe(true);
    expect(canClearMemory(state)).toBe(false);
  });

  it('keeps memory revision, composer draft, and clear state completely isolated from Tone/Instructions/Location state', () => {
    let pState = personalizationReducer(initialPersonalizationState(), {
      type: 'loaded',
      response: {
        protocolVersion: 1,
        revision: 5,
        settings: defaultPersonalizationSettings(),
        isDefault: true,
      },
    });
    let mState = userMemoryReducer(initialUserMemoryState(), {
      type: 'loaded',
      response: memoryResponse({
        revision: 1,
        enabled: true,
        sections: { ...emptyUserMemorySections(), work: 'Builds Aurvin.' },
      }),
    });

    // Mutate Tone and Instructions to make Personalization dirty
    pState = personalizationReducer(pState, { type: 'setAmplitude', field: 'warmth', value: 'high' });
    pState = personalizationReducer(pState, {
      type: 'setCustomInstructions',
      value: 'Use short bullets.',
    });
    expect(isPersonalizationDirty(pState)).toBe(true);

    // Mutating and clearing Memory changes only mState revision/sections, never pState
    mState = userMemoryReducer(mState, { type: 'setComposerDraft', value: 'Forget my work' });
    mState = userMemoryReducer(mState, {
      type: 'loaded',
      response: memoryResponse({ revision: 2, enabled: true, sections: emptyUserMemorySections() }),
      statusMessage: 'Memory cleared.',
    });
    expect(mState.revision).toBe(2);
    expect(mState.isEmpty).toBe(true);
    expect(pState.revision).toBe(5);
    expect(pState.draft.warmth).toBe('high');
    expect(pState.draft.customInstructions).toBe('Use short bullets.');
    expect(isPersonalizationDirty(pState)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/features/personalization/user-memory.test.ts`
Expected: FAIL with missing module `./user-memory-state.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/features/personalization/user-memory-state.ts`:

```typescript
/**
 * ============================================================================
 * FILE: user-memory-state.ts
 * LOCATION: frontend/src/features/personalization/user-memory-state.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Pure reducer and selectors for the independent Personalization MemoryCard.
 *
 * ROLE IN PROJECT:
 *    Owns memory revision CAS, enabled toggle, categorized read-only summary,
 *    char budget meter, and composer state strictly isolated from Tone, Custom
 *    Instructions, and Location form drafts.
 *
 * KEY COMPONENTS:
 *    - userMemoryReducer / initialUserMemoryState
 *    - nonEmptyMemorySections / memoryBudgetStatus / clientComposerValidationError
 *    - canSubmitMemoryEdit / canClearMemory / formatMemoryApplyStatus
 * ============================================================================
 */

import {
  cloneUserMemorySections,
  emptyUserMemorySections,
  USER_MEMORY_INSTRUCTION_MAX_CHARS,
  USER_MEMORY_MAX_CHARS,
  USER_MEMORY_SECTION_KEYS,
  USER_MEMORY_SECTION_LABELS,
  validateMemoryInstruction,
  type UserMemoryEditResponse,
  type UserMemoryErrorCode,
  type UserMemoryResponse,
  type UserMemorySectionKey,
  type UserMemorySections,
} from '../../api/user-memory-protocol.ts';

export type UserMemoryPhase = 'loading' | 'ready' | 'unavailable';
export type UserMemoryBusy = 'toggling' | 'editing' | 'clearing' | null;

export type UserMemoryState = {
  phase: UserMemoryPhase;
  revision: number;
  enabled: boolean;
  sections: UserMemorySections;
  isEmpty: boolean;
  charCount: number;
  maxChars: number;
  updatedAt: string | null;
  composerDraft: string;
  busy: UserMemoryBusy;
  conflictRevision: number | null;
  statusMessage: string | null;
  errorMessage: string | null;
};

export type UserMemoryAction =
  | { type: 'loading' }
  | { type: 'loaded'; response: UserMemoryResponse; statusMessage?: string | null }
  | { type: 'editSucceeded'; response: UserMemoryEditResponse }
  | { type: 'loadFailed'; message: string }
  | { type: 'setComposerDraft'; value: string }
  | { type: 'begin'; kind: Exclude<UserMemoryBusy, null> }
  | {
      type: 'failed';
      code?: UserMemoryErrorCode | string;
      message: string;
      currentRevision?: number | null;
    };

export type RenderedMemorySection = {
  key: UserMemorySectionKey;
  label: string;
  text: string;
};

export type MemoryBudgetStatus = {
  percent: number;
  level: 'normal' | 'near' | 'full';
  label: string;
};

export function initialUserMemoryState(): UserMemoryState {
  return {
    phase: 'loading',
    revision: 0,
    enabled: true,
    sections: emptyUserMemorySections(),
    isEmpty: true,
    charCount: 0,
    maxChars: USER_MEMORY_MAX_CHARS,
    updatedAt: null,
    composerDraft: '',
    busy: null,
    conflictRevision: null,
    statusMessage: null,
    errorMessage: null,
  };
}

export function nonEmptyMemorySections(sections: UserMemorySections): RenderedMemorySection[] {
  const result: RenderedMemorySection[] = [];
  for (const key of USER_MEMORY_SECTION_KEYS) {
    const text = sections[key];
    if (text !== '') {
      result.push({ key, label: USER_MEMORY_SECTION_LABELS[key], text });
    }
  }
  return result;
}

export function memoryBudgetStatus(charCount: number, maxChars: number): MemoryBudgetStatus {
  const safeMax = maxChars > 0 ? maxChars : USER_MEMORY_MAX_CHARS;
  const clamped = Math.max(0, Math.min(charCount, safeMax));
  const percent = Math.round((clamped / safeMax) * 100);
  const level: MemoryBudgetStatus['level'] =
    clamped >= safeMax ? 'full' : percent >= 85 ? 'near' : 'normal';
  return { percent, level, label: `${charCount} / ${safeMax} chars` };
}

export function clientComposerValidationError(draft: string): string | null {
  if (draft.trim().length === 0) return null;
  const checked = validateMemoryInstruction(draft);
  if (checked.error === 'disallowed_characters') {
    return 'Memory updates cannot contain unsupported control characters.';
  }
  if (checked.error === 'secret_pattern') {
    return 'Memory updates cannot contain API keys, tokens, or connection strings.';
  }
  if (checked.error === 'out_of_range') {
    return `Memory updates must be ${USER_MEMORY_INSTRUCTION_MAX_CHARS} characters or fewer.`;
  }
  return null;
}

export function canSubmitMemoryEdit(state: UserMemoryState): boolean {
  if (state.phase !== 'ready' || state.busy !== null || state.conflictRevision !== null) {
    return false;
  }
  return validateMemoryInstruction(state.composerDraft).error === null;
}

export function canClearMemory(state: UserMemoryState): boolean {
  return (
    state.phase === 'ready' &&
    !state.isEmpty &&
    state.busy === null &&
    state.conflictRevision === null
  );
}

export function formatMemoryApplyStatus(changeSummary: string): string {
  const summary = changeSummary.trim();
  if (summary.length === 0) return 'Memory checked — no changes needed.';
  return `${summary} — applies to new chats.`;
}

function applyResponse(
  state: UserMemoryState,
  response: UserMemoryResponse,
  options: { statusMessage: string | null; clearDraft: boolean },
): UserMemoryState {
  return {
    phase: 'ready',
    revision: response.revision,
    enabled: response.enabled,
    sections: cloneUserMemorySections(response.sections),
    isEmpty: response.isEmpty,
    charCount: response.charCount,
    maxChars: response.maxChars,
    updatedAt: response.updatedAt,
    composerDraft: options.clearDraft ? '' : state.composerDraft,
    busy: null,
    conflictRevision: null,
    statusMessage: options.statusMessage,
    errorMessage: null,
  };
}

export function userMemoryReducer(
  state: UserMemoryState,
  action: UserMemoryAction,
): UserMemoryState {
  switch (action.type) {
    case 'loading':
      return {
        ...state,
        phase: 'loading',
        busy: null,
        conflictRevision: null,
        errorMessage: null,
      };
    case 'loaded':
      return applyResponse(state, action.response, {
        statusMessage: action.statusMessage ?? null,
        clearDraft: false,
      });
    case 'editSucceeded':
      return applyResponse(state, action.response, {
        statusMessage: formatMemoryApplyStatus(action.response.changeSummary),
        clearDraft: true,
      });
    case 'loadFailed':
      return {
        ...state,
        phase: 'unavailable',
        busy: null,
        statusMessage: null,
        errorMessage: action.message,
      };
    case 'setComposerDraft':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        composerDraft: action.value,
        errorMessage: null,
      };
    case 'begin':
      if (state.phase !== 'ready' || state.busy !== null || state.conflictRevision !== null) {
        return state;
      }
      return {
        ...state,
        busy: action.kind,
        statusMessage: null,
        errorMessage: null,
      };
    case 'failed':
      return {
        ...state,
        busy: null,
        conflictRevision:
          action.code === 'MEMORY_CONFLICT'
            ? (action.currentRevision ?? state.revision)
            : state.conflictRevision,
        errorMessage: action.message,
      };
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- src/features/personalization/user-memory.test.ts`
Expected: PASS (4/4 tests passing).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/personalization/user-memory-state.ts frontend/src/features/personalization/user-memory.test.ts
git commit -m "feat(frontend): add independent user-memory state reducer and selectors"
```

---

### Task 3: `MemoryCard` Component & Personalization Styles

**Files:**
- Create: `frontend/src/features/personalization/MemoryCard.tsx`
- Modify: `frontend/src/features/personalization/personalization.css:540-585`
- Test: `frontend/src/features/personalization/user-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Update the imports at the top of `frontend/src/features/personalization/user-memory.test.ts` to add `createElement`, `renderToStaticMarkup`, `vi`, `createUserMemoryClient`, and `MemoryCard`:

```typescript
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createUserMemoryClient } from '../../api/user-memory-client.ts';
import { MemoryCard } from './MemoryCard.tsx';
```

Then append the following `describe` block at the bottom of `frontend/src/features/personalization/user-memory.test.ts`:

```typescript
describe('MemoryCard rendering', () => {
  const noopClient = createUserMemoryClient({
    fetch: vi.fn(async () => new Response('{}', { status: 200 })),
  });

  it('renders empty state, master toggle switch, budget meter, disabled clear, and bottom composer', () => {
    const emptyState = userMemoryReducer(initialUserMemoryState(), {
      type: 'loaded',
      response: memoryResponse({ revision: 0, enabled: true, sections: emptyUserMemorySections() }),
    });
    const html = renderToStaticMarkup(
      createElement(MemoryCard, { client: noopClient, initialState: emptyState }),
    );
    expect(html).toContain('id="aurvin-personalization-memory"');
    expect(html).toContain('Memory');
    expect(html).toContain('Aurvin learns concise personal details across chats and applies updates to new sessions.');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Nothing remembered yet. Aurvin will learn as you chat, or tell it below.');
    expect(html).toContain('0 / 2500 chars');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('placeholder="e.g., My dog&#x27;s name is Beans"');
    expect(html).toContain('Clear memory');
    expect(html).not.toContain('<textarea');
  });

  it('renders only non-empty read-only categorized sections, paused notice, status banner, and conflict reload', () => {
    const populated = userMemoryReducer(initialUserMemoryState(), {
      type: 'loaded',
      response: memoryResponse({
        revision: 3,
        enabled: false,
        sections: {
          ...emptyUserMemorySections(),
          identity: 'Name: Peter. Dog: Beans.',
          preferences: 'Concise answers.',
        },
        updatedAt: '2026-11-20T12:00:00.000Z',
      }),
      statusMessage: 'Updated Identity — applies to new chats.',
    });
    const html = renderToStaticMarkup(
      createElement(MemoryCard, { client: noopClient, initialState: populated }),
    );
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('Memory is paused');
    expect(html).toContain('>Identity<');
    expect(html).toContain('Name: Peter. Dog: Beans.');
    expect(html).toContain('>Preferences<');
    expect(html).toContain('Concise answers.');
    expect(html).not.toContain('>Work<');
    expect(html).not.toContain('>Ongoing<');
    expect(html).not.toContain('>Other<');
    expect(html).toContain('Updated Identity — applies to new chats.');

    const conflicted = userMemoryReducer(populated, {
      type: 'failed',
      code: 'MEMORY_CONFLICT',
      message: 'Memory changed elsewhere. Reload and try again.',
      currentRevision: 5,
    });
    const conflictHtml = renderToStaticMarkup(
      createElement(MemoryCard, { client: noopClient, initialState: conflicted }),
    );
    expect(conflictHtml).toContain('Reload memory');
    expect(conflictHtml).toContain('Memory changed elsewhere');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/features/personalization/user-memory.test.ts`
Expected: FAIL with missing module `./MemoryCard.tsx`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/features/personalization/MemoryCard.tsx`:

```tsx
/**
 * ============================================================================
 * FILE: MemoryCard.tsx
 * LOCATION: frontend/src/features/personalization/MemoryCard.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render the independent cross-session User Memory card inside Personalization.
 *
 * ROLE IN PROJECT:
 *    Exposes the master enable toggle, read-only categorized caveman summary,
 *    char budget meter, Claude-style natural-language composer, and danger
 *    ConfirmDialog clear-all with revision state isolated from Tone/Location.
 *
 * KEY COMPONENTS:
 *    - MemoryCard: Self-contained fetch/CAS card anchored at #aurvin-personalization-memory.
 * ============================================================================
 */

import { useCallback, useEffect, useId, useReducer, useRef, useState, type FormEvent } from 'react';
import {
  createUserMemoryClient,
  UserMemoryClientError,
  type UserMemoryClient,
} from '../../api/user-memory-client.ts';
import {
  USER_MEMORY_INSTRUCTION_MAX_CHARS,
  userMemoryCharCount,
} from '../../api/user-memory-protocol.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import {
  canClearMemory,
  canSubmitMemoryEdit,
  clientComposerValidationError,
  initialUserMemoryState,
  memoryBudgetStatus,
  nonEmptyMemorySections,
  userMemoryReducer,
  type UserMemoryState,
} from './user-memory-state.ts';

export const MEMORY_CARD_ELEMENT_ID = 'aurvin-personalization-memory';

export type MemoryCardProps = {
  client?: UserMemoryClient;
  disabled?: boolean;
  initialState?: UserMemoryState;
  onBusyChange?: (busy: boolean) => void;
};

const defaultMemoryClient = createUserMemoryClient();

function initState(provided?: UserMemoryState): UserMemoryState {
  return provided ?? initialUserMemoryState();
}

export function MemoryCard({
  client = defaultMemoryClient,
  disabled = false,
  initialState,
  onBusyChange,
}: MemoryCardProps) {
  const ids = useId();
  const [state, dispatch] = useReducer(userMemoryReducer, initialState, initState);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const requestEpoch = useRef(0);

  const busy = state.busy !== null;
  const controlsLocked = disabled || busy || state.conflictRevision !== null;
  const sections = nonEmptyMemorySections(state.sections);
  const budget = memoryBudgetStatus(state.charCount, state.maxChars);
  const composerError = state.phase === 'ready' ? clientComposerValidationError(state.composerDraft) : null;
  const composerCharCount = userMemoryCharCount(state.composerDraft);
  const canApply = !disabled && canSubmitMemoryEdit(state);
  const canClear = !disabled && canClearMemory(state);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const loadMemory = useCallback(() => {
    const epoch = ++requestEpoch.current;
    const abort = new AbortController();
    dispatch({ type: 'loading' });
    void client
      .read(abort.signal)
      .then(response => {
        if (epoch !== requestEpoch.current) return;
        dispatch({ type: 'loaded', response });
      })
      .catch(error => {
        if (epoch !== requestEpoch.current) return;
        const message =
          error instanceof UserMemoryClientError && error.code === 'NOT_READY'
            ? 'Memory storage is unavailable right now.'
            : 'Memory could not be loaded.';
        dispatch({ type: 'loadFailed', message });
      });
    return () => {
      abort.abort();
      requestEpoch.current += 1;
    };
  }, [client]);

  useEffect(() => {
    if (initialState) return undefined;
    return loadMemory();
  }, [initialState, loadMemory]);

  const handleToggleEnabled = async () => {
    if (controlsLocked || state.phase !== 'ready') return;
    const nextEnabled = !state.enabled;
    const epoch = ++requestEpoch.current;
    dispatch({ type: 'begin', kind: 'toggling' });
    try {
      const response = await client.setEnabled({
        protocolVersion: 1,
        expectedRevision: state.revision,
        enabled: nextEnabled,
      });
      if (epoch !== requestEpoch.current) return;
      dispatch({
        type: 'loaded',
        response,
        statusMessage: nextEnabled
          ? 'Memory enabled — applies to new chats.'
          : 'Memory paused. Saved details remain stored until you clear them.',
      });
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      if (error instanceof UserMemoryClientError) {
        dispatch({
          type: 'failed',
          code: error.code,
          message:
            error.code === 'MEMORY_CONFLICT'
              ? 'Memory was updated elsewhere. Reload to get the latest details.'
              : error.message,
          currentRevision: error.currentRevision,
        });
      } else {
        dispatch({ type: 'failed', message: 'Memory setting could not be updated.' });
      }
    }
  };

  const handleApplyEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canApply) return;
    const epoch = ++requestEpoch.current;
    dispatch({ type: 'begin', kind: 'editing' });
    try {
      const response = await client.edit({
        protocolVersion: 1,
        expectedRevision: state.revision,
        instruction: state.composerDraft,
      });
      if (epoch !== requestEpoch.current) return;
      dispatch({ type: 'editSucceeded', response });
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      if (error instanceof UserMemoryClientError) {
        dispatch({
          type: 'failed',
          code: error.code,
          message:
            error.code === 'MEMORY_CONFLICT'
              ? 'Memory was updated elsewhere. Reload to get the latest details.'
              : error.message,
          currentRevision: error.currentRevision,
        });
      } else {
        dispatch({ type: 'failed', message: 'Memory update could not be applied.' });
      }
    }
  };

  const executeClear = async () => {
    setConfirmClearOpen(false);
    if (!canClear) return;
    const epoch = ++requestEpoch.current;
    dispatch({ type: 'begin', kind: 'clearing' });
    try {
      const response = await client.clear({
        protocolVersion: 1,
        expectedRevision: state.revision,
      });
      if (epoch !== requestEpoch.current) return;
      dispatch({
        type: 'loaded',
        response,
        statusMessage: 'Memory cleared — applies to new chats.',
      });
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      if (error instanceof UserMemoryClientError) {
        dispatch({
          type: 'failed',
          code: error.code,
          message:
            error.code === 'MEMORY_CONFLICT'
              ? 'Memory was updated elsewhere. Reload to get the latest details.'
              : error.message,
          currentRevision: error.currentRevision,
        });
      } else {
        dispatch({ type: 'failed', message: 'Memory could not be cleared.' });
      }
    }
  };

  return (
    <section
      id={MEMORY_CARD_ELEMENT_ID}
      tabIndex={-1}
      className="aurvin-personalization-card aurvin-memory-card"
      aria-labelledby={`${ids}-memory-title`}
    >
      <div className="aurvin-memory-header">
        <div className="aurvin-memory-heading-group">
          <h3 id={`${ids}-memory-title`} className="aurvin-personalization-card-title">
            Memory
          </h3>
          <p className="aurvin-memory-subtitle">
            Aurvin learns concise personal details across chats and applies updates to new sessions.
          </p>
        </div>

        {state.phase === 'ready' ? (
          <div className="aurvin-memory-toggle-wrap">
            <span id={`${ids}-enable-label`} className="aurvin-memory-toggle-label">
              Enable memory
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={state.enabled}
              aria-labelledby={`${ids}-enable-label`}
              className={`aurvin-memory-switch${state.enabled ? ' is-on' : ''}`}
              disabled={controlsLocked}
              onClick={() => {
                void handleToggleEnabled();
              }}
            >
              <span className="aurvin-memory-switch-thumb" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>

      {state.phase === 'loading' ? (
        <div className="aurvin-memory-loading" role="status">
          Loading memory…
        </div>
      ) : null}

      {state.phase === 'unavailable' ? (
        <div className="aurvin-personalization-alert is-error" role="alert">
          <p>{state.errorMessage ?? 'Memory is unavailable right now.'}</p>
          <button
            type="button"
            className="aurvin-personalization-btn"
            onClick={() => loadMemory()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.phase === 'ready' ? (
        <>
          {!state.enabled ? (
            <p className="aurvin-memory-paused-note">
              Memory is paused. Automatic learning and memory injection into new chats are off, but
              your saved details remain stored and you can still edit or clear them below.
            </p>
          ) : null}

          {state.conflictRevision !== null ? (
            <div className="aurvin-personalization-alert is-warning" role="alert">
              <p>{state.errorMessage}</p>
              <button
                type="button"
                className="aurvin-personalization-btn"
                onClick={() => loadMemory()}
              >
                Reload memory
              </button>
            </div>
          ) : state.errorMessage ? (
            <div className="aurvin-personalization-alert is-error" role="alert">
              <p>{state.errorMessage}</p>
            </div>
          ) : null}

          {sections.length > 0 ? (
            <dl className="aurvin-memory-sections">
              {sections.map(item => (
                <div key={item.key} className="aurvin-memory-section">
                  <dt className="aurvin-memory-section-label">{item.label}</dt>
                  <dd className="aurvin-memory-section-text">{item.text}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="aurvin-memory-empty">
              Nothing remembered yet. Aurvin will learn as you chat, or tell it below.
            </p>
          )}

          <div className="aurvin-memory-meta-row">
            <div className="aurvin-memory-budget">
              <div className="aurvin-memory-budget-top">
                <span className="aurvin-memory-budget-label">Memory capacity</span>
                <span
                  className={`aurvin-personalization-counter${
                    budget.level === 'full'
                      ? ' is-over'
                      : budget.level === 'near'
                        ? ' is-near'
                        : ''
                  }`}
                >
                  {budget.label}
                </span>
              </div>
              <div
                className="aurvin-memory-budget-track"
                role="progressbar"
                aria-label="Memory character budget"
                aria-valuemin={0}
                aria-valuemax={state.maxChars}
                aria-valuenow={state.charCount}
              >
                <div
                  className={`aurvin-memory-budget-fill is-${budget.level}`}
                  style={{ width: `${budget.percent}%` }}
                />
              </div>
            </div>

            <button
              type="button"
              className="aurvin-personalization-btn"
              disabled={!canClear}
              onClick={() => setConfirmClearOpen(true)}
            >
              Clear memory
            </button>
          </div>

          <form
            className="aurvin-memory-composer"
            onSubmit={event => {
              void handleApplyEdit(event);
            }}
          >
            <label htmlFor={`${ids}-composer`} className="aurvin-personalization-field-label">
              Update or forget something
            </label>
            <div className="aurvin-memory-composer-row">
              <input
                id={`${ids}-composer`}
                type="text"
                className="aurvin-personalization-input"
                value={state.composerDraft}
                disabled={controlsLocked}
                placeholder="e.g., My dog's name is Beans"
                aria-invalid={composerError ? 'true' : undefined}
                aria-describedby={
                  composerError
                    ? `${ids}-composer-help ${ids}-composer-error`
                    : `${ids}-composer-help`
                }
                onChange={event =>
                  dispatch({ type: 'setComposerDraft', value: event.target.value })
                }
              />
              <button
                type="submit"
                className="aurvin-personalization-save"
                disabled={!canApply}
              >
                {state.busy === 'editing' ? 'Applying…' : 'Update'}
              </button>
            </div>
            <div className="aurvin-memory-composer-footer">
              <p id={`${ids}-composer-help`} className="aurvin-memory-composer-help">
                Tell Aurvin in plain language what to remember, update, or forget. Avoid secrets or
                API keys.
              </p>
              <span
                className={`aurvin-personalization-counter${
                  composerCharCount > USER_MEMORY_INSTRUCTION_MAX_CHARS ? ' is-over' : ''
                }`}
              >
                {composerCharCount} / {USER_MEMORY_INSTRUCTION_MAX_CHARS}
              </span>
            </div>
            {composerError ? (
              <p
                id={`${ids}-composer-error`}
                className="aurvin-personalization-field-error"
                role="alert"
              >
                {composerError}
              </p>
            ) : null}
            {state.statusMessage ? (
              <p className="aurvin-memory-status" role="status" aria-live="polite">
                {state.statusMessage}
              </p>
            ) : null}
          </form>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmClearOpen}
        title="Clear all memory?"
        message="This permanently removes all saved Memory details across future sessions. Your Tone, Custom instructions, and Location settings will not be changed."
        confirmLabel="Clear memory"
        cancelLabel="Cancel"
        variant="danger"
        busy={state.busy === 'clearing'}
        busyLabel="Clearing…"
        onConfirm={() => {
          void executeClear();
        }}
        onCancel={() => setConfirmClearOpen(false)}
      />
    </section>
  );
}
```

Append MemoryCard styles to `frontend/src/features/personalization/personalization.css` (right before `@media (prefers-color-scheme: light)` and update `@media (prefers-reduced-motion: reduce)` and `@media (max-width: 640px)`):

```css
.aurvin-memory-card:focus:not(:focus-visible) {
  outline: none;
}

.aurvin-memory-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px 16px;
}

.aurvin-memory-heading-group {
  min-width: 0;
  flex: 1 1 260px;
}

.aurvin-memory-subtitle {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--aurvin-text-muted);
}

.aurvin-memory-toggle-wrap {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.aurvin-memory-toggle-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--aurvin-text);
}

.aurvin-personalization .aurvin-memory-switch {
  position: relative;
  width: 42px;
  height: 24px;
  padding: 2px;
  border-radius: 999px;
  border: 1px solid var(--aurvin-border);
  background: var(--aurvin-surface-active);
  cursor: pointer;
  transition: background-color 0.16s ease, border-color 0.16s ease;
}

.aurvin-personalization .aurvin-memory-switch.is-on {
  background: var(--aurvin-accent);
  border-color: var(--aurvin-accent);
}

.aurvin-personalization .aurvin-memory-switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.aurvin-memory-switch-thumb {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: var(--aurvin-bg);
  transform: translateX(0);
  transition: transform 0.16s ease;
}

.aurvin-personalization .aurvin-memory-switch.is-on .aurvin-memory-switch-thumb {
  transform: translateX(18px);
}

.aurvin-memory-loading {
  font-size: 13px;
  color: var(--aurvin-text-muted);
}

.aurvin-memory-paused-note {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--aurvin-border);
  background: var(--aurvin-surface);
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--aurvin-text-muted);
}

.aurvin-memory-sections {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.aurvin-memory-section {
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--aurvin-border);
  background: var(--aurvin-code-bg);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aurvin-memory-section-label {
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--aurvin-text-muted);
}

.aurvin-memory-section-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--aurvin-text);
  white-space: pre-wrap;
  word-break: break-word;
}

.aurvin-memory-empty {
  margin: 0;
  padding: 16px 14px;
  border-radius: 10px;
  border: 1px dashed var(--aurvin-border);
  background: var(--aurvin-surface);
  font-size: 13px;
  line-height: 1.5;
  color: var(--aurvin-text-muted);
}

.aurvin-memory-meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
}

.aurvin-memory-budget {
  flex: 1 1 220px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.aurvin-memory-budget-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.aurvin-memory-budget-label {
  font-size: 12px;
  color: var(--aurvin-text-muted);
}

.aurvin-memory-budget-track {
  height: 6px;
  border-radius: 999px;
  background: var(--aurvin-surface-active);
  overflow: hidden;
}

.aurvin-memory-budget-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--aurvin-accent);
  transition: width 0.2s ease;
}

.aurvin-memory-budget-fill.is-near {
  background: var(--aurvin-warning);
}

.aurvin-memory-budget-fill.is-full {
  background: var(--aurvin-danger);
}

.aurvin-memory-composer {
  padding-top: 14px;
  border-top: 1px solid var(--aurvin-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.aurvin-memory-composer-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.aurvin-memory-composer-footer {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.aurvin-memory-composer-help {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--aurvin-text-muted);
}

.aurvin-memory-status {
  margin: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--aurvin-text);
}
```

Inside `@media (prefers-reduced-motion: reduce)` in `frontend/src/features/personalization/personalization.css`, include `.aurvin-personalization .aurvin-memory-switch`, `.aurvin-memory-switch-thumb`, and `.aurvin-memory-budget-fill`. Inside `@media (max-width: 640px)`, stack `.aurvin-memory-composer-row` (`flex-direction: column; align-items: stretch;`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- src/features/personalization/user-memory.test.ts`
Expected: PASS (6/6 tests passing).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/personalization/MemoryCard.tsx frontend/src/features/personalization/personalization.css frontend/src/features/personalization/user-memory.test.ts
git commit -m "feat(frontend): add Personalization MemoryCard component and styles"
```

---

### Task 4: Mount Independent `MemoryCard` Inside `PersonalizationPanel`

**Files:**
- Modify: `frontend/src/features/personalization/PersonalizationPanel.tsx:20-115,475-496`
- Test: `frontend/src/features/personalization/user-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Add an SSR integration check to `frontend/src/features/personalization/user-memory.test.ts`:

```typescript
import { createPersonalizationClient } from '../../api/personalization-client.ts';
import { PersonalizationPanel } from './PersonalizationPanel.tsx';
```

(Add these imports near the top of `frontend/src/features/personalization/user-memory.test.ts`, and add this test inside `describe('MemoryCard rendering', ...)`:)

```typescript
  it('mounts MemoryCard independently inside PersonalizationPanel before personalization finishes loading', () => {
    const pClient = createPersonalizationClient({
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    });
    const html = renderToStaticMarkup(
      createElement(PersonalizationPanel, { client: pClient, userMemoryClient: noopClient }),
    );
    expect(html).toContain('Personalization');
    expect(html).toContain('Loading personalization settings');
    expect(html).toContain('id="aurvin-personalization-memory"');
    expect(html).toContain('Loading memory');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/features/personalization/user-memory.test.ts`
Expected: FAIL because `PersonalizationPanel` does not accept `userMemoryClient` or render `MemoryCard`.

- [ ] **Step 3: Write minimal implementation**

Update `frontend/src/features/personalization/PersonalizationPanel.tsx`:

1. Import `type UserMemoryClient` from `'../../api/user-memory-client.ts'` and `MemoryCard` from `'./MemoryCard.tsx'`.
2. Add optional `userMemoryClient?: UserMemoryClient;` to `PersonalizationPanelProps`.
3. Destructure `userMemoryClient` in `PersonalizationPanel` props and add:
   ```tsx
   const [memoryBusy, setMemoryBusy] = useState(false);
   ```
4. Update the `onBusyChange` effect (keep `onDirtyChange` strictly tied to `dirty` only!):
   ```tsx
   useEffect(() => {
     onBusyChange?.(busy || memoryBusy);
   }, [busy, memoryBusy, onBusyChange]);
   ```
5. Mount `<MemoryCard>` directly inside `<section className="aurvin-personalization">` right after the `{state.phase === 'ready' ? (...) : null}` block (and before `<ConfirmDialog>`), so Memory renders and loads independently of Personalization's `ready`/`unavailable` phase and Save/Discard/Reset footer:
   ```tsx
      <MemoryCard
        client={userMemoryClient}
        disabled={disabled}
        onBusyChange={setMemoryBusy}
      />
   ```

- [ ] **Step 4: Run tests to verify both new and existing personalization suites pass**

Run: `cd frontend && npm test -- src/features/personalization/user-memory.test.ts src/features/personalization/personalization.test.ts`
Expected: PASS (all tests in both files pass).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/personalization/PersonalizationPanel.tsx frontend/src/features/personalization/user-memory.test.ts
git commit -m "feat(frontend): mount independent MemoryCard in PersonalizationPanel"
```

---

### Task 5: Close the P1 Admin-Config Mirror Transfer

**Files:**
- Modify: `frontend/src/api/admin-config-protocol.ts:81-100,175-184,227-235,328-360,395-408,428-452,504-520`
- Scope-expansion (requires parent approval; unowned by any other plan):
  - Modify: `frontend/src/api/admin-config-client.ts:20-43,136-149,325-358`
  - Modify: `frontend/src/features/admin-config/testing/fixtures.ts:20-63`

- [ ] **Step 1: Verify the backend mirror test currently fails**

Run: `cd backend && npm test -- src/contracts/admin-config.spec.ts -t "mirrors only the public admin contract into the frontend"`
Expected: FAIL showing diff between `frontend/src/api/admin-config-protocol.ts` and `backend/src/contracts/admin-config-wire.ts` on `MemorySettings` / `DEFAULT_MEMORY_SETTINGS` / `memory.modelMode` / `memory.customModelId` / `isMemorySettings` / `isCompatibilityCandidate`.

- [ ] **Step 2: Mirror `backend/src/contracts/admin-config-wire.ts` verbatim into `frontend/src/api/admin-config-protocol.ts`**

Apply these exact edits to `frontend/src/api/admin-config-protocol.ts` so everything from `export const ADMIN_CONFIG_PROTOCOL_VERSION` to EOF matches `backend/src/contracts/admin-config-wire.ts` byte-for-byte:

1. Immediately after `DEFAULT_COMPACTION_SETTINGS` (lines 81–84), add:
```typescript
export type MemorySettings = { modelMode: 'main' | 'custom'; customModelId: string | null };
export const DEFAULT_MEMORY_SETTINGS = {
  modelMode: 'main', customModelId: null,
} as const satisfies MemorySettings;
type ReadableManageableSettings = Omit<ManageableSettings, 'memory'> & { memory?: MemorySettings };
type ReadablePublicAdminConfig = Omit<PublicAdminConfig, 'settings'> & { settings: ReadableManageableSettings };
```

2. In `ManageableSettings`, add `memory: MemorySettings;` immediately after `compaction: CompactionSettings;`.

3. In `ModelCompatibilityResponse['candidate']`, add `memory?: MemorySettings;` immediately after `chat: ChatLimits;`.

4. In `ADMIN_CONFIG_FIELD_PATHS`, add immediately after `'compaction.customModelId',`:
```typescript
  'memory.modelMode',
  'memory.customModelId',
```

5. Immediately before `function isChatLimits`, add:
```typescript
function isMemorySettings(value: unknown): value is MemorySettings {
  return record(value) && exact(value, {
    modelMode: x => x === 'main' || x === 'custom', customModelId: nullable(nonEmptyModelId),
  }) && (value.modelMode !== 'custom' || value.customModelId !== null);
}
```

6. Update `isManageableSettings` signature, destructuring, and cast:
```typescript
export function isManageableSettings(value: unknown): value is ReadableManageableSettings {
  if (!record(value)) return false;
  const { devModeEnabled, memory, ...base } = value;
  if (Object.hasOwn(value, 'devModeEnabled') && typeof devModeEnabled !== 'boolean') return false;
  if (Object.hasOwn(value, 'memory') && !isMemorySettings(memory)) return false;
  ...
  const s = value as ReadableManageableSettings;
```

7. Update `isPublicAdminConfig` signature and cast:
```typescript
export function isPublicAdminConfig(value: unknown): value is ReadablePublicAdminConfig {
  ...
  const v = value as ReadablePublicAdminConfig;
```

8. Replace `isModelCompatibilityResponse` with `isCompatibilityCandidate` + `isModelCompatibilityResponse`:
```typescript
function isCompatibilityCandidate(value: unknown): boolean {
  if (!record(value)) return false;
  const { memory, ...base } = value;
  return (!Object.hasOwn(value, 'memory') || isMemorySettings(memory)) && exact(base, {
    revision: r => typeof r === 'number' && Number.isSafeInteger(r) && r >= 0,
    modelId,
    reasoningEffort: isReasoningEffort,
    chat: isChatLimits,
  });
}

export function isModelCompatibilityResponse(value: unknown): value is ModelCompatibilityResponse {
  return exact(value, {
    protocolVersion: v => v === 1,
    candidate: isCompatibilityCandidate,
    checkedAt: timestamp,
    catalogueObservedAt: nullable(timestamp),
    expiresAt: timestamp,
    report: isModelCompatibilityReport,
  });
}
```

- [ ] **Step 3: Update `admin-config-client.ts` and `testing/fixtures.ts` for `ManageableSettings.memory` & `ReadablePublicAdminConfig` compatibility**

In `frontend/src/api/admin-config-client.ts`:
1. Import `DEFAULT_MEMORY_SETTINGS` from `./admin-config-protocol.ts`.
2. Add the minimal normalization helper and explicit save-memory check:
```typescript
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
```
3. In `assertSaveRequest`:
```typescript
  if (!request.settings || typeof request.settings !== 'object'
      || !Object.hasOwn(request.settings, 'memory')
      || !isManageableSettings(request.settings)) invalidRequest();
```
4. Wrap `read`, `saveSettings`, and `updateCredential` returns with `normalizePublicConfig(await request(...))`.

In `frontend/src/features/admin-config/testing/fixtures.ts`:
1. Import `DEFAULT_MEMORY_SETTINGS` alongside `DEFAULT_COMPACTION_SETTINGS`.
2. Add `memory: { ...DEFAULT_MEMORY_SETTINGS },` immediately after `compaction: { ...DEFAULT_COMPACTION_SETTINGS },`.

- [ ] **Step 4: Run backend mirror test and frontend admin-config client test to verify pass**

Run:
```bash
cd backend && npm test -- src/contracts/admin-config.spec.ts -t "mirrors only the public admin contract into the frontend"
cd frontend && npm test -- src/features/admin-config/admin-config-client.test.ts
```
Expected: Both PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/admin-config-protocol.ts frontend/src/api/admin-config-client.ts frontend/src/features/admin-config/testing/fixtures.ts
git commit -m "feat(frontend): mirror admin-config memory settings contract"
```

---

### Task 6: Admin Config Memory Writer Model Selector (`config-edit-state.ts` & `ConfigFields.tsx`)

**Files:**
- Modify: `frontend/src/features/admin-config/config-edit-state.ts:20-35,125-145,485-530,660-680`
- Modify: `frontend/src/features/admin-config/ConfigFields.tsx:30-37,230-296,335-408`
- Test: `frontend/src/features/admin-config/config-edit-state.test.ts`

- [ ] **Step 1: Write the failing test**

In `frontend/src/features/admin-config/config-edit-state.test.ts`:
1. Import `createElement` from `'react'`, `renderToStaticMarkup` from `'react-dom/server'`, `ConfigFields` from `'./ConfigFields.tsx'`, and `applyCompactionModelToMemory` from `'./config-edit-state.ts'`.
2. Append these deterministic tests at the bottom of `frontend/src/features/admin-config/config-edit-state.test.ts`:

```typescript
it('round-trips memory writer settings, enforces customModelId, resets on main, and defaults absent legacy memory', () => {
  const baseline = publicConfig().settings;
  expect(baseline.memory).toEqual({ modelMode: 'main', customModelId: null });

  const fields = fieldsFromSettings(baseline);
  expect(fields['memory.modelMode']).toBe('main');
  expect(fields['memory.customModelId']).toBe('');

  const missingCustom = settingsFromFields(baseline, {
    ...fields,
    'memory.modelMode': 'custom',
    'memory.customModelId': '',
  });
  expect(missingCustom.settings).toBeNull();
  expect(missingCustom.fieldErrors).toContainEqual({
    path: 'memory.customModelId',
    code: 'required',
  });

  for (const [path, value] of [
    ['memory.modelMode', 'compaction'],
    ['memory.customModelId', ' spaced/model '],
    ['memory.customModelId', 'a\nb'],
    ['memory.customModelId', 'm'.repeat(201)],
  ] as const) {
    const invalid = settingsFromFields(baseline, {
      ...fields,
      'memory.modelMode': 'custom',
      'memory.customModelId': 'openai/gpt-4.1-mini',
      [path]: value,
    });
    expect(invalid.settings).toBeNull();
    expect(invalid.fieldErrors.some((error) => error.path === path)).toBe(true);
  }

  const validCustom = settingsFromFields(baseline, {
    ...fields,
    'memory.modelMode': 'custom',
    'memory.customModelId': 'anthropic/claude-haiku-4.5',
  });
  expect(validCustom.fieldErrors).toEqual([]);
  expect(validCustom.settings?.memory).toEqual({
    modelMode: 'custom',
    customModelId: 'anthropic/claude-haiku-4.5',
  });

  // Switching back to main clears memory.customModelId and leaves compatibility unlocked
  let state = createEditState(publicConfig());
  state = editReducer(state, { type: 'edit', path: 'memory.modelMode', value: 'custom' });
  state = editReducer(state, {
    type: 'edit',
    path: 'memory.customModelId',
    value: 'anthropic/claude-haiku-4.5',
  });
  expect(requiresCompatibilityCheck(state)).toBe(false);
  expect(saveLocked(state)).toBe(false);

  state = editReducer(state, { type: 'edit', path: 'memory.modelMode', value: 'main' });
  expect(state.fields['memory.customModelId']).toBe('');
  expect(isDirty(state)).toBe(false);

  // Legacy baseline missing memory defaults cleanly to main/null
  const legacy = structuredClone(baseline) as Omit<typeof baseline, 'memory'> & {
    memory?: typeof baseline.memory;
  };
  delete legacy.memory;
  expect(isManageableSettings(legacy)).toBe(true);
  const legacyFields = fieldsFromSettings(legacy as typeof baseline);
  expect(legacyFields['memory.modelMode']).toBe('main');
  expect(legacyFields['memory.customModelId']).toBe('');
  const rebuilt = settingsFromFields(legacy as typeof baseline, legacyFields);
  expect(rebuilt.fieldErrors).toEqual([]);
  expect(rebuilt.settings?.memory).toEqual({ modelMode: 'main', customModelId: null });
});

it('maps the approved Compaction model choice explicitly to main or a copy of compaction.customModelId', () => {
  const baseFields = fieldsFromSettings(publicConfig().settings);
  expect(applyCompactionModelToMemory(baseFields)).toEqual({
    modelMode: 'main',
    customModelId: '',
  });
  expect(
    applyCompactionModelToMemory({
      ...baseFields,
      'compaction.modelMode': 'custom',
      'compaction.customModelId': 'anthropic/claude-haiku-4.5',
    }),
  ).toEqual({
    modelMode: 'custom',
    customModelId: 'anthropic/claude-haiku-4.5',
  });
  expect(
    applyCompactionModelToMemory({
      ...baseFields,
      'compaction.modelMode': 'custom',
      'compaction.customModelId': '   ',
    }),
  ).toEqual({
    modelMode: 'main',
    customModelId: '',
  });
});

it('renders Memory writer model controls in ConfigFields compaction section and toggles ModelCombobox by mode', () => {
  const fields = fieldsFromSettings(publicConfig().settings);
  const mainHtml = renderToStaticMarkup(
    createElement(ConfigFields, {
      section: 'compaction',
      fields,
      errors: [],
      disabled: false,
      onChange: () => undefined,
    }),
  );
  expect(mainHtml).toContain('User memory');
  expect(mainHtml).toContain('Memory writer model mode');
  expect(mainHtml).toContain('Main chat model');
  expect(mainHtml).toContain('Use compaction model');
  expect(mainHtml).not.toContain('id="admin-field-memory-customModelId"');

  const customHtml = renderToStaticMarkup(
    createElement(ConfigFields, {
      section: 'compaction',
      fields: {
        ...fields,
        'memory.modelMode': 'custom',
        'memory.customModelId': 'anthropic/claude-haiku-4.5',
      },
      errors: [{ path: 'memory.customModelId', code: 'required' }],
      disabled: false,
      models: [
        {
          id: 'anthropic/claude-haiku-4.5',
          name: 'Claude Haiku 4.5',
          reasoning: { selection: 'unavailable', efforts: [], mandatory: null },
        },
      ],
      modelsLoading: false,
      modelsError: null,
      onRetryModels: () => undefined,
      onChange: () => undefined,
    }),
  );
  expect(customHtml).toContain('id="admin-field-memory-customModelId"');
  expect(customHtml).toContain('role="combobox"');
  expect(customHtml).toContain('Claude Haiku 4.5');
  expect(customHtml).toContain('id="admin-field-memory-customModelId-error"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- src/features/admin-config/config-edit-state.test.ts`
Expected: FAIL (`covers every manageable field` fails on missing `memory.modelMode` / `memory.customModelId`, plus `applyCompactionModelToMemory` not exported).

- [ ] **Step 3: Write minimal implementation**

Update `frontend/src/features/admin-config/config-edit-state.ts`:

1. Import `DEFAULT_MEMORY_SETTINGS` from `'../../api/admin-config-protocol.ts'`.
2. In `editableFields`, right after `compaction.customModelId` (line 140), add:
```typescript
  { path: 'memory.modelMode', section: 'compaction', group: 'User memory',
    label: 'Memory writer model mode',
    help: 'Main chat model reuses the configured chat model; Custom selects a separate OpenRouter model.',
    kind: 'select', choices: ['main', 'custom'] },
  { path: 'memory.customModelId', section: 'compaction', group: 'User memory',
    label: 'Memory writer model',
    help: 'OpenRouter model ID used when Memory writer model mode is Custom.',
    kind: 'nullable-text', max: 200 },
```
3. In `crossFieldErrors`, right after the `compaction.customModelId` check (line 489), add:
```typescript
  if (settings.memory.modelMode === 'custom' && settings.memory.customModelId === null) {
    errors.push(fieldError('memory.customModelId', 'required'));
  }
```
4. In `fieldsFromSettings`, normalize absent legacy `settings.memory` before reading paths:
```typescript
export function fieldsFromSettings(settings: ManageableSettings): FieldValues {
  const normalized = settings.memory
    ? settings
    : { ...settings, memory: { ...DEFAULT_MEMORY_SETTINGS } };
  const fields: FieldValues = {};
  for (const field of editableFields) {
    const value = readPath(normalized, field.path);
    if (field.kind === 'boolean') fields[field.path] = Boolean(value);
    else if (field.kind === 'keyterms' || field.kind === 'domain-list') {
      fields[field.path] = Array.isArray(value) ? value.join('\n') : '';
    }
    else if (value === null || value === undefined) fields[field.path] = '';
    else fields[field.path] = String(value);
  }
  return fields;
}
```
5. In `settingsFromFields`, initialize `settings.memory` if absent on a legacy baseline before `writePath`:
```typescript
  const settings = structuredClone(baseline);
  if (!settings.memory) settings.memory = { ...DEFAULT_MEMORY_SETTINGS };
```
6. In `editReducer` (`case 'edit'`), right after the `compaction.modelMode` reset (line 673), add:
```typescript
      if (action.path === 'memory.modelMode' && action.value === 'main') {
        fields['memory.customModelId'] = '';
      }
```
7. Export `applyCompactionModelToMemory` in `frontend/src/features/admin-config/config-edit-state.ts`:
```typescript
/**
 * Maps the approved "Compaction model" UI choice onto the reconciled
 * `main | custom` wire contract as a snapshot copy (not a live link).
 */
export function applyCompactionModelToMemory(
  fields: FieldValues,
): { modelMode: 'main' | 'custom'; customModelId: string } {
  const compactionCustom =
    typeof fields['compaction.customModelId'] === 'string'
      ? fields['compaction.customModelId'].trim()
      : '';
  if (fields['compaction.modelMode'] === 'custom' && compactionCustom !== '') {
    return { modelMode: 'custom', customModelId: compactionCustom };
  }
  return { modelMode: 'main', customModelId: '' };
}
```

Update `frontend/src/features/admin-config/ConfigFields.tsx`:

1. Import `applyCompactionModelToMemory` from `'./config-edit-state.ts'`.
2. In `FieldControl`, generalize custom model detection from `compaction.customModelId` to both custom model fields:
```tsx
  const isCustomModelField =
    field.path === 'compaction.customModelId' || field.path === 'memory.customModelId';
  const selectedModel = isCustomModelField
    ? models.find((item) => item.id === modelValue)
    : undefined;
```
   Use `isCustomModelField` for the `<ModelCombobox ... />` branch and for the `modelsError && onRetryModels` alert block.
3. In `AdminSelect` option label mapping, add `'main'`:
```tsx
                label: choice === 'us'
                  ? 'US'
                  : choice === 'eu'
                    ? 'EU'
                    : choice === 'active-fork'
                      ? 'Active model fork (cache-aligned)'
                      : choice === 'main'
                        ? 'Main chat model'
                        : choice === 'custom'
                          ? 'Custom model'
                          : choice,
```
4. In `ConfigFields`:
   - Add `const showCustomMemoryModel = fields['memory.modelMode'] === 'custom';` and filter `(field.path !== 'memory.customModelId' || showCustomMemoryModel)`.
   - Inside each `<fieldset>`, right after `group.fields.map(...)`, render the explicit compaction-copy helper when `section === 'compaction' && group.name === 'User memory'`:
```tsx
          {section === 'compaction' && group.name === 'User memory' ? (
            <div className="aurvin-admin-field">
              <button
                type="button"
                className="aurvin-admin-button"
                disabled={disabled}
                onClick={() => {
                  const mapped = applyCompactionModelToMemory(fields);
                  onChange('memory.modelMode', mapped.modelMode);
                  if (mapped.modelMode === 'custom') {
                    onChange('memory.customModelId', mapped.customModelId);
                  }
                }}
              >
                Use compaction model
              </button>
              <p className="aurvin-admin-help">
                Copies the current compaction model (Main chat model or custom compaction model ID;
                not a live link).
              </p>
            </div>
          ) : null}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd frontend && npm test -- src/features/admin-config/config-edit-state.test.ts src/features/admin-config/admin-dashboard.test.ts
```
Expected: PASS (all tests in both files pass).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/admin-config/config-edit-state.ts frontend/src/features/admin-config/ConfigFields.tsx frontend/src/features/admin-config/config-edit-state.test.ts
git commit -m "feat(frontend): add Admin Config memory writer model selector"
```

---

## Final P5 Verification Gate

Run all required checks and report exact results (no skipping):

```bash
cd backend && npm test -- src/contracts/admin-config.spec.ts -t "mirrors only the public admin contract into the frontend"
cd frontend && npm run build
cd frontend && npm run lint
cd frontend && npm test
```

Expected:
- Backend mirror test: **PASS** (closes the P1 → P5 admin-config mirror transfer).
- Frontend `npm run build`: **PASS** (`tsc -b && vite build` clean with zero errors).
- Frontend `npm run lint`: **PASS** (`oxlint` clean).
- Frontend `npm test`: **PASS** (all existing + new user-memory and admin-config tests pass).

---

## Downstream Contract Notes for P6

- **Memory Card Navigation Target:** `MemoryCard` renders a focusable `<section id="aurvin-personalization-memory" tabIndex={-1}>` (exported constant `MEMORY_CARD_ELEMENT_ID = 'aurvin-personalization-memory'` from `frontend/src/features/personalization/MemoryCard.tsx`). When the user clicks the `✓ Memory updated` pill in `ChatView` / `MessageItem`, P6 (`App.tsx` + `AdminDashboard.tsx`) can switch to `initialSection="personalization"` and scroll/focus `#aurvin-personalization-memory`.
- **Optional Client Injection:** `PersonalizationPanelProps` accepts optional `userMemoryClient?: UserMemoryClient`; omitting it uses the default `/api/personalization/memory*` client automatically, so existing `AdminDashboard.tsx` call sites keep working while P6 integration tests can inject a fixture client if desired.
- **Dirty vs Busy Semantics:** `MemoryCard` never affects `PersonalizationPanel`'s `onDirtyChange` (Tone/Instructions/Location unsaved-exit prompt stays isolated), while active memory requests do surface through `onBusyChange` so tab/navigation buttons stay locked while a memory request is in flight.
- **Admin Config Memory Selector Location:** `memory.modelMode` and `memory.customModelId` live in the existing `compaction` Config section (`User memory` fieldset), so `AdminDashboard.tsx` requires no new Config section rail entry.
- **Untouched P6 / User Files:** P5 leaves `frontend/src/api/protocol.ts`, `frontend/src/api/client.ts`, `frontend/src/api/voice-protocol.ts`, `frontend/src/features/admin-config/AdminDashboard.tsx`, and all uncommitted voice/weather files untouched.
