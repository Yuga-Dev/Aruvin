/**
 * ============================================================================
 * FILE: personalization.ts
 * LOCATION: backend/src/persistence/personalization.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Persist per-user personalization settings with revision-fenced CAS.
 *
 * ROLE IN PROJECT:
 *    Adapts the admitted MongoDB store for user_personalization documents,
 *    enforcing executor ownership, BSON byte bounds, and atomic revision CAS.
 *
 * KEY COMPONENTS:
 *    - MongoUserPersonalizationRepository: Read, initial create, and CAS update.
 * ============================================================================
 */

import { isDeepStrictEqual } from 'node:util';
import type { Collection } from 'mongodb';
import { COLLECTIONS } from '../contracts/collections.js';
import { idSchema, isoDateSchema } from '../contracts/identifiers.js';
import {
  PERSONALIZATION_SCHEMA_VERSION,
  storedUserPersonalizationSchema,
  userPersonalizationSettingsSchema,
  type PersonalizationCasResult,
  type StoredUserPersonalization,
  type UserPersonalizationRepository,
  type UserPersonalizationSettings,
} from '../contracts/personalization.js';
import { AppError } from '../platform/errors/app-error.js';
import type { MongoOwnership } from './ownership.js';
import { assertBytes, key } from './records.js';
import type { RecordStore } from './store.js';

type StoredPersonalizationDocument = StoredUserPersonalization & { _id: string };

const MAX_EXPECTED_REVISION = Number.MAX_SAFE_INTEGER - 1;

export function personalizationKey(userId: string): string {
  return key('user-personalization', userId);
}

export class MongoUserPersonalizationRepository implements UserPersonalizationRepository {
  private readonly collection: Collection<StoredPersonalizationDocument>;

  constructor(
    private readonly store: RecordStore,
    private readonly owner: Pick<MongoOwnership, 'assertExecutor'>,
    private readonly documentByteLimit: number,
  ) {
    this.collection = store.db.collection<StoredPersonalizationDocument>(
      COLLECTIONS.userPersonalization,
    );
  }

  async read(userId: string): Promise<StoredUserPersonalization | null> {
    const validUserId = idSchema.parse(userId);
    const id = personalizationKey(validUserId);
    let raw: StoredPersonalizationDocument | null;
    try {
      raw = await this.collection.findOne(
        { _id: id, userId: validUserId },
        { ...this.store.options(), timeoutMS: this.store.timeoutMs },
      );
    } catch {
      throw new AppError('PERSISTENCE_ERROR', 'Personalization storage is unavailable.');
    }
    if (raw === null) return null;
    return this.parseStored(raw, id, validUserId);
  }

  async createIfAbsent(
    userId: string,
    settings: UserPersonalizationSettings,
    updatedAt: string,
  ): Promise<PersonalizationCasResult> {
    const validUserId = idSchema.parse(userId);
    const candidate = this.validateCandidate(validUserId, settings, 1, updatedAt);
    const id = personalizationKey(validUserId);
    const doc: StoredPersonalizationDocument = { _id: id, ...candidate };
    assertBytes(doc, this.documentByteLimit);
    await this.assertWritable();
    let dispatched = false;
    try {
      dispatched = true;
      const result = await this.collection.updateOne(
        { _id: id },
        { $setOnInsert: doc },
        { ...this.writeOptions(), upsert: true },
      );
      if (!result.acknowledged) return this.resolveAmbiguous(id, validUserId, candidate);
      if ((result.upsertedCount ?? 0) === 1) return this.confirm(candidate);
      return { outcome: 'conflict', currentRevision: await this.readCurrentRevision(validUserId) };
    } catch (error) {
      return this.afterDispatchFailure(dispatched, error, id, validUserId, candidate);
    }
  }

