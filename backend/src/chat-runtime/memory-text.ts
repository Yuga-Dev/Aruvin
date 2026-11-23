/**
 * ============================================================================
 * FILE: memory-text.ts
 * LOCATION: backend/src/chat-runtime/memory-text.ts
 * ============================================================================
 * PURPOSE: Connect ordinary text and live voice to one bounded memory foundation.
 * ROLE IN PROJECT: Owner-bound memory compartment inside one DurableChatRuntime.
 * KEY COMPONENTS: Explicit ownerId, shared epoch/capacity, cold hydration, save-only archive.
 * ============================================================================
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  MemoryFirstFoundation, eraseMemoryCalendarMutation,
  type MemoryCapacity, type MemoryFirstPolicy, type MemoryTurn,
  type MemoryTerminal, type MemoryAcceptance, type MemoryCalendarMutation,
} from './memory-first-foundation.js';
import type { ResolvedIdentity } from '../contracts/identity.js';
import { diagnose, type RuntimeDependencies, type ExecuteTurn, type SubmitLiveTurn, type CalendarCompatibleEnvelope } from './ports.js';
import { voiceDeliveryRecordSchema, type VoiceDeliveryRecord } from '../contracts/voice.js';
import { SpeechProse } from '../voice/agent/speech-prose.js';
import type { CanvasArtifactProjection } from '../contracts/voice-wire.js';
import type { DurableChatRuntime } from './durable-chat-runtime.js';
import type { RetryTurnCommand, CancelTurnCommand } from '../contracts/runtime.js';
import type { SubmitTurnCommand as PortSubmitTurnCommand } from './ports.js';
import type { RuntimeConfigSnapshot } from '../contracts/config-runtime.js';
import {
  defaultPersonalizationSettings,
  type UserPersonalizationSettings,
} from '../contracts/personalization.js';
import type { AttemptRecord } from '../contracts/attempt.js';
import type { AccountingRecord } from '../contracts/metadata.js';
import type { SessionRecord } from '../contracts/session.js';
import type { MessageRecord } from '../contracts/message.js';
import type { WeatherView } from '../contracts/weather-view.js';
import type { PageQuery, ExecutionLease } from '../contracts/repositories.js';
import type { ConfirmedRecord } from '../persistence/confirmed-record.js';
import { inspectConfirmedRecord } from '../persistence/confirmed-record.js';
import type { AcceptanceRecord } from '../persistence/ownership.js';
import type { CalendarMutationHandle } from '../persistence/sessions.js';
import { calendarAccountBindingSchema, type CalendarAccountBinding } from '../contracts/calendar-discovery.js';
import type { CalendarProposalRecord } from '../contracts/calendar-authority.js';
import type { CompatibleCalendarToolGroup } from '../context/calendar-context.js';
import { redactCalendarMessage, redactCalendarMessageForAccount, redactCalendarSourceForAccount } from '../persistence/calendar-records.js';
import { calendarHistory } from './calendar-history.js';
import { CalendarTurnLedger } from './calendar-budget.js';
import { publishCalendarTurn } from './calendar-publication.js';
import {
  pendingCalendarOperation,
  reconcileCalendarOperationV2,
  reconcileConsumedProposalWithoutOperation,
  reconcilePlannedCalendarOperationV2,
} from './calendar-recovery.js';
import { unavailableMoney } from '../contracts/usage-evidence.js';
import type { CalendarTurnBudget } from '../contracts/calendar-accounting.js';
import type { CalendarCursor, CalendarRefs, CalendarSeal } from '../agent/state.js';
import type { TurnGraph, CalendarGraphPatch } from '../agent/turn-graph.js';
import type { Work } from './work.js';
import { turnStatusResponseSchema, hasCanvasContent, toVisibleMessage } from '../contracts/api.js';
import { streamEnvelopeSchema, type StreamEvent } from '../contracts/stream.js';
import { ReferencedContextAssembler, projectTurnMessages, type PositionedContext } from '../context/referenced-context-assembler.js';
import { buildReferenceManifest, validateManifest } from '../context/reference-selection.js';
import { defaultEnvironmentContext, estimateMessagesTokens, fixedContextMessages, validateInput } from '../context/context-budget.js';
import { createModelServices } from '../model/index.js';
import { CompactionRunner } from '../model/compaction-runner.js';
import { selectCompactionCutpoint, type CompactionTurn } from '../context/cutpoint.js';
import type { ActiveSummaryRecord } from '../contracts/agent-memory.js';
import { buildTurnGraph } from '../agent/turn-graph.js';
import { boundaryFor } from '../agent/state.js';
import { shouldAdvertiseWebTool } from '../contracts/web-search-policy.js';
import { WEB_TOOL_DEFINITION } from '../contracts/web-search-tools.js';
import { GET_ENVIRONMENT_TOOL_DEFINITION } from '../contracts/environment-tools.js';
import { createWebNativeModelPort, environmentRepairFeedback, memoryCallId, memoryReceiptHeadroom,
  memoryReceiptText, type WebNativeDecision, type WebNativeMessage }
  from '../model/web-native.js';
import { UPDATE_USER_MEMORY_TOOL_DEFINITION } from '../contracts/user-memory.js';
import type { CalendarFailure } from '../contracts/calendar-policy.js';
import { WebTurn } from './web-turn.js';
import { graphConfig, terminal, transitionConfirmed } from './finalization.js';
import { sessionIdFor, responseFor, titleFor } from './identity.js';
import { graphThreadId, bounded, counterSchema, acceptanceSchema, key } from '../persistence/records.js';
import { messageRecordSchema } from '../contracts/message.js';
import { AppError } from '../platform/errors/app-error.js';
import { hashPayload } from '../platform/crypto/hash-payload.js';
import { normalizeTimeZone, type RequestGeoHint } from '../platform/environment/request-environment.js';
import {
  OpenMeteoWeatherProvider, executeEnvironmentTool, extractSavedLocation, type WeatherProvider,
} from '../environment/index.js';
import { page, cursor } from '../persistence/pagination.js';
import { MemoryTextArchive } from '../persistence/memory-text-archive.js';
import { readMemoryCalendarStates } from '../persistence/memory-calendar-reader.js';
import { memoryWebRecordSchema, readMemoryWebRecords, type MemoryWebRecord }
  from '../persistence/memory-web-records.js';
import { admitNativePrompt, insertWebGroups, type HistoricalWebResult, type WebContextResult }
  from '../context/web-context.js';
import { foldHistoricalWebResult } from '../context/tool-folding.js';
import { type WebToolGroup } from './memory-web-state.js';
import { assembleTurnCalendarContext, CalendarLoop } from './calendar-loop.js';
import { separateAssistantContinuation } from './assistant-continuation.js';
import { createTurnModelMode, dispatchStream, type TurnModelDispatch } from './turn-model-mode.js';
import type { CalendarOperationWriterOptions } from './calendar-operation.js';
import { isCalendarV2, asCalendarAccountingPort } from './calendar-ports.js';
import { MemoryCalendarLedger } from './memory-calendar-ledger.js';
import {
  MemoryCalendarStage,
  eraseMemoryCalendarStateForAccount,
  isCalendarBearingState,
  memoryCalendarIntegrity,
  memoryCalendarPublicationHash,
  memoryCalendarRecordSchema,
  memoryCalendarStateSchema,
  type MemoryCalendarIntegrity,
  type MemoryCalendarState,
} from './memory-calendar-state.js';
import { CALENDAR_LIMITS } from '../contracts/calendar-policy.js';
import { CALENDAR_TOMBSTONE } from '../contracts/calendar-sources.js';
import { redactSummaryCalendar, type CompactionCheckpointMeta } from '../contracts/agent-memory.js';
import type { ContextUsageMeta } from '../contracts/context.js';
import type { ContextChatMessage } from '../contracts/context.js';
import { ownedCanvasInventory, ownedCanvasSelection, navigateCanvas, controlCanvas } from './canvas-navigation.js';
import type { CanvasInventorySnapshot, CanvasSelection } from '../contracts/canvas-navigation.js';

/** Proposed encoded-data ceilings, not an operator-approved V8 heap/RSS budget. */
export const PROPOSED_MEMORY_TEXT_POLICY: Readonly<MemoryFirstPolicy> = Object.freeze({
  maxSessions: 16, maxSessionBytes: 8_388_608, maxMemoryBytes: 134_217_728,
  maxRequestsPerSession: 128, maxTurnsPerSession: 128,
  maxEnvelopes: 32, maxEnvelopeBytes: 524_288, maxBacklogBytes: 16_777_216,
  maxInputBytes: 65_536, maxOutputBytes: 131_072, maxEvidenceBytes: 131_072,
  maxOperationsPerSave: 32, maxConcurrentSaves: 2, maxAttempts: 3,
  retryBackoffMs: 1_000, writeTimeoutMs: 15_000, maxDirtyAgeMs: 60_000,
  requestRetentionMs: 300_000, shutdownDrainMs: 20_000,
});

type Entry = { identity: Readonly<ResolvedIdentity>; turn: MemoryTurn; snapshot: RuntimeConfigSnapshot | null; budgets: RuntimeConfigSnapshot['budgets']; personalization: UserPersonalizationSettings | null; clientTimeZone?: string | null; requestGeo?: RequestGeoHint | null; status: AttemptRecord['status'];
  error: AppError | null; accounting?: AccountingRecord; delivery?: VoiceDeliveryRecord;
  calendar?: MemoryCalendarState; calendarMutation?: MemoryCalendarMutation; calendarView?: MessageRecord['calendarView'];
  weatherView?: MessageRecord['weatherView'];
  sourceProvenance?: MessageRecord['sourceProvenance']; initialBudget?: CalendarTurnBudget; native?: NativeExecution; running: boolean; web?: WebTurn;
  webAcceptedAt?: number; webLimits?: import('../contracts/web-search-policy.js').WebSearchLimits;
  memoryUpdated?: true };
type Promotion = { lease: ExecutionLease; binding?: CalendarAccountBinding; attempt?: AttemptRecord;
  receipt?: ConfirmedRecord<AttemptRecord>; acceptance?: AcceptanceRecord; graph?: TurnGraph; ledger?: CalendarTurnLedger;
  ready: boolean };
type MutationBarrier = {
  handle?: CalendarMutationHandle;
  paused: boolean;
  inputReceipt?: ConfirmedRecord<MessageRecord>;
  attemptReceipt?: ConfirmedRecord<AttemptRecord>;
  acceptance?: AcceptanceRecord;
  sequenceUpdated: boolean;
  discoveryUpdated: boolean;
  replyBound: boolean;
  ledger?: CalendarTurnLedger;
  binding?: CalendarAccountBinding;
  acceptedConfirmed: boolean;
  prefixFrozen: boolean;
  prefixCalendar?: MemoryCalendarState;
  prefixIntegrity?: MemoryCalendarIntegrity;
  nativePublication?: AttemptRecord['nativePublication'];
  mutation?: {
    operationId: string;
    decision: MemoryCalendarMutation['decision'];
    result: MemoryCalendarMutation['result'];
  };
};
type NativeExecution = { ledger: MemoryCalendarLedger; stage: MemoryCalendarStage; loop: CalendarLoop;
  job: Work; promotion?: Promotion; mutation?: MutationBarrier; boundAccount?: CalendarAccountBinding; invalidation: number; pending: boolean };
type Cold = { session: SessionRecord; attempts: AttemptRecord[]; stale: boolean;
  groups?: Map<string, readonly CompatibleCalendarToolGroup[]>; pendingProposal?: CalendarProposalRecord | null;
  webGroups?: Map<string, WebToolGroup[]>; accountBinding?: CalendarAccountBinding | null;
  canvasArchive?: MessageRecord[];
  memoryUpdated?: Set<string>;
  compaction?: {
    running: Promise<void> | null;
    abort: AbortController | null;
    pending: { summary: ActiveSummaryRecord; checkpoint: CompactionCheckpointMeta; forVersion: number } | null;
    failures: number;
    cooldownUntil: number;
  } };
export class DurableHistoryRequired extends AppError {
  constructor() { super('NOT_READY', 'This chat requires its durable Calendar path.'); }
}

/** Stable newest-last merge; later entries win for the same message identity. */
function mergeCanvasRecords(records: readonly MessageRecord[],
  limit = Number.POSITIVE_INFINITY): MessageRecord[] {
  const merged = new Map<string, MessageRecord>();
  for (const record of records) merged.set(record.messageId, record);
  return [...merged.values()].sort((a, b) => a.sequence - b.sequence).slice(-limit);
}

