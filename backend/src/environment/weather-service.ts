/**
 * ============================================================================
 * FILE: weather-service.ts
 * LOCATION: backend/src/environment/weather-service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Provide a clean WeatherProvider port and cached Open-Meteo implementation.
 *
 * ROLE IN PROJECT:
 *    Executes bounded, timeout-enforced geocoding and weather forecast lookups
 *    on demand with strict in-memory LRU/TTL caching and closed error mapping.
 *
 * KEY COMPONENTS:
 *    - WeatherProvider: Injectable weather lookup port.
 *    - BoundedTtlCache: Fixed-capacity Map-backed LRU + TTL cache.
 *    - OpenMeteoWeatherProvider: Free Open-Meteo geocoding & forecast client.
 * ============================================================================
 */

import {
  WEATHER_ATTRIBUTION,
  type WeatherResolvedLocation,
  type WeatherUnits,
  type WeatherView,
} from '../contracts/weather-view.js';
import { AppError } from '../platform/errors/app-error.js';
import { wmoConditionLabel } from './wmo-codes.js';

export const DEFAULT_OPEN_METEO_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const DEFAULT_OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const DEFAULT_WEATHER_TIMEOUT_MS = 5_000;
export const DEFAULT_WEATHER_MAX_RESPONSE_BYTES = 262_144;
export const DEFAULT_GEOCODE_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_FORECAST_TTL_MS = 15 * 60 * 1_000;
export const DEFAULT_WEATHER_CACHE_ENTRIES = 256;
const MAX_HOURLY_ENTRIES = 12;

export type GeocodedLocation = Readonly<{
  city: string;
  region?: string;
  country?: string;
  latitude: number;
  longitude: number;
}>;

export type WeatherLookupInput = Readonly<{
  query?: string;
  coordinates?: GeocodedLocation;
  forecastDays: number;
  units: WeatherUnits;
  timeZone: string;
  signal?: AbortSignal;
}>;

export type WeatherLookupSuccess = Readonly<{
  ok: true;
  resolvedLocation: WeatherResolvedLocation;
  units: WeatherUnits;
  current: WeatherView['current'];
  hourly: WeatherView['hourly'];
  daily: WeatherView['daily'];
  attribution: WeatherView['attribution'];
}>;

export type WeatherLookupResult =
  | WeatherLookupSuccess
  | Readonly<{ ok: false; code: 'LOCATION_NOT_FOUND' | 'WEATHER_UNAVAILABLE' }>;

export interface WeatherProvider {
  lookup(input: WeatherLookupInput): Promise<WeatherLookupResult>;
}

export type OpenMeteoWeatherProviderOptions = Readonly<{
  fetcher?: typeof fetch;
  geocodingBaseUrl?: string;
  forecastBaseUrl?: string;
  apiKey?: string | null;
  timeoutMs?: number;
  maxResponseBytes?: number;
  geocodeTtlMs?: number;
  forecastTtlMs?: number;
  maxCacheEntries?: number;
  now?: () => number;
}>;

type CacheEntry<T> = { value: T; expiresAt: number };

class BoundedTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

function cleanString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return undefined;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return trimmed;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function wmoInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99 ? value : null;
}

function clampPercent(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n === null) return undefined;
  return Math.max(0, Math.min(100, n));
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    return JSON.parse(text) as unknown;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const merged = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  return JSON.parse(merged.toString('utf8')) as unknown;
}

export class OpenMeteoWeatherProvider implements WeatherProvider {
  private readonly fetcher: typeof fetch;
  private readonly geocodingBaseUrl: string;
  private readonly forecastBaseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly geocodeCache: BoundedTtlCache<GeocodedLocation>;
  private readonly forecastCache: BoundedTtlCache<Omit<WeatherLookupSuccess, 'resolvedLocation'>>;

