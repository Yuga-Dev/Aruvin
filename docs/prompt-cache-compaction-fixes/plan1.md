# Emergency Web Result Folding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rescue real native prompt overflow in MemoryText with a bounded, request-only projection of stale, validated Web evidence, without changing ordinarily admitted prompts.

**Architecture:** Run admission on the final native message order after inserting historical and live groups; only a history/total token overflow can trigger one projection, newest eligible result first. Keep validated historical group provenance alongside its wire result index, protect the active and last three historical turns plus pending proposal or unfinished turns, and reserve/send only the final admitted request. If the first request still cannot fit, use the existing bounded compaction/reassembly fallback; never start checkpoint work from a live tool continuation.

**Tech Stack:** Backend TypeScript/NodeNext, LangGraph, Zod, Vitest, existing OpenRouter SSE and in-memory persistence fixtures.

---

## Scope and file map

Source of truth: [goal.md](goal.md), criterion 1 (live admission only) and the verification paragraph. Work in the user-selected `main` checkout. Preserve existing user changes, especially in `memory-text.ts`, `calendar-loop.ts` and `compaction-runtime.spec.ts`. Research and unified review are skipped. Stage/commit only through the orchestrator; task commit subjects below are handoff labels.

- `backend/src/context/tool-folding.ts` and `backend/test/context/tool-folding.spec.ts`: Replace the now-unused generic folding behavior with a single pure Web projection; only the old MemoryText Web path calls the generic helper in production. Replace experimental tests that expected lossy Calendar, title-based Canvas and generic result folding with tests proving they stay untouched. Do not touch existing Calendar redaction or Canvas ownership code.
- `backend/src/context/web-context.ts`: Track validated historical Web insertions and share native admission between Web-only and Calendar/composite. Keep the existing `insertWebGroups(messages, positions, groups)` array-returning interface for context tests; an optional caller-owned candidate array captures result indices. The current Web merge and its duplicate/collision validation stay here.
- `backend/src/context/calendar-context.ts` and `backend/src/chat-runtime/calendar-loop.ts`: Assemble/redact/validate as now, merge current Web groups before the final token gate, reserve from the admitted estimate. Pass optional folding eligibility in **MemoryText** only; the durable Calendar path does not opt in. Leave catalog position and Canvas layout/state alone.
- `backend/src/chat-runtime/memory-text.ts`: Build eligibility from trusted memory records, preflight the route that actually dispatches, rebuild from source after fallback, and finalize each Web request after admission. Do not alter attachment or persistence contracts, the summary prompt, model routing, or the underlying active-handle rebase (P4).
- `backend/test/runtime/web-search-followup-verify.spec.ts`: Add actual mocked OpenRouter POST assertions using the existing Web and Calendar fixtures. Keep the existing short two-turn overflow test (it must remain a rejection) and append-only tests.

## Task 1: Narrow the projection to validated Web results

**Files:** `backend/src/context/tool-folding.ts`, `backend/test/context/tool-folding.spec.ts`.

- [ ] **Write focused RED tests.** Replace the broad-helper spec with the following, keeping its file header and updating the header purpose. Reuse these fixtures in unit cases; live tests in Task 3 use results from the actual `WebTurn` pipeline.

