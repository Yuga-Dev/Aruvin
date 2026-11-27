/**
 * ============================================================================
 * FILE: task-mode-phase-a.spec.ts
 * LOCATION: backend/test/runtime/task-mode-phase-a.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Required Phase A checks for Task mode that need a tool-capable runtime:
 *    fallback, ordered steps, stop, one active task, interrupted + retry,
 *    task budgets, and the Skip route.
 *
 * ROLE IN PROJECT:
 *    docs/task-mode-and-flows/spec.md "Required checks". Real MemoryText over
 *    textConfigFixture with an environment tool; deterministic frames only.
 *
 * KEY COMPONENTS:
 *    - harness: planner + environment-tool + answer frames, event capture.
 *    - Cases use the exact spec check names.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { textConfigFixture } from './text-config-fixture.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { FRAMES } from '../fixtures/openrouter/frames.js';
import type { StreamEnvelope } from '../../src/contracts/stream.js';
import type { ContextChatMessage } from '../../src/contracts/context.js';
import { AppError } from '../../src/platform/errors/app-error.js';
import { TASK_LIMITS } from '../../src/contracts/task.js';
import { WEATHER_ATTRIBUTION } from '../../src/contracts/weather-view.js';
import type { WeatherProvider } from '../../src/environment/weather-service.js';

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = 'data: [DONE]\n\n';
const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const textFrame = (text: string, id = 'gen_text') =>
  event({ id, model: 'fixture/model', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })
  + event({ id, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.00001 } }) + done;
const envFrame = (id = 'env_1') => event({ id: 'gen_env', choices: [{ index: 0, delta: { tool_calls: [
  { index: 0, id, type: 'function', function: { name: 'get_environment', arguments: '{"include":["weather"],"location":"Tokyo"}' } }] },
finish_reason: 'tool_calls' }] }) + done;
const planOf = (steps: { title: string; effect: string; tool: string }[]) => JSON.stringify({ goal: 'Plan the day', steps });
const ENV_PLAN = planOf([
  { title: 'Read the local date and time', effect: 'read', tool: 'environment' },
  { title: 'Write the answer', effect: 'answer', tool: 'none' },
]);

type Frames = { plan: string; chat: (call: number) => Response };

const weather: WeatherProvider = { lookup: async () => ({ ok: true as const, resolvedLocation: { city: 'Tokyo', country: 'Japan' },
  units: 'metric' as const, current: { temperature: 16, apparentTemperature: 15, weatherCode: 0, condition: 'Clear sky' }, hourly: [],
  daily: [{ date: '2026-11-19', tempMax: 18, tempMin: 10, weatherCode: 0, condition: 'Clear sky' }], attribution: WEATHER_ATTRIBUTION }) };

function harness(frames: Frames) {
  const base = textSnapshot(1, { maxOutputTokens: 2048 }, 'fixture/model', 'fixture-A');
  const h = textConfigFixture({ ...base, modelLimits: { ...base.modelLimits!, tools: true } }, deps => ({
    ...deps, weatherProvider: weather,
    memoryFirst: { save: async e => ({ kind: 'saved', epoch: e.epoch, sessionId: e.sessionId, version: e.version, fence: e.fence }),
      policy: { ...PROPOSED_MEMORY_TEXT_POLICY, flushDelayMs: 5, shutdownDrainMs: 100, writeTimeoutMs: 500 } },
  }));
  let chatCalls = 0, planCalls = 0;
  h.fetcher.mockImplementation(async (url, init) => {
    if (!(url as string).includes('/chat/completions')) throw new Error('no network in fixtures');
    const body = JSON.parse(init?.body as string) as { messages: ContextChatMessage[] };
    if (body.messages[0]?.content.startsWith('You plan multi-step tasks')) {
      planCalls++;
      return sse(textFrame(frames.plan, 'gen_plan'));
    }
    return frames.chat(++chatCalls);
  });
  const execute = async (ids: { sessionId: string; turnId: string; attemptId: string }, events: StreamEnvelope['event'][],
    signal = new AbortController().signal, onEvent?: (e: StreamEnvelope['event']) => void | Promise<void>) => {
    await h.runtime.executeTurn({ userId: h.identity.userId, ...ids, signal,
      emit: async envelope => { events.push(envelope.event); await onEvent?.(envelope.event); } });
  };
  const submit = (content: string, key: string, sessionId: string | null = null, task = true) =>
    h.runtime.submitTurn({ identity: h.identity, sessionId, content, idempotencyKey: `task-${key}`, ...(task ? { task: true as const } : {}) });
  return { h, execute, submit, calls: () => ({ chat: chatCalls, plan: planCalls }) };
}

const steps = (events: StreamEnvelope['event'][]) =>
  events.filter(e => e.type === 'task-step').map(e => `${e.stepId}:${e.status}`);

describe('Task mode Phase A', () => {
  it('task plan with only an answer step falls back to a normal chat turn', async () => {
    const f = harness({ plan: planOf([{ title: 'Answer the question', effect: 'answer', tool: 'none' }]),
      chat: () => sse(FRAMES.normal) });
    try {
      const events: StreamEnvelope['event'][] = [];
      await f.execute(await f.submit('What is a venue?', 'answer-only-1'), events);
      expect(events.some(e => e.type === 'task-plan' || e.type === 'task-step')).toBe(false);
      expect(events.some(e => e.type === 'completed')).toBe(true);
      const completed = events.find(e => e.type === 'completed');
      expect(completed).not.toHaveProperty('task');
    } finally { await f.h.dispose(); }
  });

  it('read steps run without approval and stream task-step transitions in order', async () => {
    const f = harness({ plan: ENV_PLAN, chat: n => sse(n === 1 ? envFrame() : textFrame('It is morning.')) });
    try {
      const events: StreamEnvelope['event'][] = [];
      await f.execute(await f.submit('What time is it where I am?', 'read-order-1'), events);
      const types = events.map(e => e.type);
      expect(types.indexOf('task-plan')).toBeLessThan(types.indexOf('delta'));
      expect(steps(events)).toEqual(['s1:running', 's1:done', 's2:done']);
      expect(events.some(e => e.type === 'calendar-clarification')).toBe(false);
      const completed = events.find(e => e.type === 'completed');
      expect(completed?.type === 'completed' && completed.task?.outcome).toBeUndefined();
    } finally { await f.h.dispose(); }
  });

  it('stop during a running step cancels and keeps completed step summaries', async () => {
    const f = harness({ plan: ENV_PLAN, chat: n => sse(n === 1 ? envFrame() : textFrame('late')) });
    try {
      const events: StreamEnvelope['event'][] = [];
      const ids = await f.submit('What time is it?', 'stop-1');
      // Stop = the existing cancel route, issued once the first step is running.
      await f.execute(ids, events, undefined, async e => {
        if (e.type === 'task-step' && e.status === 'running')
          await f.h.runtime.cancelTurn({ identity: f.h.identity, ...ids });
      });
      expect(events.some(e => e.type === 'completed')).toBe(false);
      expect(events.find(e => e.type === 'error')).toBeDefined();
      const status = await f.h.runtime.getTurnStatus(f.h.identity.userId, ids.sessionId, ids.turnId);
      expect(status.status).toBe('cancelled');
    } finally { await f.h.dispose(); }
  });

  it('competing tabs keep one active task per session', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = harness({ plan: ENV_PLAN, chat: n => sse(n === 1 ? envFrame() : textFrame('ok')) });
    try {
      const first = await f.submit('Plan my morning', 'tabs-1');
      const events: StreamEnvelope['event'][] = [];
      const running = f.execute(first, events, undefined, async e => { if (e.type === 'task-plan') await gate; });
      await vi.waitFor(() => expect(events.some(e => e.type === 'task-plan')).toBe(true));
      // A second tab submitting while the task runs is refused; the first task is unaffected.
      await expect(f.submit('Plan my evening', 'tabs-2', first.sessionId)).rejects.toMatchObject({ code: 'CONFLICT_ACTIVE_TURN' });
      release();
      await running;
      expect(events.some(e => e.type === 'completed')).toBe(true);
    } finally { release(); await f.h.dispose(); }
  });

  it('crash mid-task reconciles to interrupted; retry creates a new attempt linked to the same input', async () => {
    const f = harness({ plan: ENV_PLAN, chat: n => sse(n === 1 ? envFrame() : textFrame('Recovered.')) });
    try {
      const events: StreamEnvelope['event'][] = [];
      const first = await f.submit('Plan my morning', 'crash-1');
      // A dropped connection / process stop aborts the in-flight task: interrupted, never silently resumed.
      const crash = new AbortController();
      await f.execute(first, events, crash.signal, e => { if (e.type === 'task-plan') crash.abort(); });
      expect(events.some(e => e.type === 'completed')).toBe(false);
      const status = await f.h.runtime.getTurnStatus(f.h.identity.userId, first.sessionId, first.turnId);
      expect(status.status).toBe('interrupted');

      const again = await f.h.runtime.retryTurn({ identity: f.h.identity, sessionId: first.sessionId, turnId: first.turnId,
        idempotencyKey: "task-crash-retry-1" });
      expect(again.turnId).toBe(first.turnId);
      expect(again.attemptId).not.toBe(first.attemptId);
      const retried: StreamEnvelope['event'][] = [];
      await f.execute(again, retried);
      // Retry keeps Task mode: it plans again and completes.
      expect(retried.some(e => e.type === 'task-plan')).toBe(true);
      expect(retried.some(e => e.type === 'completed')).toBe(true);
    } finally { await f.h.dispose(); }
  });

  it('task stops with budget-exceeded at the model-attempt or wall-clock limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = harness({ plan: ENV_PLAN, chat: n => {
      // The model dispatch finishes "late": the next dispatch is past the 3 minute task limit.
      if (n === 1) { vi.setSystemTime(Date.now() + TASK_LIMITS.maxTaskRunMs + 1_000); return sse(envFrame()); }
      return sse(textFrame('too late'));
    } });
    try {
      const events: StreamEnvelope['event'][] = [];
      const ids = await f.submit('Plan my morning', 'budget-1');
      await f.execute(ids, events);
      expect(f.calls().chat).toBe(1);
      expect(events.some(e => e.type === 'completed')).toBe(false);
      expect(events.find(e => e.type === 'error')).toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
    } finally { await f.h.dispose(); vi.useRealTimers(); }
  });

  it('skips a queued step through the runtime and rejects a bad attempt, an unknown step, and a stale step', async () => {
    const f = harness({ plan: planOf([
      { title: 'Read the local date and time', effect: 'read', tool: 'environment' },
      { title: 'Write the answer', effect: 'answer', tool: 'none' },
    ]), chat: n => sse(n === 1 ? envFrame() : textFrame('ok')) });
    try {
      const events: StreamEnvelope['event'][] = [];
      const ids = await f.submit('Plan my morning', 'skip-1');
      const command = { identity: f.h.identity, sessionId: ids.sessionId, turnId: ids.turnId, attemptId: ids.attemptId };
      // Not running yet: nothing to skip.
      await expect(f.h.runtime.skipTaskStep!(command, 's2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const outcomes: unknown[] = [];
      await f.execute(ids, events, undefined, e => {
        if (e.type !== 'task-plan') return;
        void (async () => {
          await f.h.runtime.skipTaskStep!({ ...command, attemptId: 'other-attempt' }, 's2').catch(x => outcomes.push((x as AppError).code));
          await f.h.runtime.skipTaskStep!(command, 's7').catch(x => outcomes.push((x as AppError).code));
          await f.h.runtime.skipTaskStep!(command, 's2').then(() => outcomes.push('skipped'));
          await f.h.runtime.skipTaskStep!(command, 's2').catch(x => outcomes.push((x as AppError).code));
        })();
      });
      expect(outcomes).toEqual(['CONFLICT_ACTIVE_TURN', 'NOT_FOUND', 'skipped', 'INVALID_REQUEST']);
      expect(steps(events)).toContain('s2:skipped');
      const completed = events.find(e => e.type === 'completed');
      expect(completed?.type === 'completed' && completed.task?.steps.find(s => s.stepId === 's2')?.status).toBe('skipped');
    } finally { await f.h.dispose(); }
  });
});
