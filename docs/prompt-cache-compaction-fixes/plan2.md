# Stable Prompt Prefix and Voice Canvas Suffix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the prompt’s fixed assets contiguous and its completed wire history identical when only the current voice Canvas state changes.

**Architecture:** Reuse `fixedContextMessages(assets)` for the leading system/product pair. Insert the existing trusted, voice-only Canvas system message immediately before the accepted input, after all historical insertions, without changing what counts against the saved-history, full-prompt, or message limits. Leave provider cache policy, authority checks, and native serializers alone.

**Tech Stack:** Backend TypeScript/NodeNext, Vitest, existing in-memory Calendar/voice runtime and scripted OpenRouter fetch.

---

## Ownership and handoff

- **P2 starts after P1 lands.** `backend/src/context/calendar-context.ts`, `backend/src/context/web-context.ts`, and the composite forwarding seam `assembleTurnCalendarContext` in `backend/src/chat-runtime/calendar-loop.ts` overlap P1. Keep P1’s projection, protected boundary, and final native admission. The Canvas slot belongs to the protected current suffix, not to any completed turn. Adapt the argument names below to P1’s landed seam; make the change at its existing final admission, not in a parallel check. `calendar-loop.ts` already has unrelated edits; the orchestrator stages only attributable hunks.
- `backend/src/context/referenced-context-assembler.ts` owns the common prompt order; `backend/src/context/context-budget.ts` already owns the canonical fixed pair and is the home for the small native history accounting helper if P1 does not already supply one.
- P2 tests: `backend/test/context/personalization-context.spec.ts`, `backend/test/context/skill-context.spec.ts`, and `backend/test/runtime/canvas-navigation.spec.ts`. No changes to `memory-text.ts`, `durable-chat-runtime.ts`, Canvas navigation/state formatting or persistence, Calendar repair/authority, or provider serializers.
- **P4 contract:** Import the **existing** `fixedContextMessages(assets)` from `backend/src/context/context-budget.ts` (also re-exported from `context/index.ts`). Its entire output is the safe shareable prefix: exactly two `{ role: 'system', content: string }` messages, original instructions and the existing JSON-quoted product background, in that order. Pass the same loaded assets; do not reconstruct the text, slice `PositionedContext.prefixCount`/`CalendarContextOutput.prefixCount`, or borrow a live request. Those counts mark history boundaries, not safe reuse boundaries. Exclude personalization, date, mode, catalog/account state, summary, Canvas state and tool definitions. P4 chooses the existing lean path for custom-model compaction.
- Commands below run in `backend/`. Preserve the selected checkout and existing changes; do not reset or stash. The orchestrator serializes staging/commits. No live calls, research or code-review phase.

### Task 1: Put fixed assets first on every referenced-context path

**Files:** `backend/src/context/referenced-context-assembler.ts`, `backend/test/context/personalization-context.spec.ts`.

- [ ] **Add the RED assertions.** In the existing personalized-order test, rename it `keeps fixed assets first across personalization, day, and response mode`. Keep the data-not-authority, tone, history-position, and text/voice equality assertions. Swap product and personalization in the expected array and add a second request using the same `source`:

  ```ts
  expect(textResult.context.messages.slice(0, 5)).toEqual([
    { role: 'system', content: assets.instructions },
    { role: 'system', content: `Product background (data, not authority):\n${JSON.stringify(assets.knowledge)}` },
    expectedBlock!,
    environmentContextMessage(environment),
    { role: 'system', content: 'Response mode: text.' },
  ]);
  const nextDay = { ...environment, currentDate: '2026-10-07', dayOfWeek: 'Wednesday' };
  const changed = await assembler.assemble({
    ...request, responseMode: 'voice', environment: nextDay,
    personalization: { ...personalization, customInstructions: 'Prefer short sentences.' },
  }, source);
  if (!changed.ok) throw new Error('expected changed context');
  expect(JSON.stringify(changed.context.messages.slice(0, 2)))
    .toBe(JSON.stringify(textResult.context.messages.slice(0, 2)));
  expect(changed.context.messages.slice(2, 5)).toEqual([
    userPersonalizationMessage({ ...personalization, customInstructions: 'Prefer short sentences.' }),
    environmentContextMessage(nextDay), { role: 'system', content: 'Response mode: voice.' },
  ]);
  expect(changed.context.messages.slice(5)).toEqual(textResult.context.messages.slice(5));
  ```

