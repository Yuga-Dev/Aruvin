# P6 — Frontend Chat UX (`✓ Memory updated` Pill + Temporary Chat) & Integrated Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the frontend Chat UX for User Memory (`✓ Memory updated` clickable pill navigating to Manage Aurvin → Personalization → `MemoryCard`), True Ephemeral (Temporary) Chat controls and exit purge (`DELETE` with `keepalive: true` on `pagehide`, session switch, and New Chat), P4-aligned Live Voice gating in Temporary Chat (off by default), and closure of the P1→P6 `voice-protocol.ts` mirror with full Node-environment Vitest integration coverage.

**Architecture:** Extend the browser chat/voice protocols (`protocol.ts`, `client.ts`, `voice-protocol.ts`) to mirror P1/P4's `ephemeral?: boolean` and `memoryUpdated?: boolean` fields without breaking existing strict guards or uncommitted `voice-limits.ts` extraction. Track `activeSessionTemporary` in `chat-reducer.ts` with pure, testable predicates (`canToggleTemporaryChat`, `canStartLiveVoiceForChat`) so Temporary Chat locks after turn 1, stays out of the sidebar and `sessionStorage` recovery, suppresses save-poll chrome, disables Live Voice by default (`TEMPORARY_LIVE_VOICE_ENABLED = false`), and fires deduplicated `keepalive: true` `DELETE` purges from `use-chat.ts`. Surface the minimalistic clickable `✓ Memory updated` pill from `MessageItem.tsx` through `Transcript.tsx` → `ChatView.tsx` → `App.tsx` → `AdminDashboard.tsx`, focusing P5's `#aurvin-personalization-memory` anchor without touching P5-owned files or unowned CSS.

**Tech Stack:** React 19, TypeScript (`verbatimModuleSyntax`, `erasableSyntaxOnly`, `.ts`/`.tsx` relative imports), Vite, Vitest (Node environment + `react-dom/server` `renderToStaticMarkup`, no browser DOM/jsdom), `oxlint`, CSS custom properties (`--aurvin-*`) via existing `chat.css` utility classes.

---

## Work Gate, Ownership & Preservation Rules

- **Upstream Gate:** P6 worker execution is gated on **both P4 and P5 workers** being complete (`P5` is complete at `ac4e97f`…`166f411`; `P4` plan is committed at `e2c9286` and its worker is currently paused). Verify `P4` worker commits before starting P6 implementation.
- **P6 Owned Files (authoritative from `docs/user-memory-context/state.md`):**
  - Modify: `frontend/src/api/voice-protocol.ts`
  - Modify: `frontend/src/api/protocol.ts`
  - Modify: `frontend/src/api/client.ts`
  - Modify: `frontend/src/features/chat/state/chat-types.ts`
  - Modify: `frontend/src/features/chat/state/chat-reducer.ts`
  - Modify: `frontend/src/features/chat/state/use-chat.ts`
  - Modify: `frontend/src/features/chat/state/chat-context.tsx`
  - Create: `frontend/src/features/chat/state/user-memory-chat-state.test.ts`
  - Modify: `frontend/src/features/chat/ChatView.tsx`
  - Modify: `frontend/src/features/chat/ChatView.test.ts`
  - Modify: `frontend/src/components/MessageItem.tsx`
  - Modify: `frontend/src/components/Transcript.tsx`
  - Modify: `frontend/src/App.tsx`
  - Modify: `frontend/src/features/voice/state/useLiveVoice.ts`
  - Modify: `frontend/src/features/admin-config/AdminDashboard.tsx`
  - Create: `frontend/src/features/chat/integration-tests/user-memory.test.ts`
- **Strictly Off-Limits (Do NOT edit):**
  - Any `backend/**` file.
  - Any P5-owned personalization or admin-config file (`MemoryCard.tsx`, `PersonalizationPanel.tsx`, `personalization.css`, `ConfigFields.tsx`, `config-edit-state.ts`, `admin-config-protocol.ts`, `admin-config-client.ts`).
  - Unowned frontend components/styles/tests (`Composer.tsx`, `Sidebar.tsx`, `styles/chat.css`, `protocol.test.ts`, `client.test.ts`, `MessageItem.test.ts`, `Transcript.test.ts`, `App.assembly.test.ts`, `admin-dashboard.test.ts`, `live-voice-controller.ts`).
- **Preserve Uncommitted User Work:**
  - `frontend/src/api/voice-protocol.ts` currently has uncommitted user edits extracting `VoiceLimits` / `DEFAULT_VOICE_LIMITS` / `isVoiceLimits` into untracked `frontend/src/api/voice-limits.ts` (matching uncommitted `backend/src/contracts/voice-wire.ts` and `backend/src/contracts/voice-limits.ts`). **Merge atop these edits; never revert or discard them.**
  - Both `backend/src/contracts/voice-wire.ts` and `frontend/src/api/voice-protocol.ts` use **CRLF (`\r\n`)** line endings, and `backend/src/contracts/voice.spec.ts` compares them byte-for-byte without normalizing line endings. Preserve CRLF in `frontend/src/api/voice-protocol.ts`.
  - When committing `frontend/src/api/voice-protocol.ts`, stage **only** the `ephemeral` hunks with `git add -p -- frontend/src/api/voice-protocol.ts` and inspect `git diff --cached -- frontend/src/api/voice-protocol.ts`. Never run `git add .`.
- **Lint & TypeScript Discipline:**
  - All new `.ts` files include the mandatory repository file header.
  - Non-component helper exports from `.tsx` files carry `// oxlint-disable-next-line react/only-export-components -- pure helper shared with tests`.
  - `App.tsx` must stay free of `VITE_*`, `localStorage`, `sessionStorage`, and `DEEPGRAM|ENABLE_LIVE_VOICE|ENABLE_DICTATION` tokens (`App.assembly.test.ts` enforces this).
  - `chat-context.tsx` and `use-chat.ts` import `canStartLiveVoiceForChat` from `./chat-reducer.ts` (never from `useLiveVoice.ts`, which `App.assembly.test.ts` mocks with only `{ useLiveVoice }`).

## File Map

| Owned path | Responsibility |
| --- | --- |
| `frontend/src/api/voice-protocol.ts` | Close P1→P6 mirror: add `ephemeral?: boolean` to `CreateVoiceSessionRequest` and `isCreateVoiceSessionRequest` while preserving uncommitted `voice-limits.ts` edits and CRLF. |
| `frontend/src/api/protocol.ts`, `frontend/src/api/client.ts` | Add `ephemeral?: boolean` on `SubmitTurnRequest`/`SessionSummary`, `memoryUpdated?: boolean` on `VisibleMessage`/SSE `completed`, `deleteSession(id, { keepalive })`, ephemeral mismatch check, and no `sessionStorage` writes for temporary prompts. |
| `frontend/src/features/chat/state/chat-types.ts`, `chat-reducer.ts` | `activeSessionTemporary`, `SET_TEMPORARY_CHAT`, `canToggleTemporaryChat`, `TEMPORARY_LIVE_VOICE_ENABLED = false`, `canStartLiveVoiceForChat`, sidebar exclusion, save-state suppression, and explicit + passive `memoryUpdated` retention. |
| `frontend/src/features/chat/state/use-chat.ts`, `chat-context.tsx`, `frontend/src/features/voice/state/useLiveVoice.ts` | Creation-only `ephemeral: true`, deduplicated `keepalive: true` `DELETE` purge on `startNewChat`, `selectSession`, `pagehide` (`startTemporaryChatPagehideEffect`), and aborted Turn 1; disable Live Voice in Temporary Chat by default. |
| `frontend/src/components/MessageItem.tsx`, `Transcript.tsx`, `frontend/src/features/chat/ChatView.tsx`, `frontend/src/App.tsx`, `frontend/src/features/admin-config/AdminDashboard.tsx` | Minimalistic clickable `✓ Memory updated` pill routing to Manage Aurvin → Personalization → `#aurvin-personalization-memory` (`focusMemoryCardElement`); Temporary Chat header toggle (unsaved New Chat, locked after turn 1) and active `"Temporary chat — not saved, memory off"` pill. |
| `frontend/src/features/chat/state/user-memory-chat-state.test.ts`, `frontend/src/features/chat/ChatView.test.ts`, `frontend/src/features/chat/integration-tests/user-memory.test.ts` | Node-environment Vitest unit, SSR, and end-to-end integration tests covering all P6 seams without jsdom. |

---

### Task 1: Close the P1→P6 Voice Protocol Mirror

**Files:**
- Modify: `frontend/src/api/voice-protocol.ts:163-164, 422-426`
- Create: `frontend/src/features/chat/integration-tests/user-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/chat/integration-tests/user-memory.test.ts`:

```typescript
/**
 * ============================================================================
 * FILE: user-memory.test.ts
 * LOCATION: frontend/src/features/chat/integration-tests/user-memory.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Integrated Node-environment tests for User Memory UX and Temporary Chat.
 *
 * ROLE IN PROJECT:
 *    Verifies the P1->P6 voice contract mirror, explicit and passive memory
 *    indicator flows, Temporary Chat purge/isolation lifecycle, Live Voice
 *    gating, and navigation to Personalization MemoryCard without jsdom.
 *
 * KEY COMPONENTS:
 *    - Voice protocol ephemeral guard tests
 *    - End-to-end chat client, reducer, hook, and SSR markup integration seams
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_LIMITS,
  isCreateVoiceSessionRequest,
  isVoiceLimits,
} from '../../../api/voice-protocol.ts';

describe('P6 voice protocol ephemeral mirror', () => {
  const baseRequest = {
    protocolVersion: 1 as const,
    mode: 'live' as const,
    conversationId: null,
    locale: 'en-US' as const,
    idempotencyKey: 'voice-temp-key-1',
  };

  it('accepts optional boolean ephemeral on CreateVoiceSessionRequest and rejects invalid values', () => {
    expect(isCreateVoiceSessionRequest(baseRequest)).toBe(true);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: true })).toBe(true);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: false })).toBe(true);

    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: 'true' })).toBe(false);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: 1 })).toBe(false);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: null })).toBe(false);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: true, extra: 1 })).toBe(false);
  });

  it('preserves voice-limits re-exports alongside the ephemeral mirror', () => {
    expect(isVoiceLimits(DEFAULT_VOICE_LIMITS)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd frontend && npm test -- src/features/chat/integration-tests/user-memory.test.ts src/api/testing/voice-fixtures.test.ts
```
and:
```bash
cd backend && npm test -- src/contracts/voice.spec.ts -t "mirrors the entire portable voice contract"
```
Expected: FAIL — `isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: true })` returns `false`, `voice-fixtures.test.ts` fails parity on `CreateVoiceSessionRequest`, and `backend/src/contracts/voice.spec.ts` fails `"mirrors the entire portable voice contract"`.

- [ ] **Step 3: Write minimal implementation (preserving uncommitted edits and CRLF)**

Edit `frontend/src/api/voice-protocol.ts` in **only** two contiguous places so the body from `export const VOICE_PROTOCOL_VERSION` to EOF matches `backend/src/contracts/voice-wire.ts` verbatim (keep CRLF line endings and keep the existing uncommitted `voice-limits.ts` import/re-export lines untouched):

1. Lines 163–164 (`CreateVoiceSessionRequest`):
```typescript
export type CreateVoiceSessionRequest = { protocolVersion: 1; mode: VoiceMode;
  conversationId: string | null; locale: 'en-US'; idempotencyKey: string; ephemeral?: boolean };
```

2. Lines 422–426 (`isCreateVoiceSessionRequest`):
```typescript
export function isCreateVoiceSessionRequest(value: unknown): value is CreateVoiceSessionRequest {
  if (!record(value)) return false;
  const { ephemeral, ...base } = value;
  if (Object.hasOwn(value, 'ephemeral') && !bool(ephemeral)) return false;
  return exact(base, { protocolVersion: oneOf(1), mode: oneOf('dictation', 'live'),
    conversationId: nullable(id), locale: oneOf('en-US'),
    idempotencyKey: v => id(v) && (v as string).length >= 8 });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd frontend && npm test -- src/features/chat/integration-tests/user-memory.test.ts src/api/testing/voice-fixtures.test.ts src/api/voice-protocol.test.ts
cd ../backend && npm test -- src/contracts/voice.spec.ts -t "mirrors the entire portable voice contract"
```
Expected: PASS — all frontend voice tests AND backend `"mirrors the entire portable voice contract"` pass.

- [ ] **Step 5: Commit (staging ONLY P6 hunks from `voice-protocol.ts`)**

Use interactive patch staging so the uncommitted `voice-limits.ts` extraction hunks stay unstaged in the working tree:

