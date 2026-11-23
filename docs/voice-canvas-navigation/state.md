---
objective: voice-canvas-navigation
workflow: maw-lite
status: complete
verification_status: feature-verified-with-known-baseline-failures
source: conversation; docs/voice-canvas-navigation/goal.md
goal_status: approved
dag_status: complete
resume_gate: none
skipped_phases: [review]
---

# State & Execution Plan: Always-available Canvas navigation

## Workflow configuration

- Keep artifacts directly in `docs/voice-canvas-navigation/`.
- One foreground implementation planner followed by one worker and final verification/report; planner and worker phases are complete.
- Current authorization: the approved feature implementation and final report are complete. No external/browser/database checks or unrelated baseline fixes are authorized by this workflow; any such work needs a separate scoped request.
- Mandatory phases: goal alignment, planning, TDD execution, meaningful checks, defect correction, final verification/report.
- Unified review is **skipped**, not passed. No reviewer or review-triggered fixer is to be dispatched.
- Orchestrator manages documentation/status/dispatch/commit serialization only. Never implement code or ingest `plan.md`/`research.md`; verify future plan existence through its reported commit and git metadata.
- No separate research phase is needed for MAW-lite. Planner investigation and current primary library documentation remain required where applicable.
- Current memory-first requirement, added to root `AGENTS.md` in `94fcd1033f0009c64ed55fcb64b6ba38678368ea`: zero DB reads/writes before model dispatch for text and voice; no persistence gate on inference, streaming, or next-turn eligibility; consolidated asynchronous post-response persistence; only external mutations require durable pre-effect barriers. Canvas navigation is an in-memory UI effect, so it must not introduce a pre-model database access or persistence barrier.
- Delegated planner/worker use the session default model; no model override was requested. One child at a time fits the repository's maximum of three children.
- No provisioning, deployment, paid model/STT/TTS calls, microphone checks, or database mutation is authorized.

## Workflow milestones

- [x] Step 1a: Inspect project context and capture the conversationally approved design.
- [x] Step 1b: Write goal and full initial state; inline document/spec consistency check.
- [x] Step 1c: User approval of written `goal.md` (12 November 2026, "Approve and continue").
- [x] Step 2: Foreground planner completes and commits `plan.md` (`5bf56df022111af3279ced64e58a1a4f59a00b96`).
- [x] Step 3: Worker executes plan with TDD and commits changes (`5609aad`, `88c9054`, `886610e`, `d1b3874`, `32c1273`, `4a93dfd`, `3f7a489`).
- [x] Step 4: Final verification and `final_report.md`; full backend/e2e failures are recorded, not treated as passes.
- [x] Unified review recorded as **skipped** under repository instructions.

## Brainstorming tasks

- [x] Explore existing code, relevant workflow context, tests/manifests, and recent commits.
- [x] Clarify purpose and constraints through the preceding user discussion: reopening hidden canvases during a call; stable direct tool; voice-only execution.
- [x] Compare stable native tool, mode-dependent registration, and skill-discovered tool; stable native tool selected by user.
- [x] Present design in conversation and receive conversational approval.
- [x] Save written design and check placeholders, internal consistency, scope, and ambiguity.
- [x] Receive explicit approval of the written specification before planning (12 November 2026).

## Initial findings

- Checkout: `main`; refreshed HEAD `b28677f0bf7424799c0999df0413a1319c783f75`. The plan was committed as `5bf56df022111af3279ced64e58a1a4f59a00b96`; it contains only `docs/voice-canvas-navigation/plan.md` and no source/delegation changes.
- Frontend already implements `OPEN_CANVAS_ARTIFACT` in `frontend/src/features/chat/state/chat-reducer.ts` to open the panel, select an artifact, and remove its exact ID from closed tabs. Reuse this behavior and preserve Calendar alias matching.
- `frontend/src/features/chat/ChatView.tsx` merges archived/text/live artifacts and Calendar workspaces, then filters closed tabs for presentation. Inventory must not be derived only from visible tabs.
- `frontend/src/App.tsx` already passes `openCanvasArtifact` into voice bindings. `LiveVoiceController` currently invokes it for new `canvas.artifact` delivery; new navigation must not pretend an old artifact is newly generated.
- `backend/src/contracts/calendar-tools.ts` defines a frozen direct-native set containing only `activate_skill` and `call_tool`. Its schema names, policy, model adapter, validation/repair, context, and runtime callers need coordinated investigation for a direct third tool; do not tunnel the new tool through plugin execution.
- `backend/src/instructions/system.md` already uses a backend-selected text/voice mode after shared context. Its current voice policy requires new visual output when referencing Canvas and says not to claim interface switching; add a narrowly scoped authorized-navigation exception.
- Voice contracts/guards are mirrored in `backend/src/contracts/voice-wire.ts` and `frontend/src/api/voice-protocol.ts`. Changes must preserve transport limits and lifecycle scoping.
- Backend/frontend are separate npm packages, with existing Vitest checks. Frontend routine tests use Node, not a browser DOM.

### Preserved user work / overlap gate

