/**
 * ============================================================================
 * FILE: weather-wire.spec.ts
 * LOCATION: backend/src/contracts/weather-wire.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify strict Zod and wire guards for WeatherView persistence, SSE, and voice.
 *
 * ROLE IN PROJECT:
 *    Ensures assistant-only weatherView persistence, Canvas archive detection,
 *    SSE weather-view/completed framing, canvas.inventory weather ownership,
 *    and bounded live-only weather.frame validation.
 *
 * KEY COMPONENTS:
 *    - sampleWeatherView: Valid bounded WeatherView fixture.
 *    - Contract assertions for message, API, stream, canvas-navigation, voice-wire.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { hasCanvasContent, toVisibleMessage, visibleMessageSchema } from './api.js';
import { isCanvasInventoryPayload } from './canvas-navigation.js';
import { messageRecordSchema } from './message.js';
import { encodeSseFrame, parseSseDataLine, streamEnvelopeSchema } from './stream.js';
import { parseVoiceControl } from './voice-wire.js';
import type { WeatherView } from './weather-view.js';

const sampleWeatherView = (): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:00:00.000Z',
  units: 'metric',
  location: {
    city: 'Chennai',
    region: 'Tamil Nadu',
    country: 'India',
    source: 'personalization',
  },
  current: {
    temperature: 30.4,
    apparentTemperature: 34.1,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14.5,
    isDay: true,
  },
  hourly: [
    { time: '2026-11-19T12:00', temperature: 31.2, weatherCode: 2, precipitationProbability: 15 },
    { time: '2026-11-19T13:00', temperature: 31.8, weatherCode: 3, precipitationProbability: 25 },
  ],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32.4,
      tempMin: 25.6,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
  ],
  attribution: {
    label: 'Open-Meteo',
    url: 'https://open-meteo.com/',
  },
});

const baseAssistantMessage = () => ({
  schemaVersion: 1 as const,
  userId: 'user-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  messageId: 'msg-asst-1',
  eventId: 'evt-1',
  sequence: 1,
  role: 'assistant' as const,
  content: 'It is 30°C and partly cloudy in Chennai.',
  createdAt: '2026-11-19T06:00:01.000Z',
  completionStatus: 'completed' as const,
  attemptId: 'attempt-1',
  truncated: false,
  weatherView: sampleWeatherView(),
});

describe('weather wire and persistence contracts', () => {
  it('allows weatherView on assistant MessageRecord and projects it to VisibleMessage', () => {
    const parsed = messageRecordSchema.parse(baseAssistantMessage());
    expect(parsed.weatherView?.location.city).toBe('Chennai');
    expect(hasCanvasContent(parsed)).toBe(true);

    const visible = toVisibleMessage(parsed);
    expect(visible.weatherView).toEqual(sampleWeatherView());
    expect(visibleMessageSchema.parse(visible).weatherView?.kind).toBe('weather');
  });

  it('rejects weatherView on user messages in both MessageRecord and VisibleMessage', () => {
    expect(() =>
      messageRecordSchema.parse({
        ...baseAssistantMessage(),
        role: 'user',
        attemptId: null,
      }),
    ).toThrow(/weather views require assistant role/i);

    expect(() =>
      visibleMessageSchema.parse({
        messageId: 'msg-u1',
        turnId: 'turn-1',
        eventId: 'evt-u1',
        sequence: 0,
        role: 'user',
        content: 'Weather?',
        createdAt: '2026-11-19T06:00:00.000Z',
        completionStatus: 'accepted',
        truncated: false,
        weatherView: sampleWeatherView(),
      }),
    ).toThrow(/weather views require assistant role/i);
  });

  it('round-trips weather-view and completed.weatherView SSE envelopes', () => {
    const viewEnvelope = streamEnvelopeSchema.parse({
      protocolVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      sequence: 1,
      event: { type: 'weather-view', view: sampleWeatherView() },
    });
    expect(parseSseDataLine(encodeSseFrame(viewEnvelope))).toEqual(viewEnvelope);

    const completedEnvelope = streamEnvelopeSchema.parse({
      protocolVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      sequence: 2,
      event: {
        type: 'completed',
        assistantMessageId: 'msg-asst-1',
        outcome: 'completed',
        weatherView: sampleWeatherView(),
      },
    });
    expect(parseSseDataLine(encodeSseFrame(completedEnvelope))).toEqual(completedEnvelope);
  });

  it('accepts weather owner kind in canvas.inventory payloads', () => {
    expect(
      isCanvasInventoryPayload({
        type: 'canvas.inventory',
        conversationId: 'session-1',
        inventory: {
          items: [
            {
              canvasId: 'weather:turn-1::canvas::weather',
              title: 'Weather · Chennai',
              owner: { kind: 'weather', id: 'turn-1' },
            },
          ],
          omitted: 0,
        },
        selection: {
          canvasId: 'weather:turn-1::canvas::weather',
          revision: 1,
          open: true,
          fullscreen: false,
          mode: 'scroll',
        },
      }),
    ).toBe(true);
  });

  it('accepts live weather.frame and rejects it in dictation mode or with invalid view', () => {
    const valid = {
      protocolVersion: 1,
      sessionId: 'voice-1',
      connectionEpoch: 1,
      eventId: 'ev-1',
      sequence: 4,
      type: 'weather.frame',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      responseId: 'resp-1',
      view: sampleWeatherView(),
    };
    const parsed = parseVoiceControl(JSON.stringify(valid), 'server', 'live');
    expect(parsed.type).toBe('weather.frame');

    expect(() => parseVoiceControl(JSON.stringify(valid), 'server', 'dictation')).toThrow(
      'INVALID_VOICE_CONTROL',
    );
    expect(() =>
      parseVoiceControl(
        JSON.stringify({ ...valid, view: { ...sampleWeatherView(), attribution: { label: 'Evil', url: 'javascript:alert(1)' } } }),
        'server',
        'live',
      ),
    ).toThrow('INVALID_VOICE_CONTROL');
  });
});
