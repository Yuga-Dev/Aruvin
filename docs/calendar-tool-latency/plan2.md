# P2 Memory-First Calendar Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use the installed `executing-plans` and `test-driven-development` skills. The MAW orchestrator assigns this worker; do not dispatch another worker or reviewer.

**Goal:** Execute prepared Calendar reads and availability through provider delivery, model continuation, and eligible follow-ups in bounded memory, then archive complete permission-bounded evidence through the existing ordered asynchronous saver.

**Architecture:** Extend the existing `MemoryText`/`CalendarLoop`/`MemoryFirstFoundation` path, not the plugin framework. P1 remains the sole prepared-authority owner; the runtime explicitly selects prepared checks for reads, keeps complete current-turn pairs in memory, and stages only privacy-safe native evidence. Reuse the terminal save queue and one consolidated native record per attempt, with bounded expiry/account erasure and integrity-checked cold hydration; leave durable create promotion and recovery to P3.

**Tech Stack:** Existing Node.js, TypeScript ESM/NodeNext, NestJS composition, LangGraph, Zod 3, MongoDB repository ports/fake driver, and Vitest 4; no new dependency, collection, framework, live service, or transaction assumption.

---

## Prerequisites, ownership, and non-goals

- Approved inputs: [`goal.md`](goal.md), reconciled [`state.md`](state.md), [`research.md`](research.md) at `b66fe00`, and P1 [`plan1.md`](plan1.md) at `4d62254`. Planning checkout: `11f4c5a`; P1 implementation is running concurrently. This planner writes/commits **only this document**.
- **Worker gate:** P1 worker must finish its checks and commits before P2 edits source. Read its actual interface/evidence handoff and refresh the paths below. A committed P1 plan alone does not satisfy this gate. Report upstream contract differences to the orchestrator before proceeding.
- P1 contract wins over research: `currentAccount()` is prepared after warming; `requireAccountCurrent(account, signal)` is **fresh by default**; read-only callers must pass `{ fresh: false }`. Call the optional synchronous `connection.invalidateAccount?.(account)` from direct runtime invalidation. No token, credential envelope, lifecycle epoch, or prepared snapshot belongs in chat memory or archives.
- P1 owns `backend/src/contracts/calendar-authority.ts`, `backend/src/contracts/calendar-operations.ts`, `backend/src/chat-runtime/calendar-ports.ts`, `backend/src/plugins/google-calendar/connection.ts`, `backend/src/plugins/google-calendar/discovery.ts`, `backend/src/plugins/google-calendar/tools.ts`, `backend/src/operations/calendar-assembly.ts`, and `backend/src/app.service.ts`. Inspect, **do not edit**, those files. Request a serialized handback for an actual upstream defect.
- P2 owns only the ten production paths mapped below and the named focused tests. P3 receives sequential ownership of shared runtime/archive paths after P2. Do not narrow a create barrier, change proposal consumption, introduce pause/resume mutation ownership, change operation schemas, or optimize recovery here. A read-then-create still promotes at the create boundary.
- P4 owns the new `backend/test/performance/calendar-tool-latency.spec.ts`, integrated measurement/reporting, and final root `AGENTS.md` policy. Do not create that test or edit `AGENTS.md`, `state.md`, `goal.md`, other plans, or old workflow documents.
- No Google/OpenRouter/database calls, application-data inspection, service restart, deployment, paid checks, model change, new capability, or multi-instance support. Use deterministic in-process fetch/repository fixtures. Unified review is **skipped**, never passed.
- Preserve new dirty files, including P1's initially untracked `backend/test/plugins/google-calendar/connection-prepared.spec.ts`. Stage named P2 files only and obtain orchestrator permission before each shared-index commit.
- Preserve repository code-file headers; add the required header if an existing code file changes by more than 30%. Local TypeScript imports keep `.js` specifiers. No new code/test file is required by this plan.

## Exact file map

| Production path | Smallest required responsibility/change |
| --- | --- |
| `backend/src/chat-runtime/memory-text.ts` | Resolve prepared binding without a redundant raw connection read; carry read provenance into completion; invoke P1 invalidation synchronously; scrub active/staged evidence and reject late publication. |
| `backend/src/chat-runtime/calendar-loop.ts` | Skip promotion for the four reads; use the active ledger; stage read results without source/result writes; validate before continuation/publication; preserve create/proposal promotion. |
| `backend/src/chat-runtime/memory-calendar-ledger.ts` | In-memory request/refresh/logical/create counters and idempotent debit evidence; report real connector counts in aggregate. |
| `backend/src/chat-runtime/memory-calendar-state.ts` | Bounded local/v2 result union, strict joins, privacy projection, shared group reconstruction/erasure, compatible native record integrity. |
| `backend/src/chat-runtime/memory-first-foundation.ts` | Carry provenance, scrub base/results/queued envelopes, apply expiry at consumption, reuse all existing save supervision. |
| `backend/src/chat-runtime/calendar-history.ts` | Reconstruct consolidated Calendar pairs through the same projection as warm history; keep legacy joins and honest unavailable history. |
| `backend/src/context/calendar-context.ts` | Treat historical unavailable pairs separately from valid current API results; reject revoked volatile sources and never revive tombstones as schema authority. |
| `backend/src/persistence/memory-text-archive.ts` | Save the privacy-projected native batch; bind immutable integrity; prevent late saves/retries from restoring expired/revoked content. |
| `backend/src/persistence/memory-calendar-reader.ts` | Read old local records and new Calendar records with strict visibility, identity, and integrity checks; accept only verified erasure. |
| `backend/src/persistence/calendar-retention.ts` | Bounded keyset expiry/account redaction of consolidated native records, including save/invalidation races. |

**Existing test files to modify:**

- `backend/test/performance/calendar-memory-first.spec.ts`: read routing, held-save continuation, real assembled authority, save failures/bounds, text/live consistency, existing create guards unchanged.
- `backend/test/performance/memory-calendar-state.spec.ts`: ledger, bounded Calendar state, warm/cold joins, integrity, erasure and privacy canaries.
- `backend/test/performance/memory-text-archive.spec.ts`: ordered Calendar archive, post-response I/O, release/retry/drain and late privacy projection.
- `backend/test/context/calendar-context.spec.ts`: current/historical/volatile validation.
- `backend/test/persistence/calendar-multi-retention.spec.ts`: expiry/account paging and late native writer races.
- `backend/test/performance/memory-first-foundation.spec.ts`: active/base/queued scrubbing and unchanged supervision when needed.

Reuse fixtures read-only: `backend/test/runtime/calendar-runtime.fixture.ts`, `backend/test/persistence/calendar-multi-memory.ts`, `backend/test/contracts/calendar-multi-fixtures.ts`, `backend/test/context/fixtures.ts`, and P1's assembled fixture pattern. Keep new test helpers local to the owned specs. The existing runtime fixture deliberately uses raw store-backed fake gates/credentials; **it cannot prove the prepared production chain**. Do not hide its storage calls by replacing gates with always-allow mocks.

## Fixed safety and compatibility decisions

