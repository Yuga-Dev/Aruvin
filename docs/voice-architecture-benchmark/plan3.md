# Deepgram Voice Agent v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the genuine Deepgram Voice Agent v1 protocol adapter, deterministic offline checks, and an unconditional direct-BYO policy block that produces an honest Deepgram report without opening a network connection or spending money.

**Architecture:** Keep protocol construction/parsing, measurement, socket lifecycle and preflight inside `benchmarks/voice-architectures/deepgram-agent/`, reusing P1's validated report formatter/writer through a candidate-local export. The supported public candidate route always evaluates the structural BYO blockers first and returns `BLOCKED_BYO_CONTROLS_UNSUPPORTED`; separately test the actual Voice Agent wire client with an injected in-memory WebSocket, not a substitute STT/LLM/TTS loop. Export P1's exact `ArchitectureHarness` call surface.

**Tech Stack:** Node 24 / TypeScript NodeNext ESM, P1-owned `ws`, Vitest, Node standard-library buffers/files/timers, and read-only types from P1-owned `shared/contracts.ts`.

---

## Scope, dependency gate, and execution rules

- **Planner output:** this file only. No implementation, installation, live probes, staging, or commits are performed while writing it.
- **Worker write allowlist:** `benchmarks/voice-architectures/deepgram-agent/**` only. Do not edit `shared/`, sibling candidates, manifests/lockfiles, root configuration, `backend/`, `frontend/`, production data, or any `.env`.
- **Worker prerequisite:** P1 implementation is completed, tested, and committed, not merely planned. P1 provides the isolated package, pinned `ws` / `@types/ws`, TypeScript/Vitest configuration, shared contracts, credential/redaction services, runner, and report compiler. Do not install or add dependencies yourself.
- Use the installed `executing-plans` and `test-driven-development` skills for this assigned worker task; the `superpowers:` names in the required header refer to those workflows. Do not dispatch nested agents or a reviewer. Unified review remains **skipped**, not passed.
- All commands below run from `benchmarks/voice-architectures/` unless another directory is explicitly stated. `npm exec --no -- vitest ...` uses the existing local executable and must not install anything. Missing tooling or zero discovered tests is a blocked verification, not success.
- The orchestrator serializes Git. Each task ends with an **atomic commit suggestion**, not permission to stage/commit. Hand back the named files and suggested message; do not run `git add` or `git commit` without separate orchestrator authorization.
- Preserve existing edits and untracked files. At planning time there was no `benchmarks/` directory. That is not permission to overwrite a later P1/P2 implementation.

### P1 ABI handoff

Research §7.4 names `ArchitectureHarness` but only supplies concrete definitions of `PreflightResult` and `TurnObservation`. P1's concurrently produced `plan1.md` now resolves that omission:

```ts
interface ArchitectureHarness {
  readonly id: CandidateId;
  preflight(context: RunContext): Promise<PreflightResult>;
  run(context: RunContext, preflight: PreflightResult): Promise<ArchitectureReport>;
}
```

P1's runner expects the export name `harness` from `deepgram-agent/harness.ts`; it calls `run` only for a ready preflight, otherwise creates the blocked report itself. Thus **all mandatory policy explanation and zero-spend evidence must also be present in preflight provenance**, not only in a run implementation which the runner will correctly skip. P3's `run` nevertheless rechecks policy to reject a direct caller's forged ready result.

P1 supplies `newReport`, `renderArchitectureReport`, and `writeArchitectureReport` in `shared/compiler.ts`; reuse them rather than maintaining a second report schema, serializer, redactor or writer. Confirm these declarations against P1's completed implementation before starting. A changed upstream ABI pauses integration; it does not authorize shared edits, unsafe casts, or a second contract.

### Fail-closed decision, including the entitlement-check ordering

The user's latest instruction requires blocking **before any network open**. Therefore P3's normal dry-run **and** explicitly requested live route return the structural block without an HTTP request, DNS/WS connection, credential access, budget reservation, input submission, or Settings serialization containing a real key. P1's runner must likewise not perform candidate-specific credential/network preparation before a decisive P3 preflight; flag an incompatible runner order to P1 rather than editing shared code.

Research §5.3 also mentions a non-billable `GET /v1/auth/token`. It is unnecessary after a decisive structural failure and would contradict the stronger zero-network ordering here. Record entitlement as **not checked / unknown**, not valid or invalid. Do not add a paid health probe or perform an otherwise unnecessary token check. Entitlement verification can only become relevant in a separately approved future implementation after the structural controls are genuinely resolved.

No configuration switch, `--live`, caller-supplied capability map, valid credentials, nominal budget, or claimed operator exception may bypass the block in this implementation. A later user decision is a prerequisite for a separately scoped change, not a runtime escape hatch.

## Evidence and precise limitations

Read `goal.md`, `research.md` §§5, 7.3–7.5, and `state.md` before execution. These research findings are the policy baseline:

1. `ThinkSettingsV1` exposes `provider`, `endpoint`, `functions`, `prompt`, and `context_length`; `OpenAiThinkProvider` exposes `type`, `version`, `model`, `temperature`, and `reasoning_mode`. Neither exposes the per-request OpenRouter JSON-body `user`.
2. Neither exposes OpenRouter routing-body `provider.data_collection: 'deny'`, `provider.require_parameters: true`, `provider.allow_fallbacks: false`, `transforms: []`, or disabled `plugins`. Headers, Deepgram `mip_opt_out`, prompt instructions, and `context_length` do not implement these controls.
3. Neither exposes `max_tokens` or `max_completion_tokens`. `context_length` is a **character retention setting**, not a token or generation-output ceiling.
4. Deepgram dispatches the upstream HTTPS LLM call on its servers. Local `BudgetGuard` cannot inspect/reserve/reject each such dispatch; neither local SDK `maxRetries: 0` nor framework `maxRetry: 0` controls Deepgram's upstream client. A WebSocket lifetime limit is not an output-token or upstream-attempt bound.
5. Managed events do not supply attributable prompt/completion-token totals, OpenRouter generation IDs, or per-generation billing evidence. Do not manufacture them from transcripts or request IDs.
6. `OpenAiThinkProviderModel` is an OpenAI-only enum. Preserve the requested `vendor/model` string in the **offline Settings intent** and disclose server acceptance as unverified. Do not replace it with an OpenAI model or a Deepgram-managed model to obtain a successful run.
7. Direct BYO Settings would transmit the OpenRouter authorization header to Deepgram's servers. That transfer is **not performed** while blocked. No proxy, public callback, listener, deployment, or tunnel is permitted.

Protocol sources checked while preparing this plan (documentation requests only, no service probes):

- <https://developers.deepgram.com/docs/voice-agent-message-flow>
- <https://developers.deepgram.com/docs/configure-voice-agent>
- <https://developers.deepgram.com/docs/voice-agent-inject-user-message>
- <https://developers.deepgram.com/docs/voice-agent-tts-models>
- <https://raw.githubusercontent.com/deepgram/deepgram-api-specs/main/asyncapi.yml>

The current schema describes `AgentStartedSpeaking` timing fields as float strings and the event as experimental; accept optional numeric/string diagnostic fields, but **do not** equate them to locally observed model TTFT or TTS first audio. `AgentThinking.content` may contain thought-process text: validate the event identity but discard the content immediately, never archive/log/report it.

## File map

Create only these files; keep small append-only task increments in the same files:

| File, relative to `benchmarks/voice-architectures/deepgram-agent/` | Responsibility |
| --- | --- |
| `harness.ts` | Structural preflight, P1-schema zero-spend blocked result, exact P1 contract binding. |
| `protocol.ts` | Allowlisted endpoints, Settings and text commands, safe event parsing, PCM framing/pacing. |
| `measurements.ts` | Bounded single-turn receipt/cutoff observer; no device/playback claims. |
| `client.ts` | Real `ws` opening seam plus attachable Voice Agent v1 state machine and bounded cleanup. |
| `report.ts` | Candidate-local exports of P1's validated Markdown/JSON formatter and writer. |
| `__tests__/harness.test.ts` | Zero-network gate, capability/blocker completeness, public-contract binding. |
| `__tests__/protocol.test.ts` | Settings, parser, raw frames, pacing and cancellation. |
| `__tests__/measurements.test.ts` | Onset/early endpoint, nulls, interruption anchor, stale tail and ambiguity. |
| `__tests__/client.test.ts` | Mock WebSocket handshake, events, failures, close/deadline/cancellation lifecycle. |
| `__tests__/report.test.ts` | Shared-format integration, blocked counts/nulls and redaction before writes. |
| `report.md` | Initial clearly labeled offline/blocked report; V1 replaces with actual execution provenance. |

All new `.ts` files must start with the full AGENTS.md header. Complete first-write headers appear below. Do not put comments in emitted JSON. No separate config, new dependency, duplicate credential importer, duplicate budget library, or custom managed-LLM server is needed.

---

### Task 1: Establish the immutable zero-network BYO preflight

