/**
 * ============================================================================
 * FILE: compaction-records.spec.ts
 * LOCATION: backend/test/persistence/compaction-records.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify compaction summary, manifest, privacy, and accounting persistence.
 *
 * ROLE IN PROJECT:
 *    Exercises real repositories and RecordStore over the existing offline
 *    MongoDB fixture without provider calls or native database prerequisites.
 *
 * KEY COMPONENTS:
 *    - Summary storage: Scoped immutable records and redaction-only CAS.
 *    - Manifest/accounting cases: Bounded tail and independent compaction usage.
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import { activeSummaryRecordSchema } from '../../src/contracts/agent-memory.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { CALENDAR_TOMBSTONE } from '../../src/contracts/calendar-sources.js';
import { accountingRecordSchema } from '../../src/contracts/metadata.js';
import { MongoMemory } from '../../src/persistence/memory.js';
import { MongoMetadata } from '../../src/persistence/metadata.js';
import { key } from '../../src/persistence/records.js';
import { calendarMemory } from './calendar-multi-memory.js';
import { accounting, attempt, manifest } from './fixtures.js';

const createdAt = '2026-11-17T11:00:00.000Z';
const expiresAt = '2026-11-17T12:00:00.000Z';
const sourceRange = { fromSequence: 0, toSequence: 4, fromEventId: 'e0', toEventId: 'e4' };
const summary = () => activeSummaryRecordSchema.parse({
  schemaVersion: 1, kind: 'memory-summary', userId: 'u1', sessionId: 's1',
  summaryId: 'summary-1', compactionCycle: 1, sourceRange,
  content: 'Keep URL https://example.com.\n<calendar_context>Private event at 4pm.</calendar_context>\nNext: confirm.',
  calendarProvenance: { containsCalendarContent: true, connectionId: 'conn-1',
    connectionRevision: 2, earliestExpiresAt: expiresAt, redactedAt: null },
  modelId: 'fixture/model', tokenEstimate: 120, createdAt,
});
const compactedManifest = () => ({
  ...manifest(), activeSummaryRef: { summaryId: 'summary-1', sourceRange },
  messageRefs: [{ messageId: 'm5', eventId: 'e5', sequence: 5 },
    { messageId: 'm6', eventId: 'e6', sequence: 6 }],
  sourceRanges: [{ fromSequence: 5, toSequence: 6, fromEventId: 'e5', toEventId: 'e6' }],
});

describe('compaction persistence primitives', () => {
  it('stores one scoped immutable summary without inventing attempts or collections', async () => {
    const f = calendarMemory();
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS, () => Date.parse(createdAt));
    const value = summary();
    await metadata.putCompactionSummary(value);
    await metadata.putCompactionSummary(value);
    expect(await metadata.getCompactionSummary('u1', 's1', 'summary-1')).toEqual(value);
    expect(await metadata.getCompactionSummary('u2', 's1', 'summary-1')).toBeNull();
    expect(await metadata.getCompactionSummary('u1', 's2', 'summary-1')).toBeNull();
    expect(f.rows('metadata').size).toBe(1);
    expect(f.rows('metadata').get(key('memory-summary', 'u1', 's1', 'summary-1'))?.kind)
      .toBe('memory-summary');
    expect((await metadata.listAttempts('u1', 's1', { cursor: null, limit: 10 })).items).toEqual([]);
    await expect(metadata.putCompactionSummary({ ...value, content: value.content + ' changed' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
  });

  it('enforces runtime UTF-8 content and existing BSON document bounds', async () => {
    const f = calendarMemory();
    const smallMessage = new MongoMetadata(f.store,
      { ...DEFAULT_BUDGETS, maxMessageBytes: 200 }, () => Date.parse(createdAt));
    await expect(smallMessage.putCompactionSummary({
      ...summary(), content: `界${'界'.repeat(70)}\n<calendar_context>secret</calendar_context>`,
    })).rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
    const smallDocument = new MongoMetadata(f.store,
      { ...DEFAULT_BUDGETS, maxDocumentBytes: 512 }, () => Date.parse(createdAt));
    await expect(smallDocument.putCompactionSummary(summary()))
      .rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
    expect(f.rows('metadata').size).toBe(0);
  });

  it('round-trips a summarized tail, then an empty tail with existing version CAS', async () => {
    const f = calendarMemory();
    const memory = new MongoMemory(f.store, DEFAULT_BUDGETS);
    const first = compactedManifest();
    const receipt = await memory.putConfirmed(first);
    expect(await memory.get('u1', 's1')).toEqual(first);
    const next = { ...first, contextVersion: first.contextVersion + 1,
      messageRefs: [], sourceRanges: [] };
    await memory.putConfirmed(next, receipt);
    expect(await memory.get('u1', 's1')).toEqual(next);
    await expect(memory.putConfirmed({ ...first, contextVersion: 99 }))
      .rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
  });

  it('rejects summary overlap, duplicate/unsorted tail refs and wrong tail envelopes', async () => {
    for (const change of [
      { messageRefs: [{ messageId: 'm4', eventId: 'e4', sequence: 4 }] },
      { messageRefs: [{ messageId: 'm5', eventId: 'e5', sequence: 5 },
        { messageId: 'm5', eventId: 'e6', sequence: 6 }] },
      { messageRefs: [...compactedManifest().messageRefs].reverse() },
      { sourceRanges: [] },
      { sourceRanges: [{ fromSequence: 0, toSequence: 6, fromEventId: 'e0', toEventId: 'e6' }] },
      { messageRefs: [], sourceRanges: compactedManifest().sourceRanges },
      { messageRefs: Array.from({ length: 501 }, (_, i) => ({
        messageId: `m${i + 5}`, eventId: `e${i + 5}`, sequence: i + 5,
      })) },
    ]) {
      const f = calendarMemory();
      await expect(new MongoMemory(f.store, DEFAULT_BUDGETS)
        .put({ ...compactedManifest(), ...change })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(f.rows('agent-memory').size).toBe(0);
    }
  });

  it('durably redacts only Calendar content and never lets a stale insert restore it', async () => {
    const f = calendarMemory();
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS, () => Date.parse(createdAt));
    await metadata.putCompactionSummary(summary());
    const at = '2026-11-17T11:30:00.000Z';
    expect(await metadata.redactCompactionSummary('u2', 's1', 'summary-1', at)).toBeNull();
    const redacted = await metadata.redactCompactionSummary('u1', 's1', 'summary-1', at);
    expect(redacted?.content).toContain(CALENDAR_TOMBSTONE);
    expect(redacted?.content).toContain('https://example.com');
    expect(redacted?.content).not.toContain('Private event');
    expect(redacted?.calendarProvenance.redactedAt).toBe(at);
    expect(await metadata.redactCompactionSummary('u1', 's1', 'summary-1', expiresAt)).toEqual(redacted);
    await expect(metadata.putCompactionSummary(summary())).rejects.toThrow();
    expect(await metadata.getCompactionSummary('u1', 's1', 'summary-1')).toEqual(redacted);
    expect(JSON.stringify([...f.rows('metadata').values()])).not.toContain('Private event');
  });

  it('projects exact-expiry redaction on read without a write or an early expiry', async () => {
    const f = calendarMemory();
    let now = Date.parse(expiresAt) - 1;
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS, () => now);
    await metadata.putCompactionSummary(summary());
    expect((await metadata.getCompactionSummary('u1', 's1', 'summary-1'))?.content).toContain('Private event');
    now++;
    const before = f.calls.length;
    const read = await metadata.getCompactionSummary('u1', 's1', 'summary-1');
    expect(read?.content).toContain(CALENDAR_TOMBSTONE);
    expect(read?.content).not.toContain('Private event');
    expect(read?.calendarProvenance.redactedAt).toBe(expiresAt);
    expect(f.calls.slice(before).map(call => call.method)).toEqual(['findOne']);
  });

  it('confirms ambiguous redaction writes and fails closed on a CAS conflict', async () => {
    const f = calendarMemory();
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS, () => Date.parse(createdAt));
    await metadata.putCompactionSummary(summary());
    f.failNext('cas-mismatch', { collection: 'metadata', method: 'replaceOne' });
    await expect(metadata.redactCompactionSummary('u1', 's1', 'summary-1', expiresAt))
      .rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
    f.failNext('after-write', { collection: 'metadata', method: 'replaceOne' });
    expect((await metadata.redactCompactionSummary('u1', 's1', 'summary-1', expiresAt))
      ?.content).toContain(CALENDAR_TOMBSTONE);
  });
});

describe('compaction accounting purpose', () => {
  it('parses optional legacy/chat/compaction purpose and rejects other values', () => {
    const value = accounting();
    expect(accountingRecordSchema.parse(value)).not.toHaveProperty('purpose');
    for (const purpose of ['chat', 'compaction']) {
      expect(accountingRecordSchema.parse({ ...value, purpose }).purpose).toBe(purpose);
    }
    expect(accountingRecordSchema.safeParse({ ...value, purpose: 'summary' }).success).toBe(false);
  });

  it('stores attributed compaction usage without a chat attempt or attempt lookup', async () => {
    const f = calendarMemory();
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS);
    const value = { ...accounting(), purpose: 'compaction' as const, turnId: 'compaction-cycle-1',
      attemptId: 'compaction-attempt-1', outcome: 'completed' as const,
      promptTokens: 8000, completionTokens: 400, cost: 0.01,
      accountingStatus: 'known' as const, endedAt: createdAt };
    await metadata.putAccounting(value);
    await metadata.putAccounting(value);
    expect(await metadata.getAccounting('u1', 's1', value.attemptId)).toEqual(value);
    expect(f.calls.some(call => call.method === 'findOne' && call.filter.kind === 'attempt')).toBe(false);
    expect([...f.rows('metadata').values()].filter(row => row.kind === 'attempt')).toHaveLength(0);
    expect([...f.rows('metadata').values()].filter(row => row.kind === 'accounting')).toHaveLength(1);
    await expect(metadata.putAccounting({ ...value, cost: 0.02 })).rejects.toThrow();
    await expect(metadata.putAccounting({ ...value, promptTokens: null })).rejects.toThrow();
  });

  it('still requires matching attempts for both legacy and explicit chat accounting', async () => {
    const f = calendarMemory();
    const metadata = new MongoMetadata(f.store, DEFAULT_BUDGETS);
    await expect(metadata.putAccounting(accounting()))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(metadata.putAccounting({ ...accounting(), purpose: 'chat' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await metadata.putAttempt(attempt());
    await metadata.putAccounting(accounting());
    await metadata.putAccounting({ ...accounting(), purpose: 'chat' });
    expect((await metadata.getAccounting('u1', 's1', 'a1'))?.purpose).toBe('chat');
    await expect(metadata.putAccounting({ ...accounting(), purpose: 'compaction' }))
      .rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
  });
});
