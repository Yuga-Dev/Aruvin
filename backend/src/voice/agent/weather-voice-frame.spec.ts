/**
 * ============================================================================
 * FILE: weather-voice-frame.spec.ts
 * LOCATION: backend/src/voice/agent/weather-voice-frame.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify AgentVoiceAdapter forwards weather-view stream events as voice
 *    weather.frame payloads and system.md includes Weather voice guidelines.
 *
 * ROLE IN PROJECT:
 *    Confirms live voice emits weather.frame strictly for the active scoped
 *    turn/attempt, ignores mismatched frames, and instructs the model to give
 *    concise spoken summaries without duplicate fenced visuals.
 *
 * KEY COMPONENTS:
 *    - AgentVoiceAdapter weather.frame emission and scoping tests.
 *    - system.md <voice_guidelines> weather summary rule assertion.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { WeatherView } from '../../contracts/weather-view.js';
import type { LiveFlow } from '../session/live-flow.js';
import type { SessionContext, VoiceSink } from '../session/voice-session.options.js';
import { AgentVoiceAdapter, type VoiceBridgeRuntime } from './agent-voice-adapter.js';

const sampleWeatherView = (): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:00:00.000Z',
  units: 'metric',
  location: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', source: 'explicit' },
  current: {
    temperature: 30,
    apparentTemperature: 34,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14,
    isDay: true,
  },
  hourly: [{ time: '2026-11-19T12:00', temperature: 31, weatherCode: 2, precipitationProbability: 15 }],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32,
      tempMin: 25,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
  ],
  attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
});

describe('AgentVoiceAdapter weather.frame forwarding', () => {
  it('forwards valid weather-view frames as weather.frame and drops mismatched turn frames', async () => {
    const sinkEvents: unknown[] = [];
    const sink: VoiceSink = {
      event: (payload) => {
        sinkEvents.push(payload);
      },
      audio: () => undefined,
      close: () => undefined,
    };

    const flow = {
      providerSocketId: 'sock-1',
      waitForOutput: vi.fn(async () => true),
      prepareResponse: vi.fn(() => ({ providerBaseSamples: 0 })),
      modelStarted: vi.fn(),
      modelOutput: vi.fn(),
      deliverySettled: vi.fn(),
      speak: vi.fn(async () => undefined),
      finishSpeech: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as LiveFlow;

    const context = {
      identity: { userId: 'user-1', source: 'hardcoded' },
      response: {
        protocolVersion: 1,
        sessionId: 'voice-1',
        conversationId: 'session-1',
        mode: 'live',
        connectionEpoch: 1,
        websocketUrl: '/api/voice',
        expiresAt: '2026-11-19T07:00:00.000Z',
        effectiveAudioSettings: {
          input: { encoding: 'pcm16', sampleRate: 16000, channels: 1, endian: 'little', frameMs: 80 },
          output: { encoding: 'pcm16', sampleRate: 24000, channels: 1, endian: 'little' },
        },
        limits: {
          dictationMaxMs: 300000,
          liveMaxMs: 1200000,
          liveWarningMs: 1080000,
          idleWarningMs: 60000,
          idleExitAfterWarningMs: 30000,
          finalizationMs: 2000,
          reconnectMs: 10000,
          connectMs: 10000,
          inputQueueMs: 1000,
          outputQueueMs: 2000,
        },
      },
      reservation: {
        userId: 'user-1',
        conversationId: 'session-1',
        owner: { kind: 'live', voiceSessionId: 'voice-1' },
      },
    } as unknown as SessionContext;

    const view = sampleWeatherView();
    const runtime: VoiceBridgeRuntime = {
      submitLiveTurn: vi.fn(async () => ({
        sessionId: 'session-1',
        turnId: 'turn-w1',
        attemptId: 'att-w1',
        userMessageId: 'msg-u1',
        streamPath: '/sessions/session-1/turns/turn-w1/stream',
      })),
      findLiveSubmission: vi.fn(async () => null),
      getLiveTurnStatus: vi.fn(async () => ({
        sessionId: 'session-1',
        turnId: 'turn-w1',
        attemptId: 'att-w1',
        status: 'accepted',
        truncated: false,
        error: null,
      })),
      cancelLiveTurn: vi.fn(async () => undefined),
      reconcileSession: vi.fn(async () => undefined),
      getLiveDelivery: vi.fn(async () => ({
        schemaVersion: 1,
        kind: 'voice-delivery',
        userId: 'user-1',
        sessionId: 'session-1',
        voiceSessionId: 'voice-1',
        turnId: 'turn-w1',
        attemptId: 'att-w1',
        responseId: 'resp-1',
        eventId: 'ev-1',
        sequence: 1,
        speechId: null,
        providerSocketId: 'sock-1',
        status: 'spoken',
        audioDurationMs: 1000,
        audioPlayedMs: 1000,
        playedSamples: 24000,
        textGenerated: 'It is 30 degrees and partly cloudy in Chennai.',
        textSpoken: 'It is 30 degrees and partly cloudy in Chennai.',
        textRemaining: '',
        createdAt: '2026-11-19T06:00:00.000Z',
        updatedAt: '2026-11-19T06:00:01.000Z',
      })),
      executeTurn: vi.fn(async (cmd) => {
        await cmd.emit({
          protocolVersion: 1,
          sessionId: 'session-1',
          turnId: 'wrong-turn',
          attemptId: 'att-w1',
          sequence: 0,
          event: { type: 'weather-view', view },
        });
        await cmd.emit({
          protocolVersion: 1,
          sessionId: 'session-1',
          turnId: 'turn-w1',
          attemptId: 'att-w1',
          sequence: 1,
          event: { type: 'weather-view', view },
        });
      }),
    };

    const adapter = new AgentVoiceAdapter(runtime, async () => undefined);
    adapter.attach(context, flow, sink);
    await adapter.finalized(
      context,
      { providerSocketEpoch: 1, providerTurnId: 'pt-1', text: 'What is the weather in Chennai?' },
      new AbortController().signal,
    );

    const weatherFrames = sinkEvents.filter(
      (ev): ev is { type: string; turnId: string; attemptId: string; responseId: string; view: WeatherView } =>
        typeof ev === 'object' && ev !== null && (ev as { type?: string }).type === 'weather.frame',
    );
    expect(weatherFrames).toHaveLength(1);
    expect(weatherFrames[0]).toMatchObject({
      type: 'weather.frame',
      turnId: 'turn-w1',
      attemptId: 'att-w1',
      view,
    });
  });

  it('documents concise spoken Weather summaries without duplicate fenced visuals in system.md', () => {
    const systemMd = readFileSync(new URL('../../instructions/system.md', import.meta.url), 'utf8');
    const voiceSection = systemMd.slice(systemMd.indexOf('<voice_guidelines>'));
    expect(voiceSection).toContain('Weather Canvas card');
    expect(voiceSection).toContain('1–2 sentence');
    expect(voiceSection).toMatch(/do not generate fenced/i);
  });
});
