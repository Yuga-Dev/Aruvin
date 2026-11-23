# Authentication Authority Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the account database lookup from real HTTP authentication before model dispatch without removing WorkOS verification, local account admission, or revocation fencing.

**Architecture:** Keep one bounded, server-only map of account authority, not authenticated principals or cookies. Explicit authentication control-plane preparation and confirmed account writes publish immutable, revisioned snapshots; synchronous generation fences prevent pending reads and stale write acknowledgements from restoring revoked authority. `authenticate()` still verifies each sealed session with WorkOS and calls `admitAccount()`, but reads account authority synchronously and never hydrates it.

**Tech Stack:** Existing TypeScript/NodeNext ESM, Node standard library, WorkOS adapter, Nest/Express, MongoUsers/RecordStore, Zod, Supertest, and Vitest. No new dependency, collection, index, scheduler, or frontend change.

---

## Execution authority and findings

- This document is a plan, not implemented or passing authentication evidence. Inspected on 2026-11-14: root [AGENTS.md](../../AGENTS.md), [goal.md](goal.md), [research.md](research.md), [state.md](state.md), [plan3.md](plan3.md), authentication, account persistence, identity, private HTTP, administration, and their fixtures.
- Worker prerequisite: verified research `715b7b0`, this committed plan, and orchestrator assignment. P2A is independent of P2's plugin implementation. P3's worker requires both completed workers.
- Use the available `executing-plans` and `test-driven-development` skills. The required header does not authorize invented `superpowers:` skills or additional delegation. Unified review remains **skipped**.
- Edit only the P2A files below. Preserve the concurrent P2 worker's changes, Calendar code/tests, `.commandcode/`, `.openchamber/`, and other user work. Use explicit path-scoped commits after checking status; no broad staging.
- All new TypeScript/test files need the repository's full FILE/LOCATION/PURPOSE/ROLE IN PROJECT/KEY COMPONENTS header before imports. Add it to an existing file if changing more than 30%. Local imports use `.js`.
- `AuthService.authenticate()` currently does `provider.read(cookie)` → `users.bySubject(subject)` → `admitAccount(account, sid)`. Replace **only that account lookup**. Do not replace WorkOS verification with a snapshot of an admitted principal, add a development identity fallback, or change `requireFullAccount`/`requireSuperAdmin`.
- All `authenticate()` callers were traced: private middleware, `auth-boundary.ts`, `AuthController`, and `VoiceUpgradeAdmission`. The shared service fix covers them; do not patch the text route alone.
- Existing account CAS already protects immutable identity, `_revision`, and nondecreasing `sessionEpoch`. Its confirmed result is the publication source. A successful provider login alone is not authority.
- Administration's existing `onUserDeactivated` callback runs **after** persistence and is deferred through `Promise.resolve().then(...)`. It remains a cleanup hook, not the memory fence.
- `passwordReset` in Administration and `forgotPassword` only send recovery mail. They must not revoke a session merely for requesting mail. Actual `AuthService.resetPassword` performs the account invalidation.
- WorkOS documentation checked through Context7 `/workos/workos-node`, “CookieSession.authenticate / refresh / revokeSession”, on 2026-11-14: sealed-session authentication unseals and verifies against JWKS; refresh is separate network work. Keep the installed adapter's current behavior, including its bounded refresh/revalidation. Zero **application database** operations is not a promise of zero authentication network calls, instant visibility of a WorkOS-dashboard revocation, or zero SDK latency.

## File map: ownership before tasks

| Owner | Action / exact files | Responsibility |
| --- | --- | --- |
| P2A | Create `backend/src/auth/account-authority.ts` | Small authority types, bounded map, explicit hydration, generation/revision fences |
| P2A | Modify `backend/src/auth/auth.service.ts` | Replace authenticate lookup; explicit control-plane preparation; publish/fence existing login/logout/password/reset writes |
| P2A | Modify `backend/src/auth/auth.controller.ts` | Explicit preparation only on existing auth control-plane routes |
| P2A | Modify `backend/src/auth/access.ts` | Accept a readonly account in `admitAccount`; keep its checks/body unchanged |
| P2A | Modify `backend/src/auth/index.ts` | Export the authority port/types and concrete implementation |
| P2A | Modify `backend/src/administration/administration.service.ts` | Required-at-use authority dependency; synchronous mutation fences and confirmed publications |
| P2A | Create `backend/test/auth/account-authority.spec.ts`, `backend/test/auth/authority-lifecycle.spec.ts`, `backend/test/auth/authority-http.spec.ts` | Bounds, races, control-plane lifecycle, actual private HTTP → runtime → model instrumentation |
| P2A | Modify `backend/test/auth/fixtures.ts`, `backend/test/auth/session.spec.ts`, `backend/test/auth/password.spec.ts`, `backend/test/auth/recovery.spec.ts`, `backend/test/auth/http.spec.ts` | Explicit outside-turn preparation and strengthened existing semantics |
| P2A | Modify `backend/test/administration/fixtures.ts`, `backend/test/administration/lifecycle.spec.ts`, `backend/test/administration/deactivation.spec.ts`, `backend/test/auth/integration/accounts.ts` | One shared authority across services; retain existing cleanup/CAS checks |
| P2A | Modify `backend/test/http/private-boundary.spec.ts` | Explicitly prepare known-missing subjects; retain origin/onboarding/role checks |
| P3 handoff, **not P2A edits** | `backend/src/app.service.ts`, `backend/src/main.ts` if needed, `backend/test/assembly/auth-wiring.spec.ts`, `backend/test/assembly/web-search-composition.spec.ts`, `backend/test/voice/web-search-voice.spec.ts` | Inject the same authority into Administration; shutdown closure; real assembled text/voice evidence |
| Read only | `backend/src/auth/provider.ts`, `backend/src/http/configure-private-http.ts`, `backend/src/platform/identity/**`, `backend/src/voice/transport/authenticated-ws-adapter.ts`, `backend/src/contracts/auth.ts`, `backend/src/persistence/users.ts` | Preserve provider/session verification, ALS identity, existing wire/schema/repository contracts |

No P1 contract/manifest change or P2 WebSearchPort change is needed. P3 must reconcile its documented authentication exception and trusted-identity-only fixtures with this prerequisite; AC6 is unchanged.

## Frozen P2A contract

### Server-only port and snapshot

Put these exports in `backend/src/auth/account-authority.ts`; import the existing `AccountRead`, `UserAccount`, and `UsersRepository` rather than creating another account schema.

```ts
export const ACCOUNT_AUTHORITY_POLICY = Object.freeze({
  maxEntries: 1024,
  maxSnapshotBytes: 2048,
  maxAgeMs: 900_000,
  maxWarmReads: 4,
});

export type AccountAuthorityPolicy = {
  maxEntries: number;
  maxSnapshotBytes: number;
  maxAgeMs: number;
  maxWarmReads: number;
};
export type AccountAuthorityChange = 'replacement' | 'revocation';

export type AccountAuthoritySnapshot = Readonly<{
  workosUserId: string;
  account: Readonly<UserAccount> | null;
  revision: number | null;
  generation: number;
  verifiedAt: number;
  expiresAt: number;
}>;

declare const authorityFenceBrand: unique symbol;
export type AccountAuthorityFence = Readonly<{
  workosUserId: string;
  generation: number;
  [authorityFenceBrand]: true;
}>;

export interface AccountAuthorityPort {
  snapshot(workosUserId: string): AccountAuthoritySnapshot;
  warm(workosUserId: string): Promise<void>;
  fence(workosUserId: string, change?: AccountAuthorityChange): AccountAuthorityFence;
  publish(fence: AccountAuthorityFence, value: AccountRead | null): boolean;
  fail(fence: AccountAuthorityFence): void;
  close(): void;
}
```

Concrete constructor:

```ts
type AccountAuthorityOptions = {
  users: Pick<UsersRepository, 'bySubject'>;
  nowMs?: () => number;
  policy?: AccountAuthorityPolicy;
};
// new AccountAuthority(options: AccountAuthorityOptions)
```

Use `performance.now()` by default. These are process-local monotonic coordinates, not durable timestamps or an out-of-process change-feed position. `policy` is an internal test seam, never browser/admin configuration; production defaults stay exactly as above. Validate positive safe integers and `maxWarmReads <= maxEntries` once in the constructor.

