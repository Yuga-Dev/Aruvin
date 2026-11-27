/**
 * ============================================================================
 * FILE: user-memory.service.ts
 * LOCATION: backend/src/personalization/user-memory.service.ts
 * PURPOSE: Cache per-user memory and coordinate revision-safe updates.
 * ROLE IN PROJECT: Exposes immutable, pre-rendered RAM memory to the runtime.
 * KEY COMPONENTS: Coalesced warm, synchronous pin projection, bounded queue,
 * one-conflict recompute before publishing a confirmed record, direct section
 * edits, request-id idempotency, and best-effort content-free audit after each
 * confirmed change (retried in a bounded in-process queue, never rolled back).
 * ============================================================================
 */
import { isDeepStrictEqual } from 'node:util';
import type { UserMemoryCasResult, UserMemoryRepository, UserMemoryWriteSettings } from '../contracts/repositories.js';
import { USER_MEMORY_MAX_CHARS, USER_MEMORY_SECTION_KEYS, renderUserMemorySections, userMemoryCharCount,
  userMemorySectionsSchema,
  type MemoryAuditRecord, type PinnedUserMemory, type StoredUserMemory, type UserMemoryHistoryResponse,
  type UserMemoryResponse, type UserMemorySectionKey, type UserMemorySections,
  type UserMemoryWriterOutput } from '../contracts/user-memory.js';
import { findAuditGaps, type MemoryAuditPort } from '../persistence/memory-audit.js';
import { AppError } from '../platform/errors/app-error.js';
import { UserMemoryFault } from './errors.js';

const EMPTY = Object.freeze({ identity: '', work: '', preferences: '', ongoing: '', other: '' });
// ponytail: process-local queue ceilings; multiple live executors would need durable admission.
const MAX_ACTIVE_QUEUES = 8;
const MAX_PENDING_PER_USER = 8;
type QueueEntry = { tail: Promise<void>; owner: AbortController; depth: number };
// ponytail: process-local audit retry queue; a crash loses queued entries and history
// shows a gap. A durable outbox would close this.
const MAX_AUDIT_QUEUE = 64;
const AUDIT_ATTEMPTS = 3;
const PRUNE_EVERY_MS = 60 * 60_000;
export type MemoryAuditInfo = Pick<MemoryAuditRecord, 'action' | 'source' | 'origin'>;
type EditOptions = { expectedRevision?: number; requireEnabled?: boolean; signal?: AbortSignal;
  requestId?: string; audit?: MemoryAuditInfo };
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
  audit?: () => MemoryAuditPort | null;
  auditRetryMs?: number;
  report?: (code: 'PERSISTENCE_ERROR' | 'STORAGE_BUDGET_EXCEEDED') => void;
};
const sectionsOf = (record: StoredUserMemory | null): Readonly<UserMemorySections> => record?.sections ?? EMPTY;

export class UserMemoryService {
  private readonly records = new Map<string, CachedUserMemory | null>();
  private readonly pins = new Map<string, Readonly<PinnedUserMemory>>();
  private readonly warming = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, QueueEntry>();
  private readonly auditQueue: MemoryAuditRecord[] = [];
  private readonly auditJobs = new Set<Promise<void>>();
  private readonly lastPrune = new Map<string, number>();
  private readonly userChangeListeners = new Set<(userId: string) => void>();

  constructor(private readonly options: UserMemoryServiceOptions) {}

  cachedMemory(userId: string): CachedUserMemory | null | undefined { return this.records.get(userId); }
  cachedSnapshot(userId: string): Readonly<PinnedUserMemory> | null { return this.pins.get(userId) ?? null; }

  /** Called after a confirmed user-initiated change (edit, delete, enable/disable, composer). */
  onUserChange(listener: (userId: string) => void): () => void {
    this.userChangeListeners.add(listener);
    return () => { this.userChangeListeners.delete(listener); };
  }

  /** Resolves when every queued audit write has succeeded or been given up on. */
  async drainAudit(): Promise<void> { await Promise.allSettled(this.auditJobs); }

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

  async setEnabled(userId: string, expectedRevision: number, enabled: boolean,
    requestId?: string): Promise<UserMemoryResponse> {
    return (await this.mutate(userId, { expectedRevision, requestId,
      audit: { action: enabled ? 'enable' : 'disable', source: 'user-ui' } }, async current =>
      ({ settings: { enabled, sections: { ...sectionsOf(current) } }, summary: '' }))).memory;
  }

  async clear(userId: string, expectedRevision: number, requestId?: string): Promise<UserMemoryResponse> {
    return (await this.mutate(userId, { expectedRevision, requestId,
      audit: { action: 'clear-all', source: 'user-ui' } }, async current =>
      ({ settings: { enabled: current?.enabled ?? true, sections: { ...EMPTY } }, summary: '' }))).memory;
  }

  /** Direct text edit of one section; empty text clears it. Same validation as writer output. */
  async editSection(userId: string, expectedRevision: number, key: UserMemorySectionKey, text: string,
    requestId?: string): Promise<UserMemoryResponse> {
    if (!USER_MEMORY_SECTION_KEYS.includes(key)) throw new UserMemoryFault('INVALID_REQUEST');
    return (await this.mutate(userId, { expectedRevision, requestId,
      audit: { action: text === '' ? 'clear-section' : 'edit-section', source: 'user-ui' } }, async current => {
      const next = userMemorySectionsSchema.safeParse({ ...sectionsOf(current), [key]: text });
      if (!next.success) throw new UserMemoryFault('INVALID_REQUEST', null,
        next.error.issues.some(issue => issue.message === 'secret_pattern'));
      if (isDeepStrictEqual(next.data, sectionsOf(current))) return null;
      return { settings: { enabled: current?.enabled ?? true, sections: next.data }, summary: '' };
    })).memory;
  }

