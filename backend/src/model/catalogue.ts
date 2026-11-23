/**
 * ============================================================================
 * FILE: catalogue.ts
 * LOCATION: backend/src/model/catalogue.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Load non-inference capability limits for the configured OpenRouter model.
 *
 * ROLE IN PROJECT:
 *    Lets P8/P9 verify context, native completion cap, and max_tokens support
 *    at readiness time without a paid chat POST or process restart loop.
 *
 * KEY COMPONENTS:
 *    - loadModelLimits: GET /models, select the configured model, fail closed.
 *    - derivedCalendar: Admit tools from live catalogue prices when unpinned.
 * ============================================================================
 */

import { AppError } from '../platform/errors/app-error.js';
import { OPENROUTER_BASE, TRANSPORT_LIMITS, type ModelConfig, type ModelLimits } from './policy.js';
import { object } from './faults.js';
import { number } from './accounting.js';
import { readJson } from './deadlines.js';
import type { FixedAssets } from '../instructions/fixed-assets.js';
import { assertFixedContextFits } from '../context/context-budget.js';
import { computeChatFloor } from '../context/prefix-estimate.js';
import { tokenPricingSchema, type CalendarTokenPricing } from '../contracts/calendar-accounting.js';
import { canonicalDecimal } from '../contracts/usage-evidence.js';
import {
  REASONING_EFFORTS,
  type AdminConfigFieldPath,
  type CompactionSettings,
  type ExplicitReasoningEffort,
  type MemorySettings,
  type ModelCatalogueItem,
  type ModelCatalogueResponse,
  type ModelCompatibilityCode,
  type ModelCompatibilityReport,
  type ModelCompatibilityWarning,
} from '../contracts/admin-config-wire.js';

export type CalendarCatalogueEvidence = {
  pricing: CalendarTokenPricing;
  nativeStrict: boolean;
  parallelToolCallsParameter: boolean;
};

export type CatalogueSnapshot = {
  observedAt: string;
  entries: Record<string, unknown>[];
};

export type CompatibilityConfig = Pick<ModelConfig, 'budgets'> & {
  openRouter: Omit<ModelConfig['openRouter'], 'apiKey'>;
  compaction?: CompactionSettings;
  memory?: MemorySettings;
};

export type CompactionModelLoadOptions = {
  compaction?: CompactionSettings;
  setCompactionLimits?: (limits: ModelLimits | null) => void;
};

export type ModelEvaluation = {
  report: ModelCompatibilityReport;
  limits: ModelLimits | null;
};

export class ModelCompatibilityFault extends AppError {
  readonly report: ModelCompatibilityReport;

  constructor(report: ModelCompatibilityReport) {
    super('CONFIGURATION_ERROR', 'The model configuration is incompatible or could not be verified.', false);
    this.report = report;
  }
}

function decimalPrice(value: unknown): string | null {
  try {
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) return null;
      return canonicalDecimal(String(value));
    }
    if (typeof value !== 'string' || value === '') return null;
    return canonicalDecimal(value);
  } catch {
    return null;
  }
}

function hasApplicableOrMalformedOverrides(
  rawOverrides: unknown,
  contextTokens: number | null,
): boolean {
  if (rawOverrides === undefined) return false;
  if (!Array.isArray(rawOverrides)) return true;
  for (const item of rawOverrides) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return true;
    const minPrompt = (item as Record<string, unknown>).min_prompt_tokens;
    if (minPrompt === undefined) return true;
    if (typeof minPrompt !== 'number' || !Number.isFinite(minPrompt) || !Number.isSafeInteger(minPrompt) || minPrompt < 0) {
      return true;
    }
    if (contextTokens === null || minPrompt <= contextTokens) return true;
  }
  return false;
}

