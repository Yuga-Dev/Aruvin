# Release 6 plan: Everyday integrations

**Status:** Decisions D1–D13 accepted as recommended by the user on 27 November 2026 (section 11). Nothing here is implemented yet. **Branch:** planning merged from `codex/release-6-plan`, based on main `a38f1da`.

Work order follows [release-plan.md](../roadmap/release-plan.md): contracts, backend, database and indexes, API and events, frontend, states, security, tests, docs, verification. User-visible capabilities stay behind `frontend/src/app/feature-flags.ts` (and a backend plugin setting) until release verification passes. Current status of everything else is in [feature-status.md](../roadmap/feature-status.md). Format precedent: [Release 1 plan](../release-1/plan.md).

Release 6 scope (roadmap): Calendar edit, reschedule and delete; email; document storage. All writes need approval; credentials stay server-side. **Calendar is planned in full (sections 3-9). Email and document storage are planned lightly (section 10) because they need user decisions before any design is safe.**

## 1. What exists today (traced)

| Area | Reality | Consequence |
| --- | --- | --- |
| Tools | `CALENDAR_TOOLS` in [`contracts/calendar-tools.ts`](../../backend/src/contracts/calendar-tools.ts): list events, get event, create event, list calendars, check availability. Only `calendar_create_event` is a write (`deliveryRetry: 'never'`, `readOnlyHint: false`). The model sees an exact tool list per request (`assertTools` in [`model/calendar-policy.ts`](../../backend/src/model/calendar-policy.ts)); `CALENDAR_LIMITS` allows `creates: 1`, 6 logical tools, 8 model dispatches. | Update and delete are new tools, a new tool revision, and a new per-turn cap (`changes: 1`). |
| OAuth scope | `CALENDAR_SCOPES` in [`contracts/calendar-policy.ts`](../../backend/src/contracts/calendar-policy.ts): `openid`, `email`, `calendar.calendarlist.readonly`, `calendar.events`, `calendar.freebusy`. The broad `calendar` and `calendar.readonly` scopes are explicitly forbidden. | `calendar.events` already allows event update and delete. **No new scope and no reconnect is needed** (section 6). |
| Provider adapter | [`plugins/google-calendar/calendar-api.ts`](../../backend/src/plugins/google-calendar/calendar-api.ts): `create` POSTs with `writeQuery()` (`sendUpdates: 'none'`), a deterministic event ID from `calendarEventId(operationId)`, and `extendedProperties.private.aurvinOperationId` linkage; `readback` GETs the pinned ID and `matchesCreateAction` checks id, action and both private linkage values. `calendar-api-http.ts` only allows `method: 'GET' \| 'POST'`. `EVENT_FIELDS` has no `etag`, `sequence`, `recurringEventId`, `attendees`, `organizer` or `recurrence`. | PATCH and DELETE methods, `If-Match`, and wider field selection are new. Reads must expose the preconditions. |
| Operation ledger | [`contracts/calendar-operations.ts`](../../backend/src/contracts/calendar-operations.ts): `operationRecordV2Schema` (strict, `schemaRevision: 'google-calendar.v2'`), states `planned`, `dispatching`, `succeeded`, `definitely-failed`, `unknown`, `evidence-expired`, `failed`, `cancelled`; `action` is create-only; `googleEventId` must match `^[0-9a-v]{5,1024}$`; `calendarRequestKindSchema` has `create` and `readback` but no update or delete. | The record needs an operation type, a precondition, and a receipt that can describe a change or a deletion. |
| Writer and barrier | [`chat-runtime/calendar-operation.ts`](../../backend/src/chat-runtime/calendar-operation.ts): `buildV2CreateOperation`, `CalendarOperationWriter`, `appendPlannedEvent`, `repairOperationEventV2`. Durable `planned` then fenced `dispatching` CAS happen before the provider call. | Reuse unchanged for update and delete; add the new operation builders next to the create one. |
| Recovery | [`chat-runtime/calendar-recovery.ts`](../../backend/src/chat-runtime/calendar-recovery.ts): `reconcileCalendarOperationV2` (dispatching/unknown, deadline-bounded, charges the budget), `reconcilePlannedCalendarOperationV2` (W1-W3), `reconcileConsumedProposalWithoutOperation`, `classifyCalendarContinuationV2`. Reads back the pinned ID; never POSTs again. | Add update and delete read-back classifiers (section 5). |
| Proposals | [`contracts/calendar-authority.ts`](../../backend/src/contracts/calendar-authority.ts) `calendarProposalSchema`: ≤16 KiB, TTL ≤ 10 minutes (`proposalLifetimeMs`), states `pending`, `consumed`, `cancelled`, `superseded`, `expired`, single consumption, `purpose: selection \| details \| conflict`, `action` is create-only. Frontend reply binding: `calendarReplyTo { proposalId, revision }` ([`api/protocol.ts`](../../frontend/src/api/protocol.ts)). | Add a `change` purpose and an operation type; the approval card is the existing proposal. |
| Runtime | [`chat-runtime/calendar-loop.ts`](../../backend/src/chat-runtime/calendar-loop.ts) (shared model/tool loop), [`calendar-budget.ts`](../../backend/src/chat-runtime/calendar-budget.ts), [`calendar-authority.ts`](../../backend/src/chat-runtime/calendar-authority.ts), memory-first state in `memory-calendar-state.ts` and `memory-calendar-ledger.ts`, post-turn projection in `calendar-publication.ts`. Persistence in `persistence/calendar-operations.ts`, `calendar-proposals.ts`, `calendar-accounting.ts`; indexes `calendar_operation_*` in `persistence/indexes.ts`. | The memory-first admission path is reused; no new pre-model database access. |
| Frontend | [`features/plugins/google-calendar/CalendarTurnRegion.tsx`](../../frontend/src/features/plugins/google-calendar/CalendarTurnRegion.tsx) (proposal/confirmation/receipt in the chat), `api/calendar-protocol.ts`, Canvas calendar views in `features/canvas/calendar-workspace.ts`, `use-chat.ts` reply handling. [Confirmation success canvas](../confirmation-success-canvas.md): a durable success receipt opens the Calendar Canvas; failed or unknown writes never produce a success artifact. | Same region and the same success rule for edit and delete. |
| Task mode | [Task spec](../task-mode-and-flows/spec.md): a write step pauses on the existing Calendar proposal; `task-tracker.ts` marks `awaiting_approval` on a `calendar-clarification` proposal frame. Phase A is being finished on another branch. | Edit and delete proposals use the same frame; no second approval system. |
| Email, documents | Nothing exists. Prior research ([`aurvin-plugins-research`](../aurvin-plugins-research/platforms.md)) covers the plugin architecture, not Gmail or Drive. | Section 10 lists decisions before any code. |

