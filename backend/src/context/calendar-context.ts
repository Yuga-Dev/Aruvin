/**
 * ============================================================================
 * FILE: calendar-context.ts
 * LOCATION: backend/src/context/calendar-context.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Assemble and validate Calendar-specific model context and tool result groups.
 *
 * ROLE IN PROJECT:
 *    Ensures tool groups conform to bounded budgets, authenticates source provenance
 *    against the account authority, and rebuilds model messages for a current v2 turn.
 *    Historical web groups are reinserted before that turn's Calendar groups.
 *
 * KEY COMPONENTS:
 *    - assertGroups: Validates tool call/result bounds, duplicates, and source lifetimes.
 *    - assertV2Provenance: Verifies source account revisions and targets against the result.
 *    - calendarContext: Assembles bounded messages and calculates remaining context tokens.
 * ============================================================================
 */

import { z } from 'zod';
import type { BudgetConfig } from '../contracts/budgets.js';
import type { CalendarAccountBinding } from '../contracts/calendar-discovery.js';
import {
  completeToolGroupSchema,
  completeToolGroupV2Schema,
  type CompleteCalendarToolGroup,
  type NativeCalendarModelMessage,
  type SkillDecisionRequest,
} from '../contracts/calendar-model.js';
import type { CalendarLimits } from '../contracts/calendar-policy.js';
import type { AssembledContext } from '../contracts/context.js';
import { CALENDAR_TOMBSTONE } from '../contracts/calendar-sources.js';
import { CALENDAR_TOOLS, calendarResultV2Schema, canvasControlResultSchema, canvasNavigationResultSchema,
  compactSkillCatalog, getEnvironmentResultSchema, skillLocalResultSchema,
  type SkillRegistryTool } from '../contracts/calendar-tools.js';
import type { CanvasInventorySnapshot, CanvasSelection } from '../contracts/canvas-navigation.js';
import { canvasTurnStateMessage } from '../chat-runtime/canvas-navigation.js';
import { loadedSkillRevisions, type LoadedSkill } from '../chat-runtime/calendar-skills.js';
import { nativeToolDefinitions } from '../model/calendar-policy.js';
import { UPDATE_USER_MEMORY_TOOL_NAME, updateUserMemoryArgumentsSchema, updateUserMemoryReceiptSchema }
  from '../contracts/user-memory.js';
import { rebuildCalendarMessages, type CompositeNativeMessage } from '../model/calendar-repair.js';
import { AppError } from '../platform/errors/app-error.js';
import type { PositionedContext } from './referenced-context-assembler.js';
import {
  admitNativePrompt, appendHistoricalWebGroups, webContext, webInsertions,
  type HistoricalWebResult, type WebContextInput,
} from './web-context.js';
import type { WebToolGroup } from '../chat-runtime/memory-web-state.js';

const UNAVAILABLE_HISTORY = JSON.stringify({
  kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE,
});
const HISTORY_WITHHELD_NOTE = 'Earlier Google Calendar tool payloads are not in this prompt. '
  + 'The chat transcript is what the user saw. Do not recant those replies or claim those '
  + 'lookups failed or that their details were invented. For new calendar facts, call tools again.';

export type CompatibleCalendarToolGroup = CompleteCalendarToolGroup | z.infer<typeof completeToolGroupV2Schema>;

const compatibleToolGroupSchema = z.union([completeToolGroupSchema, completeToolGroupV2Schema]);

export type CalendarContextInput = {
  context: AssembledContext;
  acceptedInput: string;
  groups: readonly CompatibleCalendarToolGroup[];
  historicalGroups?: ReadonlyMap<string, readonly CompatibleCalendarToolGroup[]>;
  /** Historical web evidence, reinserted before that turn's Calendar groups. */
  historicalWebGroups?: ReadonlyMap<string, readonly WebToolGroup[]>;
  /** Completed historical turns whose validated Web evidence may be projected on overflow. */
  foldableTurnIds?: ReadonlySet<string>;
  /** Optional exact current Web groups and native definitions merged before admission. */
  web?: Pick<WebContextInput, 'webGroups' | 'tools' | 'contextTokens'>;
  /** Model context ceiling when the standalone Calendar path has one. */
  contextTokens?: number;
  repair: SkillDecisionRequest['repair'];
  tools: SkillDecisionRequest['tools'];
  budgets: BudgetConfig;
  limits: CalendarLimits;
  binding: CalendarAccountBinding;
  /**
   * 'current' assembles a new execution and accepts v2 groups only.
   * 'historical' is the explicit read-only compatibility path for v1 evidence.
   */
  compatibility?: 'current' | 'historical';
  volatileSourceIds?: ReadonlySet<string>;
  now: number;
  /** Enabled plugin tool set; an explicit empty list hides Calendar availability. */
  enabledPluginTools?: readonly SkillRegistryTool[];
  /** Trusted account state for model awareness; it does not grant access. */
  calendarConnection?: 'connected' | 'not-connected';
  /** Trusted, already-intersected Canvas state for voice-only turns. */
  responseMode?: 'text' | 'voice';
  canvasInventory?: CanvasInventorySnapshot;
  canvasSelection?: CanvasSelection | null;
  /** Hidden model-only note; never a visible transcript line. */
  note?: string | null;
};

