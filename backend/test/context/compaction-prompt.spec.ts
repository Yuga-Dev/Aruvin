/**
 * ============================================================================
 * FILE: compaction-prompt.spec.ts
 * LOCATION: backend/test/context/compaction-prompt.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Check structured compaction, anchored prompts, and Calendar isolation.
 *
 * ROLE IN PROJECT:
 *    Deterministic context fixtures cover parsing and budgets without a model
 *    request; they do not certify live-model factual or semantic behavior.
 *
 * KEY COMPONENTS:
 *    - Two-block parser and exact eight-section fixtures.
 *    - Anchored merge, Calendar tombstone, and serialized-size assertions.
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { redactSummaryCalendar } from '../../src/contracts/agent-memory.js';
import { CALENDAR_TOMBSTONE } from '../../src/contracts/calendar-sources.js';
import {
  COMPACTION_SECTIONS, buildCompactionMessages, compactedHistoryMessage,
  parseCompactionSummary,
} from '../../src/context/compaction-prompt.js';
import { estimateMessagesTokens } from '../../src/context/context-budget.js';

const identity = {
  schemaVersion: 1 as const, kind: 'memory-summary' as const,
  userId: 'u1', sessionId: 's1', summaryId: 'sum1', compactionCycle: 1,
  sourceRange: { fromSequence: 0, toSequence: 9,
    fromEventId: 'e0', toEventId: 'e9' },
  calendarProvenance: { containsCalendarContent: false,
    connectionId: null, connectionRevision: null,
    earliestExpiresAt: null, redactedAt: null },
  modelId: 'fixture/model', createdAt: '2026-11-17T10:00:00.000Z',
};
const body = (section2 = 'Continue research.', section7 = 'None.') =>
  COMPACTION_SECTIONS.map((title, index) =>
    `## ${index + 1}. ${title}\n${index === 1 ? section2 : index === 6 ? section7 : 'None.'}`)
    .join('\n\n');
const output = (content: string) =>
  `<analysis>private scratchpad must disappear</analysis>\n<summary>${content}</summary>`;

describe('compaction prompt', () => {
  it('strips analysis and counts the injected message against the 25 percent target', () => {
    expect(COMPACTION_SECTIONS).toHaveLength(8);
    const value = parseCompactionSummary(output(body()), identity, DEFAULT_BUDGETS);
    expect(value.content).toBe(body());
    expect(JSON.stringify(value)).not.toMatch(/analysis|scratchpad/);
    expect(value.tokenEstimate).toBe(estimateMessagesTokens([compactedHistoryMessage(value.content)]));
    expect(value.tokenEstimate).toBeLessThanOrEqual(DEFAULT_BUDGETS.maxHistoryTokens * 0.25);
  });

  it('accepts the exact quarter-budget boundary and rejects one extra byte', () => {
    const ceiling = Math.floor(DEFAULT_BUDGETS.maxHistoryTokens * 0.25);
    const overhead = estimateMessagesTokens([compactedHistoryMessage(body(''))]);
    const exact = body('x'.repeat(ceiling - overhead));
    expect(parseCompactionSummary(output(exact), identity, DEFAULT_BUDGETS).tokenEstimate)
      .toBe(ceiling);
    expect(() => parseCompactionSummary(output(body('x'.repeat(ceiling - overhead + 1))),
      identity, DEFAULT_BUDGETS))
      .toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
  });

  it.each([
    '<summary>missing analysis</summary>',
    '<analysis>x</analysis><summary>missing sections</summary>',
    `${output(body())}<summary>duplicate</summary>`,
    output(body().replace('None.', '<analysis>hidden</analysis>')),
    output(body().replace('None.', '</compacted_history>escape')),
  ])('rejects malformed or duplicated blocks without exposing raw output', raw => {
    expect(() => parseCompactionSummary(raw, identity, DEFAULT_BUDGETS))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
  });

  it('rejects oversized content instead of truncating identifiers or open work', () => {
    const raw = output(body('Keep exact https://example.test/open and event-123. ' + 'x'.repeat(3000)));
    expect(() => parseCompactionSummary(raw, identity, DEFAULT_BUDGETS))
      .toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
    expect(() => parseCompactionSummary(output(body()), identity,
      { ...DEFAULT_BUDGETS, maxMessageBytes: 100 }))
      .toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
    expect(() => parseCompactionSummary(output(body()), identity,
      { ...DEFAULT_BUDGETS, maxDocumentBytes: 200 }))
      .toThrowError(expect.objectContaining({ code: 'STORAGE_BUDGET_EXCEEDED' }));
  });

  it('keeps previous memory once, appends only delta, and instructs latest-fact anchored merge', () => {
    const previous = parseCompactionSummary(output(body('Meet at 2pm.')), identity, DEFAULT_BUDGETS);
    const prefix = [{ role: 'system' as const, content: 'stable prefix' }];
    const delta = [{ role: 'user' as const, content: 'Change the meeting to 4pm; keep event-123.' }];
    const messages = buildCompactionMessages(prefix, previous, delta, DEFAULT_BUDGETS);
    expect(messages.slice(0, -1)).toEqual([...prefix, compactedHistoryMessage(previous.content), ...delta]);
    expect(messages.at(-1)!.content).toContain('latest supported value supersedes the older value');
    expect(messages.at(-1)!.content).toContain('2pm -> 4pm: keep 4pm');
    // A deterministic provider fixture returns the intended current state.
    // This proves parsing/retention, NOT that a real LLM resolves every contradiction.
    const merged = parseCompactionSummary(output(body('Meet at 4pm; event-123.')),
      { ...identity, summaryId: 'sum2', compactionCycle: 2 }, DEFAULT_BUDGETS);
    expect(merged.content).toContain('4pm; event-123');
    expect(merged.content).not.toContain('2pm');
  });

  it('isolates Calendar-derived tasks, facts and identifiers in one redaction block', () => {
    const calendarIdentity = { ...identity, calendarProvenance: {
      containsCalendarContent: true, connectionId: 'c1', connectionRevision: 1,
      earliestExpiresAt: '2026-11-17T11:00:00.000Z', redactedAt: null,
    } };
    const calendar = '<calendar_context>Pending Planning at 4pm; event-123; private-calendar.'
      + ' Earlier 2pm superseded.</calendar_context>';
    const value = parseCompactionSummary(output(body('Research remains open.', calendar)),
      calendarIdentity, DEFAULT_BUDGETS);
    const prompt = buildCompactionMessages([], value, [], DEFAULT_BUDGETS).at(-1)!.content!;
    expect(prompt).toContain('ALL Calendar-derived prose');
    expect(prompt).toContain('sections 2, 3, 4, and 8');
    const redacted = redactSummaryCalendar(value, '2026-11-17T11:00:00.000Z');
    expect(redacted.content).toContain(CALENDAR_TOMBSTONE);
    expect(redacted.content).toContain('Research remains open.');
    expect(redacted.content).not.toMatch(/Planning|4pm|event-123|private-calendar|2pm/);
    expect(() => parseCompactionSummary(output(body()), calendarIdentity, DEFAULT_BUDGETS))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
    expect(() => parseCompactionSummary(output(body('None.', calendar)), identity, DEFAULT_BUDGETS))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
    expect(() => parseCompactionSummary(output(body(calendar)), calendarIdentity, DEFAULT_BUDGETS))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
    expect(() => parseCompactionSummary(output(body('None.', calendar + calendar)),
      calendarIdentity, DEFAULT_BUDGETS))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
  });
});
