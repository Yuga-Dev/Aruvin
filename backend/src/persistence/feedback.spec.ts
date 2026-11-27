/**
 * ============================================================================
 * FILE: feedback.spec.ts
 * LOCATION: backend/src/persistence/feedback.spec.ts
 * ============================================================================
 * PURPOSE: Verify message feedback storage, HTTP guards, list enrichment and cleanup.
 * ROLE IN PROJECT: Deterministic fixture checks; native MongoDB is not exercised.
 * KEY COMPONENTS: Upsert/clear, ownership, saved-state, role checks, delete/purge, list resilience.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import { DEFAULT_BUDGETS } from '../contracts/budgets.js';
import { calendarMemory } from '../../test/persistence/calendar-multi-memory.js';
import { message, session } from '../../test/persistence/fixtures.js';
import { fixtureOptions } from '../../test/http/fixtures.js';
import { ChatHttpService } from '../http/chat-http.service.js';
import { FeedbackHttpService } from '../http/feedback-http.service.js';
import { MongoFeedback } from './feedback.js';
import { MongoMessages } from './messages.js';
import { MongoSessions } from './sessions.js';
import { key } from './records.js';

async function fixture() {
  const mem = calendarMemory();
  const messages = new MongoMessages(mem.store, DEFAULT_BUDGETS);
  // Fixture collections lack deleteMany; add an equality-only one for cleanup checks.
  const collection = mem.store.collection.bind(mem.store);
  vi.spyOn(mem.store, 'collection').mockImplementation(name => {
    const col = collection(name);
    col.deleteMany = (async (filter: Record<string, unknown>) => {
      let deletedCount = 0;
      for (const [id, row] of mem.rows(name)) {
        if (Object.entries(filter).every(([f, v]) =>
          v && typeof v === 'object' && '$ne' in v ? row[f] !== (v as { $ne: unknown }).$ne : row[f] === v)) {
          mem.rows(name).delete(id); deletedCount++;
        }
      }
      return { acknowledged: true, deletedCount };
    }) as unknown as typeof col.deleteMany;
    return col;
  });
  await messages.append(message(0));
  await messages.append(message(1));
  await messages.append({ ...message(2), completionStatus: 'streaming' });
  await messages.append({ ...message(3), completionStatus: 'failed' });
  const feedback = new MongoFeedback(mem.store, messages, DEFAULT_BUDGETS);
  return { ...mem, messages, feedback };
}
const feedbackRows = (f: Awaited<ReturnType<typeof fixture>>) =>
  [...f.rows('metadata').values()].filter(r => r.kind === 'message-feedback');

it('stores one feedback document per message and upserts changes', async () => {
  const f = await fixture();
  await expect(f.feedback.put('u1', 's1', 'm1', 'up')).resolves.toEqual({ messageId: 'm1', rating: 'up' });
  await f.feedback.put('u1', 's1', 'm1', 'down');
  const rows = feedbackRows(f);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ _id: key('feedback', 'u1', 's1', 'm1'), userId: 'u1', sessionId: 's1',
    messageId: 'm1', turnId: 't1', attemptId: 'a1', rating: 'down', kind: 'message-feedback' });
  expect(JSON.stringify(rows[0])).not.toContain('Hello');
  expect([...(await f.feedback.ratings('u1', 's1', ['m0', 'm1']))]).toEqual([['m1', 'down']]);
});

it('clearing feedback removes the rating', async () => {
  const f = await fixture();
  await f.feedback.put('u1', 's1', 'm1', 'up');
  await expect(f.feedback.put('u1', 's1', 'm1', null)).resolves.toEqual({ messageId: 'm1', rating: null });
  expect(feedbackRows(f)).toHaveLength(0);
});

it("rejects feedback for another user's message", async () => {
  const f = await fixture();
  await expect(f.feedback.put('u2', 's1', 'm1', 'up')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(feedbackRows(f)).toHaveLength(0);
});

it('rejects feedback for a message that is not saved yet', async () => {
  const f = await fixture();
  const options = fixtureOptions();
  options.feedback = { put: (u, s, m, r) => f.feedback.put(u, s, m, r) };
  const unsaved = { ...message(1, 'server-user'), messageId: 'm9' };
  options.runtime.memoryMessages = vi.fn(() => ({ items: [{ ...unsaved }], nextCursor: null, olderAvailable: false })) as never;
  const service = new FeedbackHttpService(options);
  // Durable lookup uses the fixture user, so the id is absent from storage and present in memory.
  await expect(service.put('s1', 'm9', { rating: 'up' })).rejects.toMatchObject({ code: 'MESSAGE_NOT_SAVED' });
  await expect(service.put('s1', 'm10', { rating: 'up' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('rejects feedback on a user or non-terminal message', async () => {
  const f = await fixture();
  for (const id of ['m0', 'm2', 'm3'])
    await expect(f.feedback.put('u1', 's1', id, 'up')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(feedbackRows(f)).toHaveLength(0);
});

it('session delete removes feedback documents', async () => {
  const f = await fixture();
  await f.feedback.put('u1', 's1', 'm1', 'up');
  const other = { ...message(1, 'u1', 's2') };
  await f.messages.append(other);
  await f.feedback.put('u1', 's2', 'm1', 'up');
  // Soft delete goes through the HTTP service, which clears ratings after archiving.
  const options = fixtureOptions();
  options.feedback = { put: (u, s, m, r) => f.feedback.put(u, s, m, r), removeSession: (u, s) => f.feedback.removeSession(u, s) };
  options.sessions.get = vi.fn(async () => null);
  await new ChatHttpService({ ...options, identity: { ...options.identity, resolve: () => ({ userId: 'u1' }) as never } }).deleteSession('s1');
  expect(feedbackRows(f).map(r => r.sessionId)).toEqual(['s2']);

  // Hard purge of a temporary chat already removes every non-accounting metadata kind, feedback included.
  const sessions = new MongoSessions(f.store, DEFAULT_BUDGETS);
  const _id = key('session', 'u1', 's2');
  f.rows('sessions').set(_id, { ...session('u1', 's2'), ephemeral: true, _id, _revision: 0 });
  await sessions.hardPurgeSession('u1', 's2');
  expect(feedbackRows(f)).toHaveLength(0);
});

it('message list survives a feedback read failure', async () => {
  const options = fixtureOptions();
  const items = [{ ...message(1, 'server-user'), messageId: 'm1' }].map(m => ({
    messageId: m.messageId, turnId: m.turnId, eventId: m.eventId, sequence: m.sequence, role: m.role,
    content: m.content, createdAt: m.createdAt, completionStatus: m.completionStatus, truncated: false }));
  options.messages.list = vi.fn(async () => ({ items, nextCursor: null, olderAvailable: false })) as never;
  options.feedback = { put: vi.fn(), ratings: vi.fn(async () => { throw new Error('read failed'); }) } as never;
  const service = new ChatHttpService(options);
  await expect(service.messages('s1', {})).resolves.toMatchObject({ items: [{ messageId: 'm1' }] });
  options.feedback = { put: vi.fn(), ratings: vi.fn(async () => new Map([['m1', 'up' as const]])) } as never;
  const listed = await service.messages('s1', {});
  expect(listed.items[0]?.feedback).toBe('up');
});
