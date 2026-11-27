/**
 * ============================================================================
 * FILE: export-markdown.ts
 * LOCATION: backend/src/http/export-markdown.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Pure rendering of a saved chat to a Markdown document and a safe filename.
 *
 * ROLE IN PROJECT:
 *    Used by ExportHttpService (Release 1 unit C). No I/O, no model access, no
 *    private reasoning; unit-testable without a database.
 *
 * KEY COMPONENTS:
 *    - exportMarkdown: ordered "## You" / "## Aurvin" sections with size cap.
 *    - exportFilename: ASCII slug (max 60 chars) plus date.
 * ============================================================================
 */

import type { VisibleMessage } from '../contracts/api.js';

export const EXPORT_MAX_BYTES = 2_000_000;
const DONE = new Set(['completed', 'truncated']);

export function exportFilename(title: string, now: Date): string {
  const slug = title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '');
  return `${slug || 'chat'}-${now.toISOString().slice(0, 10)}.md`;
}

/** Close an unterminated code fence (with a fence at least as long as its opener) so later sections stay headings. */
function closeFences(text: string): string {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    const f = m[1]!;
    if (open === null) open = f;
    else if (f[0] === open[0] && f.length >= open.length && line.trim() === f) open = null;
  }
  return open === null ? text : `${text}\n${open}`;
}

const label = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '\\$&');

function sections(m: VisibleMessage, hidden: Set<string>): string[] {
  if (hidden.has(m.messageId)) return [];
  const who = (r: string) => (r === 'user' ? '## You' : '## Aurvin');
  const out: string[] = [];
  if (m.voiceTranscripts?.length) {
    for (const t of m.voiceTranscripts) {
      if (t.content.trim()) out.push(`${who(t.role)}\n\n${closeFences(t.content.trim())}`);
    }
    return out;
  }
  if (m.role === 'assistant' && !DONE.has(m.completionStatus)) return [];
  const parts: string[] = [];
  if (m.content.trim()) parts.push(closeFences(m.content.trim()));
  if (m.role === 'assistant') {
    if (m.truncated || m.completionStatus === 'truncated') parts.push('*(truncated)*');
    if (m.canvasArtifacts?.length) parts.push(m.canvasArtifacts.map(a => `- Canvas ${a.kind}: ${label(a.title)}`).join('\n'));
    if (m.task) parts.push(`- Task plan: ${label(m.task.plan.goal)}`);
    if (m.webSources?.length) parts.push('Sources:\n' + m.webSources.map(s => `- [${label(s.title)}](${s.url})`).join('\n'));
  }
  if (parts.length) out.push(`${who(m.role)}\n\n${parts.join('\n\n')}`);
  return out;
}

export function exportMarkdown(input: { title: string; messages: VisibleMessage[]; now: Date; olderOmitted?: boolean }): string {
  const hidden = new Set(input.messages.flatMap(m => (m.supersedes ? [m.supersedes] : [])));
  let doc = `# ${label(input.title)}\n\nExported ${input.now.toISOString().slice(0, 10)}\n`;
  if (input.olderOmitted) doc += '\n*Older messages are not included in this export.*\n';
  let bytes = Buffer.byteLength(doc, 'utf8');
  for (const m of input.messages) {
    for (const s of sections(m, hidden)) {
      const next = `\n${s}\n`;
      bytes += Buffer.byteLength(next, 'utf8');
      if (bytes > EXPORT_MAX_BYTES) return `${doc}\n*Export truncated: size limit reached.*\n`;
      doc += next;
    }
  }
  return doc;
}
