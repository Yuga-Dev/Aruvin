/**
 * ============================================================================
 * FILE: search.spec.ts
 * LOCATION: backend/src/persistence/search.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify conversation search scoping, escaping, paging, degradation and index setup.
 *
 * ROLE IN PROJECT:
 *    Deterministic fixture checks (small in-memory matcher); not native MongoDB evidence.
 *
 * KEY COMPONENTS:
 *    - fake store: minimal filter/sort/skip/limit evaluator incl. a word-based $text.
 *    - Cases mirror docs/release-1/plan.md section 8 (search.spec.ts, indexes).
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { searchSessionsQuerySchema } from '../contracts/api.js';
import { SearchHttpService } from '../http/search-http.service.js';
import type { ChatHttpOptions } from '../http/options.js';
import { SEARCH_INDEXES, setupIndexes } from './indexes.js';
import { MongoSearch, escapeRegex, snippetOf } from './search.js';
import type { RecordStore } from './store.js';

type Doc = Record<string, any>;

function matches(d: Doc, f: Doc): boolean {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$or') return (v as Doc[]).some(x => matches(d, x));
    if (k === '$text') {
      const words = String(v.$search).toLowerCase().split(/\s+/);
      return words.some(w => String(d.content).toLowerCase().includes(w));
    }
    const a = d[k];
    if (v && typeof v === 'object' && !(v instanceof RegExp)) {
      return Object.entries(v as Doc).every(([op, b]) => {
        if (op === '$ne') return b === null ? a !== null && a !== undefined : a !== b;
        if (op === '$in') return (b as unknown[]).includes(a);
        if (op === '$lt') return a !== undefined && a < b;
        if (op === '$regex') return new RegExp(b as string, (v as Doc).$options).test(String(a));
        return op === '$options';
      });
    }
    return a === v;
  });
}

function fixture(sessions: Doc[], messages: Doc[], failText?: unknown) {
  const calls: Array<{ collection: string; filter: Doc; opts: Doc }> = [];
  const store = {
    options: () => ({ maxTimeMS: 3000 }),
    collection: (name: string) => ({
      find(filter: Doc, opts: Doc = {}) {
        calls.push({ collection: name, filter, opts });
        let rows = (name === 'sessions' ? sessions : messages).filter(d => matches(d, filter));
        let skip = 0, limit = Infinity;
        const cur = {
          sort(spec: Doc) {
            const [[key, dir]] = Object.entries(spec);
            if (key === 'score') rows = [...rows].sort((a, b) => b.score - a.score);
            else rows = [...rows].sort((a, b) =>
              (b.lastActivityAt.localeCompare(a.lastActivityAt) || b.sessionId.localeCompare(a.sessionId)) * (dir === -1 ? 1 : -1));
            return cur;
          },
          skip(n: number) { skip = n; return cur; },
          limit(n: number) { limit = n; return cur; },
          async toArray() {
            if (failText && name === 'messages') throw failText;
            return rows.slice(skip, skip + limit);
          },
        };
        return cur;
      },
    }),
  } as unknown as RecordStore;
  return { search: new MongoSearch(store), calls };
}

const ses = (id: string, title: string, at: string, extra: Doc = {}) => ({
  userId: 'u1', sessionId: id, title, lastActivityAt: at, lifecycle: 'active', latestTurnId: 't1', ...extra,
});
const msg = (id: string, sessionId: string, content: string, extra: Doc = {}) => ({
  userId: 'u1', sessionId, messageId: id, content, role: 'user', completionStatus: 'accepted', score: 1, ...extra,
});
const q = (raw: Record<string, string>) => searchSessionsQuerySchema.parse(raw);

describe('conversation search', () => {
  it('searches titles case-insensitively with regex characters escaped', async () => {
    const f = fixture([ses('a', 'Plan (v1.0)+', '2026-01-02'), ses('b', 'Plan v1x0', '2026-01-01')], []);
    const r = await f.search.search('u1', q({ q: 'PLAN (v1.0)+' }));
    expect(r.items.filter(i => i.match === 'title').map(i => i.sessionId)).toEqual(['a']);
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
    expect(f.calls[0]!.filter.title).toEqual({ $regex: escapeRegex('PLAN (v1.0)+'), $options: 'i' });
  });

  it('title search includes an unsaved in-memory session', async () => {
    const found = { items: [], nextCursor: null };
    const live = { sessionId: 'live1', title: 'Roadmap draft', createdAt: 'x', lastActivityAt: '2026-02-01T00:00:00.000Z', pinned: false };
    const o = { identity: { resolve: () => ({ userId: 'u1' }) }, budgets: { maxPageSize: 50 },
      runtime: { overlaySessions: () => ({ items: [live, { ...live, sessionId: 'live2', title: 'Other' }], nextCursor: null }) },
      search: { search: async () => found } } as unknown as ChatHttpOptions;
    const r = await new SearchHttpService(o).search({ q: 'roadmap' });
    expect(r.items).toEqual([{ sessionId: 'live1', title: 'Roadmap draft', lastActivityAt: live.lastActivityAt, match: 'title' }]);
  });

  it('text search is scoped to the caller userId', async () => {
    const f = fixture([ses('a', 'x', '2026-01-01'), ses('o', 'x', '2026-01-01', { userId: 'u2' })],
      [msg('m1', 'a', 'budget notes'), msg('m2', 'o', 'budget notes', { userId: 'u2' })]);
    const r = await f.search.search('u1', q({ q: 'budget' }));
    expect(r.items.map(i => i.sessionId)).toEqual(['a']);
    expect(r.items[0]).toMatchObject({ match: 'message', messageId: 'm1', snippet: 'budget notes' });
    for (const c of f.calls) expect(c.filter.userId).toBe('u1');
    expect(f.calls.find(c => c.collection === 'messages')!.opts.maxTimeMS).toBe(3000);
  });

  it('text search never returns internal, ephemeral, deleted or non-active chats', async () => {
    const f = fixture([
      ses('ok', 'x', '2026-01-05'), ses('eph', 'x', '2026-01-04', { ephemeral: true }),
      ses('del', 'x', '2026-01-03', { lifecycle: 'deleted' }), ses('arch', 'x', '2026-01-02', { lifecycle: 'archived' }),
      ses('new', 'x', '2026-01-01', { latestTurnId: null }),
    ], ['ok', 'eph', 'del', 'arch', 'new'].map(s => msg(`m-${s}`, s, 'zebra'))
      .concat([msg('mi', 'ok', 'zebra', { visibility: 'internal' }), msg('mf', 'ok', 'zebra', { role: 'assistant', completionStatus: 'failed' })]));
    const r = await f.search.search('u1', q({ q: 'zebra' }));
    expect(r.items.map(i => i.sessionId)).toEqual(['ok']);
    expect(r.items[0]!.messageId).toBe('m-ok');
  });

  it('search pages with a keyset cursor and caps limit at 20', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ses(`s${i}`, 'alpha', `2026-01-0${i + 1}`));
    const f = fixture(rows, []);
    const one = await f.search.search('u1', q({ q: 'alpha', limit: '2' }));
    expect(one.items.map(i => i.sessionId)).toEqual(['s4', 's3']);
    const two = await f.search.search('u1', q({ q: 'alpha', limit: '2', cursor: one.nextCursor! }));
    expect(two.items.map(i => i.sessionId)).toEqual(['s2', 's1']);
    expect(f.calls.at(-1)!.filter.$or).toBeDefined();
    const last = await f.search.search('u1', q({ q: 'alpha', limit: '2', cursor: two.nextCursor! }));
    expect(last.items.map(i => i.sessionId)).toEqual(['s0']);
    expect(last.nextCursor).toBeNull();
    expect(searchSessionsQuerySchema.safeParse({ q: 'alpha', limit: '21' }).success).toBe(false);
    await expect(f.search.search('u2', q({ q: 'alpha', cursor: one.nextCursor! }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.search.search('u1', q({ q: 'beta', cursor: one.nextCursor! }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('search degrades to title-only when the text index is missing', async () => {
    const f = fixture([ses('a', 'budget', '2026-01-01')], [], Object.assign(new Error('text index required'), { code: 27 }));
    const r = await f.search.search('u1', q({ q: 'budget' }));
    expect(r).toMatchObject({ degraded: true, nextCursor: null });
    expect(r.items.map(i => i.match)).toEqual(['title']);
    const off = new MongoSearch(fixture([ses('a', 'budget', '2026-01-01')], []).search['store' as never], { text: false });
    expect((await off.search('u1', q({ q: 'budget' }))).degraded).toBe(true);
    const slow = fixture([], [], Object.assign(new Error('time limit'), { code: 50 }));
    await expect(slow.search.search('u1', q({ q: 'budget' }))).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
  });

  it('search query over 100 characters is rejected', async () => {
    expect(searchSessionsQuerySchema.safeParse({ q: 'a'.repeat(101) }).success).toBe(false);
    const s = new SearchHttpService({ identity: { resolve: () => ({ userId: 'u1' }) }, search: { search: async () => ({ items: [], nextCursor: null }) } } as unknown as ChatHttpOptions);
    await expect(s.search({ q: 'a'.repeat(101) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rate limits a user and builds plain-text snippets', async () => {
    let t = 0;
    const s = new SearchHttpService({ identity: { resolve: () => ({ userId: 'u1' }) }, runtime: {}, budgets: { maxPageSize: 50 },
      search: { search: async () => ({ items: [], nextCursor: null }) } } as unknown as ChatHttpOptions, () => t);
    for (let i = 0; i < 30; i++) await s.search({ q: 'hello' });
    await expect(s.search({ q: 'hello' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    t = 61_000;
    await expect(s.search({ q: 'hello' })).resolves.toBeDefined();
    const long = `${'x '.repeat(200)}needle <b>bold</b> ${'y '.repeat(200)}`;
    const snip = snippetOf(long, 'needle');
    expect(snip.length).toBeLessThanOrEqual(300);
    expect(snip).toContain('needle <b>bold</b>');
  });
});

describe('indexes', () => {
  it('creates the messages text index once and idempotently', async () => {
    const created: Array<{ collection: string; keys: unknown; options: Doc }> = [];
    const db = { collection: (collection: string) => ({ createIndex: async (keys: unknown, options: Doc) => { created.push({ collection, keys, options }); } }) } as unknown as Db;
    await setupIndexes(db);
    await setupIndexes(db);
    const text = created.filter(c => Object.values(c.keys as Doc).includes('text'));
    expect(SEARCH_INDEXES).toHaveLength(1);
    expect(text).toHaveLength(2);
    expect(new Set(text.map(c => JSON.stringify(c))).size).toBe(1);
    expect(text[0]).toMatchObject({ collection: 'messages', keys: { userId: 1, content: 'text' },
      options: { name: 'user_content_text', default_language: 'none' } });
  });
});
