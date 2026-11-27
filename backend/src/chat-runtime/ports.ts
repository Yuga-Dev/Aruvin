/**
 * ============================================================================
 * FILE: ports.ts
 * LOCATION: backend/src/chat-runtime/ports.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Project P1/P2/P4 types into request-owned execution and drain ports.
 *
 * ROLE IN PROJECT:
 *    Lets P6 attach one stream executor per attempt and lets P8 drain or
 *    authorize stopped-owner recovery without changing upstream contracts.
 *
 * KEY COMPONENTS:
 *    - RuntimeDependencies: Config, persistence, assembler, assets, limits.
 *    - ChatRuntime: AgentRuntime plus executeTurn, drain, quiesce, rebase, and hooks.
 *    - ExecuteTurn/DrainResult: Transport-independent request ownership.
 *    - StreamReservation/Quiesce: Fence a stream before status; wait to persist.
 *    - CalendarCompatibleEnvelope/TurnState: Protocol-2/3 frame, v1/v2 state.
 * ============================================================================
 */

import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { z } from 'zod';
import type { AgentRuntime } from '../contracts/runtime.js';
import type { TurnStatusResponse } from '../contracts/api.js';
import type { StreamEnvelope } from '../contracts/stream.js';
import type { PersistenceBundle } from '../persistence/persistence.js';
import type { ContextAssembler } from '../contracts/context.js';
import type { UserPersonalizationSettings } from '../contracts/personalization.js';
import type { FixedAssets } from '../instructions/fixed-assets.js';
import type { AurvinConfig } from '../platform/config/load-config.js';
import type { ModelLimits } from '../model/index.js';
import type { ExecutionReservation, VoiceDeliveryRecord } from '../contracts/voice.js';
import type { SubmitTurnCommand as AgentSubmitTurn } from '../contracts/runtime.js';
import type { CompatibleCalendarToolGroup } from '../context/calendar-context.js';
import type { MemoryToolCandidate } from '../model/calendar-validation.js';
import type { UpdateUserMemoryReceipt } from '../contracts/user-memory.js';
import type { AttemptRecord } from '../contracts/attempt.js';
import type { UserMemoryService } from '../personalization/user-memory.service.js';
import type { MemoryWriterService } from '../personalization/memory-writer.js';
import type { MemoryFirstPolicy, SaveTerminal, SaveVoiceObservation } from './memory-first-foundation.js';

import type { CurrentConfigPort, RuntimeConfigSnapshot } from '../contracts/config-runtime.js';
import type { BudgetConfig } from '../contracts/budgets.js';
import type { AuthPrincipal } from '../contracts/auth.js';
import type { DevModeTurnAuthority } from '../admin-config/dev-mode-authority.js';
import type {
  CanvasArtifactProjection,
  CanvasControlArguments,
  CanvasInventorySnapshot,
  CanvasSelection,
} from '../contracts/voice-wire.js';
import type {
  calendarCompatibleEnvelopeSchema,
  calendarCompatibleTurnStateSchema,
} from '../contracts/calendar-wire.js';
import type { CalendarRuntimeDependencies } from './calendar-ports.js';
import type { WebSearchPort } from '../plugins/web-search/types.js';
import type { RequestGeoHint } from '../platform/environment/request-environment.js';
import type { WeatherProvider } from '../environment/weather-service.js';
import type { WeatherView } from '../contracts/weather-view.js';
import type { StreamQuiesceResult, StreamReservation } from './work.js';
export type { StreamQuiesceResult, StreamReservation };

/**
 * The Calendar stream envelope the runtime port accepts.
 *
 * Protocol 2 stays accepted because the v1 Calendar path still emits
 * protocol-2 frames. Protocol 3 is accepted so a saved v2 seal can publish
 * its own frame truthfully instead of through a cast.
 */
export type CalendarCompatibleEnvelope = z.infer<typeof calendarCompatibleEnvelopeSchema>;
/** The Calendar turn state the runtime port returns: v1 receipt or v2 state. */
export type CalendarCompatibleTurnState = z.infer<typeof calendarCompatibleTurnStateSchema>;

