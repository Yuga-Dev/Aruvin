# Web Search — Integrated Verification

## Outcome and acceptance gates

P5 executed the deterministic integrated matrix against the committed P1–P4 tree plus the P5 fixtures. The feature works in fixtures for the web-only and Calendar-capable text paths, the shared voice path, ordered provider fallback, bounded repair, account isolation, source linkage, cancellation/disable fencing, and non-blocking archives. It is **not** production-ready: page fetch is admitted for all five providers under Aurvin's client-side guard, but provider-side redirect/private-network behavior remains unverified, browser OAuth is fixture-only, TinyFish's `Authorization: Bearer` API-key path is vendor-documented and fixture-tested but not live-verified, 0/5 providers were live-tested, and no native/staging/latency certification is claimed.

P4 defect D1 is **resolved at `26c6461`**: TinyFish now links `https://agent.tinyfish.ai/api-keys` and Keenable `https://app.keenable.ai/`, matching the approved goal. AC1 is no longer blocked by D1; the focused AC1 flow/panel tests pass 9/9 and the full frontend suite passes 867/867. AC1 remains subject to the unchanged browser-OAuth/0-of-5-live compatibility limitations. AC3/AC5/AC6/AC8 have integrated deterministic evidence but remain subject to the compatibility gates above. Unified review is **skipped**, never passed.

## Tested revisions and preserved workspace

| Run ID | Tested HEAD | Dirty task paths | Other dirty paths | Worker/fix commits included |
| --- | --- | --- | --- | --- |
| P5-baseline | `192f4b3` | none | `.commandcode/` (untracked, preserved) | P1 `06ccaca`…`6371607`; P2 `6f0eeff`…`6b4ed9d`; P2A `48fdb30`…`26b2caa`; P3 `333c7d3`…`4dff1ee`; P4 `427b125`…`e93d77c` |
| P5-integration | `b249625` + P5 test commits | P5 new files only | `.commandcode/` (untracked, preserved) | Same owner commits; P5 fixtures `370ebbd`, `93e8f52`, `901ae21`, `1df5b08` |
| P5-D1-fix | `26c6461` + docs follow-up | none | `.commandcode/` (untracked, preserved) | P4 fix `26c6461`; P5 docs follow-up commit |

The tested application tree for the original matrix is `b249625` (`docs(web-search): record P5 worker dispatch`). The D1 rerun tree is `26c6461` (`fix(web-search): use approved provider console destinations`) plus the P5 docs follow-up; the fix changes only the frontend catalog and its focused tests. The P5 fixtures and documents are new files; they do not modify production source. The Calendar dirty baseline recorded at earlier workflow stages was no longer present in `git status`; only untracked `.commandcode/` remained and was preserved.

## Environment and safety boundary

| Date | OS/shell | Node | npm | Backend Vitest | Frontend Vitest | Native prerequisites present | Browser available |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-14 | Windows / PowerShell 7 (`pwsh`) | v24.19.0 | 11.17.0 | 4.1.11 | 4.1.11 | No (`AURVIN_TEST_MONGODB_URI` absent; prefix not `aurvin_p2_test_`) | No approved browser surface was used; BR1 prerequisite-blocked |

Routine checks ran in child PowerShell processes with `AURVIN_TEST_MONGODB_URI`, `AURVIN_TEST_DB_PREFIX`, `MONGODB_URI`, `OPENROUTER_API_KEY`, `WORKOS_API_KEY`, `GOOGLE_CLIENT_SECRET`, `LIVEKIT_API_SECRET`, and `DEEPGRAM_API_KEY` removed. No live provider, OAuth, WorkOS, OpenRouter, Google, Deepgram, LiveKit, paid, staging, or deployment request was made. Provider fetches and DNS answers in fixtures are deterministic and deny unknown destinations.

## Executed commands

