# P4 Integrated Calendar Tool Latency Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use the installed `executing-plans` and `test-driven-development` skills. The MAW orchestrator assigns this worker; do not dispatch another worker, reviewer or review-triggered fixer.

**Goal:** Prove the assembled Calendar read/create paths meet the approved critical-path, recovery, isolation and bounded-saving requirements, publish reproducible evidence, then add only the verified future-tool policy to root `AGENTS.md`.

**Architecture:** Exercise the existing AppService composition, production connection owner, capability/credential/executor path, memory runtime and real repository/checkpointer implementations over the existing BSON fake driver and deterministic HTTP fixtures. Observe command starts/completions and hold real archive or essential-barrier acknowledgements without replacing admission/ownership guards. Keep production defect correction with P1–P3; P4 owns independent acceptance tests, measurements, the verification document and the final instruction addition only.

**Tech Stack:** Existing TypeScript ESM/NodeNext, NestJS application composition, MongoDB repository/checkpointer ports, `node:async_hooks`, `node:perf_hooks`, BSON, Vitest 4 and `DependencyProbe`; no new dependency, framework, collection or live service.

---

## Authorization and start gates

- Inputs read: approved [`goal.md`](goal.md), current [`state.md`](state.md), [`research.md`](research.md), [`plan1.md`](plan1.md), [`plan2.md`](plan2.md) and [`plan3.md`](plan3.md). Research is `b66fe00`; P1 plan/implementation are `4d62254`/`67bb366`; P2 plan/implementation are `86253c3`/`3742a38`; P3 plan is `10f2f07`.
- **Current status supersedes the historical cancellation paragraphs in plan3:** P2 implementation is committed and must not be restarted. P3 M1–M6 reconciliation is running separately. This planner does not start P3 or any other worker.
- **P4 worker gate:** this plan committed; actual P1, P2 and P3 implementations/check handoffs complete and committed; P3 M1–M6 reconciliation recorded by the orchestrator; serialized shared-index permission. A committed plan or source resembling an unfinished implementation is not worker completion.
- At worker entry, reconcile actual P3 APIs and test names with this plan. Missing upstream behavior becomes a failing P4 acceptance test and an owner handoff, not permission to weaken an assertion or implement a production fix here.
- This planning delivery creates/commits **only `docs/calendar-tool-latency/plan4.md`**. No implementation, application tests, verification document or root policy edit now.
- Work in the shared checkout; **no separate worktree**. Preserve unrelated dirty backend/frontend files and `.openchamber/`. Do not inspect their contents or stage them. If a P4-owned future path becomes dirty, ask the orchestrator to reconcile ownership before editing it.
- No live Google/OpenRouter/LiveKit/MongoDB, paid calls, application-data access, external provisioning, backend restart or deployment. Native/service checks require separate explicit authorization and isolated test prerequisites. No model change or new mode capability.
- Unified code review is **skipped**, never passed. Test failures still require diagnosis/correction through the owner; do not dispatch a reviewer/fixer.

## Exact file map

| P4 path | Responsibility / edit gate |
| --- | --- |
| Create `backend/test/performance/calendar-tool-latency.spec.ts` | Integrated acceptance matrix and prepared/cold measurements. All P4 test cases live here. |
| Create `backend/test/performance/calendar-tool-latency-fixture.ts` | One assembled AppService/runtime over the existing fake driver; synthetic provider state, controlled gates, BSON image capture and cleanup. No new production abstraction. |
| Create `backend/test/performance/calendar-tool-latency-trace.ts` | Bounded test-only command/milestone recorder using `DependencyProbe` and async origin tags. |
| Create `docs/calendar-tool-latency/verification.md` | Actual environment, commit set, commands/counts, measurements, acceptance mapping, failures/skips and limitations. |
| Modify root `AGENTS.md` | **Last implementation task only**, after evidence exists; load `agents-markdown-setup`, add the compact policy below and preserve everything else. |

Do not edit existing fixtures/tests, package manifests/lockfiles, production files, other plans, historical workflows, `goal.md`, `state.md` or `final_report.md`. The orchestrator owns the latter three. P1 owns authority/provider assembly; P2 owns read/context/retention; P3 owns mutation barrier/archive-isolation/recovery. Report a failure with exact test/commit/log and expected invariant to its owner, await the owner's committed correction, then rerun affected acceptance and regressions.

Read-only reuse: `backend/test/persistence/calendar-multi-memory.ts`, `calendar-multi-fixtures.ts`, `backend/test/assembly/admin-config-fixture.ts`, `calendar-fixture.ts`, `backend/test/auth/fixtures.ts`, `backend/test/model/calendar-fixtures.ts`, `backend/test/runtime/calendar-runtime.fixture.ts`, `calendar-multi-fixture.ts`, `calendar-live.fixture.ts`, and `backend/test/performance/dependency-probe.ts` / `latency-runtime-fixture.ts`. Do not change these to expose a local helper.

**Important fixture distinction:** `calendarFixture` and `createLatencyFixture({ path: 'calendar' })` use a legacy store-backed capability/credential adapter; their fake Google metadata handler itself reads application storage. They are useful unchanged historical regression/profile controls, **not** the assembled prepared-path acceptance fixture. `assembledCalendarApp` explicitly sets `memoryFirstPolicy = null`; do not call it and claim memory-first coverage. Use the new fixture below with the stock saver enabled.

## Milestones and completion meaning

1. **V0 — Prerequisite/baseline inventory:** exact commits/environment and open failures recorded, no inferred clean baseline.
2. **V1 — Observable real composition:** new fixture self-checks pass, deterministic providers only, all real guards retained.
3. **V2 — Critical-path acceptance:** blocked-store reads/availability, complete continuation/follow-up and mandatory-versus-archive create checks pass.
4. **V3 — Safety/recovery:** four primary crash windows plus split-acknowledgement cases, identity/no-replay, invalidation/privacy/mode/bounds checks pass.
5. **V4 — Measurements/regressions:** reproducible prepared/cold profiles and actual suite/build/lint results published; failures/skips remain explicit.
6. **V5 — Verified instructions:** root addition matches source/tests/evidence; final document consistency checked. Orchestrator receives final-report inputs and decides the overall workflow gate.

Never mark an unrun/empty/skipped check passed. Open required acceptance or introduced regression failures block V5 and completion; reproducible existing failures still remain open with evidence/owner disposition, not a blanket waiver or full-suite certification.

## Task 1: Capture the actual baseline and open evidence record

**Files:** create `docs/calendar-tool-latency/verification.md`; inspect only named clean prerequisites/test configuration.

- [ ] **Step 1 — Record worker entry.** Run separately at repository root: `git status --short --branch`, `git rev-parse HEAD`, `git log -1 --format=fuller 67bb366`, `git log -1 --format=fuller 3742a38`, `node --version`, `npm --version`. Obtain the actual completed P3 commit set from its handoff. Record OS, date/time, package versions from package/lock metadata, dirty **path names only**, fixture clock and test commands. Do not inspect unrelated dirty contents.
- [ ] **Step 2 — Remove service credentials from the worker's test process, without printing values.** Ensure every test command inherits this sanitized environment; a separate tool shell may not retain another shell's environment edits. Prefix each such PowerShell invocation with this loop, or run checks inside one approved sanitized process:

```powershell
foreach ($name in @('AURVIN_TEST_MONGODB_URI', 'MONGODB_URI', 'OPENROUTER_API_KEY', 'GOOGLE_CLIENT_SECRET', 'LIVEKIT_API_SECRET')) {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
```

Fixture bootstrap/config/provider ports must use explicit synthetic values, never `.env` or fallback `fetch`. Do not print connection strings or keys. No `npm ci` is needed when installed prerequisites already exist; report an absent prerequisite instead of adding a dependency.

- [ ] **Step 3 — Capture focused baseline before creating tests.** Working directory `backend/`:

