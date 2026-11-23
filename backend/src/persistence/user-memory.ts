/**
 * ============================================================================
 * FILE: user-memory.ts
 * LOCATION: backend/src/persistence/user-memory.ts
 * PURPOSE: Persist one bounded, revision-fenced user-memory record per user.
 * ROLE IN PROJECT: Implements the shared memory repository on the admitted store.
 * KEY COMPONENTS: Scoped read, initial upsert, compare-and-swap and read-back.
 * ============================================================================
 */
import { isDeepStrictEqual } from 'node:util';
import { COLLECTIONS } from '../contracts/collections.js';
import { idSchema } from '../contracts/identifiers.js';
import type { UserMemoryCasResult, UserMemoryRepository, UserMemoryWriteSettings } from '../contracts/repositories.js';
import { USER_MEMORY_RECORD_MAX_BYTES, storedUserMemorySchema,
  type StoredUserMemory } from '../contracts/user-memory.js';
import { AppError } from '../platform/errors/app-error.js';
import type { MongoOwnership } from './ownership.js';
import { assertBytes, key } from './records.js';
import type { RecordStore } from './store.js';

export class MongoUserMemoryRepository implements UserMemoryRepository {
  constructor(private readonly store: RecordStore,
    private readonly owner: Pick<MongoOwnership, 'assertExecutor'>,
    private readonly documentByteLimit: number) {}

  private get byteLimit(): number {
    return Math.min(this.documentByteLimit, USER_MEMORY_RECORD_MAX_BYTES);
  }

  async read(userId: string): Promise<StoredUserMemory | null> {
    if (!idSchema.safeParse(userId).success)
      throw new AppError('INVALID_REQUEST', 'Invalid memory owner.');
    const _id = key('user-memory', userId);
    try {
      const doc = await this.store.collection(COLLECTIONS.userMemory).findOne(
        { _id, userId }, { ...this.store.options(), timeoutMS: this.store.timeoutMs,
          readPreference: 'primary', readConcern: { level: 'majority' } },
      );
      if (!doc) return null;
      assertBytes(doc, this.byteLimit);
      const { _id: storedId, ...payload } = doc;
      const parsed = storedUserMemorySchema.safeParse(payload);
      if (storedId === _id && parsed.success && parsed.data.userId === userId) return parsed.data;
    } catch {
      throw new AppError('PERSISTENCE_ERROR', 'User memory storage is unavailable.');
    }
    throw new AppError('PERSISTENCE_ERROR', 'Stored user memory is invalid.');
  }

  createIfAbsent(userId: string, settings: UserMemoryWriteSettings, updatedAt: string): Promise<UserMemoryCasResult> {
    return this.write(userId, 0, settings, updatedAt);
  }

  async compareAndSwap(userId: string, expectedRevision: number, settings: UserMemoryWriteSettings,
    updatedAt: string): Promise<UserMemoryCasResult> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER)
      throw new AppError('INVALID_REQUEST', 'Invalid memory revision.');
    return this.write(userId, expectedRevision, settings, updatedAt);
  }

  private async write(userId: string, expected: number, settings: UserMemoryWriteSettings,
    updatedAt: string): Promise<UserMemoryCasResult> {
    const parsed = storedUserMemorySchema.safeParse({ ...settings,
      schemaVersion: 1, userId, revision: expected + 1, updatedAt });
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid user memory record.');
    const record = parsed.data;
    const _id = key('user-memory', userId);
    // User memory has its own revision field; do not use RecordStore's _revision envelope.
    const doc = { _id, ...record };
    assertBytes(doc, this.byteLimit);
    await this.owner.assertExecutor();

    const collection = this.store.collection(COLLECTIONS.userMemory);
    const options = { ...this.store.options(), timeoutMS: this.store.timeoutMs,
      writeConcern: { w: 'majority' as const, j: true } };
    try {
      const result = expected === 0
        ? await collection.updateOne({ _id }, { $setOnInsert: doc }, { ...options, upsert: true })
        : await collection.replaceOne({ _id, userId, revision: expected }, doc, { ...options, upsert: false });
      if (result.acknowledged) {
        if ((expected === 0 ? result.upsertedCount : result.matchedCount) === 1)
          return this.confirm(record);
        const current = await this.read(userId);
        if (current || expected !== 0)
          return { outcome: 'conflict', currentRevision: current?.revision ?? 0 };
        return { outcome: 'uncertain' }; // An _id matched but the scoped record is not visible.
      }
    } catch { /* The command may have reached Mongo. Check only the exact candidate. */ }

    try {
      if (isDeepStrictEqual(await this.read(userId), record)) return this.confirm(record);
    } catch { /* No durable proof. */ }
    return { outcome: 'uncertain' };
  }

  private async confirm(record: StoredUserMemory): Promise<UserMemoryCasResult> {
    try {
      await this.owner.assertExecutor();
      return { outcome: 'confirmed', record };
    } catch {
      return { outcome: 'uncertain' };
    }
  }
}
