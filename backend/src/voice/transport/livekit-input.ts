/**
 * ============================================================================
 * FILE: livekit-input.ts
 * LOCATION: backend/src/voice/transport/livekit-input.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Convert decoded LiveKit microphone frames into exact 2560-byte STT frames.
 *
 * ROLE IN PROJECT:
 *    Applies Aurvin's existing 16 kHz/80 ms speech framing, a five-second quiet
 *    suspension gate with bounded pre-roll, and finite forwarding into LiveFlow.
 *
 * KEY COMPONENTS:
 *    - LiveKitInput: PCM accumulator, quiet gate and bounded STT-forward queue.
 * ============================================================================
 */

import { LIVE_WEBRTC_AUDIO as A, type VoiceErrorCode } from '../../contracts/voice-wire.js';
import { voiceError } from '../session/voice-session.options.js';
import type { VoiceVad } from './voice-vad.js';

type DecodedFrame = {
  data: Int16Array;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
};

const WINDOW_SAMPLES = A.sttFrameSamples / 4;

function windowHasSpeechEnergy(view: DataView, windowIndex: number): boolean {
  const start = windowIndex * WINDOW_SAMPLES;
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < WINDOW_SAMPLES; i++) {
    const sample = view.getInt16((start + i) * 2, true);
    const abs = sample < 0 ? -sample : sample;
    if (abs > peak) peak = abs;
    sumSq += sample * sample;
  }
  return peak >= A.quietPeakThreshold && sumSq >= WINDOW_SAMPLES * A.bargeInMinRms * A.bargeInMinRms;
}

export class LiveKitInput {
  private partial = new Uint8Array(A.sttFrameBytes);
  private used = 0;
  private quietMs = 0;
  private speechWindows = 0;
  private bargeInLatched = false;
  private suspended = false;
  private waking = false;
  private uploading = true;
  private enabled = true;
  private flushing = false;
  private closed = false;
  private preRoll: Uint8Array[] = [];
  private queue: Uint8Array[] = [];
  private running = false;
  private inFlight = false;
  private drainTask?: Promise<void>;
  private readonly maxFrames: number;

  constructor(
    inputQueueMs: number,
    private readonly write: (pcm: Uint8Array) => Promise<void>,
    private readonly suspend: () => void,
    private readonly resume: () => void,
    private readonly fail: (code: VoiceErrorCode) => void,
    private readonly vad: VoiceVad,
    private readonly bargeIn?: () => void,
  ) {
    this.maxFrames = Math.floor(inputQueueMs / A.sttFrameMs);
  }

  get bufferedFrames() {
    return this.preRoll.length + this.queue.length + Number(this.inFlight);
  }

  private failure(code: VoiceErrorCode) {
    if (!this.closed) {
      this.close();
      this.fail(code);
    }
  }

  push(frame: DecodedFrame) {
    if (this.closed || !this.enabled) return;
    if (frame.sampleRate !== A.sttSampleRateHz || frame.channels !== A.sttChannels ||
      frame.samplesPerChannel !== frame.data.length || !frame.data.length ||
      frame.data.byteLength > this.maxFrames * A.sttFrameBytes) {
      this.failure('INVALID_AUDIO_FRAME');
      return;
    }
    for (const sample of frame.data) {
      if (this.closed) break;
      this.partial[this.used++] = sample & 255;
      this.partial[this.used++] = (sample >> 8) & 255;
      if (this.used === A.sttFrameBytes) {
        const pcm = this.partial;
        this.partial = new Uint8Array(A.sttFrameBytes);
        this.used = 0;
        this.accept(pcm);
      }
    }
  }

