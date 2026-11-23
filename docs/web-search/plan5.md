# Web Search Integrated Verification and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce reproducible, offline AC1–AC11 integration and latency evidence, an accurate operator runbook, and a final report without changing production source or claiming unsupported provider readiness.

**Architecture:** Exercise the existing AppService, real authentication/control-plane preparation, shared text/voice runtime, stock asynchronous archive, P2 MCP SDK transport, and P4 clients/renderers through deterministic boundaries. Reuse owner suites for exhaustive component cases; add only missing cross-boundary fixtures in dedicated P5 files. Keep synthetic dependency-wave measurements separate from observed test-process time, and route production defects to their original owners.

**Tech Stack:** Existing Node.js/TypeScript NodeNext backend, Nest/Express/Supertest, Vitest 4, BSON fake-driver/DependencyProbe fixtures, MCP SDK 1.32.2, React/Vite frontend, Node-environment client/reducer/SSR checks, and existing development-only browser-fixture conventions. No dependency additions.

---

## Authority, prerequisites, and non-negotiable reporting

- Sources inspected on 2026-11-14: [goal.md](goal.md), [research.md](research.md), [state.md](state.md), [plan1.md](plan1.md), [plan2.md](plan2.md), [plan2a.md](plan2a.md), [plan3.md](plan3.md), [plan4.md](plan4.md), and root [AGENTS.md](../../AGENTS.md), particularly **Tool execution critical path**.
- This is a **plan**, not executed application verification. P1, P2, P2A, and P4 completion/handoff evidence is recorded in `state.md`; P3 is still implementing at planning time. **P5 execution waits for verified P1/P2/P2A/P3/P4 worker commits, its own committed plan, and orchestrator assignment.** File existence and plan commits do not satisfy that worker gate.
- Use the available `executing-plans` and `test-driven-development` skills during execution. Load `systematic-debugging` on a failing check before proposing a correction. The mandatory header's `superpowers:` names do not authorize invented skills, additional delegation, or a reviewer. Unified review is **skipped**, never passed.
- P5 edits only its file map below. No `backend/src/**`, production frontend files, package/configuration files, Calendar fixtures, authentication source, or upstream tests. An upstream test defect also returns to its owner; do not silently weaken it.
- Preserve all unrelated work, including dirty `docs/web-search/state.md`, `.commandcode/`, `.openchamber/`, concurrent commits, and any new user changes. Planning entry status was modified `state.md` plus untracked `.commandcode/`. Recheck before every commit. The orchestrator alone updates `state.md`.
- No live MCP/OAuth/WorkOS/OpenRouter/Google/Deepgram/LiveKit requests, paid checks, infrastructure provisioning, application-data access, or deployment. Local Supertest/loopback fixture traffic is allowed; all provider fetches and DNS answers are deterministic and deny unknown destinations.
- Keep local backend imports `.js`; frontend imports follow the existing `.ts`/`.tsx` convention. Every new code/test/HTML file gets the repository FILE/LOCATION/PURPOSE/ROLE IN PROJECT/KEY COMPONENTS header using valid comment syntax. Test files are code files.

### Reconciled handoffs: actual implementation wins over stale plan prose

1. **P2:** compose `WebSearchConnections`, `WebSearchOAuth`, `WebSearchRuntime`, and `McpWebClient` once over the existing guarded persistence owner. The public execution seam remains `snapshot` → `validateInput` → `execute`; a validation failure has `'ok' in value`, an issued ticket has `'args' in value`. P3 owns turn counters, repair, SSE/voice, archival, private callback wiring, and off-turn preparation.
2. **P2A supersedes P3's historical auth exception.** `AuthService.authenticate()` must verify the session, read `auth.authority.snapshot()`, and call admission without `users.bySubject()`. Warm through actual `/api/auth/me` before measurement, not a direct principal injection or a no-op `prepareOwner`. P3 injects that **same** `auth.authority` into Administration and closes it synchronously at shutdown. P3's original “after trusted authentication” fixtures are insufficient for AC6.
3. **Authority ceilings:** 1,024 entries, 2,048 encoded bytes/snapshot, 15-minute validity, four warm reads. Cold, exactly expired, fenced, uncertain, capacity-unavailable, and closed authority fail `NOT_READY` without turn-path hydration. WorkOS session verification/possible SDK refresh remains separate from web discovery/connect/refresh counters.
4. **P4:** five cards, masked ephemeral key input, supported-only OAuth actions, global default-off account toggle, Config 5/5 controls, SSE/history/live `web.frame` presentation, and exact admin/voice mirrors are implemented. React SSR/state checks are not browser interaction or real backend integration evidence.
5. **Compatibility is limited, not green by default:** TinyFish API-key-over-hosted-MCP returns `WEB_AUTH_UNSUPPORTED` before a request. OAuth is fixture-only for all five providers. All five production `fetchSafety` values remain `unverified`; production fetch is closed. Successful synthetic fetches must say **fixture trust**, and must never change that source policy.
6. P2 reported full routine/e2e failures; P2A reported assembly auth wiring/deactivation failures pending P3 composition; P4's focused frontend/mirror results passed. Those are inherited reports, **not P5 reruns**. Compare actual failing names/commits before claiming any failure is pre-existing.

## File map and ownership

Create only files required by a missing cross-boundary assertion; do not duplicate a passing upstream suite merely to increase P5 counts.

| P5 action | Exact path | Responsibility |
| --- | --- | --- |
| Create | `backend/test/assembly/web-search-acceptance-fixture.ts` | One real AppService/AppModule/auth/runtime/archive assembly; provider-wire interception, all-storage guards, causal counters, explicit preparation |
| Create | `backend/test/assembly/web-search-acceptance.spec.ts` | Authenticated HTTP/setup/SSE, permission/schema/repair/fallback/linkage/security integration |
| Create | `backend/test/voice/web-search-acceptance.spec.ts` | Actual voice admission plus AgentVoiceAdapter/shared runtime, held archive and interruption |
| Create | `backend/test/performance/web-search-latency.spec.ts` | Payload-free boundary counts, synthetic waves, independent `performance.now()` observations |
| Create | `frontend/src/features/plugins/integration-tests/web-search-flow.test.ts` | Real client → fixture HTTP → setup reducer/render and SSE → chat reducer → source rendering |
| Create | `frontend/src/features/plugins/integration-tests/web-search-browser.html` | Development-only browser fixture entry, never a production navigation route |
| Create | `frontend/src/features/plugins/integration-tests/web-search-browser.tsx` | Actual component interactions with closed fixture clients, keyboard/layout/privacy checks |
| Create | `docs/web-search/verification.md` | Tested revisions, commands, AC rows, failures/owner routing, latency rows, compatibility/prerequisite ledger |
| Create | `docs/web-search/operations.md` | Delivered provider setup, rotation/OAuth, lifecycle, privacy, auth authority, shutdown/rollback |
| Create | `docs/web-search/final_report.md` | Outcome, actual worker/fix/tested commits, executed/skipped/unrun evidence and remaining gates |
| Modify narrowly | `README.md` | One Web Search paragraph/links and only directly conflicting feature wording |
| Planning only | `docs/web-search/plan5.md` | This plan; no other plan edits |

**Read-only reuse:** `backend/test/assembly/admin-config-fixture.ts`, `backend/test/persistence/calendar-multi-memory.ts`, `backend/test/performance/dependency-probe.ts`, `backend/test/performance/calendar-tool-latency-trace.ts`, `backend/test/plugins/web-search/{fixtures,mcp-fixture}.ts`, P3's `backend/test/runtime/web-search-fixture.ts` and assembly/voice suites once committed, frontend admin browser helpers and integration fixtures. A private function inside another spec is **not** an importable fixture; do not import a `.spec.ts`/`.test.ts` to run its tests indirectly.

## Exact integrated test matrix

Command IDs below expand to the exact commands in the following catalog. All routine rows require nonempty discovery, named assertions, and actual pass/fail/skip counts. New P5 spec cases use `[ACn]` in test names so an acceptance row can be located without guessing a regex.

