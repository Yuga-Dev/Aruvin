/**
 * ============================================================================
 * FILE: web-context.ts
 * LOCATION: backend/src/context/web-context.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Merge complete web tool groups into composite native model history.
 *
 * ROLE IN PROJECT:
 *    Keeps the accepted input exactly once, preserves Calendar group order,
 *    reinserts historical web evidence at its originating turn, and admits the
 *    final serialized prompt, optionally projecting the newest stale Web result.
 *
 * KEY COMPONENTS:
 *    - webInsertions: Positioned historical groups using Calendar's rule.
 *    - insertWebGroups / appendHistoricalWebGroups: Append-only insertion.
 *    - webContext: Validated current-group merge and final native admission.
 *    - admitNativePrompt: Overflow-only, bounded in-memory Web projection.
 * ============================================================================
 */

import type { BudgetConfig } from '../contracts/budgets.js';
import { webToolGroupSchema, type WebToolGroup } from '../chat-runtime/memory-web-state.js';
import type { WebNativeMessage } from '../model/web-native.js';
import { AppError } from '../platform/errors/app-error.js';
import { foldHistoricalWebResult } from './tool-folding.js';
import { HISTORY_BUDGET_MESSAGE, estimateNativeHistoryTokens } from './context-budget.js';

export type WebHistoryPosition = { turnId: string; role: 'user' | 'assistant'; index: number };
export type HistoricalWebResult = { turnId: string; resultIndex: number; group: WebToolGroup };
export type WebContextInput = {
  calendarMessages: readonly WebNativeMessage[];
  webGroups: readonly WebToolGroup[];
  budgets: Pick<BudgetConfig, 'maxContextTokens' | 'maxOutputTokens' | 'modelMarginTokens'
    | 'maxMessagesInContext' | 'maxHistoryTokens'>;
  contextTokens: number;
  tools: readonly unknown[];
  /** Native prefix boundary; current web groups are history, not prefix. */
  prefixCount: number;
  /** Trusted single fixed-overhead slot excluded only from the history estimate. */
  historyBudgetExcludedIndex?: number;
  /** Validated historical Web groups with their actual wire result index. */
  historicalWebResults?: readonly HistoricalWebResult[];
  foldableTurnIds?: ReadonlySet<string>;
};
export type WebContextResult = {
  messages: readonly WebNativeMessage[];
  estimatedInputTokens: number;
  remainingContextTokens: number;
};

type NativeAdmission = Pick<WebContextInput,
  'budgets' | 'contextTokens' | 'tools' | 'prefixCount' | 'historyBudgetExcludedIndex'> & {
  messages: readonly WebNativeMessage[];
  historicalWebResults?: readonly HistoricalWebResult[];
  foldableTurnIds?: ReadonlySet<string>;
  totalOverflowMessage?: string;
};

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function incomplete(): never {
  throw new AppError('INVALID_REQUEST', 'Web tool results are incomplete.');
}

function contextLimit(message = 'This chat has reached its context limit. Start a new chat to continue.'): never {
  throw new AppError('CONTEXT_BUDGET_EXCEEDED', message, false);
}

/**
 * Map each historical turn's groups to the index of that turn's assistant
 * message (or the next turn's user, or the last message). This is the same
 * rule Calendar history uses, so web evidence lands before Calendar evidence
 * and both stay byte-stable across turns.
 */
export function webInsertions(
  messageCount: number,
  positions: readonly WebHistoryPosition[],
  historicalGroups: ReadonlyMap<string, readonly WebToolGroup[]>,
): Map<number, { turnId: string; groups: WebToolGroup[] }> {
  const insertions = new Map<number, { turnId: string; groups: WebToolGroup[] }>();
  for (const [turnId, groups] of historicalGroups) {
    if (!groups.length) continue;
    const parsed = groups.map(group => webToolGroupSchema.parse(group));
    const origin = positions.find(position => position.turnId === turnId && position.role === 'user');
    if (!origin) incomplete();
    const after = positions.find(position => position.index > origin.index
      && (position.turnId !== turnId || position.role === 'assistant'));
    const index = after?.index ?? messageCount - 1;
    if (insertions.has(index)) incomplete();
    insertions.set(index, { turnId, groups: parsed });
  }
  return insertions;
}

/** Append one historical turn's validated Web pairs; candidates follow the wire. */
export function appendHistoricalWebGroups(
  out: WebNativeMessage[],
  insertion: { turnId: string; groups: WebToolGroup[] } | undefined,
  candidates?: HistoricalWebResult[],
): void {
  if (!insertion) return;
  for (const group of insertion.groups) {
    out.push(group.assistant, group.result);
    candidates?.push({ turnId: insertion.turnId, group, resultIndex: out.length - 1 });
  }
}

