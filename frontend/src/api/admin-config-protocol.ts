/**
 * ============================================================================
 * FILE: admin-config-protocol.ts
 * LOCATION: frontend/src/api/admin-config-protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Mirror the public admin configuration protocol for the browser client.
 *
 * ROLE IN PROJECT:
 *    Provides browser-safe types, routes, and guards without server bootstrap,
 *    encryption, or runtime-secret types.
 *
 * KEY COMPONENTS:
 *    - ADMIN_CONFIG_ROUTES / versions: Public admin HTTP paths and protocol ids.
 *    - PublicAdminConfig guards: Redacted reads and closed error catalogs.
 * ============================================================================
 */

import { isVoiceLimits, type VoiceLimits } from './voice-protocol';
import {
  isBlockedWebDomain,
  MAX_WEB_SEARCH_BLOCKED_DOMAINS,
  type WebSearchLimits,
  type WebSearchSettings,
} from './web-search-protocol.ts';
export type { WebSearchLimits, WebSearchSettings };

/** Admission-estimate floor for saved chat history; mirrored from the backend. */
export const MIN_HISTORY_TOKENS = 10_000;
export const ADMIN_CONFIG_PROTOCOL_VERSION = 1 as const;
export const ADMIN_CONFIG_SCHEMA_VERSION = 1 as const;
export const MAX_ADMIN_CONFIG_BODY_BYTES = 16_384;
export const MAX_CREDENTIAL_BYTES = 4_096;
export const CREDENTIAL_VALIDATION_LIMITS = {
  timeoutMs: 10_000, responseBytes: 65_536, retries: 0,
} as const;
export type CredentialProvider = 'openrouter' | 'deepgram';
export const ADMIN_CONFIG_ROUTES = {
  config: '/admin/config',
  models: '/admin/config/models',
  modelCompatibility: '/admin/config/model-compatibility',
  credential: (provider: CredentialProvider) => `/admin/config/credentials/${provider}`,
  devMode: '/admin/config/dev-mode',
} as const;

export const DEV_MODES = ['user', 'dev'] as const;
export type DevMode = typeof DEV_MODES[number];
export type DevModeResponse = { protocolVersion: 1 } &
  ({ enabled: false; mode: null } | { enabled: true; mode: DevMode });
export type SetDevModeRequest = { protocolVersion: 1; mode: DevMode };

export const REASONING_EFFORTS = [
  'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none',
] as const;
export type ExplicitReasoningEffort = typeof REASONING_EFFORTS[number];
export type ReasoningEffort = 'provider-default' | ExplicitReasoningEffort;

