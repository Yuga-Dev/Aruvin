# Calendar tool latency — approved goal

Date: 13 November 2026.
Status: **Approved by the user on 13 November 2026.** This is the approved outcome/scope, not an implementation design.
Workflow: **MAW, `--skip review`**. Goal approved; collaborative brainstorming is next.

## Objective

Make existing Calendar tools execute promptly after the model requests them by removing avoidable database and bookkeeping waits from the critical path. Apply the existing memory-first principle to tool execution without weakening authorization, privacy, duplicate prevention, or recovery of external effects.

“Instant” means minimal application-added delay, not zero CPU time or elimination of Google/network latency. Measure model-to-tool dispatch separately from provider response and result-to-continuation latency.

## Intended behavior

### 1. Calendar reads and availability

- Existing calendar discovery/listing, event listing/retrieval, and availability tools use warmed server memory for admission, account/target checks, finite budgets and immediate tool results where safe.
- On the prepared, valid-memory path, no application database reads, writes, ownership promotion, chat-save flushes, or graph checkpoints block provider dispatch, result delivery, model continuation, or next-turn eligibility.
- Keep essential argument/domain validation, correct account/calendar binding, consent/access checks, cancellation, deadlines, bounded concurrency/request/result/context budgets, and privacy/retention limits.
- Credentials/discovery refresh when actually needed; do not silently use invalid credentials, expired content, incomplete coverage as complete, or another account's state to meet a latency target.
- Cold, stale, recovery and invalidated paths remain explicit and safe; do not omit history or claim universal zero database I/O where hydration is necessary.

### 2. Calendar creates and future external-mutation policy

- Keep a minimal acknowledged durable pre-effect record binding the exact authorized action, account/calendar, stable operation/event identity and reconciliation information before creating an event.
- Never invoke the mutation if that durability barrier fails or is uncertain. Preserve duplicate/concurrency protection and reconcile uncertain outcomes without blindly repeating the create.
- Remove unrelated chat flushing, full accounting replay and redundant bookkeeping from that barrier wherever recovery correctness permits.
- Preserve existing conflict/availability and confirmation semantics. A model tool call or schema-valid payload is not, by itself, user authorization.
- Surface provider-confirmed results promptly and distinguish them from durable archive completion. Preserve enough evidence to recover a create that succeeded before a later save failed.

### 3. Asynchronous consolidated persistence

- Reuse the existing asynchronous persistence mechanism where possible. Consolidate nonessential transcript, tool-result and accounting persistence after the action/response rather than saving each intermediate step synchronously.
- Keep follow-up admission independent of unrelated saves, while ordering conflicting external actions and essential durability barriers correctly.
- Persistence must be tracked, bounded, ordered and failure-visible, not an unhandled fire-and-forget promise. Preserve shutdown/drain and recovery behavior.
- A consolidated save is one logical persistence operation/batch, not a promise of one physical database command or cross-collection atomicity. Retain bounded records and established collection responsibilities.

## Scope and exclusions

- Prioritize the existing Google Calendar read/availability/create paths and their existing text/live-voice integrations; do not add Calendar capability to a mode that does not already support it.
- Document the reusable policy distinction: local presentation/read-only tools versus externally mutating tools. Preserve the existing Canvas fast path.
- At the end of implementation and verification, update root `AGENTS.md` with the verified policy for future tool implementations: essential in-memory checks, no avoidable pre-tool persistence for reads/local effects, minimal durable pre-effect evidence for external mutations, tracked consolidated asynchronous bookkeeping, bounded failure handling, and runnable verification. Do not edit `AGENTS.md` during brainstorming or claim an unimplemented guarantee.
- No new tool framework, generic plugin rewrite, new Calendar update/delete tools, new dependency without demonstrated need, or multi-instance execution support.
- No removal of required authority/consent/retention checks, product-level conflict coverage reduction, automatic mutation replay, or exactly-once billing/effect claims.
- No model change, live/paid calls, application-data inspection or modification, external provisioning, backend restart, or deployment without separate authorization.
- Preserve concurrent user edits and older workflow records. This goal starts a new incremental workflow; it does not reopen or certify historical workflows.

## Acceptance criteria

