/**
 * ============================================================================
 * FILE: weather-view.ts
 * LOCATION: backend/src/contracts/weather-view.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define the bounded, data-only WeatherView presentation contract.
 *
 * ROLE IN PROJECT:
 *    Serves as the dependency-leaf contract shared between Milestone 2's
 *    get_environment tool execution and Milestone 3's Canvas, SSE, and Voice
 *    weather presentation layers.
 *
 * KEY COMPONENTS:
 *    - WEATHER_VIEW_MAX_BYTES / WEATHER_ATTRIBUTION: Locked bounds and credit.
 *    - weatherCurrentSchema / weatherHourlyItemSchema / weatherDailyItemSchema:
 *      Reusable sub-schemas shared with getEnvironmentResultSchema.
 *    - weatherViewSchema / WeatherView: Strict validated view contract.
 * ============================================================================
 */

import { z } from 'zod';
import { isoDateSchema } from './identifiers.js';

export const WEATHER_VIEW_MAX_BYTES = 12_288;

export const WEATHER_ATTRIBUTION = Object.freeze({
  label: 'Open-Meteo' as const,
  url: 'https://open-meteo.com/' as const,
});

function noControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

const safeLabel = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(value => value.trim().length > 0 && noControlChars(value), {
      message: 'Value must be non-empty without control characters.',
    });

export const weatherUnitsSchema = z.enum(['metric', 'imperial']);
export type WeatherUnits = z.infer<typeof weatherUnitsSchema>;

export const weatherLocationSourceSchema = z.enum(['explicit', 'personalization', 'edge-geo']);
export type WeatherLocationSource = z.infer<typeof weatherLocationSourceSchema>;

export const weatherResolvedLocationSchema = z
  .object({
    city: safeLabel(100),
    region: safeLabel(100).optional(),
    country: safeLabel(100).optional(),
  })
  .strict();
export type WeatherResolvedLocation = z.infer<typeof weatherResolvedLocationSchema>;

export const weatherViewLocationSchema = weatherResolvedLocationSchema
  .extend({
    source: weatherLocationSourceSchema,
  })
  .strict();

export const weatherCurrentSchema = z
  .object({
    temperature: z.number().finite(),
    apparentTemperature: z.number().finite(),
    weatherCode: z.number().int().min(0).max(99),
    condition: safeLabel(100),
    humidityPercent: z.number().finite().min(0).max(100).optional(),
    windSpeed: z.number().finite().min(0).optional(),
    isDay: z.boolean().optional(),
  })
  .strict();

export const weatherHourlyItemSchema = z
  .object({
    time: safeLabel(64),
    temperature: z.number().finite(),
    weatherCode: z.number().int().min(0).max(99),
    precipitationProbability: z.number().finite().min(0).max(100).optional(),
  })
  .strict();

export const weatherDailyItemSchema = z
  .object({
    date: z.string().date(),
    tempMax: z.number().finite(),
    tempMin: z.number().finite(),
    weatherCode: z.number().int().min(0).max(99),
    condition: safeLabel(100),
    precipitationProbabilityMax: z.number().finite().min(0).max(100).optional(),
  })
  .strict();

export const weatherAttributionSchema = z
  .object({
    label: z.literal('Open-Meteo'),
    url: z.literal('https://open-meteo.com/'),
  })
  .strict();

export const weatherViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('weather'),
    capturedAt: isoDateSchema,
    units: weatherUnitsSchema,
    location: weatherViewLocationSchema,
    current: weatherCurrentSchema,
    hourly: z.array(weatherHourlyItemSchema).max(24),
    daily: z.array(weatherDailyItemSchema).max(7),
    attribution: weatherAttributionSchema,
  })
  .strict()
  .refine(v => Buffer.byteLength(JSON.stringify(v), 'utf8') <= WEATHER_VIEW_MAX_BYTES, {
    message: 'Weather view exceeds UTF-8 byte limit.',
  });

export type WeatherView = z.infer<typeof weatherViewSchema>;

export function isWeatherView(value: unknown): value is WeatherView {
  return weatherViewSchema.safeParse(value).success;
}
