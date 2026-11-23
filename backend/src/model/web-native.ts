/**
 * ============================================================================
 * FILE: web-native.ts
 * LOCATION: backend/src/model/web-native.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate one native web_tool candidate and produce canonical repair text.
 *
 * ROLE IN PROJECT:
 *    Keeps the web decision boundary local to P3: it reuses the Calendar
 *    candidate scanner, never widens Calendar schemas, and never dispatches a
 *    provider or repairs a stale/disabled call.
 *
 * KEY COMPONENTS:
 *    - WebNativeCall / WebDecision / WebNativeRequest: Composite local types.
 *    - validateWebCandidate: Cardinality, envelope, scanner, and P1 schema.
 *    - webRepairFeedback: Canonical bounded schema feedback.
 *    - webToolsFor: Canonical advertisement order.
 * ============================================================================
 */

import { AppError } from '../platform/errors/app-error.js';
import { isDeepStrictEqual } from 'node:util';
import { idSchema } from '../contracts/identifiers.js';
import type { SkillNativeDefinition } from '../contracts/calendar-tools.js';
import type { SkillDecision, SkillDecisionRequest } from '../contracts/calendar-model.js';
import { CALENDAR_LIMITS, calendarFailureSchema, type CalendarFailure }
  from '../contracts/calendar-policy.js';
import { UPDATE_USER_MEMORY_TOOL_DEFINITION, UPDATE_USER_MEMORY_TOOL_NAME,
  updateUserMemoryReceiptSchema, type UpdateUserMemoryReceipt } from '../contracts/user-memory.js';
import { nativeToolCallSchema } from '../contracts/calendar-model.js';
import type { CompatibleCalendarToolGroup } from '../context/calendar-context.js';
import { nativeToolDefinitions } from './calendar-policy.js';
import { WEB_SEARCH_POLICY } from '../contracts/web-search-policy.js';
import { openRouterSessionId, providerParameters, type ModelConfig, type ModelLimits } from './policy.js';
import { verifiedOutputCap } from '../contracts/config-runtime.js';
import { isReasoningEffort } from '../contracts/admin-config-wire.js';
import { CalendarStreamAssembly } from './calendar-stream.js';
import { streamNativeCompletion } from './native-stream.js';
import { hasNativeToolDelta } from './calendar-policy.js';
import type { DiagnosticSink } from '../chat-runtime/ports.js';
import type { TurnModelDispatch } from '../chat-runtime/turn-model-mode.js';
import {
  WEB_TOOL_DEFINITION, WEB_TOOL_PARAMETERS, webToolArgumentsSchema,
  type WebToolArguments, type WebToolResult,
} from '../contracts/web-search-tools.js';
import {
  GET_ENVIRONMENT_PARAMETERS,
  getEnvironmentEnvelopeSchema,
  type GetEnvironmentEnvelope,
  type GetEnvironmentToolDefinition,
} from '../contracts/environment-tools.js';
import type { CandidateBatch } from './calendar-validation.js';
import { readMemoryToolCandidate, type MemoryToolCandidate } from './calendar-validation.js';
import { scanJsonObject, webForbiddenKeys } from './strict-json.js';
import type { WebNativeCall, WebToolGroup } from '../chat-runtime/memory-web-state.js';

export type WebNativeMessage =
  | import('../contracts/calendar-model.js').NativeCalendarModelMessage
  | WebToolGroup['assistant']
  | WebToolGroup['result'];
export type WebDecision =
  | { kind: 'web_tool'; call: WebNativeCall; args: WebToolArguments; assistantContent: string | null }
  | { kind: 'web-invalid'; call: WebNativeCall | null; diagnostics: string[] }
  | { kind: 'web-denied'; call: WebNativeCall | null;
      result: Extract<WebToolResult, { ok: false }> };
export type EnvironmentNativeCall = Readonly<{
  id: string;
  type: 'function';
  function: Readonly<{ name: 'get_environment'; arguments: string }>;
}>;

export type EnvironmentDecision =
  | { kind: 'get_environment'; call: EnvironmentNativeCall; envelope: GetEnvironmentEnvelope; assistantContent: string | null }
  | { kind: 'env-invalid'; call: EnvironmentNativeCall | null; diagnostics: string[] }
  | { kind: 'env-denied'; call: EnvironmentNativeCall | null };

