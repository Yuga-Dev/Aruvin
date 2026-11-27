/**
 * ============================================================================
 * FILE: task-mode-latency.spec.ts
 * LOCATION: backend/test/performance/task-mode-latency.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove a prepared Task-mode read step dispatches with application storage blocked.
 *
 * ROLE IN PROJECT:
 *    docs/task-mode-and-flows/spec.md required check "prepared task read steps
 *    dispatch with application storage blocked" (memory-first: the planner call,
 *    the plan stream, and the read tool add no database access). Deterministic
 *    fixture only; reuses the calendar-tool-latency assembled fixture.
 *
 * KEY COMPONENTS:
 *    - One task turn: planner wire, Calendar read, answer, with storage blocked.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import { calendarToolLatencyFixture } from './calendar-tool-latency-fixture.js';
import { loadWire, skillWire, textWire } from '../runtime/calendar-runtime.fixture.js';

it('prepared task read steps dispatch with application storage blocked', async () => {
  const f = await calendarToolLatencyFixture();
  const save = f.holdNextArchiveSave();
  let storageBlock: ReturnType<typeof f.blockStorage> | undefined;
  let failure: unknown;
  try {
    f.observeArchive();
    const plan = JSON.stringify({ goal: 'Check my calendars', steps: [
      { title: 'List the calendars', effect: 'read', tool: 'calendar' },
      { title: 'Summarize', effect: 'answer', tool: 'none' },
    ] });
    f.modelWires.push(
      textWire(plan),
      loadWire('calendar_list_calendars', 'task-load'),
      skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_calendars', arguments: {} }, 'task-read'),
      textWire('You have one calendar.'),
    );
    const before = f.trace.commands.length;
    storageBlock = f.blockStorage();
    const ids = await f.run(() => f.raw.submitTurn({ identity: f.identity, sessionId: null,
      content: 'Check my calendars', idempotencyKey: 'task-latency-1', task: true }));
    await f.run(() => f.execute(ids));
    await save.entered;
    expect(f.status(ids)?.status).toBe('completed');
    const types = f.frames.map(frame => (frame as { event: { type: string } }).event.type);
    expect(types).toContain('task-plan');
    expect(types.filter(t => t === 'task-step').length).toBeGreaterThan(0);
    expect(f.modelBodies).toHaveLength(4);
    expect(storageBlock.calls(), storageBlock.firstStack() ?? undefined).toBe(0);
    expect(f.trace.commands).toHaveLength(before);
    expect(f.provider.posts).toHaveLength(0);
  } catch (error) {
    failure = error;
  } finally {
    storageBlock?.restore();
    save.release();
    try {
      await f.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
    }
  }
  if (failure !== undefined) throw failure;
});
