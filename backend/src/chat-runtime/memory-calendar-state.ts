/**
 * ============================================================================
 * FILE: memory-calendar-state.ts
 * LOCATION: backend/src/chat-runtime/memory-calendar-state.ts
 * ============================================================================
 * PURPOSE: Bound native decision/result evidence before publication or promotion.
 * ROLE IN PROJECT: Data-only shared text/voice memory evidence; grants no authority.
 * KEY COMPONENTS: Schema, complete native pairs, immutable staging and byte ceiling.
 * ============================================================================
 */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  resumableSkillDecisionSchema, rejectedDecisionV2Schema, completeToolGroupV2Schema,
  type ResumableSkillDecision, type CalendarRejectedDecisionV2,
} from '../contracts/calendar-model.js';
import {
  CALENDAR_TOMBSTONE, calendarToolResultRecordV2Schema, localSkillResultRecordSchema,
  type CalendarToolResultRecordV2, type LocalSkillResultRecord,
} from '../contracts/calendar-sources.js';
import { CALENDAR_LIMITS } from '../contracts/calendar-policy.js';
import { turnBudgetRecordSchema, modelDispatchV2Schema, modelAggregateSchema } from '../contracts/calendar-accounting.js';
import { calendarSourceExpired, redactCalendarSource } from '../persistence/calendar-records.js';
import { skillGroup } from './calendar-skills.js';
import { AppError } from '../platform/errors/app-error.js';
import { idSchema, isoDateSchema } from '../contracts/identifiers.js';
import { hashPayload } from '../platform/crypto/hash-payload.js';

const memoryResultSchema = z.union([localSkillResultRecordSchema, calendarToolResultRecordV2Schema]);
export type MemorySkillResult = LocalSkillResultRecord | CalendarToolResultRecordV2;

const terminalCallSchema = z.object({
  decisionId: idSchema,
  toolCallId: idSchema,
  outcome: z.enum(['denied', 'clarification', 'failed', 'cancelled', 'interrupted']),
}).strict();
export type MemoryTerminalCall = z.infer<typeof terminalCallSchema>;

function unavailableResultContent(): string {
  return JSON.stringify({ kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE });
}

