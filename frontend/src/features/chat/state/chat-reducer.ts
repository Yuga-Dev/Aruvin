/**
 * ============================================================================
 * FILE: chat-reducer.ts
 * LOCATION: frontend/src/features/chat/state/chat-reducer.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Deterministic pure reducer for chat navigation, paging, and streaming.
 *
 * ROLE IN PROJECT:
 *    Owns all UI state transitions so session order, draft preservation, and
 *    turn lifecycle can be unit-tested without React or network I/O.
 *
 * KEY COMPONENTS:
 *    - initialChatState: Empty idle chat with no premature session record.
 *    - sortSessions: lastActivityAt DESC with sessionId DESC tie-break.
 *    - chatReducer: Immutable transitions for every ChatAction.
 * ============================================================================
 */

import { applyTaskStep, snapshotForPlan } from '../../../api/task-protocol.ts';
import type {
  AttemptStatus,
  ClientErrorBody,
  CompactionCheckpointMeta,
  SessionSummary,
  VisibleMessage,
} from '../../../api/protocol.ts';
import type { WebSearchActivity, WebSourceReference } from '../../../api/web-search-protocol.ts';
import type { WeatherView } from '../../../api/weather-protocol.ts';
import { foldWebActivities, foldWebSources } from '../../plugins/web-search/web-search-presentation.ts';
import type { ChatAction, ChatState } from './chat-types.ts';

export type TurnErrorNotice = {
  message: string;
  canContinueInNewChat: boolean;
};

export function describeTurnError(error: ClientErrorBody, hasActiveSession: boolean): TurnErrorNotice {
  switch (error.code) {
    case 'STORAGE_BUDGET_EXCEEDED':
      return {
        message: hasActiveSession
          ? 'This chat has reached its storage limit. Continue your prompt in a new chat.'
          : 'This message could not be saved because storage is full.',
        canContinueInNewChat: hasActiveSession,
      };
    case 'CONTEXT_BUDGET_EXCEEDED':
      return {
        message: hasActiveSession
          ? 'This chat is too long to continue here. Continue your prompt in a new chat.'
          : 'Your message exceeds the context limit. Shorten it slightly and try again.',
        canContinueInNewChat: hasActiveSession,
      };
    case 'NOT_FOUND':
      return {
        message: hasActiveSession
          ? 'This chat is no longer available. Continue your prompt in a new chat.'
          : 'That chat could not be found.',
        canContinueInNewChat: hasActiveSession,
      };
    case 'NOT_READY':
      return {
        message: hasActiveSession
          ? "This chat isn't ready right now. Try again shortly, or continue in a new chat."
          : "Aurvin isn't ready right now. Please try again shortly.",
        canContinueInNewChat: hasActiveSession,
      };
    case 'PERSISTENCE_ERROR':
      return {
        message: hasActiveSession
          ? "This chat couldn't be saved or loaded. Try again, or continue in a new chat."
          : "Couldn't save your message right now. Please try again.",
        canContinueInNewChat: hasActiveSession,
      };
    case 'CONFLICT_ACTIVE_TURN':
      return {
        message: hasActiveSession
          ? 'Another reply is still active in this chat. Wait a moment, or continue in a new chat.'
          : 'A reply is already in progress. Please wait a moment.',
        canContinueInNewChat: hasActiveSession,
      };
    case 'INTERRUPTED':
      return {
        message: 'The previous request was interrupted. Your message is ready to send again.',
        canContinueInNewChat: hasActiveSession,
      };
    case 'INVALID_REQUEST':
    case 'IDEMPOTENCY_PAYLOAD_MISMATCH':
      return {
        message: hasActiveSession
          ? "This chat couldn't process that request. Continue your prompt in a new chat."
          : error.message || "That request couldn't be sent. Check your message and try again.",
        canContinueInNewChat: hasActiveSession,
      };
    case 'NETWORK_ERROR':
      return {
        message: 'Connection lost. Your message is preserved below—check your network and send again.',
        canContinueInNewChat: false,
      };
    case 'RATE_LIMITED':
    case 'CONCURRENCY_LIMIT':
      return {
        message: 'Aurvin is busy right now. Your message is preserved below—try again in a moment.',
        canContinueInNewChat: false,
      };
    case 'TIMEOUT':
      return {
        message: 'The request timed out. Your message is preserved below—try sending again.',
        canContinueInNewChat: false,
      };
    case 'INPUT_TOO_LARGE':
      return {
        message: 'Your message is too long. Shorten it slightly and send again.',
        canContinueInNewChat: false,
      };
    case 'PROVIDER_ERROR':
    case 'PROVIDER_AUTH':
    case 'PROVIDER_CREDITS':
    case 'CONFIGURATION_ERROR':
    case 'UNSUPPORTED_TOPOLOGY':
      return {
        message: error.message || "The model service couldn't respond right now. Please try again shortly.",
        canContinueInNewChat: false,
      };
    default:
      return {
        message: error.message || 'Something went wrong sending your message. Please try again.',
        canContinueInNewChat: hasActiveSession && !error.retryable,
      };
  }
}

function isBusyAttemptStatus(status: ChatState['turnStatus']): boolean {
  return status === 'accepted' || status === 'generating' || status === 'finalizing';
}

/** Product gate matching P4's server-side `allowTemporaryLive` seam (off by default). */
export const TEMPORARY_LIVE_VOICE_ENABLED = false;

export function canToggleTemporaryChat(
  state: Pick<
    ChatState,
    'activeSessionId' | 'messages' | 'isSubmitting' | 'isStreaming' | 'turnStatus' | 'voiceInput'
  >,
): boolean {
  return (
    state.activeSessionId === null &&
    state.messages.length === 0 &&
    !state.isSubmitting &&
    !state.isStreaming &&
    !isBusyAttemptStatus(state.turnStatus) &&
    state.voiceInput === null
  );
}

