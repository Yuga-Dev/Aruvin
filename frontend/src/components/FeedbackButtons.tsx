/**
 * ============================================================================
 * FILE: FeedbackButtons.tsx
 * LOCATION: frontend/src/components/FeedbackButtons.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Thumbs up/down control for a saved assistant message (no free text).
 *
 * ROLE IN PROJECT:
 *    Release 1 feedback. Plugged into the MessageItem action row. Optimistic
 *    rating with rollback; never touches chat admission or the reducer.
 *
 * KEY COMPONENTS:
 *    - nextRating / submitFeedback: pure toggle and optimistic-with-rollback logic.
 *    - FeedbackButtons: two aria-pressed buttons, disabled until the message is saved.
 * ============================================================================
 */

import { useState } from 'react';
import type { FeedbackRating, VisibleMessage } from '../api/protocol.ts';
import { useChat } from '../features/chat/state/chat-context.tsx';

/** Completed (or length-truncated) text answers only; live voice and in-flight messages never qualify. */
export function isFeedbackEligible(m: Pick<VisibleMessage, 'role' | 'completionStatus' | 'voiceSessionId' | 'mode' | 'messageId'>): boolean {
  return m.role === 'assistant' && (m.completionStatus === 'completed' || m.completionStatus === 'truncated') &&
    !m.voiceSessionId && m.mode !== 'live' && m.messageId !== 'streaming_in_flight';
}

/** Pressing the active rating again clears it. */
export function nextRating(current: FeedbackRating | null, pressed: FeedbackRating): FeedbackRating | null {
  return current === pressed ? null : pressed;
}

/** Apply optimistically, call the server, roll back and report on failure. */
export async function submitFeedback(args: {
  current: FeedbackRating | null;
  pressed: FeedbackRating;
  put: (rating: FeedbackRating | null) => Promise<unknown>;
  set: (rating: FeedbackRating | null) => void;
  onError: () => void;
}): Promise<void> {
  const next = nextRating(args.current, args.pressed);
  args.set(next);
  try { await args.put(next); } catch { args.set(args.current); args.onError(); }
}

const ICON = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export function FeedbackButtonsView({ rating, disabled, pending, error, onPress }: {
  rating: FeedbackRating | null;
  disabled: boolean;
  pending: boolean;
  error: boolean;
  onPress: (rating: FeedbackRating) => void;
}) {
  const button = (kind: FeedbackRating, label: string, path: string) => (
    <button
      type="button"
      className="aurvin-copy-btn aurvin-feedback-btn"
      aria-label={label}
      aria-pressed={rating === kind}
      data-active={rating === kind ? 'true' : 'false'}
      disabled={disabled || pending}
      onClick={() => onPress(kind)}
    >
      <svg {...ICON} fill={rating === kind ? 'currentColor' : 'none'}><path d={path} /></svg>
      <span className="aurvin-copy-tooltip" role="tooltip">{disabled ? 'Saving…' : label}</span>
    </button>
  );
  return (
    <>
      {button('up', 'Good response', 'M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2l-1 6a2 2 0 0 1-2 2H7')}
      {button('down', 'Bad response', 'M17 13V4h3v9zM17 13l-4 8a2 2 0 0 1-2-2v-4H5a2 2 0 0 1-2-2l1-6a2 2 0 0 1 2-2h11')}
      {error ? <span className="aurvin-feedback-error" role="alert">Couldn&apos;t save your feedback</span> : null}
    </>
  );
}

export function FeedbackButtons({ sessionId, messageId, initial, saved }: {
  sessionId: string;
  messageId: string;
  initial?: FeedbackRating;
  /** False while the message is not yet durable; the server would answer MESSAGE_NOT_SAVED. */
  saved: boolean;
}) {
  const { client } = useChat();
  const [rating, setRating] = useState<FeedbackRating | null>(initial ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return (
    <FeedbackButtonsView
      rating={rating}
      disabled={!saved}
      pending={pending}
      error={error}
      onPress={(pressed) => {
        setError(false); setPending(true);
        void submitFeedback({
          current: rating, pressed, set: setRating, onError: () => setError(true),
          put: (r) => client.putFeedback(sessionId, messageId, r),
        }).finally(() => setPending(false));
      }}
    />
  );
}
