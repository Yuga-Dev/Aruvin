/**
 * ============================================================================
 * FILE: analytics-state.ts
 * LOCATION: frontend/src/features/admin-config/analytics-state.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Pure range, summing, and formatting logic for the Analytics tab.
 *
 * ROLE IN PROJECT:
 *    Keeps AnalyticsPanel presentational and testable in Node. Money stays in
 *    decimal strings (no float sums); unknown cost is never shown as $0.
 *
 * KEY COMPONENTS:
 *    - rangeFor / ANALYTICS_PRESETS: UTC ranges inside the 31-day API limit.
 *    - summarize: Totals across units with an honest cost status.
 *    - formatUsd / formatCount / describeAnalyticsError: Display helpers.
 * ============================================================================
 */

import type { AnalyticsCountKey, AnalyticsTotals, AnalyticsUnit } from '../../api/analytics-protocol.ts';
import { ANALYTICS_COUNT_KEYS } from '../../api/analytics-protocol.ts';

export const ANALYTICS_PRESETS = [
  { id: '24h', label: 'Last 24 hours', ms: 86_400_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
] as const;
export type AnalyticsPresetId = (typeof ANALYTICS_PRESETS)[number]['id'];

export const UNIT_LABELS: Record<AnalyticsUnit, string> = {
  'text-tokens': 'Text',
  'voice-audio': 'Voice audio',
  'voice-characters': 'Voice characters',
};

/** UTC ISO range ending at `now` (millisecond precision, as the API requires). */
export function rangeFor(preset: AnalyticsPresetId, now: number): { start: string; end: string } {
  const ms = ANALYTICS_PRESETS.find((p) => p.id === preset)!.ms;
  return { start: new Date(now - ms).toISOString(), end: new Date(now).toISOString() };
}

const SCALE = 12;
function toUnits(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole! + fraction.padEnd(SCALE, '0').slice(0, SCALE));
}
/** Exact decimal-string sum; null when no row has a value. */
export function sumDecimal(values: Array<string | null>): string | null {
  const present = values.filter((v): v is string => v !== null);
  if (present.length === 0) return null;
  const total = present.reduce((n, v) => n + toUnits(v), 0n).toString().padStart(SCALE + 1, '0');
  const whole = total.slice(0, -SCALE);
  const fraction = total.slice(-SCALE).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export type AnalyticsSummary = Record<AnalyticsCountKey, number> & {
  reportedTotal: string | null;
  estimatedTotal: string | null;
  spendComplete: boolean;
};

export function summarize(items: readonly AnalyticsTotals[]): AnalyticsSummary {
  const counts = Object.fromEntries(
    ANALYTICS_COUNT_KEYS.map((k) => [k, items.reduce((n, row) => n + row[k], 0)]),
  ) as Record<AnalyticsCountKey, number>;
  return {
    ...counts,
    reportedTotal: sumDecimal(items.map((r) => r.reportedTotal)),
    estimatedTotal: sumDecimal(items.map((r) => r.estimatedTotal)),
    spendComplete: items.every((r) => r.spendComplete),
  };
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Dollar string, or null for unknown. Sub-cent amounts keep up to 6 decimals. */
export function formatUsd(amount: string | null): string | null {
  if (amount === null) return null;
  const [whole = '0', fraction = ''] = amount.split('.');
  const digits = Math.max(2, Math.min(6, fraction.length));
  return `$${Number(whole).toLocaleString('en-US')}.${fraction.slice(0, digits).padEnd(digits, '0')}`;
}

export type CostDisplay = { value: string; note: string | null };

/** Reported cost: never "$0" for unknown; flags partial coverage as an estimate. */
export function reportedCostDisplay(
  s: Pick<AnalyticsSummary, 'reportedTotal' | 'spendComplete' | 'unknownCostCount' | 'pendingCostCount'>,
): CostDisplay {
  const value = formatUsd(s.reportedTotal);
  const missing = s.unknownCostCount + s.pendingCostCount;
  if (value === null) {
    return { value: 'Unknown', note: missing > 0 ? 'No provider-reported cost for this range' : null };
  }
  if (s.spendComplete) return { value, note: null };
  return { value: `${value}+`, note: `Estimate: ${formatCount(missing)} operations have no reported cost yet` };
}

export function estimatedCostDisplay(s: Pick<AnalyticsSummary, 'estimatedTotal'>): CostDisplay {
  const value = formatUsd(s.estimatedTotal);
  return value === null ? { value: 'None', note: null } : { value, note: 'Estimated, not provider-reported' };
}

export function formatAudioMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function isEmptyReport(items: readonly AnalyticsTotals[]): boolean {
  return items.every((r) => r.requestCount === 0 && r.operationCount === 0);
}

export function describeAnalyticsError(code: string): string {
  if (code === 'INVALID_REQUEST') return 'This range has too much activity to report. Try a shorter range.';
  if (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED') return 'Analytics is available to super admins only.';
  if (code === 'NOT_READY') return 'Usage storage is not ready. Try again shortly.';
  return 'Analytics could not be loaded.';
}
