/**
 * ============================================================================
 * FILE: revision-history.spec.ts
 * LOCATION: backend/src/chat-runtime/revision-history.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove edit/regenerate exclusion and the ordered revise guards (Unit B, phase 1).
 *
 * ROLE IN PROJECT:
 *    Pins how superseded records stay out of model context and that history is
 *    never rewritten, using the real reference selection and manifest builder.
 *
 * KEY COMPONENTS:
 *    - Context tests: regenerate and edit selection through selectReferences.
 *    - Guard tests: reviseRefusal ordering, caps, no-op edit, compaction.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGETS } from '../contracts/budgets.js';
import { AppError } from '../platform/errors/app-error.js';
import { buildReferenceManifest, selectReferences } from '../context/reference-selection.js';
import { assets, record } from '../../test/context/fixtures.js';
import { contextRecords, reviseRefusal, supersededIds, type ReviseFacts, type RevisableRecord } from './history.js';

const u1 = record({ turnId: 't1', messageId: 'u1', eventId: 'eu1', sequence: 0, role: 'user', content: 'Q1' });
const a1 = record({ turnId: 't1', messageId: 'a1', eventId: 'ea1', sequence: 1, role: 'assistant', content: 'A1', completionStatus: 'completed', attemptId: 'att1' });
// Regenerate of t1: new attempt, new assistant superseding a1.
const a1b: RevisableRecord = { ...record({ turnId: 't1', messageId: 'a1b', eventId: 'ea1b', sequence: 3, role: 'assistant', content: 'A1b', completionStatus: 'completed', attemptId: 'att2' }), supersedes: 'a1' };
// Edit of t1: new turn t2 whose user message supersedes u1.
const u2: RevisableRecord = { ...record({ turnId: 't2', messageId: 'u2', eventId: 'eu2', sequence: 4, role: 'user', content: 'Q1 edited' }), supersedes: 'u1' };
const a2 = record({ turnId: 't2', messageId: 'a2', eventId: 'ea2', sequence: 5, role: 'assistant', content: 'A2', completionStatus: 'completed', attemptId: 'att3' });
// ponytail: contract strict schema lacks `supersedes` until Unit 0; strip it for the real builders. Remove in phase 2.
const plain = (rs: readonly RevisableRecord[]) => rs.map(({ supersedes: _s, ...rest }) => rest);
const ids = (r: readonly { messageId: string }[]) => r.map(x => x.messageId);
const req = (turnId: string, newUserInput: string) => ({ userId: 'u1', sessionId: 's1', turnId, newUserInput,
  responseMode: 'text' as const, environment: { timeZone: 'Etc/UTC', currentDate: '2026-10-06', dayOfWeek: 'Tuesday' } });

describe('superseded records and model context', () => {
  it('regenerate in flight: the turn own earlier answer would make selection inconsistent unless dropped', () => {
    const all = [u1, a1];
    const m = buildReferenceManifest('u1', 's1', 1, all, assets, DEFAULT_BUDGETS);
    expect(() => selectReferences(req('t1', 'Q1'), m, all, assets, DEFAULT_BUDGETS)).toThrow(AppError);
    const clean = plain(contextRecords(all, 't1'));
    const m2 = buildReferenceManifest('u1', 's1', 1, clean, assets, DEFAULT_BUDGETS);
    expect(selectReferences(req('t1', 'Q1'), m2, clean, assets, DEFAULT_BUDGETS)).toEqual([]);
    expect(ids(clean)).toEqual(['u1']);
  });
  it('next turn after a regenerate sees only the new answer, input exactly once', () => {
    const next = record({ turnId: 't3', messageId: 'u3', eventId: 'eu3', sequence: 6, role: 'user', content: 'Q3' });
    const clean = plain(contextRecords([u1, a1, a1b, next], 't3'));
    const m = buildReferenceManifest('u1', 's1', 2, clean, assets, DEFAULT_BUDGETS);
    expect(selectReferences(req('t3', 'Q3'), m, clean, assets, DEFAULT_BUDGETS).map(r => r.messageId)).toEqual(['u1', 'a1b']);
  });
  it('an edit hides the replaced turn: user message and every answer', () => {
    const all = [u1, a1, a1b, u2, a2];
    expect([...supersededIds(all)].sort()).toEqual(['a1', 'a1b', 'u1']);
    const clean = plain(contextRecords(all, 't2'));
    expect(ids(clean)).toEqual(['u2']);
    const m = buildReferenceManifest('u1', 's1', 3, clean, assets, DEFAULT_BUDGETS);
    expect(selectReferences(req('t2', 'Q1 edited'), m, clean, assets, DEFAULT_BUDGETS)).toEqual([]);
  });
  it('is a pure view: the archive array and its records are never modified', () => {
    const all = Object.freeze([u1, a1, a1b, u2, a2].map(r => Object.freeze(r)));
    contextRecords(all, 't2');
    expect(ids(all)).toEqual(['u1', 'a1', 'a1b', 'u2', 'a2']);
  });
  it('records without supersedes are untouched (retry behaviour unchanged)', () => {
    expect(ids(contextRecords([u1, a1], 't2'))).toEqual(['u1', 'a1']);
  });
});

const facts = (o: Partial<ReviseFacts> = {}): ReviseFacts => ({ kind: 'regenerate', epochMatches: true,
  targetTurnId: 't1', latestTurnId: 't1', targetSequence: 4, compactedThroughSequence: null,
  activeAttempt: false, attemptsOnTurn: 1, priorTerminal: true, isLiveOrCanvasOnly: false,
  originalContent: 'Q1', validate: () => undefined, ...o });
describe('reviseRefusal guard order', () => {
  it('allows a regenerate of a completed latest turn and an edit with new text', () => {
    expect(reviseRefusal(facts())).toBeNull();
    expect(reviseRefusal(facts({ kind: 'edit', newContent: 'Q1 edited' }))).toBeNull();
  });
  it('orders epoch, latest, compaction, active, cap', () => {
    const bad = facts({ epochMatches: false, latestTurnId: 'tX', targetSequence: 0, compactedThroughSequence: 5,
      activeAttempt: true, attemptsOnTurn: 5 });
    expect(reviseRefusal(bad)?.code).toBe('INTERRUPTED');
    expect(reviseRefusal({ ...bad, epochMatches: true })?.code).toBe('REVISION_NOT_LATEST');
    expect(reviseRefusal({ ...bad, epochMatches: true, latestTurnId: 't1' })?.code).toBe('REVISION_TOO_OLD');
    expect(reviseRefusal({ ...bad, epochMatches: true, latestTurnId: 't1', compactedThroughSequence: null })?.code).toBe('CONFLICT_ACTIVE_TURN');
    expect(reviseRefusal(facts({ attemptsOnTurn: 5 }))?.code).toBe('INVALID_REQUEST');
    expect(reviseRefusal(facts({ attemptsOnTurn: 4 }))).toBeNull();
  });
  it('bounds run before the no-op check and an unchanged edit is refused', () => {
    const validate = (c: string) => { if (c.length > 3) throw new AppError('INPUT_TOO_LARGE', 'The message is too large.'); };
    expect(() => reviseRefusal(facts({ kind: 'edit', newContent: 'too long', originalContent: 'too long', validate }))).toThrow(AppError);
    expect(reviseRefusal(facts({ kind: 'edit', newContent: 'Q1', originalContent: 'Q1' }))?.code).toBe('INVALID_REQUEST');
  });
  it('refuses live or canvas-only targets and an unfinished prior attempt', () => {
    expect(reviseRefusal(facts({ isLiveOrCanvasOnly: true }))?.code).toBe('INVALID_REQUEST');
    expect(reviseRefusal(facts({ priorTerminal: false }))?.code).toBe('CONFLICT_ACTIVE_TURN');
  });
});
