/**
 * ============================================================================
 * FILE: chat-types.ts
 * LOCATION: frontend/src/features/chat/state/chat-types.ts
 * ============================================================================
 *
 * PURPOSE:
 *    TypeScript types for chat UI state, actions, and lifecycle statuses.
 *
 * ROLE IN PROJECT:
 *    Shared contract between the pure reducer, orchestration hook, context
 *    provider, and presentational components without importing transport code.
 *
 * KEY COMPONENTS:
 *    - ChatState: Session list, transcript, stream, draft, and sidebar flags.
 *    - ChatAction: Discriminated actions for navigation, paging, and turns.
 * ============================================================================
 */

import type { TaskPlanEvent, TaskSnapshot, TaskStepEvent } from '../../../api/task-protocol.ts';
import type {
  CalendarClarificationEvent,
  CalendarProgressPhase,
  CalendarTurnState,
  CalendarView,
} from '../../../api/calendar-protocol.ts';
import type {
  ActiveSessionTurn,
  AttemptStatus,
  ClientErrorBody,
  CompactionCheckpointMeta,
  ContextUsageMeta,
  SessionSummary,
  VisibleMessage,
  SaveStateSnapshot,
} from '../../../api/protocol.ts';
import type { WebSearchActivity, WebSourceReference } from '../../../api/web-search-protocol.ts';
import type { WeatherView } from '../../../api/weather-protocol.ts';

export type ChatState = {
  saves: Record<string, { turnId: string; value: SaveStateSnapshot; mode?: 'text' | 'live' }>;
  unsavedMessages: Record<string, VisibleMessage[]>;
  localSessionIds: string[];
  sessionsRevision: number;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  sessionsCursor: string | null;
  hasMoreSessions: boolean;

  activeSessionId: string | null;
  activeSessionTitle: string | null;
  activeSessionTemporary: boolean;

  messages: VisibleMessage[];
  canvasMessages: VisibleMessage[];
  messagesLoading: boolean;
  messagesError: string | null;
  messagesCursor: string | null;
  olderAvailable: boolean;
  loadingOlder: boolean;
  compaction: CompactionCheckpointMeta | null;
  contextUsage: ContextUsageMeta | null;

  activeTurnId: string | null;
  activeAttemptId: string | null;
  activeTurnMode: 'text' | 'live' | null;
  turnStatus: AttemptStatus | 'submitting' | 'idle';
  isStreaming: boolean;
  streamText: string;
  turnError: ClientErrorBody | null;

  draftInput: string;
  isSubmitting: boolean;

  voiceInput: { token: string; mode: 'dictation' | 'live' } | null;

  sidebarOpen: boolean;

  canvasOpen: boolean;
  activeCanvasArtifactId: string | null;
  closedCanvasArtifactIds: string[];

  calendarProgress: CalendarProgressPhase | null;
  calendarOperationsByTurn: Record<string, CalendarTurnState>;
  calendarViewsByTurn: Record<string, CalendarView>;
  calendarTurnOrder: string[];
  calendarClarification: { turnId: string; event: CalendarClarificationEvent } | null;
  calendarLastSequence: number;

  webActivitiesByTurn: Record<string, WebSearchActivity[]>;
  webSourcesByTurn: Record<string, WebSourceReference[]>;
  webLastSequenceByTurn: Record<string, number>;
  weatherViewsByTurn: Record<string, WeatherView>;
  weatherLastSequenceByTurn: Record<string, number>;
  pendingWebContinuationBreak: boolean;
  /** Task mode composer toggle (docs/task-mode-and-flows/spec.md). */
  taskMode: boolean;
  /** Release 1: version chosen per superseded chain, keyed by the chain's newest message id. */
  revisionSelection: Record<string, string>;
  /** Release 1: the answer a running regenerate will replace; hidden while it streams. */
  revisionSupersedes: string | null;
  /** Plan and step states of the in-flight Task-mode turn. */
  activeTask: TaskSnapshot | null;
};

