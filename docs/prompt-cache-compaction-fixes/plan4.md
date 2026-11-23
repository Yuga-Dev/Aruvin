# Checkpoint Prompts and Overflow Rebase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a safe shared prefix and useful validated Web evidence to the checkpoint summarizer, and settle overflow turns using the current memory handle without making healthy turns wait.

**Architecture:** `MemoryText` chooses the checkpoint prefix and builds a projected delta from the existing cutpoint and server-memory records. The existing runner remains a bounded, no-tools serializer; rebase updates the active entry before promotion cleanup, and cancellation detaches the waiting turn from the independent compaction job.

**Tech Stack:** TypeScript/NodeNext, NestJS runtime, LangGraph, OpenRouter SSE, Vitest fixtures.

---

## Execution contract and files

- Approved [goal](goal.md), points 1 and 3. Start implementation only after [P1](plan1.md), [P2](plan2.md) and [P3](plan3.md) worker handoffs. Research and unified review are skipped. Run commands from `backend/` unless specified. This artifact authorizes no source edit during planning, no live requests, and no staging/committing by the planner. Workers hand off named changes to the orchestrator for serialized commits.
- **P1:** Reuse `foldHistoricalWebResult(group: WebToolGroup): string | null` from `backend/src/context/tool-folding.ts`. A non-null value is a bounded validated JSON projection with exact URL, title and excerpt (not a native call to replay in the summarizer). Null never authorizes a raw payload. Do not change its validation, Stage 1 eligibility or final native wire admission. Reuse P1's abort-aware `waitForCompaction` for the earlier referenced-assembly overflow path; do not add a second native wait mechanism.
- **P2:** `fixedContextMessages(this.d.assets)` is **the entire exact safe stable prefix**, not everything before history. It is the live serializer's two system messages: instructions and the existing JSON-quoted product background. Do not slice `prefixCount`, copy actual live messages, rebuild text or carry personalization, date, mode, catalog/account state, Canvas state, or tools. A prior compacted summary is data *after* the prefix.
- **P3:** Keep `CompactionRunner`'s shared `openRouterSessionId(input.userId, input.sessionId)` and current provider parameters unchanged. Do not add cache hints, attach tools or alter provider admission. Only stable wire equality is asserted; no cache hit, savings, or latency improvement is inferred.
- **Owned:** `backend/src/chat-runtime/memory-text.ts` (checkpoint snapshot, active `Entry`, referenced overflow waiting); `backend/src/chat-runtime/memory-first-foundation.ts` (only attempt-scoped Web accessor); `backend/test/runtime/compaction-runtime.spec.ts` and `backend/test/runtime/compaction-foundation.spec.ts` (wire, lifecycle and identity regression). `backend/src/model/compaction-runner.ts` and `backend/src/context/compaction-prompt.ts` remain unchanged. No new schema, persistence writes, model calls, configuration, or UI work.
- **Baseline evidence on this checkout:** `npm test -- test/runtime/compaction-runtime.spec.ts -t 'triggers compaction preflight'` passed, and the entire baseline file passed 4/4. The reported error is not presently reproducible with that fixture: the selected worktree already has an unrelated in-progress Canvas retention edit adding `!entry.running` to promotion cleanup. The old cleanup read `foundation.result(entry.turn)` after `applyCompaction` replaced the active handle but before `execute` stored it, so `owned` could throw and voice `finally` would try to settle with the same stale handle. Keep the existing Canvas work and regression; do not undo user changes to manufacture a RED. A distinct cancellation test below should be RED until the referenced overflow wait is bounded. Reconfirm after P1–P3, and record any pre-existing overlap that is already green.

### Task 1: Share the exact prefix only in active-fork mode

**Files:** `backend/src/chat-runtime/memory-text.ts` (`runCompactionJob`); `backend/test/runtime/compaction-runtime.spec.ts` (`createRuntimeHarness` and new wire test).

