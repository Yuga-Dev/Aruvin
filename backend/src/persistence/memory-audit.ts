/**
 * ============================================================================
 * FILE: memory-audit.ts
 * LOCATION: backend/src/persistence/memory-audit.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Persist and read bounded memory-change audit records in `metadata`.
 *
 * ROLE IN PROJECT:
 *    Gives user memory a revision-ordered change history without storing any
 *    memory text. Written only after the memory CAS is confirmed, off the chat path.
 *
 * KEY COMPONENTS:
 *    - MongoMemoryAudit.put: Idempotent insert keyed by user and memory revision.
 *    - findByRequestId / history: Owner-scoped idempotency lookup and keyset pages.
 *    - prune: Bounded per-user retention (newest 200, nothing older than 180 days).
 *    - memoryAuditFor: One cached repository per ownership object.
 * ============================================================================
 */
import { COLLECTIONS } from '../contracts/collections.js';
import { idSchema } from '../contracts/identifiers.js';
import { MEMORY_AUDIT_RECORD_MAX_BYTES, USER_MEMORY_HISTORY_MAX_LIMIT, memoryAuditRecordSchema,
  type MemoryAuditRecord } from '../contracts/user-memory.js';
import { AppError } from '../platform/errors/app-error.js';
import type { MongoOwnership } from './ownership.js';
import { assertBytes, key } from './records.js';
import type { RecordStore } from './store.js';

export const MEMORY_AUDIT_KIND = 'memory-audit';
export const MEMORY_AUDIT_KEEP = 200;
export const MEMORY_AUDIT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 50;

export type MemoryAuditHistoryPage = {
  items: MemoryAuditRecord[]; nextCursor: string | null; cursorRevision: number | null;
};
export interface MemoryAuditPort {
  put(record: MemoryAuditRecord): Promise<void>;
  findByRequestId(userId: string, requestId: string): Promise<MemoryAuditRecord | null>;
  history(userId: string, query: { cursor?: string; limit: number }): Promise<MemoryAuditHistoryPage>;
  prune(userId: string, now: number): Promise<void>;
}

const storageError = () => new AppError('PERSISTENCE_ERROR', 'Memory history storage is unavailable.');

function encodeCursor(userId: string, revision: number): string {
  return Buffer.from(JSON.stringify({ v: 1, u: userId, r: revision })).toString('base64url');
}
function decodeCursor(userId: string, value: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as
      { v?: unknown; u?: unknown; r?: unknown };
    if (parsed.v === 1 && parsed.u === userId && Number.isSafeInteger(parsed.r) && (parsed.r as number) >= 1)
      return parsed.r as number;
  } catch { /* fall through */ }
  throw new AppError('INVALID_REQUEST', 'Invalid page cursor.');
}

export class MongoMemoryAudit implements MemoryAuditPort {
  constructor(private readonly store: RecordStore,
    private readonly owner: Pick<MongoOwnership, 'assertExecutor'>) {}

  private get metadata() { return this.store.collection(COLLECTIONS.metadata); }
  private get readOptions() {
    return { ...this.store.options(), timeoutMS: this.store.timeoutMs,
      readPreference: 'primary' as const, readConcern: { level: 'majority' as const } };
  }

  async put(record: MemoryAuditRecord): Promise<void> {
    const parsed = memoryAuditRecordSchema.safeParse(record);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid memory audit record.');
    const _id = key('memory-audit', record.userId, record.memoryRevision);
    const doc = { _id, ...parsed.data };
    assertBytes(doc, MEMORY_AUDIT_RECORD_MAX_BYTES + 256);
    await this.owner.assertExecutor();
    try {
      const result = await this.metadata.updateOne({ _id }, { $setOnInsert: doc }, {
        ...this.store.options(), timeoutMS: this.store.timeoutMs, upsert: true,
        writeConcern: { w: 'majority', j: true } });
      if (!result.acknowledged) throw storageError();
    } catch (error) {
      throw error instanceof AppError ? error : storageError();
    }
  }

  async findByRequestId(userId: string, requestId: string): Promise<MemoryAuditRecord | null> {
    if (!idSchema.safeParse(userId).success || !idSchema.safeParse(requestId).success)
      throw new AppError('INVALID_REQUEST', 'Invalid memory request.');
    try {
      const doc = await this.metadata.findOne({ userId, kind: MEMORY_AUDIT_KIND, requestId }, this.readOptions);
      return doc ? this.decode(doc, userId) : null;
    } catch (error) {
      throw error instanceof AppError ? error : storageError();
    }
  }

