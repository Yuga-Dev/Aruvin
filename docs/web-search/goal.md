# Web Search — Goal and Acceptance Specification

## Outcome

Add an opt-in Web Search plugin so Aurvin can search the public web and read user-supplied URLs to ground text and voice answers. Users connect their own providers. Keep the implementation small, efficient, and consistent with existing Plugins, credential, configuration, tool-loop, and chat patterns.

This extends the old Phase 1 no-tools boundary for this feature only. It does not authorize unrelated tools, public deployment, paid service checks, infrastructure provisioning, or changes to the unfinished Calendar work.

## Confirmed decisions

1. One **Web Search** section on the existing Plugins page; no composer-level toggle.
2. One account-wide plugin toggle, applying to that user's conversations in text and voice. It is not an administrator switch affecting every user.
3. Default off. Connecting a provider does not turn the plugin on automatically. At least one connected provider is required to enable and use it.
4. Five providers, with fixed priority: **TinyFish → Keenable → Exa → Tavily → Firecrawl**. No provider picker, editable priority list, parallel provider fan-out, or quota-balancing engine.
5. Full MCP transport for provider search and page reading. Aurvin exposes only one model-facing tool: **`web_tool`**.
6. `mode: "browse"` means search and requires `query`. `mode: "fetch"` means read a page and requires `url`. Reject invalid mode/argument combinations at the tool boundary.
7. Retrieval is used **as needed**, rather than on every enabled turn. An explicit request to search or read a supplied URL should trigger an attempt; a URL appearing incidentally is not a reason to retrieve it automatically.
8. When disabled, omit `web_tool` from model requests and make no external web calls. Accept possible prompt-cache misses when toggling; while enabled, keep the tool schema and ordering stable across providers and fallback.
9. Put two independently configurable limits on the existing Config page: **maximum searches per turn = 5** and **maximum fetches per turn = 5** by default. Do not add unrelated per-provider tuning controls.
10. Automatically fall back through eligible connected providers in the fixed order, with bounded attempts and timeouts.
11. Preserve memory-first chat behavior and immediate follow-ups. No database or provider preparation work may gate model dispatch.
12. Unified review is **skipped**. Planning, implementation, defect correction, and final verification are not skipped.
13. Invalid model-generated `web_tool` arguments get a bounded schema-repair loop: at most **three additional model attempts per accepted turn**, revealing the expected schema again on each retry.

## User experience and connections

### Plugins page

- Add Web Search alongside existing plugins; reuse existing navigation and responsive layout.
- Show the global toggle and five provider cards in priority order.
- Each card shows a short provider-specific sequence for obtaining a key, followed by a button that opens the provider's official console in a new tab.
- Provide a dedicated masked API-key input and Connect action, with useful pending, connected, invalid-key, unavailable, and reconnect-required states.
- Once connected, provide replacement and disconnection actions using existing credential UX conventions. Never return saved raw keys to the browser.
- Offer **Connect account** wherever supported browser authorization can be integrated. Keep manual API-key connection available.
- A browser authorization button starts the real authorization flow; it is not a static signup link presented as a completed connection.
- Provider Google sign-in can occur on the provider's page. Do not claim Aurvin directly obtains API access just because someone signed into Google, or promise literally one-click onboarding when signup, consent, a device code, or team selection is required.
- Key validation and MCP preparation belong to setup, outside the chat path. A successful connection must establish the required capabilities, not merely recognize a key-shaped string.
- If the last connection is removed, effective web access becomes off and the UI explains why. Reconnection does not silently re-enable it.
- Preserve saved enablement through reload/restart, subject to a valid saved connection. A transient provider outage is degradation, not deletion of the preference or a reason to restart Aurvin.

### Concise key instructions

Instructions must be verified against official documentation during research and kept specific without inventing dashboard button names.