export type WebNativeDecision = SkillDecision | WebDecision | EnvironmentDecision | MemoryToolCandidate;
export type WebNativeDefinition = typeof WEB_TOOL_DEFINITION | typeof UPDATE_USER_MEMORY_TOOL_DEFINITION;
export type WebNativeRequest = Omit<SkillDecisionRequest, 'messages' | 'tools'> & {
  messages: readonly WebNativeMessage[];
  tools: readonly (SkillNativeDefinition | WebNativeDefinition)[];
  /** Evaluated at late projection only; never authorizes an unadvertised call. */
  memoryAllowed?: () => boolean;
};
export type WebNativeChunk =
  | Exclude<import('../contracts/calendar-model.js').SkillDecisionChunk, { type: 'decision' }>
  | { type: 'decision'; decision: WebNativeDecision };

const DIAGNOSTIC_PATHS = new Set(['$', 'tool_calls', 'id', 'name', 'mode', 'query', 'url']);
const MAX_DIAGNOSTICS = 4;

function diagnostic(path: string, code: string): string {
  return `${DIAGNOSTIC_PATHS.has(path) ? path : '$'}:${code}`;
}
function bounded(input: readonly string[]): string[] {
  return [...new Set(input)].slice(0, MAX_DIAGNOSTICS);
}
function invalid(call: WebNativeCall | null, diagnostics: readonly string[]): WebDecision {
  return { kind: 'web-invalid', call, diagnostics: bounded(diagnostics) };
}
function denial(code: Extract<WebToolResult, { ok: false }>['error']['code'],
  retryable = false): Extract<WebToolResult, { ok: false }> {
  return { ok: false, mode: null, error: { code, retryable } };
}

/** A structurally usable call: exact native envelope and bounded ID. */
function callOf(batch: CandidateBatch): WebNativeCall | null {
  if (batch.calls.length !== 1 || batch.envelopeInvalid) return null;
  const raw = batch.calls[0]!;
  if (raw.envelopeInvalid || raw.type !== 'function' || raw.name !== 'web_tool'
    || !idSchema.safeParse(raw.id).success) return null;
  return {
    id: raw.id!, type: 'function',
    function: { name: 'web_tool', arguments: raw.arguments },
  };
}

/**
 * Classify one model decision as a valid web call, a repairable syntax error,
 * or a closed denial. `advertised:false` never repairs and never dispatches.
 */
export function validateWebCandidate(batch: CandidateBatch, advertised: boolean): WebNativeDecision {
  if (!advertised) {
    return { kind: 'web-denied', call: callOf(batch), result: denial('WEB_DISABLED') };
  }
  const diagnostics: string[] = [];
  if (batch.calls.length !== 1) diagnostics.push(diagnostic('tool_calls', 'cardinality'));
  if (batch.terminal !== 'tool_calls') diagnostics.push(diagnostic('tool_calls', 'terminal'));
  if (batch.envelopeInvalid) diagnostics.push(diagnostic('tool_calls', 'envelope'));
  const raw = batch.calls[0];
  if (!raw) return invalid(null, diagnostics.length ? diagnostics : [diagnostic('tool_calls', 'cardinality')]);
  if (raw.envelopeInvalid) diagnostics.push(diagnostic('tool_calls', 'envelope'));
  if (raw.name !== 'web_tool') diagnostics.push(diagnostic('name', 'unknown'));
  if (raw.type !== 'function') diagnostics.push(diagnostic('tool_calls', 'type'));
  if (!idSchema.safeParse(raw.id).success) diagnostics.push(diagnostic('id', 'invalid'));
  if (diagnostics.length) return invalid(callOf(batch), diagnostics);

  const scan = scanJsonObject(raw.arguments, {
    argumentBytes: WEB_SEARCH_POLICY.argumentBytes, jsonDepth: WEB_SEARCH_POLICY.jsonDepth,
  }, webForbiddenKeys);
  if (scan.forbidden) return invalid(callOf(batch), [diagnostic('$', 'forbidden-key')]);
  if (scan.code === 'duplicate-key') return invalid(callOf(batch), [diagnostic('$', 'duplicate-key')]);
  if (scan.code === 'depth-limit') return invalid(callOf(batch), [diagnostic('$', 'depth-limit')]);
  if (scan.code === 'byte-limit') return invalid(callOf(batch), [diagnostic('tool_calls', 'arguments-too-large')]);
  if (scan.code === 'malformed-json') return invalid(callOf(batch), [diagnostic('$', 'malformed-json')]);

  let parsed: unknown;
  try { parsed = JSON.parse(raw.arguments) as unknown; }
  catch { return invalid(callOf(batch), [diagnostic('$', 'malformed-json')]); }
  const args = webToolArgumentsSchema.safeParse(parsed);
  if (!args.success) {
    return invalid(callOf(batch), args.error.issues.map(issue => {
      const field = typeof issue.path[0] === 'string' ? issue.path[0] : '$';
      const code = issue.code === 'too_small' ? 'required'
        : issue.code === 'too_big' ? 'too-large'
          : issue.code === 'unrecognized_keys' ? 'unknown-field'
            : issue.code === 'invalid_type' ? 'type'
              : issue.code === 'invalid_enum_value' ? 'mode' : 'invalid';
      return diagnostic(field, code);
    }));
  }
  return {
    kind: 'web_tool', call: callOf(batch)!, args: args.data, assistantContent: null,
  };
}

