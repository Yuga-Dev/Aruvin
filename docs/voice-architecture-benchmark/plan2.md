# LiveKit Agents Voice Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the genuine, independently selectable LiveKit Agents/Flux/Silero/OpenRouter candidate, with fail-closed expenditure controls, deterministic cancellation tests, and an honest architecture-specific report.

**Architecture:** Use one standalone `voice.AgentSession` over a connected RTC `Room`; let the installed framework own recognition, generation, interruption, output buffering, and conversation-context truncation. Reuse P1's authorization, `BudgetGuard`, corpus, monotonic clock, headless participant, artifact writer, and aggregation rather than recreating them. Keep P2-specific configuration, guarded OpenAI transport, framework lifecycle, and report disclosure adapter inside `benchmarks/voice-architectures/livekit-agents/`.

**Tech Stack:** Node 24.18.0 on Windows x64; ESM/TypeScript NodeNext; Vitest; `@livekit/agents@1.10.0`, `@livekit/agents-plugin-deepgram@1.10.0`, `@livekit/agents-plugin-silero@1.10.0`, `@livekit/agents-plugin-openai@1.10.0`, `@livekit/rtc-node@1.2.2`, `livekit-server-sdk@2.19.2`, `openai@^6.8.1`, `zod@3.25.76`.

---

## Status, ownership, and hard gates

This is a **plan**, not evidence that dependencies, Windows native inference, tests, or live calls succeeded. Unified review is **skipped**, not passed. P2 implementation starts only after the P1 **worker** has completed, tested, and committed the shared package.

- Planner writes **only this document**. Do not install dependencies, run provider/media calls, stage, or commit.
- Worker writes **only** `benchmarks/voice-architectures/livekit-agents/**`. This includes any local fixture, evidence adapter, or explanatory README needed by P2.
- Do not edit `shared/`, either package manifest/lockfile, root configuration, `backend/`, `frontend/`, `.env`, or production state. Report an upstream deficiency to the orchestrator/P1.
- P1 owns all package installation and dependency reconciliation. No worker `npm install`, `npm ci`, `npx` download, framework upgrade, ambient credential fallback, worker deployment, or public listener.
- V1, not P2, runs the paid pilot and publishes actual per-candidate `report.md`/JSON results. P2 implements and fixture-tests the formatter. Do not commit a synthetic report as a live result.
- Suggested atomic commit subjects below are **handoff requests**. The orchestrator stages named files and serializes commits; do not execute `git add`/`git commit`.
- Preserve the unrelated working-tree changes reported by `git status --short`. Isolation is a comparison against that initial state, not a requirement to reset the checkout.

### Important correction to research's abbreviated start example

The version-pinned published `agent_session.d.ts` declares:

```ts
start({
  agent,
  room,
  inputOptions,
  outputOptions,
  record,
}: {
  agent: Agent;
  room?: Room;
  inputOptions?: Partial<RoomInputOptions>;
  outputOptions?: Partial<RoomOutputOptions>;
  record?: boolean | RecordingOptions;
}): Promise<void>;
```

Use `inputOptions.participantIdentity`; **do not pass `roomOptions.audioInput`**. `start` creates its RoomIO when `room` is supplied. Do not create a second RoomIO, second recognition loop, or second output track.

### P1 interface handoff: an explicit prerequisite, not an invented shared API

Research §7.4 names `ArchitectureHarness` and `ArchitectureReport`, but its code block defines only `CandidateId`, `PreflightResult`, and `TurnObservation`. It does **not** define harness method signatures, report members, `BudgetGuard` methods, or participant-driver methods. At planning time `benchmarks/` does not exist.

Before Task 1, obtain the committed P1 exports and confirm the following exact **behavioral** bindings:

1. A per-run immutable context: candidate/run identity, mode, trusted user ID, credential handles, model/voice/region/configuration fingerprints, matched synthetic instructions/history, verified token-cap parameter, finite deadlines, and the one shared monotonic clock.
2. An authorization check that runs before any room/provider connection; in offline mode it must refuse egress without needing credentials. Changed/expired authorization or configuration must stop subsequent egress too.
3. An atomic, nonrefundable model-dispatch reservation against the **same aggregate** `BudgetGuard`; it rejects missing/already-consumed submission authority and accounts for failed/cancelled attempts. A framework-generated extra turn cannot acquire free authority.
4. Synchronous STT-duration and conservative TTS-byte reservations; no deferred accounting after provider dispatch.
5. Dedicated-room ownership and the shared RTC caller/scenario driver. Caller subscription is pinned to the agent identity/track; agent input is pinned to the caller. The driver distinguishes assistant-generation epochs for interruption measurement.
6. Artifact redaction/writing, cleanup evidence, and report aggregation including actual source/build/lock/corpus hashes.
7. The actual `ArchitectureHarness` and `ArchitectureReport` signatures, candidate registration/export convention, and deterministic test fixtures.

**Required action if any binding is absent:** stop the affected task and send the orchestrator the missing export/signature and the minimal P1 change needed. Do not create a second budget, copy a shared implementation, assert-cast a fake harness to `ArchitectureHarness`, or guess a caller API.

The code below intentionally defines P2's small normalized ports locally. They are not proposed edits to `shared/contracts.ts`. The final binding task must use the real P1 contract with `satisfies`/a return annotation and no `any`, `unknown as ArchitectureHarness`, or duplicate shared interface.

**Planning-time reconciliation:** P1's concurrently authored `plan1.md` now specifies the concrete proposed contract:

```ts
export interface ArchitectureHarness {
  readonly id: CandidateId;
  preflight(context: RunContext): Promise<PreflightResult>;
  run(context: RunContext, preflight: PreflightResult): Promise<ArchitectureReport>;
}
```

Export **`harness`**, not `livekitAgentsHarness`. `RunContext` includes `mode`, `runId`, `repoRoot`, `packageRoot`, `outputDir`, `startedAtIso`, `clock`, `signal`, nullable `credentials`/`guard`, `corpus`, and `redactor`. The report has `schemaVersion`, run metadata, `preflight`, `provenance`, `turns`, `cleanup`, `envelope`, and `limitations`. Use `emptyTurn` for test defaults and `summarize`/`DecodedObserver`/`pacePcm` from shared timing. P1's discovery is `**/__tests__/**/*.test.ts`, so all P2 tests use that suffix. Verify these against the **worker commit** before execution; planner text is not implementation evidence.

P1 additionally requires enforcement on actual installed-plugin speech **opens/sends**. These pinned plugin options expose no socket-factory injection. Guarding Agent nodes provides finite input bounds but is not, by itself, evidence that every delayed/reconnected socket open/send is admitted. Unless P1's committed safe egress seam proves that requirement without modifying dependencies or global production networking, return `BLOCKED_AGENTS_SPEECH_EGRESS_UNGUARDED` **before any room/provider connection**. Keep the real pipeline and offline tests; never silently waive this gate to run a live candidate.

## File map

All paths below are relative to the repository unless a command explicitly names its working directory.

| File | Responsibility |
| --- | --- |
| `benchmarks/voice-architectures/livekit-agents/config.ts` | Exact plugin/session/start options and real offline Silero check. |
| `benchmarks/voice-architectures/livekit-agents/openrouter-client.ts` | One real OpenAI client; request normalization, policy enforcement, attribution, finite token limits, atomic shared-budget handoff. |
| `benchmarks/voice-architectures/livekit-agents/harness.ts` | Framework-backed session construction, bounded lifecycle, shared-driver integration, concrete `ArchitectureHarness` export. |
| `benchmarks/voice-architectures/livekit-agents/report.ts` | Pure deterministic presentation of shared report data; no independent writer or cost estimator. |
| `benchmarks/voice-architectures/livekit-agents/__tests__/config.test.ts` | Real package identity/options and real native Silero inference; no cloud access. |
| `benchmarks/voice-architectures/livekit-agents/__tests__/openrouter-client.test.ts` | Request/SDK fixtures, routing/privacy/caps/attribution, rejection, cancellation, zero SDK retry. |
| `benchmarks/voice-architectures/livekit-agents/__tests__/harness.test.ts` | No-network admission, standalone startup, guard-before-frame/text, lifecycle races and shared-contract binding. |
| `benchmarks/voice-architectures/livekit-agents/__tests__/interruption.test.ts` | Actual framework cancellation/output clear and actual TTSv2 stream abort using offline transport fixtures. |
| `benchmarks/voice-architectures/livekit-agents/__tests__/report.test.ts` | Exact report boundaries, nulls/failures, every attempt, grouped results, escaping/redaction. |
| `benchmarks/voice-architectures/livekit-agents/report.md` | V1-generated final result, **not** a worker-written fabricated observation. |

No separate custom STT, TTS, VAD, LLM loop, latency framework, credential loader, room-service abstraction, CLI, or cost calculator is needed.

## Commands and test discipline

Unless stated otherwise, command working directory is `benchmarks/voice-architectures/`.

```bash
npm exec --no -- vitest run livekit-agents/__tests__/config.test.ts
npm exec --no -- vitest run livekit-agents/__tests__/openrouter-client.test.ts
npm exec --no -- vitest run livekit-agents/__tests__/harness.test.ts
npm exec --no -- vitest run livekit-agents/__tests__/interruption.test.ts
npm exec --no -- vitest run livekit-agents/__tests__/report.test.ts
```

`npm exec --no` uses the already installed binary and must not download Vitest. An absent package is a P1 prerequisite failure, not permission to install it. Require nonzero test discovery. Real Silero load/inference must **run**, not skip; native-load failure is a compatibility block before live work, not a passing mock.

Each task follows RED → observe the named failure → implement only that task → GREEN. Use P1's no-egress setup for tests; also deny `globalThis.fetch` and provider socket creation in native-only/configuration tests. The test doubles below use synthetic credentials such as `fixture-key`; never read `.env` from tests.

### Mandatory headers

Every new `.ts` file, including fixtures and tests, starts with its expanded header before imports. This is the exact header for the first file:

```ts
/**
 * ============================================================================
 * FILE: config.ts
 * LOCATION: benchmarks/voice-architectures/livekit-agents/config.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Pin the benchmark's real LiveKit Agents configuration and native VAD check.
 *
 * ROLE IN PROJECT:
 *    Supplies P2's standalone framework candidate without changing Aurvin.
 *    Consumes only the isolated package and P1-owned run configuration.
 *
 * KEY COMPONENTS:
 *    - sessionOptions: Explicit matched turn, interruption, and retry controls.
 *    - loadSilero: Offline Windows native-load and dummy-inference admission.
 * ============================================================================
 */
```

For the other files, use their exact `FILE`/`LOCATION` from the file map, their one-line responsibility as `PURPOSE`, and these non-placeholder component lists:

- `openrouter-client.ts`: `guardedFetch` — last pre-dispatch policy/budget boundary; `createOpenRouterLlm` — actual OpenAI/plugin client.
- `harness.ts`: `GuardedAgent` — pre-provider speech accounting; `openSession` — real standalone AgentSession; `bounded` — cancellation/deadline boundary; concrete shared harness export — P1 integration.
- `report.ts`: `withLivekitBoundaries` — candidate-specific disclosures; shared formatter/writer wrappers — preserve raw evidence and nulls.
- `config.test.ts`: exact plugin identities; native Silero inference.
- `openrouter-client.test.ts`: request policy fixtures; zero-retry/cancellation fixtures.
- `harness.test.ts`: admission/lifecycle fixtures; shared-contract conformance.
- `interruption.test.ts`: real framework output-clear fixture; real TTSv2 abort fixture.
- `report.test.ts`: deterministic report fixture; proof/cost/escaping assertions.

