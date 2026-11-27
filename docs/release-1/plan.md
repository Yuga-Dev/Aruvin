# Release 1 plan: Modern conversation

**Status:** Decisions accepted 27 November 2026 (section 9). Unit 0 starts after the Task mode Phase A branch merges (section 3). **Branch:** planning merged from `codex/release-1-plan`. **Based on:** main `5ec75ee`, after Release 0 ([release-0](../releases/release-0.md)).

Work order follows [release-plan.md](../roadmap/release-plan.md): contracts, backend, database and indexes, API and events, frontend, states, security, tests, docs, verification. Capabilities stay behind `frontend/src/app/feature-flags.ts` until release verification passes. Current status of everything else is in [feature-status.md](../roadmap/feature-status.md).

## 1. Scope and non-goals

In scope: conversation search, edit and regenerate, feedback, Markdown export, message rendering polish. Streaming, cancel, retry, retry-save, recovery and the memory-first admission path keep working unchanged.

Non-goals (each deferred on purpose):

- Branching or navigating alternate conversation trees. Edit and regenerate apply to the **latest turn only** (the rule retry already has: `session.latestTurnId === turnId`). Editing older turns is a later release.
- Semantic or embedding search, cross-session retrieval for the model, fuzzy or substring search.
- Searching voice transcripts, Canvas artifacts, tool payloads, or temporary (ephemeral) chats.
- Server-side PDF/DOCX export (Release 7). Export is Markdown only.
- Using feedback to change model behaviour, analytics dashboards, or sending feedback to OpenRouter.
- Any new infrastructure, model picker, or authentication change.

## 2. What exists today (traced)

| Area | Reality | Consequence |
| --- | --- | --- |
| Messages | `MongoMessages` (`backend/src/persistence/messages.ts`) is insert-only (`appendConfirmed`, `scope_message` index). `MessageRecord` in `contracts/message.ts` is strict; the UI shape is `visibleMessageSchema`, a `pick` in `contracts/api.ts`. | History must not be rewritten. Edits and regenerations are new records that point at what they replace. |
| Sessions | `MongoSessions` (`persistence/sessions.ts`); soft delete via `lifecycle`; `ephemeral` chats exist; the list merges in-memory sessions through `runtime.overlaySessions`. Title is 1-80 chars. | Title search must overlay unsaved in-memory sessions and respect `lifecycle` and `ephemeral`. |
| Memory-first | Text chats run from server memory (`chat-runtime/memory-text.ts`); one consolidated async write persists the turn. | Message text is searchable only after it is saved. No new pre-model database read or write is allowed (AGENTS.md). Search, feedback and export are not on the model path, so they may read the database. |
| Retry | `POST /sessions/:id/turns/:turnId/retry` (`http/chat-http.controller.ts`, `chat-http.service.ts retry`) calls `runtime.retryTurn`, which has **two** implementations: `MemoryText.retry` and `DurableChatRuntime.acceptRetry`. Allowed only for the latest turn, only after `failed`, `cancelled` or `interrupted`, max 3 attempts. The new attempt keeps `causal.userMessageId` and sets `causal.previousAttemptId`. | Regenerate is a relaxed retry (completed turns allowed). Edit is a new turn. Both implementations must change. |
| Attempt output | The assistant message id is derived from the attempt id (`key('output', ...)`), so each attempt already produces its own assistant message. | Old assistant messages already survive a regenerate; only the transcript needs to hide them. |
| Context | `chat-runtime/history.ts acceptedHistory` selects accepted users and completed assistants; `checkBoundary` rebuilds the manifest (`buildReferenceManifest`) and rebases when it differs. Compaction records `compactedThroughSequence`. | Superseded messages must be excluded here, and an edit that reaches into compacted history must be refused. |
| Idempotency | `submitTurnRequestSchema` and `retryTurnRequestSchema` (`contracts/api.ts`) carry `idempotencyKey` and `expectedEpoch`; one active attempt per session via `executionReservations` and the owner lease. | Edit and regenerate reuse the same envelope and guards. |
| Frontend chat | `features/chat/state/use-chat.ts` (`retryTurn`, `retrySave`), `chat-reducer.ts`, `components/MessageItem.tsx` (Retry button on failed/interrupted, `CopyMessageButton`), `components/Transcript.tsx`. | New actions sit next to Copy and Retry. |
| Sidebar and palette | `components/Sidebar.tsx` shows the session list from reducer state; `components/command-palette.ts` filters only loaded titles. `api/client.ts` is the single HTTP client; wire validation is in `api/protocol.ts`. | Search is a server call from a new Sidebar field and the palette. |
| Markdown | `features/chat/markdown/parse-markdown.ts` and `safe-markdown.tsx` (zero dependency, no HTML injection). Tables, nested lists and math already render (feature-status.md says otherwise; correct it in docs). Not present: horizontal rule, strikethrough, task-list checkboxes, code-block copy button and language label. | The polish list in 6.5 is small and local. |
| Indexes | `persistence/indexes.ts` `APP_INDEXES` through `setupIndexes`, all non-unique compound. AGENTS.md requires Azure/Cosmos verification before admission. | A text index is the first non-compound index; see D1 and D3. |

