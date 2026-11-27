/**
 * ============================================================================
 * FILE: task-tracker.spec.ts
 * LOCATION: backend/src/chat-runtime/task-tracker.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify inferred Task-mode step progress from tool activity events.
 *
 * ROLE IN PROJECT:
 *    Guards docs/task-mode-and-flows/spec.md §2.3 (no extra model calls):
 *    ordering, skipping, approval wait, and terminal closing.
 *
 * KEY COMPONENTS:
 *    - Ordered ticks, skipped steps, awaiting_approval, finish outcomes.
 * ============================================================================
 */


import { TaskBudget, TaskTracker } from './task-tracker.js';
import { TASK_LIMITS, taskSnapshotSchema, taskStepEventSchema, type TaskPlan } from '../contracts/task.js';

const plan: TaskPlan = { goal: 'Book a call and find venues', steps: [
  { id: 's1', title: 'Check free slots', effect: 'read', tool: 'calendar' },
  { id: 's2', title: 'Search venues', effect: 'read', tool: 'web' },
  { id: 's3', title: 'Check the weather', effect: 'read', tool: 'environment' },
  { id: 's4', title: 'Create the event', effect: 'write', tool: 'calendar' },
  { id: 's5', title: 'Summarize', effect: 'answer', tool: 'none' },
] };
// Every emitted event must satisfy the strict wire schema.
const ticks = (events: unknown[]) => events.map(e => taskStepEventSchema.parse(e)).map(e => `${e.stepId}:${e.status}`);