export type ChatLimits = {
  maxInputChars: number; maxInputTokens: number; maxMessagesInContext: number;
  maxContextTokens: number; maxHistoryTokens: number; maxOutputTokens: number;
  modelMarginTokens: number;
  titleMaxChars: number; maxConcurrentGenerationsPerProcess: number;
  maxRequestsPerMinutePerUser: number; retryMaxAttempts: number;
  retryBaseDelayMs: number; retryMaxDelayMs: number;
  firstOutputTimeoutMs: number; idleStreamTimeoutMs: number; totalRunTimeoutMs: number;
};
/** Server-computed context floor; the browser must not duplicate the estimator. */
export type ChatFloor = {
  minContextTokens: number; prefixTokens: number;
  breakdown: { fixed: number; personalization: number; tools: number };
  historyTokens: number;
  reserves: { maxOutputTokens: number; modelMarginTokens: number };
};
export type CompactionSettings = {
  enabled: boolean;
  watermarkRatio: number;
  modelMode: 'active-fork' | 'custom';
  customModelId: string | null;
};
export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true, watermarkRatio: 0.8, modelMode: 'active-fork', customModelId: null,
} as const satisfies CompactionSettings;
export type MemorySettings = { modelMode: 'main' | 'custom'; customModelId: string | null };
export const DEFAULT_MEMORY_SETTINGS = {
  modelMode: 'main', customModelId: null,
} as const satisfies MemorySettings;
type ReadableManageableSettings = Omit<ManageableSettings, 'memory'> & { memory?: MemorySettings };
type ReadablePublicAdminConfig = Omit<PublicAdminConfig, 'settings'> & { settings: ReadableManageableSettings };
export type ManageableSettings = {
  devModeEnabled?: boolean;
  openRouter: {
    modelId: string;
    reasoningEffort: ReasoningEffort;
    dataCollection: 'deny';
    disableTransforms: true;
  };
  chat: ChatLimits;
  compaction: CompactionSettings;
  memory: MemorySettings;
  webSearch: WebSearchSettings;
  voice: {
    enabledModes: { dictation: boolean; live: boolean };
    limits: VoiceLimits; dictationWarningMs: number | null;
    quotas: { identityConcurrent: number; globalConcurrent: number;
      identityDailyMinutes: number; globalDailyMinutes: number; dailySpendUsd: number | null };
  };
  deepgram: {
    region: 'us' | 'eu'; dictationModel: 'nova-3'; liveModel: 'flux-general-en';
    ttsModel: 'flux-cole-en' | 'flux-haley-en' | 'flux-alexis-en' | 'flux-priya-en';
    endpointingMs: number; spokenPunctuation: boolean; keyterms: string[];
    eotThreshold: number; eotTimeoutMs: number;
    rates: { novaPerMinuteUsd: number | null; fluxSttPerMinuteUsd: number | null;
      fluxTtsPerThousandCharsUsd: number | null };
  };
};
export type CredentialState = { configured: boolean; validatedAt: string | null };
export type SessionAdminRoleAssumption = {
  role: 'super-admin' | 'user'; authentication: 'session'; source: 'local-account';
};
/** @deprecated P3 removes this compile bridge at application auth cutover. */
export type LegacyAdminRoleAssumption = {
  role: 'super-admin'; authentication: 'disabled'; source: 'server-configured-development';
};
export type AdminRoleAssumption = SessionAdminRoleAssumption | LegacyAdminRoleAssumption;
export type PublicAdminConfig = {
  protocolVersion: 1; schemaVersion: 1;
  revision: number; activeRevision: number | null; state: 'missing' | 'stored';
  activation: 'active' | 'unconfigured' | 'blocked';
  roleAssumption: AdminRoleAssumption;
  settings: ManageableSettings;
  chatFloor: ChatFloor;
  credentials: { openrouter: CredentialState; deepgram: CredentialState };
};
export type SaveSettingsRequest = {
  protocolVersion: 1; expectedRevision: number; settings: ManageableSettings;
};
export type CredentialUpdateRequest =
  | { protocolVersion: 1; expectedRevision: number; action: 'replace'; candidate: string }
  | { protocolVersion: 1; expectedRevision: number; action: 'remove'; confirm: true };
export type ModelCatalogueItem = {
  id: string; name: string;
  reasoning: {
    selection: 'declared' | 'all' | 'unavailable' | 'unknown';
    efforts: ExplicitReasoningEffort[];
    mandatory: boolean | null;
  };
};
export type ModelCatalogueResponse = {
  protocolVersion: 1;
  observedAt: string;
  models: ModelCatalogueItem[];
};
export type ModelCompatibilityCode =
  | 'MODEL_REQUIRED' | 'MODEL_NOT_LISTED' | 'TEXT_CHAT_UNSUPPORTED'
  | 'TEXT_CHAT_EVIDENCE_MISSING' | 'CONTEXT_CAPACITY_MISSING'
  | 'CONTEXT_CAPACITY_TOO_SMALL' | 'OUTPUT_CAPACITY_MISSING'
  | 'OUTPUT_CAPACITY_TOO_SMALL' | 'OUTPUT_CAP_UNSUPPORTED'
  | 'OUTPUT_CAP_EVIDENCE_MISSING' | 'EFFORT_UNSUPPORTED'
  | 'EFFORT_EVIDENCE_MISSING' | 'REASONING_REQUIRED'
  | 'CONTEXT_FLOOR_NOT_MET' | 'FIXED_CONTEXT_DOES_NOT_FIT'
  | 'CATALOGUE_UNAVAILABLE' | 'CATALOGUE_RESPONSE_INVALID';
export type ModelCompatibilityWarning =
  | 'PRIVACY_ROUTE_UNVERIFIED' | 'STREAMING_UNTESTED'
  | 'TOOL_BEHAVIOR_UNTESTED' | 'REASONING_CONTINUITY_UNTESTED'
  | 'REASONING_USES_OUTPUT_BUDGET' | 'CREDENTIAL_NOT_CONFIGURED'
  | 'CALENDAR_PRICE_UNVERIFIED';
