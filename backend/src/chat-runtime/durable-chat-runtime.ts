/**
 * ============================================================================
 * FILE: durable-chat-runtime.ts
 * LOCATION: backend/src/chat-runtime/durable-chat-runtime.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Accept, execute, retry, cancel, and reconcile durable LangGraph turns.
 *
 * ROLE IN PROJECT:
 *    Owns P5 request lifecycle: persist acceptance before inference, stream
 *    honest events, publish sealed results, and recover without model replay.
 *
 * KEY COMPONENTS:
 *    - submitTurn: Idempotent acceptance that retains the active attempt slot.
 *    - executeTurn: One request-owned generation and application finalization.
 *    - retry/cancel/reconcile: Explicit retry, cancellation, and quiescent repair.
 *    - The untrusted Calendar reply reference is carried, bound and compared.
 * ============================================================================
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ExecutionLease, ExecutionOwnership } from '../contracts/repositories.js';
import type { RetryTurnCommand, CancelTurnCommand } from '../contracts/runtime.js';
import {
  defaultPersonalizationSettings,
  type UserPersonalizationSettings,
} from '../contracts/personalization.js';
import type { CalendarReplyReference } from '../contracts/calendar-authority.js';
import type { CalendarAccountBinding } from '../contracts/calendar-discovery.js';
import type { SessionRecord } from '../contracts/session.js';
import { UPDATE_USER_MEMORY_TOOL_NAME, updateUserMemoryReceiptSchema }
  from '../contracts/user-memory.js';
import { UserMemoryFault } from '../personalization/errors.js';
import type { AttemptRecord } from '../contracts/attempt.js';
import type { AccountingRecord } from '../contracts/metadata.js';
import { messageRecordSchema, type MessageRecord } from '../contracts/message.js';
import type { ConfirmedRecord } from '../persistence/confirmed-record.js';
import type { AcceptanceRecord } from '../persistence/ownership.js';
import { submitTurnRequestSchema, retryTurnRequestSchema, turnStatusResponseSchema, hasCanvasContent, type SubmitTurnResponse } from '../contracts/api.js';
import { resolvedIdentitySchema } from '../contracts/identity.js';
import { streamEnvelopeSchema, type StreamEvent } from '../contracts/stream.js';
import { graphThreadId } from '../persistence/index.js';
import { cursor } from '../persistence/pagination.js';
import { bounded, key } from '../persistence/records.js';
import { defaultEnvironmentContext, validateInput } from '../context/context-budget.js';
import { buildReferenceManifest } from '../context/index.js';
import { projectTurnMessages, type PositionedContext }
  from '../context/referenced-context-assembler.js';
import { selectReferences } from '../context/reference-selection.js';
import { calendarHistory } from './calendar-history.js';
import { hashPayload } from '../platform/crypto/hash-payload.js';
import { normalizeTimeZone, type RequestGeoHint } from '../platform/environment/request-environment.js';
import {
  OpenMeteoWeatherProvider, executeEnvironmentTool, extractSavedLocation, type WeatherProvider,
} from '../environment/index.js';
import { AppError } from '../platform/errors/app-error.js';
import { buildTurnGraph } from '../agent/turn-graph.js';
import { boundaryFor, calendarCursorSchema, calendarSealSchema, resultSchema, rebaseSchema, type GraphInput, type SavedResult } from '../agent/state.js';
import { createModelServices, type ModelConfig } from '../model/index.js';
import { CALENDAR_LIMITS } from '../contracts/calendar-policy.js';
import { CALENDAR_TOMBSTONE } from '../contracts/calendar-sources.js';
import { CalendarTurnLedger } from './calendar-budget.js';
import { isCalendarV2, asCalendarAccountingPort } from './calendar-ports.js';
import { CalendarLoop } from './calendar-loop.js';
import { ownedCanvasInventory, ownedCanvasSelection, navigateCanvas, controlCanvas } from './canvas-navigation.js';
import type { CanvasInventorySnapshot, CanvasSelection } from '../contracts/canvas-navigation.js';
import { projectCalendarTurnStateCompatible, publishCalendarTurn } from './calendar-publication.js';
import { repairOperationEventV2 } from './calendar-operation.js';
import {
  pendingCalendarOperation,
  reconcileCalendarOperation,
  reconcileCalendarOperationV2,
  reconcileConsumedProposalWithoutOperation,
  reconcilePlannedCalendarOperationV2,
} from './calendar-recovery.js';
import type { ExecutionReservation, VoiceDeliveryRecord } from '../contracts/voice.js';
import type { AgentMemoryManifest, MessageRef } from '../contracts/agent-memory.js';
import {
  AdmissionReceiptStore,
  isPinnedCheckpointId,
  mergeAdmissionSourceRecords,
  type AdmissionReceipt,
} from './admission-receipt.js';
import { ConfirmedStateCache, type ConfirmedSessionState } from './confirmed-state-cache.js';
import type { AssembledContext, ContextAssembler, ContextSourceSnapshot, EnvironmentContext, ResponseMode } from '../contracts/context.js';
import type { ContextChatMessage } from '../contracts/context.js';
import type { CalendarCompatibleTurnState, CalendarCompatibleEnvelope } from './ports.js';
import { diagnose, type RuntimeDependencies, type ExecuteTurn, type SubmitLiveTurn, type AttemptStreamBudgets, type DiagnosticScope, type SubmitTurnCommand, type MemoryToolTurn, type ReviseTurnCommand } from './ports.js';
import { UserMemoryScheduler, type PassiveTurn } from './user-memory-scheduler.js';
import { createTurnModelMode, dispatchStream, type TurnModeHandle, type TurnModelDispatch } from './turn-model-mode.js';
import type { RuntimeConfigSnapshot } from '../contracts/config-runtime.js';
import { acceptedHistory, attemptsFor, latestAttempt } from './history.js';
import { sessionIdFor, attemptIdFor, turnIdFor, inputId, outputId, eventIdFor, titleFor, responseFor } from './identity.js';
import { WorkRegistry, type StreamQuiesceResult, type StreamReservation, type Work } from './work.js';
import { graphConfig, transition, terminal, publishResult, advanceAttempt, type LivePublicationEvidence } from './finalization.js';
import { interruptAttempt, finishRebase, hasPendingVoiceDelivery, reconcileVoiceDeliveries } from './reconciliation.js';
import { ExecutionReservations } from './execution-reservations.js';
import { boundedResult } from '../operations/bounded.js';
import { SpeechProse } from '../voice/agent/speech-prose.js';
import { MemoryText, DurableHistoryRequired } from './memory-text.js';
import type { MemoryCapacity } from './memory-first-foundation.js';
import { CANVAS_ARTIFACT_LIMITS, isCanvasArtifactProjectionList,
  type CanvasArtifactProjection, type CanvasArtifactSource } from '../contracts/voice-wire.js';
import { createWebNativeModelPort, memoryCallId, memoryReceiptHeadroom, memoryReceiptText, memoryToolPair,
  type WebNativeDecision, type WebNativeMessage } from '../model/web-native.js';
import { admitNativePrompt } from '../context/web-context.js';
import { UPDATE_USER_MEMORY_TOOL_DEFINITION } from '../contracts/user-memory.js';
import { identifier, mergeUsage } from '../model/accounting.js';
import { object } from '../model/faults.js';

/**
 * The reply reference of one submit command, as the untrusted client sent it.
 *
 * `SubmitTurnCommand.calendarReplyTo` is optional, so an ordinary text turn
 * simply carries no reference and the runtime treats it as a plain message.
 */
function replyReferenceOf(command: SubmitTurnCommand): CalendarReplyReference | undefined {
  return command.calendarReplyTo;
}

function snapshotCheckpointId(source: {
  config?: { configurable?: { checkpoint_id?: unknown } };
  configurable?: { checkpoint_id?: unknown };
}): string {
  const id = source.configurable?.checkpoint_id ?? source.config?.configurable?.checkpoint_id;
  return typeof id === 'string' ? id : '';
}

export function activityUpdatedByFinishCommitment(input: {
  live: boolean;
  finishAttempt: unknown;
  attemptReceipt: unknown;
  compareAttemptConfirmed: unknown;
}): true | undefined {
  if (
    !input.live
    && typeof input.finishAttempt === 'function'
    && input.attemptReceipt
    && typeof input.compareAttemptConfirmed === 'function'
  ) {
    return true;
  }
  return undefined;
}

export class DurableChatRuntime {
  readonly work: WorkRegistry;
  readonly reservations: ExecutionReservations;
  readonly stoppedOwners = new Set<string>();
  readonly userMemoryScheduler?: UserMemoryScheduler;
  private readonly memoryOwners = new Map<string, MemoryText>();
  private readonly epoch = randomUUID();
  private accepting = new Map<string, { hash: string; promise: Promise<SubmitTurnResponse> }>();

  // ponytail: bounded pending-attempt secret retention, 1024 bindings maximum; future durable nonsecret provenance/credential-version design must precede restart-resumable inference.
  private readonly attemptSettings = new Map<string, RuntimeConfigSnapshot>();
  private readonly attemptPersonalization = new Map<string, UserPersonalizationSettings>();
  private readonly attemptTimeZone = new Map<string, string>();
  private readonly attemptRequestGeo = new Map<string, RequestGeoHint>();
  private defaultWeatherProvider: WeatherProvider | null = null;
  private readonly attemptIdentities = new Map<string, Readonly<import('../contracts/identity.js').ResolvedIdentity>>();
  private readonly attemptCalendar = new Map<string, { createdAt: string; deadlineAt: string }>();
  private readonly receipts = new AdmissionReceiptStore();
  private readonly confirmedState = new ConfirmedStateCache();
  private readonly sessionCalendarMessages = new Map<string, {
    hasCalendarHistory: boolean;
    calendarMessageIds: Set<string>;
  }>();
  private readonly sessionGraphEpoch = new Map<string, number>();
  private readonly freshLiveSubmissions = new Map<string, number>();
  /** Bounded in-memory live-turn markers so public stream probes never read storage. */
  private readonly liveTurnKeys = new Set<string>();
  private readonly purging = new Map<string, { promise: Promise<boolean>; explicit: boolean }>();
  private readonly purgedUntil = new Map<string, number>();
  private readonly executing = new Map<string, Set<Promise<void>>>();

  private sessionKey(userId: string, sessionId: string) { return JSON.stringify([userId, sessionId]); }
  private evictCalendarCacheEntry(key: string): void {
    this.sessionCalendarMessages.delete(key);
    const [owner, session] = JSON.parse(key) as [string, string];
    this.confirmedState.delete(owner, session);
  }
  private trackCalendarMessage(userId: string, sessionId: string, messageId: string): void {
    const key = this.sessionKey(userId, sessionId);
    let entry = this.sessionCalendarMessages.get(key);
    if (!entry) {
      if (this.sessionCalendarMessages.size >= 1024) {
        const first = this.sessionCalendarMessages.keys().next().value;
        if (first) this.evictCalendarCacheEntry(first);
      }
      entry = { hasCalendarHistory: true, calendarMessageIds: new Set<string>() };
      this.sessionCalendarMessages.set(key, entry);
    }
    entry.hasCalendarHistory = true;
    entry.calendarMessageIds.add(messageId);
  }

  private trackCleanSession(userId: string, sessionId: string): void {
    const key = this.sessionKey(userId, sessionId);
    if (!this.sessionCalendarMessages.has(key)) {
      if (this.sessionCalendarMessages.size >= 1024) {
        const first = this.sessionCalendarMessages.keys().next().value;
        if (first) this.evictCalendarCacheEntry(first);
      }
      this.sessionCalendarMessages.set(key, {
        hasCalendarHistory: false,
        calendarMessageIds: new Set<string>(),
      });
    }
  }

  private isCalendarOrUncertain(userId: string, sessionId: string, record: MessageRecord): boolean {
    if (Boolean(record.sourceProvenance?.length) || record.content === CALENDAR_TOMBSTONE) {
      return true;
    }
    if (!this.d.calendarFor && !this.d.calendar) {
      return false;
    }
    const entry = this.sessionCalendarMessages.get(this.sessionKey(userId, sessionId));
    if (!entry) {
      // Classification is unavailable / uncertain (evicted, restarted, reconciled, or rebased).
      // Fail closed: assistant records must refresh; user records are never redacted.
      return record.role === 'assistant';
    }
    if (entry.calendarMessageIds.has(record.messageId)) {
      return true;
    }
    if (entry.hasCalendarHistory && record.role === 'assistant') {
      return true;
    }
    return false;
  }

  private isCalendarMessage(userId: string, sessionId: string, record: MessageRecord): boolean {
    return this.isCalendarOrUncertain(userId, sessionId, record);
  }
  memoryFor(userId: string, create = false): MemoryText | null {
    if (!this.d.memoryFirst) return null;
    const found = this.memoryOwners.get(userId);
    if (found || !create) return found ?? null;
    // ponytail: at most 32 admitted owner compartments/process; restart or add
    // quiescent eviction if a larger installation needs more resident owners.
    if (this.memoryOwners.size >= 32) throw new AppError('CONCURRENCY_LIMIT', 'Chat capacity is unavailable.');
    const memory = new MemoryText(this, this.dependenciesFor(userId), userId, this.epoch,
      { otherCapacity: () => this.otherMemoryCapacity(userId),
        onSaveSettled: () => {
          for (const [owner, peer] of this.memoryOwners) if (owner !== userId) peer.foundation.pumpSaves();
        } });
    this.memoryOwners.set(userId, memory);
    return memory;
  }
  /** RAM-only eligibility: unwarmed or failed cache denies tool advertisement/learning. */
  memoryEnabled(u: string): boolean {
    const memory = this.d.userMemory?.cache.cachedMemory(u);
    return memory === null || memory?.enabled === true;
  }
  /**
   * One attempt-scoped explicit memory executor. The checked store CAS in the
   * writer is the commit; no external barrier or archive wait is added.
   */
  explicitMemory(session: SessionRecord | null | undefined, turnId: string,
    snapshot: RuntimeConfigSnapshot, mode: TurnModeHandle | undefined, localControl?: boolean): MemoryToolTurn | undefined {
    const memory = this.d.userMemory;
    if (!memory || !session || session.ephemeral || session.lifecycle !== 'active' ||
        localControl || snapshot.modelLimits?.tools !== true) return undefined;
    const { userId, sessionId } = session;
    let receipt: ReturnType<typeof updateUserMemoryReceiptSchema.parse> | null = null;
    const eligible = () => mode?.current()?.mode !== 'dev' && this.memoryEnabled(userId);
    return {
      // Eligibility excludes live storage. Recheck after the first model decision.
      allowed: () => receipt === null && eligible(),
      receipt: () => receipt,
      async run(candidate, signal) {
        signal.throwIfAborted();
        if (!receipt) {
          if (!eligible()) receipt = { ok: false, error: { code: 'MEMORY_DISABLED', retryable: false } };
          else if (candidate.kind === 'memory-secret')
            receipt = { ok: false, error: { code: 'SECRET_REJECTED', retryable: false } };
          else {
            try {
              const edit = await memory.writer.applyInstruction(userId, candidate.envelope.instruction,
                { source: 'tool', sessionId, turnId, signal });
              receipt = { ok: true, status: edit.changed ? 'updated' : 'no_change', summary: edit.changeSummary };
            } catch (error) {
              const fault = error instanceof UserMemoryFault ? error : null;
              const code = fault?.secretRejected ? 'SECRET_REJECTED' : fault?.code === 'MEMORY_DISABLED' ? 'MEMORY_DISABLED'
                : fault?.code === 'PERSISTENCE_ERROR' || fault?.code === 'MEMORY_CONFLICT' ? 'PERSISTENCE_ERROR'
                : 'WRITER_UNAVAILABLE';
              receipt = { ok: false, error: { code, retryable: fault?.retryable ?? false } };
            }
          }
        }
        return memoryToolPair(memoryCallId(candidate), receipt);
      },
    };
  }
  /**
   * Queue one trusted finalized turn for passive learning. Scheduling is
   * constant-bounded RAM bookkeeping; writer I/O stays in the idle timer.
   */
  recordMemoryTurn(session: SessionRecord | null | undefined, input: MessageRecord,
    output: MessageRecord, version: number, mode: TurnModeHandle | undefined,
    delivery: VoiceDeliveryRecord | null | undefined, toolDerived = false, localToolControl = false): void {
    if (!this.userMemoryScheduler || !session || session.lifecycle !== 'active' ||
        session.ephemeral || localToolControl || (mode?.frozen() ?? mode?.current())?.mode === 'dev' ||
        !['completed', 'truncated'].includes(output.completionStatus)) return;
    const heard = output.mode === 'live' || input.mode === 'live';
    this.userMemoryScheduler.completed(session.userId, session.sessionId,
      session.memoryWatermarkSequence ?? -1, {
        turnId: output.turnId, messageId: output.messageId, sequence: output.sequence, version,
        userText: input.content,
        assistantText: toolDerived || output.sourceProvenance?.length || output.calendarView ||
          output.webSources?.length || output.webActivities?.length || output.weatherView
          ? '' : heard ? delivery?.textSpoken ?? '' : output.content,
      });
  }
  /** Off-path enqueue for the older durable path; records arrive after terminal publication. */
  private recordDurableMemory(session: SessionRecord | null | undefined, u: string, s: string, a: AttemptRecord,
    delivery: VoiceDeliveryRecord | null | undefined, mode: TurnModeHandle | undefined): void {
    if (!this.userMemoryScheduler) return;
    const load = session ? Promise.resolve(session) : this.d.persistence.sessions.get(u, s);
    void load.then(async row => {
      const [input, output] = await Promise.all([
        this.d.persistence.messages.get(u, s, a.causal.userMessageId),
        this.d.persistence.messages.get(u, s, outputId(a)),
      ]);
      if (input && output) this.recordMemoryTurn(row, input, output, 0, mode, delivery);
    }).catch(() => undefined);
  }
  private calendarFor(userId: string) { return this.d.calendarFor?.(userId) ?? this.d.calendar; }
  private configFor(userId: string) { return this.d.configFor?.(userId) ?? this.d.currentConfig?.current() ?? null; }
  private personalizationFor(userId: string): UserPersonalizationSettings {
    return { ...(this.d.personalizationFor?.(userId) ?? defaultPersonalizationSettings()) };
  }
  private weatherProvider(): WeatherProvider {
    if (this.d.weatherProvider) return this.d.weatherProvider;
    this.defaultWeatherProvider ??= new OpenMeteoWeatherProvider({ fetcher: this.d.fetcher ?? fetch });
    return this.defaultWeatherProvider;
  }
  private dependenciesFor(userId: string): RuntimeDependencies {
    return { ...this.d, calendar: this.calendarFor(userId),
      currentConfig: { current: () => this.configFor(userId) } };
  }
  private otherMemoryCapacity(userId: string): MemoryCapacity {
    const total: MemoryCapacity = { sessions: 0, reservedMemoryBytes: 0,
      pending: 0, reservedBacklogBytes: 0, unresolvedWrites: 0 };
    for (const [owner, memory] of this.memoryOwners) if (owner !== userId) {
      const s = memory.foundation.snapshot();
      for (const key of Object.keys(total) as (keyof MemoryCapacity)[]) total[key] += s[key];
    }
    return total;
  }
  private attemptKey(u: string, s: string, a: string) {
    return JSON.stringify([u, s, a]);
  }
  private inPhase<T>(databasePhase: NonNullable<DiagnosticScope['databasePhase']>, work: () => T): T {
    return this.d.diagnostics ? this.d.diagnostics.run({ databasePhase }, work) : work();
  }
  private captureTextSettings(userId: string): RuntimeConfigSnapshot {
    const snapshot = this.configFor(userId);
    if (!snapshot || !snapshot.openRouter.apiKey || !snapshot.openRouter.modelId ||
        !snapshot.modelLimits || snapshot.modelLimits.modelId !== snapshot.openRouter.modelId) {
      throw new AppError('NOT_READY', 'Chat configuration is unavailable.');
    }
    return snapshot;
  }
  private assemblerFor(snapshot: RuntimeConfigSnapshot): ContextAssembler {
    if (!this.d.assembler.forBudgets) {
      throw new AppError('NOT_READY', 'Chat context is unavailable.');
    }
    return this.d.assembler.forBudgets(snapshot.budgets);
  }
  attemptStreamBudgets(userId: string, sessionId: string, attemptId: string): AttemptStreamBudgets {
    const memory = this.memoryFor(userId)?.attemptBudgets(userId, sessionId, attemptId); if (memory) return memory;
    const bound = this.attemptSettings.get(this.attemptKey(userId, sessionId, attemptId));
    return {
      idleStreamTimeoutMs: bound?.budgets.idleStreamTimeoutMs ?? this.d.config.budgets.idleStreamTimeoutMs,
      maxMessageBytes: bound?.budgets.maxMessageBytes ?? this.d.config.budgets.maxMessageBytes,
    };
  }
  constructor(readonly d: RuntimeDependencies) {
    if (d.config.topology.executor !== 'single-process') throw new AppError('UNSUPPORTED_TOPOLOGY', 'Only one executor is supported.');
    this.work = new WorkRegistry(() => {
      const snap = this.d.currentConfig?.current() ?? null;
      return snap?.budgets.maxConcurrentGenerationsPerProcess ?? this.d.config.budgets.maxConcurrentGenerationsPerProcess ?? 1;
    });
    this.reservations = new ExecutionReservations(async (u, s) => {
      const memory = this.memoryFor(u, true);
      if (memory?.eligibleVoice())
        return Boolean(this.work.get(u, s) || (memory.owns(s) && memory.foundation.session(s).activeAttemptId));
      if (memory?.busy(s)) return true;
      memory?.handoff(s);
      if (this.work.get(u, s)) return true;
      const session = await d.persistence.sessions.get(u, s);
      return Boolean(this.work.get(u, s) || session?.execution.ownerId || session?.execution.activeAttemptId);
    }, async (u, s) => {
      if (this.memoryFor(u, true)?.eligibleVoice()) await this.prepareSession(u, s);
    });
    if (d.userMemory) {
      this.userMemoryScheduler = new UserMemoryScheduler({
        enabled: u => this.memoryEnabled(u),
        synthesize: (u, delta, scope) => d.userMemory!.writer.synthesize(u, delta, scope),
        publish: (u, s, last, changed, signal, mark = last) => {
          const write = async () => {
            signal.throwIfAborted();
            const owner = this.memoryFor(u);
            if (owner?.owns(s) && last.version !== 0)
              await owner.foundation.flushSession(s, last.version);
            await d.persistence.owner.assertExecutor();
            signal.throwIfAborted();
            if (changed) {
              await d.persistence.messages.markMemoryUpdated(u, s, mark.messageId);
              if (!signal.aborted) owner?.projectPassiveMarker(s, mark.messageId);
            }
            signal.throwIfAborted();
            await d.persistence.sessions.advanceMemoryWatermark(u, s, last.sequence);
            if (!signal.aborted) owner?.projectMemoryWatermark(s, last.sequence);
          };
          return d.userMemory!.trackWrite ? d.userMemory!.trackWrite(write) : write();
        },
        report: d.diagnostics?.emit,
      });
    }
  }
  now() { return new Date((this.d.now ?? Date.now)()).toISOString(); }
  private environmentContext(userId: string, clientTimeZone?: string | null): EnvironmentContext {
    return defaultEnvironmentContext(
      new Date(this.now()),
      normalizeTimeZone(clientTimeZone) ?? this.calendarFor(userId)?.trustedTimeZone ?? 'Etc/UTC',
    );
  }
  identity(value: SubmitTurnCommand['identity']) {
    const id = resolvedIdentitySchema.parse(value);
    if (id.source !== 'authenticated-session' || id.openRouterUser !== id.userId)
      throw new AppError('IDENTITY_OVERRIDE_REJECTED', 'Identity is resolved by the server.');
    return Object.freeze({ ...id });
  }
  ready() {
    if (!this.work.accepting || this.work.degraded) throw new AppError('NOT_READY', 'Chat is not accepting work.');
  }
  private joinAcceptance(key: string, hash: string, action: () => Promise<SubmitTurnResponse>) {
    const existing = this.accepting.get(key);
    if (existing) {
      if (existing.hash !== hash) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This request identity has different input.');
      return existing.promise;
    }
    const maxAcceptance = this.d.currentConfig?.current()?.budgets.maxConcurrentGenerationsPerProcess ?? this.d.config.budgets.maxConcurrentGenerationsPerProcess;
    if (this.accepting.size >= maxAcceptance)
      throw new AppError('CONCURRENCY_LIMIT', 'Too many chat requests are active.');
    const promise = Promise.resolve().then(action);
    this.accepting.set(key, { hash, promise });
    void promise.then(() => this.accepting.delete(key), () => this.accepting.delete(key));
    return promise;
  }
  /**
   * The Calendar proposal store, when this deployment runs the Calendar runtime.
   * A text-only deployment has no Calendar store at all.
   */
  private proposalStore() {
    if (this.d.calendarFor) return this.d.persistence.calendarProposals;
    const cal = this.d.calendar;
    if (!cal || !isCalendarV2(cal)) return null;
    return this.d.persistence.calendarProposals;
  }