- [ ] **Add a wire test.** Add `fixedContextMessages` from `../../src/context/context-budget.js` and `openRouterSessionId` from P3's `../../src/model/policy.js`. Extend `createRuntimeHarness` options by `modelMode?: 'active-fork' | 'custom'`, and replace the `settings.compaction` assignment:

```ts
settings.compaction = {
  enabled: true, watermarkRatio: 0.8,
  modelMode: options?.modelMode ?? 'active-fork',
  customModelId: options?.modelMode === 'custom' ? 'openai/gpt-4o-mini' : null,
};
```

The same target for both rows isolates what the mode changes; keep the existing `compaction-model.spec.ts` case for a genuinely different target and reasoning limits. At module scope add:

```ts
type CheckpointWire = {
  messages: { role: string; content: string; tool_calls?: unknown }[];
  session_id?: string;
  tools?: unknown;
  tool_choice?: unknown;
};
```

Add inside the existing describe:

```ts
it.each(['active-fork', 'custom'] as const)('sends the safe checkpoint prefix in %s mode', async modelMode => {
  const bodies: CheckpointWire[] = [];
  const { runtime, dbReads } = createRuntimeHarness({
    modelMode,
    fetcherImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as CheckpointWire;
      bodies.push(body);
      return isCompactionBody(body) ? sseText('gen-cmp-prefix', summaryPayload('Condensed'))
        : sseText('gen-live-prefix', 'A'.repeat(180));
    },
  });
  let sessionId: string | null = null;
  for (let i = 0; i < 4; i++) {
    const sub = await runtime.submitTurn({
      identity, sessionId, content: `Prefix question ${i}: ${'q'.repeat(2000)}`,
      idempotencyKey: `prefix-${i}`,
    });
    sessionId = sub.sessionId;
    await runtime.executeTurn({
      userId: identity.userId, sessionId, turnId: sub.turnId, attemptId: sub.attemptId,
      signal: new AbortController().signal, emit: async () => undefined,
    });
  }
  await runtime['memoryOwners'].get(identity.userId)!.foundation.flushSession(sessionId!);
  await vi.waitFor(() => expect(bodies.filter(isCompactionBody)).toHaveLength(1));
  const live = bodies.find(body => !isCompactionBody(body))!;
  const checkpoint = bodies.find(isCompactionBody)!;
  const system = fixedContextMessages(assets);
  expect(live.messages.slice(0, 2)).toEqual(system);
  expect(checkpoint.messages.filter(m => m.role === 'system')).toEqual(
    modelMode === 'active-fork' ? live.messages.slice(0, 2) : system.slice(0, 1),
  );
  expect(checkpoint.messages.slice(0, modelMode === 'active-fork' ? 2 : 1)).toEqual(
    modelMode === 'active-fork' ? system : system.slice(0, 1),
  );
  expect(checkpoint.session_id).toBe(openRouterSessionId(identity.userId, sessionId!));
  expect(checkpoint.session_id).toBe(live.session_id);
  expect(checkpoint).not.toHaveProperty('tools');
  expect(checkpoint).not.toHaveProperty('tool_choice');
  expect(dbReads).not.toHaveBeenCalled();
  await runtime.drain(2000);
});
```

- [ ] **Run RED:** `npm test -- test/runtime/compaction-runtime.spec.ts -t "safe checkpoint prefix"`. Active-fork must fail with the missing product system message, not a missing P2 live prefix or P3 routing ID. Custom is a green regression.
- [ ] **Implement the selection at the only runtime runner call.** Add `fixedContextMessages` to the existing `context-budget.js` import and replace the `prefix` property:

```ts
prefix: snapshot.settings.compaction.modelMode === 'active-fork'
  ? fixedContextMessages(this.d.assets)
  : [{ role: 'system', content: this.d.assets.instructions }],
```

No smaller-prefix retry if the safe active-fork request cannot fit; the runner estimates the actual final messages against its current context/output margins. Keeping custom's previous one-message prefix avoids adding product overhead to a different, potentially smaller model.