```ts
import { expect, it } from 'vitest';
import { webToolGroupSchema } from '../../src/chat-runtime/memory-web-state.js';
import { foldHistoricalWebResult, type FoldedWebEvidence } from '../../src/context/tool-folding.js';

const url = 'https://example.test/A%2Fb?q=one%20two#Exact';
const stamp = '2026-11-14T00:00:00.000Z';
const makeGroup = () => webToolGroupSchema.parse({
  ordinal: 0, afterCalendarGroups: 0,
  assistant: { role: 'assistant', content: null, tool_calls: [{
    id: 'reused', type: 'function',
    function: { name: 'web_tool', arguments: '{"mode":"fetch","url":"https://example.test/request"}' },
  }] },
  result: { role: 'tool', name: 'web_tool', tool_call_id: 'reused',
    content: JSON.stringify({ truncated: false, url, body: `Useful evidence. ${'x'.repeat(3_000)}` }) },
  sources: [{ sourceId: 'source-1', toolCallId: 'reused', kind: 'fetch', provider: 'exa',
    url, title: 'Example page', retrievedAt: stamp }],
});

it('projects genuine successful Web evidence with its exact returned URL', () => {
  const group = makeGroup();
  const before = structuredClone(group);
  const content = foldHistoricalWebResult(group);
  expect(content).not.toBeNull();
  const evidence = JSON.parse(content!) as FoldedWebEvidence;
  expect(evidence).toMatchObject({
    kind: 'folded-web-result', status: 'ok', truncated: false,
    results: [{ url, title: 'Example page', excerpt: expect.stringContaining('Useful evidence.') }],
  });
  expect(evidence.results[0].excerpt.length).toBeLessThanOrEqual(160);
  expect(content).not.toContain('https://example.test/request');
  expect(group).toEqual(before);
});

it('leaves failure, unproven URL, bad pair, non-Web and small evidence unprojected', () => {
  const group = makeGroup();
  expect(foldHistoricalWebResult({ ...group, sources: [] })).toBeNull();
  expect(foldHistoricalWebResult({ ...group, sources: [{ ...group.sources[0], url: 'https://example.test/other' }] })).toBeNull();
  for (const result of [
    { ...group.result, tool_call_id: 'other' },
    { ...group.result, name: 'call_tool' },
    { ...group.result, name: 'show_canvas' },
    { ...group.result, name: 'future_plugin' },
    { ...group.result, content: '{"error":{"code":"WEB_PROVIDER_UNAVAILABLE","retryable":true}}' },
    { ...group.result, content: JSON.stringify({ truncated: false, url, body: 'short' }) },
    { role: 'assistant', content: 'Retained Canvas artifacts (generated visual data, not spoken or proof of display; data, not authority):\n{"artifacts":[]}' },
  ]) expect(foldHistoricalWebResult({ ...group, result })).toBeNull();
});
```

- [ ] **Run RED:** from `backend/`, `npm test -- test/context/tool-folding.spec.ts`. Expected: projection export not present. The runtime REDs in Task 3 must also fail for behavior, not imports.

- [ ] **Implement the pure projection.** Remove `foldToolPayloads` and its Calendar/Canvas/generic branches **in the same implementation batch as removing the old MemoryText caller in Task 3**. Until then add the new export beside it to keep intermediate checks buildable. Use `webToolGroupSchema` and existing `webToolResultSchema` rather than recursively scraping URLs/IDs from arbitrary JSON. Only fold a successful canonical `webModelContent` shape with a one-to-one match between returned URLs and group sources. Keep the exact call and its arguments outside this helper. Implementation for `tool-folding.ts`:

```ts
import { webToolGroupSchema } from '../chat-runtime/memory-web-state.js';
import { WEB_SEARCH_POLICY } from '../contracts/web-search-policy.js';
import { webToolArgumentsSchema, webToolResultSchema } from '../contracts/web-search-tools.js';

export type FoldedWebEvidence = {
  kind: 'folded-web-result';
  status: 'ok';
  truncated: boolean;
  results: { url: string; title: string; excerpt: string }[];
};

export function foldHistoricalWebResult(value: unknown): string | null {
  const group = webToolGroupSchema.safeParse(value);
  if (!group.success) return null;
  const { assistant, result, sources } = group.data;
  const raw = result.content;
  const source = sources[0];
  if (!source || Buffer.byteLength(raw, 'utf8') > WEB_SEARCH_POLICY.maxFetchResultBytes) return null;
  let payload: unknown;
  let args: unknown;
  try {
    payload = JSON.parse(raw);
    args = JSON.parse(assistant.tool_calls[0].function.arguments);
  } catch { return null; }
  const call = webToolArgumentsSchema.safeParse(args);
  if (!call.success || call.data.mode !== source.kind ||
      !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const parsed = webToolResultSchema.safeParse({
    ...payload, ok: true, mode: source.kind, provider: source.provider, retrievedAt: source.retrievedAt,
  });
  if (!parsed.success || !parsed.data.ok || 'error' in payload) return null;
  const data = parsed.data;
  const entries = data.mode === 'browse'
    ? data.results : [{ url: data.url, title: source.title, body: data.body }];
  if (entries.length !== sources.length || entries.some((entry, index) => {
    const known = sources[index];
    return entry.url !== known.url || entry.title !== known.title || known.kind !== data.mode ||
      known.provider !== source.provider || known.retrievedAt !== source.retrievedAt;
  })) return null;

  const folded: FoldedWebEvidence = {
    kind: 'folded-web-result', status: 'ok', truncated: data.truncated,
    results: entries.map(entry => ({ url: entry.url, title: entry.title, excerpt: entry.body.slice(0, 160) })),
  };
  const content = JSON.stringify(folded);
  return Buffer.byteLength(JSON.stringify(content), 'utf8') <
    Buffer.byteLength(JSON.stringify(raw), 'utf8') ? content : null;
}
```