## 3. Overlap risks with concurrent work

Two other agents are changing Task mode (`task-*` files, MemoryText, `TaskCard.tsx`) and fixing failing backend tests. This plan does not depend on unmerged work, but these collisions are likely:

- `backend/src/chat-runtime/memory-text.ts` (unit B) is the highest risk: Task mode edits the same turn flow. **Start unit B only after the Task-mode branch merges, or rebase on it first.**
- `frontend/src/components/MessageItem.tsx`, `Transcript.tsx`, `features/chat/state/chat-reducer.ts` and `use-chat.ts` (units B and C) are shared with Task mode UI. Rebase before starting and keep edits additive.
- `contracts/api.ts` and `contracts/message.ts` already gained a `task` field; Unit 0 must be rebased on it.
- Failing backend suites (`launcher`, `compaction-runtime`, `session-affinity`, calendar suites, see feature-status.md) can mask regressions in the retry and context code this release touches. Record the baseline failure list before starting and compare afterwards.

## 4. Representing edits and regenerations without rewriting history

One rule: **records are never modified or deleted; a newer record names the one it replaces.**

- **Regenerate** (latest turn, any terminal state including `completed` and `truncated`): a new attempt on the same turn and the same user message, with `causal.previousAttemptId` set to the prior attempt (existing linkage). It produces a new assistant message (id derived from the new attempt) whose record carries `supersedes: <previous assistant messageId>`.
- **Edit** (latest user turn only): a new turn with a new user message whose `supersedes` is the original user message id. The original user message, its attempts and its assistant replies stay in the archive. The new attempt records `causal.revision = { kind: 'edit', ofTurnId }`.
- Both are also recorded on the attempt (`causal.revision: { kind: 'edit' | 'regenerate', ofTurnId, ofAttemptId }`, bounded and optional) for accounting and reconciliation.
- **Transcript:** `visibleMessageSchema` gains `supersedes?`. The reducer hides any message whose id appears in a loaded message's `supersedes`, and shows "Version 2 of 3" with previous and next controls that walk the chain (bounded to 5 versions per turn). Nothing is hidden server-side, so older pages need no recomputation (a superseder is always newer than what it replaces).
- **Model context:** `acceptedHistory` drops superseded messages and, for an edit, every message of the replaced turn (user message and all attempt outputs). The manifest is rebuilt through the existing `checkBoundary` rebase (new `contextVersion`), not through a second code path.
- **Compaction guard:** if the target turn's sequence is `<= compactedThroughSequence`, edit and regenerate fail with `REVISION_TOO_OLD`, because the summary already contains it. No silent history loss.
- **Checkpointer:** LangGraph checkpoints may hold the replaced turn's messages. Unit B starts with a spike (B0) proving the graph input uses application-selected history only, as retry does (it removes the current input "by turn ID"). If not, the fix is a rebase marker (the existing `rebase` channel in `agent/state.ts`), never deleting checkpoints.
- **One active attempt:** edit and regenerate pass through the same `executionReservations.assertText`, owner lease and `CONFLICT_ACTIVE_TURN` checks as submit and retry. While a generation is active both are rejected, and the UI disables them.
- **Attempt budget:** regenerate shares the per-turn attempt cap (D5).

