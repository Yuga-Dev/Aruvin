/**
 * ============================================================================
 * FILE: MessageItem.tsx
 * LOCATION: frontend/src/components/MessageItem.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render safe message content, live placeholders, copy actions, voice pills,
 *    and inline post-call Canvas visual cards.
 *
 * ROLE IN PROJECT:
 *    Distinguishes user plaintext from assistant Markdown, renders Voice Chat
 *    indicator pills with transcript modals, surfaces inline spoken explanations
 *    and CanvasArtifactCard buttons for completed voice turns with visuals, and
 *    copies prompt or response text to the clipboard.
 *
 * KEY COMPONENTS:
 *    - MessageItem: Main message entry point supporting text, call pills, and inline voice visuals.
 *    - CopyMessageButton: Copies prompt or response text with copied feedback.
 *    - SafeMarkdown / CanvasArtifactCard: Assistant prose and Canvas visual triggers.
 *    - VoiceTranscriptModal: Hovering window modal displaying full call transcripts.
 * ============================================================================
 */

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { TaskCard } from './TaskCard.tsx';
import type { VisibleMessage } from '../api/protocol.ts';
import { isWeatherView } from '../api/weather-protocol.ts';
import {
  CanvasArtifactCard,
  extractVoiceMessageCanvasArtifacts,
  matchesWeatherArtifact,
  weatherViewArtifact,
} from '../features/canvas/index.ts';
import { parseCalendarConfirmationDetails } from '../features/plugins/google-calendar/CalendarTurnRegion.tsx';
import { WebSearchActivityView } from '../features/plugins/web-search/index.ts';
import { SafeMarkdown } from '../features/chat/markdown/safe-markdown.tsx';
import { IconCheck, IconCopy } from './icons.tsx';
import { getMessagePresentation } from './message-presentation.ts';
import { formatVoiceDuration, VoiceTranscriptModal } from './VoiceTranscriptModal.tsx';

const COPIED_FEEDBACK_MS = 1800;

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API unavailable in non-secure or headless context
  }
  return false;
}

function CopyMessageButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const actionLabel = copied ? 'Copied' : label;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className="aurvin-copy-btn"
      aria-label={actionLabel}
      onClick={() => {
        void copyTextToClipboard(text).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
    >
      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
      <span className="aurvin-copy-tooltip" role="tooltip">{actionLabel}</span>
    </button>
  );
}

// oxlint-disable-next-line react/only-export-components -- pure predicate shared with tests
export function shouldShowMemoryUpdatedPill(
  message: Pick<VisibleMessage, 'role' | 'memoryUpdated'>,
): boolean {
  return message.role === 'assistant' && message.memoryUpdated === true;
}

