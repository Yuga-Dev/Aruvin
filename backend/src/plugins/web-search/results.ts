/**
 * ============================================================================
 * FILE: results.ts
 * LOCATION: backend/src/plugins/web-search/results.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Normalize provider MCP payloads into bounded P1 web tool results.
 *
 * ROLE IN PROJECT:
 *    Applies provider-specific extraction, public-URL validation, code-point-
 *    safe clipping, and serialized-byte fitting before returning. Provenance
 *    is not emitted here; the runtime derives it from the returned URLs.
 *
 * KEY COMPONENTS:
 *    - normalizeResult: Browse/fetch extraction and strict result validation.
 *    - canonicalUrl / sourceTitle: Public URL checks and bounded titles.
 *    - fittingPrefix: Binary-search longest fitting code-point prefix.
 * ============================================================================
 */

import { WEB_SEARCH_POLICY as P } from '../../contracts/web-search-policy.js';
import type { WebSearchMode, WebSearchProvider } from '../../contracts/web-search-policy.js';
import {
  webToolResultSchema, type WebToolArguments, type WebToolResult,
} from '../../contracts/web-search-tools.js';

export type NormalizeInput = {
  provider: WebSearchProvider; args: WebToolArguments; payload: unknown;
  retrievedAt: string; publicUrl: (raw: string) => Promise<string>;
};

