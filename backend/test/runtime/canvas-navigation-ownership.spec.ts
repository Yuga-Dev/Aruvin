/**
 * ============================================================================
 * FILE: canvas-navigation-ownership.spec.ts
 * LOCATION: backend/test/runtime/canvas-navigation-ownership.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify trusted Canvas ownership intersection, model projection, and the
 *    bounded local navigation outcome.
 *
 * ROLE IN PROJECT:
 *    Pure unit coverage over already-loaded message records: no repository,
 *    provider, or presentation dependency is constructed here.
 *
 * KEY COMPONENTS:
 *    - navigateCanvas: Mode, membership, activity and queue admission outcomes.
 *    - ownedCanvasInventory: Message/response/Calendar owner intersection.
 *    - canvasModelInventory: Ownership-free bounded model metadata.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { canvasModelInventory, canvasTurnState, canvasTurnStateMessage, controlCanvas,
  isRedundantCanvasControl, navigateCanvas, ownedCanvasInventory,
  ownedCanvasSelection } from '../../src/chat-runtime/canvas-navigation.js';
import { messageRecordSchema } from '../../src/contracts/message.js';
import type { MessageRecord } from '../../src/contracts/message.js';
import type { CanvasInventorySnapshot } from '../../src/contracts/canvas-navigation.js';

const AT = '2026-11-04T10:00:00.000Z';
const notice = { viewVersion: 1 as const, kind: 'notice' as const, state: 'unavailable' as const,
  message: 'Calendar is unavailable.', proposalId: null, intentId: null, tool: null, coverage: null,
  conflict: null, limitations: [] };

function record(overrides: Record<string, unknown> = {}): MessageRecord {
  return messageRecordSchema.parse({ schemaVersion: 1, userId: 'user-1', sessionId: 'session-1',
    turnId: 'turn-1', attemptId: 'attempt-1', messageId: 'message-1', eventId: 'event-1', sequence: 1,
    role: 'assistant', content: 'Answer', createdAt: AT, completionStatus: 'completed', truncated: false,
    ...overrides });
}

const assistant = (overrides: Record<string, unknown> = {}) => record(overrides);
const live = (overrides: Record<string, unknown> = {}) => assistant({ mode: 'live', visibility: 'internal',
  voiceSessionId: 'voice-1', ...overrides });

function snapshot(items: CanvasInventorySnapshot['items'], omitted = 0): CanvasInventorySnapshot {
  return { items, omitted };
}

const messageItem = (messageId: string, title = 'Pricing comparison', ordinal = 0) => ({
  canvasId: `${messageId}::canvas::${ordinal}`, title,
  owner: { kind: 'message' as const, id: messageId } });

it('gates trusted mode before presentation and never falls back to another target', () => {
  const show = vi.fn(() => true);
  const target = 'old-response::canvas::0';
  const base = { envelope: { canvas_id: target },
    inventory: { items: [{ canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'response' as const, id: 'old-response' } }], omitted: 0 },
    show, active: () => true };
  expect(navigateCanvas({ ...base, responseMode: 'text' })).toEqual({
    kind: 'canvas-navigation', outcome: 'mode-not-allowed', canvas_id: target });
  expect(show).not.toHaveBeenCalled();
  expect(navigateCanvas({ ...base, envelope: { canvas_id: 'missing::canvas::0' }, responseMode: 'voice' }))
    .toMatchObject({ outcome: 'unavailable' });
  expect(show).not.toHaveBeenCalled();
  expect(navigateCanvas({ ...base, responseMode: 'voice' }))
    .toEqual({ kind: 'canvas-navigation', outcome: 'requested', canvas_id: target });
  expect(show).toHaveBeenCalledExactlyOnceWith(target);
});

it('reports bounded delivery failure for a refused, throwing, or ended presentation', () => {
  const target = 'old-message::canvas::0';
  const base = { envelope: { canvas_id: target }, responseMode: 'voice' as const,
    inventory: snapshot([messageItem('old-message')]) };
  const refused = vi.fn(() => false);
  expect(navigateCanvas({ ...base, active: () => true, show: refused }))
    .toEqual({ kind: 'canvas-navigation', outcome: 'delivery-unavailable', canvas_id: target });
  expect(refused).toHaveBeenCalledExactlyOnceWith(target);
  const throwing = vi.fn((): boolean => { throw new Error('presentation rejected'); });
  expect(navigateCanvas({ ...base, active: () => true, show: throwing }))
    .toEqual({ kind: 'canvas-navigation', outcome: 'delivery-unavailable', canvas_id: target });
  const ended = vi.fn(() => true);
  expect(navigateCanvas({ ...base, active: () => false, show: ended }))
    .toEqual({ kind: 'canvas-navigation', outcome: 'delivery-unavailable', canvas_id: target });
  expect(ended).not.toHaveBeenCalled();
});

it('rejects invalid or extended native arguments without a presentation effect', () => {
  const show = vi.fn(() => true);
  const base = { responseMode: 'voice' as const, inventory: snapshot([messageItem('old-message')]),
    active: () => true, show };
  for (const envelope of [{}, { canvas_id: '' }, { canvas_id: 'bad id' },
    { canvas_id: 'old-message::canvas::0', mode: 'voice' },
    { canvas_id: 'old-message::canvas::0', conversationId: 'other' }]) {
    expect(navigateCanvas({ ...base, envelope }))
      .toEqual({ kind: 'canvas-navigation', outcome: 'invalid-arguments', canvas_id: null });
  }
  expect(show).not.toHaveBeenCalled();
});

it('intersects ordinary text owners with this user, conversation and assistant role', () => {
  const records = [assistant({ messageId: 'owned-message' }),
    assistant({ messageId: 'foreign-user', userId: 'user-2' }),
    assistant({ messageId: 'foreign-session', sessionId: 'session-2' }),
    record({ role: 'user', messageId: 'user-message' })];
  const filtered = ownedCanvasInventory(snapshot([
    messageItem('owned-message'),
    messageItem('foreign-user'),
    messageItem('foreign-session'),
    messageItem('user-message'),
    messageItem('missing-message'),
    { canvasId: 'owned-message::canvas::01', title: 'Non canonical ordinal',
      owner: { kind: 'message', id: 'owned-message' } },
    { canvasId: 'owned-message::canvas::1x', title: 'Loose suffix',
      owner: { kind: 'message', id: 'owned-message' } },
    { canvasId: 'another::canvas::0', title: 'Mismatched owner prefix',
      owner: { kind: 'message', id: 'owned-message' } },
  ]), records, 'user-1', 'session-1');
  expect(filtered.items.map(item => item.canvasId)).toEqual(['owned-message::canvas::0']);
  expect(filtered.omitted).toBe(7);
  expect(ownedCanvasInventory(snapshot([messageItem('owned-message')], 5), records, 'user-1', 'session-1').omitted)
    .toBe(5);
});

it('requires an exact typed projection for response-owned Canvas IDs', () => {
  const records = [live({ messageId: 'voice-message',
    canvasArtifacts: [{ responseId: 'response-a', ordinal: 0, kind: 'chart', subType: 'bar',
      title: 'Revenue', rawSource: '{"labels":[],"values":[]}' }] })];
  const entry = (canvasId: string, id = 'response-a') => ({ canvasId, title: 'Revenue',
    owner: { kind: 'response' as const, id } });
  const filtered = ownedCanvasInventory(snapshot([
    entry('response-a::canvas::0'),
    entry('response-a::canvas::1'),
    entry('response-b::canvas::0', 'response-b'),
    entry('response-a::canvas::00'),
  ]), records, 'user-1', 'session-1');
  expect(filtered.items.map(item => item.canvasId)).toEqual(['response-a::canvas::0']);
  expect(filtered.omitted).toBe(3);
});

it('accepts only the established structured Calendar workspace ID forms', () => {
  const records = [assistant({ messageId: 'calendar-message', turnId: 'calendar-turn-1',
    calendarView: notice })];
  const entry = (canvasId: string, id = 'calendar-turn-1') => ({ canvasId, title: 'Schedule',
    owner: { kind: 'calendar' as const, id } });
  const filtered = ownedCanvasInventory(snapshot([
    entry('calendar:calendar-turn-1::canvas::calendar'),
    entry('calendar-turn-1::canvas::calendar'),
    entry('calendar-message::canvas::calendar', 'calendar-message'),
    entry('calendar:calendar-turn-2::canvas::calendar', 'calendar-turn-2'),
    entry('calendar-message::canvas::calendar', 'calendar-turn-1'),
    entry('calendar:calendar-message::canvas::calendar', 'calendar-message'),
  ]), records, 'user-1', 'session-1');
  expect(filtered.items.map(item => item.canvasId)).toEqual([
    'calendar:calendar-turn-1::canvas::calendar',
    'calendar-turn-1::canvas::calendar',
    'calendar-message::canvas::calendar',
  ]);
  expect(filtered.omitted).toBe(3);
  expect(ownedCanvasInventory(snapshot([entry('calendar:calendar-turn-1::canvas::calendar')]),
    [assistant({ messageId: 'no-view', turnId: 'calendar-turn-1' })], 'user-1', 'session-1').items).toEqual([]);
});

it('retains duplicate titles as independent IDs and bounds the projection', () => {
  const records = [assistant({ messageId: 'one' }), assistant({ messageId: 'two' })];
  const filtered = ownedCanvasInventory(snapshot([messageItem('one', 'Pricing comparison'),
    messageItem('two', 'Pricing comparison')]), records, 'user-1', 'session-1');
  expect(filtered.items).toHaveLength(2);
  expect(canvasModelInventory(filtered)).toEqual({ items: [
    { canvas_id: 'one::canvas::0', title: 'Pricing comparison' },
    { canvas_id: 'two::canvas::0', title: 'Pricing comparison' },
  ], omitted: 0 });
});

it('strips ownership refs from the model projection and marks a saturated omission', () => {
  const projected = canvasModelInventory(snapshot([messageItem('one')], 499));
  expect(projected).toEqual({ items: [{ canvas_id: 'one::canvas::0', title: 'Pricing comparison' }],
    omitted: 499 });
  expect(JSON.stringify(projected)).not.toContain('owner');
  expect(canvasModelInventory(snapshot([], 500))).toEqual({ items: [], omitted: 500, omittedAtLeast: true });
});

it('dispatches a valid relative control synchronously without persistence or target lookup', () => {
  const target = { canvasId: 'm1::canvas::0', revision: 1, open: true, fullscreen: false, mode: 'diagram' as const };
  const control = vi.fn(() => true);
  const result = controlCanvas({
    envelope: { action: 'zoom_in' },
    responseMode: 'voice',
    expected: target,
    selection: target,
    active: () => true,
    control,
  });
  expect(result).toEqual({
    kind: 'canvas-control',
    outcome: 'requested',
    action: 'zoom_in',
    canvas_id: target.canvasId,
  });
  expect(control).toHaveBeenCalledExactlyOnceWith({ action: 'zoom_in' }, target);
  expect(result).not.toBeInstanceOf(Promise);
});

it('intersects selection with owned inventory and enforces control admission precedence', () => {
  const owned = snapshot([messageItem('m1')]);
  const selected = { canvasId: 'm1::canvas::0', revision: 2, open: true, fullscreen: false, mode: 'diagram' as const };
  expect(ownedCanvasSelection(selected, owned)).toEqual(selected);
  expect(ownedCanvasSelection({ ...selected, canvasId: 'missing::canvas::0' }, owned)).toBeNull();
  expect(ownedCanvasSelection(null, owned)).toBeNull();

  const control = vi.fn(() => true);
  // Mode gates before invalid arguments or unavailable target.
  expect(controlCanvas({
    envelope: {}, responseMode: 'text', expected: null, selection: null, active: () => false, control,
  })).toEqual({ kind: 'canvas-control', outcome: 'mode-not-allowed', action: null, canvas_id: null });
  // Invalid parseable arguments gate before target selection checks.
  expect(controlCanvas({
    envelope: { action: 'zoom_in', amount: 10 }, responseMode: 'voice', expected: selected,
    selection: null, active: () => true, control,
  })).toEqual({ kind: 'canvas-control', outcome: 'invalid-arguments', action: null, canvas_id: selected.canvasId });
  // Mismatched expected vs latest revision/open/fullscreen/mode/id or closed non-close target is unavailable.
  for (const selection of [
    null,
    { ...selected, revision: 3 },
    { ...selected, open: false },
    { ...selected, fullscreen: true },
    { ...selected, mode: 'scroll' as const },
    { ...selected, canvasId: 'other::canvas::0' },
  ]) {
    expect(controlCanvas({
      envelope: { action: 'zoom_in' }, responseMode: 'voice', expected: selected,
      selection, active: () => true, control,
    })).toEqual({ kind: 'canvas-control', outcome: 'unavailable', action: 'zoom_in', canvas_id: selected.canvasId });
  }
  const closed = { ...selected, open: false };
  expect(controlCanvas({
    envelope: { action: 'zoom_in' }, responseMode: 'voice', expected: closed,
    selection: closed, active: () => true, control,
  }).outcome).toBe('unavailable');
  // Close is still admitted when already closed if selection matches.
  expect(controlCanvas({
    envelope: { action: 'close' }, responseMode: 'voice', expected: closed,
    selection: closed, active: () => true, control,
  }).outcome).toBe('requested');

  // Scroll mode marks zoom/fit unsupported without calling transport, but admits scroll/reset/close/fullscreen.
  const scrollSel = { ...selected, mode: 'scroll' as const };
  for (const action of ['zoom_in', 'zoom_out', 'fit_to_view'] as const) {
    expect(controlCanvas({
      envelope: { action }, responseMode: 'voice', expected: scrollSel,
      selection: scrollSel, active: () => true, control,
    })).toEqual({ kind: 'canvas-control', outcome: 'unsupported', action, canvas_id: scrollSel.canvasId });
  }
  control.mockClear();
  for (const envelope of [
    { action: 'scroll', direction: 'down' as const },
    { action: 'reset_view' as const },
    { action: 'close' as const },
    { action: 'fullscreen', state: 'enter' as const },
  ]) {
    expect(controlCanvas({
      envelope, responseMode: 'voice', expected: scrollSel, selection: scrollSel,
      active: () => true, control,
    }).outcome).toBe('requested');
  }
  expect(control).toHaveBeenCalledTimes(4);

  // Delivery failure states: inactive, false return, throwing callback.
  expect(controlCanvas({
    envelope: { action: 'zoom_in' }, responseMode: 'voice', expected: selected,
    selection: selected, active: () => false, control: () => true,
  }).outcome).toBe('delivery-unavailable');
  expect(controlCanvas({
    envelope: { action: 'zoom_in' }, responseMode: 'voice', expected: selected,
    selection: selected, active: () => true, control: () => false,
  }).outcome).toBe('delivery-unavailable');
  expect(controlCanvas({
    envelope: { action: 'zoom_in' }, responseMode: 'voice', expected: selected,
    selection: selected, active: () => true, control: () => { throw new Error('boom'); },
  }).outcome).toBe('delivery-unavailable');
});

it('builds voice-only Canvas state without leaking current_canvas, revision, or owner and flags redundant controls', () => {
  const snap = snapshot([messageItem('m1', 'Diagram'), messageItem('m2', 'Calendar')], 2);
  const openDiagram = canvasTurnState(snap, {
    canvasId: 'm1::canvas::0', revision: 7, open: true, fullscreen: false, mode: 'diagram',
  });
  expect(openDiagram).toEqual({
    mode: 'voice',
    canvas_count: 4,
    canvas_ids: [
      { canvas_id: 'm1::canvas::0', title: 'Diagram' },
      { canvas_id: 'm2::canvas::0', title: 'Calendar' },
    ],
    open: true,
    fullscreen: false,
    zoomable: true,
  });
  const msg = canvasTurnStateMessage(snap, {
    canvasId: 'm1::canvas::0', revision: 7, open: true, fullscreen: false, mode: 'diagram',
  });
  expect(msg).not.toContain('current_canvas');
  expect(msg).not.toContain('"revision"');
  expect(msg).not.toContain('"owner"');
  expect(msg).toContain('2 additional Canvas artifacts are not listed; this inventory is incomplete.');

  const closedState = canvasTurnState(snap, {
    canvasId: 'm1::canvas::0', revision: 8, open: false, fullscreen: false, mode: 'diagram',
  });
  expect(closedState).toMatchObject({ open: false, fullscreen: false, zoomable: false });
  const fullscreenScroll = canvasTurnState(snap, {
    canvasId: 'm2::canvas::0', revision: 9, open: true, fullscreen: true, mode: 'scroll',
  });
  expect(fullscreenScroll).toMatchObject({ open: true, fullscreen: true, zoomable: false });

  expect(isRedundantCanvasControl({ action: 'open', canvas_id: 'm1::canvas::0' }, openDiagram)).toBe(false);
  expect(isRedundantCanvasControl({ action: 'open', canvas_id: 'm1::canvas::0' }, closedState)).toBe(false);
  expect(isRedundantCanvasControl({ action: 'close' }, closedState)).toBe(true);
  expect(isRedundantCanvasControl({ action: 'close' }, openDiagram)).toBe(false);
  expect(isRedundantCanvasControl({ action: 'fullscreen', state: 'enter' }, closedState)).toBe(true);
  expect(isRedundantCanvasControl({ action: 'fullscreen', state: 'enter' }, fullscreenScroll)).toBe(true);
  expect(isRedundantCanvasControl({ action: 'fullscreen', state: 'enter' }, openDiagram)).toBe(false);
  expect(isRedundantCanvasControl({ action: 'fullscreen', state: 'exit' }, openDiagram)).toBe(true);
  expect(isRedundantCanvasControl({ action: 'fullscreen', state: 'exit' }, closedState)).toBe(true);
  expect(isRedundantCanvasControl({ action: 'fullscreen', state: 'exit' }, fullscreenScroll)).toBe(false);
  expect(isRedundantCanvasControl({ action: 'zoom_in' }, closedState)).toBe(true);
  expect(isRedundantCanvasControl({ action: 'zoom_out' }, fullscreenScroll)).toBe(true);
  expect(isRedundantCanvasControl({ action: 'fit_to_view' }, fullscreenScroll)).toBe(true);
  expect(isRedundantCanvasControl({ action: 'reset_view' }, closedState)).toBe(true);
  expect(isRedundantCanvasControl({ action: 'scroll', direction: 'down' }, closedState)).toBe(true);
  expect(isRedundantCanvasControl({ action: 'scroll', direction: 'down' }, fullscreenScroll)).toBe(false);
  expect(isRedundantCanvasControl({ action: 'reset_view' }, fullscreenScroll)).toBe(false);
  expect(isRedundantCanvasControl({ action: 'zoom_in' }, openDiagram)).toBe(false);
});