export type ModelCompatibilityReport = {
  status: 'catalogue-compatible' | 'incompatible' | 'unable-to-verify';
  blockers: Array<{ code: ModelCompatibilityCode; path: AdminConfigFieldPath | null }>;
  warnings: ModelCompatibilityWarning[];
  contextTokens: number | null;
  outputTokens: number | null;
  outputCapParameter: 'max_tokens' | 'max_completion_tokens' | null;
  chatFloor: ChatFloor;
  capabilities: {
    calendar: 'declared-available' | 'unavailable' | 'unknown';
    webTool: 'declared-available' | 'unavailable' | 'unknown';
    pricing: 'usable' | 'unverified';
  };
};
export type ModelCompatibilityResponse = {
  protocolVersion: 1;
  candidate: {
    revision: number; modelId: string; reasoningEffort: ReasoningEffort;
    chat: ChatLimits;
    memory?: MemorySettings;
  };
  checkedAt: string; catalogueObservedAt: string | null; expiresAt: string;
  report: ModelCompatibilityReport;
};
export const ADMIN_CONFIG_ERROR_CODES = [
  'INVALID_CONFIG_REQUEST', 'CONFIG_VALIDATION_FAILED', 'CONFIG_CONFLICT',
  'CONFIG_STORAGE_UNAVAILABLE', 'CONFIG_WRITE_UNCERTAIN', 'CONFIG_STORED_INVALID',
  'CONFIG_ENCRYPTION_UNAVAILABLE', 'CONFIG_ACTIVATION_UNAVAILABLE',
  'MODEL_CATALOGUE_UNAVAILABLE', 'MODEL_INCOMPATIBLE', 'MODEL_UNVERIFIED',
  'CREDENTIAL_REJECTED', 'CREDENTIAL_VALIDATION_TIMEOUT',
  'CREDENTIAL_PROVIDER_RATE_LIMITED', 'CREDENTIAL_PROVIDER_UNAVAILABLE',
  'CREDENTIAL_PROVIDER_RESPONSE_INVALID', 'ADMIN_RATE_LIMITED',
  'INVALID_ADMIN_ORIGIN', 'ADMIN_TRANSPORT_REQUIRED', 'DEV_MODE_DISABLED',
] as const;
export type AdminConfigErrorCode = typeof ADMIN_CONFIG_ERROR_CODES[number];
export type AdminConfigError = {
  protocolVersion: 1;
  error: { code: AdminConfigErrorCode; retryable: boolean; currentRevision: number | null;
    fieldErrors: Array<{ path: string; code: 'required' | 'invalid' | 'out_of_range'
      | 'cross_field' | 'immutable' | 'unsupported' }>;
    compatibility?: ModelCompatibilityReport };
};

export const ADMIN_CONFIG_FIELD_PATHS = [
  'devModeEnabled',
  'expectedRevision',
  'candidate',
  'openRouter.modelId',
  'openRouter.reasoningEffort',
  'openRouter.dataCollection',
  'openRouter.disableTransforms',
  'chat.maxInputChars',
  'chat.maxInputTokens',
  'chat.maxMessagesInContext',
  'chat.maxContextTokens',
  'chat.maxHistoryTokens',
  'chat.maxOutputTokens',
  'chat.modelMarginTokens',
  'chat.titleMaxChars',
  'chat.maxConcurrentGenerationsPerProcess',
  'chat.maxRequestsPerMinutePerUser',
  'chat.retryMaxAttempts',
  'chat.retryBaseDelayMs',
  'chat.retryMaxDelayMs',
  'chat.firstOutputTimeoutMs',
  'chat.idleStreamTimeoutMs',
  'chat.totalRunTimeoutMs',
  'compaction.enabled',
  'compaction.watermarkRatio',
  'compaction.modelMode',
  'compaction.customModelId',
  'memory.modelMode',
  'memory.customModelId',
  'webSearch.maxSearchesPerTurn',
  'webSearch.maxFetchesPerTurn',
  'webSearch.blockedDomains',
  'voice.enabledModes.dictation',
  'voice.enabledModes.live',
  'voice.limits.dictationMaxMs',
  'voice.dictationWarningMs',
  'voice.limits.liveMaxMs',
  'voice.limits.liveWarningMs',
  'voice.limits.idleWarningMs',
  'voice.limits.idleExitAfterWarningMs',
  'voice.limits.finalizationMs',
  'voice.limits.reconnectMs',
  'voice.limits.connectMs',
  'voice.limits.inputQueueMs',
  'voice.limits.outputQueueMs',
  'voice.quotas.identityConcurrent',
  'voice.quotas.globalConcurrent',
  'voice.quotas.identityDailyMinutes',
  'voice.quotas.globalDailyMinutes',
  'voice.quotas.dailySpendUsd',
  'deepgram.region',
  'deepgram.dictationModel',
  'deepgram.liveModel',
  'deepgram.ttsModel',
  'deepgram.endpointingMs',
  'deepgram.spokenPunctuation',
  'deepgram.keyterms',
  'deepgram.eotThreshold',
  'deepgram.eotTimeoutMs',
  'deepgram.rates.novaPerMinuteUsd',
  'deepgram.rates.fluxSttPerMinuteUsd',
  'deepgram.rates.fluxTtsPerThousandCharsUsd',
] as const;
export type AdminConfigFieldPath = typeof ADMIN_CONFIG_FIELD_PATHS[number];

