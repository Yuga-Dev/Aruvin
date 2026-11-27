/**
 * ============================================================================
 * FILE: search.ts
 * LOCATION: backend/src/persistence/search.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Bounded per-user conversation search: title scan plus message text index.
 *
 * ROLE IN PROJECT:
 *    Read-only repository behind GET /sessions/search (Release 1 unit A). It is
 *    off the chat path, so it never delays model dispatch. Newest messages are
 *    searchable only after their consolidated save (memory-first, decision D4).
 *
 * KEY COMPONENTS:
 *    - MongoSearch.search: Title page first, then ranked message-text matches.
 *    - escapeRegex / snippetOf: Query escaping and plain-text snippet building.
 *    - Degraded mode: title-only when the text index is missing or unadmitted.
 * ============================================================================
 */

import { z } from 'zod';
import {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  type SearchResult,
  type SearchSessionsQuery,
  type SearchSessionsResponse,
} from '../contracts/api.js';
import { idSchema } from '../contracts/identifiers.js';
import { AppError } from '../platform/errors/app-error.js';
import type { RecordStore } from './store.js';

export const SEARCH_MAX_TIME_MS = 3000;
export const SEARCH_CANDIDATES = 100;
/** Offset ceiling for message-text pages (ranked, not keyset). */
const MAX_SKIP = 500;

