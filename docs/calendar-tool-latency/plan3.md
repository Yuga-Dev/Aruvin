# P3 Minimal Calendar Mutation Barrier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use the installed `executing-plans` and `test-driven-development` skills. The MAW orchestrator assigns the worker; do not dispatch another worker or reviewer.

**Goal:** Acknowledge only the durable authority, accepted-input, budget and operation evidence required before a Calendar create, independently of unrelated archives, while preserving ordered publication and non-replaying crash recovery.

**Architecture:** Keep `CalendarOperationWriter` as the sole create state machine and P1 as the sole connection-authority owner. Extend the existing memory runtime with a narrowly scoped mutation barrier that uses the admitted executor, the existing session active-attempt CAS and immutable operation identity, without joining the archive owner's shared queue. Keep nonessential native evidence and transcript publication in the existing bounded ordered saver; recovery discovers operations independently of graph checkpoints and never treats `dispatching` as permission to POST again.

**Tech Stack:** Existing Node.js/TypeScript ESM/NodeNext, NestJS composition, MongoDB repository ports and fake driver, Zod contracts, LangGraph and Vitest; no new dependency, collection, transaction, generic tool framework or multi-instance protocol.

---

## Authorization, prerequisite gate and planning evidence

- Read inputs: approved [`goal.md`](goal.md), [`state.md`](state.md), [`research.md`](research.md), [`plan1.md`](plan1.md) and [`plan2.md`](plan2.md). Research is `b66fe00`; P1 implementation is `67bb366`; P2's **plan**, not implementation, is `86253c3`. Inspected planning HEAD: `3ee809d85407cf7ccf5ab21df2fcc72f78c81025`.
- **Latest user instruction overrides stale state paragraphs: P2's worker was cancelled. Do not restart it unless the user later explicitly asks.** The user authorized P3 planning ahead of P2, not P3 execution. This document does not authorize starting any worker.
- **P3 worker remains blocked:** require an explicitly authorized/completed P2 implementation, its commits/check results, a serialized shared-file handoff and reconciliation of assumptions M1–M6 below. A P2 plan, dirty source resembling its plan, or cancelled-worker partial output does not satisfy this dependency. Do not execute P2 tasks from P3.
- Planning writes/commits **only `docs/calendar-tool-latency/plan3.md`**. Do not edit goal/state/research/other plans, source/tests, current dirty work or `AGENTS.md`. Do not start P3 after this commit. The orchestrator owns status reconciliation.
- The checkout contains many unrelated backend/frontend changes, including shared runtime/archive files and `calendar-memory-first.spec.ts`. These are not an implementation handoff. Before future edits, inspect named-path diffs; stop on ambiguous overlap rather than replacing or staging another person's changes. No separate worktree is requested.
- No live provider/service/database calls, application-data access, paid checks, backend restart, provisioning or deployment. Future commands below use deterministic in-process fixtures with native-test credentials cleared. Code review is **skipped**, never passed; testing, compatibility checks and correction of introduced defects remain required.
- P1 reported build/capability-suite failures on a dirty shared checkout. Do not call them independently established baseline defects. Capture the actual completed-P2 baseline before implementation and route upstream defects to their owner.

## P2-dependent assumptions: reconcile before worker dispatch

| ID | Assumed completed-P2 interface/behavior | Required reconciliation evidence |
| --- | --- | --- |
| M1 | `CalendarLoopContext.memory.readAccount()` lazily pins the prepared account; `ctx.memory` remains available for native memory reads; ordinary/Canvas inference makes no account call. | Completed P2 source and prepared/ordinary tests. P3 obtains fresh mutation authority at the requested action, never before ordinary model dispatch. |
| M2 | `MemoryCalendarLedger` provides finite idempotent logical/create debits, request/refresh counters, `deadlineAt()`, `snapshot()` and `aggregate()`; mutations still conservatively promote. | Read-then-create and retry budget tests; exact signatures and configured lower limits. Do not assume zeroed counters on entry. |
| M3 | P2's terminal saver retains ordered jobs, immutable privacy commitments, raw-write tracking, erasure projection, retry/backoff/age/bytes limits and save-only checkpoints. | P2 archive/foundation handoff; no replacement saver or untracked promises. P3 adds foreground ownership isolation without undoing privacy behavior. |
| M4 | Native v2 read/local publication binds immutable `attempt.nativePublication`; native state intentionally rejects operation/intent/proposal-bearing results. | Prove the prefix/native-versus-mutation split below with real archive and cold-reader tests before using it. Never add mutation IDs to P2's read schema or change a committed hash opportunistically. |
| M5 | P2 maintains safe current-turn native decisions separately from sanitized archive copies, complete history pairing, expiry and synchronous scoped invalidation. | Preserve live-versus-archive decision distinction and anchored erasure across creates. Raw volatile arguments must not enter new queue fields. |
| M6 | All P2-owned shared files/tests are handed off sequentially and P1's fresh-default authority contract remains unchanged. | Actual commits, diff reconciliation and named test/build results. Missing capability, type or integrity support is a dispatch blocker, not permission to edit outside ownership. |

If an assumption is false, report the exact interface conflict to the orchestrator and reconcile this plan/ownership before implementation. In particular, do not restart cancelled P2, silently widen contracts, relax native integrity, or create another runtime to make a test pass.

## Exact ownership and file map

### Production paths P3 may modify after its start gate

| Path | Responsibility |
| --- | --- |
| `backend/src/chat-runtime/calendar-operation.ts` | Structural writer ledger port; shared fresh planned-dispatch validation; acknowledge planned/dispatching/outcome events; no blind replay. |
| `backend/src/chat-runtime/calendar-recovery.ts` | Bounded checkpoint-independent discovery; exact planned recovery or safe interruption; original-ID readback; repair missing matching transition event. |
| `backend/src/chat-runtime/calendar-publication.ts` | One receipt/privacy projection for live confirmed evidence and durable recovery; missing prose never negates success. |
| `backend/src/chat-runtime/calendar-preflight.ts` | Reuse exact server-owned coverage/condition policy for direct, proposal and planned recovery; no weaker recovery preflight. |
| `backend/src/chat-runtime/durable-chat-runtime.ts` | Discover/reconcile minimal-barrier attempts without prepare/seal checkpoints; preserve legacy graph recovery and stopped-owner gates. |
| `backend/src/persistence/calendar-operations.ts` | Reuse scoped operation/event queries, authority and CAS; repair only exact missing event evidence; no new effect retry edge. |
| `backend/src/persistence/sessions.ts` | Narrow active-attempt claim/check/release independent of archive lease; bounded recovery candidates; preserve lifecycle and publication fields. |
| `backend/src/chat-runtime/calendar-loop.ts` | **Sequential P2 handoff:** narrow actual create/consumption boundary, non-create proposals, independent writer callbacks, prompt live result. |
| `backend/src/chat-runtime/memory-text.ts` | **Sequential P2 handoff:** accepted evidence/barrier adapter, stable prefix commitment, tracked mutation settlement, memory completion without promotion. |
| `backend/src/chat-runtime/memory-first-foundation.ts` | **Sequential P2 handoff:** scoped pause/resume and bounded data-only mutation archive extension; unchanged ordered publication and drain. |
| `backend/src/persistence/memory-text-archive.ts` | **Sequential P2 handoff:** retryable active-mutation contention, immutable accepted-attempt completion, deferred mutation evidence and monotonic prefix CAS. |

### Focused test ownership

- Modify `backend/test/performance/calendar-memory-first.spec.ts` only after P2 hands it off: real archive lock, direct/proposal/mixed creates, bounded post-outcome save and shared text/live races. Reuse its local `nativeFixture`, `readWires`, `toolIds` and P2's assembled provider fixture.
- Modify `backend/test/performance/memory-first-foundation.spec.ts`: scoped pause/retry/drain and dirty-prefix version order.
- Modify `backend/test/performance/memory-text-archive.spec.ts`: active marker races, generating-attempt settlement, prefix watermark and immutable dependency checks.
- Modify `backend/test/runtime/calendar-operation.spec.ts`: actual writer's planned checks, event acknowledgement and duplicate state classification.
- Modify `backend/test/runtime/calendar-multi-recovery.spec.ts`: checkpointless crash matrix, consumption repair and session discovery.
- Modify `backend/test/runtime/calendar-recovery.spec.ts` and `backend/test/runtime/calendar-confirmation.spec.ts`: existing receipt/readback/confirmation guarantees, plus new minimal-route assertions.
- Modify `backend/test/persistence/calendar-multi-operations.spec.ts`: exact operation/event commands, missing-event repair, unresolved overflow and authority isolation.
- Create `backend/test/persistence/calendar-mutation-session.spec.ts`: narrow session claim/check/clear and recovery-page tests using the existing fake driver. Add the mandatory code-file header on first write.