export class MemoryText {
  readonly foundation: MemoryFirstFoundation;
  // ponytail: O(maxSessions) coordinated clean sweep after requestRetentionMs;
  // dirty, active, loading, or reserved sessions stay pinned in both maps.
  private readonly entries = new Map<string, Entry>();
  private readonly sessions = new Map<string, Cold>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly archive: MemoryTextArchive | null;
  private readonly policy: Readonly<MemoryFirstPolicy>;
  private readonly invalidatedAccounts = new Set<string>();
  private readonly compactionJobs = new Set<Promise<void>>();
  private readonly compactionRunner: CompactionRunner;
  private defaultWeatherProvider: WeatherProvider | null = null;
  constructor(private readonly runtime: DurableChatRuntime, private readonly d: RuntimeDependencies,
    readonly ownerId: string, epoch: string,
    shared: { otherCapacity: () => MemoryCapacity; onSaveSettled: () => void }) {
    const options = d.memoryFirst!;
    this.policy = Object.freeze({ ...options.policy });
    this.archive = options.save ? null : new MemoryTextArchive(d.persistence, d.assets, () => Date.parse(this.runtime.now()));
    this.foundation = new MemoryFirstFoundation({ userId: ownerId, epoch,
      policy: this.policy, save: options.save ?? this.archive!.save, now: d.now,
      saveVoiceObservation: options.saveVoiceObservation ?? this.archive?.saveVoiceObservation, ...shared });
    this.compactionRunner = new CompactionRunner({
      putAccounting: d.persistence.metadata.putAccounting.bind(d.persistence.metadata),
      fetcher: d.fetcher, now: () => this.runtime.now(), report: d.diagnostics?.emit,
    });
  }
  private weatherProvider(): WeatherProvider {
    if (this.d.weatherProvider) return this.d.weatherProvider;
    this.defaultWeatherProvider ??= new OpenMeteoWeatherProvider({ fetcher: this.d.fetcher ?? fetch });
    return this.defaultWeatherProvider;
  }
  eligibleVoice(): boolean { return Boolean(this.d.memoryFirst?.voice && this.eligible()); }
  eligible(): boolean { return !this.d.currentConfig?.current()?.calendar?.enabled || Boolean(this.d.calendar && isCalendarV2(this.d.calendar)); }
  owns(sessionId: string): boolean { return this.foundation.has(sessionId); }
  get loadingCount(): number { return this.loading.size; }
  hasRequest(sessionId: string, requestKey: string): boolean { return this.foundation.find(sessionId, requestKey) !== null; }
  attemptBudgets(userId: string, sessionId: string, attemptId: string) {
    this.user(userId); const e = this.entries.get(attemptId);
    return e?.turn.sessionId === sessionId ? { idleStreamTimeoutMs: e.budgets.idleStreamTimeoutMs,
      maxMessageBytes: e.budgets.maxMessageBytes } : null;
  }
  find(sessionId: string, turnId: string): Entry | null {
    if (this.sessions.get(sessionId)?.stale) return null;
    const turn = this.foundation.byTurn(sessionId, turnId);
    if (turn && this.sessions.get(sessionId)?.attempts.some(a => a.turnId === turnId && a.sequence > turn.sequence + 2)) return null;
    return turn ? this.entries.get(turn.attemptId) ?? null : null;
  }
  busy(sessionId: string): boolean { return this.owns(sessionId) && this.foundation.session(sessionId).dirty; }
  /** Called before entering the old durable path, including live reservations. */
  handoff(sessionId: string): void {
    if (!this.owns(sessionId)) return;
    if (this.busy(sessionId)) throw new AppError('NOT_READY', 'This chat is still saving. Try again shortly.');
    const state = this.sessions.get(sessionId);
    if (state) state.stale = true;
  }
  assertMutation(userId: string, sessionId: string): void {
    this.user(userId);
    // ponytail: reject mutation during dirty authority; add queued mutation/tombstone
    // projection only when pending rename/delete UX is explicitly implemented.
    if (this.busy(sessionId)) throw new AppError('NOT_READY', 'This chat is still saving. Try again shortly.');
    this.handoff(sessionId);
  }
  /** Passive batch confirmation: project a durable marker without changing hashes. */
  projectPassiveMarker(sessionId: string, messageId: string): void {
    const cold = this.sessions.get(sessionId);
    if (!cold) return;
    const markers = cold.memoryUpdated ??= new Set<string>();
    markers.delete(messageId); markers.add(messageId);
    const limit = Math.max(1, this.d.config.budgets.maxMessagesInContext);
    while (markers.size > limit) markers.delete(markers.values().next().value!);
  }
  /** Advance the RAM watermark only for the resident, unchanged session record. */
  projectMemoryWatermark(sessionId: string, sequence: number): void {
    const cold = this.sessions.get(sessionId);
    if (!cold) return;
    cold.session = { ...cold.session,
      memoryWatermarkSequence: Math.max(sequence, cold.session.memoryWatermarkSequence ?? 0) };
  }
  private visible(record: MessageRecord, cold: Cold | undefined): MessageRecord {
    return record.memoryUpdated === true || !cold?.memoryUpdated?.has(record.messageId)
      ? record : { ...record, memoryUpdated: true };
  }
  /** Hydration, unsettled work, or a running compactor still owns the Temporary Chat. */
  temporaryPurgeBusy(sessionId: string): boolean {
    if (this.loading.has(sessionId)) return true;
    if (this.foundation.has(sessionId) && this.busy(sessionId)) return true;
    if (this.sessions.get(sessionId)?.compaction?.running) return true;
    return [...this.entries.values()].some(e => e.turn.sessionId === sessionId && this.isUnsettledEntry(e));
  }
  /** Quiesce the scoped Temporary Chat before its durable cascade. */
  async settleTemporaryPurge(sessionId: string): Promise<void> {
    const loading = this.loading.get(sessionId);
    if (loading) await loading.catch(() => undefined);
    const cold = this.sessions.get(sessionId);
    cold?.compaction?.abort?.abort();
    if (cold?.compaction?.running) await cold.compaction.running.catch(() => undefined);
    if (this.foundation.has(sessionId)) await this.foundation.flushSession(sessionId);
  }
  /** Remove a confirmed-purged Temporary Chat from RAM only. */
  dropTemporarySession(sessionId: string): void {
    for (const [attemptId, entry] of this.entries) if (entry.turn.sessionId === sessionId) this.entries.delete(attemptId);
    this.sessions.delete(sessionId);
    this.loading.delete(sessionId);
    if (this.foundation.has(sessionId)) this.foundation.evictClean(sessionId, true);
  }
  private user(userId: string): void {
    if (userId !== this.ownerId) throw new AppError('NOT_FOUND', 'Chat not found.');
  }
  private snapshot(): RuntimeConfigSnapshot {
    const s = this.d.currentConfig?.current();
    if (!s?.openRouter.apiKey || !s.modelLimits || s.modelLimits.modelId !== s.openRouter.modelId)
      throw new AppError('NOT_READY', 'Chat configuration is unavailable.');
    return s;
  }
  private evictCleanSessions(excludeSessionId?: string): void {
    const u = this.ownerId;
    this.foundation.evictCleanObservations();
    for (const id of this.foundation.sessionIds()) {
      if (id === excludeSessionId || this.loading.has(id) || this.runtime.work.get(u, id) ||
          this.runtime.reservations.hasSession(u, id)) continue;
      if (!this.foundation.evictClean(id)) continue;
      for (const [attemptId, entry] of this.entries) if (entry.turn.sessionId === id) this.entries.delete(attemptId);
      this.sessions.delete(id);
    }
  }
  private async hydrate(sessionId: string, snapshot: RuntimeConfigSnapshot): Promise<void> {
    this.evictCleanSessions(sessionId);
    if (this.owns(sessionId) && !this.sessions.get(sessionId)?.stale) return;
    const loading = this.loading.get(sessionId); if (loading) return loading;
    if (this.loading.size >= snapshot.budgets.maxConcurrentGenerationsPerProcess)
      throw new AppError('CONCURRENCY_LIMIT', 'Too many chat requests are active.');
    const load = (async () => {
      const p = this.d.persistence, u = this.ownerId;
      const session = await p.sessions.get(u, sessionId);
      if (!session || session.lifecycle !== 'active') throw new AppError('NOT_FOUND', 'Chat not found.');
      if (session.execution.ownerId || session.execution.activeAttemptId) throw new AppError('NOT_READY', 'Chat needs recovery.');
      const source = await p.memory.get(u, sessionId);
      if (!source) throw new AppError('NOT_READY', 'Chat context needs recovery.');
      // A stored manifest keeps the instructions/knowledge versions it was written
      // with. Accept it only when its own schema matches and the manifest is
      // structurally valid for those stored versions; the checkpoint boundary
      // below still has to name the stored manifest, not the upgraded one.
      const needsAssetUpgrade = source.graphSchemaVersion === this.d.assets.graphSchemaVersion &&
        (source.instructionVersion !== this.d.assets.instructionVersion ||
          source.knowledgeContentHash !== this.d.assets.knowledgeContentHash);
      const validationAssets = needsAssetUpgrade
        ? { ...this.d.assets, instructionVersion: source.instructionVersion,
            knowledgeContentHash: source.knowledgeContentHash }
        : this.d.assets;
      validateManifest(source, { userId: u, sessionId }, validationAssets, snapshot.budgets);
      if (session.memoryPublication && session.memoryPublication.version !== source.contextVersion)
        throw new AppError('NOT_READY', 'Chat save needs recovery.');
      const records = await p.messages.getReferences(u, sessionId, source.messageRefs);
      let summary = source.activeSummaryRef
        ? await p.metadata.getCompactionSummary?.(u, sessionId, source.activeSummaryRef.summaryId) ?? null
        : null;
      if (source.activeSummaryRef && (!summary || summary.summaryId !== source.activeSummaryRef.summaryId
        || !isDeepStrictEqual(summary.sourceRange, source.activeSummaryRef.sourceRange)))
        throw new AppError('NOT_READY', 'Chat summary needs recovery.');
      const pendingProposal = snapshot.calendar?.enabled
        ? await p.calendarProposals.getCurrentSlot(u, sessionId) : null;
      let accountBinding: CalendarAccountBinding | null = null;
      if (snapshot.calendar?.enabled && this.d.calendar && isCalendarV2(this.d.calendar)) {
        try {
          accountBinding = await this.d.calendar.connection.currentAccount();
        } catch {
          accountBinding = null;
        }
      }
      if (summary?.calendarProvenance.containsCalendarContent && summary.calendarProvenance.redactedAt === null) {
        const expired = summary.calendarProvenance.earliestExpiresAt
          && Date.parse(this.runtime.now()) >= Date.parse(summary.calendarProvenance.earliestExpiresAt);
        const mismatch = !accountBinding
          || accountBinding.connectionId !== summary.calendarProvenance.connectionId
          || accountBinding.connectionRevision !== summary.calendarProvenance.connectionRevision;
        if (expired || mismatch) summary = redactSummaryCalendar(summary, this.runtime.now());
      }
      const groups = await calendarHistory(p, u, sessionId, records, () => Date.parse(this.runtime.now()), session);
      const tailMinSeq = records[0]?.sequence ?? (source.activeSummaryRef ? source.activeSummaryRef.sourceRange.toSequence + 1 : 0);
      const attempts: AttemptRecord[] = [];
      let next: string | null = null;
      do {
        const found = await p.metadata.listAttempts(u, sessionId, { cursor: next,
          limit: Math.min(50, p.metadata.budgets.maxPageSize) });
        if (found.items.some(a => !terminal(a.status) || (session.memoryPublication && a.sequence > session.memoryPublication.sequence)))
          throw new AppError('NOT_READY', 'Chat save needs recovery.');
        attempts.push(...found.items.filter(a => a.sequence >= tailMinSeq));
        if (found.items.some(a => a.sequence < tailMinSeq)) break;
        next = found.nextCursor;
        if (attempts.length > this.policy.maxRequestsPerSession || (next && attempts.length >= this.policy.maxRequestsPerSession))
          throw new AppError('STORAGE_BUDGET_EXCEEDED', 'This chat has reached its record limit. Start a new chat.');
      } while (next);
      const lease = { userId: u, sessionId, ownerId: p.owner.executorId,
        generation: session.execution.generation, leaseExpiresAt: this.runtime.now() };
      const graph = await this.runtime.graph(lease);
      const state = await graph.getState(graphConfig(u, sessionId));
      if (state.next.length || !isDeepStrictEqual(state.values.boundary, boundaryFor(source)))
        throw new AppError('NOT_READY', 'Chat graph needs recovery.');
      const ids = records.filter(r => r.mode === 'live' && r.role === 'assistant' && r.attemptId).map(r => r.attemptId!);
      const deliveries = ids.length ? await p.metadata.getVoiceDeliveries(u, sessionId, ids) : [];
      const latestPage = await p.messages.listForContext(u, sessionId, { cursor: null, limit: 1 });
      if (session.memoryPublication && latestPage.items[0] && latestPage.items[0].sequence > session.memoryPublication.sequence)
        throw new AppError('NOT_READY', 'Chat save needs recovery.');
      // ponytail: bounded ten-page cold walk; replace with an indexed Canvas
      // projection only if pre-compaction artifact history outgrows this ceiling.
      let canvasArchive: MessageRecord[] = [];
      if (source.activeSummaryRef) {
        const ceiling = source.activeSummaryRef.sourceRange.toSequence;
        const limit = Math.min(snapshot.budgets.maxPageSize, p.messages.budgets.maxPageSize);
        const found: MessageRecord[] = [];
        for (const record of latestPage.items) {
          if (record.sequence > ceiling) continue;
          if (session.memoryPublication && record.sequence > session.memoryPublication.sequence) continue;
          if (hasCanvasContent(record)) found.push(record);
        }
        if (latestPage.nextCursor) {
          const oldestTail = records.reduce<MessageRecord | null>(
            (min, record) => !min || record.sequence < min.sequence
              || (record.sequence === min.sequence && record.messageId < min.messageId) ? record : min,
            null,
          );
          let canvasCursor: string | null = oldestTail && oldestTail.sequence > ceiling
            ? cursor({ kind: 'messages', userId: u, sessionId, value: oldestTail.sequence, id: oldestTail.messageId })
            : latestPage.nextCursor;
          for (let pages = 0; pages < 10; pages++) {
            const older = await p.messages.listForContext(u, sessionId, { cursor: canvasCursor, limit });
            for (const record of older.items) {
              if (record.sequence > ceiling) continue;
              if (session.memoryPublication && record.sequence > session.memoryPublication.sequence) continue;
              if (hasCanvasContent(record)) found.push(record);
            }
            if (found.length >= 500 || !older.nextCursor || older.items.length === 0
              || older.nextCursor === canvasCursor) break;
            canvasCursor = older.nextCursor;
          }
        }
        canvasArchive = mergeCanvasRecords(found, snapshot.budgets.maxPageSize);
      }
      const archive = [...records];
      const counter = p.owner.store ? await p.owner.store.read('metadata', counterSchema,
        { _id: key('sequence-counter', u, sessionId), userId: u, sessionId }) : null;
      const nextSequence = Math.max(Math.max(-1, ...archive.map(r => r.sequence), ...attempts.map(a => a.sequence),
        latestPage.items[0]?.sequence ?? -1) + 1, counter?.next ?? 0);
      const native = await readMemoryCalendarStates(p, session, records, this.policy.maxRequestsPerSession, attempts);
      let web: MemoryWebRecord[] = [];
      if (p.owner.store) {
        const tailAttemptIds = attempts.map(a => a.attemptId);
        for (let i = 0; i < tailAttemptIds.length; i += 32) {
          web.push(...await readMemoryWebRecords(p.owner.store, u, sessionId, tailAttemptIds.slice(i, i + 32)));
        }
        if (web.length) {
          const byAttempt = new Map(web.map(record => [record.attemptId, record]));
          for (const record of [...records, ...archive]) {
            if (record.role !== 'assistant' || !record.attemptId) continue;
            const saved = byAttempt.get(record.attemptId);
            if (!saved) continue;
            if (!record.webSources?.length && saved.state.sources.length)
              record.webSources = [...saved.state.sources];
            if (!record.webActivities?.length && saved.state.activities.length)
              record.webActivities = [...saved.state.activities];
          }
        }
      }
      const webGroups = new Map<string, WebToolGroup[]>();
      for (const record of web) {
        if (record.groups.length) webGroups.set(record.turnId, [...record.groups]);
      }
      const hydratedManifest = needsAssetUpgrade
        ? { ...source, instructionVersion: this.d.assets.instructionVersion,
            knowledgeContentHash: this.d.assets.knowledgeContentHash }
        : source;
      this.foundation.hydrate({ manifest: hydratedManifest, records, ...(summary ? { summary } : {}) }, deliveries, nextSequence, archive, native, web);
      this.sessions.set(sessionId, { session, attempts, stale: false, groups, webGroups, accountBinding,
        ...(canvasArchive.length ? { canvasArchive } : {}),
        pendingProposal: pendingProposal?.state === 'pending' ? pendingProposal : null });
    })();
    this.loading.set(sessionId, load);
    try { await load; } finally { this.loading.delete(sessionId); }
  }
  async prepare(userId: string, sessionId: string): Promise<void> {
    this.user(userId);
    await this.hydrate(sessionId, this.snapshot());
  }
  async submit(c: PortSubmitTurnCommand, retry?: { previous: Entry | AttemptRecord; input: MessageRecord }, live?: SubmitLiveTurn): Promise<ReturnType<typeof responseFor>> {
    const identity = this.runtime.identity(c.identity); this.runtime.ready();
    if (identity.userId !== this.ownerId) throw new AppError('NOT_FOUND', 'Chat not found.');
    const sessionId = sessionIdFor(c.identity.userId, c.sessionId, c.idempotencyKey);
    this.evictCleanSessions(sessionId);
    const creating = c.sessionId === null || live?.freshConversation === true;
    if (!creating && c.ephemeral !== undefined)
      throw new AppError('INVALID_REQUEST', 'Temporary mode is selected when starting a conversation.');
    const existing = this.foundation.find(sessionId, c.idempotencyKey);
    const readOriginPin = () => c.ephemeral === true ? null
      : this.d.userMemory?.cache.cachedSnapshot(identity.userId);
    const accept = (config: MemoryAcceptance['config'], ephemeral = c.ephemeral === true) => {
      try { return this.foundation.accept({ sessionId, requestKey: c.idempotencyKey, content: c.content,
        ...(c.expectedEpoch ? { expectedEpoch: c.expectedEpoch } : {}),
        mode: live ? 'live' : 'text', voice: live?.voice ?? null, calendarReplyTo: c.calendarReplyTo ?? null, config,
        ...(ephemeral ? { ephemeral: true } : {}),
        ...(retry ? { retryOf: { turnId: retry.input.turnId, userMessageId: retry.input.messageId,
          inputEventId: retry.input.eventId, sequence: retry.input.sequence, createdAt: retry.input.createdAt,
          previousAttemptId: 'turn' in retry.previous ? retry.previous.turn.attemptId : retry.previous.attemptId } } : {}),
      }, readOriginPin); } catch (error) { throw this.admissionError(error); }
    };
    if (existing) {
      const entry = this.entries.get(existing.attemptId)!;
      validateInput(c.content, entry.budgets);
      if (creating) accept(existing.config, c.ephemeral === true);
      else if (this.sessions.get(sessionId)?.stale) {
        const record = await this.d.persistence.sessions.get(c.identity.userId, sessionId);
        if (!record || record.lifecycle !== 'active') throw new AppError('NOT_FOUND', 'Chat not found.');
        accept(existing.config, record.ephemeral === true);
      } else accept(existing.config, this.sessions.get(sessionId)?.session.ephemeral === true);
      return { ...responseFor(this.attempt(entry)), processEpoch: existing.epoch };
    }
    const snapshot = live?.configSnapshot ?? this.snapshot();
    if (live && (!live.voice || this.policy.maxEvidenceBytes < 8192))
      throw new AppError('NOT_READY', 'Voice memory capacity is unavailable.');
    validateInput(c.content, snapshot.budgets);
    const assertMode = () => live ? this.runtime.reservations.assertLive(live.reservation, c.identity, sessionId)
      : this.runtime.reservations.assertText(c.identity.userId, sessionId);
    assertMode();
    if (live?.freshConversation && sessionId !== sessionIdFor(c.identity.userId, null, c.idempotencyKey))
      throw new AppError('INVALID_REQUEST', 'New conversation identity is invalid.');
    const webPort = this.d.webSearch;
    const webAccount = webPort?.snapshot(identity.userId);
    const webAdvertised = webPort !== undefined && shouldAdvertiseWebTool({
      enabled: webAccount?.prepared === true && webAccount.enabled,
      hasEligibleProvider: Boolean(webAccount?.providers.some(p => p.capabilities.browse || p.capabilities.fetch)),
      credentialsRejected: webAccount?.credentialsRejected === true,
      modelSupportsTools: snapshot.modelLimits?.tools,
    });
    if (c.sessionId !== null && !live?.freshConversation) await this.hydrate(sessionId, snapshot);
    const legacy = this.sessions.get(sessionId)?.attempts.find(a => a.idempotencyKey === c.idempotencyKey);
    if (legacy) {
      const original = this.foundation.history(sessionId).find(r => r.messageId === legacy.causal.userMessageId);
      if (!original || (live ? original.mode !== 'live' || original.voiceSessionId !== live.voice?.voiceSessionId
          : original.visibility === 'internal' || original.mode === 'live') ||
          (!retry && legacy.causal.previousAttemptId !== null) || original.content !== c.content ||
          !isDeepStrictEqual(legacy.calendarReplyTo ?? null, c.calendarReplyTo ?? null))
        throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This request identity has different input.');
      return responseFor(legacy);
    }
    this.runtime.ready();
    assertMode();
    try { this.tryPromotePendingCompaction(sessionId); } catch { /* Promotion cannot block admission. */ }
    if (!existing && this.runtime.work.get(c.identity.userId, sessionId)) throw new AppError('CONFLICT_ACTIVE_TURN', 'Another turn is active.');
    const personalization = { ...(this.d.personalizationFor?.(identity.userId) ?? defaultPersonalizationSettings()) };
    const clientTimeZone = normalizeTimeZone(c.clientTimeZone)
      ?? (retry && 'turn' in retry.previous ? retry.previous.clientTimeZone ?? null : null);
    const requestGeo = c.requestGeo
      ?? (retry && 'turn' in retry.previous ? retry.previous.requestGeo ?? null : null);
    const ephemeral = creating ? c.ephemeral === true : this.sessions.get(sessionId)?.session.ephemeral === true;
    const turn = accept({ revision: String(snapshot.revision), modelId: snapshot.openRouter.modelId,
          instructionVersion: this.d.assets.instructionVersion, knowledgeContentHash: this.d.assets.knowledgeContentHash,
          graphSchemaVersion: this.d.assets.graphSchemaVersion }, ephemeral);
    if (!this.entries.has(turn.attemptId)) this.entries.set(turn.attemptId, { identity, turn, snapshot, budgets: snapshot.budgets, personalization, clientTimeZone, requestGeo, status: 'accepted', error: null, running: false,
      ...(retry && 'turn' in retry.previous ? { initialBudget: this.foundation.result(retry.previous.turn)?.calendar?.budget } : {}),
      ...(webAdvertised && webPort ? {
        webAcceptedAt: performance.now(), webLimits: snapshot.settings.webSearch,
      } : {}) });
    if (!this.sessions.has(sessionId)) {
      const at = turn.createdAt;
      this.sessions.set(sessionId, { attempts: [], stale: false, session: { schemaVersion: 1,
        userId: turn.userId, sessionId, title: titleFor(c.content, snapshot.budgets.titleMaxChars),
        createdAt: at, updatedAt: at, lastActivityAt: at, lifecycle: 'active', graphThreadId: graphThreadId(turn.userId, sessionId),
        latestTurnId: turn.turnId, execution: { ownerId: null, leaseExpiresAt: null, activeAttemptId: null, generation: 0 },
        ...(ephemeral ? { ephemeral: true } : {}) } });
    }
    return { ...responseFor(this.attempt(this.entries.get(turn.attemptId)!)), processEpoch: turn.epoch };
  }
  private admissionError(error: unknown): AppError {
    const message = error instanceof Error ? error.message : '';
    if (/payload/i.test(message)) return new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This request identity has different input.');
    if (/active/i.test(message)) return new AppError('CONFLICT_ACTIVE_TURN', 'Another turn is active.');
    return new AppError('NOT_READY', 'Chat memory or saving capacity is unavailable. Try again shortly.');
  }
  private attempt(e: Entry): AttemptRecord {
    const t = e.turn;
    return { schemaVersion: 1, kind: 'attempt', userId: t.userId, sessionId: t.sessionId,
      turnId: t.turnId, attemptId: t.attemptId, idempotencyKey: t.requestKey,
      payloadHash: hashPayload(t.content), status: e.status, sequence: t.sequence + 2,
      createdAt: t.createdAt, updatedAt: t.createdAt,
      instructionVersion: t.config.instructionVersion, knowledgeContentHash: t.config.knowledgeContentHash,
      graphSchemaVersion: t.config.graphSchemaVersion, modelId: t.config.modelId,
      contextVersion: t.contextVersion, openRouterUser: t.userId,
      generationId: e.accounting?.generationId ?? this.foundation.result(t)?.accounting?.generationId ?? null,
      truncated: e.status === 'truncated', errorCode: e.error?.code ?? null,
      causal: { userMessageId: t.userMessageId, previousAttemptId: t.retryOf?.previousAttemptId ?? null }, calendarReplyTo: t.calendarReplyTo };
  }
  status(userId: string, sessionId: string, turnId: string) {
    this.user(userId); const e = this.find(sessionId, turnId); if (!e) return null;
    const s = this.foundation.session(sessionId);
    return turnStatusResponseSchema.parse({ sessionId, turnId, attemptId: e.turn.attemptId,
      status: e.status, truncated: e.status === 'truncated', error: e.error?.toClientBody() ?? null,
      save: { state: this.foundation.saveState(e.turn), epoch: e.turn.epoch,
        version: this.foundation.result(e.turn)?.version ?? s.version, durableVersion: s.durableVersion } });
  }
  session(userId: string, sessionId: string): SessionRecord | null {
    this.user(userId); const s = this.sessions.get(sessionId);
    if (!s || s.stale || this.foundation.session(sessionId).fenced) return null;
    const latest = this.foundation.records(sessionId).at(-1);
    return { ...s.session, latestTurnId: latest?.turnId ?? s.session.latestTurnId,
      lastActivityAt: latest?.createdAt ?? s.session.lastActivityAt };
  }
  private static readonly TERMINAL_STATUSES = new Set<AttemptRecord['status']>([
    'completed', 'truncated', 'failed', 'cancelled', 'interrupted',
  ]);
  private safeResult(turn: MemoryTurn) {
    if (this.foundation.find(turn.sessionId, turn.requestKey) !== turn) return null;
    return this.foundation.result(turn);
  }
  private safeSaveState(turn: MemoryTurn) {
    if (this.foundation.find(turn.sessionId, turn.requestKey) !== turn) return null;
    return this.foundation.saveState(turn);
  }
  private isUnsettledEntry(entry: Entry): boolean {
    return entry.running || !MemoryText.TERMINAL_STATUSES.has(entry.status) || Boolean(entry.native?.pending);
  }
  activeTurn(userId: string, sessionId: string) {
    this.user(userId);
    if (!this.session(userId, sessionId)) return null;
    const active = [...this.entries.values()].find(e => e.turn.sessionId === sessionId && this.isUnsettledEntry(e));
    if (!active || (active.status !== 'accepted' && active.status !== 'generating' && active.status !== 'finalizing')) return null;
    return { turnId: active.turn.turnId, attemptId: active.turn.attemptId, status: active.status, mode: active.turn.mode };
  }
  private allCanvasRecords(sessionId: string): MessageRecord[] {
    const cold = this.sessions.get(sessionId);
    const nowMs = Date.parse(this.runtime.now());
    return mergeCanvasRecords([
      ...(cold?.canvasArchive ?? []),
      ...(this.foundation.has(sessionId) ? this.foundation.history(sessionId) : []),
    ]).map(record => redactCalendarMessage(record, nowMs));
  }
  messages(userId: string, sessionId: string, query: PageQuery) {
    this.user(userId); if (!this.session(userId, sessionId)) return null;
    const { limit, after } = page(query, 'messages', userId, sessionId, this.d.config.budgets.maxPageSize);
    const records = this.foundation.history(sessionId);
    const active = [...this.entries.values()].find(e => e.turn.sessionId === sessionId && this.isUnsettledEntry(e));
    if (active && !records.some(r => r.messageId === active.turn.userMessageId)) records.push({ schemaVersion: 1, userId, sessionId, turnId: active.turn.turnId,
      attemptId: null, messageId: active.turn.userMessageId, eventId: active.turn.inputEventId,
      sequence: active.turn.sequence, role: 'user', content: active.turn.content, createdAt: active.turn.createdAt,
      completionStatus: 'accepted', truncated: false, mode: active.turn.mode,
      ...(active.turn.voice ? { visibility: 'internal', voiceSessionId: active.turn.voice.voiceSessionId } : {}) });
    const selected = records.filter(r => !after || r.sequence < Number(after.value))
      .sort((a, b) => b.sequence - a.sequence);
    const cold = this.sessions.get(sessionId);
    const items = selected.slice(0, limit).reverse().map(r => toVisibleMessage(this.visible(r, cold)));
    const oldest = items[0];
    // Deliberately only the initial page: the transcript keeps its cursor and
    // limit=1 polls stay one cheap read, while older Canvases ride along once.
    const archivedCanvases = !after && limit > 1
      ? this.allCanvasRecords(sessionId)
        .filter(r => hasCanvasContent(r) && r.sequence < (oldest?.sequence ?? Number.POSITIVE_INFINITY))
        .slice(-this.d.config.budgets.maxPageSize)
        .map(r => toVisibleMessage(this.visible(r, cold)))
      : [];
    const latest = [...this.entries.values()].filter(e => e.turn.sessionId === sessionId).at(-1);
    const latestSave = latest ? this.status(userId, sessionId, latest.turn.turnId)?.save : undefined;
    const activeTurn = this.activeTurn(userId, sessionId);
    const state = this.compactionState(userId, sessionId);
    if (after && selected.length === 0 && Boolean(state?.compaction)) return null;
    const olderAvailable = selected.length > limit || Boolean(state?.compaction);
    return { items, olderAvailable, nextCursor: olderAvailable && oldest
      ? cursor({ kind: 'messages', userId, sessionId, value: oldest.sequence, id: oldest.messageId }) : null,
      ...(archivedCanvases.length ? { canvasMessages: archivedCanvases } : {}),
      ...(latestSave ? { save: latestSave, saveTurnId: latest!.turn.turnId } : {}),
      ...(activeTurn ? { activeTurn } : {}),
      ...(state?.compaction ? { compaction: state.compaction } : {}),
      ...(state?.contextUsage ? { contextUsage: state.contextUsage } : {}) };
  }
  overlaySessions(userId: string, query: PageQuery, durable: { items: import('../contracts/api.js').SessionSummary[]; nextCursor: string | null }) {
    this.user(userId);
    const { limit, after } = page(query, 'sessions', userId, '', this.d.config.budgets.maxPageSize);
    const live = [...this.sessions.keys()].flatMap(s => {
      const record = this.session(userId, s);
      return record && record.ephemeral !== true ? [{ sessionId: s, title: record.title, createdAt: record.createdAt,
        lastActivityAt: record.lastActivityAt, pinned: record.pinned ?? false }] : [];
    });
    const compare = (a: typeof live[number], b: typeof live[number]) => Number(b.pinned) - Number(a.pinned)
      || Buffer.compare(Buffer.from(b.lastActivityAt), Buffer.from(a.lastActivityAt))
      || Buffer.compare(Buffer.from(b.sessionId), Buffer.from(a.sessionId));
    const liveIds = new Set(live.map(s => s.sessionId));
    const items = [...durable.items.filter(s => !liveIds.has(s.sessionId)).map(s => ({ ...s, pinned: s.pinned ?? false })),
      ...live.filter(s => !after || compare(s, { ...s, sessionId: after.id,
        lastActivityAt: String(after.value), pinned: after.pinned ?? false }) > 0)].sort(compare);
    const selected = items.slice(0, limit), last = selected.at(-1);
    return { items: selected, nextCursor: last && (items.length > limit || durable.nextCursor)
      ? cursor({ kind: 'sessions', userId, sessionId: '', value: last.lastActivityAt, id: last.sessionId, pinned: last.pinned }) : null };
  }
  async cancel(c: CancelTurnCommand, live = false): Promise<boolean> {
    const identity = this.runtime.identity(c.identity);
    if (identity.userId !== this.ownerId) throw new AppError('NOT_FOUND', 'Chat not found.');
    const e = this.find(c.sessionId, c.turnId); if (!e) return false;
    if ((e.turn.mode === 'live') !== live) throw new AppError('NOT_FOUND', 'Turn not found.');
    if (e.turn.attemptId !== c.attemptId) throw new AppError('CONFLICT_ACTIVE_TURN', 'This attempt is no longer current.');
    if (this.foundation.result(e.turn)) return true;
    const work = this.runtime.work.get(c.identity.userId, c.sessionId);
    if (work) work.abort('CANCELLED');
    if (!e.running) this.finish(e, '', 'cancelled', new AppError('CANCELLED', 'Generation was cancelled.', false));
    return true;
  }
  async retry(c: RetryTurnCommand) {
    const identity = this.runtime.identity(c.identity);
    if (identity.userId !== this.ownerId) throw new AppError('NOT_FOUND', 'Chat not found.');
    if (c.expectedEpoch !== undefined && c.expectedEpoch !== this.foundation.epoch)
      throw new AppError('INTERRUPTED', 'This request belongs to an earlier server session; its outcome is unknown.', false);
    this.evictCleanSessions(c.sessionId);
    if (!this.owns(c.sessionId) || this.sessions.get(c.sessionId)?.stale) await this.hydrate(c.sessionId, this.snapshot());
    const duplicate = this.foundation.find(c.sessionId, c.idempotencyKey);
    if (duplicate) {
      if (duplicate.turnId !== c.turnId || !duplicate.retryOf)
        throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This retry identity has different input.');
      return { ...responseFor(this.attempt(this.entries.get(duplicate.attemptId)!)), processEpoch: duplicate.epoch };
    }
    const nextTimeZone = normalizeTimeZone(c.clientTimeZone);
    const e = this.find(c.sessionId, c.turnId);
    if (e?.native?.pending && !e.running && !this.foundation.result(e.turn)) {
      if (nextTimeZone) e.clientTimeZone = nextTimeZone;
      if (c.requestGeo) e.requestGeo = c.requestGeo;
      e.status = 'accepted'; e.error = null;
      return { ...responseFor(this.attempt(e)), processEpoch: e.turn.epoch };
    }
    const native = e && this.foundation.result(e.turn)?.calendar;
    if (native?.decisions.some(record => record.decision?.kind === 'call_tool' &&
        !native.results.some(result => result.decisionId === record.decisionId)))
      throw new AppError('NOT_READY', 'The pending Calendar decision needs saving; generation cannot be repeated.', false);
    const legacy = this.sessions.get(c.sessionId)?.attempts ?? [];
    const duplicateLegacy = legacy.find(a => a.idempotencyKey === c.idempotencyKey);
    if (duplicateLegacy) {
      if (duplicateLegacy.turnId !== c.turnId || duplicateLegacy.causal.previousAttemptId === null)
        throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This retry identity has different input.');
      return responseFor(duplicateLegacy);
    }
    const prior = e ?? legacy.filter(a => a.turnId === c.turnId).sort((a, b) => a.sequence - b.sequence).at(-1);
    const attempts = new Set([...this.entries.values()].filter(e => e.turn.sessionId === c.sessionId && e.turn.turnId === c.turnId)
      .map(e => e.turn.attemptId).concat(legacy.filter(a => a.turnId === c.turnId).map(a => a.attemptId))).size;
    const input = e ? this.foundation.result(e.turn)?.input : prior && 'causal' in prior
      ? this.foundation.history(c.sessionId).find(r => r.messageId === prior.causal.userMessageId) : null;
    if (!prior || !input || input.mode === 'live' || !['failed', 'cancelled', 'interrupted'].includes(prior.status) || attempts >= 3 ||
        this.foundation.history(c.sessionId).some(r => r.turnId !== c.turnId && r.sequence > input.sequence))
      throw new AppError('INVALID_REQUEST', 'This response cannot be retried.');
    return this.submit({ identity: c.identity, sessionId: c.sessionId, idempotencyKey: c.idempotencyKey,
      ...(c.expectedEpoch ? { expectedEpoch: c.expectedEpoch } : {}),
      ...(nextTimeZone ? { clientTimeZone: nextTimeZone } : {}),
      content: input.content }, { previous: prior, input });
  }
  private finish(e: Entry, content: string, status: MemoryTerminal['status'], error: AppError | null = null): void {
    const accounting = e.accounting ? { ...e.accounting, outcome: status } : undefined;
    const web = e.web?.freeze();
    const webProjection = e.web?.presentation();
    const webRecord = web ? memoryWebRecordSchema.parse({
      schemaVersion: 1, kind: 'memory-web-native', userId: e.turn.userId,
      sessionId: e.turn.sessionId, turnId: e.turn.turnId, attemptId: e.turn.attemptId,
      epoch: e.turn.epoch, version: e.turn.contextVersion + 1, fence: e.turn.fence,
      state: web, groups: web.groups,
    }) : undefined;
    this.foundation.complete(e.turn, { content, status, accounting,
      ...(e.calendar ? { calendar: e.calendar } : {}),
      ...(e.calendarMutation ? { calendarMutation: e.calendarMutation } : {}),
      ...(e.calendarView ? { calendarView: e.calendarView } : {}),
      ...(e.weatherView ? { weatherView: e.weatherView } : {}),
      ...(e.sourceProvenance?.length ? { sourceProvenance: e.sourceProvenance } : {}),
      ...(webProjection?.sources.length ? { webSources: [...webProjection.sources] } : {}),
      ...(webProjection?.activities.length ? { webActivities: [...webProjection.activities] } : {}),
      ...(webRecord ? { web: webRecord } : {}),
      ...(e.memoryUpdated ? { memoryUpdated: e.memoryUpdated } : {}),
      ...(e.turn.mode === 'live' ? { delivery: e.delivery ?? this.unknownDelivery(e.turn, content) } : {}) }); e.status = status; e.error = error;
    const snap = e.snapshot ?? this.d.currentConfig?.current() ?? null;
    // Terminal ledger/envelope retain public config revision and accounting only.
    // Release credential-bearing settings and the extra observation copy.
    e.snapshot = null; e.personalization = null; e.accounting = undefined; e.delivery = undefined; e.calendar = undefined;
    e.calendarMutation = undefined; e.calendarView = undefined; e.weatherView = undefined; e.sourceProvenance = undefined;
    e.native?.ledger.freeze(); e.native = undefined; e.web = undefined;
    if (snap && (status === 'completed' || status === 'truncated')) {
      try { this.scheduleCompactionIfNeeded(e.turn.sessionId, snap); }
      catch { /* Compaction is best-effort and must not fail the turn. */ }
    }
  }
  private unknownDelivery(t: MemoryTurn, textGenerated: string): VoiceDeliveryRecord {
    // No hearing is asserted when execution never started or settlement failed.
    return voiceDeliveryRecordSchema.parse({ schemaVersion: 1, kind: 'voice-delivery', userId: t.userId,
      sessionId: t.sessionId, voiceSessionId: t.voice!.voiceSessionId, turnId: t.turnId, attemptId: t.attemptId,
      responseId: key('voice-response', t.userId, t.sessionId, t.attemptId), eventId: randomUUID(), sequence: 1,
      speechId: null, providerSocketId: 'not-confirmed', status: 'unknown', audioDurationMs: null,
      audioPlayedMs: null, playedSamples: null, textGenerated, textSpoken: null, textRemaining: null,
      createdAt: t.createdAt, updatedAt: this.runtime.now() });
  }
  async interruptPending(): Promise<void> {
    for (const e of this.entries.values()) {
      if (e.running) continue;
      try {
        if (this.foundation.result(e.turn)) continue;
        this.finish(e, '', 'interrupted', new AppError('INTERRUPTED', 'Generation was interrupted.', false));
      } catch {
        // Compacted or already released handles are not live generations.
      }
    }
  }
  async stopPending(): Promise<void> {
    this.foundation.stopAdmission();
    await this.interruptPending();
  }
  compactionState(userId: string, sessionId: string): {
    compaction?: CompactionCheckpointMeta;
    contextUsage?: ContextUsageMeta;
  } | null {
    this.user(userId);
    const cold = this.sessions.get(sessionId);
    if (!cold && !this.foundation.has(sessionId)) return null;
    const checkpoint = cold?.session.compactionCheckpoint;
    const compaction = checkpoint
      ? { compactedThroughSequence: checkpoint.compactedThroughSequence,
          compactionCycle: checkpoint.compactionCycle,
          ...(checkpoint.summaryPreview !== undefined ? { summaryPreview: checkpoint.summaryPreview } : {}) }
      : undefined;
    const snapshot = this.d.currentConfig?.current();
    const records = this.foundation.has(sessionId) ? this.foundation.records(sessionId) : [];
    const historyTokens = estimateMessagesTokens(records.map(r => ({ role: r.role === 'assistant' ? 'assistant' as const : 'user' as const, content: r.content })));
    const maxHistoryTokens = snapshot?.budgets.maxHistoryTokens ?? this.d.config.budgets.maxHistoryTokens;
    const contextUsage: ContextUsageMeta | undefined = snapshot ? {
      historyTokens, maxHistoryTokens,
      utilizationPercent: maxHistoryTokens > 0 ? (historyTokens / maxHistoryTokens) * 100 : 0,
      status: 'idle',
    } : undefined;
    return { ...(compaction ? { compaction } : {}), ...(contextUsage ? { contextUsage } : {}) };
  }
  async drainCompactions(timeoutMs: number): Promise<void> {
    for (const cold of this.sessions.values()) cold.compaction?.abort?.abort();
    if (!this.compactionJobs.size) return;
    await Promise.race([
      Promise.allSettled([...this.compactionJobs]),
      new Promise<void>(resolve => setTimeout(resolve, Math.max(1, timeoutMs))),
    ]);
  }

