/**
 * ============================================================================
 * FILE: protocol.ts
 * LOCATION: frontend/src/api/protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define client-safe API and SSE types with strict runtime guards.
 *
 * ROLE IN PROJECT:
 *    Mirrors backend resource and stream contracts without importing server
 *    configuration, persistence models, provider details, or secrets.
 *
 * KEY COMPONENTS:
 *    - API_ROUTES / protocol types: Shared paths and browser-safe payloads.
 *    - Request guards: Reject client identity, model, and credential overrides.
 *    - SSE parsing: Validate untrusted frames against the versioned protocol.
 * ============================================================================
 */

import {
  isCalendarTurnState,
  isCalendarView,
  type CalendarTurnState,
  type CalendarView,
} from './calendar-protocol.ts'
import {
  isCanvasArtifactId,
  isCanvasArtifactProjectionList,
  type CanvasArtifactProjection,
} from './voice-protocol.ts'
import {
  isWebSearchActivity,
  isWebSearchActivityList,
  isWebSourceReferenceList,
  type WebSearchActivity,
  type WebSourceReference,
} from './web-search-protocol.ts'
import { isWeatherView, type WeatherView } from './weather-protocol.ts'

export type { CanvasArtifactProjection }

export const STREAM_PROTOCOL_VERSION = 1
export const API_PROTOCOL_VERSION = 1

export const API_ROUTES = {
  sessions: '/sessions',
  session: (sessionId: string) => `/sessions/${sessionId}`,
  messages: (sessionId: string) => `/sessions/${sessionId}/messages`,
  turns: (sessionId: string) => `/sessions/${sessionId}/turns`,
  turnStatus: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}`,
  turnStream: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}/stream`,
  cancelTurn: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}/cancel`,
  retryTurn: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}/retry`,
  retrySave: (sessionId: string, turnId: string) =>
    `/sessions/${sessionId}/turns/${turnId}/retry-save`,
} as const

export const ATTEMPT_STATUSES = [
  'accepted',
  'generating',
  'finalizing',
  'completed',
  'truncated',
  'failed',
  'cancelled',
  'interrupted',
] as const

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]

export type ClientErrorBody = {
  code: string
  message: string
  retryable: boolean
}

export type SubmitTurnRequest = {
  sessionId: string | null
  content: string
  idempotencyKey: string
  ephemeral?: boolean
  expectedEpoch?: string
  calendarProtocol?: 2
  calendarReplyTo?: { proposalId: string; revision: number }
}

export type SubmitTurnResponse = {
  sessionId: string
  turnId: string
  attemptId: string
  userMessageId: string
  streamPath: string
  processEpoch?: string
}

export type RetryTurnRequest = {
  idempotencyKey: string
  expectedEpoch?: string
  calendarProtocol?: 2
}

export type SessionSummary = {
  pinned?: boolean
  ephemeral?: boolean
  sessionId: string
  title: string
  createdAt: string
  lastActivityAt: string
}

export type ListSessionsResponse = {
  items: SessionSummary[]
  nextCursor: string | null
}

export type VoiceTranscriptItem = {
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
  canvasArtifacts?: CanvasArtifactProjection[]
  messageId?: string
  turnId?: string
  calendarView?: CalendarView
  weatherView?: WeatherView
  webSources?: WebSourceReference[]
  webActivities?: WebSearchActivity[]
}

export type VisibleMessage = {
  messageId: string
  turnId: string
  eventId: string
  sequence: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  completionStatus:
    | 'accepted'
    | 'streaming'
    | 'completed'
    | 'truncated'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
  truncated: boolean
  visibility?: 'visible' | 'internal'
  mode?: 'text' | 'live'
  voiceSessionId?: string
  voiceDurationSeconds?: number
  voiceTranscripts?: VoiceTranscriptItem[]
  canvasArtifacts?: CanvasArtifactProjection[]
  calendarView?: CalendarView
  weatherView?: WeatherView
  webSources?: WebSourceReference[]
  webActivities?: WebSearchActivity[]
  memoryUpdated?: boolean
}

export type ActiveSessionTurn = {
  turnId: string
  attemptId: string
  status: 'accepted' | 'generating' | 'finalizing'
  mode: 'text' | 'live'
}

export type CompactionCheckpointMeta = {
  compactedThroughSequence: number
  compactionCycle: number
  summaryPreview?: string
}

export type ContextUsageMeta = {
  historyTokens: number
  maxHistoryTokens: number
  utilizationPercent: number
  status: 'idle' | 'compacting'
}