| Provider | Intended concise instructions | Official destination |
| --- | --- | --- |
| TinyFish | Sign in or create an account; choose Create API Key; copy immediately because the key is shown only once; paste into Aurvin. | https://agent.tinyfish.ai/api-keys |
| Keenable | Sign in or create an account; create a key in the console; copy before closing the dialog; paste into Aurvin. | https://app.keenable.ai/ |
| Exa | Sign in or create an account; create a key on the API Keys page; copy and paste into Aurvin. | https://dashboard.exa.ai/api-keys |
| Tavily | Sign in or create an account; copy a key from the dashboard; paste into Aurvin. | https://app.tavily.com/home |
| Firecrawl | Sign in or create an account; open API Keys; copy the available default key; paste into Aurvin. | https://www.firecrawl.dev/app/api-keys |

Do not hardcode claims of unlimited or permanently free use. Link to provider pricing; any displayed allowance is informational and dated, not an Aurvin guarantee.

## Architecture and scope

### Minimum architecture

- Reuse existing per-user identity, encrypted credential storage, settings activation, plugin routing, model tool execution, cancellation, streaming, and voice integration where appropriate.
- Keep provider MCP specifics behind the existing backend boundaries. A small fixed provider mapping translates Aurvin's browse/fetch operations to the corresponding MCP tools.
- Do not expose the provider's entire advertised tool catalog to the model. Allowlist only search and page reading for the five fixed providers.
- Do not add a general MCP marketplace, user-supplied MCP servers, generic plugin framework, new browser runtime, or speculative repository-wide tool refactor.
- Prefer an installed MCP dependency. If none can safely provide the required transport and OAuth, research must justify the minimum additional dependency; do not hand-roll a general protocol stack to avoid one package.
- Native REST calls are not a silent fallback for missing MCP capabilities. Report a provider incompatibility and reconcile it before claiming that provider is implemented.

### Authorization compatibility evidence

Brainstorming found documented OAuth paths for TinyFish, Exa, and Tavily hosted MCP; Keenable device authorization and an OAuth MCP route; and Firecrawl OAuth with REST/MCP options.

These are research leads, not completed compatibility tests. Research must verify exact MCP endpoints, transports, auth/token audience, client registration, API-key handling, search and fetch tools, account billing attribution, and local callback support for all five providers.

Choose the simplest documented usable authorization flow per provider. OAuth tokens intended only for REST must not be assumed usable against MCP. If a provider cannot support the approved scope, surface the concrete limitation instead of silently removing it or claiming success.

## Memory-first, latency-sensitive execution

- For both text and voice, zero database reads or writes before the initial model dispatch. Admission, identity, plugin enablement, credentials, tool schemas, limits, selected history, and follow-up state come from server memory.
- Subsequent model dispatches in the same web-tool loop must not wait on persistence either.
- Load durable connection/settings state outside admitted turns. Prepare discovery, capabilities, connections, and token renewal during setup/startup or in bounded background lifecycle work.
- Do not perform database lookups, live connection probes, MCP initialization/discovery, or OAuth refresh before the first model dispatch of a turn.
- If a web request later needs reconnect/refresh, perform it only on the bounded tool path after model dispatch, or skip the unavailable provider. Never make provider preparation a normal-chat prerequisite.
- Apply successful settings/connection changes to the in-memory account state so the next turn sees them without a database read.
- Accept turns, stream responses, and admit immediate follow-ups independently of database-save completion. Persist bounded turn/tool/citation/accounting evidence through the existing consolidated asynchronous post-response path.
- Search and fetch are read-only; do not copy Calendar mutation barriers or add pre-effect database writes to web calls.
- Preserve essential in-memory admission, account binding, consent, expiry, capability, cancellation, deadline, and budget checks; fail closed rather than bypass them for latency. Shared-runtime changes must retain Calendar's required mutation barriers, prepared authority, and held-archive continuation behavior.
- Keep network calls out of readiness checks and ordinary turns where the plugin is off or not used. Web outages must not take text or voice chat down.
- Validate untrusted input once at the appropriate boundary. Bound responses once before adding them to context; avoid repeated validation or full-history scanning in streaming/token callbacks.
- Do not add a generic cache, new task queue, speculative warmup service, or paid health probes. Use existing memory snapshots and connection lifecycle facilities first.