A Web failure is already small and informative; unreadable, legacy, unproven or non-shrinking content is not a candidate, not a new admission error. Include this browse case with the RED tests above:

```ts
it('preserves every proved browse URL and its own excerpt, in order', () => {
  const group = makeGroup();
  const urls = [url, `${url}-2`];
  const results = urls.map((url, i) => ({ url, title: `Page ${i}`, body: `${i}${'b'.repeat(319)}` }));
  const sources = results.map(({ url, title }, i) => ({
    ...group.sources[0], url, title, sourceId: `browse-${i}`, kind: 'browse',
  }));
  const call = group.assistant.tool_calls[0];
  const browse = { ...group, sources, assistant: { ...group.assistant, tool_calls: [{
    ...call, function: { ...call.function, arguments: '{"mode":"browse","query":"fixture"}' },
  }] }, result: { ...group.result, content: JSON.stringify({ truncated: true, results }) } };
  const content = foldHistoricalWebResult(browse);
  expect(content).not.toBeNull();
  expect(JSON.parse(content!)).toMatchObject({
    truncated: true, results: results.map(({ url, title, body }) => ({ url, title, excerpt: body.slice(0, 160) })),
  });
  expect(foldHistoricalWebResult({ ...browse, sources: [sources[0], { ...sources[1], url: `${url}-unproved` }] }))
    .toBeNull();
});
```

- [ ] **Run GREEN:** `npm test -- test/context/tool-folding.spec.ts`. Expected: pass. Handoff label: `feat(prompt-cache): define bounded Web evidence projection`.

## Task 2: Admit the final native prompt with an overflow-only retry

**Files:** `backend/src/context/web-context.ts`, `backend/src/context/calendar-context.ts`, `backend/src/chat-runtime/calendar-loop.ts`, `backend/test/context/history-budget.spec.ts`.

- [ ] **Add RED coverage for native history limits and cutoff.** Append this case to `history-budget.spec.ts`, importing `admitNativePrompt`, `type HistoricalWebResult` from `web-context.js` and `webToolGroupSchema` from `memory-web-state.js`; use the existing `WEB_TOOL_DEFINITION` import. This tests actual wire array order, reused IDs, a protected pending turn and stopping at the latest possible changed message. Keep existing tests for both initial and current Web group budget enforcement.

