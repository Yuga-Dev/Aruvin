/**
 * ============================================================================
 * FILE: tools-boundaries.spec.ts
 * LOCATION: backend/test/plugins/google-calendar/tools-boundaries.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Direct-executor lifecycle, drain, cancellation, and post-dispatch safety.
 *
 * ROLE IN PROJECT:
 *    Relocates necessary MCP wrapper guarantees onto CalendarApiTools: active
 *    work accounting, idempotent close, blocked-request abort, and uncertain
 *    create outcomes after a dispatched write.
 *
 * KEY COMPONENTS:
 *    - Active execution accounting until settlement
 *    - Close/cancel/deadline drain without claiming a missing create
 *    - Revocation and admission races before Google effects
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../../../src/contracts/auth.js';
import {
  calendarExecutionBindingV2Schema,
  operationRecordV2Schema,
  type CalendarRequestKindV2,
} from '../../../src/contracts/calendar-operations.js';
import { CALENDAR_LIMITS } from '../../../src/contracts/calendar-policy.js';
import { createCalendarAssembly } from '../../../src/operations/calendar-assembly.js';
import { toolFault, calendarActionHash, calendarEventId } from '../../../src/plugins/google-calendar/tools-validation.js';
import { assembledCalendarApp } from '../../assembly/calendar-fixture.js';
import { deferred } from '../../assembly/admin-config-fixture.js';
import { admittedAccount } from '../../auth/fixtures.js';
import { multiConnectionFixture } from './connection-multi-fixtures.js';
import { multiToolsFixture } from './tools-multi-fixtures.js';
import {
  CREATE_ACTION,
  fakeFetch,
  googleJson,
  googleEvent,
  type FakeStep,
} from './tools-fixtures.js';

it('counts active direct work until settlement and refuses later work after close', async () => {
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const f = multiToolsFixture({ operation: null, call: {
    name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } }, steps: [{
    method: 'GET', path: '/calendar/v3/calendars/shared/events/abcde01234',
    response: async () => { started(); await resume; return googleJson(googleEvent()); },
  }] });
  const pending = f.tools.invoke(f.input);
  try {
    await entered;
    expect(f.tools.activeExecutions).toBe(1);
    const closing = f.tools.close();
    release();
    await pending;
    await closing;
    expect(f.tools.activeExecutions).toBe(0);
    expect(await f.tools.invoke(f.input)).toMatchObject({ outcome: 'failure' });
    expect(f.requests).toHaveLength(1);
    await f.tools.close();
  } finally { release(); await pending; await f.tools.close(); }
});

it('never claims a noncreation when a dispatched create is cut short', async () => {
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = multiToolsFixture({ steps: [{
    method: 'POST', path: '/calendar/v3/calendars/shared/events',
    response: () => {
      started();
      return new Response(new ReadableStream<Uint8Array>({ pull() { /* never ends */ } }),
        { headers: { 'content-type': 'application/json' } });
    },
  }] });
  const pending = f.tools.invoke(f.input);
  try {
    await entered;
    expect(f.tools.activeExecutions).toBe(1);
    const closing = f.tools.close();
    expect(await pending).toMatchObject({ outcome: 'failure', failure: {
      category: 'uncertain', code: 'WRITE_OUTCOME_UNKNOWN', retry: 'readback' } });
    await closing;
    expect(f.requests).toHaveLength(1);
  } finally { await pending; await f.tools.close(); }
});

it('honours invocation cancellation without an external effect after close', async () => {
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = multiToolsFixture({ operation: null, call: {
    name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } }, steps: [{
    method: 'GET', path: '/calendar/v3/calendars/shared/events/abcde01234',
    response: () => {
      started();
      return new Response(new ReadableStream<Uint8Array>({ pull() { /* never ends */ } }),
        { headers: { 'content-type': 'application/json' } });
    },
  }] });
  const controller = new AbortController();
  const pending = f.tools.invoke({ ...f.input, signal: controller.signal });
  try {
    await entered;
    expect(f.tools.activeExecutions).toBe(1);
    controller.abort();
    expect(await pending).toMatchObject({ outcome: 'failure' });
    expect(f.tools.activeExecutions).toBe(0);
  } finally { await pending; await f.tools.close(); }
});

