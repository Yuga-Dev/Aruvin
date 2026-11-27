/**
 * ============================================================================
 * FILE: CommandPalette.test.ts
 * LOCATION: frontend/src/components/CommandPalette.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify command palette filtering, shortcut detection and markup.
 *
 * ROLE IN PROJECT:
 *    Locks the Ctrl/Cmd+K contract (no clash with Alt+M/X/C voice
 *    shortcuts), group ordering, the conversation cap, and accessible
 *    combobox/listbox semantics rendered server-side in Node.
 *
 * KEY COMPONENTS:
 *    - filterPaletteItems, isPaletteShortcut, CommandPalette markup
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommandPalette } from './CommandPalette.tsx';
import {
  PALETTE_CONVERSATION_LIMIT,
  filterPaletteItems,
  isPaletteShortcut,
  messageSearchItems,
  type PaletteItem,
} from './command-palette.ts';

const noop = () => undefined;
const items: PaletteItem[] = [
  { id: 'theme-dark', group: 'Theme', label: 'Dark theme', run: noop },
  { id: 'new-chat', group: 'Actions', label: 'New chat', run: noop },
  { id: 'nav-settings', group: 'Actions', label: 'Open Settings', run: noop },
  { id: 's1', group: 'Conversations', label: 'Quarterly budget review', run: noop },
  { id: 's2', group: 'Conversations', label: 'Budget for the offsite', hint: 'Pinned', run: noop },
];

describe('message search group', () => {
  it('palette adds a message-search group without breaking local filtering', () => {
    const found = messageSearchItems([
      { sessionId: 'x1', title: 'Offsite', lastActivityAt: '2026-01-01T00:00:00.000Z', match: 'message', snippet: 'we agreed on <b>venue</b>', messageId: 'm1' },
    ], noop);
    expect(found[0]).toMatchObject({ group: 'Messages', label: 'Offsite', hint: 'we agreed on <b>venue</b>' });
    const all = [...items, ...found];
    // Server-ranked rows survive a query their label does not contain; local rows still filter.
    expect(filterPaletteItems(all, 'venue').map((i) => i.id)).toEqual(['search-x1']);
    expect(filterPaletteItems(all, 'budget').map((i) => i.id)).toEqual(['s2', 's1', 'search-x1']);
    expect(filterPaletteItems(all, '').map((i) => i.group)).toEqual(['Actions', 'Actions', 'Conversations', 'Conversations', 'Messages', 'Theme']);
  });
});

describe('filterPaletteItems', () => {
  it('orders groups Actions, Conversations, Theme for an empty query', () => {
    expect(filterPaletteItems(items, '').map((i) => i.id)).toEqual(['new-chat', 'nav-settings', 's1', 's2', 'theme-dark']);
  });

  it('matches every term case-insensitively and ranks label prefixes first', () => {
    expect(filterPaletteItems(items, 'BUDGET').map((i) => i.id)).toEqual(['s2', 's1']);
    expect(filterPaletteItems(items, 'budget review').map((i) => i.id)).toEqual(['s1']);
    expect(filterPaletteItems(items, 'pinned').map((i) => i.id)).toEqual(['s2']);
    expect(filterPaletteItems(items, 'nothing-here')).toEqual([]);
  });

  it('caps conversations so a long history cannot flood the list', () => {
    const many = Array.from({ length: 30 }, (_, n): PaletteItem => ({ id: `c${n}`, group: 'Conversations', label: `Chat ${n}`, run: noop }));
    expect(filterPaletteItems(many, 'chat')).toHaveLength(PALETTE_CONVERSATION_LIMIT);
  });
});

describe('isPaletteShortcut', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;
  it('accepts Ctrl+K and Cmd+K only', () => {
    expect(isPaletteShortcut(key('k', { ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key('K', { metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key('k'))).toBe(false);
    expect(isPaletteShortcut(key('k', { ctrlKey: true, shiftKey: true }))).toBe(false);
    for (const voiceKey of ['m', 'x', 'c']) expect(isPaletteShortcut(key(voiceKey, { altKey: true }))).toBe(false);
  });
});

describe('CommandPalette markup', () => {
  it('renders nothing when closed', () => {
    expect(renderToStaticMarkup(createElement(CommandPalette, { open: false, items, onClose: noop }))).toBe('');
  });

  it('renders an accessible modal combobox with a selected first option', () => {
    const html = renderToStaticMarkup(createElement(CommandPalette, { open: true, items, onClose: noop }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
    expect(html).toMatch(/role="option" aria-selected="true"[^>]*>.*New chat/);
    expect(html).toContain('loaded in the sidebar');
  });
});
