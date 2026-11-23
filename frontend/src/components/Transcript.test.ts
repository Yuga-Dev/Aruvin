/**
 * ============================================================================
 * FILE: Transcript.test.ts
 * LOCATION: frontend/src/components/Transcript.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Confirm transcript exports, context-independent historical rows, and the
 *    inline compaction checkpoint divider.
 *
 * ROLE IN PROJECT:
 *    Node-environment smoke check for transcript rendering modules.
 *
 * KEY COMPONENTS:
 *    - Export type assertions
 *    - Compaction divider placement and optional summary preview
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisibleMessage } from '../api/protocol.ts';
import { initialChatState } from '../features/chat/state/chat-reducer.ts';
import type { ChatState } from '../features/chat/state/chat-types.ts';
import { MessageItem } from './MessageItem.tsx';
import { CompactionDivider, Transcript, findCompactionDividerIndex } from './Transcript.tsx';

const chatContext = vi.hoisted(() => ({
  state: {} as ChatState,
  dispatch: vi.fn(),
  actions: {
    loadOlderMessages: vi.fn(),
    retryTurn: vi.fn(),
  },
}));

vi.mock('../features/chat/state/chat-context.tsx', () => ({
  useChat: () => chatContext,
}));

function makeMsg(sequence: number, role: 'user' | 'assistant'): VisibleMessage {
  return {
    messageId: `msg_${sequence}`,
    turnId: `turn_${Math.ceil(sequence / 2)}`,
    eventId: `evt_${sequence}`,
    sequence,
    role,
    content: `Body ${sequence}`,
    createdAt: '2026-11-17T12:00:00.000Z',
    completionStatus: 'completed',
    truncated: false,
  };
}

describe('Transcript and MessageItem components', () => {
  beforeEach(() => {
    chatContext.state = { ...initialChatState };
  });

  it('exports valid React components', () => {
    expect(typeof Transcript).toBe('function');
    expect(MessageItem).toMatchObject({ $$typeof: Symbol.for('react.memo') });
  });
  it('renders an immutable historical row without subscribing to the broad chat context', () => {
    const html = renderToStaticMarkup(createElement(MessageItem, { message: {
      messageId: 'm1', turnId: 't1', eventId: 'e1', sequence: 1, role: 'assistant',
      content: '**Archive** [unsafe](javascript:alert(1))', createdAt: '', completionStatus: 'completed', truncated: false,
    } }));
    expect(html).toContain('<strong>Archive</strong>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('Copy response');
  });

  it('places the checkpoint divider immediately after compactedThroughSequence or above a cold tail', () => {
    const full = [makeMsg(1, 'user'), makeMsg(2, 'assistant'), makeMsg(3, 'user'), makeMsg(4, 'assistant')];
    expect(findCompactionDividerIndex(full, null)).toBeNull();
    expect(findCompactionDividerIndex(full, { compactedThroughSequence: 2, compactionCycle: 1 })).toBe(1);
    expect(findCompactionDividerIndex([makeMsg(3, 'user'), makeMsg(4, 'assistant')], {
      compactedThroughSequence: 2,
      compactionCycle: 1,
    })).toBe(-1);
  });

  it('renders full scrollable history with an inline checkpoint divider and optional summary preview toggle', () => {
    chatContext.state = {
      ...initialChatState,
      activeSessionId: 'sess_1',
      olderAvailable: true,
      messages: [makeMsg(1, 'user'), makeMsg(2, 'assistant'), makeMsg(3, 'user'), makeMsg(4, 'assistant')],
      compaction: {
        compactedThroughSequence: 2,
        compactionCycle: 1,
        summaryPreview: 'User asked about architecture; settled on two-stage pipeline.',
      },
    };
    const html = renderToStaticMarkup(createElement(Transcript));
    expect(html).toContain('Load older messages');
    expect(html).toContain('Body 1');
    expect(html).toContain('Body 2');
    expect(html).toContain('Body 3');
    expect(html).toContain('Body 4');
    const body2Idx = html.indexOf('Body 2');
    const dividerIdx = html.indexOf('Earlier conversation compacted to preserve context');
    const body3Idx = html.indexOf('Body 3');
    expect(dividerIdx).toBeGreaterThan(body2Idx);
    expect(dividerIdx).toBeLessThan(body3Idx);
    expect(html).toContain('View summary');
    expect(html).not.toContain('User asked about architecture; settled on two-stage pipeline.');

    const expandedHtml = renderToStaticMarkup(
      createElement(CompactionDivider, {
        compaction: chatContext.state.compaction!,
        defaultExpanded: true,
      }),
    );
    expect(expandedHtml).toContain('Hide summary');
    expect(expandedHtml).toContain('User asked about architecture; settled on two-stage pipeline.');
  });

  it('renders checkpoint divider before the tail when older compacted messages are not loaded yet', () => {
    chatContext.state = {
      ...initialChatState,
      activeSessionId: 'sess_1',
      olderAvailable: true,
      messages: [makeMsg(11, 'user'), makeMsg(12, 'assistant')],
      compaction: { compactedThroughSequence: 10, compactionCycle: 2 },
    };
    const html = renderToStaticMarkup(createElement(Transcript));
    const dividerIdx = html.indexOf('Earlier conversation compacted to preserve context');
    const body11Idx = html.indexOf('Body 11');
    expect(dividerIdx).toBeGreaterThan(-1);
    expect(dividerIdx).toBeLessThan(body11Idx);
    expect(html).not.toContain('View summary');
  });
});