- A ready snapshot is frozen, including its account; it contains **only** schema-selected `UserAccount` fields, revision, process generation, and validity coordinates. No cookie, password, access/refresh/reset token, provider error, or authenticated principal is retained.
- `account:null, revision:null` is a confirmed missing mapping from an explicit warm. It passes `null` to `admitAccount` and gets the existing `UNAUTHENTICATED`/401. Cold is not confirmed absence.
- Cold/evicted, exactly expired (`now >= expiresAt`), warming, fenced, uncertain, closed, or capacity-unavailable authority throws `new AuthFault('NOT_READY')`. No turn-path repository fallback, warm task, timer, or provider preparation is started.
- Inactive accounts, null/mismatched current SID, password-change gate, and role denial keep the existing admission semantics and safe 401/403 responses. Retryable `NOT_READY` leaves the browser cookie intact under existing middleware.
- `verifiedAt`/`expiresAt` are an explicit validity ceiling, **not** a sliding TTL principal cache or evidence that external changes become immediately visible. Reads never renew or hydrate it.
- No snapshot or fence is a public wire DTO, log field, prompt, transcript, or telemetry payload. Session IDs inside `UserAccount` stay server-only.

### Revision, fencing, and capacity rules

Implement one `Map<string, Entry>` and one monotonically increasing safe-integer sequence. Internal entries have exactly these fields:

```ts
type Entry = {
  token: AccountAuthorityFence;
  state: 'warming' | 'fenced' | 'uncertain' | 'ready';
  change: AccountAuthorityChange | null;
  floor: AccountRead | null;
  snapshot: AccountAuthoritySnapshot | null;
};
```

1. Every warm start and every mutation fence creates a new, frozen token object with a new process generation. Publication checks **object identity against `entry.token`**, not just subject/number. A copied/forged/old token cannot publish, even after eviction/reinsertion.
2. `fence(subject, change = 'replacement')` is synchronous and runs immediately before an account mutation's first write await, or before the known-subject reset read. A replacement **must refuse an existing fenced entry**, rather than supersede an unresolved mutation. A revocation may supersede warming or either mutation kind; its eventual publication must have null current SID (and cannot reactivate an inactive floor). Preserve the last confirmed `floor`. This asymmetry matters: a paused login/password rollback cannot win against deactivation, and a no-op/reactivation cannot fence a pending revoke and restore its old account.
3. `publish(token, value)` is synchronous and single-use. Reject stale tokens and already-ready/uncertain entries with `false` and no side effect on the newer entry. Validate subject binding, schema, safe nonnegative revision, encoded snapshot cap, account identity matching the retained floor, and the revocation-only publication restriction above. Reject decreasing revision/sessionEpoch. For an equal revision, require `isDeepStrictEqual` account content; timestamps are not an ordering substitute. Invalid current-token publications mark that entry uncertain and throw safe `NOT_READY`.
4. On success, store a schema-selected clone, freeze it, set `verifiedAt = nowMs()` and `expiresAt = verifiedAt + maxAgeMs`, update floor only for a non-null value, and make state ready. The floor references that isolated frozen clone, **never the caller's mutable receipt object**. An explicit confirmed missing read may deny access while retaining the previous floor internally.
5. `fail(token)` is synchronous and marks **only the still-current token** uncertain. Old catches must not fence or erase a newer confirmed account. A thrown/uncertain/conflicting write never publishes the old account optimistically.
6. `warm(subject)` is **control-plane only**. Refuse fenced/uncertain subjects; never overwrite an in-progress mutation or reconcile an ambiguous write by a casual lookup. Refuse a duplicate `warming` request with `NOT_READY` instead of creating a waiter queue. Reserve one of four warm slots before dispatch; use one existing `users.bySubject` read, no write, and publish only if its token still owns the entry. Retain the slot until the actual promise settles, even when the caller goes away. No artificial timeout releases an unsettled slot.
7. Reconciliation after uncertain state requires a new explicitly authenticated, confirmed account mutation (normally login or a state-changing admin lifecycle action), which fences with a new token and publishes its confirmed CAS result. `/auth/me` and admin no-ops alone must not lift uncertainty. Do not add automatic replay or a general reconciliation service.
8. On inserting a new subject at capacity, evict the oldest **ready** entry by `Map` insertion order; renewing/publishing moves a ready entry to the end. Never evict warming/fenced/uncertain entries. If all entries are pinned, throw `NOT_READY` before dispatching a new warm or mutation. No per-cookie negative map, tombstone list, or unbounded promise map.
9. Snapshot reads do not reorder the map or extend expiry. Eviction makes that owner cold until explicit preparation/login, not an implicit read-through miss. An expired ready entry may be evicted but is never served.
10. `close()` synchronously sets a permanent closed flag and clears the map. Every old token/result becomes invalid; no reopen method. Generation overflow or nonfinite/nonmonotonic injected clock also closes the authority and fails `NOT_READY`.

Use one `ponytail:` comment documenting the 1024-entry, ready-only O(n) eviction scan and single-process ceiling. These are bounded encoded-data/entry limits, not a calibrated claim of exact V8 heap/RSS consumption.

### Control-plane and mutation hooks

`AuthService` owns `readonly authority: AccountAuthorityPort`, supplied through optional `AuthServiceOptions.authority`, or defaults to `new AccountAuthority({ users: o.users })`. It creates no second persistence owner.

Add the explicit control-plane entry:

```ts
async prepare(cookie: string | null): Promise<{
  principal: AuthPrincipal; sealedSession?: string;
}>;
```

It performs the same `provider.read(cookie)` verification as `authenticate`, then `await authority.warm(verifiedSubject)`, then `admitAccount(authority.snapshot(verifiedSubject).account, verifiedSid)`. Use it only in the existing AuthController private `principal()` helper for `/auth/me`, `/auth/logout`, and `/auth/password`. `auth-boundary`, private HTTP, voice upgrade, text submit/retry/stream, and live turns continue using **memory-only `authenticate`**. WorkOS is called once per preparation, not twice.

| Existing operation | Fence point / publication |
| --- | --- |
| Login/account session replacement | Keep existing byEmail snapshot **before** provider login; invalid proof leaves old authority intact. After active/matching provider proof, acquire a replacement fence immediately before binding CAS. Publish only the confirmed saved account before returning a cookie. Fence-capacity/busy failure or stale publication fails `NOT_READY` and revokes the newly obtained unissued session. |
| Logout | Keep current account read and SID comparison. Only if stored current SID equals the principal SID, take a revocation fence before invalidation CAS, publish the confirmed null-SID account, then revoke WorkOS. Stale logout must not evict/fence a newer SID. On read/write uncertainty for the currently represented SID, fence/fail that SID's authority before returning the safe error. |
| Password change | Preserve same-subject current-password proof and proof-session revocation. Fence immediately before the existing durable invalidation. Keep the entry fenced through provider replacement and fresh login. Publish only the final confirmed fresh-SID account. If replacement is definitively `INVALID_REQUEST`, publish the existing **confirmed rollback** under the same token, preserving the increased sessionEpoch. Timeouts/uncertain writes stay closed; a concurrent deactivation invalidates rollback/final publication. |
| Actual password reset | Preserve provider token verification, provider-owned subject, and the existing maximum three local CAS attempts; do not infer owner from token/email/client. Once the provider returns the subject, synchronously take a revocation fence **before** the first `users.bySubject` await, and publish the confirmed invalidated account under that same token. Never repeat the provider reset to fix storage. |
| Forgot/admin recovery mail | No account mutation or authority publication; preserve uniform mail semantics and rate limits. The eventual actual reset above owns the fence. |
| Administration create | Require shared authority before provider provisioning; fence the provider-confirmed subject before local insert, publish only the confirmed inserted account. On unknown/failed insertion, leave it closed. Existing provisioning-incomplete/error semantics remain. |
| Administration deactivate/reactivate | After existing actor/target validation, take a revocation/replacement fence respectively immediately before save; publish the confirmed result synchronously before cleanup/success. For already-in-state no-ops, use explicit `warm` (which refuses unresolved fences/uncertainty), without another DB write. Never blindly fence/publish a pre-fence read for a no-op. Reactivate always preserves null SID; it never revives old access. |
| Explicit revoke/disable initiated by the application | Route through the existing local invalidate/deactivate mutation, take a revocation fence before write/provider revoke, and publish confirmed null-SID/inactive authority. No new provider-only revoke endpoint is introduced. Never retain a ready snapshot for a locally revoked admitted SID. |

For login/password cleanup of a newly acquired but unissued provider SID, it normally was never authoritative. If it **is** the SID in a ready snapshot, fence/fail that snapshot before calling revoke; do not invalidate a distinct newer SID. Proof-only/unknown cookies must not gain a general account-revocation capability.