History to respect: Calendar create was proven through [google-calendar-plugin](../google-calendar-plugin/goal.md), [multi-calendar](../google-calendar-multi-calendar/goal.md), [memory-first handoff](../calendar-memory-first-production-handoff/HANDOFF.md), [tool latency](../calendar-tool-latency/goal.md) and [visibility simplification](../calendar-visibility-simplification/goal.md). Those goals explicitly deferred "update/delete/bulk mutation, invitations/attendees, recurrence"; this release is that deferral. Deterministic fixtures only; no live Google run is certified.

## 2. Scope and non-goals

In scope: Calendar edit (title, description, location), reschedule (start/end/time zone), and delete of one event on an authorized calendar; then, after decisions, email and document storage.

Non-goals:

- Bulk or multi-event changes: one change per turn (`changes: 1`). "Move all my Friday meetings" is refused with a plain explanation.
- Series-wide recurring edits or deletes, "this and following" (decision D1).
- Events with guests: no attendee add/remove, no invitation or update emails (decision D2). Creating events with attendees stays out too.
- Moving an event between calendars (`events.move`), RSVP responses, reminders, conference/Meet, attachments, ACL or calendar management.
- Undo for delete. The card says it removes the event from Google Calendar; Aurvin does not promise restore.
- Automatic conflict rescheduling, or any unattended write: background Flow runs cannot change or delete events in this release (section 9).
- New OAuth scopes for Calendar; new infrastructure; Azure certification; public access; live provider runs without explicit authorization.

## 3. Calendar edit, reschedule and delete

### 3.1 Behavior and approval UX

1. The user asks ("move my 3 pm to 4", "rename it", "delete the dentist event"). The model finds the event with the existing read tools, then calls `calendar_update_event` or `calendar_delete_event` with `eventId`, optional `calendarId`, and for update only the fields to change (`summary`, `description`, `location`, `start`, `end`, `timeZone`; at least one required; strict, bounded like create).
2. The tool never executes on the model's call alone. As with create, the backend turns the call into a **proposal** (purpose `change`) and emits the existing `calendar-clarification` frame. The proposal records the event as last read: `eventId`, `calendarId`, `etag`, `sequence`, a bounded before-image of the changed fields, the canonical after-image, and a `canonicalActionHash` over the operation type, target, etag and patch.
3. The card (in `CalendarTurnRegion`) shows **before and after** side by side, the calendar name, a destructive style and wording for delete ("Delete 'Dentist' on Fri 4 Dec, 10:00?"), and Confirm and Cancel. Confirm is the existing `calendarReplyTo` reply; it is single-consumption and expires after 10 minutes. Editing the arguments in the card (Task mode rule) creates a new proposal and supersedes the old one.
4. On confirm the backend runs the durable barrier, then sends. Success shows a receipt and opens the Calendar Canvas on the changed day (edit) or confirms removal (delete) using the existing success-canvas rule: only a durable success receipt produces a success view.
5. Failure and unknown outcomes are shown directly without model narration, as create does today.