it('bounds the invocation by a shorter remaining deadline', async () => {
  const f = multiToolsFixture({ operation: null, call: {
    name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } }, steps: [{
    method: 'GET', path: '/calendar/v3/calendars/shared/events/abcde01234',
    response: () => new Response(new ReadableStream<Uint8Array>({ pull() { /* never ends */ } }),
      { headers: { 'content-type': 'application/json' } }),
  }] });
  f.input.binding = { ...f.input.binding, deadlineAt: new Date(Date.now() + 200).toISOString() };
  const started = Date.now();
  try {
    expect(await f.tools.invoke(f.input)).toMatchObject({ outcome: 'failure' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(f.tools.activeExecutions).toBe(0);
  } finally { await f.tools.close(); }
});

it('refuses the effect when the connection changes while the credential callback waits', async () => {
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const opened = new Promise<void>(resolve => { release = resolve; });
  const f = multiToolsFixture({ operation: null, call: {
    name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } }, steps: [{
    method: 'GET', path: '/calendar/v3/calendars/shared/events/abcde01234',
    response: () => googleJson(googleEvent()),
  }] });
  const original = f.credentials.withAccessToken.bind(f.credentials);
  f.credentials.withAccessToken = async (input, action) => {
    started();
    await opened;
    return original(input, action);
  };
  const pending = f.tools.invoke(f.input);
  try {
    await entered;
    expect(f.tools.activeExecutions).toBe(1);
    f.gate.disable();
    release();
    expect(await pending).toMatchObject({ outcome: 'failure', failure: { retry: 'none' } });
    expect(f.requests).toHaveLength(0);
  } finally { release(); await pending; await f.tools.close(); }
});

it('does not accumulate active work across repeated invocations', async () => {
  const f = multiToolsFixture({ operation: null, call: {
    name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } }, steps: [{
    method: 'GET', path: '/calendar/v3/calendars/shared/events/abcde01234',
    response: () => googleJson(googleEvent()),
  }, {
    method: 'GET', path: '/calendar/v3/calendars/shared/events/abcde01234',
    response: () => googleJson(googleEvent()),
  }] });
  try {
    expect(await f.tools.invoke(f.input)).toMatchObject({ outcome: 'success' });
    expect(f.tools.activeExecutions).toBe(0);
    expect(await f.tools.invoke(f.input)).toMatchObject({ outcome: 'success' });
    expect(f.tools.activeExecutions).toBe(0);
    expect(f.requests).toHaveLength(2);
  } finally { await f.tools.close(); }
});

it('refuses to deliver a result above a lower configured result limit', async () => {
  const f = multiToolsFixture({ operation: null, limits: { ...CALENDAR_LIMITS, resultBytes: 512 },
    call: { name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } },
    steps: [{ method: 'GET', path: '/calendar/v3/calendars/shared/events/abcde01234',
      response: () => googleJson(googleEvent()) }] });
  try {
    expect(await f.tools.invoke(f.input)).toMatchObject({ outcome: 'failure', failure: {
      category: 'delivery', code: 'CALENDAR_RESULT_TOO_LARGE', retry: 'none' } });
    expect(f.requests).toHaveLength(1);
  } finally { await f.tools.close(); }
});

