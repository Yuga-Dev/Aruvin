/**
 * ============================================================================
 * FILE: canvas-navigation.ts
 * LOCATION: backend/src/contracts/canvas-navigation.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define the dependency-leaf Canvas navigation limits, argument, and result
 *    contracts used by the native tool catalogue and local history.
 *
 * ROLE IN PROJECT:
 *    Imports only Zod so the frozen native catalogue can validate show_canvas
 *    without reaching voice/Calendar modules that import that catalogue.
 *
 * KEY COMPONENTS:
 *    - CANVAS_NAVIGATION_LIMITS: Locked inventory, control, and result bounds.
 *    - showCanvasArgumentsSchema / showCanvasEnvelopeSchema: Strict native input.
 *    - canvasNavigationResultSchema: Bounded local outcome.
 * ============================================================================
 */

import { z } from 'zod';

export const CANVAS_NAVIGATION_LIMITS = Object.freeze({
  maxItems: 24,
  maxInventoryBytes: 8192,
  maxControlBytes: 12288,
  maxCanvasIdChars: 256,
  maxResultBytes: 1024,
  maxPendingControls: 4,
  maxPendingBytes: 32768,
});

export const canvasNavigationIdSchema = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
export const showCanvasArgumentsSchema = z.object({ canvas_id: canvasNavigationIdSchema }).strict();
export const showCanvasEnvelopeSchema = z.record(z.unknown())
  .refine(v => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 16384);
export const controlCanvasArgumentsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), canvas_id: canvasNavigationIdSchema }).strict(),
  z.object({ action: z.literal('zoom_in') }).strict(),
  z.object({ action: z.literal('zoom_out') }).strict(),
  z.object({ action: z.literal('fit_to_view') }).strict(),
  z.object({ action: z.literal('scroll'), direction: z.enum(['up', 'down', 'left', 'right']) }).strict(),
  z.object({ action: z.literal('close') }).strict(),
  z.object({ action: z.literal('reset_view') }).strict(),
  z.object({ action: z.literal('fullscreen'), state: z.enum(['enter', 'exit']) }).strict(),
]);
export const controlCanvasEnvelopeSchema = showCanvasEnvelopeSchema;
export type CanvasControlArguments = z.infer<typeof controlCanvasArgumentsSchema>;
export const canvasNavigationResultSchema = z.object({ kind: z.literal('canvas-navigation'),
  outcome: z.enum(['requested', 'mode-not-allowed', 'invalid-arguments', 'unavailable', 'delivery-unavailable']),
  canvas_id: canvasNavigationIdSchema.nullable(),
}).strict().refine(v => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 1024);
export const canvasControlResultSchema = z.object({
  kind: z.literal('canvas-control'),
  outcome: z.enum(['requested', 'mode-not-allowed', 'invalid-arguments', 'unavailable',
    'delivery-unavailable', 'unsupported']),
  action: z.enum(['open', 'zoom_in', 'zoom_out', 'fit_to_view', 'scroll', 'close', 'reset_view', 'fullscreen']).nullable(),
  canvas_id: canvasNavigationIdSchema.nullable(),
}).strict().refine(v => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 1024);

export type CanvasNavigationOutcome = z.infer<typeof canvasNavigationResultSchema>['outcome'];
export type CanvasNavigationResult = z.infer<typeof canvasNavigationResultSchema>;
export type CanvasControlOutcome = z.infer<typeof canvasControlResultSchema>['outcome'];
export type CanvasControlResult = z.infer<typeof canvasControlResultSchema>;

export type CanvasInventoryEntry = {
  canvasId: string;
  title: string;
  owner: { kind: 'message' | 'response' | 'calendar' | 'weather'; id: string };
};
export type CanvasInventorySnapshot = {
  items: CanvasInventoryEntry[];
  omitted: number;
};
export type CanvasSelection = {
  canvasId: string;
  revision: number;
  open: boolean;
  fullscreen: boolean;
  mode: 'diagram' | 'scroll';
};
export type CanvasInventoryPayload = {
  type: 'canvas.inventory';
  conversationId: string;
  inventory: CanvasInventorySnapshot;
  selection?: CanvasSelection | null;
};
export type CanvasShowPayload = {
  type: 'canvas.show';
  conversationId: string;
  turnId: string;
  responseId: string;
  navigationId: string;
  canvasId: string;
};
export type CanvasControlPayload = {
  type: 'canvas.control';
  conversationId: string;
  turnId: string;
  responseId: string;
  controlId: string;
  canvasId: string;
  selectionRevision: number;
  command: CanvasControlArguments;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, shape: Record<string, (candidate: unknown) => boolean>): boolean =>
  record(value) && Object.keys(value).length === Object.keys(shape).length &&
  Object.entries(shape).every(([key, guard]) => Object.hasOwn(value, key) && guard(value[key]));
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
const wellFormed = (value: string) => {
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
};
export function isCanvasNavigationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}
export function isCanvasComponentId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
const inventoryTitle = (value: unknown): boolean =>
  typeof value === 'string' && value.length > 0 && value.length <= 120 &&
  value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) &&
  wellFormed(value) && utf8(value) <= 480;
