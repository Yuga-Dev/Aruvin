/**
 * ============================================================================
 * FILE: task.spec.ts
 * LOCATION: backend/src/contracts/task.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the Task mode contract bounds, planner parsing, and approval policy.
 *
 * ROLE IN PROJECT:
 *    Guards the shapes the task runner, stream, persistence and UI share
 *    (docs/task-mode-and-flows/spec.md, Phase A1).
 *
 * KEY COMPONENTS:
 *    - Planner parsing: valid, malformed, out-of-bounds, extra keys.
 *    - Events: strict, versioned, bounded summaries.
 *    - Approval: read-only allowlist, unknown tools fail closed.
 * ============================================================================
 */

import {
  TASK_LIMITS, isAnswerOnlyPlan, parsePlannerOutput, requiresApproval,
  taskPlanEventSchema, taskSnapshotSchema, taskStepEventSchema,
} from './task.js';

const planned = (steps: unknown[]) => JSON.stringify({ goal: 'Plan a call', steps });

describe('task contract', () => {
  it('parses planner output and assigns ordered step ids', () => {
    const plan = parsePlannerOutput(planned([
      { title: 'Check calendars', effect: 'read', tool: 'calendar' },
      { title: 'Create the event', effect: 'write', tool: 'calendar' },
      { title: 'Summarize', effect: 'answer', tool: 'none' },
    ]));
    expect(plan?.steps.map(s => s.id)).toEqual(['s1', 's2', 's3']);
    expect(plan?.steps[1].effect).toBe('write');
    expect(plan && isAnswerOnlyPlan(plan)).toBe(false);
  });

  it('recognizes an answer-only plan so the turn falls back to normal chat', () => {
    const plan = parsePlannerOutput(planned([{ title: 'Answer directly', effect: 'answer', tool: 'none' }]));
    expect(plan && isAnswerOnlyPlan(plan)).toBe(true);
  });

  it('returns null for malformed, oversized, extra-key or out-of-bounds output', () => {
    expect(parsePlannerOutput('not json')).toBeNull();
    expect(parsePlannerOutput(planned([]))).toBeNull();
    expect(parsePlannerOutput(planned(Array.from({ length: TASK_LIMITS.maxSteps + 1 },
      () => ({ title: 'x', effect: 'read', tool: 'web' }))))).toBeNull();
    expect(parsePlannerOutput(planned([{ title: 'x', effect: 'delete', tool: 'web' }]))).toBeNull();
    expect(parsePlannerOutput(planned([{ title: 'x', effect: 'read', tool: 'gmail' }]))).toBeNull();
    expect(parsePlannerOutput(planned([{ title: 'x'.repeat(TASK_LIMITS.maxStepTitleChars + 1), effect: 'read', tool: 'web' }]))).toBeNull();
    expect(parsePlannerOutput('{"goal":"g","steps":[{"title":"x","effect":"read","tool":"web"}],"__proto__":{}}')).toBeNull();
    expect(parsePlannerOutput(' '.repeat(TASK_LIMITS.maxPlannerOutputBytes + 1))).toBeNull();
  });

  it('accepts strict versioned events and rejects oversized summaries', () => {
    const plan = parsePlannerOutput(planned([{ title: 'Search', effect: 'read', tool: 'web' }]))!;
    expect(taskPlanEventSchema.parse({ type: 'task-plan', version: 1, taskId: 'task_1', plan })).toBeTruthy();
    const step = { type: 'task-step', version: 1, taskId: 'task_1', stepId: 's1', status: 'done', summary: 'ok' };
    expect(taskStepEventSchema.parse(step)).toBeTruthy();
    expect(taskStepEventSchema.safeParse({ ...step, stepId: 's9' }).success).toBe(false);
    expect(taskStepEventSchema.safeParse({ ...step, extra: true }).success).toBe(false);
    // Multi-byte text counts bytes, not characters.
    expect(taskStepEventSchema.safeParse({ ...step, summary: 'é'.repeat(1_500) }).success).toBe(false);
    expect(taskSnapshotSchema.parse({ version: 1, taskId: 'task_1', plan,
      steps: [{ stepId: 's1', status: 'done' }] })).toBeTruthy();
  });

  it('requires approval for writes and for any tool not known to be read-only', () => {
    expect(requiresApproval('calendar_list_events')).toBe(false);
    expect(requiresApproval('web_tool')).toBe(false);
    expect(requiresApproval('calendar_create_event')).toBe(true);
    expect(requiresApproval('gmail_send_message')).toBe(true);
  });
});
