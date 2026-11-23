/**
 * ============================================================================
 * FILE: compaction-runtime.spec.ts
 * LOCATION: backend/test/runtime/compaction-runtime.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify DurableChatRuntime + MemoryText async 80% compaction state
 *    machine, concurrent K+1 preservation with orphan tool pruning, 4-stage
 *    >100% burst fallback, silent Live Voice compaction, and Calendar redaction.
 *
 * ROLE IN PROJECT:
 *    End-to-end runtime verification across P3's orchestration paths.
 *
 * KEY COMPONENTS:
 *    - Async 80% compaction + zero-I/O concurrent turn + orphan pruning test.
 *    - Checkpoint stable prefix, validated Web projection, and rebase/cancel regressions.
 *    - Stage 1 folding -> Stage 3 inline -> Stage 4 floor burst tests.
 *    - Silent Live Voice compaction & AppService Calendar redaction tests.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { DurableChatRuntime } from '../../src/chat-runtime/durable-chat-runtime.js';
import { configurationAdapter } from '../../src/app.service.js';
import { sessionIdFor } from '../../src/chat-runtime/identity.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { ReferencedContextAssembler } from '../../src/context/referenced-context-assembler.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { fixedContextMessages } from '../../src/context/context-budget.js';
import { CALENDAR_TOMBSTONE } from '../../src/contracts/calendar-sources.js';
import type { AccountingRecord } from '../../src/contracts/metadata.js';
import type { ActiveSummaryRecord } from '../../src/contracts/agent-memory.js';
import { initialWebCounters, webLimits, webToolGroupSchema }
  from '../../src/chat-runtime/memory-web-state.js';
import { memoryWebRecordSchema, type MemoryWebRecord } from '../../src/persistence/memory-web-records.js';
import { openRouterSessionId } from '../../src/model/policy.js';
import { loadBootstrapConfig } from '../../src/platform/config/bootstrap-config.js';
import { buildRuntimeSnapshot, defaultManageableSettings } from '../../src/platform/config/manageable-config.js';

type CheckpointWire = {
  messages: { role: string; content: string; tool_calls?: unknown }[];
  session_id?: string;
  tools?: unknown;
  tool_choice?: unknown;
};

const assets = {
  instructions: 'System prompt.',
  knowledge: 'Product knowledge.',
  instructionVersion: 'inst-1',
  knowledgeContentHash: 'know-1',
  graphSchemaVersion: 'graph-1',
};

const identity = { userId: 'user-1', source: 'authenticated-session' as const, openRouterUser: 'user-1' };

function summaryPayload(tag = 'Summary details.'): string {
  return `<analysis>scratch</analysis>\n<summary>\n${COMPACTION_SECTIONS.map((h, i) => `## ${i + 1}. ${h}\n${tag}`).join('\n\n')}\n</summary>`;
}

function sseText(id: string, content: string, promptTokens = 200): Response {
  const frames = [
    { id, model: 'openai/gpt-4o-mini', choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: 40, cost: 0.001 } },
  ];
  return new Response(`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function isCompactionBody(body: { messages?: { content?: string }[] }): boolean {
  return Boolean(body.messages?.at(-1)?.content?.includes('Compact the preceding conversation data'));
}

function createRuntimeHarness(options?: {
  maxHistoryTokens?: number;
  maxContextTokens?: number;
  modelMode?: 'active-fork' | 'custom';
  fetcherImpl?: typeof fetch;
}) {
  const bootstrap = loadBootstrapConfig({ PERSISTENCE_PROFILE: 'native-mongodb', MONGODB_URI: 'fixture-only' });
  const limits = {
    modelId: 'openai/gpt-4o-mini',
    contextTokens: 128_000,
    outputTokens: 4096,
    supportsMaxTokens: true,
    outputCapParameter: 'max_tokens' as const,
    source: 'catalogue' as const,
    tools: true,
  };
  const settings = defaultManageableSettings();
  settings.openRouter.modelId = 'openai/gpt-4o-mini';
  settings.openRouter.reasoningEffort = 'none';
  settings.compaction = {
    enabled: true, watermarkRatio: 0.8,
    modelMode: options?.modelMode ?? 'active-fork',
    customModelId: options?.modelMode === 'custom' ? 'openai/gpt-4o-mini' : null,
  };
  settings.voice.enabledModes = { ...settings.voice.enabledModes, live: true };
  const baseSnapshot = buildRuntimeSnapshot(
    bootstrap,
    { revision: 1, settings, credentials: { openrouter: 'sk-test-key', deepgram: 'dg-test-key' } },
    limits,
  );
  const snapshot = Object.freeze({
    ...baseSnapshot,
    compactionModelLimits: limits,
    budgets: Object.freeze({
      ...baseSnapshot.budgets,
      maxHistoryTokens: Math.max(10_000, options?.maxHistoryTokens ?? 10_000),
      maxContextTokens: options?.maxContextTokens ?? baseSnapshot.budgets.maxContextTokens,
    }),
  });
  const accounting: AccountingRecord[] = [];
  const summaries = new Map<string, ActiveSummaryRecord>();
  const saver = new MemorySaver();
  const dbReads = vi.fn();
  const persistence = {
    owner: {
      executorId: 'exec-1',
      store: null,
      acquire: async () => ({ ok: true, lease: { userId: 'user-1', sessionId: 's', ownerId: 'exec-1', generation: 1, leaseExpiresAt: '2026-10-06T13:00:00.000Z' } }),
      run: async (_l: unknown, fn: () => Promise<unknown>) => fn(),
      release: async () => undefined,
      drain: async () => ({ drained: true, active: 0, unresolvedWrites: 0 }),
    },
    sessions: { get: async () => { dbReads('sessions.get'); return null; } },
    memory: { budgets: snapshot.budgets, get: async () => { dbReads('memory.get'); return null; }, put: async () => undefined },
    messages: {
      budgets: snapshot.budgets,
      getReferences: async () => { dbReads('messages.getReferences'); return []; },
      listForContext: async () => { dbReads('messages.listForContext'); return { items: [], olderAvailable: false, nextCursor: null }; },
    },
    metadata: {
      budgets: snapshot.budgets,
      putAccounting: async (rec: AccountingRecord) => { accounting.push(rec); },
      putCompactionSummary: async (rec: ActiveSummaryRecord) => { summaries.set(rec.summaryId, rec); },
      getCompactionSummary: async (_u: string, _s: string, id: string) => summaries.get(id) ?? null,
      redactCompactionSummary: async () => null,
    },
    calendarProposals: { getCurrentSlot: async () => null },
    checkpoints: { create: async () => ({ bind: () => saver }) },
  } as never;

  const fetcher = options?.fetcherImpl ?? (async (_u, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    return isCompactionBody(body)
      ? sseText('gen-compact', summaryPayload())
      : sseText('gen-chat', 'Assistant reply.');
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
    fetcher,
    now: () => Date.now(),
    memoryFirst: {
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async (e) => ({ kind: 'saved', epoch: e.epoch, sessionId: e.sessionId, version: e.version, fence: e.fence }),
      voice: true,
    },
  });
  return { runtime, accounting, dbReads, snapshot };
}

describe('DurableChatRuntime async compaction & burst fallback', () => {
  it.each(['active-fork', 'custom'] as const)('sends the safe checkpoint prefix in %s mode', async modelMode => {
    const bodies: CheckpointWire[] = [];
    const { runtime, dbReads } = createRuntimeHarness({
      modelMode,
      fetcherImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as CheckpointWire;
        bodies.push(body);
        return isCompactionBody(body) ? sseText('gen-cmp-prefix', summaryPayload('Condensed'))
          : sseText('gen-live-prefix', 'A'.repeat(180));
      },
    });
    let sessionId: string | null = null;
    for (let i = 0; i < 4; i++) {
      const sub = await runtime.submitTurn({
        identity, sessionId, content: `Prefix question ${i}: ${'q'.repeat(2000)}`,
        idempotencyKey: `prefix-${i}`,
      });
      sessionId = sub.sessionId;
      await runtime.executeTurn({
        userId: identity.userId, sessionId, turnId: sub.turnId, attemptId: sub.attemptId,
        signal: new AbortController().signal, emit: async () => undefined,
      });
    }
    await runtime['memoryOwners'].get(identity.userId)!.foundation.flushSession(sessionId!);
    await vi.waitFor(() => expect(bodies.filter(isCompactionBody)).toHaveLength(1));
    const live = bodies.find(body => !isCompactionBody(body))!;
    const checkpoint = bodies.find(isCompactionBody)!;
    const system = fixedContextMessages(assets);
    expect(live.messages.slice(0, 2)).toEqual(system);
    expect(checkpoint.messages.filter(m => m.role === 'system')).toEqual(
      modelMode === 'active-fork' ? live.messages.slice(0, 2) : system.slice(0, 1),
    );
    expect(checkpoint.messages.slice(0, modelMode === 'active-fork' ? 2 : 1)).toEqual(
      modelMode === 'active-fork' ? system : system.slice(0, 1),
    );
    expect(checkpoint.session_id).toBe(openRouterSessionId(identity.userId, sessionId!));
    expect(checkpoint.session_id).toBe(live.session_id);
    expect(checkpoint).not.toHaveProperty('tools');
    expect(checkpoint).not.toHaveProperty('tool_choice');
    expect(dbReads).not.toHaveBeenCalled();
    await runtime.drain(2000);
  });

  it('sends validated folded Web data for checkpointed turns only and excludes private Calendar prose', async () => {
    const bodies: CheckpointWire[] = [];
    const release = Promise.withResolvers<void>();
    const { runtime, snapshot, dbReads } = createRuntimeHarness({
      fetcherImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as CheckpointWire;
        bodies.push(body);
        await release.promise;
        return sseText('gen-selected-web', summaryPayload('Selected evidence'));
      },
    });
    const exactUrl = 'https://example.test/%7Enews?x=A%2Fb';
    const snippet = 'Verified opening detail. ';
    const rawBody = snippet + 'raw-padding-'.repeat(100);
    const privateText = 'PRIVATE_CALENDAR_EVENT_AT_NOON';
    const group = (ordinal: number, url: string, provedUrl: string) => webToolGroupSchema.parse({
      ordinal, afterCalendarGroups: 0,
      assistant: { role: 'assistant', content: null, tool_calls: [{
        id: `web-${ordinal}`, type: 'function',
        function: { name: 'web_tool', arguments: JSON.stringify({ mode: 'fetch', url }) },
      }] },
      result: { role: 'tool', name: 'web_tool', tool_call_id: `web-${ordinal}`,
        content: JSON.stringify({ url, body: rawBody, truncated: false }) },
      sources: [{ sourceId: `source-${ordinal}`, toolCallId: `web-${ordinal}`, url: provedUrl,
        title: `Article ${ordinal}`, kind: 'fetch', provider: 'exa', retrievedAt: '2026-10-06T11:00:00.000Z' }],
    });
    let sessionId: string | null = null;
    for (let i = 0; i < 4; i++) {
      const sub = await runtime.submitTurn({
        identity, sessionId, content: `Selected fixture question ${i}: ${'q'.repeat(1240)}`,
        idempotencyKey: `selected-web-${i}`,
      });
      sessionId = sub.sessionId;
      const memory = runtime['memoryOwners'].get(identity.userId)!;
      const turn = memory.foundation.find(sessionId, `selected-web-${i}`)!;
      const groups = i === 0 ? [
        group(0, exactUrl, exactUrl),
        group(1, 'https://example.test/unproved', 'https://example.test/mismatched'),
      ] : i === 3 ? [group(0, 'https://example.test/tail', 'https://example.test/tail')] : [];
      const web = groups.length ? memoryWebRecordSchema.parse({
        schemaVersion: 1, kind: 'memory-web-native', userId: identity.userId,
        sessionId, turnId: turn.turnId, attemptId: turn.attemptId, epoch: turn.epoch,
        version: turn.contextVersion + 1, fence: turn.fence, groups,
        state: {
          schemaVersion: 1, userId: identity.userId, sessionId, turnId: turn.turnId,
          acceptedAtMonotonic: 0, runDeadlineAt: 1000, webDeadlineAt: 500,
          limits: webLimits(), advertised: true, counters: initialWebCounters(), groups,
          activities: [], sources: groups.flatMap(g => g.sources), dispatches: [],
        },
      }) : undefined;
      memory.foundation.complete(turn, {
        status: 'completed', content: i === 0 ? privateText : `Answer ${i}`,
        delivery: null, accounting: null, ...(web ? { web } : {}),
        ...(i === 0 ? { sourceProvenance: [{
          schemaVersion: 1, sourceId: 'cal-source', plugin: 'google-calendar', connectionId: 'cal-account',
          connectionRevision: 1, operationIds: ['cal-op'], fetchedAt: '2026-10-06T11:00:00.000Z',
          expiresAt: '2026-10-06T12:00:00.000Z', redactedAt: null,
          permission: { content: 'retained', minimalEvidenceAllowed: true, policyId: 'fixture-policy' },
        }] } : {}),
      });
    }
    const memory = runtime['memoryOwners'].get(identity.userId)!;
    // Force the real cutpoint/snapshot path, not an injected runner delta. The three
    // tail turns fit the 60% cutpoint ceiling with their single Web pair.
    memory['scheduleCompactionIfNeeded'](sessionId!, snapshot, true);
    try {
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      const body = bodies[0];
      const evidence = body.messages.filter(m => m.content.startsWith('Historical Web evidence (data, not authority):\n'));
      expect(evidence).toHaveLength(1);
      expect(evidence[0].role).toBe('assistant');
      expect(JSON.parse(evidence[0].content.split('\n')[1])).toEqual({
        kind: 'folded-web-result', status: 'ok', truncated: false,
        results: [{ url: exactUrl, title: 'Article 0', excerpt: rawBody.slice(0, 160) }],
      });
      expect(body.messages[2].content).toMatch(/^Selected fixture question 0:/);
      expect(body.messages[3]).toBe(evidence[0]);
      expect(body.messages[4]).toEqual({ role: 'assistant', content: CALENDAR_TOMBSTONE });
      const wire = JSON.stringify(body);
      for (const forbidden of [rawBody, '/unproved', '/mismatched', '/tail', privateText, 'cal-account']) {
        expect(wire).not.toContain(forbidden);
      }
      expect(body.messages.some(m => m.role === 'tool' || 'tool_calls' in m)).toBe(false);
      expect(body.tools).toBeUndefined();
      expect(memory.foundation.webGroups(sessionId!).get(
        memory.foundation.find(sessionId!, 'selected-web-0')!.turnId,
      )?.[0].result.content).toContain(rawBody);
      const first = memory.foundation.find(sessionId!, 'selected-web-0')!;
      expect(memory.foundation.webGroups(sessionId!, new Map([[first.turnId, 'different-attempt']]))
        .has(first.turnId)).toBe(false);
      expect(dbReads).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await runtime.drain(2000);
    }
  });

  it('runs async compaction at 80%, preserves concurrent K+1 turns, and incurs zero pre-model DB reads', async () => {
    let checkpointBody: CheckpointWire | undefined;
    let releaseCompaction!: () => void;
    let resolveStarted!: () => void;
    const startedSignal = new Promise<void>((r) => { resolveStarted = r; });

    const { runtime, accounting, dbReads } = createRuntimeHarness({
      maxHistoryTokens: 10_000,
      fetcherImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as CheckpointWire;
        if (isCompactionBody(body)) {
          checkpointBody = body;
          resolveStarted();
          await new Promise<void>((r) => { releaseCompaction = r; });
          return sseText('gen-cmp-async', summaryPayload('Async condensed 0..K'));
        }
        return sseText('gen-chat', 'A'.repeat(180));
      },
    });

    let sessionId: string | null = null;
    for (let i = 0; i < 4; i++) {
      const sub = await runtime.submitTurn({
        identity,
        sessionId,
        content: `Question ${i}: ${'x'.repeat(2000)}`,
        idempotencyKey: `k-${i}-xxxx`,
      });
      sessionId = sub.sessionId;
      await runtime.executeTurn({
        userId: 'user-1',
        sessionId,
        turnId: sub.turnId,
        attemptId: sub.attemptId,
        signal: new AbortController().signal,
        emit: async () => undefined,
      });
    }

    await startedSignal;
    const concurrentSub = await runtime.submitTurn({
      identity,
      sessionId,
      content: 'Concurrent turn while compacting',
      idempotencyKey: 'k-concurrent',
    });
    const concurrentEvents: string[] = [];
    await runtime.executeTurn({
      userId: 'user-1',
      sessionId: sessionId!,
      turnId: concurrentSub.turnId,
      attemptId: concurrentSub.attemptId,
      signal: new AbortController().signal,
      emit: async (e) => { concurrentEvents.push((e as { event: { type: string } }).event.type); },
    });

    expect(dbReads).not.toHaveBeenCalled();
    expect(concurrentEvents).toContain('completed');

    expect(checkpointBody).toBeDefined();
    expect(JSON.stringify(checkpointBody)).not.toContain('Concurrent turn while compacting');

    releaseCompaction();
    for (let i = 0; i < 40 && !accounting.some((a) => a.purpose === 'compaction'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await runtime.drain(2000);
    const compactedMsgs = runtime.memoryMessages('user-1', sessionId!, { cursor: null, limit: 50 });
    expect(compactedMsgs?.compaction?.compactionCycle).toBeGreaterThanOrEqual(1);
    expect(compactedMsgs?.items.some((m) => m.content === 'Concurrent turn while compacting')).toBe(true);
    expect(accounting.some((a) => a.purpose === 'compaction')).toBe(true);
  });

  it('resolves Stage 1 web-tool payload bloat by folding without triggering model compaction, and falls back through inline + physical floor', async () => {
    const { runtime, accounting } = createRuntimeHarness({
      maxHistoryTokens: 10_000,
      fetcherImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        return isCompactionBody(body)
          ? sseText('gen-cmp-inline', summaryPayload('Tight'))
          : sseText('gen-chat', 'B'.repeat(80));
      },
    });

    const sub0 = await runtime.submitTurn({
      identity, sessionId: null, content: 'Short question 0', idempotencyKey: 'fold-0-xx',
    });
    const memoryText = runtime['memoryOwners'].get('user-1')!;
    const turn0 = memoryText.foundation.find(sub0.sessionId, 'fold-0-xx')!;
    const bulkyGroup = {
      ordinal: 0,
      afterCalendarGroups: 0,
      assistant: {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'wt-1', type: 'function' as const, function: { name: 'web_tool' as const, arguments: '{"query":"big"}' } }] as const,
      },
      result: { role: 'tool' as const, tool_call_id: 'wt-1', name: 'web_tool' as const, content: JSON.stringify({ snippet: 'W'.repeat(900) }) },
      sources: [],
    };
    const bulkyWeb: MemoryWebRecord = {
      schemaVersion: 1,
      kind: 'memory-web-native',
      userId: 'user-1',
      sessionId: sub0.sessionId,
      turnId: sub0.turnId,
      attemptId: sub0.attemptId,
      epoch: turn0.epoch,
      version: turn0.contextVersion + 1,
      fence: turn0.fence,
      state: {
        schemaVersion: 1, userId: 'user-1', sessionId: sub0.sessionId, turnId: sub0.turnId,
        acceptedAtMonotonic: 0, runDeadlineAt: 1, webDeadlineAt: 1,
        limits: { maxSearchesPerTurn: 1, maxFetchesPerTurn: 1 }, advertised: true,
        counters: { searchesUsed: 1, fetchesUsed: 0, schemaRepairsUsed: 0, modelAttemptsUsed: 1, evidenceBytes: 0 },
        groups: [bulkyGroup], activities: [], sources: [], dispatches: [],
      },
      groups: [bulkyGroup],
    };
    memoryText.foundation.complete(turn0, {
      status: 'completed',
      content: 'Short answer 0',
      accounting: null,
      delivery: null,
      web: bulkyWeb,
    });
    await memoryText.foundation.flushSession(sub0.sessionId);

    const sub1 = await runtime.submitTurn({
      identity, sessionId: sub0.sessionId, content: 'Follow-up after bulky web tool', idempotencyKey: 'fold-1-xx',
    });
    await runtime.executeTurn({
      userId: 'user-1', sessionId: sub0.sessionId, turnId: sub1.turnId, attemptId: sub1.attemptId,
      signal: new AbortController().signal, emit: async () => undefined,
    });
    expect(accounting.some((a) => a.purpose === 'compaction')).toBe(false);

    const sid = sub0.sessionId;
    for (let i = 2; i <= 5; i++) {
      const s = await runtime.submitTurn({
        identity, sessionId: sid, content: `Turn ${i} ${'z'.repeat(2000)}`, idempotencyKey: `burst-${i}-x`,
      });
      await runtime.executeTurn({
        userId: 'user-1', sessionId: sid, turnId: s.turnId, attemptId: s.attemptId,
        signal: new AbortController().signal, emit: async () => undefined,
      });
    }
    for (let i = 0; i < 40 && !accounting.some((a) => a.purpose === 'compaction'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(accounting.some((a) => a.purpose === 'compaction')).toBe(true);

    const floor = createRuntimeHarness({ maxContextTokens: 4096 });
    const huge = await floor.runtime.submitTurn({
      identity, sessionId: null, content: 'h'.repeat(7_000), idempotencyKey: 'burst-floor-x',
    });
    await floor.runtime.executeTurn({
      userId: 'user-1', sessionId: huge.sessionId, turnId: huge.turnId, attemptId: huge.attemptId,
      signal: new AbortController().signal, emit: async () => undefined,
    });
    const status = await floor.runtime.getTurnStatus('user-1', huge.sessionId, huge.turnId);
    expect(status.error?.code).toBe('CONTEXT_BUDGET_EXCEEDED');
  });

  it('compacts silently in Live Voice without emitting context-state or speaking summary text', async () => {
    const { runtime, accounting } = createRuntimeHarness({ maxHistoryTokens: 10_000 });
    const spokenDeltas: string[] = [];
    const wireEvents: string[] = [];
    const seedId = sessionIdFor('user-1', null, 'voice-0-x');
    const reservation = await runtime.reservations.acquire({
      identity, conversationId: seedId, owner: { kind: 'live', voiceSessionId: 'vs-1' },
    });

    let sessionId: string | null = null;
    for (let i = 0; i < 4; i++) {
      const sub = await runtime.submitLiveTurn({
        identity,
        sessionId: sessionId ?? seedId,
        freshConversation: i === 0,
        content: `Voice turn ${i} ${'v'.repeat(2000)}`,
        idempotencyKey: `voice-${i}-x`,
        reservation,
        voice: { voiceSessionId: 'vs-1', socketEpoch: 1, providerTurnId: `pv-${i}` },
      });
      sessionId = sub.sessionId;
      await runtime.executeTurn({
        userId: 'user-1', sessionId, turnId: sub.turnId, attemptId: sub.attemptId,
        signal: new AbortController().signal,
        emit: async (e) => { wireEvents.push((e as { event: { type: string } }).event.type); },
        live: {
          reservation,
          start: async () => undefined,
          delta: async (delta) => { spokenDeltas.push(delta); },
          finish: async () => undefined,
          settle: async () => undefined,
        },
      });
    }
    for (let i = 0; i < 40 && !accounting.some((a) => a.purpose === 'compaction'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await runtime.drain(2000);

    expect(wireEvents).not.toContain('context-state');
    expect(spokenDeltas.join('')).not.toContain('<summary>');
    expect(accounting.some((a) => a.purpose === 'compaction')).toBe(true);
  });

  it('triggers compaction preflight when calendar/voice context exceeds budget after assembler passes, and emits runtime-error on failure', async () => {
    const bootstrap = loadBootstrapConfig({ PERSISTENCE_PROFILE: 'native-mongodb', MONGODB_URI: 'fixture-only' });
    const limits = {
      modelId: 'openai/gpt-4o-mini',
      contextTokens: 128_000,
      outputTokens: 4096,
      supportsMaxTokens: true,
      outputCapParameter: 'max_tokens' as const,
      source: 'catalogue' as const,
      tools: true,
      calendar: {
        tools: true,
        nativeStrict: false,
        parallelToolCallsParameter: false,
        pricing: {
          version: 'fixture-v1',
          source: 'fixture' as const,
          observedAt: '2026-10-06T12:00:00.000Z',
          modelId: 'openai/gpt-4o-mini',
          providerRoute: 'openrouter',
          promptUsdPerToken: '0',
          completionUsdPerToken: '0',
          requestUsd: '0',
        },
      },
    };
    const settings = defaultManageableSettings();
    settings.openRouter.modelId = 'openai/gpt-4o-mini';
    settings.openRouter.reasoningEffort = 'none';
    settings.compaction = { enabled: true, watermarkRatio: 0.8, modelMode: 'active-fork', customModelId: null };
    settings.voice.enabledModes = { ...settings.voice.enabledModes, live: true };
    const baseSnapshot = buildRuntimeSnapshot(
      bootstrap,
      { revision: 1, settings, credentials: { openrouter: 'sk-test-key', deepgram: 'dg-test-key' } },
      limits,
    );
    const snapshot = Object.freeze({
      ...baseSnapshot,
      compactionModelLimits: limits,
      budgets: Object.freeze({
        ...baseSnapshot.budgets,
        maxHistoryTokens: 10_000,
        maxContextTokens: 15_500,
      }),
    });
    const summaries = new Map<string, ActiveSummaryRecord>();
    const accounting: AccountingRecord[] = [];
    const diagnostics: Record<string, unknown>[] = [];
    const saver = new MemorySaver();
    const persistence = {
      owner: {
        executorId: 'exec-1',
        store: null,
        acquire: async () => ({ ok: true, lease: { userId: 'user-1', sessionId: 's', ownerId: 'exec-1', generation: 1, leaseExpiresAt: '2026-10-06T13:00:00.000Z' } }),
        run: async (_l: unknown, fn: () => Promise<unknown>) => fn(),
        release: async () => undefined,
        drain: async () => ({ drained: true, active: 0, unresolvedWrites: 0 }),
      },
      sessions: { get: async () => null },
      memory: { budgets: snapshot.budgets, get: async () => null, put: async () => undefined },
      messages: {
        budgets: snapshot.budgets,
        getReferences: async () => [],
        listForContext: async () => ({ items: [], olderAvailable: false, nextCursor: null }),
      },
      metadata: {
        budgets: snapshot.budgets,
        putAccounting: async (rec: AccountingRecord) => { accounting.push(rec); },
        putCompactionSummary: async (rec: ActiveSummaryRecord) => { summaries.set(rec.summaryId, rec); },
        getCompactionSummary: async (_u: string, _s: string, id: string) => summaries.get(id) ?? null,
        redactCompactionSummary: async () => null,
      },
      calendarProposals: { getCurrentSlot: async () => null },
      checkpoints: { create: async () => ({ bind: () => saver }) },
    } as never;

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
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        return isCompactionBody(body)
          ? sseText('gen-cmp-voice-cal', summaryPayload('Compacted calendar history'))
          : sseText('gen-voice-cal', 'Voice reply after compaction.');
      },
      now: () => Date.now(),
      diagnostics: {
        emit: fields => { diagnostics.push(fields); },
        run: (scope, work) => {
          void scope;
          return work();
        },
      },
      memoryFirst: {
        policy: PROPOSED_MEMORY_TEXT_POLICY,
        save: async (e) => ({ kind: 'saved', epoch: e.epoch, sessionId: e.sessionId, version: e.version, fence: e.fence }),
        voice: true,
      },
    });

    const seedId = sessionIdFor('user-1', null, 'voice-cal-0');
    const reservation = await runtime.reservations.acquire({
      identity, conversationId: seedId, owner: { kind: 'live', voiceSessionId: 'vs-cal-1' },
    });

    // Seed 4 turns (~7200 tokens of text: < 80% watermark of 10,000, so async compaction does not trigger yet).
    for (let i = 0; i < 4; i++) {
      const sub = await runtime.submitLiveTurn({
        identity,
        sessionId: seedId,
        freshConversation: i === 0,
        content: `Turn ${i} ${'a'.repeat(1650)}`,
        idempotencyKey: `voice-cal-${i}`,
        reservation,
        voice: { voiceSessionId: 'vs-cal-1', socketEpoch: 1, providerTurnId: `pvc-${i}` },
      });
      await runtime.executeTurn({
        userId: 'user-1', sessionId: seedId, turnId: sub.turnId, attemptId: sub.attemptId,
        signal: new AbortController().signal, emit: async () => undefined,
        live: {
          reservation,
          start: async () => undefined,
          delta: async () => undefined,
          finish: async () => undefined,
          settle: async () => undefined,
        },
      });
    }
    expect(accounting.some((a) => a.purpose === 'compaction')).toBe(false);

    // Next turn stays under 10,000 in ReferencedContextAssembler (~9800), while calendarContext
    // (with voice Canvas inventory + compacted/system framing) pushes over 10,000 unless compacted.
    const spoken: string[] = [];
    const overflowTurn = await runtime.submitLiveTurn({
      identity,
      sessionId: seedId,
      content: `Turn 4 ${'b'.repeat(2400)}`,
      idempotencyKey: 'voice-cal-4',
      reservation,
      voice: { voiceSessionId: 'vs-cal-1', socketEpoch: 1, providerTurnId: 'pvc-4' },
    });
    const memory = runtime['memoryOwners'].get(identity.userId)!;
    const before = memory.foundation.find(seedId, 'voice-cal-4')!;
    const start = vi.fn(async () => undefined);
    const settle = vi.fn(async () => undefined);
    const events: string[] = [];
    await expect(runtime.executeTurn({
      userId: identity.userId, sessionId: seedId, turnId: overflowTurn.turnId, attemptId: overflowTurn.attemptId,
      signal: new AbortController().signal,
      emit: async ({ event }) => { events.push(event.type); },
      live: {
        reservation, start, settle, delta: async text => { spoken.push(text); },
        finish: async () => undefined,
      },
    })).resolves.toBeUndefined();
    const after = memory.foundation.find(seedId, 'voice-cal-4')!;
    expect(after).not.toBe(before);
    expect(after).toMatchObject({
      turnId: before.turnId, attemptId: before.attemptId, requestKey: before.requestKey,
      contextVersion: before.contextVersion + 1, epoch: before.epoch, fence: before.fence,
    });
    expect(memory.foundation.result(after)).toMatchObject({
      version: after.contextVersion + 1,
      output: { completionStatus: 'completed' },
      delivery: { status: 'unknown', textGenerated: 'Voice reply after compaction.' },
    });
    expect(() => memory.foundation.result(before)).toThrow('Invalid memory turn handle.');
    expect(start).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
    expect(events.filter(event => event === 'completed')).toHaveLength(1);
    expect(events).not.toContain('context-state');
    expect(diagnostics.filter(d => d.stage === 'runtime-error')).toEqual([]);
    expect(spoken.join('')).toBe('Voice reply after compaction.');
    expect(accounting.filter(a => a.purpose === 'compaction')).toHaveLength(1);

    // Also verify runtime-error diagnostic is emitted when a live turn fails pre-output.
    const broken = createRuntimeHarness({ maxContextTokens: 4096 });
    const brokenDiagnostics: Record<string, unknown>[] = [];
    (broken.runtime.d as { diagnostics?: { emit: (f: Record<string, unknown>) => void; run: <T>(s: unknown, w: () => T) => T } }).diagnostics = {
      emit: f => { brokenDiagnostics.push(f); },
      run: (_s, w) => w(),
    };
    const brokenSeed = sessionIdFor('user-1', null, 'broken-live-0');
    const brokenRes = await broken.runtime.reservations.acquire({
      identity, conversationId: brokenSeed, owner: { kind: 'live', voiceSessionId: 'vs-broken' },
    });
    const brokenTurn = await broken.runtime.submitLiveTurn({
      identity, sessionId: brokenSeed, freshConversation: true, content: 'h'.repeat(7_000),
      idempotencyKey: 'broken-live-0', reservation: brokenRes,
      voice: { voiceSessionId: 'vs-broken', socketEpoch: 1, providerTurnId: 'pb-0' },
    });
    await broken.runtime.executeTurn({
      userId: 'user-1', sessionId: brokenSeed, turnId: brokenTurn.turnId, attemptId: brokenTurn.attemptId,
      signal: new AbortController().signal, emit: async () => undefined,
      live: {
        reservation: brokenRes,
        start: async () => undefined,
        delta: async () => undefined,
        finish: async () => undefined,
        settle: async () => undefined,
      },
    });
    expect(brokenDiagnostics).toContainEqual(expect.objectContaining({
      stage: 'runtime-error',
      state: 'error',
      code: 'CONTEXT_BUDGET_EXCEEDED',
      failureKind: 'application',
    }));
  });

  it('settles a cancelled referenced-overflow turn while its background checkpoint is held', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const bodies: CheckpointWire[] = [];
    const { runtime, dbReads } = createRuntimeHarness({
      fetcherImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as CheckpointWire;
        bodies.push(body);
        if (isCompactionBody(body)) {
          started.resolve();
          await release.promise;
          return sseText('gen-held-cmp', summaryPayload('Late checkpoint'));
        }
        return sseText('gen-seed-cmp', 'A'.repeat(180));
      },
    });
    const assembler = vi.spyOn(ReferencedContextAssembler.prototype, 'assemble');
    let execution: Promise<void> | undefined;
    try {
      let sessionId: string | null = null;
      for (let i = 0; i < 4; i++) {
        const seed = await runtime.submitTurn({
          identity, sessionId, idempotencyKey: `cancel-seed-${i}`,
          content: `Seed ${i}: ${'q'.repeat(2000)}`,
        });
        sessionId = seed.sessionId;
        await runtime.executeTurn({
          userId: identity.userId, sessionId, turnId: seed.turnId, attemptId: seed.attemptId,
          signal: new AbortController().signal, emit: async () => undefined,
        });
      }
      await started.promise;
      const sub = await runtime.submitTurn({
        identity, sessionId, idempotencyKey: 'cancel-overflow',
        content: `Overflow ${'z'.repeat(3000)}`,
      });
      const events: string[] = [];
      execution = runtime.executeTurn({
        userId: identity.userId, sessionId: sub.sessionId, turnId: sub.turnId, attemptId: sub.attemptId,
        signal: new AbortController().signal, emit: async ({ event }) => { events.push(event.type); },
      });
      await vi.waitFor(() => expect(assembler).toHaveBeenCalledTimes(5));
      expect(await assembler.mock.results[4].value).toMatchObject({
        ok: false, overflow: { code: 'CONTEXT_BUDGET_EXCEEDED' },
      });
      await runtime.cancelTurn({ identity, sessionId: sub.sessionId, turnId: sub.turnId, attemptId: sub.attemptId });
      await vi.waitFor(() => expect(events).toContain('error'), { timeout: 500 });
      await execution;
      expect(await runtime.getTurnStatus(identity.userId, sub.sessionId, sub.turnId)).toMatchObject({
        status: 'cancelled', attemptId: sub.attemptId, error: { code: 'CANCELLED' },
      });
      expect(events).not.toContain('completed');
      expect(bodies.filter(isCompactionBody)).toHaveLength(1);
      expect(bodies.filter(body => !isCompactionBody(body))).toHaveLength(4);
      expect(dbReads).not.toHaveBeenCalled();
      release.resolve();
      const next = await runtime.submitTurn({
        identity, sessionId, idempotencyKey: 'after-cancelled-overflow', content: 'Still usable',
      });
      expect(next.attemptId).not.toBe(sub.attemptId);
    } finally {
      release.resolve();
      await execution?.catch(() => undefined);
      assembler.mockRestore();
      await runtime.drain(2000);
    }
  });
});