Keep headers in final files; the subsequent code blocks are file bodies **after these headers**. Standard Node/SDK APIs used below are not locally reimplemented.

---

## Task 1: Pin genuine framework configuration and prove offline Windows Silero inference

**Files**

- Create `benchmarks/voice-architectures/livekit-agents/config.ts`.
- Create `benchmarks/voice-architectures/livekit-agents/__tests__/config.test.ts`.

- [ ] **Step 1: Read the installed declarations without network or package changes.**

Check `AgentSession.start`, `RoomInputOptions`, `RoomOutputOptions`, `STTv2Options.endpointUrl`, `TTSv2Options.baseUrl`, `TurnHandlingOptions`, and plugin labels against the pinned artifacts listed under Sources. Confirm the installed versions via P1's lock/version utility. It must identify Agents/plugins `1.10.0`, RTC `1.2.2`, server SDK `2.19.2`, Zod `3.25.76`, and an OpenAI `6.x` satisfying `^6.8.1`; do not report a requested range as an observed locked version.

- [ ] **Step 2: Write these exact failing assertions.**

Test body after the mandatory `config.test.ts` header:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { voice } from '@livekit/agents';
import { sessionOptions, startOptions, speechOptions, loadSilero } from '../config.js';

afterEach(() => vi.unstubAllGlobals());

it('keeps STT endpoint authority, VAD interruption, and all retry layers explicit', () => {
  const session = new voice.AgentSession({ ...sessionOptions(), vad: null });
  expect(session.sessionOptions.turnHandling).toMatchObject({
    turnDetection: 'stt',
    endpointing: { mode: 'fixed', minDelay: 0, maxDelay: 0 },
    interruption: {
      enabled: true, mode: 'vad', minDuration: 500,
      minWords: 0, resumeFalseInterruption: false,
    },
    preemptiveGeneration: { enabled: false, preemptiveTts: false, maxRetries: 0 },
  });
  for (const name of ['llmConnOptions', 'sttConnOptions', 'ttsConnOptions'] as const) {
    expect(session.connOptions[name].maxRetry).toBe(0);
  }
  expect(session.connOptions.maxUnrecoverableErrors).toBe(1);
  expect(session.sessionOptions.expressive).toBe(false);
  expect(session.sessionOptions.aecWarmupDuration).toBeNull();
});

it('pins only the synthetic participant and selects exact regional Flux URLs', () => {
  expect(startOptions('caller-fixture')).toMatchObject({
    inputOptions: {
      participantIdentity: 'caller-fixture', textEnabled: false,
      audioSampleRate: 16000, audioNumChannels: 1,
      closeOnDisconnect: true, deleteRoomOnClose: false,
    },
    outputOptions: {
      audioSampleRate: 24000, audioNumChannels: 1, queueSizeMs: 200,
    },
    record: false,
  });
  expect(speechOptions('eu')).toEqual({
    sttUrl: 'wss://api.eu.deepgram.com/v2/listen',
    ttsUrl: 'https://api.eu.deepgram.com/v2/speak',
  });
  expect(() => speechOptions('unverified-region')).toThrow('UNSUPPORTED_SPEECH_REGION');
});

it('loads real Silero and completes real dummy PCM inference with fetch denied', async () => {
  const fetcher = vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); });
  vi.stubGlobal('fetch', fetcher);
  const vad = await loadSilero();
  expect(vad.label).toBe('silero.VAD');
  expect(fetcher).not.toHaveBeenCalled();
  await vad.close();
}, 30000);
```

The shared no-egress setup must deny HTTP(S)/WebSocket egress as well, not just `fetch`. P1 must supply that test isolation before this suite is accepted.

- [ ] **Step 3: Run RED.**

Run `npm exec --no -- vitest run livekit-agents/__tests__/config.test.ts`.

Expected: FAIL resolving `../config.js`, not a cloud-authentication error.

- [ ] **Step 4: Implement the configuration and real VAD smoke.**

`config.ts` body:

```ts
import { initializeLogger, VADEventType, voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import * as silero from '@livekit/agents-plugin-silero';

// Standalone sessions do not run the CLI's logger bootstrap. Keep SDK payload
// logging disabled; only P1's allowlisted/redacted benchmark evidence is emitted.
initializeLogger({ pretty: false, level: 'silent' });

export function sessionOptions(): voice.AgentSessionOptions {
  return {
    turnHandling: {
      turnDetection: 'stt',
      endpointing: { mode: 'fixed', minDelay: 0, maxDelay: 0 },
      interruption: {
        enabled: true, mode: 'vad', minDuration: 500, minWords: 0,
        resumeFalseInterruption: false,
      },
      preemptiveGeneration: {
        enabled: false, preemptiveTts: false, maxRetries: 0,
      },
    },
    connOptions: {
      llmConnOptions: { maxRetry: 0, timeoutMs: 10000 },
      sttConnOptions: { maxRetry: 0, timeoutMs: 10000 },
      ttsConnOptions: { maxRetry: 0, timeoutMs: 10000 },
      maxUnrecoverableErrors: 1,
    },
    // Headless synthetic input has no acoustic echo path to calibrate.
    aecWarmupDuration: null,
    userAwayTimeout: null,
    expressive: false,
    ttsReadIdleTimeout: 10000,
    forwardAudioIdleTimeout: 10000,
  };
}

export function startOptions(participantIdentity: string) {
  if (!participantIdentity) throw new Error('MISSING_CALLER_IDENTITY');
  return {
    inputOptions: {
      participantIdentity, audioEnabled: true, textEnabled: false,
      videoEnabled: false, audioSampleRate: 16000, audioNumChannels: 1,
      closeOnDisconnect: true, deleteRoomOnClose: false,
    },
    outputOptions: {
      audioEnabled: true, audioSampleRate: 24000, audioNumChannels: 1,
      transcriptionEnabled: false, queueSizeMs: 200,
    },
    record: false,
  } satisfies Omit<Parameters<voice.AgentSession['start']>[0], 'room' | 'agent'>;
}

export function speechOptions(region: string) {
  if (region !== 'us' && region !== 'eu') {
    throw new Error('UNSUPPORTED_SPEECH_REGION');
  }
  const host = region === 'eu' ? 'api.eu.deepgram.com' : 'api.deepgram.com';
  return {
    sttUrl: `wss://${host}/v2/listen`,
    ttsUrl: `https://${host}/v2/speak`,
  };
}

export async function loadSilero() {
  const vad = await silero.VAD.load({ sampleRate: 16000, forceCPU: true });
  const stream = vad.stream();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stream.close();
  }, 10000);
  try {
    stream.pushFrame(new AudioFrame(new Int16Array(512), 16000, 1, 512));
    const event = await stream.next();
    if (timedOut || event.done || event.value.type !== VADEventType.INFERENCE_DONE ||
        !Number.isFinite(event.value.probability)) {
      throw new Error('SILERO_INFERENCE_MISSING');
    }
    return vad;
  } catch (error) {
    await vad.close();
    throw error;
  } finally {
    clearTimeout(timer);
    if (!timedOut) stream.close();
  }
}
```

Wrap `loadSilero()` in Task 4's bounded offline preparation before invoking it from preflight. A missing ONNX asset/VC++ runtime is `BLOCKED_SILERO_NATIVE_LOAD`, with the sanitized cause category; no runtime download or non-Silero substitute. The pinned VAD implementation does not guarantee iterator exhaustion from `endInput()`: await one actual inference event and explicitly close the smoke stream, with a finite deadline. Offline preparation duration is excluded from paid setup timing.

- [ ] **Step 5: Run GREEN and request the atomic commit.**

Run the same command; expected three executed tests PASS, including native inference. Add installed-version assertions using the **existing P1 version helper**, not another package resolver. Request subject:

`feat(voice-benchmark): pin LiveKit Agents policy and native Silero preflight`

---

## Task 2: Enforce OpenRouter policy at the actual OpenAI fetch boundary

**Files**

- Create `benchmarks/voice-architectures/livekit-agents/openrouter-client.ts`.
- Create `benchmarks/voice-architectures/livekit-agents/__tests__/openrouter-client.test.ts`.

`GuardPorts` below is a local normalized call to the **one shared BudgetGuard**, not a second ledger. Its reservation must include the active accepted submission, model dispatch ceiling, verified prompt/output bound, current rate reservation, authorization fingerprint, and paid-active deadline.

- [ ] **Step 1: Write the failing transport/SDK tests.**

Test body after header:

```ts
import { expect, it, vi } from 'vitest';
import { guardedFetch, createOpenRouterLlm, type RouterPolicy } from '../openrouter-client.js';

const policy: RouterPolicy = {
  modelId: 'fixture/model', userId: 'fixture-user', apiKey: 'fixture-key',
  outputCap: 128, capParameter: 'max_tokens',
  contextCap: 4096, timeoutMs: 10000,
};
const payload = {
  model: policy.modelId, messages: [{ role: 'user', content: 'synthetic input' }],
  stream: true, max_completion_tokens: 128,
};
function setup() {
  const reserve = vi.fn();
  const signal = new AbortController().signal;
  const transport = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
  const fetcher = guardedFetch(policy, { reserve, signal }, transport);
  return { reserve, transport, fetcher };
}

it('rewrites the real outbound request with trusted attribution, privacy, and one cap', async () => {
  const s = setup();
  await s.fetcher('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', body: JSON.stringify(payload),
  });
  const [request] = s.transport.mock.calls[0]!;
  const sent = request instanceof Request ? request : new Request(request);
  const body = await sent.json();
  expect(body).toMatchObject({
    user: 'fixture-user', max_tokens: 128,
    provider: { data_collection: 'deny', require_parameters: true, allow_fallbacks: false },
    transforms: [],
    plugins: [
      { id: 'context-compression', enabled: false }, { id: 'web', enabled: false },
      { id: 'file-parser', enabled: false }, { id: 'response-healing', enabled: false },
    ],
    stream_options: { include_usage: true },
  });
  expect(body).not.toHaveProperty('max_completion_tokens');
  expect(body).not.toHaveProperty('tools');
  expect(sent.redirect).toBe('error');
  expect(s.reserve).toHaveBeenCalledTimes(1);
  expect(s.reserve.mock.invocationCallOrder[0])
    .toBeLessThan(s.transport.mock.invocationCallOrder[0]!);
});

it.each([
  ['https://api.openai.com/v1/chat/completions', payload],
  ['https://openrouter.ai/api/v1/chat/completions?route=other', payload],
  ['https://openrouter.ai/api/v1/models', payload],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, model: 'other/model' }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, user: 'other-user' }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, max_tokens: 129 }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, tools: [{}] }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, n: 2 }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, messages: [] }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, messages: [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://invalid/' } }] },
  ] }],
])('rejects unsupported egress/body before reservation or transport: %s', async (url, body) => {
  const s = setup();
  await expect(s.fetcher(url, { method: 'POST', body: JSON.stringify(body) })).rejects.toThrow();
  expect(s.reserve).not.toHaveBeenCalled();
  expect(s.transport).not.toHaveBeenCalled();
});