| Run ID | CWD | Exact command | Disposition | Exit | Files pass/fail/skip | Tests pass/fail/skip | Worker errors | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | `backend` | `npm run build` | executed/pass | 0 | — | — | none | `web-search-P5-R1-build.log` |
| R2 | `backend` | `npm run lint` | executed/pass | 0 | — | — | none | console |
| R3 | `backend` | `npm test` | executed/fail | 1 | 381 pass / 19 fail / 3 skip / 1 unreported (404) | 3854 pass / 73 fail / 14 skip (3942) | 1 unhandled worker error | `web-search-P5-R3.log` |
| R4 | `backend` | `npm run test:e2e` | executed/fail | 1 | 3 pass / 1 fail / 44 skip (48) | 14 pass / 29 fail / 140 skip (183) | none | `web-search-P5-R4.log` |
| R5 | `frontend` | `npm run build` | executed/pass | 0 | — | — | none (chunk-size warning) | console; post-D1 rerun also pass |
| R6 | `frontend` | `npm run lint` | executed/pass | 0 | — | — | warnings only | console; post-D1 rerun also pass |
| R7 | `frontend` | `npm test` | executed/fail | 1 | 107 pass / 1 fail / 0 skip | 866 pass / 1 fail / 0 skip | none | `web-search-P5-R7-frontend.log` |
| R7b | `frontend` | `npm test` (after D1 fix `26c6461`) | executed/pass | 0 | 108 pass / 0 fail / 0 skip | 867 pass / 0 fail / 0 skip | none | `web-search-P5-R7-d1fix.log` |
| B1 | `backend` | `npm test -- test/assembly/web-search-acceptance.spec.ts --no-file-parallelism` | executed/pass | 0 | 1 pass | 14 pass | none | console |
| B2 | `backend` | `npm test -- test/plugins/web-search/ test/persistence/web-search-connections.spec.ts src/platform/crypto/web-search-secret-cipher.spec.ts --no-file-parallelism` | executed/pass | 0 | 11 pass | 194 pass | none | `web-search-P5-B2.log` |
| B3 | `backend` | `npm test -- src/contracts/web-search-policy.spec.ts src/contracts/web-search-wire.spec.ts src/contracts/web-search-tools.spec.ts test/model/web-native.spec.ts test/context/web-context.spec.ts test/runtime/web-search-runtime.spec.ts test/runtime/web-search-calendar.spec.ts test/persistence/memory-web-records.spec.ts --no-file-parallelism` | executed/pass | 0 | 7 pass | 55 pass | none | `web-search-P5-B3.log` |
| B4 | `backend` | `npm test -- test/voice/web-search-acceptance.spec.ts test/voice/web-search-voice.spec.ts test/performance/memory-first-voice.spec.ts test/runtime/calendar-memory-voice.spec.ts --no-file-parallelism` | executed/fail | 1 | 2 pass / 1 fail / 1 unreported (worker exit) | 13 pass / 1 fail / 2 unreported | 1 unhandled worker error | `web-search-P5-B4.log` |
| B5 | `backend` | `npm test -- test/performance/web-search-latency.spec.ts test/assembly/web-search-composition.spec.ts test/http/web-search-boundary.spec.ts test/performance/memory-text-archive.spec.ts test/performance/memory-first-text.spec.ts --no-file-parallelism` | executed/pass | 0 | 5 pass | 57 pass | none | `web-search-P5-B5.log` |
| B6 | `backend` | `npm test -- test/auth/ test/administration/ test/http/private-boundary.spec.ts test/assembly/auth-wiring.spec.ts test/assembly/auth-deactivation.spec.ts test/voice/transport/auth-upgrade.spec.ts src/contracts/admin-config.spec.ts src/contracts/voice.spec.ts --no-file-parallelism` | executed/pass | 0 | 32 pass | 358 pass | none | `web-search-P5-B6-baseline.log` |
| C1 | `backend` | `npm test -- test/performance/calendar-tool-latency.spec.ts --no-file-parallelism` | executed/pass | 0 | 1 pass | 47 pass | none | `web-search-P5-C1-baseline.log` |
| C2 | `backend` | `npm test -- test/performance/calendar-memory-first.spec.ts test/performance/memory-calendar-state.spec.ts --no-file-parallelism` | executed/pass | 0 | 2 pass | 82 pass | none | `web-search-P5-C2-baseline.log` |
| C3 | `backend` | `npm test -- test/plugins/google-calendar/connection-prepared.spec.ts test/plugins/google-calendar/tools-boundaries.spec.ts test/assembly/calendar-assembly.spec.ts --no-file-parallelism` | executed/pass | 0 | 3 pass | 33 pass | none | `web-search-P5-C3-baseline.log` |
| C4 | `backend` | `npm test -- test/model/calendar-adapter.spec.ts test/model/calendar-stream.spec.ts test/model/calendar-policy.spec.ts test/model/calendar-validation.spec.ts test/model/calendar-repair.spec.ts test/model/calendar-repair-flow.spec.ts test/model/strict-json.spec.ts test/model/catalogue.spec.ts src/contracts/config-runtime.spec.ts src/platform/config/manageable-config.spec.ts src/admin-config/admin-config.service.spec.ts --no-file-parallelism` | executed/pass | 0 | 11 pass | 275 pass | none | `web-search-P5-C4.log` |
| F1 | `frontend` | `npm test -- src/features/plugins/integration-tests/web-search-flow.test.ts` | executed/fail | 1 | 1 fail | 5 pass / 1 fail | none | console |
| F1b | `frontend` | `npm test -- src/features/plugins/integration-tests/web-search-flow.test.ts src/features/plugins/web-search/web-search-panel.test.ts` (after D1 fix `26c6461`) | executed/pass | 0 | 2 pass | 9 pass | none | console |
| F2 | `frontend` | `npm test -- src/api/web-search-protocol.test.ts src/api/web-search-client.test.ts src/api/protocol.test.ts src/api/client.test.ts src/api/voice-protocol.test.ts src/api/testing/voice-fixtures.test.ts src/features/plugins/web-search/ src/features/chat/state/web-search-chat-state.test.ts src/features/admin-config/ src/features/chat/integration-tests/ src/features/voice/integration-tests/ src/features/voice/state/live-voice-controller.test.ts src/features/voice/state/live-voice-reducer.test.ts src/components/Composer.test.ts src/components/MessageItem.test.ts src/components/VoiceTranscriptModal.test.ts src/App.assembly.test.ts` | executed/pass | 0 | 34 pass | 321 pass | none | `web-search-P5-F2.log` |
| N1 | `backend` | `npm test -- test/persistence/web-search-native.spec.ts --no-file-parallelism` | prerequisite-blocked | — | — | — | — | operator MongoDB settings absent |
| BR1 | `frontend` | `npm run dev -- --host 127.0.0.1` + `/src/features/plugins/integration-tests/web-search-browser.html` | prerequisite-blocked | — | — | — | — | no approved browser surface |

