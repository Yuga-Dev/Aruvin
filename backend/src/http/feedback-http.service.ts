/**
 * ============================================================================
 * FILE: feedback-http.service.ts
 * LOCATION: backend/src/http/feedback-http.service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate and delegate message feedback (Release 1 unit 0 stub).
 *
 * ROLE IN PROJECT:
 *    Unit C replaces the port behind this service; until then it fails closed.
 *
 * KEY COMPONENTS:
 *    - FeedbackHttpService.put: strict body parse, server identity, port call.
 * ============================================================================
 */

import { feedbackRequestSchema, feedbackResponseSchema } from '../contracts/api.js';
import type { ChatHttpOptions } from './options.js';
import { AppError } from '../platform/errors/app-error.js';
import { parseBody } from './validation.js';

export class FeedbackHttpService {
  constructor(private readonly o: ChatHttpOptions) {}
  async put(sessionId: string, messageId: string, raw: unknown) {
    const body = parseBody(feedbackRequestSchema, raw, this.o.identity);
    if (!this.o.feedback) throw new AppError('NOT_FOUND', 'Not available.', false);
    const identity = this.o.identity.resolve();
    return feedbackResponseSchema.parse(
      await this.o.feedback.put(identity.userId, sessionId, messageId, body.rating));
  }
}
