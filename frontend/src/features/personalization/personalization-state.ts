/**
 * ============================================================================
 * FILE: personalization-state.ts
 * LOCATION: frontend/src/features/personalization/personalization-state.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Pure reducer and validation selectors for user personalization editing.
 *
 * ROLE IN PROJECT:
 *    Manages draft/baseline diffs, revision CAS state, dirty/busy tracking,
 *    location detection, and client-side validation independent of React DOM.
 *
 * KEY COMPONENTS:
 *    - personalizationReducer: Load, edit, detect location, begin/succeed/fail, discard.
 *    - isPersonalizationDirty / canResetToDefaults / clientValidationError
 *    - clientLocationValidationError / clientInstructionsValidationError
 * ============================================================================
 */

import {
  clonePersonalizationSettings,
  defaultPersonalizationSettings,
  isDefaultPersonalization,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_LOCATION_FIELD_CHARS,
  normalizeCustomInstructions,
  normalizeSavedLocation,
  validateCustomInstructions,
  validateLocationText,
  type PersonalizationAmplitude,
  type PersonalizationErrorCode,
  type PersonalizationFieldError,
  type PersonalizationResponse,
  type SavedUserLocation,
  type UserPersonalizationSettings,
} from '../../api/personalization-protocol.ts';

export type PersonalizationPhase = 'loading' | 'ready' | 'unavailable';
export type PersonalizationBusy = 'saving' | 'resetting' | 'detecting' | null;
export type LocationTextField = 'city' | 'region' | 'country';

export type PersonalizationState = {
  phase: PersonalizationPhase;
  revision: number;
  baseline: UserPersonalizationSettings;
  draft: UserPersonalizationSettings;
  busy: PersonalizationBusy;
  conflictRevision: number | null;
  statusMessage: string | null;
  errorMessage: string | null;
  locationError: string | null;
  fieldErrors: PersonalizationFieldError[];
};

export type PersonalizationAction =
  | { type: 'loading' }
  | { type: 'loaded'; response: PersonalizationResponse; statusMessage?: string | null }
  | { type: 'loadFailed'; message: string }
  | { type: 'setAmplitude'; field: 'warmth' | 'enthusiasm' | 'emoji'; value: PersonalizationAmplitude }
  | { type: 'setCustomInstructions'; value: string }
  | { type: 'setLocationField'; field: LocationTextField; value: string }
  | { type: 'locationDetected'; location: SavedUserLocation; statusMessage: string }
  | { type: 'detectLocationFailed'; message: string }
  | { type: 'clearLocation' }
  | { type: 'discard' }
  | { type: 'begin'; kind: Exclude<PersonalizationBusy, null> }
  | {
      type: 'failed';
      code?: PersonalizationErrorCode | string;
      message: string;
      currentRevision?: number | null;
      fieldErrors?: PersonalizationFieldError[];
    };

export function initialPersonalizationState(): PersonalizationState {
  const defaults = defaultPersonalizationSettings();
  return {
    phase: 'loading',
    revision: 0,
    baseline: clonePersonalizationSettings(defaults),
    draft: clonePersonalizationSettings(defaults),
    busy: null,
    conflictRevision: null,
    statusMessage: null,
    errorMessage: null,
    locationError: null,
    fieldErrors: [],
  };
}

function locationsEqual(a: SavedUserLocation | null, b: SavedUserLocation | null): boolean {
  const normA = normalizeSavedLocation(a);
  const normB = normalizeSavedLocation(b);
  if (normA === null && normB === null) return true;
  if (normA === null || normB === null) return false;
  return (
    normA.city === normB.city &&
    normA.region === normB.region &&
    normA.country === normB.country &&
    normA.latitude === normB.latitude &&
    normA.longitude === normB.longitude
  );
}

export function isPersonalizationDirty(state: PersonalizationState): boolean {
  if (state.phase !== 'ready') return false;
  return (
    state.draft.warmth !== state.baseline.warmth ||
    state.draft.enthusiasm !== state.baseline.enthusiasm ||
    state.draft.emoji !== state.baseline.emoji ||
    normalizeCustomInstructions(state.draft.customInstructions) !==
      normalizeCustomInstructions(state.baseline.customInstructions) ||
    !locationsEqual(state.draft.location, state.baseline.location)
  );
}

