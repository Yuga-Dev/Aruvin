# Final Report: prompt-cache-compaction-fixes

## Executive summary

This workflow fixed the four actionable audit concerns while keeping Aurvin’s normal chat path append-only and memory-first.

- Emergency Web result folding now runs only on real native overflow, uses a real protected tail, and sends the folded projection in the final provider request.
- Stable fixed assets lead the prompt; volatile voice Canvas state is rendered after history and before the current input.
- One server-derived OpenRouter conversation ID is used across plain, Calendar/composite, Web-only, and compaction dispatches.
- Active-fork compaction now reuses the exact stable fixed prefix, consumes only validated Web evidence from selected completed attempts, and settles overflow rebase with the adopted turn handle.

Ordinary admitted prompts remain literal. No new settings, dependencies, storage schema, live provider calls, native MongoDB tests, staging access, deployment, or cache-savings/latency/cost claims were introduced. Dedicated research and unified code review were skipped as instructed; review is recorded as **skipped**, not passed.

## Workflow configuration

- Workflow: MAW, four-plan DAG.
- Skipped phases: `research`, `review`.
- Required phases completed: brainstorming/spec, planning, implementation with tests, final verification.
- Source: approved goal in `docs/prompt-cache-compaction-fixes/goal.md`, commit `2929b0d`.
- Checkout: current `main`, preserving unrelated user work. `.gitignore` and untracked docs/outputs were left untouched.
- Worker handoff order: P1 → P2 → P3 → P4, with P4 last because it integrates the earlier contracts.

## Plan execution record

| Plan | Scope | Worker commits | Status |
| --- | --- | --- | --- |
| P1 | Emergency Web result folding and final native admission | `d428b5a` | Complete |
| P2 | Stable fixed prefix and voice Canvas suffix | `541e1be`, `52a6b3a` | Complete |
| P3 | One server-derived OpenRouter conversation ID across routes | `79ff453`, `410767a` | Complete |
| P4 | Compaction prefix, validated checkpoint evidence, rebase/cancel | `5e78feb` | Complete |

P4’s changes arrived unstaged in the working tree; the orchestrator staged only the four task files and committed them as `5e78feb`. Unrelated `.gitignore` and untracked output remained unchanged.

## Implementation details

### P1 — overflow folding

- `backend/src/context/tool-folding.ts`: one pure `foldHistoricalWebResult` projection; exact URL/title/source identity, success-only canonical payloads, and required byte shrink.
- `backend/src/context/web-context.ts`: `admitNativePrompt`, protected active and last three historical user turns, newest-first candidates, merged Web-only/Calendar admission.
- `backend/src/context/calendar-context.ts`, `backend/src/chat-runtime/calendar-loop.ts`: one final native gate after historical/current Web insertions.
- `backend/src/chat-runtime/memory-text.ts`: foldable-turn selection from completed/truncated records, pending-proposal exclusion, route preflight, and dispatch of the admitted final request only.
- Wire tests cover Web and composite routes for history/total overflow, repeated inputs, protected continuation, and rejection when protected content cannot fit.

### P2 — stable prefix and Canvas suffix

- `backend/src/context/referenced-context-assembler.ts`: prefix starts with `fixedContextMessages(assets)`, then personalization, environment, and response mode.
- `backend/src/context/calendar-context.ts`: plugin catalog stays at the assembler prefix boundary; voice Canvas state moves after historical Web/Calendar insertions, immediately before accepted input.
- `backend/src/context/context-budget.ts`, `backend/src/context/web-context.ts`: one trusted fixed-overhead slot is excluded from native history estimates only; full prompt and message-count checks still include Canvas.
- Tests assert byte-identical older wire messages when Canvas state changes on continuations, plus ordering and exact budget boundaries.

### P3 — routing parity

- `backend/src/model/policy.ts`: `openRouterSessionId(userId, sessionId)` produces `aurvin-` plus SHA-256 of the JSON pair.
- Plain, Calendar/composite, compaction, and Web-only dispatch paths send the same server-derived `session_id`.
- `backend/src/chat-runtime/memory-text.ts` passes `e.turn.sessionId` with `e.turn.userId` to the Web-only factory; the factory type requires server-bound session identity.
- Client-supplied identity/routing fields do not override the server value. Existing cache defaults, tools, prompts, and compaction mode behavior were left unchanged.

### P4 — checkpoint and rebase

- `backend/src/chat-runtime/memory-text.ts`: active-fork compaction sends the exact `fixedContextMessages(assets)` prefix; custom mode keeps the lean instructions-only prefix.
- Checkpoint deltas use only selected completed turns and exact completed attempts. Valid Web groups are projected with `foldHistoricalWebResult`; failed/unvalidated groups are dropped; Calendar-marked prose becomes the tombstone and prior Calendar summary blocks are redacted before reuse.
- `backend/src/chat-runtime/memory-first-foundation.ts`: overflow promotion adopts the rebased turn into the active entry before cleanup. Cleanup excludes the active turn, preserves unsaved compacted turns for status/retry, and detached/cancelled waits settle without waiting for the shared checkpoint job.

## Verification and quality assurance

Verification was run on the integrated checkout after commit `5e78feb`.

| Check | Result |
| --- | --- |
| `npm run build` (`backend`) | Passed |
| `npm run lint` (`backend`) | Exit 0; pre-existing warnings only |
| Focused workflow suites (25 files) | 383 passed, 0 failed |
| Full `npm test` (`backend`) | 17 failed files, 400 passed, 3 skipped; 66 failed tests, 4073 passed, 14 skipped; 1 worker error |
| Baseline comparison | Workers reproduced the same 66-test failing set on clean `HEAD`; failures are pre-existing assembly/readiness 503s, persistence setup, built-dist import, and frozen latency/performance gates |
| Native MongoDB / Azure | Not run; requires operator-supplied isolated URI and prefix |
| Live provider / staging / paid calls | Not run; explicitly out of scope |
| Cache-hit, TTFT/TTFA, and cost measurement | Not claimed; would require live instrumentation and authorization |

The focused set covered folding, history budgets, Calendar/Web context, Web follow-up wire admission, stable prefix/personalization, Canvas ordering and retention, routing parity, Web-native dispatch, and compaction runtime/foundation/model suites.

## Key artifacts

- Goal: `docs/prompt-cache-compaction-fixes/goal.md`
- State and DAG: `docs/prompt-cache-compaction-fixes/state.md`
- Plans: `docs/prompt-cache-compaction-fixes/plan1.md` through `plan4.md`
- Final report: `docs/prompt-cache-compaction-fixes/final_report.md`

## Limitations and follow-ups

- The full backend suite is not green in this checkout; the 66 failures reproduce on clean baseline and are outside this change set.
- One Vitest worker-exit error occurred in the full run; focused suites are clean.
- No provider affinity, cache-hit, latency, or savings improvement is certified by deterministic fixtures.
- Review remains skipped; no reviewer verdict exists.
