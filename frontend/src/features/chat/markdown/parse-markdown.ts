/**
 * ============================================================================
 * FILE: parse-markdown.ts
 * LOCATION: frontend/src/features/chat/markdown/parse-markdown.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Tokenize progressive Markdown, including unclosed streaming code fences,
 *    GFM tables, and nested lists.
 *
 * ROLE IN PROJECT:
 *    Zero-dependency parser used by SafeMarkdown so assistant text can render
 *    incrementally without waiting for a complete document or a HTML library.
 *
 * KEY COMPONENTS:
 *    - MarkdownToken: Heading, code, quote, list, table, and paragraph shapes.
 *    - parseMarkdown: Line-oriented tokenizer with streaming fence support.
 *    - parseLines: Recursive block parser; list item bodies re-enter it.
 * ============================================================================
 */

export type MarkdownToken =
  | { type: 'heading'; level: number; text: string }
  | { type: 'code_block'; lang: string; code: string }
  | { type: 'math_block'; expression: string }
  | { type: 'blockquote'; text: string }
  | { type: 'bullet_list'; items: MarkdownListItem[] }
  | { type: 'ordered_list'; items: MarkdownListItem[]; start?: number }
  | {
    type: 'table';
    align: Array<'left' | 'center' | 'right' | null>;
    header: string[];
    rows: string[][];
  }
  | { type: 'paragraph'; text: string };

// Item text plus nested blocks (sub-lists, continuation paragraphs, code).
export type MarkdownListItem = { text: string; children: MarkdownToken[] };

// ponytail: list nesting deeper than this renders as plain paragraphs, which
// bounds recursion and DOM depth; raise only if real replies need more.
export const MAX_LIST_DEPTH = 6;

