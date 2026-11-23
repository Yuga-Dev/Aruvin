# P1 Prepared Calendar Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository, use the installed `test-driven-development` skill before implementation; the MAW orchestrator already assigns this worker, so do not dispatch another worker or reviewer.

**Goal:** Let the existing prepared Calendar read executor admit requests using bounded, current server memory without connection-storage waits, while retaining fresh mutation authority, credential privacy, finite budgets, and synchronous invalidation.

**Architecture:** Keep one encrypted connection snapshot in the existing per-user `GoogleCalendarConnections` owner and reuse its existing lifecycle epoch, persisted revisions, refresh flights, capability gate, and executor. Make prepared reads an explicit opt-in; fresh persisted checks remain the default and are mandatory for creates and reconciliation. Decrypt access credentials only inside `withAccessToken`, with no persistent plaintext-token cache or new authority framework.

**Tech Stack:** Existing Node.js/TypeScript ESM/NodeNext, NestJS composition, Zod contracts, Mongo connection-store ports, deterministic fetch fixtures, and Vitest; no new dependency, collection, framework, or persistent schema.

---

## Scope, prerequisites, and what this plan does not prove

- Approved sources: [`goal.md`](goal.md), research-reconciled [`state.md`](state.md), and [`research.md`](research.md), research commit `b66fe00`. Planning baseline: `53c774f`; working tree was clean before this document was created.
- P1 worker starts after this plan is committed. Refresh Git status first; preserve intervening edits. Coordinate staging/commits with the MAW orchestrator.
- P1 owns provider authority and assembly only. Do not edit runtime read promotion, memory accounting/archive/retention, mutation operation persistence, root `AGENTS.md`, or other workflow records. Those belong to P2, P3, and P4.
- The P1 exit test is the **real assembled provider executor**, not a claim that the complete HTTP/model/runtime route is already memory-first. P2 removes remaining hydration/promotion/save waits; P4 proves the integrated route. Do not change old read-promotion expectations in `calendar-memory-first.spec.ts` here.
- No live Google/OpenRouter/database calls, application-data access, paid checks, restart, provisioning, or deployment. All provider and storage work below is deterministic in-process fixture work. Unified code review is **skipped**, not passed.

## Minimum design decision: challenge the research cache proposal

1. A prepared encrypted connection record is necessary: `statusV2`, account lookup, discovery, executor admission, and credential lookup otherwise repeatedly call `integration_connections`.
2. A second `authorityEpoch` is unnecessary: `lifecycleEpoch`, already used by OAuth snapshots and effect gating, detects consent/disconnect/fence/close races. Reuse it. Persisted `connectionRevision`, `credentialVersion`, `defaultSettingRevision`, and discovery revision already identify the other changes.
3. A decrypted-token cache is unnecessary: AES-GCM decryption is local bounded CPU work, not the sequential database wait being removed. Do **not** store `decryptedAccess`, a token hash, or a plaintext token field on the connection, runtime binding, session, status, prompt, or archive. `withAccessToken` opens the selected encrypted access token immediately before its callback and drops its local reference in `finally`.
4. One per-owner prepared slot is enough: `undefined` means cold, `null` means confirmed absent, otherwise a bounded v1/v2 record. Retain the schema's 262,144-byte record ceiling; return defensive copies, not a caller-mutable cache object. No global map, TTL daemon, new concurrency limiter, or generic cache abstraction.
5. Revocation needs more than clearing a slot: a concurrent store read could otherwise rehydrate the same revoked revision. Keep at most **one private revoked-account watermark** per connection owner, containing only the four account-binding identifiers. It rejects that connection/subject's revisions at or below the invalidated revision. A newer confirmed account is independent; old callbacks must not fence its replacement. This is bounded revocation evidence, not another authority cache.
6. Do not bump the lifecycle epoch for a harmless token rotation, unchanged discovery, or default preference save. Preference changes do not revoke a correctly pinned create. Instead, recheck the current default for implicitly selected read targets and compare current target access/private visibility before dispatch/publication.

Add a `ponytail:` comment at the prepared slot: process-local single-executor, all production connection mutations go through this owner, and restart/explicit invalidation requires hydration. Out-of-process database edits are not a supported coherent live-authority channel. Standalone adapters without the optional authority owner retain fresh store reads.

## File map and handoff contracts

### Owned production paths

- `backend/src/contracts/calendar-authority.ts`: small shared account-check options/authority port; existing proposal/consumption contracts unchanged.
- `backend/src/contracts/calendar-operations.ts`: inspect as the execution boundary; **leave its persisted schemas and bindings unchanged**. No epoch, token, or prepared snapshot belongs in `CalendarExecutionBindingV2` or an operation record.
- `backend/src/chat-runtime/calendar-ports.ts`: compatible optional fresh-check argument and scoped synchronous invalidation hook for P2.
- `backend/src/plugins/google-calendar/connection.ts`: sole prepared snapshot owner; fresh fallback, monotonic write-through, credential opening, and lifecycle/revocation guards.
- `backend/src/plugins/google-calendar/discovery.ts`: propagate check mode, use warmed account checks on unchanged reads, and preserve fresh refresh/CAS/rebase and provider capability checks.
- `backend/src/plugins/google-calendar/tools.ts`: optional owner-backed admission for reads/creates; default standalone fallback; pre/post-request and post-read publication checks.
- `backend/src/operations/calendar-assembly.ts`: wire the existing connection owner into executor, discovery, and runtime, without constructing another owner.
- `backend/src/app.service.ts`: warmed owner status and immediate account invalidation before stream quiescence/retention I/O.

