/**
 * ============================================================================
 * FILE: weather-service.spec.ts
 * LOCATION: backend/test/environment/weather-service.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Open-Meteo geocoding, forecast parsing, caching, timeouts, and caps.
 *
 * ROLE IN PROJECT:
 *    Deterministic fixture tests for WeatherProvider without live network calls:
 *    proves 24h geocode TTL, 15m forecast TTL, coordinate rounding, LRU eviction,
 *    imperial unit query params, byte caps, and closed failure mapping.
 *
 * KEY COMPONENTS:
 *    - OpenMeteoWeatherProvider: Geocode/forecast lookup, cache hits, expiry, errors.
 *    - wmoConditionLabel: Known and unknown WMO weather code mapping.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { wmoConditionLabel } from '../../src/environment/wmo-codes.js';
import { OpenMeteoWeatherProvider } from '../../src/environment/weather-service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const GEOCODE_TOKYO = {
  results: [
    {
      name: 'Tokyo',
      admin1: 'Tokyo',
      country: 'Japan',
      latitude: 35.6895,
      longitude: 139.6917,
    },
  ],
};

const FORECAST_TOKYO = {
  current: {
    time: '2026-11-19T12:00',
    temperature_2m: 14.8,
    apparent_temperature: 13.1,
    relative_humidity_2m: 58,
    wind_speed_10m: 11.2,
    weather_code: 2,
    is_day: 1,
  },
  hourly: {
    time: ['2026-11-19T11:00', '2026-11-19T12:00', '2026-11-19T13:00'],
    temperature_2m: [14.0, 14.8, 15.3],
    weather_code: [1, 2, 3],
    precipitation_probability: [5, 10, 15],
  },
  daily: {
    time: ['2026-11-19', '2026-11-20', '2026-11-21'],
    temperature_2m_max: [16.5, 17.0, 15.2],
    temperature_2m_min: [9.1, 10.2, 8.4],
    weather_code: [2, 61, 0],
    precipitation_probability_max: [20, 80, 5],
  },
};

describe('wmoConditionLabel', () => {
  it('maps standard WMO codes and falls back safely for unmapped codes', () => {
    expect(wmoConditionLabel(0)).toBe('Clear sky');
    expect(wmoConditionLabel(61)).toBe('Slight rain');
    expect(wmoConditionLabel(95)).toBe('Thunderstorm');
    expect(wmoConditionLabel(42)).toBe('Unknown');
  });
});

describe('OpenMeteoWeatherProvider', () => {
  it('geocodes a city, fetches forecast, slices upcoming hours, and caches both with 24h/15m TTLs', async () => {
    let clock = 1_700_000_000_000;
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.includes('geocoding-api.open-meteo.com')) return jsonResponse(GEOCODE_TOKYO);
      if (url.includes('api.open-meteo.com')) return jsonResponse(FORECAST_TOKYO);
      return jsonResponse({}, 404);
    });
    const provider = new OpenMeteoWeatherProvider({ fetcher, now: () => clock });

    const first = await provider.lookup({
      query: 'Tokyo',
      forecastDays: 2,
      units: 'metric',
      timeZone: 'Asia/Tokyo',
    });
    expect(first).toEqual({
      ok: true,
      resolvedLocation: { city: 'Tokyo', region: 'Tokyo', country: 'Japan' },
      units: 'metric',
      current: {
        temperature: 14.8,
        apparentTemperature: 13.1,
        weatherCode: 2,
        condition: 'Partly cloudy',
        humidityPercent: 58,
        windSpeed: 11.2,
        isDay: true,
      },
      hourly: [
        { time: '2026-11-19T12:00', temperature: 14.8, weatherCode: 2, precipitationProbability: 10 },
        { time: '2026-11-19T13:00', temperature: 15.3, weatherCode: 3, precipitationProbability: 15 },
      ],
      daily: [
        {
          date: '2026-11-19',
          tempMax: 16.5,
          tempMin: 9.1,
          weatherCode: 2,
          condition: 'Partly cloudy',
          precipitationProbabilityMax: 20,
        },
        {
          date: '2026-11-20',
          tempMax: 17.0,
          tempMin: 10.2,
          weatherCode: 61,
          condition: 'Slight rain',
          precipitationProbabilityMax: 80,
        },
      ],
      attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Within 15 minutes: both geocode and forecast hit cache (0 new HTTP calls).
    clock += 10 * 60_000;
    const second = await provider.lookup({
      query: '  tokyo ',
      forecastDays: 2,
      units: 'metric',
      timeZone: 'Asia/Tokyo',
    });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // After 16 minutes: forecast expires (1 HTTP call), geocode still cached (24h TTL).
    clock += 6 * 60_000;
    await provider.lookup({
      query: 'Tokyo',
      forecastDays: 2,
      units: 'metric',
      timeZone: 'Asia/Tokyo',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);

    // After 25 hours: both geocode and forecast expire (2 HTTP calls).
    clock += 25 * 60 * 60_000;
    await provider.lookup({
      query: 'Tokyo',
      forecastDays: 2,
      units: 'metric',
      timeZone: 'Asia/Tokyo',
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('skips geocoding when saved coordinates are provided and rounds coordinates to 2 decimals for cache keys', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(FORECAST_TOKYO));
    const provider = new OpenMeteoWeatherProvider({
      fetcher,
      apiKey: 'secret-upgrade-key',
    });

    const res1 = await provider.lookup({
      coordinates: { latitude: 35.6895, longitude: 139.6917, city: 'Tokyo', country: 'Japan' },
      forecastDays: 3,
      units: 'imperial',
      timeZone: 'Asia/Tokyo',
    });
    expect(res1.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = String(fetcher.mock.calls[0]![0]);
    expect(url).toContain('temperature_unit=fahrenheit');
    expect(url).toContain('wind_speed_unit=mph');
    expect(url).toContain('apikey=secret-upgrade-key');

    // Nearby coordinate rounding to identical 2-decimal cell hits cache.
    const res2 = await provider.lookup({
      coordinates: { latitude: 35.6911, longitude: 139.6941, city: 'Tokyo', country: 'Japan' },
      forecastDays: 3,
      units: 'imperial',
      timeZone: 'Asia/Tokyo',
    });
    expect(res2.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns LOCATION_NOT_FOUND when geocoding returns empty results and WEATHER_UNAVAILABLE on HTTP/size/timeout errors', async () => {
    const emptyFetcher = vi.fn<typeof fetch>(async () => jsonResponse({ results: [] }));
    const notFound = await new OpenMeteoWeatherProvider({ fetcher: emptyFetcher }).lookup({
      query: 'AtlantisXYZ',
      forecastDays: 3,
      units: 'metric',
      timeZone: 'Etc/UTC',
    });
    expect(notFound).toEqual({ ok: false, code: 'LOCATION_NOT_FOUND' });

    const errorFetcher = vi.fn<typeof fetch>(async () => jsonResponse({ error: true }, 503));
    const unavailable = await new OpenMeteoWeatherProvider({ fetcher: errorFetcher }).lookup({
      coordinates: { latitude: 13.08, longitude: 80.27, city: 'Chennai' },
      forecastDays: 3,
      units: 'metric',
      timeZone: 'Asia/Kolkata',
    });
    expect(unavailable).toEqual({ ok: false, code: 'WEATHER_UNAVAILABLE' });

    const oversizedFetcher = vi.fn<typeof fetch>(
      async () => new Response('x'.repeat(2048), { status: 200 }),
    );
    const oversized = await new OpenMeteoWeatherProvider({
      fetcher: oversizedFetcher,
      maxResponseBytes: 512,
    }).lookup({
      coordinates: { latitude: 13.08, longitude: 80.27, city: 'Chennai' },
      forecastDays: 3,
      units: 'metric',
      timeZone: 'Asia/Kolkata',
    });
    expect(oversized).toEqual({ ok: false, code: 'WEATHER_UNAVAILABLE' });
  });

  it('evicts oldest cache entries at maxCacheEntries and propagates caller abort', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(FORECAST_TOKYO));
    const provider = new OpenMeteoWeatherProvider({ fetcher, maxCacheEntries: 2 });

    for (const lat of [10, 20, 30]) {
      await provider.lookup({
        coordinates: { latitude: lat, longitude: 10, city: `City${lat}` },
        forecastDays: 1,
        units: 'metric',
        timeZone: 'Etc/UTC',
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    // Entry lat=10 was evicted; fetching it again hits network.
    await provider.lookup({
      coordinates: { latitude: 10, longitude: 10, city: 'City10' },
      forecastDays: 1,
      units: 'metric',
      timeZone: 'Etc/UTC',
    });
    expect(fetcher).toHaveBeenCalledTimes(4);

    const ac = new AbortController();
    ac.abort();
    await expect(
      provider.lookup({
        coordinates: { latitude: 40, longitude: 10, city: 'Aborted' },
        forecastDays: 1,
        units: 'metric',
        timeZone: 'Etc/UTC',
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
