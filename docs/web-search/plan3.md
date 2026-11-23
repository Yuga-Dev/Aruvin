# Web Search Memory-First Text and Voice Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate P2's account-bound Web Search into Aurvin's existing text/voice execution, with one conditional `web_tool`, bounded repair and retrieval, nonblocking archival, and unchanged Calendar authority and mutation semantics.

**Architecture:** `AppService` composes one P2 connection/OAuth/runtime assembly over the existing persistence owner and injects its secret-free port into the existing `DurableChatRuntime`/`MemoryText` path. A small accepted-turn web state owns counters, complete native groups, and bounded presentation evidence; the existing native model transport is reused for both web-only and Calendar-plus-web decisions. Preparation is control-plane/background work, while generation, continuation, and immediate next-turn admission use memory.

**Tech Stack:** Existing Node.js/TypeScript NodeNext ESM, NestJS, LangGraph, OpenRouter SSE, Zod 3.25, Vitest, MongoDB/RecordStore, P1 web contracts, and P2's installed MCP SDK integration; no additional dependencies.

---

## Authority, prerequisites, and boundaries

- This is **planning**, not implementation, test evidence, or latency certification. Planning inspection: 2026-11-14. Read [goal.md](goal.md), [state.md](state.md), [research.md](research.md), [plan1.md](plan1.md), [plan2.md](plan2.md), root `../../AGENTS.md`, and the actual P1/P2 exports before execution.
- **Worker gate:** P1 complete, P2 worker committed and verified, this plan committed, and orchestrator assignment. P2 implementation did not exist at initial inspection; its `types.ts`, connection, and repository appeared during drafting and their exported shapes were checked read-only. Runtime/OAuth/module completion still requires its returned verified worker handoff. A plan commit does not satisfy a worker dependency.
- Use the available `executing-plans` and `test-driven-development` skills. The required header's `superpowers:` names do not authorize invented skills or additional delegation.
- Unified review is **skipped**, never passed. TDD, defect correction, regression checks, and final verification remain required.
- Preserve `.commandcode/`, `.openchamber/`, Calendar/user work, and concurrent P2/P4 changes. Recheck Git status before each edit/commit. Never stage a directory recursively. Use explicit, path-scoped commits and serialized commit permission.
- No package installs, manifest changes, live provider/model/OAuth checks, provisioning, paid health probes, arbitrary page HTTP requests, or frontend edits in P3.
- New code/test files require the repository's complete FILE/LOCATION/PURPOSE/ROLE IN PROJECT/KEY COMPONENTS header. Existing files changed by >30% need that header too. Local TypeScript imports use `.js`.
- Retain one `AppService`, one `DurableChatRuntime`, one configured OpenRouter model, one work/reservation registry, and one persistence-close owner. A new concrete web request wrapper around the **same extracted native SSE transport** is not a new runtime, model selection, or inference service.

### Findings that determine this plan

1. `MemoryText.execute` currently selects `CalendarLoop` on `snapshot.modelLimits?.calendar?.tools`, **not** on plugin enablement. A web sibling guarded by `!calendar.tools` would hide web on most admitted native-tool models. Handle web inside that existing native branch as well as the text-only-capability branch.
2. Calendar's public native schemas deliberately reject `web_tool`: `calendar-model.ts` restricts names, `calendar-policy.ts` requires exactly `SKILL_NATIVE_TOOLS`, and `calendarContext` validates Calendar-specific sources. Do **not** widen these P1/Calendar contracts or cast web groups into them. P3-owned composite types and explicit web-aware overloads wrap the existing Calendar validators; pure Calendar calls retain their original path.
3. `scanJsonObject` hardcodes Calendar forbidden keys, including `url`, and currently misses prototype keys. Its two callers are `model/calendar-validation.ts` and `model/calendar-repair.ts`. Preserve their default denied fields and add a narrow caller-selectable key policy for web.
4. `MemoryText.messages` and `MongoMessages.list` enumerate visible fields, so P1's new message fields otherwise disappear. `MemoryFirstFoundation.terminalEnvelope` also constructs output explicitly. All three projections need the additive web fields.
5. `MemoryTextArchive` already schedules bounded ordered post-response saves through `MemoryFirstFoundation`; “one consolidated save” means **one terminal envelope/job**, not a single Mongo command or a new transaction.
6. Existing `ChatHttpService.messages` prepares selected history outside a turn. Existing cold `MemoryText.submit` can hydrate inside submission. For the web-enabled memory-first path, require selected history to be prepared before accepting an existing-session turn; a cold/unprepared web account simply omits web and does not hydrate web connections from a turn.
7. `configurePrivateHttp` authenticates before calling `prepareOwner`. `AuthService.authenticate` itself calls `users.bySubject`, a database read. Therefore zero-I/O **admitted-runtime** proof must not be misreported as zero-I/O from raw HTTP arrival. See the explicit authentication limitation below; do not weaken authentication to manufacture a zero.
8. Context7's current LangGraph documentation confirms explicit recursion termination and cooperative cancellation. Keep the repository's installed `buildTurnGraph(undefined, ...)`, `signal`, and `Work.settled()` pattern; do not introduce the newer documented `RunControl` API or upgrade LangGraph.

## File map and ownership

Paths in braces below enumerate exact files, not permission to change whole directories.

| P3 action | Exact paths | Responsibility |
| --- | --- | --- |
| Modify | `backend/src/app.service.ts`, `backend/src/app.module.ts`, `backend/src/main.ts` | One plugin assembly, module/options, control-plane preparation, lifecycle/drain, HTTP registration |
| Modify | `backend/src/http/configure-private-http.ts`; create `backend/src/http/web-search-boundary.ts` | Exact static callback exception, bounded JSON/control-plane boundary, no cold web preparation on turn routes |
| Modify | `backend/src/persistence/persistence.ts` | Construct/export P2's repository over the existing `store`/`owner` |
| Modify | `backend/src/model/catalogue.ts`, `backend/src/model/strict-json.ts` | Independent tools capability; parameterized scanner key policy |
| Create | `backend/src/model/native-stream.ts` | Extract the existing Calendar SSE transport once, preserving deadlines, observation, cleanup, and early Canvas control |
| Create | `backend/src/model/web-native.ts` | Concrete web/composite request types, canonical tool advertisement, raw web-call validation/repair/closed denial, web request policy |
| Modify narrowly | `backend/src/model/calendar-adapter.ts`, `backend/src/model/calendar-stream.ts`, `backend/src/model/calendar-policy.ts` | Delegate transport; expose bounded raw candidate; explicit optional composite policy without changing Calendar-only admission |
| Create | `backend/src/context/web-context.ts` | Insert complete web groups at recorded positions and conservatively bound the full composite prompt |
| Create | `backend/src/chat-runtime/memory-web-state.ts` | Strict bounded data-only web evidence, counters, model observations, complete groups, archive schema |
| Create | `backend/src/chat-runtime/web-turn.ts` | One read-only per-turn controller over `WebSearchPort`; checks, charge, no-replay, presentation, honest termination |
| Modify | `backend/src/chat-runtime/ports.ts`, `backend/src/chat-runtime/durable-chat-runtime.ts`, `backend/src/chat-runtime/memory-text.ts`, `backend/src/chat-runtime/memory-first-foundation.ts` | Inject port, accepted-turn state, native-loop selection, terminal/history/async archive integration |
| Modify narrowly | `backend/src/chat-runtime/calendar-loop.ts` | Optional web branch at decide/execute/context seams only; no provider, consent, mutation, recovery, or prepared-authority changes |
| Create | `backend/src/persistence/memory-web-records.ts` | One bounded metadata record per terminal attempt; scoped hydration and idempotent archival |
| Modify | `backend/src/persistence/memory-text-archive.ts`, `backend/src/persistence/messages.ts` | Include web evidence in existing save job and durable UI projection |
| Modify | `backend/src/voice/agent/agent-voice-adapter.ts` | Map shared runtime web events to bound `web.frame`; reuse cancellation and speech delivery |
| Create tests | `backend/test/runtime/web-search-fixture.ts`, `backend/test/runtime/web-search-runtime.spec.ts`, `backend/test/runtime/web-search-coexistence.spec.ts` | Shared fixture, actual MemoryText loop/repair/budgets/races, Calendar coexistence |
| Create tests | `backend/test/model/web-native.spec.ts`, `backend/test/context/web-context.spec.ts` | Raw/envelope/schema validation, composite history and context bounds |
| Create tests | `backend/test/assembly/web-search-composition.spec.ts`, `backend/test/http/web-search-boundary.spec.ts` | Actual composition, lifecycle, route/control-plane boundaries |
| Create tests | `backend/test/voice/web-search-voice.spec.ts`, `backend/test/persistence/memory-web-records.spec.ts` | Real voice bridge, interruption, archive/reload/linkage |
| Modify tests | `backend/test/model/catalogue.spec.ts`, `backend/test/model/strict-json.spec.ts` | Focused independent capability/scanner regressions |

**Read-only P2 handoff:** `backend/src/plugins/web-search/{types,connection,oauth,runtime,mcp-client,module,controller,oauth-callback-page}.ts`, `backend/src/platform/crypto/web-search-secret-cipher.ts`, `backend/src/persistence/web-search-connections.ts`, `backend/src/persistence/indexes.ts`, and `backend/test/plugins/web-search/**`. P2 owns network preparation, token lifecycle, fixed provider mapping, URL safety, fallback, and indexes. P3 never reads/decrypts credentials.

**Read-only P1:** all `contracts/**`, manageable/admin configuration, manifests/lockfiles. In particular keep `WEB_TOOL_DEFINITION`, `WEB_TOOL_PARAMETERS`, `WebToolArguments`, `WebToolResult`, `WebPresentationEvent`, `WebFramePayload`, configuration defaults, and public error codes unchanged.

**P4 handoff, not P3 edits:** frontend admin-config/voice mirrors; text SSE parsing/reduction; Plugins controls; clickable source/activity rendering; history projections; live voice `web.frame` handling. There is no composer toggle or model picker.

**P5 handoff:** integrated performance/assembly evidence and workflow reports. Existing Calendar fixtures are run, not edited. If their baseline is failing, preserve failures and report attribution; do not delete assertions or silently alter production semantics.

## Frozen integration contracts

### 1. P2 port and lifecycle

Consume these exact P2 contracts from `backend/src/plugins/web-search/types.ts`:

```ts
type PreparedWebAccount = Readonly<{
  userId: string; revision: number; generation: number; enabled: boolean;
  prepared: boolean;
  providers: readonly Readonly<{
    provider: WebSearchProvider;
    capabilities: Readonly<{ browse: boolean; fetch: boolean }>;
  }>[];
}>;
type WebCallContext = Readonly<{
  userId: string; turnId: string; toolCallId: string;
  webDeadlineAt: number; signal: AbortSignal;
  activity?: (activity: WebSearchActivity) => void;
}>;
interface WebSearchPort {
  snapshot(userId: string): PreparedWebAccount;
  validateInput(args: WebToolArguments, context: WebCallContext):
    Promise<ValidatedWebInput | Extract<WebToolResult, { ok: false }>>;
  execute(input: ValidatedWebInput, context: WebCallContext): Promise<WebToolResult>;
}
```

- `snapshot` is synchronous, memory-only, secret-free, and returns a closed projection for an unprepared owner. `providers` contains only currently executable prepared sessions, not merely saved credentials.
- `validateInput` runs **after model dispatch**; fetch safety/DNS checks belong to P2. Its issued ticket is opaque, single-use, owner/turn/call-bound, and expires after <=1s. Do not forge/copy a ticket or put an await between final charging and `execute` that could consume that lifetime.
- `execute` owns fixed sequential fallback and current permission/version checks, including a check before publishing each result. P3 charges one logical call, never individual fallback slots. P2 does not write chat evidence, emit SSE, connect/discover/refresh from ordinary snapshot, or reset P3 counters.
- P2's approved simplification is **no runtime OAuth refresh**. Stale/missing sessions are skipped; background maintenance can repair them. Do not reintroduce refresh/connect/discovery from `WebTurn`.
- Instantiate `McpWebClient`, `WebSearchSecretCipher`, `WebSearchConnections`, `WebSearchOAuth`, and `WebSearchRuntime` once in `AppService`, using their P2 constructor options. Bind `connections.setMaintenance((u, signal) => oauth.maintainOwner(u, signal))` once. If a returned P2 export name/options differ, reconcile with P2; do not modify its files or guess incompatible constructors.
- `warmOwner` loads/decrypts only on control-plane preparation; hits perform zero storage calls. `maintainOwner` owns P2's bounded lifecycle scheduling; do not add another interval, task queue, warmup service, provider probe, or readiness dependency.
- Logout/deactivation synchronously call `oauth.invalidate(userId)` and `connections.evict(userId)` **before** awaiting other cleanup. Shutdown synchronously starts `oauth.close()` and `connections.close()`, tracking the actual promises through `trackConfigJob`; the existing config drain waits for them before persistence release. A timeout does not pretend an unfinished write/job stopped.

### 2. Composition and admission

`RuntimeDependencies` gains only:

```ts
webSearch?: WebSearchPort;
```

It is the same account-scoped-by-argument port for text and voice; `dependenciesFor(userId)` already carries the rest of the owner compartment. Do not add web settings/identity to client submit messages, voice input, or `RuntimeConfigSnapshot`.

`AppService` exposes readonly `webSearchConnections`, `webSearchOAuth`, and `webSearchRuntime`. `createRuntime` passes `webSearch: this.webSearchRuntime`. `WebSearchModule.registerAsync` injects the existing `AppService`, with:

```ts
{
  connections: () => service.webSearchConnections,
  oauth: () => service.webSearchOAuth,
  principal: () => service.identities.principal(),
  assertNoClientOverrides: body => service.identity.assertNoClientOverrides(body),
  frontendOrigin: service.bootstrap.frontendOrigin,
  secureCookie: new URL(service.bootstrap.frontendOrigin).protocol === 'https:',
}
```

`persistence.ts` imports `MongoWebSearchConnections` from `./web-search-connections.js`, constructs `new MongoWebSearchConnections(store, owner, budgets)` with the **existing** objects, and returns it as `webSearchConnections`. Its constructor was checked against P2's in-progress source; verify the final commit too. No `MongoClient`, close callback, executor claim, or independent database owner is added.

Preparation rules:

| Entry | Web preparation behavior |
| --- | --- |
| Plugins status/connect/toggle/OAuth completion | P2 control-plane warm/setup; confirmed changes update the shared map before success returns |
| `/api/auth/me` after successful authentication | Tracked bounded `warmOwner` outside a turn; optional lifecycle request once hydrated; never a retrieval probe |
| Existing selected-history GET | Existing `prepareSession` may hydrate history; web warm may run here, outside accepted turns |
| Text submit/retry/stream execution | Only `snapshot`; never await or initiate a cold warm/network job |
| Live finalized speech / next live turn | Same memory-only port; connection setup belongs to voice session/control plane, not finalized speech |
| Readiness/liveness | No P2 network call, no probe, no web-health gate |

Do **not** add web warm to the existing unconditional `prepareOwner` Promise.all: private HTTP calls it on turn submissions too. Expose `prepareWebOwner(principal)` for control-plane routing, and keep repeated `prepareOwner` Calendar behavior unchanged. `/auth/me` is already exempt from the private middleware, so wrap `service.auth.me` at composition or use an explicit main HTTP hook; do not assume private middleware invokes it.

**Cold history:** existing-session generation is admitted only from a prepared MemoryText session on the web-enabled memory-first path. Use existing `ChatHttpService.messages -> runtime.prepareSession` and voice binding preparation. If not prepared, return existing `NOT_READY` before accepting/model dispatch, with zero web preparation; do not silently fall into the durable path or discard selected history. Keep non-web legacy behavior unchanged until its owner authorizes a broader admission change.

**Authentication limitation:** `AuthService.authenticate` presently performs `users.bySubject` on every private HTTP request. P3 does not own `auth/**` or an account-authorization cache. Required runtime fixtures begin **after trusted authentication**, and production HTTP fixtures separately count that existing authentication read. If acceptance is interpreted as zero DB operations from raw HTTP arrival, the orchestrator must assign an authentication-owner change or approve that explicit boundary before AC6 can be claimed globally. Never cache a principal ad hoc, skip session/revocation checks, or label the authentication read “zero.”

### 3. P3-owned state and native boundaries

Define these internal types in `memory-web-state.ts`; schemas are strict and bounded. Import P1 types rather than duplicating their unions:

```ts
type WebNativeCall = {
  id: string; type: 'function';
  function: { name: 'web_tool'; arguments: string };
};
type WebToolGroup = {
  ordinal: number;
  afterCalendarGroups: number;
  assistant: { role: 'assistant'; content: string | null; tool_calls: [WebNativeCall] };
  result: { role: 'tool'; tool_call_id: string; name: 'web_tool'; content: string };
  sources: WebSourceReference[];
};
type WebCounters = {
  searchesUsed: number; fetchesUsed: number; schemaRepairsUsed: number;
  modelAttemptsUsed: number; evidenceBytes: number;
};
type MemoryWebState = {
  schemaVersion: 1; userId: string; sessionId: string; turnId: string;
  acceptedAtMonotonic: number; runDeadlineAt: number; webDeadlineAt: number;
  limits: WebSearchLimits; advertised: boolean;
  counters: WebCounters;
  groups: WebToolGroup[];
  activities: WebSearchActivity[];
  sources: WebSourceReference[];
  dispatches: AccountingRecord[];
};
```

- Store one mutable controller/state on the accepted `Entry` as `web?: WebTurn`; expose data-only snapshots to the foundation. `WebTurn` has no repository or credentials.
- `acceptedAtMonotonic` is captured using `performance.now()` synchronously at acceptance, not execution or first retrieval. Inject `webNow?: () => number` on the internal fixture/controller options; do not confuse `RuntimeDependencies.now` (wall time) with monotonic time.
- `runDeadlineAt = acceptedAtMonotonic + acceptedSnapshot.budgets.totalRunTimeoutMs`; `webDeadlineAt = min(runDeadlineAt, acceptedAtMonotonic + 45_000)`. Across retries of the **same turnId**, retain original deadlines, limits, counters, prior complete groups, and successful-call identities. A new accepted turnId starts fresh. Replay/reconnect does not initialize state again.
- Monotonic coordinates are valid only within the enclosing foundation's process epoch. Archived values are evidence, not portable restart deadlines. On a new epoch, reuse sealed output/groups for history/save recovery but refuse further same-turn web execution; require a newly accepted turn rather than rebasing a monotonic clock or granting another 45 seconds.
- Acceptance creates state without a provider call. `WebTurn.bind(signal)` binds the later `Work.signal` at execute time; same-process explicit retry creates a fresh controller over a copied data snapshot with unchanged counters/deadlines, never reuses an aborted signal.
- `WebTurn` receives `headroom(mode: WebSearchMode | null, feedback?: string): boolean` from the owning MemoryText/native-loop composition. At model/tool boundaries it measures the current prepared composite prompt, worst-case mode result plus native envelope, current prose/projections, and foundation reservation. For repair, `mode:null` measures the actual feedback/schema instead. Cache stable prefix size; update group/projection deltas at decision boundaries, not token callbacks. This callback reads memory only.
- `modelAttemptsUsed` counts every model HTTP attempt on a web-advertised turn, including Calendar decisions, schema repair, and any allowed pre-output provider rejection retry. Bound by `webModelAttemptLimit(limits)` (15 at 5/5; <=45). Calendar-enabled execution additionally obeys its existing dispatch/spend ceilings; do not raise Calendar limits to make a web test pass.
- Schema repair uses its own 0..3 counter, **not** Calendar's 0..2 repair counter. In a composite turn, web repair is a regular continuation in the Calendar ledger (`repair: null` there), with web feedback in the web group. Actual Calendar schema repairs keep their existing charge/reason.
- Web groups are sequential, ordinal-ordered, with matching unique call/result IDs. `afterCalendarGroups` records where the group occurred relative to already-complete Calendar/local-native groups. Reject out-of-range anchors and duplicate IDs across both sets.
- Complete groups only: never persist a dangling assistant tool call. A cancelled issued call gets a matching bounded failure result; an untrusted malformed envelope with no usable ID gets bounded rejection evidence, not an invented successful native call.
- Each group is bounded to 4,096 argument bytes, 4,600 result bytes, one call, and P1 source bounds. Schema-error groups may retain bounded malformed argument **strings** for causal history, but never parse/reexecute them as valid calls. Unknown tool names are not persisted as executable web calls.
- Preserve max 40 latest activities, max 15 source refs, 12,000-byte caps for each projection, 24,000 bytes of web evidence, and existing foundation/session/envelope caps. Reject a new call before dispatch if its worst-case bounded result plus projections cannot fit; do not make a successful external call and then silently throw away its linkage.
- `MemoryWebState.dispatches` is a finite per-attempt list of actual model observations. Store only provider IDs, usage, money/timing, outcome, and existing accounting fields—no private model reasoning. A retry keeps prior counters/groups but puts observations for its own attempt in its own terminal evidence record.
- Do not overwrite accounting with only the last model request. Keep one existing attempt-level `AccountingRecord` projection in `e.accounting`: sum known token/cost observations using existing accounting/money helpers; mark unknown if any required observation is unknown. For multiple provider generation IDs, set that aggregate record's `generationId` to null and retain every actual generation ID in the bounded dispatch list. Never invent a provider generation ID for the aggregate or count Calendar ledger observations twice.

