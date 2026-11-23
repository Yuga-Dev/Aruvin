/**
 * ============================================================================
 * FILE: personalization.ts
 * LOCATION: backend/src/contracts/personalization.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define per-user personalization contracts, bounds, normalization, and CAS types.
 *
 * ROLE IN PROJECT:
 *    Provides shared validation, secret/control-character rejection, storage
 *    document schemas, and wire protocol types for /api/personalization.
 *
 * KEY COMPONENTS:
 *    - UserPersonalizationSettings: Warmth, enthusiasm, emoji, customInstructions, location.
 *    - SavedUserLocation: Optional city-level location with coarse coordinates.
 *    - StoredUserPersonalization: Revision-fenced per-user storage document.
 *    - validatePersonalizationSettings / parsePersonalizationPut / parseReset:
 *      Strict validation producing closed field errors.
 * ============================================================================
 */

import { z } from 'zod';
import { idSchema, isoDateSchema } from './identifiers.js';

export const PERSONALIZATION_PROTOCOL_VERSION = 1 as const;
export const PERSONALIZATION_SCHEMA_VERSION = 1 as const;
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 1500;
export const MAX_CUSTOM_INSTRUCTIONS_BYTES = 6000;
export const MAX_LOCATION_FIELD_CHARS = 100;
export const MAX_PERSONALIZATION_BODY_BYTES = 16_384;

export const PERSONALIZATION_AMPLITUDES = ['low', 'medium', 'high'] as const;
export type PersonalizationAmplitude = (typeof PERSONALIZATION_AMPLITUDES)[number];

export const personalizationAmplitudeSchema = z.enum(PERSONALIZATION_AMPLITUDES);

export const PERSONALIZATION_ERROR_CODES = [
  'INVALID_REQUEST',
  'PERSONALIZATION_CONFLICT',
  'NOT_READY',
  'PERSISTENCE_ERROR',
  'LOCATION_UNAVAILABLE',
] as const;
export type PersonalizationErrorCode = (typeof PERSONALIZATION_ERROR_CODES)[number];

export const PERSONALIZATION_FIELD_PATHS = [
  'warmth',
  'enthusiasm',
  'emoji',
  'customInstructions',
  'location',
  'location.city',
  'location.region',
  'location.country',
  'location.latitude',
  'location.longitude',
  'latitude',
  'longitude',
  'expectedRevision',
] as const;
export type PersonalizationFieldPath = (typeof PERSONALIZATION_FIELD_PATHS)[number];

export const PERSONALIZATION_FIELD_ERROR_CODES = [
  'required',
  'invalid',
  'out_of_range',
  'disallowed_characters',
  'secret_pattern',
] as const;
export type PersonalizationFieldErrorCode = (typeof PERSONALIZATION_FIELD_ERROR_CODES)[number];

export type PersonalizationFieldError = {
  path: PersonalizationFieldPath;
  code: PersonalizationFieldErrorCode;
};

export type PersonalizationErrorBody = {
  protocolVersion: 1;
  error: {
    code: PersonalizationErrorCode;
    message: string;
    retryable: boolean;
    currentRevision: number | null;
    fieldErrors: PersonalizationFieldError[];
  };
};

export type SavedUserLocation = {
  city: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
};

export type UserPersonalizationSettings = {
  warmth: PersonalizationAmplitude;
  enthusiasm: PersonalizationAmplitude;
  emoji: PersonalizationAmplitude;
  customInstructions: string;
  location: SavedUserLocation | null;
};

export const DEFAULT_PERSONALIZATION_SETTINGS: Readonly<UserPersonalizationSettings> = Object.freeze({
  warmth: 'medium',
  enthusiasm: 'medium',
  emoji: 'medium',
  customInstructions: '',
  location: null,
});

export function defaultPersonalizationSettings(): UserPersonalizationSettings {
  return { ...DEFAULT_PERSONALIZATION_SETTINGS };
}

