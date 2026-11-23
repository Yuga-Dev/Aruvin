# Calendar tool latency — P4 integrated verification

## Status and scope

**Status: P4 integrated verification complete. The two blocking acceptance failures are resolved; the integrated spec passes 47/47 with exit 0, independently rerun by the orchestrator. AC1–AC3 and AC6–AC8 pass; AC4 and AC5 pass on the covered cases with the listed not-run variants. Review is **skipped**, never passed. Baseline full-suite/e2e failures and the stated coverage/measurement gaps remain open and are not P4 acceptance failures.**

This document records P4's assembled-path verification of the Calendar read/create critical path, the minimal mutation barrier, crash recovery, invalidation/isolation, and deterministic measurements. It does not certify native MongoDB, Azure, live Google/OpenRouter/LiveKit, staging, topology, or production latency. The P4 test slice is `backend/test/performance/calendar-tool-latency.spec.ts` with the new fixture and trace helpers. P4 itself modifies only that spec/fixture, this document, and the additive root `AGENTS.md` policy; the P1 production fix and the P1/P2 regression tests are separate owner changes recorded below. No package manifest or existing workflow document was modified by P4.

The integrated spec discovers **47 tests: 47 passed, 0 failed**. The former failures and their resolutions are recorded next.

## Resolved acceptance defects

| Former failure | Root cause | Resolution | Final evidence |
| --- | --- | --- | --- |
| `repeated prepared owner request preparation does not touch application storage` (P1) | `GoogleCalendarConnections.statusV2()` called `readPreparedOrFreshRecord({ fresh: true })`, so every warm status check re-read the connection store. A second warm `AppService.prepareOwner` reached `refreshCalendarStatus` → `statusV2` → `MongoCalendarConnections.getCompatible` → one `RecordStore.collection` call. | Changed `statusV2()` to prepared mode (`fresh: false`) in `backend/src/plugins/google-calendar/connection.ts`. Cold start (no prepared record) and invalidation still rehydrate; explicit fresh checks (`requireAccountCurrent` without `fresh: false`) remain the refresh path. No other production file changed. | `repeated prepared owner request preparation does not touch application storage` (P4, 47/47); `warms prepared account authority via AppService.prepareOwner without later storage get calls`; `reuses warmed status and account without opening connection storage`; `rehydrates status after invalidation without restoring revoked authority`; P1 10-file selection 114/114 (orchestrator rerun); broader plugin/assembly 326/326 (worker-reported); P4 warm-path case passes. |
| `source expiry at exactly expiresAt forces a fresh provider read` (P2) | Source expiry was already correctly enforced with `now >= expiresAt` in history/context/publication. The P4 fixture set the Calendar policy deadline to `CLOCK + 1 hour`; `effectiveSourceExpiry` clamps source expiry to `min(fetchedAt + 24 h, policyDeadline)`, so the old test advanced to the policy deadline and measured the policy's safe denial, not source reuse. Its expectation of a fresh provider read therefore could not hold. | No production deadline comparator changed. The fixture gained an optional `policyLifetimeMs`; the source-expiry test now uses a 48-hour policy with a 24-hour source lifetime and asserts a fresh provider GET plus fresh content. A separate policy-expired test uses the default 1-hour policy and asserts safe denial with no provider request and no stale content. | `source expiry at exactly expiresAt forces a fresh provider read`; `expired policy denies a Calendar read without a provider request or stale content` (P4, 47/47); `keeps read evidence usable until its expiry and never reuses it at or after the exact boundary`; `keeps retained read evidence usable until its expiry and tombstones it at the exact boundary`; P2 seven-file selection 179/179 (orchestrator rerun). |

The P1 fix, P2 regression tests and P4 finalization were committed by the orchestrator after this document's handoff: P1 `fcb09ae`, P2 `327d55d`, P4 `b7d0032`; the final report/state commit is `1c2ac20`.

## Commit set and workspace

