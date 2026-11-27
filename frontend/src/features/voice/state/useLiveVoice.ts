/**
 * ============================================================================
 * FILE: useLiveVoice.ts
 * LOCATION: frontend/src/features/voice/state/useLiveVoice.ts
 * ============================================================================
 *
 * PURPOSE:
 *    React external store hook binding LiveVoiceController to the UI.
 *
 * ROLE IN PROJECT:
 *    Exposes live voice state and actions without opening media, Rooms, or sockets
 *    during render or effect execution. Live mode constructs only the LiveKit
 *    WebRTC client; dictation keeps its own PCM composition elsewhere.
 *
 * KEY COMPONENTS:
 *    - useLiveVoice: React hook using useSyncExternalStore.
 *    - supportsLiveVoice: Live-only secure-context/media/WebRTC support probe.
 *    - snapshotLiveDraft: Helper capturing UTF-16 textarea selection.
 *    - LiveVoiceSurface: Return type for ChatView and LiveVoicePanel consumption.
 * ============================================================================
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createLazyLiveKitClient, preloadLiveKitClient } from './lazy-livekit-client.ts';
import { VoiceHttpClient } from '../../../api/voice-client.ts';
import type { CalendarConfirmPayload } from '../../../api/voice-protocol.ts';
import type { CanvasArtifact } from '../../canvas/canvas-types.ts';
import {
  canStartLiveVoiceForChat,
  TEMPORARY_LIVE_VOICE_ENABLED,
} from '../../chat/state/chat-reducer.ts';
import { attachLiveVoiceLifecycle } from '../live/live-voice-lifecycle.ts';
import { LiveVoiceController, type CanvasPresentationBinding, type LiveVoiceBindings } from './live-voice-controller.ts';
import type { LiveDraft, LiveVoiceState } from './live-voice-reducer.ts';
import { useVoiceCapabilities } from './useVoiceCapabilities.ts';

/**
 * Live-only support probe, evaluated at activation. `mediaDevices` lives on `navigator`,
 * not on `globalThis`, so the default scope reads both from their real homes.
 */
export function supportsLiveVoice(
  scope: { isSecureContext?: boolean; mediaDevices?: { getUserMedia?: unknown } } =
    { isSecureContext: globalThis.isSecureContext, mediaDevices: globalThis.navigator?.mediaDevices },
  rtc: unknown = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection,
): boolean {
  return scope.isSecureContext === true && typeof scope.mediaDevices?.getUserMedia === 'function' && typeof rtc === 'function';
}

export function snapshotLiveDraft(element: HTMLTextAreaElement | null, fallback: string): LiveDraft {
  const text = element?.value ?? fallback;
  return { text, start: element?.selectionStart ?? text.length, end: element?.selectionEnd ?? text.length,
    direction: element?.selectionDirection ?? 'none' };
}

export function useLiveVoice(options: {
  conversationId: string | null;
  draft: string;
  temporaryChat?: boolean;
  allowTemporaryLive?: boolean;
  bindings: LiveVoiceBindings;
}) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; }, [options]);
  const [http] = useState(() => new VoiceHttpClient());
  const config = useVoiceCapabilities();
  // Prefetch the transport chunk once live voice is available, so the gesture-bound prepare() stays synchronous.
  const liveEnabled = Boolean(config?.enabledModes.live);
  useEffect(() => { if (liveEnabled) void preloadLiveKitClient().catch(() => {}); }, [liveEnabled]);
  const [controller] = useState(() => new LiveVoiceController({ http,
    client: callbacks => createLazyLiveKitClient(callbacks),
    support: () => supportsLiveVoice(),
    bindings: {
      claimVoiceInput: (mode, onClose) => latest.current.bindings.claimVoiceInput(mode, onClose),
      writeVoiceDraft: (token, text) => latest.current.bindings.writeVoiceDraft(token, text),
      releaseVoiceInput: token => latest.current.bindings.releaseVoiceInput(token),
      bindVoiceConversation: (token, id, meta) =>
        meta
          ? latest.current.bindings.bindVoiceConversation(token, id, meta)
          : latest.current.bindings.bindVoiceConversation(token, id),
      refreshSessions: (
        id?: string,
        voiceSession?: { voiceSessionId: string; durationSeconds: number; startedAt: string },
      ) => latest.current.bindings.refreshSessions(id, voiceSession),
      getActiveConversationId: () => latest.current.bindings.getActiveConversationId?.() ?? null,
      openCanvasArtifact: (artifactId) =>
        latest.current.bindings.openCanvasArtifact?.(artifactId),
    } }));
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => attachLiveVoiceLifecycle(controller, document, window, navigator.mediaDevices), [controller]);
  const start = () => {
    const current = latest.current;
    if (
      !config?.enabledModes.live ||
      document.hidden ||
      !canStartLiveVoiceForChat(
        { activeSessionTemporary: Boolean(current.temporaryChat) },
        current.allowTemporaryLive ?? TEMPORARY_LIVE_VOICE_ENABLED,
      )
    ) {
      return;
    }
    const draft = snapshotLiveDraft(document.querySelector<HTMLTextAreaElement>('.aurvin-textarea'), current.draft);
    void controller.start(draft, current.conversationId, config);
  };
  return { view, start, toggleMute: () => { void controller.toggleMute(); },
    interrupt: () => controller.interrupt(), exit: () => controller.exit(),
    resume: () => { if (!document.hidden) void controller.resume(); },
    confirmCalendar: (proposalId: string, revision: number, answer: CalendarConfirmPayload['answer']) =>
      controller.confirmCalendar(proposalId, revision, answer),
    updateCanvasInventory: controller.updateCanvasInventory,
    getVolume: controller.getVolume };
}

export type LiveVoiceSurface = {
  view: LiveVoiceState;
  start: () => void;
  toggleMute: () => void;
  interrupt: () => void;
  exit: () => void;
  resume: () => void;
  confirmCalendar?: (proposalId: string, revision: number, answer: CalendarConfirmPayload['answer']) => boolean;
  /** Publishes the current merged Canvas surface as bounded navigation metadata. */
  updateCanvasInventory?: (
    conversationId: string | null,
    artifacts: readonly CanvasArtifact[],
    presentation?: CanvasPresentationBinding | null,
  ) => void;
  getVolume?: () => number;
};
