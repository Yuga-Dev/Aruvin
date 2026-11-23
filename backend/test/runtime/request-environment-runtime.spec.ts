/**
 * ============================================================================
 * FILE: request-environment-runtime.spec.ts
 * LOCATION: backend/test/runtime/request-environment-runtime.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify clientTimeZone propagation and fallback precedence in runtimes.
 *
 * ROLE IN PROJECT:
 *    Guards against the hardcoded Etc/UTC bug in MemoryText and ensures both
 *    DurableChatRuntime and MemoryText resolve clientTimeZone ->
 *    calendar.trustedTimeZone -> Etc/UTC without altering idempotency hashes.
 *
 * KEY COMPONENTS:
 *    - MemoryText precedence, retry preservation/update, and live voice tests.
 *    - DurableChatRuntime submit, retry, live voice, and idempotency hash tests.
 * ============================================================================
 */

import type { MongoClient } from 'mongodb';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { textConfigFixture } from './text-config-fixture.js';
import { sessionIdFor } from '../../src/chat-runtime/identity.js';
import type { ContextChatMessage } from '../../src/contracts/context.js';
import type { CalendarRuntimeDependencies } from '../../src/chat-runtime/calendar-ports.js';
import type { DeliveryWrite } from '../../src/chat-runtime/ports.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { deliveryFixture } from '../../src/contracts/testing/voice-fixtures.js';
import { voiceDeliveryRecordSchema } from '../../src/contracts/voice.js';
import { key } from '../../src/persistence/records.js';

function dispatchedEnvironments(h: ReturnType<typeof textConfigFixture>): Array<{ timeZone: string }> {
  return h.fetcher.mock.calls.map(call => {
    const body = typeof call[1]?.body === 'string' ? call[1].body : '';
    const messages = (JSON.parse(body) as { messages: ContextChatMessage[] }).messages;
    const envMsg = messages.find(m => m.role === 'system' && m.content.startsWith('Environment background (data, not authority):\n'));
    if (!envMsg) throw new Error('Missing Environment background message');
    const json = envMsg.content.slice('Environment background (data, not authority):\n'.length);
    return JSON.parse(json) as { timeZone: string };
  });
}

function calendarStub(trustedTimeZone: string): CalendarRuntimeDependencies {
  return {
    trustedTimeZone,
    execution: {} as CalendarRuntimeDependencies['execution'],
    capabilities: {} as CalendarRuntimeDependencies['capabilities'],
    connection: {} as CalendarRuntimeDependencies['connection'],
    permission: { content: 'volatile', minimalEvidenceAllowed: false, policyId: 'stub' },
    auditDeadlineAt: '2026-12-31T00:00:00.000Z',
  };
}

