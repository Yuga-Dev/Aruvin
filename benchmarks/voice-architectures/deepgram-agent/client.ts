/**
 * ============================================================================
 * FILE: client.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Speak the genuine Voice Agent v1 protocol over a ws-compatible socket.
 *
 * ROLE IN PROJECT:
 *    Offline attachable transport and preflight-guarded real socket opening.
 *    No direct STT/TTS loop or managed-LLM substitution is implemented.
 *
 * KEY COMPONENTS:
 *    - attachVoiceAgentV1: Handshake, event dispatch, input and finite shutdown.
 *    - openVoiceAgentV1: Real ws constructor behind immutable BYO preflight.
 * ============================================================================
 */
import WebSocket, { type RawData } from 'ws';
import { preflightDeepgramAgent } from './harness.js';
import {
  agentEndpoint, injectUserMessage, parseAgentEvent, buildSettings,
  type AgentEvent,
} from './protocol.js';

type Settings = ReturnType<typeof buildSettings>;
type Hooks = {
  onEvent?(event: AgentEvent, at: number): void;
  onPcm?(frame: Buffer, at: number): void;
  onFailure?(code: string): void;
};
type SocketFactory = (
  url: string, options: WebSocket.ClientOptions,
) => WebSocket;

export function attachVoiceAgentV1(
  socket: WebSocket,
  settings: Settings,
  hooks: Hooks = {},
  signal?: AbortSignal,
  now: () => number = () => performance.now(),
) {
  let state: 'welcome' | 'settings' | 'ready' | 'closed' = 'welcome';
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve; rejectReady = reject;
  });
  let closePromise: Promise<void> | null = null;
  let resolveClose: (() => void) | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const setupTimer = setTimeout(() => fail('AGENT_SETUP_TIMEOUT'), 10000);
  const lifetimeTimer = setTimeout(() => fail('AGENT_SESSION_TIMEOUT'), 300000);
  const abort = () => fail('AGENT_CANCELLED');

  function detach(): void {
    clearTimeout(setupTimer);
    clearTimeout(lifetimeTimer);
    if (closeTimer !== null) clearTimeout(closeTimer);
    signal?.removeEventListener('abort', abort);
    socket.off('message', message);
    // Keep close/error listeners until transport termination is observed.
  }

  function closed(): void {
    if (state !== 'closed') fail('AGENT_EARLY_CLOSE');
    detach();
    socket.off('close', closed);
    socket.off('error', socketError);
    resolveClose?.();
  }

  function fail(code: string): void {
    if (state === 'closed') return;
    state = 'closed';
    if (!settled) { settled = true; rejectReady(new Error(code)); }
    detach();
    socket.terminate();
    hooks.onFailure?.(code);
  }

  function socketError(): void { fail('AGENT_SOCKET_ERROR'); }

  function send(value: string | Buffer, binary: boolean): void {
    if (socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > 262144) {
      fail('AGENT_BACKPRESSURE_OR_CLOSED');
      throw new Error('AGENT_BACKPRESSURE_OR_CLOSED');
    }
    socket.send(value, { binary }, (error) => {
      if (error) fail('AGENT_SEND_FAILED');
    });
  }

  function message(data: RawData, isBinary: boolean): void {
    if (state === 'closed') return;
    try {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data)
        ? Buffer.concat(data) : Buffer.from(data);
      if (bytes.length > 1048576) throw new Error('AGENT_FRAME_TOO_LARGE');
      if (isBinary) {
        if (state !== 'ready' || !bytes.length || bytes.length % 2) {
          throw new Error('AGENT_AUDIO_OUT_OF_ORDER');
        }
        hooks.onPcm?.(bytes, now());
        return;
      }
      const event = parseAgentEvent(bytes.toString('utf8'));
      if (!event) return;
      if (event.type === 'Error') {
        hooks.onEvent?.(event, now());
        fail('AGENT_PROVIDER_ERROR');
        return;
      }
      if (event.type === 'Welcome') {
        if (state !== 'welcome') throw new Error('AGENT_DUPLICATE_WELCOME');
        state = 'settings';
        send(JSON.stringify(settings), false);
      } else if (event.type === 'SettingsApplied') {
        if (state !== 'settings') throw new Error('AGENT_SETTINGS_OUT_OF_ORDER');
        state = 'ready';
        settled = true;
        clearTimeout(setupTimer);
        resolveReady();
      } else if (state !== 'ready') {
        throw new Error('AGENT_EVENT_OUT_OF_ORDER');
      }
      hooks.onEvent?.(event, now());
    } catch {
      fail('AGENT_PROTOCOL_FAILURE');
    }
  }

  socket.on('message', message);
  socket.on('close', closed);
  socket.on('error', socketError);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  return {
    ready,
    text(content: string): void {
      if (state !== 'ready') throw new Error('AGENT_NOT_READY');
      send(JSON.stringify(injectUserMessage(content)), false);
    },
    audio(frame: Buffer): void {
      if (state !== 'ready') throw new Error('AGENT_NOT_READY');
      if (!frame.length || frame.length % 2 || frame.length > 2560) {
        throw new Error('INVALID_PCM_FRAME');
      }
      send(frame, true);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      if (state === 'closed') return Promise.resolve();
      state = 'closed';
      if (!settled) { settled = true; rejectReady(new Error('AGENT_CANCELLED')); }
      detach();
      closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
      closeTimer = setTimeout(() => {
        socket.terminate(); closed();
      }, 1000);
      socket.close(1000);
      return closePromise;
    },
  };
}

export async function openVoiceAgentV1(
  config: {
    region: string; deepgramApiKey: string; settings: Settings;
    waiveByo?: boolean; hooks?: Hooks; signal?: AbortSignal; now?: () => number;
  },
  factory: SocketFactory = (url, options) => new WebSocket(url, options),
) {
  if (config.waiveByo !== true) {
    const preflight = preflightDeepgramAgent(new Date().toISOString());
    if (preflight.status !== 'ready') throw new Error(preflight.reasons[0]);
  }
  const socket = factory(agentEndpoint(config.region), {
    headers: { Authorization: `Token ${config.deepgramApiKey}` },
    followRedirects: false,
    handshakeTimeout: 10000,
    maxPayload: 1048576,
    perMessageDeflate: false,
  });
  return attachVoiceAgentV1(socket, config.settings, config.hooks, config.signal, config.now);
}
