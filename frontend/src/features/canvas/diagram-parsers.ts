/**
 * ============================================================================
 * FILE: diagram-parsers.ts
 * LOCATION: frontend/src/features/canvas/diagram-parsers.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Parse Mermaid mindmap, erDiagram and classDiagram into the flowchart model.
 *
 * ROLE IN PROJECT:
 *    Lets the existing flowchart layout/renderer draw three more diagram types
 *    without a new dependency. Output is bounded; labels are plain text.
 *
 * KEY COMPONENTS:
 *    - parseMindmap / parseErDiagram / parseClassDiagram: source body -> MermaidFlowModel.
 *    - DIAGRAM_LIMITS: node/edge/line caps.
 * ============================================================================
 */

import type { MermaidEdge, MermaidEdgeStyle, MermaidFlowDirection, MermaidFlowModel, MermaidNode } from './canvas-types.ts';

export const DIAGRAM_LIMITS = { maxNodes: 60, maxEdges: 120, maxLine: 200 } as const;

const clean = (s: string) => s.trim().replace(/^["']|["']$/g, '');
const bodyLines = (body: string) =>
  body.split('\n').slice(1).map((l) => l.replace(/\s+$/, '').slice(0, DIAGRAM_LIMITS.maxLine)).filter((l) => l.trim());

function model(title: string | undefined, direction: MermaidFlowDirection, nodes: Map<string, MermaidNode>, edges: MermaidEdge[]): MermaidFlowModel {
  return {
    kind: 'flowchart', title, direction,
    nodes: [...nodes.values()].slice(0, DIAGRAM_LIMITS.maxNodes),
    edges: edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)).slice(0, DIAGRAM_LIMITS.maxEdges),
    subgraphs: [],
  };
}

const MINDMAP_SHAPED = /^[\w-]*\s*(?:\(\(|\)\)|\{\{|\[|\(|\)|\{)\s*(.+?)\s*(?:\)\)|\}\}|\]|\)|\(|\})$/;

export function parseMindmap(body: string, title?: string): MermaidFlowModel {
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  const stack: Array<{ indent: number; id: string }> = [];
  for (const raw of bodyLines(body)) {
    const text = raw.trim();
    if (text.startsWith('::') || text.startsWith(':::')) continue; // icon/class decorations
    const indent = raw.length - raw.trimStart().length + (raw.match(/^\t*/)?.[0].length ?? 0) * 3;
    const label = clean(MINDMAP_SHAPED.exec(text)?.[1] ?? text);
    if (!label || nodes.size >= DIAGRAM_LIMITS.maxNodes) continue;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const id = `m${nodes.size}`;
    nodes.set(id, { id, label, shape: stack.length ? 'rounded' : 'stadium' });
    const parent = stack[stack.length - 1];
    if (parent) edges.push({ from: parent.id, to: id, style: 'solid' });
    stack.push({ indent, id });
  }
  return model(title, 'LR', nodes, edges);
}

const ER_REL = /^("?[\w-]+"?)\s+([|}{o]{1,2}(--|\.\.)[|}{o]{1,2})\s+("?[\w-]+"?)\s*(?::\s*(.+))?$/;
const ER_NAME = /^"?([\w-]+)"?\s*\{$/;

export function parseErDiagram(body: string, title?: string): MermaidFlowModel {
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  const attrs = new Map<string, string[]>();
  const ensure = (name: string) => { if (!nodes.has(name) && nodes.size < DIAGRAM_LIMITS.maxNodes) nodes.set(name, { id: name, label: name, shape: 'rect' }); };
  let open: string | null = null;
  for (const raw of bodyLines(body)) {
    const line = raw.trim();
    if (open) {
      if (line === '}') open = null;
      else attrs.get(open)?.push(line.replace(/\s+/g, ' '));
      continue;
    }
    const block = ER_NAME.exec(line);
    if (block) { open = block[1]!; ensure(open); attrs.set(open, []); continue; }
    const rel = ER_REL.exec(line);
    if (rel) {
      const from = clean(rel[1]!), to = clean(rel[4]!);
      ensure(from); ensure(to);
      edges.push({ from, to, label: rel[5] ? clean(rel[5]) : undefined, style: (rel[3] === '..' ? 'dashed' : 'solid') as MermaidEdgeStyle });
    }
  }
  for (const [name, list] of attrs) {
    const n = nodes.get(name);
    if (n && list.length) n.label = [name, ...list.slice(0, 2), ...(list.length > 2 ? ['…'] : [])].join('\n');
  }
  return model(title, 'LR', nodes, edges);
}

const CLASS_REL = /^([\w.-]+)\s+(?:"[^"]*"\s+)?(<\|--|\*--|o--|-->|<--|\.\.>|<\.\.|\.\.\|>|<\|\.\.|--|\.\.)\s+(?:"[^"]*"\s+)?([\w.-]+)\s*(?::\s*(.+))?$/;
const CLASS_BLOCK = /^class\s+([\w.-]+)\s*(?:~[^~]*~)?\s*(\{)?$/;
const CLASS_MEMBER = /^([\w.-]+)\s*:\s*(.+)$/;

export function parseClassDiagram(body: string, title?: string): MermaidFlowModel {
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  const members = new Map<string, string[]>();
  const ensure = (name: string) => {
    if (!nodes.has(name) && nodes.size < DIAGRAM_LIMITS.maxNodes) { nodes.set(name, { id: name, label: name, shape: 'rect' }); members.set(name, []); }
  };
  let open: string | null = null;
  for (const raw of bodyLines(body)) {
    const line = raw.trim();
    if (line === 'direction' || /^direction\s/i.test(line) || line.startsWith('note')) continue;
    if (open) {
      if (line === '}') open = null;
      else members.get(open)?.push(line);
      continue;
    }
    const block = CLASS_BLOCK.exec(line);
    if (block) { ensure(block[1]!); if (block[2]) open = block[1]!; continue; }
    const rel = CLASS_REL.exec(line);
    if (rel) {
      const [, a, op, b, label] = rel as unknown as [string, string, string, string, string?];
      ensure(a); ensure(b);
      const reversed = op.startsWith('<'); // "Animal <|-- Dog": the child points at its parent
      edges.push({ from: reversed ? b : a, to: reversed ? a : b, label: label ? clean(label) : undefined, style: op.includes('..') ? 'dashed' : 'solid' });
      continue;
    }
    const member = CLASS_MEMBER.exec(line);
    if (member && nodes.has(member[1]!)) members.get(member[1]!)?.push(member[2]!.trim());
  }
  for (const [name, list] of members) {
    const n = nodes.get(name);
    if (n && list.length) n.label = [name, ...list.slice(0, 2), ...(list.length > 2 ? ['…'] : [])].join('\n');
  }
  return model(title, 'TD', nodes, edges);
}