const ENV_DIAGNOSTIC_PATHS = new Set(['$', 'tool_calls', 'id', 'name', 'include', 'location', 'forecast_days', 'units']);

function envDiagnostic(path: string, code: string): string {
  return `${ENV_DIAGNOSTIC_PATHS.has(path) ? path : '$'}:${code}`;
}

function envCallOf(batch: CandidateBatch): EnvironmentNativeCall | null {
  if (batch.calls.length !== 1 || batch.envelopeInvalid) return null;
  const raw = batch.calls[0]!;
  if (raw.envelopeInvalid || raw.type !== 'function' || raw.name !== 'get_environment'
    || !idSchema.safeParse(raw.id).success) return null;
  return {
    id: raw.id!,
    type: 'function',
    function: { name: 'get_environment', arguments: raw.arguments },
  };
}

export function validateEnvironmentCandidate(batch: CandidateBatch, advertised: boolean): EnvironmentDecision {
  if (!advertised) {
    return { kind: 'env-denied', call: envCallOf(batch) };
  }
  const diagnostics: string[] = [];
  if (batch.calls.length !== 1) diagnostics.push(envDiagnostic('tool_calls', 'cardinality'));
  if (batch.terminal !== 'tool_calls') diagnostics.push(envDiagnostic('tool_calls', 'terminal'));
  if (batch.envelopeInvalid) diagnostics.push(envDiagnostic('tool_calls', 'envelope'));
  const raw = batch.calls[0];
  if (!raw) return { kind: 'env-invalid', call: null, diagnostics: bounded(diagnostics.length ? diagnostics : [envDiagnostic('tool_calls', 'cardinality')]) };
  if (raw.envelopeInvalid) diagnostics.push(envDiagnostic('tool_calls', 'envelope'));
  if (raw.name !== 'get_environment') diagnostics.push(envDiagnostic('name', 'unknown'));
  if (raw.type !== 'function') diagnostics.push(envDiagnostic('tool_calls', 'type'));
  if (!idSchema.safeParse(raw.id).success) diagnostics.push(envDiagnostic('id', 'invalid'));
  if (diagnostics.length) return { kind: 'env-invalid', call: envCallOf(batch), diagnostics: bounded(diagnostics) };

  const scan = scanJsonObject(raw.arguments, CALENDAR_LIMITS);
  if (scan.forbidden) return { kind: 'env-invalid', call: envCallOf(batch), diagnostics: [envDiagnostic('$', 'forbidden-key')] };
  if (scan.code === 'duplicate-key') return { kind: 'env-invalid', call: envCallOf(batch), diagnostics: [envDiagnostic('$', 'duplicate-key')] };
  if (scan.code === 'depth-limit') return { kind: 'env-invalid', call: envCallOf(batch), diagnostics: [envDiagnostic('$', 'depth-limit')] };
  if (scan.code === 'byte-limit') return { kind: 'env-invalid', call: envCallOf(batch), diagnostics: [envDiagnostic('tool_calls', 'arguments-too-large')] };
  if (scan.code === 'malformed-json') return { kind: 'env-invalid', call: envCallOf(batch), diagnostics: [envDiagnostic('$', 'malformed-json')] };

  let parsed: unknown;
  try { parsed = JSON.parse(raw.arguments) as unknown; }
  catch { return { kind: 'env-invalid', call: envCallOf(batch), diagnostics: [envDiagnostic('$', 'malformed-json')] }; }
  const args = getEnvironmentEnvelopeSchema.safeParse(parsed);
  if (!args.success) {
    return {
      kind: 'env-invalid',
      call: envCallOf(batch),
      diagnostics: bounded(args.error.issues.map(issue => {
        const field = typeof issue.path[0] === 'string' ? issue.path[0] : '$';
        const code = issue.code === 'too_small' ? 'required'
          : issue.code === 'too_big' ? 'too-large'
            : issue.code === 'unrecognized_keys' ? 'unknown-field'
              : issue.code === 'invalid_type' ? 'type'
                : issue.code === 'invalid_enum_value' ? 'enum' : 'invalid';
        return envDiagnostic(field, code);
      })),
    };
  }
  return {
    kind: 'get_environment',
    call: envCallOf(batch)!,
    envelope: args.data,
    assistantContent: null,
  };
}

