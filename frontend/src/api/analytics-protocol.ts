/**
 * ============================================================================
 * FILE: analytics-protocol.ts
 * LOCATION: frontend/src/api/analytics-protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Wire types and a structural guard for GET /admin/analytics.
 *
 * ROLE IN PROJECT:
 *    Mirrors the backend AccountingTotals contract so the browser rejects
 *    malformed reports instead of rendering wrong numbers.
 *
 * KEY COMPONENTS:
 *    - AnalyticsTotals / AnalyticsPage: Report rows and a keyset page.
 *    - isAnalyticsPage: Structural guard.
 * ============================================================================
 */

export const ANALYTICS_ROUTE = '/admin/analytics';
export const ANALYTICS_UNITS = ['text-tokens', 'voice-audio', 'voice-characters'] as const;
export type AnalyticsUnit = (typeof ANALYTICS_UNITS)[number];

export const ANALYTICS_COUNT_KEYS = [
  'requestCount', 'operationCount', 'knownCostCount', 'pendingCostCount', 'unknownCostCount',
  'estimatedCostCount', 'promptTokens', 'completionTokens', 'cachedPromptTokens',
  'observedAudioMs', 'billableCharacters', 'failedCount', 'cancelledCount',
  'interruptedCount', 'truncatedCount',
] as const;
export type AnalyticsCountKey = (typeof ANALYTICS_COUNT_KEYS)[number];

export type AnalyticsTotals = Record<AnalyticsCountKey, number> & {
  userId: string | null;
  currency: 'USD';
  unit: AnalyticsUnit;
  reportedTotal: string | null;
  estimatedTotal: string | null;
  spendComplete: boolean;
};
export type AnalyticsPage = { items: AnalyticsTotals[]; nextCursor: string | null };
export type AnalyticsQuery = { start: string; end: string; byUser?: boolean; cursor?: string };

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const money = (v: unknown) => v === null || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v));

function isTotals(v: unknown): v is AnalyticsTotals {
  if (!object(v)) return false;
  return (v.userId === null || typeof v.userId === 'string') && v.currency === 'USD'
    && ANALYTICS_UNITS.includes(v.unit as AnalyticsUnit) && money(v.reportedTotal) && money(v.estimatedTotal)
    && typeof v.spendComplete === 'boolean'
    && ANALYTICS_COUNT_KEYS.every((k) => typeof v[k] === 'number' && Number.isSafeInteger(v[k]) && (v[k] as number) >= 0);
}

export function isAnalyticsPage(v: unknown): v is AnalyticsPage {
  return object(v) && Array.isArray(v.items) && v.items.every(isTotals)
    && (v.nextCursor === null || typeof v.nextCursor === 'string');
}
