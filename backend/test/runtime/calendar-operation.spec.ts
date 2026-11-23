/**
 * ============================================================================
 * FILE: calendar-operation.spec.ts
 * LOCATION: backend/test/runtime/calendar-operation.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove that the single public create entry point is the only way to write a
 *    Calendar event, and that it refuses anything its evidence does not cover.
 *
 * ROLE IN PROJECT:
 *    `CalendarOperationWriter.executeCreate` verifies the accepted message, the
 *    canonical action hash and the minimal-evidence permission itself, reserves
 *    one immutable v2 operation, confirms its durable v2 event and dispatches
 *    the provider exactly once. These tests hold that contract.
 *
 * KEY COMPONENTS:
 *    - writerFor: Builds a writer bound to one durable turn.
 *    - acceptedIntent: The accepted message and the intent it authorises.
 *    - executeCreate tests: Reservation, dispatch, refusal and idempotency.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { CALENDAR_LIMITS } from '../../src/contracts/calendar-policy.js';
import { calendarInputSchemas } from '../../src/contracts/calendar-tools.js';
import { CalendarTurnLedger } from '../../src/chat-runtime/calendar-budget.js';
import {
  canonicalCalendarAction, CalendarOperationWriter,
} from '../../src/chat-runtime/calendar-operation.js';
import { isCalendarV2 } from '../../src/chat-runtime/calendar-ports.js';
import { calendarActionHash, calendarEventId } from '../../src/plugins/google-calendar/tools-validation.js';
import { key } from '../../src/persistence/records.js';
import { fixturePricing } from '../model/calendar-fixtures.js';
import { calendarFixture } from './calendar-runtime.fixture.js';

const action = calendarInputSchemas.calendar_create_event.parse({
  summary: 'Planning', start: '2026-10-22T10:00:00+00:00',
  end: '2026-10-22T11:00:00+00:00', timeZone: 'Etc/UTC',
});
const request = 'Schedule Planning on 2026-10-22 from 10:00 to 11:00 Etc/UTC.';

async function harness() {
  const h = calendarFixture();
  const ids = await h.submit(request);
  const attempt = await h.p.metadata.getAttempt(h.identity.userId, ids.sessionId, ids.attemptId);
  const message = await h.p.messages.get(h.identity.userId, ids.sessionId, attempt!.causal.userMessageId);
  const calendar = h.runtime.d.calendar;
  if (!calendar || !isCalendarV2(calendar)) throw new Error('expected the v2 calendar runtime');
  const account = await calendar.connection.currentAccount();
  const resolved = await calendar.capabilities.resolve({
    account, selector: 'team@example.test', operation: 'create',
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.parse(attempt!.createdAt) + DEFAULT_BUDGETS.totalRunTimeoutMs).toISOString(),
    consumeRequest: async () => undefined, consumeRefreshRequest: async () => undefined,
  });
  if (resolved.outcome !== 'resolved') throw new Error('expected a resolved target');
  const target = resolved.target;
  const canonical = canonicalCalendarAction(action, target);
  const requestHash = calendarActionHash(canonical);
  const binding = await calendar.connection.currentBinding();
  const createdAt = attempt!.createdAt;
  const deadlineAt = new Date(Date.parse(createdAt) + DEFAULT_BUDGETS.totalRunTimeoutMs).toISOString();
  const ledger = new CalendarTurnLedger({
    accounting: h.p.calendarAccounting,
    identity: {
      userId: h.identity.userId, sessionId: ids.sessionId, turnId: ids.turnId,
      attemptId: ids.attemptId, openRouterUser: h.identity.userId, createdAt, deadlineAt,
    },
    limits: CALENDAR_LIMITS, write: fn => fn(), clock: Date.now,
    modelId: 'fixture/model', pricing: fixturePricing, configRevision: 1, connection: binding,
    maxOutputTokens: DEFAULT_BUDGETS.maxOutputTokens, processingPolicyId: 'fixture-policy',
    job: { check() {}, wait: async <T>(p: Promise<T>) => p, signal: new AbortController().signal },
    fence: async () => true, requireCurrent: async () => {},
  });
  await ledger.ensureBudget();
  const writer = new CalendarOperationWriter({
    operations: h.p.calendarOperations, operationsV2: h.p.calendarOperationsV2,
    execution: calendar.execution, executionV2: calendar.execution,
    write: fn => fn(), ledger, identity: {
      userId: h.identity.userId, sessionId: ids.sessionId, turnId: ids.turnId, attemptId: ids.attemptId,
    }, binding, clock: Date.now,
    job: { check() {}, signal: new AbortController().signal },
    fence: async () => true, requireCurrent: async () => {},
    permission: { content: 'retained', minimalEvidenceAllowed: true, policyId: 'fixture-policy' },
    trustedTimeZone: 'Etc/UTC',
  });
  return {
    h, ids, writer,
    intent: {
      intentId: key('calendar-intent', h.identity.userId, ids.sessionId, message!.messageId),
      originatingTurnId: message!.turnId,
      originatingAcceptedMessageId: message!.messageId,
      originatingAttemptId: attempt!.attemptId,
    },
    accepted: { message: message!, turnId: ids.turnId },
    account, target, canonical, requestHash,
    operationId: key('calendar-operation', h.identity.userId, ids.sessionId,
      key('calendar-intent', h.identity.userId, ids.sessionId, message!.messageId)),
  };
}

describe('Calendar create entry point', () => {
  it('reserves one operation, confirms its v2 event and dispatches exactly once', async () => {
    const x = await harness();
    try {
      const outcome = await x.writer.executeCreate({
        intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null, action: x.canonical, requestHash: x.requestHash,
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
      });
      expect(outcome.outcome).toBe('created');
      const saved = await x.h.p.calendarOperationsV2.getByIntent(x.h.identity.userId, x.ids.sessionId, x.intent.intentId);
      expect(saved).toMatchObject({
        state: 'succeeded', deliveryRetries: 0, calendarId: x.target.calendarId,
        authorization: { basis: 'explicit-request', acceptedTurnId: x.ids.turnId },
      });
      expect(saved?.googleEventId).toBe(calendarEventId(x.operationId));
      expect(x.h.effects.filter(e => e.kind === 'create')).toHaveLength(1);
      // The durable v2 event is written, so the confirmed transition is readable.
      const events = await x.h.p.calendarOperationsV2.listEventsV2({
        userId: x.h.identity.userId, sessionId: x.ids.sessionId, operationId: x.operationId,
      });
      expect(events.map(event => event.state)).toContain('dispatching');
      expect(events.map(event => event.state)).toContain('succeeded');
      const budget = await x.h.p.calendarAccountingV2.getBudget(x.h.identity.userId, x.ids.sessionId, x.ids.turnId);
      expect(budget).toMatchObject({ logicalTools: 1, creates: 1, calendarRequests: 1 });
    } finally { await x.h.dispose(); }
  });

  it('refuses a create whose accepted message does not authorise it', async () => {
    const x = await harness();
    try {
      await expect(x.writer.executeCreate({
        intent: { ...x.intent, originatingAcceptedMessageId: 'msg-other' },
        account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null, action: x.canonical, requestHash: x.requestHash,
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
      })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(x.h.effects.filter(e => e.kind === 'create')).toHaveLength(0);
    } finally { await x.h.dispose(); }
  });

  it('refuses a create whose canonical action hash does not match the approval', async () => {
    const x = await harness();
    try {
      await expect(x.writer.executeCreate({
        intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null,
        action: { ...x.canonical, summary: 'Other' },
        requestHash: x.requestHash,
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
      })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(x.h.effects.filter(e => e.kind === 'create')).toHaveLength(0);
    } finally { await x.h.dispose(); }
  });

  it('never dispatches again for an operation that already exists', async () => {
    const x = await harness();
    try {
      const first = await x.writer.executeCreate({
        intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null, action: x.canonical, requestHash: x.requestHash,
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
      });
      expect(first.outcome).toBe('created');
      const second = await x.writer.executeCreate({
        intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null, action: x.canonical, requestHash: x.requestHash,
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
      });
      expect(second.outcome).toBe('existing');
      expect(x.h.effects.filter(e => e.kind === 'create')).toHaveLength(1);
      const budget = await x.h.p.calendarAccountingV2.getBudget(x.h.identity.userId, x.ids.sessionId, x.ids.turnId);
      expect(budget).toMatchObject({ logicalTools: 1, creates: 1 });
    } finally { await x.h.dispose(); }
  });

  it('rechecks capability and preflight when resuming an acknowledged planned operation, and refuses when changed or conflicted', async () => {
    const x = await harness();
    try {
      // Simulate crash right after planned reservation (before dispatching).
      vi.spyOn(x.h.p.calendarOperationsV2, 'compareAndSwap').mockRejectedValueOnce(new Error('Crash before dispatching'));
      await expect(x.writer.executeCreate({
        intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null, action: x.canonical, requestHash: x.requestHash,
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
        capability: async () => ({ outcome: 'ok', target: x.target }),
        preflight: async () => null,
      })).rejects.toThrow('Crash before dispatching');
      vi.restoreAllMocks();

      // Case A: Capability/target changed before resume -> refuses POST and clarifies.
      let capCalls = 0;
      const movedTarget = await x.writer.executeCreate({
        intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null, action: x.canonical, requestHash: x.requestHash,
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
        capability: async () => { capCalls++; return { outcome: 'ok', target: { ...x.target, targetRevision: x.target.targetRevision + 1 } }; },
        preflight: async () => null,
      });
      expect(capCalls).toBe(1);
      expect(movedTarget.outcome).toBe('clarify');
      expect(x.h.effects.filter(e => e.kind === 'create')).toHaveLength(0);

      // Case B: Preflight conflicts before resume -> refuses POST and clarifies.
      let preflightCalls = 0;
      const conflicted = await x.writer.executeCreate({
        intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null, action: x.canonical, requestHash: x.requestHash,
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
        capability: async () => ({ outcome: 'ok', target: x.target }),
        preflight: async () => {
          preflightCalls++;
          return {
            availabilityRevision: 2,
            conflict: 'conflict',
            busy: [{ start: x.canonical.start, end: x.canonical.end }],
            unreadable: [],
            limitations: [],
            uncoveredGaps: [],
          };
        },
        clarify: async () => 'You already have a meeting at that time.',
      });
      expect(preflightCalls).toBe(1);
      expect(conflicted.outcome).toBe('clarify');
      expect(x.h.effects.filter(e => e.kind === 'create')).toHaveLength(0);

      // Case C: Valid capability and clean preflight -> revalidates and dispatches once.
      let okCap = 0;
      let okPre = 0;
      const created = await x.writer.executeCreate({
        intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null, action: x.canonical, requestHash: x.requestHash,
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
        capability: async () => { okCap++; return { outcome: 'ok', target: x.target }; },
        preflight: async () => { okPre++; return null; },
      });
      expect(okCap).toBe(1);
      expect(okPre).toBe(1);
      expect(created.outcome).toBe('created');
      expect(x.h.effects.filter(e => e.kind === 'create')).toHaveLength(1);
    } finally { vi.restoreAllMocks(); await x.h.dispose(); }
  });

  it('refuses a changed action for an intent reserved before the dispatching CAS', async () => {
    const x = await harness();
    try {
      // Crash immediately after the planned reservation, before dispatching.
      vi.spyOn(x.h.p.calendarOperationsV2, 'compareAndSwap').mockRejectedValueOnce(new Error('Crash before dispatching'));
      await expect(x.writer.executeCreate({
        intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null, action: x.canonical, requestHash: x.requestHash,
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
      })).rejects.toThrow('Crash before dispatching');
      vi.restoreAllMocks();
      const reserved = await x.h.p.calendarOperationsV2.getByIntent(x.h.identity.userId, x.ids.sessionId, x.intent.intentId);
      expect(reserved).toMatchObject({ state: 'planned', requestHash: x.requestHash });

      // The same intent now asks for a different event. The immutable approval
      // is never rewritten; the duplicate identity is refused with no POST.
      const changed = canonicalCalendarAction({ ...action, summary: 'Other' }, x.target);
      await expect(x.writer.executeCreate({
        intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null, action: changed,
        requestHash: calendarActionHash(changed),
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
      })).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
      expect(x.h.effects.filter(e => e.kind === 'create')).toHaveLength(0);
      expect(await x.h.p.calendarOperationsV2.getByIntent(x.h.identity.userId, x.ids.sessionId, x.intent.intentId))
        .toMatchObject({ state: 'planned', requestHash: x.requestHash });
    } finally { vi.restoreAllMocks(); await x.h.dispose(); }
  });

  it('refuses duplicate dispatch or reservation when a concurrent attempt returns dispatching or unknown from reserveByIntent', async () => {
    const x = await harness();
    try {
      const origReserve = x.h.p.calendarOperationsV2.reserveByIntent.bind(x.h.p.calendarOperationsV2);
      const appendSpy = vi.spyOn(x.h.p.calendarOperationsV2, 'appendEventV2');
      let intercept = true;
      vi.spyOn(x.h.p.calendarOperationsV2, 'reserveByIntent').mockImplementation(async req => {
        const res = await origReserve(req);
        if (intercept && res.outcome === 'created') {
          intercept = false;
          return { outcome: 'existing', operation: { ...res.operation, state: 'dispatching' } };
        }
        return res;
      });
      const outcome = await x.writer.executeCreate({
        intent: x.intent, account: x.account, target: x.target, accepted: x.accepted,
        proposal: null, consumption: null, action: x.canonical, requestHash: x.requestHash,
        operationId: x.operationId, decisionId: 'decision-create', toolCallId: 'call-create',
        createdAt: '2026-10-24T10:00:00.000Z', auditExpiresAt: '2026-11-23T10:00:00.000Z',
      });
      expect(outcome.outcome).toBe('unknown');
      expect(appendSpy).not.toHaveBeenCalled();
      expect(x.h.effects.filter(e => e.kind === 'create')).toHaveLength(0);
    } finally { vi.restoreAllMocks(); await x.h.dispose(); }
  });
});