const FIELD_PATHS = new Set<string>(ADMIN_CONFIG_FIELD_PATHS);
const ERROR_CODES = new Set<string>(ADMIN_CONFIG_ERROR_CODES);
const EFFORT_SET = new Set<string>(REASONING_EFFORTS);
const COMPATIBILITY_CODES = new Set<string>([
  'MODEL_REQUIRED', 'MODEL_NOT_LISTED', 'TEXT_CHAT_UNSUPPORTED',
  'TEXT_CHAT_EVIDENCE_MISSING', 'CONTEXT_CAPACITY_MISSING',
  'CONTEXT_CAPACITY_TOO_SMALL', 'OUTPUT_CAPACITY_MISSING',
  'OUTPUT_CAPACITY_TOO_SMALL', 'OUTPUT_CAP_UNSUPPORTED',
  'OUTPUT_CAP_EVIDENCE_MISSING', 'EFFORT_UNSUPPORTED',
  'EFFORT_EVIDENCE_MISSING', 'REASONING_REQUIRED',
  'CONTEXT_FLOOR_NOT_MET', 'FIXED_CONTEXT_DOES_NOT_FIT',
  'CATALOGUE_UNAVAILABLE', 'CATALOGUE_RESPONSE_INVALID',
]);
const COMPATIBILITY_WARNINGS = new Set<string>([
  'PRIVACY_ROUTE_UNVERIFIED', 'STREAMING_UNTESTED',
  'TOOL_BEHAVIOR_UNTESTED', 'REASONING_CONTINUITY_UNTESTED',
  'REASONING_USES_OUTPUT_BUDGET', 'CREDENTIAL_NOT_CONFIGURED',
  'CALENDAR_PRICE_UNVERIFIED',
]);
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const MAX_NODE_TIMER_MS = 2_147_483_647;
type Guard = (value: unknown) => boolean;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, shape: Record<string, Guard>): boolean =>
  record(value) && Object.keys(value).length === Object.keys(shape).length &&
  Object.entries(shape).every(([key, guard]) => Object.hasOwn(value, key) && guard(value[key]));
export function isSessionAdminAssumption(value: unknown): value is SessionAdminRoleAssumption {
  return exact(value, { role: x => x === 'super-admin' || x === 'user',
    authentication: x => x === 'session', source: x => x === 'local-account' });
}
const bool: Guard = value => typeof value === 'boolean';
export function isDevMode(value: unknown): value is DevMode {
  return value === 'user' || value === 'dev';
}