**Files**
- Create: `benchmarks/voice-architectures/deepgram-agent/harness.ts`
- Test: `benchmarks/voice-architectures/deepgram-agent/__tests__/harness.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
/**
 * ============================================================================
 * FILE: harness.test.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/__tests__/harness.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove structural BYO rejection occurs before any paid or network work.
 *
 * ROLE IN PROJECT:
 *    Offline P3 admission regression checks.
 *    No credentials, application state, or provider services are accessed.
 *
 * KEY COMPONENTS:
 *    - Preflight checks: Exact unsupported requirements and zero-spend evidence.
 * ============================================================================
 */
import { afterEach, expect, it, vi } from 'vitest';
import { makeBlockedRun, preflightDeepgramAgent } from '../harness.js';

afterEach(() => vi.unstubAllGlobals());

it('blocks direct BYO with all structural reasons before any network open', () => {
  const fetcher = vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); });
  vi.stubGlobal('fetch', fetcher);
  const p = preflightDeepgramAgent('2026-11-16T00:00:00.000Z');
  expect(p.candidate).toBe('deepgram-agent');
  expect(p.status).toBe('blocked');
  expect(p.reasons).toEqual([
    'BLOCKED_BYO_CONTROLS_UNSUPPORTED',
    'BYO_USER_BODY_UNSUPPORTED',
    'BYO_ROUTING_ZDR_TRANSFORMS_UNSUPPORTED',
    'BYO_OUTPUT_TOKEN_CAP_UNSUPPORTED',
    'BYO_LOCAL_BUDGET_AND_ZERO_RETRY_UNENFORCEABLE',
    'BYO_TOKEN_GENERATION_ACCOUNTING_UNOBSERVABLE',
    'BYO_OPENAI_MODEL_ENUM_UNVERIFIED',
  ]);
  expect(p.capabilities).toEqual({
    userAttribution: false,
    zeroDataRetention: false,
    maxOutputTokensEnforced: false,
    zeroRetriesEnforced: false,
    speculationDisabled: 'unknown',
    fluxSttSupported: true,
    fluxTtsSupported: true,
  });
  expect(p.provenance.entitlement).toBe('not-checked-structurally-blocked');
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['dry-run', 'live'] as const)(
  'keeps %s at zero submissions, zero paid time and US$0',
  (mode) => {
    const result = makeBlockedRun(
      mode, '2026-11-16T00:00:00.000Z', '00000000-0000-4000-8000-000000000003',
    );
    expect(result.turns).toEqual([]);
    expect(result.envelope.submittedTurns).toBe(0);
    expect(result.envelope.modelDispatches).toBe(0);
    expect(result.provenance.networkOpens).toBe(0);
    expect(result.envelope.activeMs).toBe(0);
    expect(result.provenance.estimatedCostUsd).toBe(0);
    expect(result.provenance.providerReportedUsd).toBeNull();
    expect(result.cleanup).toEqual({ resources: [], openSockets: 0, complete: true });
  },
);
```

- [ ] **Step 2: Run and observe red.**

Run: `npm exec --no -- vitest run deepgram-agent/__tests__/harness.test.ts`

Expected: FAIL resolving `../harness.js`; after the file exists, deleting any structural reason must fail the exact-array assertion. Do not treat missing P1 tooling as this intentional red result.

- [ ] **Step 3: Implement the minimal gate and blocked record.**

```ts
/**
 * ============================================================================
 * FILE: harness.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/harness.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Fail closed on unsupported direct managed-BYO inference controls.
 *
 * ROLE IN PROJECT:
 *    Public P3 admission and blocked-result boundary.
 *    Never loads credentials or opens a provider connection while blocked.
 *
 * KEY COMPONENTS:
 *    - preflightDeepgramAgent: Immutable structural policy decision.
 *    - makeBlockedRun: Honest zero-submission evidence.
 * ============================================================================
 */
import type { ArchitectureReport, PreflightResult } from '../shared/contracts.js';
import { newReport } from '../shared/compiler.js';

export const BYO_REASONS = [
  'BLOCKED_BYO_CONTROLS_UNSUPPORTED',
  'BYO_USER_BODY_UNSUPPORTED',
  'BYO_ROUTING_ZDR_TRANSFORMS_UNSUPPORTED',
  'BYO_OUTPUT_TOKEN_CAP_UNSUPPORTED',
  'BYO_LOCAL_BUDGET_AND_ZERO_RETRY_UNENFORCEABLE',
  'BYO_TOKEN_GENERATION_ACCOUNTING_UNOBSERVABLE',
  'BYO_OPENAI_MODEL_ENUM_UNVERIFIED',
] as const;

export function preflightDeepgramAgent(checkedAtIso: string): PreflightResult {
  if (!Number.isFinite(Date.parse(checkedAtIso))) throw new Error('INVALID_CHECK_TIME');
  return {
    candidate: 'deepgram-agent',
    status: 'blocked',
    reasons: [...BYO_REASONS],
    checkedAtIso,
    capabilities: {
      userAttribution: false,
      zeroDataRetention: false,
      maxOutputTokensEnforced: false,
      zeroRetriesEnforced: false,
      speculationDisabled: 'unknown',
      fluxSttSupported: true,
      fluxTtsSupported: true,
    },
    provenance: {
      protocol: 'Deepgram Voice Agent v1',
      thinkEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
      entitlement: 'not-checked-structurally-blocked',
      modelEnumAcceptance: 'unverified-openai-only-enum',
      contextLengthUnit: 'characters-not-output-tokens',
      upstreamAttemptControl: 'not-locally-enforceable',
      tokenAccounting: 'unobservable',
      generationId: null,
      openRouterKeyTransfer: 'not-performed',
      requestedEagerEot: 'omitted',
      observedSettings: 'none-no-network',
      publicProxy: false,
      managedLlmSubstitution: false,
      userBodyBlocker: 'ThinkSettingsV1 / OpenAiThinkProvider lack JSON-body user attribution.',
      routingBlocker: "Missing provider.data_collection: 'deny', " +
        'provider.require_parameters: true, provider.allow_fallbacks: false, ' +
        'transforms: [], and disabled plugins.',
      outputBlocker: 'Missing max_tokens / max_completion_tokens; context_length retains characters.',
      budgetBlocker: 'Cloud-side dispatch bypasses local BudgetGuard and maxRetry: 0 / maxRetries: 0.',
      accountingBlocker: 'No attributable prompt/completion tokens, OpenRouter generationId or cost.',
      modelBlocker: 'OpenAI-only model enum; vendor/model acceptance is unverified.',
      spendEvidence: 'US$0 spent: no paid transmission, not a provider-enforced invoice cap.',
      networkOpens: 0,
      estimatedCostUsd: 0,
      providerReportedUsd: null,
      modelFirstOutputMs: null,
      ttsFirstAudioMs: null,
      promptTokens: null,
      completionTokens: null,
      disclosure: 'Decoded PCM receipt is not physical speaker audibility.',
    },
  };
}

export function makeBlockedRun(
  mode: 'dry-run' | 'live',
  checkedAtIso: string,
  runId: string,
): ArchitectureReport {
  const preflight = preflightDeepgramAgent(checkedAtIso);
  const report = newReport('deepgram-agent', runId, mode, preflight);
  report.startedAtIso = checkedAtIso;
  report.provenance = { ...preflight.provenance };
  report.envelope.denied = preflight.reasons[0];
  report.limitations.push(
    'No live turns, entitlement checks, sockets, rooms or databases were opened.',
    'AgentThinking content is discarded; no private reasoning is archived.',
    'AgentAudioDone is not durable completion or heard-prefix proof.',
    'Managed model/TTS first-output timing and token/generation accounting remain null.',
    'Interruption needs active output and an independently observed 1000 ms stale-tail window.',
    'Overlapping untagged old/new audio is unknown, not a successful interruption.',
    'No managed LLM substitution, public proxy/tunnel or runtime exception bypass.',
    'A blocked candidate does not reallocate its six-turn allowance.',
    'Future managed Flux TTS surcharge and provider invoice components remain unverified.',
  );
  return report;
}
```

- [ ] **Step 4: Run green.**

Run: `npm exec --no -- vitest run deepgram-agent/__tests__/harness.test.ts`

Expected: 3 tests pass, zero skipped, zero HTTP/WS opens. Protocol-supported booleans mean documented support, not successful service entitlement or observed configuration.

- [ ] **Step 5: Offer the atomic commit to the orchestrator.**

Files: `deepgram-agent/harness.ts`, `deepgram-agent/__tests__/harness.test.ts`.

Suggested message: `feat(voice-bench): fail closed on Deepgram managed BYO controls`

---

### Task 2: Implement actual Settings, InjectUserMessage, event and PCM protocol

**Files**
- Create: `benchmarks/voice-architectures/deepgram-agent/protocol.ts`
- Test: `benchmarks/voice-architectures/deepgram-agent/__tests__/protocol.test.ts`

- [ ] **Step 1: Write the exact wire/pacing tests.**

