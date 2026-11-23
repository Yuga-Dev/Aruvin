/**
 * ============================================================================
 * FILE: compaction.spec.ts
 * LOCATION: backend/src/contracts/compaction.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify bounded compaction memory and client-safe context projections.
 *
 * ROLE IN PROJECT:
 *    Freezes P1 contracts for downstream context, runtime, and UI workers
 *    without requiring provider or database access.
 *
 * KEY COMPONENTS:
 *    - Summary contracts: Provenance, scratchpad exclusion, and redaction.
 *    - Projection contracts: Optional checkpoint and context-usage metadata.
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import {
  activeSummaryRecordSchema, agentMemoryManifestSchema, compactionCheckpointMetaSchema,
  redactSummaryCalendar,
} from './agent-memory.js';
import { CALENDAR_TOMBSTONE } from './calendar-sources.js';
import { contextUsageMetaSchema } from './context.js';
import { listMessagesResponseSchema } from './api.js';
import { sessionRecordSchema } from './session.js';
import { streamEnvelopeSchema, completedEventSchema, encodeSseFrame, parseSseDataLine } from './stream.js';
import type { ContextSourceSnapshot } from './context.js';

const range = { fromSequence: 0, toSequence: 4, fromEventId: 'e0', toEventId: 'e4' };
const rawSummary = {
  schemaVersion: 1, kind: 'memory-summary', userId: 'u1', sessionId: 's1',
  summaryId: 'summary-1', compactionCycle: 1, sourceRange: range,
  content: 'Goal: ship.\n<calendar_context>Private event at 4pm.</calendar_context>\nNext: confirm.',
  calendarProvenance: { containsCalendarContent: true, connectionId: 'conn-1',
    connectionRevision: 2, earliestExpiresAt: '2026-11-17T12:00:00.000Z', redactedAt: null },
  modelId: 'fixture/model', tokenEstimate: 120, createdAt: '2026-11-17T11:00:00.000Z',
};

describe('compaction memory contracts', () => {
  it('accepts a structured summary and a bounded tail-only manifest snapshot', () => {
    const summary = activeSummaryRecordSchema.parse(rawSummary);
    const manifest = agentMemoryManifestSchema.parse({
      schemaVersion: 1, userId: 'u1', sessionId: 's1', contextVersion: 2,
      activeSummaryRef: { summaryId: summary.summaryId, sourceRange: range },
      sourceRanges: [], messageRefs: [], instructionVersion: 'v1',
      knowledgeContentHash: 'abc', graphSchemaVersion: 'v1',
    });
    const snapshot: ContextSourceSnapshot = { manifest, records: [], summary };
    expect(snapshot.summary?.sourceRange.toSequence).toBe(4);
    expect(manifest.activeSummaryRef?.summaryId).toBe('summary-1');
  });

  it('rejects scratchpad, invalid provenance, unsafe ranges and unbounded content', () => {
    for (const change of [
      { content: '<analysis>private reasoning</analysis><summary>answer</summary>' },
      { reasoning: 'private reasoning' },
      { compactionCycle: 0 },
      { tokenEstimate: Number.MAX_SAFE_INTEGER + 1 },
      { sourceRange: { ...range, toSequence: -1 } },
      { sourceRange: { ...range, fromSequence: 5 } },
      { sourceRange: { ...range, toSequence: Number.MAX_SAFE_INTEGER + 1 } },
      { content: 'x'.repeat(65_537) },
      { content: 'Calendar data without its isolated block.' },
      { content: '<calendar_context>one</calendar_context><calendar_context>two</calendar_context>' },
      { calendarProvenance: { ...rawSummary.calendarProvenance, connectionId: null } },
      { calendarProvenance: { ...rawSummary.calendarProvenance, connectionRevision: 0 } },
      { calendarProvenance: { ...rawSummary.calendarProvenance, earliestExpiresAt: null } },
      { calendarProvenance: { ...rawSummary.calendarProvenance,
        redactedAt: '2026-11-17T11:30:00.000Z' } },
    ]) expect(activeSummaryRecordSchema.safeParse({ ...rawSummary, ...change }).success).toBe(false);
  });

  it('accepts non-Calendar summaries only without Calendar provenance or tags', () => {
    const plain = { ...rawSummary, content: 'Continue URL research.',
      calendarProvenance: { containsCalendarContent: false, connectionId: null,
        connectionRevision: null, earliestExpiresAt: null, redactedAt: null } };
    expect(activeSummaryRecordSchema.safeParse(plain).success).toBe(true);
    expect(activeSummaryRecordSchema.safeParse({ ...plain,
      content: rawSummary.content }).success).toBe(false);
  });

  it('replaces only the Calendar block without mutation or redaction reversal', () => {
    const summary = activeSummaryRecordSchema.parse(rawSummary);
    const at = '2026-11-17T11:30:00.000Z';
    const redacted = redactSummaryCalendar(summary, at);
    expect(redacted.content).toBe(
      `Goal: ship.\n<calendar_context>${CALENDAR_TOMBSTONE}</calendar_context>\nNext: confirm.`,
    );
    expect(summary.content).toContain('Private event at 4pm.');
    expect(redacted.calendarProvenance.redactedAt).toBe(at);
    expect(redacted.sourceRange).toEqual(range);
    expect(activeSummaryRecordSchema.parse(redacted)).toEqual(redacted);
    expect(redactSummaryCalendar(redacted, '2026-11-17T12:00:00.000Z')).toBe(redacted);
  });
});

describe('compaction wire projections', () => {
  const compaction = { compactedThroughSequence: 4, compactionCycle: 1, summaryPreview: 'Goal: ship.' };
  const contextUsage = { historyTokens: 8000, maxHistoryTokens: 10000,
    utilizationPercent: 80, status: 'compacting' };
  it('round-trips optional metadata on list, completed, and context-state events', () => {
    expect(listMessagesResponseSchema.parse({ items: [], nextCursor: null,
      olderAvailable: true, compaction, contextUsage }).compaction).toEqual(compaction);
    expect(listMessagesResponseSchema.safeParse({
      items: [], nextCursor: null, olderAvailable: false,
    }).success).toBe(true);
    expect(completedEventSchema.parse({ type: 'completed', assistantMessageId: 'm6',
      outcome: 'completed', compaction, contextUsage }).contextUsage).toEqual(contextUsage);
    const envelope = streamEnvelopeSchema.parse({
      protocolVersion: 1, sessionId: 's1', turnId: 't1', attemptId: 'a1', sequence: 9,
      event: { type: 'context-state', compaction, contextUsage },
    });
    expect(parseSseDataLine(encodeSseFrame(envelope))).toEqual(envelope);
    expect(streamEnvelopeSchema.safeParse({
      ...envelope, event: { type: 'context-state', contextUsage },
    }).success).toBe(true);
    expect(streamEnvelopeSchema.safeParse({
      ...envelope, event: { type: 'context-state', compaction },
    }).success).toBe(false);
    expect(contextUsageMetaSchema.parse({
      ...contextUsage, historyTokens: 10500, utilizationPercent: 105,
    }).utilizationPercent).toBe(105);
  });
  it('keeps unsafe preview data, provider internals and invalid usage out of the wire', () => {
    for (const change of [
      { compactedThroughSequence: -1 }, { compactionCycle: 0 },
      { summaryPreview: 'x'.repeat(501) }, { summaryPreview: '<analysis>private</analysis>' },
      { summaryPreview: '<calendar_context>private</calendar_context>' },
      { summaryId: 'internal-summary' },
    ]) expect(compactionCheckpointMetaSchema.safeParse({ ...compaction, ...change }).success).toBe(false);
    for (const change of [
      { historyTokens: -1 }, { maxHistoryTokens: 0 }, { utilizationPercent: Infinity },
      { historyTokens: Number.MAX_SAFE_INTEGER + 1 }, { status: 'failed' }, { modelId: 'provider/model' },
    ]) expect(contextUsageMetaSchema.safeParse({ ...contextUsage, ...change }).success).toBe(false);
  });
  it('accepts an optional strict checkpoint on existing session records', () => {
    const record = { schemaVersion: 1, userId: 'u1', sessionId: 's1', title: 'Hello',
      createdAt: rawSummary.createdAt, updatedAt: rawSummary.createdAt,
      lastActivityAt: rawSummary.createdAt, lifecycle: 'active', graphThreadId: 'thread-1',
      execution: { ownerId: null, leaseExpiresAt: null, activeAttemptId: null, generation: 0 },
      latestTurnId: null };
    expect(sessionRecordSchema.safeParse(record).success).toBe(true);
    expect(sessionRecordSchema.parse({ ...record,
      compactionCheckpoint: { ...compaction, summaryId: 'summary-1' } })
      .compactionCheckpoint?.compactedThroughSequence).toBe(4);
    expect(sessionRecordSchema.safeParse({ ...record,
      compactionCheckpoint: { ...compaction, summaryId: 'summary-1', content: 'private' },
    }).success).toBe(false);
  });
});
