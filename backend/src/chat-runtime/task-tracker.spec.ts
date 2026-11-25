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

import { taskStepEventSchema, type TaskPlan } from '../contracts/task.js';
import { TaskTracker } from './task-tracker.js';

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
});
