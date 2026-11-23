/**
 * ============================================================================
 * FILE: weather-view.spec.ts
 * LOCATION: backend/test/contracts/weather-view.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify strict bounds, schema fields, and byte caps for WeatherView.
 *
 * ROLE IN PROJECT:
 *    Locks the shared Milestone 2 -> Milestone 3 WeatherView contract so tool
 *    execution and Canvas/SSE/Voice renderers validate identical shapes.
 *
 * KEY COMPONENTS:
 *    - weatherViewSchema: Accepts valid payloads and rejects extra/oversized data.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  WEATHER_ATTRIBUTION,
  WEATHER_VIEW_MAX_BYTES,
  weatherViewSchema,
  type WeatherView,
} from '../../src/contracts/weather-view.js';

function validView(overrides: Partial<WeatherView> = {}): WeatherView {
  return {
    schemaVersion: 1,
    kind: 'weather',
    capturedAt: '2026-11-19T06:45:00.000Z',
    units: 'metric',
    location: {
      city: 'Chennai',
      region: 'Tamil Nadu',
      country: 'India',
      source: 'personalization',
    },
    current: {
      temperature: 30.2,
      apparentTemperature: 34.1,
      weatherCode: 2,
      condition: 'Partly cloudy',
      humidityPercent: 72,
      windSpeed: 14.5,
      isDay: true,
    },
    hourly: [
      {
        time: '2026-11-19T12:00',
        temperature: 30.5,
        weatherCode: 2,
        precipitationProbability: 20,
      },
    ],
    daily: [
      {
        date: '2026-11-19',
        tempMax: 32.0,
        tempMin: 25.1,
        weatherCode: 2,
        condition: 'Partly cloudy',
        precipitationProbabilityMax: 30,
      },
    ],
    attribution: WEATHER_ATTRIBUTION,
    ...overrides,
  };
}

describe('weatherViewSchema', () => {
  it('accepts a valid bounded WeatherView across all location sources and units', () => {
    for (const source of ['explicit', 'personalization', 'edge-geo'] as const) {
      for (const units of ['metric', 'imperial'] as const) {
        const view = validView({
          units,
          location: { city: 'Tokyo', source },
        });
        expect(weatherViewSchema.parse(view)).toEqual(view);
      }
    }
  });

  it('rejects extra fields, invalid attribution, bad codes, and oversized payloads', () => {
    expect(weatherViewSchema.safeParse({ ...validView(), extra: true }).success).toBe(false);
    expect(
      weatherViewSchema.safeParse({
        ...validView(),
        attribution: { label: 'Other', url: 'https://evil.invalid/' },
      }).success,
    ).toBe(false);
    expect(
      weatherViewSchema.safeParse({
        ...validView(),
        current: { ...validView().current, weatherCode: 105 },
      }).success,
    ).toBe(false);
    expect(
      weatherViewSchema.safeParse({
        ...validView(),
        location: { city: 'Bad\nCity', source: 'explicit' },
      }).success,
    ).toBe(false);
    expect(
      weatherViewSchema.safeParse({
        ...validView(),
        hourly: Array.from({ length: 25 }, (_, i) => ({
          time: `2026-11-19T${String(i % 24).padStart(2, '0')}:00`,
          temperature: 25,
          weatherCode: 0,
        })),
      }).success,
    ).toBe(false);
    expect(
      weatherViewSchema.safeParse({
        ...validView(),
        daily: Array.from({ length: 8 }, (_, i) => ({
          date: `2026-11-${String(19 + i).padStart(2, '0')}`,
          tempMax: 30,
          tempMin: 20,
          weatherCode: 0,
          condition: 'Clear sky',
        })),
      }).success,
    ).toBe(false);
    expect(WEATHER_VIEW_MAX_BYTES).toBe(12_288);
  });
});
