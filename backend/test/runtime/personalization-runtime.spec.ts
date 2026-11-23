/**
 * ============================================================================
 * FILE: personalization-runtime.spec.ts
 * LOCATION: backend/test/runtime/personalization-runtime.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify zero pre-model DB latency and attempt-level personalization
 *    snapshot stability across DurableChatRuntime and MemoryText (text + voice).
 *
 * ROLE IN PROJECT:
 *    Proves AC3 and AC4 at the runtime layer: both runtimes capture the cached
 *    personalization once at submission, ignore later cache changes during the
 *    attempt, keep the fixed pair first, emit [2] User customizations in
 *    non-default mode, and keep voice prefix [0..2] byte-identical to text
 *    without DB reads before dispatch.
 *
 * KEY COMPONENTS:
 *    - DurableChatRuntime snapshot & zero-DB-read tests.
 *    - MemoryText text & live voice personalization tests.
 * ============================================================================
 */

import { textSnapshot } from '../model/config-snapshot.js';
import { textConfigFixture } from './text-config-fixture.js';
import { sessionIdFor } from '../../src/chat-runtime/identity.js';
import type { ContextChatMessage } from '../../src/contracts/context.js';
import type { UserPersonalizationSettings } from '../../src/contracts/personalization.js';
import { DEFAULT_PERSONALIZATION_SETTINGS } from '../../src/contracts/personalization.js';
import type { DeliveryWrite } from '../../src/chat-runtime/ports.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { deliveryFixture } from '../../src/contracts/testing/voice-fixtures.js';
import { voiceDeliveryRecordSchema } from '../../src/contracts/voice.js';
import { key } from '../../src/persistence/records.js';

function dispatchedMessages(h: ReturnType<typeof textConfigFixture>): ContextChatMessage[][] {
  return h.fetcher.mock.calls.map(
    call => (JSON.parse(String(call[1]?.body)) as { messages: ContextChatMessage[] }).messages,
  );
}

