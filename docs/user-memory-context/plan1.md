# P1 — Shared Contracts, Collections & Admin Memory Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define and verify the backend storage, tool, chat wire, and Admin Config contracts for User Memory and Temporary Chat without enabling any runtime behavior.

**Architecture:** Keep user memory in a separate bounded `user_memory` collection keyed by `_id = userId`. Put the passive watermark and `ephemeral` on `SessionRecord`; only the frozen pin goes on `AgentMemoryManifest`, which is hashed by `boundaryFor(m)` and protected by `MongoMemory.putConfirmed`'s strict `contextVersion + 1` CAS. Reuse existing validation, catalogue evidence, and guarded write paths; add no runtime IO to chat or voice.

**Tech Stack:** Node.js, TypeScript/NodeNext ESM, Zod 3, Vitest, MongoDB driver facade, OpenRouter catalogue fixtures.

---

## Scope and file map

Use [goal.md](goal.md) (`836ed14`), [research.md](research.md) (`1df0789`), and the reconciled P1 file ownership in [state.md](state.md). Where the early examples disagree, use five sections (not a flat stored `content` string), raw `userId` as the Mongo `_id` (not `key(...)`), and `instruction` as the only tool argument. Keep `ChatFloor.breakdown` unchanged (`fixed`, `personalization`, `tools`); its reserve computation is outside P1 ownership.

| Files | Responsibility |
| --- | --- |
| `backend/src/contracts/collections.ts`, `backend/src/contracts/user-memory.ts`, `backend/src/contracts/user-memory.spec.ts`, `backend/src/contracts/index.ts` | Registry, memory record/renderer, private wire and tool schemas, shared tests and exports |
| `backend/src/contracts/session.ts`, `backend/src/contracts/agent-memory.ts`, `backend/src/contracts/repositories.ts` | Session-only state, manifest-only pin, port signatures |
| `backend/src/contracts/api.ts`, `backend/src/contracts/message.ts`, `backend/src/contracts/stream.ts`, `backend/src/contracts/metadata.ts`, `backend/src/contracts/voice-wire.ts` | Compatible text/voice requests, assistant marker, and accounting |
| `backend/src/contracts/calendar-tools.ts`, `backend/src/contracts/calendar-model.ts` | Opt-in native tool definition and decision/receipt contracts |
| `backend/src/contracts/admin-config-wire.ts`, `backend/src/contracts/admin-config.ts`, `backend/src/contracts/config-runtime.ts`, `backend/src/platform/config/manageable-config.ts` | Settings, legacy normalization, public guard, resolved writer model ID |
| `backend/src/model/catalogue.ts`, `backend/src/admin-config/admin-config.service.ts`, `backend/src/admin-config/admin-config.service.spec.ts` | Reused catalogue evidence, pre-CAS validation and offline admin tests |
| `backend/src/persistence/mutation-journal.ts` | Guarded collection/method additions; test in the owned memory spec |
| `backend/src/contracts/context.ts` (inspect only) | `ContextSourceSnapshot.manifest` already carries the new pin; no duplicate current-memory input |

Run `npm` commands from `backend/`, Git commands from the repository root. Use `.js` for local TS imports and the `AGENTS.md` file header for both new TS files. Add imports shown in each task to the top of the named file. Confirm the index is clear before staging; stage only named P1 hunks and coordinate commits with the parent. No review dispatch, live calls, schema migration, or P2–P6 runtime/UI changes.

**Ownership gate:** Two existing deterministic specs assert the exact registry: `backend/src/contracts/persistence-profile.spec.ts` and `backend/test/contracts/calendar-multi-boundaries.spec.ts`. Adding `user_memory` necessarily changes those assertions. Neither file is P1-owned: request parent approval for the two one-line fixture additions in Task 1, or have the parent land them. Do not report a clean P1 gate or quietly skip those specs if authorization has not arrived. Notify the parent that the optional native suites `backend/test/integration/storage.native.e2e-spec.ts` and `backend/test/integration/operations.native.e2e-spec.ts` also iterate the registry; they assume collections exist before any per-user memory write. P1 must not add eager collection creation merely to satisfy these out-of-scope tests.

### Task 1: Collection, five sections, and bounded record

**Files:** Modify `backend/src/contracts/collections.ts` (end of `COLLECTIONS`), `backend/src/contracts/index.ts` (barrel); create `backend/src/contracts/user-memory.ts` and `backend/src/contracts/user-memory.spec.ts`.

- [ ] **Red:** Create the Vitest spec with the required header and:

```ts
import { expect, it } from 'vitest';
import { COLLECTIONS, renderUserMemorySections, storedUserMemorySchema,
  userMemorySectionsSchema } from './index.js';

const at = '2026-11-20T12:00:00.000Z';
const empty = { identity: '', work: '', preferences: '', ongoing: '', other: '' };
const stored = { schemaVersion: 1, userId: 'u', enabled: true, sections: empty,
  revision: 1, updatedAt: at };

it('registers user_memory separately and normalizes the five sections in render order', () => {
  expect(COLLECTIONS.userMemory).toBe('user_memory');
  expect(renderUserMemorySections(userMemorySectionsSchema.parse({
    ...empty, work: ' TS\r\nMongo\rVitest ', identity: ' Peter ',
  }))).toBe('- Identity: Peter\n- Work: TS\nMongo\nVitest');
  expect(renderUserMemorySections(userMemorySectionsSchema.parse(empty))).toBe('');
  expect(storedUserMemorySchema.parse(stored)).toEqual(stored);
  expect(storedUserMemorySchema.safeParse({ ...stored, revision: 0 }).success).toBe(false);
  expect(userMemorySectionsSchema.safeParse({ identity: 'Peter' }).success).toBe(false);
  expect(userMemorySectionsSchema.safeParse({ ...empty, calendar: 'event' }).success).toBe(false);
});

it('enforces both rendered ceilings including labels and separators', () => {
  const identity = 'x'.repeat(2500 - '- Identity: '.length);
  expect(userMemorySectionsSchema.safeParse({ ...empty, identity }).success).toBe(true);
  expect(userMemorySectionsSchema.safeParse({ ...empty, identity, work: 'x' }).success).toBe(false);
  // 1,997 supplementary code points at four bytes, plus the 12 ASCII label bytes.
  const otherIdentity = '😀'.repeat(1997);
  expect(Buffer.byteLength(renderUserMemorySections({ ...empty, identity: otherIdentity }))).toBe(8000);
  expect(userMemorySectionsSchema.safeParse({ ...empty, identity: otherIdentity }).success).toBe(true);
  expect(userMemorySectionsSchema.safeParse({ ...empty, identity: `${otherIdentity}x` }).success).toBe(false);
});

it.each(['\u0000Peter', '\u000bPeter', 'OPENROUTER_API_KEY=fixture'])(
  'rejects an unsafe generated section or stored record', (value) => {
    const sections = { ...empty, work: value };
    expect(userMemorySectionsSchema.safeParse(sections).success).toBe(false);
    expect(storedUserMemorySchema.safeParse({ ...stored, sections }).success).toBe(false);
  },
);
```

- [ ] **Run red:** `npm test -- src/contracts/user-memory.spec.ts` — fails on the missing memory exports/registry.
- [ ] **Implement:** Append `userMemory: 'user_memory',` to `COLLECTIONS` and `export * from './user-memory.js';` to the barrel. Create the following in `backend/src/contracts/user-memory.ts` after its header. `StoredUserMemory` is the domain record; Mongo adds `_id: userId` without exposing `_id` on the wire. `revision: 0` is only an unpersisted view/CAS expectation. Count Unicode code points, not UTF-16 units, so the independent UTF-8 limit is reachable; use this same count for the public `charCount`.

