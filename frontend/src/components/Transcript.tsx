/**
 * ============================================================================
 * FILE: Transcript.tsx
 * LOCATION: frontend/src/components/Transcript.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Conversation log with older-message paging, a quiet compaction checkpoint
 *    divider, and a streaming bubble.
 *
 * ROLE IN PROJECT:
 *    Hosts the durable UI archive plus the in-flight assistant draft, using
 *    ScrollController so live tokens only follow the reader near the bottom.
 *
 * KEY COMPONENTS:
 *    - Load older messages control
 *    - MessageItem list with an inline compaction divider
 *    - Streaming assistant placeholder
 *    - Inline turn extensions (e.g. Calendar activity)
 * ============================================================================
 */

import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CompactionCheckpointMeta, VisibleMessage } from '../api/protocol.ts';
import { useChat } from '../features/chat/state/chat-context.tsx';
import { nextMessageSequence } from '../features/chat/state/chat-reducer.ts';
import { hideCalendarConfirmReplies } from '../features/plugins/google-calendar/CalendarTurnRegion.tsx';
import { groupVoiceMessages } from './group-voice-messages.ts';
import { MessageItem } from './MessageItem.tsx';
import { PromptTraveler } from './PromptTraveler.tsx';
import { ScrollController } from './ScrollController.tsx';

// oxlint-disable-next-line react/only-export-components -- pure placement helper shared with tests
export function findCompactionDividerIndex(
  messages: readonly VisibleMessage[],
  compaction: CompactionCheckpointMeta | null,
): number | null {
  if (!compaction || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.sequence <= compaction.compactedThroughSequence) {
      return i;
    }
  }
  return -1;
}

export function CompactionDivider({
  compaction,
  defaultExpanded = false,
}: {
  compaction: CompactionCheckpointMeta;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const preview = compaction.summaryPreview?.trim() ?? '';
  const hasPreview = preview.length > 0;

  return (
    <div
      className="aurvin-compaction-divider"
      role="separator"
      aria-label="Earlier conversation compacted"
      data-compaction-cycle={compaction.compactionCycle}
      data-compacted-through={compaction.compactedThroughSequence}
    >
      <div className="aurvin-compaction-divider-row">
        <span className="aurvin-compaction-line" aria-hidden="true" />
        <span className="aurvin-compaction-pill">
          <span>Earlier conversation compacted to preserve context</span>
          {hasPreview ? (
            <button
              type="button"
              className="aurvin-compaction-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? 'Hide summary' : 'View summary'}
            </button>
          ) : null}
        </span>
        <span className="aurvin-compaction-line" aria-hidden="true" />
      </div>
      {hasPreview && expanded ? (
        <p className="aurvin-compaction-preview">{preview}</p>
      ) : null}
    </div>
  );
}

export type TranscriptProps = {
  children?: ReactNode;
  onOpenMemorySettings?: () => void;
};

export function Transcript({
  children,
  onOpenMemorySettings,
}: TranscriptProps) {
  const { state, actions, dispatch } = useChat();
  const containerRef = useRef<HTMLDivElement>(null);
  const onOpenArtifact = useCallback((artifactId: string) => {
    dispatch({ type: 'OPEN_CANVAS_ARTIFACT', payload: { artifactId } });
  }, [dispatch]);
  const messageActions = { activeArtifactId: state.canvasOpen ? state.activeCanvasArtifactId : null,
    onOpenArtifact, onRetry: actions.retryTurn, onOpenMemorySettings };
  const scrollDependencies = useMemo(() => [
    state.messages,
    state.streamText,
    state.turnStatus,
    state.calendarClarification,
    state.calendarProgress,
    state.webActivitiesByTurn,
    state.webSourcesByTurn,
    state.weatherViewsByTurn,
    state.activeTask,
    state.compaction?.compactedThroughSequence,
  ], [
    state.messages,
    state.streamText,
    state.turnStatus,
    state.calendarClarification,
    state.calendarProgress,
    state.webActivitiesByTurn,
    state.webSourcesByTurn,
    state.weatherViewsByTurn,
    state.activeTask,
    state.compaction?.compactedThroughSequence,
  ]);

  const displayMessages = useMemo(
    () => groupVoiceMessages(hideCalendarConfirmReplies(state.messages)),
    [state.messages],
  );

  const compaction = state.compaction ?? null;
  const dividerAfterIndex = useMemo(
    () => findCompactionDividerIndex(displayMessages, compaction),
    [displayMessages, compaction],
  );
  const dividerKey = compaction
    ? `${state.activeSessionId ?? 'none'}:${compaction.compactionCycle}:${compaction.compactedThroughSequence}`
    : '';

  return (
    <div className="aurvin-transcript-stage">
      <div
        ref={containerRef}
        className="aurvin-transcript"
        role="log"
        aria-label="Conversation transcript"
        aria-live="polite"
      >
        {state.olderAvailable ? (
          <div className="aurvin-transcript-toolbar">
            <button
              type="button"
              className="aurvin-quiet-btn"
              onClick={() => {
                void actions.loadOlderMessages();
              }}
              disabled={state.loadingOlder}
            >
              {state.loadingOlder ? 'Loading older messages…' : 'Load older messages'}
            </button>
          </div>
        ) : null}

        {dividerAfterIndex === -1 && compaction ? (
          <CompactionDivider key={dividerKey} compaction={compaction} />
        ) : null}

        {displayMessages.map((message, index) => (
          <Fragment key={message.messageId}>
            <MessageItem
              message={
                state.activeSessionTemporary && message.memoryUpdated
                  ? { ...message, memoryUpdated: undefined }
                  : message
              }
              {...messageActions}
            />
            {dividerAfterIndex === index && compaction ? (
              <CompactionDivider key={dividerKey} compaction={compaction} />
            ) : null}
          </Fragment>
        ))}

        {state.isStreaming ||
        ((state.turnStatus === 'accepted' ||
          state.turnStatus === 'generating' ||
          state.turnStatus === 'finalizing') &&
          state.activeTurnMode !== 'live' &&
          Boolean(state.activeTurnId)) ? (
          <MessageItem
            {...messageActions}
            liveStatus={state.turnStatus}
            message={{
              messageId: 'streaming_in_flight',
              turnId: state.activeTurnId ?? 'turn_streaming',
              eventId: 'evt_streaming',
              sequence: nextMessageSequence(state.messages, compaction),
              role: 'assistant',
              content: state.streamText,
              createdAt: '',
              completionStatus: 'streaming',
              truncated: false,
              ...(state.activeTurnId && state.webActivitiesByTurn[state.activeTurnId]?.length
                ? { webActivities: state.webActivitiesByTurn[state.activeTurnId] }
                : {}),
              ...(state.activeTurnId && state.webSourcesByTurn[state.activeTurnId]?.length
                ? { webSources: state.webSourcesByTurn[state.activeTurnId] }
                : {}),
              ...(state.activeTurnId && state.weatherViewsByTurn[state.activeTurnId]
                ? { weatherView: state.weatherViewsByTurn[state.activeTurnId] }
                : {}),
              ...(state.activeTask ? { task: state.activeTask } : {}),
            }}
          />
        ) : null}

        {children}

        <ScrollController
          scrollContainerRef={containerRef}
          dependencies={scrollDependencies}
        />
      </div>

      <PromptTraveler scrollContainerRef={containerRef} messages={displayMessages} />
    </div>
  );
}
