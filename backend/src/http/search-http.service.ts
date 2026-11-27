/**
 * ============================================================================
 * FILE: search-http.service.ts
 * LOCATION: backend/src/http/search-http.service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate, rate-limit and run conversation search, overlaying unsaved in-memory titles.
 *
 * ROLE IN PROJECT:
 *    Reads only (never on the chat path); fails closed with SEARCH_UNAVAILABLE when no port is wired.
 *
 * KEY COMPONENTS:
 *    - SearchHttpService.search: Strict query parse, server identity, per-user limit, port call, title overlay.
 * ============================================================================
 */

import { searchSessionsQuerySchema, searchSessionsResponseSchema, SEARCH_LIMIT_DEFAULT, type SearchResult } from '../contracts/api.js';
import type { ChatHttpOptions } from './options.js';
import { AppError } from '../platform/errors/app-error.js';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;

export class SearchHttpService {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly o: ChatHttpOptions, private readonly now: () => number = Date.now) {}
  /** ponytail: per-process sliding window; the admitted topology is single-process. */
  private limit(userId: string) {
    const t = this.now();
    const recent = (this.hits.get(userId) ?? []).filter(h => t - h < WINDOW_MS);
    if (recent.length >= MAX_PER_WINDOW) throw new AppError('RATE_LIMITED', 'Too many requests.');
    this.hits.set(userId, [...recent, t]);
  }
  async search(raw: unknown) {
    const parsed = searchSessionsQuerySchema.safeParse(raw);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid request.');
    if (!this.o.search) throw new AppError('SEARCH_UNAVAILABLE', 'Search is unavailable.');
    const { userId } = this.o.identity.resolve();
    this.limit(userId);
    const found = searchSessionsResponseSchema.parse(await this.o.search.search(userId, parsed.data));
    if (parsed.data.cursor) return found;
    // Memory-first: a just-created chat is not saved yet, so match its in-memory title on the first page.
    const needle = parsed.data.q.toLowerCase();
    const live = this.o.runtime.overlaySessions?.(userId, { cursor: null, limit: Math.min(this.o.budgets.maxPageSize, 50) },
      { items: [], nextCursor: null })?.items.filter(s => s.title.toLowerCase().includes(needle)) ?? [];
    if (live.length === 0) return found;
    const liveIds = new Set(live.map(s => s.sessionId));
    const limit = Number(parsed.data.limit ?? SEARCH_LIMIT_DEFAULT);
    const titles: SearchResult[] = [...live.map(s => ({ sessionId: s.sessionId, title: s.title,
      lastActivityAt: s.lastActivityAt, match: 'title' as const })), ...found.items.filter(i => i.match === 'title' && !liveIds.has(i.sessionId))]
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const rest = found.items.filter(i => i.match === 'message' && !liveIds.has(i.sessionId));
    return { ...found, items: [...titles, ...rest].slice(0, limit) };
  }
}