export function isDevModeResponse(value: unknown): value is DevModeResponse {
  return record(value) && exact(value, {
    protocolVersion: v => v === ADMIN_CONFIG_PROTOCOL_VERSION,
    enabled: bool,
    mode: v => value.enabled === true ? isDevMode(v) : v === null,
  });
}
const finite: Guard = value => typeof value === 'number' && Number.isFinite(value);
const safePos = (max = Number.MAX_SAFE_INTEGER): Guard => value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
const timer: Guard = safePos(MAX_NODE_TIMER_MS);
const nullable = (guard: Guard): Guard => value => value === null || guard(value);
const timestamp: Guard = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 40 && !Number.isNaN(Date.parse(value));
const modelId: Guard = value => typeof value === 'string' && value.length <= 200 &&
  (value === '' || (value.trim() === value && value.length > 0 && !CONTROL_CHARS.test(value)));
const nonEmptyModelId: Guard = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 200 && value.trim() === value && !CONTROL_CHARS.test(value);
const catalogueName: Guard = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 200 && !CONTROL_CHARS.test(value);
export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  value === 'provider-default' || (typeof value === 'string' && EFFORT_SET.has(value));
const isExplicitEffort = (value: unknown): value is ExplicitReasoningEffort =>
  typeof value === 'string' && EFFORT_SET.has(value);
const keyterm: Guard = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 64 && value.trim() === value && !CONTROL_CHARS.test(value);

function isMemorySettings(value: unknown): value is MemorySettings {
  return record(value) && exact(value, {
    modelMode: x => x === 'main' || x === 'custom', customModelId: nullable(nonEmptyModelId),
  }) && (value.modelMode !== 'custom' || value.customModelId !== null);
}

function isChatLimits(value: unknown): value is ChatLimits {
  if (!exact(value, {
    maxInputChars: safePos(32_000), maxInputTokens: safePos(), maxMessagesInContext: safePos(500),
    maxContextTokens: safePos(), maxHistoryTokens: safePos(), maxOutputTokens: safePos(),
    modelMarginTokens: safePos(),
    titleMaxChars: safePos(80), maxConcurrentGenerationsPerProcess: safePos(),
    maxRequestsPerMinutePerUser: safePos(), retryMaxAttempts: safePos(3),
    retryBaseDelayMs: timer, retryMaxDelayMs: timer, firstOutputTimeoutMs: timer,
    idleStreamTimeoutMs: timer, totalRunTimeoutMs: timer,
  })) return false;
  const v = value as ChatLimits;
  return v.maxHistoryTokens >= MIN_HISTORY_TOKENS &&
    v.maxContextTokens - v.maxOutputTokens - v.modelMarginTokens > 0 &&
    v.retryMaxDelayMs >= v.retryBaseDelayMs && v.retryMaxDelayMs <= v.totalRunTimeoutMs &&
    v.firstOutputTimeoutMs <= v.totalRunTimeoutMs && v.idleStreamTimeoutMs <= v.totalRunTimeoutMs;
}

