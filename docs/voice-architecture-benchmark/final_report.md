# Final Report: voice-architecture-benchmark

## Executive Summary

The **three-harness voice architecture benchmark** has been designed, implemented, verified offline, and executed in an authorized bounded live sequential pilot (`runId: 854c24ce-bb4a-4598-94d4-7fae2535c268`, commit `4313cb354138985bc39f180e2ad33478f13b504f`) in strict isolation under `benchmarks/voice-architectures/`. Zero files were modified in `backend/`, `frontend/`, root manifests (`package.json`, `package-lock.json`), `.env`, or production databases (`backend/dist/` was rebuilt via `npm run build` with zero source edits).

All three candidate architectures exist in dedicated subdirectories with their own published `report.md` files, and an overarching `benchmarks/voice-architectures/report.md` compiles all three into a single qualified screening verdict (`--waive-deepgram-byo` applied strictly for this US$2 pilot by explicit user waiver on 16 November 2026):
1. **Aurvin Baseline (`benchmarks/voice-architectures/aurvin/`):** Invokes real `AppService.create` from `backend/dist/app.service.js` against an isolated MongoDB database, enforcing `backend/dist` freshness checks, read-only configuration, fail-closed secret redaction, and genuine playback-proof handling (`BENCHMARK_UNPROVEN_PLAYBACK` / `VOICE_DELIVERY_UNKNOWN` recovered across sessions without fabricating audibility). In live run `854c24ce`: 6/6 turns submitted, 0 failed/timeout turns, 4 explicit recoveries, `cleanup.complete: true`.
2. **LiveKit Agents (`benchmarks/voice-architectures/livekit-agents/`):** Real LiveKit Agents 1.10.0 implementation on Node 24 (`win32-x64`) with native Silero VAD (`onnxruntime-node@1.24.3`), Deepgram STTv2/TTSv2 plugins via loopback `BudgetGuard.sockets` relay (`speech-proxy.ts`), and a guarded OpenRouter client enforcing user attribution, ZDR/no-fallback routing, disabled plugins, finite token limits, and `maxRetry: 0`. In live run `854c24ce`: 4 turns submitted (`completed` Turns 0–2, `failed` Turn 3 `hesitation-pause` with `AGENTS_PROVIDER_ERROR` after a second LLM attempt on the 800 ms pause hit the per-turn `BudgetGuard` limit; Turns 4–5 unreached; `cleanup.complete: true`).
3. **Deepgram Voice Agent v1 (`benchmarks/voice-architectures/deepgram-agent/`):** Real Voice Agent v1 WebSocket protocol implementation (`Flux` STT + BYO OpenRouter + `Flux` TTS) with PCM onset and conservative stale-tail measurements. Fails closed on BYO controls by default (`BLOCKED_BYO_CONTROLS_UNSUPPORTED`); executed live under the explicit user pilot waiver (`--waive-deepgram-byo`). In live run `854c24ce`: 6 turns submitted (`completed` Turns 0–4 including `hesitation-pause`, `failed` Turn 5 `barge-in-interrupt` with `INTERRUPTION_ANCHOR_MISSING`; `cleanup.complete: true`).

## Workflow Configuration

- **Workflow Engine:** MAW (`maw`)
- **Skipped Phases:** `[review]` (Unified code review skipped by explicit user instruction; recorded as skipped, never passed)
- **Agent Topology:** 1 Researcher (`R`), 3 Architecture Planners (`P1`–`P3`), 3 Implementation Workers (`P1`–`P3`), 1 Execution & Verification Worker (`V1`)
- **Isolation Boundary:** 100% confined to `benchmarks/voice-architectures/`; zero project interference

## Plan Breakdown & Execution Record