### Admitted topology and honest limitations

- Supported: one live application executor per database, with **all application account mutations routed through these hooks**. MongoUsers' existing CAS remains the durable concurrency check. Process generation complements it; neither replaces the other.
- Out-of-process direct Mongo changes, the bootstrap CLI run against a live process, other executors, and WorkOS dashboard changes have no coherent push invalidation here. They are **not admitted as immediate-consistency writers**. Stop/quiesce the application for such changes; reconcile local SID/status and restart/reprepare before resuming. No multi-instance or production authentication certification.
- An explicit `/auth/me` warm can observe external local-account changes, and the 15-minute validity ceiling stops serving an unrenewed snapshot. Neither guarantees immediate revocation visibility; no TTL argument may be used to claim that it does.
- Startup does not scan all users. Login publication or the browser's existing `/auth/me` restores authority outside turns. A cold/expired request must fail closed; the user must return through `/auth/me`/reload or login. Do not silently fix that UX by adding per-turn warmup. This bounded re-preparation requirement is a deliberate ceiling, not a seamless background-refresh promise.
- `provider.reset()` cannot identify its subject before a verified response. The known-subject fence starts immediately at that response, before local reset reconciliation. Preserve the existing adapter/provider ambiguity boundary; do not claim this plan makes an unknown external reset outcome atomically revoke local application access. Such an outcome requires operator reconciliation and must not be labeled production-certified. No new token introspection API or broad global reset gate is authorized.
- Fencing prevents **new authentication admissions**. It cannot retract a model/provider request already sent or turn an already captured ALS principal into a live revocation subscription. Existing deactivation/logout cleanup remains; P3/P5 must not claim this snapshot alone solves active voice/socket cancellation or external billing.

## Task 1: RED/GREEN bounded snapshot and generation kernel

**Files:** create `backend/src/auth/account-authority.ts`, `backend/test/auth/account-authority.spec.ts`.

- [ ] **Step 1 — Write a failing test with real existing account/schema fixtures:**

```ts
import { expect, it, vi } from 'vitest';
import { AccountAuthority, ACCOUNT_AUTHORITY_POLICY } from '../../src/auth/account-authority.js';
import { admittedAccount } from './fixtures.js';

it('serves only confirmed immutable authority and expires exactly at the boundary', () => {
  let now = 10;
  const users = { bySubject: vi.fn(async () => null) };
  const authority = new AccountAuthority({ users, nowMs: () => now });
  expect(() => authority.snapshot('user_fixture_1')).toThrow('NOT_READY');
  const ticket = authority.fence('user_fixture_1');
  const value = { account: admittedAccount(), revision: 4 };
  expect(authority.publish(ticket, value)).toBe(true);
  value.account.status = 'inactive';
  const snapshot = authority.snapshot('user_fixture_1');
  expect(snapshot.account?.status).toBe('active');
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.account)).toBe(true);
  expect(snapshot).toMatchObject({ revision: 4, verifiedAt: 10, expiresAt: 900010 });
  now = snapshot.expiresAt;
  expect(() => authority.snapshot('user_fixture_1')).toThrow('NOT_READY');
  expect(users.bySubject).not.toHaveBeenCalled();
});

it('rejects stale publications even when their receipt has a newer number', () => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
  const older = authority.fence('user_fixture_1');
  const revoked = authority.fence('user_fixture_1', 'revocation');
  expect(authority.publish(revoked, {
    account: admittedAccount({ status: 'inactive', currentWorkosSessionId: null, sessionEpoch: 2 }),
    revision: 8,
  })).toBe(true);
  expect(authority.publish(older, { account: admittedAccount(), revision: 9 })).toBe(false);
  authority.fail(older);
  expect(authority.snapshot('user_fixture_1').account?.status).toBe('inactive');
});
```

- [ ] **Step 2 — Run RED** from `backend`: `npm test -- test/auth/account-authority.spec.ts`. Expect missing module/export, not empty discovery.
- [ ] **Step 3 — Implement the frozen types and synchronous map kernel.** After the required source header, import:

```ts
import { isDeepStrictEqual } from 'node:util';
import { userAccountSchema, type AccountRead, type UserAccount,
  type UsersRepository } from '../contracts/auth.js';
import { idSchema } from '../contracts/identifiers.js';
import { AuthFault } from './errors.js';
```

Add the frozen contracts/Entry above, then this minimal class. The deliberately closed `warm` is replaced only after Task 2's RED:

```ts
export class AccountAuthority implements AccountAuthorityPort {
  private readonly entries = new Map<string, Entry>();
  private readonly policy: AccountAuthorityPolicy;
  private sequence = 0;
  private lastNow = -Infinity;
  private closed = false;
  private warmReads = 0;

  constructor(private readonly o: AccountAuthorityOptions) {
    this.policy = { ...ACCOUNT_AUTHORITY_POLICY, ...o.policy };
    if (Object.values(this.policy).some(n => !Number.isSafeInteger(n) || n <= 0) ||
        this.policy.maxWarmReads > this.policy.maxEntries) throw new AuthFault('NOT_READY');
  }
  private assertOpen(): number {
    if (this.closed) throw new AuthFault('NOT_READY');
    const now = (this.o.nowMs ?? (() => performance.now()))();
    if (!Number.isFinite(now) || now < 0 || now < this.lastNow) {
      this.close();
      throw new AuthFault('NOT_READY');
    }
    this.lastNow = now;
    return now;
  }
  private begin(subject: string, state: 'warming' | 'fenced',
    change: AccountAuthorityChange | null = null): AccountAuthorityFence {
    this.assertOpen();
    if (!idSchema.safeParse(subject).success) throw new AuthFault('NOT_READY');
    const previous = this.entries.get(subject);
    if (!previous && this.entries.size >= this.policy.maxEntries) {
      // ponytail: single-process, <=1024 entries; bounded O(n) ready-only eviction.
      // A larger/multi-executor deployment needs coherent authority, not a generic cache.
      const victim = [...this.entries].find(([, value]) => value.state === 'ready')?.[0];
      if (victim === undefined) throw new AuthFault('NOT_READY');
      this.entries.delete(victim);
    }
    if (!Number.isSafeInteger(this.sequence + 1)) {
      this.close();
      throw new AuthFault('NOT_READY');
    }
    const token = Object.freeze({
      workosUserId: subject, generation: ++this.sequence,
    }) as AccountAuthorityFence;
    this.entries.delete(subject);
    this.entries.set(subject, {
      token, state, change, floor: previous?.floor ?? null, snapshot: null,
    });
    return token;
  }
  snapshot(subject: string): AccountAuthoritySnapshot {
    const now = this.assertOpen();
    const entry = this.entries.get(subject);
    if (entry?.state !== 'ready' || !entry.snapshot || now >= entry.snapshot.expiresAt)
      throw new AuthFault('NOT_READY');
    return entry.snapshot;
  }
  fence(subject: string, change: AccountAuthorityChange = 'replacement'): AccountAuthorityFence {
    this.assertOpen();
    if (change === 'replacement' && this.entries.get(subject)?.state === 'fenced')
      throw new AuthFault('NOT_READY');
    return this.begin(subject, 'fenced', change);
  }
  publish(ticket: AccountAuthorityFence, value: AccountRead | null): boolean {
    const entry = this.entries.get(ticket.workosUserId);
    if (this.closed || entry?.token !== ticket ||
        entry.state === 'ready' || entry.state === 'uncertain') return false;
    const invalid = (): never => { this.fail(ticket); throw new AuthFault('NOT_READY'); };
    const parsed = value === null ? null : userAccountSchema.safeParse(value.account);
    if (parsed && (!parsed.success || !Number.isSafeInteger(value!.revision) || value!.revision < 0))
      return invalid();
    const account = parsed?.success ? parsed.data : null;
    if (account && account.workosUserId !== ticket.workosUserId) return invalid();
    if (account && entry.change === 'revocation' && (
      account.currentWorkosSessionId !== null ||
      (entry.floor?.account.status === 'inactive' && account.status !== 'inactive')
    )) return invalid();
    if (account && entry.floor && (
      value!.revision < entry.floor.revision ||
      account.sessionEpoch < entry.floor.account.sessionEpoch ||
      account.userId !== entry.floor.account.userId ||
      account.emailNormalized !== entry.floor.account.emailNormalized ||
      account.role !== entry.floor.account.role ||
      account.createdAt !== entry.floor.account.createdAt ||
      (value!.revision === entry.floor.revision &&
        !isDeepStrictEqual(account, entry.floor.account))
    )) return invalid();
    const verifiedAt = this.assertOpen();
    const expiresAt = verifiedAt + this.policy.maxAgeMs;
    if (!Number.isFinite(expiresAt)) { this.close(); throw new AuthFault('NOT_READY'); }
    const snapshot = Object.freeze({
      workosUserId: ticket.workosUserId,
      account: account ? Object.freeze(account) : null,
      revision: value?.revision ?? null,
      generation: ticket.generation, verifiedAt, expiresAt,
    });
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > this.policy.maxSnapshotBytes)
      return invalid();
    entry.state = 'ready';
    entry.snapshot = snapshot;
    if (account) entry.floor = { account, revision: value!.revision };
    this.entries.delete(ticket.workosUserId);
    this.entries.set(ticket.workosUserId, entry);
    return true;
  }
  fail(ticket: AccountAuthorityFence): void {
    const entry = this.entries.get(ticket.workosUserId);
    if (entry?.token === ticket) {
      entry.state = 'uncertain';
      entry.snapshot = null;
    }
  }
  async warm(_subject: string): Promise<void> {
    throw new AuthFault('NOT_READY');
  }
  close(): void {
    this.closed = true;
    this.entries.clear();
  }
}
```

