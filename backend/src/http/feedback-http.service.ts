/**
 * ============================================================================
 * FILE: feedback-http.service.ts
 * LOCATION: backend/src/http/feedback-http.service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate and delegate message feedback (thumbs only, no free text).
 *
 * ROLE IN PROJECT:
 *    Release 1 unit C. Server identity, per-user rate limit, MESSAGE_NOT_SAVED for
 *    messages still only in runtime memory. Never on the chat admission path.
 *
 * KEY COMPONENTS:
 *    - FeedbackHttpService.put: strict body parse, server identity, rate limit, port call.
 * ============================================================================
 */

import { feedbackRequestSchema, feedbackResponseSchema } from '../contracts/api.js';
import type { ChatHttpOptions } from './options.js';
import { AppError } from '../platform/errors/app-error.js';
import { parseBody } from './validation.js';

const LIMIT = 60;
const WINDOW_MS = 60_000;

export class FeedbackHttpService {
  // ponytail: per-process fixed window (single-process topology); move to shared state if multi-instance is admitted.
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly o: ChatHttpOptions, private readonly clock: () => number = Date.now) {}
  async put(sessionId: string, messageId: string, raw: unknown) {
    const body = parseBody(feedbackRequestSchema, raw, this.o.identity);
    if (!this.o.feedback) throw new AppError('NOT_FOUND', 'Not available.', false);
    const identity = this.o.identity.resolve();
    const now = this.clock();
    const w = this.windows.get(identity.userId);
    if (!w || now - w.start >= WINDOW_MS) this.windows.set(identity.userId, { start: now, count: 1 });
    else if (++w.count > LIMIT) throw new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.');
    try {
      return feedbackResponseSchema.parse(
        await this.o.feedback.put(identity.userId, sessionId, messageId, body.rating));
    } catch (e) {
      if (e instanceof AppError && e.code === 'NOT_FOUND' && this.o.runtime?.memoryMessages?.(identity.userId, sessionId,
        { cursor: null, limit: this.o.budgets.maxPageSize })?.items.some(m => m.messageId === messageId))
        throw new AppError('MESSAGE_NOT_SAVED', 'Message is still saving.');
      throw e;
    }
  }
}
