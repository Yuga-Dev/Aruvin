# Release 2: Canvas renderers (diagrams, Calendar day/week, data tables)

Status: implemented on `codex/release-2-canvas-renderers`; see "Results" at the end. Unified review: **skipped** (workflow `--skip review`).

## Scope

1. More Mermaid diagram types in Canvas.
2. Read-only Calendar day and week views, built from the existing agenda view data.
3. A Canvas data table with client-side sort and filter.

Out of scope here: code-splitting, PNG/print/copy controls, task mode, chat transcript/reducer, voice projection contract.

## Diagram types

Previously supported: flowchart/graph, sequenceDiagram, stateDiagram(-v2), pie, xychart-beta, quadrantChart.
Previously "unsupported" fallback: classDiagram, erDiagram, gantt, journey, mindmap, timeline, gitGraph, and others.

Added (mapped onto the existing flowchart layout, no new dependency): **mindmap**, **erDiagram**, **classDiagram**.
Still unsupported (need a new renderer, not just a mapping): gantt, journey, timeline, gitGraph, sankey, block, etc.

Bounds: at most 60 nodes and 120 edges per diagram, 200 characters per line; extras are dropped. Labels render as SVG text (escaped).

## Calendar day/week views

`CalendarGridView` renders an agenda result as a Day or Week list grouped by day in the display time zone, with previous/next navigation. Read-only; no Calendar write path, no new network calls. Agenda stays the default view.

## Data table

Fenced block ```` ```table ```` with JSON `{"columns":["A","B"],"rows":[["x",1]]}`.
Bounds: 12 columns, 200 rows, 200 characters per cell, 60 per header, 32 KB source. Cells must be string/number/boolean/null; anything else is rejected. Cells are rendered as React text only (no HTML, no links). Sort (numeric when a whole column is numeric) and substring filter run in the browser. Header buttons carry `aria-sort`; a live region announces the visible row count.

Validation is client-side only: text-mode artifacts are extracted by the browser from the model's fenced blocks (as for chart/mermaid), and the voice projection contract (`backend/src/contracts/voice-wire.ts`) is unchanged, so a server-side table guard would have no consumer. The model is not yet told to emit tables (flag off; `system.md` unchanged).

## Flags (`frontend/src/app/feature-flags.ts`, all `false`)

- `canvasMoreDiagrams`: mindmap/ER/class rendering (off: existing "not rendered yet" fallback).
- `canvasCalendarGrid`: Day/Week toggle on Calendar agenda.
- `canvasTables`: recognise ```` ```table ```` blocks as Canvas artifacts.

## Tests (27 new, all passing)

- `frontend/src/features/canvas/diagram-types-extra.test.ts` (10): flag gate, mindmap/ER/class structure, inheritance direction, rendering with the flag on, header-only streaming fallback, node/edge caps, garbage lines, escaping.
- `frontend/src/features/canvas/canvas-table.test.ts` (10): accepted cell types, rejected shapes, column/row/cell/source bounds, numeric and text sort, blanks last, filter, no mutation, safe markup/aria, invalid-data fallback, flag-gated extraction.
- `frontend/src/features/canvas/renderers/calendar-grid-view.test.ts` (7): Monday week start, display-zone day placement, multi-day and exclusive ends, ordering, agenda default, day and week markup, escaping, flag gate.

## Results

- Frontend `npm test`: 132 files, 1160 tests passed. `npm run build`: passed (existing chunk-size warning). `npm run lint`: 0 errors; warnings only (new file adds the same `only-export-components`/`Date.now` default-parameter warnings as `calendar-agenda-view.tsx`).
- Backend untouched, so backend checks were not run.
- Verified in Node (`renderToStaticMarkup`) only. Browser rendering, real keyboard/screen-reader behaviour, layout and CSS were **not** verified in a browser.

## Limitations

- All three flags ship off; turning them on needs a browser check first. Table emission also needs a `system.md` canvas guideline (not added) and a `table` entry in the voice projection only if voice should show tables.
- Class/ER nodes show the name plus at most two members/attributes; ER cardinality markers and class relation glyphs are not drawn (edges are plain arrows, dashed for `..`). Mindmap shapes are flattened.
- gantt, journey, timeline, gitGraph and other types still use the unsupported fallback.
- Day/Week views only re-slice the entries already returned by the agenda tool; they cannot fetch other ranges, and show no event links or details (Agenda mode keeps them).
- Table sort/filter state resets when the artifact is closed; filter is a plain substring match.
