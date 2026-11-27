/**
 * ============================================================================
 * FILE: api.ts
 * LOCATION: backend/src/contracts/api.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define versioned, strict client-safe HTTP request and response schemas.
 *
 * ROLE IN PROJECT:
 *    Shares resource paths and validated payload types across backend HTTP
 *    adapters and the frontend without accepting client identity or model data.
 *
 * KEY COMPONENTS:
 *    - API_ROUTES: Resource-relative paths served beneath the API prefix.
 *    - Request/response schemas: Bounded submit, retry, paging, and status data.
 * ============================================================================
 */

import { z } from 'zod';
import { attemptStatusSchema } from './attempt.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { clientErrorBodySchema } from './errors.js';
import { idSchema, isoDateSchema } from './identifiers.js';
import { messageRecordObjectSchema, type MessageRecord } from './message.js';
import { isCanvasArtifactId } from './voice-wire.js';
import { CONTRACT_VERSIONS } from './versions.js';
import { calendarCompatibleTurnStateSchema } from './calendar-wire.js';
import { calendarReplyReferenceSchema } from './calendar-authority.js';
import { saveStateSnapshotSchema } from './stream.js';
import { compactionCheckpointMetaSchema } from './agent-memory.js';
import { contextUsageMetaSchema } from './context.js';

export const API_PROTOCOL_VERSION = CONTRACT_VERSIONS.api;

