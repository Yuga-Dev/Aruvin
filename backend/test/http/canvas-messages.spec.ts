/**
 * ============================================================================
 * FILE: canvas-messages.spec.ts
 * LOCATION: backend/test/http/canvas-messages.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify listMessages exposes pre-page Canvas artifacts without extra
 *    routine fetch calls on the durable archive fallback.
 *
 * ROLE IN PROJECT:
 *    Covers the HTTP projection that keeps older Calendar/diagram Canvases in
 *    the UI Canvas panel and voice inventory after transcript paging.
 *
 * KEY COMPONENTS:
 *    - Initial page walk and canvasMessages projection.
 *    - limit=1 and complete-history call-count guards.
 *    - In-memory runtime passthrough.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { ChatHttpService } from '../../src/http/chat-http.service.js';
import type { VisibleMessage } from '../../src/contracts/api.js';
import { agendaFixture } from '../contracts/calendar-view.fixture.js';
import { fixtureOptions } from './fixtures.js';

const message = (sequence: number, extra: Partial<VisibleMessage> = {}): VisibleMessage => ({
  messageId: `m${sequence}`,
  turnId: `t${sequence}`,
  eventId: `e${sequence}`,
  sequence,
  role: 'assistant',
  content: '',
  createdAt: '2026-11-11T10:00:00.000Z',
  completionStatus: 'completed',
  truncated: false,
  ...extra,
});

const diagram = message(2, { content: 'Here it is.\n\n```mermaid\nflowchart TD\nA --> B\n```' });
const calendar = message(3, { calendarView: agendaFixture() });

it('returns older Calendar and diagram Canvases from the page walk on the initial load', async () => {
  const o = fixtureOptions();
  const list = vi.fn(async (_userId: string, _sessionId: string,
    page: { cursor: string | null; limit: number }) => page.cursor === null
    ? { items: [message(10), message(11)], nextCursor: 'page-2', olderAvailable: true }
    : { items: [diagram, calendar, message(1)], nextCursor: null, olderAvailable: false });
  o.messages.list = list as never;
  const s = new ChatHttpService(o);
  const result = await s.messages('s1', {});
  expect(list).toHaveBeenCalledTimes(2);
  expect(list.mock.calls[0]![2]).toEqual({ cursor: null, limit: 20 });
  expect(list.mock.calls[1]![2]).toEqual({ cursor: 'page-2', limit: o.budgets.maxPageSize });
  expect(result.items.map(item => item.messageId)).toEqual(['m10', 'm11']);
  expect(result.canvasMessages?.map(item => item.messageId)).toEqual(['m2', 'm3']);
});

it('omits canvasMessages and skips the older walk for limit=1 polls', async () => {
  const o = fixtureOptions();
  const list = vi.fn(async () => ({ items: [message(10)], nextCursor: 'page-2', olderAvailable: true }));
  o.messages.list = list as never;
  const s = new ChatHttpService(o);
  const result = await s.messages('s1', { limit: '1' });
  expect(list).toHaveBeenCalledTimes(1);
  expect(result.canvasMessages).toBeUndefined();
});

it('skips the older walk when the initial page is already complete', async () => {
  const o = fixtureOptions();
  const list = vi.fn(async () => ({ items: [message(10)], nextCursor: null, olderAvailable: false }));
  o.messages.list = list as never;
  const s = new ChatHttpService(o);
  const result = await s.messages('s1', {});
  expect(list).toHaveBeenCalledTimes(1);
  expect(result.canvasMessages).toBeUndefined();
});

it('passes memory-first canvasMessages through without a durable list read', async () => {
  const o = fixtureOptions();
  const list = vi.fn(async () => ({ items: [], nextCursor: null, olderAvailable: false }));
  o.messages.list = list as never;
  o.runtime.memoryMessages = vi.fn(() => ({ items: [message(10)], nextCursor: null,
    olderAvailable: true, canvasMessages: [diagram] }));
  const s = new ChatHttpService(o);
  const result = await s.messages('s1', {});
  expect(list).not.toHaveBeenCalled();
  expect(result.canvasMessages?.map(item => item.messageId)).toEqual(['m2']);
});