```powershell
npm test -- test/performance/calendar-memory-first.spec.ts test/performance/memory-calendar-state.spec.ts test/performance/memory-text-archive.spec.ts test/performance/memory-first-foundation.spec.ts test/performance/calendar-voice-latency.spec.ts test/performance/calendar-critical-path.spec.ts test/performance/memory-first-voice.spec.ts test/runtime/calendar-operation.spec.ts test/runtime/calendar-confirmation.spec.ts test/runtime/calendar-multi-recovery.spec.ts test/assembly/calendar-capability.spec.ts
```

Run `npm run build` and `npm run lint` separately. Record exit, discovered files/tests, passes/failures/skips/unhandled errors/worker crashes, duration and artifact location. A worker crash does not turn undiscovered/unexecuted tests into passes. These worker commands are **not run by this planner**.

- [ ] **Step 4 — Carry these caveats into verification verbatim in substance, then append actual new results:**
  - Research on `7c4ac68`: seven files / 124 passed; backend build/lint passed (711 lint warnings). Synthetic legacy lookup: 197 reads / 73 writes / 262 waves, first dispatch 14,595 ms, first delta 34,410 ms. Legacy unreferenced confirmation: 0 prior turns 158/45/199, receipt 21,108 ms; 8 prior turns 182/45/223, receipt 22,716 ms. These are historical **synthetic** results, not current/live performance.
  - P1 `67bb366`: reported selection 32/33 files, 344 passed, **two calendar-capability failures**. Initial build hit three errors in then-dirty `calendar-loop.ts`/`calendar-skills.ts`; lint exit 0, 720 warnings. Reported pre-existing attribution has no independently replayed clean baseline.
  - P2 `3742a38`: focused seven files / 153 passed; broader 19 files / 365 passed; build/lint passed, 731 warnings. Separate voice-latency check 12 passed / **2 failed**, reads 160 versus <=158 and 184 versus <=182 with timing ceilings. `memory-first-voice.spec.ts`: four skips and one worker crash. Do not treat proposed causes as verified baseline classification.
  - No P1/P2 full-backend, native, e2e, frontend or live certification follows from those selections.
- [ ] **Step 5 — Create the evidence document with these headings:** `Status and scope`, `Commit set and workspace`, `Environment and fixture protocol`, `Baseline and open defects`, `Commands and actual outcomes`, `Acceptance matrix AC1–AC8`, `Critical-path measurements`, `Crash/recovery matrix`, `Privacy/isolation/bounds`, `AGENTS policy consistency`, `Limitations and unresolved work`. Each result row names the exact test/command, commit set, outcome/counts and evidence location. Until measured, use **Not run**, not invented values. Do not fill final-report/state on behalf of the orchestrator.

## Task 2: Build one observable assembled fixture, without overriding guards

**Files:** create the three new test/fixture paths in the file map. Add the mandatory repository header to each on its first write (`FILE`, `LOCATION`, `PURPOSE`, `ROLE IN PROJECT`, `KEY COMPONENTS`), before imports. Local imports use `.js`.

- [ ] **Step 1 — Write this first red fixture test** in `calendar-tool-latency.spec.ts`:

```ts
import { expect, it, vi } from 'vitest';
import { calendarToolLatencyFixture } from './calendar-tool-latency-fixture.js';
import { textWire, loadWire, skillWire, createWire } from '../runtime/calendar-runtime.fixture.js';
import { event } from '../runtime/calendar-multi-fixture.js';

it('assembled fixture observes denied fresh admission instead of bypassing it', async () => {
  const f = await calendarToolLatencyFixture();
  try {
    await f.prepare();
    const account = await f.owner.connections.currentAccount();
    const blocked = vi.spyOn(f.p.calendarConnectionsV2, 'get')
      .mockRejectedValue(new Error('synthetic essential storage failure'));
    try {
      await expect(f.owner.connections.requireAccountCurrent(account,
        new AbortController().signal)).rejects.toBeDefined();
      expect(blocked).toHaveBeenCalled();
      expect(f.provider.posts).toHaveLength(0);
    } finally { blocked.mockRestore(); }
  } finally { await f.close(); }
});
```

Run in `backend/`: `npm test -- test/performance/calendar-tool-latency.spec.ts -t "assembled fixture observes"`. Initial expected red is missing new fixture import, not a real network call. This is test-harness TDD; after prerequisites are implemented, later behavioral assertions may pass immediately. Record that honestly—never break production or override a guard to manufacture red.

- [ ] **Step 2 — Implement the fixture using the actual application entry point.** The following is the required composition recipe and public test contract; use existing imports from the exact files listed alongside it. `assemblyFixture` supplies config storage/assets only; replace its stub persistence and runtime **before** `AppService.create`. Do not use `calendarFixture` to decorate the real bundle, because its acceptance wrapper changes the returned receipt shape.

