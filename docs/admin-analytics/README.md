# Admin analytics

The Analytics tab in Manage Aurvin shows usage and cost for a UTC date range. It is
super-admin only and read-only. It reuses the bounded accounting reporting layer
(`backend/src/persistence/accounting-reporting.ts`); no new aggregation exists.

## Endpoint

`GET /api/admin/analytics?start=<UTC ISO ms>&end=<UTC ISO ms>[&byUser=true][&cursor=<opaque>]`

- `start` and `end` must be UTC ISO strings with milliseconds (`2026-11-22T12:00:00.000Z`),
  `end > start`, range at most 31 days.
- `byUser=true` returns one row per user and unit, paged by `nextCursor`. The cursor is bound
  to the same `start`/`end`/`byUser`. Without it, one row per unit (at most three).
- Any other parameter (including `limit` and `userId`) is rejected with 400. Page size is fixed
  by the server at `min(50, MAX_PAGE_SIZE)`.
- Response: `{ items: AccountingTotals[], nextCursor: string | null }`. Money is a decimal
  string or `null`. Responses are `no-store`.
- Errors use the closed `{ error: { code, retryable } }` body: 401 unauthenticated, 403 not a
  super admin (enforced by private HTTP admission and again in the controller), 400 invalid
  query or a range with too many records (narrow the range), 503 storage not ready.

Code: `backend/src/admin-analytics/`; wired in `app.module.ts`
and `AppService.adminAccountingTotals`.

## Frontend

`AnalyticsPanel` (`frontend/src/features/admin-config/`) with presets 24 hours, 7 days and
30 days, summary tiles, an outcome row (failed, cancelled, interrupted, truncated), a by-unit
table and an optional by-user table. Summary tiles always come from the non-`byUser` call so
they are complete; the by-user table loads more pages on demand.

Cost labelling (`analytics-state.ts`):

- No reported cost: `Unknown`, never `$0`.
- Reported cost with `spendComplete` false on any row: shown as `$X+` with an "Estimate" note.
- Estimated cost is a separate tile and is labelled as not provider-reported.

## Tests

- Backend: `npx vitest run src/admin-analytics`
- Frontend: `npx vitest run src/features/admin-config/analytics-state.test.ts`
