/**
 * ============================================================================
 * FILE: web-search-loop.spec.ts
 * LOCATION: backend/test/runtime/web-search-loop.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the actual MemoryText web loop: advertisement, execution, repair.
 *
 * ROLE IN PROJECT:
 *    Proves web_tool is advertised only when enabled/eligible, invalid calls
 *    never dispatch a provider, and successful calls are never replayed.
 *
 * KEY COMPONENTS:
 *    - webFixture: Real MemoryText over the text runtime fixture.
 *    - browse/repair cases: Model bodies, provider effects, visible evidence.
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { textConfigFixture } from '../runtime/text-config-fixture.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import type { SaveOutcome, TerminalEnvelope } from '../../src/chat-runtime/memory-first-foundation.js';
import type { WebSearchPort, ValidatedWebInput, WebCallContext } from '../../src/plugins/web-search/types.js';
import type { WebToolArguments, WebToolResult } from '../../src/contracts/web-search-tools.js';
import type { StreamEnvelope } from '../../src/contracts/stream.js';
import type { RuntimeDependencies } from '../../src/chat-runtime/ports.js';
import { authority } from './dev-mode-fixture.js';

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = 'data: [DONE]\n\n';
const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const textFrame = (text: string, id = 'gen_text') => event({ id, choices: [{ index: 0,
  delta: { content: text }, finish_reason: 'stop' }] }) + done;
const toolFrame = (raw: string, id = 'web_1', gen = 'gen_tool') => event({ id: gen,
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function',
    function: { name: 'web_tool', arguments: raw } }] }, finish_reason: 'tool_calls' }] }) + done;
const preambleThenTool = (text: string, raw: string, id = 'web_1') =>
  event({ id: 'gen_tool', choices: [{ index: 0, delta: { content: text } }] })
  + event({ id: 'gen_tool', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function',
    function: { name: 'web_tool', arguments: raw } }] }, finish_reason: 'tool_calls' }] }) + done;

const saved = (e: TerminalEnvelope): SaveOutcome => ({ kind: 'saved', epoch: e.epoch,
  sessionId: e.sessionId, version: e.version, fence: e.fence });

function webPort(options: { enabled?: boolean; prepared?: boolean } = {}) {
  const executed: ValidatedWebInput[] = [];
  const port: WebSearchPort = {
    snapshot: userId => ({ userId, revision: 1, generation: 1,
      prepared: options.prepared ?? true, enabled: options.enabled ?? true,
      providers: [{ provider: 'exa', capabilities: { browse: true, fetch: true } }] }),
    validateInput: vi.fn(async (args: WebToolArguments, context: WebCallContext) => Object.freeze({
      args, userId: context.userId, turnId: context.turnId, toolCallId: context.toolCallId,
    })),
    execute: vi.fn(async (input: ValidatedWebInput, context: WebCallContext) => {
      executed.push(input);
      context.activity?.({ toolCallId: input.toolCallId, mode: input.args.mode,
        phase: 'searching', provider: null, code: null });
      const result: WebToolResult = { ok: true as const, mode: 'browse' as const,
        provider: 'exa' as const, retrievedAt: '2026-11-14T00:00:00.000Z', truncated: false,
        results: [{ url: 'https://example.com/', title: 'Example',
          body: 'Useful public evidence.' }] };
      context.activity?.({ toolCallId: input.toolCallId, mode: input.args.mode,
        phase: 'completed', provider: 'exa', code: null });
      return result;
    }),
  };
  return { port, executed };
}

function fixture(options: { enabled?: boolean; prepared?: boolean; tools?: boolean;
  devMode?: RuntimeDependencies['devMode'] } = {}) {
  const base = textSnapshot(1);
  const snapshot = { ...base, modelLimits: { ...base.modelLimits!, tools: options.tools ?? true } };
  const web = webPort(options);
  const f = textConfigFixture(snapshot, d => ({ ...d, webSearch: web.port,
    ...(options.devMode ? { devMode: options.devMode } : {}),
    memoryFirst: { policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 30 },
      save: async envelope => saved(envelope) } }));
  return { f, web };
}

it('keeps User and its announcement through a web continuation after switching to Dev', async () => {
  const a = authority(); a.mode.setEnabled(true);
  const { f, web } = fixture({ devMode: a.mode });
  const consume = vi.spyOn(a.mode, 'consumeForDispatch');
  try {
    f.fetcher.mockImplementationOnce(async () => {
      a.mode.select(a.principal, 'dev');
      return sse(toolFrame('{"mode":"browse","query":"news"}'));
    }).mockResolvedValueOnce(sse(textFrame('Verified answer.')));
    const ids = await f.submit('Search the news');
    await f.runtime.executeTurn({ ...ids, principal: a.principal, userId: f.identity.userId,
      signal: new AbortController().signal, emit: async () => {} });
    expect(web.executed).toHaveLength(1);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of f.fetcher.mock.calls) {
      expect(String(init?.body)).toContain('[Current mode: User]');
      expect(String(init?.body)).not.toContain('[Current mode: Dev]');
    }
    expect(consume).toHaveBeenCalledTimes(1);
    expect(a.mode.peek(a.principal)).toEqual({ mode: 'dev', announce: true });
  } finally { await f.dispose(); }
});

it('never validates, executes, or repairs a native web tool in Dev', async () => {
  const a = authority(); a.mode.setEnabled(true); a.mode.select(a.principal, 'dev');
  const { f, web } = fixture({ devMode: a.mode });
  const frames: StreamEnvelope[] = [];
  try {
    f.fetcher.mockResolvedValueOnce(sse(toolFrame('{"mode":"browse","query":"news"}')));
    const ids = await f.submit('Search the news');
    await f.runtime.executeTurn({ ...ids, principal: a.principal, userId: f.identity.userId,
      signal: new AbortController().signal, emit: async frame => { frames.push(frame); } });
    expect(web.port.validateInput).not.toHaveBeenCalled();
    expect(web.executed).toHaveLength(0);
    expect(frames.some(frame => ['web-sources', 'web-activity'].includes(frame.event.type))).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(f.fetcher.mock.calls[0]![1]?.body as string);
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body.messages)).toContain('[Current mode: Dev]');
  } finally { await f.dispose(); }
});

it('advertises web_tool only when enabled, eligible and tools-capable', async () => {
  for (const [options, expected] of [
    [{}, true], [{ enabled: false }, false], [{ prepared: false }, false], [{ tools: false }, false],
  ] as const) {
    const { f } = fixture(options);
    f.fetcher.mockResolvedValue(sse(textFrame('An ordinary answer.')));
    const ids = await f.submit('Hello');
    await f.execute(ids);
    const body = JSON.parse(f.fetcher.mock.calls[0]![1]?.body as string);
    const tools = (body.tools ?? []) as Array<{ function: { name: string } }>;
    expect(tools.some(tool => tool.function.name === 'web_tool')).toBe(expected);
    await f.dispose();
  }
});

it('executes one browse call, advertises it once, and returns linked sources', async () => {
  const { f, web } = fixture();
  f.fetcher
    .mockResolvedValueOnce(sse(toolFrame('{"mode":"browse","query":"news"}')))
    .mockResolvedValueOnce(sse(textFrame('Verified answer.')));
  const ids = await f.submit('Search the news');
  const frames: StreamEnvelope[] = [];
  await f.runtime.executeTurn({ userId: f.identity.userId, ...ids,
    signal: new AbortController().signal, emit: async frame => { frames.push(frame); } });
  const status = await f.runtime.getTurnStatus(f.identity.userId, ids.sessionId, ids.turnId);
  expect({ status: status.status, error: status.error }).toEqual({ status: 'completed', error: null });
  expect(web.executed).toHaveLength(1);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  const expectedId = `aurvin-${createHash('sha256')
    .update(JSON.stringify([f.identity.userId, ids.sessionId])).digest('hex')}`;
  const sent = f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(sent.map(body => body.session_id)).toEqual([expectedId, expectedId]);
  for (const body of sent) {
    expect(body.user).toBe(f.identity.userId);
    expect(body.sessionId).toBeUndefined();
  }
  const second = JSON.parse(f.fetcher.mock.calls[1]![1]?.body as string);
  const toolMessage = (second.messages as Array<{ role: string; tool_call_id?: string;
    content?: string }>).find(message => message.role === 'tool' && message.tool_call_id === 'web_1');
  expect(JSON.parse(toolMessage!.content!)).toEqual({ truncated: false,
    results: [{ url: 'https://example.com/', title: 'Example',
      body: 'Useful public evidence.' }] });
  const message = f.runtime.memoryMessages(f.identity.userId, ids.sessionId,
    { cursor: null, limit: 10 })?.items.at(-1);
  expect(message?.webSources?.[0]).toMatchObject({ toolCallId: 'web_1', provider: 'exa' });
  expect(message?.webActivities?.length).toBeGreaterThan(0);
  expect(frames.some(frame => frame.event.type === 'web-sources')).toBe(true);
  await f.dispose();
});

it('allows exactly three additional schema repairs and never dispatches invalid args', async () => {
  const { f, web } = fixture();
  for (let i = 0; i < 4; i++) {
    f.fetcher.mockResolvedValueOnce(sse(toolFrame('{"mode":"browse"}', `bad_${i}`, `gen_bad_${i}`)));
  }
  const ids = await f.submit('Search recent news');
  await f.execute(ids);
  expect(f.fetcher).toHaveBeenCalledTimes(4);
  expect(web.executed).toHaveLength(0);
  for (const call of f.fetcher.mock.calls.slice(1)) {
    const body = JSON.parse(call[1]?.body as string);
    const feedback = (body.messages as Array<{ role: string; content?: string }>)
      .filter(message => message.role === 'system')
      .map(message => { try { return JSON.parse(message.content ?? '') as { code?: string }; }
        catch { return null; } })
      .filter(value => value?.code === 'WEB_SCHEMA_INVALID');
    expect(feedback.length).toBeGreaterThan(0);
  }
  const message = f.runtime.memoryMessages(f.identity.userId, ids.sessionId,
    { cursor: null, limit: 10 })?.items.at(-1);
  expect(message?.content).toContain("couldn't verify");
  await f.dispose();
});

it('starts the post-search answer on a new paragraph after pre-tool narration', async () => {
  const { f } = fixture();
  f.fetcher
    .mockResolvedValueOnce(sse(preambleThenTool(
      'Let me look up the NRSV text for 1 Peter 3:5.',
      '{"mode":"browse","query":"1 Peter 3:5 NRSV"}',
    )))
    .mockResolvedValueOnce(sse(textFrame('Here is 1 Peter 3:5 from the NRSV.')));
  const ids = await f.submit('Show me 1 Peter 3:5 NRSV');
  await f.execute(ids);
  const message = f.runtime.memoryMessages(f.identity.userId, ids.sessionId,
    { cursor: null, limit: 10 })?.items.at(-1);
  expect(message?.content).toBe(
    'Let me look up the NRSV text for 1 Peter 3:5.\n\nHere is 1 Peter 3:5 from the NRSV.',
  );
  await f.dispose();
});

it('reuses one successful call ID without a second provider effect', async () => {
  const { f, web } = fixture();
  f.fetcher
    .mockResolvedValueOnce(sse(toolFrame('{"mode":"browse","query":"news"}', 'same')))
    .mockResolvedValueOnce(sse(toolFrame('{"mode":"browse","query":"news"}', 'same', 'gen_same_2')))
    .mockResolvedValueOnce(sse(textFrame('Verified once.')));
  const ids = await f.submit('Search the news twice');
  await f.execute(ids);
  expect(web.executed).toHaveLength(1);
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  await f.dispose();
});