### Test paths

- Create `backend/test/plugins/google-calendar/connection-prepared.spec.ts` for focused cold/prepared/fresh/race cases. Include the required repository code-file header on first write.
- Extend `backend/test/plugins/google-calendar/tools-boundaries.spec.ts` with assembled executor blocked-store/race checks.
- Extend `backend/test/plugins/google-calendar/tools-multi.spec.ts` only for owner-backed versus standalone admission and publication cases.
- Extend focused existing `backend/test/plugins/google-calendar/connection-refresh.spec.ts`, `connection-settings.spec.ts`, `connection-capabilities.spec.ts`, and `discovery.spec.ts` as needed for the explicit cases below. Existing headers are already present.
- Reuse, do not rewrite, `backend/test/plugins/google-calendar/connection-multi-fixtures.ts`, `tools-multi-fixtures.ts`, `tools-fixtures.ts`, and `oauth-fixtures.ts`. Keep new helpers local to the new focused spec or boundary spec unless an existing helper genuinely needs a backward-compatible option.

### Exact interfaces supplied to P2/P3

In `calendar-authority.ts`, import `CalendarConnectionRecordV2` as a type and add:

```ts
/** Prepared reads opt in; absence of options preserves fresh persisted authority. */
export type CalendarAccountCheckOptions = Readonly<{ fresh?: boolean }>;

export interface CalendarAccountAuthority {
  requireAccountCurrent(account: CalendarAccountBinding, signal: AbortSignal,
    options?: CalendarAccountCheckOptions): Promise<CalendarConnectionRecordV2>;
  getLifecycleEpoch(): number;
}
```

Extend `CalendarCapabilityGate.requireCurrent` input with optional `fresh?: boolean`. `operation: 'create'` always forces fresh checks even if a caller passes `false`; readback passes `fresh: true`. `resolve` already carries the operation and needs no extra public flag.

In `calendar-ports.ts`, retain the existing structural shape and make additions compatible with standalone test dependencies:

```ts
connection: {
  currentAccount(): Promise<CalendarAccountBinding>;
  requireAccountCurrent(account: CalendarAccountBinding, signal: AbortSignal,
    options?: CalendarAccountCheckOptions): Promise<CalendarConnectionRecordV2>;
  invalidateAccount?(account: CalendarAccountBinding): void;
};
```

`currentAccount()` and `statusV2()` use the prepared slot when populated. `requireAccountCurrent(account, signal)` stays **fresh by default**; `{ fresh: false }` is the only prepared-read opt-in. Cold prepared access hydrates safely or fails; it never fabricates a connected account. `invalidateAccount(account)` is synchronous, scoped, idempotent for the same revoked watermark, and never performs storage I/O or invokes invalidation callbacks recursively.

In `tools.ts` add one optional dependency, retaining `connections.get` as fallback:

```ts
authority?: CalendarAccountAuthority;
```

No new public credential API is needed. `CalendarAccountCredentialPort.withAccessToken` stays unchanged. P2 will use `{ fresh: false }` for read-only runtime checks and call `connection.invalidateAccount?.(account)` from its existing memory invalidation entry point. P3 will keep default/`{ fresh: true }` checks at the durable mutation boundary. Do not make those downstream edits in P1.

## Task 1: Capture the focused baseline and add the cold/prepared contract test

**Files:** new `backend/test/plugins/google-calendar/connection-prepared.spec.ts`; inspect the production and fixture paths listed above.

- [ ] **Step 1 — Capture clean/dirty state and deterministic prerequisites.** In repository root run `git status --short --branch`, `git rev-parse HEAD`, and `node --version` separately. In the worker's shell clear `AURVIN_TEST_MONGODB_URI` before checks, without printing its value:

```powershell
Remove-Item Env:AURVIN_TEST_MONGODB_URI -ErrorAction SilentlyContinue
```

- [ ] **Step 2 — Run existing focused checks before editing.** Working directory `backend/`:

```powershell
npm test -- test/plugins/google-calendar/tools-boundaries.spec.ts test/plugins/google-calendar/tools-multi.spec.ts test/plugins/google-calendar/connection-multi.spec.ts test/plugins/google-calendar/connection-settings.spec.ts test/plugins/google-calendar/connection-refresh.spec.ts test/plugins/google-calendar/connection-capabilities.spec.ts test/plugins/google-calendar/discovery.spec.ts
```

Expected: real test discovery and all selected tests pass. Record exact counts/failures; research's 124-test result covered a different file set and is not this worker's baseline. Reproducible baseline failures are reported, not silently deleted.

- [ ] **Step 3 — Write the first failing test.** Import `expect`, `it`, `vi`, and `multiConnectionFixture` in the new spec. Add this test; it intentionally fails on today's unconditional `currentAccount()` store lookup:

```ts
it('reuses warmed status and account without opening connection storage', async () => {
  const f = await multiConnectionFixture();
  const get = vi.spyOn(f.adapter.v2, 'get');
  try {
    await f.service.statusV2();
    expect(get).toHaveBeenCalledTimes(1);
    get.mockRejectedValue(new Error('prepared path touched storage'));
    const account = await f.service.currentAccount();
    expect(account.userId).toBe('u1');
    expect(await f.service.requireAccountCurrent(account,
      new AbortController().signal, { fresh: false })).toMatchObject({
      connectionId: account.connectionId, connectionRevision: account.connectionRevision,
    });
    expect((await f.service.statusV2()).connectionRevision).toBe(account.connectionRevision);
    expect(get).toHaveBeenCalledTimes(1);
  } finally { get.mockRestore(); await f.service.close(); }
});
```

