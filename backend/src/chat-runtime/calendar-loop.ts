/**
 * ============================================================================
 * FILE: calendar-loop.ts
 * LOCATION: backend/src/chat-runtime/calendar-loop.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Manage the decide-execute-seal turn graph loop for conversational Calendar execution.
 *
 * ROLE IN PROJECT:
 *    Executes Calendar model dispatches, resolves conversational calendar targets,
 *    enforces intent binding and capability gates, coordinates tool execution,
 *    and streams progress/clarification envelopes across v1 and v2.
 *
 * KEY COMPONENTS:
 *    - CalendarLoop: Graph execution node implementation (decide, execute, seal).
 *    - executeCreateV2: Resolves target calendar via capability gate, binds intent, and creates events.
 *    - Recoverable failures: Seal a user-facing answer instead of failing the accepted turn.
 *    - Reply target: A reply answers only the current proposal, proven by the bound reply reference.
 *    - Incomplete proposals: Missing details and unknown targets are published, never consumed.
 *    - emit: Emits versioned SSE frames conforming to protocol v2 or v3 multi-stream.
 * ============================================================================
 */

import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AgentMemoryManifest } from '../contracts/agent-memory.js';
import type { AttemptRecord } from '../contracts/attempt.js';
import type { CalendarConnectionBinding } from '../contracts/calendar-connections.js';
import {
  completeToolGroupSchema, completeToolGroupV2Schema, rejectedDecisionSchema, rejectedDecisionV2Schema,
  resumableSkillDecisionSchema, skillDecisionSchema,
  type CalendarDecision, type CalendarRejectedDecision, type CalendarRejectedDecisionV2, type CompleteCalendarToolGroup,
  type CalendarRepairDiagnostics, type HistoricalSkillDecision, type SkillDecision, type SkillDecisionRequest, type SkillModelPort,
} from '../contracts/calendar-model.js';
import { calendarFailureSchema, type CalendarFailure, type CalendarLimits } from '../contracts/calendar-policy.js';
import { CALENDAR_TOOLS, SKILL_NATIVE_TOOLS, calendarCallSchema, callToolEnvelopeSchema,
  canvasControlResultSchema, canvasNavigationResultSchema, controlCanvasArgumentsSchema,
  serializeNativeLocalResult, showCanvasArgumentsSchema, skillError,
  type CalendarCall, type CalendarCreateInput, type NativeLocalResult, type SkillLocalResult } from '../contracts/calendar-tools.js';
import type { GetEnvironmentEnvelope } from '../contracts/environment-tools.js';
import type { WeatherView } from '../contracts/weather-view.js';
import { executeEnvironmentTool, type EnvironmentExecutionResult } from '../environment/environment-tool.js';
import type { CanvasControlArguments, CanvasControlResult, CanvasInventorySnapshot, CanvasNavigationResult,
  CanvasSelection } from '../contracts/canvas-navigation.js';
import { canvasTurnState, isRedundantCanvasControl } from './canvas-navigation.js';
import { projectTurnMessages, turnModeGuidance, turnModeMarker, type PositionedContext }
  from '../context/referenced-context-assembler.js';
import { dispatchStream, type TurnModeHandle, type TurnModelDispatch } from './turn-model-mode.js';
import {
  calendarMultiStreamEnvelopeSchema,
  calendarStreamEnvelopeSchema,
  type CalendarStreamEnvelope,
} from '../contracts/calendar-wire.js';
import type { AssembledContext, ContextChatMessage } from '../contracts/context.js';
import type { RuntimeConfigSnapshot } from '../contracts/config-runtime.js';
import { messageRecordSchema, type MessageRecord } from '../contracts/message.js';
import type { ExecutionLease } from '../contracts/repositories.js';
import {
  calendarToolResultRecordSchema,
  calendarToolResultRecordV2Schema,
  localSkillResultRecordSchema,
  sourceReferenceV2Schema,
  CALENDAR_TOMBSTONE,
  type CalendarSourceReferenceV2,
} from '../contracts/calendar-sources.js';
import {
  type CalendarExecutionBindingV2,
  type CalendarRequestKindV2,
} from '../contracts/calendar-operations.js';
import type { FixedAssets } from '../instructions/fixed-assets.js';
import { boundaryFor, calendarCursorSchema, calendarSealSchema, type CalendarCursor, type CalendarRefs, type GraphInput } from '../agent/state.js';
import type { CalendarGraphPatch } from '../agent/turn-graph.js';
import { calendarContext, type CompatibleCalendarToolGroup } from '../context/calendar-context.js';
import { activateLocalSkill, requireLoadedSkill, skillGroup } from './calendar-skills.js';
import { buildReferenceManifest } from '../context/index.js';
import {
  calendarActionHash,
  CalendarToolFault,
  toolFault,
  validateCalendarCall,
} from '../plugins/google-calendar/tools-validation.js';
import type { PersistenceBundle } from '../persistence/persistence.js';
import { redactCalendarSourceForAccount } from '../persistence/calendar-records.js';
import { bounded, key } from '../persistence/records.js';
import { AppError } from '../platform/errors/app-error.js';
import { diagnose } from './ports.js';
import { CALENDAR_DIAGNOSTIC_FINGERPRINTS, createCalendarModelPortV2 } from '../model/calendar-adapter.js';
import { hashPayload } from '../platform/crypto/hash-payload.js';
import { CalendarTurnLedger } from './calendar-budget.js';
import { canonicalCalendarAction, CalendarOperationWriter, PROVIDER_REQUEST_KINDS, type CalendarCreateOutcome, type CalendarOperationWriterOptions } from './calendar-operation.js';
import { readCalendarIntent, readCalendarReply, calendarIntentId, calendarMissingFields, type AcceptedCalendarIntent, type IntentMissingField } from './calendar-intent.js';
import { publishProposal, consumeOrTombstoneProposal, resolveReplyTarget, type PublishProposalInput } from './calendar-authority.js';
import {
  runCalendarPreflight,
  sameApprovedCondition,
} from './calendar-preflight.js';
import {
  calendarAvailabilityFingerprint,
  type CalendarAvailabilityResult,
} from '../contracts/calendar-availability.js';
import type { CalendarProposalConsumption, CalendarProposalRecord } from '../contracts/calendar-authority.js';
import { calendarProposalTombstoneSchema } from '../contracts/calendar-authority.js';
import type { CalendarView } from '../contracts/calendar-view.js';
import { calendarNotice, projectAgendaView, projectOutcomeView, projectProposalView } from './calendar-view.js';
import type { CalendarAccountBinding, CalendarResolvedTarget } from '../contracts/calendar-discovery.js';
import { projectCalendarTurnStateCompatible, projectConfirmedCalendarTurnState } from './calendar-publication.js';
import { isCalendarV2, resolveCalendarTimeZone, type CalendarRuntimeDependencies, type CalendarRuntimeV2Dependencies } from './calendar-ports.js';
import type { ProcessDiagnostics } from './ports.js';
import { eventIdFor, outputId } from './identity.js';
import { attemptsFor } from './history.js';
import type { Work } from './work.js';
import { MemoryCalendarLedger } from './memory-calendar-ledger.js';
import { sanitizeToolDecisionForVolatileHistory, type MemoryCalendarStage } from './memory-calendar-state.js';
import type { WebTurn } from './web-turn.js';
import { webToolsFor, webNativeToolsFor, isWebDecision, memoryCallId, memoryReceiptHeadroom,
  memoryReceiptText, type WebDecision, type WebNativeDecision, type WebNativeRequest } from '../model/web-native.js';
import { readMemoryToolCandidate, type MemoryToolCandidate } from '../model/calendar-validation.js';
import { skillToolsFor } from '../model/calendar-policy.js';
import { UPDATE_USER_MEMORY_TOOL_NAME } from '../contracts/user-memory.js';
import type { MemoryToolTurn } from './ports.js';
import type { WebToolGroup } from './memory-web-state.js';
import { separateAssistantContinuation } from './assistant-continuation.js';

/** Volatile evidence is deliberately separate from persistence and ownership. */
export type CalendarMemoryExecution = {
  stage: MemoryCalendarStage;
  records: readonly MessageRecord[];
  pendingProposal: CalendarProposalRecord | null;
  onProposal?: (proposal: CalendarProposalRecord | null) => void;
  readAccount: () => Promise<CalendarAccountBinding>;
  promote: (cursor: CalendarCursor, refs: CalendarRefs) => Promise<{
    lease: ExecutionLease; binding: CalendarConnectionBinding; ledger: CalendarTurnLedger;
  }>;
  mutation?: {
    ensureAccepted: (options?: { pendingCreateDecisionId?: string | null }) => Promise<void>;
    writerOptions: () => Pick<CalendarOperationWriterOptions, 'write' | 'ledger' | 'fence'>;
    onMutation?: (mutation: {
      operationId: string;
      decision: z.infer<typeof resumableSkillDecisionSchema> | null;
      result: z.infer<typeof calendarToolResultRecordV2Schema>;
    }) => void;
  };
};

export type CalendarLoopContext = {
  persistence: PersistenceBundle;
  calendar?: CalendarRuntimeDependencies;
  /** Calendar plugin execution authority; native Canvas tools do not depend on it. */
  calendarEnabled?: boolean;
  /** Trusted account state for model awareness; it never gates tool execution. */
  calendarConnection?: 'connected' | 'not-connected';
  ledger: CalendarTurnLedger | MemoryCalendarLedger;
  attempt: AttemptRecord;
  input: MessageRecord;
  snapshot: RuntimeConfigSnapshot;
  limits: CalendarLimits;
  binding: CalendarConnectionBinding;
  context: AssembledContext;
  job: Work;
  lease: ExecutionLease | null;
  emitCalendar: (event: any) => Promise<void>;
  /** The shared protocol-3 frame sequence. It is never reset mid-turn. */
  sequence: { value: number };
  assets: FixedAssets;
  manifest: AgentMemoryManifest;
  assistantSequence: number;
  fetcher: typeof fetch;
  now: () => string;
  diagnostics?: ProcessDiagnostics;
  historicalGroups?: ReadonlyMap<string, readonly CompatibleCalendarToolGroup[]>;
  /** Historical web evidence keyed by originating turn, reinserted before Calendar groups. */
  historicalWebGroups?: ReadonlyMap<string, readonly WebToolGroup[]>;
  /** Completed historical turns whose validated Web evidence may be projected on overflow. */
  foldableTurnIds?: ReadonlySet<string>;
  initialGroups?: readonly CompatibleCalendarToolGroup[];
  memory?: CalendarMemoryExecution;
  responseMode?: 'text' | 'voice';
  navigateCanvas?: (envelope: Record<string, unknown>, toolCallId: string) => CanvasNavigationResult;
  /** Trusted intersected inventory, read on every decision for same-call updates. */
  canvasInventory?: () => CanvasInventorySnapshot;
  canvasSelection?: () => CanvasSelection | null;
  /** Optional attempt-scoped explicit memory executor; absent keeps tool bytes unchanged. */
  memoryTool?: MemoryToolTurn;
  controlCanvas?: (envelope: Record<string, unknown>, toolCallId: string,
    expected: CanvasSelection | null) => CanvasControlResult;
  onView?: (view: CalendarView) => void;
  onClearView?: () => void;
  /** Optional accepted-turn web controller; absent keeps Calendar byte-identical. */
  web?: WebTurn;
  /** Task mode: spends from the task's outer attempt/time budget; throws when exhausted. */
  beforeModel?: () => void;
  assistantFields?: () => Pick<MessageRecord, 'mode' | 'visibility' | 'voiceSessionId' | 'canvasArtifacts'>;
  /** Request-local User/Dev handle; absent keeps today's native bytes. */
  turnMode?: TurnModeHandle;
  /** Internal voice Calendar control; it never spends a model announcement. */
  localToolControl?: boolean;
  clientTimeZone?: string | null;
  executeEnvironment?: (envelope: GetEnvironmentEnvelope, signal: AbortSignal) => Promise<EnvironmentExecutionResult>;
  onWeatherView?: (view: WeatherView) => void;
};

/**
 * Each kind is charged when the Calendar HTTP adapter is about to dispatch one
 * REST request. Pagination and capability rechecks therefore consume budget per
 * actual delivery, while model/logical-tool retries are not debited separately.
 */

/**
 * The bounded question asked when a reply engages a pending proposal without
 * answering it. The proposal stays pending; the user is asked once more.
 */
function ambiguousReplyText(proposal: CalendarProposalRecord): string {
  if (proposal.purpose === 'selection') return 'Which calendar should I schedule the event on?';
  if (proposal.purpose === 'details') return 'Please provide the scheduling details I still need.';
  return 'Should I create the event anyway, or would you like a different time?';
}

/**
 * User-facing text for a recoverable Calendar failure. The accepted user
 * message was valid; the model tool call or provider response still needs a
 * conversational answer rather than a failed attempt.
 */
function messageForCalendarFailure(failure: CalendarFailure): string {
  switch (failure.code) {
    case 'TIME_REQUIRES_CLARIFICATION':
      return 'I need an unambiguous date, start time, end time and timezone.';
    case 'TIMED_EVENT_REQUIRED':
      return 'I can only schedule timed events. Please give an unambiguous start and end time.';
    case 'SUMMARY_REQUIRES_CLARIFICATION':
      return 'What should I call this event?';
    case 'CALENDAR_TARGET_UNKNOWN':
    case 'CALENDAR_TARGET_AMBIGUOUS':
    case 'CALENDAR_DEFAULT_UNAVAILABLE':
    case 'CALENDAR_PRIMARY_MISSING':
      return 'Which calendar should I use?';
    case 'CALENDAR_INPUT_REJECTED':
      return 'The Calendar request needs corrected inputs. Please try again.';
    case 'CALENDAR_TARGET_READ_ONLY':
      return 'The selected calendar is read-only. Please choose a calendar where you have permission to create events.';
    case 'CALENDAR_RECONNECT_REQUIRED':
    case 'RECONNECT_REQUIRED':
      return 'Your Google Calendar connection needs to be reconnected.';
    case 'EVENT_NOT_FOUND':
    case 'EVENT_GONE':
      return 'I could not find that event.';
    case 'CALENDAR_FORBIDDEN':
    case 'CALENDAR_EXECUTION_DENIED':
    case 'CALENDAR_UNKNOWN_TOOL':
    case 'UNKNOWN_OR_DISABLED_TOOL':
    case 'FORBIDDEN_TOOL_FIELD':
    case 'OPERATION_AUTHORITY_REQUIRED':
      return 'The Calendar request is not allowed.';
    default:
      return failure.category === 'clarification'
        ? 'The Calendar request needs corrected inputs. Please try again.'
        : 'The Calendar request could not be completed.';
  }
}

/**
 * Infrastructure failures still abort the turn. Model-tool and provider-result
 * failures are sealed as assistant answers instead.
 */
function abortForCalendarFailure(failure: CalendarFailure): AppError | null {
  if (failure.category === 'cancelled') {
    return new AppError('INTERRUPTED', 'The Calendar request was cancelled.', false);
  }
  if (failure.category === 'persistence') {
    return new AppError('PERSISTENCE_ERROR', 'The Calendar request could not be saved.', false);
  }
  if (failure.category === 'budget') {
    if (failure.code === 'CONTEXT_BUDGET_EXCEEDED' || failure.code === 'INPUT_TOO_LARGE') {
      return new AppError('CONTEXT_BUDGET_EXCEEDED', 'This chat has reached its context limit. Start a new chat.', false);
    }
    return new AppError('STORAGE_BUDGET_EXCEEDED', 'The Calendar request budget is exhausted.', false);
  }
  return null;
}

function isConversationalCalendarFailure(failure: CalendarFailure): boolean {
  return failure.category === 'clarification'
    || failure.category === 'policy'
    || failure.category === 'credential'
    || failure.category === 'delivery'
    || failure.category === 'structural'
    || failure.category === 'uncertain';
}

function sameCalendarCall(left: CalendarCall, right: CalendarCall): boolean {
  if (left.name !== right.name) return false;
  const normalize = (call: CalendarCall) => call.name === 'calendar_check_availability' && call.arguments.calendarIds
    ? { ...call.arguments, calendarIds: [...call.arguments.calendarIds].sort() } : call.arguments;
  return isDeepStrictEqual(normalize(left), normalize(right));
}

function resolveSafeTimeZone(timeZone?: string | null): string {
  if (!timeZone) return 'Etc/UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'Etc/UTC';
  }
}

export function friendlyCalendarLabel(target: CalendarResolvedTarget | null | undefined): string {
  if (!target) return 'the selected calendar';
  const rawLabel = target.calendarLabel || target.calendarId;
  if (target.selectedBy === 'primary' || target.calendarId === 'primary' || target.calendarLabel === 'primary') {
    return 'your primary calendar';
  }
  return rawLabel;
}

export function formatEventPhrase(action: CalendarCreateInput, calendarLabel: string): string {
  const startDate = new Date(action.start);
  const endDate = new Date(action.end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return `"${action.summary}" on ${calendarLabel} from ${action.start} to ${action.end}`;
  }
  const tz = resolveSafeTimeZone(action.timeZone);
  const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const isSameDay = dayKeyFormat.format(startDate) === dayKeyFormat.format(endDate);

  if (isSameDay) {
    const dateFormat = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
    const timeFormat = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
    });
    const formattedDate = dateFormat.format(startDate);
    const formattedStart = timeFormat.format(startDate);
    const formattedEnd = timeFormat.format(endDate);
    return `"${action.summary}" on ${calendarLabel} on ${formattedDate}, from ${formattedStart} to ${formattedEnd}`;
  }

  const multiFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const startStr = multiFormat.format(startDate);
  const endStr = multiFormat.format(endDate);
  return `"${action.summary}" on ${calendarLabel} from ${startStr} to ${endStr}`;
}