**Plan command deviations.** The B3 catalog references `test/runtime/web-search-coexistence.spec.ts`, which does not exist in the tested tree. B3 was executed with `test/runtime/web-search-calendar.spec.ts` substituted; the Calendar-capable web advertisement/execution/coexistence evidence is in that file. No empty discovery was counted as a pass. The B1, B4, B5, F1, and F2 commands were otherwise executed as written.

## AC1–AC11

| AC | Named tests/command IDs | Observed result | Disposition | Limitation/owner gate |
| --- | --- | --- | --- | --- |
| AC1 | F1/F1b `[AC1][AC2] client status renders five ordered cards…`; F1/F1b `[AC1] goal console destinations…`; B2 providers/connections | Five ordered cards, masked input, safe rel, default-off toggle pass. Exact goal destinations now match: TinyFish `https://agent.tinyfish.ai/api-keys`, Keenable `https://app.keenable.ai/`, Exa `https://dashboard.exa.ai/api-keys`, Tavily `https://app.tavily.com/home`, Firecrawl `https://www.firecrawl.dev/app/api-keys`. D1 resolved at `26c6461`; focused 9/9 and full frontend 867/867 pass. | executed/pass | Browser OAuth fixture-only; 0/5 live. |
| AC2 | F1 connect/replace; B1 `[AC2] account lifecycle`; B1 `[AC7] off and unused`; R7 | Connect returns connected browse true/fetch false with enabled false; candidate not retained; failed replacement keeps old status; A enablement does not enable B; no composer control. | executed/pass | Account-wide text/voice scope proven in fixtures; live providers unrun. |
| AC3 | B1 `[AC3] four invalid emissions…`; B1 `[AC3] a corrected call…`; B3 web-native/policy; B5 composition | Initial + exactly three additional model POSTs, zero provider calls, canonical feedback; corrected call dispatches once and the successful call is not replayed; Calendar-capable advertisement/execution in B3. | executed/pass | Calendar coexistence uses P3's `web-search-calendar.spec.ts`; no live model. |
| AC4 | B1 `[AC4] real SDK fallback is ordered…`; B2 providers/mcp-client/prepared; B3 runtime | Real SDK initialize/list/call over fixed endpoints; Keenable 429 → Exa empty → Tavily usable; one slot/provider; account header on every call; no anonymous/keyless/REST. | executed/pass | TinyFish Bearer key path is fixture-tested only (see the 15 November 2026 follow-up); live MCP 0/5. |
| AC5 | B1 `[AC5] fallback does not multiply…`; B1 fallback/latency; B3 policy | Five logical browse calls allowed, sixth denied; fallback consumes one logical call; defaults 5/5 and 1..20 bounds covered by P1/P4 suites. Calendar-capable advertisement/execution/repair is covered by B3, but a Calendar-specific 5/5 exhaustion case was not separately executed. | executed/pass (web-only exhaustion) | Calendar-specific 5/5 exhaustion unrun; no live provider quota/billing observation. |
| AC6 | B1 `[AC6] real HTTP auth…`; B1 `[AC6] HTTP continuation…`; B1 `[AC6] closed authority…`; B4 voice AC6 cases; B5 composition/archive; latency profiles | Real `/auth/me` then real submit/SSE to model with zero DB reads/writes/collection entries and zero web discovery/connect/refresh/probes; continuation and next turn finish while an actual archive is held; voice admission likewise; closed authority 503 with no model. | executed/pass | Fixture-only; no native DB or live service. `authReads` is cumulative. |
| AC7 | B1 `[AC7] off and unused`; latency off/unused/cold; B5 composition readiness | Off/unused/cold turns make zero external web calls; incidental URL not fetched; no readiness web probes. | executed/pass | Stale-token/service-outage live scenarios unrun. |
| AC8 | B1 `[AC8] source linkage…`; B1 partial/failure paths; B4 bound frames; F1 SSE/render; B5 archive | SSE/completed/history retain `sourceId`/`toolCallId`/provider/mode/turn/attempt; only HTTP(S) anchors render; unsafe list rejected; bound frames preserve sources without speaking activity. | executed/pass | Partial/empty/all-failed honest flows covered by B2/B3; no live verification claim. |
| AC9 | B1 `[AC9] isolated credentials…`; B1 `[AC9] disable mid-call…`; B4 barge-in/disable/revoke; B2 crypto/OAuth/URL safety; B6 authority | A/B sentinel headers isolated; ciphertext contains no plaintext; disable/cancel/voice interruption discard late results; closed authority denies new admission; OAuth denial/expiry/binding in B2. | executed/pass | OAuth fixture-only; no charge-prevention promise. |
| AC10 | C1–C4, B6, R3/R4 | Calendar required cases and existing text/voice/config/auth regressions executed; pre-existing failures separated. R3 failed files are all Calendar/local-guard/performance/integration suites; R4's only failed file is the pre-existing `voice-bootstrap.e2e-spec.ts`. No P5 spec failed. | executed (see R3/R4) | Pre-existing `calendar-memory-voice`, `memory-first-voice` worker exit, `calendar-confirmation`, `calendar-voice-authority`, and voice-bootstrap e2e not claimed as passing. |
| AC11 | D1, R1–R7, N1/BR1 disposition; this document, operations, final report | Tested SHA, environment, commands, counts, latency rows, 0/5 live, TinyFish/fetch/OAuth gates, native/browser skips, auth limitations, review skipped. | executed/pass (evidence) | No production readiness or SLA certification. |

