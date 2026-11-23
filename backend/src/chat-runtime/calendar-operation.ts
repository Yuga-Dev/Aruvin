/**
 * ============================================================================
 * FILE: calendar-operation.ts
 * LOCATION: backend/src/chat-runtime/calendar-operation.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Own the single mutating Calendar create entry point and the v2 operation
 *    state machine.
 *
 * ROLE IN PROJECT:
 *    `CalendarOperationWriter.executeCreate` is the only public way to write a
 *    Calendar event. It verifies the accepted message, the canonical action
 *    hash and the minimal-evidence permission itself, so neither a direct
 *    caller nor a model flag can bypass the intent, the preflight or the
 *    durable operation record.
 *
 * KEY COMPONENTS:
 *    - canonicalCalendarAction: Attributes the canonical target ID and validates the schema.
 *    - deriveV2Basis/buildV2CreateOperation: The single construction seam of one immutable v2 operation.
 *    - transitionV2: The confirmed v2 transition (CAS plus the durable v2 event).
 *    - CalendarOperationWriter.executeCreate: Admission, dispatch and outcome classification.
 *    - CalendarOperationWriter.markUnknown: A bounded reconciliation outcome without replay permission.
 * ============================================================================
 */

import { isDeepStrictEqual } from 'node:util';
import { calendarInputSchemas, type CalendarCreateInput } from '../contracts/calendar-tools.js';
import type { AttemptRecord } from '../contracts/attempt.js';
import type { CalendarAvailabilityResult } from '../contracts/calendar-availability.js';
import type { CalendarAccountBinding, CalendarResolvedTarget } from '../contracts/calendar-discovery.js';
import type { MessageRecord } from '../contracts/message.js';
import {
  operationRecordSchema,
  operationRecordV2Schema,
  operationEventV2Schema,
  type CalendarExecutionBindingV2,
  type CalendarExecutionPort,
  type CalendarExecutionPortV2,
  type CalendarRequestKindV2,
  type CalendarOperation,
  type CalendarOperationEventV2,
  type CalendarOperationStoreV2,
  type CalendarOperationV2,
  type CalendarReceiptV2,
} from '../contracts/calendar-operations.js';
import type { CalendarResultV2 } from '../contracts/calendar-tools.js';
import type { CalendarSourceReferenceV2 } from '../contracts/calendar-sources.js';
import type { CalendarProposalConsumption, CalendarProposalRecord } from '../contracts/calendar-authority.js';
import type { CalendarConnectionBinding } from '../contracts/calendar-connections.js';
import { calendarActionHash, calendarEventId, validateCalendarCall }
  from '../plugins/google-calendar/tools-validation.js';
export { calendarActionHash };
import { key } from '../persistence/records.js';
import { AppError } from '../platform/errors/app-error.js';
import type { CalendarOperationsPort } from './calendar-ports.js';
import type { CalendarTurnLedger } from './calendar-budget.js';
import { describeAvailabilityCondition, requiresAcceptance } from './calendar-preflight.js';

export function canonicalCalendarAction(action: CalendarCreateInput,
  target: CalendarResolvedTarget): CalendarCreateInput {
  if (action.calendarId !== undefined && action.calendarId !== target.calendarId) {
    throw new AppError('INVALID_REQUEST', 'The calendar selection needs clarification.', false);
  }
  const canonical = calendarInputSchemas.calendar_create_event.parse({ ...action, calendarId: target.calendarId });
  validateCalendarCall({ name: 'calendar_create_event', arguments: canonical });
  return canonical;
}

/**
 * A succeeded or in-flight create for this canonical event in the session.
 * Hash identity is preferred; the same calendar and start/end instants still
 * match when timestamp spelling produced a different request hash.
 */
export async function findOwnSessionCreate(
  store: CalendarOperationStoreV2,
  userId: string,
  sessionId: string,
  action: CalendarCreateInput,
): Promise<CalendarOperationV2 | null> {
  const byHash = await store.findSucceededByRequestHash(userId, sessionId, calendarActionHash(action));
  if (byHash) return byHash;
  const calendarId = action.calendarId;
  if (!calendarId) return null;
  return store.findOwnCreateBySlot(userId, sessionId, {
    calendarId, start: action.start, end: action.end,
  });
}

