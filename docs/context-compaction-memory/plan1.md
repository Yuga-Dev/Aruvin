# P1: Contracts, Admin Config Schema & Persistence Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide bounded compaction contracts, backward-compatible admin settings, safe wire projections, summary storage/redaction, and independently attributed compaction accounting.

**Architecture:** Extend the existing Zod contracts, stored-settings preprocessor, `MongoMemory`, and `MongoMetadata`; reuse `RecordStore` immutable inserts, confirmed revision CAS, BSON bounds, and `CALENDAR_TOMBSTONE`. Summary text contains exactly one isolated `<calendar_context>` block when Calendar provenance is present, with one small pure redaction function reusable by P2/P3. No new collections, dependencies, registries, runtime compaction orchestration, or validation framework.

**Tech Stack:** TypeScript/NodeNext ESM, installed Zod 3.25, MongoDB driver 6 / existing `RecordStore`, Vitest 4.

---

## Execution rules and scope

- Inputs: approved `docs/context-compaction-memory/goal.md`, research `81719e1`, and P1 ownership/exit gate in `docs/context-compaction-memory/state.md`.
- Execute only after this plan is committed by the orchestrator. Planning does not satisfy a worker dependency.
- All commands below run with working directory `backend`; there is no root npm package. Use Node `^22.22.3 || ^24.15.0 || >=26.0.0`. All backend local TypeScript imports use `.js`.
- Keep the diff small: reuse existing fixtures and helpers; do not add packages, framework layers, a summary collection, tokenizers, folded-result storage schemas, or new budget knobs. Preserve the 500-reference **working-window** bound, rather than making records unbounded.
- Every new code file must begin with the full mandated `FILE / LOCATION / PURPOSE / ROLE IN PROJECT / KEY COMPONENTS` block comment, as shown in the tests below. Retain/update existing headers when editing more than 30% of an existing file.
- No git commands in the worker. Each task ends with a suggested message and named files for the orchestrator's serialized commit. Never stage unrelated `benchmarks/voice-architectures/**`, `docs/voice-latency-benchmark/**`, `output/`, or `.openchamber/**`.
- Unified review is **skipped**, not passed. TDD, defect correction, and P1 verification remain required.
- Do not modify P2 context implementations, P3 runtime/archive/model/admin-service wiring, P4 frontend UI, or P5 evaluations/integration suites. In particular, `persistence/memory-text-archive.ts` is P3-owned.

## File map

Modify:
- `backend/src/contracts/agent-memory.ts`: summary/provenance, checkpoint metadata, source-range safety, pure Calendar redaction, `SummaryRef`.
- `backend/src/contracts/context.ts`: optional warm summary snapshot; bounded context-usage projection.
- `backend/src/contracts/admin-config-wire.ts` and `frontend/src/api/admin-config-protocol.ts`: identical exported public body, compaction settings/defaults/field paths/guard.
- `backend/src/contracts/admin-config.ts`: strict compaction settings; absent-only stored-settings default.
- `backend/src/contracts/config-runtime.ts`: optional verified compaction-model limits.
- `backend/src/platform/config/manageable-config.ts`: fresh settings default.
- `backend/src/contracts/session.ts`, `backend/src/contracts/api.ts`, `backend/src/contracts/stream.ts`: optional persisted checkpoint and HTTP/SSE projections.
- `backend/src/contracts/repositories.ts`: optional summary persistence ports.
- `backend/src/persistence/memory.ts`: admit summarized manifests without weakening tail/CAS bounds.
- `backend/src/contracts/metadata.ts`, `backend/src/persistence/metadata.ts`: optional accounting purpose and summary persistence primitives.
- `backend/src/contracts/admin-config.spec.ts`: settings/default/mirror regression checks.

Create:
- `backend/src/contracts/compaction.spec.ts`: summary/privacy/checkpoint/usage contracts.
- `backend/test/persistence/compaction-records.spec.ts`: real repositories over existing deterministic storage fixture.

Intentionally unchanged:
- `backend/src/contracts/budgets.ts`: current byte/history/document bounds already cover summaries; P2 enforces the 25%-of-history output target.
- `backend/src/platform/config/legacy-config-import.ts`: already calls `defaultManageableSettings()` at line 78; test that inherited default instead of adding a redundant assignment.
- `backend/src/persistence/messages.ts`: existing bounded reference materialization and full-archive pagination already serve P3.
- `backend/src/persistence/records.ts`: existing `bounded`, `key`, `normalizeDate`, and BSON headroom already serve these records.
- `backend/src/contracts/index.ts`: existing wildcard exports already expose the additions.

## Frozen handoff to downstream plans

P1 defines these names and shapes; downstream workers must consume them rather than invent parallel schemas:

```typescript
// contracts/agent-memory.ts
type SummaryRef = { summaryId: string; sourceRange: SourceRange };
// activeSummaryRecordSchema / ActiveSummaryRecord, implemented in Task 1.
// redactSummaryCalendar(record, redactedAt): ActiveSummaryRecord
// compactionCheckpointMetaSchema / CompactionCheckpointMeta, implemented in Task 3.

// contracts/context.ts
// contextUsageMetaSchema / ContextUsageMeta, implemented in Task 3.
// ContextSourceSnapshot.summary?: ActiveSummaryRecord | null

// contracts/repositories.ts: optional to preserve existing fixtures/adapters.
// putCompactionSummary?(record: ActiveSummaryRecord): Promise<void>
// getCompactionSummary?(userId, sessionId, summaryId): Promise<ActiveSummaryRecord | null>
// redactCompactionSummary?(userId, sessionId, summaryId, redactedAt):
//   Promise<ActiveSummaryRecord | null>
```

- Summary records use `kind: 'memory-summary'` in existing `metadata`, with `_id = key('memory-summary', userId, sessionId, summaryId)`.
- Calendar provenance has one `connectionId`, one `connectionRevision`, and earliest expiry. P2/P3 must tombstone Calendar material that cannot be represented by that single authorized binding; never silently retain mixed/revoked sources.
- `redactSummaryCalendar` is an unconditional, immutable, idempotent privacy transformation once the caller decides redaction is required. It does not check authority or access storage. P3 compares authorized account ID/revision and invokes it on RAM snapshots and explicit persistence redaction. P1's summary getter also projects exact-expiry redaction, without a write.
- P2 owns two-block parsing, eight-section content, summary token/byte target, and semantic isolation of all Calendar-derived text into the dedicated block. P1 rejects scratchpad tags and malformed provenance; it cannot infer whether arbitrary prose was derived from Calendar.
- P3 owns background model calls, `purpose: 'compaction'` usage records, unique job/attempt identities, promotion/CAS ordering across collections, runtime privacy checks, session checkpoint writes, and custom-model catalogue verification. Never create fake chat `AttemptRecord`s for compaction.
- Optional `compaction` / `contextUsage` fields are shared by message lists and completed events. `context-state` requires `contextUsage` and optionally carries `compaction`. No protocol-version bump; existing payloads remain valid.
- `summaryPreview` is optional and bounded to 500 characters. P3 should omit it unless generated from non-Calendar, analysis-free sections; schemas cannot detect redacted Calendar prose. Live Voice must not speak these projections.