```ts
it('folds only the newest necessary stale Web result, never a pinned or recent one', () => {
  const make = (i: number) => {
    const url = `https://example.test/${i}`;
    return webToolGroupSchema.parse({
      ordinal: 0, afterCalendarGroups: 0,
      assistant: { role: 'assistant', content: null, tool_calls: [{
        id: 'same-call', type: 'function',
        function: { name: 'web_tool', arguments: JSON.stringify({ mode: 'fetch', url }) },
      }] },
      result: { role: 'tool', name: 'web_tool', tool_call_id: 'same-call',
        content: JSON.stringify({ url, truncated: false, body: 'w'.repeat(1_600) }) },
      sources: [{ sourceId: `source-${i}`, toolCallId: 'same-call', url, title: `Title ${i}`,
        kind: 'fetch', provider: 'exa', retrievedAt: '2026-11-14T00:00:00.000Z' }],
    });
  };
  const groups = Array.from({ length: 7 }, (_, i) => make(i));
  const user = { role: 'user' as const, content: 'Identical accepted input' };
  const messages = groups.flatMap(g => [user, g.assistant, g.result]);
  const historicalWebResults: HistoricalWebResult[] = groups.slice(0, -1).map((group, i) => ({
    group, turnId: `t${i}`, resultIndex: i * 3 + 2,
  }));
  const size = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 32 * messages.length;
  const budgets = { maxHistoryTokens: size - 400, maxContextTokens: 24_000,
    maxOutputTokens: 100, modelMarginTokens: 100, maxMessagesInContext: 80 };
  const input = { messages, prefixCount: 0, tools: [WEB_TOOL_DEFINITION], budgets,
    contextTokens: 24_000, historicalWebResults, foldableTurnIds: new Set(['t0', 't1']) };
  const admitted = admitNativePrompt(input);
  expect(admitted.messages.slice(0, 5)).toEqual(messages.slice(0, 5));
  expect(admitted.messages[5]).toMatchObject({ name: 'web_tool', tool_call_id: 'same-call',
    content: expect.stringContaining('"kind":"folded-web-result"') });
  expect(admitted.messages.slice(6)).toEqual(messages.slice(6));
  expect(admitNativePrompt({ ...input, budgets: { ...budgets, maxHistoryTokens: size } }).messages).toBe(messages);
  expect(() => admitNativePrompt({ ...input, budgets: { ...budgets, maxMessagesInContext: 20 } }))
    .toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
  expect(() => admitNativePrompt({ ...input, foldableTurnIds: new Set(['t3', 't4', 't5']) }))
    .toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
});
```

- [ ] **Run RED:** `npm test -- test/context/history-budget.spec.ts -t "newest necessary stale"`. Expected: no shared admission export. Record the existing `calendar-context.spec.ts` behavior for authority/expiry and ordinary ordering; do not weaken those assertions.

- [ ] **Implement shared admission in `web-context.ts`.** Import `foldHistoricalWebResult` and use the existing `bytes`, `contextLimit`, `HISTORY_BUDGET_MESSAGE`, and `estimateMessagesTokens`. Make `WebContextResult.messages` readonly (callers do not need to mutate admission output); if a public standalone Calendar type needs mutable messages, keep its existing concrete array type and use the corresponding admitted result type only for the runtime wrapper. Admission expects already validated native assembly; it does not authorize or replace validation. The fourth-from-last real `user` position in the **final native array** is the protected cutoff (active + recent three; no safe fold if fewer). Only real user roles count, never equality of text. Because admitted edits only replace one JSON object in place, its exact encoded size delta applies to both limits, with no group reordering or repeated full prompt serialization per candidate.

```ts
export type HistoricalWebResult = { turnId: string; resultIndex: number; group: WebToolGroup };
type NativeAdmission = Pick<WebContextInput, 'budgets' | 'contextTokens' | 'tools' | 'prefixCount'> & {
  messages: readonly WebNativeMessage[];
  historicalWebResults?: readonly HistoricalWebResult[];
  foldableTurnIds?: ReadonlySet<string>;
  totalOverflowMessage?: string;
};

