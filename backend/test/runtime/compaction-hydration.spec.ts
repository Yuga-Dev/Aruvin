/**
 * ============================================================================
 * FILE: compaction-hydration.spec.ts
 * LOCATION: backend/test/runtime/compaction-hydration.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify O(tail) hydration for calendarHistory and MemoryText.hydrate, plus
 *    zero-I/O tail message listing with DB scrollback past compaction cutpoint.
 *
 * ROLE IN PROJECT:
 *    Ensures sessions with >128 turns cold-start and page without full-session
 *    archive or attempt scans.
 *
 * KEY COMPONENTS:
 *    - calendarHistory lower-bound attempt paging test.
 *    - MemoryText.hydrate 200-turn tail-only load via DurableChatRuntime,
 *      plus bounded pre-compaction Canvas walk reads.
 *    - ChatHttpService.messages scrollback fallback test.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { calendarHistory } from '../../src/chat-runtime/calendar-history.js';
import { DurableChatRuntime } from '../../src/chat-runtime/durable-chat-runtime.js';
import { ChatHttpService } from '../../src/http/chat-http.service.js';
import { configurationAdapter } from '../../src/app.service.js';
import { ReferencedContextAssembler } from '../../src/context/referenced-context-assembler.js';
import { buildReferenceManifest } from '../../src/context/reference-selection.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { boundaryFor } from '../../src/agent/state.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import type { ActiveSummaryRecord } from '../../src/contracts/agent-memory.js';
import type { AttemptRecord } from '../../src/contracts/attempt.js';
import type { MessageRecord } from '../../src/contracts/message.js';
import type { SessionRecord } from '../../src/contracts/session.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { loadBootstrapConfig } from '../../src/platform/config/bootstrap-config.js';
import { buildRuntimeSnapshot, defaultManageableSettings } from '../../src/platform/config/manageable-config.js';
import { cursor } from '../../src/persistence/pagination.js';
import { graphThreadId } from '../../src/persistence/records.js';

const assets = {
  instructions: 'Sys',
  knowledge: 'Know',
  instructionVersion: 'inst-1',
  knowledgeContentHash: 'know-1',
  graphSchemaVersion: 'graph-1',
};

function makeMsg(seq: number, turnIdx: number): MessageRecord {
  return {
    schemaVersion: 1,
    userId: 'user-1',
    sessionId: 'sess-200',
    turnId: `turn-${turnIdx}`,
    attemptId: seq % 2 === 0 ? null : `att-${turnIdx}`,
    messageId: `msg-${seq}`,
    eventId: `ev-${seq}`,
    sequence: seq,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${seq}`,
    createdAt: '2026-10-06T12:00:00.000Z',
    completionStatus: seq % 2 === 0 ? 'accepted' : 'completed',
    truncated: false,
  };
}

function makeAttempt(idx: number): AttemptRecord {
  return {
    schemaVersion: 1,
    userId: 'user-1',
    sessionId: 'sess-200',
    turnId: `turn-${idx}`,
    attemptId: `att-${idx}`,
    idempotencyKey: `key-${idx}-xx`,
    status: 'completed',
    truncated: false,
    sequence: idx * 3,
    contextVersion: idx + 1,
    openRouterUser: 'user-1',
    modelId: 'openai/gpt-4o-mini',
    instructionVersion: 'inst-1',
    knowledgeContentHash: 'know-1',
    graphSchemaVersion: 'graph-1',
    createdAt: '2026-10-06T12:00:00.000Z',
    updatedAt: '2026-10-06T12:00:01.000Z',
    generationId: `gen-${idx}`,
    errorCode: null,
  } as AttemptRecord;
}

describe('O(tail) hydration & scrollback', () => {
  it('bounds calendarHistory listAttempts calls when records only contain tail sequences', async () => {
    const allAttempts = Array.from({ length: 300 }, (_, i) => makeAttempt(299 - i));
    const listAttempts = vi.fn(async (_u: string, _s: string, q: { cursor: string | null; limit: number }) => {
      const start = q.cursor ? Number(q.cursor) : 0;
      const items = allAttempts.slice(start, start + 50);
      return { items, nextCursor: start + 50 < allAttempts.length ? String(start + 50) : null };
    });
    const fakePersistence = {
      metadata: {
        budgets: DEFAULT_BUDGETS,
        listAttempts,
        getCalendarStates: vi.fn(async () => []),
      },
      owner: { store: null },
      calendarAccountingV2: { listDispatches: vi.fn(async () => []) },
      calendarOperations: null,
      calendarOperationsV2: null,
      calendarSources: null,
      skillDecisions: null,
      calendarProposals: { getCurrentSlot: async () => null },
      sessions: { get: async () => ({
        userId: 'user-1', sessionId: 'sess-200', lifecycle: 'active',
        memoryPublication: { version: 1, sequence: 900, epoch: 'e', fence: 0 },
      }) },
    } as never;

    const tailRecords = [makeMsg(894, 298), makeMsg(895, 298), makeMsg(897, 299), makeMsg(898, 299)];
    const result = await calendarHistory(fakePersistence, 'user-1', 'sess-200', tailRecords);
    expect(result.size).toBe(0);
    expect(listAttempts).toHaveBeenCalledTimes(1);
  });

  it('hydrates a 200-turn compacted session in O(tail) and delegates older UI scrollback to listPublished', async () => {
    const allAttempts = Array.from({ length: 200 }, (_, i) => makeAttempt(199 - i));
    const allMessages = Array.from({ length: 400 }, (_, i) => {
      const turnIdx = Math.floor(i / 2);
      return makeMsg(turnIdx * 3 + (i % 2), turnIdx);
    });
    const tailMessages = allMessages.slice(-4);
    const summaryRange = {
      fromSequence: allMessages[0].sequence,
      toSequence: allMessages[395].sequence,
      fromEventId: allMessages[0].eventId,
      toEventId: allMessages[395].eventId,
    };
    const summary: ActiveSummaryRecord = {
      schemaVersion: 1,
      kind: 'memory-summary',
      userId: 'user-1',
      sessionId: 'sess-200',
      summaryId: 'sum-200',
      compactionCycle: 4,
      sourceRange: summaryRange,
      content: COMPACTION_SECTIONS.map((h, i) => `## ${i + 1}. ${h}\nCondensed 198 turns.`).join('\n\n'),
      calendarProvenance: {
        containsCalendarContent: false,
        connectionId: null,
        connectionRevision: null,
        earliestExpiresAt: null,
        redactedAt: null,
      },
      modelId: 'openai/gpt-4o-mini',
      tokenEstimate: 90,
      createdAt: '2026-10-06T12:00:00.000Z',
    };
    const manifest = buildReferenceManifest(
      'user-1', 'sess-200', 204, tailMessages, assets, DEFAULT_BUDGETS,
      { summaryId: 'sum-200', sourceRange: summaryRange },
    );
    const saver = new MemorySaver();
    await saver.put(
      { configurable: { thread_id: graphThreadId('user-1', 'sess-200'), checkpoint_ns: '' } },
      {
        v: 1,
        id: 'cp-204',
        ts: '2026-10-06T12:00:00.000Z',
        channel_values: { boundary: boundaryFor(manifest) },
        channel_versions: {},
        versions_seen: {},
      },
      { source: 'update', step: 1, parents: {} },
    );

    const listAttempts = vi.fn(async (_u: string, _s: string, q: { cursor: string | null }) => {
      const start = q.cursor ? Number(q.cursor) : 0;
      const items = allAttempts.slice(start, start + 50);
      return { items, nextCursor: start + 50 < allAttempts.length ? String(start + 50) : null };
    });
    const listForContext = vi.fn(async () => ({
      items: [allMessages.at(-1)!],
      olderAvailable: true,
      nextCursor: 'more-cursor',
    }));
    const listPublished = vi.fn(async () => ({
      items: allMessages.slice(346, 396).map((m) => ({
        messageId: m.messageId,
        turnId: m.turnId,
        eventId: m.eventId,
        sequence: m.sequence,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        completionStatus: m.completionStatus,
        truncated: false,
      })),
      olderAvailable: true,
      nextCursor: 'older-cursor',
    }));
    const sessionRecord: SessionRecord = {
      schemaVersion: 1,
      userId: 'user-1',
      sessionId: 'sess-200',
      title: 'Long Chat',
      lifecycle: 'active',
      createdAt: '2026-10-06T10:00:00.000Z',
      updatedAt: '2026-10-06T12:00:00.000Z',
      lastActivityAt: '2026-10-06T12:00:00.000Z',
      latestTurnId: 'turn-199',
      execution: { ownerId: null, generation: 1, activeAttemptId: null, leaseExpiresAt: null },
      memoryPublication: { version: 204, sequence: 600, epoch: 'epoch-1', fence: 0 },
      compactionCheckpoint: {
        compactedThroughSequence: summaryRange.toSequence,
        compactionCycle: 4,
        summaryPreview: 'Condensed 198 turns.',
        summaryId: 'sum-200',
      },
    } as SessionRecord;
    const persistence = {
      owner: { executorId: 'exec-1', store: null, drain: vi.fn(async () => ({ drained: true, active: 0, unresolvedWrites: 0 })) },
      sessions: { get: vi.fn(async () => sessionRecord), update: vi.fn(), delete: vi.fn(), list: vi.fn() },
      memory: { budgets: DEFAULT_BUDGETS, get: vi.fn(async () => manifest) },
      messages: {
        budgets: DEFAULT_BUDGETS,
        getReferences: vi.fn(async () => tailMessages),
        listForContext,
        listPublished,
      },
      metadata: {
        budgets: DEFAULT_BUDGETS,
        listAttempts,
        getCompactionSummary: vi.fn(async () => summary),
        getVoiceDeliveries: vi.fn(async () => []),
        putAccounting: vi.fn(async () => undefined),
      },
      calendarAccountingV2: { listDispatches: vi.fn(async () => []) },
      calendarProposals: { getCurrentSlot: async () => null },
      checkpoints: { create: async () => ({ bind: () => saver }) },
    } as never;

    const bootstrap = loadBootstrapConfig({ PERSISTENCE_PROFILE: 'native-mongodb', MONGODB_URI: 'fixture-only' });
    const limits = { modelId: 'openai/gpt-4o-mini', contextTokens: 128_000, outputTokens: 4096, supportsMaxTokens: true, source: 'catalogue' as const, tools: false };
    const settings = defaultManageableSettings();
    settings.openRouter.modelId = 'openai/gpt-4o-mini';
    settings.openRouter.reasoningEffort = 'none';
    settings.chat.maxHistoryTokens = 10_000;
    settings.compaction = { enabled: true, watermarkRatio: 0.8, modelMode: 'active-fork', customModelId: null };
    const snapshot = Object.freeze({
      ...buildRuntimeSnapshot(
        bootstrap,
        { revision: 1, settings, credentials: { openrouter: 'sk-test', deepgram: null } },
        limits,
      ),
      compactionModelLimits: limits,
    });

    const runtime = new DurableChatRuntime({
      config: configurationAdapter(bootstrap, snapshot),
      persistence,
      assembler: new ReferencedContextAssembler({
        memory: (persistence as { memory: unknown }).memory as never,
        messages: (persistence as { messages: unknown }).messages as never,
        metadata: (persistence as { metadata: unknown }).metadata as never,
        assets,
        budgets: snapshot.budgets,
      }),
      assets,
      limits,
      currentConfig: { current: () => snapshot, revision: () => snapshot.revision },
      fetcher: async () => new Response(),
      now: () => Date.parse('2026-10-06T12:01:00.000Z'),
      memoryFirst: {
        policy: PROPOSED_MEMORY_TEXT_POLICY,
        save: async (e) => ({ kind: 'saved', epoch: e.epoch, sessionId: e.sessionId, version: e.version, fence: e.fence }),
        voice: false,
      },
    });

    await runtime.prepareSession('user-1', 'sess-200');
    // One O(tail) latest read plus two bounded pre-compaction Canvas walk
    // reads starting from the oldest loaded tail cursor; the fixture repeats
    // its cursor and the walk stops before looping.
    expect(listForContext).toHaveBeenCalledTimes(3);
    expect(listForContext).toHaveBeenNthCalledWith(1, 'user-1', 'sess-200', { cursor: null, limit: 1 });
    expect(listForContext).toHaveBeenNthCalledWith(2, 'user-1', 'sess-200', {
      cursor: cursor({
        kind: 'messages',
        userId: 'user-1',
        sessionId: 'sess-200',
        value: tailMessages[0].sequence,
        id: tailMessages[0].messageId,
      }),
      limit: DEFAULT_BUDGETS.maxPageSize,
    });
    expect(listForContext).toHaveBeenNthCalledWith(3, 'user-1', 'sess-200', {
      cursor: 'more-cursor',
      limit: DEFAULT_BUDGETS.maxPageSize,
    });
    expect(listAttempts).toHaveBeenCalledTimes(2);

    const page1 = runtime.memoryMessages('user-1', 'sess-200', { cursor: null, limit: 50 });
    expect(page1).not.toBeNull();
    expect(page1!.items).toHaveLength(4);
    expect(page1!.olderAvailable).toBe(true);
    expect(page1!.nextCursor).toEqual(expect.any(String));
    expect(page1!.compaction).toEqual({
      compactedThroughSequence: summaryRange.toSequence,
      compactionCycle: 4,
      summaryPreview: 'Condensed 198 turns.',
    });
    expect(page1!.contextUsage?.maxHistoryTokens).toBe(10_000);
    expect(listPublished).not.toHaveBeenCalled();

    expect(runtime.memoryMessages('user-1', 'sess-200', { cursor: page1!.nextCursor!, limit: 50 })).toBeNull();

    const http = new ChatHttpService({
      identity: { resolve: () => ({ userId: 'user-1', source: 'local-default' }), assertNoClientOverrides: () => undefined } as never,
      sessions: (persistence as { sessions: unknown }).sessions as never,
      messages: (persistence as { messages: unknown }).messages as never,
      budgets: DEFAULT_BUDGETS,
      runtime,
    });
    const olderPage = await http.messages('sess-200', { cursor: page1!.nextCursor! });
    expect(listPublished).toHaveBeenCalledTimes(1);
    expect(olderPage.items).toHaveLength(50);
    expect(olderPage.compaction?.compactionCycle).toBe(4);
  });
});
