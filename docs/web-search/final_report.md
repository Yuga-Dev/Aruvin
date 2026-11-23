# Final Report: web-search

## Outcome and remaining acceptance gates

Web Search is implemented and deterministically verified across the assembled backend, shared text/voice runtime, MCP SDK provider wires, stock asynchronous archive, and frontend client/reducer/render boundaries. In fixtures it advertises exactly one `web_tool` only when enabled and eligible, executes browse/fetch through the fixed five-provider order, falls back within one logical call, repairs invalid arguments with at most three additional model attempts, never replays a successful call, preserves source/activity linkage, fences late results on disable/cancel/interruption, and keeps ordinary chat independent of web preparation and saves.

It is **not** accepted as production-ready. Remaining gates:

- **D1 resolved:** P4 defect D1 is fixed at `26c6461`; TinyFish now links `https://agent.tinyfish.ai/api-keys` and Keenable `https://app.keenable.ai/`, matching the approved goal. AC1 is no longer blocked by D1. The focused AC1 flow/panel tests pass 9/9 and the full frontend suite passes 867/867.
- **Compatibility:** 0/5 providers live-tested; browser OAuth fixture-only for all five; TinyFish API-key-over-MCP unsupported; page fetch admitted for all five providers under Aurvin's client-side URL guard and untrusted-evidence prompt guardrail, while provider-side redirect/private-network protections remain unverified.
- **Environment:** no native MongoDB/replica-set/Azure, staging, live audio, provider billing, cache-hit, or wall-clock SLA certification.
- **Pre-existing failures:** `calendar-memory-voice`, `memory-first-voice` worker exit, `calendar-confirmation`, and `calendar-voice-authority` are not claimed as passing; the full backend/e2e suites contain additional pre-existing Calendar/local-guard failures.

Unified review is **skipped by user instruction**, never passed.

## Workflow configuration

MAW with `--skip review`; unified review skipped by user instruction, never passed. Planner `openai/gpt-6.1-sol#xhigh`; worker `mistral/deepseek-v4-1-flash-1017#max`. P5 ran as the Senior Verification Engineer worker and did not modify production source.

## Plan and execution record

| Owner | Plan commit | Implementation/fix commits actually included | Status |
| --- | --- | --- | --- |
| P1 | `2335027` | `06ccaca`, `0fbaca8`, `8869d4a`, `d1baaba`, `dd6e749`, `5077ef5`, `baf2039`, `6371607` | Complete |
| P2 | `37b159f` | `6f0eeff`, `7a041a0`, `fd0dce9`, `886d779`, `6fdf2b4`, `99ad397`, `ef06dd2`, `eb579cd`, `49d87fd`, `8d3312c`, `71eef33`, `6786606`, `6b4ed9d` | Complete; fetch gated; live OAuth unverified |
| P2A | `b0a37c4` | `48fdb30`, `6ff09c2`, `17e24ad`, `7228a0d`, `4ede9e4`, `0c13f69`, `1a9ee7d`, `69bb789`, `faa736b`, `26b2caa` | Complete |
| P3 | `43a8263` | `333c7d3`, `6af79bd`, `c43ef41`, `33bdae8`, `4cb4c71`, `8a1a0e7`, `9849691`, `e7869ed`, `f093832`, `120744a`, `091fdcd`, `779f60d`, `83bebfd`, `4dff1ee` | Complete (focused); integrated evidence in P5 |
| P4 | `32b043e` | `427b125`, `b62bb28`, `0fa5246`, `060552b`, `5a0bb0d`, `d7e2b16`, `4df8178`, `e93d77c`, `26c6461` | Complete; D1 resolved at `26c6461` |
| P5 | `22f2b69` | `370ebbd`, `93e8f52`, `901ae21`, `1df5b08`, `ccaa87d`, `04c06e6`, `487d45e`, `3248257`, `e11948e`, `26c6461`, and the commit containing this report | Evidence complete; D1 resolved; compatibility gates remain |

## Tested revisions and environment

- Tested application tree: `b249625` (`docs(web-search): record P5 worker dispatch`), with P5 new files.
- D1 rerun tree: `26c6461` (`fix(web-search): use approved provider console destinations`) plus the P5 docs follow-up; the fix changes only the frontend catalog and focused tests.
- OS/shell: Windows / PowerShell 7 (`pwsh`); Node v24.19.0; npm 11.17.0; backend and frontend Vitest 4.1.11.
- Native prerequisites: absent (`AURVIN_TEST_MONGODB_URI` not present; prefix not `aurvin_p2_test_`).
- Browser: no approved browser surface used; BR1 prerequisite-blocked.
- No live provider/OAuth/WorkOS/OpenRouter/Google/Deepgram/LiveKit/paid/staging/deployment request was made. Untracked `.commandcode/` was preserved.

