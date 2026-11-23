/**
 * ============================================================================
 * FILE: timing.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/timing.test.ts
 * PURPOSE: Prove exact measurement boundaries without waiting in real time.
 * ROLE IN PROJECT: Deterministic decoded-receipt and interruption evidence.
 * KEY COMPONENTS: Nonzero gate; early endpoint; stale tail; no burst catch-up.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import { DecodedObserver, pacePcm, summarize } from '../timing.js';
it('keeps silence, early output, and cancelled stale audio distinct', () => {
  let now = 1000;
  const observer = new DecodedObserver({ now: () => now });
  observer.begin('r1', 1100);
  observer.frame(new Int16Array(240), 24000, 1);
  expect(observer.snapshot().speechEndToFirstAudioMs).toBeNull();
  now = 1080; observer.frame(Int16Array.of(1), 24000, 1);
  expect(observer.snapshot().earlyEndpoint).toBe(true);
  expect(observer.snapshot().speechEndToFirstAudioMs).toBeNull();
  now = 1690; observer.frame(Int16Array.of(1), 24000, 1);
  now = 1700; observer.interrupt();
  now = 1720; observer.frame(Int16Array.of(1), 24000, 1);
  now = 1830; observer.tick();
  now = 1900; observer.frame(Int16Array.of(1), 24000, 1);
  now = 2830; observer.tick();
  expect(observer.snapshot()).toMatchObject({ interruptionAnchorObserved: true,
    staleTailNonzeroFrames: 1, staleTailObservedMs: 1000 });
  expect(observer.snapshot().interruptionToCutoffMs).toBeCloseTo(20 + 1 / 24);
  expect(() => observer.frame(Int16Array.of(1), 16000, 1)).toThrow('DECODE_FORMAT_INVALID');
  const unattributed = new DecodedObserver({ now: () => now });
  unattributed.begin('r2', 0);
  unattributed.interrupt();
  expect(unattributed.snapshot().interruptionToCutoffMs).toBeNull();
  expect(unattributed.snapshot().staleTailObservedMs).toBeNull();
});
it('paces 80 ms frames and refuses catch-up bursts', async () => {
  let now = 0;
  const at: number[] = [];
  await pacePcm(new Uint8Array(5120), { now: () => now }, async ms => { now += ms; },
    async () => { at.push(now); }, new AbortController().signal);
  expect(at).toEqual([0, 80]);
  now = 0;
  await expect(pacePcm(new Uint8Array(5120), { now: () => now }, async ms => { now += ms; },
    async () => { now += 1200; }, new AbortController().signal)).rejects.toThrow('INPUT_PACING_INVALID');
});
it('summarizes no observations as null, not zero or a stable percentile', () => {
  expect(summarize([])).toEqual({ count: 0, median: null, min: null, max: null, exploratoryP95: null });
  expect(summarize([30, 10, 20])).toMatchObject({ count: 3, median: 20, min: 10, max: 30 });
});