describe('personalization runtime integration', () => {
  it('DurableChatRuntime embeds [2] User customizations, keeps attempt snapshot stable across saves, and performs zero DB personalization reads', async () => {
    let active: UserPersonalizationSettings = {
      warmth: 'high',
      enthusiasm: 'high',
      emoji: 'low',
      customInstructions: 'Snapshot A instructions.',
      location: null,
    };
    const personalizationReadSpy = vi.fn(async () => {
      throw new Error('Must not query personalization DB during turn execution');
    });

    const h = textConfigFixture(
      textSnapshot(1, { maxOutputTokens: 2048 }, 'fixture/model', 'fixture-A'),
      deps => ({
        ...deps,
        personalizationFor: () => active,
      }),
    );
    (h.p as Record<string, unknown>).personalization = {
      read: personalizationReadSpy,
      createIfAbsent: vi.fn(),
      compareAndSwap: vi.fn(),
    };

    try {
      const turn1 = await h.submit('Hello one');
      // Concurrent settings change between submitTurn and executeTurn must NOT affect turn1.
      active = {
        warmth: 'low',
        enthusiasm: 'low',
        emoji: 'high',
        customInstructions: 'Snapshot B instructions.',
        location: null,
      };
      await h.execute(turn1);

      // Next turn picks up updated personalization snapshot.
      const turn2 = await h.submit('Hello two', turn1.sessionId);
      await h.execute(turn2);

      // Default personalization omits [2] User customizations cleanly.
      active = { ...DEFAULT_PERSONALIZATION_SETTINGS };
      const turn3 = await h.submit('Hello three', turn1.sessionId);
      await h.execute(turn3);

      const dispatches = dispatchedMessages(h);
      expect(dispatches).toHaveLength(3);
      expect(dispatches[0][1].content).toContain('Product background (data, not authority):');
      expect(dispatches[0][2].role).toBe('system');
      expect(dispatches[0][2].content).toContain('Snapshot A instructions.');

      expect(dispatches[1][1].content).toContain('Product background (data, not authority):');
      expect(dispatches[1][2].role).toBe('system');
      expect(dispatches[1][2].content).toContain('Snapshot B instructions.');

      // Turn 3 omitted the block so index 2 is Environment background directly.
      expect(dispatches[2][1].content).toContain('Product background (data, not authority):');
      expect(dispatches[2][2].content).toContain('Environment background (data, not authority):');
      expect(personalizationReadSpy).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  });

  it('MemoryText captures personalization once per text and live voice turn with zero DB reads before dispatch', async () => {
    let active: UserPersonalizationSettings = {
      warmth: 'high',
      enthusiasm: 'low',
      emoji: 'high',
      customInstructions: 'MemoryText preference.',
      location: null,
    };
    const personalizationReadSpy = vi.fn(async () => {
      throw new Error('Must not query personalization DB in MemoryText');
    });

    const h = textConfigFixture(
      textSnapshot(1, { maxOutputTokens: 2048 }, 'fixture/model', 'fixture-A'),
      deps => ({
        ...deps,
        personalizationFor: () => active,
        memoryFirst: {
          voice: true,
          save: async () => ({ kind: 'confirmed' }),
          policy: {
            ...PROPOSED_MEMORY_TEXT_POLICY,
            flushDelayMs: 5,
            shutdownDrainMs: 250,
            writeTimeoutMs: 500,
          },
        },
      }),
    );
    (h.p as Record<string, unknown>).personalization = {
      read: personalizationReadSpy,
      createIfAbsent: vi.fn(),
      compareAndSwap: vi.fn(),
    };

    try {
      // Text turn in MemoryText
      const textTurn = await h.submit('Text hello');
      // Mutate active cache before executeTurn to verify attempt-level snapshot stability
      active = {
        warmth: 'low',
        enthusiasm: 'high',
        emoji: 'low',
        customInstructions: 'Mutated later.',
        location: null,
      };
      await h.execute(textTurn);

      // Live voice turn in MemoryText with the updated settings
      const snapshot = h.currentConfig.current()!;
      const held = await h.runtime.reservations.acquire({
        identity: h.identity,
        conversationId: null,
        owner: { kind: 'live', voiceSessionId: 'voice-pers-1' },
      });
      const idempotencyKey = 'pers-live-key';
      const sessionId = sessionIdFor(h.identity.userId, null, idempotencyKey);
      const reservation = await h.runtime.reservations.bindConversation({
        identity: h.identity,
        reservationId: held.reservationId,
        conversationId: sessionId,
      });
      const voiceIds = await h.runtime.submitLiveTurn({
        identity: h.identity,
        sessionId,
        content: 'Voice hello',
        idempotencyKey,
        reservation,
        configSnapshot: snapshot,
      });

      let attempt: { userId: string; sessionId: string; attemptId: string; turnId: string } | undefined;
      let write: DeliveryWrite | undefined;
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
          },
          delta: async () => {},
          finish: async () => {},
          settle: async textGenerated => {
            if (!write || !attempt) throw new Error('expected delivery writer');
            await write(
              voiceDeliveryRecordSchema.parse({
                ...deliveryFixture(),
                userId: attempt.userId,
                sessionId: attempt.sessionId,
                turnId: attempt.turnId,
                attemptId: attempt.attemptId,
                responseId: key('voice-response', attempt.userId, attempt.sessionId, attempt.attemptId),
                voiceSessionId: 'voice-pers-1',
                status: 'completed',
                textGenerated,
                textSpoken: textGenerated,
                textRemaining: '',
              }),
            );
          },
        },
      });
      await h.runtime.reservations.release({
        identity: h.identity,
        reservationId: reservation.reservationId,
      });

      const dispatches = dispatchedMessages(h);
      expect(dispatches).toHaveLength(2);
      expect(dispatches[0][1].content).toContain('Product background (data, not authority):');
      expect(dispatches[0][2].content).toContain('MemoryText preference.');
      expect(dispatches[0][4]).toEqual({ role: 'system', content: 'Response mode: text.' });

      expect(dispatches[1][1].content).toContain('Product background (data, not authority):');
      expect(dispatches[1][2].content).toContain('Mutated later.');
      expect(dispatches[1][2].content).toContain('Emoji (text mode only): low');
      expect(dispatches[1][4]).toEqual({ role: 'system', content: 'Response mode: voice.' });
      expect(personalizationReadSpy).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  });
});