## Verification

| Command/run IDs | Executed outcome and counts | Skips/errors/limitations |
| --- | --- | --- |
| R1 backend build | pass (exit 0) | none |
| R2 backend lint | pass (exit 0) | none |
| R3 backend `npm test` | 404 files: 381 pass / 19 fail / 3 skip; 3,942 tests: 3,854 pass / 73 fail / 14 skip; 1 unhandled worker error | Failed files are pre-existing Calendar/local-guard/performance/integration suites; no P5 spec failed. Not all green. |
| R4 backend e2e | 48 files: 3 pass / 1 fail / 44 skip; 183 tests: 14 pass / 29 fail / 140 skip | Pre-existing `voice-bootstrap.e2e-spec.ts` failure; native skips separate. |
| R5 frontend build | pass (exit 0; post-D1 rerun also pass) | chunk-size warning |
| R6 frontend lint | pass (exit 0; post-D1 rerun also pass) | existing warnings only |
| R7 frontend test (pre-fix) | 107 files pass / 1 fail; 866 tests pass / 1 fail | Failure was P4 D1 in the new P5 flow test |
| R7b frontend test (after `26c6461`) | 108 files / 867 tests pass | D1 resolved; no frontend failures |
| B1 assembled acceptance | 1 file / 14 tests pass | Fixture-only; no live service |
| B2 P2 provider/storage/crypto | 11 files / 194 tests pass | Live MCP/OAuth unrun |
| B3 contracts/runtime/archive | 7 files / 55 tests pass | `web-search-coexistence.spec.ts` absent; Calendar-capable file substituted |
| B4 voice | 2 files pass, 1 failed, 1 unreported worker exit; 13 tests pass / 1 fail | Pre-existing `calendar-memory-voice` and `memory-first-voice` worker exit |
| B5 observations/composition/archive | 5 files / 57 tests pass | Synthetic waves prerequisite-blocked |
| B6 auth/administration/boundaries | 32 files / 358 tests pass | none |
| C1–C4 Calendar regressions | 47 + 82 + 33 + 275 tests pass | Baseline and post-change runs agree |
| F1 frontend flow (pre-fix) | 5 pass / 1 fail | P4 D1 |
| F1b frontend focused (after `26c6461`) | 2 files / 9 tests pass | AC1 flow + panel |
| F2 frontend focused | see [verification.md](verification.md) | R7/R7b cover the full set |
| N1 native | prerequisite-blocked | operator settings absent |
| BR1 browser | prerequisite-blocked | no approved browser surface |

## AC1–AC11 evidence

| AC | Disposition | Evidence |
| --- | --- | --- |
| AC1 | **pass (fixtures)** | Five ordered cards, masking, safe links, default-off toggle pass; exact goal destinations now match for all five providers. D1 resolved at `26c6461`; focused 9/9 and full frontend 867/867 pass. Browser OAuth remains fixture-only and 0/5 live. |
| AC2 | pass (fixtures) | Connect does not enable; A-only enablement; failed replacement keeps old status; no composer control. |
| AC3 | pass (fixtures) | One conditional `web_tool`; four invalid emissions → initial + three repairs, zero provider calls; corrected call once; no replay; Calendar-capable advertisement/execution in B3. |
| AC4 | pass (fixtures) | Real SDK wire, fixed endpoints/tools, account headers, ordered fallback, one slot/provider; TinyFish key unsupported; live 0/5. |
| AC5 | pass (fixtures, web-only exhaustion) | 5/5 defaults, independent edits, sixth call denied, fallback charges one logical call. Calendar-specific 5/5 exhaustion unrun; B3 covers Calendar-capable advertisement/execution/repair. |
| AC6 | pass (fixtures) | Real HTTP/SSE and voice admission to model with zero foreground DB/discovery/connect/refresh; held archive does not block continuation/next turn; closed authority fails closed. |
| AC7 | pass (fixtures) | Off/unused/cold turns make zero external web calls; no readiness probes. |
| AC8 | pass (fixtures) | Source/activity linkage in SSE/completed/history; safe HTTP(S) anchors; bound voice frames; honest failures. |
| AC9 | pass (fixtures) | Account isolation, ciphertext-only storage, OAuth denial/expiry/binding in B2, URL safety, disable/cancel/interruption fencing. |
| AC10 | executed with pre-existing failures | Calendar critical paths and existing suites run; pre-existing failures separated. |
| AC11 | evidence complete | This report, verification, operations, actual commits/environment, 0/5 live, native/browser skips, review skipped. |

