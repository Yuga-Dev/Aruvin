/**
 * ============================================================================
 * FILE: web-search-acceptance.spec.ts
 * LOCATION: backend/test/assembly/web-search-acceptance.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify integrated Web Search acceptance over real HTTP auth, runtime and archive.
 *
 * ROLE IN PROJECT:
 *    P5 cross-boundary evidence: one assembled AppService/AppModule, real private
 *    HTTP authentication, real DurableChatRuntime, real MCP SDK wire fixtures, and
 *    the stock asynchronous archive. Production source is never modified here.
 *
 * KEY COMPONENTS:
 *    - AC6: authenticated submit/SSE to model with all foreground storage blocked.
 *    - AC6: continuation and immediate next turn finish while a real archive is held.
 *    - AC3: bounded schema repair, no provider dispatch, no successful-call replay.
 *    - AC2/AC7: account lifecycle, off/unused isolation.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import {
  WEB_CREDENTIALS_INVALID_MESSAGE, WEB_TOOL_DEFINITION,
} from '../../src/contracts/web-search-tools.js';
import { webAcceptanceFixture } from './web-search-acceptance-fixture.js';

it('[AC6] real HTTP auth and SSE dispatch with all foreground application storage blocked', async () => {
  const f = await webAcceptanceFixture();
  let guard: ReturnType<typeof f.guardForegroundStorage> | undefined;
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    f.queue(
      { id: 'web_a', name: 'web_tool', raw: '{"mode":"browse","query":"public evidence"}' },
      { text: 'A bounded grounded answer.' },
    );
    guard = f.guardForegroundStorage();
    const result = await f.turn('Search public evidence');
    expect(f.beforeModel).toHaveLength(2);
    expect(f.beforeModel[0]).toMatchObject({
      dbReads: 0, dbWrites: 0, storageEntries: 0,
      initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0, retrieval: 0,
    });
    for (const boundary of f.beforeModel) {
      expect(boundary).toMatchObject({ dbReads: 0, dbWrites: 0, storageEntries: 0 });
      expect(boundary.authReads).toBeGreaterThanOrEqual(2);
    }
    expect(f.bodies[0]!.tools).toContainEqual(WEB_TOOL_DEFINITION);
    expect(f.bodies.every(body => body.user === 'u1')).toBe(true);
    expect(result.stream).toContain('web-sources');
    expect(guard.attempts()).toBe(0);
    // The setup counters are live: connect performed real MCP initialize/list/probe.
    expect(f.mcpCounts.initialize).toBeGreaterThan(0);
    expect(f.mcpCounts.list).toBeGreaterThan(0);
    expect(f.mcpCounts.probes).toBeGreaterThan(0);
  } finally {
    guard?.restore();
    await f.close();
  }
});

it('[AC6] HTTP continuation and immediate next turn finish while an actual archive is held', async () => {
  const f = await webAcceptanceFixture();
  let hold: ReturnType<typeof f.heldArchive> | undefined;
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    hold = f.heldArchive();
    f.queue({ text: 'Seed answer.' });
    const first = await f.turn('Seed');
    await hold.entered;
    f.queue(
      { id: 'web_b', name: 'web_tool', raw: '{"mode":"browse","query":"current facts"}' },
      { text: 'Grounded follow-up.' },
      { text: 'Immediate next answer.' },
    );
    const second = await f.turn('Search current facts', first.sessionId);
    const third = await f.turn('Continue', first.sessionId);
    expect(second.stream).toContain('completed');
    expect(third.stream).toContain('completed');
    expect(f.beforeModel.slice(-3)).toHaveLength(3);
    for (const row of f.beforeModel.slice(-3)) {
      expect(row).toMatchObject({
        dbReads: 0, dbWrites: 0, storageEntries: 0,
        initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0,
      });
    }
  } finally {
    hold?.release();
    await f.close();
  }
});

it('[AC3] four invalid emissions allow exactly three additional attempts and no provider call', async () => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    f.guardForegroundStorage();
    f.queue(...Array.from({ length: 4 }, (_, index) => ({
      id: `invalid_${index}`, name: 'web_tool', raw: '{"mode":"browse"}',
    })));
    const result = await f.turn('Search now');
    expect(f.bodies).toHaveLength(4);
    expect(f.boundary().retrieval).toBe(0);
    for (const body of f.bodies.slice(1)) {
      expect(body.tools).toContainEqual(WEB_TOOL_DEFINITION);
      const feedback = (body.messages as Array<{ content?: string }>)
        .flatMap(message => {
          try {
            const value = JSON.parse(message.content ?? '') as Record<string, unknown>;
            return value.code === 'WEB_SCHEMA_INVALID' ? [value] : [];
          } catch { return []; }
        });
      expect(feedback.at(-1)?.expectedSchema).toEqual(WEB_TOOL_DEFINITION.function.parameters);
    }
    expect(result.stream).toContain("couldn't verify");
  } finally { await f.close(); }
});

it('[AC3] a corrected call dispatches once and never replays the successful call', async () => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    f.queue(
      { id: 'web_ok', name: 'web_tool', raw: '{"mode":"browse","query":"first facts"}' },
      { id: 'web_bad', name: 'web_tool', raw: '{"mode":"browse"}' },
      { id: 'web_ok', name: 'web_tool', raw: '{"mode":"browse","query":"first facts"}' },
      { text: 'One provider effect.' },
    );
    const result = await f.turn('Search first facts');
    expect(f.bodies).toHaveLength(4);
    expect(f.boundary().retrieval).toBe(1);
    expect(result.stream).toContain('completed');
  } finally { await f.close(); }
});

it('[AC7] off and enabled-unused turns make zero external web requests', async () => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare();
    f.queue({ text: 'Ordinary answer.' });
    await f.turn('Hello');
    expect(f.boundary().retrieval).toBe(0);
    expect(f.boundary().initialize).toBe(0);
    const offTools = (f.bodies[0]!.tools ?? []) as Array<{ function: { name: string } }>;
    expect(offTools.some(tool => tool.function.name === 'web_tool')).toBe(false);

    await f.connect('exa');
    await f.enable(true);
    f.queue({ text: 'Still ordinary.' });
    await f.turn('Read https://example.com/ later');
    expect(f.boundary().retrieval).toBe(0);
    const tools = (f.bodies.at(-1)!.tools ?? []) as Array<{ function: { name: string } }>;
    expect(tools.filter(tool => tool.function.name === 'web_tool')).toHaveLength(1);
  } finally { await f.close(); }
});

it('[AC6] foreground storage guard trips on a deliberate application storage read', async () => {
  const f = await webAcceptanceFixture();
  let guard: ReturnType<typeof f.guardForegroundStorage> | undefined;
  try {
    await f.prepare();
    guard = f.guardForegroundStorage();
    expect(() => f.trace.run({ lane: 'foreground' },
      () => f.persistence.users.bySubject('user_fixture_1'))).toThrow(/blocked foreground/);
    expect(guard.attempts()).toBe(1);
    // Outside the foreground lane the same read is counted, not blocked.
    const before = f.boundary().storageEntries;
    await f.trace.run({ lane: 'setup' }, () => f.persistence.users.bySubject('user_fixture_1'));
    expect(f.boundary().storageEntries).toBeGreaterThan(before);
  } finally {
    guard?.restore();
    await f.close();
  }
});

it('[AC4] real SDK fallback is ordered and uses the connected account header', async () => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare();
    await f.connect('keenable');
    await f.connect('exa');
    await f.connect('tavily');
    await f.enable(true);
    f.failProvider('keenable', 429);
    f.emptyProvider('exa');
    f.queue(
      { id: 'web_fb', name: 'web_tool', raw: '{"mode":"browse","query":"fallback facts"}' },
      { text: 'Fallback answer.' },
    );
    const result = await f.turn('Search fallback facts');
    expect(f.boundary().retrieval).toBe(3);
    expect(result.stream).toContain('"provider":"tavily"');
    expect(f.providerCalls('keenable')).toHaveLength(2);
    expect(f.providerCalls('exa')).toHaveLength(2);
    expect(f.providerCalls('tavily')).toHaveLength(2);
    expect(f.providerCalls('tavily').at(-1)?.headers.get('authorization')).toBe('Bearer fixture-key');
  } finally { await f.close(); }
});

it('[AC5] fallback does not multiply the five logical browse calls', async () => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    f.queue(
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `web_${index}`, name: 'web_tool', raw: `{"mode":"browse","query":"q${index}"}`,
      })),
      { text: 'Budget answer.' },
    );
    const result = await f.turn('Search six times');
    expect(f.boundary().retrieval).toBe(5);
    expect(f.bodies).toHaveLength(7);
    const toolMessages = (f.bodies.at(-1)!.messages as Array<{ role: string; content?: string }>)
      .filter(message => message.role === 'tool');
    expect(toolMessages.at(-1)?.content).toContain('WEB_SEARCH_LIMIT');
    expect(result.stream).toContain('completed');
  } finally { await f.close(); }
});

it('[AC8] source linkage survives transport and archive', async () => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    f.queue(
      { id: 'web_link', name: 'web_tool', raw: '{"mode":"browse","query":"linked facts"}' },
      { text: 'Linked answer.' },
    );
    const result = await f.turn('Search linked facts');
    const frames = result.stream.split('\n\n').filter(Boolean)
      .map(block => block.replace(/^data: /, ''))
      .filter(value => value !== '[DONE]')
      .map(value => JSON.parse(value) as {
        sessionId: string; turnId: string; attemptId: string;
        event: { type: string; sources?: Array<Record<string, unknown>> };
      });
    const sources = frames.find(frame => frame.event.type === 'web-sources');
    expect(sources).toBeDefined();
    expect(sources!.event.sources?.[0]).toMatchObject({
      toolCallId: 'web_link', provider: 'exa', kind: 'browse',
      url: 'https://example.com/',
    });
    expect(String(sources!.event.sources?.[0]?.sourceId)).toMatch(/^ws_/);
    expect(sources!.sessionId).toBe(result.sessionId);
    expect(sources!.turnId).toBe(result.turnId);
    expect(sources!.attemptId).toBe(result.attemptId);
    const completed = frames.find(frame => frame.event.type === 'completed');
    expect(completed).toBeDefined();
    expect(completed!.turnId).toBe(result.turnId);
  } finally { await f.close(); }
});

it('[AC9] isolated credentials use only the owning account provider header', async () => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    await f.prepare('b');
    await f.connect('tavily', 'b');
    await f.enable(true, 'b');
    f.queue(
      { id: 'web_a', name: 'web_tool', raw: '{"mode":"browse","query":"account a"}' },
      { text: 'A answer.' },
    );
    await f.turn('Account A search');
    f.queue(
      { id: 'web_b', name: 'web_tool', raw: '{"mode":"browse","query":"account b"}' },
      { text: 'B answer.' },
    );
    await f.turn('Account B search', undefined, 'b');
    expect(f.providerCalls('exa').at(-1)?.headers.get('x-api-key')).toBe('fixture-key');
    expect(f.providerCalls('tavily').at(-1)?.headers.get('authorization')).toBe('Bearer fixture-key');
    const stored = [...f.memory.rows('web_search_connections').values()];
    expect(JSON.stringify(stored)).not.toContain('fixture-key');
  } finally { await f.close(); }
});

it('[AC9] disable mid-call discards the late provider result', async () => {
  const f = await webAcceptanceFixture();
  let hold: ReturnType<typeof f.holdProvider> | undefined;
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    hold = f.holdProvider('exa');
    f.queue(
      { id: 'web_late', name: 'web_tool', raw: '{"mode":"browse","query":"late facts"}' },
      { text: 'Honest fallback.' },
    );
    const running = f.turn('Search late facts');
    await hold.entered;
    await f.enable(false);
    hold.release();
    hold = undefined;
    const result = await running;
    expect(result.stream).not.toContain('web-sources');
    expect(f.boundary().retrieval).toBe(1);
  } finally {
    hold?.release();
    await f.close();
  }
});

it('[AC6] closed authority fails closed before any model dispatch', async () => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    f.service.auth.authority.close();
    const response = await f.agent.post('/api/sessions')
      .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', f.origin)
      .send({ sessionId: null, content: 'Hello', idempotencyKey: 'web-p5-closed-auth' })
      .expect(503);
    expect(response.body.error?.code ?? response.body.code).toBe('NOT_READY');
    expect(f.bodies).toHaveLength(0);
  } finally { await f.close(); }
});

it('[AC6] shutdown closes persistence once and makes no late provider call', async () => {
  const f = await webAcceptanceFixture();
  await f.prepare();
  await f.connect('exa');
  await f.enable(true);
  f.queue({ text: 'Ordinary answer.' });
  await f.turn('Hello');
  const retrieval = f.mcpCounts.retrieval;
  await f.close();
  expect(f.closeCount()).toBe(1);
  expect(f.mcpCounts.retrieval).toBe(retrieval);
});

it('[AC10] a rejected saved key tells the model to reconnect and the next turn stays status-only', async () => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    f.failProvider('exa', 401);
    f.queue(
      { id: 'web_rejected', name: 'web_tool', raw: '{"mode":"browse","query":"rejected facts"}' },
      { text: WEB_CREDENTIALS_INVALID_MESSAGE },
    );
    const first = await f.turn('Search rejected facts');
    expect(first.stream).toContain('completed');
    expect(f.boundary().retrieval).toBe(1);
    const failureMessage = (f.bodies[1]!.messages as Array<{ role: string; content?: string }>)
      .filter(message => message.role === 'tool').at(-1);
    expect(failureMessage?.content).toContain(WEB_CREDENTIALS_INVALID_MESSAGE);
    const assistant = f.runtime.memoryMessages('u1', first.sessionId, { cursor: null, limit: 10 })
      ?.items.find(message => message.role === 'assistant');
    expect(assistant?.content).toBe(WEB_CREDENTIALS_INVALID_MESSAGE);
    const providerCalls = f.providerCalls('exa').length;

    f.queue(
      { id: 'web_status_only', name: 'web_tool', raw: '{"mode":"browse","query":"again"}' },
      { text: 'Web search is still unavailable.' },
    );
    const second = await f.turn('Try again', first.sessionId);
    expect(second.stream).toContain('completed');
    expect(f.boundary()).toMatchObject({ initialize: 0, list: 0, probes: 0, retrieval: 0 });
    expect(f.providerCalls('exa')).toHaveLength(providerCalls);
    expect((f.bodies.at(-1)!.tools ?? []) as unknown[]).toContainEqual(WEB_TOOL_DEFINITION);
    const repaired = (f.bodies.at(-1)!.messages as Array<{ role: string; content?: string }>)
      .filter(message => message.role === 'tool').at(-1);
    expect(repaired?.content).toContain(WEB_CREDENTIALS_INVALID_MESSAGE);
  } finally { await f.close(); }
});

it('[AC2] account A enablement does not enable account B', async () => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    f.queue({ text: 'A answer.' });
    await f.turn('A question');
    expect((f.bodies.at(-1)!.tools ?? []) as unknown[]).toContainEqual(WEB_TOOL_DEFINITION);

    await f.prepare('b');
    f.queue({ text: 'B answer.' });
    await f.turn('B question', undefined, 'b');
    const bTools = (f.bodies.at(-1)!.tools ?? []) as Array<{ function: { name: string } }>;
    expect(bTools.some(tool => tool.function.name === 'web_tool')).toBe(false);
    expect(f.bodies.at(-1)!.user).toBe('u2');
  } finally { await f.close(); }
});
