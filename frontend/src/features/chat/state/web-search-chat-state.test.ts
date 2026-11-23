/**
 * ============================================================================
 * FILE: web-search-chat-state.test.ts
 * LOCATION: frontend/src/features/chat/state/web-search-chat-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Web Search SSE reducer folding, turn/attempt fencing, and terminal attachment.
 *
 * ROLE IN PROJECT:
 *    Prevents stale-session web activity leakage and guarantees honest error/cancel provenance.
 *
 * KEY COMPONENTS:
 *    - chatReducer Web Search tests: Fenced WEB_ACTIVITY / WEB_SOURCES and terminal retention.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { chatReducer, initialChatState } from './chat-reducer.ts';
import type { ChatState } from './chat-types.ts';
import type { WebSearchActivity, WebSourceReference } from '../../../api/web-search-protocol.ts';

const activeState = (): ChatState => ({
  ...initialChatState,
  activeSessionId: 'session-1',
  activeTurnId: 'turn-1',
  activeAttemptId: 'attempt-1',
  isStreaming: true,
  streamText: 'Partial answer',
  draftInput: 'Keep my draft',
});

const searchActivity: WebSearchActivity = {
  toolCallId: 'call_1',
  mode: 'browse',
  phase: 'searching',
  provider: 'exa',
  code: null,
};

const safeSource: WebSourceReference = {
  sourceId: 'src_1',
  toolCallId: 'call_1',
  provider: 'exa',
  kind: 'browse',
  title: 'TypeScript Docs',
  url: 'https://www.typescriptlang.org/docs/',
  retrievedAt: '2026-11-14T00:00:00.000Z',
};

describe('web-search chat reducer state and fencing', () => {
  it('fences WEB_ACTIVITY and WEB_SOURCES to active session, turn, attempt, and increasing sequence', () => {
    const first = chatReducer(activeState(), {
      type: 'WEB_ACTIVITY',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        attemptId: 'attempt-1',
        sequence: 1,
        activity: searchActivity,
      },
    });
    expect(first.webActivitiesByTurn['turn-1']).toEqual([searchActivity]);

    for (const bad of [
      { sessionId: 'other-session' },
      { turnId: 'other-turn' },
      { attemptId: 'old-attempt' },
      { sequence: 1 },
    ]) {
      expect(
        chatReducer(first, {
          type: 'WEB_ACTIVITY',
          payload: {
            sessionId: 'session-1',
            turnId: 'turn-1',
            attemptId: 'attempt-1',
            sequence: 2,
            activity: { ...searchActivity, phase: 'failed', code: 'WEB_SCHEMA_REPAIR_EXHAUSTED' },
            ...bad,
          },
        }),
      ).toBe(first);
    }

    const withSources = chatReducer(first, {
      type: 'WEB_SOURCES',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        attemptId: 'attempt-1',
        sequence: 2,
        sources: [
          safeSource,
          { ...safeSource, sourceId: 'src_bad', url: 'javascript:alert(1)' },
        ],
      },
    });
    expect(withSources.webSourcesByTurn['turn-1']).toEqual([safeSource]);

    const completed = chatReducer(withSources, {
      type: 'STREAM_COMPLETED',
      payload: {
        assistantMessageId: 'msg_1',
        outcome: 'completed',
      },
    });
    expect(completed.messages.at(-1)?.webActivities).toEqual([searchActivity]);
    expect(completed.messages.at(-1)?.webSources).toEqual([safeSource]);
    expect(completed.webActivitiesByTurn['turn-1']).toBeUndefined();
    expect(completed.webSourcesByTurn['turn-1']).toBeUndefined();
  });

  it('retains failed/cancelled search activities honestly without inventing sources and clears on NEW_CHAT or SELECT_SESSION', () => {
    let state = chatReducer(activeState(), {
      type: 'WEB_ACTIVITY',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        attemptId: 'attempt-1',
        sequence: 1,
        activity: { ...searchActivity, phase: 'cancelled', provider: null },
      },
    });
    state = chatReducer(state, { type: 'STREAM_CANCELLED' });
    expect(state.messages.at(-1)?.webActivities?.[0]?.phase).toBe('cancelled');
    expect(state.messages.at(-1)?.webSources).toBeUndefined();

    const clearedNew = chatReducer(activeState(), { type: 'NEW_CHAT' });
    expect(clearedNew.webActivitiesByTurn).toEqual({});
    expect(clearedNew.webSourcesByTurn).toEqual({});
    expect(clearedNew.draftInput).toBe('Keep my draft');

    const clearedSwitch = chatReducer(activeState(), {
      type: 'SELECT_SESSION',
      payload: { sessionId: 'session-2', title: 'Second' },
    });
    expect(clearedSwitch.webActivitiesByTurn).toEqual({});
    expect(clearedSwitch.webSourcesByTurn).toEqual({});
  });

  it('starts the post-search answer on a new paragraph after pre-tool narration', () => {
    let state = chatReducer({ ...initialChatState, ...activeState(), streamText: '' }, {
      type: 'STREAM_DELTA',
      payload: { text: 'Let me look up the NRSV text for 1 Peter 3:5.' },
    });
    state = chatReducer(state, {
      type: 'WEB_ACTIVITY',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        attemptId: 'attempt-1',
        sequence: 1,
        activity: searchActivity,
      },
    });
    expect(state.pendingWebContinuationBreak).toBe(true);
    state = chatReducer(state, {
      type: 'STREAM_DELTA',
      payload: { text: 'Here is 1 Peter 3:5 from the NRSV.' },
    });
    expect(state.streamText).toBe(
      'Let me look up the NRSV text for 1 Peter 3:5.\n\nHere is 1 Peter 3:5 from the NRSV.',
    );
    expect(state.pendingWebContinuationBreak).toBe(false);
    state = chatReducer(state, {
      type: 'WEB_ACTIVITY',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        attemptId: 'attempt-1',
        sequence: 2,
        activity: { ...searchActivity, phase: 'completed', provider: 'exa' },
      },
    });
    state = chatReducer(state, {
      type: 'STREAM_DELTA',
      payload: { text: ' The wording is softer.' },
    });
    expect(state.streamText).toBe(
      'Let me look up the NRSV text for 1 Peter 3:5.\n\nHere is 1 Peter 3:5 from the NRSV. The wording is softer.',
    );
  });
});
