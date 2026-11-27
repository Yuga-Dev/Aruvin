# Release 5 plan: Projects and memory

**Status:** Planned, awaiting user decisions (section 10). **Branch:** `codex/release-5-plan`. **Based on:** main `a38f1da`. Release 1 Unit 0 contracts are being implemented on another branch; this plan names every collision (section 8).

Work order follows [release-plan.md](../roadmap/release-plan.md): contracts, backend, database and indexes, API, frontend, states, security, tests, docs, verification. User-visible parts stay behind `frontend/src/app/feature-flags.ts` (`projects` and `memory`, both false today). Format precedent: [release-1 plan](../release-1/plan.md). Status of everything else: [feature-status.md](../roadmap/feature-status.md). Existing memory work: [user-memory-context](../user-memory-context/final_report.md), [user-personalization](../user-personalization/goal.md), [context-compaction-memory](../context-compaction-memory/final_report.md).

## 1. Scope and non-goals

In scope:

- **Memory inspection, editing, deletion with audit.** A Memory view where the user sees what Aurvin remembers, edits or deletes it, sees when and why it changed, and can rely on deletions reaching future context.
- **Projects.** A user-owned container with its own instructions. Chats attach to a project and receive its instructions in context. The sidebar groups chats by project.

Non-goals (each deferred on purpose):

- Project file or document uploads, knowledge bases, embeddings, retrieval (Release 4 uploads; AGENTS.md puts cross-session retrieval out of scope).
- Project-scoped learned memory, sharing or collaboration, templates, per-project model choice.
- Editing or deleting facts inside compaction summaries or old messages (stated as a limitation in the UI, section 3.4).
- Undo or content history of memory (audit keeps no content, D2).
- Admin browsing of other users' memory. Identity stays server-resolved.
- New infrastructure, authentication changes, voice-specific UI.

## 2. What exists today (traced)

| Area | Reality (file) | Consequence |
| --- | --- | --- |
| Memory contract | Five sections `identity, work, preferences, ongoing, other`; at most 2500 chars and 8000 bytes rendered; secret and control-character screening; `StoredUserMemory` with `revision` CAS (`backend/src/contracts/user-memory.ts`). Routes `GET /personalization/memory`, `PATCH .../enabled`, `POST .../edit` (natural-language instruction through the writer model), `POST .../clear` (`USER_MEMORY_ROUTES`). | No direct text edit, no per-section delete, no history. Edit goes through an LLM, so a user cannot make an exact change. |
| Memory service | `backend/src/personalization/user-memory.service.ts`: RAM cache (`records`, `pins`), coalesced `warm` at `prepareOwner` (`app.service.ts`), per-user serialized queue (8 pending, 8 queues), CAS `mutate`, one conflict recompute, `publish` updates RAM only after a confirmed write; `evict` on user deactivation. | Cache is synchronous and confirmed-only: reusable as is. Queue and CAS already give two-tab safety. |
| Memory storage | `backend/src/persistence/user-memory.ts`: `user_memory` collection, `_id = key('user-memory', userId)`, `replaceOne` on `{_id, userId, revision}`, `w:majority`, 16 KB cap. `replaceOne` keeps no previous content. | Deletion is already a true overwrite; audit must not create a content history. |
| Context pin | Memory enters context as one system block after personalization (`userMemoryMessage` in `backend/src/context/context-budget.ts`; order in `ReferencedContextAssembler.assemble`). The pin is **frozen per session** in `manifest.pinnedUserMemory` (read once in `chat-runtime/memory-text.ts` `readOriginPin`, refreshed only on compaction, ~line 868). | New chats see an edit at once. An open chat keeps the old memory, **including a deleted fact**, until compaction. This is the one real propagation gap (3.3). |
| Passive learning | `chat-runtime/user-memory-scheduler.ts` (120 s idle or 8 turns, `cancel`/`deactivate`, per-session watermark); `personalization/memory-writer.ts`; the `update_user_memory` tool. | A queued batch can re-learn a fact the user just deleted (3.4). |
| "Memory updated" pill | `memoryUpdated` on `MessageRecord`/`VisibleMessage` and the `completed` stream event; `markMemoryUpdated` in `persistence/messages.ts`. | Says an update happened, not what or when; nothing links it to history. |
| Personalization UI | `frontend/src/features/personalization/MemoryCard.tsx`, `user-memory-state.ts`; clients `frontend/src/api/user-memory-client.ts`, `user-memory-protocol.ts`. Toggle, read-only sections, composer, clear-all. | Starting point for the Memory view. The `memory` navigation entry is `destination: 'unavailable'` (`frontend/src/app/navigation.ts`). |
| Temporary chats | `ephemeral` sessions: memory off, hidden; `hardPurgeSession` (`persistence/sessions.ts`) deletes children including `metadata` by `{userId, sessionId}` except accounting. | Audit must not carry a top-level `sessionId`. Projects must refuse ephemeral chats. |
| Sessions | `sessionRecordSchema` is strict (`contracts/session.ts`), no project field. `GET /sessions`, `PATCH /sessions/:id` in `http/chat-http.controller.ts`; sidebar in `components/Sidebar.tsx`. | `projectId` is a contract change that collides with Release 1 Unit 0 (section 8). |
| Per-turn user data | Personalization is read from RAM at turn accept (`memory-text.ts` ~548, `personalizationFor`), kept in the turn entry, passed as `request.personalization` to the assembler, never in the manifest. | The right pattern for project instructions (4.3): current each turn, no manifest change, no re-pin. |
| Collections | `COLLECTIONS` (`contracts/collections.ts`) already has `user_personalization` and `user_memory` beyond the six agreed in AGENTS.md; `persistence/mutation-journal.ts` lists collections. | Precedent for a `projects` collection; update the AGENTS.md table. |
| Flags | `FEATURE_FLAGS.projects` and `.memory` exist, false. | Both areas ship dark until verification. |

