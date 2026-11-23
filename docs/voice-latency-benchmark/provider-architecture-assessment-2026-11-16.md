# Aurvin live voice: provider and architecture assessment

**Research date:** 16 November 2026. **Repository inspected:** `c50017b` on `main`.
**Scope:** documentation research, published-package inspection, existing measurement evidence, and current source tracing. No implementation, configuration change, paid inference, live connection, infrastructure provisioning, or new performance measurement.

## Executive decision

**There is no defensible universal winner among Deepgram Voice Agent, LiveKit Agents, and a custom pipeline. For Aurvin, the lead alternative to evaluate is LiveKit Agents with separate interruption and turn-end detection; Deepgram Voice Agent is the managed comparator. Keep the current custom pipeline as the baseline, not the presumed winner.**

My earlier advice that the custom approach offers the most control was correct, but that is not evidence it is the best choice for reliable performance. A framework or managed service could be a better engineering choice if it removes application-owned scheduling, cancellation, and playback defects. Conversely, moving the same slow backend/model into a new wrapper can preserve the delay.

Recommended evaluation order:

1. Establish the **current** Aurvin audible baseline and identify its slow stages.
2. Compare a matched LiveKit Agents cascade, initially with the same speech and LLM choices where supported, using VAD for interruptions and one explicit end-of-turn authority.
3. Compare Deepgram Voice Agent with matched models/settings where possible, then separately with its latency-oriented managed configuration.
4. Include **OpenAI Realtime** as a native-audio challenger if changing the conversational model is acceptable. Evaluate Gemini Live and ElevenLabs Agents if the initial candidates miss the targets or their language/voice capabilities are important.
5. Change individual STT/TTS providers only when stage measurements or quality results justify it. Cartesia and ElevenLabs are credible TTS candidates; AssemblyAI is a credible STT/turn-detection candidate. None is a measured winner for Aurvin.

This is a research recommendation, **not an approved migration plan or permission for paid experiments**.

## 1. Separate the things being compared

The original three-way comparison mixes independently selectable layers:

| Layer | Choices | What it can affect |
| --- | --- | --- |
| Browser/media transport | LiveKit/WebRTC, a direct provider WebRTC connection, application/provider WebSockets | Capture/upload, jitter/loss behavior, playback buffers, reconnection |
| Voice orchestration | Aurvin custom code, LiveKit Agents, Pipecat, Deepgram Voice Agent, ElevenLabs Agents | Scheduling, turn policy, cancellation, text aggregation, state synchronization |
| Speech/model providers | Deepgram, AssemblyAI, Cartesia, ElevenLabs, OpenAI, Google, etc. | Recognition quality, endpointing, model first output, synthesis and capacity |
| Deployment | Device, backend, media SFU, model regions, process capacity and service tier | Network distance, cold starts, contention and tail latency |

**LiveKit is not an alternative STT engine. Silero is not a faster LLM or TTS engine.** Using LiveKit media alone does not enable the Agents framework's turn-management features. A framework can call Deepgram directly through a plugin or through LiveKit Inference; those are different routing, billing, and operational arrangements. [S5–S9]

### Four separate user experiences

- **Response onset:** last actual user speech → first audible, useful assistant answer.
- **Interruption stop:** actual interrupting speech onset → assistant audio stops and stays stopped.
- **Streaming continuity:** gaps/stalls after audio starts, underruns and stale audio after cancellation.
- **Session reliability:** startup, long conversations, reconnects, correct heard-history, and safe tools.

A short acknowledgment or filler is not the substantive answer. Report its latency separately. Fast synthesis does not establish any of the four experiences above.

For a non-speculative cascade, response onset is roughly input delivery/turn detection + application admission/context + LLM first usable output + text release + TTS first audio + output delivery/playback. Stages can overlap, especially with speculation. **Do not add separately calculated stage percentiles.**

## 2. What Aurvin actually does