export function canResetToDefaults(state: PersonalizationState): boolean {
  if (state.phase !== 'ready' || state.busy !== null || state.conflictRevision !== null) {
    return false;
  }
  return !isDefaultPersonalization(state.draft) || !isDefaultPersonalization(state.baseline);
}

export function clientInstructionsValidationError(customInstructions: string): string | null {
  if (customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
    return `Custom instructions must be ${MAX_CUSTOM_INSTRUCTIONS_CHARS} characters or fewer.`;
  }
  const checked = validateCustomInstructions(customInstructions);
  if (checked.error === 'disallowed_characters') {
    return 'Custom instructions contain unsupported control characters.';
  }
  if (checked.error === 'secret_pattern') {
    return 'Custom instructions cannot contain API keys, tokens, or connection strings.';
  }
  if (checked.error === 'out_of_range') {
    return `Custom instructions must fit within ${MAX_CUSTOM_INSTRUCTIONS_CHARS} characters and 6000 UTF-8 bytes.`;
  }
  return null;
}

export function clientLocationValidationError(location: SavedUserLocation | null): string | null {
  if (location === null) return null;
  const cityRaw = location.city ?? '';
  const regionRaw = location.region ?? '';
  const countryRaw = location.country ?? '';
  if (!cityRaw.trim() && !regionRaw.trim() && !countryRaw.trim()) {
    return null;
  }
  const cityCheck = validateLocationText(cityRaw, true);
  if (cityCheck.error === 'required') {
    return 'City is required when setting a location.';
  }
  if (cityCheck.error === 'disallowed_characters') {
    return 'City contains unsupported control characters.';
  }
  if (cityCheck.error === 'secret_pattern') {
    return 'Location fields cannot contain API keys, tokens, or connection strings.';
  }
  if (cityCheck.error === 'out_of_range') {
    return `City must be ${MAX_LOCATION_FIELD_CHARS} characters or fewer.`;
  }

  for (const [label, value] of [
    ['Region / State', regionRaw],
    ['Country', countryRaw],
  ] as const) {
    const check = validateLocationText(value, false);
    if (check.error === 'disallowed_characters') {
      return `${label} contains unsupported control characters.`;
    }
    if (check.error === 'secret_pattern') {
      return 'Location fields cannot contain API keys, tokens, or connection strings.';
    }
    if (check.error === 'out_of_range') {
      return `${label} must be ${MAX_LOCATION_FIELD_CHARS} characters or fewer.`;
    }
  }
  return null;
}

export function clientValidationError(draft: UserPersonalizationSettings): string | null {
  return (
    clientInstructionsValidationError(draft.customInstructions) ??
    clientLocationValidationError(draft.location)
  );
}

export function describeFieldError(error: PersonalizationFieldError): string {
  const isLocationField =
    error.path === 'location' || error.path.startsWith('location.');
  switch (error.code) {
    case 'secret_pattern':
      return isLocationField
        ? 'Location fields cannot contain API keys, tokens, or connection strings.'
        : 'Custom instructions cannot contain API keys, tokens, or connection strings.';
    case 'disallowed_characters':
      return 'Contains unsupported control characters.';
    case 'out_of_range':
      return isLocationField
        ? `Location fields must be ${MAX_LOCATION_FIELD_CHARS} characters or fewer.`
        : `Must be within ${MAX_CUSTOM_INSTRUCTIONS_CHARS} characters and 6000 UTF-8 bytes.`;
    case 'required':
      return error.path === 'location.city'
        ? 'City is required when setting a location.'
        : 'This setting is required.';
    default:
      return 'Invalid setting value.';
  }
}

