/**
 * ============================================================================
 * FILE: measurements.test.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/__tests__/measurements.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prevent false latency, audibility and interruption claims.
 *
 * ROLE IN PROJECT:
 *    Deterministic P3 receipt-boundary checks.
 *    Fixture timestamps are not live wall-clock measurements.
 *
 * KEY COMPONENTS:
 *    - ReceiptObserver fixtures: Nonzero onset, stale tail and unknown attribution.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import { ReceiptObserver } from '../measurements.js';

const voiced = () => { const b = Buffer.alloc(960); b.writeInt16LE(1); return b; };

it('ignores silence and keeps managed model/TTS stages null', () => {
  const m = new ReceiptObserver(100);
  m.pcm(Buffer.alloc(960), 120);
  m.thinking(130);
  m.pcm(voiced(), 160);
  expect(m.snapshot(160)).toMatchObject({
    speechEndToFirstAudioMs: 60,
    speechEndToThinkingMs: 30,
    modelFirstOutputMs: null,
    ttsFirstAudioMs: null,
    decodedPlaybackProof: 'unproven-headless-pcm-only',
    durableCompletionStatus: 'not-applicable',
  });
});

it('does not turn early output or missing audio into a fast successful response', () => {
  const early = new ReceiptObserver(100);
  early.pcm(voiced(), 80);
  expect(early.snapshot(100).speechEndToFirstAudioMs).toBeNull();
  expect(early.earlyEndpoint).toBe(true);
  const empty = new ReceiptObserver(100);
  expect(() => empty.interrupt(700)).toThrow('INTERRUPTION_ANCHOR_MISSING');
  expect(empty.snapshot(2000).interruptionToCutoffMs).toBeNull();
});

it('measures cutoff independently of events and observes a full 1000 ms window', () => {
  const m = new ReceiptObserver(0);
  m.pcm(voiced(), 10);
  m.pcm(voiced(), 610);
  m.interrupt(620);
  m.pcm(voiced(), 650);
  m.poll(850);
  expect(m.snapshot(1669).interruptionToCutoffMs).toBeNull();
  expect(m.snapshot(1670)).toMatchObject({
    interruptionToCutoffMs: 50,
    staleTailObservedMs: 1000,
    staleTailNonzeroFrames: 0,
  });
});

it('records reappearing nonzero tail rather than resetting it away', () => {
  const m = new ReceiptObserver(0);
  m.pcm(voiced(), 0);
  m.pcm(voiced(), 600);
  m.interrupt(610);
  m.poll(810);
  m.pcm(voiced(), 900);
  expect(m.snapshot(1620)).toMatchObject({
    interruptionToCutoffMs: 10,
    staleTailObservedMs: 1000,
    staleTailNonzeroFrames: 1,
  });
  expect(m.interruptionSucceeded(1620)).toBe(false);
});

it('leaves overlapping new-response attribution and early close unknown', () => {
  const m = new ReceiptObserver(0);
  m.pcm(voiced(), 0);
  m.pcm(voiced(), 600);
  m.interrupt(610);
  m.poll(810);
  m.thinking(900);
  expect(m.snapshot(2000).staleTailNonzeroFrames).toBeNull();
  expect(m.snapshot(2000).interruptionToCutoffMs).toBeNull();
  expect(m.interruptionSucceeded(2000)).toBe(false);
  const closed = new ReceiptObserver(0);
  closed.pcm(voiced(), 0);
  closed.pcm(voiced(), 600);
  closed.interrupt(610);
  closed.endObservation(700);
  expect(closed.snapshot(2000).interruptionToCutoffMs).toBeNull();
});

it('does not accept AgentAudioDone as an interruption or physical playback proof', () => {
  const m = new ReceiptObserver(0);
  m.pcm(voiced(), 0);
  m.pcm(voiced(), 600);
  m.done();
  expect(() => m.interrupt(610)).toThrow('INTERRUPTION_ANCHOR_MISSING');
  expect(m.snapshot(2000).durableCompletionStatus).toBe('not-applicable');
  expect(m.snapshot(2000).interruptionToCutoffMs).toBeNull();
});