- [ ] **Step 4 — Run red.** `npm test -- test/plugins/google-calendar/connection-prepared.spec.ts -t "reuses warmed status"`. Expected: failure with the blocked-store error, not a provider/network call. The new optional argument is added in Task 2; type-aware build is run after the interface change.

## Task 2: Add the small explicit authority port and one coherent prepared slot

**Modify:** `backend/src/contracts/calendar-authority.ts`, `backend/src/chat-runtime/calendar-ports.ts`, and `backend/src/plugins/google-calendar/connection.ts`.

- [ ] **Step 1 — Add the exact interfaces above.** Keep `.js` local import specifiers. Do not add mandatory members to existing runtime mocks. Do not change `calendar-operations.ts` schemas.

- [ ] **Step 2 — Add the prepared slot and local account validation.** The connection class needs these private fields, not the research's multi-layer cache:

```ts
private preparedRecord: CalendarConnectionRecord | CalendarConnectionRecordV2 | null | undefined;
private revokedAccount: CalendarAccountBinding | null = null;
```

Use one local record-reading helper for `status`, `statusV2`, `currentAccount`, and `requireAccountCurrent`. Its explicit algorithm is:

1. A prepared request returns a defensive copy of the populated slot, including confirmed `null`.
2. A cold or fresh request captures `lifecycleEpoch` and the slot reference, then calls the existing store once. Do not cache a thrown read or convert failure to absence.
3. After the await, reject an epoch mismatch/closing/fenced execution before returning usable authority. Status may still project a degraded state but must not publish a pre-invalidation connected snapshot.
4. When a newer confirmed write changed the slot while that get was pending, do not let the older result replace it. Compare record revision for the same owner and preserve the newer record; a late `null` must not erase a newer confirmed create. Revalidate the selected result against current flags/watermark, not the captured old result.
5. Reuse the existing account/identity/enabled/configured/grant/status checks; add the credential presence check for access and refresh before treating an account as usable. Validate owner `userId` as well as connection/revision/subject. Check cancellation both before and after any await.

The implementation-mode selection must be this restrictive:

```ts
const fresh = options?.fresh !== false;
```

`currentAccount`/status deliberately request prepared mode; standalone/default `requireAccountCurrent` remains fresh. Do not put a store read inside the pure account-check predicate.

- [ ] **Step 3 — Add a red/green fresh-default test before changing caller routing.** In the new spec:

```ts
it('keeps default authority fresh when the backing account changes', async () => {
  const f = await multiConnectionFixture();
  try {
    const account = await f.service.currentAccount();
    await f.patch({ enabled: false, connectionRevision: account.connectionRevision + 1,
      discovery: null });
    await expect(f.service.requireAccountCurrent(account, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'CALENDAR_EXECUTION_DENIED' } });
    await expect(f.service.requireAccountCurrent(account, new AbortController().signal,
      { fresh: false })).rejects.toBeDefined();
  } finally { await f.service.close(); }
});
```

The fresh get must also replace/drop the previously prepared usable record. Add two small cases in this same spec: confirmed absence is reused without additional gets; a failed cold get can be retried and is not cached as absence.

- [ ] **Step 4 — Run focused green.** `npm test -- test/plugins/google-calendar/connection-prepared.spec.ts`. Expected: both contract tests and cold cases pass with real discovery, zero live calls. Run `npm run build` to catch port compatibility errors before proceeding.

## Task 3: Write through confirmed connection changes and close invalidation races

**Modify:** `backend/src/plugins/google-calendar/connection.ts`; **test:** `connection-prepared.spec.ts`, `connection-settings.spec.ts`, `connection-refresh.spec.ts`.

- [ ] **Step 1 — Write the stale-hydration regression first.** Use the existing `deferred` helper from `oauth-fixtures.ts` and add to the prepared spec:

```ts
it('does not resurrect a revoked account from a get already in flight', async () => {
  const f = await multiConnectionFixture();
  const account = await f.service.currentAccount();
  const old = (await f.read())!;
  const held = deferred<typeof old>();
  const get = vi.spyOn(f.adapter.v2, 'get').mockImplementationOnce(() => held.promise);
  const pending = f.service.requireAccountCurrent(account, new AbortController().signal)
    .then(() => 'allowed', () => 'denied');
  try {
    f.service.invalidateAccount(account);
    held.resolve(old);
    expect(await pending).toBe('denied');
    await expect(f.service.requireAccountCurrent(account, new AbortController().signal,
      { fresh: false })).rejects.toBeDefined();
  } finally { held.resolve(old); await pending; get.mockRestore(); await f.service.close(); }
});
```

Run `npm test -- test/plugins/google-calendar/connection-prepared.spec.ts -t "does not resurrect"`. Expected red before the scoped invalidation implementation.

- [ ] **Step 2 — Implement scoped revocation and existing-epoch invalidation.** `invalidateAccount` records only a matching current/cold owner's watermark, clears that account's prepared usable data, advances the existing lifecycle epoch, aborts discovery/refresh work, and clears the proactive timer. Ignore wrong-user and demonstrably older-account callbacks when a newer/replacement account is already known. Repeated invalidation of the same watermark is idempotent; it must not endlessly advance the epoch or call `onAccountInvalidated` again.

The local rejection predicate uses all relevant binding fields:

```ts
const revoked = this.revokedAccount;
if (revoked && account.userId === revoked.userId
  && account.connectionId === revoked.connectionId
  && account.googleSubjectId === revoked.googleSubjectId
  && account.connectionRevision <= revoked.connectionRevision) {
  throw toolFault('policy', 'CALENDAR_EXECUTION_DENIED');
}
```

