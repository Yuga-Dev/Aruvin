# Model selection and reasoning effort — technical research

Date: 16 November 2026. Planning only. Source checkout: `main`, approved
goal/state commit `aeea3f4`, application baseline `c50017b`.

## Conclusion

Extend the existing strict admin configuration, catalogue preflight, immutable
snapshot, and `providerParameters` flow. No new dependency, model-name allowlist,
inference probe, alternate runtime, reasoning archive, or speech-model change is
needed. One sequential implementation plan is sufficient.

The current `max_tokens`-only gate unnecessarily excludes models that declare
`max_completion_tokens`: OpenRouter documents equivalent Chat Completions cap
semantics. Supporting that alternative requires carrying the verified parameter
into **all three** shared serializer callers, not merely weakening admission.
Missing finite cap evidence must still fail closed.

Catalogue-compatible means **declared static text-chat requirements satisfied**.
It does not certify an account-specific privacy-compatible provider route,
working SSE, tool schemas/behavior, reasoning replay, wall-clock latency, or a
hard provider billing guarantee.

## Authorization and evidence hygiene

- Read root `AGENTS.md`, approved [goal](goal.md), and [state](state.md).
- No application data, `.env`, stored credentials, live model/tool calls, service
  restart, provisioning, deployment, source edits, or application suites.
- Public documentation and unauthenticated Models API GETs only. Catalogue
  observations below are not fixtures, acceptance evidence, or allowlists.
- Unified review: **skipped**. No additional agents dispatched.
- Unrelated pre-existing changes found in
  `docs/voice-latency-benchmark/README.md` and
  `docs/voice-latency-benchmark/provider-architecture-assessment-2026-11-16.md`;
  leave both untouched.

## Current primary documentation

Context7 was queried on 16 November 2026 using `/websites/openrouter_ai` for
reasoning metadata, token caps, Models API modalities/endpoints, and provider
parameter filtering. `/websites/langchain` was queried for ChatOpenRouter
reasoning serialization; that index primarily returned Python results, so the
current JavaScript integration documentation and installed JavaScript/types were
also inspected. No constructor or `invocationParams` inspection invokes a model.

