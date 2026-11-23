# Technical Research: In-Session Context Compaction & Semantic-Ready Memory

**Date:** 2026-11-17  
**Baseline commit inspected:** `dd7580a` (`docs(context-compaction-memory): add goal spec and initial MAW state`)  
**Scope:** Reconcile `docs/context-compaction-memory/goal.md` and `docs/context-compaction-memory/state.md` against actual codebase seams, pinned test invariants, Ponytail minimalism, and KV-cache constraints.

---

## 1. Baseline Health & Pinned-Test Observations

Ran baseline checks prior to any implementation:
- `backend`: `npm run build` (`nest build` via `tsconfig.build.json`) — **passed** (exit `0`). Note: `npx tsc --noEmit` in `backend/` without `-p tsconfig.build.json` fails on test/cross-workspace spec files; `npm run build` is the authoritative compiler check.
- `frontend`: `npm run build` (`tsc -b && vite build`) — **passed** (exit `0`, 127 modules, 333ms).
- `backend` targeted Vitest (`src/contracts/admin-config.spec.ts`, `test/context/fixed-assets.spec.ts`, `test/context/context-failures.spec.ts`, `test/model/prompt-caching.spec.ts`) — **4 files, 119 tests passed**.
- `frontend` targeted Vitest (`src/api/protocol.test.ts`, `src/features/admin-config/config-edit-state.test.ts`) — **2 files, 37 tests passed**.
- `backend` behavior spec (`npx vitest run --config ./vitest.config.behavior.ts test/evaluations/deterministic.behavior.spec.ts`) — **2 passed, 2 pre-existing failures** on `SYSTEM_DIGEST` (`6069282D...` vs pinned `531BDD0F...`) and `<canvas_guidelines>` wording in `system.md`, while `KNOWLEDGE_DIGEST` (`CECF74AD...`) and `'does not silently remove history'` in `product_knowledge.md` currently match.

---

## 2. External Industry Research & KV-Cache Benchmarks

Targeted web research across Manus (*Context Engineering for AI Agents*), Anthropic (*Compaction / Claude Code*), Factory.ai (*Evaluating Context Compression*), and OpenRouter (*Prompt Caching & Sticky Routing*) confirms four design rules directly governing Aurvin's architecture:

1. **Batch-fold ONLY at explicit checkpoints (Manus KV-Cache Rule):** Provider KV-caches require byte-identical prefixes. Mutating or folding older tool results turn-by-turn mid-stream busts every subsequent token's KV-cache (4x–10x uncached re-prefill cost and latency spike). Therefore:
   - **Never mutate older turns in place during normal append turns.**
   - **Run Stage 1 deterministic tool-payload folding (`tool-folding.ts`) strictly as:** (a) the pre-processor feeding Stage 2 compaction input `[0..K]` (cutting compaction input tokens and preventing compaction prompt overflow), and (b) emergency RAM-only Burst Step A relief if a single massive turn pushes past `100%` before async compaction finishes.
   - Between 80% compaction cycles, `[0..prefixCount-1]` + `[activeSummary]` + `[K+1..M]` remains **100% append-only and byte-identical**, avoiding extra folded-stub persistence schemas (Ponytail!).
2. **OpenRouter Sticky Routing & Prompt Caching:** `backend/src/model/policy.ts:91-93` emits top-level `cache_control: { type: 'ephemeral' }` for `isAnthropicModel(modelId)` and `backend/src/model/openrouter-adapter.ts:80` sets `body.session_id = "aurvin-<sha256(userId, sessionId)>"`. Decoupling sticky routing via `session_id` avoids provider-hopping on prompt compaction and achieves 50–90% cached input discounts as long as JSON serialization and message order stay deterministic.
3. **Structured Two-Block Compaction + Anchored Iterative Merge (Anthropic + Factory.ai):** Two-block `<analysis>` + `<summary>` gives the compactor scratchpad room before stripping `<analysis>` prior to storage. Cycle `N >= 2` merges `[Previous <summary>] + [Delta K_prev+1..K]` into eight fixed sections rather than re-summarizing blindly, preventing multi-cycle drift.
4. **Functional Probe Evaluation over ROUGE (Factory.ai):** Compression quality should be verified via functional retention tests (continuing active workflows, retaining exact URLs/event IDs/Canvas IDs, resolving state overrides like `2pm -> 4pm`) rather than naive text-overlap metrics.

