# Model selection and reasoning effort — approved design

## Authorization and scope

On 16 November 2026 the user requested an OpenRouter model dropdown, an explicit
Aurvin compatibility check, and a super-admin thinking-effort dropdown.

The user selected **Catalogue only**, approved the design below, and then directed:
“You just delegate one planner to plan the implementation and report me.”

This authorizes one planner and documentation only. Do not implement code, dispatch
workers or additional agents, run paid inference, inspect application data, restart
services, or deploy. Unified review remains **skipped** under repository policy.

## Objective

Let a super-admin select any catalogue-listed OpenRouter chat model that satisfies
Aurvin's verified requirements, and choose a supported reasoning effort, without a
curated model-name allowlist. Do not promise that every catalogue entry is usable.

## Approved behavior

### 1. Model selection

- Replace the free-text-only Model ID experience in Manage Aurvin → Config →
  OpenRouter with a searchable dropdown populated from the live OpenRouter chat
  model catalogue.
- Show human-readable names and exact model IDs. Preserve the currently configured
  ID even when it disappears from the catalogue; do not silently replace it.
- A selection is a draft, not activation. Incompatible candidates can be selected
  for an explanation but cannot bypass admission.
- Catalogue requests are server-mediated, bounded, and protected by the existing
  super-admin configuration access controls. Credentials remain server-side.

### 2. Thinking effort

- Add a deployment-wide, server-side reasoning-effort setting.
- Offer **Provider default**, plus effort values declared supported for the selected
  model. Do not assume every model supports Low/Medium/High.
- When reasoning metadata does not disclose effort selection, expose only Provider
  default with a useful explanation. Handle documented `supported_efforts: null`
  semantics separately from an absent field; respect mandatory reasoning and
  never offer disabling it when forbidden.
- Changing the model resets the draft effort to Provider default.
- Existing stored configurations retain their current behavior through a safe
  Provider default compatibility/migration path.
- Explain that reasoning consumes the finite output budget and may reduce visible
  output. No token-budget slider is requested.

### 3. Explicit catalogue-only compatibility check

- **Check compatibility** checks the draft model, effort, and relevant chat budgets
  using live, non-inference OpenRouter metadata and Aurvin's fixed-asset/context
  requirements.
- Return **Catalogue compatible**, **Incompatible**, or **Unable to verify**, with
  specific, safe reasons rather than only CONFIG_ACTIVATION_UNAVAILABLE.
- Check catalogue membership, chat/text applicability, verified context and
  completion capacity, required output-cap parameter support, and the chosen effort.
- Evaluate available routing/parameter evidence without claiming that public
  catalogue metadata proves account-specific eligibility under privacy policies.
- Report Calendar and web-tool capability separately. A missing optional tool
  capability or usable Calendar price can disable that feature without rejecting
  otherwise compatible text chat.
- Do not make inference calls, execute tools, access real Calendar data, save the
  draft, or activate a configuration during this check.
- Explicitly label actual SSE streaming, provider-route availability, and reasoning
  continuity through tool rounds as **untested**.
- Missing or ambiguous required evidence is not invented or overridden.

### 4. Save and runtime behavior

- Editing the model, effort, relevant budgets, or saved credentials invalidates
  the displayed compatibility result. Ignore stale/out-of-order check responses.
- The UI requires a matching successful check for a changed model configuration;
  the server independently revalidates the relevant requirements before saving.
  A client-side success flag is never authority.
- Reuse one shared compatibility evaluator for check and save admission, avoiding
  divergent policy. Failed checks or saves leave the active configuration intact.
- Keep existing revision/CAS, secret handling, origin/transport protections,
  validation budgets, and activation guarantees.
- Propagate model and effort consistently to new deployment-wide text and live
  voice model attempts, including retries and tool rounds. Never switch settings
  silently inside an admitted attempt.
- Provider default must preserve existing request behavior. Do not store or expose
  private model reasoning. Reasoning blocks that a provider requires to be replayed
  are a real limitation, not something catalogue-only checks can certify.

## Non-goals

- No per-user, per-chat, or browser-authoritative model/effort override.
- No alternate model-provider endpoint or curated model-name list.
- No relaxation of `dataCollection: 'deny'`, disabled transforms, finite budgets,
  privacy, authentication, durable mutation barriers, or tool safety.
- No automatic budget increases, paid smoke-test button, model benchmark, or
  collection of private reasoning.
- No change to Deepgram speech-model selection.
- No implementation in this planning-only authorization.

## Acceptance criteria for the implementation plan

1. Specify exact contract, persistence/backward-compatibility, catalogue, backend
   route, request-serialization, UI-state, and integration-test changes.
2. Trace every model request path and call site affected by the saved effort,
   including text, live voice, retries, and tool continuations.
3. Define a bounded server-side catalogue response and structured compatibility
   result, protecting secrets and preserving existing authorization.
4. Specify deterministic tests proving non-inference checking, precise blockers,
   model-specific effort options, draft/result invalidation, stale-response
   isolation, save revalidation/CAS, default compatibility, consistent provider
   payloads, and independent optional-tool availability.
5. Include accessibility/loading/error behavior using existing frontend patterns
   without adding dependencies unless demonstrably necessary.
6. Include backend/frontend build, lint and test commands, applicable integration
   checks, and honest native/live prerequisites and limitations.
7. Record review as skipped; do not mislabel catalogue or fixture evidence as
   runtime, topology, staging, or production certification.

## Planning evidence

The initial checkout was clean at `c50017b` on `main`. Initial context inspection
covered the admin settings wire/runtime contracts, config service and controller,
snapshot preparation, catalogue verification, shared OpenRouter provider-parameter
serialization, text/native/tool transports, and admin form/edit-state components.

Current OpenRouter documentation was queried through Context7. A public, unauthenticated
GET to `https://openrouter.ai/api/v1/models` returned 200 with 468 entries; 346
contained reasoning metadata, including model-specific effort arrays. This is a
point-in-time observation, not an admission allowlist or paid inference evidence.

Primary documentation:

- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
- https://openrouter.ai/docs/guides/overview/models
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model
