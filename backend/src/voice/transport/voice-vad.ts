/**
 * ============================================================================
 * FILE: voice-vad.ts
 * LOCATION: backend/src/voice/transport/voice-vad.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Offline embedded WebRTC VAD loader and 20 ms decision wrapper for LiveKit.
 *
 * ROLE IN PROJECT:
 *    Scores 80 ms (2560-byte) 16 kHz PCM16 LE microphone frames as four
 *    independent 320-sample windows without fetch or eval, mapping failures to
 *    MEDIA_GATE_UNAVAILABLE.
 *
 * KEY COMPONENTS:
 *    - VoiceVad: Decision, reset, and teardown interface for LiveKitInput.
 *    - createVoiceVad: Instantiates VERY_AGGRESSIVE 16 kHz embedded WebRTC VAD.
 * ============================================================================
 */

import createVad, { VADMode } from '@ozymandiasthegreat/vad/lib/embedded.js';
import { LIVE_WEBRTC_AUDIO as A } from '../../contracts/voice-wire.js';
import { VoiceSessionError } from '../session/voice-session.options.js';

export type VoiceVad = {
  decisions(pcm: Uint8Array): boolean[];
  reset(): void;
  destroy(): void;
};

const WINDOW_SAMPLES = A.sttFrameSamples / 4;

export async function createVoiceVad(): Promise<VoiceVad> {
  try {
    const VAD = await createVad();
    let instance = new VAD(VADMode.VERY_AGGRESSIVE, A.sttSampleRateHz);
    let destroyed = false;
    return {
      decisions(pcm: Uint8Array): boolean[] {
        if (destroyed || pcm.byteLength !== A.sttFrameBytes) {
          throw new VoiceSessionError('MEDIA_GATE_UNAVAILABLE');
        }
        try {
          const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
          return Array.from({ length: 4 }, (_, window) => {
            // The pinned package reads frame.buffer, ignoring byteOffset: each 20 ms window owns its buffer.
            const frame = Int16Array.from(
              { length: WINDOW_SAMPLES },
              (_, i) => view.getInt16((window * WINDOW_SAMPLES + i) * 2, true),
            );
            const result = instance.processFrame(frame);
            if (result !== 0 && result !== 1) {
              throw new VoiceSessionError('MEDIA_GATE_UNAVAILABLE');
            }
            return result === 1;
          });
        } catch (error) {
          if (error instanceof VoiceSessionError) throw error;
          throw new VoiceSessionError('MEDIA_GATE_UNAVAILABLE');
        }
      },
      reset(): void {
        if (destroyed) throw new VoiceSessionError('MEDIA_GATE_UNAVAILABLE');
        try {
          const fresh = new VAD(VADMode.VERY_AGGRESSIVE, A.sttSampleRateHz);
          instance.destroy();
          instance = fresh;
        } catch {
          throw new VoiceSessionError('MEDIA_GATE_UNAVAILABLE');
        }
      },
      destroy(): void {
        if (!destroyed) {
          destroyed = true;
          instance.destroy();
        }
      },
    };
  } catch (error) {
    if (error instanceof VoiceSessionError) throw error;
    throw new VoiceSessionError('MEDIA_GATE_UNAVAILABLE');
  }
}
