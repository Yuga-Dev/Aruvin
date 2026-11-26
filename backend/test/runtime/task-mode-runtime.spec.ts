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
 *    - A4: the snapshot is saved on the assistant message and returned with history.
 * ============================================================================
 */

import { textSnapshot } from '../model/config-snapshot.js';
import { textConfigFixture } from './text-config-fixture.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { FRAMES } from '../fixtures/openrouter/frames.js';
import type { StreamEnvelope } from '../../src/contracts/stream.js';
import type { ContextChatMessage } from '../../src/contracts/context.js';
import type { SaveEnvelope } from '../../src/chat-runtime/memory-first-foundation.js';
import { listMessagesResponseSchema, toVisibleMessage } from '../../src/contracts/api.js';

// The fixture turn has no web/calendar/environment tools, so the plan uses only "none".
const PLAN = JSON.stringify({ goal: 'Compare two venues', steps: [
  { title: 'List what matters for each venue', effect: 'read', tool: 'none' },
  { title: 'Write the comparison', effect: 'answer', tool: 'none' },
] });

const planFrame = (content: string) =>
  `data: ${JSON.stringify({ id: 'gen_plan', model: 'fixture/model', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
  + `data: ${JSON.stringify({ id: 'gen_plan', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 } })}\n\ndata: [DONE]\n\n`;

function harness(planReply: string) {
  const saved: SaveEnvelope[] = [];
  const h = textConfigFixture(textSnapshot(1, { maxOutputTokens: 2048 }, 'fixture/model', 'fixture-A'), deps => ({
    ...deps,
    memoryFirst: { save: async envelope => { saved.push(envelope); return { kind: 'confirmed' }; },
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
    return { events, ids };
  };
  return { h, saved, run: async (content: string, task?: true) => (await run(content, task)).events,
    runWithIds: run, chatBodies };
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
      const planMessages = answer.filter(m => m.role === 'system' && m.content.startsWith('Task mode:'));
      expect(planMessages).toHaveLength(1);
      // Numbered titles, not raw JSON with tool names the model could mistake for plugins.
      expect(planMessages[0].content).toContain('1. List what matters for each venue');
      expect(planMessages[0].content).not.toContain('"tool"');
      expect(answer.at(-1)).toEqual({ role: 'user', content: request });

      // Tool-less steps close as done when the answer completes.
      const steps = events.filter(e => e.type === 'task-step').map(e => `${e.stepId}:${e.status}`);
      expect(steps).toEqual(['s1:done', 's2:done']);
      const completed = events.find(e => e.type === 'completed');
      expect(completed?.type === 'completed' && completed.task?.steps.map(s => s.status)).toEqual(['done', 'done']);
    } finally { await h.dispose(); }
  });

  it('saves the final snapshot on the assistant message and returns it with history (A4)', async () => {
    const { h, saved, runWithIds } = harness(PLAN);
    try {
      const { events, ids } = await runWithIds('Compare the Grand Hall and the Lakeside venue', true);
      const completed = events.find(e => e.type === 'completed');
      const live = completed?.type === 'completed' ? completed.task : undefined;
      expect(live?.steps.map(s => s.status)).toEqual(['done', 'done']);

      // The memory-first save carries the same snapshot on the assistant record.
      await vi.waitFor(() => expect(saved.some(e => 'output' in e && e.output.task)).toBe(true));
      const envelope = saved.find(e => 'output' in e && e.output.task)!;
      const output = 'output' in envelope ? envelope.output : undefined;
      expect(output?.role).toBe('assistant');
      expect(output?.task).toEqual(live);

      // History from memory, and the archive read projection, both return it.
      const page = listMessagesResponseSchema.parse(
        h.runtime.memoryMessages(h.identity.userId, ids.sessionId, { cursor: null, limit: 20 }));
      expect(page.items.find(m => m.role === 'assistant')?.task).toEqual(live);
      expect(toVisibleMessage(output!).task).toEqual(live);
      expect(page.items.find(m => m.role === 'user')).not.toHaveProperty('task');
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
