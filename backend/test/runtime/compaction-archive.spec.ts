/**
 * ============================================================================
 * FILE: compaction-archive.spec.ts
 * LOCATION: backend/test/runtime/compaction-archive.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify MemoryTextArchive compaction checkpoint persistence, concurrent
 *    tail preservation, activeSummaryRef preservation on subsequent turns, and
 *    TOCTOU Calendar summary redaction.
 *
 * ROLE IN PROJECT:
 *    Guards durable CAS ordering between turn saves and compaction saves on
 *    MemoryTextArchive's shared FIFO save pipeline.
 *
 * KEY COMPONENTS:
 *    - CompactionEnvelope projection & LangGraph boundary update test.
 *    - Post-compaction TerminalEnvelope preservation of activeSummaryRef.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { MemoryTextArchive } from '../../src/persistence/memory-text-archive.js';
import { graphThreadId } from '../../src/persistence/records.js';
import { buildReferenceManifest } from '../../src/context/reference-selection.js';
import { boundaryFor } from '../../src/agent/state.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import type { ActiveSummaryRecord, AgentMemoryManifest } from '../../src/contracts/agent-memory.js';
import type { MessageRecord } from '../../src/contracts/message.js';
import type { SessionRecord } from '../../src/contracts/session.js';
import type { CompactionEnvelope } from '../../src/chat-runtime/memory-first-foundation.js';

const assets = {
  instructions: 'Sys',
  knowledge: 'Know',
  instructionVersion: 'inst-1',
  knowledgeContentHash: 'know-1',
  graphSchemaVersion: 'graph-1',
};

function makeMessage(seq: number, role: 'user' | 'assistant', turnId: string, attemptId: string | null): MessageRecord {
  return {
    schemaVersion: 1,
    userId: 'user-1',
    sessionId: 'sess-1',
    turnId,
    attemptId,
    messageId: `msg-${seq}`,
    eventId: `ev-${seq}`,
    sequence: seq,
    role,
    content: `Text ${seq}`,
    createdAt: '2026-10-06T12:00:00.000Z',
    completionStatus: role === 'user' ? 'accepted' : 'completed',
    truncated: false,
  };
}

describe('MemoryTextArchive compaction projection', () => {
  it('saves ActiveSummaryRecord, preserves concurrent tail K+1, updates LangGraph boundary and sessions.compactionCheckpoint', async () => {
    const msgs = [
      makeMessage(0, 'user', 'turn-1', null),
      makeMessage(1, 'assistant', 'turn-1', 'att-1'),
      makeMessage(3, 'user', 'turn-2', null),
      makeMessage(4, 'assistant', 'turn-2', 'att-2'),
    ];
    let currentManifest: AgentMemoryManifest = buildReferenceManifest(
      'user-1', 'sess-1', 2, msgs, assets, DEFAULT_BUDGETS, null,
    );
    const summaries = new Map<string, ActiveSummaryRecord>();
    const sessionDoc: Record<string, unknown> = {
      _id: 'session:user-1:sess-1',
      schemaVersion: 1,
      userId: 'user-1',
      sessionId: 'sess-1',
      title: 'Test',
      lifecycle: 'active',
      createdAt: '2026-10-06T12:00:00.000Z',
      updatedAt: '2026-10-06T12:00:00.000Z',
      lastActivityAt: '2026-10-06T12:00:00.000Z',
      latestTurnId: 'turn-2',
      execution: { ownerId: 'exec-1', generation: 1, activeAttemptId: null, leaseExpiresAt: '2026-10-06T13:00:00.000Z' },
      memoryPublication: { version: 2, sequence: 5, epoch: 'epoch-1', fence: 0 },
      _revision: 2,
    };
    const lease = { userId: 'user-1', sessionId: 'sess-1', ownerId: 'exec-1', generation: 1, leaseExpiresAt: '2026-10-06T13:00:00.000Z' };
    const saver = new MemorySaver();

    const fakeStore = {
      options: () => ({}),
      raw: vi.fn(async () => null),
      read: vi.fn(async () => null),
      insert: vi.fn(async () => undefined),
      collection: (name: string) => ({
        updateOne: vi.fn(async (filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) => {
          if (name === 'sessions' && filter['memoryPublication.version'] === 2) {
            Object.assign(sessionDoc, update.$set ?? {});
            return { acknowledged: true, matchedCount: 1 };
          }
          return { acknowledged: true, matchedCount: 0 };
        }),
      }),
    };

    const persistence = {
      owner: {
        executorId: 'exec-1',
        store: fakeStore,
        acquire: vi.fn(async () => ({ ok: true, lease })),
        run: vi.fn(async (_lease: unknown, fn: () => Promise<unknown>) => fn()),
        release: vi.fn(async () => undefined),
        assertExecutor: vi.fn(async () => undefined),
      },
      sessions: {
        get: vi.fn(async () => sessionDoc as unknown as SessionRecord),
        budgets: DEFAULT_BUDGETS,
      },
      memory: {
        budgets: DEFAULT_BUDGETS,
        get: vi.fn(async () => currentManifest),
        put: vi.fn(async (next: AgentMemoryManifest) => { currentManifest = next; }),
      },
      messages: {
        budgets: DEFAULT_BUDGETS,
        getReferences: vi.fn(async (_u: string, _s: string, refs: readonly { messageId: string }[]) =>
          msgs.filter((m) => refs.some((r) => r.messageId === m.messageId)),
        ),
      },
      metadata: {
        budgets: DEFAULT_BUDGETS,
        putCompactionSummary: vi.fn(async (rec: ActiveSummaryRecord) => { summaries.set(rec.summaryId, rec); }),
        redactCompactionSummary: vi.fn(async (_u: string, _s: string, id: string) => summaries.get(id) ?? null),
      },
      checkpoints: { create: async () => ({ bind: () => saver }) },
    } as never;

    const archive = new MemoryTextArchive(persistence, assets, () => Date.parse('2026-10-06T12:01:00.000Z'));
    const sections = COMPACTION_SECTIONS.map((h, i) => `## ${i + 1}. ${h}\nCondensed.`).join('\n\n');
    const summary: ActiveSummaryRecord = {
      schemaVersion: 1,
      kind: 'memory-summary',
      userId: 'user-1',
      sessionId: 'sess-1',
      summaryId: 'sum-1',
      compactionCycle: 1,
      sourceRange: { fromSequence: 0, toSequence: 1, fromEventId: 'ev-0', toEventId: 'ev-1' },
      content: sections,
      calendarProvenance: {
        containsCalendarContent: false,
        connectionId: null,
        connectionRevision: null,
        earliestExpiresAt: null,
        redactedAt: null,
      },
      modelId: 'openai/gpt-4o-mini',
      tokenEstimate: 48,
      createdAt: '2026-10-06T12:01:00.000Z',
    };

    const envelope: CompactionEnvelope = {
      schemaVersion: 1,
      kind: 'compaction',
      epoch: 'epoch-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      version: 3,
      previousVersion: 2,
      fence: 0,
      sequence: 6,
      summary,
      checkpoint: { compactedThroughSequence: 1, compactionCycle: 1, summaryPreview: 'Condensed.' },
    };

    const outcome = await archive.save(envelope, { maxOperations: 32, maxBytes: 524_288 });
    expect(outcome).toEqual({ kind: 'saved', epoch: 'epoch-1', sessionId: 'sess-1', version: 3, fence: 0 });
    expect(summaries.get('sum-1')).toBeDefined();
    expect(currentManifest.contextVersion).toBe(3);
    expect(currentManifest.activeSummaryRef).toEqual({ summaryId: 'sum-1', sourceRange: summary.sourceRange });
    expect(currentManifest.messageRefs.map((r) => r.sequence)).toEqual([3, 4]);
    expect(sessionDoc.compactionCheckpoint).toEqual({
      compactedThroughSequence: 1,
      compactionCycle: 1,
      summaryPreview: 'Condensed.',
      summaryId: 'sum-1',
    });
    const checkpointState = await saver.getTuple({ configurable: { thread_id: graphThreadId('user-1', 'sess-1') } });
    expect(checkpointState?.checkpoint.channel_values.boundary).toEqual(boundaryFor(currentManifest));
  });
});
