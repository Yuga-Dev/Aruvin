/**
 * ============================================================================
 * FILE: protocol.test.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/__tests__/protocol.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Check genuine Voice Agent messages and real-time PCM framing offline.
 *
 * ROLE IN PROJECT:
 *    Pins P3 wire intent without asserting managed-provider acceptance.
 *    All keys, clocks and transports are synthetic.
 *
 * KEY COMPONENTS:
 *    - Settings fixtures: Flux v2 and direct OpenRouter endpoint.
 *    - PCM/parser checks: Frame flags, safe events, cancellation and pacing.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import {
  agentEndpoint, buildSettings, injectUserMessage, pacePcm, parseAgentEvent,
} from '../protocol.js';

const settingsInput = {
  modelId: 'vendor/requested-model',
  ttsModel: 'flux-haley-en',
  openRouterApiKey: 'fixture-openrouter-only',
  prompt: 'Synthetic benchmark instruction.',
  contextCharacters: 45000,
  eotThreshold: 0.8,
  eotTimeoutMs: 5000,
};

it('uses the genuine US and EU Voice Agent v1 endpoints only', () => {
  expect(agentEndpoint('us')).toBe('wss://agent.deepgram.com/v1/agent/converse');
  expect(agentEndpoint('eu')).toBe('wss://api.eu.deepgram.com/v1/agent/converse');
  expect(() => agentEndpoint('https://attacker.invalid')).toThrow('UNSUPPORTED_REGION');
});

it('builds Settings with Flux v2, PCM rates and the unchanged BYO model intent', () => {
  const s = buildSettings(settingsInput);
  expect(s).toEqual({
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
        eot_threshold: 0.8, eot_timeout_ms: 5000,
      } },
      think: {
        provider: { type: 'open_ai', version: 'v1', model: 'vendor/requested-model' },
        endpoint: {
          url: 'https://openrouter.ai/api/v1/chat/completions',
          headers: { Authorization: 'Bearer fixture-openrouter-only' },
        },
        prompt: 'Synthetic benchmark instruction.',
        context_length: 45000,
      },
      speak: { provider: {
        type: 'deepgram', version: 'v2', model: 'flux-haley-en',
      } },
    },
  });
  const wire = JSON.stringify(s);
  for (const absent of [
    '"greeting"', '"eager_eot_threshold"', '"think_live"', '"functions"',
    '"user"', '"max_tokens"', '"max_completion_tokens"', '"transforms"',
  ]) expect(wire).not.toContain(absent);
  expect(injectUserMessage('Hello')).toEqual({
    type: 'InjectUserMessage', content: 'Hello',
  });
  expect(() => injectUserMessage('')).toThrow('INVALID_TEXT');
  expect(() => buildSettings({ ...settingsInput, eotThreshold: NaN }))
    .toThrow('INVALID_SETTINGS');
  expect(() => buildSettings({ ...settingsInput, ttsModel: 'aura-2-thalia-en' }))
    .toThrow('INVALID_SETTINGS');
});

it('parses required events but discards thought text and provider error payloads', () => {
  for (const type of [
    'SettingsApplied', 'UserStartedSpeaking', 'AgentThinking',
    'AgentStartedSpeaking', 'AgentAudioDone',
  ]) {
    expect(parseAgentEvent(JSON.stringify({
      type, content: 'PRIVATE_THOUGHT_MUST_NOT_SURVIVE',
      total_latency: '0.3', tts_latency: '0.1', ttt_latency: '0.2',
    }))).toEqual({ type });
  }
  expect(parseAgentEvent('{"type":"Welcome","request_id":"fixture-request"}'))
    .toEqual({ type: 'Welcome', requestId: 'fixture-request' });
  expect(parseAgentEvent('{"type":"ConversationText","role":"user","content":"Hi"}'))
    .toEqual({ type: 'ConversationText', role: 'user', content: 'Hi' });
  expect(parseAgentEvent('{"type":"Error","code":"INVALID_SETTINGS","description":"secret"}'))
    .toEqual({ type: 'Error', code: 'INVALID_SETTINGS' });
  expect(parseAgentEvent('{"type":"UnrecognizedFutureEvent"}')).toBeNull();
  for (const invalid of ['{', '[]', 'null', '{"type":"Welcome"}',
    '{"type":"ConversationText","role":"system","content":"x"}']) {
    expect(() => parseAgentEvent(invalid)).toThrow('AGENT_PROTOCOL_INVALID');
  }
});

it('paces unchanged raw 16 kHz PCM as 80 ms binary frames with the shared pacer', async () => {
  let time = 100;
  const times: number[] = [];
  const frames: Buffer[] = [];
  const pcm = Buffer.alloc(2560 * 3, 1);
  const result = await pacePcm(pcm, 165, {
    now: () => time,
    wait: async (ms) => { time += ms; },
    send: (frame) => { times.push(time); frames.push(frame); },
    signal: new AbortController().signal,
  });
  expect(times).toEqual([100, 180, 260]);
  expect(frames.map((f) => f.length)).toEqual([2560, 2560, 2560]);
  expect(Buffer.concat(frames)).toEqual(pcm);
  expect(result).toEqual({ speechEndAt: 265, maxLatenessMs: 0 });
});

it('cancels before a queued frame and rejects partial or odd-byte corpus frames', async () => {
  let time = 0;
  const sent: number[] = [];
  const controller = new AbortController();
  await expect(pacePcm(Buffer.alloc(5120), 160, {
    now: () => time,
    wait: async (ms) => { time += ms; controller.abort(); },
    send: () => sent.push(time),
    signal: controller.signal,
  })).rejects.toThrow();
  expect(sent).toEqual([0]);
  await expect(pacePcm(Buffer.alloc(3), 0, {
    now: () => 0, wait: async () => {}, send: () => {},
    signal: new AbortController().signal,
  })).rejects.toThrow('INVALID_PCM');
  await expect(pacePcm(Buffer.alloc(320), 0, {
    now: () => 0, wait: async () => {}, send: () => {},
    signal: new AbortController().signal,
  })).rejects.toThrow('INVALID_PCM');
});

it('records scheduler lateness using the shared absolute-deadline pacing policy', async () => {
  let time = 0;
  const sent: number[] = [];
  let delayed = false;
  const result = await pacePcm(Buffer.alloc(2560 * 3), 200, {
    now: () => time,
    wait: async (ms) => {
      time += ms;
      if (ms > 0 && !delayed) { time += 40; delayed = true; }
    },
    send: () => sent.push(time),
    signal: new AbortController().signal,
  });
  expect(sent).toEqual([0, 120, 160]);
  expect(result.maxLatenessMs).toBe(40);
  expect(result.speechEndAt).toBe(200);
});