| Criterion | Commands / fixture locations | Required assertions and acceptance boundary |
| --- | --- | --- |
| AC1 | F1, F2, B1, B2, BR1; P5 frontend flow/browser and P2 HTTP/MCP fixtures | Cards exactly TinyFish → Keenable → Exa → Tavily → Firecrawl; exact five console destinations and provider-specific instructions from goal; new-tab `noopener noreferrer`; masked inputs and connect/replace/disconnect; browser authorization only from real supported setup, not dashboard login. TinyFish unsupported and OAuth live-unrun remain visible. |
| AC2 | B1, B2, B4, F1, F2, BR1 | Default false; enable without connection 409; connect does not enable; account A setting applies to A text and voice, not B; reload/restart preserves saved preference subject to preparation; transient outage preserves preference; last-provider removal clears it; reconnect stays off; no composer control. |
| AC3 | B1, B3, F1 | Actual first/continuation model bodies add exactly one canonical `web_tool`, stable after Calendar definitions and across fallback; off/no eligible/non-tool model omits it. Strict browse/query vs fetch/url, malformed JSON/duplicates/prototype/mixed-batch rejection. Four invalid emissions yield **initial + exactly three additional model POSTs**, no fifth synthesis/repair, zero provider calls; prior successful calls never replay. Stale unauthorized calls fail closed. |
| AC4 | B1, B2 | Actual SDK initialize/list/call wires for ten provider/mode mappings; only exact fixed tools/endpoints; account's header credentials on every MCP method; no anonymous/keyless/REST or endpoint override; sequential fixed fallback, one attempt/provider/logical call, max five. TinyFish OAuth and successful fetch are explicitly synthetic; production admission remains gated. |
| AC5 | B1, B3, F1, F2, BR1 | Config defaults 5 searches/5 fetches; independent 1..20 edits; sixth call of either mode blocked; fallback consumes one logical call, not another allowance; config edit/retry/reconnect does not reset accepted-turn counters; next accepted turn captures new limits; shared repair/model/deadline/context bounds. |
| AC6 | B1, B4, B5, B6 | Real `/auth/me` control plane followed by real private HTTP submit **and SSE authentication** → actual `prepareOwner` → model fetch: zero application DB reads/writes/collection entry attempts, zero web discovery/connect/refresh/probes. Voice admission → actual shared model boundary likewise. Continuations and immediate next turns finish before actual held archive releases, with complete tool pairs/input once. Trusted-identity-only evidence cannot pass this row. |
| AC7 | B1, B2, B4, B5 | Web-off and enabled-unused text/voice make zero external web calls; incidental URLs are not fetched. Unprepared/stale/missing-token/outage cases do not prepare from the turn, block ordinary model dispatch, or trigger readiness probes. No readiness/liveness web network calls or provider-driven restart requirement. |
| AC8 | B1, B2, B3, B4, F1, F2, BR1 | Text SSE, completed/replay/history and live frames retain sourceId/toolCallId/provider/mode/turn/attempt linkage. Only HTTP(S) anchors. Truncation, partial success then failure, empty/unusable results, all-provider exhaustion and context/time/budget stops are honest; no fabricated URL or live-verification claim. Bounded tool groups, 15 sources, 40 latest activities, 24,000-byte evidence, no raw page archive. |
| AC9 | B1, B2, B4, B6, F1, F2, BR1 | Two-account isolation; encrypted/write-only credentials and AAD tamper checks; OAuth denial, exact expiry, state/session/browser/provider/callback binding and one consume/exchange; URL/public DNS/redirect/result safety and fetch gate. Injection stays tool evidence. Cancel/disable/disconnect/replace/logout/deactivate/voice interruption/shutdown fence future dispatch and discard late results. No charge-prevention promise. |
| AC10 | B6, C1–C4, F2, R1–R7 | Calendar required named checks below; existing text/voice/config/auth/model regressions and exact frontend mirrors. Production-route, archive, mutation-barrier, recovery, expiry/invalidation assertions preserved. Baseline reports distinguished from reproduced results; all new feature defects routed/resolved/retested or explicitly block acceptance. |
| AC11 | D1, R1–R7, N1 disposition, BR1 disposition; three P5 docs | Actual tested SHA/dirty inventory/environment/commands/counts/evidence paths, scoped latency observations, 0/5 live-tested, TinyFish/fetch/OAuth blockers, native/browser/service skips, auth limitations, review **skipped**, no production readiness or SLA certification. |

### Command catalog

Run each line separately in its stated working directory. Do not chain commands, use root npm scripts, install tooling, or substitute empty discovery for evidence.

**Backend (`backend/`):**

```powershell
# B1: P5 real assembled HTTP/setup/model/SSE acceptance
npm test -- test/assembly/web-search-acceptance.spec.ts --no-file-parallelism
# B2: P2 real SDK/provider, authorization, safety, connection and storage boundaries
npm test -- test/plugins/web-search/ test/persistence/web-search-connections.spec.ts src/platform/crypto/web-search-secret-cipher.spec.ts --no-file-parallelism
# B3: P1/P3 schema, counters, native groups, context, archive and coexistence
npm test -- src/contracts/web-search-policy.spec.ts src/contracts/web-search-wire.spec.ts src/contracts/web-search-tools.spec.ts test/model/web-native.spec.ts test/context/web-context.spec.ts test/runtime/web-search-runtime.spec.ts test/runtime/web-search-coexistence.spec.ts test/persistence/memory-web-records.spec.ts --no-file-parallelism
# B4: real voice integration and existing shared-runtime regressions
npm test -- test/voice/web-search-acceptance.spec.ts test/voice/web-search-voice.spec.ts test/performance/memory-first-voice.spec.ts test/runtime/calendar-memory-voice.spec.ts --no-file-parallelism
# B5: P5 observations, stock archive and P3 actual composition
npm test -- test/performance/web-search-latency.spec.ts test/assembly/web-search-composition.spec.ts test/http/web-search-boundary.spec.ts test/performance/memory-text-archive.spec.ts test/performance/memory-first-text.spec.ts --no-file-parallelism
# B6: real account authority, session/role boundaries and exact cross-package mirrors
npm test -- test/auth/ test/administration/ test/http/private-boundary.spec.ts test/assembly/auth-wiring.spec.ts test/assembly/auth-deactivation.spec.ts test/voice/transport/auth-upgrade.spec.ts src/contracts/admin-config.spec.ts src/contracts/voice.spec.ts --no-file-parallelism
# C1: required prepared routes, archives, barriers, W1-W4, duplicate, expiry, profiles
npm test -- test/performance/calendar-tool-latency.spec.ts --no-file-parallelism
# C2: cancel at dispatching CAS/after success plus existing memory authority
npm test -- test/performance/calendar-memory-first.spec.ts test/performance/memory-calendar-state.spec.ts --no-file-parallelism
# C3: prepared and invalidation authority plus production-route assembly/boundaries
npm test -- test/plugins/google-calendar/connection-prepared.spec.ts test/plugins/google-calendar/tools-boundaries.spec.ts test/assembly/calendar-assembly.spec.ts --no-file-parallelism
# C4: shared native transport and model/context/config regression
npm test -- test/model/calendar-adapter.spec.ts test/model/calendar-stream.spec.ts test/model/calendar-policy.spec.ts test/model/calendar-validation.spec.ts test/model/calendar-repair.spec.ts test/model/calendar-repair-flow.spec.ts test/model/strict-json.spec.ts test/model/catalogue.spec.ts src/contracts/config-runtime.spec.ts src/platform/config/manageable-config.spec.ts src/admin-config/admin-config.service.spec.ts --no-file-parallelism
# R1
npm run build
# R2
npm run lint
# R3
npm test
# R4
npm run test:e2e
# N1: isolated native check; separate prerequisite disposition, never automatic admission
npm test -- test/persistence/web-search-native.spec.ts --no-file-parallelism
```

**Frontend (`frontend/`):**

```powershell
# F1: P5 client/state/SSR integration
npm test -- src/features/plugins/integration-tests/web-search-flow.test.ts
# F2: existing P4 UI/wire plus chat/voice/config integration regressions
npm test -- src/api/web-search-protocol.test.ts src/api/web-search-client.test.ts src/api/protocol.test.ts src/api/client.test.ts src/api/voice-protocol.test.ts src/api/testing/voice-fixtures.test.ts src/features/plugins/web-search/ src/features/chat/state/web-search-chat-state.test.ts src/features/admin-config/ src/features/chat/integration-tests/ src/features/voice/integration-tests/ src/features/voice/state/live-voice-controller.test.ts src/features/voice/state/live-voice-reducer.test.ts src/components/Composer.test.ts src/components/MessageItem.test.ts src/components/VoiceTranscriptModal.test.ts src/App.assembly.test.ts
# R5
npm run build
# R6
npm run lint
# R7
npm test
# BR1: development-only closed DOM fixture; start only when browser inspection is available
npm run dev -- --host 127.0.0.1
```

BR1 URL: `http://127.0.0.1:5173/src/features/plugins/integration-tests/web-search-browser.html`. Record the actual Vite port if 5173 is unavailable. It must install all stubs **before** importing App/components and must not contact the backend proxy, vendors, microphone or live signaling. Existing Node Vitest discovery is not a browser runner; F1/F2 do not execute `.tsx` browser checks. Use an available approved browser surface or operator-opened page; if unavailable, mark BR1 **prerequisite-blocked**, never “passed by SSR.” No browser package installation or subagent dispatch is authorized by this plan.

## Evidence format and baseline protocol

Use these literal headings and table columns in `verification.md`; fill rows only from actual output:

```markdown
# Web Search — Integrated Verification
## Outcome and acceptance gates
## Tested revisions and preserved workspace
| Run ID | Tested HEAD | Dirty task paths | Other dirty paths | Worker/fix commits included |
## Environment and safety boundary
| Date | OS/shell | Node | npm | Backend Vitest | Frontend Vitest | Native prerequisites present | Browser available |
## Executed commands
| Run ID | CWD | Exact command | Disposition | Exit | Files pass/fail/skip | Tests pass/fail/skip | Worker errors | Evidence |
## AC1–AC11
| AC | Named tests/command IDs | Observed result | Disposition | Limitation/owner gate |
## Defects and owner reruns
| Defect ID | Reproducer/test | Expected | Actual | Owner | Classification evidence | Fix commit | Focused rerun | Broad rerun |
## Dispatch and latency observations
| Scenario | Prior turns | Mode | Boundary | Foreground DB reads/writes | Other-lane DB | Web initialize/list/connect/refresh/probe | Retrieval attempts | Model POSTs | Waves | Synthetic ms | Observed ms |
## Provider compatibility
| Provider | Documented key MCP | Fixture modes | Live MCP | Live OAuth/callback | Remote fetch safety | Admission limitation |
## Unrun and prerequisite-blocked checks
## Operations/document consistency
## Limitations and review skipped
```

Disposition vocabulary:

- **executed/pass**: command ran, expected tests discovered, required assertions passed.
- **executed/fail**: nonzero exit, assertion failure, worker crash/unhandled error, or incomplete test process. Never replace with “mostly passed.”
- **skipped**: runner explicitly skipped a discovered test (include reason/count), or unified review intentionally skipped by user instruction.
- **unrun**: command/drill was not invoked; say why, including lack of live authorization.
- **prerequisite-blocked**: required evidence cannot be attempted because an identified prerequisite is missing. If N1 is invoked and reports skips, record both the runner skips and the missing-prerequisite gate; do not count it as a native pass.

Preserve worker-reported evidence in a separate inherited-evidence table, not in P5 executed rows. Do not deduplicate aggregate test totals by adding overlapping command counts. Zero discovered tests is an evidence failure even if the process exits 0.

### Task 1: Freeze execution inputs and capture an honest baseline

**Files:** create `docs/web-search/verification.md` only.

