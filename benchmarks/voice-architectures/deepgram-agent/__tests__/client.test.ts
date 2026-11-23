/**
 * ============================================================================
 * FILE: client.test.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/__tests__/client.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Test real Voice Agent event sequencing without opening a network socket.
 *
 * ROLE IN PROJECT:
 *    P3 protocol transport fixtures, not a simulated benchmark candidate.
 *    Synthetic EventEmitter sockets exercise the same client handlers.
 *
 * KEY COMPONENTS:
 *    - MockSocket: Minimal ws-compatible fixture.
 *    - Client checks: Handshake, failure, audio flags and bounded shutdown.
 * ============================================================================
 */
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { attachVoiceAgentV1, openVoiceAgentV1 } from '../client.js';
import { buildSettings } from '../protocol.js';
import { ReceiptObserver } from '../measurements.js';

class MockSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: { value: string | Buffer; binary: boolean }[] = [];
  terminated = 0;
  closed = 0;
  send(value: string | Buffer, options: { binary: boolean }) {
    this.sent.push({ value, binary: options.binary });
  }
  close() { this.closed += 1; }
  terminate() { this.terminated += 1; this.emit('close', 1006); }
  event(value: object) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  socket(): WebSocket { return this as unknown as WebSocket; }
}

const settings = () => buildSettings({
  modelId: 'vendor/requested-model', ttsModel: 'flux-haley-en',
  openRouterApiKey: 'fixture-key', prompt: 'Synthetic instruction.',
  contextCharacters: 45000, eotThreshold: 0.8, eotTimeoutMs: 5000,
});

afterEach(() => vi.useRealTimers());

it('sends Settings only after Welcome and permits input only after SettingsApplied', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  const events: string[] = [];
  const pcm = vi.fn();
  const session = attachVoiceAgentV1(ws.socket(), settings(), {
    onEvent: (e) => events.push(e.type), onPcm: pcm,
  });
  expect(ws.sent).toEqual([]);
  expect(() => session.text('Hi')).toThrow('AGENT_NOT_READY');
  ws.event({ type: 'Welcome', request_id: 'fixture-request' });
  expect(ws.sent).toEqual([{ value: JSON.stringify(settings()), binary: false }]);
  expect(() => session.audio(Buffer.alloc(2560))).toThrow('AGENT_NOT_READY');
  ws.event({ type: 'SettingsApplied' });
  await expect(session.ready).resolves.toBeUndefined();
  session.text('Hi');
  session.audio(Buffer.alloc(2560));
  expect(ws.sent[1]).toEqual({
    value: '{"type":"InjectUserMessage","content":"Hi"}', binary: false,
  });
  expect(ws.sent[2]?.binary).toBe(true);
  for (const type of ['UserStartedSpeaking', 'AgentThinking',
    'AgentStartedSpeaking', 'AgentAudioDone']) ws.event({ type, content: 'discard' });
  ws.emit('message', Buffer.alloc(960), true);
  expect(pcm).toHaveBeenCalledOnce();
  expect(events).toEqual([
    'Welcome', 'SettingsApplied', 'UserStartedSpeaking',
    'AgentThinking', 'AgentStartedSpeaking', 'AgentAudioDone',
  ]);
  const closing = session.close();
  ws.emit('close', 1000);
  await closing;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['provider', 'socket', 'early-close', 'malformed', 'out-of-order'])(
  'rejects a %s handshake failure without reconnect or raw payload leakage',
  async (kind) => {
    vi.useFakeTimers();
    const ws = new MockSocket();
    const session = attachVoiceAgentV1(ws.socket(), settings());
    const rejected = expect(session.ready).rejects.toThrow(/^AGENT_/);
    if (kind === 'provider') ws.event({
      type: 'Error', code: 'INVALID_SETTINGS', description: 'fixture-key',
    });
    if (kind === 'socket') ws.emit('error', new Error('fixture-key'));
    if (kind === 'early-close') ws.emit('close', 1006);
    if (kind === 'malformed') ws.emit('message', Buffer.from('{'), false);
    if (kind === 'out-of-order') ws.event({ type: 'SettingsApplied' });
    await rejected;
    await session.close();
    expect(ws.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('times out a silent handshake and forcibly terminates bounded cleanup', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  const session = attachVoiceAgentV1(ws.socket(), settings());
  const rejected = expect(session.ready).rejects.toThrow('AGENT_SETUP_TIMEOUT');
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  await session.close();
  expect(ws.terminated).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores late frames after shutdown and does not retry partial-response errors', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  const pcm = vi.fn();
  const failures: string[] = [];
  const session = attachVoiceAgentV1(ws.socket(), settings(), {
    onPcm: pcm, onFailure: (code) => failures.push(code),
  });
  ws.event({ type: 'Welcome', request_id: 'fixture-request' });
  ws.event({ type: 'SettingsApplied' });
  await session.ready;
  ws.emit('message', Buffer.alloc(960), true);
  ws.event({ type: 'Error', code: 'INTERNAL_SERVER_ERROR', description: 'fixture-key' });
  ws.emit('message', Buffer.alloc(960), true);
  await session.close();
  expect(pcm).toHaveBeenCalledOnce();
  expect(failures).toEqual(['AGENT_PROVIDER_ERROR']);
  expect(ws.sent).toHaveLength(1);
});

it('blocks the real socket factory even when explicit live intent and keys are supplied', async () => {
  const openSocket = vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); });
  await expect(openVoiceAgentV1({
    region: 'eu', deepgramApiKey: 'fixture-deepgram', settings: settings(),
  }, openSocket)).rejects.toThrow('BLOCKED_BYO_CONTROLS_UNSUPPORTED');
  expect(openSocket).not.toHaveBeenCalled();
});