1. **Scope of the no-I/O assertion:** new/warm, enabled, prepared, valid-credential/discovery/account paths only. Cold session hydration, first authority preparation, real credential/discovery refresh, stale target evidence, unsupported legacy history, and recovery may perform bounded I/O or return safe unavailability. Do not discard history or invent coverage to make counters zero.
2. **Read set:** `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`, `calendar_check_availability`. `calendar_create_event`, proposal replies, and the existing durable graph keep their current barriers. Keep Canvas local presentation behavior unchanged.
3. **Budgets:** preserve `CALENDAR_LIMITS` and configured lower limits. Preserve `PROPOSED_MEMORY_TEXT_POLICY`: 32 envelopes, 524,288 bytes/envelope, 131,072 evidence bytes, 16,777,216 backlog bytes, 32 logical save operations, two concurrent saves, three attempts, 1,000 ms retry backoff, 15,000 ms write timeout, 60,000 ms dirty-age limit, 300,000 ms request retention, and 20,000 ms drain. Tests may use smaller explicit fixture limits. Do not increase limits to accommodate fan-out.
4. **Pairing and privacy:** current-turn raw Calendar results exist only in the loop's bounded groups and may feed the immediate continuation. `MemoryCalendarStage`, `TerminalEnvelope.calendar`, and `memory-calendar-native` contain retained payloads only with `minimalEvidenceAllowed` and retained permission; volatile results contain a source/reference only. Source-derived text decisions are already null under volatile permission: retain that rule, and do not leak Calendar details through later `assistantContent`, native arguments, local-result echoes, or queued copies. Visible user/assistant transcript and heard voice text retain the repository's existing archive policy; evidence expiry does **not** rewrite what the user saw.
5. **Use real schemas:** `persistedCalendarResultV2Schema` supports `reference` with `outcome: 'ok' | 'error' | 'unknown'`, `retained`, and `tombstone` with `reason: 'expired' | 'disconnected' | 'not-permitted'`. Research's `outcome: 'redacted'` does not exist. Do not edit shared contracts to add it.
6. **No hash bypass:** a `redactedAt` flag alone never authorizes ignoring `nativePublication.contentHash`. Use the bounded v2 integrity design in Task 3; legacy local records retain exact-state hashing. No new attempt-contract fields are needed.
7. **Erasure granularity:** an attempt has at most eight results. Erase its Calendar evidence set conservatively on the first affected source expiry/revocation, keeping accounting, identifiers, source-free local disclosure/Canvas evidence, and visible narration. This prevents partially erased leaves from escaping the integrity check. Mark the deliberate ceiling with a `ponytail:` comment: at most eight entries, attempt-wide Calendar erasure; per-source independent lifetimes would require separately committed leaf integrity. Do not erase another attempt/account/session merely because one source was revoked.
8. **Invalidation:** check owner identity before changing runtime counters/maps; connection/account revision and lifecycle invalidation must win over held debit/provider/model/save promises. Clear affected staged/current groups, cached history, `baseCalendar`, results, queued envelopes and retry projections. Already-dispatched raw saves remain tracked until settlement and must finish with verified erasure before reporting saved. No ordinary TTL substitutes for immediate consent revocation.

## Task 1: Capture baseline and implement finite in-memory tool/request debits

**Modify:** `backend/src/chat-runtime/memory-calendar-ledger.ts`.
**Test:** `backend/test/performance/memory-calendar-state.spec.ts` (reuse its `ledger()` helper).

- [ ] **Step 1 — Record prerequisites and baseline.** Run separately at repository root: `git status --short --branch`, `git rev-parse HEAD`, `node --version`. Clear the native-test variable without printing it:

```powershell
Remove-Item Env:AURVIN_TEST_MONGODB_URI -ErrorAction SilentlyContinue
```

Run in `backend/` before edits:

```powershell
npm test -- test/performance/calendar-memory-first.spec.ts test/performance/memory-calendar-state.spec.ts test/performance/memory-text-archive.spec.ts test/context/calendar-context.spec.ts test/persistence/calendar-multi-retention.spec.ts
```

Record actual discovery/counts/failures against the completed P1 commit set, not research's different 124-test baseline. Load `systematic-debugging` for unexpected failures; do not delete assertions to conceal them.

- [ ] **Step 2 — Add the first red regression in `memory-calendar-state.spec.ts`.**

```ts
it('debits finite memory Calendar work once per logical identity', async () => {
  const l = ledger({ limits: { ...CALENDAR_LIMITS, logicalTools: 2,
    creates: 1, calendarRequests: 1, refreshRequests: 1 } });
  await l.chargeLogicalTool('read-decision');
  await l.chargeLogicalTool('read-decision');
  await l.chargeCalendarRequest('get');
  await l.chargeRefreshRequest();
  await l.chargeCreate('create-intent');
  await l.chargeCreate('create-intent');
  expect(l.snapshot().budget).toMatchObject({ logicalTools: 2, creates: 1,
    calendarRequests: 1, refreshRequests: 1, debits: expect.any(Array) });
  await expect(l.chargeLogicalTool('extra-read')).rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
  await expect(l.chargeCalendarRequest('get')).rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
  await expect(l.chargeRefreshRequest()).rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
  const d = await l.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  await l.finishDispatch(d.dispatchId, null);
  expect(await l.aggregate()).toMatchObject({ calendarRequests: 1, refreshRequests: 1 });
  l.freeze();
  await expect(l.chargeCalendarRequest('get')).rejects.toThrow(/frozen/);
});
```

- [ ] **Step 3 — Run red:** `npm test -- test/performance/memory-calendar-state.spec.ts -t "debits finite memory"`. Expected: missing `chargeLogicalTool`, not missing test discovery. Implement the same public method signatures as `CalendarTurnLedger` (`chargeLogicalTool(decisionId?: string, _hash?: string)`, `chargeCreate(intentId?: string, _hash?: string)`, `chargeCalendarRequest(kind)`, `chargeRefreshRequest()`). Reuse `calendarDebitId` and `CALENDAR_DEBIT_EFFECT` from the existing budget/contracts modules; a create debit increments **both** logical tools and creates.

The increment kernel must execute synchronously before returning its resolved promise, so concurrent request callbacks cannot read the same old value:

```ts
this.check();
const next = { ...this.budget, revision: this.budget.revision + 1,
  logicalTools: this.budget.logicalTools + change.logicalTools,
  creates: this.budget.creates + change.creates,
  calendarRequests: this.budget.calendarRequests + change.calendarRequests,
  refreshRequests: this.budget.refreshRequests + change.refreshRequests };
if (next.logicalTools > this.o.limits.logicalTools || next.creates > this.o.limits.creates
  || next.calendarRequests > this.o.limits.calendarRequests || next.refreshRequests > this.o.limits.refreshRequests)
  throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The Calendar request budget is exhausted.', false);
```

`change` is one of the four exact nonnegative increments; validate/commit with `turnBudgetRecordSchema`. With a logical/create identity, check existing `budget.debits` first, preserve an exact duplicate without increment, and append the existing bounded debit-entry shape (kind, decision/intent, stable ID, increments, next revision, createdAt). Copy initial retry debits; do not use a second unbounded set. Calls without identity increment normally. No storage or `ConfirmedRecord`. `aggregate()` uses budget request/refresh counters, not hardcoded zero.

- [ ] **Step 4 — Add/run red then green for concurrent `Promise.all` request debits, lower configured ceilings, cancelled/deadline checks, and retry-seeded duplicate identities.** Add these assertions to the same spec before each branch change; two concurrent requests under a limit of one yield one fulfilled result and one budget rejection, with counter one. A retry created using `ledger({ initialBudget: l.snapshot().budget })` must not charge the saved decision/intent twice. Run `npm test -- test/performance/memory-calendar-state.spec.ts test/runtime/calendar-budget.spec.ts` and `npm run build` separately. Expected: all discovered cases and build pass; durable ledger behavior unchanged.

- [ ] **Step 5 — Checkpoint after commit permission:** stage only the ledger and state spec; commit `feat(calendar): bound read accounting in server memory`.

## Task 2: Admit complete permission-bounded Calendar state and reconstruct pairs once

