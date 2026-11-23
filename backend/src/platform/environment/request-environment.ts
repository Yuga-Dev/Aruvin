/**
 * ============================================================================
 * FILE: request-environment.ts
 * LOCATION: backend/src/platform/environment/request-environment.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate client time zone hints and trusted proxy geolocation headers.
 *
 * ROLE IN PROJECT:
 *    Extracts sanitized, fail-closed request environment metadata at HTTP
 *    admission without trusting unverified proxy headers or retaining raw IPs.
 *
 * KEY COMPONENTS:
 *    - normalizeTimeZone: Validates trimmed IANA time zones safely.
 *    - trustedGeoProxyIngress / extractTrustedGeo: Loopback TLS/opt-in proxy gate.
 *    - extractRequestEnvironment: Combines normalized time zone and geo hints.
 * ============================================================================
 */

import type { Request } from 'express';

export const CLIENT_TIME_ZONE_HEADER = 'x-aurvin-time-zone';

export type RequestGeoSource = 'cloudflare' | 'vercel';

export type RequestGeoHint = Readonly<{
  city?: string;
  region?: string;
  country?: string;
  source: RequestGeoSource;
}>;

export type RequestEnvironment = Readonly<{
  timeZone: string | null;
  geo: RequestGeoHint | null;
}>;

export type TrustedProxyPredicate = (req: Request) => boolean;

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const GEO_PLACEHOLDERS = new Set(['xx', 't1', 'unknown']);
const COUNTRY_CODE_RE = /^[A-Z]{2,3}(?:-[A-Z0-9]{1,12})?$/;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function singleHeaderValue(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === 'string') return raw[0];
  return null;
}

export function normalizeTimeZone(raw: unknown): string | null {
  const candidate = singleHeaderValue(raw);
  if (candidate === null || hasControlChars(candidate)) return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return null;
  }
}

export function trustedGeoProxyIngress(req: Request): boolean {
  const peer = req.socket?.remoteAddress;
  if (!peer || !LOOPBACK_PEERS.has(peer)) return false;
  return req.headers['x-forwarded-proto'] === 'https'
    || process.env.AURVIN_TRUSTED_PROXY_GEO === 'true';
}

function sanitizeGeoField(raw: unknown, maxLen: number): string | undefined {
  const value = singleHeaderValue(raw);
  if (value === null || value.length > 4096) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }
  if (hasControlChars(decoded)) return undefined;
  const trimmed = decoded.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return undefined;
  if (GEO_PLACEHOLDERS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

function sanitizeCountryField(raw: unknown): string | undefined {
  const value = sanitizeGeoField(raw, 16);
  if (!value) return undefined;
  const upper = value.toUpperCase();
  if (GEO_PLACEHOLDERS.has(upper.toLowerCase())) return undefined;
  return COUNTRY_CODE_RE.test(upper) ? upper : undefined;
}

function buildGeoHint(
  headers: Request['headers'],
  keys: { city: string; region: string; country: string },
  source: RequestGeoSource,
): RequestGeoHint | null {
  const city = sanitizeGeoField(headers[keys.city], 100);
  const region = sanitizeGeoField(headers[keys.region], 100);
  const country = sanitizeCountryField(headers[keys.country]);
  if (!city && !region && !country) return null;
  return Object.freeze({
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(country ? { country } : {}),
    source,
  });
}

export function extractTrustedGeo(
  req: Request,
  trustedProxy: TrustedProxyPredicate = trustedGeoProxyIngress,
): RequestGeoHint | null {
  if (!trustedProxy(req)) return null;
  const headers = req.headers ?? {};
  return buildGeoHint(
    headers,
    { city: 'cf-ipcity', region: 'cf-region', country: 'cf-ipcountry' },
    'cloudflare',
  ) ?? buildGeoHint(
    headers,
    { city: 'x-vercel-ip-city', region: 'x-vercel-ip-country-region', country: 'x-vercel-ip-country' },
    'vercel',
  );
}

export function extractRequestEnvironment(
  req: Request,
  trustedProxy: TrustedProxyPredicate = trustedGeoProxyIngress,
): RequestEnvironment {
  const headers = req.headers ?? {};
  return Object.freeze({
    timeZone: normalizeTimeZone(headers[CLIENT_TIME_ZONE_HEADER]),
    geo: extractTrustedGeo(req, trustedProxy),
  });
}
