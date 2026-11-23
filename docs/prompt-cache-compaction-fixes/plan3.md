# OpenRouter Conversation Routing Implementation Plan (P3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send one stable, server-derived OpenRouter `session_id` for the same user and conversation across plain, Calendar, Calendar/Web composite, Web-only, and same-model compaction POSTs.

**Architecture:** Reuse the exact existing plain/compaction hash at the model serialization boundary: SHA-256 of `JSON.stringify([userId, sessionId])`, prefixed with `aurvin-`. Plain uses its accounting record, Calendar and composite use their admitted dispatch binding, and compaction uses its existing server input. Web-only binds the accepted session ID when MemoryText constructs the model port; individual model requests cannot override it.

**Tech Stack:** Backend TypeScript (ESM/NodeNext), Node `node:crypto`, Vitest with injected OpenRouter SSE fixtures.

---

## Ownership and execution order

This covers the routing part of [Goal 3](goal.md), on the current `main` checkout. Tasks 1–2 are disjoint model work and may start before P1 completes. Task 3 may edit `memory-text.ts` only after the orchestrator confirms P1 has released it. P4 may take over MemoryText and `compaction-runner.ts` after P3 finishes; it owns the stable compaction prefix, snapshot content, and rebase/settlement. Do not edit them beyond the routing lines in this plan.

- `backend/src/model/policy.ts`: own the one hash function, not a new routing-policy layer.
- `backend/src/model/openrouter-adapter.ts`, `backend/src/model/calendar-policy.ts`, `backend/src/model/compaction-runner.ts`: put the hash on the wire from existing trusted bindings. Preserve Calendar admission, including the dispatch/budget identity check.
- `backend/src/model/web-native.ts`: bind conversation routing once per Web-only port, outside the request. The final factory config is `ModelConfig & { sessionId: string }`; this does not change the shared `ModelConfig`, `WebModelRequest`, public schemas, or composite request types.
- `backend/test/model/session-affinity.spec.ts`: compare actual JSON POST bodies and retain plain retry, isolation, and override regressions. Update the intentional `session_id` omission assertions in `backend/test/model/calendar-policy.spec.ts` and `backend/test/model/prompt-caching.spec.ts`. Keep `backend/test/model/web-native.spec.ts` on the final factory contract.
- `backend/src/chat-runtime/memory-text.ts` and `backend/test/runtime/web-search-loop.spec.ts`: wire the accepted turn's session into the factory and prove the Web-only continuation carries it.

Every npm command below runs from `backend/`; Git path commands run from the repo root. Use deterministic fakes only. The orchestrator serializes staging and commits; report the changed files, attributable hunks on dirty files, test evidence, and suggested commit message at each gate. Do not stage or commit independently. Do not add storage calls, change routing eligibility/provider pins or fallbacks, alter provider parameters/cache defaults, or change prompts, tools, or compaction mode behavior to achieve parity. Custom compaction already sends the hash; keep that behavior, its existing model/limits, provider-default reasoning, and no live tool definitions.

### Task 1: Share the existing hash and add it to Calendar and composite

**Files:**
- Modify: `backend/src/model/policy.ts` (`ModelConfig`/`providerParameters`)
- Modify: `backend/src/model/openrouter-adapter.ts` (`OpenRouterAttemptAdapter.stream`)
- Modify: `backend/src/model/calendar-policy.ts` (`buildCalendarBody`)
- Modify: `backend/src/model/compaction-runner.ts` (`CompactionRunner.run` request body only)
- Test: `backend/test/model/session-affinity.spec.ts`, `backend/test/model/calendar-policy.spec.ts`, `backend/test/model/prompt-caching.spec.ts`

- [ ] **Step 1: Add the plain/Calendar/composite wire regression.** In `session-affinity.spec.ts`, add the imports, pinned key, and test below. Give the existing `dispatch` helper a third parameter `modelId = 'anthropic/fixture'` and replace its hard-coded assignment with `c.openRouter.modelId = modelId`. The pinned key is the pre-change plain body for `seed()`; never call the production hash helper to compute a test expectation.

```ts
import { SKILL_NATIVE_TOOLS } from '../../src/contracts/calendar-tools.js';
import { OpenRouterCalendarAdapter } from '../../src/model/calendar-adapter.js';
import { webToolsFor } from '../../src/model/web-native.js';
import { calendarBinding, calendarLimits, skillRequest } from './calendar-fixtures.js';

const seedRoutingId = 'aurvin-c97ee719b602026b2cee407b294b0e79a2593f047eff6de370950686e2fea7e0';

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
    composite ? ['activate_skill', 'call_tool', 'control_canvas', 'web_tool']
      : ['activate_skill', 'call_tool', 'control_canvas'],
  );
  for (const field of ['sessionId', 'trace', 'stream_options', 'cache_control']) {
    expect(body[field]).toBeUndefined();
  }
});
```

In `calendar-policy.spec.ts`'s “forwards native assistant/tool groups” test, add the following and remove **only** `'session_id'` from its private-field list:

