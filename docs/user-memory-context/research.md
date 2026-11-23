# User Memory Context & True Ephemeral Chat — Technical Research

Code-backed integration findings for `docs/user-memory-context/goal.md` (commit `836ed14`), validating and correcting `docs/user-memory-context/state.md`.

---

## 1. Critical Architectural Catches

1. **`memoryWatermarkSequence` belongs on `SessionRecord`, NOT `AgentMemoryManifest`:**
   - `boundaryFor(m)` (`backend/src/agent/state.ts:122-126`) hashes the entire `AgentMemoryManifest` into LangGraph checkpoints (`TurnState.boundary`).
   - `MongoMemory.putConfirmed` (`backend/src/persistence/memory.ts:111`) enforces `contextVersion + 1` CAS, and `MemoryText` (`hydrate`), `MemoryTextArchive`, `finalization.ts`, and `reconciliation.ts` check `isDeepStrictEqual(boundaryFor(manifest), ...)` / `isDeepStrictEqual(expected, r.target)`.
   - Putting `memoryWatermarkSequence` on `AgentMemoryManifest` would cause async idle/8-turn passive extractions to race active turns (`CONFLICT_ACTIVE_TURN`) or invalidate checkpoint boundaries. Placing `memoryWatermarkSequence?: number` on **`SessionRecord`** (`sessions`), updated via atomic `$max` (`MongoSessions.advanceMemoryWatermark`, mirroring `touchActivity` at `sessions.ts:182-201`) plus RAM update on `cold.session`, avoids all manifest/checkpoint conflicts.
   - `pinnedUserMemory?: { revision: number; content: string } | null` DOES belong on `AgentMemoryManifest` (changes only at session creation `contextVersion === 0` and compaction, where `TurnState.boundary` already updates).

2. **`mutation-journal.ts` blocks `user_memory` and `deleteMany` under local crash recovery:**
   - `backend/src/persistence/mutation-journal.ts:73-74` hardcodes `collections = new Set(['sessions','messages','agent-memory','metadata','checkpoints','checkpoint_writes','integration_connections','users','user_personalization'])` and `mutations = { updateOne:2, replaceOne:2, findOneAndUpdate:2, bulkWrite:1, createIndex:1 }`.
   - Under `AURVIN_LOCAL_CRASH_RECOVERY=true`, unwhitelisted collections or `deleteMany`/`deleteOne` throw `UNSUPPORTED_TOPOLOGY`. Add `'user_memory'` to `collections` and `deleteMany: 1` / `deleteOne: 1` to `mutations` (or implement hard purge via `deleteMany` once whitelisted).

3. **`MongoMetadata.putAccountingConfirmed` rejects `purpose: 'memory'`:**
   - `backend/src/persistence/metadata.ts:388` gates orphan-link checks on `if (value.purpose !== 'compaction')`. Extend to `if (value.purpose !== 'compaction' && value.purpose !== 'memory')`. `accountingTotalsPipeline` and `accountingRecordFilter` (`backend/src/persistence/accounting-reporting.ts`) filter by `kind: 'accounting'`, so `'memory'` totals automatically aggregate.

4. **`configurePersonalizationHttp` whitelists exact routes:**
   - `backend/src/personalization/configure-personalization-http.ts:48-70` skips/rejects any path outside `/api/personalization`, `/reset`, `/reverse-geocode`. Extend its exact path/method table for `/api/personalization/memory` (`GET`), `/api/personalization/memory/enabled` (`PATCH`), `/api/personalization/memory/edit` (`POST`), `/api/personalization/memory/clear` (`POST`).

5. **`ManageableSettings` and `ChatFloor` backward compatibility:**
   - Stored `config` documents lack `settings.memory`. Like `devModeEnabled` (`contracts/admin-config.ts:126`, `contracts/admin-config-wire.ts:347`, `manageable-config.ts:298`), default `settings.memory` to `{ modelMode: 'main', customModelId: null }` in schema/projection while tolerating absence in wire guards on read.
   - `ChatFloor.breakdown` (`contracts/admin-config-wire.ts:69,411`; `frontend/src/api/admin-config-protocol.ts:71,413`; `ConfigFields.tsx:398`) strictly has `{ fixed, personalization, tools }`. Fold worst-case `userMemoryMessage` (`MAX_USER_MEMORY_BYTES`) into `breakdown.personalization` and `UPDATE_USER_MEMORY_TOOL_DEFINITION` into `WORST_CASE_TOOLS` (`breakdown.tools`) to preserve the `ChatFloor` shape without breaking existing fixtures.

6. **`model/policy.ts` sets `provider: { require_parameters: true }`:**
   - `MemoryWriterService` must NOT unconditionally pass `response_format: { type: 'json_object' }`, which causes 404s on OpenRouter models without JSON-mode support. Mirror `compaction-prompt.ts`: require strict JSON in the prompt, strip optional markdown fences, and parse with `JSON.parse` + Zod.

7. **HTTP route prefix mismatch in `goal.md`:**
   - `goal.md` mentions `DELETE /api/chat/sessions/:sessionId`, whereas actual routes (`contracts/api.ts:36-38`, `chat-http.controller.ts:27`, `frontend/src/api/protocol.ts:46-48`) are `/api/sessions` and `/api/sessions/:sessionId`. Use `DELETE /api/sessions/:sessionId`.

