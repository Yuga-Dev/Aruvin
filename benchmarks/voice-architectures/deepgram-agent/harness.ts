/**
 * ============================================================================
 * FILE: harness.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/harness.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Fail closed on unsupported direct managed-BYO inference controls unless explicitly waived.
 *
 * ROLE IN PROJECT:
 *    Public P3 admission, blocked-result boundary, and explicitly waived live Voice Agent v1 runner.
 *    Never loads credentials or opens a provider connection without explicit live + waiver auth.
 *
 * KEY COMPONENTS:
 *    - preflightDeepgramAgent: Structural policy check (blocked by default, waived only with explicit flag).
 *    - makeBlockedRun: Honest zero-submission evidence.
 *    - harness: Shared ArchitectureHarness implementation.
 * ============================================================================
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  emptyTurn, type ArchitectureHarness, type ArchitectureReport,
  type PreflightResult, type RunContext, type TurnObservation,
} from '../shared/contracts.js';
import { newReport } from '../shared/compiler.js';
import { wait } from '../shared/timing.js';
import { openVoiceAgentV1 } from './client.js';
import { ReceiptObserver } from './measurements.js';
import { buildSettings, pacePcm, type AgentEvent } from './protocol.js';

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

class DeepgramTurnState {
  readonly observer: ReceiptObserver;
  readonly turn: TurnObservation;
  firstAudioAt: number | null = null;
  doneAt: number | null = null;
  audioDone = false;
  fault: string | null = null;
  private readonly now: () => number;

  constructor(index: number, speechEndAt: number, now: () => number) {
    this.now = now;
    this.turn = emptyTurn('deepgram-agent', index);
    this.observer = new ReceiptObserver(speechEndAt);
  }

  onEvent(event: AgentEvent, at: number): void {
    if (event.type === 'AgentThinking') this.observer.thinking(at);
    if (event.type === 'AgentStartedSpeaking') this.observer.newResponse(at);
    if (event.type === 'AgentAudioDone') {
      this.observer.done();
      this.audioDone = true;
      this.doneAt ??= at;
    }
  }

  onPcm(frame: Buffer, at: number): void {
    if (this.firstAudioAt === null) {
      for (let i = 0; i + 1 < frame.length; i += 2) {
        if (frame.readInt16LE(i) !== 0) { this.firstAudioAt = at; break; }
      }
    }
    this.observer.pcm(frame, at);
  }

  snapshot(): TurnObservation {
    Object.assign(this.turn, this.observer.snapshot(this.now()));
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

async function withSilenceTail(
  context: RunContext,
  guard: NonNullable<RunContext['guard']>,
  session: Awaited<ReturnType<typeof openVoiceAgentV1>>,
  shouldStream: () => boolean,
  body: () => Promise<void>,
) {
  const silence = Buffer.alloc(2560);
  let active = true;
  const pumper = (async () => {
    while (active && shouldStream() && !context.signal.aborted) {
      await wait(80, context.signal);
      if (!active || !shouldStream() || context.signal.aborted) break;
      guard.speechSend('stt', silence);
      session.audio(silence);
    }
  })().catch(() => undefined);
  try {
    await body();
  } finally {
    active = false;
    await pumper;
  }
}

export const harness = {
  id: 'deepgram-agent',
  async preflight(context: RunContext) {
    if (context.mode !== 'live' || context.waiveDeepgramByo !== true) {
      return preflightDeepgramAgent(context.startedAtIso);
    }
    const base = preflightDeepgramAgent(context.startedAtIso);
    const creds = context.credentials;
    if (!creds?.deepgram || !creds.openrouter || !context.guard) {
      return { ...base, status: 'blocked', reasons: ['CREDENTIALS_REQUIRED'] };
    }
    if (!creds.settings.voice.enabledModes.live) {
      return { ...base, status: 'blocked', reasons: ['SOURCE_LIVE_MODE_DISABLED'] };
    }
    return {
      ...base,
      status: 'ready',
      reasons: ['BYO_CONTROLS_WAIVED_BY_USER_FOR_PILOT'],
      provenance: {
        ...base.provenance,
        byoControlsWaived: true,
        waiverReference: 'user-request-2026-11-16-byo-waiver',
        entitlement: 'live-attempt-with-user-waiver',
        openRouterKeyTransfer: 'sent-in-voice-agent-think-headers',
        modelId: creds.settings.openRouter.modelId,
        region: creds.settings.deepgram.region,
      },
    };
  },
  async run(context: RunContext, suppliedPreflight: PreflightResult): Promise<ArchitectureReport> {
    if (context.mode !== 'live' || context.waiveDeepgramByo !== true || suppliedPreflight.status !== 'ready' ||
        !context.credentials || !context.guard) {
      return makeBlockedRun(context.mode, context.startedAtIso, context.runId);
    }
    const guard = context.guard;
    const creds = context.credentials;
    const report = newReport('deepgram-agent', context.runId, 'live', suppliedPreflight);
    report.startedAtIso = context.startedAtIso;
    report.provenance = { ...suppliedPreflight.provenance };

    const release = guard.openCandidate('deepgram-agent');
    let session: Awaited<ReturnType<typeof openVoiceAgentV1>> | undefined;
    let state: DeepgramTurnState | undefined;
    let pendingInterrupt: DeepgramTurnState | undefined;
    let socketFault: string | null = null;
    let providerErrorCode: string | null = null;
    let requestId: string | null = null;
    const ticker = setInterval(() => {
      const now = context.clock.now();
      pendingInterrupt?.observer.poll(now);
    }, 10);

    try {
      const [systemMd, knowledgeMd] = await Promise.all([
        readFile(resolve(context.repoRoot, 'backend/src/instructions/system.md'), 'utf8'),
        readFile(resolve(context.repoRoot, 'product_knowledge.md'), 'utf8'),
      ]);
      const prompt = `${systemMd}\n\n${knowledgeMd}`;
      const settings = buildSettings({
        modelId: creds.settings.openRouter.modelId,
        ttsModel: creds.settings.deepgram.ttsModel,
        openRouterApiKey: creds.openrouter,
        prompt,
        contextCharacters: 45000,
        eotThreshold: creds.settings.deepgram.eotThreshold,
        eotTimeoutMs: creds.settings.deepgram.eotTimeoutMs,
      });

      const setupStarted = context.clock.now();
      session = await openVoiceAgentV1({
        region: creds.settings.deepgram.region,
        deepgramApiKey: creds.deepgram,
        settings,
        waiveByo: true,
        signal: context.signal,
        now: () => context.clock.now(),
        hooks: {
          onEvent: (event, at) => {
            if (event.type === 'Welcome') requestId = event.requestId;
            if (event.type === 'Error') providerErrorCode = event.code;
            if (event.type === 'Warning') report.provenance.lastWarningCode = event.code;
            if (event.type === 'AgentStartedSpeaking' && pendingInterrupt &&
                pendingInterrupt.observer.snapshot(at).staleTailObservedMs !== 1000) {
              pendingInterrupt.observer.newResponse(at);
              pendingInterrupt.turn.interruptionAttribution = 'unknown';
            }
            state?.onEvent(event, at);
          },
          onPcm: (frame, at) => {
            state?.onPcm(frame, at);
            pendingInterrupt?.onPcm(frame, at);
          },
          onFailure: (code) => { socketFault ??= code; },
        },
      });
      await session.ready;
      const setupMs = context.clock.now() - setupStarted;
      report.provenance.welcomeRequestId = requestId;

      for (const input of context.corpus) {
        if (input.index === 5 && !pendingInterrupt) break;
        const turnStart = context.clock.now();
        state = new DeepgramTurnState(input.index, turnStart + input.speechEndMs, () => context.clock.now());
        const turn = state.turn;
        turn.submitted = true;
        turn.setupMs = input.index === 0 ? setupMs : null;
        turn.sessionPhase = input.index === 0 ? 'cold-setup' : 'warm-session';
        guard.submitTurn('deepgram-agent', input.index);
        report.turns.push(turn);

        const pcm = Buffer.from(input.pcm.buffer, input.pcm.byteOffset, input.pcm.byteLength);
        let interrupted = false;
        const pacing = await pacePcm(pcm, input.speechEndMs, {
          now: () => context.clock.now(),
          wait: (ms) => wait(ms, context.signal),
          signal: context.signal,
          send: (frame) => {
            if (input.index === 5 && pendingInterrupt && !interrupted) {
              interrupted = true;
              const at = context.clock.now();
              pendingInterrupt.observer.interrupt(at);
              pendingInterrupt.turn.interruptionAttribution = 'boundary-window-only';
              pendingInterrupt.snapshot();
            }
            guard.speechSend('stt', frame);
            session!.audio(frame);
          },
        });
        turn.inputPacingMaxLatenessMs = pacing.maxLatenessMs;

        if (input.index === 4) {
          await withSilenceTail(context, guard, session, () => state!.firstAudioAt === null && socketFault === null, () =>
            until(context, () => state!.firstAudioAt !== null || socketFault !== null, 30000));
          if (socketFault) throw new Error(socketFault);
          await wait(Math.max(0, state!.firstAudioAt! + 600 - context.clock.now()), context.signal);
          if (state!.audioDone) {
            state!.snapshot();
            turn.failureCode = 'INTERRUPT_ANCHOR_UNOBSERVED';
            break;
          }
          state!.snapshot();
          pendingInterrupt = state;
          state = undefined;
          continue;
        }

        await withSilenceTail(context, guard, session, () => state!.firstAudioAt === null && !state!.audioDone && socketFault === null, () =>
          until(context, () =>
            socketFault !== null ||
            (state!.audioDone && state!.doneAt !== null && context.clock.now() - state!.doneAt >= 1500), 45000));
        if (socketFault) throw new Error(socketFault);
        state!.snapshot();
        if (pendingInterrupt) {
          pendingInterrupt.observer.poll(context.clock.now());
          const attribution = pendingInterrupt.turn.interruptionAttribution;
          pendingInterrupt.snapshot();
          if (attribution === 'unknown') {
            pendingInterrupt.turn.interruptionToCutoffMs = null;
            pendingInterrupt.turn.staleTailObservedMs = null;
            pendingInterrupt.turn.staleTailNonzeroFrames = null;
            pendingInterrupt.turn.staleTailBytes = null;
          }
          pendingInterrupt = undefined;
        }
      }

      report.limitations.push(
        'BYO OpenRouter controls (user attribution, ZDR/no-fallback routing, output token cap, local retry/token accounting) were waived by explicit user decision for this bounded US$2 pilot.',
        'AgentThinking content is discarded; no private reasoning is archived.',
        'AgentAudioDone is not durable completion or heard-prefix proof.',
        'Managed model/TTS first-output timing and token/generation accounting remain null.',
      );
      return report;
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message : (socketFault ?? 'DEEPGRAM_AGENT_RUN_FAILED');
      if (providerErrorCode) report.provenance.providerErrorCode = providerErrorCode;
      if (requestId) report.provenance.welcomeRequestId = requestId;
      if (state) {
        state.fault = code;
        state.snapshot();
        state.turn.outcome = code === 'BENCHMARK_TIMEOUT' ? 'timeout' : 'failed';
        state.turn.failureCode = code;
      }
      report.limitations.push(code);
      return report;
    } finally {
      clearInterval(ticker);
      let wsClosed = true;
      if (session) {
        try { await session.close(); } catch { wsClosed = false; }
      }
      report.cleanup.resources.push({
        kind: 'socket',
        id: `deepgram-voice-agent-${creds.settings.deepgram.region}`,
        owned: true,
        outcome: wsClosed ? 'closed' : 'failed',
      });
      if (!wsClosed) report.cleanup.complete = false;
      release();
      report.envelope = guard.snapshot();
      report.cleanup.openSockets = guard.openSocketCount;
      if (report.cleanup.openSockets !== 0) report.cleanup.complete = false;
      if (!report.cleanup.complete) guard.stop();
    }
  },
} satisfies ArchitectureHarness;