- [ ] **Step 1 — Verify the worker gate.** Read current `state.md` handoffs. Inspect the known owner tips with `git show --stat 6371607 6b4ed9d 26b2caa e93d77c`; inspect P3's returned implementation commit after its handoff, not its plan commit. If P3 is incomplete or its real-auth/voice fixture contract is missing, report **prerequisite-blocked** and stop affected execution; do not “finish” P3 in P5.
- [ ] **Step 2 — Record revisions/workspace**, repository root:

```powershell
git status --short
git rev-parse HEAD
git log -20 --format="%h %s"
git diff --name-only
git diff --cached --name-only
```

Record the P1/P2/P2A/P3/P4 worker/fix commit lists from `state.md` and verify each is contained in the tested tree. Do not treat a contiguous range as solely feature commits: other workers have committed concurrently. Keep a per-owner explicit commit inventory.

- [ ] **Step 3 — Record versions** from each package and root; do not dump environment variables:

```powershell
node --version
npm --version
npm ls vitest
```

Use backend `npm ls @modelcontextprotocol/sdk zod` to verify installed pins without installing. Record only boolean presence of `AURVIN_TEST_MONGODB_URI` and whether prefix equals `aurvin_p2_test_`; never print values or read private `.env` files.

- [ ] **Step 4 — Isolate routine checks from service credentials.** Run routine tests in child PowerShell processes with `AURVIN_TEST_MONGODB_URI`, `AURVIN_TEST_DB_PREFIX`, `MONGODB_URI`, `OPENROUTER_API_KEY`, `WORKOS_API_KEY`, `GOOGLE_CLIENT_SECRET`, `LIVEKIT_API_SECRET`, and `DEEPGRAM_API_KEY` removed from that child's environment. Do not alter the user's persistent environment. Use the following wrapper, replacing only its final command with one catalog command per invocation:

```powershell
pwsh -NoProfile -Command {
  foreach ($name in @(
    'AURVIN_TEST_MONGODB_URI', 'AURVIN_TEST_DB_PREFIX', 'MONGODB_URI',
    'OPENROUTER_API_KEY', 'WORKOS_API_KEY', 'GOOGLE_CLIENT_SECRET',
    'LIVEKIT_API_SECRET', 'DEEPGRAM_API_KEY'
  )) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  npm test -- test/performance/calendar-tool-latency.spec.ts --no-file-parallelism
  exit $LASTEXITCODE
}
```

The child inherits its tool working directory (`backend` or `frontend`). Its tests must use explicit fixture bootstrap rather than load `.env`. Save logs only under `~/AppData/Local/Temp/opencode/`, with command/run IDs, not credentials/payload dumps. Console output and optionally Vitest `--reporter=default --reporter=json --outputFile=~/AppData/Local/Temp/opencode/web-search-P5-B1.json` provide runner counts; use a different run-specific filename for another command, and record exit immediately.

- [ ] **Step 5 — Baseline C1–C4, B6 and package R1–R7 before P5 test changes.** Build before suites that import `dist`. Run separately; record all failures/skips. Historical P2 totals and auth assembly failures may have changed after P3/P4; do not copy them as current.
- [ ] **Step 6 — Create the evidence headings above**, with initial rows marked unrun or prerequisite-blocked until executed. Include “Review: skipped by user instruction” and current compatibility gates. Commit only `verification.md` after serialized commit permission: `docs(web-search): record integrated verification baseline`.

## Fixture contract: real boundaries, not counting a mocked callback as dispatch

Use P3's committed fixture **if it exports the same real assembly needed here**. Otherwise build the small P5 fixture at the named path by reusing the source-backed seams below. Do not export private upstream test functions, copy the Calendar provider implementation, or create a second runtime.

### Required P5 fixture interface

The following test-only names are defined here, not assumed upstream exports. Add each method only when a corresponding acceptance test needs it.

```ts
type Boundary = {
  dbReads: number; dbWrites: number; storageEntries: number;
  initialize: number; list: number; connect: number; refresh: number;
  probes: number; retrieval: number; authReads: number;
};
type ModelStep = { text: string } | { id: string; name: string; raw: string };
type Hold = { entered: Promise<void>; release(): void };
// Return type of the P5 webAcceptanceFixture function:
type AcceptanceControls = {
  // The concrete fixture also returns app, service, persistence, db and provider
  // objects with their inferred existing types, never handwritten stand-ins.
  prepare(owner?: 'a' | 'b'): Promise<void>;
  connect(provider: 'keenable' | 'exa' | 'tavily' | 'firecrawl',
    owner?: 'a' | 'b'): Promise<void>;
  enable(enabled: boolean, owner?: 'a' | 'b'): Promise<void>;
  queue(...steps: ModelStep[]): void;
  turn(content: string, sessionId?: string, owner?: 'a' | 'b'):
    Promise<{ sessionId: string; turnId: string; attemptId: string; stream: string }>;
  boundary(): Boundary;
  beforeModel: Boundary[];
  bodies: Record<string, unknown>[];
  heldArchive(): Hold;
  guardForegroundStorage(): { attempts(): number; restore(): void };
  close(): Promise<void>;
};
```

### Assembly construction and instrumentation recipe

These are verification steps, not permission to modify the production constructors:

1. Create `calendarMemory` and a fake `MongoClient` using its `commandSource` plus `db: () => db.store.db`, `appendMetadata: () => undefined`, and fixture-only `close`. Call real `createPersistenceBundle` once. Seed `admittedAccount()` for A and `admittedAccount({userId:'u2',workosUserId:'workos_u2',emailNormalized:'b@example.com',currentWorkosSessionId:'sid_2'})` for B through `persistence.users.insert` **before measurement**. The existing provider fixture returns A for `sealed_1`; configure its `read` mock to return `{workosUserId:'workos_u2',sessionId:'sid_2'}` for `sealed_2` and reject other cookies. Convenience methods use `aurvin_wos_session=sealed_1` or `sealed_2` respectively. Do not seed a second auth-only repository that escapes storage instrumentation.
2. Reuse `assemblyFixture(document(1))`, `CredentialService`/`CredentialValidator`, fixture assets, and `providerFixture` from the existing paths. Seed a fixture OpenRouter credential and model `fixture/model`; use `ports.open` to return the real bundle plus one close callback and `ports.runtime` to construct one real `DurableChatRuntime`. Enable top-level `modelLimits.tools:true`; run a second case with real Calendar native capability using existing `calendarLimits`. Do not equate Calendar tools support with web eligibility.
3. Intercept `ports.fetcher`. Exact OpenRouter `/api/v1/chat/completions` receives queued SSE; record the parsed body and a **synchronous boundary snapshot at entry**, before yielding any frame. Reuse `nativeFrame` for tool chunks, `chunk`/`done` for text, with a distinct generation ID per model request. Fixed MCP endpoints route to the actual `mcpFixture` request handler with provider-shaped results. Unknown URLs/methods throw; there is no original/global-fetch escape.
4. Instantiate real `AppService.create` over those ports; mount actual `AppModule` through Nest Test provider overrides and call real `configureApplication(app)` before `app.init()`, as in `backend/test/assembly/auth-wiring.spec.ts`. Install an instrumentation-only middleware **before** `configureApplication` to enter `trace.scope.run({lane:'foreground',attemptId:null}, next)` for measured `/api/sessions` requests; other HTTP control-plane requests enter `setup`. Do not assume AsyncLocalStorage survives the Supertest socket boundary from the caller. The middleware tags work only; it never supplies identity, authorization, preparation or responses. Never replace `configurePrivateHttp`, `prepareOwner`, `authenticate`, `admitAccount`, the runtime, WebSearchPort or archive with success callbacks for acceptance proof.
5. `prepare()` performs authenticated **GET `/api/auth/me`** with the fixture cookie, GET plugin status and selected-history preparation as needed, all before a measured turn. Await explicit web setup/background preparation completion, not a sleep. `connect()` calls actual private POST connect; `enable()` calls actual PATCH settings using current public revision. Setup is allowed durable/network fixture work and is measured separately.
6. `turn()` uses actual POST `/api/sessions` for the first message or POST `/api/sessions/:id/turns` for subsequent messages, with origin/cookie/idempotency key but no identity/provider/model overrides, then GET the returned `/api` stream path using the same cookie. It does not call `runtime.executeTurn` directly. Assert HTTP 202/stream 200 before interpreting output.
7. All storage instrumentation includes `owner.store`, `owner.controlStore` (deduplicate identical objects), raw `db.collection`/`db.command`, every returned collection/cursor method, and checkpoint access through the fake client. Also instrument injected non-driver repository boundaries: the reused assembly fixture's `repository.read`, `createIfAbsent`, `compareAndSwap`, and any fake account/personalization/connection repository retained from P3. An in-memory fixture implementation of a production storage port is still a storage operation; it cannot escape the count because no driver command exists. Count collection-entry **attempts**, including operations that throw before producing driver commands. Count driver `commandStarted` reads/writes independently and compare to `db.calls`. Auth, settings/config/personalization, sessions/messages, web connections, Calendar, ownership, metadata, checkpoints/writes must all be visible.
8. Reuse `CalendarToolTrace.scope` for `foreground`, `archive`, `setup`, `recovery` causal lanes without editing it. Wrap actual stock saver invocation in the archive lane, retaining its real returned promise and bytes/commands; do not replace it with an ACK stub. Raw unclassified commands remain visible and fail a zero-foreground claim until attributed. Never dismiss an unexplained command as background.
9. `heldArchive()` uses the real fake driver's `pauseNextUpdate()` and the stock saver: return `entered = paused.started`, `release = paused.resume`. Choose a turn that actually starts an archive write; assert that it owns a real pending persistence operation before testing continuation. A Promise placed before save entry alone is not “actual archive ownership.”
10. `guardForegroundStorage()` throws/counts on **all** application-storage entry points in the foreground lane; it must allow the already-held archive lane to remain held. Install after setup and before HTTP submit/voice admission. Enter the foreground trace scope explicitly around the actual voice admission and finalized-speech calls, since those bypass HTTP instrumentation middleware. Boundary snapshots include DB attempts/commands since that measurement start. Capture counters from both submit and SSE authentication; never reset between them.
11. `connect` is also observed at real `McpWebClient.prepare`, not only counted from `initialize`; refresh at the actual OAuth HTTP refresh boundary; discovery includes OAuth metadata/DCR and MCP `tools/list`; probes include setup validation `tools/call`. Counts distinguish retrieval from explicit setup probes. Track `providerFixture.read` separately as `authReads`; do not turn off WorkOS verification to obtain zeros.
12. Intercept DNS through a test-scoped spy on `node:dns/promises.lookup` returning public fixture addresses, with call counting. Never resolve arbitrary real page hosts or perform local page HTTP requests. Restore all spies in `finally`; release holds before closing AppService/app; assert one persistence close and no late provider/model calls.

