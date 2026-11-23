/**
 * ============================================================================
 * FILE: calendar-policy.ts
 * LOCATION: backend/src/model/calendar-policy.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Model request admission policy, input token estimation, and tool dispatch bounds.
 *
 * ROLE IN PROJECT:
 *    Validates calendar model requests against OpenRouter parameters, charged turn
 *    budgets, token limits, and ensures only admitted native requests enter dispatch.
 *
 * KEY COMPONENTS:
 *    - buildCalendarBody: Serializes and bounds OpenRouter chat completion requests.
 *    - estimateCalendarInput: Conservative byte/token input estimator for reservations.
 *    - CalendarDispatchBindingV2: Typed binding holding v2 dispatch, budget, and hooks.
 * ============================================================================
 */

import { AppError } from '../platform/errors/app-error.js';
import { calendarLimitsSchema, type CalendarLimits } from '../contracts/calendar-policy.js';
import { SKILL_NATIVE_TOOLS, type SkillNativeDefinition } from '../contracts/calendar-tools.js';
import { modelDispatchV2Schema, turnBudgetRecordSchema, reserveUsd, withinSpendCap,
  type CalendarModelDispatch, type CalendarModelDispatchV2, type CalendarTurnBudget } from '../contracts/calendar-accounting.js';
import { nativeModelMessageSchema, type CalendarDecisionRequest, type CalendarDispatchObservation,
  type NativeCalendarModelMessage, type SkillDecisionRequest } from '../contracts/calendar-model.js';
import { object } from './faults.js';
import { openRouterSessionId, providerParameters, type ModelConfig, type ModelLimits } from './policy.js';
import { verifiedOutputCap } from '../contracts/config-runtime.js';
import { isReasoningEffort } from '../contracts/admin-config-wire.js';
import { assertNativeHistory, repairInstruction, type CompositeNativeMessage } from './calendar-repair.js';
import { WEB_TOOL_DEFINITION } from '../contracts/web-search-tools.js';
import { UPDATE_USER_MEMORY_NATIVE_TOOL } from '../contracts/user-memory.js';
import { webToolGroupSchema } from '../chat-runtime/memory-web-state.js';
import type { WebNativeRequest } from './web-native.js';

export type CalendarDispatchHooks = {
  beforeDispatch(): Promise<void>;
  onObservation(observation: CalendarDispatchObservation): Promise<void>;
  enqueueObservation?(observation: CalendarDispatchObservation): void;
  flushObservations?(): Promise<void>;
  checkObservations?(): void;
};
export type CalendarDispatchBindingV2 = {
  dispatch: CalendarModelDispatchV2; budget: CalendarTurnBudget; limits: CalendarLimits;
  processingPolicyId: string; hooks: CalendarDispatchHooks;
};
export type CalendarDispatchBinding = CalendarDispatchBindingV2 | {
  dispatch: CalendarModelDispatch; budget: CalendarTurnBudget; limits: CalendarLimits;
  processingPolicyId: string; hooks: CalendarDispatchHooks;
};