type Entry = { title?: string; url: string; snippet?: string; content?: string };
type Parts = {
  structured?: Record<string, unknown>; json?: Record<string, unknown>;
  text?: string; isError: boolean;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const points = (value: string): string[] => Array.from(value);
const clipped = (value: string, max: number): boolean => points(value).length > max;
const clip = (value: string, max: number): string => points(value).slice(0, max).join('');

/**
 * `label()` bounds UTF-16 length, not code points, so a code-point clip can
 * still overflow it. Cut on a code-unit boundary without splitting a pair.
 */
export function sourceTitle(value: string): string {
  const head = value.slice(0, P.maxTitleChars);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/** `label()` rejects control characters; collapse them so one bad title cannot fail a result. */
const cleanTitle = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();

export function fittingPrefix(text: string, fits: (candidate: string) => boolean): string {
  const chars = points(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(chars.slice(0, mid).join(''))) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join('');
}

function unusable(mode: WebSearchMode | null): WebToolResult {
  return { ok: false, mode, error: { code: 'WEB_UNUSABLE_RESULT', retryable: true } };
}

function payloadParts(payload: unknown): Parts {
  const root = record(payload);
  if (!root) return { isError: false };
  const isError = root.isError === true;
  const structured = record(root.structuredContent) ?? undefined;
  const blocks = arr(root.content).map(record)
    .map(block => (block ? str(block.text) : undefined))
    .filter((value): value is string => value !== undefined);
  for (const block of blocks) {
    try {
      const json = record(JSON.parse(block));
      if (json) return { structured, json, text: block, isError };
    } catch {
      /* Not JSON; retain the first text block for the exact grammar below. */
    }
  }
  return { structured, text: blocks[0], isError };
}

function extractBrowse(provider: WebSearchProvider, parts: Parts): Entry[] {
  const source = parts.structured ?? parts.json;
  if (provider === 'exa' && source === undefined) {
    return parts.text ? parseExaBrowse(parts.text) : [];
  }
  if (source === undefined) return [];
  switch (provider) {
    case 'tinyfish':
    case 'keenable':
      return arr(source.results).map(record).flatMap(item => {
        const url = item ? str(item.url) : undefined;
        return url ? [{ url, title: str(item!.title), snippet: str(item!.snippet) }] : [];
      });
    case 'exa':
      return arr(source.results).map(record).flatMap(item => {
        const url = item ? str(item.url) : undefined;
        if (!url) return [];
        const highlights = arr(item!.highlights).map(str)
          .filter((value): value is string => value !== undefined).join('\n');
        return [{ url, title: str(item!.title), snippet: highlights || str(item!.text) }];
      });
    case 'tavily':
      return arr(source.results).map(record).flatMap(item => {
        const url = item ? str(item.url) : undefined;
        return url ? [{ url, title: str(item!.title), snippet: str(item!.content) }] : [];
      });
    case 'firecrawl': {
      const data = record(source.data);
      const list = Array.isArray(source.data) ? source.data : arr(data?.web ?? source.web);
      return list.map(record).flatMap(item => {
        const url = item ? str(item.url) : undefined;
        return url ? [{ url, title: str(item!.title), snippet: str(item!.description) }] : [];
      });
    }
  }
}

function extractFetch(provider: WebSearchProvider, parts: Parts): Entry[] {
  const source = parts.structured ?? parts.json;
  if (provider === 'exa' && source === undefined) {
    return parts.text ? parseExaFetch(parts.text) : [];
  }
  if (source === undefined) return [];
  switch (provider) {
    case 'tinyfish':
      return arr(source.results).map(record).flatMap(item => {
        const url = item ? str(item.url) : undefined;
        if (!url) return [];
        const metadata = record(item!.page_metadata);
        return [{ url, title: str(metadata?.title),
          content: str(item!.content) ?? str(item!.markdown) }];
      });
    case 'keenable': {
      const data = record(source.data) ?? source;
      const url = str(data.url);
      return url ? [{ url, title: str(data.title), content: str(data.content) }] : [];
    }
    case 'exa':
      return arr(source.results).map(record).flatMap(item => {
        const url = item ? str(item.url) : undefined;
        return url ? [{ url, title: str(item!.title), content: str(item!.text) }] : [];
      });
    case 'tavily':
      return arr(source.results).map(record).flatMap(item => {
        const url = item ? str(item.url) : undefined;
        return url ? [{ url, content: str(item!.raw_content) }] : [];
      });
    case 'firecrawl': {
      const data = record(source.data) ?? source;
      const metadata = record(data.metadata);
      const url = str(metadata?.sourceURL) ?? str(metadata?.url);
      return url ? [{ url, title: str(metadata?.title),
        content: str(data.markdown) ?? str(source.markdown) }] : [];
    }
  }
}

function parseExaBrowse(text: string): Entry[] {
  return text.split(/\n\n---\n\n/).flatMap(block => {
    const lines = block.split('\n');
    let title: string | undefined;
    let url: string | undefined;
    const body: string[] = [];
    let inBody = false;
    for (const line of lines) {
      if (!inBody) {
        if (line.startsWith('Title: ')) { title = line.slice(7).trim(); continue; }
        if (line.startsWith('URL: ')) { url = line.slice(5).trim(); continue; }
        if (line.startsWith('Published: ') || line.startsWith('Author: ')) continue;
        if (line === 'Highlights:' || line === 'Text:') { inBody = true; continue; }
      }
      if (inBody) body.push(line);
    }
    const snippet = body.join('\n').trim();
    return url ? [{ url, title, snippet }] : [];
  });
}

function parseExaFetch(text: string): Entry[] {
  const lines = text.split('\n');
  let title: string | undefined;
  let url: string | undefined;
  let index = 0;
  if (lines[0]?.startsWith('# ')) { title = lines[0].slice(2).trim(); index = 1; }
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('URL: ')) { url = line.slice(5).trim(); continue; }
    if (line.startsWith('Published: ') || line.startsWith('Author: ')) continue;
    if (line === '') { index += 1; break; }
  }
  const content = lines.slice(index).join('\n').trim();
  return url ? [{ url, title, content }] : [];
}

/** Canonical public URL, or null when it is unsafe, unresolvable, or too long. */async function canonicalUrl(entry: Entry, input: NormalizeInput): Promise<string | null> {
  let canonical: string;
  try {
    canonical = await input.publicUrl(entry.url);
  } catch {
    return null;
  }
  return canonical.length > P.maxSourceUrlChars ? null : canonical;
}

const titleOf = (entry: Entry, url: string): string =>
  sourceTitle(cleanTitle(entry.title ?? '') || url).trim() || sourceTitle(url);