Reuse fixtures read-only: `backend/test/runtime/calendar-runtime.fixture.ts`, `calendar-multi-fixture.ts`, `backend/test/persistence/calendar-multi-memory.ts`, `calendar-multi-fixtures.ts`, `backend/test/performance/dependency-probe.ts`. Put small test helpers inside owned specs. Do not expand fixture fail-point enums just to save a local spy.

No ownership of `calendar-budget.ts`, `memory-calendar-ledger.ts`, `memory-calendar-state.ts`, `calendar-history.ts`, retention/reader modules, `ownership.ts`, shared contracts/manifests, provider/assembly files, voice implementation or frontend. Request a serialized owner handback for a proven incompatible interface; do not edit them unilaterally. P4 owns `backend/test/performance/calendar-tool-latency.spec.ts`, final evidence documents and root `AGENTS.md`.

## Fixed design: minimum evidence, not minimum acknowledgement

### 1. Reuse existing identities and distinguish the two storage owners

`MemoryTextArchive.project()` currently holds `execution.ownerId` and `MongoOwnership.run()`'s **process-wide exclusive tail** while awaiting message/manifest/checkpoint storage. Merely removing `flushSession`, releasing one lease early, or pausing future saves cannot unblock a foreground `owner.acquire/run` already queued behind that tail. Do not steal/release an in-flight archive lease or pretend a timed-out raw write was cancelled.

Use the existing active-attempt slot for the narrow memory-mutation lane, independently of the archive's owner lease. The existing memory foundation, reservation and `WorkRegistry` still admit one current text/live attempt per session. Add three concrete `MongoSessions` methods, not a second `ExecutionOwnership` implementation:

```ts
export type CalendarMutationHandle = Readonly<{
  userId: string; sessionId: string; attemptId: string; generation: number;
}>;

beginCalendarMutation(input: {
  userId: string; sessionId: string; attemptId: string; executorId: string;
  archiveOwned: boolean;
}): Promise<CalendarMutationHandle>;
assertCalendarMutation(handle: CalendarMutationHandle, executorId: string): Promise<boolean>;
finishCalendarMutation(handle: CalendarMutationHandle, executorId: string): Promise<void>;
```

`archiveOwned` is a trusted in-process assertion from the actual `MemoryTextArchive` instance: expose `ownsSession(userId, sessionId): boolean` from its tracked raw projection/lease state, set before its first acquisition await and clear only after raw settlement/release reconciliation. It is **not** a client value or an inference that every same-executor owner is an archive. A non-null owner is accepted only when it is this executor's verified archive; otherwise conflict. Reconcile the acquire-start/claim race: once a mutation claim wins, any archive acquisition that was already admitted must fail/retry or remain the known archive owner, never create another foreground owner.

Claim is a scoped read followed by one conditional session update matching active lifecycle, observed generation, active slot null (or this exact attempt for idempotent confirmation), and observed owner. Set **only** `execution.activeAttemptId`; do not change archive owner/lease/generation or `memoryPublication`. A successful acknowledgement requires `acknowledged && matchedCount === 1`; an ambiguous result requires exact scoped readback before any effect. Re-check generation and owner provenance on a repeat claim; an arbitrary existing attempt is not a reusable handle. `assert` matches lifecycle, generation and the exact active attempt; owner may have become null through the archive's legitimate release. A new recovery generation fences the handle.

Every essential write uses a local callback in `MemoryText`, with the same admitted executor and tracked `Work`, not `owner.run`, `runPhase`, `acquire` or `drain`:

```ts
const write = async <T>(action: () => Promise<T>): Promise<T> => {
  native.job.check();
  await p.owner.assertExecutor();
  if (!await p.sessions.assertCalendarMutation(handle, p.owner.executorId))
    throw new AppError('INTERRUPTED', 'Calendar execution ownership was lost.', false);
  const result = await native.job.wait(action(), timeout);
  native.job.check();
  return result;
};
```

The callback is server-private and available only after the real runtime's memory/work/reservation ownership checks. Keep the configured guarded client/local mutation journal underneath; do not construct a raw client/store to avoid fencing. Add `ponytail:` documentation: admitted single executor, one memory turn/session, archive lease is independent; multi-process execution would require a different durable owner protocol. If the journal or essential storage itself is unavailable, fail closed; the independence guarantee concerns **unrelated archive work**, not bypassing a real durability fence.

### 2. The acknowledged pre-POST contract and physical-operation inventory

Use this order; each arrow is an acknowledgement/check boundary, not a transaction:

1. Validate accepted user intent, action hash, exact account/target binding, evidence permission and pinned user/session identity in memory. A model call alone is not consent.
2. Fresh current account and target capability, full server-owned availability/preflight, proposal revision/condition/expiry and cancellation/deadline checks. Charge actual preparation requests against finite memory counters. Clarification may stop here without a create.
3. Pause **future** saves for this session synchronously; bootstrap its session if absent, with `memoryPublication.version = 0`, then claim the active-attempt slot through the independent lane. Existing raw archives stay tracked and may settle.
4. Confirm the current accepted input, its attempt in `generating`, matching acceptance marker, ordering high-water counter and recovery discovery pointer. For a proposal reply, persist this evidence **before** consuming authority. Do not persist prior turns to obtain it.
5. Confirm single-use explicit intent reservation or exact proposal consumption; initialize/reuse the existing mutation budget, seed only safety counters, debit one create, reserve exact `planned` operation and append its matching event.
6. Recheck current authority, owner handle, action identity, cancellation and original deadline immediately before `dispatching` CAS; acknowledge its matching event. P1's create executor still performs fresh authority/target checks at provider admission and charges each actual delivery.
7. Only then send one POST using `calendarEventId(operationId)`. Neither an uncertain barrier nor an acknowledged `dispatching` recovered later is a dispatch permit.

Research's accepted input/attempt/acceptance minimum is retained, but its physical implementation must be proved. Reuse `nativeInput`, `attempt`, `appendConfirmed`, `putAttemptConfirmed`, `acceptanceSchema`, `counterSchema`, stable keys and bounded encoding. `putAttemptConfirmed` accepts a valid initial generating record; do not add an unnecessary accepted-to-generating write if no observer requires it. `confirmAcceptance` currently enters the shared queue, so reproduce its **receipt verification and exact marker shape** in the narrow adapter, not an unchecked acknowledgement. Verify receipts with `inspectConfirmedRecord` against the same store, input/attempt scope, accepted role, causal message, turn, payload hash and attempt ID; then insert the marker through `store.insertConfirmed`. Never mint a `ConfirmedRecord` from memory.

The sequence `$max(next, turn.sequence + 3)` is necessary before releasing discovery ownership: a crash must not allow a later durable allocator to reuse the accepted message/attempt sequence. The acceptance discovery update sets `latestTurnId` under the exact mutation handle; it never advances the archive watermark. Coalesce those two fields only if a real single-document update covers them; they presently live in different collections, so assume separate commands.

| Primitive, inspected source | Normal-path physical commands to account for | What may be removed/deferred |
| --- | --- | --- |
| `sessions.createIfAbsent`, only when absence is established | Scoped read; insert-confirm path; extra exact read on duplicate/ambiguity. | No bootstrap for an already established durable session; never replace a nonzero watermark with zero. |
| Mutation slot claim/check/clear | Scoped read + conditional update for claim; exact readback on ambiguity; scoped guard reads and conditional clear. Executor assertion is a separate metadata read. | No archive flush, lease acquisition, shared ownership-tail wait or lease theft. |
| Input / generating attempt / acceptance | Input confirmed insertion; attempt identity lookup + confirmed insertion; marker confirmed insertion; ambiguous/existing payloads require exact readback. | No redundant lifecycle transition when initial generating insertion is valid. No prior inputs/attempts. |
| Ordering / discovery | Metadata counter `$max`; session pointer CAS with scope/generation/attempt. | No manifest or graph prepare/boundary write. |
| Mutation budget and debit | Existing `getBudgetConfirmed/createBudgetConfirmed`; safety-counter CAS if needed; `debit` budget CAS plus its separate debit record acknowledgement. | No prior model dispatch reservations/settlements, decision/result replay or model-money projection. |
| Direct `reserveByIntent` today | 7 reads + 2 writes on its new direct-intent path: existing-intent, turn, legacy-unresolved, connection; intent upsert/read; operation upsert/read; post-insert account check. | Do not remove adapter authority/redaction checks just to meet research's speculative 2–3 connection-read estimate. |
| Proposal consume/reserve | Existing proposal CAS, consumption wrapper and intent reservation confirmations; reserve verifies wrapper/expiry/reservation and account. | Never replace confirmed consumption with a model flag or a memory-only boolean. |
| `appendEventV2` today | Existing-events read + matching-operation read + event upsert + exact event read: 3 reads, 1 write for a new event. | No duplicate event append after it has been exactly confirmed. |
| `compareAndSwapV2` today | Current-operation read + conditional replacement; exact read on ambiguous result. | Keep immutable action/account/event identity and revision/state checks. |
| Planned -> dispatching | Operation CAS plus event acknowledgement above. | No prepare/calendar-decide/calendar-execute checkpoint, retention registration, prose save or archive projection. |