export type ModelToolDefinition = { name: string; description: string; inputSchema: unknown };
export const nativeToolDefinitions = (tools: readonly ModelToolDefinition[]) => tools.map(t => ({
  type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

export function estimateCalendarInput(messages: readonly CompositeNativeMessage[],
  tools: readonly ModelToolDefinition[]): number {
  const nativeTools = nativeToolDefinitions(tools);
  // ponytail: conservative byte-based reservation, not tokenizer certification;
  // retain the margin and replace with a verified tokenizer if needed.
  return 64 + Buffer.byteLength(JSON.stringify({ messages, tools: nativeTools }), 'utf8') + messages.length * 32;
}

function samePricing(left: CalendarModelDispatchV2['pricing'], right: CalendarModelDispatchV2['pricing']): boolean {
  return left.modelId === right.modelId && left.providerRoute === right.providerRoute && left.version === right.version
    && left.promptUsdPerToken === right.promptUsdPerToken && left.completionUsdPerToken === right.completionUsdPerToken
    && left.requestUsd === right.requestUsd;
}

function assertTools(tools: readonly ModelToolDefinition[], memory = false): void {
  if (JSON.stringify(tools) !== JSON.stringify(skillToolsFor(memory))) {
    throw new AppError('INVALID_REQUEST', 'The calendar request is invalid.', false);
  }
}

function assertCompositeTools(tools: readonly ModelToolDefinition[], memory = false): void {
  if (JSON.stringify(tools) !== JSON.stringify([...skillToolsFor(memory), WEB_TOOL_DEFINITION])) {
    throw new AppError('INVALID_REQUEST', 'The calendar request is invalid.', false);
  }
}

/** Canonical native tool order: base native tools, memory if enabled, Web last. */
export const skillToolsFor = (memory: boolean): readonly SkillNativeDefinition[] =>
  memory ? [...SKILL_NATIVE_TOOLS, UPDATE_USER_MEMORY_NATIVE_TOOL] : SKILL_NATIVE_TOOLS;

/** Exact provider-native definitions for one admitted tool set. */
export function calendarWireTools(memory: boolean, composite: boolean): readonly unknown[] {
  const base = nativeToolDefinitions(skillToolsFor(memory));
  return composite ? [...base, WEB_TOOL_DEFINITION] : base;
}

/** Validate Calendar subsequences and complete web groups separately. */
function assertCompositeHistory(messages: readonly NativeCalendarModelMessage[]): void {
  const calendar: NativeCalendarModelMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'assistant' && 'tool_calls' in message
      && (message.tool_calls[0]?.function.name as string) === 'web_tool') {
      const result = messages[++i];
      webToolGroupSchema.parse({ ordinal: 0, afterCalendarGroups: 0,
        assistant: message, result, sources: [] });
      continue;
    }
    calendar.push(message);
  }
  assertNativeHistory(calendar);
}

function assertGroupBytes(messages: readonly NativeCalendarModelMessage[], limits: CalendarLimits): void {
  for (const message of messages) {
    if ('tool_calls' in message) {
      const args = message.tool_calls[0]?.function.arguments ?? '';
      if (Buffer.byteLength(args, 'utf8') > limits.argumentBytes) {
        throw new AppError('INPUT_TOO_LARGE', 'A chat message is too large.', false);
      }
    }
    if (message.role === 'tool' && Buffer.byteLength(message.content, 'utf8') > limits.resultBytes) {
      throw new AppError('INPUT_TOO_LARGE', 'A chat message is too large.', false);
    }
  }
}

/**
 * Late projection admission for an already validated native request.
 *
 * Rechecks message bytes, the raw accepted input, the exact outgoing tools,
 * and the held dispatch reservation without a second history walk or reserve.
 */
export function assertProjectedNativeBody(config: ModelConfig, request: {
  messages: readonly { role: string; content: string }[]; remainingContextTokens: number;
  maxOutputTokens: number;
}, binding: CalendarDispatchBinding, messages: readonly { role: string; content: string | null }[],
  includeTools: boolean, composite: boolean, rawInput: string, contextTokens: number, memory = false): void {
  const dispatch = modelDispatchV2Schema.parse(binding.dispatch);
  const budget = turnBudgetRecordSchema.parse(binding.budget);
  const effective = calendarLimitsSchema.parse(binding.limits);
  if (!messages.length || messages.length > config.budgets.maxMessagesInContext) {
    throw new AppError('CONTEXT_BUDGET_EXCEEDED', 'This chat is too long. Start a new chat.', false);
  }
  if (rawInput.length > config.budgets.maxInputChars
    || Buffer.byteLength(rawInput, 'utf8') > config.budgets.maxInputTokens) {
    throw new AppError('INPUT_TOO_LARGE', 'The chat input is too large.', false);
  }
  for (const message of messages) {
    if (!includeTools) {
      // Dev sends only the plain transcript projection.
      if (!['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
        throw new AppError('INVALID_REQUEST', 'The calendar request is invalid.', false);
      }
      if (Buffer.byteLength(message.content, 'utf8') > config.budgets.maxMessageBytes) {
        throw new AppError('INPUT_TOO_LARGE', 'A chat message is too large.', false);
      }
    }
  }
  const tools = includeTools ? calendarWireTools(memory, composite) : [];
  const estimate = 64 + Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') + messages.length * 32;
  const ceiling = Math.min(config.budgets.maxContextTokens, contextTokens);
  if (estimate > request.remainingContextTokens
    || estimate + request.maxOutputTokens + config.budgets.modelMarginTokens > ceiling) {
    throw new AppError('CONTEXT_BUDGET_EXCEEDED', 'This chat is too long. Start a new chat.', false);
  }
  const needed = reserveUsd(dispatch.pricing, estimate, request.maxOutputTokens);
  if (!withinSpendCap('0', '0', needed, dispatch.reservationUsd)
    || !withinSpendCap('0', '0', dispatch.reservationUsd, budget.reservedUsd)
    || !withinSpendCap(budget.settledUsd, budget.reservedUsd, '0', effective.modelSpendUsd)) {
    throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The model budget is exhausted.', false);
  }
}

/** True for a native tool delta or tool-call finish marker in one provider frame. */
export function hasNativeToolDelta(raw: unknown): boolean {
  const top = object(raw);
  const choices = top.choices;
  if (!Array.isArray(choices)) return false;
  for (const candidate of choices) {
    const choice = object(candidate);
    const delta = object(choice.delta);
    if (delta.tool_calls !== undefined || delta.function_call !== undefined
      || choice.finish_reason === 'tool_calls') return true;
  }
  return false;
}

export function buildCalendarBody(config: ModelConfig, limits: ModelLimits,
  request: CalendarDecisionRequest | SkillDecisionRequest | WebNativeRequest, binding: CalendarDispatchBinding,
  composite = false, memory = false): Record<string, unknown> {
  const configError = () => { throw new AppError('CONFIGURATION_ERROR', 'The model configuration is unavailable.', false); };
  const invalid = () => { throw new AppError('INVALID_REQUEST', 'The calendar request is invalid.', false); };
  if (!config.openRouter.apiKey || !config.openRouter.modelId || config.openRouter.modelId.length > 200
    || !config.openRouter.disableTransforms || limits.modelId !== config.openRouter.modelId
    || !Number.isSafeInteger(limits.contextTokens) || !Number.isSafeInteger(limits.outputTokens)
    || limits.contextTokens < config.budgets.maxContextTokens || limits.outputTokens < config.budgets.maxOutputTokens
    || verifiedOutputCap(limits) === null || !isReasoningEffort(config.openRouter.reasoningEffort)) configError();
  if (request.modelId !== config.openRouter.modelId || request.user !== config.identity.userId || !request.user
    || request.user.length > 128 || request.dataCollection !== 'deny'
    || request.dataCollection !== config.openRouter.dataCollection) configError();
  const d = binding.dispatch as { schemaRevision?: string; schemaVersion?: number };
  if (d.schemaRevision === 'google-calendar.v1' || d.schemaVersion === 1) {
    invalid();
  }
  const dispatch = modelDispatchV2Schema.parse(binding.dispatch);
  const budget = turnBudgetRecordSchema.parse(binding.budget);
  const effective = calendarLimitsSchema.parse(binding.limits);
  if (dispatch.userId !== budget.userId || dispatch.sessionId !== budget.sessionId || dispatch.turnId !== budget.turnId
    || dispatch.userId !== request.user || dispatch.openRouterUser !== request.user
    || dispatch.requestedModel !== request.modelId || dispatch.dispatchId !== request.dispatchId
    || dispatch.decisionId !== request.decisionId || request.deadlineAt !== budget.deadlineAt
    || request.processingPolicyId !== binding.processingPolicyId || !request.processingPolicyId
    || dispatch.dispatchIndex !== budget.modelDispatches || dispatch.dispatchIndex > effective.modelDispatches
    || budget.repairs > effective.repairs) invalid();
  if (dispatch.reservationStatus !== 'held' || (dispatch.status !== 'reserved' && dispatch.status !== 'dispatched')) invalid();
  if (!limits.calendar?.tools || !samePricing(limits.calendar.pricing, dispatch.pricing)
    || dispatch.pricing.modelId !== request.modelId) configError();
  const deadline = Date.parse(request.deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) invalid();
  if (request.repair) {
    if (dispatch.reason !== 'schema-repair' && dispatch.reason !== 'provider-retry') invalid();
    if (dispatch.repairedDecisionId !== request.repair.rejectedDecisionId || budget.repairs < 1) invalid();
    const last = request.messages.at(-1);
    if (!last || last.role !== 'system' || !('content' in last)
      || last.content !== repairInstruction(request.repair.diagnostics)) invalid();
  } else if (dispatch.reason === 'schema-repair' || dispatch.repairedDecisionId !== null) invalid();
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0
    || request.maxOutputTokens > config.budgets.maxOutputTokens
    || request.maxOutputTokens > limits.outputTokens) {
    throw new AppError('INVALID_REQUEST', 'The output limit is invalid.', false);
  }
  if (!request.messages.length || request.messages.length > config.budgets.maxMessagesInContext) {
    throw new AppError('CONTEXT_BUDGET_EXCEEDED', 'This chat is too long. Start a new chat.', false);
  }
  if (composite) assertCompositeTools(request.tools as unknown as readonly ModelToolDefinition[], memory);
  else assertTools(request.tools as readonly ModelToolDefinition[], memory);
  if (composite) assertCompositeHistory(request.messages as readonly NativeCalendarModelMessage[]);
  else assertNativeHistory(request.messages as readonly NativeCalendarModelMessage[]);
  assertGroupBytes(request.messages as readonly NativeCalendarModelMessage[], effective);
  for (const message of request.messages) {
    if (message.role !== 'tool' && !('tool_calls' in message)) {
      const bytes = Buffer.byteLength(message.content, 'utf8');
      if (bytes > config.budgets.maxMessageBytes) throw new AppError('INPUT_TOO_LARGE', 'A chat message is too large.', false);
    }
  }
  const lastUser = [...request.messages].reverse().find(message => message.role === 'user' && !('tool_calls' in message));
  if (!lastUser || lastUser.role !== 'user' || lastUser.content.length > config.budgets.maxInputChars
    || Buffer.byteLength(lastUser.content, 'utf8') > config.budgets.maxInputTokens) {
    throw new AppError('INPUT_TOO_LARGE', 'The chat input is too large.', false);
  }
  const estimate = 64 + Buffer.byteLength(JSON.stringify({
    messages: request.messages,
    tools: calendarWireTools(memory, composite),
  }), 'utf8') + request.messages.length * 32;
  if (estimate > request.remainingContextTokens) {
    throw new AppError('CONTEXT_BUDGET_EXCEEDED', 'This chat is too long. Start a new chat.', false);
  }
  const ceiling = Math.min(config.budgets.maxContextTokens, limits.contextTokens);
  if (estimate + request.maxOutputTokens + config.budgets.modelMarginTokens > ceiling) {
    throw new AppError('CONTEXT_BUDGET_EXCEEDED', 'This chat is too long. Start a new chat.', false);
  }
  const needed = reserveUsd(dispatch.pricing, estimate, request.maxOutputTokens);
  const admitted = withinSpendCap(budget.settledUsd, budget.reservedUsd, '0', effective.modelSpendUsd)
    && withinSpendCap('0', '0', needed, dispatch.reservationUsd)
    && withinSpendCap('0', '0', dispatch.reservationUsd, budget.reservedUsd);
  if (!admitted) throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The model budget is exhausted.', false);
  const tools = calendarWireTools(memory, composite);
  return { ...providerParameters(config, request, limits),
    session_id: openRouterSessionId(dispatch.userId, dispatch.sessionId),
    messages: composite ? request.messages
      : request.messages.map(m => nativeModelMessageSchema.parse(m)),
    tools,
    ...(limits.calendar?.parallelToolCallsParameter ? { parallel_tool_calls: false } : {}),
    // OpenRouter always returns usage; stream_options breaks require_parameters
    // routing for Anthropic-family endpoints.
    stream: true };
}