| Plan ID | Title & Scope | Commits | Status |
| :--- | :--- | :--- | :--- |
| **Research (R)** | Technical compatibility research | `7a40c2a` | Completed |
| **Plan 1 (P1)** | Shared scaffold, runner, report compiler & Aurvin baseline | `e0e80af` (plan)<br>`1e51331`…`9a1a335` (12 worker commits) | Completed |
| **Plan 2 (P2)** | LiveKit Agents/Flux/Silero harness & report formatter | `f4f8115` (plan)<br>`dd40398` (worker commit) | Completed |
| **Plan 3 (P3)** | Deepgram Voice Agent v1 harness & fail-closed preflight | `4e1d590` (plan)<br>`e8cd1a8` (worker commit) | Completed |
| **Verification (V1) & Live Pilot** | Offline checks, live-enablement fixes, authorized live pilot (`854c24ce`) & compiled reports | `d73e97f`, `832879e`…`4313cb3` (pilot fixes), plus report publication commit | Completed (Live) |

## Verification & Quality Assurance

- **Automated Tests (`vitest run` in `benchmarks/voice-architectures/`):** 23 test files passed, 140 tests passed (0 failed, 0 skipped) covering all three candidates, native WebRTC participant, `BudgetGuard` per-turn isolation, credentials/redaction, timing/dither, corpus, compiler, and CLI.
- **Type Checking (`npm run lint`):** Passed (`tsc --noEmit -p tsconfig.json`, 0 errors).
- **Package Build (`npm run build`):** Passed (`tsc -p tsconfig.json`, 0 errors).
- **Offline Default Fail-Closed Checks:**
  - `npm run bench:aurvin`, `npm run bench:livekit-agents`, `npm run bench:deepgram-agent`, and `npm run bench` default to dry-run and fail closed with 0 submitted turns and US$0 spent (`deepgram-agent` remains `BLOCKED_BYO_CONTROLS_UNSUPPORTED` without explicit `--waive-deepgram-byo`).
- **Authorized Live Sequential Pilot (`runId: 854c24ce-bb4a-4598-94d4-7fae2535c268`, commit `4313cb3`):**
  - Command: `npm run bench -- --live --authorization=results/auth-live-pilot.json --waive-deepgram-byo --publish-reports` (exited 0).
  - Aggregate ledger: `submittedTurns: 16`, `modelDispatches: 10`, `activeMs: 357033.0459` (< 900000 ms), `sttAudioMs: 157180`, `ttsInputBytes: 1557`, `conservativeReserveUsd: 1.359666` (<= US$2), `denied: null`.
  - Provider/media/speech invoice exact USD totals remain explicitly `null` (`unknown` is not zero) where upstream APIs do not emit per-turn billing.
  - All three candidate cleanups completed (`cleanup.complete: true`, `openSockets: 0`).
- **Project Isolation:** Zero edits to `backend/`, `frontend/`, root `package.json`, root `package-lock.json`, `.env`, production databases, or preexisting `docs/voice-latency-benchmark/*` files.

## Benchmark Reports & Verdict