  private ensureCompaction(cold: Cold): NonNullable<Cold['compaction']> {
    cold.compaction ??= { running: null, abort: null, pending: null, failures: 0, cooldownUntil: 0 };
    return cold.compaction;
  }

  private tryPromotePendingCompaction(sessionId: string, activeEntry?: Entry) {
    const cold = this.sessions.get(sessionId);
    const pending = cold?.compaction?.pending;
    if (!pending || !this.foundation.has(sessionId)) return null;
    // Capture before promotion because the manifest rebase drops compacted refs
    // and removes durable compacted results from foundation.results.
    const canvasRecords = this.foundation.history(sessionId).filter(hasCanvasContent);
    const cut = pending.summary.sourceRange.toSequence;
    if (!activeEntry && this.foundation.session(sessionId).activeAttemptId) return null;
    // Keep unsaved compacted entries for status/retrySave; prune only settled
    // entries whose output sequence is covered and whose save no longer needs
    // the in-memory handle. Skip the active entry: its handle is replaced below.
    const deletableEntryIds = new Set<string>();
    for (const [id, entry] of this.entries) {
      if (entry === activeEntry || entry.turn.sessionId !== sessionId || this.isUnsettledEntry(entry)) continue;
      if (entry.turn.sequence + 1 > cut) continue;
      if (this.foundation.find(sessionId, entry.turn.requestKey) !== entry.turn
        || this.safeSaveState(entry.turn) === 'saved'
        || (this.foundation.session(sessionId).durableVersion > entry.turn.contextVersion
          && this.safeResult(entry.turn) === null)) {
        deletableEntryIds.add(id);
      }
    }
    const refresh = cold.session.ephemeral ? null
      : this.d.userMemory?.cache.cachedSnapshot(this.ownerId);
    const promoted = activeEntry
      ? (() => {
          const next = this.foundation.rebaseActiveTurnForCompaction(activeEntry.turn, pending.summary, pending.checkpoint, refresh);
          activeEntry.turn = next.turn;
          return next;
        })()
      : this.foundation.promoteCompaction(this.ownerId, sessionId, pending.summary, pending.checkpoint, refresh);
    if (canvasRecords.length) {
      const nowMs = Date.parse(this.runtime.now());
      cold.canvasArchive = mergeCanvasRecords([
        ...(cold.canvasArchive ?? []),
        ...canvasRecords.map(record => redactCalendarMessage(record, nowMs)),
      ], this.d.config.budgets.maxPageSize);
    }
    cold.compaction!.pending = null;
    if (cold.groups) for (const turnId of [...cold.groups.keys()])
      if (!promoted.tailTurnIds.has(turnId)) cold.groups.delete(turnId);
    if (cold.webGroups) for (const turnId of [...cold.webGroups.keys()])
      if (!promoted.tailTurnIds.has(turnId)) cold.webGroups.delete(turnId);
    cold.attempts = cold.attempts.filter(a => a.sequence > cut);
    for (const id of deletableEntryIds) this.entries.delete(id);
    if (cold.session.compactionCheckpoint)
      cold.session = { ...cold.session, compactionCheckpoint: {
        ...pending.checkpoint, summaryId: pending.summary.summaryId,
      } };
    else cold.session = { ...cold.session, compactionCheckpoint: {
      ...pending.checkpoint, summaryId: pending.summary.summaryId,
    } };
    return promoted;
  }

  private buildTurnsForSession(sessionId: string): CompactionTurn[] {
    const records = this.foundation.records(sessionId);
    const cold = this.sessions.get(sessionId);
    const webGroups = this.foundation.webGroups(sessionId);
    const nativeGroups = this.foundation.nativeGroups(sessionId);
    const turns: CompactionTurn[] = [];
    const byTurn = new Map<string, MessageRecord[]>();
    for (const record of records) {
      const list = byTurn.get(record.turnId) ?? [];
      list.push(record);
      byTurn.set(record.turnId, list);
    }
    for (const [turnId, items] of byTurn) {
      const ordered = [...items].sort((a, b) => a.sequence - b.sequence);
      const userItems = ordered.filter(r => r.role === 'user').map(r => ({ role: 'user' as const, content: r.content }));
      const assistantItems = ordered.filter(r => r.role !== 'user').map(r => ({ role: 'assistant' as const, content: r.content }));
      const turnWeb = (webGroups.get(turnId) ?? cold?.webGroups?.get(turnId) ?? [])
        .flatMap<WebNativeMessage>(group => group?.assistant && group?.result ? [group.assistant, group.result] : []);
      const turnNative = (nativeGroups.get(turnId) ?? cold?.groups?.get(turnId) ?? [])
        .flatMap<WebNativeMessage>(group => group?.assistant && group?.result ? [group.assistant, group.result] : []);
      turns.push({
        turnId,
        sourceRange: {
          fromSequence: ordered[0].sequence, toSequence: ordered.at(-1)!.sequence,
          fromEventId: ordered[0].eventId, toEventId: ordered.at(-1)!.eventId,
        },
        messages: userItems.length ? [...userItems, ...turnWeb, ...turnNative, ...assistantItems]
          : ordered.map(r => ({ role: r.role as 'user' | 'assistant', content: r.content })),
        completed: Boolean(
          (() => { const t = this.foundation.byTurn(sessionId, turnId); return t && this.foundation.result(t); })()
          || ordered.some(r => r.role === 'assistant' && (r.completionStatus === 'completed' || r.completionStatus === 'truncated'))),
      });
    }
    return turns.sort((a, b) => a.sourceRange.fromSequence - b.sourceRange.fromSequence);
  }