export function canStartLiveVoiceForChat(
  state: Pick<ChatState, 'activeSessionTemporary'>,
  allowTemporaryLive = TEMPORARY_LIVE_VOICE_ENABLED,
): boolean {
  return !state.activeSessionTemporary || allowTemporaryLive === true;
}

export const initialChatState: ChatState = {
  saves: {},
  unsavedMessages: {},
  localSessionIds: [],
  sessionsRevision: 0,
  sessions: [],
  sessionsLoading: false,
  sessionsError: null,
  sessionsCursor: null,
  hasMoreSessions: false,

  activeSessionId: null,
  activeSessionTitle: null,
  activeSessionTemporary: false,

  messages: [],
  canvasMessages: [],
  messagesLoading: false,
  messagesError: null,
  messagesCursor: null,
  olderAvailable: false,
  loadingOlder: false,
  compaction: null,
  contextUsage: null,

  activeTurnId: null,
  activeAttemptId: null,
  activeTurnMode: null,
  turnStatus: 'idle',
  isStreaming: false,
  streamText: '',
  turnError: null,

  draftInput: '',
  isSubmitting: false,

  voiceInput: null,

  sidebarOpen: false,

  canvasOpen: false,
  activeCanvasArtifactId: null,
  closedCanvasArtifactIds: [],

  calendarProgress: null,
  calendarOperationsByTurn: {},
  calendarViewsByTurn: {},
  calendarTurnOrder: [],
  calendarClarification: null,
  calendarLastSequence: -1,

  webActivitiesByTurn: {},
  webSourcesByTurn: {},
  webLastSequenceByTurn: {},
  weatherViewsByTurn: {},
  weatherLastSequenceByTurn: {},
  pendingWebContinuationBreak: false,
  taskMode: false,
  activeTask: null,
};

const WEB_TOOL_IN_FLIGHT = new Set(['searching', 'reading', 'fallback']);

function separateStreamContinuation(prior: string, next: string): string {
  if (!prior || !next) return next;
  if (/\n[ \t]*$/.test(prior) || /^\s/.test(next)) return next;
  return `\n\n${next}`;
}

function syncActiveCalendarNarration(
  state: ChatState,
  narration: 'completed' | 'failed' | 'interrupted',
): Record<string, ChatState['calendarOperationsByTurn'][string]> {
  const turnId = state.activeTurnId;
  if (!turnId) return state.calendarOperationsByTurn;
  const existing = state.calendarOperationsByTurn[turnId];
  if (!existing || existing.narration !== 'pending') {
    return state.calendarOperationsByTurn;
  }
  return {
    ...state.calendarOperationsByTurn,
    [turnId]: {
      ...existing,
      narration,
    },
  };
}

function ignoreCalendarAction(
  state: ChatState,
  payload: { turnId: string; sessionId?: string; attemptId?: string; sequence?: number },
): boolean {
  if (payload.turnId !== state.activeTurnId) return true;
  if (payload.sessionId !== undefined && payload.sessionId !== state.activeSessionId) return true;
  if (payload.attemptId !== undefined && payload.attemptId !== state.activeAttemptId) return true;
  return payload.sequence !== undefined && payload.sequence <= state.calendarLastSequence;
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const pinDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinDiff) return pinDiff;
    const timeDiff = Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return b.sessionId.localeCompare(a.sessionId);
  });
}

export function nextMessageSequence(
  messages: readonly VisibleMessage[],
  compaction: CompactionCheckpointMeta | null | undefined,
): number {
  return (
    messages.reduce(
      (max, item) => Math.max(max, item.sequence),
      compaction?.compactedThroughSequence ?? 0,
    ) + 1
  );
}

function mergeCompaction(
  current: CompactionCheckpointMeta | null,
  incoming: CompactionCheckpointMeta | undefined,
): CompactionCheckpointMeta | null {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming.compactionCycle < current.compactionCycle) return current;
  if (
    incoming.compactionCycle === current.compactionCycle &&
    incoming.compactedThroughSequence < current.compactedThroughSequence
  ) {
    return current;
  }
  return incoming;
}

function appendTerminalAssistant(
  state: ChatState,
  completionStatus: VisibleMessage['completionStatus'],
  truncated: boolean,
  messageId: string,
  web: { webActivities: WebSearchActivity[]; webSources: WebSourceReference[] },
): VisibleMessage[] {
  if (!state.streamText) {
    return state.messages;
  }

  const assistantMsg: VisibleMessage = {
    messageId,
    turnId: state.activeTurnId ?? 'turn_completed',
    eventId: `evt_${messageId}`,
    sequence: nextMessageSequence(state.messages, state.compaction),
    role: 'assistant',
    content: state.streamText,
    createdAt: new Date().toISOString(),
    completionStatus,
    truncated,
    ...(web.webActivities.length > 0 ? { webActivities: web.webActivities } : {}),
    ...(web.webSources.length > 0 ? { webSources: web.webSources } : {}),
  };

  return [...state.messages, assistantMsg];
}

function acceptsFencedWebPayload(
  state: ChatState,
  payload: { sessionId: string; turnId: string; attemptId: string; sequence: number },
): boolean {
  if (!state.activeSessionId || payload.sessionId !== state.activeSessionId) return false;
  if (!state.activeTurnId || payload.turnId !== state.activeTurnId) return false;
  if (!state.activeAttemptId || payload.attemptId !== state.activeAttemptId) return false;
  const lastSeq = state.webLastSequenceByTurn[payload.turnId] ?? -1;
  return payload.sequence > lastSeq;
}

function takeTurnWebProvenance(state: ChatState, turnId: string | null) {
  if (!turnId) {
    return {
      webActivities: [],
      webSources: [],
      nextActivitiesByTurn: state.webActivitiesByTurn,
      nextSourcesByTurn: state.webSourcesByTurn,
      nextSeqByTurn: state.webLastSequenceByTurn,
    };
  }
  const webActivities = state.webActivitiesByTurn[turnId] ?? [];
  const webSources = state.webSourcesByTurn[turnId] ?? [];
  const { [turnId]: _a, ...nextActivitiesByTurn } = state.webActivitiesByTurn;
  const { [turnId]: _s, ...nextSourcesByTurn } = state.webSourcesByTurn;
  const { [turnId]: _q, ...nextSeqByTurn } = state.webLastSequenceByTurn;
  return { webActivities, webSources, nextActivitiesByTurn, nextSourcesByTurn, nextSeqByTurn };
}

