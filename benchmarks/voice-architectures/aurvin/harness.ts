/**
 * ============================================================================
 * FILE: harness.ts
 * LOCATION: benchmarks/voice-architectures/aurvin/harness.ts
 * PURPOSE: Exercise real application admission/context/voice over native WebRTC.
 * ROLE IN PROJECT: Aurvin baseline only; no production patch or playback ACK.
 * KEY COMPONENTS: AurvinTurnState; preflight; sequential six-input driver.
 * ============================================================================
 */
import { randomUUID } from 'node:crypto';
import { emptyTurn, offlinePreflight, type ArchitectureHarness, type Clock,
  type PreflightResult, type RunContext } from '../shared/contracts.js';
import { backendModule } from '../shared/credentials.js';
import { newReport } from '../shared/compiler.js';
import { bounded, DecodedObserver, wait } from '../shared/timing.js';
import { createParticipant, type Participant } from '../shared/webrtc-participant.js';
import { startAurvin, verifyBuild, type AurvinSession } from './preflight.js';
type Control = Record<string, unknown> & { type: string };
export class AurvinTurnState {
  readonly observer: DecodedObserver;
  readonly turn: ReturnType<typeof emptyTurn>;
  response: { turnId: string; responseId: string } | null = null;
  ended = false; paused = false; fault: string | null = null;
  firstAudioAt: number | null = null; endAt: number | null = null;
  constructor(index: number, private speechEnd: number, private clock: Clock) {
    this.turn = emptyTurn('aurvin', index); this.observer = new DecodedObserver(clock);
  }
  inputStarted(clockMs: number, speechEndMs: number) { this.speechEnd = clockMs + speechEndMs; }
  event(event: Control) {
    if (event.type === 'audio.start' && !this.response) {
      this.response = { turnId: String(event.turnId), responseId: String(event.responseId) };
      this.observer.begin(this.response.responseId, this.speechEnd);
    }
    if (event.type === 'voice.state' && event.agent === 'thinking' &&
      this.turn.speechEndToThinkingMs === null && this.clock.now() >= this.speechEnd)
      this.turn.speechEndToThinkingMs = this.clock.now() - this.speechEnd;
    if (event.type === 'audio.end' && this.response?.turnId === event.turnId &&
      this.response?.responseId === event.responseId) { this.ended = true; this.endAt = this.clock.now(); }
    if (event.type === 'session.error') {
      if (event.code === 'VOICE_DELIVERY_UNKNOWN' && event.recoverable === true && event.terminal === false) {
        this.paused = true;
      } else this.fault = /^[A-Z0-9_]{1,100}$/.test(String(event.code)) ? String(event.code) : 'BASELINE_SESSION_ERROR';
    }
    if (event.type === 'session.ended') this.fault = 'BASELINE_SESSION_ENDED';
  }
  frame(data: Int16Array, rate: number, channels: number) {
    if (!this.response) return; // Decoded bytes preceding audio.start cannot be attributed.
    if (this.firstAudioAt === null && data.some(value => value !== 0)) this.firstAudioAt = this.clock.now();
    this.observer.frame(data, rate, channels);
  }
  controlsForRecovery(): Control[] { return this.paused ? [{ type: 'input.unmute' }] : []; }
  result() {
    Object.assign(this.turn, this.observer.snapshot());
    this.turn.durableCompletionStatus = 'unknown';
    this.turn.outcome = this.fault ? 'failed' : this.turn.earlyEndpoint ? 'early-endpoint' : 'unverified-playback';
    this.turn.failureCode = this.fault ?? 'BENCHMARK_UNPROVEN_PLAYBACK';
    return this.turn;
  }
}
async function until(context: RunContext, predicate: () => boolean, timeoutMs: number) {
  const started = context.clock.now();
  while (!predicate()) {
    context.signal.throwIfAborted();
    if (context.clock.now() - started >= timeoutMs) throw Error('BENCHMARK_TIMEOUT');
    await wait(10, context.signal);
  }
}
export const harness: ArchitectureHarness = {
  id: 'aurvin',
  async preflight(context) {
    if (context.mode !== 'live') return offlinePreflight('aurvin');
    const p = offlinePreflight('aurvin', []);
    try {
      const source = context.credentials;
      if (!source?.openrouter || !source.deepgram || !source.bootstrap.livekit) throw Error('CREDENTIALS_REQUIRED');
      if (!source.settings.voice.enabledModes.live) throw Error('SOURCE_LIVE_MODE_DISABLED');
      if (source.settings.deepgram.liveModel !== 'flux-general-en' ||
        !/^flux-(cole|haley|alexis|priya)-en$/.test(source.settings.deepgram.ttsModel))
        throw Error('SOURCE_SPEECH_FAMILY_UNSUPPORTED');
      const build = await verifyBuild(context.repoRoot);
      p.status = 'ready'; p.provenance = build;
      p.capabilities = { userAttribution: true, zeroDataRetention: true, maxOutputTokensEnforced: true,
        zeroRetriesEnforced: true, speculationDisabled: true, fluxSttSupported: true, fluxTtsSupported: true };
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'BASELINE_PREFLIGHT_FAILED';
      p.reasons = [code];
    }
    return p;
  },
  async run(context, preflight) {
    if (preflight.status !== 'ready' || context.mode !== 'live' || !context.guard || !context.credentials)
      throw Error('BASELINE_LIVE_ADMISSION_REQUIRED');
    const guard = context.guard, report = newReport('aurvin', context.runId, 'live', preflight);
    const expectedDatabase = `aurvin_voice_arch_${context.runId.replaceAll('-', '')}`;
    report.provenance.isolatedDatabase = expectedDatabase;
    let release: (() => void) | undefined;
    let runtime: Awaited<ReturnType<typeof startAurvin>> | undefined;
    let participant: Participant | undefined; let session: AurvinSession | undefined;
    let state: AurvinTurnState | undefined; let pendingInterrupt: AurvinTurnState | undefined;
    let sequence = 0, serverSequence = -1, ready = false, resumeReady = false, recoveries = 0;
    let connectionFault: string | null = null, recoveryFault: string | null = null, recoveryMs: number | null = null;
    let pausedForRecovery = false; let recoveryControls: Control[] = [];
    let boundConversationId: string | null = null;
    const closedRooms = new Set<string>();
    const ticker = setInterval(() => pendingInterrupt?.observer.tick(), 10);
    const send = async (payload: Control) => {
      if (!participant || !session || payload.type === 'playback.progress') throw Error('UNPROVEN_CONTROL_DENIED');
      await participant.sendControl({ protocolVersion: 1, sessionId: session.sessionId,
        connectionEpoch: session.connectionEpoch, eventId: randomUUID(), sequence: sequence++, ...payload });
    };
    type WireApi = {
      INPUT_AUDIO: Record<string, unknown>; livekitAgentIdentity(sessionId: string): string;
      VoiceControlReassembler: new (direction: 'server', mode: 'live', binding: {
        sessionId: string; connectionEpoch: number }) => { push(bytes: Uint8Array):
          { status: string; event?: Control & { sessionId: string; connectionEpoch: number; sequence: number } } };
    };
    let wire: WireApi | undefined;
    const closeActiveSession = async () => {
      const cleanup = report.cleanup;
      const currentParticipant = participant;
      const currentSession = session;
      participant = undefined;
      session = undefined;
      if (currentParticipant) {
        const pOk = await currentParticipant.close();
        cleanup.resources.push({ kind: 'participant', id: currentSession?.livekit.participantIdentity ?? 'aurvin-caller',
          owned: true, outcome: pOk ? 'closed' : 'unknown' });
        if (!pOk) cleanup.complete = false;
      }
      if (runtime && currentSession) {
        let sOutcome: 'closed' | 'unknown' | 'failed' = 'closed';
        try { await bounded(runtime.service.voiceSessions.endOwned(currentSession.sessionId, runtime.principal), 10000); }
        catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (msg === 'VOICE_DELIVERY_UNKNOWN') sOutcome = 'unknown';
          else { sOutcome = 'failed'; cleanup.complete = false; }
        }
        cleanup.resources.push({ kind: 'participant', id: `voice-session:${currentSession.sessionId}`, owned: true, outcome: sOutcome });
        const room = currentSession.livekit.roomName;
        if (!closedRooms.has(room)) {
          closedRooms.add(room);
          let outcome: 'closed' | 'unknown' = 'unknown';
          try {
            if ((await bounded(runtime.roomClient.listRooms([room]), 3000)).length)
              await bounded(runtime.roomClient.deleteRoom(room), 3000);
            if (!(await bounded(runtime.roomClient.listRooms([room]), 3000)).length) outcome = 'closed';
          } catch { cleanup.complete = false; }
          cleanup.resources.push({ kind: 'room', id: room, owned: true, outcome });
          if (outcome !== 'closed') cleanup.complete = false;
        }
      }
    };
    const openSession = async (conversationId: string | null, idempotencyKey: string) => {
      if (!runtime || !wire) throw Error('BASELINE_NOT_READY');
      sequence = 0; serverSequence = -1; ready = false; resumeReady = false;
      connectionFault = null; recoveryFault = null;
      session = (await runtime.service.voiceSessions.create({ protocolVersion: 1, mode: 'live',
        conversationId, locale: 'en-US', idempotencyKey },
        runtime.bootstrap.frontendOrigin, runtime.principal)).response;
      const activeSession = session;
      const reassembler = new wire.VoiceControlReassembler('server', 'live', activeSession);
      const { url, roomName, participantToken } = activeSession.livekit;
      participant = await createParticipant({ url, roomName, token: participantToken,
        agentIdentity: wire.livekitAgentIdentity(activeSession.sessionId), clock: context.clock, signal: context.signal,
        onPcm: (data, rate, channels) => {
          const clean = data.some(value => Math.abs(value) > 64) ? data : new Int16Array(data.length);
          state?.frame(clean, rate, channels); pendingInterrupt?.frame(clean, rate, channels);
        },
        onFault: code => { connectionFault = code; },
        onControl: bytes => {
          try {
            const parsed = reassembler.push(bytes); if (parsed.status !== 'complete' || !parsed.event) return;
            const event = parsed.event;
            if (event.sessionId !== activeSession.sessionId || event.connectionEpoch !== activeSession.connectionEpoch)
              throw Error('CONTROL_BINDING_INVALID');
            if (event.sequence <= serverSequence) return;
            serverSequence = event.sequence;
            if (event.type === 'session.ready') ready = true;
            if (event.type === 'conversation.bound' && typeof event.conversationId === 'string') {
              boundConversationId = event.conversationId;
            }
            if (event.type === 'voice.state' && event.input === 'listening' &&
              event.agent === 'idle' && event.connection === 'connected') resumeReady = true;
            if (event.type === 'session.error' && !state && pausedForRecovery && event.recoverable !== true) {
              recoveryFault = /^[A-Z0-9_]{1,100}$/.test(String(event.code)) ? String(event.code) : 'BASELINE_SESSION_ERROR';
            }
            if (event.type === 'audio.start' && pendingInterrupt &&
              pendingInterrupt.observer.snapshot().staleTailObservedMs !== 1000) {
              pendingInterrupt.turn.interruptionAttribution = 'unknown';
            }
            state?.event(event);
          } catch { connectionFault = 'CONTROL_INVALID'; }
        }
      });
      await send({ type: 'session.start', mode: 'live', audioSettings: wire.INPUT_AUDIO });
      await until(context, () => ready || connectionFault !== null, 10000);
      if (connectionFault) throw Error(connectionFault);
    };
    try {
      runtime = await startAurvin(context);
      release = guard.openCandidate('aurvin');
      report.provenance = { ...preflight.provenance, modelId: context.credentials.settings.openRouter.modelId,
        sttModel: context.credentials.settings.deepgram.liveModel, ttsModel: context.credentials.settings.deepgram.ttsModel,
        region: context.credentials.settings.deepgram.region, configHash: context.credentials.configHash,
        maxContextTokens: 45000, maxOutputTokens: 1024, maxRetries: 0, preemptiveGeneration: false,
        sourceRevision: context.credentials.sourceRevision, benchmarkOverrides: context.credentials.overrides.join('; '),
        routingOverride: 'provider.allow_fallbacks=false', heardHistory: 'application unknown-delivery reconciliation',
        isolatedDatabase: runtime.bootstrap.persistence.mongoDbName };
      wire = await backendModule<WireApi>(context.repoRoot, 'contracts/voice-wire.js');
      const started = context.clock.now();
      await openSession(null, context.runId);
      const setupMs = context.clock.now() - started;
      for (const input of context.corpus) {
        if (pausedForRecovery) {
          resumeReady = false;
          recoveryFault = null;
          const recoveringAt = context.clock.now();
          guard.allowSpeechRecovery('VOICE_DELIVERY_UNKNOWN');
          for (const control of recoveryControls) await send(control);
          recoveries++;
          await until(context, () => resumeReady || connectionFault !== null || recoveryFault !== null, 25000);
          if (connectionFault) throw Error(connectionFault);
          if (recoveryFault === 'VOICE_DELIVERY_UNKNOWN' && boundConversationId) {
            await closeActiveSession();
            await openSession(boundConversationId, randomUUID());
          } else if (recoveryFault) {
            throw Error(recoveryFault);
          }
          recoveryMs = context.clock.now() - recoveringAt;
          pausedForRecovery = false;
          recoveryControls = [];
        }
        if (input.index === 5 && !pendingInterrupt) break;
        const inputStart = context.clock.now();
        state = new AurvinTurnState(input.index, inputStart + input.speechEndMs, context.clock);
        const turn = state.turn;
        turn.submitted = true; turn.setupMs = input.index === 0 ? setupMs : null;
        if (recoveryMs !== null) { turn.connectStageMs.recoveryMs = recoveryMs; recoveryMs = null; }
        turn.sessionPhase = input.index === 0 ? 'cold-setup' : recoveries ? 'recovered-session' : 'warm-session';
        guard.submitTurn('aurvin', input.index);
        report.turns.push(turn);
        if (!participant) throw Error('PARTICIPANT_CLOSED');
        const pacing = await participant.play(input.pcm, at => {
          state!.inputStarted(at, input.speechEndMs);
          if (input.index === 5 && pendingInterrupt) {
            pendingInterrupt.observer.interrupt();
            pendingInterrupt.result();
            if (!pendingInterrupt.turn.interruptionAnchorObserved) throw Error('INTERRUPT_ANCHOR_UNOBSERVED');
          }
        });
        turn.inputPacingMaxLatenessMs = pacing.latenessMs; turn.maxInputQueuedMs = pacing.maxQueuedMs;
        if (input.index === 4) {
          await until(context, () => state!.firstAudioAt !== null || state!.fault !== null || state!.paused, 30000);
          if (state!.fault || state!.paused) throw Error(state!.fault ?? 'INTERRUPT_ANCHOR_UNOBSERVED');
          await wait(Math.max(0, state!.firstAudioAt! + 600 - context.clock.now()), context.signal);
          if (state!.ended) { state!.result(); turn.failureCode = 'INTERRUPT_ANCHOR_UNOBSERVED'; break; }
          state!.result();
          turn.interruptionAttribution = 'boundary-window-only';
          pendingInterrupt = state; state = undefined;
          continue; // Next input starts while target is speaking; no fabricated interrupt control.
        }
        await until(context, () => state!.paused || state!.fault !== null ||
          state!.ended && state!.endAt !== null && context.clock.now() - state!.endAt! >= 3000, 60000);
        state!.result();
        pausedForRecovery = state!.paused;
        recoveryControls = state!.controlsForRecovery();
        const fault = state!.fault;
        state = undefined;
        if (connectionFault) throw Error(connectionFault);
        if (fault) throw Error(fault);
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
      report.provenance.recoveries = recoveries;
      report.limitations.push('VOICE_DELIVERY_UNKNOWN pauses are recovered explicitly; recovered turns are not warm-session equivalence.',
        'No proven playback.progress is sent. Model/TTS internal timings remain null when not genuinely observable.');
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'BASELINE_RUN_FAILED';
      if (state) { state.result(); state.turn.outcome = code === 'BENCHMARK_TIMEOUT' ? 'timeout' : 'failed';
        state.turn.failureCode = code; }
      report.limitations.push(code);
    } finally {
      clearInterval(ticker);
      const cleanup = report.cleanup;
      await closeActiveSession();
      if (runtime) {
        let eOutcome: 'closed' | 'failed' = 'closed';
        try { await bounded(runtime.service.operations.shutdown(), 10000); }
        catch { eOutcome = 'failed'; cleanup.complete = false; }
        cleanup.resources.push({ kind: 'executor', id: 'aurvin-app-service', owned: true, outcome: eOutcome });
        for (const room of runtime.rooms) {
          if (closedRooms.has(room)) continue;
          closedRooms.add(room);
          let outcome: 'closed' | 'unknown' = 'unknown';
          try {
            if ((await bounded(runtime.roomClient.listRooms([room]), 3000)).length)
              await bounded(runtime.roomClient.deleteRoom(room), 3000);
            if (!(await bounded(runtime.roomClient.listRooms([room]), 3000)).length) outcome = 'closed';
          } catch { cleanup.complete = false; }
          cleanup.resources.push({ kind: 'room', id: room, owned: true, outcome });
          if (outcome !== 'closed') cleanup.complete = false;
        }
        cleanup.resources.push({ kind: 'database', id: runtime.bootstrap.persistence.mongoDbName,
          owned: true, outcome: 'retained' });
      }
      if (!runtime) {
        cleanup.resources.push({ kind: 'database', id: expectedDatabase, owned: false, outcome: 'unknown' });
        cleanup.complete = false;
      }
      release?.(); report.envelope = guard.snapshot();
      cleanup.openSockets = guard.openSocketCount;
      if (cleanup.openSockets !== 0) cleanup.complete = false;
      if (!cleanup.complete) guard.stop(); // No next live candidate after uncertain cleanup.
    }
    return report;
  }
};