### Aurvin Prompt Determinism Audit
- **Clean today:** `defaultEnvironmentContext(new Date(this.runtime.now()), 'Etc/UTC')` (`backend/src/context/context-budget.ts:81-118`, `backend/src/chat-runtime/memory-text.ts:1460`) serializes `{ timeZone, currentDate: 'YYYY-MM-DD', dayOfWeek }` without `HH:MM:SS`, keeping `[0..prefixCount-1]` byte-identical within a UTC day. `insertWebGroups` (`web-context.ts:82-95`) and `calendarContext` (`calendar-context.ts:257-276`) preserve deterministic turn insertion order.
- **Bug hazard to fix in `calendar-context.ts:244`:** `const catalogIndex = positions[0]?.index ?? input.context.messages.length - 1;` currently assumes `historyPositions[0]` sits immediately after `prefixCount`. When `ReferencedContextAssembler` injects `<compacted_history>` at `prefix.length` (the start of history), `positions[0].index` shifts to `prefix.length + 1`, which would place `Enabled plugin catalog` **after** `<compacted_history>` while `nativePrefixCount` (`calendar-context.ts:295`) assumes it was inserted **before**! Fix in P2: anchor `catalogIndex` to `(input.context as Partial<PositionedContext>).prefixCount ?? positions[0]?.index ?? input.context.messages.length - 1`.

---

## 3. Codebase Seams & Critical Findings by Subsystem

### 3.1 Contracts & Persistence (`P1`)
- **Manifest & Summary Record (`contracts/agent-memory.ts`, `contracts/metadata.ts`, `persistence/memory.ts`, `persistence/metadata.ts`):**
  - `summaryRefSchema` and `agentMemoryManifestSchema.activeSummaryRef` already exist in `backend/src/contracts/agent-memory.ts:41-56`.
  - Lift `record.activeSummaryRef !== null` rejection in `MongoMemory.putConfirmed` (`backend/src/persistence/memory.ts:69`) and enforce monotonic tail invariant (`messageRefs[0].sequence > activeSummaryRef.sourceRange.toSequence` when non-empty).
  - Add `ActiveSummaryRecord` (`schemaVersion: 1`, `kind: 'memory-summary'`, `_id: key('memory-summary', userId, sessionId, summaryId)`) in `metadata` collection via `MongoMetadata` (`putCompactionSummary`, `getCompactionSummary`, `redactCompactionSummary`) + optional port methods on `MetadataRepository` (`contracts/repositories.ts`). Reuse `CONSERVATIVE_DOCUMENT_HEADROOM_BYTES` (`budgets.maxDocumentBytes`).
- **Compaction Accounting Seam (`contracts/metadata.ts`, `persistence/metadata.ts:336-339`):**
  - **Catch:** `MongoMetadata.putAccountingConfirmed` (`metadata.ts:336-339`) currently rejects any `AccountingRecord` without a matching `AttemptRecord` (`getAttempt(...)`). Inventing fake `AttemptRecord` rows for background compaction would pollute `listAttempts`, `attemptsFor` (`history.ts`), and `MemoryText.hydrate`.
  - **Ponytail fix:** Add optional `purpose: z.enum(['chat', 'compaction']).optional()` to `accountingRecordSchema` (`contracts/metadata.ts:32-60`), and skip the `getAttempt` check in `putAccountingConfirmed` ONLY when `value.purpose === 'compaction'`. `accountingTotalsPipeline` (`persistence/accounting-reporting.ts:160`) already aggregates all `kind: 'accounting'` rows automatically without touching `accounting-reporting.ts`.
- **Session Checkpoint (`contracts/session.ts`):**
  - `sessionRecordSchema` (`session.ts:33-50`) uses `.strict()`. Add optional `compactionCheckpoint` (`{ summaryId, compactedThroughSequence, compactionCycle, summaryPreview? }`) so cold reloads and `listMessages` restore the UI divider cleanly.