it('does not transmit when shared reservation is denied or cancellation already occurred', async () => {
  const s = setup();
  s.reserve.mockImplementation(() => { throw new Error('BUDGET_ENVELOPE_EXCEEDED'); });
  await expect(s.fetcher('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', body: JSON.stringify(payload),
  })).rejects.toThrow();
  expect(s.transport).not.toHaveBeenCalled();
  const abort = new AbortController();
  abort.abort();
  await expect(s.fetcher('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', signal: abort.signal, body: JSON.stringify(payload),
  })).rejects.toThrow();
  expect(s.transport).not.toHaveBeenCalled();
});

it('uses the real OpenAI client with zero retry on a retryable 429', async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    new Response('{"error":{"message":"fixture"}}', {
      status: 429, headers: { 'content-type': 'application/json' },
    }));
  const reserve = vi.fn();
  const { client } = createOpenRouterLlm(policy, {
    reserve, signal: new AbortController().signal,
  }, transport);
  expect(client.maxRetries).toBe(0);
  await expect(client.chat.completions.create({
    model: policy.modelId, messages: [{ role: 'user', content: 'synthetic' }],
    stream: true, max_completion_tokens: 128,
  })).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(reserve).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run RED.**

Run `npm exec --no -- vitest run livekit-agents/__tests__/openrouter-client.test.ts`.

Expected: FAIL resolving `../openrouter-client.js`.

- [ ] **Step 3: Write the complete guarded client body.**

```ts
import OpenAI from 'openai';
import * as openai from '@livekit/agents-plugin-openai';

export type RouterPolicy = {
  modelId: string;
  userId: string;
  apiKey: string;
  outputCap: number;
  capParameter: 'max_tokens' | 'max_completion_tokens';
  contextCap: number;
  timeoutMs: number;
};
export type GuardPorts = {
  signal: AbortSignal;
  reserve(body: Readonly<Record<string, unknown>>): void;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function boundedJson(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 200000)) {
    throw new Error('OPENROUTER_REQUEST_TOO_LARGE');
  }
  if (!request.body) throw new Error('OPENROUTER_BODY_MISSING');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel(request.signal.reason).catch(() => {}); };
  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 200000) throw new Error('OPENROUTER_REQUEST_TOO_LARGE');
      chunks.push(next.value);
    }
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function checkedPolicy(p: RouterPolicy) {
  if (!p.modelId || !p.userId || !p.apiKey ||
      !Number.isSafeInteger(p.outputCap) || p.outputCap < 1 ||
      !Number.isSafeInteger(p.contextCap) || p.contextCap <= p.outputCap ||
      !Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0 ||
      !['max_tokens', 'max_completion_tokens'].includes(p.capParameter)) {
    throw new Error('INVALID_ROUTER_POLICY');
  }
}

export function guardedFetch(p: RouterPolicy, guard: GuardPorts, transport: typeof fetch): typeof fetch {
  checkedPolicy(p);
  return async (input, init) => {
    const incoming = new Request(input, init);
    const signal = AbortSignal.any([
      incoming.signal, guard.signal, AbortSignal.timeout(p.timeoutMs),
    ]);
    const request = new Request(incoming, { signal });
    const url = new URL(request.url);
    if (url.origin !== 'https://openrouter.ai' ||
        url.pathname !== '/api/v1/chat/completions' ||
        url.search || url.hash || url.username || url.password ||
        request.method !== 'POST') {
      throw new Error('OPENROUTER_EGRESS_DENIED');
    }
    guard.signal.throwIfAborted();
    request.signal.throwIfAborted();
    const raw = await boundedJson(request);
    if (!object(raw) || raw.model !== p.modelId ||
        (raw.user !== undefined && raw.user !== p.userId) ||
        raw.stream !== true || (raw.n !== undefined && raw.n !== 1)) {
      throw new Error('OPENROUTER_REQUEST_DENIED');
    }
    const permitted = new Set([
      'model', 'messages', 'stream', 'stream_options', 'user', 'n',
      'max_tokens', 'max_completion_tokens', 'temperature', 'top_p',
      'provider', 'transforms', 'plugins', 'store', 'tool_choice',
    ]);
    if (Object.keys(raw).some((key) => !permitted.has(key)) ||
        (raw.tool_choice !== undefined && raw.tool_choice !== 'none')) {
      throw new Error('OPENROUTER_UNSUPPORTED_PARAMETER');
    }
    if (!Array.isArray(raw.messages) || raw.messages.length === 0 ||
        raw.messages.some((message: unknown) => !object(message) ||
          !['system', 'user', 'assistant'].includes(String(message.role)) ||
          typeof message.content !== 'string' ||
          Object.keys(message).some((key) => !['role', 'content'].includes(key)))) {
      throw new Error('OPENROUTER_CONTEXT_DENIED');
    }
    if (raw.max_tokens !== undefined && raw.max_completion_tokens !== undefined &&
        raw.max_tokens !== raw.max_completion_tokens) {
      throw new Error('OPENROUTER_OUTPUT_CAP_DENIED');
    }
    for (const key of ['max_tokens', 'max_completion_tokens'] as const) {
      const cap = raw[key];
      if (cap !== undefined && (!Number.isSafeInteger(cap) ||
          typeof cap !== 'number' || cap < 1 || cap > p.outputCap)) {
        throw new Error('OPENROUTER_OUTPUT_CAP_DENIED');
      }
    }
    // Byte ceiling is an additional finite request bound, not a tokenizer claim.
    // The shared reservation independently validates the verified context budget.
    if (Buffer.byteLength(JSON.stringify(raw.messages), 'utf8') > p.contextCap) {
      throw new Error('OPENROUTER_CONTEXT_CAP_DENIED');
    }
    const body: Record<string, unknown> = {
      ...raw,
      user: p.userId,
      provider: { data_collection: 'deny', require_parameters: true, allow_fallbacks: false },
      transforms: [],
      plugins: ['context-compression', 'web', 'file-parser', 'response-healing']
        .map((id) => ({ id, enabled: false })),
      stream_options: { include_usage: true },
      store: false,
    };
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.tool_choice;
    // Use the catalogue-verified parameter; never send both parameters.
    body[p.capParameter] = p.outputCap;
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${p.apiKey}`);
    headers.set('content-type', 'application/json');
    signal.throwIfAborted();
    guard.reserve(Object.freeze(body));
    signal.throwIfAborted();
    return transport(new Request(request.url, {
      method: 'POST', headers, body: JSON.stringify(body),
      redirect: 'error', signal,
    }));
  };
}

class NoProbeLlm extends openai.LLM {
  // Catalogue verification is P1's explicit preflight, not a hidden session probe.
  protected override async _prewarmImpl(_signal: AbortSignal): Promise<void> {}
}

export function createOpenRouterLlm(p: RouterPolicy, guard: GuardPorts, transport: typeof fetch) {
  const client = new OpenAI({
    apiKey: p.apiKey, baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 0, timeout: p.timeoutMs,
    fetch: guardedFetch(p, guard, transport),
  });
  const llm = new NoProbeLlm({
    client, apiKey: p.apiKey, baseURL: 'https://openrouter.ai/api/v1',
    model: p.modelId, user: p.userId, maxCompletionTokens: p.outputCap,
    parallelToolCalls: false, toolChoice: 'none', store: false,
  });
  return { client, llm };
}
```

The byte ceiling is a deliberate conservative additional limit; it must be explicit in configuration provenance. Do not claim it proves model token equality. P1's verified context/token reservation remains authoritative. If the installed plugin emits an extra field, inspect it and either safely admit that exact field with a fixture or block; do not widen the allowlist to arbitrary passthrough.

Normalized privacy/routing/plugin fields override conflicting caller values under the explicit benchmark-only policy. Disable each currently supported OpenRouter plugin explicitly, rather than assuming an empty array overrides account defaults. User/model mismatches, tools/functions, multimodal content, alternate endpoints, and unsupported controls reject before dispatch. Both output-cap names are checked; unequal aliases reject, then exactly the catalogue-selected one is sent. Cancellation does not refund a consumed reservation or prove the provider did not bill.

- [ ] **Step 4: Add remaining exact negative cases and run GREEN.**

Extend the parameterized test rows with missing body, invalid JSON, `GET`, host userinfo, HTTP URL, fractional/zero/negative caps, conflicting cap aliases, `functions`, `web_search_options`, nonempty tool calls inside a message, and oversize context. Assert zero transport calls. Add:

```ts
it('supports the verified max_completion_tokens variant without also sending max_tokens', async () => {
  const reserve = vi.fn();
  let sent: Record<string, unknown> = {};
  const transport: typeof fetch = async (input, init) => {
    sent = await new Request(input, init).json();
    return new Response('');
  };
  await guardedFetch({ ...policy, capParameter: 'max_completion_tokens' }, {
    reserve, signal: new AbortController().signal,
  }, transport)('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ ...payload, max_tokens: 128 }),
  });
  expect(sent.max_completion_tokens).toBe(128);
  expect(sent).not.toHaveProperty('max_tokens');
});

it('propagates cancellation to the actual in-flight fetch without another dispatch', async () => {
  const abort = new AbortController();
  let reached!: () => void;
  const ready = new Promise<void>((resolve) => { reached = resolve; });
  const transport = vi.fn<typeof fetch>((input, init) => {
    const request = new Request(input, init);
    reached();
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  });
  const pending = guardedFetch(policy, { reserve: vi.fn(), signal: abort.signal }, transport)(
    'https://openrouter.ai/api/v1/chat/completions',
    { method: 'POST', body: JSON.stringify(payload) },
  );
  await ready;
  abort.abort(new Error('BENCHMARK_CANCELLED'));
  await expect(pending).rejects.toThrow('BENCHMARK_CANCELLED');
  expect(transport).toHaveBeenCalledTimes(1);
});
```

Run the Task 2 command. Expected: all executed tests PASS. Request subject:

`feat(voice-benchmark): guard real OpenRouter SDK requests and disable retries`

---

## Task 3: Construct one actual Agents pipeline and put speech guards before provider input

**Files**

- Create `benchmarks/voice-architectures/livekit-agents/harness.ts`.
- Create `benchmarks/voice-architectures/livekit-agents/__tests__/harness.test.ts`.

Keep the local normalized port narrow. P1 maps its actual exported guard methods into these callbacks without P2 editing shared files. `assertActive` rechecks authorization, configuration fingerprint, candidate active time, and cancellation; it is not just a boolean captured at startup.

- [ ] **Step 1: Write failing real-plugin identity tests and guard-order tests.**

Test body after header:

```ts
import { expect, it, vi } from 'vitest';
import { voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import { makePipeline, GuardedAgent, type PipelineInput } from '../harness.js';
import { loadSilero } from '../config.js';

function input(vad: PipelineInput['vad']): PipelineInput {
  return {
    vad, instructions: 'Synthetic benchmark. Answer the user briefly.',
    history: [], callerIdentity: 'caller-fixture', region: 'us',
    sttModel: 'flux-general-en', ttsModel: 'flux-haley-en',
    eotThreshold: 0.8, eotTimeoutMs: 5000, deepgramKey: 'fixture-key',
    router: {
      modelId: 'fixture/model', userId: 'fixture-user', apiKey: 'fixture-key',
      outputCap: 128, capParameter: 'max_tokens', contextCap: 4096, timeoutMs: 10000,
    },
    guard: {
      signal: new AbortController().signal,
      assertActive: vi.fn(), reserve: vi.fn(), stt: vi.fn(), tts: vi.fn(),
    },
    fetcher: vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }),
  };
}