Schema selection/clone occurs once at publication, not per token/request callback. `fence`, `publish`, `snapshot`, `fail`, `close`, safe-clock/sequence checks, and ready-only eviction are the only synchronous responsibilities; no storage access is permitted in them. The branded token cast is local to its issuer, and runtime object identity rejects forged copies; do not export a token constructor.

- [ ] **Step 4 — Add boundary/race tests before implementing the corresponding guards:**

```ts
it.each(['revision', 'epoch', 'subject', 'identity', 'oversize'] as const)(
  'fails closed on an invalid current publication: %s', mode => {
    const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
    authority.publish(authority.fence('user_fixture_1'), { account: admittedAccount(), revision: 4 });
    const next = { account: admittedAccount(), revision: 5 };
    if (mode === 'revision') next.revision = 3;
    if (mode === 'epoch') {
      authority.publish(authority.fence('user_fixture_1'), {
        account: admittedAccount({ sessionEpoch: 1 }), revision: 5,
      });
      next.revision = 6;
    }
    if (mode === 'subject') next.account.workosUserId = 'user_other';
    if (mode === 'identity') next.account.userId = 'other';
    if (mode === 'oversize') next.account.updatedAt = `2026-11-14T00:00:00.${'1'.repeat(3000)}Z`;
    const ticket = authority.fence('user_fixture_1');
    expect(() => authority.publish(ticket, next)).toThrow('NOT_READY');
    expect(() => authority.snapshot('user_fixture_1')).toThrow('NOT_READY');
  },
);
```

Add separate equal-revision-different-content, NaN/negative/unsafe revision, copied token, null/missing mapping, caller-receipt mutation not changing the retained floor, backward/nonfinite clock, close/late publication, and injected near-overflow sequence tests. Also prove replacement refuses a pending replacement/revocation, a revocation supersedes a pending replacement, revocation publication rejects a non-null SID/reactivation, an already-published token cannot renew expiry, and a failed token cannot later republish. For sequence overflow use a constructor-internal test seam via a class-private test cast in this test only; do not expose generation control in the production port.

- [ ] **Step 5 — Run GREEN:** same focused command; all named cases must execute. Commit only the new two files with `feat(auth): add bounded revision-fenced account authority`.

## Task 2: RED/GREEN explicit hydration, uncertainty, and entry bounds

**Files:** extend the same two files.

- [ ] **Step 1 — Add failing warm-race and eviction tests:**

```ts
it('a warm started before revocation cannot restore authority', async () => {
  let finish!: (value: { account: ReturnType<typeof admittedAccount>; revision: number }) => void;
  const users = { bySubject: vi.fn(() => new Promise<{
    account: ReturnType<typeof admittedAccount>; revision: number;
  }>(resolve => { finish = resolve; })) };
  const authority = new AccountAuthority({ users });
  const warming = authority.warm('user_fixture_1');
  const denied = expect(warming).rejects.toThrow('NOT_READY');
  const revoke = authority.fence('user_fixture_1', 'revocation');
  authority.publish(revoke, { account: admittedAccount({
    status: 'inactive', currentWorkosSessionId: null, sessionEpoch: 1,
  }), revision: 2 });
  finish({ account: admittedAccount(), revision: 1 });
  await denied;
  expect(authority.snapshot('user_fixture_1').account?.status).toBe('inactive');
});

it('evicts ready entries but never drops an unresolved fence to admit a newcomer', async () => {
  const users = { bySubject: vi.fn(async () => null) };
  const policy = { ...ACCOUNT_AUTHORITY_POLICY, maxEntries: 2, maxWarmReads: 2 };
  const authority = new AccountAuthority({ users, policy });
  await authority.warm('a');
  await authority.warm('b');
  await authority.warm('c');
  expect(() => authority.snapshot('a')).toThrow('NOT_READY');
  expect(authority.snapshot('c').account).toBeNull();
  authority.fail(authority.fence('b'));
  authority.fail(authority.fence('c'));
  await expect(authority.warm('d')).rejects.toThrow('NOT_READY');
  expect(users.bySubject).toHaveBeenCalledTimes(3);
});
```

- [ ] **Step 2 — Run RED:** `npm test -- test/auth/account-authority.spec.ts -t "warm|evicts"`.
- [ ] **Step 3 — Implement the explicit hydration method with no read-through behavior:**

```ts
async warm(workosUserId: string): Promise<void> {
  this.assertOpen();
  const previous = this.entries.get(workosUserId);
  if (this.warmReads >= this.policy.maxWarmReads ||
      (previous && previous.state !== 'ready')) throw new AuthFault('NOT_READY');
  const ticket = this.begin(workosUserId, 'warming');
  this.warmReads++;
  try {
    const value = await this.o.users.bySubject(workosUserId);
    if (!this.publish(ticket, value)) throw new AuthFault('NOT_READY');
  } catch {
    this.fail(ticket);
    throw new AuthFault('NOT_READY');
  } finally {
    this.warmReads--;
  }
}
```

`assertOpen` checks closed flag and clock validity. `begin(subject,state,change = null)` is the private token allocator used by both `warm` and `fence`, performing ID/bounds/eviction checks and preserving the previous floor. `fence` enforces the replacement-versus-revocation rule before calling `begin`. Define these two private helpers in this file; they are not extra ports. Do not release a slot before the actual repository promise settles.

- [ ] **Step 4 — Add/run tests** for four held reads rejecting the fifth without another DB call, duplicate-subject warm rejection, failure pinning uncertainty, warm refusing uncertainty, successful new fenced mutation recovering uncertainty, actual 1024-entry capacity, ready-only eviction/reinsertion ABA, and snapshot reads not renewing expiry or changing eviction order. Use explicitly released promises, not sleeping or wall-clock performance assertions.
- [ ] **Step 5 — Run GREEN:** `npm test -- test/auth/account-authority.spec.ts`; commit only the two files with `feat(auth): warm account authority outside admitted turns`.

## Task 3: RED/GREEN authenticate and explicit AuthController preparation

**Files:** modify `backend/src/auth/auth.service.ts`, `backend/src/auth/auth.controller.ts`, `backend/src/auth/access.ts`, `backend/src/auth/index.ts`, `backend/test/auth/fixtures.ts`, `backend/test/auth/session.spec.ts`, `backend/test/auth/http.spec.ts`, and `backend/test/http/private-boundary.spec.ts`.

- [ ] **Step 1 — Add failing service assertions:**

