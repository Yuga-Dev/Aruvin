# Final Report: voice-canvas-navigation

## Executive summary

Implemented one directly advertised native `show_canvas({ canvas_id })` tool that remains in the model catalogue in both text and live voice. The application authorizes navigation only for the active trusted voice call, supplies a bounded in-memory inventory, and uses the existing Canvas state path to reopen/focus existing artifacts. No skill activation, Calendar connectivity, browser acknowledgement, provider lookup, new dependency, or pre-model persistence barrier is required.

The feature-specific focused checks and the full frontend suite pass. The backend build and lint pass. The full backend routine and e2e suites still have known failures, reported as baseline failures unrelated to this feature; these failures are documented below and are not represented as passing. Browser/microphone/SFU, live paid providers, and native database/Azure checks remain unrun and unauthorized. Unified review was **skipped**, not passed.

## Implementation

- Added the strict, stable native tool contract and result pairing directly alongside existing native tools; it is not discovered through `activate_skill`/`call_tool` and does not depend on Calendar availability.
- Added bounded Canvas inventory/control contracts and a soft, scoped voice-delivery path with stale-call protection.
- Authorized targets from trusted live-call and current-conversation state in memory. Text mode is rejected without a UI effect; navigation does not add a database read/write before model dispatch or a persistence barrier.
- Reused the frontend Canvas inventory/state flow to focus an open artifact or restore a closed tab. Existing Calendar workspace identity and manual Canvas behavior are preserved.
- Updated system policy for direct voice navigation, disambiguation, text-mode prohibition, and honest presentation-result wording.

### Inventory and transport bounds

The planner/worker implemented the planned bounds: 24 inventory entries and 8192 UTF-8 bytes; titles at most 120 characters/480 bytes; composite IDs at most 256 characters; one Canvas control packet at most 12,288 bytes; optional pending controls at most 4/32,768 bytes; results at most 1024 bytes. Overflow is newest-first and reports omitted/incomplete counts rather than claiming the list is exhaustive.

## Changed implementation areas

- Backend tool, model, result, and history contracts under `backend/src/contracts/`, `backend/src/model/`, and the existing calendar runtime/context.
- In-memory inventory authorization under `backend/src/chat-runtime/canvas-navigation.ts`, existing durable runtime/voice adapter paths, and `backend/src/instructions/system.md`.
- Bounded backend/frontend voice protocol and control transport.
- Frontend inventory helper `frontend/src/features/canvas/canvas-navigation.ts`, voice controller, and `ChatView` integration.
- Focused contract, runtime, voice transport, integration, and regression fixtures/tests.

## Git commits

Plan commit: `5bf56df022111af3279ced64e58a1a4f59a00b96`.

Implementation commits, all present on `main`:

- `5609aade85e115830eaf2db7abb55ca03f106ac3` — direct native `show_canvas` contracts.
- `88c9054938cc91460bde32a7ec50cbcb409cb9d3` — bounded Canvas wire controls and soft delivery lane.
- `886610e65dac54a72549b0f28d06234dffcc99da` — Calendar-independent native availability and policy.
- `d1b387428684e3bf5470c6c19dcb0ae07e9d6617` — trusted inventory ownership and local result pairing.
- `32c127332dec975e0143f56e88c72ec878a95183` — frontend inventory publishing and reopen/focus.
- `4a93dfd2d37f762aee5fdb746b10fdf48c70b817` — frontend wire-parity integration coverage.
- `3f7a4890249e02edfb4adc17dbf71d8f797d0f88` — offline backend integration and regressions/fixes.

The seven earlier waveform/analyser changes were already committed by the user in `3978e60634521af9acdac86c83c49b27806d0956`; they are baseline, not part of this feature. The concurrent Calendar/review changes were also preserved. Four untracked files under `reviews/November 12/` remain user-owned and untouched.

## Verification

Environment: Windows, Node `v24.18.0`, npm `12.0.1`; implementation commits are on `main` at `3f7a4890249e02edfb4adc17dbf71d8f797d0f88`.

| Check | Result |
| --- | --- |
| Backend focused Canvas contract/runtime/ownership/voice integration tests (5 files) | **64 passed** |
| Worker-reported expanded backend feature regression set (15 files) | **99 passed** |
| Frontend focused Canvas and voice integration tests (2 files) | **15 passed** |
| Frontend full suite | **806 passed** |
| Backend build | **Passed** |
| Backend lint | **Passed**, warnings only; no lint errors reported |
| Frontend build | **Passed**; Vite reports the existing large-chunk warning |
| Frontend lint | **Passed**, warnings only; no lint errors reported |
| Backend full suite | **Not green:** 3270 passed, 27 failed, 10 skipped; six test files and one Vitest worker error |
| Backend e2e | **Not green:** 35 passed, 8 failed, 140 prerequisite-guarded skips |

The focused offline voice integration scenario covers seeded visual inventory, native tool/result pairing, `canvas.show` identity, text-mode rejection, lost presentation publish, cold reload without redispatch, and operation with Calendar disabled. The worker reports that scenario passed 5/5.

### Existing backend failures / limitations

The full backend suite was run after the backend build and produced the same 27 failing tests reported by the worker. Failures are concentrated in stale Calendar instruction/confirmation expectations, durable-latency fixed caps and context-ceiling scenarios, the memory-text archive partial-publication expectation, and the finalization BSON redaction expectation. The built Calendar assembly test also fails to import `dist/plugins/google-calendar/tools.js`. The worker reports reproducing the failure set at baseline sources; this workflow did not change those expectations or unrelated Calendar/runtime behavior. The full run also reported a Vitest worker exit in the memory-first suite; the worker reports that issue reproduces at baseline and that the test passes individually.

The e2e suite's eight failures are in `voice-bootstrap.e2e-spec.ts`; the worker reports reproducing them with voice sources reverted to the baseline. They remain unresolved suite failures, not successful checks. No unrelated fixes were made under this Canvas task.

No real browser/microphone/SFU test, live model/STT/TTS call, native MongoDB test, or Azure compatibility test was run. These checks require separate authorization/prerequisites and remain unverified.

## Review status

Unified code review: **skipped** per repository instruction. This is not a pass or an endorsement of the unrelated baseline failures.

## Outcome

Canvas navigation implementation and its targeted acceptance evidence are complete. The repository-wide backend test/e2e gates remain red for the documented baseline failures; do not infer overall project readiness from the passing focused checks or frontend suite.
