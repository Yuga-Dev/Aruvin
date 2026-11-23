/**
 * ============================================================================
 * FILE: compaction-model.spec.ts
 * LOCATION: backend/test/runtime/compaction-model.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify CompactionRunner model dispatch, prompt capacity guards, summary
 *    extraction, and purpose='compaction' accounting persistence.
 *
 * ROLE IN PROJECT:
 *    Exercises the background compaction model wrapper in isolation using a
 *    deterministic OpenRouter fetch double.
 *
 * KEY COMPONENTS:
 *    - Active-fork & custom-model dispatch specs.
 *    - Accounting emission & failure/abort handling specs.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import type { AccountingRecord } from '../../src/contracts/metadata.js';
import { CompactionRunner } from '../../src/model/compaction-runner.js';

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function validRawSummary(): string {
  const sections = COMPACTION_SECTIONS.map((heading, idx) =>
    `## ${idx + 1}. ${heading}\nDetails for ${heading}.`,
  ).join('\n\n');
  return `<analysis>Internal scratchpad note</analysis>\n<summary>\n${sections}\n</summary>`;
}

describe('CompactionRunner', () => {
  it('forks active model with sticky session_id, lifts message limit, strips analysis, and emits compaction accounting', async () => {
    const savedAccounting: AccountingRecord[] = [];
    const seenBodies: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      seenBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([
        {
          id: 'gen-cmp-1',
          model: 'anthropic/claude-sonnet-4',
          provider: 'Anthropic',
          choices: [{ index: 0, delta: { content: validRawSummary() }, finish_reason: null }],
        },
        {
          id: 'gen-cmp-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1400,
            completion_tokens: 220,
            cost: 0.0042,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        },
      ]);
    };

    const runner = new CompactionRunner({
      putAccounting: async (record) => { savedAccounting.push(record); },
      fetcher,
      now: () => '2026-10-06T12:00:00.000Z',
    });

    const delta = Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `Turn message ${i}`,
    }));

    const out = await runner.run({
      userId: 'user-1',
      sessionId: 'sess-1',
      summaryId: 'sum-1',
      compactionCycle: 1,
      turnId: 'turn-2',
      sourceRange: { fromSequence: 0, toSequence: 3, fromEventId: 'ev-0', toEventId: 'ev-3' },
      prefix: [{ role: 'system', content: 'System prefix' }],
      previousSummary: null,
      deltaMessages: delta,
      calendarProvenance: {
        containsCalendarContent: false,
        connectionId: null,
        connectionRevision: null,
        earliestExpiresAt: null,
        redactedAt: null,
      },
      budgets: { ...DEFAULT_BUDGETS, maxMessagesInContext: 4 },
      openRouter: {
        apiKey: 'sk-test-key',
        modelId: 'anthropic/claude-sonnet-4',
        reasoningEffort: 'low',
        dataCollection: 'deny',
        disableTransforms: true,
      },
      modelLimits: {
        modelId: 'anthropic/claude-sonnet-4',
        contextTokens: 200_000,
        outputTokens: 8192,
        supportsMaxTokens: true,
        outputCapParameter: 'max_tokens',
        source: 'catalogue',
        tools: true,
      },
      compaction: {
        enabled: true,
        watermarkRatio: 0.8,
        modelMode: 'active-fork',
        customModelId: null,
      },
      compactionModelLimits: null,
      signal: new AbortController().signal,
    });

    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0].model).toBe('anthropic/claude-sonnet-4');
    expect(seenBodies[0].session_id).toMatch(/^aurvin-[0-9a-f]{64}$/);
    expect(seenBodies[0].cache_control).toEqual({ type: 'ephemeral' });
    expect((seenBodies[0].messages as unknown[]).length).toBeGreaterThan(4);
    expect(out.summary.content).not.toMatch(/<\/?analysis\b/i);
    expect(savedAccounting).toHaveLength(1);
    expect(savedAccounting[0]).toMatchObject({
      purpose: 'compaction',
      userId: 'user-1',
      sessionId: 'sess-1',
      turnId: 'turn-2',
      attemptId: 'compact-sum-1',
      generationId: 'gen-cmp-1',
      accountingStatus: 'known',
      outcome: 'completed',
      promptTokens: 1400,
      completionTokens: 220,
      cachedPromptTokens: 1000,
      cost: 0.0042,
    });
  });

  it('uses customModelId + compactionModelLimits with provider-default reasoning when configured', async () => {
    const savedAccounting: AccountingRecord[] = [];
    const seenBodies: Record<string, unknown>[] = [];
    const runner = new CompactionRunner({
      putAccounting: async (record) => { savedAccounting.push(record); },
      fetcher: async (_url, init) => {
        seenBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sseResponse([
          {
            id: 'gen-cmp-2',
            model: 'openai/gpt-4o-mini',
            choices: [{ index: 0, delta: { content: validRawSummary() }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 500, completion_tokens: 150, cost: 0.001 },
          },
        ]);
      },
      now: () => '2026-10-06T12:00:00.000Z',
    });

    const out = await runner.run({
      userId: 'user-1',
      sessionId: 'sess-1',
      summaryId: 'sum-2',
      compactionCycle: 2,
      turnId: 'turn-4',
      sourceRange: { fromSequence: 0, toSequence: 7, fromEventId: 'ev-0', toEventId: 'ev-7' },
      prefix: [{ role: 'system', content: 'System prefix' }],
      previousSummary: null,
      deltaMessages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }],
      calendarProvenance: {
        containsCalendarContent: false,
        connectionId: null,
        connectionRevision: null,
        earliestExpiresAt: null,
        redactedAt: null,
      },
      budgets: DEFAULT_BUDGETS,
      openRouter: {
        apiKey: 'sk-test-key',
        modelId: 'anthropic/claude-sonnet-4',
        reasoningEffort: 'high',
        dataCollection: 'deny',
        disableTransforms: true,
      },
      modelLimits: {
        modelId: 'anthropic/claude-sonnet-4',
        contextTokens: 200_000,
        outputTokens: 8192,
        supportsMaxTokens: true,
        outputCapParameter: 'max_tokens',
        source: 'catalogue',
        tools: true,
      },
      compaction: {
        enabled: true,
        watermarkRatio: 0.8,
        modelMode: 'custom',
        customModelId: 'openai/gpt-4o-mini',
      },
      compactionModelLimits: {
        modelId: 'openai/gpt-4o-mini',
        contextTokens: 128_000,
        outputTokens: 16_384,
        supportsMaxTokens: true,
        outputCapParameter: 'max_tokens',
        source: 'catalogue',
        tools: false,
      },
      signal: new AbortController().signal,
    });

    expect(seenBodies[0].model).toBe('openai/gpt-4o-mini');
    expect(seenBodies[0].reasoning).toBeUndefined();
    expect(out.summary.modelId).toBe('openai/gpt-4o-mini');
    expect(savedAccounting[0].requestedModel).toBe('openai/gpt-4o-mini');
    expect(savedAccounting[0].purpose).toBe('compaction');
  });

  it('emits failed compaction accounting when provider errors', async () => {
    const savedAccounting: AccountingRecord[] = [];
    const runner = new CompactionRunner({
      putAccounting: async (record) => { savedAccounting.push(record); },
      fetcher: async () => new Response(JSON.stringify({ error: { message: 'Overloaded' } }), { status: 503 }),
      now: () => '2026-10-06T12:00:00.000Z',
    });

    await expect(runner.run({
      userId: 'user-1',
      sessionId: 'sess-1',
      summaryId: 'sum-err',
      compactionCycle: 1,
      turnId: 'turn-1',
      sourceRange: { fromSequence: 0, toSequence: 1, fromEventId: 'ev-0', toEventId: 'ev-1' },
      prefix: [{ role: 'system', content: 'Sys' }],
      previousSummary: null,
      deltaMessages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }],
      calendarProvenance: {
        containsCalendarContent: false,
        connectionId: null,
        connectionRevision: null,
        earliestExpiresAt: null,
        redactedAt: null,
      },
      budgets: DEFAULT_BUDGETS,
      openRouter: {
        apiKey: 'sk-test-key',
        modelId: 'openai/gpt-4o-mini',
        reasoningEffort: 'none',
        dataCollection: 'deny',
        disableTransforms: true,
      },
      modelLimits: {
        modelId: 'openai/gpt-4o-mini',
        contextTokens: 128_000,
        outputTokens: 4096,
        supportsMaxTokens: true,
        outputCapParameter: 'max_tokens',
        source: 'catalogue',
        tools: false,
      },
      compaction: { enabled: true, watermarkRatio: 0.8, modelMode: 'active-fork', customModelId: null },
      compactionModelLimits: null,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });

    expect(savedAccounting).toHaveLength(1);
    expect(savedAccounting[0]).toMatchObject({
      purpose: 'compaction',
      attemptId: 'compact-sum-err',
      outcome: 'failed',
    });
  });
});