export function admitNativePrompt(input: NativeAdmission): WebContextResult {
  const { messages, budgets, prefixCount, tools } = input;
  const remainingContextTokens = Math.min(budgets.maxContextTokens, input.contextTokens)
    - budgets.maxOutputTokens - budgets.modelMarginTokens;
  const estimate = (m: readonly WebNativeMessage[]) => 64 + bytes({ messages: m, tools }) + m.length * 32;
  const overflow = (m: readonly WebNativeMessage[]) => ({
    history: estimateMessagesTokens(m.slice(prefixCount)) - budgets.maxHistoryTokens,
    total: estimate(m) - remainingContextTokens,
  });
  const first = overflow(messages);
  const failure = (history: number): never =>
    contextLimit(history > 0 ? HISTORY_BUDGET_MESSAGE : input.totalOverflowMessage);
  const countTooLarge = messages.length > budgets.maxMessagesInContext;
  let needed = Math.max(first.history, first.total);
  if (needed <= 0 && !countTooLarge) {
    return { messages, estimatedInputTokens: first.total + remainingContextTokens, remainingContextTokens };
  }
  if (countTooLarge || !input.foldableTurnIds?.size || !input.historicalWebResults?.length) {
    return failure(first.history);
  }
  let tailStart = -1;
  let users = 0;
  for (let i = messages.length - 1; i >= prefixCount; i--) {
    if (messages[i].role === 'user' && ++users === 4) { tailStart = i; break; }
  }
  let projected: WebNativeMessage[] | undefined;
  for (const { group, resultIndex, turnId } of input.historicalWebResults.toReversed()) {
    if (resultIndex <= prefixCount || resultIndex >= tailStart || !input.foldableTurnIds.has(turnId)
      || messages[resultIndex] !== group.result || messages[resultIndex - 1] !== group.assistant) continue;
    const content = foldHistoricalWebResult(group);
    if (!content) continue;
    const result = { ...group.result, content };
    const saved = bytes(group.result) - bytes(result);
    if (saved <= 0) continue;
    (projected ??= [...messages])[resultIndex] = result;
    needed -= saved;
    if (needed <= 0) break;
  }
  if (projected) {
    const final = overflow(projected);
    if (final.history <= 0 && final.total <= 0) {
      return { messages: projected, estimatedInputTokens: final.total + remainingContextTokens, remainingContextTokens };
    }
    return failure(final.history);
  }
  return failure(first.history);
}
```

- [ ] **Carry insertion positions without changing ordinary order.** Have `webInsertions` return `Map<number, { turnId: string; groups: WebToolGroup[] }>` and change `insertions.set(index, parsed)` to `insertions.set(index, { turnId, groups: parsed })`. Reuse the same append function in Calendar's historical loop and last-anchor branch. Never register current groups. `rebuildCalendarMessages` currently preserves historical Web object identity; do not introduce a map that clones them after registering the candidates. If that invariant changes, remap at the actual insertion, not by IDs or content.

```ts
export function appendHistoricalWebGroups(
  out: WebNativeMessage[],
  insertion: { turnId: string; groups: WebToolGroup[] } | undefined,
  candidates?: HistoricalWebResult[],
): void {
  if (!insertion) return;
  for (const group of insertion.groups) {
    out.push(group.assistant, group.result);
    candidates?.push({ turnId: insertion.turnId, group, resultIndex: out.length - 1 });
  }
}
```

Add optional `candidates?: HistoricalWebResult[]` as the fourth `insertWebGroups` parameter. Replace its inner loop with `appendHistoricalWebGroups(out, insertions.get(index), candidates)`. Add optional `historicalWebResults` and `foldableTurnIds` to `WebContextInput`; replace only its old history/total limit block with `return admitNativePrompt({ ...input, messages });`. The current Web splice is after the active user, so no historical candidate offsets move. Keep all Zod checks and current-group ID collisions in place.

- [ ] **Make Calendar's final gate run once, after current groups.** In `calendar-context.ts`, expose optional `foldableTurnIds?: ReadonlySet<string>`, plus optional internal `web?: Pick<WebContextInput, 'webGroups' | 'tools' | 'contextTokens'>` and `contextTokens?: number`. Allocate `const candidates = input.foldableTurnIds?.size ? [] as HistoricalWebResult[] : undefined;`. Replace both historical Web loops with `appendHistoricalWebGroups(prefix, web.get(index), candidates)` (use the last base index in the second call). Leave `assertGroups`, origin ordering, note handling and `rebuildCalendarMessages` intact. Preserve `nativePrefixCount` and loaded skills extraction; change the output message type to readonly as needed and replace the old token block with:

```ts
const admission = { budgets: input.budgets, prefixCount: nativePrefixCount,
  historicalWebResults: candidates?.filter(({ group }) =>
    Buffer.byteLength(group.assistant.tool_calls[0].function.arguments, 'utf8') <= input.limits.argumentBytes &&
    Buffer.byteLength(group.result.content, 'utf8') <= input.limits.resultBytes),
  foldableTurnIds: input.foldableTurnIds };
const admitted = input.web
  ? webContext({ ...input.web, ...admission, calendarMessages: messages })
  : admitNativePrompt({ ...admission, messages,
      contextTokens: input.contextTokens ?? input.budgets.maxContextTokens,
      totalOverflowMessage: 'This chat has reached its context limit. Start a new chat.',
      tools: nativeToolDefinitions(input.tools) });