Apply it after hydration and before every credential callback. `invalidateLifecycle`, `cancelPendingWork`, `beginConsent`, `fence`, `close`, reconnect-required transitions, and uncertain credential/connection writes clear prepared usable state at their **synchronous pre-await** point. Begin-consent and reconnect mark the old revision revoked before starting storage work; clearing alone must not allow a parallel read to reload it. Keep `hardFenced` on uncertain authority writes.

- [ ] **Step 3 — Centralize confirmed write-through without a new framework.** Wrap only this owner's injected `CalendarConnectionStoreV2` inside `connection.ts`; pass that same small wrapper to `CalendarDiscoveryService`. Its `get` performs fresh I/O and safe publication; `create`/`compareAndSwap` delegate unchanged, publish **`result.record` only on `confirmed`**, and drop prepared state on conflict/uncertainty. This catches install, settings, disconnect, refresh rotation, discovery writes, and capability-driven CAS in one place instead of one cache patch per caller. Never substitute an unacknowledged `next` record. Preserve CAS/rebase semantics and the underlying AppService tracking/owner guards.

Publication after an await captures the existing epoch; a late completion across close/revoke cannot repopulate the slot. Monotonic revision checks prevent a slower lower-revision get/CAS result replacing a newer confirmed record. A conflict invalidates the read slot so existing fresh rebase actually reloads storage; uncertainty additionally fences affected execution.

- [ ] **Step 4 — Keep refresh fresh and credentials local.** All store-backed refresh admission/rebase calls in `leadRefreshV2`, plus setup/install/settings/disconnect and unauthorized-account resolution, remain fresh (default or explicit `true`). `withAccessToken` may use `{ fresh: false }` after owner/operation admission, retaining synchronous-refresh/proactive margins and single-flight rotation; a cold/expired token still follows the existing refresh path. Preserve the rule that newly refreshed credentials are not used until their CAS is acknowledged.

After account/deadline checks, the credential lifetime outline is:

```ts
let accessToken: string | null = null;
try {
  accessToken = this.cipher.openToken(tokenAad(record, 'access'), record.credentials!.access!);
  this.assertDeadline(deadlineAt, signal);
  return await action(accessToken);
} finally {
  accessToken = null;
}
```

Retain the existing `RECONNECT_REQUIRED` mapping for decryption failure; do not expose cipher/provider exception text. Capture/recheck lifecycle/account after legitimate refresh and before callback; after a read callback settles, tools perform the publication guard in Task 5. Do not automatically retry the callback on 401, particularly a create. Clearing JS references is not a cryptographic zeroization guarantee.

- [ ] **Step 5 — Add focused race/rotation assertions before each corresponding change.** Tests must cover: get paused across close; older get paused across a newer settings/credential CAS; disconnect/disable/consent before the first lifecycle store await; same-subject re-consent with new revision; a late old-account 401/invalidation after replacement; confirmed token rotation visible to the next prepared call; failed/uncertain CAS never exposes new tokens; ten refresh callers still share one refresh and one refresh-budget debit. Existing direct fixture `patch` calls modelling external writes must use an explicit fresh check before expecting prepared state to change; do not quietly weaken standalone fallback tests.

- [ ] **Step 6 — Run green and make a focused checkpoint.** In `backend/`:

```powershell
npm test -- test/plugins/google-calendar/connection-prepared.spec.ts test/plugins/google-calendar/connection-multi.spec.ts test/plugins/google-calendar/connection-settings.spec.ts test/plugins/google-calendar/connection-refresh.spec.ts
```

Expected: no regression to preference revisioning, scope/subject checks, durable rotation, or callback non-retry. After orchestrator commit permission, stage only the actual Task 1–3 files and commit `feat(calendar): prepare owner authority without credential leakage`.

## Task 4: Make discovery account checks prepared without weakening provider capabilities

**Modify:** `backend/src/plugins/google-calendar/discovery.ts`, `connection.ts`; **test:** `discovery.spec.ts`, `connection-capabilities.spec.ts`, `connection-prepared.spec.ts`.

- [ ] **Step 1 — Add the failing unchanged-read check.** In the prepared spec, reuse `multiConnectionFixture` but construct a local connection owner with the production-style `checkTarget` port as shown below. The existing multi-connection helper has no `checkTarget`, so using it unmodified here would test the explicit full-refresh fallback instead of the prepared production path. Unchanged target evidence retains its original discovery lifetime and avoids a no-op CAS.

Core assertion after setup is:

```ts
const f = await multiConnectionFixture();
const service = new GoogleCalendarConnections({
  store: f.adapter, storeV2: f.adapter.v2, cipher: f.cipher, options: f.options,
  userId: 'u1', client: f.client, now: f.now,
  retentionPolicy: () => ({ policyId: 'fixture-policy',
    expiresAt: new Date(f.now() + 300000).toISOString() }),
  discovery: { discover: f.discover, checkTarget: async input => {
    await input.consumeRequest('capability-recheck');
    return f.entries.find(entry => entry.calendarId === input.calendarId) ?? null;
  } },
});
const request = { ...await f.request('read', 'shared-team'), account: await service.currentAccount() };
const resolved = await service.resolveTarget(request);
if (resolved.outcome !== 'resolved') throw new Error('fixture target missing');
const get = vi.spyOn(f.adapter.v2, 'get').mockRejectedValue(new Error('blocked connection read'));
const cas = vi.spyOn(f.adapter.v2, 'compareAndSwap').mockRejectedValue(new Error('blocked CAS'));
try {
  await service.requireTargetCurrent({ ...request, target: resolved.target });
  expect(get).not.toHaveBeenCalled();
  expect(cas).not.toHaveBeenCalled();
  expect(request.consumeRequest).toHaveBeenCalled();
} finally {
  get.mockRestore(); cas.mockRestore(); await service.close(); await f.service.close();
}
```

