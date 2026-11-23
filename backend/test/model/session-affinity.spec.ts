/**
 * ============================================================================
 * FILE: session-affinity.spec.ts
 * LOCATION: backend/test/model/session-affinity.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify conversation-scoped OpenRouter routing using serialized requests.
 *
 * ROLE IN PROJECT:
 *    Exercises trusted accounting bindings without paid calls, preserving
 *    attribution, cache controls, and isolation from global tracing settings.
 *
 * KEY COMPONENTS:
 *    - dispatch: Capture wire bodies through deterministic provider fixtures.
 *    - Affinity regressions: Turns, retries, users, sessions, and privacy.
 * ============================================================================
 */

import type { AccountingRecord } from '../../src/contracts/metadata.js';
import { SKILL_NATIVE_TOOLS } from '../../src/contracts/calendar-tools.js';
import { WEB_TOOL_DEFINITION } from '../../src/contracts/web-search-tools.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { AccountingService } from '../../src/model/accounting.js';
import { OpenRouterCalendarAdapter } from '../../src/model/calendar-adapter.js';
import { CompactionRunner } from '../../src/model/compaction-runner.js';
import { OpenRouterAttemptAdapter } from '../../src/model/openrouter-adapter.js';
import { createWebNativeModelPort, webToolsFor } from '../../src/model/web-native.js';
import { chunk, done, FRAMES, usage } from '../fixtures/openrouter/frames.js';
import { calendarBinding, calendarLimits, skillRequest } from './calendar-fixtures.js';
import { collect, config, limits, request, response, seed, sink } from './helpers.js';

// Independently pinned: 'aurvin-' + sha256(JSON.stringify(['aurvin-dev-user','sess_fixture'])), computed outside production code.
const seedRoutingId = 'aurvin-799702a455993d6746cd0f8bb97d87b6ebfaf2f0469216e80311ff4c26cef9ea';

afterEach(() => vi.unstubAllEnvs());

async function dispatch(binding: Partial<AccountingRecord> = {}, rejectFirst = false, modelId = 'anthropic/fixture') {
  const record = { ...seed(), ...binding };
  const c = config();
  c.identity.userId = record.userId;
  c.openRouter.modelId = modelId;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(FRAMES.normal));
  if (rejectFirst) fetcher.mockResolvedValueOnce(new Response('{"error":{"code":429}}', { status: 429 }));
  const adapter = new OpenRouterAttemptAdapter(c, { ...limits, modelId: c.openRouter.modelId },
    { ...record, requestedModel: c.openRouter.modelId }, new AccountingService(c, sink(), fetcher),
    async () => {}, fetcher, () => 0);
  // Extra untrusted request fields must not override the durable binding.
  const input = { ...request(), user: record.userId, modelId: c.openRouter.modelId,
    sessionId: 'client-session', session_id: 'client-routing', trace: { name: 'client-trace' } };
  await collect(adapter.stream(input));
  return fetcher.mock.calls.map(([, init]) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a serialized request body.');
    return JSON.parse(init.body) as Record<string, unknown>;
  });
}

it('keeps explicit affinity across turns, attempt retries, and HTTP retries', async () => {
  const [first] = await dispatch();
  const [nextTurn] = await dispatch({ turnId: 'turn_next', attemptId: 'att_next' });
  const retry = await dispatch({ attemptId: 'att_retry' }, true);
  expect(first.session_id).toEqual(expect.any(String));
  expect(String(first.session_id).length).toBeLessThanOrEqual(256);
  expect(nextTurn.session_id).toBe(first.session_id);
  expect(retry).toHaveLength(2);
  for (const body of retry) expect(body.session_id).toBe(first.session_id);
});

it('isolates both users and sessions without ambiguous identifier concatenation', async () => {
  const bindings = [
    { userId: 'user_a', sessionId: 'session_a' },
    { userId: 'user_a', sessionId: 'session_b' },
    { userId: 'user_b', sessionId: 'session_a' },
    { userId: 'user_a_b', sessionId: 'session_a' },
    { userId: 'user_a', sessionId: 'b_session_a' },
  ];
  const keys = [];
  for (const binding of bindings) {
    const [body] = await dispatch(binding);
    expect(body.session_id).toEqual(expect.any(String));
    expect(String(body.session_id)).not.toContain(binding.userId);
    expect(String(body.session_id)).not.toContain(binding.sessionId);
    keys.push(body.session_id);
  }
  expect(new Set(keys).size).toBe(bindings.length);
});

it('ignores global/client routing and tracing while preserving cache controls and privacy', async () => {
  const [baseline] = await dispatch();
  vi.stubEnv('OPENROUTER_SESSION_ID', 'global-session');
  vi.stubEnv('OPENROUTER_TRACE', 'global-trace');
  const [body] = await dispatch();
  expect(body.session_id).toEqual(expect.any(String));
  expect(body.session_id).toBe(baseline.session_id);
  expect(body.session_id).not.toBe('global-session');
  expect(body.session_id).not.toBe('client-routing');
  expect(body).toMatchObject({ user: 'aurvin-dev-user', cache_control: { type: 'ephemeral' },
    transforms: [], provider: { data_collection: 'deny', require_parameters: true } });
  expect(body.plugins).toContainEqual({ id: 'context-compression', enabled: false });
  for (const field of ['trace', 'sessionId', 'apiKey', 'tools', 'tool_choice']) expect(body[field]).toBeUndefined();
});