it('constructs actual STTv2, Silero, OpenAI plugin LLM, TTSv2, and AgentSession', async () => {
  const vad = await loadSilero();
  const p = makePipeline(input(vad));
  try {
    expect(p.session).toBeInstanceOf(voice.AgentSession);
    expect(p.session.stt).toBeInstanceOf(deepgram.STTv2);
    expect(p.session.vad).toBe(vad);
    expect(p.session.llm).toBeInstanceOf(openai.LLM);
    expect(p.session.tts).toBeInstanceOf(deepgram.TTSv2);
    expect(p.session.stt?.model).toBe('flux-general-en');
    expect(p.session.tts?.model).toBe('flux-haley-en');
    expect(p.session.tts?.sampleRate).toBe(24000);
    expect(p.agent).toBeInstanceOf(GuardedAgent);
    expect(p.client.maxRetries).toBe(0);
  } finally {
    await p.close();
    await vad.close();
  }
}, 30000);

it('charges conservative TTS bytes before text reaches the actual default node', async () => {
  const settings = { toolChoice: 'none' as const };
  const guard = { signal: new AbortController().signal, assertActive: vi.fn(),
    reserve: vi.fn(), stt: vi.fn(), tts: vi.fn() };
  const seen: string[] = [];
  const spy = vi.spyOn(voice.Agent.default, 'ttsNode').mockImplementation(async (_agent, text) => {
    for await (const chunk of text) seen.push(chunk);
    return null;
  });
  try {
    const agent = new GuardedAgent({ instructions: 'synthetic' }, guard);
    await agent.ttsNode((async function* () { yield 'hi'; })(), settings);
    expect(guard.tts).toHaveBeenCalledWith(5); // 2 UTF-8 bytes + 2 code units + 1
    expect(seen).toEqual(['hi']);
    guard.tts.mockImplementation(() => { throw new Error('TTS_BUDGET_EXCEEDED'); });
    await expect(agent.ttsNode((async function* () { yield 'blocked'; })(), settings))
      .rejects.toThrow('TTS_BUDGET_EXCEEDED');
    expect(seen).toEqual(['hi']);
  } finally {
    spy.mockRestore();
  }
});
```

- [ ] **Step 2: Run RED.**

Run `npm exec --no -- vitest run livekit-agents/__tests__/harness.test.ts`.

Expected: FAIL resolving `../harness.js`.

- [ ] **Step 3: Implement the actual plugin/session construction.**

`harness.ts` initial body after header:

```ts
import { llm, voice, type VAD } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import type { AudioFrame, Room } from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import { sessionOptions, speechOptions, startOptions } from './config.js';
import { createOpenRouterLlm, type GuardPorts, type RouterPolicy } from './openrouter-client.js';

export type SpeechGuard = GuardPorts & {
  assertActive(): void;
  stt(audioMs: number): void;
  tts(conservativeUtf8Bytes: number): void;
};
export type PipelineInput = {
  vad: VAD;
  instructions: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  callerIdentity: string;
  region: string;
  sttModel: string;
  ttsModel: string;
  eotThreshold: number;
  eotTimeoutMs: number;
  deepgramKey: string;
  router: RouterPolicy;
  guard: SpeechGuard;
  fetcher: typeof fetch;
};

export class GuardedAgent extends voice.Agent {
  constructor(options: ConstructorParameters<typeof voice.Agent>[0], private readonly guard: SpeechGuard) {
    super(options);
  }

  override async sttNode(
    audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
    settings: voice.ModelSettings,
  ) {
    const guard = this.guard;
    const checked = (async function* () {
      for await (const frame of audio) {
        guard.signal.throwIfAborted();
        guard.assertActive();
        if (frame.sampleRate !== 16000 || frame.channels !== 1 ||
            frame.samplesPerChannel <= 0 ||
            frame.data.length !== frame.samplesPerChannel) {
          throw new Error('UNEXPECTED_INPUT_AUDIO_FORMAT');
        }
        guard.stt(frame.samplesPerChannel / frame.sampleRate * 1000);
        yield frame;
      }
    })();
    return voice.Agent.default.sttNode(this, checked, settings);
  }

  override async ttsNode(
    text: ReadableStream<string> | AsyncIterable<string>,
    settings: voice.ModelSettings,
  ) {
    const guard = this.guard;
    const checked = (async function* () {
      for await (const chunk of text) {
        guard.signal.throwIfAborted();
        guard.assertActive();
        // Flux's word tokenizer appends spaces. Reserve their worst-case cost too.
        // ponytail: conservative per-code-unit padding over-reserves; an exact
        // tokenizer-wire counter is the upgrade if the six-turn pilot hits this cap.
        guard.tts(Buffer.byteLength(chunk, 'utf8') + chunk.length + 1);
        yield chunk;
      }
    })();
    return voice.Agent.default.ttsNode(this, checked, settings);
  }
}

export function makePipeline(input: PipelineInput) {
  input.guard.assertActive();
  const urls = speechOptions(input.region);
  if (!input.deepgramKey || input.sttModel !== 'flux-general-en' ||
      !/^flux-[a-z0-9-]+-en$/.test(input.ttsModel) ||
      !Number.isFinite(input.eotThreshold) || input.eotThreshold <= 0 ||
      input.eotThreshold > 1 || !Number.isSafeInteger(input.eotTimeoutMs) ||
      input.eotTimeoutMs <= 0) {
    throw new Error('UNSUPPORTED_SPEECH_CONFIGURATION');
  }
  const stt = new deepgram.STTv2({
    apiKey: input.deepgramKey, model: input.sttModel, sampleRate: 16000,
    endpointUrl: urls.sttUrl, eotThreshold: input.eotThreshold,
    eotTimeoutMs: input.eotTimeoutMs, mipOptOut: true,
    // Deliberately omit eagerEotThreshold.
  });
  // The custom node wraps audio. This streaming Flux path never requires manual flushing.
  stt.capabilities.manualFlush = false;
  const tts = new deepgram.TTSv2({
    apiKey: input.deepgramKey, model: input.ttsModel, sampleRate: 24000,
    encoding: 'linear16', baseUrl: urls.ttsUrl, mipOptOut: true,
  });
  const router = createOpenRouterLlm(input.router, input.guard, input.fetcher);
  const chatCtx = new llm.ChatContext();
  for (const message of input.history) {
    chatCtx.addMessage({ role: message.role, content: message.content });
  }
  const agent = new GuardedAgent({
    instructions: input.instructions, chatCtx, tools: [],
  }, input.guard);
  const session = new voice.AgentSession({
    ...sessionOptions(), stt, vad: input.vad, llm: router.llm, tts, tools: [],
  });
  let closing: Promise<void> | undefined;
  return {
    session, agent, client: router.client,
    start(room: Room) {
      input.guard.signal.throwIfAborted();
      input.guard.assertActive();
      return session.start({ room, agent, ...startOptions(input.callerIdentity) });
    },
    close() {
      closing ??= (async () => {
        const outcomes = await Promise.allSettled([
          session.close(), tts.close(), stt.close(), router.llm.aclose(),
        ]);
        if (outcomes.some((outcome) => outcome.status === 'rejected')) {
          throw new Error('AGENTS_CLEANUP_UNCERTAIN');
        }
      })();
      return closing;
    },
  };
}
```

`vad` is run-owned and closed by the outer owner after session teardown; do not close a preflight VAD and then start a session with it. If multiple preflight/run calls occur, dispose unused instances explicitly.

- [ ] **Step 4: Add guard and actual `start` option regressions.**

Use the same test `input()` fixture, and these additional test bodies:

```ts
it('charges each STT frame, including silence, before recognition receives it', async () => {
  const { AudioFrame } = await import('@livekit/rtc-node');
  const guard = { signal: new AbortController().signal, assertActive: vi.fn(),
    reserve: vi.fn(), stt: vi.fn(), tts: vi.fn() };
  const seen: number[] = [];
  const spy = vi.spyOn(voice.Agent.default, 'sttNode').mockImplementation(async (_agent, audio) => {
    for await (const frame of audio) seen.push(frame.samplesPerChannel);
    return null;
  });
  try {
    const agent = new GuardedAgent({ instructions: 'synthetic' }, guard);
    await agent.sttNode((async function* () {
      yield new AudioFrame(new Int16Array(1280), 16000, 1, 1280);
    })(), {});
    expect(guard.stt).toHaveBeenCalledWith(80);
    expect(seen).toEqual([1280]);
    guard.assertActive.mockImplementation(() => { throw new Error('AUTHORIZATION_EXPIRED'); });
    await expect(agent.sttNode((async function* () {
      yield new AudioFrame(new Int16Array(1280), 16000, 1, 1280);
    })(), {})).rejects.toThrow('AUTHORIZATION_EXPIRED');
    expect(seen).toEqual([1280]);
  } finally {
    spy.mockRestore();
  }
});
```

For `start`, spy on `p.session.start`, pass a P1 fixture `Room`, and assert **the actual argument** contains that same `room`, `p.agent`, `inputOptions.participantIdentity`, no `roomOptions`, `record: false`, and no greeting/generateReply call. This test must use P1's typed Room fixture, not an `as unknown as Room` production escape hatch.

Add a fake WebSocket transport integration check that observes `STTv2`'s actual URL: `/v2/listen`, configured host/model, `eot_threshold`, `eot_timeout_ms`, `mip_opt_out=true`, **no** `eager_eot_threshold`. Observe real TTSv2 URL `/v2/speak`, same configured voice, `linear16`, `24000`, `mip_opt_out=true`. Reuse Task 5's EventEmitter socket fixture; no live connection is needed.

- [ ] **Step 5: Run GREEN and request the atomic commit.**

Run Task 3's command and Tasks 1–2. Expected: real plugins instantiate without provider network; all guard-before-provider and option tests PASS. Request subject:

`feat(voice-benchmark): assemble real standalone LiveKit Agents pipeline`

---

## Task 4: Bound startup, cancellation, early close, timeout, and owned cleanup

**Files**

- Modify `benchmarks/voice-architectures/livekit-agents/harness.ts`.
- Modify `benchmarks/voice-architectures/livekit-agents/__tests__/harness.test.ts`.

P1 supplies `createParticipant`, PCM pacing, decoded observation, and budget primitives. P2's SDK lifecycle is fixture-testable without a cloud connection. Actual room creation, agent AccessToken minting, and per-candidate conversational scheduling would be part of an admitted live extension; Task 7 currently blocks that path because the speech egress seam is missing. Do not assume P1 exports a room/scenario service it has not implemented, deploy a worker, or use `cli.runApp`.

### Required lifecycle

1. Offline mode: dependency/configuration/native checks only. No room, socket, OpenRouter request, TTS prewarm, or credential-dependent check.
2. Authorized live mode: current preflight + current shared budget/rate/configuration admission → owned room/caller/agent connection → one `makePipeline().start(agentRoom)`.
3. No `onEnter` greeting, `session.say`, or `session.generateReply` from production harness code. Only accepted synthetic audio initiates a conversational turn.
4. Shared driver reserves each of the six submitted inputs, including warm-up and barge-in. Context includes synthetic instructions/history **once**. Do not inject the known corpus transcript into `generateReply` as well as replaying audio.
5. Register `error`, `close`, abort, and deadline listeners **before** startup; recognize close during `start` as failure even if `start` subsequently resolves.
6. First terminal cause wins. Abort outstanding inference/media, stop accepting input, and preserve partial onset/usage. Cancellation maps to shared `outcome: 'failed'` with `failureCode: 'BENCHMARK_CANCELLED'` because research's outcome union has no `cancelled` member.
7. Start/turn/run deadlines come from shared caps: candidate ≤300000 ms; aggregate ≤900000 ms; no invented extra allowance. Use turn deadline ≤60000 ms unless P1's tighter bounded policy applies.
8. Cleanup is idempotent and independently bounded (5000 ms ceiling within the remaining aggregate deadline). Close framework/provider resources, stop caller readers/pacing, disconnect both RTC rooms, delete only the owned room, dispose VAD, remove listeners/timers, and report each result.
9. A cleanup timeout/error is `cleanup uncertain`, never silently converted to zero sockets/success. Do not refund paid-active time or delete evidence to rerun.

- [ ] **Step 1: Write the failing bounded-race checks.**

Append to `harness.test.ts`:

```ts
import { bounded } from '../harness.js';

