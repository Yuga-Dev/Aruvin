/**
 * ============================================================================
 * FILE: sanitize-url.ts
 * LOCATION: frontend/src/features/chat/markdown/sanitize-url.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Whitelist safe URL schemes before rendering Markdown links and web sources.
 *
 * ROLE IN PROJECT:
 *    Prevents javascript:, data:, vbscript:, and file: payloads from reaching
 *    href attributes while allowing http, https, mailto, and in-page paths for
 *    Markdown, and strict absolute HTTP(S)-only URLs for web source citations.
 *
 * KEY COMPONENTS:
 *    - sanitizeUrl: Returns the original URL or an empty string when unsafe.
 *    - sanitizeWebSourceUrl: Strict absolute HTTP(S) source URL or empty string.
 *    - isSafeHttpsUrl: Bounded HTTPS-only check for OAuth authorization URLs.
 * ============================================================================
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const WEB_HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_WEB_URL_BYTES = 1_024;
const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007f]/u;

function parseBoundedUrl(
  raw: string,
  protocols: ReadonlySet<string>,
  maxBytes = MAX_WEB_URL_BYTES,
): string {
  if (!raw || raw !== raw.trim() || CONTROL_OR_SPACE_RE.test(raw)) return '';
  if (new TextEncoder().encode(raw).byteLength > maxBytes) return '';
  try {
    const parsed = new URL(raw);
    if (!protocols.has(parsed.protocol)) return '';
    if (!parsed.hostname || parsed.username || parsed.password) return '';
    return raw;
  } catch {
    return '';
  }
}

export function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('/') || trimmed.startsWith('#')) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (SAFE_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return trimmed;
    }
    return '';
  } catch {
    return '';
  }
}

export function sanitizeWebSourceUrl(url: string): string {
  return parseBoundedUrl(url, WEB_HTTP_PROTOCOLS, MAX_WEB_URL_BYTES);
}

export function isSafeHttpsUrl(url: string, maxBytes = 2_048): boolean {
  return parseBoundedUrl(url, new Set(['https:']), maxBytes) !== '';
}