1. **Prepared read dispatch:** production-route deterministic tests hold application persistence blocked and prove a valid warmed read/availability tool reaches its provider fixture without database work on that critical path.
2. **Immediate read continuation:** holding asynchronous archive saves does not block tool-result consumption, the next model dispatch, or eligible follow-up input. Preserve complete tool-call/result pairing and finite context bounds.
3. **Minimal mutation barrier:** tests distinguish essential pre-effect durability from nonessential bookkeeping; a blocked archive/accounting save alone does not gate a create once the necessary action evidence is acknowledged.
4. **Failure and recovery:** barrier failure/uncertainty prevents a create; successful-create/post-save-failure, uncertain delivery, duplicate requests, cancellation, retries and restart recovery do not silently reissue the external effect.
5. **Invalidation and isolation:** disconnect/reconnect, permission/target changes, expired content and cross-session/text/voice races cannot reuse invalid authority or expose stale/cross-account content.
6. **Measured application overhead:** record before/after database commands and sequential wait stages for reads, availability, direct create and proposal-confirmed create. Separate prepared/cold paths and synthetic measurements from any authorized live evidence; do not invent a wall-clock SLA.
7. **Regression evidence:** run relevant existing suites, builds and lint, plus integrated final verification. Report actual passes, failures, skips, baseline defects and environment limitations. Code review is **skipped**, never passed.
8. **Future implementation instructions:** the final `AGENTS.md` update records the verified tool policy, required tests and honest cold/recovery exceptions; it does not contradict the existing memory-first chat rule or promise zero network latency. Final verification includes consistency between instructions, implementation and evidence.

## Approval and next gate

The user approved this goal and requested the final `AGENTS.md` deliverable on 13 November 2026, then approved the architecture and safety/verification design sections and the complete written specification (`ba614a2`). **Research and the approved MAW planning/execution workflow are authorized.** The initial graph is recorded in [`state.md`](state.md); research will reconcile exact interfaces and ownership without weakening approved behavior.

## Brainstorming decisions recorded so far

- **Temporary background archive-save failure:** user selected "Continue reads within limits" on 13 November 2026. Read-only Calendar tools remain usable within existing memory/backlog bounds; save failures remain visible and unsaved state may be lost on process crash. Invalid authority, inconsistent/fenced state and exhausted limits still stop affected work. Creates retain their own acknowledged durable action barrier. This does not authorize indefinite unsaved operation or mutation dispatch during uncertain durability.
- **Architecture approved on 13 November 2026:** extend the existing memory-first runtime and Google Calendar executor rather than building a separate framework. Reads remain memory-first through result/continuation; creates retain narrowed durable action/reconciliation evidence rather than full chat/accounting promotion; reuse the bounded ordered asynchronous save mechanism. Preserve fresh conflict/approval behavior, explicit cold paths, distinct provider-confirmed/archive-saved states, and existing local Canvas behavior. Research and tests establish necessary physical writes.
- **Failure/recovery and verification section approved on 13 November 2026:** fail closed before mutation on uncertain durability; reconcile ambiguous dispatch with original identity; preserve provider-confirmed success across archive failures; reuse bounded retries/drain and stop affected admissions at safety/capacity limits; test real production routes, shared modes, invalidation and cold paths without bypassing guards.
- **Complete written specification approved on 13 November 2026:** user selected "Approve specification; authorize research", authorizing research and the approved MAW planning/execution workflow.

## Consolidated design

### Architecture and ownership boundaries

Extend the existing runtime, executor and persistence mechanisms. Do not build a second Calendar executor, generic tool framework or duplicate authority owner. Split execution by actual effect: local presentation, external read and external mutation. Existing local Canvas execution remains unchanged except regression protection.

Keep provider integration responsible for API/credentials, runtime responsible for turn/operation ordering and finite in-memory accounting, and persistence responsible for acknowledged action evidence and eventual archives. Exact interfaces and required database commands are research/planning deliverables; these responsibilities and acceptance gates are fixed.

### Prepared reads and continuation

Prepare account identity, credentials and target/discovery metadata ahead of input when existing lifecycle hooks allow it. The prepared path performs essential synchronous/in-memory checks, reserves finite in-memory request capacity, then invokes the existing provider executor without durable promotion. Remove blocking store reads throughout the real invocation chain, not merely in CalendarLoop.