### Task 1: Add bounded summary contracts and the reusable privacy transformation

**Files:** Modify `backend/src/contracts/agent-memory.ts`, `backend/src/contracts/context.ts`; create `backend/src/contracts/compaction.spec.ts`.

- [ ] **Step 1: Write the failing tests.**

Create `backend/src/contracts/compaction.spec.ts` with this complete initial content:

```typescript
/**
 * ============================================================================
 * FILE: compaction.spec.ts
 * LOCATION: backend/src/contracts/compaction.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify bounded compaction memory and client-safe context projections.
 *
 * ROLE IN PROJECT:
 *    Freezes P1 contracts for downstream context, runtime, and UI workers
 *    without requiring provider or database access.
 *
 * KEY COMPONENTS:
 *    - Summary contracts: Provenance, scratchpad exclusion, and redaction.
 *    - Projection contracts: Optional checkpoint and context-usage metadata.
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import {
  activeSummaryRecordSchema, agentMemoryManifestSchema, redactSummaryCalendar,
} from './agent-memory.js';
import { CALENDAR_TOMBSTONE } from './calendar-sources.js';
import type { ContextSourceSnapshot } from './context.js';

const range = { fromSequence: 0, toSequence: 4, fromEventId: 'e0', toEventId: 'e4' };
const rawSummary = {
  schemaVersion: 1, kind: 'memory-summary', userId: 'u1', sessionId: 's1',
  summaryId: 'summary-1', compactionCycle: 1, sourceRange: range,
  content: 'Goal: ship.\n<calendar_context>Private event at 4pm.</calendar_context>\nNext: confirm.',
  calendarProvenance: { containsCalendarContent: true, connectionId: 'conn-1',
    connectionRevision: 2, earliestExpiresAt: '2026-11-17T12:00:00.000Z', redactedAt: null },
  modelId: 'fixture/model', tokenEstimate: 120, createdAt: '2026-11-17T11:00:00.000Z',
};

describe('compaction memory contracts', () => {
  it('accepts a structured summary and a bounded tail-only manifest snapshot', () => {
    const summary = activeSummaryRecordSchema.parse(rawSummary);
    const manifest = agentMemoryManifestSchema.parse({
      schemaVersion: 1, userId: 'u1', sessionId: 's1', contextVersion: 2,
      activeSummaryRef: { summaryId: summary.summaryId, sourceRange: range },
      sourceRanges: [], messageRefs: [], instructionVersion: 'v1',
      knowledgeContentHash: 'abc', graphSchemaVersion: 'v1',
    });
    const snapshot: ContextSourceSnapshot = { manifest, records: [], summary };
    expect(snapshot.summary?.sourceRange.toSequence).toBe(4);
    expect(manifest.activeSummaryRef?.summaryId).toBe('summary-1');
  });

  it('rejects scratchpad, invalid provenance, unsafe ranges and unbounded content', () => {
    for (const change of [
      { content: '<analysis>private reasoning</analysis><summary>answer</summary>' },
      { reasoning: 'private reasoning' },
      { compactionCycle: 0 },
      { tokenEstimate: Number.MAX_SAFE_INTEGER + 1 },
      { sourceRange: { ...range, toSequence: -1 } },
      { sourceRange: { ...range, fromSequence: 5 } },
      { sourceRange: { ...range, toSequence: Number.MAX_SAFE_INTEGER + 1 } },
      { content: 'x'.repeat(65_537) },
      { content: 'Calendar data without its isolated block.' },
      { content: '<calendar_context>one</calendar_context><calendar_context>two</calendar_context>' },
      { calendarProvenance: { ...rawSummary.calendarProvenance, connectionId: null } },
      { calendarProvenance: { ...rawSummary.calendarProvenance, connectionRevision: 0 } },
      { calendarProvenance: { ...rawSummary.calendarProvenance, earliestExpiresAt: null } },
      { calendarProvenance: { ...rawSummary.calendarProvenance,
        redactedAt: '2026-11-17T11:30:00.000Z' } },
    ]) expect(activeSummaryRecordSchema.safeParse({ ...rawSummary, ...change }).success).toBe(false);
  });

  it('accepts non-Calendar summaries only without Calendar provenance or tags', () => {
    const plain = { ...rawSummary, content: 'Continue URL research.',
      calendarProvenance: { containsCalendarContent: false, connectionId: null,
        connectionRevision: null, earliestExpiresAt: null, redactedAt: null } };
    expect(activeSummaryRecordSchema.safeParse(plain).success).toBe(true);
    expect(activeSummaryRecordSchema.safeParse({ ...plain,
      content: rawSummary.content }).success).toBe(false);
  });

  it('replaces only the Calendar block without mutation or redaction reversal', () => {
    const summary = activeSummaryRecordSchema.parse(rawSummary);
    const at = '2026-11-17T11:30:00.000Z';
    const redacted = redactSummaryCalendar(summary, at);
    expect(redacted.content).toBe(
      `Goal: ship.\n<calendar_context>${CALENDAR_TOMBSTONE}</calendar_context>\nNext: confirm.`,
    );
    expect(summary.content).toContain('Private event at 4pm.');
    expect(redacted.calendarProvenance.redactedAt).toBe(at);
    expect(redacted.sourceRange).toEqual(range);
    expect(activeSummaryRecordSchema.parse(redacted)).toEqual(redacted);
    expect(redactSummaryCalendar(redacted, '2026-11-17T12:00:00.000Z')).toBe(redacted);
  });
});
```

- [ ] **Step 2: Prove RED.**

Run: `npm test -- src/contracts/compaction.spec.ts -t "compaction memory contracts"`

Expected: FAIL because `activeSummaryRecordSchema` / `redactSummaryCalendar` do not exist. Existing nullable summary references alone are not implementation evidence.

- [ ] **Step 3: Implement the minimum contract additions.**

In `backend/src/contracts/agent-memory.ts`, add imports:

```typescript
import { DEFAULT_BUDGETS } from './budgets.js';
import { CALENDAR_TOMBSTONE } from './calendar-sources.js';
// Extend the existing identifiers import:
import { idSchema, isoDateSchema, sequenceSchema } from './identifiers.js';
```

Change the two sequence properties of `sourceRangeSchema` to `sequenceSchema.safe()` and its ending from `.strict()` to:

```typescript
  .strict()
  .refine(range => range.fromSequence <= range.toSequence, {
    message: 'Source range must be ordered.',
  });
```

After `summaryRefSchema`, add:

```typescript
export const activeSummaryRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  kind: z.literal('memory-summary'),
  userId: idSchema,
  sessionId: idSchema,
  summaryId: idSchema,
  compactionCycle: z.number().int().positive().safe(),
  sourceRange: sourceRangeSchema,
  content: z.string().min(1).max(DEFAULT_BUDGETS.maxMessageBytes)
    .refine(value => !/<\/?analysis\b/i.test(value), { message: 'Scratchpad is not memory.' }),
  calendarProvenance: z.object({
    containsCalendarContent: z.boolean(),
    connectionId: idSchema.nullable(),
    connectionRevision: z.number().int().positive().safe().nullable(),
    earliestExpiresAt: isoDateSchema.nullable(),
    redactedAt: isoDateSchema.nullable(),
  }).strict(),
  modelId: z.string().min(1).max(200),
  tokenEstimate: z.number().int().nonnegative().safe(),
  createdAt: isoDateSchema,
}).strict().superRefine((value, ctx) => {
  const p = value.calendarProvenance;
  const block = value.content.match(/<calendar_context>([\s\S]*?)<\/calendar_context>/);
  const tags = value.content.match(/<\/?calendar_context\b[^>]*>/gi) ?? [];
  const valid = p.containsCalendarContent
    ? block !== null && tags.length === 2 && p.connectionId !== null &&
      p.connectionRevision !== null && p.earliestExpiresAt !== null &&
      (p.redactedAt === null || block[1] === CALENDAR_TOMBSTONE)
    : tags.length === 0 && p.connectionId === null && p.connectionRevision === null &&
      p.earliestExpiresAt === null && p.redactedAt === null;
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom,
    path: ['calendarProvenance'], message: 'Calendar summary must be isolated and attributable.' });
});

export type ActiveSummaryRecord = z.infer<typeof activeSummaryRecordSchema>;
export type SummaryRef = z.infer<typeof summaryRefSchema>;

export function redactSummaryCalendar(
  record: ActiveSummaryRecord, redactedAt: string,
): ActiveSummaryRecord {
  if (!record.calendarProvenance.containsCalendarContent ||
      record.calendarProvenance.redactedAt !== null) return record;
  return {
    ...record,
    content: record.content.replace(/<calendar_context>[\s\S]*?<\/calendar_context>/,
      `<calendar_context>${CALENDAR_TOMBSTONE}</calendar_context>`),
    calendarProvenance: { ...record.calendarProvenance,
      redactedAt: isoDateSchema.parse(redactedAt) },
  };
}
```

Keep `tokenEstimate` as the previous conservative upper estimate after redaction; do not invent another estimator. This single schema check verifies structure, not semantic summary quality.

In `backend/src/contracts/context.ts`, extend the existing type import and snapshot:

```typescript
import type { ActiveSummaryRecord, AgentMemoryManifest } from './agent-memory.js';

export type ContextSourceSnapshot = {
  manifest: AgentMemoryManifest;
  records: readonly MessageRecord[];
  summary?: ActiveSummaryRecord | null;
};
```

No assembler or runtime edits belong to this task.

- [ ] **Step 4: Prove GREEN and preserve existing archive contracts.**

Run: `npm test -- src/contracts/compaction.spec.ts src/contracts/archive.spec.ts`

Expected: PASS, including legacy null-summary manifests and strict transcript/unknown-field rejection. Run `npm run build`; expected exit 0.

- [ ] **Step 5: Request the orchestrator's serialized commit.**

Suggested message: `feat(memory): define bounded compaction summary contracts`

Named files: `backend/src/contracts/agent-memory.ts`, `backend/src/contracts/context.ts`, `backend/src/contracts/compaction.spec.ts`.

### Task 2: Extend strict admin settings and preserve the exact public mirror

**Files:** Modify `backend/src/contracts/{admin-config-wire,admin-config,admin-config.spec,config-runtime}.ts`, `backend/src/platform/config/manageable-config.ts`, `frontend/src/api/admin-config-protocol.ts`. Read but do not modify `backend/src/platform/config/legacy-config-import.ts`.

- [ ] **Step 1: Add failing tests at the end of `backend/src/contracts/admin-config.spec.ts`.**

Add these imports to the existing import lists:

```typescript
import { loadBootstrapConfig } from '../platform/config/bootstrap-config.js';
import { parseLegacyConfigImport } from '../platform/config/legacy-config-import.js';
```

Append:

```typescript
describe('compaction manageable settings', () => {
  const defaults = { enabled: true, watermarkRatio: 0.8,
    modelMode: 'active-fork', customModelId: null };
  it('defaults fresh and legacy-import settings without sharing mutable state', () => {
    const first = defaultManageableSettings();
    expect(first.compaction).toEqual(defaults);
    expect(parseLegacyConfigImport({}, loadBootstrapConfig({})).settings.compaction).toEqual(defaults);
    first.compaction.enabled = false;
    expect(defaultManageableSettings().compaction).toEqual(defaults);
    expect(ADMIN_CONFIG_FIELD_PATHS.filter(path => path.startsWith('compaction.'))).toEqual([
      'compaction.enabled', 'compaction.watermarkRatio',
      'compaction.modelMode', 'compaction.customModelId',
    ]);
  });
  it.each([0.5, 0.8, 0.9])('accepts bounded watermark %s through schema and wire', watermarkRatio => {
    const s = defaultManageableSettings();
    const raw = { ...s, compaction: { ...defaults, watermarkRatio } };
    expect(manageableSettingsSchema.safeParse(raw).success).toBe(true);
    expect(isManageableSettings(raw)).toBe(true);
  });
  it('accepts custom mode only with a nonempty bounded model ID', () => {
    const s = defaultManageableSettings();
    for (const customModelId of ['fixture/cheap', 'm'.repeat(200)]) {
      const raw = { ...s, compaction: { ...defaults, modelMode: 'custom', customModelId } };
      expect(manageableSettingsSchema.safeParse(raw).success).toBe(true);
      expect(isManageableSettings(raw)).toBe(true);
    }
    for (const compaction of [
      null, {}, { ...defaults, enabled: 'true' }, { ...defaults, watermarkRatio: 0.49 },
      { ...defaults, watermarkRatio: 0.91 }, { ...defaults, watermarkRatio: Infinity },
      { ...defaults, watermarkRatio: Number.NaN }, { ...defaults, watermarkRatio: '0.8' },
      { ...defaults, modelMode: 'other' }, { ...defaults, modelMode: 'custom' },
      { ...defaults, customModelId: '' }, { ...defaults, customModelId: ' x ' },
      { ...defaults, customModelId: 'a\nb' }, { ...defaults, customModelId: 'm'.repeat(201) },
      { ...defaults, apiKey: 'secret' },
    ]) {
      const raw = { ...s, compaction };
      expect(manageableSettingsSchema.safeParse(raw).success).toBe(false);
      expect(isManageableSettings(raw)).toBe(false);
    }
  });
  it('defaults only absent stored compaction, never malformed values or new saves', () => {
    const full = defaultManageableSettings();
    const { compaction: ignored, ...oldSettings } = full;
    expect(ignored).toEqual(defaults);
    const old = { _id: 'aurvin', schemaVersion: 1, revision: 7, settings: oldSettings,
      credentials: { openrouter: null, deepgram: null },
      updatedAt: '2026-11-17T11:00:00.000Z', updatedBy: 'fixture-user' };
    expect(storedConfigDocumentSchema.parse(old).settings.compaction).toEqual(defaults);
    expect(old.settings).not.toHaveProperty('compaction');
    expect(saveSettingsRequestSchema.safeParse({
      protocolVersion: 1, expectedRevision: 7, settings: oldSettings,
    }).success).toBe(false);
    for (const compaction of [null, {}, { enabled: false }]) {
      expect(storedConfigDocumentSchema.safeParse({
        ...old, settings: { ...oldSettings, compaction },
      }).success).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Prove RED.**

Run: `npm test -- src/contracts/admin-config.spec.ts -t "compaction manageable settings"`

Expected: FAIL on missing compaction defaults / strict schema rejection of the new settings.

- [ ] **Step 3: Extend the existing public settings and guard, without another validator layer.**

In `backend/src/contracts/admin-config-wire.ts`, insert before `ManageableSettings`:

```typescript
export type CompactionSettings = {
  enabled: boolean;
  watermarkRatio: number;
  modelMode: 'active-fork' | 'custom';
  customModelId: string | null;
};
export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true, watermarkRatio: 0.8, modelMode: 'active-fork', customModelId: null,
} as const satisfies CompactionSettings;
```

Add this required property immediately after `chat` in `ManageableSettings`:

```typescript
  compaction: CompactionSettings;
