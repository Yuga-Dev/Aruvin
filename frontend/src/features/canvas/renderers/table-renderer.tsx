/**
 * ============================================================================
 * FILE: table-renderer.tsx
 * LOCATION: frontend/src/features/canvas/renderers/table-renderer.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render a validated Canvas data table with keyboard-accessible sort and filter.
 *
 * ROLE IN PROJECT:
 *    Canvas body for `table` artifacts. Cells are React text children, so
 *    model-supplied content can never inject markup or links.
 *
 * KEY COMPONENTS:
 *    - TableRenderer: filter input, sortable column header buttons, live row count.
 * ============================================================================
 */

import { useMemo, useState } from 'react';
import { parseTableSource, viewTableRows, type TableSort } from '../canvas-table.ts';

export function TableRenderer({ source, title }: { source: string; title?: string }) {
  const parsed = useMemo(() => parseTableSource(source), [source]);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<TableSort>(null);
  const model = parsed.ok ? parsed.model : null;
  const rows = useMemo(() => (model ? viewTableRows(model, filter, sort) : []), [model, filter, sort]);

  if (!model) {
    return (
      <div className="aurvin-canvas-fallback">
        <p className="aurvin-canvas-fallback-note">{parsed.ok ? '' : parsed.error}</p>
        <pre className="aurvin-canvas-fallback-code"><code>{source}</code></pre>
      </div>
    );
  }

  const cycle = (column: number) =>
    setSort((prev) => (prev?.column !== column ? { column, direction: 'asc' } : prev.direction === 'asc' ? { column, direction: 'desc' } : null));

  return (
    <section className="aurvin-canvas-table" aria-label={title || 'Data table'}>
      <div className="aurvin-canvas-table-tools">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter rows"
          aria-label="Filter table rows"
        />
        <span role="status" aria-live="polite">
          {rows.length === model.rows.length ? `${rows.length} rows` : `${rows.length} of ${model.rows.length} rows`}
        </span>
      </div>
      {model.truncated ? <p role="note">Only part of this table is shown.</p> : null}
      <div className="aurvin-canvas-table-scroll" tabIndex={0} role="region" aria-label="Table, scrollable">
        <table>
          {title ? <caption>{title}</caption> : null}
          <thead>
            <tr>
              {model.columns.map((name, i) => {
                const active = sort?.column === i ? sort : null;
                return (
                  <th key={i} scope="col" aria-sort={active ? (active.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => cycle(i)} aria-label={`Sort by ${name}`}>
                      {name}
                      <span aria-hidden="true">{active ? (active.direction === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={model.columns.length}>No matching rows.</td></tr>
            ) : (
              rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={model.numeric[c] ? 'is-numeric' : undefined}>{cell}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
