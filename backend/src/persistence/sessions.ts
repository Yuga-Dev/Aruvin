/**
 * ============================================================================
 * FILE: sessions.ts
 * LOCATION: backend/src/persistence/sessions.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Implement the P1 session repository plus scoped recovery listing.
 *
 * ROLE IN PROJECT:
 *    Stores bounded session metadata, hides unaccepted chats from navigation,
 *    and exposes recovery scans without embedding transcript arrays.
 *
 * KEY COMPONENTS:
 *    - MongoSessions.createIfAbsent: Idempotent scoped session creation.
 *    - MongoSessions.list: Keyset activity listing of accepted sessions.
 *    - MongoSessions.listForRecovery: Bounded scans of attempts and owner-only leftovers.
 * ============================================================================
 */

import type { Filter } from 'mongodb';
import { sessionSummarySchema } from '../contracts/api.js';
import type { BudgetConfig } from '../contracts/budgets.js';
import { COLLECTIONS } from '../contracts/collections.js';
import { idSchema } from '../contracts/identifiers.js';
import type { PageQuery, SessionRepository } from '../contracts/repositories.js';
import { sessionRecordSchema, type SessionRecord } from '../contracts/session.js';
import { AppError } from '../platform/errors/app-error.js';
import { cursor, page } from './pagination.js';
import {
  decode,
  graphThreadId,
  key,
  normalizeDate,
  type StoredDocument,
} from './records.js';
import { RecordStore } from './store.js';

export const EPHEMERAL_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CalendarMutationHandle = Readonly<{
  userId: string;
  sessionId: string;
  attemptId: string;
  generation: number;
}>;

function assertId(value: string, label: string): void {
  if (!idSchema.safeParse(value).success) {
    throw new AppError('INVALID_REQUEST', `Invalid ${label}.`);
  }
}

function assertHandle(handle: CalendarMutationHandle, executorId: string): void {
  assertId(handle.userId, 'userId');
  assertId(handle.sessionId, 'sessionId');
  assertId(handle.attemptId, 'attemptId');
  assertId(executorId, 'executorId');
  if (!Number.isSafeInteger(handle.generation) || handle.generation < 0) {
    throw new AppError('INVALID_REQUEST', 'Invalid mutation handle generation.');
  }
}

export class MongoSessions implements SessionRepository {
  constructor(
    readonly store: RecordStore,
    readonly budgets: BudgetConfig,
  ) {}

  get(userId: string, sessionId: string) {
    return this.store.read('sessions', sessionRecordSchema, {
      _id: key('session', userId, sessionId),
      userId,
      sessionId,
    });
  }

  createForInternalTurn(record: SessionRecord): Promise<SessionRecord> {
    return this.createIfAbsent(record);
  }