export type CalendarContextOutput = {
  messages: readonly CompositeNativeMessage[];
  estimatedInputTokens: number;
  remainingContextTokens: number;
  loadedSkills: ReadonlyMap<string, LoadedSkill>;
  /** Native prefix boundary including the catalog; the Canvas suffix is not history. */
  prefixCount: number;
};

function incomplete(): never {
  throw new AppError('INVALID_REQUEST', 'Calendar tool results are incomplete.');
}

function isV2Group(value: CompatibleCalendarToolGroup): value is z.infer<typeof completeToolGroupV2Schema> {
  return value.sources.every(source => source.schemaVersion === 2);
}

/**
 * Verifies that every source covers this tool call and that the result it produced is
 * the result the source was taken for. Volatile sources deliberately withhold labels
 * and are checked only for the call they belong to.
 */
function assertV2Provenance(group: z.infer<typeof completeToolGroupV2Schema>): void {
  const callId = group.assistant.tool_calls[0].id;
  let content: unknown;
  try { content = JSON.parse(group.result.content); } catch { incomplete(); }
  const parsed = calendarResultV2Schema.safeParse(content);
  if (!parsed.success) incomplete();
  const result = parsed.data;
  for (const source of group.sources) {
    if (!source.toolCallIds.includes(callId)) incomplete();
    if (source.permission.content !== 'retained') continue;
    const targets = 'target' in result ? [result.target]
      : result.tool === 'calendar_list_calendars'
        ? result.calendars.map(calendar => ({ calendarId: calendar.calendarId, calendarLabel: calendar.label }))
        : result.calendars;
    if (!targets.every(target => source.targets.some(known => known.calendarId === target.calendarId
      && known.calendarLabel === target.calendarLabel))) incomplete();
    if (result.tool === 'calendar_check_availability'
      && (source.calendarSetHash !== result.calendarSetHash
        || source.availabilityRevision !== result.availabilityRevision
        || source.discoveryRevision !== result.discoveryRevision)) incomplete();
  }
}

function contextLimit(message = 'This chat has reached its context limit. Start a new chat.'): never {
  throw new AppError('CONTEXT_BUDGET_EXCEEDED', message, false);
}