```ts
it('verifies WorkOS on every authentication without opening account storage', async () => {
  const f = await authFixture(admittedAccount());
  const lookup = vi.spyOn(f.users, 'bySubject').mockRejectedValue(new Error('blocked-account-storage'));
  await f.service.authenticate('sealed_1');
  await f.service.authenticate('sealed_1');
  expect(f.provider.read).toHaveBeenCalledTimes(2);
  expect(lookup).not.toHaveBeenCalled();
  f.provider.read.mockResolvedValueOnce({
    workosUserId: 'user_fixture_1', sessionId: 'sid_wrong', sealedSession: 'rotated',
  });
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('UNAUTHENTICATED');
});

it('cold authentication fails closed and only explicit prepare loads account authority', async () => {
  const f = await authFixture(admittedAccount(), { warm: false });
  const lookup = vi.spyOn(f.users, 'bySubject');
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('NOT_READY');
  expect(lookup).not.toHaveBeenCalled();
  await f.service.prepare('sealed_1');
  expect(lookup).toHaveBeenCalledTimes(1);
  await f.service.authenticate('sealed_1');
  expect(lookup).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2 — Run RED:** `npm test -- test/auth/session.spec.ts -t "WorkOS on every|cold authentication"`. Before production changes, update `authFixture(initial = account(), options: { warm?: boolean } = {})` to expose one authority and, unless `warm:false`, warm it explicitly after fixture insertion. This is fixture setup **outside** the measured request, not implicit authentication behavior:

```ts
const authority = new AccountAuthority({ users });
if (options.warm !== false) await authority.warm(initial.workosUserId);
const service = new AuthService({ users, provider, authority, now: () => new Date(at) });
return { ...storage, users, provider, authority, service };
```

- [ ] **Step 3 — Minimal production change:**

```ts
export type AuthServiceOptions = {
  users: UsersRepository; provider: AuthProvider | null;
  authority?: AccountAuthorityPort; now?: () => Date;
};
// Constructor:
this.authority = o.authority ?? new AccountAuthority({ users: o.users });
```

In `authenticate`, retain provider/cookie/session lines and replace only the lookup/admission input:

```ts
const local = this.authority.snapshot(session.workosUserId);
const principal = admitAccount(local.account, session.sessionId);
```

Add `prepare` with the same safe result shape:

```ts
async prepare(cookie: string | null): Promise<{ principal: AuthPrincipal; sealedSession?: string }> {
  const provider = this.provider();
  if (!cookie) throw new AuthFault('UNAUTHENTICATED');
  const session = await provider.read(cookie);
  await this.authority.warm(session.workosUserId);
  const principal = admitAccount(this.authority.snapshot(session.workosUserId).account, session.sessionId);
  return { principal, ...(session.sealedSession ? { sealedSession: session.sealedSession } : {}) };
}
```

Change `admitAccount(a: UserAccount | null, ...)` to `admitAccount(a: Readonly<UserAccount> | null, ...)`; leave its status/SID checks, cloning, identity, and freeze unchanged. In AuthController import `readSessionCookie` from `cookies.js`, remove only its now-unused `authenticateCookie` import, and change its private helper call to:

```ts
const r = await this.service.prepare(readSessionCookie(req.headers.cookie));
```

Export `AccountAuthority`, `ACCOUNT_AUTHORITY_POLICY`, and the five authority types (`AccountAuthorityPort`, `AccountAuthoritySnapshot`, `AccountAuthorityFence`, `AccountAuthorityPolicy`, `AccountAuthorityChange`) through `auth/index.ts`.

- [ ] **Step 4 — Strengthen the existing HTTP cases.** Use the existing AuthModule-only `testApp` harness. With a cold fixture, `/auth/me` must warm then admit, but a private `configurePrivateHttp` request must return 503 without a read. For existing unknown-subject 401 tests, call `await f.authority.warm('unknown_subject')` (or `user_unmapped`) during setup so they test **confirmed absence**, not cold authority. Retain valid refreshed-cookie propagation, password-change 403, user/admin 403, origin/header checks, and cookie preservation/clearing.
- [ ] **Step 5 — Run GREEN for this task:** `npm test -- test/auth/session.spec.ts -t "WorkOS on every|cold authentication"` and `npm test -- test/auth/access.spec.ts test/http/private-boundary.spec.ts test/auth/provider.spec.ts`. Run the complete session/Auth HTTP suites again after Task 4/5 publications are in place. Commit only this task's named files with `feat(auth): authenticate against prepared account authority`.

At this intermediate task login's publication tests can remain RED until Task 4; do not claim the full session suite is green before completing that task. Prefer committing Tasks 3 and 4 together if needed to keep the shared branch runnable; keep the RED/GREEN records distinct.

## Task 4: RED/GREEN login replacement and logout fences

**Files:** modify `backend/src/auth/auth.service.ts`, `backend/test/auth/session.spec.ts`; create `backend/test/auth/authority-lifecycle.spec.ts`.

- [ ] **Step 1 — Add a held-CAS regression that fails without synchronous fencing:**

```ts
it('logout denies authentication while its invalidation acknowledgement is held', async () => {
  const f = await authFixture(admittedAccount());
  const principal = (await f.service.authenticate('sealed_1')).principal;
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const cas = f.users.compareAndSwap.bind(f.users);
  vi.spyOn(f.users, 'compareAndSwap').mockImplementationOnce(async (before, next) => {
    entered(); await held; return cas(before, next);
  });
  const loggingOut = f.service.logout(principal);
  await began;
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('NOT_READY');
  release(); await loggingOut;
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('UNAUTHENTICATED');
});
```

Add the same held-ack test for login replacement: old SID denied while CAS is held; new SID accepted only after confirmed publication. Failed provider login must leave the old prepared account usable.

- [ ] **Step 2 — Run RED:** `npm test -- test/auth/authority-lifecycle.spec.ts -t "logout denies|login replacement"`.
- [ ] **Step 3 — Add narrow helpers inside AuthService; no repository rewrite:**

```ts
private publish(ticket: AccountAuthorityFence, value: AccountRead): AccountRead {
  if (!this.authority.publish(ticket, value)) throw new AuthFault('NOT_READY');
  return value;
}
private fenceRepresentedSession(subject: string, sessionId: string): void {
  try {
    const current = this.authority.snapshot(subject);
    if (current.account?.currentWorkosSessionId === sessionId)
      this.authority.fail(this.authority.fence(subject, 'revocation'));
  } catch (error) {
    if (!(error instanceof AuthFault) || error.code !== 'NOT_READY') throw error;
    // Already closed: this helper must not hydrate or replace a newer operation.
  }
}
```

`publish` is used only with a confirmed saved/read record in the places specified here. `fenceRepresentedSession` is cleanup for a specific represented SID, never a caller-controlled unauthenticated revocation API.

In login, immediately after existing active/subject checks:

```ts
let ticket: AccountAuthorityFence | undefined;
let saved: AccountRead;
try {
  ticket = this.authority.fence(session.workosUserId);
  saved = this.publish(ticket, await this.confirmed(local, {
    ...local.account, currentWorkosSessionId: session.sessionId, updatedAt: this.now(),
  }));
} catch (error) {
  if (ticket) this.authority.fail(ticket);
  this.fenceRepresentedSession(session.workosUserId, session.sessionId);
  await provider.revoke(session.sessionId).catch(() => undefined);
  throw error;
}
```

Do not fence on wrong credentials or before the matching active-local proof. Preserve the existing pre-provider local snapshot and one-live-SID rule.

Replace logout's current matched-SID branch with:

```ts
if (current && current.account.currentWorkosSessionId === principal.sessionId) {
  const ticket = this.authority.fence(current.account.workosUserId, 'revocation');
  try {
    this.publish(ticket, await this.confirmed(current, invalidateAccount(current.account, this.now())));
  } catch (error) {
    this.authority.fail(ticket);
    throw error;
  }
}
```

Keep provider revocation after the branch. Wrap its existing `users.get` in a catch that invokes `fenceRepresentedSession(principal.account.workosUserId, principal.sessionId)` and rethrows; a failed current-state lookup must not leave that represented SID ready. A stale logout whose confirmed stored SID differs must not call fence. Do not publish a stale principal's account.

- [ ] **Step 4 — Add/run these exact cases:** logout provider failure still denies old access; write conflict/uncertainty/throw pins closed; second login rejects old cookies; stale logout preserves the new SID; late confirmed login receipt cannot overwrite a later confirmed deactivation; failed login cleanup cannot erase a distinct newer session; capacity/busy fence failure revokes the unissued provider session and returns no cookie. Existing direct `users.compareAndSwap` deactivation simulations in `session.spec.ts` must explicitly take revocation fences before their fixture mutation and publish confirmed results, because a raw out-of-process write is no longer a coherent local hook.
- [ ] **Step 5 — Run GREEN:** `npm test -- test/auth/session.spec.ts test/auth/authority-lifecycle.spec.ts`; commit named files with `fix(auth): fence session replacement and logout authority`.

## Task 5: RED/GREEN password, rollback, and actual reset

**Files:** modify `backend/src/auth/auth.service.ts`, `backend/test/auth/password.spec.ts`, `backend/test/auth/recovery.spec.ts`, `backend/test/auth/authority-lifecycle.spec.ts`.

- [ ] **Step 1 — Add failing known-subject reset race:**

```ts
it('fences a verified reset subject before the first local reset lookup', async () => {
  const f = await authFixture(admittedAccount());
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const lookup = f.users.bySubject.bind(f.users);
  vi.spyOn(f.users, 'bySubject').mockImplementationOnce(async subject => {
    entered(); await held; return lookup(subject);
  });
  const resetting = f.service.resetPassword({ token: 'fixture-reset', newPassword: 'private-password' });
  await began;
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('NOT_READY');
  release(); await resetting;
  expect(f.provider.reset).toHaveBeenCalledTimes(1);
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('UNAUTHENTICATED');
});
```

For password, hold `provider.replacePassword`, assert old authority is closed, then return a fresh SID and verify only that SID is admitted after final confirmed CAS. Retain the existing same-subject proof/revocation test.

- [ ] **Step 2 — Run RED:** `npm test -- test/auth/authority-lifecycle.spec.ts -t "reset subject|password"`.
- [ ] **Step 3 — Minimal password publication changes at existing anchors:**

```ts
const ticket = this.authority.fence(current.account.workosUserId);
let fenced: AccountRead;
try {
  fenced = await this.confirmed(current, invalidateAccount(current.account, this.now()));
} catch (error) {
  this.authority.fail(ticket);
  throw error;
}
```

Keep that token for the rest of this password operation. In the existing definitive-`INVALID_REQUEST` rollback branch, replace the ignored confirmed call with:

```ts
await this.confirmed(fenced, {
  ...current.account, sessionEpoch: fenced.account.sessionEpoch, updatedAt: this.now(),
}).then(saved => this.publish(ticket, saved))
  .catch(() => this.authority.fail(ticket));
