/**
 * ============================================================================
 * FILE: compaction-chat-state.test.ts
 * LOCATION: frontend/src/features/chat/state/compaction-chat-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify compaction checkpoint and context usage state transitions, sequence
 *    monotonicity, SSE handling, and bounded idle compaction polling.
 *
 * ROLE IN PROJECT:
 *    Locks P4 chat reducer and orchestration behavior for cold-loaded compacted
 *    tails, stream updates, session switching, and Live Voice silence.
 *
 * KEY COMPONENTS:
 *    - chatReducer compaction/contextUsage transitions and sequence ordering
 *    - startCompactionPollEffect bounded polling and Live Voice suppression
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../../api/client.ts';
import type { VisibleMessage } from '../../../api/protocol.ts';
import { chatReducer, initialChatState } from './chat-reducer.ts';
import type { ChatAction, ChatState } from './chat-types.ts';
import { startCompactionPollEffect, useChatActions } from './use-chat.ts';

function msg(sequence: number, role: 'user' | 'assistant' = 'user'): VisibleMessage {
  return {
    messageId: `m_${sequence}`,
    turnId: `t_${Math.ceil(sequence / 2)}`,
    eventId: `e_${sequence}`,
    sequence,
    role,
    content: `Message ${sequence}`,
    createdAt: '2026-11-17T12:00:00.000Z',
    completionStatus: 'completed',
    truncated: false,
  };
}

describe('compaction and context usage chat state', () => {
  it('hydrates compaction and contextUsage on MESSAGES_LOADED and resets on NEW_CHAT / SELECT_SESSION', () => {
    const compaction = { compactedThroughSequence: 100, compactionCycle: 2, summaryPreview: 'Phase 1 goals settled.' };
    const contextUsage = { historyTokens: 4200, maxHistoryTokens: 10000, utilizationPercent: 42, status: 'idle' as const };

    let state = chatReducer(initialChatState, {
      type: 'SELECT_SESSION',
      payload: { sessionId: 'sess_1', title: 'Long session' },
    });
    state = chatReducer(state, {
      type: 'MESSAGES_LOADED',
      payload: {
        sessionId: 'sess_1',
        items: [msg(101, 'user'), msg(102, 'assistant')],
        nextCursor: '101',
        olderAvailable: true,
        compaction,
        contextUsage,
      },
    });
    expect(state.compaction).toEqual(compaction);
    expect(state.contextUsage).toEqual(contextUsage);

    const switched = chatReducer(state, {
      type: 'SELECT_SESSION',
      payload: { sessionId: 'sess_2', title: 'Fresh session' },
    });
    expect(switched.compaction).toBeNull();
    expect(switched.contextUsage).toBeNull();

    const cleared = chatReducer(state, { type: 'NEW_CHAT' });
    expect(cleared.compaction).toBeNull();
    expect(cleared.contextUsage).toBeNull();
  });

  it('assigns optimistic sequences past compacted cold-loaded tails and rejects stale cycles', () => {
    let state: ChatState = {
      ...initialChatState,
      activeSessionId: 'sess_1',
      messages: [msg(101, 'user'), msg(102, 'assistant')],
      compaction: { compactedThroughSequence: 100, compactionCycle: 2, summaryPreview: 'Cycle 2' },
      contextUsage: { historyTokens: 8200, maxHistoryTokens: 10000, utilizationPercent: 82, status: 'compacting' },
    };

    state = chatReducer(state, {
      type: 'TURN_SUBMIT_START',
      payload: { userContent: 'Next question', idempotencyKey: 'key_next_1' },
    });
    expect(state.messages.at(-1)?.sequence).toBe(103);

    state = chatReducer(state, {
      type: 'TURN_ACCEPTED',
      payload: { sessionId: 'sess_1', turnId: 't_52', attemptId: 'att_1', userMessageId: 'm_103' },
    });
    state = chatReducer(state, { type: 'STREAM_DELTA', payload: { text: 'Answer' } });
    state = chatReducer(state, {
      type: 'STREAM_COMPLETED',
      payload: {
        assistantMessageId: 'm_104',
        outcome: 'completed',
        compaction: { compactedThroughSequence: 102, compactionCycle: 3, summaryPreview: 'Cycle 3' },
        contextUsage: { historyTokens: 3100, maxHistoryTokens: 10000, utilizationPercent: 31, status: 'idle' },
      },
    });
    expect(state.messages.at(-1)?.sequence).toBe(104);
    expect(state.compaction?.compactionCycle).toBe(3);
    expect(state.contextUsage?.utilizationPercent).toBe(31);

    // Older compaction cycle or other-session CONTEXT_STATE is ignored
    const afterStale = chatReducer(state, {
      type: 'CONTEXT_STATE',
      payload: {
        sessionId: 'sess_1',
        compaction: { compactedThroughSequence: 80, compactionCycle: 1, summaryPreview: 'Stale' },
      },
    });
    expect(afterStale.compaction?.compactionCycle).toBe(3);

    const afterOtherSession = chatReducer(state, {
      type: 'CONTEXT_STATE',
      payload: {
        sessionId: 'other_sess',
        contextUsage: { historyTokens: 9900, maxHistoryTokens: 10000, utilizationPercent: 99, status: 'compacting' },
      },
    });
    expect(afterOtherSession).toBe(state);
  });

  it('merges older paged messages in sequence order without duplicates', () => {
    const state: ChatState = {
      ...initialChatState,
      activeSessionId: 'sess_1',
      messages: [msg(3, 'user'), msg(4, 'assistant')],
      messagesCursor: '3',
      olderAvailable: true,
    };
    const next = chatReducer(state, {
      type: 'OLDER_MESSAGES_LOADED',
      payload: {
        items: [msg(1, 'user'), msg(2, 'assistant'), msg(3, 'user')],
        nextCursor: null,
        olderAvailable: false,
      },
    });
    expect(next.messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4]);
    expect(next.olderAvailable).toBe(false);
  });

  it('handles SSE context-state without prematurely flushing coalesced deltas', async () => {
    const ssePayload = [
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":1,"event":{"type":"turn-accepted","userMessageId":"m_1"}}\n\n',
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":2,"event":{"type":"delta","text":"Hel"}}\n\n',
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":3,"event":{"type":"context-state","contextUsage":{"historyTokens":8200,"maxHistoryTokens":10000,"utilizationPercent":82,"status":"compacting"}}}\n\n',
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":4,"event":{"type":"delta","text":"lo"}}\n\n',
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":5,"event":{"type":"completed","assistantMessageId":"m_2","outcome":"completed","compaction":{"compactedThroughSequence":2,"compactionCycle":1,"summaryPreview":"Greeted user."},"contextUsage":{"historyTokens":2400,"maxHistoryTokens":10000,"utilizationPercent":24,"status":"idle"}}}\n\n',
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const chunk of ssePayload) ctrl.enqueue(encoder.encode(chunk));
        ctrl.close();
      },
    });
    const fetchSpy = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          sessionId: 'sess_1',
          turnId: 'turn_1',
          attemptId: 'att_1',
          userMessageId: 'm_1',
          streamPath: '/sessions/sess_1/turns/turn_1/stream',
        }),
      )
      .mockResolvedValueOnce(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }));

    const client = new ApiClient({ fetch: fetchSpy, recoveryStorage: null });
    let state = initialChatState;
    const actionsLog: ChatAction['type'][] = [];
    const dispatch = (action: ChatAction) => {
      actionsLog.push(action.type);
      state = chatReducer(state, action);
    };
    let actions!: ReturnType<typeof useChatActions>;
    function Harness() {
      actions = useChatActions(state, dispatch, client, undefined, {
        scheduler: {
          schedule: (fn) => { const id = setTimeout(fn, 100); return () => clearTimeout(id); },
        },
      });
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    await actions.submitMessage('Hi');

    expect(actionsLog).toContain('CONTEXT_STATE');
    expect(actionsLog).not.toContain('STREAM_DELTA');
    expect(state.messages.at(-1)?.content).toBe('Hello');
    expect(state.compaction?.compactedThroughSequence).toBe(2);
    expect(state.contextUsage?.status).toBe('idle');
    expect(state.contextUsage?.utilizationPercent).toBe(24);
  });

  it('polls listMessages(limit=1) while compacting when idle and suppresses polling during Live Voice', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
        Response.json({
          items: [],
          nextCursor: null,
          olderAvailable: true,
          compaction: { compactedThroughSequence: 10, compactionCycle: 1, summaryPreview: 'Done.' },
          contextUsage: { historyTokens: 2500, maxHistoryTokens: 10000, utilizationPercent: 25, status: 'idle' },
        }),
      );
      const client = new ApiClient({ fetch: fetcher, recoveryStorage: null });
      let state: ChatState = {
        ...initialChatState,
        activeSessionId: 'sess_1',
        contextUsage: { historyTokens: 8200, maxHistoryTokens: 10000, utilizationPercent: 82, status: 'compacting' },
      };

      expect(
        startCompactionPollEffect({
          client,
          dispatch: () => undefined,
          sessionId: 'sess_1',
          contextUsage: state.contextUsage,
          isStreaming: false,
          voiceLocked: true,
          savePending: false,
        }),
      ).toBeUndefined();

      const cleanup = startCompactionPollEffect({
        client,
        dispatch: (action) => { state = chatReducer(state, action); },
        sessionId: 'sess_1',
        contextUsage: state.contextUsage,
        isStreaming: false,
        voiceLocked: false,
        savePending: false,
      });
      await vi.advanceTimersByTimeAsync(1600);
      cleanup?.();

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0][0])).toContain('/sessions/sess_1/messages?limit=1');
      expect(state.contextUsage?.status).toBe('idle');
      expect(state.compaction?.compactedThroughSequence).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