```bash
git add -- frontend/src/features/chat/integration-tests/user-memory.test.ts
git add -p -- frontend/src/api/voice-protocol.ts
git diff --cached -- frontend/src/api/voice-protocol.ts
git commit -m "feat(voice): mirror ephemeral voice session request field on frontend"
```
Verify `git diff --cached -- frontend/src/api/voice-protocol.ts` shows **only** the `CreateVoiceSessionRequest` and `isCreateVoiceSessionRequest` hunks before committing.

---

### Task 2: Chat Wire Protocol (`ephemeral`, `memoryUpdated`) & Keepalive Delete Client

**Files:**
- Modify: `frontend/src/api/protocol.ts:82-90, 106-112, 132-160, 222-234, 325-359, 465-492, 608-626`
- Modify: `frontend/src/api/client.ts:184-192, 305-307, 342-346`
- Create: `frontend/src/features/chat/state/user-memory-chat-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/chat/state/user-memory-chat-state.test.ts`:

```typescript
/**
 * ============================================================================
 * FILE: user-memory-chat-state.test.ts
 * LOCATION: frontend/src/features/chat/state/user-memory-chat-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Unit tests for chat protocol, client keepalive purge, reducer transitions,
 *    and hook orchestration for User Memory indicator and Temporary Chat.
 *
 * ROLE IN PROJECT:
 *    Covers wire guards, sessionStorage isolation, Temporary Chat lock/sidebar
 *    exclusion/exit purge, explicit and passive memoryUpdated hydration, and
 *    the P4-aligned Live Voice gate in Node Vitest without jsdom.
 *
 * KEY COMPONENTS:
 *    - Protocol and ApiClient contract tests
 *    - chatReducer and useChatActions lifecycle tests
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../../api/client.ts';
import { parseCalendarCompatibleFrame } from '../../../api/calendar-protocol.ts';
import {
  isStreamEvent,
  isSubmitTurnRequest,
  isVisibleMessage,
  parseSseDataLine,
} from '../../../api/protocol.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('chat protocol and client for user memory and temporary chat', () => {
  it('accepts optional boolean ephemeral on SubmitTurnRequest and rejects non-boolean values', () => {
    const base = {
      sessionId: null,
      content: 'Temporary question',
      idempotencyKey: 'temp-key-123456',
    };
    expect(isSubmitTurnRequest({ ...base, ephemeral: true })).toBe(true);
    expect(isSubmitTurnRequest({ ...base, ephemeral: false })).toBe(true);
    expect(isSubmitTurnRequest({ ...base, ephemeral: 'yes' })).toBe(false);
    expect(isSubmitTurnRequest({ ...base, ephemeral: null })).toBe(false);
  });

  it('accepts memoryUpdated on assistant VisibleMessage and rejects it on user messages or non-booleans', () => {
    const assistant = {
      messageId: 'm_asst',
      turnId: 't_1',
      eventId: 'e_1',
      sequence: 2,
      role: 'assistant' as const,
      content: 'Got it, I will remember that.',
      createdAt: '2026-11-20T12:00:00.000Z',
      completionStatus: 'completed' as const,
      truncated: false,
    };
    expect(isVisibleMessage({ ...assistant, memoryUpdated: true })).toBe(true);
    expect(isVisibleMessage({ ...assistant, memoryUpdated: false })).toBe(true);
    expect(isVisibleMessage({ ...assistant, memoryUpdated: 'yes' })).toBe(false);
    expect(isVisibleMessage({ ...assistant, role: 'user', memoryUpdated: true })).toBe(false);
  });

  it('accepts memoryUpdated on SSE completed events across v1 and v3 envelopes', () => {
    expect(
      isStreamEvent({
        type: 'completed',
        assistantMessageId: 'm_1',
        outcome: 'completed',
        memoryUpdated: true,
      }),
    ).toBe(true);
    expect(
      isStreamEvent({
        type: 'completed',
        assistantMessageId: 'm_1',
        outcome: 'completed',
        memoryUpdated: 'true',
      }),
    ).toBe(false);

    const v1Frame = `data: ${JSON.stringify({
      protocolVersion: 1,
      sessionId: 'sess_1',
      turnId: 'turn_1',
      attemptId: 'att_1',
      sequence: 3,
      event: {
        type: 'completed',
        assistantMessageId: 'm_1',
        outcome: 'completed',
        memoryUpdated: true,
      },
    })}\n\n`;
    expect(parseSseDataLine(v1Frame).event).toMatchObject({
      type: 'completed',
      memoryUpdated: true,
    });

    const v3Frame = `data: ${JSON.stringify({
      protocolVersion: 3,
      sessionId: 'sess_1',
      turnId: 'turn_1',
      attemptId: 'att_1',
      sequence: 4,
      event: {
        type: 'completed',
        assistantMessageId: 'm_1',
        outcome: 'completed',
        memoryUpdated: true,
      },
    })}\n\n`;
    expect(parseCalendarCompatibleFrame(v3Frame).event).toMatchObject({
      type: 'completed',
      memoryUpdated: true,
    });
  });

  it('supports keepalive DELETE on deleteSession and avoids persisting ephemeral prompts to sessionStorage', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
    };
    const fetchFn: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return Response.json(
        {
          sessionId: 'sess_temp_1',
          turnId: 'turn_1',
          attemptId: 'att_1',
          userMessageId: 'msg_1',
          streamPath: '/sessions/sess_temp_1/turns/turn_1/stream',
        },
        { status: 202 },
      );
    };

    const client = new ApiClient({ baseUrl: '/api', fetch: fetchFn, recoveryStorage: storage });
    await client.submitTurn({
      sessionId: null,
      content: 'EPHEMERAL_PRIVATE_TEXT',
      idempotencyKey: 'temp-idem-123456',
      ephemeral: true,
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      sessionId: null,
      content: 'EPHEMERAL_PRIVATE_TEXT',
      ephemeral: true,
    });
    for (const raw of stored.values()) {
      expect(raw).not.toContain('EPHEMERAL_PRIVATE_TEXT');
    }

    await client.deleteSession('sess_temp_1', { keepalive: true });
    expect(calls[1]?.url).toBe('/api/sessions/sess_temp_1');
    expect(calls[1]?.init).toMatchObject({
      method: 'DELETE',
      keepalive: true,
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  it('rejects a pending recovery replay when ephemeral classification differs', async () => {
    let failFirst = true;
    const fetchFn: typeof fetch = async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error('network drop');
      }
      return Response.json(
        {
          sessionId: 'sess_1',
          turnId: 'turn_1',
          attemptId: 'att_1',
          userMessageId: 'msg_1',
          streamPath: '/sessions/sess_1/turns/turn_1/stream',
          processEpoch: 'epoch_1',
        },
        { status: 202 },
      );
    };
    const client = new ApiClient({ baseUrl: '/api', fetch: fetchFn, recoveryStorage: null });
    await expect(
      client.submitTurn({
        sessionId: null,
        content: 'Same prompt',
        idempotencyKey: 'idem-ephemeral-1',
        expectedEpoch: 'epoch_1',
        ephemeral: true,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    await expect(
      client.submitTurn({
        sessionId: null,
        content: 'Same prompt',
        idempotencyKey: 'idem-ephemeral-2',
        expectedEpoch: 'epoch_1',
      }),
    ).rejects.toMatchObject({ code: 'SUBMISSION_PENDING' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd frontend && npm test -- src/features/chat/state/user-memory-chat-state.test.ts
```
Expected: FAIL — `isSubmitTurnRequest`, `isVisibleMessage`, `isStreamEvent`, and `deleteSession(..., { keepalive: true })` do not yet recognize `ephemeral`, `memoryUpdated`, or `keepalive`.

- [ ] **Step 3: Write minimal implementation**

Modify `frontend/src/api/protocol.ts`:
1. Add `ephemeral?: boolean` to `SubmitTurnRequest` (lines 82–89):
```typescript
export type SubmitTurnRequest = {
  sessionId: string | null
  content: string
  idempotencyKey: string
  ephemeral?: boolean
  expectedEpoch?: string
  calendarProtocol?: 2
  calendarReplyTo?: { proposalId: string; revision: number }
}
```
2. Add `ephemeral?: boolean` to `SessionSummary` (lines 106–112):
```typescript
export type SessionSummary = {
  pinned?: boolean
  ephemeral?: boolean
  sessionId: string
  title: string
  createdAt: string
  lastActivityAt: string
}
```
3. Add `memoryUpdated?: boolean` to `VisibleMessage` (lines 132–159):
```typescript
  webSources?: WebSourceReference[]
  webActivities?: WebSearchActivity[]
  memoryUpdated?: boolean
```
4. Add `memoryUpdated?: boolean` to the `'completed'` union arm of `StreamEvent` (lines 222–233):
```typescript
      compaction?: CompactionCheckpointMeta
      contextUsage?: ContextUsageMeta
      memoryUpdated?: boolean
```
5. Add `hasValidMemoryUpdated` right after `hasValidWeatherView` (around line 329) and call it in `isVisibleMessage`:
```typescript
function hasValidMemoryUpdated(value: Record<string, unknown>): boolean {
  if (!('memoryUpdated' in value) || value.memoryUpdated === undefined) return true
  return value.role === 'assistant' && typeof value.memoryUpdated === 'boolean'
}
```
and inside `isVisibleMessage`:
```typescript
    hasValidWebProvenance(value) &&
    hasValidWeatherView(value) &&
    hasValidMemoryUpdated(value)
```
6. Update `isSubmitTurnRequest` (lines 465–492):
```typescript
  if (!hasExactKeys(body, ['sessionId', 'content', 'idempotencyKey',
    ...('ephemeral' in body ? ['ephemeral'] : []),
    ...('expectedEpoch' in body ? ['expectedEpoch'] : []),
    ...('calendarProtocol' in body ? ['calendarProtocol'] : []),
    ...('calendarReplyTo' in body ? ['calendarReplyTo'] : [])]) ||
    ('ephemeral' in body && typeof body.ephemeral !== 'boolean') ||
    ('calendarProtocol' in body && body.calendarProtocol !== 2)) {
    return false
  }
```
7. Update `isStreamEvent` case `'completed'` (lines 608–626):
```typescript
    case 'completed':
      return (
        hasExactKeys(value, ['type', 'assistantMessageId', 'outcome', ...('save' in value ? ['save'] : []),
          ...('calendarView' in value ? ['calendarView'] : []),
          ...('weatherView' in value ? ['weatherView'] : []),
          ...('webSources' in value ? ['webSources'] : []),
          ...('webActivities' in value ? ['webActivities'] : []),
          ...('compaction' in value ? ['compaction'] : []),
          ...('contextUsage' in value ? ['contextUsage'] : []),
          ...('memoryUpdated' in value ? ['memoryUpdated'] : [])]) &&
        (!('save' in value) || isSaveStateSnapshot(value.save)) &&
        (!('calendarView' in value) || isCalendarView(value.calendarView)) &&
        (!('weatherView' in value) || isWeatherView(value.weatherView)) &&
        (!('webSources' in value) || isWebSourceReferenceList(value.webSources)) &&
        (!('webActivities' in value) || isWebSearchActivityList(value.webActivities)) &&
        (!('compaction' in value) || isCompactionCheckpointMeta(value.compaction)) &&
        (!('contextUsage' in value) || isContextUsageMeta(value.contextUsage)) &&
        (!('memoryUpdated' in value) || typeof value.memoryUpdated === 'boolean') &&
        isBoundedId(value.assistantMessageId) &&
        (value.outcome === 'completed' || value.outcome === 'truncated')
      )
```

Modify `frontend/src/api/client.ts`:
1. In `persistRecovery()` (lines 184–192), never persist temporary prompts into `sessionStorage`:
```typescript
  private persistRecovery(): void {
    try {
      this.recoveryStorage?.setItem(this.recoveryKey, JSON.stringify({
        pending: this.pendingSubmission?.ephemeral ? null : this.pendingSubmission,
        ...(this.pendingRetry ? { retry: this.pendingRetry } : {}),
        epoch: this.processEpoch ?? null,
      }));
    } catch { /* Keep the same request in this client even when browser storage fails. */ }
  }
```
2. In `deleteSession` (lines 305–307), accept optional `{ keepalive?: boolean }`:
```typescript
  async deleteSession(sessionId: string, options?: { keepalive?: boolean }): Promise<void> {
    return this.request<void>(API_ROUTES.session(sessionId), {
      method: 'DELETE',
      ...(options?.keepalive ? { keepalive: true } : {}),
    });
  }
```
3. In `submitTurn` (lines 342–345), include `(pending.ephemeral === true) !== (request.ephemeral === true)` in the pending mismatch check:
```typescript
    if (pending) {
      if (pending.sessionId !== request.sessionId || pending.content !== request.content ||
        (pending.ephemeral === true) !== (request.ephemeral === true) ||
        pending.calendarProtocol !== request.calendarProtocol || JSON.stringify(pending.calendarReplyTo) !== JSON.stringify(request.calendarReplyTo))
        throw new ApiClientError('SUBMISSION_PENDING', 'An earlier submission has unknown delivery. Retry it or explicitly start a new attempt.', 0, false);
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd frontend && npm test -- src/features/chat/state/user-memory-chat-state.test.ts src/api/protocol.test.ts src/api/client.test.ts src/api/submission-recovery.test.ts
```
Expected: PASS — all 4 test files pass with zero regressions.

