/**
 * ============================================================================
 * FILE: web-search-presentation.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-presentation.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Fold bounded web activities and HTTP(S)-safe sources for text and voice UI.
 *
 * ROLE IN PROJECT:
 *    Produces concise user-facing progress labels and filtered clickable links
 *    without exposing raw query strings or inventing unprovided sources.
 *
 * KEY COMPONENTS:
 *    - foldWebActivities / foldWebSources: Bounded immutable accumulators.
 *    - summarizeWebActivities: Phase/provider/error-code label resolver.
 * ============================================================================
 */

import {
  WEB_SEARCH_POLICY,
  WEB_SEARCH_PROVIDER_CATALOG,
  type WebSearchActivity,
  type WebSearchProvider,
  type WebSourceReference,
} from '../../../api/web-search-protocol.ts';
import { sanitizeWebSourceUrl } from '../../chat/markdown/sanitize-url.ts';

export type WebActivitySummary = {
  tone: 'active' | 'completed' | 'failed' | 'cancelled';
  label: string;
};

export function providerDisplayName(provider: WebSearchProvider | null): string {
  if (!provider) return 'web search';
  return WEB_SEARCH_PROVIDER_CATALOG.find((item) => item.provider === provider)?.displayName ?? provider;
}

export function foldWebActivities(
  existing: readonly WebSearchActivity[],
  next: WebSearchActivity,
): WebSearchActivity[] {
  const sameIndex = existing.findIndex(
    (item) => item.toolCallId === next.toolCallId && item.phase === next.phase && item.provider === next.provider,
  );
  if (sameIndex >= 0) {
    return existing.map((item, idx) => (idx === sameIndex ? next : item));
  }
  if (existing.length >= WEB_SEARCH_POLICY.maxActivitiesPerMessage) {
    return [...existing.slice(existing.length - WEB_SEARCH_POLICY.maxActivitiesPerMessage + 1), next];
  }
  return [...existing, next];
}

export function foldWebSources(
  existing: readonly WebSourceReference[],
  incoming: readonly WebSourceReference[],
): WebSourceReference[] {
  const byId = new Map<string, WebSourceReference>();
  for (const item of existing) {
    if (sanitizeWebSourceUrl(item.url) !== '') byId.set(item.sourceId, item);
  }
  for (const item of incoming) {
    if (sanitizeWebSourceUrl(item.url) === '') continue;
    if (!byId.has(item.sourceId) && byId.size >= WEB_SEARCH_POLICY.maxSourcesPerMessage) continue;
    byId.set(item.sourceId, item);
  }
  return [...byId.values()];
}

function describeToolFailureCode(code: string | null): string {
  switch (code) {
    case 'WEB_PROVIDER_AUTH':
      return 'The saved Web Search credentials are invalid or expired. Reconnect a provider in Plugins → Web Search.';
    case 'WEB_URL_UNSAFE':
      return 'Page URL blocked by safety policy.';
    case 'WEB_SCHEMA_REPAIR_EXHAUSTED':
      return 'Web lookup could not finish within safety limits.';
    default:
      return 'Web search could not complete cleanly.';
  }
}

export function summarizeWebActivities(
  activities: readonly WebSearchActivity[],
): WebActivitySummary {
  if (activities.length === 0) return { tone: 'completed', label: '' };
  const latest = activities[activities.length - 1]!;
  switch (latest.phase) {
    case 'searching':
      return {
        tone: 'active',
        label: 'Searching the web…',
      };
    case 'reading':
      return {
        tone: 'active',
        label: 'Reading page…',
      };
    case 'fallback':
      return {
        tone: 'active',
        label: 'Trying backup provider…',
      };
    case 'completed':
      return {
        tone: 'completed',
        label: '',
      };
    case 'failed':
      return {
        tone: 'failed',
        label: describeToolFailureCode(latest.code),
      };
    case 'cancelled':
      return {
        tone: 'cancelled',
        label: 'Web search cancelled.',
      };
  }
}
