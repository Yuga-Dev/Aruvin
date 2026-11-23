/**
 * ============================================================================
 * FILE: ChatView.test.ts
 * LOCATION: frontend/src/features/chat/ChatView.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify ChatView exports, Temporary Chat header states, and Memory updated pill.
 *
 * ROLE IN PROJECT:
 *    Node-environment SSR checks for the assembled chat feature view, header
 *    Temporary Chat toggle/lock/pill, clickable memory indicator, and focus helper.
 *
 * KEY COMPONENTS:
 *    - Temporary Chat header toggle vs locked active pill assertions
 *    - Minimalistic ✓ Memory updated pill on assistant turns only
 *    - AdminDashboard focusMemoryCardElement seam targeting #aurvin-personalization-memory
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisibleMessage } from '../../api/protocol.ts';
import { MessageItem, shouldShowMemoryUpdatedPill } from '../../components/MessageItem.tsx';
import { Transcript } from '../../components/Transcript.tsx';
import { focusMemoryCardElement } from '../admin-config/AdminDashboard.tsx';
import { MEMORY_CARD_ELEMENT_ID } from '../personalization/MemoryCard.tsx';
import { ChatView, getTemporaryChatHeaderState } from './ChatView.tsx';
import { initialChatState } from './state/chat-reducer.ts';
import type { ChatState } from './state/chat-types.ts';

const chatContext = vi.hoisted(() => ({
  state: {} as ChatState,
  dispatch: vi.fn(),
  actions: {
    startNewChat: vi.fn(),
    continueInNewChat: vi.fn(),
    selectSession: vi.fn(),
    loadOlderMessages: vi.fn(),
    loadMoreSessions: vi.fn(),
    setDraft: vi.fn(),
    submitMessage: vi.fn(),
    retrySave: vi.fn(),
    cancelCurrentTurn: vi.fn(),
    retryTurn: vi.fn(),
    isVoiceInputLocked: vi.fn(() => false),
    claimVoiceInput: vi.fn(() => null),
    writeVoiceDraft: vi.fn(() => false),
    releaseVoiceInput: vi.fn(),
    bindVoiceConversation: vi.fn(() => false),
  },
  client: {} as Record<string, unknown>,
  startVoiceConversation: undefined as (() => void) | undefined,
}));

vi.mock('./state/chat-context.tsx', () => ({ useChat: () => chatContext }));
vi.mock('../voice/dictation/useDictation.ts', () => ({
  useDictation: () => ({
    config: null,
    locked: false,
    phase: 'idle',
    status: '',
    notice: null,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  }),
}));

function assistantMessage(overrides: Partial<VisibleMessage> = {}): VisibleMessage {
  return {
    messageId: 'msg_a1',
    turnId: 'turn_1',
    eventId: 'evt_a1',
    sequence: 2,
    role: 'assistant',
    content: 'Noted — I will remember your preference.',
    createdAt: '2026-11-20T12:00:00.000Z',
    completionStatus: 'completed',
    truncated: false,
    ...overrides,
  };
}

describe('ChatView component, Temporary Chat header, and Memory updated pill', () => {
  beforeEach(() => {
    chatContext.state = { ...initialChatState };
    chatContext.dispatch.mockReset();
  });

  it('is exported as a React functional component', () => {
    expect(typeof ChatView).toBe('function');
  });

  it('shows Temporary chat toggle on unsaved New Chat, active pill when enabled, and locks toggle after turn 1', () => {
    // 1. Unsaved New Chat (temporary off): toggle visible, active pill hidden
    expect(getTemporaryChatHeaderState(chatContext.state, false)).toEqual({
      showToggle: true,
      togglePressed: false,
      showActivePill: false,
    });
    const idleHtml = renderToStaticMarkup(createElement(ChatView));
    expect(idleHtml).toContain('aurvin-temp-chat-toggle');
    expect(idleHtml).toContain('aria-pressed="false"');
    expect(idleHtml).not.toContain('Temporary chat — not saved, memory off');

    // 2. Unsaved New Chat (temporary on): toggle pressed + active pill visible
    chatContext.state = { ...initialChatState, activeSessionTemporary: true };
    const armedHtml = renderToStaticMarkup(createElement(ChatView));
    expect(armedHtml).toContain('aurvin-temp-chat-toggle');
    expect(armedHtml).toContain('aria-pressed="true"');
    expect(armedHtml).toContain('Temporary chat — not saved, memory off');

    // 3. After turn 1 in Temporary Chat: toggle locked (hidden), active pill stays visible, save banner suppressed
    chatContext.state = {
      ...initialChatState,
      activeSessionId: 'sess_temp_1',
      activeSessionTemporary: true,
      messages: [assistantMessage({ content: 'Temporary answer' })],
      saves: {
        sess_temp_1: {
          turnId: 'turn_1',
          value: { state: 'saving', epoch: 'epoch_1', version: 1, durableVersion: 0 },
        },
      },
    };
    const lockedHtml = renderToStaticMarkup(createElement(ChatView));
    expect(lockedHtml).not.toContain('aurvin-temp-chat-toggle');
    expect(lockedHtml).toContain('Temporary chat — not saved, memory off');
    expect(lockedHtml).not.toContain('Answer ready. Saving');

    // 4. Normal saved chat: neither toggle nor temporary pill rendered
    chatContext.state = {
      ...initialChatState,
      activeSessionId: 'sess_saved_1',
      activeSessionTemporary: false,
      messages: [assistantMessage({ content: 'Saved answer' })],
    };
    const savedHtml = renderToStaticMarkup(createElement(ChatView));
    expect(savedHtml).not.toContain('aurvin-temp-chat-toggle');
    expect(savedHtml).not.toContain('Temporary chat — not saved, memory off');
  });

  it('renders minimalistic clickable Memory updated pill only for assistant messages with memoryUpdated: true', () => {
    const updated = assistantMessage({ memoryUpdated: true });
    expect(shouldShowMemoryUpdatedPill(updated)).toBe(true);
    expect(shouldShowMemoryUpdatedPill(assistantMessage({ memoryUpdated: false }))).toBe(false);
    expect(shouldShowMemoryUpdatedPill(assistantMessage())).toBe(false);
    expect(shouldShowMemoryUpdatedPill({ role: 'user', memoryUpdated: true })).toBe(false);

    const updatedHtml = renderToStaticMarkup(
      createElement(MessageItem, { message: updated, onOpenMemorySettings: vi.fn() }),
    );
    expect(updatedHtml).toContain('aurvin-memory-updated-pill');
    expect(updatedHtml).toContain('Memory updated');
    expect(updatedHtml).toContain('Open Personalization memory settings');

    const plainHtml = renderToStaticMarkup(createElement(MessageItem, { message: assistantMessage() }));
    expect(plainHtml).not.toContain('aurvin-memory-updated-pill');
    expect(plainHtml).not.toContain('Memory updated');

    // Transcript suppresses memory pill in Temporary Chat defensively.
    chatContext.state = {
      ...initialChatState,
      activeSessionId: 'sess_temp_1',
      activeSessionTemporary: true,
      messages: [updated],
    };
    const tempTranscriptHtml = renderToStaticMarkup(
      createElement(Transcript, { onOpenMemorySettings: vi.fn() }),
    );
    expect(tempTranscriptHtml).not.toContain('aurvin-memory-updated-pill');
  });

  it('focuses and scrolls to P5 MemoryCard element id via focusMemoryCardElement', () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const doc = {
      getElementById: vi.fn((id: string) =>
        id === MEMORY_CARD_ELEMENT_ID ? ({ scrollIntoView, focus } as unknown as HTMLElement) : null,
      ),
    };
    expect(focusMemoryCardElement(doc)).toBe(true);
    expect(doc.getElementById).toHaveBeenCalledWith(MEMORY_CARD_ELEMENT_ID);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focusMemoryCardElement({ getElementById: () => null })).toBe(false);
  });
});