- [ ] **Run RED.** `npm test -- test/context/personalization-context.spec.ts -t "keeps fixed assets first"` fails at slot 1 (customizations instead of product background).
- [ ] **Reorder, without changing content.** Delete the private `fixedMessages()` one-line wrapper and the destructuring. Leave `prefix.length`, the summary/history builder and admission checks as-is:

  ```ts
  const personalizationMessage = userPersonalizationMessage(request.personalization);
  const prefix: ContextChatMessage[] = [
    ...fixedContextMessages(this.assets),
    ...(personalizationMessage ? [personalizationMessage] : []),
    environmentContextMessage(request.environment),
    responseModeMessage(request.responseMode),
  ];
  ```

  Update the test header/comments: personalization is optional at index 2; the fixed pair is contiguous. `prefix-estimate.ts` already counts the same assets/metadata; no configuration or estimate change.
- [ ] **Run GREEN.** `npm test -- test/context/personalization-context.spec.ts test/context/referenced-context-assembler.spec.ts test/context/voice-context.spec.ts` passes, including default personalization omission and existing budget boundaries. Report commit label `fix(context): lead prompts with stable assets` to the orchestrator.

### Task 2: Move Canvas after history and retain the exact native limits

**Files:** `backend/src/context/calendar-context.ts`, `backend/src/context/context-budget.ts`, `backend/src/context/web-context.ts`, `backend/src/chat-runtime/calendar-loop.ts` (composite argument only), `backend/test/context/skill-context.spec.ts`, `backend/test/runtime/canvas-navigation.spec.ts`.

- [ ] **Add a RED test at the outbound boundary.** In `backend/test/runtime/canvas-navigation.spec.ts` after `seededLiveNavigation`, use the existing fixture, not a stub assembler. Seed a native pair through `control_canvas` and then capture the first dispatch and Calendar continuation for **the same** accepted input. Change only the trusted selection via the port once the first body has been captured. Both requests must still expose exactly one Canvas state, the same completed history (including the old native pair), and the current input once. The continuation adds only its current native pair after the input.

  ```ts
  it('keeps older wire messages byte-stable when Canvas changes on a voice continuation', async () => {
    const { f, canvas, target } = await seededLiveNavigation();
    try {
      f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'old-open'));
      await f.execute(await f.submit('Open the pricing comparison.'), undefined, canvas);
      const before = f.h.modelBodies.length;
      const current = '  Load the Calendar schema.\nPlease.  ';
      const args = { plugin: 'google-calendar', tools: ['calendar_get_event'] };
      f.h.modelWires.push(skillWire('activate_skill', args, 'current-load'), textWire('Ready.'));
      await f.execute(await f.submit(current), undefined, {
        ...canvas,
        selection: () => f.h.modelBodies.length === before ? null
          : { canvasId: target, revision: 1, open: true, mode: 'diagram', fullscreen: true },
      });
      const bodies = f.h.modelBodies.slice(before);
      expect(bodies).toHaveLength(2);
      const messages = bodies.map(body => body.messages as {
        role: string; content?: string | null; tool_call_id?: string;
      }[]);
      const olderWire: string[] = [];
      for (const [index, list] of messages.entries()) {
        const canvases = list.filter(m => m.role === 'system'
          && m.content?.startsWith('Canvas state (voice-only instantaneous state;'));
        expect(canvases).toHaveLength(1);
        const stateIndex = list.indexOf(canvases[0]!);
        const accepted = { role: 'user', content: current };
        expect(list.filter(m => m.role === 'user' && m.content === current)).toEqual([accepted]);
        expect(list[stateIndex + 1]).toEqual(accepted);
        expect(JSON.parse(canvases[0]!.content!.split('\n')[1]!)).toEqual({
          mode: 'voice', canvas_count: 1, canvas_ids: [{ canvas_id: target, title: 'Pricing comparison' }],
          open: index === 1, fullscreen: index === 1, zoomable: index === 1,
        });
        const oldTool = list.findIndex(m => m.role === 'tool' && m.tool_call_id === 'old-open');
        expect(oldTool).toBeGreaterThan(0);
        expect(list[oldTool - 1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'old-open' }] });
        expect(oldTool).toBeLessThan(stateIndex);
        expect(list.slice(oldTool + 1, stateIndex)).toContainEqual({
          role: 'assistant', content: 'Voice reply delivery is unknown; do not assume generated content was heard.',
        });
        olderWire.push(JSON.stringify(list.slice(0, stateIndex)));
        const afterInput = list.slice(stateIndex + 2);
        if (index === 0) expect(afterInput).toEqual([]);
        else {
          expect(afterInput).toHaveLength(2);
          expect(afterInput[0]).toMatchObject({ role: 'assistant', tool_calls: [{
            id: 'current-load', function: { name: 'activate_skill', arguments: JSON.stringify(args) },
          }] });
          expect(afterInput[1]).toMatchObject({ role: 'tool', tool_call_id: 'current-load' });
        }
      }
      expect(olderWire[1]).toBe(olderWire[0]);
      expect(f.h.effects).toEqual([]);
    } finally { await f.dispose(); }
  }, 5000);
  ```

