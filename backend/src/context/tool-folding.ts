/**
 * ============================================================================
 * FILE: tool-folding.ts
 * LOCATION: backend/src/context/tool-folding.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Project one validated historical Web result into bounded evidence.
 *
 * ROLE IN PROJECT:
 *    Pure, request-only admission helper for real native overflow. It never runs
 *    on ordinary prompts, never touches Calendar redaction or Canvas ownership,
 *    and never rewrites canonical messages or source provenance.
 *
 * KEY COMPONENTS:
 *    - FoldedWebEvidence: Exact returned URLs/titles with a bounded excerpt.
 *    - foldHistoricalWebResult: Conservative success-only validation and shrink.
 * ============================================================================
 */
import { webToolGroupSchema } from '../chat-runtime/memory-web-state.js';
import { WEB_SEARCH_POLICY } from '../contracts/web-search-policy.js';
import { webToolArgumentsSchema, webToolResultSchema } from '../contracts/web-search-tools.js';

export type FoldedWebEvidence = {
  kind: 'folded-web-result';
  status: 'ok';
  truncated: boolean;
  results: { url: string; title: string; excerpt: string }[];
};

/**
 * Project one already validated historical Web group into bounded evidence.
 * Exact URLs and titles must match the group's own sources one-to-one; failure,
 * legacy, unproven or non-shrinking payloads are not candidates.
 */
export function foldHistoricalWebResult(value: unknown): string | null {
  const group = webToolGroupSchema.safeParse(value);
  if (!group.success) return null;
  const { assistant, result, sources } = group.data;
  const raw = result.content;
  const source = sources[0];
  if (!source || Buffer.byteLength(raw, 'utf8') > WEB_SEARCH_POLICY.maxFetchResultBytes) return null;
  let payload: unknown;
  let args: unknown;
  try {
    payload = JSON.parse(raw);
    args = JSON.parse(assistant.tool_calls[0].function.arguments);
  } catch { return null; }
  const call = webToolArgumentsSchema.safeParse(args);
  if (!call.success || call.data.mode !== source.kind ||
      !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const parsed = webToolResultSchema.safeParse({
    ...payload, ok: true, mode: source.kind, provider: source.provider, retrievedAt: source.retrievedAt,
  });
  if (!parsed.success || !parsed.data.ok || 'error' in payload) return null;
  const data = parsed.data;
  const entries = data.mode === 'browse'
    ? data.results : [{ url: data.url, title: source.title, body: data.body }];
  if (entries.length !== sources.length || entries.some((entry, index) => {
    const known = sources[index];
    return entry.url !== known.url || entry.title !== known.title || known.kind !== data.mode ||
      known.provider !== source.provider || known.retrievedAt !== source.retrievedAt;
  })) return null;

  const folded: FoldedWebEvidence = {
    kind: 'folded-web-result', status: 'ok', truncated: data.truncated,
    results: entries.map(entry => ({ url: entry.url, title: entry.title, excerpt: entry.body.slice(0, 160) })),
  };
  const content = JSON.stringify(folded);
  return Buffer.byteLength(JSON.stringify(content), 'utf8') <
    Buffer.byteLength(JSON.stringify(raw), 'utf8') ? content : null;
}