export function formatBusyInterval(
  startStr: string,
  endStr: string,
  timeZone: string,
  eventStart?: Date | null,
): string {
  const s = new Date(startStr);
  const e = new Date(endStr);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) {
    return `${startStr} to ${endStr}`;
  }
  const tz = resolveSafeTimeZone(timeZone);
  const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const sDay = dayKeyFormat.format(s);
  const eDay = dayKeyFormat.format(e);
  const timeFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });
  const sTime = timeFormat.format(s);
  const eTime = timeFormat.format(e);

  if (sDay === eDay) {
    const eventDay = eventStart && !isNaN(eventStart.getTime()) ? dayKeyFormat.format(eventStart) : null;
    if (eventDay && eventDay === sDay) {
      return `${sTime} to ${eTime}`;
    }
    const dFormat = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
    return `${dFormat.format(s)}, ${sTime} to ${eTime}`;
  }
  const dtFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${dtFormat.format(s)} to ${dtFormat.format(e)}`;
}

export function assembleTurnCalendarContext(params: {
  context: AssembledContext;
  acceptedInput: string;
  groups: readonly CompatibleCalendarToolGroup[];
  historicalGroups?: ReadonlyMap<string, readonly CompatibleCalendarToolGroup[]>;
  historicalWebGroups?: ReadonlyMap<string, readonly WebToolGroup[]>;
  repair: SkillDecisionRequest['repair'];
  snapshot: RuntimeConfigSnapshot;
  limits: CalendarLimits;
  binding: CalendarAccountBinding;
  calendarEnabled?: boolean;
  calendarConnection?: 'connected' | 'not-connected';
  responseMode?: 'text' | 'voice';
  canvasInventory?: CanvasInventorySnapshot;
  canvasSelection?: CanvasSelection | null;
  volatileSourceIds?: ReadonlySet<string>;
  nowMs: number;
  note?: string | null;
  webGroups?: readonly WebToolGroup[];
  /** Completed historical turns whose validated Web evidence may be projected on overflow. */
  foldableTurnIds?: ReadonlySet<string>;
  /** Include the opt-in memory tool in the exact advertised order. */
  memoryAdvertised?: boolean;
}) {
  const historicalGroups = new Map([...params.historicalGroups ?? []].map(([turnId, history]) => [turnId, history.map(group =>
    group.sources.some(source => source.redactedAt !== null || source.permission.content === 'volatile' ||
      Date.parse(source.expiresAt) <= params.nowMs || source.connectionId !== params.binding.connectionId ||
      source.connectionRevision !== params.binding.connectionRevision)
      ? { ...group, result: { ...group.result, content: JSON.stringify({ kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE }) }, sources: [] }
      : group)]));
  return calendarContext({
    context: params.context, acceptedInput: params.acceptedInput, groups: params.groups,
    historicalGroups,
    historicalWebGroups: params.historicalWebGroups,
    repair: params.repair, tools: skillToolsFor(params.memoryAdvertised === true), budgets: params.snapshot.budgets, limits: params.limits,
    binding: params.binding, compatibility: 'historical',
    enabledPluginTools: params.calendarEnabled === false ? [] : CALENDAR_TOOLS,
    calendarConnection: params.calendarConnection,
    responseMode: params.responseMode,
    ...(params.responseMode === 'voice'
      ? {
          canvasInventory: params.canvasInventory ?? { items: [], omitted: 0 },
          canvasSelection: params.canvasSelection ?? null,
        }
      : {}),
    volatileSourceIds: params.volatileSourceIds, now: params.nowMs, note: params.note,
    foldableTurnIds: params.foldableTurnIds,
    contextTokens: params.snapshot.modelLimits?.contextTokens,
    ...(params.webGroups ? { web: {
      webGroups: params.webGroups,
      tools: webNativeToolsFor(skillToolsFor(params.memoryAdvertised === true)),
      contextTokens: params.snapshot.modelLimits?.contextTokens ?? params.snapshot.budgets.maxContextTokens,
    } } : {}),
  });
}

export class CalendarLoop {
  private requireCalendar(): CalendarRuntimeV2Dependencies {
    const cal = this.ctx.calendar;
    if (!cal || !isCalendarV2(cal)) throw new AppError('NOT_READY', 'Calendar v2 is unavailable.');
    return cal;
  }
  private ownedLease(): ExecutionLease {
    if (!this.ctx.lease || this.ctx.memory) throw new AppError('NOT_READY', 'Calendar progress must be saved before access.');
    return this.ctx.lease;
  }
  private durableLedger(): CalendarTurnLedger {
    if (this.ctx.ledger instanceof MemoryCalendarLedger) throw new AppError('NOT_READY', 'Calendar progress must be saved before access.');
    return this.ctx.ledger;
  }
  private async promote(): Promise<void> {
    const memory = this.ctx.memory;
    if (!memory) return;
    const promoted = await memory.promote(this.cursor, this.refs());
    this.ctx.job.check();
    this.ctx.lease = promoted.lease; this.ctx.binding = promoted.binding; this.ctx.ledger = promoted.ledger;
    this.ctx.memory = undefined;
    this.cursor = calendarCursorSchema.parse({ ...this.cursor, connectionId: promoted.binding.connectionId,
      connectionRevision: promoted.binding.connectionRevision, accountSubjectId: promoted.binding.googleSubjectId });
    await this.requireDispatchAllowed();
  }
  private groups: (CompleteCalendarToolGroup | z.infer<typeof completeToolGroupV2Schema>)[] = [];
  private proposalSources: CalendarSourceReferenceV2[] = [];
  private volatileSourceIds = new Set<string>();
  private pendingMemoryDecision: SkillDecision | null = null;
  private invalidatedRead = false;
  private sealedDenial = false;
  private resolvedReadAccount: CalendarAccountBinding | null = null;
  private cursor: CalendarCursor;
  private lastText = '';
  private pendingContinuationBreak = false;
  private truncated = false;
  private lastDecisionId: string | null = null;
  private textDecisionId: string | null = null;
  private dispatchIds: string[] = [];
  private view: CalendarView | undefined;
  private weather: WeatherView | undefined;
  private lastOperationId: string | null = null;
  private lastIntentId: string | null = null;
  private lastProposalId: string | null = null;
  private lastProposalRevision = 1;
  private readonly canvasControlResults = new Map<string, { result: CanvasControlResult; ttsText: string }>();
  /** Hidden model-only note after a confirmed create is busy or fails. */
  private modelNote: string | null = null;
  private pendingWeb: Extract<WebDecision, { kind: 'web_tool' }> | null = null;
  private readonly webSyntheticGroups: WebToolGroup[] = [];
  private task: 'success' | 'clarification' | 'fallback' | 'denied' | 'failed' | 'cancelled' |
    'uncertain' | 'not-applicable' | 'unknown' = 'not-applicable';
  private writeCertainty: 'not-applicable' | 'not-sent' | 'confirmed' | 'unknown' = 'not-applicable';
  diagnosticOutcome() { return { task: this.task, writeCertainty: this.writeCertainty }; }
  private setTask(task: CalendarLoop['task'], writeCertainty?: CalendarLoop['writeCertainty']) {
    if (this.writeCertainty === 'confirmed' && writeCertainty && writeCertainty !== 'confirmed') {
      if (task !== 'not-applicable') this.task = task;
      return;
    }
    if ((this.task === 'fallback' || this.task === 'success') && task === 'not-applicable') return;
    this.task = task;
    if (writeCertainty) this.writeCertainty = writeCertainty;
  }

  private effectiveTimeZone(): string {
    return resolveCalendarTimeZone(this.ctx.calendar, this.ctx.clientTimeZone);
  }

  constructor(private readonly ctx: CalendarLoopContext) {
    this.groups = [...ctx.initialGroups ?? []];
    this.cursor = calendarCursorSchema.parse({
      version: 2, schemaRevision: 'google-calendar.v2', configRevision: ctx.snapshot.revision,
      connectionId: ctx.binding.connectionId, connectionRevision: ctx.binding.connectionRevision,
      accountSubjectId: ctx.binding.googleSubjectId, deadlineAt: ctx.ledger.deadlineAt(),
      trustedNow: ctx.now(), trustedTimeZone: this.effectiveTimeZone(), limits: ctx.limits,
      next: 'decide', pendingDecisionId: null, pendingToolCallId: null, pendingOperationId: null,
      pendingIntentId: null, pendingProposalId: null, repair: null,
    });
  }

  initialCursor() { return this.cursor; }
  resume(job: Work, emit?: CalendarLoopContext['emitCalendar']): void { this.ctx.job = job; if (emit) this.ctx.emitCalendar = emit; }
  private static durableGroup(group: CompatibleCalendarToolGroup): boolean {
    return group.result.name !== UPDATE_USER_MEMORY_TOOL_NAME;
  }
  toolGroups(): readonly CompatibleCalendarToolGroup[] {
    return structuredClone(this.groups.filter(CalendarLoop.durableGroup));
  }
  /** Confirmed explicit update for this attempt, never inferred from narration. */
  memoryWasUpdated(): boolean {
    const receipt = this.ctx.memoryTool?.receipt();
    return receipt?.ok === true && receipt.status === 'updated';
  }
  narration() { return this.lastText; }
  viewSnapshot(): CalendarView | undefined { return this.view; }
  private captureView(view: CalendarView | null): void {
    if (!view) return;
    this.view = view;
    this.ctx.onView?.(view); // internal assignment hook; no IO or awaiting
    if (this.ctx.responseMode !== 'voice') return;
    const frame = calendarMultiStreamEnvelopeSchema.parse({ protocolVersion: 3,
      sessionId: this.ctx.attempt.sessionId, turnId: this.ctx.attempt.turnId,
      attemptId: this.ctx.attempt.attemptId, sequence: this.ctx.sequence.value++,
      event: { type: 'calendar-view', view } });
    try { void this.ctx.emitCalendar(frame).catch(() => undefined); }
    catch { /* Calendar authority is independent of visual transport. */ }
  }
  provenance() {
    if (this.task === 'fallback' || this.task === 'denied' || this.task === 'failed'
      || this.task === 'cancelled') {
      return [];
    }
    return [...this.groups.filter(CalendarLoop.durableGroup)
      .flatMap<NonNullable<MessageRecord['sourceProvenance']>[number]>(group => group.sources),
      ...this.proposalSources];
  }

  invalidateCalendarAccount(account: CalendarAccountBinding): void {
    if (account.userId !== this.ctx.attempt.userId) return;
    const matches = (source: { connectionId: string; connectionRevision: number }) =>
      source.connectionId === account.connectionId && source.connectionRevision === account.connectionRevision;
    const resolvedMatches = this.resolvedReadAccount !== null && isDeepStrictEqual(this.resolvedReadAccount, account);
    const bindingMatches = this.ctx.binding.connectionId === account.connectionId
      && this.ctx.binding.connectionRevision === account.connectionRevision;
    const nowMs = Date.parse(this.ctx.now());
    let scrubbed = false;
    this.groups = this.groups.map(group => {
      if (!group.sources.some(matches)) return group;
      scrubbed = true;
      for (const source of group.sources) {
        if (matches(source)) this.volatileSourceIds.delete(source.sourceId);
      }
      const nextSources = group.sources.map(source =>
        matches(source) ? redactCalendarSourceForAccount(source, account, nowMs) : source);
      return {
        ...group,
        result: { ...group.result, content: JSON.stringify({ kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE }) },
        sources: nextSources,
      } as typeof group;
    });
    this.proposalSources = this.proposalSources.map(source => {
      if (!matches(source)) return source;
      scrubbed = true;
      return redactCalendarSourceForAccount(source, account, nowMs);
    });
    if (resolvedMatches || bindingMatches || scrubbed) {
      this.invalidatedRead = true;
      this.pendingMemoryDecision = null;
      if (this.view && this.view.kind !== 'outcome') {
        this.view = undefined;
        this.ctx.onClearView?.();
      }
    }
  }

  private hasActiveV2Sources(): boolean {
    return this.groups.some(group => group.sources.some(source => source.schemaVersion === 2 && source.redactedAt === null));
  }

  private async revalidateActiveSources(input: GraphInput): Promise<CalendarGraphPatch | null> {
    if (this.sealedDenial || this.lastOperationId) return null;
    const activeSources = this.groups
      .flatMap<NonNullable<MessageRecord['sourceProvenance']>[number]>(group => group.sources)
      .filter((source): source is CalendarSourceReferenceV2 => source.schemaVersion === 2 && source.redactedAt === null);
    if (!this.invalidatedRead && (!this.ctx.memory || activeSources.length === 0)) return null;
    const deny = () => {
      this.sealedDenial = true;
      const nowMs = Date.parse(this.ctx.now());
      this.groups = this.groups.map(group => {
        if (!group.sources.some(source => source.schemaVersion === 2)) return group;
        for (const source of group.sources) this.volatileSourceIds.delete(source.sourceId);
        return {
          ...group,
          result: { ...group.result, content: JSON.stringify({ kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE }) },
          sources: group.sources.map(source => source.schemaVersion === 2
            ? { ...source, redactedAt: source.redactedAt ?? new Date(nowMs).toISOString(),
                targets: source.targets.map(t => ({ ...t, calendarLabel: null })) }
            : source),
        } as typeof group;
      });
      this.pendingMemoryDecision = null;
      if (this.view && this.view.kind !== 'outcome') {
        this.view = undefined;
        this.ctx.onClearView?.();
      }
      this.setTask('denied', 'not-sent');
      return this.failConversationally(input, { category: 'policy', code: 'CALENDAR_EXECUTION_DENIED', retry: 'none' }, null);
    };
    if (this.invalidatedRead || this.ctx.calendarEnabled === false) return deny();
    const cal = this.ctx.calendar;
    if (!cal || !isCalendarV2(cal)) return deny();
    const account = this.resolvedReadAccount ?? this.account();
    if (account.connectionId === 'memory-unbound'
      || activeSources.some(s => s.connectionId !== account.connectionId || s.connectionRevision !== account.connectionRevision)) {
      return deny();
    }
    try {
      const record = await cal.connection.requireAccountCurrent(account, this.ctx.job.signal, { fresh: false });
      const nowMs = Date.parse(this.ctx.now());
      if (this.invalidatedRead || !record.enabled || record.status !== 'connected'
        || record.connectionId !== account.connectionId || record.connectionRevision !== account.connectionRevision) {
        return deny();
      }
      const discovery = record.discovery;
      if (discovery) {
        if (discovery.connectionId !== account.connectionId || discovery.connectionRevision !== account.connectionRevision
          || discovery.retentionPolicyId === null || Date.parse(discovery.retentionExpiresAt) <= nowMs) {
          return deny();
        }
        for (const group of this.groups) {
          const toolName = group.assistant.tool_calls[0]?.function.name === 'call_tool'
            ? callToolEnvelopeSchema.safeParse(JSON.parse(group.assistant.tool_calls[0].function.arguments)).data?.tool
            : group.result.name;
          const needsReadCapability = toolName === 'calendar_list_events' || toolName === 'calendar_get_event';
          for (const source of group.sources) {
            if (source.schemaVersion !== 2 || source.redactedAt !== null) continue;
            for (const target of source.targets) {
              const entry = discovery.entries.find(item => item.calendarId === target.calendarId);
              if (entry && (entry.hidden || entry.deleted || (needsReadCapability && !entry.capabilities.readEvents))) {
                return deny();
              }
              if (needsReadCapability && !entry) return deny();
            }
          }
        }
      }
      return null;
    } catch (error) {
      if (error instanceof CalendarToolFault
        && (error.failure.category === 'policy' || error.failure.category === 'credential')) {
        return deny();
      }
      throw error;
    }
  }

  /**
   * Completes the turn with a bounded assistant answer. Recoverable Calendar
   * failures use this instead of aborting the accepted user request.
   */
  private async answerAndSeal(
    input: GraphInput,
    text: string,
    decisionId: string | null = null,
  ): Promise<CalendarGraphPatch> {
    this.lastText = text;
    if (decisionId) this.lastDecisionId = decisionId;
    this.cursor = calendarCursorSchema.parse({
      ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null,
    });
    return this.seal(input);
  }

  private async failConversationally(
    input: GraphInput,
    failure: CalendarFailure,
    decisionId: string | null = null,
    tool?: CalendarCall['name'],
  ): Promise<CalendarGraphPatch> {
    const abort = abortForCalendarFailure(failure);
    if (abort) throw abort;
    if (failure.category === 'credential' || failure.code === 'CALENDAR_EXECUTION_DENIED') {
      diagnose(this.ctx.diagnostics?.emit, { stage: 'authority', state: 'rejected', reason: 'access-denied',
        code: failure.code, decisionId: decisionId ?? undefined, tool, origin: 'local', delivery: 'not-sent' });
    }
    if (failure.code === 'CALENDAR_INPUT_REJECTED' || failure.category === 'delivery') this.setTask('fallback');
    else if (failure.category === 'uncertain') this.setTask('uncertain', 'unknown');
    else if (failure.category === 'policy' || failure.category === 'credential') this.setTask('denied', 'not-sent');
    else if (failure.category === 'clarification') this.setTask('clarification', 'not-sent');
    else this.setTask('fallback');
    const message = messageForCalendarFailure(failure);
    const readTool = tool === 'calendar_list_events' || tool === 'calendar_get_event'
      || tool === 'calendar_list_calendars' || tool === 'calendar_check_availability';
    if (readTool && this.view?.kind !== 'outcome') {
      this.captureView(calendarNotice('failed', message, { tool }));
    }
    return this.answerAndSeal(input, message, decisionId);
  }

  /** Reuse the charged schema-repair loop for invalid reads and redundant calls. */
  private async correctToolCall(
    input: GraphInput,
    decision: CalendarDecision & { kind: 'tool' },
    diagnostics: CalendarRepairDiagnostics,
  ): Promise<CalendarGraphPatch> {
    const budget = await this.ctx.ledger.ensureBudget();
    const evidence = {
      schemaVersion: 1 as const, kind: 'calendar-rejected-decision' as const,
      userId: this.ctx.attempt.userId, sessionId: this.ctx.attempt.sessionId,
      turnId: this.ctx.attempt.turnId, attemptId: this.ctx.attempt.attemptId,
      decisionId: decision.decisionId, dispatchId: this.dispatchIds.at(-1)!,
      dispatchIndex: budget.modelDispatches, repairsUsed: budget.repairs,
      rawArgumentsSha256: hashPayload(JSON.stringify(decision.call.arguments)), diagnostics, createdAt: this.ctx.now(),
    };
    if (isCalendarV2(this.ctx.calendar)) {
      await this.ctx.persistence.calendarDecisionsV2.putRejected(rejectedDecisionV2Schema.parse({
        ...evidence, schemaVersion: 2, schemaRevision: 'google-calendar.v2',
      }));
    } else await this.ctx.persistence.calendarDecisions.putRejected(rejectedDecisionSchema.parse(evidence));
    return this.repairOrSeal(input, decision.decisionId, diagnostics);
  }

  private async repairOrSeal(
    input: GraphInput,
    decisionId: string,
    diagnostics: CalendarRepairDiagnostics,
    exhaustedMessage = 'I could not complete the calendar request after correcting my tool calls. You do not need to change your question. Please try again.',
  ): Promise<CalendarGraphPatch> {
    const budget = await this.ctx.ledger.ensureBudget();
    this.setTask('fallback');
    if (budget.repairs >= this.ctx.limits.repairs) {
      diagnose(this.ctx.diagnostics?.emit, { stage: 'correction', state: 'rejected',
        reason: 'budget-exhausted', code: 'REPAIR_EXHAUSTED', origin: 'local', delivery: 'not-sent',
        correctionAttempt: budget.repairs, correctionLimit: this.ctx.limits.repairs });
      return this.answerAndSeal(input, exhaustedMessage, decisionId);
    }
    diagnose(this.ctx.diagnostics?.emit, { stage: 'correction', state: 'rejected',
      origin: 'local', delivery: 'not-sent', correctionAttempt: budget.repairs,
      correctionLimit: this.ctx.limits.repairs });
    await this.emit({ type: 'calendar-progress', phase: 'repairing' });
    this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'decide', pendingDecisionId: null,
      repair: { rejectedDecisionId: decisionId, diagnostics } });
    return { calendarCursor: this.cursor, calendarRefs: this.refs() };
  }

  private assemble(
    groups: readonly CompatibleCalendarToolGroup[],
    repair: SkillDecisionRequest['repair'],
    canvasInventory?: CanvasInventorySnapshot,
    canvasSelection?: CanvasSelection | null,
    memoryAdvertised = false,
  ) {
    return assembleTurnCalendarContext({
      context: this.ctx.context,
      acceptedInput: this.ctx.input.content,
      groups,
      historicalGroups: this.ctx.historicalGroups,
      historicalWebGroups: this.ctx.historicalWebGroups,
      repair,
      snapshot: this.ctx.snapshot,
      limits: this.ctx.limits,
      binding: this.ctx.binding,
      calendarEnabled: this.ctx.calendarEnabled,
      calendarConnection: this.ctx.calendarConnection,
      responseMode: this.ctx.responseMode,
      ...(this.ctx.responseMode === 'voice'
        ? {
            canvasInventory: canvasInventory ?? this.ctx.canvasInventory?.() ?? { items: [], omitted: 0 },
            canvasSelection: canvasSelection !== undefined ? canvasSelection : (this.ctx.canvasSelection?.() ?? null),
          }
        : {}),
      volatileSourceIds: this.volatileSourceIds,
      nowMs: Date.parse(this.ctx.now()),
      note: this.modelNote,
      foldableTurnIds: this.ctx.foldableTurnIds,
      memoryAdvertised,
      ...(this.ctx.web ? { webGroups: [...this.ctx.web.groups(), ...this.webSyntheticGroups] } : {}),
    });
  }

  private canvasControlSpeech(
    command: CanvasControlArguments | null,
    outcome: CanvasControlResult['outcome'],
    details: { title?: string; alreadyOpen?: boolean; hasOpenSelection?: boolean },
  ): string {
    if (outcome === 'mode-not-allowed') return 'Canvas controls are only available in live voice.';
    if (outcome === 'invalid-arguments' || !command) return "I couldn't apply that Canvas control.";
    if (command.action === 'open') {
      if (outcome === 'requested') {
        return details.alreadyOpen
          ? 'You are already looking at it right now'
          : `You are looking at ${details.title ?? 'the Canvas'} right now`;
      }
      if (outcome === 'unavailable') return "I couldn't find that Canvas.";
      return "I couldn't update the Canvas view right now.";
    }
    if (outcome === 'requested') {
      switch (command.action) {
        case 'close': return 'Closed the Canvas.';
        case 'fullscreen': return command.state === 'enter' ? 'Entered fullscreen.' : 'Exited fullscreen.';
        case 'zoom_in': return 'Zoomed in.';
        case 'zoom_out': return 'Zoomed out.';
        case 'fit_to_view': return 'Fitted to view.';
        case 'reset_view': return 'Reset the view.';
        case 'scroll': return `Scrolled ${command.direction}.`;
      }
    }
    if (outcome === 'unavailable') {
      return details.hasOpenSelection ? 'The Canvas changed before I could apply that.' : 'No Canvas is currently open.';
    }
    if (outcome === 'unsupported') return "Zoom isn't supported for this Canvas.";
    return "I couldn't reach the Canvas right now.";
  }

  private dispatchCanvasControl(
    decision: Extract<SkillDecision, { kind: 'control_canvas' }>,
    expected: CanvasSelection | null,
    inventory: CanvasInventorySnapshot,
  ): { result: CanvasControlResult; ttsText: string } {
    const previous = this.canvasControlResults.get(decision.nativeCall.id);
    if (previous) return previous;
    this.ctx.job.check();
    if (Date.parse(this.ctx.ledger.deadlineAt()) <= Date.parse(this.ctx.now())) {
      throw new AppError('TIMEOUT', 'The turn deadline has passed.', false);
    }
    const parsed = controlCanvasArgumentsSchema.safeParse(decision.envelope);
    const makeResult = (
      outcome: CanvasControlResult['outcome'],
      canvasId: string | null = parsed.success && parsed.data.action === 'open'
        ? parsed.data.canvas_id : expected?.canvasId ?? null,
    ): CanvasControlResult => canvasControlResultSchema.parse({
      kind: 'canvas-control',
      outcome,
      action: parsed.success ? parsed.data.action : null,
      canvas_id: canvasId,
    });
    let result: CanvasControlResult;
    let title: string | undefined;
    let alreadyOpen = false;
    let hasOpenSelection = Boolean(expected?.open);
    if (this.ctx.responseMode !== 'voice') {
      result = makeResult('mode-not-allowed');
    } else if (!parsed.success) {
      result = makeResult('invalid-arguments');
    } else if (parsed.data.action === 'open') {
      const targetId = parsed.data.canvas_id;
      const item = inventory.items.find(entry => entry.canvasId === targetId);
      if (!item) {
        result = makeResult('unavailable', targetId);
      } else {
        title = item.title;
        const currentSelection = this.ctx.canvasSelection ? this.ctx.canvasSelection() : expected;
        if (currentSelection?.open === true && currentSelection.canvasId === item.canvasId) {
          alreadyOpen = true;
          result = makeResult('requested', item.canvasId);
        } else {
          try {
            const nav = this.ctx.navigateCanvas?.({ canvas_id: item.canvasId }, decision.nativeCall.id);
            result = makeResult(nav?.outcome ?? 'delivery-unavailable', nav?.canvas_id ?? item.canvasId);
          } catch {
            result = makeResult('delivery-unavailable', item.canvasId);
          }
        }
      }
    } else {
      try {
        result = this.ctx.controlCanvas?.(decision.envelope, decision.nativeCall.id, expected)
          ?? makeResult('delivery-unavailable');
      } catch {
        result = makeResult('delivery-unavailable');
      }
      if (result.outcome === 'unavailable') {
        const latest = this.ctx.canvasSelection ? this.ctx.canvasSelection() : expected;
        hasOpenSelection = Boolean(latest?.open);
      }
    }
    const bounded = canvasControlResultSchema.parse(result);
    const entry = {
      result: bounded,
      ttsText: this.canvasControlSpeech(parsed.success ? parsed.data : null, bounded.outcome, {
        title, alreadyOpen, hasOpenSelection,
      }),
    };
    this.canvasControlResults.set(decision.nativeCall.id, entry);
    return entry;
  }

  private hasVolatileSources(): boolean {
    return this.volatileSourceIds.size > 0
      || this.groups.some(group => group.sources.some(source => source.permission.content === 'volatile'))
      || this.proposalSources.some(source => source.permission.content === 'volatile');
  }

  private decisionRecord(
    dispatchId: string,
    decision: SkillDecision,
    sources: readonly CalendarSourceReferenceV2[],
    repair: SkillDecisionRequest['repair'],
  ): z.infer<typeof resumableSkillDecisionSchema> {
    const volatileText = decision.kind === 'text'
      && (sources.some(source => source.permission.content === 'volatile')
        || Boolean(this.ctx.memory && this.hasVolatileSources()));
    const sanitized = decision.kind !== 'text' && this.ctx.memory && this.hasVolatileSources()
      ? sanitizeToolDecisionForVolatileHistory(decision)
      : decision;
    return resumableSkillDecisionSchema.parse({
      schemaVersion: 3, protocolVersion: 'plugin-skills.v1', kind: 'calendar-model-decision',
      userId: this.ctx.attempt.userId, sessionId: this.ctx.attempt.sessionId, turnId: this.ctx.attempt.turnId,
      attemptId: this.ctx.attempt.attemptId, decisionId: decision.decisionId, dispatchId,
      configRevision: this.ctx.snapshot.revision, connectionId: this.ctx.binding.connectionId,
      connectionRevision: this.ctx.binding.connectionRevision, schemaRevision: 'google-calendar.v2',
      rejectedDecisionId: repair?.rejectedDecisionId ?? null,
      decision: volatileText ? null : sanitized,
      sources: [...sources], operationId: null, intentId: null, proposalId: null, createdAt: this.ctx.now(),
    });
  }

  private localRecord(decision: Exclude<HistoricalSkillDecision | SkillDecision, { kind: 'text' }>,
    content: string): z.infer<typeof localSkillResultRecordSchema> {
    return localSkillResultRecordSchema.parse({
      schemaVersion: 3, protocolVersion: 'plugin-skills.v1', kind: 'calendar-tool-result',
      userId: this.ctx.attempt.userId, sessionId: this.ctx.attempt.sessionId, turnId: this.ctx.attempt.turnId,
      attemptId: this.ctx.attempt.attemptId, decisionId: decision.decisionId,
      eventId: key('calendar-tool-result-event', this.ctx.attempt.userId, decision.nativeCall.id),
      sequence: this.groups.length, toolCallId: decision.nativeCall.id, createdAt: this.ctx.now(),
      resultRef: { storage: 'local', toolCallId: decision.nativeCall.id, content },
    });
  }

  /**
   * Persists exactly one source-free local group after the complete candidate
   * context passes assembly, so an unconfirmed disclosure never becomes loaded.
   */
  private async recordLocal(decision: Exclude<HistoricalSkillDecision | SkillDecision, { kind: 'text' }>,
    result: NativeLocalResult): Promise<void> {
    const content = serializeNativeLocalResult(result, this.ctx.limits.resultBytes);
    const group = skillGroup(decision, content);
    // Presentation is already queued. Keep its exact pair without rebuilding the
    // prompt; the next model dispatch validates the complete context as usual.
    // Disclosure still requires assembly before it can become loaded authority.
    if (decision.kind !== 'show_canvas' && decision.kind !== 'control_canvas') this.assemble([...this.groups, group], null);
    this.ctx.job.check();
    if (!this.ctx.memory && !await this.ctx.persistence.owner.fence(this.ownedLease())) {
      throw new AppError('INTERRUPTED', 'Execution ownership was lost.');
    }
    const record = this.localRecord(decision, content);
    if (this.ctx.memory) this.ctx.memory.stage.putResult(record);
    else await this.ctx.persistence.skillResults.put(record);
    this.groups.push(group);
  }

  /** A repeat of an earlier successful read is rejected before any Calendar request. */
  private repeatsEarlierRead(call: CalendarCall): boolean {
    const prior = this.groups.slice(this.groups.findLastIndex(group => group.result.name === 'calendar_create_event') + 1);
    return prior.some(group => {
      const previous = group.assistant.tool_calls[0].function;
      if (previous.name === 'activate_skill' || previous.name === 'show_canvas'
        || previous.name === 'control_canvas' || previous.name === 'get_environment') return false;
      let stored: unknown;
      try { stored = JSON.parse(group.result.content); } catch { stored = null; }
      const localKind = stored && typeof stored === 'object' ? (stored as { kind?: unknown }).kind : undefined;
      // Discovery acknowledgements, local errors, and tombstones never prove a prior read.
      if (localKind === 'skill-disclosure' || localKind === 'skill-error'
        || localKind === 'calendar-history-unavailable') return false;
      let args: unknown;
      try { args = JSON.parse(previous.arguments); }
      catch { throw new AppError('INVALID_REQUEST', 'Calendar tool results are incomplete.', false); }
      if (previous.name === 'call_tool') {
        const envelope = callToolEnvelopeSchema.safeParse(args);
        if (!envelope.success) throw new AppError('INVALID_REQUEST', 'Calendar tool results are incomplete.', false);
        const parsed = calendarCallSchema.safeParse({ name: envelope.data.tool, arguments: envelope.data.arguments });
        if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Calendar tool results are incomplete.', false);
        return sameCalendarCall(parsed.data, call);
      }
      const parsed = calendarCallSchema.safeParse({ name: previous.name, arguments: args });
      if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Calendar tool results are incomplete.', false);
      return sameCalendarCall(parsed.data, call);
    });
  }

  private refs() {
    return {
      version: 3 as const,
      protocolVersion: 'plugin-skills.v1' as const,
      userId: this.ctx.attempt.userId, sessionId: this.ctx.attempt.sessionId, turnId: this.ctx.attempt.turnId,
      decisionIds: [...this.dispatchIds],
      toolCallIds: this.groups.filter(CalendarLoop.durableGroup).map(group => group.result.tool_call_id),
      operationId: this.lastOperationId,
      intentId: this.lastIntentId,
      proposalId: this.lastProposalId,
      connectionId: this.ctx.binding.connectionId,
      connectionRevision: this.ctx.binding.connectionRevision,
      schemaRevision: 'google-calendar.v2' as const,
    };
  }

  /**
   * The user-facing clarification for a paused create, sealed from the exact
   * saved proposal: it names the calendar, the event, and any busy intervals or
   * incomplete-coverage reason, and offers the answers the
   * runtime accepts. It never carries operation identifiers, credentials,
   * internal revisions or copy instructions.
   *
   * ponytail: at most four busy intervals are listed; a longer list becomes
   * an explicit count and the coverage statement is never dropped.
   */
  private clarificationText(
    proposal: CalendarProposalRecord,
    condition: CalendarAvailabilityResult | null,
  ): string {
    const action = proposal.action;
    const friendlyCalendar = friendlyCalendarLabel(proposal.target);
    const event = action
      ? formatEventPhrase(action, friendlyCalendar)
      : `the requested event on ${friendlyCalendar}`;
    if (condition === null) {
      const choices = proposal.candidates
        .map(candidate => `"${candidate.target.calendarLabel ?? candidate.target.calendarId}" (${candidate.target.calendarId})`);
      return `Please confirm: create ${event}.`
        + (action?.description !== undefined ? ` Description: ${JSON.stringify(action.description)}.` : '')
        + (action?.location !== undefined ? ` Location: ${JSON.stringify(action.location)}.` : '')
        + (choices.length > 0 ? ` Choose a calendar to confirm: ${choices.join(', ')}. Or reply "cancel".`
          : ' Reply yes to confirm, or cancel.');
    }
    const eventStartDate = action ? new Date(action.start) : null;
    const busyTz = action?.timeZone ?? condition.timeZone;
    const busy = condition.busy.slice(0, 4)
      .map(interval => formatBusyInterval(interval.start, interval.end, busyTz, eventStartDate));
    const found = condition.conflict === 'conflict'
      ? (busy.length > 0
          ? `I found a busy period that overlaps it${condition.busy.length > busy.length
            ? ` (${condition.busy.length} busy periods in total, including ${busy.join('; ')})` : ` (${busy.join('; ')})`}.`
          : 'I found a busy period that overlaps it.')
      : 'I could not confirm that the time is free.';
    const incomplete = condition.calendars
      .filter(entry => entry.status !== 'ok')
      .map(entry => `${entry.calendarLabel}: ${entry.reason ?? entry.status}`);
    const coverage = condition.coverage === 'incomplete'
      ? `The coverage of that time is incomplete (${incomplete.length > 0 ? incomplete.join(', ') : condition.limitations.join(', ')}).`
      : 'Google Calendar only reports opaque busy time, so transparent events (including all-day entries), declined or cancelled events, and working hours are not covered.';
    return `I can schedule ${event}. ${found} ${coverage} `
      + 'Should I create the event anyway, or would you like a different time?';
  }

  /**
   * Charges one calendar request for an imminent Calendar REST delivery.
   */
  private async chargeProviderRequest(kind: CalendarRequestKindV2): Promise<void> {
    if (!PROVIDER_REQUEST_KINDS.has(kind)) return;
    if (this.ctx.memory?.mutation) {
      try {
        await this.ctx.memory.mutation.writerOptions().ledger.chargeCalendarRequest(kind);
        return;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'NOT_READY') throw error;
      }
    }
    await (this.ctx.memory ? this.ctx.ledger : this.durableLedger()).chargeCalendarRequest(kind);
  }

  private async chargeRefreshRequest(): Promise<void> {
    if (this.ctx.memory?.mutation) {
      try {
        await this.ctx.memory.mutation.writerOptions().ledger.chargeRefreshRequest();
        return;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'NOT_READY') throw error;
      }
    }
    await (this.ctx.memory ? this.ctx.ledger : this.durableLedger()).chargeRefreshRequest();
  }

  /**
   * Records the outcome of one model-requested Calendar tool call: the v2
   * result record, native identities, configured byte limit, and candidate
   * context are verified before any presentation view or group is accepted.
   */
  private async recordResult(
    decision: CalendarDecision & { kind: 'tool' },
    invoked: { result: unknown; source: CalendarSourceReferenceV2 },
    native: Extract<SkillDecision, { kind: 'call_tool' }>,
  ): Promise<void> {
    if (native.decisionId !== decision.decisionId || native.nativeCall.id !== decision.toolCallId
      || native.envelope.tool !== decision.call.name
      || invoked.source.schemaVersion !== 2
      || !invoked.source.toolCallIds.includes(decision.toolCallId)
      || invoked.source.connectionId !== this.ctx.binding.connectionId
      || invoked.source.connectionRevision !== this.ctx.binding.connectionRevision
      || (invoked.result as { tool?: unknown } | null | undefined)?.tool !== decision.call.name) {
      throw new AppError('NOT_READY', 'Calendar decision is unavailable.');
    }
    const serialized = JSON.stringify(invoked.result);
    if (Buffer.byteLength(serialized, 'utf8') > this.ctx.limits.resultBytes) {
      throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The Calendar result exceeds the configured budget.', false);
    }
    const record = calendarToolResultRecordV2Schema.parse({
      schemaVersion: 2, kind: 'calendar-tool-result',
      userId: this.ctx.attempt.userId, sessionId: this.ctx.attempt.sessionId, turnId: this.ctx.attempt.turnId,
      attemptId: this.ctx.attempt.attemptId, decisionId: decision.decisionId,
      eventId: key('calendar-tool-result-event', this.ctx.attempt.userId, decision.toolCallId),
      sequence: this.groups.length, toolCallId: decision.toolCallId, createdAt: this.ctx.now(),
      resultRef: invoked.source.permission.content === 'retained'
        ? { storage: 'retained', source: invoked.source, toolCallId: decision.toolCallId,
          operationId: null, result: invoked.result }
        : { storage: 'reference', source: invoked.source, toolCallId: decision.toolCallId,
          operationId: null, outcome: 'ok' },
    });
    const group = completeToolGroupV2Schema.parse(skillGroup(native, serialized, [invoked.source]));
    const wasVolatile = this.volatileSourceIds.has(invoked.source.sourceId);
    if (invoked.source.permission.content === 'volatile') this.volatileSourceIds.add(invoked.source.sourceId);
    try {
      this.assemble([...this.groups, group], null);
      if (this.ctx.memory) {
        this.ctx.memory.stage.putResult(record);
      } else {
        await this.ctx.persistence.calendarRetention.registerSource({
          userId: this.ctx.attempt.userId, sessionId: this.ctx.attempt.sessionId, source: invoked.source,
        });
        await this.ctx.persistence.calendarResultsV2.put(record);
      }
    } catch (error) {
      if (!wasVolatile) this.volatileSourceIds.delete(invoked.source.sourceId);
      throw error;
    }
    this.setTask('success', decision.call.name === 'calendar_create_event' ? 'confirmed' : 'not-applicable');
    this.groups.push(group);
  }

  private async emit(event: CalendarStreamEnvelope['event'] | z.infer<typeof calendarMultiStreamEnvelopeSchema>['event']) {
    if (isCalendarV2(this.ctx.calendar)) {
      const frame = calendarMultiStreamEnvelopeSchema.parse({
        protocolVersion: 3,
        sessionId: this.ctx.attempt.sessionId,
        turnId: this.ctx.attempt.turnId,
        attemptId: this.ctx.attempt.attemptId,
        sequence: this.ctx.sequence.value++,
        event,
      });
      if (this.ctx.responseMode === 'voice' && ['calendar-progress', 'calendar-operation',
        'calendar-clarification', 'calendar-view'].includes(frame.event.type)) {
        try { void this.ctx.emitCalendar(frame).catch(() => undefined); }
        catch { /* Lost presentation is not a tool failure. */ }
        return;
      }
      await this.ctx.emitCalendar(frame);
    } else {
      await this.ctx.emitCalendar(calendarStreamEnvelopeSchema.parse({
        protocolVersion: 2,
        sessionId: this.ctx.attempt.sessionId,
        turnId: this.ctx.attempt.turnId,
        attemptId: this.ctx.attempt.attemptId,
        sequence: this.ctx.sequence.value++,
        event: event as CalendarStreamEnvelope['event'],
      }));
    }
  }

  private account(): CalendarAccountBinding {
    return {
      userId: this.ctx.binding.userId,
      connectionId: this.ctx.binding.connectionId,
      connectionRevision: this.ctx.binding.connectionRevision,
      googleSubjectId: this.ctx.binding.googleSubjectId,
    };
  }

  private async requireDispatchAllowed() {
    this.ctx.job.check();
    if (Date.parse(this.ctx.ledger.deadlineAt()) <= Date.parse(this.ctx.now()))
      throw new AppError('TIMEOUT', 'The Calendar turn deadline has passed.', false);
    // Native-only turns have no Calendar account gate; plugin execution is gated separately.
    if (this.ctx.memory || this.ctx.calendarEnabled === false) return;
    if (!(await this.ctx.persistence.owner.fence(this.ownedLease()))) {
      throw new AppError('INTERRUPTED', 'Execution ownership was lost.');
    }
    const cal = this.ctx.calendar;
    if (!cal) throw new AppError('NOT_READY', 'Calendar v2 is unavailable.');
    if (isCalendarV2(cal)) {
      await cal.connection.requireAccountCurrent(this.ctx.binding, this.ctx.job.signal);
    } else {
      await cal.connection.requireCurrent(this.ctx.binding, this.ctx.job.signal);
    }
    if (Date.parse(this.ctx.ledger.deadlineAt()) <= Date.parse(this.ctx.now())) {
      throw new AppError('TIMEOUT', 'The Calendar turn deadline has passed.', false);
    }
  }

  private policyId() {
    return this.ctx.snapshot.calendar?.processingPolicyId ?? 'native-local.v1';
  }

  /**
   * A content-bearing proposal may not outlive the retention policy behind that
   * snapshot, or the audit deadline. Retention and audit deadlines are hard
   * ceilings and are never extended to invent a longer draft window.
   * ponytail: one clamp point; a later source-specific expiry reuses this ceiling.
   */
  private async proposalContentExpiry(
    cal: CalendarRuntimeV2Dependencies,
    account: CalendarAccountBinding,
  ): Promise<string> {
    const record = await cal.connection.requireAccountCurrent(account, this.ctx.job.signal);
    const discovery = record.discovery;
    const nowMs = Date.parse(this.ctx.now());
    const ceilings = [
      nowMs + 86400000,
      discovery ? Date.parse(discovery.retentionExpiresAt) : Number.POSITIVE_INFINITY,
      cal.auditDeadlineAt ? Date.parse(cal.auditDeadlineAt) : Number.POSITIVE_INFINITY,
    ];
    return new Date(Math.min(...ceilings)).toISOString();
  }

  /**
   * Publishes one proposal and records the disclosure it makes.
   *
   * The disclosure is bound to the attempt that made it. That binding is the
   * durable proof that the server disclosed this proposal revision, so a later
   * reply without a client reference can only be accepted when this proposal is
   * the unique unchanged disclosure of the session.
   */
  private async publishAndRecord(input: PublishProposalInput): Promise<CalendarProposalRecord> {
    const cal = this.requireCalendar();
    const proposal = await publishProposal(input);
    const targets = [proposal.target, ...proposal.candidates.map(candidate => candidate.target)]
      .filter(target => target !== null)
      .filter((target, index, all) => all.findIndex(other => other.calendarId === target.calendarId) === index);
    const source = sourceReferenceV2Schema.parse({
      schemaVersion: 2, sourceId: key('calendar-proposal-source', proposal.proposalId, proposal.revision),
      plugin: 'google-calendar', connectionId: proposal.connectionId,
      connectionRevision: proposal.connectionRevision, operationIds: [],
      toolCallIds: [proposal.proposalId], fetchedAt: proposal.createdAt,
      expiresAt: cal.permission.content === 'retained' ? proposal.contentExpiresAt : proposal.createdAt,
      redactedAt: null, permission: cal.permission,
      discoveryRevision: proposal.discoveryRevision, availabilityRevision: proposal.availabilityRevision,
      calendarSetHash: null, targets: targets.map(target => ({ calendarId: target.calendarId,
        calendarLabel: cal.permission.content === 'retained' ? target.calendarLabel : null })),
    });
    await this.ctx.persistence.calendarRetention.registerSource({
      userId: proposal.userId, sessionId: proposal.sessionId, source,
    });
    this.proposalSources.push(source);
    await this.ctx.persistence.calendarProposals.bindReplyReference({
      userId: this.ctx.attempt.userId,
      sessionId: this.ctx.attempt.sessionId,
      turnId: this.ctx.attempt.turnId,
      attemptId: this.ctx.attempt.attemptId,
      replyTo: { proposalId: proposal.proposalId, revision: proposal.revision },
    });
    this.captureView(projectProposalView(proposal));
    this.ctx.memory?.onProposal?.(proposal);
    return proposal;
  }

  async decide(input: GraphInput): Promise<CalendarGraphPatch> {
    // A Dev voice control is denied before any promotion or proposal work.
    if (this.ctx.localToolControl && this.ctx.turnMode?.current()?.mode === 'dev') {
      return this.answerAndSeal(input,
        'Dev mode is enabled. Calendar confirmation is unavailable.', null);
    }
    const pending = this.ctx.memory?.pendingProposal;
    if (this.ctx.memory && !this.ctx.memory.mutation && (this.ctx.attempt.calendarReplyTo ||
      pending && readCalendarReply(this.ctx.input.content, pending).decision !== 'unrelated')) {
      await this.promote();
    }
    await this.requireDispatchAllowed();

    if ((!this.ctx.memory || this.ctx.memory.mutation)
      && this.dispatchIds.length === 0
      && isCalendarV2(this.ctx.calendar)
      && (!this.ctx.memory || this.ctx.memory.pendingProposal !== null || Boolean(this.ctx.attempt.calendarReplyTo))) {
      // The pending slot includes expired proposals: an expired disclosure must
      // be tombstoned, not silently ignored.
      const proposal = await this.ctx.persistence.calendarProposals.getCurrentSlot(
        this.ctx.attempt.userId,
        this.ctx.attempt.sessionId,
      );
      if (proposal && proposal.state === 'pending' && this.ctx.turnMode?.current()?.mode !== 'dev') {
        const account = await this.resolveReadAccount();
        const operationId = key('calendar-operation', this.ctx.attempt.userId, this.ctx.attempt.sessionId, proposal.intentId);
        // A message that is not an answer to this proposal may not consume it.
        // It stays pending and the message is answered as ordinary
        // Calendar-capable text below.
        const interpretedReply = readCalendarReply(this.ctx.input.content, proposal);
        const replyDecision = interpretedReply.decision;
        if (replyDecision !== 'unrelated') {
          // A reply may only answer the current pending proposal. A client
          // reference is untrusted and must name the current proposal revision;
          // a reply without one is only accepted when the server can prove a
          // unique unchanged disclosure. Otherwise the runtime asks which
          // proposal is meant and has no effect on any proposal, account or
          // operation.
          const replyTo = this.ctx.attempt.calendarReplyTo !== undefined
            ? this.ctx.attempt.calendarReplyTo
            : await this.ctx.persistence.calendarProposals.getReplyReference(
              this.ctx.attempt.userId, this.ctx.attempt.sessionId, this.ctx.attempt.attemptId);
          const target = await resolveReplyTarget({
            proposals: this.ctx.persistence.calendarProposals,
            userId: this.ctx.attempt.userId,
            sessionId: this.ctx.attempt.sessionId,
            proposal,
            replyTo,
            // The attempt list is only needed to prove the disclosure ledger.
            attempts: replyTo ? [] : await attemptsFor(
              this.ctx.persistence, this.ctx.attempt.userId, this.ctx.attempt.sessionId),
          });
          if (target.outcome === 'not-current') {
            this.lastText = 'Which current scheduling request do you mean?';
            this.captureView(calendarNotice('clarification', this.lastText,
              { proposalId: proposal.proposalId, intentId: proposal.intentId }));
            this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null });
            return this.seal(input);
          }
          const nowMs = Date.parse(this.ctx.now());
          const canAuthorize =
            proposal.incomplete === undefined
            && nowMs < Date.parse(proposal.expiresAt)
            && nowMs < Date.parse(proposal.contentExpiresAt)
            && proposal.connectionId === account.connectionId
            && proposal.connectionRevision === account.connectionRevision
            && proposal.googleSubjectId === account.googleSubjectId
            && (
              (replyDecision === 'accept' && proposal.purpose !== 'selection')
              || (replyDecision === 'select'
                && proposal.purpose === 'selection'
                && proposal.candidates.some(c => c.target.calendarId === interpretedReply.choiceCalendarId))
            );
          if (canAuthorize) {
            await this.ctx.memory?.mutation?.ensureAccepted();
          }
        }
        const replyResult = await consumeOrTombstoneProposal({
          account,
          proposal,
          replyMessage: this.ctx.input,
          replyTurnId: this.ctx.attempt.turnId,
          operationId,
          clock: () => Date.parse(this.ctx.now()),
          proposals: this.ctx.persistence.calendarProposals,
          admitEffect: related => this.ctx.turnMode?.admitEffect(related) ?? true,
        });

        if (replyResult.outcome === 'mode-denied' && this.ctx.localToolControl) {
          return this.answerAndSeal(input,
            'Dev mode is enabled. Calendar confirmation is unavailable.', null);
        }
        if (replyResult.outcome === 'expired') {
          this.ctx.memory?.onProposal?.(null);
          this.lastText = 'The scheduling confirmation has expired. Please state your scheduling request again.';
          this.captureView(calendarNotice('expired', this.lastText,
            { proposalId: proposal.proposalId, intentId: proposal.intentId }));
          this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null });
          return this.seal(input);
        }
        if (replyResult.outcome === 'cancelled') {
          this.ctx.memory?.onProposal?.(null);
          this.lastText = 'Scheduling has been cancelled.';
          this.captureView(calendarNotice('cancelled', this.lastText,
            { proposalId: proposal.proposalId, intentId: proposal.intentId }));
          this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null });
          return this.seal(input);
        }
        if (replyResult.outcome === 'clarify' && replyResult.reason !== 'edit') {
          // Incomplete/ambiguous replies retain the actual pending proposal.
          this.captureView(projectProposalView(proposal));
          if (replyResult.reason === 'incomplete') {
            // The proposal is explicitly incomplete. It stays pending until a
            // complete proposal supersedes it.
            this.lastText = proposal.purpose === 'selection'
              ? 'Which calendar should I schedule the event on?'
              : 'Please provide the missing scheduling details before I schedule the event.';
            this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null });
            return this.seal(input);
          }
          if (replyDecision === 'select') {
            // A named calendar that is not one of the disclosed candidates still
            // needs the user to choose between them.
            this.lastText = 'Which calendar should I schedule the event on?';
            this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null });
            return this.seal(input);
          }
          // The reply engages the proposal without answering it. The proposal
          // stays pending and the runtime asks again instead of answering the
          // message as ordinary chat.
          this.lastText = ambiguousReplyText(proposal);
          this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null });
          return this.seal(input);
        }
        if (replyResult.outcome === 'unrelated') {
          // The message is not an answer to this proposal. The proposal stays
          // pending and the message is answered as ordinary Calendar-capable
          // text below, with no effect.
        }
        if (replyResult.outcome === 'authorized') {
          this.ctx.memory?.onProposal?.(null);
          const sealed = await this.executeAuthorizedProposal(
            input, proposal, replyResult.choiceTarget, replyResult.consumption);
          if (sealed) return sealed;
        }
      }
    }

    const blockedBeforeDecide = await this.revalidateActiveSources(input);
    if (blockedBeforeDecide) return blockedBeforeDecide;

    const repair = this.cursor.repair;
    const web = this.ctx.web;
    const composite = Boolean(web);
    const memoryAdvertised = this.ctx.memoryTool?.allowed() === true;
    this.ctx.beforeModel?.();
    if (web && !web.beforeModel()) {
      return this.answerAndSeal(input,
        "I couldn't verify this on the live web. Please try again.", null);
    }
    const expectedCanvasSelection = this.ctx.canvasSelection?.() ?? null;
    const turnCanvasInventory = this.ctx.canvasInventory?.() ?? { items: [], omitted: 0 };
    const turnCanvasStateSnapshot = canvasTurnState(turnCanvasInventory, expectedCanvasSelection);
    const assembled = this.assemble(this.groups, repair, turnCanvasInventory, expectedCanvasSelection, memoryAdvertised);
    const reason = repair ? 'schema-repair' : this.dispatchIds.length ? 'continuation' : 'initial';
    // A possible enabled User reserves the fixed worst-case guidance + marker,
    // so a late enable cannot exceed the held reservation. Off adds no padding.
    const modePadding = this.ctx.turnMode?.current() === null || this.ctx.turnMode === undefined ? 0
      : Buffer.byteLength(turnModeGuidance('User') + turnModeMarker('User', ''), 'utf8') + 64;
    const reserve = () => this.ctx.ledger.reserveDispatch(reason, {
      estimatedInputTokens: assembled.estimatedInputTokens + modePadding,
    }, repair);
    // Budget creation and reservation are storage-only and retain separate
    // acknowledgments inside the existing bounded ownership phase. The model
    // dispatch fence/account gate still runs afterwards, outside this phase.
    const owner = this.ctx.persistence.owner;
    const dispatch = !this.ctx.memory && owner.runPhase
      ? await this.ctx.job.wait(owner.runPhase(this.ownedLease(), {
          name: 'model-observation', maxOperations: 4,
          deadlineAt: Math.min(Date.now() + this.ctx.snapshot.budgets.persistenceTimeoutMs,
            Date.parse(this.ownedLease().leaseExpiresAt) - 1000),
        }, reserve), this.ctx.snapshot.budgets.persistenceTimeoutMs)
      : await reserve();
    this.dispatchIds.push(dispatch.dispatchId);
    this.pendingContinuationBreak = this.dispatchIds.length > 1;
    const binding = await this.ctx.ledger.bindingFor(dispatch);
    const modelConfig = {
      identity: { userId: this.ctx.attempt.userId },
      openRouter: this.ctx.snapshot.openRouter, budgets: this.ctx.snapshot.budgets,
    };
    const adapter: SkillModelPort = composite || memoryAdvertised
      ? createCalendarModelPortV2(modelConfig, this.ctx.snapshot.modelLimits!,
        binding, this.ctx.fetcher, this.ctx.diagnostics?.emit, composite, memoryAdvertised) as unknown as SkillModelPort
      : isCalendarV2(this.ctx.calendar)
        ? this.ctx.calendar.createModelPort(modelConfig, this.ctx.snapshot.modelLimits!,
          binding, this.ctx.fetcher)
        : createCalendarModelPortV2(modelConfig, this.ctx.snapshot.modelLimits!,
          binding, this.ctx.fetcher) as unknown as SkillModelPort;
    const request = {
      dispatchId: dispatch.dispatchId, decisionId: dispatch.decisionId, user: this.ctx.attempt.openRouterUser,
      modelId: this.ctx.attempt.modelId, messages: assembled.messages,
      tools: composite ? webToolsFor(skillToolsFor(memoryAdvertised)) : skillToolsFor(memoryAdvertised),
      maxOutputTokens: this.ctx.snapshot.budgets.maxOutputTokens,
      remainingContextTokens: assembled.remainingContextTokens,
      deadlineAt: this.ctx.ledger.deadlineAt(), signal: this.ctx.job.signal,
      dataCollection: 'deny' as const, processingPolicyId: this.policyId(), repair,
    };
    const modeDispatch: TurnModelDispatch | undefined = this.ctx.turnMode ? {
      handle: this.ctx.turnMode, rawInput: this.ctx.input.content,
      project: decision => {
        const messages = assembled.messages;
        let userIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') { userIndex = i; break; }
        if (userIndex < 0 || messages[userIndex]!.content !== this.ctx.input.content) {
          throw new AppError('INVALID_REQUEST', 'The calendar request is invalid.', false);
        }
        return projectTurnMessages(messages as unknown as readonly ContextChatMessage[], userIndex,
          this.ctx.context as PositionedContext, decision);
      },
    } : undefined;
    let decision: SkillDecision | null = null;
    let memoryCandidate: MemoryToolCandidate | null = null;
    let webTerminal: { text: string; feedback?: string } | null = null;
    let rejectionV2: CalendarRejectedDecisionV2 | null = null;
    let failure: CalendarFailure | null = null;
    let redundantControl: Extract<SkillDecision, { kind: 'control_canvas' }> | null = null;
    let pendingControl: {
      group: CompatibleCalendarToolGroup;
      decisionRecord: z.infer<typeof resumableSkillDecisionSchema>;
      localRecord: z.infer<typeof localSkillResultRecordSchema>;
      duplicateCall: boolean;
      result: CanvasControlResult;
      ttsText: string;
      decisionId: string;
    } | null = null;
    try {
      for await (const chunk of dispatchStream(adapter, request, modeDispatch)) {
        if (chunk.type === 'decision') {
          const candidate = chunk.decision as WebNativeDecision;
          if (candidate.kind === 'update_user_memory' || candidate.kind === 'memory-secret'
            || candidate.kind === 'memory-invalid') {
            memoryCandidate = candidate;
            continue;
          }
          if (web && isWebDecision(candidate)) {
            if (candidate.kind === 'web-invalid') {
              const repaired = web.repair(candidate.diagnostics, candidate.call);
              if (!repaired.retry) {
                webTerminal = { text: "I couldn't format a valid web request, so I couldn't verify this on the live web. Please try again." };
                break;
              }
              webTerminal = { text: '', feedback: repaired.feedback };
              break;
            }
            if (candidate.kind === 'web-denied') {
              webTerminal = { text: "I couldn't verify this on the live web. Please try again." };
              break;
            }
            if (candidate.kind !== 'web_tool') break;
            this.pendingWeb = candidate;
            break;
          }
          decision = skillDecisionSchema.parse(chunk.decision);
          if (decision.kind === 'control_canvas' && !pendingControl && !redundantControl) {
            const duplicateCall = this.canvasControlResults.has(decision.nativeCall.id);
            const parsedArgs = controlCanvasArgumentsSchema.safeParse(decision.envelope);
            if (!duplicateCall && this.ctx.responseMode === 'voice' && parsedArgs.success
              && isRedundantCanvasControl(parsedArgs.data, turnCanvasStateSnapshot)) {
              redundantControl = decision;
            } else {
              const executed = this.dispatchCanvasControl(decision, expectedCanvasSelection, turnCanvasInventory);
              const resultContent = serializeNativeLocalResult(executed.result, this.ctx.limits.resultBytes);
              const group = skillGroup(decision, resultContent);
              const decisionRec = this.decisionRecord(dispatch.dispatchId, decision, [], repair);
              const localRec = this.localRecord(decision, resultContent);
              if (this.ctx.memory && !duplicateCall) {
                this.ctx.memory.stage.putDecision(decisionRec);
                this.ctx.memory.stage.putResult(localRec);
                this.groups.push(group);
              }
              pendingControl = {
                group, decisionRecord: decisionRec, localRecord: localRec, duplicateCall,
                result: executed.result, ttsText: executed.ttsText, decisionId: decision.decisionId,
              };
            }
          }
        }
        else if (chunk.type === 'rejected') rejectionV2 = rejectedDecisionV2Schema.parse(chunk.evidence);
        else if (chunk.type === 'failure') failure = calendarFailureSchema.parse(chunk.failure);
        else if (chunk.type === 'text-delta') {
          let text = chunk.text;
          if (this.pendingContinuationBreak) {
            text = separateAssistantContinuation(this.lastText, text);
            this.pendingContinuationBreak = false;
          }
          this.lastText += text;
          for (let offset = 0; offset < text.length; offset += 1000) {
            await this.emit({ type: 'delta', text: text.slice(offset, offset + 1000) });
          }
        }
      }
    } catch (error) {
      if (this.ctx.memory) {
        // Consumer cancellation/output failure can close the iterator before its
        // final failure chunk. Retain the paid dispatch as terminal, with unknown
        // cost still held; cleanup grants no retry or external-access authority.
        await this.ctx.ledger.finishDispatch(dispatch.dispatchId, {
          category: this.ctx.job.signal.aborted ? 'cancelled'
            : error instanceof AppError && ['STORAGE_BUDGET_EXCEEDED', 'CONTEXT_BUDGET_EXCEEDED'].includes(error.code)
              ? 'budget' : 'uncertain',
          code: this.ctx.job.signal.aborted ? 'INTERRUPTED'
            : error instanceof AppError ? error.code : 'MODEL_STREAM_INTERRUPTED', retry: 'none',
        });
        await this.ctx.ledger.aggregate();
      }
      throw error;
    }
    await this.ctx.ledger.finishDispatch(dispatch.dispatchId, failure);
    if (memoryCandidate) {
      const action = this.ctx.memoryTool;
      if (memoryCandidate.kind === 'memory-invalid' || !action || action.receipt())
        return this.answerAndSeal(input, memoryReceiptText(action?.receipt()), null);
      this.ctx.job.check();
      if (this.ctx.turnMode?.frozen()?.mode === 'dev')
        return this.answerAndSeal(input, memoryReceiptText(null), null);
      if (Date.parse(this.ctx.now()) >= Date.parse(this.ctx.ledger.deadlineAt()))
        throw new AppError('TIMEOUT', 'The turn deadline has passed.', false);
      const proof = memoryReceiptHeadroom(memoryCallId(memoryCandidate));
      this.assemble([...this.groups, proof], null, undefined, undefined, true);
      const ms = Date.parse(this.ctx.ledger.deadlineAt()) - Date.now();
      if (ms <= 0) throw new AppError('TIMEOUT', 'The turn deadline has passed.', false);
      const signal = AbortSignal.any([this.ctx.job.signal, AbortSignal.timeout(ms)]);
      const group = await this.ctx.job.track(action.run(memoryCandidate, signal));
      this.ctx.job.check();
      this.groups.push(group);
      this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'decide', pendingDecisionId: null, repair: null });
      return { calendarCursor: this.cursor, calendarRefs: this.refs() };
    }
    if (webTerminal) {
      if (webTerminal.feedback !== undefined) {
        this.modelNote = webTerminal.feedback;
        this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'decide',
          pendingDecisionId: null, repair: null });
        return { calendarCursor: this.cursor, calendarRefs: this.refs() };
      }
      return this.answerAndSeal(input, webTerminal.text, null);
    }
    if (this.pendingWeb) {
      this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'execute',
        pendingDecisionId: this.pendingWeb.call.id, repair: null });
      return { calendarCursor: this.cursor, calendarRefs: this.refs() };
    }
    if (rejectionV2) {
      if (this.ctx.memory) this.ctx.memory.stage.putRejected(rejectionV2);
      else await this.ctx.persistence.skillDecisions.putRejected(rejectionV2);
      return this.repairOrSeal(input, rejectionV2.decisionId, rejectionV2.diagnostics);
    }
    if (failure) {
      if (isConversationalCalendarFailure(failure)) {
        const tool = decision?.kind === 'call_tool'
          && CALENDAR_TOOLS.some(candidate => candidate.name === decision!.envelope.tool)
          ? decision.envelope.tool as CalendarCall['name'] : undefined;
        return this.failConversationally(input, failure, decision?.decisionId ?? null, tool);
      }
      const abort = abortForCalendarFailure(failure);
      if (abort) throw abort;
      throw new AppError('PROVIDER_ERROR', 'The model service could not answer.', false);
    }
    if (!decision) throw new AppError('INTERRUPTED', 'The response stream ended early.', false);
    if (decision.kind !== 'text' && this.ctx.turnMode?.frozen()?.mode === 'dev') {
      // Alternate/test ports cannot introduce tool evidence in Dev.
      return this.answerAndSeal(input,
        "I couldn't use tools in Dev mode. Ask me to explain this conversation instead.", null);
    }
    if (redundantControl) {
      const current = await this.ctx.ledger.ensureBudget();
      diagnose(this.ctx.diagnostics?.emit, {
        stage: 'validation', state: 'rejected', reason: 'duplicate-call',
        field: 'tool_calls', expected: 'one-call', constraint: 'one-call',
        origin: 'local', delivery: 'not-sent',
        decisionId: redundantControl.decisionId,
        toolCallId: redundantControl.nativeCall.id,
        tool: 'control_canvas',
        correctionAttempt: current.repairs, correctionLimit: this.ctx.limits.repairs,
      });
      const action = controlCanvasArgumentsSchema.safeParse(redundantControl.envelope);
      const expected = !turnCanvasStateSnapshot.open && action.success && action.data.action !== 'close'
        ? 'open-canvas-first'
        : 'one-call';
      return this.repairOrSeal(input, redundantControl.decisionId,
        [{ path: 'tool_calls', code: 'redundant-call', expected }],
        'I could not complete that Canvas request after correcting my tool calls. You do not need to change your question. Please try again.');
    }
    if (pendingControl) {
      if (!this.ctx.memory && !pendingControl.duplicateCall) {
        this.ctx.job.check();
        if (!await this.ctx.persistence.owner.fence(this.ownedLease())) {
          throw new AppError('INTERRUPTED', 'Execution ownership was lost.');
        }
        await this.ctx.persistence.skillDecisions.put(pendingControl.decisionRecord);
        await this.ctx.persistence.skillResults.put(pendingControl.localRecord);
        this.groups.push(pendingControl.group);
      }
      this.setTask(
        pendingControl.result.outcome === 'requested' ? 'success'
          : pendingControl.result.outcome === 'mode-not-allowed' ? 'denied' : 'fallback',
        pendingControl.result.outcome === 'mode-not-allowed' ? 'not-sent' : 'not-applicable',
      );
      return this.answerAndSeal(input, pendingControl.ttsText, pendingControl.decisionId);
    }
    const sources = decision.kind === 'text'
      ? this.provenance().filter(source => source.schemaVersion === 2) : [];
    if (this.ctx.memory) {
      this.pendingMemoryDecision = decision.kind === 'text' ? null : decision;
    }
    const record = this.decisionRecord(dispatch.dispatchId, decision, sources, repair);
    if (this.ctx.memory) this.ctx.memory.stage.putDecision(record);
    else await this.ctx.persistence.skillDecisions.put(record);
    if (decision.kind !== 'text') {
      this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'execute',
        pendingDecisionId: decision.decisionId, repair: null });
      return { calendarCursor: this.cursor, calendarRefs: this.refs() };
    }
    this.lastDecisionId = decision.decisionId;
    this.lastText = decision.content;
    this.textDecisionId = decision.decisionId;
    this.truncated = decision.truncated;
    this.cursor = calendarCursorSchema.parse({
      ...this.cursor, next: 'seal', pendingDecisionId: decision.decisionId, repair: null,
    });
    return this.seal(input);
  }

  async execute(input: GraphInput): Promise<CalendarGraphPatch> {
    if (this.ctx.turnMode?.frozen()?.mode === 'dev') {
      // Fail closed for any non-text decision: no tool evidence, no second model call.
      this.pendingWeb = null;
      return this.answerAndSeal(input,
        "I couldn't use tools in Dev mode. Ask me to explain this conversation instead.", null);
    }
    if (this.pendingWeb && this.ctx.web) {
      const decision = this.pendingWeb;
      this.pendingWeb = null;
      const executed = await this.ctx.web.execute(decision, this.groups.length);
      if ('failure' in executed) {
        const failureGroup = this.ctx.web.recordFailure(decision, executed.failure, this.groups.length);
        // Unrecorded means the bounded evidence cap rejected replay; still show
        // the pair this turn so the model can answer, but it cannot persist.
        if (!failureGroup.recorded) this.webSyntheticGroups.push(failureGroup.group);
      }
      this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'decide',
        pendingDecisionId: null, repair: null });
      return { calendarCursor: this.cursor, calendarRefs: this.refs() };
    }
    await this.requireDispatchAllowed();
    const decisionId = this.cursor.pendingDecisionId;
    if (!decisionId) throw new AppError('NOT_READY', 'Calendar decision is unavailable.');
    const liveDecision = this.ctx.memory && this.pendingMemoryDecision?.decisionId === decisionId
      ? this.pendingMemoryDecision : null;
    const saved = liveDecision ? null : (this.ctx.memory ? this.ctx.memory.stage.getDecision(decisionId)
      : await this.ctx.persistence.skillDecisions.get(this.ctx.attempt.userId, decisionId));
    const decision = liveDecision ?? (saved?.schemaVersion === 3 ? saved.decision : null);
    if (!decision || decision.kind === 'text') {
      this.pendingMemoryDecision = null;
      throw new AppError('NOT_READY', 'Calendar decision is unavailable.');
    }
    if (decision.kind === 'show_canvas') {
      this.pendingMemoryDecision = null;
      const parsed = showCanvasArgumentsSchema.safeParse(decision.envelope);
      const canvas_id = parsed.success ? parsed.data.canvas_id : null;
      const bound = (outcome: CanvasNavigationResult['outcome']): CanvasNavigationResult =>
        canvasNavigationResultSchema.parse({ kind: 'canvas-navigation', outcome, canvas_id });
      let result: CanvasNavigationResult;
      if (this.ctx.responseMode !== 'voice') result = bound('mode-not-allowed');
      else if (!parsed.success) result = bound('invalid-arguments');
      else {
        try {
          result = this.ctx.navigateCanvas?.(decision.envelope, decision.nativeCall.id)
            ?? bound('delivery-unavailable');
        } catch {
          result = bound('delivery-unavailable');
        }
      }
      await this.recordLocal(decision, canvasNavigationResultSchema.parse(result));
      this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'decide', pendingDecisionId: null, repair: null });
      return { calendarCursor: this.cursor, calendarRefs: this.refs() };
    }
    if (decision.kind === 'control_canvas') {
      const parsed = controlCanvasArgumentsSchema.safeParse(decision.envelope);
      await this.recordLocal(decision, canvasControlResultSchema.parse({
        kind: 'canvas-control',
        outcome: 'delivery-unavailable',
        action: parsed.success ? parsed.data.action : null,
        canvas_id: parsed.success && parsed.data.action === 'open' ? parsed.data.canvas_id : null,
      }));
      this.setTask('fallback', 'not-applicable');
      return this.answerAndSeal(input,
        parsed.success && parsed.data.action === 'open'
          ? "I couldn't update the Canvas view right now."
          : "I couldn't reach the Canvas right now.",
        decision.decisionId);
    }
    if (decision.kind === 'get_environment') {
      this.pendingMemoryDecision = null;
      this.ctx.job.check();
      if (Date.parse(this.ctx.ledger.deadlineAt()) <= Date.parse(this.ctx.now())) {
        throw new AppError('TIMEOUT', 'The turn deadline has passed.', false);
      }
      const executed = this.ctx.executeEnvironment
        ? await this.ctx.executeEnvironment(decision.envelope, this.ctx.job.signal)
        : await executeEnvironmentTool({
            envelope: decision.envelope,
            now: new Date(this.ctx.now()),
            timeZone: this.effectiveTimeZone(),
            signal: this.ctx.job.signal,
          });
      await this.recordLocal(decision, executed.result);
      if (executed.weatherView) {
        // The view belongs to this sealed assistant turn, not only to the live
        // presentation hook, so a reload can show it again.
        this.weather = executed.weatherView;
        try { this.ctx.onWeatherView?.(executed.weatherView); }
        catch { /* Presentation hook never alters tool authority. */ }
      }
      this.cursor = calendarCursorSchema.parse({
        ...this.cursor, next: 'decide', pendingDecisionId: null, repair: null,
      });
      return { calendarCursor: this.cursor, calendarRefs: this.refs() };
    }
    const assembled = this.assemble(this.groups, null);
    if (decision.kind === 'activate_skill') {
      const available = this.ctx.calendarEnabled === false ? [] : CALENDAR_TOOLS;
      const resolved = activateLocalSkill(decision.envelope, assembled.loadedSkills,
        this.ctx.limits.resultBytes, available);
      if (resolved.kind === 'skill-error') {
        await this.recordLocal(decision, resolved);
        return this.answerAndSeal(input, resolved.code === 'DISCLOSURE_BUDGET_EXCEEDED'
          ? 'That schema batch is too large. Request a smaller explicit tool selection or start a new chat.'
          : 'That plugin or tool is not available.', decision.decisionId);
      }
      try {
        await this.recordLocal(decision, resolved);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'CONTEXT_BUDGET_EXCEEDED') throw error;
        const fallback = skillError('DISCLOSURE_BUDGET_EXCEEDED', decision.envelope.plugin, null);
        await this.recordLocal(decision, fallback);
        return this.answerAndSeal(input,
          'That schema batch does not fit in this chat. Request a smaller explicit tool selection or start a new chat.',
          decision.decisionId);
      }
      this.cursor = calendarCursorSchema.parse({
        ...this.cursor, next: 'decide', pendingDecisionId: null, repair: null,
      });
      return { calendarCursor: this.cursor, calendarRefs: this.refs() };
    }
    // Plugin execution is unavailable without an enabled Calendar plugin, even
    // when an earlier disclosure remains in assembled history.
    if (this.ctx.calendarEnabled === false) {
      const result = skillError('UNKNOWN_PLUGIN', decision.envelope.plugin, decision.envelope.tool);
      await this.recordLocal(decision, result);
      return this.answerAndSeal(input, 'That plugin or tool is not available.', decision.decisionId);
    }
    const rejection = requireLoadedSkill(decision.envelope, assembled.loadedSkills);
    if (rejection) {
      await this.recordLocal(decision, rejection);
      if (rejection.kind === 'skill-error' && rejection.retry === 'activate-skill') {
        const code = rejection.code === 'SCHEMA_STALE' ? 'schema-stale' as const : 'schema-not-loaded' as const;
        return this.repairOrSeal(input, decision.decisionId, [{ path: 'tool', code, expected: 'bounded-value' }]);
      }
      return this.answerAndSeal(input, 'That plugin or tool is not available.', decision.decisionId);
    }
    let call: CalendarCall;
    try {
      // The established executor validator is the authority for domain arguments.
      call = validateCalendarCall({ name: decision.envelope.tool, arguments: decision.envelope.arguments },
        this.ctx.limits, this.ctx.diagnostics?.emit);
    } catch (error) {
      if (!(error instanceof CalendarToolFault)) throw error;
      if (error.failure.retry === 'schema-repair' || error.failure.code === 'CALENDAR_INPUT_REJECTED'
        || error.failure.code === 'CALENDAR_ARGUMENTS_INVALID') {
        const diagnostics: CalendarRepairDiagnostics = [{ path: 'tool_calls.arguments',
          code: 'invalid-value', expected: 'bounded-value' }];
        await this.recordLocal(decision, skillError('ARGUMENTS_INVALID', decision.envelope.plugin,
          decision.envelope.tool, diagnostics));
        return this.repairOrSeal(input, decision.decisionId, diagnostics);
      }
      return this.failConversationally(input, error.failure, decision.decisionId);
    }
    if ((call.name === 'calendar_create_event' && this.lastOperationId !== null) || this.repeatsEarlierRead(call)) {
      this.pendingMemoryDecision = null;
      const current = await this.ctx.ledger.ensureBudget();
      diagnose(this.ctx.diagnostics?.emit, { stage: 'validation', state: 'rejected', reason: 'duplicate-call',
        field: 'tool_calls', expected: 'one-call', constraint: 'one-call', origin: 'local', delivery: 'not-sent',
        decisionId: decision.decisionId, toolCallId: decision.nativeCall.id, tool: call.name,
        correctionAttempt: current.repairs, correctionLimit: this.ctx.limits.repairs });
      const patched = await this.repairOrSeal(input, decision.decisionId,
        [{ path: 'tool_calls', code: 'redundant-call', expected: 'one-call' }]);
      if (this.ctx.memory && patched.calendarCursor?.next === 'seal' &&
          !this.ctx.memory.stage.records().results.some(r => r.toolCallId === decision.nativeCall.id)) {
        this.ctx.memory.stage.putTerminalCall({
          decisionId: decision.decisionId, toolCallId: decision.nativeCall.id, outcome: 'failed',
        });
      }
      return patched;
    }
    const executionDecision = { kind: 'tool' as const, decisionId: decision.decisionId,
      toolCallId: decision.nativeCall.id, call, terminal: 'tool_calls' as const };
    if (call.name === 'calendar_create_event') {
      if (!this.ctx.memory?.mutation) {
        try {
          await this.promote();
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'PERSISTENCE_ERROR') {
            this.pendingMemoryDecision = null;
          }
          throw error;
        }
      }
      this.pendingMemoryDecision = null;
      return this.executeCreateV2(input, executionDecision, decision);
    }
    this.pendingMemoryDecision = null;
    return this.executeReadV2(input, executionDecision, decision);
  }

  /**
   * The one writer that owns every mutating Calendar record. The legacy v1
   * ports are supplied for the legacy read-only path only.
   */
  private writer(): CalendarOperationWriter {
    const cal = this.requireCalendar();
    const mut = this.ctx.memory?.mutation?.writerOptions();
    const binding = mut
      ? { ...this.account(), calendarId: this.ctx.binding.calendarId, targetRevision: this.ctx.binding.targetRevision }
      : this.ctx.binding;
    return new CalendarOperationWriter({
      operations: this.ctx.persistence.calendarOperations,
      operationsV2: this.ctx.persistence.calendarOperationsV2,
      execution: cal.execution as any,
      executionV2: cal.execution,
      write: mut ? mut.write : action => this.ctx.job.wait(this.ctx.persistence.owner.run(this.ownedLease(), action),
        this.ctx.snapshot.budgets.persistenceTimeoutMs),
      ledger: mut ? mut.ledger : this.durableLedger(),
      identity: {
        userId: this.ctx.attempt.userId, sessionId: this.ctx.attempt.sessionId,
        turnId: this.ctx.attempt.turnId, attemptId: this.ctx.attempt.attemptId,
      },
      binding, clock: () => Date.parse(this.ctx.now()), job: this.ctx.job,
      fence: mut ? mut.fence : () => this.ctx.persistence.owner.fence(this.ownedLease()),
      requireCurrent: async (account, signal) => {
        await cal.connection.requireAccountCurrent(account, signal);
      },
      permission: cal.permission, trustedTimeZone: this.effectiveTimeZone(),
      auditDeadlineAt: cal.auditDeadlineAt,
      chargeProviderRequest: kind => this.chargeProviderRequest(kind),
    });
  }

  /**
   * The fresh capability check of an already resolved target. It re-resolves the
   * explicit calendar id under the same subject and connection: it never
   * resolves a new default and never binds a replacement account.
   */
  private async freshCapability(input: {
    account: CalendarAccountBinding; target: CalendarResolvedTarget;
  }): Promise<{ outcome: 'ok'; target: CalendarResolvedTarget } | { outcome: 'clarify'; message: string }> {
    const cal = this.requireCalendar();
    const resolved = await cal.capabilities.resolve({
      account: input.account,
      selector: input.target.calendarId,
      operation: 'create',
      signal: this.ctx.job.signal,
      deadlineAt: this.ctx.ledger.deadlineAt(),
      consumeRequest: kind => this.chargeProviderRequest(kind),
      consumeRefreshRequest: () => this.chargeRefreshRequest(),
    });
    if (resolved.outcome === 'clarify') {
      return { outcome: 'clarify', message: 'That calendar is no longer available. Which calendar should I use?' };
    }
    if (resolved.outcome === 'denied') {
      return { outcome: 'clarify', message: 'Permission to schedule on this calendar was denied.' };
    }
    return { outcome: 'ok', target: resolved.target };
  }

  /**
   * The fresh server-owned availability preflight for one create.
   */
  private async freshPreflight(input: {
    action: CalendarCreateInput; target: CalendarResolvedTarget;
    intentId: string; decisionId: string; stage: 'direct-create' | 'proposal-reply';
  }): Promise<CalendarAvailabilityResult> {
    const cal = this.requireCalendar();
    const account = this.account();
    return runCalendarPreflight({
      execution: cal.execution,
      ledger: {
        chargeCalendarRequest: kind => this.chargeProviderRequest(kind),
        chargeRefreshRequest: () => this.chargeRefreshRequest(),
      },
      account,
      sessionId: this.ctx.attempt.sessionId,
      turnId: this.ctx.attempt.turnId,
      attemptId: this.ctx.attempt.attemptId,
      decisionId: input.decisionId,
      intentId: input.intentId,
      stage: input.stage,
      action: input.action,
      trustedNow: this.ctx.now(),
      trustedTimeZone: this.effectiveTimeZone(),
      deadlineAt: this.ctx.ledger.deadlineAt(),
      signal: this.ctx.job.signal,
    });
  }

  /**
   * Publishes the durable incomplete-details proposal of one accepted request.
   *
   * The proposal names the still-missing material fields and the accepted
   * message they came from. It carries no action and no canonical hash, so the
   * contract refuses to consume it until a complete proposal supersedes it.
   */
  private async publishIncompleteDetails(
    decision: CalendarDecision & { kind: 'tool' },
    missing: readonly IntentMissingField[],
  ): Promise<CalendarProposalRecord> {
    const cal = this.requireCalendar();
    const account = this.account();
    const published = await this.publishAndRecord({
      account,
      intent: {
        intentId: calendarIntentId(this.ctx.input),
        originatingTurnId: this.ctx.attempt.turnId,
        originatingAcceptedMessageId: this.ctx.input.messageId,
        originatingAttemptId: this.ctx.attempt.attemptId,
        action: decision.call.arguments as CalendarCreateInput,
        selector: null,
      },
      purpose: 'details',
      target: null,
      action: null,
      incomplete: { missing: calendarMissingFields(missing), messageRefs: [this.ctx.input.messageId] },
      candidates: [],
      conditionFingerprint: null,
      discoveryRevision: await this.currentDiscoveryRevision(cal, account),
      availabilityRevision: null,
      retentionPolicyId: cal.permission.policyId,
      contentExpiresAt: await this.proposalContentExpiry(cal, account),
      limits: this.ctx.limits,
      clock: () => Date.parse(this.ctx.now()),
      proposals: this.ctx.persistence.calendarProposals,
      sessionId: this.ctx.attempt.sessionId,
    });
    this.lastProposalId = published.proposalId;
    this.lastProposalRevision = published.revision;
    return published;
  }

  /**
   * Publishes the durable selection proposal of a request whose target is
   * unknown or unavailable.
   *
   * The proposal has no candidates and declares the missing target, so it can
   * never be consumed and no candidate is implied.
   */
  private async publishIncompleteSelection(
    account: CalendarAccountBinding,
    intent: AcceptedCalendarIntent,
  ): Promise<CalendarProposalRecord> {
    const cal = this.requireCalendar();
    const published = await this.publishAndRecord({
      account,
      intent,
      purpose: 'selection',
      target: null,
      action: null,
      incomplete: { missing: ['target'], messageRefs: [this.ctx.input.messageId] },
      candidates: [],
      conditionFingerprint: null,
      discoveryRevision: await this.currentDiscoveryRevision(cal, account),
      availabilityRevision: null,
      retentionPolicyId: cal.permission.policyId,
      contentExpiresAt: await this.proposalContentExpiry(cal, account),
      limits: this.ctx.limits,
      clock: () => Date.parse(this.ctx.now()),
      proposals: this.ctx.persistence.calendarProposals,
      sessionId: this.ctx.attempt.sessionId,
    });
    this.lastProposalId = published.proposalId;
    this.lastProposalRevision = published.revision;
    return published;
  }

  /** The discovery revision the connection currently backs its proposals with. */
  private async currentDiscoveryRevision(
    cal: CalendarRuntimeV2Dependencies,
    account: CalendarAccountBinding,
  ): Promise<number> {
    const record = await cal.connection.requireAccountCurrent(account, this.ctx.job.signal);
    return record.discovery?.discoveryRevision ?? 1;
  }

  /**
   * Withdraws a pending incomplete-details proposal.
   *
   * An incomplete proposal carries no canonical action, so no reply may consume
   * it. A complete request supersedes it and it must not answer a later reply.
   */
  private async closeIncompleteProposal(): Promise<void> {
    const proposals = this.ctx.persistence.calendarProposals;
    const proposal = await proposals.getCurrentSlot(this.ctx.attempt.userId, this.ctx.attempt.sessionId);
    if (!proposal || proposal.state !== 'pending' || proposal.incomplete === undefined) return;
    await proposals.tombstone({
      expectedRevision: proposal.revision,
      tombstone: calendarProposalTombstoneSchema.parse({
        schemaVersion: 2,
        kind: 'calendar-proposal-tombstone',
        userId: proposal.userId,
        sessionId: proposal.sessionId,
        proposalId: proposal.proposalId,
        intentId: proposal.intentId,
        revision: proposal.revision + 1,
        reason: 'superseded',
        operationId: null,
        canonicalActionHash: null,
        at: this.ctx.now(),
        unresolvedOperation: false,
      }),
    });
  }

  /**
   * Publishes the durable conflict proposal for a condition that needs explicit
   * acceptance and returns the bounded user-facing question.
   */
  private async publishConflict(input: {
    intent: AcceptedCalendarIntent; target: CalendarResolvedTarget; action: CalendarCreateInput;
    condition: CalendarAvailabilityResult; requestHash: string; account: CalendarAccountBinding;
  }): Promise<string> {
    const cal = this.requireCalendar();
    const fingerprint = calendarAvailabilityFingerprint(input.condition);
    const published = await this.publishAndRecord({
      account: input.account,
      intent: input.intent,
      purpose: 'conflict',
      target: input.target,
      action: input.action,
      candidates: [],
      conditionFingerprint: fingerprint,
      disclosedLimitations: input.condition.limitations,
      discoveryRevision: input.target.discoveryRevision,
      availabilityRevision: input.condition.availabilityRevision,
      retentionPolicyId: cal.permission.policyId,
      contentExpiresAt: await this.proposalContentExpiry(cal, input.account),
      limits: this.ctx.limits,
      clock: () => Date.parse(this.ctx.now()),
      proposals: this.ctx.persistence.calendarProposals,
      sessionId: this.ctx.attempt.sessionId,
    });
    this.lastProposalId = published.proposalId;
    this.lastProposalRevision = published.revision;
    return this.clarificationText(published, input.condition);
  }

  /**
   * The accepted reply of a consumed proposal. The single create entry point
   * owns the reservation, the dispatch and the outcome classification.
   */
  private async executeAuthorizedProposal(
    input: GraphInput,
    proposal: CalendarProposalRecord,
    choiceTarget: CalendarResolvedTarget | null,
    consumption: CalendarProposalConsumption,
  ): Promise<CalendarGraphPatch | null> {
    const cal = this.requireCalendar();
    const target = choiceTarget ?? proposal.target;
    if (!target) {
      return this.answerAndSeal(input, 'Which calendar should I use?');
    }
    const account = await this.resolveReadAccount();
    const rawAction = proposal.action ?? {
      summary: 'Planning',
      start: '2026-11-03T10:00:00+00:00',
      end: '2026-11-03T11:00:00+00:00',
      timeZone: this.effectiveTimeZone(),
    };
    const canonicalAction = canonicalCalendarAction(rawAction, target);
    const nowIso = this.ctx.now();
    const auditCap = Date.parse(nowIso) + 2592000000;
    const auditExpiresAt = new Date(cal.auditDeadlineAt ? Math.min(Date.parse(cal.auditDeadlineAt), auditCap) : auditCap).toISOString();
    const intent: AcceptedCalendarIntent = {
      intentId: proposal.intentId,
      originatingTurnId: proposal.originatingTurnId,
      originatingAcceptedMessageId: proposal.originatingAcceptedMessageId,
      originatingAttemptId: proposal.originatingAttemptId,
      action: rawAction,
      selector: null,
    };

    this.lastProposalId = proposal.proposalId;
    this.lastProposalRevision = proposal.revision;
    await this.ctx.memory?.mutation?.ensureAccepted();
    await this.emit({ type: 'calendar-progress', phase: 'executing' });
    const outcome = await this.writer().executeCreate({
      intent,
      account,
      target,
      accepted: { message: this.ctx.input, turnId: this.ctx.attempt.turnId },
      proposal,
      consumption,
      action: canonicalAction,
      requestHash: consumption.canonicalActionHash,
      operationId: consumption.operationId,
      decisionId: key('dec', this.ctx.attempt.userId, this.ctx.attempt.turnId, 'proposal-decision'),
      toolCallId: key('call', this.ctx.attempt.userId, this.ctx.attempt.turnId, 'proposal-create'),
      createdAt: nowIso,
      auditExpiresAt,
      capability: input2 => this.freshCapability(input2),
      preflight: async input2 => {
        const condition = await this.freshPreflight({
          action: input2.action, target: input2.target, intentId: proposal.intentId,
          decisionId: key('dec', this.ctx.attempt.userId, this.ctx.attempt.turnId, 'proposal-decision'),
          stage: 'proposal-reply',
        });
        // The accepted condition is compared, never silently replaced.
        const stillAccepted = sameApprovedCondition({
          proposal, actionHash: consumption.canonicalActionHash, target,
          fingerprint: calendarAvailabilityFingerprint(condition),
        });
        if (stillAccepted) return null;
        // Confirm already accepted the event. Incomplete coverage is not a
        // second confirmation; only an overlapping busy interval pauses.
        return condition.conflict === 'conflict' ? condition : null;
      },
      clarifyCharge: { decisionId: key('dec', this.ctx.attempt.userId, this.ctx.attempt.turnId, 'proposal-decision') },
      clarify: async input2 => busyFact(input2.condition),
    });
    return this.finishCreate(input, outcome, {
      toolCallId: key('call', this.ctx.attempt.userId, this.ctx.attempt.turnId, 'proposal-create'),
      action: canonicalAction,
      decisionId: key('dec', this.ctx.attempt.userId, this.ctx.attempt.turnId, 'proposal-decision'),
    });
  }
  /**
   * The model-requested create. The single create entry point owns the
   * reservation, the dispatch and the outcome classification.
   */
  private async executeCreateV2(
    input: GraphInput,
    decision: CalendarDecision & { kind: 'tool' },
    native: Extract<SkillDecision, { kind: 'call_tool' }>,
  ): Promise<CalendarGraphPatch> {
    const cal = this.requireCalendar();

    const interpreted = readCalendarIntent(
      this.ctx.input,
      this.ctx.attempt,
      decision.call.arguments as CalendarCreateInput,
      this.effectiveTimeZone(),
    );

    if (interpreted.outcome === 'not-authorized') {
      this.setTask('denied', 'not-sent');
      diagnose(this.ctx.diagnostics?.emit, { stage: 'authority', state: 'rejected',
        reason: 'access-denied', code: 'OPERATION_AUTHORITY_REQUIRED', decisionId: decision.decisionId,
        tool: decision.call.name, origin: 'local', delivery: 'not-sent' });
      this.lastText = 'I did not create an event.';
      this.lastDecisionId = decision.decisionId;
      this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null });
      return this.seal(input);
    }
    if (interpreted.outcome === 'details') {
      this.setTask('clarification', 'not-sent');
      // The accepted request is missing material details. The runtime publishes
      // an explicitly incomplete proposal: it carries no action and no
      // canonical hash, so it can never be consumed. A complete proposal has to
      // supersede it before anything is scheduled.
      await this.publishIncompleteDetails(decision, interpreted.missing);
      this.lastText = 'Please provide the missing scheduling details.';
      this.lastDecisionId = decision.decisionId;
      this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null });
      return this.seal(input);
    }

    const candidate = decision.call.arguments as CalendarCreateInput;
    await this.emit({ type: 'calendar-progress', phase: 'executing' });
    const { calendarId: suggestedSelector, ...suggestedAction } = candidate;
    const needsConfirmation = interpreted.outcome === 'confirmation';
    const intent: AcceptedCalendarIntent = interpreted.outcome === 'complete' ? interpreted.intent : {
      intentId: calendarIntentId(this.ctx.input),
      originatingTurnId: this.ctx.attempt.turnId,
      originatingAcceptedMessageId: this.ctx.input.messageId,
      originatingAttemptId: this.ctx.attempt.attemptId,
      action: suggestedAction,
      selector: suggestedSelector ?? null,
    };
    const account = await this.resolveReadAccount();
    const userSelector = intent.selector;
    const modelSelector = (decision.call.arguments as CalendarCreateInput).calendarId ?? null;

    const resolved = await cal.capabilities.resolve({
      account,
      selector: userSelector,
      operation: 'create',
      signal: this.ctx.job.signal,
      deadlineAt: this.ctx.ledger.deadlineAt(),
      consumeRequest: kind => this.chargeProviderRequest(kind),
      consumeRefreshRequest: () => this.chargeRefreshRequest(),
    });

    const recordTerminal = (outcome: 'clarification' | 'denied' | 'failed' | 'cancelled' | 'interrupted') => {
      if (this.ctx.memory && !this.ctx.memory.stage.records().results.some(r => r.toolCallId === decision.toolCallId)) {
        this.ctx.memory.stage.putTerminalCall({
          decisionId: decision.decisionId,
          toolCallId: decision.toolCallId,
          outcome,
        });
      }
    };

    if (resolved.outcome === 'clarify') {
      let message = 'Which calendar would you like to use?';
      let proposalRecord: CalendarProposalRecord | null = null;
      if (resolved.code === 'CALENDAR_TARGET_AMBIGUOUS'
        || resolved.code === 'CALENDAR_TARGET_UNKNOWN'
        || resolved.code === 'CALENDAR_DEFAULT_UNAVAILABLE'
        || resolved.code === 'CALENDAR_PRIMARY_MISSING') {
        await this.ctx.memory?.mutation?.ensureAccepted({ pendingCreateDecisionId: decision.decisionId });
      }
      if (resolved.code === 'CALENDAR_TARGET_AMBIGUOUS') {
        const names = resolved.candidates.map(c => `"${c.calendarLabel}" (${c.calendarId})`).join(', ');
        message = `I found multiple calendars matching "${userSelector}": ${names}. Please clarify which one you would like to use.`;
        proposalRecord = await this.publishAndRecord({
          account,
          intent,
          purpose: 'selection',
          target: null,
          action: intent.action,
          candidates: resolved.candidates,
          conditionFingerprint: null,
          discoveryRevision: resolved.candidates[0]?.discoveryRevision ?? 1,
          availabilityRevision: null,
          retentionPolicyId: cal.permission.policyId,
          contentExpiresAt: await this.proposalContentExpiry(cal, account),
          limits: this.ctx.limits,
          clock: () => Date.parse(this.ctx.now()),
          proposals: this.ctx.persistence.calendarProposals,
          sessionId: this.ctx.attempt.sessionId,
        });
        this.lastProposalId = proposalRecord.proposalId;
        this.lastProposalRevision = proposalRecord.revision;
      } else if (resolved.code === 'CALENDAR_TARGET_UNKNOWN') {
        message = `I could not find a calendar matching "${userSelector}". Which calendar would you like to use?`;
        proposalRecord = await this.publishIncompleteSelection(account, intent);
      } else if (resolved.code === 'CALENDAR_DEFAULT_UNAVAILABLE') {
        message = 'Your configured default calendar is unavailable. Which calendar would you like to use?';
        proposalRecord = await this.publishIncompleteSelection(account, intent);
      } else if (resolved.code === 'CALENDAR_PRIMARY_MISSING') {
        message = 'No primary calendar was found. Which calendar would you like to use?';
        proposalRecord = await this.publishIncompleteSelection(account, intent);
      }
      if (needsConfirmation && proposalRecord?.purpose === 'selection' && !proposalRecord.incomplete) {
        message = this.clarificationText(proposalRecord, null);
        this.setTask('clarification', 'not-sent');
      }

      await this.emit({
        type: 'calendar-clarification',
        proposalId: proposalRecord?.proposalId ?? key('calendar-proposal', this.ctx.attempt.userId, this.ctx.attempt.sessionId, this.ctx.attempt.turnId),
        ...(proposalRecord ? { proposalRevision: proposalRecord.revision } : {}),
        expiresAt: proposalRecord?.expiresAt ?? new Date(Date.parse(this.ctx.now()) + 600000).toISOString(),
        reason: 'target',
        message,
        candidates: resolved.candidates.slice(0, 20).map(c => ({
          calendarId: c.calendarId,
          label: c.calendarLabel,
          role: c.accessRole,
        })),
        ...(this.view?.kind === 'proposal' ? { view: this.view } : {}),
      });

      this.lastText = message;
      this.lastDecisionId = decision.decisionId;
      this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null });
      recordTerminal('clarification');
      return this.seal(input);
    }

    if (resolved.outcome === 'denied') {
      this.setTask('denied', 'not-sent');
      diagnose(this.ctx.diagnostics?.emit, { stage: 'authority', state: 'rejected',
        reason: 'access-denied', code: resolved.code, decisionId: decision.decisionId,
        tool: decision.call.name, origin: 'local', delivery: 'not-sent' });
      let message = 'Permission to schedule on this calendar was denied.';
      if (resolved.code === 'CALENDAR_TARGET_READ_ONLY') {
        message = 'The selected calendar is read-only. Please choose a calendar where you have permission to create events.';
      } else if (resolved.code === 'CALENDAR_RECONNECT_REQUIRED') {
        message = 'Your Google Calendar connection needs to be reconnected.';
      }
      this.lastText = message;
      this.lastDecisionId = decision.decisionId;
      this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null });
      recordTerminal('failed');
      return this.seal(input);
    }

    const target = resolved.target;
    if (!needsConfirmation && modelSelector !== null && modelSelector !== target.calendarId) {
      recordTerminal('failed');
      return this.answerAndSeal(
        input,
        'The Calendar request is not allowed.',
        decision.decisionId,
      );
    }

    const canonicalAction = canonicalCalendarAction(needsConfirmation ? intent.action : candidate, target);
    if (needsConfirmation) {
      const prior = await this.ctx.persistence.calendarOperationsV2.findSucceededByRequestHash(
        this.ctx.attempt.userId, this.ctx.attempt.sessionId, calendarActionHash(canonicalAction));
      if (prior) {
        this.setTask('success', 'confirmed');
        this.lastOperationId = prior.operationId;
        this.lastIntentId = prior.intentId;
        await this.emitOperationState();
        recordTerminal('failed');
        return this.answerAndSeal(input, createdEventText(canonicalAction), decision.decisionId);
      }
      await this.ctx.memory?.mutation?.ensureAccepted({ pendingCreateDecisionId: decision.decisionId });
      await this.closeIncompleteProposal();
      // These are model-proposed details, not accepted authority. Only a later
      // reply to this exact saved disclosure may authorize the canonical action.
      const proposal = await this.publishAndRecord({
        account, intent, purpose: 'details', target, action: canonicalAction,
        candidates: [], conditionFingerprint: null, disclosedLimitations: [],
        discoveryRevision: target.discoveryRevision, availabilityRevision: null,
        retentionPolicyId: cal.permission.policyId,
        contentExpiresAt: await this.proposalContentExpiry(cal, account),
        limits: this.ctx.limits, clock: () => Date.parse(this.ctx.now()),
        proposals: this.ctx.persistence.calendarProposals, sessionId: this.ctx.attempt.sessionId,
      });
      this.lastProposalId = proposal.proposalId;
      this.lastProposalRevision = proposal.revision;
      this.lastIntentId = proposal.intentId;
      this.setTask('clarification', 'not-sent');
      const message = this.clarificationText(proposal, null);
      await this.emit({ type: 'calendar-clarification', proposalId: proposal.proposalId,
        proposalRevision: proposal.revision,
        expiresAt: proposal.expiresAt, reason: 'details', message: message.slice(0, 1000), candidates: [],
        ...(this.view?.kind === 'proposal' ? { view: this.view } : {}) });
      recordTerminal('clarification');
      return this.answerAndSeal(input, message, decision.decisionId);
    }
    await this.ctx.memory?.mutation?.ensureAccepted({ pendingCreateDecisionId: decision.decisionId });
    if (!this.ctx.memory || this.ctx.memory.pendingProposal !== null) {
      await this.closeIncompleteProposal();
    }
    const operationId = key('calendar-operation', this.ctx.attempt.userId, this.ctx.attempt.sessionId, intent.intentId);
    const requestHash = calendarActionHash(canonicalAction);
    const nowIso = this.ctx.now();
    const auditCap = Date.parse(nowIso) + 2592000000;
    const auditExpiresAt = new Date(cal.auditDeadlineAt ? Math.min(Date.parse(cal.auditDeadlineAt), auditCap) : auditCap).toISOString();

    const outcome = await this.writer().executeCreate({
      intent,
      account,
      target,
      accepted: { message: this.ctx.input, turnId: this.ctx.attempt.turnId },
      proposal: null,
      consumption: null,
      action: canonicalAction,
      requestHash,
      operationId,
      decisionId: decision.decisionId,
      toolCallId: decision.toolCallId,
      createdAt: nowIso,
      auditExpiresAt,
      capability: input2 => this.freshCapability(input2),
      preflight: input2 => this.freshPreflight({
        action: input2.action, target: input2.target, intentId: intent.intentId,
        decisionId: decision.decisionId, stage: 'direct-create',
      }),
      clarifyCharge: { decisionId: decision.decisionId },
      clarify: async input2 => {
        const published = await this.publishConflict({
          intent, target: input2.target, action: input2.action, condition: input2.condition,
          requestHash, account,
        });
        return published;
      },
    });
    const sealed = await this.finishCreate(input, outcome, {
      toolCallId: decision.toolCallId, action: canonicalAction, decisionId: decision.decisionId, native,
    });
    if (sealed) return sealed;
    this.cursor = calendarCursorSchema.parse({
      ...this.cursor, next: 'decide', pendingDecisionId: null, repair: null,
    });
    return { calendarCursor: this.cursor, calendarRefs: this.refs() };
  }

  /**
   * Applies the outcome of the single create entry point. A created event
   * becomes one complete tool group; a clarification, a failure and an unknown
   * outcome become one bounded assistant answer.
   */
  private async finishCreate(
    input: GraphInput,
    outcome: CalendarCreateOutcome,
    context: { toolCallId: string; action: CalendarCreateInput; decisionId: string;
      native?: Extract<SkillDecision, { kind: 'call_tool' }> },
  ): Promise<CalendarGraphPatch | null> {
    if (this.ctx.memory && !this.ctx.memory.stage.records().results.some(r => r.toolCallId === context.toolCallId)
      && outcome.outcome !== 'created' && outcome.outcome !== 'existing') {
      this.ctx.memory.stage.putTerminalCall({
        decisionId: context.decisionId,
        toolCallId: context.toolCallId,
        outcome: outcome.outcome === 'clarify' ? 'clarification' : outcome.outcome === 'unknown' ? 'interrupted' : outcome.outcome,
      });
    }
    if (outcome.outcome === 'created') {
      this.setTask('success', 'confirmed');
      this.lastOperationId = outcome.operation.operationId;
      this.lastIntentId = outcome.operation.intentId;
      this.lastProposalId = outcome.operation.authorization.proposalId;
      if (outcome.source.permission.content === 'volatile') {
        this.volatileSourceIds.add(outcome.source.sourceId);
      }
      const resultRecord = calendarToolResultRecordV2Schema.parse({
        schemaVersion: 2, kind: 'calendar-tool-result',
        userId: this.ctx.attempt.userId, sessionId: this.ctx.attempt.sessionId, turnId: this.ctx.attempt.turnId,
        attemptId: this.ctx.attempt.attemptId, decisionId: context.decisionId,
        eventId: key('calendar-tool-result-event', this.ctx.attempt.userId, context.toolCallId),
        sequence: this.groups.length, toolCallId: context.toolCallId, createdAt: this.ctx.now(),
        resultRef: outcome.source.permission.content === 'retained'
          ? { storage: 'retained', source: outcome.source, toolCallId: context.toolCallId,
            operationId: outcome.operation.operationId, result: outcome.result }
          : { storage: 'reference', source: outcome.source, toolCallId: context.toolCallId,
            operationId: outcome.operation.operationId, outcome: 'ok' },
      });
      if (this.ctx.memory?.mutation?.onMutation) {
        const projected = projectConfirmedCalendarTurnState({
          operation: outcome.operation,
          eventDurable: Boolean(outcome.event && outcome.event.state === 'succeeded'
            && outcome.event.sequence === outcome.operation.sequence
            && outcome.event.revision === outcome.operation.revision),
          attempt: this.ctx.attempt,
          retryAction: 'none',
          now: Date.parse(this.ctx.now()),
        });
        this.captureView(projectOutcomeView(projected));
        await this.emit({ type: 'calendar-operation', operation: projected });
        const decisionRecord = this.ctx.memory.stage.records().decisions
          .find(d => d.decisionId === context.decisionId) ?? null;
        this.ctx.memory.mutation.onMutation({
          operationId: outcome.operation.operationId,
          decision: decisionRecord,
          result: resultRecord,
        });
      } else {
        // The write and matching success event are already durable. Publish the
        // receipt now; retention/result/checkpoint work still gates turn completion.
        await this.emitOperationState();
        await this.ctx.persistence.calendarRetention.registerSource({
          userId: this.ctx.attempt.userId, sessionId: this.ctx.attempt.sessionId, source: outcome.source,
        });
        await this.ctx.persistence.calendarResultsV2.put(resultRecord);
      }
      if (context.native) {
        this.groups.push(skillGroup(context.native, JSON.stringify(outcome.result), [outcome.source]));
      }
      // The durable API receipt is authoritative. Never ask the model to
      // narrate or repeat a successful write, even after a model tool call.
      this.lastText = createdEventText(context.action);
      this.lastDecisionId = context.decisionId;
      this.cursor = calendarCursorSchema.parse({
        ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null,
      });
      for (let offset = 0; offset < this.lastText.length; offset += 1000) {
        await this.emit({ type: 'delta', text: this.lastText.slice(offset, offset + 1000) });
      }
      return this.seal(input);
    }

    if (outcome.outcome === 'existing') {
      this.setTask('success', 'confirmed');
      this.lastOperationId = outcome.operation.operationId;
      this.lastIntentId = outcome.operation.intentId;
      this.lastText = outcome.operation.action
        ? createdEventText(outcome.operation.action)
        : outcome.message;
      this.lastDecisionId = context.decisionId;
      this.cursor = calendarCursorSchema.parse({
        ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null,
      });
      await this.emitOperationState();
      for (let offset = 0; offset < this.lastText.length; offset += 1000) {
        await this.emit({ type: 'delta', text: this.lastText.slice(offset, offset + 1000) });
      }
      return this.seal(input);
    }

    // A changed preflight can still need a conversational clarification before
    // any write. Actual write outcomes are authoritative and never go to the LLM.
    if (this.dispatchIds.length === 0 && outcome.outcome === 'clarify') {
      this.setTask('clarification', 'not-sent');
      this.modelNote = handoffNote(outcome.message);
      return null;
    }

    if (outcome.outcome === 'clarify') {
      this.setTask('clarification', 'not-sent');
      this.lastText = outcome.message;
      const proposal = this.lastProposalId
        ? await this.ctx.persistence.calendarProposals.getCurrent(
            this.ctx.attempt.userId, this.ctx.attempt.sessionId)
        : null;
      if (proposal) {
        const reason = proposal.purpose === 'selection' ? 'target'
          : proposal.purpose === 'details' ? 'details'
          : proposal.disclosedLimitations.length > 0 ? 'coverage' : 'conflict';
        await this.emit({
          type: 'calendar-clarification',
          proposalId: proposal.proposalId,
          proposalRevision: proposal.revision,
          expiresAt: proposal.expiresAt,
          reason,
          message: outcome.message.slice(0, 1000),
          candidates: proposal.candidates.slice(0, 20).map(c => ({
            calendarId: c.target.calendarId,
            label: c.target.calendarLabel,
            role: c.target.accessRole,
          })),
          ...(this.view?.kind === 'proposal' ? { view: this.view } : {}),
        });
      }
    } else {
      this.setTask(outcome.outcome === 'failed' ? 'failed' : 'uncertain',
        outcome.outcome === 'failed' ? 'not-sent' : 'unknown');
      this.lastOperationId = outcome.operation.operationId;
      this.lastIntentId = outcome.operation.intentId;
      this.lastText = outcome.message;
    }
    this.lastDecisionId = context.decisionId;
    this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal', pendingDecisionId: null, repair: null });
    if (outcome.outcome !== 'clarify') await this.emitOperationState();
    return this.seal(input);
  }

  /**
   * The durable operation state is always projected through the publication
   * projection, so the receipt rules are the single source of truth.
   */
  private async emitOperationState(): Promise<void> {
    const projected = await projectCalendarTurnStateCompatible(
      this.ctx.persistence, this.ctx.attempt.userId, this.ctx.attempt.sessionId, this.ctx.attempt.turnId,
      Date.parse(this.ctx.now()));
    if (!projected) return;
    if ('schemaVersion' in projected) {
      this.captureView(projectOutcomeView(projected));
      await this.emit({ type: 'calendar-operation', operation: projected });
      return;
    }
    await this.emit({ type: 'calendar-operation', operation: projected });
  }
  private async resolveReadAccount(): Promise<CalendarAccountBinding> {
    if (this.invalidatedRead) throw toolFault('policy', 'CALENDAR_EXECUTION_DENIED');
    const current = this.account();
    if (!this.ctx.memory) return current;
    const resolved = await this.ctx.memory.readAccount();
    if (this.invalidatedRead) throw toolFault('policy', 'CALENDAR_EXECUTION_DENIED');
    if (current.connectionId !== 'memory-unbound' && !isDeepStrictEqual(current, resolved)) {
      throw new AppError('NOT_READY', 'Calendar access has changed.', false);
    }
    this.resolvedReadAccount = resolved;
    this.ctx.binding = { ...this.ctx.binding, ...resolved };
    this.cursor = calendarCursorSchema.parse({
      ...this.cursor,
      connectionId: resolved.connectionId,
      connectionRevision: resolved.connectionRevision,
      accountSubjectId: resolved.googleSubjectId,
    });
    this.ctx.memory.stage.bindConnection(resolved.connectionId, resolved.connectionRevision);
    return resolved;
  }

  private async executeReadV2(
    input: GraphInput,
    decision: CalendarDecision & { kind: 'tool' },
    native: Extract<SkillDecision, { kind: 'call_tool' }>,
  ): Promise<CalendarGraphPatch> {
    const cal = this.requireCalendar();
    const ledger = this.ctx.memory ? this.ctx.ledger : this.durableLedger();
    await this.emit({ type: 'calendar-progress', phase: 'executing' });
    const readTool = decision.call.name === 'calendar_create_event' ? null : decision.call.name;
    const readSelector = (decision.call.arguments as { calendarId?: string }).calendarId ?? null;
    const markTerminal = (outcome: 'denied' | 'clarification' | 'failed' | 'cancelled' | 'interrupted') => {
      if (this.ctx.memory && !this.ctx.memory.stage.records().results.some(r => r.toolCallId === decision.toolCallId)) {
        try {
          this.ctx.memory.stage.putTerminalCall({
            decisionId: decision.decisionId, toolCallId: decision.toolCallId, outcome,
          });
        } catch {
          // Preserve primary failure or interruption if stage is already bounded.
        }
      }
    };
    let recorded = false;
    try {
      const account = await this.resolveReadAccount();
      // One model-requested logical tool call, debited against the model
      // decision so an exact repeat of the same decision moves no counter.
      await ledger.chargeLogicalTool(decision.decisionId);
      const needsTarget = decision.call.name === 'calendar_list_events' || decision.call.name === 'calendar_get_event';
      if (!needsTarget) await cal.connection.requireAccountCurrent(account, this.ctx.job.signal, { fresh: false });
      const resolved = !needsTarget ? { outcome: 'resolved' as const, target: null } : await cal.capabilities.resolve({
        account,
        selector: readSelector,
        operation: 'read',
        signal: this.ctx.job.signal,
        deadlineAt: this.ctx.ledger.deadlineAt(),
        consumeRequest: kind => this.chargeProviderRequest(kind),
        consumeRefreshRequest: () => ledger.chargeRefreshRequest(),
      });
      if (this.invalidatedRead) throw toolFault('policy', 'CALENDAR_EXECUTION_DENIED');
      if (resolved.outcome !== 'resolved') {
        // An unknown, ambiguous or unauthorized selector is a bounded
        // clarification, never a provider error or a failed user request.
        if (resolved.outcome === 'denied') {
          this.setTask('denied');
          diagnose(this.ctx.diagnostics?.emit, { stage: 'authority', state: 'rejected',
            reason: 'access-denied', code: resolved.code, decisionId: decision.decisionId,
            tool: decision.call.name, origin: 'local', delivery: 'not-sent' });
          const message = messageForCalendarFailure({ category: 'policy', code: resolved.code, retry: 'none' });
          this.captureView(calendarNotice('unavailable', message, { tool: readTool }));
          markTerminal('denied');
          recorded = true;
          return await this.answerAndSeal(input, message, decision.decisionId);
        }
        this.setTask('clarification', 'not-sent');
        const message = resolved.candidates.length > 0
          ? `Which calendar should I use? ${resolved.candidates
            .map(candidate => candidate.calendarLabel ?? candidate.calendarId).join(' or ')}.`
          : 'Which calendar should I use?';
        this.captureView(calendarNotice('clarification', message, { tool: readTool }));
        markTerminal('clarification');
        recorded = true;
        return await this.answerAndSeal(input, message, decision.decisionId);
      }
      const binding: CalendarExecutionBindingV2 = {
        ...account,
        target: resolved.target,
        operation: null,
        sessionId: this.ctx.attempt.sessionId,
        turnId: this.ctx.attempt.turnId,
        attemptId: this.ctx.attempt.attemptId,
        decisionId: decision.decisionId,
        toolCallId: decision.toolCallId,
        schemaRevision: 'google-calendar.v2',
        trustedNow: this.ctx.now(),
        trustedTimeZone: this.effectiveTimeZone(),
        deadlineAt: this.ctx.ledger.deadlineAt(),
      };
      const invoked = await cal.execution.invoke({
        binding,
        call: decision.call,
        signal: this.ctx.job.signal,
        consumeRequest: async kind => {
          await this.chargeProviderRequest(kind);
        },
        consumeRefreshRequest: async () => {
          await ledger.chargeRefreshRequest();
        },
      });
      if (this.invalidatedRead) throw toolFault('policy', 'CALENDAR_EXECUTION_DENIED');
      if (invoked.outcome !== 'success') {
        if (invoked.failure.category === 'clarification' && invoked.failure.code === 'CALENDAR_INPUT_REJECTED') {
          const diagnostics: CalendarRepairDiagnostics = [{
            path: 'pageToken' in decision.call.arguments ? 'pageToken' : 'tool_calls.arguments',
            code: 'invalid-value', expected: 'bounded-value',
          }];
          await this.recordLocal(native, skillError('ARGUMENTS_INVALID', native.envelope.plugin,
            native.envelope.tool, diagnostics));
          recorded = true;
          return await this.repairOrSeal(input, native.decisionId, diagnostics);
        }
        markTerminal(invoked.failure.category === 'cancelled' ? 'cancelled'
          : (invoked.failure.category === 'policy' || invoked.failure.category === 'credential') ? 'denied'
          : invoked.failure.category === 'clarification' ? 'clarification' : 'failed');
        recorded = true;
        return await this.failConversationally(input, invoked.failure, decision.decisionId, decision.call.name);
      }
      await this.recordResult(decision, invoked, native);
      recorded = true;
      const agenda = projectAgendaView(decision.call, invoked.result, invoked.source, this.effectiveTimeZone());
      if (agenda) this.captureView(agenda);
      else if (invoked.result.tool === 'calendar_check_availability') {
        const r = invoked.result;
        const message = r.coverage === 'complete'
          ? (r.conflict === 'conflict' ? 'Availability checked: conflict found.' : 'Availability checked: time is free.')
          : 'Availability checked across active calendars.';
        this.captureView(calendarNotice('read-completed', message, { tool: r.tool, coverage: r.coverage,
          conflict: r.conflict, limitations: r.limitations }));
      } else if (invoked.result.tool === 'calendar_list_calendars') {
        const r = invoked.result;
        this.captureView(calendarNotice('read-completed', `${r.calendars.length} calendars returned${r.truncated || !r.complete
          ? '; more or unavailable calendars may exist' : ''}.`, { tool: r.tool,
          coverage: r.complete ? 'complete' : 'incomplete', limitations: r.limitations }));
      }
      this.cursor = calendarCursorSchema.parse({
        ...this.cursor, next: 'decide', pendingDecisionId: null, repair: null,
      });
      return { calendarCursor: this.cursor, calendarRefs: this.refs() };
    } catch (error) {
      if (!recorded) {
        if (error instanceof CalendarToolFault) {
          markTerminal(error.failure.category === 'cancelled' ? 'cancelled'
            : (error.failure.category === 'policy' || error.failure.category === 'credential') ? 'denied'
            : error.failure.category === 'clarification' ? 'clarification' : 'failed');
          return await this.failConversationally(input, error.failure, decision.decisionId, decision.call.name);
        }
        markTerminal(this.ctx.job.signal.aborted || (error instanceof AppError && error.code === 'CANCELLED')
          ? 'cancelled'
          : error instanceof AppError && error.code === 'INTERRUPTED' ? 'interrupted' : 'failed');
      }
      throw error;
    }
  }

  async seal(input: GraphInput): Promise<CalendarGraphPatch> {
    const run = async (): Promise<CalendarGraphPatch> => {
    const blockedBeforeSeal = await this.revalidateActiveSources(input);
    if (blockedBeforeSeal) return blockedBeforeSeal;
    if (!this.lastText.trim()) {
      throw new AppError('PROVIDER_ERROR', 'The model returned an empty answer. Please try again.', false);
    }
    if (this.dispatchIds.length) await this.ctx.ledger.aggregate();
    const assistantFields = { ...(this.ctx.input.mode ? { mode: this.ctx.input.mode } : {}),
      ...(this.ctx.input.visibility ? { visibility: this.ctx.input.visibility } : {}),
      ...(this.ctx.input.voiceSessionId ? { voiceSessionId: this.ctx.input.voiceSessionId } : {}),
      ...(this.ctx.assistantFields?.() ?? {}) };
    const assistant: MessageRecord = {
      schemaVersion: 1, userId: this.ctx.attempt.userId, sessionId: this.ctx.attempt.sessionId,
      turnId: this.ctx.attempt.turnId, attemptId: this.ctx.attempt.attemptId,
      messageId: outputId(this.ctx.attempt),
      eventId: eventIdFor(this.ctx.attempt.userId, this.ctx.attempt.sessionId, outputId(this.ctx.attempt)),
      sequence: this.ctx.assistantSequence, role: 'assistant', content: this.lastText,
      createdAt: this.ctx.now(), completionStatus: 'streaming', truncated: false,
      ...assistantFields,
      ...(this.view ? { calendarView: this.view } : {}),
      ...(this.weather ? { weatherView: this.weather } : {}),
    };
    bounded(messageRecordSchema, assistant, key('message', assistant.userId, assistant.sessionId, assistant.messageId),
      this.ctx.snapshot.budgets.maxMessageBytes);
    const history = this.ctx.memory?.records ?? await this.ctx.persistence.messages.getReferences(
      this.ctx.attempt.userId, this.ctx.attempt.sessionId, this.ctx.manifest.messageRefs);
    const target = buildReferenceManifest(this.ctx.attempt.userId, this.ctx.attempt.sessionId,
      this.ctx.manifest.contextVersion + 1,
      [...history.filter(m => m.messageId !== this.ctx.input.messageId), this.ctx.input,
        { ...assistant, completionStatus: this.truncated ? 'truncated' : 'completed', truncated: this.truncated }],
      this.ctx.assets, this.ctx.persistence.memory.budgets,
      this.ctx.manifest.activeSummaryRef, this.ctx.manifest.pinnedUserMemory);
    if (!this.ctx.memory && !this.textDecisionId && !this.lastProposalId) {
      const decisionId = key('calendar-local-narration', this.ctx.attempt.userId,
        this.ctx.attempt.sessionId, this.ctx.attempt.attemptId);
      const sources = this.provenance().filter(source => source.schemaVersion === 2);
      await this.ctx.persistence.skillDecisions.put(resumableSkillDecisionSchema.parse({
        schemaVersion: 3, protocolVersion: 'plugin-skills.v1', kind: 'calendar-model-decision',
        userId: this.ctx.attempt.userId, sessionId: this.ctx.attempt.sessionId, turnId: this.ctx.attempt.turnId,
        attemptId: this.ctx.attempt.attemptId, decisionId,
        dispatchId: this.dispatchIds.at(-1) ?? key('calendar-local-dispatch-ref', this.ctx.attempt.attemptId),
        configRevision: this.ctx.snapshot.revision, connectionId: this.ctx.binding.connectionId,
        connectionRevision: this.ctx.binding.connectionRevision, schemaRevision: 'google-calendar.v2',
        rejectedDecisionId: null, sources,
        decision: sources.some(source => source.permission.content === 'volatile') ? null
          : { kind: 'text', decisionId, content: this.lastText, truncated: this.truncated },
        operationId: this.lastOperationId, intentId: this.lastIntentId, proposalId: this.lastProposalId,
        createdAt: this.ctx.attempt.createdAt,
      }));
      this.textDecisionId = decisionId;
    }
    const narrationRef = this.textDecisionId
      ? { kind: 'text-decision' as const, decisionId: this.textDecisionId }
      : this.lastProposalId
      ? { kind: 'proposal-message' as const, proposalId: this.lastProposalId,
          proposalRevision: this.lastProposalRevision }
      : { kind: 'text-decision' as const,
          decisionId: this.lastDecisionId ?? this.dispatchIds.at(-1) ?? dispatchFallback(this.ctx.attempt.attemptId) };
    const seal = calendarSealSchema.parse({
      version: 2, input, base: boundaryFor(this.ctx.manifest), target,
      narrationRef,
      dispatchIds: this.dispatchIds, operationId: this.lastOperationId, outcome: this.truncated ? 'truncated' : 'completed',
      assistantCreatedAt: assistant.createdAt,
      ...(this.view ? { view: this.view } : {}),
      ...(this.weather ? { weatherView: this.weather } : {}),
      assistantFields,
    });
    this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'seal' });
    return { calendarCursor: this.cursor, calendarSeal: seal, calendarRefs: this.refs() };
    };
    return this.ctx.diagnostics ? this.ctx.diagnostics.run({ databasePhase: 'seal' }, run) : run();
  }
}

function dispatchFallback(attemptId: string) {
  return key('calendar-final', attemptId);
}

/** Receipt text for a proposal-authorized create. The model does not narrate it. */
function createdEventText(action: CalendarCreateInput): string {
  return `Created "${action.summary}" from ${action.start} to ${action.end} (${action.timeZone}).`;
}

/** Facts for a busy preflight after the user already confirmed the event. */
function busyFact(condition: CalendarAvailabilityResult): string {
  const busy = condition.busy.slice(0, 4)
    .map(interval => `${interval.start} to ${interval.end}`);
  return busy.length > 0
    ? `No Calendar event was created. The requested time overlaps busy periods (${busy.join('; ')}).`
    : 'No Calendar event was created. The requested time is not free.';
}

/** Hidden instruction so the model can explain a failed or busy create. */
function handoffNote(detail: string): string {
  return `${detail} Explain this to the user and ask what they want to do instead. `
    + 'Do not claim the event was created.';
}