it('aborts a hung operation at the finite deadline', async () => {
  vi.useFakeTimers();
  const operation = vi.fn((signal: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
  try {
    const result = bounded(operation, new AbortController().signal, 100, 'BENCHMARK_TIMEOUT');
    const assertion = expect(result).rejects.toThrow('BENCHMARK_TIMEOUT');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(operation.mock.calls[0]![0].aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('does not start work after cancellation and propagates an early startup failure', async () => {
  const abort = new AbortController();
  abort.abort(new Error('BENCHMARK_CANCELLED'));
  const operation = vi.fn(async () => 1);
  await expect(bounded(operation, abort.signal, 100, 'BENCHMARK_TIMEOUT'))
    .rejects.toThrow('BENCHMARK_CANCELLED');
  expect(operation).not.toHaveBeenCalled();
  await expect(bounded(async () => { throw new Error('AGENTS_EARLY_CLOSE'); },
    new AbortController().signal, 100, 'BENCHMARK_TIMEOUT'))
    .rejects.toThrow('AGENTS_EARLY_CLOSE');
});
```

- [ ] **Step 2: Run RED.**

Run `npm exec --no -- vitest run livekit-agents/__tests__/harness.test.ts -t "finite deadline|after cancellation"`.

Expected: FAIL because `bounded` is not exported.

- [ ] **Step 3: Add the bounded operation helper.**

Append to `harness.ts`:

```ts
export async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
  timeoutCode: string,
): Promise<T> {
  parent.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(timeoutCode);
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => controller.abort(new Error(timeoutCode)), timeoutMs);
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([operation(signal), interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
```

A Promise race alone does not stop native work. Every caller must wire the supplied signal into its operation and execute `finally` cleanup. Specifically, `Room.connect`/`AgentSession.start` lack a per-call AbortSignal in this API: register abort to close/disconnect owned resources and keep a completion handler on the late startup promise that closes/disconnects again if cancellation already won. Do not leave late successful resources alive.

Use P1's bounded resource-owner helper if it already provides these exact semantics; in that case import/re-export it locally instead of maintaining a duplicate helper, and run the same tests against it.

- [ ] **Step 4: Implement and test session terminal-event arbitration.**

Append this reusable small session boundary; it avoids reading raw exception payloads into evidence:

```ts
export async function openSession(
  pipeline: ReturnType<typeof makePipeline>,
  room: Room,
  signal: AbortSignal,
  timeoutMs: number,
) {
  const ended = new AbortController();
  const onClose = () => ended.abort(new Error('AGENTS_EARLY_CLOSE'));
  const onError = () => ended.abort(new Error('AGENTS_PROVIDER_ERROR'));
  pipeline.session.on(voice.AgentSessionEventTypes.Close, onClose);
  pipeline.session.on(voice.AgentSessionEventTypes.Error, onError);
  const active = AbortSignal.any([signal, ended.signal]);
  let startup: Promise<void> | undefined;
  let failed = false;
  try {
    await bounded(async (opening) => {
      const stop = () => {
        void pipeline.close().catch(() => {});
        void room.disconnect().catch(() => {});
      };
      opening.addEventListener('abort', stop, { once: true });
      try {
        startup = pipeline.start(room);
        await startup;
        opening.throwIfAborted();
      } finally {
        opening.removeEventListener('abort', stop);
      }
    }, active, timeoutMs, 'AGENTS_SETUP_TIMEOUT');
    active.throwIfAborted();
    return {
      signal: active,
      dispose() {
        pipeline.session.off(voice.AgentSessionEventTypes.Close, onClose);
        pipeline.session.off(voice.AgentSessionEventTypes.Error, onError);
      },
    };
  } catch (error) {
    failed = true;
    // Late setup completion must not resurrect a cancelled room/session.
    void startup?.finally(async () => {
      if (failed) {
        // Startup may have completed after the cached owner-close already ran.
        await Promise.allSettled([pipeline.session.close(), room.disconnect()]);
      }
    }).catch(() => {});
    throw error;
  } finally {
    if (failed) {
      pipeline.session.off(voice.AgentSessionEventTypes.Close, onClose);
      pipeline.session.off(voice.AgentSessionEventTypes.Error, onError);
    }
  }
}
```

The outer owner must always close/disconnect in `finally`, even if opening failed before a return value existed. The returned `signal` remains attached to close/error events for the **whole scenario run**, not just startup; call `dispose()` only after driving stops. Suppressed cleanup errors in emergency callbacks are recorded by the outer awaited cleanup, never used to claim success.

Use P1's typed fixture room/session owner to execute this exact matrix:

| Exact test name | Trigger | Required assertions |
| --- | --- | --- |
| `offline selection never creates a room or provider connection` | dry-run | only offline checks; all network factories called zero times |
| `expired authorization prevents TTS prewarm and room join` | shared admission throws | zero plugin start/room creation/paid requests |
| `close emitted while start is pending wins over late start success` | close event then resolve start | failed code; late completion closed/disconnected; no corpus submission |
| `provider error after first decoded audio preserves partial onset and fails once` | error during output | partial onset retained; one failed terminal observation; no retry |
| `cancellation during setup aborts resources and rejects late successful setup` | abort while connect/start held | no subsequent input/LLM; eventual room disconnected; cleanup bounded |
| `timeout during generation aborts the model and closes speech streams` | hung response + fake monotonic deadline | timeout outcome; one dispatch; no late successful result |
| `early close before first response does not become completion or interruption success` | provider close before PCM | failed outcome, null onset/cutoff, no fabricated zero latency |
| `cleanup runs once after success failure timeout and repeated close` | parameterized four causes | only owned room deleted, room/source IDs retained, no live handles claimed without observation |
| `cleanup timeout remains uncertain and prevents the next candidate from starting` | held close/delete | explicit uncertainty; shared sequential runner refuses overlap |

Run startup/terminal/cleanup assertions against the real `makePipeline`/`openSession` functions and typed fixture resources. Run no-network admission assertions against Task 7's concrete harness. Tests that require an admitted live conversation driver are explicitly pending the blocked extension, not passing acceptance evidence. Use `vi.useFakeTimers` and deferred promises; no sleeps or network.

- [ ] **Step 5: Run GREEN and request the atomic commit.**

Run Task 4's focused command, then the full `harness.test.ts`. Request subject:

`feat(voice-benchmark): bound Agents lifecycle and preserve cleanup uncertainty`

---

## Task 5: Prove actual TTSv2 abort and framework output clear without inventing playback proof

**Files**

- Create `benchmarks/voice-architectures/livekit-agents/__tests__/interruption.test.ts`.
- Modify `benchmarks/voice-architectures/livekit-agents/harness.ts` only if a regression exposes a P2 lifecycle defect.

Do **not** add a custom `Interrupt` message, `playback_offset`, transcript slicing heuristic, early consumer mute, or audio suppression at the headless receiver. Those would change the candidate or manufacture a successful cutoff.

### Three separate proofs

1. **Transport fixture:** actual `deepgram.TTSv2.stream()` aborts its real `SynthesizeStreamv2`, closes/removes its pooled WebSocket, ignores late provider frames, and uses a fresh connection for the next stream.
2. **Framework fixture:** actual `voice.AgentSession.interrupt({ force: true })` cancels its generation/audio source and calls the configured output's `clearBuffer()`. This is cancellation plumbing, not a live VAD latency measurement.
3. **Shared decoded observer fixture:** onset/600 ms anchor, interrupt marker, output cutoff, and fixed 1000 ms stale-tail window are computed from subscriber PCM on the shared monotonic clock, **not** from `interrupt()` resolution or provider terminal events.

Configuration/native tests establish actual Silero identity and 500 ms VAD interruption policy separately. Do not call a programmatic-interrupt fixture proof of Silero classification latency.

- [ ] **Step 1: Add the real TTSv2 socket fixture and failing regression.**

The following test body uses a mocked `ws` transport, not a mock TTS plugin. Keep its mock isolated in this file so real native/configuration tests retain actual imports.

```ts
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const sockets = vi.hoisted(() => ({ all: [] as Array<{
  readyState: number; url: string; sent: string[];
  emit(event: string, ...args: unknown[]): boolean;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  close(): void;
}> }));

vi.mock('ws', () => {
  class WebSocket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent: string[] = [];
    constructor(readonly url: string) {
      super();
      sockets.all.push(this);
      queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
    }
    send(data: string | Buffer) {
      this.sent.push(String(data));
      if (String(data).includes('"type":"Flush"')) {
        queueMicrotask(() => this.emit('message', Buffer.alloc(9600, 1), true));
      }
      if (String(data).includes('"type":"Close"')) {
        queueMicrotask(() => this.emit('message', Buffer.from('{}'), false));
      }
    }
    close() { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)); }
    terminate() { this.close(); }
    ping() {}
  }
  return { WebSocket, default: WebSocket };
});

import '../config.js';
import * as deepgram from '@livekit/agents-plugin-deepgram';

beforeEach(() => { sockets.all.length = 0; });

it('actual TTSv2 abort closes the old stream and never sends playback_offset Interrupt', async () => {
  const tts = new deepgram.TTSv2({
    apiKey: 'fixture-key', model: 'flux-haley-en',
    baseUrl: 'https://api.deepgram.com/v2/speak',
    sampleRate: 24000, encoding: 'linear16', mipOptOut: true,
  });
  const stream = tts.stream({
    connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 100 },
  });
  try {
    stream.pushText('synthetic output long enough to be cancelled ');
    stream.flush();
    const first = await stream.next();
    expect(first.done).toBe(false);
    const old = sockets.all[0]!;
    const oldClosed = new Promise<void>((resolve) => old.once('close', () => resolve()));
    stream.close();
    expect(stream.abortSignal.aborted).toBe(true);
    old.emit('message', Buffer.alloc(9600, 2), true);
    for await (const buffered of stream) {
      if (typeof buffered !== 'symbol') {
        expect(buffered.frame.data.every((sample) => sample === 257)).toBe(true);
      }
    }
    expect(old.sent.some((packet) => /Interrupt|playback_offset/.test(packet))).toBe(false);
    await oldClosed;
    expect(old.readyState).toBe(3);
    const next = tts.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 100 },
    });
    try {
      next.pushText('new synthetic generation ');
      next.flush();
      const firstNew = await next.next();
      expect(firstNew.done).toBe(false);
      if (!firstNew.done && typeof firstNew.value !== 'symbol') {
        expect(firstNew.value.frame.data.every((sample) => sample === 257)).toBe(true);
      }
      expect(sockets.all).toHaveLength(2);
    } finally {
      next.close();
    }
  } finally {
    stream.close();
    await tts.close();
  }
  expect(sockets.all.every((socket) => socket.readyState === 3)).toBe(true);
});
```

TTSv2 holds one last frame until the next packet; the fixture emits exactly 9600 bytes, enough PCM for more than one plugin frame. Drain any already-buffered pre-abort prefix; it is not a newly arriving provider tail. Assert the late packet's `514` sample sentinel never appears. RoomIO output clearing, tested separately, is what discards an already queued prefix.

The second actual stream asserts two sockets, old-socket closure, and absence of the old late-packet sentinel. This directly tests the pooled-connection abort caveat; merely asserting `abortSignal.aborted` is insufficient.

- [ ] **Step 2: Run RED before fixing a missing binding or test seam.**

Run `npm exec --no -- vitest run livekit-agents/__tests__/interruption.test.ts`.

Expected first failure is a real abort/cutoff assertion or unavailable P1 fixture seam, not a skipped suite. If the installed SDK itself passes the independent transport characterization immediately, record **characterization PASS** and do not manufacture a failure or modify the SDK; the framework/shared-driver wiring tests still precede P2 integration changes.

- [ ] **Step 3: Add the actual framework cancellation fixture.**

Use a real `voice.AgentSession` with no room/network for this fixture. Supply a test-only `voice.AudioOutput` with:

```ts
import { voice } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

