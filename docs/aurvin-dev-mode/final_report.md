# Final Report: aurvin-dev-mode

## Executive summary

Aurvin now has the SayCart User / Dev workflow with Aurvin's own controls: a super-admin-only **Enable dev mode** checkbox and a separate **User / Dev** selector, both living only on **Manage Aurvin → Config**. The feature is off by default, so existing installs and ordinary users keep today's prompts and today's call counts. When enabled, the first eligible text or live-voice turn after enablement or a mode change carries one model-only `[Current mode: User]` or `[Current mode: Dev]` prefix, and every eligible turn carries short mode guidance. Dev turns are read-only: no tools, no Calendar/web/canvas effects, no secrets or raw system instructions. Injected text never reaches stored messages, checkpoints, titles, compaction, exports, or the UI.

Mode handling adds **no extra model call, no database operation, no network round trip, no async wait, and no pre-dispatch ordering change**. It is one synchronous in-memory lookup plus fixed string concatenation at the dispatch cut.

## Workflow configuration

- Workflow: MAW, `docs/aurvin-dev-mode/`.
- Skipped phases: **research** and **unified code review**, per the user's instruction. Review is recorded as skipped, never as passed. One blocking defect found outside review (contract-mirror parity) was routed to its owning worker and fixed.
- Mandatory phases performed: brainstorming/approval, planning, three worker executions, final verification.
- Authorized exception: planners were dispatched with the event-driven subagent tool after the user approved it, because foreground planners are unavailable in this session. Dependencies and gates were unchanged. The user also directed planners to run on `openai/gpt-6.2-sol#xhigh`.
- No SayCart files were changed. SayCart is read-only reference.
- Not run and not authorized: deployment, live provider calls, paid checks, native MongoDB integration, staging, and real microphone/voice measurements.

## Plan breakdown & execution record

| Plan | Title | Plan commit | Worker commits | Status |
| --- | --- | --- | --- | --- |
| P1 | Backend Config and session authority | `b7880f7` | `0c1e43e`, `e15b6b9`, `0f5d178`, `68cff91` | Complete |
| P2 | Config-only controls | `bec5aeb` | `e09eceb`, `28d8463`, `c9e12b9`, `86af5a0`, `89a80ab` | Complete |
| P3 | Text and live-voice model integration | `4c394d1` | `27da971`, `7e98382`, `9b30909`, `f0a86a4` | Complete |
| Fix | Contract-mirror parity defect | — | `4e6182e` | Complete |

Workflow documents: goal `2da108c`, approval/latency constraint `96a4c02`, baseline record `370e649`, state updates `59dce2c`, `ab82544`, `542e541`, `f6f19e5`, `de5005c`, `c9ad83d`, `c5bfcaa`.

## What was built

**Config and authority (P1).** `settings.devModeEnabled` is persisted and optional; a missing value reads and stays `false` for existing stored documents. `GET`/`PUT /api/admin/config/dev-mode` are the only mode endpoints and require an authenticated, full-access `super-admin` with a current session and account authority. `GET` reflects the confirmed active settings pointer, not drafts. `PUT` accepts exactly `{ protocolVersion: 1, mode }`, returns 409 `DEV_MODE_DISABLED` while the feature is off, and same-mode reselect does not re-arm the announcement. One `AccountAuthority` drives a single in-process `DevModeAuthority` exposing synchronous `peek(principal)` and atomic `consumeForDispatch(principal)`. Selection resets to User on disable, restart, and every session fence (login replacement, logout, password change/reset, deactivation); in-flight decisions stay frozen.

**Config UI (P2).** The checkbox saves through the existing revisioned settings save and stays safe across unsaved, failed, and conflicting saves. The User / Dev selector appears only after the mode `GET` confirms active enablement, and errors (`403`, `409`, `503`) fail closed with accessible messages. No chat or voice controls were added.

**Model behavior (P3).** The existing trusted `AuthPrincipal` travels from HTTP/voice admission into the real turn. At the dispatch cut — after projection and the existing late checks, immediately before the provider POST — the turn consumes the decision and freezes it for retries, web continuations, and Calendar continuations. Off/ineligible builds no handle and no projection; raw request bodies and call counts match today. User mode keeps the assembled messages and tools with bounded guidance. Dev mode replaces tool-bearing groups with public-safe guidance, rejects provider tool deltas before assembly, denies Calendar/web/canvas and voice tool paths, and drops visual artifacts.

## Verification & quality assurance