export const API_ROUTES = {
  sessions: '/sessions',
  session: (sessionId: string) => `/sessions/${sessionId}`,
  messages: (sessionId: string) => `/sessions/${sessionId}/messages`,
  turns: (sessionId: string) => `/sessions/${sessionId}/turns`,
  turnStatus: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}`,
  turnStream: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}/stream`,
  cancelTurn: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}/cancel`,
  retryTurn: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}/retry`,
  retrySave: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}/retry-save`,
  searchSessions: '/sessions/search',
  editTurn: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}/edit`,
  regenerateTurn: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}/regenerate`,
  messageFeedback: (sessionId: string, messageId: string) =>
    `/sessions/${sessionId}/messages/${messageId}/feedback`,
  exportSession: (sessionId: string) => `/sessions/${sessionId}/export.md`,
  skipTaskStep: (sessionId: string, turnId: string, stepId: string) =>
    `/sessions/${sessionId}/turns/${turnId}/steps/${stepId}/skip`,
} as const;

export const submitTurnRequestSchema = z
  .object({
    sessionId: idSchema.nullable(),
    content: z.string().min(1).max(DEFAULT_BUDGETS.maxInputChars),
    idempotencyKey: z.string().min(8).max(128),
    ephemeral: z.boolean().optional(),
    expectedEpoch: idSchema.optional(),
    calendarProtocol: z.union([z.literal(2), z.literal(3)]).optional(),
    /**
     * Optional untrusted causal reference to the proposal revision this reply answers.
     *
     * It is bounded, optional, and never approval: it lets the server tell a reply to
     * a superseded disclosure from an affirmative to the current one. A reply without
     * it stays valid here; the server-side acceptance rule is a runtime concern.
     */
    calendarReplyTo: calendarReplyReferenceSchema.optional(),
    /** Task mode (docs/task-mode-and-flows/spec.md): plan first, then the normal tool loop. */
    task: z.literal(true).optional(),
  })
  .strict();

export const retryTurnRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(128),
    expectedEpoch: idSchema.optional(),
    calendarProtocol: z.union([z.literal(2), z.literal(3)]).optional(),
  })
  .strict();

/** Edit the latest user turn: a new turn whose user message supersedes the original. */
export const editTurnRequestSchema = z
  .object({
    content: z.string().min(1).max(DEFAULT_BUDGETS.maxInputChars),
    idempotencyKey: z.string().min(8).max(128),
    expectedEpoch: idSchema.optional(),
    calendarProtocol: z.union([z.literal(2), z.literal(3)]).optional(),
  })
  .strict();

/** Regenerate the latest turn: same envelope as retry, allowed after completion. */
export const regenerateTurnRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(128),
    expectedEpoch: idSchema.optional(),
    calendarProtocol: z.union([z.literal(2), z.literal(3)]).optional(),
  })
  .strict();

export const feedbackRatingSchema = z.enum(['up', 'down']);
/** rating null clears the caller's rating. */
export const feedbackRequestSchema = z.object({ rating: feedbackRatingSchema.nullable() }).strict();
export const feedbackResponseSchema = z
  .object({ messageId: idSchema, rating: feedbackRatingSchema.nullable() })
  .strict();

export const SEARCH_QUERY_MAX_CHARS = 100;
export const SEARCH_LIMIT_MAX = 20;
export const SEARCH_LIMIT_DEFAULT = 10;
/** Raw query-string shape (all scalars are strings on the wire). */
export const searchSessionsQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(SEARCH_QUERY_MAX_CHARS),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d?$/u)
      .refine(v => Number(v) <= SEARCH_LIMIT_MAX)
      .optional(),
  })
  .strict();

export const searchResultSchema = z
  .object({
    sessionId: idSchema,
    title: z.string().min(1).max(DEFAULT_BUDGETS.titleMaxChars),
    lastActivityAt: isoDateSchema,
    match: z.enum(['title', 'message']),
    snippet: z.string().max(300).optional(),
    messageId: idSchema.optional(),
  })
  .strict();

export const searchSessionsResponseSchema = z
  .object({
    items: z.array(searchResultSchema).max(SEARCH_LIMIT_MAX),
    nextCursor: z.string().min(1).nullable(),
    degraded: z.boolean().optional(),
  })
  .strict();

export const cancelTurnRequestSchema = z
  .object({
    attemptId: idSchema,
  })
  .strict();

/** Same shape as cancel: the body names the attempt; identity is always server-resolved. */
export const skipTaskStepRequestSchema = cancelTurnRequestSchema;

export const retrySaveRequestSchema = z.object({ epoch: idSchema,
  version: z.number().int().nonnegative().safe() }).strict();

export const submitTurnResponseSchema = z
  .object({
    sessionId: idSchema,
    turnId: idSchema,
    attemptId: idSchema,
    userMessageId: idSchema,
    streamPath: z.string().min(1),
    processEpoch: idSchema.optional(),
  })
  .strict();

export const sessionSummarySchema = z
  .object({
    sessionId: idSchema,
    title: z.string().min(1).max(DEFAULT_BUDGETS.titleMaxChars),
    pinned: z.boolean().optional(),
    ephemeral: z.boolean().optional(),
    createdAt: isoDateSchema,
    lastActivityAt: isoDateSchema,
  })
  .strict();

export const listSessionsResponseSchema = z
  .object({
    items: z.array(sessionSummarySchema).max(DEFAULT_BUDGETS.maxPageSize),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export const visibleMessageSchema = messageRecordObjectSchema.pick({
  messageId: true,
  turnId: true,
  eventId: true,
  sequence: true,
  role: true,
  content: true,
  createdAt: true,
  completionStatus: true,
  truncated: true,
  mode: true,
  voiceSessionId: true,
  voiceDurationSeconds: true,
  voiceTranscripts: true,
  canvasArtifacts: true,
  calendarView: true,
  weatherView: true,
  webSources: true,
  webActivities: true,
  memoryUpdated: true,
  task: true,
  supersedes: true,
}).extend({
  /** The caller's own rating only. */
  feedback: feedbackRatingSchema.optional(),
}).superRefine((v, ctx) => {
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
  if (v.canvasArtifacts !== undefined) {
    if (v.role !== 'assistant') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['role'], message: 'canvas artifacts require assistant role' });
    }
    if (v.mode !== 'live') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mode'], message: 'canvas artifacts require live mode' });
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

export const activeSessionTurnSchema = z
  .object({
    turnId: idSchema,
    attemptId: idSchema,
    status: z.enum(['accepted', 'generating', 'finalizing']),
    mode: z.enum(['text', 'live']).optional(),
  })
  .strict();

const CANVAS_TAG_RE = /<aurvin-canvas\b|<canvas\b|<svg\b/i;
const CANVAS_FENCE_TOKENS = new Set([
  'mermaid', 'mmd', 'chart', 'graph', 'plot', 'scatter', 'xy', 'xy-plot',
  'line-graph', 'bar-chart', 'line-chart', 'pie-chart', 'area-chart',
  'svg', 'calendar', 'event', 'canvas', 'json',
]);
const CANVAS_MERMAID_HEADER_RE =
  /^(?:---\s*\n[\s\S]*?\n---\s*\n\s*)?(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|pie|xychart-beta|quadrantChart|gantt|mindmap)\b/i;

/**
 * True when an assistant record can produce at least one Canvas artifact.
 * Mirrors the frontend detectors without importing UI parsing into contracts.
 */
export function hasCanvasContent(record: {
  role: string;
  content: string;
  visibility?: string;
  canvasArtifacts?: readonly unknown[];
  calendarView?: unknown;
  weatherView?: unknown;
}): boolean {
  if (record.role !== 'assistant') return false;
  if (
    record.calendarView !== undefined
    || record.weatherView !== undefined
    || (record.canvasArtifacts !== undefined && record.canvasArtifacts.length > 0)
  ) {
    return true;
  }
  if (record.visibility === 'internal') return false;
  if (CANVAS_TAG_RE.test(record.content)) return true;
  if (!record.content.includes('```') && !record.content.includes('~~~')) return false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;
  let emptyFenceBody: string[] | null = null;
  for (const line of record.content.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (fenceChar) {
      if (trimmed.length >= fenceLen && [...trimmed].every(char => char === fenceChar)) {
        if (emptyFenceBody && CANVAS_MERMAID_HEADER_RE.test(emptyFenceBody.join('\n').trim())) {
          return true;
        }
        fenceChar = null;
        emptyFenceBody = null;
      } else if (emptyFenceBody) {
        emptyFenceBody.push(line);
      }
      continue;
    }
    const open = /(?:^|\s)(?:(`{3,})|(~{3,}))(.*)$/.exec(trimmed);
    if (!open) continue;
    const marker = (open[1] ?? open[2])!;
    const info = open[3]!.trim();
    const firstToken = (info.split(/\s+/)[0] ?? '').toLowerCase();
    if (CANVAS_FENCE_TOKENS.has(firstToken)) return true;
    fenceChar = marker[0] as '`' | '~';
    fenceLen = marker.length;
    emptyFenceBody = firstToken === '' ? [] : null;
  }
  return emptyFenceBody !== null && CANVAS_MERMAID_HEADER_RE.test(emptyFenceBody.join('\n').trim());
}

export const listMessagesResponseSchema = z
  .object({
    items: z.array(visibleMessageSchema).max(DEFAULT_BUDGETS.maxPageSize),
    nextCursor: z.string().min(1).nullable(),
    olderAvailable: z.boolean(),
    canvasMessages: z.array(visibleMessageSchema).max(DEFAULT_BUDGETS.maxPageSize).optional(),
    save: saveStateSnapshotSchema.optional(),
    saveTurnId: idSchema.optional(),
    activeTurn: activeSessionTurnSchema.optional(),
    compaction: compactionCheckpointMetaSchema.optional(),
    contextUsage: contextUsageMetaSchema.optional(),
  })
  .strict();

export const turnStatusResponseSchema = z
  .object({
    sessionId: idSchema,
    turnId: idSchema,
    attemptId: idSchema,
    status: attemptStatusSchema,
    truncated: z.boolean(),
    error: clientErrorBodySchema.nullable(),
    calendar: calendarCompatibleTurnStateSchema.optional(),
    save: saveStateSnapshotSchema.optional(),
  })
  .strict();

export const pageRequestSchema = z
  .object({
    cursor: z.string().min(1).nullable(),
    limit: z
      .number()
      .int()
      .positive()
      .max(DEFAULT_BUDGETS.maxPageSize)
      .default(DEFAULT_BUDGETS.defaultPageSize),
  })
  .strict();

export type SubmitTurnRequest = z.infer<typeof submitTurnRequestSchema>;
export type CreateSessionRequest = SubmitTurnRequest & { sessionId: null };
export type RetryTurnRequest = z.infer<typeof retryTurnRequestSchema>;
export type EditTurnRequest = z.infer<typeof editTurnRequestSchema>;
export type RegenerateTurnRequest = z.infer<typeof regenerateTurnRequestSchema>;
export type FeedbackRating = z.infer<typeof feedbackRatingSchema>;
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;
export type FeedbackResponse = z.infer<typeof feedbackResponseSchema>;
export type SearchSessionsQuery = z.infer<typeof searchSessionsQuerySchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchSessionsResponse = z.infer<typeof searchSessionsResponseSchema>;
export type CancelTurnRequest = z.infer<typeof cancelTurnRequestSchema>;
export type SubmitTurnResponse = z.infer<typeof submitTurnResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;
export type VisibleMessage = z.infer<typeof visibleMessageSchema>;
export type ActiveSessionTurn = z.infer<typeof activeSessionTurnSchema>;
export type ListMessagesResponse = z.infer<typeof listMessagesResponseSchema>;
export type TurnStatusResponse = z.infer<typeof turnStatusResponseSchema>;
export type PageRequest = z.infer<typeof pageRequestSchema>;

/**
 * Single canonical MessageRecord -> client projection. Internal inputs keep
 * their content only in voiceTranscripts so the visible transcript is not
 * duplicated while a voice UI can still show the spoken text.
 */
export function toVisibleMessage(record: MessageRecord): VisibleMessage {
  return visibleMessageSchema.parse({
    messageId: record.messageId,
    turnId: record.turnId,
    eventId: record.eventId,
    sequence: record.sequence,
    role: record.role,
    content: record.visibility === 'internal' ? '' : record.content,
    createdAt: record.createdAt,
    completionStatus: record.completionStatus,
    truncated: record.truncated,
    ...(record.mode !== undefined ? { mode: record.mode } : {}),
    ...(record.voiceSessionId !== undefined ? { voiceSessionId: record.voiceSessionId } : {}),
    ...(record.voiceDurationSeconds !== undefined ? { voiceDurationSeconds: record.voiceDurationSeconds } : {}),
    ...(record.visibility === 'internal'
      ? { voiceTranscripts: [{ role: record.role, content: record.content, createdAt: record.createdAt }] }
      : record.voiceTranscripts !== undefined ? { voiceTranscripts: record.voiceTranscripts } : {}),
    ...(record.canvasArtifacts !== undefined ? { canvasArtifacts: record.canvasArtifacts } : {}),
    ...(record.calendarView ? { calendarView: record.calendarView } : {}),
    ...(record.weatherView ? { weatherView: record.weatherView } : {}),
    ...(record.webSources ? { webSources: record.webSources } : {}),
    ...(record.webActivities ? { webActivities: record.webActivities } : {}),
    ...(record.memoryUpdated === true ? { memoryUpdated: true } : {}),
    ...(record.task ? { task: record.task } : {}),
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
  });
}