“Zero pre-model latency” means no blocking database/provider preparation on the dispatch path, not literally zero CPU time. Grounded answers still incur model and retrieval network latency.

## Tool behavior, limits, and fallback

- Exactly one model-facing tool, with two modes and mode-specific arguments. Keep provider names, credentials, and endpoint selection out of model arguments.
- If the model emits malformed JSON or schema-invalid arguments for `web_tool`, return concise validation feedback and the same canonical tool schema to the model, then allow a corrected call. The original attempt plus at most three additional schema-repair model attempts are allowed; the three-retry budget is shared across the whole accepted turn, not reset per provider, mode, or tool-loop iteration.
- Put repair feedback/schema in the current tool-result/continuation context without changing the canonical tool definition or stable prompt prefix. Preserve valid tool-call/result grouping and repair only invalid calls; do not replay successful calls.
- Invalid arguments cause no provider request and consume no browse/fetch logical-call budget. Repair attempts consume the finite model/token/deadline budget and their separate three-retry allowance. Never bypass an exhausted budget to obtain three retries.
- Permission denial, URL-safety rejection, exhausted limits, cancellation, and provider failures are not schema errors. They do not trigger the schema-repair loop. After repair exhaustion, return a useful failure without further model repair or provider dispatch for the invalid call.
- A browse call returns bounded titles, public URLs, useful snippets/content, and available source metadata.
- A fetch call returns bounded readable page content with its source URL and available metadata. No recursive site crawl or interactive navigation.
- Five browse calls and five fetch calls are separate default **logical-call budgets per accepted turn**, shared across its full model/tool loop and text/voice handling.
- A fallback attempt does not grant another logical call or reset either budget. Bound provider attempts separately: at most one attempt per provider per logical call, across the five-provider list.
- Use finite per-provider timeouts, a shared per-turn web deadline, and finite result/content/token bounds. Research/planning must select concrete values and test them before implementation is considered complete.
- Eligible means connected, authorized, enabled for this account, capable of the requested mode, and not already known unavailable under the existing bounded connection state.
- Start with the highest-priority eligible provider for each operation; reuse existing connections.
- Fall back on provider-specific authorization, quota, rate-limit, transport, timeout, service, or unusable-result failures within the shared limits. Do not try another provider for invalid/unsafe input, disabled permission, exhausted turn budget/deadline, or cancellation.
- Do not automatically buy credits, enable auto top-up, switch to anonymous/keyless usage, or send requests to providers the user did not connect.
- If all eligible providers fail, return a useful tool failure. Aurvin must say live verification failed; it must not manufacture sources or imply an ungrounded answer was verified.
- Show concise search/page-reading activity and the successful source links. Fall-back provider identity should be inspectable without exposing credentials or backend internals.
- Retries are explicit after a terminal failure. Do not replay completed model calls or tool calls automatically during crash recovery. Report interruption honestly when no sealed result is available.

## Safety, privacy, and cancellation

- Credentials and tokens stay encrypted server-side, scoped to the authenticated account, and never enter prompts, transcripts, URLs, logs, or frontend environment settings.
- Reuse secure OAuth state/PKCE, expiry, callback binding, and token-rotation patterns where applicable. Keep these checks on the control-plane connection path, not per token.
- Public HTTP(S) URLs only: no credential-bearing URLs, localhost/private/internal targets, arbitrary endpoint overrides, authenticated page sessions, or paywall/access-control bypass.
- Enforce the public-web restriction for model-supplied and user-supplied URLs. Research must establish the provider's redirect/private-network protections; do not claim a protection that only checks the initial URL.
- Aurvin itself contacts only the five fixed provider services, not arbitrary page URLs. Do not introduce a local unrestricted URL-fetch fallback or an SSRF proxy.
- Retrieved text is untrusted evidence, never new system instructions or authority to execute other tools.
- Send only the necessary query or requested URL/content to the chosen provider. Do not forward whole chat history, private Calendar data, or secrets as search context.
- Explain in plugin setup that queries and URLs are sent to connected third parties and may consume their credits. Fallback can disclose the same query/URL to another connected provider.
- Recheck in-memory permission before each external call. Disabling/disconnecting blocks new calls, including an active turn's follow-up calls, and best-effort aborts affected in-flight work.
- Cancellation, disconnect, voice interruption, and shutdown stop new tool calls and discard late results using the existing signal/lifecycle mechanism.
- Already-dispatched requests cannot be retracted; do not promise charge prevention or exactly-once provider billing.
- Durable UI history and complete tool call/result linkage remain intact. Do not store private model reasoning or unbounded raw pages.

