/**
 * ============================================================================
 * FILE: webrtc-participant.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/webrtc-participant.test.ts
 * PURPOSE: Verify native caller lifecycle without loading native code/network.
 * ROLE IN PROJECT: Reusable P1/P2 transport fixture with exact frame capture.
 * KEY COMPONENTS: Fake RTC module; input conversion; no playback claims.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ captured: [] as Int16Array[], controls: [] as unknown[],
  disconnects: 0, clears: 0 }));
vi.mock('@livekit/rtc-node', async () => {
  const { EventEmitter } = await import('node:events');
  class Room extends EventEmitter {
    name = 'owned-room';
    localParticipant = { publishTrack: async () => ({}),
      publishData: async (data: Uint8Array) => { state.controls.push(JSON.parse(new TextDecoder().decode(data))); } };
    async connect() {} async disconnect() { state.disconnects++; }
  }
  class AudioSource {
    queuedDuration = 0; async captureFrame(frame: { data: Int16Array }) { state.captured.push(frame.data); }
    clearQueue() { state.clears++; } async close() {}
  }
  return { Room, AudioSource, AudioFrame: class { constructor(public data: Int16Array) {} },
    LocalAudioTrack: { createAudioTrack: () => ({ close: async () => undefined }) },
    TrackPublishOptions: class {}, TrackSource: { SOURCE_MICROPHONE: 1 },
    RoomEvent: { DataReceived: 'data', TrackSubscribed: 'track', Disconnected: 'disconnected',
      Reconnecting: 'reconnecting', TrackUnsubscribed: 'unsubscribed', TrackSubscriptionFailed: 'subscription-failed' } };
});
import { createParticipant } from '../webrtc-participant.js';
it('captures aligned PCM and sends only caller-requested controls', async () => {
  let now = 0;
  const participant = await createParticipant({ url: 'wss://fixture.invalid', token: 'not-a-secret-fixture',
    roomName: 'owned-room', agentIdentity: 'synthetic-agent', clock: { now: () => now },
    signal: new AbortController().signal, sleepFor: async ms => { now += ms; },
    onPcm: () => undefined, onControl: () => undefined, onFault: () => undefined });
  const bytes = Buffer.alloc(2560); bytes.writeInt16LE(-123, 0);
  await participant.play(bytes);
  expect(state.captured[0][0]).toBe(-123);
  expect(state.controls).toEqual([]);
  expect(await participant.close()).toBe(true);
  expect(await participant.close()).toBe(true);
  expect(state.disconnects).toBe(1);
  expect(state.clears).toBe(1);
});
