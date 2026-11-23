# Final Report: web-search-tinyfish-auth

## Executive Summary

TinyFish is now connectable. The provider's authentication was blocked by two independent defects, and
both are resolved:

1. **A stale capability assumption.** `providers.ts` declared TinyFish's hosted MCP endpoint unable to
   accept an API key, so every key attempt was rejected with `WEB_AUTH_UNSUPPORTED` before a request.
   TinyFish's own documentation shows the endpoint accepts `Authorization: Bearer sk-tinyfish-...`, which
   is exactly what Aurvin's credential builder already produced for that header form.
2. **A stale origin allowlist.** TinyFish publishes RFC 9728 protected-resource metadata at the
   path-suffixed location `/.well-known/oauth-protected-resource/mcp` (200), naming
   `https://clerk.tinyfish.ai` as its authorization server. Clerk publishes complete RFC 8414 metadata
   (200). Every static gate condition passed except the per-provider origin pin, because Clerk was not in
   `tinyfish.oauthOrigins`.

Both paths now work. Browser OAuth is reachable for the first time: the connect action previously could
not appear, because the `supported` flag was set only by a completed install and the helper meant to
record support was dead code.

This is **not** a production-readiness claim. Authenticated provider compatibility remains **0/5
live-tested**. DCR response shape, loopback callback acceptance, token exchange, and refresh rotation are
unverified. Nothing here was tested against a real TinyFish account.

## Workflow Configuration

- Skipped phases: **review** (standing user instruction; recorded as skipped, never passed).
- Mandatory phases executed: brainstorming, research, planning, execution, final verification.
- Live external calls: eight unauthenticated GETs and one keyless `POST` against TinyFish/Clerk discovery
  endpoints, plus four GETs against Clerk. No credentials, no account, no registration attempt, no paid
  call.

## Plan Breakdown & Execution Record

| Plan ID | Title | Commits | Status |
| :--- | :--- | :--- | :--- |
| R1 | OAuth metadata probe and provider-auth research | `bc9c5b9` | Complete |
| R1b | Clerk authorization-server follow-up | `7784abc` | Complete |
| P1 | API-key route, Clerk OAuth enablement, honest affordance, docs | `7b5c514` (plan), `7349b41`, `2680ba7`, `56e16e7`, `1922f74` | Complete |
| P2 | Conditional OAuth enablement | collapsed into P1 | Collapsed |

The user's unrelated in-progress work landed as `960e6f8` between groups A and B and was preserved
throughout. `docs/web-search/operations.md` was excluded from worker staging while it carried an
uncommitted paragraph, then updated in a separate commit after the file was clean.

## What Changed

**Group A — `7349b41` `feat(web-search): enable TinyFish Bearer API keys`**

- `providers.ts`: TinyFish `apiKeyHeader` set to `Authorization`, producing `Authorization: Bearer <key>`.
- `connection.ts`: removed the hardcoded `apiKey: 'unsupported'` verdict for TinyFish in both status paths.
- `web-search-protocol.ts`: catalog instructions rewritten for the documented Bearer header and key format.
- Tests: the "refuses TinyFish API-key setup" and "hides its key field" assertions replaced with
  acceptance coverage, plus fail-closed coverage proving a rejected key stores nothing and never falls
  through to another provider.

**Group B — `2680ba7` `feat(web-search): enable gated TinyFish Clerk OAuth`**

- `providers.ts`: added exactly `https://clerk.tinyfish.ai` to `tinyfish.oauthOrigins`. No wildcard, no
  relaxed `assertMetadata`, no relaxed `assertOrigins`, `redirect: 'error'` untouched.
- `oauth.ts`: TinyFish requests only `offline_access` and fails closed on anything broader, instead of
  joining every advertised scope.
- `connection.ts`: removed the dead `markOAuthSupported`.
- `WebSearchPanel.tsx`: unverified providers now offer an explicitly labeled support check that runs the
  real `oauth/start` and surfaces the real error, rather than rendering nothing.
