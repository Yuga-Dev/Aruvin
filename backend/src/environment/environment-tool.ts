/**
 * ============================================================================
 * FILE: environment-tool.ts
 * LOCATION: backend/src/environment/environment-tool.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Execute get_environment requests with in-process datetime, 4-tier location
 *    precedence, partial-success weather lookups, and WeatherView projection.
 *
 * ROLE IN PROJECT:
 *    Shared pure-orchestration executor called by CalendarLoop and the
 *    web-only/tool-capable text loop. Performs zero database I/O and never
 *    fails datetime/location when weather is unavailable.
 *
 * KEY COMPONENTS:
 *    - buildEnvironmentDatetime: <1ms Intl-based local clock and UTC offset.
 *    - resolveEnvironmentLocation: explicit > personalization > edge-geo > none.
 *    - executeEnvironmentTool: Returns validated GetEnvironmentResult + WeatherView.
 * ============================================================================
 */

import {
  getEnvironmentArgumentsSchema,
  getEnvironmentResultSchema,
  type EnvironmentDatetime,
  type EnvironmentLocation,
  type EnvironmentWeather,
  type GetEnvironmentEnvelope,
  type GetEnvironmentResult,
} from '../contracts/environment-tools.js';
import {
  weatherViewSchema,
  type WeatherLocationSource,
  type WeatherView,
} from '../contracts/weather-view.js';
import {
  normalizeTimeZone,
  type RequestGeoHint,
} from '../platform/environment/request-environment.js';
import { AppError } from '../platform/errors/app-error.js';
import type { GeocodedLocation, WeatherProvider } from './weather-service.js';

export type EnvironmentSavedLocation = Readonly<{
  city: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}>;

export type ResolvedEnvironmentLocation =
  | Readonly<{
      available: true;
      city: string;
      region?: string;
      country?: string;
      source: WeatherLocationSource;
      query?: string;
      coordinates?: GeocodedLocation;
    }>
  | Readonly<{ available: false; reason: 'LOCATION_UNKNOWN' }>;

export type EnvironmentExecutionResult = Readonly<{
  result: GetEnvironmentResult;
  weatherView: WeatherView | null;
}>;

function cleanOptional(value: unknown, maxLen = 100): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return undefined;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return trimmed;
}

/**
 * Reads Milestone 1's optional `location` from cached UserPersonalizationSettings
 * without requiring a hard compile-time coupling before Milestone 1 lands.
 */
export function extractSavedLocation(personalization: unknown): EnvironmentSavedLocation | null {
  if (!personalization || typeof personalization !== 'object' || Array.isArray(personalization)) {
    return null;
  }
  const raw = (personalization as { location?: unknown }).location;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const loc = raw as Record<string, unknown>;
  const city = cleanOptional(loc.city, 100);
  if (!city) return null;
  const region = cleanOptional(loc.region, 100);
  const country = cleanOptional(loc.country, 100);
  const hasCoords =
    typeof loc.latitude === 'number' &&
    Number.isFinite(loc.latitude) &&
    loc.latitude >= -90 &&
    loc.latitude <= 90 &&
    typeof loc.longitude === 'number' &&
    Number.isFinite(loc.longitude) &&
    loc.longitude >= -180 &&
    loc.longitude <= 180;
  return {
    city,
    ...(region ? { region } : {}),
    ...(country ? { country } : {}),
    ...(hasCoords ? { latitude: loc.latitude as number, longitude: loc.longitude as number } : {}),
  };
}