  private scheduleCompactionIfNeeded(sessionId: string, snapshot: RuntimeConfigSnapshot, force = false,
    forcedTailTurns = 3): void {
    const settings = snapshot.settings.compaction;
    if (!settings?.enabled || !this.foundation.has(sessionId)) return;
    const cold = this.sessions.get(sessionId);
    if (!cold) return;
    const slot = this.ensureCompaction(cold);
    if (slot.running || Date.parse(this.runtime.now()) < slot.cooldownUntil) return;
    const records = this.foundation.records(sessionId);
    const turns = this.buildTurnsForSession(sessionId);
    const historyTokens = estimateMessagesTokens(turns.flatMap(turn => [...turn.messages]));
    const watermark = settings.watermarkRatio;
    const utilization = Math.max(
      historyTokens / snapshot.budgets.maxHistoryTokens,
      records.length / snapshot.budgets.maxMessagesInContext,
    );
    if (!force && utilization < watermark) return;
    const pinned = new Set<string>();
    if (cold.pendingProposal?.originatingTurnId) pinned.add(cold.pendingProposal.originatingTurnId);
    // A forced pass drops the token-target tail and keeps exactly
    // `forcedTailTurns` verbatim (default 3; the overflow fallback passes 1).
    const cut = selectCompactionCutpoint(turns, snapshot.budgets.maxHistoryTokens, force
      ? { minTailTurns: forcedTailTurns, pinnedTurnIds: pinned, targetTailTokens: 0 }
      : { minTailTurns: 3, pinnedTurnIds: pinned });
    if (!cut) return;
    if (!cold.session.ephemeral) this.runtime.userMemoryScheduler?.compacting(this.ownerId, sessionId);
    const abort = new AbortController();
    slot.abort = abort;
    const job = this.runCompactionJob(sessionId, snapshot, cut.sourceRange, cut.compactedTurnIds, abort.signal);
    slot.running = job;
    this.compactionJobs.add(job);
    void job.finally(() => {
      this.compactionJobs.delete(job);
      if (slot.running === job) { slot.running = null; slot.abort = null; }
    });
  }

  private async runCompactionJob(
    sessionId: string, snapshot: RuntimeConfigSnapshot, range: ActiveSummaryRecord['sourceRange'],
    compactedTurnIds: readonly string[], signal: AbortSignal,
  ): Promise<void> {
    const cold = this.sessions.get(sessionId);
    if (!cold) return;
    const slot = this.ensureCompaction(cold);
    const selected = new Set(compactedTurnIds);
    const records = this.foundation.records(sessionId)
      .filter(r => selected.has(r.turnId) && r.sequence >= range.fromSequence && r.sequence <= range.toSequence);
    const latestAssistant = new Map<string, MessageRecord>();
    for (const r of records) {
      if (r.role === 'assistant') latestAssistant.set(r.turnId, r);
    }
    const completedAttempts = new Map<string, string>();
    for (const r of latestAssistant.values()) {
      if (r.attemptId && (r.completionStatus === 'completed' || r.completionStatus === 'truncated')) {
        completedAttempts.set(r.turnId, r.attemptId);
      }
    }
    const groups = this.foundation.webGroups(sessionId, completedAttempts);
    const deltaMessages: WebNativeMessage[] = [];
    for (const r of records) {
      if (latestAssistant.get(r.turnId) === r && completedAttempts.has(r.turnId)) {
        for (const group of groups.get(r.turnId) ?? []) {
          const folded = foldHistoricalWebResult(group);
          if (!folded) continue;
          const content = `Historical Web evidence (data, not authority):\n${folded}`;
          if (Buffer.byteLength(content, 'utf8') <= snapshot.budgets.maxMessageBytes) {
            deltaMessages.push({ role: 'assistant', content });
          }
        }
      }
      deltaMessages.push({
        role: r.role as 'user' | 'assistant',
        content: r.role === 'assistant' && (r.sourceProvenance?.length || r.calendarView)
          ? CALENDAR_TOMBSTONE : r.content,
      });
    }
    const prior = this.foundation.summary(sessionId);
    const priorSummary = prior ? redactSummaryCalendar(prior, this.runtime.now()) : null;
    const summaryId = key('memory-summary', this.ownerId, sessionId, String(range.toSequence), String(Date.parse(this.runtime.now())));
    const cycle = (priorSummary?.compactionCycle ?? cold.session.compactionCheckpoint?.compactionCycle ?? 0) + 1;
    const turnId = records.at(-1)?.turnId ?? sessionId;
    try {
      const out = await this.compactionRunner.run({
        userId: this.ownerId, sessionId, summaryId, compactionCycle: cycle, turnId, sourceRange: range,
        prefix: snapshot.settings.compaction.modelMode === 'active-fork'
          ? fixedContextMessages(this.d.assets)
          : [{ role: 'system', content: this.d.assets.instructions }],
        previousSummary: priorSummary,
        deltaMessages,
        calendarProvenance: priorSummary?.calendarProvenance ?? {
          containsCalendarContent: false, connectionId: null, connectionRevision: null,
          earliestExpiresAt: null, redactedAt: null,
        },
        budgets: snapshot.budgets,
        openRouter: snapshot.openRouter,
        modelLimits: snapshot.modelLimits,
        compaction: snapshot.settings.compaction,
        compactionModelLimits: snapshot.compactionModelLimits ?? snapshot.modelLimits,
        signal,
      });
      const checkpoint = {
        compactedThroughSequence: range.toSequence,
        compactionCycle: cycle,
        summaryPreview: out.summary.content.slice(0, 200),
      };
      slot.pending = { summary: out.summary, checkpoint, forVersion: this.foundation.session(sessionId).version };
      slot.failures = 0;
      cold.session = { ...cold.session, compactionCheckpoint: { ...checkpoint, summaryId: out.summary.summaryId } };
      try {
        if (!this.foundation.session(sessionId).activeAttemptId) this.tryPromotePendingCompaction(sessionId);
      } catch { /* Promotion retries on the next idle submit. */ }
    } catch {
      slot.failures += 1;
      slot.cooldownUntil = Date.parse(this.runtime.now()) + Math.min(60_000, 1000 * 2 ** slot.failures);
    }
  }


  private accountKey(account: CalendarAccountBinding): string {
    return JSON.stringify(calendarAccountBindingSchema.parse(account));
  }
  invalidateCalendarAccount(account: CalendarAccountBinding, reason?: string): void {
    if (account.userId !== this.foundation.userId) return;
    if (this.d.calendar && isCalendarV2(this.d.calendar)) {
      this.d.calendar.connection.invalidateAccount?.(account);
    }
    const canonical = calendarAccountBindingSchema.parse(account);
    const keyString = this.accountKey(canonical);
    this.invalidatedAccounts.add(keyString);
    // ponytail: one server user, bounded revision tombstones; fresh account gates
    // remain authoritative after older revisions leave this process-local cache.
    if (this.invalidatedAccounts.size > this.policy.maxRequestsPerSession)
      this.invalidatedAccounts.delete(this.invalidatedAccounts.values().next().value!);
    const nowMs = Date.parse(this.runtime.now());
    const nowIso = new Date(nowMs).toISOString();
    for (const cold of this.sessions.values()) {
      const pending = cold.compaction?.pending?.summary;
      if (pending?.calendarProvenance.containsCalendarContent
        && pending.calendarProvenance.connectionId === canonical.connectionId
        && pending.calendarProvenance.connectionRevision === canonical.connectionRevision) {
        cold.compaction!.pending = {
          ...cold.compaction!.pending!,
          summary: redactSummaryCalendar(pending, nowIso),
        };
      }
      if (pending?.calendarProvenance.containsCalendarContent) cold.compaction?.abort?.abort();
      if (cold.canvasArchive?.length) cold.canvasArchive = cold.canvasArchive.map(
        record => redactCalendarMessageForAccount(record, canonical, nowMs));
    }
    this.foundation.invalidateCalendarAccount(canonical);
    for (const e of this.entries.values()) {
      e.native?.loop.invalidateCalendarAccount(canonical);
      const bound = e.native?.boundAccount ?? e.native?.promotion?.binding ?? e.native?.mutation?.binding;
      const entryInvalidated = bound ? this.accountKey(bound) === keyString : false;
      if (e.native && entryInvalidated) e.native.invalidation++;
      if (e.calendar) e.calendar = eraseMemoryCalendarStateForAccount(
        e.calendar, canonical, nowMs, reason === 'not-permitted' ? 'not-permitted' : 'disconnected');
      if (e.calendarMutation && (entryInvalidated || (e.calendarMutation.result.resultRef.source.connectionId === canonical.connectionId
          && e.calendarMutation.result.resultRef.source.connectionRevision === canonical.connectionRevision))) {
        e.calendarMutation = eraseMemoryCalendarMutation(
          e.calendarMutation, nowMs, reason === 'not-permitted' ? 'not-permitted' : 'disconnected');
      }
      if (e.sourceProvenance) e.sourceProvenance = e.sourceProvenance.map(s => redactCalendarSourceForAccount(s, canonical, nowMs));
      if (entryInvalidated && e.calendarView && e.calendarView.kind !== 'outcome') {
        e.calendarView = undefined;
      }
    }
    for (const state of this.sessions.values()) {
      if (state.accountBinding && this.accountKey(state.accountBinding) === keyString ||
          state.pendingProposal?.connectionId === canonical.connectionId && state.pendingProposal.connectionRevision === canonical.connectionRevision) {
        state.accountBinding = null; state.pendingProposal = null;
      }
      for (const [turnId, groups] of state.groups ?? []) state.groups!.set(turnId, groups.map(group =>
        group.sources.some(source => source.connectionId === canonical.connectionId && source.connectionRevision === canonical.connectionRevision)
          ? { ...group, result: { ...group.result, content: JSON.stringify({ kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE }) }, sources: [] }
          : group));
    }
  }
  private nativeInput(e: Entry): MessageRecord {
    const t = e.turn;
    return messageRecordSchema.parse({ schemaVersion: 1, userId: t.userId, sessionId: t.sessionId,
      turnId: t.turnId, attemptId: null, messageId: t.userMessageId, eventId: t.inputEventId,
      sequence: t.retryOf?.sequence ?? t.sequence, role: 'user', content: t.content,
      createdAt: t.retryOf?.createdAt ?? t.createdAt, completionStatus: 'accepted', truncated: false, mode: t.mode,
      ...(t.voice ? { visibility: 'internal', voiceSessionId: t.voice.voiceSessionId } : {}) });
  }
  private assertCalendar(native: NativeExecution, account?: CalendarAccountBinding): void {
    native.job.check();
    const target = account ?? native.boundAccount ?? native.promotion?.binding ?? native.mutation?.binding;
    if (!this.d.currentConfig?.current()?.calendar?.enabled || native.invalidation > 0 ||
        (target && this.invalidatedAccounts.has(this.accountKey(target))))
      throw new AppError('NOT_READY', 'Calendar access is unavailable.', false);
  }
  private async ensureMutationAccepted(
    e: Entry,
    native: NativeExecution,
    options?: { pendingCreateDecisionId?: string | null },
  ): Promise<MutationBarrier> {
    const p = this.d.persistence, cal = this.d.calendar, t = e.turn, snapshot = e.snapshot!;
    if (!cal || !isCalendarV2(cal) || !this.d.currentConfig?.current()?.calendar?.enabled) {
      throw new AppError('NOT_READY', 'Calendar access is unavailable.', false);
    }
    if (!p.messages.appendConfirmed || !p.metadata.putAttemptConfirmed || !p.metadata.compareAttemptConfirmed ||
        !p.calendarAccountingV2.getBudgetConfirmed || !p.calendarAccountingV2.createBudgetConfirmed ||
        !p.calendarAccountingV2.compareBudgetConfirmed || !p.owner.store) {
      throw new AppError('PERSISTENCE_ERROR', 'Chat progress could not be confirmed.', false);
    }
    const job = native.job, timeout = snapshot.budgets.persistenceTimeoutMs;
    const mut: MutationBarrier = native.mutation ??= {
      paused: false, sequenceUpdated: false, discoveryUpdated: false, replyBound: false,
      acceptedConfirmed: false, prefixFrozen: false,
    };
    this.assertCalendar(native, mut.binding);
    const account = await job.wait(cal.connection.currentAccount(), timeout);
    native.boundAccount = account;
    this.assertCalendar(native, account);
    const coldSession = this.sessions.get(t.sessionId);
    if (coldSession?.accountBinding && !isDeepStrictEqual(coldSession.accountBinding, account)) {
      throw new AppError('NOT_READY', 'Calendar access has changed.', false);
    }
    if (mut.binding && !isDeepStrictEqual(mut.binding, account)) {
      throw new AppError('NOT_READY', 'Calendar access has changed.', false);
    }
    mut.binding = account;
    if (coldSession && !coldSession.accountBinding) coldSession.accountBinding = account;
    await job.wait(cal.connection.requireAccountCurrent(account, job.signal), timeout);
    this.assertCalendar(native, account);

    if (!mut.paused) {
      this.foundation.pauseSession(t);
      mut.paused = true;
    }

    if (!mut.prefixFrozen) {
      const rawSnap = { ...native.ledger.snapshot(), ...native.stage.records() };
      const pendingId = options?.pendingCreateDecisionId ?? null;
      const decisions = pendingId
        ? rawSnap.decisions.filter(d => d.decisionId !== pendingId
            || rawSnap.results.some(r => r.decisionId === d.decisionId)
            || rawSnap.terminalCall?.decisionId === d.decisionId)
        : rawSnap.decisions;
      if (rawSnap.dispatches.length > 0 || decisions.length > 0
          || rawSnap.results.length > 0 || rawSnap.rejected.length > 0) {
        const parsed = memoryCalendarStateSchema.parse({ ...rawSnap, decisions });
        const bearing = isCalendarBearingState(parsed);
        const integrity = bearing ? memoryCalendarIntegrity(parsed) : undefined;
        const dummy = memoryCalendarRecordSchema.parse(bearing
          ? { schemaVersion: 2, kind: 'memory-calendar-native', userId: t.userId, sessionId: t.sessionId,
              turnId: t.turnId, attemptId: t.attemptId, epoch: t.epoch, version: t.contextVersion + 1,
              fence: t.fence, integrity: integrity!, redactedAt: null, state: parsed }
          : { schemaVersion: 1, kind: 'memory-calendar-native', userId: t.userId, sessionId: t.sessionId,
              turnId: t.turnId, attemptId: t.attemptId, epoch: t.epoch, version: t.contextVersion + 1,
              fence: t.fence, state: parsed });
        mut.prefixCalendar = parsed;
        mut.prefixIntegrity = integrity;
        mut.nativePublication = {
          epoch: t.epoch,
          version: t.contextVersion + 1,
          fence: t.fence,
          contentHash: memoryCalendarPublicationHash(dummy),
        };
      }
      mut.prefixFrozen = true;
    }

    if (t.contextVersion === 0 || !(await job.wait(p.sessions.get(t.userId, t.sessionId), timeout))) {
      await job.wait(p.sessions.createIfAbsent({
        ...this.sessions.get(t.sessionId)!.session,
        memoryPublication: { version: 0, sequence: 0, epoch: t.epoch, fence: t.fence },
      }), timeout);
    }

    if (!mut.handle) {
      mut.handle = await job.wait(p.sessions.beginCalendarMutation({
        userId: t.userId,
        sessionId: t.sessionId,
        attemptId: t.attemptId,
        executorId: p.owner.executorId,
        archiveOwned: Boolean(this.archive?.ownsSession(t.userId, t.sessionId)),
      }), timeout);
    }

    // ponytail: scoped Calendar mutation ownership checks handle before and after
    // each un-transacted write; assumes one live backend process per database.
    const write = async <T>(action: () => Promise<T>): Promise<T> => {
      const handle = mut.handle;
      if (!handle) throw new AppError('INTERRUPTED', 'Calendar execution ownership was lost.');
      if (!await job.wait(p.sessions.assertCalendarMutation(handle, p.owner.executorId), timeout)) {
        throw new AppError('INTERRUPTED', 'Calendar execution ownership was lost.');
      }
      const res = await job.wait(action(), timeout);
      if (!await job.wait(p.sessions.assertCalendarMutation(handle, p.owner.executorId), timeout)) {
        throw new AppError('INTERRUPTED', 'Calendar execution ownership was lost.');
      }
      return res;
    };

    const store = p.owner.store!;
    mut.inputReceipt ??= await write(() => p.messages.appendConfirmed!(this.nativeInput(e)));
    mut.attemptReceipt ??= await write(() => p.metadata.putAttemptConfirmed!({
      ...this.attempt(e),
      status: 'accepted',
      ...(mut.nativePublication ? { nativePublication: mut.nativePublication } : {}),
    }));
    if (!mut.acceptance) {
      const inputEnv = inspectConfirmedRecord<MessageRecord>(mut.inputReceipt, { store });
      const attemptEnv = inspectConfirmedRecord<AttemptRecord>(mut.attemptReceipt, { store });
      if (
        attemptEnv.canonical.attemptId !== t.attemptId ||
        attemptEnv.canonical.userId !== t.userId ||
        attemptEnv.canonical.sessionId !== t.sessionId ||
        inputEnv.canonical.userId !== t.userId ||
        inputEnv.canonical.sessionId !== t.sessionId ||
        inputEnv.canonical.role !== 'user' ||
        inputEnv.canonical.turnId !== attemptEnv.canonical.turnId ||
        attemptEnv.canonical.causal.userMessageId !== inputEnv.canonical.messageId ||
        hashPayload(inputEnv.canonical.content) !== attemptEnv.canonical.payloadHash
      ) {
        throw new AppError('INVALID_REQUEST', 'Receipt evidence mismatch for acceptance.');
      }
      const marker: AcceptanceRecord = {
        schemaVersion: 1,
        kind: 'acceptance',
        userId: t.userId,
        sessionId: t.sessionId,
        turnId: attemptEnv.canonical.turnId,
        attemptId: t.attemptId,
        userMessageId: inputEnv.canonical.messageId,
        payloadHash: attemptEnv.canonical.payloadHash,
      };
      await write(() => store.insertConfirmed(
        'metadata',
        acceptanceSchema,
        marker,
        key('acceptance', t.userId, t.sessionId, t.attemptId),
        4096,
      ));
      mut.acceptance = marker;
    }

    if (mut.attemptReceipt.record.status === 'accepted') {
      const prev = mut.attemptReceipt;
      const next: AttemptRecord = { ...prev.record, status: 'generating', updatedAt: this.runtime.now() };
      const outcome = await write(() => p.metadata.compareAttemptConfirmed!(prev, next));
      if (outcome.outcome !== 'confirmed') {
        throw new AppError('PERSISTENCE_ERROR', 'Chat progress could not be confirmed.', false);
      }
      mut.attemptReceipt = outcome.receipt;
    }

    if (!mut.sequenceUpdated) {
      const counterId = key('sequence-counter', t.userId, t.sessionId);
      const targetNext = (t.retryOf?.sequence ?? t.sequence) + 3;
      await write(async () => {
        try {
          const res = await store.collection('metadata').updateOne(
            { _id: counterId, userId: t.userId, sessionId: t.sessionId },
            {
              $setOnInsert: {
                schemaVersion: 1, kind: 'sequence-counter',
                userId: t.userId, sessionId: t.sessionId, _revision: 0,
              },
              $max: { next: targetNext },
            },
            { upsert: true, ...store.options() },
          );
          if (res.acknowledged) {
            const saved = await store.read('metadata', counterSchema, { _id: counterId, userId: t.userId, sessionId: t.sessionId });
            if (saved && saved.next >= targetNext) return;
          }
        } catch {
          // Ambiguous or unacknowledged write falls through to exact readback.
        }
        const readback = await store.read('metadata', counterSchema, { _id: counterId, userId: t.userId, sessionId: t.sessionId });
        if (!readback || readback.next < targetNext) {
          throw new AppError('PERSISTENCE_ERROR', 'Chat sequence counter could not be confirmed.', false);
        }
      });
      mut.sequenceUpdated = true;
    }

    if (!mut.discoveryUpdated) {
      const h = mut.handle;
      const scope = { _id: key('session', t.userId, t.sessionId), userId: t.userId, sessionId: t.sessionId };
      await write(async () => {
        try {
          const res = await store.collection('sessions').updateOne(
            {
              ...scope,
              lifecycle: 'active',
              'execution.generation': h.generation,
              'execution.activeAttemptId': t.attemptId,
              $or: [{ 'execution.ownerId': null }, { 'execution.ownerId': p.owner.executorId }],
            },
            { $set: { latestTurnId: t.turnId }, $inc: { _revision: 1 } },
            store.options(),
          );
          if (res.acknowledged && res.matchedCount === 1) return;
        } catch {
          // Ambiguous or unacknowledged write falls through to exact readback.
        }
        const saved = await p.sessions.get(t.userId, t.sessionId);
        if (!saved || saved.latestTurnId !== t.turnId || saved.execution.activeAttemptId !== t.attemptId) {
          throw new AppError('INTERRUPTED', 'Calendar execution ownership was lost.');
        }
      });
      mut.discoveryUpdated = true;
    }

    if (t.calendarReplyTo && !mut.replyBound) {
      await write(() => p.calendarProposals.bindReplyReference({
        userId: t.userId, sessionId: t.sessionId, turnId: t.turnId,
        attemptId: t.attemptId, replyTo: t.calendarReplyTo!,
      }));
      mut.replyBound = true;
    }

    const activeSnap = native.ledger.snapshot();
    const accounting = p.calendarAccountingV2;
    let budget = await write(() => accounting.getBudgetConfirmed!(t.userId, t.sessionId, t.turnId));
    if (!budget) {
      budget = await write(() => accounting.createBudgetConfirmed!({
        ...activeSnap.budget,
        revision: 1,
        modelDispatches: 0,
        repairs: 0,
        logicalTools: 0,
        creates: 0,
        calendarRequests: 0,
        refreshRequests: 0,
        reservedUsd: '0',
        settledUsd: '0',
        debits: [],
      }));
    }
    const limits = this.d.currentConfig?.current()?.calendar?.limits ?? snapshot.calendar?.limits ?? CALENDAR_LIMITS;
    const ledger = new CalendarTurnLedger({
      accounting: asCalendarAccountingPort(p),
      identity: {
        userId: t.userId, sessionId: t.sessionId, turnId: t.turnId, attemptId: t.attemptId,
        openRouterUser: t.userId,
        createdAt: activeSnap.budget.createdAt,
        deadlineAt: activeSnap.budget.deadlineAt,
      },
      limits,
      write,
      clock: () => Date.parse(this.runtime.now()),
      modelId: snapshot.openRouter.modelId,
      pricing: snapshot.modelLimits!.calendar!.pricing,
      configRevision: snapshot.revision,
      connection: account,
      maxOutputTokens: snapshot.budgets.maxOutputTokens,
      processingPolicyId: snapshot.calendar!.processingPolicyId!,
      job,
      fence: async () => {
        const h = native.mutation?.handle;
        return Boolean(h && await p.sessions.assertCalendarMutation(h, p.owner.executorId));
      },
      requireCurrent: async () => {
        this.assertCalendar(native, account);
        await cal.connection.requireAccountCurrent(account, job.signal);
        this.assertCalendar(native, account);
      },
    });
    const seenDebits = new Set<string>();
    for (const debit of activeSnap.budget.debits ?? []) {
      if (seenDebits.has(debit.debitId)) continue;
      seenDebits.add(debit.debitId);
      if (debit.kindOfDebit === 'logical-tool' && debit.decisionId) {
        await ledger.chargeLogicalTool(debit.decisionId);
      } else if (debit.kindOfDebit === 'create' && debit.intentId) {
        await ledger.chargeCreate(debit.intentId);
      }
    }
    const durableBudget = await ledger.ensureBudget();
    if (
      durableBudget.logicalTools > limits.logicalTools ||
      durableBudget.creates > limits.creates ||
      durableBudget.calendarRequests > limits.calendarRequests ||
      durableBudget.refreshRequests > limits.refreshRequests ||
      activeSnap.budget.modelDispatches > limits.modelDispatches ||
      activeSnap.budget.repairs > limits.repairs ||
      activeSnap.budget.logicalTools > limits.logicalTools ||
      activeSnap.budget.creates > limits.creates ||
      activeSnap.budget.calendarRequests > limits.calendarRequests ||
      activeSnap.budget.refreshRequests > limits.refreshRequests
    ) {
      throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The Calendar request budget is exhausted.', false);
    }
    const maxRequests = Math.max(durableBudget.calendarRequests, activeSnap.budget.calendarRequests);
    const maxRefresh = Math.max(durableBudget.refreshRequests, activeSnap.budget.refreshRequests);
    if (maxRequests > durableBudget.calendarRequests || maxRefresh > durableBudget.refreshRequests) {
      await ledger.consume({
        ...(maxRequests > durableBudget.calendarRequests ? { calendarRequests: maxRequests } : {}),
        ...(maxRefresh > durableBudget.refreshRequests ? { refreshRequests: maxRefresh } : {}),
      });
    }
    this.assertCalendar(native, account);
    mut.ledger = ledger;
    mut.acceptedConfirmed = true;
    return mut;
  }

