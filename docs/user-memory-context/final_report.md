# Final Report: user-memory-context

Status: **complete** (review skipped by instruction). Verified commit set: `8a1ec64` (last implementation commit) plus workflow commits `4e9173b`, `b0669ed`. This report's own commit is the one that adds this file.

## Executive Summary

Aurvin now has a durable, low-latency user-memory layer shared by Text chat and Live Voice:

- **Storage** — a separate `user_memory` collection keyed by user, five caveman-style sections, `<= 2500` chars / `<= 8000` bytes, secret/control-character screening, revision CAS.
- **Hot path** — session pin (`pinnedUserMemory`) taken synchronously from a RAM cache at admission with zero pre-model database reads, LLM calls, or parsing; frozen for the session and refreshed from RAM (0 ms) on compaction.
- **Learning** — passive, off-path extraction on a 120 s idle timer, an 8-turn batch threshold, or compaction kick-off, through a shared `MemoryWriterService` on an Admin-configured `main` or custom model, with `changed: false` as a zero-write no-op and a two-failure cap.
- **Explicit control** — a narrow `update_user_memory` tool for "remember / forget" in Text and Voice with honest receipts, plus the Personalization page `MemoryCard` (toggle, read-only sections, natural-language composer, clear-all with confirmation) and the Admin Config memory-model selector.
- **Feedback** — a minimal clickable `✓ Memory updated` pill on assistant turns, immediate for explicit updates and hydrated for passive batches.
- **True Ephemeral** — Temporary Chat with memory off, hidden from the sidebar, hard-purged across the six collections on exit with accounting retained, plus a 24 h server-side orphan sweep.

Verification: frontend is fully green (121 files / 1,018 tests); backend builds and lints clean, all user-memory suites pass, and the only backend failures are the pre-existing categories recorded before this workflow, reproduced on a pristine pre-P4 tree.

## Workflow Configuration

- Workflow: `maw` (`state_schema_version: 2`), source `docs/user-memory-context/goal.md` (approved `836ed14`).
- Skipped phases: `review` only, per `AGENTS.md`. Recorded **skipped**, never passed; no reviewer or review-triggered fixer was dispatched. Research (`1df0789`), planning, execution, and final verification all ran.
- Delegation (OpenCode `subagent`): planner `openai/gpt-6.2-sol#xhigh` for P1 and `#max` for P2–P3; P4 planning resumed by the user with an unreported replacement selector; P5/P6 manual planner handoffs; workers on the harness default. Enforcement stayed `unverified`; no claim is made that the original P4 selector was used.
- Concurrency: at most three children; P2, P3 and P5 ran in parallel on disjoint files with serialized commits; P4 followed P1–P3/P5, P6 followed P4/P5.
- Merge handling: during resume, `origin/main` fast-forwarded `de34009` → `7538428` (a large unrelated dev-mode / environment-tool / weather-canvas / personalization merge). Measured drift reached only `backend/src/app.service.ts` (P4 scope) and `frontend/src/api/voice-protocol.ts` (P6 scope); both were merged atop, with no revert of other work and no contract change.

## Plan Breakdown & Execution Record

| Plan | Title | Commits | Status |
| :--- | :--- | :--- | :--- |
| P1 | Shared Contracts, Collections & Admin Memory Config | `d99f622`, `add0786`, `822eb7b`, `80244e2`, `49033d2`, `97fffb2`, `4170d8c`, `1b2dfb2` | Complete |
| P2 | Persistence, RAM Cache, `MemoryWriterService` & HTTP API | `5c94e63`, `6ba1163`, `f4e0112`, `12710ee`, `586a0a3`, `79c0d06` | Complete |
| P3 | Context Prefix, `ChatFloor`, Policy & Ephemeral Hard-Purge | `e994748`, `c809798`, `1970fcb`, `a661904`, `4b45d6a`, `b0cd9f6`, `f813ed2`, `2f40a48`, `e08cf26`, `1593082` | Complete |
| P4 | Runtime Pinning, Scheduler, Explicit Tool, Voice & App Wiring | `30fc2ed`, `0425de0`, `6169705`, `c41cd1a`, `58b5f75`, `48f8388`, `9718ddb`, `3f1e9ee`, `c9293e3`, `f62fcd5`, `66efff5`, `484c072`, `51c45d0`, `e8d4c28` | Complete |
| P5 | Personalization `MemoryCard` & Admin Memory Model Selector | `ac4e97f`, `43aa538`, `15479b6`, `b493fec`, `604314e`, `166f411` | Complete |
| P6 | Chat UX (`✓ Memory updated` Pill + Temporary Chat) & Integration | `375fc99`, `d099e69`, `79dcfe8`, `b68809f`, `b3c37a0`, `5990908`, `8a1ec64` | Complete |

