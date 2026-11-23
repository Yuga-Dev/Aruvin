# Aurvin Dev Mode — P1 Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save a default-off Config flag and expose a strictly authenticated, process-local User/Dev selection and one-shot announcement.

**Architecture:** Activate only the existing confirmed Config snapshot; keep selection and pending state separately in one `AppService` authority shared by Config and the future runtime. Use the existing admitted principal and synchronous account authority, not a role assumption, chat ID, cookie value, or client-provided mode.

**Tech Stack:** TypeScript (NodeNext), NestJS, Zod, Vitest, Supertest and existing Config CAS/account authority.

---

All tasks: **P1 worker**; commands start in `backend/` unless marked repo root. Use the existing helpers, offline fixtures and required headers. No migration, dependency, environment flag, research, review, provider call, or new storage. Add only the specified files/edits; ask the orchestrator for the serialized commit slot before each commit. P2 owns the browser; P3 takes over `app.service.ts` runtime sections after P1 and owns all text/voice auth-to-dispatch and tool/prompt changes. P1 touches private HTTP middleware only to omit unrelated owner warm-up on its two new Config routes.

## Downstream contracts

**P2 wire** (relative to existing `/api` base):

- Existing `GET /admin/config` and revisioned `PUT /admin/config` are unchanged except `settings.devModeEnabled`. Current server always projects a boolean, default `false`; stored records and settings requests may omit it (means `false`). Only literal booleans are valid; preserve closed keys. PUT body stays `{ protocolVersion: 1, expectedRevision, settings }`; no `mode` in settings or this response. Browser validators should mirror the optional field; render from the persisted flag, not draft state. Deploy browser/server validators together: unmodified old clients reject new response keys.
- `GET /admin/config/dev-mode` (no body) → `200 { protocolVersion: 1, enabled: false, mode: null }` when inactive, or `200 { protocolVersion: 1, enabled: true, mode: "user" | "dev" }`. This reads **active** enablement, not stored-but-unpublished settings. The Config selector uses this response to confirm active enablement including on reload; do not use Config `activation === "active"` as the enablement test (that flag describes chat configuration).
- `PUT /admin/config/dev-mode` with exact JSON `{ protocolVersion: 1, mode: "user" | "dev" }` → `200 { protocolVersion: 1, enabled: true, mode }`. Same selection succeeds without re-arming. Off: `409 DEV_MODE_DISABLED`. Invalid query/body: `400 INVALID_CONFIG_REQUEST`. Existing auth fault body `{ error: { code, retryable } }`: `401 UNAUTHENTICATED`, `403 FORBIDDEN` / `PASSWORD_CHANGE_REQUIRED`; current account snapshot unavailable: `503 NOT_READY`. Config faults keep `{ protocolVersion: 1, error: { code, retryable, currentRevision, fieldErrors } }` (`currentRevision: null`, `fieldErrors: []` for disabled). Existing Origin/TLS/body/rate rules remain. Neither response contains any user/session identifier or pending state.
- Keep requests same-origin with the existing session cookie. On an uncertain mode PUT result or disable race, re-read mode before showing a selection; a mode-specific 409 is not a Config revision conflict. Mirror `DEV_MODE_DISABLED` and the `devModeEnabled` field path in the existing strict error guards; recognize the existing auth error envelope for the new mode calls.

**P3 internal**: `AppService.devMode` implements `DevModeTurnAuthority` in `backend/src/admin-config/dev-mode-authority.ts`. `peek(principal?: AuthPrincipal): DevModeDecision | null` is synchronous and non-consuming. `consumeForDispatch(principal?: AuthPrincipal): DevModeDecision | null` synchronously reads the latest selection and atomically spends the prefix if pending; returned `{ mode: 'user' | 'dev', announce: boolean }` is immutable. `null` means no diagnostics (not permission to admit chat/tools). Only pass a trusted, owner-matched principal already admitted by existing text or voice auth; no deriving it from `ResolvedIdentity`, turn/request fields, or a chat/voice ID. Both channels use this **same instance** and local account session identity (`userId`, WorkOS subject/session, `sessionEpoch`). Unavailable/stale accounts cannot authorize diagnostics; preserve all existing turn admission/revocation checks.