  private async promoteTurn(e: Entry, native: NativeExecution, cursor: CalendarCursor, refs: CalendarRefs) {
    const p = this.d.persistence, cal = this.d.calendar, t = e.turn, snapshot = e.snapshot!;
    if (!cal || !isCalendarV2(cal)) throw new AppError('NOT_READY', 'Calendar access is unavailable.');
    this.assertCalendar(native);
    await this.foundation.flushSession(t.sessionId);
    const state = this.foundation.session(t.sessionId);
    if (state.fenced || state.durableVersion !== t.contextVersion)
      throw new AppError('PERSISTENCE_ERROR', 'Chat progress must be saved before Calendar access.', false);
    this.assertCalendar(native);
    const job = native.job, timeout = snapshot.budgets.persistenceTimeoutMs;
    if (!native.promotion) {
      if (t.contextVersion === 0) await job.wait(p.sessions.createIfAbsent({ ...this.sessions.get(t.sessionId)!.session,
        memoryPublication: { version: 0, sequence: 0, epoch: t.epoch, fence: t.fence } }), timeout);
      this.assertCalendar(native);
      const owned = await job.wait(p.owner.acquire({ userId: t.userId, sessionId: t.sessionId,
        ownerId: p.owner.executorId, leaseMs: 180000 }), timeout);
      if (!owned.ok) throw new AppError('CONFLICT_ACTIVE_TURN', 'Another turn is active.');
      native.promotion = { lease: owned.lease, ready: false };
    }
    const promotion = native.promotion, lease = promotion.lease;
    this.assertCalendar(native);
    const write = <T>(action: () => Promise<T>) => job.wait(p.owner.run(lease, action), timeout);
    if (!p.messages.appendConfirmed || !p.metadata.putAttemptConfirmed || !p.metadata.compareAttemptConfirmed ||
        !p.calendarAccountingV2.getBudgetConfirmed || !p.calendarAccountingV2.createBudgetConfirmed ||
        !p.calendarAccountingV2.reserveDispatchConfirmed || !p.calendarAccountingV2.updateDispatchConfirmed)
      throw new AppError('PERSISTENCE_ERROR', 'Chat progress could not be confirmed.', false);
    await job.wait(p.owner.reserveAttempt(lease, t.attemptId), timeout);
    const input = this.nativeInput(e);
    const inputReceipt = await write(() => p.messages.appendConfirmed!(input));
    if (!promotion.receipt) promotion.receipt = await write(() => p.metadata.putAttemptConfirmed!({ ...this.attempt(e), status: 'accepted' }));
    promotion.attempt = promotion.receipt.record;
    if (!promotion.acceptance) promotion.acceptance = await job.wait(p.owner.confirmAcceptance(lease, t.attemptId,
      { input: inputReceipt, attempt: promotion.receipt }), timeout);
    if (promotion.receipt.record.status === 'accepted')
      promotion.receipt = await transitionConfirmed(p, lease, job, promotion.receipt, 'generating');
    promotion.attempt = promotion.receipt.record;
    const store = p.owner.store;
    if (!store) throw new AppError('PERSISTENCE_ERROR', 'Chat progress could not be confirmed.');
    await write(async () => {
      await store.collection('metadata').updateOne({ _id: key('sequence-counter', t.userId, t.sessionId),
        userId: t.userId, sessionId: t.sessionId }, { $setOnInsert: { schemaVersion: 1, kind: 'sequence-counter',
        userId: t.userId, sessionId: t.sessionId, _revision: 0 }, $max: { next: t.sequence + 3 } },
      { upsert: true, ...store.options() });
    });
    await write(() => p.memory.put(this.foundation.context(t).manifest));
    if (t.calendarReplyTo) await write(() => p.calendarProposals.bindReplyReference({ userId: t.userId,
      sessionId: t.sessionId, turnId: t.turnId, attemptId: t.attemptId, replyTo: t.calendarReplyTo! }));
    const account = await job.wait(cal.connection.currentAccount(), timeout);
    this.assertCalendar(native, account);
    const coldSession = this.sessions.get(t.sessionId);
    if (coldSession?.accountBinding && !isDeepStrictEqual(coldSession.accountBinding, account))
      throw new AppError('NOT_READY', 'Calendar access has changed.', false);
    if (promotion.binding && !isDeepStrictEqual(promotion.binding, account)) throw new AppError('NOT_READY', 'Calendar access has changed.', false);
    promotion.binding = account;
    if (coldSession && !coldSession.accountBinding) coldSession.accountBinding = account;
    const states = [...this.entries.values()].filter(prior => prior.turn.sessionId === t.sessionId && prior.turn.turnId === t.turnId && prior !== e)
      .map(prior => this.foundation.result(prior.turn)?.calendar).filter((value): value is MemoryCalendarState => Boolean(value));
    const active = memoryCalendarStateSchema.parse({ ...native.ledger.snapshot(), ...native.stage.records() });
    states.push(active);
    const accounting = p.calendarAccountingV2;
    let budget = await write(() => accounting.getBudgetConfirmed!(t.userId, t.sessionId, t.turnId));
    if (!budget) budget = await write(() => accounting.createBudgetConfirmed!({ ...active.budget,
      revision: 1, modelDispatches: 0, repairs: 0, logicalTools: 0, creates: 0, calendarRequests: 0,
      refreshRequests: 0, reservedUsd: '0', settledUsd: '0', debits: [] }));
    for (const dispatch of states.flatMap(value => value.dispatches).sort((a, b) => a.dispatchIndex - b.dispatchIndex)) {
      const next = { ...dispatch, connectionId: account.connectionId, connectionRevision: account.connectionRevision };
      let saved = await write(() => accounting.getDispatchConfirmed!(t.userId, dispatch.dispatchId));
      if (!saved) {
        const reservation = { ...next, status: 'reserved' as const, reportedModel: null, reportedProvider: null,
          generationId: null, providerRequestId: null, endedAt: null, firstOutputAt: null, promptTokens: null,
          completionTokens: null, cachedPromptTokens: null, cacheWriteTokens: null, reasoningOutputTokens: null,
          money: unavailableMoney(true), reservationStatus: 'held' as const, failure: null };
        const reserved = await write(() => accounting.reserveDispatchConfirmed!(reservation, budget!));
        saved = reserved.dispatch; budget = reserved.budget;
      }
      if (saved.record.status === 'reserved' && next.status === 'terminal') {
        const dispatched = await write(() => accounting.updateDispatchConfirmed!(saved!, { ...saved!.record, status: 'dispatched' }, budget!));
        saved = dispatched.dispatch; budget = dispatched.budget;
      }
      if (!isDeepStrictEqual(saved.record, next)) {
        const updated = await write(() => accounting.updateDispatchConfirmed!(saved!, next, budget!));
        budget = updated.budget;
      }
    }
    for (const value of states) {
      for (const decision of value.decisions) await write(() => p.skillDecisions.put({ ...decision,
        connectionId: account.connectionId, connectionRevision: account.connectionRevision }));
      for (const rejected of value.rejected) await write(() => p.calendarDecisionsV2.putRejected(rejected));
      for (const result of value.results) {
        if (result.schemaVersion === 2) {
          await write(() => p.calendarRetention.registerSource({
            userId: t.userId, sessionId: t.sessionId, source: result.resultRef.source,
          }));
        }
        await write(() => p.skillResults.put(result));
      }
    }
    if (!budget || budget.record.modelDispatches !== active.budget.modelDispatches ||
        budget.record.reservedUsd !== active.budget.reservedUsd || budget.record.settledUsd !== active.budget.settledUsd)
      throw new AppError('PERSISTENCE_ERROR', 'Calendar accounting could not be confirmed.', false);
    this.assertCalendar(native, account);
    await job.wait(cal.connection.requireAccountCurrent(account, job.signal), timeout);
    this.assertCalendar(native, account);
    const ledger = promotion.ledger ?? new CalendarTurnLedger({ accounting: asCalendarAccountingPort(p),
      identity: { userId: t.userId, sessionId: t.sessionId, turnId: t.turnId, attemptId: t.attemptId,
        openRouterUser: t.userId, createdAt: active.budget.createdAt, deadlineAt: active.budget.deadlineAt },
      limits: snapshot.calendar!.limits ?? CALENDAR_LIMITS, write,
      clock: () => Date.parse(this.runtime.now()), modelId: snapshot.openRouter.modelId,
      pricing: snapshot.modelLimits!.calendar!.pricing, configRevision: snapshot.revision, connection: account,
      maxOutputTokens: snapshot.budgets.maxOutputTokens, processingPolicyId: snapshot.calendar!.processingPolicyId!,
      job, fence: () => p.owner.fence(lease), requireCurrent: async () => {
        this.assertCalendar(native, account); await cal.connection.requireAccountCurrent(account, job.signal);
        this.assertCalendar(native, account);
      } });
    let durableBudget = await ledger.ensureBudget();
    const seenDebits = new Set<string>();
    for (const debit of states.flatMap(value => value.budget.debits ?? [])) {
      if (seenDebits.has(debit.debitId)) continue;
      seenDebits.add(debit.debitId);
      if (debit.kindOfDebit === 'logical-tool' && debit.decisionId) {
        await ledger.chargeLogicalTool(debit.decisionId);
      } else if (debit.kindOfDebit === 'create' && debit.intentId) {
        await ledger.chargeCreate(debit.intentId);
      }
    }
    durableBudget = await ledger.ensureBudget();
    const maxRequests = Math.max(durableBudget.calendarRequests, ...states.map(value => value.budget.calendarRequests));
    const maxRefresh = Math.max(durableBudget.refreshRequests, ...states.map(value => value.budget.refreshRequests));
    if (maxRequests > durableBudget.calendarRequests || maxRefresh > durableBudget.refreshRequests) {
      await ledger.consume({
        ...(maxRequests > durableBudget.calendarRequests ? { calendarRequests: maxRequests } : {}),
        ...(maxRefresh > durableBudget.refreshRequests ? { refreshRequests: maxRefresh } : {}),
      });
    }
    promotion.graph ??= await this.runtime.graph(lease);
    const boundCursor = { ...cursor, connectionId: account.connectionId,
      connectionRevision: account.connectionRevision, ...(cursor.version === 2 ? { accountSubjectId: account.googleSubjectId } : {}) };
    await job.wait(promotion.graph.updateState(graphConfig(t.userId, t.sessionId), {
      input: { attempt: promotion.attempt, assistantSequence: t.sequence + 1 }, boundary: boundaryFor(this.foundation.context(t).manifest),
      result: null, sealed: false, rebase: null, calendarCursor: boundCursor, calendarSeal: null, calendarRefs: refs,
    }, 'prepare'), timeout);
    this.assertCalendar(native, account);
    promotion.ledger = ledger; promotion.ready = true; native.pending = false;
    return { lease, binding: { ...account, calendarId: 'primary', targetRevision: 1 }, ledger };
  }
  private async publishPromoted(e: Entry, seal: CalendarSeal, content: string, artifacts: readonly CanvasArtifactProjection[]): Promise<void> {
    const native = e.native!, promoted = native.promotion!, p = this.d.persistence, t = e.turn;
    const job = native.job, timeout = e.budgets.persistenceTimeoutMs, graph = promoted.graph!;
    const source = this.foundation.context(t), input = this.nativeInput(e);
    const memoryUpdated = native.loop.memoryWasUpdated();
    const assistantFields = { mode: t.mode, ...(t.voice ? { visibility: 'internal' as const, voiceSessionId: t.voice.voiceSessionId } : {}),
      ...(artifacts.length ? { canvasArtifacts: [...artifacts] } : {}),
      ...(memoryUpdated ? { memoryUpdated: true as const } : {}) };
    if (e.delivery) await job.wait(p.owner.run(promoted.lease, async () => {
      const store = p.owner.store;
      if (!store) throw new AppError('PERSISTENCE_ERROR', 'Voice delivery could not be saved.');
      const id = key('voice-delivery', t.userId, t.sessionId, t.attemptId);
      const existing = await store.read('metadata', voiceDeliveryRecordSchema,
        { _id: id, userId: t.userId, sessionId: t.sessionId });
      if (existing) {
        if (!isDeepStrictEqual(existing, e.delivery)) {
          throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Saved voice delivery differs.');
        }
        return;
      }
      await store.insert('metadata', voiceDeliveryRecordSchema, e.delivery!, id, p.metadata.budgets.maxDocumentBytes);
    }), timeout);
    const complete = await graph.getState(graphConfig(t.userId, t.sessionId));
    if (complete.next.length || !complete.values.sealed || !complete.values.calendarSeal)
      throw new AppError('PERSISTENCE_ERROR', 'The response save could not be confirmed.', false);
    await publishCalendarTurn({ persistence: p, work: job, lease: promoted.lease,
      attempt: promoted.attempt!, seal, narration: content, sources: native.loop.provenance(),
      assistantFields, now: () => Date.parse(this.runtime.now()), assistantSequence: t.sequence + 1,
      persistenceTimeoutMs: timeout, liveEvidence: { attemptReceipt: promoted.receipt!, confirmedSnapshot: complete,
        baseManifest: source.manifest, acceptedInput: input, acceptance: promoted.acceptance! },
      commitBoundary: async () => {
        await job.wait(graph.updateState(graphConfig(t.userId, t.sessionId), { boundary: boundaryFor(seal.target) }, 'seal'), timeout);
        const store = p.owner.store;
        if (!store) throw new AppError('PERSISTENCE_ERROR', 'Chat progress could not be confirmed.');
        await job.wait(p.owner.run(promoted.lease, async () => {
          const counter = { schemaVersion: 1, kind: 'sequence-counter', userId: t.userId, sessionId: t.sessionId };
          await store.collection('metadata').updateOne({ _id: key('sequence-counter', t.userId, t.sessionId),
            userId: t.userId, sessionId: t.sessionId }, { $setOnInsert: { ...counter, _revision: 0 },
            $max: { next: t.sequence + 3 } }, { upsert: true, ...store.options() });
          const marker = await store.collection('sessions').updateOne({ _id: key('session', t.userId, t.sessionId),
            userId: t.userId, sessionId: t.sessionId, lifecycle: 'active',
            'execution.ownerId': promoted.lease.ownerId, 'execution.generation': promoted.lease.generation },
          { $set: { memoryPublication: { version: seal.target.contextVersion, sequence: t.sequence + 2,
            epoch: t.epoch, fence: t.fence } }, $inc: { _revision: 1 } }, store.options());
          if (!marker.acknowledged || marker.matchedCount !== 1) throw new AppError('PERSISTENCE_ERROR', 'Chat progress could not be confirmed.');
        }), timeout);
      }, beforeTerminal: async completion => {
        if (!completion.receipt || !p.owner.finishAttempt) throw new AppError('PERSISTENCE_ERROR', 'The response save could not be confirmed.');
        await job.wait(p.owner.finishAttempt(promoted.lease, completion.receipt, completion.activityAt ?? t.createdAt), timeout);
        promoted.receipt = completion.receipt; promoted.attempt = completion.attempt;
      } });
    const output = messageRecordSchema.parse({ schemaVersion: 1, userId: t.userId, sessionId: t.sessionId,
      turnId: t.turnId, attemptId: t.attemptId, messageId: t.outputMessageId, eventId: t.outputEventId,
      sequence: t.sequence + 1, role: 'assistant', content, createdAt: seal.assistantCreatedAt,
      completionStatus: seal.outcome, truncated: seal.outcome === 'truncated', ...assistantFields,
      ...(seal.version === 2 && seal.view ? { calendarView: seal.view } : {}),
      ...(e.weatherView ? { weatherView: e.weatherView } : {}),
      ...(native.loop.provenance().length ? { sourceProvenance: native.loop.provenance() } : {}) });
    this.foundation.commitPromoted(t, { input, output, manifest: seal.target, ...(e.delivery ? { delivery: e.delivery } : {}) });
    const cold = this.sessions.get(t.sessionId)!;
    cold.groups ??= new Map(); cold.groups.set(t.turnId, native.loop.toolGroups()); cold.accountBinding = promoted.binding;
    const pending = await p.calendarProposals.getCurrentSlot(t.userId, t.sessionId);
    cold.pendingProposal = pending?.state === 'pending' ? pending : null;
    cold.attempts.push(promoted.attempt!); e.status = seal.outcome; e.error = null;
    e.snapshot = null; e.personalization = null; e.accounting = undefined; e.delivery = undefined; e.calendar = undefined; e.native = undefined;
    e.weatherView = undefined;
  }
  async reconcilePromoted(sessionId: string): Promise<void> {
    const e = [...this.entries.values()].find(entry => entry.turn.sessionId === sessionId &&
      entry.native?.promotion?.attempt && !this.foundation.result(entry.turn));
    if (!e) return;
    const p = this.d.persistence, t = e.turn;
    const session = await p.sessions.get(t.userId, sessionId);
    const attempt = await p.metadata.getAttempt(t.userId, sessionId, t.attemptId);
    const manifest = await p.memory.get(t.userId, sessionId);
    if (!session || session.execution.ownerId || session.execution.activeAttemptId || !attempt || !terminal(attempt.status) ||
        !manifest || manifest.contextVersion !== t.contextVersion + 1)
      throw new AppError('NOT_READY', 'Chat recovery is incomplete.');
    const input = await p.messages.get(t.userId, sessionId, t.userMessageId);
    if (!input) throw new AppError('NOT_READY', 'Chat recovery is incomplete.');
    const output = await p.messages.get(t.userId, sessionId, t.outputMessageId) ?? messageRecordSchema.parse({
      schemaVersion: 1, userId: t.userId, sessionId, turnId: t.turnId, attemptId: t.attemptId,
      messageId: t.outputMessageId, eventId: t.outputEventId, sequence: t.sequence + 1, role: 'assistant', content: '',
      completionStatus: attempt.status, truncated: attempt.truncated, createdAt: attempt.updatedAt, mode: t.mode,
      ...(t.voice ? { visibility: 'internal', voiceSessionId: t.voice.voiceSessionId } : {}) });
    const acquired = await p.owner.acquire({ userId: t.userId, sessionId, ownerId: p.owner.executorId, leaseMs: 180000 });
    if (!acquired.ok) throw new AppError('CONFLICT_ACTIVE_TURN', 'Chat work is still active.');
    try {
      const store = p.owner.store;
      if (!store) throw new AppError('PERSISTENCE_ERROR', 'Chat recovery could not be confirmed.');
      await p.owner.run(acquired.lease, async () => {
        const result = await store.collection('sessions').updateOne({ _id: key('session', t.userId, sessionId),
          userId: t.userId, sessionId, lifecycle: 'active', 'execution.ownerId': acquired.lease.ownerId,
          'execution.generation': acquired.lease.generation }, { $set: { memoryPublication: {
          version: manifest.contextVersion, sequence: t.sequence + 2, epoch: t.epoch, fence: t.fence } },
          $inc: { _revision: 1 } }, store.options());
        if (!result.acknowledged || result.matchedCount !== 1) throw new AppError('PERSISTENCE_ERROR', 'Chat recovery could not be confirmed.');
      });
    } finally { await p.owner.release(acquired.lease); }
    const delivery = t.mode === 'live' ? await p.metadata.getVoiceDelivery(t.userId, sessionId, t.attemptId) : null;
    this.foundation.commitPromoted(t, { input, output, manifest, ...(delivery ? { delivery } : {}) });
    const cold = this.sessions.get(sessionId)!;
    cold.stale = false; cold.session = session; cold.attempts.push(attempt);
    cold.groups = await calendarHistory(p, t.userId, sessionId, this.foundation.records(sessionId), () => Date.parse(this.runtime.now()), cold.session);
    const pending = await p.calendarProposals.getCurrentSlot(t.userId, sessionId);
    cold.pendingProposal = pending?.state === 'pending' ? pending : null;
    cold.accountBinding = e.native!.promotion!.binding;
    e.status = attempt.status; e.error = attempt.errorCode ? new AppError(attempt.errorCode, 'This response is incomplete.', false) : null;
    e.snapshot = null; e.native = undefined; e.calendar = undefined;
  }