- **Admin Config Contract & Mirror Pin (`contracts/admin-config-wire.ts`, `contracts/admin-config.ts`, `contracts/config-runtime.ts`, `platform/config/`):**
  - **Catch:** `backend/src/contracts/admin-config.spec.ts:256-262` asserts **verbatim equality** of the exported body between `backend/src/contracts/admin-config-wire.ts` and `frontend/src/api/admin-config-protocol.ts`! P1 must update **both** files together so `backend npm test` stays green.
  - Add `compaction: { enabled: boolean; watermarkRatio: number; modelMode: 'active-fork' | 'custom'; customModelId: string | null }` to `ManageableSettings` (`admin-config-wire.ts`, `admin-config.ts`), with `storedManageableSettingsSchema` preprocess fallback (`enabled: true, watermarkRatio: 0.8, modelMode: 'active-fork', customModelId: null`) for older `config` docs, plus defaults in `defaultManageableSettings()` (`manageable-config.ts:108`) and `parseLegacyConfigImport()` (`legacy-config-import.ts:78`).
  - Add `compactionModelLimits?: VerifiedModelLimits | null` on `RuntimeConfigSnapshot` (`contracts/config-runtime.ts:75`).
- **Wire Projections (`contracts/api.ts`, `contracts/stream.ts`):**
  - Add `CompactionCheckpointMeta` and `ContextUsageMeta` as optional fields on `listMessagesResponseSchema` (`api.ts:162-171`) and `completedEventSchema` (`stream.ts:79-89`), plus optional `{ type: 'context-state', compaction?, contextUsage }` on `streamEventSchema` (`stream.ts:91-100`). Note: `calendarCompatibleEnvelopeSchema` (`contracts/calendar-wire.ts:183`) embeds `streamEventSchema`, so stream transport validation adapts automatically.
- **Note on `memory-text-archive.ts`:** `MemoryTextArchive` (`persistence/memory-text-archive.ts:40,532`) imports `buildReferenceManifest` (owned by P2) and `TerminalEnvelope` (owned by P3). Moving `memory-text-archive.ts` ownership from P1 to **P3** avoids cross-plan build coupling before P2 lands.

### 3.2 Context Assembly & Prompt Pins (`P2`)
- **`ReferencedContextAssembler` (`context/referenced-context-assembler.ts`) & `contracts/context.ts`:**
  - Extend `ContextSourceSnapshot` with optional `summary?: ActiveSummaryRecord | null` (warm `MemoryText` passes RAM snapshot with **0 DB reads**); when `source` is omitted (cold/fallback), read via optional `metadata.getCompactionSummary` port if `manifest.activeSummaryRef !== null`.
  - Inject `<compacted_history>` message immediately at `prefix.length` (the start of history, before `heardHistory` and `newUserInput`), keeping `prefixCount: prefix.length` unchanged so `checkContextBudget` (`context-budget.ts:183-206`) accounts `[summary, ...tail, newUserInput]` inside `maxHistoryTokens` and `[0..prefixCount-1]` remains byte-identical.
  - Apply `calendarContext:244` `catalogIndex` fix noted in Section 2 so `Enabled plugin catalog` precedes `<compacted_history>`.
- **`reference-selection.ts`:**
  - Lift `value.activeSummaryRef !== null` in `validateManifest` (`reference-selection.ts:60`), enforce `refs[0].sequence > value.activeSummaryRef.sourceRange.toSequence` (when `refs.length > 0`), and add optional `activeSummaryRef: SummaryRef | null = null` parameter to `buildReferenceManifest` (`reference-selection.ts:118`).
  - Update pinned unit test `backend/test/context/context-failures.spec.ts:28` (and `reference-selection.spec.ts`) in P2 so `npm test` passes.