  async createIfAbsent(record: SessionRecord): Promise<SessionRecord> {
    const value = sessionRecordSchema.parse({
      ...record,
      createdAt: normalizeDate(record.createdAt),
      updatedAt: normalizeDate(record.updatedAt),
      lastActivityAt: normalizeDate(record.lastActivityAt),
    });
    if (
      value.graphThreadId !== graphThreadId(value.userId, value.sessionId) ||
      value.title.length > this.budgets.titleMaxChars
    ) {
      throw new AppError('INVALID_REQUEST', 'Invalid session record.');
    }
    const saved = await this.get(value.userId, value.sessionId);
    if (saved) {
      if (saved.graphThreadId !== value.graphThreadId) {
        throw new AppError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'The session identity is already used.',
        );
      }
      return saved;
    }
    try {
      return await this.store.insert(
        'sessions',
        sessionRecordSchema,
        value,
        key('session', value.userId, value.sessionId),
        this.budgets.maxDocumentBytes,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
        const winner = await this.get(value.userId, value.sessionId);
        if (winner?.graphThreadId === value.graphThreadId) {
          return winner;
        }
      }
      throw error;
    }
  }

  async list(userId: string, query: PageQuery) {
    const { limit, after } = page(
      query,
      'sessions',
      userId,
      '',
      this.budgets.maxPageSize,
    );
    // Equality on each index prefix preserves activity order without a computed sort.
    // Mongo's null equality includes missing flags; normalize only these bounded reads.
    const pins = !after || after.pinned ? [true, false, null] : [false, null];
    const groups = await Promise.all(pins.map(async (pinned) => {
      const filter: Filter<StoredDocument> = {
        userId, lifecycle: 'active', latestTurnId: { $ne: null }, pinned, ephemeral: { $ne: true },
      };
      if (after && (pinned === true) === (after.pinned ?? false)) {
        filter.$or = [
          { lastActivityAt: { $lt: after.value } },
          { lastActivityAt: after.value, sessionId: { $lt: after.id } },
        ];
      }
      return this.store.collection('sessions')
        .find(filter, this.store.options())
        .sort({ lastActivityAt: -1, sessionId: -1 })
        .limit(limit + 1)
        .toArray();
    }));
    // Merge at most 3 * (limit + 1) records using Mongo's simple binary string order.
    const docs = groups.flat().map<StoredDocument>(doc => ({ ...doc, pinned: doc.pinned ?? false }))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
        Buffer.compare(Buffer.from(b.lastActivityAt), Buffer.from(a.lastActivityAt)) ||
        Buffer.compare(Buffer.from(b.sessionId), Buffer.from(a.sessionId)))
      .slice(0, limit + 1);
    const selected = docs.slice(0, limit).map((doc) =>
      sessionSummarySchema.parse(
        decode(sessionRecordSchema, doc) && {
          sessionId: doc.sessionId,
          title: doc.title,
          pinned: doc.pinned,
          createdAt: doc.createdAt,
          lastActivityAt: doc.lastActivityAt,
        },
      ),
    );
    const last = selected.at(-1);
    return {
      items: selected,
      nextCursor:
        docs.length > limit && last
          ? cursor({
              kind: 'sessions',
              userId,
              sessionId: '',
              value: last.lastActivityAt,
              id: last.sessionId,
              pinned: last.pinned ?? false,
            })
          : null,
    };
  }

  async listExpiredEphemeral(cutoffIso: string, limit: number): Promise<SessionRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.budgets.maxPageSize)
      throw new AppError('INVALID_REQUEST', 'Invalid page size.');
    const cutoff = normalizeDate(cutoffIso);
    // ponytail: one bounded oldest-first page; add an indexed cursor if blocked rows fill a batch.
    const docs = await this.store.collection(COLLECTIONS.sessions).find({
      lifecycle: { $in: ['active', 'archived'] }, ephemeral: true, lastActivityAt: { $lt: cutoff },
    }, this.store.options()).sort({ lastActivityAt: 1 }).limit(limit).toArray();
    return docs.map(doc => decode(sessionRecordSchema, doc)!);
  }

  async advanceMemoryWatermark(userId: string, sessionId: string, sequence: number): Promise<void> {
    assertId(userId, 'userId');
    assertId(sessionId, 'sessionId');
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new AppError('INVALID_REQUEST', 'Invalid memory watermark.');
    const scope = { _id: key('session', userId, sessionId), userId, sessionId };
    try {
      const result = await this.store.collection(COLLECTIONS.sessions).updateOne(
        { ...scope, lifecycle: 'active', ephemeral: { $ne: true } },
        { $max: { memoryWatermarkSequence: sequence }, $inc: { _revision: 1 } },
        this.store.options(),
      );
      if (result.acknowledged && result.matchedCount === 1) return;
    } catch { /* Confirm an ambiguous write by reading the scoped watermark. */ }
    const saved = await this.get(userId, sessionId);
    if (saved?.lifecycle !== 'active' || saved.ephemeral === true)
      throw new AppError('NOT_FOUND', 'Chat not found.');
    if ((saved.memoryWatermarkSequence ?? -1) >= sequence) return;
    throw new AppError('PERSISTENCE_ERROR', 'The memory watermark could not be saved.');
  }

  async touchActivity(userId: string, sessionId: string, at: string): Promise<void> {
    const value = normalizeDate(at);
    try {
      const result = await this.store
        .collection('sessions')
        .updateOne(
          { _id: key('session', userId, sessionId), userId, sessionId },
          { $max: { lastActivityAt: value, updatedAt: value }, $inc: { _revision: 1 } },
          this.store.options(),
        );
      if (!result.matchedCount) {
        throw new Error('missing');
      }
    } catch {
      const saved = await this.get(userId, sessionId);
      if (!saved || saved.lastActivityAt < value) {
        throw new AppError('PERSISTENCE_ERROR', 'Chat activity could not be saved.');
      }
    }
  }

  async update(userId: string, sessionId: string, changes: { title?: string; pinned?: boolean }): Promise<void> {
    const title = changes.title?.trim();
    if ((changes.title !== undefined && (!title || title.length > this.budgets.titleMaxChars)) ||
      (changes.pinned !== undefined && typeof changes.pinned !== 'boolean') ||
      (title === undefined && changes.pinned === undefined)) {
      throw new AppError('INVALID_REQUEST', 'Invalid session update.');
    }
    const fields = { ...(title !== undefined ? { title } : {}),
      ...(changes.pinned !== undefined ? { pinned: changes.pinned } : {}) };
    await this.mutate(userId, sessionId, fields);
  }

  // Soft deletion preserves durable accounting/checkpoints for the retention policy.
  async delete(userId: string, sessionId: string): Promise<void> {
    await this.mutate(userId, sessionId, { lifecycle: 'archived' }, true);
  }

  /** Caller must fence RAM admission and finish in-flight work before invoking. */
  async hardPurgeSession(userId: string, sessionId: string): Promise<void> {
    assertId(userId, 'userId');
    assertId(sessionId, 'sessionId');
    const chat = { userId, sessionId };
    const scope = { _id: key('session', userId, sessionId), ...chat, ephemeral: true };
    const s = await this.store.read(COLLECTIONS.sessions, sessionRecordSchema, scope);
    if (!s) return; // Absent (including already purged), not temporary, or not owned.

    const error = () => new AppError('PERSISTENCE_ERROR', 'Temporary chat deletion could not be confirmed.');
    const busy = () => new AppError('CONFLICT_ACTIVE_TURN', 'Wait for chat work to finish before deleting.');
    const idle = { 'execution.ownerId': null, 'execution.activeAttemptId': null };
    const thread = { thread_id: graphThreadId(userId, sessionId) };
    if (s.graphThreadId !== thread.thread_id) throw error();
    if (s.execution.ownerId !== null || s.execution.activeAttemptId !== null) throw busy();

    const sessions = this.store.collection(COLLECTIONS.sessions);
    const options = this.store.options();
    try {
      if (s.lifecycle === 'active') {
        // Close durable admission before touching the children. An interrupted
        // purge is not a publication to recover; the archived root remains sweepable.
        const fenced = await sessions.updateOne({ ...scope, ...idle, lifecycle: 'active' },
          { $set: { lifecycle: 'archived' }, $unset: { memoryPublication: '' }, $inc: { _revision: 1 } },
          options);
        if (!fenced.acknowledged) throw error();
        if (fenced.matchedCount !== 1) throw busy();
      }
      const children: [string, Filter<StoredDocument>][] = [
        [COLLECTIONS.checkpointWrites, thread], [COLLECTIONS.checkpoints, thread],
        [COLLECTIONS.agentMemory, chat], [COLLECTIONS.messages, chat],
        [COLLECTIONS.metadata, { ...chat, kind: { $ne: 'accounting' } }],
      ];
      for (const [collection, filter] of children) {
        if (!(await this.store.collection(collection).deleteMany(filter, options)).acknowledged) throw error();
      }
      const root = await sessions.deleteOne({ ...scope, ...idle, lifecycle: 'archived' }, options);
      if (!root.acknowledged || (root.deletedCount !== 1 && await this.store.raw(COLLECTIONS.sessions, scope)))
        throw error();
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw error();
    }
  }

  private async mutate(userId: string, sessionId: string, fields: Record<string, string | boolean>, idleOnly = false) {
    const scope = { _id: key('session', userId, sessionId), userId, sessionId };
    try {
      const result = await this.store.collection('sessions').updateOne({ ...scope, lifecycle: 'active',
        ...(idleOnly ? { 'execution.ownerId': null, 'execution.activeAttemptId': null } : {}) },
      { $set: { ...fields, updatedAt: new Date().toISOString() }, $inc: { _revision: 1 } }, this.store.options());
      if (result.matchedCount) return;
    } catch {
      const saved = await this.store.raw('sessions', scope);
      if (saved && Object.entries(fields).every(([name, value]) => saved[name] === value)) return;
      throw new AppError('PERSISTENCE_ERROR', 'The session change could not be confirmed.');
    }
    const saved = await this.get(userId, sessionId);
    if (idleOnly && saved?.lifecycle === 'archived') return;
    if (!saved || saved.lifecycle !== 'active') throw new AppError('NOT_FOUND', 'Chat not found.');
    throw new AppError('CONFLICT_ACTIVE_TURN', 'Wait for the response to finish before deleting this chat.');
  }

  async listForRecovery(userId: string, query: PageQuery) {
    const { limit, after } = page(
      query,
      'sessions',
      userId,
      '',
      this.budgets.maxPageSize,
    );
    const filter: Filter<StoredDocument> = {
      userId,
      // ponytail: at most the configured page size per query; a dedicated indexed
      // pending-effect pointer is warranted only if startup recovery profiling justifies a schema change.
      $or: [
        { 'execution.activeAttemptId': { $ne: null } },
        { 'execution.ownerId': { $ne: null } },
        { memoryPublication: { $exists: true } },
      ],
    };
    if (after) {
      filter.$and = [{ $or: [
        { lastActivityAt: { $lt: after.value } },
        { lastActivityAt: after.value, sessionId: { $lt: after.id } },
      ] }];
    }
    const docs = await this.store
      .collection('sessions')
      .find(filter, this.store.options())
      .sort({ lastActivityAt: -1, sessionId: -1 })
      .limit(limit + 1)
      .toArray();
    const items = docs.slice(0, limit).map((doc) => decode(sessionRecordSchema, doc)!);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        docs.length > limit && last
          ? cursor({
              kind: 'sessions',
              userId,
              sessionId: '',
              value: last.lastActivityAt,
              id: last.sessionId,
            })
          : null,
    };
  }

  private validMutationOwner(session: SessionRecord, executorId: string, archiveOwned: boolean): boolean {
    if (session.execution.ownerId === null) return true;
    return archiveOwned && session.execution.ownerId === executorId;
  }

  async beginCalendarMutation(input: {
    userId: string;
    sessionId: string;
    attemptId: string;
    executorId: string;
    archiveOwned: boolean;
  }): Promise<CalendarMutationHandle> {
    assertId(input.userId, 'userId');
    assertId(input.sessionId, 'sessionId');
    assertId(input.attemptId, 'attemptId');
    assertId(input.executorId, 'executorId');
    const scope = { _id: key('session', input.userId, input.sessionId), userId: input.userId, sessionId: input.sessionId };
    const observedRaw = await this.store.raw('sessions', scope);
    const observed = observedRaw ? decode(sessionRecordSchema, observedRaw) : null;
    if (!observed || observed.lifecycle !== 'active') {
      throw new AppError('NOT_FOUND', 'Chat not found.');
    }
    if (!this.validMutationOwner(observed, input.executorId, input.archiveOwned)) {
      throw new AppError('CONFLICT_ACTIVE_TURN', 'Another turn is active.');
    }
    if (observed.execution.activeAttemptId !== null && observed.execution.activeAttemptId !== input.attemptId) {
      throw new AppError('CONFLICT_ACTIVE_TURN', 'Another turn is active.');
    }
    const generation = observed.execution.generation;
    const expectedActive = observed.execution.activeAttemptId;
    let acknowledged = false;
    let matchedCount = 0;
    let writeFailed = false;
    try {
      const result = await this.store.collection('sessions').updateOne(
        {
          ...scope,
          lifecycle: 'active',
          'execution.generation': generation,
          'execution.ownerId': observed.execution.ownerId,
          'execution.activeAttemptId': expectedActive,
        },
        {
          $set: { 'execution.activeAttemptId': input.attemptId },
          $inc: { _revision: 1 },
        },
        this.store.options(),
      );
      acknowledged = Boolean(result.acknowledged);
      matchedCount = result.matchedCount;
      if (acknowledged && matchedCount === 1) {
        return { userId: input.userId, sessionId: input.sessionId, attemptId: input.attemptId, generation };
      }
    } catch {
      writeFailed = true;
    }
    // Ambiguous/unacknowledged result: confirm via exact scoped readback before returning handle.
    const savedRaw = await this.store.raw('sessions', scope);
    const saved = savedRaw ? decode(sessionRecordSchema, savedRaw) : null;
    const advancedRevision = expectedActive === null || Number(savedRaw?._revision) > Number(observedRaw?._revision);
    if (
      (writeFailed || !acknowledged)
      && saved
      && saved.lifecycle === 'active'
      && saved.execution.generation === generation
      && saved.execution.activeAttemptId === input.attemptId
      && this.validMutationOwner(saved, input.executorId, input.archiveOwned)
      && advancedRevision
    ) {
      return { userId: input.userId, sessionId: input.sessionId, attemptId: input.attemptId, generation };
    }
    if (saved && (saved.lifecycle !== 'active'
      || !this.validMutationOwner(saved, input.executorId, input.archiveOwned)
      || (saved.execution.activeAttemptId !== null && saved.execution.activeAttemptId !== input.attemptId))) {
      throw new AppError('CONFLICT_ACTIVE_TURN', 'Another turn is active.');
    }
    throw new AppError('PERSISTENCE_ERROR', 'Calendar mutation ownership could not be confirmed.');
  }

  async assertCalendarMutation(handle: CalendarMutationHandle, executorId: string): Promise<boolean> {
    assertHandle(handle, executorId);
    const saved = await this.get(handle.userId, handle.sessionId);
    if (!saved || saved.lifecycle !== 'active') return false;
    if (saved.execution.generation !== handle.generation) return false;
    if (saved.execution.activeAttemptId !== handle.attemptId) return false;
    return saved.execution.ownerId === null || saved.execution.ownerId === executorId;
  }

  async finishCalendarMutation(handle: CalendarMutationHandle, executorId: string): Promise<void> {
    assertHandle(handle, executorId);
    const scope = { _id: key('session', handle.userId, handle.sessionId), userId: handle.userId, sessionId: handle.sessionId };
    const observed = await this.get(handle.userId, handle.sessionId);
    if (
      !observed
      || observed.lifecycle !== 'active'
      || observed.execution.generation !== handle.generation
      || observed.execution.activeAttemptId !== handle.attemptId
      || (observed.execution.ownerId !== null && observed.execution.ownerId !== executorId)
    ) {
      throw new AppError('INTERRUPTED', 'Calendar execution ownership was lost.');
    }
    let acknowledged = false;
    let matchedCount = 0;
    let writeFailed = false;
    try {
      const result = await this.store.collection('sessions').updateOne(
        {
          ...scope,
          lifecycle: 'active',
          'execution.generation': handle.generation,
          'execution.activeAttemptId': handle.attemptId,
          $or: [{ 'execution.ownerId': null }, { 'execution.ownerId': executorId }],
        },
        {
          $set: { 'execution.activeAttemptId': null },
          $inc: { _revision: 1 },
        },
        this.store.options(),
      );
      acknowledged = Boolean(result.acknowledged);
      matchedCount = result.matchedCount;
      if (acknowledged && matchedCount === 1) return;
    } catch {
      writeFailed = true;
    }
    const saved = await this.get(handle.userId, handle.sessionId);
    if (
      (writeFailed || !acknowledged)
      && saved
      && saved.lifecycle === 'active'
      && saved.execution.generation === handle.generation
      && saved.execution.activeAttemptId === null
      && (saved.execution.ownerId === null || saved.execution.ownerId === executorId)
    ) {
      return;
    }
    throw new AppError('PERSISTENCE_ERROR', 'Calendar mutation release could not be confirmed.');
  }
}