export function isManageableSettings(value: unknown): value is ReadableManageableSettings {
  if (!record(value)) return false;
  const { devModeEnabled, memory, ...base } = value;
  if (Object.hasOwn(value, 'devModeEnabled') && typeof devModeEnabled !== 'boolean') return false;
  if (Object.hasOwn(value, 'memory') && !isMemorySettings(memory)) return false;
  if (!exact(base, {
    openRouter: v => exact(v, {
      modelId,
      reasoningEffort: isReasoningEffort,
      dataCollection: x => x === 'deny',
      disableTransforms: x => x === true,
    }),
    chat: isChatLimits,
    compaction: v => exact(v, {
      enabled: bool,
      watermarkRatio: x => finite(x) && (x as number) >= 0.5 && (x as number) <= 0.9,
      modelMode: x => x === 'active-fork' || x === 'custom',
      customModelId: nullable(nonEmptyModelId),
    }),
    webSearch: v => exact(v, {
      maxSearchesPerTurn: safePos(20),
      maxFetchesPerTurn: safePos(20),
      blockedDomains: x => Array.isArray(x) && x.length <= MAX_WEB_SEARCH_BLOCKED_DOMAINS &&
        x.every(isBlockedWebDomain) && new Set(x).size === x.length,
    }),
    voice: v => record(v) && exact(v, {
      enabledModes: modes => exact(modes, { dictation: bool, live: bool }),
      limits: isVoiceLimits,
      dictationWarningMs: nullable(timer),
      quotas: q => exact(q, {
        identityConcurrent: safePos(), globalConcurrent: safePos(),
        identityDailyMinutes: safePos(), globalDailyMinutes: safePos(),
        dailySpendUsd: nullable(x => finite(x) && (x as number) > 0),
      }),
    }),
    deepgram: v => record(v) && exact(v, {
      region: x => x === 'us' || x === 'eu',
      dictationModel: x => x === 'nova-3', liveModel: x => x === 'flux-general-en',
      ttsModel: x => x === 'flux-cole-en' || x === 'flux-haley-en' || x === 'flux-alexis-en' || x === 'flux-priya-en',
      endpointingMs: x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 300 && x <= 2000,
      spokenPunctuation: bool,
      keyterms: x => Array.isArray(x) && x.length <= 50 && x.every(keyterm),
      eotThreshold: x => finite(x) && (x as number) >= 0.5 && (x as number) <= 1,
      eotTimeoutMs: timer,
      rates: r => exact(r, {
        novaPerMinuteUsd: nullable(x => finite(x) && (x as number) >= 0),
        fluxSttPerMinuteUsd: nullable(x => finite(x) && (x as number) >= 0),
        fluxTtsPerThousandCharsUsd: nullable(x => finite(x) && (x as number) >= 0),
      }),
    }),
  })) return false;
  const s = value as ReadableManageableSettings;
  if (s.compaction.modelMode === 'custom' && s.compaction.customModelId === null) return false;
  if (s.voice.dictationWarningMs !== null &&
      s.voice.dictationWarningMs >= s.voice.limits.dictationMaxMs) return false;
  if (s.voice.quotas.identityConcurrent > s.voice.quotas.globalConcurrent) return false;
  if (s.voice.quotas.identityDailyMinutes > s.voice.quotas.globalDailyMinutes) return false;
  if (s.voice.quotas.dailySpendUsd !== null &&
      (s.deepgram.rates.novaPerMinuteUsd === null ||
        s.deepgram.rates.fluxSttPerMinuteUsd === null ||
        s.deepgram.rates.fluxTtsPerThousandCharsUsd === null)) return false;
  return true;
}

function isChatFloor(value: unknown): value is ChatFloor {
  if (!exact(value, {
    minContextTokens: safePos(), prefixTokens: safePos(),
    breakdown: v => exact(v, { fixed: safePos(), personalization: safePos(), tools: safePos() }),
    historyTokens: safePos(),
    reserves: v => exact(v, { maxOutputTokens: safePos(), modelMarginTokens: safePos() }),
  })) return false;
  const floor = value as ChatFloor;
  return floor.minContextTokens === floor.historyTokens + floor.reserves.maxOutputTokens +
    floor.reserves.modelMarginTokens + floor.prefixTokens &&
    floor.prefixTokens === floor.breakdown.fixed + floor.breakdown.personalization + floor.breakdown.tools;
}

function isCredentialState(value: unknown): value is CredentialState {
  if (!exact(value, { configured: bool, validatedAt: nullable(timestamp) })) return false;
  const v = value as CredentialState;
  return v.configured ? v.validatedAt !== null : v.validatedAt === null;
}

export function isPublicAdminConfig(value: unknown): value is ReadablePublicAdminConfig {
  if (!exact(value, {
    protocolVersion: v => v === 1, schemaVersion: v => v === 1,
    revision: v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
    activeRevision: nullable(v => typeof v === 'number' && Number.isSafeInteger(v) && v > 0),
    state: v => v === 'missing' || v === 'stored',
    activation: v => v === 'active' || v === 'unconfigured' || v === 'blocked',
    roleAssumption: v => isSessionAdminAssumption(v) || exact(v, {
      role: x => x === 'super-admin', authentication: x => x === 'disabled',
      source: x => x === 'server-configured-development',
    }),
    settings: isManageableSettings,
    chatFloor: isChatFloor,
    credentials: v => exact(v, { openrouter: isCredentialState, deepgram: isCredentialState }),
  })) return false;
  const v = value as ReadablePublicAdminConfig;
  if (v.state === 'missing') {
    if (v.revision !== 0 || v.credentials.openrouter.configured || v.credentials.deepgram.configured)
      return false;
  } else if (v.revision < 1) return false;
  if (v.activation === 'active' && (v.activeRevision !== v.revision || v.state !== 'stored'))
    return false;
  return true;
}