export function environmentRepairFeedback(diagnostics: readonly string[]): string {
  const feedback = JSON.stringify({
    code: 'ENV_SCHEMA_INVALID',
    errors: bounded(diagnostics),
    expectedSchema: GET_ENVIRONMENT_PARAMETERS,
  });
  if (feedback.length > 2000) {
    throw new AppError('CONTEXT_BUDGET_EXCEEDED', 'Environment verification could not fit in this chat.', false);
  }
  return feedback;
}

/** Canonical, bounded repair feedback revealing the complete P1 schema. */
export function webRepairFeedback(diagnostics: readonly string[]): string {
  const feedback = JSON.stringify({
    code: 'WEB_SCHEMA_INVALID',
    errors: bounded(diagnostics),
    expectedSchema: WEB_TOOL_PARAMETERS,
  });
  if (feedback.length > WEB_SEARCH_POLICY.maxRepairFeedbackChars) {
    throw new AppError('CONTEXT_BUDGET_EXCEEDED', 'Web verification could not fit in this chat.', false);
  }
  return feedback;
}

/** True only for the local web decision kinds, never a Calendar SkillDecision. */
export function isWebDecision(value: WebNativeDecision): value is WebDecision {
  return value.kind === 'web_tool' || value.kind === 'web-invalid' || value.kind === 'web-denied';
}

/** Provider call identity for a memory candidate, including a rejected secret. */
export function memoryCallId(candidate: Exclude<MemoryToolCandidate, { kind: 'memory-invalid' }>): string {
  return candidate.kind === 'memory-secret' ? candidate.toolCallId : candidate.nativeCall.id;
}
/** The exact native pair sent before and after the local memory writer. */
export function memoryToolPair(id: string, receipt: UpdateUserMemoryReceipt): CompatibleCalendarToolGroup {
  const call = nativeToolCallSchema.parse({ id, type: 'function',
    function: { name: UPDATE_USER_MEMORY_TOOL_NAME, arguments: '{"instruction":"[withheld]"}' } });
  return { assistant: { role: 'assistant', content: null, tool_calls: [call] },
    result: { role: 'tool', name: UPDATE_USER_MEMORY_TOOL_NAME, tool_call_id: id,
      content: JSON.stringify(updateUserMemoryReceiptSchema.parse(receipt)) }, sources: [] };
}
/** Worst-case receipt framing used to reserve continuation headroom. */
export const memoryReceiptHeadroom = (id: string) => memoryToolPair(id, {
  ok: true, status: 'updated', summary: '\\'.repeat(500),
});
/** Fixed, payload-free narration for a confirmation without a model continuation. */
export function memoryReceiptText(receipt: UpdateUserMemoryReceipt | null | undefined): string {
  return receipt?.ok ? receipt.status === 'updated' ? 'I updated your memory.' : 'Nothing in your memory changed.'
    : receipt?.error.code === 'SECRET_REJECTED' ? 'I did not save that sensitive information.'
    : 'I could not confirm a memory update.';
}

/** Calendar tools keep their order; only the one canonical web tool is appended. */
export function webToolsFor(calendar: readonly SkillNativeDefinition[] | null):
readonly (SkillNativeDefinition | WebNativeDefinition)[] {
  return calendar ? [...calendar, WEB_TOOL_DEFINITION] : [WEB_TOOL_DEFINITION];
}