```ts
import { vi } from 'vitest';
import { BSON, type MongoClient } from 'mongodb';
import { AppService } from '../../src/app.service.js';
import type { SubmitTurnResponse } from '../../src/contracts/api.js';
import type { RuntimeDependencies } from '../../src/chat-runtime/ports.js';
import { DurableChatRuntime } from '../../src/chat-runtime/durable-chat-runtime.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { MemoryTextArchive } from '../../src/persistence/memory-text-archive.js';
import { CalendarSecretCipher } from '../../src/platform/crypto/calendar-secret-cipher.js';
import { tokenAad } from '../../src/plugins/google-calendar/connection.js';
import { calendarConnectionV2Schema } from '../../src/contracts/calendar-discovery.js';
import { defaultManageableSettings } from '../../src/platform/config/manageable-config.js';
import { CredentialService } from '../../src/admin-config/credential-service.js';
import { CredentialValidator } from '../../src/admin-config/credential-validation.js';
import { loadBootstrapConfig } from '../../src/platform/config/bootstrap-config.js';
import { parseCalendarSetupOptions } from '../../src/plugins/google-calendar/options.js';
import { assemblyFixture } from '../assembly/admin-config-fixture.js';
import { document, at, secret } from '../admin-config/fixtures.js';
import { calendarLimits } from '../model/calendar-fixtures.js';
import { admittedAccount, authFixture } from '../auth/fixtures.js';
import { connectionV2 } from '../persistence/calendar-multi-fixtures.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { googleJson } from '../plugins/google-calendar/tools-fixtures.js';
import { DependencyProbe } from './dependency-probe.js';
import { CalendarToolTrace } from './calendar-tool-latency-trace.js';

const USER = 'aurvin-dev-user';
const CALENDAR = 'personal@example.test';
const CLOCK = Date.parse('2026-11-03T09:00:00.000Z');
const KEY = Buffer.alloc(32, 7);

export async function calendarToolLatencyFixture(options: {
  prepared?: boolean; image?: Record<string, Uint8Array[]>;
  provider?: ReturnType<typeof syntheticCalendarProvider>;
  readMs?: number; writeMs?: number;
} = {}) {
  const probe = new DependencyProbe();
  const db = calendarMemory(probe, { databaseName: 'calendar-tool-latency' });
  if (options.image) for (const [name, values] of Object.entries(options.image)) {
    for (const bytes of values) {
      const value = BSON.deserialize(bytes);
      db.rows(name).set(String(value._id), value);
    }
  }
  let now = CLOCK;
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const run = <T>(work: () => Promise<T>) => probe.drive(work,
    options.readMs ?? 0, options.writeMs ?? 0);
  const client = Object.assign(db.commandSource, { db: () => db.store.db,
    appendMetadata: () => undefined }) as unknown as MongoClient;
  const trace = new CalendarToolTrace(db.commandSource, probe);
  const saveOriginal = MemoryTextArchive.prototype.save;
  const saveObserver = vi.spyOn(MemoryTextArchive.prototype, 'save')
    .mockImplementation(function (envelope, limits) {
      return trace.scope.run({ lane: 'archive', attemptId: envelope.request.attemptId }, async () => {
        trace.mark('save-start');
        try { return await saveOriginal.call(this, envelope, limits); }
        finally { trace.mark('save-end'); }
      });
    });
  const p = await run(() => createPersistenceBundle(client,
    'calendar-tool-latency', DEFAULT_BUDGETS));
  const provider = options.provider ?? syntheticCalendarProvider();
  const modelWires: string[] = [], modelBodies: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input
      : input instanceof URL ? input.href : input.url);
    if (url.origin === 'https://openrouter.ai' && url.pathname === '/api/v1/chat/completions') {
      const wire = modelWires.shift();
      if (wire === undefined) throw new Error('Unexpected synthetic model dispatch');
      modelBodies.push(JSON.parse(String(init?.body ?? '{}')));
      trace.mark('model-dispatch');
      if (wire.includes('call_tool')) trace.mark('tool-wire-offered');
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.origin === 'https://www.googleapis.com') return provider.fetch(url, init, trace);
    throw new Error('Network destination is not an injected provider fixture');
  };
  const bootstrap = loadBootstrapConfig({ NODE_ENV: 'development',
    FRONTEND_ORIGIN: 'http://127.0.0.1:5173', PERSISTENCE_PROFILE: 'native-mongodb',
    MONGODB_URI: 'fixture-injected-only', MONGODB_DB_NAME: 'calendar-tool-latency',
    AURVIN_USER_ID: USER, AURVIN_CONFIG_ENCRYPTION_KEY: KEY.toString('base64') });
  const seeded = document(1);
  seeded.settings = defaultManageableSettings();
  seeded.settings.openRouter.modelId = 'fixture/model';
  const credentials = new CredentialService(bootstrap.encryption, new CredentialValidator(fetcher));
  seeded.credentials.openrouter = { envelope: credentials.seal('openrouter', secret), validatedAt: at };
  if (!options.image) {
    const base = connectionV2();
    const cipher = new CalendarSecretCipher(bootstrap.encryption);
    const account = { userId: USER, connectionId: 'conn-aurvin-dev',
      connectionRevision: 1, googleSubjectId: 'google-sub-aurvin', credentialVersion: 1 };
    const row = calendarConnectionV2Schema.parse({ ...base, ...account,
      tokenExpiresAt: new Date(now + 3600000).toISOString(),
      credentials: { access: cipher.sealToken(tokenAad(account, 'access'), 'latency-access-canary'),
        refresh: cipher.sealToken(tokenAad(account, 'refresh'), 'latency-refresh-canary') },
      updatedAt: new Date(now).toISOString(),
      discovery: { ...base.discovery, connectionId: account.connectionId, connectionRevision: 1,
        entries: [provider.entry], fetchedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 300000).toISOString(),
        retentionExpiresAt: new Date(now + 300000).toISOString() } });
    const saved = await run(() => p.calendarConnectionsV2.create(row));
    if (saved.outcome !== 'confirmed') throw new Error('Synthetic connection was not confirmed');
  }
  const auth = await authFixture(admittedAccount({ userId: USER }));
  const principal = { account: admittedAccount({ userId: USER }), sessionId: 'latency-auth-session',
    identity: { userId: USER, openRouterUser: USER, source: 'authenticated-session' as const } };
  const setup = assemblyFixture(seeded);
  setup.ports.open = async () => ({ ...p, users: auth.users,
    ping: async () => true, close: async () => { await p.owner.releaseExecutor(); } }) as never;
  setup.ports.authProvider = () => auth.provider;
  setup.ports.fetcher = fetcher;
  setup.ports.limits = async () => calendarLimits;
  setup.ports.memoryFirstPolicy = { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 50 };
  setup.ports.calendarConfig = { setup: parseCalendarSetupOptions({
    initial: { enabled: true, processingPolicyId: 'fixture-policy' }, evidence: 'fixture',
    realDataPolicyApproved: true, frontendOrigin: 'http://127.0.0.1:5173',
    backendOrigin: 'http://127.0.0.1:3000', oauth: { clientId: 'fixture-client-id',
      clientSecret: 'fixture-client-secret',
      redirectUri: 'http://127.0.0.1:3000/api/plugins/google-calendar/oauth/callback' } }),
    permission: { content: 'retained', minimalEvidenceAllowed: true, policyId: 'fixture-policy' },
    policyDeadlines: [CLOCK + 3600000], trustedTimeZone: 'Etc/UTC' };
  bootstrap.calendar = setup.ports.calendarConfig;
  let raw!: DurableChatRuntime;
  setup.ports.runtime = (d: RuntimeDependencies) => {
    raw = new DurableChatRuntime({ ...d, now: () => now });
    return raw;
  };
  const service = await run(() => AppService.create(bootstrap, setup.ports));
  const owner = service.calendarFor(USER);
  const invokeOriginal = owner.execution.invoke.bind(owner.execution);
  const invokeObserver = vi.spyOn(owner.execution, 'invoke').mockImplementation(async input => {
    trace.mark('executor-entered');
    try { return await invokeOriginal(input); }
    finally { trace.mark('executor-result'); }
  });
  const prepare = () => run(() => trace.scope.run({ lane: 'foreground', attemptId: null },
    () => service.prepareOwner(principal)));
  if (options.prepared !== false) await prepare();
  let serial = 0;
  const submit = (content: string, sessionId: string | null = null,
    calendarReplyTo?: { proposalId: string; revision: number }) =>
    trace.scope.run({ lane: 'foreground', attemptId: null }, () =>
      raw.submitTurn({ identity: principal.identity, sessionId, content,
        idempotencyKey: `latency-input-${++serial}`, ...(calendarReplyTo ? { calendarReplyTo } : {}) }));
  const frames: unknown[] = [];
  const execute = (ids: SubmitTurnResponse, signal = new AbortController().signal) =>
    trace.scope.run({ lane: 'foreground', attemptId: ids.attemptId }, () => raw.executeTurn({ userId: USER, ...ids, signal,
      emit: async frame => { frames.push(frame); trace.mark(`frame:${frame.event.type}`); },
      emitCalendar: async frame => { frames.push(frame); trace.mark(`frame:${frame.event.type}`); } }));
  const status = (ids: SubmitTurnResponse) => raw.memoryFor(USER)!.status(USER, ids.sessionId, ids.turnId);
  const close = async () => {
    raw.stopAccepting();
    await run(() => service.operations.shutdown());
    invokeObserver.mockRestore(); saveObserver.mockRestore(); trace.close(); dateNow.mockRestore();
  };
  return { p, db, probe, trace, provider, service, owner, raw, run, submit, execute,
    prepare, status, close, modelWires, modelBodies, frames,
    identity: principal.identity, principal, advance: (ms: number) => { now += ms; } };
}
```

AppService constructs its own real discovery adapter. Inspect the completed P3 handoff before implementing; if actual AppService composition requires a different safe fixture port, reconcile explicitly rather than falling back to the legacy adapter. `calendarLimits` already carries fixture Calendar capability/pricing; do not bypass frozen capability admission. Keep exactly one live runtime and persistence-close owner per fixture. Keep cleanup in a tracked `try/finally`, including fixture-construction failure: release test holds, drain raw work, close service/connection timers, restore observers and the clock. Tests are sequential, not `it.concurrent`, because their scoped prototype observer and Date spy must not overlap.

- [ ] **Step 3 — Implement `syntheticCalendarProvider` in this same new fixture.** This function is entirely a provider double; it must never inspect `db`, repositories or runtime state. Keep the external event map alive across crash images, because a process crash does not undo Google effects:

```ts
export function syntheticCalendarProvider() {
  const entry = { calendarId: CALENDAR, label: 'Personal', primary: true,
    accessRole: 'owner' as const, privateAccess: true, timeZone: 'Etc/UTC',
    selected: true, hidden: false, deleted: false,
    capabilities: { readEvents: true, createEvents: true, availability: true } };
  const posts: { calendarId: string; eventId: string }[] = [];
  const gets: { calendarId: string; eventId: string }[] = [];
  const events = new Map<string, Record<string, unknown>>();
  let beforeReturn: (() => Promise<void>) | null = null;
  const fetch = async (url: URL, init: RequestInit | undefined, trace: CalendarToolTrace) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    trace.mark(`google:${method}:${url.pathname.includes('/events') ? 'events' : 'metadata'}`);
    const metadata = { id: entry.calendarId, summary: entry.label, primary: entry.primary,
      accessRole: entry.accessRole, timeZone: entry.timeZone, selected: true };
    if (url.pathname.startsWith('/calendar/v3/users/me/calendarList')) {
      return googleJson(url.pathname.endsWith('/calendarList')
        ? { kind: 'calendar#calendarList', items: [metadata] } : metadata);
    }
    if (url.pathname === '/calendar/v3/freeBusy') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      await beforeReturn?.(); trace.mark('google-response');
      return googleJson({ kind: 'calendar#freeBusy', timeMin: body.timeMin, timeMax: body.timeMax,
        calendars: Object.fromEntries(body.items.map((item: { id: string }) => [item.id, { busy: [] }])) });
    }
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) throw new Error('Unexpected synthetic Google route');
    const calendarId = decodeURIComponent(match[1]!);
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (typeof body.id !== 'string') throw new Error('Missing stable event identity');
      const key = JSON.stringify([calendarId, body.id]);
      posts.push({ calendarId, eventId: body.id });
      const saved = { ...body, status: 'confirmed',
        htmlLink: `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(body.id)}` };
      events.set(key, saved); // External effect precedes response delivery.
      await beforeReturn?.(); trace.mark('google-response');
      return googleJson(saved);
    }
    await beforeReturn?.(); trace.mark('google-response');
    if (match[2]) {
      const eventId = decodeURIComponent(match[2]); gets.push({ calendarId, eventId });
      const saved = events.get(JSON.stringify([calendarId, eventId]));
      return saved ? googleJson(saved) : new Response('{}', { status: 404 });
    }
    return googleJson({ timeZone: 'Etc/UTC', items: [...events.values()] });
  };
  return { entry, posts, gets, events, fetch,
    holdResponses: (callback: (() => Promise<void>) | null) => { beforeReturn = callback; } };
}
```

For ordinary get-event acceptance seed one synthetic event with ID `evt123456`, summary `private-event-canary`, 10:00–11:00 UTC via this external map, not an application write. Restrict list output to the requested external calendar when adding a second calendar for isolation. Unknown destinations/methods must throw; no default global network fallback. Keep fixture fault outcomes (matched, 404, mismatched action, delayed/aborted response) explicit.

- [ ] **Step 4 — Implement the bounded trace helper.** Use this core in `calendar-tool-latency-trace.ts`; add `AsyncLocalStorage` from `node:async_hooks`, `performance` from `node:perf_hooks` and types `EventEmitter` / `DependencyProbe`. No raw query/body/log payloads:

```ts
type Origin = { lane: 'foreground' | 'archive' | 'setup' | 'recovery'; attemptId: string | null };
export class CalendarToolTrace {
  readonly scope = new AsyncLocalStorage<Origin>();
  readonly commands: { id: number; name: string; collection: string; origin: Origin;
    startedAt: number; endedAt: number | null; realStartedAt: number; failed: boolean | null }[] = [];
  readonly marks: { name: string; syntheticMs: number; realMs: number; origin: Origin }[] = [];
  private readonly origin = (): Origin => this.scope.getStore() ?? { lane: 'setup', attemptId: null };
  private readonly started = (e: { requestId: number; commandName: string; command: Record<string, unknown> }) => {
    if (this.commands.length >= 100000) throw new Error('Trace command ceiling exceeded');
    this.commands.push({ id: e.requestId, name: e.commandName,
      collection: String(e.command[e.commandName] ?? 'unknown'), origin: this.origin(),
      startedAt: this.probe.elapsedMs, endedAt: null, realStartedAt: performance.now(), failed: null });
  };
  private readonly succeeded = (e: { requestId: number }) => this.finish(e.requestId, false);
  private readonly failed = (e: { requestId: number }) => this.finish(e.requestId, true);
  constructor(private readonly source: EventEmitter, private readonly probe: DependencyProbe) {
    source.on('commandStarted', this.started); source.on('commandSucceeded', this.succeeded);
    source.on('commandFailed', this.failed);
  }
  private finish(id: number, failed: boolean) {
    const event = this.commands.find(row => row.id === id);
    if (!event) throw new Error('Unmatched synthetic command completion');
    event.endedAt = this.probe.elapsedMs; event.failed = failed;
  }
  mark(name: string) {
    if (this.marks.length >= 10000) throw new Error('Trace milestone ceiling exceeded');
    this.marks.push({ name, syntheticMs: this.probe.elapsedMs, realMs: performance.now(), origin: this.origin() });
  }
  close() {
    this.source.off('commandStarted', this.started); this.source.off('commandSucceeded', this.succeeded);
    this.source.off('commandFailed', this.failed);
  }
}
```

The fixture's call-through archive/executor observers preserve `this`, all arguments, returned values/errors and raw settlement; **never** return a fake execution result or replace any guard. Tag recovery using `trace.scope.run({ lane: 'recovery', attemptId: originalAttemptId }, ...)`, where `originalAttemptId` is captured from the actual interrupted turn. Restore observers only after raw work is drained. The saver identity is `envelope.request.attemptId`, not a nonexistent top-level envelope field.

Count started and completed commands independently; a held command must remain visible with `endedAt: null`, not disappear from `wireCalls`-only accounting. `probe.events` supplies method/kind/wave; driver request IDs supply exact start/completion linkage. Keep logical repository operations, physical fake-driver commands and provider requests separate.

- [ ] **Step 5 — Green fixture checks.** Run the first test, then add/run `assembled fixture records command starts before held completion` (hold `p.memory.put`, assert archive ownership, an unfinished started command where the hold is at driver level, release and require completion) and `assembled fixture rejects an unexpected provider destination`. Hold at repository level and driver level in separate cases: a repository hold before dispatch has no physical command start yet. Verify full identity attribution and synthetic canaries absent from traces. Run `npm run build` and `npm run lint`; this catches fixture typing/import compatibility even if a missing test fixture initially caused red. No changes to production or discovery guards.

## Task 3: Prove prepared read/availability continuation and the real held-save path

**Files:** new spec and fixture only. Each case uses a new fixture; never share a cached account across users/runtimes.

- [ ] **Step 1 — Add all four prepared cases and explicit pair assertions.** Define this matrix in the spec:

```ts
const READS = [
  { tool: 'calendar_list_calendars', args: {} },
  { tool: 'calendar_list_events', args: { timeMin: '2026-11-03T10:00:00Z',
    timeMax: '2026-11-03T11:00:00Z', maxResults: 10 } },
  { tool: 'calendar_get_event', args: { calendarId: 'personal@example.test', eventId: 'evt123456' } },
  { tool: 'calendar_check_availability', args: { timeMin: '2026-11-03T10:00:00Z',
    timeMax: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC', calendarIds: ['personal@example.test'] } },
] as const;

function assertPair(body: Record<string, unknown>, callId: string, input: string) {
  const messages = body.messages as { role: string; content: string;
    tool_calls?: { id: string }[]; tool_call_id?: string }[];
  expect(messages.filter(m => m.role === 'user' && m.content === input)).toHaveLength(1);
  expect(messages.flatMap(m => m.tool_calls ?? []).filter(c => c.id === callId)).toHaveLength(1);
  expect(messages.filter(m => m.role === 'tool' && m.tool_call_id === callId)).toHaveLength(1);
}
```

For test `prepared $tool dispatches and continues with application storage blocked`, warm only through real `f.prepare()` and the normal production owner lifecycle. Install a held call-through `MemoryTextArchive.save` **before** executing; background saves wait at this controlled entry so the strict block does not accidentally test expected background I/O. Traverse all repository instance/prototype function properties and the fake `RecordStore`/driver boundary, installing throwing spies after preparation (reuse the blocking algorithm in `calendar-memory-first.spec.ts` read-only). Do not block/replace the Calendar authority/capability/credential methods themselves. Run this body:

```ts
f.modelWires.push(loadWire(spec.tool, 'p4-load'), skillWire('call_tool', {
  plugin: 'google-calendar', tool: spec.tool, arguments: spec.args }, 'p4-read'),
  textWire('Read complete.'), textWire('Follow-up complete.'));
const before = f.trace.commands.length;
const input = `Run ${spec.tool}`;
const first = await f.run(() => f.submit(input));
await f.run(() => f.execute(first));
expect(f.status(first)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } });
assertPair(f.modelBodies[2]!, 'p4-read', input);
await f.prepare(); // Same private-owner preparation used by subsequent requests.
const next = await f.run(() => f.submit('Follow up', first.sessionId));
await f.run(() => f.execute(next));
expect(f.status(next)?.status).toBe('completed');
expect(f.modelBodies).toHaveLength(4);
expect(f.trace.commands).toHaveLength(before);
expect(f.provider.posts).toHaveLength(0);
expect(JSON.stringify(f.modelBodies)).not.toMatch(/latency-(access|refresh)-canary/);
```

Assert every blocked spy has zero calls, including no ownership promotion/flush/checkpointer call. Availability's `/freeBusy` is a **read**, despite its HTTP POST method; only `/calendars/.../events` POST counts as an external create. `calendar_list_calendars` can return from a complete prepared snapshot without a provider request. Assert expected real request/debit counts rather than forcing a request it does not need.

In `finally`, restore blocked spies first, release the save hold, drive/drain real saves, then close. No raw pending promise may be abandoned. Run `npm test -- test/performance/calendar-tool-latency.spec.ts -t "prepared .* dispatches"`. Expected green only for genuinely prepared memory routes; failures go to P1/P2. Already-green P2 behavior is legitimate acceptance evidence, not a reason to manufacture red.

- [ ] **Step 2 — Add `read result, next dispatch and follow-up finish while an actual archive holds ownership`.** Use the stock saver, spy `p.memory.put` once with `entered`/`release` deferreds, and execute an earlier ordinary turn until that archive is held. Drive storage waves with a bounded loop (`node:timers/promises.setImmediate`, at most 10000 iterations; advance only when `probe.waiting > 0`) until `entered`, **not** `probe.drive` on an intentionally blocked entire execution. Verify `sessions.execution.ownerId` is the actual executor by inspecting fake rows outside measured work. Run a read and availability continuation plus a new eligible follow-up while the hold remains; assert complete pairs and no fresh archive/promotion wait. Do not run a flush first.
- [ ] **Step 3 — Assert supervision before release:** status pending/unknown rather than saved; bounded drain reports false; the old raw write and archive owner are still tracked. Release and drive all promises, require durable versions `[1, 2, 3]` in order and no duplicate provider/model dispatch during save retry. Run `npm test -- test/performance/calendar-tool-latency.spec.ts -t "actual archive holds"`.
- [ ] **Step 4 — Add `temporary archive failure permits bounded reads but not unlimited dirty operation`.** Fail only archive projection, not authority/essential records. A read/availability/follow-up still completes while within existing queue/byte/age bounds; visible failed/unknown save is retained. At exact configured dirty-age/envelope/backlog boundary, next admission is denied before new model/provider calls. Retry saver only with the existing API/epoch/version and backoff; no inference replay, no increased limits. Preserve three total attempts and raw-write pinning. Reuse existing foundation-limit tests as regressions, not a second scheduler.

## Task 4: Prove the essential create barrier is independent of archive work

**Files:** new spec/fixture only. These tests cannot be satisfied by mocking `executeCreate`, `requireDispatchAllowed`, ownership, acceptance receipts, capabilities, credentials or budgets to always allow.

- [ ] **Step 1 — Add two real held-archive cases** named `direct create crosses only its essential barrier with archive held` and `proposal confirmation crosses only its essential barrier with archive held`. Hold an earlier actual `p.memory.put` **after** archive ownership acquisition as in Task 3. Direct wire/input:

```ts
f.modelWires.push(loadWire('calendar_create_event', 'p4-create-load'),
  createWire(event(), 'p4-create'));
const created = await f.run(() => f.submit(
  'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', earlier.sessionId));
await f.run(() => f.execute(created));
expect(f.provider.posts).toHaveLength(1);
expect(f.status(created)).toMatchObject({ status: 'completed', save: { durableVersion: 0 } });
```

`earlier` is the actual earlier turn whose raw archive is held, created by `f.submit('Earlier question')` with `textWire('Earlier answer')`. For proposal confirmation, first submit `'create the event'` with those same create wires, require a real pending proposal via `p.calendarProposals.getCurrent`, assert zero event POST, then submit `'yes'` with its exact `{ proposalId, revision }`. Do not seed/fabricate the proposal or bypass disclosure/consumption. No additional model wire is required for a genuinely accepted confirmation. Include referenced and unreferenced unique unchanged-disclosure variants; ambiguous/missing proof must clarify, never silently create.

At the provider POST callback capture a **BSON image of existing fake rows**, not extra foreground DB reads. Assert accepted input + generating attempt + exact acceptance marker, original deadline and finite create debit, exact account/calendar/action hash, consumed proposal/direct intent, `planned` and `dispatching` operation/events, and deterministic event ID all exist before POST. Assert no prior dispatch/decision/result replay, manifest/prepare/calendar checkpoint, unrelated archive completion or owner lease theft. Count necessary fresh connection checks rather than imposing research's speculative 2–3-read estimate.

- [ ] **Step 2 — Add `mutation barrier $boundary fails closed on $fault` parameterization.** Boundaries: bootstrap, accepted input, generating attempt, acceptance marker, sequence high-water, discovery pointer, direct intent/proposal consumption, create debit, planned operation, planned event, dispatching CAS, dispatching event, executor/active-handle fence. Faults: reject before write; hold acknowledgement; committed write with unavailable exact readback. For each locally wrap the actual owned method/RecordStore operation and call through except at the selected fault. Example shared real method check:

```ts
it.each([false, true])('unconfirmed dispatching event prevents POST (committed: %s)', async committed => {
  const f = await calendarToolLatencyFixture();
  const original = f.p.calendarOperationsV2.appendEventV2.bind(f.p.calendarOperationsV2);
  const spy = vi.spyOn(f.p.calendarOperationsV2, 'appendEventV2').mockImplementation(async row => {
    if (row.state !== 'dispatching') return original(row);
    if (committed) await original(row);
    throw new Error('Synthetic acknowledgement unavailable');
  });
  try {
    f.modelWires.push(loadWire('calendar_create_event', 'barrier-load'), createWire(event(), 'barrier-call'));
    const ids = await f.run(() => f.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.'));
    await f.run(() => f.execute(ids)).catch(() => undefined);
    expect(f.provider.posts).toHaveLength(0);
  } finally { spy.mockRestore(); await f.close(); }
});
```

For a production helper that legitimately confirms lost acknowledgement via exact readback, also fail/hold that readback to test **uncertainty**; otherwise successful exact confirmation is not a failed barrier. Include a separate positive lost-ack/exact-readback case. Catching the execute rejection above is only cleanup/observation: also assert the actual terminal safe error/unknown state and persisted operation state, not simply zero POST after an unrelated fixture failure. Hold each mandatory boundary, prove no POST while held, then cancel/expire/invalidate before release and prove no late POST. No fault wrapper may authorize work or fabricate a receipt.

Run `npm test -- test/performance/calendar-tool-latency.spec.ts -t "essential barrier|mutation barrier|unconfirmed dispatching"`. A behavioral failure is P1/P3-owned, not a P4 production task.