- [ ] **Step 5: Commit**

```bash
git add -- frontend/src/api/protocol.ts frontend/src/api/client.ts frontend/src/features/chat/state/user-memory-chat-state.test.ts
git commit -m "feat(chat): add ephemeral turn and memoryUpdated protocol support"
```

---

### Task 3: Chat Reducer for Temporary Chat Lifecycle, Live Voice Gate, and `memoryUpdated`

**Files:**
- Modify: `frontend/src/features/chat/state/chat-types.ts:50-53, 108-112, 162-176`
- Modify: `frontend/src/features/chat/state/chat-reducer.ts`
- Modify: `frontend/src/features/chat/state/user-memory-chat-state.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/features/chat/state/user-memory-chat-state.test.ts` (importing `canStartLiveVoiceForChat`, `canToggleTemporaryChat`, `chatReducer`, `initialChatState`, and `TEMPORARY_LIVE_VOICE_ENABLED` from `./chat-reducer.ts` and `type VisibleMessage` from `../../../api/protocol.ts`):

```typescript
import {
  canStartLiveVoiceForChat,
  canToggleTemporaryChat,
  chatReducer,
  initialChatState,
  TEMPORARY_LIVE_VOICE_ENABLED,
} from './chat-reducer.ts';
import type { VisibleMessage } from '../../../api/protocol.ts';

describe('chatReducer temporary chat and memoryUpdated state', () => {
  it('toggles Temporary Chat only on an unsaved empty New Chat and locks after turn 1', () => {
    expect(initialChatState.activeSessionTemporary).toBe(false);
    expect(canToggleTemporaryChat(initialChatState)).toBe(true);

    const enabled = chatReducer(initialChatState, { type: 'SET_TEMPORARY_CHAT', payload: true });
    expect(enabled.activeSessionTemporary).toBe(true);
    expect(canToggleTemporaryChat(enabled)).toBe(true);

    const submitting = chatReducer(enabled, {
      type: 'TURN_SUBMIT_START',
      payload: { userContent: 'Secret question', idempotencyKey: 'temp-12345678' },
    });
    expect(canToggleTemporaryChat(submitting)).toBe(false);
    expect(
      chatReducer(submitting, { type: 'SET_TEMPORARY_CHAT', payload: false }).activeSessionTemporary,
    ).toBe(true);

    const accepted = chatReducer(submitting, {
      type: 'TURN_ACCEPTED',
      payload: {
        sessionId: 'sess_temp_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        userMessageId: 'msg_u1',
        processEpoch: 'epoch_1',
      },
    });
    expect(accepted.activeSessionTemporary).toBe(true);
    expect(accepted.activeSessionId).toBe('sess_temp_1');
    expect(canToggleTemporaryChat(accepted)).toBe(false);
    expect(
      chatReducer(accepted, { type: 'SET_TEMPORARY_CHAT', payload: false }).activeSessionTemporary,
    ).toBe(true);
  });

  it('excludes Temporary Chat from sidebar sessions, localSessionIds, and unsaved save state', () => {
    let state = chatReducer(initialChatState, { type: 'SET_TEMPORARY_CHAT', payload: true });
    state = chatReducer(state, {
      type: 'TURN_SUBMIT_START',
      payload: { userContent: 'Off the record', idempotencyKey: 'temp-12345678' },
    });
    state = chatReducer(state, {
      type: 'TURN_ACCEPTED',
      payload: {
        sessionId: 'sess_temp_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        userMessageId: 'msg_u1',
        processEpoch: 'epoch_1',
      },
    });
    expect(state.sessions).toEqual([]);
    expect(state.localSessionIds).toEqual([]);

    state = chatReducer(state, {
      type: 'SAVE_STATE',
      payload: {
        sessionId: 'sess_temp_1',
        turnId: 'turn_1',
        save: { state: 'saving', epoch: 'epoch_1', version: 1, durableVersion: 0 },
      },
    });
    expect(state.saves['sess_temp_1']).toBeUndefined();
    expect(state.unsavedMessages['sess_temp_1']).toBeUndefined();

    // Defensive sidebar exclusion if any list payload contains an ephemeral row.
    const withServerList = chatReducer(state, {
      type: 'SESSIONS_LOADED',
      payload: {
        items: [
          {
            sessionId: 'sess_temp_1',
            title: 'Leak',
            ephemeral: true,
            createdAt: '2026-11-20T12:00:00.000Z',
            lastActivityAt: '2026-11-20T12:00:00.000Z',
          },
          {
            sessionId: 'sess_saved',
            title: 'Saved chat',
            createdAt: '2026-11-20T11:00:00.000Z',
            lastActivityAt: '2026-11-20T11:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
    });
    expect(withServerList.sessions.map((s) => s.sessionId)).toEqual(['sess_saved']);

    const afterNewChat = chatReducer(state, { type: 'NEW_CHAT' });
    expect(afterNewChat.activeSessionTemporary).toBe(false);
    expect(afterNewChat.activeSessionId).toBeNull();
    expect(afterNewChat.unsavedMessages['sess_temp_1']).toBeUndefined();
  });

  it('keeps Live Voice disabled in Temporary Chat by default and rejects live lease claims', () => {
    expect(TEMPORARY_LIVE_VOICE_ENABLED).toBe(false);
    expect(canStartLiveVoiceForChat(initialChatState)).toBe(true);

    const temp = chatReducer(initialChatState, { type: 'SET_TEMPORARY_CHAT', payload: true });
    expect(canStartLiveVoiceForChat(temp)).toBe(false);
    expect(canStartLiveVoiceForChat(temp, true)).toBe(true);

    const blockedLive = chatReducer(temp, {
      type: 'CLAIM_VOICE_INPUT',
      payload: { token: 'live-lease-1', mode: 'live' },
    });
    expect(blockedLive.voiceInput).toBeNull();

    // Dictation lease remains unaffected on unsaved temporary draft.
    const dictation = chatReducer(temp, {
      type: 'CLAIM_VOICE_INPUT',
      payload: { token: 'dict-lease-1', mode: 'dictation' },
    });
    expect(dictation.voiceInput).toEqual({ token: 'dict-lease-1', mode: 'dictation' });
    expect(canToggleTemporaryChat(dictation)).toBe(false);
  });

  it('records memoryUpdated on explicit STREAM_COMPLETED and preserves it across passive MESSAGES_LOADED hydration', () => {
    let state = chatReducer(initialChatState, {
      type: 'TURN_SUBMIT_START',
      payload: { userContent: 'Remember my dog is Beans', idempotencyKey: 'mem-12345678' },
    });
    state = chatReducer(state, {
      type: 'TURN_ACCEPTED',
      payload: {
        sessionId: 'sess_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        userMessageId: 'msg_u1',
      },
    });
    state = chatReducer(state, { type: 'STREAM_DELTA', payload: { text: 'Noted — Beans!' } });
    state = chatReducer(state, {
      type: 'STREAM_COMPLETED',
      payload: { assistantMessageId: 'msg_a1', outcome: 'completed', memoryUpdated: true },
    });
    expect(state.messages.at(-1)).toMatchObject({
      messageId: 'msg_a1',
      role: 'assistant',
      memoryUpdated: true,
    });

    // Never attach memoryUpdated in Temporary Chat even if a stray flag arrives.
    let tempState = chatReducer(initialChatState, { type: 'SET_TEMPORARY_CHAT', payload: true });
    tempState = chatReducer(tempState, {
      type: 'TURN_ACCEPTED',
      payload: {
        sessionId: 'sess_temp',
        turnId: 'turn_t1',
        attemptId: 'att_t1',
        userMessageId: 'msg_tu1',
      },
    });
    tempState = chatReducer(tempState, { type: 'STREAM_DELTA', payload: { text: 'Temporary reply' } });
    tempState = chatReducer(tempState, {
      type: 'STREAM_COMPLETED',
      payload: { assistantMessageId: 'msg_ta1', outcome: 'completed', memoryUpdated: true },
    });
    expect(tempState.messages.at(-1)?.memoryUpdated).toBeUndefined();

    // Passive hydration merges memoryUpdated: true from server even when local unsaved retain is active.
    const localAssistant: VisibleMessage = {
      messageId: 'msg_a2',
      turnId: 'turn_2',
      eventId: 'evt_a2',
      sequence: 4,
      role: 'assistant',
      content: 'Passive batch reply',
      createdAt: '2026-11-20T12:01:00.000Z',
      completionStatus: 'completed',
      truncated: false,
    };
    const withPendingSave = {
      ...initialChatState,
      activeSessionId: 'sess_1',
      messages: [localAssistant],
      saves: {
        sess_1: {
          turnId: 'turn_2',
          value: { state: 'saving' as const, epoch: 'epoch_1', version: 2, durableVersion: 1 },
        },
      },
    };
    const hydrated = chatReducer(withPendingSave, {
      type: 'MESSAGES_LOADED',
      payload: {
        sessionId: 'sess_1',
        items: [{ ...localAssistant, memoryUpdated: true }],
        nextCursor: null,
        olderAvailable: false,
        save: { state: 'saving', epoch: 'epoch_1', version: 1, durableVersion: 1 },
      },
    });
    expect(hydrated.messages[0]?.memoryUpdated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd frontend && npm test -- src/features/chat/state/user-memory-chat-state.test.ts
```
Expected: FAIL — `TEMPORARY_LIVE_VOICE_ENABLED`, `canToggleTemporaryChat`, `canStartLiveVoiceForChat`, `activeSessionTemporary`, and `SET_TEMPORARY_CHAT` are not defined yet.

- [ ] **Step 3: Write minimal implementation**

Modify `frontend/src/features/chat/state/chat-types.ts`:
1. Add `activeSessionTemporary: boolean;` right after `activeSessionTitle: string | null;` (line 51):
```typescript
  activeSessionId: string | null;
  activeSessionTitle: string | null;
  activeSessionTemporary: boolean;
```
2. Add `| { type: 'SET_TEMPORARY_CHAT'; payload: boolean }` right after `| { type: 'NEW_CHAT' }` (line 108).
3. Add `memoryUpdated?: boolean;` inside `STREAM_COMPLETED['payload']` (line 174):
```typescript
        compaction?: CompactionCheckpointMeta;
        contextUsage?: ContextUsageMeta;
        memoryUpdated?: boolean;
```

