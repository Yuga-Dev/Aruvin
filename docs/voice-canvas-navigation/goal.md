# Goal: Always-available Canvas navigation

## Status and source

- Date: 12 November 2026.
- Workflow: MAW-lite; one implementation planner followed by one worker and final verification.
- Source: user discussion in this session. The user approved a stable `show_canvas` tool, voice-only execution, and explicitly said it must always be available rather than discovered through `activate_skill`.
- Conversational design and this written specification were explicitly approved on 12 November 2026 through the workflow approval form ("Approve and continue"). Planning and execution may proceed subject to the state gates and preservation of existing user work.
- This is a new objective, not a resumption of the historical Phase 1 or other Canvas workflows. Existing source, not historical completion claims, determines implementation work.
- Unified code review remains **skipped**, not passed, under repository instructions. Meaningful tests, compatibility checks, defect correction, and final verification remain required.

## User outcome

During an active live voice call, the user can ask Aurvin to show a particular existing Canvas. Aurvin can focus an open tab or reopen a hidden tab without ending the call, opening the transcript, or requiring mouse/keyboard navigation.

Closing a Canvas tab hides its presentation; it does not delete the underlying artifact. This feature navigates existing artifacts rather than generating replacements.

## Agreed design

### One directly advertised native tool

The model-facing interface is:

```typescript
show_canvas({ canvas_id: string })
```

Advertise its complete description and strict argument schema directly alongside the existing native tools in both text and live voice model requests. No `activate_skill` step, plugin schema disclosure, or `call_tool` wrapper is required. Its availability must not depend on Google Calendar being connected, on earlier skill activation, or on there already being an open Canvas.

Keep the definition, description, and position deterministic across text/voice transitions and follow-up decisions. Do not insert/remove or mutate it based on mode, canvas count, selected tab, or hidden state. Existing model capability and application readiness requirements still apply; this does not enable tools on an unsupported provider/model.

The static instructions explain the mode policy. The backend-selected response mode and changing Canvas inventory belong in per-turn context after reusable static context, not in the tool description or shared static instructions. Preserve existing context ordering where possible. Stable definitions prevent this feature from introducing tool-schema churn; they do not guarantee provider cache hits or cache sharing between different models.

### Voice-only execution, enforced by the application

Use the trusted server-side mode and active call binding to authorize execution. Do not trust a mode, user ID, conversation ID, or voice-session ID supplied as tool arguments.

- Active live voice: validate that the requested Canvas belongs to the current authorized conversation and is available in the current call's Canvas surface.
- Text mode, including dictation submitted as text: return a bounded, structured mode-not-allowed result with no UI side effect. Keep the tool advertised.
- An ended, stale, or mismatched call must not receive a navigation effect.

Prompt instructions also prohibit using Canvas navigation tools in text mode, but prompt compliance is not the execution boundary. Preserve ordinary manual Canvas controls and visual generation in text mode.

### Compact, bounded inventory

Give Aurvin stable Canvas IDs and meaningful titles for existing artifacts available to the active call, including tabs the user closed. Include artifacts from the current conversation that the existing voice Canvas surface can actually restore; do not search other conversations or users. Reuse existing artifact identity and calendar workspace/alias handling rather than inventing a second registry or positional tab IDs.

The inventory is metadata for navigation, not another copy of visual source or transcript content. It must be bounded and refreshed when relevant artifacts change, including visuals created earlier in the same call. Titles and other artifact metadata are untrusted data, not instructions. No extra model call or Calendar/provider request is needed to build the inventory. The planner must select concrete size/count limits and explicit overflow behavior consistent with existing budgets; overflow must not silently imply that an inventory is exhaustive.

Aurvin resolves a spoken description such as “open the pricing comparison” using that inventory, then supplies the exact ID. If more than one candidate is plausible, ask a short clarification rather than arbitrarily choosing. Never invent an ID or regenerate an artifact merely to reopen it. An unknown or unavailable ID returns a safe failure without navigating to another Canvas.

### Idempotent presentation action

For a valid target, use the existing Canvas state/action path to:

1. Open the Canvas panel if hidden.
2. Restore the target tab if closed.
3. Make the requested existing artifact the active tab.

Repeating the same request must not duplicate tabs or artifacts. Reopening an older Canvas must not be blocked merely because its original generation response is no longer the active response; navigation is distinct from accepting a newly generated artifact. Preserve existing Calendar workspace identity and aliases so navigation does not recreate or mutate Calendar results.

Scope navigation effects to the correct active call/conversation and existing transport epoch rules. Delayed, duplicate, cancelled, or stale effects must not switch a different conversation or superseded call. Reuse the existing voice control channel and state machinery; do not add another connection, navigation service, or general UI-command framework.

### Honest results and minimal latency

Return bounded structured outcomes for valid navigation requests, invalid arguments/IDs, unavailable targets, mode rejection, and unavailable/stale call delivery. Preserve native tool call/result pairing, normal budgets, cancellation, and accounting.

