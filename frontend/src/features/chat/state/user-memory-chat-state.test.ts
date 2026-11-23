/**
 * ============================================================================
 * FILE: user-memory-chat-state.test.ts
 * LOCATION: frontend/src/features/chat/state/user-memory-chat-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Unit tests for chat protocol, client keepalive purge, reducer transitions,
 *    and hook orchestration for User Memory indicator and Temporary Chat.
 *
 * ROLE IN PROJECT:
 *    Covers wire guards, sessionStorage isolation, Temporary Chat lock/sidebar
 *    exclusion/exit purge, explicit and passive memoryUpdated hydration, and
 *    the P4-aligned Live Voice gate in Node Vitest without jsdom.
 *
 * KEY COMPONENTS:
 *    - Protocol and ApiClient contract tests
 *    - chatReducer and useChatActions lifecycle tests
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiClient } from '../../../api/client.ts';
import type {
  CalendarCompatibleEnvelope,
  CalendarStreamEvent,
  CalendarStreamEventV3,
} from '../../../api/calendar-protocol.ts';
import { parseCalendarCompatibleFrame } from '../../../api/calendar-protocol.ts';
import {
  isStreamEvent,
  isSubmitTurnRequest,
  isVisibleMessage,
  parseSseDataLine,
} from '../../../api/protocol.ts';
import type { VisibleMessage } from '../../../api/protocol.ts';
import {
  canStartLiveVoiceForChat,
  canToggleTemporaryChat,
  chatReducer,
  initialChatState,
  TEMPORARY_LIVE_VOICE_ENABLED,
} from './chat-reducer.ts';
import type { ChatAction, ChatState } from './chat-types.ts';
import { startTemporaryChatPagehideEffect, useChatActions } from './use-chat.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('chat protocol and client for user memory and temporary chat', () => {
  it('accepts optional boolean ephemeral on SubmitTurnRequest and rejects non-boolean values', () => {
    const base = {
      sessionId: null,
      content: 'Temporary question',
      idempotencyKey: 'temp-key-123456',
    };
    expect(isSubmitTurnRequest({ ...base, ephemeral: true })).toBe(true);
    expect(isSubmitTurnRequest({ ...base, ephemeral: false })).toBe(true);
    expect(isSubmitTurnRequest({ ...base, ephemeral: 'yes' })).toBe(false);
    expect(isSubmitTurnRequest({ ...base, ephemeral: null })).toBe(false);
  });

  it('accepts memoryUpdated on assistant VisibleMessage and rejects it on user messages or non-booleans', () => {
    const assistant = {
      messageId: 'm_asst',
      turnId: 't_1',
      eventId: 'e_1',
      sequence: 2,
      role: 'assistant' as const,
      content: 'Got it, I will remember that.',
      createdAt: '2026-11-20T12:00:00.000Z',
      completionStatus: 'completed' as const,
      truncated: false,
    };
    expect(isVisibleMessage({ ...assistant, memoryUpdated: true })).toBe(true);
    expect(isVisibleMessage({ ...assistant, memoryUpdated: false })).toBe(true);
    expect(isVisibleMessage({ ...assistant, memoryUpdated: 'yes' })).toBe(false);
    expect(isVisibleMessage({ ...assistant, role: 'user', memoryUpdated: true })).toBe(false);
  });

  it('accepts memoryUpdated on SSE completed events across v1 and v3 envelopes', () => {
    expect(
      isStreamEvent({
        type: 'completed',
        assistantMessageId: 'm_1',
        outcome: 'completed',
        memoryUpdated: true,
      }),
    ).toBe(true);
    expect(
      isStreamEvent({
        type: 'completed',
        assistantMessageId: 'm_1',
        outcome: 'completed',
        memoryUpdated: 'true',
      }),
    ).toBe(false);

    const v1Frame = `data: ${JSON.stringify({
      protocolVersion: 1,
      sessionId: 'sess_1',
      turnId: 'turn_1',
      attemptId: 'att_1',
      sequence: 3,
      event: {
        type: 'completed',
        assistantMessageId: 'm_1',
        outcome: 'completed',
        memoryUpdated: true,
      },
    })}\n\n`;
    expect(parseSseDataLine(v1Frame).event).toMatchObject({
      type: 'completed',
      memoryUpdated: true,
    });

    const v3Frame = `data: ${JSON.stringify({
      protocolVersion: 3,
      sessionId: 'sess_1',
      turnId: 'turn_1',
      attemptId: 'att_1',
      sequence: 4,
      event: {
        type: 'completed',
        assistantMessageId: 'm_1',
        outcome: 'completed',
        memoryUpdated: true,
      },
    })}\n\n`;
    expect(parseCalendarCompatibleFrame(v3Frame).event).toMatchObject({
      type: 'completed',
      memoryUpdated: true,
    });
  });

  it('supports keepalive DELETE on deleteSession and avoids persisting ephemeral prompts to sessionStorage', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
    };
    const fetchFn: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return Response.json(
        {
          sessionId: 'sess_temp_1',
          turnId: 'turn_1',
          attemptId: 'att_1',
          userMessageId: 'msg_1',
          streamPath: '/sessions/sess_temp_1/turns/turn_1/stream',
        },
        { status: 202 },
      );
    };

    const client = new ApiClient({ baseUrl: '/api', fetch: fetchFn, recoveryStorage: storage });
    await client.submitTurn({
      sessionId: null,
      content: 'EPHEMERAL_PRIVATE_TEXT',
      idempotencyKey: 'temp-idem-123456',
      ephemeral: true,
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      sessionId: null,
      content: 'EPHEMERAL_PRIVATE_TEXT',
      ephemeral: true,
    });
    for (const raw of stored.values()) {
      expect(raw).not.toContain('EPHEMERAL_PRIVATE_TEXT');
    }

    await client.deleteSession('sess_temp_1', { keepalive: true });
    expect(calls[1]?.url).toBe('/api/sessions/sess_temp_1');
    expect(calls[1]?.init).toMatchObject({
      method: 'DELETE',
      keepalive: true,
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  it('rejects a pending recovery replay when ephemeral classification differs', async () => {
    let failFirst = true;
    const fetchFn: typeof fetch = async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error('network drop');
      }
      return Response.json(
        {
          sessionId: 'sess_1',
          turnId: 'turn_1',
          attemptId: 'att_1',
          userMessageId: 'msg_1',
          streamPath: '/sessions/sess_1/turns/turn_1/stream',
          processEpoch: 'epoch_1',
        },
        { status: 202 },
      );
    };
    const client = new ApiClient({ baseUrl: '/api', fetch: fetchFn, recoveryStorage: null });
    await expect(
      client.submitTurn({
        sessionId: null,
        content: 'Same prompt',
        idempotencyKey: 'idem-ephemeral-1',
        expectedEpoch: 'epoch_1',
        ephemeral: true,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

    await expect(
      client.submitTurn({
        sessionId: null,
        content: 'Same prompt',
        idempotencyKey: 'idem-ephemeral-2',
        expectedEpoch: 'epoch_1',
      }),
    ).rejects.toMatchObject({ code: 'SUBMISSION_PENDING' });
  });
});

describe('chatReducer temporary chat and memoryUpdated state', () => {
  it('toggles Temporary Chat only on an unsaved empty New Chat and locks after turn 1', () => {
    expect(initialChatState.activeSessionTemporary).toBe(false);
    expect(canToggleTemporaryChat(initialChatState)).toBe(true);

    const enabled = chatReducer(initialChatState, { type: 'SET_TEMPORARY_CHAT', payload: true });
    expect(enabled.activeSessionTemporary).toBe(true);
    expect(canToggleTemporaryChat(enabled)).toBe(true);

    const submitting = chatReducer(enabled, {
      type: 'TURN_SUBMIT_START',
      payload: { userContent: 'Secret question', idempotencyKey: 'temp-12345678' },
    });
    expect(canToggleTemporaryChat(submitting)).toBe(false);
    expect(
      chatReducer(submitting, { type: 'SET_TEMPORARY_CHAT', payload: false }).activeSessionTemporary,
    ).toBe(true);

    const accepted = chatReducer(submitting, {
      type: 'TURN_ACCEPTED',
      payload: {
        sessionId: 'sess_temp_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        userMessageId: 'msg_u1',
        processEpoch: 'epoch_1',
      },
    });
    expect(accepted.activeSessionTemporary).toBe(true);
    expect(accepted.activeSessionId).toBe('sess_temp_1');
    expect(canToggleTemporaryChat(accepted)).toBe(false);
    expect(
      chatReducer(accepted, { type: 'SET_TEMPORARY_CHAT', payload: false }).activeSessionTemporary,
    ).toBe(true);
  });

  it('excludes Temporary Chat from sidebar sessions, localSessionIds, and unsaved save state', () => {
    let state = chatReducer(initialChatState, { type: 'SET_TEMPORARY_CHAT', payload: true });
    state = chatReducer(state, {
      type: 'TURN_SUBMIT_START',
      payload: { userContent: 'Off the record', idempotencyKey: 'temp-12345678' },
    });
    state = chatReducer(state, {
      type: 'TURN_ACCEPTED',
      payload: {
        sessionId: 'sess_temp_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        userMessageId: 'msg_u1',
        processEpoch: 'epoch_1',
      },
    });
    expect(state.sessions).toEqual([]);
    expect(state.localSessionIds).toEqual([]);

    state = chatReducer(state, {
      type: 'SAVE_STATE',
      payload: {
        sessionId: 'sess_temp_1',
        turnId: 'turn_1',
        save: { state: 'saving', epoch: 'epoch_1', version: 1, durableVersion: 0 },
      },
    });
    expect(state.saves['sess_temp_1']).toBeUndefined();
    expect(state.unsavedMessages['sess_temp_1']).toBeUndefined();

    // Defensive sidebar exclusion if any list payload contains an ephemeral row.
    const withServerList = chatReducer(state, {
      type: 'SESSIONS_LOADED',
      payload: {
        items: [
          {
            sessionId: 'sess_temp_1',
            title: 'Leak',
            ephemeral: true,
            createdAt: '2026-11-20T12:00:00.000Z',
            lastActivityAt: '2026-11-20T12:00:00.000Z',
          },
          {
            sessionId: 'sess_saved',
            title: 'Saved chat',
            createdAt: '2026-11-20T11:00:00.000Z',
            lastActivityAt: '2026-11-20T11:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
    });
    expect(withServerList.sessions.map((s) => s.sessionId)).toEqual(['sess_saved']);

    const afterNewChat = chatReducer(state, { type: 'NEW_CHAT' });
    expect(afterNewChat.activeSessionTemporary).toBe(false);
    expect(afterNewChat.activeSessionId).toBeNull();
    expect(afterNewChat.unsavedMessages['sess_temp_1']).toBeUndefined();
  });

  it('keeps Live Voice disabled in Temporary Chat by default and rejects live lease claims', () => {
    expect(TEMPORARY_LIVE_VOICE_ENABLED).toBe(false);
    expect(canStartLiveVoiceForChat(initialChatState)).toBe(true);

    const temp = chatReducer(initialChatState, { type: 'SET_TEMPORARY_CHAT', payload: true });
    expect(canStartLiveVoiceForChat(temp)).toBe(false);
    expect(canStartLiveVoiceForChat(temp, true)).toBe(true);

    const blockedLive = chatReducer(temp, {
      type: 'CLAIM_VOICE_INPUT',
      payload: { token: 'live-lease-1', mode: 'live' },
    });
    expect(blockedLive.voiceInput).toBeNull();

    // Dictation lease remains unaffected on unsaved temporary draft.
    const dictation = chatReducer(temp, {
      type: 'CLAIM_VOICE_INPUT',
      payload: { token: 'dict-lease-1', mode: 'dictation' },
    });
    expect(dictation.voiceInput).toEqual({ token: 'dict-lease-1', mode: 'dictation' });
    expect(canToggleTemporaryChat(dictation)).toBe(false);
  });

  it('records memoryUpdated on explicit STREAM_COMPLETED and preserves it across passive MESSAGES_LOADED hydration', () => {
    let state = chatReducer(initialChatState, {
      type: 'TURN_SUBMIT_START',
      payload: { userContent: 'Remember my dog is Beans', idempotencyKey: 'mem-12345678' },
    });
    state = chatReducer(state, {
      type: 'TURN_ACCEPTED',
      payload: {
        sessionId: 'sess_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        userMessageId: 'msg_u1',
      },
    });
    state = chatReducer(state, { type: 'STREAM_DELTA', payload: { text: 'Noted — Beans!' } });
    state = chatReducer(state, {
      type: 'STREAM_COMPLETED',
      payload: { assistantMessageId: 'msg_a1', outcome: 'completed', memoryUpdated: true },
    });
    expect(state.messages.at(-1)).toMatchObject({
      messageId: 'msg_a1',
      role: 'assistant',
      memoryUpdated: true,
    });

    // Never attach memoryUpdated in Temporary Chat even if a stray flag arrives.
    let tempState = chatReducer(initialChatState, { type: 'SET_TEMPORARY_CHAT', payload: true });
    tempState = chatReducer(tempState, {
      type: 'TURN_ACCEPTED',
      payload: {
        sessionId: 'sess_temp',
        turnId: 'turn_t1',
        attemptId: 'att_t1',
        userMessageId: 'msg_tu1',
      },
    });
    tempState = chatReducer(tempState, { type: 'STREAM_DELTA', payload: { text: 'Temporary reply' } });
    tempState = chatReducer(tempState, {
      type: 'STREAM_COMPLETED',
      payload: { assistantMessageId: 'msg_ta1', outcome: 'completed', memoryUpdated: true },
    });
    expect(tempState.messages.at(-1)?.memoryUpdated).toBeUndefined();

    // Passive hydration merges memoryUpdated: true from server even when local unsaved retain is active.
    const localAssistant: VisibleMessage = {
      messageId: 'msg_a2',
      turnId: 'turn_2',
      eventId: 'evt_a2',
      sequence: 4,
      role: 'assistant',
      content: 'Passive batch reply',
      createdAt: '2026-11-20T12:01:00.000Z',
      completionStatus: 'completed',
      truncated: false,
    };
    const withPendingSave = {
      ...initialChatState,
      activeSessionId: 'sess_1',
      messages: [localAssistant],
      saves: {
        sess_1: {
          turnId: 'turn_2',
          value: { state: 'saving' as const, epoch: 'epoch_1', version: 2, durableVersion: 1 },
        },
      },
    };
    const hydrated = chatReducer(withPendingSave, {
      type: 'MESSAGES_LOADED',
      payload: {
        sessionId: 'sess_1',
        items: [{ ...localAssistant, memoryUpdated: true }],
        nextCursor: null,
        olderAvailable: false,
        save: { state: 'saving', epoch: 'epoch_1', version: 1, durableVersion: 1 },
      },
    });
    expect(hydrated.messages[0]?.memoryUpdated).toBe(true);
  });
});

type StreamEventCallback = (
  event: CalendarStreamEvent | CalendarStreamEventV3,
  envelope: CalendarCompatibleEnvelope,
) => void;

function createHookHarness(initial: ChatState, client: ApiClient) {
  let state = initial;
  const dispatched: ChatAction[] = [];
  const dispatch = (action: ChatAction) => {
    dispatched.push(action);
    state = chatReducer(state, action);
  };
  let actions!: ReturnType<typeof useChatActions>;
  function Harness() {
    // oxlint-disable-next-line react/globals -- test harness captures hook actions for assertions
    actions = useChatActions(state, dispatch, client);
    return null;
  }
  const render = () => {
    renderToStaticMarkup(createElement(Harness));
  };
  render();
  return {
    get state() {
      return state;
    },
    get actions() {
      return actions;
    },
    dispatched,
    dispatch,
    render,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useChatActions temporary chat purge, creation-only ephemeral flag, and memoryUpdated stream', () => {
  it('sends ephemeral: true only on turn 1, skips sidebar reconcile, and purges with keepalive on New Chat and session switch', async () => {
    const client = new ApiClient({ fetch: vi.fn() });
    const listSessionsSpy = vi.spyOn(client, 'listSessions').mockResolvedValue({ items: [], nextCursor: null });
    const listMessagesSpy = vi.spyOn(client, 'listMessages').mockResolvedValue({
      items: [],
      nextCursor: null,
      olderAvailable: false,
    });
    const deleteSpy = vi.spyOn(client, 'deleteSession').mockResolvedValue(undefined);
    const submitSpy = vi
      .spyOn(client, 'submitTurn')
      .mockResolvedValueOnce({
        sessionId: 'sess_temp_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        userMessageId: 'msg_u1',
        streamPath: '/sessions/sess_temp_1/turns/turn_1/stream',
        processEpoch: 'epoch_1',
      })
      .mockResolvedValueOnce({
        sessionId: 'sess_temp_1',
        turnId: 'turn_2',
        attemptId: 'att_2',
        userMessageId: 'msg_u2',
        streamPath: '/sessions/sess_temp_1/turns/turn_2/stream',
        processEpoch: 'epoch_1',
      });

    let streamHandler: StreamEventCallback | null = null;
    vi.spyOn(client, 'connectTurnStream').mockImplementation(async (_path, handlers) => {
      streamHandler = handlers.onEvent ?? null;
    });

    const harness = createHookHarness(
      { ...initialChatState, activeSessionTemporary: true },
      client,
    );

    // Turn 1: sends ephemeral: true
    await harness.actions.submitMessage('First temp turn');
    expect(submitSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: null, ephemeral: true, content: 'First temp turn' }),
      expect.any(Object),
    );
    streamHandler!(
      { type: 'completed', assistantMessageId: 'msg_a1', outcome: 'completed' },
      {
        protocolVersion: 1,
        sessionId: 'sess_temp_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        sequence: 2,
        event: { type: 'completed', assistantMessageId: 'msg_a1', outcome: 'completed' },
      },
    );
    await flushMicrotasks();
    expect(listSessionsSpy).not.toHaveBeenCalled();
    expect(harness.state.sessions).toEqual([]);

    // Re-render hook with activeSessionId='sess_temp_1', Turn 2 omits ephemeral
    harness.render();
    await harness.actions.submitMessage('Second temp turn');
    const secondPayload = submitSpy.mock.calls[1]?.[0];
    expect(secondPayload?.sessionId).toBe('sess_temp_1');
    expect('ephemeral' in (secondPayload ?? {})).toBe(false);

    // Clicking New Chat purges with keepalive: true once
    harness.actions.startNewChat();
    expect(deleteSpy).toHaveBeenCalledExactlyOnceWith('sess_temp_1', { keepalive: true });
    expect(harness.state.activeSessionId).toBeNull();
    expect(harness.state.activeSessionTemporary).toBe(false);

    // Switching from another active Temporary Chat purges it with keepalive: true
    const switchHarness = createHookHarness(
      {
        ...initialChatState,
        activeSessionId: 'sess_temp_2',
        activeSessionTemporary: true,
      },
      client,
    );
    await switchHarness.actions.selectSession('sess_saved_1', 'Saved chat');
    expect(deleteSpy).toHaveBeenCalledWith('sess_temp_2', { keepalive: true });
    expect(listMessagesSpy).toHaveBeenCalledWith('sess_saved_1');
    expect(switchHarness.state.activeSessionTemporary).toBe(false);
  });

  it('purges an active Temporary Chat on pagehide and detaches the listener on cleanup', () => {
    const listeners = new Map<string, Set<() => void>>();
    const target = {
      addEventListener: (type: string, listener: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
      },
    };
    const onPurge = vi.fn();
    let activeTempId: string | null = null;
    const cleanup = startTemporaryChatPagehideEffect({
      target,
      getActiveTemporarySessionId: () => activeTempId,
      onPurge,
    });

    // Unsaved temporary chat (null id): no purge on pagehide.
    listeners.get('pagehide')?.forEach((fn) => fn());
    expect(onPurge).not.toHaveBeenCalled();

    // Active temporary chat: purges synchronously on pagehide.
    activeTempId = 'sess_temp_unload';
    listeners.get('pagehide')?.forEach((fn) => fn());
    expect(onPurge).toHaveBeenCalledExactlyOnceWith('sess_temp_unload');

    cleanup?.();
    listeners.get('pagehide')?.forEach((fn) => fn());
    expect(onPurge).toHaveBeenCalledTimes(1);
  });

  it('forwards memoryUpdated: true from completed SSE frames and blocks live voice lease in Temporary Chat', async () => {
    const client = new ApiClient({ fetch: vi.fn() });
    vi.spyOn(client, 'listSessions').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(client, 'submitTurn').mockResolvedValue({
      sessionId: 'sess_1',
      turnId: 'turn_1',
      attemptId: 'att_1',
      userMessageId: 'msg_u1',
      streamPath: '/sessions/sess_1/turns/turn_1/stream',
    });
    let streamHandler: StreamEventCallback | null = null;
    vi.spyOn(client, 'connectTurnStream').mockImplementation(async (_path, handlers) => {
      streamHandler = handlers.onEvent ?? null;
    });

    const harness = createHookHarness(initialChatState, client);
    await harness.actions.submitMessage('Remember I live in Chennai');
    streamHandler!(
      { type: 'delta', text: 'Saved Chennai to your memory.' },
      {
        protocolVersion: 1,
        sessionId: 'sess_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        sequence: 1,
        event: { type: 'delta', text: 'Saved Chennai to your memory.' },
      },
    );
    streamHandler!(
      { type: 'completed', assistantMessageId: 'msg_a1', outcome: 'completed', memoryUpdated: true },
      {
        protocolVersion: 1,
        sessionId: 'sess_1',
        turnId: 'turn_1',
        attemptId: 'att_1',
        sequence: 2,
        event: { type: 'completed', assistantMessageId: 'msg_a1', outcome: 'completed', memoryUpdated: true },
      },
    );
    await flushMicrotasks();
    expect(harness.state.messages.at(-1)).toMatchObject({
      messageId: 'msg_a1',
      memoryUpdated: true,
    });

    const tempHarness = createHookHarness(
      { ...initialChatState, activeSessionTemporary: true },
      client,
    );
    expect(tempHarness.actions.claimVoiceInput('live', vi.fn())).toBeNull();
  });
});
