/**
 * ============================================================================
 * FILE: memory-text-archive.ts
 * LOCATION: backend/src/persistence/memory-text-archive.ts
 * ============================================================================
 * PURPOSE: Project terminal conversation and voice accounting through the native store.
 * ROLE IN PROJECT: Save-only adapter; shares ownership/client and never invokes inference.
 * KEY COMPONENTS: Immutable terminal IDs, ordered dependencies, checkpoint and visibility CAS.
 * ============================================================================
 */
import { isDeepStrictEqual } from 'node:util';
import type { Document } from 'mongodb';
import type { ZodType, ZodTypeDef } from 'zod';
import type { PersistenceBundle } from './persistence.js';
import type { FixedAssets } from '../instructions/fixed-assets.js';
import {
  memoryCalendarMutationSchema, projectMemoryCalendarMutationPrivacy,
  type MemoryCalendarMutation, type SaveTerminal, type TerminalEnvelope, type SaveOutcome,
  type SaveVoiceObservation, type CompactionEnvelope, type SaveEnvelope,
} from '../chat-runtime/memory-first-foundation.js';
import { redactSummaryCalendar } from '../contracts/agent-memory.js';
import { voiceAccountingRecordSchema } from '../contracts/voice-accounting.js';
import { voiceDeliveryRecordSchema } from '../contracts/voice.js';
import { attemptRecordSchema, type AttemptRecord } from '../contracts/attempt.js';
import { accountingRecordSchema } from '../contracts/metadata.js';
import { modelAggregateSchema } from '../contracts/calendar-accounting.js';
import { resumableSkillDecisionSchema, type ResumableSkillDecision } from '../contracts/calendar-model.js';
import {
  calendarToolResultRecordV2Schema,
  type CalendarSourceReference, type CalendarSourceReferenceV2, type CalendarToolResultRecordV2,
} from '../contracts/calendar-sources.js';
import { messageRecordSchema, type MessageRecord } from '../contracts/message.js';
import type { CalendarAccountBinding } from '../contracts/calendar-discovery.js';
import type { SessionRecord } from '../contracts/session.js';
import type { ExecutionLease } from '../contracts/repositories.js';
import {
  aggregateKey, calendarSourceExpired, decodeCalendar, decisionKey, encodeCalendar,
  readCurrentCalendarAccountBinding, redactCalendarMessage, redactCalendarSource, resultKey,
} from './calendar-records.js';
import { acceptanceSchema, bounded, graphThreadId, key } from './records.js';
import { buildReferenceManifest } from '../context/reference-selection.js';
import { buildTurnGraph } from '../agent/turn-graph.js';
import { boundaryFor } from '../agent/state.js';
import { graphConfig } from '../chat-runtime/finalization.js';
import { hashPayload } from '../platform/crypto/hash-payload.js';
import { titleFor } from '../chat-runtime/identity.js';
import { memoryWebRecordId, memoryWebRecordSchema } from './memory-web-records.js';
import { AppError } from '../platform/errors/app-error.js';
import {
  eraseMemoryCalendarState, isCalendarBearingState, isFullyErasedMemoryCalendarState,
  memoryCalendarIntegrity, memoryCalendarPublicationHash, memoryCalendarRecordSchema,
  memoryCalendarStateSchema, stateHasExpiredSource, stateMatchesAccount,
  verifyMemoryCalendarRecordIntegrity, type MemoryCalendarRecord, type MemoryCalendarState,
} from '../chat-runtime/memory-calendar-state.js';

function nativeRedactedAt(state: MemoryCalendarState, fallback: string): string | null {
  if (!isFullyErasedMemoryCalendarState(state)) return null;
  const stamps = [
    ...state.results.flatMap(r => r.schemaVersion === 2 && r.resultRef.source.redactedAt ? [r.resultRef.source.redactedAt] : []),
    ...state.decisions.flatMap(d => d.sources.flatMap(s => s.redactedAt ? [s.redactedAt] : [])),
  ].sort();
  return stamps.at(-1) ?? (isCalendarBearingState(state) ? fallback : null);
}

function sourceUnavailable(
  source: CalendarSourceReference | CalendarSourceReferenceV2,
  account: CalendarAccountBinding | null,
  atMs: number,
): boolean {
  return calendarSourceExpired(source, atMs)
    || !account
    || source.connectionId !== account.connectionId
    || source.connectionRevision !== account.connectionRevision;
}

function projectOutputPrivacy(
  output: MessageRecord,
  account: CalendarAccountBinding | null,
  atMs: number,
): MessageRecord {
  const parsed = messageRecordSchema.parse(output);
  if (!parsed.sourceProvenance?.length) return parsed;
  const nextProvenance = parsed.sourceProvenance.map(source =>
    sourceUnavailable(source, account, atMs) ? redactCalendarSource(source, atMs) : source);
  if (isDeepStrictEqual(nextProvenance, parsed.sourceProvenance)) return parsed;
  return redactCalendarMessage(messageRecordSchema.parse({ ...parsed, sourceProvenance: nextProvenance }), atMs);
}

function projectNativeStatePrivacy(
  state: MemoryCalendarState,
  account: CalendarAccountBinding | null,
  atMs: number,
): MemoryCalendarState {
  if (!isCalendarBearingState(state)) return state;
  const expired = stateHasExpiredSource(state, atMs);
  const authorized = account !== null && stateMatchesAccount(state, account);
  if (!expired && authorized && !isFullyErasedMemoryCalendarState(state)) return state;
  return eraseMemoryCalendarState(state, atMs, !authorized ? 'disconnected' : 'expired');
}

