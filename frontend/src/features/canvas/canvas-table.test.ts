/**
 * ============================================================================
 * FILE: canvas-table.test.ts
 * LOCATION: frontend/src/features/canvas/canvas-table.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Canvas table validation, bounds, sort/filter, safe rendering and flag gate.
 *
 * ROLE IN PROJECT:
 *    Node-environment suite for canvas-table.ts, TableRenderer and table extraction.
 *
 * KEY COMPONENTS:
 *    - parseTableSource bounds/rejections, viewTableRows sort/filter.
 *    - TableRenderer markup: aria-sort, escaped cells, live count.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseTableSource, TABLE_LIMITS, viewTableRows } from './canvas-table.ts';
import { TableRenderer } from './renderers/table-renderer.tsx';
import { parseCanvasCodeBlock } from './index.ts';
import { FEATURE_FLAGS } from '../../app/feature-flags.ts';

const ok = (v: unknown) => {
  const p = parseTableSource(JSON.stringify(v));
  if (!p.ok) throw new Error(p.error);
  return p.model;
};

describe('parseTableSource', () => {
  it('accepts text, numbers, booleans and null cells', () => {
    const m = ok({ columns: ['Name', 'Qty'], rows: [['a', 1], ['b', null], ['c', true]] });
    expect(m.rows).toEqual([['a', '1'], ['b', ''], ['c', 'true']]);
    expect(m.numeric).toEqual([false, false]);
  });
  it('rejects malformed shapes and non-primitive cells', () => {
    for (const bad of ['{', '[]', '{"columns":[],"rows":[]}', '{"columns":["a"],"rows":"x"}', '{"columns":["a"],"rows":[{"a":1}]}',
      '{"columns":["a"],"rows":[[{"x":1}]]}', '{"columns":[1],"rows":[]}']) {
      expect(parseTableSource(bad).ok, bad).toBe(false);
    }
  });
  it('bounds columns, rows, cells and source size', () => {
    const m = ok({
      columns: Array.from({ length: 20 }, (_, i) => `c${i}`),
      rows: Array.from({ length: 100 }, () => ['x'.repeat(250)]),
    });
    expect(m.columns).toHaveLength(TABLE_LIMITS.maxColumns);
    expect(m.rows).toHaveLength(100);
    expect(m.rows[0]![0]).toHaveLength(TABLE_LIMITS.maxCell);
    expect(m.truncated).toBe(true);
    const tall = ok({ columns: ['a'], rows: Array.from({ length: 500 }, () => ['x']) });
    expect(tall.rows).toHaveLength(TABLE_LIMITS.maxRows);
    expect(tall.truncated).toBe(true);
    expect(parseTableSource(' '.repeat(TABLE_LIMITS.maxSource + 1)).ok).toBe(false);
  });
});

describe('viewTableRows', () => {
  const m = ok({ columns: ['Item', 'Qty'], rows: [['pear', 10], ['Apple', 9], ['fig', ''], ['apple pie', 100]] });
  it('detects numeric columns and sorts numerically with blanks last', () => {
    expect(m.numeric).toEqual([false, true]);
    expect(viewTableRows(m, '', { column: 1, direction: 'asc' }).map((r) => r[1])).toEqual(['9', '10', '100', '']);
    expect(viewTableRows(m, '', { column: 1, direction: 'desc' }).map((r) => r[1])).toEqual(['100', '10', '9', '']);
  });
  it('sorts text case-insensitively and filters by substring across cells', () => {
    expect(viewTableRows(m, '', { column: 0, direction: 'asc' }).map((r) => r[0])).toEqual(['Apple', 'apple pie', 'fig', 'pear']);
    expect(viewTableRows(m, ' APPLE ', null).map((r) => r[0])).toEqual(['Apple', 'apple pie']);
    expect(viewTableRows(m, '10', null).map((r) => r[0])).toEqual(['pear', 'apple pie']);
    expect(viewTableRows(m, 'zzz', null)).toEqual([]);
  });
  it('does not mutate the model', () => {
    const before = JSON.stringify(m.rows);
    viewTableRows(m, '', { column: 0, direction: 'desc' });
    expect(JSON.stringify(m.rows)).toBe(before);
  });
});

describe('TableRenderer', () => {
  const source = JSON.stringify({ columns: ['Name', 'Qty'], rows: [['<img src=x onerror=alert(1)>', 3], ['b', 4]] });
  it('renders accessible markup and escapes cell text', () => {
    const html = renderToStaticMarkup(createElement(TableRenderer, { source, title: 'Stock' }));
    expect(html).toContain('<caption>Stock</caption>');
    expect(html).toContain('scope="col"');
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain('aria-label="Sort by Name"');
    expect(html).toContain('aria-label="Filter table rows"');
    expect(html).toContain('role="status"');
    expect(html).toContain('2 rows');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('class="is-numeric"');
  });
  it('shows an error and the escaped source for invalid data', () => {
    const html = renderToStaticMarkup(createElement(TableRenderer, { source: '{"columns":["a"]' }));
    expect(html).toContain('aurvin-canvas-fallback');
    expect(html).not.toContain('<table');
  });
});

describe('table artifact extraction', () => {
  it('is flagged off by default and recognised when enabled', () => {
    expect(FEATURE_FLAGS.canvasTables).toBe(false);
    const src = '{"columns":["a"],"rows":[["1"]]}';
    expect(parseCanvasCodeBlock('table title="Stock"', src, 'm1', 0)).toBeNull();
    const a = parseCanvasCodeBlock('table title="Stock"', src, 'm1', 0, false, true);
    expect(a).toMatchObject({ kind: 'table', title: 'Stock', buttonLabel: 'View table', subType: 'Data Table' });
  });
});