- [ ] **Check native ordering and budgets in one offline test for both routes.** In `backend/test/context/skill-context.spec.ts`, add imports for `assembleTurnCalendarContext` from `../../src/chat-runtime/calendar-loop.js`, `webToolGroupSchema` from `../../src/chat-runtime/memory-web-state.js`, `estimateMessagesTokens` from `../../src/context/context-budget.js`, `compactedHistoryMessage` from `../../src/context/compaction-prompt.js`, `repairInstruction` from `../../src/model/calendar-repair.js`, and `textSnapshot` from `../model/config-snapshot.js`. Add:

  ```ts
  it.each([false, true])('bounds the voice suffix without rewriting native history (composite=%s)', composite => {
    const acceptedInput = '  Keep my exact input.\n ';
    const summary = compactedHistoryMessage('Earlier task.');
    const oldUser = { role: 'user' as const, content: 'Old question' };
    const oldAnswer = { role: 'assistant' as const, content: 'Old answer' };
    const context: PositionedContext = {
      contextVersion: 1, instructionVersion: 'i', knowledgeContentHash: 'k', graphSchemaVersion: 'g',
      messages: [{ role: 'system', content: 'Fixture rules' }, summary, oldUser, oldAnswer,
        { role: 'user', content: acceptedInput }],
      prefixCount: 1, historyPositions: [
        { messageId: 'u1', turnId: 't1', role: 'user', index: 2 },
        { messageId: 'a1', turnId: 't1', role: 'assistant', index: 3 },
      ],
    };
    const envelope = { plugin: 'google-calendar', tools: ['calendar_get_event'] };
    const local = (id: string) => completeToolGroupV2Schema.parse({
      assistant: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function',
        function: { name: 'activate_skill', arguments: JSON.stringify(envelope) } }] },
      result: { role: 'tool', name: 'activate_skill', tool_call_id: id,
        content: JSON.stringify(activateLocalSkill(envelope, new Map(), 16384)) },
      sources: [],
    });
    const web = (id: string) => webToolGroupSchema.parse({
      ordinal: 0, afterCalendarGroups: 0,
      assistant: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function',
        function: { name: 'web_tool', arguments: '{"mode":"fetch","url":"https://example.test/a"}' } }] },
      result: { role: 'tool', name: 'web_tool', tool_call_id: id,
        content: '{"url":"https://example.test/a","body":"retained"}' },
      sources: [],
    });
    const oldLocal = local('old-calendar'), currentLocal = local('current-calendar');
    const oldWeb = web('old-web'), currentWeb = web('current-web');
    const snapshot = textSnapshot();
    const repair = { rejectedDecisionId: 'bad-decision', diagnostics: [
      { path: 'summary', code: 'missing' as const, expected: 'string' },
    ] };
    const assemble = (responseMode: 'voice' | 'text', budgets = snapshot.budgets, note?: string) =>
      assembleTurnCalendarContext({
        context, acceptedInput, groups: [currentLocal],
        historicalGroups: new Map([['t1', [oldLocal]]]),
        ...(composite ? {
          historicalWebGroups: new Map([['t1', [oldWeb]]]), webGroups: [currentWeb],
        } : {}),
        repair, snapshot: { ...snapshot, budgets }, limits: CALENDAR_LIMITS,
        binding: { userId: 'u', connectionId: 'c', connectionRevision: 1, googleSubjectId: 'sub' },
        nowMs: Date.parse('2026-10-21T09:00:00Z'), responseMode, note,
        canvasInventory: { items: [], omitted: 0 },
      });
    const old = [summary, oldUser, ...(composite ? [oldWeb.assistant, oldWeb.result] : []),
      oldLocal.assistant, oldLocal.result, oldAnswer];
    const current = [{ role: 'user', content: acceptedInput },
      ...(composite ? [currentWeb.assistant, currentWeb.result] : []),
      currentLocal.assistant, currentLocal.result,
      { role: 'system', content: repairInstruction(repair.diagnostics) }];
    const historyCap = estimateMessagesTokens([...old, ...current]);
    const roomy = { ...snapshot.budgets, maxContextTokens: 30_000 };
    const exact = { ...roomy, maxHistoryTokens: historyCap };
    const voice = assemble('voice', exact);
    const text = assemble('text', exact);
    expect(voice.messages[1]?.content).toContain('Enabled plugin catalog');
    expect(text.messages.slice(2)).toEqual([...old, ...current]);
    expect(voice.messages.slice(2, 2 + old.length)).toEqual(old);
    expect(voice.messages[2 + old.length]).toMatchObject({
      role: 'system', content: expect.stringMatching(/^Canvas state \(voice-only/),
    });
    expect(voice.messages.slice(3 + old.length)).toEqual(current);
    expect(voice.estimatedInputTokens).toBeGreaterThan(text.estimatedInputTokens);
    const note = 'Model-only note.';
    expect(assemble('voice', { ...roomy, maxHistoryTokens: 10_000 }, note).messages)
      .toEqual([...voice.messages, { role: 'system', content: note }]);
    expect(() => assemble('voice', { ...exact, maxHistoryTokens: historyCap - 1 }))
      .toThrow("This chat's saved history exceeds the configured history limit.");
    expect(() => assemble('voice', { ...exact, maxMessagesInContext: voice.messages.length - 1 }))
      .toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
    const fullCap = voice.estimatedInputTokens + exact.maxOutputTokens + exact.modelMarginTokens;
    expect(assemble('voice', { ...exact, maxContextTokens: fullCap }).messages).toEqual(voice.messages);
    expect(() => assemble('voice', { ...exact, maxContextTokens: fullCap - 1 }))
      .toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
  });
  ```

  The deliberately small `maxHistoryTokens` exercises the low-level final native check with a sized fixture; it is not a new valid admin setting. Keep P1’s emergency folding disabled for this test if its post-P1 assembly seam opts in, so this verifies the normal accounting paths directly.

