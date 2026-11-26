/**
 * ============================================================================
 * FILE: task-protocol.ts
 * LOCATION: frontend/src/api/task-protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Client mirror of the backend Task-mode stream contract (backend/src/contracts/task.ts).
 *
 * ROLE IN PROJECT:
 *    Strict validators so protocol.ts accepts task-plan / task-step events and
 *    the completed snapshot without importing server code
 *    (docs/task-mode-and-flows/spec.md).
 *
 * KEY COMPONENTS:
 *    - TaskPlan / TaskSnapshot / task events: types.
 *    - isTaskPlanEvent / isTaskStepEvent / isTaskSnapshot: exact-key validators.
 *    - applyTaskStep: Pure snapshot update used by the chat reducer.
 * ============================================================================
 */

export type TaskStepStatus = 'queued' | 'running' | 'awaiting_approval' | 'done' | 'skipped' | 'failed'
export type TaskStep = {
  id: string
  title: string
  effect: 'read' | 'write' | 'answer'
  tool: 'calendar' | 'web' | 'environment' | 'none'
}
export type TaskPlan = { goal: string; steps: TaskStep[] }
export type TaskSnapshot = {
  version: 1
  taskId: string
  plan: TaskPlan
  steps: { stepId: string; status: TaskStepStatus }[]
}
export type TaskPlanEvent = { type: 'task-plan'; version: 1; taskId: string; plan: TaskPlan }
export type TaskStepEvent = {
  type: 'task-step'
  version: 1
  taskId: string
  stepId: string
  status: TaskStepStatus
  summary?: string
  proposalId?: string
}

const MAX_STEPS = 8
const STATUSES: readonly string[] = ['queued', 'running', 'awaiting_approval', 'done', 'skipped', 'failed']
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((k) => k in v) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k))
const isId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 128
const isStepId = (v: unknown): v is string => typeof v === 'string' && /^s[1-8]$/.test(v)
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max

function isTaskStep(v: unknown): v is TaskStep {
  return isRecord(v) && exact(v, ['id', 'title', 'effect', 'tool']) && isStepId(v.id) && isText(v.title, 120) &&
    ['read', 'write', 'answer'].includes(v.effect as string) &&
    ['calendar', 'web', 'environment', 'none'].includes(v.tool as string)
}

export function isTaskPlan(v: unknown): v is TaskPlan {
  return isRecord(v) && exact(v, ['goal', 'steps']) && isText(v.goal, 300) && Array.isArray(v.steps) &&
    v.steps.length >= 1 && v.steps.length <= MAX_STEPS && v.steps.every(isTaskStep) &&
    new Set(v.steps.map((s: TaskStep) => s.id)).size === v.steps.length
}

export function isTaskPlanEvent(v: Record<string, unknown>): v is TaskPlanEvent {
  return exact(v, ['type', 'version', 'taskId', 'plan']) && v.version === 1 && isId(v.taskId) && isTaskPlan(v.plan)
}

export function isTaskStepEvent(v: Record<string, unknown>): v is TaskStepEvent {
  return exact(v, ['type', 'version', 'taskId', 'stepId', 'status'], ['summary', 'proposalId']) && v.version === 1 &&
    isId(v.taskId) && isStepId(v.stepId) && STATUSES.includes(v.status as string) &&
    (!('summary' in v) || (typeof v.summary === 'string' && v.summary.length <= 2048)) &&
    (!('proposalId' in v) || isId(v.proposalId))
}

export function isTaskSnapshot(v: unknown): v is TaskSnapshot {
  return isRecord(v) && exact(v, ['version', 'taskId', 'plan', 'steps']) && v.version === 1 && isId(v.taskId) &&
    isTaskPlan(v.plan) && Array.isArray(v.steps) && v.steps.length <= MAX_STEPS &&
    v.steps.every((s) => isRecord(s) && exact(s, ['stepId', 'status']) && isStepId(s.stepId) &&
      STATUSES.includes(s.status as string))
}

/** A fresh snapshot for a just-received plan: every step queued. */
export const snapshotForPlan = (event: TaskPlanEvent): TaskSnapshot => ({
  version: 1, taskId: event.taskId, plan: event.plan,
  steps: event.plan.steps.map((step) => ({ stepId: step.id, status: 'queued' as const })),
})

/** Apply one step event; events for another task are ignored. */
export function applyTaskStep(snapshot: TaskSnapshot, event: TaskStepEvent): TaskSnapshot {
  if (event.taskId !== snapshot.taskId) return snapshot
  return { ...snapshot, steps: snapshot.steps.map((s) => (s.stepId === event.stepId ? { ...s, status: event.status } : s)) }
}