function listedCalendarPrices(entry: Record<string, unknown>, contextTokens: number | null = null): {
  prompt: string; completion: string; requestUsd: string;
} | undefined {
  const listed = object(entry.pricing);
  const prompt = decimalPrice(listed.prompt);
  const completion = decimalPrice(listed.completion);
  if (prompt === null || completion === null) return undefined;
  let requestUsd = '0';
  if (listed.request !== undefined) {
    const request = decimalPrice(listed.request);
    if (request === null) return undefined;
    requestUsd = request;
  }
  if (listed.internal_reasoning !== undefined) {
    const reasoningRate = decimalPrice(listed.internal_reasoning);
    if (reasoningRate === null || reasoningRate !== completion) return undefined;
  }
  if (hasApplicableOrMalformedOverrides(listed.pricing_overrides, contextTokens) ||
      hasApplicableOrMalformedOverrides(entry.pricing_overrides, contextTokens)) {
    return undefined;
  }
  return { prompt, completion, requestUsd };
}

function verifiedCalendar(
  entry: Record<string, unknown>,
  evidence: CalendarCatalogueEvidence,
  modelId: string,
  contextTokens: number | null = null,
): ModelLimits['calendar'] {
  try {
    const pricing = tokenPricingSchema.parse(evidence.pricing);
    if (pricing.modelId !== modelId) return undefined;
    const supported = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
    if (!supported.includes('tools')) return undefined;
    if (evidence.parallelToolCallsParameter && !supported.includes('parallel_tool_calls')) return undefined;
    if (evidence.nativeStrict && !supported.includes('structured_outputs')) return undefined;
    const listed = listedCalendarPrices(entry, contextTokens);
    if (!listed) return undefined;
    if (listed.prompt !== pricing.promptUsdPerToken || listed.completion !== pricing.completionUsdPerToken) return undefined;
    if (object(entry.pricing).request !== undefined && listed.requestUsd !== pricing.requestUsd) return undefined;
    return { tools: true, nativeStrict: evidence.nativeStrict,
      parallelToolCallsParameter: evidence.parallelToolCallsParameter, pricing };
  } catch {
    return undefined;
  }
}

function derivedCalendar(
  entry: Record<string, unknown>,
  modelId: string,
  contextTokens: number | null = null,
  observedAt?: string,
): ModelLimits['calendar'] {
  try {
    const supported = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
    if (!supported.includes('tools')) return undefined;
    const listed = listedCalendarPrices(entry, contextTokens);
    if (!listed) return undefined;
    const slash = modelId.indexOf('/');
    const vendor = slash > 0 ? modelId.slice(0, slash) : 'openrouter';
    const pricing = tokenPricingSchema.parse({
      version: 'openrouter-catalogue-live',
      source: 'OpenRouter GET /api/v1/models catalogue',
      observedAt: observedAt ?? new Date().toISOString(),
      modelId,
      providerRoute: `openrouter-default/${vendor}`.slice(0, 200),
      promptUsdPerToken: listed.prompt,
      completionUsdPerToken: listed.completion,
      requestUsd: listed.requestUsd,
    });
    return { tools: true, nativeStrict: false, parallelToolCallsParameter: false, pricing };
  } catch {
    return undefined;
  }
}

const EFFORT_SET = new Set<string>(REASONING_EFFORTS);

export function catalogueEfforts(entry: Record<string, unknown>): ModelCatalogueItem['reasoning'] {
  if (!Object.hasOwn(entry, 'reasoning') || entry.reasoning === undefined) {
    return { selection: 'unavailable', efforts: [], mandatory: null };
  }
  if (entry.reasoning === null || typeof entry.reasoning !== 'object' || Array.isArray(entry.reasoning)) {
    return { selection: 'unknown', efforts: [], mandatory: null };
  }
  const metadata = entry.reasoning as Record<string, unknown>;
  let mandatory: boolean | null = null;
  if (Object.hasOwn(metadata, 'mandatory') && metadata.mandatory !== undefined) {
    if (typeof metadata.mandatory !== 'boolean') {
      return { selection: 'unknown', efforts: [], mandatory: null };
    }
    mandatory = metadata.mandatory;
  }
  if (!Object.hasOwn(metadata, 'supported_efforts') || metadata.supported_efforts === undefined) {
    return { selection: 'unavailable', efforts: [], mandatory };
  }
  const raw = metadata.supported_efforts;
  if (raw === null) {
    return {
      selection: 'all',
      efforts: REASONING_EFFORTS.filter((e) => mandatory !== true || e !== 'none'),
      mandatory,
    };
  }
  if (
    !Array.isArray(raw) ||
    raw.length > REASONING_EFFORTS.length * 2 ||
    !raw.every((v) => typeof v === 'string' && EFFORT_SET.has(v))
  ) {
    return { selection: 'unknown', efforts: [], mandatory };
  }
  const unique = [...new Set(raw as ExplicitReasoningEffort[])];
  return {
    selection: 'declared',
    efforts: unique.filter((e) => mandatory !== true || e !== 'none'),
    mandatory,
  };
}

