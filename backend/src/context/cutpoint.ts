/**
 * ============================================================================
 * FILE: cutpoint.ts
 * LOCATION: backend/src/context/cutpoint.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Choose a completed-turn compaction boundary with a protected verbatim tail.
 *
 * ROLE IN PROJECT:
 *    Runtime supplies terminal state and commitment pins from server memory.
 *    This helper never discovers workflows or reads storage.
 *
 * KEY COMPONENTS:
 *    - CompactionTurn: Already-projected messages belonging to one whole turn.
 *    - selectCompactionCutpoint: Recency floor and affordable pin expansion.
 * ============================================================================
 */
import type { SourceRange } from '../contracts/agent-memory.js';
import type { WebNativeMessage } from '../model/web-native.js';
import { estimateMessagesTokens } from './context-budget.js';

export type CompactionTurn = {
  turnId: string;
  sourceRange: SourceRange;
  messages: readonly WebNativeMessage[];
  completed: boolean;
};

function closed(turn: CompactionTurn): boolean {
  if (!turn.completed || turn.messages[0]?.role !== 'user') return false;
  const pending = new Set<string>();
  for (const message of turn.messages) {
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) return false;
    } else {
      if (pending.size) return false;
      if ('tool_calls' in message) for (const call of message.tool_calls) pending.add(call.id);
    }
  }
  return pending.size === 0;
}

export function selectCompactionCutpoint(
  turns: readonly CompactionTurn[],
  maxHistoryTokens: number,
  options: { minTailTurns?: number; pinnedTurnIds?: ReadonlySet<string>; targetTailTokens?: number } = {},
): { sourceRange: SourceRange; protectedTailStart: number; compactedTurnIds: string[] } | null {
  let completed = 0;
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    if (index > 0 && turn.sourceRange.fromSequence <= turns[index - 1].sourceRange.toSequence) return null;
    if (!closed(turn)) break;
    completed++;
  }
  if (completed < 2) return null;
  const tokens = (from: number) => estimateMessagesTokens(
    turns.slice(from, completed).flatMap(turn => [...turn.messages]));
  let start = completed - 1;
  const minimum = options.minTailTurns ?? 3;
  const tailTarget = options.targetTailTokens ?? maxHistoryTokens * 0.25;
  // ponytail: bounded working-set scans; replace with prefix sums only if the
  // runtime's existing <=250-turn working-set ceiling is lifted.
  while (start > 0 &&
      (completed - start < minimum || tokens(start) < tailTarget)) {
    if (tokens(start - 1) > maxHistoryTokens * 0.60) break;
    start--;
  }
  for (let index = start - 1; index >= 0; index--) {
    if (options.pinnedTurnIds?.has(turns[index].turnId) &&
        tokens(index) <= maxHistoryTokens * 0.50) start = index;
  }
  if (start === 0) return null;
  const first = turns[0].sourceRange;
  const last = turns[start - 1].sourceRange;
  return {
    sourceRange: { fromSequence: first.fromSequence, fromEventId: first.fromEventId,
      toSequence: last.toSequence, toEventId: last.toEventId },
    protectedTailStart: start,
    compactedTurnIds: turns.slice(0, start).map(turn => turn.turnId),
  };
}