### 3.2 Conflict handling: changed or deleted since it was read

- Every update and delete is sent with `If-Match: <etag read into the proposal>`. Google answers 412 if the event changed since; the check is atomic at Google, so the happy path needs no extra read.
- 412: operation `definitely-failed`, code `EVENT_CHANGED`, **no effect**. The user sees "This event changed since I looked. Here is the current version" and the model gets a fresh read to offer a **new proposal** (new approval). A stale proposal is never silently retargeted.
- 404 or 410 at send time with a pre-send proof that the event existed: `definitely-failed`, `EVENT_NOT_FOUND` ("already deleted or moved"), no effect. For delete, a direct 410 on the *first* attempt is reported as "already gone" success-equivalent with receipt `outcome: 'already-absent'`, because the user's goal holds.
- `sequence` is stored and compared in read-back only; `If-Match` is the precondition.
- Reschedule onto a conflicting time: the existing availability check runs when the model proposes a new time; conflict is disclosed on the card (existing `conflict` limitation wording). The user may still confirm (`basis: 'conflict-acceptance'` already exists).
- Edits to events Aurvin cannot safely change are refused before a proposal: organizer is not the connected account, event has guests (D2), event is recurring and not instance-addressable (D1), calendar role lacks writer access or `privateAccess` is false, event type is not default (birthday, focus time, out-of-office, working location). A refusal links to the event in Google Calendar (existing `htmlLink`, host-allowlisted).

### 3.3 Recurring events (decision D1)

Google addresses an occurrence by an instance ID (`<seriesId>_<timestamp>`) and the series by its own ID. Our list call already uses `singleEvents: true`, so the model sees instances. **Recommendation: this release changes or deletes only a single non-recurring event or one single instance ("this event only").** The card says so ("This event only; the rest of the series is unchanged"). Series and "this and following" are refused with a link. Deleting an instance writes a cancelled exception; editing an instance writes an exception; both are patch/delete on the instance ID with `If-Match` on the instance etag. Reconciliation (5.x) uses the instance ID as the pinned ID.

### 3.4 Attendee notifications (decision D2/D3)

`writeQuery()` currently forces `sendUpdates: 'none'`. Google warns that suppressing updates can desynchronize guests. **Recommendation: v1 supports only events with no guests other than the owner, so `sendUpdates: 'none'` is correct and nothing is emailed.** A guest-bearing event is refused. A later release may add a card choice "Notify guests" (`sendUpdates: 'all'`), which then needs its own consent wording and a recipient list in the card. Never default to notifying.

### 3.5 Contracts (U0, one owner)

- `calendar-tools.ts`: `calendar_update_event` and `calendar_delete_event` (V2 tool list only; V1 stays create-only); `CALENDAR_TOOL_REVISION` bump; `deliveryRetry: 'never'`; delete `destructiveHint: true`, `idempotentHint: false`; update `calendarEventSchema` projection to carry bounded `etag`, `sequence`, `recurringEventId`, `guestCount`, `organizerSelf`, `eventType`. Update `model/calendar-policy.ts` `assertTools` / `assertCompositeTools` and the stable prompt-cache tool list together.
- `calendar-policy.ts`: `CALENDAR_LIMITS.changes: 1` (updates plus deletes per turn, separate from `creates`); keep `CALENDAR_SCOPES` and `forbiddenScopes` unchanged.
- `calendar-operations.ts`: `calendarRequestKindSchema` gains `update` and `delete`; operation record gains `operationType: 'create' | 'update' | 'delete'` (default `'create'` so stored documents still parse), `precondition: { etag, sequence } | null`, a discriminated `action` (create input, bounded patch, or delete marker), `beforeHash`/`afterHash`; `googleEventId` for update/delete is the **existing target event ID** and is validated against Google's real ID alphabet (instance IDs contain `_`), not the create-generated regex. Receipt gains `outcome: 'applied' | 'already-absent' | 'inferred'` and, for update, the post-state `etag`.
- `calendar-authority.ts`: proposal gains `operationType`, `target event` binding, `precondition`, and a `change` purpose; same ≤16 KiB bound and 10-minute TTL.
- Mirrors in `frontend/src/api/calendar-protocol.ts`; extend the protocol tests. Contract versions bumped per existing practice. No client-supplied identity or authority is added (`assertNoClientOverrides` stays).