The production browser composition constructs `LiveKitVoiceClient`, rather than the legacy PCM WebSocket client. The backend uses RTC/media SDKs but does not depend on `@livekit/agents`. It connects directly to Flux STT `/v2/listen` and Flux TTS `/v2/speak`.

Relevant source:

- [Production hook](../../frontend/src/features/voice/state/useLiveVoice.ts), especially lines 58–60.
- [LiveKit browser client](../../frontend/src/api/livekit-voice-client.ts), including microphone constraints at lines 84–85 and playback cancellation at lines 561–569.
- [Backend dependencies](../../backend/package.json).
- [Flux STT](../../backend/src/voice/providers/flux-stt.ts), lines 79–88 and 105–108.
- [Turn orchestration](../../backend/src/voice/session/live-flow.ts), lines 511–560 and 573–597.
- [Flux TTS interruption](../../backend/src/voice/providers/flux-tts.ts), lines 183–196.

Current behavior and implications:

1. **Flux `StartOfTurn` triggers interruption.** Aurvin invalidates media, cancels application work, and explicitly interrupts TTS with a playback position when valid. This signal travels through the provider path; it is not a browser-local speech-onset mute.
2. **Only confirmed `EndOfTurn` dispatches ordinary conversational work.** The STT adapter deliberately does not authorize execution from `EagerEndOfTurn` or `TurnResumed`. Speculative replies are therefore a genuine alternative to evaluate, not an optimization already enabled here.
3. **STT and TTS connect in parallel** when a live flow opens and are reused within the flow. “Keep connections warm” is not a missing implementation by itself. First-session setup, subsequent turns and reset/recovery must be measured separately.
4. **The input bridge requests 80 ms decoded frames.** That is not proof of 80 ms RTP packets, nor evidence that arbitrarily reducing frames improves Flux. The application also has a simple quiet-upload gate with bounded pre-roll.
5. The repository contains an **embedded WebRTC VAD in the legacy capture path**. Its existence does not mean the current native-microphone LiveKit composition uses it for barge-in. There is no production browser speech-onset-to-speaker-mute path identified in the inspected composition.
6. The output queue is bounded and drains as frames arrive. A 2,000 ms queue **capacity** does not mean a mandatory two-second startup delay. Measure actual queue occupancy.
7. Current runtime source has memory-first live admission/status routes as well as durable recovery/fallback routes. An asynchronous method name or a historical database wait is not proof of a current pre-model storage delay.

Additional source: [input bridge](../../backend/src/voice/transport/livekit-media.ts), [quiet gate](../../backend/src/voice/transport/livekit-input.ts), [output queue](../../backend/src/voice/transport/livekit-output.ts), [legacy capture VAD](../../frontend/src/features/voice/audio/audio-capture-vad.ts), [runtime memory/durable branches](../../backend/src/chat-runtime/durable-chat-runtime.ts), [existing stage telemetry](../../backend/src/voice/usage/voice-usage.service.ts).

### Existing measured evidence — historical, not today's baseline

**5 November, old WebSocket path:** seven measured successful turns after one excluded warm-up. Speech-end → first PCM receipt p50 **7.801 s**; exploratory p95 **17.696 s**. With seven samples, that p95 is the maximum, not a stable tail estimate. Reported stage medians included:

| Historical server span | Median |
| --- | ---: |
| STT end-of-turn → response prepared | 3.144 s |
| Model dispatch → first meaningful output | 1.502 s |
| First model output → first TTS submission | 0.188 s |
| First TTS submission → first synthesized PCM | 0.483 s |

**8 November, WebRTC path:** one full-input observation reached decoded nonzero response audio at **8.251 s** after the synthetic speech-end marker. Same-server-clock disjoint spans included **3.484 s** from STT EOT to preparation, **0.248 s** preparation to model dispatch, **2.254 s** dispatch to first model text, **0.019 s** text to `Speak`, and **0.488 s** `Speak` to first server PCM.

