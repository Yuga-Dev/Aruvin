/**
 * ============================================================================
 * FILE: reference-selection.spec.ts
 * LOCATION: backend/test/context/reference-selection.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify scoped manifest validation, eligible history, and reference-only output.
 *
 * ROLE IN PROJECT:
 *    Ensures P3 restores role/order from sequence, excludes incomplete assistants,
 *    and never copies transcript text into constructed manifests.
 *
 * KEY COMPONENTS:
 *    - Selection tests: Order, eligibility, current-turn exactly-once identity.
 *    - Manifest tests: Bounded references, range envelope, duplicate rejection.
 * ============================================================================
 */

import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { selectReferences, buildReferenceManifest, validateManifest } from '../../src/context/reference-selection.js';
import { assets, history, manifest, record, request } from './fixtures.js';

describe('reference selection', () => {
  it('restores role/order from sequence, not timestamps or incoming array order', () => {
    expect(selectReferences(request, manifest(), [...history].reverse(), assets, DEFAULT_BUDGETS)
      .map((item) => item.messageId)).toEqual(['m1', 'm2']);
  });
  it.each(['streaming', 'truncated', 'failed', 'cancelled', 'interrupted'] as const)
    ('excludes %s assistant output but retains accepted original input', (completionStatus) => {
      const records = [history[0], record({ ...history[1], completionStatus,
        truncated: completionStatus === 'truncated' })];
      expect(selectReferences(request, manifest(records), records, assets, DEFAULT_BUDGETS)).toEqual([history[0]]);
    });
  it('removes only the current-turn input by identity, not repeated text from another turn', () => {
    const records = [record({ content: request.newUserInput }), record({
      messageId: 'm3', eventId: 'e3', sequence: 3, turnId: request.turnId,
      content: request.newUserInput,
    })];
    expect(selectReferences(request, manifest(records), records, assets, DEFAULT_BUDGETS))
      .toEqual([records[0]]);
  });
  it('builds bounded reference-only manifests with a range envelope and null summary', () => {
    const next = buildReferenceManifest('u1', 's1', 2, history, assets, DEFAULT_BUDGETS);
    expect(next).toEqual({ ...manifest(), contextVersion: 2 });
    expect(JSON.stringify(next)).not.toContain('Hello');
    expect(next.activeSummaryRef).toBeNull();
  });
  it('rejects duplicate sequence, event, or message identity even with matching text', () => {
    for (const duplicate of [record({ messageId: 'm3', eventId: 'e3' }),
      record({ sequence: 3, eventId: 'e3' }), record({ sequence: 3, messageId: 'm3' })]) {
      expect(() => selectReferences(request, manifest([history[0], duplicate]),
        [history[0], duplicate], assets, DEFAULT_BUDGETS)).toThrow('Chat context needs reconciliation before continuing.');
    }
  });
  it('keeps a summary reference and selects only the strictly newer tail', () => {
    const activeSummaryRef = { summaryId: 'sum1',
      sourceRange: { fromSequence: 0, toSequence: 9,
        fromEventId: 'old-first', toEventId: 'old-last' } };
    const tail = history.map(item => ({ ...item, sequence: item.sequence + 10 }));
    const next = buildReferenceManifest('u1', 's1', 2, tail, assets,
      DEFAULT_BUDGETS, activeSummaryRef);
    expect(next.activeSummaryRef).toEqual(activeSummaryRef);
    expect(next.sourceRanges).toEqual([{ fromSequence: 10, toSequence: 11,
      fromEventId: 'e1', toEventId: 'e2' }]);
    expect(selectReferences(request, next, tail, assets, DEFAULT_BUDGETS)).toEqual(tail);
    expect(buildReferenceManifest('u1', 's1', 3, [], assets,
      DEFAULT_BUDGETS, activeSummaryRef)).toMatchObject({
      activeSummaryRef, messageRefs: [], sourceRanges: [],
    });
  });
  it.each([8, 9])('rejects a tail overlapping a summary at sequence %s', sequence => {
    const value = { ...manifest([record({ sequence })]), activeSummaryRef: {
      summaryId: 'sum1', sourceRange: { fromSequence: 0, toSequence: 9,
        fromEventId: 'old-first', toEventId: 'old-last' },
    } };
    expect(() => validateManifest(value, request, assets, DEFAULT_BUDGETS))
      .toThrowError(expect.objectContaining({ code: 'NOT_READY' }));
  });
});
