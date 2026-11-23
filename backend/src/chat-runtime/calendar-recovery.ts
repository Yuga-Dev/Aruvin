/**
 * ============================================================================
 * FILE: calendar-recovery.ts
 * LOCATION: backend/src/chat-runtime/calendar-recovery.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Discover and reconcile interrupted Calendar operations and pre-operation
 *    authorizations without model replay or graph-dependent blind spots.
 *
 * ROLE IN PROJECT:
 *    Owns checkpointless unresolved operation discovery, readback-only v1/v2
 *    reconciliation, missing transition event repair, and fresh-gated
 *    recovery of planned operations and confirmed proposal consumptions.
 *
 * KEY COMPONENTS:
 *    - pendingCalendarOperation: Bounded unresolved/publication-recovery lookup.
 *    - reconcileCalendarOperationV2: Readback reconciliation with lease or barrier.
 *    - reconcilePlannedCalendarOperationV2: Fresh-checked planned dispatch/repair.
 *    - reconcileConsumedProposalWithoutOperation: Exact consumption repair/interruption.
 * ============================================================================
 */

import type { z } from 'zod';
import type { PersistenceBundle } from '../persistence/persistence.js';
import type { ExecutionLease } from '../contracts/repositories.js';
import type { AttemptRecord } from '../contracts/attempt.js';
import type { CalendarConnectionBinding } from '../contracts/calendar-connections.js';
import type { CalendarExecutionPort, CalendarExecutionPortV2, CalendarOperation, CalendarOperationV2 } from '../contracts/calendar-operations.js';
import type { CalendarAccountBinding, CalendarConnectionRecordV2, CalendarResolvedTarget } from '../contracts/calendar-discovery.js';
import {
  type CalendarCapabilityGate,
  type CalendarProposalConsumption,
  type CalendarProposalRecord,
} from '../contracts/calendar-authority.js';
import { calendarAvailabilityFingerprint } from '../contracts/calendar-availability.js';
import type { CalendarTokenPricing } from '../contracts/calendar-accounting.js';
import { CALENDAR_LIMITS, type CalendarLimits } from '../contracts/calendar-policy.js';
import { decodeCalendar, proposalConsumptionKey, proposalConsumptionRecordSchema } from '../persistence/calendar-records.js';
import { key } from '../persistence/records.js';
import { AppError } from '../platform/errors/app-error.js';
import { CalendarTurnLedger } from './calendar-budget.js';
import {
  calendarActionHash,
  CalendarOperationWriter,
  canonicalCalendarAction,
  repairOperationEventV2,
  transitionOperation,
  transitionOperationV2,
  type CalendarOperationWriterOptions,
} from './calendar-operation.js';
import {
  describeAvailabilityCondition,
  requiresAcceptance,
  runCalendarPreflight,
  sameApprovedCondition,
} from './calendar-preflight.js';
import { asCalendarAccountingPort, type CalendarSeal } from './calendar-ports.js';
import { attemptsFor } from './history.js';
import type { Work } from './work.js';

type CalendarProposalConsumptionWrapper = z.infer<typeof proposalConsumptionRecordSchema>;

export type CalendarContinuation =
  | { kind: 'publish'; seal: CalendarSeal | null }
  | { kind: 'reuse-decision'; decisionId: string }
  | { kind: 'reuse-result'; decisionId: string; toolCallId: string }
  | { kind: 'repair-consumption'; intentId: string }
  | { kind: 'dispatch-planned'; operationId: string }
  | { kind: 'reconcile-operation'; operationId: string }
  | { kind: 'fresh-dispatch'; reason: 'initial' | 'continuation' | 'schema-repair' }
  | { kind: 'interrupt'; code: 'EVIDENCE_MISSING' | 'EVIDENCE_EXPIRED' | 'INFERENCE_OUTCOME_UNKNOWN' |
      'CONNECTION_CHANGED' | 'TURN_DEADLINE_EXCEEDED' };

/**
 * The reconciliation binding is the connection and target revision the write was
 * dispatched on, never the live one. A missing, revoked, replaced or
 * unconfigured Calendar therefore fails the readback closed inside the gate and
 * leaves the operation unknown, instead of aborting the ordinary text recovery
 * that asked for the reconciliation.
 */
function bindingOf(operation: CalendarOperation): CalendarConnectionBinding {
  return {
    userId: operation.userId, connectionId: operation.connectionId,
    connectionRevision: operation.connectionRevision, googleSubjectId: operation.googleSubjectId,
    calendarId: operation.calendarId, targetRevision: operation.targetRevision,
  };
}

/**
 * The v2 readback is pinned to the ORIGINAL operation: the original event id,
 * the original calendar, the original connection revision and the original
 * target revision. Current names are not durable receipt evidence.
 */
function bindingOfV2(operation: CalendarOperationV2): CalendarConnectionBinding {
  return {
    userId: operation.userId, connectionId: operation.connectionId,
    connectionRevision: operation.connectionRevision, googleSubjectId: operation.googleSubjectId,
    calendarId: operation.calendarId, targetRevision: operation.targetRevision,
  };
}

