/**
 * ============================================================================
 * FILE: canvas-navigation-wire.spec.ts
 * LOCATION: backend/test/contracts/canvas-navigation-wire.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the live-only bounded Canvas inventory and navigation wire payloads.
 *
 * ROLE IN PROJECT:
 *    Guards client/server direction, exact shapes, duplicate IDs, title bounds,
 *    snapshot/control byte ceilings, and single-packet encoding.
 *
 * KEY COMPONENTS:
 *    - parseVoiceControl / encodeVoiceControlPackets canvas cases.
 *    - Canvas inventory guard and limit parity.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  CANVAS_NAVIGATION_LIMITS,
  encodeVoiceControlPackets,
  isCanvasControlPayload,
  isCanvasInventoryPayload,
  isCanvasShowPayload,
  parseVoiceControl,
  type CanvasControlArguments,
  type CanvasInventoryEntry,
} from '../../src/contracts/voice-wire.js';

const envelope = { protocolVersion: 1 as const, sessionId: 'session-1', connectionEpoch: 1,
  eventId: 'event-1', sequence: 3 };
const entry = (n: number): CanvasInventoryEntry => ({ canvasId: `msg-${n}::canvas::0`,
  title: `Canvas ${n}`, owner: { kind: 'message', id: `msg-${n}` } });
const inventory = (items: CanvasInventoryEntry[], omitted = 0) => ({ items, omitted });
const inventoryPayload = (items = [entry(1)], omitted = 1) => ({ ...envelope,
  type: 'canvas.inventory' as const, conversationId: 'conversation-1', inventory: inventory(items, omitted) });
const inventoryBody = (payload: ReturnType<typeof inventoryPayload>) => ({
  type: payload.type, conversationId: payload.conversationId, inventory: payload.inventory });
const showPayload = { ...envelope, type: 'canvas.show' as const, conversationId: 'conversation-1',
  turnId: 'turn-new', responseId: 'response-new', navigationId: 'navigation-1',
  canvasId: 'response-old::canvas::0' };
const showBody = (payload: typeof showPayload) => ({ type: payload.type,
  conversationId: payload.conversationId, turnId: payload.turnId,
  responseId: payload.responseId, navigationId: payload.navigationId,
  canvasId: payload.canvasId });

describe('canvas wire limits and exact guards', () => {
  it('locks the inventory and control ceilings', () => {
    expect(CANVAS_NAVIGATION_LIMITS).toEqual({ maxItems: 24, maxInventoryBytes: 8192,
      maxControlBytes: 12288, maxCanvasIdChars: 256, maxResultBytes: 1024,
      maxPendingControls: 4, maxPendingBytes: 32768 });
  });

  it('accepts a maximum valid inventory as exactly one packet', () => {
    const items = Array.from({ length: 24 }, (_, n) => ({
      ...entry(n), title: `${'T'.repeat(60)}${String(n).padStart(2, '0')}` }));
    while (new TextEncoder().encode(JSON.stringify(inventory(items))).byteLength > 8192) {
      items[items.length - 1]!.title = items[items.length - 1]!.title.slice(0, -1);
    }
    const payload = { ...inventoryPayload(items, 0), sequence: 0 };
    expect(isCanvasInventoryPayload(inventoryBody(payload))).toBe(true);
    const json = JSON.stringify(payload);
    expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(12288);
    expect(encodeVoiceControlPackets(json, 'client', 'live')).toHaveLength(1);
    expect(parseVoiceControl(json, 'client', 'live')).toMatchObject({ type: 'canvas.inventory' });
  });

  it('accepts the exact server navigation payload only', () => {
    expect(isCanvasShowPayload(showBody(showPayload))).toBe(true);
    expect(parseVoiceControl(JSON.stringify(showPayload), 'server', 'live'))
      .toMatchObject({ type: 'canvas.show', navigationId: 'navigation-1' });
    expect(() => parseVoiceControl(JSON.stringify(showPayload), 'client', 'live')).toThrow('INVALID_VOICE_CONTROL');
    expect(isCanvasInventoryPayload(inventoryBody(inventoryPayload()))).toBe(true);
    expect(() => parseVoiceControl(JSON.stringify(inventoryPayload()), 'server', 'live'))
      .toThrow('INVALID_VOICE_CONTROL');
  });

  it('rejects both payloads in dictation mode', () => {
    expect(() => parseVoiceControl(JSON.stringify(inventoryPayload()), 'client', 'dictation'))
      .toThrow('INVALID_VOICE_CONTROL');
    expect(() => parseVoiceControl(JSON.stringify(showPayload), 'server', 'dictation'))
      .toThrow('INVALID_VOICE_CONTROL');
  });

  it.each([
    ['duplicate IDs', { ...inventoryPayload([entry(1), entry(1)]) }],
    ['extra field', { ...inventoryPayload(), extra: true }],
    ['negative omitted', { ...inventoryPayload(), inventory: inventory([entry(1)], -1) }],
    ['unsafe omitted', { ...inventoryPayload(), inventory: { items: [entry(1)], omitted: Number.MAX_SAFE_INTEGER + 1 } }],
    ['omitted above archive', { ...inventoryPayload(), inventory: inventory([entry(1)], 501) }],
    ['25 entries', { ...inventoryPayload(Array.from({ length: 25 }, (_, n) => entry(n))) }],
    ['empty title', { ...inventoryPayload([{ ...entry(1), title: '' }]) }],
    ['untrimmed title', { ...inventoryPayload([{ ...entry(1), title: ' padded ' }]) }],
    ['control character title', { ...inventoryPayload([{ ...entry(1), title: 'bad\u0007title' }]) }],
    ['lone surrogate title', { ...inventoryPayload([{ ...entry(1), title: 'bad\uD800title' }]) }],
    ['121-character title', { ...inventoryPayload([{ ...entry(1), title: 'x'.repeat(121) }]) }],
    ['480-byte overflow multibyte title', { ...inventoryPayload([{ ...entry(1), title: 'é'.repeat(241) }]) }],
    ['overlong canvas ID', { ...inventoryPayload([{ ...entry(1), canvasId: 'x'.repeat(257) }]) }],
    ['malformed canvas ID', { ...inventoryPayload([{ ...entry(1), canvasId: 'bad id' }]) }],
    ['malformed owner kind', { ...inventoryPayload([{ ...entry(1), owner: { kind: 'plugin', id: 'm1' } }]) }],
    ['malformed owner id', { ...inventoryPayload([{ ...entry(1), owner: { kind: 'message', id: 'bad id' } }]) }],
    ['overlong owner id', { ...inventoryPayload([{ ...entry(1), owner: { kind: 'response', id: 'x'.repeat(129) } }]) }],
    ['extra owner field', { ...inventoryPayload([{ ...entry(1), owner: { kind: 'message', id: 'm1', extra: 1 } }]) }],
  ])('rejects %s', (_label, payload) => {
    if (!('extra' in payload)) expect(isCanvasInventoryPayload(inventoryBody(payload as never))).toBe(false);
    expect(() => parseVoiceControl(JSON.stringify(payload), 'client', 'live'))
      .toThrow('INVALID_VOICE_CONTROL');
  });

  it('rejects a snapshot over the inventory byte ceiling even under 24 items', () => {
    const items = Array.from({ length: 24 }, (_, n) => ({
      canvasId: `${'x'.repeat(254)}${String(n).padStart(2, '0')}`,
      title: '🌍'.repeat(60),
      owner: { kind: 'response' as const, id: `r${'y'.repeat(127)}` },
    }));
    const payload = { ...inventoryPayload(items), sequence: 0 };
    expect(new TextEncoder().encode(JSON.stringify(inventory(items))).byteLength).toBeGreaterThan(8192);
    expect(isCanvasInventoryPayload(inventoryBody(payload))).toBe(false);
  });

  it.each([
    ['missing navigationId', { ...showPayload, navigationId: undefined }],
    ['extra field', { ...showPayload, extra: true }],
    ['malformed responseId', { ...showPayload, responseId: 'bad id' }],
    ['overlong canvasId', { ...showPayload, canvasId: 'x'.repeat(257) }],
    ['wrong type', { ...showPayload, type: 'canvas.inventory' }],
  ])('rejects navigation payload with %s', (_label, payload) => {
    if (!('extra' in payload)) expect(isCanvasShowPayload(showBody(payload as typeof showPayload))).toBe(false);
    expect(() => parseVoiceControl(JSON.stringify(payload), 'server', 'live'))
      .toThrow('INVALID_VOICE_CONTROL');
  });

  const controlCommands: CanvasControlArguments[] = [
    { action: 'open', canvas_id: 'msg-1::canvas::0' },
    { action: 'zoom_in' },
    { action: 'zoom_out' },
    { action: 'fit_to_view' },
    { action: 'scroll', direction: 'up' },
    { action: 'scroll', direction: 'down' },
    { action: 'scroll', direction: 'left' },
    { action: 'scroll', direction: 'right' },
    { action: 'close' },
    { action: 'reset_view' },
    { action: 'fullscreen', state: 'enter' },
    { action: 'fullscreen', state: 'exit' },
  ];

  const controlPayload = (command: CanvasControlArguments = { action: 'zoom_in' }) => ({
    ...envelope,
    type: 'canvas.control' as const,
    conversationId: 'conversation-1',
    turnId: 'turn-new',
    responseId: 'response-new',
    controlId: 'control-1',
    canvasId: 'msg-1::canvas::0',
    selectionRevision: 1,
    command,
  });

  const controlBody = (payload: ReturnType<typeof controlPayload>) => ({
    type: payload.type,
    conversationId: payload.conversationId,
    turnId: payload.turnId,
    responseId: payload.responseId,
    controlId: payload.controlId,
    canvasId: payload.canvasId,
    selectionRevision: payload.selectionRevision,
    command: payload.command,
  });

  it('accepts optional selection on canvas.inventory and enforces membership and revisions', () => {
    const validNull = { ...inventoryPayload(), selection: null };
    const validSelected = {
      ...inventoryPayload(),
      selection: { canvasId: 'msg-1::canvas::0', revision: 1, open: true, fullscreen: false, mode: 'diagram' as const },
    };
    const validFullscreen = {
      ...inventoryPayload(),
      selection: { canvasId: 'msg-1::canvas::0', revision: 2, open: true, fullscreen: true, mode: 'diagram' as const },
    };
    expect(isCanvasInventoryPayload({ ...inventoryBody(validNull), selection: null })).toBe(true);
    expect(isCanvasInventoryPayload({ ...inventoryBody(validSelected), selection: validSelected.selection })).toBe(true);
    expect(isCanvasInventoryPayload({ ...inventoryBody(validFullscreen), selection: validFullscreen.selection })).toBe(true);
    expect(parseVoiceControl(JSON.stringify(validNull), 'client', 'live')).toEqual(validNull);
    expect(parseVoiceControl(JSON.stringify(validSelected), 'client', 'live')).toEqual(validSelected);
    expect(parseVoiceControl(JSON.stringify(validFullscreen), 'client', 'live')).toEqual(validFullscreen);

    expect(isCanvasInventoryPayload({
      ...inventoryBody(inventoryPayload()),
      selection: { canvasId: 'missing::canvas::0', revision: 1, open: true, fullscreen: false, mode: 'diagram' },
    })).toBe(false);
    expect(() => parseVoiceControl(JSON.stringify({
      ...inventoryPayload(),
      selection: { canvasId: 'missing::canvas::0', revision: 1, open: true, fullscreen: false, mode: 'diagram' },
    }), 'client', 'live')).toThrow('INVALID_VOICE_CONTROL');

    for (const badFullscreen of [undefined, null, 'true', 1]) {
      expect(isCanvasInventoryPayload({
        ...inventoryBody(inventoryPayload()),
        selection: { canvasId: 'msg-1::canvas::0', revision: 1, open: true, fullscreen: badFullscreen, mode: 'diagram' },
      })).toBe(false);
    }

    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isCanvasInventoryPayload({
        ...inventoryBody(inventoryPayload()),
        selection: { canvasId: 'msg-1::canvas::0', revision, open: true, fullscreen: false, mode: 'diagram' },
      })).toBe(false);
    }
    expect(isCanvasInventoryPayload({
      ...inventoryBody(inventoryPayload()),
      selection: undefined,
    })).toBe(false);
    expect(isCanvasInventoryPayload({
      ...inventoryBody(inventoryPayload()),
      selection: { canvasId: 'msg-1::canvas::0', revision: 1, open: true, fullscreen: false, mode: 'code' },
    })).toBe(false);
  });

  it.each(controlCommands)('accepts live server canvas.control command %j and rejects dictation/client', (command) => {
    const payload = controlPayload(command);
    expect(isCanvasControlPayload(controlBody(payload))).toBe(true);
    expect(parseVoiceControl(JSON.stringify(payload), 'server', 'live')).toEqual(payload);
    expect(() => parseVoiceControl(JSON.stringify(payload), 'server', 'dictation')).toThrow('INVALID_VOICE_CONTROL');
    expect(() => parseVoiceControl(JSON.stringify(payload), 'client', 'live')).toThrow('INVALID_VOICE_CONTROL');
  });

  it.each([
    ['zero revision', { ...controlPayload(), selectionRevision: 0 }],
    ['negative revision', { ...controlPayload(), selectionRevision: -2 }],
    ['fractional revision', { ...controlPayload(), selectionRevision: 2.5 }],
    ['unsafe integer revision', { ...controlPayload(), selectionRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ['NaN revision', { ...controlPayload(), selectionRevision: Number.NaN }],
    ['Infinity revision', { ...controlPayload(), selectionRevision: Number.POSITIVE_INFINITY }],
    ['unknown action', { ...controlPayload(), command: { action: 'rotate' } }],
    ['open missing canvas_id', { ...controlPayload(), command: { action: 'open' } }],
    ['open malformed canvas_id', { ...controlPayload(), command: { action: 'open', canvas_id: 'bad id' } }],
    ['open extra field', { ...controlPayload(), command: { action: 'open', canvas_id: 'msg-1::canvas::0', direction: 'up' } }],
    ['unknown scroll direction', { ...controlPayload(), command: { action: 'scroll', direction: 'diagonal' } }],
    ['unknown fullscreen state', { ...controlPayload(), command: { action: 'fullscreen', state: 'toggle' } }],
    ['cross-action scroll extra', { ...controlPayload(), command: { action: 'zoom_in', direction: 'down' } }],
    ['extra command field', { ...controlPayload(), command: { action: 'zoom_in', amount: 25 } }],
    ['extra payload field', { ...controlPayload(), extra: 1 }],
    ['array command', { ...controlPayload(), command: ['zoom_in'] }],
    ['bad controlId', { ...controlPayload(), controlId: 'bad id' }],
    ['overlong canvasId', { ...controlPayload(), canvasId: 'x'.repeat(257) }],
  ])('rejects invalid canvas.control payload: %s', (_label, payload) => {
    const body = 'extra' in payload
      ? { ...controlBody(payload as ReturnType<typeof controlPayload>), extra: 1 }
      : controlBody(payload as ReturnType<typeof controlPayload>);
    expect(isCanvasControlPayload(body)).toBe(false);
    if (!Number.isNaN((payload as { selectionRevision?: number }).selectionRevision)) {
      expect(() => parseVoiceControl(JSON.stringify(payload), 'server', 'live')).toThrow('INVALID_VOICE_CONTROL');
    }
  });
});