function buildNativeRecord(
  e: TerminalEnvelope,
  state: MemoryCalendarState,
  integrity: TerminalEnvelope['calendarIntegrity'] | undefined,
  fallbackRedactedAt: string,
): MemoryCalendarRecord {
  return memoryCalendarRecordSchema.parse(
    integrity
      ? {
          schemaVersion: 2, kind: 'memory-calendar-native',
          userId: e.userId, sessionId: e.sessionId, turnId: e.request.turnId, attemptId: e.request.attemptId,
          epoch: e.epoch, version: e.version, fence: e.fence,
          integrity, redactedAt: nativeRedactedAt(state, fallbackRedactedAt), state,
        }
      : {
          schemaVersion: 1, kind: 'memory-calendar-native',
          userId: e.userId, sessionId: e.sessionId, turnId: e.request.turnId, attemptId: e.request.attemptId,
          epoch: e.epoch, version: e.version, fence: e.fence, state,
        },
  );
}

function mergeMonotonicMessage(existing: MessageRecord, expected: MessageRecord): MessageRecord {
  const { sourceProvenance: exProv, memoryUpdated: exMemory, ...exBase } = existing;
  const { sourceProvenance: expProv, ...expBase } = expected;
  if (!isDeepStrictEqual(exBase, expBase)) {
    throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
  }
  const left = exProv ?? [];
  const right = expProv ?? [];
  if (left.length !== right.length) {
    throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
  }
  const merged = left.map((exSrc, i) => {
    const expSrc = right[i]!;
    if (exSrc.redactedAt === null && expSrc.redactedAt === null) {
      if (!isDeepStrictEqual(exSrc, expSrc)) {
        throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
      }
      return exSrc;
    }
    const normEx = { ...redactCalendarSource(exSrc, 0), redactedAt: 'canonical' };
    const normExp = { ...redactCalendarSource(expSrc, 0), redactedAt: 'canonical' };
    if (!isDeepStrictEqual(normEx, normExp)) {
      throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
    }
    return exSrc.redactedAt !== null ? exSrc : expSrc;
  });
  return merged.length > 0 ? messageRecordSchema.parse({ ...existing, sourceProvenance: merged }) : existing;
}