```ts
expect(body.session_id).toMatch(/^aurvin-[0-9a-f]{64}$/);
expect(body.session_id).not.toContain(calendarBinding().dispatch.sessionId);
```

In `prompt-caching.spec.ts`'s Anthropic Calendar dispatch test, remove **only** `'session_id'` from the private-field list and add:

```ts
expect(serialized.session_id).toMatch(/^aurvin-[0-9a-f]{64}$/);
expect(serialized.session_id).not.toContain(binding.dispatch.sessionId);
```

- [ ] **Step 2: Pin current compaction behavior before refactoring it.** Add the imports and test to `session-affinity.spec.ts`; extend the existing fixture frame import to `{ chunk, done, FRAMES, usage }`. Complete SSE usage prevents reconciliation from needing another fetch.

```ts
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { CompactionRunner } from '../../src/model/compaction-runner.js';

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
```

- [ ] **Step 3: Run red and verify the fixture.**

```bash
npm test -- test/model/session-affinity.spec.ts test/model/calendar-policy.spec.ts test/model/prompt-caching.spec.ts
```

Expected: Calendar/composite sends no `session_id` and the new assertions fail there; plain and both compaction mode regressions already pass. Fix a fixture error before treating it as a routing failure.

- [ ] **Step 4: Extract the function in `policy.ts`.** Add `import { createHash } from 'node:crypto';` and the helper below. Leave `providerParameters`' serialization unchanged; update its `model.sessionId = undefined` comment to `// Ignore global session grouping/tracing; serializers bind the trusted conversation.`.

```ts
/** OpenRouter grouping for one server-bound user and conversation. */
export function openRouterSessionId(userId: string, sessionId: string): string {
  return `aurvin-${createHash('sha256').update(JSON.stringify([userId, sessionId])).digest('hex')}`;
}
```

- [ ] **Step 5: Switch the three serializers.** Import `openRouterSessionId` from `./policy.js` in each file. Remove the direct `node:crypto` import from `openrouter-adapter.ts` and `compaction-runner.ts`, and delete `compactionSessionRoutingId` from the latter. Leave everything else in place.

```ts
// openrouter-adapter.ts, after the existing accounting/request guard:
body.session_id = openRouterSessionId(this.record.userId, this.record.sessionId);
```

```ts
// calendar-policy.ts, immediately after the providerParameters spread in the return body:
session_id: openRouterSessionId(dispatch.userId, dispatch.sessionId),
```

```ts
// compaction-runner.ts, replace only the existing session_id expression:
session_id: openRouterSessionId(input.userId, input.sessionId),
```

- [ ] **Step 6: Run green and hand off disjoint work.**

```bash
npm test -- test/model/session-affinity.spec.ts test/model/calendar-policy.spec.ts test/model/calendar-adapter.spec.ts test/model/prompt-caching.spec.ts test/runtime/compaction-model.spec.ts
```

Expected: all pass; matching session ID on both Calendar routes, unchanged hash for plain and compaction, no Calendar admission or cache-default regression. Suggested serialized commit: `fix(model): share conversation routing across Calendar and compaction`.

### Task 2: Bind Web-only routing in the model layer before the runtime handoff

**Files:**
- Modify: `backend/src/model/web-native.ts` (`createWebNativeModelPort`)
- Test: `backend/test/model/session-affinity.spec.ts`, `backend/test/model/web-native.spec.ts`

- [ ] **Step 1: Add a Web-only provider-boundary regression.** Add `WEB_TOOL_DEFINITION` from `../../src/contracts/web-search-tools.js` and add `createWebNativeModelPort` to the existing Web import in `session-affinity.spec.ts`. Use a local config variable so this assertion runs before the factory accepts the additional field. In `web-native.spec.ts`'s existing reasoning/output-cap test, set `sessionId: 'sess_fixture'` on `c` and `advertised: true` on `req` so that fixture continues to meet the factory/request types.

```ts
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
```

- [ ] **Step 2: Run red.**

```bash
npm test -- test/model/session-affinity.spec.ts -t "matches plain session_id on Web-only wire"
```

Expected: the Web-only POST succeeds but `body.session_id` is `undefined` instead of the plain ID.

- [ ] **Step 3: Bind the ID without editing the runtime yet.** Import `openRouterSessionId` from `./policy.js` and change the factory as follows. This interim optional field preserves the old Web-only wire behavior for the single runtime caller until P1 releases it. It is not a provider fallback, and Task 3 must delete the optional branch before P3 is complete.

```ts
export function createWebNativeModelPort(
  config: ModelConfig & { sessionId?: string }, limits: ModelLimits, fetcher: typeof fetch = fetch,
  diagnostic?: DiagnosticSink,
): WebModelPort {
  const sessionId = config.sessionId === undefined
    ? undefined : openRouterSessionId(config.identity.userId, config.sessionId);
  const webLimits = { ...CALENDAR_LIMITS, argumentBytes: WEB_SEARCH_POLICY.argumentBytes };
  // The existing stream implementation follows.
```

Add `session_id: sessionId,` immediately after the `providerParameters` spread in the `body` callback. `JSON.stringify` omits `undefined` during the interim. Do not add a route for this field through `WebModelRequest`; the existing stream user/config validation is unchanged.

