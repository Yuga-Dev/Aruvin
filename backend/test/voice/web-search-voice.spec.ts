/**
 * ============================================================================
 * FILE: web-search-voice.spec.ts
 * LOCATION: backend/test/voice/web-search-voice.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify live voice emits bound web frames and rejects stale presentation.
 *
 * ROLE IN PROJECT:
 *    Exercises the real AgentVoiceAdapter over the shared memory-first web
 *    loop: valid sources reach the sink, invalid/binding/epoch/closed frames
 *    are dropped, and interruption never publishes a late source.
 *
 * KEY COMPONENTS:
 *    - voiceFixture: Real persistence, reservation, adapter, sink, and flow.
 *    - emission/race cases: valid frame, rejection matrix, barge-in.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { key } from '../../src/persistence/records.js';
import type { VoiceServerPayload } from '../../src/contracts/voice-wire.js';
import type { StreamEnvelope } from '../../src/contracts/stream.js';
import { AgentVoiceAdapter } from '../../src/voice/agent/agent-voice-adapter.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { textConfigFixture } from '../runtime/text-config-fixture.js';
import { authority, execute, wire } from '../runtime/dev-mode-fixture.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import {
  sse, textFrame, webPortFixture, webToolFrame,
} from '../runtime/web-search-fixture.js';

const source = (sourceId: string, toolCallId: string) => ({
  sourceId, toolCallId, provider: 'exa' as const, kind: 'browse' as const,
  title: 'Example', url: 'https://example.com/',
  retrievedAt: '2026-11-14T00:00:00.000Z',
});

async function voiceFixture(a?: ReturnType<typeof authority>) {
  const memory = calendarMemory();
  const client = Object.assign(memory.commandSource, {
    db: () => memory.store.db, appendMetadata: () => undefined,
  }) as unknown as MongoClient;
  const persistence = await createPersistenceBundle(
    client, 'web-voice-test', DEFAULT_BUDGETS, 'web-voice-executor',
  );
  const web = webPortFixture();
  const base = textSnapshot(1);
  const snapshot = { ...base, modelLimits: { ...base.modelLimits!, tools: true } };
  const f = textConfigFixture(snapshot, dependencies => ({
    ...dependencies, webSearch: web.port,
    ...(a ? { devMode: a.mode } : {}),
    memoryFirst: { policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 50 }, voice: true },
  }), persistence);
  const reservation = await f.runtime.reservations.acquire({
    identity: f.identity, conversationId: null,
    owner: { kind: 'live', voiceSessionId: 'web-voice-1' },
  });
  const context: Parameters<AgentVoiceAdapter['attach']>[0] = {
    identity: f.identity,
    configSnapshot: snapshot,
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
    ...(a ? { principal: a.principal } : {}),
  };
  let bound = reservation;
  const bridge = new AgentVoiceAdapter(f.runtime, async (_voiceId, conversationId) => {
    bound = await f.runtime.reservations.bindConversation({
      identity: f.identity, reservationId: reservation.reservationId, conversationId,
    });
    context.reservation = bound;
    context.response.conversationId = conversationId;
  });
  const sinkEvents: VoiceServerPayload[] = [];
  const spoken: string[] = [];
  let activeRef: { turnId: string; responseId: string } | null = null;
  const flow = {
    providerSocketId: 'tts-web',
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
  return { f, web, bridge, context, sinkEvents, spoken };
}

it('announces only the latest selection once across text and final speech', async () => {
  const a = authority(); a.mode.setEnabled(true);
  const { f, web, bridge, context, sinkEvents, spoken } = await voiceFixture(a);
  const consume = vi.spyOn(a.mode, 'consumeForDispatch');
  const say = (id: string, text: string) => bridge.finalized(context,
    { providerSocketEpoch: 1, providerTurnId: id, text }, new AbortController().signal);
  try {
    const ids = await f.submit('Text original');
    await say('blank', ' ');
    expect(consume).not.toHaveBeenCalled();
    a.mode.select(a.principal, 'dev'); a.mode.select(a.principal, 'user');
    a.mode.select(a.principal, 'dev'); a.mode.select(a.principal, 'dev');
    f.fetcher.mockImplementation(async () => sse(textFrame('Diagnostic reply.')));
    await Promise.all([execute(f, ids, a.principal), say('first', 'Speech original')]);
    const firstTwo = [wire(f), wire(f, 1)];
    expect(firstTwo.flatMap(body => body.messages.filter(message => message.role === 'user')
      .map(message => message.content)).filter(text => text.startsWith('[Current mode: Dev]\n'))).toHaveLength(1);
    expect(firstTwo.every(body => body.tools === undefined
      && body.messages.some(message => message.role === 'system'
        && message.content.includes('Server-selected mode: Dev.')))).toBe(true);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(web.effects.web).toBe(0);
    await say('first', 'Speech original'); // duplicate final STT event
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    a.mode.setEnabled(false);
    await say('second', 'Speech after disable'); // same live binding
    expect(JSON.stringify(wire(f, 2))).not.toMatch(/Current mode:|Server-selected mode:/);
    expect(wire(f, 2).tools).toBeDefined();
    expect(JSON.stringify([sinkEvents, spoken])).not.toMatch(/Current mode:|Server-selected mode:/);
    await f.runtime.drain(5000);
    const copy = await f.p.messages.list(f.identity.userId, context.response.conversationId!,
      { cursor: null, limit: 10 });
    const user = copy.items.find(message => message.role === 'user');
    expect(user?.voiceTranscripts?.[0]?.content ?? user?.content).toBe('Speech original');
    expect(JSON.stringify(copy)).not.toMatch(/Current mode:|Server-selected mode:/);
  } finally { await f.dispose(); }
});

it('does not render or speak a Dev voice artifact envelope', async () => {
  const a = authority(); a.mode.setEnabled(true); a.mode.select(a.principal, 'dev');
  const { f, bridge, context, sinkEvents, spoken } = await voiceFixture(a);
  try {
    f.fetcher.mockResolvedValueOnce(sse(textFrame(
      'Allowed prose.\n<aurvin-canvas type="flowchart" title="Workflow">\nflowchart TD\nStart --> Stop\n</aurvin-canvas>',
    )));
    await bridge.finalized(context, { providerSocketEpoch: 1, providerTurnId: 'no-visual', text: 'Explain this' },
      new AbortController().signal);
    expect(spoken.join('')).toBe('Allowed prose.');
    expect(sinkEvents.some(event => event.type.startsWith('canvas.'))).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await f.runtime.drain(5000);
    const messages = await f.p.messages.list(f.identity.userId, context.response.conversationId!,
      { cursor: null, limit: 10 });
    expect(JSON.stringify(messages)).not.toMatch(/aurvin-canvas|canvasArtifacts|Start --> Stop/);
  } finally { await f.dispose(); }
});

it('emits bound web frames through the shared voice loop without speaking activity', async () => {
  const { f, web, bridge, context, sinkEvents, spoken } = await voiceFixture();
  try {
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'voice_web')))
      .mockResolvedValueOnce(sse(textFrame('Verified voice answer.')));
    await bridge.finalized(context, {
      providerSocketEpoch: 1, providerTurnId: 'p-1', text: 'Search the latest news',
    }, new AbortController().signal);

    expect(web.effects.web).toBe(1);
    const frames = sinkEvents.filter((event): event is Extract<VoiceServerPayload,
      { type: 'web.frame' }> => event.type === 'web.frame');
    expect(frames.length).toBeGreaterThan(0);
    const sources = frames.filter(frame => frame.event.type === 'web-sources');
    expect(sources).toHaveLength(1);
    const assistant = f.runtime.memoryMessages(f.identity.userId,
      context.response.conversationId!, { cursor: null, limit: 10 })?.items
      .find(message => message.role === 'assistant');
    expect(assistant?.webSources?.[0]).toMatchObject({ toolCallId: 'voice_web', provider: 'exa' });
    for (const frame of frames) {
      expect(frame.turnId).toBe(assistant?.turnId);
      expect(frame.attemptId).toBeDefined();
      expect(frame.responseId).toBe(key('voice-response', f.identity.userId,
        context.response.conversationId!, frame.attemptId));
    }
    expect(spoken.join('')).not.toContain('searching');
    expect(spoken.join('')).not.toContain('reading');
  } finally { await f.dispose(); }
});

it('drops invalid, binding-mismatched, and stale-epoch frames', async () => {
  const { f, bridge, context, sinkEvents } = await voiceFixture();
  try {
    const original = f.runtime.executeTurn.bind(f.runtime);
    let captured: Parameters<typeof f.runtime.executeTurn>[0] | null = null;
    vi.spyOn(f.runtime, 'executeTurn').mockImplementation(async input => {
      captured = input;
      const envelope = (event: unknown, overrides: Record<string, unknown> = {}): StreamEnvelope => ({
        protocolVersion: 1, sessionId: input.sessionId, turnId: input.turnId,
        attemptId: input.attemptId, sequence: 0, event, ...overrides,
      }) as StreamEnvelope;
      await input.emit(envelope({ type: 'web-activity', activity: {
        toolCallId: 'invalid', mode: 'browse', phase: 'completed', provider: null, code: null,
      } }));
      await input.emit(envelope({ type: 'web-sources', sources: [source('rejected_binding', 'invalid')] },
        { turnId: 'other-turn' }));
      const epoch = context.response.connectionEpoch;
      context.response.connectionEpoch = epoch + 1;
      await input.emit(envelope({ type: 'web-sources', sources: [source('rejected_epoch', 'invalid')] }));
      context.response.connectionEpoch = epoch;
      return original(input);
    });
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'voice_ok')))
      .mockResolvedValueOnce(sse(textFrame('Verified.')));
    await bridge.finalized(context, {
      providerSocketEpoch: 1, providerTurnId: 'p-2', text: 'Search the news',
    }, new AbortController().signal);

    const frames = sinkEvents.filter((event): event is Extract<VoiceServerPayload,
      { type: 'web.frame' }> => event.type === 'web.frame');
    expect(frames.some(frame => frame.event.type === 'web-sources'
      && frame.event.sources.some(entry => entry.sourceId === 'rejected_binding'))).toBe(false);
    expect(frames.some(frame => frame.event.type === 'web-sources'
      && frame.event.sources.some(entry => entry.sourceId === 'rejected_epoch'))).toBe(false);
    expect(frames.some(frame => frame.event.type === 'web-sources'
      && frame.event.sources.some(entry => entry.toolCallId === 'voice_ok'))).toBe(true);

    const before = sinkEvents.length;
    await bridge.disconnected(context);
    await captured!.emit({
      protocolVersion: 1, sessionId: captured!.sessionId, turnId: captured!.turnId,
      attemptId: captured!.attemptId, sequence: 1,
      event: { type: 'web-sources', sources: [source('closed_late', 'closed')] },
    } as StreamEnvelope);
    expect(sinkEvents.filter(event => event.type === 'web.frame')).toHaveLength(
      sinkEvents.slice(0, before).filter(event => event.type === 'web.frame').length);
  } finally { await f.dispose(); }
});

it('aborts a held retrieval on barge-in and never publishes a late source', async () => {
  const { f, web, bridge, context, sinkEvents } = await voiceFixture();
  try {
    const hold = web.holdResult();
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'voice_late')))
      .mockResolvedValueOnce(sse(textFrame('A fallback answer.')));
    const running = bridge.finalized(context, {
      providerSocketEpoch: 1, providerTurnId: 'p-3', text: 'Search the news',
    }, new AbortController().signal);
    await hold.entered;
    const current = bridge.currentResponse();
    expect(current).not.toBeNull();
    const interruption = bridge.interrupt(context, current!);
    hold.release();
    await interruption;
    await running.catch(() => undefined);
    expect(sinkEvents.some(event => event.type === 'response.cancelled')).toBe(true);
    expect(sinkEvents.some(event => event.type === 'web.frame'
      && event.event.type === 'web-sources')).toBe(false);
    expect(web.effects.web).toBe(1);
  } finally { await f.dispose(); }
});