  async history(userId: string, query: { cursor?: string; limit: number }): Promise<MemoryAuditHistoryPage> {
    if (!idSchema.safeParse(userId).success) throw new AppError('INVALID_REQUEST', 'Invalid memory owner.');
    const limit = query.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > USER_MEMORY_HISTORY_MAX_LIMIT)
      throw new AppError('INVALID_REQUEST', 'Invalid page size.');
    const before = query.cursor ? decodeCursor(userId, query.cursor) : null;
    try {
      const docs = await this.metadata.find({ userId, kind: MEMORY_AUDIT_KIND,
        ...(before === null ? {} : { memoryRevision: { $lt: before } }) },
      { ...this.readOptions, sort: { memoryRevision: -1 }, limit: limit + 1 }).toArray();
      const items = docs.slice(0, limit).map(doc => this.decode(doc, userId));
      return { items, cursorRevision: before, nextCursor: docs.length > limit && items.length
        ? encodeCursor(userId, items[items.length - 1]!.memoryRevision) : null };
    } catch (error) {
      throw error instanceof AppError ? error : storageError();
    }
  }

  // ponytail: per-user bounded sweep driven by audit writes and history reads, not a
  // cross-user scan or TTL index (TTL on the unverified Azure product, AGENTS.md R1).
  // A user who never changes or opens memory again keeps at most 200 content-free rows
  // until a cross-user sweep is added on the orphan-sweep cadence.
  async prune(userId: string, now: number): Promise<void> {
    if (!idSchema.safeParse(userId).success) return;
    const cutoff = new Date(now - MEMORY_AUDIT_MAX_AGE_MS).toISOString();
    try {
      const rows = await this.metadata.find({ userId, kind: MEMORY_AUDIT_KIND },
        { ...this.readOptions, sort: { memoryRevision: -1 }, limit: MEMORY_AUDIT_KEEP + PRUNE_BATCH,
          projection: { _id: 1, at: 1 } }).toArray();
      const doomed = rows.filter((row, index) => index >= MEMORY_AUDIT_KEEP ||
        (typeof row.at === 'string' && row.at < cutoff)).slice(0, PRUNE_BATCH);
      if (doomed.length) await this.owner.assertExecutor();
      for (const row of doomed)
        await this.metadata.deleteOne({ _id: row._id, userId, kind: MEMORY_AUDIT_KIND },
          { ...this.store.options(), timeoutMS: this.store.timeoutMs, writeConcern: { w: 'majority', j: true } });
    } catch (error) {
      throw error instanceof AppError ? error : storageError();
    }
  }

  private decode(doc: Record<string, unknown>, userId: string): MemoryAuditRecord {
    const { _id, ...payload } = doc;
    const parsed = memoryAuditRecordSchema.safeParse(payload);
    if (!parsed.success || parsed.data.userId !== userId ||
        _id !== key('memory-audit', userId, parsed.data.memoryRevision)) throw storageError();
    return parsed.data;
  }
}

// Missing revisions (a failed audit write) between a page's items and its upper bound.
// `upper` is exclusive for a cursor page and inclusive for the newest page.
export function findAuditGaps(items: readonly { memoryRevision: number }[], upper: number | null,
  inclusive: boolean): { fromRevision: number; toRevision: number }[] {
  const gaps: { fromRevision: number; toRevision: number }[] = [];
  let top = upper === null ? null : inclusive ? upper : upper - 1;
  for (const { memoryRevision } of items) {
    if (top !== null && top > memoryRevision) gaps.push({ fromRevision: memoryRevision + 1, toRevision: top });
    top = memoryRevision - 1;
  }
  return gaps;
}

const cache = new WeakMap<object, MongoMemoryAudit>();
export function memoryAuditFor(persistence: { owner: Pick<MongoOwnership, 'assertExecutor'> & { store: RecordStore } } |
  null | undefined): MemoryAuditPort | null {
  if (!persistence) return null;
  let repo = cache.get(persistence.owner);
  if (!repo) cache.set(persistence.owner, repo = new MongoMemoryAudit(persistence.owner.store, persistence.owner));
  return repo;
}
