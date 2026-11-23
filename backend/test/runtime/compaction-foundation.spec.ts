/**
 * ============================================================================
 * FILE: compaction-foundation.spec.ts
 * LOCATION: backend/test/runtime/compaction-foundation.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify >128 turn sliding eviction, compaction promotion/pruning, active
 *    turn rebasing, calendar invalidation summary redaction, and finalization.
 *
 * ROLE IN PROJECT:
 *    Guards MemoryFirstFoundation invariants so compaction never hits the old
 *    requests.size permanent lock or leaks compacted/orphaned working state.
 *
 * KEY COMPONENTS:
 *    - 140-turn admission/save sliding eviction test.
 *    - Concurrent tail preservation & orphaned Calendar/Web pruning test.
 *    - Finalization non-null activeSummaryRef compatibility test.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { MemoryFirstFoundation, type SaveEnvelope } from '../../src/chat-runtime/memory-first-foundation.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { checkedResult } from '../../src/chat-runtime/finalization.js';
import { buildReferenceManifest } from '../../src/context/reference-selection.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import type { ActiveSummaryRecord } from '../../src/contracts/agent-memory.js';
import type { MessageRecord } from '../../src/contracts/message.js';
import type { MemoryCalendarState } from '../../src/chat-runtime/memory-calendar-state.js';
import type { MemoryWebRecord } from '../../src/persistence/memory-web-records.js';
import { boundaryFor } from '../../src/agent/state.js';
import { CALENDAR_TOMBSTONE } from '../../src/contracts/calendar-sources.js';
import { hashPayload } from '../../src/platform/crypto/hash-payload.js';
import { eventIdFor, outputId } from '../../src/chat-runtime/identity.js';

const cfg = {
  revision: 'rev-1',
  modelId: 'openai/gpt-4o-mini',
  instructionVersion: 'inst-1',
  knowledgeContentHash: 'know-1',
  graphSchemaVersion: 'graph-1',
};

function makeSummary(overrides: Partial<ActiveSummaryRecord> = {}): ActiveSummaryRecord {
  const sections = COMPACTION_SECTIONS.map((h, i) =>
    `## ${i + 1}. ${h}\n${h === 'Tool & Provenance Status' && overrides.calendarProvenance?.containsCalendarContent
      ? '<calendar_context>Meeting at 3pm.</calendar_context>'
      : 'Summary text.'}`,
  ).join('\n\n');
  return {
    schemaVersion: 1,
    kind: 'memory-summary',
    userId: 'user-1',
    sessionId: 'sess-1',
    summaryId: 'sum-1',
    compactionCycle: 1,
    sourceRange: { fromSequence: 0, toSequence: 5, fromEventId: 'ev-0', toEventId: 'ev-5' },
    content: sections,
    calendarProvenance: {
      containsCalendarContent: false,
      connectionId: null,
      connectionRevision: null,
      earliestExpiresAt: null,
      redactedAt: null,
    },
    modelId: 'openai/gpt-4o-mini',
    tokenEstimate: 64,
    createdAt: '2026-10-06T12:00:00.000Z',
    ...overrides,
    content: overrides.content ?? sections,
  };
}

function calendarBudget(turn: { userId: string; sessionId: string; turnId: string }): MemoryCalendarState {
  return {
    storage: 'volatile',
    budget: {
      schemaVersion: 1,
      kind: 'calendar-turn-budget',
      userId: turn.userId,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      revision: 1,
      modelDispatches: 0,
      repairs: 0,
      logicalTools: 0,
      creates: 0,
      calendarRequests: 0,
      refreshRequests: 0,
      deadlineAt: '2026-10-06T12:05:00.000Z',
      createdAt: '2026-10-06T12:00:00.000Z',
      settledUsd: '0',
      reservedUsd: '0',
    },
    dispatches: [],
    aggregate: null,
    decisions: [],
    rejected: [],
    results: [],
  };
}

describe('MemoryFirstFoundation compaction & eviction', () => {
  it('accepts >128 settled turns via sliding eviction without STORAGE_BUDGET_EXCEEDED', async () => {
    const saved: SaveEnvelope[] = [];
    const foundation = new MemoryFirstFoundation({
      userId: 'user-1',
      epoch: 'epoch-1',
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async (envelope) => {
        saved.push(envelope);
        return {
          kind: 'saved',
          epoch: envelope.epoch,
          sessionId: envelope.sessionId,
          version: envelope.version,
          fence: envelope.fence,
        };
      },
    });

    for (let i = 0; i < 140; i++) {
      const turn = foundation.accept({
        mode: 'text',
        sessionId: 'sess-1',
        content: `Turn ${i}`,
        requestKey: `req-${i}-xxxx`,
        calendarReplyTo: null,
        voice: null,
        config: cfg,
      });
      foundation.complete(turn, {
        status: 'completed',
        content: `Reply ${i}`,
        accounting: null,
        delivery: null,
      });
      await foundation.flushSession('sess-1');
    }

    expect(saved).toHaveLength(140);
    expect(foundation.records('sess-1')).toHaveLength(280);
  });

  it('promotes compaction preserving K+1..latest, prunes orphaned Calendar/Web groups, and redacts summary on disconnect', async () => {
    const saved: SaveEnvelope[] = [];
    const foundation = new MemoryFirstFoundation({
      userId: 'user-1',
      epoch: 'epoch-1',
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async (envelope) => {
        saved.push(envelope);
        return {
          kind: 'saved',
          epoch: envelope.epoch,
          sessionId: envelope.sessionId,
          version: envelope.version,
          fence: envelope.fence,
        };
      },
    });

    const turns = [];
    for (let i = 0; i < 4; i++) {
      const turn = foundation.accept({
        mode: 'text',
        sessionId: 'sess-1',
        content: `Q${i}`,
        requestKey: `req-${i}-xxxx`,
        calendarReplyTo: null,
        voice: null,
        config: cfg,
      });
      turns.push(turn);
      const webRecord = {
        schemaVersion: 1,
        kind: 'memory-web',
        userId: 'user-1',
        sessionId: 'sess-1',
        turnId: turn.turnId,
        attemptId: turn.attemptId,
        groups: [{
          assistant: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `wc-${i}`, type: 'function', function: { name: 'web_tool', arguments: '{"action":"search"}' } }],
          },
          results: [{ role: 'tool', tool_call_id: `wc-${i}`, content: '{"ok":true}' }],
        }],
        state: { sources: [], activities: [] },
      } as unknown as MemoryWebRecord;
      foundation.complete(turn, {
        status: 'completed',
        content: `A${i}`,
        accounting: null,
        delivery: null,
        calendar: calendarBudget(turn),
        web: webRecord,
      });
    }
    await foundation.flushSession('sess-1');

    const baseSections = COMPACTION_SECTIONS.map((h, i) =>
      `## ${i + 1}. ${h}\n${h === 'Tool & Provenance Status' ? '<calendar_context>Meeting at 3pm.</calendar_context>' : 'Overview.'}`,
    ).join('\n\n');
    const summary = makeSummary({
      summaryId: 'sum-cal-1',
      compactionCycle: 1,
      sourceRange: {
        fromSequence: turns[0].sequence,
        toSequence: turns[1].sequence + 1,
        fromEventId: turns[0].inputEventId,
        toEventId: turns[1].outputEventId,
      },
      content: baseSections,
      calendarProvenance: {
        containsCalendarContent: true,
        connectionId: 'conn-1',
        connectionRevision: 2,
        earliestExpiresAt: '2026-10-06T13:00:00.000Z',
        redactedAt: null,
      },
    });

    const promoted = foundation.promoteCompaction(
      'user-1',
      'sess-1',
      summary,
      { compactedThroughSequence: summary.sourceRange.toSequence, compactionCycle: 1 },
    );
    await foundation.flushSession('sess-1');

    expect(promoted.manifest.activeSummaryRef).toEqual({
      summaryId: 'sum-cal-1',
      sourceRange: summary.sourceRange,
    });
    expect(promoted.tailTurnIds).toEqual(new Set([turns[2].turnId, turns[3].turnId]));
    expect(foundation.records('sess-1').map((r) => r.turnId)).toEqual([
      turns[2].turnId,
      turns[2].turnId,
      turns[3].turnId,
      turns[3].turnId,
    ]);
    expect([...foundation.webGroups('sess-1').keys()]).toEqual([turns[2].turnId, turns[3].turnId]);
    expect(saved.at(-1)).toMatchObject({ kind: 'compaction', version: 5, previousVersion: 4 });

    foundation.invalidateCalendarAccount({
      userId: 'user-1',
      connectionId: 'conn-1',
      connectionRevision: 2,
      googleSubjectId: 'subject-1',
    });
    const nextTurn = foundation.accept({
      mode: 'text',
      sessionId: 'sess-1',
      content: 'Follow-up',
      requestKey: 'req-4-xxxx',
      calendarReplyTo: null,
      voice: null,
      config: cfg,
    });
    const ctx = foundation.context(nextTurn);
    expect(ctx.summary?.calendarProvenance.redactedAt).not.toBeNull();
    expect(ctx.summary?.content).toContain(CALENDAR_TOMBSTONE);
  });

  it('rebases active turn during inline burst compaction so complete() uses incremented version', () => {
    const foundation = new MemoryFirstFoundation({
      userId: 'user-1',
      epoch: 'epoch-1',
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async (envelope) => ({
        kind: 'saved',
        epoch: envelope.epoch,
        sessionId: envelope.sessionId,
        version: envelope.version,
        fence: envelope.fence,
      }),
    });
    const t0 = foundation.accept({
      mode: 'text', sessionId: 'sess-1', content: 'U0', requestKey: 'r0-xxxxxx',
      calendarReplyTo: null, voice: null, config: cfg,
    });
    foundation.complete(t0, { status: 'completed', content: 'A0', accounting: null, delivery: null });

    const t1 = foundation.accept({
      mode: 'text', sessionId: 'sess-1', content: 'U1', requestKey: 'r1-xxxxxx',
      calendarReplyTo: null, voice: null, config: cfg,
    });
    const rebased = foundation.rebaseActiveTurnForCompaction(
      t1,
      makeSummary({
        sourceRange: {
          fromSequence: t0.sequence,
          toSequence: t0.sequence + 1,
          fromEventId: t0.inputEventId,
          toEventId: t0.outputEventId,
        },
      }),
      { compactedThroughSequence: t0.sequence + 1, compactionCycle: 1 },
    );

    expect(rebased.turn.contextVersion).toBe(2);
    expect(foundation.find(rebased.turn.sessionId, rebased.turn.requestKey)).toBe(rebased.turn);
    const ctx = foundation.context(rebased.turn);
    expect(ctx.manifest.activeSummaryRef?.summaryId).toBe('sum-1');
    foundation.complete(rebased.turn, { status: 'completed', content: 'A1', accounting: null, delivery: null });
    expect(foundation.result(rebased.turn)?.version).toBe(3);
  });

  it('checkedResult preserves and verifies non-null activeSummaryRef', async () => {
    const summaryRef = {
      summaryId: 'sum-1',
      sourceRange: { fromSequence: 0, toSequence: 1, fromEventId: 'ev-0', toEventId: 'ev-1' },
    };
    const payloadHash = hashPayload('Hi');
    const attempt = {
      schemaVersion: 1 as const, kind: 'attempt' as const,
      userId: 'user-1', sessionId: 'sess-1', turnId: 'turn-2', attemptId: 'att-2',
      idempotencyKey: 'k2-xxxxx', payloadHash, status: 'generating' as const, truncated: false, sequence: 3,
      contextVersion: 2, openRouterUser: 'user-1', modelId: 'openai/gpt-4o-mini',
      instructionVersion: 'inst-1', knowledgeContentHash: 'know-1', graphSchemaVersion: 'graph-1',
      createdAt: '2026-10-06T12:01:00.000Z', updatedAt: '2026-10-06T12:01:00.000Z',
      generationId: null, errorCode: null, causal: { userMessageId: 'm2', previousAttemptId: null },
    };
    const msg2: MessageRecord = {
      schemaVersion: 1, userId: 'user-1', sessionId: 'sess-1', turnId: 'turn-2', attemptId: null,
      messageId: 'm2', eventId: 'ev-2', sequence: 3, role: 'user', content: 'Hi',
      createdAt: '2026-10-06T12:01:00.000Z', completionStatus: 'accepted', truncated: false,
    };
    const assistantId = outputId(attempt);
    const msg3: MessageRecord = {
      schemaVersion: 1, userId: 'user-1', sessionId: 'sess-1', turnId: 'turn-2', attemptId: 'att-2',
      messageId: assistantId, eventId: eventIdFor('user-1', 'sess-1', assistantId), sequence: 4,
      role: 'assistant', content: 'Yo',
      createdAt: '2026-10-06T12:01:01.000Z', completionStatus: 'streaming', truncated: false,
    };
    const assets = {
      instructions: '', knowledge: '', instructionVersion: 'inst-1',
      knowledgeContentHash: 'know-1', graphSchemaVersion: 'graph-1',
    };
    const base = buildReferenceManifest('user-1', 'sess-1', 2, [], assets, DEFAULT_BUDGETS, summaryRef);
    const target = buildReferenceManifest('user-1', 'sess-1', 3, [msg2, { ...msg3, completionStatus: 'completed' }], assets, DEFAULT_BUDGETS, summaryRef);
    const fakePersistence = {
      memory: { get: async () => base, budgets: DEFAULT_BUDGETS },
      messages: { get: async () => msg2, getReferences: async () => [] },
      metadata: { getAcceptance: async () => ({
        schemaVersion: 1, kind: 'acceptance', userId: 'user-1', sessionId: 'sess-1',
        turnId: 'turn-2', attemptId: 'att-2', userMessageId: 'm2', payloadHash,
      }) },
    } as never;

    const checked = await checkedResult(
      fakePersistence,
      attempt,
      {
        input: { attempt, assistantSequence: 4 },
        assistant: msg3,
        accounting: {
          schemaVersion: 1, kind: 'accounting', purpose: 'chat', userId: 'user-1', sessionId: 'sess-1',
          turnId: 'turn-2', attemptId: 'att-2', generationId: null, requestedModel: 'openai/gpt-4o-mini',
          reportedModel: null, reportedProvider: null, promptTokens: null, completionTokens: null,
          cost: null, accountingStatus: 'unknown', outcome: 'completed',
          startedAt: '2026-10-06T12:01:00.000Z', endedAt: null,
        },
        base: boundaryFor(base),
        target,
        outcome: 'completed',
      },
    );
    expect(isDeepStrictEqual(checked.target, target)).toBe(true);
  });
});
