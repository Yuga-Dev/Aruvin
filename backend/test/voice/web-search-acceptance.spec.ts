/**
 * ============================================================================
 * FILE: web-search-acceptance.spec.ts
 * LOCATION: backend/test/voice/web-search-acceptance.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify integrated voice admission, shared execution, and late-result fencing.
 *
 * ROLE IN PROJECT:
 *    P5 cross-boundary evidence: real VoiceUpgradeAdmission over the assembled
 *    AuthService, the real AgentVoiceAdapter/shared runtime, deterministic MCP
 *    provider wires, and the stock asynchronous archive. No live WebRTC media.
 *
 * KEY COMPONENTS:
 *    - AC6: real admission to shared model with all foreground storage blocked.
 *    - AC8: bound live frames preserve sources without speaking activity.
 *    - AC6: next voice turn finishes while the actual archive is held.
 *    - AC9: barge-in, disable, and revoked authority fence late results.
 * ============================================================================
 */

import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { expect, it } from 'vitest';
import type { VoiceServerPayload } from '../../src/contracts/voice-wire.js';
import {
  WEB_CREDENTIALS_INVALID_MESSAGE, WEB_TOOL_DEFINITION,
} from '../../src/contracts/web-search-tools.js';
import { AgentVoiceAdapter } from '../../src/voice/agent/agent-voice-adapter.js';
import { key } from '../../src/persistence/records.js';
import { webAcceptanceFixture } from '../assembly/web-search-acceptance-fixture.js';

type Fixture = Awaited<ReturnType<typeof webAcceptanceFixture>>;

function requestFor(origin: string, cookie = 'aurvin_wos_session=sealed_1'): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
  const req = new IncomingMessage(socket);
  req.url = '/api/voice';
  req.headers = { host: '127.0.0.1:3000', origin, cookie };
  req.rawHeaders = ['Host', '127.0.0.1:3000', 'Origin', origin, 'Cookie', cookie];
  return req;
}

async function admitVoice(f: Fixture) {
  const req = requestFor(f.origin);
  await f.service.voiceUpgrades.verify(req);
  const principal = f.service.voiceUpgrades.takePrincipal(req);
  req.socket.destroy();
  const reservation = await f.runtime.reservations.acquire({
    identity: principal.identity, conversationId: null,
    owner: { kind: 'live', voiceSessionId: 'web-voice-1' },
  });
  const context: Parameters<AgentVoiceAdapter['attach']>[0] = {
    identity: principal.identity,
    configSnapshot: f.snapshot,
    reservation,
    response: {
      protocolVersion: 1, sessionId: 'web-voice-1', conversationId: null, mode: 'live',
      connectionEpoch: 1, websocketUrl: '/api/voice',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      effectiveAudioSettings: {
        input: { encoding: 'pcm16', sampleRate: 16000, channels: 1, endian: 'little', frameMs: 80 },
        output: { encoding: 'pcm16', sampleRate: 24000, channels: 1, endian: 'little' },
      },
      limits: {
        dictationMaxMs: 300000, liveMaxMs: 1200000, liveWarningMs: 1080000, idleWarningMs: 60000,
        idleExitAfterWarningMs: 30000, finalizationMs: 200, reconnectMs: 10000, connectMs: 10000,
        inputQueueMs: 1000, outputQueueMs: 2000,
      },
    },
  };
  let bound = reservation;
  const bridge = new AgentVoiceAdapter(f.runtime, async (_voiceId, conversationId) => {
    bound = await f.runtime.reservations.bindConversation({
      identity: principal.identity, reservationId: reservation.reservationId, conversationId,
    });
    context.reservation = bound;
    context.response.conversationId = conversationId;
  });
  const sinkEvents: VoiceServerPayload[] = [];
  const spoken: string[] = [];
  let activeRef: { turnId: string; responseId: string } | null = null;
  const flow = {
    providerSocketId: 'tts-web-acceptance',
    waitForOutput: async () => true,
    prepareResponse: (ref: { turnId: string; responseId: string }) => {
      activeRef = ref;
      return { providerBaseSamples: 0 };
    },
    modelStarted: () => undefined,
    modelOutput: () => undefined,
    speak: async (chunk: { text: string }) => { spoken.push(chunk.text); },
    flush: async () => {
      if (!activeRef) return;
      await bridge.hooks.delivery(context, {
        type: 'speech-completed', turnId: activeRef.turnId, responseId: activeRef.responseId,
        speechId: 'speech-web', audioDurationMs: 100, audioSamples: 2400,
        usage: { providerRequestId: null, model: 'fixture', modelVersion: null,
          audioMs: 100, billableCharacters: spoken.join('').length },
      });
      await bridge.hooks.playback(context, activeRef, 2400);
    },
    deliverySettled: () => undefined,
  };
  bridge.attach(context, flow as never, {
    event: payload => { sinkEvents.push(payload); },
    audio: () => true,
    close: () => undefined,
  });
  return { bridge, context, sinkEvents, spoken, principal, reservation };
}