export async function reconcileCalendarOperation(input: {
  persistence: PersistenceBundle;
  lease: ExecutionLease;
  job: Work;
  userId: string;
  sessionId: string;
  execution: CalendarExecutionPort;
  trustedTimeZone: string;
  now: () => string;
}): Promise<void> {
  const session = await input.persistence.sessions.get(input.userId, input.sessionId);
  const turnId = session?.latestTurnId;
  if (!turnId) return;
  const operation = await input.persistence.calendarOperations.getByTurn(input.userId, input.sessionId, turnId);
  if (!operation) return;
  if (operation.state !== 'dispatching' && operation.state !== 'unknown') return;
  const attempts = await attemptsFor(input.persistence, input.userId, input.sessionId);
  const attempt = attempts.filter(item => item.turnId === turnId).at(-1);
  if (!attempt) return;
  const budget = await input.persistence.calendarAccounting.getBudget(input.userId, input.sessionId, turnId);
  const deadlineAt = budget?.deadlineAt ?? operation.auditExpiresAt;
  const binding = bindingOf(operation);
  // A readback that cannot be completed is an unknown external outcome. It is
  // never a success and never a reason to fail the surrounding text recovery.
  const outcome = await input.execution.readback({
    binding: {
      ...binding, sessionId: input.sessionId, turnId, attemptId: attempt.attemptId,
      decisionId: attempt.attemptId, toolCallId: operation.operationId, schemaRevision: 'google-calendar.v1',
      operation, trustedNow: input.now(), trustedTimeZone: input.trustedTimeZone, deadlineAt,
    },
    operation, signal: input.job.signal,
    consumeRequest: async () => undefined,
    consumeRefreshRequest: async () => undefined,
  }).catch(() => ({ outcome: 'unknown' as const }));
  if (outcome.outcome === 'matched') {
    const options: CalendarOperationWriterOptions = {
      operations: input.persistence.calendarOperations, execution: input.execution,
      write: action => input.job.wait(input.persistence.owner.run(input.lease, action), 15000),
      ledger: null as never, identity: {
        userId: input.userId, sessionId: input.sessionId, turnId, attemptId: attempt.attemptId,
      }, binding, clock: Date.now, job: input.job,
      fence: () => input.persistence.owner.fence(input.lease),
      requireCurrent: async () => undefined,
      permission: { content: 'retained', minimalEvidenceAllowed: true, policyId: 'fixture-policy' },
      trustedTimeZone: input.trustedTimeZone,
    };
    await transitionOperation(options, operation, { state: 'succeeded', receipt: outcome.receipt });
    return;
  }
  if (operation.state === 'dispatching') {
    const options: CalendarOperationWriterOptions = {
      operations: input.persistence.calendarOperations, execution: input.execution,
      write: action => input.job.wait(input.persistence.owner.run(input.lease, action), 15000),
      ledger: null as never, identity: {
        userId: input.userId, sessionId: input.sessionId, turnId, attemptId: attempt.attemptId,
      }, binding, clock: Date.now, job: input.job,
      fence: () => input.persistence.owner.fence(input.lease),
      requireCurrent: async () => undefined,
      permission: { content: 'retained', minimalEvidenceAllowed: true, policyId: 'fixture-policy' },
      trustedTimeZone: input.trustedTimeZone,
    };
    await transitionOperation(options, operation, { state: 'unknown' });
    if (outcome.outcome === 'absent' || outcome.outcome === 'mismatch' || outcome.outcome === 'unknown') {
      await input.persistence.calendarOperations.putReconciliation({
        schemaVersion: 1, kind: 'calendar-operation-reconciliation',
        userId: input.userId, sessionId: input.sessionId, turnId, operationId: operation.operationId,
        eventId: operation.googleEventId, operationRevision: operation.revision,
        outcome: outcome.outcome === 'absent' ? 'absent' : outcome.outcome === 'mismatch' ? 'mismatch' : 'unknown',
        connectionRevision: operation.connectionRevision, targetRevision: operation.targetRevision,
        checkedAt: input.now(),
      });
    }
  }
}

/**
 * The pending Calendar operation of a session. It is derived from the current
 * graph's own operation and intent references plus a scoped store lookup, never
 * from the session's latest turn alone: an unrelated later text reply must not
 * hide an earlier unknown effect.
 *
 * The lookup is bounded: it reads the saved cursor and seal of the thread and
 * at most three scoped operation records.
 */