/**
 * Request kinds emitted once for each actual Calendar REST delivery. The HTTP
 * adapter invokes the consumer immediately before dispatch, including every
 * discovery page and same-target capability recheck.
 */
export const PROVIDER_REQUEST_KINDS = new Set<CalendarRequestKindV2>(
  ['list', 'get', 'create', 'readback', 'availability', 'preflight', 'discovery', 'capability-recheck'],
);

export type CalendarOperationLedger = Pick<
  CalendarTurnLedger,
  'ensureBudget' | 'deadlineAt' | 'chargeLogicalTool' | 'chargeCreate' | 'chargeCalendarRequest' | 'chargeRefreshRequest'
>;

export type CalendarOperationWriterOptions = {
  /** The legacy v1 store. It is read-only in this runtime and never writes. */
  operations?: CalendarOperationsPort;
  /** The v2 operation store. It owns every mutating Calendar record. */
  operationsV2?: CalendarOperationStoreV2;
  /** The legacy v1 execution port. It is used only for the legacy readback. */
  execution?: CalendarExecutionPort;
  /** The v2 execution port. It owns every mutating Calendar write. */
  executionV2?: CalendarExecutionPortV2;
  write: <T>(action: () => Promise<T>) => Promise<T>;
  ledger: CalendarOperationLedger;
  identity: { userId: string; sessionId: string; turnId: string; attemptId: string };
  binding: CalendarConnectionBinding;
  clock: () => number;
  job: { check(): void; signal: AbortSignal };
  fence: () => Promise<boolean>;
  requireCurrent: (account: CalendarAccountBinding, signal: AbortSignal) => Promise<void>;
  permission: { content: 'volatile' | 'retained'; minimalEvidenceAllowed: boolean; policyId: string };
  auditDeadlineAt?: string;
  trustedTimeZone: string;
  /**
   * Charges one actual Calendar REST delivery before it is dispatched.
   */
  chargeProviderRequest?: (kind: CalendarRequestKindV2) => Promise<void>;
};

/**
 * The legacy v1 transition. It is reachable only through the legacy read-only
 * reconciliation path; the active v2 runtime never writes a v1 operation.
 */
async function transition(
  options: CalendarOperationWriterOptions,
  current: CalendarOperation,
  change: Partial<CalendarOperation>,
): Promise<CalendarOperation> {
  const operations = options.operations;
  if (!operations) throw new AppError('NOT_READY', 'Calendar v1 is unavailable.');
  const now = new Date(options.clock()).toISOString();
  const next = operationRecordSchema.parse({ ...current, ...change,
    revision: current.revision + 1, sequence: current.sequence + 1, updatedAt: now });
  const result = await options.write(() => operations.compareAndSwap(current.revision, next));
  if (result.outcome !== 'confirmed') {
    throw new AppError('PERSISTENCE_ERROR', 'Calendar progress could not be confirmed.', false);
  }
  await options.write(() => operations.appendEvent({ schemaVersion: 1, kind: 'calendar-operation-event',
    userId: next.userId, sessionId: next.sessionId, turnId: next.turnId, attemptId: options.identity.attemptId,
    operationId: next.operationId, eventId: key('calendar-operation-event', next.operationId, next.sequence),
    sequence: next.sequence, state: next.state, createdAt: next.updatedAt, failure: next.failure }));
  return result.record;
}

export function buildOperationEventV2(
  operation: CalendarOperationV2,
  attemptId: string,
  createdAt = operation.updatedAt,
): CalendarOperationEventV2 {
  return operationEventV2Schema.parse({
    schemaVersion: 2,
    kind: 'calendar-operation-event-v2',
    userId: operation.userId,
    sessionId: operation.sessionId,
    turnId: operation.turnId,
    attemptId,
    operationId: operation.operationId,
    intentId: operation.intentId,
    eventId: key('calendar-operation-event-v2', operation.operationId, operation.sequence),
    sequence: operation.sequence,
    state: operation.state,
    revision: operation.revision,
    createdAt,
    failure: operation.failure,
  });
}