async function preparedFixture(): Promise<Fixture> {
  const f = await webAcceptanceFixture();
  await f.prepare();
  await f.connect('exa');
  await f.enable(true);
  return f;
}

it('[AC6] real voice admission to shared model has zero pre-model application storage and web preparation', async () => {
  const f = await preparedFixture();
  let guard: ReturnType<typeof f.guardForegroundStorage> | undefined;
  try {
    guard = f.guardForegroundStorage();
    f.beginMeasurement();
    const voice = await admitVoice(f);
    f.queue(
      { id: 'voice_web', name: 'web_tool', raw: '{"mode":"browse","query":"public evidence"}' },
      { text: 'Verified voice answer.' },
    );
    await f.trace.run({ lane: 'foreground' }, () => voice.bridge.finalized(voice.context, {
      providerSocketEpoch: 1, providerTurnId: 'web-voice-1', text: 'Search public evidence',
    }, new AbortController().signal));
    f.endMeasurement();
    expect(f.beforeModel).toHaveLength(2);
    expect(f.beforeModel[0]).toMatchObject({
      dbReads: 0, dbWrites: 0, storageEntries: 0,
      initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0, retrieval: 0,
    });
    expect(f.beforeModel[1]).toMatchObject({ dbReads: 0, dbWrites: 0, storageEntries: 0 });
    expect(f.beforeModel[1]!.retrieval).toBe(1);
    expect(f.bodies[0]!.tools).toContainEqual(WEB_TOOL_DEFINITION);
    expect(guard.attempts()).toBe(0);
  } finally {
    guard?.restore();
    await f.close();
  }
});

it('[AC10] live voice relays the fixed reconnect message and the next turn is status-only', async () => {
  const f = await preparedFixture();
  try {
    f.failProvider('exa', 401);
    const voice = await admitVoice(f);
    f.beginMeasurement();
    f.queue(
      { id: 'voice_rejected', name: 'web_tool', raw: '{"mode":"browse","query":"rejected facts"}' },
      { text: WEB_CREDENTIALS_INVALID_MESSAGE },
    );
    await voice.bridge.finalized(voice.context, {
      providerSocketEpoch: 1, providerTurnId: 'web-voice-rejected-1', text: 'Search rejected facts',
    }, new AbortController().signal);
    f.endMeasurement();
    expect(f.boundary().retrieval).toBe(1);
    const failure = (f.bodies[1]!.messages as Array<{ role: string; content?: string }>)
      .filter(message => message.role === 'tool').at(-1);
    expect(failure?.content).toContain(WEB_CREDENTIALS_INVALID_MESSAGE);
    const conversationId = voice.context.response.conversationId!;
    const items = f.runtime.memoryMessages('u1', conversationId, { cursor: null, limit: 10 })
      ?.items ?? [];
    const assistant = items.find(message => message.role === 'assistant');
    expect(assistant?.voiceTranscripts?.[0]?.content).toBe(WEB_CREDENTIALS_INVALID_MESSAGE);
    const providerCalls = f.providerCalls('exa').length;

    f.beginMeasurement();
    f.queue(
      { id: 'voice_status_only', name: 'web_tool', raw: '{"mode":"browse","query":"again"}' },
      { text: 'Web search is still unavailable.' },
    );
    await voice.bridge.finalized(voice.context, {
      providerSocketEpoch: 1, providerTurnId: 'web-voice-rejected-2', text: 'Try again',
    }, new AbortController().signal);
    f.endMeasurement();
    expect(f.boundary()).toMatchObject({ initialize: 0, list: 0, probes: 0, retrieval: 0 });
    expect(f.providerCalls('exa')).toHaveLength(providerCalls);
    expect(f.bodies.at(-1)!.tools).toContainEqual(WEB_TOOL_DEFINITION);
    const repaired = (f.bodies.at(-1)!.messages as Array<{ role: string; content?: string }>)
      .filter(message => message.role === 'tool').at(-1);
    expect(repaired?.content).toContain(WEB_CREDENTIALS_INVALID_MESSAGE);
  } finally { await f.close(); }
});

