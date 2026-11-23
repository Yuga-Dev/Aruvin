/**
 * ============================================================================
 * FILE: reverse-geocode.spec.ts
 * LOCATION: backend/test/personalization/reverse-geocode.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify bounded OpenStreetMap Nominatim reverse-geocoding behavior.
 *
 * ROLE IN PROJECT:
 *    Proves coarse 2-decimal coordinate rounding, required User-Agent header,
 *    address fallback order, timeout/byte-cap guards, and closed fault mapping
 *    without touching the live network.
 *
 * KEY COMPONENTS:
 *    - reverseGeocodeNominatim unit tests using deterministic fetch doubles.
 * ============================================================================
 */

import { PersonalizationFault } from '../../src/personalization/errors.js';
import {
  MAX_REVERSE_GEOCODE_RESPONSE_BYTES,
  NOMINATIM_USER_AGENT,
  reverseGeocodeNominatim,
} from '../../src/personalization/reverse-geocode.js';

describe('reverseGeocodeNominatim', () => {
  it('calls Nominatim with 2-decimal coarse coords, zoom=10, and required User-Agent', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          address: {
            city: 'Austin',
            state: 'Texas',
            country: 'United States',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const location = await reverseGeocodeNominatim(30.267153, -97.743061, { fetcher });
    expect(location).toEqual({
      city: 'Austin',
      region: 'Texas',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://nominatim.openstreetmap.org/reverse?lat=30.27&lon=-97.74&format=jsonv2&zoom=10&addressdetails=1',
    );
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toBe(NOMINATIM_USER_AGENT);
    expect(headers.get('accept')).toBe('application/json');
  });

  it('falls back across town/village/municipality/county and omits duplicate region', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          address: {
            town: 'Dingle',
            state: 'Dingle',
            country: 'Ireland',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const location = await reverseGeocodeNominatim(52.1409, -10.264, { fetcher });
    expect(location).toEqual({
      city: 'Dingle',
      country: 'Ireland',
      latitude: 52.14,
      longitude: -10.26,
    });
  });

  it('maps HTTP errors, missing city, oversized responses, and timeouts to closed LOCATION_UNAVAILABLE', async () => {
    // 1. Upstream HTTP 429 / 503
    const rateLimited = vi.fn<typeof fetch>(async () => new Response('rate limit', { status: 429 }));
    let caught: unknown;
    try {
      await reverseGeocodeNominatim(30.27, -97.74, { fetcher: rateLimited });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersonalizationFault);
    const fault = caught as PersonalizationFault;
    expect(fault.code).toBe('LOCATION_UNAVAILABLE');
    expect(fault.status).toBe(503);
    expect(fault.retryable).toBe(true);
    expect(fault.message).not.toContain('30.27');
    expect(fault.message).not.toContain('rate limit');

    // 2. Ocean coordinates / Nominatim error payload with no city
    const ocean = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: 'Unable to geocode' }), { status: 200 }),
    );
    await expect(reverseGeocodeNominatim(0, 0, { fetcher: ocean })).rejects.toMatchObject({
      code: 'LOCATION_UNAVAILABLE',
      status: 503,
    });

    // 3. Oversized response body exceeding byte cap
    const oversized = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          address: { city: 'Austin' },
          padding: 'x'.repeat(MAX_REVERSE_GEOCODE_RESPONSE_BYTES + 1024),
        }),
        { status: 200 },
      ),
    );
    await expect(reverseGeocodeNominatim(30.27, -97.74, { fetcher: oversized })).rejects.toMatchObject({
      code: 'LOCATION_UNAVAILABLE',
      status: 503,
    });

    // 4. Timeout abort
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    await expect(
      reverseGeocodeNominatim(30.27, -97.74, { fetcher: hanging, timeoutMs: 25 }),
    ).rejects.toMatchObject({
      code: 'LOCATION_UNAVAILABLE',
      status: 503,
    });
  });
});
