# Three-Harness Voice Architecture Benchmark: Technical Compatibility Research

**Date:** 16 November 2026
**Status:** Complete (`R` exit artifact for `voice-architecture-benchmark`)
**Environment Verified:** Windows 11 (`win32 x64`), Node `v24.18.0`, npm `12.0.1`
**Scope:** Read-only repository/package/API research only. Zero source edits to `backend/`, `frontend/`, root config, `.env`, or production MongoDB; zero `npm install` runs; zero live/paid calls.

---

## 1. Executive Decision Summary (Feasible vs. Blocked Matrix)

| Candidate | Folder | Compatibility Verdict | Key Technical Finding |
| --- | --- | --- | --- |
| **Aurvin Baseline** | `benchmarks/voice-architectures/aurvin/` | **Feasible** | Reuse `AppService.create` from `backend/dist/app.service.js` with an isolated benchmark MongoDB (`aurvin_voice_arch_<uuid>`), read-only `configRepository`, `ports.assets`, `ports.authProvider` stub + seeded synthetic `UserAccount`, and shared `BudgetGuard`. Headless decoded receipt yields `VOICE_DELIVERY_UNKNOWN` / `BENCHMARK_UNPROVEN_PLAYBACK` after completed turns (triggering `pause`), which must be preserved honestly and recovered via `input.unmute` or fresh session without fabricating `playback.progress(proof: 'proven')`. |
| **LiveKit Agents JS** | `benchmarks/voice-architectures/livekit-agents/` | **Feasible (with Windows/TTSv2 checks)** | `@livekit/agents@1.10.0` + `@livekit/agents-plugin-deepgram@1.10.0` (`STTv2` + `TTSv2`) + `@livekit/agents-plugin-silero@1.10.0` (`onnxruntime-node@1.24.3`) + `@livekit/agents-plugin-openai@1.10.0` (`openai@^6.8.1`) support Node `v24.18.0` and `win32-x64` prebuilds. JS plugin lacks Python's `withOpenRouter`, so pass a custom `OpenAI` `client` (`maxRetries: 0`, custom `fetch`) into `openai.LLM` to enforce `user`, `data_collection: 'deny'`, `transforms: []`, `max_tokens`, and `BudgetGuard`. `TTSv2` cancels via stream abort/buffer clear (no `/v2/speak` `Interrupt` `playback_offset`). Must pass offline `silero.VAD.load()` check on Windows before live calls. |
| **Deepgram Voice Agent BYO OpenRouter** | `benchmarks/voice-architectures/deepgram-agent/` | **Offline Protocol Feasible; Live BYO Preflight-Blocked Without Public Proxy** | Voice Agent v1 (`wss://agent.deepgram.com/v1/agent/converse` US / `wss://api.eu.deepgram.com/v1/agent/converse` EU) supports Flux STT (`v2`), Flux TTS (`v2`), and `think.endpoint` pointing at an OpenAI-compatible URL. **However**, Deepgram's `ThinkSettingsV1` / `OpenAiThinkProvider` AsyncAPI spec lacks JSON-body fields for OpenRouter `user` attribution, `provider: { data_collection: 'deny' }`, `transforms: []`, and `max_tokens`, sends the `OPENROUTER_API_KEY` header to Deepgram's servers, types `OpenAiThinkProvider.model` as an OpenAI-only enum, and prevents local `BudgetGuard` / `maxRetry: 0` enforcement on outbound LLM calls without a public proxy (which `goal.md` forbids). P3 must build the real client + fail-closed preflight block (`BLOCKED_BYO_CONTROLS_UNSUPPORTED`) and surface a separate user decision. |

---

## 2. Local Environment & Toolchain Baseline

- **Runtime observed:** `node -v` = `v24.18.0`, `npm -v` = `12.0.1`, OS = `win32` (`x64`). Matches `backend/package.json` `engines.node` (`^22.22.3 || ^24.15.0 || >=26.0.0`).
- **Existing locked versions in `backend/package-lock.json`:**
  - `@livekit/rtc-node`: `1.2.1` (`@livekit/rtc-ffi-bindings`: `0.13.1`)
  - `livekit-server-sdk`: `2.19.2`
  - `zod`: `3.25.76`
  - `ws`: `8.22.0`
  - `mongodb`: `6.21.0`
  - `typescript`: `6.0.3`, `vitest`: `4.1.11`, `oxlint`: `1.87.0`
- **Stale `backend/dist/` hazard observed:** `backend/dist/app.service.js` exists (`True`), **but** `backend/dist/context/prefix-estimate.js` does not exist (`False`) even though `backend/src/context/prefix-estimate.ts` exists on `HEAD`. Because `benchmarks/voice-architectures/aurvin/` imports compiled ESM from `backend/dist/`, **Aurvin preflight must check `backend/dist/` freshness against `backend/src/` (and require running read-only `npm run build` inside `backend/` if stale)** before live execution.

---

## 3. Existing Aurvin Baseline & Read-Only Credential Import Seams

### 3.1 Reusable `backend/` Files & Contracts (Zero Edits to `backend/`)