## 3. Memory inspection, editing and deletion

### 3.1 What the user can see, edit and delete

| Item | See | Edit | Delete |
| --- | --- | --- | --- |
| The five memory sections | Yes, with labels, per-section and total character use, last updated | Yes: **direct text edit** per section (same validation as writer output: control characters, secrets, normalization, rendered cap) plus the existing natural-language composer | Yes: **clear one section**; clear all (existing); toggle off (existing, keeps data, stops use) |
| Change history | Yes: last 50 entries (when, source, sections touched, size change, link to the originating chat) | No | Pruned by retention (3.5); not user-deletable in this release (D1) |
| Custom instructions and tone | Already editable in the Personalization tab | Unchanged | Reset exists |
| Chats and summaries | Chats deleted from the sidebar as today | Not here | Memory deletion does **not** delete chats; the UI says so |
| Accounting | Admin-only | No | No |

Granularity is the section: stored sections are free-form telegraphic text, and splitting facts reliably would need the writer model. Fact-level delete is deferred (D3).

### 3.2 API (extends `USER_MEMORY_ROUTES`; same controller, filter, server-resolved user id)

- `PATCH /personalization/memory/sections/:key`, body `{ protocolVersion: 1, expectedRevision, requestId, text }`. `key` is validated against the five-key enum. Empty `text` clears the section. Returns `UserMemoryResponse`.
- `POST .../clear`, `POST .../edit`, `PATCH .../enabled` gain an optional `requestId`.
- `GET /personalization/memory/history?cursor=&limit=` (limit at most 50, keyset cursor via `persistence/pagination.ts`) returns `{ items: MemoryAuditView[], nextCursor }`.
- Bodies strict; identity never in a body; responses `Cache-Control: no-store` (existing filter).
- **Idempotency:** `requestId` is stored on the audit record. A retry after an unknown outcome that meets `MEMORY_CONFLICT` looks up the audit record by `requestId`; if found, it returns the current memory with 200. No record means the change did not happen.

### 3.3 Propagation to future context and caches (memory-first preserved)

- **RAM cache:** `UserMemoryService.publish` runs only after a confirmed CAS, synchronously updates `records` and `pins`, and an empty or disabled memory drops the pin. Section edit and delete reuse `mutate` and inherit this. Failed or uncertain writes never change RAM. No pre-model database read or write is added.
- **New chats and compaction refresh** read the new pin from RAM (existing).
- **Open chats (the gap):** add a **revocation fence** in `UserMemoryService`: `Map<userId, minRevision>`, set by every user-initiated change that removes or alters content (section edit, section clear, clear, disable). At turn accept (`memory-text.ts` and the durable runtime), if the session pin revision is below the fence, re-pin from RAM through the same rebase path compaction uses (`rebaseActiveTurnForCompaction` / `promoteCompaction` `refresh` argument; new `contextVersion`). Effect: the **next** turn after a user edit or delete no longer contains the old memory. The prompt cache is lost once per such edit (accepted). Passive additions do not set the fence, so the KV-safe frozen pin keeps its purpose. An in-flight turn is not interrupted; the UI says "applies from your next message".
- **Topology:** the fence is process-local like the rest of the admitted single-process design (`ponytail:` comment naming the ceiling: a second live executor would need a durable fence).
- `evict(userId)` and `clearCache()` also drop the fence.