- [ ] **Run RED.** `npm test -- test/context/skill-context.spec.ts -t "bounds the voice suffix"` fails because Canvas arrives before the summary. `npm test -- test/runtime/canvas-navigation.spec.ts -t "keeps older wire messages"` fails because Canvas is not adjacent to accepted input. A fix that only moves the message fails the exact-fit native history check; a fix that drops Canvas from the full limits fails the backstop cases.

- [ ] **Move the single message at the native boundary.** In `calendarContext`, make both existing catalog insertions push only `catalogMessage`. After the last-slot historical Web and Calendar insertions, just before `rebuildCalendarMessages`, append the existing `inventoryMessage` to the array supplied as `prefix`:

  ```ts
  const canvasStateIndex = inventoryMessage ? prefix.length : undefined;
  if (inventoryMessage) prefix.push(inventoryMessage);
  ```

  This argument to `rebuildCalendarMessages` means *all* pre-user messages; it is not the `prefixCount` budget marker. Keep the explicit assembler/catalog boundary; for positioned contexts `nativePrefixCount = assemblerPrefix + 1`, even with no tail or a summary-only tail. Do not scan for a user by string or split the historical loop at a content marker. If P1 returns a start-of-current-turn index for protection, use `canvasStateIndex ?? acceptedInputIndex` without changing the accepted-input anchor itself. Current Web insertion is after the last user and cannot shift the recorded Canvas index; current Calendar groups, repair instruction, and the existing optional note keep their original positions. Keep the `responseMode === 'voice' && input.canvasInventory` gate and use the `CalendarLoop` snapshots it already obtains per dispatch. Do not change selection/inventory validation or take another snapshot.