return { ...admitted, loadedSkills: loadedSkillRevisions(admitted.messages), prefixCount: nativePrefixCount };
```

`nativeToolDefinitions` replaces the old `estimateCalendarInput` import here; the numeric reservation estimate is identical on admitted ordinary prompts. Preserve Calendar-only overflow guidance. The candidate filter only prevents use of Stage 1 to evade a transport per-group limit; it does not drop such a pair from the prompt. The old intermediate Calendar token/count check was strictly weaker than the merged final check (same prefix boundary, additional current groups and serialized definitions): removing that intermediate gate does **not** remove `assertGroups`, account/source and native validation, transport byte caps, model ceiling, spend reservation, or the final adapter's checks.

In `assembleTurnCalendarContext`, keep its exact existing historical authority filtering before calling `calendarContext`. Add optional `foldableTurnIds` to its parameter type and `CalendarLoopContext`, forward through `CalendarLoop.assemble`, and replace the two-stage return with the following additions to the existing `calendarContext` argument:

```ts
foldableTurnIds: params.foldableTurnIds,
contextTokens: params.snapshot.modelLimits?.contextTokens,
...(params.webGroups ? { web: {
  webGroups: params.webGroups,
  tools: webNativeToolsFor(SKILL_NATIVE_TOOLS),
  contextTokens: params.snapshot.modelLimits?.contextTokens ?? params.snapshot.budgets.maxContextTokens,
} } : {}),
```

Keep `CalendarLoop.decide` constructing the request from `assembled.messages`, with `reserveDispatch(reason, assembled, repair)` unchanged. No edits to `buildCalendarBody`, native definitions or provider routing in P1. Calendar source admission must run before Web candidates can shrink anything. For example, a Calendar group rejected by `assertGroups` must not become accepted after folding Web.

- [ ] **Run GREEN:** `npm test -- test/context/tool-folding.spec.ts test/context/history-budget.spec.ts test/context/calendar-context.spec.ts test/model/calendar-policy.spec.ts`. Expected: pass, and existing Calendar and current-Web failures still reject. Handoff label: `fix(prompt-cache): admit final native prompt with bounded Web folding`.

## Task 3: Prove and wire overflow rescue in MemoryText

**Files:** `backend/test/runtime/web-search-followup-verify.spec.ts`, `backend/src/chat-runtime/memory-text.ts`.

- [ ] **Add RED wire cases using the current fixtures.** Add this mock factory to `web-search-followup-verify.spec.ts`; import `type { RuntimeDependencies }` from `../../src/chat-runtime/ports.js`. In `plainFixture`, create `save` with `fixtureSave()` before making `f`, pass it in `memoryFirst`, and return `{ f, web, snapshot, save }`. In `compositeFixture(memoryOnly = false)`, create the same spy, spread `...(memoryOnly ? { save } : {})` in the memory-first options, and return `{ f, web, memory, save }`. Leave the hydration case's archive behavior unchanged.

```ts
function fixtureSave() {
  type Save = NonNullable<NonNullable<RuntimeDependencies['memoryFirst']>['save']>;
  return vi.fn<Save>(async e => ({ kind: 'saved', epoch: e.epoch, sessionId: e.sessionId,
    version: e.version, fence: e.fence }));
}
```

Append the following test to `web-search-followup-verify.spec.ts`, importing `estimateMessagesTokens`, and use the existing snapshot fixture and `Body` shape. A single repeated input plus reused historical call ID catches searching by content or starting at the prefix. Derive ceilings from the wire instead of relying on the default prompt assets or a non-overflowing 900-byte snippet.

```ts
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
      expect(new URL(String(request)).pathname).toBe('/api/v1/chat/completions');
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
```

The storage counters are sampled at transport entry, not after archival. Capture POSTs, not a draft context or adapter input. If adding more spies, retain a simple `Array<{ mock: { calls: readonly unknown[] } }>` annotation so heterogeneous mock signatures do not narrow `push`.

- [ ] **Strengthen the protected-only first-dispatch case.** In the existing `fails closed when historical web evidence exceeds the context budget` two-turn test, after execute add `expect(f.fetcher).toHaveBeenCalledTimes(2);`. Keep the two status assertions. Recent native results must not be dropped/folded. The new protected-continuation row separately tests initial rescue followed by budget rejection: the maximum two old result savings are below `6_100` bytes even with empty bodies; after the initial `3_000`-byte shortfall, the additional new `3_950`-byte body alone exceeds the remaining possible savings. No retries, checkpoint wait or extra POST in continuation failure.

- [ ] **Run wire RED before enabling folding on either route:** `npm test -- test/runtime/web-search-followup-verify.spec.ts -t "rescues|fails closed"`. Expected: rescue cases fail at POST count or terminal status; the protected-only companion remains green. On the original Web history case the old helper may estimate a smaller array but the request still points at the original; on composite the history/total gate rejects before a successful POST. If a test fails before provider emulation (fixture schema, mismatched snapshot or accepted-turn size), fix the fixture and reconfirm behavioral RED. Run `npm test -- test/runtime/compaction-runtime.spec.ts -t "triggers compaction preflight"` on the starting checkout before runtime edits; if `Invalid memory turn handle` is present, give the exact repro to P4 without editing its regression.

- [ ] **Wire memory eligibility and the exact outbound request.** Capture `foldableTurnIds` alongside historical maps (reuse the terminal assistant status from existing memory records, and exclude the explicit proposal pin). Example addition to `buildHistoricalGroups`, after filtering the two maps:

```ts
const pinned = cold.pendingProposal?.originatingTurnId;
const foldableTurnIds = new Set(records.filter(record => record.role === 'assistant'
  && (record.completionStatus === 'completed' || record.completionStatus === 'truncated')
  && record.turnId !== c.turnId && record.turnId !== pinned
  && historicalWebGroups.has(record.turnId)).map(record => record.turnId));