- Peek as needed for route/capability selection and token preflight; do not use an early peek across an await as effect authority. After all rejectable preflight and the last cancellation check, synchronously resolve the final mode/context and consume at first **actual eligible current-user model dispatch**, without a yield between resolve/consume and handing off the request. If the existing model wrapper can still reject before dispatch, bind the commit there, not at submit, enqueue, stream start or speech finalization. Budget for the late mode/prefix without rebuilding any persisted context. A cancelled/rejected/deduplicated/no-model turn, partial speech or unused dictation must not spend it.
- Freeze the decision (including `null`) on that admitted execution only; retries and continuations reuse the frozen context/mode without touching the latch. A later selection or Config disable cannot relabel in-flight execution. Direct effect-only paths must also respect Dev; gate at the late effect admission with no stale peek, and don't spend on a tool-only outcome. An already-admitted User tool path must not be relabeled Dev on continuation or spend another turn's pending transition. P3 owns the routing, budgets, tool suppression and raw-transcript checks; no changes to existing auth/preparation budgets or persistence ordering.
- Off/ineligible runtime checks short-circuit without a lookup; eligible checks do a synchronous account snapshot and bounded map lookups only. No mode-specific promise, timer, model call, network, DB, or auth refresh in pre-dispatch. No mode state or render guidance goes into history, checkpoint, replay record, telemetry, `AssemblyPorts` fixture identity, or browser storage.

## Task 1 — Default-off revisioned setting

Files: `backend/src/contracts/admin-config-wire.ts`, `backend/src/contracts/admin-config.ts`, `backend/src/platform/config/manageable-config.ts`, `backend/src/contracts/admin-config.spec.ts`.

- [ ] **Red test.** Append to `admin-config.spec.ts` (existing `storedConfigDocumentSchema`, `defaultManageableSettings`, `manageableSettingsSchema`, `isManageableSettings` imports):

```ts
it('defaults legacy dev enablement off, accepting only a boolean and never a mode', () => {
  const defaults = defaultManageableSettings();
  const legacy = { ...defaults };
  delete legacy.devModeEnabled;
  expect(isManageableSettings(legacy)).toBe(true);
  const doc = {
    _id: 'aurvin', schemaVersion: 1, revision: 1, settings: legacy,
    credentials: { openrouter: null, deepgram: null },
    updatedAt: '2026-11-10T00:00:00.000Z', updatedBy: 'admin',
  };
  expect(storedConfigDocumentSchema.parse(doc).settings.devModeEnabled).toBe(false);
  expect(defaults.devModeEnabled).toBe(false);
  const enabled = { ...defaults, devModeEnabled: true };
  expect(manageableSettingsSchema.parse(enabled).devModeEnabled).toBe(true);
  expect(isManageableSettings(enabled)).toBe(true);
  for (const raw of [{ ...defaults, devModeEnabled: 'true' },
    { ...defaults, devModeEnabled: null }, { ...defaults, mode: 'dev' }]) {
    expect(manageableSettingsSchema.safeParse(raw).success).toBe(false);
    expect(storedConfigDocumentSchema.safeParse({ ...doc, settings: raw }).success).toBe(false);
    expect(isManageableSettings(raw)).toBe(false);
  }
});
```

- [ ] **Run red:** `npm test -- src/contracts/admin-config.spec.ts -t "defaults legacy dev enablement"` → fails on absent setting (`undefined` instead of `false`).
- [ ] **Implement.** Add `devModeEnabled?: boolean;` to `ManageableSettings`, `'devModeEnabled',` to `ADMIN_CONFIG_FIELD_PATHS`, and `devModeEnabled: z.boolean().default(false),` to the strict top-level manageable Zod schema (shared by stored/read, settings save and compatibility check). In `isManageableSettings`, replace the opening condition, keeping the existing shape and checks after it:

```ts
if (!record(value)) return false;
const { devModeEnabled, ...base } = value;
if (Object.hasOwn(value, 'devModeEnabled') && typeof devModeEnabled !== 'boolean') return false;
```

Follow with the existing `if (!exact(base, {` and leave its shape and subsequent refinements on `value` unchanged. Add `devModeEnabled: false,` to `defaultManageableSettings()`'s return literal. In `projectPublicAdminConfig`, retain the existing clone/default branch and immediately add `settings.devModeEnabled ??= false;`. Keep version 1 and the existing save, prepare, CAS, confirm and publish flow.

- [ ] **Run green:** `npm test -- src/contracts/admin-config.spec.ts src/platform/config/manageable-config.spec.ts` → both pass, including the legacy settings fixtures.
- [ ] **Commit (repo root):** `git commit --only -m "feat(config): persist default-off dev mode enablement" -- backend/src/contracts/admin-config-wire.ts backend/src/contracts/admin-config.ts backend/src/platform/config/manageable-config.ts backend/src/contracts/admin-config.spec.ts`

## Task 2 — In-memory selection and one-shot authority

Files: create `backend/src/admin-config/dev-mode-authority.ts` and `backend/src/admin-config/dev-mode-authority.spec.ts`; modify `backend/src/auth/account-authority.ts`, `backend/src/contracts/admin-config-wire.ts`, `backend/src/admin-config/errors.ts`.

- [ ] **Red test.** In `dev-mode-authority.spec.ts` after the required file header:

```ts
import { expect, it, vi } from 'vitest';
import { AccountAuthority } from '../auth/account-authority.js';
import { admitAccount } from '../auth/access.js';
import { admittedAccount } from '../../test/auth/fixtures.js';
import { DevModeAuthority } from './dev-mode-authority.js';

it('shares one synchronous announcement and fences sessions without I/O', async () => {
  const account = admittedAccount({ role: 'super-admin' });
  const subject = account.workosUserId;
  const bySubject = vi.fn(async () => ({ account, revision: 1 }));
  const accounts = new AccountAuthority({ users: { bySubject }, onSessionFence: (id): void => { mode.invalidate(id); } });
  const mode = new DevModeAuthority(accounts);
  accounts.publish(accounts.fence(subject), { account, revision: 1 });
  const text = admitAccount(account, 'sid_1');
  const voice = admitAccount({ ...account }, 'sid_1');
  const other = { ...account, workosUserId: 'other_subject', userId: 'other_user' };
  accounts.publish(accounts.fence(other.workosUserId), { account: other, revision: 1 });
  const otherAdmin = admitAccount(other, 'sid_1');
  expect(mode.peek(text)).toBeNull();
  mode.setEnabled(true);
  expect(mode.peek()).toBeNull();
  expect(mode.peek(admitAccount({ ...account, role: 'user' }, 'sid_1'))).toBeNull();
  expect(mode.peek(admitAccount({ ...account, passwordChangeRequired: true }, 'sid_1'))).toBeNull();
  expect(mode.peek(text)).toEqual({ mode: 'user', announce: true });
  expect(mode.consumeForDispatch(voice)).toEqual({ mode: 'user', announce: true });
  expect(mode.consumeForDispatch(text)).toEqual({ mode: 'user', announce: false });
  mode.select(text, 'dev');
  mode.select(voice, 'user');
  mode.select(text, 'dev');
  expect(mode.read(otherAdmin)).toBe('user');
  expect(mode.read(text)).toBe('dev');
  const frozen = mode.consumeForDispatch(text);
  expect(frozen).toEqual({ mode: 'dev', announce: true });
  mode.select(voice, 'dev');
  expect(mode.consumeForDispatch(voice)).toEqual({ mode: 'dev', announce: false });
  expect(bySubject).not.toHaveBeenCalled();
  await accounts.warm(subject);
  mode.setEnabled(true); // e.g. a confirmed unrelated settings save
  expect(mode.peek(voice)).toEqual({ mode: 'dev', announce: false });
  mode.select(text, 'user');
  expect(mode.consumeForDispatch(voice)).toEqual({ mode: 'user', announce: true });
  expect(mode.consumeForDispatch(text)).toEqual({ mode: 'user', announce: false });
  mode.select(text, 'dev');
  mode.setEnabled(false);
  expect(mode.peek(voice)).toBeNull();
  expect(frozen).toEqual({ mode: 'dev', announce: true });
  mode.setEnabled(true);
  expect(mode.peek(text)).toEqual({ mode: 'user', announce: true });
  mode.select(voice, 'dev');
  // A sign-in fence clears cached mode even if the test provider reuses the ID.
  accounts.publish(accounts.fence(subject), { account, revision: 1 });
  expect(mode.peek(text)).toEqual({ mode: 'user', announce: true });
  mode.select(voice, 'dev');
  const ticket = accounts.fence(subject, 'revocation');
  expect(mode.consumeForDispatch(voice)).toBeNull();
  accounts.publish(ticket, { account: { ...account, currentWorkosSessionId: null, sessionEpoch: 1 }, revision: 2 });
  const fresh = { ...account, currentWorkosSessionId: 'sid_next', sessionEpoch: 1 };
  accounts.publish(accounts.fence(subject), { account: fresh, revision: 3 });
  expect(mode.peek(text)).toBeNull();
  expect(mode.consumeForDispatch(admitAccount(fresh, 'sid_next'))).toEqual({ mode: 'user', announce: true });
  expect(bySubject).toHaveBeenCalledTimes(1); // only the explicit warm
});
```