```

On every other error after the fence, call `fail(ticket)` before rethrowing; do not swallow the original safe AuthFault. In the final write:

```ts
saved = this.publish(ticket, await this.confirmed(fenced, {
  ...fenced.account, passwordChangeRequired: false,
  currentWorkosSessionId: fresh.sessionId, updatedAt: this.now(),
}));
```

In its failure cleanup, `fail(ticket)`, fence the represented fresh SID if any, and revoke that unissued fresh session as in Task 4. Preserve current proof, provider replacement, final cookie, old-session revoke, and increased sessionEpoch. A rollback **must not** allocate a new fence after a concurrent deactivation; the original token is its only publication right.

For reset, immediately after provider returns `result.workosUserId`:

```ts
const ticket = this.authority.fence(result.workosUserId, 'revocation');
```

Wrap the existing three-attempt local loop in try/catch. On confirmed CAS:

```ts
if (saved.outcome === 'confirmed') {
  this.publish(ticket, saved.value);
  return { ok: true };
}
```

On thrown/uncertain/exhausted/conflicting terminal outcome, `fail(ticket)` and preserve the existing safe error; no provider reset replay and no unconfirmed publication.

- [ ] **Step 4 — Add/run cases** for password replacement timeout, final CAS uncertainty, rollback acknowledgement held, rollback defeated by deactivation, reset CAS conflicts then success, unknown/inactive subject, provider failure before a verified subject, no duplicate provider reset, and mail-only methods leaving authority untouched. The existing `INVALID_REQUEST` rollback must leave the old SID usable **only** if its rollback is confirmed and its token still current.
- [ ] **Step 5 — Run GREEN:** `npm test -- test/auth/password.spec.ts test/auth/recovery.spec.ts test/auth/authority-lifecycle.spec.ts test/auth/http.spec.ts`; commit named files with `fix(auth): publish password and reset authority safely`.

## Task 6: RED/GREEN Administration's shared authority hooks

**Files:** modify `backend/src/administration/administration.service.ts`, `backend/test/administration/fixtures.ts`, `backend/test/administration/lifecycle.spec.ts`, `backend/test/administration/deactivation.spec.ts`, `backend/test/auth/integration/accounts.ts`, `backend/test/auth/authority-lifecycle.spec.ts`.

- [ ] **Step 1 — Add failing shared-service regression to `authority-lifecycle.spec.ts`:**

```ts
it('administration fences before its durable write and before cleanup runs', async () => {
  const f = await administrationFixture();
  const auth = new AuthService({ users: f.users, provider: f.provider, authority: f.authority });
  const before = (await auth.authenticate('sealed_1')).principal;
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const cas = f.users.compareAndSwap.bind(f.users);
  vi.spyOn(f.users, 'compareAndSwap').mockImplementationOnce(async (current, next) => {
    entered(); await held; return cas(current, next);
  });
  const deactivating = f.service.deactivate(f.admin, before.account.userId, {});
  await began;
  await expect(auth.authenticate('sealed_1')).rejects.toThrow('NOT_READY');
  release(); await deactivating;
  await expect(auth.authenticate('sealed_1')).rejects.toThrow('UNAUTHENTICATED');
});
```

Import the existing `administrationFixture` directly. Update that fixture to create one `AccountAuthority({ users })`, explicitly warm both initial subjects during setup, pass it into `AdministrationService`, and return it as `authority`. Every test-created AuthService in `test/administration/lifecycle.spec.ts` must receive `authority: f.authority`. In `test/auth/integration/accounts.ts`, construct AuthService first, then inject `authority: auth.authority` into Administration. Do not share authority accidentally through a module global.

- [ ] **Step 2 — Run RED:** `npm test -- test/auth/authority-lifecycle.spec.ts -t "administration fences"`.
- [ ] **Step 3 — Add the narrow optional option with fail-closed use:**

```ts
authority?: AccountAuthorityPort;
```

Add this private accessor:

```ts
private authority(): AccountAuthorityPort {
  if (!this.o.authority) throw new AuthFault('NOT_READY');
  return this.o.authority;
}
```

The option is optional only to preserve compile compatibility until **P3 composes it**. All account-mutating Administration operations must call the accessor **before external provisioning or mutation work** and fail closed when missing. Do not create a second authority or use a no-op fallback. Read-only listing and mail-only reset retain their current behavior.

Add a third parameter `change: AccountAuthorityChange = 'revocation'` to private `save`; `deactivate` keeps its default and `reactivate` passes `'replacement'`. Capture authority and fence immediately before CAS:

```ts
const authority = this.authority();
const ticket = authority.fence(expected.account.workosUserId, change);
let result;
try { result = await this.o.users.compareAndSwap(expected, next); }
catch {
  authority.fail(ticket);
  throw new AdministrationFault('ACCOUNT_WRITE_UNCERTAIN');
}
if (result.outcome !== 'confirmed') {
  authority.fail(ticket);
  throw new AdministrationFault(result.outcome === 'conflict'
    ? 'ACCOUNT_CONFLICT' : 'ACCOUNT_WRITE_UNCERTAIN');
}
if (!authority.publish(ticket, result.value))
  throw new AdministrationFault('ACCOUNT_WRITE_UNCERTAIN');