- [ ] **Run GREEN:** `npm test -- test/runtime/compaction-runtime.spec.ts test/runtime/compaction-model.spec.ts test/model/session-affinity.spec.ts -t "safe checkpoint prefix|customModelId|compaction"`. Handoff label: `fix(prompt-cache): share stable assets with active-fork checkpoints`.

### Task 2: Feed selected and validated Web evidence into the checkpoint

**Files:** `backend/src/chat-runtime/memory-text.ts` (`scheduleCompactionIfNeeded`, `runCompactionJob`); `backend/src/chat-runtime/memory-first-foundation.ts` (`webGroups`); `backend/test/runtime/compaction-runtime.spec.ts`.

- [ ] **Add a checkpoint wire regression.** Import `CALENDAR_TOMBSTONE` from `../../src/contracts/calendar-sources.js`, `initialWebCounters`, `webLimits`, `webToolGroupSchema` from `../../src/chat-runtime/memory-web-state.js`, and add `memoryWebRecordSchema` to the existing memory-web-records import. Insert inside the runtime describe:

```ts
it('sends validated folded Web data for checkpointed turns only and excludes private Calendar prose', async () => {
  const bodies: CheckpointWire[] = [];
  const release = Promise.withResolvers<void>();
  const { runtime, snapshot, dbReads } = createRuntimeHarness({
    fetcherImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as CheckpointWire;
      bodies.push(body);
      await release.promise;
      return sseText('gen-selected-web', summaryPayload('Selected evidence'));
    },
  });
  const exactUrl = 'https://example.test/%7Enews?x=A%2Fb';
  const snippet = 'Verified opening detail. ';
  const rawBody = snippet + 'raw-padding-'.repeat(100);
  const privateText = 'PRIVATE_CALENDAR_EVENT_AT_NOON';
  const group = (ordinal: number, url: string, provedUrl: string) => webToolGroupSchema.parse({
    ordinal, afterCalendarGroups: 0,
    assistant: { role: 'assistant', content: null, tool_calls: [{
      id: `web-${ordinal}`, type: 'function',
      function: { name: 'web_tool', arguments: JSON.stringify({ mode: 'fetch', url }) },
    }] },
    result: { role: 'tool', name: 'web_tool', tool_call_id: `web-${ordinal}`,
      content: JSON.stringify({ url, body: rawBody, truncated: false }) },
    sources: [{ sourceId: `source-${ordinal}`, toolCallId: `web-${ordinal}`, url: provedUrl,
      title: `Article ${ordinal}`, kind: 'fetch', provider: 'exa', retrievedAt: '2026-10-06T11:00:00.000Z' }],
  });
  let sessionId: string | null = null;
  for (let i = 0; i < 4; i++) {
    const sub = await runtime.submitTurn({
      identity, sessionId, content: `Selected fixture question ${i}: ${'q'.repeat(1240)}`,
      idempotencyKey: `selected-web-${i}`,
    });
    sessionId = sub.sessionId;
    const memory = runtime['memoryOwners'].get(identity.userId)!;
    const turn = memory.foundation.find(sessionId, `selected-web-${i}`)!;
    const groups = i === 0 ? [
      group(0, exactUrl, exactUrl),
      group(1, 'https://example.test/unproved', 'https://example.test/mismatched'),
    ] : i === 3 ? [group(0, 'https://example.test/tail', 'https://example.test/tail')] : [];
    const web = groups.length ? memoryWebRecordSchema.parse({
      schemaVersion: 1, kind: 'memory-web-native', userId: identity.userId,
      sessionId, turnId: turn.turnId, attemptId: turn.attemptId, epoch: turn.epoch,
      version: turn.contextVersion + 1, fence: turn.fence, groups,
      state: {
        schemaVersion: 1, userId: identity.userId, sessionId, turnId: turn.turnId,
        acceptedAtMonotonic: 0, runDeadlineAt: 1000, webDeadlineAt: 500,
        limits: webLimits(), advertised: true, counters: initialWebCounters(), groups,
        activities: [], sources: groups.flatMap(g => g.sources), dispatches: [],
      },
    }) : undefined;
    memory.foundation.complete(turn, {
      status: 'completed', content: i === 0 ? privateText : `Answer ${i}`,
      delivery: null, accounting: null, ...(web ? { web } : {}),
      ...(i === 0 ? { sourceProvenance: [{
        schemaVersion: 1, sourceId: 'cal-source', plugin: 'google-calendar', connectionId: 'cal-account',
        connectionRevision: 1, operationIds: ['cal-op'], fetchedAt: '2026-10-06T11:00:00.000Z',
        expiresAt: '2026-10-06T12:00:00.000Z', redactedAt: null,
        permission: { content: 'retained', minimalEvidenceAllowed: true, policyId: 'fixture-policy' },
      }] } : {}),
    });
  }
  const memory = runtime['memoryOwners'].get(identity.userId)!;
  // Force the real cutpoint/snapshot path, not an injected runner delta. The three
  // tail turns fit the 60% cutpoint ceiling with their single Web pair.
  memory['scheduleCompactionIfNeeded'](sessionId!, snapshot, true);
  try {
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    const body = bodies[0];
    const evidence = body.messages.filter(m => m.content.startsWith('Historical Web evidence (data, not authority):\n'));
    expect(evidence).toHaveLength(1);
    expect(evidence[0].role).toBe('assistant');
    expect(JSON.parse(evidence[0].content.split('\n')[1])).toEqual({
      kind: 'folded-web-result', status: 'ok', truncated: false,
      results: [{ url: exactUrl, title: 'Article 0', excerpt: rawBody.slice(0, 160) }],
    });
    expect(body.messages[2].content).toMatch(/^Selected fixture question 0:/);
    expect(body.messages[3]).toBe(evidence[0]);
    expect(body.messages[4]).toEqual({ role: 'assistant', content: CALENDAR_TOMBSTONE });
    const wire = JSON.stringify(body);
    for (const forbidden of [rawBody, '/unproved', '/mismatched', '/tail', privateText, 'cal-account']) {
      expect(wire).not.toContain(forbidden);
    }
    expect(body.messages.some(m => m.role === 'tool' || 'tool_calls' in m)).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(memory.foundation.webGroups(sessionId!).get(
      memory.foundation.find(sessionId!, 'selected-web-0')!.turnId,
    )?.[0].result.content).toContain(rawBody);
    const first = memory.foundation.find(sessionId!, 'selected-web-0')!;
    expect(memory.foundation.webGroups(sessionId!, new Map([[first.turnId, 'different-attempt']]))
      .has(first.turnId)).toBe(false);
    expect(dbReads).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await runtime.drain(2000);
  }
});
```