### 3.6 Durable pre-effect evidence per operation

Same rule as create (AGENTS.md "Tool execution critical path"): before any PATCH or DELETE the backend persists, acknowledged and fenced, in order: accepted input, attempt, acceptance marker, consumed proposal with `consumedBy`, operation record (`planned`) carrying target event ID, `precondition.etag`, patch or delete marker, `beforeHash` and `afterHash`; then the `planned` event; then the `dispatching` CAS. If any of these is failed or uncertain, **do not send**. Prepared read paths used to *find* the event stay storage-free (server-memory authority; `requireAccountCurrent(..., { fresh: false })`).

The patch carries `extendedProperties.private.aurvinOperationId` (and request hash) so a later read-back can prove *this* operation applied (a PATCH merges private properties). Delete has no such marker, see 5.2.

### 3.7 Crash windows and reconciliation (update, delete)

The create windows are W1-W4 ([`test/performance/calendar-tool-latency.spec.ts`](../../backend/test/performance/calendar-tool-latency.spec.ts)). Update and delete inherit the same windows and the same budget/deadline/fence rules in `reconcile*CalendarOperationV2`. Never replay a mutation blindly; every recovery starts with a bounded GET of the pinned event ID (cost charged to `calendarRequests`).

| Window | State at crash | Recovery |
| --- | --- | --- |
| W1 | Before the essential barrier is acknowledged | No operation, no send. The proposal is still `pending` or `consumed-without-operation`; existing `reconcileConsumedProposalWithoutOperation` reports it and the user must re-approve. No model replay. |
| W2 | `planned` written, `dispatching` CAS not confirmed | Never dispatch the planned operation after a failed or lost CAS. Read back: etag still equals `precondition.etag` and content equals before-image: mark `cancelled`/`definitely-failed` (no effect). Anything else: `unknown` plus the evidence. |
| W3 | `dispatching` confirmed, crash before or during send | Read back the pinned ID (no PATCH/DELETE). Update: private `aurvinOperationId` equals ours and fields match the after-image → `succeeded` with receipt `applied`. Etag unchanged and before-image intact → **not applied**; mark `unknown` with "not confirmed, nothing changed that we can see" and let the user start a **new** change (new proposal, new approval). Etag changed but no marker or different content → `unknown` (someone else changed it). |
| W4 | Provider success, operation `succeeded` not recorded | Same read-back proves the marker and after-image; record the receipt without a second send. |

**Delete is not idempotent the same way.** There is no body to compare and a retry after success returns 410/404.

- Ambiguous send (timeout, connection reset after write began): GET the pinned ID with `showDeleted` semantics. `status: 'cancelled'`, 404 or 410 and a persisted pre-send proof that the event existed at `precondition.etag` → `succeeded` with receipt `outcome: 'inferred'` ("deleted; Aurvin could not confirm it was this request, nobody else is known to have deleted it"). The card/receipt says so honestly. Still present with the same etag → not applied → `unknown`, new approval to try again.
- Never resend DELETE to "find out". A 410 on a deliberate *new* approved attempt is `already-absent`, not an error.
- 5xx or lost connection without any read-back → `unknown`; the unknown state is shown, not hidden; the pinned-ID read-back runs again on recovery until the audit deadline, then stays `unknown`.

Reuse saved results during finalization recovery; do not repeat model inference.

### 3.8 Cancellation semantics

Same as create. Cancel before the `dispatching` CAS: operation `cancelled`, proposal `cancelled`, nothing sent. Cancel or disconnect after the CAS: the send is not guaranteed stoppable; the UI says "Confirming with Google Calendar", the operation completes or reconciles, and the receipt is shown. A user-initiated cancel never claims the change did not happen after dispatch. Provider charges are not applicable; model cost cancellation claims are unchanged (no guaranteed charge prevention).

### 3.9 OAuth scope and consent

None needed: `calendar.events` already covers `events.patch`, `events.update` and `events.delete`, and consent text already says "see, edit, share and permanently delete events on all your calendars" (verify wording in `oauth-callback-page.ts` and `GoogleCalendarPanel.tsx`; adjust the Aurvin settings copy to say Aurvin will only change or delete after approval). **No reconnect, no `include_granted_scopes` change, no verification-tier change.** Existing connections keep working; the feature flag is the gate. Revoked or invalidated accounts fail closed: in-flight proposals and operations obey the existing account-invalidation rules (`in-flight Calendar result cannot publish a view or continuation after account invalidation` pattern); invalidation never restores revoked authority.

### 3.10 Task-mode integration