export type ListMessagesResponse = {
  items: VisibleMessage[]
  nextCursor: string | null
  olderAvailable: boolean
  canvasMessages?: VisibleMessage[]
  save?: SaveStateSnapshot
  saveTurnId?: string
  activeTurn?: ActiveSessionTurn
  compaction?: CompactionCheckpointMeta
  contextUsage?: ContextUsageMeta
}
export type SaveStateSnapshot = {
  state: 'pending' | 'saving' | 'saved' | 'failed' | 'unknown' | 'fenced'
  epoch: string
  version: number
  durableVersion: number
}

export type TurnStatusResponse = {
  sessionId: string
  turnId: string
  attemptId: string
  status: AttemptStatus
  truncated: boolean
  error: ClientErrorBody | null
  calendar?: CalendarTurnState
  save?: SaveStateSnapshot
}

export type StreamEvent =
  | { type: 'turn-accepted'; userMessageId: string }
  | { type: 'delta'; text: string; reset?: true }
  | { type: 'status'; status: AttemptStatus; truncated: boolean; save?: SaveStateSnapshot }
  | {
      type: 'usage'
      accountingStatus: 'known' | 'pending' | 'unknown'
      promptTokens: number | null
      completionTokens: number | null
      cost: number | null
    }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | {
      type: 'completed'
      assistantMessageId: string
      outcome: 'completed' | 'truncated'
      save?: SaveStateSnapshot
      calendarView?: CalendarView
      weatherView?: WeatherView
      webSources?: WebSourceReference[]
      webActivities?: WebSearchActivity[]
      compaction?: CompactionCheckpointMeta
      contextUsage?: ContextUsageMeta
      memoryUpdated?: boolean
    }
  | {
      type: 'context-state'
      compaction?: CompactionCheckpointMeta
      contextUsage: ContextUsageMeta
    }
  | { type: 'web-activity'; activity: WebSearchActivity }
  | { type: 'web-sources'; sources: WebSourceReference[] }
  | { type: 'weather-view'; view: WeatherView }

export type StreamEnvelope = {
  protocolVersion: 1
  sessionId: string
  turnId: string
  attemptId: string
  sequence: number
  event: StreamEvent
}

const OVERRIDE_KEYS = [
  'userId',
  'user',
  'openRouterUser',
  'model',
  'modelId',
  'apiKey',
  'calendarId',
  'accountId',
  'connectionId',
  'googleSubjectId',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'authorization',
  'serviceUrl',
] as const

const APP_ERROR_CODES = [
  'INVALID_REQUEST',
  'UNKNOWN_FIELD',
  'IDENTITY_OVERRIDE_REJECTED',
  'MODEL_OVERRIDE_REJECTED',
  'NOT_FOUND',
  'CONFLICT_ACTIVE_TURN',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
  'CONTEXT_BUDGET_EXCEEDED',
  'INPUT_TOO_LARGE',
  'STORAGE_BUDGET_EXCEEDED',
  'RATE_LIMITED',
  'CONCURRENCY_LIMIT',
  'TIMEOUT',
  'PROVIDER_ERROR',
  'PROVIDER_AUTH',
  'PROVIDER_CREDITS',
  'CANCELLED',
  'INTERRUPTED',
  'PERSISTENCE_ERROR',
  'CONFIGURATION_ERROR',
  'NOT_READY',
  'UNSUPPORTED_TOPOLOGY',
] as const

const OVERRIDE_MESSAGE = 'Identity, model, and API keys cannot be supplied by the client.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isVisibleMessageCanvasArtifacts(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!Object.hasOwn(value, 'canvasArtifacts')) return true
  return (
    value.role === 'assistant' &&
    value.mode === 'live' &&
    isCanvasArtifactId(value.voiceSessionId) &&
    isCanvasArtifactProjectionList(value.canvasArtifacts)
  )
}

const VISIBLE_COMPLETION_STATUSES = [
  'accepted', 'streaming', 'completed', 'truncated', 'failed', 'cancelled', 'interrupted',
] as const

function hasValidWebProvenance(value: Record<string, unknown>): boolean {
  if (!('webSources' in value) && !('webActivities' in value)) return true
  if (value.role !== 'assistant') return false
  return (
    (!('webSources' in value) || isWebSourceReferenceList(value.webSources)) &&
    (!('webActivities' in value) || isWebSearchActivityList(value.webActivities))
  )
}

