/**
 * ============================================================================
 * FILE: client-timezone.test.ts
 * LOCATION: frontend/src/api/client-timezone.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Unit tests for browser time zone detection and HTTP header attachment.
 *
 * ROLE IN PROJECT:
 *    Verifies zero-permission Intl time zone validation, graceful null fallback,
 *    and non-clobbering case-insensitive header merging across HeadersInit shapes.
 *
 * KEY COMPONENTS:
 *    - detectBrowserTimeZone tests: valid trimming, length bounds, control chars, throws.
 *    - withClientTimeZoneHeader tests: plain object, tuple array, Headers, overrides.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_TIME_ZONE_HEADER,
  detectBrowserTimeZone,
  withClientTimeZoneHeader,
} from './client-timezone.ts';

function stubResolvedTimeZone(timeZone: unknown): void {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
    (() => ({
      resolvedOptions: () => ({ timeZone }),
    })) as unknown as typeof Intl.DateTimeFormat,
  );
}

describe('client-timezone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports the canonical X-Aurvin-Time-Zone header name', () => {
    expect(CLIENT_TIME_ZONE_HEADER).toBe('X-Aurvin-Time-Zone');
  });

  it('returns a valid trimmed time zone from Intl.DateTimeFormat', () => {
    stubResolvedTimeZone('America/New_York');
    expect(detectBrowserTimeZone()).toBe('America/New_York');

    stubResolvedTimeZone('  Europe/London  ');
    expect(detectBrowserTimeZone()).toBe('Europe/London');

    const exactLimit = 'A'.repeat(100);
    stubResolvedTimeZone(exactLimit);
    expect(detectBrowserTimeZone()).toBe(exactLimit);
  });

  it('returns null gracefully when Intl throws, is unavailable, or yields invalid values', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((() => {
      throw new Error('Intl disabled');
    }) as unknown as typeof Intl.DateTimeFormat);
    expect(detectBrowserTimeZone()).toBeNull();

    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      (() => ({
        resolvedOptions: () => {
          throw new Error('resolvedOptions failed');
        },
      })) as unknown as typeof Intl.DateTimeFormat,
    );
    expect(detectBrowserTimeZone()).toBeNull();

    for (const invalid of [
      undefined,
      null,
      42,
      '',
      '   ',
      'A'.repeat(101),
      'America/New\nYork',
      'UTC\r',
      '\tUTC',
      '\u0000UTC',
      'UTC\u001f',
      'UTC\u007f',
    ]) {
      stubResolvedTimeZone(invalid);
      expect(detectBrowserTimeZone()).toBeNull();
    }
  });

  it('normalizes HeadersInit inputs to plain Record<string, string> and appends detected header', () => {
    stubResolvedTimeZone('America/Chicago');

    expect(withClientTimeZoneHeader()).toEqual({
      'X-Aurvin-Time-Zone': 'America/Chicago',
    });

    const callerRecord = { 'Content-Type': 'application/json' };
    expect(withClientTimeZoneHeader(callerRecord)).toEqual({
      'Content-Type': 'application/json',
      'X-Aurvin-Time-Zone': 'America/Chicago',
    });
    expect(callerRecord).toEqual({ 'Content-Type': 'application/json' });

    expect(withClientTimeZoneHeader([['Content-Type', 'application/json'], ['X-Custom', '1']])).toEqual({
      'Content-Type': 'application/json',
      'X-Custom': '1',
      'X-Aurvin-Time-Zone': 'America/Chicago',
    });

    expect(
      withClientTimeZoneHeader(new Headers({ 'Content-Type': 'application/json', 'X-Trace': 'abc' })),
    ).toEqual({
      'content-type': 'application/json',
      'x-trace': 'abc',
      'X-Aurvin-Time-Zone': 'America/Chicago',
    });
  });

  it('does not clobber explicit caller X-Aurvin-Time-Zone overrides regardless of case', () => {
    stubResolvedTimeZone('America/Chicago');

    expect(
      withClientTimeZoneHeader({
        'Content-Type': 'application/json',
        'x-aurvin-time-zone': 'Europe/Berlin',
      }),
    ).toEqual({
      'Content-Type': 'application/json',
      'x-aurvin-time-zone': 'Europe/Berlin',
    });

    expect(
      withClientTimeZoneHeader([
        ['Content-Type', 'application/json'],
        ['X-AURVIN-TIME-ZONE', 'Asia/Tokyo'],
      ]),
    ).toEqual({
      'Content-Type': 'application/json',
      'X-AURVIN-TIME-ZONE': 'Asia/Tokyo',
    });

    expect(
      withClientTimeZoneHeader(new Headers({ 'X-Aurvin-Time-Zone': 'Pacific/Auckland' })),
    ).toEqual({
      'x-aurvin-time-zone': 'Pacific/Auckland',
    });
  });

  it('omits X-Aurvin-Time-Zone when detection returns null while preserving caller headers', () => {
    stubResolvedTimeZone('');

    expect(withClientTimeZoneHeader()).toEqual({});
    expect(withClientTimeZoneHeader({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
    });
  });
});
