/**
 * ============================================================================
 * FILE: search-client.test.ts
 * LOCATION: frontend/src/features/search/search-client.test.ts
 * ============================================================================
 * PURPOSE: Verify debounce, abort, stale-response and degraded handling of conversation search.
 * ROLE IN PROJECT: Node-only checks of the framework-free search controller.
 * KEY COMPONENTS: createSearchController with a deferred fake client and fake timers.
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchSessionsResponse } from '../../api/protocol.ts';
import {
  SEARCH_DEBOUNCE_MS, SEARCH_DEGRADED_NOTICE, createSearchController, type SearchClient, type SearchState,
} from './search-controller.ts';

const hit = (id: string, match: 'title' | 'message' = 'title') => ({ sessionId: id, title: id, lastActivityAt: '2026-01-01T00:00:00.000Z', match });

function harness() {
  const calls: Array<{ q: string; signal?: AbortSignal; resolve: (r: SearchSessionsResponse) => void }> = [];
  const client: SearchClient = {
    searchSessions: (q, o) => new Promise((resolve) => { calls.push({ q, signal: o?.signal, resolve }); }),
  };
  let last!: SearchState;
  const c = createSearchController({ client, onChange: (s) => { last = s; } });
  return { c, calls, state: () => last };
}

describe('conversation search controller', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ignores a stale search response', async () => {
    const h = harness();
    h.c.setQuery('alpha');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.c.setQuery('alpha beta');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(h.calls).toHaveLength(2);
    h.calls[1].resolve({ items: [hit('new')], nextCursor: null });
    await Promise.resolve();
    h.calls[0].resolve({ items: [hit('old')], nextCursor: null });
    await Promise.resolve();
    expect(h.state().items.map((i) => i.sessionId)).toEqual(['new']);
    expect(h.state().query).toBe('alpha beta');
  });

  it('debounces and aborts the previous request', async () => {
    const h = harness();
    h.c.setQuery('al');
    h.c.setQuery('alp');
    h.c.setQuery('alph');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls.map((c) => c.q)).toEqual(['alph']);
    h.c.setQuery('alphabet');
    expect(h.calls[0].signal?.aborted).toBe(true);
    h.c.setQuery('a'); // below the 2 character minimum: idle, nothing sent
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(h.calls).toHaveLength(1);
    expect(h.state().status).toBe('idle');
  });

  it('shows title-only notice when degraded', async () => {
    const h = harness();
    h.c.setQuery('budget');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.calls[0].resolve({ items: [hit('t1')], nextCursor: null, degraded: true });
    await Promise.resolve();
    expect(h.state()).toMatchObject({ status: 'ready', degraded: true });
    expect(SEARCH_DEGRADED_NOTICE).toMatch(/titles only/);
  });

  it('merges pages by chat and keeps the title match', async () => {
    const h = harness();
    h.c.setQuery('budget');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    h.calls[0].resolve({ items: [hit('a', 'message')], nextCursor: 'c1' });
    await Promise.resolve();
    h.c.loadMore();
    h.calls[1].resolve({ items: [hit('a', 'title'), hit('b', 'message')], nextCursor: null });
    await Promise.resolve();
    expect(h.state().items.map((i) => `${i.sessionId}:${i.match}`)).toEqual(['a:title', 'b:message']);
  });
});