- [ ] **Run red:** `npm test -- src/admin-config/dev-mode-authority.spec.ts` → unresolved `dev-mode-authority.js`.
- [ ] **Implement.** Add `export const DEV_MODES = ['user', 'dev'] as const;`, `export type DevMode = typeof DEV_MODES[number];` and `'DEV_MODE_DISABLED',` in `ADMIN_CONFIG_ERROR_CODES` in `admin-config-wire.ts`; add `DEV_MODE_DISABLED: 409,` to `STATUS` in `errors.ts` (non-retryable). In `account-authority.ts` add `onSessionFence?: (workosUserId: string) => void;` to `AccountAuthorityOptions`. At the end of `fence` replace the direct `return this.begin(...)` with:

```ts
const ticket = this.begin(subject, 'fenced', change);
this.o.onSessionFence?.(subject);
return ticket;
```

Do not call the hook from warm/read/publish; existing login/replacement, logout, password change/reset and deactivation already call `fence`. Create `dev-mode-authority.ts` with its project header and:

```ts
import { requireSuperAdmin } from '../auth/access.js';
import { ACCOUNT_AUTHORITY_POLICY, type AccountAuthorityPort } from '../auth/account-authority.js';
import { AuthFault } from '../auth/errors.js';
import type { DevMode } from '../contracts/admin-config-wire.js';
import type { AuthPrincipal } from '../contracts/auth.js';
import { AdminConfigFault } from './errors.js';

export type DevModeDecision = Readonly<{ mode: DevMode; announce: boolean }>;
export interface DevModeTurnAuthority {
  peek(principal?: AuthPrincipal): DevModeDecision | null;
  consumeForDispatch(principal?: AuthPrincipal): DevModeDecision | null;
}
const initial: DevModeDecision = Object.freeze({ mode: 'user', announce: true });
type Entry = { userId: string; sessionId: string; epoch: number; decision: DevModeDecision };

export class DevModeAuthority implements DevModeTurnAuthority {
  private enabled = false;
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly accounts: Pick<AccountAuthorityPort, 'snapshot'>) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.entries.clear();
  }
  invalidate(subject: string): void { this.entries.delete(subject); }

  private requireCurrentAdmin(p: AuthPrincipal): void {
    requireSuperAdmin(p);
    const a = this.accounts.snapshot(p.account.workosUserId).account;
    if (!a || a.userId !== p.identity.userId || a.userId !== p.account.userId ||
        a.status !== 'active' || a.currentWorkosSessionId !== p.sessionId ||
        a.sessionEpoch !== p.account.sessionEpoch) throw new AuthFault('UNAUTHENTICATED');
    if (a.passwordChangeRequired) throw new AuthFault('PASSWORD_CHANGE_REQUIRED');
    if (a.role !== 'super-admin') throw new AuthFault('FORBIDDEN');
  }
  private decision(p: AuthPrincipal): DevModeDecision | null {
    const e = this.entries.get(p.account.workosUserId);
    if (e?.userId === p.identity.userId && e.sessionId === p.sessionId &&
        e.epoch === p.account.sessionEpoch) return e.decision;
    // ponytail: bound single-process state; never evict a live latch and re-announce.
    // A larger/multi-executor installation needs session state with coherent lifecycle.
    return e || this.entries.size < ACCOUNT_AUTHORITY_POLICY.maxEntries ? initial : null;
  }
  private store(p: AuthPrincipal, mode: DevMode, announce: boolean): void {
    this.entries.set(p.account.workosUserId, {
      userId: p.identity.userId, sessionId: p.sessionId, epoch: p.account.sessionEpoch,
      decision: Object.freeze({ mode, announce }),
    });
  }
  private requireDecision(p: AuthPrincipal): DevModeDecision {
    const d = this.decision(p);
    if (!d) throw new AuthFault('NOT_READY');
    return d;
  }
  read(p: AuthPrincipal): DevMode | null {
    this.requireCurrentAdmin(p);
    return this.enabled ? this.requireDecision(p).mode : null;
  }
  select(p: AuthPrincipal, mode: DevMode): DevMode {
    this.requireCurrentAdmin(p);
    if (!this.enabled) throw new AdminConfigFault('DEV_MODE_DISABLED');
    if (this.requireDecision(p).mode !== mode) this.store(p, mode, true);
    return mode;
  }
  peek(p?: AuthPrincipal): DevModeDecision | null {
    if (!this.enabled || !p || p.account.role !== 'super-admin' || p.account.passwordChangeRequired) return null;
    try { this.requireCurrentAdmin(p); }
    catch (error) { if (error instanceof AuthFault) return null; throw error; }
    return this.decision(p);
  }
  consumeForDispatch(p?: AuthPrincipal): DevModeDecision | null {
    if (!p) return null;
    const d = this.peek(p);
    if (d?.announce) this.store(p, d.mode, false);
    return d;
  }
}
```