```ts
/**
 * ============================================================================
 * FILE: protocol.test.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/__tests__/protocol.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Check genuine Voice Agent messages and real-time PCM framing offline.
 *
 * ROLE IN PROJECT:
 *    Pins P3 wire intent without asserting managed-provider acceptance.
 *    All keys, clocks and transports are synthetic.
 *
 * KEY COMPONENTS:
 *    - Settings fixtures: Flux v2 and direct OpenRouter endpoint.
 *    - PCM/parser checks: Frame flags, safe events, cancellation and pacing.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import {
  agentEndpoint, buildSettings, injectUserMessage, pacePcm, parseAgentEvent,
} from '../protocol.js';

const settingsInput = {
  modelId: 'vendor/requested-model',
  ttsModel: 'flux-haley-en',
  openRouterApiKey: 'fixture-openrouter-only',
  prompt: 'Synthetic benchmark instruction.',
  contextCharacters: 45000,
  eotThreshold: 0.8,
  eotTimeoutMs: 5000,
};

it('uses the genuine US and EU Voice Agent v1 endpoints only', () => {
  expect(agentEndpoint('us')).toBe('wss://agent.deepgram.com/v1/agent/converse');
  expect(agentEndpoint('eu')).toBe('wss://api.eu.deepgram.com/v1/agent/converse');
  expect(() => agentEndpoint('https://attacker.invalid')).toThrow('UNSUPPORTED_REGION');
});

it('builds Settings with Flux v2, PCM rates and the unchanged BYO model intent', () => {
  const s = buildSettings(settingsInput);
  expect(s).toEqual({
    type: 'Settings',
    mip_opt_out: true,
    audio: {
      input: { encoding: 'linear16', sample_rate: 16000 },
      output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
    },
    agent: {
      language: 'en',
      listen: { provider: {
        type: 'deepgram', version: 'v2', model: 'flux-general-en',
        eot_threshold: 0.8, eot_timeout_ms: 5000,
      } },
      think: {
        provider: { type: 'open_ai', version: 'v1', model: 'vendor/requested-model' },
        endpoint: {
          url: 'https://openrouter.ai/api/v1/chat/completions',
          headers: { Authorization: 'Bearer fixture-openrouter-only' },
        },
        prompt: 'Synthetic benchmark instruction.',
        context_length: 45000,
      },
      speak: { provider: {
        type: 'deepgram', version: 'v2', model: 'flux-haley-en',
      } },
    },
  });
  const wire = JSON.stringify(s);
  for (const absent of [
    '"greeting"', '"eager_eot_threshold"', '"think_live"', '"functions"',
    '"user"', '"max_tokens"', '"max_completion_tokens"', '"transforms"',
  ]) expect(wire).not.toContain(absent);
  expect(injectUserMessage('Hello')).toEqual({
    type: 'InjectUserMessage', content: 'Hello',
  });
  expect(() => injectUserMessage('')).toThrow('INVALID_TEXT');
  expect(() => buildSettings({ ...settingsInput, eotThreshold: NaN }))
    .toThrow('INVALID_SETTINGS');
  expect(() => buildSettings({ ...settingsInput, ttsModel: 'aura-2-thalia-en' }))
    .toThrow('INVALID_SETTINGS');
});

it('parses required events but discards thought text and provider error payloads', () => {
  for (const type of [
    'SettingsApplied', 'UserStartedSpeaking', 'AgentThinking',
    'AgentStartedSpeaking', 'AgentAudioDone',
  ]) {
    expect(parseAgentEvent(JSON.stringify({
      type, content: 'PRIVATE_THOUGHT_MUST_NOT_SURVIVE',
      total_latency: '0.3', tts_latency: '0.1', ttt_latency: '0.2',
    }))).toEqual({ type });
  }
  expect(parseAgentEvent('{"type":"Welcome","request_id":"fixture-request"}'))
    .toEqual({ type: 'Welcome', requestId: 'fixture-request' });
  expect(parseAgentEvent('{"type":"ConversationText","role":"user","content":"Hi"}'))
    .toEqual({ type: 'ConversationText', role: 'user', content: 'Hi' });
  expect(parseAgentEvent('{"type":"Error","code":"INVALID_SETTINGS","description":"secret"}'))
    .toEqual({ type: 'Error', code: 'INVALID_SETTINGS' });
  expect(parseAgentEvent('{"type":"UnrecognizedFutureEvent"}')).toBeNull();
  for (const invalid of ['{', '[]', 'null', '{"type":"Welcome"}',
    '{"type":"ConversationText","role":"system","content":"x"}']) {
    expect(() => parseAgentEvent(invalid)).toThrow('AGENT_PROTOCOL_INVALID');
  }
});

it('paces unchanged raw 16 kHz PCM as 80 ms binary frames with the shared pacer', async () => {
  let time = 100;
  const times: number[] = [];
  const frames: Buffer[] = [];
  const pcm = Buffer.alloc(2560 * 3, 1);
  const result = await pacePcm(pcm, 165, {
    now: () => time,
    wait: async (ms) => { time += ms; },
    send: (frame) => { times.push(time); frames.push(frame); },
    signal: new AbortController().signal,
  });
  expect(times).toEqual([100, 180, 260]);
  expect(frames.map((f) => f.length)).toEqual([2560, 2560, 2560]);
  expect(Buffer.concat(frames)).toEqual(pcm);
  expect(result).toEqual({ speechEndAt: 265, maxLatenessMs: 0 });
});

it('cancels before a queued frame and rejects partial or odd-byte corpus frames', async () => {
  let time = 0;
  const sent: number[] = [];
  const controller = new AbortController();
  await expect(pacePcm(Buffer.alloc(5120), 160, {
    now: () => time,
    wait: async (ms) => { time += ms; controller.abort(); },
    send: () => sent.push(time),
    signal: controller.signal,
  })).rejects.toThrow();
  expect(sent).toEqual([0]);
  await expect(pacePcm(Buffer.alloc(3), 0, {
    now: () => 0, wait: async () => {}, send: () => {},
    signal: new AbortController().signal,
  })).rejects.toThrow('INVALID_PCM');
  await expect(pacePcm(Buffer.alloc(320), 0, {
    now: () => 0, wait: async () => {}, send: () => {},
    signal: new AbortController().signal,
  })).rejects.toThrow('INVALID_PCM');
});
```

- [ ] **Step 2: Run red.**

Run: `npm exec --no -- vitest run deepgram-agent/__tests__/protocol.test.ts`

Expected: FAIL resolving `../protocol.js`.

- [ ] **Step 3: Implement the wire helpers with no inference substitute.**

```ts
/**
 * ============================================================================
 * FILE: protocol.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Construct and parse the actual Deepgram Voice Agent v1 wire protocol.
 *
 * ROLE IN PROJECT:
 *    Pure protocol and paced PCM helpers used by the P3 socket adapter.
 *    Settings express offline intent, never verified BYO policy compliance.
 *
 * KEY COMPONENTS:
 *    - buildSettings/parseAgentEvent: Narrow protocol allowlists.
 *    - pacePcm: Thin marker/frame bridge over P1's shared monotonic pacer.
 * ============================================================================
 */
import { pacePcm as sharedPacePcm } from '../shared/timing.js';

export function agentEndpoint(region: string): string {
  if (region === 'us') return 'wss://agent.deepgram.com/v1/agent/converse';
  if (region === 'eu') return 'wss://api.eu.deepgram.com/v1/agent/converse';
  throw new Error('UNSUPPORTED_REGION');
}

export type SettingsInput = {
  modelId: string;
  ttsModel: string;
  openRouterApiKey: string;
  prompt: string;
  contextCharacters: number;
  eotThreshold: number;
  eotTimeoutMs: number;
};

export function buildSettings(c: SettingsInput) {
  if (!c.modelId.trim() || c.modelId.length > 256 ||
      !/^flux-[a-z0-9-]+-en$/.test(c.ttsModel) ||
      !c.openRouterApiKey || /[\r\n]/.test(c.openRouterApiKey) ||
      !c.prompt.trim() || Buffer.byteLength(c.prompt) > 262144 ||
      !Number.isInteger(c.contextCharacters) || c.contextCharacters < 2 ||
      c.contextCharacters > 262144 ||
      !Number.isFinite(c.eotThreshold) || c.eotThreshold < 0.5 ||
      c.eotThreshold > 1 || !Number.isInteger(c.eotTimeoutMs) ||
      c.eotTimeoutMs < 1000 || c.eotTimeoutMs > 10000) {
    throw new Error('INVALID_SETTINGS');
  }
  return {
    type: 'Settings',
    mip_opt_out: true,
    audio: {
      input: { encoding: 'linear16', sample_rate: 16000 },
      output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
    },
    agent: {
      language: 'en',
      listen: { provider: {
        type: 'deepgram', version: 'v2', model: 'flux-general-en',
        eot_threshold: c.eotThreshold, eot_timeout_ms: c.eotTimeoutMs,
      } },
      think: {
        provider: { type: 'open_ai', version: 'v1', model: c.modelId },
        endpoint: {
          url: 'https://openrouter.ai/api/v1/chat/completions',
          headers: { Authorization: `Bearer ${c.openRouterApiKey}` },
        },
        prompt: c.prompt,
        context_length: c.contextCharacters,
      },
      speak: { provider: {
        type: 'deepgram', version: 'v2', model: c.ttsModel,
      } },
    },
  };
}

export function injectUserMessage(content: string) {
  if (!content.trim() || Buffer.byteLength(content) > 4096) {
    throw new Error('INVALID_TEXT');
  }
  return { type: 'InjectUserMessage', content };
}

export type AgentEvent =
  | { type: 'Welcome'; requestId: string }
  | { type: 'SettingsApplied' | 'UserStartedSpeaking' | 'AgentThinking'
      | 'AgentStartedSpeaking' | 'AgentAudioDone' }
  | { type: 'ConversationText'; role: 'user' | 'assistant'; content: string }
  | { type: 'Error' | 'Warning'; code: string };

export function parseAgentEvent(text: string): AgentEvent | null {
  const invalid = () => new Error('AGENT_PROTOCOL_INVALID');
  if (Buffer.byteLength(text) > 65536) throw invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string') throw invalid();
  switch (v.type) {
    case 'Welcome':
      if (typeof v.request_id !== 'string' || !v.request_id ||
          v.request_id.length > 256) throw invalid();
      return { type: 'Welcome', requestId: v.request_id };
    case 'SettingsApplied':
    case 'UserStartedSpeaking':
    case 'AgentThinking':
    case 'AgentStartedSpeaking':
    case 'AgentAudioDone':
      // AgentThinking.content is deliberately discarded: never store reasoning.
      return { type: v.type };
    case 'ConversationText':
      if ((v.role !== 'user' && v.role !== 'assistant') ||
          typeof v.content !== 'string' ||
          Buffer.byteLength(v.content) > 16384) throw invalid();
      return { type: 'ConversationText', role: v.role, content: v.content };
    case 'Error':
    case 'Warning':
      return {
        type: v.type,
        code: typeof v.code === 'string' && /^[A-Z0-9_-]{1,64}$/.test(v.code)
          ? v.code : 'UNCLASSIFIED_PROVIDER_ERROR',
      };
    default:
      return null;
  }
}

export type PacingPorts = {
  now(): number;
  wait(ms: number): Promise<void>;
  send(frame: Buffer): void;
  signal: AbortSignal;
};

export async function pacePcm(
  pcm: Buffer, speechEndMs: number, p: PacingPorts,
): Promise<{ speechEndAt: number; maxLatenessMs: number }> {
  if (!pcm.length || pcm.length % 2560 !== 0 || pcm.length > 1920000 ||
      !Number.isFinite(speechEndMs) || speechEndMs < 0 ||
      speechEndMs > pcm.length / 32) throw new Error('INVALID_PCM');
  let offset = 0;
  let speechEndAt: number | null = null;
  const markerByte = speechEndMs * 32;
  const maxLatenessMs = await sharedPacePcm(
    pcm, { now: p.now }, p.wait, async (frame) => {
      const at = p.now();
      if (markerByte >= offset && markerByte <= offset + frame.length &&
          speechEndAt === null) speechEndAt = at + (markerByte - offset) / 32;
      p.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
      offset += frame.length;
    }, p.signal,
  );
  if (speechEndAt === null) throw new Error('INVALID_SPEECH_END_MARKER');
  return { speechEndAt, maxLatenessMs };
}
```

