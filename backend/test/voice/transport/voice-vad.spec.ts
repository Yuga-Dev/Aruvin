/**
 * ============================================================================
 * FILE: voice-vad.spec.ts
 * LOCATION: backend/test/voice/transport/voice-vad.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Deterministic unit checks for the backend embedded WebRTC VAD wrapper.
 *
 * ROLE IN PROJECT:
 *    Proves offline WASM loading without fetch, 4x20 ms windowing including
 *    non-zero byteOffset views, voiced vs silence/DC classification, reset,
 *    destroy, and MEDIA_GATE_UNAVAILABLE error mapping.
 *
 * KEY COMPONENTS:
 *    - pcmFrame(): Encodes 1280 Int16 samples into an 80 ms PCM16 LE frame.
 *    - voicedSample(): Dual-tone 140 Hz + 280 Hz voiced synthetic waveform.
 * ============================================================================
 */

import { afterEach, expect, it, vi } from 'vitest';
import { createVoiceVad } from '../../../src/voice/transport/voice-vad.js';
import { VoiceSessionError } from '../../../src/voice/session/voice-session.options.js';

function pcmFrame(sampleAt: (index: number) => number, offsetBytes = 0): Uint8Array {
  const backing = new Uint8Array(offsetBytes + 2560 + 16);
  const view = new DataView(backing.buffer, offsetBytes, 2560);
  for (let i = 0; i < 1280; i++) {
    view.setInt16(i * 2, sampleAt(i), true);
  }
  return backing.subarray(offsetBytes, offsetBytes + 2560);
}

const voicedSample = (offset = 0) => (i: number) => {
  const n = offset + i;
  return Math.round(
    (Math.sin((2 * Math.PI * 140 * n) / 16000) * 0.6 +
      Math.sin((2 * Math.PI * 280 * n) / 16000) * 0.4) * 3000,
  );
};

afterEach(() => {
  vi.restoreAllMocks();
});

it('loads the embedded WASM offline without fetch and scores voiced vs silence/DC frames', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('unexpected network fetch');
  });
  const vad = await createVoiceVad();
  try {
    expect(fetchSpy).not.toHaveBeenCalled();

    // Silence frames stay false.
    const silence = pcmFrame(() => 0);
    expect(vad.decisions(silence)).toEqual([false, false, false, false]);
    expect(vad.decisions(silence)).toEqual([false, false, false, false]);

    // Voiced dual-tone frames are detected across all 20 ms windows once VERY_AGGRESSIVE onset warms up,
    // even with non-zero byteOffset.
    expect(vad.decisions(pcmFrame(voicedSample(0), 64))).toEqual([false, false, true, true]);
    expect(vad.decisions(pcmFrame(voicedSample(1280), 128))).toEqual([true, true, true, true]);

    // Sustained DC offset stays silent after the initial step-change transient.
    const dc = pcmFrame(() => 1000);
    vad.reset();
    vad.decisions(dc); // step transient frame
    expect(vad.decisions(dc)).toEqual([false, false, false, false]);
    expect(vad.decisions(dc)).toEqual([false, false, false, false]);
  } finally {
    vad.destroy();
  }
});

it('maps invalid frame lengths and post-destroy calls to MEDIA_GATE_UNAVAILABLE', async () => {
  const vad = await createVoiceVad();
  expect(() => vad.decisions(new Uint8Array(2558))).toThrowError(VoiceSessionError);
  try {
    vad.decisions(new Uint8Array(10));
  } catch (error) {
    expect(error).toMatchObject({ code: 'MEDIA_GATE_UNAVAILABLE' });
  }

  vad.reset();
  expect(vad.decisions(pcmFrame(voicedSample(0)))).toEqual([false, false, true, true]);
  expect(vad.decisions(pcmFrame(voicedSample(1280)))).toEqual([true, true, true, true]);

  vad.destroy();
  vad.destroy(); // idempotent
  expect(() => vad.decisions(pcmFrame(() => 0))).toThrowError(VoiceSessionError);
  expect(() => vad.reset()).toThrowError(VoiceSessionError);
});