export async function appendPlannedEvent(
  store: CalendarOperationStoreV2,
  write: CalendarOperationWriterOptions['write'],
  operation: CalendarOperationV2,
  attemptId: string,
): Promise<CalendarOperationEventV2> {
  const event = buildOperationEventV2(operation, attemptId, operation.createdAt);
  const appended = await write(() => store.appendEventV2(event));
  if (appended.outcome !== 'confirmed') {
    throw new AppError('PERSISTENCE_ERROR', 'Calendar progress could not be confirmed.', false);
  }
  return event;
}

/**
 * Verifies the scoped current operation and idempotently repairs a missing
 * `planned` or `succeeded` transition event for its exact sequence/revision.
 * Rejects competing events, modified receipts, foreign attempts, and states
 * where only readback is permitted.
 */
export async function repairOperationEventV2(input: {
  store: CalendarOperationStoreV2;
  metadata: { getAttempt(userId: string, sessionId: string, attemptId: string): Promise<AttemptRecord | null> };
  write: CalendarOperationWriterOptions['write'];
  operation: CalendarOperationV2;
  attemptId: string;
}): Promise<CalendarOperationEventV2> {
  const current = await input.store.getByIntent(
    input.operation.userId, input.operation.sessionId, input.operation.intentId,
  );
  if (!current || current.operationId !== input.operation.operationId
    || current.revision !== input.operation.revision
    || current.sequence !== input.operation.sequence
    || current.state !== input.operation.state
    || !isDeepStrictEqual(current.receipt, input.operation.receipt)) {
    throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Calendar operation disagrees with event repair.');
  }
  if (current.state !== 'planned' && (current.state !== 'succeeded' || current.receipt === null)) {
    throw new AppError('INVALID_REQUEST', 'Calendar operation state does not permit event repair.', false);
  }
  const attempt = await input.metadata.getAttempt(current.userId, current.sessionId, input.attemptId);
  if (!attempt || attempt.userId !== current.userId || attempt.sessionId !== current.sessionId
    || attempt.turnId !== current.turnId) {
    throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Foreign attempt cannot repair Calendar operation event.');
  }
  const events = await input.store.listEventsV2({
    userId: current.userId, sessionId: current.sessionId, operationId: current.operationId,
  });
  const existing = events.find(entry => entry.sequence === current.sequence);
  if (existing) {
    const existingAttempt = existing.attemptId === attempt.attemptId
      ? attempt
      : await input.metadata.getAttempt(current.userId, current.sessionId, existing.attemptId);
    const expected = buildOperationEventV2(
      current,
      existing.attemptId,
      current.state === 'planned' ? current.createdAt : existing.createdAt,
    );
    if (!existingAttempt || existingAttempt.turnId !== current.turnId
      || (existing.attemptId !== attempt.attemptId && existing.attemptId !== current.originatingAttemptId)
      || !isDeepStrictEqual(existing, expected)) {
      throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Competing Calendar operation event at sequence.');
    }
    return existing;
  }
  const event = buildOperationEventV2(
    current,
    attempt.attemptId,
    current.state === 'planned' ? current.createdAt : current.updatedAt,
  );
  const appended = await input.write(() => input.store.appendEventV2(event));
  if (appended.outcome !== 'confirmed') {
    throw new AppError('PERSISTENCE_ERROR', 'Calendar progress could not be confirmed.', false);
  }
  return event;
}

/**
 * The confirmed v2 transition: the immutable operation row moves forward and
 * the matching durable v2 event is written. An unconfirmed CAS or an
 * unconfirmed event never looks like progress.
 */