| Check | Command | Result |
| --- | --- | --- |
| Backend tests (pre-change baseline) | `backend/`: `npm test` | 18 failed files / 74 failed / 4070 passed / 14 skipped, 1 worker-fork error |
| Backend tests (final) | `backend/`: `npm test` | **17 failed files / 66 failed / 4104 passed / 14 skipped**, 1 worker-fork error |
| Backend lint | `backend/`: `npm run lint` | exit 0, pre-existing warnings only |
| Backend build | `backend/`: `npm run build` | exit 0 |
| Backend e2e | `backend/`: `npm run test:e2e` | 1 failed file / 4 passed / 44 skipped; 8 failed / 38 passed / 141 skipped |
| Frontend tests | `frontend/`: `npm test` | **110 files / 938 tests passed**, exit 0 |
| Frontend lint | `frontend/`: `npm run lint` | exit 0, pre-existing warnings only |
| Frontend build | `frontend/`: `npm run build` | exit 0 |
| Config browser fixture | headless Chrome, P2 | dev-mode checkbox, selector, save, and error checks all PASS |

**No new failures.** The final backend failing-file set is a strict subset of the recorded baseline: no failing file is new and no dev-mode test fails. The one baseline-only file, `test/operations/bootstrap.spec.ts`, did not reproduce (known shared-`dist` rebuild race, not claimed as fixed). Remaining failures are the documented pre-existing assembled admin/Calendar HTTP, durable-latency performance gates, local persistence owner/open, Calendar confirmation/voice, finalization repair, and multi-calendar integration sets.

**E2E is honestly compared, not waived.** All 8 e2e failures are the same eight `test/assembly/voice-bootstrap.e2e-spec.ts` cases recorded across earlier workflows. They were re-checked on this workflow's own pre-change commit `b3cf86e` in an isolated worktree: **8 failed / 22 passed**, with the same eight test names. Native suites skipped (141) because `AURVIN_TEST_MONGODB_URI` is not authorized here.

**No-added-overhead evidence.** Focused deterministic tests assert unchanged off/ineligible request bodies and dispatch counts, one shared announcement across text and live voice, frozen reuse across retries and continuations, and no tool execution in Dev. Reasoning is synchronous in-memory only; the authority has no timers, I/O, logging, or async work.

## Acceptance coverage

| Criterion | Result | Evidence |
| --- | --- | --- |
| AC1 — super-admin-only Config controls; backend denies unauthorized read/write and mode injection | Met | Auth-gated routes and account re-checks; role-aware dashboard and admin API tests |
| AC2 — default off, confirmed save toggles, users unaffected | Met | Stored-document compatibility tests; active-pointer activation tests; prompt-parity tests |
| AC3 — exactly one announcement per enable/switch, latest wins | Met | Authority tests plus dispatch fixtures for text and voice |
| AC4 — text/live parity, one shared announcement, session isolation | Met | `dev-mode-dispatch` and `web-search-voice` fixtures |
| AC5 — correct trusted mode, no persisted injection, Dev read-only | Met | Raw request captures, persistence/compaction/title/UI assertions, tool-denial tests |

## Limitations and recorded deviations

- **Marker echo is not filtered.** If a model deliberately repeats the injected marker or guidance in its own reply, it could appear in that reply. Injected text is never stored; no content, identity, or secret leaks through it.
- **Planned P3 extras were not added:** compaction-specific assertions, `postCounts` operation-count additions, voice sign-in-fence, cancel-before-final-dispatch, winner-ordering, and reasoning-canary tests. The no-added-work claim rests on the existing compaction and Calendar-latency regressions plus focused dispatch-count assertions, not new wave measurements.
- **No live latency measurement.** Turn-path cost is argued from deterministic call/body-count assertions and code shape, not a wall-clock benchmark, and no live provider, microphone, or staging run was authorized.
- **Single-process authority.** Mode state is in-process, matching the admitted single-process executor topology. It is not multi-instance shared state.
- **In-flight turns keep their admitted mode**, and disabling stops diagnostics for newly admitted turns, including on an already-open voice connection.
- **Historical failures remain.** This workflow does not certify native MongoDB, Azure, staging, or production readiness.

## Key artifacts

- Goal: `docs/aurvin-dev-mode/goal.md`
- State and dependency graph: `docs/aurvin-dev-mode/state.md`
- Plans: `docs/aurvin-dev-mode/plan1.md`, `plan2.md`, `plan3.md`
- Research / review: skipped, no files created