  constructor(options: OpenMeteoWeatherProviderOptions = {}) {
    const now = options.now ?? Date.now;
    const maxEntries = Math.max(1, Math.min(options.maxCacheEntries ?? DEFAULT_WEATHER_CACHE_ENTRIES, 1024));
    this.fetcher = options.fetcher ?? fetch;
    this.geocodingBaseUrl = options.geocodingBaseUrl ?? DEFAULT_OPEN_METEO_GEOCODING_URL;
    this.forecastBaseUrl = options.forecastBaseUrl ?? DEFAULT_OPEN_METEO_FORECAST_URL;
    this.apiKey = options.apiKey?.trim() || null;
    this.timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? DEFAULT_WEATHER_TIMEOUT_MS, 15_000));
    this.maxResponseBytes = Math.max(256, Math.min(options.maxResponseBytes ?? DEFAULT_WEATHER_MAX_RESPONSE_BYTES, 1_048_576));
    this.geocodeCache = new BoundedTtlCache(maxEntries, options.geocodeTtlMs ?? DEFAULT_GEOCODE_TTL_MS, now);
    this.forecastCache = new BoundedTtlCache(maxEntries, options.forecastTtlMs ?? DEFAULT_FORECAST_TTL_MS, now);
  }

  async lookup(input: WeatherLookupInput): Promise<WeatherLookupResult> {
    if (input.signal?.aborted) {
      throw new AppError('CANCELLED', 'The environment request was cancelled.', false);
    }
    let place: GeocodedLocation;
    if (input.coordinates) {
      place = input.coordinates;
    } else {
      const normalized = input.query?.trim();
      if (!normalized) return { ok: false, code: 'LOCATION_NOT_FOUND' };
      const geocoded = await this.geocode(normalized, input.signal);
      if ('ok' in geocoded) return geocoded;
      place = geocoded;
    }

    const days = Math.max(1, Math.min(7, Math.trunc(input.forecastDays)));
    const cacheKey = `${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}|${input.units}|${days}|${input.timeZone}`;
    const cached = this.forecastCache.get(cacheKey);
    const resolvedLocation: WeatherResolvedLocation = {
      city: place.city,
      ...(place.region ? { region: place.region } : {}),
      ...(place.country ? { country: place.country } : {}),
    };
    if (cached) {
      return { ...cached, resolvedLocation };
    }

    const fetched = await this.fetchForecast(place.latitude, place.longitude, days, input.units, input.timeZone, input.signal);
    if (!fetched) return { ok: false, code: 'WEATHER_UNAVAILABLE' };
    this.forecastCache.set(cacheKey, fetched);
    return { ...fetched, resolvedLocation };
  }

  private async fetchJson(url: URL, outer?: AbortSignal): Promise<unknown | null> {
    if (outer?.aborted) {
      throw new AppError('CANCELLED', 'The environment request was cancelled.', false);
    }
    const timerCtrl = new AbortController();
    const timer = setTimeout(() => timerCtrl.abort(), this.timeoutMs);
    timer.unref?.();
    const signal = outer ? AbortSignal.any([outer, timerCtrl.signal]) : timerCtrl.signal;
    try {
      const response = await this.fetcher(url.toString(), {
        method: 'GET',
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      return await readBoundedJson(response, this.maxResponseBytes);
    } catch {
      if (outer?.aborted) {
        throw new AppError('CANCELLED', 'The environment request was cancelled.', false);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async geocode(
    query: string,
    signal?: AbortSignal,
  ): Promise<GeocodedLocation | { ok: false; code: 'LOCATION_NOT_FOUND' | 'WEATHER_UNAVAILABLE' }> {
    const key = query.toLowerCase();
    const cached = this.geocodeCache.get(key);
    if (cached) return cached;

    const url = new URL(this.geocodingBaseUrl);
    url.searchParams.set('name', query);
    url.searchParams.set('count', '1');
    url.searchParams.set('language', 'en');
    url.searchParams.set('format', 'json');
    if (this.apiKey) url.searchParams.set('apikey', this.apiKey);

    const payload = await this.fetchJson(url, signal);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, code: 'WEATHER_UNAVAILABLE' };
    }
    const results = (payload as Record<string, unknown>).results;
    if (!Array.isArray(results) || results.length === 0) {
      return { ok: false, code: 'LOCATION_NOT_FOUND' };
    }
    const first = results[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) {
      return { ok: false, code: 'WEATHER_UNAVAILABLE' };
    }
    const item = first as Record<string, unknown>;
    const city = cleanString(item.name, 100);
    const latitude = finiteNumber(item.latitude);
    const longitude = finiteNumber(item.longitude);
    if (!city || latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return { ok: false, code: 'WEATHER_UNAVAILABLE' };
    }
    const region = cleanString(item.admin1, 100);
    const country = cleanString(item.country, 100) ?? cleanString(item.country_code, 16);
    const resolved: GeocodedLocation = Object.freeze({
      city,
      ...(region ? { region } : {}),
      ...(country ? { country } : {}),
      latitude,
      longitude,
    });
    this.geocodeCache.set(key, resolved);
    return resolved;
  }

  private async fetchForecast(
    latitude: number,
    longitude: number,
    forecastDays: number,
    units: WeatherUnits,
    timeZone: string,
    signal?: AbortSignal,
  ): Promise<Omit<WeatherLookupSuccess, 'resolvedLocation'> | null> {
    const url = new URL(this.forecastBaseUrl);
    url.searchParams.set('latitude', latitude.toFixed(4));
    url.searchParams.set('longitude', longitude.toFixed(4));
    url.searchParams.set(
      'current',
      'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day',
    );
    url.searchParams.set('hourly', 'temperature_2m,weather_code,precipitation_probability');
    url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max');
    url.searchParams.set('forecast_days', String(forecastDays));
    url.searchParams.set('timezone', timeZone);
    if (units === 'imperial') {
      url.searchParams.set('temperature_unit', 'fahrenheit');
      url.searchParams.set('wind_speed_unit', 'mph');
    }
    if (this.apiKey) url.searchParams.set('apikey', this.apiKey);

    const payload = await this.fetchJson(url, signal);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const root = payload as Record<string, unknown>;
    const rawCurrent = root.current;
    if (!rawCurrent || typeof rawCurrent !== 'object' || Array.isArray(rawCurrent)) return null;
    const cur = rawCurrent as Record<string, unknown>;
    const temperature = finiteNumber(cur.temperature_2m);
    const apparentTemperature = finiteNumber(cur.apparent_temperature) ?? temperature;
    const weatherCode = wmoInt(cur.weather_code);
    if (temperature === null || apparentTemperature === null || weatherCode === null) return null;

    const humidityPercent = clampPercent(cur.relative_humidity_2m);
    const wind = finiteNumber(cur.wind_speed_10m);
    const windSpeed = wind !== null && wind >= 0 ? wind : undefined;
    const isDay = cur.is_day === 1 ? true : cur.is_day === 0 ? false : undefined;
    const currentTime = cleanString(cur.time, 64);

    const hourly: WeatherView['hourly'] = [];
    if (root.hourly && typeof root.hourly === 'object' && !Array.isArray(root.hourly)) {
      const h = root.hourly as Record<string, unknown>;
      const times = Array.isArray(h.time) ? h.time : [];
      const temps = Array.isArray(h.temperature_2m) ? h.temperature_2m : [];
      const codes = Array.isArray(h.weather_code) ? h.weather_code : [];
      const pops = Array.isArray(h.precipitation_probability) ? h.precipitation_probability : [];
      let startIdx = 0;
      if (currentTime) {
        const found = times.findIndex(t => typeof t === 'string' && t >= currentTime);
        if (found >= 0) startIdx = found;
      }
      for (let i = startIdx; i < times.length && hourly.length < MAX_HOURLY_ENTRIES; i++) {
        const time = cleanString(times[i], 64);
        const temp = finiteNumber(temps[i]);
        const code = wmoInt(codes[i]);
        if (!time || temp === null || code === null) continue;
        const precipitationProbability = clampPercent(pops[i]);
        hourly.push({
          time,
          temperature: temp,
          weatherCode: code,
          ...(precipitationProbability !== undefined ? { precipitationProbability } : {}),
        });
      }
    }

    const daily: WeatherView['daily'] = [];
    if (root.daily && typeof root.daily === 'object' && !Array.isArray(root.daily)) {
      const d = root.daily as Record<string, unknown>;
      const dates = Array.isArray(d.time) ? d.time : [];
      const maxs = Array.isArray(d.temperature_2m_max) ? d.temperature_2m_max : [];
      const mins = Array.isArray(d.temperature_2m_min) ? d.temperature_2m_min : [];
      const codes = Array.isArray(d.weather_code) ? d.weather_code : [];
      const pops = Array.isArray(d.precipitation_probability_max) ? d.precipitation_probability_max : [];
      for (let i = 0; i < dates.length && daily.length < forecastDays; i++) {
        const date = cleanString(dates[i], 16);
        const tempMax = finiteNumber(maxs[i]);
        const tempMin = finiteNumber(mins[i]);
        const code = wmoInt(codes[i]);
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || tempMax === null || tempMin === null || code === null) continue;
        const precipitationProbabilityMax = clampPercent(pops[i]);
        daily.push({
          date,
          tempMax,
          tempMin,
          weatherCode: code,
          condition: wmoConditionLabel(code),
          ...(precipitationProbabilityMax !== undefined ? { precipitationProbabilityMax } : {}),
        });
      }
    }

    return {
      ok: true,
      units,
      current: {
        temperature,
        apparentTemperature,
        weatherCode,
        condition: wmoConditionLabel(weatherCode),
        ...(humidityPercent !== undefined ? { humidityPercent } : {}),
        ...(windSpeed !== undefined ? { windSpeed } : {}),
        ...(isDay !== undefined ? { isDay } : {}),
      },
      hourly,
      daily,
      attribution: WEATHER_ATTRIBUTION,
    };
  }
}