const inventoryOwner = (value: unknown): boolean => exact(value, {
  kind: candidate => candidate === 'message' || candidate === 'response' || candidate === 'calendar'
    || candidate === 'weather',
  id: isCanvasComponentId,
});
const inventoryEntry = (value: unknown): boolean => exact(value, {
  canvasId: isCanvasNavigationId,
  title: inventoryTitle,
  owner: inventoryOwner,
});
export function isCanvasInventorySnapshot(value: unknown): value is CanvasInventorySnapshot {
  if (!exact(value, {
    items: candidate => Array.isArray(candidate) && candidate.length <= CANVAS_NAVIGATION_LIMITS.maxItems,
    omitted: candidate => typeof candidate === 'number' && Number.isSafeInteger(candidate) &&
      candidate >= 0 && candidate <= 500,
  })) return false;
  const items = (value as CanvasInventorySnapshot).items;
  return items.every(inventoryEntry) &&
    new Set(items.map(item => item.canvasId)).size === items.length &&
    utf8(JSON.stringify(value)) <= CANVAS_NAVIGATION_LIMITS.maxInventoryBytes;
}
function isPositiveSafeRevision(candidate: unknown): candidate is number {
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0;
}

export function isCanvasSelection(value: unknown): value is CanvasSelection {
  return exact(value, {
    canvasId: isCanvasNavigationId,
    revision: isPositiveSafeRevision,
    open: candidate => typeof candidate === 'boolean',
    fullscreen: candidate => typeof candidate === 'boolean',
    mode: candidate => candidate === 'diagram' || candidate === 'scroll',
  });
}

export function isCanvasControlArguments(value: unknown): value is CanvasControlArguments {
  if (!record(value)) return false;
  const action = value.action;
  if (action === 'open') return exact(value, {
    action: candidate => candidate === 'open',
    canvas_id: isCanvasNavigationId,
  });
  if (action === 'scroll') return exact(value, {
    action: candidate => candidate === 'scroll',
    direction: candidate => typeof candidate === 'string'
      && ['up', 'down', 'left', 'right'].includes(candidate),
  });
  if (action === 'fullscreen') return exact(value, {
    action: candidate => candidate === 'fullscreen',
    state: candidate => candidate === 'enter' || candidate === 'exit',
  });
  return typeof action === 'string'
    && ['zoom_in', 'zoom_out', 'fit_to_view', 'close', 'reset_view'].includes(action)
    && exact(value, { action: candidate => candidate === action });
}

export function isCanvasInventoryPayload(value: unknown): value is CanvasInventoryPayload {
  if (!record(value)) return false;
  const baseShape = {
    type: (candidate: unknown) => candidate === 'canvas.inventory',
    conversationId: isCanvasComponentId,
    inventory: isCanvasInventorySnapshot,
  };
  const shape = Object.hasOwn(value, 'selection')
    ? { ...baseShape, selection: (candidate: unknown) => candidate === null || isCanvasSelection(candidate) }
    : baseShape;
  if (!exact(value, shape)) return false;
  if (utf8(JSON.stringify(value)) > CANVAS_NAVIGATION_LIMITS.maxControlBytes) return false;
  const typed = value as CanvasInventoryPayload;
  if (typed.selection != null && !typed.inventory.items.some(item => item.canvasId === typed.selection!.canvasId)) {
    return false;
  }
  return true;
}
export function isCanvasShowPayload(value: unknown): value is CanvasShowPayload {
  return exact(value, {
    type: candidate => candidate === 'canvas.show',
    conversationId: isCanvasComponentId,
    turnId: isCanvasComponentId,
    responseId: isCanvasComponentId,
    navigationId: isCanvasComponentId,
    canvasId: isCanvasNavigationId,
  }) && utf8(JSON.stringify(value)) <= CANVAS_NAVIGATION_LIMITS.maxControlBytes;
}
export function isCanvasControlPayload(value: unknown): value is CanvasControlPayload {
  return exact(value, {
    type: candidate => candidate === 'canvas.control',
    conversationId: isCanvasComponentId,
    turnId: isCanvasComponentId,
    responseId: isCanvasComponentId,
    controlId: isCanvasComponentId,
    canvasId: isCanvasNavigationId,
    selectionRevision: isPositiveSafeRevision,
    command: isCanvasControlArguments,
  }) && utf8(JSON.stringify(value)) <= CANVAS_NAVIGATION_LIMITS.maxControlBytes;
}
