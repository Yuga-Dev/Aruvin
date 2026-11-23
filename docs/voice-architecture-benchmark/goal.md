# Three-harness live voice benchmark

## Approval and scope

On 16 November 2026 the user requested three separate latency/performance harnesses using the existing LiveKit, OpenRouter and Deepgram credentials. They selected **Build + bounded live pilot** and added: **“Live test but please make it low cost.”**

This specification narrows the selected maximum envelope to **US$2 conservatively estimated spend, 18 total user-turn submissions, and 15 minutes aggregate paid-active time**. Unused room in the earlier approval is not a reason to expand this pilot.

**Written-spec gate:** approved by the user on 16 November 2026 (`goal_status: approved`). Existing unified-review instruction: **skipped**, never passed.

## Goal

Build three independently runnable harnesses and perform an inexpensive, bounded screening comparison of:

1. **Aurvin baseline:** current production custom voice orchestration with LiveKit/WebRTC transport and direct Flux STT/TTS.
2. **LiveKit Agents:** actual Agents framework, Flux STT, Silero interruption detection, the same OpenRouter model, and Flux TTS.
3. **Deepgram Voice Agent:** actual managed Voice Agent API with Flux STT/TTS and the same OpenRouter model through its supported BYO LLM integration.

Do not substitute a hand-written simulation for a framework or managed service. Preserve a blocked candidate rather than silently changing its model, speech family, topology, safety policy or identity attribution.

## Deliverables and architecture

- An isolated npm package under `benchmarks/voice-architectures/` that **does not interfere with the actual project in any way**: zero edits to `backend/`, `frontend/`, root `package.json`/workspaces, or production database/configuration.
- Inside `benchmarks/voice-architectures/`:
  - `shared/`: shared contracts, `.env` credential importer/redactor, synthetic audio corpus, monotonic measurement helpers, and finite cost/turn/time guards.
  - `aurvin/`: Aurvin baseline harness, deterministic tests, and `benchmarks/voice-architectures/aurvin/report.md`.
  - `livekit-agents/`: LiveKit Agents harness, deterministic tests, and `benchmarks/voice-architectures/livekit-agents/report.md`.
  - `deepgram-agent/`: Deepgram Voice Agent harness, deterministic tests, and `benchmarks/voice-architectures/deepgram-agent/report.md`.
  - `report.md` (`benchmarks/voice-architectures/report.md`): compiled main benchmark report aggregating all three per-architecture reports, raw/summary evidence, costs/unknowns, limitations, and the qualified verdict.
- Independently runnable `aurvin`, `livekit-agents`, and `deepgram-agent` commands, plus a sequential comparison and report-compilation command.
- Read-only reuse of existing backend voice/config contracts where helpful without copying or editing `backend/` or rebuilding the production voice stack.
- Default operation is offline validation/dry-run. Live mode requires an explicit, fresh authorization envelope and finite guards.
- Per-architecture `report.md` files and compiled `benchmarks/voice-architectures/report.md` (plus machine-readable JSON artifacts) containing every attempted turn, capability/compatibility outcomes, observed configuration, costs/unknown costs, and a qualified verdict.
- Documentation for setup, commands, credential import, prerequisites, interpretation, failure/cleanup behavior and a future browser-audible evaluation.

This is standalone benchmark tooling, not an Aurvin provider migration. Application code, manifests, `.env` files, and production configuration remain untouched.

## Credentials and infrastructure

- Existing `.env` credentials (such as `backend/.env`, an explicit env file path, or server process environment) may be imported read-only at runtime. Reuse existing server-side decryption only if a required provider key is stored encrypted in DB admin config rather than in `.env`. Do not print, return to chat, copy/commit into benchmark files or reports, or embed secrets in browser bundles.
- Application files, `.env`, and production configuration are strictly read-only. Read only the provider/model/voice/identity/bootstrap information required for this task, not private chats or calendars.
- Validate configuration offline before connecting. Do not use paid health probes.
- Separate credential presence from capability: a configured Deepgram key may not admit Voice Agent; a configured model may not work through the selected plugin.
- Use dedicated, uniquely named benchmark rooms on the existing LiveKit service. No service deployment, public listener, tunnel, firewall/TURN change or paid infrastructure provisioning.
- The Aurvin baseline must use a fresh isolated benchmark database if it starts an executor. Never start a second executor against the application database. No broad database cleanup or deletion of preexisting rooms/data.
- Cleanup only resources created by this run, using supported lifecycle operations. Preserve generated database/evidence identifiers for audit; do not delete retained evidence to rerun.
- If a required secret is unavailable, ask with the private secret tool; never ask for it in ordinary chat.