return { historicalWebGroups, historicalGroups, initialGroups, foldableTurnIds };
```

The live Web groups, retry predecessor, loaded skill schemas, repaired input, Canvas state/artifacts, and redacted/valid Calendar groups are not candidates. Check the cold/bootstrap inputs contain valid terminal records (if the cutoff lacks a completed marker, fail conservative). Destructure and refresh eligibility, maps and `readyContext` together after successful fallback reassembly. When a loop can update `cold.pendingProposal` during the active turn, `CalendarLoop.assemble` must additionally exclude `this.ctx.memory?.pendingProposal?.originatingTurnId` if that state can advance, or supply a current `() => ReadonlySet<string>` from MemoryText that removes the current pin without re-reading storage. Existing current-turn proposal evidence is always protected by cutoff and candidate origin.

At the start of the Web-only path, build a base from canonical context and a fresh candidate array:

```ts
const assembleWebBase = () => {
  const positioned = readyContext as Partial<PositionedContext>;
  const historicalWebResults: HistoricalWebResult[] = [];
  const messages = insertWebGroups(readyContext.messages, positioned.historyPositions ?? [],
    historicalWebGroups, historicalWebResults);
  const admit = (candidate: readonly WebNativeMessage[]) => admitNativePrompt({
    messages: candidate, prefixCount: positioned.prefixCount ?? 0, historicalWebResults,
    foldableTurnIds, budgets: snapshot.budgets, tools: [WEB_TOOL_DEFINITION],
    contextTokens: snapshot.modelLimits!.contextTokens,
  });
  return { messages, admit };
};
```

Define this closure just before native preflight (not inside an adapter); make web preflight obtain `{ messages, admit }` and call `admit(messages)` before graph/voice start. Keep the admitted initial request in a local alongside the corresponding raw base so the loop need not re-admit it. Web loop shape:

```ts
const { messages: base, admit } = preparedWeb!;
let messages: WebNativeMessage[] = [...base];
// Inside the existing guarded loop, before constructing request:
const admitted = iteration === 0 ? preparedWeb!.initial : admit(messages);
const request = { messages: admitted.messages, tools: [WEB_TOOL_DEFINITION] as const, user: c.userId,
  modelId: snapshot.openRouter.modelId, maxOutputTokens: snapshot.budgets.maxOutputTokens,
  remainingContextTokens: admitted.remainingContextTokens,
  deadlineAt: new Date(Date.parse(e.turn.createdAt) + snapshot.budgets.totalRunTimeoutMs).toISOString(),
  signal: job.signal, dataCollection: 'deny' as const, advertised: true };