```ts
import { z } from 'zod';
import { idSchema } from './identifiers.js';
import { hasDisallowedControlChars, hasSecretPattern,
  normalizeCustomInstructions } from './personalization.js';

export const USER_MEMORY_SECTION_KEYS = ['identity', 'work', 'preferences', 'ongoing', 'other'] as const;
export const USER_MEMORY_MAX_CHARS = 2500;
export const USER_MEMORY_MAX_BYTES = 8000;
export const USER_MEMORY_RECORD_MAX_BYTES = 16_384;
export type UserMemorySections = Record<(typeof USER_MEMORY_SECTION_KEYS)[number], string>;

export const userMemoryCharCount = (value: string): number => Array.from(value).length;
const fitsRenderedMemory = (value: string): boolean =>
  value.length <= USER_MEMORY_MAX_CHARS * 2 &&
  Buffer.byteLength(value, 'utf8') <= USER_MEMORY_MAX_BYTES &&
  userMemoryCharCount(value) <= USER_MEMORY_MAX_CHARS;

export function renderUserMemorySections(sections: UserMemorySections): string {
  return USER_MEMORY_SECTION_KEYS.filter(key => sections[key] !== '')
    .map(key => `- ${key.charAt(0).toUpperCase()}${key.slice(1)}: ${sections[key]}`)
    .join('\n');
}

const safeMemoryText = z.string()
  .refine(value => !hasDisallowedControlChars(value), { message: 'disallowed_characters' })
  .refine(value => !hasSecretPattern(value), { message: 'secret_pattern' });
const section = safeMemoryText.transform(normalizeCustomInstructions);
export const userMemorySectionsSchema = z.object({
  identity: section, work: section, preferences: section, ongoing: section, other: section,
}).strict().refine(sections => fitsRenderedMemory(renderUserMemorySections(sections)), {
  message: 'rendered user memory exceeds its limit',
});
const revision = z.number().int().nonnegative().safe();
const persistedRevision = revision.min(1);
const timestamp = z.string().max(40).datetime({ offset: true });
export const storedUserMemorySchema = z.object({
  schemaVersion: z.literal(1), userId: idSchema, enabled: z.boolean(),
  sections: userMemorySectionsSchema, revision: persistedRevision, updatedAt: timestamp,
}).strict();
export type StoredUserMemory = z.infer<typeof storedUserMemorySchema>;
```

  If authorized, add `userMemory: 'user_memory',` after `userPersonalization` in `backend/src/contracts/persistence-profile.spec.ts:64–76` (update “eleven” to “twelve” in the test name) and append `'user_memory'` after `'user_personalization'` in `backend/test/contracts/calendar-multi-boundaries.spec.ts:33–35`. Preserve both exact checks.
- [ ] **Green:** `npm test -- src/contracts/user-memory.spec.ts src/contracts/persistence-profile.spec.ts test/contracts/calendar-multi-boundaries.spec.ts` — all three must pass; an unupdated registry assertion is an ownership blocker.
- [ ] **Commit:** Stage the four P1 files above by name (plus the two exact fixture paths only if granted). `git commit -m "feat(user-memory): define bounded five-section memory records"`

### Task 2: Shared private wire, writer output, and explicit tool input/receipt

**Files:** Modify `backend/src/contracts/user-memory.ts` and `backend/src/contracts/user-memory.spec.ts`.

- [ ] **Red:** Extend the `./index.js` import in the memory spec with the exports below and append:

```ts
it('shares the bounded and screened instruction across composer and explicit tool', () => {
  const cas = { protocolVersion: 1, expectedRevision: 0 };
  for (const instruction of ['x', '😀'.repeat(500), ' Remember beans ']) {
    expect(updateUserMemoryArgumentsSchema.parse({ instruction })).toEqual({ instruction });
    expect(userMemoryEditRequestSchema.safeParse({ ...cas, instruction }).success).toBe(true);
  }
  for (const instruction of ['', ' \t ', 'x'.repeat(501), '\u000bremember', 'sk-or-v1-fixture']) {
    expect(updateUserMemoryArgumentsSchema.safeParse({ instruction }).success).toBe(false);
    expect(userMemoryEditRequestSchema.safeParse({ ...cas, instruction }).success).toBe(false);
  }
  expect(userMemoryEditRequestSchema.safeParse({ ...cas, instruction: 'x', userId: 'other' }).success).toBe(false);
  expect(updateUserMemoryArgumentsSchema.safeParse({ instruction: 'x', action: 'remember' }).success).toBe(false);
  expect(userMemoryEnabledRequestSchema.parse({ ...cas, enabled: false }).enabled).toBe(false);
  expect(userMemoryClearRequestSchema.safeParse({ ...cas, expectedRevision: -1 }).success).toBe(false);
  expect(UPDATE_USER_MEMORY_TOOL_DEFINITION.function.parameters).toMatchObject({
    additionalProperties: false, required: ['instruction'],
    properties: { instruction: { type: 'string', minLength: 1, maxLength: 500 } },
  });
});

it('checks the writer candidate, private view and closed receipt independently', () => {
  const candidate = { changed: true, changeSummary: 'Added pet', sections: empty };
  expect(userMemoryWriterOutputSchema.parse(candidate)).toEqual(candidate);
  expect(userMemoryWriterOutputSchema.safeParse({
    ...candidate, sections: { ...empty, other: 'mongodb://fixture' },
  }).success).toBe(false);
  expect(userMemoryWriterOutputSchema.safeParse({
    ...candidate, sections: { ...empty, work: 'x'.repeat(2500) },
  }).success).toBe(false);
  const view = { protocolVersion: 1, revision: 0, enabled: true, sections: empty,
    isEmpty: true, charCount: 0, maxChars: 2500, updatedAt: null };
  expect(userMemoryResponseSchema.parse(view)).toEqual(view);
  expect(userMemoryEditResponseSchema.parse({ ...view, changeSummary: '' })).toMatchObject({ changeSummary: '' });
  for (const receipt of [
    { ok: true, status: 'updated', summary: 'Added pet' },
    { ok: true, status: 'no_change', summary: '' },
    { ok: false, error: { code: 'SECRET_REJECTED', retryable: false } },
  ]) expect(updateUserMemoryReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(updateUserMemoryReceiptSchema.safeParse({
    ok: false, error: { code: 'UNKNOWN', retryable: false },
  }).success).toBe(false);
});
```

- [ ] **Run red:** `npm test -- src/contracts/user-memory.spec.ts -t "instruction|writer candidate"` — fails on missing wire/tool exports.
- [ ] **Implement:** Append the following to `backend/src/contracts/user-memory.ts`. Keep the validated tool envelope untransformed so Calendar's raw-JSON/envelope identity check succeeds. Blank-only input fails; raw instruction length is bounded before any trimming. Secret violations retain issue message `secret_pattern` from Task 1 for tool classification, without echoing input. Existing runtime scanners, not Zod's object schema, own rejection of duplicate JSON keys. No per-field error catalogue.

