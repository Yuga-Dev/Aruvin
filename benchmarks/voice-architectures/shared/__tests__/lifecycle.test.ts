/**
 * ============================================================================
 * FILE: lifecycle.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/lifecycle.test.ts
 * PURPOSE: Exercise late/failed native transport lifecycle deterministically.
 * ROLE IN PROJECT: Proves decoded consumption outlives provider terminal controls.
 * KEY COMPONENTS: Fake RTC streams; abort; late join; failure-aware close.
 * ============================================================================
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  room: null as import('node:events').EventEmitter | null,
  reader: null as ReadableStreamDefaultController<{
    data: Int16Array; sampleRate: number; channels: number }> | null,
  connect: async (): Promise<void> => undefined, disconnects: 0, failDisconnect: false,
  remote: (): unknown => null
}));
vi.mock('@livekit/rtc-node', async () => {
  const { EventEmitter } = await import('node:events');
  class RemoteAudioTrack {}
  native.remote = () => new RemoteAudioTrack();
  class Room extends EventEmitter {
    name = 'owned-room';
    localParticipant = { publishTrack: async () => ({}), publishData: async () => undefined };
    constructor() { super(); native.room = this; }
    async connect() { await native.connect(); }
    async disconnect() { native.disconnects++; if (native.failDisconnect) throw Error('fixture'); }
  }
  return { Room, RemoteAudioTrack,
    AudioSource: class { queuedDuration = 0; clearQueue() {} async close() {} async captureFrame() {} },
    AudioFrame: class {}, TrackPublishOptions: class {}, TrackSource: { SOURCE_MICROPHONE: 1 },
    LocalAudioTrack: { createAudioTrack: () => ({ close: async () => undefined }) },
    AudioStream: class { getReader() { return new ReadableStream({
      start(controller) { native.reader = controller; }
    }).getReader(); } },
    RoomEvent: { DataReceived: 'data', TrackSubscribed: 'track', Disconnected: 'disconnected',
      Reconnecting: 'reconnecting', TrackUnsubscribed: 'unsubscribed', TrackSubscriptionFailed: 'subscription-failed' } };
});
import { createParticipant } from '../webrtc-participant.js';
beforeEach(() => {
  vi.useFakeTimers(); native.room = null; native.reader = null; native.disconnects = 0;
  native.failDisconnect = false; native.connect = async () => undefined;
});
afterEach(() => { vi.useRealTimers(); });
function options(signal = new AbortController().signal) {
  const faults: string[] = [], frames: number[] = [], controls: Uint8Array[] = [];
  return { faults, frames, controls, value: { url: 'wss://fixture.invalid', token: 'fixture',
    roomName: 'owned-room', agentIdentity: 'agent', clock: { now: () => performance.now() }, signal,
    onPcm: (data: Int16Array) => { frames.push(data[0]); },
    onControl: (bytes: Uint8Array) => { controls.push(bytes); }, onFault: (code: string) => { faults.push(code); } } };
}
it.each(['audio.end', 'response.cancelled'])('keeps decoded tail after %s', async type => {
  const fixture = options(), participant = await createParticipant(fixture.value);
  native.room!.emit('track', native.remote(), {}, { identity: 'agent' });
  native.room!.emit('data', new TextEncoder().encode(JSON.stringify({ type })),
    { identity: 'agent' }, undefined, 'aurvin.voice.control');
  native.reader!.enqueue({ data: Int16Array.of(42), sampleRate: 24000, channels: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.frames).toEqual([42]); expect(fixture.controls).toHaveLength(1);
  expect(await participant.close()).toBe(true);
});
it('rejects the wrong control sender and duplicate remote track', async () => {
  const fixture = options(), participant = await createParticipant(fixture.value);
  native.room!.emit('data', new Uint8Array(), { identity: 'other' }, undefined, 'aurvin.voice.control');
  native.room!.emit('track', native.remote(), {}, { identity: 'agent' });
  native.room!.emit('track', native.remote(), {}, { identity: 'agent' });
  expect(fixture.faults).toEqual(['CONTROL_BINDING_INVALID', 'MEDIA_BINDING_INVALID']);
  expect(await participant.close()).toBe(true);
});
it('marks early stream close as failure and aborts an outstanding read', async () => {
  const aborter = new AbortController(), fixture = options(aborter.signal);
  const participant = await createParticipant(fixture.value);
  native.room!.emit('track', native.remote(), {}, { identity: 'agent' });
  native.reader!.close(); await vi.advanceTimersByTimeAsync(0);
  expect(fixture.faults).toContain('MEDIA_EARLY_CLOSE');
  aborter.abort(); expect(await participant.close()).toBe(true);
});
it('keeps failed disconnect visible instead of returning successful cleanup', async () => {
  const participant = await createParticipant(options().value);
  native.failDisconnect = true;
  expect(await participant.close()).toBe(false);
});
it('disconnects a join that succeeds only after its deadline', async () => {
  let release!: () => void;
  native.connect = () => new Promise<void>(resolve => { release = resolve; });
  const pending = createParticipant(options().value).then(() => 'unexpected', error => error.message);
  await vi.advanceTimersByTimeAsync(10001);
  expect(await pending).toBe('BENCHMARK_MEDIA_FAILED');
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(native.disconnects).toBe(1);
});
