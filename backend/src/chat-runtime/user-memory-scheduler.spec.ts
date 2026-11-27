/**
 * ============================================================================
 * FILE: user-memory-scheduler.spec.ts
 * LOCATION: backend/src/chat-runtime/user-memory-scheduler.spec.ts
 * PURPOSE: Verify passive memory batching and lifecycle with a virtual clock.
 * ROLE IN PROJECT: Proves no-op, retry, privacy, and cancellation boundaries.
 * KEY COMPONENTS: Idle debounce, eight-turn/compaction wake, and held writer.
 * ============================================================================
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UserMemoryScheduler, type PassiveTurn } from './user-memory-scheduler.js';

const idle = 120_000;
const u = 'memory-user';
const s = 'session-1';
function turn(n: number, fields: Partial<PassiveTurn> = {}): PassiveTurn {
  return { turnId: `t${n}`, messageId: `m${n}`, version: n, sequence: n * 3 - 2,
    userText: `User ${n}`, assistantText: `Assistant ${n}`, ...fields };
}
function fixture() {
  const synthesize = vi.fn<ConstructorParameters<typeof UserMemoryScheduler>[0]['synthesize']>()
    .mockResolvedValue({ changed: false });
  const publish = vi.fn<ConstructorParameters<typeof UserMemoryScheduler>[0]['publish']>()
    .mockResolvedValue(undefined);
  const enabled = vi.fn(() => true);
  const report = vi.fn();
  const scheduler = new UserMemoryScheduler({ enabled, synthesize, publish, report });
  return { scheduler, synthesize, publish, enabled, report };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('debounces for two minutes and advances only the finalized assistant sequence on no change', async () => {
  const f = fixture();
  f.scheduler.completed(u, s, -1, turn(1));
  await vi.advanceTimersByTimeAsync(idle - 1);
  f.scheduler.completed(u, s, -1, turn(2));
  await vi.advanceTimersByTimeAsync(idle - 1);
  expect(f.synthesize).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize).toHaveBeenCalledExactlyOnceWith(u, [
    { role: 'user', content: 'User 1' }, { role: 'assistant', content: 'Assistant 1' },
    { role: 'user', content: 'User 2' }, { role: 'assistant', content: 'Assistant 2' },
  ], expect.objectContaining({ sessionId: s, turnId: 't2' }));
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(u, s, turn(2), false, expect.any(AbortSignal));
  f.scheduler.completed(u, s, 4, turn(2)); // persisted watermark excludes replay
  await vi.advanceTimersByTimeAsync(idle);
  expect(f.synthesize).toHaveBeenCalledTimes(1);
});

it('kicks off only at eight user turns, and compaction can wake a shorter batch asynchronously', async () => {
  const f = fixture();
  for (let i = 1; i <= 7; i++) f.scheduler.completed(u, s, 0, turn(i));
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize).not.toHaveBeenCalled();
  f.scheduler.completed(u, s, 0, turn(8));
  expect(f.synthesize).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize.mock.calls[0]?.[1]).toHaveLength(16);
  f.scheduler.completed(u, s, turn(8).sequence, turn(9));
  f.scheduler.compacting(u, s);
  expect(f.synthesize).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize.mock.calls[1]?.[1]).toEqual([
    { role: 'user', content: 'User 9' }, { role: 'assistant', content: 'Assistant 9' },
  ]);
});

it('projects only safe full user text and 400 code points of assistant prose', async () => {
  const f = fixture();
  f.scheduler.completed(u, s, 0, turn(1, {
    userText: 'My whole response should remain intact. '.repeat(21).trim(),
    assistantText: '```ts\nPRIVATE_CODE\n```\n' + '😀'.repeat(405),
  }));
  f.scheduler.completed(u, s, 0, turn(2, { assistantText: '' })); // unknown/no voice heard
  f.scheduler.completed(u, s, 0, turn(3, {
    userText: 'sk-or-v1-fixture', assistantText: 'Never pair an answer with a secret.',
  }));
  f.scheduler.compacting(u, s);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize.mock.calls[0]?.[1]).toEqual([
    { role: 'user', content: 'My whole response should remain intact. '.repeat(21).trim() },
    { role: 'assistant', content: '😀'.repeat(400) },
    { role: 'user', content: 'User 2' },
  ]);
});

it('caps two failed jobs until a new eligible turn and never advances on synthesis failure', async () => {
  const f = fixture();
  f.synthesize.mockRejectedValueOnce(new Error('PRIVATE_WRITER_PAYLOAD'))
    .mockRejectedValueOnce(new Error('PRIVATE_WRITER_PAYLOAD'));
  f.scheduler.completed(u, s, 0, turn(1));
  await vi.advanceTimersByTimeAsync(idle * 3);
  f.scheduler.compacting(u, s);
  await vi.advanceTimersByTimeAsync(idle);
  expect(f.synthesize).toHaveBeenCalledTimes(2);
  expect(f.publish).not.toHaveBeenCalled();
  expect(JSON.stringify(f.report.mock.calls)).not.toContain('PRIVATE_WRITER_PAYLOAD');
  f.scheduler.completed(u, s, 0, turn(2));
  f.scheduler.compacting(u, s);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize).toHaveBeenCalledTimes(3);
  expect(f.publish.mock.calls[0]?.[2]).toEqual(turn(1));
  await vi.advanceTimersByTimeAsync(idle);
  expect(f.publish.mock.calls[1]?.[2]).toEqual(turn(2));
});

it('retries marker/watermark publication without rerunning a confirmed writer', async () => {
  const f = fixture();
  f.synthesize.mockResolvedValue({ changed: true });
  f.publish.mockRejectedValueOnce(new Error('unconfirmed archive'));
  f.scheduler.completed(u, s, 0, turn(1));
  await vi.advanceTimersByTimeAsync(idle * 2);
  expect(f.synthesize).toHaveBeenCalledTimes(1);
  expect(f.publish.mock.calls.map(call => call.slice(0, 4))).toEqual([
    [u, s, turn(1), true], [u, s, turn(1), true],
  ]);
});

it('cancels idle timers on close and revokes running work without late projection', async () => {
  const f = fixture();
  const held = Promise.withResolvers<{ changed: boolean }>();
  f.synthesize.mockReturnValueOnce(held.promise);
  f.scheduler.completed(u, s, 0, turn(1));
  f.scheduler.completed('other', s, 0, turn(1));
  f.scheduler.compacting(u, s);
  await vi.advanceTimersByTimeAsync(1);
  const signal = f.synthesize.mock.calls[0]![2].signal!;
  f.scheduler.deactivate(u);
  expect(signal.aborted).toBe(true);
  held.resolve({ changed: true });
  f.scheduler.close();
  await vi.advanceTimersByTimeAsync(idle * 3);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.synthesize).toHaveBeenCalledTimes(1);
});

it('does not start an idle synthesis once memory is disabled', async () => {
  const f = fixture();
  f.scheduler.completed(u, s, 0, turn(1));
  f.enabled.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(idle);
  expect(f.synthesize).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it('user delete drops queued passive turns and advances the watermark', async () => {
  const f = fixture();
  f.scheduler.completed(u, s, 0, turn(1));
  f.scheduler.completed(u, s, 0, turn(2));
  f.scheduler.completed('other', s, 0, turn(1));
  f.scheduler.userChanged(u);
  await vi.advanceTimersByTimeAsync(idle * 2);
  expect(f.synthesize).toHaveBeenCalledTimes(1); // only the other user's turn
  expect(f.synthesize.mock.calls[0]![0]).toBe('other');
  f.scheduler.completed(u, s, 0, turn(2)); // dropped turn is not replayed
  await vi.advanceTimersByTimeAsync(idle * 2);
  expect(f.synthesize).toHaveBeenCalledTimes(1);
  f.scheduler.completed(u, s, 0, turn(3)); // facts stated again later are learned again
  await vi.advanceTimersByTimeAsync(idle);
  expect(f.synthesize).toHaveBeenCalledTimes(2);
  expect(f.synthesize.mock.calls[1]![1]).toEqual([
    { role: 'user', content: 'User 3' }, { role: 'assistant', content: 'Assistant 3' }]);
});

it('user delete aborts a running batch and the slot keeps working afterwards', async () => {
  const f = fixture();
  const held = Promise.withResolvers<{ changed: boolean }>();
  f.synthesize.mockReturnValueOnce(held.promise);
  f.scheduler.completed(u, s, 0, turn(1));
  await vi.advanceTimersByTimeAsync(idle);
  const signal = f.synthesize.mock.calls[0]![2].signal!;
  f.scheduler.userChanged(u);
  expect(signal.aborted).toBe(true);
  f.scheduler.completed(u, s, 0, turn(2));
  held.resolve({ changed: true });
  await vi.advanceTimersByTimeAsync(idle * 2);
  expect(f.publish).toHaveBeenCalledTimes(1); // no late projection of the aborted batch
  expect(f.publish.mock.calls[0]![2]).toEqual(turn(2));
});