```ts
export const USER_MEMORY_INSTRUCTION_MAX_CHARS = 500;
const instructionSchema = safeMemoryText.refine(value =>
  value.length <= 2 * USER_MEMORY_INSTRUCTION_MAX_CHARS &&
  userMemoryCharCount(value) <= USER_MEMORY_INSTRUCTION_MAX_CHARS &&
  value.trim().length > 0,
);
const summarySchema = safeMemoryText.refine(value =>
  value.length <= 2 * USER_MEMORY_INSTRUCTION_MAX_CHARS &&
  userMemoryCharCount(value) <= USER_MEMORY_INSTRUCTION_MAX_CHARS,
);
export const userMemoryWriterOutputSchema = z.object({
  changed: z.boolean(), changeSummary: summarySchema, sections: userMemorySectionsSchema,
}).strict();
export type UserMemoryWriterOutput = z.infer<typeof userMemoryWriterOutputSchema>;

export const USER_MEMORY_ROUTES = {
  memory: '/personalization/memory',
  enabled: '/personalization/memory/enabled',
  edit: '/personalization/memory/edit',
  clear: '/personalization/memory/clear',
} as const;
export const userMemoryClearRequestSchema = z.object({
  protocolVersion: z.literal(1), expectedRevision: revision.max(Number.MAX_SAFE_INTEGER - 1),
}).strict();
export const userMemoryEnabledRequestSchema = userMemoryClearRequestSchema.extend({ enabled: z.boolean() });
export const userMemoryEditRequestSchema = userMemoryClearRequestSchema.extend({ instruction: instructionSchema });
export const userMemoryResponseSchema = z.object({
  protocolVersion: z.literal(1), revision, enabled: z.boolean(), sections: userMemorySectionsSchema,
  isEmpty: z.boolean(), charCount: z.number().int().min(0).max(USER_MEMORY_MAX_CHARS),
  maxChars: z.literal(USER_MEMORY_MAX_CHARS), updatedAt: timestamp.nullable(),
}).strict();
export const userMemoryEditResponseSchema = userMemoryResponseSchema.extend({ changeSummary: summarySchema });
export type UserMemoryClearRequest = z.infer<typeof userMemoryClearRequestSchema>;
export type UserMemoryEnabledRequest = z.infer<typeof userMemoryEnabledRequestSchema>;
export type UserMemoryEditRequest = z.infer<typeof userMemoryEditRequestSchema>;
export type UserMemoryResponse = z.infer<typeof userMemoryResponseSchema>;
export type UserMemoryEditResponse = z.infer<typeof userMemoryEditResponseSchema>;

export const UPDATE_USER_MEMORY_TOOL_NAME = 'update_user_memory' as const;
export const UPDATE_USER_MEMORY_NATIVE_TOOL = {
  name: UPDATE_USER_MEMORY_TOOL_NAME,
  description: 'Remember, update, or forget durable personal facts only when the user explicitly asks.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['instruction'],
    properties: { instruction: { type: 'string', minLength: 1, maxLength: USER_MEMORY_INSTRUCTION_MAX_CHARS } },
  },
} as const;
export const UPDATE_USER_MEMORY_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: UPDATE_USER_MEMORY_NATIVE_TOOL.name, description: UPDATE_USER_MEMORY_NATIVE_TOOL.description,
    parameters: UPDATE_USER_MEMORY_NATIVE_TOOL.inputSchema,
  },
} as const;
export const updateUserMemoryArgumentsSchema = z.object({ instruction: instructionSchema }).strict();
export const updateUserMemoryReceiptSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: z.enum(['updated', 'no_change']), summary: summarySchema }).strict(),
  z.object({ ok: z.literal(false), error: z.object({
    code: z.enum(['SECRET_REJECTED', 'MEMORY_DISABLED', 'WRITER_UNAVAILABLE', 'PERSISTENCE_ERROR']),
    retryable: z.boolean(),
  }).strict() }).strict(),
]);
export type UpdateUserMemoryArguments = z.infer<typeof updateUserMemoryArgumentsSchema>;
export type UpdateUserMemoryReceipt = z.infer<typeof updateUserMemoryReceiptSchema>;
```

- [ ] **Green:** `npm test -- src/contracts/user-memory.spec.ts` — all cases pass.
- [ ] **Commit:** `git add -- backend/src/contracts/user-memory.ts backend/src/contracts/user-memory.spec.ts`, then `git commit -m "feat(user-memory): define private wire and explicit tool contracts"`.

### Task 3: Opt-in Calendar native decision and result

**Files:** Modify `backend/src/contracts/calendar-tools.ts` (`SkillNativeDefinition`, `repairDiagnosticsSchema`, `nativeLocalResultSchema`), `backend/src/contracts/calendar-model.ts` (native names and decision schemas), `backend/src/contracts/user-memory.spec.ts`.

- [ ] **Red:** Import the named exports from `./index.js` and add:

```ts
it('defines a memory decision and receipt without changing the active Calendar tool set', () => {
  const envelope = { instruction: ' Remember beans ' };
  const nativeCall = { id: 'call1', type: 'function',
    function: { name: 'update_user_memory', arguments: JSON.stringify(envelope) } };
  const decision = { kind: 'update_user_memory', decisionId: 'decision1', nativeCall,
    assistantContent: null, envelope, terminal: 'tool_calls' };
  expect(memoryCompatibleSkillDecisionSchema.parse(decision)).toEqual(decision);
  expect(memoryCompatibleSkillDecisionSchema.safeParse({
    ...decision, envelope: { instruction: 'Different' },
  }).success).toBe(false);
  expect(skillDecisionSchema.safeParse(decision).success).toBe(false);
  expect(historicalSkillDecisionSchema.safeParse(decision).success).toBe(false);
  expect(SKILL_NATIVE_TOOLS.map(tool => tool.name)).not.toContain('update_user_memory');
  const receipt = { ok: true, status: 'updated', summary: 'Added pet' };
  expect(JSON.parse(serializeNativeLocalResult(receipt))).toEqual(receipt);
  expect(repairDiagnosticsSchema.safeParse([
    { path: 'instruction', code: 'missing', expected: 'string' },
  ]).success).toBe(true);
});
```

- [ ] **Run red:** `npm test -- src/contracts/user-memory.spec.ts -t "memory decision"` — fails on missing opt-in schema.
- [ ] **Implement:** In `backend/src/contracts/calendar-tools.ts`, import `type UPDATE_USER_MEMORY_NATIVE_TOOL` and `updateUserMemoryReceiptSchema` from `./user-memory.js`, widen the definition type (not the advertised array), add the receipt to the existing array in `z.union`, and append `'instruction'` to the existing diagnostics path enum:

```ts
export type SkillNativeDefinition = (typeof SKILL_NATIVE_TOOLS)[number] | typeof UPDATE_USER_MEMORY_NATIVE_TOOL;
```

  In `backend/src/contracts/calendar-model.ts`, import `UPDATE_USER_MEMORY_TOOL_NAME` and `updateUserMemoryArgumentsSchema` from `./user-memory.js`. Extend generic native call/result parsing and define the opt-in decision after `skillDecisionSchema`:

```ts
const readableNativeNameSchema = z.union([
  calendarToolNameSchema, historicalSkillNativeNameSchema, z.literal(UPDATE_USER_MEMORY_TOOL_NAME),
]);

export const updateUserMemoryDecisionSchema = z.object({
  kind: z.literal(UPDATE_USER_MEMORY_TOOL_NAME), decisionId: idSchema,
  nativeCall: nativeToolCallSchema, assistantContent: z.string().max(32000).nullable(),
  envelope: updateUserMemoryArgumentsSchema, terminal: z.literal('tool_calls'),
}).strict().superRefine(verifySkillDecisionIdentity);
export const memoryCompatibleSkillDecisionSchema = z.union([skillDecisionSchema, updateUserMemoryDecisionSchema]);
export type MemoryCompatibleSkillDecision = z.infer<typeof memoryCompatibleSkillDecisionSchema>;
```

  Do **not** widen `SkillDecision`, `HistoricalSkillDecision`, or `resumableSkillDecisionSchema` in this task. In current `calendar-loop.ts` the final branch assumes `call_tool` once built-ins are narrowed out. Widening that active union without its corresponding executor is both a compile break and an authority-boundary change. No new tool is advertised or admitted by existing dispatch.