  private accept(pcm: Uint8Array) {
    let windows: boolean[];
    try {
      windows = this.vad.decisions(pcm);
      if (windows.length !== 4) {
        this.failure('MEDIA_GATE_UNAVAILABLE');
        return;
      }
    } catch {
      this.failure('MEDIA_GATE_UNAVAILABLE');
      return;
    }
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let speech = false;
    let triggerBargeIn = false;
    for (let w = 0; w < windows.length; w++) {
      const active = windows[w]! && windowHasSpeechEnergy(view, w);
      speech ||= active;
      this.quietMs = active ? 0 : this.quietMs + A.quietFrameWindowMs;
      if (active) {
        this.speechWindows++;
        if (!this.bargeInLatched && this.speechWindows >= A.bargeInSpeechWindows) {
          this.bargeInLatched = true;
          triggerBargeIn = true;
        }
      } else {
        this.speechWindows = 0;
        this.bargeInLatched = false;
      }
    }
    if (!this.suspended && this.quietMs >= A.quietHangoverMs) {
      this.suspended = true;
      this.uploading = false;
      this.waking = false;
      this.queue = [];
      this.preRoll = [];
      this.remember(pcm);
      this.suspend();
      return;
    }
    if (this.suspended && !this.waking) {
      this.remember(pcm);
      if (!speech) return;
      this.waking = true;
      const onset = this.preRoll;
      this.preRoll = [];
      for (const part of onset) this.enqueue(part);
      if (!this.closed) this.resume();
      if (triggerBargeIn && !this.closed) this.bargeIn?.();
      return;
    }
    this.enqueue(pcm);
    if (triggerBargeIn && !this.closed) this.bargeIn?.();
  }

  private remember(pcm: Uint8Array) {
    this.preRoll.push(pcm);
    while (this.preRoll.length && (this.preRoll.length > A.quietPreRollFrames ||
      this.bufferedFrames > this.maxFrames)) {
      this.preRoll.shift();
    }
  }

  private enqueue(pcm: Uint8Array) {
    if (this.closed) return;
    if (this.bufferedFrames >= this.maxFrames) {
      this.failure('AUDIO_BUFFER_OVERFLOW');
      return;
    }
    this.queue.push(pcm);
    this.drain();
  }

  private canDrain() {
    return !this.closed && this.uploading && (this.enabled || this.flushing);
  }

  private drain() {
    if (this.running || !this.queue.length || !this.canDrain()) return;
    this.running = true;
    let settled = false;
    let task: Promise<void> | undefined;
    task = (async () => {
      try {
        while (this.queue.length && this.canDrain()) {
          const pcm = this.queue.shift()!;
          this.inFlight = true;
          try {
            await this.write(pcm);
          } finally {
            this.inFlight = false;
          }
        }
      } catch (error) {
        this.failure(voiceError(error, 'STT_UNAVAILABLE').code);
      } finally {
        this.running = false;
        settled = true;
        if (this.drainTask === task) this.drainTask = undefined;
        if (this.queue.length && this.canDrain()) this.drain();
      }
    })();
    // Only publish a pending drainTask; synchronous completion must not leave a stale promise.
    if (!settled) this.drainTask = task;
  }

  setUploading(enabled: boolean) {
    if (this.closed || this.uploading === enabled) return;
    this.uploading = enabled;
    if (enabled) {
      this.suspended = false;
      this.waking = false;
      this.quietMs = 0;
      this.preRoll = [];
      this.drain();
    }
  }

  async flushAndDisable(): Promise<void> {
    this.enabled = false;
    if (this.uploading && !this.suspended && !this.closed) {
      this.flushing = true;
      try {
        if (this.used > 0) {
          this.partial.fill(0, this.used);
          const pcm = this.partial;
          this.partial = new Uint8Array(A.sttFrameBytes);
          this.used = 0;
          this.enqueue(pcm);
        } else {
          this.drain();
        }
        while (this.drainTask) {
          await this.drainTask;
        }
      } finally {
        this.flushing = false;
      }
    }
    this.reset();
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.reset();
  }

  private reset() {
    this.used = 0;
    this.partial = new Uint8Array(A.sttFrameBytes);
    this.queue = [];
    this.preRoll = [];
    this.quietMs = 0;
    this.speechWindows = 0;
    this.bargeInLatched = false;
    this.suspended = false;
    this.waking = false;
    this.uploading = true;
    if (!this.closed) {
      try {
        this.vad.reset();
      } catch {
        this.failure('MEDIA_GATE_UNAVAILABLE');
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.enabled = false;
    this.reset();
    try {
      this.vad.destroy();
    } catch {
      // Teardown must remain idempotent.
    }
  }
}