const MISSING_EVIDENCE_CODES = new Set<ModelCompatibilityCode>([
  'TEXT_CHAT_EVIDENCE_MISSING',
  'CONTEXT_CAPACITY_MISSING',
  'OUTPUT_CAPACITY_MISSING',
  'OUTPUT_CAP_EVIDENCE_MISSING',
  'EFFORT_EVIDENCE_MISSING',
  'CATALOGUE_UNAVAILABLE',
  'CATALOGUE_RESPONSE_INVALID',
]);

function isStringArray(value: unknown, maxLen = 200): value is string[] {
  return Array.isArray(value) && value.length <= maxLen && value.every((v) => typeof v === 'string');
}

function addBlocker(
  blockers: Array<{ code: ModelCompatibilityCode; path: AdminConfigFieldPath | null }>,
  code: ModelCompatibilityCode,
  path: AdminConfigFieldPath | null,
): void {
  if (blockers.length >= 12) return;
  if (blockers.some((b) => b.code === code && b.path === path)) return;
  blockers.push({ code, path });
}

type EvidenceEvaluation = {
  reportBase: Omit<ModelCompatibilityReport, 'chatFloor'>;
  limits: ModelLimits | null;
};

function evaluateModelEvidence(
  config: CompatibilityConfig,
  snapshot: CatalogueSnapshot,
  calendarEvidence?: CalendarCatalogueEvidence,
  preBlockers: Array<{ code: ModelCompatibilityCode; path: AdminConfigFieldPath | null }> = [],
): EvidenceEvaluation {
  const blockers: Array<{ code: ModelCompatibilityCode; path: AdminConfigFieldPath | null }> = [...preBlockers];
  const warnings = new Set<ModelCompatibilityWarning>();

  const emptyBase = (
    status: ModelCompatibilityReport['status'],
    contextTokens: number | null = null,
    outputTokens: number | null = null,
    outputCapParameter: 'max_tokens' | 'max_completion_tokens' | null = null,
  ): EvidenceEvaluation => ({
    reportBase: {
      status,
      blockers,
      warnings: [...warnings],
      contextTokens,
      outputTokens,
      outputCapParameter,
      capabilities: { calendar: 'unknown', webTool: 'unknown', pricing: 'unverified' },
    },
    limits: null,
  });

  if (!config.openRouter.modelId) {
    addBlocker(blockers, 'MODEL_REQUIRED', 'openRouter.modelId');
    return emptyBase('incompatible');
  }

  const found = snapshot.entries.find((v) => object(v).id === config.openRouter.modelId);
  if (!found || typeof found !== 'object' || Array.isArray(found)) {
    addBlocker(blockers, 'MODEL_NOT_LISTED', 'openRouter.modelId');
    return emptyBase('incompatible');
  }
  const entry = found as Record<string, unknown>;

  // 1. Text chat applicability
  const arch = entry.architecture;
  const hasArch = arch !== null && typeof arch === 'object' && !Array.isArray(arch);
  const inputMods = hasArch ? (arch as Record<string, unknown>).input_modalities : undefined;
  const outputMods = hasArch ? (arch as Record<string, unknown>).output_modalities : undefined;
  const endpoints = entry.endpoints;

  if (!isStringArray(inputMods) || !isStringArray(outputMods) || !isStringArray(endpoints)) {
    if (
      (isStringArray(inputMods) && !inputMods.includes('text')) ||
      (isStringArray(outputMods) && !outputMods.includes('text')) ||
      (isStringArray(endpoints) && !endpoints.includes('/api/v1/chat/completions'))
    ) {
      addBlocker(blockers, 'TEXT_CHAT_UNSUPPORTED', 'openRouter.modelId');
    } else {
      addBlocker(blockers, 'TEXT_CHAT_EVIDENCE_MISSING', 'openRouter.modelId');
    }
  } else if (
    !inputMods.includes('text') ||
    !outputMods.includes('text') ||
    !endpoints.includes('/api/v1/chat/completions')
  ) {
    addBlocker(blockers, 'TEXT_CHAT_UNSUPPORTED', 'openRouter.modelId');
  }

  // 2. Context and output capacity
  const rawContext = number(entry.context_length, true);
  const contextTokens = rawContext !== null && Number.isSafeInteger(rawContext) && rawContext > 0 ? rawContext : null;
  if (contextTokens === null) {
    addBlocker(blockers, 'CONTEXT_CAPACITY_MISSING', 'openRouter.modelId');
  } else if (contextTokens < config.budgets.maxContextTokens) {
    addBlocker(blockers, 'CONTEXT_CAPACITY_TOO_SMALL', 'chat.maxContextTokens');
  }

  const rawOutput = number(object(entry.top_provider).max_completion_tokens, true);
  const outputTokens = rawOutput !== null && Number.isSafeInteger(rawOutput) && rawOutput > 0 ? rawOutput : null;
  if (outputTokens === null) {
    addBlocker(blockers, 'OUTPUT_CAPACITY_MISSING', 'openRouter.modelId');
  } else if (outputTokens < config.budgets.maxOutputTokens) {
    addBlocker(blockers, 'OUTPUT_CAPACITY_TOO_SMALL', 'chat.maxOutputTokens');
  }

  // 3. Output cap parameter
  const supportedParams = isStringArray(entry.supported_parameters, 200) ? entry.supported_parameters : null;
  let outputCapParameter: 'max_tokens' | 'max_completion_tokens' | null = null;
  if (supportedParams === null) {
    addBlocker(blockers, 'OUTPUT_CAP_EVIDENCE_MISSING', 'openRouter.modelId');
  } else if (supportedParams.includes('max_tokens')) {
    outputCapParameter = 'max_tokens';
  } else if (supportedParams.includes('max_completion_tokens')) {
    outputCapParameter = 'max_completion_tokens';
  } else {
    addBlocker(blockers, 'OUTPUT_CAP_UNSUPPORTED', 'openRouter.modelId');
  }

  // 4. Reasoning effort
  const effort = config.openRouter.reasoningEffort;
  const effortMeta = catalogueEfforts(entry);
  if (effort !== 'provider-default') {
    if (supportedParams === null) {
      addBlocker(blockers, 'EFFORT_EVIDENCE_MISSING', 'openRouter.reasoningEffort');
    } else if (!supportedParams.includes('reasoning')) {
      addBlocker(blockers, 'EFFORT_UNSUPPORTED', 'openRouter.reasoningEffort');
    } else if (effortMeta.selection === 'unknown') {
      addBlocker(blockers, 'EFFORT_EVIDENCE_MISSING', 'openRouter.reasoningEffort');
    } else if (effortMeta.selection === 'unavailable') {
      addBlocker(blockers, 'EFFORT_UNSUPPORTED', 'openRouter.reasoningEffort');
    } else if (effort === 'none' && effortMeta.mandatory === true) {
      addBlocker(blockers, 'REASONING_REQUIRED', 'openRouter.reasoningEffort');
    } else if (!effortMeta.efforts.includes(effort)) {
      addBlocker(blockers, 'EFFORT_UNSUPPORTED', 'openRouter.reasoningEffort');
    }
  }

  // 5. Optional tools & pricing
  const webTool: ModelCompatibilityReport['capabilities']['webTool'] =
    supportedParams === null ? 'unknown' : supportedParams.includes('tools') ? 'declared-available' : 'unavailable';
  const listedPricing = listedCalendarPrices(entry, contextTokens);
  const pricingStatus: ModelCompatibilityReport['capabilities']['pricing'] =
    listedPricing ? 'usable' : 'unverified';
  const calendarLimits = supportedParams === null || !supportedParams.includes('tools')
    ? undefined
    : calendarEvidence
      ? verifiedCalendar(entry, calendarEvidence, config.openRouter.modelId, contextTokens)
      : derivedCalendar(entry, config.openRouter.modelId, contextTokens, snapshot.observedAt);
  const calendarStatus: ModelCompatibilityReport['capabilities']['calendar'] =
    supportedParams === null
      ? 'unknown'
      : !supportedParams.includes('tools')
        ? 'unavailable'
        : calendarLimits
          ? 'declared-available'
          : 'unavailable';

  if (pricingStatus === 'unverified') {
    warnings.add('CALENDAR_PRICE_UNVERIFIED');
  }

  // 6. Status precedence
  const hasConcreteBlocker = blockers.some((b) => !MISSING_EVIDENCE_CODES.has(b.code));
  const status: ModelCompatibilityReport['status'] = hasConcreteBlocker
    ? 'incompatible'
    : blockers.length > 0
      ? 'unable-to-verify'
      : 'catalogue-compatible';

  let limits: ModelLimits | null = null;
  if (status === 'catalogue-compatible') {
    warnings.add('PRIVACY_ROUTE_UNVERIFIED');
    warnings.add('STREAMING_UNTESTED');
    warnings.add('TOOL_BEHAVIOR_UNTESTED');
    warnings.add('REASONING_CONTINUITY_UNTESTED');
    if (effort !== 'provider-default' || effortMeta.mandatory === true) {
      warnings.add('REASONING_USES_OUTPUT_BUDGET');
    }
    const baseLimits: ModelLimits = {
      modelId: config.openRouter.modelId,
      contextTokens: contextTokens!,
      outputTokens: outputTokens!,
      supportsMaxTokens: outputCapParameter === 'max_tokens',
      outputCapParameter: outputCapParameter!,
      source: 'catalogue',
      tools: webTool === 'declared-available',
    };
    limits = calendarLimits ? { ...baseLimits, calendar: calendarLimits } : baseLimits;
  }

  return {
    reportBase: {
      status,
      blockers,
      warnings: [...warnings].slice(0, 8),
      contextTokens,
      outputTokens,
      outputCapParameter,
      capabilities: {
        calendar: calendarStatus,
        webTool,
        pricing: pricingStatus,
      },
    },
    limits,
  };
}