Use the following complete test-local guard pattern for shared RecordStore objects; extend at raw-driver/collection/cursor entry points listed above, not just this one method:

```ts
const stores = [...new Set([
  persistence.owner.store, persistence.owner.controlStore,
].filter(value => value !== undefined))];
let attempts = 0;
const guards = stores.map(store => {
  const original = store.collection.bind(store);
  return vi.spyOn(store, 'collection').mockImplementation(name => {
    if (trace.scope.getStore()?.lane === 'foreground') {
      attempts++;
      throw new Error('fixture blocked foreground application storage');
    }
    return original(name);
  });
});
// finally:
for (const guard of guards) guard.mockRestore();
```

Do not assume `Object.keys(repository)` sees prototype methods: use real RecordStore/raw-driver guards and command observation. Include a negative-control check that a deliberately invoked foreground `users.bySubject()` increments the guard and throws, then start a new measurement after restoring valid setup. A zero counter without a live guard is not evidence.

### Task 2: Add real HTTP-auth-to-model and held-archive integration

**Files:** create `backend/test/assembly/web-search-acceptance-fixture.ts` and `backend/test/assembly/web-search-acceptance.spec.ts`.

- [ ] **Step 1 — Add the first failing acceptance test**, after required headers. Create only the test first and run Step 2 to observe the missing fixture module. Then implement `webAcceptanceFixture` in the named fixture file with the interface/recipe above; its imported construction seams must remain real. Do not commit a stub or an unimplemented method.

```ts
import { expect, it } from 'vitest';
import { WEB_TOOL_DEFINITION } from '../../src/contracts/web-search-tools.js';
import { webAcceptanceFixture } from './web-search-acceptance-fixture.js';

it('[AC6] real HTTP auth and SSE dispatch with all foreground application storage blocked', async () => {
  const f = await webAcceptanceFixture();
  let guard: ReturnType<typeof f.guardForegroundStorage> | undefined;
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    f.queue({ id: 'web_a', name: 'web_tool', raw: '{"mode":"browse","query":"public evidence"}' },
      { text: 'A bounded grounded answer.' });
    guard = f.guardForegroundStorage();
    const result = await f.turn('Search public evidence');
    expect(f.beforeModel).toHaveLength(2);
    expect(f.beforeModel[0]).toMatchObject({
      dbReads: 0, dbWrites: 0, storageEntries: 0,
      initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0, retrieval: 0,
    });
    for (const boundary of f.beforeModel) {
      expect(boundary).toMatchObject({ dbReads: 0, dbWrites: 0, storageEntries: 0 });
      expect(boundary.authReads).toBeGreaterThanOrEqual(2);
    }
    expect(f.bodies[0].tools).toContainEqual(WEB_TOOL_DEFINITION);
    expect(f.bodies.every(body => body.user === 'u1')).toBe(true);
    expect(result.stream).toContain('web-sources');
    expect(guard.attempts()).toBe(0);
  } finally { guard?.restore(); await f.close(); }
});
```

`webAcceptanceFixture()` defaults A to existing `admittedAccount()` (`userId:'u1'`); never inherit a trusted hardcoded development identity. `beforeModel`/guard counters reset once after setup when guarding starts, not on each dispatch.

- [ ] **Step 2 — Run RED**, `backend`: `npm test -- test/assembly/web-search-acceptance.spec.ts -t "real HTTP auth" --no-file-parallelism`. Expected initially: missing fixture/unfinished test helper. Once fixture is implemented, a production path violation must fail with its counted entry, not hang on an unbounded storage promise.
- [ ] **Step 3 — Complete only test-fixture wiring** using the recipe, one small construction seam at a time: fake driver/bundle → fixture accounts/config → closed model/MCP fetch → real AppService/module → actual auth/setup requests → foreground/driver instrumentation. Run the Step 2 command after each seam, distinguishing missing fixture support from a product assertion failure. Do not patch production source to pass. Prove the storage negative control trips; then run Step 2 GREEN. A genuine production failure goes to the routing table below with the exact command/call stack.
- [ ] **Step 4 — Add held-archive continuation and immediate follow-up** with this assertion sequence:

```ts
it('[AC6] HTTP continuation and immediate next turn finish while an actual archive is held', async () => {
  const f = await webAcceptanceFixture();
  let hold: ReturnType<typeof f.heldArchive> | undefined;
  try {
    await f.prepare(); await f.connect('exa'); await f.enable(true);
    hold = f.heldArchive();
    f.queue({ text: 'Seed answer.' });
    const first = await f.turn('Seed');
    await hold.entered;
    f.queue({ id: 'web_b', name: 'web_tool', raw: '{"mode":"browse","query":"current facts"}' },
      { text: 'Grounded follow-up.' }, { text: 'Immediate next answer.' });
    const second = await f.turn('Search current facts', first.sessionId);
    const third = await f.turn('Continue', first.sessionId);
    expect(second.stream).toContain('completed');
    expect(third.stream).toContain('completed');
    expect(f.beforeModel.slice(-3)).toHaveLength(3);
    for (const row of f.beforeModel.slice(-3)) {
      expect(row).toMatchObject({ dbReads: 0, dbWrites: 0, storageEntries: 0,
        initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0 });
    }
  } finally { hold?.release(); await f.close(); }
});
```

For this case reset foreground deltas at each HTTP-turn start but keep archive state and total other-lane counters intact. Also assert pending archive remains unresolved **before** releasing it; after release, stock archive order/versions converge without extra model/MCP calls. Check every continuation has the accepted input once and native assistant/tool pairs adjacent with matching IDs. Reuse P3 archival tests for sealed-result reload and interrupted-unsealed recovery; do not claim this held-write case alone proves crash recovery.

- [ ] **Step 5 — Add parameterized cases**, one small test per row:

| Test name suffix | Setup/action | Exact expected check |
| --- | --- | --- |
| `[AC6] prepared selected history` | Save one real turn, prepare selected history via GET before measurement, then guard and submit | Prior input/assistant each once, new input once; zero foreground storage before model |
| `[AC6] cold web owner ordinary chat` | Auth warm, web map cold; submit ordinary text | Model proceeds without web schema, zero turn-triggered warm/connect/list/refresh |
| `[AC9] cold expired fenced uncertain closed auth` | Separate fixture for each authority state, block storage, submit | 503 `NOT_READY`, no model/MCP call or lookup fallback; retryable cookie preserved |
| `[AC9] real admin deactivation shares authority` | Prepare A/admin; deactivate through actual Administration route; next private request with storage blocked | Same AuthService authority denies A; no second map; pending login/warm cannot restore it |
| `[AC7] off and unused` | Connected-off and enabled-unused ordinary answers, including incidental public URL | Zero total external web requests during measured turn; off schema absent, unused schema present once |
| `[AC7] stale provider and readiness` | Prepared account with expired token/missing session/service outage | Ordinary answer dispatches without preparation; repeated ready/live zero web calls, no new restart behavior |
| `[AC2] account lifecycle` | Connect/enable A, leave B off; reload status; remove last provider and reconnect | A-only text/voice enablement, saved preference semantics, reconnect false |

Do not backdate authority with a Date clock while its implementation uses `performance.now()`: use P2A's internal clock seam or fake only the authority clock; keep performance observations on a separate monotonic clock.

- [ ] **Step 6 — Run B1/B5/B6**. Record actual names/counts. Commit only the two P5 assembly files with `test(web-search): verify authenticated HTTP and nonblocking archives`.

### Task 3: Integrate schema repair, fixed MCP fallback, limits, safety and sources

**Files:** extend the same P5 assembly fixture/spec only. Exhaustive P2/P3 suites remain read-only.

- [ ] **Step 1 — Add exact exhaustion test** using the implemented fixture:

```ts
it('[AC3] four invalid emissions allow exactly three additional attempts and no provider call', async () => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare(); await f.connect('exa'); await f.enable(true);
    f.guardForegroundStorage();
    f.queue(...Array.from({ length: 4 }, (_, index) => ({
      id: `invalid_${index}`, name: 'web_tool', raw: '{"mode":"browse"}',
    })));
    const result = await f.turn('Search now');
    expect(f.bodies).toHaveLength(4);
    expect(f.boundary().retrieval).toBe(0);
    for (const body of f.bodies.slice(1)) {
      expect(body.tools).toContainEqual(WEB_TOOL_DEFINITION);
      const feedback = (body.messages as Array<{ content?: string }>)
        .flatMap(message => {
          try {
            const value = JSON.parse(message.content ?? '') as Record<string, unknown>;
            return value.code === 'WEB_SCHEMA_INVALID' ? [value] : [];
          } catch { return []; }
        });
      expect(feedback.at(-1)?.expectedSchema).toEqual(WEB_TOOL_DEFINITION.function.parameters);
    }
    expect(result.stream).toContain("couldn't verify");
  } finally { await f.close(); }
});
```

The fixture's `close()` restores its own guards. Keep canonical feedback unchanged, no provider secret/raw invalid value in diagnostics. Do not use a fifth “synthesis” model response in the fixture queue.