function hasValidWeatherView(value: Record<string, unknown>): boolean {
  if (!('weatherView' in value) || value.weatherView === undefined) return true
  return value.role === 'assistant' && isWeatherView(value.weatherView)
}

function hasValidMemoryUpdated(value: Record<string, unknown>): boolean {
  if (!('memoryUpdated' in value) || value.memoryUpdated === undefined) return true
  return value.role === 'assistant' && typeof value.memoryUpdated === 'boolean'
}

export function isVoiceTranscriptItem(value: unknown): value is VoiceTranscriptItem {
  return (
    isRecord(value) &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    hasValidWebProvenance(value) &&
    hasValidWeatherView(value)
  )
}

export function isVisibleMessage(value: unknown): value is VisibleMessage {
  return (
    isRecord(value) &&
    isBoundedId(value.messageId) &&
    isBoundedId(value.turnId) &&
    isBoundedId(value.eventId) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.completionStatus === 'string' &&
    (VISIBLE_COMPLETION_STATUSES as readonly string[]).includes(value.completionStatus) &&
    typeof value.truncated === 'boolean' &&
    hasValidWebProvenance(value) &&
    hasValidWeatherView(value) &&
    hasValidMemoryUpdated(value)
  )
}

export function isVisibleMessageList(value: unknown): value is VisibleMessage[] {
  return Array.isArray(value) && value.every(isVisibleMessage)
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  )
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
}
function isSaveStateSnapshot(value: unknown): value is SaveStateSnapshot {
  return isRecord(value) && hasExactKeys(value, ['state', 'epoch', 'version', 'durableVersion']) &&
    ['pending', 'saving', 'saved', 'failed', 'unknown', 'fenced'].includes(value.state as string) &&
    isBoundedId(value.epoch) && typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version >= 0 &&
    typeof value.durableVersion === 'number' && Number.isSafeInteger(value.durableVersion) && value.durableVersion >= 0
}

const DISALLOWED_PREVIEW_TAGS = /<\/?(?:analysis|calendar_context)\b/i

export function isCompactionCheckpointMeta(value: unknown): value is CompactionCheckpointMeta {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'compactedThroughSequence',
      'compactionCycle',
      ...('summaryPreview' in value ? ['summaryPreview'] : []),
    ]) &&
    typeof value.compactedThroughSequence === 'number' &&
    Number.isSafeInteger(value.compactedThroughSequence) &&
    value.compactedThroughSequence >= 0 &&
    typeof value.compactionCycle === 'number' &&
    Number.isSafeInteger(value.compactionCycle) &&
    value.compactionCycle > 0 &&
    (!('summaryPreview' in value) ||
      (typeof value.summaryPreview === 'string' &&
        value.summaryPreview.length <= 500 &&
        !DISALLOWED_PREVIEW_TAGS.test(value.summaryPreview)))
  )
}

export function isContextUsageMeta(value: unknown): value is ContextUsageMeta {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['historyTokens', 'maxHistoryTokens', 'utilizationPercent', 'status']) &&
    typeof value.historyTokens === 'number' &&
    Number.isSafeInteger(value.historyTokens) &&
    value.historyTokens >= 0 &&
    typeof value.maxHistoryTokens === 'number' &&
    Number.isSafeInteger(value.maxHistoryTokens) &&
    value.maxHistoryTokens > 0 &&
    typeof value.utilizationPercent === 'number' &&
    Number.isFinite(value.utilizationPercent) &&
    value.utilizationPercent >= 0 &&
    (value.status === 'idle' || value.status === 'compacting')
  )
}

function isAttemptStatus(value: unknown): value is AttemptStatus {
  return (
    typeof value === 'string' &&
    (ATTEMPT_STATUSES as readonly string[]).includes(value)
  )
}

function isNullableNonnegativeInteger(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  )
}

function isNullableNonnegativeNumber(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  )
}

function isAppErrorCode(value: unknown): value is (typeof APP_ERROR_CODES)[number] {
  return (
    typeof value === 'string' &&
    (APP_ERROR_CODES as readonly string[]).includes(value)
  )
}

export function assertNoClientOverrides(body: unknown): void {
  if (!isRecord(body)) {
    return
  }

  for (const key of OVERRIDE_KEYS) {
    if (key in body) {
      throw new Error(OVERRIDE_MESSAGE)
    }
  }
}

