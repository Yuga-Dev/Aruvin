# Final Report: context-compaction-memory

## Executive Summary

Delivered in-session, cache-aligned context compaction and semantic-ready memory for Aurvin's Text Chat and Live Voice, replacing the fail-closed `"Start a new chat"` context wall. The two-stage pipeline performs zero-cost deterministic tool-payload folding and asynchronous structured compaction at an 80% soft watermark, keeps live turns at zero pre-model DB latency, preserves append-only prompt prefixes for KV-cache hits, lifts the former 128-turn / 500-message working ceiling, and adds a quiet Text Chat checkpoint divider/context meter plus Admin Config controls. Live Voice compaction is silent.

All five plans were written and executed under the MAW pipelined DAG. Unified review was **skipped** by instruction (`--skip review`) — never passed. Final verification was run directly by the orchestrator. One genuine regression introduced by P3 was found during final verification and fixed (`8466183`). All remaining test failures were proven identical to the pre-workflow baseline via an isolated worktree at `dd7580a`; they are not workflow regressions.

## Workflow Configuration

- Workflow: `maw` (pipelined DAG), resumed from `state.md` (`12a31cc`).
- Skipped phases: **review only** (`--skip review`). Brainstorming, research, planning, worker execution, meaningful tests, and final verification were all performed.
- Concurrency: at most three child agents; git commits serialized centrally by the orchestrator.
- Resumed from approved goal (`dd7580a`) and committed research (`81719e1`), reconciled in `b477a62`.
- Unrelated user changes (`output/`, voice/VAD work, `benchmarks/voice-architectures/**`, `.openchamber/**`) were preserved untouched.

## Plan Breakdown & Execution Record

| Plan | Title | Plan commit | Worker commits | Status |
| :--- | :--- | :--- | :--- | :--- |
| P1 | Contracts, Admin Config Schema & Persistence Primitives | `9a1a3a0` | `b9b6864`, `95bbdbd`, `2d864de`, `16612be`, `11bbd83` | Completed |
| P2 | Context Engine: Tool Folding, Cutpoint, Compaction Prompt & Prompt Copy | `3097f59` | `568354f`, `7ca1d62`, `5b8ff1b`, `70d2753`, `620f91b`, `5d19db6`, `43e0de0` | Completed |
| P3 | Runtime Compaction Engine, Working-Set Eviction & Model Dispatch | `e2395c4` | `a39bdff`, `337725b`, `f42aad1`, `6fa13ae`, `8cf5974`, `ae29dbb`, `208611b` | Completed |
| P4 | Frontend Chat Checkpoint UI, Context Meter & Admin Config | `2a8f0c7` | `17d9b12`, `debca9a`, `1ee8b57`, `6d3d5aa`, `e4fc4d7`, `39e5fbe`, `de6ecf8` | Completed |
| P5 | Integrated Verification, Native Long-Session E2E & Eval Alignment | `0bc2f4b` | `1cb7b0e`, `0c6adc2` | Completed |

Final verification fix: `8466183`. The interleaved voice commit `043773b` and voice-bench commits are unrelated user work, not part of this workflow.

### Acceptance coverage

- **AC1** (zero pre-model DB latency & KV-cache prefix preservation): P2 folding restricted to checkpoints/burst relief; P3 async engine holds `[0..prefixCount]` + `[activeSummary]` byte-identical between cycles. Verified by `compaction-runtime.spec.ts`, `prompt-caching.spec.ts`.
- **AC2** (deterministic tool folding & ongoing-task protection): `tool-folding.spec.ts`, `cutpoint.spec.ts` — whole-turn cutpoints, `protectedTail`, pinned commitments, stub preservation of URLs/IDs.
- **AC3** (async 80% compaction, non-blocking turns, between-turn promotion, burst fallback): `compaction-runtime.spec.ts`, `compaction-foundation.spec.ts`.
- **AC4** (`<analysis>` stripping, eight-section anchored merge, Calendar redaction): `compaction-prompt.spec.ts`, `tool-folding.spec.ts`, `compaction-records.spec.ts`, P5 Calendar tombstone E2E.
- **AC5** (128-turn / 500-message ceiling removed, full scrollback, O(tail) hydration): `compaction-foundation.spec.ts`, `compaction-hydration.spec.ts`, P5 160-turn deterministic E2E.
- **AC6** (Admin Config `active-fork` default + custom model, quiet Text/Voice UX): `admin-config.service.spec.ts`, `app.controller.spec.ts`, P4 `Transcript`/`Composer`/`ChatView.voice` tests.

