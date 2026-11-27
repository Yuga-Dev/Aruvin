/**
 * ============================================================================
 * FILE: FeedbackButtons.test.ts
 * LOCATION: frontend/src/components/FeedbackButtons.test.ts
 * ============================================================================
 * PURPOSE: Verify optimistic feedback with rollback, saved-state gating, aria-pressed and eligibility.
 * ROLE IN PROJECT: Node-environment checks for Release 1 feedback UI logic.
 * KEY COMPONENTS: submitFeedback, FeedbackButtonsView markup, isFeedbackEligible, MessageItem slot.
 * ============================================================================
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client.ts';
import type { VisibleMessage } from '../api/protocol.ts';
import { ChatProvider } from '../features/chat/state/chat-context.tsx';
import { FeedbackButtonsView, isFeedbackEligible, nextRating, submitFeedback } from './FeedbackButtons.tsx';
import { MessageItem } from './MessageItem.tsx';

const base: VisibleMessage = {
  messageId: 'a1', turnId: 't1', eventId: 'e1', sequence: 2, role: 'assistant', content: 'Hi',
  createdAt: '2026-11-27T00:00:00Z', completionStatus: 'completed', truncated: false,
};

describe('FeedbackButtons', () => {
  it('optimistic rating rolls back on error', async () => {
    const seen: unknown[] = [];
    const onError = vi.fn();
    await submitFeedback({ current: 'up', pressed: 'down', set: (r) => seen.push(r),
      put: async () => { throw new Error('boom'); }, onError });
    expect(seen).toEqual(['down', 'up']);
    expect(onError).toHaveBeenCalledOnce();
    const ok: unknown[] = [];
    const put = vi.fn(async () => ({}));
    await submitFeedback({ current: 'up', pressed: 'up', set: (r) => ok.push(r), put, onError });
    expect(ok).toEqual([null]);
    expect(put).toHaveBeenCalledWith(null);
    expect(nextRating(null, 'down')).toBe('down');
  });

  it('buttons are disabled until the message is saved', () => {
    const view = (disabled: boolean) => renderToStaticMarkup(createElement(FeedbackButtonsView,
      { rating: null, disabled, pending: false, error: false, onPress: () => undefined }));
    expect(view(true).match(/disabled=""/g)).toHaveLength(2);
    expect(view(true)).toContain('Saving…');
    expect(view(false)).not.toContain('disabled');
  });

  it('exposes aria-pressed', () => {
    const out = renderToStaticMarkup(createElement(FeedbackButtonsView,
      { rating: 'down', disabled: false, pending: false, error: true, onPress: () => undefined }));
    expect(out).toContain('aria-label="Good response" aria-pressed="false"');
    expect(out).toContain('aria-label="Bad response" aria-pressed="true"');
    expect(out).toContain('save your feedback');
  });

  it('shows feedback only for eligible messages and hides it for live voice', () => {
    expect(isFeedbackEligible(base)).toBe(true);
    expect(isFeedbackEligible({ ...base, completionStatus: 'truncated' })).toBe(true);
    for (const m of [{ role: 'user' as const }, { completionStatus: 'failed' as const }, { completionStatus: 'streaming' as const },
      { voiceSessionId: 'v1' }, { mode: 'live' as const }, { messageId: 'streaming_in_flight' }])
      expect(isFeedbackEligible({ ...base, ...m })).toBe(false);
    const client = new ApiClient({ fetch: async () => { throw new Error('no network'); } });
    const out = renderToStaticMarkup(createElement(ChatProvider, { client,
      children: createElement(MessageItem, { message: base, actionsEnd: createElement('i', { id: 'slot' }) }) }));
    expect(out).toContain('<i id="slot"></i>');
  });
});
