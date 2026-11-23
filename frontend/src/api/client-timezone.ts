/**
 * ============================================================================
 * FILE: client-timezone.ts
 * LOCATION: frontend/src/api/client-timezone.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Detect and attach the browser's IANA time zone header on HTTP requests.
 *
 * ROLE IN PROJECT:
 *    Provides zero-permission browser time zone detection via Intl.DateTimeFormat
 *    and merges X-Aurvin-Time-Zone into fetch headers for chat turns and voice
 *    session creation without modifying JSON wire payloads or recovery storage.
 *
 * KEY COMPONENTS:
 *    - CLIENT_TIME_ZONE_HEADER: Canonical X-Aurvin-Time-Zone request header name.
 *    - detectBrowserTimeZone: Validated, non-throwing browser time zone reader.
 *    - withClientTimeZoneHeader: Header normalization and non-clobbering merge.
 * ============================================================================
 */

export const CLIENT_TIME_ZONE_HEADER = 'X-Aurvin-Time-Zone';

const MAX_TIME_ZONE_LENGTH = 100;

function hasAsciiControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function detectBrowserTimeZone(): string | null {
  try {
    const raw = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof raw !== 'string' || hasAsciiControlChar(raw)) {
      return null;
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_TIME_ZONE_LENGTH) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

export function withClientTimeZoneHeader(headers?: HeadersInit): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      normalized[key] = value;
    }
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) {
        normalized[key] = value;
      }
    }
  }

  const targetLower = CLIENT_TIME_ZONE_HEADER.toLowerCase();
  const hasCallerHeader = Object.keys(normalized).some((key) => key.toLowerCase() === targetLower);
  if (!hasCallerHeader) {
    const timeZone = detectBrowserTimeZone();
    if (timeZone !== null) {
      normalized[CLIENT_TIME_ZONE_HEADER] = timeZone;
    }
  }

  return normalized;
}