That headless attempt ended with `VOICE_DELIVERY_UNKNOWN`, because it did not supply valid played-audio evidence; it is **not** a successful proven-playback conversation or proof that an actual browser failed. Two preceding runner compatibility/pacing failures are retained separately.

Sources: [5 November report](websocket-live-baseline-2026-11-05.md), [8 November results](../performance/live-text-voice-results-2026-11-08.md), [same-clock analysis](../performance/live-latency-followup-2026-11-08.md).

**What these observations support:** there was significant application/model-path latency; it was not all synthesis or browser transport.

**What they do not support:** blaming Deepgram alone, predicting current performance, claiming WebRTC improved/worsened latency, adding medians into a total, or treating PCM receipt as audible playback. A [later memory-first implementation record](../performance/calendar-memory-first-implementation-2026-11-08.md) and current source show changes after those runs. The older [transport comparison](../live-voice-webrtc/comparison.md) also predates the later headless observation; neither supplies a matched audible comparison.

## 3. Architecture findings

### A. Deepgram Voice Agent: a serious managed candidate

**Advantages**

- One application-facing WebSocket for STT, conversational orchestration and TTS.
- Managed turn handling, response cancellation and speculative reply coordination.
- Current documentation supports Flux STT, Flux TTS, managed/external LLMs and external functions. Flux TTS requires the appropriate `v2` provider version; do not silently compare Aura and Flux. [S1–S4]
- Eliminates some application-mediated speech handoffs and real-time orchestration code.

**Limits and migration costs**

- **The client must still stop playback and clear buffered audio** on `UserStartedSpeaking`. The original “Deepgram manages everything” description is too broad. It cannot retract audio already buffered at the browser/device. [S1]
- One API does not mean every LLM runs in the same process or region. External models and Aurvin tools retain network and execution latency. [S3, S15]
- Preserving Aurvin's canonical context, trusted identity, tool authorization, mutation barriers, idempotency, accounting, heard-versus-generated distinction and cross-mode history requires an integration design. A URL swap is insufficient.
- Wrapping Aurvin's full existing agent loop behind a managed “think” endpoint may retain its waits. Accidentally running both agents' reasoning loops can add latency and conflicting state.
- Managed speculation can make a default comparison faster for reasons other than network consolidation.

**Important safety finding:** Deepgram documents function calls dispatching within the speculative window by default. Irreversible functions need `defer_until_eot: true` **and** Aurvin's independent authorization/durable pre-effect safeguards. Cancellation cannot undo an already executed Calendar create. [S4]

**Verdict:** strong candidate if transferring ownership of the conversational loop is acceptable. No matched evidence establishes it as the fastest or most consistent for Aurvin.

### B. LiveKit Agents + Flux + Silero: lead framework candidate

**Advantages**

- Separates media/session management from replaceable STT, LLM and TTS components.
- Supports STT-based turn endings with Flux and VAD-driven interruption detection.
- Provides preemptive generation, interruption handling, false-interruption recovery and stage metrics rather than requiring all of that in Aurvin's media loop. [S5–S8]
- Has a Node.js implementation, fitting Aurvin's TypeScript stack better than introducing a Python voice server solely to obtain a framework.

**Configuration traps**

- Merely adding Silero does not ensure instant interruption. The current documented framework interruption minimum duration is **0.5 s** by default. VAD classification onset and the policy threshold are separate.
- In STT mode, framework `min_delay` is **additional to the STT endpoint signal**. Inspect and explicitly test the effective setting rather than accidentally stacking endpoint waits.
- Choose one end-of-turn authority: Flux STT or a framework detector. Do not assume layering every detector improves latency.
- Adaptive interruption handling distinguishes intentional interruption from “yeah/uh-huh” backchannels. It is an additional inference dependency, not the same thing as local Silero. Its fallback can change interruption behavior.
- Self-hosted agents using LiveKit media are not automatically hosted near LiveKit Inference or speech providers. Inference and direct-provider plugins need separate regional and billing decisions. [S9]

