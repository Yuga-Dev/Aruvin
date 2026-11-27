/**
 * ============================================================================
 * FILE: canvas-export.ts
 * LOCATION: frontend/src/features/canvas/canvas-export.ts
 * ============================================================================
 *
 * PURPOSE:
 *    PNG export and print for Canvas artifacts using only platform features.
 *
 * ROLE IN PROJECT:
 *    Used by CanvasPanel's toolbar. Pure helpers (size planning, SVG markup
 *    normalisation, error mapping, availability) are unit tested in Node; the
 *    DOM-bound functions (SVG -> Image -> canvas -> PNG, print container) need
 *    a browser.
 *
 * KEY COMPONENTS:
 *    - planPngSize: devicePixelRatio and canvas-limit math.
 *    - prepareSvgMarkup: standalone SVG normalisation with optional background.
 *    - exportSvgToPng: serialize SVG, draw to <canvas>, toBlob('image/png').
 *    - printCanvasElement: prints a copy of one element, hiding the chat UI.
 * ============================================================================
 */

export const PNG_MAX_EDGE = 8192;
export const PNG_MAX_PIXELS = 36_000_000;
export const PNG_MAX_DPR = 3;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export type PngPlan =
  | { ok: true; width: number; height: number; scale: number }
  | { ok: false; reason: 'invalid-size' | 'too-large' };

/**
 * Bitmap size for a CSS-sized artifact: honours devicePixelRatio (1..3) but lowers the
 * scale to stay inside browser canvas limits; an artifact larger than the limits at 1x fails.
 */
export function planPngSize(cssWidth: number, cssHeight: number, dpr: number): PngPlan {
  if (![cssWidth, cssHeight].every((n) => Number.isFinite(n) && n > 0)) {
    return { ok: false, reason: 'invalid-size' };
  }
  const wanted = clamp(Number.isFinite(dpr) ? dpr : 1, 1, PNG_MAX_DPR);
  const limit = Math.min(
    PNG_MAX_EDGE / Math.max(cssWidth, cssHeight),
    Math.sqrt(PNG_MAX_PIXELS / (cssWidth * cssHeight)),
  );
  if (limit < 1) return { ok: false, reason: 'too-large' };
  const scale = Math.min(wanted, limit);
  return {
    ok: true,
    scale,
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
  };
}

export type PngExportErrorCode =
  | 'invalid-size' | 'too-large' | 'tainted' | 'image-load' | 'encode' | 'unsupported';

export class PngExportError extends Error {
  readonly code: PngExportErrorCode;
  constructor(code: PngExportErrorCode) {
    super(code);
    this.name = 'PngExportError';
    this.code = code;
  }
}

const PNG_MESSAGES: Record<PngExportErrorCode, string> = {
  'invalid-size': 'This diagram has no measurable size yet, so it cannot be exported as PNG.',
  'too-large': 'This diagram is too large to export as PNG. Download it as SVG instead.',
  tainted: 'The browser blocked PNG export because the diagram uses external content. Download it as SVG instead.',
  'image-load': 'The diagram could not be rendered to an image. Download it as SVG instead.',
  encode: 'The PNG could not be created. Try again or download it as SVG.',
  unsupported: 'PNG export is not supported in this browser. Download it as SVG instead.',
};

export const pngExportMessage = (code: PngExportErrorCode): string => PNG_MESSAGES[code];

export function classifyPngError(error: unknown): PngExportError {
  if (error instanceof PngExportError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  return new PngExportError(name === 'SecurityError' ? 'tainted' : 'encode');
}

/** Lowercase, hyphenated file stem; never empty. */
export function canvasFileStem(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'aurvin-canvas';
}

/** Which controls apply; `flagOn` is FEATURE_FLAGS.canvasExportPrint. */
export function canvasExportAvailability(input: {
  flagOn: boolean;
  structuredMode: boolean;
  viewMode: 'preview' | 'code';
}): { png: boolean; print: boolean } {
  return {
    png: input.flagOn && !input.structuredMode && input.viewMode === 'preview',
    print: input.flagOn,
  };
}

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|hsl)a?\([0-9a-z\s,./%-]+\))$/i;

/**
 * Normalises serialized SVG for use as a standalone image: namespaces, explicit pixel size,
 * a viewBox, and an optional opaque background rect (the colour is validated, never raw markup).
 */
export function prepareSvgMarkup(
  serialized: string,
  opts: { width: number; height: number; background: string | null },
): string {
  const open = /<svg\b[^>]*>/.exec(serialized);
  if (!open) throw new PngExportError('image-load');
  const tag = open[0];
  const hasViewBox = /\sviewBox\s*=/.test(tag);
  let attrs = tag
    .slice(4, -1)
    .replace(/\s(width|height|style)\s*=\s*("[^"]*"|'[^']*')/g, '')
    .replace(/\/\s*$/, '');
  if (!/\sxmlns\s*=/.test(attrs)) attrs += ' xmlns="http://www.w3.org/2000/svg"';
  if (/xlink:/.test(serialized) && !/xmlns:xlink\s*=/.test(attrs)) {
    attrs += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
  }
  if (!hasViewBox) attrs += ` viewBox="0 0 ${opts.width} ${opts.height}"`;
  const background =
    opts.background && SAFE_COLOR.test(opts.background.trim())
      ? `<rect width="100%" height="100%" fill="${opts.background.trim()}"/>`
      : '';
  return `<svg${attrs} width="${opts.width}" height="${opts.height}">${background}${serialized.slice(open.index + tag.length)}`;
}

const INLINE_STYLE_PROPS = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'opacity', 'color', 'font-family', 'font-size',
  'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing',
  'visibility', 'display',
] as const;

