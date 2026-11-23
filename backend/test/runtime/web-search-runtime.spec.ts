/**
 * ============================================================================
 * FILE: web-search-runtime.spec.ts
 * LOCATION: backend/test/runtime/web-search-runtime.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify accepted-turn web counters, single-use execution, and no replay.
 *
 * ROLE IN PROJECT:
 *    Proves the P3 controller charges one logical call, reuses a completed
 *    native ID, and never dispatches invalid or disabled work.
 *
 * KEY COMPONENTS:
 *    - portFixture: Deterministic WebSearchPort with issued tickets.
 *    - WebTurn cases: 5/5 limits, duplicate IDs, disable, deadlines, repairs.
 * ============================================================================
 */

import type { WebSearchPort, ValidatedWebInput, WebCallContext } from '../../src/plugins/web-search/types.js';
import type { WebToolArguments, WebToolResult } from '../../src/contracts/web-search-tools.js';
import { validateWebCandidate } from '../../src/model/web-native.js';
import { WebTurn } from '../../src/chat-runtime/web-turn.js';

const candidate = (raw: string, id = 'good_1') => ({
  calls: [{ index: 0, id, type: 'function', name: 'web_tool',
    arguments: raw, envelopeInvalid: false }],
  terminal: 'tool_calls',
  envelopeInvalid: false,
});
const decision = (raw: string, id = 'good_1') => {
  const value = validateWebCandidate(candidate(raw, id), true);
  if (value.kind !== 'web_tool') throw new Error('Fixture must be a valid web decision.');
  return value;
};
const retrievedAt = '2026-11-14T00:00:00.000Z';
const browseResult: WebToolResult = { ok: true, mode: 'browse', provider: 'exa', retrievedAt,
  results: [{ url: 'https://example.com/', title: 'Example',
    body: 'Useful public evidence.' }], truncated: false };
const fetchResult: WebToolResult = { ok: true, mode: 'fetch', provider: 'exa', retrievedAt,
  url: 'https://example.com/', body: 'Public page.', truncated: false };

function portFixture(options: {
  enabled?: boolean; prepared?: boolean; browse?: boolean; fetch?: boolean;
  result?: (input: ValidatedWebInput) => WebToolResult;
} = {}) {
  const calls: ValidatedWebInput[] = [];
  const port: WebSearchPort = {
    snapshot: userId => ({
      userId, revision: 1, generation: 1,
      prepared: options.prepared ?? true, enabled: options.enabled ?? true,
      providers: [{ provider: 'exa', capabilities: {
        browse: options.browse ?? true, fetch: options.fetch ?? true,
      } }],
    }),
    validateInput: vi.fn(async (args: WebToolArguments, context: WebCallContext) => Object.freeze({
      args, userId: context.userId, turnId: context.turnId, toolCallId: context.toolCallId,
    })),
    execute: vi.fn(async (input: ValidatedWebInput, context?: WebCallContext) => {
      calls.push(input);
      context?.activity?.({ toolCallId: input.toolCallId, mode: input.args.mode,
        phase: input.args.mode === 'browse' ? 'searching' : 'reading', provider: null, code: null });
      const value: WebToolResult = options.result?.(input)
        ?? (input.args.mode === 'browse' ? browseResult : fetchResult);
      if (value.ok) context?.activity?.({ toolCallId: input.toolCallId, mode: input.args.mode,
        phase: 'completed', provider: 'exa', code: null });
      return value;
    }),
  };
  return { port, calls };
}

function turnFixture(port: WebSearchPort, options: {
  limits?: { maxSearchesPerTurn: number; maxFetchesPerTurn: number };
  advertised?: boolean; nowMs?: () => number; headroom?: () => boolean;
  signal?: AbortSignal;
} = {}) {
  return new WebTurn({
    port, identity: { userId: 'u1', openRouterUser: 'u1', source: 'authenticated-session' },
    sessionId: 's1', turnId: 't1',
    limits: options.limits ?? { maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 },
    advertised: options.advertised ?? true,
    acceptedAtMonotonic: 0, runTimeoutMs: 180_000, nowMs: options.nowMs ?? (() => 1),
    signal: options.signal ?? new AbortController().signal,
    present: () => undefined, headroom: options.headroom ?? (() => true),
  });
}

it('keeps a turn-wide 5/5 limit and never replays a successful ID', async () => {
  const { port } = portFixture();
  const turn = turnFixture(port);
  await turn.execute(decision('{"mode":"browse","query":"news"}'), 0);
  await turn.execute(decision('{"mode":"browse","query":"news"}'), 0);
  expect(port.execute).toHaveBeenCalledTimes(1);
  expect(turn.snapshot().counters).toMatchObject({ searchesUsed: 1, fetchesUsed: 0 });
});