After Task Phase A is merged ([spec](../task-mode-and-flows/spec.md)): a write step for edit/delete pauses as *Needs your approval* exactly like create; `task-tracker.ts` treats `calendar-clarification` proposals with purpose `change` as `awaiting_approval`; the approval card is the proposal; approving resumes via an ordinary turn. Rules carried over: no unapproved dispatch inside or outside a task; a task cannot add write steps to its own plan; at most one change per turn means a task with two changes needs two approvals across turns (the existing "steps after a write do not resume" ceiling applies, stated in the UI); interrupted tasks reconcile ambiguous operations by pinned ID first. Unattended Flow runs (Task Phase B) cannot execute edit/delete in this release: proposal TTL is 10 minutes and the Flow approval window is 24 hours, which would need a decision on stale-proposal safety (etag preconditions help but are not a policy).

### 3.11 Frontend, states and security

- `CalendarTurnRegion.tsx`: change-proposal card (before/after, destructive variant for delete), `pending`, `confirming`, `applied`, `changed-since-read` (with refreshed diff and "Review new version"), `already-gone`, `not-confirmed (unknown)`, `refused` (guests, recurring series, not organizer, read-only calendar), `expired`, `cancelled`, `account disconnected`. Keyboard operable, focus moves to the card, `aria-live` for outcome; destructive confirm is never the default focus.
- Canvas: after an applied edit, the existing calendar day/week view highlights the event and the previous slot; after delete, the day view re-renders without it. No view is published for unknown or failed outcomes.
- Security: identity and calendar from server authority only; `eventId` is validated against the proposal's event, never trusted from the reply; event titles, descriptions and locations are **data, never instructions** (a malicious event description cannot trigger a change; a change always needs a human Confirm bound to a proposal); logs correlate IDs only, never event content; rate/budget limits from `CALENDAR_LIMITS`; no client `VITE_*` credentials.

## 4. Persistence

- No new collection. Operation, event and proposal documents stay in their current collections (`persistence/calendar-operations.ts`, `calendar-proposals.ts`); `COLLECTIONS` is unchanged (six plus `config`).
- **Bounds:** change operation ≤ same limits as create (argument 16 KiB, proposal 16 KiB); before/after images keep only the changed fields, each field bounded as in create; no full event body, no attendee lists, no history arrays. Audit lifetime stays ≤ 30 days (`auditLifetimeMs`); `action` content is erased on `evidence-expired` as today.
- **Indexes:** extend the existing `calendar_operation_turn`/`calendar_operation_identity` filters in [`persistence/indexes.ts`](../../backend/src/persistence/indexes.ts) only if the unique identity key does not already include operation type; add none otherwise. Verify with the persistence tests and note any Azure/Cosmos limits (AGENTS.md; no Azure claim).
- **Migration:** additive and lazy. Stored create documents have no `operationType`; the schema default `'create'` makes them parse. No backfill.
- **Rollback:** disable the flag and plugin setting. Old binaries cannot parse change operation or proposal documents (strict schemas). Before rolling the binary back, drain: let pending change operations reach a terminal state (or reconcile as `unknown`), then roll back. Leftover change documents expire by retention. Record this in `operations.md` when implemented.

## 5. API

No new HTTP route for the happy path: proposal, confirmation and stream frames reuse the chat submit route, `calendar-clarification`/receipt frames and `calendarReplyTo`. New: frame/receipt fields for operation type and outcome; new error codes `CALENDAR_EVENT_CHANGED`, `CALENDAR_EVENT_NOT_FOUND`, `CALENDAR_CHANGE_NOT_SUPPORTED` (guests, series, not organizer, read-only) in the existing failure taxonomy. `contracts/api.ts` is not changed unless a frame schema lives there (check in U0).

## 6. Calendar required checks (extends AGENTS.md list)

Existing create checks in AGENTS.md remain mandatory and must stay green. For each, an update and a delete equivalent is added (deterministic fixtures, `calendar-tool-latency.spec.ts` and `test/runtime/calendar-*.spec.ts` patterns). Proposed exact names (`<op>` is `update` or `delete`):