function isModelCatalogueItem(value: unknown): value is ModelCatalogueItem {
  if (!exact(value, {
    id: nonEmptyModelId,
    name: catalogueName,
    reasoning: r => exact(r, {
      selection: s => s === 'declared' || s === 'all' || s === 'unavailable' || s === 'unknown',
      efforts: e => Array.isArray(e) && e.length <= REASONING_EFFORTS.length &&
        e.every(isExplicitEffort) && new Set(e).size === e.length,
      mandatory: nullable(bool),
    }),
  })) return false;
  return true;
}

export function isModelCatalogueResponse(value: unknown): value is ModelCatalogueResponse {
  if (!exact(value, {
    protocolVersion: v => v === 1,
    observedAt: timestamp,
    models: m => Array.isArray(m) && m.length <= 2_000 && m.every(isModelCatalogueItem),
  })) return false;
  const ids = new Set<string>();
  for (const item of (value as ModelCatalogueResponse).models) {
    if (ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}

export function isModelCompatibilityReport(value: unknown): value is ModelCompatibilityReport {
  if (!exact(value, {
    status: s => s === 'catalogue-compatible' || s === 'incompatible' || s === 'unable-to-verify',
    blockers: b => Array.isArray(b) && b.length <= 12 && b.every(item => exact(item, {
      code: c => typeof c === 'string' && COMPATIBILITY_CODES.has(c),
      path: nullable(p => typeof p === 'string' && FIELD_PATHS.has(p)),
    })),
    warnings: w => Array.isArray(w) && w.length <= 8 &&
      w.every(item => typeof item === 'string' && COMPATIBILITY_WARNINGS.has(item)) &&
      new Set(w).size === w.length,
    contextTokens: nullable(safePos()),
    outputTokens: nullable(safePos()),
    outputCapParameter: nullable(p => p === 'max_tokens' || p === 'max_completion_tokens'),
    chatFloor: isChatFloor,
    capabilities: c => exact(c, {
      calendar: x => x === 'declared-available' || x === 'unavailable' || x === 'unknown',
      webTool: x => x === 'declared-available' || x === 'unavailable' || x === 'unknown',
      pricing: x => x === 'usable' || x === 'unverified',
    }),
  })) return false;
  return true;
}

function isCompatibilityCandidate(value: unknown): boolean {
  if (!record(value)) return false;
  const { memory, ...base } = value;
  return (!Object.hasOwn(value, 'memory') || isMemorySettings(memory)) && exact(base, {
    revision: r => typeof r === 'number' && Number.isSafeInteger(r) && r >= 0,
    modelId,
    reasoningEffort: isReasoningEffort,
    chat: isChatLimits,
  });
}

export function isModelCompatibilityResponse(value: unknown): value is ModelCompatibilityResponse {
  return exact(value, {
    protocolVersion: v => v === 1,
    candidate: isCompatibilityCandidate,
    checkedAt: timestamp,
    catalogueObservedAt: nullable(timestamp),
    expiresAt: timestamp,
    report: isModelCompatibilityReport,
  });
}

export function isAdminConfigError(value: unknown): value is AdminConfigError {
  if (!exact(value, {
    protocolVersion: v => v === 1,
    error: v => {
      if (!record(v)) return false;
      const keys = Object.keys(v);
      const hasCompat = Object.hasOwn(v, 'compatibility');
      if (keys.length !== (hasCompat ? 5 : 4)) return false;
      const baseValid =
        Object.hasOwn(v, 'code') && typeof v.code === 'string' && ERROR_CODES.has(v.code) &&
        Object.hasOwn(v, 'retryable') && bool(v.retryable) &&
        Object.hasOwn(v, 'currentRevision') &&
          nullable(x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0)(v.currentRevision) &&
        Object.hasOwn(v, 'fieldErrors') &&
          Array.isArray(v.fieldErrors) && v.fieldErrors.length <= 20 && v.fieldErrors.every(err => exact(err, {
            path: p => typeof p === 'string' && FIELD_PATHS.has(p),
            code: c => c === 'required' || c === 'invalid' || c === 'out_of_range' ||
              c === 'cross_field' || c === 'immutable' || c === 'unsupported',
          }));
      if (!baseValid) return false;
      return !hasCompat || isModelCompatibilityReport(v.compatibility);
    },
  })) return false;
  return true;
}
