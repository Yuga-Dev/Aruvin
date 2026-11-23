/**
 * ============================================================================
 * FILE: environment-tools.ts
 * LOCATION: backend/src/contracts/environment-tools.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define the built-in native get_environment tool schema, arguments, and results.
 *
 * ROLE IN PROJECT:
 *    Dependency-leaf contract for Aurvin's on-demand datetime, location, and
 *    weather tool so Calendar, Web, and Voice loops validate one canonical shape.
 *
 * KEY COMPONENTS:
 *    - GET_ENVIRONMENT_PARAMETERS / GET_ENVIRONMENT_NATIVE_TOOL /
 *      GET_ENVIRONMENT_TOOL_DEFINITION: Frozen provider-safe flat schemas.
 *    - getEnvironmentEnvelopeSchema / getEnvironmentArgumentsSchema: Strict inputs.
 *    - getEnvironmentResultSchema: Bounded partial-success result contract.
 * ============================================================================
 */

import { z } from 'zod';
import { isoDateSchema } from './identifiers.js';
import {
  weatherAttributionSchema,
  weatherCurrentSchema,
  weatherDailyItemSchema,
  weatherHourlyItemSchema,
  weatherLocationSourceSchema,
  weatherResolvedLocationSchema,
  weatherUnitsSchema,
} from './weather-view.js';

export const ENVIRONMENT_TOOL_NAME = 'get_environment' as const;
export const ENVIRONMENT_INCLUDE_FIELDS = ['datetime', 'location', 'weather'] as const;
export const ENVIRONMENT_VOLATILE_FIELDS = ['datetime', 'weather'] as const;
export const ENVIRONMENT_ARGUMENT_MAX_BYTES = 16_384;
export const ENVIRONMENT_RESULT_MAX_BYTES = 16_384;

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

function noControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

export const GET_ENVIRONMENT_DESCRIPTION =
  'Fetch current environment details on demand in one call: exact local datetime, user location, and/or current and forecast weather. Batch all needed fields into include. Omit location to use the user\'s saved or approximate location, or pass a city name to query a specific place.';

export const GET_ENVIRONMENT_PARAMETERS = freezeDeep({
  type: 'object' as const,
  additionalProperties: false as const,
  required: ['include'] as const,
  properties: {
    include: {
      type: 'array' as const,
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: {
        type: 'string' as const,
        enum: ['datetime', 'location', 'weather'] as const,
      },
      description: 'Environment fields to fetch in one call.',
    },
    location: {
      type: 'string' as const,
      minLength: 1,
      maxLength: 100,
      description: 'Optional explicit city or place override (for example, "Tokyo").',
    },
    forecast_days: {
      type: 'integer' as const,
      minimum: 1,
      maximum: 7,
      description: 'Number of forecast days when weather is included (default 3).',
    },
    units: {
      type: 'string' as const,
      enum: ['metric', 'imperial'] as const,
      description: 'Units for weather values (default metric).',
    },
  },
});

export const GET_ENVIRONMENT_NATIVE_TOOL = freezeDeep({
  name: ENVIRONMENT_TOOL_NAME,
  description: GET_ENVIRONMENT_DESCRIPTION,
  inputSchema: GET_ENVIRONMENT_PARAMETERS,
});

export const GET_ENVIRONMENT_TOOL_DEFINITION = freezeDeep({
  type: 'function' as const,
  function: {
    name: ENVIRONMENT_TOOL_NAME,
    description: GET_ENVIRONMENT_DESCRIPTION,
    parameters: GET_ENVIRONMENT_PARAMETERS,
  },
});
export type GetEnvironmentToolDefinition = typeof GET_ENVIRONMENT_TOOL_DEFINITION;

export const environmentIncludeFieldSchema = z.enum(ENVIRONMENT_INCLUDE_FIELDS);
export type EnvironmentIncludeField = z.infer<typeof environmentIncludeFieldSchema>;

const locationInputSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(value => value.trim().length > 0 && noControlChars(value), {
    message: 'location must be non-empty without control characters.',
  });

/**
 * Strict raw envelope schema without value transforms so native decision
 * identity checks (`isDeepStrictEqual(JSON.parse(arguments), envelope)`) hold.
 */
export const getEnvironmentEnvelopeSchema = z
  .object({
    include: z
      .array(environmentIncludeFieldSchema)
      .min(1)
      .max(3)
      .refine(values => new Set(values).size === values.length, {
        message: 'include values must be unique.',
      }),
    location: locationInputSchema.optional(),
    forecast_days: z.number().int().min(1).max(7).optional(),
    units: weatherUnitsSchema.optional(),
  })
  .strict()
  .refine(v => Buffer.byteLength(JSON.stringify(v), 'utf8') <= ENVIRONMENT_ARGUMENT_MAX_BYTES, {
    message: 'get_environment arguments exceed UTF-8 byte limit.',
  });
export type GetEnvironmentEnvelope = z.infer<typeof getEnvironmentEnvelopeSchema>;

export const getEnvironmentArgumentsSchema = getEnvironmentEnvelopeSchema.transform(v => ({
  include: v.include,
  ...(v.location !== undefined ? { location: v.location.trim() } : {}),
  forecast_days: v.forecast_days ?? 3,
  units: v.units ?? ('metric' as const),
}));
export type GetEnvironmentArguments = z.infer<typeof getEnvironmentArgumentsSchema>;

export const environmentDatetimeSchema = z
  .object({
    iso: isoDateSchema,
    localDate: z.string().date(),
    dayOfWeek: z.string().min(1).max(32),
    localTime24: z.string().regex(/^\d{2}:\d{2}$/),
    localTime12: z.string().min(1).max(16),
    timeZone: z.string().min(1).max(100),
    utcOffset: z.string().regex(/^[+-]\d{2}:\d{2}$/),
  })
  .strict();
export type EnvironmentDatetime = z.infer<typeof environmentDatetimeSchema>;

export const environmentLocationSchema = z.discriminatedUnion('available', [
  weatherResolvedLocationSchema
    .extend({
      available: z.literal(true),
      source: weatherLocationSourceSchema,
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      reason: z.literal('LOCATION_UNKNOWN'),
    })
    .strict(),
]);
export type EnvironmentLocation = z.infer<typeof environmentLocationSchema>;

export const environmentWeatherSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      resolvedLocation: weatherResolvedLocationSchema,
      units: weatherUnitsSchema,
      current: weatherCurrentSchema,
      hourly: z.array(weatherHourlyItemSchema).max(24),
      daily: z.array(weatherDailyItemSchema).max(7),
      attribution: weatherAttributionSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(['LOCATION_UNKNOWN', 'LOCATION_NOT_FOUND', 'WEATHER_UNAVAILABLE']),
    })
    .strict(),
]);
export type EnvironmentWeather = z.infer<typeof environmentWeatherSchema>;

export const getEnvironmentResultSchema = z
  .object({
    kind: z.literal('environment-result'),
    capturedAt: isoDateSchema,
    validForCurrentTurnOnly: z
      .array(z.enum(ENVIRONMENT_VOLATILE_FIELDS))
      .max(2)
      .refine(values => new Set(values).size === values.length, {
        message: 'validForCurrentTurnOnly values must be unique.',
      }),
    datetime: environmentDatetimeSchema.optional(),
    location: environmentLocationSchema.optional(),
    weather: environmentWeatherSchema.optional(),
  })
  .strict()
  .refine(v => Buffer.byteLength(JSON.stringify(v), 'utf8') <= ENVIRONMENT_RESULT_MAX_BYTES, {
    message: 'get_environment result exceeds UTF-8 byte limit.',
  });
export type GetEnvironmentResult = z.infer<typeof getEnvironmentResultSchema>;