- **Blocked-storage prepared reads:** `prepared event lookup for a change dispatches and continues with application storage blocked`; `repeated prepared owner request preparation for a change does not touch application storage`.
- **Held-archive continuation:** `read continuation and follow-up finish while an actual archive owns persistence after a change`; `provider-confirmed <op> continues while its result projection is held`.
- **Barrier vs unrelated save ordering:** `direct <op> crosses its essential barrier while an earlier archive holds ownership`; `proposal confirmation for <op> crosses its essential barrier while an earlier archive holds ownership`.
- **Crash windows:** `crash window W1 before the essential barrier recovers a <op> without a send or model replay`; `crash window W2 blocked variants never dispatch the planned <op>`; `crash window W3 before send reads back the pinned event without a <op> request`; `crash window W4 after provider success and operation success recovers the <op> receipt without a second request`.
- **Ambiguity and idempotency:** `new assembled runtime reconciles an ambiguous update by pinned ID and marker without another PATCH`; `new assembled runtime reconciles an ambiguous delete by read-back without another DELETE`; `delete read-back 404 or 410 with a pre-send existence proof records an inferred receipt`; `delete read-back with the event still present and the same etag stays unknown and is never resent`; `a direct 410 on a first delete attempt is reported as already gone`.
- **Preconditions:** `update sends If-Match with the proposal etag`; `etag mismatch 412 is a definite failure with no effect and offers a new proposal`; `a stale proposal is never silently retargeted to a newer event version`; `delete of a deleted event after the read returns EVENT_NOT_FOUND without a retry`.
- **One provider effect:** `competing text tabs keep one active attempt and one <op> effect`; `concurrent text and live confirmations consume one change proposal and apply once`; `keeps one provider effect when an <op> is cancelled at the dispatching CAS or after success`; `a second change in the same turn is refused by the changes budget`.
- **Expiry and invalidation:** `change proposal at exactly expiresAt is refused and not sent`; `source expiry at exactly expiresAt forces a fresh provider read before a change proposal`; `expired policy denies a change without a provider request or stale content`; `rehydrates status after invalidation without restoring revoked authority for a pending change`; `in-flight change result cannot publish a view or continuation after account invalidation`.
- **Refusals and safety:** `change of an event with guests is refused before any proposal`; `change of a recurring series is refused and a single instance is addressed by its instance id`; `event description text cannot trigger a change without a bound confirmation`; `unapproved update or delete cannot dispatch inside or outside a task`.
- **Contracts and frontend:** schema tests for the new tool revision, operation type default parse of stored create documents, receipt outcome refinements; frontend `change proposal card renders before and after and a destructive delete variant`, `unknown outcome never opens a success view`, protocol mirror tests.
- **Task mode:** `write step pauses on a change proposal and updates once after approval` (after Phase A merge).
- **Measurement:** `profiles ... ` cases in `calendar-tool-latency.spec.ts` extended for change commands; report synthetic waves separately from `performance.now()` observations.

These are deterministic fixture checks; they do not certify native MongoDB, live Google, staging or any wall-clock SLA. Native-database suites need operator-supplied `AURVIN_TEST_MONGODB_URI` and the isolated prefix; report skips separately.

## 7. Work units and parallelism (Calendar)

Capacity: up to 3 parallel agents. Each unit edits only the files it owns; U0 owns shared contracts and central wiring.

| Unit | Scope | Owns (files) | Starts |
| --- | --- | --- | --- |
| **U0 Contracts** | Section 3.5 and 4 schemas, error codes, protocol mirrors, tool list and policy assertions, schema tests | `backend/src/contracts/calendar-*.ts`, `backend/src/model/calendar-policy.ts`, `backend/src/model/calendar-adapter.ts` tool list, `frontend/src/api/calendar-protocol.ts` (+ tests) | **Now** (blocks the rest; small) |
| **A Provider adapter** | PATCH/DELETE, `If-Match`, wider fields, projection of etag/sequence/guests/recurring, marker, status mapping (412/404/410), read-back for update and delete, fixtures | `backend/src/plugins/google-calendar/calendar-api*.ts`, `tools.ts`, `tools-validation.ts`, `test/plugins/**` Calendar API tests | After U0 contracts land |
| **B Runtime and recovery** | Proposal creation for changes, operation builders, writer, budget `changes`, W1-W4 and ambiguity recovery, memory-first state, publication, persistence + indexes, all required-check backend tests | `chat-runtime/calendar-operation.ts`, `calendar-recovery.ts`, `calendar-budget.ts`, `calendar-authority.ts`, `calendar-publication.ts`, `memory-calendar-*.ts`, `persistence/calendar-*.ts`, `persistence/indexes.ts`, `test/runtime/**`, `test/performance/calendar-tool-latency.spec.ts` | After U0; `calendar-loop.ts` edits only after the Task Phase A merge or rebased on it |
| **C Frontend** | Card, states, a11y, Canvas views, protocol use, tests | `frontend/src/features/plugins/google-calendar/**`, `features/canvas/calendar-*`, change-related parts of `use-chat.ts` | After U0 protocol; `use-chat.ts` and `MessageItem.tsx` after Task Phase A and Release 1 merge (shared files, additive edits only) |
| **D Task integration** | `task-tracker.ts` change proposals, prompts, Task tests | `chat-runtime/task-*.ts`, `TaskCard.tsx` | After Task Phase A merge |
| **E Verification** | Full checks, baseline-failure comparison, `verification.md`, `feature-status.md`, `operations.md` rollback note | docs only | End |

