/**
 * ============================================================================
 * FILE: measurements.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/measurements.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Observe nonzero PCM receipt and conservative interruption boundaries.
 *
 * ROLE IN PROJECT:
 *    P3 measurements use one injected monotonic clock domain.
 *    Nothing here proves device audibility or durable heard-history.
 *
 * KEY COMPONENTS:
 *    - ReceiptObserver: Managed-event/nullability overlay on P1's decoded observer.
 * ============================================================================
 */
import type { TurnObservation } from '../shared/contracts.js';
import { DecodedObserver } from '../shared/timing.js';

type ReceiptMetrics = Pick<TurnObservation,
  'speechEndToFirstAudioMs' | 'speechEndToThinkingMs' | 'modelFirstOutputMs' |
  'ttsFirstAudioMs' | 'interruptionToCutoffMs' | 'staleTailObservedMs' |
  'staleTailNonzeroFrames' | 'streamGapCount' | 'maxStreamGapMs' |
  'decodedPlaybackProof' | 'durableCompletionStatus'>;

export class ReceiptObserver {
  private time = Number.NEGATIVE_INFINITY;
  private readonly observer = new DecodedObserver({ now: () => this.time });
  private thinkingAt: number | null = null;
  private marker: number | null = null;
  private ambiguous = false;
  private endedAt: number | null = null;
  private audioDone = false;

  constructor(private readonly speechEndAt: number) {
    if (!Number.isFinite(speechEndAt)) throw new Error('INVALID_MARKER');
    // A local observer label, not a provider/OpenRouter generation identifier.
    this.observer.begin('managed-no-generation-id', speechEndAt);
  }

  get earlyEndpoint(): boolean { return this.observer.snapshot().earlyEndpoint; }

  private advance(at: number): void {
    if (!Number.isFinite(at) || at < this.time) throw new Error('NON_MONOTONIC_CLOCK');
    this.time = at;
    this.observer.tick();
  }

  thinking(at: number): void {
    this.thinkingAt ??= at;
    this.newResponse(at);
  }

  newResponse(at: number): void {
    this.advance(at);
    if (this.marker !== null &&
        this.observer.snapshot().staleTailObservedMs !== 1000) this.ambiguous = true;
  }

  done(): void { this.audioDone = true; }

  pcm(frame: Buffer, at: number): void {
    if (this.endedAt !== null) return;
    if (!frame.length || frame.length % 2 || frame.length > 1048576 ||
        !Number.isFinite(at)) throw new Error('INVALID_OUTPUT_PCM');
    this.advance(at); // Tick before updating: late audio cannot erase a quiet gap.
    const samples = new Int16Array(frame.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = frame.readInt16LE(i * 2);
    this.observer.frame(samples, 24000, 1);
  }

  interrupt(at: number): void {
    if (this.marker !== null || this.audioDone) {
      throw new Error('INTERRUPTION_ANCHOR_MISSING');
    }
    this.advance(at);
    this.observer.interrupt();
    if (!this.observer.snapshot().interruptionAnchorObserved) {
      throw new Error('INTERRUPTION_ANCHOR_MISSING');
    }
    this.marker = at;
  }

  poll(at: number): void {
    this.advance(at);
  }

  endObservation(at: number): void { this.advance(at); this.endedAt = at; }

  interruptionSucceeded(at: number): boolean {
    const s = this.snapshot(at);
    return s.staleTailObservedMs === 1000 && s.staleTailNonzeroFrames === 0;
  }

  snapshot(at: number): ReceiptMetrics {
    const observedUntil = Math.min(at, this.endedAt ?? at);
    this.poll(observedUntil);
    const shared = this.observer.snapshot();
    const complete = !this.ambiguous && this.marker !== null &&
      shared.staleTailObservedMs === 1000;
    return {
      speechEndToFirstAudioMs: shared.speechEndToFirstAudioMs,
      speechEndToThinkingMs: this.thinkingAt !== null &&
        this.thinkingAt >= this.speechEndAt
        ? this.thinkingAt - this.speechEndAt : null,
      modelFirstOutputMs: null,
      ttsFirstAudioMs: null,
      interruptionToCutoffMs: complete ? shared.interruptionToCutoffMs : null,
      staleTailObservedMs: complete ? 1000 : null,
      staleTailNonzeroFrames: complete ? shared.staleTailNonzeroFrames : null,
      streamGapCount: shared.streamGapCount,
      maxStreamGapMs: shared.maxStreamGapMs,
      decodedPlaybackProof: 'unproven-headless-pcm-only',
      durableCompletionStatus: 'not-applicable',
    };
  }
}