Only trusted code can call the authority; no lookup by browser-supplied identifiers. Mode entries are capped at the existing account capacity, allocated only for actual changes or consumption, cleared on disable/shutdown and deleted immediately on session fences. Snapshot expiry/eviction denies diagnostics until normal auth warm-up; that warm-up by itself does not re-arm a represented session. At capacity don't evict another mode: unrepresented sessions get `NOT_READY` on enabled Config mode operations and no diagnostics on turns. No timers/background cleanup; nothing is logged.

- [ ] **Run green:** `npm test -- src/admin-config/dev-mode-authority.spec.ts test/auth/account-authority.spec.ts test/auth/authority-lifecycle.spec.ts` → pass for authority, no-I/O/same-mode/rapid switches, session fencing, and existing lifecycle.
- [ ] **Commit (repo root):** `git add -- backend/src/admin-config/dev-mode-authority.ts backend/src/admin-config/dev-mode-authority.spec.ts` then `git commit --only -m "feat(auth): add session-scoped dev mode authority" -- backend/src/admin-config/dev-mode-authority.ts backend/src/admin-config/dev-mode-authority.spec.ts backend/src/auth/account-authority.ts backend/src/contracts/admin-config-wire.ts backend/src/admin-config/errors.ts`

## Task 3 — Config routes and confirmed composition