8. **`CalendarLoop` exact tool equality assertions:**
   - `model/calendar-policy.ts:72-82,147-150,244-261` asserts `JSON.stringify(tools) === JSON.stringify(SKILL_NATIVE_TOOLS)` (or + `WEB_TOOL_DEFINITION`), and `calendar-adapter.ts:154` passes `SKILL_NATIVE_TOOLS` to `CalendarStreamAssembly`. Both must accommodate optional `update_user_memory`, following the existing `get_environment` local-tool pattern in `calendar-loop.ts`, `calendar-validation.ts`, `calendar-repair.ts`, and `calendar-context.ts`.

---

## 2. Findings by Research Area

### Area 1: Personalization & Persistence
- **RAM Cache & Revision CAS (`backend/src/personalization/personalization.service.ts`):**
  - `PersonalizationService` maintains `cache: Map<string, StoredUserPersonalization | null>`, coalesces cold loads via `inFlightWarm: Map<string, Promise<StoredUserPersonalization | null>>`, exports synchronous `cachedSettings(userId)` (called by runtime during zero-DB pre-model assembly), and provides `warm`, `evict`, `clearCache`, `read`, `save`, `reset`, and `applyCas`.
  - Follow the identical pattern for `UserMemoryService`: synchronous `cachedMemory(userId)`, coalesced `warm(userId)` wired alongside personalization/admin-config warming in `prepareOwner`, `evict`/`clearCache` on ownership reset, and optimistic CAS loop (`compareAndSwap`) over `MongoUserMemoryRepository`.
  - `MongoUserPersonalizationRepository` (`backend/src/persistence/personalization.ts`) uses `_id: personalizationKey(userId)` (no secondary index needed — `user_memory` can share this `_id` pattern without touching `persistence/indexes.ts`), `owner.assertExecutor()`, `assertBytes(..., MAX_USER_MEMORY_RECORD_BYTES)`, `writeConcern: { w: 'majority', j: true }`, `$setOnInsert` create-if-absent, and `resolveAmbiguous` on uncertain write outcomes.
- **Secret Screening & Hygiene (`backend/src/contracts/personalization.ts:144-169`):**
  - Reuse `PERSONALIZATION_SECRET_PATTERN`, `hasSecretPattern`, `hasDisallowedControlChars`, and `extractPersonalizationFieldErrors`. Reject user manual edits containing secret patterns (`400` with field error); in `MemoryWriterService`, strip/suppress any candidate line/fact matching `PERSONALIZATION_SECRET_PATTERN` or control chars before persisting, and skip write if nothing remains.
