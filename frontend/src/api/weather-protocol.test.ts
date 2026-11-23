/**
 * ============================================================================
 * FILE: weather-protocol.test.ts
 * LOCATION: frontend/src/api/weather-protocol.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify strict frontend validation for WeatherView, SSE frames, messages,
 *    canvas.inventory weather ownership, and live weather.frame payloads.
 *
 * ROLE IN PROJECT:
 *    Mirrors backend weather contract checks on untrusted browser wire data
 *    without importing server code or trusting arbitrary URLs/roles.
 *
 * KEY COMPONENTS:
 *    - isWeatherView / isWeatherViewEvent guard tests.
 *    - parseSseDataLine / parseCalendarCompatibleFrame weather event tests.
 *    - isVisibleMessage assistant-role weatherView guard tests.
 *    - parseVoiceControl live/dictation weather.frame and canvas.inventory tests.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { parseCalendarCompatibleFrame } from './calendar-protocol.ts';
import { isVisibleMessage, parseSseDataLine } from './protocol.ts';
import { isCanvasInventoryPayload, parseVoiceControl } from './voice-protocol.ts';
import { isWeatherView, type WeatherView } from './weather-protocol.ts';

const sampleWeatherView = (): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:00:00.000Z',
  units: 'metric',
  location: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', source: 'personalization' },
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
  attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
});

describe('frontend weather protocol guards', () => {
  it('validates well-formed WeatherView and rejects unsafe attribution URLs or control characters', () => {
    expect(isWeatherView(sampleWeatherView())).toBe(true);
    expect(
      isWeatherView({
        ...sampleWeatherView(),
        attribution: { label: 'Open-Meteo', url: 'javascript:alert(1)' },
      }),
    ).toBe(false);
    expect(
      isWeatherView({
        ...sampleWeatherView(),
        location: { ...sampleWeatherView().location, city: 'Chennai\nInjected' },
      }),
    ).toBe(false);
  });

  it('parses weather-view and completed.weatherView across v1 and compatible SSE frames', () => {
    const viewFrame = {
      protocolVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      sequence: 1,
      event: { type: 'weather-view', view: sampleWeatherView() },
    };
    expect(parseSseDataLine(`data: ${JSON.stringify(viewFrame)}`)).toEqual(viewFrame);
    expect(parseCalendarCompatibleFrame(`data: ${JSON.stringify(viewFrame)}`)).toEqual(viewFrame);

    const completedFrame = {
      protocolVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      sequence: 2,
      event: {
        type: 'completed',
        assistantMessageId: 'msg-1',
        outcome: 'completed',
        weatherView: sampleWeatherView(),
      },
    };
    expect(parseSseDataLine(`data: ${JSON.stringify(completedFrame)}`)).toEqual(completedFrame);
  });

  it('enforces assistant-only weatherView in isVisibleMessage', () => {
    const base = {
      messageId: 'msg-1',
      turnId: 'turn-1',
      eventId: 'evt-1',
      sequence: 1,
      role: 'assistant',
      content: 'It is 30°C in Chennai.',
      createdAt: '2026-11-19T06:00:01.000Z',
      completionStatus: 'completed',
      truncated: false,
      weatherView: sampleWeatherView(),
    };
    expect(isVisibleMessage(base)).toBe(true);
    expect(isVisibleMessage({ ...base, role: 'user' })).toBe(false);
  });

  it('validates weather.frame in live voice mode and weather owner in canvas.inventory', () => {
    const frame = {
      protocolVersion: 1,
      sessionId: 'voice-1',
      connectionEpoch: 1,
      eventId: 'ev-1',
      sequence: 5,
      type: 'weather.frame',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      responseId: 'resp-1',
      view: sampleWeatherView(),
    };
    expect(parseVoiceControl(JSON.stringify(frame), 'server', 'live').type).toBe('weather.frame');
    expect(() => parseVoiceControl(JSON.stringify(frame), 'server', 'dictation')).toThrow(
      'INVALID_VOICE_CONTROL',
    );
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
      }),
    ).toBe(true);
  });
});