### 3.4 Interaction with passive learning, the tool and compaction

- A user edit or delete drops that user's queued passive turns (scheduler `deactivate`-style) and advances each slot's `seen` watermark, so a queued batch cannot rewrite a just-deleted fact. Facts the user states again later can be learned again.
- Writer CAS means a passive or tool write racing a user edit either lands first (user edit gets `MEMORY_CONFLICT` and reloads) or after (it recomputes once against the user's text). User text is never silently overwritten.
- `update_user_memory` and passive writes also produce audit records (`source: 'tool' | 'passive'`). The pill's click opens the Memory view at the history entry for its `turnId`.
- **Compaction:** summaries are derived from messages, not memory, and may repeat a deleted fact. Not rewritten in this release. The delete confirmation and the Memory view footer say: "Deleting memory does not remove what you said in earlier chats." Compaction keeps reading the pin from RAM.

### 3.5 Audit record (in `metadata`)

One bounded document per accepted memory change, written **after** the memory CAS is confirmed, off the chat path (HTTP, tool and passive paths already run outside pre-model dispatch).

```text
{ _id: key('memory-audit', userId, memoryRevision), kind: 'memory-audit', schemaVersion: 1,
  userId, memoryRevision, requestId?, at,
  action: 'edit-section' | 'clear-section' | 'clear-all' | 'enable' | 'disable' | 'instruction' | 'tool' | 'passive',
  source: 'user-ui' | 'composer' | 'tool' | 'passive',
  sections: touched keys (at most 5),
  charsBefore, charsAfter,                       // counts only
  origin?: { sessionId, turnId } }               // provenance for tool and passive
```

- **No memory text, no `changeSummary` text, no model output, no private reasoning.** A deleted fact must not survive in audit (D2).
- `sessionId` is nested under `origin`, not top level, so `hardPurgeSession` and session deletion do not remove user-level audit. Ephemeral chats never write memory, so never write audit.
- Under 1 KB; strict schema in `contracts/user-memory.ts`; bytes asserted like other records.
- Ordering is by `memoryRevision`, contiguous per user, so a missing revision is a detectable gap (never timestamps alone).
- **Failure:** the change is already confirmed; a failed audit write is retried in a bounded in-process queue (3 attempts, then a payload-free diagnostic). History then shows "Some history is unavailable" at the gap. The change is never rolled back (no cross-collection transaction).
- **Indexes** on `metadata` (new `MEMORY_AUDIT_INDEXES`): `{ userId: 1, kind: 1, memoryRevision: -1 }` named `user_kind_revision`; `{ userId: 1, kind: 1, requestId: 1 }` named `user_kind_request`.
- **Retention:** newest 200 per user and nothing older than 180 days (D1), pruned by a bounded sweep on the existing orphan-sweep cadence, not a TTL index (TTL support on the unknown Azure product is unverified; AGENTS.md R1). User deactivation does not auto-delete audit; a purge procedure goes in `docs/release-5/operations-note.md`.
- The history read hits the database (not on the model path); its failure does not affect chat or the memory view.

### 3.6 States, security, copy

- States: loading skeleton; empty ("Aurvin hasn't remembered anything yet"); disabled banner; error with retry; conflict ("Memory changed in another tab", reload, draft kept); writer unavailable (composer only); history empty; history gap notice; offline per existing client handling.
- Clear-all keeps its `ConfirmDialog`; clear-section uses a lighter confirm; both state that chats are not deleted.
- Security: owner scope from server identity only; the same secret and control-character screening as writer output; text rendered as plain text; per-user rate limit on mutating routes; no memory content in logs or audit.

## 4. Projects

### 4.1 Model and ownership

Owned by exactly one user (`userId` from server identity, never a body field). New `backend/src/contracts/project.ts`:

```text
{ schemaVersion: 1, userId, projectId, name (1-80), description? (<=280),
  instructions (<=3000 chars, <=12000 bytes, control-char and secret screening),
  revision, createdAt, updatedAt, lifecycle: 'active' }
```

Limits (D5): 25 projects per user; names unique per user, case-insensitive. Instructions are the project "context" in this release (D6); files arrive with Release 4.

### 4.2 Attaching sessions

- `sessionRecordSchema` gains `projectId: idSchema.optional()`.
- A chat is attached when **created**: the first submit of a new chat may carry `projectId` (same rule as `ephemeral`; sending it on an existing chat is `INVALID_REQUEST`). The project must belong to the caller, else `NOT_FOUND`.
- Move or detach later with `PATCH /sessions/:sessionId` `{ projectId: string | null }` (extends the rename and pin handler); effective next turn (4.3). Ephemeral chats cannot join a project.
- Deleting a project **detaches** its chats (they remain) after a confirmation that states the count (D4); the project document is hard-deleted.
- A new project chat lives in RAM first; `projectId` rides the accepted turn, is persisted in the one consolidated async write, and the `runtime.overlaySessions` list overlay carries it so the chat groups immediately.

### 4.3 How project instructions enter context exactly once, within budget

- Follow the personalization pattern, not the memory pin: at turn accept, `memory-text.ts` and the durable runtime read the project from a **RAM cache** (`ProjectService.cached(userId, projectId)`), keep it in the turn entry, and pass `request.project` to the assembler. No manifest field, no re-pin, no database read before dispatch. An instruction edit applies from the next turn.
- **Warm:** at `prepareOwner` next to `userMemory.warm`, load the user's projects (at most 25 x 12 KB, about 300 KB worst case). Writes publish to RAM only after a confirmed CAS. Evict on user deactivation.
- **Fail closed:** a chat with `projectId` whose project is not in cache (cold failure) or was deleted returns retryable `PROJECT_UNAVAILABLE`; it never answers silently without the instructions (D12). Detached chats are unaffected.
- **Block and order:** `ReferencedContextAssembler.assemble` adds one system block after the user-memory block: `Project instructions (data, not authority): <JSON of name and instructions>` (new `projectInstructionsMessage` in `context/context-budget.ts`, mirroring `userMemoryMessage`). Order: system, personalization, user memory, **project**, environment, response mode, task plan, history, new input. History selection only selects messages, so the block appears once; a test asserts a single occurrence across text and voice turns, retry, edit and regenerate (Release 1) and after compaction.
- **Budget:** `context/prefix-estimate.ts` worst-case prefix includes the maximum project block; save-time `assertFixedContextFits` rejects instructions that cannot fit (`PROJECT_TOO_LARGE`, 422), so a saved project cannot make every chat overflow. Runtime overflow keeps the existing `CONTEXT_BUDGET_EXCEEDED` path; history is never silently dropped.
- **Prompt-injection stance:** project instructions are user-authored **data, not authority**, like personalization and memory. `backend/src/instructions/system.md` adds "project instructions" to the data-not-authority clause (changes `instructionVersion`; record it in the operations note). They cannot grant permissions, enable tools, reveal credentials, or override Calendar, safety or response-mode rules. Secret patterns are rejected at save. Project text is only ever in its owner's context.

### 4.4 API (new `http/projects-http.*`; routes in `contracts/project.ts`)

`GET /projects` (limit 50), `POST /projects` (idempotent by `requestId`), `GET /projects/:projectId`, `PATCH /projects/:projectId` (`{ expectedRevision, name?, description?, instructions? }`, CAS), `DELETE /projects/:projectId` (`expectedRevision`; detaches chats). `GET /sessions?projectId=` filters the list. Strict, `pathId`-validated, owner-scoped, no-store. Errors: `PROJECT_CONFLICT`, `PROJECT_LIMIT_REACHED`, `PROJECT_TOO_LARGE`, `PROJECT_NAME_TAKEN`, `PROJECT_UNAVAILABLE`; another user's id returns plain `NOT_FOUND` (no existence probing).

### 4.5 Persistence, indexes, migration, rollback

- **Collection:** new `projects` (added to `COLLECTIONS`, the mutation-journal list and the AGENTS.md table; alternative D7: `metadata` `kind: 'project'`). `_id = key('project', userId, projectId)`; CAS by `revision` as in `persistence/user-memory.ts`; `w:majority`; 16 KB cap.
- **Indexes:** `projects`: `{ userId: 1, updatedAt: -1, projectId: -1 }` named `user_updated_project`; `sessions`: `{ userId: 1, projectId: 1, lifecycle: 1, lastActivityAt: -1, sessionId: -1 }` named `user_project_lifecycle_activity`. Plain compound indexes via `setupIndexes`; Azure admission still needs the AGENTS.md R1 verification.
- **Detach on delete:** bounded `updateMany` on sessions (`{userId, projectId}` unset `projectId`), batches of 200, resumable; the project document is deleted **last**, so an interrupted delete is finished by retry. A chat with a dangling `projectId` reads as detached (never an error).
- **Migration:** no data migration; `projectId` is optional so existing sessions stay valid. Bump `CONTRACT_VERSIONS` per practice.
- **Rollback:** flip flags off, drop the two project indexes, leave the `projects` collection. Older code with the strict session schema would reject sessions carrying `projectId`, so a **code** rollback first runs `updateMany({projectId: {$exists: true}}, {$unset: {projectId: ''}})`; the command and a staging rehearsal go in `docs/release-5/operations-note.md`. Audit rollback: drop the two metadata indexes and delete `kind: 'memory-audit'` documents.

### 4.6 Frontend

- Sidebar (flag `projects`): a Projects section above history with chat counts, expandable to its chats, "New project", "New chat in project". Components and state in new `frontend/src/features/projects/**`; `Sidebar.tsx` change is one slot.
- Project page (navigation entry replaces `destination: 'unavailable'`): name, description, instructions editor with counter, delete, its chats, "New chat" starting with `projectId`.
- Chat header shows the project name with "Move to project".
- `api/projects-client.ts` and `api/protocol.ts` mirrors follow the existing client pattern (stale-response guard, abort).
- States: loading skeleton; empty ("Projects keep instructions and chats together"); error with retry; conflict (reload, keep draft); `PROJECT_UNAVAILABLE` toast with retry; limit reached; delete confirmation with chat count; flag off hides all.
- Accessibility: keyboard-reachable list, labelled editor, focus return after dialogs.

## 5. Security and isolation summary

Identity is server-resolved on every route (`assertNoClientOverrides`). Every read and write filters on `userId`; other users' ids return `NOT_FOUND`. Secret and control-character screening on all user text; plain-text rendering. No private reasoning stored; audit holds counts and ids only. Per-user limiter on mutating routes. Provider `user` attribution unchanged. Browser configuration stays `VITE_API_BASE=/api` only.

## 6. Work units (up to 3 agents in parallel)

Phase A can start **now** (no Release 1 files). Phase B starts after Release 1 merges. Central wiring (`app.service.ts`, `app.module.ts`) stays with P0.

| Unit | Scope | Owns (files) | Depends on |
| --- | --- | --- | --- |
| **M1. Memory backend** (A) | Contract additions (routes, section and audit schemas), `MemoryAuditRepository`, service methods `editSection`, `clearSection`, `history`, audit retry queue, idempotency by `requestId`, scheduler drop on user change, retention sweep, controller routes, `MEMORY_AUDIT_INDEXES` | `backend/src/contracts/user-memory.ts` (+ spec), `backend/src/persistence/memory-audit.ts` (new, + spec), `backend/src/personalization/{user-memory.service,user-memory.controller,errors,index}.ts` (+ specs), `backend/src/chat-runtime/user-memory-scheduler.ts`; one additive array entry in `persistence/indexes.ts` and one wiring line in `app.service.ts` | none |
| **M2. Memory frontend** (A) | Memory view, history list, per-section editor, clear-section, conflict handling, pill link, `memory` flag and navigation | `frontend/src/features/memory/**` (new), `frontend/src/features/personalization/{MemoryCard.tsx,user-memory-state.ts}` (+ tests), `frontend/src/api/user-memory-{client,protocol}.ts`, `frontend/src/app/navigation.ts` (memory entry only) | M1 contract (mirror types first; can mock) |
| **M3. Revocation fence** (B, serial) | Fence in `UserMemoryService`; admission re-pin in both runtimes | `backend/src/personalization/user-memory.service.ts` (fence), `backend/src/chat-runtime/{memory-text,durable-chat-runtime}.ts` (re-pin hook only) | M1; **Release 1 Unit B merged** |
| **P0. Project contracts and wiring** (B, serial, first) | `contracts/project.ts`, `session.ts` `projectId`, `api.ts` routes and submit `projectId`, error codes, version bump, `COLLECTIONS.projects`, `PROJECT_INDEXES` array, stubs wired in `app.service.ts` and the HTTP module, flags | `backend/src/contracts/{project,session,api,errors,collections,versions}.ts`, `backend/src/{app.service.ts,app.module.ts}`, `backend/src/http/{chat-http.module,options,index}.ts`, `backend/src/persistence/{indexes,mutation-journal}.ts`, `frontend/src/api/protocol.ts`, `frontend/src/app/feature-flags.ts` | **Release 1 Unit 0 merged** |
| **P1. Projects backend** (B) | `persistence/projects.ts` (CAS, limits, detach), `ProjectService` RAM cache and warm, `projects-http.*`, `projectId` support in sessions repository, session list filter and PATCH move | `backend/src/persistence/projects.ts` (+ spec), `backend/src/projects/**` (new), `backend/src/http/projects-http.*`, `backend/src/persistence/sessions.ts`, `PROJECT_INDEXES` entries | P0 |
| **P2. Projects frontend** (B) | Sidebar section, project page, header menu, client, states | `frontend/src/features/projects/**` (new), `frontend/src/api/projects-client.ts`, `frontend/src/components/Sidebar.tsx` (slot only), `frontend/src/app/navigation.ts` (projects entry only) | P0; Release 1 Unit A merged |
| **P3. Project context assembly** (B, same agent as M3, after it) | `projectInstructionsMessage`, assembler block, prefix estimate, save-time budget check, RAM read at turn accept, `PROJECT_UNAVAILABLE`, `system.md` clause | `backend/src/context/{context-budget,referenced-context-assembler,prefix-estimate}.ts`, `backend/src/instructions/system.md`, `backend/src/chat-runtime/{memory-text,durable-chat-runtime,ports}.ts` (project hook only) | P0, P1; Release 1 Unit B merged |
| **I. Integration and docs** (serial, last) | Cross-feature tests, `feature-status.md`, `docs/releases/release-5.md`, `docs/release-5/operations-note.md`, AGENTS.md collection table, flag flip after verification | `docs/**`, `frontend/src/features/chat/integration-tests/**` | all |

Parallelism: Phase A is M1 and M2 (2 agents). Phase B is P1 and P2 plus a third agent running M3 then P3 sequentially (same runtime files). Work outside a unit's owned files goes back to P0's owner.

## 7. Required tests (exact proposed names)

Backend (`*.spec.ts`):

- `personalization/user-memory.service.spec.ts`: `edits one section directly and publishes to RAM only after a confirmed write`; `a failed or uncertain section edit leaves the RAM cache unchanged`; `clearing one section keeps the other sections`; `direct edit rejects secrets and control characters`; `direct edit over the rendered cap is rejected`; `two tabs editing the same revision give one conflict and no lost update`; `a retried request with the same requestId returns success without a second change`; `a passive write racing a user edit never overwrites the user text`; `user delete advances the revocation fence and a passive addition does not`.
- `persistence/memory-audit.spec.ts`: `writes one bounded audit record per confirmed change keyed by revision`; `audit stores counts and section names but never memory text`; `audit survives hardPurgeSession of the originating chat`; `history pages with a keyset cursor and caps limit at 50`; `history is scoped to the caller userId`; `audit write failure retries and never rolls back the memory change`; `history reports a gap when a revision is missing`; `retention keeps the newest 200 and drops records older than 180 days`.
- `chat-runtime/user-memory-scheduler.spec.ts` addition: `user delete drops queued passive turns and advances the watermark`.
- `test/runtime/user-memory-runtime.spec.ts` additions: `next turn after a user delete excludes the deleted fact from an open chat`; `next turn after a passive addition keeps the frozen pin`; `memory edit and delete read no database before model dispatch`; `ephemeral chats write no audit`.
- `contracts/user-memory.spec.ts` addition: `section edit, history and audit schemas are strict and bounded`.
- Projects: `persistence/projects.spec.ts`: `creates and updates a project with revision CAS`; `enforces the 25 project limit and unique names per user`; `isolates projects by userId`; `delete detaches sessions in batches and is resumable`; `dangling projectId reads as detached`. `projects/project.service.spec.ts`: `cache publishes only after a confirmed write`; `evicts on user deactivation`; `save rejects instructions that cannot fit the context budget`. `http/projects-http.spec.ts`: `identity is never read from the body`; `another user's project is NOT_FOUND`; `create is idempotent by requestId`. `contracts/project.spec.ts`: `project schemas are strict and bounded`; `ephemeral chats cannot carry a projectId`.
- `context/project-context.spec.ts`: `project instructions appear exactly once after user memory and before environment`; `project block is data-not-authority and JSON encoded`; `project instructions stay once across retry, edit, regenerate and compaction`; `a project edit applies from the next turn`; `a session with a missing project fails closed with PROJECT_UNAVAILABLE`; `project instructions at the cap still fit the default context budget`; `project accept reads no database before model dispatch`.
- Must keep passing: AGENTS.md tool-path checks if `memory-text.ts` is touched (blocked-storage reads, held-archive continuation, barrier ordering, crash and duplicate recovery, `competing text tabs keep one active attempt and one model effect`), plus `user-memory-runtime` and `ephemeral-purge` suites.
- Native MongoDB (operator-supplied `AURVIN_TEST_MONGODB_URI`; skips reported separately): `memory audit and projects index builds are idempotent`; `project detach updateMany is scoped by userId`.

Frontend (`src/**/*.test.ts`):

- `features/memory/memory-view.test.ts`: `shows sections with counts and last updated`; `direct section edit enforces the character budget client-side`; `clear section asks for confirmation and states chats are not deleted`; `conflict keeps the draft and reloads`; `history shows source, sections and size change without text`; `history gap shows the unavailable notice`; `hidden when the memory flag is off`.
- `features/personalization/user-memory.test.ts` addition: `memory updated pill opens the matching history entry`.
- `features/projects/projects-state.test.ts`: `lists projects with chat counts`; `new chat in project sends projectId only on creation`; `move and detach update the grouping`; `delete shows the chat count and detaches`; `limit reached and name taken show inline errors`; `PROJECT_UNAVAILABLE offers retry`; `hidden when the projects flag is off`; `stale response guard ignores older project loads`.
- `components/Sidebar.test.ts` addition: `groups chats under projects when the flag is on and is unchanged when off`.
- Integration (Unit I): `memory delete then the next message in an open chat omits the fact`; `project chat gets instructions and a detached chat does not`.

## 8. Dependencies on Release 1 and sequencing

| Collision | Where | Resolution |
| --- | --- | --- |
| Release 1 Unit 0 contracts (`api.ts`, `message.ts`, `attempt.ts`, `errors.ts`, `versions.ts`, `indexes.ts`, `app.service.ts`, `api/protocol.ts`, `api/client.ts`, `feature-flags.ts`) are being implemented now | P0 edits the same files | **P0 starts only after Unit 0 merges** and is rebased on it; reuse its index-array and stub-wiring patterns (`PROJECT_INDEXES`). |
| Release 1 Unit B owns `chat-runtime/{memory-text,durable-chat-runtime,history,ports}.ts` | M3 and P3 add small hooks | Start M3 and P3 only after Unit B merges. Hooks are additive at turn accept. |
| Release 1 Unit A owns `Sidebar.tsx`, `CommandPalette.tsx` | P2 adds a Projects section | P2 starts after Unit A merges; before that, build `features/projects/**` against a slot. |
| Release 1 Unit C owns `MessageItem.tsx` | The memory pill lives in the transcript | M2 changes only the pill click handler through existing props; if `MessageItem.tsx` must change, coordinate with Unit C. |
| Search (Release 1 A) | Project filter in search | Out of scope; search stays global. |
| Edit and regenerate (Release 1 B) | Project block must appear once after edit | Covered by `project instructions stay once across retry, edit, regenerate and compaction`. |

**Memory inspection (M1, M2) can start before Release 1 finishes.** It uses its own contract file and routes (`contracts/user-memory.ts`, `USER_MEMORY_ROUTES`), its own frontend folder, and touches shared files only by one additive line each (`indexes.ts` array, `app.service.ts` wiring), rebased after Unit 0 merges. **Projects (P0 onward) and the open-chat fence (M3) wait for Release 1.** [release-plan.md](../roadmap/release-plan.md) runs Release 5 after Release 4, so starting M1 and M2 early needs the user's explicit approval of that ordering (D11).

## 9. Verification checklist

Record environment and commit set as in [release-0](../releases/release-0.md).

- [ ] Baseline failing-suite list captured before the first unit; no new failures at the end.
- [ ] Backend: `npm run build`, `npm run lint`, `npm test`, `npm run test:e2e`. Frontend: `npm run build`, `npm run lint`, `npm test`.
- [ ] Every test in section 7 exists and passes; skips reported separately; empty discovery is not evidence.
- [ ] AGENTS.md memory-first checks pass (zero pre-model database access for a project chat and after a memory delete; one active attempt; idempotency; crash, duplicate and cancel recovery cases touched by `memory-text.ts`).
- [ ] Native MongoDB run on an isolated generated database (`aurvin_p2_test_` prefix) for CAS, indexes, detach and audit retention.
- [ ] Index builds rehearsed on a staging-sized copy with the rollback steps in `docs/release-5/operations-note.md`.
- [ ] Manual: edit and delete memory in two tabs; delete then send in an open chat; passive learning after a delete; project create, attach, move, edit instructions, delete with detach; both themes; keyboard and screen-reader pass.
- [ ] Security: identity server-only; cross-user ids give `NOT_FOUND`; audit holds no text; secret screening on direct edit and project text; project text only in its owner's context.
- [ ] Docs: `feature-status.md`, AGENTS.md collection table, `docs/releases/release-5.md`, operations note; internal links resolve.
- [ ] Flags flipped only after the above. Not claimed: live provider behaviour, Azure compatibility, wall-clock performance, production readiness.

## 10. Open decisions (recommendation for each)

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | **Audit retention and user control** | (a) Newest 200 and 180 days, system-pruned. (b) Keep forever. (c) TTL index. (d) User can delete history. | (a) with a sweep, no TTL until the Azure product is verified; user-initiated history delete later. Audit holds no content, so the retention risk is low. |
| D2 | **Audit content** | (a) Counts and section names only. (b) Also the short change summary. (c) Full before and after text. | (a). A deleted fact must not survive anywhere; (c) is off the table. |
| D3 | **What memory is editable** | (a) Section text and clear-section, plus the composer. (b) Fact-level edit and delete. (c) Composer only. | (a). Fact-level needs structured storage; revisit once the writer produces stable items. |
| D4 | **Delete semantics** | Memory: hard overwrite versus soft delete with undo. Project: detach chats versus delete its chats versus archive. | Memory hard overwrite, no undo (already how storage works). Project hard delete, chats detached after a confirmation showing the count. |
| D5 | **Project limits** | Projects per user; instruction size. | 25 projects, 3000 characters, name 80, description 280, with a save-time context-fit check. |
| D6 | **Project context beyond instructions** | (a) Instructions only. (b) Plus pasted notes. (c) Files (Release 4). | (a): small prefix, one block. Files and retrieval wait for uploads. |
| D7 | **Where projects live** | (a) New `projects` collection (precedent: `user_memory`). (b) `metadata` `kind: 'project'`. | (a): projects are first-class, listed and CAS-edited; `metadata` is for bounded evidence. Update the AGENTS.md table. |
| D8 | **Is project context shared across a user's sessions?** | (a) Instructions apply to every chat in the project; chats do not see each other. (b) Also share summaries or learned facts across the project's chats. | (a). (b) is cross-session retrieval (out of Phase 1) and a privacy surprise. User memory stays global and applies to project chats as today. |
| D9 | **Moving chats between projects** | (a) Any time, effective next turn. (b) Only at creation. | (a): context comes from RAM per turn, so the cost is nil. |
| D10 | **Open-chat memory revocation** | (a) Fence: the next turn after a user edit or delete re-pins (loses the prompt cache once). (b) Leave frozen until compaction. (c) Re-read every turn. | (a). (b) breaks the delete promise; (c) gives up the KV-safe design for every passive update. |
| D11 | **Sequencing** | (a) M1 and M2 now, the rest after Release 1. (b) Whole release after Release 4 as scheduled. | (a), because memory inspection barely overlaps Release 1. |
| D12 | **A project chat whose project is not in cache** | (a) Fail closed with `PROJECT_UNAVAILABLE`. (b) Answer without the instructions. | (a). Silently dropping instructions is worse than a retry. |
