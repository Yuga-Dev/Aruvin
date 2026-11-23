# Final Report: calendar-tool-latency

## Executive summary

The workflow made existing Google Calendar read/availability tools execute through the prepared, memory-first path without application-storage waits, while keeping Calendar creates behind a minimal acknowledged durable barrier and preserving recovery, invalidation and duplicate protection.

- **Reads:** prepared account authority is resolved from server memory; the four prepared read/availability production routes dispatch, continue the model and complete an eligible follow-up with `RecordStore.collection` blocked and zero storage calls. The P1 follow-up fix removed the last warm-path storage read in `statusV2()`.
- **Creates:** direct and proposal-confirmed creates cross only their essential barrier (accepted input, attempt, acceptance marker, create budget, `planned`/`dispatching` operation and event) before the provider POST, while an unrelated archive holds persistence. Crash windows W1–W4, ambiguous readback, duplicate/concurrent requests and cancellation never silently issue a second create.
- **Persistence:** nonessential transcript/tool/accounting persistence remains tracked, bounded, ordered and asynchronous. Provider-confirmed results are distinct from archive-durable state.
- **Expiry/invalidation:** source expiry is enforced at `now >= expiresAt`; policy expiry denies safely; disconnect/reconnect, settings, target-role, credential, account-replacement and in-flight invalidation do not reuse revoked authority or publish stale content.
- **Policy:** root `AGENTS.md` now carries the verified "Tool execution critical path" section, mapped to named passing checks.

The integrated P4 spec passes **47/47**. Backend build and lint pass. The full routine suite and e2e still contain pre-existing baseline/environment failures, recorded below; they are not P4 acceptance failures but they are not green. Review was **skipped by user instruction**, never passed. No native, live, staging or topology certification is claimed.

## Workflow configuration

- Workflow: MAW, `--skip review`.
- Goal approved 13 November 2026; written specification approved and committed `ba614a2`.
- Research committed `b66fe00`; plans committed `4d62254`, `86253c3`, `10f2f07`, `c592e55`.
- No separate worktree. Implementation ran in the shared checkout with explicit named-path staging.
- No live services, paid calls, application-database access, provisioning, restart or deployment were authorized or performed.

## Plan breakdown and execution record

| Plan | Title | Commits | Status |
| --- | --- | --- | --- |
| P1 | Prepared provider authority, credentials, invalidation and fast read admission | Plan `4d62254`; implementation `67bb366`; warm-status fix `fcb09ae` | Complete |
| P2 | Memory-first reads, complete Calendar evidence and consolidated async archive | Plan `86253c3`; implementation `3742a38`; exact-boundary tests `327d55d` | Complete |
| P3 | Essential create barrier, dirty-prefix isolation and crash recovery | Plan `10f2f07`; implementation/recovery `07f723a`; crash tests/profiling `3cdb07d` | Complete |
| P4 | Integrated critical-path/recovery verification and final AGENTS.md policy | Plan `c592e55`; integrated tests `4c53b47`; partial evidence `e8e79fa`; final evidence/policy `b7d0032` | Complete |

### Defects found and corrected

1. **P1 warm preparation storage read** (`fcb09ae`): `GoogleCalendarConnections.statusV2()` requested `{ fresh: true }`, so every warm `AppService.prepareOwner` re-read connection storage. It now uses prepared mode (`{ fresh: false }`). Cold start, explicit fresh checks and invalidation still rehydrate; invalidation does not restore revoked authority. One production line changed; regression tests added.
2. **P4 expiry fixture collision** (`b7d0032`): the integrated source-expiry test advanced to a source `expiresAt` that had been clamped to the one-hour policy deadline, so it measured correct policy denial rather than source reuse. The fixture now supports an optional `policyLifetimeMs`; the source-expiry case uses a 48-hour policy with a 24-hour source lifetime and asserts a fresh provider GET, while a separate policy-expired case asserts safe denial with no provider request and no stale content. No production deadline comparator changed.
3. **P2 exact-boundary regression coverage** (`327d55d`): source expiry was already correct; tests now pin usable-just-before, tombstone/fresh-read-at, and safe-after behavior.

## Verification and quality assurance

All backend commands ran with `AURVIN_TEST_MONGODB_URI`, `MONGODB_URI`, `OPENROUTER_API_KEY`, `GOOGLE_CLIENT_SECRET` and `LIVEKIT_API_SECRET` cleared. No URIs or credentials are recorded.

| Check | Actual result |
| --- | --- |
| P4 integrated spec `test/performance/calendar-tool-latency.spec.ts` | **47/47 passed**, exit 0 (orchestrator rerun) |
| P1 focused selection (10 files) | **114/114 passed**, exit 0 (orchestrator rerun) |
| P1 broader plugin/assembly (29 files) | 326/326 passed (worker-reported) |
| P2 focused source/archive selection (7 files) | **179/179 passed**, exit 0 (orchestrator rerun) |
| P2 broader selection (19 files) | 14 files passed; four known baseline-failure files, 8 failed tests + 1 worker error (worker-reported) |
| P3 Task 6 focused recovery set | 123/123 passed (worker-reported); three changed test files 91/91 (orchestrator rerun at P3) |
| Full `npm test` (post-fix) | 374 files: 360 passed, 11 failed, 2 skipped; 3,540 tests: **3,489 passed, 39 failed, 10 skipped**; 1 worker error; exit 1 |
| `npm run test:e2e` (post-fix) | 48 files: 3 passed, 1 failed, 44 skipped; 183 tests: 35 passed, 8 failed, 140 skipped; exit 1 |
| `npm run build` | exit 0 |
| `npm run lint` | exit 0; warnings only, no errors |
| Canvas regression (P4) | 4 files, 77/77 passed |
| `git diff --check` | clean (CRLF/LF conversion warnings only) |