Parallel plan: U0 first (one agent). Then A, B and C in parallel (3 agents). D after the Task merge. E last. Shared central wiring (`app.service.ts`, `app.module.ts`) is not expected to change; if it does, one owner serializes.

## 8. What can start now vs later

- **Now:** this plan's decisions; U0 (calendar contracts do not overlap Task mode or Release 1 files); A (isolated provider adapter and fixtures); B recovery/operation/persistence work that avoids `calendar-loop.ts`, `memory-text.ts` and `durable-chat-runtime.ts`.
- **After Task mode Phase A merge:** `calendar-loop.ts`, `memory-text.ts`/`durable-chat-runtime.ts` wiring, `task-tracker.ts` (D), the Task-mode tests.
- **After Release 1 merge:** edits to `MessageItem.tsx`, `Transcript.tsx`, `chat-reducer.ts` that Release 1 also changes (rebase first; keep additive).
- **Baseline first:** record the known failing backend suites (feature-status.md: calendar assembly/HTTP/confirmation, multi-calendar integration, `compaction-runtime`, `session-affinity`); several are Calendar suites that would mask regressions in this exact path. Compare before and after; fix or isolate with their owners.

## 9. Risks

- Tool-list change affects prompt caching and the exact-tool assertions: bump the revision once, in U0, with `assertTools`, `assertCompositeTools`, adapter and tests together.
- Strict schemas mean rollback needs a drain (section 4).
- Delete has an unavoidable "inferred" outcome after an ambiguous send; the UI must be honest about it.
- Model asks for a change on an event it never read: the tool requires a prior read in the same turn or session memory (verify the etag came from a server read, never from model text).
- Provider quirks (instance IDs, cancelled-event GET semantics, `If-Match` on instances) need confirmation from primary Google documentation during unit A, and later a live drill that requires explicit authorization.

## 10. Email and document storage (lighter plan; nothing starts before decisions D5-D10)

**Principles (all must hold before implementation):**

- A separate plugin per provider, built like Calendar: server-side OAuth, encrypted credentials, per-user connection, default-off, readiness, revoke/disconnect semantics, the same operation ledger and durable pre-effect rules for every external write, and a proposal-and-approval card (approval enforced by backend policy, not model text).
- **Email and document content is untrusted data.** It is never instructions: it cannot change tools, recipients, scopes or the plan. Any send/share/write derived from content needs a human approval card that shows the exact recipients, subject and body (or document and change), bound to a proposal like Calendar. Retrieved content is quoted in context as clearly delimited data; links in it are not followed automatically; a step cannot add write actions to its own plan (Task rule).
- Least privilege: smallest scope that works; no broad mailbox or drive scope without a decision.
- Bounded context: the model gets snippets, not full mailboxes or drives; per-item and per-turn byte caps; no retention of bodies beyond the turn unless the user saves them; logs hold IDs only.
- No new storage or retention policy is implied by this plan; each provider needs an explicit retention statement before launch.

**Candidates (to be confirmed from primary documentation; not researched live here):**

| Area | Candidate | Notes and open points |
| --- | --- | --- |
| Email | **Gmail API** (same Google account and OAuth app as Calendar) | Natural fit. Read/send scopes are Google "restricted"; public production needs Google app verification and a security assessment, while local/test-user use does not. Smaller options: `gmail.compose` (drafts, send) and `gmail.readonly`/`gmail.metadata`. Sends have no idempotency key: ambiguity handling must rely on a pre-created **draft** (read-back by draft ID) rather than direct send. |
| Email | Microsoft Graph Mail | Needs a second identity and OAuth app; only if the audience is Microsoft 365. |
| Email | Provider-neutral SMTP/outbound-only | Simplest for "send", but no read, no read-back, and no sent-evidence; weak for reconciliation. |
| Documents | **Google Drive** with `drive.file` (per-file access to files the app creates or the user picks) | Non-restricted, least privilege, but needs a file picker flow and cannot search the whole drive. `drive.readonly` is restricted. |
| Documents | Microsoft OneDrive/SharePoint (Graph) | Same Microsoft identity question as above. |
| Documents | Notion or other note stores | Different model (blocks, pages); only if the user names it. |

**Decisions needed (section 11):** provider and account model (D5), scopes and read-vs-write phasing (D6), what may enter model context and how much (D7), retention (D8), prompt-injection stance and approval rules (D9), and sequencing (D10).