Files: `backend/src/contracts/admin-config-wire.ts`, `backend/src/contracts/admin-config.ts`, `backend/src/admin-config/admin-config.controller.ts`, `backend/src/admin-config/admin-config.service.ts`, `backend/src/http/configure-private-http.ts` (Config skip-preparation predicate only), `backend/src/app.service.ts` (Config/auth composition only), `backend/test/assembly/auth-wiring.spec.ts`.

- [ ] **Red test.** In `auth-wiring.spec.ts` add imports `document` from `../admin-config/fixtures.js` and `type StoredConfigDocument` from `../../src/contracts/admin-config.js`. Extend the existing helper signature to `async function wiredApp(initial: StoredConfigDocument | null = null)` and its first line to `const f = assemblyFixture(initial);`. Append:

```ts
it('gates session dev mode and activates only confirmed settings', async () => {
  const legacy = document();
  delete legacy.settings.devModeEnabled;
  const started = await wiredApp(legacy);
  const modeUrl = '/api/admin/config/dev-mode';
  const configUrl = '/api/admin/config';
  const admin = 'aurvin_wos_session=sealed_admin';
  const user = 'aurvin_wos_session=sealed_1';
  let saved: StoredConfigDocument | null = null;
  try {
    const http = request(started.app.getHttpServer());
    const get = () => http.get(modeUrl).set('Cookie', admin);
    const set = (body: object) => http.put(modeUrl).set('Cookie', admin).set('Origin', started.origin).send(body);
    const dev = { protocolVersion: 1, mode: 'dev' };
    await http.get(modeUrl).expect(401);
    await http.get('/api/auth/me').set('Cookie', user).expect(200);
    await http.get(modeUrl).set('Cookie', user).expect(403);
    await http.put(modeUrl).set('Cookie', user).set('Origin', started.origin).send(dev).expect(403);
    const restricted = account({ userId: 'restricted', workosUserId: 'workos_restricted',
      emailNormalized: 'restricted@example.com', role: 'super-admin', currentWorkosSessionId: 'sid_restricted' });
    await started.auth.users.insert(restricted);
    await started.service.auth.authority.warm(restricted.workosUserId);
    started.auth.provider.read.mockResolvedValueOnce({ workosUserId: restricted.workosUserId, sessionId: 'sid_restricted' });
    await http.get(modeUrl).set('Cookie', 'aurvin_wos_session=restricted_cookie').expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('PASSWORD_CHANGE_REQUIRED'));
    started.auth.provider.read.mockResolvedValueOnce({ workosUserId: restricted.workosUserId, sessionId: 'sid_restricted' });
    await http.put(modeUrl).set('Cookie', 'aurvin_wos_session=restricted_cookie')
      .set('Origin', started.origin).send(dev).expect(403);
    await http.get('/api/auth/me').set('Cookie', admin).expect(200);
    const off = { protocolVersion: 1, enabled: false, mode: null };
    await get().expect(200, off);
    await set(dev).expect(409).expect(({ body }) => expect(body.error.code).toBe('DEV_MODE_DISABLED'));
    const before = await http.get(configUrl).set('Cookie', admin).expect(200);
    expect(before.body.settings.devModeEnabled).toBe(false);
    const save = (expectedRevision: number, enabled: boolean) =>
      http.put(configUrl).set('Cookie', admin).set('Origin', started.origin).send({
        protocolVersion: 1, expectedRevision, settings: { ...before.body.settings, devModeEnabled: enabled },
      });
    vi.mocked(started.f.repository.compareAndSwap).mockResolvedValueOnce({ outcome: 'conflict', currentRevision: 1 });
    await save(1, true).expect(409);
    await get().expect(200, off);
    await save(1, true).expect(200).expect(({ body }) => expect(body.settings.devModeEnabled).toBe(true));
    const prepare = vi.spyOn(started.service, 'prepareOwner');
    const predictMode = (mode: string) => ({ protocolVersion: 1, enabled: true, mode });
    vi.mocked(started.f.repository.read).mockClear();
    vi.mocked(started.f.repository.compareAndSwap).mockClear();
    await get().expect(200, predictMode('user')).expect('Cache-Control', 'no-store');
    await get().query({ mode: 'dev' }).expect(400);
    await set({ ...dev, mode: 'Dev' }).expect(400);
    await set({ ...dev, sessionId: 'not-from-browser' }).expect(400);
    await set(dev).expect(200, predictMode('dev'));
    await get().expect(200, predictMode('dev'));
    expect(prepare).not.toHaveBeenCalled();
    expect(started.f.repository.read).not.toHaveBeenCalled();
    expect(started.f.repository.compareAndSwap).not.toHaveBeenCalled();
    expect(started.f.fetcher).not.toHaveBeenCalled();
    saved = started.f.stored();
    await save(2, false).expect(200);
    await get().expect(200, off);
    await save(3, true).expect(200);
    await get().expect(200, predictMode('user'));
  } finally { await started.app.close(); }

  expect(saved?.settings.devModeEnabled).toBe(true);
  const restarted = await wiredApp(saved);
  try {
    const http = request(restarted.app.getHttpServer());
    await http.get('/api/auth/me').set('Cookie', admin).expect(200);
    await http.get(modeUrl).set('Cookie', admin).expect(200, { protocolVersion: 1, enabled: true, mode: 'user' });
    const { principal } = await restarted.service.auth.authenticate('sealed_admin');
    expect(restarted.service.devMode.peek(principal)).toEqual({ mode: 'user', announce: true });
  } finally { await restarted.app.close(); }
});
```

