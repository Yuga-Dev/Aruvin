/**
 * ============================================================================
 * FILE: ChatView.tsx
 * LOCATION: frontend/src/features/chat/ChatView.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Assemble sidebar, header, transcript or live voice surface, composer, and Canvas.
 *
 * ROLE IN PROJECT:
 *    Public chat feature container mounted inside ChatProvider. Coordinates
 *    unified text + live-voice Canvas artifacts, live voice Calendar auto-open
 *    and sticky dismissal, 320 ms right-slide entry/exit mounting with inert +
 *    focus restoration, and layout chrome without restarting active media
 *    instances. Text Calendar stays manual.
 *
 * KEY COMPONENTS:
 *    - Responsive layout shell with split-screen desktop / overlay mobile Canvas
 *    - Session header and unified Canvas toggle controls
 *    - LiveVoicePanel versus EmptyState / Transcript switch
 *    - Ctrl/Cmd+K command palette (shell actions, theme, loaded chats)
 * ============================================================================
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import type { AuthUser } from '../../api/auth-protocol.ts';
import type { CanvasControlArguments } from '../../api/voice-protocol.ts';
import { Composer } from '../../components/Composer.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { IconNewChat, IconSidebar } from '../../components/icons.tsx';
import { Sidebar } from '../../components/Sidebar.tsx';
import { CommandPalette } from '../../components/CommandPalette.tsx';
import { isPaletteShortcut, type PaletteItem } from '../../components/command-palette.ts';
import { shellNavItems } from '../../app/navigation.ts';
import { useTheme } from '../../app/theme/ThemeProvider.tsx';
import { THEME_PREFERENCES } from '../../app/theme/theme.ts';
import { Transcript } from '../../components/Transcript.tsx';
import {
  CANVAS_TRANSITION_MS,
  calendarViewArtifact,
  claimCalendarAutoOpenId,
  claimNewAutoOpenArtifactId,
  claimWeatherAutoOpenId,
  collectSessionCanvasArtifacts,
  matchesCanvasArtifact,
  mergeCalendarWorkspaces,
  mergeSessionCanvasArtifacts,
  mergeWeatherWorkspaces,
  prefersReducedCanvasMotion,
  restoreCanvasCloseFocus,
  weatherViewArtifact,
  type CalendarWorkspace,
  type CanvasArtifact,
  type CanvasPanelHandle,
  type WeatherWorkspace,
} from '../canvas/index.ts';
import { lazyComponent, LazyBoundary } from '../../app/lazy.tsx';
import type { CanvasPanel as CanvasPanelType } from '../canvas/CanvasPanel.tsx';
import { CalendarTurnRegion } from '../plugins/google-calendar/index.ts';
import { restoreLiveDraftFocus } from '../voice/live/live-voice-lifecycle.ts';
import { LiveVoicePanel } from '../voice/live/LiveVoicePanel.tsx';
import { showsLiveVoice, type LiveDraft } from '../voice/state/live-voice-reducer.ts';
import type { LiveVoiceSurface } from '../voice/state/useLiveVoice.ts';
import { FEATURE_FLAGS } from '../../app/feature-flags.ts';
import { ExportMenu } from './ExportMenu.tsx';
import { useChat } from './state/chat-context.tsx';
import { canToggleTemporaryChat, describeTurnError } from './state/chat-reducer.ts';
import type { ChatState } from './state/chat-types.ts';

/** Canvas panel (renderers, calendar/weather views) loads on first open, not with the chat shell. */
export const LazyCanvasPanel = lazyComponent<ComponentProps<typeof CanvasPanelType>>(() =>
  import('../canvas/CanvasPanel.tsx').then((m) => ({ default: m.CanvasPanel })));
const NOTICE_TIMEOUT_MS = 6_000;
const EMPTY_CALENDAR_WORKSPACES: readonly CalendarWorkspace[] = [];
const EMPTY_WEATHER_WORKSPACES: readonly WeatherWorkspace[] = [];

type ExitingCanvasSnapshot = {
  artifacts: CanvasArtifact[];
  activeArtifactId: string | null;
  sessionId: string | null;
};

export type TemporaryChatHeaderState = {
  showToggle: boolean;
  togglePressed: boolean;
  showActivePill: boolean;
};