`web-native.ts` defines a **local**, non-P1 composite message/tool/decision union:

```ts
type WebNativeMessage =
  | NativeCalendarModelMessage
  | WebToolGroup['assistant']
  | WebToolGroup['result'];
type WebDecision =
  | { kind: 'web_tool'; call: WebNativeCall; args: WebToolArguments; assistantContent: string | null }
  | { kind: 'web-invalid'; call: WebNativeCall | null; diagnostics: string[] }
  | { kind: 'web-denied'; call: WebNativeCall | null;
      result: Extract<WebToolResult, { ok: false }> };
type WebNativeDecision = SkillDecision | WebDecision;
type WebNativeDefinition = typeof WEB_TOOL_DEFINITION;
type WebNativeRequest = Omit<SkillDecisionRequest, 'messages' | 'tools'> & {
  messages: readonly WebNativeMessage[];
  tools: readonly (SkillNativeDefinition | WebNativeDefinition)[];
};
type WebNativeChunk =
  | Exclude<SkillDecisionChunk, { type: 'decision' }>
  | { type: 'decision'; decision: WebNativeDecision };
```

These replace only the request's `messages`/`tools` and decision union for the **opt-in composite overload**. All other composite request/binding fields retain the existing Calendar identities, deadlines, hooks, privacy and reservation checks. `pendingWeb` also records `request.decisionId` for the existing cursor; never fabricate a Calendar `SkillDecision` to obtain one. Web-only request construction supplies its own memory dispatch ID and fixed `processingPolicyId: 'web-search.v1'`, with no Calendar reservation/binding. Never use `as unknown as SkillDecision`, accept arbitrary tool names, or loosen Calendar's public schemas.

The same web-aware parser may run with `advertised:false` to classify a stale unsolicited `web_tool` as `web-denied` without execution or repair. In that case do not require `modelLimits.tools`, add schemas, add prompt instructions, or start a retrieval job. A no-Calendar empty tool list is serialized by **omitting** the `tools` property, not sending an empty tool schema. With no `RuntimeDependencies.webSearch` installed, the existing plain/Calendar parser route remains unchanged.

### 4. Advertisement, validation, repair, and bounded execution

At acceptance, capture:

```ts
const account = dependencies.webSearch?.snapshot(identity.userId);
const advertised = shouldAdvertiseWebTool({
  enabled: account?.prepared === true && account.enabled,
  hasEligibleProvider: Boolean(account?.providers.some(p => p.capabilities.browse || p.capabilities.fetch)),
  modelSupportsTools: snapshot.modelLimits?.tools,
});
```

- While enabled/eligible, append `WEB_TOOL_DEFINITION` **after** the existing `SKILL_NATIVE_TOOLS` in their unchanged order. For a model without Calendar pricing/capability, use `[WEB_TOOL_DEFINITION]`. Web names/provider catalogs never alter that order or schema.
- Disable removes the definition from **all subsequent model requests**, including an active loop continuation; current in-memory permission is read before serializing each request. Enabled mid-turn takes effect next accepted turn, not an unadvertised active turn. An already-dispatched body cannot be withdrawn.
- A connected-provider outage may cause the next request to omit web; an enabled account's stored preference is not changed. Never do a probe to decide advertisement.
- Web off/unprepared/no connection/non-tool model routes ordinary chat normally and performs zero web calls. Where the port is installed, the shared parser still recognizes a stale model-emitted web call and returns the correct closed denial, not schema repair. `validateWebCandidate(batch, advertised)` uses `WEB_DISABLED` for its false-advertisement pure test; WebTurn refines the actual denial using current memory/model state (`WEB_DISABLED`, `WEB_CONNECTION_REQUIRED`, or `WEB_MODEL_UNSUPPORTED`), without dispatch.
- Explicit search/page-read intent is in the unchanged P1 tool description. Do not add a regex that retrieves every incidental URL, forward chat/Calendar context to P2, or force a tool on every enabled turn.

Validation order: whole-batch cardinality/name/envelope -> scanner -> P1 `webToolArgumentsSchema` -> in-memory authority/cancel/deadline/context/limit -> P2 `validateInput` -> repeat cheap current checks -> increment one mode counter -> P2 `execute` -> cancellation/current-publication gate -> complete group/evidence -> next model request.

Mixed Calendar/web batches are rejected **before any tool executes**. One sequential web call per decision; pure Calendar decisions use their existing validator. Syntactically valid `ftp:`, `file:`, private, credential-bearing, or internal URLs reach P2's non-repairable safety denial, not schema repair.

Repair behavior:

```ts
const feedback = JSON.stringify({
  code: 'WEB_SCHEMA_INVALID',
  errors: diagnostics,
  expectedSchema: WEB_TOOL_PARAMETERS,
});
if (feedback.length > WEB_SEARCH_POLICY.maxRepairFeedbackChars) {
  throw new AppError('CONTEXT_BUDGET_EXCEEDED', 'Web verification could not fit in this chat.', false);
}
```

Diagnostics are <=4 entries, from fixed paths `$`, `tool_calls`, `id`, `name`, `mode`, `query`, `url`, each a fixed code; no raw values, provider text, arbitrary Zod messages, or credentials. This leaves room for the **entire** canonical schema under 1,500 characters; assert its actual serialized length in tests.

- Increment `schemaRepairsUsed` immediately before dispatching each additional repair model request, only if P1 `canRepairWebSchema` plus shared model/deadline/context budgets permit. Invalid args consume no browse/fetch budget and dispatch no provider.
- If a native ID/envelope is usable, append a matching failed tool result containing that feedback. For missing/bad IDs or mixed/unknown batches, do not send invalid native messages back; retain bounded rejection diagnostics and append a continuation system note with the same feedback. Do not erase or reconstruct prior successful groups.
- Four invalid model responses give exactly **four model requests total** (initial +3); the fourth invalid response seals a local honest failure with **zero extra synthesis request**. If other bounds stop earlier, report that bound rather than claiming all three repairs occurred.
- Provider failure, URL-safety rejection, off/disconnected authority, model capability, mode/context/time budget exhaustion, cancellation/interruption do not increment repair or trigger repair. At most one ordinary synthesis continuation can explain a non-schema terminal failure; remove executable web tool advertisement for that terminal continuation, and never dispatch it on cancellation.
- If a native call ID repeats with the same validated arguments, reuse its completed result without another P2 execute or counter charge. Reuse with different args is a closed structural rejection with no provider dispatch. Do not deduplicate distinct IDs by query text: two separately requested searches can be legitimate and consume two calls.
- Late P2 results never become sources, prompt content, archives, or voice frames after cancellation or revocation. P2's provider-generation fence handles replacement/disconnect of A without poisoning B; P3 must not use global account revision equality to discard a valid B fallback merely because A changed.

### 5. Calendar coexistence without contract/schema changes

Use these exact seams:

1. `CalendarStreamAssembly` adds `rawCandidate()` returning the already bounded text/native fragments and terminal marker before Calendar name/schema parsing. Its existing `finish()` remains unchanged for pure Calendar.
2. Extract the transport portion of `OpenRouterCalendarAdapter.stream` into `model/native-stream.ts`: POST, SSE parser, deadlines, generation/usage observation, diagnostics, cleanup and early-control opportunity. Retain the existing Calendar factory signatures and behavior through a wrapper. No alternate model, no duplicate fetch/parser loop.
3. Add an **explicit composite overload** to `buildCalendarBody` taking P3's web profile. Default still asserts exactly `SKILL_NATIVE_TOOLS` and calls `assertNativeHistory`. Composite mode accepts only those exact definitions plus the canonical web definition, uses the combined context estimate for reservations, and validates each Calendar subsequence with existing validators and each web group with P3's bounded schema. It never permits arbitrary definitions.
4. `createWebNativeModelPort` uses that same transport. With Calendar capability, it uses the existing `MemoryCalendarLedger` dispatch binding; without it, it uses a P3 memory-only binding with the same server user/model/privacy/deadline checks and bounded `AccountingRecord` observations. Preserve ordinary text's finite pre-output 429/503 rejection policy using existing `mayRetryRejection`/`retryDelay`; every actual POST is counted, and a transport-ambiguous or output-started request is never replayed. Do not fabricate Calendar pricing, bindings, budget records, or schema revisions to make a web-only model eligible.
5. `CalendarLoopContext` gains optional `web?: WebTurn`. At `context()`/`decide()`, assemble Calendar groups **unchanged**, then insert web groups using `webContext`. Reserve the combined estimated input, and count each shared model dispatch in WebTurn before fetch.
6. In `decide()`, web-invalid candidates go to WebTurn repair; web-denied candidates produce the closed local failure; valid web candidates are stored in a distinct `pendingWeb` field and route to the existing graph's execute node. They never enter `skillDecisionSchema`, Calendar decision records, `activate_skill`, a Calendar ledger logical-tool debit, or mutation promotion.
7. At the very top of `CalendarLoop.execute`, handle `pendingWeb` through WebTurn and return `calendarCursor.next = 'decide'`. The cursor is merely existing memory routing; web evidence remains in its separate state. The remainder of Calendar execution is unchanged.
8. Keep Calendar prepared authority, `readAccount`, `ensureMutationAccepted`, `CalendarOperationWriter`, event IDs, proposal consumption, readback, invalidation, tombstones, source expiry, promotion/finalization, and archive ownership behavior byte-for-byte unless an additive type/plumbing edit is unavoidable. No web barrier, DB lookup, or provider preparation is added there.
9. Preserve early live `control_canvas` execution and identity/accounting cleanup when extracting transport. A web/mixed candidate can never use this early-control path. Existing pure Calendar fixtures must see identical request tools, body fields, provider counts, and ordering when web is off.
10. Web-only turns run their bounded sequential loop inside the existing `buildTurnGraph(undefined, { prepare, generate })` generate hook. Composite turns reuse Calendar's graph nodes and existing recursion limit 48 (Calendar's lower dispatch bound still applies). No new checkpointer, graph schema version, durable pre-model checkpoint, or automatic web resume is introduced.

