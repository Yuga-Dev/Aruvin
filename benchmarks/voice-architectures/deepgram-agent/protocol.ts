/**
 * ============================================================================
 * FILE: protocol.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Construct and parse the actual Deepgram Voice Agent v1 wire protocol.
 *
 * ROLE IN PROJECT:
 *    Pure protocol and paced PCM helpers used by the P3 socket adapter.
 *    Settings express offline intent, never verified BYO policy compliance.
 *
 * KEY COMPONENTS:
 *    - buildSettings/parseAgentEvent: Narrow protocol allowlists.
 *    - pacePcm: Thin marker/frame bridge over P1's shared monotonic pacer.
 * ============================================================================
 */
import { pacePcm as sharedPacePcm } from '../shared/timing.js';

export function agentEndpoint(region: string): string {
  if (region === 'us') return 'wss://agent.deepgram.com/v1/agent/converse';
  if (region === 'eu') return 'wss://api.eu.deepgram.com/v1/agent/converse';
  throw new Error('UNSUPPORTED_REGION');
}

export type SettingsInput = {
  modelId: string;
  ttsModel: string;
  openRouterApiKey: string;
  prompt: string;
  contextCharacters: number;
  eotThreshold: number;
  eotTimeoutMs: number;
};

export function buildSettings(c: SettingsInput) {
  if (!c.modelId.trim() || c.modelId.length > 256 ||
      !/^flux-[a-z0-9-]+-en$/.test(c.ttsModel) ||
      !c.openRouterApiKey || /[\r\n]/.test(c.openRouterApiKey) ||
      !c.prompt.trim() || Buffer.byteLength(c.prompt) > 262144 ||
      !Number.isInteger(c.contextCharacters) || c.contextCharacters < 2 ||
      c.contextCharacters > 262144 ||
      !Number.isFinite(c.eotThreshold) || c.eotThreshold < 0.5 ||
      c.eotThreshold > 1 || !Number.isInteger(c.eotTimeoutMs) ||
      c.eotTimeoutMs < 1000 || c.eotTimeoutMs > 10000) {
    throw new Error('INVALID_SETTINGS');
  }
  return {
    type: 'Settings',
    mip_opt_out: true,
    audio: {
      input: { encoding: 'linear16', sample_rate: 16000 },
      output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
    },
    agent: {
      language: 'en',
      listen: { provider: {
        type: 'deepgram', version: 'v2', model: 'flux-general-en',
        eot_threshold: c.eotThreshold, eot_timeout_ms: c.eotTimeoutMs,
      } },
      think: {
        provider: { type: 'open_ai', version: 'v1', model: c.modelId },
        endpoint: {
          url: 'https://openrouter.ai/api/v1/chat/completions',
          headers: { Authorization: `Bearer ${c.openRouterApiKey}` },
        },
        prompt: c.prompt,
        context_length: c.contextCharacters,
      },
      speak: { provider: {
        type: 'deepgram', version: 'v2', model: c.ttsModel,
      } },
    },
  };
}

export function injectUserMessage(content: string) {
  if (!content.trim() || Buffer.byteLength(content) > 4096) {
    throw new Error('INVALID_TEXT');
  }
  return { type: 'InjectUserMessage', content };
}

export type AgentEvent =
  | { type: 'Welcome'; requestId: string }
  | { type: 'SettingsApplied' | 'UserStartedSpeaking' | 'AgentThinking'
      | 'AgentStartedSpeaking' | 'AgentAudioDone' }
  | { type: 'ConversationText'; role: 'user' | 'assistant'; content: string }
  | { type: 'Error' | 'Warning'; code: string };

export function parseAgentEvent(text: string): AgentEvent | null {
  const invalid = () => new Error('AGENT_PROTOCOL_INVALID');
  if (Buffer.byteLength(text) > 65536) throw invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string') throw invalid();
  switch (v.type) {
    case 'Welcome':
      if (typeof v.request_id !== 'string' || !v.request_id ||
          v.request_id.length > 256) throw invalid();
      return { type: 'Welcome', requestId: v.request_id };
    case 'SettingsApplied':
    case 'UserStartedSpeaking':
    case 'AgentThinking':
    case 'AgentStartedSpeaking':
    case 'AgentAudioDone':
      // AgentThinking.content is deliberately discarded: never store reasoning.
      return { type: v.type };
    case 'ConversationText':
      if ((v.role !== 'user' && v.role !== 'assistant') ||
          typeof v.content !== 'string' ||
          Buffer.byteLength(v.content) > 16384) throw invalid();
      return { type: 'ConversationText', role: v.role, content: v.content };
    case 'Error':
    case 'Warning':
      return {
        type: v.type,
        code: typeof v.code === 'string' && /^[A-Z0-9_-]{1,64}$/.test(v.code)
          ? v.code : 'UNCLASSIFIED_PROVIDER_ERROR',
      };
    default:
      return null;
  }
}

export type PacingPorts = {
  now(): number;
  wait(ms: number): Promise<void>;
  send(frame: Buffer): void;
  signal: AbortSignal;
};

export async function pacePcm(
  pcm: Buffer, speechEndMs: number, p: PacingPorts,
): Promise<{ speechEndAt: number; maxLatenessMs: number }> {
  if (!pcm.length || pcm.length % 2560 !== 0 || pcm.length > 1920000 ||
      !Number.isFinite(speechEndMs) || speechEndMs < 0 ||
      speechEndMs > pcm.length / 32) throw new Error('INVALID_PCM');
  p.signal.throwIfAborted();
  let offset = 0;
  let speechEndAt: number | null = null;
  const markerByte = speechEndMs * 32;
  // Shared pacer abort-checks after wait(0), which would drop the already-due first
  // frame. Honor abort after that send so a queued later frame is the one cancelled.
  const maxLatenessMs = await sharedPacePcm(
    pcm, { now: p.now }, p.wait, async (frame) => {
      const at = p.now();
      if (markerByte >= offset && markerByte <= offset + frame.length &&
          speechEndAt === null) speechEndAt = at + (markerByte - offset) / 32;
      p.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
      offset += frame.length;
      p.signal.throwIfAborted();
    }, new AbortController().signal,
  );
  if (speechEndAt === null) throw new Error('INVALID_SPEECH_END_MARKER');
  return { speechEndAt, maxLatenessMs };
}
