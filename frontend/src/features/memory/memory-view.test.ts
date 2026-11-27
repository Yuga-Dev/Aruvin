/**
 * ============================================================================
 * FILE: memory-view.test.ts
 * LOCATION: frontend/src/features/memory/memory-view.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the Memory view state helpers, markup, and section/history client.
 *
 * ROLE IN PROJECT:
 *    Node-only Vitest checks (server render, reducer, fake fetch). Click and
 *    keyboard behavior in a real browser is not exercised here.
 *
 * KEY COMPONENTS:
 *    - Section budget validation, history gap detection, flag gating
 *    - MemoryView server markup for ready, conflict, empty, and history states
 *    - Client PATCH /sections/:key and GET /history wire behavior
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createUserMemoryClient, UserMemoryClientError } from '../../api/user-memory-client.ts';
import {
  emptyUserMemorySections,
  renderUserMemorySections,
  USER_MEMORY_MAX_CHARS,
  userMemoryCharCount,
  type MemoryAuditView,
  type UserMemoryResponse,
  type UserMemorySections,
} from '../../api/user-memory-protocol.ts';
import {
  initialUserMemoryState,
  userMemoryReducer,
  type UserMemoryState,
} from '../personalization/user-memory-state.ts';
import { MemoryView, type MemoryHistoryState } from './MemoryView.tsx';
import {
  describeHistoryEntry,
  historyHasGap,
  memoryViewEnabled,
  sectionDraftError,
  sectionUsage,
} from './memory-state.ts';

function memoryResponse(sections: Partial<UserMemorySections> = {}, revision = 3): UserMemoryResponse {
  const full = { ...emptyUserMemorySections(), ...sections };
  const rendered = renderUserMemorySections(full);
  return {
    protocolVersion: 1,
    revision,
    enabled: true,
    sections: full,
    isEmpty: rendered === '',
    charCount: userMemoryCharCount(rendered),
    maxChars: USER_MEMORY_MAX_CHARS,
    updatedAt: '2026-11-20T12:00:00.000Z',
  };
}

function readyState(sections: Partial<UserMemorySections> = {}): UserMemoryState {
  return userMemoryReducer(initialUserMemoryState(), { type: 'loaded', response: memoryResponse(sections) });
}

function audit(revision: number, overrides: Partial<MemoryAuditView> = {}): MemoryAuditView {
  return {
    memoryRevision: revision,
    at: '2026-11-21T10:00:00.000Z',
    action: 'edit-section',
    source: 'user-ui',
    sections: ['work'],
    charsBefore: 10,
    charsAfter: 25,
    ...overrides,
  };
}

const noHistory: MemoryHistoryState = { status: 'ready', items: [], nextCursor: null };

function render(state: UserMemoryState, history = noHistory): string {
  return renderToStaticMarkup(createElement(MemoryView, { initialState: state, initialHistory: history }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('memory view', () => {
  it('shows sections with counts and last updated', () => {
    const html = render(readyState({ identity: 'Name: Peter', work: 'Engineer' }));
    expect(html).toContain('Identity');
    expect(html).toContain('Name: Peter');
    expect(html).toContain('11 chars');
    expect(html).toContain('Nothing saved.');
    expect(html).toContain('updated ');
    expect(html).toContain('aria-label="Edit Work"');
    expect(html).toContain('aria-label="Clear Work"');
  });

  it('renders memory text as plain text, never HTML', () => {
    const html = render(readyState({ other: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('shows the empty state', () => {
    expect(render(readyState())).toContain('hasn&#x27;t remembered anything yet');
  });

  it('direct section edit enforces the character budget client-side', () => {
    const sections = { ...emptyUserMemorySections(), identity: 'a'.repeat(2400) };
    expect(sectionDraftError(sections, 'work', 'short')).toBeNull();
    expect(sectionDraftError(sections, 'work', 'b'.repeat(200))).toContain('limit');
    expect(sectionDraftError(sections, 'work', 'key sk-or-v1-abc')).not.toBeNull();
    expect(sectionDraftError(sections, 'work', 'bad\u0000text')).toContain('control');
    expect(sectionDraftError(sections, 'identity', '')).toBeNull();
    const usage = sectionUsage(sections, 'work', 'hello');
    expect(usage.max).toBe(USER_MEMORY_MAX_CHARS);
    expect(usage.used).toBeGreaterThan(2400);
  });

  it('clear section asks for confirmation and states chats are not deleted', () => {
    const html = render(readyState({ work: 'Engineer' }));
    // The two-step inline confirm shares this wording; Clear all uses ConfirmDialog (closed by default).
    expect(html).toContain('does not delete your chats');
    expect(html).not.toContain('Clear Work?');
    expect(html).not.toContain('role="dialog"');
  });

  it('conflict keeps the draft and reloads', () => {
    const state = userMemoryReducer(readyState({ work: 'Engineer' }), {
      type: 'failed',
      code: 'MEMORY_CONFLICT',
      message: 'Memory changed in another tab. Reload to see the latest, then try again.',
      currentRevision: 4,
    });
    expect(state.conflictRevision).toBe(4);
    const html = render(state);
    expect(html).toContain('Memory changed in another tab');
    expect(html).toContain('Your draft is kept');
    expect(html).toContain('Reload memory');
    // Editing and saving are blocked until the user reloads.
    expect(html).toMatch(/aria-label="Edit Work"[^>]*disabled|disabled=""[^>]*aria-label="Edit Work"/);
    // Reload dispatches `loading` then `loaded`: the new revision replaces the stale one.
    const reloaded = userMemoryReducer(userMemoryReducer(state, { type: 'loading' }), {
      type: 'loaded',
      response: memoryResponse({ work: 'Manager' }, 4),
    });
    expect(reloaded.conflictRevision).toBeNull();
    expect(reloaded.revision).toBe(4);
  });

  it('history shows source, sections and size change without text', () => {
    const entry = audit(5, { source: 'passive', action: 'passive', sections: ['identity', 'work'] });
    const row = describeHistoryEntry(entry);
    expect(row).toMatchObject({ source: 'Aurvin', sections: 'Identity, Work' });
    expect(row.size).toContain('+15');
    const html = render(readyState({ work: 'Engineer' }), { status: 'ready', items: [entry], nextCursor: null });
    expect(html).toContain('Learned from chat');
    expect(html).toContain('Identity, Work');
    expect(html).toContain('10 to 25 characters');
    expect(html).not.toContain('Some history is unavailable');
  });

  it('history gap shows the unavailable notice', () => {
    expect(historyHasGap([audit(7), audit(6), audit(5)])).toBe(false);
    expect(historyHasGap([audit(7), audit(5)])).toBe(true);
    const html = render(readyState({ work: 'x' }), { status: 'ready', items: [audit(7), audit(5)], nextCursor: null });
    expect(html).toContain('Some history is unavailable');
  });

  it('history failure leaves the memory view usable', () => {
    const html = render(readyState({ work: 'Engineer' }), { status: 'error', items: [], nextCursor: null });
    expect(html).toContain('History is unavailable right now');
    expect(html).toContain('Engineer');
  });

  it('hidden when the memory flag is off', () => {
    expect(memoryViewEnabled()).toBe(false);
    expect(memoryViewEnabled({ memory: false })).toBe(false);
    expect(memoryViewEnabled({ memory: true })).toBe(true);
  });
});

describe('memory section and history client', () => {
  it('PATCHes a section with revision, request id and text', async () => {
    const fetcher = vi.fn(async () => jsonResponse(memoryResponse({ work: '' }, 4)));
    const client = createUserMemoryClient({ baseUrl: '/api', fetch: fetcher as unknown as typeof fetch });
    await client.editSection('work', { protocolVersion: 1, expectedRevision: 3, requestId: 'req-12345678', text: '' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/personalization/memory/sections/work');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      protocolVersion: 1,
      expectedRevision: 3,
      requestId: 'req-12345678',
      text: '',
    });
  });

  it('rejects a bad section key or request id before the network', async () => {
    const fetcher = vi.fn();
    const client = createUserMemoryClient({ baseUrl: '/api', fetch: fetcher as unknown as typeof fetch });
    const base = { protocolVersion: 1 as const, expectedRevision: 1, text: 'x' };
    await expect(
      client.editSection('work', { ...base, requestId: 'no spaces allowed' }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_MEMORY_REQUEST' });
    await expect(
      client.editSection('../x' as never, { ...base, requestId: 'req-12345678' }),
    ).rejects.toBeInstanceOf(UserMemoryClientError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps a 409 conflict to MEMORY_CONFLICT with the current revision', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        { protocolVersion: 1, error: { code: 'MEMORY_CONFLICT', message: 'x', retryable: false, currentRevision: 9 } },
        409,
      ),
    );
    const client = createUserMemoryClient({ baseUrl: '/api', fetch: fetcher as unknown as typeof fetch });
    await expect(
      client.editSection('work', { protocolVersion: 1, expectedRevision: 3, requestId: 'req-12345678', text: 'y' }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT', currentRevision: 9 });
  });

  it('reads history with a capped limit and validates the shape', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ items: [audit(2)], nextCursor: 'abc' }));
    const client = createUserMemoryClient({ baseUrl: '/api', fetch: fetcher as unknown as typeof fetch });
    const page = await client.history({ cursor: 'c1', limit: 500 });
    expect(page.items).toHaveLength(1);
    const [url] = fetcher.mock.calls[0] as unknown as [string];
    expect(url).toBe('/api/personalization/memory/history?cursor=c1&limit=50');

    const bad = vi.fn(async () => jsonResponse({ items: [{ memoryRevision: 1 }], nextCursor: null }));
    const badClient = createUserMemoryClient({ baseUrl: '/api', fetch: bad as unknown as typeof fetch });
    await expect(badClient.history()).rejects.toMatchObject({ code: 'INVALID_USER_MEMORY_RESPONSE' });
  });
});
