/**
 * ============================================================================
 * FILE: livekit-input.spec.ts
 * LOCATION: backend/test/voice/transport/livekit-input.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Deterministic checks for LiveKit microphone framing and quiet gating.
 *
 * ROLE IN PROJECT:
 *    Proves exact PCM byte order, fixed 2560-byte framing, five-second quiet
 *    suspension, bounded pre-roll and overflow rejection without native RTC.
 *
 * KEY COMPONENTS:
 *    - frame(): Structural decoded-frame stdlib shape.
 *    - inputFixture(): Isolated LiveKitInput with spy callbacks.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { LiveKitInput } from '../../../src/voice/transport/livekit-input.js';
import { createVoiceVad, type VoiceVad } from '../../../src/voice/transport/voice-vad.js';
import { VoiceSessionError } from '../../../src/voice/session/voice-session.options.js';
import { settle } from './fixtures.js';

const frame = (n: number, value = 1000) => ({
  data: new Int16Array(n).fill(value), sampleRate: 16000,
  channels: 1, samplesPerChannel: n,
});

const voicedFrame = (offset = 0) => ({
  data: Int16Array.from({ length: 1280 }, (_, i) => {
    const n = offset + i;
    return Math.round(
      (Math.sin((2 * Math.PI * 140 * n) / 16000) * 0.6 +
        Math.sin((2 * Math.PI * 280 * n) / 16000) * 0.4) * 3000,
    );
  }),
  sampleRate: 16000,
  channels: 1,
  samplesPerChannel: 1280,
});

async function inputFixture(inputQueueMs = 1000, vadOverride?: VoiceVad) {
  const write = vi.fn(async (_pcm: Uint8Array): Promise<void> => undefined);
  const suspend = vi.fn(), resume = vi.fn(), fail = vi.fn(), bargeIn = vi.fn();
  const vad = vadOverride ?? await createVoiceVad();
  const input = new LiveKitInput(inputQueueMs, write, suspend, resume, fail, vad, bargeIn);
  return { input, write, suspend, resume, fail, bargeIn, vad };
}

it('assembles irregular native frames in exact little-endian sample order', async () => {
  const f = await inputFixture();
  f.input.push(frame(160, 0x1234));
  f.input.push(frame(480, -32768));
  f.input.push(frame(640, 32767));
  f.input.push(frame(1279));
  await settle();
  expect(f.write).toHaveBeenCalledTimes(1);
  const bytes = f.write.mock.calls[0][0];
  expect(bytes).toHaveLength(2560);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([view.getInt16(0, true), view.getInt16(320, true), view.getInt16(1280, true)])
    .toEqual([0x1234, -32768, 32767]);
  f.input.close();
  expect(f.write).toHaveBeenCalledTimes(1);
});

it('suspends at five seconds, bounds pre-roll and wakes on voiced speech without waking on sustained DC', async () => {
  const f = await inputFixture();
  try {
    for (let i = 0; i < 62; i++) { f.input.push(frame(1280, 0)); await settle(); }
    expect(f.suspend).not.toHaveBeenCalled();
    f.input.push(frame(1280, 0)); await settle();
    expect(f.suspend).toHaveBeenCalledTimes(1);
    const before = f.write.mock.calls.length;
    for (let i = 0; i < 100; i++) f.input.push(frame(1280, 0));
    expect(f.input.bufferedFrames).toBe(4);
    f.input.push(voicedFrame(0)); await settle();
    expect(f.resume).toHaveBeenCalledTimes(1);
    expect(f.write).toHaveBeenCalledTimes(before);
    f.input.setUploading(true); await settle();
    expect(f.write).toHaveBeenCalledTimes(before + 4);
    expect(f.fail).not.toHaveBeenCalled();
    expect(f.bargeIn).not.toHaveBeenCalled();
  } finally {
    f.input.close();
  }

  // Sustained DC offset (after initial 1-frame step transient) stays silent and suspends at 5s.
  const g = await inputFixture();
  try {
    g.input.push(frame(1280, 600)); // step transient frame
    await settle();
    for (let i = 0; i < 63; i++) { g.input.push(frame(1280, 600)); await settle(); }
    expect(g.suspend).toHaveBeenCalledTimes(1);
    expect(g.bargeIn).not.toHaveBeenCalled();
    g.input.push(frame(1280, 600));
    await settle();
    expect(g.resume).not.toHaveBeenCalled();
  } finally {
    g.input.close();
  }
});

it('rejects format mismatch and overflows a blocked STT lane without unbounded promises', async () => {
  const f = await inputFixture(160);
  let release!: () => void;
  f.write.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  f.input.push(frame(1280)); await settle();
  f.input.push(frame(1280));
  expect(f.input.bufferedFrames).toBe(2);
  f.input.push(frame(1280));
  expect(f.fail).toHaveBeenCalledExactlyOnceWith('AUDIO_BUFFER_OVERFLOW');
  release(); await settle();
  expect(f.write).toHaveBeenCalledTimes(1);
  const g = await inputFixture();
  g.input.push({ ...frame(1280), sampleRate: 48000 });
  expect(g.fail).toHaveBeenCalledExactlyOnceWith('INVALID_AUDIO_FRAME');
  expect(g.write).not.toHaveBeenCalled();
  g.input.close();
});

it('discards partial and queued frames on mute and resets VAD before forwarding fresh input', async () => {
  const f = await inputFixture();
  const resetSpy = vi.spyOn(f.vad, 'reset');
  const destroySpy = vi.spyOn(f.vad, 'destroy');
  let release!: () => void;
  f.write.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  f.input.push(frame(1280, 1000)); await settle();
  f.input.push(frame(1280, 2000)); f.input.push(frame(100, 3000));
  f.input.setEnabled(false); f.input.setEnabled(true);
  expect(resetSpy).toHaveBeenCalledTimes(2);
  f.input.push(frame(1280, 4000)); release(); await settle();
  expect(f.write).toHaveBeenCalledTimes(2);
  const fresh = f.write.mock.calls[1][0];
  expect(new DataView(fresh.buffer, fresh.byteOffset).getInt16(0, true)).toBe(4000);
  f.input.close();
  f.input.close();
  expect(destroySpy).toHaveBeenCalledTimes(1);
});

it('preserves a source VoiceSessionError instead of masking it as STT failure', async () => {
  const f = await inputFixture();
  f.write.mockRejectedValueOnce(new VoiceSessionError('VOICE_QUOTA_EXHAUSTED', 'none'));
  f.input.push(frame(1280)); await settle();
  expect(f.fail).toHaveBeenCalledExactlyOnceWith('VOICE_QUOTA_EXHAUSTED');
  expect(f.input.bufferedFrames).toBe(0);
  f.input.close();
});

it('triggers edge-triggered barge-in at 300 ms voiced speech, resets on silence, and ignores short clicks', async () => {
  const f = await inputFixture();
  try {
    // Three voiced frames (12 x 20 ms = 240 ms) do not trigger barge-in yet.
    f.input.push(voicedFrame(0));
    f.input.push(voicedFrame(1280));
    f.input.push(voicedFrame(2560));
    await settle();
    expect(f.bargeIn).not.toHaveBeenCalled();

    // Fourth voiced frame crosses 15 consecutive windows (300 ms) once; continuing speech does not spam.
    f.input.push(voicedFrame(3840));
    f.input.push(voicedFrame(5120));
    await settle();
    expect(f.bargeIn).toHaveBeenCalledTimes(1);

    // Silence resets the latch so a subsequent speech onset can barge in again.
    f.input.push(frame(1280, 0));
    f.input.push(frame(1280, 0));
    await settle();
    f.input.push(voicedFrame(6400));
    f.input.push(voicedFrame(7680));
    f.input.push(voicedFrame(8960));
    await settle();
    expect(f.bargeIn).toHaveBeenCalledTimes(1);

    // Next frame reaches 16 windows -> triggers second barge-in.
    f.input.push(voicedFrame(10240));
    await settle();
    expect(f.bargeIn).toHaveBeenCalledTimes(2);
  } finally {
    f.input.close();
  }
});

it('handles exact 15-window boundary, silence reset mid-frame, and VAD errors fail-closed', async () => {
  const patterns: boolean[][] = [
    [true, true, true, true],     // 4
    [true, true, true, true],     // 8
    [true, true, true, true],     // 12
    [true, true, true, false],    // hits 15 on window 2, resets on window 3
    [false, true, true, true],    // 3
    [true, true, true, true],     // 7
    [true, true, true, true],     // 11
    [true, true, true, true],     // hits 15 on window 3
  ];
  const fakeVad: VoiceVad = {
    decisions: vi.fn(() => patterns.shift() ?? [false, false, false, false]),
    reset: vi.fn(),
    destroy: vi.fn(),
  };
  const f = await inputFixture(1000, fakeVad);
  for (let i = 0; i < 8; i++) f.input.push(frame(1280, 1000));
  await settle();
  expect(f.bargeIn).toHaveBeenCalledTimes(2);

  vi.mocked(fakeVad.decisions).mockImplementationOnce(() => {
    throw new VoiceSessionError('MEDIA_GATE_UNAVAILABLE');
  });
  f.input.push(frame(1280, 0));
  expect(f.fail).toHaveBeenCalledExactlyOnceWith('MEDIA_GATE_UNAVAILABLE');
  expect(fakeVad.destroy).toHaveBeenCalledTimes(1);
});

it('ignores low-level noise below the energy floor even when VAD returns true, and does not wake quiet suspension', async () => {
  const fakeVad: VoiceVad = {
    decisions: vi.fn(() => [true, true, true, true]),
    reset: vi.fn(),
    destroy: vi.fn(),
  };
  const f = await inputFixture(1000, fakeVad);
  try {
    // Low amplitude noise (peak 150 < 600, RMS 150 < 200) never triggers barge-in
    for (let i = 0; i < 6; i++) { f.input.push(frame(1280, 150)); await settle(); }
    expect(f.bargeIn).not.toHaveBeenCalled();

    // Isolated high-peak click (peak 800 >= 600, RMS ~45 < 200) never triggers barge-in
    const click = new Int16Array(1280);
    for (let w = 0; w < 4; w++) click[w * 320] = 800;
    for (let i = 0; i < 6; i++) {
      f.input.push({ data: click, sampleRate: 16000, channels: 1, samplesPerChannel: 1280 });
      await settle();
    }
    expect(f.bargeIn).not.toHaveBeenCalled();

    // Suspends at 5s of below-floor frames and does not wake on low-level noise
    for (let i = 0; i < 51; i++) { f.input.push(frame(1280, 150)); await settle(); }
    expect(f.suspend).toHaveBeenCalledTimes(1);
    f.input.push(frame(1280, 150));
    await settle();
    expect(f.resume).not.toHaveBeenCalled();

    // Real speech-level energy wakes quiet suspension
    f.input.push(voicedFrame(0));
    await settle();
    expect(f.resume).toHaveBeenCalledTimes(1);
  } finally {
    f.input.close();
  }
});

it('flushAndDisable drains queued and zero-padded partial frames before resetting', async () => {
  const f = await inputFixture();
  let releaseFirst!: () => void;
  f.write.mockImplementationOnce(() => new Promise<void>(resolve => { releaseFirst = resolve; }));

  // First full frame is in-flight, second full frame is queued, third is a 100-sample partial tail.
  f.input.push(frame(1280, 1000));
  await settle();
  f.input.push(frame(1280, 2000));
  f.input.push(frame(100, 3000));
  expect(f.write).toHaveBeenCalledTimes(1);

  const flushing = f.input.flushAndDisable();
  // Further pushes after flushAndDisable() begins must be ignored.
  f.input.push(frame(1280, 4000));
  releaseFirst();
  await flushing;

  expect(f.write).toHaveBeenCalledTimes(3);
  const view0 = new DataView(f.write.mock.calls[0][0].buffer, f.write.mock.calls[0][0].byteOffset);
  const view1 = new DataView(f.write.mock.calls[1][0].buffer, f.write.mock.calls[1][0].byteOffset);
  const view2 = new DataView(f.write.mock.calls[2][0].buffer, f.write.mock.calls[2][0].byteOffset);
  expect(view0.getInt16(0, true)).toBe(1000);
  expect(view1.getInt16(0, true)).toBe(2000);
  expect(f.write.mock.calls[2][0]).toHaveLength(2560);
  expect(view2.getInt16(0, true)).toBe(3000);
  expect(view2.getInt16(99 * 2, true)).toBe(3000);
  expect(view2.getInt16(100 * 2, true)).toBe(0);
  expect(view2.getInt16(1279 * 2, true)).toBe(0);
  expect(f.input.bufferedFrames).toBe(0);
  f.input.close();
});

it('flushAndDisable resolves immediately when queue and partial buffer are empty', async () => {
  const f = await inputFixture();
  try {
    f.input.push(frame(1280, 1000));
    await settle();
    expect(f.write).toHaveBeenCalledTimes(1);

    // Regression: flushing with empty queue and partial=0 must not leave a stale drainTask spinning.
    await f.input.flushAndDisable();
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.input.bufferedFrames).toBe(0);
  } finally {
    f.input.close();
  }
});
