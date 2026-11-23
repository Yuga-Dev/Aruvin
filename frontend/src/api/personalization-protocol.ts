/**
 * ============================================================================
 * FILE: personalization-protocol.ts
 * LOCATION: frontend/src/api/personalization-protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Mirror the /api/personalization wire protocol and validation rules.
 *
 * ROLE IN PROJECT:
 *    Provides browser-safe personalization types, default settings, input
 *    normalization, secret/control-char guards, and strict response parsers.
 *
 * KEY COMPONENTS:
 *    - PERSONALIZATION_ROUTES / DEFAULT_PERSONALIZATION_SETTINGS
 *    - SavedUserLocation / reverse-geocode request and response guards
 *    - validateCustomInstructions / isPersonalizationResponse / isPersonalizationErrorBody
 * ============================================================================
 */

export const PERSONALIZATION_PROTOCOL_VERSION = 1 as const;
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 1500;
export const MAX_CUSTOM_INSTRUCTIONS_BYTES = 6000;
export const MAX_LOCATION_FIELD_CHARS = 100;
export const MAX_PERSONALIZATION_BODY_BYTES = 16_384;

export const PERSONALIZATION_ROUTES = {
  root: '/personalization',
  reset: '/personalization/reset',
  reverseGeocode: '/personalization/reverse-geocode',
} as const;

export const PERSONALIZATION_AMPLITUDES = ['low', 'medium', 'high'] as const;
export type PersonalizationAmplitude = (typeof PERSONALIZATION_AMPLITUDES)[number];

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

export type PersonalizationResponse = {
  protocolVersion: 1;
  revision: number;
  settings: UserPersonalizationSettings;
  isDefault: boolean;
};

export type PersonalizationPutRequest = {
  protocolVersion: 1;
  expectedRevision: number;
  settings: UserPersonalizationSettings;
};

export type PersonalizationResetRequest = {
  protocolVersion: 1;
  expectedRevision: number;
};

export type ReverseGeocodeRequest = {
  protocolVersion: 1;
  latitude: number;
  longitude: number;
};

export type ReverseGeocodeResponse = {
  protocolVersion: 1;
  location: SavedUserLocation;
};

export const PERSONALIZATION_SECRET_PATTERN =
  /sk-or-v1-|mongodb(?:\+srv)?:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,}|(?:OPENROUTER_API_KEY|MONGODB_URI)\s*[:=]/iu;