**Modify:** `backend/src/chat-runtime/memory-calendar-state.ts`.
**Test:** `backend/test/performance/memory-calendar-state.spec.ts`.

- [ ] **Step 1 — Add a local read-state helper and the red schema test.** Import `calendarToolResultRecordV2Schema`, `sourceReferenceV2Schema`, `CALENDAR_TOMBSTONE`, `calendarPage`, and `sourceV2` from their existing contracts/fixture paths. This helper uses the spec's existing `localState()`/`ledger()` and changes only inert evidence:

```ts
async function readState(l = ledger(), volatile = false) {
  const base = await localState(l);
  const fetchedAt = base.state.budget.createdAt;
  const source = sourceReferenceV2Schema.parse({ ...sourceV2, operationIds: [],
    toolCallIds: ['native-call'], fetchedAt,
    expiresAt: volatile ? fetchedAt : new Date(Date.parse(fetchedAt) + 60000).toISOString(),
    permission: { ...sourceV2.permission, content: volatile ? 'volatile' : 'retained' },
    targets: sourceV2.targets.map(t => ({ ...t, calendarLabel: volatile ? null : t.calendarLabel })) });
  const envelope = { plugin: 'google-calendar', tool: 'calendar_list_calendars', arguments: {} };
  const decision = resumableSkillDecisionSchema.parse({ ...base.decision,
    connectionId: source.connectionId, connectionRevision: source.connectionRevision,
    decision: { kind: 'call_tool', decisionId: base.decision.decisionId, assistantContent: null,
      nativeCall: { id: 'native-call', type: 'function', function: {
        name: 'call_tool', arguments: JSON.stringify(envelope) } }, envelope, terminal: 'tool_calls' } });
  const result = calendarToolResultRecordV2Schema.parse({ schemaVersion: 2, kind: 'calendar-tool-result',
    userId: decision.userId, sessionId: decision.sessionId, turnId: decision.turnId,
    attemptId: decision.attemptId, decisionId: decision.decisionId,
    eventId: 'read-result-event', sequence: 0, toolCallId: 'native-call', createdAt: fetchedAt,
    resultRef: volatile ? { storage: 'reference', source, toolCallId: 'native-call', operationId: null, outcome: 'ok' }
      : { storage: 'retained', source, toolCallId: 'native-call', operationId: null,
          result: { ...calendarPage, fetchedAt, expiresAt: source.expiresAt } } });
  const state = memoryCalendarStateSchema.parse({ ...base.state,
    budget: { ...base.state.budget, logicalTools: 1 }, decisions: [decision], results: [result] });
  return { state, source, decision, result };
}

it('stages complete retained Calendar pairs and volatile references without payload copies', async () => {
  const retained = await readState(), volatile = await readState(ledger(), true);
  const stage = new MemoryCalendarStage(32768, 8);
  stage.putDecision(retained.decision); stage.putResult(retained.result);
  expect(stage.records().results).toEqual([retained.result]);
  expect(JSON.stringify(volatile.state.results)).not.toContain('"calendars"');
  expect(volatile.result.resultRef.storage).toBe('reference');
  expect(memoryCalendarStateSchema.safeParse({ ...retained.state,
    results: [{ ...retained.result, attemptId: 'other-attempt' }] }).success).toBe(false);
});
```

- [ ] **Step 2 — Run red:** `npm test -- test/performance/memory-calendar-state.spec.ts -t "stages complete retained"`. Expected: Zod rejection of the v2 result by the local-only array. Implement a module-local `memoryResultSchema = z.union([localSkillResultRecordSchema, calendarToolResultRecordV2Schema])`; use its inferred union in stage maps, `putResult`, and `assertResultCapacity`. Keep `.max(8)`, whole-stage encoded byte bound, cloning and immutable-idempotency checks.

- [ ] **Step 3 — Strengthen the shared join while extending it.** Permit bounded v2 `decision.sources` but continue forbidding operation/intent/proposal IDs for unpromoted state. Check dispatch-decision equality, all owner/session/turn/attempt IDs, native call ID, result event/sequence uniqueness and exact tool identity (`decision.envelope.tool === result.resultRef.result.tool` for retained `call_tool`). Validate local content through the current local schema. For v2 require `operationId === null`, correct source call coverage/account revision, retained target/availability provenance through the existing result schema, and result serialization within `CALENDAR_LIMITS.resultBytes` (the loop still enforces lower configured limits).

Provide these narrowly shared exports in this same file, not another service:

```ts
export function memoryCalendarGroups(state: MemoryCalendarState, now: number): ReturnType<typeof skillGroup>[];
export function eraseMemoryCalendarState(state: MemoryCalendarState, now: number,
  reason: 'expired' | 'disconnected' | 'not-permitted'): MemoryCalendarState;
```

`memoryCalendarGroups` sorts by result sequence and joins the original native decision. Local results use `resultRef.content`. A valid retained Calendar result uses `JSON.stringify(resultRef.result)` and its source. Reference/tombstone/expired/redacted Calendar results use exactly `JSON.stringify({ kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE })` and `sources: []`. Never emit an orphan, duplicate, invented success, or schema disclosure. Null **text** decisions with provenance are valid evidence, not missing tool calls. A malformed/missing call/result join still fails; do not simply filter it out.

Account for a read denied/clarified/cancelled before any result is consumed: add optional `terminalCall` to the module-local memory state, with the strict shape `{ decisionId, toolCallId, outcome: 'denied' | 'clarification' | 'failed' | 'cancelled' | 'interrupted' }`. Stage it with one idempotent `putTerminalCall` method; no array/map or new shared contract. It may explain exactly one last non-text decision with no result, only when that decision belongs to the last terminal dispatch and no later continuation exists. Its IDs must match the original call and it cannot coexist with a result for that decision. `memoryCalendarRecordSchema` accepts that explicitly terminal unexecuted call; otherwise its existing complete-result requirement remains. Reconstructed history emits no orphan native message for this marker, while accounting/accepted input/narration and the explicit terminal outcome remain archived. Add red tests for denied/ambiguous target, provider failure and cancellation completing/saving without a dangling pair, plus a forged marker on an earlier/successful decision that must reject. This prevents the old archive requirement from permanently failing legitimate unpromoted read denials.

`eraseMemoryCalendarState` is pure, idempotent and bounded: retain dispatch/accounting/rejection/ordering identities and source-free local pairs; erase Calendar result payloads to the existing tombstone shape, null source target labels, mark sources redacted without extending fetchedAt/expiresAt, null sourced text decisions, and remove Calendar-derived assistant prose. For erased external calls preserve original call ID and tool/plugin name, but replace content-bearing arguments with the explicit empty envelope `{ plugin: 'google-calendar', tool, arguments: {} }` in **both** parsed envelope and native-call JSON; clear the call-decision's `sources` (its result still carries redacted provenance). This keeps the existing `resumableSkillDecisionSchema` requirement that non-null decisions cannot have volatile/expired sources. These are unavailable-history pairs only, never executable/disclosure authority. Preserve source identity/permission/discovery/availability hashes and result linkage. Strip derived `assistantContent` from local decisions; fixed schema disclosures/errors and server-owned Canvas IDs/results remain valid local evidence, not raw Calendar echoes.

- [ ] **Step 4 — Add/run red then green cases for valid sources on a final text decision; wrong target/tool/source/account; duplicate sequence/call/event; missing result; ninth entry; one-byte stage/result overflow; retained permission denied; volatile raw result rejection; and erasure idempotence.** Verify reconstructed volatile history is the exact unavailable pair and cannot load a tool schema. Run `npm test -- test/performance/memory-calendar-state.spec.ts`. Expected: complete discovery and passing local/Calendar privacy/bounds assertions.

