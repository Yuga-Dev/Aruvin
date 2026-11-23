/**
 * ============================================================================
 * FILE: web-search-connections.ts
 * LOCATION: backend/src/persistence/web-search-connections.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Persist one bounded web-search account aggregate and single-use OAuth state.
 *
 * ROLE IN PROJECT:
 *    Provides scoped CAS and atomic OAuth consume on the existing guarded
 *    RecordStore without a new connection, executor, or close owner.
 *
 * KEY COMPONENTS:
 *    - MongoWebSearchConnections: WebSearchStore implementation.
 *    - saveAccount: Revision CAS with one exact lost-ACK reread.
 *    - consumeOAuthState: Atomic owner/browser/session/expiry match.
 * ============================================================================
 */

import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { BudgetConfig } from '../contracts/budgets.js';
import { idSchema, isoDateSchema } from '../contracts/identifiers.js';
import { WEB_SEARCH_PROVIDERS } from '../contracts/web-search-policy.js';
import { AppError } from '../platform/errors/app-error.js';
import {
  storedWebAccountSchema, storedWebOAuthStateSchema,
  type StoredWebAccount, type StoredWebOAuthState, type WebAccountCas, type WebSearchStore,
} from '../plugins/web-search/types.js';
import type { MongoOwnership } from './ownership.js';
import { assertBytes, decode, key } from './records.js';
import type { RecordStore } from './store.js';

export type WebSearchRecordStore = Pick<RecordStore, 'collection' | 'raw' | 'options' | 'timeoutMs'>;
export type WebSearchOwnership = Pick<MongoOwnership, 'assertExecutor'>;

const ACCOUNT_BYTES = 262_144;
const STATE_BYTES = 32_768;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const consumeInputSchema = z.object({
  userId: idSchema, provider: z.enum(WEB_SEARCH_PROVIDERS),
  stateHash: sha256, browserHash: sha256, sessionHash: sha256, now: isoDateSchema,
}).strict();

function parseRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid persistence record.');
  return parsed.data;
}

export class MongoWebSearchConnections implements WebSearchStore {
  constructor(
    private readonly store: WebSearchRecordStore,
    private readonly owner: WebSearchOwnership,
    private readonly budgets: BudgetConfig,
  ) {}

  private writeOptions() {
    return {
      ...this.store.options(),
      timeoutMS: this.store.timeoutMs,
      writeConcern: { w: 'majority' as const, j: true },
    };
  }

  private accountFilter(userId: string) {
    return { _id: key('web-search-account', userId), userId, kind: 'account' };
  }

  private oauthFilter(userId: string, provider: string) {
    return { _id: key('web-search-oauth', userId, provider), userId, provider, kind: 'oauth-state' };
  }

  async readAccount(userId: string): Promise<StoredWebAccount | null> {
    const raw = await this.store.raw('web_search_connections', this.accountFilter(idSchema.parse(userId)));
    return decode(storedWebAccountSchema, raw);
  }

  async saveAccount(expectedRevision: number, next: StoredWebAccount): Promise<WebAccountCas> {
    await this.owner.assertExecutor();
    const value = parseRecord(storedWebAccountSchema, next);
    if (value.revision !== expectedRevision + 1) {
      throw new AppError('INVALID_REQUEST', 'Invalid persistence record.');
    }
    const id = key('web-search-account', value.userId);
    const doc = { _id: id, ...value, _revision: expectedRevision };
    assertBytes(doc, Math.min(ACCOUNT_BYTES, this.budgets.maxDocumentBytes));
    if (expectedRevision === 0) {
      let result;
      try {
        result = await this.store.collection('web_search_connections').updateOne(
          { _id: id, userId: value.userId, kind: 'account' },
          { $setOnInsert: doc },
          { upsert: true, ...this.writeOptions() },
        );
      } catch {
        return this.confirmAccount(value);
      }
      if (result.acknowledged && result.upsertedCount === 1) {
        await this.owner.assertExecutor();
        return { outcome: 'confirmed', record: value };
      }
      return this.confirmAccount(value);
    }
    let result;
    try {
      result = await this.store.collection('web_search_connections').replaceOne(
        { _id: id, userId: value.userId, kind: 'account', revision: expectedRevision },
        doc,
        this.writeOptions(),
      );
    } catch {
      return this.confirmAccount(value);
    }
    if (result.acknowledged && result.matchedCount === 1) {
      await this.owner.assertExecutor();
      return { outcome: 'confirmed', record: value };
    }
    return this.confirmAccount(value);
  }

  private async confirmAccount(next: StoredWebAccount): Promise<WebAccountCas> {
    let raw;
    try {
      raw = await this.store.raw('web_search_connections', this.accountFilter(next.userId));
    } catch {
      return { outcome: 'uncertain' };
    }
    if (!raw) return { outcome: 'uncertain' };
    let saved: StoredWebAccount | null;
    try {
      saved = decode(storedWebAccountSchema, raw);
    } catch {
      return { outcome: 'uncertain' };
    }
    if (!saved) return { outcome: 'uncertain' };
    if (isDeepStrictEqual(saved, next)) return { outcome: 'confirmed', record: saved };
    return { outcome: 'conflict', currentRevision: saved.revision };
  }

  async putOAuthState(record: StoredWebOAuthState): Promise<'confirmed' | 'uncertain'> {
    const value = parseRecord(storedWebOAuthStateSchema, record);
    const doc = { _id: key('web-search-oauth', value.userId, value.provider), ...value, _revision: 0 };
    assertBytes(doc, STATE_BYTES);
    try {
      const result = await this.store.collection('web_search_connections').replaceOne(
        this.oauthFilter(value.userId, value.provider),
        doc,
        { upsert: true, ...this.writeOptions() },
      );
      return result.acknowledged ? 'confirmed' : 'uncertain';
    } catch {
      return 'uncertain';
    }
  }

  async readOAuthState(
    userId: string,
    provider: StoredWebOAuthState['provider'],
    stateHash: string,
  ): Promise<StoredWebOAuthState | null> {
    const raw = await this.store.raw('web_search_connections', {
      ...this.oauthFilter(idSchema.parse(userId), provider),
      stateHash: sha256.parse(stateHash),
    });
    return decode(storedWebOAuthStateSchema, raw);
  }

  async consumeOAuthState(input: {
    userId: string; provider: StoredWebOAuthState['provider']; stateHash: string;
    browserHash: string; sessionHash: string; now: string;
  }): Promise<'consumed' | 'not-found' | 'uncertain'> {
    const value = parseRecord(consumeInputSchema, input);
    try {
      const saved = await this.store.collection('web_search_connections').findOneAndUpdate(
        {
          ...this.oauthFilter(value.userId, value.provider),
          stateHash: value.stateHash,
          browserHash: value.browserHash,
          sessionHash: value.sessionHash,
          consumedAt: null,
          expiresAt: { $gt: new Date(value.now) },
        },
        { $set: { consumedAt: value.now }, $inc: { _revision: 1 } },
        { returnDocument: 'after', includeResultMetadata: false, ...this.writeOptions() },
      );
      return saved ? 'consumed' : 'not-found';
    } catch {
      return 'uncertain';
    }
  }
}