`Settings.agent.think.context_length = 45000` in the test is a character-count fixture only. Do not derive it from `maxContextTokens` or claim a common context ceiling. It is deliberately another reason the live candidate is not admitted.

- [ ] **Step 4: Run green, including an actual scheduler-delay case.**

Append this test to the same test file. P1's shared pacer retains absolute deadlines and rejects lateness above 80 ms; do not silently replace that matched policy with P3-specific scheduling.

```ts
it('records scheduler lateness using the shared absolute-deadline pacing policy', async () => {
  let time = 0;
  const sent: number[] = [];
  let delayed = false;
  const result = await pacePcm(Buffer.alloc(2560 * 3), 200, {
    now: () => time,
    wait: async (ms) => {
      time += ms;
      if (ms > 0 && !delayed) { time += 40; delayed = true; }
    },
    send: () => sent.push(time),
    signal: new AbortController().signal,
  });
  expect(sent).toEqual([0, 120, 160]);
  expect(result.maxLatenessMs).toBe(40);
  expect(result.speechEndAt).toBe(200);
});
```

Run: `npm exec --no -- vitest run deepgram-agent/__tests__/protocol.test.ts`

Expected: 6 tests pass. Raw frames concatenate byte-for-byte to the original fixture; partial frames are rejected, not padded or truncated. P1's corpus supplies already aligned 80 ms frames. No WAV header, JSON/base64 audio, `Finalize`, `/v2/listen`, `/v2/speak`, fabricated cancel command, or automatic greeting is sent. Text injection is a protocol check, never an extra uncounted benchmark turn or a replacement for the audio corpus.

- [ ] **Step 5: Offer an atomic commit.**

Files: `deepgram-agent/protocol.ts`, `deepgram-agent/__tests__/protocol.test.ts`.

Suggested message: `feat(voice-bench): implement Deepgram Voice Agent v1 wire protocol`

---

### Task 3: Observe decoded PCM onset, barge-in and stale tail without invented metrics

**Files**
- Create: `benchmarks/voice-architectures/deepgram-agent/measurements.ts`
- Test: `benchmarks/voice-architectures/deepgram-agent/__tests__/measurements.test.ts`

**Measurement definitions**

- All numbers use one caller-supplied monotonic clock. ISO time is metadata only.
- Output is already raw, headerless PCM16LE at 24 kHz; scan signed 16-bit samples for nonzero receipt. A provider event or silent frame cannot establish audio onset.
- Reuse P1's `DecodedObserver`, rather than implementing a second PCM scanner, gap counter or cutoff algorithm. Its anchor requires nonzero output at least 600 ms earlier and estimated nonzero frame end within 100 ms; P3 additionally rejects an anchor after `AgentAudioDone`. The marker is the first interrupting **input frame**, not the subsequent `UserStartedSpeaking` event.
- The shared observer uses a 100 ms quiet threshold and estimates received frame end as arrival plus decoded sample duration. Its provisional cutoff is the later of that end and the interruption marker. Observe the entire fixed 1,000 ms interval after it. Nonzero reappearance is stale tail, not successful interruption. These are headless decoded-boundary estimates, not DAC/buffer-drain timings.
- The managed binary stream lacks turn/generation IDs. A new `AgentThinking` or response-start event overlapping the stale-tail interval makes old/new audio attribution ambiguous; expose cutoff/tail metrics as `null`, not zero. Missing output, missing anchor, early disconnect, or an incomplete 1,000 ms window also yields `null`.
- `modelFirstOutputMs`, `ttsFirstAudioMs`, prompt/completion tokens, generation ID, and provider cost remain `null`. Provider-reported latency strings are not replacements for these measurements.

- [ ] **Step 1: Write the failing measurement tests.**

```ts
/**
 * ============================================================================
 * FILE: measurements.test.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/__tests__/measurements.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prevent false latency, audibility and interruption claims.
 *
 * ROLE IN PROJECT:
 *    Deterministic P3 receipt-boundary checks.
 *    Fixture timestamps are not live wall-clock measurements.
 *
 * KEY COMPONENTS:
 *    - ReceiptObserver fixtures: Nonzero onset, stale tail and unknown attribution.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import { ReceiptObserver } from '../measurements.js';

const voiced = () => { const b = Buffer.alloc(960); b.writeInt16LE(1); return b; };

it('ignores silence and keeps managed model/TTS stages null', () => {
  const m = new ReceiptObserver(100);
  m.pcm(Buffer.alloc(960), 120);
  m.thinking(130);
  m.pcm(voiced(), 160);
  expect(m.snapshot(160)).toMatchObject({
    speechEndToFirstAudioMs: 60,
    speechEndToThinkingMs: 30,
    modelFirstOutputMs: null,
    ttsFirstAudioMs: null,
    decodedPlaybackProof: 'unproven-headless-pcm-only',
    durableCompletionStatus: 'not-applicable',
  });
});

it('does not turn early output or missing audio into a fast successful response', () => {
  const early = new ReceiptObserver(100);
  early.pcm(voiced(), 80);
  expect(early.snapshot(100).speechEndToFirstAudioMs).toBeNull();
  expect(early.earlyEndpoint).toBe(true);
  const empty = new ReceiptObserver(100);
  expect(() => empty.interrupt(700)).toThrow('INTERRUPTION_ANCHOR_MISSING');
  expect(empty.snapshot(2000).interruptionToCutoffMs).toBeNull();
});

it('measures cutoff independently of events and observes a full 1000 ms window', () => {
  const m = new ReceiptObserver(0);
  m.pcm(voiced(), 10);
  m.pcm(voiced(), 610);
  m.interrupt(620);
  m.pcm(voiced(), 650);
  m.poll(850);
  expect(m.snapshot(1669).interruptionToCutoffMs).toBeNull();
  expect(m.snapshot(1670)).toMatchObject({
    interruptionToCutoffMs: 50,
    staleTailObservedMs: 1000,
    staleTailNonzeroFrames: 0,
  });
});

it('records reappearing nonzero tail rather than resetting it away', () => {
  const m = new ReceiptObserver(0);
  m.pcm(voiced(), 0);
  m.pcm(voiced(), 600);
  m.interrupt(610);
  m.poll(810);
  m.pcm(voiced(), 900);
  expect(m.snapshot(1620)).toMatchObject({
    interruptionToCutoffMs: 10,
    staleTailObservedMs: 1000,
    staleTailNonzeroFrames: 1,
  });
  expect(m.interruptionSucceeded(1620)).toBe(false);
});

it('leaves overlapping new-response attribution and early close unknown', () => {
  const m = new ReceiptObserver(0);
  m.pcm(voiced(), 0);
  m.pcm(voiced(), 600);
  m.interrupt(610);
  m.poll(810);
  m.thinking(900);
  expect(m.snapshot(2000).staleTailNonzeroFrames).toBeNull();
  expect(m.snapshot(2000).interruptionToCutoffMs).toBeNull();
  expect(m.interruptionSucceeded(2000)).toBe(false);
  const closed = new ReceiptObserver(0);
  closed.pcm(voiced(), 0);
  closed.pcm(voiced(), 600);
  closed.interrupt(610);
  closed.endObservation(700);
  expect(closed.snapshot(2000).interruptionToCutoffMs).toBeNull();
});
```

- [ ] **Step 2: Run red.**

Run: `npm exec --no -- vitest run deepgram-agent/__tests__/measurements.test.ts`

Expected: FAIL resolving `../measurements.js`.

- [ ] **Step 3: Implement the bounded observer.**