**Concrete SDK compatibility finding:** the LiveKit TTS guide marked direct Flux TTS as Python-only when fetched, while the Node reference and published `@livekit/agents-plugin-deepgram@1.10.0` artifact contain `TTSv2`. Public artifact inspection confirmed `/v2/speak` support. However, the inspected `tts_v2.js` contained no `Interrupt` command or `playback_offset`. That is **not proof that framework cancellation fails**, but it is also not evidence of parity with Aurvin's provider-side spoken-text reconciliation. Verify the exact installed release, cancellation path, cross-turn behavior, and heard-history contract before migration. [S7, S10]

**Verdict:** best first framework experiment for Aurvin's maintainability and provider flexibility; **not a measured latency winner**. Compare VAD-only interruption with adaptive handling, and eager generation off/on as separate configurations.

### C. Aurvin custom pipeline + VAD: viable, but ownership remains ours

Adding an earlier speech-onset detector can remove the wait for the remote STT interruption signal. It does **not** remove LLM TTFT, delayed turn acceptance, slow tools or TTS buffering.

Placement matters:

- **Provider VAD:** must receive audio and send a signal back.
- **Agent/backend-local Silero:** avoids waiting for the separate STT provider round trip, but still follows microphone upload to the backend and media delivery back to the browser.
- **Browser-local VAD:** can provisionally duck/mute the local speaker without that network round trip, but introduces client CPU/lifecycle work and false-positive/echo handling.

“Local” in a framework document usually means the **agent process**, not the browser. A quoted 100–150 ms saving is not a fixed property of VAD. Actual savings depend on placement, network, frame cadence, minimum speech duration, policy and output buffering. [S6, S8]

A browser-local provisional mute is distinct from a confirmed backend interruption: preserve playback position, reject stale audio, decide whether a false onset resumes or cancels, and reconcile generated-versus-heard content. Browser echo cancellation/noise suppression requests help but do not prove device behavior.

**Verdict:** retain as the measured baseline and potentially the eventual winner. Do not add a second voice-state machine or VAD dependency until the specific deficiency is measured.

### D. Pipecat and telephony frameworks

Pipecat is credible, but it is not “the same LiveKit configuration in Python.” Its current Flux service requests external turn-management strategies; VAD is optional, and adding it does not by itself guarantee it takes ownership of interruptions. Eager mode is separately supported. [S11]

It also documents a reliability nuance: during Flux reconnect, arriving audio is not transcribed; an in-progress turn ends with the transcript received so far. That is a failure/recovery behavior to test, not merely a socket-health metric.

**For Aurvin:** consider Pipecat when its processing graph/provider integrations supply a concrete advantage that warrants another server runtime. Twilio ConversationRelay is a telephony-oriented option, not the lead candidate for the current browser/WebRTC product. No performance ranking for either follows from its inclusion in the original framework category.

## 4. Alternatives to Deepgram

| Candidate | Why it belongs in the evaluation | Main qualification |
| --- | --- | --- |
| OpenAI Realtime, native audio | Removes the application's separate text-STT/LLM/TTS handoffs; browser WebRTC and server-side tool control are documented | Changes conversational-model behavior, context/cost model and history reconciliation; not guaranteed faster |
| Gemini Live, native audio | Bidirectional audio and tool support; an independent model/provider challenger | Test scheduled connection resets, `GoAway`, resumption, context policy, and interruption behavior |
| ElevenLabs Agents | Managed speech and turn-taking stack with configurable model/voice choices | External tools/history still need integration; measure useful answers rather than soft-timeout fillers |
| Cartesia Sonic TTS | Replace synthesis without replacing Aurvin's entire agent | Streaming aggregation/cancellation semantics differ; avoid double buffering |
| ElevenLabs real-time TTS | Another component-level alternative; explicit latency methodology | Published medians exclude network, upstream model time and playback; warm-voice conditions matter |
| AssemblyAI streaming STT | Alternative native turn detection and entity handling for dates, codes and names | Endpoint timing/accuracy trade-off remains; compare the exact model/mode/plugin, not brand-level claims |