async function assembledReadFixture(options: {
  steps?: FakeStep[];
  permissionContent?: 'volatile' | 'retained';
  onAccountInvalidated?: () => Promise<void>;
} = {}) {
  const f = await multiConnectionFixture();
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => f.now());
  const fake = fakeFetch(options.steps ?? []);
  const owner = createCalendarAssembly({
    config: {
      setup: f.options,
      permission: {
        content: options.permissionContent ?? 'volatile',
        minimalEvidenceAllowed: true,
        policyId: 'fixture-policy',
      },
      policyDeadlines: [f.now() + 3600000],
      trustedTimeZone: 'Etc/UTC',
    },
    encryption: { status: 'ready', key: Buffer.alloc(32, 7) },
    userId: 'u1',
    store: f.adapter,
    storeV2: f.adapter.v2,
    discovery: {
      discover: f.discover,
      checkTarget: async (request) => {
        await request.consumeRequest('capability-recheck');
        return f.entries.find((entry) => entry.calendarId === request.calendarId) ?? null;
      },
    },
    fetcher: fake.fetcher,
    onAccountInvalidated: options.onAccountInvalidated ?? (async () => undefined),
  });
  return {
    f,
    fake,
    owner,
    dispose: async () => {
      dateNow.mockRestore();
      await owner.execution.close();
      await owner.connections.close();
      await f.service.close();
    },
  };
}

it('dispatches a prepared assembled read without touching application storage', async () => {
  const h = await assembledReadFixture({
    steps: [{
      method: 'GET',
      path: '/calendar/v3/calendars/shared-team/events/abcde01234',
      response: () => googleJson(googleEvent()),
    }],
  });
  let get: ReturnType<typeof vi.spyOn> | undefined;
  let create: ReturnType<typeof vi.spyOn> | undefined;
  let cas: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await h.owner.connections.statusV2();
    const account = await h.owner.connections.currentAccount();
    const resolved = await h.owner.connections.capabilityGate.resolve({
      account,
      selector: 'shared-team',
      operation: 'read',
      signal: new AbortController().signal,
      deadlineAt: new Date(h.f.now() + 20000).toISOString(),
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    if (resolved.outcome !== 'resolved') throw new Error('fixture target missing');

    const binding = calendarExecutionBindingV2Schema.parse({
      ...account,
      target: resolved.target,
      sessionId: 's',
      turnId: 't',
      attemptId: 'a',
      decisionId: 'd',
      toolCallId: 'tc',
      schemaRevision: 'google-calendar.v2',
      operation: null,
      trustedNow: new Date(h.f.now()).toISOString(),
      trustedTimeZone: 'Etc/UTC',
      deadlineAt: new Date(h.f.now() + 20000).toISOString(),
    });

    get = vi.spyOn(h.f.adapter.v2, 'get').mockRejectedValue(new Error('blocked connection get'));
    create = vi.spyOn(h.f.adapter.v2, 'create').mockRejectedValue(new Error('blocked connection create'));
    cas = vi.spyOn(h.f.adapter.v2, 'compareAndSwap').mockRejectedValue(new Error('blocked connection cas'));

    const kinds: CalendarRequestKindV2[] = [];
    const result = await h.owner.execution.invoke({
      binding,
      call: { name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } },
      signal: new AbortController().signal,
      consumeRequest: async (kind) => { kinds.push(kind); },
      consumeRefreshRequest: async () => undefined,
    });

    expect(result).toMatchObject({ outcome: 'success', receipt: null });
    expect(h.fake.requests).toHaveLength(1);
    expect(kinds).toEqual(['capability-recheck', 'get']);
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(cas).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('fixture-access');
    expect(JSON.stringify(result)).not.toContain('fixture-refresh');
  } finally {
    get?.mockRestore();
    create?.mockRestore();
    cas?.mockRestore();
    await h.dispose();
  }
});

