/**
 * ============================================================================
 * FILE: reverse-geocode.ts
 * LOCATION: backend/src/personalization/reverse-geocode.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Resolve browser coordinates to a coarse city-level SavedUserLocation via
 *    OpenStreetMap Nominatim with finite timeout, byte cap, and closed faults.
 *
 * ROLE IN PROJECT:
 *    Powers POST /api/personalization/reverse-geocode without transmitting
 *    exact street GPS coordinates or leaking upstream details to callers.
 *
 * KEY COMPONENTS:
 *    - reverseGeocodeNominatim: Bounded fetch, address extraction, Zod validation.
 * ============================================================================
 */

import {
  roundCoarseCoordinate,
  savedUserLocationSchema,
  type SavedUserLocation,
} from '../contracts/personalization.js';
import { PersonalizationFault } from './errors.js';

export const NOMINATIM_REVERSE_ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
export const NOMINATIM_USER_AGENT = 'Aurvin/1.0 (personalization-location)';
export const DEFAULT_REVERSE_GEOCODE_TIMEOUT_MS = 5_000;
export const MAX_REVERSE_GEOCODE_RESPONSE_BYTES = 65_536;

export type ReverseGeocodeOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  endpoint?: string;
  signal?: AbortSignal;
};

function firstNonEmptyString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REVERSE_GEOCODE_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new PersonalizationFault('LOCATION_UNAVAILABLE');
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(combined);
    return JSON.parse(text) as unknown;
  } catch {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }
}

function extractLocation(
  payload: unknown,
  coarseLat: number,
  coarseLon: number,
): SavedUserLocation {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }
  const record = payload as Record<string, unknown>;
  const address = record.address;
  if (address === null || typeof address !== 'object' || Array.isArray(address)) {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }
  const addr = address as Record<string, unknown>;
  const city = firstNonEmptyString([
    addr.city,
    addr.town,
    addr.village,
    addr.municipality,
    addr.hamlet,
    addr.borough,
    addr.county,
  ]);
  if (!city) {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }

  const rawRegion = firstNonEmptyString([
    addr.state,
    addr.region,
    addr.province,
    addr.state_district,
  ]);
  const region =
    rawRegion && rawRegion.toLowerCase() !== city.toLowerCase() ? rawRegion : undefined;
  const country = firstNonEmptyString([addr.country]);

  const candidate: SavedUserLocation = {
    city,
    latitude: coarseLat,
    longitude: coarseLon,
  };
  if (region !== undefined) candidate.region = region;
  if (country !== undefined) candidate.country = country;

  const parsed = savedUserLocationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }
  return parsed.data;
}

export async function reverseGeocodeNominatim(
  latitude: number,
  longitude: number,
  options?: ReverseGeocodeOptions,
): Promise<SavedUserLocation> {
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new PersonalizationFault('INVALID_REQUEST');
  }

  const coarseLat = roundCoarseCoordinate(latitude);
  const coarseLon = roundCoarseCoordinate(longitude);
  const fetcher = options?.fetcher ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REVERSE_GEOCODE_TIMEOUT_MS;
  const endpoint = options?.endpoint ?? NOMINATIM_REVERSE_ENDPOINT;

  const url =
    `${endpoint}?lat=${encodeURIComponent(String(coarseLat))}` +
    `&lon=${encodeURIComponent(String(coarseLon))}` +
    '&format=jsonv2&zoom=10&addressdetails=1';

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedSignal = options?.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        'User-Agent': NOMINATIM_USER_AGENT,
        Accept: 'application/json',
      },
      signal: combinedSignal,
    });
    if (!response.ok) {
      throw new PersonalizationFault('LOCATION_UNAVAILABLE');
    }
    const payload = await readBoundedJson(response);
    return extractLocation(payload, coarseLat, coarseLon);
  } catch (error) {
    if (error instanceof PersonalizationFault) throw error;
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}
