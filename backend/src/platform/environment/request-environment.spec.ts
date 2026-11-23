/**
 * ============================================================================
 * FILE: request-environment.spec.ts
 * LOCATION: backend/src/platform/environment/request-environment.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify time zone normalization, trusted proxy geo gating, and ALS isolation.
 *
 * ROLE IN PROJECT:
 *    Tests fail-closed proxy trust, URL decoding, placeholder/control-char
 *    rejection, absence of raw IP retention, and concurrent ALS isolation.
 *
 * KEY COMPONENTS:
 *    - normalizeTimeZone: Valid, invalid, overlong, control-char, multi-value cases.
 *    - extractTrustedGeo / trustedGeoProxyIngress: Cloudflare, Vercel, spoofing.
 *    - RequestEnvironmentStore: AsyncLocalStorage and WeakMap attach/restore isolation.
 * ============================================================================
 */

import { setImmediate } from 'node:timers/promises';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_TIME_ZONE_HEADER,
  RequestEnvironmentStore,
  extractRequestEnvironment,
  extractTrustedGeo,
  normalizeTimeZone,
  trustedGeoProxyIngress,
} from './index.js';

function fakeRequest(input: {
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
} = {}): Request {
  return {
    headers: input.headers ?? {},
    socket: { remoteAddress: input.remoteAddress },
  } as unknown as Request;
}