## Verification and acceptance

| ID | Required evidence |
| --- | --- |
| AC1 | Existing Plugins page lists all five providers in priority order, with verified concise setup instructions, destination buttons, key connection, and supported browser authorization. |
| AC2 | Account-wide toggle defaults off, requires a connection, affects text and voice, survives reload appropriately, and has no composer control. |
| AC3 | Model requests contain only one added `web_tool` while enabled, with browse/fetch argument checks; it is absent while disabled. Invalid arguments receive the canonical schema again for at most three additional model repair attempts per turn, without provider dispatch or successful-call replay. Backend still blocks stale/unauthorized calls. |
| AC4 | MCP calls use only approved search/fetch capabilities, the connected account's credentials, fixed endpoints, and deterministic ordered fallback. |
| AC5 | Config page exposes default 5-search and 5-fetch limits; budgets persist across the whole turn loop and cannot be multiplied by fallback. |
| AC6 | Runnable instrumented text and voice fixtures assert zero database operations and zero discovery/connect/refresh probes before initial model dispatch; tool-loop model dispatch and immediate next turns do not wait for saves. |
| AC7 | Web-off and web-unused turns make zero external web requests. Outages, stale tokens, and slow persistence do not block ordinary chat or introduce readiness probes. |
| AC8 | Sources are clickable and traceable to results; page limits, unusable results, exhausted providers, partial retrieval, and budget/time limits produce honest outcomes without invented verification. |
| AC9 | Account isolation, encrypted/write-only credentials, OAuth denial/expiry/callback binding, URL safety, prompt injection, cancellation, voice interruption, disconnect/disable races, and late responses have focused deterministic checks. |
| AC10 | Existing Calendar, text, voice, and configuration behavior remains covered by relevant regression suites. Any pre-existing failure is separated from new failures with evidence. |
| AC11 | Final verification records actual commits, environment, executed/skipped checks, latency observations, provider compatibility limitations, and review as skipped. No fixture result is presented as live service certification. |

Use established Vitest fixtures rather than a new test framework. Unit/integration checks are deterministic and make no paid provider/model requests. Native database integration requires the repository's operator-supplied isolated test settings. Live provider/OAuth/staging checks require separate explicit authorization and bounded data/cost; without it, report them unrun.

Run backend build, lint, unit tests, and e2e; frontend build, lint, and tests; add focused integration/browser-fixture coverage using existing tooling where available. Empty discovery and skipped prerequisite suites are not passing evidence.

## Out of scope

- Composer toggle, model picker, provider picker, editable priority, provider fan-out, automatic quota purchasing, and anonymous usage.
- General MCP server management or arbitrary tool execution.
- Recursive crawling, browser interactions, private site access, authenticated browsing, and background research jobs.
- Embeddings, cross-session retrieval, summaries, compaction, or new permanent page archives.
- Broad refactors, new infrastructure, public rollout, live paid checks without approval, and changes to unrelated Calendar work.
- Unified review, per the user's `--skip review` instruction.

## Workflow and approval

Use MAW with small dependency-driven plan units, explicit file ownership, separate planner/worker prerequisites, serialized shared commits, and final verification. The orchestrator manages documentation and dispatch; assigned agents perform research/planning/implementation.

User conversation approved the feature direction and requested proceeding on 2026-11-14. Approval of this written goal remains a separate required gate, recorded in `state.md`; no implementation or research dispatch is implied merely by this file's existence.