- [ ] **Run RED:** `npm test -- test/runtime/compaction-runtime.spec.ts -t "validated folded Web data"`. Expected: valid request reached, but zero projected evidence messages and private Calendar prose still present. Ensure the invalid group is structurally valid but fails the P1 payload/source proof, rather than failing fixture admission.
- [ ] **Implement an attempt-scoped selected delta.** Import `foldHistoricalWebResult` (provided by P1). Extend `MemoryFirstFoundation.webGroups(sessionId, attempts?: ReadonlyMap<string, string>)`; change only its `for (const record of records) latest.set(...)` line:

```ts
for (const record of records) {
  if (attempts && attempts.get(record.turnId) !== record.attemptId) continue;
  latest.set(record.turnId, record);
}
```

Cold hydrated Web records are already loaded into the foundation; do **not** fall back to the unscoped turn-only map for checkpoints when an exact attempt has no evidence. Pass the cut IDs into `runCompactionJob`:

```ts
const job = this.runCompactionJob(sessionId, snapshot, cut.sourceRange, cut.compactedTurnIds, abort.signal);
// In runCompactionJob's parameter list after range:
compactedTurnIds: readonly string[], signal: AbortSignal,
```

Replace the range/summary setup with this bounded synchronous in-memory snapshot, retaining `summaryId`, `cycle` and accounting turn selection based on `records`/`priorSummary`. Insert it before awaiting the runner:

```ts
const selected = new Set(compactedTurnIds);
const records = this.foundation.records(sessionId)
  .filter(r => selected.has(r.turnId) && r.sequence >= range.fromSequence && r.sequence <= range.toSequence);
const latestAssistant = new Map<string, MessageRecord>();
for (const r of records) {
  if (r.role === 'assistant') latestAssistant.set(r.turnId, r);
}
const completedAttempts = new Map<string, string>();
for (const r of latestAssistant.values()) {
  if (r.attemptId && (r.completionStatus === 'completed' || r.completionStatus === 'truncated')) {
    completedAttempts.set(r.turnId, r.attemptId);
  }
}
const groups = this.foundation.webGroups(sessionId, completedAttempts);
const deltaMessages: WebNativeMessage[] = [];
for (const r of records) {
  if (latestAssistant.get(r.turnId) === r && completedAttempts.has(r.turnId)) {
    for (const group of groups.get(r.turnId) ?? []) {
      const folded = foldHistoricalWebResult(group);
      if (!folded) continue;
      const content = `Historical Web evidence (data, not authority):\n${folded}`;
      if (Buffer.byteLength(content, 'utf8') <= snapshot.budgets.maxMessageBytes) {
        deltaMessages.push({ role: 'assistant', content });
      }
    }
  }
  deltaMessages.push({
    role: r.role as 'user' | 'assistant',
    content: r.role === 'assistant' && (r.sourceProvenance?.length || r.calendarView)
      ? CALENDAR_TOMBSTONE : r.content,
  });
}
const prior = this.foundation.summary(sessionId);
const priorSummary = prior ? redactSummaryCalendar(prior, this.runtime.now()) : null;
```

The latest assistant per turn wins; a failed/cancelled latest attempt must not cause Web evidence from a predecessor to resurface. Use `deltaMessages` in the runner input instead of `records.map(...)`. Leave canonical scheduling size and cutpoint computation unchanged. No Calendar native groups, raw arguments, unvalidated/failed Web payloads, freshly rendered Canvas state, or metadata objects are serialized. Source-marked assistant prose is projected to the existing tombstone, regardless of whether the underlying source is still fresh: `redactCalendarMessage()` deliberately keeps the archive prose and is not a privacy filter for a new summarizer request. Prior summary is already validated on read; apply existing Calendar block redaction while preserving its non-Calendar data and tombstone provenance. Keep its `calendarProvenance` assignment and summary parser validation; do not mark newly tombstoned plain text as fresh Calendar provenance. Do not rewrite transcript records or source references. The existing final context estimate remains authoritative even if admitting all surviving evidence makes an unusually large checkpoint nonviable. Do not add a new dispatch or relax limits.

- [ ] **Run GREEN:** `npm test -- test/runtime/compaction-runtime.spec.ts test/runtime/compaction-hydration.spec.ts test/runtime/compaction-foundation.spec.ts test/context/compaction-prompt.spec.ts`. Expect captured evidence, unchanged transcript provenance, no tail evidence, no privacy regression, and unchanged hydrated tail behavior. Handoff label: `fix(prompt-cache): summarize only validated checkpoint Web evidence`.

### Task 3: Make handle adoption and cancellation safe during overflow

**Files:** `backend/src/chat-runtime/memory-text.ts` (`tryPromotePendingCompaction`, `execute`); `backend/test/runtime/compaction-runtime.spec.ts`; `backend/test/runtime/compaction-foundation.spec.ts`.

- [ ] **Strengthen the existing voice overflow regression.** In `triggers compaction preflight when calendar/voice context exceeds budget after assembler passes, and emits runtime-error on failure`, capture the fifth accepted handle using the same runtime memory lookup pattern used above. Replace the first overflow execution and its success assertions with:

```ts
const memory = runtime['memoryOwners'].get(identity.userId)!;
const before = memory.foundation.find(seedId, 'voice-cal-4')!;
const start = vi.fn(async () => undefined);
const settle = vi.fn(async () => undefined);
const events: string[] = [];
await expect(runtime.executeTurn({
  userId: identity.userId, sessionId: seedId, turnId: overflowTurn.turnId, attemptId: overflowTurn.attemptId,
  signal: new AbortController().signal,
  emit: async ({ event }) => { events.push(event.type); },
  live: {
    reservation, start, settle, delta: async text => { spoken.push(text); },
    finish: async () => undefined,
  },
})).resolves.toBeUndefined();
const after = memory.foundation.find(seedId, 'voice-cal-4')!;
expect(after).not.toBe(before);
expect(after).toMatchObject({
  turnId: before.turnId, attemptId: before.attemptId, requestKey: before.requestKey,
  contextVersion: before.contextVersion + 1, epoch: before.epoch, fence: before.fence,
});
expect(memory.foundation.result(after)).toMatchObject({
  version: after.contextVersion + 1,
  output: { completionStatus: 'completed' },
  delivery: { status: 'unknown', textGenerated: 'Voice reply after compaction.' },
});
expect(() => memory.foundation.result(before)).toThrow('Invalid memory turn handle.');
expect(start).toHaveBeenCalledOnce();
expect(settle).toHaveBeenCalledOnce();
expect(events.filter(event => event === 'completed')).toHaveLength(1);
expect(events).not.toContain('context-state');
expect(diagnostics.filter(d => d.stage === 'runtime-error')).toEqual([]);
expect(spoken.join('')).toBe('Voice reply after compaction.');
expect(accounting.filter(a => a.purpose === 'compaction')).toHaveLength(1);
```

In `compaction-foundation.spec.ts`'s existing `rebases active turn during inline burst compaction so complete() uses incremented version` test, immediately after `expect(rebased.turn.contextVersion).toBe(2);`, add `expect(foundation.find(rebased.turn.sessionId, rebased.turn.requestKey)).toBe(rebased.turn);`. Keep its version-3 completion assertion. On the old cleanup path the voice execute assertion rejects with `Invalid memory turn handle`; on the user's working tree it can correctly be green. If P1/P2 change the overflow fixture's effective threshold, require the changed handle/version assertion rather than passing on a no-rebase turn.

- [ ] **Add cancellation RED and keep concurrent-turn coverage.** Add the following independent test in the same runtime describe. The test takes cancellation before the held summary completes; it must not be made green by releasing the summary first.