The seven voice files that were modified at initial setup were subsequently committed by the user as `3978e60634521af9acdac86c83c49b27806d0956` (audio analyser/live waveform changes). Preserve those changes as baseline; do not attribute them to this objective or revert them. The calendar/runtime and prompt edits reported during planning were committed by the user in `b28677f0bf7424799c0999df0413a1319c783f75`; preserve the calendar label/date-format/retention-ceiling behavior and default-or-primary wording while editing overlapping files. They are clean in the refreshed working tree.

The following review artifacts are still untracked user work and must not be staged, overwritten, moved, or attributed to this objective:

- `reviews/November 12/calendar-canvas-presentation-review.md`
- `reviews/November 12/calendar-conversation-runtime-review.md`
- `reviews/November 12/final-review-summary.md`
- `reviews/November 12/google-calendar-provider-transport-review.md`

The future worker overlaps voice controller/bindings work and two Calendar/prompt files, now committed in the baseline. Refresh status/diffs before every edit and commit; preserve these changes and their behavior. If new user work appears in a feature-owned path or overlap becomes inseparable, stop and ask for coordination rather than committing it with the feature. Do not move to a new worktree or branch without authorization solely to avoid this gate. Preserve `.openchamber/` and unrelated local configuration.

## Confirmed product decisions

- Direct `show_canvas({ canvas_id: string })` tool is always advertised in text and live voice, never discovered by `activate_skill` or wrapped in `call_tool`.
- Application enforces live-voice-only execution; prompt policy alone is insufficient.
- Open/focus an existing target, including reopening a closed tab; no replacement visual or deletion.
- Use compact bounded current-conversation inventory including hidden targets and same-call additions; preserve stable IDs and existing Canvas/Calendar workspace behavior.
- Keep stable tool definitions/order and static policy; do not claim guaranteed provider caching savings.
- Reuse current transport and frontend state; no generic UI-command framework, new dependency, or future Canvas tools.

## Dependency matrix & execution status

`A` = written goal approved; `P1` = committed detailed plan; `W1` = worker completion with meaningful checks. Each is a distinct gate.

| Plan ID | Title & scope | Planner prerequisites | Worker dependencies | Touched subsystems | Planner status | Worker status | Commits |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Plan 1 | Stable direct Canvas navigation, inventory, mode gate, scoped voice delivery, prompt, regression checks | A (satisfied) | P1 committed; refreshed ownership baseline | Native tool/model/runtime/context; voice contracts/transport; Canvas/voice frontend state/tests | [x] `5bf56df022111af3279ced64e58a1a4f59a00b96` | [x] Complete; focused tests/build/lint pass; full backend/e2e failures classified as baseline and reported | `5609aad`, `88c9054`, `886610e`, `d1b3874`, `32c1273`, `4a93dfd`, `3f7a489` |

Execution graph: written-goal approval → foreground planner + committed `plan.md` → worker with TDD + commits → final verification/report. Review has no node because it is skipped.

## Plan scopes, file ownership, and completion gates

### Plan 1 — Always-available Canvas navigation

**Deliverable:** `plan.md`; one focused implementation plan covering AC1–AC8 from [goal.md](goal.md).

**Planning ownership:** only `docs/voice-canvas-navigation/plan.md`; planner made no source changes or state edits. The planner consulted current Zod/LiveKit documentation and specified the following design bounds: inventory 24 entries/8192 UTF-8 bytes; titles 120 chars/480 bytes; composite IDs 256 chars; Canvas control 12,288 bytes in one packet; optional pending controls 4/32,768 bytes; result 1024 bytes. Overflow is newest-first with omitted/incomplete counts. The worker completed six atomic TDD tasks. The detailed plan is verified from reported commit metadata, not ingested by the orchestrator.

**Expected worker ownership boundaries (planner selects exact files):**

- Backend contracts/model validation and dispatch, currently rooted in `backend/src/contracts/calendar-tools.ts`, `backend/src/contracts/calendar-model.ts`, and `backend/src/model/calendar-*.ts`.
- Existing runtime/context paths under `backend/src/chat-runtime/` and `backend/src/context/`, and narrowly scoped application composition only where required.
- `backend/src/instructions/system.md` mode/navigation policy.
- Existing backend voice contracts/agent/session/transport paths under `backend/src/contracts/voice-wire.ts` and `backend/src/voice/`.
- Mirrored `frontend/src/api/voice-protocol.ts`, existing voice controller/bindings/state, `frontend/src/App.tsx`, and existing Canvas/chat state integration only as needed.
- Corresponding established tests and fixtures. No unrelated refactors, renderer changes, or plugin redesign.

**Orchestrator ownership:** `goal.md`, `state.md`, `final_report.md`; workflow status and serial commit control. Agents must not overwrite these artifacts.

**Exit gate:** strict tool argument/result handling; stable advertisement without skills/Calendar dependency; backend-enforced text rejection; closed-tab reopening/idempotency; bounded inventory and isolation; stale/cancelled delivery guards; native tool/history and Calendar compatibility; honest prompt/result semantics; focused and full checks with explicit limitations. Required defects remain blocking. No live/paid checks without further permission.

