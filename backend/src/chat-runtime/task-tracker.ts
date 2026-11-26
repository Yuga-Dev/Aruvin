/**
 * ============================================================================
 * FILE: task-tracker.ts
 * LOCATION: backend/src/chat-runtime/task-tracker.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Infer Task-mode step progress from the turn's existing tool activity.
 *
 * ROLE IN PROJECT:
 *    docs/task-mode-and-flows/spec.md §2.3: progress costs no extra model
 *    calls. MemoryText feeds every outgoing stream/calendar event through
 *    observe(); the tracker returns the task-step events to send.
 *
 * KEY COMPONENTS:
 *    - TaskTracker.observe: Tool activity → advance to the matching step.
 *    - TaskTracker.finish: Terminal outcome → close remaining steps.
 *    - TaskTracker.snapshot: Bounded final state for the completed event.
 * ============================================================================
 */

import {
  TASK_EVENT_VERSION, type TaskPlan, type TaskSnapshot, type TaskStepEvent, type TaskStepStatus, type TaskStepTool,
} from '../contracts/task.js';

/** Existing stream event types that prove activity of one tool family. */
const TOOL_BY_EVENT: Readonly<Record<string, TaskStepTool>> = {
  'calendar-progress': 'calendar', 'calendar-operation': 'calendar', 'calendar-view': 'calendar',
  'calendar-clarification': 'calendar', 'web-activity': 'web', 'web-sources': 'web', 'weather-view': 'environment',
};

/**
 * ponytail: progress is inferred, not reported by the model. Ceiling: a step is
 * matched by tool family only (same-family read steps close together), and a
 * tool call that emits no stream event (a date-only environment lookup) is
 * invisible, so its step can show skipped. Upgrade path is a model-reported
 * progress tool, which needs higher per-turn dispatch caps (spec §2.3).
 */
export class TaskTracker {
  private readonly status: TaskStepStatus[];
  private readonly seen = new Set<TaskStepTool>();
  private cursor = -1;

  constructor(readonly taskId: string, readonly plan: TaskPlan) {
    this.status = plan.steps.map(() => 'queued');
  }

  observe(event: { type: string; proposalId?: unknown }): TaskStepEvent[] {
    const tool = TOOL_BY_EVENT[event.type];
    if (!tool) return [];
    this.seen.add(tool);
    const out: TaskStepEvent[] = [];
    const current = this.cursor >= 0 ? this.plan.steps[this.cursor] : undefined;
    if (current?.tool !== tool || this.status[this.cursor] === 'awaiting_approval') {
      const next = this.plan.steps.findIndex((step, i) => i > this.cursor && step.tool === tool);
      if (next < 0) return [];
      this.closeBefore(next, out);
      this.cursor = next;
    }
    const step = this.plan.steps[this.cursor];
    if (event.type === 'calendar-clarification' && step.effect === 'write' && typeof event.proposalId === 'string') {
      this.set(this.cursor, 'awaiting_approval', out, event.proposalId);
    } else if (this.status[this.cursor] === 'queued') {
      this.set(this.cursor, 'running', out);
    }
    return out;
  }

  /** completed: every unfinished step closes; failed/cancelled: the running step fails, the rest stay queued. */
  finish(outcome: 'completed' | 'failed'): TaskStepEvent[] {
    const out: TaskStepEvent[] = [];
    if (outcome === 'completed') this.closeBefore(this.plan.steps.length, out);
    else if (this.cursor >= 0 && this.status[this.cursor] === 'running') this.set(this.cursor, 'failed', out);
    return out;
  }

  snapshot(): TaskSnapshot {
    return { version: TASK_EVENT_VERSION, taskId: this.taskId, plan: this.plan,
      steps: this.plan.steps.map((step, i) => ({ stepId: step.id, status: this.status[i] })) };
  }

  /**
   * Close steps before `end`: active → done; a tool-less step, or a read step
   * whose tool family was seen in use, → done; otherwise → skipped. A write step
   * never closes as done from activity alone (a read does not prove the change).
   */
  private closeBefore(end: number, out: TaskStepEvent[]): void {
    for (let i = 0; i < end; i++) {
      const status = this.status[i];
      const step = this.plan.steps[i];
      if (status === 'running') this.set(i, 'done', out);
      else if (status === 'queued') {
        const used = step.tool === 'none' || (step.effect !== 'write' && this.seen.has(step.tool));
        this.set(i, used ? 'done' : 'skipped', out);
      }
    }
  }

  private set(index: number, status: TaskStepStatus, out: TaskStepEvent[], proposalId?: string): void {
    this.status[index] = status;
    out.push({ type: 'task-step', version: TASK_EVENT_VERSION, taskId: this.taskId,
      stepId: this.plan.steps[index].id, status, ...(proposalId ? { proposalId } : {}) });
  }
}
