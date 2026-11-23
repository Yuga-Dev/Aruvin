/**
 * ============================================================================
 * FILE: user-memory.test.ts
 * LOCATION: frontend/src/features/chat/integration-tests/user-memory.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Integrated Node-environment tests for User Memory UX and Temporary Chat.
 *
 * ROLE IN PROJECT:
 *    Verifies the P1->P6 voice contract mirror, explicit and passive memory
 *    indicator flows, Temporary Chat purge/isolation lifecycle, Live Voice
 *    gating, and navigation to Personalization MemoryCard without jsdom.
 *
 * KEY COMPONENTS:
 *    - Voice protocol ephemeral guard tests
 *    - Explicit SSE and passive listMessages memoryUpdated -> pill -> MemoryCard seam
 *    - Temporary Chat lifecycle: toggle, lock, sidebar exclusion, keepalive DELETE
 *    - Live Voice gate and App.tsx wiring verification
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../../api/client.ts';
import type { VisibleMessage } from '../../../api/protocol.ts';
import {
  DEFAULT_VOICE_LIMITS,
  isCreateVoiceSessionRequest,
  isVoiceLimits,
} from '../../../api/voice-protocol.ts';
import { MessageItem } from '../../../components/MessageItem.tsx';
import { focusMemoryCardElement } from '../../admin-config/AdminDashboard.tsx';
import { MemoryCard, MEMORY_CARD_ELEMENT_ID } from '../../personalization/MemoryCard.tsx';
import { initialUserMemoryState } from '../../personalization/user-memory-state.ts';
import { ChatView, getTemporaryChatHeaderState } from '../ChatView.tsx';
import { ChatProvider } from '../state/chat-context.tsx';
import {
  canStartLiveVoiceForChat,
  canToggleTemporaryChat,
  chatReducer,
  initialChatState,
  TEMPORARY_LIVE_VOICE_ENABLED,
} from '../state/chat-reducer.ts';
import type { ChatAction, ChatState } from '../state/chat-types.ts';
import { startTemporaryChatPagehideEffect, useChatActions } from '../state/use-chat.ts';

function sseResponse(frames: unknown[]): Response {
  const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function createActionHarness(initial: ChatState, client: ApiClient) {
  let state = initial;
  const dispatch = (action: ChatAction) => {
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
    dispatch,
    render,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('P6 voice protocol ephemeral mirror', () => {
  const baseRequest = {
    protocolVersion: 1 as const,
    mode: 'live' as const,
    conversationId: null,
    locale: 'en-US' as const,
    idempotencyKey: 'voice-temp-key-1',
  };

  it('accepts optional boolean ephemeral on CreateVoiceSessionRequest and rejects invalid values', () => {
    expect(isCreateVoiceSessionRequest(baseRequest)).toBe(true);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: true })).toBe(true);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: false })).toBe(true);

    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: 'true' })).toBe(false);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: 1 })).toBe(false);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: null })).toBe(false);
    expect(isCreateVoiceSessionRequest({ ...baseRequest, ephemeral: true, extra: 1 })).toBe(false);
  });

  it('preserves voice-limits re-exports alongside the ephemeral mirror', () => {
    expect(isVoiceLimits(DEFAULT_VOICE_LIMITS)).toBe(true);
  });
});

describe('P6 user memory indicator integration (explicit SSE + passive hydration + MemoryCard target)', () => {
  it('streams explicit memoryUpdated: true end-to-end and targets the real MemoryCard anchor', async () => {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/sessions' && init?.method === 'POST') {
        return Response.json(
          {
            sessionId: 'sess_mem_1',
            turnId: 'turn_1',
            attemptId: 'att_1',
            userMessageId: 'msg_u1',
            streamPath: '/sessions/sess_mem_1/turns/turn_1/stream',
          },
          { status: 202 },
        );
      }
      if (url === '/api/sessions/sess_mem_1/turns/turn_1/stream') {
        return sseResponse([
          {
            protocolVersion: 1,
            sessionId: 'sess_mem_1',
            turnId: 'turn_1',
            attemptId: 'att_1',
            sequence: 1,
            event: { type: 'delta', text: 'I will remember that Beans is your dog.' },
          },
          {
            protocolVersion: 1,
            sessionId: 'sess_mem_1',
            turnId: 'turn_1',
            attemptId: 'att_1',
            sequence: 2,
            event: {
              type: 'completed',
              assistantMessageId: 'msg_a1',
              outcome: 'completed',
              memoryUpdated: true,
            },
          },
        ]);
      }
      return Response.json({ items: [], nextCursor: null });
    };

    const client = new ApiClient({ baseUrl: '/api', fetch: fetchFn, recoveryStorage: null });
    const harness = createActionHarness(initialChatState, client);

    await harness.actions.submitMessage('Remember my dog is Beans.');
    const assistant = harness.state.messages.find((m) => m.messageId === 'msg_a1');
    expect(assistant?.memoryUpdated).toBe(true);

    const pillHtml = renderToStaticMarkup(
      createElement(MessageItem, { message: assistant!, onOpenMemorySettings: vi.fn() }),
    );
    expect(pillHtml).toContain('aurvin-memory-updated-pill');
    expect(pillHtml).toContain('Memory updated');

    // Verify P5 MemoryCard renders the exact anchor targeted by AdminDashboard.focusMemoryCardElement.
    const memoryCardHtml = renderToStaticMarkup(
      createElement(MemoryCard, { initialState: initialUserMemoryState() }),
    );
    expect(memoryCardHtml).toContain(`id="${MEMORY_CARD_ELEMENT_ID}"`);

    const focus = vi.fn();
    const scrollIntoView = vi.fn();
    expect(
      focusMemoryCardElement({
        getElementById: (id) =>
          id === MEMORY_CARD_ELEMENT_ID ? ({ focus, scrollIntoView } as unknown as HTMLElement) : null,
      }),
    ).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });

  it('hydrates passive batch memoryUpdated: true on selectSession without marking earlier turns', async () => {
    const serverMessages: VisibleMessage[] = [
      {
        messageId: 'm_1',
        turnId: 't_1',
        eventId: 'e_1',
        sequence: 1,
        role: 'user',
        content: 'I build Aurvin in TypeScript.',
        createdAt: '2026-11-20T12:00:00.000Z',
        completionStatus: 'completed',
        truncated: false,
      },
      {
        messageId: 'm_2',
        turnId: 't_1',
        eventId: 'e_2',
        sequence: 2,
        role: 'assistant',
        content: 'Sounds like a solid stack.',
        createdAt: '2026-11-20T12:00:02.000Z',
        completionStatus: 'completed',
        truncated: false,
      },
      {
        messageId: 'm_3',
        turnId: 't_2',
        eventId: 'e_3',
        sequence: 3,
        role: 'user',
        content: 'I prefer concise dark UIs.',
        createdAt: '2026-11-20T12:01:00.000Z',
        completionStatus: 'completed',
        truncated: false,
      },
      {
        messageId: 'm_4',
        turnId: 't_2',
        eventId: 'e_4',
        sequence: 4,
        role: 'assistant',
        content: 'Good preference to keep in mind.',
        createdAt: '2026-11-20T12:01:02.000Z',
        completionStatus: 'completed',
        truncated: false,
        memoryUpdated: true,
      },
    ];
    const fetchFn: typeof fetch = async () =>
      Response.json({ items: serverMessages, nextCursor: null, olderAvailable: false });
    const client = new ApiClient({ baseUrl: '/api', fetch: fetchFn, recoveryStorage: null });
    const harness = createActionHarness(initialChatState, client);

    await harness.actions.selectSession('sess_passive', 'Stack chat');
    expect(harness.state.messages.map((m) => m.memoryUpdated ?? false)).toEqual([
      false,
      false,
      false,
      true,
    ]);

    const firstReplyHtml = renderToStaticMarkup(
      createElement(MessageItem, { message: harness.state.messages[1]! }),
    );
    const lastReplyHtml = renderToStaticMarkup(
      createElement(MessageItem, { message: harness.state.messages[3]!, onOpenMemorySettings: vi.fn() }),
    );
    expect(firstReplyHtml).not.toContain('aurvin-memory-updated-pill');
    expect(lastReplyHtml).toContain('aurvin-memory-updated-pill');
  });
});

describe('P6 Temporary Chat end-to-end lifecycle and Live Voice gate', () => {
  it('executes toggle -> turn 1 ephemeral -> lock -> turn 2 -> keepalive DELETE purge on exit and pagehide', async () => {
    const requests: Array<{ url: string; method: string; body?: string; keepalive?: boolean }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({
        url,
        method,
        body: typeof init?.body === 'string' ? init.body : undefined,
        keepalive: init?.keepalive,
      });

      if (url === '/api/sessions' && method === 'POST') {
        return Response.json(
          {
            sessionId: 'sess_temp_e2e',
            turnId: 'turn_1',
            attemptId: 'att_1',
            userMessageId: 'msg_u1',
            streamPath: '/sessions/sess_temp_e2e/turns/turn_1/stream',
            processEpoch: 'epoch_1',
          },
          { status: 202 },
        );
      }
      if (url === '/api/sessions/sess_temp_e2e/turns' && method === 'POST') {
        return Response.json(
          {
            sessionId: 'sess_temp_e2e',
            turnId: 'turn_2',
            attemptId: 'att_2',
            userMessageId: 'msg_u2',
            streamPath: '/sessions/sess_temp_e2e/turns/turn_2/stream',
            processEpoch: 'epoch_1',
          },
          { status: 202 },
        );
      }
      if (url.endsWith('/stream')) {
        const turnId = url.includes('turn_1') ? 'turn_1' : 'turn_2';
        const attemptId = turnId === 'turn_1' ? 'att_1' : 'att_2';
        return sseResponse([
          {
            protocolVersion: 1,
            sessionId: 'sess_temp_e2e',
            turnId,
            attemptId,
            sequence: 1,
            event: { type: 'delta', text: `Reply for ${turnId}` },
          },
          {
            protocolVersion: 1,
            sessionId: 'sess_temp_e2e',
            turnId,
            attemptId,
            sequence: 2,
            event: { type: 'completed', assistantMessageId: `asst_${turnId}`, outcome: 'completed' },
          },
        ]);
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return Response.json({ items: [], nextCursor: null, olderAvailable: false });
    };

    const client = new ApiClient({ baseUrl: '/api', fetch: fetchFn, recoveryStorage: null });
    const harness = createActionHarness(initialChatState, client);

    // 1. Toggle Temporary Chat ON before turn 1
    harness.dispatch({ type: 'SET_TEMPORARY_CHAT', payload: true });
    expect(harness.state.activeSessionTemporary).toBe(true);
    expect(canToggleTemporaryChat(harness.state)).toBe(true);
    expect(TEMPORARY_LIVE_VOICE_ENABLED).toBe(false);
    expect(canStartLiveVoiceForChat(harness.state)).toBe(false);
    expect(getTemporaryChatHeaderState(harness.state, false)).toEqual({
      showToggle: true,
      togglePressed: true,
      showActivePill: true,
    });
    harness.render();

    // 2. Turn 1 creates ephemeral session, locks toggle, excludes sidebar
    await harness.actions.submitMessage('Temporary turn 1');
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({
      sessionId: null,
      ephemeral: true,
      content: 'Temporary turn 1',
    });
    expect(harness.state.activeSessionId).toBe('sess_temp_e2e');
    expect(harness.state.sessions).toEqual([]);
    expect(canToggleTemporaryChat(harness.state)).toBe(false);
    expect(getTemporaryChatHeaderState(harness.state, false)).toEqual({
      showToggle: false,
      togglePressed: false,
      showActivePill: true,
    });
    expect(requests.some((r) => r.url === '/api/sessions' && r.method === 'GET')).toBe(false);

    // 3. Turn 2 omits ephemeral (creation-only on wire)
    harness.render();
    await harness.actions.submitMessage('Temporary turn 2');
    const turn2Body = JSON.parse(
      requests.find((r) => r.url === '/api/sessions/sess_temp_e2e/turns')!.body!,
    ) as Record<string, unknown>;
    expect(turn2Body.sessionId).toBe('sess_temp_e2e');
    expect('ephemeral' in turn2Body).toBe(false);

    // 4. Exit via pagehide fires DELETE with keepalive: true
    const pagehideListeners: Array<() => void> = [];
    const stopPagehide = startTemporaryChatPagehideEffect({
      target: {
        addEventListener: (_type, fn) => {
          pagehideListeners.push(fn);
        },
        removeEventListener: () => {
          pagehideListeners.length = 0;
        },
      },
      getActiveTemporarySessionId: () =>
        harness.state.activeSessionTemporary ? harness.state.activeSessionId : null,
      onPurge: (id) => {
        void client.deleteSession(id, { keepalive: true });
      },
    });
    pagehideListeners.forEach((fn) => fn());
    stopPagehide?.();

    const deletes = requests.filter((r) => r.method === 'DELETE');
    expect(deletes).toEqual([
      expect.objectContaining({
        url: '/api/sessions/sess_temp_e2e',
        method: 'DELETE',
        keepalive: true,
      }),
    ]);

    // 5. Mounted ChatProvider + ChatView renders Temporary chat toggle cleanly on fresh New Chat
    const html = renderToStaticMarkup(
      createElement(ChatProvider, {
        client,
        startVoiceConversation: vi.fn(),
        // oxlint-disable-next-line react/no-children-prop -- createElement requires children as a prop
        children: createElement(ChatView),
      }),
    );
    expect(html).toContain('aurvin-temp-chat-toggle');
  });

  it('keeps App.tsx wired for onOpenMemorySettings, focusTarget, and temporaryChat without client storage or secret flags', () => {
    const appSource = readFileSync('src/App.tsx', 'utf8');
    expect(appSource).toContain('onOpenMemorySettings');
    expect(appSource).toContain('focusTarget={adminFocusTarget}');
    expect(appSource).toContain('temporaryChat: state.activeSessionTemporary');
    expect(appSource).not.toMatch(/VITE_|localStorage|sessionStorage/);
  });
});