function assertGroups(input: CalendarContextInput): {
  groups: CompatibleCalendarToolGroup[];
  historicalGroups: { turnId: string; groups: CompatibleCalendarToolGroup[] }[];
} {
  if (input.groups.length > input.limits.modelDispatches) contextLimit();
  const historical = input.compatibility === 'historical';
  const ids = new Set<string>();
  const sourceIds = new Set<string>();
  const volatile = input.volatileSourceIds ?? new Set<string>();
  const validate = (candidates: readonly CompatibleCalendarToolGroup[], allowVolatile: boolean,
    allowMemory: boolean): CompatibleCalendarToolGroup[] => {
    const parsed: CompatibleCalendarToolGroup[] = [];
    for (const group of candidates) {
      const value = compatibleToolGroupSchema.parse(group);
      const call = value.assistant.tool_calls[0];
      if (ids.has(call.id)) incomplete();
      ids.add(call.id);
      if (Buffer.byteLength(call.function.arguments, 'utf8') > input.limits.argumentBytes
        || Buffer.byteLength(value.result.content, 'utf8') > input.limits.resultBytes) contextLimit();
      // The opt-in memory pair is local evidence: current-turn only, never sourced.
      if (value.result.name === UPDATE_USER_MEMORY_TOOL_NAME) {
        if (!allowMemory || value.sources.length !== 0) incomplete();
        let args: unknown;
        let receipt: unknown;
        try {
          args = JSON.parse(call.function.arguments);
          receipt = JSON.parse(value.result.content);
        } catch { incomplete(); }
        updateUserMemoryArgumentsSchema.parse(args);
        updateUserMemoryReceiptSchema.parse(receipt);
        parsed.push(value);
        continue;
      }
      // An explicitly unavailable historical pair is not a validated API success or schema authority.
      if (value.result.content === UNAVAILABLE_HISTORY) {
        if (!historical || value.sources.length !== 0) incomplete();
        parsed.push(value);
        continue;
      }
      for (const source of value.sources) {
        if (sourceIds.has(source.sourceId)) incomplete();
        sourceIds.add(source.sourceId);
        if (source.connectionId !== input.binding.connectionId
          || source.connectionRevision !== input.binding.connectionRevision
          || source.redactedAt !== null) {
          incomplete();
        }
        if (source.permission.content === 'volatile') {
          if (!allowVolatile || !volatile.has(source.sourceId)) incomplete();
        } else if (Date.parse(source.expiresAt) <= input.now) {
          incomplete();
        }
      }
      const local = value.result.name === 'activate_skill' || value.result.name === 'show_canvas'
        || value.result.name === 'control_canvas' || value.result.name === 'get_environment'
        || (value.result.name === 'call_tool' && value.sources.length === 0);
      if (local) {
        if (value.sources.length !== 0) incomplete();
        let content: unknown;
        try { content = JSON.parse(value.result.content); } catch { incomplete(); }
        if (value.result.name === 'show_canvas') {
          if (!canvasNavigationResultSchema.safeParse(content).success) incomplete();
          parsed.push(value);
          continue;
        }
        if (value.result.name === 'control_canvas') {
          if (!canvasControlResultSchema.safeParse(content).success) incomplete();
          parsed.push(value);
          continue;
        }
        if (value.result.name === 'get_environment') {
          if (!getEnvironmentResultSchema.safeParse(content).success) incomplete();
          parsed.push(value);
          continue;
        }
        const result = skillLocalResultSchema.safeParse(content);
        if (!result.success) incomplete();
        if (value.result.name === 'activate_skill' && result.data.kind === 'skill-disclosure') {
          let envelope: unknown;
          try { envelope = JSON.parse(call.function.arguments); } catch { incomplete(); }
          if (!envelope || typeof envelope !== 'object'
            || (envelope as { plugin?: unknown }).plugin !== result.data.plugin) incomplete();
        }
      } else if (isV2Group(value)) assertV2Provenance(value);
      else if (!historical) incomplete();
      parsed.push(value);
    }
    return parsed;
  };
  const groups = validate(input.groups, true, true);
  const historicalGroups: { turnId: string; groups: CompatibleCalendarToolGroup[] }[] = [];
  for (const [turnId, oldGroups] of input.historicalGroups ?? []) {
    if (oldGroups.length > input.limits.modelDispatches) contextLimit();
    historicalGroups.push({ turnId, groups: validate(oldGroups, false, false) });
  }
  return { groups, historicalGroups };
}

