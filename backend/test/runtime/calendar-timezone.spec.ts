/**
 * ============================================================================
 * FILE: calendar-timezone.spec.ts
 * LOCATION: backend/test/runtime/calendar-timezone.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Calendar timezone precedence between explicit env override,
 *    validated browser clientTimeZone, and Etc/UTC fallback.
 *
 * ROLE IN PROJECT:
 *    Proves unset AURVIN_GOOGLE_CALENDAR_TIME_ZONE defers to clientTimeZone,
 *    explicit env overrides always win, invalid hints fall back safely, and
 *    calendar-intent confirmation safety remains intact.
 *
 * KEY COMPONENTS:
 *    - resolveCalendarTimeZone: Precedence matrix unit checks.
 *    - readCalendarIntent: Explicit confirmation safety under resolved timezone.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { resolveCalendarTimeZone } from '../../src/chat-runtime/calendar-ports.js';
import { readCalendarIntent } from '../../src/chat-runtime/calendar-intent.js';
import type { MessageRecord } from '../../src/contracts/message.js';
import type { AttemptRecord } from '../../src/contracts/attempt.js';

describe('resolveCalendarTimeZone', () => {
  it('uses explicit env override when trustedTimeZoneExplicit is true', () => {
    expect(
      resolveCalendarTimeZone(
        { trustedTimeZone: 'America/Chicago', trustedTimeZoneExplicit: true },
        'Asia/Kolkata',
      ),
    ).toBe('America/Chicago');
    expect(
      resolveCalendarTimeZone(
        { trustedTimeZone: 'Etc/UTC', trustedTimeZoneExplicit: true },
        'Asia/Kolkata',
      ),
    ).toBe('Etc/UTC');
  });

  it('uses validated clientTimeZone when AURVIN_GOOGLE_CALENDAR_TIME_ZONE is unset, falling back to Etc/UTC', () => {
    expect(
      resolveCalendarTimeZone(
        { trustedTimeZone: 'Etc/UTC', trustedTimeZoneExplicit: false },
        'Asia/Kolkata',
      ),
    ).toBe('Asia/Kolkata');
    expect(
      resolveCalendarTimeZone(
        { trustedTimeZone: 'Etc/UTC', trustedTimeZoneExplicit: false },
        'Not/A_Zone',
      ),
    ).toBe('Etc/UTC');
    expect(
      resolveCalendarTimeZone(
        { trustedTimeZone: 'Etc/UTC', trustedTimeZoneExplicit: false },
        null,
      ),
    ).toBe('Etc/UTC');
  });

  it('preserves non-UTC fixture overrides when trustedTimeZoneExplicit is omitted', () => {
    expect(
      resolveCalendarTimeZone({ trustedTimeZone: 'America/New_York' }, 'Asia/Kolkata'),
    ).toBe('America/New_York');
    expect(
      resolveCalendarTimeZone({ trustedTimeZone: 'Etc/UTC' }, 'Europe/London'),
    ).toBe('Europe/London');
  });

  it('keeps calendar-intent confirmation safety intact with browser-resolved timezone', () => {
    const message: MessageRecord = {
      schemaVersion: 1,
      userId: 'user-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      attemptId: null,
      messageId: 'msg-1',
      eventId: 'evt-1',
      sequence: 0,
      role: 'user',
      content: 'Schedule Standup tomorrow at 9am',
      createdAt: '2026-11-19T06:45:00.000Z',
      completionStatus: 'accepted',
      truncated: false,
    };
    const attempt: AttemptRecord = {
      schemaVersion: 1,
      kind: 'attempt',
      userId: 'user-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      attemptId: 'att-1',
      idempotencyKey: 'k1',
      payloadHash: '0'.repeat(64),
      status: 'generating',
      sequence: 2,
      createdAt: '2026-11-19T06:45:00.000Z',
      updatedAt: '2026-11-19T06:45:00.000Z',
      instructionVersion: 'v1',
      knowledgeContentHash: '0'.repeat(64),
      graphSchemaVersion: '1',
      modelId: 'fixture/model',
      contextVersion: 0,
      openRouterUser: 'user-1',
      generationId: null,
      truncated: false,
      errorCode: null,
      causal: { userMessageId: 'msg-1', previousAttemptId: null },
    };
    const tz = resolveCalendarTimeZone(
      { trustedTimeZone: 'Etc/UTC', trustedTimeZoneExplicit: false },
      'Asia/Kolkata',
    );
    const interpreted = readCalendarIntent(
      message,
      attempt,
      {
        summary: 'Standup',
        start: '2026-11-20T09:00:00+05:30',
        end: '2026-11-20T10:00:00+05:30',
        timeZone: tz,
      },
      tz,
    );
    expect(interpreted).toEqual({ outcome: 'confirmation' });
  });
});
