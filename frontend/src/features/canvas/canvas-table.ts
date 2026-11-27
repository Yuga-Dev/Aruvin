/**
 * ============================================================================
 * FILE: canvas-table.ts
 * LOCATION: frontend/src/features/canvas/canvas-table.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate a Canvas table source and apply client-side sort and filter.
 *
 * ROLE IN PROJECT:
 *    Pure, bounded logic behind the table artifact; the renderer only draws
 *    what this module accepts. Cells are text, never markup.
 *
 * KEY COMPONENTS:
 *    - TABLE_LIMITS: column/row/cell/source caps.
 *    - parseTableSource: JSON text -> validated model or an error message.
 *    - viewTableRows: substring filter then stable, numeric-aware sort.
 * ============================================================================
 */

export const TABLE_LIMITS = { maxColumns: 12, maxRows: 200, maxCell: 200, maxHeader: 60, maxSource: 32768 } as const;

export type TableModel = { columns: string[]; rows: string[][]; numeric: boolean[]; truncated: boolean };
export type TableParse = { ok: true; model: TableModel } | { ok: false; error: string };
export type TableSort = { column: number; direction: 'asc' | 'desc' } | null;

const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

export function parseTableSource(source: string): TableParse {
  if (source.length > TABLE_LIMITS.maxSource) return { ok: false, error: 'Table is too large to display.' };
  let data: unknown;
  try { data = JSON.parse(source); } catch { return { ok: false, error: 'Table data is not valid yet.' }; }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, error: 'Table data must be an object.' };
  const { columns, rows } = data as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(columns) || columns.length === 0 || !columns.every((c) => typeof c === 'string' && c.trim())) {
    return { ok: false, error: 'Table needs a list of column names.' };
  }
  if (!Array.isArray(rows) || !rows.every((r) => Array.isArray(r))) return { ok: false, error: 'Table rows must be lists of cells.' };
  const cols = columns.slice(0, TABLE_LIMITS.maxColumns).map((c) => (c as string).trim().slice(0, TABLE_LIMITS.maxHeader));
  const kept = (rows as unknown[][]).slice(0, TABLE_LIMITS.maxRows);
  const out: string[][] = [];
  for (const row of kept) {
    const cells: string[] = [];
    for (let i = 0; i < cols.length; i++) {
      const v = row[i];
      if (v === undefined || v === null) cells.push('');
      else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') cells.push(String(v).slice(0, TABLE_LIMITS.maxCell));
      else return { ok: false, error: 'Table cells must be text, numbers, or true/false.' };
    }
    out.push(cells);
  }
  const numeric = cols.map((_, i) => {
    const filled = out.map((r) => r[i]!.trim()).filter(Boolean);
    return filled.length > 0 && filled.every((v) => NUMBER_RE.test(v));
  });
  const truncated = columns.length > cols.length || rows.length > kept.length;
  return { ok: true, model: { columns: cols, rows: out, numeric, truncated } };
}

export function viewTableRows(model: TableModel, filter: string, sort: TableSort): string[][] {
  const needle = filter.trim().toLowerCase();
  const rows = needle ? model.rows.filter((r) => r.some((c) => c.toLowerCase().includes(needle))) : [...model.rows];
  if (!sort) return rows;
  const { column, direction } = sort;
  const sign = direction === 'asc' ? 1 : -1;
  const numeric = model.numeric[column];
  // Array.prototype.sort is stable, so equal cells keep source order.
  return rows.sort((a, b) => {
    const x = a[column]!, y = b[column]!;
    if (!x.trim() !== !y.trim()) return x.trim() ? -1 : 1; // blanks always last
    return sign * (numeric ? Number(x) - Number(y) : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }));
  });
}