## 5. Contracts (Unit 0, one owner)

All in `backend/src/contracts/`, with mirrors in `frontend/src/api/protocol.ts`.

- `message.ts`: `supersedes: idSchema.optional()` on `messageRecordObjectSchema`; refinement: an assistant message supersedes an assistant message of the same turn, a user message a user message, never itself. Add to the `visibleMessageSchema` pick in `api.ts`.
- `attempt.ts`: optional `causal.revision`.
- `api.ts`: routes `API_ROUTES.searchSessions` (`/sessions/search`), `editTurn`, `regenerateTurn`, `messageFeedback`, `exportSession`; schemas `searchSessionsQuerySchema`, `searchSessionsResponseSchema`, `editTurnRequestSchema` (`content`, `idempotencyKey`, `expectedEpoch`, `calendarProtocol`; strict; same size bound as submit), `regenerateTurnRequestSchema` (same as retry), `feedbackRequestSchema`, `feedbackResponseSchema`; `visibleMessageSchema` gains `feedback?: 'up' | 'down'` (the caller's own rating only).
- New error codes in `errors.ts`: `REVISION_TOO_OLD`, `REVISION_NOT_LATEST`, `MESSAGE_NOT_SAVED`, `SEARCH_UNAVAILABLE`.
- Bump `CONTRACT_VERSIONS.api` per existing practice and extend `api.spec.ts`.
- Edit and regenerate responses reuse `submitTurnResponseSchema`, so the existing SSE stream and recovery logic apply unchanged. Identity is never in a body: `parseBody` plus `assertNoClientOverrides` already reject it.

## 6. Features

### 6.1 Conversation search

**Behavior.** A search field in the sidebar and in the Ctrl/Cmd+K palette. Typing (debounced 250 ms, minimum 2 characters) shows matching chats: title matches first, then message-text matches with a short snippet. Selecting one opens the chat (at the matched message when it is within the loaded page, otherwise at the latest page).

**API.** `GET /api/sessions/search?q=&cursor=&limit=` returns `{ items: [{ sessionId, title, lastActivityAt, match: 'title' | 'message', snippet?, messageId? }], nextCursor, degraded? }`. `q` max 100 chars, `limit` max 20 (default 10), keyset cursor via `persistence/pagination.ts`. The user id comes only from the server identity. The route must be declared before `:sessionId` in the controller so `search` is not read as an id.

**Backend.** New `persistence/search.ts` (`MongoSearch`), wired like other repositories; the HTTP layer is a new `http/search-http.*` pair so it does not collide with `chat-http.service.ts`.

- Titles: case-insensitive, regex-escaped match over the user's active, non-ephemeral sessions through `user_lifecycle_pin_activity_session`, plus in-memory titles through `runtime.overlaySessions` so a just-created chat is findable.
- Text: `$text` query on `messages`, always with `userId` equality (compound text-index prefix), `visibility != 'internal'` and a terminal visible `completionStatus`; then one bounded `sessions` lookup (`$in` of at most `limit * 3` ids) to drop deleted, ephemeral and non-active chats. Group by session, best score per session. Hard caps: 3 s `maxTimeMS`, at most 100 candidate messages scanned per page.
- Memory-first limit: a message is searchable only after its consolidated save. The UI empty state says so.

**Indexes.** In `indexes.ts`, `messages`: `{ userId: 1, content: 'text' }`, name `user_content_text`, `default_language: 'none'` (no stemming surprises across languages). A partial filter excluding `visibility: 'internal'` is used only if the target service supports it (verify); otherwise the filter is applied at query time. MongoDB allows one text index per collection, so this one is reserved for search.

**Migration and rollback.** The index is built by `setupIndexes` at startup. On a large existing `messages` collection the build takes time and disk. There is no data migration; existing messages are indexed automatically. Procedure: build on a staging copy first and record build time and index size in `docs/release-1/search-index-migration.md`; roll back with `dropIndex('user_content_text')`. After rollback, or if the index is missing at runtime (for example an unadmitted Azure profile), the endpoint returns title results with `degraded: true` and the UI shows a one-line notice. No data changes, so rollback is index-only.

**Frontend.** `Sidebar.tsx` search input (an empty field restores the normal list); `CommandPalette.tsx` and `command-palette.ts` gain a "Search messages" group fed by the same client call; `api/client.ts searchSessions`; stale-response guard (ignore results of an older query) and abort on a new keystroke.

**States.** Loading: skeleton rows. Empty: "No chats match" plus the saved-messages hint. Error: inline "Search is unavailable. Try again." with retry. Degraded: title-only notice. 401 and offline follow existing client error handling.

**Security.** User resolved server-side; query escaped before regex; the `$text` string is never concatenated into operators; snippets render as plain text (no HTML); other users' data is excluded by construction (index prefix plus filter); the per-user request limiter applies.

### 6.2 Edit and regenerate

**Behavior.** Regenerate: a button on the last assistant message when no generation is active; the new answer replaces the visible one, with "Version n of m" arrows to view earlier ones. Edit: a pencil on the last user message opens an inline editor; Save sends a new turn; Cancel restores. While generating both are disabled and Stop works as today. Live voice messages and Canvas-only messages show neither.

**API.** `POST /sessions/:sessionId/turns/:turnId/regenerate` and `POST /sessions/:sessionId/turns/:turnId/edit`, both 202 with `SubmitTurnResponse`, then the existing stream path. Idempotent by `idempotencyKey` (same key and payload returns the same attempt; a different payload is `IDEMPOTENCY_PAYLOAD_MISMATCH`). New handlers live in `http/revision-http.*` and delegate to `runtime.revise(...)`.

**Backend.** `chat-runtime`: one shared `revise` entry used by `MemoryText.retry` and `DurableChatRuntime.acceptRetry` logic; do not fork a third path. Guards in order: epoch, latest turn only (`REVISION_NOT_LATEST`), compaction guard (`REVISION_TOO_OLD`), no active attempt, attempt cap, input bounds (`inputBounds` and `validateInput`), unchanged content on edit rejected as a no-op. `history.ts acceptedHistory` and the in-memory history in `memory-text.ts` exclude superseded records. No new database read or write before dispatch: the memory-first path persists the new user message, attempt (with `causal.revision`) and assistant message in the usual single consolidated post-response write; the durable fallback keeps its existing pre-effect markers.

**Persistence.** No new collection and no new index (supersession is resolved client-side from the loaded page). Only `messages.supersedes` and `attempts.causal.revision` are added. Record size bounds are unchanged.

**Frontend.** `use-chat.ts` adds `regenerateTurn` and `editTurn` beside `retryTurn` (same recovery storage, `submission-recovery` and idempotency-key creation); `chat-reducer.ts` adds hide-superseded and version-chain selectors; `MessageItem.tsx` receives handlers through slot props (Unit C owns the file); the editor is a small new `MessageEditor.tsx`.

**States.** Editing (textarea, counter against `maxInputChars`, Save disabled when empty or unchanged); submitting; failure shows the standard retry badge on the new turn; `REVISION_TOO_OLD` shows "This message is part of a summarised earlier conversation and can't be edited."; a stale epoch uses the existing interrupted copy.

**Security.** Identity server-resolved; owner's latest turn only; content passes the same limits and secret-rejection path as submit; no reasoning is stored or returned; superseded records stay in the user's own archive and out of model context; export includes only the visible version (6.4).

### 6.3 Feedback

**Behavior.** Thumbs up and down under each completed assistant message; pressing again clears. Free-text reasons are deferred (D6). Feedback does not change the answer.

**API.** `PUT /sessions/:sessionId/messages/:messageId/feedback`, body `{ rating: 'up' | 'down' | null }` (null clears), returns `{ messageId, rating }`. `visibleMessage.feedback` returns the caller's own rating on list reads.

**Backend and persistence.** New `persistence/feedback.ts` writing one bounded `metadata` document per message: `kind: 'message-feedback'`, `userId`, `sessionId`, `messageId`, `turnId`, `attemptId`, `rating`, `updatedAt`, `schemaVersion`; upsert keyed `key('feedback', userId, sessionId, messageId)` through `RecordStore` (schema-validated, no content copy). New index on `metadata`: `{ userId: 1, sessionId: 1, kind: 1, messageId: 1 }`, name `scope_kind_message`. The list read fetches ratings for the page's message ids in one `$in` query (at most page size); a failing feedback read must not fail the message list (omit the field, log without payload). Validation: the message exists, belongs to the caller, is an assistant message in a terminal visible state, and is durable. If it is not saved yet, the call returns `MESSAGE_NOT_SAVED` and the UI keeps the buttons disabled until the save state is saved. Session delete and `hardPurgeSession` remove `metadata` by session scope; a test must prove feedback is included. Feedback never touches memory-first admission.

**Frontend.** `FeedbackButtons.tsx` (new) in the `MessageItem` action row; optimistic update with rollback on error; `api/client.ts putFeedback`; reducer field `feedback` per message.

**States.** Disabled until saved (tooltip "Saving..."), pending, error toast "Couldn't save your feedback", cleared. Keyboard accessible with `aria-pressed`.

**Security.** Strict enum body, `pathId` validation, owner-scoped upsert, per-user rate limit, no free text in this release (no PII or injection surface).

### 6.4 Markdown export

**Behavior.** "Export as Markdown" in the chat header menu downloads `<title-slug>-<date>.md` with the title, export date, then `## You` and `## Aurvin` sections in order. Superseded versions and failed or cancelled partials are omitted; truncated answers are marked `(truncated)`. Canvas artifacts, Task plans and web sources appear as short references (title and URL only); calendar and voice content is exported as the text already shown in the transcript. Temporary chats cannot be exported.

**API.** `GET /sessions/:sessionId/export.md`, `Content-Type: text/markdown; charset=utf-8`, `Content-Disposition: attachment` with a sanitised filename. New `http/export-http.*` pair.

**Backend.** A pure function `exportMarkdown(session, messages)` in `http/export-markdown.ts` (unit-testable) plus paged reads through `MessageRepository.list` (page size `maxPageSize`), capped at 2000 messages or 2 MB with a visible truncation note. Unsaved in-memory messages come through `runtime.memoryMessages`, as the messages route does. A code fence inside content gets a longer outer fence. Filename: ASCII slug, at most 60 chars.

**Frontend.** Menu item calls the client and saves through a Blob and anchor download (no new dependency).

**States.** Loading (button spinner), error ("Export failed. Try again."), empty chat (item disabled), too large (download proceeds with the truncation note).

**Security.** Owner-scoped; ephemeral chats refused (`NOT_FOUND`); no reasoning; no internal or Canvas bodies; filename and header injection prevented by a slug whitelist; no credentials or internal ids exposed.

### 6.5 Message rendering polish

Local to `features/chat/markdown/` and `styles/chat.css`; no contract change. Confirm each item against the renderer before starting:

- Code blocks: language label, copy button (reuse `copyTextToClipboard` and the `CopyMessageButton` pattern), horizontal scroll, no layout jump while streaming.
- Horizontal rule, strikethrough, read-only task-list checkboxes.
- Tables: horizontal scroll container on narrow widths; long URLs wrap.
- Streaming: no flicker when a table or list closes (extend `stream-render-boundary.test.ts`).
- Light and dark contrast checked against the Release 0 tokens.

States: an unterminated fence or malformed table stays safe plain text. Security: still no raw HTML, `sanitize-url.ts` governs links, task checkboxes are inert.

## 7. Task breakdown

Unit 0 merges first (serial, small). Units A, B and C then run in parallel with disjoint files, so up to three agents can work at once. Central wiring stays with Unit 0, as AGENTS.md requires. Unit 9 runs last.

| Unit | Scope | Owns (files) | Depends on |
| --- | --- | --- | --- |
| **0. Contracts and wiring** | Section 5 contracts and protocol mirrors; error codes; empty route stubs (`search-http`, `revision-http`, `feedback-http`, `export-http`) registered in the HTTP module and options; no-op repository wiring in `app.service.ts`; four feature flags (`conversationSearch`, `messageEdit`, `feedback`, `exportMarkdown`, all false); `MessageItem` action-slot props; pre-declared `api/client.ts` method stubs; empty `SEARCH_INDEXES` and `FEEDBACK_INDEXES` arrays iterated by `setupIndexes` | `backend/src/contracts/{api,message,attempt,errors,versions}.ts` and touched `contracts/*.spec.ts`; `backend/src/http/{chat-http.module,options,index}.ts` and the four `*-http` stubs; `backend/src/app.service.ts`; `backend/src/persistence/indexes.ts` (array scaffolding only); `frontend/src/api/{protocol,client}.ts`; `frontend/src/app/feature-flags.ts` | Task-mode merge; baseline failing-test list. **Done 27 Nov 2026** (commit recorded below) |
| **A. Search** | `persistence/search.ts`, title and text queries, text index and migration note, `search-http` body, client method body, Sidebar search, palette group | `persistence/search.ts` (+ spec), the `SEARCH_INDEXES` entries, `http/search-http.*`, `docs/release-1/search-index-migration.md`, `frontend/src/components/{Sidebar,CommandPalette}.tsx`, `command-palette.ts`, `frontend/src/features/search/**` (new) | 0 |
| **B. Edit and regenerate** | B0 checkpointer spike; `revise` in both runtimes; history exclusion; `causal.revision`; `revision-http` body; `use-chat`; reducer; `MessageEditor`; version arrows | `chat-runtime/{memory-text,durable-chat-runtime,history,ports}.ts`, `http/revision-http.*`, `frontend/src/features/chat/state/{use-chat,chat-reducer,chat-types}.ts`, `frontend/src/components/MessageEditor.tsx`, `frontend/src/features/chat/integration-tests/revision*.test.ts` | 0; Task-mode merge |
| **C. Feedback, export, rendering** | `persistence/feedback.ts` and index; `feedback-http` and `export-http` bodies; `export-markdown.ts`; FeedbackButtons; export menu item; `MessageItem` action row; Markdown polish | `persistence/feedback.ts` (+ spec), the `FEEDBACK_INDEXES` entries, `http/{feedback-http,export-http,export-markdown}.*`, `frontend/src/components/{MessageItem,Transcript,FeedbackButtons}.tsx`, `frontend/src/features/chat/markdown/**`, `frontend/src/styles/chat.css`, header menu part of `frontend/src/features/chat/ChatView.tsx` | 0 |
| **9. Integration and docs** (serial) | Cross-feature integration tests, `feature-status.md` and `docs/releases/release-1.md`, flag flip after verification | `docs/**`, `frontend/src/features/chat/integration-tests/` | A, B, C |

**Unit 0 status (done, 27 November 2026, branch `codex/release-1-unit-0`, commits 7171eca (backend), plus the frontend commit that follows it).** Implemented sections 5 and 7 as scaffolding only: contracts (`supersedes`, `causal.revision`, feedback, edit, regenerate and search schemas, routes), four error codes, four inert route stubs plus fail-closed ports (`http/noop-ports.ts`, spread in `httpOptions`), empty `SEARCH_INDEXES` and `FEEDBACK_INDEXES`, four flags (all false), frontend protocol mirrors, inert `api/client.ts` stubs (`NOT_IMPLEMENTED`) and `MessageItem` `actionsStart`/`actionsEnd` slots. Deviations: `CONTRACT_VERSIONS.api` stays 1 (all changes are additive and optional, as earlier additions were); the cross-record `supersedes` rule is a helper `isValidSupersession` in `contracts/message.ts` because one record cannot see its target, with a self-reference refinement on the record. Checks: see the unit 0 report in the merge commit message; review skipped. Native MongoDB and live checks not run.

Conflict rules: `indexes.ts` is shared only through the two arrays Unit 0 creates; `api/client.ts` through the method stubs Unit 0 pre-declares; `MessageItem.tsx` belongs to C and B plugs in through the slot props. Any needed change outside a unit's owned files goes back to Unit 0's owner.

## 8. Required tests (exact proposed names)

Backend (Vitest `*.spec.ts` under `backend/src`):

- `search.spec.ts`: `searches titles case-insensitively with regex characters escaped`; `title search includes an unsaved in-memory session`; `text search is scoped to the caller userId`; `text search never returns internal, ephemeral, deleted or non-active chats`; `search pages with a keyset cursor and caps limit at 20`; `search degrades to title-only when the text index is missing`; `search query over 100 characters is rejected`.
- `indexes` suite: `creates the messages text index once and idempotently`.
- `revision.spec.ts`: `regenerate creates a new attempt linked to the previous attempt on the same user message`; `regenerate of a completed turn marks the new assistant message as superseding the old one`; `edit creates a new turn whose user message supersedes the original`; `edit and regenerate are idempotent by key and mismatch on different payload`; `edit is rejected unless it targets the latest turn`; `revision is rejected when the turn is inside the compacted range`; `revision is rejected while another attempt is active in the session`; `competing tabs keep one active revision attempt and one model effect`; `context for the next turn excludes superseded messages and the replaced turn`; `superseded records remain in the archive and are never modified`; `revision persists once in the consolidated memory-first write and reads no database before dispatch`; `revision respects the per-turn attempt cap`; `revision input is bounded and rejects secrets like submit`.
- `feedback.spec.ts`: `stores one feedback document per message and upserts changes`; `clearing feedback removes the rating`; `rejects feedback for another user's message`; `rejects feedback for a message that is not saved yet`; `rejects feedback on a user or non-terminal message`; `session delete removes feedback documents`; `message list survives a feedback read failure`.
- `export-markdown.spec.ts`: `exports visible messages in order with superseded versions omitted`; `marks truncated answers and omits failed partials`; `keeps code fences intact with a longer outer fence`; `caps size and appends a truncation note`; `sanitises the download filename`; `refuses temporary chats`.
- `contracts/api.spec.ts`: `edit, regenerate, feedback and search schemas are strict and bounded`; `supersedes cannot reference itself or cross roles`.
- Existing and must keep passing: retry suites, `competing text tabs keep one active attempt and one model effect`, streaming terminal-state suites, and the AGENTS.md tool-path checks if `memory-text.ts` is touched.
- Native MongoDB (needs operator-supplied `AURVIN_TEST_MONGODB_URI`; skips reported separately): `text index query returns ranked results scoped by user`; `index build is idempotent on an existing messages collection`.

Frontend (`src/**/*.test.ts`, Node environment):

- `search-client.test.ts`: `ignores a stale search response`; `debounces and aborts the previous request`; `shows title-only notice when degraded`.
- `command-palette.test.ts` addition: `palette adds a message-search group without breaking local filtering`.
- `chat-reducer.test.ts` additions: `hides messages that a later message supersedes`; `exposes the version chain for a superseded message`; `older page load keeps hidden state consistent`.
- `revision-chat-state.test.ts`: `regenerate sends a new idempotency key and streams like a submit`; `edit is disabled while a generation is active`; `edit save is disabled for empty or unchanged text`; `revision too old shows the summarised-conversation notice`; `a stale epoch after refresh uses the interrupted recovery`.
- `FeedbackButtons.test.ts`: `optimistic rating rolls back on error`; `buttons are disabled until the message is saved`; `exposes aria-pressed`.
- `export-download.test.ts`: `builds a safe filename and triggers a Blob download`; `shows an error without downloading on failure`.
- `markdown.test.ts` additions: `renders horizontal rules and strikethrough`; `renders task lists as inert checkboxes`; `code block has a language label and copy button`; `unterminated fence stays safe while streaming`; `raw HTML is still escaped`.
- `MessageItem.test.ts` additions: `shows edit, regenerate and feedback only for eligible messages`; `hides all three for live voice messages`.
- Integration (Unit 9): `regenerate then export shows only the latest version`; `search result opens the matching chat`.

## 9. Decisions

**Accepted 27 November 2026:** the user accepted every recommendation below (D1–D8) as written. Implementation follows them.

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | **Per-user text index and search limits.** MongoDB has one text index per collection, not per user, so "limits" means index growth, scan cost and abuse. | (a) One text index `{userId, content}`, all roles, per-request caps (limit 20, 3 s, 100 candidates) and the shared rate limiter. (b) Index user messages only; smaller but misses answers. (c) No index: bounded regex scan per user; works anywhere, slow for large users. (d) External search service. | (a) with `default_language: 'none'`, and (c) only as the automatic title fallback. Record index size per million messages in the migration note. |
| D2 | **Edit scope.** | Latest turn only; any turn with branches. | Latest turn only for Release 1. Branching is a larger context and UX change. |
| D3 | **Cosmos/Azure text-index compatibility (known blocker).** The Azure product and tier are unknown and uncertified; Cosmos DB for MongoDB may not support text indexes the same way, or at all on some tiers. | (a) Native MongoDB only for message search; an Azure profile ships title-only search via the degraded path. (b) Block the release until the Azure target is chosen and verified. (c) Use Cosmos-native search once the product is known. | (a). Do not admit an Azure profile until text-index support is verified with primary documentation and an isolated service test (AGENTS.md R1 rule). |
| D4 | **Search before save.** Memory-first means the newest messages are unsearchable until saved. | Accept; or also scan in-memory sessions on the server. | Accept and say so in the empty state; titles are overlaid so new chats are still found. |
| D5 | **Attempt cap for regenerate.** Retry allows 3 attempts per turn today. | Keep 3 shared; raise to 5 shared; unlimited. | Shared cap of 5 for all attempts on a turn; cost stays bounded and the version chain stays within 5. |
| D6 | **Feedback detail.** | Thumbs only; thumbs plus reason tags; free-text comment. | Thumbs only. Reason tags later, once something reads them; this avoids storing user free text without a retention policy. |
| D7 | **Export location.** | Server-built (this plan); client-built from loaded pages. | Server-built: it can walk the full archive, include unsaved memory messages consistently and be tested without a browser. |
| D8 | **Search result navigation.** | Open chat only; jump to the matched message. | Open the chat; jump to the message only when it is in the loaded page. An around-cursor read is out of scope. |

## 10. Verification checklist

Record the environment and commit set as in [release-0](../releases/release-0.md).

- [ ] Baseline failing-suite list captured before Unit 0; no new failures after Unit 9.
- [ ] Backend: `npm run build`, `npm run lint`, `npm test`, `npm run test:e2e`.
- [ ] Frontend: `npm run build`, `npm run lint`, `npm test`.
- [ ] Every test in section 8 exists and passes; skips (native MongoDB) are reported separately; an exit code of zero with empty discovery is not evidence.
- [ ] Native MongoDB run of the text-index tests on a generated isolated database (`aurvin_p2_test_` prefix).
- [ ] Index migration measured on a staging-sized copy: build time, index size, search latency p95; recorded, with the rollback step exercised.
- [ ] AGENTS.md memory-first checks still pass: zero pre-model database access, one active attempt, idempotency, and crash, duplicate and cancel recovery cases that touch `memory-text.ts`.
- [ ] Streaming, cancel, retry and retry-save manual run in both themes.
- [ ] Manual checks: search (title, text, degraded), edit, regenerate with version arrows, feedback, export file opens correctly, rendering polish in light and dark, keyboard and screen-reader pass for new controls.
- [ ] Security items: identity never client-supplied; input bounds; no reasoning stored; owner scoping on search, feedback and export; ephemeral chats excluded.
- [ ] Docs: `feature-status.md` updated (including the Markdown row: tables and nested lists render), `docs/releases/release-1.md` written, migration note present, internal links check.
- [ ] Feature flags flipped only after the above; Azure text-index status stated as unverified.
- Not claimed by this release: live provider behaviour, Azure compatibility, wall-clock performance, production readiness.