- **Pure Compaction Helpers (`context/cutpoint.ts`, `context/tool-folding.ts`, `context/compaction-prompt.ts`):**
  - Keep all three pure, stateless, and free of plugin registries or DB I/O.
  - `cutpoint.ts`: selects completed turn boundary `K` keeping `protectedTail` (`>= minTailTurns` (3) or `~25%` of `maxHistoryTokens`, capped `<= 60%`) + pinning open `CalendarProposalRecord` turns and active multi-turn tool chains (`<= 50%` cap, falling back to structured summary preservation if one task exceeds cap).
  - `tool-folding.ts`: folds `web_tool` bodies, superseded Calendar reads (honoring `CALENDAR_TOMBSTONE` on expired/disconnected sources), duplicate Canvas artifacts, and generic `> foldToolResultBytes` (1024 B) tool results into compact schema-valid stubs. Used for compaction input `[0..K]` and Burst Step A only (per Manus KV-cache rule).
  - `compaction-prompt.ts`: generates the 8-section prompt (and anchored Cycle `N >= 2` merge prompt), enforces `<calendar_context>` isolation for single-operation tombstone redaction, parses `<summary>` while stripping `<analysis>`, and caps summary size `<= 25%` of `maxHistoryTokens` and `<= budgets.maxDocumentBytes`.
- **Product Copy & Eval Pins (`product_knowledge.md`):**
  - `backend/src/instructions/fixed-assets.ts:61-67` requires `product_knowledge.md` to begin with `# Aurvin product knowledge\n\nRelease: phase1.v1\n` and stay `<= 16,384` bytes without secrets. Preserve `do not promise an Azure tier` (`HON-01`).
  - Updating `product_knowledge.md` in P2 intentionally invalidates `KNOWLEDGE_DIGEST` (`CECF74AD...`) and `'does not silently remove history'` in `backend/test/evaluations/deterministic.behavior.spec.ts` / `cases.json` (which are excluded from `npm test` via `vitest.config.ts:32` and aligned in P5).