export const memoryCalendarStateSchema = z.object({
  storage: z.literal('volatile'), budget: turnBudgetRecordSchema,
  dispatches: z.array(modelDispatchV2Schema).max(8), aggregate: modelAggregateSchema.nullable(),
  decisions: z.array(resumableSkillDecisionSchema).max(8),
  rejected: z.array(rejectedDecisionV2Schema).max(8),
  results: z.array(memoryResultSchema).max(8),
  terminalCall: terminalCallSchema.optional(),
}).strict().superRefine((state, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Native memory evidence is incomplete.' });
  const budget = state.budget;
  if (state.dispatches.length > budget.modelDispatches ||
      new Set(state.dispatches.map(d => d.dispatchId)).size !== state.dispatches.length ||
      new Set(state.decisions.map(d => d.decisionId)).size !== state.decisions.length ||
      new Set(state.results.map(r => r.toolCallId)).size !== state.results.length ||
      new Set(state.results.map(r => r.eventId)).size !== state.results.length ||
      new Set(state.results.map(r => r.sequence)).size !== state.results.length) fail();
  for (const [index, dispatch] of state.dispatches.entries()) {
    if (dispatch.userId !== budget.userId || dispatch.sessionId !== budget.sessionId || dispatch.turnId !== budget.turnId ||
        dispatch.dispatchIndex !== budget.modelDispatches - state.dispatches.length + index + 1 ||
        (index > 0 && dispatch.attemptId !== state.dispatches[0]!.attemptId)) fail();
  }
  for (const decision of state.decisions) {
    const dispatch = state.dispatches.find(d => d.dispatchId === decision.dispatchId);
    if (!dispatch || dispatch.decisionId !== decision.decisionId || dispatch.attemptId !== decision.attemptId ||
        dispatch.userId !== decision.userId || dispatch.sessionId !== decision.sessionId || dispatch.turnId !== decision.turnId ||
        decision.sources.some(s => s.operationIds.length > 0) ||
        decision.operationId || decision.intentId || decision.proposalId) fail();
  }
  for (const result of state.results) {
    const decision = state.decisions.find(d => d.decisionId === result.decisionId);
    const native = decision?.decision;
    if (!decision || !native || native.kind === 'text' || native.nativeCall.id !== result.toolCallId ||
        decision.userId !== result.userId || decision.sessionId !== result.sessionId || decision.turnId !== result.turnId ||
        decision.attemptId !== result.attemptId) { fail(); continue; }
    if (result.schemaVersion === 3) {
      if (!completeToolGroupV2Schema.safeParse(skillGroup(native, result.resultRef.content)).success) fail();
      continue;
    }
    const source = result.resultRef.source;
    if (native.kind !== 'call_tool' || result.resultRef.operationId !== null ||
        source.operationIds.length > 0 || !source.toolCallIds.includes(result.toolCallId) ||
        source.connectionId !== decision.connectionId || source.connectionRevision !== decision.connectionRevision) {
      fail(); continue;
    }
    if (result.resultRef.storage === 'retained') {
      const payload = result.resultRef.result;
      if (native.envelope.plugin !== 'google-calendar' || native.envelope.tool !== payload.tool ||
          Buffer.byteLength(JSON.stringify(payload), 'utf8') > CALENDAR_LIMITS.resultBytes ||
          ('connectionId' in payload && (payload.connectionId !== decision.connectionId ||
            payload.connectionRevision !== decision.connectionRevision))) {
        fail(); continue;
      }
      if (!completeToolGroupV2Schema.safeParse(skillGroup(native, JSON.stringify(payload), [source])).success) fail();
    } else {
      if (!completeToolGroupV2Schema.safeParse(skillGroup(native, unavailableResultContent(), [])).success) fail();
    }
  }
  if (state.terminalCall) {
    const marker = state.terminalCall;
    const lastDispatch = state.dispatches.at(-1);
    const decision = state.decisions.find(d => d.decisionId === marker.decisionId);
    const native = decision?.decision;
    if (!lastDispatch || lastDispatch.status !== 'terminal' || !decision || !native || native.kind === 'text' ||
        native.nativeCall.id !== marker.toolCallId || decision.dispatchId !== lastDispatch.dispatchId ||
        state.decisions.at(-1)?.decisionId !== decision.decisionId ||
        state.results.some(r => r.decisionId === marker.decisionId || r.toolCallId === marker.toolCallId)) fail();
  }
  for (const rejection of state.rejected) {
    const dispatch = state.dispatches.find(d => d.dispatchId === rejection.dispatchId);
    if (!dispatch || dispatch.decisionId !== rejection.decisionId || dispatch.attemptId !== rejection.attemptId ||
        dispatch.userId !== rejection.userId || dispatch.sessionId !== rejection.sessionId || dispatch.turnId !== rejection.turnId) fail();
  }
  if (state.aggregate && (!isDeepStrictEqual(state.aggregate.dispatchIds, state.dispatches.map(d => d.dispatchId)) ||
      state.aggregate.userId !== budget.userId || state.aggregate.sessionId !== budget.sessionId || state.aggregate.turnId !== budget.turnId ||
      state.aggregate.attemptId !== state.dispatches[0]?.attemptId)) fail();
});
export type MemoryCalendarState = z.infer<typeof memoryCalendarStateSchema>;