/** Local command widening: P1's contract has no creation-mode field yet. */
export type SubmitTurnCommand = AgentSubmitTurn & { ephemeral?: boolean };
/** Off-path user memory has no storage dependency on the model hot path. */
export type UserMemoryRuntime = {
  cache: Pick<UserMemoryService, 'cachedMemory' | 'cachedSnapshot'>;
  writer: Pick<MemoryWriterService, 'applyInstruction' | 'synthesize'>;
  trackWrite?: <T>(run: () => Promise<T>) => Promise<T>;
};
/** One attempt-scoped memory executor; the writer CAS is the commit. */
export type MemoryToolTurn = {
  allowed(): boolean;
  receipt(): UpdateUserMemoryReceipt | null;
  run(candidate: Exclude<MemoryToolCandidate, { kind: 'memory-invalid' }>, signal: AbortSignal):
    Promise<CompatibleCalendarToolGroup>;
};

export type SubmitLiveTurn = Omit<SubmitTurnCommand, 'sessionId'> & {
  sessionId: string;
  reservation: ExecutionReservation;
  configSnapshot?: RuntimeConfigSnapshot;
  freshConversation?: boolean;
  clientTimeZone?: string | null;
  requestGeo?: RequestGeoHint | null;
  voice?: { voiceSessionId: string; socketEpoch: number; providerTurnId: string };
};
export type DeliveryWrite = (record: VoiceDeliveryRecord, expectedSequence?: number) => Promise<void>;
export type LiveExecution = {
  reservation: ExecutionReservation;
  start(attempt: AttemptRecord, write: DeliveryWrite): Promise<void>;
  delta(text: string): Promise<void>;
  finish(): Promise<void>;
  artifact?(artifact: CanvasArtifactProjection): Promise<boolean>;
  /** Trusted current-call Canvas presentation port; absent in non-live turns. */
  canvas?: {
    inventory(): CanvasInventorySnapshot;
    active(): boolean;
    show(canvasId: string, navigationId: string, signal: AbortSignal): boolean;
    selection?(): CanvasSelection | null;
    control?(command: CanvasControlArguments, target: CanvasSelection,
      toolCallId: string, signal: AbortSignal): boolean;
  };
  modelStarted?(): void;
  modelOutput?(): void;
  settle(finalGenerated: string, signal?: AbortSignal): Promise<void>;
};

export type AttemptStreamBudgets = Pick<BudgetConfig, 'idleStreamTimeoutMs' | 'maxMessageBytes'>;

export type DiagnosticSink = (fields: Readonly<Record<string, unknown>>) => void;
export type DiagnosticScope = Partial<Record<'sessionId' | 'turnId' | 'attemptId' |
  'dispatchId' | 'decisionId' | 'toolCallId' | 'operationId' | 'tool' | 'schemaRevision' |
  'schemaFingerprint' | 'databasePhase' | 'databaseOrigin', string>>;
export type ProcessDiagnostics = {
  emit: DiagnosticSink;
  run<T>(scope: DiagnosticScope, work: () => T): T;
};
export function diagnose(sink: DiagnosticSink | undefined, fields: Readonly<Record<string, unknown>>): void {
  try { sink?.(fields); } catch { /* Best effort; never retry or change chat. */ }
}