- [ ] **Step 2 — Run** `npm test -- test/assembly/web-search-acceptance.spec.ts -t "four invalid" --no-file-parallelism`. A passing initial production path needs no artificial source mutation to manufacture RED. To validate the new oracle, locally alter only the fixture queue/expected count (e.g. expect five bodies), observe that assertion fail, then restore the correct assertion. Record this as **test-oracle negative control**, not a pre-fix product defect.
- [ ] **Step 3 — Add corrected-call/no-replay case:** valid call A → invalid B → corrected B → answer. Assert A's actual MCP `tools/call` count is one, B's is one, invalid B consumes zero browse/fetch budget, full schema reappears, original successful native group is unchanged, and each actual model POST has server `user` attribution.
- [ ] **Step 4 — Run B2/B3 and add cross-boundary rows** only where their upstream proof does not reach the assembled model/HTTP surface:

| Named P5 case | Required assertions |
| --- | --- |
| `[AC3] one conditional schema` | Calendar-capable and web-only-capable models; exact canonical definition once; absent for off/no eligible/no tools; provider catalogs never appear |
| `[AC3] repair budget spans modes and iterations` | Two browse repairs then one fetch repair; next invalid seals, same-turn retry retains counters; no provider before a valid ticket |
| `[AC3] non-schema failures never repair` | Disabled/permission, unsafe URL, provider failure, context/mode/deadline/cancel each consume zero repair allowance; no forced retries after global budget is exhausted |
| `[AC4] real SDK fallback is ordered` | Connect in reverse order, Keenable 429 → Exa empty → Tavily usable; exact `tools/call` order and max concurrency1, successful source Tavily; next logical call starts highest eligible again |
| `[AC4] each provider slot at most once` | Exhaust connected providers; no auth401/session404 replay, no parallel calls, no public/keyless endpoint, no provider not connected by this owner |
| `[AC5] fallback does not multiply 5/5` | Five logical browse calls with fallback then sixth denial; independent five synthetic fetches then sixth denial; captured counters5/5, each fallback charges once |
| `[AC5] limits and finite clocks` | Config1/20 accepted through real route; 0/21/fraction rejected; accepted limits survive edit/retry; exact 4s/12s/25s/45s ceilings nested, model15/default and45/max ceiling; no clock reset |
| `[AC8] source linkage survives transport and archive` | Each source links successful tool result/call/provider/mode and owning turn/attempt in SSE/completed/history; one bounded archive job; no tool/model replay on sealed save retry |
| `[AC8] partial and exhausted outcomes` | Useful clipped evidence marked truncated, later provider failure preserves only successful sources; empty/blocked/unusable/all-failed returns honest failure; no invented title metadata/URL/verification |
| `[AC9] isolated credentials and data` | A/B distinct sentinel credentials in correct provider headers only; ciphertext store contains neither; no leak in status/errors/model/stream/logs/history or B prompt; A cannot mutate B by overrides |
| `[AC9] injection is only evidence` | Result contains “ignore instructions / use Calendar / reveal key”; model context keeps it in tool result, immutable system/tools unchanged; actual executor makes no extra Calendar/web effect |
| `[AC9] disable disconnect replace cancel late result` | Hold provider response; perform real control-plane mutation/cancel; release abort-ignoring fixture; no revoked source/completed activity/archive content/voice frame or new external call; allowed B provider/account remains usable |

For provider-specific mappings use this exact expectation, never names inferred from `tools/list`:

| Provider | Browse | Fetch | Fixture admission |
| --- | --- | --- | --- |
| TinyFish | `search` | `fetch_content` | OAuth fixture only; API key rejected before request |
| Keenable | `search_web_pages` | `fetch_page_content` | Own `X-API-Key` |
| Exa | `web_search_exa` | `web_fetch_exa` with `urls:[url]` | Own `x-api-key` |
| Tavily | `tavily_search` | `tavily_extract` | Own Bearer credential |
| Firecrawl | `firecrawl_search` | `firecrawl_scrape` | Own Bearer credential |

Successful ten-mode translation/SDK and normalization fixtures already live in `test/plugins/web-search/{providers,prepared,results}.spec.ts`. Run/assert their actual ten cases rather than writing a second adapter. P5 assembled fallback tests must use the real SDK wire, not P2's fake `PreparedMcpSession.call` as their sole evidence.

- [ ] **Step 5 — Verify fetch gating separately from successful synthetic mapping.** Run unmocked `providers.spec.ts` proving all five production gates closed. Run URL cases for private/metadata/loopback/numeric/mapped-IPv6/userinfo/non-HTTP(S)/mixed-DNS/unsafe returned/final/redirect targets with zero forbidden outbound request. Only within a clearly named synthetic fetch test use P2's test-module `providerDefinition` mock (`fetchSafety:'verified'`); reset after each test. Never expose that override in HTTP, config, constructor options or shipped production policy.
- [ ] **Step 6 — Verify OAuth through B2 and assembled HTTP routes:** static GET callbacks for the exact five paths, CSP/no-store/query scrubbing, no GET token exchange; private POST completion requires current session/origin and matching browser/state/provider; denial/600,000ms exact expiry/callback mismatch/replay/uncertain consume ACK make zero exchange POSTs. Test callback success reaches P4's actual return convention without assuming P4's older illustrative redirect snippet. Missing provider identity or losing an outcome is a P2/P3/P4 integration defect, not permission for P5 to redesign OAuth.
- [ ] **Step 7 — Run B1–B3/B6**, record compatibility gates explicitly, and commit P5 test/fixture changes only: `test(web-search): cover integrated repair fallback and safety`.

### Task 4: Voice admission, shared execution, interruption and late discard

**Files:** create `backend/test/voice/web-search-acceptance.spec.ts`; extend only P5 fixture when shared controls are needed.

- [ ] **Step 1 — Reuse P3's committed voice fixture if it is an exported helper**, not a function private to `web-search-voice.spec.ts`. Otherwise reproduce only the attach/finalized test wiring from `backend/test/performance/memory-first-voice.spec.ts` over P5's existing AppService/runtime. Use `Parameters<AgentVoiceAdapter['attach']>[0]`, real reservations, `VoiceDelivery`, deterministic sink/TTS, and existing bindConversation callback; no alternate voice inference runtime.
- [ ] **Step 2 — Establish the authentication boundary before capturing a principal.** Prepare through actual `/api/auth/me`, then guard storage. Exercise real `service.voiceUpgrades.verify(req)`/`takePrincipal(req)` as shown below, keeping actual origin/Host/peer checks. This tests the shared WS admission object; live WebRTC media/signaling remain unrun. Also exercise the production authenticated voice-session REST path with the same AuthService in P3's suite.

```ts
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

const socket = new Socket();
Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
const req = new IncomingMessage(socket);
req.url = '/api/voice';
req.headers = {
  host: '127.0.0.1:3000', origin: f.service.bootstrap.frontendOrigin,
  cookie: 'aurvin_wos_session=sealed_1',
};
req.rawHeaders = [
  'Host', '127.0.0.1:3000', 'Origin', f.service.bootstrap.frontendOrigin,
  'Cookie', 'aurvin_wos_session=sealed_1',
];
await f.service.voiceUpgrades.verify(req);
const principal = f.service.voiceUpgrades.takePrincipal(req);
expect(principal.identity.userId).toBe('u1');
socket.destroy();
```

Do not mock `authenticate` or attach an independently constructed `AuthPrincipal`. Assert the second `takePrincipal` is denied; test missing/wrong cookie and cold/expired/fenced authority with no DB/model/provider call.

- [ ] **Step 3 — Drive `bridge.finalized(context, { providerSocketEpoch:1, providerTurnId:'web-voice-1', text:'Search public evidence' }, signal)`**, where `context.identity` is the admitted principal above and the reservation belongs to the same user/runtime. Queue one web call then narration. Inspect real model-entry boundary counters, not `flow.modelStarted` alone.
- [ ] **Step 4 — Add these named test cases before fixture support for each**, and run `npm test -- test/voice/web-search-acceptance.spec.ts --no-file-parallelism` after each:
  - `[AC6] real voice admission to shared model has zero pre-model application storage and web preparation`: zero reads/writes/entries and discovery/connect/refresh; session verification occurs; same runtime count1.
  - `[AC8] bound live frames preserve sources without speaking activity`: validate every `web.frame` with P1 voice guard; matching turn/attempt/response/epoch, successful provider/call IDs; TTS contains narration only; dictation rejects web frames.
  - `[AC6] voice next turn finishes before actual archive releases`: stock saver held at driver update; first narration settles using real heard evidence; second finalized speech dispatches/completes before release with zero foreground storage.
  - `[AC7] off unused and incidental URL voice has no web calls`: same zero-request/schema distinctions as text; no second model runtime or readiness probe.
  - `[AC9] barge-in during provider call discards late result`: caller abort/cancelLiveTurn, no next provider/model dispatch, no late source/frame/context; terminal interrupted/cancelled remains honest.
  - `[AC9] disconnect disable and epoch replacement fence voice`: real plugin disable/disconnect and socket/response replacement; abort-ignoring late response cannot attach to a new responseId; B account unaffected.
  - `[AC9] new admission after local revoke fails closed`: new verify/REST admission denied; explicitly **do not** assert an already captured WebSocket principal is automatically reauthenticated.
- [ ] **Step 5 — Run B4 plus B1/B6**, route production failures, and commit only this voice spec and actually changed P5 fixture: `test(web-search): verify authenticated voice and interruption`.

### Task 5: Frontend client/state/render and closed browser flows

**Files:** create `frontend/src/features/plugins/integration-tests/web-search-flow.test.ts`, `web-search-browser.html`, `web-search-browser.tsx`.

- [ ] **Step 1 — Write a Node integration test using actual client → reducer → markup**, following `multi-calendar-settings.test.ts`. This exact initial test adds no DOM framework:

```ts
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { createWebSearchClient } from '../../../api/web-search-client.ts';
import { WEB_SEARCH_PROVIDERS, type WebSearchPublicStatus } from '../../../api/web-search-protocol.ts';
import { WebSearchPanel } from '../web-search/WebSearchPanel.tsx';
import { createInitialWebSearchSetupState, webSearchSetupReducer } from '../web-search/web-search-setup-state.ts';

it('[AC1][AC2] client status renders five exact destinations without enabling on connect', async () => {
  const status: WebSearchPublicStatus = {
    protocolVersion: 1, revision: 1, enabled: false, effectiveEnabled: false,
    providers: WEB_SEARCH_PROVIDERS.map(provider => ({
      provider, state: 'not-connected', authMethod: null,
      authSupport: { apiKey: 'unverified', browserAuthorization: 'unverified' },
      capabilities: { browse: false, fetch: false }, lastValidatedAt: null,
    })),
  };
  const fetcher = vi.fn<typeof fetch>(async input => {
    expect(String(input)).toBe('/api/plugins/web-search/status');
    return Response.json(status);
  });
  const client = createWebSearchClient({ fetch: fetcher });
  const parsed = await client.status();
  const state = webSearchSetupReducer(createInitialWebSearchSetupState(), {
    type: 'loaded', requestId: 1, status: parsed,
  });
  const html = renderToStaticMarkup(createElement(WebSearchPanel, { client, initialStatus: state.status! }));
  const names = ['TinyFish', 'Keenable', 'Exa', 'Tavily', 'Firecrawl'];
  const positions = names.map(name => html.indexOf(name));
  expect(positions.every(index => index >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  for (const url of [
    'https://agent.tinyfish.ai/api-keys', 'https://app.keenable.ai/',
    'https://dashboard.exa.ai/api-keys', 'https://app.tavily.com/home',
    'https://www.firecrawl.dev/app/api-keys',
  ]) expect(html).toContain(`href="${url}"`);
  expect(html).toContain('type="password"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(state.status?.enabled).toBe(false);
  expect(html).not.toContain('Connect Exa account');
});
```

The name includes the connect invariant; extend this test with an actual `client.connectProvider` response and reducer transition before claiming that portion passed. Assert a key save response has connected browse true/fetch false yet enabled false, and no candidate retained in state/render.

- [ ] **Step 2 — Run F1.** If exact console URLs/instructions differ from the goal, report P4 defect with this failing assertion; do not relax to generic origin substrings. Key text must preserve TinyFish shown-once/Create API Key, Keenable copy-before-dialog-close, Exa API Keys, Tavily dashboard, Firecrawl existing default key instructions, and disclose unsupported paths without inventing button names.
- [ ] **Step 3 — Extend F1 with client/SSE cross-boundary checks**:
  - Fixture HTTP mutations record exact protocolVersion/revision/body and use actual `WebSearchClient`; connect/replace/disconnect/last removal/conflict/uncertain states pass through actual reducer. Failed replacement keeps old confirmed status; no browser key persistence/reveal.
  - Use actual `ApiClient.connectTurnStream` on chunked `ReadableStream` SSE as in `client-lifecycle.test.ts`; parse `web-activity`, `web-sources`, completed into actual chat reducer `WEB_ACTIVITY`/`WEB_SOURCES`/`STREAM_COMPLETED`. Render final assistant via `MessageItem` or shared `WebSearchActivityView`; only provided HTTP(S) links, correct call/provider, unsafe source dropped/rejected, no stale session/turn/attempt/sequence acceptance.
  - Partial/failure/cancel events render honest status with no invented source. Completed/replayed/history projections agree. Stream navigation does not resubmit or cancel merely because Plugins opens.
  - Run P4 live-controller/reducer/integration suites in F2 for actual `web.frame`/cancelled/retired response/epoch fencing; do not bypass controller checks by testing reducer alone.
  - Config defaults5/5, independent limits1..20 and no composer control are checked through F2 plus browser interaction.
- [ ] **Step 4 — Create the development-only browser entry** with HTML comment header, root, results/status regions and module script `./web-search-browser.tsx`. Import `act` from `react`, `createRoot` from `react-dom/client`, and reuse `check`, `typeInput`, `press` from existing `frontend/src/features/admin-config/testing/browser-checks.ts`; `createFixtureApi` from `frontend/src/features/auth/integration-tests/fixture-api.ts` supplies closed auth/base App responses. Wrap only explicit web routes locally; unknown URLs never reach native fetch. Mount the real `WebSearchPanel` with `onNavigateUrl` captured for synthetic OAuth-action checks; actual App navigation is a separate mount using the same closed API. Do not invent an App-level navigation prop that P4 does not export.
- [ ] **Step 5 — Install browser guards before dynamic App import.** Require `import.meta.env.DEV`; deny non-same-origin fetch, XMLHttpRequest, `sendBeacon`, WebSocket/media/provider navigation except a captured `onNavigateUrl` callback. Keep Vite development module/HMR traffic distinct from application requests. Intercept `Storage.prototype.setItem` and console output; never store the candidate even in fixture request evidence. Capture only method/path and `candidatePresent:boolean`, not plaintext request bodies.
- [ ] **Step 6 — Execute this exact BR1 checklist**, recording each named assertion in `#fixture-checks`, total pass/fail, unexpected network count and media count in `#fixture-status`:

| Browser check | Required observation |
| --- | --- |
| Plugins navigation / role | A normal User opens Web Search without admin config read; admin sees Config Web Search; no composer toggle |
| Five cards / instructions / destinations | Exact order/URLs/instructions above; native labels; official console anchors target blank with safe rel |
| Default-off connect | Toggle initially disabled/off, connect requires explicit action, input password, pending announced; connected result still off |
| Key replace / failed replace / disconnect | Candidate cleared after submit/cancel, no saved redisplay; rejected replacement retains old connection; confirmation removes last provider and explains off; reconnect remains off |
| Account-wide setting / reload | Explicit enable controls fixture text/voice permission; remount/reload saved status appropriate; account B remains off |
| OAuth unsupported / supported fixture | Unverified/unsupported not shown as completed support; supported fixture starts captured authorization URL; denial/expiry returns honest state; no external browser navigation or live exchange |
| Config limits | Defaults5/5, independent edits1 and20, invalid0/21/fraction not saved; field errors accessible |
| Text source/activity | Searching/fallback/completed/failed/partial activity from SSE; exact successful HTTP(S) anchor, not invented verification; malicious scheme never clickable |
| Draft/stream continuity | Manage Aurvin navigation preserves composer draft and live stream, no duplicate submit |
| Keyboard / focus / small screen | Label-associated input, Tab-accessible buttons, visible focus, disconnect dialog Escape/return focus, status announcements; no horizontal overflow at 390px and1280px |
| Privacy / passive voice | No key/token in DOM text/serialized saved status/storage/cookies/logs; zero unexpected outbound/media, no voice connection on navigation |

Masked candidate typing is intentional transient input; do not falsely label its presence in the editable password input as a saved-secret leak. After submit/unmount/reload, the value must be empty and unrecoverable from saved state. Browser output contains only assertion names/counters, not sentinels.

- [ ] **Step 7 — Run F1/F2 and BR1 if available**. A DOM failure goes to P4; a backend callback mismatch goes jointly to P2/P3/P4. Record browser/tool/version/viewport and exact results; absent browser is prerequisite-blocked, not an excuse to install Playwright/jsdom. Run frontend build/lint; commit the three P5 fixture files only with `test(web-search): cover integrated plugin and browser flows`.

### Task 6: Measure dispatch boundaries without inventing a latency SLA

**Files:** create `backend/test/performance/web-search-latency.spec.ts`; extend P5 assembly fixture for observations only.

- [ ] **Step 1 — Use existing `DependencyProbe('wave')` and `calendarMemory(probe)`**, plus read-only `CalendarToolTrace` for command starts/completions and causal lanes. Drive setup outside the measured interval. Drive fixture work with `probe.drive` and existing bounded microtask/immediate handling; no real sleeps as ordering proof. If the helper cannot advance HTTP work safely, keep ordinary B1 measurements and mark synthetic profile prerequisite-blocked rather than forging waves.
- [ ] **Step 2 — Add `it.each` profiles** named `profiles [AC6][AC11] ...` for:
  1. text web-off/new session;
  2. text enabled-unused/new session;
  3. text prepared browse/new session;
  4. text prepared browse/eight prior ordinary turns;
  5. prepared existing-session history (hydration excluded and separately counted);
  6. cold web state ordinary turn (no turn preparation);
  7. sequential fallback Keenable→Exa→Tavily;
  8. repaired call and repair exhaustion (separate rows);
  9. synthetic-trust fetch (production gate separately closed);
  10. actual held archive → tool continuation → immediate next text turn;
  11. voice prepared browse/next turn under actual held archive;
  12. off/unused voice.

Use both `readMs:0, writeMs:0` and synthetic `readMs:67, writeMs:449` for the matched ordinary/browse/held-archive workloads. Count all other scenarios once; do not inflate “samples” by treating model-loop requests as independent turn trials.

- [ ] **Step 3 — Capture stages** at HTTP/voice measured entry, authenticated/admitted, accepted, first model fetch, valid tool offered, provider request/response, next model fetch, first answer delta, terminal, archive start/driver-hold/release/end/publication and immediate next model fetch. Missing stages are `null`, not zero. Track model calls, provider attempts/fallback, repairs, raw/foreground/other-lane DB commands, attempted storage entries, waves and unresolved saves.
- [ ] **Step 4 — Emit a payload-free row and assert only behavior/bounds**:

```ts
const observedStart = performance.now();
const syntheticStart = probe.elapsedMs;
// Run one measured fixture operation here through the real f.turn/voice path.
const observedMs = performance.now() - observedStart;
const syntheticMs = probe.elapsedMs - syntheticStart;
console.info('WEB_SEARCH_LATENCY', JSON.stringify({
  scenario, priorTurns, readMs, writeMs,
  waves: probe.waves, syntheticMs, observedMs,
  firstModel: f.beforeModel[0],
  modelPosts: f.bodies.length,
}));
expect(f.beforeModel[0]).toMatchObject({
  dbReads: 0, dbWrites: 0, storageEntries: 0,
  initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0,
});
expect(Number.isFinite(observedMs) && observedMs >= 0).toBe(true);
```

