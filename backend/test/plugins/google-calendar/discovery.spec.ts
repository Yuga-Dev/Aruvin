/**
 * ============================================================================
 * FILE: discovery.spec.ts
 * LOCATION: backend/test/plugins/google-calendar/discovery.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Unit and concurrency tests for CalendarDiscoveryService.
 *
 * ROLE IN PROJECT:
 *    Tests coalesced discovery refreshes, boundary limits, partial evidence
 *    preservation, and lifecycle fencing.
 *
 * KEY COMPONENTS:
 *    - Coalescing: Multi-caller manual refresh flight sharing
 *    - Partial evidence: Byte-for-byte preservation without extending expiry
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { CALENDAR_SCOPES } from '../../../src/contracts/calendar-policy.js';
import { deferred } from './oauth-fixtures.js';
import { multiConnectionFixture } from './connection-multi-fixtures.js';

it('coalesces manual refresh and cannot resurrect a disconnected account', async () => {
  const f = await multiConnectionFixture();
  const old = (await f.read())!;
  const result = deferred<NonNullable<typeof old.discovery>>();
  f.discover.mockImplementationOnce(() => result.promise);
  const signal = new AbortController().signal;
  const a = f.service.refreshCalendars({ expectedConnectionRevision: old.connectionRevision }, signal);
  const b = f.service.refreshCalendars({ expectedConnectionRevision: old.connectionRevision }, signal);
  await vi.waitFor(() => expect(f.discover).toHaveBeenCalledTimes(1));
  await f.service.disconnect({ mode: 'local' }, signal);
  result.resolve({ ...old.discovery!, discoveryRevision: old.revision + 1 });
  await Promise.allSettled([a, b]);
  expect(await f.read()).toMatchObject({ status: 'disconnected', credentials: null, discovery: null });
  expect(f.discover).toHaveBeenCalledTimes(1);
});

it('keeps complete evidence byte-for-byte after a partial refresh and does not extend expiry', async () => {
  const f = await multiConnectionFixture();
  const before = (await f.read())!;
  f.discover.mockResolvedValueOnce({ ...before.discovery!, discoveryRevision: before.revision + 1,
    complete: false, truncated: true, nextPageToken: 'provider-only', limitations: ['page-limit'] });
  await expect(f.service.refreshCalendars({ expectedConnectionRevision: before.connectionRevision },
    new AbortController().signal)).rejects.toMatchObject({ failure: { code: 'CALENDAR_DISCOVERY_PARTIAL' } });
  expect((await f.read())!.discovery).toEqual(before.discovery);
  expect((await f.read())!.defaultSetting).toEqual(before.defaultSetting);
});

it('expiry at 300000ms triggers a scan, fresh ensureFresh does not', async () => {
  const f = await multiConnectionFixture();
  const account = await f.service.currentAccount();
  const input = {
    account,
    mode: 'out-of-turn' as const,
    signal: new AbortController().signal,
    deadlineAt: new Date(f.now() + 20000).toISOString(),
    force: false,
    purpose: 'discovery' as const,
    consumeRequest: vi.fn(async () => undefined),
    consumeRefreshRequest: vi.fn(async () => undefined),
  };
  // Fresh cache does not trigger discover
  const snap1 = await f.service.discoveryService!.ensureFresh(input);
  expect(snap1).toBeDefined();
  expect(f.discover).not.toHaveBeenCalled();

  // Advance time past 300000ms expiry
  f.advance(300001);
  const snap2 = await f.service.discoveryService!.ensureFresh({
    ...input,
    deadlineAt: new Date(f.now() + 20000).toISOString(),
  });
  expect(snap2).toBeDefined();
  expect(f.discover).toHaveBeenCalledTimes(1);
});

it('does not persist a volatile no-store discovery result', async () => {
  const f = await multiConnectionFixture();
  const before = (await f.read())!;
  f.discover.mockResolvedValueOnce({
    ...before.discovery!,
    discoveryRevision: before.revision + 1,
    retentionPolicyId: null,
    expiresAt: new Date(f.now()).toISOString(),
  });
  const account = await f.service.currentAccount();
  const result = await f.service.discoveryService!.refresh({
    account,
    mode: 'out-of-turn',
    signal: new AbortController().signal,
    deadlineAt: new Date(f.now() + 20000).toISOString(),
    force: true,
    purpose: 'discovery',
    consumeRequest: vi.fn(async () => undefined),
    consumeRefreshRequest: vi.fn(async () => undefined),
  });
  expect(result.retentionPolicyId).toBeNull();
  expect((await f.read())!.discovery).toEqual(before.discovery);
});

it('401 -> refresh -> success uses two Calendar deliveries and one refresh', async () => {
  const f = await multiConnectionFixture();
  const account = await f.service.currentAccount();
  const before = (await f.read())!;
  const toolFault = (await import('../../../src/plugins/google-calendar/tools-validation.js')).toolFault;
  f.discover
    .mockRejectedValueOnce(toolFault('credential', 'RECONNECT_REQUIRED'))
    .mockResolvedValueOnce({
      ...before.discovery!,
      discoveryRevision: before.revision + 1,
    });
  f.client.refresh.mockResolvedValueOnce({
    accessToken: 'rotated-access',
    refreshToken: null,
    expiresAt: new Date(f.now() + 3600000).toISOString(),
    scopes: null,
  });

  const refreshed = await f.service.discoveryService!.refresh({
    account,
    mode: 'out-of-turn',
    signal: new AbortController().signal,
    deadlineAt: new Date(f.now() + 20000).toISOString(),
    force: true,
    purpose: 'discovery',
    consumeRequest: vi.fn(async () => undefined),
    consumeRefreshRequest: vi.fn(async () => undefined),
  });
  expect(refreshed).toBeDefined();
  expect(f.discover).toHaveBeenCalledTimes(2);
  expect(f.client.refresh).toHaveBeenCalledTimes(1);
});

it('401 -> refresh -> 401 is terminal and marks account reconnect-required', async () => {
  const f = await multiConnectionFixture();
  const account = await f.service.currentAccount();
  const toolFault = (await import('../../../src/plugins/google-calendar/tools-validation.js')).toolFault;
  f.discover
    .mockRejectedValueOnce(toolFault('credential', 'RECONNECT_REQUIRED'))
    .mockRejectedValueOnce(toolFault('credential', 'RECONNECT_REQUIRED'));
  f.client.refresh.mockResolvedValueOnce({
    accessToken: 'rotated-access',
    refreshToken: null,
    expiresAt: new Date(f.now() + 3600000).toISOString(),
    scopes: null,
  });

  await expect(
    f.service.discoveryService!.refresh({
      account,
      mode: 'out-of-turn',
      signal: new AbortController().signal,
      deadlineAt: new Date(f.now() + 20000).toISOString(),
      force: true,
      purpose: 'discovery',
      consumeRequest: vi.fn(async () => undefined),
      consumeRefreshRequest: vi.fn(async () => undefined),
    }),
  ).rejects.toMatchObject({ failure: { code: 'RECONNECT_REQUIRED' } });
  expect(f.discover).toHaveBeenCalledTimes(2);
  expect(f.client.refresh).toHaveBeenCalledTimes(1);
  expect((await f.read())!.status).toBe('reconnect-required');
});

it('refreshes at exact expiry boundary and when retention expires despite fresh cache timestamp', async () => {
  const f = await multiConnectionFixture();
  const account = await f.service.currentAccount();
  const baseInput = {
    account,
    mode: 'out-of-turn' as const,
    signal: new AbortController().signal,
    deadlineAt: new Date(f.now() + 500_000).toISOString(),
    force: false,
    purpose: 'discovery' as const,
    consumeRequest: vi.fn(async () => undefined),
    consumeRefreshRequest: vi.fn(async () => undefined),
  };

  // Exact boundary: 300000ms after fetchedAt
  f.advance(300000);
  await f.service.discoveryService!.ensureFresh(baseInput);
  expect(f.discover).toHaveBeenCalledTimes(1);

  // Patch discovery with fresh expiresAt (later) but expired retentionExpiresAt
  const cur = (await f.read())!;
  const res = await f.patch({
    discovery: {
      ...cur.discovery!,
      discoveryRevision: cur.revision + 1,
      fetchedAt: new Date(f.now()).toISOString(),
      expiresAt: new Date(f.now() + 200_000).toISOString(),
      retentionExpiresAt: new Date(f.now() + 200_000).toISOString(),
    },
  });
  expect(res.outcome).toBe('confirmed');
  f.advance(200_000);
  await f.service.discoveryService!.ensureFresh({
    ...baseInput,
    deadlineAt: new Date(f.now() + 20_000).toISOString(),
  });
  expect(f.discover).toHaveBeenCalledTimes(2);
});

it('skips no-op CAS when forced refresh returns unchanged complete snapshot', async () => {
  const f = await multiConnectionFixture();
  const account = await f.service.currentAccount();
  const before = (await f.read())!;
  // Align initial snapshot retentionExpiresAt with what the fixture policy grants
  await f.patch({
    discovery: { ...before.discovery!, discoveryRevision: before.revision + 1,
      retentionExpiresAt: before.discovery!.expiresAt },
  });
  const cas = vi.spyOn(f.adapter.v2, 'compareAndSwap');
  try {
    const snap = await f.service.discoveryService!.refresh({
      account,
      mode: 'out-of-turn',
      signal: new AbortController().signal,
      deadlineAt: new Date(f.now() + 20_000).toISOString(),
      force: true,
      purpose: 'discovery',
      consumeRequest: vi.fn(async () => undefined),
      consumeRefreshRequest: vi.fn(async () => undefined),
    });
    expect(f.discover).toHaveBeenCalledTimes(1);
    expect(cas).not.toHaveBeenCalled();
    expect(snap.expiresAt).toBe(before.discovery!.expiresAt);
  } finally { cas.mockRestore(); await f.service.close(); }
});

it('rejects an old discovery completion after account replacement without overwriting replacement', async () => {
  const f = await multiConnectionFixture();
  const oldAccount = await f.service.currentAccount();
  const oldSnap = (await f.read())!.discovery!;
  const held = deferred<typeof oldSnap>();
  f.discover.mockImplementationOnce(() => held.promise);
  const pending = f.service.discoveryService!.refresh({
    account: oldAccount,
    mode: 'out-of-turn',
    signal: new AbortController().signal,
    deadlineAt: new Date(f.now() + 20_000).toISOString(),
    force: true,
    purpose: 'discovery',
    consumeRequest: vi.fn(async () => undefined),
    consumeRefreshRequest: vi.fn(async () => undefined),
  });
  await vi.waitFor(() => expect(f.discover).toHaveBeenCalledTimes(1));

  // Replace account with a different Google subject
  const snapshot = await f.service.captureSetupSnapshot();
  await f.service.beginConsent(new AbortController().signal);
  const cur = (await f.read())!;
  await f.service.installGrant({
    snapshot: { ...snapshot, lifecycleEpoch: f.service.getLifecycleEpoch(), recordRevision: cur.revision, expectedGoogleSubjectId: null },
    grant: {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: new Date(f.now() + 3600_000).toISOString(),
      scopes: [...CALENDAR_SCOPES],
    },
    account: { subject: 'replacement-sub', email: 'new@example.invalid' },
    signal: new AbortController().signal,
    deadlineAt: new Date(f.now() + 20_000).toISOString(),
    isCurrentFlow: () => true,
  });

  held.resolve(oldSnap);
  await expect(pending).rejects.toBeDefined();
  const after = (await f.read())!;
  expect(after.googleSubjectId).toBe('replacement-sub');
  expect(after.connectionRevision).toBeGreaterThan(oldAccount.connectionRevision);
});