export function clonePersonalizationSettings(
  settings: UserPersonalizationSettings,
): UserPersonalizationSettings {
  return {
    warmth: settings.warmth,
    enthusiasm: settings.enthusiasm,
    emoji: settings.emoji,
    customInstructions: settings.customInstructions,
    location: settings.location ? { ...settings.location } : null,
  };
}

export function roundCoarseCoordinate(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function hasLocationControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function normalizeCustomInstructions(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

export function hasDisallowedControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

export const PERSONALIZATION_SECRET_PATTERN =
  /sk-or-v1-|mongodb(?:\+srv)?:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,}|(?:OPENROUTER_API_KEY|MONGODB_URI)\s*[:=]/iu;

export function hasSecretPattern(text: string): boolean {
  return PERSONALIZATION_SECRET_PATTERN.test(text);
}

export function isDefaultPersonalization(settings: UserPersonalizationSettings): boolean {
  return (
    settings.warmth === 'medium' &&
    settings.enthusiasm === 'medium' &&
    settings.emoji === 'medium' &&
    settings.customInstructions === '' &&
    settings.location === null
  );
}

export const customInstructionsSchema = z
  .string()
  .transform(normalizeCustomInstructions)
  .superRefine((value, ctx) => {
    if (hasDisallowedControlChars(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'disallowed_characters',
      });
    }
    if (hasSecretPattern(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'secret_pattern',
      });
    }
    if (
      value.length > MAX_CUSTOM_INSTRUCTIONS_CHARS ||
      Buffer.byteLength(value, 'utf8') > MAX_CUSTOM_INSTRUCTIONS_BYTES
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'out_of_range',
      });
    }
  });

function validateLocationTextField(
  raw: string,
  required: boolean,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: required ? 'required' : 'out_of_range',
    });
    return;
  }
  if (hasLocationControlChars(trimmed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'disallowed_characters',
    });
  }
  if (hasSecretPattern(trimmed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'secret_pattern',
    });
  }
  if (trimmed.length > MAX_LOCATION_FIELD_CHARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'out_of_range',
    });
  }
}

export const savedUserLocationSchema = z
  .object({
    city: z.string(),
    region: z.string().optional(),
    country: z.string().optional(),
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateLocationTextField(val.city, true, ['city'], ctx);
    if (val.region !== undefined) {
      validateLocationTextField(val.region, false, ['region'], ctx);
    }
    if (val.country !== undefined) {
      validateLocationTextField(val.country, false, ['country'], ctx);
    }
    const hasLat = val.latitude !== undefined;
    const hasLon = val.longitude !== undefined;
    if (hasLat && !hasLon) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['longitude'],
        message: 'required',
      });
    } else if (!hasLat && hasLon) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['latitude'],
        message: 'required',
      });
    }
  })
  .transform((val): SavedUserLocation => {
    const out: SavedUserLocation = { city: val.city.trim() };
    if (val.region !== undefined) out.region = val.region.trim();
    if (val.country !== undefined) out.country = val.country.trim();
    if (val.latitude !== undefined && val.longitude !== undefined) {
      out.latitude = roundCoarseCoordinate(val.latitude);
      out.longitude = roundCoarseCoordinate(val.longitude);
    }
    return out;
  });

export const userPersonalizationSettingsSchema = z
  .object({
    warmth: personalizationAmplitudeSchema,
    enthusiasm: personalizationAmplitudeSchema,
    emoji: personalizationAmplitudeSchema,
    customInstructions: customInstructionsSchema,
    location: savedUserLocationSchema.nullable().default(null),
  })
  .strict();