it('dispatches prepared assembled list_events, list_calendars, and check_availability with blocked and unresolved storage', async () => {
  const h = await assembledReadFixture({
    steps: [
      {
        method: 'GET',
        path: '/calendar/v3/calendars/shared-team/events',
        response: () => googleJson({ timeZone: 'Etc/UTC', items: [googleEvent()] }),
      },
      {
        method: 'POST',
        path: '/calendar/v3/freeBusy',
        response: () => googleJson({
          timeMin: '2026-10-22T10:00:00Z',
          timeMax: '2026-10-22T11:00:00Z',
          calendars: {
            primary: { busy: [] },
            'shared-team': { busy: [{ start: '2026-10-22T10:15:00Z', end: '2026-10-22T10:30:00Z' }] },
          },
        }),
      },
    ],
  });
  let get: ReturnType<typeof vi.spyOn> | undefined;
  let create: ReturnType<typeof vi.spyOn> | undefined;
  let cas: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await h.owner.connections.statusV2();
    const account = await h.owner.connections.currentAccount();
    const resolved = await h.owner.connections.capabilityGate.resolve({
      account,
      selector: 'shared-team',
      operation: 'read',
      signal: new AbortController().signal,
      deadlineAt: new Date(h.f.now() + 20000).toISOString(),
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    if (resolved.outcome !== 'resolved') throw new Error('fixture target missing');
    const binding = calendarExecutionBindingV2Schema.parse({
      ...account,
      target: resolved.target,
      sessionId: 's',
      turnId: 't',
      attemptId: 'a',
      decisionId: 'd',
      toolCallId: 'tc',
      schemaRevision: 'google-calendar.v2',
      operation: null,
      trustedNow: new Date(h.f.now()).toISOString(),
      trustedTimeZone: 'Etc/UTC',
      deadlineAt: new Date(h.f.now() + 20000).toISOString(),
    });

    // Return a never-settling promise on store.get to prove no hidden storage wait.
    get = vi.spyOn(h.f.adapter.v2, 'get').mockImplementation(() => new Promise(() => undefined));
    create = vi.spyOn(h.f.adapter.v2, 'create').mockRejectedValue(new Error('blocked create'));
    cas = vi.spyOn(h.f.adapter.v2, 'compareAndSwap').mockRejectedValue(new Error('blocked cas'));

    const listEvents = await h.owner.execution.invoke({
      binding,
      call: {
        name: 'calendar_list_events',
        arguments: { timeMin: '2026-10-22T10:00:00Z', timeMax: '2026-10-22T11:00:00Z', maxResults: 5 },
      },
      signal: new AbortController().signal,
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    expect(listEvents).toMatchObject({ outcome: 'success', receipt: null });

    const listCalendars = await h.owner.execution.invoke({
      binding: { ...binding, target: null },
      call: { name: 'calendar_list_calendars', arguments: {} },
      signal: new AbortController().signal,
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    expect(listCalendars).toMatchObject({ outcome: 'success', receipt: null });

    const availabilityKinds: CalendarRequestKindV2[] = [];
    const availability = await h.owner.execution.invoke({
      binding: { ...binding, target: null },
      call: {
        name: 'calendar_check_availability',
        arguments: { timeMin: '2026-10-22T10:00:00Z', timeMax: '2026-10-22T11:00:00Z', timeZone: 'Etc/UTC' },
      },
      signal: new AbortController().signal,
      consumeRequest: async (kind) => { availabilityKinds.push(kind); },
      consumeRefreshRequest: async () => undefined,
    });
    expect(availability).toMatchObject({ outcome: 'success', receipt: null });
    expect(availabilityKinds).toEqual(['availability']);
    expect(h.fake.requests).toHaveLength(2);
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(cas).not.toHaveBeenCalled();
  } finally {
    get?.mockRestore();
    create?.mockRestore();
    cas?.mockRestore();
    await h.dispose();
  }
});

it('denies prepared reads on pause-time invalidation, cancel, deadline, masked target, expiry, and budget exhaustion', async () => {
  let enterGet!: () => void;
  let resumeGet!: () => void;
  const enteredGet = new Promise<void>(resolve => { enterGet = resolve; });
  const getWait = new Promise<void>(resolve => { resumeGet = resolve; });
  let enterAvail!: () => void;
  let resumeAvail!: () => void;
  const enteredAvail = new Promise<void>(resolve => { enterAvail = resolve; });
  const availWait = new Promise<void>(resolve => { resumeAvail = resolve; });

  const h = await assembledReadFixture({ steps: [] });
  try {
    await h.owner.connections.statusV2();
    const account = await h.owner.connections.currentAccount();
    const resolved = await h.owner.connections.capabilityGate.resolve({
      account,
      selector: 'shared-team',
      operation: 'read',
      signal: new AbortController().signal,
      deadlineAt: new Date(h.f.now() + 20000).toISOString(),
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    if (resolved.outcome !== 'resolved') throw new Error('fixture target missing');
    const binding = calendarExecutionBindingV2Schema.parse({
      ...account,
      target: resolved.target,
      sessionId: 's',
      turnId: 't',
      attemptId: 'a',
      decisionId: 'd',
      toolCallId: 'tc',
      schemaRevision: 'google-calendar.v2',
      operation: null,
      trustedNow: new Date(h.f.now()).toISOString(),
      trustedTimeZone: 'Etc/UTC',
      deadlineAt: new Date(h.f.now() + 20000).toISOString(),
    });

    // 1. Request budget exhaustion denied cleanly -> 0 HTTP
    const budgetDenied = await h.owner.execution.invoke({
      binding,
      call: { name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } },
      signal: new AbortController().signal,
      consumeRequest: async () => { throw toolFault('budget', 'CALENDAR_REQUEST_LIMIT'); },
      consumeRefreshRequest: async () => undefined,
    });
    expect(budgetDenied).toMatchObject({ outcome: 'failure', failure: { category: 'budget', code: 'CALENDAR_REQUEST_LIMIT' } });
    expect(h.fake.requests).toHaveLength(0);

    // 2. Cancellation and deadline while consumeRequest waits -> 0 HTTP
    const controller = new AbortController();
    const cancelledRead = await h.owner.execution.invoke({
      binding,
      call: { name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } },
      signal: controller.signal,
      consumeRequest: async () => { controller.abort(); },
      consumeRefreshRequest: async () => undefined,
    });
    expect(cancelledRead).toMatchObject({ outcome: 'failure', failure: { category: 'policy', code: 'CALENDAR_EXECUTION_DENIED' } });

    const deadlineRead = await h.owner.execution.invoke({
      binding: { ...binding, deadlineAt: new Date(h.f.now() + 500).toISOString() },
      call: { name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } },
      signal: new AbortController().signal,
      consumeRequest: async () => { h.f.advance(600); },
      consumeRefreshRequest: async () => undefined,
    });
    expect(deadlineRead).toMatchObject({ outcome: 'failure', failure: { code: 'CALENDAR_DEADLINE_EXCEEDED' } });
    expect(h.fake.requests).toHaveLength(0);

    // 3. Account invalidated while consumeRequest paused -> 0 HTTP
    const pausedRead = await h.owner.execution.invoke({
      binding: { ...binding, deadlineAt: new Date(h.f.now() + 20000).toISOString() },
      call: { name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } },
      signal: new AbortController().signal,
      consumeRequest: async () => { h.owner.connections.invalidateAccount(account); },
      consumeRefreshRequest: async () => undefined,
    });
    expect(pausedRead).toMatchObject({ outcome: 'failure', failure: { category: 'policy', code: 'CALENDAR_EXECUTION_DENIED' } });
    expect(h.fake.requests).toHaveLength(0);
  } finally {
    await h.dispose();
  }

  // 4. Target swapped / invalidated while GET is in flight -> never publishes result
  const hGet = await assembledReadFixture({
    steps: [{
      method: 'GET',
      path: '/calendar/v3/calendars/shared-team/events/abcde01234',
      response: async () => { enterGet(); await getWait; return googleJson(googleEvent()); },
    }],
  });
  try {
    await hGet.owner.connections.statusV2();
    const accGet = await hGet.owner.connections.currentAccount();
    const resGet = await hGet.owner.connections.capabilityGate.resolve({
      account: accGet,
      selector: 'shared-team',
      operation: 'read',
      signal: new AbortController().signal,
      deadlineAt: new Date(hGet.f.now() + 20000).toISOString(),
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    if (resGet.outcome !== 'resolved') throw new Error('fixture target missing');
    const bGet = calendarExecutionBindingV2Schema.parse({
      ...accGet,
      target: resGet.target,
      sessionId: 's',
      turnId: 't',
      attemptId: 'a',
      decisionId: 'd',
      toolCallId: 'tc',
      schemaRevision: 'google-calendar.v2',
      operation: null,
      trustedNow: new Date(hGet.f.now()).toISOString(),
      trustedTimeZone: 'Etc/UTC',
      deadlineAt: new Date(hGet.f.now() + 20000).toISOString(),
    });
    const inFlightGet = hGet.owner.execution.invoke({
      binding: bGet,
      call: { name: 'calendar_get_event', arguments: { eventId: 'abcde01234' } },
      signal: new AbortController().signal,
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    await enteredGet;
    hGet.owner.connections.invalidateAccount(accGet);
    resumeGet();
    expect(await inFlightGet).toMatchObject({ outcome: 'failure', failure: { category: 'policy', code: 'CALENDAR_EXECUTION_DENIED' } });
  } finally {
    resumeGet?.();
    await hGet.dispose();
  }

  // 5. Expiry while check_availability is in flight -> never publishes stale result
  const hAvail = await assembledReadFixture({
    steps: [{
      method: 'POST',
      path: '/calendar/v3/freeBusy',
      response: async () => { enterAvail(); await availWait; return googleJson({
        timeMin: '2026-10-22T10:00:00Z',
        timeMax: '2026-10-22T11:00:00Z',
        calendars: { primary: { busy: [] }, 'shared-team': { busy: [] } },
      }); },
    }],
  });
  try {
    await hAvail.owner.connections.statusV2();
    const accAvail = await hAvail.owner.connections.currentAccount();
    const availBinding = calendarExecutionBindingV2Schema.parse({
      ...accAvail,
      target: null,
      sessionId: 's',
      turnId: 't',
      attemptId: 'a',
      decisionId: 'd',
      toolCallId: 'tc',
      schemaRevision: 'google-calendar.v2',
      operation: null,
      trustedNow: new Date(hAvail.f.now()).toISOString(),
      trustedTimeZone: 'Etc/UTC',
      deadlineAt: new Date(hAvail.f.now() + 20 * 60 * 1000).toISOString(),
    });
    const inFlightAvail = hAvail.owner.execution.invoke({
      binding: availBinding,
      call: {
        name: 'calendar_check_availability',
        arguments: { timeMin: '2026-10-22T10:00:00Z', timeMax: '2026-10-22T11:00:00Z', timeZone: 'Etc/UTC' },
      },
      signal: new AbortController().signal,
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    await enteredAvail;
    hAvail.f.advance(10 * 60 * 1000);
    resumeAvail();
    expect(await inFlightAvail).toMatchObject({ outcome: 'failure', failure: { category: 'policy' } });
  } finally {
    resumeAvail?.();
    await hAvail.dispose();
  }
});

it('keeps fresh storage admission on calendar_create_event and readback without rewriting uncertain writes', async () => {
  const h = await assembledReadFixture({
    steps: [
      {
        method: 'POST',
        path: '/calendar/v3/calendars/shared-team/events',
        response: () => Promise.reject(new Error('dispatched write cut short')),
      },
    ],
  });
  try {
    await h.owner.connections.statusV2();
    const account = await h.owner.connections.currentAccount();
    const resolved = await h.owner.connections.capabilityGate.resolve({
      account,
      selector: 'shared-team',
      operation: 'create',
      signal: new AbortController().signal,
      deadlineAt: new Date(h.f.now() + 20000).toISOString(),
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    if (resolved.outcome !== 'resolved') throw new Error('fixture target missing');

    const createAction = { ...CREATE_ACTION, calendarId: resolved.target.calendarId };
    const createHash = calendarActionHash(createAction);
    const op = operationRecordV2Schema.parse({
      schemaVersion: 2,
      kind: 'calendar-operation',
      userId: account.userId,
      sessionId: 's',
      turnId: 't',
      operationId: 'op_fresh',
      originatingAttemptId: 'a',
      revision: 1,
      sequence: 1,
      intentId: 'intent_fresh',
      originatingTurnId: 't',
      originatingAcceptedMessageId: 'm_1',
      connectionId: account.connectionId,
      connectionRevision: account.connectionRevision,
      googleSubjectId: account.googleSubjectId,
      calendarId: resolved.target.calendarId,
      targetRevision: resolved.target.targetRevision,
      calendarLabel: null,
      labelExpiresAt: null,
      discoveryRevision: resolved.target.discoveryRevision,
      proofRevision: 'google-calendar.multi.v2',
      schemaRevision: 'google-calendar.v2',
      requestHash: createHash,
      googleEventId: calendarEventId('op_fresh'),
      action: createAction,
      actionSources: [],
      authorization: {
        acceptedUserMessageId: 'm_1',
        acceptedTurnId: 't',
        canonicalActionHash: createHash,
        approvedAt: resolved.target.verifiedAt,
        basis: 'explicit-request',
        proposalId: null,
        conditionFingerprint: null,
      },
      deliveryRetries: 0,
      createdAt: resolved.target.verifiedAt,
      updatedAt: resolved.target.verifiedAt,
      auditExpiresAt: new Date(h.f.now() + 86400000).toISOString(),
      state: 'dispatching',
      receipt: null,
      failure: null,
    });

    const createBinding = calendarExecutionBindingV2Schema.parse({
      ...account,
      target: resolved.target,
      sessionId: 's',
      turnId: 't',
      attemptId: 'a',
      decisionId: 'd',
      toolCallId: 'tc_create',
      schemaRevision: 'google-calendar.v2',
      operation: op,
      trustedNow: new Date(h.f.now()).toISOString(),
      trustedTimeZone: 'Etc/UTC',
      deadlineAt: new Date(h.f.now() + 20000).toISOString(),
    });

    const getSpy = vi.spyOn(h.f.adapter.v2, 'get');
    // Dispatched POST cut short stays uncertain rather than being rewritten.
    const uncertainCreate = await h.owner.execution.invoke({
      binding: createBinding,
      call: { name: 'calendar_create_event', arguments: { ...CREATE_ACTION, calendarId: resolved.target.calendarId } },
      signal: new AbortController().signal,
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    expect(getSpy).toHaveBeenCalled();
    expect(h.fake.requests).toHaveLength(1);
    expect(uncertainCreate).toMatchObject({
      outcome: 'failure',
      failure: { category: 'uncertain', code: 'WRITE_OUTCOME_UNKNOWN', retry: 'readback' },
    });

    // When fresh storage read fails or denies, zero additional POST or readback HTTP fires.
    getSpy.mockRejectedValueOnce(new Error('storage failure'));
    const failedCreate = await h.owner.execution.invoke({
      binding: createBinding,
      call: { name: 'calendar_create_event', arguments: { ...CREATE_ACTION, calendarId: resolved.target.calendarId } },
      signal: new AbortController().signal,
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    expect(failedCreate).toMatchObject({ outcome: 'failure' });
    expect(h.fake.requests).toHaveLength(1);

    getSpy.mockRejectedValueOnce(new Error('storage failure'));
    const failedReadback = await h.owner.execution.readback({
      binding: createBinding,
      operation: op,
      signal: new AbortController().signal,
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    expect(failedReadback).toEqual({ outcome: 'unknown' });
    expect(h.fake.requests).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});

it('warms prepared account authority via AppService.prepareOwner without later storage get calls', async () => {
  const h = await assembledCalendarApp();
  let getSpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const userId = 'aurvin-dev-user';
    const principal: AuthPrincipal = {
      account: admittedAccount({ userId }),
      sessionId: 'sid_1',
      identity: { userId, openRouterUser: 'aurvin-dev', source: 'authenticated-session' },
    };
    await h.service.prepareOwner(principal);

    const owner = h.service.calendarFor(userId);
    const account = await owner.connections.currentAccount();
    getSpy = vi.spyOn(h.cal.p.calendarConnectionsV2, 'get').mockRejectedValue(new Error('blocked store get'));

    await h.service.prepareOwner(principal);
    expect(getSpy).not.toHaveBeenCalled();

    const prepared = await owner.runtime.connection.requireAccountCurrent(
      account,
      new AbortController().signal,
      { fresh: false },
    );
    expect(prepared.connectionId).toBe(account.connectionId);
    expect(prepared.connectionRevision).toBe(account.connectionRevision);

    const resolved = await owner.runtime.capabilities.resolve({
      account,
      selector: 'owned',
      operation: 'read',
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 20000).toISOString(),
      consumeRequest: async () => undefined,
      consumeRefreshRequest: async () => undefined,
    });
    expect(resolved).toMatchObject({ outcome: 'resolved', target: { calendarId: 'owned' } });
    expect(getSpy).not.toHaveBeenCalled();
  } finally {
    getSpy?.mockRestore();
    await h.dispose();
  }
});

it('synchronously denies prepared checks while runtime.quiesceStreams is held and preserves newer replacement status', async () => {
  const h = await assembledCalendarApp();
  try {
    const userId = 'aurvin-dev-user';
    const owner = h.service.calendarFor(userId);
    const runtime = vi.mocked(h.f.ports.runtime).mock.results.at(-1)?.value as {
      quiesceStreams: (timeoutMs: number) => Promise<{ drained: boolean }>;
    };
    const account = await owner.connections.currentAccount();

    const enteredQuiesce = deferred<void>();
    const releaseQuiesce = deferred<void>();
    vi.spyOn(runtime, 'quiesceStreams').mockImplementationOnce(async () => {
      enteredQuiesce.resolve();
      await releaseQuiesce.promise;
      return { drained: true };
    });

    const invalidating = owner.connections.rejectUnauthorizedAccount(account);
    await enteredQuiesce.promise;

    // Before quiesceStreams releases, prepared authority already denies immediately.
    await expect(
      owner.runtime.connection.requireAccountCurrent(account, new AbortController().signal, { fresh: false }),
    ).rejects.toMatchObject({ failure: { code: 'CALENDAR_EXECUTION_DENIED' } });

    releaseQuiesce.resolve();
    await invalidating;

    // Direct AppService.onCalendarInvalidated also synchronously invalidates an active prepared owner
    // before runtime.quiesceStreams yields, and ignores out-of-order status downgrades.
    const spyInvalidate = vi.spyOn(owner.connections, 'invalidateAccount');
    const statusMap = (h.service as unknown as { calendarStatusByOwner: Map<string, { connectionRevision: number | null; state: string }> }).calendarStatusByOwner;
    statusMap.set(userId, {
      ...(statusMap.get(userId)!),
      state: 'connected',
      connectionRevision: account.connectionRevision + 1,
    } as never);
    const enteredDirect = deferred<void>();
    const releaseDirect = deferred<void>();
    vi.spyOn(runtime, 'quiesceStreams').mockImplementationOnce(async () => {
      enteredDirect.resolve();
      await releaseDirect.promise;
      return { drained: true };
    });
    const invoker = (h.service as unknown as {
      onCalendarInvalidated: (acc: typeof account, reason: 'replacement') => Promise<void>;
    });
    const directInvalidating = invoker.onCalendarInvalidated(account, 'replacement');
    await enteredDirect.promise;
    expect(spyInvalidate).toHaveBeenCalledWith(account);
    releaseDirect.resolve();
    await directInvalidating;
    expect(statusMap.get(userId)).toMatchObject({
      state: 'connected',
      connectionRevision: account.connectionRevision + 1,
    });
  } finally {
    await h.dispose();
  }
});