/** Natural CSS size of an SVG: width/height attributes, else viewBox, else bounding box. */
export function measureSvgSize(svg: SVGSVGElement): { width: number; height: number } | null {
  const attr = (name: string) => {
    const raw = svg.getAttribute(name);
    return raw && !raw.trim().endsWith('%') ? Number.parseFloat(raw) : Number.NaN;
  };
  let width = attr('width');
  let height = attr('height');
  if (!(width > 0 && height > 0)) {
    const box = svg.viewBox?.baseVal;
    if (box && box.width > 0 && box.height > 0) {
      width = box.width;
      height = box.height;
    } else {
      try {
        const bbox = svg.getBBox();
        width = bbox.x + bbox.width;
        height = bbox.y + bbox.height;
      } catch {
        return null;
      }
    }
  }
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Computed background of the nearest ancestor that paints one, else white. */
export function resolveCanvasBackground(el: Element): string {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && !/^rgba\([^)]*,\s*0\)$/.test(color)) return color;
  }
  return '#ffffff';
}

/** Clone with page CSS (including var()-based colours) resolved into inline styles. */
function cloneWithComputedStyles(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const live = [svg, ...svg.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  live.forEach((source, i) => {
    const target = copies[i];
    if (!target) return;
    const computed = getComputedStyle(source);
    target.setAttribute(
      'style',
      INLINE_STYLE_PROPS.map((prop) => `${prop}:${computed.getPropertyValue(prop)}`).join(';'),
    );
  });
  return clone;
}

/**
 * Renders an on-screen SVG to a PNG blob. Throws PngExportError; map `.code` to a
 * user-facing message with pngExportMessage.
 */
export async function exportSvgToPng(
  svg: SVGSVGElement,
  opts: { background: 'theme' | 'transparent'; dpr?: number; timeoutMs?: number },
): Promise<Blob> {
  if (typeof document === 'undefined' || typeof XMLSerializer === 'undefined' || typeof Image === 'undefined') {
    throw new PngExportError('unsupported');
  }
  const size = measureSvgSize(svg);
  if (!size) throw new PngExportError('invalid-size');
  const plan = planPngSize(size.width, size.height, opts.dpr ?? globalThis.devicePixelRatio ?? 1);
  if (!plan.ok) throw new PngExportError(plan.reason);
  const markup = prepareSvgMarkup(new XMLSerializer().serializeToString(cloneWithComputedStyles(svg)), {
    width: size.width,
    height: size.height,
    background: opts.background === 'theme' ? resolveCanvasBackground(svg) : null,
  });
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PngExportError('image-load')), opts.timeoutMs ?? 10_000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new PngExportError('image-load')); };
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PngExportError('too-large');
    ctx.drawImage(image, 0, 0, plan.width, plan.height);
    return await new Promise<Blob>((resolve, reject) => {
      try {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new PngExportError('too-large'))), 'image/png');
      } catch (error) {
        reject(classifyPngError(error));
      }
    });
  } catch (error) {
    throw classifyPngError(error);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const PRINT_ROOT_ID = 'aurvin-print-root';

/**
 * Prints a copy of `source` only: canvas-print.css hides the chat UI while
 * `data-aurvin-printing` is set, and the light theme is forced so ink matches paper.
 * Returns the cleanup (also run on afterprint or after a safety timeout).
 */
export function printCanvasElement(source: Element, title: string): () => void {
  const doc = source.ownerDocument;
  const root = doc.documentElement;
  const container = doc.createElement('div');
  container.id = PRINT_ROOT_ID;
  const heading = doc.createElement('h1');
  heading.textContent = title;
  const copy = source.cloneNode(true) as Element;
  copy.removeAttribute('style');
  container.append(heading, copy);
  doc.body.append(container);
  const previousTheme = root.getAttribute('data-theme');
  root.setAttribute('data-theme', 'light');
  root.setAttribute('data-aurvin-printing', 'true');
  let done = false;
  // ponytail: if afterprint never fires the chat stays hidden up to 120 s; upgrade to matchMedia('print') tracking.
  const safety = setTimeout(() => cleanup(), 120_000);
  function cleanup() {
    if (done) return;
    done = true;
    clearTimeout(safety);
    window.removeEventListener('afterprint', cleanup);
    container.remove();
    root.removeAttribute('data-aurvin-printing');
    if (previousTheme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', previousTheme);
  }
  window.addEventListener('afterprint', cleanup);
  try {
    window.print();
  } catch {
    cleanup();
  }
  return cleanup;
}
