/**
 * ============================================================================
 * FILE: environment-tool.spec.ts
 * LOCATION: backend/test/environment/environment-tool.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify get_environment execution: datetime, 4-tier location precedence,
 *    partial-success weather fallback, and WeatherView construction.
 *
 * ROLE IN PROJECT:
 *    Tests pure in-process datetime formatting (<1ms, zero I/O), location
 *    priority (explicit > personalization > edge-geo > unknown), and strict
 *    freshness tagging (`validForCurrentTurnOnly`).
 *
 * KEY COMPONENTS:
 *    - buildEnvironmentDatetime: Local date/time/UTC offset across zones.
 *    - resolveEnvironmentLocation: Exact 4-tier precedence and country-only guard.
 *    - executeEnvironmentTool: Combined execution, partial success, WeatherView.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildEnvironmentDatetime,
  executeEnvironmentTool,
  extractSavedLocation,
  resolveEnvironmentLocation,
} from '../../src/environment/environment-tool.js';
import type { WeatherProvider } from '../../src/environment/weather-service.js';
import { WEATHER_ATTRIBUTION } from '../../src/contracts/weather-view.js';

const NOW = new Date('2026-11-19T06:45:00.000Z');

describe('buildEnvironmentDatetime', () => {
  it('formats accurate local date, 24h/12h times, day of week, and UTC offset', () => {
    expect(buildEnvironmentDatetime(NOW, 'Asia/Kolkata')).toEqual({
      iso: '2026-11-19T06:45:00.000Z',
      localDate: '2026-11-19',
      dayOfWeek: 'Thursday',
      localTime24: '12:15',
      localTime12: '12:15 PM',
      timeZone: 'Asia/Kolkata',
      utcOffset: '+05:30',
    });

    expect(buildEnvironmentDatetime(NOW, 'America/New_York')).toEqual({
      iso: '2026-11-19T06:45:00.000Z',
      localDate: '2026-11-19',
      dayOfWeek: 'Thursday',
      localTime24: '01:45',
      localTime12: '1:45 AM',
      timeZone: 'America/New_York',
      utcOffset: '-05:00',
    });

    expect(buildEnvironmentDatetime(NOW, 'Not/A_Zone').timeZone).toBe('Etc/UTC');
    expect(buildEnvironmentDatetime(NOW, 'Etc/UTC').utcOffset).toBe('+00:00');
  });
});

describe('resolveEnvironmentLocation', () => {
  const saved = { city: 'Chennai', region: 'Tamil Nadu', country: 'India', latitude: 13.08, longitude: 80.27 };
  const geo = { city: 'Bengaluru', region: 'KA', country: 'IN', source: 'cloudflare' as const };

  it('enforces explicit > personalization > edge-geo > LOCATION_UNKNOWN', () => {
    expect(resolveEnvironmentLocation({ explicit: 'Tokyo', saved, requestGeo: geo })).toMatchObject({
      available: true,
      city: 'Tokyo',
      source: 'explicit',
      query: 'Tokyo',
    });
    expect(resolveEnvironmentLocation({ saved, requestGeo: geo })).toMatchObject({
      available: true,
      city: 'Chennai',
      region: 'Tamil Nadu',
      country: 'India',
      source: 'personalization',
      coordinates: { latitude: 13.08, longitude: 80.27, city: 'Chennai', region: 'Tamil Nadu', country: 'India' },
    });
    expect(resolveEnvironmentLocation({ saved: null, requestGeo: geo })).toMatchObject({
      available: true,
      city: 'Bengaluru',
      region: 'KA',
      country: 'IN',
      source: 'edge-geo',
    });
    // Country-only edge geo never fabricates a city.
    expect(
      resolveEnvironmentLocation({ saved: null, requestGeo: { country: 'IN', source: 'cloudflare' } }),
    ).toEqual({ available: false, reason: 'LOCATION_UNKNOWN' });
    expect(resolveEnvironmentLocation({ saved: null, requestGeo: null })).toEqual({
      available: false,
      reason: 'LOCATION_UNKNOWN',
    });
  });

  it('extracts optional Milestone 1 location safely from cached personalization settings', () => {
    expect(extractSavedLocation({ warmth: 'medium', enthusiasm: 'medium', emoji: 'medium', customInstructions: '' })).toBeNull();
    expect(
      extractSavedLocation({
        warmth: 'medium',
        enthusiasm: 'medium',
        emoji: 'medium',
        customInstructions: '',
        location: saved,
      }),
    ).toEqual(saved);
  });
});

describe('executeEnvironmentTool', () => {
  it('answers datetime-only purely in-process without calling WeatherProvider', async () => {
    const lookup = vi.fn<WeatherProvider['lookup']>();
    const out = await executeEnvironmentTool({
      envelope: { include: ['datetime'] },
      now: NOW,
      timeZone: 'Asia/Kolkata',
      savedLocation: null,
      requestGeo: null,
      weatherProvider: { lookup },
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(out.weatherView).toBeNull();
    expect(out.result).toEqual({
      kind: 'environment-result',
      capturedAt: '2026-11-19T06:45:00.000Z',
      validForCurrentTurnOnly: ['datetime'],
      datetime: {
        iso: '2026-11-19T06:45:00.000Z',
        localDate: '2026-11-19',
        dayOfWeek: 'Thursday',
        localTime24: '12:15',
        localTime12: '12:15 PM',
        timeZone: 'Asia/Kolkata',
        utcOffset: '+05:30',
      },
    });
  });

  it('returns WeatherView on weather success and guarantees partial success when weather fails or location is unknown', async () => {
    const okProvider: WeatherProvider = {
      lookup: vi.fn(async () => ({
        ok: true as const,
        resolvedLocation: { city: 'Chennai', region: 'Tamil Nadu', country: 'India' },
        units: 'metric' as const,
        current: { temperature: 31, apparentTemperature: 35, weatherCode: 1, condition: 'Mainly clear' },
        hourly: [{ time: '2026-11-19T13:00', temperature: 31.5, weatherCode: 1 }],
        daily: [{ date: '2026-11-19', tempMax: 33, tempMin: 25, weatherCode: 1, condition: 'Mainly clear' }],
        attribution: WEATHER_ATTRIBUTION,
      })),
    };

    const okOut = await executeEnvironmentTool({
      envelope: { include: ['datetime', 'location', 'weather'] },
      now: NOW,
      timeZone: 'Asia/Kolkata',
      savedLocation: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', latitude: 13.08, longitude: 80.27 },
      requestGeo: null,
      weatherProvider: okProvider,
    });
    expect(okOut.result.validForCurrentTurnOnly).toEqual(['datetime', 'weather']);
    expect(okOut.result.datetime?.localTime24).toBe('12:15');
    expect(okOut.result.location).toEqual({
      available: true,
      city: 'Chennai',
      region: 'Tamil Nadu',
      country: 'India',
      source: 'personalization',
    });
    expect(okOut.weatherView).toMatchObject({
      schemaVersion: 1,
      kind: 'weather',
      units: 'metric',
      location: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', source: 'personalization' },
    });

    // Weather failure still returns valid datetime and location (partial success).
    const failProvider: WeatherProvider = {
      lookup: vi.fn(async () => ({ ok: false as const, code: 'WEATHER_UNAVAILABLE' as const })),
    };
    const partialFail = await executeEnvironmentTool({
      envelope: { include: ['datetime', 'location', 'weather'] },
      now: NOW,
      timeZone: 'Asia/Kolkata',
      savedLocation: { city: 'Chennai' },
      requestGeo: null,
      weatherProvider: failProvider,
    });
    expect(partialFail.weatherView).toBeNull();
    expect(partialFail.result.datetime?.localTime24).toBe('12:15');
    expect(partialFail.result.location).toEqual({ available: true, city: 'Chennai', source: 'personalization' });
    expect(partialFail.result.weather).toEqual({ ok: false, code: 'WEATHER_UNAVAILABLE' });

    // Unknown location skips network and still returns datetime.
    const unused = vi.fn<WeatherProvider['lookup']>();
    const unknownLoc = await executeEnvironmentTool({
      envelope: { include: ['datetime', 'weather'] },
      now: NOW,
      timeZone: 'Etc/UTC',
      savedLocation: null,
      requestGeo: null,
      weatherProvider: { lookup: unused },
    });
    expect(unused).not.toHaveBeenCalled();
    expect(unknownLoc.weatherView).toBeNull();
    expect(unknownLoc.result.datetime?.timeZone).toBe('Etc/UTC');
    expect(unknownLoc.result.weather).toEqual({ ok: false, code: 'LOCATION_UNKNOWN' });
  });
});