## Verification & Quality Assurance

Commands run directly by the orchestrator (Node v24.18.0):

| Working dir | Command | Result |
| :--- | :--- | :--- |
| `backend` | `npm run build` | PASS (exit 0) |
| `backend` | `npm run lint` | PASS (exit 0; warnings only, no errors) |
| `backend` | `npm run test:e2e -- test/integration/compaction.native.e2e-spec.ts` | PASS — 3 passed, 1 skipped (native MongoDB twin, NOT-RUN: no URI) |
| `backend` | focused P2+P3+P5 compaction/context/persistence suites | PASS — 298 passed across 27 files |
| `backend` | `npm test` | 4027 passed, 66 failed, 14 skipped — all 66 proven pre-existing (see below) |
| `backend` | `test:behavior` | 3 passed, 2 failed, 1 skipped — 2 failures proven pre-existing |
| `frontend` | `npm run build` | PASS (exit 0) |
| `frontend` | `npm run lint` | PASS (exit 0) |
| `frontend` | `npm test` | 902 passed, 1 failed — pre-existing voice-fixture mismatch (see below) |

### Regression found and fixed during final verification

- `test/performance/memory-first-foundation.spec.ts > stops new paid admission when dirty age expires` failed on the assembled tree but passed at baseline. Root cause: P3 added `&& entry.jobs.length === 0` to the dirty-age admission guard in `memory-first-foundation.ts`, which suppressed the "Save backlog age exceeded" safety error whenever any job was pending. Fixed by restoring the original guard (`8466183`). All 20 context/compaction/persistence suites and all 5 P3 runtime suites pass after the fix; full-suite failures dropped from 67 to 66.

### Pre-existing failures (verified, not workflow regressions)

To avoid inferring readiness from worker summaries, an isolated worktree at pre-workflow commit `dd7580a` was used with a junctioned `node_modules`. Results were identical between baseline and assembled tree:

- Backend `npm test`: 66 failing tests in 17 files, fully accounted for — 58 in assembly/plugin-integration/performance-latency/local-persistence files, 6 in calendar runtime files, 1 in `finalization-repair.spec.ts`, 1 in `local-owner.spec.ts`. The same counts appeared at baseline (including the 12-file batch: 58 failed / 58 passed, and 3-file calendar batch: 6 failed / 20 passed).
- `test:behavior`: 2 failures (`fails if instruction or knowledge release/digest changed`, `defines both modes in one prompt and scopes Canvas to text only`) — identical at baseline. `KNOWLEDGE_DIGEST` (`568E38BF…`) and PK-01 pins were realigned in `0c6adc2` and pass.
- Frontend `voice-fixtures.test.ts` (`bargeInSpeechWindows: 10` in the user's uncommitted `backend/src/contracts/voice-wire.ts` but not in `frontend/src/api/voice-protocol.ts`) — caused by preserved unrelated user work, untouched by this workflow.

## Limitations

- **Native MongoDB not certified.** `AURVIN_TEST_MONGODB_URI` was unavailable; native `nativeIt` blocks were skipped (NOT-RUN, not passed). The deterministic fallback (`1cb7b0e`) supplies unconditional E2E evidence for 160-turn ceiling lift, O(tail) hydration, 320-message scrollback, KV-byte parity, Calendar tombstoning, and crash-window archive ordering, but this is not native topology or provider certification.
- **No live provider, Google, OpenRouter, or LiveKit calls** and no paid evaluations were made. Deterministic fixtures only.
- **No wall-clock latency SLA** is certified; profiling tests use synthetic/frozen clocks.
- **Unified code review was skipped**, not passed, per instruction.
- Product copy in `product_knowledge.md` was trimmed to fit the context-token budget; required compaction phrases are present, and eval pins were realigned accordingly.

## Key Artifacts

- Goal: `docs/context-compaction-memory/goal.md`
- State & DAG: `docs/context-compaction-memory/state.md`
- Research: `docs/context-compaction-memory/research.md`
- Plans: `docs/context-compaction-memory/plan1.md` … `plan5.md`
- Review: skipped (`--skip review`)
- Integrated E2E: `backend/test/integration/compaction.native.e2e-spec.ts`
- This report: `docs/context-compaction-memory/final_report.md`
