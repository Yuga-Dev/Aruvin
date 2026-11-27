/**
 * ============================================================================
 * FILE: message.ts
 * LOCATION: backend/src/contracts/message.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define the bounded durable record for each visible chat message.
 *
 * ROLE IN PROJECT:
 *    Keeps the UI transcript as individually addressable records with stable
 *    turn/event identity and ordered sequence, excluding private reasoning.
 *
 * KEY COMPONENTS:
 *    - Message status/role schemas: Shared visible transcript classifications.
 *    - messageRecordSchema: Strict schema for one durable message record.
 * ============================================================================
 */

import { z } from 'zod';
import { sourceReferenceSchema, sourceReferenceV2Schema } from './calendar-sources.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { idSchema, isoDateSchema, sequenceSchema } from './identifiers.js';
import { schemaVersionSchema } from './versions.js';
import { canvasArtifactsSchema } from './canvas-artifact.js';
import { calendarViewSchema } from './calendar-view.js';
import { weatherViewSchema } from './weather-view.js';
import { taskSnapshotSchema } from './task.js';
import { isCanvasArtifactId } from './voice-wire.js';
import { webSourcesSchema, webActivitiesSchema } from './web-search-wire.js';

export const MESSAGE_ROLES = ['user', 'assistant'] as const;
export const messageRoleSchema = z.enum(MESSAGE_ROLES);

export const voiceTranscriptItemSchema = z
  .object({
    role: messageRoleSchema,
    content: z.string(),
    createdAt: isoDateSchema.optional(),
  })
  .strict();
export type VoiceTranscriptItem = z.infer<typeof voiceTranscriptItemSchema>;

export const MESSAGE_COMPLETION_STATUSES = [
  'accepted',
  'streaming',
  'completed',
  'truncated',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export const messageCompletionStatusSchema = z.enum(
  MESSAGE_COMPLETION_STATUSES,
);

export const messageRecordObjectSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    userId: idSchema,
    sessionId: idSchema,
    turnId: idSchema,
    messageId: idSchema,
    eventId: idSchema,
    sequence: sequenceSchema,
    role: messageRoleSchema,
    content: z.string().max(DEFAULT_BUDGETS.maxInputChars),
    createdAt: isoDateSchema,
    completionStatus: messageCompletionStatusSchema,
    attemptId: idSchema.nullable(),
    truncated: z.boolean(),
    visibility: z.enum(['visible', 'internal']).optional(),
    mode: z.enum(['text', 'live']).optional(),
    voiceSessionId: idSchema.optional(),
    voiceDurationSeconds: z.number().int().nonnegative().optional(),
    // Older Calendar redaction wrote undefined, which MongoDB stored as null.
    voiceTranscripts: z.array(voiceTranscriptItemSchema).nullable().transform(items => items ?? []).optional(),
    sourceProvenance: z.array(z.union([sourceReferenceSchema, sourceReferenceV2Schema])).min(1).max(6).optional(),
    canvasArtifacts: canvasArtifactsSchema.optional(),
    calendarView: calendarViewSchema.optional(),
    weatherView: weatherViewSchema.optional(),
    webSources: webSourcesSchema.optional(),
    webActivities: webActivitiesSchema.optional(),
    memoryUpdated: z.boolean().optional(),
    /** Task-mode plan and final step states (docs/task-mode-and-flows/spec.md A4). */
    task: taskSnapshotSchema.optional(),
    /** Release 1: id of the older message this one replaces (edit or regenerate); the older record is never modified. */
    supersedes: idSchema.optional(),
  })
  .strict();

export const messageRecordSchema = messageRecordObjectSchema.superRefine((v, ctx) => {
  if (v.supersedes !== undefined && v.supersedes === v.messageId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['supersedes'], message: 'a message cannot supersede itself' });
  }
  if ((v.webSources !== undefined || v.webActivities !== undefined) && v.role !== 'assistant') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['role'],
      message: 'web provenance requires assistant role' });
  }
  if (v.calendarView !== undefined && v.role !== 'assistant') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['role'], message: 'calendar views require assistant role' });
  }
  if (v.weatherView !== undefined && v.role !== 'assistant') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['role'], message: 'weather views require assistant role' });
  }
  if (v.task !== undefined && v.role !== 'assistant') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['role'], message: 'task snapshots require assistant role' });
  }
  if (v.canvasArtifacts !== undefined) {
    if (v.role !== 'assistant') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['role'], message: 'canvas artifacts require assistant role' });
    }
    if (v.visibility !== 'internal') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visibility'], message: 'canvas artifacts require internal visibility' });
    }
    if (v.mode !== 'live') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mode'], message: 'canvas artifacts require live mode' });
    }
    if (v.attemptId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attemptId'], message: 'canvas artifacts require non-null attemptId' });
    }
    if (!v.voiceSessionId || !isCanvasArtifactId(v.voiceSessionId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['voiceSessionId'], message: 'canvas artifacts require valid voiceSessionId' });
    }
  }
  if (v.memoryUpdated !== undefined && v.role !== 'assistant') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['memoryUpdated'],
      message: 'memory updates require assistant role' });
  }
});

export type MessageRecord = z.infer<typeof messageRecordSchema>;
export type MessageRole = z.infer<typeof messageRoleSchema>;
export type MessageCompletionStatus = z.infer<
  typeof messageCompletionStatusSchema
>;

/**
 * Cross-record rule a single record cannot check: an assistant message supersedes an
 * assistant message of the same turn (regenerate), a user message a user message
 * (edit, always a different turn), never itself. Revision code calls this before writing.
 */
export function isValidSupersession(
  next: Pick<MessageRecord, 'messageId' | 'role' | 'turnId'>,
  target: Pick<MessageRecord, 'messageId' | 'role' | 'turnId'>,
): boolean {
  if (next.messageId === target.messageId || next.role !== target.role) return false;
  return next.role === 'assistant' ? next.turnId === target.turnId : next.turnId !== target.turnId;
}