### 6. Sources, activity, voice, and archive

Import exact P1 shapes:

```ts
{ type: 'web-activity', activity: {
  toolCallId, mode, phase, provider, code,
} }
{ type: 'web-sources', sources }
{ type: 'web.frame', turnId, attemptId, responseId, event }
```

- Phases: `searching`/`reading`, `fallback`, `completed`, `failed`, `cancelled`. No raw queries, URLs, page bodies, provider errors, secrets, or endpoint internals in activity. Keep the latest activity for each toolCallId; sources are cumulative bounded successful references.
- P2 activity callback is synchronous. Update memory immediately and enqueue at most one pending latest event per call; a single tracked publisher drains via existing `send`/Work bounds. Never start one untracked promise per fallback, per token, or per source.
- Text uses existing protocol-1 `send` (including compatible Calendar envelopes' ordinary event union). Completed and replay events include `webSources` and `webActivities`; one monotonically increasing sequence per existing envelope stream.
- Voice needs **no new LiveExecution callback**: `AgentVoiceAdapter` currently passes `emit: async () => undefined`; replace it with a handler accepting only P1 web presentation events. Check active object, controller, closed/invalid flag, connection epoch, conversation/reservation, sessionId/turnId/attemptId before `sink.event({ type: 'web.frame', ... })`. Never send activity text to TTS, infer from sources in a second voice model, or claim sources were spoken.
- After generation, `finish` passes `webSources`, `webActivities`, and frozen `web` evidence into `MemoryFirstFoundation.complete`. Include all projection bytes in `checkOutputCapacities`, foundation evidence/output/envelope accounting, and admission reservations.
- `MemoryTerminal` gains optional web projections and data-only `web`; `TerminalEnvelope` gains optional `web`. The assistant output gets `webSources`/`webActivities`; user messages never do. Store no raw unbounded pages.
- `memory-web-records.ts` defines strict metadata `kind: 'memory-web-native'`, `schemaVersion: 1`, owner/session/turn/attempt, epoch/version/fence, counters/limits, complete groups and dispatch observations. Bound the whole record by `min(policy.maxEvidenceBytes, persistence.maxDocumentBytes)` and the web evidence ceiling. Use deterministic `_id = key('memory-web-native', userId, sessionId, attemptId)`.
- `MemoryTextArchive.project` includes this **one record** in the existing `values`/byte charge and `ensure` path, before the session publication marker; unchanged majority ownership/journal/idempotency checks apply. No separate archive queue or save call. Budget its added read/insert operations against existing max 32; fail admission if actual envelope cannot fit rather than silently increasing that ceiling.
- `readMemoryWebRecords` loads only bounded records for the selected attempts during `prepareSession`/history hydration. Verify owner/session/attempt, deterministic ID, publication epoch/version/fence, and group linkage. No accepted-turn lookup; no provider/model replay during hydration.
- Source records retain exact successful provider, sourceId, toolCallId, public URL, retrieved timestamp, optional publisher metadata from P2. On cancellation keep only already-published safe successes, not late content; preserve cancelled/interrupted outcome and prior complete groups.
- For partial evidence (`truncated: true`, failed later call, context/limit stop), tell the model the limitation in the corresponding tool result/continuation note. If no evidence succeeded, fixed terminal fallback: **“I couldn't verify this on the live web. Please try again.”** For schema exhaustion: **“I couldn't format a valid web request, so I couldn't verify this on the live web. Please try again.”** Do not fabricate a citation, claim full-page retrieval after clipping, or automatically repeat a failed provider/model call.
- Archive retry/status/reconnect reuse sealed output and evidence only. Unsealed web execution after process loss is interrupted; no automatic model/tool replay. After restart an explicit retry of the same accepted turn may not reset counters or replay completed groups; if validated prior evidence/counters cannot be loaded, fail closed and request a newly accepted turn instead.

## Task 1: Establish the fixture and independent model capability

**Files:** create `backend/test/runtime/web-search-fixture.ts`; modify `backend/test/model/catalogue.spec.ts`, `backend/src/model/catalogue.ts`.

- [ ] **Step 1 — Write RED capability cases** in the existing catalogue test:

```ts
it.each([
  [['max_tokens', 'tools'], true],
  [['max_tokens'], false],
])('publishes tools independently of Calendar pricing: %j', async (supported, expected) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    data: [{ ...entry, supported_parameters: supported }],
  }));
  const result = await loadModelLimits(config(), new AbortController().signal, fetcher);
  expect(result.tools).toBe(expected);
  expect(result.calendar).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models');
});
```

- [ ] **Step 2 — Run RED** from `backend`: `npm test -- test/model/catalogue.spec.ts -t "publishes tools independently"`; expect `undefined` versus true/false.
- [ ] **Step 3 — Minimal capability implementation:** add to the existing `text: ModelLimits` object, without changing `verifiedCalendar`/`derivedCalendar`:

```ts
tools: Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes('tools'),
```

- [ ] **Step 4 — Build the reusable fixture only as tests need it.** Export `webSearchFixture` with exact options `{ enabled?: boolean; connected?: boolean; prepared?: boolean; tools?: boolean; calendar?: boolean; save?: SaveTerminal }`. Build from `textConfigFixture(textSnapshot(1), decorate)`; use `PROPOSED_MEMORY_TEXT_POLICY` and fixture-only snapshots with top-level `tools`. Expose the existing fixture members plus these concrete controls:

```ts
type WebFixtureControl = {
  queue: (...decisions: Array<
    { text: string } | { id: string; name: string; raw: string }
  >) => void;
  frames: StreamEnvelope[];
  bodies: Record<string, unknown>[];
  effects: { db: number; discovery: number; connect: number; refresh: number; web: number };
  beforeModel: Array<{ db: number; discovery: number; connect: number; refresh: number; web: number }>;
  disable: () => void;
  disconnect: () => void;
  holdResult: () => { entered: Promise<void>; release: () => void };
  advance: (ms: number) => void;
};
```

Implement queue responses with existing `test/fixtures/openrouter/frames.ts` SSE helpers and distinct generation IDs. Fake `WebSearchPort.snapshot` returns a frozen secret-free account; `validateInput` returns an actual fixture-issued opaque ticket; `execute` returns a P1-validated browse/fetch result linked to its context. Snapshot counters immediately at the model fetch stub **before** returning any model frame. Instrument repository/checkpoint/owner entry points using `vi.spyOn`; unknown outbound origins throw. Use P2's real connection/MCP fixture for composition/race tests, not a fake port as sole acceptance evidence.

- [ ] **Step 5 — Run GREEN:** `npm test -- test/model/catalogue.spec.ts`; expect all named capability and existing Calendar-pricing checks pass. Commit only the two catalogue files and the new fixture with message `feat(web-search): expose independent model tools capability`.

## Task 2: Scanner policy without weakening Calendar

**Files:** modify `backend/src/model/strict-json.ts`, `backend/test/model/strict-json.spec.ts`; start `backend/test/model/web-native.spec.ts`.

- [ ] **Step 1 — Write RED:**

```ts
it('permits web url while keeping prototype and Calendar denied keys closed', () => {
  const limits = { argumentBytes: 4096, jsonDepth: 4 };
  const webDenied = new Set(['__proto__', 'constructor', 'prototype']);
  expect(scanJsonObject('{"mode":"fetch","url":"https://example.com/"}', limits, webDenied))
    .toEqual({ code: null, forbidden: false });
  expect(scanJsonObject('{"url":"https://example.com/"}').forbidden).toBe(true);
  for (const key of webDenied) {
    expect(scanJsonObject(`{"nested":{"${key}":{}}}`, limits, webDenied).forbidden).toBe(true);
    expect(scanJsonObject(`{"${key}":{}}`).forbidden).toBe(true);
  }
  expect(scanJsonObject('{"mode":"browse","mode":"fetch"}', limits, webDenied).code)
    .toBe('duplicate-key');
});
```

- [ ] **Step 2 — Run RED:** `npm test -- test/model/strict-json.spec.ts`; expect missing third parameter/prototype assertions.
- [ ] **Step 3 — Minimal implementation:** keep scanner algorithm unchanged, add the repository header (small file changes exceed 30%), and use:

```ts
const prototypeKeys = ['__proto__', 'constructor', 'prototype'] as const;
const denied = new Set<string>([...forbiddenCalendarKeys, ...prototypeKeys]);
export function scanJsonObject(
  raw: string,
  limits: Pick<CalendarLimits, 'argumentBytes' | 'jsonDepth'> = CALENDAR_LIMITS,
  forbiddenKeys: ReadonlySet<string> = denied,
): JsonScan {
```

Inside the existing object-key scan change only `denied.has(key)` to `forbiddenKeys.has(key)`. The web caller supplies exactly the prototype-key set; P1 strict argument validation rejects other unknown fields.

- [ ] **Step 4 — Run GREEN:** `npm test -- test/model/strict-json.spec.ts test/model/calendar-validation.spec.ts test/model/calendar-repair.spec.ts`; require existing duplicate/depth/number/escaped-key tests remain green. Add web cases for escaped `__proto__`, top-level arrays, nonfinite numbers, 4,097 UTF-8 bytes, depth5, unknown keys and URL syntax; no provider needed.
- [ ] **Step 5 — Commit** only these named files: `fix(web-search): support safe URL arguments in the shared JSON scanner`.

## Task 3: Bounded web-native validation and repair messages

**Files:** create `backend/src/model/web-native.ts`; extend `backend/test/model/web-native.spec.ts`.

- [ ] **Step 1 — Write RED tests for exported `validateWebCandidate(batch, advertised)` and `webRepairFeedback(diagnostics)`:**

```ts
const candidate = (raw: string, name = 'web_tool') => ({
  calls: [{ index: 0, id: 'web_call_1', type: 'function', name,
    arguments: raw, envelopeInvalid: false }],
  terminal: 'tool_calls',
  envelopeInvalid: false,
});
it('validates browse and fetch without dispatching or conflating safety with syntax', () => {
  expect(validateWebCandidate(candidate('{"mode":"browse","query":"  news  "}'), true))
    .toMatchObject({ kind: 'web_tool', args: { mode: 'browse', query: 'news' } });
  expect(validateWebCandidate(candidate('{"mode":"fetch","url":"http://127.0.0.1/"}'), true))
    .toMatchObject({ kind: 'web_tool', args: { mode: 'fetch' } });
  expect(validateWebCandidate(candidate('{"mode":"fetch","url":"not a URL"}'), true).kind)
    .toBe('web-invalid');
  expect(webRepairFeedback(['query:required'])).toContain(JSON.stringify(WEB_TOOL_PARAMETERS));
  expect(webRepairFeedback(['query:required']).length).toBeLessThanOrEqual(1500);
});
```

Also test wrong mode, both mode fields, missing field, empty/oversize query, malformed JSON, duplicate keys, forbidden prototype keys, bad ID/type/name, duplicate/mixed batch, wrong finish marker, and disabled/stale tool denial. No fake provider dispatch is needed for this pure boundary.

- [ ] **Step 2 — Run RED:** `npm test -- test/model/web-native.spec.ts`; expect missing exports.
- [ ] **Step 3 — Implement exact validation sequence** from the frozen boundary, using `idSchema`, `scanJsonObject`, `webToolArgumentsSchema.safeParse`, and fixed diagnostic codes. Construct a valid `WebNativeCall` explicitly; do not pass arbitrary object fields through. `webRepairFeedback` uses the complete JSON block above and checks the cap once.
- [ ] **Step 4 — Run GREEN:** same command, then `npm run build`; no P1 schema edits or Calendar type casts. Disabled/not advertised emits a non-repairable result, never `web-invalid`.
- [ ] **Step 5 — Commit** the two files: `feat(web-search): validate native calls and canonical repair feedback`.

## Task 4: Accepted-turn state, charges, and single-use execution

**Files:** create `backend/src/chat-runtime/memory-web-state.ts`, `backend/src/chat-runtime/web-turn.ts`; extend `backend/test/runtime/web-search-runtime.spec.ts`.

- [ ] **Step 1 — Write RED using `WebTurn` constructor options** `{ port, identity, sessionId, turnId, limits, advertised, acceptedAtMonotonic, runTimeoutMs, nowMs, signal, present, headroom }`. Public methods are `bind(signal)`, `snapshot()`, `beforeModel()`, `repair(diagnostics, call)`, `execute(decision, afterCalendarGroups)`, `presentation()`, `freeze()`. `repair` returns `{ retry: boolean; feedback: string; code: WebToolErrorCode }`; `execute` returns a complete group or a closed failure, never a provider object.

```ts
it('keeps a turn-wide 5/5 limit and never replays a successful ID', async () => {
  const source = { sourceId: 'source_1', toolCallId: 'good_1', provider: 'exa' as const,
    kind: 'browse' as const, title: 'Example', url: 'https://example.com/',
    retrievedAt: '2026-11-14T00:00:00.000Z' };
  const port: WebSearchPort = {
    snapshot: userId => ({ userId, revision: 1, generation: 1, prepared: true, enabled: true,
      providers: [{ provider: 'exa', capabilities: { browse: true, fetch: true } }] }),
    validateInput: vi.fn(async (args, context) => Object.freeze({
      args, userId: context.userId, turnId: context.turnId, toolCallId: context.toolCallId,
    })),
    execute: vi.fn(async () => ({ ok: true as const, mode: 'browse' as const, provider: 'exa' as const,
      results: [{ source, snippet: 'Useful public evidence.' }], truncated: false })),
  };
  const turn = new WebTurn({ port, identity: { userId: 'u1', openRouterUser: 'u1',
    source: 'authenticated-session' }, sessionId: 's1', turnId: 't1',
    limits: { maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 }, advertised: true,
    acceptedAtMonotonic: 0, runTimeoutMs: 180000, nowMs: () => 1,
    signal: new AbortController().signal, present: () => undefined, headroom: () => true });
  const decision = validateWebCandidate(candidate('{"mode":"browse","query":"news"}'), true);
  if (decision.kind !== 'web_tool') throw new Error('Fixture must be a valid web decision.');
  decision.call.id = 'good_1';
  await turn.execute(decision, 0);
  await turn.execute(decision, 0);
  expect(port.execute).toHaveBeenCalledTimes(1);
  expect(turn.snapshot().counters).toMatchObject({ searchesUsed: 1, fetchesUsed: 0 });
});
```

Import the Task 3 `candidate` equivalent as a test-local function in this runtime spec: it constructs one index0/function/native ID call with `terminal:'tool_calls'` and no envelope invalidity, exactly as shown in Task 3. The fake port here deliberately isolates the controller; actual P2-issued ticket/fallback behavior is checked in Tasks 6/12. Do not use a fake ticket against the real P2 runtime.

- [ ] **Step 2 — Run RED:** `npm test -- test/runtime/web-search-runtime.spec.ts -t "turn-wide"`; expect missing WebTurn implementation, not no-test success.
- [ ] **Step 3 — Implement state and execution kernel:**

```ts
const checked = await port.validateInput(decision.args, context);
if ('ok' in checked) return checked;
checkCurrentMemoryPermission();
checkCancellationDeadlineAndHeadroom();
const field = decision.args.mode === 'browse' ? 'searchesUsed' : 'fetchesUsed';
state.counters[field] += 1;
const result = await port.execute(checked, context);
checkCancellationAndPublicationPermission();
```

The named checks are private `WebTurn` methods defined in this task: compare `snapshot.userId`, prepared/enabled/provider capability; check signal/deadlines; mode counter `< accepted limit`; use `headroom` plus fixed state/group/projection ceilings for worst-case capacity. At the second check, repeat counter availability before increment. Check duplicate call identity **before** validateInput; reuse completed matching group. Catch only closed P2 faults, map unexpected failures to `WEB_PROVIDER_UNAVAILABLE` with no raw text, and never retry provider execution from catch.

- [ ] **Step 4 — Add direct GREEN counter tests:** five browse + five fetch each succeed, sixth of either returns its limit and zero provider dispatch; failure fallback counts as one logical call; invalid/safety consumes zero; disable between validation and execute sends zero; exact web deadline blocks; model ceiling15/45; counters survive explicit retry by turnId; repeated same ID/different args sends zero. Inject a monotonic clock, no wall-clock sleeps.
- [ ] **Step 5 — Commit** direct state/controller source/tests only after those named cases pass: `feat(web-search): enforce accepted-turn budgets and no-replay execution`. Add assembled runtime tests only in Task 7, so this commit does not deliberately leave an unwired red test.

## Task 5: Shared native model transport and composite context

**Files:** create `backend/src/model/native-stream.ts`, `backend/src/context/web-context.ts`, `backend/test/context/web-context.spec.ts`; modify `backend/src/model/{calendar-adapter,calendar-stream,calendar-policy,web-native}.ts`.

Split this task into the following small red/green changes rather than replacing the adapter in one rewrite.

- [ ] **Step 1 — Characterize RED-to-GREEN extraction tests:** add assertions to `web-native.spec.ts` that Calendar-off/off-web still produces byte-equivalent `tools`, user/session grouping, plugins, privacy, max tokens, finish markers, generation IDs, usage and cancellation cleanup. Reuse existing `test/model/calendar-adapter.spec.ts` transport cases and early Canvas control case names; do not modify that Calendar suite. Before extraction those existing cases should pass; the new web overload test fails.
- [ ] **Step 2 — Extract one native SSE transport.** Export:

```ts
export type NativeStreamHooks<T> = {
  body: () => Record<string, unknown>;
  beforeDispatch: () => Promise<void>;
  observe: (raw: unknown, ended: boolean) => Promise<void>;
  frame: (raw: unknown) => T[];
  finish: () => T[];
};
export async function* streamNativeCompletion<T>(
  config: ModelConfig,
  signal: AbortSignal,
  deadlineAt: string,
  hooks: NativeStreamHooks<T>,
  fetcher: typeof fetch,
): AsyncGenerator<T>
```

Move—not copy—the existing adapter's POST/SSE/deadline/reader/cleanup implementation into this function. Keep bounded `readJson`, `parseSse`, `RunDeadlines`, headers and `redirect:'error'`. `beforeDispatch` runs once per actual POST; observations are absolute memory snapshots for MemoryText. Existing Calendar wrapper keeps its failure/decision schemas and binding hooks. A provider error never becomes an implicit retransmission. Preserve `finally` body cancellation, observation flush and early-control completion; no dangling async parser after generator return.

- [ ] **Step 3 — Run extraction GREEN:** `npm test -- test/model/calendar-adapter.spec.ts test/model/calendar-stream.spec.ts test/model/calendar-policy.spec.ts test/model/session-affinity.spec.ts`. Fix extraction defects before adding web behavior.
- [ ] **Step 4 — Write RED context grouping test** for `webContext({ calendarMessages, webGroups, historyPositions, budgets, tools })`. It returns `{ messages, estimatedInputTokens, remainingContextTokens }`:

```ts
it('keeps complete web groups in chronological native order without duplicating accepted input', () => {
  const result = webContext(contextWithCalendarAndWebGroups());
  const messages = result.messages;
  expect(messages.filter(m => m.role === 'user' && m.content === 'Find current news')).toHaveLength(1);
  const index = messages.findIndex(m => 'tool_calls' in m && m.tool_calls[0].id === 'web_1');
  expect(messages[index + 1]).toMatchObject({ role: 'tool', tool_call_id: 'web_1', name: 'web_tool' });
  expect(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id))
    .toEqual(['calendar_1', 'web_1', 'calendar_2']);
});
```

`contextWithCalendarAndWebGroups()` is a test-local function in `web-context.spec.ts`, built from existing `test/context/fixtures.ts` plus explicit complete groups, one web anchor `afterCalendarGroups:1`, and budgets from `textSnapshot(1)`. Define it in this step; source IDs/URLs are fixture-only public `https://example.com/` values.

- [ ] **Step 5 — Implement composite assembly/validation:** expose `CalendarStreamAssembly.rawCandidate()` from its existing maps; `web-native` routes raw web/mixed batches to Task 3, pure Calendar batches to unchanged `.finish()`. `webContext` validates Calendar subsequences with `assertNativeHistory`, web groups with strict P3 schemas, merges groups at recorded anchors/current and historical user positions, checks duplicate IDs globally, and measures `64 + UTF8(JSON.stringify({messages,tools})) + messages.length*32`. Reserve configured max output, model margin, and >=1,024 synthesis headroom; never trim history. Add the explicit composite body-builder overload from the coexistence contract, no relaxed default branch.
- [ ] **Step 6 — Add GREEN cases:** 24,001 evidence bytes, context overflow, 15/16 sources, source-byte overflow, unknown/mismatched/dangling/duplicate IDs, malformed rejected-call group, out-of-order anchor, two copies of accepted input, historical voice-generated text not proven heard, provider instruction injection remaining tool content, and unchanged canonical tool ordering. Run `npm test -- test/context/web-context.spec.ts test/model/web-native.spec.ts test/model/calendar-adapter.spec.ts test/model/calendar-policy.spec.ts`.
- [ ] **Step 7 — Commit** only these source/test files: `feat(web-search): reuse native transport with bounded composite context`.

## Task 6: One backend plugin assembly and off-turn preparation

**Files:** modify `backend/src/{app.service,app.module,main}.ts`, `backend/src/persistence/persistence.ts`, `backend/src/http/configure-private-http.ts`; create `backend/src/http/web-search-boundary.ts`, `backend/test/assembly/web-search-composition.spec.ts`, `backend/test/http/web-search-boundary.spec.ts`.

- [ ] **Step 1 — Write RED assembly checks** using existing `test/assembly/admin-config-fixture.ts`/`assemblyFixture` and P2's actual classes with intercepted fetch. Capture runtime factory dependencies:

```ts
it('shares one persistence owner and runtime with plugin and voice and does not probe readiness', async () => {
  const f = await webCompositionFixture();
  expect(f.runtimeFactory).toHaveBeenCalledTimes(1);
  expect(f.openPersistence).toHaveBeenCalledTimes(1);
  expect(f.dependencies.webSearch).toBe(f.service.webSearchRuntime);
  await f.readReady();
  expect(f.webTraffic()).toEqual([]);
  await f.shutdown();
  expect(f.persistenceClose).toHaveBeenCalledTimes(1);
});
```

Define `webCompositionFixture()` in that spec using the existing assembly fixture's open/runtime/limits overrides, fixture P2 MCP fetch, and a fake repository; it returns precisely the fields used above. No new production dependency-injection framework or exports of secrets for tests.

- [ ] **Step 2 — Run RED:** `npm test -- test/assembly/web-search-composition.spec.ts test/http/web-search-boundary.spec.ts`.
- [ ] **Step 3 — Implement wiring** at the exact contracts above. Constructor fragments:

```ts
const cipher = new WebSearchSecretCipher(bootstrap.encryption);
const mcp = new McpWebClient({ fetch: this.ports.fetcher });
this.webSearchConnections = new WebSearchConnections({
  store: () => this.persistence?.webSearchConnections ?? null,
  cipher, mcp,
});
this.webSearchOAuth = new WebSearchOAuth({
  connections: this.webSearchConnections,
  store: () => this.persistence?.webSearchConnections ?? null,
  cipher, mcp, frontendOrigin: bootstrap.frontendOrigin,
  secureCookie: new URL(bootstrap.frontendOrigin).protocol === 'https:',
  fetch: this.ports.fetcher,
});
this.webSearchConnections.setMaintenance((userId, signal) =>
  this.webSearchOAuth.maintainOwner(userId, signal));
this.webSearchRuntime = new WebSearchRuntime({ connections: this.webSearchConnections, mcp });
```

Use the same local `cipher` and `mcp` instances in both options. Repository constructor/export must match P2's verified worker handoff. Add `webSearch` to the runtime dependency object, never instantiate another runtime from the module.

- [ ] **Step 4 — Implement the exact private HTTP boundary:** `configureWebSearchHttp` in `http/web-search-boundary.ts` uses `express.json({ limit: WEB_SEARCH_POLICY.maxHttpBodyBytes, strict:true })` only for fixed plugin mutation paths, maps body parse/size errors to P1 HTTP errors, and leaves other parsers untouched. Register after private authentication and before generic chat parsing. Permit PATCH in CORS independently of Calendar config, without changing Calendar-specific headers. Static callback bypass is **GET only**, one of the five exact `WEB_SEARCH_ROUTES.oauthCallback(provider)` paths with `/api`; do not exempt the plugin prefix, POST completion, or arbitrary provider path.
- [ ] **Step 5 — Add GREEN lifecycle/setup tests:** status/setup protected; cross-site mutation403; static callback has no identity/state mutation; completion private/session-bound; candidate never returned; 16,385-byte body413; malformed JSON400; extra query rejected by P2; settings CAS success next turn sees memory; connect does not enable; disable/disconnect synchronous fence before held save; logout/deactivation invalidate pending jobs; shutdown waits tracked close before DB release; web outage/readiness zero network. Test `prepareWebOwner` on `/auth/me`/selected-history control path and **no** call on submit/retry/stream or finalized speech.
- [ ] **Step 6 — Run GREEN:** same two suites plus `npm run build`; no source edits under P2 or Calendar provider directories. Commit only this task's paths: `feat(web-search): compose plugin lifecycle outside admitted turns`.

## Task 7: Wire MemoryText and native Calendar routing

**Files:** modify `backend/src/chat-runtime/{ports,durable-chat-runtime,memory-text,calendar-loop}.ts`; extend `backend/test/runtime/{web-search-runtime,web-search-coexistence}.spec.ts`.

- [ ] **Step 1 — Write RED request assertions:**

```ts
it.each([false, true])('advertises canonical web_tool with Calendar capability=%s', async calendar => {
  const f = webSearchFixture({ calendar });
  f.queue({ text: 'An ordinary answer.' });
  const ids = await f.submit('Hello');
  await f.execute(ids);
  const tools = f.bodies[0].tools as Array<{ function: { name: string } }>;
  expect(tools.filter(t => t.function.name === 'web_tool')).toEqual([WEB_TOOL_DEFINITION]);
  expect(f.effects.web).toBe(0);
  await f.dispose();
});
```

Add off/no connections/unprepared/tools false cases requiring web schema absent and zero provider calls; enabled-unused still advertises but does no web work.

- [ ] **Step 2 — Run RED:** `npm test -- test/runtime/web-search-runtime.spec.ts test/runtime/web-search-coexistence.spec.ts`; expect unwired web.
- [ ] **Step 3 — Minimal shared plumbing:** add `webSearch?: WebSearchPort`; preserve owner compartment injection. In `MemoryText.submit`, initialize one WebTurn after accepted identity/config and **reuse** the previous entry's state on same-turn retry. Record monotonic acceptance before any model work. Capture advertisement once; remove it dynamically on disable as specified. Add a prepared-session guard for web-advertised existing-session submission rather than awaiting cold hydrate. Do not change Calendar-only cold/recovery routes.
- [ ] **Step 4 — Wire native execution** following the ten coexistence seams. Use the existing model services and extracted native transport; both text and `c.live` enter the same WebTurn. With a web port installed use the web-aware parser even when unadvertised, solely to classify unsolicited stale web calls; this changes neither the off request body nor ordinary text retry/privacy behavior. Without a web port the existing branch remains unchanged. Add narrow optional `web` hooks and `pendingWeb` to CalendarLoop; preserve all original Calendar branches and barriers.

The routing decision is:

```ts
if (snapshot.modelLimits?.calendar?.tools) {
  // Existing Calendar/native graph, with optional web controller.
  await runExistingNativeBranch(webTurn);
} else if (webTurn) {
  // Existing text graph generate hook, same native transport and accepted state.
  // Off/no capability means no tools property, no web preparation or execution.
  await runWebGenerateHook(webTurn);
} else {
  await runExistingTextBranch();
}
```

These names describe the existing branch bodies, not three new runtimes or a requirement to extract the large MemoryText method. Keep the actual branch in place and add only the small web generate helper.

- [ ] **Step 5 — Add GREEN coexistence cases:** Calendar read -> web browse -> Calendar read -> narration, web -> Calendar create -> narration, Calendar disabled but native Canvas capability still present, web fetch without Calendar pricing, pure Calendar unknown/disallowed tool retains original classification, mixed web/Calendar batch zero effects, Calendar model limits remain enforced, web rejection counter independent of Calendar repair counter, Calendar provider call excludes web query/URL, P2 request contains only query/URL not Calendar payload.
- [ ] **Step 6 — Run GREEN:** `npm test -- test/runtime/web-search-runtime.spec.ts test/runtime/web-search-coexistence.spec.ts test/model/web-native.spec.ts test/context/web-context.spec.ts`. Add the assembled counterpart of Task 4: model emits the same successful ID twice then text; assert one provider effect, one charge, and one linked source in visible history. Commit only task paths: `feat(web-search): share the bounded text and native tool loop`.

## Task 8: Exactly three schema repairs, no successful replay

**Files:** extend `backend/test/runtime/web-search-runtime.spec.ts`; modify `backend/src/chat-runtime/web-turn.ts`, `backend/src/model/web-native.ts` only as failures require.

- [ ] **Step 1 — Write RED exact-exhaustion test:**

```ts
it('allows exactly three additional schema repairs and never dispatches invalid args', async () => {
  const f = webSearchFixture();
  f.queue(...Array.from({ length: 4 }, (_, index) => ({
    id: `invalid_${index}`, name: 'web_tool', raw: '{"mode":"browse"}',
  })));
  const ids = await f.submit('Search recent news');
  await f.execute(ids);
  expect(f.bodies).toHaveLength(4);
  expect(f.effects.web).toBe(0);
  for (const body of f.bodies.slice(1)) {
    const messages = body.messages as Array<{ content?: string }>;
    const feedback = messages.map(message => {
      try { return JSON.parse(message.content ?? '') as Record<string, unknown>; }
      catch { return null; }
    }).filter(message => message?.code === 'WEB_SCHEMA_INVALID');
    expect(feedback.at(-1)?.expectedSchema).toEqual(WEB_TOOL_PARAMETERS);
    expect(body.tools).toContainEqual(WEB_TOOL_DEFINITION);
  }
  expect(f.runtime.memoryMessages(f.identity.userId, ids.sessionId, { cursor: null, limit: 10 })
    ?.items.at(-1)?.content).toContain("couldn't verify");
  await f.dispose();
});
```

Assert the full definition is unchanged on each request. The malformed-envelope system-note variant also stores exactly this feedback JSON as its continuation content, not a different schema rendering.

- [ ] **Step 2 — Run RED:** `npm test -- test/runtime/web-search-runtime.spec.ts -t "schema repairs"`.
- [ ] **Step 3 — Implement repair dispatch check** using P1 helper and accepted counters:

```ts
const permitted = canRepairWebSchema({
  schemaRepairsUsed: state.counters.schemaRepairsUsed,
  modelAttemptsRemaining: webModelAttemptLimit(state.limits) - state.counters.modelAttemptsUsed,
  hasContextHeadroom,
  deadlineRemainingMs: Math.min(state.runDeadlineAt, state.webDeadlineAt) - nowMs(),
});
if (permitted) state.counters.schemaRepairsUsed += 1;
```

Increment once for a permitted additional dispatch; if transport never sends, retain the conservative charge rather than grant a free new retry. `WEB_SCHEMA_REPAIR_EXHAUSTED` produces the fixed local terminal answer, never another “synthesis” POST.

- [ ] **Step 4 — Add GREEN cases:** two repairs browse then one fetch across iterations; valid A -> malformed B -> corrected B sends A once; malformed ID/unknown name/mixed cardinality no invalid history; fourth invalid no fifth model; exhaustion on explicit same-turn retry preserved; cancellation/deadline/context/model ceilings stop earlier; disabled/private URL/provider auth/credits/timeout/exhausted providers/mode limit each consume zero repair. Assert provider calls, counters, bodies, groups and unchanged accepted input once in every continuation.
- [ ] **Step 5 — Commit** only these files after focused green: `test(web-search): lock shared repair and no-replay semantics`.

## Task 9: Consolidated terminal archive and complete UI history

**Files:** modify `backend/src/chat-runtime/{memory-text,memory-first-foundation}.ts`, `backend/src/persistence/{memory-text-archive,messages}.ts`; create `backend/src/persistence/memory-web-records.ts`, `backend/test/persistence/memory-web-records.spec.ts`.

- [ ] **Step 1 — Write RED archive test** using the real `createPersistenceBundle` over existing `test/persistence/calendar-multi-memory.ts`, not a save stub alone:

```ts
it('archives one bounded web record and restores source linkage without inference', async () => {
  const f = await webArchiveFixture();
  const ids = await f.searchAndComplete();
  await f.saved();
  expect(f.rows('metadata').filter(r => r.kind === 'memory-web-native')).toHaveLength(1);
  const before = f.modelCalls();
  await f.reloadSelectedSession(ids.sessionId);
  const message = (await f.listMessages(ids.sessionId)).items.at(-1);
  expect(message?.webSources?.[0]).toMatchObject({ toolCallId: 'web_1', provider: 'exa' });
  expect(message?.webActivities?.[0].phase).toBe('completed');
  expect(f.modelCalls()).toBe(before);
  await f.dispose();
});
```

Define `webArchiveFixture()` locally from `webSearchFixture` with a persistence override built on `calendarMemory`, the existing native archive, and explicit selected-history preparation. Its helpers wrap real runtime/archive methods; no fake “saved” flag replaces actual publication.

- [ ] **Step 2 — Run RED:** `npm test -- test/persistence/memory-web-records.spec.ts`.
- [ ] **Step 3 — Implement projection additions** in both MemoryText and MongoMessages enumerations:

```ts
...(record.webSources ? { webSources: record.webSources } : {}),
...(record.webActivities ? { webActivities: record.webActivities } : {}),
```

Use local variable `r` where MemoryText uses `r`. Add the same explicit fields to foundation terminal output, completed/replay events, and promoted output assembly. Pass the data-only web snapshot once through the existing terminal envelope. Charge projection bytes together with prose/Canvas/Calendar at every existing output-capacity boundary; do not defer a known overflow until `complete`.

- [ ] **Step 4 — Implement one metadata record/reader** per the frozen archive contract, using existing `bounded`, `key`, `RecordStore`, owner lease and `ensure` pattern. Add the record's read/insert before publication, within max32 operations; archive retries compare exact payload and never invoke model/P2. At hydrate verify publication matching before trusting counters/groups. Keep historical invalid-call strings inert and preserve native call/result ordering.
- [ ] **Step 5 — Add GREEN checks:** text and internal/live voice history retain sources/activities; old messages remain valid; user projection rejects web fields; source/call/provider mismatch and wrong owner/fence reject; oversized record rejected before dispatch; held save still permits terminal SSE and next turn; lost/unknown archive save never changes a completed read into another request; replay/save retry zero model/web calls; restart unsealed tool state interrupted without replay; retry counters not reset.
- [ ] **Step 6 — Run GREEN:** `npm test -- test/persistence/memory-web-records.spec.ts test/performance/memory-text-archive.spec.ts test/performance/memory-first-foundation.spec.ts test/performance/memory-first-text.spec.ts`. Commit task paths only: `feat(web-search): archive linked evidence in the existing terminal save`.

## Task 10: Text memory-first instrumentation and real held-archive continuation

**Files:** extend `backend/test/runtime/web-search-runtime.spec.ts`, `backend/test/assembly/web-search-composition.spec.ts`; fix only P3-owned source found by these tests.

- [ ] **Step 1 — Write RED hot-path assertion:**

```ts
it('dispatches and follows up without DB discovery connect or refresh before the model', async () => {
  const gate = deferred<void>();
  const f = webSearchFixture({ save: async envelope => {
    await gate.promise;
    return { kind: 'saved', epoch: envelope.epoch, sessionId: envelope.sessionId,
      version: envelope.version, fence: envelope.fence };
  } });
  f.queue({ id: 'web_1', name: 'web_tool', raw: '{"mode":"browse","query":"news"}' },
    { text: 'Verified, with bounded evidence.' }, { text: 'Immediate follow-up.' });
  const first = await f.submit('Search the news');
  await f.execute(first);
  const next = await f.submit('Continue', first.sessionId);
  await f.execute(next);
  expect(f.beforeModel[0]).toEqual({ db: 0, discovery: 0, connect: 0, refresh: 0, web: 0 });
  expect(f.beforeModel.map(c => c.db)).toEqual([0, 0, 0]);
  expect(f.bodies).toHaveLength(3);
  expect(f.effects.web).toBe(1);
  gate.resolve();
  await f.dispose();
});
```

Import existing `deferred` from `test/assembly/admin-config-fixture.ts`. Do not implement timeouts/sleeps to guess ordering.

- [ ] **Step 2 — Run RED:** `npm test -- test/runtime/web-search-runtime.spec.ts -t "without DB"`.
- [ ] **Step 3 — Minimal fixes** remove any turn-triggered `warmOwner`, provider prep, awaited archive, or in-loop checkpoint. Essential in-memory authority checks stay. Set WebTurn group/state synchronously before the follow-up POST; complete/clear active generation before terminal SSE independently of save resolution.
- [ ] **Step 4 — Add actual persistence-owner variant** in the assembly suite: use `calendarMemory.pauseNextUpdate()` to hold an actual `MemoryTextArchive` publication, then issue a web call and its next model continuation and next accepted turn. Capture delta of driver commands after the held archive enters; there must be no new commands attributable to admitted turn/loop. P2's real prepared session must show zero initialize/tools-list/connect/token-refresh before model; web-unused/off variants show zero retrieval calls. Keep cold-account ordinary chat and blocked maintenance save cases separate.
- [ ] **Step 5 — Run GREEN:** both suites. Record runtime-after-authentication counters separately from raw HTTP authentication DB reads. Commit named test/fix files only: `test(web-search): prove memory-first dispatch and held-save continuation`.

## Task 11: Voice frames through the same runtime and cancellation

**Files:** modify `backend/src/voice/agent/agent-voice-adapter.ts`; create `backend/test/voice/web-search-voice.spec.ts`; extend shared fixture only where needed.

- [ ] **Step 1 — Write RED bridge check** based on the real adapter fixture pattern in `test/performance/memory-first-voice.spec.ts`:

```ts
it('uses the shared web loop and emits bound web frames without speaking activity', async () => {
  const f = await webVoiceFixture();
  await f.say('Search the latest news');
  expect(f.beforeModel[0]).toEqual({ db: 0, discovery: 0, connect: 0, refresh: 0, web: 0 });
  const frames = f.events.filter(e => e.type === 'web.frame');
  expect(frames.some(e => e.event.type === 'web-sources')).toBe(true);
  expect(frames.every(e => e.responseId === f.responseId && e.attemptId === f.attemptId)).toBe(true);
  expect(f.spoken()).not.toContain('searching');
  expect(f.runtimeCount()).toBe(1);
  await f.dispose();
});
```

Define `webVoiceFixture()` in this spec using real `AgentVoiceAdapter`, `VoiceDelivery`, runtime reservations, finalized speech, fake LiveFlow sink/TTS, and existing voice fixture payloads. `say` calls `bridge.finalized`, not a new model function. Reuse shared WebSearchPort/model queue and actual archive option.

- [ ] **Step 2 — Run RED:** `npm test -- test/voice/web-search-voice.spec.ts`.
- [ ] **Step 3 — Replace only the no-op `emit` handler** with P1 validation and exact binding checks:

```ts
emit: async frame => {
  if (!canvasCurrent() || frame.sessionId !== active.ids.sessionId
    || frame.turnId !== active.ids.turnId || frame.attemptId !== active.ids.attemptId) return;
  const parsed = webPresentationEventSchema.safeParse(frame.event);
  if (!parsed.success) return;
  try {
    this.sink?.event({ type: 'web.frame', turnId: active.ids.turnId,
      attemptId: active.ids.attemptId, responseId, event: parsed.data });
  } catch { /* Best-effort presentation cannot replay inference or retrieval. */ }
},
```

`canvasCurrent` already checks call identity/epoch/reservation and can be reused here without changing Canvas semantics; if renamed, update every caller without changing its checks.

- [ ] **Step 4 — Add GREEN voice cases:** real held archive with immediate second finalized speech; ordinary/off/unused voice zero web calls; barge-in during MCP call aborts, no late source/frame/model continuation; interruption before first audio produces existing cancellation event; voice disconnect and socket epoch change discard late frames; new responseId cannot receive prior sources; dictation rejects web frame through unchanged P1 guard; completed sources survive visible voice history but do not assert unplayed generated prose was heard.
- [ ] **Step 5 — Run GREEN:** `npm test -- test/voice/web-search-voice.spec.ts test/performance/memory-first-voice.spec.ts test/runtime/calendar-memory-voice.spec.ts`; commit only task paths: `feat(web-search): present shared web evidence in live voice`.

## Task 12: Disable/disconnect races, partial outcomes, and remaining budgets

**Files:** extend runtime/composition/voice/coexistence suites; correct only their P3-owned source if required.

- [ ] **Step 1 — Write RED late-result race:**

```ts
it('discards a provider result after disable and never starts another external call', async () => {
  const f = webSearchFixture();
  const hold = f.holdResult();
  f.queue({ id: 'late_1', name: 'web_tool', raw: '{"mode":"browse","query":"news"}' },
    { text: "I couldn't verify this on the live web." });
  const ids = await f.submit('Search');
  const running = f.execute(ids);
  await hold.entered;
  f.disable();
  hold.release();
  await running;
  expect(f.effects.web).toBe(1);
  expect(f.frames.some(frame => frame.event.type === 'web-sources')).toBe(false);
  expect(f.runtime.memoryMessages(f.identity.userId, ids.sessionId, { cursor: null, limit: 10 })
    ?.items.at(-1)?.webSources).toBeUndefined();
  await f.dispose();
});
```

- [ ] **Step 2 — Run RED:** `npm test -- test/runtime/web-search-runtime.spec.ts -t "after disable"`.
- [ ] **Step 3 — Add only needed checks**: signal/current authority after each await, before provider dispatch, before group/sources publication, before follow-up POST, and in voice sink. Use P2's generation fencing rather than an invented revision comparator or DB freshness check. Caller cancel aborts Work; disable/disconnect best-effort abort only web work, allowing a plain honest answer where appropriate.
- [ ] **Step 4 — Complete deterministic matrix:** disconnect A during attempt, then authorized B fallback; disconnect last provider; replacement old-session result; disable then re-enable cannot resurrect old work; account B unaffected; cancel just before and after execute; shutdown; P2 ignores abort and resolves late; 5/5 with fallback all-five failures charged once; config edits do not reset accepted limits; next turn sees new limits; exact45s web deadline versus180s run bound; clipped/partial result and later failure preserve only real sources; all-providers-exhausted has no invented verification; no-call ordinary turn while maintenance unavailable.
- [ ] **Step 5 — Run GREEN** runtime/voice/coexistence/composition suites plus `npm test -- test/plugins/web-search/runtime.spec.ts test/plugins/web-search/prepared.spec.ts`. Request P2 fixes for port-generation/fallback defects rather than editing P2. Commit task-specific tests/fixes only: `test(web-search): cover revocation races and honest retrieval failures`.

## Task 13: Required regression and handoff verification

**Files:** no new production files; task-owned fixes only. Do not edit workflow `state.md` or reports from this worker; return evidence to the orchestrator/P5.

- [ ] **Step 1 — Record baseline first:** before any implementation task, run the required Calendar suites below and save their actual failing names/counts in the worker handoff. `state.md` records earlier failures (53 overall), but that is not a clean current baseline. Inspect current Git status and actual commits. If failures arise, load `systematic-debugging` and isolate root cause before changing owned source.
- [ ] **Step 2 — Run focused feature/model/history checks** from `backend`:

```powershell
npm test -- test/model/catalogue.spec.ts test/model/strict-json.spec.ts test/model/web-native.spec.ts
npm test -- test/context/web-context.spec.ts test/runtime/web-search-runtime.spec.ts test/runtime/web-search-coexistence.spec.ts
npm test -- test/assembly/web-search-composition.spec.ts test/http/web-search-boundary.spec.ts
npm test -- test/voice/web-search-voice.spec.ts test/persistence/memory-web-records.spec.ts
npm test -- test/model/calendar-adapter.spec.ts test/model/calendar-stream.spec.ts test/model/calendar-policy.spec.ts test/model/calendar-repair-flow.spec.ts
npm test -- test/performance/memory-first-text.spec.ts test/performance/memory-first-voice.spec.ts test/performance/memory-first-foundation.spec.ts test/performance/memory-text-archive.spec.ts test/runtime/calendar-memory-voice.spec.ts
```

Expected: nonempty discovered suites; all newly added checks pass; no new regressions. Report any preserved baseline failures by name, not a blanket green.

- [ ] **Step 3 — Run all mandatory Calendar critical-path cases**, without editing their files:

```powershell
npm test -- test/performance/calendar-tool-latency.spec.ts
npm test -- test/performance/calendar-memory-first.spec.ts
npm test -- test/plugins/google-calendar/connection-prepared.spec.ts
npm test -- test/assembly/calendar-assembly.spec.ts test/plugins/google-calendar/tools-boundaries.spec.ts test/performance/memory-calendar-state.spec.ts
```

Explicit checklist against root instructions:

| Required behavior | Existing suite |
| --- | --- |
| Four `prepared ... dispatches and continues with application storage blocked`; repeated owner preparation | `test/performance/calendar-tool-latency.spec.ts` |
| Read continuation/follow-up with actual archive ownership; provider-confirmed create with held projection | Same |
| Direct create and proposal confirmation cross essential barrier while prior archive owns persistence | Same |
| Crash W1/W2/W3/W4; new runtime ambiguous create pinned-ID readback without another POST | Same |
| Competing text tabs; concurrent text/live confirmations create once | Same |
| In-flight invalidation; exact `expiresAt`; expired policy denies without provider request/stale content | Same |
| Every `profiles ...` case | Same; synthetic waves and `performance.now()` observations reported separately |
| Cancel at dispatching CAS/after success preserves one provider effect | `test/performance/calendar-memory-first.spec.ts` |
| Rehydrate after invalidation never restores revoked authority | `test/plugins/google-calendar/connection-prepared.spec.ts` |

No relaxing provider counts, barrier assertions, authority freshness, or fixture command accounting to make these green. New failures route to P3 if introduced here; independent Calendar defects return to their owner.

- [ ] **Step 4 — Run package checks** separately, working directory `backend`:

```powershell
npm run build
npm run lint
npm test
npm run test:e2e
```

Do not run native MongoDB/Azure/service tests without operator-supplied isolated prerequisites/authorization. Do not install missing packages. Frontend build/lint/tests and browser presentation verification belong to P4/P5; note them unrun in the P3 handoff. Known P1 frontend mirror failures are pending P4, not reasons to weaken backend parity tests.

- [ ] **Step 5 — Commit final P3 corrections only** with explicit paths and return commit/test evidence. Check `git status --short`, `git diff --check`, and `git show --name-only --format=oneline HEAD` before reporting. Do not claim workflow completion; P4/P5 and final reports remain separate gates.

## Handoff and blockers

### P1/P2 contract changes

**None required by this design.** P3 owns its composite runtime/model/evidence types; P1 wire/tools/config and P2 `snapshot`/`validateInput`/`execute` contracts remain intact. If the committed P2 implementation cannot provide the specified secret-free synchronous snapshot, generation-fenced publication, tracked lifecycle shutdown, and issued validation tickets, stop the affected task and report the exact signature/behavior mismatch rather than changing its files.

### P2 compatibility blockers retained

- All five hosted providers remain **0/5 live-tested**. Fixture success is not hosted MCP/OAuth compatibility, account billing attribution, or latency certification.
- TinyFish hosted API-key authentication remains unsupported/unverified; browser auth is capability-gated.
- P2 production fetch capabilities remain **closed** until provider-side redirect/private-network protections are established by the separately authorized evidence it requires. P3 tests fetch using fixture-only trusted safety capability; do not enable production fetch or describe full browse/fetch AC4/AC9 as complete while that gate is closed.
- Cold account hydration does not itself establish an executable MCP session. Saved-enabled preference can survive restart while effective tool advertisement is temporarily absent until off-turn maintenance prepares a session.

### Admission/authentication boundary requiring honest reporting

The runtime tests prove zero database operations/discovery/connect/refresh **after trusted admission** for new and prepared sessions, in both text and voice. They also prove no save wait on continuations/next turns. Existing HTTP authentication's per-request DB read is outside P3 ownership; full arrival-to-model zero-DB acceptance remains a cross-owner blocker unless separately resolved. Cold selected history is an explicit pre-admission preparation step, never hidden inside a passing hot-path measurement.

### Return to orchestrator/P4/P5

Return:

1. Plan path, implementation commit set, exact owned paths changed, and any preserved user changes.
2. P2 constructor/export reconciliation; central composition, control-plane paths, shutdown promises, and model capability behavior.
3. Final request tool ordering; exactly3 web repair semantics; 5/5 accepted-turn counters; cancellation/late-discard behavior; source/activity/native linkage; same-turn retry and crash limitations.
4. Named text/voice fixture results with actual initial dispatch counters and actual held-archive evidence. Synthetic timing/waves separate from wall-clock measurements; no SLA claim.
5. Each executed command, discovery/pass/failure/skip counts, baseline comparison, unresolved blockers, and unrun live/native/frontend checks.
6. P4 consumes existing P1 events/fields only: `web-activity`, `web-sources`, terminal/replayed `webSources`/`webActivities`, live `web.frame`; provider fallback identity is activity metadata, not credentials or a provider picker.
7. Review **skipped**. P5 still owns integrated acceptance/operations/verification/final report.

## Planning self-check

- AC2/AC7: composition/preparation Tasks 6–7, off/unused/races Tasks 10–12.
- AC3: scanner/validation Tasks 2–3, shared loop Task 7, exactly3/no-replay Task 8.
- AC4/AC5: issued ticket/fallback boundary and turn budget Task 4, real P2 integration Tasks 6/12; production fetch blocker remains explicit.
- AC6: admitted text and voice instrumentation/actual held-archive Tasks 10–11; raw HTTP auth limitation not concealed.
- AC8: bounded context Task 5, linked terminal/history Task 9, partial/failure Task 12.
- AC9: control-plane identity/callback Task 6, unsafe-input classification Tasks 3–4, signal/revocation/voice Tasks 11–12.
- AC10: pure Calendar transport/body characterization Task 5 and all root-mandated regressions Task 13.
- AC11: actual command/commit/limitation handoff Task 13; final report remains P5, review skipped.