- **Private HTTP Boundary & Headers (`backend/src/http/configure-private-http.ts:40-84`, `backend/src/main.ts`):**
  - `configurePrivateHttp` guards all `/api/*` routes: suppresses ETag (`app.set('etag', false)`), sets `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, checks `sec-fetch-site !== 'cross-site'` and `origin === frontendOrigin` on mutations, authenticates session cookie, enforces `requireFullAccount`, and invokes `prepareOwner?.(p)` (skipped only for 3 model metadata routes).
  - `configurePersonalizationHttp` (`backend/src/personalization/configure-personalization-http.ts`) enforces `MAX_PERSONALIZATION_BODY_BYTES = 16_384`, rejects non-empty query strings (`400`), enforces `application/json` UTF-8 object bodies, and repeats `no-store`/`nosniff`.
  - `PersonalizationController` (`backend/src/personalization/personalization.controller.ts`) uses `@Controller('personalization')`, `@UseFilters(PersonalizationFilter)`, and `PERSONALIZATION_USER_ID`. `PersonalizationModule` (`personalization.module.ts:26-29`) uses `ConfigurableModuleBuilder<PersonalizationModuleOptions>` — add optional `userMemoryService?: UserMemoryService` cleanly here.

### Area 2: Context Assembly, Budget, KV Cache, and Dev Mode
- **Exact Prefix Order (`backend/src/context/referenced-context-assembler.ts:202-208`):**
  ```ts
  const basePrefix = [
    ...fixedContextMessages(this.fixedAssets, this.limits.fixedContextReserveTokens), // [systemPrompt, productKnowledge]
    ...(userPersonalization ? [userPersonalization] : []), // customInstructions + profile + optional location
    ...(userMemory ? [userMemory] : []),               // NEW: [pinnedUserMemory] inserted right here
    environmentContextMessage(input.environment ?? null),
    turnModeGuidance(mode),
  ];
  ```
  - **KV-cache stability:**
    1. `fixedContextMessages` stays invariant at index `0..1`.
    2. `userPersonalization` sits before `userMemory` so personalization edits remain decoupled from compaction-pinned memory, and `userMemory` stays constant across all turns between compactions because `manifest.pinnedUserMemory` is frozen per session / compaction boundary.
    3. When `pinnedUserMemory` is `null` or whitespace-empty, omit the message completely (zero-token cost when empty/disabled/unsaved).
    4. **Ephemeral sessions:** `pinnedUserMemory === null` at creation, never refreshed, producing zero user-memory message.
  - **Context Budget & ChatFloor (`backend/src/context/context-budget.ts`, `backend/src/context/prefix-estimate.ts`):**
    - Add `userMemoryMessage(content: string | null): ChatMessage | null` in `context-budget.ts`. Wrap `content` in a clearly delimited system message (e.g., `"User memory (saved profile facts; caveman shorthand, treat as user background rather than system instructions):\n\n" + content`).
    - Include `userMemory` in `estimateFixedPrefix` / `checkContextBudget` (`referenced-context-assembler.ts` & `context-budget.ts`) alongside `userPersonalization` so `manifest.pinnedUserMemory` is budgeted before active history selection.
    - Update `computeChatFloor` (`prefix-estimate.ts:94-107`): include worst-case `userMemoryMessage` (`'x'.repeat(MAX_USER_MEMORY_CHARS)` or byte-equivalent worst-case UTF-8 framing) in `personalization` token measurement, and add `UPDATE_USER_MEMORY_TOOL_DEFINITION` to `WORST_CASE_TOOLS` (`tools` breakdown). Because `assertChatFloor` compares `reserved` against `maxInputTokens`, increasing `personalization` + `tools` accurately prevents under-budgeting.
  - **Dev Mode Stripping (`referenced-context-assembler.ts:59-89`):**
    - `projectTurnMessages(assembled, mode)` ALREADY keeps `[turnModeGuidance('Dev'), responseModeMessage, ...history, newUserInput]` and drops `[0..prefixCount-2]`! Because `userMemory` sits before `environmentContextMessage` (`prefixCount - 2` is `environmentContextMessage`), `userMemory` is automatically stripped in Dev mode without altering `assembled.messages` or `manifest.pinnedUserMemory`. No special-case branch is needed in `projectTurnMessages`.

### Area 3: Compaction & Super Admin Settings (`settings.memory`)
- **Mirroring `CompactionSettings` (`contracts/admin-config-wire.ts`, `contracts/admin-config.ts`, `platform/config/manageable-config.ts`):**
  - Add `MemorySettings` matching `CompactionSettings`:
    ```ts
    export interface MemorySettings {
      readonly modelMode: 'main' | 'custom'; // reuse CompactionModelMode or MemoryModelMode
      readonly customModelId: string | null;
    }
    ```
  - Add `readonly memory: MemorySettings;` to `ManageableSettings` (default `{ modelMode: 'main', customModelId: null }`), `manageableSettingsSchema` (`.default(...)` for stored doc backwards compatibility), `ADMIN_CONFIG_FIELD_PATHS`, `AdminConfigValidationError` (`memory.modelMode`, `memory.customModelId`), `isManageableSettings` (optional on wire input if reading older snapshots, emitted by `projectPublicAdminConfig`), and `RuntimeConfigSnapshot` (`contracts/config-runtime.ts:75-86`, resolved `effectiveMemoryModelId = settings.memory.modelMode === 'custom' && settings.memory.customModelId ? settings.memory.customModelId : settings.openRouter.modelId`).
- **Model Validation (`admin-config.service.ts`, `model/catalogue.ts`):**
  - `AdminConfigService.saveSettings` validates `settings.memory` identically to `settings.compaction`: when `modelMode === 'custom'`, `customModelId` must be non-empty, exist in live model catalogue (not deprecated), satisfy `evaluateCompactionModel` (note: for `memory` use small output reserve e.g. `1024–1536` tokens rather than full `compactionReserveTokens` if desired, or reuse `evaluateCompactionModel` / sibling `evaluateMemoryModel` requiring `maxInputTokens >= prefix + prompt` and `maxOutputTokens >= MEMORY_WRITER_MAX_OUTPUT_TOKENS`).
  - `checkModelCompatibility` and `AdminConfigService` field-error mapping (`settings.memory.*`) extend directly from `compaction`.
- **Compaction Runner Precedent (`backend/src/model/compaction-runner.ts`):**
  - `MemoryWriterService` should mirror `CompactionRunner`: build `providerParameters(modelLimits, ..., { forceNoDataCollection: true })`, respect `AbortSignal`, track OpenRouter `requestId` / `generationId` + token usage, and persist accounting via `AccountingService` with `purpose: 'memory'`.

### Area 4: Contracts & Limits
- **Collections (`backend/src/contracts/collections.ts`):**
  - Add `userMemory: 'user_memory'` to `COLLECTIONS`. Keep six core chat collections unchanged (`sessions`, `messages`, `agent-memory`, `metadata`, `checkpoints`, `checkpoint_writes`); `user_memory` sits alongside `user_personalization` and `users`.
- **New `user_memory` Contract (`backend/src/contracts/user-memory.ts` + export in `contracts/index.ts`):**
  - `USER_MEMORY_MAX_CHARS = 2500`, `USER_MEMORY_MAX_BYTES = 8000` (UTF-8), `USER_MEMORY_RECORD_MAX_BYTES = 16_384`.
  - `UserMemoryRecord`: `{ _id: string; schemaVersion: 1; userId: string; enabled: boolean; content: string; revision: number; updatedAt: string; lastSourceSessionId?: string | null; }` (keep minimal bounded metadata).
  - `UserMemoryView` / API responses (`GET /api/personalization/memory`, `PATCH /api/personalization/memory/enabled`, `POST /api/personalization/memory/edit`, `POST /api/personalization/memory/clear`): return `{ enabled, content, revision, updatedAt, charCount, maxChars: 2500 }`.
- **Existing Contract Additions:**
  - `AgentMemoryManifest` (`contracts/agent-memory.ts:112-127`): add `pinnedUserMemory?: { revision: number; content: string } | null` (optional so existing DB manifests parse without migration; `pinnedUserMemory === undefined` treated as unset/`null` for pre-feature sessions, `null` for ephemeral/empty, `{ revision, content }` when pinned). Do **NOT** put `memoryWatermarkSequence` here.
  - `SessionRecord` (`contracts/session.ts:34-56`): add `ephemeral?: boolean;` (default `false` when omitted on legacy records) and `memoryWatermarkSequence?: number;` (`int >= 0`).
  - `MessageRecord` (`contracts/message.ts:56-116`) & `VisibleMessage` (`contracts/api.ts:116-157`): add `memoryUpdated?: boolean;` on assistant messages (`toVisibleMessage` copies it only when `true` or omits when unset/false). Checkpointer-restored messages live inside LangGraph `TurnState.messages` (`BaseMessage`) and never store `memoryUpdated`; UI reads `VisibleMessage` from `messages` collection + SSE `completed` event.
  - `AccountingRecord` (`contracts/metadata.ts:32-63`): extend `purpose` enum from `['chat', 'compaction', 'voice']` to `['chat', 'compaction', 'memory', 'voice']` (also update `contracts/voice-accounting.ts` if duplicated, check `accountingPurposeSchema`).
  - `CompletedEvent` (`contracts/stream.ts:82-95`): add `memoryUpdated?: boolean` on `completed` (simplest, guaranteed arrival with final durable UI reconciliation, avoiding stream schema proliferation in `calendar-wire.ts` / `chat-stream.transport.ts`!). *Alternative:* adding a dedicated `{ type: 'memory_updated', updated: true }` SSE event requires updating `StreamEvent` + `calendarCompatibleEnvelopeSchema` (`stream.ts` + `chat-stream.transport.ts:79`) + frontend SSE parser; attaching `memoryUpdated?: boolean` to `completed` (and optionally updating immediately if a standalone event is preferred) is minimal. **Recommendation:** put `memoryUpdated?: boolean` on `completedEventSchema` (for post-turn synchronous `update_user_memory` tool calls during the turn, `memoryUpdated: true` arrives right as the turn finishes cleanly). Let `goal.md` note: if passive background extraction runs *after* `completed` returns, UI pill for tool-triggered updates works immediately on `completed`, while passive idle updates don't emit a live SSE event to an idle transcript (matching `goal.md`: passive runs async and doesn't block chat, while inline tool shows `✓ Memory updated`). Note: `completedEventSchema` is parsed by `calendarCompatibleEnvelopeSchema` (`stream.ts`), so optional `memoryUpdated?: z.boolean().optional()` is automatically permitted on both `stream.ts` and `chat-stream.transport.ts`.
  - API & Voice Wire (`contracts/api.ts`, `contracts/voice-wire.ts`): add `ephemeral?: boolean` on `CreateSessionRequest`, `SubmitTurnRequest`, `SessionSummary`, `CreateVoiceSessionRequest`, and internal `SubmitTurnCommand` / `SubmitLiveTurn` (`chat-runtime/ports.ts`).
  - Local Tools (`contracts/environment-tools.ts`, `contracts/calendar-tools.ts`, `contracts/calendar-model.ts`): define `UPDATE_USER_MEMORY_TOOL_DEFINITION` (`name: 'update_user_memory'`, strict JSON parameters e.g. `{ action: 'upsert' | 'remove', note: string }` or `{ update: string }` bounded length) and add `'update_user_memory'` alongside `'get_environment'` in calendar tool unions/schemas.

### Area 5: Session Lifecycle, Purge, Accounting Retention & Orphan Sweep
- **Soft Delete (`persistence/sessions.ts`):**
  - Existing `MongoSessions` supports `lifecycle: 'active' | 'deleted'`, `ephemeral?: boolean` should NOT break `listActive` (`lifecycle: 'active'`). Either exclude `ephemeral: true` from `listActive` (`sidebar`) OR return ephemeral only if needed — `goal.md` specifies Temporary Chat never appears in sidebar (`filter` `{ lifecycle: 'active', ephemeral: { $ne: true } }`), and normal soft-delete sets `lifecycle: 'deleted'`.
- **Hard Purge (`persistence/sessions.ts`, `persistence/messages.ts`, `persistence/memory.ts`, `persistence/metadata.ts`, `persistence/checkpoints.ts`, `persistence/store.ts`):**
  - Existing collections already have session-scoped delete/retention precedents (`persistence/calendar-retention.ts`). Add `MongoSessions.hardPurgeSession(sessionId, userId?)` which deletes in strict dependency order across the 6 collections (safe idempotent `deleteMany` by `sessionId` / `thread_id`):
    1. `checkpoints` & `checkpoint_writes` (`{ thread_id: sessionId }` — note `checkpoints.ts` builds thread keys cleanly; verify exact `thread_id` field = `sessionId`!).
    2. `agent-memory` (`{ sessionId }`).
    3. `messages` (`{ sessionId }`).
    4. `metadata`: **delete operational records (`kind !== 'accounting'`), RETAIN `kind: 'accounting'`** to preserve billing/token auditability as required by `goal.md`.
    5. `sessions` (`{ _id: sessionId }` last, so partial failure before deleting `sessions` remains re-sweepable!).
  - **Consequence of retaining accounting:** Deleting `sessions` first would orphan audit context, whereas deleting `sessions` *last* makes orphan sweep retry-safe if crashes happen mid-purge. Keep `kind: 'accounting'` rows in `metadata` untouched during ephemeral purge.
- **24h Ephemeral Orphan Sweep (`persistence/indexes.ts`, `app.service.ts`):**
  - Add partial/sparse compound index in `persistence/indexes.ts` on `sessions`: `{ lifecycle: 1, ephemeral: 1, lastActivityAt: 1 }` (or `{ ephemeral: 1, lastActivityAt: 1 }`).
  - `MongoSessions.listExpiredEphemeral(cutoffIso, limit)` queries `{ ephemeral: true, lastActivityAt: { $lt: cutoffIso } }` bounded (e.g. batch 50).
  - Run sweep once cleanly during startup reconciliation (after executor admission, non-blocking or bounded) and on a `setInterval` (e.g. hourly, `.unref()`ed + cancelled on `close()`) inside `UserMemoryScheduler` or `AppService` lifecycle, guarding against deleting an active in-memory session turn (`runtime.isSessionActive(sessionId)` check).

### Area 6: Runtime Integration, Tool Calling & Zero Pre-Model Reads
- **Zero Pre-Model Latency (`chat-runtime/durable-chat-runtime.ts`, `chat-runtime/memory-text.ts`, `chat-runtime/memory-first-foundation.ts`):**
  - **Turn 0 Pinning:** `startAcceptedSession` / `DurableChatRuntime` / `MemoryText` reads `this.userMemory?.cachedSnapshot(userId)` synchronously in RAM (**zero DB/LLM calls before model dispatch**).
    - If `ephemeral === true` or `!enabled` or empty trimmed content: `pinnedUserMemory = null`.
    - Otherwise: `pinnedUserMemory = { revision, content }`.
    - Stored on `cold.manifest.pinnedUserMemory`, persisted asynchronously in the post-response consolidated write alongside session/messages/manifest.
  - **Compaction Refresh (`chat-runtime/memory-text.ts` + `memory-first-foundation.ts` + `reconciliation.ts` + `memory-text-archive.ts`):**
    - `CompactionRunner` / `applyCompaction` updates `manifest.pinnedUserMemory` from current `userMemory.cachedSnapshot(userId)` whenever compaction writes a new manifest (`contextVersion + 1`), resetting the KV prefix once per compaction boundary.
    - Every `buildReferenceManifest(...)` call site (`durable-chat-runtime.ts`, `memory-text.ts`, `finalization.ts`, `calendar-loop.ts`, `reconciliation.ts`, `memory-text-archive.ts`, `context/reference-selection.ts`) and `MemoryFirstFoundation` (`applyCompaction`, `evictSettledForCapacity`) must propagate `pinnedUserMemory`.
- **Post-Turn & Passive Memory Updates (`UserMemoryScheduler`):**
  - Trigger passive update **only post-response** (never pre-model, never delaying `completed` SSE):
    1. Enqueue after durable turn finalization completes when `!session.ephemeral && !devMode && userMemory.enabled(userId) && !turnUsedExplicitMemoryTool`.
    2. Check delta `highestVisibleSequence - (session.memoryWatermarkSequence ?? 0)`:
       - Trigger immediately if `>= 8` non-trivial turns (`USER_MEMORY_TURN_INTERVAL = 8`).
       - Otherwise schedule a 10-minute idle timer per user/session (`unref()`ed, cancelled on next turn, session delete, or `close()`).
    3. On trigger, read recent transcript slice cleanly (from RAM `MemoryText` or `MongoMessages.listSessionMessages` > `watermarkSequence`, bounded), run `MemoryWriterService` (`purpose: 'memory'`, caveman compression, <=2,500 chars / <=8,000 UTF-8 bytes, secret scrubbing), CAS-save to `user_memory` (re-reading and merging on CAS conflict, bounded retries), then advance `session.memoryWatermarkSequence` (`$max` in Mongo + RAM).
    4. Never run inside `ephemeral === true` or `Dev` mode turns.
- **Explicit Tool (`update_user_memory`):**
  - **Admission:** Advertise `update_user_memory` ONLY when `userMemory.isEnabled(userId) && !session.ephemeral && !devMode && snapshot.modelLimits?.tools === true`.
  - **Wiring across all 3 runtime paths (`MemoryText` & `DurableChatRuntime`):**
    1. `CalendarLoop` path (`calendar-loop.ts`): `update_user_memory` is a local tool like `get_environment`. `calendar-loop.ts` executes `MemoryWriterService.applyExplicitUpdate(userId, sessionId, args, signal)` on tool call, emits tool result back to model, flags `turnState.memoryUpdated = true`, skips passive scheduler for this turn. Must follow `single-tool-turn` constraint cleanly alongside `CalendarLoop` validation/repair (`calendar-policy.ts`, `calendar-adapter.ts`, `calendar-validation.ts`, `calendar-repair.ts`, `calendar-context.ts`).
    2. `WebNative` path (`model/web-native.ts`): `createWebNativeModelPort` already handles `envToolCapable` (`snapshot.modelLimits?.tools === true`) local `get_environment` execution before continuing. Extend `WebNative` tool loop & `lateBody` (keep `tools` stripped in Dev mode!) so if `memoryToolCapable`, `UPDATE_USER_MEMORY_TOOL_DEFINITION` is included, tool calls execute `MemoryWriterService.applyExplicitUpdate` synchronously inside the active turn loop, record `memoryUpdated: true`, and feed the tool result back to OpenRouter. Note: `MemoryText` / `DurableChatRuntime` must route turns where `memoryToolCapable` is true through `WebNative` (even when `web === false` and `!calendar`).
    3. Plain text path (`AttemptAdapter`): selected only when `tools` are disabled (`!modelLimits?.tools`, Dev mode, ephemeral+no-web, or `memory.enabled === false` with no web/calendar). No tool advertised.
  - **Ephemeral Voice (`voice/agent/agent-voice-adapter.ts`, `voice/session/voice-session.service.ts`):**
    - Propagate `ephemeral?: boolean` on voice session creation into `submitLiveTurn`. Note: `AgentVoiceAdapter` builds context via the same assembler/runtime (`submitLiveTurn`); passing `ephemeral` ensures voice Temporary Chats neither receive/pin memory nor trigger passive updates and are purged on delete/close.

### Area 7: Frontend (`features/*`, `api/*`, Tests)
- **API Client & Protocol (`frontend/src/api/protocol.ts`, `client.ts`, `admin-config-protocol.ts`, `voice-protocol.ts`):**
  - Add `UserMemoryResponse`, `memoryUpdated?: boolean` on `VisibleMessage` / `CompletedStreamEvent`, `ephemeral?: boolean` on session/turn/voice requests & `SessionSummary`.
  - Add `getUserMemory`, `setUserMemoryEnabled`, `editUserMemory`, `clearUserMemory` in `client.ts`.
  - Add `memory: CompactionSettings` (`MemorySettings`) to `ManageableSettings`, `ManageableSettingsPatch`, and `AdminConfigValidationErrors` in `admin-config-protocol.ts`.
- **MemoryCard (`frontend/src/features/personalization/MemoryCard.tsx` + `PersonalizationPanel.tsx`):**
  - Render `MemoryCard` inside `PersonalizationPanel.tsx` with **independent state** (loading, saving, error, draft, revision) decoupled from custom instructions/profile form dirty state so saving memory never touches personalization fields and vice versa.
  - Reuse existing `ConfirmDialog` (shared component used in sidebar/personalization reset) for `"Clear all memory"`. Support inline textarea edit with live `X / 2,500 chars` counter and immediate error feedback on secret-pattern or size rejections.
- **Super Admin (`frontend/src/features/admin-config/ConfigFields.tsx`, `config-edit-state.ts`, `AdminDashboard.tsx`):**
  - Note: custom model selection for subsystem settings (`compaction.customModelId`) lives in `ConfigFields.tsx:264-275` (using `ModelCombobox` imported from `ModelSelectionFields.tsx`), NOT inside `ModelSelectionFields.tsx`. Add `"Memory writer model"` toggle (`Use main chat model` / `Use custom model`) + `ModelCombobox` in `ConfigFields.tsx`, backed by `config-edit-state.ts` and `AdminDashboard.tsx`.
- **Chat UI (`features/chat/ChatView.tsx`, `state/use-chat.ts`, `state/chat-reducer.ts`, `state/chat-types.ts`, `components/Transcript.tsx`, `components/MessageItem.tsx`, `App.tsx`):**
  - **Temporary Chat:** Place toggle button inside the **New Chat empty state** (and header badge/banner when active so users know they are in Temporary Chat), active when `activeSessionId === null` or inside an active `ephemeral === true` session; omit from sidebar list; dispatch `deleteSession(prevId)` when clicking `New Chat` or switching to another session while `activeSession?.ephemeral` is true; attach `window` `pagehide` / `beforeunload` handler in `use-chat.ts` firing `fetch('/api/sessions/' + id, { method: 'DELETE', keepalive: true, credentials: 'same-origin' })` (`keepalive: true` preserves `Origin` + `DELETE` method required by `configurePrivateHttp`, whereas `navigator.sendBeacon` forces `POST`).
  - **`✓ Memory updated` pill:** Pass an optional `onOpenMemorySettings?: () => void` from `App.tsx` -> `ChatView.tsx` -> `Transcript.tsx` -> `MessageItem.tsx`. When `message.role === 'assistant' && message.memoryUpdated`, render a subtle clickable `✓ Memory updated` pill navigating `App.tsx` to `admin` + `personalization` tab (scrolling/focusing `MemoryCard`).

### Area 8: Testing & Verification Strategy
- **Existing Patterns & Harnesses:**
  - Backend unit/runtime Vitest (`backend/vitest.config.ts`): discovers `test/**/*.spec.ts` excluding `*.azure.spec.ts`, `*.behavior.spec.ts`, `*.e2e.spec.ts`.
  - Backend e2e Vitest (`backend/vitest.config.e2e.ts`): `test/**/*.e2e.spec.ts`.
  - Frontend Vitest (`frontend/vitest.config.ts`): Node environment (`src/**/*.test.ts`, no jsdom by default — test reducers, API protocol guards, and state helpers deterministically!).
  - Precedents to mirror directly:
    - `backend/test/http/private-boundary.spec.ts` (Fastify inject HTTP boundary, `no-store`, origin/CSRF, query rejection, schema rejections on `/api/personalization/memory*` and `DELETE /api/sessions/:id`).
    - `backend/test/runtime/personalization-runtime.spec.ts` (zero pre-model DB read, CAS conflict handling, cache invalidation).
    - `backend/test/performance/calendar-tool-latency.spec.ts` (assert zero DB calls on Turn 0 assembly).
- **Exact Routine Commands (deterministic fixture suite — zero paid APIs):**
  - `cd backend && npm run build && npm run lint && npm test`
  - `cd backend && npm run test:e2e` (verify full HTTP controller + assembled pipeline with deterministic OpenRouter/Mongo fixtures)
  - `cd frontend && npm run build && npm run lint && npm test`
- **Native / Live / Staging Distinction:**
  - Native MongoDB persistence tests (`hardPurgeSession`, `$max` watermark CAS, partial ephemeral sweep index, `mutation-journal` local crash recovery compatibility) require operator-supplied `AURVIN_TEST_MONGODB_URI` + `AURVIN_TEST_DB_PREFIX=aurvin_p2_test_`; report skips explicitly if absent.
  - Real OpenRouter LLM formatting/caveman compression calls are **out of routine deterministic scope** and require explicit authorization.

---

## 3. Risks & Limitations
1. **Uncommitted Working Tree Overlap:**
   - `backend/src/app.service.ts` (uncommitted `speechSockets(signal)` diff around lines 1141–1252).
   - `backend/src/contracts/voice-wire.ts` & `frontend/src/api/voice-protocol.ts` (uncommitted extraction of `VoiceLimits` into untracked `voice-limits.ts`).
   - Uninvolved uncommitted changes: `frontend/src/api/weather-protocol.ts`, `frontend/src/api/testing/voice-fixtures.test.ts`, `frontend/src/features/voice/audio/*`, `docs/user-memory-context/state.md`.
   - Workers (P1, P4, P6) must merge cleanly atop these edits without reverting them; orchestrator/workers must stage **named files explicitly** (never `git add .`).
2. **Compaction Context Loss on Long-Lived Passive Idle Queue:**
   - Because `MemoryWriterService` extraction runs asynchronously after a turn, server shutdown before the 10-minute idle timer fires drops an unsaved idle batch unless `session.memoryWatermarkSequence` remains lower than `session.lastSequence` — next session turn or startup recovery can naturally catch up on >= 8 turns or next idle period because `memoryWatermarkSequence` is only advanced *after* successful CAS persistence.
3. **Browser Unload Purge Reliability:**
   - `fetch(..., { keepalive: true })` on `pagehide` handles normal tab close/navigation, while OS crashes/network drops are covered by the 24h ephemeral orphan sweep.
4. **Live Voice Temporary Chat:**
   - If the UI allows initiating Live Voice inside a Temporary Chat, `CreateVoiceSessionRequest` and `VoiceSessionService` must propagate `ephemeral: true` so voice turns neither leak pinned memory nor retain transcripts beyond purge.

---

## 4. DAG Reconciliation (`docs/user-memory-context/state.md`)

Review of P1–P6 against actual codebase imports identified missing files, two ownership moves to prevent P2/P3 merge conflicts, and one field relocation. **Updated ownership & sequencing:**

- **P1 (Contracts, Limits, Config Schema, Budget/Floor, Mutation Journal):**
  - *Keep:* `backend/src/contracts/{collections,agent-memory,session,message,metadata,stream,api,admin-config,admin-config-wire,voice-wire,index}.ts`, `backend/src/contracts/user-memory.ts` (new), `backend/src/contracts/environment-tools.ts`, `backend/src/platform/config/manageable-config.ts`, `backend/src/context/{context-budget,prefix-estimate}.ts`.
  - *Add:*
    - `backend/src/contracts/config-runtime.ts` (`memoryModelId` on `RuntimeConfigSnapshot`)
    - `backend/src/contracts/repositories.ts` (repository port interfaces for `UserMemoryRepository` / `Sessions` purge & watermark)
    - `backend/src/contracts/calendar-tools.ts` & `backend/src/contracts/calendar-model.ts` (`'update_user_memory'` local tool union)
    - `backend/src/model/catalogue.ts` (`evaluateCompactionModel` / memory model compatibility helper if needed)
    - `backend/src/persistence/mutation-journal.ts` (add `'user_memory'` collection + `deleteMany`/`deleteOne` mutation counts)
  - *Schema Adjustment:* Place `memoryWatermarkSequence?: number` on `SessionRecord` (`contracts/session.ts`), **NOT** on `AgentMemoryManifest` (`contracts/agent-memory.ts`). Fold worst-case `userMemoryMessage` into `ChatFloor.breakdown.personalization` and tool def into `WORST_CASE_TOOLS`.
  - *Overlap Note:* Preserve uncommitted `voice-limits.ts` re-exports in `backend/src/contracts/voice-wire.ts`.

- **P2 (User Memory Persistence, Service, MemoryWriterService, Admin Config, Personalization HTTP):**
  - *Keep:* `backend/src/persistence/{user-memory.ts (new),personalization.ts}`, `backend/src/personalization/{personalization.service.ts,personalization.controller.ts,personalization.module.ts}`, `backend/src/personalization/{user-memory.service.ts,memory-writer.service.ts,memory-scheduler.service.ts (new)}`, `backend/src/admin-config/admin-config.service.ts`.
  - *Add:*
    - `backend/src/personalization/configure-personalization-http.ts` (add `/api/personalization/memory*` exact routes)
    - `backend/src/personalization/errors.ts` (error code catalog if needed for memory routes)
    - `backend/src/persistence/metadata.ts` (line 388: exempt `value.purpose === 'memory'` from attempt-link check alongside `'compaction'`)
  - *Remove:* `backend/src/persistence/indexes.ts` (not needed for `_id`-keyed `user_memory`; moved to P3).

- **P3 (Context Assembler, Session Purge, Orphan Sweep Index, Prompt Updates):**
  - *Keep:* `backend/src/persistence/{sessions,messages,memory,checkpoints}.ts`, `backend/src/context/{referenced-context-assembler,compaction-prompt}.ts`, `backend/src/instructions/system.md`.
  - *Add:*
    - `backend/src/persistence/indexes.ts` (compound index for 24h `ephemeral` orphan sweep on `sessions`)
    - `backend/src/context/reference-selection.ts` (preserve `pinnedUserMemory` in `buildReferenceManifest`)
  - *Remove:* `backend/src/persistence/persistence.ts` -> **Move to P4** so P2 and P3 do not collide editing `createPersistenceBundle`; P4 depends on both P2 and P3 and wires P2 (`MongoUserMemoryRepository`) + P3 (`MongoSessions` methods) together cleanly.

- **P4 (Runtime Pinning, Compaction Refresh, Explicit Tool Loop, Voice, HTTP, AppService Wiring):**
  - *Keep:* `backend/src/chat-runtime/{durable-chat-runtime,memory-text,finalization,ports}.ts`, `backend/src/voice/agent/agent-voice-adapter.ts`, `backend/src/model/web-native.ts`, `backend/src/http/{chat-http.controller,chat-http.service,chat-stream.transport}.ts`, `backend/src/{app.service,app.module,main}.ts`.
  - *Add:*
    - `backend/src/persistence/persistence.ts` (moved from P3: wire `userMemory` repo into `PersistenceBundle` & shutdown cleanup)
    - `backend/src/chat-runtime/{memory-first-foundation,reconciliation}.ts` and `backend/src/persistence/memory-text-archive.ts` (preserve `pinnedUserMemory` across eviction, compaction, archive, and recovery)
    - `backend/src/model/{calendar-policy,calendar-adapter,calendar-validation,calendar-repair}.ts`, `backend/src/chat-runtime/calendar-loop.ts`, `backend/src/context/calendar-context.ts` (support optional `update_user_memory` alongside `get_environment` in Calendar tool loops)
    - `backend/src/voice/session/voice-session.service.ts` (propagate `ephemeral` on live voice sessions)
    - `backend/src/http/validation.ts` (if `ephemeral` validation lives in `http/validation.ts`)
  - *Overlap Note:* Preserve uncommitted `speechSockets(signal)` diff in `backend/src/app.service.ts`.

- **P5 (Frontend Personalization MemoryCard & Super Admin Memory Model Config):**
  - *Depends on:* P1 (can run in parallel with P2–P4 once contracts/protocol targets are fixed; verify final API parity after P2).
  - *Keep:* `frontend/src/api/{protocol,client,admin-config-protocol}.ts`, `frontend/src/features/personalization/{PersonalizationPanel.tsx,MemoryCard.tsx (new)}`, `frontend/src/features/admin-config/{AdminDashboard.tsx,config-edit-state.ts}`.
  - *Add:* `frontend/src/features/admin-config/ConfigFields.tsx` (renders `"Memory writer model"` mode radio + `ModelCombobox` matching `compaction.customModelId`).
  - *Remove:* `frontend/src/features/admin-config/ModelSelectionFields.tsx` (only handles main `openRouter.modelId`, already exports `ModelCombobox`).

- **P6 (Frontend Temporary Chat, Memory Updated Pill, Unload Purge):**
  - *Depends on:* P5 (shares `frontend/src/api/protocol.ts` and `client.ts`) and P4 (for integration/parity verification).
  - *Keep:* `frontend/src/features/chat/{ChatView.tsx,state/chat-types.ts,state/chat-reducer.ts,state/use-chat.ts}`.
  - *Add:*
    - `frontend/src/components/{MessageItem.tsx,Transcript.tsx}` (render clickable `✓ Memory updated` pill on assistant messages)
    - `frontend/src/App.tsx` (pass navigation callback from `ChatView` pill to open Admin -> Personalization -> `MemoryCard`)
    - `frontend/src/api/voice-protocol.ts` (preserve uncommitted `voice-limits.ts` imports; add `ephemeral?: boolean` on `CreateVoiceSessionRequest`)
    - `frontend/src/features/voice/state/useLiveVoice.ts` (pass active `ephemeral` flag when starting Live Voice inside a Temporary Chat)