Published live reports (`runId: 854c24ce-bb4a-4598-94d4-7fae2535c268`):
1. [aurvin/report.md](../../benchmarks/voice-architectures/aurvin/report.md) (JSON SHA-256 `4ad3fddaaa179e4a9c8d36a3893c4c06c69b1609a8ff457dd9635259869796a8`): Cold/warmup `setupMs` `2200.54 ms`, cold onset `4850.14 ms`; non-warmup recovered-session onset median `3847.20 ms` (`n=5`, range `3487.35–3970.37 ms`); interruption cutoff `1009.94 ms` with `1000 ms` zero-frame stale tail (`0` nonzero frames); `0` stream gaps (`maxStreamGapMs: 11.51–28.96 ms`); `BENCHMARK_UNPROVEN_PLAYBACK` preserved across all 6 turns.
2. [livekit-agents/report.md](../../benchmarks/voice-architectures/livekit-agents/report.md) (JSON SHA-256 `5977cadc11fa288ac6f532fe7f6f2565eb43ecc9b05b295e498e4d6d37008bee`): Cold/warmup `setupMs` `2716.53 ms`, cold onset `4326.99 ms` (`modelFirstOutputMs: 788 ms`, `ttsFirstAudioMs: 524 ms`); warm-session onset median `4870.32 ms` (`n=2`, range `4805.25–4935.39 ms`); `0` stream gaps; Turn 3 (`hesitation-pause`) failed (`AGENTS_PROVIDER_ERROR`) when Flux EOT split the 800 ms pause into a second OpenRouter attempt blocked by `BudgetGuard`.
3. [deepgram-agent/report.md](../../benchmarks/voice-architectures/deepgram-agent/report.md) (JSON SHA-256 `422db96a768c0195f815df1ab067f55c108a1d46e8607c90caccd82943d67e2f`): Cold/warmup `setupMs` `1541.79 ms`, cold onset `2840.86 ms`; warm-session onset median `2169.97 ms` (`n=4`, range `2024.13–2501.12 ms`, including single-response Turn 3 `hesitation-pause`); stream gaps observed on Turns 0–3 (`maxStreamGapMs: 96.05–237.88 ms`); Turn 5 (`barge-in-interrupt`) failed `INTERRUPTION_ANCHOR_MISSING` (`interruptionAnchorObserved: false`). Internal model/TTS timings and OpenRouter tokens/attribution remain `null`/`false` (BYO controls waived for pilot only).
4. [report.md](../../benchmarks/voice-architectures/report.md): Compiled verdict and comparison tables.

### Verdict Summary
- **No successful-completion winner is established by decoded headless output:** Decoded 24 kHz non-silent PCM receipt at a headless consumer does not establish physical speaker audibility or browser playback proof.
- **Retain Aurvin as the application baseline:** Custom orchestration maintains real application admission, attribution, ZDR/no-fallback routing, token/retry controls, and observed `1009.94 ms` interruption cutoff with `0` stream gaps.
- **LiveKit Agents (`--skip review` screening signal):** Matched safety/attribution controls via custom OpenRouter client + loopback speech proxy, but split Turn 3 (`hesitation-pause`) under `turnDetection: 'stt'` with `minDelay: 0` and did not reach interruption Turns 4–5 in this pilot.
- **Deepgram Voice Agent (`--waive-deepgram-byo` pilot-only screening signal):** Fastest observed headless warm onset (`2169.97 ms` median vs `3847.20 ms` recovered Aurvin / `4870.32 ms` LiveKit Agents), though with chunk gaps (`96.05–237.88 ms`), missing Turn 4–5 interruption anchor (`INTERRUPTION_ANCHOR_MISSING`), and unwaivable production gaps in BYO `user` attribution, ZDR/fallback routing, output token caps, and zero-retry accounting.
- **Budget & Review Status:** Aggregate run stayed inside the US$2 / 18-turn / 15-minute envelope (`conservativeReserveUsd: 1.359666`, `16` submitted turns, `357.03 s` active, `denied: null`). Unified code review remains **skipped** per instruction.

## Key Artifacts

- **Goal Specification:** [docs/voice-architecture-benchmark/goal.md](../../docs/voice-architecture-benchmark/goal.md)
- **Workflow State & Dependency Matrix:** [docs/voice-architecture-benchmark/state.md](../../docs/voice-architecture-benchmark/state.md)
- **Technical Research:** [docs/voice-architecture-benchmark/research.md](../../docs/voice-architecture-benchmark/research.md)
- **Implementation Plans:**
  - [plan1.md](../../docs/voice-architecture-benchmark/plan1.md) (Shared scaffold & Aurvin baseline)
  - [plan2.md](../../docs/voice-architecture-benchmark/plan2.md) (LiveKit Agents harness)
  - [plan3.md](../../docs/voice-architecture-benchmark/plan3.md) (Deepgram Voice Agent harness)
- **Isolated Package Root:** [benchmarks/voice-architectures/](../../benchmarks/voice-architectures/)
- **Compiled Verdict Report:** [benchmarks/voice-architectures/report.md](../../benchmarks/voice-architectures/report.md)
