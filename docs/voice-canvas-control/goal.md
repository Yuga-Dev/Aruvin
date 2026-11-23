# Goal: Instant voice Canvas controls

## Status and authorization

- Date: 12 November 2026. Workflow: MAW-lite, one planner and one worker.
- Source: user brainstorming in this session; the user selected `control_canvas`, the seven actions below, and immediate application with any existing persistence afterward.
- Written specification status: **approved** on 12 November 2026. After clarification of the synchronous safety checks, the user explicitly said "sure I approve". Planning, implementation, and verification may proceed within this scope.
- This is a focused new objective extending the existing Canvas tools, not a resumption of historical Phase 1 work. Unified review is **skipped**, not passed; tests, defect correction, and final verification remain mandatory.

## Outcome and scope

During an active voice call, Aurvin can adjust how the user views the currently selected Canvas or close its side panel. These are presentation effects only: they do not edit, regenerate, delete, or duplicate artifacts. Existing `show_canvas` continues to select/open an existing Canvas. Ordinary manual controls remain available.

Add exactly one model-facing tool, `control_canvas`, with an `action` discriminator and action-specific arguments. Follow the existing stable native-tool advertisement pattern used by `show_canvas`; no skill activation or wrapper is needed. Voice-only execution is enforced by trusted runtime mode/call state, not model compliance or caller-supplied identity. Text/dictation execution has no effect.

## Seven actions

| Action | Behavior |
| --- | --- |
| `zoom_in` | Increase zoom one existing bounded UI step, preserving current position. |
| `zoom_out` | Decrease zoom one existing bounded UI step, preserving current position. |
| `fit_to_view` | Measure the current rendered diagram locally, fit the whole diagram within the visible stage, and center it. Honor finite zoom bounds. |
| `scroll` | Move the visible view up, down, left, or right by a bounded viewport-relative step. Use pan for transformed diagrams and native scrolling for ordinary scrollable Canvas bodies. |
| `close` | Hide the Canvas side panel; preserve artifacts and tabs so existing navigation can reopen them. |
| `reset_view` | Restore default 100% zoom and neutral pan/scroll position; distinct from fitting a large diagram. |
| `fullscreen` | Explicitly enter or exit the existing expanded/maximized Canvas presentation, rather than toggling on repeat delivery. This means application panel expansion, not browser fullscreen permission requests. |

Target the selected Canvas in the active voice surface, not an arbitrary client-supplied conversation. A delayed action must not affect a different selection or superseded call. No automatic reopening or selecting an unrelated artifact if the target is absent. Closing an already closed panel and explicitly setting the existing expansion state are harmless no-ops.

The planner must freeze strict, bounded action arguments, directional scroll semantics, zoom/scroll limits, and unavailable/unsupported outcomes using existing helpers where possible. Do not introduce optional tuning parameters unless the action needs them. Calendar bodies currently do not expose diagram zoom; unsupported actions must leave them unchanged rather than adding a new Calendar renderer.

## Immediate execution: explicit user requirement

**Perform the action immediately and handle any existing persistence afterward.**

- No asynchronous prevalidation, confirmation prompt, schema discovery, external lookup, database read/write, durable barrier, extra model/planning call, or browser acknowledgement wait before applying a valid control.
- Reuse in-memory trusted call/conversation state and the existing voice control transport. Once a complete valid tool call is available, dispatch its UI control without waiting for spoken narration, TTS completion, turn finalization, or history/accounting persistence.
- On receipt of a valid current control, update the browser presentation directly; do not queue it behind persistence or unrelated voice work.
- Essential synchronous boundary checks remain: finite/strict arguments, supported action, trusted voice mode, current call/conversation/target binding, stale/cancelled controls, and duplicate delivery. These are not a separate prevalidation workflow and must not perform I/O.
- Existing tool history/accounting persistence runs afterward and must not gate the UI, inference, streaming, or next-turn eligibility. Do not add saved viewport preferences, storage collections, or persistence solely for these controls.
- Relative controls such as zoom and scroll must be applied once per control identity, not twice after retransmission. Distinct intentional repeated requests still apply.
- “Instantaneous” describes the action path after tool-call availability, not a guarantee of zero speech recognition, model generation, network, or rendering latency. Record local delivery-to-application evidence; do not invent an end-to-end millisecond SLA.

## Integration and failure behavior

Reuse the existing native catalogue/dispatch, scoped voice control channel, lifecycle guards, Canvas state, zoom/pan/maximize helpers, and bounded tool-result patterns. Do not build a generic UI-command framework, a second socket, a second registry, or a second runtime. Prefer no new dependencies and no unrelated refactoring.

Bounded results distinguish invalid arguments, disallowed mode, unavailable target/delivery, unsupported presentation action, and a dispatched request. A requested/delivered action is not proof that the browser rendered it; do not claim confirmation without evidence. Failure must not terminate, pause, or restart voice media or silently regenerate content. Preserve existing Calendar confirmation policy: this tool cannot approve or mutate Calendar data.

## Alternatives and decisions

1. **One discriminated presentation tool using existing Canvas controls — selected.** Keeps model choice small and reuses manual behavior.
2. **Seven separate tools — rejected.** Contrary to the agreed single-tool interface.
3. **Persist/validate remotely before applying — rejected.** Violates immediate execution; these are local view effects, not external mutations.

Excluded: element-specific focus, exact zoom setting, panel resizing, edge-jump actions, new editing tools, automatic saved view preferences, cross-conversation control, browser fullscreen APIs, external provisioning/deployment, and paid/live service checks.

## Acceptance and verification

- **AC1 — Tool contract:** Exactly one new stable native `control_canvas` definition with seven actions and strict action-specific arguments; existing `show_canvas` and other tools work unchanged. Voice execution succeeds; text/dictation cannot cause effects.
- **AC2 — Seven behaviors:** Deterministic tests cover both zoom directions and bounds, measured fit versus reset, four scroll directions, panel close without deletion, and explicit expansion enter/exit. Unsupported views and absent targets fail safely.
- **AC3 — Fast path:** With existing persistence deliberately pending or failing, a valid control is dispatched and applied before persistence settles and before response/TTS finalization. No control-triggered database or external lookup, blocking acknowledgement, or additional model request. Test the actual runtime ordering, not just a helper.
- **AC4 — Isolation and repetition:** Duplicate relative effects apply once; distinct repeated requests apply normally. Stale/cancelled/wrong-call/wrong-conversation/wrong-target controls cannot affect another surface. Essential synchronous checks remain tested.
- **AC5 — Regression:** Manual Canvas controls, artifact identity/reopening, Calendar behavior, native tool history/accounting, and voice media remain intact. No new viewport persistence requirement is introduced.
- **AC6 — Evidence:** Focused deterministic backend/frontend tests plus package build/lint/test checks and applicable backend e2e checks are recorded against the actual commit set. Record skips, failures, and browser/live limitations separately; unresolved defects block completion.

Use existing Vitest/fixture conventions. Frontend routine tests run in Node, not a browser DOM; state/transport tests alone are not browser presentation proof. Use an available local browser harness only if already permitted; otherwise explicitly report browser behavior unverified. No microphone, paid provider, external service, database fixture, or deployment work is authorized by this specification. Any such check needs its separate prerequisites and authorization.

## Approval gate

The user explicitly approved this written goal after clarification of the synchronous safety checks. Dispatch the foreground planner, then one TDD worker and final verification under MAW-lite. This does not authorize external services, paid checks, or deployment.
