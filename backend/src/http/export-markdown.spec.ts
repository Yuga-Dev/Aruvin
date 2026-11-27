/**
 * ============================================================================
 * FILE: export-markdown.spec.ts
 * LOCATION: backend/src/http/export-markdown.spec.ts
 * ============================================================================
 * PURPOSE: Verify Markdown export rendering, filename safety and the export route service.
 * ROLE IN PROJECT: Deterministic checks for Release 1 unit C export.
 * KEY COMPONENTS: Ordering, superseded/failed omission, fences, size cap, filename, temp refusal.
 * ============================================================================
 */
import { describe, expect, it, vi } from 'vitest';
import type { VisibleMessage } from '../contracts/api.js';
import { fixtureOptions } from '../../test/http/fixtures.js';
import { ExportHttpService } from './export-http.service.js';
import { EXPORT_MAX_BYTES, exportFilename, exportMarkdown } from './export-markdown.js';
import { session } from '../../test/persistence/fixtures.js';

const now = new Date('2026-11-27T10:00:00.000Z');
let n = 0;
const msg = (role: 'user' | 'assistant', content: string, extra: Partial<VisibleMessage> = {}): VisibleMessage => ({
  messageId: `m${++n}`, turnId: 't1', eventId: `e${n}`, sequence: n, role, content, createdAt: now.toISOString(),
  completionStatus: role === 'user' ? 'accepted' : 'completed', truncated: false, ...extra });

describe('exportMarkdown', () => {
  it('exports visible messages in order with superseded versions omitted', () => {
    const old = msg('assistant', 'Old answer');
    const out = exportMarkdown({ title: 'Trip', now, messages: [
      msg('user', 'Plan a trip'), old, msg('assistant', 'New answer', { supersedes: old.messageId }) ] });
    expect(out).toBe('# Trip\n\nExported 2026-11-27\n\n## You\n\nPlan a trip\n\n## Aurvin\n\nNew answer\n');
  });
  it('marks truncated answers and omits failed partials', () => {
    const out = exportMarkdown({ title: 'T', now, messages: [
      msg('assistant', 'Cut off', { completionStatus: 'truncated', truncated: true }),
      msg('assistant', 'partial', { completionStatus: 'failed' }),
      msg('assistant', 'stopped', { completionStatus: 'cancelled' }) ] });
    expect(out).toContain('Cut off\n\n*(truncated)*');
    expect(out).not.toContain('partial');
    expect(out).not.toContain('stopped');
  });
  it('keeps code fences intact with a longer outer fence', () => {
    const body = '````md\n```js\nx\n```\n````\n\n````md\nunterminated';
    const out = exportMarkdown({ title: 'T', now, messages: [msg('assistant', body), msg('user', 'next')] });
    expect(out).toContain('```js\nx\n```\n````\n\n````md\nunterminated\n````\n\n## You');
  });
  it('caps size and appends a truncation note', () => {
    const big = 'x'.repeat(300_000);
    const out = exportMarkdown({ title: 'T', now, messages: Array.from({ length: 10 }, () => msg('user', big)) });
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(EXPORT_MAX_BYTES + 200);
    expect(out.endsWith('*Export truncated: size limit reached.*\n')).toBe(true);
  });
  it('references canvas, sources and tasks without bodies', () => {
    const out = exportMarkdown({ title: 'T', now, messages: [msg('assistant', 'See', {
      canvasArtifacts: [{ responseId: 'r', ordinal: 0, kind: 'chart', subType: 'bar', title: 'Sales', rawSource: 'SECRET-BODY' }],
      webSources: [{ sourceId: 's', toolCallId: 'c', provider: 'x', kind: 'browse', title: 'A [site]', url: 'https://e.com/a',
        retrievedAt: now.toISOString() }] as never }) ] });
    expect(out).toContain('- Canvas chart: Sales');
    expect(out).toContain('- [A \\[site\\]](https://e.com/a)');
    expect(out).not.toContain('SECRET-BODY');
  });
  it('sanitises the download filename', () => {
    expect(exportFilename('../Ünï "x"\r\nSet-Cookie: a/b', now)).toMatch(/^[a-z0-9-]{1,60}-2026-11-27\.md$/);
    expect(exportFilename('日本語', now)).toBe('chat-2026-11-27.md');
    expect(exportFilename('a'.repeat(200), now).length).toBeLessThanOrEqual(60 + 14);
  });
});

describe('ExportHttpService', () => {
  it('refuses temporary chats', async () => {
    const o = fixtureOptions();
    o.sessions.get = vi.fn(async () => ({ ...session('server-user', 's1'), ephemeral: true }));
    await expect(new ExportHttpService(o).export('s1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(o.messages.list).not.toHaveBeenCalled();
  });
  it('pages the archive and returns a slug filename', async () => {
    const o = fixtureOptions();
    o.messages.list = vi.fn(async () => ({ items: [msg('user', 'hi')], nextCursor: null, olderAvailable: false })) as never;
    const r = await new ExportHttpService(o).export('s1');
    expect(r.markdown).toContain('## You\n\nhi');
    expect(r.filename).toMatch(/^hello-\d{4}-\d{2}-\d{2}\.md$/);
  });
});