const cursorSchema = z
  .object({
    v: z.literal(1),
    userId: idSchema,
    q: z.string().max(100),
    phase: z.enum(['title', 'message']),
    value: z.string().max(64).optional(),
    id: idSchema.optional(),
    skip: z.number().int().min(0).max(MAX_SKIP).optional(),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Plain-text window (<= 300 chars) around the first query word found in content. */
export function snippetOf(content: string, q: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const words = q.toLowerCase().split(/[\s"]+/).filter(w => w.length > 0 && !w.startsWith('-'));
  const hits = words.map(w => lower.indexOf(w)).filter(i => i >= 0);
  const start = hits.length ? Math.max(0, Math.min(...hits) - 60) : 0;
  const body = flat.slice(start, start + 240);
  return `${start > 0 ? '…' : ''}${body}${start + 240 < flat.length ? '…' : ''}`;
}

function isMissingTextIndex(error: unknown): boolean {
  const e = error as { code?: unknown; codeName?: unknown; message?: unknown };
  return e?.code === 27 || e?.codeName === 'IndexNotFound'
    || (typeof e?.message === 'string' && /text index required/i.test(e.message));
}

export class MongoSearch {
  /**
   * `text` is false for any profile where text indexes are not verified (Azure/Cosmos,
   * decision D3); those answer with titles only and `degraded: true`.
   */
  constructor(private readonly store: RecordStore, private readonly opts: { text: boolean } = { text: true }) {}

  private decode(raw: string | undefined, userId: string, q: string): Cursor | null {
    if (!raw) return null;
    try {
      const c = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
      if (c.userId !== userId || c.q !== q) throw new Error('scope');
      return c;
    } catch {
      throw new AppError('INVALID_REQUEST', 'Invalid page cursor.');
    }
  }

  private encode(c: Omit<Cursor, 'v'>): string {
    return Buffer.from(JSON.stringify({ v: 1, ...c })).toString('base64url');
  }

  async search(userId: string, query: SearchSessionsQuery): Promise<SearchSessionsResponse> {
    idSchema.parse(userId);
    const q = query.q.trim();
    const limit = Math.min(query.limit ? Number(query.limit) : SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
    const after = this.decode(query.cursor, userId, q);
    const items: SearchResult[] = [];
    try {
      if (!after || after.phase === 'title') {
        const found = await this.titles(userId, q, limit, after);
        items.push(...found.items);
        if (found.more) return { items, nextCursor: found.more };
      }
      if (!this.opts.text) return { items, nextCursor: null, degraded: true };
      const room = limit - items.length;
      const skip = after?.phase === 'message' ? after.skip ?? 0 : 0;
      if (room <= 0) return { items, nextCursor: this.encode({ userId, q, phase: 'message', skip: 0 }) };
      try {
        const text = await this.messages(userId, q, room, skip, new Set(items.map(i => i.sessionId)));
        items.push(...text.items);
        return { items, nextCursor: text.next ? this.encode({ userId, q, phase: 'message', skip: text.next }) : null };
      } catch (error) {
        if (isMissingTextIndex(error)) return { items, nextCursor: null, degraded: true };
        throw error;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SEARCH_UNAVAILABLE', 'Search is unavailable.');
    }
  }

  private async titles(userId: string, q: string, limit: number, after: Cursor | null) {
    const filter: Record<string, unknown> = {
      userId, lifecycle: 'active', latestTurnId: { $ne: null }, ephemeral: { $ne: true },
      title: { $regex: escapeRegex(q), $options: 'i' },
    };
    if (after?.value && after.id) {
      filter.$or = [{ lastActivityAt: { $lt: after.value } }, { lastActivityAt: after.value, sessionId: { $lt: after.id } }];
    }
    // ponytail: regex title scan is bounded by one user's sessions and 3 s; add a title text index if it grows.
    const docs = await this.store.collection('sessions')
      .find(filter, { ...this.store.options(), projection: { sessionId: 1, title: 1, lastActivityAt: 1 } })
      .sort({ lastActivityAt: -1, sessionId: -1 }).limit(limit + 1).toArray();
    const page = docs.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map<SearchResult>(d => ({ sessionId: d.sessionId, title: d.title, lastActivityAt: d.lastActivityAt, match: 'title' })),
      more: docs.length > limit && last
        ? this.encode({ userId, q, phase: 'title', value: last.lastActivityAt, id: last.sessionId }) : null,
    };
  }

  private async messages(userId: string, q: string, room: number, skip: number, exclude: Set<string>) {
    let cands = await this.store.collection('messages')
      .find({
        userId, $text: { $search: q }, visibility: { $ne: 'internal' },
        $or: [{ role: 'user' }, { role: 'assistant', completionStatus: { $in: ['completed', 'truncated'] } }],
      }, {
        maxTimeMS: SEARCH_MAX_TIME_MS,
        projection: { sessionId: 1, messageId: 1, content: 1, score: { $meta: 'textScore' } },
      })
      .sort({ score: { $meta: 'textScore' } }).skip(skip).limit(SEARCH_CANDIDATES).toArray();
    let more = cands.length === SEARCH_CANDIDATES;
    // Look up at most limit*3 distinct sessions per page; stop the window at the first one beyond that.
    const ids = new Set<string>();
    let cut = -1;
    for (const [i, c] of cands.entries()) {
      if (!ids.has(c.sessionId) && ids.size >= room * 3) { cut = i; break; }
      ids.add(c.sessionId);
    }
    if (cut >= 0) { cands = cands.slice(0, cut); more = true; }
    if (cands.length === 0) return { items: [] as SearchResult[], next: 0 };
    const sessions = await this.store.collection('sessions')
      .find({
        userId, sessionId: { $in: [...ids] }, lifecycle: 'active', latestTurnId: { $ne: null }, ephemeral: { $ne: true },
      }, { ...this.store.options(), projection: { sessionId: 1, title: 1, lastActivityAt: 1 } }).toArray();
    const bySession = new Map(sessions.map(s => [s.sessionId as string, s]));
    const items: SearchResult[] = [];
    const seen = new Set(exclude);
    let consumed = cands.length;
    for (const [i, c] of cands.entries()) {
      const s = bySession.get(c.sessionId);
      if (!s || seen.has(c.sessionId)) continue;
      seen.add(c.sessionId);
      items.push({ sessionId: s.sessionId, title: s.title, lastActivityAt: s.lastActivityAt, match: 'message',
        snippet: snippetOf(String(c.content ?? ''), q), messageId: c.messageId });
      if (items.length === room) { consumed = i + 1; if (consumed < cands.length) more = true; break; }
    }
    const next = skip + consumed;
    return { items, next: more && next <= MAX_SKIP ? next : 0 };
  }
}