Counts above describe inspected primitives, **not a fixed complete create total**. Count command starts as well as completions (a held command is still a dispatched command), logical calls separately, and provider HTTP separately. Fresh capability/discovery/credentials, proposal versus direct paths, bootstrap, duplicates, privacy checks and ambiguous readback change totals. No one-write, majority-topology or cross-collection atomicity claim follows from fake-driver acknowledgement.

Run removal/failure experiments for each row: omit/hold one mandatory acknowledgement and prove no POST; hold each nonessential store and prove POST/result completion remains possible. If a write can be removed without breaking acceptance/recovery/budget invariants, remove it instead of retaining it on the authority of research. Conversely do not delete evidence simply because the happy-path fixture still creates.

### 3. Keep model/read accounting in memory; persist only mutation safety counters

Do not convert the whole loop to `CalendarTurnLedger`. Keep the P2 memory ledger for inference/read accounting and all immediate tool groups. In `calendar-operation.ts` change the writer option's nominal ledger type to the actual structural methods it uses:

```ts
type CalendarOperationLedger = Pick<CalendarTurnLedger,
  'ensureBudget' | 'deadlineAt' | 'chargeLogicalTool' | 'chargeCreate'
  | 'chargeCalendarRequest' | 'chargeRefreshRequest'>;
```

Use an existing `CalendarTurnLedger` instance solely for the mutation budget, created inside the memory adapter with the independent `write`/fence callbacks. `ensureBudget` may inspect whether durable dispatch rows exist; it must not replay them. Seed only absolute monotonic logical/request/refresh counts with `consume`; keep durable model counters/money unchanged. Preserve configured lower limits through the real memory ledger and durable ledger, not just absolute store ceilings. Keep the original deadline from memory or an existing durable budget; never extend it on retry/restart.

The seed excludes already mirrored creates, so retries cannot add them twice:

```ts
const active = native.ledger.snapshot().budget;
const persisted = await mutationLedger.ensureBudget();
await mutationLedger.consume({
  logicalTools: Math.max(persisted.logicalTools, active.logicalTools - active.creates),
  calendarRequests: Math.max(persisted.calendarRequests, active.calendarRequests),
  refreshRequests: Math.max(persisted.refreshRequests, active.refreshRequests),
});
await mutationLedger.chargeCreate(intentId);
await native.ledger.chargeCreate(intentId);
```

Skip the counter CAS when no value changes. A durable debit acknowledgement failure cannot send a POST; the exact debit identity can be reconciled on retry. Before the create is debited, capability/preflight and non-create clarification charge the memory ledger. After barrier admission, each actual create/readback request charges the original durable mutation budget and mirrors its finite count in memory; duplicate operation lookup does not debit or send again. Do not replay a provider read to reconstruct a count. A resumed planned operation reuses its existing debit, remaining request budget and original deadline.

### 4. Preserve immutable native commitments without changing P2's read schema

P2's native record excludes mutation IDs, and `AttemptRecord.nativePublication` is immutable under `compareAttemptConfirmed`. Therefore **do not add a native hash after inserting the generating attempt**, and do not mutate an existing native budget/result to include a later create.

At the actual mutation boundary, freeze a privacy-projected native prefix containing completed local/read pairs and terminal model-dispatch accounting already obtained. Keep the pending physical-create decision/result separate; do not put an unmatched create call in native history. Bind the prefix's native publication hash in the first generating attempt, using P2's existing integrity/publication helpers and the eventual envelope epoch/version/fence. Preserve that exact prefix and anchored erasure commitment through completion/retry. The current schemas permit dispatch accounting whose terminal decision is stored separately; verify that with the completed-P2 reader, not an assumed hash bypass. If the prefix is empty, omit its native dependency.

For a non-create clarification/refusal, use P2's genuine `terminalCall` marker in the native prefix instead of archiving an unmatched legacy create decision. Classify the branch and mark its terminal call before freezing any acceptance dependency. After accepting/consuming a proposal on the new memory lane, seal a changed-condition clarification with the existing server-owned `busyFact`/disclosure text; do not dispatch a new narration model request whose evidence would no longer fit the pinned prefix. Keep the legacy durable narration route unchanged. This does not change the configured model or reduce conflict/confirmation coverage; assert the same disclosed condition and user-facing authority semantics. A successfully created event already uses fixed server-owned narration and needs no further model call.

Add one bounded, data-only optional field on `MemoryTerminal`/`TerminalEnvelope` in the owned foundation module:

```ts
calendarMutation?: Readonly<{
  decision: ResumableSkillDecision | null;
  result: CalendarToolResultRecordV2 | null;
  aggregate: CalendarModelAggregate | null;
  operationId: string | null;
}>;
```

Use existing strict schemas for these members. Proposal-reply creates can have no native model call/decision; do not fabricate one. Direct creates retain their exact call/result linkage. This extension carries deferred archival data, **not authority, callbacks, handles, receipts, tokens or a second operation record**. Operation/account/intent authority remains in existing durable stores. Validate full user/session/turn/attempt/decision/call linkage and configured bytes before queuing. The aggregate is the final model/connector accounting projection; the prefix budget is a committed pre-mutation snapshot, not the authoritative create budget or an amount to sum again.

Archive the pending create decision/result through `skillDecisions.put` and `calendarResultsV2.put` in the same logical terminal job after response, plus the existing retention source registration when there is a result source. Cold history already knows those legacy joins. Keep prefix read/local pairs in its one native record; no duplicate create call in that record. No wholesale dispatch replay or new mutation collection.

Do **not** call `calendarAccountingV2.putAggregate` for a memory-native attempt: its current implementation requires separately persisted dispatch rows and would reject this design. In the archive's existing bounded immutable `ensure`, validate `modelAggregateSchema`, exact attempt/turn/user/session and `aggregate.dispatchIds` against the already committed prefix's dispatch records, recompute the existing ledger aggregate from those terminal observations plus final connector counters, then ensure the existing `calendar-model-aggregate` document/key directly. This is a projection of acknowledged native evidence, not fabricated model dispatch reservations or a loosened shared accounting adapter. Add a cold accounting test proving the preferred aggregate is returned once and its dispatch evidence is the hash-bound native dependency. If an existing consumer requires individual model-dispatch rows rather than that native dependency, stop for owner/interface reconciliation instead of replaying them before POST.

Count the actual additional repository/driver commands within the existing **32 logical operations/save** and encoded-byte budget; eliminate redundant archive reads/ensures rather than increasing limits. If the committed P2 save budget leaves insufficient capacity, report a concrete count/ownership conflict before widening the design.

Before adding a field, prove it is needed: a result can be reconstructed from an immutable operation receipt only if the existing schemas and privacy/lifetime rules permit that exact projection. Prefer the existing result object when it avoids invented evidence. For volatile/source-derived decisions use P2's sanitized archive copy, never its raw live pending decision. Reuse expiry/account erasure projection before a queued retry and after a held write settles; preserve P2's immutable commitment and never revive Calendar canaries through this extension.

### 5. Dirty-prefix and post-outcome semantics