- [ ] **Run red:** `npm test -- test/assembly/auth-wiring.spec.ts -t "gates session dev mode"` → authorized mode GET has no route (404, not 200); the existing private boundary should already deny unauthorized requests.
- [ ] **Implement the route.** Add `devMode: '/admin/config/dev-mode',` to `ADMIN_CONFIG_ROUTES` and the following to `admin-config-wire.ts` after `DevMode`:

```ts
export type DevModeResponse = { protocolVersion: 1 } &
  ({ enabled: false; mode: null } | { enabled: true; mode: DevMode });
```

Import `DEV_MODES` into `admin-config.ts` and add:

```ts
export const devModeRequestSchema = z.object({
  protocolVersion: z.literal(1), mode: z.enum(DEV_MODES),
}).strict();
```

In `admin-config.service.ts` import `devModeRequestSchema`, `type DevModeResponse`, `type AuthPrincipal` and `type DevModeAuthority` from their files above. Add `modeControl?: { authority: DevModeAuthority; principal: () => AuthPrincipal };` to `AdminConfigOptions`; assign it to a `private readonly modeControl: AdminConfigOptions['modeControl'];` in the constructor. There is deliberately no fallback to `AdminConfigActor`, even for old test/module callers.

```ts
readDevMode(): DevModeResponse {
  const control = this.modeControl;
  if (!control) throw new AuthFault('UNAUTHENTICATED');
  const mode = control.authority.read(control.principal());
  return mode === null
    ? { protocolVersion: 1, enabled: false, mode: null }
    : { protocolVersion: 1, enabled: true, mode };
}
writeDevMode(raw: unknown): DevModeResponse {
  const control = this.modeControl;
  if (!control) throw new AuthFault('UNAUTHENTICATED');
  const principal = control.principal();
  const parsed = devModeRequestSchema.safeParse(raw);
  if (!parsed.success) throw new AdminConfigFault('INVALID_CONFIG_REQUEST');
  return { protocolVersion: 1, enabled: true, mode: control.authority.select(principal, parsed.data.mode) };
}
```

Append controller methods under `@Controller('admin/config')` (existing `AdminConfigFilter`, `configureAdminHttp` and private HTTP authenticate apply):