- [ ] **Green:** `npm test -- src/contracts/user-memory.spec.ts test/contracts/calendar-multi-boundaries.spec.ts` and `npm run build` — existing Calendar types compile, existing authority tests and the new opt-in case pass.
- [ ] **Commit:** `git add -- backend/src/contracts/calendar-tools.ts backend/src/contracts/calendar-model.ts backend/src/contracts/user-memory.spec.ts`, then `git commit -m "feat(user-memory): add opt-in native Calendar tool contracts"`.

### Task 4: Session/manifest, message, SSE, and accounting

**Files:** Modify `backend/src/contracts/session.ts`, `backend/src/contracts/agent-memory.ts`, `backend/src/contracts/user-memory.ts`, `backend/src/contracts/repositories.ts`, `backend/src/contracts/message.ts`, `backend/src/contracts/api.ts`, `backend/src/contracts/stream.ts`, `backend/src/contracts/metadata.ts`, `backend/src/contracts/user-memory.spec.ts`.

- [ ] **Red:** Import the referenced schemas/helpers from `./index.js`. Append:

```ts
it('keeps passive progress on the session and preserves the old manifest shape', () => {
  const session = { schemaVersion: 1, userId: 'u', sessionId: 's', title: 'Test',
    createdAt: at, updatedAt: at, lastActivityAt: at, lifecycle: 'active', graphThreadId: 's',
    execution: { ownerId: null, leaseExpiresAt: null, activeAttemptId: null, generation: 0 },
    latestTurnId: null };
  const manifest = { schemaVersion: 1, userId: 'u', sessionId: 's', contextVersion: 0,
    sourceRanges: [], messageRefs: [], activeSummaryRef: null, instructionVersion: 'v1',
    knowledgeContentHash: 'hash', graphSchemaVersion: 'v1' };
  expect(sessionRecordSchema.parse(session)).toEqual(session);
  expect(agentMemoryManifestSchema.parse(manifest)).not.toHaveProperty('pinnedUserMemory');
  expect(sessionRecordSchema.parse({ ...session, ephemeral: true, memoryWatermarkSequence: 0 }))
    .toMatchObject({ ephemeral: true, memoryWatermarkSequence: 0 });
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(sessionRecordSchema.safeParse({ ...session, memoryWatermarkSequence: value }).success).toBe(false);
  }
  for (const key of ['memoryWatermarkSequence', 'ephemeral']) {
    expect(agentMemoryManifestSchema.safeParse({ ...manifest, [key]: 1 }).success).toBe(false);
  }
  const pin = { revision: 1, content: '- Identity: Beans' };
  expect(agentMemoryManifestSchema.parse({ ...manifest, pinnedUserMemory: pin }).pinnedUserMemory).toEqual(pin);
  expect(agentMemoryManifestSchema.parse({ ...manifest, pinnedUserMemory: null }).pinnedUserMemory).toBeNull();
  expect(agentMemoryManifestSchema.safeParse({
    ...manifest, pinnedUserMemory: { ...pin, content: '😀'.repeat(2001) },
  }).success).toBe(false);
});

it('accepts the optional creation flag and rejects unknown identity overrides', () => {
  const input = { sessionId: null, content: 'Hello', idempotencyKey: 'submission-1' };
  expect(submitTurnRequestSchema.parse(input)).toEqual(input);
  expect(submitTurnRequestSchema.parse({ ...input, ephemeral: true }).ephemeral).toBe(true);
  expect(submitTurnRequestSchema.safeParse({ ...input, ephemeral: 'true' }).success).toBe(false);
  expect(submitTurnRequestSchema.safeParse({ ...input, userId: 'other' }).success).toBe(false);
  expect(sessionSummarySchema.parse({
    sessionId: 's', title: 'Temporary', ephemeral: true, createdAt: at, lastActivityAt: at,
  }).ephemeral).toBe(true);
});

it('projects a confirmed assistant marker and accepts it in both terminal envelopes', () => {
  const assistant = { schemaVersion: 1, userId: 'u', sessionId: 's', turnId: 't', messageId: 'm',
    eventId: 'e', sequence: 1, role: 'assistant', content: 'Done', createdAt: at,
    completionStatus: 'completed', attemptId: 'a', truncated: false };
  const marked = messageRecordSchema.parse({ ...assistant, memoryUpdated: true });
  expect(toVisibleMessage(marked).memoryUpdated).toBe(true);
  expect(toVisibleMessage(messageRecordSchema.parse(assistant))).not.toHaveProperty('memoryUpdated');
  expect(toVisibleMessage(messageRecordSchema.parse({ ...assistant, memoryUpdated: false })))
    .not.toHaveProperty('memoryUpdated');
  expect(messageRecordSchema.safeParse({ ...assistant, role: 'user', memoryUpdated: true }).success)
    .toBe(false);
  const event = { type: 'completed', assistantMessageId: 'm', outcome: 'completed', memoryUpdated: true };
  for (const protocolVersion of [1, 3]) {
    expect(calendarCompatibleEnvelopeSchema.parse({
      protocolVersion, sessionId: 's', turnId: 't', attemptId: 'a', sequence: 2, event,
    }).event).toEqual(event);
  }
  expect(completedEventSchema.safeParse({ ...event, memoryUpdated: 'true' }).success).toBe(false);
});

it('admits memory accounting without invalidating older text records', () => {
  const row = { schemaVersion: 1, kind: 'accounting', userId: 'u', sessionId: 'memory-composer',
    turnId: 't', attemptId: 'a', generationId: null, requestedModel: 'fixture/model',
    reportedModel: null, reportedProvider: null, promptTokens: null, completionTokens: null,
    cost: null, accountingStatus: 'unknown', outcome: 'completed', startedAt: at, endedAt: at };
  expect(accountingRecordSchema.parse(row)).toEqual(row);
  expect(accountingRecordSchema.parse({ ...row, purpose: 'memory' }).purpose).toBe('memory');
});
```

- [ ] **Run red:** `npm test -- src/contracts/user-memory.spec.ts -t "passive progress|creation flag|terminal envelopes|memory accounting"` — strict objects reject the new fields/purpose.
- [ ] **Implement:** Add the indicated fields and refinements; preserve absence instead of transforming legacy values. In `backend/src/contracts/user-memory.ts`:

```ts
export const pinnedUserMemorySchema = z.object({
  revision: persistedRevision,
  content: safeMemoryText.refine(value => value.trim().length > 0 && fitsRenderedMemory(value)),
}).strict();
export type PinnedUserMemory = z.infer<typeof pinnedUserMemorySchema>;
```

  In `backend/src/contracts/agent-memory.ts`, import `pinnedUserMemorySchema` and insert `pinnedUserMemory: pinnedUserMemorySchema.nullable().optional(),` inside `agentMemoryManifestSchema` (not summary schemas). In `backend/src/contracts/session.ts`, add `ephemeral: z.boolean().optional(),` and `memoryWatermarkSequence: sequenceSchema.safe().optional(),` inside `sessionRecordSchema`. Do not default absent fields in the persisted schemas.

  In `backend/src/contracts/repositories.ts`, import `type StoredUserMemory` from `./user-memory.js`. Add these ports; `?` allows current repository implementations to compile until their owners wire them:

