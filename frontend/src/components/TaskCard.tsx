/**
 * ============================================================================
 * FILE: TaskCard.tsx
 * LOCATION: frontend/src/components/TaskCard.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Show a Task-mode plan, each step's status, step summaries, and Skip.
 *
 * ROLE IN PROJECT:
 *    Renders the live activeTask while streaming and the final snapshot on the
 *    completed message (docs/task-mode-and-flows/spec.md). Approval itself
 *    stays in the existing Calendar confirmation card.
 *
 * KEY COMPONENTS:
 *    - TaskCard: goal, ordered steps, text status labels (not color alone),
 *      a live-only Skip button per queued step with its own pending/error state,
 *      and a distinct notice when the task did not complete.
 * ============================================================================
 */

import { useState } from 'react'
import type { TaskOutcome, TaskSnapshot, TaskStepStatus } from '../api/task-protocol.ts'

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

const OUTCOME: Record<TaskOutcome, string> = {
  cancelled: 'Task stopped.',
  failed: 'Task could not finish.',
  interrupted: 'Task was interrupted. Retry to run it again.',
  budget_exceeded: 'Task reached its time or step limit.',
}

export function TaskCard({ task, onSkip }: { task: TaskSnapshot; onSkip?: (stepId: string) => Promise<void> }) {
  const [skipping, setSkipping] = useState<string | null>(null)
  const [skipError, setSkipError] = useState<string | null>(null)
  const byId = new Map(task.steps.map((s) => [s.stepId, s]))

  const skip = async (stepId: string) => {
    if (!onSkip || skipping) return
    setSkipping(stepId)
    setSkipError(null)
    try {
      await onSkip(stepId)
    } catch {
      setSkipError('Could not skip that step. It may already be running.')
    } finally {
      setSkipping(null)
    }
  }

  return (
    <section className="aurvin-task-card" aria-label="Task plan">
      <p className="aurvin-task-goal">
        <span className="aurvin-task-kicker">Task</span> {task.plan.goal}
      </p>
      <ol className="aurvin-task-steps" aria-live="polite">
        {task.plan.steps.map((step) => {
          const entry = byId.get(step.id)
          const status = entry?.status ?? 'queued'
          return (
            <li key={step.id} className="aurvin-task-step" data-status={status}>
              <span className="aurvin-task-mark" aria-hidden="true">{MARK[status]}</span>
              <span className="aurvin-task-title">{step.title}</span>
              <span className="aurvin-task-status">
                {LABEL[status]}
                {onSkip && status === 'queued' ? (
                  <button
                    type="button"
                    className="aurvin-task-skip"
                    disabled={skipping !== null}
                    onClick={() => void skip(step.id)}
                  >
                    {skipping === step.id ? 'Skipping…' : 'Skip'}
                  </button>
                ) : null}
              </span>
              {entry?.summary ? <span className="aurvin-task-summary">{entry.summary}</span> : null}
            </li>
          )
        })}
      </ol>
      {skipError ? <p className="aurvin-task-notice" role="alert">{skipError}</p> : null}
      {task.outcome ? <p className="aurvin-task-notice" role="status">{OUTCOME[task.outcome]}</p> : null}
    </section>
  )
}