- [ ] **Preserve the budget classification explicitly.** Canvas was fixed overhead for positioned prompts. Do not bill it to saved history just because it moved. Keep one exact per-request exclusion index from the trusted insertion, internal to native assembly/admission (not on the wire or in storage). Use the same JSON estimator, excluding that single slot **only** from history. With the pre-P1 seam the minimal helper and forwarding are:

  ```ts
  // context-budget.ts
  export function estimateNativeHistoryTokens(messages: readonly object[], prefixCount: number,
    historyBudgetExcludedIndex?: number): number {
    const history = messages.slice(prefixCount);
    const offset = historyBudgetExcludedIndex === undefined ? -1 : historyBudgetExcludedIndex - prefixCount;
    if (offset >= 0) history.splice(offset, 1);
    return estimateMessagesTokens(history);
  }
  ```

  ```ts
  // calendar-context.ts after assemblerPrefix is computed:
  // Compatibility: the old unpositioned fallback could count the catalog and
  // inventory as history. Preserve that slice if the old Canvas slot was in it.
  const legacyCanvasCharged = inventoryMessage !== null && catalogIndex > assemblerPrefix;
  const nativePrefixCount = assemblerPrefix + 1 + (legacyCanvasCharged ? 1 : 0);
  const historyBudgetExcludedIndex = legacyCanvasCharged ? undefined : canvasStateIndex;
  // Use this at native history admission; return the exclusion next to prefixCount
  // only if the composite branch runs a separate final admission.
  if (estimateNativeHistoryTokens(messages, nativePrefixCount, historyBudgetExcludedIndex)
      > input.budgets.maxHistoryTokens) contextLimit(HISTORY_BUDGET_MESSAGE);
  ```

  For the separate composite check, extend `CalendarContextOutput` and `WebContextInput` with `historyBudgetExcludedIndex?: number`, forward `base.historyBudgetExcludedIndex` where `base.prefixCount` is forwarded in `assembleTurnCalendarContext`, and replace the Web history check’s `estimateMessagesTokens(messages.slice(input.prefixCount))` with `estimateNativeHistoryTokens(messages, input.prefixCount, input.historyBudgetExcludedIndex)`. Web-only callers omit the index. If P1 has consolidated the check, pass the index into that one final admission instead; if P1 already normalized the unpositioned fallback, apply its pre-move admission semantics rather than reinstating the old fallback. If P1’s projection changes message indices, carry the new slot via its explicit position mapping; never match a header against arbitrary user/history content. **Full** estimates, message count, per-message/tool bytes, ceilings, reservations, schema checks and all wire messages still include Canvas where applicable. Do not change limits, widen budget errors into retries, or add a fold trigger to admitted requests.

- [ ] **Run GREEN and authority/continuation regressions.**

  ```powershell
  npm test -- test/context/skill-context.spec.ts test/context/calendar-context.spec.ts test/runtime/canvas-navigation.spec.ts test/voice/integration/canvas-navigation.spec.ts
  npm test -- test/performance/calendar-tool-latency.spec.ts test/performance/calendar-memory-first.spec.ts test/plugins/google-calendar/connection-prepared.spec.ts
  ```

  Expect byte-identical captured older messages across Canvas states, exact current input, preserved native JSON and pairing, repair last when there is no note, unchanged no-state text behavior, and exact budget accept/reject. The second command covers the root `AGENTS.md` blocked-storage, held-archive, barriers, crash/cancel, account/expiry and synthetic profile cases. Report synthetic wave counts separately from any `performance.now()` observations. Surface baseline failures separately; do not roll back unrelated edits. Report commit label `fix(context): render live Canvas after historical messages` to the orchestrator.

## Exit gate

- [ ] From `backend/`, run `npm run build`, `npm run lint`, and `npm test` for the integrated goal (or record the orchestrator’s integrated run, in addition to P2’s focused commands). Report actual results and separately identify baseline failures or excluded integration prerequisites.
- [ ] Confirm provider serializers/cache flags and eligible routing were not changed by P2: existing `providerParameters` defaults, including its Anthropic-family `cache_control`, remain as-is. Stable wire bytes are not evidence of a provider cache hit or savings. After rollout use existing `cachedPromptTokens`, `cacheWriteTokens` and cost accounting (`backend/src/model/accounting.ts`) with `firstTextMs`, `firstAudioMs` and speech-end-to-first-audio timings (`backend/src/benchmark/runner.ts`, `backend/src/benchmark/voice-measurements.ts`). Compare unchanged routes/models and warm follow-ups/continuations; first audio is receipt, not audible playback. A provider-specific breakpoint requires separate evidence that it does not broaden writes or filter eligible routes; neither add nor benchmark one here.