## Defects and owner reruns

| Defect ID | Reproducer/test | Expected | Actual | Owner | Classification evidence | Fix commit | Focused rerun | Broad rerun |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | `frontend/src/features/plugins/integration-tests/web-search-flow.test.ts` → `[AC1] goal console destinations match the approved specification` | Goal destinations `https://agent.tinyfish.ai/api-keys` and `https://app.keenable.ai/` | Delivered `https://agent.tinyfish.ai` and `https://keenable.ai` before the fix | P4 | `frontend/src/api/web-search-protocol.ts` catalog; plan4 explicitly chose the roots | `26c6461` | F1b 9/9 pass | R7b 867/867 pass |
| D2 | B4 `test/runtime/calendar-memory-voice.spec.ts` | Assistant message with internal voice identity | `undefined` | Pre-existing Calendar/voice owner | Reproduced at base `9849691` per state.md; not introduced by P5 | none | not rerun | B4 fails |
| D3 | B4 `test/performance/memory-first-voice.spec.ts` | Test process completes | Worker exited unexpectedly | Pre-existing/environmental | Reproduced at base `9849691` per state.md | none | not rerun | B4 worker error |

## Dispatch and latency observations

All rows are one observed sample per profile on the tested tree. `syntheticMs`/`waves` are `null`: the dependency-wave probe cannot drive the real HTTP/auth/runtime path without forging ordering, so synthetic profiles are prerequisite-blocked. Observed `performance.now()` values are fixture-process observations, not provider or SLA latency. `authReads` is cumulative across setup and turns.