Sources: [S12–S14, S16–S20, S23–S24].

### Native audio is not automatically a drop-in improvement

OpenAI's Realtime guide distinguishes WebRTC/SIP automatic unplayed-audio truncation from WebSocket clients that must stop playback and send truncation themselves. Its sideband control path allows server-owned tools without placing tool credentials in the browser. [S12–S13]

Google documents audio-session/context limits and approximately ten-minute connection lifetimes, with resumption and `GoAway` handling. Verify the exact chosen model/API contract; a short successful conversation does not establish a reliable twenty-minute Aurvin call. Automatic provider context compression would also need reconciliation with Aurvin's explicit context/history policy. [S14]

**Do not conflate OpenAI Realtime with GPT-Live.** Current GPT-Live/LiveKit documentation describes a full-duplex, server-driven model with delegated reasoning, append-only context and no normal response cancellation/truncation commands. It explicitly warns that stopping playback does not remove unheard content from the model context. That conflicts with an important Aurvin requirement unless separately resolved, so GPT-Live is an exploratory candidate rather than an interchangeable Realtime upgrade. [S23]

### Component replacement has its own traps

- ElevenLabs currently publishes roughly **100 ms median server-side latency** for real-time TTS options, under warm-voice streaming conditions. That does not mean Aurvin will answer in 100 ms, and it supplies no Aurvin p95 guarantee. [S16]
- Cartesia's buffering guide documents managed text buffering with a configurable maximum and warns against application phrase aggregation plus provider buffering. A fast model with double aggregation can still be slow. Its cancellation guide distinguishes queued requests from generation already in progress; stop local playback and reject late results independently. [S18–S19]
- AssemblyAI's guidance separately evaluates recognition, end-of-turn latency/accuracy and entity accuracy. Faster first partials are not a substitute for a correct final request. [S20, S24]

### Regions and model hosting may matter more than changing speech brands

Deepgram now documents regional EU, AU and India endpoints, including Flux STT, Flux TTS and Voice Agent. Aurvin's current allowlist admits only its existing global/US-labeled and EU choices. **If the actual user/backend locations justify another region, that is an option to validate before abandoning Deepgram**, not permission to change configuration or assume geography from this workstation. Exact model/account availability and all data-processing locations still need verification.

Deepgram explicitly notes that regional speech processing does not necessarily mean the managed LLM runs in that same country. LiveKit Inference also distinguishes agent deployment, inference routing and data-region restriction. [S9, S15]

For Aurvin's existing LLM path, OpenRouter supports latency sorting and percentile-based routing preferences. These are **soft preferences, not latency SLAs**. A direct or pinned provider may reduce routing variability but reduce fallback flexibility. Compare the same model via controlled routing before attributing model first-output delays to the speech provider. [S17]

## 5. What public benchmarks can and cannot establish

I did not find a public, independently reproducible matched experiment covering **Aurvin's exact custom path versus Deepgram Voice Agent versus the same Flux/LLM/TTS stack in LiveKit Agents, with and without Silero, across our devices, regions and load**.

Useful external evidence exists, but not a transferable winner:

- **Artificial Analysis:** publishes native speech-model quality, conversational and task-success methodology. Its speed metric is an **average time to first generated audio token** across its question set, not Aurvin browser-audible p95. Use it to shortlist models, not certify deployment latency. [S21]
- **Codebridge's August 2026 screening study:** compares cascades, frameworks, managed agents and native audio, distinguishes explicit-endpoint tests from natural endpointing, and reports scenarios involving pauses/codes. However, it is a commercial engineering firm's study, with only **5–21 turns per configuration**, synthetic English and no measured multi-turn/concurrency behavior. Detailed raw data is offered on request rather than independently reanalyzed here. Its article title says phone calls, but its limitations explicitly exclude PSTN/SIP/telephone playback. Its rankings, universal-sounding failure claims and latency numbers must not be promoted into Aurvin guarantees. [S22]