| Item | Value |
| --- | --- |
| Branch | `main`; ahead 2 of `origin/main` at entry, ahead 4 at finalization |
| Entry HEAD | `3cdb07d` |
| Current HEAD at finalization | `e8e79fa` at handoff; final commits `fcb09ae`, `327d55d`, `b7d0032`, `1c2ac20` |
| P4 committed slice | `4c53b47` — `test(calendar): add integrated tool latency and recovery coverage` |
| P4 committed evidence | `e8e79fa` — `test(calendar): verify integrated tool critical paths and recovery` (initial 46-test evidence) |
| P1 implementation | `67bb366` |
| P2 implementation | `3742a38` |
| Plans | `4d62254`, `86253c3`, `10f2f07`, `c592e55` |
| P3 implementation | `07f723a` |
| P3 tests/profiling | `3cdb07d` |
| P1 owner fix | `fcb09ae` — `fix(calendar): reuse prepared authority for warm status`; `backend/src/plugins/google-calendar/connection.ts` (`statusV2` prepared mode); regression tests in `backend/test/plugins/google-calendar/connection-prepared.spec.ts`, `backend/test/plugins/google-calendar/tools-boundaries.spec.ts`, and `backend/test/assembly/calendar-assembly.spec.ts`. |
| P2 regression tests | `327d55d` — `test(calendar): cover exact source expiry boundary`; `backend/test/performance/calendar-memory-first.spec.ts` and `backend/test/performance/memory-calendar-state.spec.ts`; no production change. |
| P4 finalization | `b7d0032` — `test(calendar): finalize integrated verification and tool policy`; `backend/test/performance/calendar-tool-latency-fixture.ts`, `backend/test/performance/calendar-tool-latency.spec.ts`, `docs/calendar-tool-latency/verification.md`, and root `AGENTS.md`. |
| Final report/state | `1c2ac20` — `docs(calendar-tool-latency): final verification report`. |
| Dirty paths at P4 entry | `docs/calendar-tool-latency/state.md` (orchestrator-owned; not staged), `.commandcode/` (untracked local config; preserved), `docs/web-search/` (unrelated work; preserved) |
| P4 changed paths | `backend/test/performance/calendar-tool-latency.spec.ts`, `backend/test/performance/calendar-tool-latency-fixture.ts`, `docs/calendar-tool-latency/verification.md`, `AGENTS.md` |

No separate worktree was used. `state.md`, `goal.md`, `final_report.md`, `.commandcode/`, and `docs/web-search/` were not edited or staged by P4. The P4 test/fixture modifications, this document, and the additive root policy are the only P4 files in the final evidence commit.

## Environment and fixture protocol

| Item | Value |
| --- | --- |
| OS / shell | Windows, PowerShell 7 |
| Node / npm | Node `v24.19.0`, npm `11.17.0` |
| Date | 14 November 2026 |
| Sanitized process environment | `AURVIN_TEST_MONGODB_URI`, `MONGODB_URI`, `OPENROUTER_API_KEY`, `GOOGLE_CLIENT_SECRET`, `LIVEKIT_API_SECRET` removed before every command |
| Persistence | Existing in-memory BSON fake driver (`calendarMemory`) through the real `AppService`, `DurableChatRuntime`, persistence bundle, repositories, checkpointer, and ownership paths |
| Providers | Synthetic OpenRouter SSE wires and synthetic Google Calendar HTTP routes; unknown destinations throw |
| Fixture clock | `2026-11-03T09:00:00.000Z` (`Date.now` spy) |
| Profile constants | `DependencyProbe('wave')` with `readMs: 67`, `writeMs: 449` |
| Policy deadline | Default `CLOCK + 1 h`; the source-expiry test overrides it to `CLOCK + 48 h` with a 24 h source lifetime; the policy-expired test keeps the default 1 h |
| Live services | None; no paid calls, application DB, provisioning, restart, or deployment |
| Native prerequisites | Not supplied; native/service suites skip or are not run |

The fixture opens one `AppService`/runtime/persistence-close owner per case, uses the stock memory-first saver, observes command starts/completions through the fake driver, and restores spies/holds in `finally`. Tests are sequential within the file because the saver observer and clock spy must not overlap. The synthetic provider keeps external event state across crash images; a process crash does not undo a Google effect. The wave model is a deterministic dependency model, not a latency simulator.

## Baseline and open defects

### Inherited evidence (reported by earlier workers; not independently reproduced in this P4 session)

