/**
 * ============================================================================
 * FILE: timing.ts
 * LOCATION: benchmarks/voice-architectures/shared/timing.ts
 * PURPOSE: Measure local monotonic decoded boundaries and pace finite PCM.
 * ROLE IN PROJECT: Shared by native callers and managed protocol fixtures.
 * KEY COMPONENTS: Clock; DecodedObserver; pacePcm; bounded; summarize.
 * ============================================================================
 */
import { setTimeout as sleep } from 'node:timers/promises';
export interface Clock { now(): number }
export const monotonicClock: Clock = { now: () => performance.now() };
export const wait = (ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal });
export async function bounded<T>(job: Promise<T>, ms: number, code = 'BENCHMARK_TIMEOUT'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([job, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error(code)), ms);
  })]); } finally { clearTimeout(timer); }
}
export async function pacePcm(pcm: Uint8Array, clock: Clock,
  sleepFor: (ms: number) => Promise<unknown>,
  send: (frame: Uint8Array) => Promise<unknown>, signal: AbortSignal): Promise<number> {
  if (!pcm.length || pcm.length % 2560) throw Error('PCM_FRAME_INVALID');
  let started = clock.now(), lateness = 0;
  for (let offset = 0; offset < pcm.length; offset += 2560) {
    signal.throwIfAborted();
    const due = started + offset / 32;
    await sleepFor(Math.max(0, due - clock.now()));
    signal.throwIfAborted();
    let late = clock.now() - due;
    if (late < 0 && late >= -20) {
      await sleepFor(Math.ceil(-late));
      signal.throwIfAborted();
      late = clock.now() - due;
    }
    if (!Number.isFinite(late) || late < -20 || late > 1000) throw Error('INPUT_PACING_INVALID');
    if (late > 80) started += late - 80;
    lateness = Math.max(lateness, Math.max(0, late));
    await send(pcm.subarray(offset, offset + 2560));
  }
  return lateness;
}
export function summarize(raw: number[]) {
  const values = [...raw].sort((a, b) => a - b);
  if (values.some(x => !Number.isFinite(x) || x < 0)) throw Error('METRIC_INVALID');
  const n = values.length;
  return { count: n, median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
    min: n ? values[0] : null, max: n ? values[n - 1] : null,
    exploratoryP95: n ? values[Math.ceil(n * .95) - 1] : null };
}
export class DecodedObserver {
  private speechEnd = 0; private first: number | null = null;
  private lastNonzeroEnd: number | null = null; private lastFrame: number | null = null;
  private marker: number | null = null; private cutoff: number | null = null;
  private completedWindow = false; private tailFrames = 0; private tailBytes = 0;
  private gaps = 0; private maxGap = 0; private early = false; private anchor = false;
  private response: string | null = null;
  constructor(private clock: Clock) {}
  begin(response: string, speechEndClockMs: number) {
    if (this.response !== null) throw Error('OBSERVER_ALREADY_STARTED');
    if (!Number.isFinite(speechEndClockMs)) throw Error('METRIC_INVALID');
    this.response = response; this.speechEnd = speechEndClockMs;
  }
  frame(data: Int16Array, sampleRate: number, channels: number) {
    if (sampleRate !== 24000 || channels !== 1 || !data.length) throw Error('DECODE_FORMAT_INVALID');
    if (!this.response) return;
    const now = this.clock.now();
    if (this.lastFrame !== null) {
      const gap = now - this.lastFrame;
      if (gap < 0) throw Error('CLOCK_REVERSED');
      if (gap > 100) this.gaps++;
      this.maxGap = Math.max(this.maxGap, gap);
    }
    this.lastFrame = now;
    if (!data.some(sample => sample !== 0)) { this.tick(); return; }
    if (this.first === null) { this.first = now; this.early = now < this.speechEnd; }
    if (this.cutoff !== null && now <= this.cutoff + 1000) {
      this.tailFrames++; this.tailBytes += data.byteLength;
    }
    this.lastNonzeroEnd = now + data.length / 24;
    this.tick();
  }
  interrupt() {
    this.marker = this.clock.now();
    this.anchor = this.first !== null && this.marker - this.first >= 600 &&
      this.lastNonzeroEnd !== null && this.marker - this.lastNonzeroEnd <= 100;
  }
  tick() {
    const now = this.clock.now();
    // ponytail: 100 ms decoded quiet defines an observed cutoff, not a DAC stop.
    // A browser/audio-worklet probe is the upgrade path for physical playback.
    if (this.anchor && this.marker !== null && this.cutoff === null &&
      this.lastNonzeroEnd !== null && now - this.lastNonzeroEnd >= 100) {
      this.cutoff = Math.max(this.marker, this.lastNonzeroEnd);
    }
    if (this.cutoff !== null && now >= this.cutoff + 1000) this.completedWindow = true;
  }
  snapshot() {
    return { speechEndToFirstAudioMs: this.first === null || this.early ? null : this.first - this.speechEnd,
      earlyEndpoint: this.early, interruptionAnchorObserved: this.anchor,
      interruptionToCutoffMs: this.completedWindow && this.marker !== null && this.cutoff !== null
        ? this.cutoff - this.marker : null,
      staleTailObservedMs: this.completedWindow ? 1000 : null,
      staleTailNonzeroFrames: this.completedWindow ? this.tailFrames : null,
      staleTailBytes: this.completedWindow ? this.tailBytes : null,
      streamGapCount: this.gaps, maxStreamGapMs: this.lastFrame === null ? null : this.maxGap };
  }
}