Here `probe`, `scenario`, `priorTurns`, `readMs`, `writeMs` are the parameterized profile's locals; the measured operation is `await f.turn('Search public evidence')` after queueing its known decisions, or Task 4's actual finalized voice operation. Compute wave deltas if setup cannot reset a live probe. No `<N milliseconds` assertion or fabricated timing constant. Any pre-model operation counter violation fails even when observedMs looks small.

- [ ] **Step 5 — Run B5 and C1 profiles**. Record synthetic waves/modelled ms and real `performance.now()` observations in separate columns. Run observed profiles serially and record sample count; suite duration is not task latency. No live provider latency/cache hits/billing observation is available: write unavailable, not zero.
- [ ] **Step 6 — Compare only matched current-tree workloads** (web off vs enabled-unused; 0 vs8 history; zero vs67/449 synthetic storage). Do not subtract historical Calendar/research numbers with different prompt/workload/commit. Say no matched pre-feature baseline exists unless one was actually captured with identical fixtures on an isolated authorized baseline checkout. No resetting this checkout, broad worktree deletion, or live baseline.
- [ ] **Step 7 — Commit only P5 performance/fixture files** after focused pass: `test(web-search): record dispatch counts and fixture latency observations`.

### Task 7: Execute mandatory Calendar and full-package regressions; route defects

**Files:** update only `docs/web-search/verification.md` with evidence. P5 fixes only its own new fixtures.

- [ ] **Step 1 — Run C1 unfiltered** and confirm these exact required cases execute, not just that the file exits:
  - Four `prepared ... dispatches and continues with application storage blocked`, one for each list-calendars/list-events/get-event/check-availability route.
  - `repeated prepared owner request preparation does not touch application storage`.
  - `read continuation and follow-up finish while an actual archive owns persistence`.
  - `provider-confirmed create continues while its result projection is held`.
  - `direct create crosses its essential barrier while an earlier archive holds ownership`.
  - `proposal confirmation crosses its essential barrier while an earlier archive holds ownership`.
  - `crash window W1` through `W4` and `new assembled runtime reconciles an ambiguous create by pinned ID without another POST`.
  - `competing text tabs keep one active attempt and one model effect`.
  - `concurrent text and live confirmations consume one proposal and create once`.
  - `source expiry at exactly expiresAt forces a fresh provider read`.
  - `expired policy denies a Calendar read without a provider request or stale content`.
  - `in-flight Calendar result cannot publish a view or continuation after account invalidation`.
  - Every `profiles ...` case.
- [ ] **Step 2 — Run C2/C3** and explicitly record:
  - `keeps one provider effect when a create is cancelled at the dispatching CAS or after success`.
  - `rehydrates status after invalidation without restoring revoked authority`.
  - Prepared `prepareOwner` memory authority and essential admission/consent/expiry/capability/deadline/budget guards remain fail-closed.
  - No web read acquired a Calendar mutation barrier; creates still require their acknowledged accepted-input/attempt/acceptance-marker/operation/planned/dispatching evidence before send.
- [ ] **Step 3 — Run C4/B1–B6/F1/F2**, then all R1–R7 separately, building before built-artifact suites. Full routine/e2e failures are failures even if feature-only suites pass. Record warnings, skipped suites, errors and any command timeout/worker crash separately; never silently retry until green and omit the first failure.
- [ ] **Step 4 — Attribute defects using this ownership table**, with a smallest named failing check:

| Owner | Route production/test defects here | Focused owner regression required before P5 rerun |
| --- | --- | --- |
| P1 | Canonical schema/policy/config/collection/wire contracts, defaults/ranges, SDK dependency pins, backend mirrors' authoritative side | `npm test -- src/contracts/web-search-policy.spec.ts src/contracts/web-search-wire.spec.ts src/contracts/web-search-tools.spec.ts src/contracts/admin-config.spec.ts src/platform/dependency-pins.spec.ts` |
| P2 | Provider allowlist/mapping/headers, MCP replay/fallback, encryption/persistence, OAuth/callback content, URL/fetch gate, prepared connection/lifecycle epochs | `npm test -- test/plugins/web-search/ test/persistence/web-search-connections.spec.ts src/platform/crypto/web-search-secret-cipher.spec.ts --no-file-parallelism` |
| P2A | Account authority freshness/expiry/fences/revision/session isolation; AuthService/Administration lifecycle logic | `npm test -- test/auth/account-authority.spec.ts test/auth/authority-lifecycle.spec.ts test/auth/authority-http.spec.ts test/auth/session.spec.ts test/administration/ --no-file-parallelism` |
| P3 | Actual central injection/callback/parser/control-plane preparation; HTTP/voice model path, counters/repair/no-replay, coexistence, source/archive/runtime cancellation/shutdown | `npm test -- test/assembly/web-search-composition.spec.ts test/http/web-search-boundary.spec.ts test/runtime/web-search-runtime.spec.ts test/runtime/web-search-coexistence.spec.ts test/voice/web-search-voice.spec.ts test/persistence/memory-web-records.spec.ts test/assembly/auth-wiring.spec.ts test/assembly/auth-deactivation.spec.ts --no-file-parallelism`, plus C1–C4 for shared critical-path fixes |
| P4 | Provider instructions/destinations/actions, client/protocol/SSR/DOM, Config fields, composer absence, URL links/SSE/live presentation/mirror frontend side | F2 and R5–R7 plus BR1's exact failed interaction |
| P5 | New fixture miswiring, clock/expiry collision, missing lane/count instrumentation, evidence/runbook errors | Smallest new P5 test then B1/B4/B5/F1 as applicable; never alter product semantics |

For an independent Calendar pre-existing defect, inform the orchestrator/Calendar owner; do not expand P3/P5 ownership or alter Calendar work. P3 fixes new shared-runtime regressions it introduced; the Calendar owner fixes independent Calendar defects.

- [ ] **Step 5 — Send each reproducer to the orchestrator**, not a reviewer/fixer: defect ID, exact tested SHA/dirty baseline, file/test/command, expected/actual counts, causal stack without payloads, suspected owner, acceptance impact. Keep the failing assertion committed only if the orchestrator accepts a known-RED fixture handoff; never `.skip`, `it.fails`, loosen caps, or label an unresolved failure passed.
- [ ] **Step 6 — After returned owner fix commit**, verify named paths/commit, rerun the reproducer and relevant broad regression/package checks. Record both runs and changed tested HEAD. A final report cannot reuse old pass evidence after a source fix affecting that path without rerun.
- [ ] **Step 7 — Native N1 disposition.** Without separately operator-supplied isolated settings, run only sanitized skip-discovery if useful and report skipped/prerequisite-blocked. If settings are supplied/authorized, run N1 in a separate child preserving only that operator test configuration, exact prefix `aurvin_p2_test_`, never application URI/data, never print it. No provisioning or backup/restore follows. Native e2e skips in R4 remain separately counted. `test:azure`/`test:behavior`, live MCP/OAuth/model/voice, staging/proxy/production drills remain **unrun**, not a green zero-test result.
- [ ] **Step 8 — Commit evidence only** with `docs(web-search): record integrated acceptance and regression results`. Feature acceptance remains blocked by unresolved new defects and the named compatibility/safety gates, even when fixture checks pass.

### Task 8: Write the delivered-feature operator runbook and narrow README links

**Files:** create `docs/web-search/operations.md`; modify `README.md` narrowly.

- [ ] **Step 1 — Write runbook scope/evidence header:** local/access-controlled use, one executor per database; no provision/deploy/paid check authorization; review skipped; current `verification.md` link; live compatibility0/5, OAuth fixture-only, TinyFish key unsupported and production fetch closed. Historical Calendar/WorkOS docs are patterns, not current Web Search API authority.
- [ ] **Step 2 — Add provider setup/rotation table** with the five exact console URLs/instructions from goal and fixed endpoints/mapping above. State: per-account encrypted keys via Plugins, not Config/admin-wide keys; Connect validates MCP capabilities outside turns and may consume a bounded explicit validation probe/credits; connecting never enables; no anonymous/keyless/REST fallback. Invalid/unavailable/reconnect-required states are distinct.
- [ ] **Step 3 — Document replacement/disable/removal procedures**:
  1. Replace through the existing provider card; only confirmed setup publishes a new credential version, invalidates old transports/results, and never redisplays the saved value.
  2. Failed replacement preserves old confirmed authority unless outcome is uncertain; uncertainty is not durable success.
  3. Disable immediately memory-fences new calls and best-effort aborts current work, but does not revoke vendor credentials or retract sent requests.
  4. Disconnect removes the local provider; last-provider removal clears saved enablement; reconnection needs explicit enable.
  5. `WEB_WRITE_UNCERTAIN` stays denied in the live process. An unconfirmed disconnect may restore saved authority after restart; reconcile control-plane storage while quiesced before resuming, never claim durable revocation.
  6. Revoke/rotate keys or grants at the provider's documented account controls if necessary. Do not claim local disconnect calls a universal remote-revocation API; document only actually implemented endpoints/behavior. Do not recommend master-key rotation by changing `AURVIN_CONFIG_ENCRYPTION_KEY` in place: preserve the current key/backup and use an independently planned migration.