**Minimum design once decided (per plugin):** contracts for a read tool and a write tool (draft/send, create/update document) with proposal schemas, operation ledger reuse with `operationType`, pre-effect evidence and read-back by provider ID (draft ID, file ID/revision), recovery windows equivalent to W1-W4, an `Integrations` panel card for connect/disconnect, a Canvas view for drafts and document previews, rate and size budgets, deterministic fixtures. Each gets its own plan file (`docs/release-6/email.md`, `docs/release-6/documents.md`) and user approval before code. Suggested order after Calendar: documents read-only (lowest risk), then email read and draft, then email send and document writes.

**What must be true before implementation:** the decisions above are accepted; Calendar change is verified (this is the proving ground for the approval/recovery pattern); the Google OAuth app type and consent-screen status are known (test users vs verified); a Google primary-documentation review of scopes, quotas and read-back semantics is recorded; a retention and deletion statement exists; the prompt-injection test fixtures (hostile email/document text attempting to trigger a send or share) are written first.

## 11. Decisions

**Accepted 27 November 2026:** the user accepted every recommendation below as written.

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Recurring events | (a) single events and single instances only; (b) also entire series; (c) also "this and following" | **(a)** One approval, one effect, no series blast radius. Series later as a separate card with explicit wording. |
| D2 | Events with guests | (a) refuse and link to Google Calendar; (b) allow with notification choice | **(a)** for this release; revisit with a recipient-aware card. |
| D3 | `sendUpdates` | (a) always `none`; (b) a user choice per change | **(a)**, consistent with D2 (no guests, nothing to notify). |
| D4 | Delete wording and undo | (a) permanent, no undo promise; (b) promise restore | **(a)**; confirm text says the event is removed from Google Calendar. |
| D5 | Email and document provider | (a) Google (Gmail + Drive) only; (b) also Microsoft | **(a)**, reuses the Google OAuth app and account. |
| D6 | Email phasing | (a) read and draft first, send later; (b) send in first slice | **(a)**: a draft gives a provider ID to reconcile by and keeps the human in the final step. |
| D7 | Content allowed in model context | (a) subject/sender/snippet by default, full body only for one user-named item; (b) full bodies | **(a)**, with per-item and per-turn byte caps and no retained copy. |
| D8 | Retention | (a) no storage of content beyond the turn; (b) keep bounded excerpts with a TTL | **(a)** until a need is shown. |
| D9 | Prompt-injection stance | (a) all content is data; every write needs a bound approval card; (b) trust "known senders" | **(a)**, no exceptions. |
| D10 | Delivery order | (a) Calendar change release first, then documents read, then email; (b) all three in parallel | **(a)**: Calendar is already designed against a proven pattern; email/docs need provider decisions. |
| D11 | Tools shape | (a) separate `calendar_update_event` and `calendar_delete_event`; (b) one `calendar_change_event` | **(a)**: distinct schemas and annotations (delete is destructive), clearer audit. |
| D12 | Unattended Flows and changes | (a) not in this release; (b) allow with longer-lived proposals | **(a)** until the Flow approval window and proposal TTL are reconciled. |
| D13 | After an ambiguous send that did not apply | (a) mark `unknown`, user re-approves a new change; (b) auto-retry once with the same `If-Match` | **(a)**: matches the "never blindly replay" rule. |

## 12. Verification checklist

- [ ] Decisions D1-D13 recorded in this file.
- [ ] Baseline failing backend suites recorded before starting; compared after.
- [ ] `npm run build`, `npm run lint`, `npm test` in `backend` and `frontend`; `npm run test:e2e` where prerequisites exist. Skips reported separately; empty discovery is not evidence.
- [ ] All AGENTS.md "Tool execution critical path" required checks still pass, plus every section 6 name exists and passes (source presence alone is not a pass).
- [ ] Contract/migration checks: stored create documents still parse; rollback drain documented in `operations.md`.
- [ ] Frontend: change card states, a11y (keyboard, focus, live region), both themes, no success view for unknown/failed.
- [ ] Security review points: no credentials in `VITE_*`, no client identity, event/email/document text cannot trigger a write, logs hold IDs only.
- [ ] Native MongoDB suites (`AURVIN_TEST_MONGODB_URI`, isolated prefix) run or reported as skipped.
- [ ] Live Google checks (Calendar change drill, Gmail/Drive) are **not run** without explicit user authorization, a stated maximum request count and disposable test data; results recorded in `staging-evidence.md`, not here.
- [ ] `feature-status.md`, `release-plan.md` row, `docs/release-6/verification.md` and the final report updated; limitations stated (no Azure certification, no wall-clock SLA).