it('matches plain session_id on Web-only wire and ignores request overrides', async () => {
  vi.stubEnv('OPENROUTER_SESSION_ID', 'global-session');
  vi.stubEnv('OPENROUTER_TRACE', 'global-trace');
  const c = { ...config(), sessionId: seed().sessionId };
  const [plain] = await dispatch({}, false, c.openRouter.modelId);
  expect(plain.session_id).toBe(seedRoutingId);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(FRAMES.normal));
  const port = createWebNativeModelPort(c, limits, fetcher);
  const req = {
    user: c.identity.userId, modelId: c.openRouter.modelId, maxOutputTokens: 256,
    remainingContextTokens: 8192, deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    signal: new AbortController().signal, dataCollection: 'deny' as const, advertised: true,
    messages: [{ role: 'user' as const, content: 'Search the news' }],
    tools: [WEB_TOOL_DEFINITION],
    session_id: 'client-routing', sessionId: 'client-session',
  };
  const out = await collect(port.stream(req));
  expect(out).toContainEqual(expect.objectContaining({
    type: 'decision', decision: expect.objectContaining({ kind: 'text' }),
  }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
  expect(body.session_id).toBe(plain.session_id);
  expect(body.provider).toEqual(plain.provider);
  expect(body.tools).toEqual([WEB_TOOL_DEFINITION]);
  for (const field of ['sessionId', 'trace', 'stream_options', 'cache_control']) {
    expect(body[field]).toBeUndefined();
  }
});

it.each([false, true])('matches plain session_id on Calendar wire (composite=%s)', async composite => {
  vi.stubEnv('OPENROUTER_SESSION_ID', 'global-session');
  vi.stubEnv('OPENROUTER_TRACE', 'global-trace');
  const c = config();
  const [plain] = await dispatch({}, false, c.openRouter.modelId);
  expect(plain.session_id).toBe(seedRoutingId);
  const binding = calendarBinding(composite ? 'continuation' : 'initial');
  const base = skillRequest();
  const req = {
    ...base,
    dispatchId: binding.dispatch.dispatchId,
    decisionId: binding.dispatch.decisionId,
    tools: composite ? webToolsFor(SKILL_NATIVE_TOOLS) : SKILL_NATIVE_TOOLS,
    session_id: 'client-routing',
    sessionId: 'client-session',
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(FRAMES.normal));
  const adapter = new OpenRouterCalendarAdapter(c, calendarLimits, binding, fetcher, undefined, composite);
  const out = await collect(adapter.stream(req));
  expect(out).toContainEqual(expect.objectContaining({
    type: 'decision', decision: expect.objectContaining({ kind: 'text' }),
  }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
  expect(body.session_id).toBe(plain.session_id);
  expect(body.provider).toEqual(plain.provider);
  expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(
    composite ? ['activate_skill', 'call_tool', 'control_canvas', 'get_environment', 'web_tool']
      : ['activate_skill', 'call_tool', 'control_canvas', 'get_environment'],
  );
  for (const field of ['sessionId', 'trace', 'stream_options', 'cache_control']) {
    expect(body[field]).toBeUndefined();
  }
});

it.each(['active-fork', 'custom'] as const)('preserves compaction routing in %s mode', async modelMode => {
  const { userId, sessionId } = seed();
  const c = config();
  const modelId = c.openRouter.modelId;
  const [plain] = await dispatch({}, false, modelId);
  expect(plain.session_id).toBe(seedRoutingId);
  const customModelId = modelMode === 'custom' ? 'fixture/summarizer' : null;
  const headings = COMPACTION_SECTIONS.map((title, i) => `## ${i + 1}. ${title}\nNone.`).join('\n\n');
  const raw = `<analysis>fixture</analysis>\n<summary>\n${headings}\n</summary>`;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(
    (chunk(raw, 'stop') + usage + done).replaceAll(modelId, customModelId ?? modelId),
  ));
  const runner = new CompactionRunner({ putAccounting: sink().putAccounting, fetcher });
  await runner.run({
    userId, sessionId, summaryId: 'sum-routing', compactionCycle: 1, turnId: 'turn-compaction',
    sourceRange: { fromSequence: 0, toSequence: 1, fromEventId: 'ev-0', toEventId: 'ev-1' },
    prefix: [{ role: 'system', content: 'Rules' }],
    previousSummary: null,
    deltaMessages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }],
    calendarProvenance: {
      containsCalendarContent: false, connectionId: null, connectionRevision: null,
      earliestExpiresAt: null, redactedAt: null,
    },
    budgets: c.budgets,
    openRouter: { ...c.openRouter, reasoningEffort: 'low' },
    modelLimits: limits,
    compaction: { enabled: true, watermarkRatio: 0.8, modelMode, customModelId },
    compactionModelLimits: customModelId ? { ...limits, modelId: customModelId } : null,
    signal: new AbortController().signal,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
  expect(body.session_id).toBe(plain.session_id);
  expect(body.model).toBe(customModelId ?? modelId);
  expect(body.provider).toEqual(plain.provider);
  expect(body.reasoning).toEqual(
    modelMode === 'custom' ? undefined : { effort: 'low', exclude: true },
  );
  for (const field of ['tools', 'tool_choice', 'sessionId', 'cache_control']) {
    expect(body[field]).toBeUndefined();
  }
});
