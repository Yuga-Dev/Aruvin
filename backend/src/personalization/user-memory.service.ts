/**
 * ============================================================================
 * FILE: user-memory.service.ts
 * LOCATION: backend/src/personalization/user-memory.service.ts
 * PURPOSE: Cache per-user memory and coordinate revision-safe updates.
 * ROLE IN PROJECT: Exposes immutable, pre-rendered RAM memory to the runtime.
 * KEY COMPONENTS: Coalesced warm, synchronous pin projection, bounded queue,
 * and one-conflict recompute before publishing a confirmed record.
 * ============================================================================
 */
import { isDeepStrictEqual } from 'node:util';
import type { UserMemoryCasResult, UserMemoryRepository, UserMemoryWriteSettings } from '../contracts/repositories.js';
import { USER_MEMORY_MAX_CHARS, renderUserMemorySections, userMemoryCharCount,
  type PinnedUserMemory, type StoredUserMemory, type UserMemoryResponse, type UserMemorySections,
  type UserMemoryWriterOutput } from '../contracts/user-memory.js';
import { AppError } from '../platform/errors/app-error.js';
import { UserMemoryFault } from './errors.js';

const EMPTY = Object.freeze({ identity: '', work: '', preferences: '', ongoing: '', other: '' });
// ponytail: process-local queue ceilings; multiple live executors would need durable admission.
const MAX_ACTIVE_QUEUES = 8;
const MAX_PENDING_PER_USER = 8;
type QueueEntry = { tail: Promise<void>; owner: AbortController; depth: number };
type EditOptions = { expectedRevision?: number; requireEnabled?: boolean; signal?: AbortSignal };
type Proposal = { settings: UserMemoryWriteSettings; summary: string };
export type UserMemoryEditResult = { changed: boolean; memory: UserMemoryResponse; changeSummary: string };

function view(record: StoredUserMemory | null): UserMemoryResponse {
  const sections = { ...(record?.sections ?? EMPTY) };
  const charCount = userMemoryCharCount(renderUserMemorySections(sections));
  return { protocolVersion: 1, revision: record?.revision ?? 0, enabled: record?.enabled ?? true,
    sections, isEmpty: charCount === 0, charCount, maxChars: USER_MEMORY_MAX_CHARS,
    updatedAt: record?.updatedAt ?? null };
}

function requireLive(signal: AbortSignal): void {
  if (signal.aborted) throw new UserMemoryFault('NOT_READY');
}

export type CachedUserMemory = Readonly<Omit<StoredUserMemory, 'sections'>> & {
  readonly sections: Readonly<UserMemorySections>;
};
export type UserMemoryServiceOptions = {
  repository: () => UserMemoryRepository | null;
  now?: () => Date;
};

export class UserMemoryService {
  private readonly records = new Map<string, CachedUserMemory | null>();
  private readonly pins = new Map<string, Readonly<PinnedUserMemory>>();
  private readonly warming = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, QueueEntry>();

  constructor(private readonly options: UserMemoryServiceOptions) {}

  cachedMemory(userId: string): CachedUserMemory | null | undefined { return this.records.get(userId); }
  cachedSnapshot(userId: string): Readonly<PinnedUserMemory> | null { return this.pins.get(userId) ?? null; }

  warm(userId: string): Promise<void> {
    if (this.records.has(userId)) return Promise.resolve();
    const prior = this.warming.get(userId);
    if (prior) return prior;
    const task: Promise<void> = Promise.resolve().then(async () => {
      if (this.warming.get(userId) !== task) return;
      const record = await this.load(this.repository(), userId);
      if (this.warming.get(userId) === task && !this.records.has(userId)) this.publish(userId, record);
    }).catch(() => {
      // Cold admission is best effort. Leave absence distinct from failure.
    }).finally(() => {
      if (this.warming.get(userId) === task) this.warming.delete(userId);
    });
    this.warming.set(userId, task);
    return task;
  }

  evict(userId: string): void {
    this.records.delete(userId);
    this.pins.delete(userId);
    this.warming.delete(userId);
    this.pending.get(userId)?.owner.abort();
  }

  clearCache(): void {
    this.records.clear();
    this.pins.clear();
    this.warming.clear();
    for (const entry of this.pending.values()) entry.owner.abort();
  }

  read(userId: string): Promise<UserMemoryResponse> {
    return this.enqueue(userId, undefined, async signal => {
      const record = await this.load(this.repository(), userId);
      requireLive(signal);
      this.publish(userId, record);
      return view(record);
    });
  }

  async setEnabled(userId: string, expectedRevision: number, enabled: boolean): Promise<UserMemoryResponse> {
    return (await this.mutate(userId, { expectedRevision }, async current =>
      ({ settings: { enabled, sections: { ...(current?.sections ?? EMPTY) } }, summary: '' }))).memory;
  }