export function calendarContext(input: CalendarContextInput): CalendarContextOutput {
  const { groups, historicalGroups } = assertGroups(input);
  const last = input.context.messages.at(-1);
  if (!last || last.role !== 'user' || last.content !== input.acceptedInput) {
    throw new AppError('NOT_READY', 'Accepted chat context is unavailable.');
  }
  const positions = (input.context as Partial<PositionedContext>).historyPositions ?? [];
  const insertions = new Map<number, CompatibleCalendarToolGroup[]>();
  let withheldHistory = false;
  for (const { turnId, groups: oldGroups } of historicalGroups) {
    const usable: CompatibleCalendarToolGroup[] = [];
    for (const group of oldGroups) {
      if (group.result.content === UNAVAILABLE_HISTORY) withheldHistory = true;
      else usable.push(group);
    }
    if (usable.length === 0) continue;
    const origin = positions.find(position => position.turnId === turnId && position.role === 'user');
    if (!origin) incomplete();
    const after = positions.find(position => position.index > origin.index
      && (position.turnId !== turnId || position.role === 'assistant'));
    const index = after?.index ?? input.context.messages.length - 1;
    if (insertions.has(index)) incomplete();
    insertions.set(index, usable);
  }
  const web = webInsertions(input.context.messages.length, positions,
    input.historicalWebGroups ?? new Map());
  const candidates = input.foldableTurnIds?.size ? [] as HistoricalWebResult[] : undefined;
  const catalogIndex = (input.context as Partial<PositionedContext>).prefixCount
    ?? positions[0]?.index ?? input.context.messages.length - 1;
  const available = input.enabledPluginTools ?? CALENDAR_TOOLS;
  const catalog = available.length
    ? { ...compactSkillCatalog(available),
        ...(input.calendarConnection ? { connection: input.calendarConnection } : {}) }
    : [];
  const catalogMessage: NativeCalendarModelMessage = { role: 'system',
    content: 'Enabled plugin catalog (trusted application metadata):\n'
      + JSON.stringify(catalog) };
  const inventoryMessage: NativeCalendarModelMessage | null =
    input.responseMode === 'voice' && input.canvasInventory
      ? { role: 'system', content: canvasTurnStateMessage(input.canvasInventory, input.canvasSelection ?? null) }
      : null;
  const prefix: CompositeNativeMessage[] = [];
  for (let index = 0; index < input.context.messages.length - 1; index++) {
    if (index === catalogIndex) prefix.push(catalogMessage);
    appendHistoricalWebGroups(prefix, web.get(index), candidates);
    for (const group of insertions.get(index) ?? []) prefix.push(group.assistant, group.result);
    prefix.push(input.context.messages[index]!);
  }
  if (catalogIndex === input.context.messages.length - 1) prefix.push(catalogMessage);
  appendHistoricalWebGroups(prefix, web.get(input.context.messages.length - 1), candidates);
  for (const group of insertions.get(input.context.messages.length - 1) ?? []) {
    prefix.push(group.assistant, group.result);
  }
  const canvasStateIndex = inventoryMessage ? prefix.length : undefined;
  if (inventoryMessage) prefix.push(inventoryMessage);
  const note = [input.note, withheldHistory ? HISTORY_WITHHELD_NOTE : null]
    .filter((value): value is string => Boolean(value)).join('\n') || null;
  const messages = rebuildCalendarMessages({
    prefix,
    acceptedInput: { role: 'user', content: input.acceptedInput },
    groups,
  }, input.repair, note);
  // The fixed prefix ends with the plugin catalog at the assembler's explicit
  // boundary. The voice Canvas slot is fixed overhead but lives after history,
  // immediately before the accepted input, so it is excluded from the history
  // estimate instead of moving the prefix boundary.
  const assemblerPrefix = Math.min(
    (input.context as Partial<PositionedContext>).prefixCount ?? 0,
    input.context.messages.length - 1,
  );
  // Compatibility: the old unpositioned fallback could count the catalog and
  // inventory as history. Preserve that slice if the old Canvas slot was in it.
  const legacyCanvasCharged = inventoryMessage !== null && catalogIndex > assemblerPrefix;
  const nativePrefixCount = assemblerPrefix + 1 + (legacyCanvasCharged ? 1 : 0);
  const historyBudgetExcludedIndex = legacyCanvasCharged ? undefined : canvasStateIndex;
  // One final native gate after historical Web and current groups are merged.
  // Transport per-group caps still apply to any result Stage 1 might project.
  const admission = {
    budgets: input.budgets, prefixCount: nativePrefixCount, historyBudgetExcludedIndex,
    historicalWebResults: candidates?.filter(({ group }) =>
      Buffer.byteLength(group.assistant.tool_calls[0].function.arguments, 'utf8') <= input.limits.argumentBytes &&
      Buffer.byteLength(group.result.content, 'utf8') <= input.limits.resultBytes),
    foldableTurnIds: input.foldableTurnIds,
  };
  const admitted = input.web
    ? webContext({ ...input.web, ...admission, calendarMessages: messages })
    : admitNativePrompt({ ...admission, messages,
        contextTokens: input.contextTokens ?? input.budgets.maxContextTokens,
        totalOverflowMessage: 'This chat has reached its context limit. Start a new chat.',
        tools: nativeToolDefinitions(input.tools) });
  return { ...admitted, loadedSkills: loadedSkillRevisions(admitted.messages), prefixCount: nativePrefixCount };
}