- Fixtures: Clerk-shaped metadata for the positive path, plus a negative fixture proving an origin outside
  the allowlist still throws `WEB_AUTH_UNSUPPORTED`.

**Group C — `56e16e7` and `1922f74`**

`README.md`, `docs/web-search/verification.md`, `docs/web-search/state.md`, and
`docs/web-search/operations.md` reconciled: the unsupported claim is gone, the resolved D1 paragraph is
corrected, and the Bearer-key and support-check paragraphs are added. The `0/5 live-tested` claim is now
qualified as applying to authenticated MCP/OAuth flows.

## Verification & Quality Assurance

Independently re-run by the orchestrator on the committed tree:

| Check | Result |
| :--- | :--- |
| `backend` `npm run build` | exit 0 |
| `backend` `npm run lint` | exit 0, pre-existing warnings only |
| `backend` `npm test -- test/plugins/web-search/` | 9 files / 199 tests passed |
| `frontend` `npm run build` | exit 0, pre-existing chunk-size warning |
| `frontend` `npm run lint` | exit 0, pre-existing warnings only |
| `frontend` `npm test` | 109 files / 871 tests passed |

Worker-reported full-suite comparison:

| Suite | Baseline | Post-change |
| :--- | :--- | :--- |
| `backend npm test` | 82 fail / 3864 pass / 14 skip | 75 fail / 3887 pass / 14 skip |
| `backend npm run test:e2e` | 29 fail / 14 pass / 140 skip | identical |

The delta is the 16 added tests with no newly failing test. `Compare-Object` on failed test names showed
no new failures.

## Limitations and Honest Caveats

1. **0/5 providers remain live-tested.** No authenticated TinyFish request was made. The Bearer-key path
   is vendor-documented and fixture-tested only.
2. **DCR response shape unverified.** Registering would create a real client on TinyFish's identity
   provider, which was not authorized. If Clerk returns a `client_secret`, Aurvin's existing check rejects
   it and OAuth fails closed.
3. **Loopback callback acceptance unverified.** Aurvin sends
   `http://127.0.0.1:5173/api/plugins/web-search/providers/tinyfish/oauth/callback` in local dev; whether
   Clerk accepts that exact URI is untested.
4. **Token exchange and refresh rotation unverified.** No consent flow was run.
5. **Native MongoDB suites skipped, not passed:** 14 routine and 140 e2e, with
   `AURVIN_TEST_MONGODB_URI` cleared. Skips are not evidence.
6. **Baseline caveat, disclosed by the worker:** seven `test/operations/bootstrap.spec.ts` tests flipped
   fail→pass because that file executes the built `dist/main.js`, which `npm run build` regenerated
   between the baseline and post-change runs. The improvement is not attributable to this change.
7. **File-count caveat:** the 406→405 file delta is an untracked `web-dup-id-probe.spec.ts` that failed to
   load at baseline and was later deleted by the user — not a test removed by this work.
8. **Nineteen pre-existing failing backend files remain**, including Calendar assembly/integration/
   performance/runtime, `local-guard`, `local-open`, `local-owner`, `assembled-http`,
   `finalization-repair`, and `voice-bootstrap.e2e-spec.ts`. None are in `test/plugins/web-search/`.
9. **Model enforcement unverified.** OpenCode exposes no surface that reports which model or variant a
   child session actually ran on. Requested values are recorded in `state.md`; they are not confirmed.
10. **Review skipped, never passed.** No reviewer or fixer was dispatched.

## Key Artifacts

- Goal: `docs/web-search-tinyfish-auth/goal.md`
- State & matrix: `docs/web-search-tinyfish-auth/state.md`
- Research: `docs/web-search-tinyfish-auth/research.md`
- Plan: `docs/web-search-tinyfish-auth/plan1.md`
- Review: not produced (skipped)
