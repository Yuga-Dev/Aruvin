/**
 * ============================================================================
 * FILE: connection-capabilities.spec.ts
 * LOCATION: backend/test/plugins/google-calendar/connection-capabilities.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Unit tests for CalendarCapabilityGate role and operation checking.
 *
 * ROLE IN PROJECT:
 *    Ensures read/create/availability permissions are checked against fresh provider
 *    evidence, saved defaults do not silently fall back, and missing primary clarifies.
 *
 * KEY COMPONENTS:
 *    - Role/operation gating: Distinct permissions for reader/writer/owner/freeBusy
 *    - Default preservation: Clarifies on missing or ambiguous saved targets
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { effectiveCalendarCapabilities } from '../../../src/contracts/calendar-discovery.js';
import { CALENDAR_SCOPES, CALENDAR_SCOPES_V1 } from '../../../src/contracts/calendar-policy.js';
import { GoogleCalendarConnections } from '../../../src/plugins/google-calendar/connection.js';
import { toolFault } from '../../../src/plugins/google-calendar/tools-validation.js';
import { multiConnectionFixture } from './connection-multi-fixtures.js';

it('gates read create and availability separately on fresh shared roles', async () => {
  for (const role of ['owner', 'writer', 'writerWithoutPrivateAccess', 'reader', 'freeBusyReader'] as const) {
    for (const operation of ['read', 'create', 'availability'] as const) {
      const f = await multiConnectionFixture();
      f.entries[1] = { ...f.entries[1]!, accessRole: role,
        privateAccess: role === 'owner' || role === 'writer',
        capabilities: effectiveCalendarCapabilities(role, CALENDAR_SCOPES, true) };
      // Expire selection evidence: a fresh cache is deliberately reused; the
      // independent effect gate below must still see immediate provider changes.
      f.advance(300001);
      const result = await f.service.capabilityGate.resolve(await f.request(operation, 'shared-team'));
      const allowed = operation === 'availability'
        || (operation === 'read' ? role !== 'freeBusyReader' : !['reader', 'freeBusyReader'].includes(role));
      expect(result.outcome).toBe(allowed ? 'resolved' : 'denied');
      if (result.outcome === 'resolved') {
        expect(result.target.calendarId).toBe('shared-team');
        expect(result.target.privateAccess).toBe(role === 'owner' || role === 'writer');
      }
      expect(f.discover).toHaveBeenCalled();
    }
  }
  const old = await multiConnectionFixture({ scopes: CALENDAR_SCOPES_V1 });
  await expect(old.service.currentAccount()).rejects.toMatchObject({ failure: { code: 'CALENDAR_RECONNECT_REQUIRED' } });
  expect(old.client.refresh).not.toHaveBeenCalled();
});

it('does not silently replace an unavailable saved default or invent primary from email', async () => {
  const f = await multiConnectionFixture({ defaultCalendarId: 'gone-calendar' });
  expect(await f.service.capabilityGate.resolve(await f.request('create')))
    .toMatchObject({ outcome: 'clarify', code: 'CALENDAR_DEFAULT_UNAVAILABLE' });
  expect(await f.service.capabilityGate.resolve(await f.request('create', 'unknown')))
    .toMatchObject({ outcome: 'clarify', code: 'CALENDAR_TARGET_UNKNOWN' });
  f.entries[0] = { ...f.entries[0]!, primary: false };
  f.advance(300001);
  f.discover.mockImplementationOnce(async input => ({ ...((await f.read())!.discovery!),
    discoveryRevision: input.discoveryRevision, entries: f.entries, complete: false,
    limitations: ['primary-missing'] }));
  expect(await f.service.capabilityGate.resolve(await f.request('create', 'primary')))
    .toMatchObject({ outcome: 'clarify', code: 'CALENDAR_PRIMARY_MISSING' });
});

it('reuses fresh selection but checks provider revocation independently at the effect boundary', async () => {
  const f = await multiConnectionFixture();
  try {
    const request = await f.request('create', 'shared-team');
    const resolved = await f.service.resolveTarget(request);
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') throw new Error('Fixture target missing');
    expect(f.discover).not.toHaveBeenCalled();
    f.entries[1] = { ...f.entries[1]!, accessRole: 'reader', privateAccess: false,
      capabilities: effectiveCalendarCapabilities('reader', CALENDAR_SCOPES, true) };
    await expect(f.service.requireTargetCurrent({ ...request, target: resolved.target }))
      .rejects.toMatchObject({ failure: { code: 'CALENDAR_TARGET_READ_ONLY' } });
    expect(f.discover).toHaveBeenCalledTimes(1);
  } finally { await f.service.close(); }
});

it('rejects revoked reader or masked privateAccess even when read capability remains', async () => {
  const f = await multiConnectionFixture();
  const service = new GoogleCalendarConnections({
    store: f.adapter, storeV2: f.adapter.v2, cipher: f.cipher, options: f.options,
    userId: 'u1', client: f.client, now: f.now,
    retentionPolicy: () => ({ policyId: 'fixture-policy', expiresAt: new Date(f.now() + 300000).toISOString() }),
    discovery: {
      discover: f.discover,
      checkTarget: async (input) => {
        await input.consumeRequest('capability-recheck');
        return f.entries.find((e) => e.calendarId === input.calendarId) ?? null;
      },
    },
  });
  try {
    const request = { ...await f.request('read', 'shared-team'), account: await service.currentAccount() };
    const resolved = await service.resolveTarget(request);
    if (resolved.outcome !== 'resolved') throw new Error('fixture target missing');
    expect(resolved.target.privateAccess).toBe(true);

    // Become writerWithoutPrivateAccess (still has readEvents: true, but privateAccess: false)
    f.entries[1] = {
      ...f.entries[1]!,
      accessRole: 'writerWithoutPrivateAccess',
      privateAccess: false,
      capabilities: effectiveCalendarCapabilities('writerWithoutPrivateAccess', CALENDAR_SCOPES, true),
    };
    await expect(service.requireTargetCurrent({ ...request, target: resolved.target }))
      .rejects.toMatchObject({ failure: { code: 'CALENDAR_EXECUTION_DENIED' } });

    // Become freeBusyReader (readEvents: false)
    f.entries[1] = {
      ...f.entries[1]!,
      accessRole: 'freeBusyReader',
      privateAccess: false,
      capabilities: effectiveCalendarCapabilities('freeBusyReader', CALENDAR_SCOPES, true),
    };
    await expect(service.requireTargetCurrent({ ...request, target: resolved.target }))
      .rejects.toMatchObject({ failure: { code: 'CALENDAR_EXECUTION_DENIED' } });
  } finally { await service.close(); await f.service.close(); }
});

it('rebases changed-role checkTarget CAS conflict and fences on uncertain CAS', async () => {
  const f = await multiConnectionFixture();
  const service = new GoogleCalendarConnections({
    store: f.adapter, storeV2: f.adapter.v2, cipher: f.cipher, options: f.options,
    userId: 'u1', client: f.client, now: f.now,
    retentionPolicy: () => ({ policyId: 'fixture-policy', expiresAt: new Date(f.now() + 300000).toISOString() }),
    discovery: {
      discover: f.discover,
      checkTarget: async (input) => {
        await input.consumeRequest('capability-recheck');
        return f.entries.find((e) => e.calendarId === input.calendarId) ?? null;
      },
    },
  });
  try {
    const request = { ...await f.request('read', 'shared-team'), account: await service.currentAccount() };
    const resolved = await service.resolveTarget(request);
    if (resolved.outcome !== 'resolved') throw new Error('fixture target missing');

    // Change shared-team to reader (still readable, but different role -> triggers CAS)
    f.entries[1] = {
      ...f.entries[1]!,
      accessRole: 'reader',
      privateAccess: false,
      capabilities: effectiveCalendarCapabilities('reader', CALENDAR_SCOPES, true),
    };
    const origCas = f.adapter.v2.compareAndSwap.bind(f.adapter.v2);
    const cas = vi.spyOn(f.adapter.v2, 'compareAndSwap')
      .mockResolvedValueOnce({ outcome: 'conflict', currentRevision: 2, currentDefaultSettingRevision: 1 })
      .mockImplementationOnce((input) => origCas(input));

    await expect(service.requireTargetCurrent({ ...request, target: resolved.target }))
      .rejects.toMatchObject({ failure: { code: 'CALENDAR_EXECUTION_DENIED' } });
    expect(cas).toHaveBeenCalledTimes(2);
    cas.mockRestore();

    // Now test uncertain CAS fences the owner
    const request2 = { ...await f.request('read', 'shared-team'), account: await service.currentAccount() };
    const resolved2 = await service.resolveTarget(request2);
    if (resolved2.outcome !== 'resolved') throw new Error('fixture target missing');
    f.entries[1] = {
      ...f.entries[1]!,
      accessRole: 'writer',
      privateAccess: true,
      capabilities: effectiveCalendarCapabilities('writer', CALENDAR_SCOPES, true),
    };
    const uncertainCas = vi.spyOn(f.adapter.v2, 'compareAndSwap').mockResolvedValueOnce({ outcome: 'uncertain' });
    await expect(service.requireTargetCurrent({ ...request2, target: resolved2.target }))
      .rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' });
    uncertainCas.mockRestore();
    await expect(service.currentAccount()).rejects.toMatchObject({ failure: { code: 'CALENDAR_EXECUTION_DENIED' } });
  } finally { await service.close(); await f.service.close(); }
});

it('rejects checkTarget on provider request-budget exhaustion without CAS and preserves 401 one-refresh retry', async () => {
  const f = await multiConnectionFixture();
  const checkTarget = vi.fn(async (input: { calendarId: string; consumeRequest: (k: 'capability-recheck') => Promise<void> }) => {
    await input.consumeRequest('capability-recheck');
    return f.entries.find((e) => e.calendarId === input.calendarId) ?? null;
  });
  const service = new GoogleCalendarConnections({
    store: f.adapter, storeV2: f.adapter.v2, cipher: f.cipher, options: f.options,
    userId: 'u1', client: f.client, now: f.now,
    retentionPolicy: () => ({ policyId: 'fixture-policy', expiresAt: new Date(f.now() + 300000).toISOString() }),
    discovery: { discover: f.discover, checkTarget },
  });
  const cas = vi.spyOn(f.adapter.v2, 'compareAndSwap');
  try {
    const request = { ...await f.request('read', 'shared-team'), account: await service.currentAccount() };
    const resolved = await service.resolveTarget(request);
    if (resolved.outcome !== 'resolved') throw new Error('fixture target missing');

    // Request budget rejection
    request.consumeRequest.mockRejectedValueOnce(toolFault('budget', 'CALENDAR_REQUEST_BUDGET'));
    await expect(service.requireTargetCurrent({ ...request, target: resolved.target }))
      .rejects.toMatchObject({ failure: { code: 'CALENDAR_REQUEST_BUDGET' } });
    expect(cas).not.toHaveBeenCalled();

    // 401 -> one refresh -> one bounded second check
    checkTarget
      .mockRejectedValueOnce(toolFault('credential', 'RECONNECT_REQUIRED'))
      .mockResolvedValueOnce(f.entries[1]!);
    f.client.refresh.mockResolvedValueOnce({
      accessToken: 'rotated-access',
      refreshToken: null,
      expiresAt: new Date(f.now() + 3600000).toISOString(),
      scopes: null,
    });
    await service.requireTargetCurrent({ ...request, target: resolved.target });
    expect(f.client.refresh).toHaveBeenCalledTimes(1);
    expect(checkTarget).toHaveBeenCalledTimes(3);
  } finally { cas.mockRestore(); await service.close(); await f.service.close(); }
});