- [ ] **Step 3 — Add post-result independence.** Hold `calendarResultsV2.put`, retention/aggregate/archive projection individually **after** operation success and its matching event acknowledgement. Require provider-confirmed operation/result text and eligible follow-up before releasing those nonessential saves. Assert `receipt.durable` refers to action evidence while chat `save` remains pending/failed/unknown. Duplicate accepted submission, explicit retry and same-intent recovery preserve original operation/event and one create debit; changed payload fails idempotency. Missing prose is not permission to call model/create again.
- [ ] **Step 4 — Add mixed read/create and contention.** Same turn reads then creates; complete pair remains once, read counters/debits are not replayed, create barrier starts only at mutation. Competing text tabs and text/live confirmations yield one active attempt/effect and one proposal consumption. An unresolved original operation blocks a conflicting new intent even at another slot; unrelated session/read may progress within safety bounds. Release archives and verify strict monotonic publication without overwriting the later accepted turn pointer.

## Task 5: Test four process-crash windows using original operation identity

**Files:** new spec/fixture only. No normal exception/finally path may stand in for the durable state at a crash.

- [ ] **Step 1 — Add BSON image helpers** to the new fixture. Snapshot rows synchronously at the selected boundary, before cleanup changes them. Preserve BSON money/checkpoint binary/IDs/revisions:

```ts
const COLLECTIONS = ['sessions', 'messages', 'agent-memory', 'metadata',
  'checkpoints', 'checkpoint_writes', 'integration_connections', 'users'] as const;
export function durableImage(db: ReturnType<typeof calendarMemory>) {
  return Object.fromEntries(COLLECTIONS.map(name => [name,
    [...db.rows(name).values()].map(row => BSON.serialize(row))]));
}
```

Use a local held call-through method wrapper: enter the **before** boundary without calling original, or await original then enter the **after** boundary; signal `entered`, synchronously snapshot, and wait on a release gate. At that same instant copy the synthetic provider's `events`/`posts`/`gets` into a fresh `syntheticCalendarProvider` using BSON/structured copies; this is the external state at the crash, not a reset of Google effects. While held, create neither recovery runtime nor a second executor on that original store. Abort/stop the original runtime, release all old promises only for cleanup, close its fixture, then boot a **new fake driver** using `options.image` and that captured external provider state. Cleanup must produce no extra POST; assert this independently, and never let cleanup contaminate the recovery snapshot. New `createPersistenceBundle` must use its ordinary stopped-executor admission; never delete/rewrite a sentinel or override `assertExecutor`/recovery ownership. Boot/prepare/recover with no scripted model responses so any inference is an immediate fixture failure.

- [ ] **Step 2 — Add parameterized tests** named `crash window $window recovers by original identity` with these exact primary rows and assertions:

| Window / capture hook | Image invariant | Recovery assertion through `raw.reconcileSession(userId, sessionId)` |
| --- | --- | --- |
| W1: before essential barrier / before `reserveByIntent` | No dispatching operation; zero event POST. Include partial acceptance and consumed-proposal subcase. | Repair only exact existing accepted/consumption evidence or interrupt safely; no automatic model inference, no new authorization/identity. No POST when there was no valid planned action. |
| W2: after acknowledged planned operation/event, before dispatching CAS | Original intent/operation/action/calendar/event ID and one debit exist. | Same planned operation may make **one first POST only** after fresh authority/capability/preflight/consumption/deadline checks; no second debit or inference. Denied/expired/changed-condition variant sends none. |
| W3: after acknowledged dispatching, before outcome evidence | Original deterministic ID is pinned. Capture both before actual send and after provider has created but response is held/lost. | Bounded charged **readback only** of original calendar/event/account. Zero additional event POST even when absent; match succeeds, absent/mismatch/timeout/denied stays unknown/safe. No invented new operation. |
| W4: after provider success + succeeded operation/event, before terminal/archive | Receipt survives; archive may be missing/dirty, attempt generating. | Existing receipt returned/projected, zero additional POST/model/debit, save/narration availability distinguished, no watermark leap across dirty gap. |

For each case record original operationId, intentId, Google event ID, account/calendar/action hash, attempt/debit identity, before/after provider POST count and recovery readbacks from the fixture map/trace. Verify all returned readback IDs equal the original, not merely that a read happened. W2 asserts <=1 **total** POST; W3/W4 assert exactly unchanged POST count. The same-process `reconcileSession` case is additional coverage, not a substitute for new-driver recovery.

- [ ] **Step 3 — Add split-acknowledgement subcases:** consumed proposal/no operation; planned operation/no event; dispatching CAS/no matching event; provider success/outcome CAS failure; succeeded CAS/event acknowledgement failure; partial terminal dependencies/publication CAS uncertainty. Recovery repairs only the matching deterministic event or performs original-ID readback/save-only retry. Missing event is never a reason to POST from dispatching. Corrupt/foreign event, wrong account/session, unresolved-query overflow and v1 unresolved quarantine fail safely. Prove checkpoint/latest-turn-independent discovery by keeping real omitted graph preparation and an earlier dirty latest-turn pointer, not by inserting synthetic graph seals.
- [ ] **Step 4 — Run** `npm test -- test/performance/calendar-tool-latency.spec.ts -t "crash window|split acknowledgement"`. Record actual red/green and owner fixes. No exactly-once effect/billing, multi-instance, guaranteed cancellation-of-charge or physical-majority durability claims follow from these fake-driver tests.

## Task 6: Test authority, retention and text/live-voice isolation

**Files:** new spec/fixture only. Reuse real live reservation/delivery APIs, not voice implementation edits.

- [ ] **Step 1 — Add `invalidated in-flight result cannot feed continuation or publication`.** Hold synthetic GET/freeBusy response after normal debit/dispatch, call `raw.invalidateCalendarAccount(originalAccount, 'disconnect')` synchronously while retention saves are independently held, then release response. Assert no private result/view or source-consuming next model request, old prepared authority denied before retained-store work settles, queued/raw archives ultimately tombstoned. Follow-up ordinary text may continue after safe terminal settlement; do not weaken invalidation to keep the tool running.
- [ ] **Step 2 — Add one case per transition:** real disconnect, consent/reconnect, settings disable, implicit-default change, target-role/private-access loss, source expiry at exactly `expiresAt`, credential/discovery expiry and account replacement. Invoke actual lifecycle methods; direct out-of-process database edits are not a supported prepared-authority coherence channel. Changed provider role evidence follows the real capability adapter. Old-result completion and late old-account invalidation cannot revive/leak the old account or fence the newer confirmed account. Cold/stale paths refresh/hydrate safely or are unavailable, never pretend zero I/O/complete coverage.
- [ ] **Step 3 — Add `text and live voice share one attempt without sharing revoked context`.** Use `raw.reservations.acquire/bindConversation`, `raw.submitLiveTurn` and `raw.executeTurn({ live })` with actual `VoiceDelivery`/delivery writes as demonstrated in clean `calendar-live.fixture.ts` and `calendar-voice-latency.spec.ts`. Do not use its legacy capability adapter. Require heard/generated/unknown delivery distinctions and release the real reservation before eligible text input. Run both text-read -> live-follow-up and live-read -> text-follow-up with the earlier archive held; one active attempt, complete pairs, no premature next-turn before live terminal delivery, no save wait afterward. Concurrent text/live create confirmations consume once. Do not add Calendar to dictation or unsupported modes; this is deterministic runtime live-voice coverage, not LiveKit transport/audio certification.
- [ ] **Step 4 — Add canary and bound checks:** retained evidence available only before permission/expiry; volatile event summary/location/link appears only in current allowed continuation, not staged/queued/native/retry/cold tool context; a second model decision echoing canaries cannot leak through mutation fields. Same user/two sessions, different user/account, replaced connection revision and different target remain isolated. Finite tool/request/refresh/result/context/input/output/concurrency/deadline/save limits remain enforced; no silently dropped history. Canvas remains covered by unchanged regression suites. Invalid arguments/budget denial/cancellation before dispatch produce zero provider request; post-dispatch uncertainty preserves original identity.
- [ ] **Step 5 — Run** `npm test -- test/performance/calendar-tool-latency.spec.ts -t "invalidat|expiry|text and live voice|isolation|bounds"`. Run the relevant existing P1/P2/P3 safety suites in Task 8 afterward. Do not edit those files to turn this selection green.