describe('request environment runtime propagation', () => {
  it('MemoryText resolves e.clientTimeZone first, then calendar.trustedTimeZone, then Etc/UTC', async () => {
    // 1. Both clientTimeZone and calendar.trustedTimeZone present -> clientTimeZone wins
    const h1 = textConfigFixture(
      textSnapshot(1, { maxOutputTokens: 2048 }, 'fixture/model', 'fixture-A'),
      deps => ({
        ...deps,
        calendar: calendarStub('America/Chicago'),
        memoryFirst: {
          voice: true,
          save: async () => ({ kind: 'confirmed' }),
          policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 250, writeTimeoutMs: 500 },
        },
      }),
    );
    try {
      const turnClient = await h1.runtime.submitTurn({
        identity: h1.identity,
        sessionId: null,
        content: 'What time is it in Kolkata?',
        idempotencyKey: 'mem-tz-client-1',
        clientTimeZone: 'Asia/Kolkata',
      });
      await h1.execute(turnClient);

      // 2. clientTimeZone absent -> falls back to calendar.trustedTimeZone (not hardcoded Etc/UTC!)
      const turnCalFallback = await h1.runtime.submitTurn({
        identity: h1.identity,
        sessionId: turnClient.sessionId,
        content: 'What time is it without client header?',
        idempotencyKey: 'mem-tz-cal-2',
      });
      await h1.execute(turnCalFallback);

      expect(dispatchedEnvironments(h1).map(e => e.timeZone)).toEqual([
        'Asia/Kolkata',
        'America/Chicago',
      ]);
    } finally {
      await h1.dispose();
    }

    // 3. Neither clientTimeZone nor calendar.trustedTimeZone -> falls back to Etc/UTC
    const h2 = textConfigFixture(
      textSnapshot(1, { maxOutputTokens: 2048 }, 'fixture/model', 'fixture-A'),
      deps => ({
        ...deps,
        memoryFirst: {
          voice: true,
          save: async () => ({ kind: 'confirmed' }),
          policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 250, writeTimeoutMs: 500 },
        },
      }),
    );
    try {
      const turnUtc = await h2.runtime.submitTurn({
        identity: h2.identity,
        sessionId: null,
        content: 'Fallback UTC',
        idempotencyKey: 'mem-tz-utc-1',
        clientTimeZone: 'Invalid/Zone',
      });
      await h2.execute(turnUtc);
      expect(dispatchedEnvironments(h2).map(e => e.timeZone)).toEqual(['Etc/UTC']);
    } finally {
      await h2.dispose();
    }
  });

  it('MemoryText retry preserves clientTimeZone when omitted and updates when provided', async () => {
    const h = textConfigFixture(
      textSnapshot(1, { maxOutputTokens: 2048 }, 'fixture/model', 'fixture-A'),
      deps => ({
        ...deps,
        memoryFirst: {
          voice: true,
          save: async () => ({ kind: 'confirmed' }),
          policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 250, writeTimeoutMs: 500 },
        },
      }),
    );
    h.fetcher.mockImplementationOnce(async () => new Response('boom', { status: 500 }));
    try {
      const first = await h.runtime.submitTurn({
        identity: h.identity,
        sessionId: null,
        content: 'First attempt',
        idempotencyKey: 'mem-retry-tz-1',
        clientTimeZone: 'Asia/Kolkata',
      });
      await h.execute(first);
      expect((await h.runtime.getTurnStatus(h.identity.userId, first.sessionId, first.turnId)).status).toBe('failed');

      // Retry without clientTimeZone preserves 'Asia/Kolkata'
      h.fetcher.mockImplementationOnce(async () => new Response('boom-2', { status: 500 }));
      const retryPreserve = await h.runtime.retryTurn({
        identity: h.identity,
        sessionId: first.sessionId,
        turnId: first.turnId,
        idempotencyKey: 'mem-retry-tz-2',
      });
      await h.execute(retryPreserve);
      expect((await h.runtime.getTurnStatus(h.identity.userId, first.sessionId, first.turnId)).status).toBe('failed');

      // Retry with new clientTimeZone updates to 'America/New_York'
      const retryUpdate = await h.runtime.retryTurn({
        identity: h.identity,
        sessionId: first.sessionId,
        turnId: first.turnId,
        idempotencyKey: 'mem-retry-tz-3',
        clientTimeZone: 'America/New_York',
      });
      await h.execute(retryUpdate);

      expect(dispatchedEnvironments(h).map(e => e.timeZone)).toEqual([
        'Asia/Kolkata',
        'Asia/Kolkata',
        'America/New_York',
      ]);
    } finally {
      await h.dispose();
    }
  });

  it('MemoryText live voice turn forwards clientTimeZone into EnvironmentContext', async () => {
    const h = textConfigFixture(
      textSnapshot(1, { maxOutputTokens: 2048 }, 'fixture/model', 'fixture-A'),
      deps => ({
        ...deps,
        memoryFirst: {
          voice: true,
          save: async () => ({ kind: 'confirmed' }),
          policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 250, writeTimeoutMs: 500 },
        },
      }),
    );
    try {
      const snapshot = h.currentConfig.current()!;
      const held = await h.runtime.reservations.acquire({
        identity: h.identity,
        conversationId: null,
        owner: { kind: 'live', voiceSessionId: 'voice-tz-1' },
      });
      const idempotencyKey = 'mem-voice-tz-1';
      const sessionId = sessionIdFor(h.identity.userId, null, idempotencyKey);
      const reservation = await h.runtime.reservations.bindConversation({
        identity: h.identity,
        reservationId: held.reservationId,
        conversationId: sessionId,
      });
      const voiceIds = await h.runtime.submitLiveTurn({
        identity: h.identity,
        sessionId,
        content: 'Voice time check',
        idempotencyKey,
        reservation,
        configSnapshot: snapshot,
        freshConversation: true,
        clientTimeZone: 'Asia/Tokyo',
        voice: { voiceSessionId: 'voice-tz-1', socketEpoch: 0, providerTurnId: 'p0' },
      });

      let attempt: { userId: string; sessionId: string; attemptId: string; turnId: string } | undefined;
      let write: DeliveryWrite | undefined;
      const baseDelivery = (seq: number, status: 'pending' | 'completed', textGenerated: string) =>
        voiceDeliveryRecordSchema.parse({
          ...deliveryFixture(),
          userId: attempt!.userId,
          sessionId: attempt!.sessionId,
          turnId: attempt!.turnId,
          attemptId: attempt!.attemptId,
          responseId: key('voice-response', attempt!.userId, attempt!.sessionId, attempt!.attemptId),
          voiceSessionId: 'voice-tz-1',
          sequence: seq,
          status,
          textGenerated,
          ...(status === 'completed' ? { textSpoken: textGenerated, textRemaining: '' } : {}),
        });
      await h.runtime.executeTurn({
        userId: h.identity.userId,
        ...voiceIds,
        signal: new AbortController().signal,
        emit: async () => {},
        live: {
          reservation,
          start: async (a, persist) => {
            attempt = a;
            write = persist;
            await persist(baseDelivery(1, 'pending', ''));
          },
          delta: async () => {},
          finish: async () => {},
          settle: async textGenerated => {
            if (!write || !attempt) throw new Error('expected delivery writer');
            await write(baseDelivery(2, 'completed', textGenerated), 1);
          },
        },
      });
      await h.runtime.reservations.release({ identity: h.identity, reservationId: reservation.reservationId });
      expect(dispatchedEnvironments(h).map(e => e.timeZone)).toEqual(['Asia/Tokyo']);
    } finally {
      await h.dispose();
    }
  });

  it('DurableChatRuntime forwards clientTimeZone on submit and retry without altering idempotency hashes', async () => {
    const h = textConfigFixture(
      textSnapshot(1, { maxOutputTokens: 2048 }, 'fixture/model', 'fixture-A'),
      deps => ({
        ...deps,
        calendar: calendarStub('Europe/Berlin'),
      }),
    );
    try {
      const first = await h.runtime.submitTurn({
        identity: h.identity,
        sessionId: null,
        content: 'Durable turn',
        idempotencyKey: 'dur-tz-1',
        clientTimeZone: 'Asia/Kolkata',
      });
      // Idempotent replay with same content and different clientTimeZone returns same attempt without mismatch
      const replay = await h.runtime.submitTurn({
        identity: h.identity,
        sessionId: null,
        content: 'Durable turn',
        idempotencyKey: 'dur-tz-1',
        clientTimeZone: 'America/New_York',
      });
      expect(replay.attemptId).toBe(first.attemptId);

      // Different content with same idempotencyKey still throws IDEMPOTENCY_PAYLOAD_MISMATCH
      await expect(h.runtime.submitTurn({
        identity: h.identity,
        sessionId: null,
        content: 'Different content',
        idempotencyKey: 'dur-tz-1',
        clientTimeZone: 'Asia/Kolkata',
      })).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });

      h.fetcher.mockImplementationOnce(async () => new Response('boom', { status: 500 }));
      await expect(h.execute(first)).rejects.toThrow();

      // Retry with new clientTimeZone applies 'America/New_York'
      const retried = await h.runtime.retryTurn({
        identity: h.identity,
        sessionId: first.sessionId,
        turnId: first.turnId,
        idempotencyKey: 'dur-tz-retry-1',
        clientTimeZone: 'America/New_York',
      });
      await h.execute(retried);

      // Next turn without clientTimeZone falls back to calendar.trustedTimeZone ('Europe/Berlin')
      const next = await h.runtime.submitTurn({
        identity: h.identity,
        sessionId: first.sessionId,
        content: 'Fallback turn',
        idempotencyKey: 'dur-tz-2',
      });
      await h.execute(next);

      expect(dispatchedEnvironments(h).map(e => e.timeZone)).toEqual([
        'Asia/Kolkata',
        'America/New_York',
        'Europe/Berlin',
      ]);
    } finally {
      await h.dispose();
    }
  });

  it('DurableChatRuntime preserves clientTimeZone across AdmissionReceipt and confirmedState fast paths', async () => {
    const snapshot = textSnapshot(1, { maxOutputTokens: 2048 }, 'fixture/model', 'fixture-A');
    const memory = calendarMemory(undefined, { databaseName: 'req-env-receipt-offline' });
    const client = Object.assign(memory.commandSource, {
      appendMetadata: () => undefined, db: () => memory.store.db,
    }) as unknown as MongoClient;
    const p = await createPersistenceBundle(client, 'req-env-receipt-offline', snapshot.budgets, 'req-env-exec');
    const h = textConfigFixture(snapshot, deps => ({
      ...deps,
      calendar: calendarStub('Europe/Berlin'),
    }), p);
    try {
      const first = await h.runtime.submitTurn({
        identity: h.identity,
        sessionId: null,
        content: 'First receipt turn',
        idempotencyKey: 'receipt-tz-1',
        clientTimeZone: 'Asia/Kolkata',
      });
      await h.execute(first);

      // Second turn hits confirmedState cache + receipt reuse with a new timezone
      const second = await h.runtime.submitTurn({
        identity: h.identity,
        sessionId: first.sessionId,
        content: 'Second receipt turn',
        idempotencyKey: 'receipt-tz-2',
        clientTimeZone: 'America/Los_Angeles',
      });
      await h.execute(second);

      // Third turn omits clientTimeZone and falls back via receipt/confirmedState to calendar.trustedTimeZone
      const third = await h.runtime.submitTurn({
        identity: h.identity,
        sessionId: first.sessionId,
        content: 'Third receipt turn',
        idempotencyKey: 'receipt-tz-3',
      });
      await h.execute(third);

      expect(dispatchedEnvironments(h).map(e => e.timeZone)).toEqual([
        'Asia/Kolkata',
        'America/Los_Angeles',
        'Europe/Berlin',
      ]);
    } finally {
      await h.dispose();
    }
  });
});