Documentation commits: goal `836ed14`; research `1df0789`; plans `b07d2ba`, `8f12e72`, `310bc73`, `e2c9286`, `b428b5a`, `14d8453`; state checkpoints `5192393`, `4e9173b`, `b0669ed`.

## Verification & Quality Assurance

Environment: Windows (`win32`), Node `v24.19.0`, npm `11.17.0`, repository the repository root, branch `main`, worktree clean, deterministic provider fixtures only.

| Directory | Command | Result |
| :--- | :--- | :--- |
| `backend` | `npm run build` | **pass** (exit 0) |
| `backend` | `npm run lint` | **pass** (exit 0; warnings only, pre-existing categories such as `unbound-method` in voice tests) |
| `backend` | `npm test` | exit 1 — **4,288 passed / 82 failed / 14 skipped** across 450 files; no user-memory suite in the failure set |
| `backend` | `npm run test:e2e` | exit 1 — **38 passed / 8 failed / 141 skipped**; all 8 failures are `test/assembly/voice-bootstrap.e2e-spec.ts` |
| `backend` | `npx vitest run src/contracts/voice.spec.ts` | **12/12 pass** (portable voice mirror now byte-equal) |
| `frontend` | `npm run build` | **pass** (only the pre-existing >500 kB chunk advisory) |
| `frontend` | `npm run lint` | **pass** — 0 errors, 113 warnings, all pre-existing |
| `frontend` | `npm test` | **pass** — 121/121 files, 1,018/1,018 tests, 0 skipped |

### New and directly relevant suites

- `backend/src/chat-runtime/user-memory-scheduler.spec.ts` — 7/7 (idle, batch, compaction, caps, cancellation).
- `backend/test/runtime/user-memory-runtime.spec.ts` — 35/35 (pin/freeze/refresh, explicit tool on Text and Voice, Calendar continuation, ephemeral purge fence, sweep).
- P2/P3 suites: `user-memory.service.spec.ts`, `memory-writer.spec.ts`, `user-memory-http.spec.ts`, `persistence/user-memory.spec.ts`, `context/user-memory-context.spec.ts`, `persistence/ephemeral-purge.spec.ts`, `context/history-budget.spec.ts`, `persistence/session-navigation.spec.ts` — all passing in the full run.
- `frontend/src/features/personalization/user-memory.test.ts`, `features/chat/state/user-memory-chat-state.test.ts`, `features/chat/integration-tests/user-memory.test.ts`, `api/user-memory-client.test.ts` — covered by the green 1,018-test frontend run.
- Cost-path check: `test/performance/web-search-latency.spec.ts` 11/11 after `e8d4c28`, including the eight-prior-turn profile whose first model boundary shows `dbReads/dbWrites/storageEntries/initialize/list/connect/refresh/probes/retrieval = 0`.

### Pre-existing backend failures (not regressions)

The 82 failing unit tests sit in 20 files, all in categories recorded before this workflow and reproduced by the P4 worker on a pristine pre-P4 tree (`4e9173b`):

| Spec | Failed / total | Category |
| :--- | :--- | :--- |
| `test/performance/durable-latency.spec.ts` | 25 / 61 | wall-clock baseline caps (timing-sensitive) |
| `test/integration/plugins/multi-calendar/{acceptance,authority,accounting-recovery}.spec.ts` | 19 | Auth fixture `AuthFault NOT_READY` (recorded since P2) |
| `test/runtime/compaction-runtime.spec.ts` | 7 / 8 | pre-existing compaction fixtures |
| `test/runtime/calendar-confirmation.spec.ts` | 4 / 20 | pre-existing confirmation fixtures |
| `test/plugins/integration/assembled-http.spec.ts`, `test/assembly/calendar-multi-http.spec.ts` | 8 | assembled HTTP fixture |
| `src/app.controller.spec.ts` | 3 / 16 | P9 lifecycle drain fixtures |
| `test/persistence/local-open.spec.ts`, `local-owner.spec.ts` | 4 | mutation-journal admission / recovery filter |
| `test/operations/local-guard.spec.ts` | 3 | local admission fixtures |
| `test/performance/calendar-voice-latency.spec.ts` | 2 / 14 | wall-clock comparison |
| `calendar-{flow,http,simplification.built,memory-voice,voice-authority}`, `memory-first-voice`, `finalization-repair` | 7 | recorded pre-existing |