```ts
/**
 * ============================================================================
 * FILE: measurements.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/measurements.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Observe nonzero PCM receipt and conservative interruption boundaries.
 *
 * ROLE IN PROJECT:
 *    P3 measurements use one injected monotonic clock domain.
 *    Nothing here proves device audibility or durable heard-history.
 *
 * KEY COMPONENTS:
 *    - ReceiptObserver: Managed-event/nullability overlay on P1's decoded observer.
 * ============================================================================
 */
import type { TurnObservation } from '../shared/contracts.js';
import { DecodedObserver } from '../shared/timing.js';

type ReceiptMetrics = Pick<TurnObservation,
  'speechEndToFirstAudioMs' | 'speechEndToThinkingMs' | 'modelFirstOutputMs' |
  'ttsFirstAudioMs' | 'interruptionToCutoffMs' | 'staleTailObservedMs' |
  'staleTailNonzeroFrames' | 'streamGapCount' | 'maxStreamGapMs' |
  'decodedPlaybackProof' | 'durableCompletionStatus'>;

export class ReceiptObserver {
  private time = Number.NEGATIVE_INFINITY;
  private readonly observer = new DecodedObserver({ now: () => this.time });
  private thinkingAt: number | null = null;
  private marker: number | null = null;
  private ambiguous = false;
  private endedAt: number | null = null;
  private audioDone = false;

  constructor(private readonly speechEndAt: number) {
    if (!Number.isFinite(speechEndAt)) throw new Error('INVALID_MARKER');
    // A local observer label, not a provider/OpenRouter generation identifier.
    this.observer.begin('managed-no-generation-id', speechEndAt);
  }

  get earlyEndpoint(): boolean { return this.observer.snapshot().earlyEndpoint; }

  private advance(at: number): void {
    if (!Number.isFinite(at) || at < this.time) throw new Error('NON_MONOTONIC_CLOCK');
    this.time = at;
    this.observer.tick();
  }

  thinking(at: number): void {
    this.thinkingAt ??= at;
    this.newResponse(at);
  }

  newResponse(at: number): void {
    this.advance(at);
    if (this.marker !== null &&
        this.observer.snapshot().staleTailObservedMs !== 1000) this.ambiguous = true;
  }

  done(): void { this.audioDone = true; }

  pcm(frame: Buffer, at: number): void {
    if (this.endedAt !== null) return;
    if (!frame.length || frame.length % 2 || frame.length > 1048576 ||
        !Number.isFinite(at)) throw new Error('INVALID_OUTPUT_PCM');
    this.advance(at); // Tick before updating: late audio cannot erase a quiet gap.
    const samples = new Int16Array(frame.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = frame.readInt16LE(i * 2);
    this.observer.frame(samples, 24000, 1);
  }

  interrupt(at: number): void {
    if (this.marker !== null || this.audioDone) {
      throw new Error('INTERRUPTION_ANCHOR_MISSING');
    }
    this.advance(at);
    this.observer.interrupt();
    if (!this.observer.snapshot().interruptionAnchorObserved) {
      throw new Error('INTERRUPTION_ANCHOR_MISSING');
    }
    this.marker = at;
  }

  poll(at: number): void {
    this.advance(at);
  }

  endObservation(at: number): void { this.advance(at); this.endedAt = at; }

  interruptionSucceeded(at: number): boolean {
    const s = this.snapshot(at);
    return s.staleTailObservedMs === 1000 && s.staleTailNonzeroFrames === 0;
  }

  snapshot(at: number): ReceiptMetrics {
    const observedUntil = Math.min(at, this.endedAt ?? at);
    this.poll(observedUntil);
    const shared = this.observer.snapshot();
    const complete = !this.ambiguous && this.marker !== null &&
      shared.staleTailObservedMs === 1000;
    return {
      speechEndToFirstAudioMs: shared.speechEndToFirstAudioMs,
      speechEndToThinkingMs: this.thinkingAt !== null &&
        this.thinkingAt >= this.speechEndAt
        ? this.thinkingAt - this.speechEndAt : null,
      modelFirstOutputMs: null,
      ttsFirstAudioMs: null,
      interruptionToCutoffMs: complete ? shared.interruptionToCutoffMs : null,
      staleTailObservedMs: complete ? 1000 : null,
      staleTailNonzeroFrames: complete ? shared.staleTailNonzeroFrames : null,
      streamGapCount: shared.streamGapCount,
      maxStreamGapMs: shared.maxStreamGapMs,
      decodedPlaybackProof: 'unproven-headless-pcm-only',
      durableCompletionStatus: 'not-applicable',
    };
  }
}
```

This is deliberately constant-memory and one-turn scoped. Do not retain raw audio or arbitrary event arrays. Candidate fixture measurements stay fixture evidence; because preflight blocks, the public run's `turns` remains empty.

- [ ] **Step 4: Run green and preserve provider-terminal distinctions.**

Append:

```ts
it('does not accept AgentAudioDone as an interruption or physical playback proof', () => {
  const m = new ReceiptObserver(0);
  m.pcm(voiced(), 0);
  m.pcm(voiced(), 600);
  m.done();
  expect(() => m.interrupt(610)).toThrow('INTERRUPTION_ANCHOR_MISSING');
  expect(m.snapshot(2000).durableCompletionStatus).toBe('not-applicable');
  expect(m.snapshot(2000).interruptionToCutoffMs).toBeNull();
});
```

Run: `npm exec --no -- vitest run deepgram-agent/__tests__/measurements.test.ts`

Expected: 6 tests pass; completion is a transport/provider boundary only. A successful quiet fixture is not proof of a live interruption SLA.

- [ ] **Step 5: Offer an atomic commit.**

Files: `deepgram-agent/measurements.ts`, `deepgram-agent/__tests__/measurements.test.ts`.

Suggested message: `feat(voice-bench): measure Deepgram PCM onset and conservative stale tail`

---

### Task 4: Attach the genuine WebSocket state machine and guard the real opening seam

**Files**
- Create: `benchmarks/voice-architectures/deepgram-agent/client.ts`
- Test: `benchmarks/voice-architectures/deepgram-agent/__tests__/client.test.ts`

The attach function accepts an **already supplied** socket for offline fixtures. It does not make preflight ready. The network-opening function re-evaluates P3's own immutable preflight; there is no injectable ready result. A fixture factory returning a ready preflight is not permitted.

- [ ] **Step 1: Write mock-WebSocket tests.**

```ts
/**
 * ============================================================================
 * FILE: client.test.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/__tests__/client.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Test real Voice Agent event sequencing without opening a network socket.
 *
 * ROLE IN PROJECT:
 *    P3 protocol transport fixtures, not a simulated benchmark candidate.
 *    Synthetic EventEmitter sockets exercise the same client handlers.
 *
 * KEY COMPONENTS:
 *    - MockSocket: Minimal ws-compatible fixture.
 *    - Client checks: Handshake, failure, audio flags and bounded shutdown.
 * ============================================================================
 */
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { attachVoiceAgentV1, openVoiceAgentV1 } from '../client.js';
import { buildSettings } from '../protocol.js';
import { ReceiptObserver } from '../measurements.js';

class MockSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: { value: string | Buffer; binary: boolean }[] = [];
  terminated = 0;
  closed = 0;
  send(value: string | Buffer, options: { binary: boolean }) {
    this.sent.push({ value, binary: options.binary });
  }
  close() { this.closed += 1; }
  terminate() { this.terminated += 1; this.emit('close', 1006); }
  event(value: object) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  socket(): WebSocket { return this as unknown as WebSocket; }
}

const settings = () => buildSettings({
  modelId: 'vendor/requested-model', ttsModel: 'flux-haley-en',
  openRouterApiKey: 'fixture-key', prompt: 'Synthetic instruction.',
  contextCharacters: 45000, eotThreshold: 0.8, eotTimeoutMs: 5000,
});

afterEach(() => vi.useRealTimers());

it('sends Settings only after Welcome and permits input only after SettingsApplied', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  const events: string[] = [];
  const pcm = vi.fn();
  const session = attachVoiceAgentV1(ws.socket(), settings(), {
    onEvent: (e) => events.push(e.type), onPcm: pcm,
  });
  expect(ws.sent).toEqual([]);
  expect(() => session.text('Hi')).toThrow('AGENT_NOT_READY');
  ws.event({ type: 'Welcome', request_id: 'fixture-request' });
  expect(ws.sent).toEqual([{ value: JSON.stringify(settings()), binary: false }]);
  expect(() => session.audio(Buffer.alloc(2560))).toThrow('AGENT_NOT_READY');
  ws.event({ type: 'SettingsApplied' });
  await expect(session.ready).resolves.toBeUndefined();
  session.text('Hi');
  session.audio(Buffer.alloc(2560));
  expect(ws.sent[1]).toEqual({
    value: '{"type":"InjectUserMessage","content":"Hi"}', binary: false,
  });
  expect(ws.sent[2]?.binary).toBe(true);
  for (const type of ['UserStartedSpeaking', 'AgentThinking',
    'AgentStartedSpeaking', 'AgentAudioDone']) ws.event({ type, content: 'discard' });
  ws.emit('message', Buffer.alloc(960), true);
  expect(pcm).toHaveBeenCalledOnce();
  expect(events).toEqual([
    'Welcome', 'SettingsApplied', 'UserStartedSpeaking',
    'AgentThinking', 'AgentStartedSpeaking', 'AgentAudioDone',
  ]);
  const closing = session.close();
  ws.emit('close', 1000);
  await closing;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['provider', 'socket', 'early-close', 'malformed', 'out-of-order'])(
  'rejects a %s handshake failure without reconnect or raw payload leakage',
  async (kind) => {
    vi.useFakeTimers();
    const ws = new MockSocket();
    const session = attachVoiceAgentV1(ws.socket(), settings());
    const rejected = expect(session.ready).rejects.toThrow(/^AGENT_/);
    if (kind === 'provider') ws.event({
      type: 'Error', code: 'INVALID_SETTINGS', description: 'fixture-key',
    });
    if (kind === 'socket') ws.emit('error', new Error('fixture-key'));
    if (kind === 'early-close') ws.emit('close', 1006);
    if (kind === 'malformed') ws.emit('message', Buffer.from('{'), false);
    if (kind === 'out-of-order') ws.event({ type: 'SettingsApplied' });
    await rejected;
    await session.close();
    expect(ws.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('times out a silent handshake and forcibly terminates bounded cleanup', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  const session = attachVoiceAgentV1(ws.socket(), settings());
  const rejected = expect(session.ready).rejects.toThrow('AGENT_SETUP_TIMEOUT');
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  await session.close();
  expect(ws.terminated).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores late frames after shutdown and does not retry partial-response errors', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  const pcm = vi.fn();
  const failures: string[] = [];
  const session = attachVoiceAgentV1(ws.socket(), settings(), {
    onPcm: pcm, onFailure: (code) => failures.push(code),
  });
  ws.event({ type: 'Welcome', request_id: 'fixture-request' });
  ws.event({ type: 'SettingsApplied' });
  await session.ready;
  ws.emit('message', Buffer.alloc(960), true);
  ws.event({ type: 'Error', code: 'INTERNAL_SERVER_ERROR', description: 'fixture-key' });
  ws.emit('message', Buffer.alloc(960), true);
  await session.close();
  expect(pcm).toHaveBeenCalledOnce();
  expect(failures).toEqual(['AGENT_PROVIDER_ERROR']);
  expect(ws.sent).toHaveLength(1);
});

it('blocks the real socket factory even when explicit live intent and keys are supplied', async () => {
  const openSocket = vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); });
  await expect(openVoiceAgentV1({
    region: 'eu', deepgramApiKey: 'fixture-deepgram', settings: settings(),
  }, openSocket)).rejects.toThrow('BLOCKED_BYO_CONTROLS_UNSUPPORTED');
  expect(openSocket).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run red.**

Run: `npm exec --no -- vitest run deepgram-agent/__tests__/client.test.ts`

Expected: FAIL resolving `../client.js`.

- [ ] **Step 3: Implement bounded state and the guarded real `ws` seam.**

```ts
/**
 * ============================================================================
 * FILE: client.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Speak the genuine Voice Agent v1 protocol over a ws-compatible socket.
 *
 * ROLE IN PROJECT:
 *    Offline attachable transport and preflight-guarded real socket opening.
 *    No direct STT/TTS loop or managed-LLM substitution is implemented.
 *
 * KEY COMPONENTS:
 *    - attachVoiceAgentV1: Handshake, event dispatch, input and finite shutdown.
 *    - openVoiceAgentV1: Real ws constructor behind immutable BYO preflight.
 * ============================================================================
 */