| Scenario | Prior turns | Mode | Boundary | Foreground DB reads/writes | Other-lane DB | Web initialize/list/connect/refresh/probe | Retrieval attempts | Model POSTs | Waves | Synthetic ms | Observed ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| text web-off/new session | 0 | off | first model | 0/0 | 0 | 0/0/0/0/0 | 0 | 1 | null | null | 86.72 |
| text enabled-unused/new session | 0 | unused | first model | 0/0 | 0 | 0/0/0/0/0 | 0 | 1 | null | null | 24.32 |
| text prepared browse/new session | 0 | browse | first model | 0/0 | 0 | 0/0/0/0/0 | 0 | 2 | null | null | 35.06 |
| text prepared browse/eight prior ordinary turns | 8 | browse | first model | 0/0 | 0 | 0/0/0/0/0 | 0 | 10 | null | null | 27.13 |
| prepared existing-session history (hydration excluded) | 1 | browse | first model | 0/0 | 0 | 0/0/0/0/0 | 0 | 3 | null | null | 22.34 |
| cold web state ordinary turn (no turn preparation) | 0 | cold | first model | 0/0 | 0 | 0/0/0/0/0 | 0 | 1 | null | null | 15.34 |
| sequential fallback Keenable→Exa→Tavily | 0 | fallback | first model | 0/0 | 0 | 0/0/0/0/0 | 0 | 2 | null | null | 20.15 |
| repaired call | 0 | browse | first model | 0/0 | 0 | 0/0/0/0/0 | 0 | 2 | null | null | 19.48 |
| repair exhaustion | 0 | repair | first model | 0/0 | 0 | 0/0/0/0/0 | 0 | 4 | null | null | 17.31 |
| actual held archive → tool continuation → immediate next text turn | 0 | archive | first model | 0/0 | 0 | 0/0/0/0/0 | 0 | 4 | null | null | 23.42 |

No matched pre-feature baseline was captured on an identical isolated checkout, so no before/after latency comparison is claimed. Suite duration is not task latency. Live provider latency, cache hits, and billing are unavailable, not zero.

The plan's voice latency profiles (prepared voice browse/next turn under a held archive, and off/unused voice) were not separately timed. B4 provides functional voice admission/frame/archive/barge-in evidence only; no voice latency sample is claimed.

## Provider compatibility