Provider documentation establishes supported mechanisms. It does not establish service quality at our concurrency or an end-to-end tail-latency SLA. Service-status pages and uptime percentages likewise cannot prove responsive audio, correct transcripts or safe tools.

## 6. A decisive evaluation, not another demo

### First define success

Suggested **initial product targets**, to approve or revise; these are not measured capabilities or vendor promises:

| Measure | Proposed target for a controlled no-tool, warm-session profile |
| --- | --- |
| Speech end → first useful audible answer | p50 ≤1.0 s; p95 ≤2.0 s |
| Intentional interruption → audible stop | p95 ≤250 ms; also measure stale audio afterward |
| Streaming reliability | Report gap/underrun distributions and no-answer rate; never hide them in successful-turn percentiles |
| Conversation behavior | Score false cutoffs, false interruptions, ignored backchannels, lost words, date/name/code correctness and task completion |
| Tool safety | No unauthorized/duplicate external mutations in the deterministic acceptance scenarios; retain durable pre-effect barriers |

Tool-backed answers need separate targets: distinguish acknowledgment, time to actual provider result, and correct spoken outcome. Do not claim a fast “checking…” is completion.

### A staged experiment keeps the comparison interpretable

**Stage 0 — current baseline and contracts**

- Capture exact deployed source/build, effective nonsecret settings, model/provider revisions, user/backend/SFU/provider locations, output device and browser.
- Reuse existing Aurvin timing/benchmark infrastructure; extend only missing measurement boundaries in a separately approved implementation.
- Use consented synthetic input, a calibrated device/loopback or acoustic observation on one clock, and real-time replay. Keep decoded onset and physical audibility distinct.
- Exercise fresh start, first turn and warm follow-ups separately, including ordinary conversation while capabilities remain enabled.

**Stage 1 — screen three architectures**

- A: current Aurvin custom/LiveKit transport.
- B: LiveKit Agents, same providers where feasible, Flux turn endings and Silero interruption handling with explicit settings.
- C: Deepgram Voice Agent, matched providers/settings where possible.
- Start with 20–30 turns per candidate across several scenarios, not one repeated question. This is a screening sample, not a stable p95/SLA.
- Run a controlled non-speculative comparison first where the products expose it; document any unavoidable speculation differences. Then separately compare the best safe configuration of each. Never attribute an eager-generation advantage solely to the transport/framework.
- Match the LLM, prompt/context budget, speech model/voice, region, text aggregation and output length where supported. If they cannot match, label the result a **whole-product comparison**, not isolated architecture overhead.

**Stage 2 — change providers selectively**

- If model first output dominates, compare a voice-appropriate model/host and controlled OpenRouter routing versus direct hosting.
- If TTS dominates, keep STT/model constant and compare Flux against Cartesia and ElevenLabs.
- If turn endings/recognition dominate, compare Flux against AssemblyAI with the same downstream model/voice.
- Include OpenAI Realtime as a separate whole-system challenger; expand to Gemini Live/ElevenLabs Agents if needed. Native audio cannot share the identical cascaded LLM and should not be presented as that experiment.

**Stage 3 — validate the finalists' consistency**