`benchmarks/voice-architectures/aurvin/` can import compiled ESM modules from `../../backend/dist/` (Node resolves `backend/dist/*`'s own npm dependencies from `backend/node_modules/`):

| Backend Source (`backend/src/...`) | Compiled Seam (`backend/dist/...`) | Reuse Role in `aurvin/` & `shared/` |
| --- | --- | --- |
| `platform/config/bootstrap-config.ts` | `platform/config/bootstrap-config.js` | `loadBootstrapConfig(env)` parses infra env vars (`PORT`, `FRONTEND_ORIGIN`, `AURVIN_USER_ID`, `MONGODB_URI`, `MONGODB_DB_NAME`, `PERSISTENCE_PROFILE`, `AURVIN_CONFIG_ENCRYPTION_KEY`, `LIVEKIT_*`, `WORKOS_*`). |
| `platform/config/legacy-config-import.ts` | `platform/config/legacy-config-import.js` | `parseLegacyConfigImport(env, bootstrap)` extracts `ManageableSettings` + plaintext `DecryptedCredentials` (`openrouter`, `deepgram`) from `.env` without modifying DB. |
| `platform/config/manageable-config.ts` | `platform/config/manageable-config.js` | `validateManageableSettings`, `defaultManageableSettings`, `buildRuntimeSnapshot`. |
| `admin-config/credential-service.ts` | `admin-config/credential-service.js` | `CredentialService` (`seal` and `decrypt` using AES-256-GCM + `AURVIN_CONFIG_ENCRYPTION_KEY`, AAD `JSON.stringify(['aurvin','config',1,provider])`). |
| `contracts/admin-config.ts` | `contracts/admin-config.js` | `storedConfigDocumentSchema`, `APP_CONFIG_ID` (`'aurvin'`), `MAX_CONFIG_DOCUMENT_BYTES`. |
| `instructions/fixed-assets.ts` | `instructions/fixed-assets.js` | `loadFixedAssets({ instructions, knowledge })` loads `backend/src/instructions/system.md` (10,691 bytes) and `product_knowledge.md` (1,522 bytes). |
| `context/prefix-estimate.ts` | `context/prefix-estimate.js` | `computeChatFloor(assets, chat)` computes minimum `maxContextTokens` (`MIN_HISTORY_TOKENS = 10_000` + worst-case prefix + `maxOutputTokens` + `modelMarginTokens`). |
| `model/catalogue.ts` & `model/calendar-evidence.ts` | `model/catalogue.js`, `model/calendar-evidence.js` | `loadModelLimits`, `calendarEvidenceFor` (non-inference `GET /api/v1/models` capability & pricing verification). |
| `persistence/indexes.ts` | `persistence/indexes.js` | `setupIndexes(db)` prepares the fresh isolated benchmark DB (`aurvin_voice_arch_<uuid>`) before `AppService` boots. |
| `app.service.ts` | `app.service.js` | `AppService.create(bootstrap, ports)` wires the full production voice pipeline (`VoiceSessionService`, `LiveKitAdmission`, `LiveKitMediaBridge`, `LiveFlow`, `AgentVoiceAdapter`, `DurableChatRuntime`, `OpenRouterAttemptAdapter`, `FluxSttAdapter`, `FluxTtsAdapter`). |
| `voice/providers/provider-link.ts` | `voice/providers/provider-link.js` | `socketFactory` (`SocketFactory`) wrapped by `shared/BudgetGuard` for Deepgram STT/TTS WebSocket egress enforcement. |
| `contracts/voice-wire.ts` | `contracts/voice-wire.js` | `INPUT_AUDIO` (16 kHz mono 80 ms PCM16), `OUTPUT_AUDIO` (24 kHz mono PCM16), `LIVEKIT_CONTROL_TOPIC` (`'aurvin.voice.control'`), `parseVoiceControl`, `encodeVoiceControlPackets`, `livekitAgentIdentity`, `isLiveKitVoiceSessionResponse`. |
| `contracts/auth.ts` | `contracts/auth.js` | `userAccountSchema`, `AuthPrincipal` types for seeding the isolated benchmark DB's synthetic user. |
| `benchmark/voice-measurements.ts` & `benchmark/report.ts` & `benchmark/runner.ts` | `benchmark/voice-measurements.js`, `benchmark/report.js`, `benchmark/runner.js` | `DecodedReceipt` (24 kHz nonzero decoded gate), `summarizeVoiceMetric`, `summarize`, `safeEvidence`, `hashId`, `correlate`, `isVoiceDeliveryConfirmed`. |

### 3.2 Critical Caveats When Invoking `AppService` Without Editing `backend/`

1. **`ports.assets` must be passed explicitly:** In `backend/src/app.service.ts` (lines 280–283), the default `assets` loader resolves `resolve(process.cwd(), 'src/instructions/system.md')` and `resolve(process.cwd(), '../product_knowledge.md')`. Because the benchmark runs with `cwd = benchmarks/voice-architectures`, `aurvin/` **must** override `ports.assets` to load `<repoRoot>/backend/src/instructions/system.md` and `<repoRoot>/product_knowledge.md`.
2. **WorkOS auth was added after the Nov 5–8 `live-baseline.ts` driver:**
   - Current `AppModule` / `configurePrivateHttp` (`backend/src/http/configure-private-http.ts`) authenticates every `/api/*` request via `AuthService.authenticate` -> `WorkosProvider.read` -> `AccountAuthority.snapshot` -> `admitAccount`.
   - `VoiceSessionService.create` (`backend/src/voice/session/voice-session.service.ts`) enforces `requireFullAccount(principal)` and calls `assertAccountCurrent(principal)` (reading `users.get(userId)` from DB).
   - `OperationsService.readiness` (`backend/src/operations/readiness.ts` line 98 + `app.service.ts` line 574) requires `this.authProvider !== null && this.persistence !== null` for `acceptReady: true`.
   - **Recommended zero-edit solution for `aurvin/`:** Invoke `AppService.create(isolatedBootstrap, ports)` directly in-process (no `@nestjs/testing` / Nest HTTP dependency needed in `benchmarks/voice-architectures/package.json`!), passing:
     - `isolatedBootstrap`: `{ ...sourceBootstrap, calendar: null, workos: null, persistence: { ...sourceBootstrap.persistence, mongoDbName: isolatedDbName } }` (never touch production DB!).
     - `ports.authProvider: () => stubBenchmarkAuthProvider` (satisfies `authenticationReady() === true` with zero live WorkOS network calls).
     - `ports.configRepository: () => readOnlyConfigRepo` (returns an in-memory `StoredConfigDocument` without opening a writable repo on production DB).
     - `ports.fetcher: budgetGuard.fetch(fetch)` and `ports.speechSockets: budgetGuard.sockets(socketFactory)`.
     - `ports.writeLog`: routes `process` / `voice-pipeline` / `readiness` JSON lines through `safeEvidence` into the benchmark artifact buffer/file.
     - Seed 1 synthetic active `UserAccount` (`userId: isolatedBootstrap.identity.userId`, `workosUserId: 'user_bench_local'`, `role: 'super-admin'`, `status: 'active'`, `passwordChangeRequired: false`, `currentWorkosSessionId: benchSessionId`, `sessionEpoch: 0`) into the **fresh isolated DB's** `users` collection, call `service.operations.readiness.read()` to verify `acceptReady === true && speech === 'ready'`, then drive sessions directly via `service.voiceSessions.create(...)` and `service.voiceSessions.endOwned(...)` + `service.operations.shutdown()`.
     - *(Alternative if HTTP loopback is ever desired later: run `Test.createTestingModule` with `AppModule` and log into `/api/auth/login` against `stubBenchmarkAuthProvider`, which requires adding Nest packages; in-process `service.voiceSessions` executes 100% of the same `VoiceSessionService` -> `LiveKitAdmission` -> `LiveKitMediaBridge` -> `LiveFlow` -> `AgentVoiceAdapter` -> `DurableChatRuntime` -> `OpenRouterAttemptAdapter` -> `FluxSttAdapter` -> `FluxTtsAdapter` stack without extra Nest dependencies.)*
3. **Do NOT reuse `runVoice` / `runWebRtcVoice` / `LiveBudget` directly for multi-turn runs:** `backend/src/benchmark/webrtc-voice.ts` and `voice-runner.ts` hardcode 1 turn per session and close after `audio.end`, and `backend/src/benchmark/live-budget.ts` hardcodes `anthropic/claude-haiku-5.5` and `flux-haley-en`. P1 should place a generalized multi-turn headless `@livekit/rtc-node` participant and dynamic `BudgetGuard` inside `benchmarks/voice-architectures/shared/`.
4. **Keep `calendar: null`:** Live voice already excludes Calendar tools (`agent-voice-adapter.ts` / `durable-chat-runtime.ts`), and `goal.md` forbids Calendar/web/MCP tools in the benchmark.

### 3.3 Read-Only `.env` & DB Credential Import Seam (Never Mutates Config or Prints Secrets)

Inspection of `backend/.env` **key names only** (never values) confirms `backend/.env` defines both bootstrap keys (`PORT`, `FRONTEND_ORIGIN`, `NODE_ENV`, `AURVIN_USER_ID`, `PERSISTENCE_PROFILE`, `MONGODB_URI`, `MONGODB_DB_NAME`, `AURVIN_CONFIG_ENCRYPTION_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `WORKOS_*`) and legacy manageable keys (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_DATA_COLLECTION`, `OPENROUTER_DISABLE_TRANSFORMS`, `DEEPGRAM_API_KEY`, `DEEPGRAM_API_BASE`, `DEEPGRAM_LIVE_MODEL`, `DEEPGRAM_TTS_MODEL`, `DEEPGRAM_FLUX_EOT_THRESHOLD`, `DEEPGRAM_FLUX_EOT_TIMEOUT_MS`, `ENABLE_LIVE_VOICE_MODE`, etc.).

**Recommended `shared/credentials.ts` resolution order (read-only):**
1. Load an explicit env file (`--env-file`), or `<repoRoot>/backend/.env` if present, into an **isolated in-memory map** (parse `KEY=VALUE` via a dedicated parser or `dotenv.parse` rather than mutating global `process.env` unless explicitly needed; merge `process.env` overrides). Never log or serialize raw values.
2. Parse infra bootstrap via `loadBootstrapConfig(envMap)` (validates `LIVEKIT_*`, `AURVIN_USER_ID`, `AURVIN_CONFIG_ENCRYPTION_KEY`, `MONGODB_URI`, `PERSISTENCE_PROFILE`).
3. Extract manageable settings and credentials via `parseLegacyConfigImport(envMap, bootstrap)`.
4. **Read-only MongoDB fallback (ONLY if `.env` leaves `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, or `DEEPGRAM_API_KEY` blank, OR when `aurvin/` mirrors stored config revision):**
   - Open a short-lived `MongoClient` with `readPreference: 'primary'`, `maxTimeMS: 10000`, `connectTimeoutMS: 10000`.
   - Read **only** `db(mongoDbName).collection('config').findOne({ _id: 'aurvin' })` (never read `sessions`, `messages`, `users`, `metadata`, or `integration_connections`; never run `openPersistence` or create executor sentinels on the production DB).
   - Validate via `storedConfigDocumentSchema.parse(doc)` and decrypt via `new CredentialService(bootstrap.encryption, unusedValidator).decrypt(doc)` using `AURVIN_CONFIG_ENCRYPTION_KEY`.
   - Close that read-only `MongoClient` immediately before any live benchmark step.
5. **For `aurvin/` `StoredConfigDocument` synthesis:** If production `config` exists, pass that read-only `StoredConfigDocument` into `ports.configRepository` (with `createIfAbsent` / `compareAndSwap` throwing `READ_ONLY_CONFIG`). If running solely from `.env` without reading production `config`, construct an in-memory `StoredConfigDocument` sealed with an ephemeral in-memory 32-byte encryption key (`encryption: { status: 'ready', key: ephemeralKey }`) so `CredentialService.decrypt` stays 100% isolated.
6. **Secret Redaction (`SecretRedactor`):** Collect every loaded secret string (`openrouterApiKey`, `deepgramApiKey`, `livekitApiKey`, `livekitApiSecret`, `mongoUri`, `encryptionKey`, `workos*`) plus regex patterns (`sk-[A-Za-z0-9_-]{8,}`, `Bearer\s+\S+`, `Token\s+\S+`, compact JWTs `eyJ...`) and assert/scrub all strings before writing any JSON/Markdown report or stdout log, failing closed (`BENCHMARK_REDACTION_FAILED`) on match.

### 3.4 Exact Current Playback-Proof Contract & Why Headless Differs From Audible Delivery

Across `backend/src/voice/`:
1. **`LiveKitOutput` (`livekit-output.ts`)** emits `audio.start`, buffers 24 kHz PCM into `AudioSource`, and emits `audio.watermark` (`firstAudioSample`, `queuedSamples`, `lastAudioSample`, `final`).
2. **`LiveFlow` (`live-flow.ts` lines 398–415)** processes client `playback.progress` and `response.interrupt`. Critically:
   - Line 402: `if (e.proof !== 'unproven') { await this.deps.hooks.playback(...); this.completePlayback(r); }` — any `proof: 'unproven'` progress is ignored for durable completion.
   - Line 411: `response.interrupt` with `proof === 'unproven'` passes `position = -1`, forcing `FluxTtsAdapter` reset rather than spoken-prefix reconciliation.
3. **`VoiceDelivery` (`voice-delivery.ts` lines 318–340)** computes terminal `proof()`:
   - Completion requires `!this.invalid && this.synthesized && generated === this.sent && this.record.audioDurationMs !== null && samples === expected` (where `expected = audioSamples ?? audioDurationMs * 24`).
   - Without client `playback.progress` (`proof: 'proven'`) matching `expected` samples within `finalizationMs` (2,000 ms), `settle()` writes `status: 'unknown'`, `textSpoken: null`, `textRemaining: null`.
4. **`AgentVoiceAdapter` (`agent-voice-adapter.ts` lines 375–377) + `LiveFlow` (`live-flow.ts` line 598):**
   - Because headless must **never** fabricate `playback.progress(proof: 'proven')`, `delivery.status` settles to `'unknown'` on completed turns!
   - When `!active.invalid && delivery.status === 'unknown'`, `AgentVoiceAdapter` throws `new VoiceSessionError('VOICE_DELIVERY_UNKNOWN')` (`agent-voice-adapter.ts:376`), which `LiveFlow` catches at line 598 -> calls `this.error('VOICE_DELIVERY_UNKNOWN')` -> calls `LiveKitMediaBridge.pause('VOICE_DELIVERY_UNKNOWN', true)` (`livekit-media.ts:382`) and closes `LiveFlow`!
   - Furthermore, when Turn 2 runs on the same `conversationId`, `ReferencedContextAssembler.heardMessage()` (`referenced-context-assembler.ts:98-101`) sees `delivery.status === 'unknown'` and replaces Turn 1's assistant text in LLM context with `"Voice reply delivery is unknown; do not assume generated content was heard."`.
   - For an interrupted turn (`Turn 4 -> Turn 5`), `active.invalid === true` before `settle()`, so `AgentVoiceAdapter:376` does not throw; however `LiveFlow.interrupt` passes `played = 0` (`ms = 0`), which hits `ms <= lastInterrupt` if any prior interrupt occurred (`FluxTtsAdapter:193`), resetting the TTS socket with `VOICE_DELIVERY_UNKNOWN`.
5. **Why headless decoded receipt is NOT audible delivery:**
   - Reading decoded 24 kHz `AudioFrame`s from `@livekit/rtc-node` `AudioStream` proves only that encoded Opus frames reached the Node WebRTC subscriber and decoded to non-zero PCM samples.
   - It does **not** prove browser `AudioContext`/`AudioWorklet` scheduling, hardware DAC/OS audio buffer drain, physical speaker emission, or acoustic/microphone echo-cancellation behavior (`webrtc-methodology.md`).
   - Therefore, P1 must preserve `onset` (`speechEndToFirstAudioMs`), explicitly record incomplete delivery (`BENCHMARK_UNPROVEN_PLAYBACK` / `VOICE_DELIVERY_UNKNOWN`), recover a paused `LiveKitMediaBridge` via `input.unmute` (`livekit-media.ts:476-478`) or open a fresh session while logging the pause/recovery explicitly, and **never** emit `playback.progress(proof: 'proven')`.

---

## 4. LiveKit Agents JS/Node Compatibility (`livekit-agents`)

### 4.1 Verified Published npm Packages & Windows / Node `v24.18.0` Matrix

Verified via `npm view` against npm registry (16 Nov 2026):

| Package | Locked Version | Node `v24.18.0` / Windows `win32-x64` Compatibility | Notes & Peer/Native Dependencies |
| --- | --- | --- | --- |
| `@livekit/agents` | `1.10.0` | Compatible (prebuilt optional native binaries for `win32-x64`) | PeerDeps: `zod: ^3.25.76 \|\| ^4.1.8`, `@livekit/rtc-node: ^1.2.2`, `@modelcontextprotocol/client: ^2.3.1` (marked `optional: true`). Uses `@livekit/av@^10.0.0` (`@livekit/av-win32-x64: 10.1.0`), `@livekit/blingfire@^1.2.0` (`@livekit/blingfire-win32-x64-msvc: 1.2.0`), `@livekit/local-inference@^0.3.1` (`@livekit/local-inference-win32-x64-msvc: 0.3.1`), `sharp@0.35.5` (`@img/sharp-win32-x64: 0.35.5`, `engines.node >= 20.9.0`). |
| `@livekit/agents-plugin-silero` | `1.10.0` | **Conditional — requires offline load verification on this Windows host** | Depends on `onnxruntime-node@1.24.3` (runs `postinstall: node ./script/install` fetching binaries, uses N-API `napi-v3/win32/x64/onnxruntime_binding.node`, requires Microsoft Visual C++ 2015–2022 x64 Redistributable). P2 must run an offline `silero.VAD.load()` + dummy PCM inference test before any live run. |
| `@livekit/agents-plugin-deepgram` | `1.10.0` | Pure JS + `ws@^8.21.0` | Exports both `STTv2` (`/v2/listen`) and `TTSv2` (`/v2/speak`). |
| `@livekit/agents-plugin-openai` | `1.10.0` | Pure JS + `openai@^6.8.1` | Exports `LLM` + `LLMOptions` (supports `client?: OpenAI`, `baseURL`, `apiKey`, `model`, `user`, `maxCompletionTokens`, `temperature`). |
| `@livekit/rtc-node` | `1.2.2` | Compatible (`engines.node >= 18`) | Satisfies `^1.2.2` peerDep of `@livekit/agents@1.10.0`. Depends on `@livekit/rtc-ffi-bindings@0.13.2` (`win32-x64-msvc` prebuild; `1.2.1` / `0.13.1` already runs on this machine). |
| `livekit-server-sdk` | `2.19.2` | Pure JS | Matches `backend/package.json`; provides `AccessToken` & `RoomServiceClient` for dedicated benchmark rooms (`aurvin-bench-*`) and guaranteed `deleteRoom` cleanup. |
| `openai` | `^6.8.1` (pin `6.8.1` or resolve `6.x`, avoid `7.x` breaking mismatch) | Pure JS | Explicitly matched to `@livekit/agents-plugin-openai@1.10.0` dependency (`^6.8.1`). Supports `new OpenAI({ maxRetries: 0, fetch })`. |
| `zod` | `3.25.76` | Pure JS | Satisfies `@livekit/agents@1.10.0` peerDep (`^3.25.76 \|\| ^4.1.8`) and matches `backend/package-lock.json`. |

### 4.2 Flux STT & Flux TTS Support in `@livekit/agents-plugin-deepgram@1.10.0`

- **Flux STT (`STTv2`):** Connects to Deepgram `/v2/listen` with `TurnInfo` events (`StartOfTurn`, `Update`, `EndOfTurn`). Supports `model: 'flux-general-en'`, `apiKey`, `eotThreshold` (matched to Aurvin's `0.8`), `eotTimeoutMs` (`5000`), and `eagerEotThreshold` (must be **omitted/disabled** for the non-speculative screening comparison).
- **Flux TTS (`TTSv2`):** Connects to Deepgram `/v2/speak`, accepts `model` (`flux-*-en`, matched to Aurvin's `DEEPGRAM_TTS_MODEL`), `apiKey`, `baseUrl`, `encoding: 'linear16'`, `mipOptOut`. Both `TTSv2.stream()` and `TTSv2.synthesize()` emit raw `linear16` PCM only.
- **Concrete SDK Interruption Caveat:** As verified in `docs/voice-latency-benchmark/provider-architecture-assessment-2026-11-16.md` (§3B, `S10`), `@livekit/agents-plugin-deepgram@1.10.0/dist/tts_v2.js` does **not** emit Deepgram's `/v2/speak` `Interrupt` command with `playback_offset`. Instead, `AgentSession` aborts `SynthesizeStreamv2` (`abortSignal` / `close()`) and `RoomIO` clears queued audio output frames. P2 must verify actual decoded cutoff and stale-tail audio independently on the headless WebRTC subscriber track rather than assuming Deepgram-side `SpeechInterrupted` reconciliation.
- **Regional endpoint caveat:** Check installed `.d.ts` of `STTv2Options` and `TTSv2Options` in P2 after `P1` installs packages to confirm whether `baseUrl`/`endpoint` forwards `eu` vs `us` correctly; fail preflight if configured region is unsupported.

### 4.3 OpenRouter LLM Wiring, Attribution, Finite Output & Zero-Retry Controls

- `@livekit/agents-plugin-openai@1.10.0` does **not** expose Python's `LLM.withOpenRouter()` helper.
- Instead, `LLMOptions` exposes `client?: OpenAI`, `baseURL?: string`, `apiKey?: string`, `model: string`, `user?: string`, `maxCompletionTokens?: number`, `temperature?: number`.
- **Required P2 wiring pattern:**
  1. Construct `const openAIClient = new OpenAI({ apiKey: openRouterApiKey, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0, timeout: totalRunTimeoutMs, defaultHeaders: { 'X-Title': 'Aurvin' }, fetch: guardedOpenRouterFetch })`.
  2. Pass `client: openAIClient` to `new openai.LLM({ model: modelId, apiKey: openRouterApiKey, baseURL: 'https://openrouter.ai/api/v1', user: userId, maxCompletionTokens: outputCap, client: openAIClient })`.
  3. Inside `guardedOpenRouterFetch`:
     - Enforce `shared/BudgetGuard` (host allowlist `https://openrouter.ai`, `POST /api/v1/chat/completions` only, dispatch count ceiling, context/output token bounds, active lifetime deadline, `redirect: 'error'`).
     - Inspect/inject OpenRouter body parameters to match Aurvin's `backend/src/model/policy.ts`: `user: AURVIN_USER_ID`, `provider: { data_collection: 'deny', require_parameters: true, allow_fallbacks: false }`, `transforms: []`, `plugins` disabled, `tools` absent, and normalize `max_tokens` vs `max_completion_tokens` according to `loadModelLimits` (`verifiedOutputCap(limits)`).
  4. In `AgentSessionOptions.connOptions` (`SessionConnectOptions`): set `{ llmConnOptions: { maxRetry: 0 }, sttConnOptions: { maxRetry: 0 }, ttsConnOptions: { maxRetry: 0 }, maxUnrecoverableErrors: 1 }` so `@livekit/agents` never performs hidden framework-level paid retries.

### 4.4 Turn Handling, Interruption, Heard-History & Standalone Execution

- **Standalone Room Execution:** `AgentSession.start({ room, agent, roomOptions })` + `RoomIO` operates directly over any connected `@livekit/rtc-node` `Room` (using a minted agent `AccessToken` from `livekit-server-sdk` and `roomOptions.audioInput.participantIdentity` pinned to the headless harness participant), without requiring a LiveKit Cloud worker deployment or `cli.runApp`.
- **Turn Detection & Interruption Policy:**
  - Set `turnHandling.turnDetection: 'stt'` (use Flux STT `EndOfTurn` authority), `vad: sileroVAD`, `turnHandling.endpointing: { mode: 'fixed', minDelay: 0, maxDelay: 0 }` (prevent additional endpoint wait from stacking onto Flux STT; P2 must verify in installed types whether `0` is accepted without validation error).
  - Set `turnHandling.interruption: { enabled: true, mode: 'vad', minDuration: 500, resumeFalseInterruption: false }` (explicitly document `minDuration: 500` ms framework default vs Aurvin's immediate Flux `StartOfTurn` trigger; do **not** use `mode: 'adaptive'` which adds an unrequested inference dependency).
  - Set `turnHandling.preemptiveGeneration: { enabled: false, preemptiveTts: false }` so no unrequested speculative LLM/TTS dispatches fire.
- **Heard-History Limitation:** `AgentSession` truncates assistant messages in `chatCtx` on interruption based on internal framework playback tracking/estimation, not confirmed hardware/acoustic audibility. Label `chatCtx` history parity separately from Aurvin's `VOICE_DELIVERY_UNKNOWN` reconciliation.

---

## 5. Deepgram Voice Agent BYO OpenRouter Compatibility (`deepgram-agent`)

### 5.1 Protocol, Regional Endpoints, Audio & Flux Support

- **WebSocket Endpoints:**
  - US / Global: `wss://agent.deepgram.com/v1/agent/converse`
  - EU: `wss://api.eu.deepgram.com/v1/agent/converse`
  - AU: `wss://api.au.deepgram.com/v1/agent/converse`
  - *(Region matching: Aurvin `DEEPGRAM_API_BASE` `wss://api.deepgram.com` maps to `wss://agent.deepgram.com/v1/agent/converse`; `wss://api.eu.deepgram.com` maps to `wss://api.eu.deepgram.com/v1/agent/converse`.)*
- **Audio Formats:** Supports `audio.input: { encoding: 'linear16', sample_rate: 16000 }` and `audio.output: { encoding: 'linear16', sample_rate: 24000, container: 'none' }`, matching our synthetic corpus and decoded comparison rate.
- **Flux STT & Flux TTS inside Voice Agent:**
  - `agent.listen.provider`: `{ type: 'deepgram', version: 'v2', model: 'flux-general-en', eot_threshold, eot_timeout_ms }` (omit `eager_eot_threshold` to disable speculative generation).
  - `agent.speak.provider`: `{ type: 'deepgram', version: 'v2', model: 'flux-*-en' }`.
- **Key Entitlement Check (Non-Billable):** `GET https://api[.eu].deepgram.com/v1/auth/token` (already used by `backend/src/admin-config/credential-validation.ts`) returns key `api_key_id` and `scopes` without generating audio or opening a Voice Agent WebSocket. Note that project-level Voice Agent billing/feature enablement may still return `401`/`403` `INSUFFICIENT_PERMISSIONS` at WebSocket upgrade if the key lacks Agent permissions.
- **Observable Events:** Server emits `SettingsApplied`, `UserStartedSpeaking`, `AgentThinking`, `AgentStartedSpeaking` (with `total_latency`, `tts_latency`, `ttt_latency` floats in seconds), `AgentAudioDone`, `ConversationText`, `Warning`, and `Error`.

### 5.2 Hard Compatibility Blockers for Direct BYO OpenRouter (No Public Proxy)

Inspection of Deepgram's official Voice Agent v1 AsyncAPI schema (`deepgram/deepgram-api-specs/asyncapi.yml`), developer docs (`developers.deepgram.com`), and OpenRouter API docs (`openrouter.ai/docs`) establishes the following **structural protocol blockers** when pointing `agent.think.endpoint` directly at `https://openrouter.ai/api/v1/chat/completions` without an intermediate proxy:

| Requirement (`goal.md` / `AGENTS.md`) | Direct Deepgram Voice Agent BYO Status | Evidence / Protocol Gap |
| --- | --- | --- |
| **1. Per-attempt `user` attribution** (`AURVIN_USER_ID` in OpenRouter body) | **BLOCKED (Unsupported)** | `ThinkSettingsV1` (`provider`, `endpoint`, `functions`, `prompt`, `context_length`) and `OpenAiThinkProvider` (`type`, `version`, `model`, `temperature`, `reasoning_mode`) expose **no** `user` property or arbitrary JSON-body passthrough. OpenRouter reads `user` from the POST JSON body, not HTTP headers. |
| **2. OpenRouter privacy & routing policy** (`data_collection: 'deny'`, `require_parameters: true`, `allow_fallbacks: false`, `transforms: []`, disabled plugins) | **BLOCKED (Unsupported)** | `ThinkSettingsV1` exposes **no** `provider` routing, `transforms`, or `plugins` body fields. OpenRouter HTTP headers (`HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`, `X-OpenRouter-Metadata`) do not control `data_collection: 'deny'`, `allow_fallbacks`, or `transforms`. |
| **3. Finite per-call output cap** (`max_tokens` / `max_completion_tokens`) | **BLOCKED (Unsupported)** | `ThinkSettingsV1` provides `context_length` (history cap) for custom endpoints, but **no** `max_tokens` or `max_completion_tokens` field in `Settings.agent.think`. |
| **4. Direct `BudgetGuard` / zero-retry enforcement on LLM calls** | **BLOCKED (Unsupported without proxy)** | Deepgram's cloud server opens the HTTPS POST directly to `think.endpoint.url` (requiring `OPENROUTER_API_KEY` inside `Settings.agent.think.endpoint.headers`). The local benchmark process cannot intercept outbound OpenRouter requests with `BudgetGuard`, cannot enforce `maxRetry: 0` on Deepgram's upstream LLM client, cannot reject over-budget prompts before billing, and receives no LLM token counts (`prompt_tokens`/`completion_tokens`) or `generationId` in Voice Agent events. |
| **5. OpenRouter `vendor/model` ID under `open_ai` schema** | **AT RISK / UNVERIFIED** | In `deepgram/deepgram-api-specs/asyncapi.yml`, `OpenAiThinkProviderModel` is typed as an OpenAI-only enum (`gpt-5*`, `gpt-4.1*`, `gpt-4o*`). Even if the live Deepgram server skips strict enum checks when `endpoint` is supplied, items (1)–(4) remain hard structural omissions. |

### 5.3 Mandatory Guidance for P3 Planner

- `goal.md` explicitly prohibits adding a public proxy/tunnel, silently waiving attribution/privacy/cost-bound rules, or substituting a Deepgram-managed LLM.
- **P3 must:**
  1. Implement the genuine Deepgram Voice Agent v1 WebSocket harness (`deepgram-agent/`), including `Settings` construction, `UserStartedSpeaking` / `AgentThinking` / `AgentStartedSpeaking` / `AgentAudioDone` / `ConversationText` parsing, monotonic PCM pacing, interruption audio cutoff + stale-tail measurement, and full deterministic offline unit/protocol fixture tests.
  2. Implement a strict, fail-closed **live preflight gate** (`preflightDeepgramAgent`) that runs before any WebSocket connection:
     - Verifies non-billable key/scope status via `GET /v1/auth/token`.
     - Evaluates whether direct BYO OpenRouter satisfies `user` body attribution, `provider.data_collection: 'deny'` / `transforms: []`, `max_tokens`, and local `BudgetGuard` / zero-retry enforcement without a public proxy.
     - Fails closed with `BLOCKED_BYO_CONTROLS_UNSUPPORTED` (zero live turns executed, US$0 spent), writes an honest blocked record to `benchmarks/voice-architectures/deepgram-agent/report.md`, and requires an explicit user decision before any live admission (e.g., whether to approve a later scoped exception or keep `deepgram-agent` blocked in the compiled verdict).

---

## 6. Current Published Pricing Units & Conservative US$2 Budget Bounds

### 6.1 Verified Pricing Units

| Service / Component | Published Unit Rate (Pay-As-You-Go) | Source / Observation Basis | Conservative Reservation Rule |
| --- | --- | --- | --- |
| **OpenRouter (Configured Model)** | Dynamic per `GET /api/v1/models` (`pricing.prompt`, `pricing.completion`, `pricing.request`, `pricing.internal_reasoning`, `pricing_overrides`). Baseline model previously recorded in `live-baseline.ts` (`anthropic/claude-haiku-5.5`): base `$0.10/1M` prompt, `$0.50/1M` completion; high-context worst-case tier `$0.50/1M` prompt (`$0.0000005/tok`), `$2.50/1M` completion (`$0.0000025/tok`), `$0` per-request. | `openrouter.ai/api/v1/models` + `backend/src/model/catalogue.ts` + `websocket-live-baseline-2026-11-05.md` | Preflight MUST query `GET /api/v1/models` for actual configured `OPENROUTER_MODEL` and reserve worst-case applicable tier (`maxContextTokens * promptRate + maxOutputTokens * completionRate + requestRate`) per dispatch. Refuse live start if unavailable or exceeds ceiling. |
| **Deepgram Flux STT (`/v2/listen`)** | **`$0.0077 / minute`** of audio streamed (`$0.00012833.../sec`). | `deepgram.com/pricing` + `websocket-live-baseline-2026-11-05.md` | Reserve at full active STT audio cap (`inputAudioMinutes * $0.0077`). |
| **Deepgram Flux TTS (`/v2/speak`)** | **`$0.045 / 1,000 input characters`**. | `deepgram.com/pricing` + `websocket-live-baseline-2026-11-05.md` | Reserve conservatively by UTF-8 bytes (`utf8BytesCap / 1000 * $0.045`). |
| **Deepgram Voice Agent (Custom, BYO LLM)** | **`$0.065 / minute`** of WebSocket connection time (Growth: `$0.059/min`). *(Note: Flux `v2` TTS surcharge vs bundle inclusion is unverified on BYO-LLM tier; add a Flux TTS buffer if ever live-admitted.)* | `deepgram.com/pricing` | Reserve at `$0.065 * maxAgentMinutes` (+ `$0.045 * maxAgentTtsBytes/1000` unverified surcharge buffer). |
| **LiveKit Cloud / WebRTC** | **Build (`$0/mo`):** 1,000 agent-session min + 5,000 WebRTC min included. **Paid overage (Ship/Scale):** **`$0.01 / agent session minute`** (10 s min increment) + WebRTC downstream bandwidth/participant-min charges; self-hosted SFU `$0`. | `livekit.io/pricing` | Because account plan tier/remaining free allowance is not observable offline, conservatively reserve **`$0.02 / active-room-minute`** (covering agent + participant media buffer) and record invoice cost as `unknown (depends on LiveKit plan/host)` unless directly verified. |

### 6.2 Concrete Conservative Reservation Math (18 Turns / 15 Minutes Max / US$2 Ceiling)

Pilot hard caps enforced across the **aggregate** sequential run (all 3 candidates combined):
- **Max user-turn submissions:** `18` total (`<= 6` per candidate: 1 warm-up + 5 measured screening turns; no reallocation of a blocked candidate's 6-turn slot).
- **Max model dispatches:** `18` (`maxRetries = 0`, `preemptiveGeneration = false` -> 1 dispatch/turn).
- **Max aggregate paid-active time:** `15 minutes` (`900,000 ms`), enforced as `<= 5 minutes` (`300,000 ms`) per candidate (`<= 60,000 ms`–`90,000 ms` per turn).
- **Direct Speech Caps (Aurvin + LiveKit Agents combined, 12 turns):**
  - Max direct STT input audio streamed: `120,000 ms` (`2.0 min` total across 12 turns of 6–8 s each; hard guard `<= 300,000 ms` / `5.0 min` even if idle silence streams while active).
  - Max TTS text submitted: `8,000 UTF-8 bytes` (`4,000 bytes` per candidate; note 8 turns in Nov 5 baseline used only `1,871` bytes total).
- **Deepgram Voice Agent Caps (6 turns, if ever unblocked by user decision):** `<= 5.0 min` session time, `<= 4,000` UTF-8 bytes TTS buffer.
- **LiveKit Cloud Room Caps (Aurvin + LiveKit Agents):** `<= 10.0 min` aggregate room time.

#### Worked Conservative Ceiling Example (Using Reference `anthropic/claude-haiku-5.5` Worst-Case Catalogue Tier `$0.50/1M` in, `$2.50/1M` out)

1. **Profile A — Existing `60,000` context / `6,000` output ceilings (`live-budget.ts` style):**
   - OpenRouter: `18 × (60,000 × $0.0000005 + 6,000 × $0.0000025) = 18 × $0.045 = $0.8100`
   - Direct Flux STT (up to 5 min active stream): `5 × $0.0077 = $0.0385`
   - Direct Flux TTS (8,000 bytes): `8 × $0.045 = $0.3600`
   - Deepgram Voice Agent reserve (5 min × `$0.065` + 4,000-byte Flux TTS buffer `$0.180`): `$0.3250 + $0.1800 = $0.5050`
   - LiveKit Cloud room buffer (10 min × `$0.01/agent-min`): `$0.1000` *(or `$0.2000` at `$0.02/room-min`, subtotal `$1.9135`)*
   - Subtotal = `$1.8135` -> **with 10% safety margin (`× 1.10`): `$1.9949 <= $2.00`**!
2. **Profile B — Recommended Voice-Screening Output Ceiling (`maxContextTokens = 40,000`–`45,000` above `computeChatFloor`, `maxOutputTokens = 1,024` via explicit benchmark-only snapshot override):**
   - Check `computeChatFloor`: `system.md` (10,691 B) + `product_knowledge.md` (1,522 B) + max personalization + worst-case tool reservation + `MIN_HISTORY_TOKENS = 10,000` + `maxOutputTokens = 1,024` + `modelMarginTokens = 1,024` -> floor is ~30k–36k byte-units (`computeChatFloor` computes the exact floor at runtime; `maxContextTokens = 45,000` safely exceeds it).
   - OpenRouter at `45,000 / 1,024`: `18 × (45,000 × $0.0000005 + 1,024 × $0.0000025) = 18 × $0.02506 = $0.4511`
   - Direct Flux STT (5 min): `$0.0385`
   - Direct Flux TTS (8,000 bytes): `$0.3600`
   - Deepgram Voice Agent reserve (5 min + TTS buffer): `$0.5050`
   - LiveKit Cloud buffer (10 min × `$0.02/room-min`): `$0.2000`
   - Subtotal = `$1.5546` -> **with 10% safety margin (`× 1.10`): `$1.7101 <= $2.00`**!

> **Dynamic Fail-Closed Rule:** Regardless of worked examples, `shared/budget-guard.ts` MUST compute `conservativeCeilingUsd` dynamically from the **live OpenRouter catalogue rates** of the actual configured `OPENROUTER_MODEL` before admitting any live candidate. If `conservativeCeilingUsd > 2.00`, preflight aborts (`BUDGET_ENVELOPE_EXCEEDED`) with zero paid calls. Remember: application reservations are not a hard vendor invoice cap.

---

## 7. Recommended `benchmarks/voice-architectures/` Structure & Shared Contracts

### 7.1 Isolated Directory Layout

```text
benchmarks/voice-architectures/
├── .gitignore                 # Ignores results/, audio/, *.pcm, *.local.json (keeps tracked *.md reports)
├── package.json               # Isolated ESM TypeScript package; zero root workspace edits
├── package-lock.json          # Solely owned by P1
├── tsconfig.json              # NodeNext ESM ("module": "nodenext", "target": "ES2023", "strict": true)
├── vitest.config.ts
├── README.md                  # Setup, prerequisites, commands, credential import, future browser eval
├── report.md                  # Compiled main benchmark report + verdict (generated by runner/compiler)
├── shared/
│   ├── contracts.ts           # CandidateId, TurnScenario, TurnObservation, ArchitectureReport, Verdict types
│   ├── credentials.ts         # Read-only .env parser + read-only DB config fallback + SecretRedactor
│   ├── corpus.ts              # 6-turn deterministic synthetic corpus loader/validator
│   ├── make-corpus.ps1        # Offline Windows System.Speech generator (16 kHz mono PCM16 + speechEndMs)
│   ├── budget-guard.ts        # Shared US$2 / 18-turn / 15-min / per-dispatch / TTS-byte / STT-ms guard
│   ├── timing.ts              # Single-process monotonic clock spans + nearest-rank summary helpers
│   ├── webrtc-participant.ts  # Shared headless @livekit/rtc-node caller (16 kHz 80 ms pace, 24 kHz nonzero decode, interruption & stale-tail)
│   ├── compiler.ts            # Compiles per-architecture JSON/report.md into benchmarks/voice-architectures/report.md
│   ├── cli.ts                 # Sequential runner (--candidate aurvin|livekit-agents|deepgram-agent|all, dry-run default, --live)
│   └── __tests__/             # Offline unit/guard/redaction/corpus/compiler tests
├── aurvin/
│   ├── harness.ts             # P1: isolated AppService + synthetic UserAccount + LiveKit participant driver
│   ├── report.ts              # Formats benchmarks/voice-architectures/aurvin/report.md + raw JSON
│   ├── __tests__/             # Routing, recovery, VOICE_DELIVERY_UNKNOWN preservation, isolation tests
│   └── report.md
├── livekit-agents/
│   ├── harness.ts             # P2: real @livekit/agents AgentSession + STTv2 + Silero + OpenRouter + TTSv2
│   ├── openrouter-client.ts   # Custom OpenAI client (maxRetries: 0, guardedFetch, user/ZDR/max_tokens)
│   ├── report.ts              # Formats benchmarks/voice-architectures/livekit-agents/report.md + raw JSON
│   ├── __tests__/             # Silero Windows smoke, config identity, connOptions maxRetry:0, interruption fixtures
│   └── report.md
└── deepgram-agent/
    ├── harness.ts             # P3: real Deepgram Voice Agent v1 WebSocket client + fail-closed BYO preflight
    ├── protocol.ts            # Settings builder, event parser, pcm framer, interruption cutoff observer
    ├── report.ts              # Formats benchmarks/voice-architectures/deepgram-agent/report.md + raw JSON
    ├── __tests__/             # Settings schema, BYO preflight block, event parsing, stale-tail/close fixtures
    └── report.md
```

### 7.2 Recommended `benchmarks/voice-architectures/package.json`

- `"name": "voice-architecture-benchmark"`, `"private": true`, `"type": "module"`, `"engines": { "node": "^22.22.3 || ^24.15.0 || >=26.0.0" }`
- **Scripts:**
  - `"build": "tsc -p tsconfig.json"`
  - `"lint": "tsc --noEmit"` (plus `oxlint` if added as devDep)
  - `"test": "vitest run"`
  - `"corpus:generate": "powershell -NoProfile -File shared/make-corpus.ps1"`
  - `"bench": "node dist/shared/cli.js"` (dry-run by default)
  - `"bench:aurvin": "node dist/shared/cli.js --candidate=aurvin"`
  - `"bench:livekit-agents": "node dist/shared/cli.js --candidate=livekit-agents"`
  - `"bench:deepgram-agent": "node dist/shared/cli.js --candidate=deepgram-agent"`
  - `"bench:compile": "node dist/shared/cli.js --compile-only"`
- **Dependencies (exact pins to reconcile in `P1`):**
  - `@livekit/agents`: `1.10.0`
  - `@livekit/agents-plugin-deepgram`: `1.10.0`
  - `@livekit/agents-plugin-openai`: `1.10.0`
  - `@livekit/agents-plugin-silero`: `1.10.0`
  - `@livekit/rtc-node`: `1.2.2`
  - `livekit-server-sdk`: `2.19.2`
  - `mongodb`: `6.21.0`
  - `openai`: `^6.8.1`
  - `ws`: `^8.18.0`
  - `zod`: `3.25.76`
- **DevDependencies:**
  - `@types/node`: `^24.0.0`
  - `@types/ws`: `^8.5.14`
  - `typescript`: `^6.0.2`
  - `vitest`: `^4.1.2`

### 7.3 Shared Synthetic 6-Turn Corpus Contract (`shared/corpus.ts` & `shared/make-corpus.ps1`)

All audio generated offline on Windows (`System.Speech`, 16 kHz, 16-bit signed LE PCM, mono, 80 ms / 2560-byte frames, exact `sha256`, exact `speechEndMs` at last nonzero sample + 2,000 ms trailing silence):

| Turn Index | Scenario Role | Excluded From Percentiles? | Synthetic Utterance Design | Interruption / Timing Behavior |
| --- | --- | --- | --- | --- |
| `0` | `warmup-cold` | Yes (`warmup: true`) | `"Hello Aurvin, please confirm you can hear me in one short sentence."` | Establishes cold setup (`setupMs`), warms session/STT/TTS/caches. |
| `1` | `ordinary-reply` | No | `"In two short sentences, explain why the sky looks blue."` | Fresh/first measured turn in active session; wait for full response completion. |
| `2` | `warm-followup` | No | `"And in one short sentence, why does it look orange at sunset?"` | Sent in the **same warm session** after Turn 1 finishes (measures warm follow-up without setup). |
| `3` | `hesitation-pause` | No | Two synthesized speech segments separated by `800 ms` of exact silence: `"Wait... [800 ms silence] ...why do clouds look white?"` | `speechEndMs` placed at end of second segment. Tests whether candidate prematurely responds during mid-utterance pause (`earlyEndpoint = true`) vs waiting until true end. |
| `4` | `interrupt-target` | No (separate interruption group) | `"In four complete sentences, explain how the water cycle moves water from oceans to rain."` | Wait for first decoded nonzero PCM + `600 ms` active output window (`interruptionAnchorObserved = true`), then inject Turn 5 while Turn 4 is still speaking. |
| `5` | `barge-in-interrupt` | No (separate interruption group) | `"Stop, just tell me what evaporation means in one sentence."` | Triggered at `interruptionMarkerClockMs` (when barge-in input begins). Measures `interruptionToOutputCutoffMs` + fixed `1000 ms` stale-tail observation (`staleTailFrames`, `staleTailBytes`), then Turn 5 reply onset. |

### 7.4 Shared Candidate & Report Contracts (`shared/contracts.ts`)

Every candidate implements a single exported `ArchitectureHarness` interface:

```ts
export type CandidateId = 'aurvin' | 'livekit-agents' | 'deepgram-agent';

export type PreflightResult = {
  candidate: CandidateId;
  status: 'ready' | 'blocked' | 'failed';
  reasons: string[];
  checkedAtIso: string;
  capabilities: {
    userAttribution: boolean | 'unknown';
    zeroDataRetention: boolean | 'unknown';
    maxOutputTokensEnforced: boolean | 'unknown';
    zeroRetriesEnforced: boolean | 'unknown';
    speculationDisabled: boolean | 'unknown';
    fluxSttSupported: boolean;
    fluxTtsSupported: boolean;
  };
  provenance: Record<string, string | number | boolean | null>;
};

export type TurnObservation = {
  candidate: CandidateId;
  turnIndex: number;               // 0..5
  scenario: 'warmup-cold' | 'ordinary-reply' | 'warm-followup' | 'hesitation-pause' | 'interrupt-target' | 'barge-in-interrupt';
  warmup: boolean;
  sessionPhase: 'cold-setup' | 'warm-session' | 'recovered-session';
  outcome: 'completed' | 'unverified-playback' | 'interrupted-ok' | 'early-endpoint' | 'blocked' | 'failed' | 'timeout';
  failureCode: string | null;
  setupMs: number | null;
  connectStageMs: Record<string, number | null>; // e.g. livekitJoinMs, sttConnectMs, ttsConnectMs
  speechEndToFirstAudioMs: number | null;        // null if unmeasured or early failure
  speechEndToThinkingMs: number | null;
  modelFirstOutputMs: number | null;
  ttsFirstAudioMs: number | null;
  interruptionToCutoffMs: number | null;         // Turn 4/5 only
  staleTailObservedMs: number | null;            // Fixed 1000 ms window after cutoff
  staleTailNonzeroFrames: number | null;
  streamGapCount: number;
  maxStreamGapMs: number | null;
  inputPacingMaxLatenessMs: number | null;
  decodedPlaybackProof: 'unproven-headless-pcm-only';
  durableCompletionStatus: 'completed' | 'unknown' | 'not-applicable';
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    providerReportedUsd: number | null;
    sttAudioMs: number | null;
    ttsInputBytes: number | null;
    sessionActiveMs: number | null;
    estimatedCostUsd: number | null;
    unknownCostComponents: string[];
  };
};
```

### 7.5 Per-Architecture `report.md` & Compiled Main `benchmarks/voice-architectures/report.md` Verdict Schema

- **Per-architecture `benchmarks/voice-architectures/<candidate>/report.md`** (generated deterministically from `<candidate>/latest-result.json`):
  1. **Run Metadata & Provenance:** `candidate`, `mode` (`dry-run` | `live`), git commit/dirty status, `node -v`, OS, locked package versions, effective nonsecret settings (`modelId`, `sttModel`, `ttsModel`, `region`, `maxContextTokens`, `maxOutputTokens`, `eotThreshold`, `eotTimeoutMs`, `preemptiveGeneration`, `maxRetries`), and `PreflightResult`.
  2. **Boundary & Proof Disclosure:** Explicit note that decoded 24 kHz PCM receipt is **not** physical speaker audibility; Aurvin `VOICE_DELIVERY_UNKNOWN` / `BENCHMARK_UNPROVEN_PLAYBACK` preserved verbatim.
  3. **Scenario & Per-Turn Table:** All 6 attempted turns (including warm-up, blocked, failed, unverified), showing `turnIndex`, `scenario`, `sessionPhase`, `outcome`, `setupMs`, `speechEndToFirstAudioMs`, `modelFirstOutputMs`, `ttsFirstAudioMs`, `interruptionToCutoffMs`, `staleTailNonzeroFrames`, `streamGapCount`, `maxStreamGapMs`, `durableCompletionStatus`.
  4. **Separated Group Summaries (median + min–max range; exploratory small-sample p95 labeled as exploratory only):** Cold setup (`Turn 0`), Ordinary/Warm turns (`Turns 1–2`), Hesitation (`Turn 3`), Interruption (`Turns 4–5`).
  5. **Costs & Unknowns:** Exact OpenRouter reported cost/tokens, estimated STT/TTS/Voice-Agent/LiveKit costs, and explicit list of unknown billing components.
  6. **Cleanup & Remaining Limitations:** Rooms created & `deleteRoom` outcome, isolated DB name (for `aurvin`), open socket count (`0`), and specific failure/limitation notes.

- **Compiled `benchmarks/voice-architectures/report.md`** (built by `shared/compiler.ts`):
  1. **Executive Verdict & Qualifications:** States which candidates ran live vs preflight-blocked, states clearly that **separate completion/proof contracts cannot create a false winner** (e.g., Aurvin's strict `playback.progress` contract vs LiveKit Agents' framework truncation vs Deepgram Voice Agent BYO block), and names the qualified architectural recommendation plus exact conditions under which a blocked candidate could be reconsidered.
  2. **Side-by-Side Comparison Tables (Separated, Never Collapsed):**
     - Table A: **Capability & Policy Compliance Matrix** (`user` attribution, `data_collection: 'deny'`, `max_tokens`, `maxRetries: 0`, speculation off, playback proof contract).
     - Table B: **Setup & Speech-End → First Decoded Nonzero Audio** (cold vs warm follow-up vs hesitation, median & range).
     - Table C: **Interruption Cutoff & Stale-Tail Continuity** (interruption cutoff ms, 1000 ms stale-tail nonzero frame count, streaming gaps, heard-history fidelity).
     - Table D: **Aggregate Envelope & Cost Reconciliation** (`totalTurns <= 18`, `totalActiveMs <= 900_000`, `conservativeReserveUsd <= 2.00`, actual reported + estimated + unknown costs).
  3. **Links to All Three Per-Architecture Reports & Artifact Hashes.**
  4. **Explicit Limitations & Future Browser-Audible Evaluation Protocol.**

---

## 8. Handoff Summary for Parallel Planners (`P1`, `P2`, `P3`)

1. **`P1` (`shared/` + `aurvin/` + root `package.json`/`package-lock.json`):**
   - Owns `benchmarks/voice-architectures/package.json` (with all packages in §7.2 locked), `.gitignore`, `tsconfig.json`, `vitest.config.ts`, `shared/`, `aurvin/`, and `benchmarks/voice-architectures/README.md`.
   - Implements read-only `.env` + read-only DB `config` fallback + `SecretRedactor`, Windows `make-corpus.ps1`, dynamic `BudgetGuard` (fetching `/api/v1/models` at preflight), shared headless `@livekit/rtc-node` participant, sequential runner + report compiler, and Aurvin baseline via `AppService.create` (with `ports.assets`, `ports.authProvider` stub, isolated DB + synthetic `UserAccount`, `readOnlyConfigRepo`, `VOICE_DELIVERY_UNKNOWN` preservation + recovery handling).
2. **`P2` (`livekit-agents/`):**
   - Owns `benchmarks/voice-architectures/livekit-agents/` only; requests any package changes via P1.
   - Implements standalone `AgentSession` + `RoomIO` (with `STTv2`, `TTSv2`, `silero.VAD`, and custom `OpenAI` `client` into `openai.LLM` enforcing `user`, `data_collection: 'deny'`, `transforms: []`, `max_tokens`, `maxRetries: 0`, and `BudgetGuard`).
   - Must include Windows `silero.VAD.load()` offline test, `TTSv2` abort/buffer-clear test, `connOptions.maxRetry = 0` & `preemptiveGeneration.enabled = false` configuration tests, and `livekit-agents/report.md` generator.
3. **`P3` (`deepgram-agent/`):**
   - Owns `benchmarks/voice-architectures/deepgram-agent/` only.
   - Implements genuine Deepgram Voice Agent v1 client (`Settings` builder for Flux `v2` STT/TTS + `think.endpoint`, event parser, interruption/stale-tail observer) **plus** the fail-closed `preflightDeepgramAgent` gate checking `GET /v1/auth/token` and blocking direct BYO OpenRouter (`BLOCKED_BYO_CONTROLS_UNSUPPORTED`) unless an explicit user exception/decision changes the policy.
   - Must include protocol/guard/error/stale-tail fixtures and `deepgram-agent/report.md` generator documenting the exact unsupported controls.
