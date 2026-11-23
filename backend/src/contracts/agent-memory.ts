/**
 * ============================================================================
 * FILE: agent-memory.ts
 * LOCATION: backend/src/contracts/agent-memory.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define bounded memory manifests that reference original message records.
 *
 * ROLE IN PROJECT:
 *    Separates selected agent context from the durable UI archive without
 *    copying transcript content into an ever-growing manifest document.
 *
 * KEY COMPONENTS:
 *    - Reference schemas: Bound message and source-range linkage.
 *    - agentMemoryManifestSchema: Versioned context selection manifest.
 * ============================================================================
 */

import { z } from 'zod';
import { DEFAULT_BUDGETS } from './budgets.js';
import { CALENDAR_TOMBSTONE } from './calendar-sources.js';
import { idSchema, isoDateSchema, sequenceSchema } from './identifiers.js';
import { schemaVersionSchema } from './versions.js';
import { pinnedUserMemorySchema } from './user-memory.js';

export const sourceRangeSchema = z
  .object({
    fromSequence: sequenceSchema.safe(),
    toSequence: sequenceSchema.safe(),
    fromEventId: idSchema,
    toEventId: idSchema,
  })
  .strict()
  .refine(range => range.fromSequence <= range.toSequence, {
    message: 'Source range must be ordered.',
  });

export const messageRefSchema = z
  .object({
    messageId: idSchema,
    eventId: idSchema,
    sequence: sequenceSchema,
  })
  .strict();

export const summaryRefSchema = z
  .object({
    summaryId: idSchema,
    sourceRange: sourceRangeSchema,
  })
  .strict();

export const activeSummaryRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  kind: z.literal('memory-summary'),
  userId: idSchema,
  sessionId: idSchema,
  summaryId: idSchema,
  compactionCycle: z.number().int().positive().safe(),
  sourceRange: sourceRangeSchema,
  content: z.string().min(1).max(DEFAULT_BUDGETS.maxMessageBytes)
    .refine(value => !/<\/?analysis\b/i.test(value), { message: 'Scratchpad is not memory.' }),
  calendarProvenance: z.object({
    containsCalendarContent: z.boolean(),
    connectionId: idSchema.nullable(),
    connectionRevision: z.number().int().positive().safe().nullable(),
    earliestExpiresAt: isoDateSchema.nullable(),
    redactedAt: isoDateSchema.nullable(),
  }).strict(),
  modelId: z.string().min(1).max(200),
  tokenEstimate: z.number().int().nonnegative().safe(),
  createdAt: isoDateSchema,
}).strict().superRefine((value, ctx) => {
  const p = value.calendarProvenance;
  const block = value.content.match(/<calendar_context>([\s\S]*?)<\/calendar_context>/);
  const tags = value.content.match(/<\/?calendar_context\b[^>]*>/gi) ?? [];
  const valid = p.containsCalendarContent
    ? block !== null && tags.length === 2 && p.connectionId !== null &&
      p.connectionRevision !== null && p.earliestExpiresAt !== null &&
      (p.redactedAt === null || block[1] === CALENDAR_TOMBSTONE)
    : tags.length === 0 && p.connectionId === null && p.connectionRevision === null &&
      p.earliestExpiresAt === null && p.redactedAt === null;
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom,
    path: ['calendarProvenance'], message: 'Calendar summary must be isolated and attributable.' });
});

export type ActiveSummaryRecord = z.infer<typeof activeSummaryRecordSchema>;
export type SummaryRef = z.infer<typeof summaryRefSchema>;

export const compactionCheckpointMetaSchema = z.object({
  compactedThroughSequence: sequenceSchema.safe(),
  compactionCycle: z.number().int().positive().safe(),
  summaryPreview: z.string().max(500)
    .refine(value => !/<\/?(?:analysis|calendar_context)\b/i.test(value)).optional(),
}).strict();
export type CompactionCheckpointMeta = z.infer<typeof compactionCheckpointMetaSchema>;

export function redactSummaryCalendar(
  record: ActiveSummaryRecord, redactedAt: string,
): ActiveSummaryRecord {
  if (!record.calendarProvenance.containsCalendarContent ||
      record.calendarProvenance.redactedAt !== null) return record;
  return {
    ...record,
    content: record.content.replace(/<calendar_context>[\s\S]*?<\/calendar_context>/,
      `<calendar_context>${CALENDAR_TOMBSTONE}</calendar_context>`),
    calendarProvenance: { ...record.calendarProvenance,
      redactedAt: isoDateSchema.parse(redactedAt) },
  };
}

export const agentMemoryManifestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    userId: idSchema,
    sessionId: idSchema,
    contextVersion: sequenceSchema,
    sourceRanges: z.array(sourceRangeSchema).max(64),
    messageRefs: z.array(messageRefSchema).max(500),
    activeSummaryRef: summaryRefSchema.nullable(),
    instructionVersion: z.string().min(1).max(64),
    knowledgeContentHash: z.string().min(1).max(128),
    graphSchemaVersion: z.string().min(1).max(64),
    pinnedUserMemory: pinnedUserMemorySchema.nullable().optional(),
  })
  .strict();

export type AgentMemoryManifest = z.infer<typeof agentMemoryManifestSchema>;
export type SourceRange = z.infer<typeof sourceRangeSchema>;
export type MessageRef = z.infer<typeof messageRefSchema>;