// oxlint-disable-next-line react/only-export-components -- pure header predicate shared with tests
export function getTemporaryChatHeaderState(
  state: Pick<
    ChatState,
    | 'activeSessionId'
    | 'activeSessionTemporary'
    | 'messages'
    | 'isSubmitting'
    | 'isStreaming'
    | 'turnStatus'
    | 'voiceInput'
  >,
  liveActive: boolean,
): TemporaryChatHeaderState {
  if (liveActive) {
    return { showToggle: false, togglePressed: false, showActivePill: false };
  }
  const canToggle = canToggleTemporaryChat(state);
  const isTemporary = Boolean(state.activeSessionTemporary);
  return {
    showToggle: canToggle,
    togglePressed: canToggle && isTemporary,
    showActivePill: isTemporary,
  };
}

export function ChatView(props: {
  liveVoice?: LiveVoiceSurface;
  visible?: boolean;
  onManageAurvin?: () => void;
  onOpenMemorySettings?: () => void;
  onOpenCalendarSetup?: () => void;
  user?: AuthUser | null;
  onSignOut?: () => void;
}) {
  const liveVoice = props?.liveVoice;
  const visible = props.visible ?? true;
  const returning = useRef(visible);
  const { state, dispatch, actions } = useChat();
  const [saveNotice, setSaveNotice] = useState<{ sessionId: string | null; version: number | undefined; text: string } | null>(null);
  const [retryingSave, setRetryingSave] = useState(false);
  const currentSave =
    state.activeSessionId && !state.activeSessionTemporary
      ? state.saves?.[state.activeSessionId]?.value
      : undefined;
  const saveLabel = currentSave && currentSave.state !== 'saved' ? {
    pending: 'Answer ready. Waiting to save.', saving: 'Answer ready. Saving…',
    failed: 'Saving failed. Keep a copy of this conversation.', unknown: 'Save confirmation is unavailable. Keep a copy.',
    fenced: 'Saving stopped because this chat changed. Keep a copy.',
  }[currentSave.state] : null;
  const notice = (text: string) => setSaveNotice({ sessionId: state.activeSessionId, version: currentSave?.version, text });
  const retrySaving = async () => {
    setRetryingSave(true); setSaveNotice(null);
    try { await actions.retrySave(); }
    catch (error) { notice(error instanceof Error ? error.message : 'Saving is unavailable. Keep a copy.'); }
    finally { setRetryingSave(false); }
  };
  const copyConversation = async () => {
    try {
      const lines = state.messages.flatMap((m) =>
        m.voiceTranscripts?.length
          ? m.voiceTranscripts.map((vt) => `${vt.role}: ${vt.content}`)
          : [`${m.role}: ${m.content}`],
      );
      await navigator.clipboard.writeText(lines.join('\n\n'));
      notice('Conversation copied. This copy does not restore server history.');
    } catch { notice('Copy is unavailable. Select the conversation text and copy it manually.'); }
  };
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [greetingKey, setGreetingKey] = useState(0);
  const [hiddenNotice, setHiddenNotice] = useState<string | null>(null);
  const [exitingCanvas, setExitingCanvas] = useState<ExitingCanvasSnapshot | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const theme = useTheme();
  const isEmpty = !state.activeSessionId && state.messages.length === 0 && !state.isStreaming;
  const liveActive = liveVoice ? showsLiveVoice(liveVoice.view) : false;
  const tempHeader = getTemporaryChatHeaderState(state, liveActive);
  const showExportMenu = FEATURE_FLAGS.exportMarkdown && !liveActive && !state.activeSessionTemporary && Boolean(state.activeSessionId);
  const rawNotice = liveVoice?.view.notice ?? null;
  const visibleNotice = rawNotice && rawNotice !== hiddenNotice ? rawNotice : null;
  const mainRef = useRef<HTMLElement | null>(null);
  const liveSurfaceRef = useRef<HTMLElement | null>(null);
  const liveCanvasToggleRef = useRef<HTMLButtonElement | null>(null);
  const headerCanvasToggleRef = useRef<HTMLButtonElement | null>(null);
  const canvasControlRef = useRef<CanvasPanelHandle | null>(null);
  const [canvasPresentationMode, setCanvasPresentationMode] = useState<'diagram' | 'scroll'>('diagram');
  const [canvasMaximized, setCanvasMaximized] = useState(false);
  const restored = useRef<LiveDraft | null>(null);
  const seenLiveArtifactIdsRef = useRef<Set<string>>(new Set());
  const seenVoiceCalendarIdsRef = useRef<Set<string>>(new Set());
  const seenVoiceWeatherIdsRef = useRef<Set<string>>(new Set());
  const previousVoicePhaseRef = useRef<LiveVoiceSurface['view']['phase'] | null>(liveVoice?.view.phase ?? null);
  const previousSessionIdRef = useRef<string | null>(state.activeSessionId);

  const canvasSourceMessages = useMemo(() => {
    if (state.canvasMessages.length === 0) return state.messages;
    const merged = new Map(state.canvasMessages.map((message) => [message.messageId, message]));
    for (const message of state.messages) merged.set(message.messageId, message);
    return [...merged.values()].sort((a, b) => a.sequence - b.sequence);
  }, [state.canvasMessages, state.messages]);

  const archivedArtifacts = useMemo(
    () => collectSessionCanvasArtifacts(canvasSourceMessages, '', false),
    [canvasSourceMessages],
  );
  const textArtifacts = useMemo(() => {
    const base=collectSessionCanvasArtifacts(canvasSourceMessages,state.streamText,state.isStreaming,
      state.calendarOperationsByTurn,archivedArtifacts);
    const persistedTurns=new Set(base.filter(a=>a.calendarView).map(a=>a.turnId));
    const active=Object.entries(state.calendarViewsByTurn).filter(([turnId])=>!persistedTurns.has(turnId))
      .map(([turnId,view])=>calendarViewArtifact(view,turnId,turnId));
    const structuredTurns=new Set(active.map(a=>a.turnId));
    const persistedWeatherTurns=new Set(base.filter(a=>a.weatherView).map(a=>a.turnId));
    const activeWeather=Object.entries(state.weatherViewsByTurn)
      .filter(([turnId])=>!persistedWeatherTurns.has(turnId))
      .map(([turnId,view])=>weatherViewArtifact(view,turnId,turnId));
    return [...base.filter(a=>!(a.kind === 'calendar' && !a.calendarView && structuredTurns.has(a.turnId))),
      ...active,...activeWeather];
  }, [archivedArtifacts, canvasSourceMessages, state.streamText, state.isStreaming, state.calendarOperationsByTurn,
    state.calendarViewsByTurn, state.weatherViewsByTurn]);

  const includeLiveArtifacts = Boolean(
    liveVoice &&
      (liveActive || liveVoice.view.phase === 'ending' || state.messagesLoading) &&
      (liveVoice.view.conversationId !== null && state.activeSessionId !== null
        ? liveVoice.view.conversationId === state.activeSessionId
        : liveActive),
  );
  const liveProjections = useMemo(
    () => (includeLiveArtifacts && liveVoice ? liveVoice.view.artifacts : []),
    [includeLiveArtifacts, liveVoice],
  );

  const calendarWorkspaces = liveVoice?.view.conversationId && liveVoice.view.conversationId === state.activeSessionId
    ? liveVoice.view.calendarWorkspaces : EMPTY_CALENDAR_WORKSPACES;
  const weatherWorkspaces = liveVoice?.view.conversationId && liveVoice.view.conversationId === state.activeSessionId
    ? liveVoice.view.weatherWorkspaces : EMPTY_WEATHER_WORKSPACES;

  const sessionArtifacts = useMemo(
    () => mergeWeatherWorkspaces(
      mergeCalendarWorkspaces(
        mergeSessionCanvasArtifacts(textArtifacts, liveProjections, state.calendarOperationsByTurn),
        calendarWorkspaces,
        includeLiveArtifacts,
      ),
      weatherWorkspaces,
      includeLiveArtifacts,
    ),
    [textArtifacts, liveProjections, state.calendarOperationsByTurn, calendarWorkspaces, weatherWorkspaces,
      includeLiveArtifacts],
  );

  const openCanvasArtifacts = useMemo(() => {
    const filtered = sessionArtifacts.filter(
      (a) => (state.canvasOpen && matchesCanvasArtifact(a,state.activeCanvasArtifactId)) ||
        !state.closedCanvasArtifactIds.some(id=>matchesCanvasArtifact(a,id)),
    );
    return filtered.length > 0 ? filtered : sessionArtifacts;
  }, [sessionArtifacts, state.closedCanvasArtifactIds, state.canvasOpen, state.activeCanvasArtifactId]);

  const showCanvasPanel = state.canvasOpen && openCanvasArtifacts.length > 0;
  const activeExitingCanvas =
    !showCanvasPanel &&
    exitingCanvas !== null &&
    exitingCanvas.sessionId === state.activeSessionId &&
    exitingCanvas.artifacts.length > 0
      ? exitingCanvas
      : null;

  useLayoutEffect(() => {
    const prev = previousSessionIdRef.current;
    if (prev !== state.activeSessionId) {
      const sameCallBinding = prev === null && state.activeSessionId !== null && liveActive;
      if (!sameCallBinding) {
        seenLiveArtifactIdsRef.current.clear();
        seenVoiceCalendarIdsRef.current.clear();
        seenVoiceWeatherIdsRef.current.clear();
        setCanvasMaximized(false);
      }
      previousSessionIdRef.current = state.activeSessionId;
    }

    const autoOpenId = claimNewAutoOpenArtifactId(liveProjections, seenLiveArtifactIdsRef.current);
    if (
      autoOpenId &&
      (!state.canvasOpen || state.activeCanvasArtifactId !== autoOpenId)
    ) {
      dispatch({ type: 'OPEN_CANVAS_ARTIFACT', payload: { artifactId: autoOpenId } });
    }
  }, [
    dispatch,
    liveActive,
    liveProjections,
    state.activeCanvasArtifactId,
    state.activeSessionId,
    state.canvasOpen,
  ]);

  useEffect(() => {
    const phase = liveVoice?.view.phase ?? null;
    if (phase === previousVoicePhaseRef.current) return;
    if (phase === 'requesting_permission') {
      seenVoiceCalendarIdsRef.current.clear();
      seenVoiceWeatherIdsRef.current.clear();
    }
    previousVoicePhaseRef.current = phase;
  }, [liveVoice?.view.phase]);

  useEffect(()=>{
    const id=claimCalendarAutoOpenId({live:liveActive,conversationId:liveVoice?.view.conversationId ?? null,
      selectedId:state.activeSessionId,workspaces:calendarWorkspaces,artifacts:sessionArtifacts,seen:seenVoiceCalendarIdsRef.current});
    if (id) dispatch({type:'OPEN_CANVAS_ARTIFACT',payload:{artifactId:id}});
  },[liveActive,liveVoice?.view.conversationId,state.activeSessionId,calendarWorkspaces,sessionArtifacts,dispatch]);

  useEffect(() => {
    const id = claimWeatherAutoOpenId({
      live: liveActive,
      conversationId: liveVoice?.view.conversationId ?? null,
      selectedId: state.activeSessionId,
      workspaces: weatherWorkspaces,
      artifacts: sessionArtifacts,
      seen: seenVoiceWeatherIdsRef.current,
    });
    if (id) dispatch({ type: 'OPEN_CANVAS_ARTIFACT', payload: { artifactId: id } });
  }, [
    liveActive,
    liveVoice?.view.conversationId,
    state.activeSessionId,
    weatherWorkspaces,
    sessionArtifacts,
    dispatch,
  ]);

  useEffect(() => {
    if (!activeExitingCanvas) return;
    const timer = setTimeout(() => setExitingCanvas(null), CANVAS_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [activeExitingCanvas]);

  useEffect(() => {
    if (!rawNotice || liveActive) return;
    const timer = setTimeout(() => setHiddenNotice(rawNotice), NOTICE_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      setHiddenNotice(null);
    };
  }, [rawNotice, liveActive]);

  useLayoutEffect(() => {
    if (!visible) return;
    if (!liveActive) {
      restoreLiveDraftFocus(
        mainRef.current?.querySelector<HTMLTextAreaElement>('.aurvin-textarea') ?? null,
        liveVoice?.view.restoreDraft ?? null,
        restored,
      );
    }
  }, [visible, liveActive, liveVoice?.view.restoreDraft, state.draftInput]);

  useLayoutEffect(() => {
    if (visible && !returning.current) {
      const profile = document.querySelector<HTMLElement>('.aurvin-profile-trigger');
      const openSidebar = document.querySelector<HTMLElement>('button[aria-label="Open sidebar"]');
      const composer = mainRef.current?.querySelector<HTMLTextAreaElement>('.aurvin-textarea');
      const target =
        profile && profile.getClientRects().length > 0
          ? profile
          : openSidebar && openSidebar.getClientRects().length > 0
            ? openSidebar
            : composer;
      target?.focus();
    }
    returning.current = visible;
  }, [visible]);

  const restoreFocusAfterCanvasClose = () => {
    restoreCanvasCloseFocus({
      liveActive,
      liveCanvasToggle: liveCanvasToggleRef.current,
      liveSurface: liveSurfaceRef.current,
      headerCanvasToggle: headerCanvasToggleRef.current,
      composer: mainRef.current?.querySelector<HTMLTextAreaElement>('.aurvin-textarea') ?? null,
    });
  };

  const captureExitingCanvas = () => {
    if (!prefersReducedCanvasMotion() && openCanvasArtifacts.length > 0) {
      setExitingCanvas({
        artifacts: openCanvasArtifacts,
        activeArtifactId: state.activeCanvasArtifactId,
        sessionId: state.activeSessionId,
      });
    } else {
      setExitingCanvas(null);
    }
  };

  const closeCanvasPanel = () => {
    captureExitingCanvas();
    dispatch({ type: 'CLOSE_CANVAS' });
    restoreFocusAfterCanvasClose();
  };

  const toggleCanvasPanel = () => {
    if (showCanvasPanel) {
      closeCanvasPanel();
      return;
    }
    if (sessionArtifacts.length === 0) return;
    setExitingCanvas(null);
    setCanvasMaximized(false);
    const hasOpenActive =
      state.activeCanvasArtifactId !== null &&
      openCanvasArtifacts.some((item) => matchesCanvasArtifact(item, state.activeCanvasArtifactId));
    const targetId = hasOpenActive
      ? state.activeCanvasArtifactId!
      : (openCanvasArtifacts[openCanvasArtifacts.length - 1] ??
          sessionArtifacts[sessionArtifacts.length - 1])!.artifactId;
    dispatch({ type: 'OPEN_CANVAS_ARTIFACT', payload: { artifactId: targetId } });
  };

  const selectedArtifact = state.activeCanvasArtifactId
    ? sessionArtifacts.find((a) => matchesCanvasArtifact(a, state.activeCanvasArtifactId)) ?? null
    : null;
  const updateCanvasInventory = liveVoice?.updateCanvasInventory;

  // Publish the full merged inventory plus the exact currently selected Canvas control target.
  useLayoutEffect(() => {
    const selectedMode: 'diagram' | 'scroll' =
      selectedArtifact?.kind === 'calendar' || selectedArtifact?.kind === 'weather'
        ? 'scroll'
        : canvasPresentationMode;
    const open = showCanvasPanel;
    const fullscreen = open && canvasMaximized;
    const presentation = visible && selectedArtifact
      ? {
          canvasId: selectedArtifact.artifactId,
          open,
          fullscreen,
          mode: selectedMode,
          apply: (command: CanvasControlArguments) => {
            if (command.action === 'close' && !open) return 'applied';
            let outcome: 'applied' | 'unavailable' | 'unsupported' = 'unavailable';
            flushSync(() => {
              outcome = canvasControlRef.current?.apply(command, selectedArtifact.artifactId) ?? 'unavailable';
            });
            return outcome;
          },
        }
      : null;
    updateCanvasInventory?.(state.activeSessionId, sessionArtifacts, presentation);
  }, [
    updateCanvasInventory,
    state.activeSessionId,
    sessionArtifacts,
    visible,
    selectedArtifact,
    showCanvasPanel,
    canvasPresentationMode,
    canvasMaximized,
  ]);

  useLayoutEffect(() => () => {
    updateCanvasInventory?.(null, []);
  }, [updateCanvasInventory]);

  const collapseSidebar = useCallback(() => setDesktopCollapsed(true), []);
  const newChatAction = actions.startNewChat;
  const startNewChat = useCallback(() => {
    setExitingCanvas(null);
    setCanvasMaximized(false);
    seenLiveArtifactIdsRef.current.clear();
    seenVoiceCalendarIdsRef.current.clear();
    seenVoiceWeatherIdsRef.current.clear();
    newChatAction();
    setGreetingKey((key) => key + 1);
  }, [newChatAction]);

  useEffect(() => {
    if (!visible) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible]);

  const openCommandPalette = useCallback(() => {
    dispatch({ type: 'CLOSE_SIDEBAR' });
    setPaletteOpen(true);
  }, [dispatch]);
  const closeCommandPalette = useCallback(() => setPaletteOpen(false), []);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    if (!paletteOpen) return [];
    const navItems = shellNavItems(
      { onManageAurvin: props.onManageAurvin, onOpenIntegrations: props.onOpenCalendarSetup, onOpenMemory: props.onOpenMemorySettings },
      props.user?.role,
    );
    const items: PaletteItem[] = [
      { id: 'new-chat', group: 'Actions', label: 'New chat', run: startNewChat },
      ...navItems.map((nav): PaletteItem => ({ id: `nav-${nav.id}`, group: 'Actions', label: `Open ${nav.label}`, run: nav.onSelect })),
      ...state.sessions.map((session): PaletteItem => ({
        id: `session-${session.sessionId}`,
        group: 'Conversations',
        label: session.title || 'Untitled Chat',
        hint: session.pinned ? 'Pinned' : undefined,
        run: () => { void actions.selectSession(session.sessionId, session.title); },
      })),
      ...(theme ? THEME_PREFERENCES.map((preference): PaletteItem => ({
        id: `theme-${preference}`,
        group: 'Theme',
        label: `${preference[0].toUpperCase()}${preference.slice(1)} theme`,
        hint: theme.preference === preference ? 'Current' : undefined,
        run: () => theme.setPreference(preference),
      })) : []),
    ];
    return items;
  }, [paletteOpen, startNewChat, props.onManageAurvin, props.onOpenCalendarSetup, props.onOpenMemorySettings, props.user?.role,
    state.sessions, actions, theme]);

  const renderedCanvas = showCanvasPanel
    ? {
        artifacts: openCanvasArtifacts,
        activeArtifactId: state.activeCanvasArtifactId,
        transitionState: 'open' as const,
      }
    : activeExitingCanvas
      ? {
          artifacts: activeExitingCanvas.artifacts,
          activeArtifactId: activeExitingCanvas.activeArtifactId,
          transitionState: 'exiting' as const,
        }
      : null;

  useLayoutEffect(() => {
    if (!renderedCanvas && canvasMaximized) setCanvasMaximized(false);
  }, [renderedCanvas, canvasMaximized]);

  const canvasTransitionExiting = renderedCanvas?.transitionState === 'exiting';
  const liveCalendarControls = Boolean(
    liveActive && liveVoice?.view.conversationId === state.activeSessionId && !canvasTransitionExiting,
  );
  const calendarControlsDisabled = Boolean(
    !liveActive ||
      liveVoice?.view.conversationId !== state.activeSessionId ||
      canvasTransitionExiting ||
      liveVoice?.view.agent === 'thinking' ||
      liveVoice?.view.inputBusy ||
      liveVoice?.view.connection !== 'connected',
  );

  const turnErrorInfo = state.turnError
    ? describeTurnError(state.turnError, Boolean(state.activeSessionId))
    : null;
  const turnErrorNotice = turnErrorInfo ? (
    <div className="aurvin-turn-error" role="alert">
      <p className="aurvin-turn-error-text">{turnErrorInfo.message}</p>
      <div className="aurvin-turn-error-actions">
        {turnErrorInfo.canContinueInNewChat ? (
          <button
            type="button"
            className="aurvin-turn-error-btn"
            onClick={() => {
              actions.continueInNewChat?.();
              const focusComposer = () => {
                mainRef.current?.querySelector<HTMLTextAreaElement>('.aurvin-textarea')?.focus();
              };
              if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusComposer);
              else focusComposer();
            }}
          >
            Continue in a new chat
          </button>
        ) : null}
        <button
          type="button"
          className="aurvin-turn-error-dismiss"
          aria-label="Dismiss error"
          onClick={() => dispatch({ type: 'DISMISS_TURN_ERROR' })}
        >
          Dismiss
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div
      className={`aurvin-layout${desktopCollapsed ? ' aurvin-layout-collapsed' : ''}${showCanvasPanel ? ' aurvin-layout-canvas-open' : ''}`}
    >
      <Sidebar
        onCollapse={collapseSidebar}
        onNewChat={startNewChat}
        onManageAurvin={props.onManageAurvin}
        onOpenIntegrations={props.onOpenCalendarSetup}
        onOpenMemory={props.onOpenMemorySettings}
        onOpenCommandPalette={openCommandPalette}
        user={props.user}
        onSignOut={props.onSignOut}
      />

      {state.sidebarOpen ? (
        <button
          type="button"
          className="aurvin-backdrop"
          aria-label="Close sidebar"
          onClick={() => dispatch({ type: 'CLOSE_SIDEBAR' })}
        />
      ) : null}

      <main ref={mainRef} className="aurvin-main" role="main">
        <header className="aurvin-header">
          <div className="aurvin-header-left">
            <button
              type="button"
              className="aurvin-chat-icon-btn aurvin-header-menu"
              onClick={() => {
                dispatch({ type: 'TOGGLE_SIDEBAR' });
                setDesktopCollapsed(false);
              }}
              aria-label="Open sidebar"
              aria-expanded={state.sidebarOpen || !desktopCollapsed}
            >
              <IconSidebar />
            </button>
            <button
              type="button"
              className="aurvin-chat-icon-btn aurvin-header-new"
              onClick={startNewChat}
              aria-label="Start a new chat"
            >
              <IconNewChat />
            </button>
          </div>

          {tempHeader.showToggle || tempHeader.showActivePill || showExportMenu || (sessionArtifacts.length > 0 && !liveActive) ? (
            <div className="aurvin-header-right">
              {showExportMenu && state.activeSessionId ? (
                <ExportMenu sessionId={state.activeSessionId} empty={state.messages.length === 0}
                  title={state.sessions.find((s) => s.sessionId === state.activeSessionId)?.title ?? 'chat'} />
              ) : null}
              {tempHeader.showActivePill ? (
                <span className="aurvin-compaction-pill aurvin-temp-chat-pill" role="status">
                  Temporary chat — not saved, memory off
                </span>
              ) : null}
              {tempHeader.showToggle ? (
                <button
                  type="button"
                  className="aurvin-canvas-header-btn aurvin-temp-chat-toggle"
                  data-open={tempHeader.togglePressed ? 'true' : 'false'}
                  aria-pressed={tempHeader.togglePressed}
                  aria-label={tempHeader.togglePressed ? 'Disable temporary chat' : 'Enable temporary chat'}
                  onClick={() =>
                    dispatch({ type: 'SET_TEMPORARY_CHAT', payload: !state.activeSessionTemporary })
                  }
                >
                  <span>Temporary chat</span>
                </button>
              ) : null}
              {sessionArtifacts.length > 0 && !liveActive ? (
                <button
                  ref={headerCanvasToggleRef}
                  type="button"
                  className="aurvin-canvas-header-btn"
                  data-open={showCanvasPanel ? 'true' : 'false'}
                  aria-label={showCanvasPanel ? 'Close Canvas panel' : 'Open Canvas panel'}
                  aria-expanded={showCanvasPanel}
                  aria-controls="aurvin-canvas-panel"
                  onClick={toggleCanvasPanel}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M14 4v16" />
                  </svg>
                  <span>Canvas</span>
                  <span className="aurvin-canvas-header-count">{sessionArtifacts.length}</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </header>

        {liveActive && liveVoice ? (
          <>
            <LiveVoicePanel
              voice={liveVoice}
              surfaceRef={liveSurfaceRef}
              canvas={{
                artifactCount: sessionArtifacts.length,
                open: showCanvasPanel,
                onToggle: toggleCanvasPanel,
                toggleRef: liveCanvasToggleRef,
              }}
            />
            {saveLabel ? (
              <div className="aurvin-save-notice" role="status" aria-live="polite">
                <span>{saveLabel}</span>
                {currentSave && ['failed', 'unknown'].includes(currentSave.state) ? (
                  <button type="button" disabled={retryingSave} onClick={() => { void retrySaving(); }}>
                    Retry saving
                  </button>
                ) : null}
              </div>
            ) : null}
            {saveNotice && saveNotice.sessionId === state.activeSessionId && saveNotice.version === currentSave?.version ? (
              <p className="aurvin-save-notice" role="status">{saveNotice.text}</p>
            ) : null}
          </>
        ) : (
          <>
            {isEmpty ? (
              <div className="aurvin-empty">
                <EmptyState key={greetingKey} />
                <Composer variant="centered" />
                {turnErrorNotice}
              </div>
            ) : (
              <Transcript onOpenMemorySettings={props.onOpenMemorySettings ?? props.onManageAurvin}>
                <CalendarTurnRegion
                  onOpenCalendarSetup={props.onOpenCalendarSetup ?? props.onManageAurvin}
                  onFocusComposer={() => {
                    mainRef.current?.querySelector<HTMLTextAreaElement>('.aurvin-textarea')?.focus();
                  }}
                />
              </Transcript>
            )}

            {isEmpty ? null : (
              <>
                {turnErrorNotice}
                <Composer variant="docked" />
              </>
            )}
            {saveLabel ? <div className="aurvin-save-notice" role="status" aria-live="polite">
              <span>{saveLabel}</span>
              {currentSave && ['failed', 'unknown'].includes(currentSave.state) ?
                <button type="button" disabled={retryingSave} onClick={() => { void retrySaving(); }}>Retry saving</button> : null}
              {currentSave?.state !== 'saved' ? <button type="button" onClick={() => { void copyConversation(); }}>Copy conversation</button> : null}
            </div> : null}
            {saveNotice && saveNotice.sessionId === state.activeSessionId && saveNotice.version === currentSave?.version ?
              <p className="aurvin-save-notice" role="status">{saveNotice.text}</p> : null}
            {visibleNotice ? (
              <p className="aurvin-live-chat-notice" role="status" aria-live="polite" aria-atomic="true">
                {visibleNotice}
              </p>
            ) : null}
            <p className="aurvin-disclaimer">Aurvin can make mistakes. Check important information.</p>
          </>
        )}
      </main>

      {renderedCanvas ? (
        <LazyBoundary label="Canvas"><LazyCanvasPanel
          artifacts={renderedCanvas.artifacts}
          activeArtifactId={renderedCanvas.activeArtifactId}
          transitionState={renderedCanvas.transitionState}
          controlRef={canvasControlRef}
          maximized={canvasMaximized}
          onMaximizedChange={setCanvasMaximized}
          onPresentationModeChange={setCanvasPresentationMode}
          onSelectArtifact={(artifactId) => {
            setExitingCanvas(null);
            dispatch({ type: 'OPEN_CANVAS_ARTIFACT', payload: { artifactId } });
          }}
          onCloseTab={(artifactId) => {
            const remaining = openCanvasArtifacts.filter((a) => a.artifactId !== artifactId);
            const fallback =
              remaining.length > 0 ? remaining[remaining.length - 1]!.artifactId : null;
            if (fallback === null) {
              captureExitingCanvas();
            }
            dispatch({
              type: 'CLOSE_CANVAS_TAB',
              payload: { artifactId, fallbackArtifactId: fallback },
            });
            if (fallback === null) {
              restoreFocusAfterCanvasClose();
            }
          }}
          onClosePanel={closeCanvasPanel}
          calendarControlsDisabled={calendarControlsDisabled}
          onCalendarAnswer={liveCalendarControls
            ? (id,revision,answer)=>{ liveVoice?.confirmCalendar?.(id,revision,answer); }
            : undefined}
          onChangeCity={!liveActive ? (city) => {
            void actions.submitMessage(`What's the weather in ${city}?`);
          } : undefined}
          changeCityDisabled={
            liveActive ||
            state.isStreaming ||
            state.isSubmitting ||
            state.turnStatus === 'accepted' ||
            state.turnStatus === 'generating' ||
            state.turnStatus === 'finalizing'
          }
          liveVoiceActive={liveActive}
          onOpenPersonalization={!liveActive ? props.onManageAurvin : undefined}
        /></LazyBoundary>
      ) : null}

      <CommandPalette open={paletteOpen && visible} items={paletteItems} onClose={closeCommandPalette} />
    </div>
  );
}