## Task 7: Measure application overhead without inventing an SLA

**Files:** new spec/fixtures; actual results in `verification.md`.

- [ ] **Step 1 — Add `profiles $workload $preparation with $priorTurns prior turns`.** Workloads: list-events read, get-event read, availability, direct create, proposal confirmation (explicit reference and genuine unreferenced proof). Preparations: prepared/new session, prepared/warm session, cold existing session/new owner, stale discovery/credential refresh, recovery separately. Use 0 and 8 prior turns for read/direct/confirmation to distinguish fixed action evidence from history replay. Add one mixed read/create and one text/live contention profile. Cold history must be genuinely saved before a fresh runtime and must preserve history, not start with an empty conversation and label it cold hydration.
- [ ] **Step 2 — Use two explicit measurement modes:**
  1. **Ordering/blocked-persistence acceptance:** real monotonic timestamps and gates; assert causal order, zero forbidden foreground storage, necessary acknowledgements before POST. No machine-dependent millisecond ceiling.
  2. **Synthetic dependency model:** existing `DependencyProbe('wave')`, read 67 ms/write 449 ms to match research's reference constants; setup/warming outside the prepared window, preparation inside the cold end-to-end window. Record the fixture clock and all assumptions. This wave model rounds independent mixed-duration operations to a wave boundary; it is not an event-loop/network/real Mongo simulator. Keep real `performance.now()` observations separately labelled, not added to synthetic elapsed time.
- [ ] **Step 3 — Record these exact stage boundaries:** accepted input; initial model dispatch; tool wire offered; real executor entry; essential barrier start/end (observed repository acknowledgements); provider request start/response; executor result return; next model dispatch; first answer delta/confirmed operation frame; terminal; eligible follow-up accepted/next dispatch; logical save job start/end; durable publication/drain. Record absence as null/not applicable. Tool-wire-offered means fixture response delivery, **not** claimed parser/decision completion; executor-entry marks the downstream real boundary. Do not call initial model dispatch latency “tool dispatch latency.” Separate provider fixture time, which is controlled/instantaneous except intentional gates.
- [ ] **Step 4 — Report per stage:** command starts/completions/failures/unresolved IDs; read/write counts by collection/method; logical repository/save operations; sequential blocking waves/critical dependency stages; synthetic/real timestamps; actual Google metadata/read/freeBusy/create/readback counts; owner/attempt/origin tags. Background commands are shown separately even when concurrent with foreground; do not subtract arbitrary end snapshots or count only completed `wireCalls`. Prepared read/provider/result/continuation windows must show zero foreground DB commands; archive commands after logical completion are allowed and visible. Create windows explicitly itemize mandatory writes/reads and deferred bookkeeping. One logical consolidated save is **not** one physical command/transaction.
- [ ] **Step 5 — Before/after evidence:** rerun unchanged historical controls using `npm test -- test/performance/calendar-voice-latency.spec.ts test/performance/calendar-critical-path.spec.ts` and record their actual failures, including the open reference ceilings. Historical `7c4ac68` research numbers are comparable only with their original legacy fixture/workload and constants. Do not subtract those totals from a new prepared AppService workload and present a controlled percentage improvement. Where no matched pre-change prepared/cold/read/availability/direct-create measurement exists, mark **No matched pre-change measurement** and report structural before-call-chain versus measured after separately. No worktree, checkout/reset/stash or baseline-source replacement is authorized. An exact historical replay, if needed, is a separate orchestrator-approved scoped task, not a prerequisite invented to stall ready work.
- [ ] **Step 6 — Emit bounded payload-free results** with prefix `CALENDAR_TOOL_LATENCY` and keys `commitSet`, `scenario`, `mode`, `preparation`, `priorTurns`, `measurementKind`, `fixtureConstants`, `stages`, `logicalOperations`, `commandCounts`, `providerCounts`, `waves`, `unresolvedCommands`, `limitations`. Store readable rows and evidence locations in `verification.md`. No request text, event content, auth headers, tokens, connection strings or raw DB queries. Never claim live/native/full-suite certification or zero network/CPU latency.

## Task 8: Run required regressions and write the verification matrix

**Files:** new tests/fixtures and `verification.md` only; route all production failures to their owners. Load `systematic-debugging` for unexpected behavior, preserve the failing test and gather root-cause evidence before proposing a correction.

- [ ] **Step 1 — Run integrated and focused gates separately in `backend/`, sanitized environment.**

```powershell
npm test -- test/performance/calendar-tool-latency.spec.ts
```

```powershell
npm test -- test/performance/calendar-memory-first.spec.ts test/performance/memory-calendar-state.spec.ts test/performance/memory-text-archive.spec.ts test/performance/memory-first-foundation.spec.ts test/performance/memory-first-text.spec.ts test/performance/memory-first-voice.spec.ts test/performance/calendar-voice-latency.spec.ts test/performance/calendar-critical-path.spec.ts test/context/calendar-context.spec.ts test/runtime/calendar-operation.spec.ts test/runtime/calendar-confirmation.spec.ts test/runtime/calendar-recovery.spec.ts test/runtime/calendar-recovery-unavailable.spec.ts test/runtime/calendar-multi-recovery.spec.ts test/runtime/calendar-memory-voice.spec.ts test/runtime/calendar-voice-authority.spec.ts test/persistence/calendar-multi-operations.spec.ts test/persistence/calendar-mutation-session.spec.ts test/persistence/calendar-debit-receipts.spec.ts test/persistence/calendar-multi-retention.spec.ts test/plugins/google-calendar/connection-prepared.spec.ts test/plugins/google-calendar/tools-boundaries.spec.ts test/plugins/google-calendar/tools-multi.spec.ts test/assembly/calendar-capability.spec.ts test/assembly/calendar-invalidation.spec.ts test/assembly/auth-calendar.spec.ts
```

- [ ] **Step 2 — Run each required package command independently:**

```powershell
npm run build
```

```powershell
npm run lint
```

```powershell
npm test
```

```powershell
npm run test:e2e
```

Record actual discovered/pass/failure/skip counts, lint warnings, unhandled errors/worker crashes and exits. Native suites may skip with `AURVIN_TEST_MONGODB_URI` absent; explain prerequisites and **not run** service coverage. Do not run `test:azure`/`test:behavior` merely to obtain zero from empty discovery. No application URI fallback or live provider use. Full suite failure is still a full suite failure even if this workflow's focused tests pass.

- [ ] **Step 3 — Canvas/shared-mode regressions:** run `npm test -- test/runtime/canvas-navigation.spec.ts test/runtime/canvas-navigation-ownership.spec.ts test/voice/integration/canvas-navigation.spec.ts test/voice/integration/canvas-multimodal.spec.ts`. Some paths are concurrently dirty: execute without reading/changing them and label results against the exact dirty checkout, not a clean committed implementation. If frontend changes remain in the final assembled checkout, coordinate its owner/orchestrator to run separately in `frontend/`: `npm run build`, `npm run lint`, `npm test`. P4 edits no frontend source; report unchanged/not-run versus concurrent-source verification accurately.
- [ ] **Step 4 — Fill this acceptance matrix with actual named tests, commit(s), command evidence and outcome:**

| Goal | Required P4 evidence | Primary defect owner |
| --- | --- | --- |
| AC1 | Four real prepared routes, blocked application stores/held archive, real budgets/authority/provider | P1/P2 |
| AC2 | Complete pair/input once, next model dispatch and eligible follow-up before held saves, live terminal delivery retained | P2; P3 for mutation follow-up |
| AC3 | Direct/proposal essential acknowledgements before POST; already-held archive owner/global tail independent; no prior replay/checkpoint wait | P1/P3 |
| AC4 | W1–W4 and split acknowledgements, original identity/readback, duplicate/retry/cancel, success/archive failure, no blind POST | P3 |
| AC5 | Lifecycle/target/expiry/current and queued evidence, cross-user/account/session/text/live races and privacy canaries | P1/P2/P3 by boundary |
| AC6 | Prepared/cold/read/availability/direct/confirmation, commands/waves/stages, matched/unmatched baselines, synthetic/live distinction | P4 evidence; P1–P3 behavior |
| AC7 | Baseline/focused/full/e2e/build/lint, frontend condition, actual skips/failures/crashes; review skipped | All owners/orchestrator |
| AC8 | Final root policy added after evidence, exact instruction/test/source consistency, honest exceptions | P4 |

