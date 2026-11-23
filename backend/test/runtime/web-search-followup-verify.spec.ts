/**
 * ============================================================================
 * FILE: web-search-followup-verify.spec.ts
 * LOCATION: backend/test/runtime/web-search-followup-verify.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove accepted web evidence survives into later prompts byte-identically
 *    and rescues real native overflow without rewriting protected turns.
 *
 * ROLE IN PROJECT:
 *    Runs real MemoryText turns over deterministic fixtures and captures the
 *    provider request bodies: historical groups are reinserted at their
 *    originating turn, the accepted input appears once, ordinary prompts stay
 *    literal, and overflow either folds stale evidence or fails closed.
 *
 * KEY COMPONENTS:
 *    - plainFixture: Text-only model path with the deterministic web port.
 *    - compositeFixture: Calendar-capable model with real persistence.
 *    - Prefix assertions: turn N final body is a prefix of turn N+1 first body.
 *    - Overflow assertions: exact folded POST and zero pre-dispatch storage I/O.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { WEB_TOOL_DEFINITION } from '../../src/contracts/web-search-tools.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import type { RuntimeDependencies } from '../../src/chat-runtime/ports.js';
import { estimateMessagesTokens } from '../../src/context/context-budget.js';
import { webContext } from '../../src/context/web-context.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { textConfigFixture } from './text-config-fixture.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { nativeFrame } from '../model/calendar-fixtures.js';
import { calendarFixture, loadWire, skillWire, textWire } from './calendar-runtime.fixture.js';
import { sse, textFrame, webPortFixture, webToolFrame } from './web-search-fixture.js';

const webWire = (raw: string, id = 'web_1') => nativeFrame({
  role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
    function: { name: 'web_tool', arguments: raw } }],
}) + nativeFrame({}, 'tool_calls') + 'data: [DONE]\n\n';

const listWire = () => skillWire('call_tool', {
  plugin: 'google-calendar', tool: 'calendar_list_events', arguments: {
    timeMin: '2026-11-03T00:00:00Z', timeMax: '2026-11-04T00:00:00Z', maxResults: 20,
  },
}, 'calendar-read');

type Body = { messages: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> };

function fixtureSave() {
  type Save = NonNullable<NonNullable<RuntimeDependencies['memoryFirst']>['save']>;
  return vi.fn<Save>(async e => ({ kind: 'saved', epoch: e.epoch, sessionId: e.sessionId,
    version: e.version, fence: e.fence }));
}

function plainFixture() {
  const base = textSnapshot(1);
  const snapshot = { ...base, modelLimits: { ...base.modelLimits!, tools: true } };
  const web = webPortFixture();
  const save = fixtureSave();
  const f = textConfigFixture(snapshot, d => ({ ...d, webSearch: web.port,
    memoryFirst: { policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 30 },
      save } }));
  return { f, web, snapshot, save };
}

async function compositeFixture(memoryOnly = false) {
  const memory = calendarMemory();
  const client = Object.assign(memory.commandSource, {
    db: () => memory.store.db, appendMetadata: () => undefined,
  }) as unknown as MongoClient;
  const persistence = await createPersistenceBundle(
    client, 'web-followup-test', DEFAULT_BUDGETS, 'web-followup-executor',
  );
  const web = webPortFixture();
  const save = fixtureSave();
  const f = calendarFixture(undefined, persistence, {
    policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 50 },
    ...(memoryOnly ? { save } : {}),
  }, { webSearch: web.port, modelTools: true });
  await f.ready;
  return { f, web, memory, save };
}

const body = (f: { fetcher: { mock: { calls: unknown[][] } } }, index: number): Body => {
  const init = f.fetcher.mock.calls[index]![1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? '{}') as Body;
};

const prefixHolds = (previous: Body, next: Body) =>
  JSON.stringify(next.messages.slice(0, previous.messages.length)) === JSON.stringify(previous.messages);

it('reinserts turn 1 web evidence and keeps the prompt prefix byte-stable', async () => {
  const { f } = plainFixture();
  try {
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}')))
      .mockResolvedValueOnce(sse(textFrame('Verified answer.')))
      .mockResolvedValueOnce(sse(textFrame('Follow-up answer.')))
      .mockResolvedValueOnce(sse(textFrame('Third answer.')));

    const first = await f.submit('Search the news');
    await f.execute(first);
    const second = await f.submit('What was that source?', first.sessionId);
    await f.execute(second);
    const third = await f.submit('And again?', first.sessionId);
    await f.execute(third);

    const turn1 = body(f, 1);
    const turn2 = body(f, 2);
    const turn3 = body(f, 3);

    expect(JSON.stringify(turn2.messages)).toContain('https://example.com/');
    expect(JSON.stringify(turn2.messages)).toContain('Useful public evidence.');
    expect(prefixHolds(turn1, turn2)).toBe(true);
    expect(prefixHolds(turn2, turn3)).toBe(true);
    expect(JSON.stringify(turn2.messages).split('Search the news')).toHaveLength(2);
  } finally { await f.dispose(); }
});

it('replays a failed web pair so the next prompt keeps its prefix', async () => {
  const { f, web } = plainFixture();
  try {
    web.port.execute = vi.fn(async () => { throw new Error('provider down'); });
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}')))
      .mockResolvedValueOnce(sse(textFrame("I couldn't verify this.")))
      .mockResolvedValueOnce(sse(textFrame('Follow-up answer.')));
    const first = await f.submit('Search the news');
    await f.execute(first);
    const second = await f.submit('What happened?', first.sessionId);
    await f.execute(second);

    const turn1 = body(f, 1);
    const turn2 = body(f, 2);
    expect(JSON.stringify(turn2.messages)).toContain('WEB_PROVIDER_UNAVAILABLE');
    expect(prefixHolds(turn1, turn2)).toBe(true);
  } finally { await f.dispose(); }
});

it('reuses a failed call id without a second provider effect', async () => {
  const { f, web } = plainFixture();
  try {
    const execute = vi.fn(async () => { throw new Error('provider down'); });
    web.port.execute = execute;
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'same_fail')))
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'same_fail')))
      .mockResolvedValueOnce(sse(textFrame('Could not verify.')));
    const ids = await f.submit('Search the news');
    await f.execute(ids);
    expect(execute).toHaveBeenCalledTimes(1);
    const status = await f.runtime.getTurnStatus(f.identity.userId, ids.sessionId, ids.turnId);
    expect(status.status).toBe('completed');
  } finally { await f.dispose(); }
});

it('replays a failed web pair through the composite Calendar path', async () => {
  const { f, web } = await compositeFixture();
  try {
    web.port.execute = vi.fn(async () => { throw new Error('provider down'); });
    f.modelWires.push(
      webWire('{"mode":"browse","query":"news"}'),
      textWire("I couldn't verify this."),
      textWire('Follow-up answer.'),
    );
    const first = await f.submit('Search the news');
    await f.execute(first);
    const second = await f.submit('What happened?', first.sessionId);
    await f.execute(second);

    expect(f.modelBodies).toHaveLength(3);
    const turn1 = f.modelBodies[1] as Body;
    const turn2 = f.modelBodies[2] as Body;
    expect(JSON.stringify(turn2.messages)).toContain('WEB_PROVIDER_UNAVAILABLE');
    expect(prefixHolds(turn1, turn2)).toBe(true);
  } finally { await f.dispose(); }
});

it('places web groups before Calendar groups at the originating turn', async () => {
  const { f } = await compositeFixture();
  try {
    f.modelWires.push(
      loadWire('calendar_list_events'),
      listWire(),
      webWire('{"mode":"browse","query":"news"}', 'web_after_calendar'),
      textWire('Listed and verified.'),
      textWire('Follow-up answer.'),
    );
    const first = await f.submit('List my calendar and search the news');
    await f.execute(first);
    const second = await f.submit('What did you find?', first.sessionId);
    await f.execute(second);

    expect(f.modelBodies).toHaveLength(5);
    const turn1 = f.modelBodies[3] as Body;
    const turn2 = f.modelBodies[4] as Body;
    expect(prefixHolds(turn1, turn2)).toBe(true);

    const start = turn2.messages.findIndex(message =>
      message.role === 'user' && message.content === 'List my calendar and search the news');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(turn2.messages).split('List my calendar and search the news')).toHaveLength(2);
    const tail = turn2.messages.slice(start + 1);
    expect(tail[0]).toMatchObject({ role: 'assistant',
      tool_calls: [{ function: { name: 'web_tool' } }] });
    expect(tail[1]).toMatchObject({ role: 'tool', name: 'web_tool' });
    expect(tail[2]).toMatchObject({ role: 'assistant',
      tool_calls: [{ function: { name: 'activate_skill' } }] });
    expect(tail[3]).toMatchObject({ role: 'tool', name: 'activate_skill' });
    expect(tail[4]).toMatchObject({ role: 'assistant',
      tool_calls: [{ function: { name: 'call_tool' } }] });
    expect(tail[5]).toMatchObject({ role: 'tool', name: 'call_tool' });
    expect(tail[6]).toMatchObject({ role: 'assistant', content: 'Listed and verified.' });
  } finally { await f.dispose(); }
});

it('reinserts hydrated web evidence after a cold restart', async () => {
  const { f } = await compositeFixture();
  try {
    f.modelWires.push(
      webWire('{"mode":"browse","query":"news"}'),
      textWire('Verified answer.'),
    );
    const first = await f.submit('Search the news');
    await f.execute(first);
    await f.restart();
    await f.runtime.prepareSession(f.identity.userId, first.sessionId);

    f.modelWires.push(textWire('Follow-up answer.'));
    const second = await f.submit('What was that source?', first.sessionId);
    await f.execute(second);

    expect(f.modelBodies).toHaveLength(3);
    const turn1 = f.modelBodies[1] as Body;
    const turn2 = f.modelBodies[2] as Body;
    expect(JSON.stringify(turn2.messages)).toContain('https://example.com/');
    expect(JSON.stringify(turn2.messages)).toContain('Useful public evidence.');
    expect(prefixHolds(turn1, turn2)).toBe(true);
  } finally { await f.dispose(); }
});

it('hydrates and admits a cold or evicted web-enabled session directly on submit', async () => {
  const { f } = await compositeFixture();
  try {
    f.modelWires.push(
      webWire('{"mode":"browse","query":"news"}'),
      textWire('Verified answer.'),
    );
    const first = await f.submit('Search the news');
    await f.execute(first);

    // Cold restart without calling prepareSession first: submit must hydrate cleanly.
    await f.restart();
    expect(Boolean(f.runtime.memoryFor(f.identity.userId)?.owns(first.sessionId))).toBe(false);

    f.modelWires.push(textWire('Cold follow-up answer.'));
    const second = await f.submit('What was that source?', first.sessionId);
    await f.execute(second);
    expect(f.modelBodies).toHaveLength(3);
    expect(JSON.stringify(f.modelBodies[2])).toContain('https://example.com/');
    expect(prefixHolds(f.modelBodies[1] as Body, f.modelBodies[2] as Body)).toBe(true);

    // Simulate cold prepareSession followed by eviction from another session's activity.
    await f.restart();
    await f.runtime.prepareSession(f.identity.userId, first.sessionId);
    expect(f.runtime.memoryFor(f.identity.userId)?.owns(first.sessionId)).toBe(true);

    f.modelWires.push(textWire('Other session answer.'));
    const other = await f.submit('Unrelated chat');
    await f.execute(other);
    expect(Boolean(f.runtime.memoryFor(f.identity.userId)?.owns(first.sessionId))).toBe(false);

    f.modelWires.push(textWire('Recovered follow-up answer.'));
    const third = await f.submit('And one more follow-up', first.sessionId);
    await f.execute(third);
    expect(f.modelBodies).toHaveLength(5);
    expect(prefixHolds(f.modelBodies[2] as Body, f.modelBodies[4] as Body)).toBe(true);
  } finally { await f.dispose(); }
});

it('keeps the plain turn alive when the model reuses a web call id on a later turn', async () => {
  const { f } = plainFixture();
  try {
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'web_1')))
      .mockResolvedValueOnce(sse(textFrame('Verified answer.')))
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news2"}', 'web_1')))
      .mockResolvedValueOnce(sse(textFrame('Second answer.')));
    const first = await f.submit('Search the news');
    await f.execute(first);
    const second = await f.submit('Search again', first.sessionId);
    await f.execute(second);
    const status = await f.runtime.getTurnStatus(f.identity.userId, second.sessionId, second.turnId);
    expect(status.status).toBe('completed');
    expect(prefixHolds(body(f, 1), body(f, 2))).toBe(true);
  } finally { await f.dispose(); }
});

it('keeps the composite turn alive when the model reuses a web call id on a later turn', async () => {
  const { f } = await compositeFixture();
  try {
    f.modelWires.push(
      webWire('{"mode":"browse","query":"news"}', 'web_1'),
      textWire('Verified answer.'),
      webWire('{"mode":"browse","query":"news2"}', 'web_1'),
      textWire('Second answer.'),
    );
    const first = await f.submit('Search the news');
    await f.execute(first);
    const second = await f.submit('Search again', first.sessionId);
    await f.execute(second);
    const status = await f.runtime.getTurnStatus(f.identity.userId, second.sessionId, second.turnId);
    expect(status.status).toBe('completed');
    expect(prefixHolds(f.modelBodies[1] as Body, f.modelBodies[2] as Body)).toBe(true);
  } finally { await f.dispose(); }
});

it('fails closed when historical web evidence exceeds the context budget', async () => {
  const { f, snapshot } = plainFixture();
  try {
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}')))
      .mockResolvedValueOnce(sse(textFrame('Verified answer.')));
    const first = await f.submit('Search the news');
    await f.execute(first);

    const turn1 = body(f, 1);
    const user2 = 'Follow-up question.';
    const augmented = [...turn1.messages,
      { role: 'assistant', content: 'Verified answer.' }, { role: 'user', content: user2 }];
    const estimate = 64 + Buffer.byteLength(JSON.stringify({ messages: augmented, tools: turn1.tools }), 'utf8')
      + augmented.length * 32;
    f.publish({ ...snapshot, budgets: { ...snapshot.budgets,
      maxContextTokens: estimate - 1 + snapshot.budgets.maxOutputTokens
        + snapshot.budgets.modelMarginTokens } });

    f.fetcher.mockResolvedValueOnce(sse(textFrame('Follow-up answer.')));
    const second = await f.submit(user2, first.sessionId);
    await f.execute(second);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const status = await f.runtime.getTurnStatus(f.identity.userId, second.sessionId, second.turnId);
    expect(status.status).toBe('failed');
    expect(status.error?.code).toBe('CONTEXT_BUDGET_EXCEEDED');
  } finally { await f.dispose(); }
});

it('rejects an over-budget composite prompt instead of dropping web groups', () => {
  const group = {
    ordinal: 0, afterCalendarGroups: 0,
    assistant: { role: 'assistant' as const, content: null,
      tool_calls: [{ id: 'web_large', type: 'function' as const,
        function: { name: 'web_tool' as const, arguments: '{"mode":"browse","query":"news"}' } }] },
    result: { role: 'tool' as const, tool_call_id: 'web_large', name: 'web_tool' as const,
      content: JSON.stringify({ truncated: false, results: [{ url: 'https://example.com/',
        title: 'Example', body: 'x'.repeat(4_000) }] }) },
    sources: [],
  };
  expect(() => webContext({
    calendarMessages: [{ role: 'user', content: 'question' }, group.assistant, group.result],
    webGroups: [],
    budgets: { maxContextTokens: 2_000, maxOutputTokens: 100, modelMarginTokens: 100,
      maxMessagesInContext: 80, maxHistoryTokens: 10_000 },
    contextTokens: 2_000,
    tools: [WEB_TOOL_DEFINITION],
    prefixCount: 0,
  })).toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED',
    message: 'This chat has reached its context limit. Start a new chat to continue.' }));
});

it.each([
  { route: 'web', pressure: 'total' },
  { route: 'web', pressure: 'history' },
  { route: 'composite', pressure: 'total' },
  { route: 'composite', pressure: 'history' },
  { route: 'web', pressure: 'protected-continuation' },
] as const)('rescues $route $pressure overflow in the final POST without rewriting the tail', async ({ route, pressure }) => {
  const webOnly = route === 'web' ? plainFixture() : null;
  const mixed = route === 'composite' ? await compositeFixture(true) : null;
  const f = webOnly?.f ?? mixed!.f;
  const web = webOnly?.web ?? mixed!.web;
  const save = webOnly?.save ?? mixed!.save;
  const snapshot = webOnly?.snapshot ?? mixed!.f.currentConfig.current()!;
  const protectedOverflow = pressure === 'protected-continuation';
  const captured = (): Body[] => mixed
    ? mixed.f.modelBodies as Body[] : f.fetcher.mock.calls.map((_, i) => body(f, i));
  const queue = (text: string, webRaw?: string, id?: string) => {
    if (mixed) mixed.f.modelWires.push(webRaw ? webWire(webRaw, id) : textWire(text));
    else f.fetcher.mockResolvedValueOnce(sse(webRaw ? webToolFrame(webRaw, id) : textFrame(text)));
  };
  const question = 'Read the same page again.';
  const url = 'https://example.test/A%2Fb?q=one%20two#Exact';
  const raw = '{"mode":"fetch","url":"https://example.test/request"}';
  const sourceFor = (i: number) => `${url}-${i}`;
  let effects = 0;
  web.port.execute = vi.fn(async () => {
    const i = effects++;
    return { ok: true as const, mode: 'fetch' as const, provider: 'exa' as const,
      retrievedAt: '2026-11-14T00:00:00.000Z', truncated: false, url: sourceFor(i),
      body: `Useful evidence ${i}. ${'x'.repeat(i === 1 ? 3_650 : i === 5 ? protectedOverflow ? 3_950 : 330 : 2_200)}` };
  });
  try {
    const high = { ...snapshot, budgets: { ...snapshot.budgets,
      maxContextTokens: Math.min(30_000, snapshot.modelLimits!.contextTokens), maxHistoryTokens: 22_000 },
      settings: { ...snapshot.settings, compaction: { ...snapshot.settings.compaction,
        enabled: false, watermarkRatio: 0.8, modelMode: 'active-fork' as const, customModelId: null } } };
    f.publish(high);
    let sessionId: string | null = null;
    for (let i = 0; i < 5; i++) {
      queue('', raw, 'reused');
      queue(`Answer ${i}`);
      const sub = await f.submit(question, sessionId);
      sessionId = sub.sessionId;
      await f.execute(sub);
      expect((await f.runtime.getTurnStatus(f.identity.userId, sub.sessionId, sub.turnId)).status).toBe('completed');
    }
    const normal = captured();
    expect(normal).toHaveLength(10);
    expect(prefixHolds(normal[7], normal[8])).toBe(true);
    expect(JSON.stringify(normal[9])).not.toContain('folded-web-result');
    const previous = normal[9];
    const unprojected = [...previous.messages, { role: 'assistant', content: 'Answer 4' },
      { role: 'user', content: question }];
    const firstUser = unprojected.findIndex(m => m.role === 'user');
    const history = estimateMessagesTokens(unprojected.slice(firstUser));
    const estimate = 64 + Buffer.byteLength(JSON.stringify({ messages: unprojected, tools: previous.tools }), 'utf8')
      + unprojected.length * 32;
    const low = { ...high, revision: high.revision + 1, budgets: { ...high.budgets,
      ...(pressure === 'history' ? { maxHistoryTokens: history - 256 } : {
        maxContextTokens: estimate - (protectedOverflow ? 3_000 : 256)
          + high.budgets.maxOutputTokens + high.budgets.modelMarginTokens,
      }) } };
    expect(low.budgets.maxHistoryTokens).toBeGreaterThanOrEqual(10_000);
    expect(low.budgets.maxContextTokens).toBeLessThanOrEqual(high.budgets.maxContextTokens);
    // Keep compaction enabled in total-only case while canonical history remains below its watermark.
    if (pressure === 'total') low.settings = { ...low.settings, compaction: { ...low.settings.compaction, enabled: true } };
    expect(history + 1_000).toBeLessThan(high.budgets.maxHistoryTokens * 0.8);
    const owner = f.runtime['memoryOwners'].get(f.identity.userId)!;
    await owner.foundation.flushSession(sessionId!);
    const groupsBefore = structuredClone(owner.foundation.webGroups(sessionId!));
    const storeBefore = mixed?.memory.wireCalls.length;
    const saveBefore = save.mock.calls.length;
    const spies: Array<{ mock: { calls: readonly unknown[] } }> = mixed ? [] : [
      vi.spyOn(f.p.sessions, 'get'), vi.spyOn(f.p.memory, 'get'),
      vi.spyOn(f.p.metadata, 'putAccounting'),
    ];
    if (!mixed && f.p.messages.getReferences) spies.push(vi.spyOn(f.p.messages, 'getReferences'));
    const storeState = () => ({ stores: mixed?.memory.wireCalls.length, saves: save.mock.calls.length,
      calls: spies.map(s => s.mock.calls.length) });
    const observed: ReturnType<typeof storeState>[] = [];
    const mark = () => { observed.push(storeState()); };
    if (mixed) {
      const transport = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation((url, init) => { mark(); return transport(url, init); });
      queue('', raw, 'reused');
      queue('Rescued.');
    } else {
      f.fetcher.mockImplementationOnce(async () => { mark(); return sse(webToolFrame(raw, 'reused')); })
        .mockImplementationOnce(async () => { mark(); return sse(textFrame('Rescued.')); });
    }
    f.publish(low);
    const active = await f.submit(question, sessionId);
    await f.execute(active);
    const sent = protectedOverflow ? 1 : 2;
    expect(captured()).toHaveLength(10 + sent);
    const posts = f.fetcher.mock.calls.slice(10);
    expect(posts).toHaveLength(sent);
    for (const [request, init] of posts) {
      expect(typeof request).toBe('string');
      expect(new URL(request as string).pathname).toBe('/api/v1/chat/completions');
      expect(init?.method).toBe('POST');
    }
    const status = await f.runtime.getTurnStatus(f.identity.userId, active.sessionId, active.turnId);
    expect(status.status).toBe(protectedOverflow ? 'failed' : 'completed');
    if (protectedOverflow) expect(status.error?.code).toBe('CONTEXT_BUDGET_EXCEEDED');
    expect(observed).toEqual(Array.from({ length: sent }, () => ({
      stores: storeBefore, saves: saveBefore, calls: spies.map(() => 0),
    })));
    expect(effects).toBe(6);
    const at = unprojected.findIndex(m => m.role === 'tool' && String(m.content).includes(sourceFor(1)));
    const initial = captured()[10];
    const continuation = captured()[11];
    expect(initial.messages.slice(0, at)).toEqual(unprojected.slice(0, at));
    expect(initial.messages.slice(at + 1)).toEqual(unprojected.slice(at + 1));
    const folded = initial.messages[at];
    expect(folded).toMatchObject({ role: 'tool', name: 'web_tool', tool_call_id: 'reused' });
    expect(JSON.parse(String(folded.content))).toMatchObject({
      kind: 'folded-web-result', results: [{ url: sourceFor(1) }],
    });
    if (!protectedOverflow) {
      expect(continuation.messages.slice(0, initial.messages.length)).toEqual(initial.messages);
      expect(continuation.messages.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{
        id: 'reused', function: { name: 'web_tool', arguments: raw },
      }] });
      expect(JSON.parse(String(continuation.messages.at(-1)?.content))).toEqual({
        url: sourceFor(5), truncated: false, body: `Useful evidence 5. ${'x'.repeat(330)}`,
      });
    }
    expect(initial.messages.filter(m => m.role === 'user' && m.content === question)).toHaveLength(6);
    for (const [turnId, groups] of groupsBefore) {
      expect(owner.foundation.webGroups(sessionId!).get(turnId)).toEqual(groups);
    }
  } finally { await f.dispose(); }
});
