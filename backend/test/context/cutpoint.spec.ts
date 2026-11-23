/**
 * ============================================================================
 * FILE: cutpoint.spec.ts
 * LOCATION: backend/test/context/cutpoint.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Check whole-turn cutpoints, recent context, and bounded workflow pins.
 *
 * ROLE IN PROJECT:
 *    Uses already-projected native messages; no model, archive, or plugin
 *    discovery is required to protect a contiguous tail.
 *
 * KEY COMPONENTS:
 *    - Completed-turn and native-pair safety.
 *    - Three-turn/quarter-budget floor and bounded commitment pins.
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import { selectCompactionCutpoint, type CompactionTurn } from '../../src/context/cutpoint.js';

function turns(count = 10, size = 400): CompactionTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    turnId: `t${index}`, completed: true,
    sourceRange: { fromSequence: index * 10, toSequence: index * 10 + 9,
      fromEventId: `e${index * 10}`, toEventId: `e${index * 10 + 9}` },
    messages: [{ role: 'user', content: `Question ${index}` },
      { role: 'assistant', content: 'x'.repeat(size) }],
  }));
}

describe('compaction cutpoint', () => {
  it('cuts only completed turns and protects three turns or a quarter-budget tail', () => {
    const input = turns();
    const result = selectCompactionCutpoint(input, 10_000);
    expect(result).not.toBeNull();
    expect(result!.protectedTailStart).toBeLessThanOrEqual(7);
    expect(result!.sourceRange.toSequence).toBe(
      input[result!.protectedTailStart - 1].sourceRange.toSequence);
    expect(result!.compactedTurnIds).toEqual(
      input.slice(0, result!.protectedTailStart).map(turn => turn.turnId));
  });

  it('pins an affordable pending proposal or active research-chain origin', () => {
    const input = turns(10, 250);
    const plain = selectCompactionCutpoint(input, 10_000)!;
    const pinned = selectCompactionCutpoint(input, 10_000,
      { pinnedTurnIds: new Set(['t1']) })!;
    expect(pinned.protectedTailStart).toBe(1);
    expect(pinned.protectedTailStart).toBeLessThan(plain.protectedTailStart);
  });

  it('lets an oversized old task cross K rather than pinning an unbounded session', () => {
    const input = turns(20, 600);
    const result = selectCompactionCutpoint(input, 10_000,
      { pinnedTurnIds: new Set(['t0']) });
    expect(result).not.toBeNull();
    expect(result!.protectedTailStart).toBeGreaterThan(0);
  });

  it('never includes an in-flight turn or cuts an unmatched native tool loop', () => {
    const input = turns();
    input.push({ ...turns(1)[0], turnId: 'active', completed: false,
      sourceRange: { fromSequence: 100, toSequence: 109,
        fromEventId: 'e100', toEventId: 'e109' } });
    const result = selectCompactionCutpoint(input, 10_000)!;
    expect(result.compactedTurnIds).not.toContain('active');
    const call = { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'web1', type: 'function' as const,
      function: { name: 'web_tool' as const, arguments: '{"mode":"fetch","url":"https://example.test/a"}' },
    }] as const };
    const broken = turns();
    broken[0] = { ...broken[0], messages: [broken[0].messages[0], call] };
    expect(selectCompactionCutpoint(broken, 10_000)).toBeNull();
    broken[0] = { ...broken[0], messages: [broken[0].messages[0], call,
      { role: 'tool', tool_call_id: 'web1', name: 'web_tool',
        content: '{"url":"https://example.test/a","body":"result"}' },
      { role: 'assistant', content: 'Continue with the remaining URL.' }] };
    expect(selectCompactionCutpoint(broken, 10_000)).not.toBeNull();
  });

  it('keeps a giant newest turn whole and returns null when nothing safe can compact', () => {
    const input = turns(6, 100);
    input[5] = { ...input[5], messages: [{ role: 'user', content: 'x'.repeat(7000) },
      { role: 'assistant', content: 'ok' }] };
    expect(selectCompactionCutpoint(input, 10_000)!.protectedTailStart).toBe(5);
    expect(selectCompactionCutpoint(turns(2, 100), 10_000)).toBeNull();
  });

  it('allows settled failed turns with no assistant reply instead of wedging later compaction', () => {
    const input = turns();
    input[0] = { ...input[0], messages: [input[0].messages[0]] };
    expect(selectCompactionCutpoint(input, 10_000)!.compactedTurnIds).toContain('t0');
  });
});
