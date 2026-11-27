/**
 * ============================================================================
 * FILE: search-controller.ts
 * LOCATION: frontend/src/features/search/search-controller.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Debounced, abortable, stale-safe conversation search state (framework free).
 *
 * ROLE IN PROJECT:
 *    Shared by the sidebar search field and the command palette so both issue the
 *    same GET /sessions/search call and show the same loading/empty/error/degraded states.
 *
 * KEY COMPONENTS:
 *    - createSearchController: setQuery (250 ms debounce, min 2 chars), loadMore, retry.
 *    - SEARCH_DEGRADED_NOTICE / SEARCH_UNSAVED_HINT: user-facing copy.
 * ============================================================================
 */

import type { SearchResult, SearchSessionsResponse } from '../../api/protocol.ts';

export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEGRADED_NOTICE = 'Showing chat titles only; message search is unavailable right now.';
export const SEARCH_UNSAVED_HINT = 'Messages become searchable once they are saved, so the newest messages may not appear yet.';
export const SEARCH_ERROR_NOTICE = 'Search is unavailable. Try again.';

export type SearchState = {
  query: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: SearchResult[];
  nextCursor: string | null;
  degraded: boolean;
  loadingMore: boolean;
};

export type SearchClient = {
  searchSessions(query: string, options?: { cursor?: string | null; limit?: number; signal?: AbortSignal }): Promise<SearchSessionsResponse>;
};

export const IDLE_SEARCH: SearchState = { query: '', status: 'idle', items: [], nextCursor: null, degraded: false, loadingMore: false };

/** One row per chat: title matches win, then the best-ranked message match. */
export function mergeResults(current: SearchResult[], next: SearchResult[]): SearchResult[] {
  const out = [...current];
  for (const item of next) {
    const at = out.findIndex(o => o.sessionId === item.sessionId);
    if (at < 0) out.push(item);
    else if (out[at].match === 'message' && item.match === 'title') out[at] = item;
  }
  return out;
}

export function createSearchController(opts: {
  client: SearchClient;
  onChange: (state: SearchState) => void;
  debounceMs?: number;
}) {
  let state = IDLE_SEARCH;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;
  let seq = 0;
  const set = (next: SearchState) => { state = next; opts.onChange(state); };
  const cancel = () => { clearTimeout(timer); timer = undefined; abort?.abort(); abort = undefined; };

  const run = async (query: string, cursor: string | null) => {
    abort?.abort();
    const ctl = (abort = new AbortController());
    const mine = ++seq;
    try {
      const res = await opts.client.searchSessions(query, { cursor, signal: ctl.signal });
      if (mine !== seq || ctl.signal.aborted) return; // a newer query owns the state
      set({ query, status: 'ready', items: cursor ? mergeResults(state.items, res.items) : res.items,
        nextCursor: res.nextCursor, degraded: res.degraded === true || (cursor !== null && state.degraded), loadingMore: false });
    } catch {
      if (mine !== seq || ctl.signal.aborted) return;
      set({ ...state, query, status: 'error', loadingMore: false });
    }
  };

  return {
    get state() { return state; },
    setQuery(raw: string) {
      cancel();
      seq++;
      const query = raw.trim();
      if (query.length < SEARCH_MIN_CHARS) { set(IDLE_SEARCH); return; }
      set({ ...IDLE_SEARCH, query, status: 'loading' });
      timer = setTimeout(() => { void run(query, null); }, opts.debounceMs ?? SEARCH_DEBOUNCE_MS);
    },
    loadMore() {
      if (!state.nextCursor || state.status !== 'ready' || state.loadingMore) return;
      set({ ...state, loadingMore: true });
      void run(state.query, state.nextCursor);
    },
    retry() {
      if (state.query.length < SEARCH_MIN_CHARS) return;
      cancel();
      set({ ...IDLE_SEARCH, query: state.query, status: 'loading' });
      void run(state.query, null);
    },
    dispose() { cancel(); seq++; },
  };
}