export async function pendingCalendarOperation(input: {
  persistence: PersistenceBundle;
  userId: string;
  sessionId: string;
  values: Record<string, unknown>;
  latestTurnId: string | null;
  acceptedTurnIds?: readonly string[];
}): Promise<CalendarOperationV2 | CalendarOperation | null> {
  const store = input.persistence.calendarOperationsV2;
  // A deployment without the Calendar stores has no pending Calendar work.
  if (!store) return null;

  const unresolved = await store.listUnresolvedBySession({
    userId: input.userId,
    sessionId: input.sessionId,
    limit: 2,
  });
  if (unresolved.overflow || unresolved.operations.length > 1) {
    throw new AppError('NOT_READY', 'Multiple unresolved Calendar operations require recovery repair.');
  }
  if (unresolved.operations.length === 1) {
    const only = unresolved.operations[0]!;
    if (only.userId !== input.userId || only.sessionId !== input.sessionId) {
      throw new AppError('NOT_READY', 'Calendar operation scope mismatch.');
    }
    return only;
  }

  const cursor = input.values.calendarCursor as { version?: number; pendingIntentId?: string | null;
    pendingOperationId?: string | null } | undefined;
  const seal = input.values.calendarSeal as { operationId?: string | null;
    input?: { turn?: { turnId?: string } } } | undefined;
  const sealTurnId = seal?.input?.turn?.turnId ?? null;
  const turnIds = new Set<string>(
    [sealTurnId, input.latestTurnId, ...(input.acceptedTurnIds ?? [])]
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const intentIds = new Set<string>(
    [cursor?.pendingIntentId]
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );

  const byOp = new Map<string, CalendarOperation | CalendarOperationV2>();
  const collect = (candidate: CalendarOperation | CalendarOperationV2 | null) => {
    if (!candidate) return;
    if (candidate.userId !== input.userId || candidate.sessionId !== input.sessionId) {
      throw new AppError('NOT_READY', 'Calendar operation scope mismatch.');
    }
    if (!byOp.has(candidate.operationId)) byOp.set(candidate.operationId, candidate);
  };
  for (const intentId of intentIds) {
    collect(await store.getByIntent(input.userId, input.sessionId, intentId));
  }
  for (const turnId of turnIds) {
    collect(await store.getByTurn(input.userId, input.sessionId, turnId));
  }

  for (const candidate of byOp.values()) {
    if (candidate.state === 'planned' || candidate.state === 'dispatching' || candidate.state === 'unknown') {
      return candidate;
    }
  }
  for (const candidate of byOp.values()) {
    if (candidate.schemaVersion !== 2 || candidate.state !== 'succeeded') continue;
    const referencedBySealOrAttempt = Boolean(
      (seal?.operationId && seal.operationId === candidate.operationId)
      || input.acceptedTurnIds?.includes(candidate.turnId),
    );
    if (referencedBySealOrAttempt) return candidate;
    const events = await store.listEventsV2({
      userId: candidate.userId, sessionId: candidate.sessionId, operationId: candidate.operationId,
    });
    const hasConfirmedEvent = events.some(
      event => event.state === 'succeeded' && event.sequence === candidate.sequence && event.revision === candidate.revision,
    );
    if (!hasConfirmedEvent) return candidate;
  }
  return null;
}

export function classifyCalendarContinuation(input: {
  sealed: boolean; decisionId: string | null; toolCallId: string | null; operationId: string | null;
}): CalendarContinuation {
  if (input.sealed) throw new AppError('NOT_READY', 'Calendar continuation needs a seal payload.');
  if (input.operationId) return { kind: 'reconcile-operation', operationId: input.operationId };
  if (input.decisionId && input.toolCallId) {
    return { kind: 'reuse-result', decisionId: input.decisionId, toolCallId: input.toolCallId };
  }
  if (input.decisionId) return { kind: 'reuse-decision', decisionId: input.decisionId };
  return { kind: 'interrupt', code: 'EVIDENCE_MISSING' };
}

/**
 * The v2 continuation classifier. It is derived from the durable evidence of
 * the interrupted turn, never from the free-form history:
 *
 * - a decision was saved and no tool effect happened: reuse that exact
 *   decision under the original remaining budget;
 * - a complete retained result was saved: rebuild the group without invoking
 *   the tool or the model again;
 * - a planned operation: the same complete authority plus a fresh final
 *   capability and preflight are required before the first dispatch, otherwise
 *   the turn interrupts or clarifies without changing the immutable
 *   authorization;
 * - a dispatching or unknown operation: only the original readback is allowed;
 * - a succeeded operation: the receipt, the group and the publication;
 * - a sealed turn: the publication only.
 *
 * A model dispatch without a saved terminal decision is an inference outcome
 * that is unknown. It interrupts and is never regenerated automatically.
 */
export function classifyCalendarContinuationV2(input: {
  sealed: boolean;
  decisionId: string | null;
  toolCallId: string | null;
  intentId: string | null;
  operationId: string | null;
  operationState: string | null;
  resultRetained: boolean;
  resultExpired: boolean;
  proposalConsumed: boolean;
  consumptionConfirmed: boolean;
  dispatchedWithoutDecision: boolean;
  deadlinePassed: boolean;
}): CalendarContinuation {
  if (input.sealed) throw new AppError('NOT_READY', 'Calendar continuation needs a seal payload.');
  if (input.operationId) {
    if (input.operationState === 'succeeded') return { kind: 'publish', seal: null };
    if (input.operationState === 'planned') return { kind: 'dispatch-planned', operationId: input.operationId };
    return { kind: 'reconcile-operation', operationId: input.operationId };
  }
  if (input.resultRetained && input.decisionId && input.toolCallId) {
    return { kind: 'reuse-result', decisionId: input.decisionId, toolCallId: input.toolCallId };
  }
  if (input.resultExpired) return { kind: 'interrupt', code: 'EVIDENCE_EXPIRED' };
  // A model dispatch without a saved terminal decision is an inference outcome
  // that is unknown. It interrupts and is never regenerated automatically.
  if (input.dispatchedWithoutDecision) return { kind: 'interrupt', code: 'INFERENCE_OUTCOME_UNKNOWN' };
  if (input.decisionId) return { kind: 'reuse-decision', decisionId: input.decisionId };
  // A consumed proposal with no operation is repaired from the exact
  // consumption, and only while that consumption is confirmed.
  if (input.proposalConsumed && input.consumptionConfirmed && input.intentId) {
    return { kind: 'repair-consumption', intentId: input.intentId };
  }
  if (input.deadlinePassed) return { kind: 'interrupt', code: 'TURN_DEADLINE_EXCEEDED' };
  return { kind: 'interrupt', code: 'EVIDENCE_MISSING' };
}

/**
 * Reconciles one pending v2 operation with a pinned, charged readback of the
 * original event. The readback uses the original accepted turn's persisted
 * budget and deadline, resolves no new default and never binds a replacement
 * account. An absent, mismatched or unknown outcome is never a success: the
 * operation stays unknown and is never retried automatically.
 */
export type RecoveryBarrier = Pick<CalendarOperationWriterOptions, 'write' | 'fence'>;

function resolveBarrier(
  input: { persistence: PersistenceBundle; lease?: ExecutionLease; barrier?: RecoveryBarrier; job: Work },
): RecoveryBarrier {
  if (input.barrier) return input.barrier;
  const lease = input.lease;
  if (!lease) throw new AppError('NOT_READY', 'Calendar recovery requires a lease or barrier.');
  const timeoutMs = input.persistence.metadata.budgets.persistenceTimeoutMs;
  return {
    write: action => input.job.wait(input.persistence.owner.run(lease, action), timeoutMs),
    fence: () => input.persistence.owner.fence(lease),
  };
}

export async function reconcileCalendarOperationV2(input: {
  persistence: PersistenceBundle;
  lease?: ExecutionLease;
  barrier?: RecoveryBarrier;
  job: Work;
  userId: string;
  sessionId: string;
  execution: CalendarExecutionPortV2;
  capabilities: CalendarCapabilityGate;
  operation: CalendarOperationV2;
  attemptId: string;
  trustedTimeZone: string;
  now: () => string;
}): Promise<void> {
  const operation = input.operation;
  const barrier = resolveBarrier(input);
  if (operation.state === 'succeeded') {
    const store = input.persistence.calendarOperationsV2;
    if (store && operation.receipt) {
      await repairOperationEventV2({
        store,
        metadata: input.persistence.metadata,
        write: barrier.write,
        operation,
        attemptId: input.attemptId,
      });
    }
    return;
  }
  if (operation.state !== 'dispatching' && operation.state !== 'unknown') return;
  let currentBudget = await input.persistence.calendarAccountingV2.getBudget(
    input.userId, input.sessionId, operation.turnId);
  const deadlineAt = currentBudget?.deadlineAt ?? operation.auditExpiresAt;
  // A later recovery job never extends the deadline or resets a counter.
  if (Date.parse(deadlineAt) <= Date.parse(input.now())) {
    await markOperationUnknownV2(input, barrier, operation);
    return;
  }
  const binding = bindingOfV2(operation);
  // The target is rebuilt from the ORIGINAL operation and a freshly verified
  // EXPLICIT original calendar id under the same subject and connection. No
  // default is resolved and no replacement account is bound.
  const account: CalendarAccountBinding = {
    userId: operation.userId, connectionId: operation.connectionId,
    connectionRevision: operation.connectionRevision, googleSubjectId: operation.googleSubjectId,
  };
  const charge = async (counter: 'calendarRequests' | 'refreshRequests') => {
    input.job.check();
    if (!await barrier.fence()) throw new AppError('INTERRUPTED', 'Execution ownership was lost.');
    const current = currentBudget ?? await input.persistence.calendarAccountingV2.getBudget(
      input.userId, input.sessionId, operation.turnId);
    if (!current || Date.parse(current.deadlineAt) <= Date.parse(input.now())) {
      throw new AppError('NOT_READY', 'Calendar budget is unavailable.');
    }
    const next = {
      ...current, revision: current.revision + 1, [counter]: current[counter] + 1,
    };
    const outcome = await barrier.write(() =>
      input.persistence.calendarAccountingV2.compareAndSwapBudget(current.revision, next));
    if (outcome !== 'confirmed') {
      currentBudget = null;
      throw new AppError('PERSISTENCE_ERROR', 'Calendar request admission could not be confirmed.');
    }
    currentBudget = next;
  };
  const resolved = await input.capabilities.resolve({
    account, selector: operation.calendarId, operation: 'read',
    signal: input.job.signal, deadlineAt,
    consumeRequest: () => charge('calendarRequests'),
    consumeRefreshRequest: () => charge('refreshRequests'),
  }).catch(() => null);
  if (!resolved || resolved.outcome !== 'resolved') {
    await markOperationUnknownV2(input, barrier, operation);
    return;
  }
  const target = resolved.target;
  const outcome = await input.execution.readback({
    binding: {
      ...account, target, sessionId: input.sessionId, turnId: operation.turnId,
      attemptId: input.attemptId, decisionId: input.attemptId, toolCallId: operation.operationId,
      schemaRevision: 'google-calendar.v2', operation, trustedNow: input.now(),
      trustedTimeZone: input.trustedTimeZone, deadlineAt,
    },
    operation, signal: input.job.signal,
    // The readback is a real provider request and it is charged against the
    // original accepted turn's budget.
    consumeRequest: () => charge('calendarRequests'),
    consumeRefreshRequest: () => charge('refreshRequests'),
  }).catch(() => ({ outcome: 'unknown' as const }));
  if (outcome.outcome === 'matched') {
    const options = writerOptions(input, barrier, operation, binding);
    await transitionOperationV2(options, operation, { state: 'succeeded', receipt: outcome.receipt });
    return;
  }
  await markOperationUnknownV2(input, barrier, operation);
}

/**
 * Records the bounded reconciliation outcome of an operation whose provider
 * outcome cannot be known. It never grants replay permission.
 */
async function markOperationUnknownV2(
  input: Parameters<typeof reconcileCalendarOperationV2>[0],
  barrier: RecoveryBarrier,
  operation: CalendarOperationV2,
): Promise<void> {
  if (operation.state === 'unknown') return;
  const binding = bindingOfV2(operation);
  const options = writerOptions(input, barrier, operation, binding);
  await transitionOperationV2(options, operation, { state: 'unknown' });
}

function writerOptions(
  input: Parameters<typeof reconcileCalendarOperationV2>[0],
  barrier: RecoveryBarrier,
  operation: CalendarOperationV2,
  binding: CalendarConnectionBinding,
  attemptId = input.attemptId,
): CalendarOperationWriterOptions {
  return {
    operations: input.persistence.calendarOperations,
    operationsV2: input.persistence.calendarOperationsV2,
    executionV2: input.execution,
    write: barrier.write,
    ledger: null as never,
    identity: {
      userId: input.userId, sessionId: input.sessionId,
      turnId: operation.turnId, attemptId,
    },
    binding, clock: () => Date.parse(input.now()), job: input.job,
    fence: barrier.fence,
    requireCurrent: async () => undefined,
    permission: { content: 'retained', minimalEvidenceAllowed: true, policyId: 'fixture-policy' },
    trustedTimeZone: input.trustedTimeZone,
  };
}

export type PlannedRecoveryInput = {
  persistence: PersistenceBundle;
  lease?: ExecutionLease;
  barrier?: RecoveryBarrier;
  job: Work;
  userId: string;
  sessionId: string;
  execution: CalendarExecutionPortV2;
  capabilities: CalendarCapabilityGate;
  connection: {
    requireAccountCurrent(account: CalendarAccountBinding, signal: AbortSignal): Promise<CalendarConnectionRecordV2>;
  };
  operation: CalendarOperationV2;
  attempt: AttemptRecord;
  trustedTimeZone: string;
  permission: { content: 'volatile' | 'retained'; minimalEvidenceAllowed: boolean; policyId: string };
  auditDeadlineAt?: string;
  limits?: CalendarLimits;
  pricing?: CalendarTokenPricing;
  configRevision?: number;
  openRouterUser?: string;
  now: () => string;
};

export type PlannedRecoveryResult =
  | { outcome: 'created' | 'existing'; operation: CalendarOperationV2 }
  | { outcome: 'clarify' | 'failed' | 'unknown' | 'interrupted'; message: string; operation?: CalendarOperationV2 };

async function verifiedConsumptionAuthority(input: {
  persistence: PersistenceBundle;
  userId: string;
  sessionId: string;
  proposalId: string;
  acceptedTurnId: string;
  acceptedMessageId: string;
  expectedIntentId: string | null;
  expectedOperationId: string | null;
  expectedHash: string | null;
  nowMs: number;
}): Promise<{
  ok: true;
  proposal: CalendarProposalRecord | null;
  consumption: CalendarProposalConsumption;
  replyConnectionId: string;
  replyConnectionRevision: number;
  replyGoogleSubjectId: string;
  choiceCalendarId: string | null;
} | { ok: false; message: string }> {
  const store = input.persistence.owner.store;
  if (store) {
    const rawWrapper = await store.raw('metadata', {
      _id: proposalConsumptionKey(input.userId, input.sessionId, input.proposalId),
      userId: input.userId,
    });
    let wrapper: CalendarProposalConsumptionWrapper | null = null;
    try {
      wrapper = rawWrapper ? decodeCalendar(proposalConsumptionRecordSchema, rawWrapper) : null;
    } catch {
      wrapper = null;
    }
    if (!wrapper) {
      return { ok: false, message: 'The scheduling approval proof could not be verified.' };
    }
  }
  const auth = await input.persistence.calendarProposals.getAuthority(
    input.userId, input.sessionId, input.proposalId,
  ).catch(() => null);
  if (!auth || auth.state !== 'consumed') {
    return { ok: false, message: 'The scheduling approval is no longer active.' };
  }
  if (Date.parse(auth.authorityExpiresAt) <= input.nowMs) {
    return { ok: false, message: 'The scheduling confirmation has expired.' };
  }
  if (auth.consumption.acceptedTurnId !== input.acceptedTurnId
    || auth.consumption.acceptedMessageId !== input.acceptedMessageId
    || (input.expectedIntentId && auth.consumption.intentId !== input.expectedIntentId)
    || (input.expectedOperationId && auth.consumption.operationId !== input.expectedOperationId)
    || (input.expectedHash && auth.consumption.canonicalActionHash !== input.expectedHash)) {
    return { ok: false, message: 'The scheduling approval does not match the saved request.' };
  }
  return {
    ok: true,
    proposal: auth.proposal,
    consumption: auth.consumption,
    replyConnectionId: auth.reply.connectionId,
    replyConnectionRevision: auth.reply.connectionRevision,
    replyGoogleSubjectId: auth.reply.googleSubjectId,
    choiceCalendarId: auth.reply.choiceCalendarId ?? null,
  };
}

function buildRecoveryLedger(input: {
  persistence: PersistenceBundle;
  barrier: RecoveryBarrier;
  job: Work;
  userId: string;
  sessionId: string;
  turnId: string;
  attempt: AttemptRecord;
  account: CalendarAccountBinding;
  budget: { createdAt: string; deadlineAt: string };
  permission: { policyId: string };
  connection: PlannedRecoveryInput['connection'];
  limits?: CalendarLimits;
  pricing?: CalendarTokenPricing;
  configRevision?: number;
  openRouterUser?: string;
  now: () => string;
}): CalendarTurnLedger {
  const nowIso = input.now();
  const pricing: CalendarTokenPricing = input.pricing ?? {
    version: 'recovery',
    source: 'recovery',
    observedAt: nowIso,
    modelId: input.attempt.modelId,
    providerRoute: 'openrouter',
    promptUsdPerToken: '0',
    completionUsdPerToken: '0',
    requestUsd: '0',
  };
  return new CalendarTurnLedger({
    accounting: asCalendarAccountingPort(input.persistence),
    identity: {
      userId: input.userId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attempt.attemptId,
      openRouterUser: input.openRouterUser ?? input.attempt.openRouterUser,
      createdAt: input.budget.createdAt,
      deadlineAt: input.budget.deadlineAt,
    },
    limits: input.limits ?? CALENDAR_LIMITS,
    write: input.barrier.write,
    clock: () => Date.parse(input.now()),
    modelId: input.attempt.modelId,
    pricing,
    configRevision: input.configRevision ?? 1,
    connection: input.account,
    maxOutputTokens: 1,
    processingPolicyId: input.permission.policyId,
    job: input.job,
    fence: input.barrier.fence,
    requireCurrent: async () => {
      await input.connection.requireAccountCurrent(input.account, input.job.signal);
    },
  });
}

async function validateTurnForDispatch(input: {
  persistence: PersistenceBundle;
  userId: string;
  sessionId: string;
  turnId: string;
  acceptedMessageId: string;
  acceptanceAttemptIds: readonly string[];
}): Promise<{ ok: true; acceptedMessage: NonNullable<Awaited<ReturnType<PersistenceBundle['messages']['get']>>> }
  | { ok: false; message: string }> {
  const turnAttempts = (await attemptsFor(input.persistence, input.userId, input.sessionId))
    .filter(item => item.turnId === input.turnId);
  if (turnAttempts.some(item => item.status === 'cancelled')) {
    return { ok: false, message: 'The request was cancelled.' };
  }
  let hasAcceptance = false;
  for (const id of input.acceptanceAttemptIds) {
    const marker = await input.persistence.metadata.getAcceptance(input.userId, input.sessionId, id);
    if (marker && marker.turnId === input.turnId && marker.userMessageId === input.acceptedMessageId) {
      hasAcceptance = true;
      break;
    }
  }
  if (!hasAcceptance) {
    return { ok: false, message: 'Accepted turn evidence is missing.' };
  }
  const acceptedMessage = await input.persistence.messages.get(input.userId, input.sessionId, input.acceptedMessageId);
  if (!acceptedMessage
    || acceptedMessage.userId !== input.userId
    || acceptedMessage.sessionId !== input.sessionId
    || acceptedMessage.turnId !== input.turnId
    || acceptedMessage.role !== 'user'
    || (acceptedMessage.visibility === 'internal' && acceptedMessage.mode !== 'live')
    || acceptedMessage.completionStatus !== 'accepted') {
    return { ok: false, message: 'Accepted input evidence is missing.' };
  }
  return { ok: true, acceptedMessage };
}

/**
 * Recovers a reserved `planned` v2 operation using only saved operation,
 * accepted-turn, budget, and proposal authority records plus fresh account,
 * capability, and availability preflight checks.
 */
export async function reconcilePlannedCalendarOperationV2(
  input: PlannedRecoveryInput,
): Promise<PlannedRecoveryResult> {
  const op = input.operation;
  if (op.state !== 'planned') {
    return { outcome: 'interrupted', message: 'Calendar operation is not planned.', operation: op };
  }
  if (op.userId !== input.userId || op.sessionId !== input.sessionId
    || op.authorization.acceptedTurnId !== op.turnId
    || !op.action) {
    return { outcome: 'interrupted', message: 'Calendar operation evidence is incomplete.', operation: op };
  }
  if (!input.permission.minimalEvidenceAllowed) {
    return { outcome: 'interrupted', message: 'Calendar evidence permission is unavailable.', operation: op };
  }
  const barrier = resolveBarrier(input);
  const nowMs = Date.parse(input.now());
  const budget = await input.persistence.calendarAccountingV2.getBudget(
    input.userId, input.sessionId, op.turnId,
  );
  if (!budget || Date.parse(budget.deadlineAt) <= nowMs || Date.parse(op.auditExpiresAt) <= nowMs) {
    return { outcome: 'interrupted', message: 'The Calendar operation deadline expired.', operation: op };
  }
  const turnValid = await validateTurnForDispatch({
    persistence: input.persistence,
    userId: input.userId,
    sessionId: input.sessionId,
    turnId: op.turnId,
    acceptedMessageId: op.authorization.acceptedUserMessageId,
    acceptanceAttemptIds: [op.originatingAttemptId, input.attempt.attemptId],
  });
  if (!turnValid.ok) {
    return { outcome: 'interrupted', message: turnValid.message, operation: op };
  }

  const account: CalendarAccountBinding = {
    userId: op.userId,
    connectionId: op.connectionId,
    connectionRevision: op.connectionRevision,
    googleSubjectId: op.googleSubjectId,
  };
  try {
    await input.connection.requireAccountCurrent(account, input.job.signal);
  } catch {
    return { outcome: 'interrupted', message: 'Google Calendar connection changed.', operation: op };
  }

  let proposal: CalendarProposalRecord | null = null;
  let consumption: CalendarProposalConsumption | null = null;
  if (op.authorization.proposalId !== null) {
    const verified = await verifiedConsumptionAuthority({
      persistence: input.persistence,
      userId: input.userId,
      sessionId: input.sessionId,
      proposalId: op.authorization.proposalId,
      acceptedTurnId: op.authorization.acceptedTurnId,
      acceptedMessageId: op.authorization.acceptedUserMessageId,
      expectedIntentId: op.intentId,
      expectedOperationId: op.operationId,
      expectedHash: op.requestHash,
      nowMs,
    });
    if (!verified.ok) {
      return { outcome: 'interrupted', message: verified.message, operation: op };
    }
    if (verified.replyConnectionId !== op.connectionId
      || verified.replyConnectionRevision !== op.connectionRevision
      || verified.replyGoogleSubjectId !== op.googleSubjectId
      || (verified.proposal && (verified.proposal.connectionId !== op.connectionId
        || verified.proposal.connectionRevision !== op.connectionRevision
        || verified.proposal.googleSubjectId !== op.googleSubjectId))) {
      return { outcome: 'interrupted', message: 'The Calendar connection changed after confirmation.', operation: op };
    }
    proposal = verified.proposal;
    consumption = verified.consumption;
  }

  const store = input.persistence.calendarOperationsV2;
  if (!store) {
    return { outcome: 'interrupted', message: 'Calendar v2 is unavailable.', operation: op };
  }
  await repairOperationEventV2({
    store,
    metadata: input.persistence.metadata,
    write: barrier.write,
    operation: op,
    attemptId: op.originatingAttemptId,
  });

  const ledger = buildRecoveryLedger({
    persistence: input.persistence,
    barrier,
    job: input.job,
    userId: input.userId,
    sessionId: input.sessionId,
    turnId: op.turnId,
    attempt: input.attempt,
    account,
    budget,
    permission: input.permission,
    connection: input.connection,
    limits: input.limits,
    pricing: input.pricing,
    configRevision: input.configRevision,
    openRouterUser: input.openRouterUser,
    now: input.now,
  });
  const seedTarget: CalendarResolvedTarget = {
    userId: op.userId,
    connectionId: op.connectionId,
    connectionRevision: op.connectionRevision,
    googleSubjectId: op.googleSubjectId,
    calendarId: op.calendarId,
    calendarLabel: op.calendarLabel ?? op.calendarId,
    targetRevision: op.targetRevision,
    discoveryRevision: op.discoveryRevision,
    selectedBy: op.authorization.basis === 'proposal-selection' ? 'proposal' : 'explicit',
    accessRole: 'writer',
    privateAccess: false,
    capabilities: { readEvents: false, createEvents: true, availability: false },
    verifiedAt: op.authorization.approvedAt,
    proofRevision: 'google-calendar.multi.v2',
  };
  const canonical = canonicalCalendarAction(op.action, seedTarget);
  if (calendarActionHash(canonical) !== op.requestHash) {
    return { outcome: 'interrupted', message: 'Calendar action integrity mismatch.', operation: op };
  }
  const decisionId = key('dec', input.userId, op.turnId, 'recovery-planned');
  const writer = new CalendarOperationWriter({
    operations: input.persistence.calendarOperations,
    operationsV2: store,
    executionV2: input.execution,
    write: barrier.write,
    ledger,
    identity: {
      userId: input.userId,
      sessionId: input.sessionId,
      turnId: op.turnId,
      attemptId: op.originatingAttemptId,
    },
    binding: bindingOfV2(op),
    clock: () => Date.parse(input.now()),
    job: input.job,
    fence: barrier.fence,
    requireCurrent: async (bound, signal) => {
      await input.connection.requireAccountCurrent(bound, signal);
    },
    permission: input.permission,
    trustedTimeZone: input.trustedTimeZone,
    auditDeadlineAt: input.auditDeadlineAt,
    chargeProviderRequest: kind => ledger.chargeCalendarRequest(kind),
  });
  const outcome = await writer.executeCreate({
    intent: {
      intentId: op.intentId,
      originatingTurnId: op.originatingTurnId,
      originatingAcceptedMessageId: op.originatingAcceptedMessageId,
      originatingAttemptId: op.originatingAttemptId,
    },
    account,
    target: seedTarget,
    accepted: { message: turnValid.acceptedMessage, turnId: op.turnId },
    proposal,
    consumption,
    action: canonical,
    requestHash: op.requestHash,
    operationId: op.operationId,
    decisionId,
    toolCallId: key('call', input.userId, op.turnId, 'recovery-planned'),
    createdAt: op.createdAt,
    auditExpiresAt: op.auditExpiresAt,
    capability: async check => {
      const resolved = await input.capabilities.resolve({
        account: check.account,
        selector: check.target.calendarId,
        operation: 'create',
        signal: input.job.signal,
        deadlineAt: budget.deadlineAt,
        consumeRequest: kind => ledger.chargeCalendarRequest(kind),
        consumeRefreshRequest: () => ledger.chargeRefreshRequest(),
      });
      if (resolved.outcome === 'clarify') {
        return { outcome: 'clarify', message: 'That calendar is no longer available. Which calendar should I use?' };
      }
      if (resolved.outcome === 'denied') {
        return { outcome: 'clarify', message: 'Permission to schedule on this calendar was denied.' };
      }
      return { outcome: 'ok', target: resolved.target };
    },
    preflight: async check => {
      const condition = await runCalendarPreflight({
        execution: input.execution,
        ledger,
        account,
        sessionId: input.sessionId,
        turnId: op.turnId,
        attemptId: op.originatingAttemptId,
        decisionId,
        intentId: op.intentId,
        stage: proposal ? 'proposal-reply' : 'direct-create',
        action: check.action,
        trustedNow: input.now(),
        trustedTimeZone: input.trustedTimeZone,
        deadlineAt: budget.deadlineAt,
        signal: input.job.signal,
      });
      if (op.authorization.basis === 'conflict-acceptance' && proposal) {
        const stillAccepted = sameApprovedCondition({
          proposal,
          actionHash: op.requestHash,
          target: check.target,
          fingerprint: calendarAvailabilityFingerprint(condition),
        });
        if (stillAccepted) return null;
      }
      return condition;
    },
    clarify: async check => describeAvailabilityCondition(check.condition),
  });
  if (outcome.outcome === 'created' || outcome.outcome === 'existing') {
    return { outcome: outcome.outcome, operation: outcome.operation };
  }
  return {
    outcome: outcome.outcome,
    message: outcome.message,
    ...('operation' in outcome ? { operation: outcome.operation } : {}),
  };
}

/**
 * Discovers a confirmed proposal consumption on an interrupted turn that crashed
 * before `reserveByIntent` and either completes the exact original operation
 * under fresh checks or interrupts without re-consuming or generating new IDs.
 */
export async function reconcileConsumedProposalWithoutOperation(
  input: Omit<PlannedRecoveryInput, 'operation'>,
): Promise<PlannedRecoveryResult | null> {
  const store = input.persistence.owner.store;
  let proposalId = (await input.persistence.calendarProposals.getReplyReference(
    input.userId, input.sessionId, input.attempt.attemptId,
  ))?.proposalId ?? null;
  if (!proposalId && store) {
    const rows = await store.collection('metadata').find({
      userId: input.userId,
      sessionId: input.sessionId,
      kind: 'calendar-proposal-consumption',
      'consumption.acceptedTurnId': input.attempt.turnId,
    }, store.options()).limit(2).toArray();
    if (rows.length > 1) {
      return { outcome: 'interrupted', message: 'Multiple proposal consumptions exist for one turn.' };
    }
    if (rows.length === 1) {
      let record: CalendarProposalConsumptionWrapper | null = null;
      try {
        record = decodeCalendar(proposalConsumptionRecordSchema, rows[0]);
      } catch {
        record = null;
      }
      if (!record) {
        return { outcome: 'interrupted', message: 'Proposal consumption record is invalid.' };
      }
      proposalId = record.proposalId;
    }
  }
  if (!proposalId) return null;

  const nowMs = Date.parse(input.now());
  const verified = await verifiedConsumptionAuthority({
    persistence: input.persistence,
    userId: input.userId,
    sessionId: input.sessionId,
    proposalId,
    acceptedTurnId: input.attempt.turnId,
    acceptedMessageId: input.attempt.causal.userMessageId,
    expectedIntentId: null,
    expectedOperationId: null,
    expectedHash: null,
    nowMs,
  });
  if (!verified.ok) {
    return { outcome: 'interrupted', message: verified.message };
  }

  const { proposal, consumption, choiceCalendarId } = verified;
  if (!proposal) {
    return { outcome: 'interrupted', message: 'Proposal action details are no longer available.' };
  }
  const opStore = input.persistence.calendarOperationsV2;
  if (!opStore) return { outcome: 'interrupted', message: 'Calendar v2 is unavailable.' };
  const existing = await opStore.getByIntent(input.userId, input.sessionId, consumption.intentId);
  if (existing) return null;
  if (!input.permission.minimalEvidenceAllowed) {
    return { outcome: 'interrupted', message: 'Calendar evidence permission is unavailable.' };
  }

  const budget = await input.persistence.calendarAccountingV2.getBudget(
    input.userId, input.sessionId, input.attempt.turnId,
  );
  if (!budget || Date.parse(budget.deadlineAt) <= nowMs) {
    return { outcome: 'interrupted', message: 'The Calendar operation deadline expired.' };
  }
  const turnValid = await validateTurnForDispatch({
    persistence: input.persistence,
    userId: input.userId,
    sessionId: input.sessionId,
    turnId: input.attempt.turnId,
    acceptedMessageId: input.attempt.causal.userMessageId,
    acceptanceAttemptIds: [input.attempt.attemptId],
  });
  if (!turnValid.ok) {
    return { outcome: 'interrupted', message: turnValid.message };
  }

  const target = choiceCalendarId
    ? proposal.candidates.find(candidate => candidate.target.calendarId === choiceCalendarId)?.target ?? null
    : proposal.target;
  if (!target || !proposal.action) {
    return { outcome: 'interrupted', message: 'Proposal target or action proof is missing.' };
  }

  const account: CalendarAccountBinding = {
    userId: proposal.userId,
    connectionId: proposal.connectionId,
    connectionRevision: proposal.connectionRevision,
    googleSubjectId: proposal.googleSubjectId,
  };
  try {
    await input.connection.requireAccountCurrent(account, input.job.signal);
  } catch {
    return { outcome: 'interrupted', message: 'Google Calendar connection changed.' };
  }

  const barrier = resolveBarrier(input);
  const ledger = buildRecoveryLedger({
    persistence: input.persistence,
    barrier,
    job: input.job,
    userId: input.userId,
    sessionId: input.sessionId,
    turnId: input.attempt.turnId,
    attempt: input.attempt,
    account,
    budget,
    permission: input.permission,
    connection: input.connection,
    limits: input.limits,
    pricing: input.pricing,
    configRevision: input.configRevision,
    openRouterUser: input.openRouterUser,
    now: input.now,
  });
  const canonical = canonicalCalendarAction(proposal.action, target);
  if (calendarActionHash(canonical) !== consumption.canonicalActionHash) {
    return { outcome: 'interrupted', message: 'Proposal action does not match confirmed consumption.' };
  }

  const nowIso = input.now();
  const auditCap = Date.parse(nowIso) + 2592000000;
  const auditExpiresAt = new Date(
    input.auditDeadlineAt ? Math.min(Date.parse(input.auditDeadlineAt), auditCap) : auditCap,
  ).toISOString();
  const decisionId = key('dec', input.userId, input.attempt.turnId, 'recovery-consumption');
  const writer = new CalendarOperationWriter({
    operations: input.persistence.calendarOperations,
    operationsV2: opStore,
    executionV2: input.execution,
    write: barrier.write,
    ledger,
    identity: {
      userId: input.userId,
      sessionId: input.sessionId,
      turnId: input.attempt.turnId,
      attemptId: input.attempt.attemptId,
    },
    binding: { ...account, calendarId: target.calendarId, targetRevision: target.targetRevision },
    clock: () => Date.parse(input.now()),
    job: input.job,
    fence: barrier.fence,
    requireCurrent: async (bound, signal) => {
      await input.connection.requireAccountCurrent(bound, signal);
    },
    permission: input.permission,
    trustedTimeZone: input.trustedTimeZone,
    auditDeadlineAt: input.auditDeadlineAt,
    chargeProviderRequest: kind => ledger.chargeCalendarRequest(kind),
  });
  const outcome = await writer.executeCreate({
    intent: {
      intentId: proposal.intentId,
      originatingTurnId: proposal.originatingTurnId,
      originatingAcceptedMessageId: proposal.originatingAcceptedMessageId,
      originatingAttemptId: proposal.originatingAttemptId,
    },
    account,
    target,
    accepted: { message: turnValid.acceptedMessage, turnId: input.attempt.turnId },
    proposal,
    consumption,
    action: canonical,
    requestHash: consumption.canonicalActionHash,
    operationId: consumption.operationId,
    decisionId,
    toolCallId: key('call', input.userId, input.attempt.turnId, 'recovery-consumption'),
    createdAt: nowIso,
    auditExpiresAt,
    capability: async check => {
      const resolved = await input.capabilities.resolve({
        account: check.account,
        selector: check.target.calendarId,
        operation: 'create',
        signal: input.job.signal,
        deadlineAt: budget.deadlineAt,
        consumeRequest: kind => ledger.chargeCalendarRequest(kind),
        consumeRefreshRequest: () => ledger.chargeRefreshRequest(),
      });
      if (resolved.outcome === 'clarify') {
        return { outcome: 'clarify', message: 'That calendar is no longer available. Which calendar should I use?' };
      }
      if (resolved.outcome === 'denied') {
        return { outcome: 'clarify', message: 'Permission to schedule on this calendar was denied.' };
      }
      return { outcome: 'ok', target: resolved.target };
    },
    preflight: async check => {
      const condition = await runCalendarPreflight({
        execution: input.execution,
        ledger,
        account,
        sessionId: input.sessionId,
        turnId: input.attempt.turnId,
        attemptId: input.attempt.attemptId,
        decisionId,
        intentId: proposal.intentId,
        stage: 'proposal-reply',
        action: check.action,
        trustedNow: input.now(),
        trustedTimeZone: input.trustedTimeZone,
        deadlineAt: budget.deadlineAt,
        signal: input.job.signal,
      });
      if (proposal.purpose === 'conflict') {
        const stillAccepted = sameApprovedCondition({
          proposal,
          actionHash: consumption.canonicalActionHash,
          target: check.target,
          fingerprint: calendarAvailabilityFingerprint(condition),
        });
        if (stillAccepted) return null;
      }
      return condition;
    },
    clarify: async check => describeAvailabilityCondition(check.condition),
  });
  if (outcome.outcome === 'created' || outcome.outcome === 'existing') {
    return { outcome: outcome.outcome, operation: outcome.operation };
  }
  return {
    outcome: outcome.outcome,
    message: outcome.message,
    ...('operation' in outcome ? { operation: outcome.operation } : {}),
  };
}

