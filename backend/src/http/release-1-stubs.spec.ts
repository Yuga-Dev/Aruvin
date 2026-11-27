/**
 * ============================================================================
 * FILE: release-1-stubs.spec.ts
 * LOCATION: backend/src/http/release-1-stubs.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove the Release 1 unit 0 route stubs validate input and fail closed.
 *
 * ROLE IN PROJECT:
 *    Guards against silent success from stub services until units A, B and C land.
 *
 * KEY COMPONENTS:
 *    - Stub services: search, revision, feedback and export refuse; overrides rejected.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { SearchHttpService } from './search-http.service.js';
import { RevisionHttpService } from './revision-http.service.js';
import { FeedbackHttpService } from './feedback-http.service.js';
import { NOOP_FEATURE_PORTS } from './noop-ports.js';
import type { ChatHttpOptions } from './options.js';

const identity = {
  resolve: () => ({ userId: 'user_1' }),
  assertNoClientOverrides: (b: unknown) => {
    if (b && typeof b === 'object' && 'userId' in b) throw new Error('override');
  },
};
const base = { identity } as unknown as ChatHttpOptions;
const wired = { ...base, ...NOOP_FEATURE_PORTS } as ChatHttpOptions;

describe('release 1 stubs', () => {
  it('search validates the query and refuses with SEARCH_UNAVAILABLE', async () => {
    await expect(new SearchHttpService(wired).search({ q: 'x' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(new SearchHttpService(wired).search({ q: 'hello' })).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
    await expect(new SearchHttpService(base).search({ q: 'hello' })).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
  });
  it('edit and regenerate validate the body, then fail closed without a runtime revise', async () => {
    const s = new RevisionHttpService(base);
    await expect(s.edit('s', 't', { content: '' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(s.edit('s', 't', { content: 'hi', idempotencyKey: 'idem-key-1' })).rejects.toMatchObject({ code: 'NOT_READY' });
    await expect(s.regenerate('s', 't', { idempotencyKey: 'idem-key-1', userId: 'x' })).rejects.toThrow();
    await expect(s.regenerate('s', 't', { idempotencyKey: 'idem-key-1' })).rejects.toMatchObject({ code: 'NOT_READY' });
  });
  it('edit and regenerate hand a server-identity command to runtime.reviseTurn', async () => {
    const reply = { sessionId: 's', turnId: 't2', attemptId: 'a2', userMessageId: 'u2', streamPath: '/api/sessions/s/turns/t2/stream', status: 'accepted' };
    const reviseTurn = vi.fn(async () => reply);
    const o = { ...base, runtime: { reviseTurn, memorySession: () => ({ userId: 'user_1', sessionId: 's', lifecycle: 'active' }) } } as unknown as ChatHttpOptions;
    const s = new RevisionHttpService(o);
    await s.edit('s', 't', { content: 'hi', idempotencyKey: 'idem-key-1' }).catch(() => undefined);
    await s.regenerate('s', 't', { idempotencyKey: 'idem-key-2' }).catch(() => undefined);
    expect(reviseTurn.mock.calls.map(([c]) => [c.kind, c.turnId, c.identity.userId])).toEqual([['edit', 't', 'user_1'], ['regenerate', 't', 'user_1']]);
  });
  it('feedback refuses instead of succeeding', async () => {
    const f = new FeedbackHttpService(wired);
    await expect(f.put('s', 'm', { rating: 'sideways' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.put('s', 'm', { rating: 'up' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