  async compareAndSwap(
    userId: string,
    expectedRevision: number,
    settings: UserPersonalizationSettings,
    updatedAt: string,
  ): Promise<PersonalizationCasResult> {
    const validUserId = idSchema.parse(userId);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      expectedRevision > MAX_EXPECTED_REVISION
    ) {
      throw new AppError('INVALID_REQUEST', 'Invalid personalization revision.');
    }
    const candidate = this.validateCandidate(
      validUserId,
      settings,
      expectedRevision + 1,
      updatedAt,
    );
    const id = personalizationKey(validUserId);
    const doc: StoredPersonalizationDocument = { _id: id, ...candidate };
    assertBytes(doc, this.documentByteLimit);
    await this.assertWritable();
    let dispatched = false;
    try {
      dispatched = true;
      const result = await this.collection.replaceOne(
        { _id: id, userId: validUserId, revision: expectedRevision },
        doc,
        { ...this.writeOptions(), upsert: false },
      );
      if (!result.acknowledged) return this.resolveAmbiguous(id, validUserId, candidate);
      if (result.matchedCount === 1) return this.confirm(candidate);
      return { outcome: 'conflict', currentRevision: await this.readCurrentRevision(validUserId) };
    } catch (error) {
      return this.afterDispatchFailure(dispatched, error, id, validUserId, candidate);
    }
  }

  private validateCandidate(
    userId: string,
    settings: UserPersonalizationSettings,
    revision: number,
    updatedAt: string,
  ): StoredUserPersonalization {
    const parsedSettings = userPersonalizationSettingsSchema.parse(settings);
    const parsedDate = isoDateSchema.parse(updatedAt);
    return storedUserPersonalizationSchema.parse({
      schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
      userId,
      settings: parsedSettings,
      revision,
      updatedAt: parsedDate,
    });
  }

  private parseStored(
    raw: StoredPersonalizationDocument,
    expectedId: string,
    expectedUserId: string,
  ): StoredUserPersonalization {
    assertBytes(raw, this.documentByteLimit);
    const { _id: rawId, ...payload } = raw;
    if (rawId !== expectedId) {
      throw new AppError('PERSISTENCE_ERROR', 'Personalization data is invalid.');
    }
    const parsed = storedUserPersonalizationSchema.safeParse(payload);
    if (!parsed.success || parsed.data.userId !== expectedUserId) {
      throw new AppError('PERSISTENCE_ERROR', 'Personalization data is invalid.');
    }
    return structuredClone(parsed.data);
  }

  private async readCurrentRevision(userId: string): Promise<number> {
    const current = await this.read(userId);
    return current?.revision ?? 0;
  }

  private writeOptions() {
    return {
      ...this.store.options(),
      timeoutMS: this.store.timeoutMs,
      writeConcern: { w: 'majority' as const, j: true },
    };
  }

  private async assertWritable(): Promise<void> {
    try {
      await this.owner.assertExecutor();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('PERSISTENCE_ERROR', 'Personalization storage is unavailable.');
    }
  }

  private async confirm(candidate: StoredUserPersonalization): Promise<PersonalizationCasResult> {
    try {
      await this.owner.assertExecutor();
      return { outcome: 'confirmed', record: structuredClone(candidate) };
    } catch {
      return { outcome: 'uncertain' };
    }
  }

  private afterDispatchFailure(
    dispatched: boolean,
    error: unknown,
    id: string,
    userId: string,
    candidate: StoredUserPersonalization,
  ): Promise<PersonalizationCasResult> {
    if (!dispatched) {
      if (error instanceof AppError) throw error;
      throw new AppError('PERSISTENCE_ERROR', 'Personalization storage is unavailable.');
    }
    return this.resolveAmbiguous(id, userId, candidate);
  }

  private async resolveAmbiguous(
    id: string,
    userId: string,
    candidate: StoredUserPersonalization,
  ): Promise<PersonalizationCasResult> {
    let raw: StoredPersonalizationDocument | null;
    try {
      raw = await this.collection.findOne(
        { _id: id, userId },
        { ...this.store.options(), timeoutMS: this.store.timeoutMs },
      );
    } catch {
      return { outcome: 'uncertain' };
    }
    let parsed: StoredUserPersonalization | null;
    try {
      parsed = raw === null ? null : this.parseStored(raw, id, userId);
    } catch {
      return { outcome: 'uncertain' };
    }
    try {
      await this.owner.assertExecutor();
    } catch {
      return { outcome: 'uncertain' };
    }
    if (parsed !== null && isDeepStrictEqual(parsed, candidate)) {
      return { outcome: 'confirmed', record: structuredClone(candidate) };
    }
    const expectedRevision = candidate.revision - 1;
    if (parsed !== null && parsed.revision > expectedRevision) {
      return { outcome: 'conflict', currentRevision: parsed.revision };
    }
    return { outcome: 'uncertain' };
  }
}