Run `npm test -- test/plugins/google-calendar/connection-prepared.spec.ts -t "unchanged"`; name the complete case `checks unchanged read capability with storage blocked`. Expected red before routing changes. Do not mock out `capabilityGate` or `requireTargetCurrent`.

- [ ] **Step 2 — Propagate explicit mode through existing checks.** Extend the discovery dependency callback's optional third argument with `CalendarAccountCheckOptions`. `resolveTarget` uses prepared account checks for read/availability and fresh for create; `requireTargetCurrent` forces fresh for create or `input.fresh === true`, otherwise uses prepared checks before/after the provider check. Supply that same mode to `checkTarget` and its pre-/post-budget guards.

Keep provider `checkTarget`/bounded fallback delivery on the effect path; warmed authority does not justify skipping it. The no-`checkTarget` adapter fallback remains a full fresh bounded discovery refresh, not the prepared zero-storage route; an unchanged snapshot still avoids a no-op CAS. If production `checkTarget` evidence actually differs, crosses retention/freshness bounds, or needs persistence, enter the explicit refresh path: reload fresh authority before CAS/rebase and charge existing request/refresh budgets. Do not claim zero storage for cold/changed/legacy-refresh paths.

- [ ] **Step 3 — Revalidate current target evidence, not an old private-access projection.** After provider checks, compare latest account authority, lifecycle epoch, calendar identity, access role, and `privateAccess` to the resolved target before permitting its use. A full-private target that became masked must fail rather than deliver the old unmasked projection. Use `effectiveCalendarCapabilities` with current scopes/entry, not caller-provided capability booleans. Read-only/freeBusy/hidden/deleted rules remain unchanged.

For an implicit read target (`selectedBy` saved-default or automatic primary and no explicit `calendarId` selector), check the latest default still selects that calendar. Do not change `connectionRevision` or revoke pinned authorized operations just because a default preference changed. A missing saved default still clarifies; no silent primary fallback.

- [ ] **Step 4 — Reject expired/in-flight obsolete discovery.** `ensureFresh` keeps both freshness and retention expiry tests. Recheck cancellation/deadline and current epoch/authority after awaited provider/budget work and before returning metadata. A changed-target CAS that is `uncertain` cannot leave old prepared rights available: invalidate/fence through the owner and fail closed; conflict takes the existing bounded fresh rebase/failure route. Never restore old complete coverage over a returned partial result or extend unchanged snapshot lifetime.

- [ ] **Step 5 — Add red/green cases in existing discovery/capability suites.** Cover expiry exactly at the boundary, retention expiry with a still-fresh cache timestamp, partial/no-store discovery, old discovery completion after disconnect/replacement, revoked reader/masked access, unchanged snapshot no-CAS, changed-role CAS conflict/uncertainty, provider request-budget rejection, and create target checks with storage blocked. The create case must fail without an event POST. Preserve existing 401 → one refresh → one bounded second read behavior.

- [ ] **Step 6 — Run focused green.**

```powershell
npm test -- test/plugins/google-calendar/connection-prepared.spec.ts test/plugins/google-calendar/discovery.spec.ts test/plugins/google-calendar/discovery-pages.spec.ts test/plugins/google-calendar/connection-capabilities.spec.ts test/plugins/google-calendar/connection-settings.spec.ts
```

Expected: actual discovery of all files and passing provider-rights, expiry, pagination, default-setting, and bounded-delivery assertions.

## Task 5: Prove and wire real assembled read dispatch with application storage blocked

**Modify:** `backend/src/plugins/google-calendar/tools.ts`, `backend/src/operations/calendar-assembly.ts`; **test:** `tools-boundaries.spec.ts`, `tools-multi.spec.ts`.

- [ ] **Step 1 — Add a small local assembled fixture in the boundary spec.** Reuse `multiConnectionFixture`, `fakeFetch`/`googleJson`/`googleEvent`, and `createCalendarAssembly`. Inject the existing fixture adapter/cipher key, `f.options`, retained or volatile fixture policy, `Date.now` mocked to `f.now`, and a deterministic discovery port. Its `checkTarget` callback must call `request.consumeRequest('capability-recheck')` before returning the matching fixture entry. No public gate/admission function may be replaced.

The assembly construction is this concrete outline:

```ts
const owner = createCalendarAssembly({
  config: { setup: f.options,
    permission: { content: 'volatile', minimalEvidenceAllowed: true, policyId: 'fixture-policy' },
    policyDeadlines: [f.now() + 3600000], trustedTimeZone: 'Etc/UTC' },
  encryption: { status: 'ready', key: Buffer.alloc(32, 7) },
  userId: 'u1', store: f.adapter, storeV2: f.adapter.v2,
  discovery: { discover: f.discover, checkTarget: async request => {
    await request.consumeRequest('capability-recheck');
    return f.entries.find(entry => entry.calendarId === request.calendarId) ?? null;
  } },
  fetcher: fake.fetcher, onAccountInvalidated: async () => undefined,
});
```