export async function normalizeResult(input: NormalizeInput): Promise<WebToolResult> {
  const parts = payloadParts(input.payload);
  if (parts.isError) return unusable(input.args.mode);
  if (input.args.mode === 'browse') return normalizeBrowse(input, parts);
  return normalizeFetch(input, parts);
}

async function normalizeBrowse(input: NormalizeInput, parts: Parts): Promise<WebToolResult> {
  const entries = extractBrowse(input.provider, parts);
  if (entries.length === 0) return unusable('browse');
  const seen = new Set<string>();
  const results: Array<{ url: string; title: string; body: string }> = [];
  let truncated = false;
  for (const entry of entries) {
    if (results.length >= P.maxBrowseResults) { truncated = true; break; }
    const snippet = entry.snippet?.trim();
    if (!snippet) { truncated = true; continue; }
    const url = await canonicalUrl(entry, input);
    if (!url) { truncated = true; continue; }
    if (seen.has(url)) { truncated = true; continue; }
    seen.add(url);
    if (clipped(snippet, P.maxSnippetChars)) truncated = true;
    results.push({ url, title: titleOf(entry, url), body: clip(snippet, P.maxSnippetChars) });
  }
  if (results.length === 0) return unusable('browse');
  const build = (value: typeof results) => ({
    ok: true as const, mode: 'browse' as const, provider: input.provider,
    retrievedAt: input.retrievedAt, results: value, truncated,
  });
  let current = results;
  while (current.length > 1 && bytes(build(current)) > P.maxBrowseResultBytes) {
    current = current.slice(0, -1);
    truncated = true;
  }
  if (bytes(build(current)) > P.maxBrowseResultBytes) {
    const last = current[current.length - 1]!;
    const prefix = fittingPrefix(last.body, candidate =>
      bytes(build([...current.slice(0, -1), { ...last, body: candidate }])) <= P.maxBrowseResultBytes);
    if (prefix.length === 0) return unusable('browse');
    current = [...current.slice(0, -1), { ...last, body: prefix }];
    truncated = true;
  }
  const parsed = webToolResultSchema.safeParse(build(current));
  return parsed.success ? parsed.data : unusable('browse');
}

async function normalizeFetch(input: NormalizeInput, parts: Parts): Promise<WebToolResult> {
  const requested = input.args.mode === 'fetch' ? input.args.url : '';
  const entries = extractFetch(input.provider, parts);
  if (entries.length === 0) return unusable('fetch');
  let requestedCanonical: string | null = null;
  try { requestedCanonical = new URL(requested).toString(); } catch { requestedCanonical = null; }
  const matches = (entry: Entry): boolean => {
    if (requestedCanonical === null) return false;
    try { return new URL(entry.url).toString() === requestedCanonical; } catch { return false; }
  };
  const chosen = input.provider === 'exa' || input.provider === 'firecrawl'
    ? entries.find(matches) ?? (entries.length === 1 ? entries[0] : undefined)
    : entries.find(matches);
  if (!chosen) return unusable('fetch');
  const source = await canonicalUrl(chosen, input);
  if (!source) return unusable('fetch');
  const content = chosen.content?.trim();
  if (!content) return unusable('fetch');
  let truncated = clipped(content, P.maxFetchContentChars);
  let value = clip(content, P.maxFetchContentChars);
  const build = (candidate: string) => ({
    ok: true as const, mode: 'fetch' as const, provider: input.provider,
    retrievedAt: input.retrievedAt, url: source, body: candidate, truncated,
  });
  if (bytes(build(value)) > P.maxFetchResultBytes) {
    const prefix = fittingPrefix(value, candidate => bytes(build(candidate)) <= P.maxFetchResultBytes);
    if (prefix.length === 0) return unusable('fetch');
    value = prefix;
    truncated = true;
  }
  const parsed = webToolResultSchema.safeParse(build(value));
  return parsed.success ? parsed.data : unusable('fetch');
}
