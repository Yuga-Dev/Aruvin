/**
 * ============================================================================
 * FILE: harness.test.ts
 * LOCATION: benchmarks/voice-architectures/livekit-agents/__tests__/harness.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    admission/lifecycle fixtures; shared-contract conformance.
 *
 * ROLE IN PROJECT:
 *    Supplies P2's standalone framework candidate without changing Aurvin.
 *    Consumes only the isolated package and P1-owned run configuration.
 *
 * KEY COMPONENTS:
 *    - admission/lifecycle fixtures; shared-contract conformance.
 * ============================================================================
 */
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import type { Room } from '@livekit/rtc-node';
import type { ArchitectureHarness, RunContext } from '../../shared/contracts.js';
import { SecretRedactor } from '../../shared/credentials.js';
import { loadSilero } from '../config.js';
import {
  bounded, GuardedAgent, harness, makePipeline, openSession, type PipelineInput,
} from '../harness.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

// P1 did not export a typed Room fixture. Tests only; never a production escape hatch.
function fixtureRoom(): Room {
  // Test double only. P1 has no typed Room fixture; production start() takes a real Room.
  return { disconnect: vi.fn(async () => undefined) } as unknown as Room;
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

it('starts with the pinned caller identity and does not greet or generateReply', async () => {
  const vad = await loadSilero();
  const p = makePipeline(input(vad));
  const room = fixtureRoom();
  const start = vi.spyOn(p.session, 'start').mockResolvedValue(undefined);
  const generateReply = vi.spyOn(p.session, 'generateReply');
  try {
    await p.start(room);
    expect(start).toHaveBeenCalledTimes(1);
    const args = start.mock.calls[0]![0];
    expect(args.room).toBe(room);
    expect(args.agent).toBe(p.agent);
    expect(args.inputOptions?.participantIdentity).toBe('caller-fixture');
    expect(args).not.toHaveProperty('roomOptions');
    expect(args.record).toBe(false);
    expect(generateReply).not.toHaveBeenCalled();
  } finally {
    start.mockRestore();
    generateReply.mockRestore();
    await p.close();
    await vad.close();
  }
}, 30000);

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

it('expired authorization prevents TTS prewarm and room join', async () => {
  const vad = await loadSilero();
  try {
    const settings = input(vad);
    settings.guard.assertActive = vi.fn(() => { throw new Error('AUTHORIZATION_EXPIRED'); });
    expect(() => makePipeline(settings)).toThrow('AUTHORIZATION_EXPIRED');
  } finally {
    await vad.close();
  }
}, 30000);

it('close emitted while start is pending wins over late start success', async () => {
  const vad = await loadSilero();
  const p = makePipeline(input(vad));
  const room = fixtureRoom();
  let resolveStart!: () => void;
  const held = new Promise<void>((resolve) => { resolveStart = resolve; });
  vi.spyOn(p.session, 'start').mockReturnValue(held);
  const closed = vi.spyOn(p.session, 'close').mockResolvedValue(undefined);
  try {
    const pending = openSession(p, room, new AbortController().signal, 5000);
    p.session.emit(voice.AgentSessionEventTypes.Close, {} as never);
    await expect(pending).rejects.toThrow('AGENTS_EARLY_CLOSE');
    resolveStart();
    await Promise.resolve();
    await Promise.resolve();
    expect(room.disconnect).toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
  } finally {
    await p.close().catch(() => undefined);
    await vad.close();
  }
}, 30000);

it('cancellation during setup aborts resources and rejects late successful setup', async () => {
  const vad = await loadSilero();
  const p = makePipeline(input(vad));
  const room = fixtureRoom();
  const abort = new AbortController();
  let resolveStart!: () => void;
  const held = new Promise<void>((resolve) => { resolveStart = resolve; });
  vi.spyOn(p.session, 'start').mockReturnValue(held);
  vi.spyOn(p.session, 'close').mockResolvedValue(undefined);
  try {
    const pending = openSession(p, room, abort.signal, 5000);
    abort.abort(new Error('BENCHMARK_CANCELLED'));
    await expect(pending).rejects.toThrow('BENCHMARK_CANCELLED');
    resolveStart();
    await Promise.resolve();
    await Promise.resolve();
    expect(room.disconnect).toHaveBeenCalled();
  } finally {
    await p.close().catch(() => undefined);
    await vad.close();
  }
}, 30000);

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
  const fetcher = vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); });
  vi.stubGlobal('fetch', fetcher);
  expect(contract.id).toBe('livekit-agents');
  const preflight = await contract.preflight(context);
  expect(preflight.status).toBe('blocked');
  expect(preflight.reasons).toEqual(['DRY_RUN_NO_NETWORK']);
  expect(preflight.provenance.nativeSilero).toBe('loaded-and-inferred-offline');
  const report = await contract.run(context, preflight);
  expect(report.turns).toEqual([]);
  expect(report.envelope.submittedTurns).toBe(0);
  expect(report.envelope.modelDispatches).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
}, 30000);