- [ ] **Step 5 — Classify defects by evidence:** introduced (fails at new commit after known passing prerequisite), independently reproduced baseline (same test/conditions/commit), concurrent-dirty attribution uncertain, fixture defect, prerequisite/service skip, or not run. A source hypothesis is not baseline proof. Retain the two capability failures, two voice profile failures and voice crash/skips until actual reruns/owner fixes or reproducible baseline evidence resolve their classification. Send failure handoff promptly; continue independent ready verification, not unrelated fixes.
- [ ] **Step 6 — Commit the test/evidence slice after serialized permission.** Inspect `git diff --check`, named-path diff/stat and `git diff --cached --name-only`. Stage only new P4 files; exclude root policy until Task 9. Commit message: `test(calendar): verify integrated tool critical paths and recovery`. If defects block acceptance, commit honest partial evidence only with orchestrator agreement and report **blocked**, not completed.

## Task 9: Add the final verified future-tool policy, then check consistency

**Files:** root `AGENTS.md` and `docs/calendar-tool-latency/verification.md` only, after implementation and evidence exist. Load **`agents-markdown-setup`** now, not during planning; obey its source-evidence and compact-instruction rules without rewriting unrelated root content.

- [ ] **Step 1 — Check the policy gate.** Require P1–P3 committed behavior, V2/V3 integrated acceptance passing, V4 actual results recorded and required failures explicitly resolved/dispositioned with the orchestrator. If any proposed instruction is not implemented/tested, do not publish it as a guarantee: route the gap to the owner and leave the policy task blocked. Existing unrelated baseline failures do not become a false clean-suite claim.
- [ ] **Step 2 — Append this compact instruction section** adjacent to `Reliable chat behavior`, preserving the existing memory-first chat rule and all other instructions. This is the proposed exact wording; only tighten it if actual verified behavior requires a more restrictive statement, and record that mapping:

```markdown
### Tool execution critical path

- Classify each tool by effect: local presentation, external read, or external mutation. Reuse the existing runtime/executor and authority owner; preserve the Canvas memory-first path and supported text/live-voice boundaries.
- Prepared, valid-memory reads/local effects must not await application DB work, ownership promotion, chat/archive flushes, accounting replay or graph checkpoints before dispatch/result/continuation/eligible follow-up. Keep in-memory argument/domain, identity/account/target, consent/access, cancellation/deadline, concurrency and finite request/result/context checks. Revalidate expiry/revocation before consumption and publication; never trade privacy or coverage for speed.
- Cold hydration, credential/discovery refresh, stale/invalidated state and recovery are explicit bounded I/O or safe-unavailable paths. Do not omit history, reuse stale authority, invent complete coverage or promise zero provider/network/CPU latency. Prepared authority is process-local, not multi-instance coherence.
- External mutations require acknowledged minimal durable evidence for the exact user-authorized action, account/target, accepted input/attempt, single-use intent/proposal, safety debit and stable operation/provider identity before the effect. Fresh authority/capability/preflight and final cancellation/deadline/fence checks remain mandatory. Unrelated archives must not join that barrier; failed/uncertain essential durability means no mutation dispatch.
- Preserve original identity through crashes, retries and ambiguous delivery. Dispatching/unknown Calendar creates reconcile by pinned-ID readback, never blind POST replay; confirmed success survives missing narration/archive. Keep action-confirmed and archive-saved states distinct; do not claim exactly-once effects/billing or guaranteed charge prevention by cancellation.
- Consolidate nonessential transcript/tool/accounting evidence in the existing tracked, bounded, ordered asynchronous saver. Retain complete call/result pairs, permission/retention projection, visible pending/failed/unknown status, finite retry/backlog/age/byte limits and raw-write-aware shutdown/drain. Temporary archive failure alone permits safe reads only within those bounds; invalid authority, fences, inconsistency or exhausted limits stop affected work. One logical save is not one physical command or a cross-collection transaction.
- Verify tool changes on real assembled routes with deterministic providers and no guard overrides: blocked-store prepared reads/continuation/follow-up; held-archive versus essential-barrier ordering; failed/uncertain barriers with zero effects; crash windows/original-ID recovery; revocation/expiry and text/live-voice isolation. Run `npm test -- test/performance/calendar-tool-latency.spec.ts` in `backend/`, plus affected regressions/build/lint; report command/wave/stage measurements, cold exceptions, failures/skips and synthetic versus authorized live evidence honestly. See `docs/calendar-tool-latency/verification.md` for the measured commit set and limitations.
```

- [ ] **Step 3 — Verify instructions against evidence, not document existence.** Map every sentence to the actual owner/source plus a named passing check in `verification.md`; ensure prepared-path wording does not erase cold/recovery exceptions or the fresh mutation checks. Ensure temporary save failure never authorizes an uncertain external effect, and model-schema validity is not user consent. Check complete pairing/privacy, stable operation identity, unchanged finite limits, single-executor topology and supported modes. Confirm no new unconditional pre-model DB requirement contradicts the existing memory-first rule. The existing root instruction to use MAW/review-skipped workflows is untouched.
- [ ] **Step 4 — Document/link/path and preservation checks:** root policy path points to the actual verification artifact; goal AC8 maps to this addition; current plans/state gates do not claim final report completion. Compare the root diff: it must contain only this additive section, with no deletion/reformatting of unrelated instructions. Check all relative Markdown links, named existing paths and expected new paths, code headers and `.js` imports; run `git diff --check`. No unrelated application suite rerun is required for the final documentation-only addition after the recorded code checks, unless source changed since those checks.
- [ ] **Step 5 — Commit after permission:** `git add -- AGENTS.md docs/calendar-tool-latency/verification.md`, inspect staged paths, then `git commit -m "docs(calendar): record verified tool execution policy"`. Do not stage goal/state/final_report, generated output, unrelated changes or secrets.
- [ ] **Step 6 — Return final-report input:** exact prerequisite/P4 commit set; changed paths; all AC1–AC8 outcomes; commands/counts/skips/failures/crashes; prepared/cold command/wave/stage profiles and baseline comparability; four-window recovery results; policy skill/consistency check; dirty-checkout and forward-native-format rollback limitations; live/native/transport checks not run; review **skipped**. The orchestrator writes `final_report.md` and updates workflow state. Do not mark the entire workflow complete yourself.

## Planner self-check and plan-only commit

- Spec coverage: Tasks 2–3 cover AC1/AC2; Task 4 covers AC3; Task 5 covers AC4; Task 6 covers AC5; Task 7 covers AC6; Tasks 1/8 cover AC7 and open-baseline honesty; Task 9 covers AC8 only after evidence. Every production defect routes to its owner; no review dispatch or separate worktree.
- Type/interface discipline: real AppService/runtime/bundle, one prepared-authority owner, stock saver and explicit synthetic providers; no guard/receipt fabrication. Reconcile P3's actual handoff before the worker writes tests; the fixture code is not evidence of a passing implementation. Context7 Vitest 4.1.6 documentation was consulted for async assertion polling and spy restoration; repository source defines the application interfaces.
- Planning verification is document/path/link/ownership/whitespace consistency only. **No application tests or implementation run by this planner.** Future verification/fixtures/policy are intentionally not created by this plan commit. Preserve unrelated dirty files and the shared index.

Required planning commit from repository root (PowerShell supports `&&`; stage only this file and verify the index first):

```powershell
git add -- docs/calendar-tool-latency/plan4.md && git commit -m "docs(calendar-tool-latency): plan 4 - integrated verification"
```
