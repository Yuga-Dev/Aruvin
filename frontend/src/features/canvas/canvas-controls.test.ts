/**
 * ============================================================================
 * FILE: canvas-controls.test.ts
 * LOCATION: frontend/src/features/canvas/canvas-controls.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Deterministic Node checks for Canvas local view math, SVG bounds
 *    measurement, and bounded control application.
 *
 * ROLE IN PROJECT:
 *    Verifies zoom clamping, centered fit-to-view calculation distinct from
 *    reset, bounded directional scroll/pan, CTM measurement transform cleanup,
 *    and Calendar/code unsupported mode handling using structural DOM doubles.
 *
 * KEY COMPONENTS:
 *    - Pure view tests: stepCanvasZoom, scrollCanvasView, fitCanvasView.
 *    - Measurement & application tests: measureCanvasGraphics, applyCanvasControl.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CANVAS_VIEW,
  applyCanvasControl,
  fitCanvasView,
  measureCanvasGraphics,
  scrollCanvasView,
  stepCanvasZoom,
} from './canvas-controls.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Canvas presentation controls', () => {
  it('uses existing bounded zoom steps and preserves position', () => {
    const view = { zoom: 100, panX: 18, panY: -23 };
    expect(stepCanvasZoom(view, 1)).toEqual({ ...view, zoom: 125 });
    expect(stepCanvasZoom(view, -1)).toEqual({ ...view, zoom: 75 });
    expect(stepCanvasZoom({ ...view, zoom: 300 }, 1).zoom).toBe(300);
    expect(stepCanvasZoom({ ...view, zoom: 25 }, -1).zoom).toBe(25);
  });

  it('fits measured graphics and centers them instead of resetting to 100 percent', () => {
    const viewport = { x: -200, y: -100, width: 400, height: 200 };
    const graphics = { x: -500, y: -200, width: 1000, height: 400 };
    expect(fitCanvasView(viewport, graphics)).toEqual({ zoom: 40, panX: 0, panY: 0 });
    expect(DEFAULT_CANVAS_VIEW).toEqual({ zoom: 100, panX: 0, panY: 0 });
    expect(fitCanvasView(viewport, { ...graphics, x: -400 }))
      .toEqual({ zoom: 40, panX: -40, panY: 0 });
    expect(fitCanvasView(viewport, { ...graphics, width: 0 })).toBeNull();
    expect(fitCanvasView(viewport, { ...graphics, width: Infinity })).toBeNull();
  });

  it('scrolls the view in all four directions with bounded relative steps', () => {
    const view = { zoom: 125, panX: 0, panY: 0 };
    expect(scrollCanvasView(view, 'down', 400, 200).panY).toBe(-150);
    expect(scrollCanvasView(view, 'up', 400, 200).panY).toBe(150);
    expect(scrollCanvasView(view, 'right', 400, 200).panX).toBe(-300);
    expect(scrollCanvasView(view, 'left', 400, 200).panX).toBe(300);
    expect(scrollCanvasView(view, 'down', 400, 10000).panY).toBe(-800);
    expect(scrollCanvasView({ ...view, panY: -100000 }, 'down', 400, 200).panY).toBe(-100000);
    expect(scrollCanvasView({ ...view, panX: 100000 }, 'left', 400, 200).panX).toBe(100000);
  });

  it('measures off-center SVG bounds with CSS scaling and padding and restores stage styles even on throw', () => {
    vi.stubGlobal('getComputedStyle', () => ({
      paddingLeft: '20px',
      paddingRight: '20px',
      paddingTop: '16px',
      paddingBottom: '16px',
    }));
    const stageStyle = { transform: 'translate(80px, -40px) scale(1.5)', transition: 'transform 120ms ease' };
    const viewportEl = {
      clientWidth: 440,
      clientHeight: 232,
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 880, height: 464 }),
    } as unknown as HTMLDivElement;
    const svg = {
      getBBox: () => {
        // Must measure under neutralized stage transform/transition.
        expect(stageStyle.transform).toBe('none');
        expect(stageStyle.transition).toBe('none');
        return { x: 0, y: 0, width: 500, height: 200 };
      },
      // Differs from stage size: SVG scaled x2 into screen space, shifted right/down of stage center (540, 282).
      getScreenCTM: () => ({ a: 4, b: 0, c: 0, d: 4, e: 140, f: 82 }),
    };
    const stageEl = {
      style: stageStyle,
      offsetWidth: 100,
      offsetHeight: 80,
      getBoundingClientRect: () => {
        expect(stageStyle.transform).toBe('none');
        return { left: 440, top: 202, width: 200, height: 160 };
      },
      querySelector: (selector: string) => (selector === 'svg' ? svg : null),
    } as unknown as HTMLDivElement;

    const measured = measureCanvasGraphics(viewportEl, stageEl);
    expect(stageStyle).toEqual({
      transform: 'translate(80px, -40px) scale(1.5)',
      transition: 'transform 120ms ease',
    });
    expect(measured).toEqual({
      viewport: { x: -200, y: -100, width: 400, height: 200 },
      graphics: { x: -200, y: -100, width: 1000, height: 400 },
    });
    let current = { zoom: 175, panX: 80, panY: -40 };
    const fitOutcome = applyCanvasControl({ action: 'fit_to_view' }, {
      mode: 'diagram',
      open: true,
      getView: () => current,
      setView: next => { current = next; },
      viewport: viewportEl,
      stage: stageEl,
      body: null,
      close: vi.fn(),
      setMaximized: vi.fn(),
    });
    expect(fitOutcome).toBe('applied');
    // Off-center graphics (-200..800, -100..300 -> center 300, 100) zoomed to 40% centers in -200..200, -100..100.
    expect(current).toEqual({ zoom: 40, panX: -120, panY: -40 });
    expect(current).not.toEqual(DEFAULT_CANVAS_VIEW);

    // Restores inline stage styles even if getBBox throws, and returns unavailable without mutating view.
    const throwingStage = {
      ...stageEl,
      querySelector: () => ({
        getBBox: () => { throw new Error('layout failure'); },
        getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      }),
    } as unknown as HTMLDivElement;
    expect(measureCanvasGraphics(viewportEl, throwingStage)).toBeNull();
    expect(stageStyle).toEqual({
      transform: 'translate(80px, -40px) scale(1.5)',
      transition: 'transform 120ms ease',
    });
    expect(applyCanvasControl({ action: 'fit_to_view' }, {
      mode: 'diagram',
      open: true,
      getView: () => current,
      setView: next => { current = next; },
      viewport: { clientWidth: 0, clientHeight: 200 } as HTMLDivElement,
      stage: stageEl,
      body: null,
      close: vi.fn(),
      setMaximized: vi.fn(),
    })).toBe('unavailable');
    expect(current).toEqual({ zoom: 40, panX: -120, panY: -40 });
  });

  it('handles Calendar/code unsupported actions, clamped native scroll, reset, close, and explicit fullscreen', () => {
    const setMaximized = vi.fn();
    const close = vi.fn();
    let current = { zoom: 175, panX: 40, panY: -30 };
    const body = {
      scrollTop: 50,
      scrollLeft: 20,
      clientHeight: 200,
      clientWidth: 400,
      scrollHeight: 900,
      scrollWidth: 1000,
    };
    const port = {
      mode: 'scroll' as const,
      open: true,
      getView: () => current,
      setView: (next: typeof current) => { current = next; },
      viewport: null,
      stage: null,
      body,
      close,
      setMaximized,
    };
    expect(applyCanvasControl({ action: 'zoom_in' }, port)).toBe('unsupported');
    expect(applyCanvasControl({ action: 'zoom_out' }, port)).toBe('unsupported');
    expect(applyCanvasControl({ action: 'fit_to_view' }, port)).toBe('unsupported');
    expect(current).toEqual({ zoom: 175, panX: 40, panY: -30 });

    expect(applyCanvasControl({ action: 'scroll', direction: 'down' }, port)).toBe('applied');
    expect(body.scrollTop).toBe(200);
    expect(applyCanvasControl({ action: 'scroll', direction: 'up' }, {
      ...port, body: { ...body, scrollTop: 30 },
    })).toBe('applied');
    expect(applyCanvasControl({ action: 'scroll', direction: 'right' }, port)).toBe('applied');
    expect(body.scrollLeft).toBe(320);
    expect(applyCanvasControl({ action: 'scroll', direction: 'right' }, port)).toBe('applied');
    expect(body.scrollLeft).toBe(600);
    expect(applyCanvasControl({ action: 'scroll', direction: 'left' }, port)).toBe('applied');
    expect(body.scrollLeft).toBe(300);

    expect(applyCanvasControl({ action: 'reset_view' }, port)).toBe('applied');
    expect(current).toEqual(DEFAULT_CANVAS_VIEW);
    expect([body.scrollLeft, body.scrollTop]).toEqual([0, 0]);

    for (const state of ['enter', 'enter', 'exit', 'exit'] as const) {
      expect(applyCanvasControl({ action: 'fullscreen', state }, port)).toBe('applied');
    }
    expect(setMaximized.mock.calls).toEqual([[true], [true], [false], [false]]);

    expect(applyCanvasControl({ action: 'close' }, port)).toBe('applied');
    expect(close).toHaveBeenCalledOnce();
    expect(applyCanvasControl({ action: 'close' }, { ...port, open: false })).toBe('applied');
    expect(close).toHaveBeenCalledOnce();
    expect(applyCanvasControl({ action: 'reset_view' }, { ...port, open: false })).toBe('unavailable');
    expect(applyCanvasControl({ action: 'open', canvas_id: 'msg-1::canvas::0' }, port)).toBe('unavailable');
  });
});
