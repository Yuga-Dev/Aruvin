/**
 * ============================================================================
 * FILE: user-memory.ts
 * LOCATION: backend/src/contracts/user-memory.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define the bounded five-section user-memory record, renderer, and wire shapes.
 *
 * ROLE IN PROJECT:
 *    Shares one validated memory contract across persistence, the memory
 *    composer, and the explicit tool without enabling runtime behavior.
 *
 * KEY COMPONENTS:
 *    - UserMemorySections / renderUserMemorySections: Ordered bounded sections.
 *    - storedUserMemorySchema: Revision-fenced per-user storage document.
 *    - Section-edit, history and memory-audit schemas (counts and ids only, never memory text).
 * ============================================================================
 */

import { z } from 'zod';
import { idSchema } from './identifiers.js';
import { hasDisallowedControlChars, hasSecretPattern,
  normalizeCustomInstructions } from './personalization.js';

export const USER_MEMORY_SECTION_KEYS = ['identity', 'work', 'preferences', 'ongoing', 'other'] as const;
export const USER_MEMORY_MAX_CHARS = 2500;
export const USER_MEMORY_MAX_BYTES = 8000;
export const USER_MEMORY_RECORD_MAX_BYTES = 16_384;
export type UserMemorySections = Record<(typeof USER_MEMORY_SECTION_KEYS)[number], string>;

export const userMemoryCharCount = (value: string): number => Array.from(value).length;
const fitsRenderedMemory = (value: string): boolean =>
  value.length <= USER_MEMORY_MAX_CHARS * 2 &&
  Buffer.byteLength(value, 'utf8') <= USER_MEMORY_MAX_BYTES &&
  userMemoryCharCount(value) <= USER_MEMORY_MAX_CHARS;

export function renderUserMemorySections(sections: UserMemorySections): string {
  return USER_MEMORY_SECTION_KEYS.filter(key => sections[key] !== '')
    .map(key => `- ${key.charAt(0).toUpperCase()}${key.slice(1)}: ${sections[key]}`)
    .join('\n');
}

const safeMemoryText = z.string()
  .refine(value => !hasDisallowedControlChars(value), { message: 'disallowed_characters' })
  .refine(value => !hasSecretPattern(value), { message: 'secret_pattern' });
const section = safeMemoryText.transform(normalizeCustomInstructions);
export const userMemorySectionsSchema = z.object({
  identity: section, work: section, preferences: section, ongoing: section, other: section,
}).strict().refine(sections => fitsRenderedMemory(renderUserMemorySections(sections)), {
  message: 'rendered user memory exceeds its limit',
});
const revision = z.number().int().nonnegative().safe();
const persistedRevision = revision.min(1);
const timestamp = z.string().max(40).datetime({ offset: true });
export const storedUserMemorySchema = z.object({
  schemaVersion: z.literal(1), userId: idSchema, enabled: z.boolean(),
  sections: userMemorySectionsSchema, revision: persistedRevision, updatedAt: timestamp,
}).strict();
export type StoredUserMemory = z.infer<typeof storedUserMemorySchema>;

export const USER_MEMORY_INSTRUCTION_MAX_CHARS = 500;
const instructionSchema = safeMemoryText.refine(value =>
  value.length <= 2 * USER_MEMORY_INSTRUCTION_MAX_CHARS &&
  userMemoryCharCount(value) <= USER_MEMORY_INSTRUCTION_MAX_CHARS &&
  value.trim().length > 0,
);
const summarySchema = safeMemoryText.refine(value =>
  value.length <= 2 * USER_MEMORY_INSTRUCTION_MAX_CHARS &&
  userMemoryCharCount(value) <= USER_MEMORY_INSTRUCTION_MAX_CHARS,
);
export const userMemoryWriterOutputSchema = z.object({
  changed: z.boolean(), changeSummary: summarySchema, sections: userMemorySectionsSchema,
}).strict();
export type UserMemoryWriterOutput = z.infer<typeof userMemoryWriterOutputSchema>;

export const USER_MEMORY_ROUTES = {
  memory: '/personalization/memory',
  enabled: '/personalization/memory/enabled',
  edit: '/personalization/memory/edit',
  clear: '/personalization/memory/clear',
  section: '/personalization/memory/sections/:key',
  history: '/personalization/memory/history',
} as const;
export const userMemorySectionKeySchema = z.enum(USER_MEMORY_SECTION_KEYS);
export type UserMemorySectionKey = z.infer<typeof userMemorySectionKeySchema>;
// Idempotency key for one user action; retried after an unknown outcome with the same value.
export const userMemoryRequestIdSchema = idSchema;
export const userMemoryClearRequestSchema = z.object({
  protocolVersion: z.literal(1), expectedRevision: revision.max(Number.MAX_SAFE_INTEGER - 1),
  requestId: userMemoryRequestIdSchema.optional(),
}).strict();
export const USER_MEMORY_HISTORY_MAX_LIMIT = 50;
// One section's text; the whole rendered memory is re-validated before saving.
export const userMemorySectionEditRequestSchema = userMemoryClearRequestSchema.extend({
  requestId: userMemoryRequestIdSchema,
  text: safeMemoryText.refine(value => value.length <= USER_MEMORY_MAX_CHARS * 2, { message: 'too_long' })
    .transform(normalizeCustomInstructions),
});
export const userMemoryHistoryQuerySchema = z.object({
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(USER_MEMORY_HISTORY_MAX_LIMIT).default(USER_MEMORY_HISTORY_MAX_LIMIT),
}).strict();
export const userMemoryEnabledRequestSchema = userMemoryClearRequestSchema.extend({ enabled: z.boolean() });
export const userMemoryEditRequestSchema = userMemoryClearRequestSchema.extend({ instruction: instructionSchema });
export const userMemoryResponseSchema = z.object({
  protocolVersion: z.literal(1), revision, enabled: z.boolean(), sections: userMemorySectionsSchema,
  isEmpty: z.boolean(), charCount: z.number().int().min(0).max(USER_MEMORY_MAX_CHARS),
  maxChars: z.literal(USER_MEMORY_MAX_CHARS), updatedAt: timestamp.nullable(),
}).strict();
export const userMemoryEditResponseSchema = userMemoryResponseSchema.extend({ changeSummary: summarySchema });
export type UserMemoryClearRequest = z.infer<typeof userMemoryClearRequestSchema>;
export type UserMemoryEnabledRequest = z.infer<typeof userMemoryEnabledRequestSchema>;
export type UserMemoryEditRequest = z.infer<typeof userMemoryEditRequestSchema>;
export type UserMemoryResponse = z.infer<typeof userMemoryResponseSchema>;
export type UserMemoryEditResponse = z.infer<typeof userMemoryEditResponseSchema>;
export type UserMemorySectionEditRequest = z.infer<typeof userMemorySectionEditRequestSchema>;

