/**
 * ============================================================================
 * FILE: task-chat-state.test.ts
 * LOCATION: frontend/src/features/chat/state/task-chat-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Task-mode protocol validation, reducer fencing, completion
 *    attachment, submit validation, and the rendered plan card.
 *
 * ROLE IN PROJECT:
 *    Client half of docs/task-mode-and-flows/spec.md Phase A: the stream
 *    events the backend emits are accepted exactly, scoped to the active
 *    turn, and shown on the assistant message.
 *
 * KEY COMPONENTS:
 *    - isStreamEvent task-plan / task-step / completed.task.
 *    - chatReducer TASK_EVENT, STREAM_COMPLETED, TASK_MODE_SET.
 *    - isSubmitTurnRequest task flag; MessageItem TaskCard markup.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isStreamEvent, isSubmitTurnRequest, type VisibleMessage } from '../../../api/protocol.ts';
import type { TaskPlanEvent, TaskStepEvent } from '../../../api/task-protocol.ts';
import { MessageItem } from '../../../components/MessageItem.tsx';
import { chatReducer, initialChatState } from './chat-reducer.ts';
import type { ChatState } from './chat-types.ts';

const planEvent: TaskPlanEvent = { type: 'task-plan', version: 1, taskId: 'att-t1', plan: {
  goal: 'Book a planning call', steps: [
    { id: 's1', title: 'Check free slots', effect: 'read', tool: 'calendar' },
    { id: 's2', title: 'Create the event', effect: 'write', tool: 'calendar' },
    { id: 's3', title: 'Confirm', effect: 'answer', tool: 'none' },
  ] } };
const step = (stepId: string, status: TaskStepEvent['status'], extra: Partial<TaskStepEvent> = {}): TaskStepEvent =>
  ({ type: 'task-step', version: 1, taskId: 'att-t1', stepId, status, ...extra });
const ids = { sessionId: 'session-1', turnId: 'turn-t1', attemptId: 'att-t1' };
const activeState = (): ChatState => ({ ...initialChatState, activeSessionId: 'session-1',
  activeTurnId: 'turn-t1', activeAttemptId: 'att-t1', isStreaming: true, streamText: 'Booked.' });

describe('task mode chat state', () => {
  it('accepts exact task events and rejects malformed ones', () => {
    expect(isStreamEvent(planEvent)).toBe(true);
    expect(isStreamEvent(step('s2', 'awaiting_approval', { proposalId: 'prop_1' }))).toBe(true);
    expect(isStreamEvent({ ...planEvent, extra: 1 })).toBe(false);
    expect(isStreamEvent(step('s9', 'done'))).toBe(false);
    expect(isStreamEvent({ ...step('s1', 'done'), status: 'paused' })).toBe(false);
    expect(isStreamEvent({ ...planEvent, plan: { ...planEvent.plan, steps: [] } })).toBe(false);
    const snapshot = { version: 1, taskId: 'att-t1', plan: planEvent.plan,
      steps: [{ stepId: 's1', status: 'done' }] };
    expect(isStreamEvent({ type: 'completed', assistantMessageId: 'msg_1', outcome: 'completed', task: snapshot })).toBe(true);
    expect(isStreamEvent({ type: 'completed', assistantMessageId: 'msg_1', outcome: 'completed', task: { bad: true } })).toBe(false);
  });

  it('fences task events to the active turn and attaches the plan to the completed message', () => {
    let s = chatReducer(activeState(), { type: 'TASK_EVENT', payload: { ...ids, event: planEvent } });
    expect(s.activeTask?.steps.map((x) => x.status)).toEqual(['queued', 'queued', 'queued']);
    s = chatReducer(s, { type: 'TASK_EVENT', payload: { ...ids, event: step('s1', 'running') } });
    expect(s.activeTask?.steps[0].status).toBe('running');
    for (const stale of [{ sessionId: 'other' }, { turnId: 'other' }, { attemptId: 'old' }]) {
      expect(chatReducer(s, { type: 'TASK_EVENT', payload: { ...ids, ...stale, event: step('s1', 'failed') } })).toBe(s);
    }
    s = chatReducer(s, { type: 'STREAM_COMPLETED', payload: { assistantMessageId: 'msg_1', outcome: 'completed' } });
    expect(s.activeTask).toBeNull();
    expect(s.messages.at(-1)?.task?.steps[0].status).toBe('running');
  });

  it('prefers the server snapshot on completion and toggles task mode', () => {
    const started = chatReducer(activeState(), { type: 'TASK_EVENT', payload: { ...ids, event: planEvent } });
    const snapshot = { version: 1 as const, taskId: 'att-t1', plan: planEvent.plan,
      steps: [{ stepId: 's1', status: 'done' as const }, { stepId: 's2', status: 'awaiting_approval' as const },
        { stepId: 's3', status: 'done' as const }] };
    const done = chatReducer(started, { type: 'STREAM_COMPLETED',
      payload: { assistantMessageId: 'msg_1', outcome: 'completed', task: snapshot } });
    expect(done.messages.at(-1)?.task).toEqual(snapshot);
    expect(chatReducer(initialChatState, { type: 'TASK_MODE_SET', payload: true }).taskMode).toBe(true);
  });

  it('allows only task: true on a submit request', () => {
    const base = { sessionId: null, content: 'Plan my week', idempotencyKey: 'key-12345678' };
    expect(isSubmitTurnRequest({ ...base, task: true })).toBe(true);
    expect(isSubmitTurnRequest({ ...base, task: false })).toBe(false);
    expect(isSubmitTurnRequest({ ...base, mode: 'task' })).toBe(false);
  });

  it('renders the plan with text status labels above the answer', () => {
    const message: VisibleMessage = { messageId: 'msg_1', turnId: 'turn-t1', eventId: 'evt_1', sequence: 2,
      role: 'assistant', content: 'Booked.', createdAt: '2026-11-25T10:00:00.000Z', completionStatus: 'completed',
      truncated: false, task: { version: 1, taskId: 'att-t1', plan: planEvent.plan,
        steps: [{ stepId: 's1', status: 'done' }, { stepId: 's2', status: 'awaiting_approval' },
          { stepId: 's3', status: 'done' }] } };
    const html = renderToStaticMarkup(createElement(MessageItem, { message }));
    expect(html).toContain('aria-label="Task plan"');
    expect(html).toContain('Book a planning call');
    expect(html).toContain('Needs your approval');
    expect(html.indexOf('Task plan')).toBeLessThan(html.indexOf('Booked.'));
  });
});