  submitTurn(c: SubmitTurnCommand) {
    try {
      const identity = this.identity(c.identity); this.ready();
      const command: SubmitTurnCommand = { ...c, clientTimeZone: normalizeTimeZone(c.clientTimeZone) };
      const body = submitTurnRequestSchema.parse({ sessionId: command.sessionId, content: command.content, idempotencyKey: command.idempotencyKey, calendarReplyTo: replyReferenceOf(command), expectedEpoch: command.expectedEpoch, ephemeral: command.ephemeral });
      if (body.expectedEpoch !== undefined && body.expectedEpoch !== this.processEpoch())
        throw new AppError('INTERRUPTED', 'This request belongs to an earlier server session; its outcome is unknown.', false);
      if (body.sessionId !== null && body.ephemeral !== undefined)
        throw new AppError('INVALID_REQUEST', 'Temporary mode is selected when starting a conversation.');
      const session = sessionIdFor(identity.userId, body.sessionId, body.idempotencyKey);
      this.assertConversationAdmission(identity.userId, session);
      this.reservations.assertText(identity.userId, session);
      const memory = this.d.memoryFirst ? this.memoryFor(identity.userId, true) : null;
      if (memory && (memory.hasRequest(session, command.idempotencyKey) || memory.eligible()))
        return this.joinAcceptance(JSON.stringify([identity.userId, session, command.idempotencyKey]),
          hashPayload(JSON.stringify(['submit', body.content, body.calendarReplyTo ?? null, body.ephemeral === true])), () => memory.submit(command)
            .catch(error => { if (error instanceof DurableHistoryRequired) return this.acceptNewTurn(command); throw error; }));
      memory?.handoff(session);
      return this.joinAcceptance(JSON.stringify([identity.userId, session, command.idempotencyKey]),
        hashPayload(JSON.stringify(['submit', body.content, body.calendarReplyTo ?? null, body.ephemeral === true])), () => {
          const scope = { sessionId:session, turnId:turnIdFor(identity.userId, session, body.idempotencyKey),
            attemptId:attemptIdFor(identity.userId, session, body.idempotencyKey), databasePhase:'admission' as const };
          return this.d.diagnostics ? this.d.diagnostics.run(scope, () => this.acceptNewTurn(command)) : this.acceptNewTurn(command);
        });
    } catch (error) { return Promise.reject(error); }
  }
  submitLiveTurn(c: SubmitLiveTurn) {
    try {
      const identity = this.identity(c.identity); this.ready();
      const command: SubmitLiveTurn = { ...c, clientTimeZone: normalizeTimeZone(c.clientTimeZone) };
      const body = submitTurnRequestSchema.parse({ sessionId: command.sessionId, content: command.content, idempotencyKey: command.idempotencyKey, calendarReplyTo: replyReferenceOf(command), ephemeral: command.ephemeral });
      const s = sessionIdFor(identity.userId, body.sessionId, body.idempotencyKey);
      this.assertConversationAdmission(identity.userId, s);
      if (body.sessionId !== null && body.ephemeral !== undefined &&
          (command.freshConversation !== true || body.ephemeral !== true))
        throw new AppError('INVALID_REQUEST', 'Temporary mode is selected when starting a conversation.');
      this.reservations.assertLive(command.reservation, identity, s);
      const liveMemory = this.d.memoryFirst ? this.memoryFor(identity.userId, true) : null;
      if (liveMemory?.eligibleVoice() && command.voice)
        return this.joinAcceptance(JSON.stringify([identity.userId, s, command.idempotencyKey]),
          hashPayload(JSON.stringify(['memory-live', body.content, body.calendarReplyTo ?? null, command.voice, body.ephemeral === true])), () => liveMemory.submit(command, undefined, command)
            .catch(error => { if (error instanceof DurableHistoryRequired) return this.acceptNewTurn(command, command.reservation); throw error; }));
      return this.joinAcceptance(JSON.stringify([identity.userId, s, command.idempotencyKey]),
        hashPayload(JSON.stringify(['submit-live', body.content, body.calendarReplyTo ?? null, body.ephemeral === true])), () => {
          const scope = { sessionId:s, turnId:turnIdFor(identity.userId, s, body.idempotencyKey),
            attemptId:attemptIdFor(identity.userId, s, body.idempotencyKey), databasePhase:'admission' as const };
          return this.d.diagnostics ? this.d.diagnostics.run(scope, () => this.acceptNewTurn(command, command.reservation)) : this.acceptNewTurn(command, command.reservation);
        });
    } catch (error) { return Promise.reject(error); }
  }
  /**
   * Edit or regenerate the latest turn. One `revise` entry (MemoryText.revise) serves both kinds; the
   * durable-only fallback does not implement supersession yet, so it refuses instead of forking a path.
   * ponytail: durable-only chats (calendar v1, history too large for memory) cannot edit or regenerate; the
   * upgrade is a manifest rebase through checkBoundary plus a staged superseding record in acceptRetry.
   */
  reviseTurn(c: ReviseTurnCommand) {
    try {
      const identity = this.identity(c.identity); this.ready();
      const command: ReviseTurnCommand = { ...c, clientTimeZone: normalizeTimeZone(c.clientTimeZone) };
      if (command.expectedEpoch !== undefined && command.expectedEpoch !== this.processEpoch())
        throw new AppError('INTERRUPTED', 'This request belongs to an earlier server session; its outcome is unknown.', false);
      this.reservations.assertText(identity.userId, command.sessionId);
      this.assertConversationAdmission(identity.userId, command.sessionId);
      const memory = this.d.memoryFirst ? this.memoryFor(identity.userId, true) : null;
      if (!memory || !(memory.hasRequest(command.sessionId, command.idempotencyKey) || memory.eligible()))
        throw new AppError('NOT_READY', 'This chat cannot be edited or regenerated right now.', false);
      return this.joinAcceptance(JSON.stringify([identity.userId, command.sessionId, command.idempotencyKey]),
        hashPayload(JSON.stringify([command.kind, command.turnId, command.content ?? null])), () => memory.revise(command)
          .catch(error => {
            if (error instanceof DurableHistoryRequired)
              throw new AppError('NOT_READY', 'This chat cannot be edited or regenerated right now.', false);
            throw error;
          }));
    } catch (error) { return Promise.reject(error); }
  }
  retryTurn(c: RetryTurnCommand) {
    try {
      const identity = this.identity(c.identity); this.ready();
      const command: RetryTurnCommand = { ...c, clientTimeZone: normalizeTimeZone(c.clientTimeZone) };
      const body = retryTurnRequestSchema.parse({ idempotencyKey: command.idempotencyKey, expectedEpoch: command.expectedEpoch });
      if (body.expectedEpoch !== undefined && body.expectedEpoch !== this.processEpoch())
        throw new AppError('INTERRUPTED', 'This request belongs to an earlier server session; its outcome is unknown.', false);
      this.reservations.assertText(identity.userId, command.sessionId);
      this.assertConversationAdmission(identity.userId, command.sessionId);
      const retryMemory = this.d.memoryFirst ? this.memoryFor(identity.userId, true) : null;
      if (retryMemory && (retryMemory.hasRequest(command.sessionId, command.idempotencyKey) || retryMemory.eligible()))
        return this.joinAcceptance(JSON.stringify([identity.userId, command.sessionId, command.idempotencyKey]),
          hashPayload(JSON.stringify(['retry', command.turnId])), () => retryMemory.retry(command)
            .catch(error => { if (error instanceof DurableHistoryRequired) return this.acceptRetry(command); throw error; }));
      retryMemory?.handoff(command.sessionId);
      return this.joinAcceptance(JSON.stringify([identity.userId, command.sessionId, command.idempotencyKey]),
        hashPayload(JSON.stringify(['retry', command.turnId])), () => {
          const scope = { sessionId:command.sessionId, turnId:command.turnId, attemptId:attemptIdFor(identity.userId, command.sessionId, command.idempotencyKey),
            databasePhase:'admission' as const };
          return this.d.diagnostics ? this.d.diagnostics.run(scope, () => this.acceptRetry(command)) : this.acceptRetry(command);
        });
    } catch (error) { return Promise.reject(error); }
  }
  outputBudget(a: Pick<AttemptRecord, 'userId' | 'sessionId' | 'turnId' | 'attemptId' | 'createdAt'>, assistantSequence: number, internal = false, messageLimit = this.d.config.budgets.maxMessageBytes) {
    const outId = key('output', a.userId, a.sessionId, a.attemptId);
    const emptyOutput = { schemaVersion: 1 as const, userId: a.userId, sessionId: a.sessionId, turnId: a.turnId,
      attemptId: a.attemptId, messageId: outId, eventId: eventIdFor(a.userId, a.sessionId, outId),
      sequence: assistantSequence, role: 'assistant' as const, content: '', createdAt: a.createdAt,
      completionStatus: 'streaming' as const, truncated: false,
      ...(internal ? { visibility: 'internal' as const, mode: 'live' as const, voiceSessionId: 'x'.repeat(128) } : {}) };
    const headroom = bounded(messageRecordSchema, emptyOutput, key('message', a.userId, a.sessionId, outId), messageLimit).bytes;
    const maxVisibleBytes = messageLimit - headroom - (internal ? CANVAS_ARTIFACT_LIMITS.messageReserveBytes : 0);
    if (maxVisibleBytes < 1) throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The answer cannot fit in storage.');
    return maxVisibleBytes;
  }
  graph(lease: ExecutionLease) {
    return this.d.persistence.checkpoints.create().then(handle => buildTurnGraph(handle.bind(lease), {
      prepare: async () => { throw new AppError('NOT_READY', 'Recovery cannot invoke the graph.'); },
      generate: async () => { throw new AppError('NOT_READY', 'Recovery cannot invoke the model.'); },
    }));
  }
  private async enterDurablePublication(lease: ExecutionLease, session: SessionRecord | null): Promise<void> {
    const p = this.d.persistence;
    if (!session?.memoryPublication || !p.owner.store) return;
    const result = await p.owner.run(lease, () => p.owner.store.collection('sessions').updateOne({
      _id: key('session', lease.userId, lease.sessionId), userId: lease.userId, sessionId: lease.sessionId,
      lifecycle: 'active', 'execution.ownerId': lease.ownerId, 'execution.generation': lease.generation,
    }, { $unset: { memoryPublication: '' }, $inc: { _revision: 1 } }, p.owner.store.options()));
    if (!result.acknowledged || result.matchedCount !== 1) throw new AppError('NOT_READY', 'Chat handoff could not be confirmed.');
  }
  async checkBoundary(lease: ExecutionLease, job: Work, newTurnId: string, content: string,
    responseMode: ResponseMode, assembler?: ContextAssembler, diagnosticAttemptId?: string,
    personalization?: UserPersonalizationSettings, clientTimeZone?: string | null,
    pinnedUserMemory?: AgentMemoryManifest['pinnedUserMemory']) {
    const scope = { sessionId: lease.sessionId, turnId: newTurnId, attemptId: diagnosticAttemptId };
    const run = async () => {
    const startedAt = performance.now();
    diagnose(this.d.diagnostics?.emit, { stage: 'context', state: 'start', ...scope,
      origin: 'local', delivery: 'not-sent' });
    try {
    const p = this.d.persistence; const u = lease.userId; const s = lease.sessionId;
    const cfg = graphConfig(u, s);
    const [records, initialManifest, graphAndSnap] = await Promise.all([
      acceptedHistory(p, u, s),
      p.memory.get(u, s),
      this.graph(lease).then(async graph => ({ graph, snap: await graph.getState(cfg) })),
    ]);
    let { graph, snap } = graphAndSnap;
    let manifest = initialManifest;
    if (!manifest) {
      if (records.length || snap.values.boundary) throw new AppError('NOT_READY', 'Chat context needs recovery.');
      manifest = buildReferenceManifest(u, s, 0, [], this.d.assets, p.memory.budgets, null, pinnedUserMemory);
    }
    // The currently accepted input is deliberately not committed history yet.
    // On explicit retry it may already be referenced; P3 removes it by turn ID.
    const referenced = new Set(manifest.messageRefs.map(r => r.messageId));
    const committed = records.filter(m => !(m.turnId === newTurnId && m.role === 'user' && !referenced.has(m.messageId)));
    const expected = buildReferenceManifest(u, s, manifest.contextVersion, committed, this.d.assets, p.memory.budgets, manifest.activeSummaryRef, manifest.pinnedUserMemory);
    if (!isDeepStrictEqual(expected, manifest)) {
      // Deployed instructions/knowledge changed after this chat was saved. Rebase
      // the stored manifest once (same history, new asset versions) so the rest of
      // this turn, its finalization, and later admissions see one current manifest.
      // A graph schema change is a migration, not a version rebase.
      const assetVersionUpgrade = manifest.graphSchemaVersion === this.d.assets.graphSchemaVersion &&
        (manifest.instructionVersion !== this.d.assets.instructionVersion ||
          manifest.knowledgeContentHash !== this.d.assets.knowledgeContentHash);
      const stored = assetVersionUpgrade
        ? buildReferenceManifest(u, s, manifest.contextVersion, committed,
            { ...this.d.assets, instructionVersion: manifest.instructionVersion,
              knowledgeContentHash: manifest.knowledgeContentHash },
            p.memory.budgets, manifest.activeSummaryRef, manifest.pinnedUserMemory)
        : null;
      if (!stored || !isDeepStrictEqual(stored, manifest))
        throw new AppError('NOT_READY', 'Chat context needs recovery.');
      if (snap.next.length || !isDeepStrictEqual(snap.values.boundary, boundaryFor(manifest)))
        throw new AppError('NOT_READY', 'Graph state needs recovery.');
      const target = buildReferenceManifest(u, s, manifest.contextVersion + 1, committed,
        this.d.assets, p.memory.budgets, manifest.activeSummaryRef, manifest.pinnedUserMemory);
      const intent = { base: boundaryFor(manifest), target };
      await job.wait(graph.updateState(cfg, { rebase: intent }, 'seal'),
        this.d.config.budgets.persistenceTimeoutMs);
      await finishRebase(p, lease, job, graph, intent);
      manifest = target;
      snap = await graph.getState(cfg);
    }
    let checkpointId = snapshotCheckpointId(snap);
    if (!snap.values.boundary) {
      if (manifest.messageRefs.length || manifest.contextVersion !== 0) throw new AppError('NOT_READY', 'Graph state needs recovery.');
      const initialize = async () => {
        if (!initialManifest) await p.owner.run(lease, () => p.memory.put(manifest!));
        const updated = await graph.updateState(cfg, { boundary: boundaryFor(manifest!), input: null, result: null, sealed: false, rebase: null }, 'seal');
        return snapshotCheckpointId(updated);
      };
      checkpointId = await job.wait(p.owner.runPhase
        ? p.owner.runPhase(lease, { name: 'boundary-bootstrap', maxOperations: 4,
            deadlineAt: Math.min(Date.now() + this.d.config.budgets.persistenceTimeoutMs, Date.parse(lease.leaseExpiresAt) - 1000) }, initialize)
        : initialize(), this.d.config.budgets.persistenceTimeoutMs);
    } else if (snap.next.length || !isDeepStrictEqual(snap.values.boundary, boundaryFor(manifest)))
      throw new AppError('NOT_READY', 'Graph state needs recovery.');
    const effectiveAssembler = assembler ?? this.d.assembler;
    const effectivePersonalization = personalization
      ?? (diagnosticAttemptId ? this.attemptPersonalization.get(this.attemptKey(u, s, diagnosticAttemptId)) : undefined)
      ?? this.personalizationFor(u);
    const effectiveTimeZone = clientTimeZone !== undefined
      ? normalizeTimeZone(clientTimeZone)
      : (diagnosticAttemptId ? this.attemptTimeZone.get(this.attemptKey(u, s, diagnosticAttemptId)) : undefined);
    const source = { manifest, records: committed };
    const assembled = await effectiveAssembler.assemble({ userId: u, sessionId: s,
      turnId: newTurnId, newUserInput: content, responseMode, environment: this.environmentContext(u, effectiveTimeZone),
      personalization: effectivePersonalization }, source);
    if (!assembled.ok) throw new AppError('CONTEXT_BUDGET_EXCEEDED', assembled.overflow.message, false);
    diagnose(this.d.diagnostics?.emit, { stage: 'context', state: 'ok', ...scope,
      origin: 'local', delivery: 'not-sent', durationMs: performance.now() - startedAt });
    return { context: assembled.context, source, checkpointId };
    } catch (error) {
      diagnose(this.d.diagnostics?.emit, { stage: 'context', state: 'error', ...scope,
        origin: 'local', delivery: 'not-sent',
        code: error instanceof AppError ? error.code : 'PERSISTENCE_ERROR',
        durationMs: performance.now() - startedAt });
      throw error;
    }
    };
    return this.d.diagnostics ? this.d.diagnostics.run(scope, run) : run();
  }
  private storeAdmissionReceipt(input: {
    userId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    releasedGeneration: number;
    attempt: ConfirmedRecord<AttemptRecord>;
    input: ConfirmedRecord<MessageRecord>;
    acceptance: AcceptanceRecord;
    reservation: Readonly<{ start: number; count: number }>;
    source: ContextSourceSnapshot;
    checkpointId: string;
    responseMode: ResponseMode;
    configRevision: number;
    personalization?: UserPersonalizationSettings;
    clientTimeZone?: string | null;
    manifestReceipt?: ConfirmedRecord<AgentMemoryManifest> | null;
    assembledContext?: AssembledContext;
  }): void {
    if (input.checkpointId && !isPinnedCheckpointId(input.sessionId, input.checkpointId)) return;
    const plainRecords: MessageRecord[] = [];
    const refreshRefs: MessageRef[] = [];
    for (const m of input.source.records) {
      const isCalendarAnswer = this.isCalendarOrUncertain(input.userId, input.sessionId, m);
      if (isCalendarAnswer || m.voiceTranscripts?.length) {
        refreshRefs.push({ messageId: m.messageId, eventId: m.eventId, sequence: m.sequence });
        if (isCalendarAnswer && m.role === 'assistant') this.trackCalendarMessage(input.userId, input.sessionId, m.messageId);
      } else {
        plainRecords.push(m);
      }
    }
    this.receipts.put({
      userId: input.userId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      executorId: this.d.persistence.owner.executorId,
      releasedGeneration: input.releasedGeneration,
      expiresAt: Date.now() + 60_000,
      attempt: input.attempt,
      input: input.input,
      acceptance: input.acceptance,
      reservation: input.reservation,
      manifest: input.source.manifest,
      sourceRecords: plainRecords,
      refreshRefs,
      boundary: boundaryFor(input.source.manifest),
      checkpointId: input.checkpointId,
      graphEpoch: this.sessionGraphEpoch.get(this.sessionKey(input.userId, input.sessionId)) ?? 0,
      responseMode: input.responseMode,
      configRevision: input.configRevision,
      ...(input.personalization ? { personalization: input.personalization } : {}),
      ...(input.clientTimeZone ? { clientTimeZone: input.clientTimeZone } : {}),
      ...(input.manifestReceipt ? { manifestReceipt: input.manifestReceipt } : {}),
      ...(input.assembledContext ? { assembledContext: input.assembledContext } : {}),
    });
  }
  private async reuseAdmittedContext(
    lease: ExecutionLease,
    job: Work,
    receipt: AdmissionReceipt,
    attempt: AttemptRecord,
    content: string,
    responseMode: ResponseMode,
    assembler: ContextAssembler,
    snapshot: RuntimeConfigSnapshot,
    personalization: UserPersonalizationSettings,
    clientTimeZone?: string | null,
  ): Promise<{
    context: AssembledContext;
    source: ContextSourceSnapshot;
    manifestReceipt: ConfirmedRecord<AgentMemoryManifest> | null;
  } | null> {
    const p = this.d.persistence;
    if (
      receipt.userId !== lease.userId ||
      receipt.sessionId !== lease.sessionId ||
      receipt.turnId !== attempt.turnId ||
      receipt.attemptId !== attempt.attemptId ||
      receipt.executorId !== p.owner.executorId ||
      receipt.responseMode !== responseMode ||
      receipt.configRevision !== snapshot.revision ||
      !isDeepStrictEqual(receipt.personalization ?? defaultPersonalizationSettings(), personalization) ||
      normalizeTimeZone(receipt.clientTimeZone) !== normalizeTimeZone(clientTimeZone) ||
      receipt.input.record.messageId !== attempt.causal.userMessageId ||
      receipt.input.record.content !== content ||
      hashPayload(receipt.input.record.content) !== attempt.payloadHash ||
      receipt.manifest.instructionVersion !== this.d.assets.instructionVersion ||
      receipt.manifest.knowledgeContentHash !== this.d.assets.knowledgeContentHash ||
      receipt.manifest.graphSchemaVersion !== this.d.assets.graphSchemaVersion ||
      (receipt.checkpointId !== '' && !isPinnedCheckpointId(receipt.sessionId, receipt.checkpointId))
    ) {
      return null;
    }
    if (responseMode === 'voice' && receipt.refreshRefs.length === 0 && receipt.assembledContext) {
      const records = mergeAdmissionSourceRecords(receipt.manifest, receipt.sourceRecords, []);
      if (!records) return null;
      return {
        context: receipt.assembledContext,
        source: { manifest: receipt.manifest, records },
        manifestReceipt: receipt.manifestReceipt ?? null,
      };
    }
    const messages = p.messages as typeof p.messages & {
      getReferences?(userId: string, sessionId: string, refs: readonly MessageRef[]): Promise<MessageRecord[]>;
    };
    const refreshed = receipt.refreshRefs.length === 0
      ? [] as MessageRecord[]
      : typeof messages.getReferences === 'function'
        ? await messages.getReferences(lease.userId, lease.sessionId, receipt.refreshRefs)
        : await Promise.all(receipt.refreshRefs.map(async ref => {
            const row = await p.messages.get(lease.userId, lease.sessionId, ref.messageId);
            if (!row) throw new AppError('NOT_READY', 'Chat context needs recovery.');
            return row;
          }));
    job.check();
    const records = mergeAdmissionSourceRecords(receipt.manifest, receipt.sourceRecords, refreshed);
    if (!records) return null;
    const source = { manifest: receipt.manifest, records };
    const assembled = await assembler.assemble({
      userId: lease.userId,
      sessionId: lease.sessionId,
      turnId: attempt.turnId,
      newUserInput: content,
      responseMode,
      environment: this.environmentContext(lease.userId, clientTimeZone),
      personalization,
    }, source);
    if (!assembled.ok) throw new AppError('CONTEXT_BUDGET_EXCEEDED', assembled.overflow.message, false);
    return { context: assembled.context, source, manifestReceipt: receipt.manifestReceipt ?? null };
  }
  private async loadHealthyContext(
    lease: ExecutionLease,
    job: Work,
    newTurnId: string,
    content: string,
    responseMode: ResponseMode,
    assembler: ContextAssembler,
    currentSession?: SessionRecord | null,
    personalization?: UserPersonalizationSettings,
    clientTimeZone?: string | null,
    pinnedUserMemory?: AgentMemoryManifest['pinnedUserMemory'],
  ): Promise<{
    context: AssembledContext;
    source: ContextSourceSnapshot;
    checkpointId: string;
    manifestReceipt: ConfirmedRecord<AgentMemoryManifest> | null;
  } | null> {
    const p = this.d.persistence;
    const u = lease.userId;
    const s = lease.sessionId;
    const effectivePersonalization = personalization ?? this.personalizationFor(u);
    const cfg = graphConfig(u, s);
    const messages = p.messages as typeof p.messages & {
      getReferences?(userId: string, sessionId: string, refs: readonly MessageRef[]): Promise<MessageRecord[]>;
    };
    if (typeof messages.getReferences !== 'function') return null;
    const cached = this.confirmedState.get(u, s);
    if (
      cached &&
      cached.executorId === p.owner.executorId &&
      lease.generation === cached.sessionGeneration + 1 &&
      (!currentSession?.latestTurnId || currentSession.latestTurnId === cached.turnId) &&
      cached.instructionVersion === this.d.assets.instructionVersion &&
      cached.manifest.instructionVersion === this.d.assets.instructionVersion &&
      cached.knowledgeContentHash === this.d.assets.knowledgeContentHash &&
      cached.manifest.knowledgeContentHash === this.d.assets.knowledgeContentHash &&
      cached.graphSchemaVersion === this.d.assets.graphSchemaVersion &&
      cached.manifest.graphSchemaVersion === this.d.assets.graphSchemaVersion &&
      isPinnedCheckpointId(s, cached.checkpointId)
    ) {
      job.check();
      if (cached.calendarMessageIds?.length) {
        for (const mid of cached.calendarMessageIds) this.trackCalendarMessage(u, s, mid);
      } else if (cached.refreshRefs.length === 0) {
        this.trackCleanSession(u, s);
      }
      let records: MessageRecord[] | null = null;
      if (cached.refreshRefs.length === 0) {
        if (cached.plainRecords.length === cached.manifest.messageRefs.length) {
          records = cached.plainRecords as MessageRecord[];
        }
      } else {
        try {
          const refreshed = typeof messages.getReferences === 'function'
            ? await messages.getReferences(u, s, cached.refreshRefs)
            : await Promise.all(cached.refreshRefs.map(async ref => {
                const row = await p.messages.get(u, s, ref.messageId);
                if (!row) throw new AppError('NOT_READY', 'Chat context needs recovery.');
                return row;
              }));
          records = mergeAdmissionSourceRecords(cached.manifest, cached.plainRecords, refreshed);
        } catch {
          records = null;
        }
      }
      if (records) {
        const source = { manifest: cached.manifest, records };
        const assembled = await assembler.assemble({
          userId: u, sessionId: s, turnId: newTurnId, newUserInput: content, responseMode,
          environment: this.environmentContext(u, clientTimeZone),
          personalization: effectivePersonalization,
        }, source);
        if (!assembled.ok) throw new AppError('CONTEXT_BUDGET_EXCEEDED', assembled.overflow.message, false);
        return {
          context: assembled.context,
          source,
          checkpointId: cached.checkpointId,
          manifestReceipt: cached.manifestReceipt ?? null,
        };
      }
    }
    const manifestRead = typeof p.memory.getConfirmed === 'function'
      ? p.memory.getConfirmed(u, s).then(confirmed => ({
          manifestReceipt: confirmed,
          current: confirmed?.record ?? null,
        }))
      : p.memory.get(u, s).then(current => ({
          manifestReceipt: null as ConfirmedRecord<AgentMemoryManifest> | null,
          current,
        }));
    const [manifestState, graphAndSnap] = await Promise.all([
      manifestRead,
      this.graph(lease).then(async graph => ({ graph, snap: await graph.getState(cfg) })),
    ]);
    job.check();
    const { graph, snap } = graphAndSnap;
    const current = manifestState.current;
    if (
      responseMode === 'voice' &&
      !current &&
      !snap.values.boundary &&
      !snap.next.length &&
      !currentSession?.latestTurnId &&
      lease.generation === 1
    ) {
      const manifest = buildReferenceManifest(u, s, 0, [], this.d.assets, p.memory.budgets, null, pinnedUserMemory);
      let bootstrappedReceipt: ConfirmedRecord<AgentMemoryManifest> | null = null;
      const initialize = async () => {
        if (typeof p.memory.putConfirmed === 'function') {
          bootstrappedReceipt = await p.owner.run(lease, () => p.memory.putConfirmed!(manifest));
        } else {
          await p.owner.run(lease, () => p.memory.put(manifest));
        }
        const updated = await graph.updateState(
          cfg,
          { boundary: boundaryFor(manifest), input: null, result: null, sealed: false, rebase: null },
          'seal',
        );
        return snapshotCheckpointId(updated);
      };
      const bootCid = await job.wait(
        p.owner.runPhase
          ? p.owner.runPhase(
              lease,
              {
                name: 'boundary-bootstrap',
                maxOperations: 4,
                deadlineAt: Math.min(
                  Date.now() + this.d.config.budgets.persistenceTimeoutMs,
                  Date.parse(lease.leaseExpiresAt) - 1000,
                ),
              },
              initialize,
            )
          : initialize(),
        this.d.config.budgets.persistenceTimeoutMs,
      );
      const source = { manifest, records: [] as MessageRecord[] };
      const assembled = await assembler.assemble(
        {
          userId: u,
          sessionId: s,
          turnId: newTurnId,
          newUserInput: content,
          responseMode,
          environment: this.environmentContext(u, clientTimeZone),
          personalization: effectivePersonalization,
        },
        source,
      );
      if (!assembled.ok) throw new AppError('CONTEXT_BUDGET_EXCEEDED', assembled.overflow.message, false);
      return {
        context: assembled.context,
        source,
        checkpointId: bootCid,
        manifestReceipt: bootstrappedReceipt,
      };
    }
    if (
      !current
      || current.instructionVersion !== this.d.assets.instructionVersion
      || current.knowledgeContentHash !== this.d.assets.knowledgeContentHash
      || current.graphSchemaVersion !== this.d.assets.graphSchemaVersion
    ) {
      return null;
    }
    const checkpointId = snapshotCheckpointId(snap);
    if (
      !snap.values.boundary
      || snap.next.length
      || !isPinnedCheckpointId(s, checkpointId)
      || !isDeepStrictEqual(snap.values.boundary, boundaryFor(current))
    ) {
      return null;
    }
    let records: MessageRecord[];
    try {
      records = await messages.getReferences(u, s, current.messageRefs);
    } catch {
      return null;
    }
    const expected = buildReferenceManifest(u, s, current.contextVersion, records, this.d.assets, p.memory.budgets, current.activeSummaryRef, current.pinnedUserMemory);
    if (!isDeepStrictEqual(expected, current)) return null;
    const summary = current.activeSummaryRef
      ? await p.metadata.getCompactionSummary?.(u, s, current.activeSummaryRef.summaryId) ?? null
      : null;
    const source = { manifest: current, records, ...(summary ? { summary } : {}) };
    const assembled = await assembler.assemble({
      userId: u, sessionId: s, turnId: newTurnId, newUserInput: content, responseMode,
      environment: this.environmentContext(u, clientTimeZone),
      personalization: effectivePersonalization,
    }, source);
    if (!assembled.ok) throw new AppError('CONTEXT_BUDGET_EXCEEDED', assembled.overflow.message, false);
    return { context: assembled.context, source, checkpointId, manifestReceipt: manifestState.manifestReceipt };
  }
  async acceptNewTurn(command: SubmitTurnCommand, live?: ExecutionReservation) {
    this.memoryFor(command.identity.userId)?.handoff(sessionIdFor(command.identity.userId, command.sessionId, command.idempotencyKey));
    const id = this.identity(command.identity); this.ready();
    const body = submitTurnRequestSchema.parse({ sessionId: command.sessionId, content: command.content, idempotencyKey: command.idempotencyKey, calendarReplyTo: replyReferenceOf(command), ephemeral: command.ephemeral });
    const p = this.d.persistence; const s = sessionIdFor(id.userId, body.sessionId, body.idempotencyKey);
    if (body.sessionId !== null && body.ephemeral !== undefined &&
        !(live && body.ephemeral === true && body.sessionId === s &&
          (command as SubmitLiveTurn).freshConversation === true))
      throw new AppError('INVALID_REQUEST', 'Temporary mode is selected when starting a conversation.');
    if (live) this.reservations.assertLive(live, id, s); else this.reservations.assertText(id.userId, s);
    const classification = live ? { visibility: 'internal' as const, mode: 'live' as const,
      ...(live.owner.kind === 'live' ? { voiceSessionId: live.owner.voiceSessionId } : {}) } : {};
    const freshKey = live ? JSON.stringify([id.userId, s, body.idempotencyKey, hashPayload(body.content)]) : null;
    const freshExp = freshKey ? this.freshLiveSubmissions.get(freshKey) : undefined;
    if (freshKey) this.freshLiveSubmissions.delete(freshKey);
    const skipIdempotencyRead = Boolean(freshExp && freshExp > Date.now());
    const [existingSession, old] = await Promise.all([
      p.sessions.get(id.userId, s),
      skipIdempotencyRead
        ? Promise.resolve(null)
        : p.metadata.getAttemptByIdempotency(id.userId, s, body.idempotencyKey),
    ]);
    if (existingSession && existingSession.lifecycle !== 'active') throw new AppError('NOT_FOUND', 'Chat not found.');
    if (body.ephemeral !== undefined && (existingSession?.ephemeral === true) !== (body.ephemeral === true))
      throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This request identity has different input.');
    if (old) {
      if (old.payloadHash !== hashPayload(body.content) || old.causal.previousAttemptId !== null)
        throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This request identity has different input.');
      // The reply reference is part of the request identity. A resubmission
      // that names a different proposal revision is a different request.
      const replyTo = body.calendarReplyTo;
      const proposals = this.proposalStore();
      if (old.calendarReplyTo !== undefined) {
        if (!isDeepStrictEqual(old.calendarReplyTo, replyTo ?? null)) {
          throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This request identity has different input.');
        }
      } else if (proposals) {
        if (replyTo) {
          const bound = await proposals.bindReplyReference({
            userId: id.userId, sessionId: s, turnId: old.turnId, attemptId: old.attemptId, replyTo,
          });
          if (bound === 'conflict') throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This request identity has different input.');
        } else if (await proposals.getReplyReference(id.userId, s, old.attemptId)) {
          throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This request identity has different input.');
        }
      }
      const original = await p.messages.get(id.userId, s, old.causal.userMessageId);
      if (!original || (live ? original.visibility !== 'internal' || original.mode !== 'live'
        : original.visibility === 'internal')) throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This request identity has different input.');
      if (!await p.metadata.getAcceptance(id.userId, s, old.attemptId)) throw new AppError('NOT_READY', 'Acceptance needs recovery.');
      return responseFor(old);
    }

    let snapshot: RuntimeConfigSnapshot;
    if (live) {
      if (this.d.currentConfig) {
        const liveSnap = (command as SubmitLiveTurn).configSnapshot;
        if (!liveSnap || !liveSnap.openRouter.apiKey || !liveSnap.openRouter.modelId ||
            !liveSnap.modelLimits || liveSnap.modelLimits.modelId !== liveSnap.openRouter.modelId) {
          throw new AppError('NOT_READY', 'Voice configuration is unavailable.');
        }
        snapshot = liveSnap;
      } else {
        throw new AppError('NOT_READY', 'Chat configuration is unavailable.');
      }
    } else {
      snapshot = this.captureTextSettings(id.userId);
    }
    if (this.attemptSettings.size >= 1024) throw new AppError('CONCURRENCY_LIMIT', 'Too many attempts are pending.');
    validateInput(body.content, snapshot.budgets);

    if (live) this.reservations.assertLive(live, id, s); else this.reservations.assertText(id.userId, s);
    const job = this.work.open(id.userId, s, new AbortController().signal, snapshot.budgets.totalRunTimeoutMs);
    let lease: ExecutionLease | undefined;
    const aId = attemptIdFor(id.userId, s, body.idempotencyKey);
    const boundKey = this.attemptKey(id.userId, s, aId);
    const personalization = this.personalizationFor(id.userId);
    const clientTimeZone = normalizeTimeZone(command.clientTimeZone);
    this.attemptSettings.set(boundKey, snapshot);
    this.attemptPersonalization.set(boundKey, personalization);
    if (clientTimeZone) this.attemptTimeZone.set(boundKey, clientTimeZone);
    if (command.requestGeo) this.attemptRequestGeo.set(boundKey, command.requestGeo);
    this.attemptIdentities.set(boundKey, id);
    let confirmed = false;
    try {
      const at = this.now();
      if (!live && body.sessionId !== null && !existingSession) throw new AppError('NOT_FOUND', 'Chat not found.');
      const sessionRecord = { schemaVersion: 1 as const, userId: id.userId, sessionId: s,
        title: titleFor(body.content, snapshot.budgets.titleMaxChars),
        createdAt: at, updatedAt: at, lastActivityAt: at, lifecycle: 'active' as const,
        graphThreadId: graphThreadId(id.userId, s), latestTurnId: null,
        execution: { ownerId: null, leaseExpiresAt: null, activeAttemptId: null, generation: 0 },
        ...(body.ephemeral === true ? { ephemeral: true as const } : {}) };
      if (live || !existingSession) {
        await job.wait(live ? p.sessions.createForInternalTurn(sessionRecord) : p.sessions.createIfAbsent(sessionRecord),
          this.d.config.budgets.persistenceTimeoutMs);
      }
      const newSessionPin = existingSession ? undefined : body.ephemeral === true ? null
        : this.d.userMemory?.cache.cachedSnapshot(id.userId);
      const owned = await p.owner.acquire({ userId: id.userId, sessionId: s, ownerId: p.owner.executorId, leaseMs: 180000 });
      if (!owned.ok) throw new AppError('CONFLICT_ACTIVE_TURN', 'Another turn is active.');
      const activeLease = owned.lease;
      lease = activeLease;
      await this.enterDurablePublication(activeLease, existingSession);
      const t = turnIdFor(id.userId, s, body.idempotencyKey);
      if (live) {
        const liveKey = `${id.userId}\0${s}\0${t}`;
        this.liveTurnKeys.delete(liveKey);
        this.liveTurnKeys.add(liveKey);
        while (this.liveTurnKeys.size > 4096) this.liveTurnKeys.delete(this.liveTurnKeys.values().next().value!);
      }
      const mId = inputId(id.userId, s, aId);
      const currentSession = owned.session ?? existingSession ?? await p.sessions.get(id.userId, s);
      const assembler = this.assemblerFor(snapshot);
      const mode: ResponseMode = live ? 'voice' : 'text';
      const skipOrphanRead = Boolean(
        live &&
        skipIdempotencyRead &&
        ((!existingSession && activeLease.generation === 1) ||
          this.confirmedState.get(id.userId, s)?.sessionGeneration === activeLease.generation - 1),
      );
      const [prior, healthy, orphan] = await Promise.all([
        currentSession?.latestTurnId && currentSession.latestTurnId !== t
          ? latestAttempt(p, id.userId, s, currentSession.latestTurnId)
          : Promise.resolve(null),
        this.loadHealthyContext(activeLease, job, t, body.content, mode, assembler, currentSession, personalization, clientTimeZone, newSessionPin),
        skipOrphanRead ? Promise.resolve(null) : p.messages.get(id.userId, s, mId),
      ]);
      if (prior && !terminal(prior.status)) throw new AppError('CONFLICT_ACTIVE_TURN', 'Another turn is active.');
      const loaded = healthy ?? await this.checkBoundary(activeLease, job, t, body.content, mode, assembler, aId, personalization, clientTimeZone, newSessionPin);
      const { context, source: contextSources, checkpointId } = loaded;
      const manifestReceipt = healthy?.manifestReceipt ?? null;
      if (orphan && (orphan.content !== body.content || orphan.turnId !== t || orphan.role !== 'user' ||
        (live ? orphan.visibility !== 'internal' || orphan.mode !== 'live' : orphan.visibility === 'internal')))
        throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This request identity has different input.');
      if (orphan && (await acceptedHistory(p, id.userId, s)).some(m => m.role === 'user' && m.sequence > orphan.sequence))
        throw new AppError('NOT_READY', 'This orphaned input cannot be accepted after later turns.');
      bounded(messageRecordSchema, { schemaVersion: 1, userId: id.userId, sessionId: s, turnId: t,
        messageId: mId, eventId: eventIdFor(id.userId, s, mId), sequence: 0, role: 'user', content: body.content,
        createdAt: at, completionStatus: 'accepted', attemptId: null, truncated: false, ...classification },
        key('message', id.userId, s, mId), this.d.config.budgets.maxMessageBytes);
      const visible = this.outputBudget({ userId: id.userId, sessionId: s, turnId: t, attemptId: aId, createdAt: at }, Number.MAX_SAFE_INTEGER, Boolean(live), Math.min(snapshot.budgets.maxMessageBytes, p.messages.budgets.maxMessageBytes));
      if (context.messages.some(m => Buffer.byteLength(m.content, 'utf8') > visible))
        throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The answer cannot fit in storage.');
      const stageDeadline = Math.min(Date.now() + this.d.config.budgets.persistenceTimeoutMs,
        Date.parse(activeLease.leaseExpiresAt) - 1000);
      const canStage = typeof p.owner.runPhase === 'function' &&
        typeof p.messages.appendConfirmed === 'function' &&
        typeof p.metadata.putAttemptConfirmed === 'function';
      const stage = async () => {
        await job.wait(p.owner.reserveAttempt(activeLease, aId), this.d.config.budgets.persistenceTimeoutMs);
        const reserved = await p.owner.allocateSequences(activeLease, aId, 3);
        const input: MessageRecord = orphan ?? { schemaVersion: 1, userId: id.userId, sessionId: s, turnId: t,
          messageId: mId, eventId: eventIdFor(id.userId, s, mId), sequence: reserved.start, role: 'user', content: body.content,
          createdAt: at, completionStatus: 'accepted', attemptId: null, truncated: false, ...classification };
        const attempt: AttemptRecord = { schemaVersion: 1, kind: 'attempt', userId: id.userId, sessionId: s, turnId: t,
          attemptId: aId, idempotencyKey: body.idempotencyKey, payloadHash: hashPayload(body.content), status: 'accepted',
          calendarReplyTo: body.calendarReplyTo ?? null,
          sequence: reserved.start + 1, createdAt: input.createdAt, updatedAt: input.createdAt,
          instructionVersion: context.instructionVersion, knowledgeContentHash: context.knowledgeContentHash,
          graphSchemaVersion: context.graphSchemaVersion, contextVersion: context.contextVersion, modelId: snapshot.openRouter.modelId,
          openRouterUser: id.openRouterUser, generationId: null, truncated: false, errorCode: null,
          causal: { userMessageId: mId, previousAttemptId: null } };
        let inputReceipt: ConfirmedRecord<MessageRecord>;
        let attemptReceipt: ConfirmedRecord<AttemptRecord>;
        if (canStage) {
          const results = await Promise.allSettled([
            p.owner.run(activeLease, () => p.messages.appendConfirmed(input)),
            p.owner.run(activeLease, () => p.metadata.putAttemptConfirmed(attempt)),
          ]);
          const failure = results.find(r => r.status === 'rejected');
          if (failure && failure.status === 'rejected') throw failure.reason;
          if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') {
            throw new AppError('PERSISTENCE_ERROR', 'The chat could not be saved.');
          }
          inputReceipt = results[0].value;
          attemptReceipt = results[1].value;
        } else {
          await job.wait(p.owner.run(activeLease, () => p.messages.append(input)), this.d.config.budgets.persistenceTimeoutMs);
          await job.wait(p.owner.run(activeLease, () => p.metadata.putAttempt(attempt)), this.d.config.budgets.persistenceTimeoutMs);
          inputReceipt = { record: input, canonical: input } as any;
          attemptReceipt = { record: attempt, canonical: attempt } as any;
        }
        const acceptedRecord = await p.owner.confirmAcceptance(activeLease, aId, { input: inputReceipt, attempt: attemptReceipt });
        return { reserved, input, attempt, inputReceipt, attemptReceipt, acceptedRecord };
      };
      // Reservation, allocation, archive and acceptance marker are consecutive
      // storage-only work under one bounded ownership phase.
      const { reserved, input, attempt, inputReceipt, attemptReceipt, acceptedRecord } = await job.wait(
        canStage
          ? p.owner.runPhase(activeLease, { name: 'acceptance-stage', deadlineAt: stageDeadline, maxOperations: 8 }, stage)
          : stage(), this.d.config.budgets.persistenceTimeoutMs);
      await this.admitCalendarBudget(boundKey, snapshot, attempt, input.createdAt);
      confirmed = true;
      this.confirmedState.delete(id.userId, s);
      if (p.owner.detachAccepted) {
        const detached = await job.wait(p.owner.detachAccepted(activeLease, aId), this.d.config.budgets.persistenceTimeoutMs);
        lease = undefined;
        if (contextSources) {
          this.storeAdmissionReceipt({
            userId: id.userId,
            sessionId: s,
            turnId: t,
            attemptId: aId,
            releasedGeneration: detached.releasedGeneration,
            attempt: attemptReceipt,
            input: inputReceipt,
            acceptance: acceptedRecord,
            reservation: reserved,
            source: contextSources,
            checkpointId,
            responseMode: live ? 'voice' : 'text',
            configRevision: snapshot.revision,
            personalization,
            ...(clientTimeZone ? { clientTimeZone } : {}),
            manifestReceipt,
            ...(live ? { assembledContext: context } : {}),
          });
        }
      }
      diagnose(this.d.diagnostics?.emit, { stage: 'acceptance-durable', state: 'ok',
        sessionId: s, turnId: t, attemptId: aId, origin: 'local', delivery: 'not-sent' });
      diagnose(this.d.diagnostics?.emit, { stage: 'admission', state: 'ok',
        sessionId: s, turnId: t, attemptId: aId, origin: 'local', delivery: 'not-sent' });
      return responseFor(attempt);
    } catch (err) {
      if (!confirmed && !this.work.degraded) {
        this.attemptSettings.delete(boundKey);
        this.attemptPersonalization.delete(boundKey);
        this.attemptTimeZone.delete(boundKey);
        this.attemptRequestGeo.delete(boundKey);
        this.attemptCalendar.delete(boundKey);
        this.attemptIdentities.delete(boundKey);
      }
      throw err;
    } finally {
      await job.settled(); await p.owner.drain();
      if (lease) await p.owner.release(lease);
      job.close();
    }
  }
  async acceptRetry(c: RetryTurnCommand) {
    const id = this.identity(c.identity); this.ready(); retryTurnRequestSchema.parse({ idempotencyKey: c.idempotencyKey });
    const p = this.d.persistence; const session = await p.sessions.get(id.userId, c.sessionId);
    if (!session) throw new AppError('NOT_FOUND', 'Chat not found.');
    if (session.latestTurnId !== c.turnId) throw new AppError('CONFLICT_ACTIVE_TURN', 'Only the latest incomplete turn can be retried.');
    const prior = await latestAttempt(p, id.userId, c.sessionId, c.turnId);
    const original = await p.messages.get(id.userId, c.sessionId, prior.causal.userMessageId);
    if (!original || original.visibility === 'internal') throw new AppError('NOT_FOUND', 'Turn not found.');
    const duplicate = await p.metadata.getAttemptByIdempotency(id.userId, c.sessionId, c.idempotencyKey);
    if (duplicate) {
      if (duplicate.turnId !== c.turnId || duplicate.causal.previousAttemptId === null ||
        duplicate.payloadHash !== hashPayload(original.content))
        throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This retry identity has different input.');
      if (!await p.metadata.getAcceptance(id.userId, c.sessionId, duplicate.attemptId)) throw new AppError('NOT_READY', 'Retry acceptance needs recovery.');
      return responseFor(duplicate);
    }
    const attempts = (await attemptsFor(p, id.userId, c.sessionId)).filter(a => a.turnId === c.turnId);
    if (!['failed', 'cancelled', 'interrupted'].includes(prior.status) || attempts.length >= 3)
      throw new AppError('CONFLICT_ACTIVE_TURN', 'This turn cannot be retried. Start a new chat.');
    if (original.role !== 'user' || hashPayload(original.content) !== prior.payloadHash ||
      !await p.metadata.getAcceptance(id.userId, c.sessionId, prior.attemptId)) throw new AppError('NOT_READY', 'Original input needs recovery.');

    const snapshot = this.captureTextSettings(id.userId);
    if (this.attemptSettings.size >= 1024) throw new AppError('CONCURRENCY_LIMIT', 'Too many attempts are pending.');
    validateInput(original.content, snapshot.budgets);

    this.reservations.assertText(id.userId, c.sessionId);
    const job = this.work.open(id.userId, c.sessionId, new AbortController().signal, snapshot.budgets.totalRunTimeoutMs);
    let lease: ExecutionLease | undefined;
    const aId = attemptIdFor(id.userId, c.sessionId, c.idempotencyKey);
    const boundKey = this.attemptKey(id.userId, c.sessionId, aId);
    const personalization = this.personalizationFor(id.userId);
    const clientTimeZone = normalizeTimeZone(c.clientTimeZone);
    this.attemptSettings.set(boundKey, snapshot);
    this.attemptPersonalization.set(boundKey, personalization);
    if (clientTimeZone) this.attemptTimeZone.set(boundKey, clientTimeZone);
    if (c.requestGeo) this.attemptRequestGeo.set(boundKey, c.requestGeo);
    this.attemptIdentities.set(boundKey, id);
    let confirmed = false;
    try {
      const owned = await p.owner.acquire({ userId: id.userId, sessionId: c.sessionId, ownerId: p.owner.executorId, leaseMs: 180000 });
      if (!owned.ok) throw new AppError('CONFLICT_ACTIVE_TURN', 'Another turn is active.');
      const activeLease = owned.lease;
      lease = activeLease;
      await this.enterDurablePublication(activeLease, session);
      const assembler = this.assemblerFor(snapshot);
      const healthy = await this.loadHealthyContext(activeLease, job, c.turnId, original.content, 'text', assembler, undefined, personalization, clientTimeZone);
      const loaded = healthy ?? await this.checkBoundary(activeLease, job, c.turnId, original.content, 'text', assembler, aId, personalization, clientTimeZone);
      const { context, source: contextSources, checkpointId } = loaded;
      const manifestReceipt = healthy?.manifestReceipt ?? null;
      const visible = this.outputBudget({ userId: id.userId, sessionId: c.sessionId, turnId: c.turnId, attemptId: aId, createdAt: this.now() }, Number.MAX_SAFE_INTEGER, false, Math.min(snapshot.budgets.maxMessageBytes, p.messages.budgets.maxMessageBytes));
      if (context.messages.some(m => Buffer.byteLength(m.content, 'utf8') > visible))
        throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The answer cannot fit in storage.');
      const stageDeadline = Math.min(Date.now() + this.d.config.budgets.persistenceTimeoutMs,
        Date.parse(activeLease.leaseExpiresAt) - 1000);
      const canStage = typeof p.owner.runPhase === 'function' &&
        typeof p.metadata.putAttemptConfirmed === 'function';
      const stage = async () => {
        await job.wait(p.owner.reserveAttempt(activeLease, aId), this.d.config.budgets.persistenceTimeoutMs);
        const reservation = await p.owner.allocateSequences(activeLease, aId, 2); const at = this.now();
        const a: AttemptRecord = { ...prior, attemptId: aId, idempotencyKey: c.idempotencyKey, status: 'accepted',
          sequence: reservation.start, createdAt: at, updatedAt: at, generationId: null, truncated: false, errorCode: null,
          contextVersion: context.contextVersion, instructionVersion: context.instructionVersion, knowledgeContentHash: context.knowledgeContentHash,
          graphSchemaVersion: context.graphSchemaVersion, modelId: snapshot.openRouter.modelId, openRouterUser: id.openRouterUser,
          causal: { userMessageId: original.messageId, previousAttemptId: prior.attemptId } };
        let attemptReceipt: ConfirmedRecord<AttemptRecord>;
        if (canStage) {
          attemptReceipt = await p.owner.run(activeLease, () => p.metadata.putAttemptConfirmed(a));
        } else {
          await job.wait(p.owner.run(activeLease, () => p.metadata.putAttempt(a)), this.d.config.budgets.persistenceTimeoutMs);
          attemptReceipt = { record: a, canonical: a } as any;
        }
        const proposals = this.proposalStore();
        const priorReply = proposals && prior.calendarReplyTo === undefined
          ? await proposals.getReplyReference(id.userId, c.sessionId, prior.attemptId)
          : null;
        if (priorReply && proposals) {
          await p.owner.run(activeLease, () => proposals.bindReplyReference({
            userId: id.userId, sessionId: c.sessionId, turnId: c.turnId, attemptId: aId, replyTo: priorReply,
          }));
        }
        const originalConfirmed = p.messages.getConfirmed
          ? await p.messages.getConfirmed(id.userId, c.sessionId, original.messageId)
          : { record: original, canonical: original } as any;
        const acceptedRecord = await p.owner.confirmAcceptance(
          activeLease,
          aId,
          originalConfirmed ? { input: originalConfirmed, attempt: attemptReceipt } : undefined,
        );
        return { reservation, a, attemptReceipt, originalConfirmed, acceptedRecord };
      };
      const { reservation, a, attemptReceipt, originalConfirmed, acceptedRecord } = await job.wait(
        canStage
          ? p.owner.runPhase(activeLease, { name: 'acceptance-stage', deadlineAt: stageDeadline, maxOperations: 8 }, stage)
          : stage(), this.d.config.budgets.persistenceTimeoutMs);
      await this.admitCalendarBudget(boundKey, snapshot, a, original.createdAt);
      confirmed = true;
      if (p.owner.detachAccepted) {
        const detached = await job.wait(p.owner.detachAccepted(activeLease, aId), this.d.config.budgets.persistenceTimeoutMs);
        lease = undefined;
        if (originalConfirmed && contextSources) {
          this.storeAdmissionReceipt({
            userId: id.userId,
            sessionId: c.sessionId,
            turnId: c.turnId,
            attemptId: aId,
            releasedGeneration: detached.releasedGeneration,
            attempt: attemptReceipt,
            input: originalConfirmed,
            acceptance: acceptedRecord ?? { schemaVersion: 1, kind: 'acceptance', userId: id.userId, sessionId: c.sessionId, turnId: c.turnId, attemptId: aId, userMessageId: original.messageId, payloadHash: a.payloadHash },
            reservation,
            source: contextSources,
            checkpointId,
            responseMode: 'text',
            configRevision: snapshot.revision,
            personalization,
            ...(clientTimeZone ? { clientTimeZone } : {}),
            manifestReceipt,
          });
        }
      }
      diagnose(this.d.diagnostics?.emit, { stage: 'acceptance-durable', state: 'ok',
        sessionId: c.sessionId, turnId: c.turnId, attemptId: aId, origin: 'local', delivery: 'not-sent' });
      diagnose(this.d.diagnostics?.emit, { stage: 'admission', state: 'ok',
        sessionId: c.sessionId, turnId: c.turnId, attemptId: aId, origin: 'local', delivery: 'not-sent' });
      return responseFor(a);
    } catch (err) {
      if (!confirmed && !this.work.degraded) {
        this.attemptSettings.delete(boundKey);
        this.attemptPersonalization.delete(boundKey);
        this.attemptTimeZone.delete(boundKey);
        this.attemptRequestGeo.delete(boundKey);
        this.attemptCalendar.delete(boundKey);
        this.attemptIdentities.delete(boundKey);
      }
      throw err;
    } finally { await job.settled(); await p.owner.drain(); if (lease) await p.owner.release(lease); job.close(); }
  }
  private async cancelOwnedTurn(c: CancelTurnCommand): Promise<void> {
    const id = this.identity(c.identity); const p = this.d.persistence;
    const a = await latestAttempt(p, id.userId, c.sessionId, c.turnId);
    if (a.attemptId !== c.attemptId) throw new AppError('CONFLICT_ACTIVE_TURN', 'This attempt is no longer current.');
    this.receipts.delete(id.userId, c.sessionId, c.attemptId);
    this.confirmedState.delete(id.userId, c.sessionId);
    if (terminal(a.status) || a.status === 'finalizing') return;
    const active = this.work.get(id.userId, c.sessionId);
    if (active) { active.abort('CANCELLED'); return; } // Accepted response is request-owned cancellation acknowledgment, not terminal proof.
    const session = await p.sessions.get(id.userId, c.sessionId);
    if (!session || session.execution.ownerId !== null) throw new AppError('NOT_READY', 'Turn needs recovery before cancellation.');
    const job = this.work.open(id.userId, c.sessionId, new AbortController().signal, this.d.config.budgets.totalRunTimeoutMs);
    let lease: ExecutionLease | undefined;
    try {
      lease = await p.owner.recoverStoppedSession(id.userId, c.sessionId, null, 180000);
      await interruptAttempt({ p, lease, job, graph: await this.graph(lease), attempt: a, partial: '',
        error: new AppError('CANCELLED', 'Generation was cancelled.', false), assets: this.d.assets, budgets: this.d.config.budgets });
      const key = this.attemptKey(id.userId, c.sessionId, a.attemptId);
      this.attemptSettings.delete(key);
      this.attemptPersonalization.delete(key);
      this.attemptTimeZone.delete(key);
      this.attemptRequestGeo.delete(key);
      this.attemptCalendar.delete(key);
      this.attemptIdentities.delete(key);
    } finally { await job.settled(); await p.owner.drain(); if (lease) await p.owner.release(lease); job.close(); }
  }
  async cancelTurn(c: CancelTurnCommand): Promise<void> {
    const id = this.identity(c.identity);
    if (this.memoryFor(id.userId) && await this.memoryFor(id.userId)!.cancel(c)) return;
    await this.visibleTurn(id.userId, c.sessionId, c.turnId);
    return this.cancelOwnedTurn(c);
  }
  async skipTaskStep(c: CancelTurnCommand, stepId: string): Promise<void> {
    const id = this.identity(c.identity);
    const memory = this.memoryFor(id.userId);
    if (!memory) throw new AppError('NOT_FOUND', 'No running task.');
    await memory.skipTaskStep(c, stepId);
  }
  cancelLiveTurn(c: CancelTurnCommand, reservation: ExecutionReservation): Promise<void> {
    try {
      const id = this.identity(c.identity); this.reservations.assertLive(reservation, id, c.sessionId);
      if (this.memoryFor(id.userId)?.find(c.sessionId, c.turnId)) return this.memoryFor(id.userId)!.cancel(c, true).then(() => undefined);
      const active = this.work.get(id.userId, c.sessionId);
      if (active) { active.abort('CANCELLED'); return this.cancelOwnedTurn(c); }
      return this.getLiveTurnStatus(id.userId, c.sessionId, c.turnId, reservation).then(status => {
        if (status.attemptId !== c.attemptId) throw new AppError('CONFLICT_ACTIVE_TURN', 'This attempt is no longer current.');
        return this.cancelOwnedTurn(c);
      });
    } catch (error) { return Promise.reject(error); }
  }
  executeTurn(c: ExecuteTurn): Promise<void> {
    this.assertConversationAdmission(c.userId, c.sessionId);
    const run = () => {
      if (this.memoryFor(c.userId)?.find(c.sessionId, c.turnId)) {
        return this.memoryFor(c.userId)!.execute(c).then(() => undefined);
      }
      return this.executeOwnedTurn(c);
    };
    const started = this.d.diagnostics ? this.d.diagnostics.run({ sessionId: c.sessionId,
      turnId: c.turnId, attemptId: c.attemptId }, run) : run();
    const key = this.sessionKey(c.userId, c.sessionId);
    const set = this.executing.get(key) ?? new Set<Promise<void>>();
    this.executing.set(key, set);
    let tracked: Promise<void>;
    tracked = started.finally(() => {
      set.delete(tracked);
      if (!set.size && this.executing.get(key) === set) this.executing.delete(key);
    });
    set.add(tracked);
    return tracked;
  }
  /** Synchronous scoped purge fence; no new work starts while it is held. */
  assertConversationAdmission(u: string, s: string): void {
    const scope = this.sessionKey(u, s), expires = this.purgedUntil.get(scope);
    if (expires !== undefined && expires <= Date.now()) this.purgedUntil.delete(scope);
    if (this.purging.has(scope) || (expires !== undefined && expires > Date.now()))
      throw new AppError('NOT_FOUND', 'Chat not found.');
  }
  private hasScopedAcceptance(u: string, s: string): boolean {
    return this.scopedAcceptancePromises(u, s).length !== 0;
  }
  private scopedAcceptancePromises(u: string, s: string): Promise<SubmitTurnResponse>[] {
    return [...this.accepting.entries()].flatMap(([key, value]) => {
      const [owner, session] = JSON.parse(key) as [string, string, string];
      return owner === u && session === s ? [value.promise] : [];
    });
  }
  private scopedExecutionPromises(u: string, s: string): Promise<void>[] {
    return [...(this.executing.get(this.sessionKey(u, s)) ?? [])];
  }
  private clearScopedMemory(u: string, s: string): void {
    this.receipts.delete(u, s); this.confirmedState.delete(u, s);
    this.sessionCalendarMessages.delete(this.sessionKey(u, s));
    for (const key of [...this.attemptSettings.keys()]) {
      const [owner, session] = JSON.parse(key) as [string, string, string];
      if (owner !== u || session !== s) continue;
      this.attemptSettings.delete(key); this.attemptPersonalization.delete(key);
      this.attemptTimeZone.delete(key); this.attemptRequestGeo.delete(key);
      this.attemptCalendar.delete(key); this.attemptIdentities.delete(key);
    }
    const prefix = `${u}\0${s}\0`;
    for (const key of [...this.liveTurnKeys]) if (key.startsWith(prefix)) this.liveTurnKeys.delete(key);
  }
  private async purgeScoped(u: string, s: string,
    options: { cutoff?: string; stopTransport?: () => Promise<void> }): Promise<boolean> {
    const p = this.d.persistence;
    const memory = this.memoryFor(u);
    const fromRam = memory?.session(u, s);
    const row = fromRam ?? await p.sessions.get(u, s);
    if (!row || row.ephemeral !== true) return false;
    if (options.cutoff && (row.lastActivityAt >= options.cutoff || this.work.get(u, s) ||
        this.reservations.hasSession(u, s) || memory?.temporaryPurgeBusy(s) || this.hasScopedAcceptance(u, s))) return false;
    if (!options.cutoff) {
      this.work.get(u, s)?.abort('CANCELLED');
      const quiescent = await boundedResult(Promise.allSettled([
        ...(options.stopTransport ? [options.stopTransport()] : []),
        ...this.scopedAcceptancePromises(u, s), ...this.scopedExecutionPromises(u, s),
      ]), this.d.config.budgets.shutdownDrainMs);
      if (!quiescent.ok || this.work.get(u, s) || this.reservations.hasSession(u, s))
        throw new AppError('CONFLICT_ACTIVE_TURN', 'Wait for chat work to finish before deleting.');
      await memory?.settleTemporaryPurge(s);
    }
    const durable = await p.sessions.get(u, s);
    if (options.cutoff && durable && durable.lastActivityAt >= options.cutoff) return false;
    if (durable?.execution.ownerId || durable?.execution.activeAttemptId) {
      if (options.cutoff) return false;
      throw new AppError('NOT_READY', 'Temporary chat still has owned work.');
    }
    const unresolved = await p.calendarOperationsV2?.listUnresolvedBySession({ userId: u, sessionId: s, limit: 1 });
    if (unresolved?.overflow || unresolved?.operations.length) {
      if (options.cutoff) return false;
      throw new AppError('NOT_READY', 'Temporary chat has unresolved work.');
    }
    await p.owner.assertExecutor();
    await p.sessions.hardPurgeSession(u, s);
    memory?.dropTemporarySession(s);
    this.clearScopedMemory(u, s);
    if (this.purgedUntil.size >= 1024) {
      const oldest = this.purgedUntil.keys().next().value;
      if (oldest !== undefined) this.purgedUntil.delete(oldest);
    }
    this.purgedUntil.set(this.sessionKey(u, s), Date.now() + (this.d.memoryFirst?.policy.requestRetentionMs ?? 300_000));
    return true;
  }
  async purgeEphemeral(u: string, s: string,
    options: { cutoff?: string; stopTransport?: () => Promise<void> } = {}): Promise<boolean> {
    const scope = this.sessionKey(u, s);
    const existing = this.purging.get(scope);
    if (existing) {
      if (existing.explicit || options.cutoff) return options.cutoff && !existing.explicit ? false : existing.promise;
      const settled = await existing.promise.catch(() => false);
      if (settled) return true;
    }
    const tombstone = this.purgedUntil.get(scope);
    if (tombstone !== undefined && tombstone > Date.now()) return true;
    if (this.purging.size >= 16) throw new AppError('CONCURRENCY_LIMIT', 'Too many temporary deletions are pending.');
    const entry = { explicit: options.cutoff === undefined } as { explicit: boolean; promise: Promise<boolean> };
    let promise: Promise<boolean>;
    promise = this.purgeScoped(u, s, options).finally(() => {
      if (this.purging.get(scope)?.promise === promise) this.purging.delete(scope);
    });
    entry.promise = promise;
    this.purging.set(scope, entry);
    return promise;
  }
  private async executeOwnedTurn(c: ExecuteTurn): Promise<void> {
    const p = this.d.persistence; this.ready();
    const receipt = this.receipts.get(c.userId, c.sessionId, c.attemptId);
    let a: AttemptRecord;
    let acceptedInput: MessageRecord;
    if (receipt && receipt.turnId === c.turnId && receipt.attemptId === c.attemptId) {
      a = receipt.attempt.record;
      acceptedInput = receipt.input.record;
    } else {
      a = await latestAttempt(p, c.userId, c.sessionId, c.turnId);
      if (a.attemptId !== c.attemptId) throw new AppError('CONFLICT_ACTIVE_TURN', 'This attempt is no longer current.');
      const loaded = await p.messages.get(c.userId, c.sessionId, a.causal.userMessageId);
      if (!loaded) throw new AppError('NOT_READY', 'Accepted input needs recovery.');
      acceptedInput = loaded;
    }
    const internal = acceptedInput.visibility === 'internal' && acceptedInput.mode === 'live';
    if (this.memoryFor(c.userId) && !receipt) await this.assertPublished(a);
    if (c.live) {
      if (!internal) throw new AppError('NOT_FOUND', 'Turn not found.');
      this.reservations.assertLive(c.live.reservation, this.identity({ userId: c.userId,
        openRouterUser: c.userId, source: 'authenticated-session' }), c.sessionId);
    } else {
      if (acceptedInput.visibility === 'internal') throw new AppError('NOT_FOUND', 'Turn not found.');
      this.reservations.assertText(c.userId, c.sessionId);
    }
    if (terminal(a.status)) {
      const message = await p.messages.get(c.userId, c.sessionId, outputId(a));
      if (['completed', 'truncated'].includes(a.status)) {
        const session = await p.sessions.get(c.userId, c.sessionId);
        if (!session || !message || message.completionStatus !== a.status || message.truncated !== a.truncated)
          throw new AppError('NOT_READY', 'Saved completion evidence is unavailable.');
        // Read-only saver binding: this value grants no write ownership.
        const graph = await this.graph({ userId: c.userId, sessionId: c.sessionId, ownerId: p.owner.executorId,
          generation: session.execution.generation, leaseExpiresAt: this.now() });
        const snapshot = await graph.getState(graphConfig(c.userId, c.sessionId));
        const manifest = await p.memory.get(c.userId, c.sessionId);
        if (!manifest || snapshot.next.length || !isDeepStrictEqual(snapshot.values.boundary, boundaryFor(manifest)))
          throw new AppError('NOT_READY', 'Saved completion needs reconciliation.');
      }
      await c.emit(streamEnvelopeSchema.parse({ protocolVersion: 1, sessionId: c.sessionId, turnId: c.turnId,
        attemptId: a.attemptId, sequence: 0, event: { type: 'status', status: a.status, truncated: a.truncated } }));
      if (message && ['completed', 'truncated'].includes(a.status)) {
        let sequence = 1;
        for (let offset = 0; offset < message.content.length; offset += 1000) {
          await c.emit(streamEnvelopeSchema.parse({ protocolVersion: 1, sessionId: c.sessionId,
            turnId: c.turnId, attemptId: a.attemptId, sequence: sequence++, event: {
              type: 'delta', text: message.content.slice(offset, offset + 1000),
              ...(offset === 0 ? { reset: true as const } : {}),
            } }));
        }
        await c.emit(streamEnvelopeSchema.parse({
          protocolVersion: 1, sessionId: c.sessionId, turnId: c.turnId, attemptId: a.attemptId, sequence,
          event: { type: 'completed', assistantMessageId: message.messageId, outcome: a.status } }));
      }
      return;
    }
    if (a.status !== 'accepted') throw new AppError('NOT_READY', 'Turn requires reconciliation before it can run.');
    const boundKey = this.attemptKey(c.userId, c.sessionId, a.attemptId);
    const snapshot = this.attemptSettings.get(boundKey);
    if (!snapshot) throw new AppError('NOT_READY', 'Accepted settings are unavailable.');
    const limits = snapshot.modelLimits;
    if (!limits || a.modelId !== snapshot.openRouter.modelId) throw new AppError('NOT_READY', 'Accepted settings are unavailable.');

    if (c.live) this.reservations.assertLive(c.live.reservation, this.identity({ userId: c.userId,
      openRouterUser: c.userId, source: 'authenticated-session' }), c.sessionId);
    else this.reservations.assertText(c.userId, c.sessionId);
    const job = this.work.attach(c.userId, c.sessionId, c.signal, snapshot.budgets.totalRunTimeoutMs);
    const turnMode = createTurnModelMode(this.d.devMode, c.principal, c.userId, !c.localToolControl);
    const executionStarted = performance.now();
    let lease: ExecutionLease | undefined; let sequence = 0; let partial = ''; let graph: Awaited<ReturnType<DurableChatRuntime['graph']>> | undefined;
    let saved: SavedResult | null = null;
    let calendarActive = false;
    let savedCalendar = false;
    let calendarSnapshot: MessageRecord['calendarView'];
    let weatherSnapshot: MessageRecord['weatherView'];
    let interruptedAssistantSequence: number | undefined;
    // The live path carries the confirmed attempt receipt through the whole
    // lifecycle so every transition is a receipt scoped compare-and-set.
    let attemptReceipt: ConfirmedRecord<AttemptRecord> | null = null;
    let accountingReceipt: ConfirmedRecord<AccountingRecord> | null = null;
    let acceptanceMarker: AcceptanceRecord | null = null;
    let sourceRecords: readonly MessageRecord[] = [];
    let loadedSession: import('../contracts/session.js').SessionRecord | null | undefined;
    const responseMode: ResponseMode = c.live ? 'voice' : 'text';
    const responseId = key('voice-response', c.userId, c.sessionId, c.attemptId);
    const acceptedArtifacts: CanvasArtifactProjection[] = [];
    const pendingArtifacts: CanvasArtifactProjection[] = [];
    let lastConfirmedArtifacts: CanvasArtifactProjection[] | undefined;
    let lastConfirmedDelivery: VoiceDeliveryRecord | null = null;
    let deliveryWriteFailed = false;
    let speechClosed = false;
    const prose = c.live ? new SpeechProse(
      Math.min(32000, snapshot.budgets.maxInputChars),
      (source: CanvasArtifactSource) => {
        if (deliveryWriteFailed) return;
        const candidate: CanvasArtifactProjection = { ...source, responseId };
        const proposed = [...acceptedArtifacts, ...pendingArtifacts, candidate];
        if (proposed.length <= CANVAS_ARTIFACT_LIMITS.maxArtifactsPerResponse && isCanvasArtifactProjectionList(proposed)) {
          pendingArtifacts.push(candidate);
        }
      },
      () => turnMode?.frozen()?.mode !== 'dev'
    ) : null;
    let deliveryStarted = false;
    let memoryUpdated = false;
    const emit = async (event: StreamEvent) => {
      job.check();
      const envelope = streamEnvelopeSchema.parse({ protocolVersion: 1, sessionId: c.sessionId, turnId: c.turnId,
        attemptId: c.attemptId, sequence: sequence++, event });
      try { await job.wait(c.emit(envelope), snapshot.budgets.idleStreamTimeoutMs); }
      catch { job.abort('INTERRUPTED'); throw job.failure(); }
    };
    let pendingConfirmedState: ConfirmedSessionState | null = null;
    try {
      let input: MessageRecord;
      let reservation: { start: number; count: number };
      let context: AssembledContext;
      let contextSources: ContextSourceSnapshot;
      let owned: ExecutionLease;
      let contextPreparedViaReceipt = false;
      let attachedThisRun = false;
      let baseManifestReceipt: ConfirmedRecord<AgentMemoryManifest> | null = null;
      const assembler = this.assemblerFor(snapshot);
      const personalization = this.attemptPersonalization.get(boundKey)
        ?? receipt?.personalization
        ?? this.personalizationFor(c.userId);
      const clientTimeZone = this.attemptTimeZone.get(boundKey)
        ?? receipt?.clientTimeZone
        ?? null;
      if (receipt && p.owner.attachAccepted) {
        attachedThisRun = true;
        const attached = await p.owner.attachAccepted({
          userId: c.userId,
          sessionId: c.sessionId,
          attemptId: a.attemptId,
          expectedGeneration: receipt.releasedGeneration,
          leaseMs: 180000,
        });
        lease = attached.lease;
        loadedSession = attached.session;
        owned = lease;
        job.startHeartbeat(async () => { lease = await job.wait(p.owner.renew(owned, 180000), this.d.config.budgets.persistenceTimeoutMs); });
        input = receipt.input.record;
        reservation = receipt.reservation;
        attemptReceipt = receipt.attempt;
        acceptanceMarker = receipt.acceptance;
        const reused = await this.inPhase('context', () =>
          this.reuseAdmittedContext(owned, job, receipt, a, input.content, responseMode, assembler, snapshot, personalization, clientTimeZone));
        if (reused) {
          context = reused.context;
          contextSources = reused.source;
          baseManifestReceipt = reused.manifestReceipt;
          contextPreparedViaReceipt = true;
        } else {
          const boundRes = await this.inPhase('context', () =>
            this.checkBoundary(owned, job, a.turnId, input.content, responseMode, assembler, a.attemptId, personalization, clientTimeZone));
          context = boundRes.context;
          contextSources = boundRes.source;
        }
      } else {
        const session = await p.sessions.get(c.userId, c.sessionId);
        loadedSession = session;
        if (!session || session.execution.activeAttemptId !== a.attemptId || session.execution.ownerId !== null)
          throw new AppError('CONFLICT_ACTIVE_TURN', 'Another request owns this turn.');
        lease = await p.owner.recoverStoppedSession(c.userId, c.sessionId, null, 180000);
        owned = lease;
        job.startHeartbeat(async () => { lease = await job.wait(p.owner.renew(owned, 180000), this.d.config.budgets.persistenceTimeoutMs); });
        const strictInput = await p.messages.get(c.userId, c.sessionId, a.causal.userMessageId);
        const marker = await p.metadata.getAcceptance(c.userId, c.sessionId, a.attemptId);
        if (!strictInput || !marker || strictInput.turnId !== a.turnId || hashPayload(strictInput.content) !== a.payloadHash)
          throw new AppError('NOT_READY', 'Accepted input needs recovery.');
        input = strictInput;
        acceptanceMarker = marker;
        const boundRes = await this.inPhase('context', () =>
          this.checkBoundary(owned, job, a.turnId, input.content, responseMode, assembler, a.attemptId, personalization, clientTimeZone));
        context = boundRes.context;
        contextSources = boundRes.source;
        reservation = await p.owner.allocateSequences(owned, a.attemptId, a.causal.previousAttemptId === null ? 3 : 2);
      }
      if (context.contextVersion !== a.contextVersion || context.instructionVersion !== a.instructionVersion ||
        context.knowledgeContentHash !== a.knowledgeContentHash || context.graphSchemaVersion !== a.graphSchemaVersion)
        throw new AppError('NOT_READY', 'Accepted context versions changed.');
      const assistantSequence = reservation.start + (a.causal.previousAttemptId === null ? 2 : 1);
      const graphInput: GraphInput = { attempt: a, assistantSequence };
      interruptedAssistantSequence = assistantSequence;
      const messageLimit = Math.min(snapshot.budgets.maxMessageBytes, p.messages.budgets.maxMessageBytes);
      let generatedAt: string | undefined;
      const buildAssistantMessage = (artifacts?: CanvasArtifactProjection[], isTruncated = false): MessageRecord => ({
        schemaVersion: 1,
        userId: a.userId,
        sessionId: a.sessionId,
        turnId: a.turnId,
        attemptId: a.attemptId,
        messageId: outputId(a),
        eventId: eventIdFor(a.userId, a.sessionId, outputId(a)),
        sequence: assistantSequence,
        role: 'assistant',
        content: partial,
        createdAt: generatedAt ?? this.now(),
        completionStatus: isTruncated ? 'truncated' : 'streaming',
        truncated: isTruncated,
        ...(internal ? {
          visibility: 'internal' as const,
          mode: 'live' as const,
          ...(input.voiceSessionId ? { voiceSessionId: input.voiceSessionId } : {}),
        } : {}),
        ...(artifacts?.length ? { canvasArtifacts: artifacts } : {}),
        ...(calendarSnapshot ? { calendarView: calendarSnapshot } : {}),
        ...(memoryUpdated ? { memoryUpdated: true as const } : {}),
      });
      const assertArtifactMessageFits = (artifacts: CanvasArtifactProjection[]) => {
        const candidate = buildAssistantMessage(artifacts);
        bounded(messageRecordSchema, candidate, key('message', a.userId, a.sessionId, candidate.messageId), messageLimit);
      };
      const publishFiltered = async (text: string) => {
        if (text) {
          partial += text;
          await c.live?.delta(text);
          await emit({ type: 'delta', text });
        }
        if (prose?.visualSuffixStarted && !speechClosed) {
          speechClosed = true;
          await c.live?.finish();
        }
        while (pendingArtifacts.length) {
          job.check();
          const artifact = pendingArtifacts.shift()!;
          if (!c.live?.artifact) throw new AppError('NOT_READY', 'Visual delivery is unavailable.');
          const next = [...acceptedArtifacts, artifact];
          assertArtifactMessageFits(next);
          if (await c.live.artifact(artifact)) acceptedArtifacts.push(artifact);
        }
      };
      await emit({ type: 'turn-accepted', userMessageId: input.messageId });
      const startLiveDelivery = async () => {
        if (!c.live) return;
        await c.live.start(a, async (record, expectedSequence) => {
          if (deliveryWriteFailed) throw new AppError('PERSISTENCE_ERROR', 'Delivery write previously failed.');
          if (record.userId !== a.userId || record.sessionId !== a.sessionId || record.turnId !== a.turnId || record.attemptId !== a.attemptId || record.responseId !== responseId)
            throw new AppError('INVALID_REQUEST', 'Delivery scope is invalid.');
          if (expectedSequence === undefined) {
            if (record.canvasArtifacts !== undefined)
              throw new AppError('INVALID_REQUEST', 'Initial delivery journal must not contain artifacts.');
          } else {
            const current = record.canvasArtifacts;
            const prev = lastConfirmedArtifacts ?? [];
            if (current !== undefined) {
              if (!isCanvasArtifactProjectionList(current))
                throw new AppError('INVALID_REQUEST', 'Invalid canvas artifact projection list in delivery journal.');
              if (current.some(art => art.responseId !== responseId))
                throw new AppError('INVALID_REQUEST', 'Artifact response ID mismatch.');
              if (current.length < prev.length)
                throw new AppError('INVALID_REQUEST', 'Artifacts cannot be removed.');
              for (let i = 0; i < prev.length; i++) {
                if (JSON.stringify(current[i]) !== JSON.stringify(prev[i]))
                  throw new AppError('INVALID_REQUEST', 'Artifact list prefix mismatch.');
              }
            } else if (prev.length > 0) {
              throw new AppError('INVALID_REQUEST', 'Confirmed artifacts cannot be removed.');
            }
          }
          try {
          await job.wait(p.owner.run(owned, async () => {
            const linkage = receipt?.turnId === a.turnId && receipt.responseMode === 'voice' && attemptReceipt
              ? { attempt: attemptReceipt, input: receipt.input } : undefined;
            if (expectedSequence === undefined) await p.metadata.putVoiceDelivery(record, linkage);
            else if (!await p.metadata.compareVoiceDelivery(record, expectedSequence, linkage))
              throw new AppError('CONFLICT_ACTIVE_TURN', 'Delivery evidence changed.');
          }), this.d.config.budgets.persistenceTimeoutMs);
            lastConfirmedArtifacts = record.canvasArtifacts ? structuredClone(record.canvasArtifacts) : undefined;
            lastConfirmedDelivery = structuredClone(record);
          } catch (error) {
            deliveryWriteFailed = true;
            throw error;
          }
        });
        deliveryStarted = true;
      };
      if (c.live && p.owner.runPhase) {
        const [, generating] = await p.owner.runPhase(
          owned,
          {
            name: 'generation-start',
            maxOperations: 4,
            deadlineAt: Math.min(
              Date.now() + this.d.config.budgets.persistenceTimeoutMs,
              Date.parse(owned.leaseExpiresAt) - 1000,
            ),
          },
          () => Promise.all([startLiveDelivery(), advanceAttempt(p, owned, job, a, attemptReceipt, 'generating')]),
        );
        a = generating.attempt;
        attemptReceipt = generating.receipt;
      } else {
        await startLiveDelivery();
        const generating = await advanceAttempt(p, owned, job, a, attemptReceipt, 'generating');
        a = generating.attempt;
        attemptReceipt = generating.receipt;
      }
      await emit({ type: 'status', status: 'generating', truncated: false });
      const manifest = contextSources.manifest;
      if (!manifest) throw new AppError('NOT_READY', 'Chat context needs recovery.');
      const calendarEligible = !internal || Boolean(c.live && input.mode === 'live' && input.voiceSessionId);
      const nativeEnabled = Boolean(snapshot.modelLimits?.calendar?.tools);
      const calendarWindow = calendarEligible && nativeEnabled
        ? (this.attemptCalendar.get(boundKey)
          ?? await p.calendarAccountingV2?.getBudget(c.userId, c.sessionId, a.turnId)
          ?? { createdAt: input.createdAt,
            deadlineAt: new Date(Date.parse(input.createdAt) + snapshot.budgets.totalRunTimeoutMs).toISOString() })
        : null;
      if (calendarWindow) {
        calendarActive = true;
        if (!c.emitCalendar) throw new AppError('NOT_READY', 'Calendar stream support is required.');
        const releaseState = { finished: false };
        this.receipts.delete(c.userId, c.sessionId, a.attemptId);
        await this.runCalendarTurn({
          command: c, attempt: a, input, snapshot, job, owned, graphInput, manifest,
            context, assistantSequence, attemptReceipt, acceptance: acceptanceMarker,
            window: { createdAt: calendarWindow.createdAt, deadlineAt: calendarWindow.deadlineAt },
            sourceRecords: contextSources.records, session: loadedSession,
            turnMode,
            clientTimeZone,
            requestGeo: this.attemptRequestGeo.get(boundKey) ?? null,
            personalization,
            captureView: value => { calendarSnapshot = value; },
            captureWeather: value => { weatherSnapshot = value; },
            emitStream: event => emit(event).catch(() => undefined),
            voiceOutput: c.live ? {
              delta: async text => { c.live!.modelOutput?.(); await publishFiltered(prose!.push(text)); },
              complete: async (narration, unstreamed) => {
                // Local proposal/error paths may seal without emitting any model delta.
                if (unstreamed) await publishFiltered(prose!.push(narration));
                await publishFiltered(prose!.finish());
                if (!speechClosed) { speechClosed = true; await c.live!.finish(); }
                // Required delivery settlement must occur while the owned lease still
                // exists; runCalendarTurn's release callback clears that lease.
                await c.live!.settle(partial, job.signal);
                return partial;
              },
              fields: () => ({ mode: 'live', visibility: 'internal', voiceSessionId: input.voiceSessionId,
                ...(acceptedArtifacts.length ? { canvasArtifacts: [...acceptedArtifacts] } : {}) }),
            } : undefined,
            // The combined terminal release clears the owner and the slot; the
            // enclosing release callback then only drops the local lease reference.
            releaseState,
            release: async () =>
              this.inPhase('release', async () => {
                await p.owner.drain();
                if (!releaseState.finished) await p.owner.release(owned);
                lease = undefined; job.close();
                const releaseDuration = performance.now() - executionStarted;
                diagnose(this.d.diagnostics?.emit, { stage: 'slot-release', state: 'ok',
                  durationMs: releaseDuration, origin: 'local', delivery: 'not-sent' });
                diagnose(this.d.diagnostics?.emit, { stage: 'slot-released', state: 'ok',
                  durationMs: releaseDuration, origin: 'local', delivery: 'not-sent' });
              }),
        });
        return;
      }
      const maxVisibleBytes = this.outputBudget(a, assistantSequence, internal, messageLimit);
      if (context.messages.some(m => Buffer.byteLength(m.content, 'utf8') > maxVisibleBytes))
        throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The answer cannot fit in storage.');
      if (a.openRouterUser !== a.userId)
        throw new AppError('IDENTITY_OVERRIDE_REJECTED', 'Identity is resolved by the server.');
      const attemptConfig: ModelConfig = {
        identity: { userId: a.userId },
        openRouter: snapshot.openRouter,
        budgets: { ...snapshot.budgets, maxMessageBytes: maxVisibleBytes },
      };
      const services = createModelServices(attemptConfig, limits, { putAccounting: record =>
        this.inPhase('model-observation', () =>
          job.wait(p.owner.run(owned, async () => {
            if (p.metadata.putAccountingConfirmed) {
              accountingReceipt = await p.metadata.putAccountingConfirmed(record, accountingReceipt ?? undefined);
              return;
            }
            await p.metadata.putAccounting(record);
           }), this.d.config.budgets.persistenceTimeoutMs)) }, this.d.fetcher, Math.random, this.d.diagnostics?.emit, {
             track: promise => job.track(promise),
             fail: _err => { job.abort('INTERRUPTED'); },
             identityBarrier: action => p.owner.runPhase
               ? p.owner.runPhase(owned, { name: 'model-observation', maxOperations: 2,
                   deadlineAt: Math.min(Date.now() + this.d.config.budgets.persistenceTimeoutMs, Date.parse(owned.leaseExpiresAt) - 1000) }, action)
               : action(),
             nonBlockingStream: Boolean(c.live),
           });
      const attemptSeed: AccountingRecord = { schemaVersion: 1, kind: 'accounting', userId: a.userId,
        sessionId: a.sessionId, turnId: a.turnId, attemptId: a.attemptId, generationId: null,
        requestedModel: a.modelId, reportedModel: null, reportedProvider: null, promptTokens: null,
        completionTokens: null, cost: null, accountingStatus: 'unknown', outcome: 'generating', startedAt: a.createdAt, endedAt: null };
      const adapter = services.createAttemptAdapter(attemptSeed,
        async generationId => {
          // Text awaits this write and its parallel accounting write inside one ownership phase.
          const identified = await this.inPhase('model-observation', () =>
            advanceAttempt(p, owned, job, a, attemptReceipt, 'generating', null, { generationId }));
          a = identified.attempt; attemptReceipt = identified.receipt;
        });
      let projected: AssembledContext = context;
      const prepareTurn = (current: GraphInput) => this.inPhase('context', async () => {
        job.check();
        if (current.attempt.attemptId !== a.attemptId) throw new AppError('INTERRUPTED', 'Execution ownership was lost.');
        if (!attachedThisRun && !await p.owner.fence(owned)) throw new AppError('INTERRUPTED', 'Execution ownership was lost.');
        if (!(c.live && attachedThisRun && contextPreparedViaReceipt)) {
          if (!isDeepStrictEqual(await p.memory.get(a.userId, a.sessionId), contextSources.manifest))
            throw new AppError('NOT_READY', 'Chat context changed before inference.');
        }
        if (contextPreparedViaReceipt) {
          projected = context;
          return;
        }
        const assembled = await assembler.assemble({ userId: a.userId, sessionId: a.sessionId,
          turnId: a.turnId, newUserInput: input.content, responseMode, environment: this.environmentContext(a.userId, clientTimeZone),
          personalization }, contextSources);
        if (!assembled.ok) throw new AppError('CONTEXT_BUDGET_EXCEEDED', assembled.overflow.message, false);
        if (!isDeepStrictEqual(assembled.context, context)) throw new AppError('NOT_READY', 'Chat context changed before inference.');
        projected = assembled.context;
      });
      const generateTurn = async (current: GraphInput): Promise<SavedResult> => {
          let ended = false; let length = false;
          let accounting: AccountingRecord | undefined;
          const dispatch: TurnModelDispatch | undefined = turnMode ? {
            handle: turnMode, rawInput: input.content,
            project: decision => projectTurnMessages(projected.messages, projected.messages.length - 1,
              projected as PositionedContext, decision),
          } : undefined;
          c.live?.modelStarted?.();
          const memoryAction = this.explicitMemory(loadedSession, a.turnId, snapshot, turnMode, c.localToolControl);
          const useNativeMemory = Boolean(memoryAction && !limits.calendar?.tools);
          if (useNativeMemory && memoryAction) {
            const native = createWebNativeModelPort({ ...attemptConfig, sessionId: a.sessionId },
              limits, this.d.fetcher, this.d.diagnostics?.emit);
            const records: AccountingRecord[] = [];
            let messages: readonly WebNativeMessage[] = projected.messages;
            const prefixCount = (projected as PositionedContext).prefixCount;
            const deadlineAt = new Date(Date.parse(a.createdAt) + snapshot.budgets.totalRunTimeoutMs).toISOString();
            const sendText = async (text: string) => {
              c.live?.modelOutput?.();
              await publishFiltered(prose ? prose.push(text) : text);
            };
            for (let index = 0; index < 2 && !ended; index++) {
              job.check();
              const tools = memoryAction.allowed() ? [UPDATE_USER_MEMORY_TOOL_DEFINITION] : [];
              const admitted = admitNativePrompt({ messages, prefixCount, tools,
                budgets: snapshot.budgets, contextTokens: limits.contextTokens });
              let run: AccountingRecord = { ...attemptSeed, startedAt: this.now() };
              let candidate: WebNativeDecision | undefined;
              let failed = false;
              for await (const chunk of dispatchStream(native, { messages: admitted.messages, tools, deadlineAt,
                modelId: a.modelId, user: a.openRouterUser, maxOutputTokens: snapshot.budgets.maxOutputTokens,
                remainingContextTokens: admitted.remainingContextTokens, signal: job.signal,
                dataCollection: 'deny', advertised: false, memoryAllowed: memoryAction.allowed,
                observeUsage: raw => {
                  const frame = object(raw);
                  run = mergeUsage({ ...run, generationId: identifier(frame.id) ?? run.generationId,
                    reportedModel: identifier(frame.model) ?? run.reportedModel,
                    reportedProvider: identifier(frame.provider) ?? run.reportedProvider }, frame.usage);
                },
              }, dispatch && { ...dispatch, project: decision => {
                const userIndex = admitted.messages.findLastIndex(message => message.role === 'user');
                return projectTurnMessages(admitted.messages as readonly ContextChatMessage[], userIndex,
                  projected as PositionedContext, decision);
              } })) {
                job.check();
                if (chunk.type === 'decision') candidate = chunk.decision;
                else if (chunk.type === 'failure') failed = true;
                else await sendText(chunk.text);
              }
              records.push(run);
              if (index === 0 && run.generationId) {
                const identified = await advanceAttempt(p, owned, job, a, attemptReceipt,
                  'generating', null, { generationId: run.generationId });
                a = identified.attempt; attemptReceipt = identified.receipt;
              }
              if (candidate?.kind === 'text' && !failed) {
                ended = true; length = candidate.truncated;
              } else if (!failed && index === 0 &&
                  (candidate?.kind === 'update_user_memory' || candidate?.kind === 'memory-secret')) {
                const proof = memoryReceiptHeadroom(memoryCallId(candidate));
                admitNativePrompt({ messages: [...messages, proof.assistant, proof.result], prefixCount, tools: [],
                  budgets: snapshot.budgets, contextTokens: limits.contextTokens });
                const remaining = Date.parse(deadlineAt) - Date.now();
                if (remaining <= 0) throw new AppError('TIMEOUT', 'The turn deadline has passed.', false);
                const signal = AbortSignal.any([job.signal, AbortSignal.timeout(remaining)]);
                const pair = await job.track(memoryAction.run(candidate, signal));
                const receipt = memoryAction.receipt();
                memoryUpdated = receipt?.ok === true && receipt.status === 'updated';
                job.check();
                messages = [...messages, pair.assistant, pair.result];
              } else if (memoryAction.receipt() || candidate?.kind === 'memory-invalid') {
                await sendText(memoryReceiptText(memoryAction.receipt()));
                ended = true;
              } else throw new AppError('PROVIDER_ERROR', 'The model service could not answer.', false);
            }
            const total = (name: 'promptTokens' | 'completionTokens' | 'cost') =>
              records.every(row => row[name] !== null)
                ? records.reduce((sum, row) => sum + (row[name] ?? 0), 0) : null;
            accounting = mergeUsage({ ...attemptSeed, generationId: a.generationId, outcome: 'generating', endedAt: this.now(),
              reportedModel: records.every(r => r.reportedModel === records[0]?.reportedModel)
                ? records[0]?.reportedModel ?? null : null,
              reportedProvider: records.every(r => r.reportedProvider === records[0]?.reportedProvider)
                ? records[0]?.reportedProvider ?? null : null,
            }, { prompt_tokens: total('promptTokens'), completion_tokens: total('completionTokens'), cost: total('cost') });
          } else {
          await this.inPhase('model-observation', async () => {
            for await (const chunk of dispatchStream(adapter, { modelId: a.modelId, user: a.openRouterUser, messages: projected.messages,
              maxOutputTokens: snapshot.budgets.maxOutputTokens, abortSignal: job.signal, transforms: [],
              dataCollection: snapshot.openRouter.dataCollection }, dispatch)) {
              job.check();
              if (ended) throw new AppError('PROVIDER_ERROR', 'The model response was invalid.', false);
              switch (chunk.type) {
                case 'comment': break;
                case 'generation-id': if (!c.live && a.generationId !== chunk.generationId) throw new AppError('PERSISTENCE_ERROR', 'Generation identity was not saved.', false); break;
                case 'delta': {
                  c.live?.modelOutput?.();
                  const text = prose ? prose.push(chunk.text) : chunk.text;
                  await publishFiltered(text);
                  break;
                }
                case 'usage': await emit({ ...chunk }); break;
                case 'length': length = true; break;
                case 'error': throw new AppError('PROVIDER_ERROR', 'The model service could not answer.', false);
                case 'end': ended = true; break;
              }
            }
          });
          }
          if (!ended) throw new AppError('INTERRUPTED', 'The response stream ended early.', false);
          if (!a.generationId) throw new AppError('PERSISTENCE_ERROR', 'Generation identity was not saved.', false);
          const tail = prose?.finish() ?? '';
          await publishFiltered(tail);
          if (!speechClosed) {
            speechClosed = true;
            await c.live?.finish();
          }
          if (!accounting) accounting = adapter.accounting.snapshot(a.userId, a.sessionId, a.attemptId) ?? undefined;
          if (!accounting) throw new AppError('PERSISTENCE_ERROR', 'The model accounting was not saved.', false);
          generatedAt = accounting.endedAt ?? undefined;
          const assistant = buildAssistantMessage(acceptedArtifacts.length ? acceptedArtifacts : undefined);
          bounded(messageRecordSchema, assistant, key('message', a.userId, a.sessionId, assistant.messageId), messageLimit);
          // Keep the complete source snapshot, not the prompt's selected history
          // (which excludes the current retry input). Mutable sources still refresh.
          const reusable = contextSources.records.length === manifest.messageRefs.length
            ? mergeAdmissionSourceRecords(manifest, contextSources.records, []) : null;
          const history = reusable && (
            (c.live && attachedThisRun && contextPreparedViaReceipt) ||
            !reusable.some(m => this.isCalendarOrUncertain(a.userId, a.sessionId, m) || m.voiceTranscripts?.length)
          ) && isDeepStrictEqual(buildReferenceManifest(a.userId, a.sessionId, manifest.contextVersion,
            reusable, this.d.assets, p.memory.budgets, manifest.activeSummaryRef, manifest.pinnedUserMemory), manifest)
            ? reusable
            : await this.inPhase('seal', () => p.messages.getReferences(a.userId, a.sessionId, manifest.messageRefs));
          if (!mergeAdmissionSourceRecords(manifest, history, []) || history.length !== manifest.messageRefs.length ||
            !isDeepStrictEqual(buildReferenceManifest(a.userId, a.sessionId, manifest.contextVersion,
              history, this.d.assets, p.memory.budgets, manifest.activeSummaryRef, manifest.pinnedUserMemory), manifest))
            throw new AppError('NOT_READY', 'Chat context needs recovery.');
          sourceRecords = history;
          const target = buildReferenceManifest(a.userId, a.sessionId, manifest.contextVersion + 1,
            [...history.filter(m => m.messageId !== input.messageId), input,
              { ...assistant, completionStatus: length ? 'truncated' : 'completed', truncated: length }], this.d.assets, p.memory.budgets, manifest.activeSummaryRef, manifest.pinnedUserMemory);
          return { input: current, assistant, accounting, base: boundaryFor(manifest), target, outcome: length ? 'truncated' : 'completed' };
      };
      let precomputedVoiceResult: SavedResult | null = null;
      if (c.live && attachedThisRun && contextPreparedViaReceipt) {
        await prepareTurn(graphInput);
        precomputedVoiceResult = await generateTurn(graphInput);
      }
      graph = buildTurnGraph((await p.checkpoints.create()).bind(owned), {
        prepare: async current => {
          if (precomputedVoiceResult) return;
          await prepareTurn(current);
        },
        generate: async current => precomputedVoiceResult ?? generateTurn(current),
      });
      await this.inPhase('seal', () => job.wait(graph!.invoke({ input: graphInput, result: null, sealed: false, rebase: null }, { ...graphConfig(a.userId, a.sessionId), signal: job.signal }),
        snapshot.budgets.totalRunTimeoutMs));
      const complete = await this.inPhase('seal', () => graph!.getState(graphConfig(a.userId, a.sessionId)));
      if (!complete.values.sealed || complete.next.length || !complete.values.result || !complete.config.configurable?.checkpoint_id)
        throw new AppError('PERSISTENCE_ERROR', 'The graph save could not be confirmed.', false);
      const finalResult = resultSchema.parse(complete.values.result);
      saved = finalResult;
      const finalizing = await this.inPhase('publication', () => advanceAttempt(p, owned, job, a, attemptReceipt, 'finalizing'));
      a = finalizing.attempt; attemptReceipt = finalizing.receipt;
      const finalizationStarted = performance.now();
      diagnose(this.d.diagnostics?.emit, { stage: 'finalization', state: 'start', origin: 'local', delivery: 'not-sent' });
      // Saved result now wins over cancellation/disconnect; a failed sink is not a failed answer.
      try { await emit({ type: 'status', status: 'finalizing', truncated: false }); } catch { /* Durable finalization proceeds. */ }
      // The live path publishes the evidence it already holds; recovery omits it
      // and keeps the strict saved-result validation.
      const activityUpdatedByFinish = activityUpdatedByFinishCommitment({
        live: Boolean(c.live),
        finishAttempt: (p.owner as ExecutionOwnership).finishAttempt,
        attemptReceipt,
        compareAttemptConfirmed: (p.metadata as { compareAttemptConfirmed?: unknown }).compareAttemptConfirmed,
      });
      let targetManifestReceipt: ConfirmedRecord<AgentMemoryManifest> | null = null;
      let finalCheckpointId: string | null = null;
      const evidence: LivePublicationEvidence | undefined = acceptanceMarker
        ? {
            acceptedInput: input, acceptance: acceptanceMarker, baseManifest: manifest,
            sourceRecords, confirmedSnapshot: complete, attemptReceipt, accountingReceipt,
            ...(c.live ? { voiceDelivery: lastConfirmedDelivery } : {}),
            onAttemptConfirmed: next => { attemptReceipt = next; },
            onManifestConfirmed: nextReceipt => { targetManifestReceipt = nextReceipt; },
            onBoundaryConfirmed: cid => { finalCheckpointId = cid; },
            ...(baseManifestReceipt && isDeepStrictEqual(baseManifestReceipt.record, manifest)
              ? { baseManifestReceipt }
              : {}),
            ...(activityUpdatedByFinish ? { activityUpdatedByFinish } : {}),
          }
        : undefined;
      a = await this.inPhase('publication', () => publishResult(p, owned, job, graph!, a, finalResult, evidence));
      diagnose(this.d.diagnostics?.emit, { stage: 'attempt-terminal-durable', state: 'ok', origin: 'local', delivery: 'not-sent' });
      if (!c.live) await job.stopHeartbeat();
      await job.settled();
      // The activity touch, the attempt slot and the lease release are one
      // atomic session compare-and-set on a durable success.
      // Voice still journals playback after transcript publication. Keep its lease
      // until settle() drains; the text-only combined finish releases it too early.
      const finish = !c.live ? (p.owner as ExecutionOwnership).finishAttempt : undefined;
      await this.inPhase('release', () => job.wait(
        finish && attemptReceipt
          ? finish.call(p.owner, owned, attemptReceipt, finalResult.assistant.createdAt)
          : p.owner.clearAttempt(owned, a.attemptId), this.d.config.budgets.persistenceTimeoutMs));
      const finished = Boolean(finish && attemptReceipt);
      const boundaryCheckpointId = finalCheckpointId ?? snapshotCheckpointId(complete);
      if (boundaryCheckpointId && isPinnedCheckpointId(c.sessionId, boundaryCheckpointId)) {
        const completedAssistant: MessageRecord = {
          ...finalResult.assistant,
          completionStatus: finalResult.outcome,
          truncated: finalResult.outcome === 'truncated',
        };
        const allRecords = [
          ...sourceRecords.filter(m => m.messageId !== input.messageId),
          input,
          completedAssistant,
        ];
        for (const m of allRecords) {
          if (m.sourceProvenance?.length || m.content === CALENDAR_TOMBSTONE) {
            this.trackCalendarMessage(c.userId, c.sessionId, m.messageId);
          }
        }
        for (const m of allRecords) {
          if (m.role === 'assistant' && this.isCalendarOrUncertain(c.userId, c.sessionId, m)) {
            this.trackCalendarMessage(c.userId, c.sessionId, m.messageId);
          }
        }
        if (!this.sessionCalendarMessages.has(this.sessionKey(c.userId, c.sessionId))) {
          this.trackCleanSession(c.userId, c.sessionId);
        }
        const calendarMessageIds = Array.from(this.sessionCalendarMessages.get(this.sessionKey(c.userId, c.sessionId))?.calendarMessageIds ?? []);
        const plainRecords: MessageRecord[] = [];
        const refreshRefs: MessageRef[] = [];
        for (const m of allRecords) {
          const isCalendarAnswer = this.isCalendarOrUncertain(c.userId, c.sessionId, m);
          if (isCalendarAnswer || m.voiceTranscripts?.length) {
            refreshRefs.push({ messageId: m.messageId, eventId: m.eventId, sequence: m.sequence });
          } else {
            plainRecords.push(m);
          }
        }
        pendingConfirmedState = {
          userId: c.userId,
          sessionId: c.sessionId,
          executorId: p.owner.executorId,
          sessionGeneration: owned.generation,
          turnId: a.turnId,
          attemptId: a.attemptId,
          manifest: finalResult.target,
          checkpointId: boundaryCheckpointId,
          plainRecords,
          refreshRefs,
          instructionVersion: this.d.assets.instructionVersion,
          knowledgeContentHash: this.d.assets.knowledgeContentHash,
          graphSchemaVersion: this.d.assets.graphSchemaVersion,
          confirmedAt: Date.now(),
          expiresAt: Date.now() + 300_000,
          manifestReceipt: targetManifestReceipt,
          calendarMessageIds,
        };
      }
      // The completion timing is emitted through bounded telemetry after the
      // required durability; it is no longer a second accounting write.
      const providerEndedAt = finalResult.accounting.timing?.providerEndedAt ?? null;
      const completionMs = providerEndedAt
        ? Math.max(0, Date.parse(this.now()) - Date.parse(providerEndedAt))
        : performance.now() - finalizationStarted;
      diagnose(this.d.diagnostics?.emit, { stage: 'finalization', state: 'ok', durationMs: completionMs, origin: 'local', delivery: 'not-sent' });
      diagnose(this.d.diagnostics?.emit, { stage: 'task-outcome', task: 'not-applicable',
        writeCertainty: 'not-applicable', origin: 'local', delivery: 'not-sent' });
      diagnose(this.d.diagnostics?.emit, { stage: 'terminal', chat: a.status === 'truncated' ? 'truncated' : 'completed' });
      this.attemptSettings.delete(boundKey);
      this.attemptPersonalization.delete(boundKey);
      this.attemptTimeZone.delete(boundKey);
        this.attemptRequestGeo.delete(boundKey);
      this.attemptCalendar.delete(boundKey);
      this.attemptIdentities.delete(boundKey);
      this.receipts.delete(c.userId, c.sessionId, a.attemptId);
      if (!c.live) {
        await this.inPhase('release', async () => {
          await p.owner.drain();
          // The combined terminal release already cleared the owner and the slot.
          if (!finished) await p.owner.release(owned);
          lease = undefined; job.close();
        });
        const releaseDuration = performance.now() - executionStarted;
        diagnose(this.d.diagnostics?.emit, { stage: 'slot-release', state: 'ok',
          durationMs: releaseDuration, origin: 'local', delivery: 'not-sent' });
        diagnose(this.d.diagnostics?.emit, { stage: 'slot-released', state: 'ok',
          durationMs: releaseDuration, origin: 'local', delivery: 'not-sent' });
        if (pendingConfirmedState) {
          this.confirmedState.put(pendingConfirmedState);
          pendingConfirmedState = null;
        }
      }
      try {
        await emit({ type: 'status', status: a.status, truncated: a.truncated });
        await emit({ type: 'completed', assistantMessageId: finalResult.assistant.messageId, outcome: finalResult.outcome,
          ...(finalResult.assistant.memoryUpdated ? { memoryUpdated: true } : {}) });
      } catch { /* Stored status and transcript are authoritative on reconnect. */ }
      this.recordDurableMemory(loadedSession, c.userId, c.sessionId, a, lastConfirmedDelivery, turnMode);
    } catch (error) {
      pendingConfirmedState = null;
      this.confirmedState.delete(c.userId, c.sessionId);
      diagnose(this.d.diagnostics?.emit, { stage: 'runtime-error', state: 'error',
        code: error instanceof AppError ? error.code : 'PERSISTENCE_ERROR',
        failureKind: error instanceof AppError ? 'application' : error instanceof TypeError ? 'type'
          : error instanceof Error && error.name === 'ZodError' ? 'validation' : 'unexpected' });
      const outcomeError = job.signal.aborted ? job.failure() : error;
      job.abort('INTERRUPTED');
      await job.stopHeartbeat(); await job.settled(); await p.owner.drain();
      try {
        await this.inPhase('recovery', async () => {
        if (lease && calendarActive && !graph) graph = await this.graph(lease);
        if (lease && graph) {
          const snap = await graph.getState(graphConfig(a.userId, a.sessionId));
          if (snap.values.sealed && !snap.next.length && snap.values.result?.input.attempt.attemptId === a.attemptId) saved = snap.values.result;
          savedCalendar = Boolean(snap.values.sealed && !snap.next.length
            && snap.values.calendarSeal?.input.attempt.attemptId === a.attemptId);
        }
        if (lease && (saved || savedCalendar)) {
          const durable = await p.metadata.getAttempt(a.userId, a.sessionId, a.attemptId);
          if (durable && durable.status === 'generating') await transition(p, lease, job, durable, 'finalizing');
          this.work.degraded = true; // Keep active slot for record-driven recovery; no false failed terminal.
        } else if (lease) {
          await this.interruptOwned(lease, job, a, partial, outcomeError, acceptedArtifacts,
            interruptedAssistantSequence, calendarSnapshot, weatherSnapshot);
          const status = await this.turnStatus(a.userId, a.sessionId, a.turnId);
          if (terminal(status.status)) {
            this.attemptSettings.delete(boundKey);
            this.attemptPersonalization.delete(boundKey);
            this.attemptTimeZone.delete(boundKey);
        this.attemptRequestGeo.delete(boundKey);
            this.attemptCalendar.delete(boundKey);
            this.attemptIdentities.delete(boundKey);
            if (!c.live) {
              await job.settled(); await p.owner.drain();
              await p.owner.release(lease); lease = undefined; job.close();
            }
            try {
              for (const event of [{ type: 'status', status: status.status, truncated: status.truncated },
                ...(status.error ? [{ type: 'error', ...status.error }] : [])])
                await job.wait(c.emit(streamEnvelopeSchema.parse({ protocolVersion: 1, sessionId: a.sessionId,
                  turnId: a.turnId, attemptId: a.attemptId, sequence: sequence++, event })), snapshot.budgets.idleStreamTimeoutMs);
            } catch { /* Disconnected client reads durable status later. */ }
          }
        }
        });
      } catch (recoveryError) {
        // A second storage failure must not bypass quarantine or hide the
        // original error while the durable active-attempt marker remains.
        this.work.degraded = true;
        diagnose(this.d.diagnostics?.emit, { stage: 'persistence', state: 'error',
          code: recoveryError instanceof AppError ? recoveryError.code : 'PERSISTENCE_ERROR' });
      }
      const finalError = error instanceof AppError ? error : outcomeError;
      throw finalError instanceof AppError ? finalError : new AppError('PERSISTENCE_ERROR', 'The chat could not be saved.', false);
    } finally {
      let settlementSucceeded = !c.live;
      let releaseSucceeded = false;
      try {
        if (c.live && deliveryStarted && lease) {
          const finalGenerated = saved?.assistant.content !== undefined
            ? saved.assistant.content
            : (await p.messages.get(a.userId, a.sessionId, outputId(a)))?.content ?? partial;
          try {
            await c.live.settle(finalGenerated, job.signal);
            settlementSucceeded = true;
          } catch (error) {
            this.work.degraded = true;
            this.confirmedState.delete(c.userId, c.sessionId);
            throw error;
          }
        }
      } finally {
        try {
          await job.stopHeartbeat();
          await job.settled();
          await p.owner.drain();
          if (lease) {
            await p.owner.release(lease);
            lease = undefined;
          }
          releaseSucceeded = true;
        } catch (releaseError) {
          this.confirmedState.delete(c.userId, c.sessionId);
          throw releaseError;
        } finally {
          job.close();
          if (settlementSucceeded && releaseSucceeded) {
            if (pendingConfirmedState) {
              this.confirmedState.put(pendingConfirmedState);
              pendingConfirmedState = null;
            }
          } else {
            this.confirmedState.delete(c.userId, c.sessionId);
          }
        }
      }
    }
  }
  private async admitCalendarBudget(
    boundKey: string,
    snapshot: RuntimeConfigSnapshot,
    attempt: AttemptRecord,
    originalCreatedAt: string,
  ) {
    const cal = this.calendarFor(attempt.userId);
    if (!cal || !isCalendarV2(cal) || !snapshot.calendar?.enabled || !snapshot.modelLimits?.calendar?.tools) return;
    try {
      await cal.connection.currentAccount();
      const existing = attempt.causal.previousAttemptId !== null
        ? await this.d.persistence.calendarAccountingV2?.getBudget(attempt.userId, attempt.sessionId, attempt.turnId) ?? null
        : null;
      const createdAt = existing?.createdAt ?? originalCreatedAt;
      const deadlineAt = existing?.deadlineAt
        ?? new Date(Date.parse(createdAt) + snapshot.budgets.totalRunTimeoutMs).toISOString();
      this.attemptCalendar.set(boundKey, { createdAt, deadlineAt });
    } catch {
      // Calendar unavailable leaves ordinary text healthy.
    }
  }

  private async runCalendarTurn(input: {
    command: ExecuteTurn; attempt: AttemptRecord; input: MessageRecord; snapshot: RuntimeConfigSnapshot;
    job: Work; owned: ExecutionLease; graphInput: GraphInput; manifest: AgentMemoryManifest;
    context: AssembledContext; assistantSequence: number;
    attemptReceipt: ConfirmedRecord<AttemptRecord> | null;
    acceptance: AcceptanceRecord | null;
    window: { createdAt: string; deadlineAt: string };
    releaseState: { finished: boolean };
    release: () => Promise<void>;
    turnMode?: TurnModeHandle;
    clientTimeZone?: string | null;
    requestGeo?: RequestGeoHint | null;
    personalization?: UserPersonalizationSettings;
    sourceRecords?: readonly MessageRecord[];
    session?: import('../contracts/session.js').SessionRecord | null;
    captureView(value: NonNullable<MessageRecord['calendarView']>): void;
    captureWeather(value: NonNullable<MessageRecord['weatherView']>): void;
    emitStream(event: StreamEvent): Promise<void>;
    voiceOutput?: {
      delta(text: string): Promise<void>;
      complete(narration: string, unstreamed: boolean): Promise<string>;
      fields(): Pick<MessageRecord, 'mode' | 'visibility' | 'voiceSessionId' | 'canvasArtifacts'>;
    };
  }) {
    let calCheckpointId: string | null = null;
    const { command: c, snapshot, job, owned, graphInput, manifest, context, assistantSequence } = input;
    let a = input.attempt;
    const p = this.d.persistence;
    const cal = this.calendarFor(a.userId);
    const calendarV2 = cal && isCalendarV2(cal) ? cal : null;
    if (!c.emitCalendar) throw new AppError('NOT_READY', 'Calendar stream support is required.');
    const unbound = { userId: a.userId, connectionId: 'memory-unbound', connectionRevision: 1,
      googleSubjectId: 'memory-unbound' };
    let pluginEnabled = Boolean(snapshot.calendar?.enabled && calendarV2
      && snapshot.modelLimits?.calendar?.tools);
    let account: CalendarAccountBinding = unbound;
    if (pluginEnabled) {
      try {
        account = await calendarV2!.connection.currentAccount();
      } catch (error) {
        // A turn with prior Calendar operation evidence must fail closed: the
        // pending/unknown operation cannot be resolved as native-only work.
        const operation = await p.calendarOperationsV2?.getByTurn(a.userId, a.sessionId, a.turnId);
        if (operation) throw error;
        // Provider/account absence makes plugin execution unavailable for this
        // invocation; native Canvas tools remain advertised.
        pluginEnabled = false;
      }
    }
    const window = input.window;
    const calLimits = snapshot.calendar?.limits ?? CALENDAR_LIMITS;
    const ledger = new CalendarTurnLedger({
      accounting: asCalendarAccountingPort(p), identity: {
        userId: a.userId, sessionId: a.sessionId, turnId: a.turnId, attemptId: a.attemptId,
        openRouterUser: a.openRouterUser, createdAt: window.createdAt, deadlineAt: window.deadlineAt,
      },
      limits: calLimits,
      write: action => job.wait(p.owner.run(owned, action), snapshot.budgets.persistenceTimeoutMs),
      clock: () => Date.parse(this.now()), modelId: snapshot.openRouter.modelId,
      pricing: snapshot.modelLimits!.calendar!.pricing, configRevision: snapshot.revision, connection: account,
      maxOutputTokens: snapshot.budgets.maxOutputTokens,
      processingPolicyId: snapshot.calendar?.processingPolicyId ?? 'native-local.v1',
      job, fence: () => p.owner.fence(owned),
      requireCurrent: async () => {
        if (pluginEnabled) {
          await calendarV2!.connection.requireAccountCurrent(account, job.signal);
        }
      },
    });
    const binding = { ...account, calendarId: 'primary', targetRevision: 1 };
    const sequence = { value: 0 };
    const records = input.sourceRecords
      ?? await p.messages.getReferences(a.userId, a.sessionId, manifest.messageRefs);
    const selected = selectReferences({ userId: a.userId, sessionId: a.sessionId, turnId: a.turnId,
      newUserInput: input.input.content, responseMode: c.live ? 'voice' : 'text' }, manifest, [...records], this.d.assets, snapshot.budgets);
    const historicalGroups = await calendarHistory(p, a.userId, a.sessionId, selected, () => Date.parse(this.now()), input.session);
    const canvasPort = c.live?.canvas;
    // The compacted manifest no longer references pre-summary records, so a
    // bounded cold walk keeps older Canvas ownership authorizable for voice.
    let canvasRecords: readonly MessageRecord[] = records;
    if (canvasPort && manifest.activeSummaryRef) {
      const ceiling = manifest.activeSummaryRef.sourceRange.toSequence;
      const limit = p.messages.budgets.maxPageSize;
      const found = new Map<string, MessageRecord>();
      const oldestTail = records.reduce<MessageRecord | null>(
        (min, record) => !min || record.sequence < min.sequence
          || (record.sequence === min.sequence && record.messageId < min.messageId) ? record : min,
        null,
      );
      let canvasCursor: string | null = oldestTail && oldestTail.sequence > ceiling
        ? cursor({ kind: 'messages', userId: a.userId, sessionId: a.sessionId, value: oldestTail.sequence, id: oldestTail.messageId })
        : null;
      for (let pages = 0; pages < 10; pages++) {
        job.check();
        const older = await p.messages.listForContext(a.userId, a.sessionId, { cursor: canvasCursor, limit });
        job.check();
        for (const record of older.items) {
          if (record.sequence <= ceiling && hasCanvasContent(record)) found.set(record.messageId, record);
        }
        if (found.size >= 500 || !older.nextCursor || older.items.length === 0
          || older.nextCursor === canvasCursor) break;
        canvasCursor = older.nextCursor;
      }
      const archived = [...found.values()].sort((x, y) => x.sequence - y.sequence).slice(-limit);
      const merged = new Map<string, MessageRecord>();
      for (const record of archived) merged.set(record.messageId, record);
      for (const record of records) merged.set(record.messageId, record);
      canvasRecords = [...merged.values()].sort((x, y) => x.sequence - y.sequence);
    }
    const inventoryFor = (): CanvasInventorySnapshot => canvasPort
      ? ownedCanvasInventory(canvasPort.inventory(), canvasRecords, a.userId, a.sessionId)
      : { items: [], omitted: 0 };
    const selectionFor = (): CanvasSelection | null => canvasPort
      ? ownedCanvasSelection(canvasPort.selection?.(), inventoryFor())
      : null;
    let rawNarration = '';
    let narrationClosed = false;
    const forward: NonNullable<ExecuteTurn['emitCalendar']> = async frame => {
      if (!c.live) { await c.emitCalendar!(frame); return; }
      if (frame.event.type === 'delta') {
        if (narrationClosed) return; // publisher reset/replay, already reconciled below
        rawNarration += frame.event.text;
        await input.voiceOutput!.delta(frame.event.text);
        return;
      }
      try { void c.emitCalendar!(frame).catch(() => undefined); }
      catch { /* Display failure does not alter the durable Calendar result. */ }
    };
    const loop = new CalendarLoop({
      persistence: p, calendar: cal, ledger, attempt: a, input: input.input,
      calendarEnabled: pluginEnabled,
      calendarConnection: pluginEnabled ? 'connected' : 'not-connected',
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
      snapshot, limits: calLimits, binding, context, job, lease: owned, emitCalendar: forward,
      assets: this.d.assets, manifest, assistantSequence, fetcher: this.d.fetcher ?? fetch, now: () => this.now(),
      sequence, diagnostics: this.d.diagnostics, historicalGroups,
      responseMode: c.live ? 'voice' : 'text',
      turnMode: input.turnMode, localToolControl: c.localToolControl,
      memoryTool: this.explicitMemory(input.session, a.turnId, snapshot, input.turnMode, c.localToolControl),
      clientTimeZone: input.clientTimeZone,
      executeEnvironment: (envelope, signal) => executeEnvironmentTool({
        envelope,
        now: new Date(this.now()),
        timeZone: input.clientTimeZone ?? cal?.trustedTimeZone ?? 'Etc/UTC',
        savedLocation: extractSavedLocation(input.personalization ?? this.personalizationFor(a.userId)),
        requestGeo: input.requestGeo ?? null,
        weatherProvider: this.weatherProvider(),
        signal,
      }),
      onWeatherView: view => {
        input.captureWeather(view);
        try { c.onWeatherView?.(view); }
        catch { /* Presentation cannot fail tool execution. */ }
        void input.emitStream({ type: 'weather-view', view });
      },
      onView: input.captureView,
      assistantFields: input.voiceOutput?.fields,
    });
    const graph = buildTurnGraph((await p.checkpoints.create()).bind(owned), {
      prepare: (_input, restored) => this.inPhase('context', async () => {
        job.check();
        if (!await p.owner.fence(owned)) throw new AppError('INTERRUPTED', 'Execution ownership was lost.');
        // A restored turn resumes its saved boundary instead of a fresh initial
        // Calendar state. A legacy pending tool is refused with the durable
        // legacy disposition, because the graph cannot write persistence records.
        const savedCursor = restored.calendarCursor
          ? calendarCursorSchema.parse(restored.calendarCursor) : null;
        const savedSeal = restored.calendarSeal
          ? calendarSealSchema.parse(restored.calendarSeal) : null;
        if (savedCursor && savedCursor.version !== 2 && savedCursor.pendingDecisionId !== null) {
          await p.calendarOperations.recordLegacyDisposition({
            schemaVersion: 2, kind: 'calendar-legacy-disposition',
            userId: a.userId, sessionId: a.sessionId, turnId: a.turnId,
            legacyKind: 'decision', legacyRecordId: savedCursor.pendingDecisionId,
            operationId: null, state: 'cancelled', externalOutcome: 'not-dispatched',
            reconcileOriginal: false, reason: 'legacy-read-only', at: this.now(),
          });
          throw new AppError('NOT_READY', 'Calendar work needs a fresh request.', false);
        }
        const resuming = savedSeal !== null && savedSeal.input.attempt.attemptId === a.attemptId;
        return { calendarCursor: resuming ? savedCursor : loop.initialCursor(),
          calendarSeal: resuming ? savedSeal : null };
      }),
      generate: async () => { throw new AppError('NOT_READY', 'Calendar turns do not use text generation.'); },
      decide: current => this.inPhase('model-observation', () => loop.decide(current)),
      execute: current => this.inPhase('tool-evidence', () => loop.execute(current)),
    });
    await this.inPhase('seal', () => job.wait(graph.invoke({
      input: graphInput, result: null, sealed: false, rebase: null,
      calendarCursor: loop.initialCursor(), calendarSeal: null, calendarRefs: null,
    }, { ...graphConfig(a.userId, a.sessionId), signal: job.signal, recursionLimit: 48 }),
      snapshot.budgets.totalRunTimeoutMs));
    const complete = await this.inPhase('seal', () => graph.getState(graphConfig(a.userId, a.sessionId)));
    if (!complete.values.sealed || complete.next.length || !complete.values.calendarSeal)
      throw new AppError('PERSISTENCE_ERROR', 'The graph save could not be confirmed.', false);
    const seal = complete.values.calendarSeal;
    let narration = loop.narration();
    if (c.live) {
      if (rawNarration && narration.startsWith(rawNarration) && narration.length > rawNarration.length)
        await input.voiceOutput!.delta(narration.slice(rawNarration.length));
      else if (rawNarration && rawNarration !== narration && !rawNarration.endsWith(narration))
        await input.voiceOutput!.delta(narration); // a changed local outcome, not a repeated prefix
      narration = await input.voiceOutput!.complete(narration, rawNarration.length === 0);
      narrationClosed = true;
    }
    const finalizationStarted = performance.now();
    diagnose(this.d.diagnostics?.emit, { stage: 'finalization', state: 'start', origin: 'local', delivery: 'not-sent' });
    // The durable publication owns the message, the committed manifest, the
    // graph boundary and the terminal attempt state, in that order.
    const memoryUpdated = loop.memoryWasUpdated();
    const assistantFields = {
      ...(input.voiceOutput?.fields() ?? {}),
      ...(memoryUpdated ? { memoryUpdated: true as const } : {}),
    } as unknown as NonNullable<Parameters<typeof publishCalendarTurn>[0]['assistantFields']>;
    const emitPublished = (envelope: CalendarCompatibleEnvelope) =>
      forward(memoryUpdated && envelope.event.type === 'completed'
        ? { ...envelope, event: { ...envelope.event, memoryUpdated: true } } : envelope);
    await this.inPhase('publication', () => publishCalendarTurn({
      persistence: p, work: job, lease: owned, attempt: a, seal,
      narration, sources: loop.provenance(), assistantSequence,
      assistantFields,
      persistenceTimeoutMs: snapshot.budgets.persistenceTimeoutMs,
      liveEvidence: input.attemptReceipt && input.acceptance
        ? { attemptReceipt: input.attemptReceipt, confirmedSnapshot: complete,
            baseManifest: manifest, acceptedInput: input.input, acceptance: input.acceptance }
        : undefined,
      commitBoundary: async () => {
        // The graph boundary must follow the committed manifest, otherwise the
        // next accepted turn is rejected as "Graph state needs recovery".
        const boundary = boundaryFor(seal.target);
        await job.wait(graph.updateState(graphConfig(a.userId, a.sessionId), { boundary }, 'seal'),
          snapshot.budgets.persistenceTimeoutMs);
        const confirmed = await graph.getState(graphConfig(a.userId, a.sessionId));
        if (confirmed.next.length || !isDeepStrictEqual(confirmed.values.boundary, boundary))
          throw new AppError('PERSISTENCE_ERROR', 'Chat context save could not be confirmed.');
        calCheckpointId = snapshotCheckpointId(confirmed);
      },
      emit: async (envelope: CalendarCompatibleEnvelope) => { await emitPublished(envelope); },
      beforeTerminal: completion => this.inPhase('release', async () => {
        diagnose(this.d.diagnostics?.emit, { stage: 'attempt-terminal-durable', state: 'ok', origin: 'local', delivery: 'not-sent' });
        await job.stopHeartbeat();
        await job.settled();
        // The publisher supplies its latest acknowledged terminal receipt; the
        // activity touch, the slot clearing and the lease release are one CAS.
        const finish = (p.owner as ExecutionOwnership).finishAttempt;
        if (finish && completion.receipt) {
          await job.wait(finish.call(p.owner, owned, completion.receipt, completion.activityAt ?? a.createdAt),
            snapshot.budgets.persistenceTimeoutMs);
          input.releaseState.finished = true;
        } else {
          await job.wait(p.owner.clearAttempt(owned, a.attemptId), snapshot.budgets.persistenceTimeoutMs);
        }
        const key = this.attemptKey(a.userId, a.sessionId, a.attemptId);
        this.attemptSettings.delete(key);
        this.attemptPersonalization.delete(key);
        this.attemptTimeZone.delete(key);
      this.attemptRequestGeo.delete(key);
        this.attemptCalendar.delete(key);
        this.attemptIdentities.delete(key);
        await input.release();
        const calCid = calCheckpointId ?? snapshotCheckpointId(complete);
        if (calCid && isPinnedCheckpointId(a.sessionId, calCid)) {
          const assistantRecord: MessageRecord = {
            schemaVersion: 1, userId: a.userId, sessionId: a.sessionId, turnId: a.turnId, attemptId: a.attemptId,
            messageId: outputId(a), eventId: eventIdFor(a.userId, a.sessionId, outputId(a)),
            sequence: assistantSequence, role: 'assistant', content: loop.narration() ?? '',
            createdAt: seal.assistantCreatedAt, completionStatus: seal.outcome, truncated: seal.outcome === 'truncated',
            ...(input.voiceOutput ? input.voiceOutput.fields() : {}),
            ...(seal.version === 2 && seal.view ? { calendarView: seal.view } : {}),
            ...(seal.version === 2 && seal.weatherView ? { weatherView: seal.weatherView } : {}),
            ...(memoryUpdated ? { memoryUpdated: true } : {}),
            ...(loop.provenance()?.length ? { sourceProvenance: loop.provenance() } : {}),
          };
          const priorRecords = input.sourceRecords ?? [];
          const allRecords = [
            ...priorRecords.filter(m => m.messageId !== input.input.messageId),
            input.input,
            assistantRecord,
          ];
          this.trackCalendarMessage(a.userId, a.sessionId, assistantRecord.messageId);
          for (const m of allRecords) {
            if (m.sourceProvenance?.length || m.content === CALENDAR_TOMBSTONE) {
              this.trackCalendarMessage(a.userId, a.sessionId, m.messageId);
            }
          }
          const calendarMessageIds = Array.from(this.sessionCalendarMessages.get(this.sessionKey(a.userId, a.sessionId))?.calendarMessageIds ?? []);
          const plainRecords: MessageRecord[] = [];
          const refreshRefs: MessageRef[] = [];
          for (const m of allRecords) {
            const isCalendarAnswer = this.isCalendarOrUncertain(a.userId, a.sessionId, m);
            if (isCalendarAnswer || m.visibility === 'internal' || m.mode === 'live' || m.voiceTranscripts?.length) {
              refreshRefs.push({ messageId: m.messageId, eventId: m.eventId, sequence: m.sequence });
            } else {
              plainRecords.push(m);
            }
          }
          this.confirmedState.put({
            userId: a.userId,
            sessionId: a.sessionId,
            executorId: p.owner.executorId,
            sessionGeneration: owned.generation,
            turnId: a.turnId,
            attemptId: a.attemptId,
            manifest: seal.target,
            checkpointId: calCid,
            plainRecords,
            refreshRefs,
            instructionVersion: this.d.assets.instructionVersion,
            knowledgeContentHash: this.d.assets.knowledgeContentHash,
            graphSchemaVersion: this.d.assets.graphSchemaVersion,
            confirmedAt: Date.now(),
            expiresAt: Date.now() + 300_000,
            manifestReceipt: null,
            calendarMessageIds,
          });
        }
      }),
      sequence,
    }));
    const outcome = loop.diagnosticOutcome();
    diagnose(this.d.diagnostics?.emit, { stage: 'finalization', state: 'ok', durationMs: performance.now() - finalizationStarted, origin: 'local', delivery: 'not-sent' });
    diagnose(this.d.diagnostics?.emit, { stage: 'task-outcome', task: outcome.task,
      writeCertainty: outcome.writeCertainty, origin: 'local', delivery: 'not-sent' });
    diagnose(this.d.diagnostics?.emit, { stage: 'terminal', chat: 'completed' });
    this.recordDurableMemory(input.session, a.userId, a.sessionId, a, null, input.turnMode);
  }

  async interruptOwned(lease: ExecutionLease, job: Work, a: AttemptRecord, partial: string, error: unknown, canvasArtifacts?: CanvasArtifactProjection[], assistantSequence?: number, calendarView?: MessageRecord['calendarView'], weatherView?: MessageRecord['weatherView']) {
    this.confirmedState.delete(lease.userId, lease.sessionId);
    if (!await this.d.persistence.owner.fence(lease)) { this.work.degraded = true; return; }
    return interruptAttempt({ p: this.d.persistence, lease, job, graph: await this.graph(lease),
      attempt: a, partial, error, assets: this.d.assets, budgets: this.d.config.budgets, canvasArtifacts, assistantSequence,
      ...(calendarView ? { calendarView } : {}), ...(weatherView ? { weatherView } : {}) });
  }
  invalidateCalendarAccount(account: CalendarAccountBinding, reason?: string): void {
    this.memoryFor(account.userId)?.invalidateCalendarAccount(account, reason);
    this.clearConfirmedState();
  }
  async reconcileSession(u: string, s: string): Promise<void> {
    const memory = this.memoryFor(u);
    if (memory?.owns(s) && memory.session(u, s)) {
      if (this.work.get(u, s)) throw new AppError('CONFLICT_ACTIVE_TURN', 'Chat work is still active.');
      await memory.reconcileMutation(s);
      return; // Saving has its own owner; reconciliation must not replay generation.
    }
    return this.inPhase('recovery', async () => {
    const p = this.d.persistence;
    if (this.work.get(u, s)) throw new AppError('CONFLICT_ACTIVE_TURN', 'Chat work is still active.');
    this.receipts.delete(u, s);
    this.sessionCalendarMessages.delete(this.sessionKey(u, s));
    this.confirmedState.delete(u, s);
    await p.owner.assertExecutor(); await p.owner.drain();
    const session = await p.sessions.get(u, s);
    if (!session) throw new AppError('NOT_FOUND', 'Chat not found.');
    const readGraph = await this.graph({ userId: u, sessionId: s, ownerId: p.owner.executorId,
      generation: session.execution.generation, leaseExpiresAt: this.now() });
    const graphValues = (await readGraph.getState(graphConfig(u, s))).values;
    const pendingRebase = graphValues.rebase;
    const cal = this.calendarFor(u);
    const recentAttempts = session.memoryPublication !== undefined
      ? (await p.metadata.listAttempts(u, s, { cursor: null, limit: 5 })).items
      : [];
    const unsealedAttempt = session.execution.activeAttemptId === null && session.memoryPublication !== undefined
      ? recentAttempts.find(item => !terminal(item.status)) ?? null
      : null;
    const activeAttemptRecord = session.execution.activeAttemptId !== null
      ? await p.metadata.getAttempt(u, s, session.execution.activeAttemptId)
      : null;
    const acceptedTurnIds = [activeAttemptRecord?.turnId, unsealedAttempt?.turnId]
      .filter((id): id is string => Boolean(id));
    const publicationManifest = session.memoryPublication !== undefined
      && session.execution.activeAttemptId === null && !unsealedAttempt
      ? await p.memory.get(u, s)
      : null;
    const publicationBehind = publicationManifest && session.memoryPublication
      && publicationManifest.contextVersion > session.memoryPublication.version
      ? publicationManifest
      : null;
    // The pending Calendar check is anchored to the graph's own operation
    // and intent references and scoped unresolved lookup, never `latestTurnId` alone.
    const pendingOperation = cal
      ? await pendingCalendarOperation({
        persistence: p, userId: u, sessionId: s, values: graphValues,
        latestTurnId: session.latestTurnId, acceptedTurnIds,
      })
      : null;
    const calendarPending = pendingOperation !== null;
    if (session.execution.activeAttemptId === null && session.execution.ownerId === null && !pendingRebase &&
      !calendarPending && !unsealedAttempt && !publicationBehind && !await hasPendingVoiceDelivery(p, u, s)) return;
    if (session.execution.ownerId && session.execution.ownerId !== p.owner.executorId && !this.stoppedOwners.has(session.execution.ownerId))
      throw new AppError('NOT_READY', 'Stopped-executor recovery has not been authorized.');
    const job = this.work.open(u, s, new AbortController().signal, this.d.config.budgets.totalRunTimeoutMs);
    let lease: ExecutionLease | undefined;
    try {
      lease = await p.owner.recoverStoppedSession(u, s, session.execution.ownerId, 180000);
      const activeLease = lease;
      const cfg = this.d.currentConfig?.current();
      const recoveryPlanInput = (attempt: AttemptRecord) => ({
        persistence: p,
        lease: activeLease,
        job,
        userId: u,
        sessionId: s,
        attempt,
        limits: cfg?.calendar?.limits,
        pricing: cfg?.modelLimits?.calendar?.pricing,
        configRevision: cfg?.revision,
        openRouterUser: u,
        now: () => this.now(),
      });
      // Only a pending operation needs a reconciliation, and the reconciliation
      // never needs a live Calendar connection: a missing, revoked or
      // unconfigured Calendar leaves the operation unknown instead of failing
      // the ordinary text recovery.
      if (cal && pendingOperation) {
        const opTurnAttempt = (await attemptsFor(p, u, s))
          .filter(item => item.turnId === pendingOperation.turnId).at(-1)
          ?? await p.metadata.getAttempt(u, s, pendingOperation.originatingAttemptId);
        if (pendingOperation.schemaVersion === 2 && isCalendarV2(cal)) {
          if (pendingOperation.state === 'planned') {
            if (opTurnAttempt) {
              await reconcilePlannedCalendarOperationV2({
                ...recoveryPlanInput(opTurnAttempt),
                execution: cal.execution,
                capabilities: cal.capabilities,
                connection: cal.connection,
                operation: pendingOperation,
                trustedTimeZone: cal.trustedTimeZone,
                permission: cal.permission,
                auditDeadlineAt: cal.auditDeadlineAt,
              });
            }
          } else {
            await reconcileCalendarOperationV2({
              persistence: p, lease: activeLease, job, userId: u, sessionId: s,
              execution: cal.execution,
              capabilities: cal.capabilities,
              operation: pendingOperation,
              attemptId: opTurnAttempt?.attemptId ?? pendingOperation.originatingAttemptId,
              trustedTimeZone: cal.trustedTimeZone, now: () => this.now(),
            });
          }
        } else {
          await reconcileCalendarOperation({
            persistence: p, lease: activeLease, job, userId: u, sessionId: s,
            execution: cal.execution as any,
            trustedTimeZone: cal.trustedTimeZone, now: () => this.now(),
          });
        }
      }
      const aId = session.execution.activeAttemptId ?? unsealedAttempt?.attemptId ?? null;
      const graph = await this.graph(activeLease); const snap = await graph.getState(graphConfig(u, s));
      if (snap.values.rebase) {
        if (session.execution.activeAttemptId) throw new AppError('NOT_READY', 'A version rebase cannot overlap an active turn.');
        await finishRebase(p, activeLease, job, graph, rebaseSchema.parse(snap.values.rebase));
        await reconcileVoiceDeliveries(p, activeLease, job);
        return;
      }
      const advancePublicationIfClean = async (manifest: AgentMemoryManifest, pubAttempt: AttemptRecord) => {
        const store = p.owner.store;
        if (!store || !session.memoryPublication) return;
        if (manifest.contextVersion !== session.memoryPublication.version + 1) return;
        if (!isDeepStrictEqual(boundaryFor(manifest), snap.values.boundary)) return;
        const refs = await p.messages.getReferences(u, s, manifest.messageRefs);
        if (refs.length !== manifest.messageRefs.length) return;
        await job.wait(p.owner.run(activeLease, async () => {
          await store.collection('sessions').updateOne(
            {
              _id: key('session', u, s),
              userId: u,
              sessionId: s,
              lifecycle: 'active',
              'execution.ownerId': activeLease.ownerId,
              'execution.generation': activeLease.generation,
              'memoryPublication.version': session.memoryPublication!.version,
            },
            {
              $set: {
                memoryPublication: {
                  version: manifest.contextVersion,
                  sequence: pubAttempt.sequence,
                  epoch: session.memoryPublication!.epoch,
                  fence: session.memoryPublication!.fence,
                },
              },
              $inc: { _revision: 1 },
            },
            store.options(),
          );
        }), this.d.config.budgets.persistenceTimeoutMs);
      };
      if (!aId) {
        if (publicationBehind && recentAttempts[0]) {
          await advancePublicationIfClean(publicationBehind, recentAttempts[0]);
        }
        await reconcileVoiceDeliveries(p, activeLease, job);
        if (pendingOperation) {
          const recovered = await p.metadata.getAttempt(u, s, pendingOperation.originatingAttemptId);
          if (recovered) {
            const scope = { sessionId: s, turnId: recovered.turnId,
              attemptId: recovered.attemptId, operationId: pendingOperation.operationId };
            const observeRecoveredOperation = () => {
              diagnose(this.d.diagnostics?.emit, { stage: 'task-outcome', task: 'unknown',
                writeCertainty: 'unknown', origin: 'local', delivery: 'not-sent' });
              if (recovered.status === 'completed' || recovered.status === 'truncated'
                || recovered.status === 'failed' || recovered.status === 'cancelled'
                || recovered.status === 'interrupted') {
                diagnose(this.d.diagnostics?.emit, { stage: 'terminal', chat: recovered.status });
              }
            };
            if (this.d.diagnostics) await this.d.diagnostics.run(scope, observeRecoveredOperation);
            else observeRecoveredOperation();
          }
        }
        return;
      }
      let a = await p.metadata.getAttempt(u, s, aId);
      if (!a) {
        const orphan = await p.messages.get(u, s, inputId(u, s, aId));
        if (orphan && (orphan.role !== 'user' || orphan.attemptId !== null)) throw new AppError('NOT_READY', 'Orphaned acceptance needs operator repair.');
        if (session.execution.activeAttemptId === aId) {
          await job.wait(p.owner.clearAttempt(lease, aId), this.d.config.budgets.persistenceTimeoutMs);
        }
        await reconcileVoiceDeliveries(p, lease, job);
        return; // Preserve original; a repeated identical submission can finish acceptance.
      }
      if (snap.values.sealed && !snap.next.length && snap.values.result?.input.attempt.attemptId === aId) {
        if (a.status === 'generating') a = await transition(p, lease, job, a, 'finalizing');
        if (!['finalizing', 'completed', 'truncated'].includes(a.status)) throw new AppError('NOT_READY', 'Saved result and attempt disagree.');
        await publishResult(p, lease, job, graph, a, snap.values.result);
        if (session.execution.activeAttemptId === aId) {
          await job.wait(p.owner.clearAttempt(lease, aId), this.d.config.budgets.persistenceTimeoutMs);
        }
      } else if (snap.values.sealed && !snap.next.length && snap.values.calendarSeal?.input.attempt.attemptId === aId) {
        const seal = calendarSealSchema.parse(snap.values.calendarSeal);
        const existing = await p.messages.get(u, s, outputId(a));
        let narration = existing?.content ?? null;
        let sources = existing?.sourceProvenance;
        if (narration === null && seal.version === 2 && seal.narrationRef.kind === 'text-decision') {
          const record = await p.skillDecisions.get(u, seal.narrationRef.decisionId);
          if (record?.sessionId === s && record.attemptId === aId && record.decision?.kind === 'text') {
            narration = record.decision.content;
            sources = record.sources;
          }
        }
        if (narration !== null) {
          const recoveryLease = lease;
          const recoveryAttempt = a;
          if (!recoveryLease || !recoveryAttempt) {
            throw new AppError('NOT_READY', 'The saved Calendar answer needs recovery.');
          }
          const startedAt = performance.now();
          const scope = { sessionId: s, turnId: recoveryAttempt.turnId, attemptId: recoveryAttempt.attemptId,
            ...(seal.operationId ? { operationId: seal.operationId } : {}) };
          const publishRecoveredAnswer = async () => {
            diagnose(this.d.diagnostics?.emit, { stage: 'finalization', state: 'start',
              origin: 'local', delivery: 'not-sent' });
            try {
              const publication = await publishCalendarTurn({
                persistence: p, work: job, lease: recoveryLease, attempt: recoveryAttempt, seal, narration, sources,
                assistantSequence: seal.input.assistantSequence,
                persistenceTimeoutMs: this.d.config.budgets.persistenceTimeoutMs,
                commitBoundary: async () => {
                  await job.wait(graph.updateState(graphConfig(u, s), { boundary: boundaryFor(seal.target) }, 'seal'),
                    this.d.config.budgets.persistenceTimeoutMs);
                },
              });
              if (session.execution.activeAttemptId === aId) {
                await job.wait(p.owner.clearAttempt(recoveryLease, aId), this.d.config.budgets.persistenceTimeoutMs);
              }
              diagnose(this.d.diagnostics?.emit, { stage: 'finalization', state: 'ok',
                origin: 'local', delivery: 'not-sent', durationMs: performance.now() - startedAt });
              diagnose(this.d.diagnostics?.emit, { stage: 'task-outcome', task: 'unknown',
                writeCertainty: 'unknown', origin: 'local', delivery: 'not-sent' });
              diagnose(this.d.diagnostics?.emit, { stage: 'terminal', chat: publication.status === 'truncated'
                ? 'truncated' : 'completed' });
            } catch (error) {
              diagnose(this.d.diagnostics?.emit, { stage: 'finalization', state: 'error',
                reason: 'persistence-error', code: error instanceof AppError ? error.code : 'PERSISTENCE_ERROR',
                origin: 'local', delivery: 'not-sent', durationMs: performance.now() - startedAt });
              diagnose(this.d.diagnostics?.emit, { stage: 'task-outcome', task: 'unknown',
                writeCertainty: 'unknown', origin: 'local', delivery: 'not-sent' });
              throw error;
            }
          };
          if (this.d.diagnostics) await this.d.diagnostics.run(scope, publishRecoveredAnswer);
          else await publishRecoveredAnswer();
        } else {
          // Never repeat inference to recreate missing or expired narration.
          await interruptAttempt({ p, lease, job, graph, attempt: a, partial: '',
            error: new AppError('INTERRUPTED', 'The saved Calendar answer is unavailable.', false),
            assets: this.d.assets, budgets: this.d.config.budgets,
            ...(seal.version === 2 && seal.weatherView ? { weatherView: seal.weatherView } : {}) });
        }
      } else {
        if (!terminal(a.status) && cal && isCalendarV2(cal) && p.calendarOperationsV2
          && !(await p.calendarOperationsV2.getByTurn(u, s, a.turnId))) {
          await reconcileConsumedProposalWithoutOperation({
            ...recoveryPlanInput(a),
            execution: cal.execution,
            capabilities: cal.capabilities,
            connection: cal.connection,
            trustedTimeZone: cal.trustedTimeZone,
            permission: cal.permission,
            auditDeadlineAt: cal.auditDeadlineAt,
          });
        }
        const opForAttempt = cal && isCalendarV2(cal) && p.calendarOperationsV2
          ? await p.calendarOperationsV2.getByTurn(u, s, a.turnId)
          : null;
        const graphInput = snap.values.input as { attempt?: { attemptId?: string } } | null | undefined;
        const isMinimalAttempt = session.memoryPublication !== undefined
          && graphInput?.attempt?.attemptId !== aId
          && !snap.values.sealed;
        if (terminal(a.status)) {
          if (['completed', 'truncated'].includes(a.status)) {
            const provenOperationPublication = opForAttempt?.schemaVersion === 2
              && opForAttempt.state === 'succeeded'
              && opForAttempt.receipt !== null
              && Boolean(await p.messages.get(u, s, outputId(a)));
            if (!provenOperationPublication || !p.calendarOperationsV2) {
              throw new AppError('NOT_READY', 'Completed turn is missing graph evidence.');
            }
            await repairOperationEventV2({
              store: p.calendarOperationsV2,
              metadata: p.metadata,
              write: action => job.wait(p.owner.run(lease!, action), this.d.config.budgets.persistenceTimeoutMs),
              operation: opForAttempt,
              attemptId: a.attemptId,
            });
            const latestManifest = await p.memory.get(u, s);
            if (latestManifest) {
              await advancePublicationIfClean(latestManifest, a);
            }
            if (session.execution.activeAttemptId === aId) {
              await job.wait(p.owner.clearAttempt(lease, aId), this.d.config.budgets.persistenceTimeoutMs);
            }
          } else if (session.execution.activeAttemptId === aId) {
            await job.wait(p.owner.clearAttempt(lease, aId), this.d.config.budgets.persistenceTimeoutMs);
          }
        } else if (isMinimalAttempt) {
          // A minimal-barrier attempt has no graph seal; interrupt only via legal
          // attempt transitions so dirty memory watermarks are never leaped over.
          if (opForAttempt?.schemaVersion === 2 && opForAttempt.state === 'succeeded'
            && opForAttempt.receipt !== null && p.calendarOperationsV2) {
            await repairOperationEventV2({
              store: p.calendarOperationsV2,
              metadata: p.metadata,
              write: action => job.wait(p.owner.run(lease!, action), this.d.config.budgets.persistenceTimeoutMs),
              operation: opForAttempt,
              attemptId: a.attemptId,
            });
          }
          a = await transition(p, lease, job, a, 'interrupted', 'INTERRUPTED');
          if (session.execution.activeAttemptId === aId) {
            await job.wait(p.owner.clearAttempt(lease, aId), this.d.config.budgets.persistenceTimeoutMs);
          }
        } else {
          await interruptAttempt({ p, lease, job, graph, attempt: a, partial: '',
            error: new AppError('INTERRUPTED', 'Generation was interrupted. Retry to continue.', false),
            assets: this.d.assets, budgets: this.d.config.budgets });
        }
      }
      const attemptCacheKey = this.attemptKey(u, s, aId);
      this.attemptSettings.delete(attemptCacheKey);
      this.attemptPersonalization.delete(attemptCacheKey);
      this.attemptTimeZone.delete(attemptCacheKey);
      this.attemptRequestGeo.delete(attemptCacheKey);
      this.attemptCalendar.delete(attemptCacheKey);
      this.attemptIdentities.delete(attemptCacheKey);
      await reconcileVoiceDeliveries(p, lease, job);
    } finally {
      await job.settled(); await p.owner.drain(); if (lease) await p.owner.release(lease); job.close();
    }
    }).then(() => this.memoryFor(u)?.reconcilePromoted(s));
  }
  private async visibleTurn(u: string, s: string, t: string) {
    const a = await latestAttempt(this.d.persistence, u, s, t);
    if (this.memoryFor(u)) await this.assertPublished(a);
    const input = await this.d.persistence.messages.get(u, s, a.causal.userMessageId);
    if (!input || input.visibility === 'internal') throw new AppError('NOT_FOUND', 'Turn not found.');
    return a;
  }
  private async assertPublished(a: AttemptRecord): Promise<void> {
    const session = await this.d.persistence.sessions.get(a.userId, a.sessionId);
    if (!session || session.lifecycle !== 'active') throw new AppError('NOT_FOUND', 'Chat not found.');
    if (session.memoryPublication && (session.memoryPublication.version === 0 || a.sequence > session.memoryPublication.sequence))
      throw new AppError('NOT_READY', 'This response has not been confirmed saved.');
  }
  private async turnStatus(u: string, s: string, t: string, attempt?: AttemptRecord) {
    const a = attempt ?? await latestAttempt(this.d.persistence, u, s, t);
    const error = a.errorCode ? new AppError(a.errorCode,
      a.errorCode === 'CANCELLED' ? 'Generation was cancelled.' : 'This response is incomplete. Retry or start a new chat.',
      ['failed', 'cancelled', 'interrupted'].includes(a.status)).toClientBody() : null;
    return turnStatusResponseSchema.parse({ sessionId: s, turnId: t, attemptId: a.attemptId,
      status: a.status, truncated: a.truncated, error });
  }
  async getTurnStatus(u: string, s: string, t: string) {
    if (this.memoryFor(u)?.find(s, t)?.turn.mode === 'live') throw new AppError('NOT_FOUND', 'Turn not found.');
    const memory = this.memoryFor(u)?.status(u, s, t); if (memory) return memory;
    const a = await this.visibleTurn(u, s, t); return this.turnStatus(u, s, t, a);
  }
  async getStreamAttempt(u: string, s: string, t: string) {
    if (this.memoryFor(u)?.find(s, t)?.turn.mode === 'live') throw new AppError('NOT_FOUND', 'Turn not found.');
    if (this.liveTurnKeys.has(`${u}\0${s}\0${t}`)) throw new AppError('NOT_FOUND', 'Turn not found.');
    const memory = this.memoryFor(u)?.status(u, s, t); if (memory) return memory;
    const receipt = this.receipts.getByTurn(u, s, t);
    if (!receipt || receipt.sessionId !== s || receipt.turnId !== t) return null;
    const input = receipt.input.record;
    // Public HTTP stream is text-only. Live/internal evidence stays on the voice route.
    if (receipt.responseMode !== 'text' || input.visibility === 'internal' || input.mode === 'live') {
      throw new AppError('NOT_FOUND', 'Turn not found.');
    }
    return this.turnStatus(u, s, t, receipt.attempt.record);
  }
  async getCalendarTurnState(u: string, s: string, t: string): Promise<CalendarCompatibleTurnState | null> {
    if (!this.d.calendarFor && !this.d.calendar) return null;
    return projectCalendarTurnStateCompatible(this.d.persistence, u, s, t);
  }
  async getLiveTurnStatus(u: string, s: string, t: string, reservation: ExecutionReservation) {
    this.reservations.assertLive(reservation, this.identity({ userId: u, openRouterUser: u, source: 'authenticated-session' }), s);
    const memory = this.memoryFor(u)?.find(s, t);
    if (memory?.turn.mode === 'live') return this.memoryFor(u)!.status(u, s, t)!;
    const receipt = !this.work.get(u, s) ? this.receipts.getByTurn(u, s, t) : null;
    // Only the fresh, idle acceptance handoff is reusable; running, cancelled,
    // expired and recovery paths still load current durable status.
    const accepted = receipt?.responseMode === 'voice' && receipt.attempt.record.status === 'accepted'
      && receipt.executorId === this.d.persistence.owner.executorId ? receipt : null;
    const a = accepted?.attempt.record ?? await latestAttempt(this.d.persistence, u, s, t);
    const input = accepted?.input.record ?? await this.d.persistence.messages.get(u, s, a.causal.userMessageId);
    if (!input || input.visibility !== 'internal' || input.mode !== 'live') throw new AppError('NOT_FOUND', 'Turn not found.');
    return this.turnStatus(u, s, t, a);
  }
  async findLiveSubmission(c: SubmitLiveTurn) {
    const id = this.identity(c.identity), s = sessionIdFor(id.userId, c.sessionId, c.idempotencyKey);
    this.assertConversationAdmission(id.userId, s);
    this.reservations.assertLive(c.reservation, id, s);
    if (this.memoryFor(id.userId, true)?.eligibleVoice() && c.voice) {
      if (this.memoryFor(id.userId)!.hasRequest(s, c.idempotencyKey)) return this.memoryFor(id.userId)!.submit(c, undefined, c);
      return null;
    }
    const a = await this.d.persistence.metadata.getAttemptByIdempotency(id.userId, s, c.idempotencyKey);
    if (!a) {
      if (this.freshLiveSubmissions.size >= 1024) {
        const oldest = this.freshLiveSubmissions.keys().next().value;
        if (oldest) this.freshLiveSubmissions.delete(oldest);
      }
      this.freshLiveSubmissions.set(
        JSON.stringify([id.userId, s, c.idempotencyKey, hashPayload(c.content)]),
        Date.now() + 10_000,
      );
      return null;
    }
    const input = await this.d.persistence.messages.get(id.userId, s, a.causal.userMessageId);
    if (!input || input.visibility !== 'internal' || input.mode !== 'live' || input.content !== c.content)
      throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This request identity has different input.');
    if (!await this.d.persistence.metadata.getAcceptance(id.userId, s, a.attemptId))
      throw new AppError('NOT_READY', 'Voice acceptance needs recovery.');
    return responseFor(a);
  }
  async getLiveDelivery(u: string, s: string, a: string, reservation: ExecutionReservation) {
    this.reservations.assertLive(reservation, this.identity({ userId: u, openRouterUser: u, source: 'authenticated-session' }), s);
    if (this.memoryFor(u)?.owns(s) && this.memoryFor(u)!.session(u, s))
      return this.memoryFor(u)!.foundation.deliveries(s).find(d => d.attemptId === a) ?? null;
    return this.d.persistence.metadata.getVoiceDelivery(u, s, a);
  }
  processEpoch(): string | null { return this.d.memoryFirst ? this.epoch : null; }
  async activeSessionTurn(u: string, s: string) {
    const memoryActive = this.memoryFor(u)?.activeTurn(u, s);
    if (memoryActive) return memoryActive;
    const session = await this.d.persistence.sessions.get(u, s);
    if (!session || session.lifecycle !== 'active' || !session.execution.activeAttemptId) return null;
    const attempt = await this.d.persistence.metadata.getAttempt(u, s, session.execution.activeAttemptId);
    if (!attempt || (attempt.status !== 'accepted' && attempt.status !== 'generating' && attempt.status !== 'finalizing')) return null;
    const input = await this.d.persistence.messages.get(u, s, attempt.causal.userMessageId);
    return {
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      status: attempt.status,
      ...(input?.mode ? { mode: input.mode } : {}),
    };
  }
  memorySession(u: string, s: string) { return this.memoryFor(u)?.session(u, s) ?? null; }
  async prepareSession(u: string, s: string): Promise<void> {
    this.assertConversationAdmission(u, s);
    const memory = this.memoryFor(u, true);
    if (!memory?.eligible()) return;
    try {
      await memory.prepare(u, s);
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return;
      throw error;
    }
  }
  observeVoiceAccounting(record: import('../contracts/voice-accounting.js').VoiceAccountingRecord): boolean {
    const memory = this.memoryFor(record.userId);
    if (!memory || !this.d.memoryFirst?.voice) return false;
    memory.foundation.observeVoice(record); return true;
  }
  async retrySave(u: string, s: string, t: string, expected: { epoch: string; version: number }) {
    this.assertConversationAdmission(u, s);
    const owner = this.memoryFor(u);
    const status = owner?.status(u, s, t);
    if (!status?.save) throw new AppError('NOT_FOUND', 'Unsaved response not found.');
    if (status.save.epoch !== expected.epoch || status.save.version !== expected.version)
      throw new AppError('INTERRUPTED', 'This save belongs to an earlier response. Refresh its status.', false);
    if (!['saved', 'saving', 'pending'].includes(status.save.state) && !owner!.foundation.retrySave(s))
      throw new AppError('NOT_READY', 'Saving cannot be retried automatically. Keep a copy of this response.', false);
    return owner!.status(u, s, t)!;
  }
  memoryMessages(u: string, s: string, p: import('../contracts/repositories.js').PageQuery) { return this.memoryFor(u)?.messages(u, s, p) ?? null; }
  compactionState(u: string, s: string) { return this.memoryFor(u, true)?.compactionState(u, s) ?? null; }
  assertSessionMutation(u: string, s: string) {
    this.assertConversationAdmission(u, s);
    this.memoryFor(u)?.assertMutation(u, s);
  }
  memoryAdmissionReady() {
    if (!this.d.memoryFirst || !this.work.accepting || this.work.degraded) return false;
    const cal = this.d.calendarFor ? true : this.d.calendar && isCalendarV2(this.d.calendar);
    return !this.d.currentConfig?.current()?.calendar?.enabled || Boolean(cal);
  }
  overlaySessions(u: string, p: import('../contracts/repositories.js').PageQuery, durable: import('../contracts/api.js').ListSessionsResponse) {
    return this.memoryFor(u)?.overlaySessions(u, p, durable) ?? durable;
  }
  stopAccepting() {
    this.work.accepting = false;
    this.userMemoryScheduler?.close();
    for (const memory of this.memoryOwners.values()) memory.foundation.stopAdmission();
  }
  async interruptUser(userId: string): Promise<void> {
    this.userMemoryScheduler?.deactivate(userId);
    this.work.interruptUser(userId);
    await this.memoryFor(userId)?.interruptPending();
    const pending: Array<{ sessionId: string; turnId: string; attemptId: string; identity: import('../contracts/identity.js').ResolvedIdentity }> = [];
    for (const [key, identity] of this.attemptIdentities) {
      const [owner, sessionId, attemptId] = JSON.parse(key) as [string, string, string];
      if (owner !== userId || !sessionId || !attemptId) continue;
      const receipt = this.receipts.get(userId, sessionId, attemptId);
      if (receipt) pending.push({ sessionId, turnId: receipt.turnId, attemptId, identity });
    }
    for (const item of pending) {
      try {
        await this.cancelOwnedTurn({
          identity: item.identity, sessionId: item.sessionId, turnId: item.turnId, attemptId: item.attemptId,
        });
      } catch { /* Keep failed/unknown finalizing state for reconciliation. */ }
    }
  }
  snapshot() {
    const work = this.work.snapshot();
    const memory = this.aggregateMemory();
    return { ...work, unresolvedWrites: work.unresolvedWrites + (memory?.unresolvedWrites ?? 0), ...(memory ? { memory } : {}) };
  }
  private aggregateMemory() {
    if (!this.d.memoryFirst) return null;
    const total = { accepting: true, sessions: 0, reservedMemoryBytes: 0, pending: 0,
      reservedBacklogBytes: 0, unresolvedWrites: 0, active: 0 };
    for (const memory of this.memoryOwners.values()) {
      const s = memory.foundation.snapshot();
      total.accepting = total.accepting && s.accepting;
      total.sessions += s.sessions;
      total.reservedMemoryBytes += s.reservedMemoryBytes;
      total.pending += s.pending;
      total.reservedBacklogBytes += s.reservedBacklogBytes;
      total.unresolvedWrites += s.unresolvedWrites;
      total.active += s.active;
    }
    return total;
  }
  /**
   * Reserve a relevant operator stream before the first asynchronous status work.
   * Hold the returned run() through open()/executeTurn() and message persistence.
   */
  reserveStream(userId: string, sessionId: string, signal: AbortSignal): StreamReservation {
    this.ready();
    this.assertConversationAdmission(userId, sessionId);
    return this.work.reserve(userId, sessionId, signal, this.d.config.budgets.totalRunTimeoutMs);
  }
  /**
   * Close the stream fence, abort reserved/active work, and wait through final
   * message persistence. Does not reopen; a failed scan must not call releaseStreamFence.
   */
  async quiesceStreams(timeoutMs = this.d.config.budgets.shutdownDrainMs): Promise<StreamQuiesceResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.d.config.budgets.shutdownDrainMs)
      throw new AppError('INVALID_REQUEST', 'Invalid drain budget.');
    const result = await this.work.quiesce(timeoutMs);
    this.receipts.clear();
    this.sessionCalendarMessages.clear();
    this.confirmedState.clear();
    return result;
  }
  releaseStreamFence() { this.work.releaseFence(); }
  clearConfirmedState(): void {
    this.sessionCalendarMessages.clear();
    this.confirmedState.clear();
  }
  async drain(timeoutMs = this.d.config.budgets.shutdownDrainMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.d.config.budgets.shutdownDrainMs)
      throw new AppError('INVALID_REQUEST', 'Invalid drain budget.');
    this.userMemoryScheduler?.close();
    const started = performance.now();
    const result = await this.work.drain(timeoutMs);
    if (!result.drained) return result;
    if (this.memoryOwners.size) {
      for (const memory of this.memoryOwners.values()) await memory.stopPending();
      let loadingCount = 0, unresolved = 0;
      for (const memory of this.memoryOwners.values()) {
        loadingCount += memory.loadingCount;
        unresolved += memory.foundation.snapshot().unresolvedWrites;
      }
      const remaining = Math.floor(timeoutMs - (performance.now() - started));
      if (remaining < 1 || loadingCount > 0)
        return { drained: false, active: loadingCount, unresolvedWrites: unresolved };
      let drained = true, active = 0, pendingWrites = 0;
      for (const memory of this.memoryOwners.values()) {
        const left = Math.floor(timeoutMs - (performance.now() - started));
        if (left < 1) return { drained: false, active, unresolvedWrites: pendingWrites || unresolved };
        await memory.drainCompactions(Math.min(left, this.d.memoryFirst!.policy.shutdownDrainMs));
        const part = await memory.foundation.drain(Math.min(left, this.d.memoryFirst!.policy.shutdownDrainMs));
        if (!part.drained) {
          drained = false;
          active += part.active;
          pendingWrites += part.unresolvedWrites + part.pending;
        }
      }
      if (!drained) return { drained: false, active, unresolvedWrites: pendingWrites };
    }
    await this.d.persistence.owner.drain();
    if (!this.work.accepting && this.work.snapshot().active === 0) {
      this.attemptSettings.clear();
      this.attemptPersonalization.clear();
      this.attemptTimeZone.clear();
      this.attemptRequestGeo.clear();
      this.attemptCalendar.clear();
      this.attemptIdentities.clear();
      this.receipts.clear();
      this.sessionCalendarMessages.clear();
      this.confirmedState.clear();
    }
    return result;
  }
  allowStoppedOwner(ownerId: string) {
    if (!ownerId || ownerId.length > 128 || this.work.snapshot().active) throw new AppError('NOT_READY', 'Recovery is not quiescent.');
    this.stoppedOwners.add(ownerId);
  }
  async rebaseSession(u: string, s: string): Promise<void> {
    this.assertConversationAdmission(u, s);
    const p = this.d.persistence;
    if (this.work.get(u, s)) throw new AppError('CONFLICT_ACTIVE_TURN', 'Chat is still active.');
    this.receipts.delete(u, s);
    this.sessionCalendarMessages.delete(this.sessionKey(u, s));
    this.confirmedState.delete(u, s);
    const session = await p.sessions.get(u, s);
    if (!session || session.execution.activeAttemptId || session.execution.ownerId) throw new AppError('NOT_READY', 'Chat must be reconciled before rebasing.');
    const job = this.work.open(u, s, new AbortController().signal, this.d.config.budgets.totalRunTimeoutMs);
    let lease: ExecutionLease | undefined;
    try {
      const owned = await p.owner.acquire({ userId: u, sessionId: s, ownerId: p.owner.executorId, leaseMs: 180000 });
      if (!owned.ok) throw new AppError('CONFLICT_ACTIVE_TURN', 'Chat is active.'); lease = owned.lease;
      const old = await p.memory.get(u, s); if (!old) throw new AppError('NOT_READY', 'Chat memory is unavailable.');
      const graph = await this.graph(lease); const snap = await graph.getState(graphConfig(u, s));
      if (snap.values.rebase) {
        await finishRebase(p, lease, job, graph, rebaseSchema.parse(snap.values.rebase));
        return;
      }
      if (snap.next.length || !isDeepStrictEqual(snap.values.boundary, boundaryFor(old))) throw new AppError('NOT_READY', 'Graph and memory disagree.');
      const history = await acceptedHistory(p, u, s);
      const oldAssets = { ...this.d.assets, instructionVersion: old.instructionVersion,
        knowledgeContentHash: old.knowledgeContentHash, graphSchemaVersion: old.graphSchemaVersion };
      const verified = buildReferenceManifest(u, s, old.contextVersion, history, oldAssets, this.d.config.budgets, old.activeSummaryRef, old.pinnedUserMemory);
      if (!isDeepStrictEqual(verified, old) || old.graphSchemaVersion !== this.d.assets.graphSchemaVersion)
        throw new AppError('NOT_READY', 'Chat requires a schema migration, not a version rebase.');
      if (old.instructionVersion === this.d.assets.instructionVersion && old.knowledgeContentHash === this.d.assets.knowledgeContentHash) return;
      const next = buildReferenceManifest(u, s, old.contextVersion + 1, history, this.d.assets, this.d.config.budgets, old.activeSummaryRef, old.pinnedUserMemory);
      const intent = { base: boundaryFor(old), target: next };
      await job.wait(graph.updateState(graphConfig(u, s), { rebase: intent }, 'seal'), this.d.config.budgets.persistenceTimeoutMs);
      await finishRebase(p, lease, job, graph, intent);
    } finally { await job.settled(); await p.owner.drain(); if (lease) await p.owner.release(lease); job.close(); }
  }
}
