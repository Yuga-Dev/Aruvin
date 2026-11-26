/**
 * ============================================================================
 * FILE: task.ts
 * LOCATION: backend/src/contracts/task.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Shared contract for Task mode: plan, step status events, limits, and the
 *    fail-closed approval registry.
 *
 * ROLE IN PROJECT:
 *    Phase A1 of docs/task-mode-and-flows/spec.md. The task runner, stream
 *    transport, persistence, and the chat UI all read these shapes; flows
 *    (Phase B) reuse the same plan/step contract with a definition-supplied plan.
 *
 * KEY COMPONENTS:
 *    - TASK_LIMITS: Accepted starting bounds (spec §2.6).
 *    - taskPlanSchema / parsePlannerOutput: Bounded plan; invalid output → null.
 *    - taskPlanEventSchema / taskStepEventSchema: Versioned stream events.
 *    - requiresApproval: Unknown tools require approval (fail closed).
 * ============================================================================
 */

import { z } from 'zod';
import { idSchema } from './identifiers.js';

export const TASK_EVENT_VERSION = 1 as const;

export const TASK_LIMITS = Object.freeze({
  maxSteps: 8,
  maxGoalChars: 300,
  maxStepTitleChars: 120,
  maxStepSummaryBytes: 2_048,
  maxCarriedSummaryBytes: 8_192,
  maxPlannerOutputBytes: 4_096,
  maxTaskRunMs: 180_000,
  maxFlowRunMs: 300_000,
  maxModelAttemptsPerTask: 12,
  flowApprovalWaitMs: 24 * 60 * 60 * 1000,
});

/** read: no external effect · write: external effect, needs approval · answer: final prose. */
export const taskStepEffectSchema = z.enum(['read', 'write', 'answer']);
export const taskStepStatusSchema = z.enum(['queued', 'running', 'awaiting_approval', 'done', 'skipped', 'failed']);
/** Tool family a step expects; progress is inferred from matching tool activity (spec §2.3). */
export const taskStepToolSchema = z.enum(['calendar', 'web', 'environment', 'none']);

const stepIdSchema = z.string().regex(/^s[1-8]$/);
const boundedSummary = z.string().max(TASK_LIMITS.maxStepSummaryBytes)
  .refine(s => Buffer.byteLength(s, 'utf8') <= TASK_LIMITS.maxStepSummaryBytes, 'Step summary is too large.');

export const taskStepSchema = z.object({
  id: stepIdSchema,
  title: z.string().trim().min(1).max(TASK_LIMITS.maxStepTitleChars),
  effect: taskStepEffectSchema,
  tool: taskStepToolSchema,
}).strict();

export const taskPlanSchema = z.object({
  goal: z.string().trim().min(1).max(TASK_LIMITS.maxGoalChars),
  steps: z.array(taskStepSchema).min(1).max(TASK_LIMITS.maxSteps),
}).strict().refine(p => new Set(p.steps.map(s => s.id)).size === p.steps.length, 'Step ids must be unique.');

export type TaskStep = z.infer<typeof taskStepSchema>;
export type TaskPlan = z.infer<typeof taskPlanSchema>;
export type TaskStepStatus = z.infer<typeof taskStepStatusSchema>;
export type TaskStepTool = z.infer<typeof taskStepToolSchema>;

export const taskPlanEventSchema = z.object({
  type: z.literal('task-plan'),
  version: z.literal(TASK_EVENT_VERSION),
  taskId: idSchema,
  plan: taskPlanSchema,
}).strict();

export const taskStepEventSchema = z.object({
  type: z.literal('task-step'),
  version: z.literal(TASK_EVENT_VERSION),
  taskId: idSchema,
  stepId: stepIdSchema,
  status: taskStepStatusSchema,
  summary: boundedSummary.optional(),
  proposalId: idSchema.optional(),
}).strict();

/** Final bounded snapshot stored with the assistant message for history replay. */
export const taskSnapshotSchema = z.object({
  version: z.literal(TASK_EVENT_VERSION),
  taskId: idSchema,
  plan: taskPlanSchema,
  steps: z.array(z.object({ stepId: stepIdSchema, status: taskStepStatusSchema }).strict()).max(TASK_LIMITS.maxSteps),
}).strict();

export type TaskPlanEvent = z.infer<typeof taskPlanEventSchema>;
export type TaskStepEvent = z.infer<typeof taskStepEventSchema>;
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

const plannerOutputSchema = z.object({
  goal: z.string(),
  steps: z.array(z.object({ title: z.string(), effect: taskStepEffectSchema, tool: taskStepToolSchema }).strict()),
}).strict();

/**
 * Parse the planner model's JSON text into a plan, assigning step ids s1..sN.
 * Returns null for anything malformed or out of bounds; the caller then runs a
 * normal chat turn instead (never a partially trusted plan).
 */
export function parsePlannerOutput(raw: string): TaskPlan | null {
  if (Buffer.byteLength(raw, 'utf8') > TASK_LIMITS.maxPlannerOutputBytes) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  const draft = plannerOutputSchema.safeParse(value);
  if (!draft.success) return null;
  const plan = taskPlanSchema.safeParse({
    goal: draft.data.goal,
    steps: draft.data.steps.map((step, i) => ({ id: `s${i + 1}`, title: step.title, effect: step.effect, tool: step.tool })),
  });
  return plan.success ? plan.data : null;
}

/** A plan that is just one answer gains nothing from a timeline (spec §2.2). */
export const isAnswerOnlyPlan = (plan: TaskPlan): boolean =>
  plan.steps.length === 1 && plan.steps[0].effect === 'answer';

/** Canonical tools known to have no external effect. Everything else needs approval. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'calendar_list_calendars', 'calendar_list_events', 'calendar_get_event', 'calendar_check_availability',
  'web_tool', 'get_environment', 'activate_skill', 'control_canvas', 'update_user_memory',
]);

/**
 * Backend approval policy for task steps (spec §2.4). Fail closed: a tool not
 * listed as read-only — including any tool added later — requires approval.
 */
export const requiresApproval = (canonicalToolName: string): boolean => !READ_ONLY_TOOLS.has(canonicalToolName);