### 3.3 Runtime, Hydration, Model Runner & App Wiring (`P3`)
- **Breaking the 128-Turn / 500-Message Ceiling (`memory-first-foundation.ts`, `memory-text.ts`, `calendar-history.ts`):**
  - `MemoryFirstFoundation` (`memory-first-foundation.ts:283,365,371`): keep `maxTurnsPerSession <= 250` as the **working-set** cap.
    - Replace the hard `s.requests.size >= this.policy.maxRequestsPerSession` (`line 371`) failure with $O(1)$ eviction of the oldest non-active, non-unsaved `requestKey` from `s.requests` (JS `Map` insertion order).
    - Add `promoteCompaction` to update `s.base` (`manifest`, `tailRecords`, `summary`), evict compacted turns `0..K` from `s.results` (once saved / not in `s.jobs`), `s.baseCalendar`, `s.baseWeb`, and `s.archive`, reclaiming `retainedBytes` cleanly.
  - `MemoryText` (`memory-text.ts:225-312,1469,1503`):
    - **Cold `$O(\text{tail})$` hydration (`hydrate`):** Stop calling `messages.listForContext` across the entire session (`line 275-278`)! Load `session`, `manifest`, `ActiveSummaryRecord` (if `activeSummaryRef !== null`), tail `getReferences(manifest.messageRefs)`, latest `attempts` stopping once `sequence < tailMinSeq` (checking latest page for non-terminal/newer sequence), `sequence-counter`, and tail `native`/`web` only. Compute `nextSequence` from `sequence-counter`, latest attempt, and latest message (`limit: 1`).
    - **Orphaned tool-group guard:** `calendarContext:235` and `webContext:71` throw `INVALID_REQUEST` if `historicalGroups` / `historicalWebGroups` contain any `turnId` absent from `historyPositions`! Both `promoteCompaction` and `MemoryText.execute` (`lines 1469-1472, 1503-1506`) MUST prune/filter `cold.groups`, `cold.webGroups`, `baseCalendar`, and `baseWeb` to `turnId`s present in `tailRecords`.
    - **`calendar-history.ts:49-55`:** Also scans `listAttempts` up to a `250` cap; update it in P3 to stop paging `listAttempts` once `sequence < minRecordSequence` when `records.length > 0`.
  - **UI Scrollback Past Tail (`memory-text.ts:435-464`, `http/chat-http.service.ts:70-85`):**
    - Serve page 1 from RAM tail (`MemoryText.messages()`), reporting `olderAvailable: true` whenever `manifest.activeSummaryRef !== null` (or cursor goes past tail), and fall back to `p.messages.listPublished` in `ChatHttpService.messages()` when `after` cursor crosses below `tail[0].sequence` (or RAM page has `< limit` items with older archived messages).
  - **Async Compaction State Machine & Burst Fallback (`memory-text.ts`, `durable-chat-runtime.ts`, `finalization.ts`):**
    - Trigger post-turn (`finish()` / `complete()`) for both Text and Live Voice when `compaction.enabled` and effective history exceeds `watermarkRatio * maxHistoryTokens` (default `0.8`) or `watermarkRatio * maxMessagesInContext`, with at most one in-flight `CompactionJob` per `(userId, sessionId)` and bounded cooldown on transient errors.
    - Concurrent turns `K+1..` dispatch immediately against existing `activeSummary + tail` with zero waiting. Completed jobs stage into `pendingCompaction` and promote **only between turns** (preserving `K+1..latest` verbatim), then save `ActiveSummaryRecord` -> `AgentMemoryManifest` -> `boundaryFor(target)` -> `sessions.compactionCheckpoint` via `MemoryTextArchive.saveCompaction`.
    - Burst `>100%` fallback before `assemble`: (A) RAM Stage 1 folding on `0..K`, (B) await in-flight `CompactionJob` & promote, (C) one synchronous inline compaction, (D) `CONTEXT_BUDGET_EXCEEDED` only if indivisible input + minimal summary still exceeds ceiling.
    - `finalization.ts:163` (`checkedResult`): lift `r.target.activeSummaryRef !== null` and preserve `current.activeSummaryRef` in `buildReferenceManifest`. Note: `DurableChatRuntime` delegates all normal text and live-voice turns to `MemoryText` (`durable-chat-runtime.ts:338,358`); updating `ReferencedContextAssembler` + `finalization.ts` + optional burst helper ensures fallback/recovery paths remain 100% compatible with compacted manifests.
- **Calendar Privacy Redaction (`memory-text.ts:581`, `memory-text-archive.ts`, `memory-first-foundation.ts`):**
  - Replace `<calendar_context>...</calendar_context>` (or nullable `calendarContext` block) inside `ActiveSummaryRecord` with `CALENDAR_TOMBSTONE` and stamp `redactedAt` whenever `now >= earliestExpiresAt` or `connectionId`/`connectionRevision` mismatches on `invalidateCalendarAccount`, `hydrate`, `saveCompaction`, and `assemble`.
- **Compaction Model Runner & Custom Model Validation (`model/compaction-runner.ts`, `model/catalogue.ts`, `admin-config/admin-config.service.ts`, `app.service.ts`):**
  - **Catch in `policy.ts:41` & `policy.ts:49-50`:** `assertRequest` enforces `r.messages.length <= c.budgets.maxMessagesInContext` and `last.content <= maxInputTokens`. In `active-fork`, sending `[0..prefixCount-1, prevSummary, ...deltaMessages, { role: 'user', content: compactionPrompt }]` keeps `last` `< 2 KB` and reuses the live session's exact KV-cache prefix, while `CompactionRunner` passes `maxMessagesInContext: Math.max(budgets.maxMessagesInContext + 4, messages.length)` so appending the compaction prompt never trips the message-count cap.
  - Validate `compaction.customModelId` against the **same single** `CatalogueSnapshot` fetch in `evaluateModelCompatibility` / `prepareConfigurationSnapshot` (no extra HTTP call) and store `compactionModelLimits` on `RuntimeConfigSnapshot`.