```ts
@Get('dev-mode')
getDevMode(@Query() query: unknown) {
  noQuery(query);
  return this.service.readDevMode();
}

@Put('dev-mode')
putDevMode(@Query() query: unknown, @Body() body: unknown) {
  noQuery(query);
  return this.service.writeDevMode(body);
}
```

In `configure-private-http.ts` rename its `modelMetadataOnly` local to `configMetadataOnly`, appending this case to the existing predicate; don't skip authentication or change other paths:

```ts
|| ((req.method === 'GET' || req.method === 'PUT') && path === '/api/admin/config/dev-mode')
```

- [ ] **Compose in `app.service.ts`.** Import `AccountAuthority` from `./auth/account-authority.js` and `DevModeAuthority` from `./admin-config/dev-mode-authority.js`, then add `readonly devMode: DevModeAuthority;` next to `adminConfig`. Replace only the existing `AuthService` construction:

```ts
const accounts = new AccountAuthority({
  users: this.users, onSessionFence: subject => this.devMode.invalidate(subject),
});
this.devMode = new DevModeAuthority(accounts);
this.auth = new AuthService({ users: this.users, provider: this.authProvider, authority: accounts });
```

Add `modeControl: { authority: this.devMode, principal: () => this.identities.principal() },` to `new AdminConfigService`. Add `this.devMode.setEnabled(false);` to `stopConfig` after closing account authority. Replace the final `this.current = snapshot` line of `publishSnapshot` with `this.setCurrentSnapshot(snapshot);` (after all existing guards) and the startup assignment with `this.setCurrentSnapshot(await this.loadPointer(assets));`. Add the helper:

```ts
private setCurrentSnapshot(snapshot: RuntimeConfigSnapshot | null): void {
  this.current = snapshot;
  this.devMode.setEnabled(snapshot?.settings.devModeEnabled === true);
}
```

No registration or runtime constructor changes. Config enablement is driven only by the active pointer; drafts, prepare results and failed/conflicting writes never update the authority. As today, a write whose outcome was uncertain requires restart/reconciliation: a subsequently loaded, validated durable record then becomes authoritative.

- [ ] **Run green:** `npm test -- test/assembly/auth-wiring.spec.ts -t "gates session dev mode"` → passes, including CAS conflict, no-store mode change with no Config DB/network or owner preparation, restricted/anonymous/ordinary denial, disable/re-enable and restart. Then `npm test -- src/admin-config/ test/admin-config/ test/auth/authority-lifecycle.spec.ts test/assembly/auth-wiring.spec.ts test/assembly/admin-config.spec.ts` → new checks pass; compare existing failures to the recorded backend baseline. Run `npm run build` and `npm run lint`; report any baseline failures separately, never fix unrelated files.
- [ ] **Commit (repo root):** `git commit --only -m "feat(config): expose authenticated session dev mode controls" -- backend/src/contracts/admin-config-wire.ts backend/src/contracts/admin-config.ts backend/src/admin-config/admin-config.controller.ts backend/src/admin-config/admin-config.service.ts backend/src/http/configure-private-http.ts backend/src/app.service.ts backend/test/assembly/auth-wiring.spec.ts`

## Exit and verification handoff

Report actual focused results and the commits to unblock both implementation workers. P1 evidence: synchronous authority test only reaches account storage through the explicitly invoked warm, and Config mode GET/PUT avoid settings reads/writes, catalogue fetch and unrelated preparation (existing cookie validation remains). P3 evidence still required: capture text and final voice dispatches against deterministic fixtures with storage held/blocked; compare disabled/ordinary prompt bytes and equivalent User turn model/DB/network counts; assert only the existing inference for diagnostics, no tool calls in Dev, no mode I/O/async wait before dispatch, and no change to stored transcript. Use the existing prepared tool and held-archive regression checks in [AGENTS.md](../../AGENTS.md), plus the final commands and pre-change baseline in [state.md](state.md). No wall-clock SLA or live-provider assertion.
