/**
 * ============================================================================
 * FILE: harness.test.ts
 * LOCATION: benchmarks/voice-architectures/aurvin/__tests__/harness.test.ts
 * PURPOSE: Preserve real baseline delivery failures after decoded onset.
 * ROLE IN PROJECT: Pure deterministic control/PCM fixtures, no AppService boot.
 * KEY COMPONENTS: Unknown delivery; stale response; no forged progress.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import { AurvinTurnState, harness } from '../harness.js';
it('retains onset when application completion becomes unknown', () => {
  let now = 1000;
  const state = new AurvinTurnState(1, 1100, { now: () => now });
  state.event({ type: 'audio.start', turnId: 't1', responseId: 'r1' });
  now = 1200; state.frame(Int16Array.of(1), 24000, 1);
  state.event({ type: 'audio.end', turnId: 't1', responseId: 'r1' });
  state.event({ type: 'session.error', code: 'VOICE_DELIVERY_UNKNOWN', recoverable: true, terminal: false });
  expect(state.result()).toMatchObject({ speechEndToFirstAudioMs: 100,
    outcome: 'unverified-playback', durableCompletionStatus: 'unknown',
    failureCode: 'BENCHMARK_UNPROVEN_PLAYBACK' });
  expect(state.paused).toBe(true);
  expect(state.controlsForRecovery()).toEqual([{ type: 'input.unmute' }]);
});
it('ignores stale terminal response IDs and does not accept provider completion as audible proof', () => {
  let now = 0; const state = new AurvinTurnState(2, 1, { now: () => now });
  state.event({ type: 'audio.start', turnId: 't2', responseId: 'r2' });
  state.event({ type: 'audio.end', turnId: 'old', responseId: 'old' });
  expect(state.ended).toBe(false);
  now = 100; state.frame(Int16Array.of(1), 24000, 1);
  state.event({ type: 'audio.end', turnId: 't2', responseId: 'r2' });
  expect(state.result().outcome).toBe('unverified-playback');
  expect(state.controlsForRecovery().some(control => control.type === 'playback.progress')).toBe(false);
});
it('selects the actual Aurvin adapter, not an existing single-turn backend runner', () => {
  expect(harness.id).toBe('aurvin');
  expect(typeof harness.run).toBe('function');
});
it('keeps early output, post-cancel audio, and unobservable stages distinct', () => {
  let now = 1000;
  const early = new AurvinTurnState(3, 1200, { now: () => now });
  early.event({ type: 'audio.start', turnId: 't3', responseId: 'r3' });
  now = 1100; early.frame(Int16Array.of(1), 24000, 1);
  expect(early.result()).toMatchObject({ earlyEndpoint: true, speechEndToFirstAudioMs: null,
    outcome: 'early-endpoint', modelFirstOutputMs: null, ttsFirstAudioMs: null });
  const late = new AurvinTurnState(4, 1000, { now: () => now });
  late.event({ type: 'audio.start', turnId: 't4', responseId: 'r4' });
  now = 1700; late.frame(Int16Array.of(1), 24000, 1);
  late.observer.interrupt();
  late.event({ type: 'response.cancelled', turnId: 't4', responseId: 'r4' });
  now = 1720; late.frame(Int16Array.of(1), 24000, 1);
  expect(late.result().staleTailNonzeroFrames).toBeNull();
  expect(late.controlsForRecovery().some(control => control.type === 'playback.progress')).toBe(false);
  const failed = new AurvinTurnState(1, 1000, { now: () => now });
  failed.event({ type: 'audio.start', turnId: 't1', responseId: 'r1' });
  failed.event({ type: 'session.error', code: 'STT_UNAVAILABLE', recoverable: false, terminal: true });
  expect(failed.result()).toMatchObject({ outcome: 'failed', failureCode: 'STT_UNAVAILABLE',
    durableCompletionStatus: 'unknown' });
});