  /**
   * Reconciles a same-process pending or unresolved Calendar mutation through
   * the session's independent mutation barrier without entering the archive
   * queue or replaying model inference.
   */
  async reconcileMutation(sessionId: string): Promise<boolean> {
    if (!this.sessions.has(sessionId)) return false;
    const active = [...this.entries.values()].some(entry => entry.turn.sessionId === sessionId && entry.running);
    if (active || this.foundation.session(sessionId).pausedAttemptId !== null) {
      throw new AppError('CONFLICT_ACTIVE_TURN', 'Chat work is still active.');
    }
    const p = this.d.persistence;
    const userId = this.foundation.userId;
    const pendingEntry = [...this.entries.values()].find(
      entry => entry.turn.sessionId === sessionId && entry.native?.pending && !this.foundation.result(entry.turn),
    );
    if (pendingEntry?.native?.promotion?.attempt) return false;
    const cal = this.d.calendar;
    const session = await p.sessions.get(userId, sessionId);
    const pendingOp = cal && isCalendarV2(cal)
      ? await pendingCalendarOperation({
        persistence: p,
        userId,
        sessionId,
        values: {},
        latestTurnId: session?.latestTurnId ?? null,
        ...(pendingEntry ? { acceptedTurnIds: [pendingEntry.turn.turnId] } : {}),
      })
      : null;
    if (!pendingEntry && !pendingOp) return false;
    if (!cal || !isCalendarV2(cal)) {
      if (pendingEntry && !this.foundation.result(pendingEntry.turn) && !this.foundation.session(sessionId).fenced) {
        this.finish(pendingEntry, '', 'interrupted', new AppError('INTERRUPTED', 'Calendar access is unavailable.', false));
        return true;
      }
      return false;
    }
    if (pendingOp && pendingOp.schemaVersion !== 2) {
      throw new AppError('NOT_READY', 'Legacy Calendar operation requires operator recovery.');
    }
    const attemptId = pendingEntry?.turn.attemptId ?? pendingOp!.originatingAttemptId;
    const timeout = this.d.config.budgets.persistenceTimeoutMs;
    const job = this.runtime.work.open(userId, sessionId, new AbortController().signal, this.d.config.budgets.totalRunTimeoutMs);
    let handle: CalendarMutationHandle | undefined;
    let paused = false;
    try {
      if (pendingEntry && !this.foundation.session(sessionId).fenced
        && this.foundation.session(sessionId).activeAttemptId === pendingEntry.turn.attemptId) {
        this.foundation.pauseSession(pendingEntry.turn);
        paused = true;
      }
      handle = await job.wait(p.sessions.beginCalendarMutation({
        userId,
        sessionId,
        attemptId,
        executorId: p.owner.executorId,
        archiveOwned: true,
      }), timeout);
      const ownedHandle = handle;
      const barrier = {
        write: <T>(action: () => Promise<T>) => job.wait(action(), timeout),
        fence: () => p.sessions.assertCalendarMutation(ownedHandle, p.owner.executorId),
      };
      if (pendingOp) {
        if (pendingOp.state === 'dispatching' || pendingOp.state === 'unknown' || pendingOp.state === 'succeeded') {
          await reconcileCalendarOperationV2({
            persistence: p,
            barrier,
            job,
            userId,
            sessionId,
            execution: cal.execution,
            capabilities: cal.capabilities,
            operation: pendingOp,
            attemptId,
            trustedTimeZone: cal.trustedTimeZone,
            now: () => this.runtime.now(),
          });
        } else if (pendingOp.state === 'planned') {
          const attempt = await p.metadata.getAttempt(userId, sessionId, attemptId)
            ?? (await p.metadata.listAttempts(userId, sessionId, { cursor: null, limit: 20 }))
              .items.find(item => item.turnId === pendingOp.turnId);
          if (attempt) {
            await reconcilePlannedCalendarOperationV2({
              persistence: p,
              barrier,
              job,
              userId,
              sessionId,
              execution: cal.execution,
              capabilities: cal.capabilities,
              connection: cal.connection,
              operation: pendingOp,
              attempt,
              trustedTimeZone: cal.trustedTimeZone,
              permission: cal.permission,
              auditDeadlineAt: cal.auditDeadlineAt,
              limits: this.d.currentConfig?.current()?.calendar?.limits,
              pricing: pendingEntry?.snapshot?.modelLimits?.calendar?.pricing,
              configRevision: pendingEntry?.snapshot?.revision,
              openRouterUser: userId,
              now: () => this.runtime.now(),
            });
          }
        }
      } else if (pendingEntry) {
        const attempt = await p.metadata.getAttempt(userId, sessionId, pendingEntry.turn.attemptId);
        if (attempt && !terminal(attempt.status)) {
          await reconcileConsumedProposalWithoutOperation({
            persistence: p,
            barrier,
            job,
            userId,
            sessionId,
            execution: cal.execution,
            capabilities: cal.capabilities,
            connection: cal.connection,
            attempt,
            trustedTimeZone: cal.trustedTimeZone,
            permission: cal.permission,
            auditDeadlineAt: cal.auditDeadlineAt,
            limits: this.d.currentConfig?.current()?.calendar?.limits,
            pricing: pendingEntry.snapshot?.modelLimits?.calendar?.pricing,
            configRevision: pendingEntry.snapshot?.revision,
            openRouterUser: userId,
            now: () => this.runtime.now(),
          });
        }
      }
      return true;
    } finally {
      await job.settled();
      if (handle) {
        try {
          await p.sessions.finishCalendarMutation(handle, p.owner.executorId);
        } catch {
          this.runtime.work.degraded = true;
        }
      }
      job.close();
      if (paused && pendingEntry && !this.foundation.session(sessionId).fenced) {
        this.foundation.resumeSession(pendingEntry.turn);
      }
      if (pendingEntry && !this.foundation.result(pendingEntry.turn) && !this.foundation.session(sessionId).fenced) {
        this.finish(pendingEntry, '', 'interrupted', new AppError('INTERRUPTED', 'Generation was interrupted. Retry to continue.', false));
      }
    }
  }
  async execute(c: ExecuteTurn): Promise<boolean> {
    const e = this.find(c.sessionId, c.turnId); if (!e) return false;
    this.user(c.userId);
    if (Boolean(c.live) !== (e.turn.mode === 'live') || e.turn.attemptId !== c.attemptId) throw new AppError('CONFLICT_ACTIVE_TURN', 'This attempt is no longer current.');
    if (c.live) this.runtime.reservations.assertLive(c.live.reservation, e.identity, c.sessionId);
    else this.runtime.reservations.assertText(c.userId, c.sessionId);
    if (e.running) throw new AppError('CONFLICT_ACTIVE_TURN', 'Another turn is active.');
    let sequence = 0;
    const send = (event: StreamEvent) => c.emit(streamEnvelopeSchema.parse({ protocolVersion: 1,
      sessionId: c.sessionId, turnId: c.turnId, attemptId: c.attemptId, sequence: sequence++, event }));
    const previous = this.foundation.result(e.turn);
    if (previous) {
      if (c.live) return true; // Replay never speaks again.
      await send({ type: 'status', status: e.status, truncated: e.status === 'truncated', save: this.status(c.userId, c.sessionId, c.turnId)!.save });
      for (let i = 0; i < previous.output.content.length; i += 1000)
        await send({ type: 'delta', text: previous.output.content.slice(i, i + 1000), ...(i === 0 ? { reset: true } : {}) });
      if (previous.status === 'completed' || previous.status === 'truncated')
        await send({ type: 'completed', outcome: previous.status, assistantMessageId: e.turn.outputMessageId,
          save: this.status(c.userId, c.sessionId, c.turnId)!.save,
          ...(previous.output.calendarView ? { calendarView: previous.output.calendarView } : {}),
          ...(previous.output.weatherView ? { weatherView: previous.output.weatherView } : {}),
          ...(previous.output.memoryUpdated ? { memoryUpdated: true } : {}) });
      else if (e.error) await send({ type: 'error', ...e.error.toClientBody() });
      return true;
    }
    const snapshot = e.snapshot;
    if (!snapshot) throw new AppError('NOT_READY', 'Accepted settings are unavailable.');
    this.runtime.ready();
    const turnMode = createTurnModelMode(this.d.devMode, c.principal, c.userId, !c.localToolControl);
    const job = this.runtime.work.attach(c.userId, c.sessionId, c.signal, snapshot.budgets.totalRunTimeoutMs);
    if (e.webAcceptedAt !== undefined && this.d.webSearch && !e.web) {
      e.web = new WebTurn({ port: this.d.webSearch, identity: e.identity,
        sessionId: c.sessionId, turnId: c.turnId,
        limits: e.webLimits ?? { maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 },
        advertised: true, acceptedAtMonotonic: e.webAcceptedAt,
        runTimeoutMs: snapshot.budgets.totalRunTimeoutMs, nowMs: () => performance.now(),
        signal: job.signal,
        present: event => { void send({ ...event } as StreamEvent).catch(() => undefined); },
        headroom: () => true });
      e.web.bind(job.signal);
    }
    e.running = true; let partial = ''; let ended = false; let length = false;
    let started = false, liveFinished = false, settlementError: unknown;
    let promotedSeal: CalendarSeal | null = null;
    let reconcilePrefix = false;
    let narrated = false;
    const artifacts: CanvasArtifactProjection[] = [];
    const admittedArtifacts: CanvasArtifactProjection[] = [];
    const prose = c.live ? new SpeechProse(Math.min(32000, snapshot.budgets.maxInputChars), source => {
      artifacts.push({ ...source, responseId: key('voice-response', c.userId, c.sessionId, c.attemptId) });
    }, () => turnMode?.frozen()?.mode !== 'dev') : null;
    const messageProseBudget = this.runtime.outputBudget(
      this.attempt(e), e.turn.sequence + 1, Boolean(c.live), snapshot.budgets.maxMessageBytes,
    );
    // ponytail: 2048B accounting + 1536B fixed delivery header + 8B surrogate-split reserve
    // cover all non-prose evidence fields; revisit only if VoiceDeliveryRecord adds fields.
    const liveEvidenceMaxBytes = this.policy.maxEvidenceBytes - 2048;
    const encodedStringBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;
    const checkOutputCapacities = (nextProse: string, nextArtifacts: readonly CanvasArtifactProjection[]) => {
      const proseEncoded = encodedStringBytes(nextProse);
      const artifactsEncoded = nextArtifacts.length
        ? Buffer.byteLength(JSON.stringify({ canvasArtifacts: nextArtifacts }), 'utf8') - 1
        : 0;
      const viewEncoded = e.calendarView
        ? Buffer.byteLength(JSON.stringify({ calendarView: e.calendarView }), 'utf8') - 1 : 0;
      const weatherEncoded = e.weatherView
        ? Buffer.byteLength(JSON.stringify({ weatherView: e.weatherView }), 'utf8') - 1 : 0;
      if (proseEncoded > messageProseBudget || proseEncoded + artifactsEncoded + viewEncoded + weatherEncoded > this.policy.maxOutputBytes ||
          (c.live && 1536 + 2 * proseEncoded + 8 + artifactsEncoded > liveEvidenceMaxBytes)) {
        throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The response exceeded its storage limit.', false);
      }
    };
    const publish = async (text: string) => {
      e.calendarView = e.native?.loop.viewSnapshot() ?? e.calendarView;
      if (text) {
        const nextPartial = partial + text;
        checkOutputCapacities(nextPartial, admittedArtifacts);
        partial = nextPartial;
        await c.live?.delta(text);
        await job.wait(send({ type: 'delta', text }), snapshot.budgets.idleStreamTimeoutMs);
      }
      if (c.live && prose?.visualSuffixStarted && !liveFinished) {
        liveFinished = true;
        await c.live.finish();
      }
      while (artifacts.length) {
        const artifact = artifacts.shift()!;
        const candidate = admittedArtifacts.some(existing => existing.ordinal === artifact.ordinal)
          ? admittedArtifacts : [...admittedArtifacts, artifact];
        checkOutputCapacities(partial, candidate);
        if (!c.live?.artifact || !await c.live.artifact(artifact)) throw new AppError('NOT_READY', 'Visual delivery is unavailable.');
        if (candidate !== admittedArtifacts) admittedArtifacts.push(artifact);
      }
    };
    let mutationBarrier: MutationBarrier | undefined = e.native?.mutation;
    const presentWeather = (view: WeatherView) => {
      e.weatherView = view;
      try { c.onWeatherView?.(view); }
      catch { /* Presentation hook never alters tool execution. */ }
      void send({ type: 'weather-view', view }).catch(() => undefined);
    };
    const calendarFrame = async (frame: CalendarCompatibleEnvelope): Promise<void> => {
      if (frame.event.type === 'delta') {
        narrated = true;
        c.live?.modelOutput?.();
        await publish(prose ? prose.push(frame.event.text) : frame.event.text);
        return;
      }
      if (frame.event.type === 'calendar-view') e.calendarView = frame.event.view;
      if (!c.live) { await c.emitCalendar?.(frame); return; }
      try { void c.emitCalendar?.(frame).catch(() => undefined); }
      catch { /* Presentation cannot fail generation or authority. */ }
    };
    try {
      job.check(); e.status = 'generating';
      await job.wait(send({ type: 'status', status: 'generating', truncated: false }), snapshot.budgets.idleStreamTimeoutMs);
      let source = this.foundation.context(e.turn);
      const assembler = new ReferencedContextAssembler({ memory: this.d.persistence.memory, messages: this.d.persistence.messages,
        metadata: { getVoiceDelivery: async (_u, s, a) => this.foundation.deliveries(s).find(d => d.attemptId === a) ?? null,
          getVoiceDeliveries: async (_u, s, ids) => this.foundation.deliveries(s).filter(d => ids.includes(d.attemptId)) },
        assets: this.d.assets, budgets: snapshot.budgets });
      const assembleOnce = () => assembler.assemble({ userId: c.userId, sessionId: c.sessionId,
        turnId: c.turnId, newUserInput: e.turn.content, responseMode: c.live ? 'voice' : 'text',
        environment: defaultEnvironmentContext(new Date(this.runtime.now()), e.clientTimeZone ?? this.d.calendar?.trustedTimeZone ?? 'Etc/UTC'),
        personalization: e.personalization ?? defaultPersonalizationSettings() }, source);
      const waitForCompaction = async (running: Promise<unknown>) => {
        await new Promise<void>(resolve => {
          const done = () => { job.signal.removeEventListener('abort', done); resolve(); };
          job.signal.addEventListener('abort', done, { once: true });
          void running.then(done, done);
          if (job.signal.aborted) done();
        });
        job.check();
      };
      const rebaseAndReassemble = async () => {
        job.check();
        this.tryPromotePendingCompaction(c.sessionId, e);
        source = this.foundation.context(e.turn);
        const result = await assembleOnce();
        job.check();
        return result;
      };
      let assembled = await assembleOnce();
      job.check();
      if (!assembled.ok) {
        const running = this.sessions.get(c.sessionId)?.compaction?.running;
        if (running) {
          await waitForCompaction(running);
          assembled = await rebaseAndReassemble();
        }
      }
      if (!assembled.ok) {
        this.scheduleCompactionIfNeeded(c.sessionId, snapshot);
        const running = this.sessions.get(c.sessionId)?.compaction?.running;
        if (running) {
          await waitForCompaction(running);
          assembled = await rebaseAndReassemble();
        }
      }
      if (!assembled.ok) throw new AppError('CONTEXT_BUDGET_EXCEEDED', assembled.overflow.message, false);
      let readyContext = assembled.context;
      const adapterMaxBytes = c.live
        ? snapshot.budgets.maxMessageBytes
        : Math.min(messageProseBudget, this.policy.maxOutputBytes);
      const cold = this.sessions.get(c.sessionId)!;
      const memoryToolTurn = this.runtime.explicitMemory(cold.session, c.turnId, snapshot, turnMode, c.localToolControl);
      // Historical evidence comes from server memory only; the current
      // attempt starts fresh, so a retry never replays its predecessor's groups.
      const buildHistoricalGroups = (records: readonly MessageRecord[]) => {
        const liveTurnIds = new Set(records.map(r => r.turnId));
        const historicalWebGroups = new Map<string, WebToolGroup[]>(cold.webGroups ?? []);
        for (const [turnId, groups] of this.foundation.webGroups(c.sessionId))
          if (!historicalWebGroups.has(turnId)) historicalWebGroups.set(turnId, groups);
        historicalWebGroups.delete(c.turnId);
        for (const turnId of [...historicalWebGroups.keys()]) if (!liveTurnIds.has(turnId)) historicalWebGroups.delete(turnId);
        const historicalGroups = new Map(cold.groups ?? []);
        for (const [turnId, groups] of this.foundation.nativeGroups(c.sessionId))
          if (!historicalGroups.has(turnId)) historicalGroups.set(turnId, groups);
        const initialGroups = historicalGroups.get(c.turnId) ?? [];
        historicalGroups.delete(c.turnId);
        for (const turnId of [...historicalGroups.keys()]) if (!liveTurnIds.has(turnId)) historicalGroups.delete(turnId);
        // Only completed/truncated historical turns with validated Web groups
        // may be projected; the explicit pending proposal stays literal.
        const pinned = cold.pendingProposal?.originatingTurnId;
        const foldableTurnIds = new Set(records.filter(record => record.role === 'assistant'
          && (record.completionStatus === 'completed' || record.completionStatus === 'truncated')
          && record.turnId !== c.turnId && record.turnId !== pinned
          && historicalWebGroups.has(record.turnId)).map(record => record.turnId));
        return { historicalWebGroups, historicalGroups, initialGroups, foldableTurnIds };
      };
      let { historicalWebGroups, historicalGroups, initialGroups, foldableTurnIds } =
        buildHistoricalGroups(source.records);
      const modeDispatch: TurnModelDispatch | undefined = turnMode ? {
        handle: turnMode, rawInput: e.turn.content,
        project: decision => projectTurnMessages(readyContext.messages,
          readyContext.messages.length - 1, readyContext as PositionedContext, decision),
      } : undefined;
      const calendarEnabled = Boolean(snapshot.calendar?.enabled && this.d.calendar && isCalendarV2(this.d.calendar));
      const envToolCapable = Boolean(snapshot.modelLimits?.tools);
      const textNativeTools = [...(e.web ? [WEB_TOOL_DEFINITION] : []), ...(envToolCapable ? [GET_ENVIRONMENT_TOOL_DEFINITION] : []),
        ...(memoryToolTurn?.allowed() ? [UPDATE_USER_MEMORY_TOOL_DEFINITION] : [])];
      const limits = snapshot.calendar?.limits ?? CALENDAR_LIMITS;
      const canvasPort = c.live?.canvas;
      const inventoryFor = (): CanvasInventorySnapshot => canvasPort
        ? ownedCanvasInventory(canvasPort.inventory(),
            mergeCanvasRecords([...this.allCanvasRecords(c.sessionId), ...source.records]),
            c.userId, c.sessionId)
        : { items: [], omitted: 0 };
      const selectionFor = (): CanvasSelection | null => canvasPort
        ? ownedCanvasSelection(canvasPort.selection?.(), inventoryFor())
        : null;
      // Web-only turns admit the exact native prompt after historical groups are
      // inserted; the admission closure retains each group's wire result index.
      const assembleWebBase = () => {
        const positioned = readyContext as Partial<PositionedContext>;
        const historicalWebResults: HistoricalWebResult[] = [];
        const messages = insertWebGroups(readyContext.messages, positioned.historyPositions ?? [],
          historicalWebGroups, historicalWebResults);
        const admit = (candidate: readonly WebNativeMessage[]) => admitNativePrompt({
          messages: candidate, prefixCount: positioned.prefixCount ?? 0, historicalWebResults,
          foldableTurnIds, budgets: snapshot.budgets, tools: textNativeTools,
          contextTokens: snapshot.modelLimits!.contextTokens,
        });
        return { messages, admit };
      };
      let preparedWeb: (ReturnType<typeof assembleWebBase> & { initial: WebContextResult }) | undefined;
      const preflightNative = () => {
        if (snapshot.modelLimits?.calendar?.tools) {
          if (e.native) return;
          assembleTurnCalendarContext({
            context: readyContext,
            acceptedInput: e.turn.content,
            groups: initialGroups,
            historicalGroups,
            historicalWebGroups,
            foldableTurnIds,
            repair: null,
            snapshot,
            limits,
            binding: cold.accountBinding ?? { userId: c.userId, connectionId: 'memory-unbound', connectionRevision: 1,
              googleSubjectId: 'memory-unbound' },
            calendarEnabled,
            calendarConnection: calendarEnabled ? 'connected' : 'not-connected',
            responseMode: c.live ? 'voice' : 'text',
            ...(c.live ? { canvasInventory: inventoryFor(), canvasSelection: selectionFor() } : {}),
            nowMs: Date.parse(this.runtime.now()),
            ...(e.web ? { webGroups: e.web.groups() } : {}),
            memoryAdvertised: memoryToolTurn?.allowed() === true,
          });
          return;
        }
        if (e.web || envToolCapable) {
          const base = assembleWebBase();
          preparedWeb = { ...base, initial: base.admit(base.messages) };
        }
      };
      // Bounded fallback: wait for the existing compaction job, reassemble from
      // source, and force one schedule only when the same route still overflows.
      const fitsNative = () => {
        try { preflightNative(); return true; }
        catch (error) {
          if (!(error instanceof AppError && error.code === 'CONTEXT_BUDGET_EXCEEDED')) throw error;
          return false;
        }
      };
      const refreshAfterWait = async (running: Promise<unknown>) => {
        await waitForCompaction(running);
        const next = await rebaseAndReassemble();
        if (!next.ok) throw new AppError('CONTEXT_BUDGET_EXCEEDED', next.overflow.message, false);
        readyContext = next.context;
        ({ historicalWebGroups, historicalGroups, initialGroups, foldableTurnIds } =
          buildHistoricalGroups(source.records));
      };
      if (!fitsNative()) {
        const pending = cold.compaction?.running;
        if (pending) await refreshAfterWait(pending);
        if (!pending || !fitsNative()) {
          // Burst fallback: the normal route already failed to fit, so this single
          // forced pass compacts down to the physical floor of one verbatim turn.
          this.scheduleCompactionIfNeeded(c.sessionId, snapshot, true, 1);
          const running = cold.compaction?.running;
          if (running && running !== pending) await refreshAfterWait(running);
          preflightNative(); // Throws the current exact budget error if still too large.
        }
      }
      job.check();
      if (c.live) {
        await c.live.start(this.attempt(e), async (value, expectedSequence) => {
          const record = voiceDeliveryRecordSchema.parse(value), prior = e.delivery;
          if (record.userId !== c.userId || record.sessionId !== c.sessionId || record.turnId !== c.turnId ||
            record.attemptId !== c.attemptId || record.voiceSessionId !== e.turn.voice!.voiceSessionId ||
            record.responseId !== key('voice-response', c.userId, c.sessionId, c.attemptId) ||
            (!prior && (record.status !== 'pending' || record.sequence !== 1 || record.canvasArtifacts !== undefined)) ||
            (prior && (prior.status !== 'pending' || prior.providerSocketId !== record.providerSocketId ||
              (prior.canvasArtifacts ?? []).some((artifact, i) => !isDeepStrictEqual(artifact, record.canvasArtifacts?.[i])))) ||
            (expectedSequence === undefined ? prior !== undefined : prior?.sequence !== expectedSequence || record.sequence !== expectedSequence + 1) ||
            Buffer.byteLength(JSON.stringify(record), 'utf8') > liveEvidenceMaxBytes)
            throw new AppError('INVALID_REQUEST', 'Voice evidence is invalid.');
          e.delivery = record;
        });
        started = true;
      }
      if (snapshot.modelLimits?.calendar?.tools) {
        const t = e.turn, attempt = this.attempt(e);
        if (!e.native) {
        const ledger = new MemoryCalendarLedger({ identity: { userId: c.userId, sessionId: c.sessionId,
          turnId: c.turnId, attemptId: c.attemptId, openRouterUser: attempt.openRouterUser,
          createdAt: e.initialBudget?.createdAt ?? t.createdAt,
          deadlineAt: e.initialBudget?.deadlineAt ?? new Date(Date.parse(t.createdAt) + snapshot.budgets.totalRunTimeoutMs).toISOString() },
          limits, clock: () => Date.parse(this.runtime.now()), modelId: attempt.modelId,
          pricing: snapshot.modelLimits!.calendar!.pricing, configRevision: snapshot.revision,
          maxOutputTokens: snapshot.budgets.maxOutputTokens,
          processingPolicyId: snapshot.calendar?.processingPolicyId ?? 'native-local.v1', job,
          initialBudget: e.initialBudget });
        const stage = new MemoryCalendarStage(this.policy.maxEvidenceBytes, limits.modelDispatches);
        let native: NativeExecution;
        const loop = new CalendarLoop({ persistence: this.d.persistence, calendar: this.d.calendar, ledger,
          calendarEnabled, calendarConnection: calendarEnabled ? 'connected' : 'not-connected',
          canvasInventory: inventoryFor, canvasSelection: selectionFor,
          navigateCanvas: (envelope, toolCallId) => navigateCanvas({
            envelope, responseMode: c.live ? 'voice' : 'text', inventory: inventoryFor(),
            active: () => canvasPort?.active() ?? false,
            show: canvasId => canvasPort?.show(canvasId, toolCallId, job.signal) ?? false,
          }),
          controlCanvas: (envelope, toolCallId, expected) => controlCanvas({
            envelope, responseMode: c.live ? 'voice' : 'text', expected, selection: selectionFor(),
            active: () => !job.signal.aborted && (canvasPort?.active() ?? false),
            control: (command, target) => canvasPort?.control?.(command, target, toolCallId, job.signal) ?? false,
          }),
          attempt, input: this.nativeInput(e),
          snapshot, limits, binding: { ...(cold.accountBinding ?? { userId: t.userId, connectionId: 'memory-unbound', connectionRevision: 1,
            googleSubjectId: 'memory-unbound' }), calendarId: 'primary', targetRevision: 1 },
          context: readyContext, job, lease: null, sequence: { value: 0 },
          emitCalendar: calendarFrame, assets: this.d.assets, manifest: source.manifest, assistantSequence: t.sequence + 1,
          fetcher: this.d.fetcher ?? fetch, now: () => this.runtime.now(), diagnostics: this.d.diagnostics,
          historicalGroups, historicalWebGroups, initialGroups, foldableTurnIds, responseMode: c.live ? 'voice' : 'text',
          turnMode, localToolControl: c.localToolControl,
          memoryTool: memoryToolTurn,
          clientTimeZone: e.clientTimeZone,
          executeEnvironment: (envelope, signal) => executeEnvironmentTool({
            envelope,
            now: new Date(this.runtime.now()),
            timeZone: e.clientTimeZone ?? this.d.calendar?.trustedTimeZone ?? 'Etc/UTC',
            savedLocation: extractSavedLocation(e.personalization),
            requestGeo: e.requestGeo ?? null,
            weatherProvider: this.weatherProvider(),
            signal,
          }),
          onWeatherView: presentWeather,
          ...(e.web ? { web: e.web } : {}),
          onView: view => { e.calendarView = view; },
          onClearView: () => { e.calendarView = undefined; },
          memory: { stage, records: source.records, pendingProposal: cold.pendingProposal ?? null,
            onProposal: proposal => { cold.pendingProposal = proposal; },
            readAccount: async () => {
              this.assertCalendar(native);
              const cal = this.d.calendar;
              if (!cal || !isCalendarV2(cal) || !this.d.currentConfig?.current()?.calendar?.enabled) {
                throw new AppError('NOT_READY', 'Calendar access is unavailable.', false);
              }
              const account = await job.wait(cal.connection.currentAccount(), snapshot.budgets.persistenceTimeoutMs);
              native.boundAccount = account;
              this.assertCalendar(native, account);
              const session = this.sessions.get(t.sessionId);
              if (session?.accountBinding && !isDeepStrictEqual(session.accountBinding, account)) {
                throw new AppError('NOT_READY', 'Calendar access has changed.', false);
              }
              if (session && !session.accountBinding) session.accountBinding = account;
              return account;
            },
            promote: async (cursor, refs) => {
              try { return await this.promoteTurn(e, native, cursor, refs); }
              catch (error) { throw error instanceof AppError ? error : new AppError('PERSISTENCE_ERROR', 'Chat progress could not be confirmed.', false); }
            },
            mutation: {
              ensureAccepted: async opts => {
                mutationBarrier = await this.ensureMutationAccepted(e, native, opts);
              },
              writerOptions: () => {
                const mut = native.mutation;
                if (!mut?.acceptedConfirmed || !mut.handle || !mut.ledger) {
                  throw new AppError('NOT_READY', 'Calendar mutation ownership is unavailable.', false);
                }
                const durableLedger = mut.ledger;
                const handle = mut.handle;
                const p = this.d.persistence;
                return {
                  ledger: {
                    ensureBudget: () => durableLedger.ensureBudget(),
                    deadlineAt: () => durableLedger.deadlineAt(),
                    chargeLogicalTool: async (decisionId, hash) => {
                      await durableLedger.chargeLogicalTool(decisionId, hash);
                      await native.ledger.chargeLogicalTool(decisionId, hash);
                    },
                    chargeCreate: async (intentId, hash) => {
                      await durableLedger.chargeCreate(intentId, hash);
                      await native.ledger.chargeCreate(intentId, hash);
                    },
                    chargeCalendarRequest: async kind => {
                      await durableLedger.chargeCalendarRequest(kind);
                      await native.ledger.chargeCalendarRequest(kind);
                    },
                    chargeRefreshRequest: async () => {
                      await durableLedger.chargeRefreshRequest();
                      await native.ledger.chargeRefreshRequest();
                    },
                  },
                  // ponytail: scoped Calendar mutation ownership checks handle before and after
                  // each un-transacted write; assumes one live backend process per database.
                  write: async <T>(action: () => Promise<T>) => {
                    const timeout = e.snapshot?.budgets.persistenceTimeoutMs ?? e.budgets.persistenceTimeoutMs;
                    if (!await job.wait(p.sessions.assertCalendarMutation(handle, p.owner.executorId), timeout)) {
                      throw new AppError('INTERRUPTED', 'Calendar execution ownership was lost.');
                    }
                    const out = await job.wait(action(), timeout);
                    if (!await job.wait(p.sessions.assertCalendarMutation(handle, p.owner.executorId), timeout)) {
                      throw new AppError('INTERRUPTED', 'Calendar execution ownership was lost.');
                    }
                    return out;
                  },
                  fence: async () => {
                    const h = native.mutation?.handle;
                    if (!h || !await p.sessions.assertCalendarMutation(h, p.owner.executorId)) return false;
                    try { this.assertCalendar(native, mut.binding); return true; } catch { return false; }
                  },
                };
              },
              onMutation: payload => {
                if (!native.mutation) {
                  throw new AppError('NOT_READY', 'Calendar mutation ownership is unavailable.', false);
                }
                native.mutation.mutation = payload;
              },
            } },
        });
        native = { ledger, stage, loop, job, boundAccount: cold.accountBinding ?? undefined, invalidation: 0, pending: false };
        e.native = native;
        }
        const native = e.native, loop = native.loop;
        native.job = job; native.ledger.rebindJob(job); loop.resume(job, calendarFrame);
        const input = { attempt, assistantSequence: t.sequence + 1 };
        const node = async (name: 'calendar_decide' | 'calendar_execute', action: () => Promise<CalendarGraphPatch>) => {
          const patch = await action();
          if (native.promotion?.ready) await job.wait(native.promotion.graph!.updateState(graphConfig(t.userId, t.sessionId), patch, name), snapshot.budgets.persistenceTimeoutMs);
          return patch;
        };
        const graph = buildTurnGraph(undefined, { prepare: async () => ({ calendarCursor: loop.initialCursor() }),
          generate: async () => { throw new AppError('NOT_READY', 'Native decision is required.'); },
          decide: current => job.track(node('calendar_decide', () => loop.decide(current))),
          execute: current => job.track(node('calendar_execute', () => loop.execute(current))) });
        try {
          const result = await graph.invoke({ input, boundary: boundaryFor(source.manifest), result: null,
            sealed: false, calendarCursor: loop.initialCursor(), calendarSeal: null, calendarRefs: null },
          { signal: job.signal, recursionLimit: 48 });
          if (!result.sealed || !result.calendarSeal) throw new AppError('INTERRUPTED', 'The response ended early.', false);
          e.calendarView = result.calendarSeal.version === 2 ? result.calendarSeal.view : undefined;
          const text = loop.narration();
          if ((!c.live && partial !== text && !(text && partial.endsWith(text))) || (c.live && !narrated)) {
            // Local validation/repair fallback is produced by the same loop and
            // can seal without model deltas. It still uses the bounded output path.
            if (partial) throw new AppError('PROVIDER_ERROR', 'The response could not be confirmed.', false);
            await publish(prose ? prose.push(text) : text);
          }
          if (prose) await publish(prose.finish());
          if (c.live && !liveFinished) { liveFinished = true; await c.live.finish(); }
          length = result.calendarSeal.outcome === 'truncated';
          if (native.promotion?.ready) {
            await job.wait(native.promotion.graph!.updateState(graphConfig(t.userId, t.sessionId), {
              ...result, sealed: true }, 'seal'), snapshot.budgets.persistenceTimeoutMs);
            promotedSeal = result.calendarSeal;
          }
        } finally {
          // LangGraph may return on abort while a node is unwinding its adapter.
          // Keep ownership/accounting mutable until every actual node settles.
          await job.settled();
          const mut = native.mutation;
          if (mut?.handle) {
            const h = mut.handle;
            mut.handle = undefined;
            try {
              await this.d.persistence.sessions.finishCalendarMutation(h, this.d.persistence.owner.executorId);
            } catch {
              this.runtime.work.degraded = true;
            }
          }
          if (!native.promotion?.ready) {
            if (mut?.prefixFrozen) {
              e.calendar = mut.prefixCalendar;
            }
            if (mut?.acceptedConfirmed) {
              e.calendar = mut.prefixCalendar;
              if (mut.mutation) {
                const snap = native.ledger.snapshot();
                const aggregate = snap.dispatches.length > 0
                  ? (snap.aggregate ?? await native.ledger.aggregate())
                  : null;
                const binding = mut.binding;
                const boundDecision = mut.mutation.decision && binding
                  ? { ...mut.mutation.decision, connectionId: binding.connectionId, connectionRevision: binding.connectionRevision }
                  : mut.mutation.decision;
                e.calendarMutation = {
                  operationId: mut.mutation.operationId,
                  decision: boundDecision,
                  result: mut.mutation.result,
                  aggregate,
                };
              }
              const coldSession = this.sessions.get(t.sessionId);
              if (coldSession && !native.pending) {
                coldSession.groups ??= new Map();
                if (native.loop.toolGroups().length) coldSession.groups.set(t.turnId, native.loop.toolGroups());
                if (native.boundAccount) coldSession.accountBinding = native.boundAccount;
              }
            } else {
              e.calendar = memoryCalendarStateSchema.parse({ ...native.ledger.snapshot(), ...native.stage.records() });
            }
            const provenance = native.loop.provenance();
            if (provenance.length) e.sourceProvenance = provenance;
          }
        }
      } else if (e.web || envToolCapable) {
        const webTurn = e.web ?? null;
        const adapter = createWebNativeModelPort({
          identity: { userId: e.turn.userId },
          sessionId: e.turn.sessionId,
          openRouter: snapshot.openRouter,
          budgets: { ...snapshot.budgets, maxMessageBytes: adapterMaxBytes },
        }, snapshot.modelLimits!, this.d.fetcher ?? fetch, this.d.diagnostics?.emit);
        const input = { attempt: this.attempt(e), assistantSequence: e.turn.sequence + 1 };
        const graph = buildTurnGraph(undefined, { prepare: async () => { job.check(); }, generate: async () => {
          c.live?.modelStarted?.();
          const { messages: base, admit } = preparedWeb!;
          let messages: WebNativeMessage[] = [...base];
          let answered = false;
          let envCallsUsed = 0;
          let envRepairsUsed = 0;
          let nonWebModelAttempts = 0;
          const fallback = "I couldn't verify this on the live web. Please try again.";
          for (let iteration = 0; iteration < 16 && !answered; iteration++) {
            job.check();
            if (webTurn ? !webTurn.beforeModel() : nonWebModelAttempts++ >= 8) {
              const text = webTurn ? fallback : "I couldn't retrieve environment details right now. Please try again.";
              await publish(prose ? prose.push(text) : text);
              answered = true;
              break;
            }
            let decision: WebNativeDecision | null = null;
            let failure: CalendarFailure | null = null;
            // Every dispatch re-admits the raw canonical array and sends only the
            // smallest necessary projection; canonical state is never rewritten.
            const admitted = iteration === 0 ? preparedWeb!.initial : admit(messages);
            const request = { messages: admitted.messages, tools: textNativeTools, user: c.userId,
              modelId: snapshot.openRouter.modelId, maxOutputTokens: snapshot.budgets.maxOutputTokens,
              remainingContextTokens: admitted.remainingContextTokens,
              deadlineAt: new Date(Date.parse(e.turn.createdAt) + snapshot.budgets.totalRunTimeoutMs).toISOString(),
              signal: job.signal, dataCollection: 'deny' as const, advertised: Boolean(webTurn), envAdvertised: envToolCapable,
              memoryAllowed: memoryToolTurn?.allowed };
            let pendingBreak = iteration > 0;
            const webMode: TurnModelDispatch | undefined = turnMode ? {
              handle: turnMode, rawInput: e.turn.content,
              project: decision => {
                let userIndex = admitted.messages.length - 1;
                while (userIndex >= 0 && admitted.messages[userIndex]!.role !== 'user') userIndex--;
                if (userIndex < 0 || admitted.messages[userIndex]!.content !== e.turn.content)
                  throw new AppError('INVALID_REQUEST', 'The web request is invalid.', false);
                return projectTurnMessages(admitted.messages as unknown as ContextChatMessage[],
                  userIndex, readyContext as PositionedContext, decision);
              },
            } : undefined;
            for await (const chunk of dispatchStream(adapter, request, webMode)) {
              job.check();
              if (chunk.type === 'text-delta') {
                c.live?.modelOutput?.();
                let text = chunk.text;
                if (pendingBreak) {
                  text = separateAssistantContinuation(partial, text);
                  pendingBreak = false;
                }
                await publish(prose ? prose.push(text) : text);
              } else if (chunk.type === 'decision') decision = chunk.decision;
              else if (chunk.type === 'failure') failure = chunk.failure;
            }
            if (failure) {
              if (failure.category === 'cancelled') throw new AppError('CANCELLED', 'The response was cancelled.', false);
              throw new AppError('PROVIDER_ERROR', 'The model service could not answer.', false);
            }
            if (!decision) throw new AppError('INTERRUPTED', 'The response stream ended early.', false);
            if (turnMode?.frozen()?.mode === 'dev' && decision.kind !== 'text') {
              // Dev never repairs, validates, or executes a native web tool.
              await publish(prose ? prose.push(fallback) : fallback);
              answered = true;
              break;
            }
            if (decision.kind === 'text') {
              ended = true; length = decision.truncated;
              if (!partial) await publish(prose ? prose.push(decision.content) : decision.content);
              answered = true;
              break;
            }
            const previousReceipt = memoryToolTurn?.receipt();
            if (decision.kind === 'memory-invalid' || (previousReceipt
                && (decision.kind === 'update_user_memory' || decision.kind === 'memory-secret'))) {
              const text = memoryReceiptText(previousReceipt);
              await publish(prose ? prose.push(text) : text);
              answered = true; break;
            }
            if (decision.kind === 'update_user_memory' || decision.kind === 'memory-secret') {
              if (!memoryToolTurn) throw new AppError('PROVIDER_ERROR', 'Memory is unavailable.', false);
              job.check();
              const proof = memoryReceiptHeadroom(memoryCallId(decision));
              admit([...messages, proof.assistant, proof.result]);
              const remaining = Date.parse(request.deadlineAt) - Date.now();
              if (remaining <= 0) throw new AppError('TIMEOUT', 'The turn deadline has passed.', false);
              const signal = AbortSignal.any([job.signal, AbortSignal.timeout(remaining)]);
              const group = await job.track(memoryToolTurn.run(decision, signal));
              const receipt = memoryToolTurn.receipt();
              if (receipt?.ok && receipt.status === 'updated') e.memoryUpdated = true;
              job.check();
              messages = [...messages, group.assistant, group.result];
              continue;
            }
            if (decision.kind === 'env-invalid') {
              if (envRepairsUsed >= 2) {
                const text = "I couldn't format a valid environment request. Please try again.";
                await publish(prose ? prose.push(text) : text);
                answered = true;
                break;
              }
              envRepairsUsed += 1;
              messages = [...messages, { role: 'system', content: environmentRepairFeedback(decision.diagnostics) }];
              continue;
            }
            if (decision.kind === 'env-denied') {
              const text = "I couldn't check environment details right now. Please try again.";
              await publish(prose ? prose.push(text) : text);
              answered = true;
              break;
            }
            if (decision.kind === 'get_environment' && 'call' in decision) {
              if (envCallsUsed >= 4) {
                const text = "I couldn't retrieve environment details right now. Please try again.";
                await publish(prose ? prose.push(text) : text);
                answered = true;
                break;
              }
              envCallsUsed += 1;
              const executed = await executeEnvironmentTool({
                envelope: decision.envelope,
                now: new Date(this.runtime.now()),
                timeZone: e.clientTimeZone ?? this.d.calendar?.trustedTimeZone ?? 'Etc/UTC',
                savedLocation: extractSavedLocation(e.personalization),
                requestGeo: e.requestGeo ?? null,
                weatherProvider: this.weatherProvider(),
                signal: job.signal,
              });
              if (executed.weatherView) {
                presentWeather(executed.weatherView);
              }
              messages = [
                ...messages,
                { role: 'assistant', content: decision.assistantContent, tool_calls: [decision.call] },
                { role: 'tool', tool_call_id: decision.call.id, name: 'get_environment', content: JSON.stringify(executed.result) },
              ];
              continue;
            }
            if (!webTurn || (decision.kind !== 'web-invalid' && decision.kind !== 'web-denied' && decision.kind !== 'web_tool')) {
              throw new AppError('PROVIDER_ERROR', 'The model service could not answer.', false);
            }
            if (decision.kind === 'web-invalid') {
              const repair = webTurn.repair(decision.diagnostics, decision.call);
              if (!repair.retry) {
                const text = "I couldn't format a valid web request, so I couldn't verify this on the live web. Please try again.";
                await publish(prose ? prose.push(text) : text);
                answered = true;
                break;
              }
              messages = [...messages, { role: 'system', content: repair.feedback }];
              continue;
            }
            if (decision.kind === 'web-denied') {
              await publish(prose ? prose.push(fallback) : fallback);
              answered = true;
              break;
            }
            if (!webTurn || decision.kind !== 'web_tool') {
              throw new AppError('PROVIDER_ERROR', 'The model service could not answer.', false);
            }
            const executed = await webTurn.execute(decision, 0);
            if ('failure' in executed) {
              const failureGroup = webTurn.recordFailure(decision, executed.failure, 0);
              messages = [...messages, failureGroup.group.assistant, failureGroup.group.result];
              continue;
            }
            messages = [...messages, executed.group.assistant, executed.group.result];
          }
          if (!answered) {
            await publish(prose ? prose.push(fallback) : fallback);
          }
          if (prose) await publish(prose.finish());
          if (c.live && !liveFinished) { liveFinished = true; await c.live.finish(); }
          const assistant = messageRecordSchema.parse({ schemaVersion: 1, userId: c.userId,
            sessionId: c.sessionId, turnId: c.turnId, attemptId: c.attemptId, messageId: e.turn.outputMessageId,
            eventId: e.turn.outputEventId, sequence: input.assistantSequence, role: 'assistant', content: partial,
            createdAt: e.turn.createdAt, completionStatus: length ? 'truncated' : 'completed', truncated: length, mode: e.turn.mode,
            ...(e.turn.voice ? { visibility: 'internal' as const, voiceSessionId: e.turn.voice.voiceSessionId } : {}),
            ...(admittedArtifacts.length ? { canvasArtifacts: admittedArtifacts } : {}),
            ...(e.memoryUpdated ? { memoryUpdated: true } : {}) });
          bounded(messageRecordSchema, assistant, key('message', c.userId, c.sessionId, assistant.messageId), snapshot.budgets.maxMessageBytes);
          const accounting = e.accounting ?? { schemaVersion: 1, kind: 'accounting', userId: c.userId,
            sessionId: c.sessionId, turnId: c.turnId, attemptId: c.attemptId, generationId: null,
            requestedModel: snapshot.openRouter.modelId, reportedModel: null, reportedProvider: null,
            promptTokens: null, completionTokens: null, cost: null, accountingStatus: 'unknown',
            outcome: 'completed', startedAt: e.turn.createdAt, endedAt: null };
          e.accounting = accounting;
          return { input, assistant, accounting, base: boundaryFor(source.manifest),
            target: buildReferenceManifest(c.userId, c.sessionId, source.manifest.contextVersion + 1,
              [...source.records, assistant], this.d.assets, snapshot.budgets, source.manifest.activeSummaryRef,
              source.manifest.pinnedUserMemory), outcome: length ? 'truncated' : 'completed' };
        } });
        await graph.invoke({ input, sealed: false, result: null }, { signal: job.signal });
      } else {
        const services = createModelServices({ identity: { userId: e.turn.userId }, openRouter: snapshot.openRouter,
          budgets: { ...snapshot.budgets, maxMessageBytes: adapterMaxBytes } }, snapshot.modelLimits!,
        { putAccounting: async record => { e.accounting = record; } }, this.d.fetcher, Math.random, this.d.diagnostics?.emit);
        const adapter = services.createAttemptAdapter({ schemaVersion: 1, kind: 'accounting', userId: c.userId,
          sessionId: c.sessionId, turnId: c.turnId, attemptId: c.attemptId, generationId: null,
          requestedModel: snapshot.openRouter.modelId, reportedModel: null, reportedProvider: null,
          promptTokens: null, completionTokens: null, cost: null, accountingStatus: 'unknown',
          outcome: 'generating', startedAt: e.turn.createdAt, endedAt: null }, async () => {});
        const input = { attempt: this.attempt(e), assistantSequence: e.turn.sequence + 1 };
        // No checkpointer: each invocation owns only this turn. History is the trusted
        // foundation snapshot; no restored graph messages can duplicate it.
        const graph = buildTurnGraph(undefined, { prepare: async () => { job.check(); }, generate: async () => {
          c.live?.modelStarted?.();
          for await (const chunk of dispatchStream(adapter, { modelId: snapshot.openRouter.modelId, user: c.userId,
            messages: readyContext.messages, maxOutputTokens: snapshot.budgets.maxOutputTokens,
            abortSignal: job.signal, transforms: [], dataCollection: snapshot.openRouter.dataCollection }, modeDispatch)) {
            job.check();
            if (chunk.type === 'delta') { c.live?.modelOutput?.(); await publish(prose ? prose.push(chunk.text) : chunk.text); }
            if (chunk.type === 'usage') await job.wait(send(chunk), snapshot.budgets.idleStreamTimeoutMs);
            if (chunk.type === 'length') length = true;
            if (chunk.type === 'end') ended = true;
            if (chunk.type === 'error') throw new AppError('PROVIDER_ERROR', 'The model service could not answer.', false);
          }
          if (!ended || !e.accounting?.generationId) throw new AppError('INTERRUPTED', 'The response stream ended early.', false);
          if (prose) await publish(prose.finish());
          if (c.live && !liveFinished) { liveFinished = true; await c.live.finish(); }
          const assistant = messageRecordSchema.parse({ schemaVersion: 1, userId: c.userId,
            sessionId: c.sessionId, turnId: c.turnId, attemptId: c.attemptId, messageId: e.turn.outputMessageId,
            eventId: e.turn.outputEventId, sequence: input.assistantSequence, role: 'assistant', content: partial,
            createdAt: e.turn.createdAt, completionStatus: length ? 'truncated' : 'completed', truncated: length, mode: e.turn.mode,
            ...(e.turn.voice ? { visibility: 'internal' as const, voiceSessionId: e.turn.voice.voiceSessionId } : {}),
            ...(admittedArtifacts.length ? { canvasArtifacts: admittedArtifacts } : {}),
            ...(e.memoryUpdated ? { memoryUpdated: true } : {}) });
          bounded(messageRecordSchema, assistant, key('message', c.userId, c.sessionId, assistant.messageId), snapshot.budgets.maxMessageBytes);
          return { input, assistant, accounting: e.accounting, base: boundaryFor(source.manifest),
            target: buildReferenceManifest(c.userId, c.sessionId, source.manifest.contextVersion + 1,
              [...source.records, assistant], this.d.assets, snapshot.budgets, source.manifest.activeSummaryRef,
              source.manifest.pinnedUserMemory), outcome: length ? 'truncated' : 'completed' };
        } });
        await graph.invoke({ input, sealed: false, result: null }, { signal: job.signal });
      }
      job.check(); e.status = 'finalizing';
      if (e.native?.loop.memoryWasUpdated()) e.memoryUpdated = true;
      e.status = length ? 'truncated' : 'completed';
      if (!c.live) {
        if (promotedSeal) await this.publishPromoted(e, promotedSeal, partial, admittedArtifacts);
        else this.finish(e, partial, e.status);
      }
    } catch (error) {
      const failure = job.signal.aborted ? job.failure() : error instanceof AppError ? error
        : new AppError('PROVIDER_ERROR', 'The model service could not answer.', false);
      diagnose(this.d.diagnostics?.emit, {
        stage: 'runtime-error',
        state: 'error',
        code: failure.code,
        failureKind: error instanceof AppError ? 'application' : error instanceof TypeError ? 'type'
          : error instanceof Error && error.name === 'ZodError' ? 'validation' : 'unexpected',
      });
      if (e.native?.promotion?.attempt && (e.native.promotion.ready || failure.code !== 'PERSISTENCE_ERROR')) {
        try {
          if (!promotedSeal) await this.runtime.interruptOwned(e.native.promotion.lease, job, e.native.promotion.attempt!, partial, failure, admittedArtifacts, e.turn.sequence + 1, e.calendarView);
          await this.d.persistence.owner.release(e.native.promotion.lease);
          reconcilePrefix = !e.native.promotion.ready;
        }
        catch { this.runtime.work.degraded = true; }
        this.sessions.get(e.turn.sessionId)!.stale = true;
        e.status = 'interrupted'; e.error = failure;
      } else if (!this.foundation.result(e.turn)) {
        e.status = failure.code === 'CANCELLED' ? 'cancelled' : ['INTERRUPTED', 'TIMEOUT'].includes(failure.code) ? 'interrupted' : 'failed';
        e.error = failure;
        if (failure.code === 'PERSISTENCE_ERROR' && e.native) e.native.pending = true;
        else if (!c.live) this.finish(e, partial, e.status, failure);
      }
    } finally {
      try {
        if (c.live) {
          try { if (started) await c.live.settle(partial, e.error && !partial ? AbortSignal.abort() : job.signal); }
          catch (error) { settlementError = error; }
          if (!e.delivery || e.delivery.status === 'pending' || e.delivery.textGenerated !== partial)
            e.delivery = this.unknownDelivery(e.turn, partial);
          if (promotedSeal && !e.error) {
            try { await this.publishPromoted(e, promotedSeal, partial, admittedArtifacts); }
            catch (error) { settlementError = error; this.sessions.get(e.turn.sessionId)!.stale = true; }
          } else if (!e.native?.pending && !this.sessions.get(e.turn.sessionId)?.stale)
            this.finish(e, partial, e.status as MemoryTerminal['status'], e.error);
        }
      } finally {
        await job.settled(); job.close(); e.running = false;
        if (mutationBarrier?.paused) {
          mutationBarrier.paused = false;
          if (!this.foundation.session(e.turn.sessionId).fenced) {
            this.foundation.resumeSession(e.turn);
          }
        }
      }
    }
    if (reconcilePrefix) await this.reconcilePromoted(c.sessionId);
    if (settlementError) throw settlementError;
    const learned = this.foundation.result(e.turn);
    if (learned && (e.status === 'completed' || e.status === 'truncated')) {
      this.runtime.recordMemoryTurn(this.sessions.get(c.sessionId)?.session, learned.input, learned.output,
        learned.version, turnMode, learned.delivery, Boolean(e.native || e.web), c.localToolControl);
    }
    // Release the generation slot before terminal publication; save promises belong
    // solely to the app-owned foundation and cannot delay this boundary.
    try {
      const usage = !c.live ? this.compactionState(c.userId, c.sessionId) : null;
      if (!c.live && usage?.contextUsage)
        await send({ type: 'context-state', contextUsage: usage.contextUsage,
          ...(usage.compaction ? { compaction: usage.compaction } : {}) });
      await send({ type: 'status', status: e.status, truncated: e.status === 'truncated', save: this.status(c.userId, c.sessionId, c.turnId)?.save });
      if (e.status === 'completed' || e.status === 'truncated')
        await send({ type: 'completed', outcome: e.status, assistantMessageId: e.turn.outputMessageId,
          save: this.status(c.userId, c.sessionId, c.turnId)!.save,
          ...(this.foundation.result(e.turn)?.output.calendarView
            ? { calendarView: this.foundation.result(e.turn)!.output.calendarView } : {}),
          ...(this.foundation.result(e.turn)?.output.weatherView
            ? { weatherView: this.foundation.result(e.turn)!.output.weatherView } : {}),
          ...(this.foundation.result(e.turn)?.output.memoryUpdated ? { memoryUpdated: true } : {}),
          ...(!c.live && usage?.compaction ? { compaction: usage.compaction } : {}),
          ...(!c.live && usage?.contextUsage ? { contextUsage: usage.contextUsage } : {}) });
      else if (e.error) await send({ type: 'error', ...e.error.toClientBody() });
    } catch { /* Same-process status/replay retains the honest terminal outcome. */ }
    if ((e.status === 'completed' || e.status === 'truncated')) {
      const snap = this.d.currentConfig?.current();
      if (snap) {
        try { this.scheduleCompactionIfNeeded(c.sessionId, snap); }
        catch { /* Compaction is best-effort and must not fail the turn. */ }
      }
    }
    return true;
  }
}