export const MEMORY_AUDIT_ACTIONS = ['edit-section', 'clear-section', 'clear-all', 'enable', 'disable',
  'instruction', 'tool', 'passive'] as const;
export const MEMORY_AUDIT_SOURCES = ['user-ui', 'composer', 'tool', 'passive'] as const;
const charCount = z.number().int().min(0).max(USER_MEMORY_MAX_CHARS);
// Counts, section names and ids only: a deleted fact must not survive in audit. The chat
// id is nested under origin so session purge (top-level sessionId) never removes it.
const auditFields = {
  memoryRevision: persistedRevision, at: timestamp,
  action: z.enum(MEMORY_AUDIT_ACTIONS), source: z.enum(MEMORY_AUDIT_SOURCES),
  sections: z.array(userMemorySectionKeySchema).max(USER_MEMORY_SECTION_KEYS.length),
  charsBefore: charCount, charsAfter: charCount,
  origin: z.object({ sessionId: idSchema, turnId: idSchema }).strict().optional(),
};
export const MEMORY_AUDIT_RECORD_MAX_BYTES = 1024;
export const memoryAuditRecordSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('memory-audit'), userId: idSchema,
  requestId: userMemoryRequestIdSchema.optional(), ...auditFields,
}).strict();
export type MemoryAuditRecord = z.infer<typeof memoryAuditRecordSchema>;
export const memoryAuditViewSchema = z.object(auditFields).strict();
export type MemoryAuditView = z.infer<typeof memoryAuditViewSchema>;
export const userMemoryHistoryResponseSchema = z.object({
  protocolVersion: z.literal(1), items: z.array(memoryAuditViewSchema).max(USER_MEMORY_HISTORY_MAX_LIMIT),
  nextCursor: z.string().max(256).nullable(),
  // Inclusive revision ranges with no audit record (failed audit write); at most one entry per item.
  gaps: z.array(z.object({ fromRevision: persistedRevision, toRevision: persistedRevision }).strict())
    .max(USER_MEMORY_HISTORY_MAX_LIMIT + 1),
}).strict();
export type UserMemoryHistoryResponse = z.infer<typeof userMemoryHistoryResponseSchema>;

export const UPDATE_USER_MEMORY_TOOL_NAME = 'update_user_memory' as const;
export const UPDATE_USER_MEMORY_NATIVE_TOOL = {
  name: UPDATE_USER_MEMORY_TOOL_NAME,
  description: 'Remember, update, or forget durable personal facts only when the user explicitly asks.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['instruction'],
    properties: { instruction: { type: 'string', minLength: 1, maxLength: USER_MEMORY_INSTRUCTION_MAX_CHARS } },
  },
} as const;
export const UPDATE_USER_MEMORY_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: UPDATE_USER_MEMORY_NATIVE_TOOL.name, description: UPDATE_USER_MEMORY_NATIVE_TOOL.description,
    parameters: UPDATE_USER_MEMORY_NATIVE_TOOL.inputSchema,
  },
} as const;
export const updateUserMemoryArgumentsSchema = z.object({ instruction: instructionSchema }).strict();
export const updateUserMemoryReceiptSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: z.enum(['updated', 'no_change']), summary: summarySchema }).strict(),
  z.object({ ok: z.literal(false), error: z.object({
    code: z.enum(['SECRET_REJECTED', 'MEMORY_DISABLED', 'WRITER_UNAVAILABLE', 'PERSISTENCE_ERROR']),
    retryable: z.boolean(),
  }).strict() }).strict(),
]);
export type UpdateUserMemoryArguments = z.infer<typeof updateUserMemoryArgumentsSchema>;
export type UpdateUserMemoryReceipt = z.infer<typeof updateUserMemoryReceiptSchema>;

export const pinnedUserMemorySchema = z.object({
  revision: persistedRevision,
  content: safeMemoryText.refine(value => value.trim().length > 0 && fitsRenderedMemory(value)),
}).strict();
export type PinnedUserMemory = z.infer<typeof pinnedUserMemorySchema>;