- Research on `7c4ac68`: seven files / 124 passed; backend build/lint passed with 711 lint warnings. Synthetic legacy lookup: 197 reads / 73 writes / 262 waves, first dispatch 14,595 ms, first delta 34,410 ms. Legacy confirmation: 0 prior turns 158/45/199, receipt 21,108 ms; 8 prior turns 182/45/223, receipt 22,716 ms. These are historical synthetic results, not current or live performance.
- P1 `67bb366`: reported selection 32/33 files, 344 passed, two `calendar-capability` failures; initial build hit three errors in then-dirty `calendar-loop.ts`/`calendar-skills.ts`; lint exit 0 with 720 warnings. The "pre-existing" attribution has no independently replayed clean baseline.
- P2 `3742a38`: focused seven files / 153 passed; broader 19 files / 365 passed; build/lint passed with 731 warnings. Separate voice-latency check 12 passed / 2 failed at 160 vs ≤158 and 184 vs ≤182 reads; `memory-first-voice.spec.ts` had four skips and one worker crash.
- P3 `07f723a`/`3cdb07d`: focused recovery 7 files / 123 passed; three changed test files 91/91; full Task 7 focused set 22 files, 17 passed / 4 failed, 363 passed / 8 failed; build exit 0; lint exit 0 with 742 warnings; `local-owner.spec.ts` 8 passed / 1 failed on the known `$or` shape.

### Actual P4 reruns

| Check | Actual result |
| --- | --- |
| Integrated spec (final) | 47 tests: 47 passed, 0 failed; exit 0. Independently rerun by the orchestrator with service/secret env cleared after the P1 warm-path fix and the P4 policy/source-expiry separation. |
| P1 focused selection (final) | 10 files: 114 passed, 0 failed; exit 0. Orchestrator rerun; includes the prepared-status regressions. |
| P1 broader plugin/assembly | 29 files: 326 passed, 0 failed; worker-reported, not independently rerun in finalization. |
| P2 focused selection (final) | Seven source/archive suites: 179 passed, 0 failed; exit 0. Orchestrator rerun; includes the exact-boundary source/policy tests. |
| P2 broader selection | 19 files: 14 files passed; four known baseline-failure files (8 failed tests plus one worker error); worker-reported. |
| Focused 26-file selection (Task 8 Step 1) | 26 files: 21 passed, 4 failed; 403 tests: 394 passed, 8 failed; 1 Vitest worker error; exit 1. Failures: four `calendar-confirmation.spec.ts`, two `calendar-voice-latency.spec.ts`, one `calendar-memory-voice.spec.ts`, one `calendar-voice-authority.spec.ts`. Same failure set as the pre-P4 focused baseline (which had 393 passed / 8 failed); the one-test pass-count difference is not attributed to P4. |
| Full `npm test` (pre-fix rerun) | 374 files: 359 passed, 12 failed, 2 skipped; 3,536 tests: 3,483 passed, 41 failed, 10 skipped; 1 worker error; exit 1. The 41 failures include the eight focused-baseline failures, the two former P4 acceptance failures (now resolved separately), 19 `durable-latency.spec.ts` performance-ceiling failures, three `local-guard.spec.ts`, three `local-open.spec.ts`, one `calendar-assets.spec.ts`, one `calendar-simplification.built.spec.ts`, one `finalization-repair.spec.ts`, and one `local-owner.spec.ts`; the remaining failures are additional `durable-latency` cases. |
| Full `npm test` (post-fix orchestrator rerun) | 374 files: 360 passed, 11 failed, 2 skipped; 3,540 tests: **3,489 passed, 39 failed, 10 skipped**; 1 Vitest worker error; exit 1. Failing files: `durable-latency.spec.ts` (21 under concurrent load; 19 in the isolated run), `calendar-confirmation.spec.ts` (4), `calendar-voice-latency.spec.ts` (2), `calendar-memory-voice.spec.ts` (1), `calendar-voice-authority.spec.ts` (1), `local-guard.spec.ts` (3), `local-open.spec.ts` (3), `calendar-assets.spec.ts` (1), `calendar-simplification.built.spec.ts` (1), `finalization-repair.spec.ts` (1), `local-owner.spec.ts` (1). No P4 acceptance failure remains; the listed failures are baseline/environment classes. |
| `npm run test:e2e` (post-fix rerun) | 48 files: 3 passed, 1 failed, 44 skipped; 183 tests: 35 passed, 8 failed, 140 skipped; exit 1. All eight failures are in `test/assembly/voice-bootstrap.e2e-spec.ts` (voice transport/audio path); identical to the pre-fix run. |
| Additional isolated classification | `local-guard`, `local-open`, `calendar-assets`, `calendar-simplification.built`, `finalization-repair`, and `local-owner` fail in isolation too (10 failed / 31 passed across the seven-file run); `durable-latency.spec.ts` fails in isolation (19 failed / 42 passed). These are not caused by the P4 test files. `canvas-navigation.spec.ts` passed in isolation. |
| Cancellation spot-check (final) | `keeps one provider effect when a create is cancelled at the dispatching CAS or after success` (P3 `calendar-memory-first.spec.ts`): 1 passed, 64 skipped; exit 0. Run during finalization to substantiate the policy's cancellation check. |
| P1 invalidation spot-check (final) | `rehydrates status after invalidation without restoring revoked authority` (P1 `connection-prepared.spec.ts`): 1 passed, 14 skipped; exit 0. Run during finalization to substantiate the policy's invalidation check. |