export function evaluateCompactionModel(
  customModelId: string,
  budgets: CompatibilityConfig['budgets'],
  snapshot: CatalogueSnapshot,
): {
  blockers: Array<{ code: ModelCompatibilityCode; path: AdminConfigFieldPath | null }>;
  limits: ModelLimits | null;
} {
  const evaluated = evaluateModelEvidence(
    {
      budgets,
      openRouter: {
        modelId: customModelId,
        reasoningEffort: 'provider-default',
        dataCollection: 'deny',
        disableTransforms: true,
      },
    },
    snapshot,
    undefined,
    [],
  );
  const blockers = evaluated.reportBase.blockers.map((blocker) => ({
    code: blocker.code,
    path: 'compaction.customModelId' as AdminConfigFieldPath,
  }));
  return { blockers, limits: evaluated.limits };
}

function compatibilityStatus(
  blockers: Array<{ code: ModelCompatibilityCode; path: AdminConfigFieldPath | null }>,
): ModelCompatibilityReport['status'] {
  const hasConcreteBlocker = blockers.some((b) => !MISSING_EVIDENCE_CODES.has(b.code));
  return hasConcreteBlocker
    ? 'incompatible'
    : blockers.length > 0
      ? 'unable-to-verify'
      : 'catalogue-compatible';
}