export function isSubmitTurnRequest(body: unknown): body is SubmitTurnRequest {
  if (!isRecord(body)) {
    return false
  }
  if (!hasExactKeys(body, ['sessionId', 'content', 'idempotencyKey',
    ...('ephemeral' in body ? ['ephemeral'] : []),
    ...('expectedEpoch' in body ? ['expectedEpoch'] : []),
    ...('calendarProtocol' in body ? ['calendarProtocol'] : []),
    ...('calendarReplyTo' in body ? ['calendarReplyTo'] : [])]) ||
    ('ephemeral' in body && typeof body.ephemeral !== 'boolean') ||
    ('calendarProtocol' in body && body.calendarProtocol !== 2)) {
    return false
  }
  if ('calendarReplyTo' in body && (!isRecord(body.calendarReplyTo) ||
    !hasExactKeys(body.calendarReplyTo, ['proposalId', 'revision']) ||
    !isBoundedId(body.calendarReplyTo.proposalId) ||
    !Number.isSafeInteger(body.calendarReplyTo.revision) || (body.calendarReplyTo.revision as number) < 1)) return false

  const sessionOk = body.sessionId === null || isBoundedId(body.sessionId)
  return (
    (!('expectedEpoch' in body) || isBoundedId(body.expectedEpoch)) &&
    sessionOk &&
    typeof body.content === 'string' &&
    body.content.length > 0 &&
    body.content.length <= 32_000 &&
    typeof body.idempotencyKey === 'string' &&
    body.idempotencyKey.length >= 8 &&
    body.idempotencyKey.length <= 128
  )
}

export function isSubmitTurnResponse(body: unknown): body is SubmitTurnResponse {
  return isRecord(body) && hasExactKeys(body, ['sessionId', 'turnId', 'attemptId', 'userMessageId', 'streamPath',
    ...('processEpoch' in body ? ['processEpoch'] : [])]) &&
    ['sessionId', 'turnId', 'attemptId', 'userMessageId'].every(key => isBoundedId(body[key])) &&
    (!('processEpoch' in body) || isBoundedId(body.processEpoch)) &&
    body.streamPath === API_ROUTES.turnStream(body.sessionId as string, body.turnId as string)
}

export function isRetryTurnRequest(body: unknown): body is RetryTurnRequest {
  if (!isRecord(body)) {
    return false
  }
  if (
    !hasExactKeys(body, [
      'idempotencyKey',
      ...('expectedEpoch' in body ? ['expectedEpoch'] : []),
      ...('calendarProtocol' in body ? ['calendarProtocol'] : []),
    ]) ||
    ('calendarProtocol' in body && body.calendarProtocol !== 2) ||
    ('expectedEpoch' in body && !isBoundedId(body.expectedEpoch))
  ) {
    return false
  }
  return (
    typeof body.idempotencyKey === 'string' &&
    body.idempotencyKey.length >= 8 &&
    body.idempotencyKey.length <= 128
  )
}

export function isActiveSessionTurn(value: unknown): value is ActiveSessionTurn {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['turnId', 'attemptId', 'status', 'mode']) &&
    isBoundedId(value.turnId) &&
    isBoundedId(value.attemptId) &&
    (value.status === 'accepted' || value.status === 'generating' || value.status === 'finalizing') &&
    (value.mode === 'text' || value.mode === 'live')
  )
}

export function isTurnStatusResponse(value: unknown): value is TurnStatusResponse {
  if (!isRecord(value)) {
    return false
  }
  const baseKeys = ['sessionId', 'turnId', 'attemptId', 'status', 'truncated', 'error'] as const
  if (!hasExactKeys(value, [...baseKeys, ...('calendar' in value ? ['calendar'] : []), ...('save' in value ? ['save'] : [])]) ||
    ('calendar' in value && !isCalendarTurnState(value.calendar)) || ('save' in value && !isSaveStateSnapshot(value.save))) {
    return false
  }
  const errorOk =
    value.error === null ||
    (isRecord(value.error) &&
      hasExactKeys(value.error, ['code', 'message', 'retryable']) &&
      isAppErrorCode(value.error.code) &&
      typeof value.error.message === 'string' &&
      value.error.message.length > 0 &&
      value.error.message.length <= 500 &&
      typeof value.error.retryable === 'boolean')

  return (
    isBoundedId(value.sessionId) &&
    isBoundedId(value.turnId) &&
    isBoundedId(value.attemptId) &&
    isAttemptStatus(value.status) &&
    typeof value.truncated === 'boolean' &&
    errorOk
  )
}