Follow the current memory-first repository invariant: do not perform database reads or writes before model dispatch to assemble or authorize this Canvas inventory, and do not add a persistence barrier for navigation. Use the existing in-memory conversation/call context. Do not gate inference, streaming, or next-turn eligibility on persistence; preserve consolidated asynchronous post-response persistence. Canvas navigation is a local UI effect, not an external mutation requiring a durable pre-effect barrier.

Distinguish requesting/delivering a UI action from proof that the browser displayed it. Do not claim confirmed display without corresponding evidence. Do not add a blocking browser acknowledgement round trip solely to make this navigation work. Presentation errors must not hang up, pause, or restart voice media.

Update the voice instructions so an authorized navigation request is allowed and reopening an existing Canvas is an exception to the current rule requiring a newly generated fenced visual whenever speech refers to Canvas. A navigation-only request must not generate a replacement visual. Preserve the existing Calendar receipt/confirmation rules; showing a calendar is not a Calendar write or approval.

## Alternatives considered

1. **Stable direct native tool, runtime voice restriction — selected.** Fits the approved experience while avoiding mode-dependent tool-definition churn.
2. **Add/remove the tool when mode changes — rejected.** Unnecessary schema/prefix changes and contrary to the user's always-available requirement.
3. **Discover navigation through `activate_skill`/`call_tool` — rejected.** Adds discovery overhead for one small built-in UI action and explicitly contradicts the user's direction.

## Scope boundaries

Included: one navigation tool; trusted mode/call authorization; compact Canvas inventory; native tool parsing/validation/dispatch and context integration; scoped voice delivery; reuse of frontend reopen/focus behavior; prompt adjustments; deterministic tests and final evidence.

Excluded: other future Canvas tools, close/delete/edit/rename tools, cross-conversation navigation, a UI model picker, new visual generation/renderers, generic plugin redesign, new caching infrastructure, guaranteed provider cache savings, unrelated refactors, external provisioning/deployment, and live paid model/STT/TTS calls.

No new dependency is expected. Use existing helpers, limits, contracts, fixtures, and Vitest infrastructure. Keep the implementation within one focused plan and one worker.

## Acceptance criteria

- **AC1 — Always advertised:** Fixture requests for text and live voice advertise identical `show_canvas` definitions in deterministic order without activation or loaded schemas. It remains advertised with no canvases and without Calendar connectivity. Existing native tools still function.
- **AC2 — Voice gate:** A valid active voice request can navigate. Text/dictation requests are rejected by the application and cause no presentation side effects; untrusted arguments cannot override mode or identity.
- **AC3 — Closed-tab scenario:** With at least four artifacts in a live call and two closed tabs, requesting either closed artifact reopens and focuses the correct existing artifact without ending the call. A hidden panel opens; an already active target remains idempotent.
- **AC4 — Useful inventory:** Bounded metadata includes closed but restorable targets and same-call additions; IDs/titles align with frontend artifact and Calendar workspace identity. Bounds/overflow are explicit, contents are not duplicated, and other conversations/users are excluded.
- **AC5 — Invalid/ambiguous targets:** Invalid IDs/arguments and unavailable targets produce bounded failures without changing selection; deterministic context/policy checks cover clarification rather than arbitrary choice for duplicate titles. Do not claim deterministic tests prove live model language compliance.
- **AC6 — Lifecycle isolation:** Duplicates do not create extra tabs. Stale/mismatched call, conversation, epoch, or cancelled navigation delivery cannot switch the wrong surface. Previously generated artifacts remain valid navigation targets.
- **AC7 — Prompt and cache contract:** Shared policy permits authorized voice navigation and forbids text-mode use. Navigation does not require generating a new visual. Request fixtures prove stable tool definitions/static prefixes where applicable; no unmeasured cache hit/cost claim is made.
- **AC8 — Regression and latency:** Existing manual controls, visual generation, Calendar skill activation/results/confirmation, and voice media behavior are preserved. Navigation requires no schema activation, external data lookup, extra planning model request, browser-ack wait, database read/write before model dispatch, or persistence barrier. It does not gate inference, streaming, or next-turn eligibility on persistence. Focused tests and relevant full checks pass, or failures/skips are explicitly classified and unresolved defects block completion.

## Verification and authorization

Use deterministic model/provider and voice transport fixtures for routine testing. Both packages require build, lint, and test checks; backend e2e checks are included where applicable. Record the actual commit set, dirty-baseline caveats, commands, counts, skips, and limitations in `final_report.md`.

Real browser/microphone/live provider checks and isolated database tests require separate explicit authorization and prerequisite handling; never treat an unrun check as passed. If browser presentation or live spoken-reference behavior is not exercised, report that limitation separately from deterministic state/transport evidence.

## Approval gate

The user approved this written goal and authorized continuation on 12 November 2026. The foreground planner commits one implementation plan; the worker executes it with TDD and atomic commits after the ownership/overlap gate; the orchestrator verifies and records the outcome. Creation of these documents alone did not authorize implementation; the explicit approval did.