export type ChatAction =
  | { type: 'DISMISS_TURN_ERROR' }
  | { type: 'SAVE_STATE'; payload: { sessionId: string; turnId: string; save: SaveStateSnapshot; mode?: 'text' | 'live' } }
  | {
      type: 'CONTEXT_STATE';
      payload: {
        sessionId: string;
        compaction?: CompactionCheckpointMeta;
        contextUsage?: ContextUsageMeta;
      };
    }
  | { type: 'NEW_CHAT' }
  | { type: 'SET_TEMPORARY_CHAT'; payload: boolean }
  | { type: 'SET_DRAFT'; payload: string }
  | { type: 'CLAIM_VOICE_INPUT'; payload: { token: string; mode: 'dictation' | 'live' } }
  | { type: 'VOICE_DRAFT'; payload: { token: string; text: string } }
  | { type: 'RELEASE_VOICE_INPUT'; payload: string }
  | {
      type: 'BIND_VOICE_CONVERSATION';
      payload: { token: string; conversationId: string; turnId?: string; save?: SaveStateSnapshot };
    }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'CLOSE_SIDEBAR' }
  | { type: 'OPEN_CANVAS_ARTIFACT'; payload: { artifactId: string } }
  | { type: 'CLOSE_CANVAS_TAB'; payload: { artifactId: string; fallbackArtifactId: string | null } }
  | { type: 'CLOSE_CANVAS' }
  | { type: 'SESSIONS_LOADING' }
  | { type: 'SESSIONS_LOADED'; payload: { items: SessionSummary[]; nextCursor: string | null; revision?: number } }
  | { type: 'SESSIONS_APPENDED'; payload: { items: SessionSummary[]; nextCursor: string | null } }
  | { type: 'SESSIONS_ERROR'; payload: string }
  | { type: 'SESSION_UPDATED'; payload: SessionSummary }
  | { type: 'SESSION_DELETED'; payload: string }
  | { type: 'SELECT_SESSION'; payload: { sessionId: string; title: string } }
  | { type: 'MESSAGES_LOADING' }
  | {
      type: 'MESSAGES_LOADED';
      payload: {
        items: VisibleMessage[];
        nextCursor: string | null;
        olderAvailable: boolean;
        canvasMessages?: VisibleMessage[];
        sessionId?: string;
        save?: SaveStateSnapshot;
        saveTurnId?: string;
        activeTurn?: ActiveSessionTurn;
        compaction?: CompactionCheckpointMeta;
        contextUsage?: ContextUsageMeta;
      };
    }
  | { type: 'OLDER_MESSAGES_LOADING' }
  | {
      type: 'OLDER_MESSAGES_LOADED';
      payload: { items: VisibleMessage[]; nextCursor: string | null; olderAvailable: boolean };
    }
  | { type: 'MESSAGES_ERROR'; payload: string }
  | {
      type: 'TURN_SUBMIT_START';
      payload: { userContent: string; idempotencyKey: string; hideFromTranscript?: boolean; supersedes?: string };
    }
  | {
      type: 'TURN_ACCEPTED';
      payload: { sessionId: string; turnId: string; attemptId: string; userMessageId: string; processEpoch?: string };
    }
  | { type: 'TURN_SUBMIT_ERROR'; payload: { error: ClientErrorBody; preservedContent: string } }
  | { type: 'STREAM_DELTA'; payload: { text: string; reset?: true } }
  | { type: 'STREAM_STATUS'; payload: { status: AttemptStatus; truncated: boolean } }
  | {
      type: 'STREAM_COMPLETED';
      payload: {
        assistantMessageId: string;
        outcome: 'completed' | 'truncated';
        text?: string;
        reset?: true;
        calendarView?: CalendarView;
        weatherView?: WeatherView;
        webSources?: WebSourceReference[];
        webActivities?: WebSearchActivity[];
        compaction?: CompactionCheckpointMeta;
        contextUsage?: ContextUsageMeta;
        memoryUpdated?: boolean;
        task?: TaskSnapshot;
      };
    }
  | { type: 'STREAM_ERROR'; payload: ClientErrorBody }
  | { type: 'TASK_MODE_SET'; payload: boolean }
  | { type: 'REVISION_SELECT'; payload: { tipId: string; messageId: string } }
  | { type: 'REVISION_PENDING'; payload: { supersedes: string | null } }
  | {
      type: 'TASK_EVENT';
      payload: { sessionId: string; turnId: string; attemptId: string; event: TaskPlanEvent | TaskStepEvent };
    }
  | { type: 'STREAM_CANCELLED' }
  | { type: 'STREAM_INTERRUPTED' }
  | {
      type: 'CALENDAR_PROGRESS';
      payload: {
        turnId: string;
        phase: CalendarProgressPhase;
        sessionId?: string;
        attemptId?: string;
        sequence?: number;
      };
    }
  | {
      type: 'CALENDAR_OPERATION';
      payload: {
        turnId: string;
        operation: CalendarTurnState;
        sessionId?: string;
        attemptId?: string;
        sequence?: number;
      };
    }
  | {
      type: 'CALENDAR_VIEW';
      payload: {
        turnId: string;
        view: CalendarView;
        sessionId?: string;
        attemptId?: string;
        sequence?: number;
      };
    }
  | {
      type: 'CALENDAR_CLARIFICATION';
      payload: {
        turnId: string;
        clarification: CalendarClarificationEvent;
        sessionId?: string;
        attemptId?: string;
        sequence?: number;
      };
    }
  | {
      type: 'VOICE_SESSION_COMMITTED';
      payload: {
        sessionId: string;
        voiceSessionId: string;
        durationSeconds: number;
        createdAt: string;
      };
    }
  | {
      type: 'WEB_ACTIVITY';
      payload: {
        sessionId: string;
        turnId: string;
        attemptId: string;
        sequence: number;
        activity: WebSearchActivity;
      };
    }
  | {
      type: 'WEB_SOURCES';
      payload: {
        sessionId: string;
        turnId: string;
        attemptId: string;
        sequence: number;
        sources: WebSourceReference[];
      };
    }
  | {
      type: 'WEATHER_VIEW';
      payload: {
        sessionId: string;
        turnId: string;
        attemptId: string;
        sequence: number;
        view: WeatherView;
      };
    };