Modify `frontend/src/features/chat/state/chat-reducer.ts`:
1. Export the Live Voice gate constant and pure helpers near `isBusyAttemptStatus` (around line 136):
```typescript
/** Product gate matching P4's server-side `allowTemporaryLive` seam (off by default). */
export const TEMPORARY_LIVE_VOICE_ENABLED = false;

export function canToggleTemporaryChat(
  state: Pick<
    ChatState,
    'activeSessionId' | 'messages' | 'isSubmitting' | 'isStreaming' | 'turnStatus' | 'voiceInput'
  >,
): boolean {
  return (
    state.activeSessionId === null &&
    state.messages.length === 0 &&
    !state.isSubmitting &&
    !state.isStreaming &&
    !isBusyAttemptStatus(state.turnStatus) &&
    state.voiceInput === null
  );
}

export function canStartLiveVoiceForChat(
  state: Pick<ChatState, 'activeSessionTemporary'>,
  allowTemporaryLive = TEMPORARY_LIVE_VOICE_ENABLED,
): boolean {
  return !state.activeSessionTemporary || allowTemporaryLive === true;
}
```
2. Add `activeSessionTemporary: false,` to `initialChatState` (line 150).
3. Add helper to drop departing temporary session save/unsaved maps cleanly (right above `chatReducer`):
```typescript
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}
```
4. Update `chatReducer` cases in `frontend/src/features/chat/state/chat-reducer.ts`:
   - `SAVE_STATE` (top of case, right after destructuring):
     ```typescript
     if (state.activeSessionTemporary && sessionId === state.activeSessionId) {
       return state;
     }
     ```
   - `SET_TEMPORARY_CHAT` (new case right after `NEW_CHAT`):
     ```typescript
     case 'SET_TEMPORARY_CHAT':
       if (!canToggleTemporaryChat(state)) return state;
       return state.activeSessionTemporary === action.payload
         ? state
         : { ...state, activeSessionTemporary: action.payload };
     ```
   - `NEW_CHAT` (lines 386–426):
     ```typescript
     case 'NEW_CHAT': {
       const leavingTempId = state.activeSessionTemporary ? state.activeSessionId : null;
       return {
         ...state,
         saves: leavingTempId ? withoutKey(state.saves, leavingTempId) : state.saves,
         unsavedMessages: leavingTempId
           ? withoutKey(state.unsavedMessages, leavingTempId)
           : state.activeSessionId && state.saves[state.activeSessionId] && state.saves[state.activeSessionId].value.state !== 'saved'
             ? { ...state.unsavedMessages, [state.activeSessionId]: state.messages }
             : state.unsavedMessages,
         activeSessionId: null,
         activeSessionTitle: null,
         activeSessionTemporary: false,
         messages: [],
         canvasMessages: [],
         messagesLoading: false,
         messagesError: null,
         messagesCursor: null,
         olderAvailable: false,
         compaction: null,
         contextUsage: null,
         activeTurnId: null,
         activeAttemptId: null,
         activeTurnMode: null,
         turnStatus: 'idle',
         isStreaming: false,
         streamText: '',
         turnError: null,
         isSubmitting: false,
         voiceInput: null,
         sidebarOpen: false,
         canvasOpen: false,
         activeCanvasArtifactId: null,
         closedCanvasArtifactIds: [],
         calendarProgress: null,
         calendarOperationsByTurn: {},
         calendarViewsByTurn: {},
         calendarTurnOrder: [],
         calendarClarification: null,
         calendarLastSequence: -1,
         webActivitiesByTurn: {},
         webSourcesByTurn: {},
         webLastSequenceByTurn: {},
         weatherViewsByTurn: {},
         weatherLastSequenceByTurn: {},
         pendingWebContinuationBreak: false,
       };
     }
     ```
   - `CLAIM_VOICE_INPUT` (lines 431–434):
     ```typescript
     case 'CLAIM_VOICE_INPUT':
       if (action.payload.mode === 'live' && !canStartLiveVoiceForChat(state)) return state;
       return state.voiceInput || state.isStreaming || state.isSubmitting || isBusyAttemptStatus(state.turnStatus)
         ? state
         : { ...state, voiceInput: action.payload };
     ```
   - `BIND_VOICE_CONVERSATION` (lines 450–456):
     ```typescript
     if (!turnId || !save || state.activeSessionTemporary) {
       return {
         ...state,
         activeSessionId: conversationId,
         activeSessionTitle: nextTitle,
       };
     }
     ```
   - `SESSIONS_LOADED` (lines 524–535):
     ```typescript
     case 'SESSIONS_LOADED': {
       const merged = new Map(
         action.payload.items
           .filter((item) => item.ephemeral !== true)
           .map((item) => [item.sessionId, item]),
       );
       for (const item of state.sessions) {
         if (
           item.ephemeral !== true &&
           (state.localSessionIds.includes(item.sessionId) ||
             (action.payload.revision !== undefined &&
               action.payload.revision !== state.sessionsRevision))
         ) {
           merged.set(item.sessionId, item);
         }
       }
       return {
         ...state,
         sessionsLoading: false,
         sessions: sortSessions([...merged.values()]),
         sessionsCursor: action.payload.nextCursor,
         hasMoreSessions: action.payload.nextCursor !== null,
       };
     }
     ```
   - `SESSIONS_APPENDED` (lines 537–551):
     ```typescript
     for (const item of action.payload.items) {
       if (item.ephemeral !== true && !state.localSessionIds.includes(item.sessionId)) {
         merged.set(item.sessionId, item);
       }
     }
     ```
   - `SESSION_UPDATED` (lines 556–559):
     ```typescript
     case 'SESSION_UPDATED':
       return {
         ...state,
         sessionsRevision: state.sessionsRevision + 1,
         sessions: action.payload.ephemeral === true
           ? state.sessions.filter((session) => session.sessionId !== action.payload.sessionId)
           : sortSessions(
               state.sessions.map((session) =>
                 session.sessionId === action.payload.sessionId ? action.payload : session,
               ),
             ),
         activeSessionTitle:
           state.activeSessionId === action.payload.sessionId
             ? action.payload.title
             : state.activeSessionTitle,
       };
     ```
   - `SELECT_SESSION` (lines 566–603):
     ```typescript
     case 'SELECT_SESSION': {
       const leavingTempId = state.activeSessionTemporary ? state.activeSessionId : null;
       return {
         ...state,
         saves: leavingTempId ? withoutKey(state.saves, leavingTempId) : state.saves,
         unsavedMessages: leavingTempId
           ? withoutKey(state.unsavedMessages, leavingTempId)
           : state.activeSessionId && state.saves[state.activeSessionId] && state.saves[state.activeSessionId].value.state !== 'saved'
             ? { ...state.unsavedMessages, [state.activeSessionId]: state.messages }
             : state.unsavedMessages,
         activeSessionId: action.payload.sessionId,
         activeSessionTitle: action.payload.title,
         activeSessionTemporary: false,
         messages: state.unsavedMessages[action.payload.sessionId] ?? [],
         canvasMessages: [],
         messagesLoading: true,
         messagesError: null,
         compaction: null,
         contextUsage: null,
         activeTurnId: null,
         activeAttemptId: null,
         activeTurnMode: null,
         turnStatus: 'idle',
         isStreaming: false,
         streamText: '',
         turnError: null,
         voiceInput: null,
         sidebarOpen: false,
         canvasOpen: false,
         activeCanvasArtifactId: null,
         closedCanvasArtifactIds: [],
         calendarProgress: null,
         calendarOperationsByTurn: {},
         calendarViewsByTurn: {},
         calendarTurnOrder: [],
         calendarClarification: null,
         calendarLastSequence: -1,
         webActivitiesByTurn: {},
         webSourcesByTurn: {},
         webLastSequenceByTurn: {},
         weatherViewsByTurn: {},
         weatherLastSequenceByTurn: {},
         pendingWebContinuationBreak: false,
       };
     }
     ```
   - `MESSAGES_LOADED` (lines 615) & `OLDER_MESSAGES_LOADED` (lines 752–753): when retaining local `state.messages` over incoming server rows, preserve `memoryUpdated: true` from any matching server assistant row:
     ```typescript
     if (retain) {
       for (const item of state.messages) {
         const serverItem = incoming.get(item.messageId);
         incoming.set(
           item.messageId,
           serverItem?.memoryUpdated === true && item.role === 'assistant'
             ? { ...item, memoryUpdated: true }
             : item,
         );
       }
     }
     ```
     and similarly in `OLDER_MESSAGES_LOADED`:
     ```typescript
     for (const item of action.payload.items) merged.set(item.messageId, item);
     for (const item of state.messages) {
       const olderItem = merged.get(item.messageId);
       merged.set(
         item.messageId,
         olderItem?.memoryUpdated === true && item.role === 'assistant'
           ? { ...item, memoryUpdated: true }
           : item,
       );
     }
     ```
   - `TURN_ACCEPTED` (lines 851–856): guard optimistic sidebar/save insertion with `const trackInSidebar = Boolean(action.payload.processEpoch) && !state.activeSessionTemporary;`:
     ```typescript
     sessionsRevision: state.sessionsRevision + (trackInSidebar ? 1 : 0),
     localSessionIds: trackInSidebar ? [...new Set([...state.localSessionIds, action.payload.sessionId])] : state.localSessionIds,
     saves: trackInSidebar && state.saves[action.payload.sessionId]?.value.epoch !== action.payload.processEpoch
       ? Object.fromEntries(Object.entries(state.saves).filter(([id]) => id !== action.payload.sessionId)) : state.saves,
     sessions: trackInSidebar ? sortSessions([...state.sessions.filter(s => s.sessionId !== action.payload.sessionId),
       { ...(existing ?? { sessionId: action.payload.sessionId, title: firstInput.slice(0, 80), createdAt: at }), lastActivityAt: at }]) : state.sessions,
     ```
   - `STREAM_COMPLETED` (lines 1017–1031): attach `...(action.payload.memoryUpdated === true && !state.activeSessionTemporary ? { memoryUpdated: true as const } : {}),` to `assistantMsg`.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd frontend && npm test -- src/features/chat/state/user-memory-chat-state.test.ts src/features/chat/state/chat-reducer.test.ts src/features/chat/state/memory-save-state.test.ts src/features/chat/state/compaction-chat-state.test.ts src/features/chat/state/voice-draft-lock.test.ts
```
Expected: PASS — all reducer suites pass.

- [ ] **Step 5: Commit**

```bash
git add -- frontend/src/features/chat/state/chat-types.ts frontend/src/features/chat/state/chat-reducer.ts frontend/src/features/chat/state/user-memory-chat-state.test.ts
git commit -m "feat(chat): manage temporary chat lifecycle and memoryUpdated state"
```

---

### Task 4: Orchestration (`use-chat.ts`, `chat-context.tsx`) & Live Voice Gate (`useLiveVoice.ts`)

**Files:**
- Modify: `frontend/src/features/chat/state/use-chat.ts`
- Modify: `frontend/src/features/chat/state/chat-context.tsx`
- Modify: `frontend/src/features/voice/state/useLiveVoice.ts`
- Modify: `frontend/src/features/chat/state/user-memory-chat-state.test.ts`

- [ ] **Step 1: Write the failing test**

Append orchestration, `pagehide`, switch/New Chat purge, and Live Voice gate tests to `frontend/src/features/chat/state/user-memory-chat-state.test.ts` (importing `createElement` from `'react'`, `renderToStaticMarkup` from `'react-dom/server'`, `type CalendarCompatibleEnvelope` from `'../../../api/calendar-protocol.ts'`, `type ChatAction, type ChatState` from `'./chat-types.ts'`, and `startTemporaryChatPagehideEffect, useChatActions` from `'./use-chat.ts'`):

```typescript
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  CalendarCompatibleEnvelope,
  CalendarStreamEvent,
  CalendarStreamEventV3,
} from '../../../api/calendar-protocol.ts';
import type { ChatAction, ChatState } from './chat-types.ts';
import { startTemporaryChatPagehideEffect, useChatActions } from './use-chat.ts';

type StreamEventCallback = (
  event: CalendarStreamEvent | CalendarStreamEventV3,
  envelope: CalendarCompatibleEnvelope,
) => void;