- [ ] **Step 4: Run green and hand off before touching MemoryText.**

```bash
npm test -- test/model/session-affinity.spec.ts test/model/web-native.spec.ts
npm run build
```

Expected: both suites pass and the current caller still compiles without P1's file being edited. Suggested serialized commit if landing the disjoint slice separately: `fix(model): bind Web-only conversation routing at port creation`. Report the Task 3 gate and wait for explicit P1 release.

### Task 3: Supply the accepted runtime session and make the binding required

**Files (after P1 releases shared files):**
- Modify: `backend/src/chat-runtime/memory-text.ts` (sole `createWebNativeModelPort` call in the Web-only branch)
- Modify: `backend/src/model/web-native.ts` (remove interim optional binding)
- Test: `backend/test/runtime/web-search-loop.spec.ts`

- [ ] **Step 1: Confirm call-site ownership.** From the repo root, run:

```bash
git grep -n createWebNativeModelPort -- backend/src backend/test
git diff -- backend/src/chat-runtime/memory-text.ts backend/test/runtime/web-search-loop.spec.ts
```

Expected: one production factory call, in MemoryText, plus the declaration and model fixture uses. Apply only the routing hunk to the released file, regardless of where P1's refactor puts the call. Preserve current-user validation, fold-before-admission, and the exact dispatched messages.

- [ ] **Step 2: Extend the actual Web-only browse continuation regression.** In `web-search-loop.spec.ts` import `createHash` from `node:crypto`. In `executes one browse call, advertises it once, and returns linked sources`, insert the block below after `expect(f.fetcher).toHaveBeenCalledTimes(2)`. Keep the existing native call/result and source assertions.

```ts
const expectedId = `aurvin-${createHash('sha256')
  .update(JSON.stringify([f.identity.userId, ids.sessionId])).digest('hex')}`;
const sent = f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
expect(sent.map(body => body.session_id)).toEqual([expectedId, expectedId]);
for (const body of sent) {
  expect(body.user).toBe(f.identity.userId);
  expect(body.sessionId).toBeUndefined();
}
```

- [ ] **Step 3: Run red on the production path.**

```bash
npm test -- test/runtime/web-search-loop.spec.ts -t "executes one browse call, advertises it once, and returns linked sources"
```

Expected: the two dispatched bodies have `[undefined, undefined]` for IDs. If the fixture fails before the POST or existing settlement assertions, resolve ownership/baseline before attributing that failure to routing.

- [ ] **Step 4: Pass only the trusted turn identity and tighten the factory.** In MemoryText, add `sessionId: e.turn.sessionId` to the existing factory config next to the trusted user; retain the remaining arguments:

```ts
const adapter = createWebNativeModelPort({
  identity: { userId: e.turn.userId },
  sessionId: e.turn.sessionId,
  openRouter: snapshot.openRouter,
  budgets: { ...snapshot.budgets, maxMessageBytes: adapterMaxBytes },
}, snapshot.modelLimits!, this.d.fetcher ?? fetch, this.d.diagnostics?.emit);
```

If P1 reorders request assembly, add only the new property to the post-P1 call; do not restore earlier layout. In `web-native.ts`, replace the interim signature/hash with:

```ts
export function createWebNativeModelPort(
  config: ModelConfig & { sessionId: string }, limits: ModelLimits, fetcher: typeof fetch = fetch,
  diagnostic?: DiagnosticSink,
): WebModelPort {
  const sessionId = openRouterSessionId(config.identity.userId, config.sessionId);
  const webLimits = { ...CALENDAR_LIMITS, argumentBytes: WEB_SEARCH_POLICY.argumentBytes };
  // The existing stream implementation follows; keep session_id: sessionId in its body.
```

- [ ] **Step 5: Run integrated green.**

```bash
npm test -- test/model/session-affinity.spec.ts test/model/calendar-policy.spec.ts test/model/calendar-adapter.spec.ts test/model/prompt-caching.spec.ts test/model/web-native.spec.ts test/runtime/web-search-loop.spec.ts test/runtime/web-search-calendar.spec.ts test/runtime/compaction-model.spec.ts
npm run lint
npm run build
```

Expected: the Web-only initial POST and continuation both carry the accepted session's ID, cross-route and privacy checks pass, and no new lint or build failures. Report any unrelated baseline failure separately; do not fix it in P3 or report it as green. The orchestrator runs full backend `npm test`, lint and build on the integrated checkout. Suggested serialized commit: `fix(runtime): bind Web-only routing to the accepted conversation`.

- [ ] **Step 6: Release P4's interfaces.** Report tests and the final contract: `createWebNativeModelPort` requires a server-bound `sessionId` on its config (MemoryText uses `e.turn.sessionId` paired with `e.turn.userId`). `CompactionRunInput` is unchanged; its `userId` and `sessionId` must continue to identify the same conversation as live dispatch regardless of model mode, summary ID, cycle, or active turn. P4 may change compaction content and rebase behavior without altering this contract. The tests prove serialized parity, not provider affinity, cache hits, latency, or savings.