Full-suite counts fluctuate with the timing-sensitive latency and voice tests (recorded baselines: 4,148/72 at P1, 4,253/75 at P2, 4,248/80 at P3, 4,283/87 at P4); 82 is within that band and the failing file set is unchanged.

## Acceptance Coverage

| Criterion | Evidence |
| :--- | :--- |
| AC1 collection, sections, caps, screening, CAS | contracts + persistence + service suites; `user_memory` CAS tests |
| AC2 zero pre-model DB/LLM latency | `user-memory-runtime` zero-read evidence; `web-search-latency` boundary counters |
| AC3 KV-safe pin, 0 ms compaction refresh | runtime pin/freeze/refresh tests |
| AC4 passive synthesis, watermark safety, accounting | scheduler suite, writer suite, runtime finalized-turn evidence |
| AC5 explicit `update_user_memory` | native Text and Voice execution/receipt tests, Calendar continuation tests |
| AC6 True Ephemeral | `ephemeral-purge` retention tests, frontend purge integration test |
| AC7 MemoryCard + Admin selector | frontend personalization and config-edit-state tests; backend admin-config mirror |
| AC8 `✓ Memory updated` pill | reducer/state tests and SSE + passive-hydration integration test |
| AC9 mode-invariant prefix, `ChatFloor`, Dev stripping | `user-memory-context`, `history-budget`, `dev-mode-dispatch` |

## Deviations and Decisions

1. **Temporary Live Voice stays disabled by default.** The backend gate and frontend propagation exist and are tested, but `TEMPORARY_LIVE_VOICE_ENABLED = false` and no UI path passes `allowTemporaryLive`. Enabling it is a pending product decision, not an unverified default.
2. **Sweep start no longer calls `assertExecutor()`.** It serialized with a chat write in the fixture; `purgeEphemeral` still asserts the executor before every delete, so the safety property is unchanged.
3. **Writer runs under `trackConfigJob`**, parses prompt-enforced JSON without `response_format`, rejects secrets/control characters, and stops after two consecutive failures per session.
4. **`Use compaction model` is a snapshot copy**, not a live link, preserving the approved UI choice without widening config.
5. **Test-scope adjustments only:** `web-search-latency` now asserts turn-relative boundaries (`e8d4c28`); one-line `voice/session/config-snapshots.spec.ts` fixture alignment (`51c45d0`); `TranscriptProps` exported for `createElement`; a pagehide listener array for TS narrowing; one lint suppression in the new hook harness.
6. **Temporary prompts never use `sessionStorage`**; memory updates are stripped from temporary transcripts defensively.

## Limitations / Not Certified

- **No native MongoDB run** (`AURVIN_TEST_MONGODB_URI` was not supplied). CAS, hard purge, index creation, and the orphan sweep are proven against deterministic repository fakes only — no replica-set, topology, or Azure/Cosmos certification.
- **No live providers**: no OpenRouter writer call, no Google Calendar, no LiveKit session. Writer behaviour is proven with a scripted model; no cost or wall-clock extraction SLA is claimed.
- **No staging deployment** or access-controlled environment evidence; readiness, backup/restore, and retention drills were not re-run for this feature.
- **Review skipped** by explicit instruction; this report is a verification record, not a peer review.

## Key Artifacts

- Goal: `docs/user-memory-context/goal.md`
- Research: `docs/user-memory-context/research.md`
- Plans: `docs/user-memory-context/plan1.md` – `plan6.md`
- State & DAG: `docs/user-memory-context/state.md`
- Entry points: `backend/src/personalization/user-memory.service.ts`, `backend/src/personalization/memory-writer.ts`, `backend/src/chat-runtime/user-memory-scheduler.ts`, `frontend/src/features/personalization/MemoryCard.tsx`, `frontend/src/features/chat/state/use-chat.ts`