## Dispatch and latency observations

Ten observed one-sample profiles are recorded in [verification.md](verification.md#dispatch-and-latency-observations). Every measured first model boundary had zero foreground DB reads/writes, zero collection-entry attempts, and zero web initialize/list/connect/refresh/probe. Observed `performance.now()` values ranged from 15.34 ms to 86.72 ms in the fixture process; these are not provider latency, an SLA, or a matched before/after comparison. Synthetic dependency waves are prerequisite-blocked because the probe cannot drive real HTTP/auth/runtime work without forging ordering. Live provider latency, cache hits, and billing are unavailable, not zero.

## Defects, owner fixes and reruns

| Defect | Owner | Status | Evidence |
| --- | --- | --- | --- |
| D1 TinyFish/Keenable console destinations differ from goal | P4 | **resolved** at `26c6461` | Fix updates the catalog to `https://agent.tinyfish.ai/api-keys` and `https://app.keenable.ai/`; F1b 9/9 and R7b 867/867 pass |
| D2 `calendar-memory-voice.spec.ts` assistant message undefined | Pre-existing Calendar/voice | not P5 | Reproduced at base `9849691` per state.md |
| D3 `memory-first-voice.spec.ts` worker exit | Pre-existing/environmental | not P5 | Reproduced at base `9849691` per state.md |

No P5-owned production defect was found in the assembled web path. D1 was fixed by P4 at `26c6461` and rerun successfully; D2/D3 remain pre-existing and outside P5 ownership.

## Provider compatibility and operational limits

- All five live MCP checks **unrun (0/5 live-tested)**.
- All five live browser OAuth/local callback/refresh checks **unrun, fixture-only**.
- TinyFish manual API-key-over-MCP **unsupported** (`WEB_AUTH_UNSUPPORTED` before a request).
- Page fetch **admitted under the client-side guard** for all five providers; provider-side redirect/private-network protections **unverified**.
- OAuth state TTL 600,000 ms; authority bounds 1,024 entries / 2,048 bytes / 15 minutes / four warm reads; limits 5/5 editable 1..20; repairs 3; timeouts 4 s/12 s/25 s/45 s; model attempts 15 default/45 cap.
- Auth authority has out-of-process freshness limitations; active WebSocket principals are not automatically reauthenticated.
- No native MongoDB/replica-set/Azure/staging/live audio/provider billing/latency/cache-hit certification.

## Key artifacts

- [goal.md](goal.md), [research.md](research.md), [state.md](state.md), [plan1.md](plan1.md)–[plan5.md](plan5.md), [plan2a.md](plan2a.md)
- [verification.md](verification.md), [operations.md](operations.md), this report
- Backend P5 fixtures: `backend/test/assembly/web-search-acceptance-fixture.ts`, `backend/test/assembly/web-search-acceptance.spec.ts`, `backend/test/voice/web-search-acceptance.spec.ts`, `backend/test/performance/web-search-latency.spec.ts` (`370ebbd`, `93e8f52`, `901ae21`)
- Frontend P5 fixtures: `frontend/src/features/plugins/integration-tests/web-search-flow.test.ts`, `web-search-browser.html`, `web-search-browser.tsx` (`1df5b08`); D1 fix `26c6461`
- Narrow README update in `README.md` and [operations.md](operations.md) (`ccaa87d`); [verification.md](verification.md) and this report are the final P5 docs commits (`04c06e6`, `487d45e`, and the commit containing this report)

## Unrun checks and remaining work

1. D1 is resolved at `26c6461`; the focused AC1 flow/panel tests pass 9/9 and the full frontend suite passes 867/867. No further D1 action is required.
2. Live provider MCP/OAuth checks require separate authorization, bounded cost/data exposure, and operator-supplied credentials; 0/5 remain unrun.
3. Production fetch admission requires primary provider documentation plus separately authorized service evidence for redirect/private-network protections; P2 owns the policy change.
4. Native MongoDB/replica-set/Azure, staging/proxy, live audio, billing, cache-hit, and latency certification remain unrun.
5. BR1 requires an approved browser surface; the development-only fixture exists but was not executed.
6. Calendar-specific 5/5 exhaustion was not separately executed; B3 covers Calendar-capable advertisement/execution/repair, and B1 covers web-only exhaustion.
7. Pre-existing Calendar/voice/local-guard failures remain outside P5 ownership; do not claim the full suites as green.
8. Unified review remains skipped, not passed. No production readiness is claimed.