## Comparability and fidelity

### Shared conditions

- Same selected OpenRouter model and speech voice, region and audio corpus where supported.
- Same finite context/output ceilings and logically equivalent synthetic prompt/history. Capture effective settings and unavoidable differences.
- Use a fixed small corpus of nonprivate synthetic speech, generated offline where existing tooling supports it.
- Preserve real-time input pacing, the exact input hash, sample format and known speech-end marker.
- Run one candidate/session at a time to avoid benchmark-generated contention. Do not load-test production infrastructure.
- No Calendar, web search, MCP or other external tools; no private user audio or message history.
- No automatic paid retries or model fallback; disable speculative generation for the matched pilot where supported. Record and block unsupported controls instead of claiming equivalence.
- Do not silently change production settings to achieve matching. Benchmark-only snapshot overrides must be explicit in provenance and never persisted to production configuration.

### What the result means

The Aurvin candidate includes real application admission/context/history/safety work. The other two are real framework/managed implementations with matched conversational inputs, not complete Aurvin ports. This is a **full-stack screening comparison**, not a claim to isolate framework overhead or certify tool/history parity.

Never claim model, voice, context, detection or routing equality based solely on the requested settings. Record observed values where available; leave unobservable fields unknown.

### Required compatibility research

Research must resolve before committing implementation plans:

- Exact Node/Windows/RTC/Agents/Silero/Flux-STT/Flux-TTS plugin compatibility and package versions.
- Correct interruption behavior and heard-history limitations of the chosen framework release.
- Deepgram Voice Agent BYO OpenRouter support, regional endpoint, key entitlement, finite generation controls, data/routing requirements and per-attempt `user` attribution.
- Whether native managed inference controls can enforce the authorization envelope without an application-side proxy.
- Actual current pricing units, including managed session duration, BYO LLM requests, speech and LiveKit media/room costs.

No public proxy/tunnel may be added to work around a BYO limitation. If direct managed inference cannot satisfy attribution, privacy/routing or bounded-cost requirements with existing capabilities, implement an explicit blocked preflight for that candidate and request a separate decision. Do not silently waive a repository safety requirement or use a Deepgram-managed LLM as a substitute.

## Measurement boundaries

### Required pilot observations

- Session setup, excluding offline dependency/model preparation and separately identifying provider/media connection stages where observable.
- Synthetic input speech-end marker to first **decoded non-silent** response audio at the harness consumer.
- First-turn versus warm-follow-up timing, clearly separated.
- Interruption marker to decoded output cutoff, including a fixed stale-tail observation interval; missing output is not automatically a successful interruption.
- Streaming gap/stall observations and response completion/failure/timeout counts.
- Model first usable output and TTS first audio where genuinely observable; managed unexposed stages remain null.
- Input pacing error, queue occupancy where available, CPU/event-loop observations if reusable without disproportionate tooling, and resource cleanup outcomes.

Use one monotonic clock for each end-to-end interval. Do not subtract unrelated process clocks or add overlapping spans.

### Playback proof and accuracy

- Decoded receipt is **not physical audibility**. This initial pilot does not certify device latency, microphone performance or browser acoustic interruption.
- Never fabricate production `playback.progress`, durable completion, or heard-prefix evidence.
- If the headless baseline cannot complete under the real playback-proof contract, retain its onset measurement and explicitly incomplete delivery. Do not patch production solely to make the benchmark green or include it in a successful-completion ranking.
- Prefer separate onset/completion/behavior comparison tables so unlike completion contracts cannot create a false winner.
- Score only explicitly verifiable synthetic outcomes. Fast filler/acknowledgment is not proof of a useful answer; unknown semantic quality remains unknown.
- An interruption scenario must establish that assistant output began, inject the documented interrupting fixture, and observe cutoff/stale tail independently of provider cancellation events.

### Reporting

- Keep cold setup, warm follow-up, interruption and scenario groups separate.
- Report counts, median/range and raw per-attempt numeric outcomes. Any small-sample p95 is exploratory, not a stable percentile or SLA. No p99/capacity claim.
- Keep failures, blocked candidates, unknown usage, missing proof and cleanup uncertainty visible.
- Clearly separate deterministic fixture checks, live provider observations and unrun browser/native-service claims.