The full-suite numbers above include a **post-fix** orchestrator rerun after the P1 warm-path fix and the P4 fixture correction: 3,489 passed / 39 failed / 10 skipped with one worker error. The two former P4 acceptance failures are resolved by the 47/47 integrated rerun. The post-fix e2e rerun is unchanged at 35 passed / 8 failed / 140 skipped. The remaining full-suite/e2e failures are baseline/environment failures in files P4 did not modify.

An earlier full-suite run showed one `voice/integration/canvas-navigation.spec.ts` failure; the final rerun and the isolated Canvas run did not reproduce it, so it is classified as **concurrent-dirty / full-suite-order uncertain**, not introduced by P4. The `durable-latency` and local-guard/local-open failures are **reproduced baseline/environment** failures in files P4 did not modify. The eight focused-baseline failures remain open; P4 did not change their files or expectations.

## Commands and actual outcomes

All commands were run in `backend/` with the sanitized environment unless noted.

| Command | Actual outcome | Evidence |
| --- | --- | --- |
| `npm test -- test/performance/calendar-tool-latency.spec.ts` (final) | 47 tests: 47 passed, 0 failed; exit 0; independently rerun by the orchestrator | orchestrator rerun |
| P1 10-file focused selection | 114 tests: 114 passed; exit 0 | orchestrator rerun |
| P1 broader plugin/assembly selection | 326 tests: 326 passed; exit 0 | worker report |
| P2 seven-file focused selection | 179 tests: 179 passed; exit 0 | orchestrator rerun |
| P2 broader 19-file selection | 14 files passed; 4 baseline-failure files; 8 failed tests plus one worker error | worker report |
| `npm test -- test/performance/calendar-memory-first.spec.ts -t "keeps one provider effect when a create is cancelled at the dispatching CAS or after success"` | 1 passed, 64 skipped; exit 0 | finalization spot-check |
| `npm test -- test/plugins/google-calendar/connection-prepared.spec.ts -t "rehydrates status after invalidation without restoring revoked authority"` | 1 passed, 14 skipped; exit 0 | finalization spot-check |
| `npm test -- test/performance/calendar-memory-first.spec.ts ... test/assembly/auth-calendar.spec.ts` (26-file selection) | 403 tests: 394 passed, 8 failed; 1 worker error; exit 1 | `focused-p4-rerun.log` (session artifact) |
| `npm run build` | exit 0 | orchestrator rerun; P1 owner also reported exit 0 |
| `npm run lint` | exit 0; 742 warnings; zero warnings in the three new P4 files | P4 session lint output; P1 owner reported exit 0 after the fix, not independently rerun |
| `npm test` (post-fix orchestrator rerun) | 3,540 tests: 3,489 passed, 39 failed, 10 skipped; 1 worker error; exit 1 | orchestrator rerun; baseline/environment failures only |
| `npm run test:e2e` (post-fix) | 183 tests: 35 passed, 8 failed, 140 skipped; exit 1 | orchestrator rerun; same voice-bootstrap failures as pre-fix |
| `npm test -- test/runtime/canvas-navigation.spec.ts test/runtime/canvas-navigation-ownership.spec.ts test/voice/integration/canvas-navigation.spec.ts test/voice/integration/canvas-multimodal.spec.ts` | 4 files, 77 tests, all passed; exit 0 | `canvas-p4.log` (session artifact) |
| `git diff --check` | clean at finalization; only CRLF/LF conversion warnings, no whitespace errors | finalization output |

Frontend build/lint/test were **not run**: P4 changed no frontend source. Native MongoDB, Azure, live provider, staging, topology, OAuth refresh, and live timing were **not run**.

## Acceptance matrix AC1–AC8