- [ ] **Step 5 — Checkpoint:** stage the state module/spec only; commit `feat(calendar): retain bounded native read evidence`.

## Task 3: Bind redaction-safe native publication without weakening legacy integrity

**Modify:** `backend/src/chat-runtime/memory-calendar-state.ts`, `backend/src/chat-runtime/memory-first-foundation.ts`, `backend/src/persistence/memory-text-archive.ts`, `backend/src/persistence/memory-calendar-reader.ts`.
**Test:** `backend/test/performance/memory-calendar-state.spec.ts`, `backend/test/performance/memory-text-archive.spec.ts`.

- [ ] **Step 1 — Add a red native archive case by extending the existing `publishes one consolidated native record` test.** Replace its `localState(l)` with `readState(l)` in a separate named test, keeping the original local test. Save with the real `MemoryTextArchive`, fake driver and `MemoryFirstFoundation`. Required assertions:

```ts
const rows = [...db.rows('metadata')!.values()];
expect(rows.filter(r => r.kind === 'memory-calendar-native')).toHaveLength(1);
expect(rows.filter(r => ['calendar-source', 'calendar-tool-result', 'calendar-model-decision',
  'calendar-model-dispatch', 'calendar-model-aggregate'].includes(String(r.kind)))).toEqual([]);
expect(attempts[0]!.nativePublication).toMatchObject({ epoch: accepted.epoch, version: 1, fence: 0 });
expect(await readMemoryCalendarStates(p, session, records, 128, attempts)).toEqual([state]);
```

Name: `archives Calendar evidence as one bounded native dependency with verified erasure`. Seed the fake connection before saving retained state: reuse `connectionV2()` from `backend/test/persistence/calendar-multi-fixtures.ts`, overriding its user/connection/revision to match `accepted.userId` and `source`; keep a real connected record and bounded discovery, not a mocked privacy check. The old local-only archive test requires no connection. Run `npm test -- test/performance/memory-calendar-state.spec.ts -t "archives Calendar evidence"`; initially the erasure/hash portion below must fail, not an external call.

- [ ] **Step 2 — Define the minimum compatible record extension in the existing state module.** Keep old schema-version-1 local records readable and their exact `hashPayload(JSON.stringify(state))` dependency rule. Write Calendar-bearing state as schema version 2 under the **same deterministic document key**, with these additional fields:

```ts
integrity: z.object({ stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  erasedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
redactedAt: isoDateSchema.nullable(),
```

The exported `memoryCalendarRecordSchema` accepts the strict v1/v2 union with the same outer ownership/attempt/version/fence checks. No token/account authority is added. Add one exported pure helper `memoryCalendarIntegrity(state)` returning the two hashes and one `memoryCalendarPublicationHash(record)` selecting the legacy exact-state hash or `hashPayload(JSON.stringify(record.integrity))` for v2. Add `memoryCalendarErasedHash(state)` for normalized erasure hashing.

Exact hash rules: `stateHash` commits the complete original privacy-projected state. `erasedHash` commits the complete canonical attempt-wide Calendar-erased state from Task 2; normalize erasure timestamps to each source's original `fetchedAt` and the valid tombstone reason to `'not-permitted'` before hashing, not identities, accounting, source lifetimes/permission, local evidence, call/tool names, or sequence/linkage. Actual persisted redaction timestamps/reasons remain real ISO timestamps and the real expired/disconnected/not-permitted reason. Every v2 read verifies the attempt's publication hash against immutable `integrity`; unredacted state must match `stateHash`; redacted state must be fully erased, have valid redaction timestamps/reasons, and match `erasedHash` after this normalization. Retained payloads may **not** remain in any redacted record. Reject partial erasure, added fields, changed accounting/arguments/local bytes, missing hashes, and fabricated redaction markers. This is two fixed hashes, not a generic integrity framework or a claim of protection against an attacker who can alter every database record.

- [ ] **Step 3 — Use the helpers in archive/reader.** Build the native record after permission projection and bind `attempt.nativePublication.contentHash` through `memoryCalendarPublicationHash`. Preserve one `ensure` for the native record, ordinary terminal dependencies, sequence `$max`, manifest, save-only seal, final publication CAS and ownership release. No per-result repository writes and no new collection. Keep operation count at or below the existing 32-operation budget; measure actual logical calls/physical commands rather than copying research's unverified `<=21` estimate.

Add `calendarIntegrity?: ReturnType<typeof memoryCalendarIntegrity>` to `TerminalEnvelope` in `backend/src/chat-runtime/memory-first-foundation.ts` and calculate it once in `complete` from the original privacy-projected Calendar state. Include its encoded bytes in the existing evidence/envelope limits. Every expiry/invalidation replacement preserves that immutable value; native v2 construction uses it, rather than recomputing a new commitment from a scrubbed queue copy. This keeps an already-written attempt dependency stable across late redaction and save retry. Local-only legacy records continue exact-state hashing. Add the foundation file to this task's named staging list.

In the reader retain every existing visibility and dependency test; additionally require valid attempt/message owner/session/turn/attempt/epoch/version/fence/sequence linkage for new records and verify terminal dispatches and complete joins. New v2 records need their published attempt dependency; legacy v1 behavior stays compatible. Return valid erased state for tombstone reconstruction, never skip all integrity checks because a flag exists. Version above the session watermark remains invisible; a missing required committed native record remains `NOT_READY`.

- [ ] **Step 4 — Finish red/green archive and tampering tests.** With the same committed record/dependency, erase using `eraseMemoryCalendarState`, set `redactedAt`, and assert cold read/history succeeds as unavailable without raw Calendar data. Change `providerRequestId`, decision/call IDs, result sequence, scope, retained payload, hash, and local disclosure independently: each must reject `NOT_READY`. A record marked redacted while still containing retained data must reject. Keep partial publication, lost acknowledgement, stable retry IDs, saved-but-unacknowledged foundation version and legacy local tests. Run:

```powershell
npm test -- test/performance/memory-calendar-state.spec.ts test/performance/memory-text-archive.spec.ts
```

Expected: all discovered tests pass within unchanged limits. Record the physical command profile; there is no cross-collection atomicity or universal one-write promise. Old binaries cannot consume new v2 Calendar native records; report this forward-format rollback limitation to P3/P4, not as an automatic migration guarantee.

- [ ] **Step 5 — Checkpoint:** stage only changed state/foundation/archive/reader and the two specs; commit `feat(calendar): archive native reads with verifiable erasure`.

## Task 4: Prove prepared reads reach the real executor and continuation without promotion

**Modify:** `backend/src/chat-runtime/memory-text.ts`, `backend/src/chat-runtime/calendar-loop.ts`.
**Test:** `backend/test/performance/calendar-memory-first.spec.ts`.

- [ ] **Step 1 — Replace contradictory old read expectations, not create safeguards.** Update the tests named `failed prior background saving prevents account and external calls`, `flushes dirty prior turns before promoting a read`, `persists a partial active prefix before a read`, and `times out a blocked prior write` to assert approved read behavior. Keep their real archive/failure fixtures but expect read dispatch, three read-turn model requests (activation/call/continuation), completed response, pending/failed/unknown save status, no foreground acceptance/receipt/checkpoint writes, and no inference replay. Do not rename a create test to dodge its barrier assertion.

Use this complete initial regression with the existing `nativeFixture`/`readWires`:

```ts
it('continues a Calendar read and follow-up while the prior raw archive write is held', async () => {
  const f = await nativeFixture();
  const pause = f.db.pauseNextUpdate();
  let run: Promise<void> | undefined;
  f.modelWires.push(textWire('Earlier answer'), ...readWires('unblocked-read'), textWire('Next answer'));
  try {
    const first = await f.submit('Earlier question'); await f.execute(first); await pause.started;
    const memory = f.runtime.memoryFor(f.identity.userId)!;
    const flush = vi.spyOn(memory.foundation, 'flushSession');
    const acquire = vi.spyOn(f.p.owner, 'acquire');
    const next = await f.submit('List events on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', first.sessionId);
    run = f.execute(next);
    await vi.waitFor(() => expect(f.status(next)?.status).toBe('completed'));
    expect(f.effects.filter(e => e.kind === 'list')).toHaveLength(1);
    expect(f.modelBodies).toHaveLength(4);
    expect(flush).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
    expect(toolIds(f.modelBodies[3]!).filter(id => id === 'unblocked-read')).toHaveLength(1);
    const third = await f.submit('Follow up', first.sessionId); await f.execute(third);
    expect(f.status(third)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } });
    expect(f.modelBodies).toHaveLength(5);
    expect(await f.runtime.drain(20)).toMatchObject({ drained: false });
    pause.resume(); await run; await f.saved(third);
    expect(memory.foundation.session(first.sessionId)).toMatchObject({ version: 3, durableVersion: 3 });
  } finally {
    pause.resume(); await run?.catch(() => undefined); vi.restoreAllMocks(); f.runtime.stopAccepting();
  }
});
```

Run `npm test -- test/performance/calendar-memory-first.spec.ts -t "continues a Calendar read"`. Expected red: old `flushSession` blocks the read. This fixture proves runtime/save routing, **not** prepared provider zero-I/O, because its fake authority still uses storage.

- [ ] **Step 2 — Bind prepared authority without adding waits before ordinary inference.** In `MemoryText.hydrate`, replace the direct `p.calendarConnectionsV2.get` with the existing v2 connection owner's prepared `currentAccount()` when Calendar is enabled; cold hydration remains allowed to read history. For new/warm execution, obtain the prepared binding at the first actual Calendar read through the existing loop memory callback, not before initial ordinary/local/Canvas model dispatch. Extend the module-local `CalendarLoopContext.memory` shape in `calendar-loop.ts` with:

```ts
readAccount: () => Promise<CalendarAccountBinding>;
```

Supply it from `MemoryText` using `cal.connection.currentAccount()`, `job.check()` and `assertCalendar(native, account)` before/after the await. Pin the resolved account in the loop binding/cursor and the session's accountBinding, but do not rebind a read already pinned to a different account. A new `'memory-unbound'` loop may bind only once to the prepared owner. Catch disconnection only in optional cold preparation/ordinary paths; a requested read must return the existing safe unavailable result, not fabricate account access. Existing ordinary tests that deliberately block account methods must still assert **zero calls**, not merely swallowed errors.

- [ ] **Step 3 — Route only reads around promotion and durable bookkeeping.** The routing kernel is:

```ts
if (call.name === 'calendar_create_event') {
  await this.promote();
  return this.executeCreateV2(input, executionDecision, decision);
}
return this.executeReadV2(input, executionDecision, decision);
```

At read entry resolve/pin prepared account if in memory; debit `this.ctx.ledger.chargeLogicalTool(decisionId)`, request and refresh counters on that ledger, then pass explicit `{ fresh: false }` to read-only account checks. `chargeProviderRequest` uses the current ledger so capability/pages/freeBusy/retry charges stay finite without storage. Keep writer/fresh capability/preflight/proposal helpers using `durableLedger()` and fresh account mode. Keep `requireDispatchAllowed()` ownership fences for the durable route, and no persistence fence for memory-only reads/local effects.

Build and schema-validate the existing v2 result record first. On `ctx.memory`, put it in `stage` without `registerSource`/`calendarResultsV2.put`; on the durable route preserve those writes. Use raw `skillGroup(native, JSON.stringify(invoked.result), [source])` only for same-turn continuation. Volatile record is reference-only. Validate native ID/tool/source/permission, configured result bytes, stage capacity and complete candidate context before capturing a view or appending the group. No provider read is replayed to repair an archive failure. Keep truthful partial/complete availability coverage and limits.

For read denial/clarification, provider failure, or cancellation that terminates without a model-visible result, set Task 2's exact `terminalCall` marker before terminal state is exported. Do not counterfeit a successful result or call a permission denial `ARGUMENTS_INVALID`. A repair that continues inference still needs its genuine paired local error result; a marker cannot conceal an unmatched call in a continuation.

Preserve privacy when a continuation emits another tool call: store only a single bounded `pendingMemoryDecision` in the loop for live execution, and use that exact original decision in `execute`; clear the slot on consumption/cancel/invalidation. The stage's immutable copy strips source-derived `assistantContent`; if prior volatile sources could appear in a new Calendar call's arguments, store its explicit unavailable/sanitized call envelope from Task 2 instead. The live slot/raw groups are never part of an envelope/archive and remain charged to the argument/result/context limits. Keep first source-free read arguments intact. `decisionRecord` continues nulling volatile-source text decisions. Do not feed sanitized archive arguments back to the provider, and do not relax the shared decision schema to retain volatile-source non-null content. Add a canary regression where a second model call echoes a volatile event summary in `assistantContent`/arguments: provider execution uses the real bounded live decision, staged/archived evidence contains no canary.

Preserve the conservative mixed read-then-create bridge: in `MemoryText.promoteTurn`, replay the bounded logical debit entries already present in the active memory budget through the existing durable ledger's idempotent debit methods, and import request/refresh counts as absolute monotonic values through `ledger.consume`, before returning promotion. For request counts use `Math.max(durable.calendarRequests, active.budget.calendarRequests)` and the analogous refresh value; never re-increment counts during a promotion retry. Do not debit a create in memory or remove any create acceptance/fresh authority/operation/checkpoint barrier. Add a mixed-turn regression that performs one read then a direct create: the durable budget includes the read once, the create still cannot POST before existing durability, and retrying promotion never repeats the read or debits it twice. This is read-accounting compatibility, not P3's barrier optimization.

- [ ] **Step 4 — Add the real prepared executor regression in the same spec.** Build a local fixture from `nativeFixture`'s real fake-driver persistence plus `createCalendarAssembly` (P1 pattern), with `CalendarSecretCipher`/`tokenAad`-sealed synthetic credentials and confirmed v2 discovery. Replace only the injected runtime dependencies using a **new** `DurableChatRuntime({ ...f.runtime.d, calendar: assembly.runtime, calendarFor: () => assembly.runtime })`; do not replace gates, `requireDispatchAllowed`, auth, capability or credentials. The existing assembly returns `{ connections, oauth, execution, runtime }`; reconcile any P1 handoff change before coding. Inject a deterministic fetcher that routes model URLs to `f.fetcher` and Calendar calendarList capability/GET/freeBusy URLs to frozen fixture responses; the fake provider must not itself query application storage. Set `Date.now` to the fixture clock for owner source-expiry calculations and restore it in `finally`.

Warm `assembly.connections.statusV2()`, resolve/current-check targets through its real gate, then block all application repository methods (including inherited methods) and fake-driver collection methods. Use a held custom `SaveTerminal` to separate asynchronous archive work from critical-path I/O; assert no ownership/promotion/checkpointer call. Model activation, read dispatch, returned result, next model request and eligible follow-up must all finish while the hold remains unresolved. Repeat for all four tools; freeBusy includes normal batch/request debit, calendar listing may use the valid prepared snapshot. Assert:

```ts
expect(blockedStorageSpies.every(spy => spy.mock.calls.length === 0)).toBe(true);
expect(continuation.messages.filter(m => m.role === 'user' && m.content === acceptedInput)).toHaveLength(1);
expect(continuation.messages.filter(m => m.role === 'tool' && m.tool_call_id === callId)).toHaveLength(1);
expect(continuation.messages.flatMap(m => m.tool_calls ?? []).filter(call => call.id === callId)).toHaveLength(1);
expect(JSON.stringify(continuation)).not.toContain('fixture-access-token');
expect(JSON.stringify(continuation)).not.toContain('fixture-refresh-token');
```

`blockedStorageSpies`, `continuation`, `acceptedInput`, and `callId` are local variables populated from that spec's spies, captured model body, submitted text and scripted wire ID. Parameterize the test name `prepared production read $tool reaches continuation with application storage blocked` over the four exact read tools above. Use the same setup for a held actual archive write separately (Step 1), not a claim that background storage never runs. No elapsed-time SLA assertion. Run `npm test -- test/performance/calendar-memory-first.spec.ts -t "prepared production read"` red before finishing the runtime changes.

- [ ] **Step 5 — Run green and checkpoint.** `npm test -- test/performance/calendar-memory-first.spec.ts test/runtime/calendar-loop.spec.ts test/runtime/calendar-logical-tools.spec.ts`, then `npm run build`. Expected: real prepared reads and held-save continuation pass; create/proposal tests retain pre-effect persistence and current authority. Stage only loop/memory-text/read spec; commit `feat(calendar): keep prepared reads on the memory-first path`.

## Task 5: Carry provenance and make warm/cold history expiry-safe

**Modify:** `backend/src/chat-runtime/memory-text.ts`, `backend/src/chat-runtime/memory-first-foundation.ts`, `backend/src/chat-runtime/calendar-history.ts`, `backend/src/context/calendar-context.ts`.
**Test:** state spec, context spec, read spec.

- [ ] **Step 1 — Add/run red provenance and expiry tests before edits.** Extend the state spec's existing foundation test to complete with `readState(l)` and `sourceProvenance: [source]`, using its controllable `now`. Assert envelope output contains source provenance; before expiry `memory.nativeGroups()` returns the original retained pair exactly once; at `now === Date.parse(source.expiresAt)` it returns unavailable with no source/payload, without changing visible assistant prose. Name: `keeps read provenance and expires reusable evidence without rewriting narration`. Run `npm test -- test/performance/memory-calendar-state.spec.ts -t "keeps read provenance"`; expected red: completion currently drops provenance.

- [ ] **Step 2 — Add the small terminal field and use the shared projection.** Add `sourceProvenance?: MessageRecord['sourceProvenance']` to `MemoryTerminal`; pass it through `terminalEnvelope` into `messageRecordSchema` output and include its bytes in the existing envelope/output/evidence capacity checks. `MemoryText.finish` passes `e.native?.loop.provenance()` before releasing `e.native`; never lose sources on a read-only terminal. Preserve current truncation, cancellation, live delivery and accounting checks.

Replace local-only `result.resultRef.content` assumptions in foundation native groups and consolidated `calendarHistory` with `memoryCalendarGroups(state, now)`. Give `calendarHistory` an optional `now = Date.now` argument, and pass `() => Date.parse(this.runtime.now())` from both `MemoryText` callers; keep existing durable callers compatible. Apply the same expiry/reference-to-tombstone rule in legacy retained history before result delivery, preserving strict joins and ordered attempt sequences. Native history and separately persisted legacy history must not duplicate the same call when both are present; conflicting duplicate identities fail, not silently override.

- [ ] **Step 3 — Add/run red context isolation tests.** In `calendar-context.spec.ts`, reuse existing `v2Group`, `v2Source`, `binding`, `context`, `now`. Add:

```ts
it('rejects a redacted live volatile source even when its id remains admitted', () => {
  const source = sourceReferenceV2Schema.parse({ ...v2Source,
    expiresAt: v2Source.fetchedAt, redactedAt: v2Source.fetchedAt,
    permission: { ...v2Source.permission, content: 'volatile' },
    targets: v2Source.targets.map(t => ({ ...t, calendarLabel: null })) });
  expect(() => calendarContext({ context, acceptedInput: 'Check my event',
    groups: [{ ...v2Group, sources: [source] }], repair: null, tools: SKILL_NATIVE_TOOLS,
    budgets: DEFAULT_BUDGETS, limits: CALENDAR_LIMITS, binding, now,
    volatileSourceIds: new Set([source.sourceId]) })).toThrow();
});
```

Run `npm test -- test/context/calendar-context.spec.ts -t "redacted live volatile"`; expected red: current volatile branch skips `redactedAt`. Check revocation before allowing the explicit current-turn volatile exception; zero-lifetime volatile sources remain usable only in the same active turn set, not arbitrary historical groups. Distinguish `groups` from `historicalGroups`: historical unavailable pairs may be withheld with the existing `HISTORY_WITHHELD_NOTE`, but a current unavailable result must not count as successful schema/API authority. Do not weaken current provenance/target/bounds validation.

- [ ] **Step 4 — Expand red/green warm/cold assertions.** Update the old `cold-hydrates promoted Calendar history` read test to await its actual async save before restarting and assert consolidated native evidence, not promoted per-result metadata. Before expiry original call/result and input appear once; after expiry no stale tool payload is sent, narration remains, and the existing model-only `do not recant` note appears. Include volatile provider event/label/link canaries: they appear in the immediate continuation fixture, never `stage`, `envelope.calendar`, native docs, or later tool context. Inspect derived decisions as well as resultRef. Run:

```powershell
npm test -- test/performance/memory-calendar-state.spec.ts test/context/calendar-context.spec.ts test/performance/calendar-memory-first.spec.ts test/runtime/calendar-answer-regressions.spec.ts
```

Expected: passing discovery, legacy v1 read-only compatibility retained, no history truncation to fit limits, visible transcript policy unchanged.

- [ ] **Step 5 — Checkpoint:** stage the four production paths and changed named specs; commit `fix(calendar): expire reusable read history and retain provenance`.

## Task 6: Scrub lifecycle invalidation and close queued/in-flight archive races

**Modify:** `backend/src/chat-runtime/memory-text.ts`, `backend/src/chat-runtime/calendar-loop.ts`, `backend/src/chat-runtime/memory-first-foundation.ts`, `backend/src/persistence/memory-text-archive.ts`, `backend/src/persistence/calendar-retention.ts`.
**Test:** read/state/archive/foundation specs and `backend/test/persistence/calendar-multi-retention.spec.ts`.

- [ ] **Step 1 — Write the direct invalidation red test.** In the read spec use the real prepared assembly from Task 4; hold the provider response after normal request debit, call `runtime.invalidateCalendarAccount(account, 'disconnect')`, and hold retention/quiescence storage separately. Assert the optional `cal.connection.invalidateAccount` spy was called synchronously, a new old-account read is denied before storage settles, and releasing the old response cannot publish a Calendar view/result or dispatch a source-consuming continuation. Existing ordinary chat can still proceed after the affected turn terminates. Name: `invalidates prepared reads before retention waits and rejects late publication`. Run `npm test -- test/performance/calendar-memory-first.spec.ts -t "invalidates prepared reads"`; expected red without the runtime hook.

