/**
 * ============================================================================
 * FILE: use-conversation-search.ts
 * LOCATION: frontend/src/features/search/use-conversation-search.ts
 * ============================================================================
 *
 * PURPOSE:
 *    React binding for the search controller plus result navigation helpers.
 *
 * ROLE IN PROJECT:
 *    Used by Sidebar and CommandPalette; opening a result selects the chat and, only
 *    when the matched message is in the loaded page, scrolls to it (decision D8).
 *
 * KEY COMPONENTS:
 *    - useConversationSearch: state + setQuery/loadMore/retry, disposed on unmount.
 *    - revealMessage: bounded poll for the loaded message element.
 * ============================================================================
 */

import { useEffect, useMemo, useState } from 'react';
import { createSearchController, IDLE_SEARCH, type SearchClient, type SearchState } from './search-controller.ts';

export function useConversationSearch(client: SearchClient) {
  const [state, setState] = useState<SearchState>(IDLE_SEARCH);
  const controller = useMemo(() => createSearchController({ client, onChange: setState }), [client]);
  useEffect(() => () => controller.dispose(), [controller]);
  return { state, setQuery: controller.setQuery, loadMore: controller.loadMore, retry: controller.retry };
}

/** Scroll to a message once it is rendered; gives up quietly if it is not in the loaded page. */
export function revealMessage(messageId: string | undefined, tries = 20): void {
  if (!messageId || typeof document === 'undefined') return;
  const el = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (el) { el.scrollIntoView({ block: 'center' }); return; }
  if (tries > 0) setTimeout(() => revealMessage(messageId, tries - 1), 150);
}
