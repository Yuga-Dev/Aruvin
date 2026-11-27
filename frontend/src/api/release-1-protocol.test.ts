/**
 * ============================================================================
 * FILE: release-1-protocol.test.ts
 * LOCATION: frontend/src/api/release-1-protocol.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Check the Release 1 protocol mirrors, inert client stubs and disabled flags.
 *
 * ROLE IN PROJECT:
 *    Keeps unit 0 contracts aligned with the backend until units A, B and C land.
 *
 * KEY COMPONENTS:
 *    - Guards, routes, client stubs and feature flags.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest'
import { ApiClient } from './client.ts'
import {
  API_ROUTES,
  isEditTurnRequest,
  isFeedbackResponse,
  isSearchSessionsResponse,
  isVisibleMessage,
} from './protocol.ts'
import { FEATURE_FLAGS } from '../app/feature-flags.ts'

const msg = {
  messageId: 'm1', turnId: 't1', eventId: 'e1', sequence: 1, role: 'assistant', content: 'x',
  createdAt: '2026-01-01T00:00:00.000Z', completionStatus: 'completed', truncated: false,
}

describe('release 1 protocol mirrors', () => {
  it('mirrors routes and validates new guards', () => {
    expect(API_ROUTES.searchSessions).toBe('/sessions/search')
    expect(API_ROUTES.editTurn('s', 't')).toBe('/sessions/s/turns/t/edit')
    expect(API_ROUTES.regenerateTurn('s', 't')).toBe('/sessions/s/turns/t/regenerate')
    expect(isEditTurnRequest({ content: 'hi', idempotencyKey: 'idem-key-1' })).toBe(true)
    expect(isEditTurnRequest({ content: '', idempotencyKey: 'idem-key-1' })).toBe(false)
    expect(isEditTurnRequest({ content: 'hi', idempotencyKey: 'idem-key-1', userId: 'u' })).toBe(false)
    expect(isFeedbackResponse({ messageId: 'm1', rating: null })).toBe(true)
    expect(isFeedbackResponse({ messageId: 'm1', rating: 'meh' })).toBe(false)
    expect(isSearchSessionsResponse({ items: [], nextCursor: null, degraded: true })).toBe(true)
    expect(isSearchSessionsResponse({ items: [{ sessionId: 's' }], nextCursor: null })).toBe(false)
  })

  it('accepts supersedes and feedback on assistant messages only', () => {
    expect(isVisibleMessage({ ...msg, supersedes: 'm0', feedback: 'up' })).toBe(true)
    expect(isVisibleMessage({ ...msg, feedback: 'maybe' })).toBe(false)
    expect(isVisibleMessage({ ...msg, role: 'user', feedback: 'up' })).toBe(false)
  })

  it('keeps client stubs inert and the four flags off', async () => {
    const client = new ApiClient({ fetch: () => { throw new Error("must not call network") } })
    await expect(client.searchSessions('hello')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    await expect(client.putFeedback('s', 'm', 'up')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    await expect(client.exportSession('s')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    expect([FEATURE_FLAGS.conversationSearch, FEATURE_FLAGS.messageEdit, FEATURE_FLAGS.feedback,
      FEATURE_FLAGS.exportMarkdown]).toEqual([false, false, false, false])
  })
})