async function transitionV2WithEvent(
  options: CalendarOperationWriterOptions,
  current: CalendarOperationV2,
  change: Partial<CalendarOperationV2>,
): Promise<{ operation: CalendarOperationV2; event: CalendarOperationEventV2 }> {
  const store = options.operationsV2;
  if (!store) throw new AppError('NOT_READY', 'Calendar v2 is unavailable.');
  const now = new Date(options.clock()).toISOString();
  const next = operationRecordV2Schema.parse({ ...current, ...change,
    revision: current.revision + 1, sequence: current.sequence + 1, updatedAt: now });
  const result = await options.write(() => store.compareAndSwap({
    expectedRevision: current.revision, next,
  }));
  if (result.outcome !== 'confirmed') {
    throw new AppError('PERSISTENCE_ERROR', 'Calendar progress could not be confirmed.', false);
  }
  const event = buildOperationEventV2(next, options.identity.attemptId, next.updatedAt);
  const appended = await options.write(() => store.appendEventV2(event));
  if (appended.outcome !== 'confirmed') {
    throw new AppError('PERSISTENCE_ERROR', 'Calendar progress could not be confirmed.', false);
  }
  return { operation: result.operation, event };
}

async function transitionV2(
  options: CalendarOperationWriterOptions,
  current: CalendarOperationV2,
  change: Partial<CalendarOperationV2>,
): Promise<CalendarOperationV2> {
  return (await transitionV2WithEvent(options, current, change)).operation;
}

export type CalendarV2CreateRequest = {
  identity: { userId: string; sessionId: string; turnId: string; attemptId: string };
  intent: {
    intentId: string;
    originatingTurnId: string;
    originatingAcceptedMessageId: string;
    originatingAttemptId: string;
  };
  accepted: { messageId: string; turnId: string; createdAt: string };
  action: CalendarCreateInput;
  target: CalendarResolvedTarget;
  /** The consumed proposal that authorised this create, or null for an explicit request. */
  proposal: CalendarProposalRecord | null;
  operationId: string;
  requestHash: string;
  createdAt: string;
  auditExpiresAt: string;
};

/**
 * The authority basis is derived from the verified proposal evidence, never from
 * a model instruction or a caller-supplied flag.
 */
export function deriveV2Basis(proposal: CalendarProposalRecord | null):
  'explicit-request' | 'proposal-selection' | 'proposal-confirmation' | 'conflict-acceptance' {
  if (!proposal) return 'explicit-request';
  if (proposal.purpose === 'details') return 'proposal-confirmation';
  return proposal.purpose === 'selection' ? 'proposal-selection' : 'conflict-acceptance';
}

/**
 * One immutable v2 operation per accepted intent. The operation identity, the
 * canonical action hash, the accepted message, the target and the authorised
 * condition are fixed here; nothing downstream may rewrite them.
 */
export function buildV2CreateOperation(request: CalendarV2CreateRequest): CalendarOperationV2 {
  const basis = deriveV2Basis(request.proposal);
  return operationRecordV2Schema.parse({
    schemaVersion: 2,
    kind: 'calendar-operation',
    userId: request.identity.userId,
    sessionId: request.identity.sessionId,
    turnId: request.identity.turnId,
    operationId: request.operationId,
    originatingAttemptId: request.proposal?.originatingAttemptId ?? request.intent.originatingAttemptId,
    revision: 1,
    sequence: 0,
    intentId: request.intent.intentId,
    originatingTurnId: request.intent.originatingTurnId,
    originatingAcceptedMessageId: request.intent.originatingAcceptedMessageId,
    connectionId: request.target.connectionId,
    connectionRevision: request.target.connectionRevision,
    googleSubjectId: request.target.googleSubjectId,
    calendarId: request.target.calendarId,
    targetRevision: request.target.targetRevision,
    calendarLabel: null,
    labelExpiresAt: null,
    discoveryRevision: request.target.discoveryRevision,
    proofRevision: 'google-calendar.multi.v2',
    requestHash: request.requestHash,
    googleEventId: calendarEventId(request.operationId),
    schemaRevision: 'google-calendar.v2',
    action: request.action,
    actionSources: [],
    authorization: {
      acceptedUserMessageId: request.accepted.messageId,
      acceptedTurnId: request.accepted.turnId,
      canonicalActionHash: request.requestHash,
      approvedAt: request.accepted.createdAt,
      basis,
      proposalId: request.proposal?.proposalId ?? null,
      conditionFingerprint: basis === 'conflict-acceptance' ? request.proposal!.conditionFingerprint : null,
    },
    deliveryRetries: 0,
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
    auditExpiresAt: request.auditExpiresAt,
    state: 'planned',
    receipt: null,
    failure: null,
  });
}