export class MemoryTextArchive {
  private readonly uncertainReleases = new Map<string, ExecutionLease>();
  private readonly activeCounts = new Map<string, number>();
  constructor(
    private readonly p: PersistenceBundle,
    private readonly assets: FixedAssets,
    private readonly now: () => number = Date.now,
  ) {
    if (!p.owner.store || typeof p.owner.store.read !== 'function' || typeof p.owner.store.insert !== 'function')
      throw new AppError('NOT_READY', 'Terminal saving is unavailable.');
  }
  private sessionKey(userId: string, sessionId: string): string {
    return key('session', userId, sessionId);
  }
  ownsSession(userId: string, sessionId: string): boolean {
    const sk = this.sessionKey(userId, sessionId);
    return (this.activeCounts.get(sk) ?? 0) > 0 || this.uncertainReleases.has(sk);
  }
  readonly saveVoiceObservation: SaveVoiceObservation = async (record, limits) => {
    const store = this.p.owner.store!;
    try {
      if (limits.maxOperations < 3 || record.status === 'pending') return 'failed';
      const id = key('voice-accounting', record.userId, record.sessionId, record.usageId);
      const expected = bounded(voiceAccountingRecordSchema, record, id,
        Math.min(limits.maxBytes, this.p.metadata.budgets.maxDocumentBytes)).record;
      await this.p.owner.assertExecutor();
      const old = await store.read('metadata', voiceAccountingRecordSchema, { _id: id, userId: record.userId, sessionId: record.sessionId });
      if (old) return isDeepStrictEqual(old, expected) ? 'saved' : 'failed';
      await store.insert('metadata', voiceAccountingRecordSchema, expected, id, Math.min(limits.maxBytes, this.p.metadata.budgets.maxDocumentBytes));
      return 'saved';
    } catch (error) {
      return error instanceof AppError && ['INVALID_REQUEST', 'STORAGE_BUDGET_EXCEEDED'].includes(error.code) ? 'failed' : 'unknown';
    }
  };
  readonly save: SaveTerminal = async (e, limits) => {
    const sk = this.sessionKey(e.userId, e.sessionId);
    let outcome: SaveOutcome;
    try {
      outcome = 'kind' in e && e.kind === 'compaction'
        ? await this.projectCompaction(e, limits)
        : await this.project(e as TerminalEnvelope, limits);
    }
    catch { outcome = { kind: 'unknown', retryable: true }; }
    return this.uncertainReleases.has(sk) ? { kind: 'unknown', retryable: true } : outcome;
  };
  private async project(e: TerminalEnvelope, limits: Parameters<SaveTerminal>[1]): Promise<SaveOutcome> {
    const p = this.p, store = p.owner.store;
    const sk = this.sessionKey(e.userId, e.sessionId);
    let operations = 0, writeBytes = 0;
    const op = async <T>(action: () => Promise<T>): Promise<T> => {
      if (++operations > limits.maxOperations) throw new AppError('STORAGE_BUDGET_EXCEEDED', 'Save operation budget exceeded.');
      return action();
    };
    const charge = (value: unknown) => {
      writeBytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (writeBytes > limits.maxBytes) throw new AppError('STORAGE_BUDGET_EXCEEDED', 'Save byte budget exceeded.');
    };
    let lease: ExecutionLease | undefined;
    let counted = false;
    try {
      if (!store || (e.request.mode === 'live') !== Boolean(e.delivery)) return { kind: 'failed', retryable: false };
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const baseCalendar = e.calendar ? memoryCalendarStateSchema.parse(e.calendar) : undefined;
      const integrity = baseCalendar
        ? (e.calendarIntegrity ?? (isCalendarBearingState(baseCalendar) ? memoryCalendarIntegrity(baseCalendar) : undefined))
        : undefined;
      const baseNative = baseCalendar ? buildNativeRecord(e, baseCalendar, integrity, e.output.createdAt) : undefined;
      if (e.request.config.instructionVersion !== this.assets.instructionVersion ||
          e.request.config.knowledgeContentHash !== this.assets.knowledgeContentHash ||
          e.request.config.graphSchemaVersion !== this.assets.graphSchemaVersion) return { kind: 'failed', retryable: false };
      const previousLease = this.uncertainReleases.get(sk);
      if (previousLease) { await p.owner.release(previousLease); this.uncertainReleases.delete(sk); }
      const scope = { userId: e.userId, sessionId: e.sessionId };
      const needsAuthority = Boolean((baseCalendar && isCalendarBearingState(baseCalendar))
        || e.output.sourceProvenance?.length || e.calendarMutation);
      let currentAccount = needsAuthority ? await op(() => readCurrentCalendarAccountBinding(store, e.userId)) : null;
      let session = await op(() => p.sessions.get(e.userId, e.sessionId));
      if (!session) {
        if (e.previousVersion !== 0) return { kind: 'failed', retryable: false };
        const record: SessionRecord = { schemaVersion: 1, ...scope,
          title: titleFor(e.input.content, p.sessions.budgets.titleMaxChars), createdAt: e.input.createdAt,
          updatedAt: e.input.createdAt, lastActivityAt: e.input.createdAt, lifecycle: 'active',
          graphThreadId: graphThreadId(e.userId, e.sessionId), latestTurnId: null,
          execution: { ownerId: null, leaseExpiresAt: null, activeAttemptId: null, generation: 0 },
          memoryPublication: { version: 0, sequence: 0, epoch: e.epoch, fence: e.fence },
          ...(e.request.ephemeral === true ? { ephemeral: true } : {}) };
        charge(record); session = await op(() => p.sessions.createIfAbsent(record));
      }
      if (session.lifecycle !== 'active') return { kind: 'failed', retryable: false };
      if ((session.ephemeral === true) !== (e.request.ephemeral === true)) return { kind: 'failed', retryable: false };
      if (session.execution.activeAttemptId !== null) return { kind: 'unknown', retryable: true };
      const published = session.memoryPublication;
      if (published && published.version < e.previousVersion) return { kind: 'failed', retryable: false };
      this.activeCounts.set(sk, (this.activeCounts.get(sk) ?? 0) + 1);
      counted = true;
      const acquired = await op(() => p.owner.acquire({ ...scope, ownerId: p.owner.executorId, leaseMs: 180_000 }));
      if (!acquired.ok) return { kind: 'failed', retryable: true };
      lease = acquired.lease;
      const owned = lease;
      const attempt = attemptRecordSchema.parse({ schemaVersion: 1, kind: 'attempt', ...scope,
        turnId: e.request.turnId, attemptId: e.request.attemptId, idempotencyKey: e.request.requestKey,
        payloadHash: hashPayload(e.input.content), calendarReplyTo: e.request.calendarReplyTo,
        ...(baseNative ? { nativePublication: { epoch: baseNative.epoch, version: baseNative.version, fence: baseNative.fence,
          contentHash: memoryCalendarPublicationHash(baseNative) } } : {}),
        status: e.status, sequence: e.request.sequence + 2, createdAt: e.request.createdAt,
        updatedAt: e.accounting?.endedAt ?? e.request.createdAt,
        instructionVersion: e.request.config.instructionVersion, knowledgeContentHash: e.request.config.knowledgeContentHash,
        graphSchemaVersion: e.request.config.graphSchemaVersion, contextVersion: e.previousVersion,
        modelId: e.request.config.modelId, openRouterUser: e.userId, generationId: e.accounting?.generationId ?? null,
        truncated: e.status === 'truncated', errorCode: e.status === 'cancelled' ? 'CANCELLED'
          : e.status === 'interrupted' ? 'INTERRUPTED' : e.status === 'failed' ? 'PROVIDER_ERROR' : null,
        causal: { userMessageId: e.input.messageId, previousAttemptId: e.request.retryOf?.previousAttemptId ?? null } });
      const marker = acceptanceSchema.parse({ schemaVersion: 1, kind: 'acceptance', ...scope,
        turnId: attempt.turnId, attemptId: attempt.attemptId, userMessageId: e.input.messageId, payloadHash: attempt.payloadHash });
      let input = e.input;
      if (e.request.retryOf) {
        const existing = await op(() => p.messages.get(e.userId, e.sessionId, e.input.messageId));
        if (!existing || existing.role !== 'user' || existing.turnId !== input.turnId || existing.content !== input.content ||
            existing.eventId !== input.eventId || existing.sequence !== e.request.retryOf.sequence)
          return { kind: 'failed', retryable: false };
        input = existing;
      }
      let output = needsAuthority ? projectOutputPrivacy(e.output, currentAccount, nowMs) : e.output;
      let calendar = baseCalendar ? projectNativeStatePrivacy(baseCalendar, currentAccount, nowMs) : undefined;
      let native = calendar ? buildNativeRecord(e, calendar, integrity, nowIso) : undefined;
      let mutation: MemoryCalendarMutation | undefined = e.calendarMutation
        ? projectMemoryCalendarMutationPrivacy(memoryCalendarMutationSchema.parse(e.calendarMutation), currentAccount, nowMs)
        : undefined;
      const values: unknown[] = [input, output, attempt, marker, ...(e.accounting ? [e.accounting] : []),
        ...(e.delivery ? [e.delivery] : []), ...(native ? [native] : []),
        ...(e.web ? [memoryWebRecordSchema.parse(e.web)] : []),
        ...(mutation ? [
          mutation.result,
          ...(mutation.decision ? [mutation.decision] : []),
          ...(mutation.aggregate ? [mutation.aggregate] : []),
        ] : [])];
      values.forEach(charge);
      const ensure = async <T extends Document>(collection: string, schema: ZodType<T, ZodTypeDef, unknown>,
        value: T, id: string, maxBytes: number) => {
        const expected = bounded(schema, value, id, maxBytes).record;
        const existing = await op(() => store.read(collection, schema, { _id: id, ...scope }));
        if (existing) {
          if (!isDeepStrictEqual(existing, expected)) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
          return;
        }
        await op(() => p.owner.run(owned, () => store.insert(collection, schema, expected, id, maxBytes)));
      };
      const casReplace = async <T extends Document>(
        collection: string,
        schema: ZodType<T, ZodTypeDef, unknown>,
        value: T,
        oldDoc: Document,
        id: string,
        maxBytes: number,
      ): Promise<boolean> => {
        const { doc } = encodeCalendar(schema, value, id, maxBytes);
        doc._revision = Number(oldDoc._revision) + 1;
        const res = await op(() => p.owner.run(owned, () => store.collection(collection).replaceOne(
          { _id: id, ...scope, _revision: oldDoc._revision }, doc, store.options(),
        )));
        return Boolean(res.acknowledged && res.matchedCount === 1);
      };
      const ensureMessage = async (value: MessageRecord, id: string, maxBytes: number): Promise<boolean> => {
        const expected = bounded(messageRecordSchema, value, id, maxBytes).record;
        const existingDoc = await op(() => store.raw('messages', { _id: id, ...scope }));
        if (!existingDoc) {
          await op(() => p.owner.run(owned, () => store.insert('messages', messageRecordSchema, expected, id, maxBytes)));
          return true;
        }
        const existing = decodeCalendar(messageRecordSchema, existingDoc);
        if (!existing) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
        const merged = mergeMonotonicMessage(existing, expected);
        if (isDeepStrictEqual(merged, existing)) return true;
        return casReplace('messages', messageRecordSchema, merged, existingDoc, id, maxBytes);
      };
      const ensureNative = async (value: MemoryCalendarRecord, id: string, maxBytes: number): Promise<boolean> => {
        const expected = bounded(memoryCalendarRecordSchema, value, id, maxBytes).record;
        const existingDoc = await op(() => store.raw('metadata', { _id: id, ...scope }));
        if (!existingDoc) {
          await op(() => p.owner.run(owned, () => store.insert('metadata', memoryCalendarRecordSchema, expected, id, maxBytes)));
          return true;
        }
        const existing = decodeCalendar(memoryCalendarRecordSchema, existingDoc);
        if (!existing || existing.schemaVersion !== expected.schemaVersion
          || existing.userId !== expected.userId || existing.sessionId !== expected.sessionId
          || existing.turnId !== expected.turnId || existing.attemptId !== expected.attemptId
          || existing.epoch !== expected.epoch || existing.version !== expected.version
          || existing.fence !== expected.fence) {
          throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
        }
        if (existing.schemaVersion === 1 || expected.schemaVersion === 1) {
          if (!isDeepStrictEqual(existing, expected)) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
          return true;
        }
        if (!isDeepStrictEqual(existing.integrity, expected.integrity)) {
          throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
        }
        const pubHash = memoryCalendarPublicationHash(expected);
        if (!verifyMemoryCalendarRecordIntegrity(expected, pubHash)) {
          throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
        }
        if (existing.redactedAt !== null) {
          if (isFullyErasedMemoryCalendarState(existing.state) && verifyMemoryCalendarRecordIntegrity(existing, pubHash)) {
            return true;
          }
          if (expected.redactedAt !== null) {
            return casReplace('metadata', memoryCalendarRecordSchema, expected, existingDoc, id, maxBytes);
          }
          throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
        }
        if (expected.redactedAt !== null) {
          return casReplace('metadata', memoryCalendarRecordSchema, expected, existingDoc, id, maxBytes);
        }
        if (!isDeepStrictEqual(existing, expected)) {
          throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
        }
        return true;
      };
      const decodeDoc = <T>(schema: ZodType<T, ZodTypeDef, unknown>, doc: Document): T | null => {
        try {
          return schema.parse(Object.fromEntries(Object.entries(doc).filter(([k]) => k !== '_id' && k !== '_revision')));
        } catch {
          return null;
        }
      };
      const ensureAttempt = async (value: AttemptRecord, id: string, maxBytes: number): Promise<boolean> => {
        const expected = bounded(attemptRecordSchema, value, id, maxBytes).record;
        const existingDoc = await op(() => store.raw('metadata', { _id: id, ...scope }));
        if (!existingDoc) {
          await op(() => p.owner.run(owned, () => store.insert('metadata', attemptRecordSchema, expected, id, maxBytes)));
          return true;
        }
        const existing = decodeDoc(attemptRecordSchema, existingDoc);
        if (!existing) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
        if (isDeepStrictEqual(existing, expected)) return true;
        const immutableSame = existing.userId === expected.userId && existing.sessionId === expected.sessionId
          && existing.turnId === expected.turnId && existing.attemptId === expected.attemptId
          && existing.idempotencyKey === expected.idempotencyKey && existing.payloadHash === expected.payloadHash
          && existing.sequence === expected.sequence && existing.createdAt === expected.createdAt
          && existing.modelId === expected.modelId && existing.openRouterUser === expected.openRouterUser
          && existing.contextVersion === expected.contextVersion && existing.instructionVersion === expected.instructionVersion
          && existing.knowledgeContentHash === expected.knowledgeContentHash && existing.graphSchemaVersion === expected.graphSchemaVersion
          && isDeepStrictEqual(existing.causal, expected.causal)
          && isDeepStrictEqual(existing.calendarReplyTo ?? null, expected.calendarReplyTo ?? null)
          && isDeepStrictEqual(existing.nativePublication ?? null, expected.nativePublication ?? null);
        if (!immutableSame || !['accepted', 'generating', 'finalizing'].includes(existing.status)) {
          throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
        }
        let currentDoc: Document = existingDoc;
        if (existing.status === 'accepted') {
          const generating = attemptRecordSchema.parse({ ...existing, status: 'generating', updatedAt: expected.updatedAt });
          if (!await casReplace('metadata', attemptRecordSchema, generating, currentDoc, id, maxBytes)) return false;
          const refreshed = await op(() => store.raw('metadata', { _id: id, ...scope }));
          if (!refreshed) return false;
          currentDoc = refreshed;
        }
        if (currentDoc.status === 'generating') {
          const decodedGenerating = decodeDoc(attemptRecordSchema, currentDoc);
          if (!decodedGenerating) return false;
          const finalizing = attemptRecordSchema.parse({ ...decodedGenerating, status: 'finalizing', updatedAt: expected.updatedAt });
          if (!await casReplace('metadata', attemptRecordSchema, finalizing, currentDoc, id, maxBytes)) return false;
          const refreshed = await op(() => store.raw('metadata', { _id: id, ...scope }));
          if (!refreshed) return false;
          currentDoc = refreshed;
        }
        return casReplace('metadata', attemptRecordSchema, expected, currentDoc, id, maxBytes);
      };
      // All dependencies are absolute immutable or monotonically redacted terminal
      // records; retries re-check authority and never restore unredacted Calendar evidence.
      const outputId = key('message', e.userId, e.sessionId, output.messageId);
      const nativeId = key('memory-calendar-native', e.userId, e.sessionId, attempt.attemptId);
      await ensure('messages', messageRecordSchema, input,
        key('message', e.userId, e.sessionId, input.messageId), p.messages.budgets.maxMessageBytes);
      if (!await ensureMessage(output, outputId, p.messages.budgets.maxMessageBytes)) {
        return { kind: 'unknown', retryable: true };
      }
      if (!await ensureAttempt(attempt, key('attempt', e.userId, e.sessionId, attempt.idempotencyKey),
        p.metadata.budgets.maxDocumentBytes)) {
        return { kind: 'unknown', retryable: true };
      }
      if (e.accounting) await ensure('metadata', accountingRecordSchema, e.accounting,
        key('accounting', e.userId, e.sessionId, attempt.attemptId), p.metadata.budgets.maxDocumentBytes);
      await ensure('metadata', acceptanceSchema, marker,
        key('acceptance', e.userId, e.sessionId, attempt.attemptId), p.metadata.budgets.maxDocumentBytes);
      if (e.delivery) await ensure('metadata', voiceDeliveryRecordSchema, e.delivery,
        key('voice-delivery', e.userId, e.sessionId, attempt.attemptId), p.metadata.budgets.maxDocumentBytes);
      if (e.web) {
        const record = memoryWebRecordSchema.parse(e.web);
        await ensure('metadata', memoryWebRecordSchema, record,
          memoryWebRecordId(record.userId, record.sessionId, record.attemptId),
          Math.min(24_000, p.metadata.budgets.maxDocumentBytes));
      }
      const ensureMutationDecision = async (value: ResumableSkillDecision, id: string, maxBytes: number): Promise<boolean> => {
        const expected = bounded(resumableSkillDecisionSchema, value, id, maxBytes).record;
        const existingDoc = await op(() => store.raw('metadata', { _id: id, userId: e.userId }));
        if (!existingDoc) {
          await op(() => p.owner.run(owned, () => store.insert('metadata', resumableSkillDecisionSchema, expected, id, maxBytes)));
          return true;
        }
        const existing = decodeCalendar(resumableSkillDecisionSchema, existingDoc);
        if (!existing) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
        if (isDeepStrictEqual(existing, expected)) return true;
        const alreadyErased = existing.sources.every(s => s.redactedAt !== null)
          && (existing.decision === null
            || (existing.decision.kind === 'call_tool'
              ? isDeepStrictEqual(existing.decision.envelope.arguments, {})
              : existing.decision.kind !== 'text' && existing.decision.assistantContent === null));
        if (alreadyErased) return true;
        const nextErased = expected.sources.every(s => s.redactedAt !== null);
        if (nextErased) {
          return casReplace('metadata', resumableSkillDecisionSchema, expected, existingDoc, id, maxBytes);
        }
        throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
      };
      const ensureMutationResult = async (
        value: CalendarToolResultRecordV2,
        id: string,
        maxBytes: number,
        allowProviderRegistration: boolean,
      ): Promise<boolean> => {
        const expected = bounded(calendarToolResultRecordV2Schema, value, id, maxBytes).record;
        const existingDoc = await op(() => store.raw('metadata', { _id: id, ...scope }));
        if (!existingDoc) {
          if (allowProviderRegistration && expected.resultRef.source.redactedAt === null) {
            await op(() => p.owner.run(owned, () => p.calendarRetention.registerSource({
              userId: e.userId, sessionId: e.sessionId, source: expected.resultRef.source,
            })));
            await op(() => p.owner.run(owned, () => p.calendarResultsV2.put(expected)));
            return true;
          }
          await op(() => p.owner.run(owned, () => store.insert('metadata', calendarToolResultRecordV2Schema, expected, id, maxBytes)));
          return true;
        }
        const existing = decodeCalendar(calendarToolResultRecordV2Schema, existingDoc);
        if (!existing) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
        if (isDeepStrictEqual(existing, expected)) return true;
        if (existing.resultRef.source.redactedAt !== null) return true;
        if (expected.resultRef.source.redactedAt !== null) {
          return casReplace('metadata', calendarToolResultRecordV2Schema, expected, existingDoc, id, maxBytes);
        }
        throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved payload differs.');
      };
      if (native && !await ensureNative(native, nativeId, p.metadata.budgets.maxDocumentBytes)) {
        return { kind: 'unknown', retryable: true };
      }
      if (mutation) {
        if (mutation.decision && !await ensureMutationDecision(
          mutation.decision,
          decisionKey('calendar-model-decision', e.userId, mutation.decision.decisionId),
          p.metadata.budgets.maxDocumentBytes,
        )) {
          return { kind: 'unknown', retryable: true };
        }
        if (!await ensureMutationResult(
          mutation.result,
          resultKey(e.userId, e.sessionId, mutation.result.toolCallId),
          p.metadata.budgets.maxDocumentBytes,
          true,
        )) {
          return { kind: 'unknown', retryable: true };
        }
        if (mutation.aggregate) {
          const expectedDispatches = (calendar?.dispatches ?? []).map(d => d.dispatchId);
          if (!isDeepStrictEqual(mutation.aggregate.dispatchIds, expectedDispatches)) {
            return { kind: 'failed', retryable: false };
          }
          await ensure('metadata', modelAggregateSchema, mutation.aggregate,
            aggregateKey(e.userId, e.sessionId, attempt.turnId, attempt.attemptId),
            p.metadata.budgets.maxDocumentBytes);
        }
      }
      // Advance ordering absolutely so later legacy/live allocations cannot reuse
      // these sequences. No non-idempotent increment is retried.
      const counter = { schemaVersion: 1, kind: 'sequence-counter', ...scope, next: e.request.sequence + 3 };
      charge(counter);
      await op(() => p.owner.run(owned, async () => {
        const { next, ...base } = counter;
        await store.collection('metadata').updateOne({ _id: key('sequence-counter', e.userId, e.sessionId), ...scope },
          { $setOnInsert: { ...base, _revision: 0 }, $max: { next } }, { upsert: true, ...store.options() });
      }));
      const prior = await op(() => p.memory.get(e.userId, e.sessionId));
      if (prior && prior.contextVersion !== e.previousVersion && prior.contextVersion !== e.version)
        return { kind: 'failed', retryable: false };
      if (prior && !isDeepStrictEqual(prior.pinnedUserMemory, e.pinnedUserMemory))
        return { kind: 'failed', retryable: false };
      const activeSummaryRef = prior?.activeSummaryRef ?? null;
      const cut = activeSummaryRef?.sourceRange.toSequence ?? -1;
      const old = prior ? await op(() => p.messages.getReferences(e.userId, e.sessionId, prior.messageRefs)) : [];
      if (prior && old.length !== prior.messageRefs.length) return { kind: 'failed', retryable: false };
      const records = new Map(old.filter(r => r.sequence > cut).map(r => [r.messageId, r]));
      if (input.sequence > cut) records.set(input.messageId, input);
      if (output.sequence > cut) records.set(output.messageId, output);
      const target = buildReferenceManifest(e.userId, e.sessionId, e.version, [...records.values()], this.assets, p.memory.budgets, activeSummaryRef, e.pinnedUserMemory);
      charge(target);
      if (prior?.contextVersion === e.version && !isDeepStrictEqual(prior, target)) return { kind: 'failed', retryable: false };
      await op(() => p.owner.run(owned, () => p.memory.put(target)));
      // This background-only boundary makes final application history readable by
      // the unchanged durable voice/Calendar graph. It never generates an answer.
      const graph = buildTurnGraph((await op(() => p.checkpoints.create())).bind(owned), {
        prepare: async () => { throw new Error('Save-only graph'); }, generate: async () => { throw new Error('Save-only graph'); } });
      await op(() => graph.updateState(graphConfig(e.userId, e.sessionId), { input: null, result: null,
        sealed: false, rebase: null, calendarCursor: null, calendarSeal: null, calendarRefs: null,
        boundary: boundaryFor(target) }, 'seal'));
      if ((native?.schemaVersion === 2 && native.redactedAt === null)
        || (mutation && mutation.result.resultRef.source.redactedAt === null)
        || output.sourceProvenance?.some(s => s.redactedAt === null)) {
        const latestAccount = await op(() => readCurrentCalendarAccountBinding(store, e.userId));
        if (!isDeepStrictEqual(latestAccount, currentAccount)) {
          currentAccount = latestAccount;
          const recheckMs = this.now();
          const recheckIso = new Date(recheckMs).toISOString();
          output = projectOutputPrivacy(output, currentAccount, recheckMs);
          if (!await ensureMessage(output, outputId, p.messages.budgets.maxMessageBytes)) {
            return { kind: 'unknown', retryable: true };
          }
          if (calendar) {
            calendar = projectNativeStatePrivacy(calendar, currentAccount, recheckMs);
            native = buildNativeRecord(e, calendar, integrity, recheckIso);
            if (!await ensureNative(native, nativeId, p.metadata.budgets.maxDocumentBytes)) {
              return { kind: 'unknown', retryable: true };
            }
          }
          if (mutation) {
            mutation = projectMemoryCalendarMutationPrivacy(mutation, currentAccount, recheckMs);
            if (mutation.decision && !await ensureMutationDecision(
              mutation.decision,
              decisionKey('calendar-model-decision', e.userId, mutation.decision.decisionId),
              p.metadata.budgets.maxDocumentBytes,
            )) {
              return { kind: 'unknown', retryable: true };
            }
            if (!await ensureMutationResult(
              mutation.result,
              resultKey(e.userId, e.sessionId, mutation.result.toolCallId),
              p.metadata.budgets.maxDocumentBytes,
              false,
            )) {
              return { kind: 'unknown', retryable: true };
            }
          }
        }
      }
      const currentSession = await op(() => p.sessions.get(e.userId, e.sessionId));
      if (!currentSession || currentSession.lifecycle !== 'active') return { kind: 'failed', retryable: false };
      if (currentSession.execution.activeAttemptId !== null) return { kind: 'unknown', retryable: true };
      let preserveLatestTurnId = false;
      if (currentSession.latestTurnId && currentSession.latestTurnId !== e.request.turnId) {
        const latestAttemptDoc = await op(() => store.raw('metadata', {
          kind: 'attempt', ...scope, turnId: currentSession.latestTurnId,
        }));
        const latestAttemptRecord = latestAttemptDoc ? decodeDoc(attemptRecordSchema, latestAttemptDoc) : null;
        if (latestAttemptRecord && latestAttemptRecord.sequence > attempt.sequence) {
          preserveLatestTurnId = true;
        }
      }
      // A tombstone or another generation prevents publication. Update only the
      // fields this writer owns; preserve rename/pin and monotonic activity.
      const publication = { version: e.version, sequence: e.request.sequence + 2, epoch: e.epoch, fence: e.fence };
      charge(publication);
      const result = await op(() => p.owner.run(owned, () => store.collection('sessions').updateOne({
        _id: key('session', e.userId, e.sessionId), ...scope, lifecycle: 'active',
        'execution.ownerId': owned.ownerId, 'execution.generation': owned.generation,
        'execution.activeAttemptId': null,
        ...(preserveLatestTurnId ? {} : { latestTurnId: currentSession.latestTurnId }),
        ...(published ? { 'memoryPublication.version': published.version } : { memoryPublication: { $exists: false } }),
      }, { $set: { memoryPublication: publication, ...(preserveLatestTurnId ? {} : { latestTurnId: e.request.turnId }) },
        $max: { updatedAt: e.output.createdAt, lastActivityAt: e.output.createdAt }, $inc: { _revision: 1 } }, store.options())));
      if (!result.acknowledged || result.matchedCount !== 1) return { kind: 'unknown', retryable: true };
      // This is a qualified save acknowledgement, not a ConfirmedRecord minted
      // from volatile state. The raw adapter promise includes ownership release.
      return { kind: 'saved', epoch: e.epoch, sessionId: e.sessionId, version: e.version, fence: e.fence };
    } catch (error) {
      return error instanceof AppError && ['INVALID_REQUEST', 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'STORAGE_BUDGET_EXCEEDED'].includes(error.code)
        ? { kind: 'failed', retryable: false } : { kind: 'unknown', retryable: true };
    } finally {
      if (lease) {
        try { await p.owner.release(lease); this.uncertainReleases.delete(sk); }
        catch {
          this.uncertainReleases.set(sk, lease);
        }
      }
      if (counted) {
        const next = (this.activeCounts.get(sk) ?? 1) - 1;
        if (next <= 0) this.activeCounts.delete(sk);
        else this.activeCounts.set(sk, next);
      }
    }
  }

