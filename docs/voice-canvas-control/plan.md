# Instant Voice Canvas Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Repository execution override:** This is the approved one-worker MAW-lite objective. Use the installed `executing-plans` and `test-driven-development` skills; do not dispatch another agent. Unified review is **skipped**, not passed. The orchestrator manages state and final reporting from your summary, not by reading this plan.

**Goal:** Add one voice-only native `control_canvas` tool that immediately applies seven bounded presentation actions to the selected Canvas without waiting for persistence, narration, TTS, or turn finalization.

**Architecture:** Extend the existing native catalogue, call-scoped Canvas port, `canvas.inventory` metadata, and dedicated Canvas presentation lane used by `show_canvas`. Dispatch a complete control decision synchronously before model-accounting/decision persistence, carry the selected-target revision to the browser, and call the mounted Canvas's narrow imperative handle directly. Reuse the existing state, panel-close action, zoom/pan behavior, and application maximize class; do not introduce another registry, socket, runtime, store, or saved viewport preference.

**Tech Stack:** Existing TypeScript/ESM, Zod 3, React/React DOM 19, NestJS, reliable LiveKit control packets, Vitest 4, existing offline voice/runtime fixtures. No dependency or infrastructure additions.

---

## Authority, limits, and execution rules

- Approved specification: [goal.md](goal.md), approval commit `aaacf15` (draft `05c4868`). Workflow/ownership: [state.md](state.md). Do not edit either file or historical workflow documents.
- Own implementation/test files listed below. The orchestrator owns `final_report.md` and workflow status. Return actual commits, commands, counts, failures/skips, and limitations for that report.
- First inspect `git status --short`; preserve other work and `.openchamber/`. Stage named files only. Do not commit fixtures' generated output, local settings, credentials, or dependencies.
- Node must satisfy each package's engines. No root npm package exists. Commands below run in the explicitly named package directory; do not start a real backend, connect a real database/provider/SFU, open a microphone, install a browser harness, provision anything, or run paid checks.
- Add the mandatory repository header to every new code/test file before its first write and to an existing file if changing over 30%. Preserve backend `.js` and frontend `.ts`/`.tsx` import conventions.
- Each checkbox is one small action. Within each task repeat the write-one-red-test → run-red → minimal implementation → run-green cycle for the listed cases. Do not implement the entire feature before observing failures.

The packages target ES2023; do not rely on `Promise.withResolvers` or raise their TypeScript library target for these tests. Use the existing deferred-promise pattern locally in a test file that needs explicit gates:

```typescript
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(release => { resolve = release; });
  return { promise, resolve };
}
```

## Findings that constrain the solution

1. `backend/src/contracts/calendar-tools.ts` currently advertises three frozen native tools, including `show_canvas`. `calendar-model.ts`, candidate validation, repair/history validation, context reconstruction, and retention each explicitly recognize that name. Extend every caller, not just the catalogue.
2. Both runtime compositions already supply a `LiveExecution.canvas` port: `memory-text.ts` and `durable-chat-runtime.ts`. `AgentVoiceAdapter` binds it to the real voice session, reservation, conversation, response, abort signal, and connection epoch. These—not tool arguments—are execution authority.
3. `OpenRouterCalendarAdapter.stream()` currently awaits `publish()`/`flushObservations()` before yielding a decision. `CalendarLoop.decide()` then awaits `finishDispatch()` and stores that decision; `execute()` reads it and performs an asynchronous permission/fence check before presentation. Copying the `show_canvas` execute branch alone would violate AC3, especially in promoted/durable execution.
4. `LiveKitControls.showCanvas()` already has a separate bounded `canvasOutgoing` FIFO, independent of ordinary voice/media controls. Generalize this one lane to admit both Canvas payloads; do not add a second outgoing lane. Its boolean means admitted/queued, not rendered.
5. The browser currently advertises only inventory, not selection/open state/presentation mode. Membership alone cannot safely implement “control the currently selected Canvas.” Add a small revisioned selection to the existing metadata. Do not add a lookup or acknowledgement round trip.
6. `CanvasPanel.tsx` already owns `{zoom, panX, panY}`, code/preview mode, maximize state, stage ref, and manual close/zoom/reset controls. `ChatView.tsx` owns selected tabs, panel lifecycle, focus restoration, and an inert exiting panel. `CLOSE_CANVAS` preserves the archive and tabs; `CLOSE_CANVAS_TAB` is not the requested close behavior.
7. `.aurvin-canvas-stage` fills the viewport, and SVGs also stretch to that stage. Fitting the stage/outer SVG rectangle alone is not measuring the diagram. Use local rendered SVG graphics bounds and their screen transform at neutral stage transform.
8. Calendar bodies and the code view are ordinary scroll containers. Calendar has no diagram zoom; do not introduce one, touch confirmation controls, or parse Calendar data as graphics.
9. Frontend tests discover `src/**/*.test.ts` under Node. Existing Canvas tests use `renderToStaticMarkup`; that does not run effects, mount imperative refs, measure actual layout, or prove browser paint. There is no checked-in Playwright/browser harness. Record that limitation rather than adding one.

## Frozen public behavior and contracts

### Exactly seven argument variants

No conversation, artifact, identity, amount, percentage, offset, duration, or optional tuning parameter is accepted from the model.

```typescript
type CanvasControlArguments =
  | { action: 'zoom_in' }
  | { action: 'zoom_out' }
  | { action: 'fit_to_view' }
  | { action: 'scroll'; direction: 'up' | 'down' | 'left' | 'right' }
  | { action: 'close' }
  | { action: 'reset_view' }
  | { action: 'fullscreen'; state: 'enter' | 'exit' };
```

- Zoom uses the existing toolbar step **25 percentage points**, bounds **25–300%**, and preserves pan.
- Diagram scrolling uses **75% of the relevant visible viewport dimension**, clamped to **0–800 CSS px** per request. “Scroll down/right” moves the viewing window down/right, therefore the transformed content moves **negative Y/X**. Up/left are positive Y/X. Clamp voice-produced pan to **±100,000 CSS px** on each axis. Mark this intentional finite ceiling with `ponytail:`; measured content-edge constraints would be a future replacement, not part of this task.
- Ordinary body scrolling uses the same bounded positive/negative displacement on native `scrollTop`/`scrollLeft`, clamped to `[0, scrollHeight-clientHeight]` and `[0, scrollWidth-clientWidth]`. At an edge or without overflow it is a harmless no-op. Calendar's current horizontal overflow policy is unchanged.
- Fit measures rendered graphics, uses the stage's available inner viewport (respect its existing 20 px horizontal / 16 px vertical padding), chooses a finite scale within 25–300%, and centers the measured graphics. Bounds can prevent a huge diagram fitting entirely: do not exceed minimum zoom or promise otherwise. Missing/nonfinite/zero geometry is unavailable and leaves the current view unchanged. Do not wait for rendering to become ready and replay later.
- Reset is exactly `{zoom:100, panX:0, panY:0}` plus native scroll positions `0,0`; it is not fit. Diagram zoom/fit are unsupported in Calendar and code view; reset/scroll/close/application expansion remain supported.
- `fullscreen.state` sets `maximized` to `true` for `enter` and `false` for `exit`. Repeating the same explicit setting is a no-op, not a toggle. Never call `requestFullscreen`, `exitFullscreen`, resize the panel, or request browser permission.
- Close invokes the existing panel-close path, retains artifacts/closed-tab IDs/selection, and can be repeated while closed. Other controls do not open a closed panel. An absent exact selected artifact is unavailable; do not use `CanvasPanel`'s visual fallback to select another artifact.

### Selection metadata and presentation payload

Extend the existing payload with an **optional** `selection` field so old inventory-only tests/clients remain valid; an absent selection permits `show_canvas` as before but never admits `control_canvas`.

```typescript
type CanvasSelection = {
  canvasId: string;
  revision: number;
  open: boolean;
  mode: 'diagram' | 'scroll';
};
type CanvasInventoryPayload = {
  type: 'canvas.inventory';
  conversationId: string;
  inventory: CanvasInventorySnapshot;
  selection?: CanvasSelection | null;
};
type CanvasControlPayload = {
  type: 'canvas.control';
  conversationId: string;
  turnId: string;
  responseId: string;
  controlId: string;
  canvasId: string;
  selectionRevision: number;
  command: CanvasControlArguments;
};
type CanvasControlResult = {
  kind: 'canvas-control';
  outcome: 'requested' | 'mode-not-allowed' | 'invalid-arguments'
    | 'unavailable' | 'delivery-unavailable' | 'unsupported';
  action: CanvasControlArguments['action'] | null;
  canvas_id: string | null;
};
```

- Reuse Canvas ID/component guards and 12,288-byte control / 1,024-byte result bounds. Selection revisions are positive safe integers. `selection.canvasId` must be in that snapshot's inventory. Unknown fields fail; null/absent selection is valid. Every browser/backend guard rejects unknown direction/state/action, cross-action fields, invalid IDs/revisions, arrays, oversized payloads, and nonfinite numbers.
- `revision` is generated by the existing frontend controller, increases whenever conversation, canonical selected ID, panel open/closed state, or diagram/scroll mode changes, and is not changed by zoom/pan/maximize values or unrelated inventory titles. Never reuse a revision after A→B→A. Refuse further controls at safe-integer exhaustion rather than wrap. Session/epoch envelopes fence calls, so a local monotonically increasing counter is sufficient; no new ID service is necessary.
- Capture the advertised selected-target snapshot at **each model dispatch**, not at tool execution. At complete decision availability compare it to the latest in-memory selection. A changed revision cannot retarget that pending decision. Browser receipt compares exact canonical selected ID and revision again. No model-facing `canvas_id` parameter is added.
- Return `mode-not-allowed` first for text; then `invalid-arguments`; then absent/changed/unowned/closed target (`unavailable`, except close on a known closed selection); then known unsupported presentation; then inactive/missing/failed lane (`delivery-unavailable`); otherwise `requested`.
- `requested` means admitted on the existing lane. It does **not** imply browser receipt, application, or paint. No browser acknowledgement is added. Browser-only geometry failures are local unavailable outcomes; without an acknowledgement the model result remains requested. Do not fabricate end-to-end confirmation.
- Stable control identity is `key('canvas-control', responseId, toolCallId)` in the trusted voice adapter. The loop caches the first result by native tool-call ID within its bounded turn. The frontend uses its existing bounded per-run presentation/navigation identity set with a `control:` prefix. Duplicate identity is consumed once even if target changes or application throws; a distinct tool-call ID is an intentional repeat. Do not deduplicate by action/arguments.
- These are best-effort volatile presentation effects. Do not replay them from checkpoints, hydrated history, cold recovery, reconnection, or an already completed turn. An unexecuted restored control gets a bounded `delivery-unavailable` pair, never a delayed UI effect. No durable exactly-once guarantee is claimed.