export const MessageItem = memo(function MessageItem({
  message,
  liveStatus,
  activeArtifactId = null,
  onOpenArtifact,
  onRetry,
  onSkipTaskStep,
  onOpenMemorySettings,
  actionsStart,
  actionsEnd,
}: {
  message: VisibleMessage;
  liveStatus?: string;
  activeArtifactId?: string | null;
  onOpenArtifact?: (artifactId: string) => void;
  onRetry?: (turnId: string) => void;
  /** Live task only: skip a queued step. */
  onSkipTaskStep?: (stepId: string) => Promise<void>;
  onOpenMemorySettings?: () => void;
  /** Release 1 slots in the action row: unit B plugs edit/regenerate in, unit C feedback. */
  actionsStart?: ReactNode;
  actionsEnd?: ReactNode;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const voiceArtifacts = useMemo(
    () => extractVoiceMessageCanvasArtifacts(message),
    [message],
  );
  const weatherArtifact = useMemo(() => {
    if (message.role !== 'assistant' || !message.weatherView || !isWeatherView(message.weatherView)) {
      return null;
    }
    const ownerId = message.messageId === 'streaming_in_flight' ? message.turnId : message.messageId;
    return weatherViewArtifact(message.weatherView, ownerId, message.turnId);
  }, [message]);
  const memoryUpdatedPill = shouldShowMemoryUpdatedPill(message) ? (
    <button
      type="button"
      className="aurvin-compaction-pill aurvin-memory-updated-pill"
      aria-label="Memory updated. Open Personalization memory settings"
      onClick={() => onOpenMemorySettings?.()}
      style={{
        gap: '5px',
        padding: '2px 10px',
        cursor: onOpenMemorySettings ? 'pointer' : 'default',
      }}
    >
      <IconCheck size={12} />
      <span>Memory updated</span>
    </button>
  ) : null;

  if (message.voiceSessionId) {
    const durationText = formatVoiceDuration(message.voiceDurationSeconds);
    const label =
      message.voiceDurationSeconds === undefined
        ? 'Voice message'
        : `Voice Chat · ${durationText}`;
    return (
      <article
        className="aurvin-voice-chat-indicator"
        data-voice-session-id={message.voiceSessionId}
      >
        <button
          type="button"
          className="aurvin-voice-chat-pill"
          title='"show transcript"'
          aria-label={`${label}. "show transcript"`}
          onClick={() => setModalOpen(true)}
        >
          <span className="aurvin-voice-chat-waveform" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <rect x="1.5" y="5" width="2" height="6" rx="1" />
              <rect x="5.5" y="2" width="2" height="12" rx="1" />
              <rect x="9.5" y="4" width="2" height="8" rx="1" />
              <rect x="13.5" y="6" width="2" height="4" rx="1" />
            </svg>
          </span>
          <span className="aurvin-voice-chat-label">{label}</span>
          <span className="aurvin-voice-tooltip" role="tooltip">&quot;show transcript&quot;</span>
        </button>
        {memoryUpdatedPill}
        {modalOpen ? (
          <VoiceTranscriptModal
            durationSeconds={message.voiceDurationSeconds}
            transcripts={message.voiceTranscripts ?? []}
            activeArtifactId={activeArtifactId}
            onOpenArtifact={onOpenArtifact}
            onClose={() => setModalOpen(false)}
          />
        ) : null}
      </article>
    );
  }

  const isUser = message.role === 'user';
  const status = liveStatus ?? message.completionStatus;
  const { generatingClassName, terminalStatus } = getMessagePresentation(message, liveStatus);
  const voiceExplanation =
    voiceArtifacts.length > 0
      ? (message.voiceTranscripts
          ?.filter((item) => item.role === 'assistant' && item.content.trim().length > 0)
          .map((item) => item.content.trim())
          .join('\n\n') ?? '')
      : '';
  const isCalendarConfirmation =
    message.role === 'assistant' &&
    /^Please confirm:\s*create\b/i.test(message.content);
  const rawContent = message.content.length > 0 ? message.content : voiceExplanation;
  const confirmation = isCalendarConfirmation
    ? parseCalendarConfirmationDetails(message.content)
    : null;
  const displayContent = confirmation
    ? `I can create "${confirmation.summary}"${confirmation.formattedTime ? ` (${confirmation.formattedTime})` : ''}. Does this look good?`
    : isCalendarConfirmation
      ? 'I can create this event for you. Does this look good?'
      : rawContent;
  const copyText = isUser ? message.content : displayContent;
  const canCopy = copyText.length > 0;
  const copyButton = canCopy ? (
    <CopyMessageButton
      text={copyText}
      label={isUser ? 'Copy message' : 'Copy response'}
    />
  ) : null;

  return (
    <article
      className={`aurvin-message ${isUser ? 'aurvin-message-user' : 'aurvin-message-assistant'}`}
      data-role={message.role}
      data-status={status}
      data-message-id={message.messageId}
      data-turn-id={message.turnId}
    >
      {isUser ? (
        <>
          <div className="aurvin-bubble">{message.content}</div>
          {copyButton}
        </>
      ) : (
        <div className="aurvin-message-body">
          {message.task ? <TaskCard task={message.task} {...(liveStatus && message.completionStatus === 'streaming' ? { onSkip: onSkipTaskStep } : {})} /> : null}
          {generatingClassName ? (
            <span className={generatingClassName}>Generating…</span>
          ) : (
            <div className="aurvin-message-content">
              {voiceArtifacts.length > 0 ? (
                <>
                  {displayContent.length > 0 ? (
                    <SafeMarkdown
                      content={displayContent}
                      messageId={message.messageId}
                      isStreaming={false}
                      activeArtifactId={activeArtifactId}
                      onOpenArtifact={onOpenArtifact}
                    />
                  ) : null}
                  {voiceArtifacts.map((artifact) => (
                    <CanvasArtifactCard
                      key={artifact.artifactId}
                      artifact={artifact}
                      isActive={activeArtifactId === artifact.artifactId}
                      onOpen={onOpenArtifact}
                    />
                  ))}
                </>
              ) : (
                <SafeMarkdown
                  content={displayContent}
                  messageId={message.messageId}
                  isStreaming={status === 'streaming' || status === 'generating'}
                  activeArtifactId={activeArtifactId}
                  onOpenArtifact={onOpenArtifact}
                />
              )}
            </div>
          )}

          {weatherArtifact ? (
            <CanvasArtifactCard
              artifact={weatherArtifact}
              isActive={matchesWeatherArtifact(weatherArtifact, activeArtifactId)}
              onOpen={onOpenArtifact}
            />
          ) : null}

          {(message.webActivities?.length || message.webSources?.length) ? (
            <WebSearchActivityView
              activities={message.webActivities}
              sources={message.webSources}
              variant="chat"
            />
          ) : null}

          {terminalStatus === 'truncated' ? (
            <span className="aurvin-status-badge aurvin-badge-truncated">
              Response reached maximum length
            </span>
          ) : null}

          {terminalStatus === 'cancelled' ? (
            <span className="aurvin-status-badge aurvin-badge-failed">Cancelled</span>
          ) : null}

          {terminalStatus === 'failed' || terminalStatus === 'interrupted' ? (
            <div className="aurvin-retry-row">
              <span className="aurvin-status-badge aurvin-badge-failed">
                {terminalStatus === 'failed' ? 'Generation failed' : 'Generation interrupted'}
              </span>
              {!message.voiceSessionId ? (
                <button
                  type="button"
                  className="aurvin-retry-btn"
                  onClick={() => onRetry?.(message.turnId)}
                  aria-label="Retry generation"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}

          {copyButton || memoryUpdatedPill || actionsStart || actionsEnd ? (
            <div className="aurvin-message-actions">
              {actionsStart}
              {copyButton}
              {actionsEnd}
              {memoryUpdatedPill}
            </div>
          ) : null}
        </div>
      )}
    </article>
  );
});
