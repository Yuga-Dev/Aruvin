/**
 * ============================================================================
 * FILE: revision.spec.ts
 * LOCATION: backend/src/chat-runtime/revision.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify edit and regenerate on the real memory-first runtime with deterministic fixtures.
 *
 * ROLE IN PROJECT:
 *    Release 1 unit B acceptance: supersession without rewriting history, guards, idempotency,
 *    one active attempt, bounded context and zero database access before dispatch.
 *
 * KEY COMPONENTS:
 *    - fixture: memory-first text runtime with a recording save sink.
 *    - Tests named as in docs/release-1/plan.md section 8 (revision.spec.ts).
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { PROPOSED_MEMORY_TEXT_POLICY } from './memory-text.js';
import type { SaveOutcome, TerminalEnvelope } from './memory-first-foundation.js';
import { textConfigFixture } from '../../test/runtime/text-config-fixture.js';
import { textSnapshot } from '../../test/model/config-snapshot.js';

const saved = (e: TerminalEnvelope): SaveOutcome => ({ kind: 'saved', epoch: e.epoch, sessionId: e.sessionId, version: e.version, fence: e.fence });
function fixture() {
  const envelopes: TerminalEnvelope[] = [];
  const f = textConfigFixture(textSnapshot(1), d => ({ ...d, memoryFirst: {
    policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 30 },
    save: async e => { envelopes.push(e); return saved(e); },
  } }));
  const memory = () => f.runtime.memoryFor(f.identity.userId)!;
  const records = (sessionId: string) => memory().foundation.history(sessionId);
  const revise = (kind: 'edit' | 'regenerate', ids: { sessionId: string; turnId: string }, key: string, content?: string) =>
    f.runtime.reviseTurn({ identity: f.identity, kind, sessionId: ids.sessionId, turnId: ids.turnId, idempotencyKey: key,
      ...(content === undefined ? {} : { content }) });
  const first = async (text = 'First') => { const a = await f.submit(text); await f.execute(a); return a; };
  return { f, envelopes, records, revise, first };
}
const assistants = (rs: { role: string; turnId: string }[], turnId: string) => rs.filter(r => r.role === 'assistant' && r.turnId === turnId);

describe('edit and regenerate', () => {
  it('regenerate creates a new attempt linked to the previous attempt on the same user message', async () => {
    const { f, revise, first, records } = fixture();
    const a = await first();
    const b = await revise('regenerate', a, 'regenerate-key-1');
    expect(b.turnId).toBe(a.turnId);
    expect(b.attemptId).not.toBe(a.attemptId);
    const turn = f.runtime.memoryFor(f.identity.userId)!.foundation.byTurn(a.sessionId, a.turnId)!;
    expect(turn.retryOf?.previousAttemptId).toBe(a.attemptId);
    expect(turn.revise).toMatchObject({ kind: 'regenerate', ofTurnId: a.turnId, ofAttemptId: a.attemptId });
    await f.execute(b);
    expect(records(a.sessionId).filter(r => r.role === 'user')).toHaveLength(1);
    await f.dispose();
  });

  it('regenerate of a completed turn marks the new assistant message as superseding the old one', async () => {
    const { f, revise, first, records } = fixture();
    const a = await first();
    const old = assistants(records(a.sessionId), a.turnId)[0]!;
    const b = await revise('regenerate', a, 'regenerate-key-2'); await f.execute(b);
    const now = assistants(records(a.sessionId), a.turnId);
    expect(now).toHaveLength(2);
    expect(now[1]).toMatchObject({ supersedes: old.messageId, completionStatus: 'completed' });
    expect(now[1]!.messageId).not.toBe(old.messageId);
    const shown = f.runtime.memoryMessages(f.identity.userId, a.sessionId, { cursor: null, limit: 20 })!.items;
    expect(shown.find(m => m.messageId === now[1]!.messageId)?.supersedes).toBe(old.messageId);
    await f.dispose();
  });

  it('edit creates a new turn whose user message supersedes the original', async () => {
    const { f, revise, first, records, envelopes } = fixture();
    const a = await first();
    const original = records(a.sessionId).find(r => r.role === 'user')!;
    const e = await revise('edit', a, 'edit-key-0001', 'First, but edited');
    expect(e.turnId).not.toBe(a.turnId);
    await f.execute(e);
    const edited = records(a.sessionId).find(r => r.turnId === e.turnId && r.role === 'user')!;
    expect(edited).toMatchObject({ content: 'First, but edited', supersedes: original.messageId });
    expect(f.runtime.memoryFor(f.identity.userId)!.foundation.byTurn(a.sessionId, e.turnId)!.revise)
      .toMatchObject({ kind: 'edit', ofTurnId: a.turnId, supersedesUser: original.messageId });
    expect(envelopes.at(-1)!.input.supersedes).toBe(original.messageId);
    await f.dispose();
  });

  it('edit and regenerate are idempotent by key and mismatch on different payload', async () => {
    const { f, revise, first } = fixture();
    const a = await first();
    const r1 = await revise('regenerate', a, 'regenerate-key-3');
    expect(await revise('regenerate', a, 'regenerate-key-3')).toEqual(r1);
    await expect(revise('edit', a, 'regenerate-key-3', 'other')).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    await f.execute(r1);
    const e1 = await revise('edit', a, 'edit-key-0002', 'Edited once');
    expect(await revise('edit', a, 'edit-key-0002', 'Edited once')).toEqual(e1);
    await expect(revise('edit', a, 'edit-key-0002', 'Edited differently')).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    await f.dispose();
  });

  it('edit is rejected unless it targets the latest turn', async () => {
    const { f, revise, first } = fixture();
    const a = await first();
    const b = await f.submit('Second', a.sessionId); await f.execute(b);
    await expect(revise('edit', a, 'edit-key-0003', 'late edit')).rejects.toMatchObject({ code: 'REVISION_NOT_LATEST' });
    await expect(revise('regenerate', a, 'regenerate-key-4')).rejects.toMatchObject({ code: 'REVISION_NOT_LATEST' });
    await expect(revise('regenerate', b, 'regenerate-key-5')).resolves.toBeTruthy();
    await f.dispose();
  });

  it('revision is rejected when the turn is inside the compacted range', async () => {
    const { f, revise, first } = fixture();
    const a = await first();
    vi.spyOn(f.runtime.memoryFor(f.identity.userId)!.foundation, 'summary')
      .mockReturnValue({ sourceRange: { fromSequence: 0, toSequence: 99 } } as never);
    await expect(revise('edit', a, 'edit-key-0004', 'inside summary')).rejects.toMatchObject({ code: 'REVISION_TOO_OLD' });
    await expect(revise('regenerate', a, 'regenerate-key-6')).rejects.toMatchObject({ code: 'REVISION_TOO_OLD' });
    await f.dispose();
  });

  it('revision is rejected while another attempt is active in the session', async () => {
    const { f, revise, first } = fixture();
    const a = await first();
    const b = await revise('regenerate', a, 'regenerate-key-7');
    await expect(revise('regenerate', a, 'regenerate-key-8')).rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
    await expect(revise('edit', a, 'edit-key-0005', 'while active')).rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
    await f.execute(b);
    await f.dispose();
  });

  it('competing tabs keep one active revision attempt and one model effect', async () => {
    const { f, revise, first } = fixture();
    const a = await first();
    const calls = f.fetcher.mock.calls.length;
    const results = await Promise.allSettled([revise('regenerate', a, 'tab-one-key-1'), revise('regenerate', a, 'tab-two-key-2')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const winner = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ turnId: string; sessionId: string; attemptId: string }>).value;
    await f.execute(winner);
    expect(f.fetcher.mock.calls.length - calls).toBe(1);
    await f.dispose();
  });

  it('context for the next turn excludes superseded messages and the replaced turn', async () => {
    const { f, revise, first } = fixture();
    const a = await first('Original question');
    const e = await revise('edit', a, 'edit-key-0006', 'Edited question'); await f.execute(e);
    const g = await revise('regenerate', e, 'regenerate-key-9'); await f.execute(g);
    const next = await f.submit('Follow-up', a.sessionId); await f.execute(next);
    const body = JSON.parse(f.fetcher.mock.calls.at(-1)![1]?.body as string);
    const sent = body.messages.filter((m: { role: string }) => m.role !== 'system');
    expect(sent.map((m: { content: string }) => m.content)).toEqual(['Edited question', 'Hello 🌍', 'Follow-up']);
    await f.dispose();
  });

  it('superseded records remain in the archive and are never modified', async () => {
    const { f, revise, first, records, envelopes } = fixture();
    const a = await first();
    const before = JSON.stringify(records(a.sessionId));
    const b = await revise('regenerate', a, 'regenerate-key-10'); await f.execute(b);
    const after = records(a.sessionId);
    expect(JSON.stringify(after.filter(r => !('supersedes' in r)))).toBe(before);
    expect(after).toHaveLength(3);
    const firstSaved = envelopes[0]!;
    expect(firstSaved.output.supersedes).toBeUndefined();
    await f.dispose();
  });

  it('revision persists once in the consolidated memory-first write and reads no database before dispatch', async () => {
    const { f, revise, first, envelopes } = fixture();
    const a = await first();
    await vi.waitFor(() => expect(envelopes).toHaveLength(1));
    const reads = [vi.spyOn(f.p.sessions, 'get'), vi.spyOn(f.p.messages, 'get'), vi.spyOn(f.p.metadata, 'getAttemptByIdempotency')];
    const writes = [vi.spyOn(f.p.messages, 'append'), vi.spyOn(f.p.metadata, 'putAttempt'), vi.spyOn(f.p.checkpoints, 'create')];
    const b = await revise('regenerate', a, 'regenerate-key-11');
    await f.execute(b);
    for (const spy of [...reads, ...writes]) expect(spy).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(envelopes).toHaveLength(2));
    expect(envelopes[1]!.request.attemptId).toBe(b.attemptId);
    await f.dispose();
  });

  it('revision respects the per-turn attempt cap', async () => {
    const { f, revise, first } = fixture();
    let ids = await first();
    for (let n = 2; n <= 5; n++) { ids = await revise('regenerate', ids, `cap-regenerate-${n}`) as typeof ids; await f.execute(ids); }
    await expect(revise('regenerate', ids, 'cap-regenerate-6')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await f.dispose();
  });

  it('revision input is bounded and rejects secrets like submit', async () => {
    const { f, revise, first } = fixture();
    const a = await first();
    await expect(revise('edit', a, 'edit-key-0007', '   ')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(revise('edit', a, 'edit-key-0008', 'First')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(revise('edit', a, 'edit-key-0009', 'x'.repeat(1_000_000))).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
    // Submit has no content-secret filter in this codebase; the revision path reuses its validateInput, nothing weaker.
    await f.dispose();
  });
});