| Provider | Documented key MCP | Fixture modes | Live MCP | Live OAuth/callback | Fetch admission | Admission limitation |
| --- | --- | --- | --- | --- | --- | --- |
| TinyFish | `https://agent.tinyfish.ai/mcp`; vendor-documented `Authorization: Bearer sk-tinyfish-...` | Bearer-key connect/probe/rejection and browse/fetch mapping; Clerk-shaped OAuth start/complete with `offline_access` | unrun (0/5 authenticated) | unrun; fixtures only; unauthenticated metadata observed separately | `verified` (client-guarded); provider-side redirects unverified | Exact `https://clerk.tinyfish.ai` pin; DCR response shape, exact loopback acceptance, token exchange and refresh unverified live |
| Keenable | `https://api.keenable.ai/mcp` | browse/fetch mapping; `X-API-Key` | unrun (0/5) | unrun; fixture-only | `verified` (client-guarded); provider-side redirects unverified | OAuth capability-gated |
| Exa | `https://mcp.exa.ai/mcp` | browse/fetch mapping; `x-api-key` | unrun (0/5) | unrun; fixture-only | `verified` (client-guarded); provider-side redirects unverified | OAuth capability-gated |
| Tavily | `https://mcp.tavily.com/mcp/` | browse/fetch mapping; Bearer | unrun (0/5) | unrun; fixture-only | `verified` (client-guarded); provider-side redirects unverified | OAuth capability-gated |
| Firecrawl | `https://mcp.firecrawl.dev/v2/mcp` | browse/fetch mapping; Bearer | unrun (0/5) | unrun; fixture-only | `verified` (client-guarded); provider-side redirects unverified | OAuth capability-gated |

Page fetch is admitted for all five providers under Aurvin's client-side URL guard, public-DNS checks, provider-returned URL validation, and the untrusted-evidence prompt guardrail. Provider-side redirect-hop/private-network protections remain unverified; this is not a provider-side safety certification. Synthetic fetch fixtures do not change that limitation.

## 15 November 2026 — TinyFish authentication follow-up

This section records the TinyFish authentication follow-up only. It is **not** a rerun of P5 and does not change the P5 run table, counts, or tested SHAs above.

[TinyFish metadata research](../web-search-tinyfish-auth/research.md) recorded unauthenticated probes: the path-specific protected-resource document at `https://agent.tinyfish.ai/.well-known/oauth-protected-resource/mcp` and the Clerk authorization-server document at `https://clerk.tinyfish.ai/.well-known/oauth-authorization-server` both returned HTTP 200. These are metadata observations, not authenticated MCP or live OAuth tests.

| Item | Result |
| --- | --- |
| Commits | A `7349b41` (Bearer API keys), B `2680ba7` (gated Clerk OAuth) |
| `backend` `npm test -- test/plugins/web-search/ --no-file-parallelism` | 9 files / 199 tests passed |
| `backend` `npm test -- test/plugins/web-search/providers.spec.ts test/plugins/web-search/oauth.spec.ts --no-file-parallelism` | 2 files / 47 tests passed |
| `backend` `npm test -- test/plugins/web-search/connections.spec.ts test/plugins/web-search/prepared.spec.ts test/plugins/web-search/runtime.spec.ts test/plugins/web-search/mcp-client.spec.ts --no-file-parallelism` | 4 files / 62 tests passed |
| `backend` `npm run build` | pass |
| `backend` `npm run lint` | exit 0, existing warnings |
| `backend` `npm test` | 75 failed / 3,887 passed / 14 skipped tests; 19 failed files, all pre-existing Calendar/local-guard/performance/integration suites |
| `backend` `npm run test:e2e` | 29 failed / 14 passed / 140 skipped; only `voice-bootstrap.e2e-spec.ts` failed (pre-existing) |
| `frontend` `npm run build` | pass (baseline chunk-size warning) |
| `frontend` `npm run lint` | exit 0, existing warnings |
| `frontend` `npm test` | 109 files / 871 tests passed |

No `test/plugins/web-search/*` file failed in either the pre-change or the post-change routine run, and no test that passed before this follow-up fails after it. The pre-existing `voice-bootstrap.e2e-spec.ts` failure is unchanged (29 failed / 14 passed / 140 skipped before and after). The routine suite was already red before this follow-up: seven `test/operations/bootstrap.spec.ts` tests failed in the pre-change run and passed in the post-change run, and that file exercises the built `dist/main.js` artifact regenerated between the two runs; it is not attributed to this follow-up. Native MongoDB suites skipped in both runs because `AURVIN_TEST_MONGODB_URI` was absent; skips are not passes.