import WebSocket, { type RawData } from 'ws';
import { preflightDeepgramAgent } from './harness.js';
import {
  agentEndpoint, injectUserMessage, parseAgentEvent,
  type AgentEvent, type buildSettings,
} from './protocol.js';

type Settings = ReturnType<typeof buildSettings>;
type Hooks = {
  onEvent?(event: AgentEvent, at: number): void;
  onPcm?(frame: Buffer, at: number): void;
  onFailure?(code: string): void;
};
type SocketFactory = (
  url: string, options: WebSocket.ClientOptions,
) => WebSocket;

export function attachVoiceAgentV1(
  socket: WebSocket,
  settings: Settings,
  hooks: Hooks = {},
  signal?: AbortSignal,
  now: () => number = () => performance.now(),
) {
  let state: 'welcome' | 'settings' | 'ready' | 'closed' = 'welcome';
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve; rejectReady = reject;
  });
  let closePromise: Promise<void> | null = null;
  let resolveClose: (() => void) | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const setupTimer = setTimeout(() => fail('AGENT_SETUP_TIMEOUT'), 10000);
  const lifetimeTimer = setTimeout(() => fail('AGENT_SESSION_TIMEOUT'), 300000);
  const abort = () => fail('AGENT_CANCELLED');

  function detach(): void {
    clearTimeout(setupTimer);
    clearTimeout(lifetimeTimer);
    if (closeTimer !== null) clearTimeout(closeTimer);
    signal?.removeEventListener('abort', abort);
    socket.off('message', message);
    // Keep close/error listeners until transport termination is observed.
  }

  function closed(): void {
    if (state !== 'closed') fail('AGENT_EARLY_CLOSE');
    detach();
    socket.off('close', closed);
    socket.off('error', socketError);
    resolveClose?.();
  }

  function fail(code: string): void {
    if (state === 'closed') return;
    state = 'closed';
    if (!settled) { settled = true; rejectReady(new Error(code)); }
    detach();
    socket.terminate();
    hooks.onFailure?.(code);
  }

  function socketError(): void { fail('AGENT_SOCKET_ERROR'); }

  function send(value: string | Buffer, binary: boolean): void {
    if (socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > 262144) {
      fail('AGENT_BACKPRESSURE_OR_CLOSED');
      throw new Error('AGENT_BACKPRESSURE_OR_CLOSED');
    }
    socket.send(value, { binary }, (error) => {
      if (error) fail('AGENT_SEND_FAILED');
    });
  }

  function message(data: RawData, isBinary: boolean): void {
    if (state === 'closed') return;
    try {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data)
        ? Buffer.concat(data) : Buffer.from(data);
      if (bytes.length > 1048576) throw new Error('AGENT_FRAME_TOO_LARGE');
      if (isBinary) {
        if (state !== 'ready' || !bytes.length || bytes.length % 2) {
          throw new Error('AGENT_AUDIO_OUT_OF_ORDER');
        }
        hooks.onPcm?.(bytes, now());
        return;
      }
      const event = parseAgentEvent(bytes.toString('utf8'));
      if (!event) return;
      if (event.type === 'Error') { fail('AGENT_PROVIDER_ERROR'); return; }
      if (event.type === 'Welcome') {
        if (state !== 'welcome') throw new Error('AGENT_DUPLICATE_WELCOME');
        state = 'settings';
        send(JSON.stringify(settings), false);
      } else if (event.type === 'SettingsApplied') {
        if (state !== 'settings') throw new Error('AGENT_SETTINGS_OUT_OF_ORDER');
        state = 'ready';
        settled = true;
        clearTimeout(setupTimer);
        resolveReady();
      } else if (state !== 'ready') {
        throw new Error('AGENT_EVENT_OUT_OF_ORDER');
      }
      hooks.onEvent?.(event, now());
    } catch {
      fail('AGENT_PROTOCOL_FAILURE');
    }
  }

  socket.on('message', message);
  socket.on('close', closed);
  socket.on('error', socketError);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  return {
    ready,
    text(content: string): void {
      if (state !== 'ready') throw new Error('AGENT_NOT_READY');
      send(JSON.stringify(injectUserMessage(content)), false);
    },
    audio(frame: Buffer): void {
      if (state !== 'ready') throw new Error('AGENT_NOT_READY');
      if (!frame.length || frame.length % 2 || frame.length > 2560) {
        throw new Error('INVALID_PCM_FRAME');
      }
      send(frame, true);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      if (state === 'closed') return Promise.resolve();
      state = 'closed';
      if (!settled) { settled = true; rejectReady(new Error('AGENT_CANCELLED')); }
      detach();
      closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
      closeTimer = setTimeout(() => {
        socket.terminate(); closed();
      }, 1000);
      socket.close(1000);
      return closePromise;
    },
  };
}

