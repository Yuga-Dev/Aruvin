/**
 * ============================================================================
 * FILE: memory-web-records.spec.ts
 * LOCATION: backend/test/persistence/memory-web-records.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove bounded web evidence survives the existing terminal save and reload.
 *
 * ROLE IN PROJECT:
 *    Exercises the real MemoryText archive over isolated in-memory storage:
 *    one metadata record restores linked sources/activities during hydration
 *    without a model, provider, or inference call.
 *
 * KEY COMPONENTS:
 *    - archiveFixture: Real persistence, memory-first runtime, web port double.
 *    - archive/reload case: Record bounds, linkage, and zero model replay.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { textConfigFixture } from '../runtime/text-config-fixture.js';
import { calendarMemory } from './calendar-multi-memory.js';
import {
  sse, textFrame, webPortFixture, webToolFrame,
} from '../runtime/web-search-fixture.js';

async function archiveFixture() {
  const memory = calendarMemory();
  const client = Object.assign(memory.commandSource, {
    db: () => memory.store.db, appendMetadata: () => undefined,
  }) as unknown as MongoClient;
  const persistence = await createPersistenceBundle(
    client, 'memory-web-records-test', DEFAULT_BUDGETS, 'memory-web-records-executor',
  );  const web = webPortFixture();
  const base = textSnapshot(1);
  const snapshot = { ...base, modelLimits: { ...base.modelLimits!, tools: true } };
  const f = textConfigFixture(snapshot, dependencies => ({
    ...dependencies, webSearch: web.port,
    memoryFirst: { policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 50 } },
  }), persistence);
  return { f, web, memory };
}

it('archives one bounded web record and restores linked evidence without inference', async () => {
  const { f, web, memory } = await archiveFixture();
  try {
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'web_1')))
      .mockResolvedValueOnce(sse(textFrame('Verified answer.')));
    const ids = await f.submit('Search the news');
    await f.execute(ids);
    expect(web.effects.web).toBe(1);
    await vi.waitFor(() => expect(f.runtime.memoryFor(f.identity.userId)!
      .foundation.snapshot().pending).toBe(0));

    const rows = [...memory.rows('metadata').values()]
      .filter(row => row.kind === 'memory-web-native');
    expect(rows).toHaveLength(1);
    const record = rows[0]!;
    expect(record).toMatchObject({
      userId: f.identity.userId, sessionId: ids.sessionId, attemptId: ids.attemptId,
    });
    expect(record.state.groups[0]).toMatchObject({
      assistant: { tool_calls: [{ id: 'web_1' }] },
      result: { tool_call_id: 'web_1', name: 'web_tool' },
    });
    expect(record.state.sources[0]).toMatchObject({ toolCallId: 'web_1', provider: 'exa' });
    expect(record.state.activities[0]).toMatchObject({ toolCallId: 'web_1', phase: 'completed' });
    expect(record.state.counters.evidenceBytes).toBeLessThanOrEqual(24_000);
    expect(record.state.groups).toHaveLength(1);
    expect(record.state.sources.length).toBeLessThanOrEqual(15);
    expect(record.state.activities.length).toBeLessThanOrEqual(40);

    const stored = [...memory.rows('messages').values()]
      .find(row => row.role === 'assistant' && row.turnId === ids.turnId);
    expect(stored).toBeDefined();
    delete (stored as { webSources?: unknown }).webSources;
    delete (stored as { webActivities?: unknown }).webActivities;

    const modelCalls = f.fetcher.mock.calls.length;
    await f.restart();
    await f.runtime.prepareSession(f.identity.userId, ids.sessionId);
    expect(f.fetcher.mock.calls.length).toBe(modelCalls);

    const assistant = f.runtime.memoryMessages(f.identity.userId, ids.sessionId,
      { cursor: null, limit: 10 })?.items
      .find(message => message.role === 'assistant' && message.turnId === ids.turnId);
    expect(assistant?.webSources?.[0]).toMatchObject({
      toolCallId: 'web_1', provider: 'exa', kind: 'browse',
    });
    expect(assistant?.webActivities?.[0]).toMatchObject({
      toolCallId: 'web_1', mode: 'browse', phase: 'completed',
    });
    expect(assistant?.webSources?.length).toBeLessThanOrEqual(15);
    expect(assistant?.webActivities?.length).toBeLessThanOrEqual(40);
    const linked = new Set(record.state.groups
      .flatMap(group => group.sources.map(source => source.sourceId)));
    expect(assistant?.webSources?.every(source => linked.has(source.sourceId))).toBe(true);
    expect(assistant?.webSources?.every(source => source.toolCallId === 'web_1')).toBe(true);
  } finally { await f.dispose(); }
});