function updateDraftLocationField(
  current: SavedUserLocation | null,
  field: LocationTextField,
  value: string,
): SavedUserLocation | null {
  const nextCity = field === 'city' ? value : (current?.city ?? '');
  const nextRegion = field === 'region' ? value : (current?.region ?? '');
  const nextCountry = field === 'country' ? value : (current?.country ?? '');
  if (nextCity === '' && nextRegion === '' && nextCountry === '') {
    return null;
  }
  // Manual text edits intentionally drop stale latitude/longitude so downstream
  // weather geocoding resolves the newly typed city cleanly.
  const next: SavedUserLocation = { city: nextCity };
  if (nextRegion !== '') next.region = nextRegion;
  if (nextCountry !== '') next.country = nextCountry;
  return next;
}

function clearLocationFieldErrors(
  errors: readonly PersonalizationFieldError[],
): PersonalizationFieldError[] {
  return errors.filter(e => e.path !== 'location' && !e.path.startsWith('location.'));
}

export function personalizationReducer(
  state: PersonalizationState,
  action: PersonalizationAction,
): PersonalizationState {
  switch (action.type) {
    case 'loading':
      return {
        ...state,
        phase: 'loading',
        busy: null,
        conflictRevision: null,
        errorMessage: null,
        locationError: null,
        fieldErrors: [],
      };
    case 'loaded':
      return {
        phase: 'ready',
        revision: action.response.revision,
        baseline: clonePersonalizationSettings(action.response.settings),
        draft: clonePersonalizationSettings(action.response.settings),
        busy: null,
        conflictRevision: null,
        statusMessage: action.statusMessage ?? null,
        errorMessage: null,
        locationError: null,
        fieldErrors: [],
      };
    case 'loadFailed':
      return {
        ...state,
        phase: 'unavailable',
        busy: null,
        statusMessage: null,
        errorMessage: action.message,
        locationError: null,
      };
    case 'setAmplitude':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        draft: { ...state.draft, [action.field]: action.value },
        statusMessage: null,
        errorMessage: null,
        fieldErrors: state.fieldErrors.filter(e => e.path !== action.field),
      };
    case 'setCustomInstructions':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        draft: { ...state.draft, customInstructions: action.value },
        statusMessage: null,
        errorMessage: null,
        fieldErrors: state.fieldErrors.filter(e => e.path !== 'customInstructions'),
      };
    case 'setLocationField':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          location: updateDraftLocationField(state.draft.location, action.field, action.value),
        },
        statusMessage: null,
        errorMessage: null,
        locationError: null,
        fieldErrors: clearLocationFieldErrors(state.fieldErrors),
      };
    case 'locationDetected':
      if (state.phase !== 'ready') return state;
      return {
        ...state,
        busy: null,
        draft: {
          ...state.draft,
          location: { ...action.location },
        },
        statusMessage: action.statusMessage,
        errorMessage: null,
        locationError: null,
        fieldErrors: clearLocationFieldErrors(state.fieldErrors),
      };
    case 'detectLocationFailed':
      if (state.phase !== 'ready') return state;
      return {
        ...state,
        busy: null,
        locationError: action.message,
      };
    case 'clearLocation':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        draft: { ...state.draft, location: null },
        statusMessage: null,
        errorMessage: null,
        locationError: null,
        fieldErrors: clearLocationFieldErrors(state.fieldErrors),
      };
    case 'discard':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        draft: clonePersonalizationSettings(state.baseline),
        statusMessage: 'Discarded unsaved personalization edits.',
        errorMessage: null,
        locationError: null,
        fieldErrors: [],
      };
    case 'begin':
      if (state.phase !== 'ready' || state.busy !== null || state.conflictRevision !== null) {
        return state;
      }
      return {
        ...state,
        busy: action.kind,
        statusMessage: null,
        errorMessage: null,
        locationError: action.kind === 'detecting' ? null : state.locationError,
        fieldErrors: [],
      };
    case 'failed':
      return {
        ...state,
        busy: null,
        conflictRevision:
          action.code === 'PERSONALIZATION_CONFLICT'
            ? (action.currentRevision ?? state.revision)
            : state.conflictRevision,
        errorMessage: action.message,
        fieldErrors: action.fieldErrors ?? [],
      };
    default:
      return state;
  }
}