  async clear(userId: string, expectedRevision: number): Promise<UserMemoryResponse> {
    return (await this.mutate(userId, { expectedRevision }, async current =>
      ({ settings: { enabled: current?.enabled ?? true, sections: { ...EMPTY } }, summary: '' }))).memory;
  }

  applyEdit(userId: string, options: EditOptions,
    writer: (sections: Readonly<UserMemorySections>, signal: AbortSignal) =>
      Promise<UserMemoryWriterOutput>): Promise<UserMemoryEditResult> {
    return this.mutate(userId, options, async (current, signal) => {
      const sections = Object.freeze({ ...(current?.sections ?? EMPTY) });
      const result = await writer(sections, signal);
      if (!result.changed || isDeepStrictEqual(result.sections, sections)) return null;
      return { settings: { sections: result.sections, enabled: current?.enabled ?? true }, summary: result.changeSummary };
    });
  }

  private mutate(userId: string, options: EditOptions,
    propose: (current: StoredUserMemory | null, signal: AbortSignal) => Promise<Proposal | null>):
    Promise<UserMemoryEditResult> {
    return this.enqueue(userId, options.signal, async (signal, owner) => {
      const expected = options.expectedRevision;
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER))
        throw new UserMemoryFault('INVALID_REQUEST');
      const repo = this.repository();
      for (let attempt = 0; ; attempt++) {
        const current = await this.load(repo, userId);
        requireLive(signal);
        const revision = current?.revision ?? 0;
        if (expected !== undefined && expected !== revision)
          throw new UserMemoryFault('MEMORY_CONFLICT', revision);
        if (options.requireEnabled && current?.enabled === false) throw new UserMemoryFault('MEMORY_DISABLED');
        if (revision >= Number.MAX_SAFE_INTEGER) throw new UserMemoryFault('PERSISTENCE_ERROR');
        const proposal = await propose(current, signal);
        requireLive(signal);
        if (!proposal) return { changed: false, memory: view(current), changeSummary: '' };

        const at = (this.options.now?.() ?? new Date()).toISOString();
        let result: UserMemoryCasResult;
        try {
          result = revision === 0 ? await repo.createIfAbsent(userId, proposal.settings, at)
            : await repo.compareAndSwap(userId, revision, proposal.settings, at);
        } catch (error) {
          throw new UserMemoryFault(error instanceof AppError && error.code === 'NOT_READY'
            ? 'NOT_READY' : 'PERSISTENCE_ERROR');
        }
        requireLive(owner);
        if (result.outcome === 'confirmed') {
          this.publish(userId, result.record);
          return { changed: true, memory: view(result.record), changeSummary: proposal.summary };
        }
        if (result.outcome === 'uncertain') throw new UserMemoryFault('PERSISTENCE_ERROR');
        if (expected !== undefined || attempt === 1)
          throw new UserMemoryFault('MEMORY_CONFLICT', result.currentRevision);
        requireLive(signal);
      }
    });
  }

  private enqueue<T>(userId: string, outer: AbortSignal | undefined,
    run: (signal: AbortSignal, owner: AbortSignal) => Promise<T>): Promise<T> {
    const previous = this.pending.get(userId);
    if ((!previous && this.pending.size >= MAX_ACTIVE_QUEUES) ||
        (previous && previous.depth >= MAX_PENDING_PER_USER))
      return Promise.reject(new UserMemoryFault('NOT_READY'));
    const entry = previous && !previous.owner.signal.aborted ? previous
      : { tail: previous?.tail ?? Promise.resolve(), owner: new AbortController(), depth: 0 };
    const owner = entry.owner.signal;
    const signal = outer ? AbortSignal.any([outer, owner]) : owner;
    entry.depth++;
    const work = entry.tail.then(() => { requireLive(signal); return run(signal, owner); });
    const settled = () => {
      entry.depth--;
      if (entry.depth === 0 && this.pending.get(userId) === entry) this.pending.delete(userId);
    };
    entry.tail = work.then(settled, settled);
    this.pending.set(userId, entry);
    return work;
  }

  private publish(userId: string, record: StoredUserMemory | null): void {
    this.records.set(userId, record && Object.freeze({ ...record, sections: Object.freeze({ ...record.sections }) }));
    const content = record?.enabled ? renderUserMemorySections(record.sections) : '';
    if (record && content) this.pins.set(userId, Object.freeze({ revision: record.revision, content }));
    else this.pins.delete(userId);
  }

  private repository(): UserMemoryRepository {
    const repo = this.options.repository();
    if (!repo) throw new UserMemoryFault('NOT_READY');
    return repo;
  }

  private async load(repo: UserMemoryRepository, userId: string): Promise<StoredUserMemory | null> {
    try {
      return await repo.read(userId);
    } catch (error) {
      throw new UserMemoryFault(error instanceof AppError && error.code === 'NOT_READY'
        ? 'NOT_READY' : 'PERSISTENCE_ERROR');
    }
  }
}
