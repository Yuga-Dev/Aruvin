/**
 * ============================================================================
 * FILE: task-mode-runtime.spec.ts
 * LOCATION: backend/test/runtime/task-mode-runtime.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Task mode end to end through the memory-first text runtime.
 *
 * ROLE IN PROJECT:
 *    Guards docs/task-mode-and-flows/spec.md Phase A: one planner call, plan
 *    streamed before the answer, plan given to the model as system data with
 *    the user's input unchanged, inferred step events, and a final snapshot.
 *    Deterministic fixtures only; no live OpenRouter.
 *
 * KEY COMPONENTS:
 *    - Task turn: plan event, plan context, closed steps, completed snapshot.
 *    - Fallbacks: no mode = no planner; malformed plan = ordinary chat.
 * ============================================================================
 */

import { textSnapshot } from '../model/config-snapshot.js';
import { textConfigFixture } from './text-config-fixture.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { FRAMES } from '../fixtures/openrouter/frames.js';
import type { StreamEnvelope } from '../../src/contracts/stream.js';
import type { ContextChatMessage } from '../../src/contracts/context.js';

const PLAN = JSON.stringify({ goal: 'Compare two venues', steps: [
  { title: 'Search both venues', effect: 'read', tool: 'web' },
  { title: 'Write the comparison', effect: 'answer', tool: 'none' },
] });

const planFrame = (content: string) =>
  `data: ${JSON.stringify({ id: 'gen_plan', model: 'fixture/model', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
  + `data: ${JSON.stringify({ id: 'gen_plan', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 } })}\n\ndata: [DONE]\n\n`;

function harness(planReply: string) {
  const h = textConfigFixture(textSnapshot(1, { maxOutputTokens: 2048 }, 'fixture/model', 'fixture-A'), deps => ({
    ...deps,
    memoryFirst: { save: async () => ({ kind: 'confirmed' }),
      policy: { ...PROPOSED_MEMORY_TEXT_POLICY, flushDelayMs: 5, shutdownDrainMs: 250, writeTimeoutMs: 500 } },
  }));
  let chat = 0;
  h.fetcher.mockImplementation(async (url, init) => {
    if (!(url as string).includes('/chat/completions')) throw new Error('no network in fixtures');
    const body = JSON.parse(init?.body as string) as { messages: ContextChatMessage[] };
    const planner = body.messages[0]?.content.startsWith('You plan multi-step tasks');
    return new Response(planner ? planFrame(planReply) : FRAMES.normal.replaceAll('gen_fixture', `gen_${++chat}`),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const chatBodies = () => h.fetcher.mock.calls
    .filter(([url]) => (url as string).includes('/chat/completions'))
    .map(([, init]) => JSON.parse(init?.body as string) as { user: string; tools?: unknown; messages: ContextChatMessage[] });
  const run = async (content: string, task?: true) => {
    const ids = await h.runtime.submitTurn({ identity: h.identity, sessionId: null, content,
      idempotencyKey: `task-request-${content.length}-${task ? 'task' : 'chat'}`, ...(task ? { task } : {}) });
    const events: StreamEnvelope['event'][] = [];
    await h.runtime.executeTurn({ userId: h.identity.userId, sessionId: ids.sessionId, turnId: ids.turnId,
      attemptId: ids.attemptId, signal: new AbortController().signal,
      emit: async envelope => { events.push(envelope.event); } });
    return events;
  };
  return { h, run, chatBodies };
}

describe('Task mode runtime', () => {
  it('plans once, streams the plan before the answer, and closes steps with a snapshot', async () => {
    const { h, run, chatBodies } = harness(PLAN);
    try {
      const request = 'Compare the Grand Hall and the Lakeside venue';
      const events = await run(request, true);
      const types = events.map(e => e.type);
      expect(types.indexOf('task-plan')).toBeGreaterThan(-1);
      expect(types.indexOf('task-plan')).toBeLessThan(types.indexOf('delta'));

      const bodies = chatBodies();
      expect(bodies).toHaveLength(2);
      expect(bodies[0].user).toBe(h.identity.userId);
      expect(bodies[0]).not.toHaveProperty('tools');
      const answer = bodies[1].messages;
      expect(answer.filter(m => m.role === 'system' && m.content.startsWith('Task mode:'))).toHaveLength(1);
      expect(answer.at(-1)).toEqual({ role: 'user', content: request });

      // No web activity happened, so the web step is skipped and the answer step done.
      const steps = events.filter(e => e.type === 'task-step').map(e => `${e.stepId}:${e.status}`);
      expect(steps).toEqual(['s1:skipped', 's2:done']);
      const completed = events.find(e => e.type === 'completed');
      expect(completed?.type === 'completed' && completed.task?.steps.map(s => s.status)).toEqual(['skipped', 'done']);
    } finally { await h.dispose(); }
  });

  it('does not call the planner for an ordinary chat turn', async () => {
    const { h, run, chatBodies } = harness(PLAN);
    try {
      const events = await run('Hello there');
      expect(chatBodies()).toHaveLength(1);
      expect(events.some(e => e.type === 'task-plan' || e.type === 'task-step')).toBe(false);
      expect(chatBodies()[0].messages.some(m => m.content.startsWith('Task mode:'))).toBe(false);
    } finally { await h.dispose(); }
  });

  it('runs a malformed plan as ordinary chat without task events', async () => {
    const { h, run, chatBodies } = harness('I would start by searching...');
    try {
      const events = await run('Compare two venues for me', true);
      expect(chatBodies()).toHaveLength(2);
      expect(events.some(e => e.type === 'task-plan' || e.type === 'task-step')).toBe(false);
      expect(events.some(e => e.type === 'completed')).toBe(true);
    } finally { await h.dispose(); }
  });
});
