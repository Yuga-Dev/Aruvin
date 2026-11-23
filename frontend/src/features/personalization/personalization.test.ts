/**
 * ============================================================================
 * FILE: personalization.test.ts
 * LOCATION: frontend/src/features/personalization/personalization.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify frontend personalization protocol, HTTP client, state reducer,
 *    EmotionSlider accessibility, PersonalizationPanel SSR, and dashboard wiring.
 *
 * ROLE IN PROJECT:
 *    Exercises AC1 and AC2 behaviors cleanly in Vitest's Node test environment.
 *
 * KEY COMPONENTS:
 *    - Protocol validation & secret/control-char rejection tests.
 *    - Client GET/PUT/POST reset, 409 conflict, and bounded JSON tests.
 *    - Reducer dirty/discard/reset/conflict transitions & SSR component checks.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  createPersonalizationClient,
  PersonalizationClientError,
} from '../../api/personalization-client.ts';
import {
  defaultPersonalizationSettings,
  isDefaultPersonalization,
  isPersonalizationResponse,
  isReverseGeocodeResponse,
  isSavedUserLocation,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_LOCATION_FIELD_CHARS,
  normalizeCustomInstructions,
  normalizeSavedLocation,
  roundCoarseCoordinate,
  validateCustomInstructions,
  validateLocationText,
} from '../../api/personalization-protocol.ts';
import { BrowserGeolocationError, requestBrowserCoordinates } from './browser-geolocation.ts';
import { EmotionSlider } from './EmotionSlider.tsx';
import { LocationCard } from './LocationCard.tsx';
import { PersonalizationPanel } from './PersonalizationPanel.tsx';
import {
  canResetToDefaults,
  clientInstructionsValidationError,
  clientLocationValidationError,
  clientValidationError,
  initialPersonalizationState,
  isPersonalizationDirty,
  personalizationReducer,
} from './personalization-state.ts';

describe('personalization protocol & client', () => {
  it('validates customInstructions normalization, char/byte limits, control chars, and secrets', () => {
    expect(normalizeCustomInstructions('  hello\r\nworld  ')).toBe('hello\nworld');
    expect(validateCustomInstructions('ok\ttext\nline2').error).toBeNull();
    expect(validateCustomInstructions('bad\u0007text').error).toBe('disallowed_characters');
    expect(validateCustomInstructions('key is sk-or-v1-secret123').error).toBe('secret_pattern');
    expect(validateCustomInstructions('uri mongodb+srv://u:p@h/db').error).toBe('secret_pattern');
    expect(
      validateCustomInstructions('a'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS + 1)).error,
    ).toBe('out_of_range');
    expect(isDefaultPersonalization(defaultPersonalizationSettings())).toBe(true);
    expect(
      isDefaultPersonalization({
        warmth: 'medium',
        enthusiasm: 'medium',
        emoji: 'medium',
        customInstructions: '   ',
        location: null,
      }),
    ).toBe(true);
  });

  it('validates SavedUserLocation bounds, coarse rounding, pair rule, defaults, and reverse-geocode response shape', () => {
    expect(defaultPersonalizationSettings().location).toBeNull();
    expect(roundCoarseCoordinate(30.267153)).toBe(30.27);
    expect(Object.is(roundCoarseCoordinate(-0.001), 0)).toBe(true);

    expect(validateLocationText('  Austin  ', true)).toEqual({ normalized: 'Austin', error: null });
    expect(validateLocationText('   ', true).error).toBe('required');
    expect(validateLocationText('a'.repeat(MAX_LOCATION_FIELD_CHARS + 1), true).error).toBe(
      'out_of_range',
    );
    expect(validateLocationText('Austin\nTX', true).error).toBe('disallowed_characters');
    expect(validateLocationText('sk-or-v1-secret123', true).error).toBe('secret_pattern');

    expect(
      normalizeSavedLocation({
        city: '  Austin ',
        region: '  ',
        country: ' United States ',
        latitude: 30.267153,
        longitude: -97.743061,
      }),
    ).toEqual({
      city: 'Austin',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    });
    expect(normalizeSavedLocation({ city: '  ', region: '', country: '' })).toBeNull();

    expect(isSavedUserLocation({ city: 'Austin' })).toBe(true);
    expect(isSavedUserLocation({ city: 'Austin', latitude: 30.27 })).toBe(false);
    expect(isSavedUserLocation({ city: 'Austin', latitude: 91, longitude: 0 })).toBe(false);
    expect(isSavedUserLocation({ city: 'Austin', extra: 'nope' })).toBe(false);

    expect(
      isDefaultPersonalization({
        ...defaultPersonalizationSettings(),
        location: { city: 'Austin' },
      }),
    ).toBe(false);

    expect(
      isPersonalizationResponse({
        protocolVersion: 1,
        revision: 1,
        settings: { ...defaultPersonalizationSettings(), location: { city: 'Austin' } },
        isDefault: false,
      }),
    ).toBe(true);

    expect(
      isReverseGeocodeResponse({
        protocolVersion: 1,
        location: { city: 'Austin', region: 'Texas', latitude: 30.27, longitude: -97.74 },
      }),
    ).toBe(true);
    expect(
      isReverseGeocodeResponse({
        protocolVersion: 1,
        location: null,
      }),
    ).toBe(false);
  });

  it('calls GET, PUT, and POST /personalization/reset with expected schemas and surfaces 409 conflicts', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createPersonalizationClient({ baseUrl: '/api', fetch: fetcher });

    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          revision: 0,
          settings: defaultPersonalizationSettings(),
          isDefault: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const readRes = await client.read();
    expect(readRes.revision).toBe(0);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/personalization');

    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          revision: 1,
          settings: {
            warmth: 'high',
            enthusiasm: 'medium',
            emoji: 'low',
            customInstructions: 'Concise bullets.',
            location: null,
          },
          isDefault: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const saveRes = await client.save({
      protocolVersion: 1,
      expectedRevision: 0,
      settings: {
        warmth: 'high',
        enthusiasm: 'medium',
        emoji: 'low',
        customInstructions: '  Concise bullets.  ',
        location: null,
      },
    });
    expect(saveRes.revision).toBe(1);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      protocolVersion: 1,
      expectedRevision: 0,
      settings: {
        warmth: 'high',
        enthusiasm: 'medium',
        emoji: 'low',
        customInstructions: 'Concise bullets.',
        location: null,
      },
    });

    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          error: {
            code: 'PERSONALIZATION_CONFLICT',
            message: 'Settings were updated elsewhere.',
            retryable: false,
            currentRevision: 2,
            fieldErrors: [],
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    let caught: unknown;
    try {
      await client.reset({ protocolVersion: 1, expectedRevision: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersonalizationClientError);
    expect(caught).toMatchObject({
      code: 'PERSONALIZATION_CONFLICT',
      status: 409,
      currentRevision: 2,
    });
    expect(fetcher.mock.calls[2]?.[0]).toBe('/api/personalization/reset');
  });

  it('calls POST /personalization/reverse-geocode, validates coordinates client-side, and surfaces LOCATION_UNAVAILABLE', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createPersonalizationClient({ baseUrl: '/api', fetch: fetcher });

    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          location: {
            city: 'Austin',
            region: 'Texas',
            country: 'United States',
            latitude: 30.27,
            longitude: -97.74,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const detected = await client.reverseGeocode({
      protocolVersion: 1,
      latitude: 30.267153,
      longitude: -97.743061,
    });
    expect(detected.location).toEqual({
      city: 'Austin',
      region: 'Texas',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/personalization/reverse-geocode');

    // Out-of-range latitude fails closed before network.
    await expect(
      client.reverseGeocode({ protocolVersion: 1, latitude: 95, longitude: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_PERSONALIZATION_REQUEST' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // 503 LOCATION_UNAVAILABLE maps to closed PersonalizationClientError.
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          error: {
            code: 'LOCATION_UNAVAILABLE',
            message: 'Location could not be determined right now. You can enter your city manually.',
            retryable: true,
            currentRevision: null,
            fieldErrors: [],
          },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(
      client.reverseGeocode({ protocolVersion: 1, latitude: 30.27, longitude: -97.74 }),
    ).rejects.toMatchObject({
      code: 'LOCATION_UNAVAILABLE',
      status: 503,
      retryable: true,
    });
  });
});

describe('browser geolocation helper', () => {
  it('calls getCurrentPosition once with low-accuracy options and classifies browser errors cleanly', async () => {
    const getCurrentPosition = vi.fn<Geolocation['getCurrentPosition']>((success, _error, opts) => {
      expect(opts).toEqual({ enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 });
      success({
        coords: { latitude: 30.267, longitude: -97.743 },
      } as GeolocationPosition);
    });

    const coords = await requestBrowserCoordinates({ getCurrentPosition });
    expect(coords).toEqual({ latitude: 30.267, longitude: -97.743 });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);

    await expect(requestBrowserCoordinates(null)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });

    const denied = vi.fn<Geolocation['getCurrentPosition']>((_ok, fail) => {
      fail?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    await expect(requestBrowserCoordinates({ getCurrentPosition: denied })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });

    const timedOut = vi.fn<Geolocation['getCurrentPosition']>((_ok, fail) => {
      fail?.({ code: 3, message: 'timeout' } as GeolocationPositionError);
    });
    await expect(requestBrowserCoordinates({ getCurrentPosition: timedOut })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    const unavailable = vi.fn<Geolocation['getCurrentPosition']>((_ok, fail) => {
      fail?.({ code: 2, message: 'unavailable' } as GeolocationPositionError);
    });
    const caught = await requestBrowserCoordinates({ getCurrentPosition: unavailable }).catch(
      err => err,
    );
    expect(caught).toBeInstanceOf(BrowserGeolocationError);
    expect((caught as BrowserGeolocationError).code).toBe('POSITION_UNAVAILABLE');
  });
});

describe('personalization state reducer', () => {
  it('tracks dirty state, discard, reset eligibility, validation, and CAS conflicts', () => {
    let state = initialPersonalizationState();
    expect(isPersonalizationDirty(state)).toBe(false);
    expect(canResetToDefaults(state)).toBe(false);

    state = personalizationReducer(state, {
      type: 'loaded',
      response: {
        protocolVersion: 1,
        revision: 0,
        settings: defaultPersonalizationSettings(),
        isDefault: true,
      },
    });
    expect(isPersonalizationDirty(state)).toBe(false);
    expect(canResetToDefaults(state)).toBe(false);

    // Whitespace-only edit matches trimmed baseline so dirty stays false
    state = personalizationReducer(state, { type: 'setCustomInstructions', value: '   ' });
    expect(isPersonalizationDirty(state)).toBe(false);

    // Changing warmth enables dirty & reset-to-defaults
    state = personalizationReducer(state, { type: 'setAmplitude', field: 'warmth', value: 'high' });
    expect(isPersonalizationDirty(state)).toBe(true);
    expect(canResetToDefaults(state)).toBe(true);

    // Discard restores baseline cleanly
    state = personalizationReducer(state, { type: 'discard' });
    expect(isPersonalizationDirty(state)).toBe(false);
    expect(state.draft.warmth).toBe('medium');

    // Secret validation error caught cleanly
    state = personalizationReducer(state, {
      type: 'setCustomInstructions',
      value: 'sk-or-v1-abc12345',
    });
    expect(clientValidationError(state.draft)).toContain('API keys');

    // Conflict sets conflictRevision cleanly
    state = personalizationReducer(state, { type: 'begin', kind: 'saving' });
    state = personalizationReducer(state, {
      type: 'failed',
      code: 'PERSONALIZATION_CONFLICT',
      message: 'Conflict',
      currentRevision: 4,
    });
    expect(state.conflictRevision).toBe(4);
    expect(canResetToDefaults(state)).toBe(false);
  });

  it('handles location detection, clears stale coordinates on manual edits, validates location, and tracks dirty/reset state', () => {
    let state = initialPersonalizationState();
    state = personalizationReducer(state, {
      type: 'loaded',
      response: {
        protocolVersion: 1,
        revision: 1,
        settings: defaultPersonalizationSettings(),
        isDefault: true,
      },
    });

    // Begin detecting locks busy state, then locationDetected populates draft with coarse coords.
    state = personalizationReducer(state, { type: 'begin', kind: 'detecting' });
    expect(state.busy).toBe('detecting');
    state = personalizationReducer(state, {
      type: 'locationDetected',
      location: {
        city: 'Austin',
        region: 'Texas',
        country: 'United States',
        latitude: 30.27,
        longitude: -97.74,
      },
      statusMessage: 'Location detected. Review and click Save to keep it.',
    });
    expect(state.busy).toBeNull();
    expect(state.draft.location).toEqual({
      city: 'Austin',
      region: 'Texas',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    });
    expect(isPersonalizationDirty(state)).toBe(true);
    expect(canResetToDefaults(state)).toBe(true);
    expect(clientLocationValidationError(state.draft.location)).toBeNull();

    // Manually editing city/region/country clears stale latitude & longitude.
    state = personalizationReducer(state, {
      type: 'setLocationField',
      field: 'city',
      value: 'Dallas',
    });
    expect(state.draft.location).toEqual({
      city: 'Dallas',
      region: 'Texas',
      country: 'United States',
    });
    expect(state.draft.location?.latitude).toBeUndefined();
    expect(state.draft.location?.longitude).toBeUndefined();

    // Clearing city while region remains triggers client location validation error.
    state = personalizationReducer(state, {
      type: 'setLocationField',
      field: 'city',
      value: '',
    });
    expect(clientLocationValidationError(state.draft.location)).toContain('City is required');
    expect(clientValidationError(state.draft)).toContain('City is required');

    // Clear location collapses draft.location back to null cleanly.
    state = personalizationReducer(state, { type: 'clearLocation' });
    expect(state.draft.location).toBeNull();
    expect(isPersonalizationDirty(state)).toBe(false);
    expect(clientLocationValidationError(state.draft.location)).toBeNull();

    // Failed geolocation detection clears busy and records locationError without blocking edits.
    state = personalizationReducer(state, { type: 'begin', kind: 'detecting' });
    state = personalizationReducer(state, {
      type: 'detectLocationFailed',
      message: 'Location access was denied. You can enter your city manually.',
    });
    expect(state.busy).toBeNull();
    expect(state.locationError).toContain('Location access was denied');
    state = personalizationReducer(state, {
      type: 'setLocationField',
      field: 'city',
      value: 'Denver',
    });
    expect(state.locationError).toBeNull();
    expect(state.draft.location).toEqual({ city: 'Denver' });
    expect(clientInstructionsValidationError(state.draft.customInstructions)).toBeNull();
  });
});

describe('EmotionSlider & PersonalizationPanel rendering', () => {
  it('renders accessible ARIA slider semantics and three labeled preset stops', () => {
    const html = renderToStaticMarkup(
      createElement(EmotionSlider, {
        id: 'warmth-slider',
        label: 'Warmth',
        description: 'Kind, approachable, and supportive tone',
        value: 'medium',
        onChange: () => undefined,
      }),
    );

    expect(html).toContain('Warmth');
    expect(html).toContain('Kind, approachable, and supportive tone');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="2"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('aria-valuetext="Medium (Default)"');
    expect(html).toContain('>Low<');
    expect(html).toContain('>Medium (Default)<');
    expect(html).toContain('>High<');
  });

  it('renders LocationCard inputs, Detect my location button, conditional Clear location, coarse coords, and accessible alert', () => {
    const emptyHtml = renderToStaticMarkup(
      createElement(LocationCard, {
        idPrefix: 'loc',
        location: null,
        disabled: false,
        detecting: false,
        error: null,
        onFieldChange: () => undefined,
        onDetect: () => undefined,
        onClear: () => undefined,
      }),
    );
    expect(emptyHtml).toContain('Location');
    expect(emptyHtml).toContain('City');
    expect(emptyHtml).toContain('Region / State');
    expect(emptyHtml).toContain('Country');
    expect(emptyHtml).toContain('Detect my location');
    expect(emptyHtml).not.toContain('Clear location');

    const populatedHtml = renderToStaticMarkup(
      createElement(LocationCard, {
        idPrefix: 'loc',
        location: {
          city: 'Austin',
          region: 'Texas',
          country: 'United States',
          latitude: 30.27,
          longitude: -97.74,
        },
        disabled: false,
        detecting: true,
        error: 'Location access was denied.',
        onFieldChange: () => undefined,
        onDetect: () => undefined,
        onClear: () => undefined,
      }),
    );
    expect(populatedHtml).toContain('value="Austin"');
    expect(populatedHtml).toContain('value="Texas"');
    expect(populatedHtml).toContain('value="United States"');
    expect(populatedHtml).toContain('Detecting…');
    expect(populatedHtml).toContain('Clear location');
    expect(populatedHtml).toContain('30.27, -97.74');
    expect(populatedHtml).toContain('role="alert"');
    expect(populatedHtml).toContain('Location access was denied.');
  });

  it('renders PersonalizationPanel heading and loading indicator before hydration', () => {
    const client = createPersonalizationClient({
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    });
    const html = renderToStaticMarkup(createElement(PersonalizationPanel, { client }));
    expect(html).toContain('Personalization');
    expect(html).toContain('Loading personalization settings');
  });
});