```ts
export type UserMemoryWriteSettings = Pick<StoredUserMemory, 'enabled' | 'sections'>;
export type UserMemoryCasResult =
  | { outcome: 'confirmed'; record: StoredUserMemory }
  | { outcome: 'conflict'; currentRevision: number }
  | { outcome: 'uncertain' };
export interface UserMemoryRepository {
  read(userId: string): Promise<StoredUserMemory | null>;
  createIfAbsent(userId: string, settings: UserMemoryWriteSettings, updatedAt: string): Promise<UserMemoryCasResult>;
  compareAndSwap(userId: string, expectedRevision: number,
    settings: UserMemoryWriteSettings, updatedAt: string): Promise<UserMemoryCasResult>;
}
// Within SessionRepository:
advanceMemoryWatermark?(userId: string, sessionId: string, sequence: number): Promise<void>;
hardPurgeSession?(userId: string, sessionId: string): Promise<void>;
listExpiredEphemeral?(cutoffIso: string, limit: number): Promise<SessionRecord[]>;
// Within MessageRepository:
markMemoryUpdated?(userId: string, sessionId: string, messageId: string): Promise<void>;
```

  In `backend/src/contracts/api.ts`, add `ephemeral: z.boolean().optional(),` to `submitTurnRequestSchema` and `sessionSummarySchema`, and add `export type CreateSessionRequest = SubmitTurnRequest & { sessionId: null };` after `SubmitTurnRequest`. `POST /api/sessions` already uses the submit schema with a null `sessionId` route check; do not create a duplicate parser or use `/api/chat/sessions`. Do not add the flag to retry.

  In `backend/src/contracts/message.ts` add `memoryUpdated: z.boolean().optional(),` to `messageRecordObjectSchema`. In `backend/src/contracts/api.ts` add `memoryUpdated: true,` to the `visibleMessageSchema` pick. Add this same role guard to each schema's existing `superRefine`:

```ts
if (v.memoryUpdated !== undefined && v.role !== 'assistant') {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['memoryUpdated'],
    message: 'memory updates require assistant role' });
}
```

  In `toVisibleMessage` add `...(record.memoryUpdated === true ? { memoryUpdated: true } : {}),`. In `backend/src/contracts/stream.ts` add `memoryUpdated: z.boolean().optional(),` to `completedEventSchema` only. In `backend/src/contracts/metadata.ts` use `purpose: z.enum(['chat', 'compaction', 'memory']).optional(),`; voice accounting has a distinct contract. Do not add a separate SSE event or modify LangGraph messages.
- [ ] **Green:** `npm test -- src/contracts/user-memory.spec.ts src/contracts/archive.spec.ts src/contracts/compaction.spec.ts test/contracts/calendar-multi-wire.spec.ts` and `npm run build`.
- [ ] **Commit:** Stage the nine paths listed above. `git commit -m "feat(user-memory): add session pin, temporary flag, and assistant marker contracts"`

### Task 5: Add the voice request flag without committing existing edits

**Files:** Modify `backend/src/contracts/voice-wire.ts` (`CreateVoiceSessionRequest`, `isCreateVoiceSessionRequest`) and `backend/src/contracts/user-memory.spec.ts`.

- [ ] **Red:** Import `isCreateVoiceSessionRequest` from `./index.js`; append:

```ts
it('accepts the optional voice creation flag without relaxing the request shape', () => {
  const request = { protocolVersion: 1, mode: 'live', conversationId: null,
    locale: 'en-US', idempotencyKey: 'voice-123' };
  expect(isCreateVoiceSessionRequest(request)).toBe(true);
  expect(isCreateVoiceSessionRequest({ ...request, ephemeral: true })).toBe(true);
  expect(isCreateVoiceSessionRequest({ ...request, ephemeral: false })).toBe(true);
  expect(isCreateVoiceSessionRequest({ ...request, ephemeral: 'true' })).toBe(false);
  expect(isCreateVoiceSessionRequest({ ...request, ephemeral: true, userId: 'other' })).toBe(false);
});
```

- [ ] **Run red:** `npm test -- src/contracts/user-memory.spec.ts -t "voice creation flag"` — the exact guard rejects `ephemeral: true`.
- [ ] **Implement:** Preserve the working `./voice-limits.js` import/re-exports and limits extraction. Edit only the request and its guard:

```ts
export type CreateVoiceSessionRequest = { protocolVersion: 1; mode: VoiceMode;
  conversationId: string | null; locale: 'en-US'; idempotencyKey: string; ephemeral?: boolean };
export function isCreateVoiceSessionRequest(value: unknown): value is CreateVoiceSessionRequest {
  if (!record(value)) return false;
  const { ephemeral, ...base } = value;
  if (Object.hasOwn(value, 'ephemeral') && !bool(ephemeral)) return false;
  return exact(base, { protocolVersion: oneOf(1), mode: oneOf('dictation', 'live'),
    conversationId: nullable(id), locale: oneOf('en-US'),
    idempotencyKey: v => id(v) && (v as string).length >= 8 });
}
```