- `pauseSession` prevents new archive dispatch/retries for this session while authority consumption/barrier work is active; it does not wait for or cancel an existing raw write. Resume in a tracked `finally` after essential mutation work settles. A nested pause or stale/wrong-user handle fails; use one active mutation/turn, not an unbounded pause map or another queue.
- A background archive observing another active attempt returns `{ kind: 'unknown', retryable: true }`, not a permanent failure/fence. Recheck the active marker in final publication CAS, including the race where it was set after archive acquisition. It may stage idempotent dependencies but cannot advance the watermark during the conflicting claim.
- An existing raw archive may hold its lease/global ownership tail throughout a delay. The independent create lane never waits for that lease/tail and never releases it. Its own essential raw work remains tracked by `Work`; timeout/cancellation does not drop ownership or authorize an overlapping retry.
- After confirmed operation outcome/event, clear only the mutation active-attempt slot through its exact handle, without touching the archive owner. Keep unknown/planned/dispatching operations durably discoverable and locally pin conflicting mutations until resolved. A succeeded operation is never evicted with a failed prose save.
- Emit the confirmed operation view and fixed `createdEventText` immediately after essential outcome acknowledgement, using already confirmed operation/event evidence; no live projection DB reread, retention/result write, manifest or checkpoint is awaited. Leave `receipt.durable` meaning operation evidence durability, not transcript durability. Emit normal memory completion with truthful `save: pending/unknown/failed` and preserve live terminal hearing rules before next-turn eligibility.
- Always use `foundation.complete` for this new memory mutation route, clean **and** dirty prefix; do not introduce a special clean synchronous promotion optimization. `commitPromoted` retains its strict clean-prefix contract for legacy promotion only. This avoids a new fast/slow publication fork.
- Archive completes an existing generating attempt through confirmed `generating -> finalizing -> terminal` transitions, rather than immutable reinsert. Its initial native dependency must already match; identity, payload, reply reference, model/config, causal IDs and sequence cannot change. A terminal attempt is reused only when its exact terminal payload matches. No terminal regression or silent generating-record overwrite.
- Prefix watermark advances one version at a time, `0 -> 1 -> ... -> k`; acceptance of create `k` does not publish unsaved `0..k-1`. Older archive publication must not overwrite `latestTurnId` of a later durable accepted mutation. Read the current referenced attempt's sequence in background and preserve the newer pointer; CAS the observed pointer/publication version to close races. Never use `$max` on a hashed turn ID.
- If the process crashes with a dirty gap, preserve the create receipt and return it through operation projection/repetition. Lost unsaved text may remain unavailable; do not manufacture missing history or advance the watermark over a gap to reopen chat. Safe-unavailable cold hydration is honest, whereas receipt lookup and reconciliation must still work.

## Task 1: Capture the actual baseline and reproduce the real archive-owner stall

**Tests:** `backend/test/performance/calendar-memory-first.spec.ts`.
**Production changes in this task:** none until the red check exists.

- [ ] **Step 1 — Verify the start gate and record exact checkout state.** Run separately at repository root: `git status --short --branch`, `git rev-parse HEAD`, `git diff -- <each dirty owned path>` and `node --version`. Obtain serialized commit ownership. Clear the native-test variable without printing it:

```powershell
Remove-Item Env:AURVIN_TEST_MONGODB_URI -ErrorAction SilentlyContinue
```

- [ ] **Step 2 — Run focused baseline in `backend/`.**

```powershell
npm test -- test/performance/calendar-memory-first.spec.ts test/performance/memory-text-archive.spec.ts test/performance/memory-first-foundation.spec.ts test/runtime/calendar-operation.spec.ts test/runtime/calendar-confirmation.spec.ts test/runtime/calendar-recovery.spec.ts test/runtime/calendar-multi-recovery.spec.ts test/persistence/calendar-multi-operations.spec.ts
```

Record actual discovery/counts/failures and elapsed environment, not research's old numbers. Load `systematic-debugging` for unexpected failures. Do not classify a dirty-file failure as pre-existing without reproducing it on the relevant completed prerequisite commit.

- [ ] **Step 3 — Add this failing regression to the handed-off performance spec.** Add `createWires` locally, using existing fixture exports. Do not replace authority/ownership gates. Holding `p.memory.put` deliberately holds the actual archive's session lease **and global `owner.run` tail**:

```ts
function createWires(callId = 'minimal-create') {
  return [skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_create_event'] }, `${callId}-load`),
    createWire(event(), callId)];
}

it('creates and completes while an earlier archive owns the shared persistence tail', async () => {
  const f = await nativeFixture();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { reached = r; });
  const put = f.p.memory.put.bind(f.p.memory);
  const blocked = vi.spyOn(f.p.memory, 'put').mockImplementationOnce(async manifest => {
    reached(); await held; return put(manifest);
  });
  let run: Promise<void> | undefined;
  f.modelWires.push(textWire('Earlier answer'), ...createWires());
  try {
    const first = await f.submit('Earlier question'); await f.execute(first); await entered;
    const owner = await f.p.sessions.get(f.identity.userId, first.sessionId);
    expect(owner?.execution.ownerId).toBe(f.p.owner.executorId);
    const next = await f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', first.sessionId);
    run = f.execute(next);
    await vi.waitFor(() => expect(f.effects.filter(e => e.kind === 'create')).toHaveLength(1));
    await vi.waitFor(() => expect(f.status(next)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } }));
    expect(f.modelBodies).toHaveLength(3);
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(await f.runtime.drain(20)).toMatchObject({ drained: false });
    release(); await run; await f.saved(next);
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.session(next.sessionId))
      .toMatchObject({ version: 2, durableVersion: 2, fenced: false });
  } finally {
    release(); await run?.catch(() => undefined); blocked.mockRestore(); f.runtime.stopAccepting();
  }
});
```

- [ ] **Step 4 — Run red.** `npm test -- test/performance/calendar-memory-first.spec.ts -t "creates and completes while"`. Expected: bounded assertion timeout, no create while the old archive is held; not zero discovery or an accidental real service call. Preserve this test's real held-lock setup through green.

## Task 2: Implement scoped mutation ownership and archive scheduler isolation

**Modify:** `backend/src/persistence/sessions.ts`, `backend/src/chat-runtime/memory-first-foundation.ts`, `backend/src/persistence/memory-text-archive.ts`.
**Test:** new `backend/test/persistence/calendar-mutation-session.spec.ts`; existing foundation/archive specs.

- [ ] **Step 1 — Write this complete claim/clear red test before the helper.** In the new spec, after its mandatory header:

```ts
import { expect, it } from 'vitest';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { MongoSessions } from '../../src/persistence/sessions.js';
import { graphThreadId } from '../../src/persistence/records.js';
import { calendarMemory } from './calendar-multi-memory.js';

it('claims mutation ownership without acquiring or releasing an archive lease', async () => {
  const db = calendarMemory(), sessions = new MongoSessions(db.store, DEFAULT_BUDGETS);
  for (const sessionId of ['s', 'other']) await sessions.createIfAbsent({
    schemaVersion: 1, userId: 'u', sessionId, title: 'Calendar',
    createdAt: '2026-11-03T09:00:00.000Z', updatedAt: '2026-11-03T09:00:00.000Z',
    lastActivityAt: '2026-11-03T09:00:00.000Z', lifecycle: 'active',
    graphThreadId: graphThreadId('u', sessionId), latestTurnId: null,
    execution: { ownerId: sessionId === 's' ? 'archive-executor' : null,
      leaseExpiresAt: sessionId === 's' ? '2026-11-03T09:03:00.000Z' : null,
      activeAttemptId: null, generation: 4 },
    memoryPublication: { version: 0, sequence: 0, epoch: 'fixture-epoch', fence: 0 },
  });
  const handle = await sessions.beginCalendarMutation({ userId: 'u', sessionId: 's',
    attemptId: 'create-a', executorId: 'archive-executor', archiveOwned: true });
  expect(handle).toEqual({ userId: 'u', sessionId: 's', attemptId: 'create-a', generation: 4 });
  expect(await sessions.assertCalendarMutation(handle, 'archive-executor')).toBe(true);
  await expect(sessions.beginCalendarMutation({ userId: 'u', sessionId: 's',
    attemptId: 'create-b', executorId: 'archive-executor', archiveOwned: true }))
    .rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
  await sessions.finishCalendarMutation(handle, 'archive-executor');
  expect(await sessions.get('u', 's')).toMatchObject({
    execution: { ownerId: 'archive-executor', generation: 4, activeAttemptId: null },
    memoryPublication: { version: 0 },
  });
  expect(await sessions.get('u', 'other')).toMatchObject({ execution: { activeAttemptId: null } });
});
```

Run `npm test -- test/persistence/calendar-mutation-session.spec.ts -t "claims mutation ownership"`; expected red: missing method. Add one test each for wrong user/session/executor, unverified same-owner lease, foreign owner, archived session, active other attempt, generation replacement, before-write failure and after-write/lost acknowledgement. Wrong/stale handles never clear a newer attempt or accept an unacknowledged claim.