- [ ] **Step 4 — Document OAuth callbacks and revocation:** exact path pattern `/api/plugins/web-search/providers/{tinyfish|keenable|exa|tavily|firecrawl}/oauth/callback` derived from configured same-origin frontend; GET is static CSP/no-store bridge, POST complete private/session/origin protected. Provider/browser/session/state/PKCE S256/audience/issuer/callback binding, single consume,10-minute expiry; fresh start after denial/expiry/restart. Capability-gated discovery/registration is not certified loopback acceptance. Never paste callback code/state/verifier/tokens in logs/tickets. Refresh is bounded background/control-plane work, never an admitted-turn requirement; ambiguous rotating refresh requires reconnect, no blind replay.
- [ ] **Step 5 — Document auth authority operations:** actual `/api/auth/me`/login preparation outside turns, bounds1024/2048 bytes/15min/four reads, exact-expiry/cold/fenced/uncertain closed behavior; reload/auth preparation or fresh confirmed login, never DB fallback in a turn. All local mutations use fencing hooks. Direct Mongo writes, bootstrap CLI while live, other executors and WorkOS-dashboard changes have no coherent immediate invalidation: stop/quiesce, reconcile status/SID, restart/reprepare. TTL is not immediate revocation. Active WebSocket principals are **not automatically reauthenticated**; existing logout/deactivation/session cleanup is separate and already-dispatched requests cannot be withdrawn. Unknown-subject provider-reset ambiguity remains operator reconciliation, not atomic local revocation certification.
- [ ] **Step 6 — Document safety/limits/degradation:** HTTP(S)/public/DNS restrictions, provider-only outbound, no local URL proxy, prompt injection untrusted evidence; provider redirect-hop protection **unverified, so fetch remains disabled** until primary documentation plus separately authorized service evidence is recorded by P2. Limits5/5 editable1..20, shared repairs3/model15(default)/45(max), one slot/provider and nested4s/12s/25s/45s within run180s; context/evidence bounds may stop earlier; no dropped history. Status/readiness has no paid probes; web outage degrades retrieval, not ordinary text/voice or a restart signal.
- [ ] **Step 7 — Document privacy/retention/billing:** only necessary query/URL sent, fallback can disclose to another connected vendor, credits/charges/third-party retention possible, no permanent free allowance, invoice/exactly-once/charge prevention not guaranteed. Keys/access/refresh/verifiers encrypted server-side with owner/provider/connection/version binding; never prompt/URL/log/frontend `VITE_*`. Bounded native tool results and source/activity/accounting may persist via existing terminal archive; disconnect does not erase prior evidence or provider logs. No unbounded raw-page archive/private model reasoning. Link existing retention/backups policy, say if actual web-evidence cleanup/restore behavior is unverified; do not invent a TTL/erasure guarantee.
- [ ] **Step 8 — Document shutdown/rollback:** stop admissions and synchronously fence authority/web work; abort new calls, close tracked setup/maintenance/sessions bounded at P2's5s and enclosing operations budget; drain actual ordered archives or report undrained/uncertain; persistence closes once. Existing external45s supervisor bound is not a proven drill. Never overlap executors, delete sentinels, replay unsealed tools/model calls, drop web collections/indexes, or rollback credentials by restoring revoked authority. Rollback needs authorized quiescence, compatible reader for additive fields/records and validated full backup/restore; separately approved isolated restore, no destructive command supplied. Restoring archives does not undo third-party disclosures/charges. Mark every actual service/shutdown/rollback drill unrun unless separately evidenced.
- [ ] **Step 9 — README edit:** add a short Web Search paragraph and links to `docs/web-search/operations.md` and `verification.md`. Say default off, per-account, text/voice, Plugins setup, Config5/5, compatibility/fetch gates and no composer toggle. Remove only the directly contradictory claim that this feature has no retrieval; narrowly qualify authenticated per-account Web Search where old shared-identity wording would otherwise misdescribe it. Do not rewrite historical Phase1/Calendar/voice setup or globally “fix” all old README paragraphs. Refer unrelated stale text back to its owner.
- [ ] **Step 10 — Check paths/routes/numeric limits against actual source and executed evidence**. Use `git diff --check -- README.md docs/web-search/operations.md` and local link resolution; all referenced existing documents/files must exist, and planned final-report link remains labelled pending until created. Commit only those two named files: `docs(web-search): add operations and scoped README guidance`.

### Task 9: Final verification snapshot and final report

**Files:** finalize `docs/web-search/verification.md`; create `docs/web-search/final_report.md`.

- [ ] **Step 1 — Recheck gate and tested tree:** no unresolved new feature/security defect hidden by an upstream failure; P3 real-auth/voice composition proven; all task files committed or explicitly identified in the tested dirty set. Production fetch/OAuth/TinyFish limitations remain acceptance blockers/limitations, not silently waived product requirements. Orchestrator records any explicit user scope decision; P5 cannot approve one.
- [ ] **Step 2 — Rerun required affected focused commands and R1–R7** on the final application commit set after any owner corrections, serialized for meaningful profile observations. Documentation-only edits after the tested source SHA do not require unrelated reruns, but record them separately. If a required suite fails, keep executed/fail and route it; no “all tests passed” summary.
- [ ] **Step 3 — Finish verification rows** with actual exit/counts, each AC disposition and exact case names, command/run IDs/log paths, real model-boundary counters, latency sample sizes/stages, unresolved saves and later drain result, native/browser/service dispositions. Missing evidence must remain unrun/prerequisite-blocked, not a guessed zero.
- [ ] **Step 4 — Create this final-report structure** and populate it from evidence, not plan intentions:

```markdown
# Final Report: web-search
## Outcome and remaining acceptance gates
## Workflow configuration
MAW; unified review skipped by user instruction, never passed.
## Plan and execution record
| Owner | Plan commit | Implementation/fix commits actually included | Status |
## Tested revisions and environment
## Verification
| Command/run IDs | Executed outcome and counts | Skips/errors/limitations |
## AC1–AC11 evidence
## Dispatch and latency observations
## Defects, owner fixes and reruns
## Provider compatibility and operational limits
## Key artifacts
## Unrun checks and remaining work
```

Lead with what actually works in deterministic fixtures and what remains gated. Include P1/P2/P2A/P3/P4/P5 exact commits, final tested SHA, OS/Node/npm/package versions, preserved dirty work, no external calls/paid checks, source vs fixture vs live distinction, and no production readiness claim.

- [ ] **Step 5 — Freeze the compatibility table:** all five live MCP **unrun (0/5 live-tested)**; all five live browser OAuth/local callback/refresh **unrun, fixture-only**; TinyFish manual key MCP **unsupported**; production fetch all five **disabled/unverified**. Native MongoDB/replica-set/Azure/staging/live audio/provider billing/latency/cache-hit verification are not certified by these fixtures.
- [ ] **Step 6 — D1 document/ownership checks**, repository root:

```powershell
git status --short
git diff --check -- docs/web-search/verification.md docs/web-search/operations.md docs/web-search/final_report.md README.md
git diff --stat
git log --format="%h %s" -- docs/web-search
```

Check all AC1–AC11 rows have a command/case/disposition; test-file paths in the command catalog exist; Markdown links resolve; source/module exports used by P5 tests exist; no unresolved placeholder markers; synthetic/observed columns cannot be confused; skipped review never described as passed. Verify P5 commits contain only its owned named files. Do not claim a `.tsx` browser fixture passed via Node discovery.

- [ ] **Step 7 — Commit report/evidence only** after orchestration commit permission:

```powershell
git add -- docs/web-search/verification.md docs/web-search/final_report.md
git commit --only -m "docs(web-search): record final verification and remaining gates" -- docs/web-search/verification.md docs/web-search/final_report.md
git show --format=fuller --stat HEAD
git diff-tree --no-commit-id --name-only -r HEAD
```

Report documentation commit separately from the final tested application SHA; the report cannot contain its own not-yet-known hash. Return the hash to the orchestrator for `state.md`.

- [ ] **Step 8 — Return final handoff:** exact P5 file/commit list, per-AC executed/blocked disposition, owner defect/fix/rerun IDs, commands/counts/warnings/skips/errors, latency observations with synthetic distinction, operations limitations, no-live0/5 table, preserved user work. The orchestrator decides workflow completion from completed evidence/report and explicit remaining gates. An evidence-complete but acceptance-blocked feature must not be labelled fully accepted or production-ready.

## Commit hygiene for every P5 execution task

Obtain serialized commit permission, run status, and use the path-scoped commit form demonstrated in Task 9 with only that task's explicitly named P5 files (message/options precede the `--` path delimiter). Stage a new file explicitly first. Never `git add .`, broad directory staging, automatic stash/reset/checkout, forced worktree removal, or commits including `.commandcode/`, dependencies, generated artifacts, or another worker's changes. Verify each commit with `git diff-tree --no-commit-id --name-only -r HEAD`.

## Planner self-check and plan-only verification

- [x] AC1–AC11 map to exact commands, fixtures, assertions, owner routing, and evidence dispositions.
- [x] P2/P2A/P4 handoffs reconciled; P3's historical authentication exception explicitly superseded.
- [x] Real private HTTP plus SSE and voice admission, all-storage attempted-entry/driver instrumentation, held **actual** archive, no replay and no preparation before initial model included.
- [x] Five provider/ten mapping fixtures, exact three additional repairs, shared5/5 limits, fixed nested timeouts, URL/fetch gates and0/5 live limitations included.
- [x] Calendar root-required named cases, full package checks, browser-vs-Node distinction, synthetic-vs-observed measurements, auth external-writer/active-socket limitations retained.
- [x] File ownership excludes production fixes; P1/P2/P2A/P3/P4 focused routing is explicit; README scope stays narrow.
- [x] Operations/report are future deliverables; source presence, previous worker reports and this plan are not executed evidence.
- [x] Planning checks: current Git status inspected; AC1–AC11 rows, 21 catalog commands, nine local links, balanced Markdown fences and unresolved-marker scan passed. Untracked-plan whitespace must also be checked after explicit staging below.
- [ ] Commit only this plan using the path-scoped equivalent of the requested command:

```powershell
git add -- docs/web-search/plan5.md
git commit --only -m "docs(web-search): plan 5 - integrated verification and operations" -- docs/web-search/plan5.md
git show --format=fuller --stat HEAD
git diff-tree --no-commit-id --name-only -r HEAD
```

Planning checks are document/source/contract consistency and Git hygiene only. Application, browser, native and live checks above are **planned, not run by this planner**.