1. [Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
   - `reasoning.supported_efforts` array: use model-declared values/order.
   - Explicit `null`: all gateway efforts accepted.
   - Absent property: effort selection not exposed; do not infer Low/Medium/High
     from `reasoning`, `reasoning_effort`, `supports_max_tokens`, or model name.
   - Gateway `reasoning.effort` vocabulary currently:
     `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`.
   - `mandatory: true` forbids disabling reasoning, including `effort: "none"`.
     Provider default is **omission**, not `enabled: true`, `"medium"`, or the
     catalogue's `default_effort`.
   - `reasoning.exclude: true` suppresses returned reasoning on Chat Completions,
     not its computation/cost. Do not add a reasoning-token slider.
   - On most providers the output cap covers hidden reasoning plus visible output;
     the entire cap can be spent reasoning, producing empty content with
     `finish_reason: "length"` and billable usage.
   - Tool continuation can require unchanged `reasoning_details`, signatures or
     encrypted blocks. Aurvin does not preserve these; never claim continuity
     was verified or add private reasoning storage to solve it.
2. [Models overview](https://openrouter.ai/docs/guides/overview/models) and
   [Models API](https://openrouter.ai/docs/api_reference/models)
   - Catalogue supports output/input modalities and served endpoint filters.
   - The default list is text-output, not a proof that every entry accepts
     text input and Chat Completions.
   - Inspect `architecture.input_modalities`, `output_modalities`, and `endpoints`.
     Explicit exclusion is incompatible; missing evidence is unable to verify.
   - `context_length` and `top_provider.max_completion_tokens` are declared
     capacities. Input/output share the context window; an output ceiling is
     not guaranteed visible output.
   - Public model metadata is aggregate evidence, not a simultaneous
     account-specific route guarantee.
3. [Request parameters](https://openrouter.ai/docs/api/reference/parameters)
   - `max_tokens` and `max_completion_tokens` are positive integer output caps;
     the latter expressly shares the former's semantics/reasoning caveat.
   - Prefer `max_tokens` when declared to preserve current payloads; otherwise
     send **only** declared `max_completion_tokens`. Neither declared: reject.
   - Do not use reasoning-only `reasoning.max_tokens` as a total output cap.
4. [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection)
   - Preserve `provider.data_collection: "deny"` and `require_parameters: true`.
     Public catalogue listing or ZDR filters do not prove current account
     eligibility. Do not silently allow training, drop caps, enable transforms,
     or turn parameter filtering off to force a route.
5. [JavaScript ChatOpenRouter](https://docs.langchain.com/oss/javascript/integrations/chat/openrouter)
   - Existing dependency suffices; installed version is pinned by lockfile
     (`@langchain/openrouter` dependency range `^0.4.17`).
   - Installed `dist/chat_models/types.d.ts` exposes
     `modelKwargs?: Record<string, unknown>`, not a typed top-level reasoning
     constructor field.
   - Installed `dist/chat_models/index.js:215–248` serializes `maxTokens` as
     `max_tokens`, and spreads `this.modelKwargs` last.
   - Minimal explicit effort serialization:
     `modelKwargs: { reasoning: { effort, exclude: true } }`.
     Provider default supplies no `reasoning` object, preserving existing JSON.
     The alternate total cap can be switched on the returned parameter object;
     no SDK upgrade or custom duplicate request builder is necessary.

### Public catalogue observation (not certification)

An unauthenticated GET of
`https://openrouter.ai/api/v1/models?output_modalities=text&input_modalities=text&endpoints=%2Fapi%2Fv1%2Fchat%2Fcompletions`
returned HTTP 200, approximately 665 KB, 382 entries:

- 268 reasoning objects; 109 of those omitted `supported_efforts`.
- No observed explicit-null effort fields; **null must still have its documented
  implementation and deterministic fixture**.
- 365 entries declared `max_tokens`, 91 `max_completion_tokens`, 10 the latter
  without the former; six had no finite top-provider completion ceiling.
- Observed efforts included all seven gateway values.
- Entries contain `architecture`, `endpoints`, and `supported_parameters`.
- Prices can contain `overrides` keyed by `min_prompt_tokens`, and
  `internal_reasoning`. An illustrative tier starts at 272,000 prompt tokens.
  A base completion price is not automatically safe for every arbitrary model
  and arbitrarily raised context budget.

The earlier approved goal's unfiltered observation (468 entries) and this filtered
observation differ in query and time. Neither number is a product limit.

## Repository flow and smallest change surface

### Settings, storage, and activation

- `backend/src/contracts/admin-config-wire.ts` owns public types, field/error
  enums, routes, and strict exact-key guards.
- `frontend/src/api/admin-config-protocol.ts` is its manual browser mirror.
  Changing types alone breaks guards and wire parity.
- `backend/src/contracts/admin-config.ts` owns strict Zod settings, request,
  and stored-document parsers. `storedManageableSettingsSchema` already performs
  narrowly scoped absent-only preprocessing for web-search and history defaults.
- Add required normalized `openRouter.reasoningEffort` with explicit
  `"provider-default"` sentinel. Existing **stored** settings missing just that
  property normalize in memory to default before the strict parser; explicit
  null/undefined/unknown values or extra keys still fail. Do not broadly loosen
  `manageableSettingsSchema` or silently repair malformed submitted requests.
- Keep schema/protocol version 1, following the established additive
  stored-default pattern. No startup write/migration or revision bump; next
  ordinary confirmed CAS writes the normalized field.
- `platform/config/manageable-config.ts` owns defaults, bounded budget
  composition, strict verified-limit assertion, frozen runtime construction, and
  public projection. `config-runtime.ts` and `load-config.ts` have explicit
  OpenRouter shapes and must carry the field.
- `platform/config/legacy-config-import.ts` starts from defaults and only
  replaces model ID: it naturally imports Provider default. No new env override
  is requested. `scripts/import-config.ts` reuses snapshot preparation; test the
  default path rather than add a second settings source.
- `AdminConfigService.saveSettings` validates, queues, reads the expected
  revision, decrypts, **prepares before CAS**, then publishes only a confirmed
  result. Credential replace/remove also prepare. `prepare()` currently discards
  the underlying error into `CONFIG_ACTIVATION_UNAVAILABLE`; preserve a typed
  bounded compatibility fault, without forwarding arbitrary provider errors.
- `AppService.prepareConfigurationSnapshot` validates bootstrap budgets,
  `assertChatFloor`, `assertFixedContextFits`, catalogue limits, then freezes.
  Startup/readiness, save, credential activation, and import converge here.
- `prepareSnapshot` updates `lastPrepared`; `publishSnapshot` compares that exact
  pointer. A compatibility check must **not call activation.prepare** or mutate
  `lastPrepared`, or a read-only check can interfere with a save.

### Catalogue and security

- `model/catalogue.ts` currently performs an authenticated `/models` GET, bounded
  at 4 MiB and `connectTimeoutMs`, then combines lookup/capability verification.
  It checks context/completion integers and `max_tokens`, but not text input,
  chat endpoint, or effort. Errors collapse to one vague AppError.
- Reuse bounded `readJson` (`model/deadlines.ts`), fixed OpenRouter base,
  decimal price parser, `verifiedCalendar`/`derivedCalendar`, fixed-floor helpers.
  Separate pure evaluation from acquisition in this same module; no generic
  provider framework.
- Public listing can use an unauthenticated fixed-host catalogue GET. No need
  to decrypt or send a saved API key merely to populate/check metadata.
  A check can inspect **credential presence plus config revision** without
  inspecting the credential. Actual activation still requires the saved key.
- Public list projection must exclude descriptions, provider raw bodies,
  credentials, and routing/account data. Bound IDs/names/entry count/bytes.
- `main.ts` installs `configurePrivateHttp` before admin middleware:
  authenticated full account, `requireSuperAdmin` for every `/api/admin/**`,
  origin checks, request identity attachment.
- Important end-to-end isolation seam: `http/configure-private-http.ts` calls
  `prepareOwner` after authentication for every private request.
  `AppService.prepareOwner` warms Calendar `statusV2` and personalization;
  cold preparation can read owner-specific Calendar connection/discovery state.
  Exempt **only** the exact new GET models and POST compatibility routes from
  optional owner warming, after full authentication/super-admin checks and
  before identity attachment. Do not exempt auth/account freshness, origin,
  transport, or configuration revision reads. Add a private-boundary regression
  proving no owner preparation, model POST, or Calendar access for these routes.
- `admin-config/configure-admin-http.ts` already covers every
  `/api/admin/config/**`: no-store/no ETag, nosniff, no query, trusted
  TLS/explicit loopback dev, 60/min, 16 KiB JSON, 5-second body deadline,
  identity encoding. Put new routes under this prefix; no security bypass.
- Service `assertActor` separately requires authenticated local-account
  super-admin. Existing validation budget: two in flight, six starts/minute.

### Every request path and binding seam

`providerParameters(config, request)` has exactly three production call sites:

1. `model/policy.ts:buildBody` → `OpenRouterAttemptAdapter` for ordinary text.
   Adapter builds once before its automatic rejection retries.
2. `model/calendar-policy.ts:buildCalendarBody` →
   `model/calendar-adapter.ts`. Both legacy Calendar and V2 skill/native/
   composite adapters share this body builder and its serializer.
3. `model/web-native.ts:createWebNativeModelPort` →
   `model/native-stream.ts:streamNativeCompletion` for web-only rounds.

`calendar-adapter.ts`, `native-stream.ts`, and `openrouter-adapter.ts` are the
three actual Chat Completions POST transports. `benchmark/live-budget.ts` is a
measurement wrapper, not another builder. `model/index.ts:createModelServices`
closes over the supplied config/limits.

Request binding already exists:

- `chat-runtime/durable-chat-runtime.ts` captures a text snapshot before
  acceptance in `attemptSettings`. Explicit retry captures current settings for
  a **new** attempt; duplicate submissions keep original IDs/settings.
- `chat-runtime/memory-text.ts` production memory-first `Entry.snapshot` captures
  once at acceptance; text/web/Calendar execution uses that snapshot. No config
  reads or catalogue I/O belong on the inference hot path.
- `chat-runtime/calendar-loop.ts` passes `ctx.snapshot.openRouter` and limits to
  Calendar/V2/composite ports throughout repair/provider/tool rounds.
- `chat-runtime/web-turn.ts` must be checked with the same bound config
  rule; its web model port ultimately calls the shared serializer above.
- `voice/session/voice-session.service.ts:capture` retains a
  `RuntimeConfigSnapshot` for an admitted voice session; reconnect keeps it.
  `voice/agent/agent-voice-adapter.ts:submit` passes that same `configSnapshot`
  into `submitLiveTurn`; durable and memory-first paths accept it.
- Keep existing voice-session lifetime semantics: new voice sessions get new
  settings, an ongoing call/reconnect does not silently switch LLM or speech
  configuration. Dictated text sent as a new ordinary chat attempt uses current
  chat settings.

Add the setting to existing projections; test binding instead of refactoring
these runtimes or adding browser/model-request effort overrides.

### Optional tools and prices

- `VerifiedModelLimits.tools` independently gates native web-tool availability.
- `calendar` requires native tools and usable decimal prices. Existing frozen
  price evidence is optional, not a model admission allowlist; arbitrary model
  IDs can use live catalogue prices.
- Keep pins when supplied; do not silently replace a mismatched frozen rate.
- For candidate contexts reaching a declared pricing override, or malformed/
  unknown overrides, disable Calendar with a price warning rather than
  under-reserve or build a tier-price engine. Base prices remain usable when
  all well-formed thresholds are strictly above the admitted context ceiling.
  An explicitly different internal reasoning unit price is not represented by
  the present flat accounting contract: disable Calendar, not text/web.
- No real Calendar account inspection is needed. “Declared available” means
  model-side capability, not connection/consent/policy authorization.

### Frontend and tests

- `AdminDashboard.tsx` owns loads/saves, credential success, epoch refs and
  aborts; `config-edit-state.ts` owns nonsecret drafts, field conversion,
  stale/CAS rules, and history-dependent context raising.
- `ConfigFields.tsx` uses labeled native inputs/selects with help/error IDs.
  Smallest accessible searchable dropdown: labeled search input filtering a
  controlled native model `<select>`, with selected ID always retained.
  No custom ARIA combobox or dependency is necessary.
- `admin-config-client.ts` currently accepts only `PublicAdminConfig`, all
  response bodies <=64 KiB, and marks dispatched mutations uncertain.
  Reuse its request flow with a supplied guard/byte bound; catalogue list gets
  a dedicated 1 MiB bound. Read-only POST check must be `mutation: false`;
  timeout/network errors must not poison the settings save state.
- Existing Node frontend checks: reducer tests, fetch fixtures and SSR
  `admin-dashboard.test.ts`. The closed browser harness is
  `frontend/src/features/admin-config/testing/{dashboard-browser.tsx,browser-checks.ts}`.
  No browser DOM testing framework is installed or needed.
- Existing backend seams: contract/default/import specs, `test/model/*`,
  admin service fixtures and HTTP security tests, `test/assembly/*`,
  `test/runtime/text-config.spec.ts`, voice session snapshot tests,
  memory-first production-route fixture suites and required Calendar
  blocked-storage/barrier/recovery/performance regressions in root instructions.

## Decisions and remaining unknowns

All product decisions needed for implementation are supplied by the approved
goal. The plan makes conservative technical choices (finite sizes/TTLs,
absent-only migration, equivalent cap, native searchable select). There is no
additional user decision blocking planning.

Unknown account/provider routing, model-specific reasoning minimums, proprietary
tokenization, real SSE, tool behavior, replay requirements, and native topology
remain honestly unverified. Do not introduce model-name exceptions or infer
undocumented capabilities to hide them. Implementation requires new authorization.