- At least 200 measured turns per finalist distributed across sessions, times and relevant conditions for an initial p95 assessment, with uncertainty reported. Hundreds of correlated turns from one easy call are not hundreds of independent reliability trials.
- Use a larger sample, preferably thousands, before making p99 or high-availability claims. For context, even 300 independent zero-failure trials only place the approximate 95% upper failure-rate bound near 1%; they do not establish 99.9% reliability.
- Include headset and speakerphone, real target accents/languages, quiet speech, background noise, “yeah” backchannels, deliberate interruptions, 0.3–1.2 s mid-sentence pauses, codes/dates, long history and a call spanning the provider's reconnect boundary.
- Test load at the intended deployment capacity in isolated infrastructure. Aurvin's admitted single-process/database topology and per-identity exclusivity must not be bypassed to create a load test.
- Use normal networking plus separately approved, independently verified delay/jitter/loss profiles. Browser HTTP throttling does not establish UDP WebRTC impairment.
- Report failures/timeouts/unverified playback alongside successful-turn p50/p95; compare useful-answer quality and cost per successful conversation.

Use hard response deadlines and bounded fallback. Fallback can improve availability but add seconds of tail latency; indiscriminate retries can duplicate responses, spend, and unsafe effects.

### Migration acceptance must preserve Aurvin

Whichever candidate wins must retain one canonical application history/authority, trusted identity, context bounds without silent history loss, generated-versus-heard projection, cancellation fences, cross-tab/cross-mode exclusion, finite costs/retries and mutation barriers/reconciliation. Faster filler audio or a green SDK fixture is not sufficient acceptance evidence.

Provider/account capacity and production service tier must be recorded. Free-tier/demos and single-call medians are not evidence for load. Keep one conversational owner per session; deliberate voice-front-end/delegated-backend designs are possible but need their own state and safety contract rather than an accidental extra inference layer.

## 7. Recommendation and confidence

- **High confidence:** “Deepgram with LiveKit” is too ambiguous to rank; Aurvin currently uses custom orchestration, not LiveKit Agents. VAD primarily changes interruption detection, not every latency stage.
- **High confidence:** managed Voice Agent does not eliminate client playback clearing; framework defaults and speculation can materially change timing and safety.
- **Moderate confidence, engineering judgment:** LiveKit Agents is the most natural first framework alternative for this TypeScript/browser product and its provider flexibility. Deepgram Voice Agent deserves an equally serious managed trial if conversational-loop ownership can move.
- **Not established:** which provider/architecture has the best current Aurvin p95, failure rate or device experience. Historical measurements are too old/different, and no new controlled comparison was run.

**Do not commit to retaining the custom pipeline out of inertia, and do not replace Deepgram on marketing latency alone. Select the winner by useful audible p95, interruption correctness, task success and operational simplicity under Aurvin's actual conditions.**

## Research verification and boundaries

- Read current production composition, STT/TTS adapters, interruption/output path, memory/durable runtime branches and existing measurement reports.
- Retrieved primary provider/framework documentation through Context7 and direct web reads; inspected a version-pinned public Node package without installing it.
- Kept guide/package inconsistencies explicit rather than inferring interoperability.
- Documentation-only deliverable; application build/lint/tests were not run. No live provider, database, LiveKit, microphone, network impairment, pricing reconciliation or service reliability test ran.
- Existing instruction to skip unified review remains unchanged. Review is **skipped**, not passed.
- Outstanding **decision evidence**, not unfinished implementation: an authorized current matched audible benchmark. It requires a separate scope, paid/data budget, approved targets and appropriate execution workflow.

## Sources

All external sources accessed 16 November 2026. Documentation is mutable; verify the selected model, SDK release, account entitlement and regional support before implementation.

