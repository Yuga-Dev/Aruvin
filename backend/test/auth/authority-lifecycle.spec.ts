/**
 * ============================================================================
 * FILE: authority-lifecycle.spec.ts
 * LOCATION: backend/test/auth/authority-lifecycle.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify login, logout, password, reset, and administration authority fences.
 *
 * ROLE IN PROJECT:
 *    Proves a held or failed account mutation denies new authentication before
 *    its acknowledgement and cannot restore an older or revoked snapshot.
 *
 * KEY COMPONENTS:
 *    - Held-CAS replacement/revocation, stale publication, and cleanup cases.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { AccountAuthority, ACCOUNT_AUTHORITY_POLICY } from '../../src/auth/account-authority.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { AuthFault } from '../../src/auth/errors.js';
import { AdministrationService } from '../../src/administration/administration.service.js';
import { administrationFixture } from '../administration/fixtures.js';
import { admittedAccount, authFixture } from './fixtures.js';

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

it('login replacement denies old authority while its binding acknowledgement is held', async () => {
  const f = await authFixture(admittedAccount());
  await f.service.authenticate('sealed_1');
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const cas = f.users.compareAndSwap.bind(f.users);
  vi.spyOn(f.users, 'compareAndSwap').mockImplementationOnce(async (before, next) => {
    entered(); await held; return cas(before, next);
  });
  f.provider.login.mockResolvedValueOnce({ workosUserId: 'user_fixture_1', sessionId: 'sid_2', sealedSession: 'sealed_2' });
  const loggingIn = f.service.login({ email: 'a@example.com', password: 'private-password' });
  await began;
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('NOT_READY');
  release(); await loggingIn;
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('UNAUTHENTICATED');
  f.provider.read.mockResolvedValueOnce({ workosUserId: 'user_fixture_1', sessionId: 'sid_2' });
  expect((await f.service.authenticate('sealed_2')).principal.account.currentWorkosSessionId).toBe('sid_2');
});

it('failed provider login leaves the old prepared authority usable', async () => {
  const f = await authFixture(admittedAccount());
  f.provider.login.mockRejectedValueOnce(new AuthFault('UNAUTHENTICATED'));
  await expect(f.service.login({ email: 'a@example.com', password: 'wrong' })).rejects.toThrow('UNAUTHENTICATED');
  expect((await f.service.authenticate('sealed_1')).principal.identity.userId).toBe('u1');
});

it.each(['conflict', 'uncertain', 'throw'] as const)(
  'logout write %s pins the represented session closed', async outcome => {
    const f = await authFixture(admittedAccount());
    const principal = (await f.service.authenticate('sealed_1')).principal;
    if (outcome === 'throw') {
      vi.spyOn(f.users, 'compareAndSwap').mockRejectedValueOnce(new Error('unknown-write'));
      await expect(f.service.logout(principal)).rejects.toThrow('unknown-write');
    } else {
      vi.spyOn(f.users, 'compareAndSwap').mockResolvedValueOnce({ outcome });
      await expect(f.service.logout(principal)).rejects.toThrow('NOT_READY');
    }
    await expect(f.service.authenticate('sealed_1')).rejects.toThrow('NOT_READY');
    expect(f.provider.revoke).not.toHaveBeenCalled();
  },
);

it('late confirmed login receipt cannot overwrite a later confirmed deactivation', async () => {
  const f = await authFixture(admittedAccount());
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const cas = f.users.compareAndSwap.bind(f.users);
  vi.spyOn(f.users, 'compareAndSwap').mockImplementationOnce(async (before, next) => {
    entered(); await held; return cas(before, next);
  });
  f.provider.login.mockResolvedValueOnce({ workosUserId: 'user_fixture_1', sessionId: 'sid_2', sealedSession: 'sealed_2' });
  const loggingIn = f.service.login({ email: 'a@example.com', password: 'private-password' });
  await began;
  const current = (await f.users.get('u1'))!;
  const revoke = f.authority.fence('user_fixture_1', 'revocation');
  const deactivated = await f.users.compareAndSwap(current,
    { ...current.account, status: 'inactive', currentWorkosSessionId: null, sessionEpoch: 1 });
  if (deactivated.outcome !== 'confirmed') throw new Error('fixture deactivation was not confirmed');
  f.authority.publish(revoke, deactivated.value);
  release();
  await expect(loggingIn).rejects.toThrow('NOT_READY');
  expect(f.authority.snapshot('user_fixture_1').account).toMatchObject({
    status: 'inactive', currentWorkosSessionId: null,
  });
});

it('failed login cleanup cannot fence a distinct newer session', async () => {
  const f = await authFixture(admittedAccount());
  vi.spyOn(f.authority, 'fence').mockImplementationOnce(() => { throw new AuthFault('NOT_READY'); });
  f.provider.login.mockResolvedValueOnce({ workosUserId: 'user_fixture_1', sessionId: 'sid_2', sealedSession: 'sealed_2' });
  await expect(f.service.login({ email: 'a@example.com', password: 'private-password' })).rejects.toThrow('NOT_READY');
  expect(f.authority.snapshot('user_fixture_1').account?.currentWorkosSessionId).toBe('sid_1');
  expect(f.provider.revoke).toHaveBeenCalledWith('sid_2');
});

it('capacity or busy fence failure revokes the unissued provider session and returns no cookie', async () => {
  const f = await authFixture(admittedAccount(), { warm: false });
  const authority = new AccountAuthority({ users: f.users,
    policy: { ...ACCOUNT_AUTHORITY_POLICY, maxEntries: 1, maxWarmReads: 1 } });
  authority.fence('user_other');
  const service = new AuthService({ users: f.users, provider: f.provider, authority });
  await expect(service.login({ email: 'a@example.com', password: 'private-password' })).rejects.toThrow('NOT_READY');
  expect(f.provider.revoke).toHaveBeenCalledWith('sid_1');
});

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

it('password replacement closes old authority until a confirmed fresh SID', async () => {
  const f = await authFixture(admittedAccount());
  const principal = (await f.service.authenticate('sealed_1')).principal;
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.provider.replacePassword.mockImplementationOnce(async () => { entered(); await held; });
  f.provider.login.mockResolvedValueOnce({ workosUserId: 'user_fixture_1', sessionId: 'sid_proof', sealedSession: 'proof' })
    .mockResolvedValueOnce({ workosUserId: 'user_fixture_1', sessionId: 'sid_fresh', sealedSession: 'fresh' });
  const changing = f.service.password(principal, { currentPassword: 'temporary', newPassword: 'private-password' });
  await began;
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('NOT_READY');
  release(); await changing;
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('UNAUTHENTICATED');
  f.provider.read.mockResolvedValueOnce({ workosUserId: 'user_fixture_1', sessionId: 'sid_fresh' });
  expect((await f.service.authenticate('sealed_fresh')).principal.account.currentWorkosSessionId).toBe('sid_fresh');
});

it('password replacement timeout leaves authority closed', async () => {
  const f = await authFixture(admittedAccount());
  const principal = (await f.service.authenticate('sealed_1')).principal;
  f.provider.replacePassword.mockRejectedValueOnce(new AuthFault('AUTH_TIMEOUT'));
  await expect(f.service.password(principal, { currentPassword: 'temporary', newPassword: 'private-password' }))
    .rejects.toThrow('AUTH_TIMEOUT');
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('NOT_READY');
});

it('password rollback leaves the old SID usable only after its acknowledgement', async () => {
  const f = await authFixture(admittedAccount());
  const principal = (await f.service.authenticate('sealed_1')).principal;
  f.provider.replacePassword.mockRejectedValueOnce(new AuthFault('INVALID_REQUEST'));
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const cas = f.users.compareAndSwap.bind(f.users);
  let writes = 0;
  vi.spyOn(f.users, 'compareAndSwap').mockImplementation(async (before, next) => {
    if (++writes === 2) { entered(); await held; }
    return cas(before, next);
  });
  const changing = f.service.password(principal, { currentPassword: 'temporary', newPassword: 'private-password' });
  await began;
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('NOT_READY');
  release();
  await expect(changing).rejects.toThrow('INVALID_REQUEST');
  expect((await f.service.authenticate('sealed_1')).principal.identity.userId).toBe('u1');
});

it('a concurrent deactivation defeats a held password rollback', async () => {
  const f = await authFixture(admittedAccount());
  const principal = (await f.service.authenticate('sealed_1')).principal;
  f.provider.replacePassword.mockRejectedValueOnce(new AuthFault('INVALID_REQUEST'));
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const cas = f.users.compareAndSwap.bind(f.users);
  let writes = 0;
  vi.spyOn(f.users, 'compareAndSwap').mockImplementation(async (before, next) => {
    if (++writes === 2) { entered(); await held; }
    return cas(before, next);
  });
  const changing = f.service.password(principal, { currentPassword: 'temporary', newPassword: 'private-password' });
  await began;
  const current = (await f.users.get('u1'))!;
  const revoke = f.authority.fence('user_fixture_1', 'revocation');
  const deactivated = await f.users.compareAndSwap(current,
    { ...current.account, status: 'inactive', currentWorkosSessionId: null, sessionEpoch: 1 });
  if (deactivated.outcome !== 'confirmed') throw new Error('fixture deactivation was not confirmed');
  f.authority.publish(revoke, deactivated.value);
  release();
  await expect(changing).rejects.toThrow('INVALID_REQUEST');
  expect(f.authority.snapshot('user_fixture_1').account).toMatchObject({
    status: 'inactive', currentWorkosSessionId: null,
  });
  await expect(f.service.authenticate('sealed_1')).rejects.toThrow('UNAUTHENTICATED');
});

it('reset publishes only its confirmed invalidation after conflicts', async () => {
  const f = await authFixture(admittedAccount());
  const cas = f.users.compareAndSwap.bind(f.users);
  vi.spyOn(f.users, 'compareAndSwap').mockResolvedValueOnce({ outcome: 'conflict' }).mockImplementationOnce(cas);
  expect(await f.service.resetPassword({ token: 'token', newPassword: 'private-password' })).toEqual({ ok: true });
  expect(f.provider.reset).toHaveBeenCalledTimes(1);
  expect(f.authority.snapshot('user_fixture_1').account).toMatchObject({
    currentWorkosSessionId: null, passwordChangeRequired: false,
  });
});

it('recovery mail requests do not fence or publish authority', async () => {
  const f = await authFixture(admittedAccount());
  const before = f.authority.snapshot('user_fixture_1');
  expect(await f.service.forgotPassword({ email: 'a@example.com' })).toEqual({ ok: true });
  expect(f.authority.snapshot('user_fixture_1')).toBe(before);
});

it('provider reset failure before a verified subject leaves authority untouched', async () => {
  const f = await authFixture(admittedAccount());
  const before = f.authority.snapshot('user_fixture_1');
  f.provider.reset.mockRejectedValueOnce(new AuthFault('AUTH_TIMEOUT'));
  await expect(f.service.resetPassword({ token: 'token', newPassword: 'private-password' })).rejects.toThrow('AUTH_TIMEOUT');
  expect(f.authority.snapshot('user_fixture_1')).toBe(before);
});

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

it('repeated administration no-ops refresh authority without another write', async () => {
  const f = await administrationFixture();
  const cas = vi.spyOn(f.users, 'compareAndSwap');
  await f.service.deactivate(f.admin, 'u1', {});
  await f.service.deactivate(f.admin, 'u1', {});
  expect(f.authority.snapshot('user_fixture_1').account).toMatchObject({
    status: 'inactive', currentWorkosSessionId: null,
  });
  await f.service.reactivate(f.admin, 'u1', {});
  await f.service.reactivate(f.admin, 'u1', {});
  expect(f.authority.snapshot('user_fixture_1').account).toMatchObject({
    status: 'active', currentWorkosSessionId: null,
  });
  expect(cas).toHaveBeenCalledTimes(2);
});

it('administration create publishes onboarding authority with a null SID', async () => {
  const f = await administrationFixture();
  await f.service.create(f.admin, { email: 'new@example.com', temporaryPassword: 'long-enough', role: 'user' });
  expect(f.authority.snapshot('user_created').account).toMatchObject({
    userId: 'u_created', workosUserId: 'user_created', status: 'active',
    passwordChangeRequired: true, currentWorkosSessionId: null,
  });
});

it('missing shared authority refuses create, deactivate, and reactivate before writes', async () => {
  const f = await administrationFixture();
  const service = new AdministrationService({ users: f.users, provider: f.provider });
  await expect(service.deactivate(f.admin, 'u1', {})).rejects.toMatchObject({ code: 'NOT_READY' });
  await expect(service.reactivate(f.admin, 'u1', {})).rejects.toMatchObject({ code: 'NOT_READY' });
  await expect(service.create(f.admin, { email: 'new@example.com', temporaryPassword: 'long-enough', role: 'user' }))
    .rejects.toMatchObject({ code: 'NOT_READY' });
  expect(f.provider.createUser).not.toHaveBeenCalled();
  expect((await f.users.get('u1'))!.account.status).toBe('active');
});

it('administration recovery mail does not fence authority', async () => {
  const f = await administrationFixture();
  const before = f.authority.snapshot('user_fixture_1');
  expect(await f.service.passwordReset(f.admin, 'u1', {})).toBeUndefined();
  expect(f.authority.snapshot('user_fixture_1')).toBe(before);
});

it('deactivation then reactivation then login keeps the old SID denied', async () => {
  const f = await administrationFixture();
  const auth = new AuthService({ users: f.users, provider: f.provider, authority: f.authority });
  expect((await auth.authenticate('sealed_1')).principal.account.userId).toBe('u1');
  await f.service.deactivate(f.admin, 'u1', {});
  await expect(auth.authenticate('sealed_1')).rejects.toThrow('UNAUTHENTICATED');
  await f.service.reactivate(f.admin, 'u1', {});
  await expect(auth.authenticate('sealed_1')).rejects.toThrow('UNAUTHENTICATED');
  f.provider.login.mockResolvedValueOnce({ workosUserId: 'user_fixture_1', sessionId: 'sid_fresh', sealedSession: 'sealed_fresh' });
  await auth.login({ email: 'a@example.com', password: 'private-password' });
  f.provider.read.mockResolvedValueOnce({ workosUserId: 'user_fixture_1', sessionId: 'sid_fresh' });
  expect((await auth.authenticate('sealed_fresh')).principal.account.userId).toBe('u1');
});

it('a held deactivation denies an already-active reactivate no-op', async () => {
  const f = await administrationFixture();
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const cas = f.users.compareAndSwap.bind(f.users);
  vi.spyOn(f.users, 'compareAndSwap').mockImplementationOnce(async (current, next) => {
    entered(); await held; return cas(current, next);
  });
  const deactivating = f.service.deactivate(f.admin, 'u1', {});
  await began;
  await expect(f.service.reactivate(f.admin, 'u1', {})).rejects.toMatchObject({ code: 'NOT_READY' });
  release(); await deactivating;
  expect(f.authority.snapshot('user_fixture_1').account).toMatchObject({
    status: 'inactive', currentWorkosSessionId: null,
  });
});