export const reverseGeocodeRequestSchema = z
  .object({
    protocolVersion: z.literal(PERSONALIZATION_PROTOCOL_VERSION),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();

export type ReverseGeocodeRequest = z.infer<typeof reverseGeocodeRequestSchema>;

export const reverseGeocodeResponseSchema = z
  .object({
    protocolVersion: z.literal(PERSONALIZATION_PROTOCOL_VERSION),
    location: savedUserLocationSchema,
  })
  .strict();

export type ReverseGeocodeResponse = z.infer<typeof reverseGeocodeResponseSchema>;

export const storedUserPersonalizationSchema = z
  .object({
    schemaVersion: z.literal(PERSONALIZATION_SCHEMA_VERSION),
    userId: idSchema,
    settings: userPersonalizationSettingsSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    updatedAt: isoDateSchema,
  })
  .strict();

export type StoredUserPersonalization = z.infer<typeof storedUserPersonalizationSchema>;

export const personalizationPutRequestSchema = z
  .object({
    protocolVersion: z.literal(PERSONALIZATION_PROTOCOL_VERSION),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
    settings: userPersonalizationSettingsSchema,
  })
  .strict();

export type PersonalizationPutRequest = z.infer<typeof personalizationPutRequestSchema>;

export const personalizationResetRequestSchema = z
  .object({
    protocolVersion: z.literal(PERSONALIZATION_PROTOCOL_VERSION),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();

export type PersonalizationResetRequest = z.infer<typeof personalizationResetRequestSchema>;

export const personalizationResponseSchema = z
  .object({
    protocolVersion: z.literal(PERSONALIZATION_PROTOCOL_VERSION),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    settings: userPersonalizationSettingsSchema,
    isDefault: z.boolean(),
  })
  .strict();

export type PersonalizationResponse = z.infer<typeof personalizationResponseSchema>;

export type PersonalizationCasResult =
  | { outcome: 'confirmed'; record: StoredUserPersonalization }
  | { outcome: 'conflict'; currentRevision: number }
  | { outcome: 'uncertain' };

export interface UserPersonalizationRepository {
  read(userId: string): Promise<StoredUserPersonalization | null>;
  createIfAbsent(
    userId: string,
    settings: UserPersonalizationSettings,
    updatedAt: string,
  ): Promise<PersonalizationCasResult>;
  compareAndSwap(
    userId: string,
    expectedRevision: number,
    settings: UserPersonalizationSettings,
    updatedAt: string,
  ): Promise<PersonalizationCasResult>;
}

const FIELD_PATH_LOOKUP = new Set<string>(PERSONALIZATION_FIELD_PATHS);

function resolveFieldPath(issuePath: readonly (string | number)[]): PersonalizationFieldPath | null {
  const stringSegments = issuePath.filter((seg): seg is string => typeof seg === 'string');
  const locationIndex = stringSegments.indexOf('location');
  if (locationIndex !== -1) {
    const joined = stringSegments.slice(locationIndex).join('.');
    if (FIELD_PATH_LOOKUP.has(joined)) {
      return joined as PersonalizationFieldPath;
    }
    return 'location';
  }
  const last = stringSegments.at(-1);
  if (last && FIELD_PATH_LOOKUP.has(last)) {
    return last as PersonalizationFieldPath;
  }
  return null;
}

export function extractPersonalizationFieldErrors(
  issues: readonly z.ZodIssue[],
): PersonalizationFieldError[] {
  const errors: PersonalizationFieldError[] = [];
  const seen = new Set<string>();
  const add = (path: PersonalizationFieldPath, code: PersonalizationFieldErrorCode) => {
    const key = `${path}:${code}`;
    if (seen.has(key) || errors.length >= 10) return;
    seen.add(key);
    errors.push({ path, code });
  };
  for (const issue of issues) {
    const path = resolveFieldPath(issue.path);
    if (!path) continue;
    if (
      issue.code === z.ZodIssueCode.custom &&
      (issue.message === 'required' ||
        issue.message === 'disallowed_characters' ||
        issue.message === 'secret_pattern' ||
        issue.message === 'out_of_range')
    ) {
      add(path, issue.message);
    } else if (issue.code === z.ZodIssueCode.too_big || issue.code === z.ZodIssueCode.too_small) {
      add(path, 'out_of_range');
    } else if (
      issue.code === z.ZodIssueCode.invalid_type &&
      'received' in issue &&
      issue.received === 'undefined'
    ) {
      add(path, 'required');
    } else {
      add(path, 'invalid');
    }
  }
  return errors;
}