export function evaluateMemoryModel(
  modelId: string, budgets: CompatibilityConfig['budgets'], snapshot: CatalogueSnapshot,
): EvidenceEvaluation {
  const selectable = snapshot.entries.filter(entry =>
    entry.id !== modelId || entry.expiration_date === null || entry.expiration_date === undefined,
  );
  const evaluated = evaluateModelEvidence({
    budgets,
    openRouter: { modelId, reasoningEffort: 'provider-default',
      dataCollection: 'deny', disableTransforms: true },
  }, { ...snapshot, entries: selectable });
  evaluated.reportBase.blockers = evaluated.reportBase.blockers.map(({ code }) => ({
    code, path: 'memory.customModelId' as AdminConfigFieldPath,
  }));
  return evaluated;
}

export function evaluateModelCompatibility(
  config: CompatibilityConfig,
  assets: FixedAssets,
  snapshot: CatalogueSnapshot,
  calendarEvidence?: CalendarCatalogueEvidence,
): ModelEvaluation {
  const chatFloor = computeChatFloor(assets, config.budgets);
  const preBlockers: Array<{ code: ModelCompatibilityCode; path: AdminConfigFieldPath | null }> = [];
  if (config.budgets.maxContextTokens < chatFloor.minContextTokens) {
    addBlocker(preBlockers, 'CONTEXT_FLOOR_NOT_MET', 'chat.maxContextTokens');
  }
  try {
    assertFixedContextFits(assets, config.budgets);
  } catch {
    addBlocker(preBlockers, 'FIXED_CONTEXT_DOES_NOT_FIT', 'chat.maxContextTokens');
  }
  const evaluated = evaluateModelEvidence(config, snapshot, calendarEvidence, preBlockers);
  if (config.compaction?.modelMode === 'custom') {
    const custom = evaluateCompactionModel(
      config.compaction.customModelId ?? '',
      config.budgets,
      snapshot,
    );
    for (const blocker of custom.blockers) {
      addBlocker(evaluated.reportBase.blockers, blocker.code, blocker.path);
    }
    evaluated.reportBase.status = compatibilityStatus(evaluated.reportBase.blockers);
    if (evaluated.reportBase.status !== 'catalogue-compatible') {
      evaluated.limits = null;
    }
  }
  if (config.memory?.modelMode === 'custom') {
    const custom = evaluateMemoryModel(config.memory.customModelId ?? '', config.budgets, snapshot);
    for (const blocker of custom.reportBase.blockers) {
      addBlocker(evaluated.reportBase.blockers, blocker.code, blocker.path);
    }
    evaluated.reportBase.status = compatibilityStatus(evaluated.reportBase.blockers);
    if (evaluated.reportBase.status !== 'catalogue-compatible') evaluated.limits = null;
  }
  return {
    report: {
      ...evaluated.reportBase,
      chatFloor,
    },
    limits: evaluated.limits,
  };
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const MAX_CATALOGUE_ENTRIES = 2_000;

export class CatalogueReadError extends AppError {
  readonly reasonCode: 'CATALOGUE_UNAVAILABLE' | 'CATALOGUE_RESPONSE_INVALID';

  constructor(reasonCode: 'CATALOGUE_UNAVAILABLE' | 'CATALOGUE_RESPONSE_INVALID') {
    super('CONFIGURATION_ERROR', 'The model catalogue is unavailable.', false);
    this.reasonCode = reasonCode;
  }
}

function isValidCatalogueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    !CONTROL_CHARS.test(value)
  );
}