/** Append-only historical insertion; never drops an older turn's evidence. */
export function insertWebGroups(
  messages: readonly WebNativeMessage[],
  positions: readonly WebHistoryPosition[],
  historicalGroups: ReadonlyMap<string, readonly WebToolGroup[]>,
  candidates?: HistoricalWebResult[],
): WebNativeMessage[] {
  const insertions = webInsertions(messages.length, positions, historicalGroups);
  if (!insertions.size) return [...messages];
  const out: WebNativeMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    appendHistoricalWebGroups(out, insertions.get(index), candidates);
    out.push(messages[index]!);
  }
  return out;
}

/**
 * Admit the already validated final native prompt. Only a history, total or
 * count overflow may project stale validated Web results, newest first, and
 * only up to the fourth-from-last user turn (active plus recent three).
 */
export function admitNativePrompt(input: NativeAdmission): WebContextResult {
  const { messages, budgets, prefixCount, tools } = input;
  const remainingContextTokens = Math.min(budgets.maxContextTokens, input.contextTokens)
    - budgets.maxOutputTokens - budgets.modelMarginTokens;
  const estimate = (m: readonly WebNativeMessage[]) => 64 + bytes({ messages: m, tools }) + m.length * 32;
  const overflow = (m: readonly WebNativeMessage[]) => ({
    history: estimateNativeHistoryTokens(m, prefixCount, input.historyBudgetExcludedIndex)
      - budgets.maxHistoryTokens,
    total: estimate(m) - remainingContextTokens,
  });
  const first = overflow(messages);
  const failure = (history: number): never =>
    contextLimit(history > 0 ? HISTORY_BUDGET_MESSAGE : input.totalOverflowMessage);
  const countTooLarge = messages.length > budgets.maxMessagesInContext;
  let needed = Math.max(first.history, first.total);
  if (needed <= 0 && !countTooLarge) {
    return { messages, estimatedInputTokens: first.total + remainingContextTokens, remainingContextTokens };
  }
  if (countTooLarge || !input.foldableTurnIds?.size || !input.historicalWebResults?.length) {
    return failure(first.history);
  }
  let tailStart = -1;
  let users = 0;
  for (let i = messages.length - 1; i >= prefixCount; i--) {
    if (messages[i].role === 'user' && ++users === 4) { tailStart = i; break; }
  }
  let projected: WebNativeMessage[] | undefined;
  for (const { group, resultIndex, turnId } of input.historicalWebResults.toReversed()) {
    if (resultIndex <= prefixCount || resultIndex >= tailStart || !input.foldableTurnIds.has(turnId)
      || messages[resultIndex] !== group.result || messages[resultIndex - 1] !== group.assistant) continue;
    const content = foldHistoricalWebResult(group);
    if (!content) continue;
    const result = { ...group.result, content };
    const saved = bytes(group.result) - bytes(result);
    if (saved <= 0) continue;
    (projected ??= [...messages])[resultIndex] = result;
    needed -= saved;
    if (needed <= 0) break;
  }
  if (projected) {
    const final = overflow(projected);
    if (final.history <= 0 && final.total <= 0) {
      return { messages: projected, estimatedInputTokens: final.total + remainingContextTokens, remainingContextTokens };
    }
    return failure(final.history);
  }
  return failure(first.history);
}

/**
 * Insert the current accepted turn's web groups after its user input. Historical
 * groups arrive already positioned in `calendarMessages`; only the current turn
 * is merged here, so the accepted input never appears twice.
 */
export function webContext(input: WebContextInput): WebContextResult {
  const groups = input.webGroups.map(group => webToolGroupSchema.parse(group));
  const calendarIds = new Set<string>();
  for (const message of input.calendarMessages) {
    // Historical web pairs are positionally paired and may legitimately reuse an
    // id across turns; only a same-request Calendar collision is ambiguous.
    if ('tool_calls' in message) for (const call of message.tool_calls) {
      if (call.function.name !== 'web_tool') calendarIds.add(call.id);
    }
  }
  const ids = new Set<string>();
  for (const group of groups) {
    const id = group.assistant.tool_calls[0].id;
    if (ids.has(id) || calendarIds.has(id)) incomplete();
    ids.add(id);
  }
  const messages: WebNativeMessage[] = [...input.calendarMessages];
  let anchor = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { anchor = i + 1; break; }
  }
  const inserted: WebNativeMessage[] = [];
  for (const group of groups) inserted.push(group.assistant, group.result);
  messages.splice(anchor, 0, ...inserted);
  return admitNativePrompt({ ...input, messages });
}