/** Exact provider-native definitions used for composite context estimation. */
export function webNativeToolsFor(calendar: readonly SkillNativeDefinition[] | null): readonly unknown[] {
  return calendar
    ? [...nativeToolDefinitions(calendar), WEB_TOOL_DEFINITION]
    : [WEB_TOOL_DEFINITION];
}

export type WebModelRequest = {
  messages: readonly WebNativeMessage[];
  tools: readonly (SkillNativeDefinition | WebNativeDefinition | GetEnvironmentToolDefinition)[];
  user: string; modelId: string; maxOutputTokens: number;
  remainingContextTokens: number; deadlineAt: string; signal: AbortSignal;
  dataCollection: 'deny'; advertised: boolean; envAdvertised?: boolean;
  /** Late projection only: a synchronous trusted scope check before the POST. */
  memoryAllowed?: () => boolean;
  /** Bounded usage observation for the durable native path. */
  observeUsage?: (raw: unknown) => void;
};
export type WebModelChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'decision'; decision: WebNativeDecision }
  | { type: 'failure'; failure: CalendarFailure };
export type WebModelPort = { stream(request: WebModelRequest, dispatch?: TurnModelDispatch): AsyncIterable<WebModelChunk> };

function failureChunk(failure: CalendarFailure): WebModelChunk {
  return { type: 'failure', failure: calendarFailureSchema.parse(failure) };
}
function mapFailure(error: unknown): CalendarFailure {
  if (error instanceof AppError) {
    if (error.code === 'CANCELLED') return calendarFailureSchema.parse({ category: 'cancelled', code: 'CANCELLED', retry: 'none' });
    if (error.code === 'PERSISTENCE_ERROR') return calendarFailureSchema.parse({ category: 'persistence', code: 'PERSISTENCE_ERROR', retry: 'none' });
    if (error.code === 'CONTEXT_BUDGET_EXCEEDED' || error.code === 'INPUT_TOO_LARGE')
      return calendarFailureSchema.parse({ category: 'budget', code: error.code, retry: 'none' });
    if (error.code === 'STORAGE_BUDGET_EXCEEDED')
      return calendarFailureSchema.parse({ category: 'budget', code: 'ARGUMENT_BUDGET_EXCEEDED', retry: 'none' });
    if (error.code === 'TIMEOUT') return calendarFailureSchema.parse({ category: 'provider', code: 'TIMEOUT', retry: 'none' });
  }
  return calendarFailureSchema.parse({ category: 'provider', code: 'PROVIDER_ERROR', retry: 'none' });
}

/**
 * One web-only native model port over the shared transport. It advertises the
 * canonical web tool and never Calendar tools; Calendar-capable turns use the
 * composite Calendar path instead.
 */