function formatUtcOffset(date: Date, timeZone: string): string {
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find(part => part.type === 'timeZoneName')?.value;
  if (tzPart === 'GMT' || tzPart === 'UTC') return '+00:00';
  const match = tzPart ? /^GMT([+-]\d{2}):(\d{2})$/.exec(tzPart) : null;
  if (match) return `${match[1]}:${match[2]}`;

  // Fallback: compute wall-clock minute difference from UTC.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, Number(p.value)]),
  );
  const wallUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  const offsetMinutes = Math.round((wallUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

export function buildEnvironmentDatetime(now: Date, rawTimeZone?: string | null): EnvironmentDatetime {
  const date = Number.isNaN(now.getTime()) ? new Date() : now;
  const timeZone = normalizeTimeZone(rawTimeZone) ?? 'Etc/UTC';

  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(date);
  let year = '';
  let month = '';
  let day = '';
  let dayOfWeek = '';
  for (const part of dateParts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
    else if (part.type === 'weekday') dayOfWeek = part.value;
  }

  const time24Parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  let hour24 = '00';
  let minute24 = '00';
  for (const part of time24Parts) {
    if (part.type === 'hour') hour24 = part.value.padStart(2, '0');
    else if (part.type === 'minute') minute24 = part.value.padStart(2, '0');
  }

  const localTime12 = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(date)
    .replace(/[\u202f\u00a0]/g, ' ');

  return {
    iso: date.toISOString(),
    localDate: `${year}-${month}-${day}`,
    dayOfWeek,
    localTime24: `${hour24}:${minute24}`,
    localTime12,
    timeZone,
    utcOffset: formatUtcOffset(date, timeZone),
  };
}

export function resolveEnvironmentLocation(input: {
  explicit?: string | null;
  saved?: EnvironmentSavedLocation | null;
  requestGeo?: RequestGeoHint | null;
}): ResolvedEnvironmentLocation {
  const explicit = cleanOptional(input.explicit, 100);
  if (explicit) {
    return {
      available: true,
      city: explicit,
      source: 'explicit',
      query: explicit,
    };
  }
  if (input.saved) {
    const city = cleanOptional(input.saved.city, 100);
    if (city) {
      const region = cleanOptional(input.saved.region, 100);
      const country = cleanOptional(input.saved.country, 100);
      const hasCoords =
        typeof input.saved.latitude === 'number' &&
        Number.isFinite(input.saved.latitude) &&
        typeof input.saved.longitude === 'number' &&
        Number.isFinite(input.saved.longitude);
      return {
        available: true,
        city,
        ...(region ? { region } : {}),
        ...(country ? { country } : {}),
        source: 'personalization',
        ...(hasCoords
          ? {
              coordinates: {
                latitude: input.saved.latitude!,
                longitude: input.saved.longitude!,
                city,
                ...(region ? { region } : {}),
                ...(country ? { country } : {}),
              },
            }
          : { query: [city, region, country].filter(Boolean).join(', ') }),
      };
    }
  }
  if (input.requestGeo) {
    const city = cleanOptional(input.requestGeo.city, 100);
    if (city) {
      const region = cleanOptional(input.requestGeo.region, 100);
      const country = cleanOptional(input.requestGeo.country, 100);
      return {
        available: true,
        city,
        ...(region ? { region } : {}),
        ...(country ? { country } : {}),
        source: 'edge-geo',
        query: [city, region, country].filter(Boolean).join(', '),
      };
    }
  }
  return { available: false, reason: 'LOCATION_UNKNOWN' };
}

export async function executeEnvironmentTool(input: {
  envelope: GetEnvironmentEnvelope;
  now: Date;
  timeZone?: string | null;
  savedLocation?: EnvironmentSavedLocation | null;
  requestGeo?: RequestGeoHint | null;
  weatherProvider?: WeatherProvider;
  signal?: AbortSignal;
}): Promise<EnvironmentExecutionResult> {
  if (input.signal?.aborted) {
    throw new AppError('CANCELLED', 'The environment request was cancelled.', false);
  }
  const args = getEnvironmentArgumentsSchema.parse(input.envelope);
  const timeZone = normalizeTimeZone(input.timeZone) ?? 'Etc/UTC';
  const capturedAt = input.now.toISOString();
  const include = new Set(args.include);
  const validForCurrentTurnOnly = (['datetime', 'weather'] as const).filter(key => include.has(key));

  const datetime = include.has('datetime') ? buildEnvironmentDatetime(input.now, timeZone) : undefined;
  const resolved =
    include.has('location') || include.has('weather')
      ? resolveEnvironmentLocation({
          explicit: args.location,
          saved: input.savedLocation,
          requestGeo: input.requestGeo,
        })
      : null;

  let location: EnvironmentLocation | undefined;
  if (include.has('location') && resolved) {
    location = resolved.available
      ? {
          available: true,
          city: resolved.city,
          ...(resolved.region ? { region: resolved.region } : {}),
          ...(resolved.country ? { country: resolved.country } : {}),
          source: resolved.source,
        }
      : { available: false, reason: 'LOCATION_UNKNOWN' };
  }

  let weather: EnvironmentWeather | undefined;
  let weatherView: WeatherView | null = null;
  if (include.has('weather')) {
    if (!resolved || !resolved.available) {
      weather = { ok: false, code: 'LOCATION_UNKNOWN' };
    } else if (!input.weatherProvider) {
      weather = { ok: false, code: 'WEATHER_UNAVAILABLE' };
    } else {
      try {
        const lookup = await input.weatherProvider.lookup({
          ...(resolved.coordinates ? { coordinates: resolved.coordinates } : { query: resolved.query }),
          forecastDays: args.forecast_days,
          units: args.units,
          timeZone,
          signal: input.signal,
        });
        if (lookup.ok) {
          weather = {
            ok: true,
            resolvedLocation: lookup.resolvedLocation,
            units: lookup.units,
            current: lookup.current,
            hourly: lookup.hourly,
            daily: lookup.daily,
            attribution: lookup.attribution,
          };
          weatherView = weatherViewSchema.parse({
            schemaVersion: 1,
            kind: 'weather',
            capturedAt,
            units: lookup.units,
            location: {
              ...lookup.resolvedLocation,
              source: resolved.source,
            },
            current: lookup.current,
            hourly: lookup.hourly,
            daily: lookup.daily,
            attribution: lookup.attribution,
          });
        } else {
          weather = { ok: false, code: lookup.code };
        }
      } catch (error) {
        if (input.signal?.aborted || (error instanceof AppError && error.code === 'CANCELLED')) {
          throw error instanceof AppError
            ? error
            : new AppError('CANCELLED', 'The environment request was cancelled.', false);
        }
        weather = { ok: false, code: 'WEATHER_UNAVAILABLE' };
      }
    }
  }

  const result = getEnvironmentResultSchema.parse({
    kind: 'environment-result',
    capturedAt,
    validForCurrentTurnOnly,
    ...(datetime ? { datetime } : {}),
    ...(location ? { location } : {}),
    ...(weather ? { weather } : {}),
  });

  return { result, weatherView };
}