```

Add these entries immediately after the `chat.*` entries in `ADMIN_CONFIG_FIELD_PATHS`:

```typescript
  'compaction.enabled',
  'compaction.watermarkRatio',
  'compaction.modelMode',
  'compaction.customModelId',
```

In the existing `isManageableSettings` exact shape, after `chat`, insert:

```typescript
    compaction: v => exact(v, {
      enabled: bool,
      watermarkRatio: x => finite(x) && (x as number) >= 0.5 && (x as number) <= 0.9,
      modelMode: x => x === 'active-fork' || x === 'custom',
      customModelId: nullable(nonEmptyModelId),
    }),
```

After `const s = value as ManageableSettings;`, insert:

```typescript
  if (s.compaction.modelMode === 'custom' && s.compaction.customModelId === null) return false;
```

In `backend/src/contracts/admin-config.ts`, import `DEFAULT_COMPACTION_SETTINGS` from the existing wire import. Add after `chat` in the settings schema:

```typescript
    compaction: z.object({
      enabled: z.boolean(),
      watermarkRatio: z.number().finite().min(0.5).max(0.9),
      modelMode: z.enum(['active-fork', 'custom']),
      customModelId: modelIdSchema.refine(value => value.length > 0).nullable(),
    }).strict(),
```

At the beginning of the existing settings `.superRefine`, insert:

```typescript
    if (settings.compaction.modelMode === 'custom' && settings.compaction.customModelId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['compaction', 'customModelId'],
        message: 'Custom compaction model is required.' });
    }
```

In `storedManageableSettingsSchema`'s existing preprocessor, after initializing `next`, insert:

```typescript
  if (!Object.hasOwn(record, 'compaction')) {
    next = { ...next, compaction: { ...DEFAULT_COMPACTION_SETTINGS } };
  }
```

Do not default partial/null settings or request payloads; do not change `schemaVersion` or stored revision.

In `backend/src/platform/config/manageable-config.ts`, import the same default constant as a value (retain existing type imports) and insert after `chat` in `defaultManageableSettings()`:

```typescript
    compaction: { ...DEFAULT_COMPACTION_SETTINGS },
```

No legacy-import edit is needed: it already obtains defaults before projecting old environment fields. No new `COMPACTION_*` environment settings.

In `backend/src/contracts/config-runtime.ts`, add beside `modelLimits`:

```typescript
  readonly compactionModelLimits?: Readonly<VerifiedModelLimits> | null;
