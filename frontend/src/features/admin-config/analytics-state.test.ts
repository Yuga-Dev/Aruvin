/**
 * ============================================================================
 * FILE: analytics-state.test.ts
 * LOCATION: frontend/src/features/admin-config/analytics-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify analytics ranges, exact money sums, and honest cost labels.
 *
 * ROLE IN PROJECT:
 *    Guards the "never $0 for unknown cost" and 31-day range rules in Node.
 *
 * KEY COMPONENTS:
 *    - rangeFor, sumDecimal, summarize, formatUsd, cost displays, client.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { createAnalyticsClient } from '../../api/analytics-client.ts';
import { ANALYTICS_COUNT_KEYS, isAnalyticsPage, type AnalyticsTotals } from '../../api/analytics-protocol.ts';
import {
  ANALYTICS_PRESETS, describeAnalyticsError, estimatedCostDisplay, formatAudioMs, formatUsd, isEmptyReport,
  rangeFor, reportedCostDisplay, sumDecimal, summarize,
} from './analytics-state.ts';

function row(over: Partial<AnalyticsTotals> = {}): AnalyticsTotals {
  const zero = Object.fromEntries(ANALYTICS_COUNT_KEYS.map((k) => [k, 0])) as Record<(typeof ANALYTICS_COUNT_KEYS)[number], number>;
  return { ...zero, userId: null, currency: 'USD', unit: 'text-tokens', reportedTotal: null, estimatedTotal: null,
    spendComplete: true, ...over };
}

describe('rangeFor', () => {
  it('builds millisecond UTC ranges within the 31-day limit', () => {
    const now = Date.parse('2026-11-23T12:00:00.123Z');
    for (const p of ANALYTICS_PRESETS) {
      const { start, end } = rangeFor(p.id, now);
      expect(end).toBe('2026-11-23T12:00:00.123Z');
      expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(end) - Date.parse(start)).toBeLessThanOrEqual(31 * 86_400_000);
    }
    expect(rangeFor('24h', now).start).toBe('2026-11-22T12:00:00.123Z');
  });
});

describe('money', () => {
  it('sums decimals exactly and treats all-null as unknown', () => {
    expect(sumDecimal(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimal(['0.0000001', '2', null])).toBe('2.0000001');
    expect(sumDecimal([null, null])).toBeNull();
  });
  it('formats dollars with at least cents and keeps sub-cent precision', () => {
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd('0.3')).toBe('$0.30');
    expect(formatUsd('1234.5')).toBe('$1,234.50');
    expect(formatUsd('0.0000123')).toBe('$0.000012');
  });
  it('never shows $0 for unknown cost and flags partial spend as an estimate', () => {
    expect(reportedCostDisplay({ reportedTotal: null, spendComplete: false, unknownCostCount: 3, pendingCostCount: 0 }).value)
      .toBe('Unknown');
    const partial = reportedCostDisplay({ reportedTotal: '1.5', spendComplete: false, unknownCostCount: 2, pendingCostCount: 1 });
    expect(partial.value).toBe('$1.50+');
    expect(partial.note).toContain('Estimate');
    expect(reportedCostDisplay({ reportedTotal: '1.5', spendComplete: true, unknownCostCount: 0, pendingCostCount: 0 }))
      .toEqual({ value: '$1.50', note: null });
    expect(estimatedCostDisplay({ estimatedTotal: null }).value).toBe('None');
    expect(estimatedCostDisplay({ estimatedTotal: '0.25' }).note).toContain('Estimated');
  });
});

describe('summarize', () => {
  it('adds counts across units and ANDs spendComplete', () => {
    const s = summarize([
      row({ requestCount: 2, promptTokens: 10, reportedTotal: '0.1', failedCount: 1 }),
      row({ unit: 'voice-audio', requestCount: 3, promptTokens: 5, reportedTotal: '0.2', spendComplete: false }),
    ]);
    expect(s).toMatchObject({ requestCount: 5, promptTokens: 15, failedCount: 1, reportedTotal: '0.3', spendComplete: false });
    expect(summarize([]).reportedTotal).toBeNull();
  });
  it('detects an empty report', () => {
    expect(isEmptyReport([])).toBe(true);
    expect(isEmptyReport([row()])).toBe(true);
    expect(isEmptyReport([row({ requestCount: 1 })])).toBe(false);
  });
});

describe('misc formatting', () => {
  it('formats audio and errors', () => {
    expect(formatAudioMs(45_000)).toBe('45s');
    expect(formatAudioMs(125_000)).toBe('2m 5s');
    expect(describeAnalyticsError('INVALID_REQUEST')).toContain('shorter range');
    expect(describeAnalyticsError('FORBIDDEN')).toContain('super admins');
    expect(describeAnalyticsError('weird')).toBe('Analytics could not be loaded.');
  });
});

describe('createAnalyticsClient', () => {
  const page = { items: [row({ requestCount: 1 })], nextCursor: null };
  it('sends the range and byUser as a same-origin GET and validates the page', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(page), { status: 200 }));
    const client = createAnalyticsClient({ baseUrl: '/api', fetch: fetcher });
    const got = await client.getReport({ start: '2026-11-22T00:00:00.000Z', end: '2026-11-23T00:00:00.000Z', byUser: true });
    expect(got.items).toHaveLength(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('/api/admin/analytics?start=2026-11-22T00%3A00%3A00.000Z&end=2026-11-23T00%3A00%3A00.000Z&byUser=true');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
  });
  it('maps closed error bodies and rejects malformed pages', async () => {
    const forbidden = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: { code: 'FORBIDDEN', retryable: false } }), { status: 403 }));
    await expect(createAnalyticsClient({ fetch: forbidden }).getReport({ start: 'a', end: 'b' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const bad = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ items: [{ unit: 'x' }], nextCursor: null })));
    await expect(createAnalyticsClient({ fetch: bad }).getReport({ start: 'a', end: 'b' }))
      .rejects.toMatchObject({ code: 'INVALID_ADMIN_RESPONSE' });
    expect(isAnalyticsPage(page)).toBe(true);
    expect(isAnalyticsPage({ items: [], nextCursor: 5 })).toBe(false);
  });
});