- [ ] **Step 2 — Implement only the exact three helper methods and handle above.** Validate IDs and bounded scope. Use the scoped CAS/readback algorithm in design section 1 with existing `RecordStore`, `sessionRecordSchema`, `key` and driver results. Preserve all session fields not explicitly owned. Do not alter `ownership.ts`, claim the executor again or introduce a new persisted field. Run the new spec green and `npm run build` separately.

- [ ] **Step 3 — Add/run red then green scheduler assertions in `memory-first-foundation.spec.ts`.** Add a single `pausedAttemptId: string | null` to each existing in-memory session, initialized null in both constructors. Implement this exact public shape:

```ts
pauseSession(turn: MemoryTurn): void;
resumeSession(turn: MemoryTurn): void;
```

Validate `owned(turn)`, the current active turn, fence and pause identity. `pauseSession` assigns the existing active attempt synchronously. `pump` skips only a session with a non-null pause. `resumeSession` clears only its matching attempt and calls `pump`; it must be callable from settlement `finally` after `complete` has released `s.active`, provided the same request/fence is retained. No waiting, cancellation, extra timer or second saver.

Test: pause `s`, queue its next envelope, queue another session, pump; only the other session saves; resume `s`, it saves once. A raw save already running when paused stays in `snapshot().unresolvedWrites` and `drain` remains false until released. A wrong turn cannot resume, retries retain attempts/backoff, and a fence cannot be lifted by resume. Run `npm test -- test/performance/memory-first-foundation.spec.ts -t "paus"` red before adding methods, then the full file green.

- [ ] **Step 4 — Add/run red active-marker publication races in `memory-text-archive.spec.ts`.** Hold the native/message/manifest/checkpoint write after acquisition; claim a mutation through the new concrete sessions helper; release the raw write. The archive returns tracked retryable unknown, never saved/fenced, and leaves the mutation marker intact. Add `execution.activeAttemptId: null` to the final publication CAS; at entry active mutation is retryable unknown, not permanent failed. Expose narrowly tracked `ownsSession` as described above. Keep `uncertainReleases` and raw release confirmation intact. Test current/other session isolation and a released archive owner while the mutation stays active.

- [ ] **Step 5 — Run green and checkpoint after commit permission.**

```powershell
npm test -- test/persistence/calendar-mutation-session.spec.ts test/performance/memory-first-foundation.spec.ts test/performance/memory-text-archive.spec.ts
```

Stage only the three production paths and the three actual changed specs. Commit message: `feat(calendar): isolate mutation ownership from archive saves`.

## Task 3: Narrow acceptance and create debit without replaying prior model accounting

**Modify:** `backend/src/chat-runtime/memory-text.ts`, `calendar-loop.ts`, `calendar-operation.ts`.
**Test:** performance spec, operation spec and new session spec.

- [ ] **Step 1 — Add/run red mandatory-versus-unrelated evidence tests.** Extend Task 1's fixture with local repository spies and `order: string[]`. At the actual create provider callback inspect durable input/attempt/acceptance, original deadline, budget create debit, exact planned/dispatching operation and events, pinned account/calendar/hash/Google event ID. Wrap the real executor and call its original function; never replace its authority/capability/admission guards. Add a held promise around each essential method and assert zero POST before release. Add rejected and commit-then-error/uncertain variants; only exact durable confirmation may permit progress.

Explicit cases: session bootstrap, input confirmation, generating attempt, acceptance insert, sequence high-water update, discovery pointer update, proposal consume or explicit intent claim, budget seed/create debit, planned reservation/event, dispatching CAS/event and executor/handle fence. Test cancellation/deadline/invalidation while each hold is pending. Lost acknowledgement plus unavailable exact readback is not success.

Hold `foundation.flushSession`, old model-accounting `reserveDispatchConfirmed/updateDispatchConfirmed`, `skillDecisions.put`, unrelated result saves, `p.memory.put` and graph checkpoint updates **individually**; direct POST must still reach its fixture after the mandatory barrier. Separate deferred create result evidence from earlier read results. Run `npm test -- test/performance/calendar-memory-first.spec.ts -t "mutation barrier"`; expected red on conservative promotion, not merely a mocked helper.

- [ ] **Step 2 — Add the narrow memory adapter and structural ledger.** Add only module-local barrier state in `NativeExecution` for the active turn: mutation handle, durable attempt receipt/acceptance, mutation-only ledger, immutable prefix commitment and one currently confirmed operation outcome. None belongs in the terminal envelope. Implement the receipt-based acceptance/kernel and counter seed in the design sections above. Cache actual receipts so retry does not reconstruct them. Before a new claim, ask the existing archive instance `ownsSession`; if an unknown/foreign owner exists, fail rather than release it.

Extend the module-local `CalendarMemoryExecution` in `calendar-loop.ts` with a mutation-only callback, keeping P2's read callback/stage:

```ts
mutation: {
  ensureAccepted(): Promise<void>;
  writerOptions(): Pick<CalendarOperationWriterOptions, 'write' | 'ledger' | 'fence'>;
};
```

`ensureAccepted` bootstraps, pauses and claims exactly once, confirms accepted evidence and prefix binding, and performs no manifest/checkpoint/accounting replay. `writerOptions` supplies the structural ledger facade: preflight/clarification stay finite in memory; `chargeCreate` ensures accepted evidence, seeds/debits the existing durable mutation budget and mirrors the memory debit. All actual mutation writes use the independent callback. Keep the existing durable route's `ownedLease`/`CalendarTurnLedger` behavior unchanged.

At the exact `writer().executeCreate` calls for direct and proposal-authorized creates, use these options when `ctx.memory` is present. Do not set `ctx.memory = undefined`, switch the inference ledger, or checkpoint the memory graph. Remove unconditional create promotion from `execute` and proposal `decide`; preserve legacy promotion for actual legacy callers. Every caller of `writer`, `freshPreflight`, `freshCapability`, `chargeProviderRequest`, `ownedLease`, `durableLedger`, `promote` and `requireDispatchAllowed` must select the correct lane, not just the direct create call.

- [ ] **Step 3 — Test mixed-read budgeting and retries before finalizing implementation.** A memory turn reads once then creates: prior logical/request/refresh counts are preserved, one create debit covers its own logical action, model dispatch/money rows are not replayed before POST, and next inference cannot reuse spent limits. Retry failed barrier with the same stable intent: no second memory/durable create debit or provider read; changed payload fails idempotency. Seeded lower configured ceilings, concurrent request callbacks, already-applied debit with failed debit-record acknowledgement, and original expired deadlines must all stop safely.

- [ ] **Step 4 — Run green.**

```powershell
npm test -- test/performance/calendar-memory-first.spec.ts -t "mutation barrier|mixed|creates and completes while"
npm test -- test/runtime/calendar-operation.spec.ts test/runtime/calendar-budget.spec.ts test/persistence/calendar-debit-receipts.spec.ts test/persistence/calendar-mutation-session.spec.ts
```

Run commands separately; all selected tests must actually be discovered. Run `npm run build`. Commit named changed files/specs with `feat(calendar): acknowledge only essential create evidence` after serialized permission.

## Task 4: Keep proposals non-creating and revalidate planned dispatch at the shared writer

**Modify:** `backend/src/chat-runtime/calendar-loop.ts`, `calendar-operation.ts`, `calendar-preflight.ts` only if its shared condition logic needs extraction.
**Test:** operation/confirmation/multi-recovery/performance specs.

- [ ] **Step 1 — Add a precise planned-resume red test in `calendar-operation.spec.ts`.** Extend its local `harness` to accept `overrides: Partial<CalendarOperationWriterOptions> = {}` and spread `...overrides` last in the existing writer constructor; preserve existing defaults. Add this complete local request helper and test:

```ts
function createRequest(x: Awaited<ReturnType<typeof harness>>) {
  return { intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
    proposal: null, consumption: null, action: x.canonical, requestHash: x.requestHash,
    operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
    createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z' };
}

it('rechecks capability and preflight when resuming an acknowledged planned operation', async () => {
  let mayDispatch = false;
  const x = await harness({ fence: async () => mayDispatch });
  const capability = vi.fn(async () => ({ outcome: 'ok' as const, target: x.target }));
  const preflight = vi.fn(async () => null);
  const request = { ...createRequest(x), capability, preflight };
  try {
    await expect(x.writer.executeCreate(request)).rejects.toMatchObject({ code: 'INTERRUPTED' });
    expect(await x.h.p.calendarOperationsV2.getByIntent(x.h.identity.userId, x.ids.sessionId, x.intent.intentId))
      .toMatchObject({ state: 'planned' });
    capability.mockClear(); preflight.mockClear(); mayDispatch = true;
    expect((await x.writer.executeCreate(request)).outcome).toBe('created');
    expect(capability).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(x.h.effects.filter(e => e.kind === 'create')).toHaveLength(1);
  } finally { await x.h.dispose(); }
});
```