```

This is an optional type seam only. P3 verifies a custom model against the same catalogue fetch and supplies the limits; P1 must not admit an unverified custom provider.

- [ ] **Step 4: Synchronize the mirror in the same task.**

Replace the body of `frontend/src/api/admin-config-protocol.ts` starting at `export const ADMIN_CONFIG_PROTOCOL_VERSION` with the entire body from that marker to EOF in `backend/src/contracts/admin-config-wire.ts`. Preserve the frontend's header, browser imports, exported `WebSearchLimits`, and local `MIN_HISTORY_TOKENS` above that marker.

This is an exact body copy, not a reimplementation: the test normalizes CRLF/LF but otherwise requires byte-equal exported text. Whole files cannot be identical because the preambles deliberately use different browser/server imports.

- [ ] **Step 5: Prove GREEN, including the mirror hazard.**

Run: `npm test -- src/contracts/admin-config.spec.ts src/contracts/config-runtime.spec.ts`

Expected: PASS, including `mirrors only the public admin contract into the frontend`, all strict settings cases, fresh defaults, and absent-only stored migration. Run `npm run build`; expected exit 0.

Do not fix P4's not-yet-updated frontend settings fixtures or field catalogue in this task. Record their required downstream update; frontend completion belongs to P4.

- [ ] **Step 6: Request the orchestrator's serialized commit.**

Suggested message: `feat(config): add backward-compatible compaction settings`

Named files: the six modified paths listed in this task, including the frontend mirror. Do not include the read-only legacy importer.

### Task 3: Define optional checkpoint and context-usage HTTP/SSE projections

**Files:** Modify `backend/src/contracts/{agent-memory,context,session,api,stream,compaction.spec}.ts`.

- [ ] **Step 1: Add exact failing projection tests.**

In `backend/src/contracts/compaction.spec.ts`, extend the existing agent-memory import with `compactionCheckpointMetaSchema`; add these imports:

```typescript
import { contextUsageMetaSchema } from './context.js';
import { listMessagesResponseSchema } from './api.js';
import { sessionRecordSchema } from './session.js';
import { streamEnvelopeSchema, completedEventSchema, encodeSseFrame, parseSseDataLine } from './stream.js';
```

Append:

```typescript
describe('compaction wire projections', () => {
  const compaction = { compactedThroughSequence: 4, compactionCycle: 1, summaryPreview: 'Goal: ship.' };
  const contextUsage = { historyTokens: 8000, maxHistoryTokens: 10000,
    utilizationPercent: 80, status: 'compacting' };
  it('round-trips optional metadata on list, completed, and context-state events', () => {
    expect(listMessagesResponseSchema.parse({ items: [], nextCursor: null,
      olderAvailable: true, compaction, contextUsage }).compaction).toEqual(compaction);
    expect(listMessagesResponseSchema.safeParse({
      items: [], nextCursor: null, olderAvailable: false,
    }).success).toBe(true);
    expect(completedEventSchema.parse({ type: 'completed', assistantMessageId: 'm6',
      outcome: 'completed', compaction, contextUsage }).contextUsage).toEqual(contextUsage);
    const envelope = streamEnvelopeSchema.parse({
      protocolVersion: 1, sessionId: 's1', turnId: 't1', attemptId: 'a1', sequence: 9,
      event: { type: 'context-state', compaction, contextUsage },
    });
    expect(parseSseDataLine(encodeSseFrame(envelope))).toEqual(envelope);
    expect(streamEnvelopeSchema.safeParse({
      ...envelope, event: { type: 'context-state', contextUsage },
    }).success).toBe(true);
    expect(streamEnvelopeSchema.safeParse({
      ...envelope, event: { type: 'context-state', compaction },
    }).success).toBe(false);
    expect(contextUsageMetaSchema.parse({
      ...contextUsage, historyTokens: 10500, utilizationPercent: 105,
    }).utilizationPercent).toBe(105);
  });
  it('keeps unsafe preview data, provider internals and invalid usage out of the wire', () => {
    for (const change of [
      { compactedThroughSequence: -1 }, { compactionCycle: 0 },
      { summaryPreview: 'x'.repeat(501) }, { summaryPreview: '<analysis>private</analysis>' },
      { summaryPreview: '<calendar_context>private</calendar_context>' },
      { summaryId: 'internal-summary' },
    ]) expect(compactionCheckpointMetaSchema.safeParse({ ...compaction, ...change }).success).toBe(false);
    for (const change of [
      { historyTokens: -1 }, { maxHistoryTokens: 0 }, { utilizationPercent: Infinity },
      { historyTokens: Number.MAX_SAFE_INTEGER + 1 }, { status: 'failed' }, { modelId: 'provider/model' },
    ]) expect(contextUsageMetaSchema.safeParse({ ...contextUsage, ...change }).success).toBe(false);
  });
  it('accepts an optional strict checkpoint on existing session records', () => {
    const record = { schemaVersion: 1, userId: 'u1', sessionId: 's1', title: 'Hello',
      createdAt: rawSummary.createdAt, updatedAt: rawSummary.createdAt,
      lastActivityAt: rawSummary.createdAt, lifecycle: 'active', graphThreadId: 'thread-1',
      execution: { ownerId: null, leaseExpiresAt: null, activeAttemptId: null, generation: 0 },
      latestTurnId: null };
    expect(sessionRecordSchema.safeParse(record).success).toBe(true);
    expect(sessionRecordSchema.parse({ ...record,
      compactionCheckpoint: { ...compaction, summaryId: 'summary-1' } })
      .compactionCheckpoint?.compactedThroughSequence).toBe(4);
    expect(sessionRecordSchema.safeParse({ ...record,
      compactionCheckpoint: { ...compaction, summaryId: 'summary-1', content: 'private' },
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Prove RED.**

Run: `npm test -- src/contracts/compaction.spec.ts -t "compaction wire projections"`

Expected: FAIL on missing projection exports or strict rejection of new optional fields.

- [ ] **Step 3: Add shared small schemas, then reference them from the existing envelopes.**

In `backend/src/contracts/agent-memory.ts`, add:

```typescript
export const compactionCheckpointMetaSchema = z.object({
  compactedThroughSequence: sequenceSchema.safe(),
  compactionCycle: z.number().int().positive().safe(),
  summaryPreview: z.string().max(500)
    .refine(value => !/<\/?(?:analysis|calendar_context)\b/i.test(value)).optional(),
}).strict();
export type CompactionCheckpointMeta = z.infer<typeof compactionCheckpointMetaSchema>;
```

In `backend/src/contracts/context.ts`, add `import { z } from 'zod';` and:

```typescript
export const contextUsageMetaSchema = z.object({
  historyTokens: z.number().int().nonnegative().safe(),
  maxHistoryTokens: z.number().int().positive().safe(),
  utilizationPercent: z.number().finite().nonnegative(),
  status: z.enum(['idle', 'compacting']),
}).strict();
export type ContextUsageMeta = z.infer<typeof contextUsageMetaSchema>;
```

Do not cap utilization at 100: burst fallback can temporarily observe more than 100%. This is a measured projection, not another admission budget.

In `backend/src/contracts/session.ts`, import `compactionCheckpointMetaSchema` from `./agent-memory.js` and add to the existing session object:

```typescript
    compactionCheckpoint: compactionCheckpointMetaSchema.extend({
      summaryId: idSchema,
    }).optional(),
```

In `backend/src/contracts/api.ts` and `backend/src/contracts/stream.ts`, import `compactionCheckpointMetaSchema` from `./agent-memory.js` and `contextUsageMetaSchema` from `./context.js`.

Add these fields to `listMessagesResponseSchema` and `completedEventSchema`:

```typescript
    compaction: compactionCheckpointMetaSchema.optional(),
    contextUsage: contextUsageMetaSchema.optional(),
```

Before the stream discriminated union in `backend/src/contracts/stream.ts`, add:

```typescript
export const contextStateEventSchema = z.object({
  type: z.literal('context-state'),
  compaction: compactionCheckpointMetaSchema.optional(),
  contextUsage: contextUsageMetaSchema,
}).strict();
```

Include `contextStateEventSchema` as another member of `streamEventSchema`. Leave envelope identity, ordering, terminal outcomes, and protocol versions unchanged. Existing `calendarCompatibleEnvelopeSchema` consumes this union automatically.

- [ ] **Step 4: Prove GREEN with legacy protocol checks.**

Run: `npm test -- src/contracts/compaction.spec.ts src/contracts/api.spec.ts src/contracts/stream.spec.ts src/contracts/archive.spec.ts`

Expected: PASS for old and extended payloads; raw summary content and IDs remain off the public checkpoint projection. Run `npm run build`; expected exit 0.

- [ ] **Step 5: Request the orchestrator's serialized commit.**

Suggested message: `feat(protocol): add bounded compaction context projections`

Named files: the six files in this task.

### Task 4: Persist summaries and summarized manifests with existing CAS/bounds

**Files:** Modify `backend/src/contracts/repositories.ts`, `backend/src/persistence/{memory,metadata}.ts`; create `backend/test/persistence/compaction-records.spec.ts`.

- [ ] **Step 1: Write deterministic repository tests using the existing storage fixture.**

Create `backend/test/persistence/compaction-records.spec.ts`:

```typescript
/**
 * ============================================================================
 * FILE: compaction-records.spec.ts
 * LOCATION: backend/test/persistence/compaction-records.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify compaction summary, manifest, privacy, and accounting persistence.
 *
 * ROLE IN PROJECT:
 *    Exercises real repositories and RecordStore over the existing offline
 *    MongoDB fixture without provider calls or native database prerequisites.
 *
 * KEY COMPONENTS:
 *    - Summary storage: Scoped immutable records and redaction-only CAS.
 *    - Manifest/accounting cases: Bounded tail and independent compaction usage.
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import { activeSummaryRecordSchema } from '../../src/contracts/agent-memory.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { CALENDAR_TOMBSTONE } from '../../src/contracts/calendar-sources.js';
import { MongoMemory } from '../../src/persistence/memory.js';
import { MongoMetadata } from '../../src/persistence/metadata.js';
import { key } from '../../src/persistence/records.js';
import { calendarMemory } from './calendar-multi-memory.js';
import { manifest } from './fixtures.js';

const createdAt = '2026-11-17T11:00:00.000Z';
const expiresAt = '2026-11-17T12:00:00.000Z';
const sourceRange = { fromSequence: 0, toSequence: 4, fromEventId: 'e0', toEventId: 'e4' };
const summary = () => activeSummaryRecordSchema.parse({
  schemaVersion: 1, kind: 'memory-summary', userId: 'u1', sessionId: 's1',
  summaryId: 'summary-1', compactionCycle: 1, sourceRange,
  content: 'Keep URL https://example.com.\n<calendar_context>Private event at 4pm.</calendar_context>\nNext: confirm.',
  calendarProvenance: { containsCalendarContent: true, connectionId: 'conn-1',
    connectionRevision: 2, earliestExpiresAt: expiresAt, redactedAt: null },
  modelId: 'fixture/model', tokenEstimate: 120, createdAt,
});
const compactedManifest = () => ({
  ...manifest(), activeSummaryRef: { summaryId: 'summary-1', sourceRange },
  messageRefs: [{ messageId: 'm5', eventId: 'e5', sequence: 5 },
    { messageId: 'm6', eventId: 'e6', sequence: 6 }],
  sourceRanges: [{ fromSequence: 5, toSequence: 6, fromEventId: 'e5', toEventId: 'e6' }],
});

describe('compaction persistence primitives', () => {
  it('stores one scoped immutable summary without inventing attempts or collections', async () => {
    const f = calendarMemory();
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS, () => Date.parse(createdAt));
    const value = summary();
    await metadata.putCompactionSummary(value);
    await metadata.putCompactionSummary(value);
    expect(await metadata.getCompactionSummary('u1', 's1', 'summary-1')).toEqual(value);
    expect(await metadata.getCompactionSummary('u2', 's1', 'summary-1')).toBeNull();
    expect(await metadata.getCompactionSummary('u1', 's2', 'summary-1')).toBeNull();
    expect(f.rows('metadata').size).toBe(1);
    expect(f.rows('metadata').get(key('memory-summary', 'u1', 's1', 'summary-1'))?.kind)
      .toBe('memory-summary');
    expect((await metadata.listAttempts('u1', 's1', { cursor: null, limit: 10 })).items).toEqual([]);
    await expect(metadata.putCompactionSummary({ ...value, content: value.content + ' changed' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
  });

  it('enforces runtime UTF-8 content and existing BSON document bounds', async () => {
    const f = calendarMemory();
    const smallMessage = new MongoMetadata(f.store,
      { ...DEFAULT_BUDGETS, maxMessageBytes: 200 }, () => Date.parse(createdAt));
    await expect(smallMessage.putCompactionSummary({
      ...summary(), content: `界${'界'.repeat(70)}\n<calendar_context>secret</calendar_context>`,
    })).rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
    const smallDocument = new MongoMetadata(f.store,
      { ...DEFAULT_BUDGETS, maxDocumentBytes: 512 }, () => Date.parse(createdAt));
    await expect(smallDocument.putCompactionSummary(summary()))
      .rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
    expect(f.rows('metadata').size).toBe(0);
  });

  it('round-trips a summarized tail, then an empty tail with existing version CAS', async () => {
    const f = calendarMemory();
    const memory = new MongoMemory(f.store, DEFAULT_BUDGETS);
    const first = compactedManifest();
    const receipt = await memory.putConfirmed(first);
    expect(await memory.get('u1', 's1')).toEqual(first);
    const next = { ...first, contextVersion: first.contextVersion + 1,
      messageRefs: [], sourceRanges: [] };
    await memory.putConfirmed(next, receipt);
    expect(await memory.get('u1', 's1')).toEqual(next);
    await expect(memory.putConfirmed({ ...first, contextVersion: 99 }))
      .rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
  });

  it('rejects summary overlap, duplicate/unsorted tail refs and wrong tail envelopes', async () => {
    for (const change of [
      { messageRefs: [{ messageId: 'm4', eventId: 'e4', sequence: 4 }] },
      { messageRefs: [{ messageId: 'm5', eventId: 'e5', sequence: 5 },
        { messageId: 'm5', eventId: 'e6', sequence: 6 }] },
      { messageRefs: [...compactedManifest().messageRefs].reverse() },
      { sourceRanges: [] },
      { sourceRanges: [{ fromSequence: 0, toSequence: 6, fromEventId: 'e0', toEventId: 'e6' }] },
      { messageRefs: [], sourceRanges: compactedManifest().sourceRanges },
      { messageRefs: Array.from({ length: 501 }, (_, i) => ({
        messageId: `m${i + 5}`, eventId: `e${i + 5}`, sequence: i + 5,
      })) },
    ]) {
      const f = calendarMemory();
      await expect(new MongoMemory(f.store, DEFAULT_BUDGETS)
        .put({ ...compactedManifest(), ...change })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(f.rows('agent-memory').size).toBe(0);
    }
  });

  it('durably redacts only Calendar content and never lets a stale insert restore it', async () => {
    const f = calendarMemory();
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS, () => Date.parse(createdAt));
    await metadata.putCompactionSummary(summary());
    const at = '2026-11-17T11:30:00.000Z';
    expect(await metadata.redactCompactionSummary('u2', 's1', 'summary-1', at)).toBeNull();
    const redacted = await metadata.redactCompactionSummary('u1', 's1', 'summary-1', at);
    expect(redacted?.content).toContain(CALENDAR_TOMBSTONE);
    expect(redacted?.content).toContain('https://example.com');
    expect(redacted?.content).not.toContain('Private event');
    expect(redacted?.calendarProvenance.redactedAt).toBe(at);
    expect(await metadata.redactCompactionSummary('u1', 's1', 'summary-1', expiresAt)).toEqual(redacted);
    await expect(metadata.putCompactionSummary(summary())).rejects.toThrow();
    expect(await metadata.getCompactionSummary('u1', 's1', 'summary-1')).toEqual(redacted);
    expect(JSON.stringify([...f.rows('metadata').values()])).not.toContain('Private event');
  });

  it('projects exact-expiry redaction on read without a write or an early expiry', async () => {
    const f = calendarMemory();
    let now = Date.parse(expiresAt) - 1;
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS, () => now);
    await metadata.putCompactionSummary(summary());
    expect((await metadata.getCompactionSummary('u1', 's1', 'summary-1'))?.content).toContain('Private event');
    now++;
    const before = f.calls.length;
    const read = await metadata.getCompactionSummary('u1', 's1', 'summary-1');
    expect(read?.content).toContain(CALENDAR_TOMBSTONE);
    expect(read?.content).not.toContain('Private event');
    expect(read?.calendarProvenance.redactedAt).toBe(expiresAt);
    expect(f.calls.slice(before).map(call => call.method)).toEqual(['findOne']);
  });

  it('confirms ambiguous redaction writes and fails closed on a CAS conflict', async () => {
    const f = calendarMemory();
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS, () => Date.parse(createdAt));
    await metadata.putCompactionSummary(summary());
    f.failNext('cas-mismatch', { collection: 'metadata', method: 'replaceOne' });
    await expect(metadata.redactCompactionSummary('u1', 's1', 'summary-1', expiresAt))
      .rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
    f.failNext('after-write', { collection: 'metadata', method: 'replaceOne' });
    expect((await metadata.redactCompactionSummary('u1', 's1', 'summary-1', expiresAt))
      ?.content).toContain(CALENDAR_TOMBSTONE);
  });
});
```

- [ ] **Step 2: Prove RED.**

Run: `npm test -- test/persistence/compaction-records.spec.ts -t "compaction persistence primitives"`

Expected: FAIL because summary repository methods do not exist and `MongoMemory` rejects a non-null summary reference.

- [ ] **Step 3: Extend only the existing optional repository seam.**

In `backend/src/contracts/repositories.ts`, extend the existing agent-memory type import with `ActiveSummaryRecord`, and add inside `MetadataRepository`:

```typescript
  putCompactionSummary?(record: ActiveSummaryRecord): Promise<void>;
  getCompactionSummary?(
    userId: string, sessionId: string, summaryId: string,
  ): Promise<ActiveSummaryRecord | null>;
  redactCompactionSummary?(
    userId: string, sessionId: string, summaryId: string, redactedAt: string,
  ): Promise<ActiveSummaryRecord | null>;
```

Optional ports preserve unrelated in-memory adapters. The concrete `MongoMetadata` methods themselves are not optional.

- [ ] **Step 4: Replace the hard summary prohibition with the actual tail invariant.**

In `backend/src/persistence/memory.ts`, after the existing `bounded(...)` call, add:

```typescript
    const first = record.messageRefs[0];
    const last = record.messageRefs.at(-1);
    const tailRanges = first && last ? [{
      fromSequence: first.sequence, toSequence: last.sequence,
      fromEventId: first.eventId, toEventId: last.eventId,
    }] : [];
```

Replace only `record.activeSummaryRef !== null ||` in the existing invalid-manifest condition with:

```typescript
      (record.activeSummaryRef !== null && (
        (first !== undefined && first.sequence <= record.activeSummaryRef.sourceRange.toSequence) ||
        !isDeepStrictEqual(record.sourceRanges, tailRanges)
      )) ||
```

Keep existing unique-message, strictly increasing sequence, size, idempotent insert, receipt validation, and `contextVersion + 1` CAS behavior. Full-transcript archive rows are never changed or deleted.

- [ ] **Step 5: Add immutable summary storage, expiry projection, and redaction-only CAS.**

In `backend/src/persistence/metadata.ts`, add:

```typescript
import {
  activeSummaryRecordSchema, redactSummaryCalendar, type ActiveSummaryRecord,
} from '../contracts/agent-memory.js';
```

Extend the existing `records.js` import with `normalizeDate`. Add an optional third constructor argument:

```typescript
    readonly clock: () => number = Date.now,
```

Add these methods to `MongoMetadata`:

```typescript
  async putCompactionSummary(record: ActiveSummaryRecord): Promise<void> {
    const id = key('memory-summary', record.userId, record.sessionId, record.summaryId);
    const { record: value } = bounded(
      activeSummaryRecordSchema, record, id, this.budgets.maxDocumentBytes,
    );
    if (Buffer.byteLength(value.content, 'utf8') > this.budgets.maxMessageBytes) {
      throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The summary is too large to save.');
    }
    await this.store.insert('metadata', activeSummaryRecordSchema, value,
      id, this.budgets.maxDocumentBytes);
  }

  async getCompactionSummary(
    userId: string, sessionId: string, summaryId: string,
  ): Promise<ActiveSummaryRecord | null> {
    const record = await this.store.read('metadata', activeSummaryRecordSchema, {
      _id: key('memory-summary', userId, sessionId, summaryId),
      kind: 'memory-summary', userId, sessionId, summaryId,
    });
    if (!record) return null;
    const p = record.calendarProvenance;
    const now = this.clock();
    return p.containsCalendarContent && p.redactedAt === null &&
      p.earliestExpiresAt !== null && now >= Date.parse(p.earliestExpiresAt)
      ? redactSummaryCalendar(record, new Date(now).toISOString()) : record;
  }

  async redactCompactionSummary(
    userId: string, sessionId: string, summaryId: string, redactedAt: string,
  ): Promise<ActiveSummaryRecord | null> {
    const at = normalizeDate(redactedAt);
    const prior = await this.store.readConfirmed('metadata', activeSummaryRecordSchema, {
      _id: key('memory-summary', userId, sessionId, summaryId),
      kind: 'memory-summary', userId, sessionId, summaryId,
    });
    if (!prior) return null;
    const next = redactSummaryCalendar(prior.record as ActiveSummaryRecord, at);
    if (next === prior.record) return next;
    const result = await this.store.replaceConfirmed(
      prior, activeSummaryRecordSchema, next, this.budgets.maxDocumentBytes,
    );
    if (result.outcome !== 'confirmed') {
      throw new AppError('CONFLICT_ACTIVE_TURN', 'Summary changed while redacting.');
    }
    return result.receipt.record as ActiveSummaryRecord;
  }
```

Do not add an unbounded CAS retry loop. `RecordStore.replaceConfirmed` already confirms ambiguous saves by reread; an unresolved conflict/uncertain outcome must reject, never return unredacted content as success. Raw immutable inserts cannot replace a redacted record. Explicit account invalidation calls this method regardless of expiry; the caller owns authority decisions.

The getter projects expiry without mutating storage. P3's tracked background archive persists expiry/invalidation redaction and checks current account binding before injection. This primitive is not authorization and is not a warm pre-model read.

- [ ] **Step 6: Prove GREEN and preserve existing persistence behavior.**

Run: `npm test -- test/persistence/compaction-records.spec.ts test/persistence/records.spec.ts test/persistence/accounting-evidence.spec.ts`

Expected: PASS, with no native database/provider prerequisites or skips. Run `npm run build`; expected exit 0.

- [ ] **Step 7: Request the orchestrator's serialized commit.**

Suggested message: `feat(persistence): store and redact bounded compaction summaries`

Named files: `backend/src/contracts/repositories.ts`, `backend/src/persistence/memory.ts`, `backend/src/persistence/metadata.ts`, `backend/test/persistence/compaction-records.spec.ts`.

### Task 5: Account for compaction without fake chat attempts

**Files:** Modify `backend/src/contracts/metadata.ts`, `backend/src/persistence/metadata.ts`, `backend/test/persistence/compaction-records.spec.ts`.

- [ ] **Step 1: Add the failing accounting cases.**

In `backend/test/persistence/compaction-records.spec.ts`, add:

```typescript
import { accountingRecordSchema } from '../../src/contracts/metadata.js';
```

Extend the existing fixture import to `import { accounting, attempt, manifest } from './fixtures.js';`, then append:

```typescript
describe('compaction accounting purpose', () => {
  it('parses optional legacy/chat/compaction purpose and rejects other values', () => {
    const value = accounting();
    expect(accountingRecordSchema.parse(value)).not.toHaveProperty('purpose');
    for (const purpose of ['chat', 'compaction']) {
      expect(accountingRecordSchema.parse({ ...value, purpose }).purpose).toBe(purpose);
    }
    expect(accountingRecordSchema.safeParse({ ...value, purpose: 'summary' }).success).toBe(false);
  });

  it('stores attributed compaction usage without a chat attempt or attempt lookup', async () => {
    const f = calendarMemory();
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS);
    const value = { ...accounting(), purpose: 'compaction' as const, turnId: 'compaction-cycle-1',
      attemptId: 'compaction-attempt-1', outcome: 'completed' as const,
      promptTokens: 8000, completionTokens: 400, cost: 0.01,
      accountingStatus: 'known' as const, endedAt: createdAt };
    await metadata.putAccounting(value);
    await metadata.putAccounting(value);
    expect(await metadata.getAccounting('u1', 's1', value.attemptId)).toEqual(value);
    expect(f.calls.some(call => call.method === 'findOne' && call.filter.kind === 'attempt')).toBe(false);
    expect([...f.rows('metadata').values()].filter(row => row.kind === 'attempt')).toHaveLength(0);
    expect([...f.rows('metadata').values()].filter(row => row.kind === 'accounting')).toHaveLength(1);
    await expect(metadata.putAccounting({ ...value, cost: 0.02 })).rejects.toThrow();
    await expect(metadata.putAccounting({ ...value, promptTokens: null })).rejects.toThrow();
  });

  it('still requires matching attempts for both legacy and explicit chat accounting', async () => {
    const f = calendarMemory();
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS);
    await expect(metadata.putAccounting(accounting()))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(metadata.putAccounting({ ...accounting(), purpose: 'chat' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await metadata.putAttempt(attempt());
    await metadata.putAccounting(accounting());
    await metadata.putAccounting({ ...accounting(), purpose: 'chat' });
    expect((await metadata.getAccounting('u1', 's1', 'a1'))?.purpose).toBe('chat');
    await expect(metadata.putAccounting({ ...accounting(), purpose: 'compaction' }))
      .rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
  });
});
```

- [ ] **Step 2: Prove RED.**

Run: `npm test -- test/persistence/compaction-records.spec.ts -t "compaction accounting purpose"`

Expected: FAIL because strict accounting rejects `purpose` and compaction still requires `getAttempt`.

- [ ] **Step 3: Make the narrow schema and linkage changes.**

In `backend/src/contracts/metadata.ts`, add beside `kind` in `accountingRecordSchema`:

```typescript
    purpose: z.enum(['chat', 'compaction']).optional(),
```

In `MongoMetadata.putAccountingConfirmed`, replace the existing `getAttempt`/linkage block with:

```typescript
    if (value.purpose !== 'compaction') {
      const linked = await this.getAttempt(value.userId, value.sessionId, value.attemptId);
      if (!linked || linked.turnId !== value.turnId || linked.modelId !== value.requestedModel) {
        throw new AppError('INVALID_REQUEST', 'Accounting attempt linkage is invalid.');
      }
    }
```

Add this condition to the existing non-regression/identity check after `const old = prior.record;`:

```typescript
      (old.purpose ?? 'chat') !== (value.purpose ?? 'chat') ||
```

Thus absent legacy purpose and explicit `chat` are equivalent, but a persisted accounting identity cannot be retagged as compaction to escape linkage. Preserve generation ownership, known-usage completeness, finite amounts, non-regressing evidence, idempotency, and revision CAS.

Do not modify reporting aggregation: existing `kind: 'accounting'` filters already include compaction rows and preserve user/session attribution. P3 supplies unique compaction attempt IDs and provider attribution.

- [ ] **Step 4: Prove GREEN, including existing accounting evidence.**

Run: `npm test -- test/persistence/compaction-records.spec.ts test/persistence/accounting-evidence.spec.ts src/contracts/metadata.spec.ts`

Expected: PASS; compaction does not create or query a chat attempt, while ordinary chat still requires matching attempt/turn/model linkage. Run `npm run build`; expected exit 0.

- [ ] **Step 5: Request the orchestrator's serialized commit.**

Suggested message: `feat(accounting): attribute compaction usage without chat attempts`

Named files: the three files in this task.

### Task 6: Execute the P1 exit gate and report the frozen handoff

**Files:** No additional source changes. Report evidence to the orchestrator; it owns workflow state and commits.

- [ ] **Step 1: Run the authoritative backend build.**

Run: `npm run build`

Expected: exit 0 (`nest build`). Do not substitute bare `npx tsc --noEmit`: research established unrelated test/cross-workspace configuration errors under that invocation.

- [ ] **Step 2: Run the complete targeted contract/persistence gate, not just name-filtered new tests.**

Run:

```text
npm test -- src/contracts/compaction.spec.ts src/contracts/admin-config.spec.ts src/contracts/config-runtime.spec.ts src/contracts/archive.spec.ts src/contracts/api.spec.ts src/contracts/stream.spec.ts src/contracts/metadata.spec.ts test/persistence/compaction-records.spec.ts test/persistence/records.spec.ts test/persistence/accounting-evidence.spec.ts test/persistence/messages-acceptance.spec.ts test/persistence/session-navigation.spec.ts
```

Expected: all discovered tests PASS, no silent empty discovery and no prerequisite skips. Record actual test/file counts and command exits. If a task-owned failure occurs, fix its root cause within the owned files and rerun that command plus the build.

- [ ] **Step 3: Confirm exit-gate coverage with the actual results.**

Check and report:
- `ActiveSummaryRecord`, null and non-null `activeSummaryRef`, bounded tail envelope, range safety, summary-only/empty-tail manifest, and `ContextSourceSnapshot.summary` are supported.
- Defaults are `enabled: true`, `watermarkRatio: 0.8`, `modelMode: 'active-fork'`, `customModelId: null`; ratio accepts exactly `0.5..0.9`. Old stored settings gain the default only when absent; fresh request payloads remain strict.
- The admin wire exported body and frontend mirror pass the existing exact equality assertion.
- Session checkpoints and optional list/completed/context-state projections parse without leaking full summary/private reasoning, and utilization can exceed 100 during a burst.
- Scoped summary storage, byte/BSON bounds, immutable retry, explicit persisted Calendar redaction, exact-expiry read projection, idempotent redaction, ambiguous-save confirmation, and fail-closed CAS conflict are tested.
- `purpose?: 'chat' | 'compaction'` works without fake attempt rows; ordinary accounting linkage and immutable purpose remain enforced.

- [ ] **Step 4: Return implementation evidence and downstream limitations.**

Report changed file paths, suggested commit messages/serialized commit acknowledgements, Node version, exact commands/results/counts, and any blocked checks. Do not run git commands. Tell P2/P3/P4 to use the frozen names above.

P1 is implemented/tested only after these checks pass; it is not runtime-compaction completion, native MongoDB certification, a live provider test, topology certification, or a wall-clock latency guarantee. Frontend UI/config fixture work is P4; custom catalogue verification, durable archive ordering, current-account invalidation wiring, and warm zero-I/O runtime behavior are P3; native long-session/evaluation evidence is P5. Unified review remains **skipped**.

## Planner self-check

- P1-only ownership: all planned source/test paths are listed in P1's owned files; no changes to P2–P5 implementations.
- Reuse: Zod schemas, existing default migration, `key`/`bounded`/BSON headroom, `RecordStore` CAS, Calendar tombstone, and `calendarMemory` fixture; no new dependencies or collections.
- Privacy/accounting: one isolated Calendar block and redaction helper; no `<analysis>` storage; compaction purpose cannot replace chat accounting identity.
- Compatibility: optional repository/snapshot/wire additions preserve existing callers; required settings gain stored-only defaults; legacy importer already inherits the default; mirrored public body is tested.
- Verification: exact RED/GREEN commands and runnable test code are supplied for every implementation task; final gate is backend build plus targeted Vitest suites. Native/live service tests are not claimed.
- Commit hygiene: suggestions only; orchestrator serializes commits. Review is skipped, not passed.