class FixtureOutput extends voice.AudioOutput {
  readonly frames: AudioFrame[] = [];
  clears = 0;
  constructor() { super(24000); }
  override async captureFrame(frame: AudioFrame) {
    await super.captureFrame(frame);
    this.frames.push(frame);
  }
  override clearBuffer() {
    this.clears++;
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
  }
  override flush() {
    super.flush();
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: false });
  }
}
```

That zero position is explicitly **test-only framework-output evidence**; it is never submitted as Aurvin `playback.progress`, never written as physical audibility, and never used as live heard-history proof.

Test body:

```ts
it('actual AgentSession interruption clears output and cancels its supplied audio stream', async () => {
  const { AudioFrame } = await import('@livekit/rtc-node');
  const { ReadableStream } = await import('node:stream/web');
  const { sessionOptions } = await import('../config.js');
  const output = new FixtureOutput();
  const session = new voice.AgentSession({ ...sessionOptions(), vad: null });
  const cancelled = vi.fn();
  let captured!: () => void;
  const firstCapture = new Promise<void>((resolve) => { captured = resolve; });
  const original = output.captureFrame.bind(output);
  vi.spyOn(output, 'captureFrame').mockImplementation(async (frame) => {
    await original(frame);
    captured();
  });
  const audio = new ReadableStream<AudioFrame>({
    start(controller) {
      controller.enqueue(new AudioFrame(new Int16Array(480).fill(1), 24000, 1, 480));
    },
    cancel: cancelled,
  });
  session.output.audio = output;
  try {
    await session.start({ agent: new voice.Agent({ instructions: 'synthetic', tools: [] }), record: false });
    session.say('synthetic output', { audio, addToChatCtx: false });
    await firstCapture;
    await session.interrupt({ force: true }).await;
    expect(output.clears).toBeGreaterThan(0);
    expect(cancelled).toHaveBeenCalledTimes(1);
    const count = output.frames.length;
    await Promise.resolve();
    expect(output.frames).toHaveLength(count);
  } finally {
    await session.close();
  }
});
```

Add a RoomIO-specific fixture using P1's typed connected-room/audio-source double. Start the real session with that room and the Task 1 pinning options; spy on the resulting output's public `clearBuffer()` and the fixture `AudioSource.clearQueue()`. Interrupt after actual `captureFrame`; assert both execute. Do not reach into `session._activity`/`_roomIO` to mutate private state. Inspect installed RoomIO source if a public output wrapper hides the concrete sink, and observe the fixture AudioSource call rather than using an unsafe private cast.

- [ ] **Step 4: Exercise the actual shared decoded observer with exact clock/PCM fixtures.**

Append these tests to `interruption.test.ts`; they use P1's reconciled `DecodedObserver`, not another cutoff algorithm:

```ts
import { DecodedObserver } from '../../shared/timing.js';

function observedResponse(withAnchor: boolean) {
  let now = 0;
  const observer = new DecodedObserver({ now: () => now });
  observer.begin('synthetic-A', 300);
  const at = (time: number, nonzero = true) => {
    now = time;
    observer.frame(new Int16Array(480).fill(nonzero ? 1 : 0), 24000, 1);
  };
  if (withAnchor) {
    for (let time = 400; time < 1000; time += 20) at(time);
  }
  now = 1000;
  observer.interrupt();
  return {
    observer, at,
    tick(time: number) { now = time; observer.tick(); },
  };
}

it('no output anchor is not interruption success', () => {
  const fixture = observedResponse(false);
  fixture.at(1100, false);
  fixture.tick(2500);
  expect(fixture.observer.snapshot()).toMatchObject({
    interruptionAnchorObserved: false, interruptionToCutoffMs: null,
    staleTailObservedMs: null, staleTailNonzeroFrames: null,
  });
});

it('cutoff is decoded output cessation not the provider cancellation event', () => {
  const fixture = observedResponse(true);
  // Provider cancellation at 1005 does not call a decoded observer method.
  fixture.at(1020);
  fixture.at(1040); // This 20 ms frame ends at 1060 on this same clock.
  fixture.tick(1160); // 100 ms quiet identifies the provisional cutoff.
  expect(fixture.observer.snapshot().staleTailObservedMs).toBeNull();
  fixture.tick(2060); // Complete the fixed 1000 ms post-cutoff observation.
  expect(fixture.observer.snapshot()).toMatchObject({
    interruptionAnchorObserved: true, interruptionToCutoffMs: 60,
    staleTailObservedMs: 1000, staleTailNonzeroFrames: 0,
  });
});

it('consumer keeps observing late nonzero frames after cancellation', () => {
  const fixture = observedResponse(true);
  fixture.at(1020);
  fixture.at(1040);
  fixture.tick(1160);
  fixture.at(1500);
  fixture.tick(2060);
  expect(fixture.observer.snapshot()).toMatchObject({
    staleTailObservedMs: 1000, staleTailNonzeroFrames: 1, staleTailBytes: 960,
  });
  // Such a result must never be classified interrupted-ok by a run adapter.
});

it('provider terminal without complete tail window remains unknown', () => {
  const fixture = observedResponse(true);
  fixture.at(1020);
  fixture.at(1040);
  fixture.tick(1660);
  expect(fixture.observer.snapshot()).toMatchObject({
    interruptionToCutoffMs: null, staleTailObservedMs: null, staleTailNonzeroFrames: null,
  });
});

it('early hesitation response is identified rather than clamped into a fast onset', () => {
  let now = 800;
  const observer = new DecodedObserver({ now: () => now });
  observer.begin('synthetic-hesitation', 1000);
  observer.frame(new Int16Array(480).fill(1), 24000, 1);
  expect(observer.snapshot()).toMatchObject({
    earlyEndpoint: true, speechEndToFirstAudioMs: null,
  });
  expect(now - 1000).toBe(-200); // Preserve separately as signed raw provenance.
});
```

P1's observer has no generation-ID parameter on `frame()`. Consequently, new-answer audio in the window is **not response-correlated**. An admitted extension must mark `interruptionAttribution: 'boundary-window-only'` or `unknown`; if it cannot disambiguate old/new output, do not publish `interrupted-ok` or rank a successful cutoff. Do not delay/mute the new response or filter arriving PCM to make the fixture pass. This limitation remains explicit even when all five observer tests pass.

- [ ] **Step 5: Verify history boundaries without claiming audible parity.**

After framework interruption, inspect the public `agent.chatCtx`/`session.chatCtx` through the actual next mocked OpenRouter request and retain a bounded synthetic text/hash assertion. Assert that the interrupted assistant content is not blindly the entire originally generated answer; record the SDK's resulting context boundary as `framework-playback-estimated`. If the SDK exposes no trustworthy prefix, record `unknown`, not a locally guessed prefix.

Required disclosure: TTSv2 stream abort + RoomIO buffer clear is not `/v2/speak Interrupt(playback_offset)` reconciliation. Framework chatCtx truncation is based on framework output tracking/estimation, not proven browser/DAC/speaker delivery and not Aurvin's durable heard-history contract.

- [ ] **Step 6: Run GREEN and request the atomic commit.**

Run Task 5's command and `npm exec --no -- vitest run livekit-agents/__tests__`.

Expected: transport characterization, real framework cutoff wiring, shared decoded cutoff/tail negative cases, and history-boundary fixtures execute and PASS. Request subject:

`test(voice-benchmark): verify Agents interruption and Flux stale-tail boundaries`

---

## Task 6: Reuse the shared formatter/writer and add exact LiveKit boundary disclosures

**Files**

- Create `benchmarks/voice-architectures/livekit-agents/report.ts`.
- Create `benchmarks/voice-architectures/livekit-agents/__tests__/report.test.ts`.

P1's `newReport`, `renderArchitectureReport`, and `writeArchitectureReport` already implement tables, scenario grouping, nulls, cost fields, and redaction. The Ponytail reuse rung holds: do not write a second Markdown formatter, group-summary model, file writer, or cost calculator. Add the candidate-specific limitations/provenance once and delegate.

- [ ] **Step 1: Write the exact failing formatter test.**

Test body after header:

```ts
import { expect, it } from 'vitest';
import { newReport } from '../../shared/compiler.js';
import { emptyTurn, offlinePreflight } from '../../shared/contracts.js';
import { formatLivekitReport, withLivekitBoundaries } from '../report.js';

const result = newReport('livekit-agents', '10000000-0000-4000-8000-000000000001',
  'dry-run', offlinePreflight('livekit-agents', ['BLOCKED_SILERO_NATIVE_LOAD']));

it('formats the exact LiveKit report destination with honest blocked and proof boundaries', () => {
  const text = formatLivekitReport(result);
  expect(text).toContain('# livekit-agents voice architecture screening');
  expect(text).toContain('BLOCKED_SILERO_NATIVE_LOAD');
  expect(text).toContain('No turns submitted');
  expect(text).toContain('not physical audibility');
  expect(text).toContain('stream abort + RoomIO buffer clear');
  expect(text).toContain('framework-playback-estimated');
  expect(text).toContain('review: skipped');
  expect(formatLivekitReport(result)).toBe(text);
  expect(withLivekitBoundaries(withLivekitBoundaries(result)))
    .toEqual(withLivekitBoundaries(result));
});