- [ ] **Step 2 — Implement local invalidation before any await.** In `MemoryText.invalidateCalendarAccount`, return immediately for another user; call P1's synchronous hook on the existing v2 dependency, then update scoped bounded tombstones and generation invalidation. Do not let the current global `invalidation++`/`native.invalidation` comparison reject an unrelated replacement-account turn: advance/mark affected active executions only, with the full known account binding; unbound ordinary/Canvas turns remain conversational. Scrub cached historical groups/proposals, active `e.calendar`, loop groups/provenance/view, foundation baseCalendar and terminal calendar, and all queued envelopes. A replacement account's data must not be erased by a late old-account callback. Add a small module-local loop method `invalidateCalendarAccount(account)` called from `MemoryText`; it erases matching groups and marks that active Calendar read invalid, with no storage or mutation replay. Check this before view capture, before/after every read await, at model continuation, and before publishing source-dependent deltas/terminal content. Preserve already confirmed create receipt/uncertainty semantics; do not rewrite a create outcome into a retryable read failure.

For already returned reads, use `requireAccountCurrent(account, signal, { fresh: false })` and the latest prepared record's discovery/retention/current capabilities to revalidate each active source before source-consuming continuation/output. Compare pinned targets and private visibility conservatively; never call provider `checkTarget`, raw storage, refresh or CAS for each delta on the valid prepared path. P1 owns provider in-flight checks; this P2 check covers the later model-consumption/publication window. A changed/expired target is safe-unavailable, not permission to relabel old data with a new expiry.

Foundation result and queue must refer to the **same replacement frozen envelope** after scrubbing; replacing only `s.results` leaves old `s.jobs` unsafe. Recompute/reduce retained bytes conservatively and never create unreserved growth. Expire/scrub again when a queued retry is dispatched, not only when history is consumed. Do not reset attempts, retryAt, order, raw promise ownership, or session fences. A pending raw call cannot be cancelled by replacing its immutable input.

- [ ] **Step 3 — Add bounded native redaction to retention.** Add `kind: 'memory-calendar-native'` to the existing metadata keyset traversal in `sweepMultiCalendarPage` and account-invalidation `$or`. Use `$elemMatch` against `state.results`/`resultRef.source` and `state.decisions`/`sources` with **same-element** connection ID/revision constraints; do not combine separate matches from different entries. Check parsed outer user and matching source before erasure. `sweepPage` must cover native records through its own bounded keyset page, not an added `.limit(50)` side scan that starves later records; its returned raw `_id` cursor can traverse the union of source/native kinds compatibly. Retain existing cursor validation and legacy derived handling.

For an affected v2 record, keep `integrity` immutable, apply full Calendar erasure from Task 2, set real `redactedAt`, and use `replaceInvalidatedRecord`'s bounded CAS/readback confirmation. Keep publication dependency identities untouched. Preserve the existing `redactAssistantAttempt` call/provenance projection without changing narration content or unresolved operation retention. Legacy v1 local records need no erasure. Never fan out every contained result into source/result records.

- [ ] **Step 4 — Close late-writer privacy races in the archive, not only the sweep.** The archive may have captured a frozen envelope before account revocation/expiry. Before native insertion and again after every raw native write settles, refresh the privacy projection using current time/current persisted account revision through existing `readCurrentCalendarAccountBinding` **in background only**. Compare outer `e.userId` and every result/text source's connection ID/revision to the current binding. Subject identity was validated by the full P1 account binding when obtaining the source; never invent a subject from source metadata. No credential or extra authority field is needed in the envelope. On denied/expired/uncertain authority, archive only verified erased Calendar evidence (visible transcript policy unchanged); do not fail an otherwise valid read or re-run inference.

A stale write released after the final invalidation page must CAS-erase its own native record before reporting saved. Recheck around final publication so it cannot publish reusable stale evidence. Use Task 3's anchored erasure hash: retries may accept an existing canonical-erased record with the same immutable publication identity, never restore retained content over it, never accept unrelated payload mismatch, and never change an already-written attempt's dependency hash. Preserve `envelope.calendarIntegrity`; projection may monotonically erase after that. Extend `ensure` only for native canonical erasure and message provenance-only erasure: a message's content/identity/sequence/terminal fields must remain byte-identical, and only existing Calendar source redaction/label-null transitions are allowed. Already-erased messages/native records are never restored by an older envelope. Arbitrary mismatches retain `IDEMPOTENCY_PAYLOAD_MISMATCH`. If authority confirmation/erasure fails, return tracked `unknown`/retryable outcome and retain raw ownership; do not report saved. These checks add legitimate **post-response** commands: count them within 32; replace redundant archive reads rather than raise the limit. Native read privacy protection does not authorize P3 archive-lock changes.

- [ ] **Step 5 — Add/run red then green race/paging cases.** In state/archive/retention specs: invalidate while a native insert is held; finish all account pages, release the old write, inspect raw fake-driver native bytes and cold-hydrate; private canaries must be absent, identity/accounting retained, history explicitly unavailable. Test queued retry after expiry, already-redacted retry, commit-then-error CAS acknowledgement, CAS mismatch, more than 50 native records with `limit: 1`, mixed source/native pages, wrong-user/account/revision isolation, stale cursor rejection, and a replacement account. A flag-only hash bypass must still fail. Update the old `races the promotion flush` and `persisted active prefix` read tests to race actual in-memory read account/debit/provider barriers instead of expecting promotion. Run:

```powershell
npm test -- test/performance/calendar-memory-first.spec.ts test/performance/memory-calendar-state.spec.ts test/performance/memory-text-archive.spec.ts test/performance/memory-first-foundation.spec.ts test/persistence/calendar-retention.spec.ts test/persistence/calendar-multi-retention.spec.ts
```

Expected: meaningful tests pass, raw saves stay pinned through timeout/drain, no revoked/expired source re-enters context. Checkpoint named task files only; commit `fix(calendar): erase invalidated native evidence across async saves`.

## Task 7: Prove bounded save-failure continuation and shared text/live behavior

**Modify only if a focused regression identifies a P2 defect:** the owned production paths above.
**Test:** `backend/test/performance/calendar-memory-first.spec.ts`, `memory-text-archive.spec.ts`, and `memory-first-foundation.spec.ts`.

- [ ] **Step 1 — Add/run the new failure expectation before changing it.** Rename the old prior-save failure read case to `continues reads through temporary archive failure within memory bounds`. Its save port initially returns `{ kind: 'unknown', retryable: true }`; second read and model continuation complete without `retryTurn`, acceptance/checkpoint writes or a second provider read. Save status remains visible; after archive becomes available, advance the fixture clock by `retryBackoffMs + 1`, use the existing `retrySave`, and verify ordered durable versions. The provider/model call counts do not change during save retry. Run `npm test -- test/performance/calendar-memory-first.spec.ts -t "temporary archive failure"`; expected red against old fail-on-flush behavior.

- [ ] **Step 2 — Test limits independently, do not relax them.** With `nativeFixture` policy overrides exercise `maxEnvelopes: 2`, exhausted shared backlog, `maxDirtyAgeMs` exact boundary, per-session request/evidence bytes, session fence, cancelled/deadline read and request/refresh exhaustion. After two dirty terminal envelopes, the third submission fails `NOT_READY` before another model/provider call; after the age deadline the next admission fails likewise. A temporarily failed archive alone does not fence safe bounded reads. A known inconsistent publication/owner fence does. Keep three total save attempts and backoff; raw timeout does not release save concurrency or begin an overlapping retry. Reuse existing foundation tests for the underlying scheduler rather than adding a second queue.