export type RuntimeDependencies = {
  config: AurvinConfig;
  persistence: PersistenceBundle;
  assembler: ContextAssembler & { forBudgets?(budgets: BudgetConfig): ContextAssembler };
  assets: FixedAssets;
  limits?: ModelLimits;
  currentConfig?: CurrentConfigPort;
  fetcher?: typeof fetch;
  now?: () => number;
  calendar?: CalendarRuntimeDependencies;
  calendarFor?: (userId: string) => CalendarRuntimeDependencies;
  configFor?: (userId: string) => RuntimeConfigSnapshot | null;
  personalizationFor?: (userId: string) => UserPersonalizationSettings;
  /** Secret-free, account-scoped web port; absent means web is not installed. */
  webSearch?: WebSearchPort;
  weatherProvider?: WeatherProvider;
  diagnostics?: ProcessDiagnostics;
  memoryFirst?: { policy: MemoryFirstPolicy; save?: SaveTerminal; voice?: boolean; saveVoiceObservation?: SaveVoiceObservation };
  /** P1's one synchronous User/Dev authority; absent keeps today's prompt bytes. */
  devMode?: DevModeTurnAuthority;
  /** Optional user-memory cache/writer; older fixtures omit it. */
  userMemory?: UserMemoryRuntime;
};
export type ExecuteTurn = {
  userId: string; sessionId: string; turnId: string; attemptId: string;
  signal: AbortSignal; emit: (event: StreamEnvelope) => Promise<void>;
  emitCalendar?: (event: CalendarCompatibleEnvelope) => Promise<void>;
  live?: LiveExecution;
  /** Request-local trusted principal; never persisted, derived, or sent to a provider. */
  principal?: AuthPrincipal;
  /** Internal voice control marker; it never spends a model announcement. */
  localToolControl?: boolean;
  onWeatherView?: (view: WeatherView) => void;
};
export type DrainResult = { drained: boolean; active: number; unresolvedWrites: number };
export interface ChatRuntime extends AgentRuntime {
  processEpoch?(): string | null;
  prepareSession?(userId: string, sessionId: string): Promise<void>;
  activeSessionTurn?(userId: string, sessionId: string): Promise<import('../contracts/api.js').ActiveSessionTurn | null>;
  observeVoiceAccounting?(record: import('../contracts/voice-accounting.js').VoiceAccountingRecord): boolean;
  /** Task mode: skip a not-yet-started step of the running task (memory-only). */
  skipTaskStep?(command: import('../contracts/runtime.js').CancelTurnCommand, stepId: string): Promise<void>;
  retrySave?(userId: string, sessionId: string, turnId: string,
    expected: { epoch: string; version: number }): Promise<TurnStatusResponse>;
  memorySession?(userId: string, sessionId: string): import('../contracts/session.js').SessionRecord | null;
  memoryMessages?(userId: string, sessionId: string, page: import('../contracts/repositories.js').PageQuery): import('../contracts/api.js').ListMessagesResponse | null;
  assertSessionMutation?(userId: string, sessionId: string): void;
  memoryAdmissionReady?(): boolean;
  /** Fence and hard-purge one owned Temporary Chat; true means confirmed removal. */
  purgeEphemeral?(userId: string, sessionId: string,
    options?: { cutoff?: string; stopTransport?: () => Promise<void> }): Promise<boolean>;
  assertConversationAdmission?(userId: string, sessionId: string): void;
  overlaySessions?(userId: string, page: import('../contracts/repositories.js').PageQuery,
    durable: import('../contracts/api.js').ListSessionsResponse): import('../contracts/api.js').ListSessionsResponse;
  executeTurn(command: ExecuteTurn): Promise<void>;
  stopAccepting(): void;
  interruptUser?(userId: string): Promise<void>;
  snapshot(): { accepting: boolean; active: number; unresolvedWrites: number; degraded: boolean };
  drain(timeoutMs?: number): Promise<DrainResult>;
  reserveStream?(userId: string, sessionId: string, signal: AbortSignal): StreamReservation;
  quiesceStreams?(timeoutMs?: number): Promise<StreamQuiesceResult>;
  releaseStreamFence?(): void;
  clearConfirmedState?(): void;
  allowStoppedOwner(ownerId: string): void;
  rebaseSession(userId: string, sessionId: string): Promise<void>;
  attemptStreamBudgets?(userId: string, sessionId: string, attemptId: string): AttemptStreamBudgets;
  getStreamAttempt?(userId: string, sessionId: string, turnId: string): Promise<TurnStatusResponse | null>;
  getCalendarTurnState?(userId: string, sessionId: string, turnId: string): Promise<CalendarCompatibleTurnState | null>;
}
export type RuntimeSaver = BaseCheckpointSaver;