```ts
it('settles a cancelled referenced-overflow turn while its background checkpoint is held', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const bodies: CheckpointWire[] = [];
  const { runtime, dbReads } = createRuntimeHarness({
    fetcherImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as CheckpointWire;
      bodies.push(body);
      if (isCompactionBody(body)) {
        started.resolve();
        await release.promise;
        return sseText('gen-held-cmp', summaryPayload('Late checkpoint'));
      }
      return sseText('gen-seed-cmp', 'A'.repeat(180));
    },
  });
  const assembler = vi.spyOn(ReferencedContextAssembler.prototype, 'assemble');
  let execution: Promise<void> | undefined;
  try {
    let sessionId: string | null = null;
    for (let i = 0; i < 4; i++) {
      const seed = await runtime.submitTurn({
        identity, sessionId, idempotencyKey: `cancel-seed-${i}`,
        content: `Seed ${i}: ${'q'.repeat(2000)}`,
      });
      sessionId = seed.sessionId;
      await runtime.executeTurn({
        userId: identity.userId, sessionId, turnId: seed.turnId, attemptId: seed.attemptId,
        signal: new AbortController().signal, emit: async () => undefined,
      });
    }
    await started.promise;
    const sub = await runtime.submitTurn({
      identity, sessionId, idempotencyKey: 'cancel-overflow',
      content: `Overflow ${'z'.repeat(3000)}`,
    });
    const events: string[] = [];
    execution = runtime.executeTurn({
      userId: identity.userId, sessionId: sub.sessionId, turnId: sub.turnId, attemptId: sub.attemptId,
      signal: new AbortController().signal, emit: async ({ event }) => { events.push(event.type); },
    });
    await vi.waitFor(() => expect(assembler).toHaveBeenCalledTimes(5));
    expect(await assembler.mock.results[4].value).toMatchObject({
      ok: false, overflow: { code: 'CONTEXT_BUDGET_EXCEEDED' },
    });
    await runtime.cancelTurn({ identity, sessionId: sub.sessionId, turnId: sub.turnId, attemptId: sub.attemptId });
    await vi.waitFor(() => expect(events).toContain('error'), { timeout: 500 });
    await execution;
    expect(await runtime.getTurnStatus(identity.userId, sub.sessionId, sub.turnId)).toMatchObject({
      status: 'cancelled', attemptId: sub.attemptId, error: { code: 'CANCELLED' },
    });
    expect(events).not.toContain('completed');
    expect(bodies.filter(isCompactionBody)).toHaveLength(1);
    expect(bodies.filter(body => !isCompactionBody(body))).toHaveLength(4);
    expect(dbReads).not.toHaveBeenCalled();
    release.resolve();
    const next = await runtime.submitTurn({
      identity, sessionId, idempotencyKey: 'after-cancelled-overflow', content: 'Still usable',
    });
    expect(next.attemptId).not.toBe(sub.attemptId);
  } finally {
    release.resolve();
    await execution?.catch(() => undefined);
    assembler.mockRestore();
    await runtime.drain(2000);
  }
});
```

In `runs async compaction at 80%, preserves concurrent K+1 turns, and incurs zero pre-model DB reads`, add `let checkpointBody: CheckpointWire | undefined;` next to `releaseCompaction`, change the fixture JSON cast to `as CheckpointWire`, and assign `checkpointBody = body;` before resolving `startedSignal`. After concurrent completion and before `releaseCompaction()`, add `expect(checkpointBody).toBeDefined();` and `expect(JSON.stringify(checkpointBody)).not.toContain('Concurrent turn while compacting');`. Keep its after-promotion tail assertion. Checkpoint snapshot is synchronous before its network await; no new strict general version compare is allowed to discard a valid prefix when K+1 has completed.

- [ ] **Run RED:** `npm test -- test/runtime/compaction-runtime.spec.ts -t "triggers compaction preflight|cancelled referenced-overflow|preserves concurrent"`. Expect cancellation test to time out at the terminal-event assertion on the old unguarded wait, not at setup. The healthy concurrency case passes. If P1 already applied its abort-aware wait to the referenced path, that test can also start green; preserve it and avoid another wait change. Record actual RED/GREEN states; do not claim an old bug was reproduced when the selected checkout passes.
- [ ] **Adopt the replacement before cleanup; prune by sequence, not by stale handles.** Change the second parameter of `tryPromotePendingCompaction` from `activeTurn?: MemoryTurn` to `activeEntry?: Entry`. Keep the existing Canvas capture **before** promotion and Canvas archive merge **after** promotion. Replace the promotion call block (between those two) with:

```ts
if (!activeEntry && this.foundation.session(sessionId).activeAttemptId) return null;
const promoted = activeEntry
  ? (() => {
      const next = this.foundation.rebaseActiveTurnForCompaction(activeEntry.turn, pending.summary, pending.checkpoint);
      activeEntry.turn = next.turn;
      return next;
    })()
  : this.foundation.promoteCompaction(this.ownerId, sessionId, pending.summary, pending.checkpoint);
```

Remove the old `if (!promoted) return null;` and keep pending summary consumption/tail pruning. In the `this.entries` cleanup loop check the immutable output sequence (see `terminalEnvelope` and `commitPromoted`), never call `result` during cleanup:

```ts
for (const [id, entry] of this.entries) {
  if (entry !== activeEntry && entry.turn.sessionId === sessionId && !entry.running &&
      entry.turn.sequence + 1 <= cut) this.entries.delete(id);
}
```

Idle promotion remains blocked during any active attempt; do not relax `owned`, active or fence checks. The existing save pump defers the adapter to a microtask and the foundation already registers the replacement synchronously; no foundation lifecycle change is needed. Replace `rebaseAndReassemble` in `execute`:

```ts
const rebaseAndReassemble = async () => {
  job.check();
  this.tryPromotePendingCompaction(c.sessionId, e);
  source = this.foundation.context(e.turn);
  const result = await assembleOnce();
  job.check();
  return result;
};
```

Both initial referenced-overflow waits call the **same** P1 local `waitForCompaction` helper, declared before the first referenced assembly. Preserve any P1 use in native preflight. It races the independent summary promise against `job.signal` (includes existing total deadline), removes its abort listener and calls `job.check()` when it wakes. Do not pass the background promise into `Work.wait`/`track` (settlement would still wait for it, and `Work.wait` quarantines persistence). Do not cancel the shared job from a single turn. Replace only the early wait blocks with:

```ts
let assembled = await assembleOnce();
job.check();
if (!assembled.ok) {
  const running = this.sessions.get(c.sessionId)?.compaction?.running;
  if (running) {
    await waitForCompaction(running);
    assembled = await rebaseAndReassemble();
  }
}
if (!assembled.ok) {
  this.scheduleCompactionIfNeeded(c.sessionId, snapshot);
  const running = this.sessions.get(c.sessionId)?.compaction?.running;
  if (running) {
    await waitForCompaction(running);
    assembled = await rebaseAndReassemble();
  }
}
```

Leave the final overflow throw and native retry policy unchanged. Check `job.check()` just before voice `start` (or first dispatch for text) after the native preflight block. `finish`, `cancel`, `status`, and `settle` continue using the single adopted `e.turn`. Do not catch and suppress invalid handles. Explicit cancellation emits `CANCELLED`; a deadline or disconnect retains the existing `Work.failure()` distinction. If P1 already landed identical gating, keep it rather than duplicate it.

- [ ] **Run GREEN:** `npm test -- test/runtime/compaction-runtime.spec.ts test/runtime/compaction-foundation.spec.ts test/runtime/compaction-archive.spec.ts`. Expect successful voice settlement, one checkpoint, stale old handle rejection, cancellation without waiting for the background job/dispatching live, and K+1 preservation. Handoff label: `fix(prompt-cache): adopt rebased turn before cleanup and detach cancelled waits`.

### Integrated verification and handoff

- [ ] Run targeted regression sets (no real services):

```powershell
npm test -- test/runtime/compaction-runtime.spec.ts test/runtime/compaction-foundation.spec.ts test/runtime/compaction-archive.spec.ts test/runtime/compaction-hydration.spec.ts test/runtime/compaction-model.spec.ts test/context/compaction-prompt.spec.ts
npm test -- test/runtime/web-search-followup-verify.spec.ts test/runtime/web-search-calendar.spec.ts test/runtime/canvas-navigation.spec.ts test/model/session-affinity.spec.ts test/performance/calendar-tool-latency.spec.ts
npm run build
npm run lint
npm test
```

- [ ] Report the baseline vs changed results, skipped integration prerequisites, and named P4 hunks to the orchestrator. The contested file is `memory-text.ts`: keep P1 preflight/admission, P3 Web transport identity, and pre-existing Canvas archive/runtime work intact. If the upstream fold format or wait ownership changes, reconcile that contract before editing. A fully valid checkpoint may exceed the provider context ceiling when shared product data/evidence is large; preserve bounded rejection and existing cooldown, do not claim a guaranteed checkpoint or cache hit. Post-rollout accounting/timing comparisons remain P2/final-verification work; do not run paid/live checks here.