it('cancels after SettingsApplied, is idempotent and forces close after one second', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  const controller = new AbortController();
  const failures: string[] = [];
  const s = attachVoiceAgentV1(ws.socket(), settings(), {
    onFailure: (code) => failures.push(code),
  }, controller.signal);
  ws.event({ type: 'Welcome', request_id: 'fixture-request' });
  ws.event({ type: 'SettingsApplied' });
  await s.ready;
  controller.abort();
  await s.close();
  await s.close();
  expect(ws.terminated).toBe(1);
  expect(failures).toEqual(['AGENT_CANCELLED']);
  expect(vi.getTimerCount()).toBe(0);

  const second = new MockSocket();
  const pending = attachVoiceAgentV1(second.socket(), settings());
  second.event({ type: 'Welcome', request_id: 'fixture-request-2' });
  second.event({ type: 'SettingsApplied' });
  await pending.ready;
  const closing = pending.close();
  expect(pending.close()).toBe(closing);
  await vi.advanceTimersByTimeAsync(1000);
  await closing;
  expect(second.terminated).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects excessive queued output without sending another frame', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  const s = attachVoiceAgentV1(ws.socket(), settings());
  ws.event({ type: 'Welcome', request_id: 'fixture-request' });
  ws.event({ type: 'SettingsApplied' });
  await s.ready;
  ws.bufferedAmount = 262145;
  expect(() => s.audio(Buffer.alloc(2560))).toThrow('AGENT_BACKPRESSURE_OR_CLOSED');
  expect(ws.sent).toHaveLength(1);
  await s.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('feeds the same socket events and binary frames into the shared-backed receipt observer', async () => {
  vi.useFakeTimers();
  const ws = new MockSocket();
  let at = 0;
  const m = new ReceiptObserver(100);
  const s = attachVoiceAgentV1(ws.socket(), settings(), {
    onPcm: (frame, time) => m.pcm(frame, time),
    onEvent: (event, time) => {
      if (event.type === 'AgentThinking') m.thinking(time);
      if (event.type === 'AgentStartedSpeaking') m.newResponse(time);
      if (event.type === 'AgentAudioDone') m.done();
    },
  }, undefined, () => at);
  ws.event({ type: 'Welcome', request_id: 'fixture-request' });
  ws.event({ type: 'SettingsApplied' });
  await s.ready;
  at = 130;
  ws.event({ type: 'AgentThinking', content: 'DISCARD_PRIVATE_THOUGHT' });
  at = 140;
  ws.event({ type: 'AgentStartedSpeaking',
    total_latency: '0.001', ttt_latency: '0.001', tts_latency: '0.001' });
  const frame = Buffer.alloc(960); frame.writeInt16LE(1);
  at = 160; ws.emit('message', frame, true);
  at = 760; ws.emit('message', frame, true);
  at = 770; m.interrupt(at); s.audio(Buffer.alloc(2560));
  at = 775; ws.event({ type: 'UserStartedSpeaking' });
  at = 800; ws.emit('message', frame, true);
  at = 825; ws.event({ type: 'AgentAudioDone' });
  expect(m.snapshot(900).interruptionToCutoffMs).toBeNull();
  expect(m.snapshot(1820)).toMatchObject({
    speechEndToFirstAudioMs: 60,
    modelFirstOutputMs: null, ttsFirstAudioMs: null,
    interruptionToCutoffMs: 50,
    staleTailObservedMs: 1000, staleTailNonzeroFrames: 0,
  });
  const closing = s.close(); ws.emit('close', 1000); await closing;
  expect(vi.getTimerCount()).toBe(0);
});