export async function openVoiceAgentV1(
  config: { region: string; deepgramApiKey: string; settings: Settings },
  factory: SocketFactory = (url, options) => new WebSocket(url, options),
) {
  const preflight = preflightDeepgramAgent(new Date().toISOString());
  if (preflight.status !== 'ready') throw new Error(preflight.reasons[0]);
  // Not reachable under the current immutable policy. Retained actual wire seam,
  // not an admitted live path and not an invitation to bypass preflight.
  const socket = factory(agentEndpoint(config.region), {
    headers: { Authorization: `Token ${config.deepgramApiKey}` },
    followRedirects: false,
    handshakeTimeout: 10000,
    maxPayload: 1048576,
    perMessageDeflate: false,
  });
  return attachVoiceAgentV1(socket, config.settings);
}
```

The real constructor is intentionally behind an always-blocked gate. The fixtures attach to the genuine protocol implementation, not a fake ready candidate. `Settings` and authorization headers are never sent by `openVoiceAgentV1` today. Do not attempt to make this branch reachable by mocking the preflight or exposing a policy override.

- [ ] **Step 4: Add exact post-ready cancellation, cleanup, and backpressure checks.**

Append:

```ts
it('cancels after SettingsApplied, is idempotent and forces close after one second', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  const controller = new AbortController();
  const failures: string[] = [];
  const s = attachVoiceAgentV1(ws.socket(), settings(), {
    onFailure: (code) => failures.push(code),
  }, controller.signal);
  ws.event({ type: 'Welcome', request_id: 'fixture-request' });
  ws.event({ type: 'SettingsApplied' });
  await s.ready;
  controller.abort();
  await s.close();
  await s.close();
  expect(ws.terminated).toBe(1);
  expect(failures).toEqual(['AGENT_CANCELLED']);
  expect(vi.getTimerCount()).toBe(0);

  const second = new MockSocket();
  const pending = attachVoiceAgentV1(second.socket(), settings());
  second.event({ type: 'Welcome', request_id: 'fixture-request-2' });
  second.event({ type: 'SettingsApplied' });
  await pending.ready;
  const closing = pending.close();
  expect(pending.close()).toBe(closing);
  await vi.advanceTimersByTimeAsync(1000);
  await closing;
  expect(second.terminated).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects excessive queued output without sending another frame', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  const s = attachVoiceAgentV1(ws.socket(), settings());
  ws.event({ type: 'Welcome', request_id: 'fixture-request' });
  ws.event({ type: 'SettingsApplied' });
  await s.ready;
  ws.bufferedAmount = 262145;
  expect(() => s.audio(Buffer.alloc(2560))).toThrow('AGENT_BACKPRESSURE_OR_CLOSED');
  expect(ws.sent).toHaveLength(1);
  await s.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('feeds the same socket events and binary frames into the shared-backed receipt observer', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  let at = 0;
  const m = new ReceiptObserver(100);
  const s = attachVoiceAgentV1(ws.socket(), settings(), {
    onPcm: (frame, time) => m.pcm(frame, time),
    onEvent: (event, time) => {
      if (event.type === 'AgentThinking') m.thinking(time);
      if (event.type === 'AgentStartedSpeaking') m.newResponse(time);
      if (event.type === 'AgentAudioDone') m.done();
    },
  }, undefined, () => at);
  ws.event({ type: 'Welcome', request_id: 'fixture-request' });
  ws.event({ type: 'SettingsApplied' });
  await s.ready;
  at = 130;
  ws.event({ type: 'AgentThinking', content: 'DISCARD_PRIVATE_THOUGHT' });
  at = 140;
  ws.event({ type: 'AgentStartedSpeaking',
    total_latency: '0.001', ttt_latency: '0.001', tts_latency: '0.001' });
  const frame = Buffer.alloc(960); frame.writeInt16LE(1);
  at = 160; ws.emit('message', frame, true);
  at = 760; ws.emit('message', frame, true);
  at = 770; m.interrupt(at); s.audio(Buffer.alloc(2560));
  at = 775; ws.event({ type: 'UserStartedSpeaking' });
  at = 800; ws.emit('message', frame, true);
  at = 825; ws.event({ type: 'AgentAudioDone' });
  expect(m.snapshot(900).interruptionToCutoffMs).toBeNull();
  expect(m.snapshot(1820)).toMatchObject({
    speechEndToFirstAudioMs: 60,
    modelFirstOutputMs: null, ttsFirstAudioMs: null,
    interruptionToCutoffMs: 50,
    staleTailObservedMs: 1000, staleTailNonzeroFrames: 0,
  });
  const closing = s.close(); ws.emit('close', 1000); await closing;
  expect(vi.getTimerCount()).toBe(0);
});
```

Run: `npm exec --no -- vitest run deepgram-agent/__tests__/client.test.ts`

Expected: 12 tests pass, zero skips, no reconnects/paid calls, no leaked timers. The combined fixture connects actual socket handlers to shared-backed observations and never substitutes provider latency strings for local measurements. Do not log provider descriptions, WS close reasons, complete Settings, authorization headers, or thought text.

- [ ] **Step 5: Offer an atomic commit.**

Files: `deepgram-agent/client.ts`, `deepgram-agent/__tests__/client.test.ts`.

Suggested message: `feat(voice-bench): add guarded Deepgram Voice Agent socket lifecycle`

---

### Task 5: Generate honest per-architecture Markdown and raw JSON

**Files**
- Create: `benchmarks/voice-architectures/deepgram-agent/report.ts`
- Create: `benchmarks/voice-architectures/deepgram-agent/report.md`
- Test: `benchmarks/voice-architectures/deepgram-agent/__tests__/report.test.ts`

P1's runner owns run directories, source/build hashes, credentials and the main compiler. Reuse its writer and renderer rather than making a second serialization path. P3's canonical blocked record has **no attempted turn records**; it does not invent six submitted attempts. The approved corpus still has six planned slots, but none is consumed or reallocated.

- [ ] **Step 1: Write the exact report checks.**

```ts
/**
 * ============================================================================
 * FILE: report.test.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/__tests__/report.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Check shared-report integration for Deepgram's zero-network policy block.
 *
 * ROLE IN PROJECT:
 *    Offline P3 evidence serialization checks.
 *    No fixture result is presented as a live provider observation.
 *
 * KEY COMPONENTS:
 *    - Report checks: Unknown metrics, policy reasons, boundaries and counts.
 *    - Writer checks: Existing shared redaction and owned candidate paths.
 * ============================================================================
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { reportSchema, type RunContext } from '../../shared/contracts.js';
import { newReport } from '../../shared/compiler.js';
import { SecretRedactor } from '../../shared/credentials.js';
import { makeBlockedRun, preflightDeepgramAgent } from '../harness.js';
import { renderDeepgramReport, writeReport } from '../report.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(), writeFile: vi.fn() };
});
afterEach(() => vi.clearAllMocks());
const runId = '00000000-0000-4000-8000-000000000003';
const at = '2026-11-16T00:00:00.000Z';
function context(): RunContext {
  return {
    mode: 'dry-run', runId, startedAtIso: at,
    repoRoot: process.cwd(), packageRoot: process.cwd(),
    outputDir: resolve('results', 'fixture-p3'),
    clock: { now: () => 0 }, signal: new AbortController().signal,
    credentials: null, guard: null, corpus: [],
    redactor: new SecretRedactor(['fixture-secret']),
  };
}

it('formats US$0 policy and nulls even when the runner skips the blocked run method', () => {
  const p = preflightDeepgramAgent(at);
  // This is P1's actual blocked-selection path: run() is not called.
  const result = newReport('deepgram-agent', runId, 'live', p);
  expect(reportSchema.parse(result).turns).toEqual([]);
  const text = renderDeepgramReport(result);
  for (const expected of [
    '# deepgram-agent voice architecture screening',
    'BLOCKED_BYO_CONTROLS_UNSUPPORTED', 'US$0 spent',
    'max_tokens / max_completion_tokens', 'provider.allow_fallbacks: false',
    'OpenAI-only model enum', 'not physical speaker audibility',
    '"modelFirstOutputMs": null', '"ttsFirstAudioMs": null',
    '"generationId": null', '"providerReportedUsd": null',
    '"submittedTurns": 0', 'Review skipped',
  ]) expect(text).toContain(expected);
  expect(text).not.toContain('p95: 0');
  expect(result.turns).toHaveLength(0);
});

it('uses the shared validated writer and candidate-owned result/report paths', async () => {
  const ctx = context();
  await writeReport(ctx, makeBlockedRun('dry-run', at, runId));
  expect(vi.mocked(writeFile).mock.calls.map(([path]) => String(path))).toEqual([
    resolve(ctx.outputDir, 'deepgram-agent', 'result.json'),
    resolve(ctx.outputDir, 'deepgram-agent', 'report.md'),
  ]);
  expect(writeFile).toHaveBeenCalledWith(
    expect.any(String), expect.any(String), expect.objectContaining({ flag: 'wx' }),
  );
});

it('fails redaction before any report directory or file is written', async () => {
  const result = makeBlockedRun('dry-run', at, runId);
  result.provenance.injectedSecret = 'fixture-secret';
  await expect(writeReport(context(), result)).rejects.toThrow('BENCHMARK_REDACTION_FAILED');
  expect(mkdir).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run red.**

Run: `npm exec --no -- vitest run deepgram-agent/__tests__/report.test.ts`

Expected: FAIL resolving `../report.js`, not a shared fixture skip or real filesystem access.

- [ ] **Step 3: Re-export P1's existing validated formatter and writer.**

```ts
/**
 * ============================================================================
 * FILE: report.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/report.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose the shared validated formatter and writer for the Deepgram candidate.
 *
 * ROLE IN PROJECT:
 *    P3 adds policy detail to preflight rather than forking the report schema.
 *    P1 retains serialization, redaction and run-directory ownership.
 *
 * KEY COMPONENTS:
 *    - renderDeepgramReport: Shared deterministic Markdown rendering.
 *    - writeReport: Shared validated and redacted JSON/Markdown writer.
 * ============================================================================
 */
export {
  renderArchitectureReport as renderDeepgramReport,
  writeArchitectureReport as writeReport,
} from '../shared/compiler.js';
```

Use P1's `SecretRedactor.encode`, strict `reportSchema`, `flag: 'wx'` run-owned artifact writes, and existing publishing path. P1's raw per-run filename is `result.json`; research's `latest-result.json` was a recommendation, not a second required schema. Do not add an overlapping raw writer. P1/V1 publishing puts the final human report at `deepgram-agent/report.md`. A filesystem failure propagates; no atomic two-file transaction is claimed.

- [ ] **Step 4: Run green and confirm actual schema integration.**

Run: `npm exec --no -- vitest run deepgram-agent/__tests__/report.test.ts`

Expected: 3 tests pass, no real filesystem writes. Both a defensive direct run and the runner's actual preflight-only blocked path preserve the exact incompatibility details. The compiler must not parse a cost zero as an observed latency or invent submitted turns.

- [ ] **Step 5: Add the initial candidate report without fabricating a run.**

Create `benchmarks/voice-architectures/deepgram-agent/report.md` with this exact initial content:

```markdown
# Deepgram Voice Agent v1

**BLOCKED_BYO_CONTROLS_UNSUPPORTED — US$0 spent.**

This is the implementation's documented structural policy, not an executed live
benchmark. Actual execution provenance and deterministic-check results are supplied
by V1's generated report. No live turns or provider timings are claimed here.

## Structural incompatibility

- `ThinkSettingsV1` / `OpenAiThinkProvider` do not expose per-attempt OpenRouter `user`.
- Missing JSON-body `provider.data_collection: 'deny'`, `require_parameters: true`,
  `allow_fallbacks: false`, `transforms: []`, and disabled plugins.
- Missing `max_tokens` / `max_completion_tokens`; `context_length` retains characters.
- Cloud-side LLM dispatches cannot be guarded by local `BudgetGuard` or local
  `maxRetry: 0` / `maxRetries: 0`.
- Attributable token totals, OpenRouter generation IDs and generation cost are
  unobservable.
- The OpenAI-only model enum makes vendor/model acceptance unverified.

## Boundaries

The public candidate blocks before any HTTP/WebSocket open, credential transfer,
budget consumption or input submission. Entitlement is not checked. No paid calls
are needed to establish this incompatibility.

No Deepgram-managed LLM substitution, public proxy, tunnel or runtime policy bypass
is implemented. A later exception requires a separate decision and implementation.

Decoded 24 kHz PCM receipt is not physical speaker audibility. Provider terminal
events are not durable heard-history proof. Unobservable model/TTS timing, token
usage, generation ID and invoice cost remain null, never zero-valued measurements.