Add `vi` to the Vitest import and import the options type from the existing `.js` application path. Run `npm test -- test/runtime/calendar-operation.spec.ts -t "resuming an acknowledged planned"`; expected red: the current existing-planned branch skips both callbacks.

- [ ] **Step 2 — Extract one fresh validation block and call it for both new and planned operations.** Keep canonical accepted-message/account/hash verification first. The existing-succeeded path returns its receipt without fresh inference or a create debit; existing dispatching/unknown returns uncertain/reconciliation, never falls through to dispatch. For new/planned actions use the exact existing capability comparison and preflight/clarification policy. A stored planned operation must match immutable action/hash/account/calendar/proposal consumption, unexpired authority and original budget before it can proceed.

Do not run preflight twice for an ordinary new create. After its one fresh validation and planned reservation, final dispatch still checks authority/fence/deadline and P1 provider admission. Planned resume runs that same validation anew before its one CAS. If fresh checks deny, change target, expire, or require a new acceptance, return clarification/interruption and **no POST**. Do not rewrite the stored action/authorization to fit a new account/default/condition. Preserve direct `requiresAcceptance` and existing proposal-confirmed `sameApprovedCondition`/busy-interval semantics exactly; do not broaden or narrow conflict coverage as a latency optimization.

Cover the sibling duplicate path too: `findOwnSessionCreate` can return a **dispatching** prior operation for a different intent at the same slot. `executeCreate` must return unknown/reconciliation for that row, not `existing` followed by a fabricated success message. Only succeeded-with-receipt means already created. Query the existing scoped unresolved operations before admitting a new conflicting intent; unknown/planned/dispatching cannot be bypassed with a different request key or slot. Cache only one bounded unresolved identity per active memory session and confirm it on cold/recovery paths; ordinary reads/text remain possible within existing safety bounds. Add the fresh-intent/same-slot-dispatching regression before modifying the shared classification, and test all its callers.

- [ ] **Step 3 — Add/run red non-create proposal cases with an earlier archive held.** In the performance spec run incomplete details, ambiguous target, missing configured default, model-suggested details requiring confirmation, conflict/partial coverage and unrelated/ambiguous/cancelled proposal replies. They may write bounded proposal/source/disclosure/reply-reference evidence and current acceptance when needed for restart disclosure proof; they must never reserve a create, charge a create or send an event POST. Non-authorized pure refusal stays memory-only.

For an actual accepted proposal reply, `ensureAccepted` precedes `calendarProposals.consume`; enforce exact proposal revision, accepted message, canonical action, account/target, authority deadline and operation identity. Two text tabs or text/live replies cannot consume twice. A caller without a reply reference still needs the existing unique unchanged disclosure proof; do not force saving unrelated history to construct it, and fail/clarify if genuine proof is missing. Refresh the memory pending slot from the actual published/consumed result, not an unawaited later DB lookup before next input.

- [ ] **Step 4 — Add/run red then green denied planned checks.** Change role/account/default preference, revoke permission, expire authority/deadline and change a conflict between planned reservation and recovery. Explicit pinned calendar remains pinned; a preference-only change does not retarget it. Fresh create/readback checks remain default/`{ fresh: true }`; no `{ fresh: false }` mutation escape. Missing capability/preflight callbacks during planned recovery mean interrupt without POST, never optional success.

- [ ] **Step 5 — Run green and checkpoint.**

```powershell
npm test -- test/runtime/calendar-operation.spec.ts test/runtime/calendar-confirmation.spec.ts test/runtime/calendar-intent.spec.ts test/runtime/calendar-multi-recovery.spec.ts test/performance/calendar-memory-first.spec.ts
```

Expected: exact planned checks, existing confirmation semantics and no second model narration after confirmed creates. Commit named paths/specs with `fix(calendar): validate planned creates and preserve proposal authority`.

## Task 5: Publish confirmed effects promptly and archive behind the dirty prefix

**Modify:** `backend/src/chat-runtime/calendar-publication.ts`, `calendar-loop.ts`, `memory-text.ts`, `memory-first-foundation.ts`, `backend/src/persistence/memory-text-archive.ts`.
**Test:** archive/foundation/performance/confirmation specs.

- [ ] **Step 1 — Add/run red result-versus-archive tests.** Hold create result retention/`calendarResultsV2.put`, aggregate and archive saves separately after operation success/event. The memory route must emit the confirmed operation and fixed result text, complete in memory, and admit an eligible follow-up while the hold remains. Repeat the same accepted submission and a later identical create: same operation/result, no extra POST/debit/model narration. Check actual stored `succeeded` plus matching event before claiming a durable receipt. Existing conservative durable-route tests can retain their old transcript completion behavior; do not rename them into false minimal-route coverage.

- [ ] **Step 2 — Add a shared pure confirmed projection, not a second receipt policy.** In `calendar-publication.ts` factor the current v2 receipt/link/label expiry and narration projection into a function receiving a validated operation, its actually confirmed matching event and current attempt status/time. Durable projection continues querying and verifying those records, then calls it. Live `CalendarLoop` calls the same function using the writer's acknowledged operation/event evidence. Include exact state/revision/sequence/operation/session/user equality; an operation-shaped object alone cannot imply its event was acknowledged. Use a server-internal acknowledgement returned by the real writer transition, never a browser flag.

Keep expired/revoked label/link redaction. Provider-confirmed success remains a success even when prose/archive is missing; absence of narration does not turn it into a fresh-create permit. An unacknowledged outcome event remains a durable-publication repair case, not a second POST or a falsely durable receipt.

- [ ] **Step 3 — Add the data-only envelope extension and immutable prefix handling.** Implement design section 4 in the owned foundation/adapter/loop files using existing schemas. Count it in evidence/envelope/backlog bytes before dispatch/queuing. Direct creates archive one complete native create pair through existing stores, proposal replies archive no invented native call; mixed read/create archives earlier pairs exactly once. Before clearing the native live state, retain the prepared prefix commitment and permission-projected deferred records. Do not clear `e.native` before provenance and terminal heard delivery have been captured.

On outcome acknowledgement, clear the mutation active slot without entering the archive owner's queue; then finish the normal memory turn. For failed/unknown outcomes retain the exact original operation in the appropriate safety state and prevent a conflicting later create while it remains unresolved. Release/resume only after actual essential raw work settles. Do not move essential pending writes to an untracked promise or release a fence at a timeout.

- [ ] **Step 4 — Add generating-attempt archive settlement and prefix-safe pointer CAS.** Replace the archive's immutable attempt `ensure` only for the verified minimal-barrier attempt case, with exact confirmed identity/dependency check and legal finalizing/terminal transitions. Preserve the ordinary immutable-save path and P2's redaction compatibility. Stage mutation result/aggregate/source records in the same tracked terminal job, then publish dependencies/manifest/save-only seal and watermark in order. Preserve newer accepted `latestTurnId` as described above; no jump to `k` while `k-1` is dirty.

Test a three-version sequence: dirty ordinary text `v1`, read/live `v2`, successful create `v3`; hold raw `v1`, create result is visible at durable version 0, then release and observe exactly `[1, 2, 3]`. Check no permanently fenced session when an archive sees a mutation marker and no stale archive release clearing that marker. A failed previous save still permits a create within unchanged bounds once **its own** barrier succeeds; exhausted age/bytes/jobs or known inconsistent publication still stops affected work.

- [ ] **Step 5 — Add/run red privacy/identity tests around the new fields.** Volatile Calendar summary/location/link canaries never appear in `calendarMutation.decision`, queued retries or persisted evidence when policy forbids them. Hold a result/native write across invalidation/expiry, finish retention, release it, and verify existing projection leaves tombstones and no private canary. Wrong owner/session/account/attempt/call/source/operation links, changed immutable prefix hash and attempted addition of `nativePublication` after acceptance must fail. Keep visible narration/heard text policy unchanged.

- [ ] **Step 6 — Run green and checkpoint.**

```powershell
npm test -- test/performance/calendar-memory-first.spec.ts test/performance/memory-text-archive.spec.ts test/performance/memory-first-foundation.spec.ts test/performance/memory-calendar-state.spec.ts test/runtime/calendar-confirmation.spec.ts
```