Set the `Date.now` spy before building bindings/assembly; restore it and all storage spies in `finally`, close `owner.connections`, `owner.execution`, and `f.service`, and release every deferred promise even on failure. Provider requests use fixture-only fetch and consume their normal budgets.

- [ ] **Step 2 — Add the red assembled test before changing executor wiring.** Warm `owner.connections.statusV2()`, get its account, and resolve `'shared-team'` through its real gate. Build the v2 binding directly with the existing schema; the standalone `multiBinding` helper hardcodes another account and must not be called with this target:

```ts
const binding = calendarExecutionBindingV2Schema.parse({
  ...account, target: resolved.target, sessionId: 's', turnId: 't', attemptId: 'a',
  decisionId: 'd', toolCallId: 'tc', schemaRevision: 'google-calendar.v2', operation: null,
  trustedNow: new Date(f.now()).toISOString(), trustedTimeZone: 'Etc/UTC',
  deadlineAt: new Date(f.now() + 20000).toISOString(),
});
```

Block adapter `get`, `create`, and `compareAndSwap`, then invoke `owner.execution` with an in-memory request counter and a deterministic GET response for `/calendar/v3/calendars/shared-team/events/abcde01234`.

Assertions must include:

```ts
expect(result).toMatchObject({ outcome: 'success', receipt: null });
expect(fake.requests).toHaveLength(1);
expect(kinds).toEqual(['capability-recheck', 'get']);
expect(get).not.toHaveBeenCalled();
expect(create).not.toHaveBeenCalled();
expect(cas).not.toHaveBeenCalled();
expect(JSON.stringify(result)).not.toContain('fixture-access');
expect(JSON.stringify(result)).not.toContain('fixture-refresh');
```

Run `npm test -- test/plugins/google-calendar/tools-boundaries.spec.ts -t "prepared assembled"`. Expected red: the old executor's direct store get prevents the fixture GET. Use thrown blocked methods to fail quickly; use one deferred storage promise in a separate race case to prove no hidden waiter rather than relying only on call counts.

- [ ] **Step 3 — Route production admission through the optional owner.** Add `authority?: CalendarAccountAuthority` to `CalendarToolsV2Dependencies` and wire the existing `connections` object as `authority` in `createCalendarAssembly`. Keep raw `connections: input.storeV2` solely as standalone fallback. Keep all existing schema/domain checks. The mode selection at `requireAccount` is:

```ts
const fresh = call.name === 'calendar_create_event';
const record = this.v2Deps!.authority
  ? await this.v2Deps!.authority.requireAccountCurrent(toAccountBinding(binding), signal, { fresh })
  : await this.v2Deps!.connections.get(binding.userId);
```

Validate the returned record with the current existing schema/identity/grant checks, including `record.userId === binding.userId`. Capture owner `getLifecycleEpoch()` for the invocation and recheck it after awaits, around `consumeRequest`, and before publication. Keep the cheap guards **before and after every awaited debit**, including retry/page/batch requests. A request debit that fails or invalidates authority must send no request; do not add recursive HTTP capability work to `admit`.

`readDiscovery` in assembly uses `requireAccountCurrent(account, signal, { fresh: false })`, `ensureFresh`, then a final prepared authority check before returning scopes/snapshot. The runtime adapter forwards the optional third argument unchanged and exposes `invalidateAccount`.

- [ ] **Step 4 — Add the read-publication guard.** Before returning success from GET/list, availability, or calendar listing, recheck the owner epoch, cancellation/deadline, latest prepared authority, and the target/snapshot's still-valid retention/freshness/selection. This check performs no fresh provider request or DB work on the valid prepared path. Reject an in-flight read after disconnect/reconnect, role/private-access change, default rebinding of an implicit target, or discovery retention expiry; do not construct new source expiry to relabel old content as fresh.

Do not apply a read-only failure rewrite after a dispatched create: its result may be provider-confirmed or uncertain and must retain existing receipt/readback semantics. `readback` is reconciliation, not a prepared ordinary read: use owner fresh checks/default raw fallback and `gate.requireCurrent({ operation: 'read', fresh: true })`; retain pinned event ID and no POST replay.

- [ ] **Step 5 — Expand tests one case at a time, red before each implementation branch.** Use the assembled fixture for `calendar_list_events`, `calendar_get_event`, `calendar_list_calendars`, and `calendar_check_availability` with storage blocked after warming. Availability uses actual `CalendarAvailabilityApi` with a deterministic freeBusy response and its normal batch debit. Listing calendars may return immediately from the complete prepared snapshot without an event request; still verify current authority and bounded result.

Keep the existing `multiToolsFixture` **without** authority for standalone tests: direct `record` edits must still be observed via raw store fallback. Add owner-backed cases for: invalidation while budget charge is paused; cancellation/deadline while credential callback waits; account swap while GET/body is paused; expiry while availability is paused; masked target before delivery; fresh create/readback blocked on store; and exhausted request/refresh budgets. In create tests assert zero event POST if the fresh check fails, and preserve `WRITE_OUTCOME_UNKNOWN` after an already dispatched POST is cut short.

- [ ] **Step 6 — Run green.**

```powershell
npm test -- test/plugins/google-calendar/tools-boundaries.spec.ts test/plugins/google-calendar/tools-multi.spec.ts test/plugins/google-calendar/connection-prepared.spec.ts
```

Expected: prepared fixture delivery and result return with zero application connection-storage reads/writes, plus unchanged standalone/fresh-mutation/cancel/budget behavior. Report metadata-provider requests separately from application storage; zero application I/O is not zero Google network requests.

## Task 6: Preserve warmed AppService preparation and invalidate before retention waits

