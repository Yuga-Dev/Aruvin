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
