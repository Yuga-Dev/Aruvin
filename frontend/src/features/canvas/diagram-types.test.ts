/**
 * ============================================================================
 * FILE: diagram-types.test.ts
 * LOCATION: frontend/src/features/canvas/diagram-types.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Mermaid state diagrams, pie charts, and the unsupported-type
 *    fallback in Aurvin's Canvas.
 *
 * ROLE IN PROJECT:
 *    Node-environment (no DOM) regression suite for parseMermaidSource and
 *    MermaidRenderer covering realistic LLM-generated diagram sources.
 *
 * KEY COMPONENTS:
 *    - State diagram parsing: aliases, descriptions, composites, notes, pseudo-states.
 *    - State diagram layout: overlap and cycle checks on rendered SVG.
 *    - Pie parsing/rendering edge cases and unsupported-type fallback.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseMermaidSource } from './index.ts';
import { MermaidRenderer } from './renderers/mermaid-renderer.tsx';
import type { MermaidFlowModel } from './canvas-types.ts';

const render = (source: string) => renderToStaticMarkup(createElement(MermaidRenderer, { source }));

function parseState(source: string): MermaidFlowModel {
  const model = parseMermaidSource(source);
  if (model.kind !== 'flowchart') throw new Error(`expected flowchart model, got ${model.kind}`);
  return model;
}

function nodeBoxes(html: string) {
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  const re = /<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"[^>]*class="aurvin-canvas-node-(?:shape|state-start)"/g;
  for (const m of html.matchAll(re)) {
    boxes.push({ x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) });
  }
  return boxes;
}

function expectNoOverlap(boxes: ReturnType<typeof nodeBoxes>) {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlaps =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlaps, `boxes ${i} and ${j} overlap`).toBe(false);
    }
  }
}

const FULL_STATE = [
  'stateDiagram-v2',
  '    direction LR',
  '    %% request lifecycle',
  '    [*] --> Idle',
  '    state "Waiting for input" as Wait',
  '    Idle --> Wait : user opens form',
  '    Wait : Shows the form',
  '    Wait --> Validate',
  '    state check <<choice>>',
  '    Validate --> check',
  '    check --> Processing : valid',
  '    check --> Wait : invalid',
  '    state Processing {',
  '        [*] --> Charging',
  '        Charging --> Shipping : paid',
  '        Shipping --> [*]',
  '    }',
  '    state fork1 <<fork>>',
  '    state join1 <<join>>',
  '    Processing --> fork1',
  '    fork1 --> Email',
  '    fork1 --> Log',
  '    Email --> join1',
  '    Log --> join1',
  '    join1 --> Done',
  '    note right of Done : Terminal state',
  '    note left of Email',
  '      sends receipt',
  '      to customer',
  '    end note',
  '    Done --> [*]',
  '    Idle --> Idle : tick',
].join('\n');

describe('state diagrams', () => {
  it('parses start/end pseudo-states, labelled transitions, and no-space arrows', () => {
    const m = parseState('stateDiagram-v2\n[*] --> Still\nStill-->Moving : push\nMoving --> [*]');
    expect(m.nodes.map((n) => [n.id, n.shape])).toEqual([
      ['__start_root', 'state-start'],
      ['Still', 'rounded'],
      ['Moving', 'rounded'],
      ['__end_root', 'state-end'],
    ]);
    expect(m.edges.map((e) => [e.from, e.to, e.label])).toEqual([
      ['__start_root', 'Still', undefined],
      ['Still', 'Moving', 'push'],
      ['Moving', '__end_root', undefined],
    ]);
  });

  it('supports the legacy stateDiagram header', () => {
    expect(parseState('stateDiagram\n[*] --> A\nA --> B').edges).toHaveLength(2);
  });

  it('handles aliases and descriptions without losing the state name', () => {
    const m = parseState(
      [
        'stateDiagram-v2',
        'state "Long running job" as Job',
        'Idle : Waiting for work',
        'Idle : Polls every 5s',
        'Job --> Idle',
      ].join('\n'),
    );
    expect(m.nodes.find((n) => n.id === 'Job')?.label).toBe('Long running job');
    expect(m.nodes.find((n) => n.id === 'Idle')?.label).toBe('Idle\nWaiting for work\nPolls every 5s');
    const html = render('stateDiagram-v2\nIdle : Waiting for work\nIdle --> Busy');
    expect(html).toContain('Waiting for work');
    expect(html).toContain('>Idle<');
  });

  it('turns composite states into subgraphs and routes edges to the right inner nodes', () => {
    const m = parseState(FULL_STATE);
    expect(m.direction).toBe('LR');
    expect(m.subgraphs).toHaveLength(1);
    expect(m.subgraphs[0]).toMatchObject({ id: 'Processing' });
    expect(m.subgraphs[0]!.nodeIds).toEqual(['__start_Processing', 'Charging', 'Shipping', '__end_Processing']);
    // Forward reference (check --> Processing before the block) must not create a stray node.
    expect(m.nodes.filter((n) => n.id === 'Processing')).toHaveLength(0);
    expect(m.edges).toContainEqual(expect.objectContaining({ from: 'check', to: '__start_Processing', label: 'valid' }));
    expect(m.edges).toContainEqual(expect.objectContaining({ from: '__end_Processing', to: 'fork1' }));
  });

  it('maps choice, fork, and join pseudo-states to dedicated shapes', () => {
    const m = parseState(FULL_STATE);
    const shape = (id: string) => m.nodes.find((n) => n.id === id)?.shape;
    expect(shape('check')).toBe('diamond');
    expect(shape('fork1')).toBe('state-bar');
    expect(shape('join1')).toBe('state-bar');
  });

  it('renders notes (single and multi-line) as connected nodes and ignores % comments', () => {
    const m = parseState(FULL_STATE);
    const notes = m.nodes.filter((n) => n.id.startsWith('__note_'));
    expect(notes.map((n) => n.label)).toEqual(['Terminal state', 'sends receipt to customer']);
    expect(m.nodes.some((n) => n.label.includes('request lifecycle'))).toBe(false);
    const html = render(FULL_STATE);
    expect(html).toContain('Terminal state');
    expect(html).not.toContain('request lifecycle');
  });

  it('renders the full realistic diagram with no overlapping nodes and one path per edge', () => {
    const m = parseState(FULL_STATE);
    const html = render(FULL_STATE);
    expect(html).toContain('<svg');
    expect(html).toContain('Waiting for input');
    expect(html).toContain('user opens form');
    expect(html).toContain('aurvin-canvas-subgraph-box');
    expect(html.match(/aurvin-canvas-edge-path/g)).toHaveLength(m.edges.length);
    expectNoOverlap(nodeBoxes(html));
  });

  it('keeps retry loops compact instead of inflating ranks around cycles', () => {
    const src = 'stateDiagram-v2\n[*] --> Idle\nIdle --> Run\nRun --> Fail\nFail --> Idle : retry\nRun --> [*]';
    const html = render(src);
    const boxes = nodeBoxes(html);
    expectNoOverlap(boxes);
    // Idle, Run, Fail, plus start/end: width must stay near 4 ranks, not n*5 visits deep.
    const width = Number(/viewBox="0 0 ([\d.]+)/.exec(html)![1]);
    const height = Number(/viewBox="0 0 [\d.]+ ([\d.]+)/.exec(html)![1]);
    expect(Math.max(width, height)).toBeLessThan(700);
  });

  it('lays out cyclic diagrams that also contain composite states in flow order', () => {
    const src = [
      'stateDiagram-v2',
      '[*] --> Draft',
      'Draft --> Review',
      'Review --> Draft : changes requested',
      'Review --> Publishing',
      'state Publishing {',
      '  [*] --> Build',
      '  Build --> Deploy',
      '  Deploy --> [*]',
      '}',
      'Publishing --> Live',
      'Live --> [*]',
    ].join('\n');
    const html = render(src);
    const boxes = nodeBoxes(html);
    expectNoOverlap(boxes);
    const ys = [...html.matchAll(/<rect x="[\d.-]+" y="([\d.-]+)" width="132" height="46"[^>]*node-shape/g)].map((m) =>
      Number(m[1]),
    );
    // Draft < Review < Build < Deploy < Live in a top-down flow.
    expect(new Set(ys).size).toBe(ys.length);
  });

  it('degrades gracefully for unsupported or malformed constructs', () => {
    const odd = [
      'stateDiagram-v2',
      'classDef active fill:#f9f',
      'class A active',
      'state "unterminated',
      '}',
      '}',
      '--',
      'hide empty description',
      'scale 350 width',
      'A --> B : ok',
      'state Empty {',
      '}',
      'B --> Empty',
      'note over A : nope',
    ].join('\n');
    expect(() => render(odd)).not.toThrow();
    const m = parseState(odd);
    expect(m.edges.map((e) => [e.from, e.to])).toEqual([
      ['A', 'B'],
      ['B', 'Empty'],
    ]);
    // An empty composite collapses into a plain node.
    expect(m.nodes.find((n) => n.id === 'Empty')).toBeTruthy();
    expect(m.subgraphs).toHaveLength(0);
    expect(render(odd)).toContain('<svg');
  });

  it('shows the generating fallback for an empty or header-only state diagram', () => {
    for (const src of ['stateDiagram-v2', 'stateDiagram-v2\n%% nothing yet']) {
      const html = render(src);
      expect(html).toContain('aurvin-canvas-fallback');
      expect(html).not.toContain('<svg');
    }
  });

  it('handles nested composites and transitions from a composite without throwing', () => {
    const src = [
      'stateDiagram-v2',
      'state Outer {',
      '  [*] --> Inner1',
      '  state Inner1 {',
      '    [*] --> Leaf',
      '  }',
      '}',
      '[*] --> Outer',
      'Outer --> Done',
    ].join('\n');
    const html = render(src);
    expect(html).toContain('<svg');
    expectNoOverlap(nodeBoxes(html));
  });

  it('uses theme tokens only (no hard-coded colours) for node, edge and pseudo-state paint', () => {
    const html = render(FULL_STATE);
    expect(html).not.toMatch(/(?:fill|stroke)="#[0-9a-fA-F]{3,8}"/);
    // Hex values may only appear as var() fallbacks.
    expect(html.replace(/var\([^)]*\)/g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});

describe('pie charts', () => {
  const pie = (lines: string[]) => lines.join('\n');

  it('renders title, slices, values and percentages', () => {
    const html = render(pie(['pie title Pets adopted', '  "Dogs" : 386', '  "Cats" : 85', '  "Rats" : 15']));
    expect(html).toContain('Pets adopted');
    expect(html).toContain('Dogs');
    expect(html).toContain('386 (79.4%)');
    expect(html).toContain('85 (17.5%)');
    expect(html).toContain('15 (3.1%)');
    expect(html.match(/<path[^>]*fill="#/g)).toHaveLength(3);
  });

  it('supports showData and a title on its own line', () => {
    const m = parseMermaidSource('pie showData\n  title Key elements\n  "Calcium" : 42.96\n  "Potassium" : 50.05');
    expect(m.kind).toBe('chart');
    if (m.kind !== 'chart') return;
    expect(m.chart.title).toBe('Key elements');
    expect(m.chart.labels).toEqual(['Calcium', 'Potassium']);
    expect(m.chart.datasets[0]!.data).toEqual([42.96, 50.05]);
    const html = render('pie showData\n  title Key elements\n  "Calcium" : 42.96\n  "Potassium" : 50.05');
    expect(html).toContain('42.96');
    expect(html).toContain('Key elements');
  });

  it('handles single quotes, colons inside labels, decimals, and comments', () => {
    const m = parseMermaidSource(
      pie(['pie', '  %% comment', '  "Time: day" : 10', "  'Night' : .5", '  "Dusk" : 2.25']),
    );
    expect(m.kind === 'chart' && m.chart.labels).toEqual(['Time: day', 'Night', 'Dusk']);
    expect(m.kind === 'chart' && m.chart.datasets[0]!.data).toEqual([10, 0.5, 2.25]);
  });

  it('skips non-numeric values and clamps negatives to zero', () => {
    const m = parseMermaidSource(pie(['pie', '  "A" : 10', '  "B" : abc', '  "C" : -5', '  "D" : 0']));
    expect(m.kind === 'chart' && m.chart.labels).toEqual(['A', 'C', 'D']);
    expect(m.kind === 'chart' && m.chart.datasets[0]!.data).toEqual([10, 0, 0]);
    const html = render(pie(['pie', '  "A" : 10', '  "C" : -5', '  "D" : 0']));
    expect(html).toContain('10 (100%)');
    expect(html).toContain('0 (0%)');
    expect(html).not.toContain('NaN');
  });

  it('falls back to readable source when no slice has a positive value', () => {
    const html = render(pie(['pie', '  "A" : 0', '  "B" : -3']));
    expect(html).toContain('aurvin-canvas-fallback');
    expect(html).toContain('&quot;A&quot; : 0');
    expect(html).not.toContain('NaN');
    expect(render('pie title Nothing yet')).toContain('aurvin-canvas-fallback');
  });

  it('draws a single 100% slice and many slices without NaN or overflow', () => {
    const single = render(pie(['pie', '  "All" : 7']));
    expect(single).toContain('7 (100%)');
    expect(single).not.toContain('NaN');

    const many = pie(['pie title Many', ...Array.from({ length: 14 }, (_, i) => `  "Slice number ${i + 1}" : ${i + 1}`)]);
    const html = render(many);
    expect(html).not.toContain('NaN');
    expect(html.match(/<path[^>]*fill="#/g)).toHaveLength(14);
    // Palette repeats after 8 colours; repeated slices are dimmed so they stay distinguishable.
    expect(html).toContain('fill-opacity="0.6"');
    expect(Number(/height="(\d+)"/.exec(html)![1])).toBeGreaterThanOrEqual(120 + 14 * 36);
  });

  it('truncates very long legend labels so they do not collide with values', () => {
    const html = render(pie(['pie', `  "${'Extremely long category name '.repeat(4)}" : 3`, '  "Short" : 1']));
    expect(html).toContain('…');
    expect(html).toContain('Short');
  });

  it('keeps slice separators and text on theme tokens', () => {
    const html = render(pie(['pie title T', '  "A" : 1', '  "B" : 2']));
    expect(html).toContain('stroke="var(--aurvin-canvas-bg');
    expect(html).not.toMatch(/(?:text|tspan)[^>]*fill="#/);
  });
});

describe('unsupported Mermaid diagram types', () => {
  const samples: Array<[string, string]> = [
    ['classDiagram', 'classDiagram\n  class Animal {\n    +int age\n    +eat()\n  }\n  Animal <|-- Dog'],
    ['erDiagram', 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE-ITEM : contains'],
    ['gantt', 'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section A\n  Task one :a1, 2026-01-01, 30d'],
    ['journey', 'journey\n  title My day\n  section Work\n    Make tea: 5: Me'],
    ['mindmap', 'mindmap\n  root((Aurvin))\n    Chat\n    Canvas'],
    ['timeline', 'timeline\n  title History\n  2002 : LinkedIn'],
    ['gitGraph', 'gitGraph\n  commit\n  branch dev\n  commit'],
  ];

  for (const [type, source] of samples) {
    it(`${type} shows a clear message and the copyable source instead of a broken render`, () => {
      const parsed = parseMermaidSource(source);
      expect(parsed.kind).toBe('unsupported');
      const html = render(source);
      expect(html).not.toContain('<svg');
      expect(html).toContain('aurvin-canvas-fallback');
      expect(html).toContain(`${type} diagrams are not rendered`);
      expect(html).toContain('<code>');
      expect(html).toContain(source.split('\n')[0]!);
    });
  }

  it('escapes markup inside fallback source', () => {
    const html = render('mindmap\n  root<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('still renders supported types after the unsupported check', () => {
    expect(render('flowchart TD\n  A --> B')).toContain('<svg');
    expect(render('sequenceDiagram\n  A->>B: hi')).toContain('<svg');
  });
});