**Modify:** `backend/src/app.service.ts`, `backend/src/operations/calendar-assembly.ts`; **test:** new assertions in `tools-boundaries.spec.ts`, existing assembly suites run unchanged unless the orchestrator explicitly hands back an assembly-test file.

- [ ] **Step 1 — Add an owner-preparation integration assertion using the actual AppService fixture.** Import `assembledCalendarApp` from `backend/test/assembly/calendar-fixture.ts`, `admittedAccount` from `backend/test/auth/fixtures.ts`, and the `AuthPrincipal` type from `backend/src/contracts/auth.ts` into the boundary spec using relative `.js` imports. It already uses injected in-process persistence/fetch and warms the connection; it is **not** the full memory-first acceptance fixture. This check was red on the baseline; it may already be green after Task 2. Do not manufacture a failure by overriding production guards.

```ts
const h = await assembledCalendarApp();
const userId = 'aurvin-dev-user';
const principal: AuthPrincipal = {
  account: admittedAccount({ userId }), sessionId: 'sid_1',
  identity: { userId, openRouterUser: userId, source: 'authenticated-session' },
};
const get = vi.spyOn(h.cal.p.calendarConnectionsV2, 'get')
  .mockRejectedValue(new Error('warm prepareOwner touched storage'));
try {
  await h.service.prepareOwner(principal);
  await h.service.prepareOwner(principal);
  expect(get).not.toHaveBeenCalled();
  expect(h.service.configFor(userId)!.calendar!.enabled).toBe(true);
  expect(h.fetcher).not.toHaveBeenCalled();
} finally { get.mockRestore(); await h.dispose(); }
```

No HTTP authentication guard or runtime gate override is permitted. The principal matches the admitted account/session seeded by this existing fixture; the test must not alter production auth code.

- [ ] **Step 2 — Keep request preparation memory-backed.** `prepareOwner` may keep its existing `boundedResult(refreshCalendarStatus(...))` structure: once `statusV2` uses the prepared slot this no longer reads connection storage on every private request. Do not create another authority/status cache in AppService or skip status policy/expiry projection. `calendarStatusByOwner` remains a public-status projection, never an authority/token owner. Cold startup remains bounded hydration, not a zero-I/O claim.

- [ ] **Step 3 — Make account revocation immediate.** At the beginning of `onCalendarInvalidated`, call the existing owner's scoped synchronous `connections.invalidateAccount(account)` before any quiesce/retention await, then retain the current status disablement and runtime memory invalidation. Runtime invalidation already runs synchronously at the beginning of `redactInvalidatedRevision`; do not defer it behind `quiesceStreams`. Preserve retained-data paging, failure-visible stream fencing, and existing config-job/shutdown tracking. The connection hook must not recursively call `onAccountInvalidated`.

The AppService hook outline is:

```ts
this.calendarOwners.get(account.userId)?.connections.invalidateAccount(account);
```

Apply it only to the matching account. A late old-account callback may redact that old revision but must not overwrite a newly connected replacement's public eligibility with disabled status. Use the existing `calendarStatusByOwner` projection: if its non-null `connectionRevision` is greater than the invalidated revision, preserve that newer projection while still invoking old-revision memory/retention redaction. Connection revisions are monotonic across replacement in `installGrant`; no new public snapshot/credential getter or DB lookup is needed. Default-setting saves update through confirmed owner state and existing wrapped status refresh, without invoking account-wide retention redaction.

- [ ] **Step 4 — Add a held-quiescence test.** In the boundary spec reuse `assembledCalendarApp` and its actual created runtime as in `backend/test/assembly/calendar-invalidation.spec.ts`. Hold `runtime.quiesceStreams` with a deferred result, trigger `rejectUnauthorizedAccount(currentAccount)`, wait for quiescence entry, and assert another prepared account check/read is denied **before** releasing quiescence/retention work. Release and settle all jobs in `finally`. Existing tests must still prove failed retention scans do not release the stream fence.

- [ ] **Step 5 — Run assembled regressions and checkpoint.**

```powershell
npm test -- test/plugins/google-calendar/tools-boundaries.spec.ts test/assembly/calendar-policy.spec.ts test/assembly/calendar-assembly.spec.ts test/assembly/calendar-capability.spec.ts test/assembly/calendar-invalidation.spec.ts test/assembly/auth-calendar.spec.ts test/operations/calendar-restart.spec.ts
```

Expected: isolation, setup/credential policy, redaction ordering, owner status, and shutdown checks pass. After orchestrator permission, stage named changed discovery/executor/assembly/test files and commit `feat(calendar): use prepared authority for safe read dispatch`.

## Task 7: Verify P1 gates and publish an exact downstream handoff

**No new production scope.** Defects found by checks stay with this worker if they belong to P1; otherwise report them to their owner instead of editing outside the file map.

- [ ] **Step 1 — Check shared callers.** Run repository searches for `requireAccountCurrent`, `currentAccount`, `getLifecycleEpoch`, `invalidateLifecycle`, `withAccessToken`, `checkTarget`, and `CalendarApiTools`. Confirm every P1 read caller explicitly opts into prepared access, every create/reconciliation/lifecycle/refresh rebase uses fresh authority, and no altered shared helper weakens a sibling caller. Inspect `calendar-loop.ts`, `calendar-operation.ts`, `calendar-preflight.ts`, and `durable-chat-runtime.ts` read-only for compatibility. Default-fresh protects these not-yet-migrated callers.

- [ ] **Step 2 — Run P1 regression set, build, and lint.** In `backend/` with Mongo test URI cleared:

```powershell
npm test -- test/plugins/google-calendar/ test/assembly/calendar-policy.spec.ts test/assembly/calendar-assembly.spec.ts test/assembly/calendar-capability.spec.ts test/assembly/calendar-invalidation.spec.ts test/assembly/auth-calendar.spec.ts test/operations/calendar-restart.spec.ts
npm run build
npm run lint
```

Run these as separate tool commands, not a noisy separator chain. Expected: meaningful discovered tests pass; build exits 0; lint exits 0 with warnings reported honestly. Correct introduced failures before handoff. Full backend/e2e and integrated text/live-voice performance verification remain P4 gates; P1 does not certify them. Frontend is untouched.

- [ ] **Step 3 — Audit privacy and limits.** Assert synthetic access/refresh token canaries occur only inside fixture provider Authorization handling/credential callbacks, never returned envelopes, diagnostics, status, public binding, or serialized chat inputs. No new plaintext cache exists. Confirm existing tool/request/refresh/page/batch/result/deadline limits are unchanged and no account/calendar privilege was widened to pass a timing check.

- [ ] **Step 4 — Verify the following exit gates with named tests/results.**

| Gate | Required evidence |
| --- | --- |
| Prepared provider executor | All four read/list/availability tools execute with adapter get/create/CAS blocked after explicit warming; real gate and credentials retained; request kinds counted. |
| Fresh mutation authority | Create and pinned readback still attempt fresh store checks and send no POST on failed/uncertain/denied admission; dispatched-create uncertainty unchanged. |
| Cold/refresh honesty | Cold/failing/legacy/absent records, expired credentials/discovery/retention, and changed evidence refresh or fail safely; no invented complete coverage. |
| Invalidation races | Revoked delayed get/refresh/discovery/read results cannot repopulate usable authority; disabled/reconnected/replaced accounts remain isolated; held quiescence cannot delay denial. |
| Target/privacy | Missing defaults clarify; preference-only changes do not fence pinned creates; stale implicit targets and unmasked projections are refused; no tokens escape. |
| Bounds/fallback | Existing concurrency lifecycle, cancellation, deadline, request/refresh/result limits, standalone adapter edits, CAS rebase, drain, and shutdown regressions pass. |
| Downstream ownership | Runtime promotion/archive and direct runtime-invalidation hook adoption explicitly handed to P2; create barrier to P3; whole-route measurements and review-skipped reporting to P4. |

- [ ] **Step 5 — Commit only named worker task files after orchestrator permission.** Final worker message: `feat(calendar): complete prepared authority admission safeguards`. Use `git diff --check`, inspect `git diff --stat` and staged paths, and never `git add .`. Do not include generated `dist`, secrets, dependency files, workflow state, or concurrent edits.

- [ ] **Step 6 — Return the interface/evidence summary.** Report commit hashes, exact changed paths, discovered pass/failure/skip counts, build/lint results, prepared versus cold command counts and sequential stages, and limitations. Explicitly tell P2 that `currentAccount` is prepared, default `requireAccountCurrent` remains fresh, reads must pass `{ fresh: false }`, and `invalidateAccount` must be called synchronously from its direct runtime invalidation path. Tell P3 that create/readback authority and provider capability checks remain fresh and that no durable mutation evidence format changed. Do not mark the overall workflow complete.

## Required safety matrix for implementation decisions

- **Snapshot load versus revocation:** epoch changes and revoked watermark win over an already running get; no late warm restore.
- **Old get versus new confirmed CAS:** higher-revision confirmed state wins, including late absence and refresh/discovery writes; stale callers revalidate against it.
- **Disable/disconnect/consent versus request debit:** invalidate before storage awaits, guard again after debit, no provider effect after denial.
- **Replacement versus old 401:** match full owner/connection/revision/subject; old callbacks cannot revoke new credentials, target data, or public eligibility.
- **Default change versus pinned action:** update prepared defaults immediately on confirmed CAS; reject obsolete implicit selection, preserve explicitly pinned authorized creates and independently recheck their fresh capability.
- **Provider return versus expiry/revocation:** read publication rechecks current authority and metadata lifetime in memory; no stale result is promoted as current. P2 additionally scrubs already staged/queued history and publication.
- **Token rotation versus use:** refresh stays single-flight and durable-before-use; no persistent plaintext cache; no retry of arbitrary credential callbacks.
- **Archive failure versus read:** P1 does not consult chat/archive persistence in executor admission; P2 owns safe bounded continuation while archives are pending/failed.
- **No hidden claims:** one logical prepared record is not a distributed coherence protocol; deterministic local tests are not service/topology certification or a wall-clock SLA.

## Planning self-check and plan-document commit

- Goal coverage: provider/authority portion of AC1, AC3, AC5, AC6, AC7 is covered above; AC2/read archival and complete invalidation publication are P2; mutation durability/recovery is P3; integrated eight-criterion evidence and final instructions are P4.
- Type consistency: one `CalendarAccountCheckOptions`, one `CalendarAccountAuthority`, optional `authority` dependency, optional runtime `invalidateAccount`; **fresh is the default everywhere except explicit prepared callers**. No persistent authority epoch or credential field added.
- Document verification only for this planning delivery: existing path/link check, placeholder scan, `git diff --check`, and named-file staged diff. Application tests in the tasks are worker instructions, not tests run or passed by this planner.
- Required plan-only commit (repository root):

```powershell
git add -- docs/calendar-tool-latency/plan1.md
git commit -m "docs(calendar-tool-latency): plan 1 - prepared authority"
```