## Low-cost live envelope

- **Spend:** at most **US$2 conservatively estimated aggregate** model, speech/managed-agent and LiveKit usage. Application-side reservations are not a guaranteed invoice cap; no claim of provider-enforced billing prevention.
- **Turns:** at most **18 total user-turn submissions**, including warm-ups, failed/cancelled submissions and interrupted user inputs. No uncounted automatic greeting/inference or retry.
- **Per candidate:** up to **six input turns**: one excluded warm-up and five screening inputs covering an ordinary reply, warm follow-up, hesitation, long-enough output to interrupt, and the interrupting input. A capability/preflight failure does not authorize reallocating its allowance without a recorded decision.
- **Time:** at most **15 minutes aggregate paid-active lifetime**, with bounded per-session/turn deadlines and finite shutdown/cleanup.
- **Concurrency:** one live candidate/session at a time.
- **Model attempts:** no hidden retries or fallbacks. Research must bound actual managed/framework attempts before live admission; additional internal requests count against a shared dispatch ceiling and dollar reservation.
- **Audio/text:** finite total input-audio, submitted TTS-text and generated-output/context budgets, selected and verified by the shared safety owner against current prices before live mode can admit work.
- **Stop conditions:** exceeded/uncertain reservation, expired authorization, changed source/configuration/model, missing rate/usage bound, unsupported controls, unrecoverable connection or redaction failure.
- Do not exhaust the budget merely to use it. Stop after useful screening evidence or an established incompatibility; no repeat pilot without fresh approval.

The one warm-up plus five varied inputs is intentionally too small for a reliable latency distribution or broad quality assessment. Report that limitation prominently.

## Verification and acceptance

1. All three entry points exist and identify the actual candidate; offline tests prove routing, event parsing, timing definitions, boundary labels and independent selection.
2. Shared tests prove default no-network behavior, secret redaction, credential/config read-only behavior, unique output/resource ownership, finite budgets, no implicit retries, monotonic measurement and cleanup.
3. Candidate-specific fixtures cover start/end-of-turn, audio before/after cancellation, stale events, partial/late failure, early close, timeout and unobservable metrics.
4. The framework package is genuinely installed/version-locked and a deterministic test verifies the configured STT/VAD/LLM/TTS choices, rather than using a custom-loop stand-in.
5. Build/lint/test commands appropriate to the isolated `benchmarks/voice-architectures/` package pass. Zero edits are made to `backend/`, `frontend/`, or root workspace files; run read-only backend checks only if needed to confirm no baseline interference.
6. Live preflight runs before any paid transmission. Each candidate produces either a bounded live observation or an explicit blocked/failed record with reason, plus its own `report.md` inside its architecture subfolder.
7. Results never portray decoded output, fixtures, a provider terminal event or a zero exit status as proven audible delivery.
8. Compiled `benchmarks/voice-architectures/report.md` (with verdict) and workflow `final_report.md` record exact commits/source/build hashes, environment, settings/version identities, actual checks, actual calls/costs/unknowns, outcomes and remaining limitations.
9. No production migration, public deployment, broad data change, review pass or provider SLA is implied.

## Workflow and ownership

Use MAW with:
- **1 Researcher (`R`)**: investigates compatibility, `.env` credential import seams, package versions, pricing/budgets, and shared folder contracts.
- **3 Architecture Planners (`P1`–`P3`)**: one planner per architecture (`P1` Aurvin baseline + shared scaffold/runner/compiler in `benchmarks/voice-architectures/shared/`, `P2` LiveKit Agents, `P3` Deepgram Voice Agent), with corresponding implementation workers.
- **1 Benchmark Execution & Report Worker** (during Final Verification, with no separate planner): executes offline verification and the bounded sequential live pilot, generates each architecture's `report.md`, and compiles `benchmarks/voice-architectures/report.md` with the verdict plus `docs/voice-architecture-benchmark/final_report.md`.
- **Unified code review: skipped (`--skip review`)**. Tests, defect correction, and final verification remain required.

At most three child agents run concurrently alongside the orchestrator. The orchestrator manages dependencies and serializes shared-index commits; it does not implement source or ingest researcher/planner artifacts for execution management. Proposed execution units and ownership are in [state.md](state.md). Any required scope/safety exception returns to the user before implementation or live execution.
