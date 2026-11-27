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
 *    - TaskTracker.observe: Tool activity → advance to the matching step; keeps a bounded step summary.
 *    - TaskTracker.skip: User skips a not-yet-started step.
 *    - TaskTracker.finish: Terminal outcome → close remaining steps.
 *    - TaskTracker.snapshot: Bounded final state for the completed event.
 *    - TaskBudget: Task-level wall-clock and model-attempt limits (spec §2.6).
 * ============================================================================
 */

import {
  TASK_EVENT_VERSION, TASK_LIMITS, type TaskOutcome, type TaskPlan, type TaskSnapshot, type TaskStepEvent,
  type TaskStepStatus, type TaskStepTool,
} from '../contracts/task.js';
import { AppError } from '../platform/errors/app-error.js';

/**
 * Task-level outer budget (spec §2.6): model attempts and wall-clock for the
 * whole task. Checked before every model dispatch, including the planner.
 * ponytail: checked between dispatches only; one in-flight dispatch is still
 * bounded by the turn's own run timeout, so the effective wall-clock is the
 * smaller of the two. Upgrade path: abort the job from a timer.
 */
export class TaskBudget {
  attempts = 0;
  exceeded = false;
  private readonly startedAt: number;
  constructor(private readonly now: () => number = Date.now, private readonly limits = TASK_LIMITS) {
    this.startedAt = now();
  }
  beforeAttempt(): void {
    if (this.attempts >= this.limits.maxModelAttemptsPerTask || this.now() - this.startedAt >= this.limits.maxTaskRunMs) {
      this.exceeded = true;
      throw new AppError('STORAGE_BUDGET_EXCEEDED', 'The task reached its time or step limit.', false);
    }
    this.attempts++;
  }
}

/** Last `max` UTF-8 bytes of `text`, trimmed; never a split character. */
function tailBytes(text: string, max: number): string {
  if (max <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  return (buf.length <= max ? text : buf.subarray(buf.length - max).toString('utf8').replace(/^�+/, '')).trim();
}

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
  private text = '';
  private summaryBytes = 0;
  private outcome: TaskOutcome | undefined;

  constructor(readonly taskId: string, readonly plan: TaskPlan) {
    this.status = plan.steps.map(() => 'queued');
  }

  observe(event: { type: string; proposalId?: unknown; text?: unknown }): TaskStepEvent[] {
    if (event.type === 'delta') {
      // Model-visible prose only (never reasoning); keep a bounded tail for the step summary.
      if (typeof event.text === 'string' && this.cursor >= 0 && this.status[this.cursor] === 'running')
        this.text = (this.text + event.text).slice(-2 * TASK_LIMITS.maxStepSummaryBytes);
      return [];
    }
    const tool = TOOL_BY_EVENT[event.type];
    if (!tool) return [];
    this.seen.add(tool);
    const out: TaskStepEvent[] = [];
    const current = this.cursor >= 0 ? this.plan.steps[this.cursor] : undefined;
    if (current?.tool !== tool || this.status[this.cursor] === 'awaiting_approval') {
      const next = this.plan.steps.findIndex((step, i) => i > this.cursor && step.tool === tool && this.status[i] === 'queued');
      if (next < 0) return [];
      this.closeBefore(next, out, true);
      this.cursor = next;
      this.text = '';
    }
    const step = this.plan.steps[this.cursor];
    // A proposal is a pending write whatever the plan labelled the step: never show it as done.
    if (event.type === 'calendar-clarification' && typeof event.proposalId === 'string') {
      this.set(this.cursor, 'awaiting_approval', out, event.proposalId);
    } else if (this.status[this.cursor] === 'queued') {
      this.set(this.cursor, 'running', out);
    }
    return out;
  }

  /** User skips a step that has not started. Skipped steps are never advanced to. */
  skip(stepId: string): TaskStepEvent[] {
    const i = this.plan.steps.findIndex(step => step.id === stepId);
    if (i < 0) throw new AppError('NOT_FOUND', 'Step not found.');
    if (this.status[i] !== 'queued') throw new AppError('INVALID_REQUEST', 'This step can no longer be skipped.', false);
    const out: TaskStepEvent[] = [];
    this.set(i, 'skipped', out);
    return out;
  }

  /**
   * completed: every unfinished step closes. Otherwise the running step fails
   * (cancelled: skipped), the rest stay queued, and the outcome is recorded.
   */
  finish(outcome: 'completed' | TaskOutcome): TaskStepEvent[] {
    const out: TaskStepEvent[] = [];
    this.outcome = outcome === 'completed' ? undefined : outcome;
    if (outcome === 'completed') this.closeBefore(this.plan.steps.length, out);
    else if (this.cursor >= 0 && this.status[this.cursor] === 'running')
      this.set(this.cursor, outcome === 'cancelled' ? 'skipped' : 'failed', out);
    return out;
  }

  snapshot(): TaskSnapshot {
    return { version: TASK_EVENT_VERSION, taskId: this.taskId, plan: this.plan,
      steps: this.plan.steps.map((step, i) => ({ stepId: step.id, status: this.status[i] })),
      ...(this.outcome ? { outcome: this.outcome } : {}) };
  }

  /**
   * Close steps before `end`: active → done; a tool-less step, or a read step
   * whose tool family was seen in use, → done; otherwise → skipped. A write step
   * never closes as done from activity alone (a read does not prove the change).
   * Only a step closed by the next step starting carries a summary; the last
   * step's prose is the final answer itself.
   */
  private closeBefore(end: number, out: TaskStepEvent[], summarize = false): void {
    for (let i = 0; i < end; i++) {
      const status = this.status[i];
      const step = this.plan.steps[i];
      if (status === 'running') this.set(i, 'done', out, undefined, summarize ? this.takeSummary() : undefined);
      else if (status === 'queued') {
        const used = step.tool === 'none' || (step.effect !== 'write' && this.seen.has(step.tool));
        this.set(i, used ? 'done' : 'skipped', out);
      }
    }
  }

  /** Bounded summary of the step that just ended: ≤ 2 KB, and ≤ 8 KB across the task. */
  private takeSummary(): string | undefined {
    const summary = tailBytes(this.text, Math.min(TASK_LIMITS.maxStepSummaryBytes,
      TASK_LIMITS.maxCarriedSummaryBytes - this.summaryBytes));
    this.text = '';
    this.summaryBytes += Buffer.byteLength(summary, 'utf8');
    return summary || undefined;
  }

  private set(index: number, status: TaskStepStatus, out: TaskStepEvent[], proposalId?: string, summary?: string): void {
    this.status[index] = status;
    out.push({ type: 'task-step', version: TASK_EVENT_VERSION, taskId: this.taskId,
      stepId: this.plan.steps[index].id, status, ...(proposalId ? { proposalId } : {}),
      ...(summary ? { summary } : {}) });
  }
}