```

Keep the existing repair/result appends against **raw** `messages` (not `admitted.messages`); every dispatch independently uses the smallest necessary projection and canonical state remains unchanged. Preserve adapter stream, `beforeModel`, job abort/deadline and iteration limits. Remove the old `foldToolPayloads` import/use, then delete its deprecated implementation from Task 1. Leave `createWebNativeModelPort` and `request`'s transport shape otherwise alone for P3.

- [ ] **Use one native preflight/fallback branch.** Replace `preflightCalendar` with native route selection: when `snapshot.modelLimits?.calendar?.tools && !e.native` call `assembleTurnCalendarContext` with existing args plus `foldableTurnIds`; when `!snapshot.modelLimits?.calendar?.tools && e.web` prepare Web base/initial using:

```ts
const base = assembleWebBase();
preparedWeb = { ...base, initial: base.admit(base.messages) };
```

Type `preparedWeb` as `(ReturnType<typeof assembleWebBase> & { initial: WebContextResult }) | undefined`. Leave plain and already-in-flight Calendar paths alone. On first-dispatch native `CONTEXT_BUDGET_EXCEEDED` only, use at most one wait on existing compaction followed by at most one forced schedule/eligible wait and one final retry. Reacquire admission from the same route on every attempt. A `Work.wait` timeout is **not** suitable (it quarantines for persistence); bound each wait by the existing `job.signal`/total run deadline and detach its listener. No compaction scheduling from continuation, no retry on provenance/schema errors, no budget relaxation. Keep helper local to `execute`, leaving rebase mechanics to P4:

```ts
const waitForCompaction = async (running: Promise<unknown>) => {
  await new Promise<void>(resolve => {
    const done = () => { job.signal.removeEventListener('abort', done); resolve(); };
    job.signal.addEventListener('abort', done, { once: true });
    void running.then(done, done);
    if (job.signal.aborted) done();
  });
  job.check();
};
const fitsNative = () => {
  try { preflightNative(); return true; }
  catch (error) {
    if (!(error instanceof AppError && error.code === 'CONTEXT_BUDGET_EXCEEDED')) throw error;
    return false;
  }
};
const refreshAfterWait = async (running: Promise<unknown>) => {
  await waitForCompaction(running);
  const next = await rebaseAndReassemble();
  if (!next.ok) throw new AppError('CONTEXT_BUDGET_EXCEEDED', next.overflow.message, false);
  readyContext = next.context;
  ({ historicalWebGroups, historicalGroups, initialGroups, foldableTurnIds } = buildHistoricalGroups(source.records));
};
if (!fitsNative()) {
  const pending = cold.compaction?.running;
  if (pending) await refreshAfterWait(pending);
  if (!pending || !fitsNative()) {
    this.scheduleCompactionIfNeeded(c.sessionId, snapshot, true);
    const running = cold.compaction?.running;
    if (running && running !== pending) await refreshAfterWait(running);
    preflightNative(); // Throws the current exact budget error if still too large.
  }
}
```

The earlier referenced-text assembler has no Web groups and cannot be rescued by Web folding if that protected base alone overflows. Preserve its fallback policy; optionally reuse the same abort-aware wait there only if needed to bound an existing unguarded await, keeping the rebase API unchanged. Do not move the normal post-completion watermark scheduler or count projected bytes as canonical utilization. The no-extra-dispatch test with compaction enabled keeps canonical usage below watermark; a checkpoint independently scheduled under existing policy is not an effect of Stage 1.

- [ ] **Run GREEN and hand off.** `npm test -- test/runtime/web-search-followup-verify.spec.ts test/runtime/web-search-calendar.spec.ts test/runtime/web-search-loop.spec.ts test/context/tool-folding.spec.ts test/context/history-budget.spec.ts test/context/calendar-context.spec.ts`. Expect exact final folded wire results only on real overflow, literal ordinary prefixes, correct source/tool identity and unchanged protected continuation. Finish P1 as a single atomic change if Tasks 1–2 are not handed off separately; commit label `fix(prompt-cache): rescue native overflow before final dispatch`. Leave no cross-owner edits in the shared index.

## Verification and handoff

- [ ] **Check authority, barriers, and ordinary routes from `backend/`:**

```powershell
npm test -- test/performance/calendar-tool-latency.spec.ts test/performance/web-search-latency.spec.ts
npm test -- test/runtime/compaction-runtime.spec.ts test/runtime/web-search-followup-verify.spec.ts test/voice/web-search-voice.spec.ts
npm run build
npm run lint
npm test
```

Expected: focused suites pass, including prepared Calendar access under blocked storage, held archive/continuation, cancellation, invalidation/expiry, and Web-only/composite behavior. Report any reproduced baseline Calendar/voice rebase failure separately to P4 (do not call a failing suite green); rerun after P4. Record actual commands and outcomes; no live/paid provider, Mongo integration, cache savings or SLA claims. Measurements after rollout belong to existing usage/timing evidence (prompt/completion/cost, cache read/write, time to first text/audio); fixture results only establish request shape and counts.

- **P2:** `calendarContext` owns one final native gate. Keep catalog before compacted history and keep `prefixCount` at the fixed prefix/history boundary, not at the current turn. Move Canvas into the suffix before final admission; while emitting in the Calendar prefix loop, record candidate indices at the actual Web insertions. Active input remains the final base user; any suffix insertion that would shift old Web indices must be performed during assembly or remapped. No changes to history/total/output/ownership limits.
- **P3:** Web-only `request` is constructed after `admitted.messages` are chosen in `MemoryText.execute`; add the trusted `session_id` at this single released call site. Native adapter/policy and routing fields are untouched by P1.
- **P4:** Reuse `foldHistoricalWebResult(WebToolGroup): string | null` for selected completed-turn checkpoint evidence after trusted group and range selection; parse/project separately into summarizer data, not a native Web call in a no-tools summarizer. A `null` projection is not authority to emit the full unvalidated payload. P1 does not change checkpoint scheduling inputs, the compaction prefix, active-turn promotion/finalization or concurrent adoption. `rebaseAndReassemble` remains the handoff; P4 fixes the handle lifecycle if the baseline failure reproduces.
