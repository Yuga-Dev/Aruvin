/**
 * ============================================================================
 * FILE: AnalyticsPanel.tsx
 * LOCATION: frontend/src/features/admin-config/AnalyticsPanel.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Super-admin usage analytics: range presets, summary tiles, unit breakdown
 *    and an optional per-user table.
 *
 * ROLE IN PROJECT:
 *    Presentation over analytics-client; all math/formatting is in
 *    analytics-state.ts. Costs unknown or partial are labelled, never $0.
 *
 * KEY COMPONENTS:
 *    - AnalyticsPanel: Loads totals per preset, optional per-user pages.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';
import type { AnalyticsClient } from '../../api/analytics-client.ts';
import type { AnalyticsTotals } from '../../api/analytics-protocol.ts';
import { Badge, Button, Card, ErrorState, Skeleton } from '../../ui/index.ts';
import {
  ANALYTICS_PRESETS, UNIT_LABELS, describeAnalyticsError, estimatedCostDisplay, formatAudioMs, formatCount,
  isEmptyReport, rangeFor, reportedCostDisplay, summarize, type AnalyticsPresetId, type CostDisplay,
} from './analytics-state.ts';

export type AnalyticsPanelProps = { client: AnalyticsClient };

type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };
const errorMessage = (e: unknown) => describeAnalyticsError((e as { code?: string })?.code ?? '');

function Tile({ label, value, note }: { label: string; value: string } & Partial<CostDisplay>) {
  return (
    <Card className="aurvin-analytics-tile">
      <p className="aurvin-analytics-tile-label">{label}</p>
      <p className="aurvin-analytics-tile-value">{value}</p>
      {note ? <p className="aurvin-analytics-tile-note">{note}</p> : null}
    </Card>
  );
}

function unitDetail(row: AnalyticsTotals): string {
  if (row.unit === 'voice-audio') return formatAudioMs(row.observedAudioMs);
  if (row.unit === 'voice-characters') return `${formatCount(row.billableCharacters)} chars`;
  return `${formatCount(row.promptTokens + row.completionTokens)} tokens`;
}

export function AnalyticsPanel({ client }: AnalyticsPanelProps) {
  const [preset, setPreset] = useState<AnalyticsPresetId>('7d');
  const [byUser, setByUser] = useState(false);
  const [totals, setTotals] = useState<Load<AnalyticsTotals[]>>({ status: 'loading' });
  const [users, setUsers] = useState<Load<{ rows: AnalyticsTotals[]; cursor: string | null }> | null>(null);
  const [range, setRange] = useState(() => rangeFor('7d', Date.now()));
  const [more, setMore] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    const next = rangeFor(preset, Date.now());
    setRange(next);
    setTotals({ status: 'loading' });
    client.getReport(next, abort.signal)
      .then((page) => setTotals({ status: 'ready', data: page.items }))
      .catch((e) => { if (!abort.signal.aborted) setTotals({ status: 'error', message: errorMessage(e) }); });
    return () => abort.abort();
  }, [client, preset, reloads]);

  useEffect(() => {
    if (!byUser) { setUsers(null); return; }
    const abort = new AbortController();
    setUsers({ status: 'loading' });
    client.getReport({ ...rangeFor(preset, Date.now()), byUser: true }, abort.signal)
      .then((page) => setUsers({ status: 'ready', data: { rows: page.items, cursor: page.nextCursor } }))
      .catch((e) => { if (!abort.signal.aborted) setUsers({ status: 'error', message: errorMessage(e) }); });
    return () => abort.abort();
  }, [client, preset, byUser, reloads]);

  const loadMore = useCallback(async () => {
    if (users?.status !== 'ready' || !users.data.cursor) return;
    setMore(true);
    try {
      // Same range as the first page: the cursor is bound to start/end.
      const page = await client.getReport({ ...range, byUser: true, cursor: users.data.cursor });
      setUsers({ status: 'ready', data: { rows: [...users.data.rows, ...page.items], cursor: page.nextCursor } });
    } catch (e) {
      setUsers({ status: 'error', message: errorMessage(e) });
    } finally {
      setMore(false);
    }
  }, [client, range, users]);

  const items = totals.status === 'ready' ? totals.data : null;
  const summary = items ? summarize(items) : null;
  const reload = () => setReloads((n) => n + 1);

  return (
    <div className="aurvin-admin-panel aurvin-analytics">
      <div className="aurvin-admin-panel-header">
        <div>
          <h2 className="aurvin-admin-section-title">Usage analytics</h2>
          <p className="aurvin-admin-help">Requests, tokens and cost across all users (UTC, read-only).</p>
        </div>
      </div>

      <div className="aurvin-analytics-controls">
        <div role="group" aria-label="Date range" className="aurvin-analytics-presets">
          {ANALYTICS_PRESETS.map((p) => (
            <Button key={p.id} size="sm" variant={p.id === preset ? 'primary' : 'secondary'}
              aria-pressed={p.id === preset} onClick={() => setPreset(p.id)}>
              {p.label}
            </Button>
          ))}
        </div>
        <label className="aurvin-analytics-toggle">
          <input type="checkbox" checked={byUser} onChange={(e) => setByUser(e.target.checked)} />
          Break down by user
        </label>
      </div>

      {totals.status === 'loading' ? (
        <div className="aurvin-analytics-tiles" role="status" aria-label="Loading analytics">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={84} width="100%" />)}
        </div>
      ) : null}
      {totals.status === 'error' ? (
        <ErrorState title="Could not load analytics" message={totals.message} actionLabel="Retry" onAction={reload} />
      ) : null}

      {items && isEmptyReport(items) ? (
        <p className="aurvin-admin-help" role="status">No usage recorded in this range.</p>
      ) : null}

      {summary && items && !isEmptyReport(items) ? (
        <>
          <div className="aurvin-analytics-tiles">
            <Tile label="Requests" value={formatCount(summary.requestCount)} />
            <Tile label="Prompt tokens" value={formatCount(summary.promptTokens)} />
            <Tile label="Completion tokens" value={formatCount(summary.completionTokens)} />
            <Tile label="Cached prompt tokens" value={formatCount(summary.cachedPromptTokens)} />
            <Tile label="Reported cost (USD)" {...reportedCostDisplay(summary)} />
            <Tile label="Estimated cost (USD)" {...estimatedCostDisplay(summary)} />
          </div>
          <div className="aurvin-analytics-outcomes" aria-label="Outcomes">
            <Badge tone={summary.failedCount ? 'danger' : 'neutral'}>Failed {formatCount(summary.failedCount)}</Badge>
            <Badge tone={summary.cancelledCount ? 'warning' : 'neutral'}>Cancelled {formatCount(summary.cancelledCount)}</Badge>
            <Badge tone={summary.interruptedCount ? 'warning' : 'neutral'}>Interrupted {formatCount(summary.interruptedCount)}</Badge>
            <Badge tone={summary.truncatedCount ? 'warning' : 'neutral'}>Truncated {formatCount(summary.truncatedCount)}</Badge>
          </div>

          <h3 className="aurvin-analytics-subtitle">By unit</h3>
          <div className="aurvin-table-wrap">
            <table className="aurvin-admin-table" aria-label="Usage by unit">
              <thead>
                <tr><th>Unit</th><th>Requests</th><th>Usage</th><th>Reported (USD)</th><th>Estimated (USD)</th></tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.unit}>
                    <td>{UNIT_LABELS[row.unit]}</td>
                    <td>{formatCount(row.requestCount)}</td>
                    <td>{unitDetail(row)}</td>
                    <td>{reportedCostDisplay(row).value}</td>
                    <td>{estimatedCostDisplay(row).value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {users?.status === 'loading' ? <Skeleton height={120} width="100%" /> : null}
      {users?.status === 'error' ? (
        <ErrorState title="Could not load per-user usage" message={users.message} actionLabel="Retry" onAction={reload} />
      ) : null}
      {users?.status === 'ready' ? (
        <>
          <h3 className="aurvin-analytics-subtitle">By user</h3>
          {users.data.rows.length === 0 ? (
            <p className="aurvin-admin-help" role="status">No per-user usage in this range.</p>
          ) : (
            <div className="aurvin-table-wrap">
              <table className="aurvin-admin-table" aria-label="Usage by user">
                <thead>
                  <tr><th>User</th><th>Unit</th><th>Requests</th><th>Usage</th><th>Reported (USD)</th><th>Estimated (USD)</th></tr>
                </thead>
                <tbody>
                  {users.data.rows.map((row) => (
                    <tr key={`${row.userId}:${row.unit}`}>
                      <td className="aurvin-analytics-user">{row.userId}</td>
                      <td>{UNIT_LABELS[row.unit]}</td>
                      <td>{formatCount(row.requestCount)}</td>
                      <td>{unitDetail(row)}</td>
                      <td>{reportedCostDisplay(row).value}</td>
                      <td>{estimatedCostDisplay(row).value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {users.data.cursor ? (
            <Button size="sm" disabled={more} onClick={() => void loadMore()}>
              {more ? 'Loading' : 'Load more'}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
