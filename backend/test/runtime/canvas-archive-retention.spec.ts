/**
 * ============================================================================
 * FILE: canvas-archive-retention.spec.ts
 * LOCATION: backend/test/runtime/canvas-archive-retention.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify compaction keeps pre-summary Canvases available to the transcript
 *    projection, voice Canvas navigation, and cold hydration.
 *
 * ROLE IN PROJECT:
 *    Exercises the real MemoryText promotion/cold-walk paths with deterministic
 *    live voice fixtures and no provider or native-database prerequisites.
 *
 * KEY COMPONENTS:
 *    - Forced compaction over a real seeded mermaid Canvas turn.
 *    - Native Canvas navigation after the compacted record leaves the manifest.
 *    - Cold restart hydration of the same Canvas inventory.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import { calendarLiveFixture } from './calendar-live.fixture.js';
import { calendarFixture, loadWire, skillWire, textWire } from './calendar-runtime.fixture.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import type { LiveExecution } from '../../src/chat-runtime/ports.js';
import type { MessageRecord } from '../../src/contracts/message.js';
import { deliveryFixture } from '../../src/contracts/testing/voice-fixtures.js';
import { voiceDeliveryRecordSchema, type VoiceDeliveryRecord } from '../../src/contracts/voice.js';
import { key } from '../../src/persistence/records.js';

const SUMMARY = `<analysis>scratch</analysis>\n<summary>\n${
  COMPACTION_SECTIONS.map((heading, index) => `## ${index + 1}. ${heading}\nCondensed history.`).join('\n\n')
}\n</summary>`;

it('keeps a compacted diagram Canvas authorizable for voice navigation and cold hydration', async () => {
  const f = await calendarLiveFixture('memory');
  const runtime = () => f.h.runtime;
  const memory = () => runtime().memoryFor(f.h.identity.userId)!;
  try {
    f.h.modelWires.push(textWire('Pricing summary.\n\n```mermaid title="Pricing comparison"\n'
      + 'flowchart TD\nA --> B\n```'));
    const seed = await f.submit('Draw the pricing comparison.');
    await f.execute(seed);
    for (let i = 0; i < 3; i++) {
      f.h.modelWires.push(textWire(`Filler answer ${i}.`));
      const turn = await f.submit(`Filler question ${i} ${'x'.repeat(120)}.`);
      await f.execute(turn);
    }
    const assistant = memory().foundation.history(f.sessionId)
      .find(record => record.role === 'assistant' && record.turnId === seed.turnId)!;
    const target = `${assistant.messageId}::canvas::0`;
    expect(assistant.canvasArtifacts?.[0]).toMatchObject({ kind: 'mermaid' });

    f.h.modelWires.push(textWire(SUMMARY));
    const cold = (memory() as unknown as { sessions: Map<string, { compaction?: { pending: unknown } }> })
      .sessions.get(f.sessionId)!;
    (memory() as unknown as { scheduleCompactionIfNeeded: (sessionId: string, snapshot: unknown, force: boolean) => void })
      .scheduleCompactionIfNeeded(f.sessionId, f.h.currentConfig.current()!, true);
    await vi.waitFor(() => {
      expect(memory().foundation.summary(f.sessionId)).not.toBeNull();
      expect(cold.compaction?.pending ?? null).toBeNull();
    }, { timeout: 5000 });

    const archived = runtime().memoryMessages(f.h.identity.userId, f.sessionId, { cursor: null, limit: 20 })!;
    expect(archived.items.some(message => message.messageId === assistant.messageId)).toBe(false);
    expect(archived.canvasMessages?.find(message => message.messageId === assistant.messageId))
      .toMatchObject({ messageId: assistant.messageId, canvasArtifacts: assistant.canvasArtifacts });

    const show = vi.fn(() => true);
    const canvas: NonNullable<LiveExecution['canvas']> = {
      inventory: () => ({ items: [{ canvasId: target, title: 'Pricing comparison',
        owner: { kind: 'message', id: assistant.messageId } }], omitted: 0 }),
      active: () => true,
      show: (canvasId: string) => show(canvasId),
    };
    const navigationWire = skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-compacted-1');
    f.h.modelWires.push(navigationWire);
    const navigation = await f.submit('Show the old pricing comparison.');
    await f.execute(navigation, undefined, canvas);
    expect(show).toHaveBeenCalledExactlyOnceWith(target);
    const pair = memory().foundation.result(memory().find(navigation.sessionId, navigation.turnId)!.turn)!.calendar!;
    expect(pair.results[0]?.resultRef.content).toBe(JSON.stringify({
      kind: 'canvas-control', outcome: 'requested', action: 'open', canvas_id: target,
    }));

    await f.h.restart();
    await f.h.runtime.prepareSession(f.h.identity.userId, f.sessionId);
    const restored = f.h.runtime.memoryMessages(f.h.identity.userId, f.sessionId, { cursor: null, limit: 20 })!;
    expect(restored.items.some(message => message.messageId === assistant.messageId)).toBe(false);
    expect(restored.canvasMessages?.find(message => message.messageId === assistant.messageId))
      .toMatchObject({ messageId: assistant.messageId, canvasArtifacts: assistant.canvasArtifacts });
  } finally {
    f.h.modelWires.length = 0;
    await f.h.dispose();
  }
}, 20_000);

it('keeps unsaved compacted turns in entries for status/retrySave and preserves durable tail turns when results are evicted', async () => {
  let allowSave = false;
  const db = calendarMemory();
  const client = Object.assign(db.commandSource, { db: () => db.store.db, appendMetadata: () => undefined }) as unknown as MongoClient;
  const persistence = await createPersistenceBundle(client, 'offline-canvas-retry-unit', DEFAULT_BUDGETS, 'offline-canvas-retry-executor');
  const h = calendarFixture(undefined, persistence, {
    policy: { ...PROPOSED_MEMORY_TEXT_POLICY, maxAttempts: 2, retryBackoffMs: 1, shutdownDrainMs: 50 },
    save: async envelope => allowSave
      ? { kind: 'saved', epoch: envelope.epoch, sessionId: envelope.sessionId,
          version: envelope.version, fence: envelope.fence }
      : { kind: 'failed', retryable: true },
  });
  await h.ready;
  const memory = () => h.runtime.memoryFor(h.identity.userId)!;
  try {
    h.modelWires.push(textWire('Seed answer.'));
    const seed = await h.submit('Seed question.');
    await h.execute(seed);
    await vi.waitFor(() => {
      expect(memory().status(h.identity.userId, seed.sessionId, seed.turnId)?.save?.state).toBe('failed');
    }, { timeout: 5000 });

    const tailTurns: Awaited<ReturnType<typeof h.submit>>[] = [];
    for (let i = 0; i < 3; i++) {
      h.modelWires.push(textWire(`Filler answer ${i}.`));
      const turn = await h.submit(`Filler question ${i} ${'x'.repeat(120)}.`, seed.sessionId);
      await h.execute(turn);
      tailTurns.push(turn);
    }

    h.modelWires.push(textWire(SUMMARY));
    const cold = (memory() as unknown as { sessions: Map<string, { compaction?: { pending: unknown } }> })
      .sessions.get(seed.sessionId)!;
    (memory() as unknown as { scheduleCompactionIfNeeded: (sessionId: string, snapshot: unknown, force: boolean) => void })
      .scheduleCompactionIfNeeded(seed.sessionId, h.currentConfig.current()!, true);
    await vi.waitFor(() => {
      expect(memory().foundation.summary(seed.sessionId)).not.toBeNull();
      expect(cold.compaction?.pending ?? null).toBeNull();
    }, { timeout: 5000 });

    const failedStatus = memory().status(h.identity.userId, seed.sessionId, seed.turnId);
    expect(failedStatus?.save?.state).toBe('failed');
    allowSave = true;
    h.advance(10);
    await h.runtime.retrySave(h.identity.userId, seed.sessionId, seed.turnId, failedStatus!.save!);
    await memory().foundation.flushSession(seed.sessionId);
    expect(memory().status(h.identity.userId, seed.sessionId, seed.turnId)?.save?.state).toBe('saved');

    // Simulate MemoryFirstFoundation.evictSettledForCapacity: drop an older
    // compacted turn's request/result handles and a durable tail turn's result.
    const foundationSession = (memory().foundation as unknown as {
      sessions: Map<string, { requests: Map<string, unknown>; results: Map<string, unknown> }>;
    }).sessions.get(seed.sessionId)!;
    const compactedTurn = memory().find(seed.sessionId, seed.turnId)!.turn;
    foundationSession.requests.delete(compactedTurn.requestKey);
    foundationSession.results.delete(compactedTurn.requestKey);
    const preservedTail = tailTurns.at(-1)!;
    const preservedTailTurn = memory().find(seed.sessionId, preservedTail.turnId)!.turn;
    foundationSession.results.delete(preservedTailTurn.requestKey);

    h.modelWires.push(textWire('One more answer.'));
    const extra = await h.submit(`Extra question ${'y'.repeat(120)}.`, seed.sessionId);
    await h.execute(extra);
    await memory().foundation.flushSession(seed.sessionId);

    h.modelWires.push(textWire(SUMMARY));
    (memory() as unknown as { scheduleCompactionIfNeeded: (sessionId: string, snapshot: unknown, force: boolean) => void })
      .scheduleCompactionIfNeeded(seed.sessionId, h.currentConfig.current()!, true);
    await vi.waitFor(() => {
      expect(memory().foundation.summary(seed.sessionId)?.compactionCycle).toBe(2);
      expect(cold.compaction?.pending ?? null).toBeNull();
    }, { timeout: 5000 });

    expect(memory().find(seed.sessionId, preservedTail.turnId)).not.toBeNull();
    expect(memory().activeTurn(h.identity.userId, seed.sessionId)).toBeNull();
    expect(memory().messages(h.identity.userId, seed.sessionId, { cursor: null, limit: 20 })?.items.length)
      .toBeGreaterThan(0);
  } finally {
    h.modelWires.length = 0;
    await h.dispose();
  }
}, 20_000);

it('redacts cold.canvasArchive when invalidateCalendarAccount runs', async () => {
  const f = await calendarLiveFixture('memory');
  const memory = () => f.h.runtime.memoryFor(f.h.identity.userId)!;
  try {
    f.h.modelWires.push(
      loadWire('calendar_list_events'),
      skillWire('call_tool', {
        plugin: 'google-calendar',
        tool: 'calendar_list_events',
        arguments: { timeMin: '2026-11-03T00:00:00Z', timeMax: '2026-11-04T00:00:00Z', maxResults: 20 },
      }, 'live-read'),
      textWire('No events in that range.'),
    );
    const calTurn = await f.submit('List my calendar for November 3.');
    await f.execute(calTurn);
    for (let i = 0; i < 3; i++) {
      f.h.modelWires.push(textWire(`Filler answer ${i}.`));
      const turn = await f.submit(`Filler question ${i} ${'x'.repeat(120)}.`);
      await f.execute(turn);
    }

    f.h.modelWires.push(textWire(SUMMARY));
    const cold = (memory() as unknown as {
      sessions: Map<string, { canvasArchive?: MessageRecord[]; compaction?: { pending: unknown } }>;
    }).sessions.get(f.sessionId)!;
    (memory() as unknown as { scheduleCompactionIfNeeded: (sessionId: string, snapshot: unknown, force: boolean) => void })
      .scheduleCompactionIfNeeded(f.sessionId, f.h.currentConfig.current()!, true);
    await vi.waitFor(() => {
      expect(memory().foundation.summary(f.sessionId)).not.toBeNull();
      expect(cold.compaction?.pending ?? null).toBeNull();
    }, { timeout: 5000 });

    const before = cold.canvasArchive?.find(record => record.turnId === calTurn.turnId);
    expect(before?.sourceProvenance?.[0]?.redactedAt).toBeNull();

    const account = await f.h.runtime.d.calendar!.connection.currentAccount();
    memory().invalidateCalendarAccount(account, 'disconnected');

    const after = cold.canvasArchive?.find(record => record.turnId === calTurn.turnId);
    expect(after?.sourceProvenance?.[0]?.redactedAt).not.toBeNull();
    if (after?.sourceProvenance?.[0]?.schemaVersion === 2) {
      expect(after.sourceProvenance[0].targets.every(target => target.calendarLabel === null)).toBe(true);
    }
  } finally {
    f.h.modelWires.length = 0;
    await f.h.dispose();
  }
}, 20_000);

it('executes control_canvas open on a compacted Canvas after cold restart and hydration', async () => {
  const f = await calendarLiveFixture('memory');
  const memory = () => f.h.runtime.memoryFor(f.h.identity.userId)!;
  try {
    f.h.modelWires.push(textWire('Pricing summary.\n\n```mermaid title="Pricing comparison"\n'
      + 'flowchart TD\nA --> B\n```'));
    const seed = await f.submit('Draw the pricing comparison.');
    await f.execute(seed);
    for (let i = 0; i < 3; i++) {
      f.h.modelWires.push(textWire(`Filler answer ${i}.`));
      const turn = await f.submit(`Filler question ${i} ${'x'.repeat(120)}.`);
      await f.execute(turn);
    }
    const assistant = memory().foundation.history(f.sessionId)
      .find(record => record.role === 'assistant' && record.turnId === seed.turnId)!;
    const target = `${assistant.messageId}::canvas::0`;

    f.h.modelWires.push(textWire(SUMMARY));
    const cold = (memory() as unknown as { sessions: Map<string, { compaction?: { pending: unknown } }> })
      .sessions.get(f.sessionId)!;
    (memory() as unknown as { scheduleCompactionIfNeeded: (sessionId: string, snapshot: unknown, force: boolean) => void })
      .scheduleCompactionIfNeeded(f.sessionId, f.h.currentConfig.current()!, true);
    await vi.waitFor(() => {
      expect(memory().foundation.summary(f.sessionId)).not.toBeNull();
      expect(cold.compaction?.pending ?? null).toBeNull();
    }, { timeout: 5000 });

    await f.h.restart();
    await f.h.runtime.prepareSession(f.h.identity.userId, f.sessionId);

    const voiceSessionId = 'calendar-voice-unit-restarted';
    const reservation = await f.h.runtime.reservations.acquire({
      identity: f.h.identity,
      conversationId: f.sessionId,
      owner: { kind: 'live', voiceSessionId },
    });
    const show = vi.fn(() => true);
    const canvas: NonNullable<LiveExecution['canvas']> = {
      inventory: () => ({
        items: [{ canvasId: target, title: 'Pricing comparison', owner: { kind: 'message', id: assistant.messageId } }],
        omitted: 0,
      }),
      active: () => true,
      show: canvasId => show(canvasId),
    };
    f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-cold-restart-1'));
    const ids = await f.h.runtime.submitLiveTurn({
      identity: f.h.identity,
      sessionId: f.sessionId,
      content: 'Open the pricing comparison.',
      reservation,
      idempotencyKey: 'open-cold-restart-key-1',
      freshConversation: false,
      configSnapshot: f.h.currentConfig.current()!,
      voice: { voiceSessionId, socketEpoch: 1, providerTurnId: 'restart-input-1' },
    });
    let write!: (record: VoiceDeliveryRecord, expectedSequence?: number) => Promise<void>;
    let record!: VoiceDeliveryRecord;
    await f.h.runtime.executeTurn({
      userId: f.h.identity.userId,
      ...ids,
      signal: new AbortController().signal,
      emit: async () => undefined,
      emitCalendar: async () => undefined,
      live: {
        reservation,
        canvas,
        start: async (attempt, save) => {
          write = save;
          record = voiceDeliveryRecordSchema.parse({
            ...deliveryFixture(),
            userId: attempt.userId,
            sessionId: attempt.sessionId,
            turnId: attempt.turnId,
            attemptId: attempt.attemptId,
            voiceSessionId,
            responseId: key('voice-response', attempt.userId, attempt.sessionId, attempt.attemptId),
            status: 'pending',
            textGenerated: '',
            createdAt: attempt.createdAt,
            updatedAt: attempt.createdAt,
          });
          await write(record);
        },
        delta: async () => undefined,
        finish: async () => undefined,
        settle: async textGenerated => {
          const old = record.sequence;
          record = voiceDeliveryRecordSchema.parse({ ...record, sequence: old + 1, status: 'unknown', textGenerated });
          await write(record, old);
        },
      },
    });
    await f.h.runtime.reservations.release({ identity: f.h.identity, reservationId: reservation.reservationId });

    expect(show).toHaveBeenCalledExactlyOnceWith(target);
    const restartedMemory = memory();
    const pair = restartedMemory.foundation.result(restartedMemory.find(ids.sessionId, ids.turnId)!.turn)!.calendar!;
    expect(pair.results[0]?.resultRef.content).toBe(JSON.stringify({
      kind: 'canvas-control', outcome: 'requested', action: 'open', canvas_id: target,
    }));
  } finally {
    f.h.modelWires.length = 0;
    await f.h.dispose();
  }
}, 20_000);