- [ ] **Green:** `npm test -- src/contracts/user-memory.spec.ts src/contracts/voice.spec.ts` — legacy and extended requests pass; string flags and unknown properties fail.
- [ ] **Commit:** `git add -- backend/src/contracts/user-memory.spec.ts`; `git add -p -- backend/src/contracts/voice-wire.ts`. Split/edit mixed hunks if Git combines the guard change with deletion of `isVoiceLimits`, or the type change with deletion of `DEFAULT_VOICE_LIMITS`. Stage only the flag additions/replacement, then inspect `git diff --cached -- backend/src/contracts/voice-wire.ts` (no limits edits) and `git diff -- backend/src/contracts/voice-wire.ts` (the user's limits extraction is still there). Never stage the untracked `backend/src/contracts/voice-limits.ts`. If staging cannot be isolated, stop and ask the parent; don't revert either set of changes. `git commit -m "feat(user-memory): accept temporary flag on voice creation requests"`

### Task 6: Admin settings, legacy read, and snapshot projection

**Files:** Modify `backend/src/contracts/admin-config-wire.ts`, `backend/src/contracts/admin-config.ts`, `backend/src/contracts/config-runtime.ts`, `backend/src/platform/config/manageable-config.ts`, `backend/src/admin-config/admin-config.service.spec.ts`.

**Mapping decision:** The approved **Compaction model** choice is a point-in-time shortcut, not a persisted third mode. Resolve it against the compaction settings at selection time: `active-fork` → `{ modelMode: 'main', customModelId: null }`; valid custom compaction ID → `{ modelMode: 'custom', customModelId: compaction.customModelId }`. The latter saves a copy and does not follow later compaction changes; the former follows Main, even if compaction is later switched to Custom. The stored selection reloads as its canonical Main or Custom value. P5 receives this mapping; do not add a hidden sentinel or silently drop the option. This differs from the original goal's live-link wording; a persistent live link would require reopening the two-mode decision.

- [ ] **Red:** In `backend/src/admin-config/admin-config.service.spec.ts` extend the existing fixtures import with `bootstrap`; import `isManageableSettings` from the wire, `saveSettingsRequestSchema` and `storedConfigDocumentSchema` from `../contracts/admin-config.js`, and `buildRuntimeSnapshot` from `../platform/config/manageable-config.js`. Add:

```ts
it('normalizes only absent legacy memory and rejects malformed or missing new saves', () => {
  const defaults = { modelMode: 'main', customModelId: null };
  const seeded = document();
  const full = seeded.settings;
  expect(full.memory).toEqual(defaults);
  const legacy = { ...seeded, settings: Object.fromEntries(
    Object.entries(full).filter(([key]) => key !== 'memory'),
  ) };
  expect(isManageableSettings(legacy.settings)).toBe(true);
  expect(storedConfigDocumentSchema.parse(legacy).settings.memory).toEqual(defaults);
  expect(saveSettingsRequestSchema.safeParse({
    protocolVersion: 1, expectedRevision: 1, settings: legacy.settings,
  }).success).toBe(false);
  for (const memory of [null, {}, { modelMode: 'compaction', customModelId: null },
    { modelMode: 'custom', customModelId: null }, { modelMode: 'custom', customModelId: ' x ' },
    { modelMode: 'main', customModelId: null, unexpected: true }]) {
    const settings = { ...full, memory };
    expect(isManageableSettings(settings)).toBe(false);
    expect(storedConfigDocumentSchema.safeParse({ ...seeded, settings }).success).toBe(false);
  }
});

it('projects the memory default and resolves the configured snapshot ID only', async () => {
  const f = serviceFixture(null);
  expect((await f.service.read(actor)).settings.memory).toEqual({ modelMode: 'main', customModelId: null });
  const settings = fixtureSettings();
  settings.openRouter.modelId = 'fixture/main';
  const candidate = { revision: 1, settings, credentials: { openrouter: null, deepgram: null } };
  expect(buildRuntimeSnapshot(bootstrap, candidate, null).memoryModelId).toBe('fixture/main');
  settings.memory = { modelMode: 'custom', customModelId: 'fixture/cheap' };
  const snapshot = buildRuntimeSnapshot(bootstrap, candidate, null);
  expect(snapshot.memoryModelId).toBe('fixture/cheap');
  expect(Object.isFrozen(snapshot.settings.memory)).toBe(true);
  expect(snapshot.openRouter.modelId).toBe('fixture/main');
});

it('returns allowlisted field errors for malformed memory settings before CAS', async () => {
  const f = serviceFixture();
  for (const [memory, path] of [
    [{ modelMode: 'compaction', customModelId: null }, 'memory.modelMode'],
    [{ modelMode: 'custom', customModelId: null }, 'memory.customModelId'],
  ] as const) {
    await expect(f.service.saveSettings({
      protocolVersion: 1, expectedRevision: 1, settings: { ...fixtureSettings(), memory },
    }, actor)).rejects.toMatchObject({
      code: 'CONFIG_VALIDATION_FAILED', fieldErrors: [expect.objectContaining({ path })],
    });
  }
  expect(f.repository.compareAndSwap).not.toHaveBeenCalled();
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
```

- [ ] **Run red:** `npm test -- src/admin-config/admin-config.service.spec.ts -t "legacy memory|snapshot ID|malformed memory"` — no default/projection/field paths yet.
- [ ] **Implement:** In `backend/src/contracts/admin-config-wire.ts`, add the following next to the compaction settings and add `memory: MemorySettings;` to `ManageableSettings`. Add only `'memory.modelMode'` and `'memory.customModelId'` to `ADMIN_CONFIG_FIELD_PATHS`.

```ts
export type MemorySettings = { modelMode: 'main' | 'custom'; customModelId: string | null };
export const DEFAULT_MEMORY_SETTINGS = {
  modelMode: 'main', customModelId: null,
} as const satisfies MemorySettings;
type ReadableManageableSettings = Omit<ManageableSettings, 'memory'> & { memory?: MemorySettings };
type ReadablePublicAdminConfig = Omit<PublicAdminConfig, 'settings'> & { settings: ReadableManageableSettings };
```

  Define `isMemorySettings` after `nonEmptyModelId` so the compatibility candidate guard in Task 7 can reuse it:

```ts
function isMemorySettings(value: unknown): value is MemorySettings {
  return record(value) && exact(value, {
    modelMode: x => x === 'main' || x === 'custom', customModelId: nullable(nonEmptyModelId),
  }) && (value.modelMode !== 'custom' || value.customModelId !== null);
}
```

  Change the `isManageableSettings` predicate return to `value is ReadableManageableSettings`; replace its destructure with `const { devModeEnabled, memory, ...base } = value;` and add `if (Object.hasOwn(value, 'memory') && !isMemorySettings(memory)) return false;` after the optional dev-mode check. Use `ReadableManageableSettings` for the post-`exact` cast. In `isPublicAdminConfig`, use `ReadablePublicAdminConfig` for the predicate and its final cast. Production `PublicAdminConfig` still emits a required memory choice; the guard accepts missing only for legacy reads. No `ChatFloor` or protocol version changes.

  In `backend/src/contracts/admin-config.ts` import `DEFAULT_MEMORY_SETTINGS`. Insert in `manageableSettingsSchema` and its existing `superRefine` respectively:

```ts
memory: z.object({
  modelMode: z.enum(['main', 'custom']),
  customModelId: modelIdSchema.refine(value => value.length > 0).nullable(),
}).strict(),
```

```ts
if (settings.memory.modelMode === 'custom' && settings.memory.customModelId === null) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['memory', 'customModelId'],
    message: 'Custom memory model is required.' });
}
```

  In `storedManageableSettingsSchema` (not the save schema), add:

```ts
if (!Object.hasOwn(record, 'memory')) {
  next = { ...next, memory: { ...DEFAULT_MEMORY_SETTINGS } };
}
```

  In `backend/src/contracts/config-runtime.ts` add `readonly memoryModelId: string;` to `RuntimeConfigSnapshot`. In `backend/src/platform/config/manageable-config.ts`, import `DEFAULT_MEMORY_SETTINGS`, add `memory: { ...DEFAULT_MEMORY_SETTINGS },` beside `compaction` in `defaultManageableSettings`, and add to the object returned from `buildRuntimeSnapshot`:

```ts
memoryModelId: clonedSettings.memory.modelMode === 'custom'
  ? clonedSettings.memory.customModelId ?? clonedSettings.openRouter.modelId
  : clonedSettings.openRouter.modelId,
```

  Public projection clones a parsed stored record; after `settings.devModeEnabled ??= false;`, add `settings.memory ??= { ...DEFAULT_MEMORY_SETTINGS };` for legacy read-only projections. An empty `memoryModelId` is the existing empty-main-ID unconfigured state; the ID is not proof of provider readiness. `saveSettings` requires the current full shape just as it does for compaction: do not deploy a new backend with an old admin bundle that neither reads nor submits `memory`.
- [ ] **Green:** `npm test -- src/admin-config/admin-config.service.spec.ts src/contracts/admin-config.spec.ts test/admin-config/admin-config-api.spec.ts` and `npm run build`.
- [ ] **Commit:** Stage the five paths listed above. `git commit -m "feat(admin-config): add backward-compatible memory model settings"`

### Task 7: Validate the custom model before saving

**Files:** Modify `backend/src/model/catalogue.ts`, `backend/src/admin-config/admin-config.service.ts`, `backend/src/contracts/admin-config-wire.ts`, `backend/src/admin-config/admin-config.service.spec.ts`.

- [ ] **Red:** Add `isModelCompatibilityResponse` to the admin service spec's `../contracts/admin-config-wire.js` import and add these deterministic cases. The existing fixture keeps activation and persistence in process; all catalogue responses use its injected fetch mock.

```ts
const memoryCatalogueEntry = (id: string) => ({
  id, context_length: 128_000, top_provider: { max_completion_tokens: 16_384 },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  endpoints: ['/api/v1/chat/completions'], supported_parameters: ['max_tokens'],
  expiration_date: null,
});

it.each([
  ['missing', [], 'MODEL_NOT_LISTED'],
  ['deprecated', [{ ...memoryCatalogueEntry('fixture/memory'), expiration_date: '2026-11-01' }], 'MODEL_NOT_LISTED'],
  ['too small', [{ ...memoryCatalogueEntry('fixture/memory'), context_length: 4096,
    top_provider: { max_completion_tokens: 128 } }], 'OUTPUT_CAPACITY_TOO_SMALL'],
] as const)('blocks a %s custom memory model at check and save, before CAS', async (_case, entries, code) => {
  const f = serviceFixture(null);
  const settings = fixtureSettings();
  settings.openRouter.modelId = 'fixture/main';
  settings.memory = { modelMode: 'custom', customModelId: 'fixture/memory' };
  f.fetchImpl.mockImplementation(async () => Response.json({
    data: [memoryCatalogueEntry('fixture/main'), ...entries],
  }));
  const request = { protocolVersion: 1, expectedRevision: 0, settings };
  const check = await f.service.checkModelCompatibility(request, actor);
  expect(check.candidate.memory).toEqual(settings.memory);
  expect(isModelCompatibilityResponse(check)).toBe(true);
  expect(check.report.blockers).toContainEqual({ code, path: 'memory.customModelId' });
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  await expect(f.service.saveSettings(request, actor)).rejects.toMatchObject({
    code: 'MODEL_INCOMPATIBLE',
    compatibility: { blockers: expect.arrayContaining([{ code, path: 'memory.customModelId' }]) },
  });
  expect(f.activation.prepare).not.toHaveBeenCalled();
  expect(f.repository.createIfAbsent).not.toHaveBeenCalled();
  expect(f.activation.publish).not.toHaveBeenCalled();
});

it('saves a listed custom memory ID or fails closed when the catalogue is unavailable', async () => {
  const f = serviceFixture();
  const settings = fixtureSettings();
  settings.memory = { modelMode: 'custom', customModelId: 'fixture/memory' };
  const request = { protocolVersion: 1, expectedRevision: 1, settings };
  f.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(f.service.saveSettings(request, actor))
    .rejects.toMatchObject({ code: 'MODEL_CATALOGUE_UNAVAILABLE' });
  expect(f.repository.compareAndSwap).not.toHaveBeenCalled();
  f.fetchImpl.mockResolvedValueOnce(Response.json({ data: [memoryCatalogueEntry('fixture/memory')] }));
  expect((await f.service.saveSettings(request, actor)).settings.memory).toEqual(settings.memory);
  expect(f.active()?.memoryModelId).toBe('fixture/memory');
  expect(f.fetchImpl).toHaveBeenLastCalledWith(expect.stringContaining('/models?'), expect.objectContaining({ method: 'GET' }));
  expect(f.activation.publish).toHaveBeenCalledTimes(1);
});

it('does not fetch a secondary catalogue for main mode with an unconfigured main provider', async () => {
  const f = serviceFixture();
  await f.service.saveSettings({ protocolVersion: 1, expectedRevision: 1, settings: fixtureSettings() }, actor);
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
```

- [ ] **Run red:** `npm test -- src/admin-config/admin-config.service.spec.ts -t "custom memory|secondary catalogue"` — custom model blockers missing and/or invalid saves get through.
- [ ] **Implement:** In `backend/src/model/catalogue.ts`, import `type MemorySettings`, add `memory?: MemorySettings;` to `CompatibilityConfig`, and add this shared evaluator. Keep the existing compaction path unchanged. Use the same configured capacity thresholds and bounded text chat/native output-cap evidence, with `provider-default` reasoning for the secondary model. Do not require tools or JSON mode. The public [OpenRouter Models API schema](https://github.com/openrouterteam/docs/blob/main/openapi/openapi.yaml) documents `expiration_date` as nullable deprecation metadata; reject a selected custom ID with declared non-null expiration (including scheduled retirement). No separate deprecation code or change to main/compaction admission.

```ts
export function evaluateMemoryModel(
  modelId: string, budgets: CompatibilityConfig['budgets'], snapshot: CatalogueSnapshot,
): EvidenceEvaluation {
  const selectable = snapshot.entries.filter(entry =>
    entry.id !== modelId || entry.expiration_date === null || entry.expiration_date === undefined,
  );
  const evaluated = evaluateModelEvidence({
    budgets,
    openRouter: { modelId, reasoningEffort: 'provider-default',
      dataCollection: 'deny', disableTransforms: true },
  }, { ...snapshot, entries: selectable });
  evaluated.reportBase.blockers = evaluated.reportBase.blockers.map(({ code }) => ({
    code, path: 'memory.customModelId',
  }));
  return evaluated;
}
```

  In `evaluateModelCompatibility`, immediately before constructing the return value, add:

```ts
if (config.memory?.modelMode === 'custom') {
  const custom = evaluateMemoryModel(config.memory.customModelId ?? '', config.budgets, snapshot);
  for (const blocker of custom.reportBase.blockers) {
    addBlocker(evaluated.reportBase.blockers, blocker.code, blocker.path);
  }
  evaluated.reportBase.status = compatibilityStatus(evaluated.reportBase.blockers);
  if (evaluated.reportBase.status !== 'catalogue-compatible') evaluated.limits = null;
}
```

  In `backend/src/contracts/admin-config-wire.ts`, add `memory?: MemorySettings;` to `ModelCompatibilityResponse.candidate` (optional for older response readers). Before the response guard, define:

```ts
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
```

  Replace the inline `candidate` guard in `isModelCompatibilityResponse` with `candidate: isCompatibilityCandidate,`. Echo the choice because compatibility now depends on it; a report for one memory draft must not look like a report for another.

  In `backend/src/admin-config/admin-config.service.ts`, import `evaluateMemoryModel`. In `checkModelCompatibility`, pass `memory: settings.memory` beside `compaction: settings.compaction` to `evaluateModelCompatibility` and add `memory: { ...settings.memory },` to the response candidate. Insert `await this.validateCustomMemoryModel(settings);` after the revision and floor checks in `saveSettings`, before constructing the candidate. Use the existing validation limiter and existing static public errors:

```ts
private async validateCustomMemoryModel(settings: ManageableSettings): Promise<void> {
  if (settings.memory.modelMode !== 'custom') return;
  const assets = this.assets();
  if (assets === null) throw new AdminConfigFault('CONFIG_ACTIVATION_UNAVAILABLE');
  const budgets = composeRuntimeBudgets(settings, this.bootstrap.safety);
  this.acquireValidation(this.now());
  try {
    const snapshot = await readModelCatalogue(new AbortController().signal, PREPARE_MS, this.fetcher);
    const { reportBase, limits } = evaluateMemoryModel(settings.memory.customModelId ?? '', budgets, snapshot);
    if (limits === null) {
      throw new AdminConfigFault(
        reportBase.status === 'incompatible' ? 'MODEL_INCOMPATIBLE' : 'MODEL_UNVERIFIED',
        null, [{ path: 'memory.customModelId', code: 'invalid' }],
        { ...reportBase, chatFloor: computeChatFloor(assets, budgets) },
      );
    }
  } catch (error) {
    if (error instanceof CatalogueReadError) throw new AdminConfigFault('MODEL_CATALOGUE_UNAVAILABLE');
    throw error;
  } finally {
    this.releaseValidation();
  }
}
```

  Existing activation also verifies the configured main model; a custom save can make one additional bounded, unpaid catalogue GET. The compatibility preview evaluates both from its one existing snapshot. No fetch is added to runtime snapshot projection, reads, default Main saves, or chat/voice dispatch. Do not edit `AppService`, startup/activation wiring, or the writer in P1.
- [ ] **Green:** `npm test -- src/admin-config/admin-config.service.spec.ts test/admin-config/ test/assembly/admin-config.spec.ts` and `npm run build` — new and existing validation/CAS checks pass with no external calls.
- [ ] **Commit:** `git add -- backend/src/model/catalogue.ts backend/src/admin-config/admin-config.service.ts backend/src/contracts/admin-config-wire.ts backend/src/admin-config/admin-config.service.spec.ts`, then `git commit -m "feat(admin-config): validate custom memory models before saving"`.

### Task 8: Guarded Mongo write allowlist

**Files:** Modify `backend/src/persistence/mutation-journal.ts` (collection/mutation constants) and `backend/src/contracts/user-memory.spec.ts`.

- [ ] **Red:** Extend the memory spec's Vitest import with `vi`. Import `type MongoClient` from `mongodb` and `guardedClient`, `MutationJournal` from `../persistence/mutation-journal.js`. Add:

```ts
it('journals user_memory upserts and scoped deletes without weakening the facade', async () => {
  const order: string[] = [];
  const updateOne = vi.fn(async (_filter: unknown, update: unknown) => {
    const state = (update as { $set: { 'local.mutation': { state: string } } }).$set['local.mutation'].state;
    order.push(state);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
  });
  const dispatch = (name: string) => vi.fn(async (..._args: unknown[]) => {
    order.push(name);
    return { acknowledged: true, deletedCount: 1 };
  });
  const upsert = dispatch('upsert');
  const deleteMany = dispatch('deleteMany');
  const deleteOne = dispatch('deleteOne');
  const raw = { db: () => ({ collection: () => ({ updateOne: upsert, deleteMany, deleteOne }) }) };
  const db = guardedClient(raw as unknown as MongoClient, 'fixture', new MutationJournal({ updateOne }, 'owner', 100))
    .db('fixture');
  const filter = { _id: 'u', userId: 'u' };
  const scoped = { userId: 'u', sessionId: 's' };
  const options = { writeConcern: { w: 'majority', j: true }, timeoutMS: 100, maxTimeMS: 100 };
  await db.collection(COLLECTIONS.userMemory).updateOne(filter, { $setOnInsert: { userId: 'u' } }, { upsert: true });
  await db.collection(COLLECTIONS.messages).deleteMany(scoped, { writeConcern: { w: 0 } });
  await db.collection(COLLECTIONS.sessions).deleteOne(scoped);
  expect(upsert).toHaveBeenCalledWith(filter, { $setOnInsert: { userId: 'u' } }, { ...options, upsert: true });
  expect(deleteMany).toHaveBeenCalledWith(scoped, options);
  expect(deleteOne).toHaveBeenCalledWith(scoped, options);
  expect(order).toEqual(['busy', 'upsert', 'idle', 'busy', 'deleteMany', 'idle', 'busy', 'deleteOne', 'idle']);
  expect(() => db.collection('unadmitted')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_TOPOLOGY' }));
  expect(() => db.collection(COLLECTIONS.sessions).drop()).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_TOPOLOGY' }),
  );
  expect(() => db.collection(COLLECTIONS.sessions).deleteOne(scoped, { session: {} as never })).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_TOPOLOGY' }),
  );
  expect(deleteOne).toHaveBeenCalledTimes(1);
});
```

- [ ] **Run red:** `npm test -- src/contracts/user-memory.spec.ts -t "journals user_memory"` — the collection/method access fails with `UNSUPPORTED_TOPOLOGY`.
- [ ] **Implement:** Import `COLLECTIONS` from `../contracts/collections.js` in `backend/src/persistence/mutation-journal.ts`. Add `deleteMany:1,deleteOne:1` to `mutations` (both signatures have options at index 1); append `COLLECTIONS.userMemory` to the whitelist. No other admission, delete policy, token transition, write concern, or timeout changes. Existing journal tests already cover blocking before ACK and quarantining ambiguous writes.
- [ ] **Green:** `npm test -- src/contracts/user-memory.spec.ts test/persistence/mutation-journal.spec.ts` — the stubbed driver observes `busy → dispatch → idle` for each operation, enforced options, and rejected bypasses. This is not native topology evidence.
- [ ] **Commit:** `git add -- backend/src/persistence/mutation-journal.ts backend/src/contracts/user-memory.spec.ts`, then `git commit -m "feat(persistence): admit guarded user memory and session deletes"`.

## Downstream contract notes

- **P2:** `COLLECTIONS.userMemory = 'user_memory'`, `_id = userId`; `StoredUserMemory { schemaVersion: 1, userId, enabled, sections, revision, updatedAt }`; `UserMemorySections` keys `identity/work/preferences/ongoing/other`. `UserMemoryRepository` and `UserMemoryCasResult` as in Task 4. `UserMemoryWriterOutput { changed, changeSummary, sections }`; accounting `purpose: 'memory'`; `RuntimeConfigSnapshot.memoryModelId: string`.
- **P3:** `SessionRecord.ephemeral?: boolean`, `SessionRecord.memoryWatermarkSequence?: number`, `AgentMemoryManifest.pinnedUserMemory?: { revision: number; content: string } | null`. Repository methods `advanceMemoryWatermark?`, `hardPurgeSession?`, `listExpiredEphemeral?`, `markMemoryUpdated?`. `USER_MEMORY_MAX_CHARS`, `USER_MEMORY_MAX_BYTES`, `UPDATE_USER_MEMORY_TOOL_DEFINITION`; unchanged `ChatFloor.breakdown.{fixed,personalization,tools}`.
- **P4:** `CreateSessionRequest`, `SubmitTurnRequest`, `SessionSummary`, `CreateVoiceSessionRequest` have `ephemeral?: boolean`; `MessageRecord`, `VisibleMessage`, `completed` SSE payload have `memoryUpdated?: boolean`. `UPDATE_USER_MEMORY_NATIVE_TOOL`, `memoryCompatibleSkillDecisionSchema`, `UpdateUserMemoryArguments { instruction }`, `UpdateUserMemoryReceipt { ok: true, status, summary } | { ok: false, error: { code, retryable } }`.
- **P5:** `UserMemoryResponse { protocolVersion: 1, revision, enabled, sections, isEmpty, charCount, maxChars: 2500, updatedAt: string | null }`; edit response adds `changeSummary`. Clear `{ protocolVersion: 1, expectedRevision }`; toggle also `enabled`; edit also `instruction`. HTTP faults: `INVALID_REQUEST`, `MEMORY_CONFLICT` with `currentRevision`, `NOT_READY`, `PERSISTENCE_ERROR`, `MEMORY_WRITER_UNAVAILABLE`. `settings.memory { modelMode: 'main' | 'custom', customModelId: string | null }`, echoed as `ModelCompatibilityResponse.candidate.memory?: MemorySettings`; Compaction selection maps to the two values in Task 6.

## P1 exit gate

- [ ] From `backend/`, run `npm run build`, `npm run lint`, then `npm test`. In particular verify the two exact registry fixtures, admin-config, archive, voice, and Calendar contract suites; no suppressed regressions. Record actual pass/fail/skip counts and separate any failure already present on the untouched baseline.
- [ ] Confirm the staged/committed source excludes the pre-existing voice limits extraction and all other user changes. Report P1 commit hashes, contract shapes, and unresolved ownership/deployment limits to the parent. P1 fixture evidence does not establish native MongoDB compatibility, live OpenRouter behavior, full `ChatFloor` coverage, or integrated runtime behavior.