TinyFish browser authorization remains `unverified` until a real successful completion/install. The panel's "Check TinyFish browser authorization support" action calls the existing `oauth/start` route; a failed check displays the real error without changing support, and only a confirmed `complete`/`installOAuth` sets `supported`. The requested and registered scope is exactly `offline_access` — not `openid`, `profile`, `email`, `public_metadata`, `private_metadata`, `user:org:read`, or any future advertised scope — because Aurvin needs an MCP access token with the existing refresh lifecycle, not an OIDC login or user data.

DCR response shape is unverified live; exact loopback acceptance is unverified live; token exchange and refresh are unverified live. Authenticated provider compatibility remains 0/5 live-tested. Review is skipped, never passed.

Any scope or DCR refusal fails closed: a missing `offline_access` advertisement in either the authorization-server or the protected-resource document raises `WEB_AUTH_UNSUPPORTED` before registration or state save, and an `invalid_scope` or DCR refusal surfaces as failure. There is no scope expansion, implicit default scope, or broader retry.

## Unrun and prerequisite-blocked checks

- **N1 native persistence:** prerequisite-blocked. `AURVIN_TEST_MONGODB_URI` is absent and the prefix is not `aurvin_p2_test_`; no native MongoDB/replica-set/Azure check was attempted. Native skips in R4 are separate.
- **BR1 browser fixture:** prerequisite-blocked. The development-only HTML/TSX entry exists, but no approved browser surface was used. Node Vitest does not execute `.tsx` browser checks; F1/F2 are not browser evidence.
- **Live provider MCP/OAuth:** unrun for all five providers (0/5). No live authorization, callback, refresh, billing, or latency check.
- **Live OpenRouter/model, Deepgram, LiveKit/WebRTC:** unrun. Voice fixtures exercise admission/adapter/shared runtime only.
- **Staging/proxy/public deployment, backup/restore, shutdown/rollback drills:** unrun. No provisioning or deployment was authorized.
- **Synthetic dependency-wave latency:** prerequisite-blocked by the probe/HTTP incompatibility described above.
- **Calendar-specific 5/5 exhaustion:** unrun. B1 proves web-only 5/5 exhaustion; B3 proves Calendar-capable advertisement/execution/repair but does not drive six browse calls on that path.
- **`npm run test:azure`, `npm run test:behavior`:** unrun; exit-zero empty discovery is not evidence.

## Operations/document consistency

- [operations.md](operations.md) records the delivered provider setup, rotation, enable/disable/removal, OAuth callback paths, auth authority bounds, safety/limits, privacy/billing, and shutdown/rollback.
- The operations provider table uses the approved goal destinations; the delivered frontend catalog now matches them after D1 was resolved at `26c6461`.
- Numeric limits were checked against `backend/src/contracts/web-search-policy.ts`: 5/5 defaults, 1..20 edits, three repairs, 4 s/12 s/25 s/45 s, model 15 default/45 cap, 1,024/2,048/15 min/four warm reads, 600,000 ms OAuth state.
- README links and document paths were checked locally; no placeholder markers remain.
- No production source, Calendar production, P2 plugin production, P2A auth production, or frontend production file was modified by P5.

## Limitations and review skipped

- Provider compatibility is **0/5 live-tested** for authenticated MCP/OAuth flows; OAuth is **fixture-only**; TinyFish's `Authorization: Bearer` API-key path is vendor-documented and fixture-tested but not live-verified; page fetch is **admitted under the client-side guard** for all five providers, while provider-side redirect/private-network behavior remains **unverified**.
- Browser OAuth/local callback/refresh is not certified; loopback redirect acceptance is unverified.
- Auth authority has an out-of-process freshness limitation: direct Mongo writes, bootstrap CLI while live, other executors, and WorkOS-dashboard changes have no coherent immediate invalidation. Active WebSocket principals are not automatically reauthenticated.
- No native MongoDB, replica-set, Azure, staging, live audio, provider billing, cache-hit, or wall-clock SLA certification is claimed.
- D1 is resolved at `26c6461`; AC1 is no longer blocked by D1. Pre-existing B4 failures are separated and not claimed as passing.
- **Review: skipped by user instruction.** It is not passed.
- No production readiness is claimed.