**Worker gate:** obey the current memory-first constraint: zero database reads/writes before model dispatch; no persistence barrier for Canvas navigation; do not block inference, streaming, or next-turn eligibility on persistence; preserve the existing consolidated asynchronous post-response persistence path. Canvas navigation is not an external mutation.

## Acceptance coverage

| Goal criterion | Primary owner | Integrated verification |
| :--- | :--- | :--- |
| AC1: Stable direct advertisement | Plan 1 | Text/voice provider-request fixtures, empty inventory and Calendar-disabled cases |
| AC2: Trusted voice-only gate | Plan 1 | Text/dictation rejection and no UI-side-effect tests |
| AC3: Reopen/focus closed tabs | Plan 1 | Four-artifact/two-closed deterministic voice-to-state scenario |
| AC4: Bounded useful inventory | Plan 1 | Same-call updates, hidden targets, identity/alias, bounds/overflow/isolation checks |
| AC5: Invalid and ambiguous targets | Plan 1 | Strict argument/ID failures; context/policy clarification checks, with model-behavior limitation |
| AC6: Lifecycle isolation/idempotency | Plan 1 | Duplicate, stale epoch/call/conversation/cancellation, old-artifact navigation tests |
| AC7: Prompt/cache contract | Plan 1 | Stable definitions/prefix fixtures; policy regression checks |
| AC8: Regressions and latency | Plan 1 | No activation/lookup/ack wait or DB read/write before model dispatch; no persistence gate for navigation; existing voice/Canvas/Calendar checks; package verification |

## Final verification commands and evidence

Documentation-only setup: verify relative links, goal/state AC coverage, pending/complete status consistency, graph prerequisites, named staged files, and commit metadata. Unrelated application suites are not required for this setup.

After implementation, run:

| Working directory | Command | Purpose |
| :--- | :--- | :--- |
| `backend/` | `npm run build` | **Passed** |
| `backend/` | `npm run lint` | **Passed**; warnings only |
| `backend/` | `npm test` | **3270 passed, 27 failed, 10 skipped**; one Vitest worker error. Failures classified in `final_report.md`; not green. |
| `backend/` | `npm run test:e2e` | **35 passed, 8 failed, 140 prerequisite-guarded skips**; not green. |
| `frontend/` | `npm run build` | **Passed**; existing Vite large-chunk warning |
| `frontend/` | `npm run lint` | **Passed**; warnings only |
| `frontend/` | `npm test` | **806/806 passed** |

Planner supplies exact focused paths/commands. Do not count empty discovery or native prerequisite skips as passing evidence. Record all actual results and limitations in `final_report.md`; unrun browser/live-service checks are not passing checks.

## Artifact and commit record

| Artifact | State | Commit |
| :--- | :--- | :--- |
| `goal.md` | Approved 12 November 2026 | Initial setup `08b9cf8`; approval `83b1159` |
| `state.md` | Complete; feature-specific verification passed and baseline failures recorded | Initial setup `08b9cf8`; approval `83b1159`; planning record `cff1c40`; lifecycle close `1982566` |
| `plan.md` | Committed; planner reports document/link/AC/fence/placeholder/diff checks passed. Offline baseline: backend 6 files/118 tests; frontend 4 files/120 tests including waveform regression. | `5bf56df022111af3279ced64e58a1a4f59a00b96` |
| Implementation | Six planned TDD tasks completed; seven focused implementation/test commits | `5609aade85e115830eaf2db7abb55ca03f106ac3`, `88c9054938cc91460bde32a7ec50cbcb409cb9d3`, `886610e65dac54a72549b0f28d06234dffcc99da`, `d1b387428684e3bf5470c6c19dcb0ae07e9d6617`, `32c127332dec975e0143f56e88c72ec878a95183`, `4a93dfd2d37f762aee5fdb746b10fdf48c70b817`, `3f7a4890249e02edfb4adc17dbf71d8f797d0f88` |
| `final_report.md` | Complete; known baseline failures, skips, and non-authorized checks disclosed | `ebc5900` |

## Current gate and resume procedure

**CURRENT GATE: COMPLETE — FEATURE VERIFIED WITH KNOWN BASELINE FAILURES.** Goal, plan, six implementation tasks, feature-specific checks, final verification, and report are complete. Backend full/e2e suites are not green; their failures and the worker's baseline reproduction are explicit in `final_report.md`. Unified review remains **skipped**. Browser/live/database checks remain unverified and unauthorized.

1. Read this state, approved goal, applicable instructions, and current git status. Do not ingest future `plan.md` into orchestrator context.
2. Goal approval and plan commit are recorded; orchestrator did not read `plan.md`.
3. Refresh status/diffs and protect committed baseline behavior plus untracked `reviews/November 12/` files before any follow-up task.
4. Implementation is committed. Focused acceptance checks pass; full backend/e2e suites retain documented failures reported as baseline, so do not claim all repository checks are green.
5. [final_report.md](final_report.md) records actual results and limitations. Unified review is skipped; real browser/live/database checks remain unrun and unauthorized.