Keep complete native call/result pairs and permission/expiry provenance in bounded turn/session memory. Once a valid result is returned, the model can continue and eligible follow-ups can be accepted without waiting for tool-result, transcript, accounting or checkpoint persistence. Expiry/invalidation must still be applied when context is consumed and when output is published. A turn that reads and subsequently creates crosses the mutation boundary only for the create.

Cold credentials/discovery, process restart, stale/expired state and unsupported legacy history are explicit refresh/hydration or safe-unavailable paths. No history dropping, stale authority, forged complete coverage or silent fallback may make a zero-I/O assertion appear true. Provider reads still require network time and may require legitimate credential/discovery refresh.

### External mutation boundary

Bind the precise validated action, account/target, accepted user authorization or consumed proposal revision, stable operation/provider-event identity, and reconciliation state into minimal durable evidence before dispatch. Reuse established operation identity and reconciliation behavior. The essential evidence must not depend on unrelated transcript saves or wholesale accounting replay becoming durable first.

No mutation is sent unless the necessary barrier is acknowledged. Recheck current authority, cancellation, deadline and action identity immediately before dispatch. Preserve existing capability, availability/conflict and proposal-consumption semantics. Maintain one active attempt per session, existing single-process/database executor ownership, and ordered conflicting mutations; do not weaken these to eliminate a wait.

Research must establish whether existing operation records can meet this contract directly or need a narrowly scoped versioned extension. No new collection, transaction assumption, universal one-write claim or exactly-once guarantee is approved here. Any change to persistent formats must specify compatibility and recovery of existing records.

### Publication, failures and recovery

Expose a provider-confirmed action result without waiting for unrelated archive projections, while keeping action outcome and archive save status distinguishable. A failed archive cannot turn a confirmed create into a fresh create request. Do not add model narration/re-execution to recover a saved external result.

After an ambiguous delivery, retain the original operation identity and reconcile by readback; never automatically issue a new create. Keep unresolved mutation evidence pinned until resolved or safely handed off. Define crash points before the barrier, after the barrier/before send, after send/before outcome recording, and after provider confirmation/before archive saving. Each must have a tested safe recovery outcome, without assuming cross-collection atomicity.

Disconnect/reconnect, changed target/access/config and retention expiry invalidate the affected memory authority and publication. In-flight results from invalidated authority cannot be reintroduced as current content. Do not rely on a TTL alone for in-process consent revocation.

### Consolidated asynchronous saving

Reuse existing memory-first save envelopes/queues and privacy projection rules. Extend their data coverage only as needed for complete Calendar evidence. Coalesce nonessential results, transcript and accounting into bounded ordered save work after the action/response. This is a logical batch, not necessarily one database command.

Keep existing queue/byte/age limits, finite retries, visible failed/unknown save states and tracked shutdown/drain. A transient archive failure alone does not block reads while safe memory and capacity remain. Inconsistent/fenced state or exhausted bounds stops affected admissions rather than growing memory indefinitely. Essential mutation records are not evicted or replaced by eventually saved transcript evidence.

### Verification and final instructions

Use actual production runtime/executor/store boundaries with deterministic provider fixtures and observable/blocked persistence. Tests must assert both absence of forbidden storage and presence/order of necessary mutation durability. Trace all callers of modified shared helpers. Retain existing collection/document/context bounds, safe Markdown/rendering, identity isolation and text/voice behavior.

Measure prepared and cold paths separately for read, availability, direct create and proposal confirmation; record database commands, blocking waves and result-to-continuation timing with the fixed fixture/environment. Capture baseline failures before changes, and distinguish new defects from reproducible existing failures. Required regressions, integrated tests, build/lint and meaningful suite results remain completion gates despite skipped review.

After implementation and evidence exist, add compact enforceable instructions to root `AGENTS.md` for future tools, using the repository's instruction-writing skill. Cover read/local/mutation distinctions, mandatory versus redundant checks, minimal durable external-effect barriers, asynchronous persistence/failure bounds and runnable critical-path/recovery checks. Keep honest preparation, refresh, recovery and service-latency exceptions. Final document consistency checking verifies these instructions match implemented behavior; they must not claim readiness that testing does not establish.