describe('TaskTracker', () => {
  it('ticks steps in order from matching tool activity and closes them on completion', () => {
    const t = new TaskTracker('task_1', plan);
    expect(ticks(t.observe({ type: 'delta' }))).toEqual([]);
    expect(ticks(t.observe({ type: 'calendar-progress' }))).toEqual(['s1:running']);
    expect(ticks(t.observe({ type: 'calendar-view' }))).toEqual([]);
    expect(ticks(t.observe({ type: 'web-activity' }))).toEqual(['s1:done', 's2:running']);
    expect(ticks(t.observe({ type: 'web-sources' }))).toEqual([]);
    expect(ticks(t.finish('completed'))).toEqual(['s2:done', 's3:skipped', 's4:skipped', 's5:done']);
  });

  it('closes a later same-family read step as done, but never an unconfirmed write', () => {
    const t = new TaskTracker('task_1', { goal: 'Weather and packing', steps: [
      { id: 's1', title: 'Read the date', effect: 'read', tool: 'environment' },
      { id: 's2', title: 'Read the weather', effect: 'read', tool: 'environment' },
      { id: 's3', title: 'Pack', effect: 'answer', tool: 'none' },
    ] });
    t.observe({ type: 'weather-view' });
    expect(ticks(t.finish('completed'))).toEqual(['s1:done', 's2:done', 's3:done']);
  });

  it('skips a step whose tool never ran when a later family appears', () => {
    const t = new TaskTracker('task_1', plan);
    expect(ticks(t.observe({ type: 'weather-view' }))).toEqual(['s1:skipped', 's2:skipped', 's3:running']);
  });

  it('marks a write step awaiting approval with the proposal and keeps it open on completion', () => {
    const t = new TaskTracker('task_1', plan);
    t.observe({ type: 'calendar-progress' });
    t.observe({ type: 'web-activity' });
    const wait = t.observe({ type: 'calendar-clarification', proposalId: 'prop_1' });
    expect(ticks(wait)).toEqual(['s2:done', 's3:skipped', 's4:awaiting_approval']);
    expect(wait.at(-1)?.proposalId).toBe('prop_1');
    expect(ticks(t.finish('completed'))).toEqual(['s5:done']);
    expect(t.snapshot().steps.map(s => s.status)).toEqual(['done', 'done', 'skipped', 'awaiting_approval', 'done']);
  });

  it('fails only the running step when the turn fails or is cancelled', () => {
    const t = new TaskTracker('task_1', plan);
    t.observe({ type: 'web-activity' });
    expect(ticks(t.finish('failed'))).toEqual(['s2:failed']);
    expect(t.snapshot().steps.map(s => s.status)).toEqual(['skipped', 'failed', 'queued', 'queued', 'queued']);
  });

  it('step summaries stay within 2 KB each and 8 KB total', () => {
    const wide: TaskPlan = { goal: 'Many steps', steps: Array.from({ length: 8 }, (_, i) => (
      { id: `s${i + 1}`, title: `Step ${i + 1}`, effect: 'read' as const, tool: i % 2 ? 'web' as const : 'calendar' as const })) };
    const t = new TaskTracker('task_1', wide);
    const summaries: string[] = [];
    for (let i = 0; i < 8; i++) {
      const events = [...t.observe({ type: i % 2 ? 'web-activity' : 'calendar-progress' })];
      for (const e of events) if (e.summary) summaries.push(e.summary);
      // Multi-byte text exercises the UTF-8 byte (not character) bound.
      t.observe({ type: 'delta', text: 'é€ summary text '.repeat(400) });
    }
    for (const e of t.finish('completed')) if (e.summary) summaries.push(e.summary);
    expect(summaries.length).toBeGreaterThan(0);
    for (const s of summaries) expect(Buffer.byteLength(s, 'utf8')).toBeLessThanOrEqual(TASK_LIMITS.maxStepSummaryBytes);
    expect(summaries.reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0)).toBeLessThanOrEqual(TASK_LIMITS.maxCarriedSummaryBytes);
    // 7 closed-by-next-step summaries would need 14 KB; the total cap must have truncated or dropped some.
    expect(summaries.length * TASK_LIMITS.maxStepSummaryBytes).toBeGreaterThan(TASK_LIMITS.maxCarriedSummaryBytes);
  });

  it('skip only affects a queued step, and observe never advances onto a skipped step', () => {
    const t = new TaskTracker('task_1', plan);
    expect(ticks(t.skip('s2'))).toEqual(['s2:skipped']);
    expect(() => t.skip('s2')).toThrow(/no longer/);
    expect(() => t.skip('s7')).toThrow(/not found/i);
    t.observe({ type: 'calendar-progress' });
    expect(() => t.skip('s1')).toThrow(/no longer/);
    // s2 (web) is skipped by the user, so web activity has no queued web step to advance to.
    expect(ticks(t.observe({ type: 'web-activity' }))).toEqual([]);
    expect(t.snapshot().steps.map(s => s.status)).toEqual(['running', 'skipped', 'queued', 'queued', 'queued']);
  });

  it('records a distinct terminal outcome in the snapshot', () => {
    for (const outcome of ['cancelled', 'failed', 'interrupted', 'budget_exceeded'] as const) {
      const t = new TaskTracker('task_1', plan);
      t.observe({ type: 'calendar-progress' });
      t.finish(outcome);
      const snap = taskSnapshotSchema.parse(t.snapshot());
      expect(snap.outcome).toBe(outcome);
      expect(snap.steps[0].status).toBe(outcome === 'cancelled' ? 'skipped' : 'failed');
    }
    const ok = new TaskTracker('task_1', plan);
    ok.finish('completed');
    expect(ok.snapshot()).not.toHaveProperty('outcome');
  });
});

describe('TaskBudget', () => {
  it('stops at the model-attempt limit', () => {
    const b = new TaskBudget(() => 0);
    for (let i = 0; i < TASK_LIMITS.maxModelAttemptsPerTask; i++) b.beforeAttempt();
    expect(() => b.beforeAttempt()).toThrow(/limit/);
    expect(b.exceeded).toBe(true);
  });
  it('stops at the wall-clock limit', () => {
    let now = 1_000;
    const b = new TaskBudget(() => now);
    b.beforeAttempt();
    now += TASK_LIMITS.maxTaskRunMs - 1;
    b.beforeAttempt();
    now += 1;
    expect(() => b.beforeAttempt()).toThrow(/limit/);
  });
});