it('uses shared null/escaping/group behavior and keeps all six attempted outcomes', () => {
  const turns = Array.from({ length: 6 }, (_, index) => ({
    ...emptyTurn('livekit-agents', index),
    outcome: 'failed' as const, failureCode: `fixture|reason-${index}`,
    durableCompletionStatus: 'not-applicable' as const,
  }));
  const text = formatLivekitReport({ ...result, turns });
  expect(text).toContain('fixture\\|reason');
  expect(text).toContain('unknown');
  for (let index = 0; index < 6; index++) expect(text).toContain(`reason-${index}`);
  expect(text).toContain('Ordinary/Warm');
  expect(text).toContain('Interruption');
});
```

- [ ] **Step 2: Run RED.**

Run `npm exec --no -- vitest run livekit-agents/__tests__/report.test.ts`.

Expected: FAIL resolving `../report.js`.

- [ ] **Step 3: Implement the small disclosure adapter and shared wrappers.**

`report.ts` body after header:

```ts
import { renderArchitectureReport, writeArchitectureReport } from '../shared/compiler.js';
import { reportSchema, type ArchitectureReport, type RunContext } from '../shared/contracts.js';

export function withLivekitBoundaries(raw: ArchitectureReport): ArchitectureReport {
  const report = reportSchema.parse(raw);
  if (report.candidate !== 'livekit-agents') throw new Error('REPORT_CANDIDATE_MISMATCH');
  return {
    ...report,
    provenance: {
      ...report.provenance,
      historyBoundary: 'framework-playback-estimated',
      cancellationBoundary: 'stream abort + RoomIO buffer clear',
      providerPlaybackOffsetInterrupt: false,
    },
    limitations: Array.from(new Set([
      ...report.limitations,
      'Decoded PCM receipt is not physical audibility.',
      'TTSv2 uses stream abort + RoomIO buffer clear, not provider Interrupt(playback_offset).',
      'chatCtx truncation is framework-playback-estimated, not proven heard-history.',
      'Framework completion is not Aurvin durable playback completion. Unified review: skipped.',
      ...(!report.turns.some((turn) => turn.submitted) ? ['No turns submitted.'] : []),
    ])),
  };
}

export function formatLivekitReport(report: ArchitectureReport) {
  return renderArchitectureReport(withLivekitBoundaries(report));
}

export function writeReport(context: RunContext, report: ArchitectureReport) {
  return writeArchitectureReport(context, withLivekitBoundaries(report));
}
```

The shared JSON remains authoritative. Record raw signed early-endpoint deltas in scalar provenance, because P1's public latency fields are nonnegative/nullable. Other observations must fit the actual shared schema; request a P1 schema addition rather than silently dropping data or attaching unknown strict-schema keys. Requested/observed version/configuration fields, hashes, VAD 500 ms, zero endpointing, speculation/retry policy, region, cost unknowns, and cleanup stay in shared report provenance/limitations.

- [ ] **Step 4: Add all-attempts/redaction integration tests.**

Extend the test using `emptyTurn`/`newReport` with warm-up, completed, early-endpoint, failed, interrupted/ambiguous, and timeout states. Assert every index/failure appears and missing onset/cutoff is `unknown` while raw unknown usage remains JSON `null`. Preserve legitimate numeric zero. Include an interrupted turn followed by a follow-up to disclose the estimated history boundary.

Call `writeReport(context, report)` with a report containing a synthetic secret sentinel and a `SecretRedactor` configured for that sentinel. Assert it refuses **both** artifacts before creating a success report. On a safe fixture, assert the returned Markdown equals `formatLivekitReport(report)` and the actual path is `<context.outputDir>/livekit-agents/report.md`. V1 publishes to `benchmarks/voice-architectures/livekit-agents/report.md` through P1's `publishReports`; raw report limitations therefore must carry the same disclosures.

Verify `providerReportedUsd: null` is not rendered as `$0`; actual observed token/model/voice fields stay unknown when not returned. Include owned room ID and each close/disconnect/delete result; do not hardcode live `open sockets: 0`. A common-renderer defect (escaping, missing fields, or grouping) belongs to P1; report its failing fixture rather than duplicating the renderer here.

- [ ] **Step 5: Run GREEN and request the atomic commit.**

Run Task 6's command. Request subject:

`feat(voice-benchmark): format honest LiveKit Agents benchmark reports`

---

## Task 7: Bind the committed shared ArchitectureHarness and finish offline integration

**Files**

- Modify `benchmarks/voice-architectures/livekit-agents/harness.ts`.
- Modify `benchmarks/voice-architectures/livekit-agents/report.ts` only if the committed shared signature differs.
- Modify the existing P2 test files only.

Verify the concrete contract reconciled above against P1's worker commit. The safe default for the inspected release is a genuine SDK adapter with **blocked live admission**, not a hand-written provider substitute. P1's `BudgetGuard.sockets(factory)` wraps an injectable socket factory, but `STTv2`/`TTSv2` construct `new WebSocket(...)` internally and do not accept it. No public proxy, loader rewrite, global `WebSocket` monkeypatch, dependency patch, or new worker/IPC architecture is authorized by this plan.

- [ ] **Step 1: Add a compile-time shared-contract assertion and independent-selection failing test.**

Import the actual shared types and export `harness` exactly as required by P1. Add the typed assignment and this complete no-credential fixture in `harness.test.ts`:

```ts
import { resolve } from 'node:path';
import type { ArchitectureHarness, RunContext } from '../../shared/contracts.js';
import { SecretRedactor } from '../../shared/credentials.js';
import { harness } from '../harness.js';

const contract: ArchitectureHarness = harness;
const context: RunContext = {
  mode: 'dry-run', runId: '10000000-0000-4000-8000-000000000001',
  repoRoot: resolve('../..'), packageRoot: process.cwd(),
  outputDir: resolve('results', 'p2-fixture-not-written'),
  startedAtIso: '2026-11-16T00:00:00.000Z',
  clock: { now: () => 0 }, signal: new AbortController().signal,
  credentials: null, guard: null, corpus: [],
  redactor: new SecretRedactor(['fixture-private-sentinel']),
};

it('exports the exact shared candidate and returns blocked dry-run evidence without credentials', async () => {
  expect(contract.id).toBe('livekit-agents');
  const preflight = await contract.preflight(context);
  expect(preflight.status).toBe('blocked');
  expect(preflight.reasons).toEqual(['DRY_RUN_NO_NETWORK']);
  expect(preflight.provenance.nativeSilero).toBe('loaded-and-inferred-offline');
  const report = await contract.run(context, preflight);
  expect(report.turns).toEqual([]);
  expect(report.envelope.submittedTurns).toBe(0);
  expect(report.envelope.modelDispatches).toBe(0);
}, 30000);
```

The new test calls the **actual shared candidate selector** for `livekit-agents` and verifies `contract.id === 'livekit-agents'`, ready/blocked preflight, and dry-run report through this export. The exact shared signatures are `preflight(context)` and `run(context, preflight)`; do not change them or introduce a type escape.

RED expected: missing P2 export or unregistered candidate. P1 owns selector registration; if registration is missing, request that exact upstream change rather than writing into `shared/cli.ts`.

- [ ] **Step 2: Implement the concrete shared-contract binding and blocked preflight.**

Append to `harness.ts` (the existing `bounded` and `loadSilero` functions are used, not duplicated):

```ts
import {
  offlinePreflight,
  type ArchitectureHarness, type ArchitectureReport,
  type PreflightResult, type RunContext,
} from '../shared/contracts.js';
import { newReport } from '../shared/compiler.js';
import { loadSilero } from './config.js';
import { withLivekitBoundaries } from './report.js';

export async function preflightLivekit(context: RunContext): Promise<PreflightResult> {
  const result = offlinePreflight('livekit-agents', [
    context.mode === 'dry-run' ? 'DRY_RUN_NO_NETWORK' : 'BLOCKED_AGENTS_SPEECH_EGRESS_UNGUARDED',
  ]);
  result.provenance = {
    framework: '@livekit/agents',
    requestedAgentsVersion: '1.10.0',
    turnDetection: 'stt', interruptionMode: 'vad', minInterruptionDurationMs: 500,
    endpointingMinDelayMs: 0, endpointingMaxDelayMs: 0,
    preemptiveGeneration: false, preemptiveTts: false,
    sdkRetries: 0, frameworkRetries: 0,
    nativeSilero: 'unverified', speechEgressIntercepted: false,
    historyBoundary: 'framework-playback-estimated',
  };
  try {
    const vad = await bounded(async (signal) => {
      const loaded = await loadSilero();
      if (signal.aborted) {
        await loaded.close();
        signal.throwIfAborted();
      }
      return loaded;
    }, context.signal, 20000, 'SILERO_LOAD_TIMEOUT');
    await vad.close();
    result.provenance.nativeSilero = 'loaded-and-inferred-offline';
    result.capabilities = {
      userAttribution: true, zeroDataRetention: true, maxOutputTokensEnforced: true,
      zeroRetriesEnforced: true, speculationDisabled: true,
      fluxSttSupported: true, fluxTtsSupported: true,
    };
  } catch {
    // Do not serialize native exceptions, paths, credentials, or SDK payloads.
    result.status = context.signal.aborted ? 'failed' : 'blocked';
    result.reasons = [context.signal.aborted ? 'BENCHMARK_CANCELLED' : 'BLOCKED_SILERO_NATIVE_LOAD'];
  }
  return result;
}

function blockedReport(context: RunContext, preflight: PreflightResult): ArchitectureReport {
  const report = newReport('livekit-agents', context.runId, context.mode, preflight);
  report.startedAtIso = context.startedAtIso;
  report.provenance = { ...preflight.provenance };
  if (context.guard) report.envelope = context.guard.snapshot();
  report.limitations.push(
    'No live candidate connections or submitted turns; native/fixture checks are not service observations.',
    'Pinned Deepgram plugins have no injectable WebSocket factory for the shared pre-send/open budget guard.',
    'Bounded live pilot and actual report publication belong to V1.',
  );
  return withLivekitBoundaries(report);
}

export const harness = {
  id: 'livekit-agents',
  preflight: preflightLivekit,
  async run(context, preflight) {
    if (preflight.candidate !== 'livekit-agents' || preflight.status === 'ready') {
      throw new Error('AGENTS_UNVERIFIED_PREFLIGHT');
    }
    return blockedReport(context, preflight);
  },
} satisfies ArchitectureHarness;
```

`openSockets: 0` here is justified only because this branch creates **no network resources at all**; never copy it into a live cleanup path. `envelope` is the shared aggregate snapshot, which may include an earlier candidate, not a claim that a blocked candidate spent that aggregate amount.

Write these exact additional assertions using P1's `RunContext` fixture:

```ts
it('refuses forged ready admission before invoking any pipeline or network operation', async () => {
  const { offlinePreflight } = await import('../../shared/contracts.js');
  const preflight = offlinePreflight('livekit-agents');
  preflight.status = 'ready';
  await expect(contract.run(context, preflight)).rejects.toThrow('AGENTS_UNVERIFIED_PREFLIGHT');
});
```

Here `context` is the explicit fixture from Step 1, not a production global. Assert `preflight({ ...context, mode: 'live' })` returns `blocked` with `BLOCKED_AGENTS_SPEECH_EGRESS_UNGUARDED` before requiring credentials or attempting capability probes. This is a structural compatibility gate, not a credential diagnosis. Assert zero room/provider factory invocations and zero candidate turn/model deltas. The shared runner handles a blocked result without calling `run`; directly calling `run` with that result must return the same validated zero-submission report.

**If P1's completed implementation introduces a verified, supported speech-transport injection path:** report that exact signature and its opens/sends/retry/cancellation tests to the orchestrator. Reconcile this task before enabling `ready`; do not remove the block merely because node-level accounting tests pass. The admitted extension must follow the sequence below. It is not permission to add unsupported transport interception under P2.

Required admitted execution sequence for that explicitly reconciled extension:

```text
preflight:
P1 offline version/config checks
  → bounded loadSilero, retaining a run-owned instance
  → validate exact STTv2/TTSv2 regional construction and token-cap support
  → return shared PreflightResult with supported / blocked reasons and provenance