- [ ] **Step 3 — Reconcile the cross-mode read regression.** Update `preserves dirty text then voice hearing and Canvas projections through Calendar promotion` to assert **no read promotion**: leave the first archive write held; text and completed live voice keep heard/generated distinctions and Canvas artifact projection; release the live reservation, execute the Calendar read and its continuation before releasing storage. Only then drain ordered versions 1, 2, 3 and inspect archived delivery/native state. Add the inverse Calendar-live-read then text-follow-up using the existing `VoiceDelivery` setup in this spec; terminal heard evidence still gates live next-turn eligibility, archive completion does not. Do not enable tools in any mode that lacks them.

- [ ] **Step 4 — Run shared-mode and local-effect regressions.**

```powershell
npm test -- test/performance/calendar-memory-first.spec.ts test/performance/memory-first-text.spec.ts test/performance/memory-first-voice.spec.ts test/performance/memory-first-foundation.spec.ts test/performance/calendar-voice-latency.spec.ts test/performance/calendar-critical-path.spec.ts test/runtime/calendar-memory-voice.spec.ts test/runtime/calendar-voice-authority.spec.ts
```

Also run `npm test -- test/contracts/canvas-navigation.spec.ts test/contracts/canvas-navigation-wire.spec.ts test/runtime/canvas-navigation.spec.ts test/runtime/canvas-navigation-ownership.spec.ts test/voice/integration/canvas-navigation.spec.ts test/voice/integration/canvas-multimodal.spec.ts`. No new Canvas implementation scope or native e2e call. Expected: finite accounting, one active attempt across tabs/modes, no duplicate speech/inference/effect on replay, Canvas fast path and cancellation/drain unchanged. Report reproducible baseline failures separately and route out-of-owner defects to the orchestrator.

- [ ] **Step 5 — Checkpoint:** stage only actual changed P2 files; commit `test(calendar): verify bounded asynchronous read continuation`.

## Task 8: Verify the owned slice and hand off to P3/P4

- [ ] **Step 1 — Trace all callers of changed helpers.** Search `memoryCalendarStateSchema`, `memoryCalendarRecordSchema`, `resultRef.content`, `nativeGroups`, `calendarHistory`, `requireAccountCurrent`, `chargeProviderRequest`, `invalidateCalendarAccount`, `terminalEnvelope`, and archive `save`. Fix P2 union assumptions at their shared owner once. Check durable callers read-only: fresh mutation/reconciliation, proposals, create debit and operation CAS/receipt behavior remain unchanged; a mixed read/create turn still crosses the durable boundary at the create with Task 4's read accounting preserved. Any required change outside P2 ownership goes to the orchestrator, never a weakened barrier.

- [ ] **Step 2 — Run final focused checks, build, and lint separately in `backend/` with native-test URI cleared.**

```powershell
npm test -- test/performance/calendar-memory-first.spec.ts test/performance/memory-calendar-state.spec.ts test/performance/memory-text-archive.spec.ts test/performance/memory-first-foundation.spec.ts test/performance/memory-first-text.spec.ts test/performance/memory-first-voice.spec.ts test/context/calendar-context.spec.ts test/persistence/calendar-retention.spec.ts test/persistence/calendar-multi-retention.spec.ts test/runtime/calendar-loop.spec.ts test/runtime/calendar-logical-tools.spec.ts test/runtime/calendar-answer-regressions.spec.ts test/runtime/calendar-operation.spec.ts test/runtime/calendar-confirmation.spec.ts test/runtime/calendar-recovery.spec.ts test/runtime/calendar-memory-voice.spec.ts test/runtime/calendar-voice-authority.spec.ts test/performance/calendar-voice-latency.spec.ts test/performance/calendar-critical-path.spec.ts
npm run build
npm run lint
```

Expected: all selected files actually discovered and passing; build/lint exit zero, warning counts reported. Native/service/live tests are not authorized or passing merely because they skip. Full `npm test`/`npm run test:e2e`, assembled integrated performance profile, and final eight-criterion evidence remain P4 gates. Frontend is untouched; no unrelated frontend check is required for this slice.

- [ ] **Step 3 — Require these exit gates before declaring the worker complete.**

| Gate | Required deterministic evidence |
| --- | --- |
| Prepared provider path | All four tools traverse real P1 owner/credentials/capability/executor with application storage blocked after preparation; zero promotion/flush/ownership/checkpointer calls before provider or continuation. |
| Immediate result/next input | Original call/result and accepted input once; continuation and eligible follow-up finish with actual archive held; held writes drain in order afterward. |
| Complete bounded evidence | Native local/Calendar union, source/text decisions, exact accounting and finite charges; one consolidated native document per attempt within existing 32-operation/byte limits; no per-result fan-out. |
| Privacy/history/integrity | Volatile tool content stays in same-turn groups only; retained evidence permission-bounded; expiry/account erasure scrubs memory, queue, retry, raw persisted native data and cold history; forged redaction cannot bypass hashes. Visible narration remains unchanged. |
| Authority/invalidation | Direct runtime hook synchronous; disconnect/reconnect/disable/target/account races reject late results/publication; cross-user/account/session isolation; no TTL-only revocation. |
| Save supervision | Visible pending/failed/unknown states, finite retry/backoff/age/bytes/counts, pinned raw work, bounded drain and no persistence close before raw save settlement. |
| Compatibility/mutations | Legacy local/native and v1 read-only history still safe; unsupported/cold paths explicit; existing create/proposal/recovery barriers and Canvas remain intact. Format rollback limitation recorded. |
| Honest handoff | Exact prerequisite/worker commits, tests/counts/skips, build/lint, command/stage observations, remaining P3/P4 work and review **skipped** reported. |

- [ ] **Step 4 — Commit remaining task changes after permission.** Run `git diff --check`, inspect named-file diff/stat and staged paths. Final message if needed: `fix(calendar): complete memory-first read safety gates`. Never `git add .`; exclude concurrent P1 files, generated output, secrets, locks and workflow status documents.

- [ ] **Step 5 — Return exact worker handoff, not overall completion.** Tell P3 which shared files changed; memory ledger now includes read debits/request counts; read-only turns use the existing queue/native envelope, while creates still use conservative promotion. P3 must preserve prepared read continuation, permission/integrity/retention helpers, dirty-prefix ordering, async archive bounds and old create safety while narrowing its barrier. Give P4 named tests, prepared versus cold limitations, observed commands/sequential waits and failures/skips; P4 owns the integrated performance file, full verification and final AGENTS policy. Do not dispatch a reviewer.

## Planning verification and plan-only commit

- This plan deliberately corrects research's fresh-default, invalid `redacted` outcome, unsafe hash-bypass and visible-transcript-redaction suggestions against exact current contracts. The lazy read-account callback preserves existing zero-account-call ordinary/Canvas tests while using P1 authority only when actually needed.
- Planning does not certify tests or implementation. Commands above are worker instructions; no application test was run by this planner. Context7 Vitest 4 documentation confirmed `vi.waitFor` retries thrown/rejected async assertions and `vi.restoreAllMocks` restores spies; repository fixtures remain the API/source authority for application code.
- Self-check: AC1/AC2 and P2's AC5/AC7 coverage are assigned above; create optimization/recovery is P3, integrated measurements/final instructions are P4. No new dependency, external call, authorization relaxation, unbounded map/queue, mutation scope or root-instruction edit is planned.
- Validate relative Markdown links, all existing file paths (the P4 future test is deliberately not created), spelling of current symbols, ownership, dependency gates and whitespace. Inspect `git diff --cached --name-only` before committing; the only staged file for this planning delivery must be this plan.

```powershell
git add -- docs/calendar-tool-latency/plan2.md
git commit -m "docs(calendar-tool-latency): plan 2 - memory-first reads"
```