it('offline selection never creates a room or provider connection', async () => {
  const fetcher = vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); });
  vi.stubGlobal('fetch', fetcher);
  const preflight = await contract.preflight(context);
  const report = await contract.run(context, preflight);
  expect(preflight.status).toBe('blocked');
  expect(report.turns).toEqual([]);
  expect(report.envelope.modelDispatches).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
  expect(context.credentials).toBeNull();
}, 30000);

it('refuses forged ready admission before invoking any pipeline or network operation', async () => {
  const { offlinePreflight } = await import('../../shared/contracts.js');
  const preflight = offlinePreflight('livekit-agents');
  preflight.status = 'ready';
  await expect(contract.run(context, preflight)).rejects.toThrow('AGENTS_UNVERIFIED_PREFLIGHT');
});

it('blocks live admission without credentials before any network or room operation', async () => {
  const fetcher = vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); });
  vi.stubGlobal('fetch', fetcher);
  const live = { ...context, mode: 'live' as const };
  const preflight = await contract.preflight(live);
  expect(preflight.status).toBe('blocked');
  expect(preflight.reasons).toEqual(['CREDENTIALS_REQUIRED']);
  expect(fetcher).not.toHaveBeenCalled();
  const report = await contract.run(live, preflight);
  expect(report.turns).toEqual([]);
  expect(report.envelope.submittedTurns).toBe(0);
  expect(report.envelope.modelDispatches).toBe(0);
}, 30000);

it('routes local loopback speech proxy connections through BudgetGuard.sockets', async () => {
  const { BudgetGuard } = await import('../../shared/budget-guard.js');
  const { createSpeechProxy } = await import('../speech-proxy.js');
  const WebSocketMod = (await import('ws')).default;
  const guard = new BudgetGuard({
    modelId: 'openai/gpt-4o-mini',
    userId: 'synthetic-user',
    maxContextTokens: 45000,
    maxOutputTokens: 1024,
    modelMarginTokens: 1024,
    region: 'us',
    sttModel: 'flux-general-en',
    ttsModel: 'flux-haley-en',
    outputParameter: 'max_tokens',
    expiresAtMs: Date.now() + 900000,
  }, { prompt: 0.0000005, completion: 0.0000025, request: 0 });
  const release = guard.openCandidate('livekit-agents');
  const proxy = await createSpeechProxy(guard, 'us', guard.signal);
  try {
    expect(proxy.sttUrl.startsWith('ws://127.0.0.1:')).toBe(true);
    expect(proxy.ttsBaseUrl.startsWith('http://127.0.0.1:')).toBe(true);
    const badClient = new WebSocketMod(`${proxy.sttUrl}?model=wrong-model`);
    const closeCode = await new Promise<number>((resolve) => {
      badClient.once('close', resolve);
    });
    expect([1006, 1008]).toContain(closeCode);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.snapshot().denied).toBe('EGRESS_POLICY_DENIED');
  } finally {
    await proxy.close();
    release();
    guard.stop();
  }
});
