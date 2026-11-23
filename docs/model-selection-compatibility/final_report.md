# Final Report: model-selection-compatibility

## Executive summary

Implemented the approved super-admin model selection and thinking-effort feature:

- Searchable live OpenRouter chat-model catalogue in Manage Aurvin → Config →
  OpenRouter, with no model-name allowlist.
- Model-specific thinking-effort selector with `provider-default` and declared
  efforts only.
- Catalogue-only **Check compatibility** with precise blockers and separate
  optional Calendar/web-tool warnings.
- Shared server revalidation before save/CAS/activation, exact-draft result
  fencing, and stale-response isolation.
- Model and effort bound consistently across text, voice, retries and tool
  rounds, with absent-only backward-compatible defaults.
- No private reasoning stored or replayed; privacy, budgets and attempt binding
  preserved.

The implementation was temporarily reverted at the user's request, then restored
in `6d59fa0`. Final verification found one fixture regression
(`skill-evidence.spec.ts` still using the old serializer signature); it was fixed
in `c3ba1ff`. Full-suite failures now match the pre-implementation baseline.

Unified review is **skipped** per repository policy.

## Workflow configuration

- Skipped phases: `review`.
- Planning, execution, defect correction and final verification were performed.
- No paid inference, live provider/service checks, application-data access,
  restarts, provisioning or deployment were performed.
- Native MongoDB e2e and browser/live checks remain unrun or unusable as noted.

## Plan breakdown and execution record

| Task | Scope | Commits |
| --- | --- | --- |
| 1 | Strict normalized setting and stored-only default | `a8a49d1` |
| 2 | Pure catalogue compatibility evaluator | `bbf8ffb` |
| 3 | Bounded acquisition and shared activation gate | `4b01de9` |
| 4 | Shared effort/cap serialization on every request path | `f4629a7` |
| 5 | Protected listing/check and independently revalidated saves | `823b9f3`, `53a5cab` |
| 6 | Bounded browser client for list/check | `ba95952` |
| 7 | Exact draft/result isolation and save gating | `11ec728` |
| 8 | Searchable model selector, effort, check/result UI | `f222133` |
| 9 | Cross-path binding and production-seam regressions | `21de817`, `0f490e8` |
| 10 | Documentation and integrated verification | `4b46713`, `c3ba1ff` |

Supporting workflow commits: approved goal/state `aeea3f4`, research `5972929`,
plan `e587a4f`, planning handoff `08d6687`, implementation authorization
`02ccd68`, temporary revert `adf0f95`, revert record `82e3661`, restoration
`6d59fa0`, restoration record `ce36487`.

## Verification and quality assurance

Environment: Windows, Node v24.18.0, npm 12.0.1. Deterministic fixtures only.

### Passed

| Check | Result |
| --- | --- |
| Backend `npm run build` | Pass |
| Backend `npm run lint` | Pass, warnings only (0 errors) |
| Frontend `npm run build` | Pass |
| Frontend `npm run lint` | Pass, warnings only (0 errors) |
| Frontend `npm test` | 109 files, 884 tests passed |
| Focused backend suites (contracts, config, model, admin, runtime text, calendar capability) | 39 files, 722 tests passed |
| `test/performance/skill-evidence.spec.ts` after fix | 1 file, 2 tests passed |
| Calendar critical-path specs (`calendar-tool-latency`, `calendar-memory-first`, `connection-prepared`) | 3 files, 127 tests passed |

### Baseline-compared failures

| Check | Current | Pre-implementation baseline (`fb8a44f`) |
| --- | --- | --- |
| Backend `npm test` | 17 failed files, 66 failed tests, 3941 passed, 14 skipped, 1 unhandled worker-fork error | Same 17 failing files and 66 failing tests in the compared subset; failures pre-date this change |
| Backend `npm run test:e2e` | 1 failed file (`voice-bootstrap.e2e-spec.ts`, 8 tests), 35 passed, 44 files / 140 tests skipped (no `AURVIN_TEST_MONGODB_URI`) | Identical 8 failures at baseline |

The failing suites include pre-existing NestJS HTTP assembly/multi-calendar
fixture issues, persistence setup without a native database, frozen performance
targets, and voice-bootstrap expectations. They are not caused by this feature.
The unhandled Vitest worker-fork error also occurred in both runs.

### Browser fixture

The closed fixture at
`frontend/src/features/admin-config/testing/dashboard-browser.html` reports
**2/10 passed** with `unexpected: GET /api/auth/me` and renders the sign-in page.
The same result was reproduced at baseline `fb8a44f`, so the fixture is stale
(pre-dates the authentication flow), not broken by this change. It is therefore
not usable as interaction evidence for this feature.

### Not run

- Native MongoDB e2e suites: operator-supplied isolated URI/prefix absent.
- Live OpenRouter inference, privacy-route certification, SSE streaming and
  tool-reasoning continuity: not authorized and not performed.
- Real browser interaction against a working fixture: fixture unusable as above.
- Azure/topology/staging/production certification: out of scope.

## Key artifacts

- Goal: `docs/model-selection-compatibility/goal.md`
- State: `docs/model-selection-compatibility/state.md`
- Research: `docs/model-selection-compatibility/research.md`
- Plan: `docs/model-selection-compatibility/plan1.md`
- Review: skipped
- Documentation: `README.md` ("OpenRouter model selection and thinking effort")

## Limitations

Catalogue-only checks verify declared public metadata and Aurvin's fixed context
floor. They do not prove account-specific privacy-compatible routing, paid
inference, SSE behavior, tool execution, or reasoning continuity across tool
rounds. No production-readiness claim is made.
