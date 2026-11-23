/**
 * ============================================================================
 * FILE: canvas-controls.ts
 * LOCATION: frontend/src/features/canvas/canvas-controls.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Pure Canvas view math, rendered SVG bounds measurement, and local control
 *    application for voice-driven presentation adjustments.
 *
 * ROLE IN PROJECT:
 *    Shared by CanvasPanel manual toolbar controls and the imperative
 *    CanvasPanelHandle invoked synchronously when live voice control frames arrive.
 *    Keeps pan/zoom/fit/scroll finite and dependency-free.
 *
 * KEY COMPONENTS:
 *    - DEFAULT_CANVAS_VIEW / stepCanvasZoom / scrollCanvasView / fitCanvasView
 *    - measureCanvasGraphics: Neutralizes inline stage transform/transition safely.
 *    - applyCanvasControl: Executes one bounded command against a panel port.
 * ============================================================================
 */

import type { CanvasControlArguments } from '../../api/voice-protocol.ts';

export type CanvasView = { zoom: number; panX: number; panY: number };
export type CanvasRect = { x: number; y: number; width: number; height: number };

export const DEFAULT_CANVAS_VIEW: CanvasView = { zoom: 100, panX: 0, panY: 0 };
export const MIN_CANVAS_ZOOM = 25;
export const MAX_CANVAS_ZOOM = 300;
export const CANVAS_ZOOM_STEP = 25;

export type CanvasScrollBody = {
  scrollTop: number;
  scrollLeft: number;
  clientHeight: number;
  clientWidth: number;
  scrollHeight: number;
  scrollWidth: number;
};

export type CanvasControlPort = {
  mode: 'diagram' | 'scroll';
  open: boolean;
  getView: () => CanvasView;
  setView: (view: CanvasView) => void;
  viewport: HTMLDivElement | null;
  stage: HTMLDivElement | null;
  body: CanvasScrollBody | null;
  close: () => void;
  setMaximized: (value: boolean) => void;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const validRect = (value: CanvasRect): boolean =>
  Object.values(value).every(Number.isFinite) && value.width > 0 && value.height > 0;

export function stepCanvasZoom(view: CanvasView, direction: 1 | -1): CanvasView {
  return {
    ...view,
    zoom: clamp(view.zoom + direction * CANVAS_ZOOM_STEP, MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM),
  };
}

export function scrollCanvasView(
  view: CanvasView,
  direction: 'up' | 'down' | 'left' | 'right',
  width: number,
  height: number,
): CanvasView {
  const horizontal = direction === 'left' || direction === 'right';
  const dimension = horizontal ? width : height;
  const step = Number.isFinite(dimension) ? clamp(dimension * 0.75, 0, 800) : 0;
  const delta = direction === 'down' || direction === 'right' ? -step : step;
  // ponytail: voice pan is capped at 100000 CSS px; replace with measured content-edge bounds if needed.
  return {
    ...view,
    panX: horizontal ? clamp(view.panX + delta, -100000, 100000) : view.panX,
    panY: horizontal ? view.panY : clamp(view.panY + delta, -100000, 100000),
  };
}

export function fitCanvasView(viewport: CanvasRect, graphics: CanvasRect): CanvasView | null {
  if (!validRect(viewport) || !validRect(graphics)) return null;
  const zoom = clamp(
    Math.min(viewport.width / graphics.width, viewport.height / graphics.height) * 100,
    MIN_CANVAS_ZOOM,
    MAX_CANVAS_ZOOM,
  );
  const scale = zoom / 100;
  const fitted = {
    zoom,
    panX: viewport.x + viewport.width / 2 - (graphics.x + graphics.width / 2) * scale,
    panY: viewport.y + viewport.height / 2 - (graphics.y + graphics.height / 2) * scale,
  };
  return Object.values(fitted).every(Number.isFinite) ? fitted : null;
}

const cssPx = (value: string | undefined): number => {
  const parsed = Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/**
 * Temporarily neutralizes stage inline transform/transition so rendered SVG CTM
 * coordinates and viewport padding convert into stage-center-relative CSS px.
 */
export function measureCanvasGraphics(
  viewport: HTMLDivElement,
  stage: HTMLDivElement,
): { viewport: CanvasRect; graphics: CanvasRect } | null {
  const prevTransform = stage.style.transform;
  const prevTransition = stage.style.transition;
  stage.style.transition = 'none';
  stage.style.transform = 'none';
  try {
    const stageRect = stage.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    if (!Number.isFinite(stage.offsetWidth) || !Number.isFinite(stage.offsetHeight)
      || stage.offsetWidth <= 0 || stage.offsetHeight <= 0) {
      return null;
    }
    const scaleX = stageRect.width / stage.offsetWidth;
    const scaleY = stageRect.height / stage.offsetHeight;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
      return null;
    }
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(viewport) : null;
    const padLeft = cssPx(style?.paddingLeft);
    const padRight = cssPx(style?.paddingRight);
    const padTop = cssPx(style?.paddingTop);
    const padBottom = cssPx(style?.paddingBottom);
    const centerX = stageRect.left + stageRect.width / 2;
    const centerY = stageRect.top + stageRect.height / 2;
    const insetViewport: CanvasRect = {
      x: (viewportRect.left - centerX) / scaleX + padLeft,
      y: (viewportRect.top - centerY) / scaleY + padTop,
      width: viewportRect.width / scaleX - padLeft - padRight,
      height: viewportRect.height / scaleY - padTop - padBottom,
    };
    const svg = stage.querySelector('svg');
    if (!svg) return null;
    const box = svg.getBBox();
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const coeffs = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
    const dims = [box.x, box.y, box.width, box.height];
    if (!coeffs.every(Number.isFinite) || !dims.every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
      return null;
    }
    const corners: ReadonlyArray<readonly [number, number]> = [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x, box.y + box.height],
      [box.x + box.width, box.y + box.height],
    ];
    const points = corners.map(([x, y]) => ({
      x: matrix.a * x + matrix.c * y + matrix.e,
      y: matrix.b * x + matrix.d * y + matrix.f,
    }));
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const graphics: CanvasRect = {
      x: (minX - centerX) / scaleX,
      y: (minY - centerY) / scaleY,
      width: (maxX - minX) / scaleX,
      height: (maxY - minY) / scaleY,
    };
    return validRect(insetViewport) && validRect(graphics)
      ? { viewport: insetViewport, graphics }
      : null;
  } catch {
    return null;
  } finally {
    stage.style.transform = prevTransform;
    stage.style.transition = prevTransition;
  }
}