it('charges five browse and five fetch calls and denies the sixth of either', async () => {
  const { port } = portFixture();
  const turn = turnFixture(port);
  for (let i = 0; i < 5; i++) {
    const group = await turn.execute(decision('{"mode":"browse","query":"news"}', `browse_${i}`), 0);
    expect('group' in group).toBe(true);
  }
  for (let i = 0; i < 5; i++) {
    const group = await turn.execute(decision('{"mode":"fetch","url":"https://example.com/"}', `fetch_${i}`), 0);
    expect('group' in group).toBe(true);
  }
  const sixthBrowse = await turn.execute(decision('{"mode":"browse","query":"news"}', 'browse_6'), 0);
  expect(sixthBrowse).toMatchObject({ failure: { ok: false, error: { code: 'WEB_SEARCH_LIMIT' } } });
  const sixthFetch = await turn.execute(decision('{"mode":"fetch","url":"https://example.com/"}', 'fetch_6'), 0);
  expect(sixthFetch).toMatchObject({ failure: { ok: false, error: { code: 'WEB_FETCH_LIMIT' } } });
  expect(port.execute).toHaveBeenCalledTimes(10);
});

it('reuses a completed ID only for identical arguments and rejects different arguments', async () => {
  const { port } = portFixture();
  const turn = turnFixture(port);
  await turn.execute(decision('{"mode":"browse","query":"news"}', 'same'), 0);
  const reused = await turn.execute(decision('{"mode":"browse","query":"news"}', 'same'), 0);
  expect('group' in reused && reused.reused).toBe(true);
  const conflict = await turn.execute(decision('{"mode":"browse","query":"other"}', 'same'), 0);
  expect(conflict).toMatchObject({ failure: { ok: false, error: { code: 'WEB_INTERRUPTED' } } });
  expect(port.execute).toHaveBeenCalledTimes(1);
});

it('sends zero provider work when disabled between validation and execute', async () => {
  let enabled = true;
  const { port } = portFixture();
  const turn = turnFixture(port);
  port.validateInput = vi.fn(async (args, context) => {
    enabled = false;
    return Object.freeze({ args, userId: context.userId, turnId: context.turnId,
      toolCallId: context.toolCallId });
  });
  port.snapshot = userId => ({ userId, revision: 2, generation: 2, prepared: true,
    enabled, providers: [{ provider: 'exa', capabilities: { browse: true, fetch: true } }] });
  const result = await turn.execute(decision('{"mode":"browse","query":"news"}'), 0);
  expect(result).toMatchObject({ failure: { ok: false, error: { code: 'WEB_DISABLED' } } });
  expect(port.execute).not.toHaveBeenCalled();
});

it('blocks at the exact web deadline without a provider call', async () => {
  const { port } = portFixture();
  const turn = turnFixture(port, { nowMs: () => 45_000 });
  const result = await turn.execute(decision('{"mode":"browse","query":"news"}'), 0);
  expect(result).toMatchObject({ failure: { ok: false, error: { code: 'WEB_DEADLINE_EXCEEDED' } } });
  expect(port.execute).not.toHaveBeenCalled();
});

it('counts every model attempt and stops at the finite model ceiling', async () => {
  const { port } = portFixture();
  const turn = turnFixture(port, { limits: { maxSearchesPerTurn: 1, maxFetchesPerTurn: 1 } });
  for (let i = 0; i < 7; i++) expect(turn.beforeModel()).toBe(true);
  expect(turn.beforeModel()).toBe(false);
  expect(turn.snapshot().counters.modelAttemptsUsed).toBe(7);
});

it('allows exactly three schema repairs and returns canonical feedback', async () => {
  const { port } = portFixture();
  const turn = turnFixture(port);
  for (let i = 0; i < 3; i++) {
    const repair = turn.repair([`query:required`], null);
    expect(repair).toMatchObject({ retry: true, code: 'WEB_SCHEMA_INVALID' });
    expect(repair.feedback).toContain('WEB_SCHEMA_INVALID');
  }
  expect(turn.repair(['query:required'], null))
    .toMatchObject({ retry: false, code: 'WEB_SCHEMA_REPAIR_EXHAUSTED' });
  expect(port.execute).not.toHaveBeenCalled();
});

it('maps an unexpected provider fault to a closed unavailable failure without retry', async () => {
  const { port } = portFixture();
  port.execute = vi.fn(async () => { throw new Error('raw provider secret'); });
  const turn = turnFixture(port);
  const result = await turn.execute(decision('{"mode":"browse","query":"news"}'), 0);
  expect(result).toMatchObject({ failure: { ok: false,
    error: { code: 'WEB_PROVIDER_UNAVAILABLE', retryable: true } } });
  expect(JSON.stringify(result)).not.toContain('raw provider secret');
  expect(port.execute).toHaveBeenCalledTimes(1);
});

it('freezes complete groups and bounded projections for archival', async () => {
  const { port } = portFixture();
  const turn = turnFixture(port);
  await turn.execute(decision('{"mode":"browse","query":"news"}'), 2);
  const state = turn.freeze();
  expect(state.groups).toHaveLength(1);
  expect(state.groups[0]).toMatchObject({ ordinal: 0, afterCalendarGroups: 2 });
  expect(state.sources).toHaveLength(1);
  expect(state.activities.length).toBeGreaterThan(0);
  expect(Object.isFrozen(state)).toBe(true);
});