function acceptsFencedWeatherPayload(
  state: ChatState,
  payload: { sessionId: string; turnId: string; attemptId: string; sequence: number },
): boolean {
  if (!state.activeSessionId || payload.sessionId !== state.activeSessionId) return false;
  if (!state.activeTurnId || payload.turnId !== state.activeTurnId) return false;
  if (!state.activeAttemptId || payload.attemptId !== state.activeAttemptId) return false;
  const lastSeq = state.weatherLastSequenceByTurn[payload.turnId] ?? -1;
  return payload.sequence > lastSeq;
}

function takeTurnWeatherView(state: ChatState, turnId: string | null) {
  if (!turnId) {
    return {
      weatherView: undefined as WeatherView | undefined,
      nextViewsByTurn: state.weatherViewsByTurn,
      nextSeqByTurn: state.weatherLastSequenceByTurn,
    };
  }
  const weatherView = state.weatherViewsByTurn[turnId];
  const { [turnId]: _v, ...nextViewsByTurn } = state.weatherViewsByTurn;
  const { [turnId]: _q, ...nextSeqByTurn } = state.weatherLastSequenceByTurn;
  return { weatherView, nextViewsByTurn, nextSeqByTurn };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'DISMISS_TURN_ERROR':
      return state.turnError === null ? state : { ...state, turnError: null };
    case 'SAVE_STATE': {
      const { sessionId, turnId, save, mode } = action.payload;
      if (state.activeSessionTemporary && sessionId === state.activeSessionId) {
        return state;
      }
      const oldEntry = state.saves[sessionId];
      const old = oldEntry?.value;
      if (old && (old.epoch !== save.epoch || old.version > save.version ||
        (old.version === save.version && old.durableVersion > save.durableVersion))) return state;
      const unsavedMessages = { ...state.unsavedMessages };
      if (save.state === 'saved') delete unsavedMessages[sessionId];
      else if (sessionId === state.activeSessionId) unsavedMessages[sessionId] = state.messages;
      const resolvedMode = mode ?? oldEntry?.mode;
      return {
        ...state,
        saves: {
          ...state.saves,
          [sessionId]: { turnId, value: save, ...(resolvedMode ? { mode: resolvedMode } : {}) },
        },
        unsavedMessages,
        sessionsRevision: state.sessionsRevision + (save.state === 'saved' && old?.state !== 'saved' ? 1 : 0),
        localSessionIds: save.state === 'saved' ? state.localSessionIds.filter(id => id !== sessionId) : state.localSessionIds,
      };
    }
    case 'CONTEXT_STATE':
      if (action.payload.sessionId !== state.activeSessionId) return state;
      return {
        ...state,
        compaction: mergeCompaction(state.compaction, action.payload.compaction),
        contextUsage: action.payload.contextUsage ?? state.contextUsage,
      };
    case 'NEW_CHAT': {
      const leavingTempId = state.activeSessionTemporary ? state.activeSessionId : null;
      return {
        ...state,
        saves: leavingTempId ? withoutKey(state.saves, leavingTempId) : state.saves,
        unsavedMessages: leavingTempId
          ? withoutKey(state.unsavedMessages, leavingTempId)
          : state.activeSessionId && state.saves[state.activeSessionId] && state.saves[state.activeSessionId].value.state !== 'saved'
            ? { ...state.unsavedMessages, [state.activeSessionId]: state.messages }
            : state.unsavedMessages,
        activeSessionId: null,
        activeSessionTitle: null,
        activeSessionTemporary: false,
        messages: [],
        canvasMessages: [],
        messagesLoading: false,
        messagesError: null,
        messagesCursor: null,
        olderAvailable: false,
        compaction: null,
        contextUsage: null,
        activeTurnId: null,
        activeAttemptId: null,
        activeTurnMode: null,
        turnStatus: 'idle',
        isStreaming: false,
        streamText: '',
        turnError: null,
        isSubmitting: false,
        voiceInput: null,
        sidebarOpen: false,
        canvasOpen: false,
        activeCanvasArtifactId: null,
        closedCanvasArtifactIds: [],
        calendarProgress: null,
        calendarOperationsByTurn: {},
        calendarViewsByTurn: {},
        calendarTurnOrder: [],
        calendarClarification: null,
        calendarLastSequence: -1,
        webActivitiesByTurn: {},
        webSourcesByTurn: {},
        webLastSequenceByTurn: {},
        weatherViewsByTurn: {},
        weatherLastSequenceByTurn: {},
        pendingWebContinuationBreak: false,
        activeTask: null,
      };
    }

    case 'SET_TEMPORARY_CHAT':
      if (!canToggleTemporaryChat(state)) return state;
      return state.activeSessionTemporary === action.payload
        ? state
        : { ...state, activeSessionTemporary: action.payload };

    case 'SET_DRAFT':
      return state.voiceInput ? state : { ...state, draftInput: action.payload };

    case 'CLAIM_VOICE_INPUT':
      if (action.payload.mode === 'live' && !canStartLiveVoiceForChat(state)) return state;
      return state.voiceInput || state.isStreaming || state.isSubmitting || isBusyAttemptStatus(state.turnStatus)
        ? state
        : { ...state, voiceInput: action.payload };

    case 'VOICE_DRAFT':
      return state.voiceInput?.token === action.payload.token
        ? { ...state, draftInput: action.payload.text } : state;

    case 'RELEASE_VOICE_INPUT':
      return state.voiceInput?.token === action.payload
        ? { ...state, voiceInput: null } : state;

    case 'BIND_VOICE_CONVERSATION': {
      if (state.voiceInput?.token !== action.payload.token || state.voiceInput.mode !== 'live') return state;
      const { conversationId, turnId, save } = action.payload;
      if (state.activeSessionId && state.activeSessionId !== conversationId) return state;
      const existing = state.sessions.find((s) => s.sessionId === conversationId);
      const nextTitle = state.activeSessionTitle ?? existing?.title ?? 'New chat';
      if (!turnId || !save || state.activeSessionTemporary) {
        return {
          ...state,
          activeSessionId: conversationId,
          activeSessionTitle: nextTitle,
        };
      }
      const at = new Date().toISOString();
      const priorEpoch = state.saves[conversationId]?.value.epoch;
      const saves =
        priorEpoch && priorEpoch !== save.epoch
          ? Object.fromEntries(Object.entries(state.saves).filter(([id]) => id !== conversationId))
          : state.saves;
      const next: ChatState = {
        ...state,
        activeSessionId: conversationId,
        activeSessionTitle: nextTitle,
        saves,
        sessionsRevision: state.sessionsRevision + 1,
        localSessionIds:
          save.state !== 'saved'
            ? [...new Set([...state.localSessionIds, conversationId])]
            : state.localSessionIds.filter((id) => id !== conversationId),
        sessions: sortSessions([
          ...state.sessions.filter((s) => s.sessionId !== conversationId),
          { ...(existing ?? { sessionId: conversationId, title: nextTitle, createdAt: at }), lastActivityAt: at },
        ]),
      };
      return chatReducer(next, {
        type: 'SAVE_STATE',
        payload: { sessionId: conversationId, turnId, save, mode: 'live' },
      });
    }

    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarOpen: !state.sidebarOpen };

    case 'CLOSE_SIDEBAR':
      return { ...state, sidebarOpen: false };

    case 'OPEN_CANVAS_ARTIFACT':
      return {
        ...state,
        canvasOpen: true,
        activeCanvasArtifactId: action.payload.artifactId,
        closedCanvasArtifactIds: state.closedCanvasArtifactIds.filter(
          (id) => id !== action.payload.artifactId,
        ),
      };

    case 'CLOSE_CANVAS_TAB': {
      const closed = state.closedCanvasArtifactIds.includes(action.payload.artifactId)
        ? state.closedCanvasArtifactIds
        : [...state.closedCanvasArtifactIds, action.payload.artifactId];
      const nextActive =
        action.payload.fallbackArtifactId === null
          ? null
          : state.activeCanvasArtifactId === action.payload.artifactId
            ? action.payload.fallbackArtifactId
            : state.activeCanvasArtifactId;
      return {
        ...state,
        closedCanvasArtifactIds: closed,
        activeCanvasArtifactId: nextActive,
        canvasOpen: nextActive !== null ? state.canvasOpen : false,
      };
    }

    case 'CLOSE_CANVAS':
      return { ...state, canvasOpen: false };

    case 'SESSIONS_LOADING':
      return { ...state, sessionsLoading: true, sessionsError: null };

    case 'SESSIONS_LOADED': {
      const merged = new Map(
        action.payload.items
          .filter((item) => item.ephemeral !== true)
          .map((item) => [item.sessionId, item]),
      );
      for (const item of state.sessions) {
        if (
          item.ephemeral !== true &&
          (state.localSessionIds.includes(item.sessionId) ||
            (action.payload.revision !== undefined &&
              action.payload.revision !== state.sessionsRevision))
        ) {
          merged.set(item.sessionId, item);
        }
      }
      return {
        ...state,
        sessionsLoading: false,
        sessions: sortSessions([...merged.values()]),
        sessionsCursor: action.payload.nextCursor,
        hasMoreSessions: action.payload.nextCursor !== null,
      };
    }

    case 'SESSIONS_APPENDED': {
      const merged = new Map<string, SessionSummary>();
      for (const item of state.sessions) {
        merged.set(item.sessionId, item);
      }
      for (const item of action.payload.items) {
        if (item.ephemeral !== true && !state.localSessionIds.includes(item.sessionId)) {
          merged.set(item.sessionId, item);
        }
      }
      return {
        ...state,
        sessions: sortSessions(Array.from(merged.values())),
        sessionsCursor: action.payload.nextCursor,
        hasMoreSessions: action.payload.nextCursor !== null,
      };
    }

    case 'SESSIONS_ERROR':
      return { ...state, sessionsLoading: false, sessionsError: action.payload };

    case 'SESSION_UPDATED':
      return {
        ...state,
        sessionsRevision: state.sessionsRevision + 1,
        sessions: action.payload.ephemeral === true
          ? state.sessions.filter((session) => session.sessionId !== action.payload.sessionId)
          : sortSessions(
              state.sessions.map((session) =>
                session.sessionId === action.payload.sessionId ? action.payload : session,
              ),
            ),
        activeSessionTitle:
          state.activeSessionId === action.payload.sessionId
            ? action.payload.title
            : state.activeSessionTitle,
      };

    case 'SESSION_DELETED': {
      const next = state.activeSessionId === action.payload ? chatReducer(state, { type: 'NEW_CHAT' }) : state;
      return { ...next, sessions: next.sessions.filter(session => session.sessionId !== action.payload) };
    }

    case 'SELECT_SESSION': {
      const leavingTempId = state.activeSessionTemporary ? state.activeSessionId : null;
      return {
        ...state,
        saves: leavingTempId ? withoutKey(state.saves, leavingTempId) : state.saves,
        unsavedMessages: leavingTempId
          ? withoutKey(state.unsavedMessages, leavingTempId)
          : state.activeSessionId && state.saves[state.activeSessionId] && state.saves[state.activeSessionId].value.state !== 'saved'
            ? { ...state.unsavedMessages, [state.activeSessionId]: state.messages }
            : state.unsavedMessages,
        activeSessionId: action.payload.sessionId,
        activeSessionTitle: action.payload.title,
        activeSessionTemporary: false,
        messages: state.unsavedMessages[action.payload.sessionId] ?? [],
        canvasMessages: [],
        messagesLoading: true,
        messagesError: null,
        compaction: null,
        contextUsage: null,
        activeTurnId: null,
        activeAttemptId: null,
        activeTurnMode: null,
        turnStatus: 'idle',
        isStreaming: false,
        streamText: '',
        turnError: null,
        voiceInput: null,
        sidebarOpen: false,
        canvasOpen: false,
        activeCanvasArtifactId: null,
        closedCanvasArtifactIds: [],
        calendarProgress: null,
        calendarOperationsByTurn: {},
        calendarViewsByTurn: {},
        calendarTurnOrder: [],
        calendarClarification: null,
        calendarLastSequence: -1,
        webActivitiesByTurn: {},
        webSourcesByTurn: {},
        webLastSequenceByTurn: {},
        weatherViewsByTurn: {},
        weatherLastSequenceByTurn: {},
        pendingWebContinuationBreak: false,
        activeTask: null,
      };
    }

    case 'MESSAGES_LOADING':
      return { ...state, messagesLoading: true, messagesError: null };

    case 'MESSAGES_LOADED': {
      if (action.payload.sessionId && action.payload.sessionId !== state.activeSessionId) return state;
      const targetSessionId = action.payload.sessionId ?? state.activeSessionId;
      const saveEntry = targetSessionId ? state.saves[targetSessionId] : undefined;
      const save = saveEntry?.value;
      const retain = save && (!action.payload.save || action.payload.save.epoch !== save.epoch || action.payload.save.version < save.version);
      const incoming = new Map(action.payload.items.map(item => [item.messageId, item]));
      if (retain) {
        for (const item of state.messages) {
          const serverItem = incoming.get(item.messageId);
          incoming.set(
            item.messageId,
            serverItem?.memoryUpdated === true && item.role === 'assistant'
              ? { ...item, memoryUpdated: true }
              : item,
          );
        }
      }
      const items = [...incoming.values()].sort((a, b) => a.sequence - b.sequence);
      const pendingProvisional = state.messages.filter(
        (m) =>
          m.messageId.startsWith('voice_provisional_') &&
          !action.payload.items.some((serverMsg) => serverMsg.voiceSessionId === m.voiceSessionId),
      );
      const mergedMessages = pendingProvisional.length > 0
        ? [...items.filter(m => !pendingProvisional.some(p => p.messageId === m.messageId)), ...pendingProvisional]
        : items;

      let activeTurnId = state.activeTurnId;
      let activeAttemptId = state.activeAttemptId;
      let activeTurnMode = state.activeTurnMode;
      let turnStatus = state.turnStatus;
      if (!state.isStreaming && !state.isSubmitting) {
        if (action.payload.activeTurn) {
          activeTurnId = action.payload.activeTurn.turnId;
          activeAttemptId = action.payload.activeTurn.attemptId;
          activeTurnMode = action.payload.activeTurn.mode;
          turnStatus = action.payload.activeTurn.status;
        } else if (isBusyAttemptStatus(state.turnStatus)) {
          const settledAssistant = state.activeTurnId
            ? [...mergedMessages].reverse().find(
                (m) =>
                  m.turnId === state.activeTurnId &&
                  m.role === 'assistant' &&
                  ['completed', 'truncated', 'failed', 'cancelled', 'interrupted'].includes(m.completionStatus),
              )
            : undefined;
          activeTurnId = null;
          activeAttemptId = null;
          activeTurnMode = null;
          turnStatus = settledAssistant
            ? (settledAssistant.completionStatus as AttemptStatus)
            : 'idle';
        }
      }

      let next: ChatState = {
        ...state,
        messagesLoading: false,
        messages: mergedMessages,
        canvasMessages:
          action.payload.canvasMessages ??
          (!action.payload.olderAvailable ? [] : state.canvasMessages),
        messagesCursor: action.payload.nextCursor,
        olderAvailable: action.payload.olderAvailable,
        compaction: mergeCompaction(state.compaction, action.payload.compaction),
        contextUsage: action.payload.contextUsage ?? state.contextUsage,
        activeTurnId,
        activeAttemptId,
        activeTurnMode,
        turnStatus,
      };
      if (targetSessionId && action.payload.save) {
        const incomingSave = action.payload.save;
        const staleAtSameVersion =
          save &&
          save.epoch === incomingSave.epoch &&
          save.version === incomingSave.version &&
          save.durableVersion === incomingSave.durableVersion &&
          ['saved', 'failed', 'unknown', 'fenced'].includes(save.state) &&
          ['pending', 'saving'].includes(incomingSave.state);
        if (!staleAtSameVersion) {
          const inferredMode =
            saveEntry?.mode ??
            action.payload.activeTurn?.mode ??
            (mergedMessages.some((m) => m.mode === 'live') ? 'live' : undefined);
          if (
            save &&
            save.epoch !== incomingSave.epoch &&
            ['pending', 'saving'].includes(save.state) &&
            !action.payload.activeTurn &&
            !['pending', 'saving'].includes(incomingSave.state)
          ) {
            const turnSaved =
              incomingSave.state === 'saved' &&
              (!saveEntry?.turnId || action.payload.items.some((m) => m.turnId === saveEntry.turnId));
            next = chatReducer(next, {
              type: 'SAVE_STATE',
              payload: {
                sessionId: targetSessionId,
                turnId: saveEntry?.turnId ?? '',
                save: {
                  ...save,
                  state: turnSaved ? 'saved' : 'unknown',
                  ...(turnSaved ? { durableVersion: Math.max(save.durableVersion, save.version) } : {}),
                },
                ...(inferredMode ? { mode: inferredMode } : {}),
              },
            });
          } else {
            next = chatReducer(next, {
              type: 'SAVE_STATE',
              payload: {
                sessionId: targetSessionId,
                turnId: action.payload.saveTurnId ?? saveEntry?.turnId ?? '',
                save: incomingSave,
                ...(inferredMode ? { mode: inferredMode } : {}),
              },
            });
          }
        }
      } else if (
        targetSessionId &&
        !action.payload.save &&
        !action.payload.activeTurn &&
        save &&
        ['pending', 'saving'].includes(save.state) &&
        saveEntry?.turnId &&
        action.payload.items.some((m) => m.turnId === saveEntry.turnId)
      ) {
        const inferredMode =
          saveEntry.mode ?? (mergedMessages.some((m) => m.mode === 'live') ? 'live' : undefined);
        next = chatReducer(next, {
          type: 'SAVE_STATE',
          payload: {
            sessionId: targetSessionId,
            turnId: saveEntry.turnId,
            save: {
              ...save,
              state: 'saved',
              durableVersion: Math.max(save.durableVersion, save.version),
            },
            ...(inferredMode ? { mode: inferredMode } : {}),
          },
        });
      }
      return next;
    }

    case 'OLDER_MESSAGES_LOADING':
      return { ...state, loadingOlder: true };

    case 'OLDER_MESSAGES_LOADED': {
      const merged = new Map<string, VisibleMessage>();
      for (const item of action.payload.items) merged.set(item.messageId, item);
      for (const item of state.messages) {
        const olderItem = merged.get(item.messageId);
        merged.set(
          item.messageId,
          olderItem?.memoryUpdated === true && item.role === 'assistant'
            ? { ...item, memoryUpdated: true }
            : item,
        );
      }
      return {
        ...state,
        loadingOlder: false,
        messages: [...merged.values()].sort((a, b) => a.sequence - b.sequence),
        messagesCursor: action.payload.nextCursor,
        olderAvailable: action.payload.olderAvailable,
      };
    }

    case 'MESSAGES_ERROR':
      return { ...state, messagesLoading: false, loadingOlder: false, messagesError: action.payload };

    case 'VOICE_SESSION_COMMITTED': {
      if (state.activeSessionId && state.activeSessionId !== action.payload.sessionId) return state;
      const exists = state.messages.some((m) => m.voiceSessionId === action.payload.voiceSessionId);
      if (exists) return state;
      const provisional: VisibleMessage = {
        messageId: `voice_provisional_${action.payload.voiceSessionId}`,
        turnId: `turn_voice_${action.payload.voiceSessionId}`,
        eventId: `evt_voice_${action.payload.voiceSessionId}`,
        sequence: nextMessageSequence(state.messages, state.compaction),
        role: 'assistant',
        content: '',
        createdAt: action.payload.createdAt,
        completionStatus: 'completed',
        truncated: false,
        mode: 'live',
        visibility: 'visible',
        voiceSessionId: action.payload.voiceSessionId,
        voiceDurationSeconds: action.payload.durationSeconds,
        voiceTranscripts: [],
      };
      return {
        ...state,
        activeSessionId: state.activeSessionId ?? action.payload.sessionId,
        messages: [...state.messages, provisional],
      };
    }

    case 'TURN_SUBMIT_START': {
      if (state.voiceInput) return state;
      const sequence = nextMessageSequence(state.messages, state.compaction);
      const tempUserMsg: VisibleMessage = {
        messageId: `temp_user_${sequence}`,
        turnId: `temp_turn_${sequence}`,
        eventId: `temp_evt_${sequence}`,
        sequence,
        role: 'user',
        content: action.payload.userContent,
        createdAt: new Date().toISOString(),
        completionStatus: 'accepted',
        truncated: false,
      };

      return {
        ...state,
        activeTask: null,
        isSubmitting: true,
        turnStatus: 'submitting',
        draftInput: '',
        turnError: null,
        streamText: '',
        pendingWebContinuationBreak: false,
        calendarProgress: null,
        messages: action.payload.hideFromTranscript
          ? state.messages
          : [...state.messages, tempUserMsg],
      };
    }

    case 'TURN_ACCEPTED': {
      const at = new Date().toISOString();
      const firstInput = state.messages.find(m => m.messageId.startsWith('temp_user_'))?.content ?? 'New chat';
      const existing = state.sessions.find(s => s.sessionId === action.payload.sessionId);
      const trackInSidebar = Boolean(action.payload.processEpoch) && !state.activeSessionTemporary;
      const messages = state.messages.map((message) => {
        if (!message.messageId.startsWith('temp_user_')) {
          return message;
        }
        return {
          ...message,
          messageId: action.payload.userMessageId,
          turnId: action.payload.turnId,
        };
      });

      return {
        ...state,
        isSubmitting: false,
        isStreaming: true,
        activeSessionId: action.payload.sessionId,
        activeTurnId: action.payload.turnId,
        activeAttemptId: action.payload.attemptId,
        activeTurnMode: 'text',
        turnStatus: 'accepted',
        turnError: null,
        calendarProgress: null,
        calendarClarification: null,
        calendarLastSequence: -1,
        sessionsRevision: state.sessionsRevision + (trackInSidebar ? 1 : 0),
        localSessionIds: trackInSidebar
          ? [...new Set([...state.localSessionIds, action.payload.sessionId])]
          : state.localSessionIds,
        saves: trackInSidebar && state.saves[action.payload.sessionId]?.value.epoch !== action.payload.processEpoch
          ? Object.fromEntries(Object.entries(state.saves).filter(([id]) => id !== action.payload.sessionId))
          : state.saves,
        sessions: trackInSidebar
          ? sortSessions([
              ...state.sessions.filter(s => s.sessionId !== action.payload.sessionId),
              { ...(existing ?? { sessionId: action.payload.sessionId, title: firstInput.slice(0, 80), createdAt: at }), lastActivityAt: at },
            ])
          : state.sessions,
        messages,
      };
    }

    case 'TURN_SUBMIT_ERROR':
      return {
        ...state,
        isSubmitting: false,
        turnStatus: 'idle',
        draftInput: state.draftInput.length > 0 ? state.draftInput : action.payload.preservedContent,
        turnError: action.payload.error,
        calendarProgress: null,
        messages: state.messages.filter((m) => !m.messageId.startsWith('temp_')),
      };

    case 'STREAM_DELTA': {
      const incoming = action.payload.reset
        ? action.payload.text
        : state.pendingWebContinuationBreak
          ? separateStreamContinuation(state.streamText, action.payload.text)
          : action.payload.text;
      return {
        ...state,
        streamText: action.payload.reset ? incoming : state.streamText + incoming,
        pendingWebContinuationBreak: false,
      };
    }

    case 'STREAM_STATUS':
      return {
        ...state,
        turnStatus: action.payload.status,
        ...(isBusyAttemptStatus(action.payload.status) ? { turnError: null } : {}),
      };

    case 'CALENDAR_PROGRESS':
      if (ignoreCalendarAction(state, action.payload)) {
        return state;
      }
      return {
        ...state,
        calendarProgress: action.payload.phase,
        calendarLastSequence:
          action.payload.sequence !== undefined
            ? action.payload.sequence
            : state.calendarLastSequence,
      };

    case 'CALENDAR_OPERATION': {
      if (ignoreCalendarAction(state, action.payload)) {
        return state;
      }
      const { turnId, operation, sequence } = action.payload;
      const isTerminalOp =
        operation.state === 'succeeded' ||
        operation.state === 'definitely-failed' ||
        operation.state === 'failed' ||
        operation.state === 'cancelled' ||
        operation.state === 'unknown' ||
        operation.state === 'evidence-expired';
      const order = state.calendarTurnOrder.includes(turnId)
        ? state.calendarTurnOrder
        : [...state.calendarTurnOrder, turnId];
      return {
        ...state,
        calendarProgress: isTerminalOp ? null : state.calendarProgress,
        calendarClarification: isTerminalOp ? null : state.calendarClarification,
        calendarOperationsByTurn: {
          ...state.calendarOperationsByTurn,
          [turnId]: operation,
        },
        calendarTurnOrder: order,
        calendarLastSequence:
          sequence !== undefined ? sequence : state.calendarLastSequence,
      };
    }

    case 'CALENDAR_VIEW': {
      if (ignoreCalendarAction(state, action.payload)) return state;
      return {...state,calendarViewsByTurn:{...state.calendarViewsByTurn,[action.payload.turnId]:action.payload.view},
        calendarLastSequence:action.payload.sequence ?? state.calendarLastSequence};
    }

    case 'CALENDAR_CLARIFICATION': {
      if (ignoreCalendarAction(state, action.payload)) {
        return state;
      }
      const clarificationView = action.payload.clarification.view;
      return {
        ...state,
        calendarProgress: null,
        calendarViewsByTurn: clarificationView
          ? { ...state.calendarViewsByTurn, [action.payload.turnId]: clarificationView }
          : state.calendarViewsByTurn,
        calendarClarification: {
          turnId: action.payload.turnId,
          event: action.payload.clarification,
        },
        calendarLastSequence:
          action.payload.sequence !== undefined
            ? action.payload.sequence
            : state.calendarLastSequence,
      };
    }

    case 'WEB_ACTIVITY': {
      if (!acceptsFencedWebPayload(state, action.payload)) return state;
      const { turnId, sequence, activity } = action.payload;
      const existing = state.webActivitiesByTurn[turnId] ?? [];
      return {
        ...state,
        webActivitiesByTurn: {
          ...state.webActivitiesByTurn,
          [turnId]: foldWebActivities(existing, activity),
        },
        webLastSequenceByTurn: { ...state.webLastSequenceByTurn, [turnId]: sequence },
        pendingWebContinuationBreak: WEB_TOOL_IN_FLIGHT.has(activity.phase)
          ? true
          : state.pendingWebContinuationBreak,
      };
    }

    case 'WEB_SOURCES': {
      if (!acceptsFencedWebPayload(state, action.payload)) return state;
      const { turnId, sequence, sources } = action.payload;
      const existing = state.webSourcesByTurn[turnId] ?? [];
      return {
        ...state,
        webSourcesByTurn: {
          ...state.webSourcesByTurn,
          [turnId]: foldWebSources(existing, sources),
        },
        webLastSequenceByTurn: { ...state.webLastSequenceByTurn, [turnId]: sequence },
      };
    }

    case 'WEATHER_VIEW': {
      if (!acceptsFencedWeatherPayload(state, action.payload)) return state;
      const { turnId, sequence, view } = action.payload;
      return {
        ...state,
        weatherViewsByTurn: { ...state.weatherViewsByTurn, [turnId]: view },
        weatherLastSequenceByTurn: { ...state.weatherLastSequenceByTurn, [turnId]: sequence },
      };
    }

    case 'STREAM_COMPLETED': {
      const web = takeTurnWebProvenance(state, state.activeTurnId);
      const weather = takeTurnWeatherView(state, state.activeTurnId);
      const content = action.payload.reset
        ? (action.payload.text ?? '')
        : `${state.streamText}${action.payload.text ?? ''}`;
      const view = action.payload.calendarView ?? (state.activeTurnId ? state.calendarViewsByTurn[state.activeTurnId] : undefined);
      const finalWeatherView = action.payload.weatherView ?? weather.weatherView;
      const finalActivities = action.payload.webActivities !== undefined
        ? action.payload.webActivities.reduce(foldWebActivities, [] as WebSearchActivity[])
        : web.webActivities;
      const finalSources = action.payload.webSources !== undefined
        ? foldWebSources([], action.payload.webSources)
        : web.webSources;
      const assistantMsg: VisibleMessage = {
        messageId: action.payload.assistantMessageId,
        turnId: state.activeTurnId ?? 'turn_completed',
        eventId: `evt_${action.payload.assistantMessageId}`,
        sequence: nextMessageSequence(state.messages, state.compaction),
        role: 'assistant',
        content,
        createdAt: new Date().toISOString(),
        completionStatus: action.payload.outcome,
        truncated: action.payload.outcome === 'truncated',
        ...(view ? { calendarView: view } : {}),
        ...(finalWeatherView ? { weatherView: finalWeatherView } : {}),
        ...(finalActivities.length > 0 ? { webActivities: finalActivities } : {}),
        ...(finalSources.length > 0 ? { webSources: finalSources } : {}),
        ...(action.payload.memoryUpdated === true && !state.activeSessionTemporary
          ? { memoryUpdated: true as const }
          : {}),
        ...((action.payload.task ?? state.activeTask) ? { task: action.payload.task ?? state.activeTask! } : {}),
      };

      const streamingWeatherId = state.activeTurnId ? `${state.activeTurnId}::canvas::weather` : null;
      const activeCanvasArtifactId = state.activeCanvasArtifactId?.startsWith('streaming_in_flight::canvas::')
        ? state.activeCanvasArtifactId.replace(
            'streaming_in_flight::canvas::',
            `${action.payload.assistantMessageId}::canvas::`,
          )
        : streamingWeatherId && state.activeCanvasArtifactId === streamingWeatherId
          ? `${action.payload.assistantMessageId}::canvas::weather`
          : state.activeCanvasArtifactId;

      return {
        ...state,
        isStreaming: false,
        turnStatus: action.payload.outcome,
        turnError: null,
        streamText: '',
        pendingWebContinuationBreak: false,
        activeTurnId: null,
        activeAttemptId: null,
        activeTurnMode: null,
        activeCanvasArtifactId,
        calendarProgress: null,
        calendarOperationsByTurn: syncActiveCalendarNarration(state, 'completed'),
        webActivitiesByTurn: web.nextActivitiesByTurn,
        webSourcesByTurn: web.nextSourcesByTurn,
        webLastSequenceByTurn: web.nextSeqByTurn,
        weatherViewsByTurn: weather.nextViewsByTurn,
        weatherLastSequenceByTurn: weather.nextSeqByTurn,
        compaction: mergeCompaction(state.compaction, action.payload.compaction),
        contextUsage: action.payload.contextUsage ?? state.contextUsage,
        messages: [...state.messages, assistantMsg],
        activeTask: null,
      };
    }

    case 'TASK_MODE_SET':
      return { ...state, taskMode: action.payload };

    case 'TASK_EVENT': {
      const { sessionId, turnId, attemptId, event } = action.payload;
      if (sessionId !== state.activeSessionId || turnId !== state.activeTurnId || attemptId !== state.activeAttemptId) {
        return state;
      }
      if (event.type === 'task-plan') return { ...state, activeTask: snapshotForPlan(event) };
      return state.activeTask ? { ...state, activeTask: applyTaskStep(state.activeTask, event) } : state;
    }

    case 'STREAM_ERROR': {
      const web = takeTurnWebProvenance(state, state.activeTurnId);
      const weather = takeTurnWeatherView(state, state.activeTurnId);
      return {
        ...state,
        isStreaming: false,
        activeTurnMode: null,
        turnStatus: 'failed',
        turnError: action.payload,
        streamText: '',
        pendingWebContinuationBreak: false,
        calendarProgress: null,
        calendarOperationsByTurn: syncActiveCalendarNarration(state, 'failed'),
        webActivitiesByTurn: web.nextActivitiesByTurn,
        webSourcesByTurn: web.nextSourcesByTurn,
        webLastSequenceByTurn: web.nextSeqByTurn,
        weatherViewsByTurn: weather.nextViewsByTurn,
        weatherLastSequenceByTurn: weather.nextSeqByTurn,
        messages: appendTerminalAssistant(
          state,
          'failed',
          false,
          `failed_${state.activeTurnId ?? 'turn'}`,
          web,
        ),
      };
    }

    case 'STREAM_CANCELLED': {
      const web = takeTurnWebProvenance(state, state.activeTurnId);
      const weather = takeTurnWeatherView(state, state.activeTurnId);
      return {
        ...state,
        isStreaming: false,
        activeTurnMode: null,
        turnStatus: 'cancelled',
        turnError: null,
        streamText: '',
        pendingWebContinuationBreak: false,
        calendarProgress: null,
        calendarOperationsByTurn: syncActiveCalendarNarration(state, 'interrupted'),
        webActivitiesByTurn: web.nextActivitiesByTurn,
        webSourcesByTurn: web.nextSourcesByTurn,
        webLastSequenceByTurn: web.nextSeqByTurn,
        weatherViewsByTurn: weather.nextViewsByTurn,
        weatherLastSequenceByTurn: weather.nextSeqByTurn,
        messages: appendTerminalAssistant(
          state,
          'cancelled',
          false,
          `cancelled_${state.activeTurnId ?? 'turn'}`,
          web,
        ),
      };
    }

    case 'STREAM_INTERRUPTED': {
      const web = takeTurnWebProvenance(state, state.activeTurnId);
      const weather = takeTurnWeatherView(state, state.activeTurnId);
      return {
        ...state,
        isStreaming: false,
        activeTurnMode: null,
        turnStatus: 'interrupted',
        streamText: '',
        pendingWebContinuationBreak: false,
        calendarProgress: null,
        calendarOperationsByTurn: syncActiveCalendarNarration(state, 'interrupted'),
        webActivitiesByTurn: web.nextActivitiesByTurn,
        webSourcesByTurn: web.nextSourcesByTurn,
        webLastSequenceByTurn: web.nextSeqByTurn,
        weatherViewsByTurn: weather.nextViewsByTurn,
        weatherLastSequenceByTurn: weather.nextSeqByTurn,
        messages: appendTerminalAssistant(
          state,
          'interrupted',
          false,
          `interrupted_${state.activeTurnId ?? 'turn'}`,
          web,
        ),
      };
    }

    default:
      return state;
  }
}
