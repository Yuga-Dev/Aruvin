/**
 * ============================================================================
 * FILE: weather-protocol.ts
 * LOCATION: frontend/src/api/weather-protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define client-safe WeatherView types and strict runtime wire guards.
 *
 * ROLE IN PROJECT:
 *    Mirrors backend WeatherView contracts for SSE streams, persisted messages,
 *    and live voice frames while enforcing UTF-8 byte caps and safe attribution.
 *
 * KEY COMPONENTS:
 *    - WeatherView / WeatherViewEvent: Shared structured forecast payload types.
 *    - isSafeOpenMeteoUrl: Pins attribution link strictly to https://open-meteo.com/.
 *    - isWeatherView / isWeatherViewEvent: Structural runtime type guards.
 * ============================================================================
 */

export const WEATHER_VIEW_MAX_BYTES = 14336;
export const OPEN_METEO_ATTRIBUTION_URL = 'https://open-meteo.com/' as const;

export type WeatherUnits = 'metric' | 'imperial';
export type WeatherLocationSource = 'explicit' | 'personalization' | 'edge-geo';

export type WeatherLocation = {
  city: string;
  region?: string;
  country?: string;
  source: WeatherLocationSource;
};

export type WeatherCurrent = {
  temperature: number;
  apparentTemperature: number;
  weatherCode: number;
  condition: string;
  humidityPercent?: number;
  windSpeed?: number;
  isDay?: boolean;
};

export type WeatherHourlyPoint = {
  time: string;
  temperature: number;
  weatherCode: number;
  precipitationProbability?: number;
};

export type WeatherDailyPoint = {
  date: string;
  tempMax: number;
  tempMin: number;
  weatherCode: number;
  condition: string;
  precipitationProbabilityMax?: number;
};

export type WeatherView = {
  schemaVersion: 1;
  kind: 'weather';
  capturedAt: string;
  units: WeatherUnits;
  location: WeatherLocation;
  current: WeatherCurrent;
  hourly: WeatherHourlyPoint[];
  daily: WeatherDailyPoint[];
  attribution: {
    label: 'Open-Meteo';
    url: 'https://open-meteo.com/';
  };
};

export type WeatherViewEvent = {
  type: 'weather-view';
  view: WeatherView;
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCleanLabel(value: unknown, maxLen: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLen &&
    value === value.trim() &&
    !CONTROL_CHARS.test(value)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isWeatherCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99;
}

function isPercent(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 100;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 10 &&
    value.length <= 64 &&
    !CONTROL_CHARS.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function isSafeOpenMeteoUrl(value: unknown): value is 'https://open-meteo.com/' {
  return value === OPEN_METEO_ATTRIBUTION_URL;
}

function isWeatherLocation(value: unknown): value is WeatherLocation {
  if (!isRecord(value) || !hasOnlyKeys(value, ['city', 'region', 'country', 'source'])) {
    return false;
  }
  return (
    isCleanLabel(value.city, 100) &&
    (!('region' in value) || value.region === undefined || isCleanLabel(value.region, 100)) &&
    (!('country' in value) || value.country === undefined || isCleanLabel(value.country, 100)) &&
    (value.source === 'explicit' || value.source === 'personalization' || value.source === 'edge-geo')
  );
}

function isWeatherCurrent(value: unknown): value is WeatherCurrent {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'temperature',
      'apparentTemperature',
      'weatherCode',
      'condition',
      'humidityPercent',
      'windSpeed',
      'isDay',
    ])
  ) {
    return false;
  }
  return (
    isFiniteNumber(value.temperature) &&
    isFiniteNumber(value.apparentTemperature) &&
    isWeatherCode(value.weatherCode) &&
    isCleanLabel(value.condition, 100) &&
    (!('humidityPercent' in value) || value.humidityPercent === undefined || isPercent(value.humidityPercent)) &&
    (!('windSpeed' in value) || value.windSpeed === undefined ||
      (isFiniteNumber(value.windSpeed) && value.windSpeed >= 0)) &&
    (!('isDay' in value) || value.isDay === undefined || typeof value.isDay === 'boolean')
  );
}

function isWeatherHourlyPoint(value: unknown): value is WeatherHourlyPoint {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['time', 'temperature', 'weatherCode', 'precipitationProbability'])
  ) {
    return false;
  }
  return (
    isIsoTimestamp(value.time) &&
    isFiniteNumber(value.temperature) &&
    isWeatherCode(value.weatherCode) &&
    (!('precipitationProbability' in value) ||
      value.precipitationProbability === undefined ||
      isPercent(value.precipitationProbability))
  );
}

function isWeatherDailyPoint(value: unknown): value is WeatherDailyPoint {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'date',
      'tempMax',
      'tempMin',
      'weatherCode',
      'condition',
      'precipitationProbabilityMax',
    ])
  ) {
    return false;
  }
  return (
    typeof value.date === 'string' &&
    DATE_RE.test(value.date) &&
    isFiniteNumber(value.tempMax) &&
    isFiniteNumber(value.tempMin) &&
    isWeatherCode(value.weatherCode) &&
    isCleanLabel(value.condition, 100) &&
    (!('precipitationProbabilityMax' in value) ||
      value.precipitationProbabilityMax === undefined ||
      isPercent(value.precipitationProbabilityMax))
  );
}

export function isWeatherView(value: unknown): value is WeatherView {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'kind',
      'capturedAt',
      'units',
      'location',
      'current',
      'hourly',
      'daily',
      'attribution',
    ])
  ) {
    return false;
  }
  if (value.schemaVersion !== 1 || value.kind !== 'weather') return false;
  if (!isIsoTimestamp(value.capturedAt)) return false;
  if (value.units !== 'metric' && value.units !== 'imperial') return false;
  if (!isWeatherLocation(value.location) || !isWeatherCurrent(value.current)) return false;
  if (!Array.isArray(value.hourly) || value.hourly.length > 24 || !value.hourly.every(isWeatherHourlyPoint)) {
    return false;
  }
  if (!Array.isArray(value.daily) || value.daily.length > 7 || !value.daily.every(isWeatherDailyPoint)) {
    return false;
  }
  if (
    !isRecord(value.attribution) ||
    !hasOnlyKeys(value.attribution, ['label', 'url']) ||
    value.attribution.label !== 'Open-Meteo' ||
    !isSafeOpenMeteoUrl(value.attribution.url)
  ) {
    return false;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= WEATHER_VIEW_MAX_BYTES;
  } catch {
    return false;
  }
}

export function isWeatherViewEvent(value: unknown): value is WeatherViewEvent {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.type === 'weather-view' &&
    isWeatherView(value.view)
  );
}
