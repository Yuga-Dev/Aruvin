/**
 * ============================================================================
 * FILE: analytics-client.ts
 * LOCATION: frontend/src/api/analytics-client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Same-origin, bounded GET client for the super-admin analytics report.
 *
 * ROLE IN PROJECT:
 *    Feeds the Manage Aurvin Analytics tab; reuses the administration error
 *    type so failures present through one closed, safe vocabulary.
 *
 * KEY COMPONENTS:
 *    - createAnalyticsClient: Factory with a single getReport call.
 * ============================================================================
 */

import { AdministrationClientError } from './administration-client.ts';
import { isAdministrationErrorResponse } from './administration-protocol.ts';
import { ANALYTICS_ROUTE, isAnalyticsPage, type AnalyticsPage, type AnalyticsQuery } from './analytics-protocol.ts';

const REQUEST_TIMEOUT_MS = 30_000;

export type AnalyticsClient = {
  getReport(query: AnalyticsQuery, signal?: AbortSignal): Promise<AnalyticsPage>;
};

function readViteApiBase(): string | undefined {
  try {
    return (import.meta.env as { VITE_API_BASE?: string } | undefined)?.VITE_API_BASE;
  } catch {
    return undefined;
  }
}

export function createAnalyticsClient(options?: { baseUrl?: string; fetch?: typeof fetch }): AnalyticsClient {
  const baseUrl = (options?.baseUrl ?? readViteApiBase() ?? '/api').replace(/\/+$/, '');
  const fetcher = options?.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async getReport(query, signal) {
      const params = new URLSearchParams({ start: query.start, end: query.end });
      if (query.byUser) params.set('byUser', 'true');
      if (query.cursor) params.set('cursor', query.cursor);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      try {
        const response = await fetcher(`${baseUrl}${ANALYTICS_ROUTE}?${params}`, {
          method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'same-origin',
          headers: { Accept: 'application/json' }, signal: combined,
        });
        let payload: unknown;
        try { payload = await response.json(); } catch { payload = undefined; }
        if (!response.ok) {
          if (isAdministrationErrorResponse(payload)) {
            throw new AdministrationClientError({
              code: payload.error.code, status: response.status, retryable: payload.error.retryable,
            });
          }
          throw new AdministrationClientError({ code: 'INVALID_ADMIN_RESPONSE', status: response.status });
        }
        if (!isAnalyticsPage(payload)) throw new AdministrationClientError({ code: 'INVALID_ADMIN_RESPONSE' });
        return payload;
      } catch (error) {
        if (error instanceof AdministrationClientError) throw error;
        throw new AdministrationClientError({
          code: combined.aborted ? (timeout.signal.aborted ? 'ADMIN_REQUEST_TIMEOUT' : 'ABORTED') : 'NETWORK_ERROR',
          retryable: true,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
