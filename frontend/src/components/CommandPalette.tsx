/**
 * ============================================================================
 * FILE: CommandPalette.tsx
 * LOCATION: frontend/src/components/CommandPalette.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Keyboard-first command palette (Ctrl/Cmd+K) for the Aurvin shell.
 *
 * ROLE IN PROJECT:
 *    Mounted by ChatView. Offers only actions backed by working code: new
 *    chat, Integrations, Settings, theme switching, jumping to a chat by title
 *    among those loaded in the sidebar and, behind the conversationSearch flag,
 *    a server-side "Messages" group (Release 1 unit A).
 *
 * KEY COMPONENTS:
 *    - CommandPalette: combobox + listbox dialog with focus trap
 *    - Filtering and shortcut logic live in command-palette.ts
 * ============================================================================
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDialogFocusTrap } from '../ui/Dialog.tsx';
import { Kbd } from '../ui/primitives.tsx';
import { IconSearch } from './icons.tsx';
import { FEATURE_FLAGS } from '../app/feature-flags.ts';
import { useChat } from '../features/chat/state/chat-context.tsx';
import { revealMessage, useConversationSearch } from '../features/search/use-conversation-search.ts';
import { SEARCH_DEGRADED_NOTICE, SEARCH_ERROR_NOTICE, SEARCH_UNSAVED_HINT } from '../features/search/search-controller.ts';
import { filterPaletteItems, messageSearchItems, type PaletteItem } from './command-palette.ts';
import '../styles/shell.css';

export function CommandPalette({ open, items, onClose, searchEnabled = FEATURE_FLAGS.conversationSearch }:
  { open: boolean; items: readonly PaletteItem[]; onClose: () => void; searchEnabled?: boolean }) {
  if (!open) return null;
  return <PaletteDialog items={items} onClose={onClose} searchEnabled={searchEnabled} />;
}

/** Feeds server message matches into the palette; mounted only when search is enabled (needs ChatProvider). */
function MessageSearchBridge({ query, onItems }: { query: string; onItems: (items: PaletteItem[]) => void }) {
  const { client, actions } = useChat();
  const search = useConversationSearch(client);
  const { setQuery } = search;
  useEffect(() => { setQuery(query); }, [query, setQuery]);
  const { items } = search.state;
  useEffect(() => {
    onItems(messageSearchItems(items.filter((r) => r.match === 'message'), (r) => {
      void actions.selectSession(r.sessionId, r.title);
      revealMessage(r.messageId);
    }));
  }, [items, actions, onItems]);
  const { status, degraded } = search.state;
  return (
    <p className="aurvin-palette-footer" role="status">
      {status === 'loading' ? 'Searching messages…'
        : status === 'error' ? <>{SEARCH_ERROR_NOTICE} <button type="button" className="aurvin-quiet-btn" onClick={search.retry}>Retry</button></>
        : degraded ? SEARCH_DEGRADED_NOTICE : SEARCH_UNSAVED_HINT}
    </p>
  );
}

function PaletteDialog({ items, onClose, searchEnabled }: { items: readonly PaletteItem[]; onClose: () => void; searchEnabled: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ids = useId();
  const listId = `${ids}-list`;
  const [found, setFound] = useState<PaletteItem[]>([]);
  const results = useMemo(() => filterPaletteItems([...items, ...found], query), [items, found, query]);
  const activeIndex = Math.min(active, Math.max(results.length - 1, 0));

  useDialogFocusTrap(dialogRef, { open: true, onEscape: onClose, initialFocusRef: inputRef });

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div className="aurvin-palette-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialogRef} className="aurvin-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="aurvin-palette-search">
          <IconSearch />
          <input
            ref={inputRef}
            className="aurvin-palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? `${ids}-opt-${activeIndex}` : undefined}
            aria-label="Search commands and loaded chats"
            placeholder="Search commands and chats…"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((activeIndex + 1) % Math.max(results.length, 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((activeIndex - 1 + results.length) % Math.max(results.length, 1));
              } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                run(results[activeIndex]);
              }
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul id={listId} className="aurvin-palette-list" role="listbox" aria-label="Results">
          {results.length === 0 ? (
            <li className="aurvin-palette-empty" role="presentation">No matching commands or loaded chats.</li>
          ) : null}
          {results.map((item, index) => {
            const heading = index === 0 || results[index - 1].group !== item.group ? item.group : null;
            return [
              heading ? (
                <li key={`h-${heading}`} className="aurvin-palette-group" role="presentation">{heading}</li>
              ) : null,
              <li
                key={item.id}
                id={`${ids}-opt-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className="aurvin-palette-option"
                onMouseMove={() => { if (index !== activeIndex) setActive(index); }}
                onClick={() => run(item)}
              >
                <span className="aurvin-palette-label">{item.label}</span>
                {item.hint ? <span className="aurvin-palette-hint">{item.hint}</span> : null}
              </li>,
            ];
          })}
        </ul>
        {searchEnabled
          ? <MessageSearchBridge query={query} onItems={setFound} />
          : <p className="aurvin-palette-footer">Chats are searched by title among those loaded in the sidebar.</p>}
      </div>
    </div>
  );
}