Expected: meaningful passing discovery, actual 32-operation/byte budgets retained, no new persistent native format, ordered retries, bounded drain and all prefix/native cold joins exact. Commit named changed files with `feat(calendar): archive mutation narration after confirmed results`.

## Task 6: Discover and recover operations without graph preparation

**Modify:** `backend/src/chat-runtime/calendar-recovery.ts`, `durable-chat-runtime.ts`, `calendar-publication.ts`, `backend/src/persistence/calendar-operations.ts`, `sessions.ts`.
**Test:** multi-recovery/recovery/operation/session/operation-persistence specs.

- [ ] **Step 1 — Write checkpointless discovery red tests first.** In `calendar-multi-recovery.spec.ts`, import `pendingCalendarOperation` and use the existing `connectedCalendarMemory`/`MongoCalendarOperations` fixtures in local tests. Reserve a valid planned v2 operation and its event, set graph values to `{}` and `latestTurnId` to an unrelated turn; assert the original operation is found. Repeat dispatching/unknown and two different users/sessions. Overflow is a safe blocking error, never “no pending operation.” Run `npm test -- test/runtime/calendar-multi-recovery.spec.ts -t "checkpointless"`; expected red against current cursor/latest-only lookup.

- [ ] **Step 2 — Use the existing bounded unresolved query once.** `pendingCalendarOperation` first calls `listUnresolvedBySession({ userId, sessionId, limit: 2 })`; check `overflow` and reject ambiguous multiple unresolved actions rather than arbitrarily selecting newest. Deduplicate cursor/seal/latest references by operation ID, check full scope, and preserve legacy v1 quarantine. A succeeded operation referenced by the current accepted attempt can also be returned for publication/receipt recovery; it must not hide an earlier unresolved action.

Keep recovery discoverable after the active slot is cleared but terminal archive is unsaved: `sessions.listForRecovery` includes memory-publication sessions as bounded keyset candidates in addition to active/owner leftovers. This is intentionally a broader **cold recovery** scan, not a per-tool or pre-model hot-path read. Add a `ponytail:` comment: at most the configured page size per query; a dedicated indexed pending-effect pointer is warranted only if startup recovery profiling justifies a schema change. In each candidate, inspect only scoped bounded attempts/operations; do not scan every metadata record or invent another collection/index here. Existing ordinary memory sessions return quickly with no provider/model work. Preserve cursor ordering and archive/foreign-user isolation.

- [ ] **Step 3 — Add explicit minimal-attempt recovery before graph-dependent fallback.** In `DurableChatRuntime.reconcileSession`, keep stopped-owner, executor, work-reservation and recovery-lease checks. The existing early return for any memory-owned session must not suppress an unresolved mutation: add `MemoryText.reconcileMutation(sessionId): Promise<boolean>` that returns false when no mutation needs recovery, refuses overlap with essential raw work, and performs only operation reconciliation using its independent barrier adapter. Ordinary save-only memory sessions retain the no-generation-replay return. Extend `reconcileCalendarOperationV2` with optional `barrier: Pick<CalendarOperationWriterOptions, 'write' | 'fence'>`; use that callback for its charged writes/fences when supplied by the actual owned memory adapter, otherwise retain the required recovery lease and existing `owner.run/fence` path. No unchecked no-op fence or raw client fallback. This preserves same-process reconciliation without joining an unrelated archive's owner queue.

When accepted input/attempt/acceptance and a matching operation exist but no graph prepare/seal exists, recover from the operation rather than calling general model continuation or requiring a synthetic graph seal. Verify the accepted attempt through `operation.authorization.acceptedTurnId/acceptedUserMessageId` and matching events; do **not** assume `operation.originatingAttemptId` is the accepting attempt for a cross-turn proposal.

For planned operation, reconstruct the exact request from saved operation action, accepted message, account/calendar and confirmed proposal consumption/authority lookup when relevant. Reuse the same writer/fresh capability/preflight/condition policy and original mutation budget; repair its matching planned event first if missing. Missing/expired accepted/proposal proof, missing safe policy callback, cancelled attempt, changed authority or exhausted deadline interrupts/clarifies without POST. There is no model inference to fill missing fields. A consumed proposal with no operation can only be repaired from its exact confirmed consumption and original evidence, otherwise remain safely interrupted; never consume it again or generate a new operation/event ID.

For dispatching/unknown operation, call only `reconcileCalendarOperationV2` with original account/calendar/event ID and original remaining budget/deadline. Resolve the explicit original calendar and require fresh readback authority (`fresh: true` at the current capability check and provider readback); no saved-default/prepared-read substitution. Matched receipt may confirm success; absent/mismatch/timeout/denial stays unknown. No transition back to dispatching in v2 and no POST replay even if readback says absent. Keep unresolved action pinned/discoverable.

- [ ] **Step 4 — Repair exact transition events without fabricating effects.** CAS and event are separate writes. If the operation is succeeded with a receipt but its event append lost acknowledgement, verify the scoped current operation and idempotently append the deterministic event for its exact sequence/revision/state. `appendEventV2` already confirms an identical existing event; reuse it. Export a small event-construction helper from `calendar-operation.ts` if shared use avoids divergent event IDs/timestamps. Reject a competing event at that sequence, modified receipt or foreign attempt. Repair permits publication only, never dispatch. Apply the same exact repair to a planned event before an eligible first dispatch; dispatching with a missing event is readback-only.

- [ ] **Step 5 — Preserve success when narration/archive is absent.** A minimal generating attempt with a succeeded operation but no prose is interrupted/marked narration unavailable using existing legal attempt transitions, while the receipt remains succeeded and is returned by operation projection/repeated intent lookup. Do not use `interruptAttempt` to create a manifest that leaps over a missing dirty prefix. Completed attempts with a proven minimal-operation publication must not trigger the generic “missing graph evidence” path; legacy completed attempts without such evidence still fail closed. Cold history remains unavailable when its watermark/dependencies are incomplete; do not reset it or silently drop earlier turns.

- [ ] **Step 6 — Run each crash case red before the corresponding branch, then green.** Use locally wrapped real store methods to stop exactly at a boundary, not graceful error cleanup as a substitute for crash. Take a copy of the fake driver's durable rows at that instant, release old promises for cleanup, create a new isolated fake-driver persistence bundle with a new executor and replay only the saved rows before invoking normal stopped-owner recovery. Do not run two live runtimes on one fake state. Reuse the existing fixture's restart/handoff where it already models this; otherwise local snapshot/restore must preserve `_id`, `_revision`, BSON money and checkpoint binaries and execute no application model/provider call during setup. Assert both unchanged POST count and original event identity.

### Required crash/recovery matrix

| Crash boundary | Durable evidence possible | Required recovery and effect assertions |
| --- | --- | --- |
| Before accepted evidence/intent reservation | Nothing, partial input/attempt/marker, or saved proposal only | No POST; clear/repair partial acceptance through existing scoped rules; no orphan privilege or automatic inference. |
| Proposal consumed, before operation reserve | Exact consumption wrapper/intent reservation and accepted evidence | Repair only the original intent/action/operation with fresh checks, or interrupt if proof/authority expired; never consume again or invent a second operation. |
| Planned operation inserted, planned event missing | Planned immutable action and stable provider ID | Confirm/repair exact event; fresh account/capability/preflight/consumption/budget/deadline before one eligible first POST. Denied/uncertain repair sends none. |
| Planned + event, before dispatching CAS | Complete planned evidence | Same checks as a new attempt, no model replay and no second debit. Changed condition/authority interrupts/clarifies. |
| Dispatching CAS acknowledged, event missing or process stopped before send | Original operation already dispatching | **Readback only**, even if this means no event is found; never infer that “before send” is safely replayable. |
| POST sent, response/receipt unknown | Dispatching/unknown and original ID | At most bounded charged readback in this recovery job; matched succeeds, absent/mismatch/unknown stays unknown; zero additional POST. |
| Provider success, outcome CAS/event acknowledgement fails | Dispatching, unknown, or succeeded row without its event | Original-ID readback or exact event repair according to actual stored state; no fresh create/debit/inference. |
| Succeeded + matching event, before prose/terminal save | Durable receipt, possibly generating attempt and dirty prefix | Return prior result with missing narration/save distinguished; zero POST/model; no watermark leap. |
| Terminal dependencies partly staged, publication CAS missing/unknown | Operation succeeded and partial archive | Save-only exact retry; preserve prefix order, immutable hashes, original attempt/debit and receipt. |