/**
 * The one request the single public create entry point accepts.
 *
 * The accepted message, the consumed proposal evidence and the canonical action
 * hash are all supplied as evidence; the entry point verifies them itself.
 */
export type CalendarCreateRequest = {
  /** The validated accepted intent. */
  intent: {
    intentId: string;
    originatingTurnId: string;
    originatingAcceptedMessageId: string;
    originatingAttemptId: string;
  };
  /** The current account binding. It must be the account the target belongs to. */
  account: CalendarAccountBinding;
  /** The resolved, capability-checked target. */
  target: CalendarResolvedTarget;
  /** The actual accepted message that authorises this create. */
  accepted: { message: MessageRecord; turnId: string };
  /** The final consumed proposal evidence, or null for an explicit request. */
  proposal: CalendarProposalRecord | null;
  /** The exact I1 consumption of that proposal, or null for an explicit request. */
  consumption: CalendarProposalConsumption | null;
  /** The action to write. Its canonical hash is recomputed by the entry point. */
  action: CalendarCreateInput;
  /** The canonical action hash the approval was granted against. */
  requestHash: string;
  /** The immutable operation identity of this accepted intent. */
  operationId: string;
  decisionId: string;
  toolCallId: string;
  createdAt: string;
  auditExpiresAt: string;
  /**
   * The fresh capability check of the resolved target. The entry point calls it
   * itself so a stale target from an earlier turn can never authorise a write.
   */
  capability?: (input: { account: CalendarAccountBinding; target: CalendarResolvedTarget }) =>
    Promise<{ outcome: 'ok'; target: CalendarResolvedTarget } | { outcome: 'clarify'; message: string }>;
  /**
   * The server-owned availability check. When present, the create entry point
   * runs it itself, so a caller cannot write on an unverified condition.
   */
  preflight?: (input: { action: CalendarCreateInput; target: CalendarResolvedTarget }) =>
    Promise<CalendarAvailabilityResult | null>;
  /**
   * The bounded clarification published for a condition that needs acceptance.
   * It publishes the durable proposal and returns the user-facing question.
   */
  clarify?: (input: { action: CalendarCreateInput; target: CalendarResolvedTarget;
    condition: CalendarAvailabilityResult }) => Promise<string>;
  /**
   * The logical tool the paused request is debited against. A create that
   * pauses for a condition still spends the turn's one logical tool.
   */
  clarifyCharge?: { decisionId: string };
};

function createFailureMessage(failure: { code: string }): string {
  switch (failure.code) {
    case 'CALENDAR_INPUT_REJECTED':
      return 'No Calendar event was created. Google Calendar rejected the event details.';
    case 'EVENT_NOT_FOUND':
    case 'EVENT_GONE':
      return 'No Calendar event was created. Google Calendar could not find that calendar.';
    case 'CALENDAR_FORBIDDEN':
      return 'No Calendar event was created. Permission to write on that calendar was denied.';
    case 'CALENDAR_QUOTA_EXCEEDED':
    case 'CALENDAR_RATE_LIMITED':
      return 'No Calendar event was created. Google Calendar rate-limited the request.';
    case 'RECONNECT_REQUIRED':
      return 'No Calendar event was created. Your Google Calendar connection needs to be reconnected.';
    default:
      return 'No Calendar event was created. The Calendar event could not be created.';
  }
}

export type CalendarCreateOutcome =
  | { outcome: 'created'; operation: CalendarOperationV2; event?: CalendarOperationEventV2; receipt: CalendarReceiptV2;
      result: CalendarResultV2; source: CalendarSourceReferenceV2 }
  | { outcome: 'clarify'; message: string }
  | { outcome: 'existing'; operation: CalendarOperationV2; message: string }
  | { outcome: 'failed'; operation: CalendarOperationV2; message: string }
  | { outcome: 'unknown'; operation: CalendarOperationV2; message: string };

