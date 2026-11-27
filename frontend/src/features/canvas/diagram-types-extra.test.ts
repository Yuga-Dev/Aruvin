/**
 * ============================================================================
 * FILE: diagram-types-extra.test.ts
 * LOCATION: frontend/src/features/canvas/diagram-types-extra.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify mindmap, erDiagram and classDiagram parsing/rendering (Release 2).
 *
 * ROLE IN PROJECT:
 *    Node-environment regression suite for diagram-parsers.ts and its flag gate.
 *
 * KEY COMPONENTS:
 *    - Flag gate: off keeps the unsupported fallback.
 *    - Per-type structure, bounds, and escaping checks.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MermaidRenderer, parseMermaidSource } from './index.ts';
import { DIAGRAM_LIMITS } from './diagram-parsers.ts';
import { FEATURE_FLAGS } from '../../app/feature-flags.ts';
import type { MermaidFlowModel } from './canvas-types.ts';

const flow = (src: string): MermaidFlowModel => {
  const m = parseMermaidSource(src, undefined, true);
  if (m.kind !== 'flowchart') throw new Error(`expected flowchart, got ${m.kind}`);
  return m;
};

describe('flag gate', () => {
  it('ships off and keeps the unsupported fallback', () => {
    expect(FEATURE_FLAGS.canvasMoreDiagrams).toBe(false);
    for (const s of ['mindmap\n  root', 'erDiagram\n  A ||--o{ B : x', 'classDiagram\n  A <|-- B']) {
      expect(parseMermaidSource(s).kind).toBe('unsupported');
    }
  });
});

describe('mindmap', () => {
  const src = 'mindmap\n  root((Aurvin))\n    Chat\n      Streaming\n      History\n    Canvas\n      ::icon(fa fa-book)\n    [Calendar]';
  it('builds a tree from indentation and strips shape wrappers and icons', () => {
    const m = flow(src);
    expect(m.nodes.map((n) => n.label)).toEqual(['Aurvin', 'Chat', 'Streaming', 'History', 'Canvas', 'Calendar']);
    const label = (id: string) => m.nodes.find((n) => n.id === id)!.label;
    expect(m.edges.map((e) => `${label(e.from)}>${label(e.to)}`)).toEqual([
      'Aurvin>Chat', 'Chat>Streaming', 'Chat>History', 'Aurvin>Canvas', 'Aurvin>Calendar',
    ]);
  });
  it('renders an svg and escapes labels', () => {
    const html = renderToStaticMarkup(createElement(MermaidRenderer, { source: 'mindmap\n  root<script>x</script>' }));
    expect(html).not.toContain('<script>');
  });
});

describe('erDiagram', () => {
  const src = 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||..|{ LINE-ITEM : contains\n  CUSTOMER {\n    string name\n    int id PK\n    string email\n  }';
  it('creates entities, labelled relationships and attribute lists', () => {
    const m = flow(src);
    expect(m.nodes.map((n) => n.id)).toEqual(['CUSTOMER', 'ORDER', 'LINE-ITEM']);
    expect(m.edges).toEqual([
      { from: 'CUSTOMER', to: 'ORDER', label: 'places', style: 'solid' },
      { from: 'ORDER', to: 'LINE-ITEM', label: 'contains', style: 'dashed' },
    ]);
    expect(m.nodes[0]!.label).toBe('CUSTOMER\nstring name\nint id PK\n…');
  });
});

describe('classDiagram', () => {
  const src = 'classDiagram\n  class Animal {\n    +int age\n    +eat()\n  }\n  Animal <|-- Dog\n  Dog *-- Tail : has\n  Dog : +bark()\n  Dog ..> Food';
  it('points inheritance child -> parent and collects members', () => {
    const m = flow(src);
    expect(m.nodes.map((n) => n.id)).toEqual(['Animal', 'Dog', 'Tail', 'Food']);
    expect(m.edges[0]).toEqual({ from: 'Dog', to: 'Animal', label: undefined, style: 'solid' });
    expect(m.edges[1]).toMatchObject({ from: 'Dog', to: 'Tail', label: 'has' });
    expect(m.edges[2]).toMatchObject({ from: 'Dog', to: 'Food', style: 'dashed' });
    expect(m.nodes[0]!.label).toBe('Animal\n+int age\n+eat()');
    expect(m.nodes[1]!.label).toBe('Dog\n+bark()');
  });
});

describe('rendering with the flag on', () => {
  const render = (source: string) => renderToStaticMarkup(createElement(MermaidRenderer, { source, moreDiagrams: true }));
  it('draws svg for each new type instead of the fallback', () => {
    for (const source of ['mindmap\n  root\n    a', 'erDiagram\n  CUSTOMER ||--o{ ORDER : places', 'classDiagram\n  Animal <|-- Dog']) {
      const html = render(source);
      expect(html).toContain('<svg');
      expect(html).not.toContain('not rendered');
    }
    expect(render('erDiagram\n  CUSTOMER ||--o{ ORDER : places')).toContain('places');
  });
  it('shows the generating fallback for a header-only source', () => {
    expect(render('classDiagram')).toContain('Generating diagram');
  });
});

describe('bounds and partial input', () => {
  it('caps nodes and edges', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `  N${i} ||--o{ N${i + 1} : r`);
    const m = flow(`erDiagram\n${lines.join('\n')}`);
    expect(m.nodes.length).toBeLessThanOrEqual(DIAGRAM_LIMITS.maxNodes);
    expect(m.edges.length).toBeLessThanOrEqual(DIAGRAM_LIMITS.maxEdges);
    expect(flow(`mindmap\n${Array.from({ length: 200 }, (_, i) => `  n${i}`).join('\n')}`).nodes.length).toBe(DIAGRAM_LIMITS.maxNodes);
  });
  it('header-only (streaming) sources produce an empty model, not an error', () => {
    for (const h of ['mindmap', 'erDiagram', 'classDiagram']) expect(flow(h).nodes).toEqual([]);
  });
  it('ignores garbage lines', () => {
    expect(flow('erDiagram\n  this is not valid\n  A ||--o{ B : ok').edges).toHaveLength(1);
  });
});
