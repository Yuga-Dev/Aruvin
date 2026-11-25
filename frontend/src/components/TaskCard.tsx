/**
 * ============================================================================
 * FILE: TaskCard.tsx
 * LOCATION: frontend/src/components/TaskCard.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Show a Task-mode plan and each step's status inside an assistant message.
 *
 * ROLE IN PROJECT:
 *    Renders the live activeTask while streaming and the final snapshot on the
 *    completed message (docs/task-mode-and-flows/spec.md). Approval itself
 *    stays in the existing Calendar confirmation card.
 *
 * KEY COMPONENTS:
 *    - TaskCard: goal, ordered steps, text status labels (not color alone).
 * ============================================================================
 */

import type { TaskSnapshot, TaskStepStatus } from '../api/task-protocol.ts'

const LABEL: Record<TaskStepStatus, string> = {
  queued: 'Waiting',
  running: 'Working',
  awaiting_approval: 'Needs your approval',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
}

const MARK: Record<TaskStepStatus, string> = {
  queued: '○', running: '◐', awaiting_approval: '!', done: '✓', skipped: '–', failed: '×',
}

export function TaskCard({ task }: { task: TaskSnapshot }) {
  const statusOf = new Map(task.steps.map((s) => [s.stepId, s.status]))
  return (
    <section className="aurvin-task-card" aria-label="Task plan">
      <p className="aurvin-task-goal">
        <span className="aurvin-task-kicker">Task</span> {task.plan.goal}
      </p>
      <ol className="aurvin-task-steps" aria-live="polite">
        {task.plan.steps.map((step) => {
          const status = statusOf.get(step.id) ?? 'queued'
          return (
            <li key={step.id} className="aurvin-task-step" data-status={status}>
              <span className="aurvin-task-mark" aria-hidden="true">{MARK[status]}</span>
              <span className="aurvin-task-title">{step.title}</span>
              <span className="aurvin-task-status">{LABEL[status]}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
