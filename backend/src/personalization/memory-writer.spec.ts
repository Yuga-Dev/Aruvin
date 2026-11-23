/**
 * ============================================================================
 * FILE: memory-writer.spec.ts
 * LOCATION: backend/src/personalization/memory-writer.spec.ts
 * PURPOSE: Verify memory synthesis, rejection and usage with offline SSE.
 * ROLE IN PROJECT: Exercises the writer against real policy/parser/accounting.
 * KEY COMPONENTS: Provider frame fixture, payload and terminal evidence assertions.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import { DEFAULT_BUDGETS } from '../contracts/budgets.js';
import type { MetadataRepository, UserMemoryRepository } from '../contracts/repositories.js';
import type { StoredUserMemory } from '../contracts/user-memory.js';
import { MemoryWriterService, type MemoryWriterConfig } from './memory-writer.js';
import { UserMemoryService } from './user-memory.service.js';

const time = '2026-11-20T12:00:00.000Z';
const empty = { identity: '', work: '', preferences: '', ongoing: '', other: '' };
const candidate = { changed: true, changeSummary: 'Saved work', sections: { ...empty, work: ' TS\r\nMongo ' } };
const composer = { source: 'composer', expectedRevision: 0 } as const;
const main: MemoryWriterConfig = {
  settings: { memory: { modelMode: 'main', customModelId: null } },
  memoryModelId: 'fixture/main', budgets: DEFAULT_BUDGETS,
  openRouter: { modelId: 'fixture/main', apiKey: 'fixture-key', reasoningEffort: 'low',
    dataCollection: 'deny', disableTransforms: true },
  modelLimits: { modelId: 'fixture/main', supportsMaxTokens: true,
    outputTokens: 4096, contextTokens: 32_768, source: 'fixture' },
};

function sse(text: string, finish = 'stop', done = true): Response {
  const frames = [
    { id: 'gen-memory', model: 'fixture/reported',
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: 'gen-memory', provider: 'Fixture',
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 80, completion_tokens: 40, cost: 0.001 } },
  ];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
    + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } });
}

function fixture(response: () => Response, config: MemoryWriterConfig = main) {
  const repo = {
    read: vi.fn<UserMemoryRepository['read']>().mockResolvedValue(null),
    createIfAbsent: vi.fn<UserMemoryRepository['createIfAbsent']>(async (userId, settings, updatedAt) =>
      ({ outcome: 'confirmed', record: { ...settings, userId, revision: 1, schemaVersion: 1, updatedAt } })),
    compareAndSwap: vi.fn<UserMemoryRepository['compareAndSwap']>(),
  };
  const fetcher = vi.fn<typeof fetch>(async () => response());
  const putAccounting = vi.fn<MetadataRepository['putAccounting']>().mockResolvedValue(undefined);
  const memory = new UserMemoryService({ repository: () => repo, now: () => new Date(time) });
  const writer = new MemoryWriterService({ memory, fetcher, putAccounting, currentConfig: () => config, now: () => time });
  return { repo, memory, writer, fetcher, putAccounting };
}

it('uses the active verified custom model, private attributed JSON prompt, and standalone usage', async () => {
  const custom: MemoryWriterConfig = { ...main,
    settings: { memory: { modelMode: 'custom', customModelId: 'fixture/custom' } },
    memoryModelId: 'fixture/custom',
    memoryModelLimits: { modelId: 'fixture/custom', supportsMaxTokens: false,
      outputCapParameter: 'max_completion_tokens', outputTokens: 4096, contextTokens: 32_768, source: 'fixture' },
  };
  const f = fixture(() => sse('```json\n' + JSON.stringify(candidate) + '\n```'), custom);
  const result = await f.writer.applyInstruction('alice', 'Remember my stack', composer);
  expect(result).toMatchObject({ changed: true, changeSummary: 'Saved work',
    memory: { revision: 1, sections: { work: 'TS\nMongo' } } });
  expect(f.memory.cachedSnapshot('alice')).toEqual({ revision: 1, content: '- Work: TS\nMongo' });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = f.fetcher.mock.calls[0];
  expect(String(url)).toMatch(/\/chat\/completions$/);
  expect(init?.method).toBe('POST');
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  expect(body).toMatchObject({ model: 'fixture/custom', user: 'alice', stream: true, max_completion_tokens: 1536,
    provider: { require_parameters: true, data_collection: 'deny' },
    messages: [{ role: 'system', content: expect.stringContaining('telegraphic') },
      { role: 'user', content: expect.stringContaining('Remember my stack') }] });
  expect(body).not.toHaveProperty('response_format');
  expect(body).not.toHaveProperty('tools');
  expect(body).not.toHaveProperty('reasoning');
  expect(f.putAccounting).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    purpose: 'memory', userId: 'alice', sessionId: 'memory-composer', turnId: expect.stringMatching(/^memory-/),
    attemptId: expect.stringMatching(/^memory-/), generationId: 'gen-memory', requestedModel: 'fixture/custom',
    reportedModel: 'fixture/reported', reportedProvider: 'Fixture', accountingStatus: 'known', outcome: 'completed',
    promptTokens: 80, completionTokens: 40, cost: 0.001,
  }));
});

it('accounts a passive changed:false once without changing memory, even if sections differ', async () => {
  const f = fixture(() => sse(JSON.stringify({ ...candidate, changed: false })));
  const row: StoredUserMemory = { schemaVersion: 1, userId: 'alice', enabled: true,
    sections: { ...empty, identity: 'Dog: Beans.' }, revision: 3, updatedAt: time };
  f.repo.read.mockResolvedValue(row);
  await f.memory.warm('alice');
  const pin = f.memory.cachedSnapshot('alice');
  await expect(f.writer.synthesize('alice', [{ role: 'user', content: 'Hello' }],
    { sessionId: 'session-1', turnId: 'turn-1' })).resolves.toMatchObject({
    changed: false, changeSummary: '', memory: { revision: 3, sections: row.sections },
  });
  const body = JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)) as Record<string, unknown>;
  expect(body).toMatchObject({ user: 'alice', model: 'fixture/main', max_tokens: 1536 });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.repo.createIfAbsent).not.toHaveBeenCalled();
  expect(f.repo.compareAndSwap).not.toHaveBeenCalled();
  expect(f.memory.cachedSnapshot('alice')).toBe(pin);
  expect(f.putAccounting).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    purpose: 'memory', sessionId: 'session-1', turnId: 'turn-1', outcome: 'completed',
  }));
});

it.each([
  ['secret', 'OPENROUTER_API_KEY=fixture', true],
  ['control character', 'Bad\u000bcharacter', false],
  ['rendered character cap', 'x'.repeat(2500), false],
  ['rendered UTF-8 byte cap', '😀'.repeat(1999), false],
] as const)('rejects invalid generated %s without writing or another POST', async (_label, work, secretRejected) => {
  const f = fixture(() => sse(JSON.stringify({ ...candidate, sections: { ...empty, work } })));
  await expect(f.writer.applyInstruction('alice', 'Remember work', composer))
    .rejects.toMatchObject({ code: 'MEMORY_WRITER_UNAVAILABLE', secretRejected });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.putAccounting).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'failed' }));
  expect(f.repo.createIfAbsent).not.toHaveBeenCalled();
  expect(f.repo.compareAndSwap).not.toHaveBeenCalled();
  expect(f.memory.cachedMemory('alice')).toBeUndefined();
});

it('rejects unsafe or overlong instructions before storage or provider work', async () => {
  const f = fixture(() => sse(JSON.stringify(candidate)));
  const tool = { source: 'tool', sessionId: 'session-1', turnId: 'turn-1' } as const;
  for (const [instruction, secretRejected] of [
    ['sk-or-v1-fixture', true], ['\u0000remember', false], ['x'.repeat(501), false], [' ', false],
  ] as const) {
    await expect(f.writer.applyInstruction('alice', instruction, tool))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', secretRejected });
  }
  expect(f.repo.read).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.putAccounting).not.toHaveBeenCalled();
});

it.each([
  ['provider rejection', () => Response.json({ error: { message: 'private fixture' } }, { status: 503 }), 'failed'],
  ['invalid JSON', () => sse('preface {"changed":false}'), 'failed'],
  ['length with usable-looking JSON', () => sse(JSON.stringify(candidate), 'length'), 'truncated'],
  ['missing stream end', () => sse(JSON.stringify(candidate), 'stop', false), 'interrupted'],
] as const)('rejects %s without a retry, retaining terminal accounting', async (_label, response, outcome) => {
  const f = fixture(response);
  await expect(f.writer.applyInstruction('alice', 'Remember work', composer))
    .rejects.toMatchObject({ code: 'MEMORY_WRITER_UNAVAILABLE' });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.putAccounting).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ purpose: 'memory', outcome }));
  expect(f.repo.createIfAbsent).not.toHaveBeenCalled();
});

it('does not dispatch for missing exact limits, context overflow, or a cancelled caller', async () => {
  const unverified = fixture(() => sse(JSON.stringify(candidate)), { ...main, memoryModelId: 'fixture/off-list' });
  await expect(unverified.writer.applyInstruction('alice', 'Remember work', composer))
    .rejects.toMatchObject({ code: 'MEMORY_WRITER_UNAVAILABLE' });
  expect(unverified.fetcher).not.toHaveBeenCalled();

  const f = fixture(() => sse(JSON.stringify(candidate)));
  await expect(f.writer.synthesize('alice', [{ role: 'user', content: 'x'.repeat(16_384) }],
    { sessionId: 'session-1', turnId: 'turn-1' })).rejects.toMatchObject({ code: 'MEMORY_WRITER_UNAVAILABLE' });
  await expect(f.writer.applyInstruction('alice', 'Remember work', { ...composer, signal: AbortSignal.abort() }))
    .rejects.toMatchObject({ code: 'NOT_READY' });
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.putAccounting).not.toHaveBeenCalled();
});

it('checks paused tool/passive eligibility inside the writer queue', async () => {
  const f = fixture(() => sse(JSON.stringify(candidate)));
  f.repo.read.mockResolvedValue({ schemaVersion: 1, userId: 'alice', enabled: false,
    revision: 1, updatedAt: time, sections: empty });
  const scope = { sessionId: 'session-1', turnId: 'turn-1' };
  await expect(f.writer.applyInstruction('alice', 'Remember work', { source: 'tool', ...scope }))
    .rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
  await expect(f.writer.synthesize('alice', [{ role: 'user', content: 'Hello.' }], scope))
    .rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.putAccounting).not.toHaveBeenCalled();
});

it('accounts a cancelled dispatch without applying its candidate', async () => {
  const controller = new AbortController();
  const f = fixture(() => { controller.abort(); return sse(JSON.stringify(candidate)); });
  await expect(f.writer.applyInstruction('alice', 'Remember work', { ...composer, signal: controller.signal }))
    .rejects.toMatchObject({ code: 'MEMORY_WRITER_UNAVAILABLE' });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.putAccounting).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'cancelled' }));
  expect(f.repo.createIfAbsent).not.toHaveBeenCalled();
});