function isTextChatEntry(entry: Record<string, unknown>): boolean {
  const arch = entry.architecture;
  if (arch === null || typeof arch !== 'object' || Array.isArray(arch)) return false;
  const inputMods = (arch as Record<string, unknown>).input_modalities;
  const outputMods = (arch as Record<string, unknown>).output_modalities;
  const endpoints = entry.endpoints;
  return (
    isStringArray(inputMods) && inputMods.includes('text') &&
    isStringArray(outputMods) && outputMods.includes('text') &&
    isStringArray(endpoints) && endpoints.includes('/api/v1/chat/completions')
  );
}

export async function readModelCatalogue(
  outer: AbortSignal,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<CatalogueSnapshot> {
  const boundedMs = Math.max(1, Math.min(timeoutMs, 10_000));
  const timerCtrl = new AbortController();
  const timer = setTimeout(() => timerCtrl.abort(), boundedMs);
  const signal = AbortSignal.any([outer, timerCtrl.signal]);
  try {
    if (signal.aborted) throw new CatalogueReadError('CATALOGUE_UNAVAILABLE');
    const response = await fetcher(`${OPENROUTER_BASE}/models?output_modalities=all`, {
      method: 'GET',
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CatalogueReadError('CATALOGUE_UNAVAILABLE');
    }
    let parsed: unknown;
    try {
      parsed = await readJson(response, TRANSPORT_LIMITS.catalogueBytes, signal);
    } catch {
      if (signal.aborted) throw new CatalogueReadError('CATALOGUE_UNAVAILABLE');
      throw new CatalogueReadError('CATALOGUE_RESPONSE_INVALID');
    }
    if (signal.aborted) throw new CatalogueReadError('CATALOGUE_UNAVAILABLE');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CatalogueReadError('CATALOGUE_RESPONSE_INVALID');
    }
    const rawData = (parsed as Record<string, unknown>).data;
    if (!Array.isArray(rawData) || rawData.length > MAX_CATALOGUE_ENTRIES) {
      throw new CatalogueReadError('CATALOGUE_RESPONSE_INVALID');
    }
    const seen = new Set<string>();
    const entries: Record<string, unknown>[] = [];
    for (const item of rawData) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new CatalogueReadError('CATALOGUE_RESPONSE_INVALID');
      }
      const rec = item as Record<string, unknown>;
      if (!isValidCatalogueId(rec.id) || seen.has(rec.id)) {
        throw new CatalogueReadError('CATALOGUE_RESPONSE_INVALID');
      }
      seen.add(rec.id);
      entries.push(rec);
    }
    return {
      observedAt: new Date().toISOString(),
      entries,
    };
  } catch (err) {
    if (err instanceof CatalogueReadError) throw err;
    throw new CatalogueReadError('CATALOGUE_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}

export function projectModelCatalogue(snapshot: CatalogueSnapshot): ModelCatalogueResponse {
  const models: ModelCatalogueItem[] = [];
  const seen = new Set<string>();
  if (snapshot.entries.length > MAX_CATALOGUE_ENTRIES) {
    throw new CatalogueReadError('CATALOGUE_RESPONSE_INVALID');
  }
  for (const entry of snapshot.entries) {
    const id = entry.id;
    if (!isValidCatalogueId(id) || seen.has(id)) {
      throw new CatalogueReadError('CATALOGUE_RESPONSE_INVALID');
    }
    seen.add(id);
    if (!isTextChatEntry(entry)) continue;
    const rawName = entry.name;
    const name =
      typeof rawName === 'string' && rawName.length > 0 && rawName.length <= 200 && !CONTROL_CHARS.test(rawName)
        ? rawName
        : id;
    models.push({
      id,
      name,
      reasoning: catalogueEfforts(entry),
    });
  }
  return {
    protocolVersion: 1,
    observedAt: snapshot.observedAt,
    models,
  };
}

export async function prepareTextConfiguration(
  c: ModelConfig,
  assets: FixedAssets,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ModelLimits | null> {
  if (!c.openRouter.apiKey || !c.openRouter.modelId) {
    assertFixedContextFits(assets, c.budgets);
    return null;
  }
  return loadModelLimits(c, signal, fetcher, undefined, assets);
}

export async function loadModelLimits(
  c: ModelConfig,
  outer: AbortSignal,
  fetcher: typeof fetch = fetch,
  calendarEvidence?: CalendarCatalogueEvidence,
  assets?: FixedAssets,
  compactionOptions?: CompactionModelLoadOptions,
): Promise<ModelLimits> {
  if (!c.openRouter.modelId || !c.openRouter.apiKey || !c.openRouter.disableTransforms) {
    throw new AppError('CONFIGURATION_ERROR', 'The model configuration is unavailable.', false);
  }
  const chatFloor = assets ? computeChatFloor(assets, c.budgets) : null;
  if (assets && chatFloor) {
    const preBlockers: Array<{ code: ModelCompatibilityCode; path: AdminConfigFieldPath | null }> = [];
    if (c.budgets.maxContextTokens < chatFloor.minContextTokens) {
      addBlocker(preBlockers, 'CONTEXT_FLOOR_NOT_MET', 'chat.maxContextTokens');
    }
    try {
      assertFixedContextFits(assets, c.budgets);
    } catch {
      addBlocker(preBlockers, 'FIXED_CONTEXT_DOES_NOT_FIT', 'chat.maxContextTokens');
    }
    if (preBlockers.length > 0) {
      throw new ModelCompatibilityFault({
        status: 'incompatible',
        blockers: preBlockers,
        warnings: [],
        contextTokens: null,
        outputTokens: null,
        outputCapParameter: null,
        chatFloor,
        capabilities: { calendar: 'unknown', webTool: 'unknown', pricing: 'unverified' },
      });
    }
  }

  let snapshot: CatalogueSnapshot;
  try {
    snapshot = await readModelCatalogue(outer, c.budgets.connectTimeoutMs, fetcher);
  } catch (err) {
    if (assets && chatFloor) {
      const code = err instanceof CatalogueReadError ? err.reasonCode : 'CATALOGUE_UNAVAILABLE';
      throw new ModelCompatibilityFault({
        status: 'unable-to-verify',
        blockers: [{ code, path: null }],
        warnings: [],
        contextTokens: null,
        outputTokens: null,
        outputCapParameter: null,
        chatFloor,
        capabilities: { calendar: 'unknown', webTool: 'unknown', pricing: 'unverified' },
      });
    }
    throw new AppError('CONFIGURATION_ERROR', 'The configured model limits could not be verified.', false);
  }

  if (assets) {
    const result = evaluateModelCompatibility(
      { ...c, compaction: compactionOptions?.compaction },
      assets,
      snapshot,
      calendarEvidence,
    );
    if (compactionOptions?.compaction?.modelMode === 'custom') {
      const custom = evaluateCompactionModel(
        compactionOptions.compaction.customModelId ?? '',
        c.budgets,
        snapshot,
      );
      if (custom.blockers.length > 0 || custom.limits === null) {
        for (const blocker of custom.blockers) {
          addBlocker(result.report.blockers, blocker.code, blocker.path);
        }
        result.report.status = compatibilityStatus(result.report.blockers);
        throw new ModelCompatibilityFault(result.report);
      }
      compactionOptions.setCompactionLimits?.(custom.limits);
    } else {
      compactionOptions?.setCompactionLimits?.(result.limits);
    }
    if (result.limits === null) {
      throw new ModelCompatibilityFault(result.report);
    }
    return result.limits;
  }

  const result = evaluateModelEvidence(c, snapshot, calendarEvidence);
  if (compactionOptions?.compaction?.modelMode === 'custom') {
    const custom = evaluateCompactionModel(
      compactionOptions.compaction.customModelId ?? '',
      c.budgets,
      snapshot,
    );
    if (custom.blockers.length > 0 || custom.limits === null) {
      throw new AppError('CONFIGURATION_ERROR', 'The configured compaction model limits could not be verified.', false);
    }
    compactionOptions.setCompactionLimits?.(custom.limits);
  } else {
    compactionOptions?.setCompactionLimits?.(result.limits);
  }
  if (result.limits === null) {
    throw new AppError('CONFIGURATION_ERROR', 'The configured model limits could not be verified.', false);
  }
  return result.limits;
}
