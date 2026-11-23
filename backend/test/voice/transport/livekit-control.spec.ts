/**
 * ============================================================================
 * FILE: livekit-control.spec.ts
 * LOCATION: backend/test/voice/transport/livekit-control.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Deterministic checks for reliable LiveKit voice envelope shipping.
 *
 * ROLE IN PROJECT:
 *    Proves identity/session/epoch fencing, ordered replay handling, bounded
 *    queues, safe UTF-8/size rejection and P1b chunked envelope reassembly.
 *
 * KEY COMPONENTS:
 *    - fixture(): LiveKitControls with captured publish/receive/dispatch spies.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { LiveKitControls } from '../../../src/voice/transport/livekit-control.js';
import {
  INPUT_AUDIO,
  LIVEKIT_CONTROL_TOPIC,
  encodeVoiceControlPackets,
  parseVoiceControl,
  VoiceControlReassembler,
  type VoiceClientEvent,
  type VoiceServerPayload,
} from '../../../src/contracts/voice-wire.js';
import {
  createSessionResponseFixture,
  largeCanvasArtifactFixture,
} from '../../../src/contracts/testing/voice-fixtures.js';
import { agendaFixture } from '../../contracts/calendar-view.fixture.js';
import { settle } from './fixtures.js';

function fixture() {
  const response = createSessionResponseFixture('live');
  const receive = vi.fn(async (_event: VoiceClientEvent): Promise<void> => undefined);
  const publish = vi.fn(async (_bytes: Uint8Array): Promise<void> => undefined);
  const fail = vi.fn();
  const controls = new LiveKitControls(response, publish, receive, fail);
  const event = (sequence = 0) => ({
    protocolVersion: 1 as const,
    sessionId: response.sessionId,
    connectionEpoch: response.connectionEpoch,
    sequence,
    eventId: `c${sequence}`,
    type: 'session.start' as const,
    mode: 'live' as const,
    audioSettings: INPUT_AUDIO,
  });
  const push = (e: object, identity = response.livekit!.participantIdentity) =>
    controls.receive(
      new TextEncoder().encode(JSON.stringify(e)),
      identity,
      true,
      LIVEKIT_CONTROL_TOPIC,
    );
  return { response, receive, publish, fail, controls, event, push };
}

it('validates identity/session/epoch and fences ordered replays before opening a flow', async () => {
  const f = fixture();
  f.push(f.event());
  f.push(f.event());
  await settle();
  expect(f.receive).toHaveBeenCalledTimes(1);
  f.push({ ...f.event(1), connectionEpoch: 999 });
  await settle();
  expect(f.fail).toHaveBeenLastCalledWith('STALE_CONNECTION_EPOCH');
  const g = fixture();
  g.push(g.event(), 'untrusted');
  await settle();
  expect(g.fail).toHaveBeenCalledWith('VOICE_BINDING_MISMATCH');
  expect(g.receive).not.toHaveBeenCalled();
});

it('serializes valid server envelopes without forwarding backend tokens or payload logs', async () => {
  const f = fixture();
  f.controls.send({ type: 'voice.state', input: 'listening', agent: 'idle', connection: 'connected' });
  f.controls.send({ type: 'session.ended', reason: 'disconnected', terminal: false });
  await settle();
  const events = f.publish.mock.calls.map(([bytes]) =>
    parseVoiceControl(new TextDecoder().decode(bytes), 'server', 'live'));
  expect(events.map(e => e.sequence)).toEqual([0, 1]);
  expect(JSON.stringify(events)).not.toContain(f.response.livekit!.participantToken);
});

it('rejects malformed UTF8, sequence gaps and oversized reliable packets before dispatch', async () => {
  const f = fixture();
  f.push(f.event(1));
  await settle();
  expect(f.fail).toHaveBeenCalledWith('VOICE_SEQUENCE_ERROR');
  const g = fixture();
  g.controls.receive(new Uint8Array([255]), g.response.livekit!.participantIdentity, true, LIVEKIT_CONTROL_TOPIC);
  await settle();
  expect(g.fail).toHaveBeenCalledWith('INVALID_VOICE_CONTROL');
  const h = fixture();
  h.controls.receive(new Uint8Array(15361), h.response.livekit!.participantIdentity, true, LIVEKIT_CONTROL_TOPIC);
  expect(h.fail).toHaveBeenCalledWith('INVALID_VOICE_CONTROL');
  expect(h.receive).not.toHaveBeenCalled();
});

it('ignores foreign topics and lossy packets', async () => {
  const f = fixture();
  f.controls.receive(new TextEncoder().encode(JSON.stringify(f.event())),
    f.response.livekit!.participantIdentity, true, 'other.topic');
  expect(f.fail).not.toHaveBeenCalled();
  f.controls.receive(new TextEncoder().encode(JSON.stringify(f.event())),
    f.response.livekit!.participantIdentity, false, LIVEKIT_CONTROL_TOPIC);
  expect(f.fail).toHaveBeenCalledWith('INVALID_VOICE_CONTROL');
  expect(f.receive).not.toHaveBeenCalled();
});

it('rejects a mismatched session and a duplicated eventId at a new sequence', async () => {
  const f = fixture();
  f.push({ ...f.event(), sessionId: 'other-session' });
  await settle();
  expect(f.fail).toHaveBeenCalledWith('VOICE_BINDING_MISMATCH');
  const g = fixture();
  g.push(g.event());
  await settle();
  g.push({ ...g.event(1), eventId: 'c0' });
  await settle();
  expect(g.fail).toHaveBeenCalledWith('VOICE_SEQUENCE_ERROR');
  expect(g.receive).toHaveBeenCalledTimes(1);
});

it('bounds queued inbound controls while dispatch is blocked', async () => {
  const f = fixture();
  let release!: () => void;
  f.receive.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  for (let i = 0; i < 65; i++) f.push(f.event(i));
  await settle();
  expect(f.fail).toHaveBeenCalledExactlyOnceWith('AUDIO_BUFFER_OVERFLOW');
  release();
  await settle();
  expect(f.receive.mock.calls.length).toBeGreaterThan(0);
  expect(f.receive.mock.calls.length).toBeLessThanOrEqual(64);
});

it('surfaces a rejected publish once and stops draining', async () => {
  const f = fixture();
  f.publish.mockRejectedValueOnce(new Error('data lane failed'));
  f.controls.send({ type: 'voice.state', input: 'listening', agent: 'idle', connection: 'connected' });
  await settle();
  expect(f.fail).toHaveBeenCalledWith('VOICE_DELIVERY_UNKNOWN');
  expect(f.publish).toHaveBeenCalledTimes(1);
});

it('chunks and reassembles a legal large canvas envelope through P1b packets', async () => {
  const f = fixture();
  const { protocolVersion: _p, sessionId: _s, connectionEpoch: _e, eventId: _i, sequence: _q,
    ...payload } = largeCanvasArtifactFixture();
  f.controls.send(payload as VoiceServerPayload);
  await settle();
  expect(f.publish.mock.calls.length).toBeGreaterThan(1);
  const reassembler = new VoiceControlReassembler('server', 'live', {
    sessionId: f.response.sessionId,
    connectionEpoch: f.response.connectionEpoch,
  });
  let complete: ReturnType<typeof reassembler.push> | undefined;
  for (const [bytes] of f.publish.mock.calls) {
    const result = reassembler.push(bytes);
    if (result.status === 'complete') complete = result;
  }
  expect(complete?.status).toBe('complete');
  if (complete?.status === 'complete') {
    expect(complete.event.type).toBe('canvas.artifact');
    if (complete.event.type === 'canvas.artifact')
      expect(complete.event.rawSource).toBe(payload.rawSource);
  }
  expect(f.fail).not.toHaveBeenCalled();
});

it('chunks a near-cap calendar frame with a paired response reference', async () => {
  const f = fixture();
  const entry = { eventId: 'event-1', summary: 'Event', start: '2026-11-11T10:00:00Z',
    end: '2026-11-11T11:00:00Z', allDay: false, timeZone: 'Etc/UTC', status: 'confirmed', htmlLink: null };
  const entries = Array.from({ length: 20 }, (_, n) => ({ ...entry, eventId: String(n), description: 'x'.repeat(400) }));
  // Grow only optional descriptions, keeping the view <=14,336 bytes.
  let view = agendaFixture({ entries });
  for (let n = 401; n < 1000; n++) {
    const candidate = { ...view, entries: entries.map(e => ({ ...e, description: 'x'.repeat(n) })) };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 14336) break;
    view = agendaFixture(candidate);
  }
  const event = { protocolVersion: 1 as const, sessionId: 's'.repeat(128), connectionEpoch: 1,
    eventId: 'e'.repeat(128), sequence: 0, type: 'calendar.frame' as const,
    turnId: 't'.repeat(128), attemptId: 'a'.repeat(128), responseId: 'r'.repeat(128),
    event: { type: 'calendar-view' as const, view } };
  // Use 128-byte correlations and enlarge legal JSON whitespace to exercise packet chunking.
  const json = JSON.stringify(event).replace('{', '{' + ' '.repeat(800));
  const packets = encodeVoiceControlPackets(json, 'server', 'live');
  expect(packets.length).toBeGreaterThan(1);
  const reader = new VoiceControlReassembler('server', 'live');
  let result: ReturnType<typeof reader.push> | undefined;
  for (const packet of packets) result = reader.push(packet);
  expect(result?.status).toBe('complete');
  if (result?.status === 'complete') expect(result.event).toEqual(event);
  expect(f.fail).not.toHaveBeenCalled();
});

const canvasShow = (canvasId = 'response-old::canvas::0') => ({
  type: 'canvas.show' as const, conversationId: 'conversation-1', turnId: 'turn-new',
  responseId: 'response-new', navigationId: 'nav-1', canvasId,
});

const canvasControl = (controlId = 'ctrl-1', selectionRevision = 1) => ({
  type: 'canvas.control' as const, conversationId: 'conversation-1', turnId: 'turn-new',
  responseId: 'response-new', controlId, canvasId: 'msg-1::canvas::0', selectionRevision,
  command: { action: 'zoom_in' as const },
});

const canvasInventory = (sequence: number, omitted = 0) => ({
  sequence, type: 'canvas.inventory' as const, conversationId: 'conversation-1',
  inventory: { items: [{ canvasId: 'msg-1::canvas::0', title: 'Pricing comparison',
    owner: { kind: 'message' as const, id: 'msg-1' } }], omitted },
});

it('publishes Canvas independently of a blocked ordinary control publish and keeps Canvas FIFO', async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.publish.mockImplementationOnce(async () => blocked);
  f.controls.send({ type: 'voice.state', input: 'listening', agent: 'idle', connection: 'connected' });
  await settle();
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.controls.showCanvas(canvasShow(), new AbortController().signal, () => true)).toBe(true);
  expect(f.controls.showCanvas({ ...canvasShow(), navigationId: 'nav-2' }, new AbortController().signal, () => true)).toBe(true);
  try {
    await settle();
    const events = f.publish.mock.calls.map(([bytes]) => parseVoiceControl(new TextDecoder().decode(bytes), 'server', 'live'));
    expect(events.map(e => [e.type, e.sequence])).toEqual([['voice.state', 0], ['canvas.show', 0], ['canvas.show', 1]]);
    expect(f.fail).not.toHaveBeenCalled();
  } finally { release(); await f.controls.flush(); }
});

it('drops a cancelled Canvas request without consuming the ordinary control sequence', async () => {
  const f = fixture();
  const abort = new AbortController();
  expect(f.controls.showCanvas(canvasShow(), abort.signal, () => true)).toBe(true);
  abort.abort();
  f.controls.send({ type: 'voice.state', input: 'listening', agent: 'idle', connection: 'connected' });
  await settle();
  const events = f.publish.mock.calls.map(([bytes]) =>
    parseVoiceControl(new TextDecoder().decode(bytes), 'server', 'live'));
  expect(events.map(e => e.type)).toEqual(['voice.state']);
  expect(events[0]!.sequence).toBe(0);
  expect(f.fail).not.toHaveBeenCalled();
});

it('keeps media healthy when a Canvas-only publish rejects', async () => {
  const f = fixture();
  f.publish.mockRejectedValueOnce(new Error('presentation publish rejected'));
  expect(f.controls.showCanvas(canvasShow(), new AbortController().signal, () => true)).toBe(true);
  await settle();
  f.controls.send({ type: 'voice.state', input: 'listening', agent: 'idle', connection: 'connected' });
  await settle();
  expect(f.fail).not.toHaveBeenCalled();
  const last = parseVoiceControl(new TextDecoder().decode(f.publish.mock.calls.at(-1)![0]), 'server', 'live');
  expect(last).toMatchObject({ type: 'voice.state', sequence: 0 });
});

it('uses gap-tolerant Canvas presentation sequences before the ordinary receive fence', async () => {
  const response = createSessionResponseFixture('live');
  const receive = vi.fn(async (_event: VoiceClientEvent): Promise<void> => undefined);
  const publish = vi.fn(async (_bytes: Uint8Array): Promise<void> => undefined);
  const fail = vi.fn();
  const controls = new LiveKitControls(response, publish, receive, fail);
  const push = (body: Record<string, unknown>, identity = response.livekit!.participantIdentity) =>
    controls.receive(new TextEncoder().encode(JSON.stringify({ protocolVersion: 1,
      sessionId: response.sessionId, connectionEpoch: response.connectionEpoch,
      eventId: `e-${String(body.sequence)}`, ...body })), identity, true, LIVEKIT_CONTROL_TOPIC);
  push(canvasInventory(5));
  push(canvasInventory(5));
  push(canvasInventory(9, 2));
  await settle();
  expect(receive).toHaveBeenCalledTimes(2);
  expect(receive.mock.calls.map(([event]) => event.type)).toEqual(['canvas.inventory', 'canvas.inventory']);
  // The ordinary lane still requires its own exact first sequence.
  push({ ...f_event(response), sequence: 2 });
  await settle();
  expect(fail).toHaveBeenCalledWith('VOICE_SEQUENCE_ERROR');
  push({ ...f_event(response), sequence: 0 });
  await settle();
  expect(receive).toHaveBeenCalledTimes(3);
  expect(receive.mock.calls.at(-1)![0].type).toBe('session.start');
});

function f_event(response: ReturnType<typeof createSessionResponseFixture>) {
  return { type: 'session.start' as const, mode: 'live' as const, audioSettings: INPUT_AUDIO };
}

it('returns false and keeps contents intact when the Canvas lane is full or closed', async () => {
  const f = fixture();
  const pending = () => true;
  for (let n = 0; n < 4; n++) {
    expect(f.controls.showCanvas({ ...canvasShow(), navigationId: `nav-${n}` },
      new AbortController().signal, pending)).toBe(true);
  }
  expect(f.controls.showCanvas({ ...canvasShow(), navigationId: 'nav-overflow' },
    new AbortController().signal, pending)).toBe(false);
  await settle();
  expect(f.fail).not.toHaveBeenCalled();
  f.controls.close();
  expect(f.controls.showCanvas(canvasShow(), new AbortController().signal, pending)).toBe(false);
});

it('carries canvas.control on the presentation FIFO with shared capacity, stale drop, and isolated faults', async () => {
  const f = fixture();
  let currentOk = true;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.publish.mockImplementationOnce(async () => blocked);
  f.controls.send({ type: 'voice.state', input: 'listening', agent: 'idle', connection: 'connected' });
  await settle();

  expect(f.controls.showCanvas(canvasShow(), new AbortController().signal, () => true)).toBe(true);
  expect(f.controls.showCanvas(canvasControl('ctrl-1'), new AbortController().signal, () => true)).toBe(true);
  expect(f.controls.showCanvas(canvasControl('ctrl-stale'), new AbortController().signal, () => currentOk)).toBe(true);
  currentOk = false;
  await settle();
  const events = f.publish.mock.calls.map(([bytes]) => parseVoiceControl(new TextDecoder().decode(bytes), 'server', 'live'));
  expect(events.map(e => [e.type, e.sequence])).toEqual([['voice.state', 0], ['canvas.show', 0], ['canvas.control', 1]]);

  release();
  await f.controls.flush();

  f.publish.mockRejectedValueOnce(new Error('control publish rejected'));
  expect(f.controls.showCanvas(canvasControl('ctrl-fail'), new AbortController().signal, () => true)).toBe(true);
  await settle();
  expect(f.fail).not.toHaveBeenCalled();

  for (let n = 0; n < 4; n++) {
    expect(f.controls.showCanvas(canvasControl(`ctrl-cap-${n}`), new AbortController().signal, () => true)).toBe(true);
  }
  expect(f.controls.showCanvas(canvasShow(), new AbortController().signal, () => true)).toBe(false);
  await settle();
});