run(dry-run):
  preflight → shared report with zero submissions and no network

run(live):
  fresh P1 authorization + dynamic shared BudgetGuard/rate/fingerprint admission
  → mark paid-active lifetime before first owned room/provider connection
  → P1 owned unique room and pinned RTC participants
  → makePipeline(mapping of immutable context and shared guard callbacks)
  → openSession(pipeline, agentRoom, runAbort, remaining setup deadline)
  → shared createParticipant + pacePcm/DecodedObserver, using returned terminal signal
  → record framework events with shared now(), plus decoded caller observations
  → finally bounded owner cleanup and retained evidence
  → shared ArchitectureReport + formatLivekitReport(view)
```

For that extension, every normalized callback calls the same P1 run-owned guard; do not silently provide a no-op when an export is missing. P1's actual model hook is **`guard.fetch(fetcher)`**, not a public `reserve()` method. Wire `guardedFetch` to that guarded transport; do not maintain another reservation or double-charge a request. P1's actual speech hook is `guard.sockets(factory)`/`speechSend(kind, data)`, not `stt(ms)`/`tts(bytes)`; only a verified injected transport can supply the final enforcement, and node counters must not double-charge those same bytes. Caller submission authorization and model dispatch are separate so warm-up, cancelled inputs, and unwanted SDK-generated dispatches count correctly.

P1 provides a participant and timing primitives, **not a per-architecture conversation-completion scheduler**. The extension would need one small P2 run loop using `guard.submitTurn(id, index)`, `participant.play(turn.pcm)`, one `DecodedObserver` per attempted response, framework terminal events, and a concurrent turn-4/turn-5 branch. Do not assume a nonexistent shared scenario-driver API. Until that extension and safe transport seam are explicitly reconciled, return the blocked record above; never publish unexecuted scenario observations.

Observe real SDK event names (`AgentSessionEventTypes`) and public fields:

- `AgentStateChanged` → `newState === 'thinking'`: stamp local receive time using `now()`, not SDK `createdAt` wall-clock subtraction.
- `MetricsCollected`: consume actually exposed durations/tokens with documented units; leave unexposed stages/cost unknown. Do not infer first usable model output from a generic network byte or whitespace-only SSE delta.
- `ConversationItemAdded`: retain bounded synthetic outcome/context-boundary evidence, not private reasoning.
- `Error`/`Close`: abort driver, preserve partial metrics, classify terminal cause once.
- `SpeechCreated`: correlate a bounded public speech ID if available, never authorize a new turn from this event.

`modelFirstOutputMs` and `ttsFirstAudioMs` may be populated only from actual local node/SDK observations with an explicit anchor. If an SDK metric only provides provider-relative `ttfb`, keep it as a separately labeled raw span, not a fabricated speech-end latency. Null is preferable to crossing clocks or mislabeling an interval.

Set `decodedPlaybackProof: 'unproven-headless-pcm-only'` on every turn. Use `durableCompletionStatus: 'not-applicable'` for this candidate. `completed` can mean framework output completion only; never call it Aurvin archive-durable or physically heard. Preserve every submitted attempt even when the scenario aborts before the remaining inputs; do not manufacture six submitted turns after a preflight failure.

- [ ] **Step 3: Complete the offline SDK/lifecycle matrices and the bound export's blocked/no-network tests.**

Blocked/no-network assertions execute the actual export invoked by P1's runner. SDK pipeline/lifecycle fixtures execute the real `makePipeline`/`openSession` functions without promoting them to live observations. Prove synthetic context/history is inserted once by examining mocked OpenRouter requests. Assert all automatic `maxRetry` settings and actual retryable-error transport counts, including framework STT/TTS failures, remain one attempted dispatch and no fallback. If the admitted extension is reconciled, rerun the matrices through that actual wrapper too.

Expose requested configuration separately from observed behavior:

- Requested/constructed: exact versions, model ID, Flux voice/region URLs, 16 kHz input/24 kHz output, EOT settings, VAD options, 500 ms interruption threshold, AEC warmup disabled for headless input, 200 ms output queue capacity.
- Observed offline: installed lock identities, native Silero load/inference, actual fixture request bodies/URLs, cancellation/output-clear behavior.
- Observed live: only V1 can populate actual provider/media timings, returned identities, accounting, and cleanup.

Do not turn these tests into a backend or frontend check; P2 has no production integration changes.

- [ ] **Step 4: Run the exact offline exit checks.**

Working directory `benchmarks/voice-architectures/`:

```bash
npm exec --no -- vitest run livekit-agents/__tests__
npm run build
npm run lint
npm test
npm run bench:livekit-agents
```

Use P1's actual independently selected dry-run script if it differs from the proposed script name, and record the literal command in the handoff. No `--live`, fresh authorization file, credential import, or provider probe belongs in P2 verification.

Expected:

- Focused suites execute native and deterministic tests, with no silently skipped acceptance case.
- Isolated package build/lint/full deterministic tests pass.
- Independent `livekit-agents` dry-run identifies actual framework candidate, writes honest dry-run/blocked evidence through the shared writer, and opens zero external connections.
- Any broader failure owned by P1/P3 is reported separately, not patched outside P2.

Repository working directory:

```bash
git diff --check
git status --short
git diff --name-only
```

Compare with the preserved initial status. P2's implementation diff contains only `benchmarks/voice-architectures/livekit-agents/**`; this plan is the planner's sole documentation output. No manifest/lockfile, backend/frontend, root configuration, credential, generated audio, dependency, or unrelated user change is staged. V1 owns final evidence publication; retain necessary generated run IDs locally without committing secrets.

- [ ] **Step 5: Request the final atomic integration commit and report the handoff.**

Suggested subject:

`feat(voice-benchmark): bind LiveKit candidate to shared guarded runner`

Handoff must list: exact P2 files/exports, P1 commit and shared signatures used, dependency lock identities, executed commands/test counts, native Silero result, failed/skipped/blocked checks, all proposed commit subjects, and residual live-only limitations. State explicitly: **no live calls by P2; unified review skipped; V1 pilot/report publication pending**.

---

## Acceptance mapping and self-check

| Requirement | Task / executable evidence |
| --- | --- |
| Only P2 directory implementation writes; no installs/commits by this planner | ownership gates; Task 7 diff comparison |
| Actual framework and pinned plugins rather than custom-loop substitute | Tasks 1 and 3 real class/lock assertions |
| Standalone room start and participant-pinned RoomIO | Tasks 1, 3, 4, 7 actual start arguments and typed RoomIO fixture |
| Flux STT/TTS region/model identity | Tasks 1 and 3 actual plugin URL/configuration fixtures |
| Real offline `silero.VAD.load()` and dummy inference on Windows | Task 1, non-skippable native test |
| STT EOT; fixed zero extra endpoint wait; VAD 500 ms; no false resume | Task 1 effective session options |
| SDK + framework zero retries; no speculation/fallback | Tasks 1–3 and 7 negative transport fixtures |
| Custom OpenAI client; trusted user; privacy/routing; disabled transforms/plugins/tools | Task 2 actual outbound request/429 fixtures |
| Verified output-cap alias; shared finite context/dispatch/dollar/time reservation | Task 2 and Task 7 guard binding |
| Finite STT audio and conservative TTS bytes before send | Task 3 node guard-order tests |
| TTSv2 abort/buffer-clear caveat and next-stream isolation | Task 5 actual plugin/framework fixtures |
| No physical playback proof or guessed heard-prefix | Tasks 5–7 labels/context tests |
| Decoded interruption anchor/cutoff/fixed 1000 ms stale tail | Task 5 shared-observer matrix |
| Cancellation, early close, partial failure, timeout, cleanup races | Task 4 matrix through Task 7 shared binding |
| Every attempt, nulls, grouping, costs/unknowns, safe report destination | Task 6 and shared writer tests |
| Exact concrete `ArchitectureHarness` conformance | Task 7 typed assignment and real selector test; gated on P1 |

Planner self-check:

- Source/configuration examples use the observed `1.10.0` **inputOptions/outputOptions** API, not research's abbreviated `roomOptions`.
- No proposed edits cross P2 ownership. No package install, paid probe, live test, staging/commit, or reviewer dispatch is part of planner execution.
- The incomplete upstream harness/report API is explicitly a prerequisite, not disguised with guessed method names, fabricated shared implementations, or unsafe casts.
- Every substantive algorithm has runnable Vitest assertions, a RED expectation or honest independent characterization label, minimal implementation content, GREEN command, and atomic commit subject.
- Test doubles never become production STT/TTS/LLM adapters. Fixture output evidence is not promoted to browser audibility or Aurvin durable completion.
- No unsupported region, hidden retry, public proxy, inference fallback, discarded history, free greeting, budget refund, or abandoned resource is silently accepted.

## Sources checked while planning

Repository:

- [Approved goal](goal.md)
- [Research, especially §§4 and 7](research.md)
- [Workflow ownership/dependencies](state.md)
- [Repository instructions](../../AGENTS.md)
- [Earlier SDK interruption assessment](../voice-latency-benchmark/provider-architecture-assessment-2026-11-16.md)

Current Context7 reference: `/livekit/agents-js`, AgentSession/RoomIO/turn-handling documentation. Published pinned artifacts take precedence over mutable examples:

- [AgentSession declarations 1.10.0](https://unpkg.com/@livekit/agents@1.10.0/dist/voice/agent_session.d.ts)
- [RoomIO declarations 1.10.0](https://unpkg.com/@livekit/agents@1.10.0/dist/voice/room_io/room_io.d.ts)
- [Interruption options 1.10.0](https://unpkg.com/@livekit/agents@1.10.0/dist/voice/turn_config/interruption.d.ts)
- [Endpointing implementation 1.10.0](https://unpkg.com/@livekit/agents@1.10.0/dist/voice/turn_config/endpointing.js)
- [STTv2 implementation 1.10.0](https://unpkg.com/@livekit/agents-plugin-deepgram@1.10.0/dist/stt_v2.js)
- [TTSv2 implementation 1.10.0](https://unpkg.com/@livekit/agents-plugin-deepgram@1.10.0/dist/tts_v2.js)
- [ConnectionPool abort/removal implementation 1.10.0](https://unpkg.com/@livekit/agents@1.10.0/dist/connection_pool.js)
- [OpenAI plugin implementation 1.10.0](https://unpkg.com/@livekit/agents-plugin-openai@1.10.0/dist/llm.js)
- [Silero implementation 1.10.0](https://unpkg.com/@livekit/agents-plugin-silero@1.10.0/dist/vad.js)

Artifact inspection and documentation are not runtime verification. This planner made no dependency installation or live/service calls.
