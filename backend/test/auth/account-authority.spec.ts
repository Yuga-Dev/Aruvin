/**
 * ============================================================================
 * FILE: account-authority.spec.ts
 * LOCATION: backend/test/auth/account-authority.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify bounded revision-fenced account authority snapshots and warm reads.
 *
 * ROLE IN PROJECT:
 *    Proves the server-only authentication authority kernel fails closed on
 *    cold, expired, fenced, uncertain, and invalid publications without storage.
 *
 * KEY COMPONENTS:
 *    - Snapshot immutability, expiry, revision/epoch/identity/byte guards.
 *    - Token identity, fencing asymmetry, warm slots, eviction, and close.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { AccountAuthority, ACCOUNT_AUTHORITY_POLICY } from '../../src/auth/account-authority.js';
import type { AccountRead } from '../../src/contracts/auth.js';
import { admittedAccount } from './fixtures.js';

const value = (patch: Parameters<typeof admittedAccount>[0] = {}, revision = 4): AccountRead =>
  ({ account: admittedAccount(patch), revision });

function heldReads() {
  const resolvers: Array<(value: AccountRead | null) => void> = [];
  const users = { bySubject: vi.fn(() => new Promise<AccountRead | null>(resolve => {
    resolvers.push(resolve);
  })) };
  return { users, resolvers };
}

it('serves only confirmed immutable authority and expires exactly at the boundary', () => {
  let now = 10;
  const users = { bySubject: vi.fn(async () => null) };
  const authority = new AccountAuthority({ users, nowMs: () => now });
  expect(() => authority.snapshot('user_fixture_1')).toThrow('NOT_READY');
  const ticket = authority.fence('user_fixture_1');
  const receipt = value();
  expect(authority.publish(ticket, receipt)).toBe(true);
  receipt.account.status = 'inactive';
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
  expect(authority.publish(revoked, value({ status: 'inactive', currentWorkosSessionId: null, sessionEpoch: 2 }, 8))).toBe(true);
  expect(authority.publish(older, value({}, 9))).toBe(false);
  authority.fail(older);
  expect(authority.snapshot('user_fixture_1').account?.status).toBe('inactive');
});

it.each(['revision', 'epoch', 'subject', 'identity', 'oversize'] as const)(
  'fails closed on an invalid current publication: %s', mode => {
    const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
    authority.publish(authority.fence('user_fixture_1'), value({}, 4));
    const next = value({}, 5);
    if (mode === 'revision') next.revision = 3;
    if (mode === 'epoch') {
      authority.publish(authority.fence('user_fixture_1'), value({ sessionEpoch: 1 }, 5));
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

it('rejects an equal revision with different content', () => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
  authority.publish(authority.fence('user_fixture_1'), value({}, 4));
  expect(() => authority.publish(authority.fence('user_fixture_1'),
    value({ updatedAt: '2026-11-11T00:00:00.000Z' }, 4))).toThrow('NOT_READY');
});

it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects an unsafe revision %s', revision => {
    const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
    expect(() => authority.publish(authority.fence('user_fixture_1'),
      { account: admittedAccount(), revision })).toThrow('NOT_READY');
  },
);

it('rejects a copied token and keeps the newer entry intact', () => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
  const ticket = authority.fence('user_fixture_1');
  const copy = { ...ticket } as typeof ticket;
  expect(authority.publish(copy, value())).toBe(false);
  expect(authority.publish(ticket, value())).toBe(true);
  expect(authority.snapshot('user_fixture_1').revision).toBe(4);
});

it('publishes a confirmed missing mapping and retains the previous floor', () => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
  expect(authority.publish(authority.fence('user_fixture_1'), value({}, 4))).toBe(true);
  const missing = authority.fence('user_fixture_1');
  expect(authority.publish(missing, null)).toBe(true);
  const snapshot = authority.snapshot('user_fixture_1');
  expect(snapshot.account).toBeNull();
  expect(snapshot.revision).toBeNull();
  expect(() => authority.publish(authority.fence('user_fixture_1'), value({}, 3))).toThrow('NOT_READY');
});

it('retains an isolated floor when the caller mutates its receipt', () => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
  const receipt = value({}, 4);
  expect(authority.publish(authority.fence('user_fixture_1'), receipt)).toBe(true);
  receipt.account.role = 'super-admin';
  receipt.revision = 99;
  expect(authority.snapshot('user_fixture_1').account?.role).toBe('user');
  expect(() => authority.publish(authority.fence('user_fixture_1'), value({}, 3))).toThrow('NOT_READY');
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('closes on a nonfinite or negative clock %s', now => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() }, nowMs: () => now });
  expect(() => authority.fence('user_fixture_1')).toThrow('NOT_READY');
  expect(() => authority.snapshot('user_fixture_1')).toThrow('NOT_READY');
});

it('closes on a backward clock and rejects every later token', () => {
  let now = 10;
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() }, nowMs: () => now });
  const ticket = authority.fence('user_fixture_1');
  now = 9;
  expect(() => authority.publish(ticket, value())).toThrow('NOT_READY');
  now = 20;
  expect(() => authority.fence('user_fixture_1')).toThrow('NOT_READY');
});

it('rejects late publication after close', () => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
  const ticket = authority.fence('user_fixture_1');
  authority.close();
  expect(authority.publish(ticket, value())).toBe(false);
  expect(() => authority.snapshot('user_fixture_1')).toThrow('NOT_READY');
  expect(() => authority.fence('user_fixture_1')).toThrow('NOT_READY');
});

it('closes on generation overflow instead of reusing a token', () => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
  (authority as unknown as { sequence: number }).sequence = Number.MAX_SAFE_INTEGER;
  expect(() => authority.fence('user_fixture_1')).toThrow('NOT_READY');
  expect(() => authority.fence('user_fixture_1')).toThrow('NOT_READY');
});

it('refuses a replacement fence while a replacement or revocation is pending', () => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
  authority.fence('user_fixture_1');
  expect(() => authority.fence('user_fixture_1')).toThrow('NOT_READY');
  const revoked = authority.fence('user_fixture_1', 'revocation');
  expect(() => authority.fence('user_fixture_1')).toThrow('NOT_READY');
  expect(authority.publish(revoked, value({ status: 'inactive', currentWorkosSessionId: null }, 2))).toBe(true);
});

it('lets a revocation supersede a pending replacement', () => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
  const replacement = authority.fence('user_fixture_1');
  const revoked = authority.fence('user_fixture_1', 'revocation');
  expect(authority.publish(revoked, value({ status: 'inactive', currentWorkosSessionId: null }, 2))).toBe(true);
  expect(authority.publish(replacement, value({}, 3))).toBe(false);
  expect(authority.snapshot('user_fixture_1').account?.status).toBe('inactive');
});

it('rejects a revocation publication with a live SID or reactivation', () => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
  authority.publish(authority.fence('user_fixture_1'), value({ status: 'inactive', currentWorkosSessionId: null }, 2));
  expect(() => authority.publish(authority.fence('user_fixture_1', 'revocation'), value({}, 3))).toThrow('NOT_READY');
});

it('does not let an already-published token renew expiry or republish', () => {
  let now = 10;
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() }, nowMs: () => now });
  const ticket = authority.fence('user_fixture_1');
  expect(authority.publish(ticket, value())).toBe(true);
  now = 20;
  expect(authority.publish(ticket, value({}, 5))).toBe(false);
  expect(authority.snapshot('user_fixture_1').expiresAt).toBe(900010);
});

it('does not let a failed token republish', () => {
  const authority = new AccountAuthority({ users: { bySubject: vi.fn() } });
  const ticket = authority.fence('user_fixture_1');
  authority.fail(ticket);
  expect(authority.publish(ticket, value())).toBe(false);
  expect(() => authority.snapshot('user_fixture_1')).toThrow('NOT_READY');
});

it('validates the policy once and fails closed on invalid bounds', () => {
  const users = { bySubject: vi.fn() };
  for (const policy of [
    { ...ACCOUNT_AUTHORITY_POLICY, maxEntries: 0 },
    { ...ACCOUNT_AUTHORITY_POLICY, maxSnapshotBytes: -1 },
    { ...ACCOUNT_AUTHORITY_POLICY, maxAgeMs: 1.5 },
    { ...ACCOUNT_AUTHORITY_POLICY, maxWarmReads: 2, maxEntries: 1 },
  ]) expect(() => new AccountAuthority({ users, policy })).toThrow('NOT_READY');
});

it('a warm started before revocation cannot restore authority', async () => {
  const { users, resolvers } = heldReads();
  const authority = new AccountAuthority({ users });
  const warming = authority.warm('user_fixture_1').catch(error => error);
  const revoke = authority.fence('user_fixture_1', 'revocation');
  authority.publish(revoke, value({ status: 'inactive', currentWorkosSessionId: null, sessionEpoch: 1 }, 2));
  resolvers[0]!(value({}, 1));
  expect(await warming).toMatchObject({ code: 'NOT_READY' });
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

it('holds four warm slots and rejects the fifth without another read', async () => {
  const { users, resolvers } = heldReads();
  const authority = new AccountAuthority({ users });
  const pending = ['a', 'b', 'c', 'd'].map(subject => authority.warm(subject));
  await expect(authority.warm('e')).rejects.toThrow('NOT_READY');
  expect(users.bySubject).toHaveBeenCalledTimes(4);
  for (const resolve of resolvers) resolve(null);
  await Promise.all(pending);
});

it('refuses a duplicate warm for the same subject', async () => {
  const { users, resolvers } = heldReads();
  const authority = new AccountAuthority({ users });
  const first = authority.warm('user_fixture_1');
  await expect(authority.warm('user_fixture_1')).rejects.toThrow('NOT_READY');
  expect(users.bySubject).toHaveBeenCalledTimes(1);
  resolvers[0]!(value());
  await first;
});

it('pins uncertainty after a failed read and recovers only through a new fence', async () => {
  const users = { bySubject: vi.fn(async () => { throw new Error('storage-down'); }) };
  const authority = new AccountAuthority({ users });
  await expect(authority.warm('user_fixture_1')).rejects.toThrow('NOT_READY');
  expect(() => authority.snapshot('user_fixture_1')).toThrow('NOT_READY');
  await expect(authority.warm('user_fixture_1')).rejects.toThrow('NOT_READY');
  expect(users.bySubject).toHaveBeenCalledTimes(1);
  const ticket = authority.fence('user_fixture_1');
  expect(authority.publish(ticket, value())).toBe(true);
  expect(authority.snapshot('user_fixture_1').revision).toBe(4);
});

it('supports the real 1024-entry capacity with ready-only eviction', async () => {
  const users = { bySubject: vi.fn(async () => null) };
  const authority = new AccountAuthority({ users });
  for (let n = 0; n < ACCOUNT_AUTHORITY_POLICY.maxEntries; n++) await authority.warm(`subject_${n}`);
  await authority.warm('subject_new');
  expect(() => authority.snapshot('subject_0')).toThrow('NOT_READY');
  expect(authority.snapshot('subject_new').account).toBeNull();
  expect(authority.snapshot('subject_1').account).toBeNull();
});

it('rejects an old token after eviction and reinsertion', async () => {
  const users = { bySubject: vi.fn(async () => null) };
  const policy = { ...ACCOUNT_AUTHORITY_POLICY, maxEntries: 2, maxWarmReads: 2 };
  const authority = new AccountAuthority({ users, policy });
  const a = (revision: number) => ({ account: admittedAccount({ workosUserId: 'a' }), revision });
  const first = authority.fence('a');
  expect(authority.publish(first, a(4))).toBe(true);
  await authority.warm('b');
  await authority.warm('c');
  await authority.warm('a');
  expect(authority.publish(first, a(5))).toBe(false);
  expect(authority.snapshot('a').account).toBeNull();
  expect(authority.snapshot('a').revision).toBeNull();
});

it('does not renew expiry or eviction order on snapshot reads', async () => {
  let now = 0;
  const users = { bySubject: vi.fn(async () => null) };
  const policy = { ...ACCOUNT_AUTHORITY_POLICY, maxEntries: 2, maxWarmReads: 2 };
  const authority = new AccountAuthority({ users, policy, nowMs: () => now });
  await authority.warm('a');
  await authority.warm('b');
  expect(authority.snapshot('a').expiresAt).toBe(900000);
  await authority.warm('c');
  expect(() => authority.snapshot('a')).toThrow('NOT_READY');
  expect(authority.snapshot('b').account).toBeNull();
  now = 900000;
  expect(() => authority.snapshot('b')).toThrow('NOT_READY');
});