### Open baseline/environment failures

The full suite's 39 failures are in files this workflow did not change: `durable-latency.spec.ts` (21 under concurrent load; 19 in isolation), `calendar-confirmation.spec.ts` (4), `calendar-voice-latency.spec.ts` (2), `calendar-memory-voice.spec.ts` (1), `calendar-voice-authority.spec.ts` (1), `local-guard.spec.ts` (3), `local-open.spec.ts` (3), `calendar-assets.spec.ts` (1, stale instruction assertion), `calendar-simplification.built.spec.ts` (1, missing `dist` module), `finalization-repair.spec.ts` (1), and `local-owner.spec.ts` (1, the known `listForRecovery` `$or` expectation). The e2e failures are eight `voice-bootstrap.e2e-spec.ts` cases. These are recorded as baseline/environment failures, not as passes and not as P4 acceptance failures.

### Measurements

Deterministic assembled-path profiles use `DependencyProbe('wave')` with `readMs: 67`, `writeMs: 449`, and report synthetic waves separately from `performance.now()` observations. Representative rows:

| Scenario | Preparation | Prior turns | Waves | Synthetic ms | Real ms |
| --- | --- | ---: | ---: | ---: | ---: |
| list-events | prepared/new | 0 | 46 | 7,666 | 37 |
| list-events | prepared/warm | 8 | 46 | 7,666 | 40 |
| direct create | prepared/new | 0 | 168 | 25,008 | 81 |
| proposal confirmation (referenced) | prepared/new | 0 | 179 | 25,745 | 27 |
| cold existing session | cold | 1 | 68 | 9,140 | 32 |
| mixed read/create | prepared/new | 0 | 175 | 26,623 | 95 |
| text/live contention | prepared/new | 0 | 50 | 8,316 | 26 |

These are synthetic fixture measurements, not live latency, and there is no matched pre-change prepared baseline. They must not be subtracted from the historical research numbers.

## Acceptance criteria

| Criterion | Outcome | Evidence |
| --- | --- | --- |
| AC1 Prepared read dispatch | Pass | Four prepared routes dispatch and continue with application storage blocked; warm `prepareOwner` makes no storage call |
| AC2 Immediate continuation/follow-up | Pass | Read continuation and follow-up complete while a real archive holds persistence; durable versions settle to `[1,2,3]` |
| AC3 Minimal mutation barrier | Pass | Direct/proposal creates cross the essential barrier while an earlier archive holds ownership; pre-POST BSON image recorded |
| AC4 Failure/recovery/idempotency | Pass on covered cases | W1–W4, ambiguous pinned-ID readback, duplicate/concurrent and cancellation cases; listed variants not run in P4 |
| AC5 Invalidation/isolation | Pass on covered cases | Disconnect, settings, target role, credential, account replacement, exact source expiry, policy denial, in-flight invalidation, two-session and text/live races |
| AC6 Measurements | Pass with limits | Eleven profile rows; synthetic and real timing separated; no matched pre-change baseline |
| AC7 Regression evidence | Pass with open baseline failures | Build/lint pass; integrated 47/47; full/e2e failures recorded and classified; review skipped |
| AC8 Future tool instructions | Pass | Root `AGENTS.md` "Tool execution critical path" maps to named passing checks; no zero-latency/exactly-once/native certification claim |

## Key artifacts

- Goal: [`goal.md`](goal.md)
- State and dependency matrix: [`state.md`](state.md)
- Research: [`research.md`](research.md)
- Plans: [`plan1.md`](plan1.md), [`plan2.md`](plan2.md), [`plan3.md`](plan3.md), [`plan4.md`](plan4.md)
- Verification evidence: [`verification.md`](verification.md)
- Root policy: [`AGENTS.md`](../../AGENTS.md)
- Integrated test: `backend/test/performance/calendar-tool-latency.spec.ts`

## Limitations and unresolved work

- **Not native, not live.** The fake BSON driver is not MongoDB; synthetic providers are not Google/OpenRouter/LiveKit. No native replica-set, Azure/Cosmos, OAuth-refresh, staging, topology, audio/transport or live-timing certification follows.
- **No matched pre-change measurement.** Prepared/cold before-after comparison is not established; the wave model is a deterministic dependency model, not a latency simulator.
- **Coverage gaps.** W1 consumed-proposal subcase, some W2/W3 and split-acknowledgement variants, same-subject reconnect/consent, private-access loss, discovery-expiry separation, different-user isolation, conflicting-intent-blocked-while-unrelated-read-proceeds, and a second-model-decision canary-echo check were not run in P4. Some are covered by P3's own suites and are not claimed as integrated evidence.
- **Full suite and e2e are not green.** Baseline/environment failures remain open as listed above. They were not fixed under this objective.
- **Frontend checks not run.** This objective changed no frontend source. Concurrent frontend changes present in checkpoint `07f723a` belong to other work and were not verified here.
- **Review skipped.** Unified code review was not dispatched and is not passed. Skipped review does not waive the baseline failures, coverage gaps or missing native/live evidence.
