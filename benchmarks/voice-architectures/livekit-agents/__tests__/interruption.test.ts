/**
 * ============================================================================
 * FILE: interruption.test.ts
 * LOCATION: benchmarks/voice-architectures/livekit-agents/__tests__/interruption.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    real framework output-clear fixture; real TTSv2 abort fixture.
 *
 * ROLE IN PROJECT:
 *    Supplies P2's standalone framework candidate without changing Aurvin.
 *    Consumes only the isolated package and P1-owned run configuration.
 *
 * KEY COMPONENTS:
 *    - real framework output-clear fixture; real TTSv2 abort fixture.
 * ============================================================================
 */
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import { AudioFrame } from '@livekit/rtc-node';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { DecodedObserver } from '../../shared/timing.js';
import '../config.js';

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.close();
});

async function listen(path: string) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const port = (wss.address() as { port: number }).port;
  const state = {
    connections: 0,
    urls: [] as string[],
    sent: [] as string[],
    clients: [] as WebSocket[],
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}${path}`,
    async close() {
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
  wss.on('connection', (ws, request) => {
    state.connections += 1;
    state.urls.push(request.url ?? '');
    state.clients.push(ws);
    ws.send(JSON.stringify({ type: 'Connected', request_id: 'fixture' }));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const text = String(raw);
      state.sent.push(text);
      let message: { type?: string };
      try { message = JSON.parse(text); } catch { return; }
      if (message.type === 'Flush') {
        ws.send(Buffer.alloc(9600, 1), { binary: true });
      }
    });
  });
  servers.push(state);
  return state;
}

it('actual TTSv2 abort closes the old stream and never sends playback_offset Interrupt', async () => {
  const server = await listen('/v2/speak');
  const tts = new deepgram.TTSv2({
    apiKey: 'fixture-key', model: 'flux-haley-en',
    baseUrl: `${server.baseUrl}/v2/speak`,
    sampleRate: 24000, encoding: 'linear16', mipOptOut: true,
  });
  const stream = tts.stream({
    connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
  });
  try {
    stream.pushText('synthetic output long enough to be cancelled ');
    stream.flush();
    const first = await stream.next();
    expect(first.done).toBe(false);
    const old = server.clients[0]!;
    const oldClosed = new Promise<void>((resolve) => old.once('close', () => resolve()));
    stream.close();
    expect(stream.abortSignal.aborted).toBe(true);
    old.send(Buffer.alloc(9600, 2), { binary: true });
    for await (const buffered of stream) {
      if (typeof buffered !== 'symbol') {
        expect(buffered.frame.data.every((sample) => sample === 257)).toBe(true);
      }
    }
    expect(server.sent.some((packet) => /Interrupt|playback_offset/.test(packet))).toBe(false);
    await oldClosed;
    expect(old.readyState).toBe(old.CLOSED);
    const next = tts.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    try {
      next.pushText('new synthetic generation ');
      next.flush();
      const firstNew = await next.next();
      expect(firstNew.done).toBe(false);
      if (!firstNew.done && typeof firstNew.value !== 'symbol') {
        expect(firstNew.value.frame.data.every((sample) => sample === 257)).toBe(true);
      }
      expect(server.connections).toBe(2);
    } finally {
      next.close();
    }
  } finally {
    stream.close();
    await tts.close();
  }
  await vi.waitFor(() => {
    expect(server.clients.every((socket) => socket.readyState === socket.CLOSED)).toBe(true);
  });
});

it('observes real STTv2 and TTSv2 regional URLs without eager EOT', async () => {
  const sttServer = await listen('/v2/listen');
  const ttsServer = await listen('/v2/speak');
  const stt = new deepgram.STTv2({
    apiKey: 'fixture-key', model: 'flux-general-en', sampleRate: 16000,
    endpointUrl: sttServer.wsUrl, eotThreshold: 0.8, eotTimeoutMs: 5000, mipOptOut: true,
  });
  const tts = new deepgram.TTSv2({
    apiKey: 'fixture-key', model: 'flux-haley-en', sampleRate: 24000,
    encoding: 'linear16', baseUrl: `${ttsServer.baseUrl}/v2/speak`, mipOptOut: true,
  });
  const listenStream = stt.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 } });
  await vi.waitFor(() => expect(sttServer.connections).toBeGreaterThan(0));
  const sttUrl = new URL(sttServer.urls[0]!, sttServer.baseUrl);
  expect(sttUrl.pathname).toBe('/v2/listen');
  expect(sttUrl.searchParams.get('model')).toBe('flux-general-en');
  expect(sttUrl.searchParams.get('eot_threshold')).toBe('0.8');
  expect(sttUrl.searchParams.get('eot_timeout_ms')).toBe('5000');
  expect(sttUrl.searchParams.get('mip_opt_out')).toBe('true');
  expect(sttUrl.searchParams.has('eager_eot_threshold')).toBe(false);
  listenStream.close();
  const speak = tts.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 } });
  speak.pushText('synthetic ');
  speak.flush();
  await vi.waitFor(() => expect(ttsServer.connections).toBeGreaterThan(0));
  const ttsUrl = new URL(ttsServer.urls[0]!, ttsServer.baseUrl);
  expect(ttsUrl.pathname).toBe('/v2/speak');
  expect(ttsUrl.searchParams.get('model')).toBe('flux-haley-en');
  expect(ttsUrl.searchParams.get('encoding')).toBe('linear16');
  expect(ttsUrl.searchParams.get('sample_rate')).toBe('24000');
  expect(ttsUrl.searchParams.get('mip_opt_out')).toBe('true');
  speak.close();
  await tts.close();
});

class FixtureOutput extends voice.AudioOutput {
  readonly frames: AudioFrame[] = [];
  clears = 0;
  constructor() { super(24000); }
  override async captureFrame(frame: AudioFrame) {
    await super.captureFrame(frame);
    this.frames.push(frame);
  }
  override clearBuffer() {
    this.clears++;
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
  }
  override flush() {
    super.flush();
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: false });
  }
}

it('actual AgentSession interruption clears output and cancels its supplied audio stream', async () => {
  const { ReadableStream } = await import('node:stream/web');
  const { sessionOptions } = await import('../config.js');
  const output = new FixtureOutput();
  const session = new voice.AgentSession({ ...sessionOptions(), vad: null });
  const cancelled = vi.fn();
  let captured!: () => void;
  const firstCapture = new Promise<void>((resolve) => { captured = resolve; });
  const original = output.captureFrame.bind(output);
  vi.spyOn(output, 'captureFrame').mockImplementation(async (frame) => {
    await original(frame);
    captured();
  });
  const audio = new ReadableStream<AudioFrame>({
    start(controller) {
      controller.enqueue(new AudioFrame(new Int16Array(480).fill(1), 24000, 1, 480));
    },
    cancel: cancelled,
  });
  session.output.audio = output;
  try {
    await session.start({ agent: new voice.Agent({ instructions: 'synthetic', tools: [] }), record: false });
    session.say('synthetic output', { audio, addToChatCtx: false });
    await firstCapture;
    await session.interrupt({ force: true }).await;
    // 1.10.0 force-interrupt resolves before the audio-forwarder calls clearBuffer.
    await vi.waitFor(() => expect(output.clears).toBeGreaterThan(0));
    expect(cancelled).toHaveBeenCalledTimes(1);
    const count = output.frames.length;
    await Promise.resolve();
    expect(output.frames).toHaveLength(count);
  } finally {
    await session.close();
  }
});

function observedResponse(withAnchor: boolean) {
  let now = 0;
  const observer = new DecodedObserver({ now: () => now });
  observer.begin('synthetic-A', 300);
  const at = (time: number, nonzero = true) => {
    now = time;
    observer.frame(new Int16Array(480).fill(nonzero ? 1 : 0), 24000, 1);
  };
  if (withAnchor) {
    for (let time = 400; time < 1000; time += 20) at(time);
  }
  now = 1000;
  observer.interrupt();
  return {
    observer, at,
    tick(time: number) { now = time; observer.tick(); },
  };
}

it('no output anchor is not interruption success', () => {
  const fixture = observedResponse(false);
  fixture.at(1100, false);
  fixture.tick(2500);
  expect(fixture.observer.snapshot()).toMatchObject({
    interruptionAnchorObserved: false, interruptionToCutoffMs: null,
    staleTailObservedMs: null, staleTailNonzeroFrames: null,
  });
});

it('cutoff is decoded output cessation not the provider cancellation event', () => {
  const fixture = observedResponse(true);
  fixture.at(1020);
  fixture.at(1040);
  fixture.tick(1160);
  expect(fixture.observer.snapshot().staleTailObservedMs).toBeNull();
  fixture.tick(2060);
  expect(fixture.observer.snapshot()).toMatchObject({
    interruptionAnchorObserved: true, interruptionToCutoffMs: 60,
    staleTailObservedMs: 1000, staleTailNonzeroFrames: 0,
  });
});

it('consumer keeps observing late nonzero frames after cancellation', () => {
  const fixture = observedResponse(true);
  fixture.at(1020);
  fixture.at(1040);
  fixture.tick(1160);
  fixture.at(1500);
  fixture.tick(2060);
  expect(fixture.observer.snapshot()).toMatchObject({
    staleTailObservedMs: 1000, staleTailNonzeroFrames: 1, staleTailBytes: 960,
  });
});

it('provider terminal without complete tail window remains unknown', () => {
  const fixture = observedResponse(true);
  fixture.at(1020);
  fixture.at(1040);
  fixture.tick(1660);
  expect(fixture.observer.snapshot()).toMatchObject({
    interruptionToCutoffMs: null, staleTailObservedMs: null, staleTailNonzeroFrames: null,
  });
});

it('early hesitation response is identified rather than clamped into a fast onset', () => {
  let now = 800;
  const observer = new DecodedObserver({ now: () => now });
  observer.begin('synthetic-hesitation', 1000);
  observer.frame(new Int16Array(480).fill(1), 24000, 1);
  expect(observer.snapshot()).toMatchObject({
    earlyEndpoint: true, speechEndToFirstAudioMs: null,
  });
  expect(now - 1000).toBe(-200);
});