  private async projectCompaction(e: CompactionEnvelope, limits: Parameters<SaveTerminal>[1]): Promise<SaveOutcome> {
    const p = this.p, store = p.owner.store;
    const sk = this.sessionKey(e.userId, e.sessionId);
    let operations = 0, writeBytes = 0;
    const op = async <T>(action: () => Promise<T>): Promise<T> => {
      if (++operations > limits.maxOperations) throw new AppError('STORAGE_BUDGET_EXCEEDED', 'Save operation budget exceeded.');
      return action();
    };
    const charge = (value: unknown) => {
      writeBytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (writeBytes > limits.maxBytes) throw new AppError('STORAGE_BUDGET_EXCEEDED', 'Save byte budget exceeded.');
    };
    let lease: ExecutionLease | undefined;
    let counted = false;
    try {
      if (!store) return { kind: 'failed', retryable: false };
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const previousLease = this.uncertainReleases.get(sk);
      if (previousLease) { await p.owner.release(previousLease); this.uncertainReleases.delete(sk); }
      const scope = { userId: e.userId, sessionId: e.sessionId };
      let session = await op(() => p.sessions.get(e.userId, e.sessionId));
      if (!session || session.lifecycle !== 'active') return { kind: 'failed', retryable: false };
      if (session.execution.activeAttemptId !== null) return { kind: 'unknown', retryable: true };
      const published = session.memoryPublication;
      if (published && published.version === e.version
        && session.compactionCheckpoint?.summaryId === e.summary.summaryId) {
        if (e.pinnedUserMemory !== undefined) {
          const persisted = await op(() => p.memory.get(e.userId, e.sessionId));
          if (!persisted || !isDeepStrictEqual(persisted.pinnedUserMemory, e.pinnedUserMemory))
            return { kind: 'failed', retryable: false };
        }
        return { kind: 'saved', epoch: e.epoch, sessionId: e.sessionId, version: e.version, fence: e.fence };
      }
      if (published && published.version < e.previousVersion) return { kind: 'failed', retryable: false };
      this.activeCounts.set(sk, (this.activeCounts.get(sk) ?? 0) + 1);
      counted = true;
      const acquired = await op(() => p.owner.acquire({ ...scope, ownerId: p.owner.executorId, leaseMs: 180_000 }));
      if (!acquired.ok) return { kind: 'failed', retryable: true };
      lease = acquired.lease;
      const owned = lease;
      let currentAccount = await op(() => readCurrentCalendarAccountBinding(store, e.userId));
      let summary = e.summary;
      const provenance = summary.calendarProvenance;
      const bindingMismatch = provenance.containsCalendarContent && (
        !currentAccount
        || currentAccount.connectionId !== provenance.connectionId
        || currentAccount.connectionRevision !== provenance.connectionRevision
      );
      const expired = provenance.containsCalendarContent && provenance.earliestExpiresAt !== null
        && Date.parse(provenance.earliestExpiresAt) <= nowMs;
      if ((bindingMismatch || expired) && provenance.redactedAt === null) {
        summary = redactSummaryCalendar(summary, nowIso);
      }
      const checkpoint = summary.calendarProvenance.redactedAt
        ? { compactedThroughSequence: e.checkpoint.compactedThroughSequence, compactionCycle: e.checkpoint.compactionCycle }
        : e.checkpoint;
      charge(summary);
      try {
        await op(() => p.metadata.putCompactionSummary!(summary));
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'IDEMPOTENCY_PAYLOAD_MISMATCH') throw error;
        const redacted = await op(() => p.metadata.redactCompactionSummary!(e.userId, e.sessionId, summary.summaryId, nowIso));
        if (!redacted) throw error;
        summary = redacted;
      }
      const prior = await op(() => p.memory.get(e.userId, e.sessionId));
      if (prior && prior.contextVersion !== e.previousVersion && prior.contextVersion !== e.version)
        return { kind: 'failed', retryable: false };
      const old = prior ? await op(() => p.messages.getReferences(e.userId, e.sessionId, prior.messageRefs)) : [];
      if (prior && old.length !== prior.messageRefs.length) return { kind: 'failed', retryable: false };
      const tail = old.filter(r => r.sequence > summary.sourceRange.toSequence);
      const pin = e.pinnedUserMemory === undefined ? prior?.pinnedUserMemory : e.pinnedUserMemory;
      const target = buildReferenceManifest(
        e.userId, e.sessionId, e.version, tail, this.assets, p.memory.budgets,
        { summaryId: summary.summaryId, sourceRange: summary.sourceRange }, pin,
      );
      charge(target);
      if (prior?.contextVersion === e.version && !isDeepStrictEqual(prior, target)) return { kind: 'failed', retryable: false };
      await op(() => p.owner.run(owned, () => p.memory.put(target)));
      const graph = buildTurnGraph((await op(() => p.checkpoints.create())).bind(owned), {
        prepare: async () => { throw new Error('Save-only graph'); },
        generate: async () => { throw new Error('Save-only graph'); },
      });
      await op(() => graph.updateState(graphConfig(e.userId, e.sessionId), {
        input: null, result: null, sealed: false, rebase: null,
        calendarCursor: null, calendarSeal: null, calendarRefs: null,
        boundary: boundaryFor(target),
      }, 'seal'));
      const latestAccount = await op(() => readCurrentCalendarAccountBinding(store, e.userId));
      if (!isDeepStrictEqual(latestAccount, currentAccount) && summary.calendarProvenance.containsCalendarContent
        && summary.calendarProvenance.redactedAt === null) {
        const recheckIso = new Date(this.now()).toISOString();
        summary = redactSummaryCalendar(summary, recheckIso);
        await op(() => p.metadata.redactCompactionSummary!(e.userId, e.sessionId, summary.summaryId, recheckIso));
      }
      const currentSession = await op(() => p.sessions.get(e.userId, e.sessionId));
      if (!currentSession || currentSession.lifecycle !== 'active') return { kind: 'failed', retryable: false };
      if (currentSession.execution.activeAttemptId !== null) return { kind: 'unknown', retryable: true };
      const publication = {
        version: e.version,
        sequence: Math.max(published?.sequence ?? 0, e.sequence),
        epoch: e.epoch,
        fence: e.fence,
      };
      const compactionCheckpoint = { ...checkpoint, summaryId: summary.summaryId };
      charge(publication);
      const result = await op(() => p.owner.run(owned, () => store.collection('sessions').updateOne({
        _id: key('session', e.userId, e.sessionId), ...scope, lifecycle: 'active',
        'execution.ownerId': owned.ownerId, 'execution.generation': owned.generation,
        'execution.activeAttemptId': null,
        ...(published ? { 'memoryPublication.version': published.version } : { memoryPublication: { $exists: false } }),
      }, { $set: { memoryPublication: publication, compactionCheckpoint }, $inc: { _revision: 1 } }, store.options())));
      if (!result.acknowledged || result.matchedCount !== 1) return { kind: 'unknown', retryable: true };
      return { kind: 'saved', epoch: e.epoch, sessionId: e.sessionId, version: e.version, fence: e.fence };
    } catch (error) {
      return error instanceof AppError && ['INVALID_REQUEST', 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'STORAGE_BUDGET_EXCEEDED'].includes(error.code)
        ? { kind: 'failed', retryable: false } : { kind: 'unknown', retryable: true };
    } finally {
      if (lease) {
        try { await p.owner.release(lease); this.uncertainReleases.delete(sk); }
        catch { this.uncertainReleases.set(sk, lease); }
      }
      if (counted) {
        const next = (this.activeCounts.get(sk) ?? 1) - 1;
        if (next <= 0) this.activeCounts.delete(sk);
        else this.activeCounts.set(sk, next);
      }
    }
  }
}
