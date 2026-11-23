/**
 * ============================================================================
 * FILE: connection-prepared.spec.ts
 * LOCATION: backend/test/plugins/google-calendar/connection-prepared.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify prepared Calendar connection authority, fresh defaults, and invalidation races.
 *
 * ROLE IN PROJECT:
 *    Exercises cold hydration, prepared status/account reuse, explicit fresh-check
 *    enforcement, revocation watermarks, and unchanged discovery capability checks.
 *
 * KEY COMPONENTS:
 *    - Cold vs. prepared statusV2/currentAccount/requireAccountCurrent contracts
 *    - Stale in-flight hydration and CAS write-through race regressions
 *    - Prepared discovery and checkTarget capability-recheck guards
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { CALENDAR_SCOPES } from '../../../src/contracts/calendar-policy.js';
import { calendarConnectionV2Schema } from '../../../src/contracts/calendar-discovery.js';
import { GoogleCalendarConnections } from '../../../src/plugins/google-calendar/connection.js';
import { multiConnectionFixture } from './connection-multi-fixtures.js';
import { deferred } from './oauth-fixtures.js';

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
    expect((await f.service.status()).state).toBe('connected');
    expect(get).toHaveBeenCalledTimes(1);
  } finally { get.mockRestore(); await f.service.close(); }
});

it('rehydrates status after invalidation without restoring revoked authority', async () => {
  const f = await multiConnectionFixture();
  const account = await f.service.currentAccount();
  const get = vi.spyOn(f.adapter.v2, 'get');
  try {
    f.service.invalidateAccount(account);

    expect((await f.service.statusV2()).connectionRevision).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    await expect(f.service.currentAccount()).rejects.toMatchObject({
      failure: { code: 'CALENDAR_EXECUTION_DENIED' },
    });
    expect(get).toHaveBeenCalledTimes(2);
  } finally { get.mockRestore(); await f.service.close(); }
});

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

it('reuses confirmed absence without additional gets', async () => {
  const f = await multiConnectionFixture({ empty: true });
  const get = vi.spyOn(f.adapter.v2, 'get');
  try {
    expect((await f.service.statusV2()).state).toBe('setup-required');
    expect(get).toHaveBeenCalledTimes(1);
    get.mockRejectedValue(new Error('prepared absence touched storage'));
    expect((await f.service.status()).state).toBe('setup-required');
    await expect(f.service.currentAccount()).rejects.toMatchObject({
      failure: { code: 'CALENDAR_RECONNECT_REQUIRED' },
    });
    expect(get).toHaveBeenCalledTimes(1);
  } finally { get.mockRestore(); await f.service.close(); }
});

it('does not cache a failed cold get as absence and allows retry', async () => {
  const f = await multiConnectionFixture();
  const get = vi.spyOn(f.adapter.v2, 'get').mockRejectedValueOnce(new Error('transient store failure'));
  try {
    await expect(f.service.currentAccount()).rejects.toThrow('transient store failure');
    const account = await f.service.currentAccount();
    expect(account.userId).toBe('u1');
    expect(get).toHaveBeenCalledTimes(2);
  } finally { get.mockRestore(); await f.service.close(); }
});

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

it('rejects a get paused across close without publishing usable authority', async () => {
  const f = await multiConnectionFixture();
  const saved = (await f.read())!;
  const held = deferred<typeof saved>();
  const get = vi.spyOn(f.adapter.v2, 'get').mockImplementationOnce(() => held.promise);
  const pendingAccount = f.service.currentAccount().then(() => 'allowed', () => 'denied');
  try {
    await f.service.close();
    held.resolve(saved);
    expect(await pendingAccount).toBe('denied');
    expect((await f.service.statusV2()).state).toBe('degraded');
    await expect(f.service.currentAccount()).rejects.toMatchObject({
      failure: { code: 'CALENDAR_EXECUTION_DENIED' },
    });
  } finally { held.resolve(saved); await pendingAccount; get.mockRestore(); await f.service.close(); }
});

it('preserves a newer confirmed settings CAS when an older get resolves late', async () => {
  const f = await multiConnectionFixture();
  const older = (await f.read())!;
  const held = deferred<typeof older>();
  const get = vi.spyOn(f.adapter.v2, 'get').mockImplementationOnce(() => held.promise);
  const pendingCold = f.service.statusV2();
  try {
    await f.service.settings({
      defaultSetting: { calendarId: 'shared-team', expectedRevision: 1, expectedConnectionRevision: 1 },
    }, new AbortController().signal);
    held.resolve(older);
    await pendingCold;
    get.mockRejectedValue(new Error('prepared status touched storage'));
    const prepared = await f.service.requireAccountCurrent(
      await f.service.currentAccount(),
      new AbortController().signal,
      { fresh: false },
    );
    expect(prepared.defaultSetting).toEqual({ defaultCalendarId: 'shared-team', defaultSettingRevision: 2 });
  } finally { held.resolve(older); await pendingCold; get.mockRestore(); await f.service.close(); }
});

it('clears prepared usable state synchronously before disconnect, disable, or beginConsent awaits', async () => {
  for (const mode of ['disconnect', 'disable', 'beginConsent'] as const) {
    const f = await multiConnectionFixture();
    const account = await f.service.currentAccount();
    const saved = (await f.read())!;
    const heldGet = deferred<typeof saved>();
    const getSpy = vi.spyOn(f.adapter.v2, 'get').mockImplementationOnce(() => heldGet.promise);
    let op!: Promise<unknown>;
    try {
      if (mode === 'disconnect') {
        op = f.service.disconnect({ mode: 'local' }, new AbortController().signal);
      } else if (mode === 'disable') {
        op = f.service.settings({ enabled: false }, new AbortController().signal);
      } else {
        op = f.service.beginConsent(new AbortController().signal);
      }
      await expect(f.service.requireAccountCurrent(account, new AbortController().signal, { fresh: false }))
        .rejects.toMatchObject({ failure: { code: 'CALENDAR_EXECUTION_DENIED' } });
      heldGet.resolve(saved);
      await op;
    } finally {
      heldGet.resolve(saved);
      await op?.catch(() => undefined);
      getSpy.mockRestore();
      await f.service.close();
    }
  }
});

it('allows same-subject re-consent with new revision and ignores late old-account invalidation', async () => {
  const f = await multiConnectionFixture();
  const oldAccount = await f.service.currentAccount();
  const snapshot = await f.service.captureSetupSnapshot();
  await f.service.beginConsent(new AbortController().signal);
  await f.service.installGrant({
    snapshot: { ...snapshot, lifecycleEpoch: f.service.getLifecycleEpoch(), recordRevision: (await f.read())!.revision },
    grant: {
      accessToken: 'reconsented-access',
      refreshToken: 'reconsented-refresh',
      expiresAt: new Date(f.now() + 3600_000).toISOString(),
      scopes: [...CALENDAR_SCOPES],
    },
    account: { subject: oldAccount.googleSubjectId, email: 'u1@example.invalid' },
    signal: new AbortController().signal,
    deadlineAt: new Date(f.now() + 20_000).toISOString(),
    isCurrentFlow: () => true,
  });
  const newAccount = await f.service.currentAccount();
  expect(newAccount.connectionId).toBe(oldAccount.connectionId);
  expect(newAccount.connectionRevision).toBeGreaterThan(oldAccount.connectionRevision);

  // Late old-account invalidation and rejectUnauthorizedAccount must not affect the new revision
  const epochBefore = f.service.getLifecycleEpoch();
  f.service.invalidateAccount(oldAccount);
  expect(f.service.getLifecycleEpoch()).toBe(epochBefore);
  await f.service.rejectUnauthorizedAccount(oldAccount);
  expect(f.service.getLifecycleEpoch()).toBe(epochBefore);

  const get = vi.spyOn(f.adapter.v2, 'get').mockRejectedValue(new Error('prepared path touched storage'));
  try {
    expect((await f.service.status()).state).toBe('connected');
    expect(await f.service.requireAccountCurrent(newAccount, new AbortController().signal, { fresh: false }))
      .toMatchObject({ connectionRevision: newAccount.connectionRevision });
    await expect(f.service.requireAccountCurrent(oldAccount, new AbortController().signal, { fresh: false }))
      .rejects.toMatchObject({ failure: { code: 'CALENDAR_EXECUTION_DENIED' } });
  } finally { get.mockRestore(); await f.service.close(); }
});

it('propagates confirmed token rotation to the next prepared call without storage reads', async () => {
  const f = await multiConnectionFixture({ expiredToken: true });
  const account = await f.service.currentAccount();
  f.client.refresh.mockResolvedValueOnce({
    accessToken: 'rotated-prepared-access',
    refreshToken: null,
    expiresAt: new Date(f.now() + 3600_000).toISOString(),
    scopes: [...CALENDAR_SCOPES],
  });
  const first = await f.service.withAccessToken({
    account,
    signal: new AbortController().signal,
    deadlineAt: new Date(f.now() + 20_000).toISOString(),
    consumeRefreshRequest: vi.fn(async () => undefined),
  }, async (token) => token);
  expect(first).toBe('rotated-prepared-access');

  const get = vi.spyOn(f.adapter.v2, 'get').mockRejectedValue(new Error('prepared path touched storage'));
  try {
    const second = await f.service.withAccessToken({
      account,
      signal: new AbortController().signal,
      deadlineAt: new Date(f.now() + 20_000).toISOString(),
      consumeRefreshRequest: vi.fn(async () => undefined),
    }, async (token) => token);
    expect(second).toBe('rotated-prepared-access');
    expect(f.client.refresh).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  } finally { get.mockRestore(); await f.service.close(); }
});

it('never exposes rotated tokens when refresh CAS fails or is uncertain', async () => {
  for (const outcome of ['conflict', 'uncertain'] as const) {
    const f = await multiConnectionFixture({ expiredToken: true });
    const account = await f.service.currentAccount();
    f.client.refresh.mockResolvedValueOnce({
      accessToken: 'unacknowledged-access',
      refreshToken: 'unacknowledged-refresh',
      expiresAt: new Date(f.now() + 3600_000).toISOString(),
      scopes: [...CALENDAR_SCOPES],
    });
    const cas = vi.spyOn(f.adapter.v2, 'compareAndSwap').mockResolvedValue(
      outcome === 'conflict'
        ? { outcome: 'conflict', currentRevision: 2, currentDefaultSettingRevision: 1 }
        : { outcome: 'uncertain' },
    );
    const action = vi.fn(async (token: string) => token);
    try {
      await expect(f.service.withAccessToken({
        account,
        signal: new AbortController().signal,
        deadlineAt: new Date(f.now() + 20_000).toISOString(),
        consumeRefreshRequest: vi.fn(async () => undefined),
      }, action)).rejects.toBeDefined();
      expect(action).not.toHaveBeenCalled();
      if (outcome === 'uncertain') {
        await expect(f.service.requireAccountCurrent(account, new AbortController().signal, { fresh: false }))
          .rejects.toMatchObject({ failure: { code: 'CALENDAR_EXECUTION_DENIED' } });
      } else {
        // conflict dropped prepared slot; fresh read returns original revision 1, not rotated version
        const current = await f.service.requireAccountCurrent(account, new AbortController().signal, { fresh: false });
        expect(current.credentialVersion).toBe(1);
        expect(calendarConnectionV2Schema.parse(current).credentialVersion).toBe(1);
      }
    } finally { cas.mockRestore(); await f.service.close(); }
  }
});

it('coalesces ten concurrent prepared-account refresh callers into one refresh and one budget debit', async () => {
  const f = await multiConnectionFixture({ expiredToken: true });
  const account = await f.service.currentAccount();
  const gate = deferred<{ accessToken: string; refreshToken: string | null; expiresAt: string; scopes: string[] | null }>();
  f.client.refresh.mockImplementationOnce(() => gate.promise);
  const consumeRefreshRequest = vi.fn(async () => undefined);
  const callers = Array.from({ length: 10 }, () =>
    f.service.withAccessToken({
      account,
      signal: new AbortController().signal,
      deadlineAt: new Date(f.now() + 20_000).toISOString(),
      consumeRefreshRequest,
    }, async (token) => token),
  );
  try {
    await vi.waitFor(() => expect(f.client.refresh).toHaveBeenCalledTimes(1));
    gate.resolve({
      accessToken: 'coalesced-access',
      refreshToken: 'coalesced-refresh',
      expiresAt: new Date(f.now() + 3600_000).toISOString(),
      scopes: [...CALENDAR_SCOPES],
    });
    expect(await Promise.all(callers)).toEqual(Array(10).fill('coalesced-access'));
    expect(consumeRefreshRequest).toHaveBeenCalledTimes(1);
    expect(f.client.refresh).toHaveBeenCalledTimes(1);
  } finally {
    gate.resolve({
      accessToken: 'coalesced-access',
      refreshToken: 'coalesced-refresh',
      expiresAt: new Date(f.now() + 3600_000).toISOString(),
      scopes: [...CALENDAR_SCOPES],
    });
    await Promise.allSettled(callers);
    await f.service.close();
  }
});

it('checks unchanged read capability with storage blocked', async () => {
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
});

it('keeps create target capability checks fresh when storage is blocked', async () => {
  const f = await multiConnectionFixture();
  const checkTarget = vi.fn(async (input: { calendarId: string; consumeRequest: (k: 'capability-recheck') => Promise<void> }) => {
    await input.consumeRequest('capability-recheck');
    return f.entries.find((entry) => entry.calendarId === input.calendarId) ?? null;
  });
  const service = new GoogleCalendarConnections({
    store: f.adapter, storeV2: f.adapter.v2, cipher: f.cipher, options: f.options,
    userId: 'u1', client: f.client, now: f.now,
    retentionPolicy: () => ({ policyId: 'fixture-policy',
      expiresAt: new Date(f.now() + 300000).toISOString() }),
    discovery: { discover: f.discover, checkTarget },
  });
  const request = { ...await f.request('create', 'shared-team'), account: await service.currentAccount() };
  const resolved = await service.resolveTarget(request);
  if (resolved.outcome !== 'resolved') throw new Error('fixture target missing');
  const get = vi.spyOn(f.adapter.v2, 'get').mockRejectedValue(new Error('blocked connection read'));
  try {
    await expect(service.requireTargetCurrent({ ...request, target: resolved.target }))
      .rejects.toThrow('blocked connection read');
    expect(get).toHaveBeenCalled();
    expect(checkTarget).not.toHaveBeenCalled();
  } finally {
    get.mockRestore(); await service.close(); await f.service.close();
  }
});
