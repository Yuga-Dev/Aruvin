/**
 * ============================================================================
 * FILE: Composer.tsx
 * LOCATION: frontend/src/components/Composer.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Multiline composer with Enter send, Shift+Enter newline, and cancel.
 *
 * ROLE IN PROJECT:
 *    Captures user input against the 32k contract budget, auto-sizes the
 *    textarea, and switches Send for Cancel while a turn is streaming.
 *    Drafting stays enabled during generation/finalization; Send stays gated.
 *
 * KEY COMPONENTS:
 *    - Auto-sizing textarea
 *    - Keyboard shortcuts
 *    - Send / Cancel actions and remaining-character warning
 * ============================================================================
 */

import { memo, useEffect, useRef, type KeyboardEvent } from 'react';
import type { ContextUsageMeta } from '../api/protocol.ts';
import type { ChatState } from '../features/chat/state/chat-types.ts';
import { useChat } from '../features/chat/state/chat-context.tsx';
import { ComposerVoiceControls } from '../features/voice/components/ComposerVoiceControls.tsx';
import { useDictation } from '../features/voice/dictation/useDictation.ts';
import { IconSend, IconStop } from './icons.tsx';

const MAX_INPUT_CHARS = 32_000;

export type ContextMeterDisplay = {
  percent: number;
  barPercent: number;
  status: 'idle' | 'compacting';
  high: boolean;
  label: string;
  detail: string;
};

// oxlint-disable-next-line react/only-export-components -- pure meter formatting helper shared with tests
export function getContextMeterDisplay(
  usage: ContextUsageMeta | null | undefined,
): ContextMeterDisplay | null {
  if (!usage) return null;
  if (usage.status !== 'compacting' && usage.utilizationPercent <= 50) {
    return null;
  }
  const percent = Math.max(0, Math.round(usage.utilizationPercent));
  const barPercent = Math.min(100, percent);
  const label =
    usage.status === 'compacting'
      ? 'Compacting context…'
      : `Context ${percent}%`;
  const detail = `${usage.historyTokens.toLocaleString()} / ${usage.maxHistoryTokens.toLocaleString()} history tokens`;
  return {
    percent,
    barPercent,
    status: usage.status,
    high: percent >= 80,
    label,
    detail,
  };
}

export function Composer({ variant = 'docked' }: { variant?: 'docked' | 'centered' }) {
  const { state, actions, dispatch, startVoiceConversation } = useChat();
  const turnBusy =
    state.isSubmitting ||
    state.isStreaming ||
    state.turnStatus === 'accepted' ||
    state.turnStatus === 'generating' ||
    state.turnStatus === 'finalizing';
  const showCancel =
    state.isStreaming ||
    (turnBusy && state.activeTurnMode !== 'live' && Boolean(state.activeTurnId && state.activeAttemptId));
  return <ComposerContent variant={variant} actions={actions} dispatch={dispatch}
    startVoiceConversation={startVoiceConversation} draftInput={state.draftInput}
    activeSessionId={state.activeSessionId} voiceInput={state.voiceInput}
    turnBusy={turnBusy} showCancel={showCancel}
    messagesLoading={state.messagesLoading} contextUsage={state.contextUsage} />;
}

const ComposerContent = memo(function ComposerContent({ variant, actions, dispatch,
  startVoiceConversation, ...state }: Pick<ChatState, 'draftInput' | 'activeSessionId' |
    'voiceInput' | 'messagesLoading' | 'contextUsage'> &
  Pick<ReturnType<typeof useChat>, 'actions' | 'dispatch' | 'startVoiceConversation'> &
  { variant: 'docked' | 'centered'; turnBusy: boolean; showCancel: boolean }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const dictation = useDictation({ textareaRef, draft: state.draftInput,
    conversationId: state.activeSessionId, bindings: actions });
  const voiceLocked = dictation.locked || state.voiceInput !== null;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    if (voiceLocked) {
      if (el.scrollHeight > el.clientHeight) {
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
      }
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [state.draftInput, voiceLocked]);

  const isOverBudget = state.draftInput.length > MAX_INPUT_CHARS;
  const isSubmitDisabled =
    !state.draftInput.trim() || state.turnBusy || isOverBudget || voiceLocked;
  const contextMeter =
    variant === 'docked' && state.voiceInput?.mode !== 'live'
      ? getContextMeterDisplay(state.contextUsage)
      : null;

  const submit = () => {
    if (!isSubmitDisabled && !actions.isVoiceInputLocked()) void actions.submitMessage();
  };
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && dictation.locked) {
      e.preventDefault();
      dictation.cancel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <footer
      className={`aurvin-composer aurvin-composer-${variant}`}
      role="region"
      aria-label="Message composer"
    >
      <div className="aurvin-composer-box">
        <textarea
          ref={textareaRef}
          className="aurvin-textarea"
          value={state.draftInput}
          onChange={(e) => {
            if (!voiceLocked && !actions.isVoiceInputLocked()) {
              dispatch({ type: 'SET_DRAFT', payload: e.target.value });
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder="Ask Aurvin"
          aria-label="Message input"
          rows={1}
          readOnly={voiceLocked}
          autoFocus={variant === 'centered'}
        />

        <ComposerVoiceControls config={dictation.config} locked={dictation.locked}
          recording={dictation.phase === 'recording'} finalizing={dictation.phase === 'finalizing'}
          textBusy={state.turnBusy || state.messagesLoading || isOverBudget}
          otherMode={state.voiceInput?.mode === 'live'} status={dictation.status} notice={dictation.notice}
          onDictate={dictation.start}
          onLive={startVoiceConversation ? () => {
            if (!actions.isVoiceInputLocked() && !isOverBudget && !state.turnBusy &&
              !state.messagesLoading) startVoiceConversation();
          } : undefined}
          onStop={dictation.stop} onCancel={dictation.cancel} />

        {state.showCancel ? (
          <button
            type="button"
            className="aurvin-cancel-btn"
            onClick={() => {
              void actions.cancelCurrentTurn();
            }}
            aria-label="Cancel response"
          >
            <IconStop />
          </button>
        ) : (
          <button
            type="button"
            className="aurvin-send-btn"
            onClick={submit}
            disabled={isSubmitDisabled}
            aria-label="Send message"
          >
            <IconSend />
          </button>
        )}
      </div>

      {contextMeter || state.draftInput.length > 25_000 ? (
        <div className="aurvin-composer-meta">
          {contextMeter ? (
            <div
              className="aurvin-context-meter"
              data-status={contextMeter.status}
              data-high={contextMeter.high ? 'true' : 'false'}
              title={contextMeter.detail}
              aria-label={`${contextMeter.label} (${contextMeter.detail})`}
            >
              <span className="aurvin-context-meter-track" aria-hidden="true">
                <span
                  className="aurvin-context-meter-fill"
                  style={{ width: `${contextMeter.barPercent}%` }}
                />
              </span>
              <span className="aurvin-context-meter-label">{contextMeter.label}</span>
            </div>
          ) : (
            <span />
          )}
          {state.draftInput.length > 25_000 ? (
            <div className="aurvin-char-count" data-over={isOverBudget}>
              {state.draftInput.length} / {MAX_INPUT_CHARS}
            </div>
          ) : null}
        </div>
      ) : null}
    </footer>
  );
});