export function applyCanvasControl(
  command: CanvasControlArguments,
  port: CanvasControlPort,
): 'applied' | 'unavailable' | 'unsupported' {
  if (command.action === 'open') return 'unavailable';
  if (command.action === 'close') {
    if (port.open) port.close();
    return 'applied';
  }
  if (!port.open) return 'unavailable';
  if (command.action === 'fullscreen') {
    port.setMaximized(command.state === 'enter');
    return 'applied';
  }
  if (command.action === 'reset_view') {
    port.setView({ ...DEFAULT_CANVAS_VIEW });
    if (port.body) {
      port.body.scrollTop = 0;
      port.body.scrollLeft = 0;
    }
    return 'applied';
  }
  if (port.mode === 'scroll' && command.action !== 'scroll') return 'unsupported';
  if (command.action === 'scroll' && port.mode === 'scroll') {
    const body = port.body;
    if (!body) return 'unavailable';
    const values = [
      body.scrollTop,
      body.scrollLeft,
      body.clientHeight,
      body.clientWidth,
      body.scrollHeight,
      body.scrollWidth,
    ];
    if (!values.every(Number.isFinite)) return 'unavailable';
    const horizontal = command.direction === 'left' || command.direction === 'right';
    const step = clamp((horizontal ? body.clientWidth : body.clientHeight) * 0.75, 0, 800);
    const delta = command.direction === 'down' || command.direction === 'right' ? step : -step;
    if (horizontal) {
      body.scrollLeft = clamp(body.scrollLeft + delta, 0, Math.max(0, body.scrollWidth - body.clientWidth));
    } else {
      body.scrollTop = clamp(body.scrollTop + delta, 0, Math.max(0, body.scrollHeight - body.clientHeight));
    }
    return 'applied';
  }
  if (!port.viewport || !port.stage || port.viewport.clientWidth <= 0 || port.viewport.clientHeight <= 0) {
    return 'unavailable';
  }
  if (command.action === 'zoom_in' || command.action === 'zoom_out') {
    port.setView(stepCanvasZoom(port.getView(), command.action === 'zoom_in' ? 1 : -1));
  } else if (command.action === 'scroll') {
    port.setView(
      scrollCanvasView(port.getView(), command.direction, port.viewport.clientWidth, port.viewport.clientHeight),
    );
  } else {
    const measured = measureCanvasGraphics(port.viewport, port.stage);
    if (!measured) return 'unavailable';
    const fitted = fitCanvasView(measured.viewport, measured.graphics);
    if (!fitted) return 'unavailable';
    port.setView(fitted);
  }
  return 'applied';
}