export function isStreamEvent(value: unknown): value is StreamEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false
  }

  switch (value.type) {
    case 'turn-accepted':
      return hasExactKeys(value, ['type', 'userMessageId']) && isBoundedId(value.userMessageId)
    case 'delta':
      return (hasExactKeys(value, ['type', 'text']) ||
        (hasExactKeys(value, ['type', 'text', 'reset']) && value.reset === true)) &&
        typeof value.text === 'string' && value.text.length > 0
    case 'status':
      return (
        hasExactKeys(value, ['type', 'status', 'truncated', ...('save' in value ? ['save'] : [])]) &&
        (!('save' in value) || isSaveStateSnapshot(value.save)) &&
        isAttemptStatus(value.status) &&
        typeof value.truncated === 'boolean'
      )
    case 'usage':
      return (
        hasExactKeys(value, [
          'type',
          'accountingStatus',
          'promptTokens',
          'completionTokens',
          'cost',
        ]) &&
        (value.accountingStatus === 'known' ||
          value.accountingStatus === 'pending' ||
          value.accountingStatus === 'unknown') &&
        isNullableNonnegativeInteger(value.promptTokens) &&
        isNullableNonnegativeInteger(value.completionTokens) &&
        isNullableNonnegativeNumber(value.cost)
      )
    case 'error':
      return (
        hasExactKeys(value, ['type', 'code', 'message', 'retryable']) &&
        isAppErrorCode(value.code) &&
        typeof value.message === 'string' &&
        value.message.length > 0 &&
        value.message.length <= 500 &&
        typeof value.retryable === 'boolean'
      )
    case 'completed':
      return (
        hasExactKeys(value, ['type', 'assistantMessageId', 'outcome', ...('save' in value ? ['save'] : []),
          ...('calendarView' in value ? ['calendarView'] : []),
          ...('weatherView' in value ? ['weatherView'] : []),
          ...('webSources' in value ? ['webSources'] : []),
          ...('webActivities' in value ? ['webActivities'] : []),
          ...('compaction' in value ? ['compaction'] : []),
          ...('contextUsage' in value ? ['contextUsage'] : []),
          ...('memoryUpdated' in value ? ['memoryUpdated'] : [])]) &&
        (!('save' in value) || isSaveStateSnapshot(value.save)) &&
        (!('calendarView' in value) || isCalendarView(value.calendarView)) &&
        (!('weatherView' in value) || isWeatherView(value.weatherView)) &&
        (!('webSources' in value) || isWebSourceReferenceList(value.webSources)) &&
        (!('webActivities' in value) || isWebSearchActivityList(value.webActivities)) &&
        (!('compaction' in value) || isCompactionCheckpointMeta(value.compaction)) &&
        (!('contextUsage' in value) || isContextUsageMeta(value.contextUsage)) &&
        (!('memoryUpdated' in value) || typeof value.memoryUpdated === 'boolean') &&
        isBoundedId(value.assistantMessageId) &&
        (value.outcome === 'completed' || value.outcome === 'truncated')
      )
    case 'context-state':
      return (
        hasExactKeys(value, [
          'type',
          ...('compaction' in value ? ['compaction'] : []),
          'contextUsage',
        ]) &&
        (!('compaction' in value) || isCompactionCheckpointMeta(value.compaction)) &&
        isContextUsageMeta(value.contextUsage)
      )
    case 'web-activity':
      return hasExactKeys(value, ['type', 'activity']) && isWebSearchActivity(value.activity)
    case 'web-sources':
      return hasExactKeys(value, ['type', 'sources']) && isWebSourceReferenceList(value.sources)
    case 'weather-view':
      return hasExactKeys(value, ['type', 'view']) && isWeatherView(value.view)
    default:
      return false
  }
}

export function isStreamEnvelope(value: unknown): value is StreamEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'protocolVersion',
      'sessionId',
      'turnId',
      'attemptId',
      'sequence',
      'event',
    ])
  ) {
    return false
  }

  return (
    value.protocolVersion === STREAM_PROTOCOL_VERSION &&
    isBoundedId(value.sessionId) &&
    isBoundedId(value.turnId) &&
    isBoundedId(value.attemptId) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    isStreamEvent(value.event)
  )
}

export function parseSseDataLine(line: string): StreamEnvelope {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) {
    throw new Error('invalid_sse_line')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice('data:'.length).trim())
  } catch {
    throw new Error('invalid_stream_envelope')
  }

  if (!isStreamEnvelope(parsed)) {
    throw new Error('invalid_stream_envelope')
  }
  return parsed
}