## File map (lock ownership before implementation)

| Files | Responsibility |
| --- | --- |
| `backend/src/contracts/canvas-navigation.ts` | Extend dependency-leaf Canvas schemas, selection/control wire types and portable guards. |
| `backend/src/contracts/calendar-tools.ts`, `calendar-model.ts` | Fourth frozen native definition, permissive bounded envelope for structured execution rejection, strict action schema, decision/result union. |
| `backend/src/model/calendar-validation.ts`, `calendar-repair.ts`, `calendar-adapter.ts` | Recognize the direct native name; yield complete valid control before observation persistence; retain raw native identity/history. |
| `backend/src/context/calendar-context.ts`, `backend/src/persistence/calendar-records.ts` | Source-free local control pairs and retention compatibility; preserve Calendar authorization/provenance. |
| `backend/src/chat-runtime/canvas-navigation.ts`, `calendar-loop.ts`, `ports.ts`, `memory-text.ts`, `durable-chat-runtime.ts` | Synchronous bounded control admission; complete-decision fast path; both existing compositions; deferred records and no replay. |
| `backend/src/contracts/voice-wire.ts`, `backend/src/voice/agent/agent-voice-adapter.ts`, `backend/src/voice/session/voice-session.options.ts`, `backend/src/voice/transport/livekit-control.ts`, `livekit-media.ts` | Existing scoped session metadata and presentation lane extended for controls; no media dependency. |
| `backend/src/instructions/system.md` | Voice-only control policy, seven arguments, fit/reset, explicit expansion, no regenerated visual or false display confirmation. |
| `frontend/src/api/voice-protocol.ts`, `livekit-voice-client.ts` | Dependency-free mirrored contract/guards; same optional Canvas receive lane. |
| `frontend/src/features/canvas/canvas-controls.ts` **new** | Small Canvas-specific presentation math, DOM measurement/application seam, shared manual/voice view operations; no store/registry. |
| `frontend/src/features/canvas/CanvasPanel.tsx` | Ref handle over existing state, fit/scroll measurement, native body refs, existing manual controls. |
| `frontend/src/features/chat/ChatView.tsx`, `frontend/src/features/voice/state/useLiveVoice.ts`, `live-voice-controller.ts` | Publish current selected presentation through existing surface; synchronous receipt callback and target/lifecycle/duplicate guards. |
| Existing contract/runtime/model/transport/voice integration tests named in tasks below | Extend fixtures in place; no copied fixture infrastructure. |
| `backend/test/model/calendar-fixtures.ts`, `backend/test/runtime/calendar-runtime.fixture.ts` | Add `control_canvas` to the existing scripted `skillWire` literal-name unions; retain the same SSE builders. |
| `frontend/src/features/canvas/canvas-controls.test.ts` **new** | Exact math and DOM-boundary doubles in existing Node Vitest environment. |

Unnecessary changes: no `App.tsx` command registry, no chat reducer viewport fields, no Calendar renderer changes, no package/lockfile changes, no root instruction changes. `live-flow.ts` already forwards the whole `canvas.inventory` payload synchronously; its existing branch needs no new asynchronous work.

## Documentation/API findings (12 November 2026)

Context7 was consulted for the actual installed API families:

- Zod 3 `/colinhacks/zod/v3.25.76`: `.strict()` rejects unknown keys; `z.discriminatedUnion` takes object variants; `.safeParse()` returns a success discriminator. Use these existing v3 APIs, not v4-only conveniences.
- React official `/reactjs/react.dev`: [`useImperativeHandle`](https://react.dev/reference/react/useImperativeHandle) can expose only the required methods; [`useLayoutEffect`](https://react.dev/reference/react/useLayoutEffect) runs after commit before paint and cleans up on dependency change/unmount. React 19 supports ref props. Use a dedicated `controlRef` prop to avoid interfering with the existing DOM `panelRef`.
- React DOM [`flushSync`](https://react.dev/reference/react-dom/flushSync) forces state/DOM commits before the next line, but can hurt performance. Use **one narrow wrapper only at the valid received-control callback**, never during render/effects and not around ordinary voice events. Do not mistake a React state setter or static markup test for synchronous DOM evidence.
- Vitest `/vitest-dev/vitest/v4.1.6`: `vi.waitFor` is appropriate for observing eventual fixture progress. For ordering use explicitly deferred promises and assertions **before releasing** them; a post-completion ordering assertion is insufficient.
- OpenRouter `/openrouterteam/docs`: tool argument validation uses JSON Schema Draft 7; `oneOf`/`const` belong to that schema dialect. Provider-native strict support varies; preserve the current `calendar-policy.ts` native tool serialization (it does not add `strict:true`) and enforce strict arguments locally. This offline implementation does not certify every provider endpoint's schema support.

Do not add a standalone research artifact; these focused findings are enough. Requery Context7 if implementation requires another library API not covered here.

---

## Task 1: Freeze the native, local-history, and portable wire contracts

**Modify:**
- `backend/src/contracts/canvas-navigation.ts`
- `backend/src/contracts/calendar-tools.ts`
- `backend/src/contracts/calendar-model.ts`
- `backend/src/model/calendar-validation.ts`
- `backend/src/model/calendar-repair.ts`
- `backend/src/context/calendar-context.ts`
- `backend/src/persistence/calendar-records.ts`
- `backend/src/contracts/voice-wire.ts`
- `frontend/src/api/voice-protocol.ts`

**Tests:**
- `backend/test/contracts/canvas-navigation.spec.ts`
- `backend/test/contracts/canvas-navigation-wire.spec.ts`
- `frontend/src/api/voice-protocol.test.ts`
- `frontend/src/api/testing/voice-fixtures.test.ts`
- `backend/test/model/calendar-fixtures.ts` and `backend/test/runtime/calendar-runtime.fixture.ts` (existing fixture name unions only).

- [ ] **Write the first red catalogue/schema test in the existing backend contract file.** Import the new schemas from the Canvas leaf module. Keep existing `show_canvas` schema assertions; change only expectations that intentionally enumerate native names.

```typescript
it('advertises exactly one new direct control with seven strict action variants', () => {
  expect(SKILL_NATIVE_TOOLS.map(tool => tool.name)).toEqual([
    'activate_skill', 'call_tool', 'show_canvas', 'control_canvas',
  ]);
  const tool = SKILL_NATIVE_TOOLS[3]!;
  expect(Object.isFrozen(tool)).toBe(true);
  const valid = [
    { action: 'zoom_in' }, { action: 'zoom_out' }, { action: 'fit_to_view' },
    { action: 'scroll', direction: 'down' }, { action: 'close' },
    { action: 'reset_view' }, { action: 'fullscreen', state: 'enter' },
  ];
  for (const value of valid) expect(controlCanvasArgumentsSchema.safeParse(value).success).toBe(true);
  for (const value of [
    {}, { action: 'toggle' }, { action: 'zoom_in', amount: 50 },
    { action: 'scroll' }, { action: 'scroll', direction: 'diagonal' },
    { action: 'fullscreen' }, { action: 'fullscreen', state: true },
    { action: 'close', canvas_id: 'other::canvas::0' },
    { action: 'reset_view', conversationId: 'other' },
    { action: 'zoom_out', direction: 'left' },
  ]) expect(controlCanvasArgumentsSchema.safeParse(value).success).toBe(false);
});
```

- [ ] **Run red** in `backend`: `npm test -- test/contracts/canvas-navigation.spec.ts -t "advertises exactly one new direct control"`. Expected: missing schema export or three-versus-four native-name failure, not a fixture/provider failure.
- [ ] **Add the minimal schemas/types in the existing dependency-leaf file.** Retain a bounded record envelope separately from strict action validation so parseable invalid arguments produce the promised local outcome without a repair/model round trip.

```typescript
export const controlCanvasArgumentsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('zoom_in') }).strict(),
  z.object({ action: z.literal('zoom_out') }).strict(),
  z.object({ action: z.literal('fit_to_view') }).strict(),
  z.object({ action: z.literal('scroll'), direction: z.enum(['up', 'down', 'left', 'right']) }).strict(),
  z.object({ action: z.literal('close') }).strict(),
  z.object({ action: z.literal('reset_view') }).strict(),
  z.object({ action: z.literal('fullscreen'), state: z.enum(['enter', 'exit']) }).strict(),
]);
export const controlCanvasEnvelopeSchema = showCanvasEnvelopeSchema;
export type CanvasControlArguments = z.infer<typeof controlCanvasArgumentsSchema>;
export const canvasControlResultSchema = z.object({
  kind: z.literal('canvas-control'),
  outcome: z.enum(['requested', 'mode-not-allowed', 'invalid-arguments', 'unavailable',
    'delivery-unavailable', 'unsupported']),
  action: z.enum(['zoom_in', 'zoom_out', 'fit_to_view', 'scroll', 'close', 'reset_view', 'fullscreen']).nullable(),
  canvas_id: canvasNavigationIdSchema.nullable(),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 1024);
export type CanvasControlResult = z.infer<typeof canvasControlResultSchema>;
```

Add the exact frozen wire types above and portable `isCanvasControlArguments`, `isCanvasSelection`, and `isCanvasControlPayload` using the leaf module's existing `exact`, ID, and UTF-8 helpers. Avoid Zod in portable browser guards. The discriminator guard is a switch whose branches call `exact` with only their variant's keys. Selection must be a strict four-key object; `Number.isSafeInteger(revision) && revision > 0` is mandatory.

```typescript
export function isCanvasControlArguments(value: unknown): value is CanvasControlArguments {
  if (!record(value)) return false;
  const action = value.action;
  if (action === 'scroll') return exact(value, {
    action: candidate => candidate === 'scroll',
    direction: candidate => typeof candidate === 'string'
      && ['up', 'down', 'left', 'right'].includes(candidate),
  });
  if (action === 'fullscreen') return exact(value, {
    action: candidate => candidate === 'fullscreen',
    state: candidate => candidate === 'enter' || candidate === 'exit',
  });
  return typeof action === 'string'
    && ['zoom_in', 'zoom_out', 'fit_to_view', 'close', 'reset_view'].includes(action)
    && exact(value, { action: candidate => candidate === action });
}
```

The native JSON schema is one `control_canvas` object definition with `oneOf` seven strict object variants and fixed action constants. Derive the five no-extra-argument variants from a literal tuple plus explicit scroll/fullscreen branches; advertise no wrapper and no plugin activation requirement.

```typescript
const plainCanvasActions = ['zoom_in', 'zoom_out', 'fit_to_view', 'close', 'reset_view'] as const;
const controlCanvasInputSchema = {
  oneOf: [
    ...plainCanvasActions.map(action => ({ type: 'object', additionalProperties: false,
      required: ['action'], properties: { action: { type: 'string', const: action } } })),
    { type: 'object', additionalProperties: false, required: ['action', 'direction'],
      properties: { action: { type: 'string', const: 'scroll' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] } } },
    { type: 'object', additionalProperties: false, required: ['action', 'state'],
      properties: { action: { type: 'string', const: 'fullscreen' },
        state: { type: 'string', enum: ['enter', 'exit'] } } },
  ],
};
```

Append `{name:'control_canvas', description: 'Immediately request a presentation-only change to the currently selected Canvas during live voice. Fullscreen explicitly enters or exits application panel expansion; it is not browser fullscreen.', inputSchema:controlCanvasInputSchema}` to the existing frozen array. Add its name to `skillNativeNameSchema`, result to `nativeLocalResultSchema`, and its envelope/result re-exports beside `show_canvas`.

- [ ] **Add red decision/history and wire cases**, then make these exact recognition changes. Preserve raw call arguments in `skillGroup`; it already uses the parsed native decision and needs no alternate group builder.

```typescript
// calendar-model.ts: append a discriminated-union object before its existing superRefine.
z.object({ kind: z.literal('control_canvas'), decisionId: idSchema,
  nativeCall: skillNativeCallSchema, assistantContent: z.string().max(32000).nullable(),
  envelope: controlCanvasEnvelopeSchema, terminal: z.literal('tool_calls') }).strict()

// calendar-validation.ts and calendar-repair.ts: use this additional schema arm.
const schema = call.name === 'activate_skill' ? activateSkillEnvelopeSchema
  : call.name === 'show_canvas' ? showCanvasEnvelopeSchema
  : call.name === 'control_canvas' ? controlCanvasEnvelopeSchema : callToolEnvelopeSchema;
```

For history validation use the same arm with `call.function.name`. Add `action`, `direction`, and `state` to bounded diagnostic paths; a control diagnostic must say no presentation action occurred and use the advertised `control_canvas` schema, never suggest `activate_skill` or `show_canvas`. Keep existing `canvas_id` repair guidance for navigation unchanged.

In `calendar-context.ts`, classify `control_canvas` as local and validate its content with `canvasControlResultSchema`, separate from `skillLocalResultSchema`. In `calendar-records.ts`, include it with source-free native decisions exempt from Calendar-account redaction. Do not exempt `call_tool` or any Calendar provenance checks.

```typescript
if (value.result.name === 'control_canvas') {
  if (!canvasControlResultSchema.safeParse(content).success) incomplete();
  parsed.push(value);
  continue;
}
```

In both voice wire mirrors add `CanvasControlPayload` to `VoiceServerPayload`, add a strict `canvas.control` server shape and full portable guard call, and reject it in dictation. Support optional selection on `canvas.inventory` through `optionalEventFields` and through `isCanvasInventoryPayload`; validate membership when selection is nonnull. Extend the existing Canvas import/re-export block in backend `voice-wire.ts`, preserving the parity test's named block anchor. Do not weaken the parity comparison or delete its source comparisons.

In `isVoiceClientEvent`, include the optional field when projecting an inventory event back into its payload guard; do not silently drop selection before validation. Keep the exact same portable code in the frontend mirror.

```typescript
if (v.type === 'canvas.inventory' && !isCanvasInventoryPayload({
  type: v.type, conversationId: v.conversationId, inventory: v.inventory,
  ...(Object.hasOwn(v, 'selection') ? { selection: v.selection } : {}),
})) return false;
```

Widen both existing `skillWire` helpers' `name` parameter to `'activate_skill' | 'call_tool' | 'show_canvas' | 'control_canvas'`; do not add another wire builder.

- [ ] **Cover the whole matrix before committing:** all seven schemas; all four scroll directions; both fullscreen states; malformed/duplicate-key/truncated/parallel native calls; strict raw identity; invalid parseable argument object retained for bounded execution failure; six result outcomes and byte bounds; exact original raw call/result pair; historical/cold local context; no Calendar-account redaction; portable cross-package shape acceptance; null/absent selection; wrong selection membership; revisions `0`, `NaN`, `Infinity`, negative, fractional, and above safe integer; extra command fields; live acceptance and dictation rejection. Use the existing contract fixtures/context setup in each file rather than copy a new fixture stack.
- [ ] **Run green**:
  - `backend`: `npm test -- test/contracts/canvas-navigation.spec.ts test/contracts/canvas-navigation-wire.spec.ts`
  - `frontend`: `npm test -- src/api/voice-protocol.test.ts src/api/testing/voice-fixtures.test.ts`
  - Expected: real discovered tests pass; no dependency/parity relaxation.
- [ ] **Commit** named task files with `feat(canvas): define voice presentation control contracts`.

## Task 2: Build the synchronous runtime admission and complete-decision fast path

**Modify:** `backend/src/chat-runtime/canvas-navigation.ts`, `ports.ts`, `calendar-loop.ts`, `memory-text.ts`, `durable-chat-runtime.ts`, `backend/src/model/calendar-adapter.ts`.

**Tests:** `backend/test/runtime/canvas-navigation-ownership.spec.ts`, `backend/test/runtime/canvas-navigation.spec.ts`, `backend/test/model/calendar-adapter.spec.ts`, `backend/test/model/calendar-stream.spec.ts`.

- [ ] **Write a red pure-admission test** in `canvas-navigation-ownership.spec.ts`. Extend that file's existing loaded-record ownership fixtures. Add a `controlCanvas` function next to `navigateCanvas`, not another service. Its input is the strict envelope, trusted mode, dispatch-time expected selection, latest owned selection, `active()` and synchronous `control(command, target)` callback. Return `CanvasControlResult` with the precedence frozen above. It must not be `async`.

```typescript
it('dispatches a valid relative control synchronously without persistence or target lookup', () => {
  const target = { canvasId: 'm1::canvas::0', revision: 1, open: true, mode: 'diagram' as const };
  const control = vi.fn(() => true);
  const result = controlCanvas({ envelope: { action: 'zoom_in' }, responseMode: 'voice',
    expected: target, selection: target, active: () => true, control });
  expect(result).toEqual({ kind: 'canvas-control', outcome: 'requested', action: 'zoom_in',
    canvas_id: target.canvasId });
  expect(control).toHaveBeenCalledExactlyOnceWith({ action: 'zoom_in' }, target);
  expect(result).not.toBeInstanceOf(Promise);
});
```

- [ ] **Run red** in `backend`: `npm test -- test/runtime/canvas-navigation-ownership.spec.ts -t "dispatches a valid relative control"`.
- [ ] **Implement the admission function and extend the existing port.** `ownedCanvasSelection(snapshot, inventory)` must return null unless its canonical ID belongs to `ownedCanvasInventory`'s already-loaded projection. Compare all four fields, not just ID. Avoid another pass over database records per action: reuse the owned inventory result. Extend both runtime compositions with the same callbacks; do not fix only memory mode.

```typescript
// Add optional members to LiveExecution.canvas; preserve its existing required members.
selection?(): CanvasSelection | null;
control?(command: CanvasControlArguments, target: CanvasSelection,
  toolCallId: string, signal: AbortSignal): boolean;

// CalendarLoopContext additions.
canvasSelection?: () => CanvasSelection | null;
controlCanvas?: (envelope: Record<string, unknown>, toolCallId: string,
  expected: CanvasSelection | null) => CanvasControlResult;
```

In each composition calculate latest selected target from `canvasPort.selection?.()` intersected with `inventoryFor()`. Wire `controlCanvas` using trusted `c.live ? 'voice' : 'text'`, `job.signal`, `canvasPort.active()`, and `canvasPort.control?.()`. Null port means no delivery, not permission. Existing `show_canvas` wiring remains intact.

The pure helper's complete admission shape is:

```typescript
export function ownedCanvasSelection(value: CanvasSelection | null | undefined,
  inventory: CanvasInventorySnapshot): CanvasSelection | null {
  return isCanvasSelection(value) && inventory.items.some(item => item.canvasId === value.canvasId)
    ? { ...value } : null;
}
export function controlCanvas(input: {
  envelope: Record<string, unknown>;
  responseMode: 'text' | 'voice';
  expected: CanvasSelection | null;
  selection: CanvasSelection | null;
  active: () => boolean;
  control: (command: CanvasControlArguments, target: CanvasSelection) => boolean;
}): CanvasControlResult {
  const parsed = controlCanvasArgumentsSchema.safeParse(input.envelope);
  const target = input.expected;
  const result = (outcome: CanvasControlResult['outcome']) => canvasControlResultSchema.parse({
    kind: 'canvas-control', outcome, action: parsed.success ? parsed.data.action : null,
    canvas_id: target?.canvasId ?? null,
  });
  if (input.responseMode !== 'voice') return result('mode-not-allowed');
  if (!parsed.success) return result('invalid-arguments');
  const latest = input.selection;
  if (!target || !latest || target.canvasId !== latest.canvasId || target.revision !== latest.revision
    || target.open !== latest.open || target.mode !== latest.mode
    || (!latest.open && parsed.data.action !== 'close')) return result('unavailable');
  if (latest.mode === 'scroll' && ['zoom_in', 'zoom_out', 'fit_to_view'].includes(parsed.data.action))
    return result('unsupported');
  try {
    if (!input.active()) return result('delivery-unavailable');
    return result(input.control(parsed.data, target) ? 'requested' : 'delivery-unavailable');
  } catch { return result('delivery-unavailable'); }
}
```

```typescript
controlCanvas: (envelope, toolCallId, expected) => controlCanvas({
  envelope, responseMode: c.live ? 'voice' : 'text', expected, selection: selectionFor(),
  active: () => !job.signal.aborted && (canvasPort?.active() ?? false),
  control: (command, target) => canvasPort?.control?.(command, target, toolCallId, job.signal) ?? false,
}),
canvasSelection: selectionFor,
```

- [ ] **Add red adapter ordering tests using existing `calendar-adapter.spec.ts` fixtures.** Use the imported `calendarHarness`, `OpenRouterCalendarAdapter`, `calendarLimits`, `config`, and aliased `skillRequest as calendarRequest`. Make a `ReadableStream<Uint8Array>` with a complete, terminal `control_canvas` frame and no usage/`[DONE]` tail yet. Defer `hooks.onObservation` and `hooks.flushObservations`; assert the decision is yielded **before either deferred promise is released**. Then release the stream tail and accounting, drain the generator, and assert one decision and exact usage evidence. Add same-frame assistant prose to prove that control decision is yielded before its text delta is consumed. Malformed/truncated/parallel calls must never yield an early control decision.

```typescript
const observationGate = deferred();
const flushGate = deferred();
const terminalControl = 'data: ' + JSON.stringify({ choices: [{ index: 0,
  delta: { role: 'assistant', content: 'Requested.', tool_calls: [{ index: 0,
    id: 'control-fast-1', type: 'function', function: { name: 'control_canvas',
      arguments: '{"action":"zoom_in"}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\n';
const h = calendarHarness('');
let streamController!: ReadableStreamDefaultController<Uint8Array>;
h.fetcher.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    streamController = controller;
    controller.enqueue(new TextEncoder().encode(terminalControl));
  },
}), { headers: { 'content-type': 'text/event-stream' } }));
h.binding.hooks.onObservation = vi.fn(async () => observationGate.promise);
h.binding.hooks.flushObservations = vi.fn(async () => flushGate.promise);
const adapter = new OpenRouterCalendarAdapter(config(), calendarLimits, h.binding, h.fetcher);
const out: SkillDecisionChunk[] = [];
const consumer = (async () => {
  for await (const chunk of adapter.stream(calendarRequest())) out.push(chunk);
})();
try {
  await vi.waitFor(() => expect(out.some(chunk => chunk.type === 'decision')).toBe(true));
  expect(h.binding.hooks.flushObservations).not.toHaveBeenCalled();
} finally {
  observationGate.resolve(); flushGate.resolve();
  streamController.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  streamController.close();
  await consumer;
}
expect(out.filter(chunk => chunk.type === 'decision')).toHaveLength(1);
```

Use that test body inside an `it` named with `control`, and add explicit settlement flags to the two gates. Do not `await` the entire consumer before the pre-release assertions. Keep the existing `call_tool` test named “awaits observations before terminal decisions”: only local control behavior is intentionally different. If a red failure happens before a response stream was opened, guard the `streamController` cleanup rather than masking the original assertion failure.

- [ ] **Run red**: `npm test -- test/model/calendar-adapter.spec.ts -t "control"` in `backend`. Expected failure: no complete decision while accounting/tail is pending.
- [ ] **Implement the minimal adapter fast path.** Move local assembly/pure validation ahead of `await publish` for each parsed non-error frame. Once `finish_reason === 'tool_calls'` and `assembly.finish()` returns a valid `control_canvas`, parse the existing `skillDecisionSchema`, `yield {type:'decision', decision}`, and set a local `earlyControl` flag. This is the first complete trustworthy native boundary; JSON-looking argument fragments without terminal/cardinality checks must not execute. Keep reading the provider stream and its bounded accounting afterward; suppress the normal second decision yield for that flag. Other tool/text behavior stays on its existing path.

```typescript
// Initialize once per stream, next to providerEnd/sawFinish.
let earlyControl = false;

// Inside the adapter frame loop, after checking top.error, before observation publish/text yield.
const provisional = assembly.push(raw);
if (!earlyControl && choice.finish_reason === 'tool_calls') {
  const candidate = assembly.finish();
  if (candidate.kind === 'valid' && candidate.nativeCall.function.name === 'control_canvas') {
    const earlyDecision = skillDecisionSchema.parse({ kind: 'control_canvas',
      decisionId: request.decisionId, nativeCall: candidate.nativeCall,
      assistantContent: candidate.assistantContent, envelope: candidate.envelope,
      terminal: 'tool_calls' });
    earlyControl = true;
    yield { type: 'decision', decision: earlyDecision };
  }
}
```

Do not discard later provider/usage failures or bypass Calendar's pre-effect barrier. This fast path applies only to the local presentation decision. A later failure cannot undo a view change or authorize another one. Once `earlyControl` is set, do not await tool-assistant prose delivery before the already-yielded control; the loop must perform its callback immediately on consuming that decision.

After the existing final `publish(true)` and `flushObservations()` complete, add `if (earlyControl) return;` before the ordinary final decision emission. Keep malformed trailing frames/accounting failures on the existing failure path; never yield the presentation decision again as a retry.

- [ ] **Add a red actual-runtime ordering test in the existing `canvas-navigation.spec.ts`.** Reuse its `seededLiveNavigation()` and `calendarLiveFixture` rather than create another runtime. Extend its returned canvas port for control and a selected target. Start execution without awaiting it; use a real control wire plus a deferred continuation response. Hold background save pending (and separately return failed/unknown). At the callback assert no response finish, no local result capacity check, and no subsequent model request has occurred. Hold `MemoryCalendarLedger.finishDispatch` for the control request to prove the callback occurs before ledger finalization as well. Also exercise `calendarLiveFixture('durable')` with decision/observation persistence deferred after model availability; a memory-only helper test is not enough.

```typescript
// Add to the existing runtime test file; import MemoryCalendarLedger.
it('applies a control before actual runtime ledger finalization and background saving', async () => {
  const saveGate = deferred<{ kind: 'unknown'; retryable: false }>();
  const ledgerGate = deferred();
  const { f, target, canvas } = await seededLiveNavigation({ save: () => saveGate.promise });
  const selected = { canvasId: target, revision: 1, open: true, mode: 'diagram' as const };
  const applied = vi.fn(() => {
    expect(f.finish).not.toHaveBeenCalled();
    return true;
  });
  const finishDispatch = MemoryCalendarLedger.prototype.finishDispatch;
  let hold = true;
  const spy = vi.spyOn(MemoryCalendarLedger.prototype, 'finishDispatch')
    .mockImplementation(async function (this: MemoryCalendarLedger, ...args) {
      if (hold) await ledgerGate.promise;
      return finishDispatch.apply(this, args);
    });
  try {
    f.finish.mockClear();
    f.h.modelWires.push(skillWire('control_canvas', { action: 'zoom_in' }, 'control-order-1'),
      textWire('Requested.'));
    const ids = await f.submit('Zoom in.');
    const run = f.execute(ids, undefined, { ...canvas, selection: () => selected, control: applied });
    await vi.waitFor(() => expect(applied).toHaveBeenCalledOnce());
    expect(f.finish).not.toHaveBeenCalled();
    expect(f.h.modelBodies.at(-1)!.messages).not.toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'control-order-1' }));
    hold = false; ledgerGate.resolve(); saveGate.resolve({ kind: 'unknown', retryable: false });
    await run;
  } finally {
    hold = false; ledgerGate.resolve(); saveGate.resolve({ kind: 'unknown', retryable: false });
    spy.mockRestore(); await f.dispose();
  }
});
```

This is the first executable test; extend it with a deferred second model response and the durable branch. For durable ordering, use the same seeded history port but spies on the fixture's real `p.skillDecisions.put/get`, `p.skillResults.put`, and the adapter observation store hooks. Arm spies only **after seed/model dispatch** to avoid blocking setup. Assert control admission before releasing those gates; then release and verify exact pair/accounting. Testing only a failing *previous* turn save does not prove current decision persistence ordering.

- [ ] **Implement the loop fast path at decision consumption.** Capture `const expectedCanvasSelection = this.ctx.canvasSelection?.() ?? null` adjacent to construction of this dispatch's model request. For `control_canvas`, do `job.check()`, finite deadline check, strict argument/mode/selection/lifecycle admission, and synchronous callback **inside the `chunk.type === 'decision'` branch**. No awaited method belongs before that callback. Cache its result once by `nativeCall.id`; the bounded per-turn dispatch budget bounds the map. A repeated ID returns the cached result even when arguments differ and never calls the port again.

```typescript
// CalendarLoop field; NativeLocalResult already includes the new result.
private readonly canvasControlResults = new Map<string, CanvasControlResult>();

// This method is synchronous. Its callback is the first effect after the essential guards.
private dispatchCanvasControl(decision: Extract<SkillDecision, { kind: 'control_canvas' }>,
  expected: CanvasSelection | null): CanvasControlResult {
  const previous = this.canvasControlResults.get(decision.nativeCall.id);
  if (previous) return previous;
  this.ctx.job.check();
  if (Date.parse(this.ctx.ledger.deadlineAt()) <= Date.parse(this.ctx.now()))
    throw new AppError('TIMEOUT', 'The turn deadline has passed.', false);
  const parsed = controlCanvasArgumentsSchema.safeParse(decision.envelope);
  const fallback = (outcome: CanvasControlResult['outcome']): CanvasControlResult =>
    canvasControlResultSchema.parse({ kind: 'canvas-control', outcome,
      action: parsed.success ? parsed.data.action : null, canvas_id: expected?.canvasId ?? null });
  let result: CanvasControlResult;
  if (this.ctx.responseMode !== 'voice') result = fallback('mode-not-allowed');
  else if (!parsed.success) result = fallback('invalid-arguments');
  else {
    try { result = this.ctx.controlCanvas?.(decision.envelope, decision.nativeCall.id, expected)
      ?? fallback('delivery-unavailable'); }
    catch { result = fallback('delivery-unavailable'); }
  }
  const bounded = canvasControlResultSchema.parse(result);
  this.canvasControlResults.set(decision.nativeCall.id, bounded);
  return bounded;
}
```

Keep source-free in-memory decision/result evidence **after dispatch but before resuming the adapter iterator**, so a later observation failure does not silently erase the applied control's pair. Reuse `localRecord`, `skillGroup`, `MemoryCalendarStage.putDecision/putResult`, and the existing group array; do not implement an independent history store. Factor construction of the existing resumable record into one local method only if necessary to avoid duplicating its full fields. In memory mode stage both records synchronously after dispatch and append their group once; in durable mode hold the same bounded pair on the loop and write it through the existing post-decision path after dispatch. Use one pending-presentation slot containing the current decision/result/record for that boundary, not a durable replay queue. The map of prior outcomes is bounded by the existing per-turn dispatch limit. No durable pre-effect write or capacity preflight is permitted for this tool.

When a successful stream finishes, retain the normal accounting/decision/result writes afterward. Handle the already-dispatched control directly in `decide`: use its held decision/result, finish the existing records, set `cursor.next='decide'` with `pendingDecisionId=null`, and return its refs without entering `execute`. That is smaller and safer than another decision-store read/permission gate for an effect already performed. Stage/push each group exactly once, and preserve in-memory evidence when later accounting returns failure. Extend `recordLocal`'s presentation exception and `repeatsEarlierRead`'s native exclusions to include `control_canvas`. The legacy/restored `execute` branch may load a saved decision through its existing path, but when its kind is `control_canvas` it only records `delivery-unavailable`, never calls the control port. All nonpresentation tools keep their existing durability/fence/Calendar gates. Do not fork, detach, or ignore writes that the existing ledger owns; their bounded post-effect failure handling must remain honest.

- [ ] **Complete runtime regressions:** text and dictation-as-text rejected; disabled/absent Calendar accepted; no Calendar account/API access; selection changed during model request rejected; wrong owner/current call/cancelled signal rejected; no duplicate on same turn execution; distinct native IDs execute twice; restored/hydrated pair does not execute; a later assembly/accounting failure retains available local evidence without replay; failing or never-settling background save does not block a following turn. A new native continuation model call after the result is normal; an extra lookup/planning request before the action is forbidden.
- [ ] **Run green** in `backend`: `npm test -- test/runtime/canvas-navigation.spec.ts test/runtime/canvas-navigation-ownership.spec.ts test/model/calendar-adapter.spec.ts test/model/calendar-stream.spec.ts`. Record discovered tests and any failure rather than deleting a difficult case.
- [ ] **Commit** named task files with `feat(canvas): dispatch voice controls before persistence`.

## Task 3: Extend the existing scoped transport, without touching media sequencing

**Modify:** `backend/src/voice/agent/agent-voice-adapter.ts`, `backend/src/voice/session/voice-session.options.ts`, `backend/src/voice/transport/livekit-control.ts`, `livekit-media.ts`, `frontend/src/api/livekit-voice-client.ts`.

**Tests:** `backend/test/voice/transport/livekit-control.spec.ts`, `backend/test/voice/agent/livekit-pipeline.spec.ts`, `frontend/src/api/livekit-voice-client.test.ts`. Reuse `backend/test/voice/agent/livekit-pipeline-fixture.ts` for the real bridge/media composition; only extend that fixture if its existing hooks cannot drive the Canvas port.

- [ ] **Write red lane tests** in the existing transport specs: a pending ordinary publish must not block `canvas.control`; the same Canvas count/byte limits apply to mixed show/control traffic; optional publish failure does not call `fail` or consume normal media sequence; closed/paused/not-ready/aborted/stale binding rejects. Scope tests must use the established fixture session/epoch/participant, not hand-wave trusted scope in a helper.

```typescript
it('shares the Canvas presentation lane for show and control without waiting for ordinary output', async () => {
  const f = fixture();
  const ordinary = deferred();
  f.publish.mockImplementation(async bytes => {
    const event = JSON.parse(new TextDecoder().decode(bytes)) as { type: string };
    if (event.type !== 'canvas.control') await ordinary.promise;
  });
  try {
    f.controls.send({ type: 'voice.state', input: 'listening', agent: 'idle', connection: 'connected' });
    expect(f.controls.showCanvas({ type: 'canvas.control', conversationId: 'conversation-1',
      turnId: 'turn-1', responseId: 'response-1', controlId: 'control-1',
      canvasId: 'm1::canvas::0', selectionRevision: 1, command: { action: 'zoom_in' } },
    new AbortController().signal, () => true)).toBe(true);
    await vi.waitFor(() => expect(f.publish.mock.calls.some(([bytes]) =>
      JSON.parse(new TextDecoder().decode(bytes)).type === 'canvas.control')).toBe(true));
    expect(f.fail).not.toHaveBeenCalled();
  } finally { ordinary.resolve(); await f.controls.flush(); f.controls.close(); }
});
```

- [ ] **Run red:** `backend`: `npm test -- test/voice/transport/livekit-control.spec.ts -t "shares the Canvas presentation lane"`. Expected: new payload not admitted/typed until the existing method is generalized.
- [ ] **Generalize, do not duplicate.** Widen existing `VoiceSink.showCanvas`, `LiveKitMedia.showCanvas`, and `LiveKitControls.showCanvas` payload types to `CanvasShowPayload | CanvasControlPayload`. The historical name is acceptable for this minimal diff; update comments to describe both presentation requests. Preserve one `canvasOutgoing`, one `canvasTx`, the existing count/byte caps, and the ordinary sequence.

```typescript
showCanvas?(payload: CanvasShowPayload | CanvasControlPayload,
  signal: AbortSignal, current: () => boolean): boolean;
```

Store selection alongside the adapter's existing `{conversationId, inventory}` snapshot in its synchronous `canvasInventory` hook; clear it with existing attach/close/disconnect clearing. Expose `selection()` on the existing runtime port. Extend that port's object with `control()` using the same `canvasCurrent` closure and the existing sink method.

```typescript
control: (command: CanvasControlArguments, target: CanvasSelection,
  toolCallId: string, signal: AbortSignal): boolean => {
  const sink = this.sink;
  if (!sink?.showCanvas || signal.aborted || !canvasCurrent()) return false;
  const latest = this.canvas?.selection;
  if (!latest || latest.canvasId !== target.canvasId || latest.revision !== target.revision) return false;
  try {
    return sink.showCanvas({ type: 'canvas.control', conversationId: ids.sessionId,
      turnId: ids.turnId, responseId, controlId: key('canvas-control', responseId, toolCallId),
      canvasId: target.canvasId, selectionRevision: target.revision, command }, signal, canvasCurrent);
  } catch { return false; }
},
```

The existing `canvasCurrent` closure is rechecked at actual queued publication; selection revision should be rechecked there too for control payloads, not only at admission. A change before publication drops this optional control without media failure. Keep `show_canvas` reopening semantics unchanged.

The existing LiveKit pipeline fixture already exposes its runtime spy and control sender; it does not need a new transport fixture. Add a case using its active execution port directly to test the adapter boundary:

```typescript
it('binds a Canvas control to the current live call and selected revision', async () => {
  const f = await pipeline();
  try {
    const ref = await f.begin();
    const conversationId = f.context.response.conversationId!;
    const target = { canvasId: 'message-1::canvas::0', revision: 1,
      open: true, mode: 'diagram' as const };
    await f.control({ type: 'canvas.inventory', conversationId,
      inventory: { items: [{ canvasId: target.canvasId, title: 'Existing diagram',
        owner: { kind: 'message', id: 'message-1' } }], omitted: 0 }, selection: target });
    const execution = vi.mocked(f.runtime.executeTurn!).mock.calls[0]![0];
    const port = execution.live!.canvas!;
    expect(port.selection?.()).toEqual(target);
    expect(port.control?.({ action: 'zoom_in' }, target, 'native-control-1',
      new AbortController().signal)).toBe(true);
    await f.until(() => f.events().some(event => event.type === 'canvas.control'));
    expect(f.events()).toContainEqual(expect.objectContaining({ type: 'canvas.control',
      conversationId, turnId: ref.turnId, responseId: ref.responseId,
      canvasId: target.canvasId, selectionRevision: 1, command: { action: 'zoom_in' } }));
    expect(port.control?.({ action: 'zoom_in' }, { ...target, revision: 2 }, 'native-control-2',
      new AbortController().signal)).toBe(false);
  } finally { await f.close(); }
});
```

This is an adapter/transport isolation test with a fake runtime, not the actual persistence-ordering proof; keep Task 2/6's real-runtime checks.

In `LiveKitVoiceClient.accept`, use the existing Canvas branch for both `canvas.show` and `canvas.control`. Both share `canvasRx`, tolerate missing presentation sequence numbers, are fenced by session/epoch/readiness, and never advance normal `rx`.

```typescript
if (event.type === 'canvas.show' || event.type === 'canvas.control') {
  if (!this.ready || event.sequence <= this.canvasRx) return;
  this.canvasRx = event.sequence;
  try { this.options.event?.(event); } catch { /* Presentation never fails media. */ }
  return;
}
```

- [ ] **Finish isolation tests:** mixed show/control increasing presentation sequences; retransmission same sequence dropped; higher sequence same control ID reaches controller dedupe; old Room callback/stale epoch dropped; wrong participant ignored by the real data callback; callback/publish failure contained; queue abort/current callback rechecked after ordinary controls are pending. Do not loosen malformed-wire rejection for all voice events.
- [ ] **Run green:**
  - `backend`: `npm test -- test/voice/transport/livekit-control.spec.ts test/voice/agent/livekit-pipeline.spec.ts`
  - `frontend`: `npm test -- src/api/livekit-voice-client.test.ts`
- [ ] **Commit** with `feat(voice): carry canvas controls on the existing presentation lane`.

## Task 4: Implement seven local Canvas effects and the mounted-panel handle

**Create:** `frontend/src/features/canvas/canvas-controls.ts`, `canvas-controls.test.ts`.

**Modify:** `frontend/src/features/canvas/CanvasPanel.tsx`.

**Regression tests:** `frontend/src/features/canvas/canvas.test.ts`, `calendar-canvas.test.ts`.

- [ ] **Write red deterministic view tests** with repository headers and imports from the new module. Export `DEFAULT_CANVAS_VIEW`, `stepCanvasZoom`, `scrollCanvasView`, `fitCanvasView`, `measureCanvasGraphics`, and `applyCanvasControl` from this one small Canvas-specific module. The DOM seam accepts only the stage/viewport/scroll body and state callbacks it needs; do not add a class, event bus, reducer store, injectable clock, or generic command framework.

```typescript
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CANVAS_VIEW, stepCanvasZoom, scrollCanvasView, fitCanvasView,
  applyCanvasControl } from './canvas-controls.ts';

describe('Canvas presentation controls', () => {
  it('uses existing bounded zoom steps and preserves position', () => {
    const view = { zoom: 100, panX: 18, panY: -23 };
    expect(stepCanvasZoom(view, 1)).toEqual({ ...view, zoom: 125 });
    expect(stepCanvasZoom(view, -1)).toEqual({ ...view, zoom: 75 });
    expect(stepCanvasZoom({ ...view, zoom: 300 }, 1).zoom).toBe(300);
    expect(stepCanvasZoom({ ...view, zoom: 25 }, -1).zoom).toBe(25);
  });
  it('fits measured graphics and centers them instead of resetting to 100 percent', () => {
    const viewport = { x: -200, y: -100, width: 400, height: 200 };
    const graphics = { x: -500, y: -200, width: 1000, height: 400 };
    expect(fitCanvasView(viewport, graphics)).toEqual({ zoom: 40, panX: 0, panY: 0 });
    expect(DEFAULT_CANVAS_VIEW).toEqual({ zoom: 100, panX: 0, panY: 0 });
    expect(fitCanvasView(viewport, { ...graphics, x: -400 }))
      .toEqual({ zoom: 40, panX: -40, panY: 0 });
    expect(fitCanvasView(viewport, { ...graphics, width: 0 })).toBeNull();
    expect(fitCanvasView(viewport, { ...graphics, width: Infinity })).toBeNull();
  });
  it('scrolls the view in all four directions with bounded relative steps', () => {
    const view = { zoom: 125, panX: 0, panY: 0 };
    expect(scrollCanvasView(view, 'down', 400, 200).panY).toBe(-150);
    expect(scrollCanvasView(view, 'up', 400, 200).panY).toBe(150);
    expect(scrollCanvasView(view, 'right', 400, 200).panX).toBe(-300);
    expect(scrollCanvasView(view, 'left', 400, 200).panX).toBe(300);
    expect(scrollCanvasView(view, 'down', 400, 10000).panY).toBe(-800);
    expect(scrollCanvasView({ ...view, panY: -100000 }, 'down', 400, 200).panY).toBe(-100000);
  });
});
```

- [ ] **Run red** in `frontend`: `npm test -- src/features/canvas/canvas-controls.test.ts`. Expected: missing module/exports.
- [ ] **Implement the finite pure math**, retaining zoom constants and using it for manual toolbar operations too. Do not change wheel zoom's distinct pointer-centered behavior (`computeWheelZoomView`).

```typescript
export type CanvasView = { zoom: number; panX: number; panY: number };
export type CanvasRect = { x: number; y: number; width: number; height: number };
export const DEFAULT_CANVAS_VIEW: CanvasView = { zoom: 100, panX: 0, panY: 0 };
export const MIN_CANVAS_ZOOM = 25;
export const MAX_CANVAS_ZOOM = 300;
export const CANVAS_ZOOM_STEP = 25;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const validRect = (value: CanvasRect) => Object.values(value).every(Number.isFinite)
  && value.width > 0 && value.height > 0;
export function stepCanvasZoom(view: CanvasView, direction: 1 | -1): CanvasView {
  return { ...view, zoom: clamp(view.zoom + direction * CANVAS_ZOOM_STEP,
    MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM) };
}
export function scrollCanvasView(view: CanvasView, direction: 'up' | 'down' | 'left' | 'right',
  width: number, height: number): CanvasView {
  const horizontal = direction === 'left' || direction === 'right';
  const dimension = horizontal ? width : height;
  const step = Number.isFinite(dimension) ? clamp(dimension * .75, 0, 800) : 0;
  const delta = direction === 'down' || direction === 'right' ? -step : step;
  // ponytail: voice pan is capped at 100000 CSS px; replace with measured content-edge bounds if needed.
  return { ...view, panX: horizontal ? clamp(view.panX + delta, -100000, 100000) : view.panX,
    panY: horizontal ? view.panY : clamp(view.panY + delta, -100000, 100000) };
}
export function fitCanvasView(viewport: CanvasRect, graphics: CanvasRect): CanvasView | null {
  if (!validRect(viewport) || !validRect(graphics)) return null;
  const zoom = clamp(Math.min(viewport.width / graphics.width, viewport.height / graphics.height) * 100,
    MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM);
  const scale = zoom / 100;
  const fitted = { zoom, panX: viewport.x + viewport.width / 2 - (graphics.x + graphics.width / 2) * scale,
    panY: viewport.y + viewport.height / 2 - (graphics.y + graphics.height / 2) * scale };
  return Object.values(fitted).every(Number.isFinite) ? fitted : null;
}
```

- [ ] **Add red local application/measurement tests before the DOM seam.** Use structural Node doubles for `querySelector`, `getBBox`, `getScreenCTM`, bounding rectangles, `style`, and scroll dimensions. Their measurements must differ from stage size, include an off-center graphics box, CSS scaling, and nonzero view pan/zoom. Assert measurement temporarily neutralizes/restores the stage transform/transition even when `getBBox` throws. Test unavailable/missing graphics/zero viewport, Calendar/code unsupported zoom/fit without state mutation, native scroll clamp in all directions, reset scroll to zero, close only invokes close callback, and explicit fullscreen `[true,true,false,false]` rather than toggling.

```typescript
const setMaximized = vi.fn();
const close = vi.fn();
let current = { zoom: 175, panX: 40, panY: -30 };
const body = { scrollTop: 50, scrollLeft: 20, clientHeight: 200, clientWidth: 400,
  scrollHeight: 900, scrollWidth: 1000 };
const port = {
  mode: 'scroll' as const, open: true,
  getView: () => current, setView: (next: typeof current) => { current = next; },
  viewport: null, stage: null, body, close, setMaximized,
};
expect(applyCanvasControl({ action: 'zoom_in' }, port)).toBe('unsupported');
expect(current.zoom).toBe(175);
expect(applyCanvasControl({ action: 'scroll', direction: 'down' }, port)).toBe('applied');
expect(body.scrollTop).toBe(200);
expect(applyCanvasControl({ action: 'reset_view' }, port)).toBe('applied');
expect(current).toEqual(DEFAULT_CANVAS_VIEW);
expect([body.scrollLeft, body.scrollTop]).toEqual([0, 0]);
for (const state of ['enter', 'enter', 'exit', 'exit'] as const)
  applyCanvasControl({ action: 'fullscreen', state }, port);
expect(setMaximized.mock.calls).toEqual([[true], [true], [false], [false]]);
applyCanvasControl({ action: 'close' }, port);
expect(close).toHaveBeenCalledOnce();
```

`applyCanvasControl` returns only local `'applied' | 'unavailable' | 'unsupported'`; no server acknowledgement or new persistent result collection follows. In diagram mode require a visible viewport/stage for geometry actions. Reset/close/expansion don't depend on SVG existence. For scroll mode the native body is the exact ordinary scroll container, not its outer overflow-hidden wrapper.

- [ ] **Implement measured fit and application** in the same small module. Define a narrow `CanvasControlPort` matching the test above: `mode`, `open`, `getView`, `setView`, nullable `viewport`/`stage`, nullable structural body with six numeric scroll properties, `close`, `setMaximized`. Use a strict command type imported from `voice-protocol.ts`; this function has no external service or persistence access.

```typescript
export type CanvasControlPort = {
  mode: 'diagram' | 'scroll'; open: boolean;
  getView: () => CanvasView; setView: (view: CanvasView) => void;
  viewport: HTMLDivElement | null; stage: HTMLDivElement | null;
  body: { scrollTop: number; scrollLeft: number; clientHeight: number; clientWidth: number;
    scrollHeight: number; scrollWidth: number } | null;
  close: () => void; setMaximized: (value: boolean) => void;
};
export function applyCanvasControl(command: CanvasControlArguments, port: CanvasControlPort):
  'applied' | 'unavailable' | 'unsupported' {
  if (command.action === 'close') { if (port.open) port.close(); return 'applied'; }
  if (!port.open) return 'unavailable';
  if (command.action === 'fullscreen') { port.setMaximized(command.state === 'enter'); return 'applied'; }
  if (command.action === 'reset_view') {
    port.setView({ ...DEFAULT_CANVAS_VIEW });
    if (port.body) { port.body.scrollTop = 0; port.body.scrollLeft = 0; }
    return 'applied';
  }
  if (port.mode === 'scroll' && command.action !== 'scroll') return 'unsupported';
  if (command.action === 'scroll' && port.mode === 'scroll') {
    const body = port.body;
    if (!body) return 'unavailable';
    const values = [body.scrollTop, body.scrollLeft, body.clientHeight, body.clientWidth,
      body.scrollHeight, body.scrollWidth];
    if (!values.every(Number.isFinite)) return 'unavailable';
    const horizontal = command.direction === 'left' || command.direction === 'right';
    const step = clamp((horizontal ? body.clientWidth : body.clientHeight) * .75, 0, 800);
    const delta = command.direction === 'down' || command.direction === 'right' ? step : -step;
    if (horizontal) body.scrollLeft = clamp(body.scrollLeft + delta, 0,
      Math.max(0, body.scrollWidth - body.clientWidth));
    else body.scrollTop = clamp(body.scrollTop + delta, 0, Math.max(0, body.scrollHeight - body.clientHeight));
    return 'applied';
  }
  if (!port.viewport || !port.stage || port.viewport.clientWidth <= 0 || port.viewport.clientHeight <= 0)
    return 'unavailable';
  if (command.action === 'zoom_in' || command.action === 'zoom_out') {
    port.setView(stepCanvasZoom(port.getView(), command.action === 'zoom_in' ? 1 : -1));
  } else if (command.action === 'scroll') {
    port.setView(scrollCanvasView(port.getView(), command.direction,
      port.viewport.clientWidth, port.viewport.clientHeight));
  } else {
    const measured = measureCanvasGraphics(port.viewport, port.stage);
    if (!measured) return 'unavailable';
    const fitted = fitCanvasView(measured.viewport, measured.graphics);
    if (!fitted) return 'unavailable';
    port.setView(fitted);
  }
  return 'applied';
}
```

Measurement algorithm (all synchronous and confined to fit):
1. Save the stage element's inline `transform` and `transition`.
2. Set `transition='none'` and `transform='none'`; measure current neutral stage and viewport rectangles.
3. Read viewport padding with native `getComputedStyle` when available (test doubles supply deterministic values). Derive neutral stage CSS-to-screen scales from `stageRect.width/stage.offsetWidth` and `stageRect.height/stage.offsetHeight`; both must be finite and positive. Convert screen rectangles into CSS-pixel coordinates relative to that neutral stage center, then inset viewport padding in CSS px. This keeps fit pan values correct under parent CSS scaling as well as SVG transforms.
4. Find the current rendered `svg`, require `getBBox()` and nonnull finite `getScreenCTM()`, transform all four graphics-box corners with the matrix coefficients `(a,b,c,d,e,f)`, and take finite min/max. Convert their pixel rectangle into those same CSS-pixel stage-center-relative coordinates. Do not use SVG source regex, natural viewBox size alone, or stage width as diagram size. The existing panel uses axis-aligned transforms; do not add arbitrary rotated-parent layout support.
5. In `finally` restore both inline properties. Return the two rectangles, or null for unavailable geometry. Apply the pure `fitCanvasView` result only after a complete finite measurement.

The corner projection uses only arithmetic and the browser's measured matrix, so it is testable without constructing `DOMPoint` in Node:

```typescript
const corners = [[box.x, box.y], [box.x + box.width, box.y],
  [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]];
const points = corners.map(([x, y]) => ({
  x: matrix.a * x! + matrix.c * y! + matrix.e,
  y: matrix.b * x! + matrix.d * y! + matrix.f,
}));
```

Do not schedule a later retry when measurement is unavailable, as it could hit another selected artifact. The DOM-double check proves geometry/application code behavior, not actual browser SVG bounds, font/stroke inclusion, animation, or paint.

- [ ] **Wire the existing panel state with an imperative handle.** Export `CanvasPanelHandle` from `CanvasPanel.tsx` with `apply(command:CanvasControlArguments, expectedCanvasId:string): 'applied' | 'unavailable' | 'unsupported'`. This internal expected ID is supplied by the selected UI binding, never the model. Add optional `controlRef?: Ref<CanvasPanelHandle>` and `onPresentationModeChange?: (mode:'diagram'|'scroll')=>void`. Use `useImperativeHandle` before the current early return, a separate rendered stage ref (the existing `stageRef` points at the viewport), and refs on `.aurvin-canvas-calendar-body` / `.aurvin-canvas-code-view` for native scrolling. Thread a `Ref<HTMLDivElement>` into `CodeLinesView` instead of querying the document.

```typescript
useImperativeHandle(controlRef, () => ({
  apply: (command, expectedCanvasId) => activeArtifact?.artifactId !== expectedCanvasId
    ? 'unavailable' : applyCanvasControl(command, {
    mode: calendarMode || viewMode === 'code' ? 'scroll' : 'diagram',
    open: transitionState === 'open' && activeArtifact !== null,
    getView: () => view,
    setView, viewport: stageRef.current, stage: renderedStageRef.current,
    body: bodyRef.current, close: onClosePanel, setMaximized,
  }),
}), [calendarMode, viewMode, transitionState, activeArtifact, view, onClosePanel]);
```

The receive wrapper in Task 5 flushes each application, so distinct repeated controls read the committed updated view, not a stale closure. Publish presentation mode from a small layout effect on Calendar/code/preview changes; do not send any voice command from that effect. Existing tab selection still resets view. Manual zoom/reset now call the shared functions; manual maximize can keep its existing toggle, while the voice handle sets explicit state. Do not add an eighth voice action or change Calendar buttons.

- [ ] **Run green** in `frontend`: `npm test -- src/features/canvas/canvas-controls.test.ts src/features/canvas/canvas.test.ts src/features/canvas/calendar-canvas.test.ts`. Add static markup assertions that manual labels, sanitized SVG rendering, source view, Calendar body, maximize class semantics, and close callbacks remain wired, but label these SSR regression checks, not interactive browser proof.
- [ ] **Commit** with `feat(canvas): apply bounded local view controls`.

## Task 5: Bind the selected surface and apply received controls immediately

**Modify:** `frontend/src/features/voice/state/live-voice-controller.ts`, `useLiveVoice.ts`, `frontend/src/features/chat/ChatView.tsx`.

**Tests:** `frontend/src/features/voice/integration-tests/canvas-navigation.test.ts`, `frontend/src/features/voice/state/live-voice-controller.test.ts`, `frontend/src/features/chat/ChatView.voice.test.ts`.

- [ ] **Write red receive/application integration cases** in the existing Canvas navigation integration file using `matrixFixture`, `live()`, `bindingsFor()`, and the real `LiveKitVoiceClient` → `LiveVoiceController` path. Extend `updateCanvasInventory` with a third optional presentation binding:

```typescript
type CanvasPresentationBinding = {
  canvasId: string;
  open: boolean;
  mode: 'diagram' | 'scroll';
  apply: (command: CanvasControlArguments) => 'applied' | 'unavailable' | 'unsupported';
};
```

The controller generates/stores the revision; UI code cannot choose one. Absent/null binding advertises no selected control target without changing inventory/show behavior.

```typescript
it('applies distinct relative controls immediately once per identity', async () => {
  const f = await live(bindingsFor(vi.fn(), () => 'conversation-1'));
  let view = { zoom: 100, panX: 0, panY: 0 };
  const apply = vi.fn((command: CanvasControlArguments) => applyCanvasControl(command, {
    mode: 'diagram', open: true, getView: () => view, setView: next => { view = next; },
    viewport: { clientWidth: 400, clientHeight: 200 } as HTMLDivElement,
    stage: {} as HTMLDivElement, body: null, close: vi.fn(), setMaximized: vi.fn(),
  }));
  try {
    const surface = collectSessionCanvasArtifacts([
      message('message-text-1', diagram('Pricing comparison')),
    ], '', false);
    const id = surface[0]!.artifactId;
    f.controller.updateCanvasInventory('conversation-1', surface,
      { canvasId: id, open: true, mode: 'diagram', apply });
    await settle();
    const packets = f.rtc.packets() as Array<{ type: string; selection?: { revision: number } }>;
    const revision = packets.filter(packet => packet.type === 'canvas.inventory').at(-1)!.selection!.revision;
    const payload = { type: 'canvas.control' as const, conversationId: 'conversation-1',
      turnId: 'control-turn', responseId: 'control-response', canvasId: id,
      selectionRevision: revision, controlId: 'control-1', command: { action: 'zoom_in' as const } };
    f.event(payload);
    expect(view.zoom).toBe(125); // No settle/ack/effect/persistence wait after receipt.
    f.event(payload);
    expect(view.zoom).toBe(125);
    f.event({ ...payload, controlId: 'control-2' });
    expect(view.zoom).toBe(150);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(f.rtc.room.disconnect).not.toHaveBeenCalled();
  } finally { f.controller.exit(); await settle(); }
});
```

Import `applyCanvasControl` from `../../canvas/canvas-controls.ts` and the command type from the existing voice protocol. These two structural element doubles are explicit Node boundaries, not a mounted browser. Use a genuinely deferred unrelated ordinary publish/save/response-completion promise in an additional case, not a comment claiming one exists. On callback inspect the promise settlement flags and a local monotonic observation (`performance.now()` or fixture counter) at delivery and application. Assert synchronous observation ordering, not an invented SLA.

- [ ] **Run red** in `frontend`: `npm test -- src/features/voice/integration-tests/canvas-navigation.test.ts -t "applies distinct relative controls"`.
- [ ] **Extend the existing controller surface**, not a registry. Store the optional binding and generated selection alongside its existing `canvasSurface`. Its metadata string becomes `JSON.stringify({inventory, selection})`; use the existing changed-metadata publication optimization and preserve old inventory-only calls. Generate a new revision only for the selection key `(conversationId, canvasId, open, mode)` changing; retain the updated `apply` callback even when the key/metadata do not change. Reject a binding whose canonical target is absent from its current surface/inventory. Publish optional selection via the same `run.client.control({type:'canvas.inventory', ...})`.

```typescript
private canvasSelectionRevision = 0;

updateCanvasInventory = (conversationId: string | null, artifacts: readonly CanvasArtifact[],
  presentation?: CanvasPresentationBinding | null): void => {
  if (conversationId === null) {
    this.canvasSurface = null; this.canvasPublished = null; return;
  }
  try {
    const responseIds = new Set<string>(this.run?.projectionsByResponse.keys() ?? []);
    const inventory = canvasInventory(artifacts, { responseIds });
    const target = presentation && inventory.items.some(item => item.canvasId === presentation.canvasId)
      ? presentation : null;
    const previous = this.canvasSurface;
    const same = target && previous?.conversationId === conversationId && previous.selection
      && previous.selection.canvasId === target.canvasId && previous.selection.open === target.open
      && previous.selection.mode === target.mode;
    let selection: CanvasSelection | null = null;
    if (target && (same || this.canvasSelectionRevision < Number.MAX_SAFE_INTEGER)) {
      const revision = same ? previous!.selection!.revision : ++this.canvasSelectionRevision;
      selection = { canvasId: target.canvasId, revision, open: target.open, mode: target.mode };
    }
    const binding = selection ? target : null;
    const metadata = JSON.stringify({ inventory, selection });
    this.canvasSurface = { conversationId, artifacts, inventory, selection,
      presentation: binding, metadata };
    this.publishCanvasInventory(this.run);
  } catch { /* Bounded presentation metadata never changes voice media. */ }
};
```

Extend `canvasSurface`'s inline type with `selection: CanvasSelection | null` and `presentation: CanvasPresentationBinding | null` to match this implementation. Preserve the counter across surface clearing; restarting a voice run still has its own session/epoch fence. Include `selection: surface.selection` in the existing inventory publication. Clearing a surface clears only its binding/selection, not artifacts or tabs elsewhere in chat state.

- [ ] **Add the synchronous control receive branch.** Reuse `acceptCanvasShow`'s current-run/phase/connection/gesture/conversation/turn/cancelled/retired fences and its pre-audio requester registration. Share a small private requester-admission helper only if it removes duplicated guard logic; do not weaken navigation. The real `event()` entry already calls `this.current(run)`; preserve this. Additionally check portable payload, exact current selection/revision, current inventory membership, panel-open policy, and bounded identity set. Consume identity before invoking application or evaluating local action support so thrown/unsupported/unavailable application is not replayed later.

```typescript
// Insert after the shared lifecycle/requester checks and exact selection checks.
const identity = `control:${event.controlId}`;
if (run.navigationIds.has(identity) || run.navigationIds.size >= 4096) return;
run.navigationIds.add(identity);
try { surface.presentation?.apply(event.command); }
catch { /* Optional presentation never pauses, restarts, or terminates media. */ }
```

No promise, browser acknowledgement, `requestAnimationFrame`, effect queue, audio/TTS wait, or persistence API belongs in this branch. A stale relative control is discarded, not queued. Keep artifacts/projections untouched and never call `openCanvasArtifact`/`ARTIFACT_ACCEPTED` for controls.

- [ ] **Wire `ChatView` directly through the existing live surface API.** Add optional third-argument type to `LiveVoiceSurface.updateCanvasInventory`; `useLiveVoice` already passes the controller method through, so no `App.tsx` binding is needed. Create `const canvasControlRef = useRef<CanvasPanelHandle | null>(null)` and a small mode mirror (`'diagram' | 'scroll'`) in `ChatView`; pass the ref and mode-change callback to `CanvasPanel`. Derive the selected canonical artifact only by matching `state.activeCanvasArtifactId`; no fallback to the last unrelated artifact. Keep selection when panel closes so repeated close is harmless.

Move/enlarge the existing inventory layout effect below the declarations it depends on. Send the same full merged inventory, plus selected ID/open/mode and the synchronous application closure. Hide controls when `visible` is false; returning no binding in a hidden chat/admin surface prevents hidden Canvas control. For a Calendar selected artifact derive scroll mode immediately, independent of a previous diagram's mode mirror. An exiting inert panel is closed, not an active target.

```typescript
apply: command => {
  if (command.action === 'close' && !showCanvasPanel) return 'applied';
  let outcome: 'applied' | 'unavailable' | 'unsupported' = 'unavailable';
  flushSync(() => {
    outcome = canvasControlRef.current?.apply(command, selectedArtifact.artifactId) ?? 'unavailable';
  });
  return outcome;
},
```

Import `flushSync` from the installed `react-dom`. The selected artifact is nonnull when constructing this binding; otherwise pass null as the presentation argument. This wrapper is called only from a validated voice receive event; registration happens in layout effects but application never does. `close` reaches the existing `closeCanvasPanel()` callback, preserving exit animation/focus restoration/retained tabs. No new storage or direct deletion is involved. Do not clear/re-register the surface on every publishing effect cleanup, which would churn target revisions. Keep the publishing layout effect update-only; use a separate unmount/controller-change cleanup as below. Guard the real panel handle by active canonical artifact and open transition as well; the controller is not the sole safety boundary.

```typescript
useLayoutEffect(() => () => {
  liveVoice?.updateCanvasInventory?.(null, []);
}, [liveVoice?.updateCanvasInventory]);
```

- [ ] **Finish the isolation matrix before committing:** A→B→A selection revision rejects delayed A; changing code/preview invalidates old commands; wrong conversation/call/session/epoch/target/turn rejected; cancelled and retired requester rejected before/after first audio; paused/ended/hidden surface rejects; duplicate ID with different command never reapplies; distinct repeat IDs apply; thrown apply contained; closed close no-op; no reopening by fullscreen/scroll/reset; missing artifact no fallback; Calendar zoom/fit unsupported and Calendar confirmation remains unchanged; no media capture/publish/reconnect changes. Assert selection revisions do not churn from callback recreation, inventory title changes, zoom or maximize changes.
- [ ] **Run green** in `frontend`: `npm test -- src/features/voice/integration-tests/canvas-navigation.test.ts src/features/voice/state/live-voice-controller.test.ts src/features/chat/ChatView.voice.test.ts src/features/canvas/canvas-controls.test.ts`. Static `ChatView` assertions should show the panel still mounts beside live voice; they cannot assert that effects/ref application ran.
- [ ] **Commit** with `feat(voice): apply canvas controls to the current selected surface`.

## Task 6: Verify assembled ordering, regressions, instructions, and honest evidence

**Modify:** `backend/src/instructions/system.md`, `backend/test/runtime/canvas-navigation.spec.ts`, `backend/test/voice/integration/canvas-navigation.spec.ts`, and existing hardcoded native catalogue expectations exposed by the package suites. Do not change unrelated snapshots or reduce assertions to make tests pass.

- [ ] **Add red policy assertions** beside existing `show_canvas` instruction tests. Require these exact policy points in the system asset: direct native tool; backend-selected voice only including no dictation-as-text effect; seven arguments; selected target only; scroll direction meaning; fit versus reset; explicit application expansion, not browser fullscreen; no Calendar mutation/confirmation; requested is not displayed; no replacement visual on a view-only action. Update existing “must generate a new visual” exceptions to include an authorized `control_canvas` request without removing new-explanation visual rules.

```typescript
it('documents presentation controls without requiring replacement content or confirmed display', () => {
  const text = readFileSync(new URL('../../src/instructions/system.md', import.meta.url), 'utf8');
  expect(text).toContain('control_canvas is a directly advertised built-in');
  expect(text).toContain('fit_to_view measures and centers the rendered diagram');
  expect(text).toContain('reset_view restores 100% zoom and neutral position');
  expect(text).toContain('fullscreen uses state enter or exit for application panel expansion');
  expect(text).toContain('does not approve or mutate Calendar data');
  expect(text).toContain('requested is not confirmation that the browser displayed or applied it');
});
```

- [ ] **Run red**, add concise instructions implementing exactly those points, and run green: `backend`: `npm test -- test/runtime/canvas-navigation.spec.ts -t "documents presentation controls"`.
- [ ] **Extend the real offline assembled voice integration test**, reusing its `liveFixture`, `seedCanvas`, `inventory`, `integratedFixture`, `peer.events`, and seeded owned target. Advertise selection in the current inventory payload; script a `control_canvas` response followed by normal spoken continuation. Assert one scoped `canvas.control` request uses the requesting turn/response, the selected target/revision and stable control ID, with no extra artifact generation, Calendar request/account lookup, or voice errors. Capture the event **before** `finishReply()`/TTS completion.

In a second case defer/fail the existing memory-first save callback and defer ordinary TTS completion. The scoped control packet must be observed before release of either gate. Check real native accounting/history after release. In a third case block the durable observation/decision path after tool availability and prove the same packet is admitted before it settles. Keep the adapter test and runtime test too: transport-only success does not prove earlier ordering.

`f.startReply()` waits for the fake TTS `speak` call and first audio, so it is not an early-ordering observation point. Start the request with `f.latest().stt.events.push({type:'end-of-turn', providerTurnId:'control-fast-turn', text:'Zoom in.'})`, observe the packet before speech, then obtain `f.latest().bridge!.currentResponse()` for later completion. The early observation must be `await vi.waitFor(() => expect(peer.events().some(e => e.type === 'canvas.control')).toBe(true))` while gates remain unresolved. Release gates in `finally` and close every fixture so no timer/server leaks remain.

- [ ] **Add exact history/replay and failure regressions:** round-trip the control assistant/tool pair through cold runtime hydration without a second control dispatch; same completed turn re-execution has no effect; lost optional publish does not pause media; unsupported Calendar action returns `unsupported` when known from selection; text-mode local result is `mode-not-allowed`. Keep `show_canvas` empty-inventory reopening/alias behavior unchanged.
- [ ] **Run focused assembled checks**:
  - `backend`: `npm test -- test/voice/integration/canvas-navigation.spec.ts test/runtime/canvas-navigation.spec.ts test/contracts/canvas-navigation.spec.ts test/contracts/canvas-navigation-wire.spec.ts test/model/calendar-adapter.spec.ts test/voice/transport/livekit-control.spec.ts`
  - `frontend`: `npm test -- src/features/voice/integration-tests/canvas-navigation.test.ts src/features/canvas/canvas-controls.test.ts src/api/livekit-voice-client.test.ts src/api/voice-protocol.test.ts src/api/testing/voice-fixtures.test.ts src/features/canvas/calendar-canvas.test.ts`
- [ ] **Run all required package checks**, separately, from the matching directories:

| Directory | Command | Required evidence |
| --- | --- | --- |
| `backend` | `npm run build` | Type/Nest build success. |
| `backend` | `npm run lint` | Type-aware lint success. |
| `backend` | `npm test` | Discovered/passed/failed/skipped counts; deterministic offline suites. |
| `backend` | `npm run test:e2e` | Actual admitted offline tests; report native-prerequisite skips separately. |
| `frontend` | `npm run build` | TypeScript/Vite build success. |
| `frontend` | `npm run lint` | Lint success. |
| `frontend` | `npm test` | Discovered/passed/failed/skipped counts; Node environment limitation. |

No native database checks are authorized. If the shell already has `AURVIN_TEST_MONGODB_URI` or `AURVIN_VOICE_NATIVE_AUTHORIZED=1`, remove those variables **only from the test child process environment** before starting package tests; never print them, edit `.env`, or use the operator's database. Do not run `test:azure`/`test:behavior` as empty-discovery evidence. Tests using in-process memory-store doubles are permitted, including the fixture's `MongoClient` type casts; they do not authorize a real connection.

- [ ] **Correct defects exposed by checks** using focused red tests and rerun affected/full checks. Update only hardcoded lists that legitimately gained the fourth native tool. Search `show_canvas` across backend/frontend tests for missed sibling recognition; do not blindly replace every occurrence. Preserve all Calendar permission, confirmation, and external-effect barriers. Unresolved test failures block completion.
- [ ] **Commit** instructions/integration/regression files with `test(canvas): verify instant voice controls and preserved behavior`.
- [ ] **Run final Git/document consistency checks**: `git diff --check`, `git status --short`, inspect `git show --stat --oneline HEAD` and the feature commit set. Do not amend the planner/orchestrator commits or stage unrelated files. Return a concise worker summary with each actual commit and command result.

## Final acceptance/evidence checklist for the worker summary

- [ ] AC1: Four total stable native tools, exactly one newly added name with seven strict variants; trusted voice-only execution including backend rejection in text and dictation-as-text.
- [ ] AC2: Zoom both directions/bounds/pan retention; measured off-center large fit distinct from reset; four directional diagram/native scroll cases and finite limits; close preserves tabs/archive; explicit maximize enter/exit; missing/closed/unsupported presentations safe.
- [ ] AC3: Real adapter → loop → trusted callback → scoped transport ordering shown while current persistence/accounting/TTS/finalization gates remain pending/failing, not merely after a previous turn failed to save. Frontend real client → controller → application callback and local math/DOM-seam doubles show direct synchronous application. No new pre-effect DB/read, schema discovery, acknowledgement, planning call, saved viewport preference, or extra network service.
- [ ] AC4: Stable identity dedupe for relative actions, distinct repeats permitted, target revision captured per dispatch and compared at receipt, all wrong/stale/cancelled/superseded/hidden scopes fenced, replay never reissues presentation.
- [ ] AC5: Manual controls, reopening, Calendar aliases/confirmation, original source-free tool pairing/accounting, and media behavior remain covered. Report any deliberate finite pan/fit limitations.
- [ ] AC6: Actual implementation commit set, Node/runtime environment, focused red/green evidence, all seven package check outcomes with discovered/skipped counts, and `git diff --check`. Review recorded **skipped**. No “complete” claim with unresolved defects.

**Mandatory limitation disclosure:** Node state/transport tests and DOM doubles are not an interactive browser test. Unless an already-authorized existing local browser harness becomes available, actual React ref mount/flush, real SVG bounds/fonts/strokes, CSS transitions, focus, pixel fit/pan, application maximize layout, and delivery-to-painted-screen timing remain **browser-unverified**. Local callback ordering/durations are not a speech-recognition/model/network SLA. Microphone, real LiveKit, live providers, native database, paid, deployment, and external-service checks were **not run / not authorized**. An admitted packet remains requested, never confirmed display.
