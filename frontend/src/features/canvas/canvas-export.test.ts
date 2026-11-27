/**
 * ============================================================================
 * FILE: canvas-export.test.ts
 * LOCATION: frontend/src/features/canvas/canvas-export.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Unit tests for the pure parts of Canvas PNG export and print.
 *
 * ROLE IN PROJECT:
 *    Node-only checks (no DOM): size/DPR math, SVG markup normalisation,
 *    error mapping, file naming and control availability. Browser rendering,
 *    PNG pixels and print output are not covered here.
 *
 * KEY COMPONENTS:
 *    - planPngSize, prepareSvgMarkup, classifyPngError, canvasFileStem,
 *      canvasExportAvailability.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  PNG_MAX_EDGE,
  PngExportError,
  canvasExportAvailability,
  canvasFileStem,
  classifyPngError,
  planPngSize,
  pngExportMessage,
  prepareSvgMarkup,
} from './canvas-export.ts';

describe('planPngSize', () => {
  it('applies devicePixelRatio and rounds to whole pixels', () => {
    expect(planPngSize(400, 300, 2)).toEqual({ ok: true, scale: 2, width: 800, height: 600 });
    expect(planPngSize(100.4, 50.2, 1.5)).toMatchObject({ ok: true, width: 151, height: 75 });
  });

  it('clamps dpr to 1..3 and treats non-finite dpr as 1', () => {
    expect(planPngSize(100, 100, 0.5)).toMatchObject({ scale: 1 });
    expect(planPngSize(100, 100, 9)).toMatchObject({ scale: 3 });
    expect(planPngSize(100, 100, Number.NaN)).toMatchObject({ scale: 1 });
  });

  it('lowers the scale to stay under the edge and pixel limits', () => {
    const plan = planPngSize(4000, 100, 3);
    expect(plan).toMatchObject({ ok: true });
    if (plan.ok) {
      expect(plan.width).toBeLessThanOrEqual(PNG_MAX_EDGE);
      expect(plan.scale).toBeCloseTo(PNG_MAX_EDGE / 4000, 5);
    }
    const square = planPngSize(5000, 5000, 3);
    expect(square.ok && square.width * square.height <= 36_000_000).toBe(true);
  });

  it('fails invalid and oversized artifacts', () => {
    expect(planPngSize(0, 10, 1)).toEqual({ ok: false, reason: 'invalid-size' });
    expect(planPngSize(Number.NaN, 10, 1)).toEqual({ ok: false, reason: 'invalid-size' });
    expect(planPngSize(PNG_MAX_EDGE + 1, 10, 1)).toEqual({ ok: false, reason: 'too-large' });
    expect(planPngSize(7000, 7000, 1)).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('prepareSvgMarkup', () => {
  const opts = { width: 300, height: 200, background: null };

  it('adds namespace, viewBox and explicit size, dropping old size and style', () => {
    const out = prepareSvgMarkup('<svg width="100%" style="transform:scale(2)"><g/></svg>', opts);
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200"><g/></svg>',
    );
  });

  it('keeps an existing viewBox and namespace', () => {
    const out = prepareSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path/></svg>', opts);
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out.match(/xmlns=/g)).toHaveLength(1);
  });

  it('adds the xlink namespace only when xlink is used', () => {
    expect(prepareSvgMarkup('<svg><use xlink:href="#a"/></svg>', opts)).toContain('xmlns:xlink');
    expect(prepareSvgMarkup('<svg><use href="#a"/></svg>', opts)).not.toContain('xmlns:xlink');
  });

  it('inserts a background rect only for a safe colour value', () => {
    const ok = prepareSvgMarkup('<svg><g/></svg>', { ...opts, background: 'rgb(18, 18, 18)' });
    expect(ok).toContain('<rect width="100%" height="100%" fill="rgb(18, 18, 18)"/>');
    const bad = prepareSvgMarkup('<svg><g/></svg>', { ...opts, background: '"/><script>x</script>' });
    expect(bad).not.toContain('<rect');
    expect(bad).not.toContain('script');
    expect(prepareSvgMarkup('<svg><g/></svg>', opts)).not.toContain('<rect');
  });

  it('rejects input without an svg root', () => {
    expect(() => prepareSvgMarkup('<div/>', opts)).toThrow(PngExportError);
  });
});

describe('errors, names and availability', () => {
  it('maps tainted-canvas SecurityError and unknown failures to user-facing codes', () => {
    const security = Object.assign(new Error('x'), { name: 'SecurityError' });
    expect(classifyPngError(security).code).toBe('tainted');
    expect(classifyPngError(new Error('boom')).code).toBe('encode');
    expect(classifyPngError(null).code).toBe('encode');
    expect(classifyPngError(new PngExportError('too-large')).code).toBe('too-large');
    expect(pngExportMessage('tainted')).toMatch(/external content/);
    expect(pngExportMessage('too-large')).toMatch(/too large/);
  });

  it('builds a safe, never-empty file stem', () => {
    expect(canvasFileStem('Auth Service / Flow!')).toBe('auth-service-flow');
    expect(canvasFileStem('***')).toBe('aurvin-canvas');
  });

  it('offers PNG only for non-structured previews and everything only when flagged', () => {
    const base = { flagOn: true, structuredMode: false, viewMode: 'preview' as const };
    expect(canvasExportAvailability(base)).toEqual({ png: true, print: true });
    expect(canvasExportAvailability({ ...base, viewMode: 'code' })).toEqual({ png: false, print: true });
    expect(canvasExportAvailability({ ...base, structuredMode: true })).toEqual({ png: false, print: true });
    expect(canvasExportAvailability({ ...base, flagOn: false })).toEqual({ png: false, print: false });
  });
});