- **S1:** Deepgram, [User Started Speaking](https://developers.deepgram.com/docs/voice-agent-user-started-speaking) — client playback/buffer responsibility.
- **S2:** Deepgram, [Voice Agent architecture](https://developers.deepgram.com/docs/voice-agent-architecture) — managed loop.
- **S3:** Deepgram, [Voice Agent LLMs](https://developers.deepgram.com/docs/voice-agent-llm-models) and [TTS models](https://developers.deepgram.com/docs/voice-agent-tts-models) — managed/BYO models and Flux version.
- **S4:** Deepgram, [Speculative replies and turn confirmation](https://developers.deepgram.com/docs/voice-agent-speculative-replies) — early work and mutation deferral.
- **S5:** LiveKit, [Deepgram STT](https://docs.livekit.io/agents/models/stt/deepgram/) — Flux endpointing and VAD responsibilities.
- **S6:** LiveKit, [Turn-handling reference](https://docs.livekit.io/reference/agents/turn-handling-options/) — additional STT-mode wait, interruption duration, preemption.
- **S7:** LiveKit, [Deepgram TTS](https://docs.livekit.io/agents/models/tts/deepgram/) — Flux/Aura interfaces and language-SDK availability caveat.
- **S8:** LiveKit, [Silero VAD](https://docs.livekit.io/agents/logic/turns/vad/) and [adaptive interruption handling](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/) — locality, policy and fallback.
- **S9:** LiveKit, [Inference](https://docs.livekit.io/agents/models/inference/) — direct plugins versus inference, deployment/region distinctions.
- **S10:** Published [`@livekit/agents-plugin-deepgram@1.10.0/dist/tts_v2.js`](https://unpkg.com/@livekit/agents-plugin-deepgram@1.10.0/dist/tts_v2.js) and [Node reference](https://docs.livekit.io/reference/agents-js/classes/plugins_agents_plugin_deepgram.SynthesizeStreamv2.html) — public static artifact inspection, not runtime verification.
- **S11:** Pipecat, [Deepgram STT](https://docs.pipecat.ai/api-reference/server/services/stt/deepgram) — Flux strategies, optional VAD, eager mode, reconnect behavior.
- **S12:** OpenAI, [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) and [VAD](https://developers.openai.com/api/docs/guides/realtime-vad) — native audio, interruptions and truncation.
- **S13:** OpenAI, [Server-side controls](https://developers.openai.com/api/docs/guides/realtime-server-controls) — server-owned tools/sideband.
- **S14:** Google, [Live session management](https://aistudio.google.com/docs/live-api/session-management) and [ephemeral tokens](https://aistudio.google.com/docs/live-api/ephemeral-tokens) — connection/session lifecycle and direct-client security.
- **S15:** Deepgram, [Regional endpoints](https://developers.deepgram.com/reference/regional-endpoints) — speech versus managed-LLM placement.
- **S16:** ElevenLabs, [Latency methodology](https://elevenlabs.io/docs/eleven-api/concepts/latency-methodology) — production p50, warm voices, excluded network/application time.
- **S17:** OpenRouter, [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) and [latency/performance](https://openrouter.ai/docs/guides/best-practices/latency-and-performance) — latency preferences versus guarantees.
- **S18:** Cartesia, [Streaming buffering](https://docs.cartesia.ai/use-the-api/tts-websocket/buffering) — aggregation/latency trade-off.
- **S19:** Cartesia, [Contexts and continuations](https://docs.cartesia.ai/use-the-api/tts-websocket/contexts) — cancellation scope and streaming contexts.
- **S20:** AssemblyAI, [Voice-agent STT evaluation](https://www.assemblyai.com/docs/streaming/evaluations/voice-agents) — finalization, turn accuracy and entity quality.
- **S21:** Artificial Analysis, [Speech-to-speech methodology](https://artificialanalysis.ai/methodology/speech-to-speech-benchmarking) — native-model benchmark boundaries.
- **S22:** Codebridge, [499-call screening study](https://www.codebridge.tech/articles/voice-ai-phone-agents-latency-benchmark) — secondary evidence with the limitations described above.
- **S23:** LiveKit, [OpenAI GPT-Live](https://docs.livekit.io/agents/models/realtime/gpt-live.md) — full-duplex/delegation and heard-context limitations; distinct from Realtime.
- **S24:** AssemblyAI, [Turn detection](https://www.assemblyai.com/docs/streaming/turn-detection) — current streaming model/mode and entity-aware endpointing.
