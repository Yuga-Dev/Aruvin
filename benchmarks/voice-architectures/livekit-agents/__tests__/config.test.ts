/**
 * ============================================================================
 * FILE: config.test.ts
 * LOCATION: benchmarks/voice-architectures/livekit-agents/__tests__/config.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    exact plugin identities; native Silero inference.
 *
 * ROLE IN PROJECT:
 *    Supplies P2's standalone framework candidate without changing Aurvin.
 *    Consumes only the isolated package and P1-owned run configuration.
 *
 * KEY COMPONENTS:
 *    - exact plugin identities; native Silero inference.
 * ============================================================================
 */
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { voice } from '@livekit/agents';
import { sessionOptions, startOptions, speechOptions, loadSilero } from '../config.js';

afterEach(() => vi.unstubAllGlobals());

function installedVersion(name: string) {
  return JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version as string;
}

it('keeps STT endpoint authority, VAD interruption, and all retry layers explicit', () => {
  const session = new voice.AgentSession({ ...sessionOptions(), vad: null });
  expect(session.sessionOptions.turnHandling).toMatchObject({
    turnDetection: 'stt',
    endpointing: { mode: 'fixed', minDelay: 0, maxDelay: 0 },
    interruption: {
      enabled: true, mode: 'vad', minDuration: 500,
      minWords: 0, resumeFalseInterruption: false,
    },
    preemptiveGeneration: { enabled: false, preemptiveTts: false, maxRetries: 0 },
  });
  for (const name of ['llmConnOptions', 'sttConnOptions', 'ttsConnOptions'] as const) {
    expect(session.connOptions[name].maxRetry).toBe(0);
  }
  expect(session.connOptions.maxUnrecoverableErrors).toBe(1);
  // 1.10.0 stores constructor `expressive` on `_expressive`, not sessionOptions.
  expect(sessionOptions().expressive).toBe(false);
  expect(session._expressive).toBe(false);
  expect(session.sessionOptions.aecWarmupDuration).toBeNull();
});

it('pins only the synthetic participant and selects exact regional Flux URLs', () => {
  expect(startOptions('caller-fixture')).toMatchObject({
    inputOptions: {
      participantIdentity: 'caller-fixture', textEnabled: false,
      audioSampleRate: 16000, audioNumChannels: 1,
      closeOnDisconnect: true, deleteRoomOnClose: false,
    },
    outputOptions: {
      audioSampleRate: 24000, audioNumChannels: 1, queueSizeMs: 200,
    },
    record: false,
  });
  expect(speechOptions('eu')).toEqual({
    sttUrl: 'wss://api.eu.deepgram.com/v2/listen',
    ttsUrl: 'https://api.eu.deepgram.com/v2/speak',
  });
  expect(() => speechOptions('unverified-region')).toThrow('UNSUPPORTED_SPEECH_REGION');
});

it('loads real Silero and completes real dummy PCM inference with fetch denied', async () => {
  const fetcher = vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); });
  vi.stubGlobal('fetch', fetcher);
  const vad = await loadSilero();
  expect(vad.label).toBe('silero.VAD');
  expect(fetcher).not.toHaveBeenCalled();
  await vad.close();
}, 30000);

it('observes installed Agents/plugin/RTC/server/zod/openai identities', () => {
  expect(installedVersion('@livekit/agents')).toBe('1.10.0');
  expect(installedVersion('@livekit/agents-plugin-deepgram')).toBe('1.10.0');
  expect(installedVersion('@livekit/agents-plugin-silero')).toBe('1.10.0');
  expect(installedVersion('@livekit/agents-plugin-openai')).toBe('1.10.0');
  expect(installedVersion('@livekit/rtc-node')).toBe('1.2.2');
  expect(installedVersion('livekit-server-sdk')).toBe('2.19.2');
  expect(installedVersion('zod')).toBe('3.25.76');
  expect(installedVersion('openai')).toMatch(/^6\./);
});