export class CalendarOperationWriter {
  constructor(private readonly o: CalendarOperationWriterOptions) {}

  /**
   * The single public entry point for a mutating Calendar create.
   *
   * The order is fixed: verify the accepted evidence, read the existing
   * operation for the intent, run the fresh capability and preflight checks,
   * charge the one logical create, reserve and confirm the planned operation
   * and its durable v2 event, re-check the lease, the account and the
   * deadline, move the operation to `dispatching`, and only then invoke the
   * provider exactly once.
   */
  async executeCreate(request: CalendarCreateRequest): Promise<CalendarCreateOutcome> {
    const o = this.o;
    const store = o.operationsV2;
    const execution = o.executionV2;
    if (!store || !execution) throw new AppError('NOT_READY', 'Calendar v2 is unavailable.');
    if (!o.permission.minimalEvidenceAllowed) {
      throw new AppError('NOT_READY', 'Calendar evidence permission is unavailable.');
    }
    o.job.check();

    // The accepted message and the accepted turn are verified here. A caller and
    // a model flag never authorise a create.
    const accepted = request.accepted.message;
    if (accepted.role !== 'user' || (accepted.visibility === 'internal' && accepted.mode !== 'live')
      || accepted.completionStatus !== 'accepted'
      || accepted.userId !== o.identity.userId
      || accepted.sessionId !== o.identity.sessionId
      || accepted.turnId !== o.identity.turnId
      || request.accepted.turnId !== o.identity.turnId) {
      throw new AppError('INVALID_REQUEST', 'The accepted message does not authorise this create.', false);
    }
    if (request.consumption) {
      if (request.consumption.acceptedMessageId !== accepted.messageId
        || request.consumption.acceptedTurnId !== request.accepted.turnId
        || request.consumption.intentId !== request.intent.intentId
        || request.consumption.operationId !== request.operationId
        || request.consumption.canonicalActionHash !== request.requestHash) {
        throw new AppError('INVALID_REQUEST', 'The consumed proposal does not authorise this create.', false);
      }
    } else if (request.intent.originatingAcceptedMessageId !== accepted.messageId) {
      // An explicit request is authorised only by the very message that asked
      // for it. A missing proposal with no matching accepted message is never
      // an explicit request.
      throw new AppError('INVALID_REQUEST', 'The accepted message does not authorise this create.', false);
    }

    // The canonical action hash is recomputed here, so no caller can supply a
    // hash that does not match the action it asks to write.
    const canonical = canonicalCalendarAction(request.action, request.target);
    const requestHash = calendarActionHash(canonical);
    if (requestHash !== request.requestHash) {
      throw new AppError('INVALID_REQUEST', 'The Calendar action does not match its approval.', false);
    }
    // The write happens on the account the target was resolved on.
    if (request.account.userId !== request.target.userId
      || request.account.connectionId !== request.target.connectionId
      || request.account.connectionRevision !== request.target.connectionRevision
      || request.account.googleSubjectId !== request.target.googleSubjectId) {
      throw new AppError('INVALID_REQUEST', 'The Calendar target does not belong to the current account.', false);
    }

    // An existing operation for this intent is the exact answer. It never
    // dispatches again and it never charges again.
    const existing = await store.getByIntent(o.identity.userId, o.identity.sessionId, request.intent.intentId);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'The request identity already has different data.');
      }
      const existingResult = this.existingOutcome(existing);
      if (existingResult) return existingResult;
      // The reservation survived before the first dispatch. Revalidate live
      // capability, target revisions, and preflight before confirming/dispatching.
      const revalidated = await this.validateCapabilityAndPreflight(request, canonical);
      if (!revalidated.ok) return revalidated.response;
      await this.confirmPlanned(existing);
      return this.dispatchReserved({ ...request, target: revalidated.target }, canonical, existing);
    }

    // A later turn may use a new intent for the same canonical event. The
    // succeeded, dispatching, or unknown row in the same slot refuses duplicate dispatch.
    const prior = await findOwnSessionCreate(store, o.identity.userId, o.identity.sessionId, canonical);
    if (prior) {
      return this.existingOutcome(prior) ?? {
        outcome: 'unknown', operation: prior,
        message: 'The Calendar event was already sent and its outcome is still being reconciled.',
      };
    }

    const validated = await this.validateCapabilityAndPreflight(request, canonical);
    if (!validated.ok) return validated.response;
    const resolvedTarget = validated.target;

    const planned = buildV2CreateOperation({
      identity: {
        userId: o.identity.userId, sessionId: o.identity.sessionId,
        turnId: o.identity.turnId, attemptId: o.identity.attemptId,
      },
      intent: request.intent,
      accepted: {
        messageId: request.accepted.message.messageId, turnId: request.accepted.turnId,
        createdAt: request.accepted.message.createdAt,
      },
      action: canonical,
      target: resolvedTarget,
      proposal: request.proposal,
      operationId: request.operationId,
      requestHash,
      createdAt: request.createdAt,
      auditExpiresAt: request.auditExpiresAt,
    });

    // The one logical create is charged against the accepted intent, so an
    // exact repeat of the same intent moves no counter.
    await o.ledger.chargeCreate(request.intent.intentId);
    const reserved = await o.write(() => store.reserveByIntent({
      operation: planned, consumption: request.consumption,
    }));
    if (reserved.outcome === 'uncertain') {
      throw new AppError('PERSISTENCE_ERROR', 'Calendar operation reservation was uncertain.', false);
    }
    const reservedOperation = reserved.operation;
    if (reservedOperation.requestHash !== requestHash) {
      throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'The request identity already has different data.');
    }
    const reservedResult = this.existingOutcome(reservedOperation);
    if (reservedResult) return reservedResult;
    // The planned operation and its durable v2 event are confirmed before any
    // provider request is made.
    await this.confirmPlanned(reservedOperation);
    return this.dispatchReserved({ ...request, target: resolvedTarget }, canonical, reservedOperation);
  }

  private existingOutcome(operation: CalendarOperationV2): CalendarCreateOutcome | null {
    if (operation.state === 'succeeded' && operation.receipt) {
      return {
        outcome: 'existing',
        operation,
        message: 'The Calendar event was already created.',
      };
    }
    if (operation.state === 'dispatching' || operation.state === 'unknown') {
      // A dispatch that already happened is never a fresh dispatch permit.
      return {
        outcome: 'unknown',
        operation,
        message: 'The Calendar event was already sent and its outcome is still being reconciled.',
      };
    }
    if (operation.state === 'planned') return null;
    return {
      outcome: 'failed',
      operation,
      message: 'The Calendar event was not created and will not be retried automatically.',
    };
  }

  private async validateCapabilityAndPreflight(
    request: CalendarCreateRequest,
    canonical: CalendarCreateInput,
  ): Promise<{ ok: true; target: CalendarResolvedTarget } | { ok: false; response: CalendarCreateOutcome }> {
    let resolvedTarget = request.target;
    if (request.capability) {
      const capable = await request.capability({ account: request.account, target: request.target });
      if (capable.outcome !== 'ok') {
        return { ok: false, response: { outcome: 'clarify', message: capable.message } };
      }
      if (capable.target.calendarId !== request.target.calendarId
        || capable.target.userId !== request.target.userId
        || capable.target.connectionId !== request.target.connectionId
        || capable.target.connectionRevision !== request.target.connectionRevision
        || capable.target.targetRevision !== request.target.targetRevision
        || capable.target.googleSubjectId !== request.target.googleSubjectId) {
        // The calendar moved under the approval. The immutable authorization is
        // never rewritten to follow it.
        return {
          ok: false,
          response: { outcome: 'clarify', message: 'The calendar for this event changed. Please confirm the event again.' },
        };
      }
      resolvedTarget = capable.target;
    }
    const condition = request.preflight
      ? await request.preflight({ action: canonical, target: resolvedTarget })
      : null;
    if (condition && requiresAcceptance(condition)) {
      if (request.clarifyCharge) await this.o.ledger.chargeLogicalTool(request.clarifyCharge.decisionId);
      const message = request.clarify
        ? await request.clarify({ action: canonical, target: resolvedTarget, condition })
        : describeAvailabilityCondition(condition);
      return { ok: false, response: { outcome: 'clarify', message } };
    }
    return { ok: true, target: resolvedTarget };
  }

  /**
   * Records the bounded reconciliation outcome of an operation whose provider
   * outcome cannot be known. It never grants replay permission and never
   * claims a success.
   */
  async markUnknown(operation: CalendarOperationV2): Promise<CalendarOperationV2> {
    if (operation.state === 'unknown') return operation;
    if (!['planned', 'dispatching'].includes(operation.state)) return operation;
    return transitionV2(this.o, operation, { state: 'unknown' });
  }

  /** Confirms the durable planned operation and its v2 event. */
  private async confirmPlanned(operation: CalendarOperationV2): Promise<void> {
    await appendPlannedEvent(this.o.operationsV2!, this.o.write, operation, this.o.identity.attemptId);
  }

  /**
   * Moves the reserved operation to `dispatching` and performs the single
   * provider invocation.
   */
  private async dispatchReserved(
    request: CalendarCreateRequest,
    canonical: CalendarCreateInput,
    reserved: CalendarOperationV2,
  ): Promise<CalendarCreateOutcome> {
    const o = this.o;
    const execution = o.executionV2!;
    let operation = reserved;

    if (operation.state === 'planned') {
      // The final lease, account and deadline check happens immediately before
      // the first dispatch.
      o.job.check();
      if (!(await o.fence())) throw new AppError('INTERRUPTED', 'Execution ownership was lost.');
      await o.requireCurrent(request.account, o.job.signal);
      await o.ledger.ensureBudget();
      operation = await transitionV2(o, operation, { state: 'dispatching' });
    }
    if (operation.state !== 'dispatching') {
      return { outcome: 'existing', operation,
        message: 'The Calendar event was already created.' };
    }

    const binding: CalendarExecutionBindingV2 = {
      userId: request.account.userId,
      connectionId: request.account.connectionId,
      connectionRevision: request.account.connectionRevision,
      googleSubjectId: request.account.googleSubjectId,
      target: request.target,
      operation,
      sessionId: o.identity.sessionId,
      turnId: o.identity.turnId,
      attemptId: o.identity.attemptId,
      decisionId: request.decisionId,
      toolCallId: request.toolCallId,
      schemaRevision: 'google-calendar.v2',
      trustedNow: new Date(o.clock()).toISOString(),
      trustedTimeZone: o.trustedTimeZone,
      deadlineAt: o.ledger.deadlineAt(),
    };

    const invoked = await execution.invoke({
      binding,
      call: { name: 'calendar_create_event', arguments: canonical },
      signal: o.job.signal,
      consumeRequest: async kind => {
        if (o.chargeProviderRequest) await o.chargeProviderRequest(kind);
        else if (PROVIDER_REQUEST_KINDS.has(kind)) await o.ledger.chargeCalendarRequest(kind);
      },
      consumeRefreshRequest: async () => {
        await o.ledger.chargeRefreshRequest();
      },
    });

    if (invoked.outcome !== 'success' || !invoked.receipt) {
      // The provider write is non-retryable. A definite rejection is a failure;
      // an uncertain delivery is an unknown outcome that keeps the original
      // action, target and event and is never claimed as a success.
      if (invoked.outcome === 'failure' && invoked.failure.category !== 'uncertain') {
        const failed = await transitionV2(o, operation, {
          state: 'definitely-failed', failure: invoked.failure,
        });
        return { outcome: 'failed', operation: failed,
          message: createFailureMessage(invoked.failure) };
      }
      const unknown = await this.markUnknown(operation);
      return { outcome: 'unknown', operation: unknown,
        message: 'The Calendar event may or may not have been created. It will not be retried automatically.' };
    }

    const succeeded = await transitionV2WithEvent(o, operation, {
      state: 'succeeded', receipt: invoked.receipt,
    });
    return { outcome: 'created', operation: succeeded.operation, event: succeeded.event, receipt: invoked.receipt,
      result: invoked.result, source: invoked.source };
  }
}

export { transition as transitionOperation, transitionV2 as transitionOperationV2 };