return result.value;
```

Map publication validation failures to existing safe `ACCOUNT_WRITE_UNCERTAIN`; never reflect schema/provider values. For deactivation/reactivation no-op branches, replace blind pre-fence-read publication with:

```ts
const authority = this.authority();
await authority.warm(current.account.workosUserId);
```

This explicit control-plane warm refuses pending/uncertain writes, so a no-op cannot resurrect the pre-revocation account. Keep existing no-op DB-write counts and post-confirmation cleanup. Keep null-SID reactivation and existing cleanup after confirmation. In create, resolve authority before `provider.createUser`; after its existing identity validation, acquire a replacement fence for the created subject, then publish the confirmed `users.insert` result before returning. In the existing insert failure branch call `fail(ticket)` and preserve `ACCOUNT_PROVISIONING_INCOMPLETE`. Do not modify `requireAdmin`'s fresh storage check: this is a control-plane check, not model dispatch.

- [ ] **Step 4 — Add/run tests** for held/uncertain/thrown administration save, repeated inactive/active no-ops updating authority without another write, create publishing onboarding/null-SID authority, missing shared option refusing create/deactivate/reactivate before provider/write, recovery-mail not fencing, and deactivation → reactivation → login keeping old SID denied. Hold a deactivation CAS and concurrently run an already-active reactivate no-op: it must return `NOT_READY`, not restore the active SID. Hold a replacement acknowledgement and supersede it with a revocation; release it and prove it cannot publish. Keep post-confirmation cleanup ordering/failure/pagination tests unchanged in intent.
- [ ] **Step 5 — Run GREEN:** `npm test -- test/administration/ test/auth/integration/ test/auth/authority-lifecycle.spec.ts`. Commit named files with `fix(auth): fence and publish administration account changes`.

**Composition gate:** current `AppService` does not yet inject this option. Until P3's handoff is implemented, account-mutating Administration routes intentionally return `NOT_READY`; P2A must report this integration dependency, not claim fully assembled readiness or remove the guard. P3 may not be dispatched before this worker's contract/checks are verified.

## Task 7: RED/GREEN actual private HTTP authentication through model dispatch

**Files:** create `backend/test/auth/authority-http.spec.ts`; use existing fixture files read-only.

- [ ] **Step 1 — Write the actual HTTP-to-model test.** Import real `configurePrivateHttp`, `ChatHttpModule`, `configureChatHttp`, `RequestIdentityStore`, `ServerIdentityResolver`, `textConfigFixture`, `textSnapshot`, `PROPOSED_MEMORY_TEXT_POLICY`, `authFixture`, `admittedAccount`, `DEFAULT_BUDGETS`, Nest Test, Supertest, and Vitest from their existing files:

```ts
it('real HTTP authentication reaches model dispatch with zero pre-model database operations', async () => {
  const identities = new RequestIdentityStore();
  const identity = new ServerIdentityResolver(identities);
  const f = await authFixture(admittedAccount({ userId: 'aurvin-dev-user' }));
  const h = textConfigFixture(textSnapshot(1), dependencies => ({
    ...dependencies,
    memoryFirst: {
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async envelope => ({
        kind: 'saved' as const, epoch: envelope.epoch, sessionId: envelope.sessionId,
        version: envelope.version, fence: envelope.fence,
      }),
    },
  }));
  const module = await Test.createTestingModule({
    imports: [ChatHttpModule.register({
      runtime: h.runtime, sessions: h.p.sessions, messages: h.p.messages,
      identity, principal: () => identities.principal(), budgets: DEFAULT_BUDGETS,
      currentConfig: h.currentConfig,
    })],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  app.setGlobalPrefix('api');
  configurePrivateHttp(app, {
    auth: f.service, identities, frontendOrigin: 'http://localhost:5173', secureCookie: false,
  });
  configureChatHttp(app, DEFAULT_BUDGETS);
  let operations = 0;
  const fail = () => { operations++; throw new Error('blocked-application-storage'); };
  const spies = [
    vi.spyOn(f.collection, 'findOne').mockImplementation(fail),
    vi.spyOn(f.collection, 'find').mockImplementation(fail),
    vi.spyOn(f.collection, 'updateOne').mockImplementation(fail),
    vi.spyOn(f.collection, 'replaceOne').mockImplementation(fail),
  ];
  // Guard every existing runtime persistence method too, not only users.bySubject.
  for (const port of Object.values(h.p)) {
    if (!port || typeof port !== 'object') continue;
    for (const key of Object.keys(port)) {
      if (typeof (port as Record<string, unknown>)[key] === 'function')
        spies.push(vi.spyOn(port as Record<string, () => unknown>, key).mockImplementation(fail));
    }
  }
  const wire = h.fetcher.getMockImplementation()!;
  let beforeModel: number | undefined;
  h.fetcher.mockImplementation(async (url, init) => {
    beforeModel = operations;
    expect(f.provider.read).toHaveBeenCalled();
    return wire(url, init);
  });
  try {
    await app.init();
    const api = request(app.getHttpServer());
    const accepted = await api.post('/api/sessions')
      .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', 'http://localhost:5173')
      .send({ sessionId: null, content: 'Hello', idempotencyKey: 'authority-http-0001' }).expect(202);
    await api.get(`/api${accepted.body.streamPath}`)
      .set('Cookie', 'aurvin_wos_session=sealed_1').expect(200);
    expect(beforeModel).toBe(0);
    expect(operations).toBe(0);
    expect(f.provider.read).toHaveBeenCalledTimes(2);
    const modelBody = JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body));
    expect(modelBody.user).toBe('aurvin-dev-user');
  } finally {
    for (const spy of spies) spy.mockRestore();
    await app.close();
    await h.dispose();
  }
});
```

Use exact imports: `../../src/http/index.js`, `../../src/http/configure-private-http.js`, `../../src/platform/identity/request-identity-store.js`, `../../src/platform/identity/server-identity-resolver.js`, `../runtime/text-config-fixture.js`, `../model/config-snapshot.js`, `../../src/chat-runtime/memory-text.js`, `../../src/contracts/budgets.js`, and `./fixtures.js`. Add `'reflect-metadata'` before Nest imports. If Vitest's overloads require separate spy arrays for the collection and structural port object, separate those arrays without weakening guards or casting production types.

This test uses the **real AuthService and private middleware, real ChatHttp controllers/SSE transport, real DurableChatRuntime/MemoryText, and actual model fetch boundary**. Only external WorkOS responses, persistence fixtures, and the model wire are deterministic. The model boundary is not a fake controller callback. The injected save is outside this test's pre-model claim; P3's held-archive tests retain actual archive projection coverage.

- [ ] **Step 2 — Run RED:** before Task 3's authenticate replacement, this test must return 503/not dispatch because the actual account storage is blocked. During implementation, preserve a RED capture or temporarily test the prior lookup in an isolated local patch, then immediately restore your own temporary edit. Never revert others' files. A fixture that succeeds after mocking `authenticate` is invalid evidence.
- [ ] **Step 3 — Make the fixture pass only through the implemented authority path.** Do not loosen `configurePrivateHttp`, fake ALS principals, remove origin checks, skip `admitAccount`, or add `prepare` to turn routes. If another existing runtime pre-model storage call is revealed, report it to P3 with the failing test; do not edit runtime/Calendar files in P2A.
- [ ] **Step 4 — Add HTTP failure/isolation cases** using the same real middleware:

```ts
it.each(['cold', 'expired', 'uncertain', 'closed'] as const)(
  'denies %s authority without opening storage or reaching the model', async mode => {
    const f = await authFixture(admittedAccount(), { warm: false });
    let now = 0;
    const authority = new AccountAuthority({ users: f.users, nowMs: () => now });
    if (mode !== 'cold') await authority.warm('user_fixture_1');
    if (mode === 'expired') now = 900_000;
    if (mode === 'uncertain') authority.fail(authority.fence('user_fixture_1'));
    if (mode === 'closed') authority.close();
    const auth = new AuthService({ users: f.users, provider: f.provider, authority });
    const app = express();
    const identities = new RequestIdentityStore();
    const dispatch = vi.fn();
    const lookup = vi.spyOn(f.users, 'bySubject').mockRejectedValue(new Error('blocked'));
    configurePrivateHttp({ use: app.use.bind(app) }, {
      auth, identities, frontendOrigin: 'http://localhost:5173', secureCookie: false,
    });
    app.post('/api/sessions', (_req, res) => { dispatch(); res.status(202).json({}); });
    const response = await request(app).post('/api/sessions')
      .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', 'http://localhost:5173')
      .send({}).expect(503);
    expect(response.body).toEqual({ error: { code: 'NOT_READY', retryable: true } });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  },
);
```

Also cover confirmed missing 401, inactive/mismatched SID 401, onboarding 403, user-admin denial, provider verification failure despite a ready snapshot, and a held provider.read that resumes **after** deactivation: the post-verification snapshot must deny it.

- [ ] **Step 5 — Run GREEN:** `npm test -- test/auth/authority-http.spec.ts test/http/private-boundary.spec.ts test/auth/provider.spec.ts`. Commit only the new test with `test(auth): prove real HTTP zero-database model admission`.

## Task 8: Security, regressions, and P3 handoff

**Files:** extend `backend/test/auth/account-authority.spec.ts`, `backend/test/auth/authority-lifecycle.spec.ts`, `backend/test/auth/authority-http.spec.ts` only as failing assertions require. Do not edit Calendar files.

- [ ] **Step 1 — Add a no-leak assertion around the real HTTP responses and captured model body:**

```ts
const secrets = ['raw-password-sentinel', 'raw-reset-token', 'sealed_1', 'raw-access', 'raw-refresh'];
const visible = JSON.stringify({ responses, modelBodies, logs });
for (const secret of secrets) expect(visible).not.toContain(secret);
expect(visible).not.toMatch(/sessionEpoch|currentWorkosSessionId|emailNormalized|workosUserId/);
```

In this test define `responses` as the collected HTTP JSON bodies (not Set-Cookie headers), `modelBodies` as parsed model request bodies, and `logs` as captured `console.log/info/warn/error` arguments via `vi.spyOn(...).mockImplementation(() => undefined)`. Restore spies in `finally`. `Set-Cookie` is the deliberate HttpOnly sealed-session transport and is **not** falsely labeled a credential leak. Do not include the intentionally server-only snapshot in the public projection assertion.

- [ ] **Step 2 — Run RED/GREEN focused coverage:** `npm test -- test/auth/ test/administration/ test/http/private-boundary.spec.ts src/platform/identity/ test/voice/transport/`. Verify actual discovery; use `functions.glob` before correcting a path that discovers no tests. Existing SDK, onboarding, CSRF, refresh, isolation, and recovery assertions must remain meaningful.
- [ ] **Step 3 — Run backend checks separately** from `backend`:

```text
npm run build
npm run lint
npm test
npm run test:e2e
```

Record exit status, passed/failed/skipped counts, exact names, and any known P1/P4 mirror or existing Calendar failures separately. If assembled auth fixtures create a brand-new `AppService.auth` then immediately use preexisting cookies without `/auth/me`, return that specific fixture update to P3; never auto-warm from a turn to make it green.

- [ ] **Step 4 — Run required Calendar regressions without editing them:**

```text
npm test -- test/assembly/calendar-assembly.spec.ts test/performance/calendar-memory-first.spec.ts test/performance/calendar-tool-latency.spec.ts test/plugins/google-calendar/connection-prepared.spec.ts test/plugins/google-calendar/tools-boundaries.spec.ts
```

Confirm this executes the root-required prepared blocked-storage routes, repeated prepared-owner preparation, held archives, direct/proposal essential barriers, W1–W4 recovery, pinned-ID readback, competing tabs/text-live confirmations, cancel-at-dispatch/success, exact expiry, policy expiry, invalidation/late-result isolation, and `profiles ...` cases. If a required named case is in another existing spec, locate it with `grep` and run that exact file too. Report synthetic command waves separately from `performance.now()` observations. A baseline failure is not authorization to edit Calendar or remove its assertion.

- [ ] **Step 5 — Commit only additional focused test changes** with `test(auth): cover authority fencing and credential isolation`. Report the following contract to the orchestrator/P3; do not create another plan or alter central source here:

```ts
// P3: keep existing AppService AuthService construction (it owns one authority).
// Inject that very instance, not another map, into existing Administration:
this.administration = new AdministrationService({
  users: this.users,
  provider: this.authProvider,
  authority: this.auth.authority,
  onUserDeactivated: userId => this.onUserDeactivated(userId),
});
// P3: call this synchronously when stopping new authentication/config admissions,
// before awaiting cleanup/persistence release:
this.auth.authority.close();
```

P3 handoff requirements:

1. Keep `AuthModule` receiving the same `service.auth`; `AuthController.prepare` is the startup/reload control-plane warm. Do not add account hydration to `prepareOwner`, ordinary private middleware, text submit/retry/SSE, readiness, voice final-speech processing, or model callbacks.
2. Modify `backend/test/assembly/auth-wiring.spec.ts`'s `wiredApp` flow to call real `/api/auth/me` for each persisted cookie before private requests; a new AppService starts cold by design. Assert Administration and Auth use the same authority by deactivating a prepared account through the real admin route and checking the next private request denies it with storage blocked.
3. Supersede `plan3.md`'s finding 7, “Authentication limitation” paragraph, Task 10 Step 5 counter-reporting exception, and final admission-boundary limitation: the original bySubject bypass is no longer acceptable. Preserve the historical finding as provenance if recording it, but acceptance must use the actual fixed path.
4. P3 owns `backend/test/assembly/web-search-composition.spec.ts`: real AuthService → `configurePrivateHttp` → actual `prepareOwner` → submit/SSE controller → runtime → model fetch with **all application storage** blocked/instrumented after outside-turn preparation. Do not substitute a no-op owner-preparation callback as full assembled evidence.
5. P3 owns `backend/test/voice/web-search-voice.spec.ts`: prepare via actual auth control plane, verify real `VoiceUpgradeAdmission` with the same AuthService, bind the admitted owner, and exercise actual voice session/AgentVoiceAdapter/shared runtime dispatch. Zero-DB evidence begins before that authentication boundary, not at trusted identity injection. WorkOS SDK fixtures still run `WorkosProvider.read` semantics separately.
6. Count operations from both HTTP submit and SSE authentication until first model fetch, with selected history and account/plugin state explicitly prepared outside the measured turn. Also test expiry/uncertainty denying before dispatch, held archives, loop continuations, and immediate next turns. Keep discovery/connect/refresh counters for P2 **separate** from preserved WorkOS session verification/refresh.
7. Do not claim active WebSocket principals are automatically reauthenticated by this map. Preserve existing user/session stop hooks; any additional active-voice authority requirement belongs to P3's shared boundary, not a second auth runtime or Calendar change.
8. P5 records out-of-process freshness, expiry/re-preparation UX, optional-until-composed admin guard, provider reset ambiguity, operation counts, actual commits, and all prerequisite skips.

## Verification/coverage exit matrix

| Requirement | Runnable ownership / evidence |
| --- | --- |
| Real HTTP authenticate → model has zero pre-model DB operations | P2A `authority-http.spec.ts`; P3 actual AppService/prepareOwner + plugin/text/voice assembly |
| Cold/missing/expired/uncertain authority denies, no lookup fallback | P2A authority kernel + real private HTTP matrix |
| WorkOS read and admitAccount intact, refreshed SID rechecked | Existing provider/access/session/private HTTP suites plus Task 3/7 |
| Login replacement, logout, password/rollback, actual reset | Existing focused suites + held-ack `authority-lifecycle.spec.ts` |
| Admin create/deactivate/reactivate, recovery-mail semantics | Administration fixtures/suites + shared authority lifecycle |
| Concurrent revocation wins against warm/login/rollback/stale publication | Kernel token-identity tests + service CAS/held-result races |
| Entry/bytes/warm-read bounds; no unsafe eviction/ABA | `account-authority.spec.ts`, including real 1024-entry boundary |
| Calendar behavior unchanged | Root-required deterministic suites, with preserved baseline attribution |
| No secrets in public/model/log projections | Existing auth/provider HTTP tests + Task 8 sentinels |
| Honest scope and readiness | Worker report + P3/P5 handoff; review **skipped** |

### Planned versus actually run

- **During this planning task:** source/caller/ownership inspection, current WorkOS documentation lookup, plan coverage/type/link/placeholder checks, and Git path/whitespace checks only. No application implementation or tests are represented as run by this document.
- **Worker must run:** the focused RED/GREEN commands and backend verification above. Record failures and skips, not just commands. Do not require unrelated frontend changes/tests for this auth-only worker; P3/P5 retain the full feature verification matrix.
- **Native MongoDB:** unrun unless operator-supplied isolated `AURVIN_TEST_MONGODB_URI` and `AURVIN_TEST_DB_PREFIX=aurvin_p2_test_` are available and authorized. Deterministic RecordStore fixtures are not native MongoDB/topology certification.
- **Live WorkOS/OpenRouter/Google/MCP/voice services, paid checks, staging, public deployment:** unrun/not authorized. Do not fetch secrets, provision infrastructure, or contact live authentication/model providers.
- **Blockers/dependencies:** P3 shared-authority injection and full AppService/voice instrumentation remain required before global AC6/readiness claims. External writer coherence is deliberately not implemented; admitting those writers would require a separate security design, not shorter expiry or an unapproved general cache.

## Planner self-check and plan-only commit

- [x] Check every requested lifecycle, bound, fail-closed state, race, and handoff against the coverage matrix.
- [x] Check all port/snapshot/method/type names match the frozen contract; no principal/cookie cache, generic framework, new dependency, or Calendar ownership leak.
- [x] Check Markdown links and all modify/read-only source paths exist; distinguish new create paths from nonexistent references.
- [x] Search this document for unresolved placeholder markers; fix any before commit.
- [ ] Immediately before committing, run `git status --short` and `git diff --check -- docs/web-search/plan2a.md`. Preserve concurrent P2/user work and do not stage `.commandcode/`.
- [ ] Stage only `docs/web-search/plan2a.md` if untracked, then use the user-required path-scoped commit:

```text
git add -- docs/web-search/plan2a.md
git commit --only -m "docs(web-search): plan 2A - authentication authority snapshot" -- docs/web-search/plan2a.md
git show --format=fuller --stat HEAD
git diff-tree --no-commit-id --name-only -r HEAD
```

The committed path list must be **only** `docs/web-search/plan2a.md`. Return its hash, exact port/invalidation contract, P2A versus P3 ownership, checks actually run, and the stated limitations. A committed plan is not a completed worker.
