/**
 * ============================================================================
 * FILE: SidebarSearch.tsx
 * LOCATION: frontend/src/features/search/SidebarSearch.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Sidebar search field and results list for conversation search.
 *
 * ROLE IN PROJECT:
 *    Rendered by Sidebar behind the conversationSearch flag. Empty field means the
 *    normal session list (parent hides it only while a query is active).
 *
 * KEY COMPONENTS:
 *    - SidebarSearch: input, skeleton/empty/error/degraded states, result buttons.
 *    - Snippets render as plain text children, never as HTML.
 * ============================================================================
 */

import { useEffect, useId } from 'react';
import type { SearchResult } from '../../api/protocol.ts';
import { useConversationSearch } from './use-conversation-search.ts';
import './search.css';
import { SEARCH_DEGRADED_NOTICE, SEARCH_ERROR_NOTICE, SEARCH_MIN_CHARS, SEARCH_UNSAVED_HINT, type SearchClient } from './search-controller.ts';

export function SidebarSearch({ client, query, onQueryChange, onOpen, onActiveChange }: {
  client: SearchClient;
  query: string;
  onQueryChange: (query: string) => void;
  onOpen: (result: SearchResult) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const id = useId();
  const search = useConversationSearch(client);
  const { setQuery } = search;
  const { status, items, degraded, nextCursor, loadingMore } = search.state;
  const active = query.trim().length >= SEARCH_MIN_CHARS;
  useEffect(() => { setQuery(query); }, [query, setQuery]);
  useEffect(() => { onActiveChange(active); }, [active, onActiveChange]);
  return (
    <div className="aurvin-sidebar-search">
      <input type="search" className="aurvin-sidebar-search-input" aria-label="Search chats" placeholder="Search chats…"
        value={query} maxLength={100} autoComplete="off" spellCheck={false}
        aria-controls={active ? `${id}-results` : undefined}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onQueryChange(''); }} />
      {active ? (
        <div id={`${id}-results`} className="aurvin-search-results" aria-live="polite">
          {status === 'loading' ? (
            <ul aria-label="Searching" aria-busy="true">{[0, 1, 2].map((i) => <li key={i} className="aurvin-search-skeleton" />)}</ul>
          ) : null}
          {status === 'error' ? (
            <p className="aurvin-session-error" role="alert">{SEARCH_ERROR_NOTICE}{' '}
              <button type="button" className="aurvin-quiet-btn" onClick={search.retry}>Retry</button></p>
          ) : null}
          {status === 'ready' && degraded ? <p className="aurvin-search-note" role="status">{SEARCH_DEGRADED_NOTICE}</p> : null}
          {status === 'ready' && items.length === 0 ? (
            <p className="aurvin-search-note">No chats match. {SEARCH_UNSAVED_HINT}</p>
          ) : null}
          {items.length > 0 ? (
            <ul className="aurvin-session-list" aria-label="Search results">
              {items.map((r) => (
                <li key={r.sessionId} className="aurvin-session-row">
                  <button type="button" className="aurvin-session-item" title={r.title} onClick={() => onOpen(r)}>
                    <div className="aurvin-session-title">{r.title}</div>
                    {r.snippet ? <div className="aurvin-search-snippet">{r.snippet}</div> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {nextCursor && status === 'ready' ? (
            <button type="button" className="aurvin-quiet-btn" disabled={loadingMore} onClick={search.loadMore}>Load more results…</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