const memoryCalendarIntegritySchema = z.object({
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  erasedHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type MemoryCalendarIntegrity = z.infer<typeof memoryCalendarIntegritySchema>;

const memoryCalendarRecordV1Schema = z.object({ schemaVersion: z.literal(1),
  kind: z.literal('memory-calendar-native'), userId: idSchema, sessionId: idSchema,
  turnId: idSchema, attemptId: idSchema, epoch: idSchema,
  version: z.number().int().positive().safe(), fence: z.number().int().nonnegative().safe(),
  state: memoryCalendarStateSchema,
}).strict();

const memoryCalendarRecordV2Schema = z.object({ schemaVersion: z.literal(2),
  kind: z.literal('memory-calendar-native'), userId: idSchema, sessionId: idSchema,
  turnId: idSchema, attemptId: idSchema, epoch: idSchema,
  version: z.number().int().positive().safe(), fence: z.number().int().nonnegative().safe(),
  integrity: memoryCalendarIntegritySchema,
  redactedAt: isoDateSchema.nullable(),
  state: memoryCalendarStateSchema,
}).strict();

/** Version visibility is checked by the reader against the session publication. */
export const memoryCalendarRecordSchema = z.discriminatedUnion('schemaVersion', [
  memoryCalendarRecordV1Schema,
  memoryCalendarRecordV2Schema,
]).refine(record =>
  (record.schemaVersion === 2 || !isCalendarBearingState(record.state)) &&
  record.state.budget.userId === record.userId &&
  record.state.budget.sessionId === record.sessionId &&
  record.state.budget.turnId === record.turnId &&
  record.state.dispatches.every(dispatch => dispatch.attemptId === record.attemptId && dispatch.status === 'terminal') &&
  record.state.decisions.every(decision => !decision.decision || decision.decision.kind === 'text' ||
    record.state.results.some(result => result.decisionId === decision.decisionId) ||
    record.state.terminalCall?.decisionId === decision.decisionId));
export type MemoryCalendarRecord = z.infer<typeof memoryCalendarRecordSchema>;

export function isCalendarBearingState(state: MemoryCalendarState): boolean {
  return state.results.some(r => r.schemaVersion === 2) ||
    state.decisions.some(d => d.sources.length > 0 ||
      (d.decision?.kind === 'call_tool' && d.decision.envelope.plugin === 'google-calendar'));
}

export function memoryCalendarErasedHash(state: MemoryCalendarState): string {
  const erased = eraseMemoryCalendarState(state, 0, 'not-permitted');
  const normalized = memoryCalendarStateSchema.parse({
    ...erased,
    decisions: erased.decisions.map(decision => ({
      ...decision,
      sources: decision.sources.map(source => ({ ...source, redactedAt: source.fetchedAt })),
    })),
    results: erased.results.map(result => {
      if (result.schemaVersion === 3) return result;
      const source = { ...result.resultRef.source, redactedAt: result.resultRef.source.fetchedAt };
      const resultRef = result.resultRef.storage === 'tombstone'
        ? { ...result.resultRef, source, reason: 'not-permitted' as const }
        : { ...result.resultRef, source };
      return { ...result, resultRef };
    }),
  });
  return hashPayload(JSON.stringify(normalized));
}

export function memoryCalendarIntegrity(state: MemoryCalendarState): MemoryCalendarIntegrity {
  const parsed = memoryCalendarStateSchema.parse(state);
  return {
    stateHash: hashPayload(JSON.stringify(parsed)),
    erasedHash: memoryCalendarErasedHash(parsed),
  };
}

export function memoryCalendarPublicationHash(record: MemoryCalendarRecord): string {
  return record.schemaVersion === 2
    ? hashPayload(JSON.stringify(record.integrity))
    : hashPayload(JSON.stringify(record.state));
}

export function isFullyErasedMemoryCalendarState(state: MemoryCalendarState): boolean {
  for (const result of state.results) {
    if (result.schemaVersion === 3) continue;
    if (result.resultRef.storage === 'retained') return false;
    if (result.resultRef.source.redactedAt === null) return false;
    if (result.resultRef.source.targets.some(t => t.calendarLabel !== null)) return false;
  }
  for (const decision of state.decisions) {
    if (!decision.decision) {
      if (decision.sources.some(s => s.redactedAt === null || s.targets.some(t => t.calendarLabel !== null))) return false;
      continue;
    }
    if (decision.decision.kind === 'text') {
      if (decision.sources.length > 0) return false;
      continue;
    }
    if (decision.decision.kind === 'call_tool' && decision.decision.envelope.plugin === 'google-calendar') {
      if (decision.sources.length > 0 || !isDeepStrictEqual(decision.decision.envelope.arguments, {})) return false;
      continue;
    }
    if (decision.decision.assistantContent !== null || decision.sources.length > 0) return false;
  }
  return true;
}

export function verifyMemoryCalendarRecordIntegrity(
  record: MemoryCalendarRecord,
  expectedContentHash?: string,
): boolean {
  const parsed = memoryCalendarRecordSchema.safeParse(record);
  if (!parsed.success) return false;
  const r = parsed.data;
  if (r.schemaVersion === 1) {
    return expectedContentHash === undefined || memoryCalendarPublicationHash(r) === expectedContentHash;
  }
  if (expectedContentHash === undefined || memoryCalendarPublicationHash(r) !== expectedContentHash) return false;
  if (r.redactedAt === null) {
    return hashPayload(JSON.stringify(r.state)) === r.integrity.stateHash;
  }
  return isFullyErasedMemoryCalendarState(r.state) && memoryCalendarErasedHash(r.state) === r.integrity.erasedHash;
}

export function memoryCalendarGroups(state: MemoryCalendarState, now: number): ReturnType<typeof skillGroup>[] {
  const parsed = memoryCalendarStateSchema.parse(state);
  for (const decision of parsed.decisions) {
    if (!decision.decision || decision.decision.kind === 'text') continue;
    if (!parsed.results.some(r => r.decisionId === decision.decisionId) &&
        parsed.terminalCall?.decisionId !== decision.decisionId) {
      throw new AppError('INVALID_REQUEST', 'Calendar history is incomplete.');
    }
  }
  const seen = new Set<string>();
  return [...parsed.results].sort((a, b) => a.sequence - b.sequence).map(result => {
    const decision = parsed.decisions.find(d => d.decisionId === result.decisionId)?.decision;
    if (!decision || decision.kind === 'text' || seen.has(result.toolCallId)) {
      throw new AppError('INVALID_REQUEST', 'Calendar history is incomplete.');
    }
    seen.add(result.toolCallId);
    if (result.schemaVersion === 3) return skillGroup(decision, result.resultRef.content, []);
    if (result.resultRef.storage === 'retained' && !calendarSourceExpired(result.resultRef.source, now)) {
      return skillGroup(decision, JSON.stringify(result.resultRef.result), [result.resultRef.source]);
    }
    return skillGroup(decision, unavailableResultContent(), []);
  });
}

export function sanitizeToolDecisionForVolatileHistory<
  T extends Exclude<ResumableSkillDecision['decision'], null | { kind: 'text' }>,
>(decision: T): T {
  if (decision.kind === 'call_tool' && decision.envelope.plugin === 'google-calendar') {
    const envelope = { plugin: 'google-calendar' as const, tool: decision.envelope.tool, arguments: {} };
    return {
      ...decision,
      assistantContent: null,
      envelope,
      nativeCall: {
        ...decision.nativeCall,
        function: { ...decision.nativeCall.function, arguments: JSON.stringify(envelope) },
      },
    };
  }
  return { ...decision, assistantContent: null };
}

export function eraseMemoryCalendarState(
  state: MemoryCalendarState,
  now: number,
  reason: 'expired' | 'disconnected' | 'not-permitted',
): MemoryCalendarState {
  const parsed = memoryCalendarStateSchema.parse(state);
  const decisions = parsed.decisions.map(decision => {
    const sources = decision.sources.map(source => redactCalendarSource(source, now));
    if (!decision.decision) return { ...decision, sources };
    if (decision.decision.kind === 'text') {
      return decision.sources.length > 0 ? { ...decision, decision: null, sources } : decision;
    }
    if (decision.decision.kind === 'call_tool' && decision.decision.envelope.plugin === 'google-calendar') {
      return {
        ...decision,
        sources: [],
        decision: sanitizeToolDecisionForVolatileHistory(decision.decision),
      };
    }
    return { ...decision, sources, decision: sanitizeToolDecisionForVolatileHistory(decision.decision) };
  });
  const results = parsed.results.map(result => {
    if (result.schemaVersion === 3) return result;
    const source = redactCalendarSource(result.resultRef.source, now);
    const resultRef = result.resultRef.storage === 'retained'
      ? { storage: 'tombstone' as const, source, toolCallId: result.resultRef.toolCallId,
          operationId: result.resultRef.operationId, reason }
      : { ...result.resultRef, source };
    return { ...result, resultRef };
  });
  return memoryCalendarStateSchema.parse({ ...parsed, decisions, results });
}

export function stateMatchesAccount(state: MemoryCalendarState, account: {
  userId: string; connectionId: string; connectionRevision: number;
}): boolean {
  if (state.budget.userId !== account.userId) return false;
  return state.results.some(result => result.schemaVersion === 2
      && result.resultRef.source.connectionId === account.connectionId
      && result.resultRef.source.connectionRevision === account.connectionRevision)
    || state.decisions.some(decision =>
      (decision.connectionId === account.connectionId && decision.connectionRevision === account.connectionRevision
        && decision.decision?.kind === 'call_tool' && decision.decision.envelope.plugin === 'google-calendar')
      || decision.sources.some(source =>
        source.connectionId === account.connectionId && source.connectionRevision === account.connectionRevision));
}

export function stateHasExpiredSource(state: MemoryCalendarState, now: number): boolean {
  return state.results.some(result => result.schemaVersion === 2
      && (result.resultRef.storage === 'retained' || result.resultRef.source.redactedAt === null)
      && calendarSourceExpired(result.resultRef.source, now))
    || state.decisions.some(decision => decision.sources.some(source => calendarSourceExpired(source, now)));
}

export function eraseMemoryCalendarStateForAccount(
  state: MemoryCalendarState,
  account: { userId: string; connectionId: string; connectionRevision: number },
  now: number,
  reason: 'disconnected' | 'not-permitted' = 'disconnected',
): MemoryCalendarState {
  return stateMatchesAccount(state, account) ? eraseMemoryCalendarState(state, now, reason) : state;
}

export function eraseExpiredMemoryCalendarState(state: MemoryCalendarState, now: number): MemoryCalendarState {
  return stateHasExpiredSource(state, now) ? eraseMemoryCalendarState(state, now, 'expired') : state;
}

export class MemoryCalendarStage {
  private readonly decisions = new Map<string, ResumableSkillDecision>();
  private readonly results = new Map<string, MemorySkillResult>();
  private readonly rejected = new Map<string, CalendarRejectedDecisionV2>();
  private terminalCall: MemoryTerminalCall | null = null;
  constructor(private readonly maxBytes: number, private readonly maxRecords: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 8)
      throw new Error('Invalid native memory bounds.');
  }
  private capacity<T>(map: Map<string, T>, id: string, value: T): T | null {
    const old = map.get(id);
    if (old && !isDeepStrictEqual(old, value)) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Native decision identity changed.');
    if (old) return null;
    if (map.size >= this.maxRecords || Buffer.byteLength(JSON.stringify(this.records()), 'utf8') +
        Buffer.byteLength(JSON.stringify(value), 'utf8') > this.maxBytes)
      throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The native memory budget is exhausted.', false);
    return structuredClone(value);
  }
  private put<T>(map: Map<string, T>, id: string, value: T): void {
    const next = this.capacity(map, id, value);
    if (next !== null) map.set(id, next);
  }
  putDecision(record: ResumableSkillDecision) {
    const parsed = resumableSkillDecisionSchema.parse(record); this.put(this.decisions, parsed.decisionId, parsed);
  }
  putResult(record: MemorySkillResult) {
    const parsed = memoryResultSchema.parse(record); this.put(this.results, parsed.toolCallId, parsed);
  }
  /** Read-only capacity/identity check used before a presentation effect. */
  assertResultCapacity(record: MemorySkillResult): void {
    const parsed = memoryResultSchema.parse(record);
    this.capacity(this.results, parsed.toolCallId, parsed);
  }
  putRejected(record: CalendarRejectedDecisionV2) {
    const parsed = rejectedDecisionV2Schema.parse(record); this.put(this.rejected, parsed.decisionId, parsed);
  }
  putTerminalCall(record: MemoryTerminalCall): void {
    const parsed = terminalCallSchema.parse(record);
    if (this.terminalCall && !isDeepStrictEqual(this.terminalCall, parsed)) {
      throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Native terminal call identity changed.');
    }
    if (this.terminalCall) return;
    if (Buffer.byteLength(JSON.stringify(this.records()), 'utf8') +
        Buffer.byteLength(JSON.stringify(parsed), 'utf8') > this.maxBytes) {
      throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The native memory budget is exhausted.', false);
    }
    this.terminalCall = structuredClone(parsed);
  }
  /** Pins previously unbound decisions once to a resolved prepared account. */
  bindConnection(connectionId: string, connectionRevision: number): void {
    for (const [id, decision] of this.decisions) {
      if (decision.connectionId === 'memory-unbound') {
        this.decisions.set(id, resumableSkillDecisionSchema.parse({
          ...decision, connectionId, connectionRevision,
        }));
      } else if (decision.connectionId !== connectionId || decision.connectionRevision !== connectionRevision) {
        throw new AppError('NOT_READY', 'Calendar access has changed.', false);
      }
    }
  }
  getDecision(id: string) { return structuredClone(this.decisions.get(id) ?? null); }
  records() {
    return structuredClone({
      decisions: [...this.decisions.values()],
      results: [...this.results.values()],
      rejected: [...this.rejected.values()],
      ...(this.terminalCall ? { terminalCall: this.terminalCall } : {}),
    });
  }
}
