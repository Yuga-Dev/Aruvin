/**
 * ============================================================================
 * FILE: task-planner.spec.ts
 * LOCATION: backend/test/model/task-planner.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the Task-mode planner call with deterministic SSE fixtures.
 *
 * ROLE IN PROJECT:
 *    Guards Phase A2 planning (docs/task-mode-and-flows/spec.md): server
 *    identity on the wire, task-plan accounting, and fail-to-normal-chat on
 *    malformed or failed planning. No live OpenRouter access.
 *
 * KEY COMPONENTS:
 *    - Valid plan: parsed, fenced JSON tolerated, user + accounting recorded.
 *    - Fallbacks: malformed JSON and provider rejection return plan null.
 *    - Cancellation: throws CANCELLED.
 * ============================================================================
 */

import type { AccountingRecord } from '../../src/contracts/metadata.js';
import { TaskPlanner, taskPlannerPrompt, type PlannerTool } from '../../src/model/task-planner.js';
import { config, limits } from './helpers.js';

const sse = (content: string, finish: 'stop' | 'length' = 'stop') => new Response(
  `data: ${JSON.stringify({ id: 'gen-plan-1', model: 'fixture/model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
  + `data: ${JSON.stringify({ id: 'gen-plan-1', choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage: { prompt_tokens: 300, completion_tokens: 60, cost: 0.0004 } })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } });

const PLAN = JSON.stringify({ goal: 'Book a planning call', steps: [
  { title: 'Check free slots next week', effect: 'read', tool: 'calendar' },
  { title: 'Create the event', effect: 'write', tool: 'calendar' },
  { title: 'Confirm the booking', effect: 'answer', tool: 'none' },
] });

function setup(fetcher: typeof fetch, tools: PlannerTool[] = ['calendar', 'web', 'environment']) {
  const saved: AccountingRecord[] = [];
  const planner = new TaskPlanner({ putAccounting: async r => { saved.push(r); }, fetcher,
    now: () => '2026-11-25T10:00:00.000Z' });
  const run = (signal = new AbortController().signal) => planner.plan({
    userId: 'aurvin-dev-user', sessionId: 'sess_1', turnId: 'turn_1', attemptId: 'att_1',
    request: 'Book a planning call with Priya next week', tools, config: config(), limits, signal });
  return { saved, run };
}

describe('TaskPlanner', () => {
  it('returns a bounded plan, sends the server user, and records task-plan accounting', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { saved, run } = setup(async (_url, init) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return sse(PLAN);
    });
    const { plan, settled } = await run();
    await settled;
    expect(plan?.steps.map(s => [s.id, s.effect])).toEqual([['s1', 'read'], ['s2', 'write'], ['s3', 'answer']]);
    expect(bodies[0].user).toBe('aurvin-dev-user');
    expect(bodies[0]).not.toHaveProperty('tools');
    // Same budget as a normal reply, not a small fixed cap (reasoning models need headroom).
    expect(bodies[0].max_tokens).toBe(Math.min(config().budgets.maxOutputTokens, limits.outputTokens));
    expect(saved.at(-1)).toMatchObject({ purpose: 'task-plan', attemptId: 'plan-att_1', outcome: 'completed' });
  });

  it('returns plan null and truncated accounting when the reply hits the output limit', async () => {
    const { saved, run } = setup(async () => sse(PLAN.slice(0, 40), 'length'));
    const { plan, settled } = await run();
    await settled;
    expect(plan).toBeNull();
    expect(saved.at(-1)?.outcome).toBe('truncated');
  });

  it('advertises only available tools and rejects a plan that names an unavailable one', async () => {
    const prompt = taskPlannerPrompt(['environment']);
    expect(prompt).toContain('- environment:');
    expect(prompt).not.toContain('- web:');
    expect(prompt).not.toContain('- calendar:');
    // PLAN uses calendar; with only environment available it must fall back to normal chat.
    const { run } = setup(async () => sse(PLAN), ['environment']);
    expect((await run()).plan).toBeNull();
  });

  it('relabels a tool-less "write" step as read so the card never implies a data change', async () => {
    const drafted = JSON.stringify({ goal: 'Draft an agenda', steps: [
      { title: 'Draft the agenda', effect: 'write', tool: 'none' },
      { title: 'Share the agenda', effect: 'answer', tool: 'none' },
    ] });
    const { run } = setup(async () => sse(drafted));
    expect((await run()).plan?.steps.map(step => step.effect)).toEqual(['read', 'answer']);
  });

  it('tolerates a code-fenced JSON reply', async () => {
    const { run } = setup(async () => sse('```json\n' + PLAN + '\n```'));
    expect((await run()).plan?.steps).toHaveLength(3);
  });

  it('returns plan null for malformed output so the turn runs as normal chat', async () => {
    const { run } = setup(async () => sse('Sure! Here is a plan: step one...'));
    expect((await run()).plan).toBeNull();
  });

  it('returns plan null and failed accounting when the provider rejects', async () => {
    const { saved, run } = setup(async () =>
      new Response(JSON.stringify({ error: { message: 'Bad request' } }), { status: 400 }));
    const { plan, settled } = await run();
    await settled;
    expect(plan).toBeNull();
    expect(saved.at(-1)?.outcome).toBe('failed');
  });

  it('throws CANCELLED when the turn is cancelled before planning', async () => {
    const controller = new AbortController();
    controller.abort();
    const { run } = setup(async () => sse(PLAN));
    await expect(run(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