function createHookHarness(initial: ChatState, client: ApiClient) {
  let state = initial;
  const dispatched: ChatAction[] = [];
  const dispatch = (action: ChatAction) => {
    dispatched.push(action);
    state = chatReducer(state, action);
  };
  let actions!: ReturnType<typeof useChatActions>;
  function Harness() {
    actions = useChatActions(state, dispatch, client);
    return null;
  }
  const render = () => {
    renderToStaticMarkup(createElement(Harness));
  };
  render();
  return {
    get state() {
      return state;
    },
    get actions() {
      return actions;
    },
    dispatched,
    dispatch,
    render,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useChatActions temporary chat purge, creation-only ephemeral flag, and memoryUpdated stream', () => {
  it('sends ephemeral: true only on turn 1, skips sidebar reconcile, and purges with keepalive on New Chat and session switch', async () => {
    const client = new ApiClient({ fetch: vi.fn() });
    const listSessionsSpy = vi.spyOn(client, 'listSessions').mockResolvedValue({ items: [], nextCursor: null });
    const listMessagesSpy = vi.spyOn(client, 'listMessages').mockResolvedValue({
      items: [],
      nextCursor: null,
      olderAvailable: false,
    });
    const deleteSpy = vi.spyOn(client, 'deleteSession').mockResolvedValue(undefined);
    const submitSpy = vi
      .spyOn(client, 'submitTurn')
      .mockResolvedValueOnce({
        sessionId: 'sess_temp_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        userMessageId: 'msg_u1',
        streamPath: '/sessions/sess_temp_1/turns/turn_1/stream',
        processEpoch: 'epoch_1',
      })
      .mockResolvedValueOnce({
        sessionId: 'sess_temp_1',
        turnId: 'turn_2',
        attemptId: 'att_2',
        userMessageId: 'msg_u2',
        streamPath: '/sessions/sess_temp_1/turns/turn_2/stream',
        processEpoch: 'epoch_1',
      });

    let streamHandler: StreamEventCallback | null = null;
    vi.spyOn(client, 'connectTurnStream').mockImplementation(async (_path, handlers) => {
      streamHandler = handlers.onEvent ?? null;
    });

    const harness = createHookHarness(
      { ...initialChatState, activeSessionTemporary: true },
      client,
    );

    // Turn 1: sends ephemeral: true
    await harness.actions.submitMessage('First temp turn');
    expect(submitSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: null, ephemeral: true, content: 'First temp turn' }),
      expect.any(Object),
    );
    streamHandler!(
      { type: 'completed', assistantMessageId: 'msg_a1', outcome: 'completed' },
      {
        protocolVersion: 1,
        sessionId: 'sess_temp_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        sequence: 2,
        event: { type: 'completed', assistantMessageId: 'msg_a1', outcome: 'completed' },
      },
    );
    await flushMicrotasks();
    expect(listSessionsSpy).not.toHaveBeenCalled();
    expect(harness.state.sessions).toEqual([]);

    // Re-render hook with activeSessionId='sess_temp_1', Turn 2 omits ephemeral
    harness.render();
    await harness.actions.submitMessage('Second temp turn');
    const secondPayload = submitSpy.mock.calls[1]?.[0];
    expect(secondPayload?.sessionId).toBe('sess_temp_1');
    expect('ephemeral' in (secondPayload ?? {})).toBe(false);

    // Clicking New Chat purges with keepalive: true once
    harness.actions.startNewChat();
    expect(deleteSpy).toHaveBeenCalledExactlyOnceWith('sess_temp_1', { keepalive: true });
    expect(harness.state.activeSessionId).toBeNull();
    expect(harness.state.activeSessionTemporary).toBe(false);

    // Switching from another active Temporary Chat purges it with keepalive: true
    const switchHarness = createHookHarness(
      {
        ...initialChatState,
        activeSessionId: 'sess_temp_2',
        activeSessionTemporary: true,
      },
      client,
    );
    await switchHarness.actions.selectSession('sess_saved_1', 'Saved chat');
    expect(deleteSpy).toHaveBeenCalledWith('sess_temp_2', { keepalive: true });
    expect(listMessagesSpy).toHaveBeenCalledWith('sess_saved_1');
    expect(switchHarness.state.activeSessionTemporary).toBe(false);
  });

  it('purges an active Temporary Chat on pagehide and detaches the listener on cleanup', () => {
    const listeners = new Map<string, Set<() => void>>();
    const target = {
      addEventListener: (type: string, listener: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
      },
    };
    const onPurge = vi.fn();
    let activeTempId: string | null = null;
    const cleanup = startTemporaryChatPagehideEffect({
      target,
      getActiveTemporarySessionId: () => activeTempId,
      onPurge,
    });

    // Unsaved temporary chat (null id): no purge on pagehide.
    listeners.get('pagehide')?.forEach((fn) => fn());
    expect(onPurge).not.toHaveBeenCalled();

    // Active temporary chat: purges synchronously on pagehide.
    activeTempId = 'sess_temp_unload';
    listeners.get('pagehide')?.forEach((fn) => fn());
    expect(onPurge).toHaveBeenCalledExactlyOnceWith('sess_temp_unload');

    cleanup?.();
    listeners.get('pagehide')?.forEach((fn) => fn());
    expect(onPurge).toHaveBeenCalledTimes(1);
  });

  it('forwards memoryUpdated: true from completed SSE frames and blocks live voice lease in Temporary Chat', async () => {
    const client = new ApiClient({ fetch: vi.fn() });
    vi.spyOn(client, 'listSessions').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(client, 'submitTurn').mockResolvedValue({
      sessionId: 'sess_1',
      turnId: 'turn_1',
      attemptId: 'att_1',
      userMessageId: 'msg_u1',
      streamPath: '/sessions/sess_1/turns/turn_1/stream',
    });
    let streamHandler: StreamEventCallback | null = null;
    vi.spyOn(client, 'connectTurnStream').mockImplementation(async (_path, handlers) => {
      streamHandler = handlers.onEvent ?? null;
    });

    const harness = createHookHarness(initialChatState, client);
    await harness.actions.submitMessage('Remember I live in Chennai');
    streamHandler!(
      { type: 'delta', text: 'Saved Chennai to your memory.' },
      {
        protocolVersion: 1,
        sessionId: 'sess_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        sequence: 1,
        event: { type: 'delta', text: 'Saved Chennai to your memory.' },
      },
    );
    streamHandler!(
      { type: 'completed', assistantMessageId: 'msg_a1', outcome: 'completed', memoryUpdated: true },
      {
        protocolVersion: 1,
        sessionId: 'sess_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        sequence: 2,
        event: { type: 'completed', assistantMessageId: 'msg_a1', outcome: 'completed', memoryUpdated: true },
      },
    );
    await flushMicrotasks();
    expect(harness.state.messages.at(-1)).toMatchObject({
      messageId: 'msg_a1',
      memoryUpdated: true,
    });

    const tempHarness = createHookHarness(
      { ...initialChatState, activeSessionTemporary: true },
      client,
    );
    expect(tempHarness.actions.claimVoiceInput('live', vi.fn())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd frontend && npm test -- src/features/chat/state/user-memory-chat-state.test.ts
```
Expected: FAIL — `startTemporaryChatPagehideEffect` is not exported, `submitMessage` does not send `ephemeral: true`, `startNewChat`/`selectSession` do not call `deleteSession(..., { keepalive: true })`, and `dispatchStreamEvent` drops `memoryUpdated`.

- [ ] **Step 3: Write minimal implementation**

Modify `frontend/src/features/chat/state/use-chat.ts`:
1. Import `canStartLiveVoiceForChat` from `./chat-reducer.ts`:
```typescript
import { canStartLiveVoiceForChat } from './chat-reducer.ts';
```
2. Export `startTemporaryChatPagehideEffect` right after `startCompactionPollEffect`:
```typescript
export function startTemporaryChatPagehideEffect(params: {
  target: {
    addEventListener(type: 'pagehide', listener: () => void): void;
    removeEventListener(type: 'pagehide', listener: () => void): void;
  } | null;
  getActiveTemporarySessionId: () => string | null;
  onPurge: (sessionId: string) => void;
}): (() => void) | undefined {
  const { target, getActiveTemporarySessionId, onPurge } = params;
  if (!target) return undefined;
  const onPageHide = () => {
    const sessionId = getActiveTemporarySessionId();
    if (sessionId) {
      onPurge(sessionId);
    }
  };
  target.addEventListener('pagehide', onPageHide);
  return () => {
    target.removeEventListener('pagehide', onPageHide);
  };
}
```
3. Inside `useChatActions`:
   - Skip `startSavePollEffect` when `state.activeSessionTemporary` is `true` by passing `activeSave: state.activeSessionTemporary ? undefined : activeSave`.
   - Add deduplicated `purgeTemporarySession` with a bounded 64-entry `Set` and wire the `pagehide` effect:
     ```typescript
     const purgedTemporaryIdsRef = useRef<Set<string>>(new Set());
     const purgeTemporarySession = useCallback(
       (sessionId: string) => {
         if (!sessionId || purgedTemporaryIdsRef.current.has(sessionId)) return;
         if (purgedTemporaryIdsRef.current.size >= 64) {
           const oldest = purgedTemporaryIdsRef.current.values().next().value;
           if (oldest !== undefined) purgedTemporaryIdsRef.current.delete(oldest);
         }
         purgedTemporaryIdsRef.current.add(sessionId);
         void client.deleteSession(sessionId, { keepalive: true }).catch(() => undefined);
       },
       [client],
     );

     useEffect(
       () =>
         startTemporaryChatPagehideEffect({
           target: typeof window !== 'undefined' ? window : null,
           getActiveTemporarySessionId: () =>
             stateRef.current.activeSessionTemporary ? stateRef.current.activeSessionId : null,
           onPurge: purgeTemporarySession,
         }),
       [purgeTemporarySession],
     );
     ```
   - In `claimVoiceInput` (lines 466–474), gate `mode === 'live'` when Temporary Chat disallows Live Voice:
     ```typescript
     if (mode === 'live' && !canStartLiveVoiceForChat(stateRef.current)) return null;
     ```
   - In `dispatchStreamEvent` (`event.type === 'completed'`, lines 516–534):
     ```typescript
     ...(event.compaction ? { compaction: event.compaction } : {}),
     ...(event.contextUsage ? { contextUsage: event.contextUsage } : {}),
     ...(event.memoryUpdated === true ? { memoryUpdated: true as const } : {}),
     ```
     and skip sidebar reconcile for temporary chats:
     ```typescript
     if (!event.save && !stateRef.current.activeSessionTemporary) {
       reconcileSessionsAfterTurnRef.current(envelope.sessionId);
     }
     ```
   - In `startNewChat` (lines 662–671):
     ```typescript
     const startNewChat = useCallback(() => {
       const tempSessionId = stateRef.current.activeSessionTemporary
         ? stateRef.current.activeSessionId
         : null;
       generationRef.current += 1;
       invalidateSessionReconcileForNavigationRef.current();
       if (activeAbortControllerRef.current) {
         activeAbortControllerRef.current.abort();
         activeAbortControllerRef.current = null;
       }
       coalescer.cancel();
       dispatch({ type: 'NEW_CHAT' });
       if (tempSessionId) {
         purgeTemporarySession(tempSessionId);
       }
     }, [dispatch, coalescer, purgeTemporarySession]);
     ```
   - In `selectSession` (lines 673–711):
     ```typescript
     const prevTempSessionId =
       stateRef.current.activeSessionTemporary &&
       stateRef.current.activeSessionId &&
       stateRef.current.activeSessionId !== sessionId
         ? stateRef.current.activeSessionId
         : null;
     ```
     and right after `dispatch({ type: 'SELECT_SESSION', payload: { sessionId, title } })`:
     ```typescript
     if (prevTempSessionId) {
       purgeTemporarySession(prevTempSessionId);
     }
     ```
     (Add `purgeTemporarySession` to `selectSession`'s dependency array.)
   - In `submitMessage` (lines 944–960):
     ```typescript
     const isNewTemporary = state.activeSessionId === null && state.activeSessionTemporary;
     const submittingTemporary = state.activeSessionTemporary;
     const response = await runWithPendingRecovery(client, () =>
       client.submitTurn(
         {
           sessionId: state.activeSessionId,
           content: text,
           idempotencyKey,
           ...(isNewTemporary ? { ephemeral: true } : {}),
           calendarProtocol: 2,
           ...(proposal?.proposalRevision !== undefined ? { calendarReplyTo: {
             proposalId: proposal.proposalId, revision: proposal.proposalRevision,
           } } : {}),
         },
         { signal: abortController.signal },
       ),
     );
     if (generationRef.current !== generation || abortController.signal.aborted) {
       if (submittingTemporary) purgeTemporarySession(response.sessionId);
       return;
     }
     ```
     (Add `state.activeSessionTemporary` and `purgeTemporarySession` to `submitMessage`'s dependency array.)

Modify `frontend/src/features/chat/state/chat-context.tsx`:
1. Import `canStartLiveVoiceForChat` from `./chat-reducer.ts`:
```typescript
import { canStartLiveVoiceForChat, chatReducer, initialChatState } from './chat-reducer.ts';
```
2. Disable `startVoiceConversation` in the context value while Temporary Chat is active (so `Composer` disables the Live Voice button automatically without editing `Composer.tsx`):
```typescript
  const effectiveStartVoiceConversation = canStartLiveVoiceForChat(state)
    ? startVoiceConversation
    : undefined;

  const value = useMemo(
    () => ({
      state,
      dispatch,
      actions,
      client,
      startVoiceConversation: effectiveStartVoiceConversation,
    }),
    [state, dispatch, actions, client, effectiveStartVoiceConversation],
  );
```

Modify `frontend/src/features/voice/state/useLiveVoice.ts`:
1. Import `canStartLiveVoiceForChat, TEMPORARY_LIVE_VOICE_ENABLED` from `../../chat/state/chat-reducer.ts`.
2. Extend `useLiveVoice` options with `temporaryChat?: boolean; allowTemporaryLive?: boolean;` and guard `start()` before touching the DOM or controller:
```typescript
export function useLiveVoice(options: {
  conversationId: string | null;
  draft: string;
  temporaryChat?: boolean;
  allowTemporaryLive?: boolean;
  bindings: LiveVoiceBindings;
}) {
```
and inside `start`:
```typescript
  const start = () => {
    const current = latest.current;
    if (
      !config?.enabledModes.live ||
      document.hidden ||
      !canStartLiveVoiceForChat(
        { activeSessionTemporary: Boolean(current.temporaryChat) },
        current.allowTemporaryLive ?? TEMPORARY_LIVE_VOICE_ENABLED,
      )
    ) {
      return;
    }
    const draft = snapshotLiveDraft(document.querySelector<HTMLTextAreaElement>('.aurvin-textarea'), current.draft);
    void controller.start(draft, current.conversationId, config);
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd frontend && npm test -- src/features/chat/state/user-memory-chat-state.test.ts src/features/chat/state/sidebar-followup-reconcile.test.ts src/features/chat/state/chat-orchestration.test.ts src/features/chat/state/memory-save-state.test.ts src/App.assembly.test.ts
```
Expected: PASS — all 5 suites pass.

- [ ] **Step 5: Commit**

```bash
git add -- frontend/src/features/chat/state/use-chat.ts frontend/src/features/chat/state/chat-context.tsx frontend/src/features/voice/state/useLiveVoice.ts frontend/src/features/chat/state/user-memory-chat-state.test.ts
git commit -m "feat(chat): purge temporary chats on exit and gate temporary live voice"
```

---

### Task 5: `✓ Memory updated` Pill, Temporary Chat Header Controls, and `MemoryCard` Navigation

**Files:**
- Modify: `frontend/src/components/MessageItem.tsx`
- Modify: `frontend/src/components/Transcript.tsx`
- Modify: `frontend/src/features/chat/ChatView.tsx`
- Modify: `frontend/src/features/chat/ChatView.test.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/features/admin-config/AdminDashboard.tsx`

- [ ] **Step 1: Write the failing test**

Expand `frontend/src/features/chat/ChatView.test.ts`:

```typescript
/**
 * ============================================================================
 * FILE: ChatView.test.ts
 * LOCATION: frontend/src/features/chat/ChatView.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify ChatView exports, Temporary Chat header states, and Memory updated pill.
 *
 * ROLE IN PROJECT:
 *    Node-environment SSR checks for the assembled chat feature view, header
 *    Temporary Chat toggle/lock/pill, clickable memory indicator, and focus helper.
 *
 * KEY COMPONENTS:
 *    - Temporary Chat header toggle vs locked active pill assertions
 *    - Minimalistic ✓ Memory updated pill on assistant turns only
 *    - AdminDashboard focusMemoryCardElement seam targeting #aurvin-personalization-memory
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisibleMessage } from '../../api/protocol.ts';
import { MessageItem, shouldShowMemoryUpdatedPill } from '../../components/MessageItem.tsx';
import { Transcript } from '../../components/Transcript.tsx';
import { focusMemoryCardElement } from '../admin-config/AdminDashboard.tsx';
import { MEMORY_CARD_ELEMENT_ID } from '../personalization/MemoryCard.tsx';
import { ChatView, getTemporaryChatHeaderState } from './ChatView.tsx';
import { initialChatState } from './state/chat-reducer.ts';
import type { ChatState } from './state/chat-types.ts';

const chatContext = vi.hoisted(() => ({
  state: {} as ChatState,
  dispatch: vi.fn(),
  actions: {
    startNewChat: vi.fn(),
    continueInNewChat: vi.fn(),
    selectSession: vi.fn(),
    loadOlderMessages: vi.fn(),
    loadMoreSessions: vi.fn(),
    setDraft: vi.fn(),
    submitMessage: vi.fn(),
    retrySave: vi.fn(),
    cancelCurrentTurn: vi.fn(),
    retryTurn: vi.fn(),
    isVoiceInputLocked: vi.fn(() => false),
    claimVoiceInput: vi.fn(() => null),
    writeVoiceDraft: vi.fn(() => false),
    releaseVoiceInput: vi.fn(),
    bindVoiceConversation: vi.fn(() => false),
  },
  client: {} as Record<string, unknown>,
  startVoiceConversation: undefined as (() => void) | undefined,
}));

vi.mock('./state/chat-context.tsx', () => ({ useChat: () => chatContext }));
vi.mock('../voice/dictation/useDictation.ts', () => ({
  useDictation: () => ({
    config: null,
    locked: false,
    phase: 'idle',
    status: '',
    notice: null,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  }),
}));

function assistantMessage(overrides: Partial<VisibleMessage> = {}): VisibleMessage {
  return {
    messageId: 'msg_a1',
    turnId: 'turn_1',
    eventId: 'evt_a1',
    sequence: 2,
    role: 'assistant',
    content: 'Noted — I will remember your preference.',
    createdAt: '2026-11-20T12:00:00.000Z',
    completionStatus: 'completed',
    truncated: false,
    ...overrides,
  };
}

describe('ChatView component, Temporary Chat header, and Memory updated pill', () => {
  beforeEach(() => {
    chatContext.state = { ...initialChatState };
    chatContext.dispatch.mockReset();
  });

  it('is exported as a React functional component', () => {
    expect(typeof ChatView).toBe('function');
  });

  it('shows Temporary chat toggle on unsaved New Chat, active pill when enabled, and locks toggle after turn 1', () => {
    // 1. Unsaved New Chat (temporary off): toggle visible, active pill hidden
    expect(getTemporaryChatHeaderState(chatContext.state, false)).toEqual({
      showToggle: true,
      togglePressed: false,
      showActivePill: false,
    });
    const idleHtml = renderToStaticMarkup(createElement(ChatView));
    expect(idleHtml).toContain('aurvin-temp-chat-toggle');
    expect(idleHtml).toContain('aria-pressed="false"');
    expect(idleHtml).not.toContain('Temporary chat — not saved, memory off');

    // 2. Unsaved New Chat (temporary on): toggle pressed + active pill visible
    chatContext.state = { ...initialChatState, activeSessionTemporary: true };
    const armedHtml = renderToStaticMarkup(createElement(ChatView));
    expect(armedHtml).toContain('aurvin-temp-chat-toggle');
    expect(armedHtml).toContain('aria-pressed="true"');
    expect(armedHtml).toContain('Temporary chat — not saved, memory off');

    // 3. After turn 1 in Temporary Chat: toggle locked (hidden), active pill stays visible, save banner suppressed
    chatContext.state = {
      ...initialChatState,
      activeSessionId: 'sess_temp_1',
      activeSessionTemporary: true,
      messages: [assistantMessage({ content: 'Temporary answer' })],
      saves: {
        sess_temp_1: {
          turnId: 'turn_1',
          value: { state: 'saving', epoch: 'epoch_1', version: 1, durableVersion: 0 },
        },
      },
    };
    const lockedHtml = renderToStaticMarkup(createElement(ChatView));
    expect(lockedHtml).not.toContain('aurvin-temp-chat-toggle');
    expect(lockedHtml).toContain('Temporary chat — not saved, memory off');
    expect(lockedHtml).not.toContain('Answer ready. Saving');

    // 4. Normal saved chat: neither toggle nor temporary pill rendered
    chatContext.state = {
      ...initialChatState,
      activeSessionId: 'sess_saved_1',
      activeSessionTemporary: false,
      messages: [assistantMessage({ content: 'Saved answer' })],
    };
    const savedHtml = renderToStaticMarkup(createElement(ChatView));
    expect(savedHtml).not.toContain('aurvin-temp-chat-toggle');
    expect(savedHtml).not.toContain('Temporary chat — not saved, memory off');
  });

  it('renders minimalistic clickable Memory updated pill only for assistant messages with memoryUpdated: true', () => {
    const updated = assistantMessage({ memoryUpdated: true });
    expect(shouldShowMemoryUpdatedPill(updated)).toBe(true);
    expect(shouldShowMemoryUpdatedPill(assistantMessage({ memoryUpdated: false }))).toBe(false);
    expect(shouldShowMemoryUpdatedPill(assistantMessage())).toBe(false);
    expect(shouldShowMemoryUpdatedPill({ role: 'user', memoryUpdated: true })).toBe(false);

    const updatedHtml = renderToStaticMarkup(
      createElement(MessageItem, { message: updated, onOpenMemorySettings: vi.fn() }),
    );
    expect(updatedHtml).toContain('aurvin-memory-updated-pill');
    expect(updatedHtml).toContain('Memory updated');
    expect(updatedHtml).toContain('Open Personalization memory settings');

    const plainHtml = renderToStaticMarkup(createElement(MessageItem, { message: assistantMessage() }));
    expect(plainHtml).not.toContain('aurvin-memory-updated-pill');
    expect(plainHtml).not.toContain('Memory updated');

    // Transcript suppresses memory pill in Temporary Chat defensively.
    chatContext.state = {
      ...initialChatState,
      activeSessionId: 'sess_temp_1',
      activeSessionTemporary: true,
      messages: [updated],
    };
    const tempTranscriptHtml = renderToStaticMarkup(
      createElement(Transcript, { onOpenMemorySettings: vi.fn() }),
    );
    expect(tempTranscriptHtml).not.toContain('aurvin-memory-updated-pill');
  });

  it('focuses and scrolls to P5 MemoryCard element id via focusMemoryCardElement', () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const doc = {
      getElementById: vi.fn((id: string) =>
        id === MEMORY_CARD_ELEMENT_ID ? ({ scrollIntoView, focus } as unknown as HTMLElement) : null,
      ),
    };
    expect(focusMemoryCardElement(doc)).toBe(true);
    expect(doc.getElementById).toHaveBeenCalledWith(MEMORY_CARD_ELEMENT_ID);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focusMemoryCardElement({ getElementById: () => null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd frontend && npm test -- src/features/chat/ChatView.test.ts
```
Expected: FAIL — `shouldShowMemoryUpdatedPill`, `getTemporaryChatHeaderState`, and `focusMemoryCardElement` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

1. Modify `frontend/src/components/MessageItem.tsx`:
   - Export `shouldShowMemoryUpdatedPill` above `MessageItem`:
     ```typescript
     // oxlint-disable-next-line react/only-export-components -- pure predicate shared with tests
     export function shouldShowMemoryUpdatedPill(
       message: Pick<VisibleMessage, 'role' | 'memoryUpdated'>,
     ): boolean {
       return message.role === 'assistant' && message.memoryUpdated === true;
     }
     ```
   - Add `onOpenMemorySettings?: () => void` to `MessageItem` props.
   - Build `memoryUpdatedPill` right before the `if (message.voiceSessionId)` early return (reusing already-imported `IconCheck` and existing `.aurvin-compaction-pill` muted pill tokens):
     ```tsx
     const memoryUpdatedPill = shouldShowMemoryUpdatedPill(message) ? (
       <button
         type="button"
         className="aurvin-compaction-pill aurvin-memory-updated-pill"
         aria-label="Memory updated. Open Personalization memory settings"
         onClick={() => onOpenMemorySettings?.()}
         style={{
           gap: '5px',
           padding: '2px 10px',
           cursor: onOpenMemorySettings ? 'pointer' : 'default',
         }}
       >
         <IconCheck size={12} />
         <span>Memory updated</span>
       </button>
     ) : null;
     ```
   - In the `if (message.voiceSessionId)` return block (lines 120–153), render `{memoryUpdatedPill}` directly after the `.aurvin-voice-chat-pill` button.
   - In the regular assistant branch (line 282), replace `{copyButton ? <div className="aurvin-message-actions">{copyButton}</div> : null}` with:
     ```tsx
     {copyButton || memoryUpdatedPill ? (
       <div className="aurvin-message-actions">
         {copyButton}
         {memoryUpdatedPill}
       </div>
     ) : null}
     ```

2. Modify `frontend/src/components/Transcript.tsx`:
   - Accept optional `onOpenMemorySettings?: () => void` on `Transcript`:
     ```tsx
     export function Transcript({
       children,
       onOpenMemorySettings,
     }: {
       children?: ReactNode;
       onOpenMemorySettings?: () => void;
     } = {}) {
     ```
   - Pass `onOpenMemorySettings` in `messageActions`, and when rendering `displayMessages`, defensively strip `memoryUpdated` if `state.activeSessionTemporary` is true:
     ```tsx
     const messageActions = {
       activeArtifactId: state.canvasOpen ? state.activeCanvasArtifactId : null,
       onOpenArtifact,
       onRetry: actions.retryTurn,
       onOpenMemorySettings,
     };
     ```
     and in the map:
     ```tsx
     <MessageItem
       message={
         state.activeSessionTemporary && message.memoryUpdated
           ? { ...message, memoryUpdated: undefined }
           : message
       }
       {...messageActions}
     />
     ```

3. Modify `frontend/src/features/chat/ChatView.tsx`:
   - Import `canToggleTemporaryChat` from `./state/chat-reducer.ts` and `type ChatState` from `./state/chat-types.ts`.
   - Export `TemporaryChatHeaderState` and `getTemporaryChatHeaderState` above `ChatView`:
     ```typescript
     export type TemporaryChatHeaderState = {
       showToggle: boolean;
       togglePressed: boolean;
       showActivePill: boolean;
     };

     // oxlint-disable-next-line react/only-export-components -- pure header predicate shared with tests
     export function getTemporaryChatHeaderState(
       state: Pick<
         ChatState,
         | 'activeSessionId'
         | 'activeSessionTemporary'
         | 'messages'
         | 'isSubmitting'
         | 'isStreaming'
         | 'turnStatus'
         | 'voiceInput'
       >,
       liveActive: boolean,
     ): TemporaryChatHeaderState {
       if (liveActive) {
         return { showToggle: false, togglePressed: false, showActivePill: false };
       }
       const canToggle = canToggleTemporaryChat(state);
       const isTemporary = Boolean(state.activeSessionTemporary);
       return {
         showToggle: canToggle,
         togglePressed: canToggle && isTemporary,
         showActivePill: isTemporary,
       };
     }
     ```
   - Add `onOpenMemorySettings?: () => void;` to `ChatView` props.
   - Suppress `saveLabel` in Temporary Chat:
     ```typescript
     const currentSave =
       state.activeSessionId && !state.activeSessionTemporary
         ? state.saves?.[state.activeSessionId]?.value
         : undefined;
     ```
   - Compute `const tempHeader = getTemporaryChatHeaderState(state, liveActive);` right after `liveActive`.
   - Update the right-hand side of `<header className="aurvin-header">` (lines 527–557):
     ```tsx
     {tempHeader.showToggle || tempHeader.showActivePill || (sessionArtifacts.length > 0 && !liveActive) ? (
       <div className="aurvin-header-right">
         {tempHeader.showActivePill ? (
           <span className="aurvin-compaction-pill aurvin-temp-chat-pill" role="status">
             Temporary chat — not saved, memory off
           </span>
         ) : null}
         {tempHeader.showToggle ? (
           <button
             type="button"
             className="aurvin-canvas-header-btn aurvin-temp-chat-toggle"
             data-open={tempHeader.togglePressed ? 'true' : 'false'}
             aria-pressed={tempHeader.togglePressed}
             aria-label={tempHeader.togglePressed ? 'Disable temporary chat' : 'Enable temporary chat'}
             onClick={() =>
               dispatch({ type: 'SET_TEMPORARY_CHAT', payload: !state.activeSessionTemporary })
             }
           >
             <span>Temporary chat</span>
           </button>
         ) : null}
         {sessionArtifacts.length > 0 && !liveActive ? (
           <button
             ref={headerCanvasToggleRef}
             type="button"
             className="aurvin-canvas-header-btn"
             data-open={showCanvasPanel ? 'true' : 'false'}
             aria-label={showCanvasPanel ? 'Close Canvas panel' : 'Open Canvas panel'}
             aria-expanded={showCanvasPanel}
             aria-controls="aurvin-canvas-panel"
             onClick={toggleCanvasPanel}
           >
             <svg
               width="15"
               height="15"
               viewBox="0 0 24 24"
               fill="none"
               stroke="currentColor"
               strokeWidth="1.8"
               strokeLinecap="round"
               strokeLinejoin="round"
               aria-hidden="true"
             >
               <rect x="3" y="4" width="18" height="16" rx="2" />
               <path d="M14 4v16" />
             </svg>
             <span>Canvas</span>
             <span className="aurvin-canvas-header-count">{sessionArtifacts.length}</span>
           </button>
         ) : null}
       </div>
     ) : null}
     ```
   - Pass `onOpenMemorySettings={props.onOpenMemorySettings ?? props.onManageAurvin}` to `<Transcript>`.

4. Modify `frontend/src/features/admin-config/AdminDashboard.tsx`:
   - Import `MEMORY_CARD_ELEMENT_ID` from `'../personalization/MemoryCard.tsx'`.
   - Export `focusMemoryCardElement` above `AdminDashboard`:
     ```typescript
     // oxlint-disable-next-line react/only-export-components -- pure focus helper shared with tests
     export function focusMemoryCardElement(
       doc: Pick<Document, 'getElementById'> | null = typeof document !== 'undefined' ? document : null,
     ): boolean {
       const node = doc?.getElementById(MEMORY_CARD_ELEMENT_ID);
       if (!node) return false;
       node.scrollIntoView?.({ block: 'center' });
       node.focus?.();
       return true;
     }
     ```
   - Add `focusTarget?: 'memory' | null; onConsumeFocusTarget?: () => void;` to `AdminDashboardProps` and destructure them with `focusTarget = null`.
   - Replace the mount heading-focus `useEffect` (lines 297–299) so `focusTarget === 'memory'` is never overridden by heading focus, and add the memory scroll/focus effect:
     ```typescript
     const initialFocusTargetRef = useRef(focusTarget);

     useEffect(() => {
       if (initialFocusTargetRef.current === 'memory') return;
       headingRef.current?.focus();
     }, []);

     useEffect(() => {
       if (focusTarget !== 'memory') return undefined;
       setTab('personalization');
       const run = () => {
         focusMemoryCardElement();
         onConsumeFocusTarget?.();
       };
       if (typeof requestAnimationFrame === 'function') {
         const frame = requestAnimationFrame(run);
         return () => cancelAnimationFrame(frame);
       }
       queueMicrotask(run);
       return undefined;
     }, [focusTarget, onConsumeFocusTarget]);
     ```

5. Modify `frontend/src/App.tsx`:
   - In `VoiceChatShell`, add `const [adminFocusTarget, setAdminFocusTarget] = useState<'memory' | null>(null)`.
   - Pass `temporaryChat: state.activeSessionTemporary` to `useLiveVoice({ ... })`.
   - Update `ChatView` props:
     ```tsx
     onManageAurvin={() => {
       dispatch({ type: 'CLOSE_SIDEBAR' })
       setAdminFocusTarget(null)
       setAdminSection('personalization')
       setPage('admin')
     }}
     onOpenMemorySettings={() => {
       dispatch({ type: 'CLOSE_SIDEBAR' })
       setAdminFocusTarget('memory')
       setAdminSection('personalization')
       setPage('admin')
     }}
     onOpenCalendarSetup={() => {
       dispatch({ type: 'CLOSE_SIDEBAR' })
       setAdminFocusTarget(null)
       setAdminSection('calendar')
       setPage('admin')
     }}
     ```
   - Pass `focusTarget={adminFocusTarget}`, `onConsumeFocusTarget={() => setAdminFocusTarget(null)}`, and update `onBackToChat={() => { setAdminFocusTarget(null); setPage('chat') }}` on `AdminDashboard`.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd frontend && npm test -- src/features/chat/ChatView.test.ts src/features/chat/ChatView.voice.test.ts src/components/MessageItem.test.ts src/components/Transcript.test.ts src/App.assembly.test.ts src/App.auth.test.ts src/features/admin-config/admin-dashboard.test.ts src/features/chat/integration-tests/welcome-and-safe-render.test.ts
```
Expected: PASS — all 8 test files pass.

- [ ] **Step 5: Commit**

```bash
git add -- frontend/src/components/MessageItem.tsx frontend/src/components/Transcript.tsx frontend/src/features/chat/ChatView.tsx frontend/src/features/chat/ChatView.test.ts frontend/src/App.tsx frontend/src/features/admin-config/AdminDashboard.tsx
git commit -m "feat(chat): render memory updated pill and temporary chat controls"
```

---

### Task 6: Integrated User Memory & Temporary Chat Verification Suite

**Files:**
- Modify: `frontend/src/features/chat/integration-tests/user-memory.test.ts`

- [ ] **Step 1: Write the failing/expanding integration tests**

Expand `frontend/src/features/chat/integration-tests/user-memory.test.ts` to cover all end-to-end P6 integration seams in Node (explicit immediate SSE update → pill → Personalization `MemoryCard` anchor, passive batch hydration via `listMessages`, full Temporary Chat toggle → Turn 1 `ephemeral: true` → lock → Turn 2 omit `ephemeral` → sidebar exclusion → `pagehide`/switch/New Chat `keepalive: true` `DELETE`, Live Voice gate, and `App.tsx` wiring seam):

```typescript
/**
 * ============================================================================
 * FILE: user-memory.test.ts
 * LOCATION: frontend/src/features/chat/integration-tests/user-memory.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Integrated Node-environment tests for User Memory UX and Temporary Chat.
 *
 * ROLE IN PROJECT:
 *    Verifies the P1->P6 voice contract mirror, explicit and passive memory
 *    indicator flows, Temporary Chat purge/isolation lifecycle, Live Voice
 *    gating, and navigation to Personalization MemoryCard without jsdom.
 *
 * KEY COMPONENTS:
 *    - Voice protocol ephemeral guard tests
 *    - Explicit SSE and passive listMessages memoryUpdated -> pill -> MemoryCard seam
 *    - Temporary Chat lifecycle: toggle, lock, sidebar exclusion, keepalive DELETE
 *    - Live Voice gate and App.tsx wiring verification
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../../api/client.ts';
import type { VisibleMessage } from '../../../api/protocol.ts';
import {
  DEFAULT_VOICE_LIMITS,
  isCreateVoiceSessionRequest,
  isVoiceLimits,
} from '../../../api/voice-protocol.ts';
import { MessageItem } from '../../../components/MessageItem.tsx';
import { focusMemoryCardElement } from '../../admin-config/AdminDashboard.tsx';
import { MemoryCard, MEMORY_CARD_ELEMENT_ID } from '../../personalization/MemoryCard.tsx';
import { initialUserMemoryState } from '../../personalization/user-memory-state.ts';
import { ChatView, getTemporaryChatHeaderState } from '../ChatView.tsx';
import { ChatProvider } from '../state/chat-context.tsx';
import {
  canStartLiveVoiceForChat,
  canToggleTemporaryChat,
  chatReducer,
  initialChatState,
  TEMPORARY_LIVE_VOICE_ENABLED,
} from '../state/chat-reducer.ts';
import type { ChatAction, ChatState } from '../state/chat-types.ts';
import { startTemporaryChatPagehideEffect, useChatActions } from '../state/use-chat.ts';

function sseResponse(frames: unknown[]): Response {
  const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function createActionHarness(initial: ChatState, client: ApiClient) {
  let state = initial;
  const dispatch = (action: ChatAction) => {
    state = chatReducer(state, action);
  };
  let actions!: ReturnType<typeof useChatActions>;
  function Harness() {
    actions = useChatActions(state, dispatch, client);
    return null;
  }
  const render = () => {
    renderToStaticMarkup(createElement(Harness));
  };
  render();
  return {
    get state() {
      return state;
    },
    get actions() {
      return actions;
    },
    dispatch,
    render,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('P6 voice protocol ephemeral mirror', () => {
  const baseRequest = {
    protocolVersion: 1 as const,
    mode: 'live' as const,
    conversationId: null,
    locale: 'en-US' as const,
    idempotencyKey: 'voice-temp-key-1',
  };

  it('accepts optional boolean ephemeral on CreateVoiceSessionRequest and rejects invalid values', () => {
    expect(isCreateVoiceSessionRequest(baseRequest)).toBe(true);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: true })).toBe(true);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: false })).toBe(true);

    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: 'true' })).toBe(false);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: 1 })).toBe(false);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: null })).toBe(false);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: true, extra: 1 })).toBe(false);
  });

  it('preserves voice-limits re-exports alongside the ephemeral mirror', () => {
    expect(isVoiceLimits(DEFAULT_VOICE_LIMITS)).toBe(true);
  });
});

describe('P6 user memory indicator integration (explicit SSE + passive hydration + MemoryCard target)', () => {
  it('streams explicit memoryUpdated: true end-to-end and targets the real MemoryCard anchor', async () => {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/sessions' && init?.method === 'POST') {
        return Response.json(
          {
            sessionId: 'sess_mem_1',
            turnId: 'turn_1',
            attemptId: 'att_1',
            userMessageId: 'msg_u1',
            streamPath: '/sessions/sess_mem_1/turns/turn_1/stream',
          },
          { status: 202 },
        );
      }
      if (url === '/api/sessions/sess_mem_1/turns/turn_1/stream') {
        return sseResponse([
          {
            protocolVersion: 1,
            sessionId: 'sess_mem_1',
            turnId: 'turn_1',
            attemptId: 'att_1',
            sequence: 1,
            event: { type: 'delta', text: 'I will remember that Beans is your dog.' },
          },
          {
            protocolVersion: 1,
            sessionId: 'sess_mem_1',
            turnId: 'turn_1',
            attemptId: 'att_1',
            sequence: 2,
            event: {
              type: 'completed',
              assistantMessageId: 'msg_a1',
              outcome: 'completed',
              memoryUpdated: true,
            },
          },
        ]);
      }
      return Response.json({ items: [], nextCursor: null });
    };

    const client = new ApiClient({ baseUrl: '/api', fetch: fetchFn, recoveryStorage: null });
    const harness = createActionHarness(initialChatState, client);

    await harness.actions.submitMessage('Remember my dog is Beans.');
    const assistant = harness.state.messages.find((m) => m.messageId === 'msg_a1');
    expect(assistant?.memoryUpdated).toBe(true);

    const pillHtml = renderToStaticMarkup(
      createElement(MessageItem, { message: assistant!, onOpenMemorySettings: vi.fn() }),
    );
    expect(pillHtml).toContain('aurvin-memory-updated-pill');
    expect(pillHtml).toContain('Memory updated');

    // Verify P5 MemoryCard renders the exact anchor targeted by AdminDashboard.focusMemoryCardElement.
    const memoryCardHtml = renderToStaticMarkup(
      createElement(MemoryCard, { initialState: initialUserMemoryState() }),
    );
    expect(memoryCardHtml).toContain(`id="${MEMORY_CARD_ELEMENT_ID}"`);

    const focus = vi.fn();
    const scrollIntoView = vi.fn();
    expect(
      focusMemoryCardElement({
        getElementById: (id) =>
          id === MEMORY_CARD_ELEMENT_ID ? ({ focus, scrollIntoView } as unknown as HTMLElement) : null,
      }),
    ).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });

  it('hydrates passive batch memoryUpdated: true on selectSession without marking earlier turns', async () => {
    const serverMessages: VisibleMessage[] = [
      {
        messageId: 'm_1',
        turnId: 't_1',
        eventId: 'e_1',
        sequence: 1,
        role: 'user',
        content: 'I build Aurvin in TypeScript.',
        createdAt: '2026-11-20T12:00:00.000Z',
        completionStatus: 'completed',
        truncated: false,
      },
      {
        messageId: 'm_2',
        turnId: 't_1',
        eventId: 'e_2',
        sequence: 2,
        role: 'assistant',
        content: 'Sounds like a solid stack.',
        createdAt: '2026-11-20T12:00:02.000Z',
        completionStatus: 'completed',
        truncated: false,
      },
      {
        messageId: 'm_3',
        turnId: 't_2',
        eventId: 'e_3',
        sequence: 3,
        role: 'user',
        content: 'I prefer concise dark UIs.',
        createdAt: '2026-11-20T12:01:00.000Z',
        completionStatus: 'completed',
        truncated: false,
      },
      {
        messageId: 'm_4',
        turnId: 't_2',
        eventId: 'e_4',
        sequence: 4,
        role: 'assistant',
        content: 'Good preference to keep in mind.',
        createdAt: '2026-11-20T12:01:02.000Z',
        completionStatus: 'completed',
        truncated: false,
        memoryUpdated: true,
      },
    ];
    const fetchFn: typeof fetch = async () =>
      Response.json({ items: serverMessages, nextCursor: null, olderAvailable: false });
    const client = new ApiClient({ baseUrl: '/api', fetch: fetchFn, recoveryStorage: null });
    const harness = createActionHarness(initialChatState, client);

    await harness.actions.selectSession('sess_passive', 'Stack chat');
    expect(harness.state.messages.map((m) => m.memoryUpdated ?? false)).toEqual([
      false,
      false,
      false,
      true,
    ]);

    const firstReplyHtml = renderToStaticMarkup(
      createElement(MessageItem, { message: harness.state.messages[1]! }),
    );
    const lastReplyHtml = renderToStaticMarkup(
      createElement(MessageItem, { message: harness.state.messages[3]!, onOpenMemorySettings: vi.fn() }),
    );
    expect(firstReplyHtml).not.toContain('aurvin-memory-updated-pill');
    expect(lastReplyHtml).toContain('aurvin-memory-updated-pill');
  });
});

describe('P6 Temporary Chat end-to-end lifecycle and Live Voice gate', () => {
  it('executes toggle -> turn 1 ephemeral -> lock -> turn 2 -> keepalive DELETE purge on exit and pagehide', async () => {
    const requests: Array<{ url: string; method: string; body?: string; keepalive?: boolean }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({
        url,
        method,
        body: typeof init?.body === 'string' ? init.body : undefined,
        keepalive: init?.keepalive,
      });

      if (url === '/api/sessions' && method === 'POST') {
        return Response.json(
          {
            sessionId: 'sess_temp_e2e',
            turnId: 'turn_1',
            attemptId: 'att_1',
            userMessageId: 'msg_u1',
            streamPath: '/sessions/sess_temp_e2e/turns/turn_1/stream',
            processEpoch: 'epoch_1',
          },
          { status: 202 },
        );
      }
      if (url === '/api/sessions/sess_temp_e2e/turns' && method === 'POST') {
        return Response.json(
          {
            sessionId: 'sess_temp_e2e',
            turnId: 'turn_2',
            attemptId: 'att_2',
            userMessageId: 'msg_u2',
            streamPath: '/sessions/sess_temp_e2e/turns/turn_2/stream',
            processEpoch: 'epoch_1',
          },
          { status: 202 },
        );
      }
      if (url.endsWith('/stream')) {
        const turnId = url.includes('turn_1') ? 'turn_1' : 'turn_2';
        const attemptId = turnId === 'turn_1' ? 'att_1' : 'att_2';
        return sseResponse([
          {
            protocolVersion: 1,
            sessionId: 'sess_temp_e2e',
            turnId,
            attemptId,
            sequence: 1,
            event: { type: 'delta', text: `Reply for ${turnId}` },
          },
          {
            protocolVersion: 1,
            sessionId: 'sess_temp_e2e',
            turnId,
            attemptId,
            sequence: 2,
            event: { type: 'completed', assistantMessageId: `asst_${turnId}`, outcome: 'completed' },
          },
        ]);
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return Response.json({ items: [], nextCursor: null, olderAvailable: false });
    };

    const client = new ApiClient({ baseUrl: '/api', fetch: fetchFn, recoveryStorage: null });
    const harness = createActionHarness(initialChatState, client);

    // 1. Toggle Temporary Chat ON before turn 1
    harness.dispatch({ type: 'SET_TEMPORARY_CHAT', payload: true });
    expect(harness.state.activeSessionTemporary).toBe(true);
    expect(canToggleTemporaryChat(harness.state)).toBe(true);
    expect(TEMPORARY_LIVE_VOICE_ENABLED).toBe(false);
    expect(canStartLiveVoiceForChat(harness.state)).toBe(false);
    expect(getTemporaryChatHeaderState(harness.state, false)).toEqual({
      showToggle: true,
      togglePressed: true,
      showActivePill: true,
    });
    harness.render();

    // 2. Turn 1 creates ephemeral session, locks toggle, excludes sidebar
    await harness.actions.submitMessage('Temporary turn 1');
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({
      sessionId: null,
      ephemeral: true,
      content: 'Temporary turn 1',
    });
    expect(harness.state.activeSessionId).toBe('sess_temp_e2e');
    expect(harness.state.sessions).toEqual([]);
    expect(canToggleTemporaryChat(harness.state)).toBe(false);
    expect(getTemporaryChatHeaderState(harness.state, false)).toEqual({
      showToggle: false,
      togglePressed: false,
      showActivePill: true,
    });
    expect(requests.some((r) => r.url === '/api/sessions' && r.method === 'GET')).toBe(false);

    // 3. Turn 2 omits ephemeral (creation-only on wire)
    harness.render();
    await harness.actions.submitMessage('Temporary turn 2');
    const turn2Body = JSON.parse(
      requests.find((r) => r.url === '/api/sessions/sess_temp_e2e/turns')!.body!,
    ) as Record<string, unknown>;
    expect(turn2Body.sessionId).toBe('sess_temp_e2e');
    expect('ephemeral' in turn2Body).toBe(false);

    // 4. Exit via pagehide fires DELETE with keepalive: true
    let pagehideListener: (() => void) | null = null;
    const stopPagehide = startTemporaryChatPagehideEffect({
      target: {
        addEventListener: (_type, fn) => {
          pagehideListener = fn;
        },
        removeEventListener: () => {
          pagehideListener = null;
        },
      },
      getActiveTemporarySessionId: () =>
        harness.state.activeSessionTemporary ? harness.state.activeSessionId : null,
      onPurge: (id) => {
        void client.deleteSession(id, { keepalive: true });
      },
    });
    pagehideListener?.();
    stopPagehide?.();

    const deletes = requests.filter((r) => r.method === 'DELETE');
    expect(deletes).toEqual([
      expect.objectContaining({
        url: '/api/sessions/sess_temp_e2e',
        method: 'DELETE',
        keepalive: true,
      }),
    ]);

    // 5. Mounted ChatProvider + ChatView renders Temporary chat toggle cleanly on fresh New Chat
    const html = renderToStaticMarkup(
      createElement(ChatProvider, {
        client,
        startVoiceConversation: vi.fn(),
        children: createElement(ChatView),
      }),
    );
    expect(html).toContain('aurvin-temp-chat-toggle');
  });

  it('keeps App.tsx wired for onOpenMemorySettings, focusTarget, and temporaryChat without client storage or secret flags', () => {
    const appSource = readFileSync('src/App.tsx', 'utf8');
    expect(appSource).toContain('onOpenMemorySettings');
    expect(appSource).toContain('focusTarget={adminFocusTarget}');
    expect(appSource).toContain('temporaryChat: state.activeSessionTemporary');
    expect(appSource).not.toMatch(/VITE_|localStorage|sessionStorage/);
  });
});
```

- [ ] **Step 2: Run the integration suite and full frontend verification**

Run:
```bash
cd frontend && npm test -- src/features/chat/integration-tests/user-memory.test.ts
```
Expected: PASS — all integration tests pass.

Then run the full frontend build, lint, and test suite, plus the backend voice mirror test:
```bash
cd frontend && npm run build && npm run lint && npm test
cd ../backend && npm test -- src/contracts/voice.spec.ts
```
Expected:
- `frontend`: `npm run build` exits 0, `npm run lint` exits 0 with 0 errors (no new warnings), `npm test` passes **100%** (including `src/api/testing/voice-fixtures.test.ts`, which was the sole remaining frontend failure after P5).
- `backend`: `src/contracts/voice.spec.ts` passes **100%** (closing the P1→P6 mirror transfer).

- [ ] **Step 3: Commit**

```bash
git add -- frontend/src/features/chat/integration-tests/user-memory.test.ts
git commit -m "test(chat): add user memory indicator and temporary chat integration tests"
```

---

## Final Verification Notes

When running final verification after both P4 and P6 workers finish:

1. **P6 Mirror Closure:** P6 closes the second and final P1 mirror transfer (`frontend/src/api/voice-protocol.ts` ↔ `backend/src/contracts/voice-wire.ts`). Confirm both `frontend/src/api/testing/voice-fixtures.test.ts` and `backend/src/contracts/voice.spec.ts` (`"mirrors the entire portable voice contract"`) pass while uncommitted `voice-limits.ts` extraction edits remain intact in the working tree.
2. **Pre-Existing Backend & E2E Failures Must Be Reported Honestly:** Do **not** claim the full `backend` `npm test` or `npm run test:e2e` suites are green if pre-existing failures recorded in `docs/user-memory-context/state.md` still reproduce:
   - `backend/test/persistence/local-open.spec.ts` ×2 (`web_search_connections` not admitted by `mutation-journal.ts`) and `local-owner.spec.ts` ×1 (pre-`memoryPublication` recovery filter).
   - Multi-calendar `AccountAuthority.snapshot` `AuthFault NOT_READY` 503s in the assembled auth fixture and other pre-feature baseline failures (~72–80 baseline failures across `app.controller`, `calendar-flow`, `compaction-runtime`, `finalization-repair`, multi-calendar `authority`, and timing-sensitive voice test variance).
   - `backend/test/voice/voice-bootstrap.e2e-spec.ts` ×8 failures in `npm run test:e2e`.
   Report exact pass/fail/skip counts and isolate any regressions from those pre-existing baselines.
3. **Environment & Scope Limitations:** Frontend Vitest runs in a Node environment (`renderToStaticMarkup`, reducer/hook harnesses, deterministic fetch doubles) with no real browser DOM; it does not certify live browser `pagehide` unload timing, native MongoDB, live OpenRouter, live LiveKit/Deepgram, or staging. Review remains **skipped** (`--skip review`).
4. **Live Voice in Temporary Chat:** Remains product-unapproved and disabled by default (`TEMPORARY_LIVE_VOICE_ENABLED = false` on frontend, `allowTemporaryLive` unset on backend). Report this explicitly in `final_report.md`.