Unified review: skipped. Live service and browser/device checks: unrun.
```

This documentation step needs no application test beyond the formatter suite and `git diff --check`. V1 owns replacing the static explanation with actual checks/source/build hashes and generated reports. Do not generate fixture `latest-result.json` into the checkout just to suggest real run evidence.

- [ ] **Step 6: Offer an atomic commit.**

Files: `deepgram-agent/report.ts`, `deepgram-agent/report.md`, `deepgram-agent/__tests__/report.test.ts`.

Suggested message: `feat(voice-bench): report Deepgram BYO block and unobservable metrics honestly`

---

### Task 6: Bind P1's actual ArchitectureHarness and verify P3 end to end offline

**Files**
- Modify: `benchmarks/voice-architectures/deepgram-agent/harness.ts`
- Modify: `benchmarks/voice-architectures/deepgram-agent/__tests__/harness.test.ts`
- Read-only prerequisite: `benchmarks/voice-architectures/shared/contracts.ts`, P1 runner adapter registration and shared report/redaction definitions.
- No edits to P1-owned files. P1 registers/selects the candidate; P3 exports its exact expected `harness` implementation.

- [ ] **Step 1: Verify the upstream ABI checkpoint before writing the shim.**

Read the completed shared `ArchitectureHarness`, `ArchitectureReport`, and context declarations and P1's existing candidate registration. Confirm:

1. `id`, `preflight(context)` and `run(context, preflight)` match P1's declared ABI.
2. `RunContext` includes `mode`, `runId`, `startedAtIso`, roots/output directory, clock, signal, credentials, guard, corpus and redactor.
3. `newReport` and strict `reportSchema` produce the report shape used in Task 1.
4. `writeArchitectureReport` writes run-owned `result.json` / `report.md`; P1/V1 publishes the final candidate Markdown.
5. A blocked preflight is retained even though the runner correctly skips `harness.run`.
6. P1 does not prepare provider/network/DB credentials or catalogue rates for P3 before its decisive structural preflight.

If implementation has diverged from P1's plan, report an upstream dependency mismatch before integrating. Do not edit shared files or cast an incompatible object to the interface. No harness cleanup method is declared; a blocked report already states zero open sockets and no created resources.

- [ ] **Step 2: Write the failing public-contract test against the confirmed ABI.**

Add imports to the existing harness test file:

```ts
import { reportSchema, type ArchitectureHarness, type RunContext } from '../../shared/contracts.js';
import { SecretRedactor } from '../../shared/credentials.js';
import { harness as deepgramAgentHarness } from '../harness.js';
```

Append this exact test:

```ts
it('implements the shared candidate contract and keeps repeated public live runs blocked', async () => {
  const harness: ArchitectureHarness = deepgramAgentHarness;
  const context: RunContext = {
    mode: 'live', runId: '00000000-0000-4000-8000-000000000003',
    startedAtIso: '2026-11-16T00:00:00.000Z',
    repoRoot: process.cwd(), packageRoot: process.cwd(), outputDir: 'unused',
    clock: { now: () => 0 }, signal: new AbortController().signal,
    get credentials() { throw new Error('CREDENTIAL_ACCESS_FORBIDDEN'); },
    get guard() { throw new Error('BUDGET_ACCESS_FORBIDDEN'); },
    corpus: [], redactor: new SecretRedactor(),
  };
  const fetcher = vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); });
  vi.stubGlobal('fetch', fetcher);
  expect(harness.id).toBe('deepgram-agent');
  const p = await harness.preflight(context);
  expect(p.status).toBe('blocked');
  const forgedReady = { ...p, status: 'ready' as const, reasons: [] };
  const first = await harness.run(context, forgedReady);
  const second = await harness.run(context, p);
  expect(first).toEqual(makeBlockedRun('live', context.startedAtIso, context.runId));
  expect(second).toEqual(first);
  expect(reportSchema.parse(first).preflight.status).toBe('blocked');
  expect(first.envelope.submittedTurns).toBe(0);
  expect(first.envelope.conservativeReserveUsd).toBe(0);
  expect(first.cleanup).toEqual({ resources: [], openSockets: 0, complete: true });
  expect(fetcher).not.toHaveBeenCalled();
});
```

The throwing getters prove the candidate does not inspect credentials or touch the budget object to establish the block. It also refuses a forged caller-supplied ready result; a valid key or authorization envelope cannot erase structural omissions.

Run: `npm exec --no -- vitest run deepgram-agent/__tests__/harness.test.ts`

Expected red: missing exported `harness`.

- [ ] **Step 3: Add the smallest type-checked binding, without a new abstraction.**

Merge these types into the existing shared import and append:

```ts
import type { ArchitectureHarness, RunContext } from '../shared/contracts.js';

export const harness = {
  id: 'deepgram-agent',
  async preflight(context: RunContext) {
    return preflightDeepgramAgent(context.startedAtIso);
  },
  async run(context: RunContext, _suppliedPreflight: PreflightResult) {
    return makeBlockedRun(context.mode, context.startedAtIso, context.runId);
  },
} satisfies ArchitectureHarness;
```

P1's runner must select this export and retain its preflight. Correctly skipping the blocked `run` must **not** discard P3's reason codes/provenance or silently replace it with a generic missing-credential record. The real `openVoiceAgentV1` seam is independently gate-tested; public blocked runs never invoke it.

P1's shared report writer/publisher is the single output path. P3's candidate-local exports in Task 5 use it unchanged. P3's own candidate cost is zero; a sequential runner's cumulative envelope may include earlier candidates' spend. Never replace that aggregate ledger with a fresh zero snapshot merely because P3 was blocked. Do not introduce a second standalone CLI or write the compiled main report.

- [ ] **Step 4: Run all candidate checks and package type checks.**

Run individually:

```bash
npm exec --no -- vitest run deepgram-agent/__tests__
```

Expected: all five candidate test files discovered and passing with zero skipped; fixture timings explicitly synthetic. With the test inventory shown here and the final shared test, the expected count is **31** (4 harness, 6 protocol, 6 measurement, 12 client, 3 report). Report actual counts if P3 adds further checks.

```bash
npm run build
```

Expected: exit 0, including shared `ArchitectureHarness` assignability and real `ws` typings.

```bash
npm run lint
```

Expected: exit 0. If P1 supplies stricter lint rules, fix only P3-owned code without unsafe casts or disabling checks.

If P1 implements the researched command names, run the default offline candidate route:

```bash
npm run bench:deepgram-agent
```

Expected: identifies the genuine candidate, returns/reports `BLOCKED_BYO_CONTROLS_UNSUPPORTED`, zero submissions/dispatches/network opens/paid time, US$0; observed settings and entitlement remain unknown. No `--live` execution is authorized in this implementation task. An offline diagnostic exit code must follow P1's blocked-result convention; the structured status and report, not a zero process exit, establish what happened.

Do not run backend/frontend suites, native DB tests, `GET /v1/auth/token`, model catalogue probes, real WebSockets, or the sequential live pilot for this worker task. V1 owns integrated checks and bounded live execution after all workers complete; this candidate remains blocked there.

- [ ] **Step 5: Check exact write isolation and artifact consistency.**

From repository root:

```bash
git diff --check
```

Expected: exit 0.

```bash
git status --short
```

Compare with the worker's initial status. Report only P3-owned additions/modifications; existing or concurrently changed frontend/research files are not P3 work. Do not require a globally clean checkout, stage unrelated files, or revert them. Confirm no P3 changes to `backend/`, `frontend/`, root config, manifest/lockfile, shared code, or production environment/configuration. Confirm every new code file has its mandatory full header.

Inspect generated Markdown/JSON without printing secrets. Check that:

- Actual mode, timestamp, source/build hashes, package versions and dirty state come from P1/V1, not the synthetic test metadata.
- No test input Settings, authorization headers, real keys, `AgentThinking.content`, or raw provider error descriptions enter artifacts.
- Empty `turns` and submitted-count zero survive compilation; six planned slots do not consume or reallocate allowance.
- Setup, warm follow-up, hesitation and interruption summaries remain separated and null for this blocked candidate.
- Review says skipped, live/native/browser claims say unrun, and no latency/completion ranking includes this candidate.

- [ ] **Step 6: Offer the final atomic commit and worker handoff.**

Files: only P3's `harness.ts` and `__tests__/harness.test.ts`.

Suggested message: `feat(voice-bench): bind blocked Deepgram candidate to shared harness`

Worker report must give:

- Exact changed P3 paths and orchestrator-serialized commit references.
- Actual test/build/lint/dry-run commands, counts/results/skips, and the confirmed shared ABI.
- Explicit **implemented/tested offline**, **live blocked**, **US$0**, **entitlement unverified**, **review skipped**.
- Any P1 integration issue as a blocking dependency, not a local contract fork.

---

## Planner self-check and acceptance coverage

This is a planning artifact; no implementation test or live call has been executed by the planner.

- [x] Scope is P3 only; the only current write is `docs/voice-architecture-benchmark/plan3.md`.
- [x] P1 owns dependencies, shared ABI, runner/compiler, credential import and redaction.
- [x] Tasks include exact failing tests, red/green Vitest commands, concrete minimal code, mandatory headers and atomic commit suggestions.
- [x] Direct v1 endpoints, Flux STT/TTS v2, 16/24 kHz raw PCM, Settings-after-Welcome, input-after-SettingsApplied, InjectUserMessage and binary frames are covered.
- [x] UserStartedSpeaking, AgentThinking, AgentStartedSpeaking, AgentAudioDone, ConversationText, Error/Warning, close/timeout/cancel/late frames are handled without automatic reconnect.
- [x] Barge-in requires an output anchor; stale tail is observed independently; missing/ambiguous/incomplete metrics are null.
- [x] Thought-process text is discarded and provider errors are reduced to safe codes.
- [x] Every researched structural blocker, OpenAI model-enum risk, and the character-vs-token distinction is recorded.
- [x] Both dry-run and live intent are unconditionally blocked before any network/credential transfer, with zero submissions and US$0.
- [x] No public proxy, managed-LLM substitution, runtime bypass, live admission, installation or Git mutation is planned for this planner.
- [x] Per-architecture Markdown/JSON output reuses P1's strict validated/redacted writer; planned-vs-attempted counts are explicit.
- [x] Shared `ArchitectureHarness` matches P1's handoff: exported `harness`, `id`, `preflight(context)` and `run(context, preflight)`, without a duplicate interface or cast.
- [x] Review remains skipped; fixtures do not certify live services, physical audibility, invoice caps, SLAs or a winning architecture.