Also test cancellation before barrier (no POST), after dispatching/before response (unknown/readback only), after success (receipt preserved), duplicate request with changed action (mismatch), competing same-session text/live creates (one active effect), unrelated session/archive progress, revoked/replaced account, target role loss, source expiry, legacy v1 unresolved quarantine and unresolved-query overflow. No exactly-once effect/billing or guaranteed cancellation-of-charge claim.

- [ ] **Step 7 — Run green and checkpoint.**

```powershell
npm test -- test/runtime/calendar-recovery.spec.ts test/runtime/calendar-recovery-unavailable.spec.ts test/runtime/calendar-multi-recovery.spec.ts test/runtime/calendar-operation.spec.ts test/persistence/calendar-multi-operations.spec.ts test/persistence/calendar-mutation-session.spec.ts test/performance/calendar-memory-first.spec.ts
```

Run `npm run build` separately. Commit actual named changed files/specs with `fix(calendar): recover minimal mutation evidence without replay`.

## Task 7: Prove irreducibility, compatibility and the downstream handoff

**No additional production scope.** Correct introduced P3 defects in their shared owner, request handback for upstream defects, and keep review skipped.

- [ ] **Step 1 — Trace every sibling caller before declaring the slice complete.** Search `promoteTurn`, `promote`, `writer`, `executeCreate`, `dispatchReserved`, `requireAccountCurrent`, `runCalendarPreflight`, `requireDispatchAllowed`, `pendingCalendarOperation`, `listForRecovery`, `nativePublication`, `commitPromoted`, `finishCalendarMutation` and `calendarMutation`. Verify direct, proposal reply, legacy durable, resumed planned, readback, text/live and error/finally paths use the appropriate ownership and freshness policy. No fire-and-forget durability or generic ownership bypass may remain.

- [ ] **Step 2 — Record deterministic physical commands and blocking stages from actual production boundaries.** In the owned performance spec, use P2's real P1 assembly with deterministic HTTP fixtures and the existing fake-driver `commandStarted` events/`wireCalls` plus `dependency-probe` when timing waves. Profile direct and proposal-confirmed creates at 0 and 8 prior turns, clean/dirty prepared paths separately; cold/changed/refresh/recovery separately. Include one mixed read/create and text/live contention case. Do not mutate gates or skip provider debit/fresh checks.

Record command name/collection/read-write counts, logical operations/save, model-tool-to-provider stages, provider response and result-to-terminal/eligible-follow-up stages separately. Mandatory evidence count must not grow with prior model dispatch history; prior native archival is deferred. Account for asynchronous concurrent commands by origin/turn and started/completed IDs, not by subtracting an arbitrary end snapshot. Publish no message text, credentials, URIs or raw provider payloads in metrics. These are synthetic measurements, not a wall-clock SLA or live certification.

- [ ] **Step 3 — Run the complete focused regression set in `backend/`.**

```powershell
npm test -- test/performance/calendar-memory-first.spec.ts test/performance/memory-calendar-state.spec.ts test/performance/memory-first-foundation.spec.ts test/performance/memory-text-archive.spec.ts test/performance/memory-first-text.spec.ts test/performance/memory-first-voice.spec.ts test/runtime/calendar-operation.spec.ts test/runtime/calendar-confirmation.spec.ts test/runtime/calendar-recovery.spec.ts test/runtime/calendar-recovery-unavailable.spec.ts test/runtime/calendar-multi-recovery.spec.ts test/runtime/calendar-budget.spec.ts test/runtime/calendar-memory-voice.spec.ts test/runtime/calendar-voice-authority.spec.ts test/persistence/calendar-multi-operations.spec.ts test/persistence/calendar-multi-proposals.spec.ts test/persistence/calendar-debit-receipts.spec.ts test/persistence/calendar-mutation-session.spec.ts test/plugins/google-calendar/tools-boundaries.spec.ts test/plugins/google-calendar/tools-multi.spec.ts test/performance/calendar-critical-path.spec.ts test/performance/calendar-voice-latency.spec.ts
```

Run separately: `npm run build`, `npm run lint`. Expected: meaningful discovered tests pass, build exits 0, lint exits 0 with warnings reported. Do not call empty discovery or native skips evidence. Full backend `npm test` / `npm run test:e2e`, integrated P4 metrics/final report remain workflow completion gates. No frontend changes are planned; report that rather than running unrelated frontend checks. Live/native service checks still require separate authorization.

- [ ] **Step 4 — Check these compatibility/recovery gates explicitly.**

| Gate | Required passing evidence or documented limitation |
| --- | --- |
| Minimal barrier | Real held archive lease/global tail does not gate create; every essential acknowledgement/fence failure prevents POST; no prior model replay/manifest/prepare checkpoint. Exact observed counts supplied. |
| Account and authorization | Fresh creates and original-ID readback, unchanged capability/preflight coverage, single-use explicit/proposal authority, same-account/calendar/action binding and cancellation/deadline checks. |
| Dirty-prefix ownership | In-flight archive remains tracked, pause does not cancel it, mutation marker isolated, no permanent archive fence, no version/pointer regression or ownership theft. |
| Result/save separation | Confirmed receipt/text before nonessential bookkeeping, truthful save status, no second inference/create for missing prose, live terminal hearing retained. |
| Accounting | Memory and durable mutation limits agree, original deadline retained, create logical debit once, mixed reads counted once, no model-money fabrication or whole-accounting replay. |
| Formats and history | Existing v1 operations/quarantine and existing v2 operation/events unchanged; P2 local/native formats retain exact commitments/erasure; complete mixed read/create pairs cold-hydrate once. New envelope data is process-local, no new collection. |
| Recovery | Every crash-matrix row tested without relying on saved graph cursor/latest turn, unresolved overflow fails safe, succeeded receipt survives absent archive, no automatic POST from dispatching/unknown. Dirty-gap chat may remain safely unavailable. |
| Rollback | P2's new native format remains its forward-format limitation; do not claim old binaries support it. Stop/drain and reconcile all mutation pointers/unresolved effects before any rollback; no destructive data rewrite or transaction assumption. |
| Bounds/shutdown/privacy | Existing limits, retries/backoff/raw ownership/drain preserved, no revoked/volatile canary resurrected in new envelope fields, no close while essential/archive raw work remains. |
| Ownership and honesty | Completed P2 interfaces reconciled; no outside-owner production changes; no live/db/service certification; review **skipped**, final P4 verification still outstanding. |

- [ ] **Step 5 — Checkpoint and report.** Run `git diff --check`, inspect the named-path staged diff and `git diff --cached --name-only`, obtain commit permission and commit only remaining actual P3 files with `test(calendar): verify minimal mutation barrier and crash recovery`. Never `git add .`, stage unrelated dirty code/tests, include generated output/dependencies/secrets or edit workflow status yourself.

Return actual worker commit hashes, exact changed paths, P1/P2 prerequisite commits and interface reconciliation, discovered test pass/failure/skip counts, build/lint results, observed mandatory versus deferred DB operations/waves and the complete crash/compatibility limitations. Tell P4 which production paths and shared-mode tests prove the barrier; P4 owns integrated evidence and final `AGENTS.md` policy. Do not dispatch a reviewer or mark the workflow complete.

## Planner self-check and document-only commit

- AC3/AC4 are primarily covered by Tasks 1–6; AC5 by scoped authority/ownership/privacy races; AC6 by Task 7's exact command/stage measurements; AC7 by actual prerequisite baseline and focused/build/lint gates. P1/P2 retain AC1/AC2; P4 integrates all eight criteria and AC8 instructions.
- Minimum-change check: no second executor, no generic framework, no new collection or dependency. The independent mutation lane is necessary because the actual shared archive queue cannot be bypassed by pause alone; it is not a claim of distributed execution support. Retain physical-command and native-prefix compatibility proof as hard gates.
- Planning has not run application tests or verified a mutation implementation. Context7 documentation lookups confirmed driver acknowledged CRUD result semantics and Vitest async `vi.waitFor` behavior; repository code is the source for application interfaces. Documentation lookups are not live provider/database testing.
- Check links and exact existing paths, the one intentionally new session spec, placeholder/whitespace consistency, P2 cancellation/start gates, ownership and no changes outside this file. Inspect the staged list before committing. This planner does not start a worker or add/update other workflow artifacts.

Required plan-only commit, repository root (run the two commands separately under PowerShell):

```powershell
git add -- docs/calendar-tool-latency/plan3.md
git commit -m "docs(calendar-tool-latency): plan 3 - minimal mutation barrier"
```
