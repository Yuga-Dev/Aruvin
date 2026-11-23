/**
 * ============================================================================
 * FILE: web-search-calendar.spec.ts
 * LOCATION: backend/test/runtime/web-search-calendar.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove web_tool advertisement and execution on Calendar-capable models.
 *
 * ROLE IN PROJECT:
 *    Exercises the real memory-first Calendar composite loop: Calendar tools
 *    keep their order, web browse/fetch run through the same native transport,
 *    and invalid web arguments use the independent three-repair budget.
 *
 * KEY COMPONENTS:
 *    - fixture: Real persistence, Calendar connection, and web port double.
 *    - advertisement cases: tools capability and provider eligibility.
 *    - composite cases: browse, fetch, Calendar coexistence, repair budget.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import type { MongoClient } from 'mongodb';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { SKILL_NATIVE_TOOLS } from '../../src/contracts/calendar-tools.js';
import {
  WEB_TOOL_DEFINITION, WEB_TOOL_PARAMETERS,
} from '../../src/contracts/web-search-tools.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { nativeFrame } from '../model/calendar-fixtures.js';
import {
  calendarFixture, loadWire, skillWire, textWire,
} from './calendar-runtime.fixture.js';
import { webPortFixture } from './web-search-fixture.js';

const webWire = (raw: string, id = 'web_1', content?: string) => nativeFrame({
  role: 'assistant', ...(content ? { content } : {}), tool_calls: [{ index: 0, id, type: 'function',
    function: { name: 'web_tool', arguments: raw } }],
}) + nativeFrame({}, 'tool_calls') + 'data: [DONE]\n\n';

const listWire = () => skillWire('call_tool', {
  plugin: 'google-calendar', tool: 'calendar_list_events', arguments: {
    timeMin: '2026-11-03T00:00:00Z', timeMax: '2026-11-04T00:00:00Z', maxResults: 20,
  },
}, 'calendar-read');

async function fixture(options: {
  modelTools?: boolean; enabled?: boolean; prepared?: boolean;
} = {}) {
  const memory = calendarMemory();
  const client = Object.assign(memory.commandSource, {
    db: () => memory.store.db, appendMetadata: () => undefined,
  }) as unknown as MongoClient;
  const persistence = await createPersistenceBundle(
    client, 'web-calendar-test', DEFAULT_BUDGETS, 'web-calendar-executor',
  );
  const web = webPortFixture({ enabled: options.enabled, prepared: options.prepared });
  const f = calendarFixture(undefined, persistence, {
    policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 50 },
  }, { webSearch: web.port, modelTools: options.modelTools ?? true });
  await f.ready;
  return { f, web };
}

const toolsOf = (body: Record<string, unknown> | undefined) =>
  (body?.tools ?? []) as Array<{ type: string; function: { name: string } }>;

it('advertises web_tool after Calendar tools on a Calendar-capable model', async () => {
  const { f, web } = await fixture();
  try {
    f.modelWires.push(textWire('An ordinary answer.'));
    const ids = await f.submit('Hello');
    await f.execute(ids);
    expect(f.modelBodies).toHaveLength(1);
    const tools = toolsOf(f.modelBodies[0]);
    expect(tools.map(tool => tool.function.name))
      .toEqual([...SKILL_NATIVE_TOOLS.map(tool => tool.name), 'web_tool']);
    expect(tools.at(-1)).toEqual(WEB_TOOL_DEFINITION);
    expect(web.effects.web).toBe(0);
  } finally { await f.dispose(); }
});

it('omits web_tool when the Calendar-capable model lacks tools capability', async () => {
  const { f } = await fixture({ modelTools: false });
  try {
    f.modelWires.push(textWire('An ordinary answer.'));
    const ids = await f.submit('Hello');
    await f.execute(ids);
    expect(toolsOf(f.modelBodies[0]).some(tool => tool.function.name === 'web_tool')).toBe(false);
  } finally { await f.dispose(); }
});

it('omits web_tool when no prepared provider is eligible', async () => {
  const { f, web } = await fixture({ enabled: true, prepared: false });
  try {
    f.modelWires.push(textWire('An ordinary answer.'));
    const ids = await f.submit('Hello');
    await f.execute(ids);
    expect(toolsOf(f.modelBodies[0]).some(tool => tool.function.name === 'web_tool')).toBe(false);
    expect(web.effects.web).toBe(0);
  } finally { await f.dispose(); }
});

it('executes browse through the Calendar composite loop', async () => {
  const { f, web } = await fixture();
  try {
    f.modelWires.push(
      webWire('{"mode":"browse","query":"news"}', 'web_browse'),
      textWire('Verified answer.'),
    );
    const ids = await f.submit('Search the news');
    await f.execute(ids);
    expect(web.effects.web).toBe(1);
    expect(web.executed[0]?.args).toEqual({ mode: 'browse', query: 'news' });
    expect(f.modelBodies).toHaveLength(2);
    const second = f.modelBodies[1]!;
    expect(toolsOf(second)).toContainEqual(WEB_TOOL_DEFINITION);
    expect((second.messages as Array<{ role: string; tool_call_id?: string }>)
      .some(message => message.role === 'tool' && message.tool_call_id === 'web_browse')).toBe(true);
    const message = f.runtime.memoryMessages(f.identity.userId, ids.sessionId,
      { cursor: null, limit: 10 })?.items.at(-1);
    expect(message?.webSources?.[0]).toMatchObject({ toolCallId: 'web_browse', provider: 'exa' });
    expect(f.webFrames.some(frame => frame.event.type === 'web-sources')).toBe(true);
  } finally { await f.dispose(); }
});

it('starts the post-search answer on a new paragraph after pre-tool narration', async () => {
  const { f } = await fixture();
  try {
    f.modelWires.push(
      webWire('{"mode":"browse","query":"1 Peter 3:5 NRSV"}', 'web_nrsv',
        'Let me look up the NRSV text for 1 Peter 3:5.'),
      textWire('Here is 1 Peter 3:5 from the NRSV.'),
    );
    const ids = await f.submit('Show me 1 Peter 3:5 NRSV');
    await f.execute(ids);
    const message = f.runtime.memoryMessages(f.identity.userId, ids.sessionId,
      { cursor: null, limit: 10 })?.items.at(-1);
    expect(message?.content).toBe(
      'Let me look up the NRSV text for 1 Peter 3:5.\n\nHere is 1 Peter 3:5 from the NRSV.',
    );
  } finally { await f.dispose(); }
});

it('executes fetch through the Calendar composite loop', async () => {
  const { f, web } = await fixture();
  try {
    f.modelWires.push(
      webWire('{"mode":"fetch","url":"https://example.com/"}', 'web_fetch'),
      textWire('Read the page.'),
    );
    const ids = await f.submit('Read https://example.com/');
    await f.execute(ids);
    expect(web.effects.web).toBe(1);
    expect(web.executed[0]?.args).toEqual({ mode: 'fetch', url: 'https://example.com/' });
    const message = f.runtime.memoryMessages(f.identity.userId, ids.sessionId,
      { cursor: null, limit: 10 })?.items.at(-1);
    expect(message?.webSources?.[0]).toMatchObject({ toolCallId: 'web_fetch', kind: 'fetch' });
  } finally { await f.dispose(); }
});

it('keeps Calendar reads working while web executes in the same turn', async () => {
  const { f, web } = await fixture();
  try {
    f.modelWires.push(
      loadWire('calendar_list_events'),
      listWire(),
      webWire('{"mode":"browse","query":"news"}', 'web_after_calendar'),
      textWire('Listed and verified.'),
    );
    const ids = await f.submit('List my calendar and search the news');
    await f.execute(ids);
    expect(f.effects.filter(effect => effect.kind === 'list')).toHaveLength(1);
    expect(web.effects.web).toBe(1);
    expect(f.modelBodies).toHaveLength(4);
    const messages = f.modelBodies[3]!.messages as Array<{ role: string; name?: string }>;
    const toolNames = messages.filter(message => message.role === 'tool').map(message => message.name);
    expect(toolNames).toContain('web_tool');
    expect(toolNames.some(name => name !== 'web_tool')).toBe(true);
  } finally { await f.dispose(); }
});

it('uses exactly three independent web repairs and never calls a provider', async () => {
  const { f, web } = await fixture();
  try {
    for (let index = 0; index < 4; index += 1)
      f.modelWires.push(webWire('{"mode":"browse"}', `bad_${index}`));
    const ids = await f.submit('Search recent news');
    await f.execute(ids);
    expect(f.modelBodies).toHaveLength(4);
    expect(web.effects.web).toBe(0);
    for (const body of f.modelBodies.slice(1)) {
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const feedback = messages
        .filter(message => message.role === 'system')
        .map(message => {
          try { return JSON.parse(message.content ?? '') as Record<string, unknown>; }
          catch { return null; }
        })
        .filter(value => value?.code === 'WEB_SCHEMA_INVALID');
      expect(feedback.at(-1)?.expectedSchema).toEqual(WEB_TOOL_PARAMETERS);
      expect(messages.at(-1)?.content).toContain('WEB_SCHEMA_INVALID');
    }
    const message = f.runtime.memoryMessages(f.identity.userId, ids.sessionId,
      { cursor: null, limit: 10 })?.items.at(-1);
    expect(message?.content).toContain("couldn't format a valid web request");
  } finally { await f.dispose(); }
});