export function createWebNativeModelPort(
  config: ModelConfig & { sessionId: string }, limits: ModelLimits, fetcher: typeof fetch = fetch,
  diagnostic?: DiagnosticSink,
): WebModelPort {
  const sessionId = openRouterSessionId(config.identity.userId, config.sessionId);
  const webLimits = { ...CALENDAR_LIMITS, argumentBytes: WEB_SEARCH_POLICY.argumentBytes };
  const isMemoryDefinition = (tool: WebModelRequest['tools'][number]) =>
    'function' in tool && tool.function.name === UPDATE_USER_MEMORY_TOOL_NAME;
  return {
    async *stream(request: WebModelRequest, dispatch?: TurnModelDispatch): AsyncGenerator<WebModelChunk> {
      const invalid = () => new AppError('INVALID_REQUEST', 'The web request is invalid.', false);
      if (verifiedOutputCap(limits) === null || !isReasoningEffort(config.openRouter.reasoningEffort)) {
        throw new AppError('CONFIGURATION_ERROR', 'The model configuration is unavailable.', false);
      }
      if (!config.openRouter.apiKey || !config.openRouter.modelId
        || limits.modelId !== config.openRouter.modelId
        || request.modelId !== config.openRouter.modelId
        || request.user !== config.identity.userId || !request.user
        || request.dataCollection !== 'deny'
        || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0
        || request.maxOutputTokens > config.budgets.maxOutputTokens
        || request.maxOutputTokens > limits.outputTokens) throw invalid();
      const memoryTools = request.tools.filter(isMemoryDefinition);
      if (memoryTools.length > 1 || (memoryTools.length === 1
        && (!isDeepStrictEqual(memoryTools[0], UPDATE_USER_MEMORY_TOOL_DEFINITION) || limits.tools !== true))) invalid();
      let sentMemory = false;
      const estimate = 64 + Buffer.byteLength(JSON.stringify({
        messages: request.messages, tools: request.tools,
      }), 'utf8') + request.messages.length * 32;
      const ceiling = Math.min(config.budgets.maxContextTokens, limits.contextTokens);
      if (estimate > request.remainingContextTokens
        || estimate + request.maxOutputTokens + config.budgets.modelMarginTokens > ceiling) {
        throw new AppError('CONTEXT_BUDGET_EXCEEDED', 'This chat is too long. Start a new chat.', false);
      }
      const assembly = new CalendarStreamAssembly([], webLimits, diagnostic);
      const cleanBody = (messages: WebModelRequest['messages'] = request.messages,
        tools: WebModelRequest['tools'] = request.tools) => {
        sentMemory = tools.some(isMemoryDefinition);
        return {
          ...providerParameters(config, request, limits),
          session_id: sessionId,
          messages,
          ...(tools.length ? { tools } : {}),
          // OpenRouter always returns usage; stream_options breaks
          // require_parameters routing for Anthropic-family endpoints.
          stream: true,
        };
      };
      yield* streamNativeCompletion<WebModelChunk>(config, request.signal, request.deadlineAt, {
        body: () => cleanBody(),
        lateBody: check => {
          if (!dispatch) return undefined;
          return dispatch.handle.prepare(decision => {
            const messages = dispatch.project(decision);
            const projected = messages === request.messages ? request.messages : messages;
            const dev = decision?.mode === 'dev';
            const tools = dev ? [] : request.memoryAllowed?.() === false
              ? request.tools.filter(t => !isMemoryDefinition(t)) : request.tools;
            const next = 64 + Buffer.byteLength(JSON.stringify({ messages: projected, tools }), 'utf8') + projected.length * 32;
            if (next > request.remainingContextTokens
              || next + request.maxOutputTokens + config.budgets.modelMarginTokens > ceiling) {
              throw new AppError('CONTEXT_BUDGET_EXCEEDED', 'This chat is too long. Start a new chat.', false);
            }
            const body = cleanBody(projected as WebModelRequest['messages'], tools);
            if (!dev) return body;
            const { tools: _tools, ...rest } = body;
            return { ...rest, messages: projected };
          }, check);
        },
        beforeDispatch: async () => undefined,
        observe: async raw => { request.observeUsage?.(raw); },
        frame: raw => {
          if (dispatch?.handle.frozen()?.mode === 'dev' && hasNativeToolDelta(raw))
            throw new AppError('PROVIDER_ERROR', 'The model service did not complete its answer.', false);
          const pushed = assembly.push(raw);
          return pushed.text ? [{ type: 'text-delta', text: pushed.text }] : [];
        },
        finish: () => {
          const raw = assembly.rawCandidate();
          if (dispatch?.handle.frozen()?.mode === 'dev' && raw.batch.calls.length) {
            return [failureChunk({ category: 'provider', code: 'PROVIDER_ERROR', retry: 'none' })];
          }
          if (raw.batch.calls.length === 0
            && (raw.terminal === 'stop' || raw.terminal === 'length')) {
            return [{ type: 'decision', decision: {
              kind: 'text', decisionId: 'web-text', content: raw.text,
              truncated: raw.terminal === 'length',
            } }];
          }
          const memory = readMemoryToolCandidate(raw.batch, sentMemory, webLimits);
          if (memory) return [{ type: 'decision', decision: memory }];
          if (raw.batch.calls.length === 1 && raw.batch.calls[0]?.name === 'get_environment') {
            return [{ type: 'decision', decision: validateEnvironmentCandidate(raw.batch, Boolean(request.envAdvertised)) }];
          }
          if (!request.advertised && request.envAdvertised) {
            return [{ type: 'decision', decision: validateEnvironmentCandidate(raw.batch, true) }];
          }
          return [{ type: 'decision', decision: validateWebCandidate(raw.batch, request.advertised) }];
        },
        rejected: (_http, _parsed, retryable) => [failureChunk({ category: 'provider',
          code: retryable ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
          retry: retryable ? 'provider-rejection' : 'none' })],
        failed: error => [failureChunk(mapFailure(error))],
      }, fetcher);
    },
  };
}
