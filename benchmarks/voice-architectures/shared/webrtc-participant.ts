/**
 * ============================================================================
 * FILE: webrtc-participant.ts
 * LOCATION: benchmarks/voice-architectures/shared/webrtc-participant.ts
 * PURPOSE: Publish paced 16 kHz input and continuously consume 24 kHz decoded PCM.
 * ROLE IN PROJECT: Real headless WebRTC caller, not an audible-playback witness.
 * KEY COMPONENTS: Lazy native import; sender binding; late-join cleanup.
 * ============================================================================
 */
import { bounded, pacePcm, wait, type Clock } from './timing.js';
type Options = { url: string; token: string; roomName: string; agentIdentity: string;
  clock: Clock; signal: AbortSignal; sleepFor?: (ms: number) => Promise<unknown>;
  onPcm(data: Int16Array, rate: number, channels: number): void;
  onControl(data: Uint8Array): void; onFault(code: string): void };
export type Participant = {
  play(pcm: Uint8Array, firstFrame?: (clockMs: number) => void):
    Promise<{ latenessMs: number; maxQueuedMs: number }>;
  sendControl(payload: unknown): Promise<void>;
  close(): Promise<boolean>; connectedAtMs: number;
};
export async function createParticipant(options: Options): Promise<Participant> {
  const rtc = await import('@livekit/rtc-node');
  const room = new rtc.Room(), source = new rtc.AudioSource(16000, 1, 1000);
  let track: ReturnType<typeof rtc.LocalAudioTrack.createAudioTrack> | undefined;
  let reader: ReadableStreamDefaultReader<import('@livekit/rtc-node').AudioFrame> | undefined;
  let media: Promise<void> | undefined; let closing = false;
  let closed: Promise<boolean> | undefined; let joined = false;
  const fault = (code: string) => { if (!closing) options.onFault(code); };
  const disconnect = async () => { if (joined) { joined = false; await room.disconnect(); } };
  const close = (): Promise<boolean> => closed ??= (async () => {
    closing = true; options.signal.removeEventListener('abort', abort);
    source.clearQueue();
    const cancelReader = await Promise.allSettled([
      bounded(Promise.resolve().then(() => reader?.cancel()), 2000),
      bounded(media ?? Promise.resolve(), 2000),
    ]);
    const results = await Promise.allSettled([
      bounded(Promise.resolve().then(() => track?.close()), 2000),
      bounded(Promise.resolve().then(() => source.close()), 2000), bounded(disconnect(), 2000),
    ]);
    room.removeAllListeners();
    return [...cancelReader, ...results].every(result => result.status === 'fulfilled');
  })();
  const abort = () => { fault('BENCHMARK_TIMEOUT'); void close(); };
  room.on(rtc.RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
    if (closing || topic !== 'aurvin.voice.control') return;
    if (participant?.identity !== options.agentIdentity || bytes.length > 131072) {
      fault('CONTROL_BINDING_INVALID'); return;
    }
    options.onControl(bytes);
  });
  room.on(rtc.RoomEvent.TrackSubscribed, (remote, _publication, participant) => {
    if (closing || participant.identity !== options.agentIdentity) return;
    if (!(remote instanceof rtc.RemoteAudioTrack) || reader) { fault('MEDIA_BINDING_INVALID'); return; }
    reader = new rtc.AudioStream(remote, { sampleRate: 24000, numChannels: 1 }).getReader();
    const ownedReader = reader;
    media = (async () => {
      try {
        while (!closing && !options.signal.aborted) {
          const next = await ownedReader.read();
          if (next.done) { if (!closing) fault('MEDIA_EARLY_CLOSE'); return; }
          options.onPcm(next.value.data, next.value.sampleRate, next.value.channels);
        }
      } catch { if (!closing) fault('MEDIA_READ_FAILED'); }
      finally { ownedReader.releaseLock(); if (reader === ownedReader) reader = undefined; }
    })();
  });
  for (const event of [rtc.RoomEvent.Disconnected, rtc.RoomEvent.Reconnecting,
    rtc.RoomEvent.TrackUnsubscribed, rtc.RoomEvent.TrackSubscriptionFailed]) {
    room.on(event, () => fault('MEDIA_CONNECTION_LOST'));
  }
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.signal.throwIfAborted();
    const joining = room.connect(options.url, options.token).then(async () => {
      joined = true; if (closing || options.signal.aborted) await disconnect();
    });
    // Keep this handler attached: a late successful join still leaves its room.
    void joining.catch(() => undefined);
    await bounded(joining, 10000);
    options.signal.throwIfAborted();
    if (closing || room.name !== options.roomName || !room.localParticipant) throw Error('MEDIA_BINDING_INVALID');
    track = rtc.LocalAudioTrack.createAudioTrack('voice-benchmark-input', source);
    await bounded(room.localParticipant.publishTrack(track,
      new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE })), 10000);
    return {
      connectedAtMs: options.clock.now(),
      play: async (pcm, firstFrame) => {
        let maxQueuedMs = 0, first = true;
        const latenessMs = await pacePcm(pcm, options.clock,
          options.sleepFor ?? (ms => wait(ms, options.signal)), async bytes => {
            options.signal.throwIfAborted();
            if (closing || !Number.isFinite(source.queuedDuration) || source.queuedDuration < 0 ||
              source.queuedDuration + 80 > 1000) throw Error('INPUT_QUEUE_OVERFLOW');
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const samples = Int16Array.from({ length: 1280 }, (_, index) => view.getInt16(index * 2, true));
            if (first) { firstFrame?.(options.clock.now()); first = false; }
            await bounded(source.captureFrame(new rtc.AudioFrame(samples, 16000, 1, 1280)), 2000);
            maxQueuedMs = Math.max(maxQueuedMs, source.queuedDuration);
          }, options.signal);
        return { latenessMs, maxQueuedMs };
      },
      sendControl: async payload => {
        options.signal.throwIfAborted(); if (closing) throw Error('PARTICIPANT_CLOSED');
        await bounded(room.localParticipant!.publishData(
          new TextEncoder().encode(JSON.stringify(payload)), { reliable: true,
            topic: 'aurvin.voice.control', destination_identities: [options.agentIdentity] }), 2000);
      }, close
    };
  } catch { await close(); throw Error('BENCHMARK_MEDIA_FAILED'); }
}