| Goal | Required P4 evidence | Actual P4 outcome | Defect owner / note |
| --- | --- | --- | --- |
| AC1 Prepared read dispatch | Four real prepared routes with application storage blocked | **Pass.** `prepared calendar_list_calendars|calendar_list_events|calendar_get_event|calendar_check_availability dispatches and continues with application storage blocked` (4 cases). Each dispatches, continues the model, and completes an eligible follow-up with `RecordStore.collection` blocked: zero storage calls, zero trace commands, exact provider request sequences, zero event POSTs. `repeated prepared owner request preparation does not touch application storage` also passes after the P1 fix. | P1/P2; no defect observed on these routes. |
| AC2 Immediate continuation/follow-up | Complete pair/input once; next model dispatch and eligible follow-up before held saves | **Pass.** `read continuation and follow-up finish while an actual archive owns persistence`: read continuation and follow-up complete while a real archive owns persistence; bounded drain reports `drained: false` with unresolved writes; after release, durable versions are exactly `[1,2,3]`. | P2/P3. |
| AC3 Minimal mutation barrier | Direct/proposal essential acknowledgements before POST; held archive independent; no prior replay/checkpoint wait | **Pass.** `direct create crosses its essential barrier while an earlier archive holds ownership` and `proposal confirmation crosses its essential barrier while an earlier archive holds ownership`. The pre-POST BSON image proves accepted input, generating attempt, acceptance marker, `logicalTools: 1`/`creates: 1`, a dispatching operation with exact authorization basis, and `planned`+`dispatching` event sequences. Proposal confirmation adds `basis: 'proposal-confirmation'` with zero extra model calls. | P1/P3. |
| AC4 Failure/recovery/idempotency | W1–W4, split acknowledgements, original identity/readback, duplicate/retry/cancel, no blind POST | **Pass on covered cases.** W1, W2 (healthy + disabled/expired/role variants), W3 before send, W3 after provider creation (ambiguous create), W4, planned/dispatching ack failures, succeeded-missing-event repair, post-success result-projection hold, duplicate/concurrent text/live confirmation, and cancellation at the dispatching CAS/after success pass. W1 consumed-proposal subcase, W2 changed-condition variants beyond role loss, several split-acknowledgement subcases, corrupt/foreign event, wrong account/session, unresolved-query overflow, and v1 quarantine are **not run in P4** (some are covered by P3's own suites). | P3. |
| AC5 Invalidation/isolation | Lifecycle/target/expiry/current and queued evidence; cross-user/account/session/text/live races; privacy canaries | **Pass on covered cases.** In-flight invalidation, disconnect, settings disable, implicit-default change, target role loss, credential expiry, account replacement, source expiry at exactly `expiresAt`, policy expiry safe denial, two-session content isolation, text↔live sharing with a held archive, and canary checks pass. Same-subject reconnect/consent, private-access loss as a separate case, discovery expiry as a separate case, and different-user isolation are **not run**. | P1/P2/P3 by boundary; former source-expiry defect resolved by the P4 fixture separation. |
| AC6 Measurements | Prepared/cold/read/availability/direct/confirmation, commands/waves/stages, matched/unmatched baselines, synthetic/live distinction | **Pass with stated limits.** Eleven `CALENDAR_TOOL_LATENCY` rows cover prepared/new, prepared/warm, cold-existing-session, list-events, get-event, availability, direct create, proposal confirmation (referenced/unreferenced), mixed read/create, and text/live contention. All use the synthetic wave model; real `performance.now()` is reported separately. No matched pre-change prepared measurement exists. | P4 evidence; P1–P3 behavior. |
| AC7 Regression evidence | Baseline/focused/full/e2e/build/lint, frontend condition, actual skips/failures/crashes; review skipped | **Pass (evidence complete; baseline failures remain open).** Build/lint pass; the integrated spec is 47/47; focused/full/e2e/Canvas results are recorded with failures and skips. Full-suite and e2e failures remain open baseline/environment failures, not P4 acceptance failures. Frontend is not applicable. Review is skipped. | All owners/orchestrator. |
| AC8 Final root policy | Root policy added only after evidence; exact instruction/test/source consistency | **Pass.** The additive "Tool execution critical path" section is in root `AGENTS.md` after "Reliable chat behavior". Each statement maps to a named passing check in this document; the section preserves the memory-first chat rule and does not claim zero network latency, exactly-once effects, or native/live/topology certification. | P4; consistency table below. |

## Critical-path measurements

Measured with the assembled `AppService`/`DurableChatRuntime` over the fake driver, `DependencyProbe('wave')`, `readMs: 67`, `writeMs: 449`, clock `2026-11-03T09:00:00.000Z`. `syntheticMs` is the deterministic wave model; `realMs` is a separate `performance.now()` observation of the measured turn. These are **not live latency** and must not be subtracted from the legacy research numbers.

| Scenario | Preparation | Prior turns | Waves | Synthetic ms | Real ms | Commands | Unresolved | Provider counts |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| list-events | prepared/new session | 0 | 46 | 7,666 | 37 | 46 | 0 | `GET:calendar-list=1`, `GET:events=1` |
| list-events | prepared/warm session | 8 | 46 | 7,666 | 40 | 46 | 0 | `GET:calendar-list=1`, `GET:events=1` |
| get-event | prepared/new session | 0 | 46 | 7,666 | 28 | 46 | 0 | `GET:calendar-list=1`, `GET:event=1` |
| availability | prepared/new session | 0 | 46 | 7,666 | 28 | 46 | 0 | `POST:freeBusy=1` |
| direct-create | prepared/new session | 0 | 168 | 25,008 | 81 | 168 | 0 | `POST:freeBusy=1`, `GET:calendar-list=1`, `POST:events=1` |
| direct-create | prepared/warm session | 8 | 168 | 25,008 | 72 | 168 | 0 | `POST:freeBusy=1`, `GET:calendar-list=1`, `POST:events=1` |
| proposal-confirmation (referenced) | prepared/new session | 0 | 179 | 25,745 | 27 | 179 | 0 | `POST:freeBusy=1`, `GET:calendar-list=1`, `POST:events=1` |
| proposal-confirmation (unreferenced) | prepared/new session | 0 | 177 | 25,229 | 40 | 177 | 0 | `POST:freeBusy=1`, `GET:calendar-list=1`, `POST:events=1` |
| list-events | cold existing session | 1 | 68 | 9,140 | 32 | 68 | 0 | `GET:calendar-list=1`, `GET:events=1` |
| mixed read/create | prepared/new session | 0 | 175 | 26,623 | 95 | 175 | 0 | `GET:calendar-list=2`, `GET:events=1`, `POST:freeBusy=1`, `POST:events=1` |
| text/live contention | prepared/new session | 0 | 50 | 8,316 | 26 | 50 | 0 | `GET:calendar-list=1`, `GET:events=1` |

The cold profile preserves the earlier saved user message in the first model request and performs a real provider read; it does not label an empty conversation as cold hydration. Stage rows in the emitted `CALENDAR_TOOL_LATENCY` payload include accepted input, initial model dispatch, tool-wire offered, executor entry/result, provider request/response, next model dispatch, delta/operation frame, terminal, save start/end, and durable publication where present. Absent stages are omitted rather than invented.

The final 47/47 rerun exercised the same profile cases, but this document does not claim new measurements; the rows above are the recorded P4 evidence numbers. **No matched pre-change prepared measurement** exists for these assembled workloads. The historical research numbers were produced by the legacy fixture/workload and are not a controlled before/after comparison. The wave model rounds independent mixed-duration operations to a wave boundary; it is not an event-loop, network, or real-Mongo simulator.

## Crash/recovery matrix

| Window / case | Test | Actual result |
| --- | --- | --- |
| W1 before the essential barrier | `crash window W1 before the essential barrier recovers without a POST or model replay` | Pass. Image has no operation row, accepted user message present, zero POST; recovery creates nothing, reads nothing, replays no model. |
| W2 planned → dispatching | `planned-operation crash recovery may dispatch one original create without model replay`; `crash window W2 blocked variants never dispatch the planned create` | Pass. Healthy recovery makes exactly one first POST with no model replay; disabled, expired, and reader-role variants make zero POST and do not succeed. |
| W3 before provider send | `crash window W3 before send reads back the pinned ID without a POST` | Pass. Recovery performs bounded readback of the original event ID, zero additional POST, operation `unknown`. |
| W3 after provider creation, response lost | `new assembled runtime reconciles an ambiguous create by pinned ID without another POST` | Pass. Same operation/intent/Google ID/request hash; one total POST; readbacks only to the original ID; zero model bodies. |
| W4 after provider success + succeeded operation/event | `crash window W4 after provider success and operation success recovers the receipt without a second POST` | Pass. Receipt survives; event sequence `[planned, dispatching, succeeded]`; recovery returns the same receipt with no second POST, zero readbacks, zero model bodies. |
| Planned event acknowledgement failure | `mutation barrier 'planned event acknowledgement' fails closed when committed: false/true` | Pass. Zero POST, safe terminal status, exact persisted `planned` state, `receipt: null`; committed variant has the planned event, uncommitted variant does not. |
| Dispatching CAS failure | `mutation barrier 'dispatching CAS' fails closed when committed: false` | Pass. Zero POST, persisted `planned`, `receipt: null`, no dispatching event. |
| Dispatching event acknowledgement failure | `missing dispatching-event acknowledgement keeps an essential create barrier closed`; `mutation barrier 'dispatching event acknowledgement' fails closed when committed: false/true` | Pass. Zero POST, operation not succeeded, no dispatching event when uncommitted; committed variant has the dispatching event but no POST. |
| Succeeded CAS/event acknowledgement failure | `succeeded operation with a missing event repairs the exact event without readback or POST` | Pass. Operation succeeded with receipt, succeeded event missing; recovery appends the exact event with no POST, no readback, zero model bodies. |
| Post-success result projection hold | `provider-confirmed create continues while its result projection is held` | Pass. Operation is succeeded before the result projection releases; an eligible follow-up runs first; one POST. |
| Cancellation at dispatching CAS / after success | `keeps one provider effect when a create is cancelled at the dispatching CAS or after success` (P3 `calendar-memory-first.spec.ts`) | Pass (finalization spot-check 1/1). At most one create; reconciliation preserves the pinned ID; a post-success cancel preserves the receipt and `[planned, dispatching, succeeded]`. |

Not run in P4: W1 consumed-proposal-without-operation subcase, W2 changed-condition variants beyond reader role, W3 absent/mismatch/timeout/denied readback variants beyond the pre-send 404 path, corrupt/foreign event, wrong account/session, unresolved-query overflow, v1 quarantine, and partial terminal publication CAS uncertainty as a separate crash image. Some of these are covered by P3's `calendar-multi-recovery.spec.ts`; P4 does not claim them as integrated evidence.

## Privacy/isolation/bounds

- Prepared read and follow-up traces contain no access/refresh-token canaries or event-content canaries; the synthetic provider and trace are payload-free.
- In-flight invalidation (`in-flight Calendar result cannot publish a view or continuation after account invalidation`) produces zero calendar-view frames, redacts source provenance, makes no POST, and an unrelated follow-up completes without the canary in any prompt.
- Disconnect and settings-disable invalidate prepared authority before the next read; the next read makes no provider request and publishes no stale view.
- Implicit-default change routes the next implicit create to the new calendar and the operation records that calendar.
- Target role loss (`accessRole: 'reader'`) denies the create before any provider write.
- Credential/discovery expiry (short token/discovery lifetimes advanced past expiry) fails closed with no provider request and no stale calendar view.
- Source expiry at exactly `expiresAt` is enforced (`now >= expiresAt`): the next read dispatches a fresh provider GET and does not reuse the expired content. Policy expiry at the default 1-hour deadline denies safely with no provider request and no stale content.
- Account replacement creates a new connection ID/subject, rejects the old account binding, and serves a read on the new account.
- Text-read → live follow-up and the subsequent text follow-up share one attempt while an earlier archive is held; the live delivery is generated/settled, the reservation is released before the text follow-up, and the archive drains after release.
- Same-user, two-session content isolation passes: a Calendar read in one session does not put the event canary into the other session's model request.
- Concurrent text/live confirmations consume one proposal and create once; the second confirmation does not produce a second POST.
- Competing text tabs yield one active attempt and one model effect; the second tab receives `CONFLICT_ACTIVE_TURN`.
- Finite request/refresh/create/model/tool/drain limits remain in force; the fixture does not override admission, capability, credential, budget, or ownership guards. The source-expiry and policy-expiry tests use separate deadlines; neither weakens authorization.
- Not run: different-user isolation, private-access loss as a separate case, same-subject reconnect/consent, discovery expiry as a separate case, and a second-model-decision canary-echo mutation check. Same-user/two-session isolation is covered.

## AGENTS policy consistency

Root `AGENTS.md` now contains the additive **"Tool execution critical path"** section immediately after "Reliable chat behavior". Each statement maps to a passing check:

| Policy statement | Runnable evidence |
| --- | --- |
| Prepared/warm reads use server-memory authority; cold start, explicit fresh checks, and invalidation are the only rehydration exceptions; invalidation must not restore revoked authority. | `reuses warmed status and account without opening connection storage`; `rehydrates status after invalidation without restoring revoked authority` (finalization spot-check 1/1); `warms prepared account authority via AppService.prepareOwner without later storage get calls`; `repeated prepared owner request preparation does not touch application storage`; `profiles cold existing session with saved history`. |
| Prepared read/local paths perform no avoidable pre-tool persistence; essential admission, authority, expiry, capability, cancellation, deadline, and budget checks remain and must fail closed. | Four `prepared ... dispatches and continues with application storage blocked` cases; `assembled fixture observes denied fresh admission instead of bypassing it`; `target role loss denies a create before any provider write`; `expired credentials fail closed without a stale calendar view`. |
| External mutations persist minimal acknowledged durable pre-effect evidence before the provider call; fail closed on uncertain durability; after an ambiguous send, read back the pinned event ID and never blindly replay the create. | `direct create crosses its essential barrier while an earlier archive holds ownership`; `proposal confirmation crosses its essential barrier while an earlier archive holds ownership`; five `mutation barrier ... fails closed when committed` cases; `missing dispatching-event acknowledgement keeps an essential create barrier closed`; `crash window W3 before send reads back the pinned ID without a POST`; `new assembled runtime reconciles an ambiguous create by pinned ID without another POST`; `crash window W4 ... recovers the receipt without a second POST`. |
| Persistence after a turn is tracked, bounded, ordered, and consolidated asynchronously; keep provider-confirmed results distinct from archive-durable state. | `read continuation and follow-up finish while an actual archive owns persistence`; `provider-confirmed create continues while its result projection is held`; `text read and live follow-up share one attempt while an archive is held`. |
| Required checks cover production-route blocked-storage reads, held-archive continuation, barrier-vs-unrelated-save ordering, crash/duplicate/cancel recovery, exact expiry/invalidation isolation, and command/wave measurement with synthetic-vs-live distinction. | The integrated spec's AC1–AC6 cases; the cancellation spot-check above; the `profiles ...` cases and the measurement section's separate `syntheticMs`/`realMs` columns. |
| The policy does not promise zero network latency, exactly-once billing/effects, or native/live/topology certification. | This document's status, environment, measurement, and limitations sections; the policy's closing synthetic-fixture sentence. |

The existing memory-first chat rule, mutation-barrier rule, idempotency rule, and review-skipped workflow instruction are unchanged. The new section is additive.

## Limitations and unresolved work

- **Not native, not live.** The fake BSON driver is not MongoDB; the synthetic providers are not Google/OpenRouter/LiveKit; the wave model is not a latency simulator. No native replica-set, Azure/Cosmos, staging, topology, OAuth refresh, live timing, audio, or transport certification follows.
- **Former P4 acceptance failures resolved.** P1 warm second `prepareOwner` no longer reads connection storage; P2 source expiry at exactly `expiresAt` now dispatches a fresh provider read while policy expiry denies safely. The fixes/tests are committed in `fcb09ae`, `327d55d` and `b7d0032`. The orchestrator reran the full suite and e2e post-fix; both remain non-green for baseline/environment failures.
- **Full suite and e2e are not green.** The post-fix orchestrator full `npm test` rerun is 3,489 passed / 39 failed / 10 skipped with one worker error; the post-fix e2e rerun is 35 passed / 8 failed / 140 skipped (all eight in `voice-bootstrap.e2e-spec.ts`). The focused baseline's eight failures remain. `durable-latency` (19/42 in isolation; 21 under concurrent load), `local-guard`, `local-open`, `calendar-assets`, `calendar-simplification.built`, `finalization-repair`, and `local-owner` fail in isolation too; they are baseline/environment failures in files P4 did not modify. An earlier full-suite Canvas failure did not reproduce in the final run or isolation and is classified as order/concurrent-dirty uncertain.
- **Coverage gaps.** W1 consumed-proposal, several W2/W3/split-acknowledgement variants, same-subject reconnect/consent, private-access loss, discovery-expiry separation, different-user isolation, conflicting-intent-blocked-while-unrelated-read-proceeds, and a second-model-decision canary-echo check are not run in P4. Same-user/two-session isolation is covered. P3's own suites cover some of the remaining cases; they are not claimed as P4 integrated evidence.
- **Measurement gaps.** No matched pre-change prepared/cold measurement exists. Stale discovery/credential refresh and recovery profiles are not separately measured. get-event/availability/proposal profiles use 0 prior turns only; list-events and direct create use 0 and 8. The cold profile uses one prior text turn. Real `performance.now()` is reported separately from synthetic waves. The final 47/47 rerun did not produce new measurement rows.
- **Frontend not run.** P4 changed no frontend source; frontend build/lint/test remain not applicable to this slice.
- **Review skipped.** Unified review was not dispatched and is not passed. Skipped review does not waive the baseline failures, the coverage gaps, or the missing native/live evidence.