export function normalizeCustomInstructions(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
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

export function hasLocationControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function hasSecretPattern(text: string): boolean {
  return PERSONALIZATION_SECRET_PATTERN.test(text);
}

export function roundCoarseCoordinate(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function validateCustomInstructions(raw: string): {
  normalized: string;
  error: 'disallowed_characters' | 'secret_pattern' | 'out_of_range' | null;
} {
  const normalized = normalizeCustomInstructions(raw);
  if (hasDisallowedControlChars(normalized)) {
    return { normalized, error: 'disallowed_characters' };
  }
  if (hasSecretPattern(normalized)) {
    return { normalized, error: 'secret_pattern' };
  }
  if (
    normalized.length > MAX_CUSTOM_INSTRUCTIONS_CHARS ||
    utf8ByteLength(normalized) > MAX_CUSTOM_INSTRUCTIONS_BYTES
  ) {
    return { normalized, error: 'out_of_range' };
  }
  return { normalized, error: null };
}

export function validateLocationText(
  raw: string,
  required: boolean,
): {
  normalized: string;
  error: 'required' | 'disallowed_characters' | 'secret_pattern' | 'out_of_range' | null;
} {
  const normalized = raw.trim();
  if (normalized.length === 0) {
    return { normalized, error: required ? 'required' : null };
  }
  if (hasLocationControlChars(normalized)) {
    return { normalized, error: 'disallowed_characters' };
  }
  if (hasSecretPattern(normalized)) {
    return { normalized, error: 'secret_pattern' };
  }
  if (normalized.length > MAX_LOCATION_FIELD_CHARS) {
    return { normalized, error: 'out_of_range' };
  }
  return { normalized, error: null };
}

export function normalizeSavedLocation(
  location: SavedUserLocation | null,
): SavedUserLocation | null {
  if (!location) return null;
  const city = location.city.trim();
  const region = location.region?.trim() ?? '';
  const country = location.country?.trim() ?? '';
  if (!city && !region && !country) return null;
  const out: SavedUserLocation = { city };
  if (region) out.region = region;
  if (country) out.country = country;
  if (location.latitude !== undefined || location.longitude !== undefined) {
    if (location.latitude !== undefined) {
      out.latitude = Number.isFinite(location.latitude)
        ? roundCoarseCoordinate(location.latitude)
        : location.latitude;
    }
    if (location.longitude !== undefined) {
      out.longitude = Number.isFinite(location.longitude)
        ? roundCoarseCoordinate(location.longitude)
        : location.longitude;
    }
  }
  return out;
}

export function isDefaultPersonalization(settings: UserPersonalizationSettings): boolean {
  return (
    settings.warmth === 'medium' &&
    settings.enthusiasm === 'medium' &&
    settings.emoji === 'medium' &&
    normalizeCustomInstructions(settings.customInstructions) === '' &&
    normalizeSavedLocation(settings.location) === null
  );
}

const AMPLITUDE_SET = new Set<string>(PERSONALIZATION_AMPLITUDES);
const ERROR_CODE_SET = new Set<string>(PERSONALIZATION_ERROR_CODES);
const FIELD_PATH_SET = new Set<string>(PERSONALIZATION_FIELD_PATHS);
const FIELD_ERROR_CODE_SET = new Set<string>(PERSONALIZATION_FIELD_ERROR_CODES);
const LOCATION_KEYS = new Set<string>(['city', 'region', 'country', 'latitude', 'longitude']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}

export function isPersonalizationAmplitude(value: unknown): value is PersonalizationAmplitude {
  return typeof value === 'string' && AMPLITUDE_SET.has(value);
}

export function isSavedUserLocation(value: unknown): value is SavedUserLocation {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!LOCATION_KEYS.has(key)) return false;
  }
  if (typeof value.city !== 'string') return false;
  if (validateLocationText(value.city, true).error !== null) return false;
  if (value.region !== undefined) {
    if (typeof value.region !== 'string' || value.region.trim().length === 0) return false;
    if (validateLocationText(value.region, false).error !== null) return false;
  }
  if (value.country !== undefined) {
    if (typeof value.country !== 'string' || value.country.trim().length === 0) return false;
    if (validateLocationText(value.country, false).error !== null) return false;
  }
  const hasLat = value.latitude !== undefined;
  const hasLon = value.longitude !== undefined;
  if (hasLat !== hasLon) return false;
  if (hasLat && hasLon) {
    if (
      typeof value.latitude !== 'number' ||
      !Number.isFinite(value.latitude) ||
      value.latitude < -90 ||
      value.latitude > 90
    ) {
      return false;
    }
    if (
      typeof value.longitude !== 'number' ||
      !Number.isFinite(value.longitude) ||
      value.longitude < -180 ||
      value.longitude > 180
    ) {
      return false;
    }
  }
  return true;
}

export function isPersonalizationSettings(value: unknown): value is UserPersonalizationSettings {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, ['warmth', 'enthusiasm', 'emoji', 'customInstructions', 'location'])) {
    return false;
  }
  if (
    !isPersonalizationAmplitude(value.warmth) ||
    !isPersonalizationAmplitude(value.enthusiasm) ||
    !isPersonalizationAmplitude(value.emoji)
  ) {
    return false;
  }
  if (typeof value.customInstructions !== 'string') return false;
  if (validateCustomInstructions(value.customInstructions).error !== null) return false;
  return value.location === null || isSavedUserLocation(value.location);
}

export function isPersonalizationResponse(value: unknown): value is PersonalizationResponse {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, ['protocolVersion', 'revision', 'settings', 'isDefault'])) return false;
  if (value.protocolVersion !== PERSONALIZATION_PROTOCOL_VERSION) return false;
  if (
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return false;
  }
  if (!isPersonalizationSettings(value.settings)) return false;
  return typeof value.isDefault === 'boolean';
}

export function isReverseGeocodeResponse(value: unknown): value is ReverseGeocodeResponse {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, ['protocolVersion', 'location'])) return false;
  if (value.protocolVersion !== PERSONALIZATION_PROTOCOL_VERSION) return false;
  return isSavedUserLocation(value.location);
}

export function isPersonalizationErrorBody(value: unknown): value is PersonalizationErrorBody {
  if (!isRecord(value)) return false;
  if (value.protocolVersion !== PERSONALIZATION_PROTOCOL_VERSION || !isRecord(value.error)) {
    return false;
  }
  const err = value.error;
  if (typeof err.code !== 'string' || !ERROR_CODE_SET.has(err.code)) return false;
  if (typeof err.message !== 'string') return false;
  if (typeof err.retryable !== 'boolean') return false;
  if (
    err.currentRevision !== null &&
    (typeof err.currentRevision !== 'number' ||
      !Number.isSafeInteger(err.currentRevision) ||
      err.currentRevision < 0)
  ) {
    return false;
  }
  if (!Array.isArray(err.fieldErrors)) return false;
  return err.fieldErrors.every(
    item =>
      isRecord(item) &&
      typeof item.path === 'string' &&
      FIELD_PATH_SET.has(item.path) &&
      typeof item.code === 'string' &&
      FIELD_ERROR_CODE_SET.has(item.code),
  );
}