describe('request-environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('normalizes valid IANA time zones and trims surrounding whitespace', () => {
    expect(normalizeTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(normalizeTimeZone('America/New_York')).toBe('America/New_York');
    expect(normalizeTimeZone('  Asia/Kolkata  ')).toBe('Asia/Kolkata');
    expect(normalizeTimeZone(['Asia/Kolkata'])).toBe('Asia/Kolkata');
  });

  it('returns null without throwing for invalid, empty, overlong, control-char, or multi-value zones', () => {
    expect(normalizeTimeZone('')).toBeNull();
    expect(normalizeTimeZone('   ')).toBeNull();
    expect(normalizeTimeZone([])).toBeNull();
    expect(normalizeTimeZone(['Asia/Kolkata', 'America/New_York'])).toBeNull();
    expect(normalizeTimeZone('Invalid/Zone')).toBeNull();
    expect(normalizeTimeZone('America/' + 'a'.repeat(95))).toBeNull();
    expect(normalizeTimeZone('Asia/Kolkata\u0000')).toBeNull();
    expect(normalizeTimeZone('Asia/\nKolkata')).toBeNull();
    expect(normalizeTimeZone('Asia/Kolkata\u007f')).toBeNull();
    expect(normalizeTimeZone('\tUTC')).toBeNull();
    expect(normalizeTimeZone(42)).toBeNull();
    expect(normalizeTimeZone(null)).toBeNull();
    expect(normalizeTimeZone(undefined)).toBeNull();
  });

  it('rejects spoofed geo headers from untrusted peers or unencrypted loopback ingress', () => {
    const spoofedRemote = fakeRequest({
      remoteAddress: '198.51.100.25',
      headers: {
        'x-forwarded-proto': 'https',
        'cf-ipcity': 'Chennai',
        'cf-region': 'Tamil%20Nadu',
        'cf-ipcountry': 'IN',
        'x-vercel-ip-city': 'Bengaluru',
      },
    });
    expect(trustedGeoProxyIngress(spoofedRemote)).toBe(false);
    expect(extractTrustedGeo(spoofedRemote)).toBeNull();

    const unencryptedLoopback = fakeRequest({
      remoteAddress: '127.0.0.1',
      headers: {
        'cf-ipcity': 'Chennai',
        'x-vercel-ip-city': 'Bengaluru',
      },
    });
    expect(trustedGeoProxyIngress(unencryptedLoopback)).toBe(false);
    expect(extractTrustedGeo(unencryptedLoopback)).toBeNull();
  });

  it('extracts URL-decoded Cloudflare and Vercel geo from trusted proxies without raw IPs', () => {
    const cfReq = fakeRequest({
      remoteAddress: '::ffff:127.0.0.1',
      headers: {
        'x-forwarded-proto': 'https',
        'cf-connecting-ip': '203.0.113.9',
        'x-forwarded-for': '203.0.113.9',
        'cf-region': 'Tamil%20Nadu',
        'cf-ipcity': 'Chennai',
        'cf-ipcountry': 'IN',
        'x-vercel-ip-city': 'Mumbai',
      },
    });
    const cfGeo = extractTrustedGeo(cfReq);
    expect(cfGeo).toEqual({
      city: 'Chennai',
      region: 'Tamil Nadu',
      country: 'IN',
      source: 'cloudflare',
    });
    expect(JSON.stringify(cfGeo)).not.toContain('203.0.113.9');
    expect(JSON.stringify(cfGeo)).not.toContain('127.0.0.1');

    vi.stubEnv('AURVIN_TRUSTED_PROXY_GEO', 'true');
    const vercelReq = fakeRequest({
      remoteAddress: '::1',
      headers: {
        'x-real-ip': '203.0.113.10',
        'x-vercel-ip-city': 'San%20Francisco',
        'x-vercel-ip-country-region': 'CA',
        'x-vercel-ip-country': 'US',
      },
    });
    const vercelGeo = extractTrustedGeo(vercelReq);
    expect(vercelGeo).toEqual({
      city: 'San Francisco',
      region: 'CA',
      country: 'US',
      source: 'vercel',
    });
    expect(JSON.stringify(vercelGeo)).not.toContain('203.0.113.10');
  });

  it('ignores XX/T1/Unknown placeholders, handles malformed percent encoding, and rejects encoded control chars', () => {
    const placeholders = fakeRequest({
      remoteAddress: '127.0.0.1',
      headers: {
        'x-forwarded-proto': 'https',
        'cf-ipcity': 'Unknown',
        'cf-region': 'T1',
        'cf-ipcountry': 'XX',
        'x-vercel-ip-country': 'unknown',
      },
    });
    expect(extractTrustedGeo(placeholders)).toBeNull();

    const partial = fakeRequest({
      remoteAddress: '127.0.0.1',
      headers: {
        'x-forwarded-proto': 'https',
        'cf-ipcity': '100%RawCity',
        'cf-region': 'Bad%0ARegion',
        'cf-ipcountry': 'T1',
      },
    });
    expect(extractTrustedGeo(partial)).toEqual({
      city: '100%RawCity',
      source: 'cloudflare',
    });

    const env = extractRequestEnvironment(
      fakeRequest({
        remoteAddress: '127.0.0.1',
        headers: {
          [CLIENT_TIME_ZONE_HEADER]: '  Asia/Kolkata  ',
          'x-forwarded-proto': 'https',
          'cf-ipcity': 'Chennai',
          'cf-ipcountry': 'IN',
        },
      }),
    );
    expect(Object.isFrozen(env)).toBe(true);
    expect(env).toEqual({
      timeZone: 'Asia/Kolkata',
      geo: { city: 'Chennai', country: 'IN', source: 'cloudflare' },
    });
  });

  it('isolates overlapping RequestEnvironmentStore ALS runs and supports attach/restore', async () => {
    const store = new RequestEnvironmentStore();
    expect(store.current()).toBeNull();
    expect(store.timeZone()).toBeNull();
    expect(store.geo()).toBeNull();

    const results = await Promise.all([
      store.run({ timeZone: 'Asia/Kolkata', geo: { city: 'Chennai', source: 'cloudflare' } }, async () => {
        await setImmediate();
        return { tz: store.timeZone(), geo: store.geo() };
      }),
      store.run({ timeZone: 'America/New_York', geo: null }, async () => {
        await setImmediate();
        return { tz: store.timeZone(), geo: store.geo() };
      }),
    ]);

    expect(results).toEqual([
      { tz: 'Asia/Kolkata', geo: { city: 'Chennai', source: 'cloudflare' } },
      { tz: 'America/New_York', geo: null },
    ]);
    expect(store.current()).toBeNull();

    const req = {};
    const bound = Object.freeze({ timeZone: 'Europe/London', geo: null });
    await store.run(bound, async () => {
      store.attach(req, bound);
    });
    // Outside the original run, restore rebinds the same request object cleanly.
    const restored = await store.run({ timeZone: 'UTC', geo: null }, async () => {
      store.restore(req);
      return store.timeZone();
    });
    expect(restored).toBe('Europe/London');
  });
});
