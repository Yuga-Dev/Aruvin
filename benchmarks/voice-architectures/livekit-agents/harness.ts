/**
 * ============================================================================
 * FILE: harness.ts
 * LOCATION: benchmarks/voice-architectures/livekit-agents/harness.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Framework-backed session construction, bounded lifecycle, shared-driver integration, concrete ArchitectureHarness export.
 *
 * ROLE IN PROJECT:
 *    Supplies P2's standalone framework candidate without changing Aurvin.
 *    Consumes only the isolated package and P1-owned run configuration.
 *
 * KEY COMPONENTS:
 *    - GuardedAgent — pre-provider speech accounting
 *    - openSession — real standalone AgentSession
 *    - bounded — cancellation/deadline boundary
 *    - concrete shared harness export — P1 integration
 * ============================================================================
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { llm, metrics, stt, voice, type VAD } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import { Room, type AudioFrame } from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import type { ReadableStream } from 'node:stream/web';
import { sessionOptions, speechOptions, startOptions, loadSilero } from './config.js';
import { createOpenRouterLlm, type GuardPorts, type RouterPolicy } from './openrouter-client.js';
import { createSpeechProxy, type SpeechProxy } from './speech-proxy.js';
import {
  emptyTurn, offlinePreflight,
  type ArchitectureHarness, type ArchitectureReport, type Clock,
  type PreflightResult, type RunContext,
} from '../shared/contracts.js';
import { newReport } from '../shared/compiler.js';
import { DecodedObserver, wait } from '../shared/timing.js';
import { createParticipant, type Participant } from '../shared/webrtc-participant.js';
import { withLivekitBoundaries } from './report.js';

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
  speechUrls?: { sttUrl: string; ttsUrl: string };
};

export class GuardedAgent extends voice.Agent {
  constructor(options: ConstructorParameters<typeof voice.Agent>[0], private readonly guard: SpeechGuard) {
    super(options);
  }

  override async sttNode(
    audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
    settings: voice.ModelSettings,
  ): Promise<ReadableStream<stt.SpeechEvent | string> | null> {
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
  const urls = input.speechUrls ?? speechOptions(input.region);
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

export async function preflightLivekit(context: RunContext): Promise<PreflightResult> {
  const result = offlinePreflight('livekit-agents',
    context.mode === 'dry-run' ? ['DRY_RUN_NO_NETWORK'] : []);
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
    if (context.mode === 'live') {
      const creds = context.credentials;
      if (!creds?.openrouter || !creds.deepgram || !creds.bootstrap.livekit || !context.guard) {
        result.status = 'blocked';
        result.reasons = ['CREDENTIALS_REQUIRED'];
      } else if (!creds.settings.voice.enabledModes.live) {
        result.status = 'blocked';
        result.reasons = ['SOURCE_LIVE_MODE_DISABLED'];
      } else if (creds.settings.deepgram.liveModel !== 'flux-general-en' ||
          !/^flux-[a-z0-9-]+-en$/.test(creds.settings.deepgram.ttsModel)) {
        result.status = 'blocked';
        result.reasons = ['SOURCE_SPEECH_FAMILY_UNSUPPORTED'];
      } else {
        result.provenance.speechEgressIntercepted = true;
        result.status = 'ready';
        result.reasons = [];
      }
    }
  } catch {
    // Do not serialize native exceptions, paths, credentials, or SDK payloads.
    result.status = context.signal.aborted ? 'failed' : 'blocked';
    result.reasons = [context.signal.aborted ? 'BENCHMARK_CANCELLED' : 'BLOCKED_SILERO_NATIVE_LOAD'];
  }
  return result;
}

class AgentsTurnState {
  readonly observer: DecodedObserver;
  readonly turn: ReturnType<typeof emptyTurn>;
  speechEnd: number;
  firstAudioAt: number | null = null;
  speaking = false;
  ended = false;
  endAt: number | null = null;
  fault: string | null = null;
  private begun = false;
  constructor(index: number, speechEnd: number, private readonly clock: Clock) {
    this.speechEnd = speechEnd;
    this.turn = emptyTurn('livekit-agents', index);
    this.observer = new DecodedObserver(clock);
  }
  inputStarted(clockMs: number, speechEndMs: number) {
    this.speechEnd = clockMs + speechEndMs;
    if (!this.begun) {
      this.begun = true;
      this.observer.begin(`lk-turn-${this.turn.turnIndex}`, this.speechEnd);
    }
  }
  onAgentState(newState: string) {
    const now = this.clock.now();
    if (newState === 'thinking' && this.turn.speechEndToThinkingMs === null && now >= this.speechEnd) {
      this.turn.speechEndToThinkingMs = now - this.speechEnd;
    }
    if (newState === 'speaking') this.speaking = true;
    if ((newState === 'listening' || newState === 'idle') && (this.speaking || this.firstAudioAt !== null)) {
      this.ended = true;
      this.endAt ??= now;
    }
  }
  onMetric(m: metrics.AgentMetrics) {
    if (m.type === 'llm_metrics') {
      if (this.turn.modelFirstOutputMs === null && Number.isFinite(m.ttftMs) && m.ttftMs >= 0) {
        this.turn.modelFirstOutputMs = m.ttftMs;
      }
      if (Number.isFinite(m.promptTokens) && m.promptTokens >= 0) {
        this.turn.usage.promptTokens = (this.turn.usage.promptTokens ?? 0) + m.promptTokens;
      }
      if (Number.isFinite(m.completionTokens) && m.completionTokens >= 0) {
        this.turn.usage.completionTokens = (this.turn.usage.completionTokens ?? 0) + m.completionTokens;
      }
    } else if (m.type === 'tts_metrics') {
      if (this.turn.ttsFirstAudioMs === null && Number.isFinite(m.ttfbMs) && m.ttfbMs >= 0) {
        this.turn.ttsFirstAudioMs = m.ttfbMs;
      }
      if (Number.isFinite(m.charactersCount) && m.charactersCount >= 0) {
        this.turn.usage.ttsInputBytes = (this.turn.usage.ttsInputBytes ?? 0) + m.charactersCount;
      }
    }
  }
  frame(data: Int16Array, rate: number, channels: number) {
    if (!this.begun) return;
    if (!this.speaking && !data.some((sample) => Math.abs(sample) > 64)) return;
    if (this.firstAudioAt === null && data.some((sample) => sample !== 0)) {
      this.firstAudioAt = this.clock.now();
    }
    this.observer.frame(data, rate, channels);
  }
  result() {
    Object.assign(this.turn, this.observer.snapshot());
    this.turn.durableCompletionStatus = 'not-applicable';
    this.turn.outcome = this.fault ? 'failed' : this.turn.earlyEndpoint ? 'early-endpoint' : 'completed';
    this.turn.failureCode = this.fault;
    return this.turn;
  }
}

async function until(context: RunContext, predicate: () => boolean, timeoutMs: number) {
  const started = context.clock.now();
  while (!predicate()) {
    context.signal.throwIfAborted();
    if (context.clock.now() - started >= timeoutMs) throw new Error('BENCHMARK_TIMEOUT');
    await wait(10, context.signal);
  }
}

function blockedReport(context: RunContext, preflight: PreflightResult): ArchitectureReport {
  const report = newReport('livekit-agents', context.runId, context.mode, preflight);
  report.startedAtIso = context.startedAtIso;
  report.provenance = { ...preflight.provenance };
  if (context.guard) report.envelope = context.guard.snapshot();
  report.limitations.push(
    'No live candidate connections or submitted turns; native/fixture checks are not service observations.',
    'Bounded live pilot and actual report publication belong to V1.',
  );
  return withLivekitBoundaries(report);
}

export const harness = {
  id: 'livekit-agents',
  preflight: preflightLivekit,
  async run(context, preflight) {
    if (preflight.candidate !== 'livekit-agents') {
      throw new Error('AGENTS_UNVERIFIED_PREFLIGHT');
    }
    if (preflight.status !== 'ready') {
      return blockedReport(context, preflight);
    }
    if (context.mode !== 'live' || !context.guard || !context.credentials || !context.credentials.bootstrap.livekit) {
      throw new Error('AGENTS_UNVERIFIED_PREFLIGHT');
    }
    const guard = context.guard;
    const credentials = context.credentials;
    const livekit = credentials.bootstrap.livekit;
    if (!livekit) throw new Error('AGENTS_UNVERIFIED_PREFLIGHT');
    const report = newReport('livekit-agents', context.runId, 'live', preflight);
    const roomName = `aurvin-bench-lk-${context.runId}`;
    const agentIdentity = `livekit-agent-${context.runId}`;
    const callerIdentity = `benchmark-caller-${context.runId}`;
    const release = guard.openCandidate('livekit-agents');
    const roomClient = new RoomServiceClient(
      livekit.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'),
      livekit.apiKey,
      livekit.apiSecret,
    );

    let vad: VAD | undefined;
    let proxy: SpeechProxy | undefined;
    let pipeline: ReturnType<typeof makePipeline> | undefined;
    let agentRoom: Room | undefined;
    let sessionHandle: Awaited<ReturnType<typeof openSession>> | undefined;
    let participant: Participant | undefined;
    let roomCreated = false;
    let state: AgentsTurnState | undefined;
    let pendingInterrupt: AgentsTurnState | undefined;
    let connectionFault: string | null = null;
    const ticker = setInterval(() => pendingInterrupt?.observer.tick(), 10);

    try {
      const [systemMd, knowledgeMd] = await Promise.all([
        readFile(resolve(context.repoRoot, 'backend/src/instructions/system.md'), 'utf8'),
        readFile(resolve(context.repoRoot, 'product_knowledge.md'), 'utf8'),
      ]);
      const instructions = `${systemMd}\n\n${knowledgeMd}`;
      vad = await loadSilero();
      proxy = await createSpeechProxy(guard, credentials.settings.deepgram.region, context.signal);

      const started = context.clock.now();
      await bounded(async () => roomClient.createRoom({
        name: roomName, emptyTimeout: 300, maxParticipants: 4,
      }), context.signal, 10000, 'LIVEKIT_ROOM_CREATE_TIMEOUT');
      roomCreated = true;

      const mint = async (identity: string) => {
        const token = new AccessToken(livekit.apiKey, livekit.apiSecret, { identity, ttl: '15m' });
        token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
        return token.toJwt();
      };
      const [agentToken, callerToken] = await Promise.all([mint(agentIdentity), mint(callerIdentity)]);

      agentRoom = new Room();
      await bounded(async () => agentRoom!.connect(livekit.url, agentToken), context.signal, 10000, 'AGENTS_ROOM_TIMEOUT');

      const speechGuard: SpeechGuard = {
        signal: guard.signal,
        reserve() { if (guard.signal.aborted) throw guard.signal.reason ?? new Error('BENCHMARK_STOPPED'); },
        assertActive() { if (guard.signal.aborted) throw guard.signal.reason ?? new Error('BENCHMARK_STOPPED'); },
        stt() {},
        tts() {},
      };
      pipeline = makePipeline({
        vad,
        instructions,
        history: [],
        callerIdentity,
        region: credentials.settings.deepgram.region,
        sttModel: credentials.settings.deepgram.liveModel,
        ttsModel: credentials.settings.deepgram.ttsModel,
        eotThreshold: credentials.settings.deepgram.eotThreshold,
        eotTimeoutMs: credentials.settings.deepgram.eotTimeoutMs,
        deepgramKey: credentials.deepgram,
        router: {
          modelId: credentials.settings.openRouter.modelId,
          userId: credentials.bootstrap.identity.userId,
          apiKey: credentials.openrouter,
          outputCap: guard.policy.maxOutputTokens,
          capParameter: guard.policy.outputParameter,
          contextCap: guard.policy.maxContextTokens,
          timeoutMs: 60000,
        },
        guard: speechGuard,
        fetcher: guard.fetch(fetch),
        speechUrls: { sttUrl: proxy.sttUrl, ttsUrl: proxy.ttsBaseUrl },
      });

      pipeline.session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
        if (ev.newState === 'speaking' && pendingInterrupt &&
            pendingInterrupt.observer.snapshot().staleTailObservedMs !== 1000) {
          pendingInterrupt.turn.interruptionAttribution = 'response-correlated';
        }
        state?.onAgentState(ev.newState);
      });
      pipeline.session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
        state?.onMetric(ev.metrics);
      });
      pipeline.session.on(voice.AgentSessionEventTypes.Error, (ev) => {
        if (state && !state.fault) {
          let cur: unknown = ev?.error;
          let candidate = '';
          for (let depth = 0; depth < 6 && cur && typeof cur === 'object'; depth++) {
            const msg = (cur as { message?: unknown }).message;
            if (typeof msg === 'string' && /^[A-Z0-9_]{1,100}$/.test(msg)) { candidate = msg; break; }
            cur = (cur as { cause?: unknown }).cause;
          }
          state.fault = candidate || 'AGENTS_PROVIDER_ERROR';
        }
      });
      pipeline.session.on(voice.AgentSessionEventTypes.Close, () => {
        connectionFault ??= 'AGENTS_EARLY_CLOSE';
      });

      participant = await createParticipant({
        url: livekit.url,
        roomName,
        token: callerToken,
        agentIdentity,
        clock: context.clock,
        signal: context.signal,
        onPcm: (data, rate, channels) => {
          const clean = data.some((sample) => Math.abs(sample) > 64) ? data : new Int16Array(data.length);
          state?.frame(clean, rate, channels);
          pendingInterrupt?.frame(clean, rate, channels);
        },
        onControl: () => {},
        onFault: (code) => { connectionFault = code; },
      });

      sessionHandle = await openSession(pipeline, agentRoom, context.signal, 20000);
      const setupMs = context.clock.now() - started;

      report.provenance = {
        ...preflight.provenance,
        modelId: credentials.settings.openRouter.modelId,
        sttModel: credentials.settings.deepgram.liveModel,
        ttsModel: credentials.settings.deepgram.ttsModel,
        region: credentials.settings.deepgram.region,
        configHash: credentials.configHash,
        maxContextTokens: guard.policy.maxContextTokens,
        maxOutputTokens: guard.policy.maxOutputTokens,
        outputParameter: guard.policy.outputParameter,
        maxRetries: 0,
        preemptiveGeneration: false,
        speechEgressIntercepted: true,
        roomName,
      };

      for (const input of context.corpus) {
        if (input.index === 5 && !pendingInterrupt) break;
        const inputStart = context.clock.now();
        state = new AgentsTurnState(input.index, inputStart + input.speechEndMs, context.clock);
        const turn = state.turn;
        turn.submitted = true;
        turn.setupMs = input.index === 0 ? setupMs : null;
        turn.sessionPhase = input.index === 0 ? 'cold-setup' : 'warm-session';
        guard.submitTurn('livekit-agents', input.index);
        report.turns.push(turn);

        const pacing = await participant.play(input.pcm, (at) => {
          state!.inputStarted(at, input.speechEndMs);
          if (input.index === 5 && pendingInterrupt) {
            pendingInterrupt.observer.interrupt();
            pendingInterrupt.result();
            if (!pendingInterrupt.turn.interruptionAnchorObserved) {
              throw new Error('INTERRUPT_ANCHOR_UNOBSERVED');
            }
          }
        });
        turn.inputPacingMaxLatenessMs = pacing.latenessMs;
        turn.maxInputQueuedMs = pacing.maxQueuedMs;

        if (input.index === 4) {
          await until(context, () => state!.firstAudioAt !== null || state!.fault !== null || connectionFault !== null, 30000);
          if (state!.fault || connectionFault) throw new Error(state!.fault ?? connectionFault!);
          await wait(Math.max(0, state!.firstAudioAt! + 600 - context.clock.now()), context.signal);
          if (state!.ended) {
            state!.result();
            turn.failureCode = 'INTERRUPT_ANCHOR_UNOBSERVED';
            break;
          }
          state!.result();
          turn.interruptionAttribution = 'boundary-window-only';
          pendingInterrupt = state;
          state = undefined;
          continue;
        }

        await until(context, () =>
          state!.fault !== null || connectionFault !== null ||
          (state!.ended && state!.endAt !== null && context.clock.now() - state!.endAt >= 2000), 45000);
        state!.result();
        if (connectionFault) throw new Error(connectionFault);
        if (state!.fault) throw new Error(state!.fault);
        if (pendingInterrupt) {
          pendingInterrupt.observer.tick();
          const attribution = pendingInterrupt.turn.interruptionAttribution;
          pendingInterrupt.result();
          if (attribution === 'unknown') {
            pendingInterrupt.turn.interruptionToCutoffMs = null;
            pendingInterrupt.turn.staleTailObservedMs = null;
            pendingInterrupt.turn.staleTailNonzeroFrames = null;
            pendingInterrupt.turn.staleTailBytes = null;
          }
          pendingInterrupt = undefined;
        }
      }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'AGENTS_RUN_FAILED';
      if (state) {
        state.result();
        state.turn.outcome = code === 'BENCHMARK_TIMEOUT' ? 'timeout' : 'failed';
        state.turn.failureCode = code;
      }
      report.limitations.push(code);
    } finally {
      clearInterval(ticker);
      sessionHandle?.dispose();
      const cleanup = report.cleanup;
      if (participant) {
        const ok = await participant.close();
        cleanup.resources.push({ kind: 'participant', id: callerIdentity, owned: true, outcome: ok ? 'closed' : 'unknown' });
        if (!ok) cleanup.complete = false;
      }
      const cleanupSignal = new AbortController().signal;
      if (pipeline) {
        let pOk = true;
        try { await bounded(() => pipeline!.close(), cleanupSignal, 10000, 'AGENTS_CLOSE_TIMEOUT'); }
        catch { pOk = false; cleanup.complete = false; }
        cleanup.resources.push({ kind: 'executor', id: 'livekit-agents-session', owned: true, outcome: pOk ? 'closed' : 'failed' });
      }
      if (agentRoom) {
        let aOk = true;
        try { await bounded(async () => agentRoom!.disconnect(), cleanupSignal, 5000, 'AGENTS_ROOM_CLOSE_TIMEOUT'); }
        catch { aOk = false; cleanup.complete = false; }
        cleanup.resources.push({ kind: 'participant', id: agentIdentity, owned: true, outcome: aOk ? 'closed' : 'unknown' });
      }
      if (proxy) {
        const sOk = await proxy.close();
        cleanup.resources.push({ kind: 'socket', id: 'loopback-speech-proxy', owned: true, outcome: sOk ? 'closed' : 'unknown' });
        if (!sOk) cleanup.complete = false;
      }
      if (vad) {
        try { await vad.close(); } catch { cleanup.complete = false; }
      }
      if (roomCreated) {
        let rOutcome: 'closed' | 'unknown' = 'unknown';
        try {
          if ((await roomClient.listRooms([roomName])).length) await roomClient.deleteRoom(roomName);
          if (!(await roomClient.listRooms([roomName])).length) rOutcome = 'closed';
        } catch { cleanup.complete = false; }
        cleanup.resources.push({ kind: 'room', id: roomName, owned: true, outcome: rOutcome });
        if (rOutcome !== 'closed') cleanup.complete = false;
      }
      release();
      report.envelope = guard.snapshot();
      cleanup.openSockets = guard.openSocketCount;
      if (cleanup.openSockets !== 0) cleanup.complete = false;
      if (!cleanup.complete) guard.stop();
    }
    return withLivekitBoundaries(report);
  },
} satisfies ArchitectureHarness;