  clearSection(userId: string, expectedRevision: number, key: UserMemorySectionKey,
    requestId?: string): Promise<UserMemoryResponse> {
    return this.editSection(userId, expectedRevision, key, '', requestId);
  }

  /** Newest-first change history for the owner; reads the database, never on the model path. */
  async history(userId: string, query: { cursor?: string; limit: number }): Promise<UserMemoryHistoryResponse> {
    const port = this.options.audit?.();
    if (!port) throw new UserMemoryFault('NOT_READY');
    let page;
    try {
      page = await port.history(userId, query);
    } catch (error) {
      throw new UserMemoryFault(error instanceof AppError && error.code === 'INVALID_REQUEST'
        ? 'INVALID_REQUEST' : 'PERSISTENCE_ERROR');
    }
    this.pruneSoon(userId, port);
    const upper = page.cursorRevision ?? this.records.get(userId)?.revision ?? null;
    return { protocolVersion: 1, nextCursor: page.nextCursor,
      gaps: findAuditGaps(page.items, upper, page.cursorRevision === null),
      items: page.items.map(({ memoryRevision, at, action, source, sections, charsBefore, charsAfter, origin }) =>
        ({ memoryRevision, at, action, source, sections, charsBefore, charsAfter,
          ...(origin ? { origin } : {}) })) };
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
        if (expected !== undefined && expected !== revision) {
          const done = await this.alreadyApplied(userId, options.requestId, repo, signal);
          if (done) return done;
          throw new UserMemoryFault('MEMORY_CONFLICT', revision);
        }
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
          this.afterConfirmed(userId, current, result.record, at, options);
          return { changed: true, memory: view(result.record), changeSummary: proposal.summary };
        }
        if (result.outcome === 'uncertain') throw new UserMemoryFault('PERSISTENCE_ERROR');
        if (expected !== undefined || attempt === 1) {
          const done = await this.alreadyApplied(userId, options.requestId, repo, signal);
          if (done) return done;
          throw new UserMemoryFault('MEMORY_CONFLICT', result.currentRevision);
        }
        requireLive(signal);
      }
    });
  }

  // A retry after an unknown outcome meets a revision conflict; an audit record (or a queued
  // one) with the same requestId proves the first attempt applied, so answer with current memory.
  private async alreadyApplied(userId: string, requestId: string | undefined, repo: UserMemoryRepository,
    signal: AbortSignal): Promise<UserMemoryEditResult | null> {
    if (!requestId) return null;
    let found = this.auditQueue.some(entry => entry.userId === userId && entry.requestId === requestId);
    if (!found) {
      try { found = Boolean(await this.options.audit?.()?.findByRequestId(userId, requestId)); }
      catch { found = false; } // No proof of success: report the conflict.
    }
    if (!found) return null;
    const latest = await this.load(repo, userId);
    requireLive(signal);
    this.publish(userId, latest);
    return { changed: false, memory: view(latest), changeSummary: '' };
  }

  private afterConfirmed(userId: string, before: StoredUserMemory | null, after: StoredUserMemory, at: string,
    options: EditOptions): void {
    const info = options.audit;
    if (!info) return;
    const entry: MemoryAuditRecord = { schemaVersion: 1, kind: 'memory-audit', userId,
      memoryRevision: after.revision, ...(options.requestId ? { requestId: options.requestId } : {}), at,
      action: info.action, source: info.source,
      sections: USER_MEMORY_SECTION_KEYS.filter(key => sectionsOf(before)[key] !== after.sections[key]),
      charsBefore: userMemoryCharCount(renderUserMemorySections({ ...sectionsOf(before) })),
      charsAfter: userMemoryCharCount(renderUserMemorySections(after.sections)),
      ...(info.origin ? { origin: info.origin } : {}) };
    this.enqueueAudit(entry);
    if (info.source === 'user-ui' || info.source === 'composer')
      for (const listener of this.userChangeListeners) {
        try { listener(userId); } catch { /* A listener must not affect a confirmed change. */ }
      }
  }

  private enqueueAudit(entry: MemoryAuditRecord): void {
    if (this.auditQueue.length >= MAX_AUDIT_QUEUE) { this.options.report?.('STORAGE_BUDGET_EXCEEDED'); return; }
    this.auditQueue.push(entry);
    const job: Promise<void> = (async () => {
      let saved = false;
      for (let attempt = 0; attempt < AUDIT_ATTEMPTS && !saved; attempt++) {
        if (attempt) await new Promise<void>(done =>
          { setTimeout(done, (this.options.auditRetryMs ?? 500) * attempt).unref?.(); });
        try {
          const port = this.options.audit?.();
          if (!port) throw new UserMemoryFault('NOT_READY');
          await port.put(entry);
          saved = true;
          this.pruneSoon(entry.userId, port);
        } catch { /* Bounded retry; the memory change is already confirmed. */ }
      }
      if (!saved) this.options.report?.('PERSISTENCE_ERROR');
    })().finally(() => {
      this.auditQueue.splice(this.auditQueue.indexOf(entry), 1);
      this.auditJobs.delete(job);
    });
    this.auditJobs.add(job);
  }

  private pruneSoon(userId: string, port: MemoryAuditPort): void {
    const now = (this.options.now?.() ?? new Date()).getTime();
    if (now - (this.lastPrune.get(userId) ?? -Infinity) < PRUNE_EVERY_MS) return;
    if (this.lastPrune.size >= 256) this.lastPrune.clear();
    this.lastPrune.set(userId, now);
    void port.prune(userId, now).catch(() => this.lastPrune.delete(userId));
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