### 3.4 Frontend (`P4`)
- `frontend/src/api/admin-config-protocol.ts` is mirrored in **P1** (byte-for-byte test pin).
- `frontend/src/api/protocol.ts`: add `CompactionCheckpointMeta` and `ContextUsageMeta`, extend `listMessagesResponseSchema` / `isStreamEvent` (`completed` optional `compaction`/`contextUsage` + optional `context-state`).
- `frontend/src/features/chat/` (`chat-types.ts`, `chat-reducer.ts`, `use-chat.ts`, `ChatView.tsx`) & `frontend/src/components/{Transcript,Composer}.tsx`:
  - Render a quiet inline divider in `Transcript` immediately after the last visible message with `sequence <= compaction.compactedThroughSequence` (with optional expand-to-preview toggle).
  - Render a quiet utilization pill in `ChatView`/`Composer` when `utilizationPercent > 50` or `status === 'compacting'`, staying completely silent in Live Voice (`LiveVoicePanel`).
- `frontend/src/features/admin-config/` (`config-edit-state.ts`, `ConfigFields.tsx`, `ModelSelectionFields.tsx`, `AdminDashboard.tsx`, `testing/fixtures.ts`):
  - **Invariant:** `config-edit-state.test.ts:84-87` asserts `catalogCoverage` covers every path in `ADMIN_CONFIG_FIELD_PATHS`. Add `compaction.*` to `ADMIN_CONFIG_FIELD_PATHS` and `editableFields`.
  - Reuse `ModelCombobox` exported from `ModelSelectionFields.tsx` when `compaction.modelMode === 'custom'` (no duplicate search dropdown), include `compaction.modelMode` / `compaction.customModelId` in `requiresCompatibilityCheck` & `compatibilityKey`, and update `testing/fixtures.ts` (`publicConfig()`).

---

## 4. Recommended P1–P5 Ownership & DAG Refinements for `state.md`

To prevent parallel file collisions and keep every plan's `npm run build` / `npm test` exit gate green:

1. **P1 (Contracts & Persistence Primitives):**
   - **Add:** `frontend/src/api/admin-config-protocol.ts` (required verbatim mirror for `admin-config.spec.ts`), `backend/src/contracts/{config-runtime,session,repositories}.ts`, `backend/src/platform/config/{manageable-config,legacy-config-import}.ts`, `backend/src/persistence/metadata.ts`.
   - **Move out of P1 -> P3:** `backend/src/persistence/memory-text-archive.ts` (depends on P2's `buildReferenceManifest` and P3's `TerminalEnvelope`).
2. **P2 (Context Engine & Prompt Copy):**
   - Keep `backend/src/context/{tool-folding,cutpoint,compaction-prompt,referenced-context-assembler,reference-selection,calendar-context,web-context,context-budget}.ts`, `product_knowledge.md`, `backend/test/context/*.spec.ts` (including updating `context-failures.spec.ts:28`).
3. **P3 (Runtime, Hydration, Model Runner & App Wiring):**
   - **Add:** `backend/src/persistence/memory-text-archive.ts`, `backend/src/chat-runtime/calendar-history.ts`, `backend/src/http/{chat-http.service,chat-stream.transport}.ts`, `backend/src/model/catalogue.ts`.
   - **Drop:** `backend/src/app.controller.ts` (serves only `/` and `/health`; wire projections live in `http/chat-http.service.ts` and `chat-runtime/`).
4. **P4 (Frontend Chat UI & Admin Config):**
   - Keep `frontend/src/api/protocol.ts`, `frontend/src/features/chat/**`, `frontend/src/components/{Transcript,Composer}.tsx`, `frontend/src/features/admin-config/**`, `frontend/src/styles/**`. (`admin-config-protocol.ts` updated by P1; `frontend` `npm run build` becomes green once P4 updates `testing/fixtures.ts` & `config-edit-state.ts`).
5. **P5 (Integrated Verification, Native Long-Session E2E & Eval Alignment):**
   - Keep `backend/test/integration/compaction.native.e2e-spec.ts` and `backend/test/evaluations/**` (aligning `KNOWLEDGE_DIGEST` + `PK-01` after P2 updates `product_knowledge.md`, without touching unrelated pre-existing `SYSTEM_DIGEST` drift unless separately authorized).
