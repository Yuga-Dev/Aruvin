/**
 * ============================================================================
 * FILE: user-memory.spec.ts
 * LOCATION: backend/src/contracts/user-memory.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify bounded user-memory records, wire schemas, and guarded write shapes.
 *
 * ROLE IN PROJECT:
 *    Protects the shared contract surface consumed by persistence, the memory
 *    composer, the explicit tool, and downstream runtime plans.
 *
 * KEY COMPONENTS:
 *    - Collection and five-section rendering/ceiling cases.
 *    - Private wire, writer candidate, and tool receipt cases.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import { guardedClient, MutationJournal } from '../persistence/mutation-journal.js';
import {
  accountingRecordSchema, agentMemoryManifestSchema, calendarCompatibleEnvelopeSchema,
  COLLECTIONS, completedEventSchema, historicalSkillDecisionSchema,
  isCreateVoiceSessionRequest,
  memoryCompatibleSkillDecisionSchema, messageRecordSchema, renderUserMemorySections,
  repairDiagnosticsSchema, serializeNativeLocalResult, sessionRecordSchema,
  sessionSummarySchema, SKILL_NATIVE_TOOLS, skillDecisionSchema, storedUserMemorySchema,
  submitTurnRequestSchema, toVisibleMessage,
  UPDATE_USER_MEMORY_TOOL_DEFINITION, updateUserMemoryArgumentsSchema,
  updateUserMemoryReceiptSchema, userMemoryClearRequestSchema,
  userMemoryEditRequestSchema, userMemoryEditResponseSchema,
  userMemoryEnabledRequestSchema, userMemoryResponseSchema,
  userMemorySectionsSchema, userMemoryWriterOutputSchema,
} from './index.js';

const at = '2026-11-20T12:00:00.000Z';
const empty = { identity: '', work: '', preferences: '', ongoing: '', other: '' };
const stored = { schemaVersion: 1, userId: 'u', enabled: true, sections: empty,
  revision: 1, updatedAt: at };

it('registers user_memory separately and normalizes the five sections in render order', () => {
  expect(COLLECTIONS.userMemory).toBe('user_memory');
  expect(renderUserMemorySections(userMemorySectionsSchema.parse({
    ...empty, work: ' TS\r\nMongo\rVitest ', identity: ' Peter ',
  }))).toBe('- Identity: Peter\n- Work: TS\nMongo\nVitest');
  expect(renderUserMemorySections(userMemorySectionsSchema.parse(empty))).toBe('');
  expect(storedUserMemorySchema.parse(stored)).toEqual(stored);
  expect(storedUserMemorySchema.safeParse({ ...stored, revision: 0 }).success).toBe(false);
  expect(userMemorySectionsSchema.safeParse({ identity: 'Peter' }).success).toBe(false);
  expect(userMemorySectionsSchema.safeParse({ ...empty, calendar: 'event' }).success).toBe(false);
});

it('enforces both rendered ceilings including labels and separators', () => {
  const identity = 'x'.repeat(2500 - '- Identity: '.length);
  expect(userMemorySectionsSchema.safeParse({ ...empty, identity }).success).toBe(true);
  expect(userMemorySectionsSchema.safeParse({ ...empty, identity, work: 'x' }).success).toBe(false);
  // 1,997 supplementary code points at four bytes, plus the 12 ASCII label bytes.
  const otherIdentity = '😀'.repeat(1997);
  expect(Buffer.byteLength(renderUserMemorySections({ ...empty, identity: otherIdentity }))).toBe(8000);
  expect(userMemorySectionsSchema.safeParse({ ...empty, identity: otherIdentity }).success).toBe(true);
  expect(userMemorySectionsSchema.safeParse({ ...empty, identity: `${otherIdentity}x` }).success).toBe(false);
});

it.each(['\u0000Peter', '\u000bPeter', 'OPENROUTER_API_KEY=fixture'])(
  'rejects an unsafe generated section or stored record', (value) => {
    const sections = { ...empty, work: value };
    expect(userMemorySectionsSchema.safeParse(sections).success).toBe(false);
    expect(storedUserMemorySchema.safeParse({ ...stored, sections }).success).toBe(false);
  },
);

it('shares the bounded and screened instruction across composer and explicit tool', () => {
  const cas = { protocolVersion: 1, expectedRevision: 0 };
  for (const instruction of ['x', '😀'.repeat(500), ' Remember beans ']) {
    expect(updateUserMemoryArgumentsSchema.parse({ instruction })).toEqual({ instruction });
    expect(userMemoryEditRequestSchema.safeParse({ ...cas, instruction }).success).toBe(true);
  }
  for (const instruction of ['', ' \t ', 'x'.repeat(501), '\u000bremember', 'sk-or-v1-fixture']) {
    expect(updateUserMemoryArgumentsSchema.safeParse({ instruction }).success).toBe(false);
    expect(userMemoryEditRequestSchema.safeParse({ ...cas, instruction }).success).toBe(false);
  }
  expect(userMemoryEditRequestSchema.safeParse({ ...cas, instruction: 'x', userId: 'other' }).success).toBe(false);
  expect(updateUserMemoryArgumentsSchema.safeParse({ instruction: 'x', action: 'remember' }).success).toBe(false);
  expect(userMemoryEnabledRequestSchema.parse({ ...cas, enabled: false }).enabled).toBe(false);
  expect(userMemoryClearRequestSchema.safeParse({ ...cas, expectedRevision: -1 }).success).toBe(false);
  expect(UPDATE_USER_MEMORY_TOOL_DEFINITION.function.parameters).toMatchObject({
    additionalProperties: false, required: ['instruction'],
    properties: { instruction: { type: 'string', minLength: 1, maxLength: 500 } },
  });
});

it('checks the writer candidate, private view and closed receipt independently', () => {
  const candidate = { changed: true, changeSummary: 'Added pet', sections: empty };
  expect(userMemoryWriterOutputSchema.parse(candidate)).toEqual(candidate);
  expect(userMemoryWriterOutputSchema.safeParse({
    ...candidate, sections: { ...empty, other: 'mongodb://fixture' },
  }).success).toBe(false);
  expect(userMemoryWriterOutputSchema.safeParse({
    ...candidate, sections: { ...empty, work: 'x'.repeat(2500) },
  }).success).toBe(false);
  const view = { protocolVersion: 1, revision: 0, enabled: true, sections: empty,
    isEmpty: true, charCount: 0, maxChars: 2500, updatedAt: null };
  expect(userMemoryResponseSchema.parse(view)).toEqual(view);
  expect(userMemoryEditResponseSchema.parse({ ...view, changeSummary: '' })).toMatchObject({ changeSummary: '' });
  for (const receipt of [
    { ok: true, status: 'updated', summary: 'Added pet' },
    { ok: true, status: 'no_change', summary: '' },
    { ok: false, error: { code: 'SECRET_REJECTED', retryable: false } },
  ]) expect(updateUserMemoryReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(updateUserMemoryReceiptSchema.safeParse({
    ok: false, error: { code: 'UNKNOWN', retryable: false },
  }).success).toBe(false);
});

it('defines a memory decision and receipt without changing the active Calendar tool set', () => {
  const envelope = { instruction: ' Remember beans ' };
  const nativeCall = { id: 'call1', type: 'function',
    function: { name: 'update_user_memory', arguments: JSON.stringify(envelope) } };
  const decision = { kind: 'update_user_memory', decisionId: 'decision1', nativeCall,
    assistantContent: null, envelope, terminal: 'tool_calls' };
  expect(memoryCompatibleSkillDecisionSchema.parse(decision)).toEqual(decision);
  expect(memoryCompatibleSkillDecisionSchema.safeParse({
    ...decision, envelope: { instruction: 'Different' },
  }).success).toBe(false);
  expect(skillDecisionSchema.safeParse(decision).success).toBe(false);
  expect(historicalSkillDecisionSchema.safeParse(decision).success).toBe(false);
  expect(SKILL_NATIVE_TOOLS.map(tool => tool.name)).not.toContain('update_user_memory');
  const receipt = { ok: true, status: 'updated', summary: 'Added pet' };
  expect(JSON.parse(serializeNativeLocalResult(receipt))).toEqual(receipt);
  expect(repairDiagnosticsSchema.safeParse([
    { path: 'instruction', code: 'missing', expected: 'string' },
  ]).success).toBe(true);
});

it('keeps passive progress on the session and preserves the old manifest shape', () => {
  const session = { schemaVersion: 1, userId: 'u', sessionId: 's', title: 'Test',
    createdAt: at, updatedAt: at, lastActivityAt: at, lifecycle: 'active', graphThreadId: 's',
    execution: { ownerId: null, leaseExpiresAt: null, activeAttemptId: null, generation: 0 },
    latestTurnId: null };
  const manifest = { schemaVersion: 1, userId: 'u', sessionId: 's', contextVersion: 0,
    sourceRanges: [], messageRefs: [], activeSummaryRef: null, instructionVersion: 'v1',
    knowledgeContentHash: 'hash', graphSchemaVersion: 'v1' };
  expect(sessionRecordSchema.parse(session)).toEqual(session);
  expect(agentMemoryManifestSchema.parse(manifest)).not.toHaveProperty('pinnedUserMemory');
  expect(sessionRecordSchema.parse({ ...session, ephemeral: true, memoryWatermarkSequence: 0 }))
    .toMatchObject({ ephemeral: true, memoryWatermarkSequence: 0 });
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(sessionRecordSchema.safeParse({ ...session, memoryWatermarkSequence: value }).success).toBe(false);
  }
  for (const key of ['memoryWatermarkSequence', 'ephemeral']) {
    expect(agentMemoryManifestSchema.safeParse({ ...manifest, [key]: 1 }).success).toBe(false);
  }
  const pin = { revision: 1, content: '- Identity: Beans' };
  expect(agentMemoryManifestSchema.parse({ ...manifest, pinnedUserMemory: pin }).pinnedUserMemory).toEqual(pin);
  expect(agentMemoryManifestSchema.parse({ ...manifest, pinnedUserMemory: null }).pinnedUserMemory).toBeNull();
  expect(agentMemoryManifestSchema.safeParse({
    ...manifest, pinnedUserMemory: { ...pin, content: '😀'.repeat(2001) },
  }).success).toBe(false);
});

it('accepts the optional creation flag and rejects unknown identity overrides', () => {
  const input = { sessionId: null, content: 'Hello', idempotencyKey: 'submission-1' };
  expect(submitTurnRequestSchema.parse(input)).toEqual(input);
  expect(submitTurnRequestSchema.parse({ ...input, ephemeral: true }).ephemeral).toBe(true);
  expect(submitTurnRequestSchema.safeParse({ ...input, ephemeral: 'true' }).success).toBe(false);
  expect(submitTurnRequestSchema.safeParse({ ...input, userId: 'other' }).success).toBe(false);
  expect(sessionSummarySchema.parse({
    sessionId: 's', title: 'Temporary', ephemeral: true, createdAt: at, lastActivityAt: at,
  }).ephemeral).toBe(true);
});

it('projects a confirmed assistant marker and accepts it in both terminal envelopes', () => {
  const assistant = { schemaVersion: 1, userId: 'u', sessionId: 's', turnId: 't', messageId: 'm',
    eventId: 'e', sequence: 1, role: 'assistant', content: 'Done', createdAt: at,
    completionStatus: 'completed', attemptId: 'a', truncated: false };
  const marked = messageRecordSchema.parse({ ...assistant, memoryUpdated: true });
  expect(toVisibleMessage(marked).memoryUpdated).toBe(true);
  expect(toVisibleMessage(messageRecordSchema.parse(assistant))).not.toHaveProperty('memoryUpdated');
  expect(toVisibleMessage(messageRecordSchema.parse({ ...assistant, memoryUpdated: false })))
    .not.toHaveProperty('memoryUpdated');
  expect(messageRecordSchema.safeParse({ ...assistant, role: 'user', memoryUpdated: true }).success)
    .toBe(false);
  const event = { type: 'completed', assistantMessageId: 'm', outcome: 'completed', memoryUpdated: true };
  for (const protocolVersion of [1, 3]) {
    expect(calendarCompatibleEnvelopeSchema.parse({
      protocolVersion, sessionId: 's', turnId: 't', attemptId: 'a', sequence: 2, event,
    }).event).toEqual(event);
  }
  expect(completedEventSchema.safeParse({ ...event, memoryUpdated: 'true' }).success).toBe(false);
});

it('admits memory accounting without invalidating older text records', () => {
  const row = { schemaVersion: 1, kind: 'accounting', userId: 'u', sessionId: 'memory-composer',
    turnId: 't', attemptId: 'a', generationId: null, requestedModel: 'fixture/model',
    reportedModel: null, reportedProvider: null, promptTokens: null, completionTokens: null,
    cost: null, accountingStatus: 'unknown', outcome: 'completed', startedAt: at, endedAt: at };
  expect(accountingRecordSchema.parse(row)).toEqual(row);
  expect(accountingRecordSchema.parse({ ...row, purpose: 'memory' }).purpose).toBe('memory');
});

it('accepts the optional voice creation flag without relaxing the request shape', () => {
  const request = { protocolVersion: 1, mode: 'live', conversationId: null,
    locale: 'en-US', idempotencyKey: 'voice-123' };
  expect(isCreateVoiceSessionRequest(request)).toBe(true);
  expect(isCreateVoiceSessionRequest({ ...request, ephemeral: true })).toBe(true);
  expect(isCreateVoiceSessionRequest({ ...request, ephemeral: false })).toBe(true);
  expect(isCreateVoiceSessionRequest({ ...request, ephemeral: 'true' })).toBe(false);
  expect(isCreateVoiceSessionRequest({ ...request, ephemeral: true, userId: 'other' })).toBe(false);
});

it('journals user_memory upserts and scoped deletes without weakening the facade', async () => {
  const order: string[] = [];
  const updateOne = vi.fn(async (_filter: unknown, update: unknown) => {
    const state = (update as { $set: { 'local.mutation': { state: string } } }).$set['local.mutation'].state;
    order.push(state);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
  });
  const dispatch = (name: string) => vi.fn(async (..._args: unknown[]) => {
    order.push(name);
    return { acknowledged: true, deletedCount: 1 };
  });
  const upsert = dispatch('upsert');
  const deleteMany = dispatch('deleteMany');
  const deleteOne = dispatch('deleteOne');
  const raw = { db: () => ({ collection: () => ({ updateOne: upsert, deleteMany, deleteOne }) }) };
  const db = guardedClient(raw as unknown as MongoClient, 'fixture', new MutationJournal({ updateOne }, 'owner', 100))
    .db('fixture');
  const filter = { _id: 'u', userId: 'u' };
  const scoped = { userId: 'u', sessionId: 's' };
  const options = { writeConcern: { w: 'majority', j: true }, timeoutMS: 100, maxTimeMS: 100 };
  await db.collection(COLLECTIONS.userMemory).updateOne(filter, { $setOnInsert: { userId: 'u' } }, { upsert: true });
  await db.collection(COLLECTIONS.messages).deleteMany(scoped, { writeConcern: { w: 0 } });
  await db.collection(COLLECTIONS.sessions).deleteOne(scoped);
  expect(upsert).toHaveBeenCalledWith(filter, { $setOnInsert: { userId: 'u' } }, { ...options, upsert: true });
  expect(deleteMany).toHaveBeenCalledWith(scoped, options);
  expect(deleteOne).toHaveBeenCalledWith(scoped, options);
  expect(order).toEqual(['busy', 'upsert', 'idle', 'busy', 'deleteMany', 'idle', 'busy', 'deleteOne', 'idle']);
  expect(() => db.collection('unadmitted')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_TOPOLOGY' }));
  expect(() => db.collection(COLLECTIONS.sessions).drop()).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_TOPOLOGY' }),
  );
  expect(() => db.collection(COLLECTIONS.sessions).deleteOne(scoped, { session: {} as never })).toThrow(
    expect.objectContaining({ code: 'UNSUPPORTED_TOPOLOGY' }),
  );
  expect(deleteOne).toHaveBeenCalledTimes(1);
});