it('[AC8] bound live frames preserve sources without speaking activity', async () => {
  const f = await preparedFixture();
  try {
    const voice = await admitVoice(f);
    f.queue(
      { id: 'voice_frame', name: 'web_tool', raw: '{"mode":"browse","query":"voice facts"}' },
      { text: 'Spoken narration only.' },
    );
    await voice.bridge.finalized(voice.context, {
      providerSocketEpoch: 1, providerTurnId: 'web-voice-2', text: 'Search voice facts',
    }, new AbortController().signal);
    const frames = voice.sinkEvents.filter((event): event is Extract<VoiceServerPayload,
      { type: 'web.frame' }> => event.type === 'web.frame');
    expect(frames.length).toBeGreaterThan(0);
    const sources = frames.filter(frame => frame.event.type === 'web-sources');
    expect(sources).toHaveLength(1);
    const conversationId = voice.context.response.conversationId!;
    const assistant = f.runtime.memoryMessages('u1', conversationId, { cursor: null, limit: 10 })
      ?.items.find(message => message.role === 'assistant');
    expect(assistant?.webSources?.[0]).toMatchObject({ toolCallId: 'voice_frame', provider: 'exa' });
    for (const frame of frames) {
      expect(frame.turnId).toBe(assistant?.turnId);
      expect(frame.responseId).toBe(key('voice-response', 'u1', conversationId, frame.attemptId));
    }
    expect(voice.spoken.join('')).not.toContain('searching');
    expect(voice.spoken.join('')).not.toContain('reading');
  } finally { await f.close(); }
});

it('[AC6] voice next turn finishes before the actual archive releases', async () => {
  const f = await preparedFixture();
  let hold: ReturnType<typeof f.heldArchive> | undefined;
  try {
    hold = f.heldArchive();
    const voice = await admitVoice(f);
    f.queue({ text: 'First narration.' });
    await voice.bridge.finalized(voice.context, {
      providerSocketEpoch: 1, providerTurnId: 'web-voice-3', text: 'First request',
    }, new AbortController().signal);
    await hold.entered;
    f.beginMeasurement();
    f.queue({ text: 'Second narration.' });
    await voice.bridge.finalized(voice.context, {
      providerSocketEpoch: 1, providerTurnId: 'web-voice-4', text: 'Second request',
    }, new AbortController().signal);
    f.endMeasurement();
    expect(f.beforeModel.at(-1)).toMatchObject({
      dbReads: 0, dbWrites: 0, storageEntries: 0,
      initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0,
    });
  } finally {
    hold?.release();
    await f.close();
  }
});

it('[AC9] barge-in during a provider call discards the late result', async () => {
  const f = await preparedFixture();
  let hold: ReturnType<typeof f.holdProvider> | undefined;
  try {
    hold = f.holdProvider('exa');
    const voice = await admitVoice(f);
    f.beginMeasurement();
    f.queue(
      { id: 'voice_late', name: 'web_tool', raw: '{"mode":"browse","query":"late facts"}' },
      { text: 'A fallback answer.' },
    );
    const running = voice.bridge.finalized(voice.context, {
      providerSocketEpoch: 1, providerTurnId: 'web-voice-5', text: 'Search late facts',
    }, new AbortController().signal);
    await hold.entered;
    const current = voice.bridge.currentResponse();
    expect(current).not.toBeNull();
    const interruption = voice.bridge.interrupt(voice.context, current!);
    hold.release();
    hold = undefined;
    await interruption;
    await running.catch(() => undefined);
    expect(voice.sinkEvents.some(event => event.type === 'response.cancelled')).toBe(true);
    expect(voice.sinkEvents.some(event => event.type === 'web.frame'
      && event.event.type === 'web-sources')).toBe(false);
    f.endMeasurement();
    expect(f.boundary().retrieval).toBe(1);
  } finally {
    hold?.release();
    await f.close();
  }
});

it('[AC9] disable mid-call fences voice sources', async () => {
  const f = await preparedFixture();
  let hold: ReturnType<typeof f.holdProvider> | undefined;
  try {
    hold = f.holdProvider('exa');
    const voice = await admitVoice(f);
    f.queue(
      { id: 'voice_disabled', name: 'web_tool', raw: '{"mode":"browse","query":"disabled facts"}' },
      { text: 'Honest fallback.' },
    );
    const running = voice.bridge.finalized(voice.context, {
      providerSocketEpoch: 1, providerTurnId: 'web-voice-6', text: 'Search disabled facts',
    }, new AbortController().signal);
    await hold.entered;
    await f.enable(false);
    hold.release();
    hold = undefined;
    await running.catch(() => undefined);
    expect(voice.sinkEvents.some(event => event.type === 'web.frame'
      && event.event.type === 'web-sources')).toBe(false);
  } finally {
    hold?.release();
    await f.close();
  }
});

it('[AC9] new admission after local revoke fails closed', async () => {
  const f = await preparedFixture();
  try {
    f.service.auth.authority.close();
    await expect(f.service.voiceUpgrades.verify(requestFor(f.origin)))
      .rejects.toMatchObject({ code: 'NOT_READY' });
    // An already captured principal is not automatically reauthenticated; the
    // production contract only fences new admissions.
    expect(f.bodies).toHaveLength(0);
  } finally { await f.close(); }
});
