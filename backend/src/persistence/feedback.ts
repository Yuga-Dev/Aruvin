/**
 * ============================================================================
 * FILE: feedback.ts
 * LOCATION: backend/src/persistence/feedback.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Store one thumbs rating per assistant message in the metadata collection.
 *
 * ROLE IN PROJECT:
 *    Release 1 feedback. Never on the chat admission path; separate from
 *    messages (insert-only archive) so ratings can change without rewriting history.
 *
 * KEY COMPONENTS:
 *    - MongoFeedback.put: validate message, upsert or clear the caller's rating.
 *    - MongoFeedback.ratings: one bounded $in read for a page of message ids.
 *    - MongoFeedback.removeSession: delete a chat's ratings (soft delete).
 *    - FEEDBACK_INDEXES entries live in indexes.ts.
 * ============================================================================
 */

import { z } from 'zod';
import type { FeedbackRating, FeedbackResponse } from '../contracts/api.js';
import { feedbackRatingSchema } from '../contracts/api.js';
import type { BudgetConfig } from '../contracts/budgets.js';
import { idSchema, isoDateSchema } from '../contracts/identifiers.js';
import type { MessageRepository } from '../contracts/repositories.js';
import { AppError } from '../platform/errors/app-error.js';
import { bounded, key } from './records.js';
import type { RecordStore } from './store.js';

export const feedbackRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('message-feedback'),
  userId: idSchema,
  sessionId: idSchema,
  messageId: idSchema,
  turnId: idSchema,
  attemptId: idSchema.nullable(),
  rating: feedbackRatingSchema,
  updatedAt: isoDateSchema,
}).strict();

const failed = () => new AppError('PERSISTENCE_ERROR', 'Your feedback could not be saved.');

export class MongoFeedback {
  constructor(
    readonly store: RecordStore,
    readonly messages: Pick<MessageRepository, 'get'>,
    readonly budgets: BudgetConfig,
    readonly clock: () => number = Date.now,
  ) {}

  async put(userId: string, sessionId: string, messageId: string, rating: FeedbackRating | null): Promise<FeedbackResponse> {
    const message = await this.messages.get(userId, sessionId, messageId);
    if (!message || message.visibility === 'internal') throw new AppError('NOT_FOUND', 'Message not found.', false);
    if (message.role !== 'assistant' || !(message.completionStatus === 'completed' || message.completionStatus === 'truncated'))
      throw new AppError('INVALID_REQUEST', 'Feedback is not available for this message.', false);
    const id = key('feedback', userId, sessionId, messageId);
    const scope = { _id: id, userId, sessionId, kind: 'message-feedback' as const };
    const col = this.store.collection('metadata');
    try {
      if (rating === null) {
        if (!(await col.deleteOne(scope, this.store.options())).acknowledged) throw failed();
      } else {
        const { record } = bounded(feedbackRecordSchema, {
          schemaVersion: 1, kind: 'message-feedback', userId, sessionId, messageId,
          turnId: message.turnId, attemptId: message.attemptId, rating,
          updatedAt: new Date(this.clock()).toISOString(),
        }, id, this.budgets.maxDocumentBytes);
        const r = await col.updateOne(scope, { $set: record, $setOnInsert: { _revision: 0 } },
          { ...this.store.options(), upsert: true });
        if (!r.acknowledged) throw failed();
      }
    } catch (e) {
      throw e instanceof AppError ? e : failed();
    }
    return { messageId, rating };
  }

  /** Caller's ratings for at most one page of message ids. */
  async ratings(userId: string, sessionId: string, messageIds: string[]): Promise<Map<string, FeedbackRating>> {
    if (!messageIds.length) return new Map();
    const ids = messageIds.slice(0, this.budgets.maxPageSize);
    const docs = await this.store.collection('metadata').find(
      { userId, sessionId, kind: 'message-feedback', messageId: { $in: ids } }, this.store.options(),
    ).limit(ids.length).toArray();
    return new Map(docs.map(d => [d.messageId as string, d.rating as FeedbackRating]));
  }

  async removeSession(userId: string, sessionId: string): Promise<void> {
    await this.store.collection('metadata')
      .deleteMany({ userId, sessionId, kind: 'message-feedback' }, this.store.options());
  }
}