const LIST_MARKER = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DELIMITER_CELL = /^:?-+:?$/;
const BLOCK_START = /^\s*(```|#{1,6}\s|>|\\\[|\$\$)/;

function expandTabs(line: string): string {
  return line.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, '    '));
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isOrderedMarker(marker: string | undefined): boolean {
  return /\d/.test(marker ?? '');
}

function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  const cells: string[] = [];
  let cell = '';
  let endedWithPipe = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    endedWithPipe = false;
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
      endedWithPipe = true;
    } else {
      cell += ch;
    }
  }
  if (!endedWithPipe) cells.push(cell.trim());
  return cells;
}

function tableAlign(cell: string): 'left' | 'center' | 'right' | null {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

// Returns alignments when `line` is a delimiter row for `columns` header cells.
// A still-streaming last line may be shorter than the header ("|---|-").
function parseDelimiterRow(line: string, columns: number, isLast: () => boolean) {
  if (!line.includes('|') || !line.includes('-') || !/^[\s|:-]+$/.test(line)) return null;
  const cells = splitTableRow(line);
  if (cells.length === columns && cells.every((c) => TABLE_DELIMITER_CELL.test(c))) {
    return cells.map(tableAlign);
  }
  if (!isLast()) return null;
  const partial = cells.filter((c) => c !== '' && c !== ':');
  if (partial.length === 0 || partial.length > columns
    || !partial.every((c) => TABLE_DELIMITER_CELL.test(c))) {
    return null;
  }
  return Array.from({ length: columns }, (_, idx) => {
    const cell = partial[idx];
    return cell ? tableAlign(cell) : null;
  });
}

// Collects the list starting at lines[start]; returns the token and the index
// after its last line. Lines indented deeper than the first marker belong to the
// current item; a same-type marker at or below that indent starts a sibling.
function parseList(lines: string[], start: number, depth: number): { token: MarkdownToken; end: number } {
  const first = LIST_MARKER.exec(expandTabs(lines[start] ?? ''))!;
  const base = (first[1] ?? '').length;
  const ordered = isOrderedMarker(first[2]);
  const items: MarkdownListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const head = LIST_MARKER.exec(expandTabs(lines[i] ?? ''));
    if (!head || (head[1] ?? '').length > base || isOrderedMarker(head[2]) !== ordered) break;
    const body: string[] = [];
    i += 1;
    while (i < lines.length) {
      const raw = expandTabs(lines[i] ?? '');
      if (raw.trim() === '') {
        // A blank line stays in the list only if the next content continues it.
        let k = i + 1;
        while (k < lines.length && (lines[k] ?? '').trim() === '') k += 1;
        const next = k < lines.length ? expandTabs(lines[k] ?? '') : null;
        const nextMarker = next === null ? null : LIST_MARKER.exec(next);
        const continues = next !== null && (
          indentOf(next) > base
          || (nextMarker !== null && isOrderedMarker(nextMarker[2]) === ordered)
        );
        if (!continues) break;
        body.push('');
        i += 1;
        continue;
      }
      if (indentOf(raw) <= base) break;
      body.push(raw);
      i += 1;
    }
    const indent = Math.min(...body.filter((l) => l.trim() !== '').map(indentOf));
    const dedented = body.map((l) => l.slice(Math.min(Number.isFinite(indent) ? indent : 0, indentOf(l))));
    let text = (head[3] ?? '').trim();
    // Plain lines directly after the marker line continue the item's paragraph.
    while (dedented.length > 0 && (dedented[0] ?? '').trim() !== ''
      && !LIST_MARKER.test(dedented[0] ?? '') && !BLOCK_START.test(dedented[0] ?? '')) {
      text += ` ${(dedented.shift() ?? '').trim()}`;
    }
    items.push({ text, children: parseLines(dedented, depth + 1) });
  }

  const startNumber = ordered ? Number.parseInt(first[2] ?? '1', 10) : 1;
  return {
    token: ordered
      ? { type: 'ordered_list', items, ...(startNumber !== 1 ? { start: startNumber } : {}) }
      : { type: 'bullet_list', items },
    end: i,
  };
}

export function parseMarkdown(
  markdown: string,
  // Reports offsets in CRLF-normalized text, before the unfinished tail.
  onStablePrefix?: (chars: number, tokenCount: number) => void,
): MarkdownToken[] {
  return parseLines(markdown.replace(/\r\n/g, '\n').split('\n'), 0, onStablePrefix);
}

function parseLines(
  lines: string[],
  depth: number,
  onStablePrefix?: (chars: number, tokenCount: number) => void,
): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockLines: string[] = [];
  let inMathBlock: '\\]' | '$$' | null = null;
  let mathBlockLines: string[] = [];
  let offset = 0;
  let stableChars = 0;
  let stableTokenCount = 0;
  // Lines up to this index cannot become the retained prefix: a trailing list or
  // table may still grow, and a pipe line may still gain its delimiter row.
  let holdThrough = -1;
  // The final line may be a half-typed marker/row, so it also keeps a block open.
  const mayGrow = (from: number) => from >= lines.length - 1 || lines.slice(from).every((l) => l.trim() === '');

  for (let i = 0; i < lines.length; i++) {
    // Only a complete line with no open multi-line construct can be retained.
    // The last (possibly partial) line is always reparsed on the next update.
    if (!inCodeBlock && !inMathBlock && i > holdThrough) {
      stableChars = offset;
      stableTokenCount = tokens.length;
    }
    const line = lines[i] ?? '';
    offset += line.length + 1;
    const trimmed = line.trim();

    if (inCodeBlock) {
      if (trimmed.startsWith('```')) {
        tokens.push({
          type: 'code_block',
          lang: codeBlockLang,
          code: codeBlockLines.join('\n'),
        });
        inCodeBlock = false;
        codeBlockLang = '';
        codeBlockLines = [];
      } else {
        codeBlockLines.push(line);
      }
      continue;
    }

    if (inMathBlock) {
      if (trimmed.endsWith(inMathBlock)) {
        const beforeClose = trimmed.slice(0, -inMathBlock.length).trim();
        if (beforeClose) {
          mathBlockLines.push(beforeClose);
        }
        tokens.push({
          type: 'math_block',
          expression: mathBlockLines.join('\n').trim(),
        });
        inMathBlock = null;
        mathBlockLines = [];
      } else if (trimmed !== '') {
        mathBlockLines.push(line);
      }
      continue;
    }

    if (trimmed.startsWith('```')) {
      inCodeBlock = true;
      codeBlockLang = trimmed.slice(3).trim();
      codeBlockLines = [];
      continue;
    }

    if (trimmed.startsWith('\\[')) {
      if (trimmed.endsWith('\\]') && trimmed.length >= 4) {
        tokens.push({
          type: 'math_block',
          expression: trimmed.slice(2, -2).trim(),
        });
      } else {
        inMathBlock = '\\]';
        const afterOpen = trimmed.slice(2).trim();
        mathBlockLines = afterOpen ? [afterOpen] : [];
      }
      continue;
    }

    if (trimmed.startsWith('$$')) {
      if (trimmed.endsWith('$$') && trimmed.length >= 4) {
        tokens.push({
          type: 'math_block',
          expression: trimmed.slice(2, -2).trim(),
        });
      } else {
        inMathBlock = '$$';
        const afterOpen = trimmed.slice(2).trim();
        mathBlockLines = afterOpen ? [afterOpen] : [];
      }
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch?.[1] && headingMatch[2] !== undefined) {
      tokens.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      continue;
    }

    if (trimmed.startsWith('>')) {
      tokens.push({
        type: 'blockquote',
        text: trimmed.replace(/^>\s?/, ''),
      });
      continue;
    }
    if (depth < MAX_LIST_DEPTH && LIST_MARKER.test(expandTabs(line))) {
      const list = parseList(lines, i, depth);
      for (let k = i + 1; k < list.end; k++) offset += (lines[k]?.length ?? 0) + 1;
      tokens.push(list.token);
      if (mayGrow(list.end)) holdThrough = Infinity;
      i = list.end - 1;
      continue;
    }

    // A table needs its delimiter row; until it streams in, the header is a paragraph.
    if (line.includes('|') && i + 1 < lines.length) {
      const header = splitTableRow(line);
      const align = parseDelimiterRow(lines[i + 1] ?? '', header.length, () => lines.slice(i + 2).every((l) => l.trim() === ''));
      if (align) {
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && (lines[j] ?? '').trim() !== '' && (lines[j] ?? '').includes('|')) {
          const cells = splitTableRow(lines[j] ?? '');
          rows.push(Array.from({ length: header.length }, (_, c) => cells[c] ?? ''));
          j += 1;
        }
        for (let k = i + 1; k < j; k++) offset += (lines[k]?.length ?? 0) + 1;
        tokens.push({ type: 'table', align, header, rows });
        if (mayGrow(j)) holdThrough = Infinity;
        i = j - 1;
        continue;
      }
    }

    if (trimmed === '') {
      continue;
    }

    tokens.push({ type: 'paragraph', text: trimmed });
    if (line.includes('|')) holdThrough = i + 1;
  }

  if (inCodeBlock) {
    tokens.push({
      type: 'code_block',
      lang: codeBlockLang,
      code: codeBlockLines.join('\n'),
    });
  }

  if (inMathBlock) {
    tokens.push({
      type: 'math_block',
      expression: mathBlockLines.join('\n').trim(),
    });
  }

  onStablePrefix?.(stableChars, stableTokenCount);
  return tokens;
}
