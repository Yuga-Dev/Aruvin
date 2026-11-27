/**
 * ============================================================================
 * FILE: task-mode-calendar.spec.ts
 * LOCATION: backend/test/performance/task-mode-calendar.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Task-mode write-step checks on the assembled Calendar fixture: approval
 *    pause, one create after approval, refusal of an unapproved write, and
 *    pinned-ID reconciliation of an ambiguous create.
 *
 * ROLE IN PROJECT:
 *    docs/task-mode-and-flows/spec.md required checks A3/A4. A task adds no new
 *    write path: the existing proposal -> confirmation -> durable barrier
 *    decides, so these assert provider effects (POST counts), not UI state.
 *
 * KEY COMPONENTS:
 *    - planWire: planner reply with a Calendar write step.
 *    - Three cases using the exact spec check names.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import { calendarToolLatencyFixture, durableImage } from './calendar-tool-latency-fixture.js';
import { createWire, loadWire, textWire } from '../runtime/calendar-runtime.fixture.js';
import { event } from '../runtime/calendar-multi-fixture.js';
import { deferred } from '../assembly/admin-config-fixture.js';

type Fixture = Awaited<ReturnType<typeof calendarToolLatencyFixture>>;

const planWire = (effect: 'read' | 'write' = 'write') => textWire(JSON.stringify({ goal: 'Schedule Planning', steps: [
  { title: 'Create the Planning event', effect, tool: 'calendar' },
  { title: 'Confirm to the user', effect: 'answer', tool: 'none' },
] }));
const submitTask = (f: Fixture, content: string, key: string) => f.run(() => f.raw.submitTurn({
  identity: f.identity, sessionId: null, content, idempotencyKey: key, task: true }));
const stepEvents = (f: Fixture) => f.frames
  .map(frame => (frame as { event: { type: string; stepId?: string; status?: string; proposalId?: string } }).event)
  .filter(e => e.type === 'task-step');

async function closing(f: Fixture, failure: unknown): Promise<unknown> {
  try { await f.close(); } catch (error) {
    return failure === undefined ? error : new AggregateError([failure, error], 'Scenario and cleanup failed');
  }
  return failure;
}

it('write step pauses on a calendar proposal and creates once after approval', async () => {
  const f = await calendarToolLatencyFixture();
  let failure: unknown;
  try {
    f.modelWires.push(planWire(), loadWire('calendar_create_event', 'task-load'), createWire(event(), 'task-create'));
    const turn = await submitTask(f, 'create the event', 'task-write-1');
    await f.run(() => f.execute(turn));
    // Paused: the step awaits approval with the proposal, and nothing was created.
    const proposal = await f.run(() => f.p.calendarProposals.getCurrent(f.identity.userId, turn.sessionId));
    expect(proposal).not.toBeNull();
    expect(stepEvents(f)).toContainEqual(expect.objectContaining({ stepId: 's1', status: 'awaiting_approval', proposalId: proposal!.proposalId }));
    expect(f.provider.posts).toHaveLength(0);
    const modelCount = f.modelBodies.length;

    // Approval is an ordinary reply turn (never a new task); it creates exactly once.
    const confirm = await f.run(() => f.submit('yes', turn.sessionId, { proposalId: proposal!.proposalId, revision: proposal!.revision }));
    await f.run(() => f.execute(confirm));
    expect(f.provider.posts).toHaveLength(1);
    expect(f.modelBodies).toHaveLength(modelCount);
    expect(f.status(confirm)?.status).toBe('completed');
    expect(f.frames.some(frame => (frame as { event: { type: string } }).event.type === 'task-plan'
      && (frame as { turnId: string }).turnId === confirm.turnId)).toBe(false);
  } catch (error) { failure = error; }
  failure = await closing(f, failure);
  if (failure !== undefined) throw failure;
});

it('unapproved write tool call is refused by the runner', async () => {
  const f = await calendarToolLatencyFixture();
  let failure: unknown;
  try {
    // The planner mislabels the create as a read: the backend policy, not the plan label, gates the write.
    f.modelWires.push(planWire('read'), loadWire('calendar_create_event', 'task-load'), createWire(event(), 'task-create'));
    const turn = await submitTask(f, 'create the event', 'task-write-2');
    await f.run(() => f.execute(turn));
    expect(f.provider.posts).toHaveLength(0);
    const proposal = await f.run(() => f.p.calendarProposals.getCurrent(f.identity.userId, turn.sessionId));
    expect(proposal).not.toBeNull();
    expect(stepEvents(f)).toContainEqual(expect.objectContaining({ stepId: 's1', status: 'awaiting_approval' }));
    expect(stepEvents(f).some(e => e.status === 'done' && e.stepId === 's1')).toBe(false);
  } catch (error) { failure = error; }
  failure = await closing(f, failure);
  if (failure !== undefined) throw failure;
});

it('ambiguous create inside a task reconciles by pinned ID without another POST', async () => {
  const f = await calendarToolLatencyFixture();
  const postEntered = deferred<void>();
  const postRelease = deferred<void>();
  let image: ReturnType<typeof durableImage> | null = null;
  let recovered: Fixture | undefined;
  let originalClosed = false;
  let failure: unknown;
  f.provider.holdResponses(async info => {
    if (info.method !== 'POST' || info.kind !== 'events') return;
    image = durableImage(f.db);
    postEntered.resolve();
    await postRelease.promise;
  });
  try {
    f.modelWires.push(planWire(), loadWire('calendar_create_event', 'task-crash-load'),
      createWire(event(), 'task-crash-create'), textWire('Created.'));
    const created = await submitTask(f, 'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.', 'task-crash-1');
    const execution = f.execute(created);
    await f.pumpUntil(() => image !== null, 'external create before response delivery');
    await postEntered.promise;
    expect(f.provider.posts).toHaveLength(1);
    const pinned = f.provider.posts[0]?.eventId;
    postRelease.resolve();
    await f.driveLifecycle(execution);
    f.provider.holdResponses(null);
    await f.close();
    originalClosed = true;

    recovered = await calendarToolLatencyFixture({ image: image!, provider: f.provider });
    await recovered.driveLifecycle(recovered.raw.reconcileSession(recovered.identity.userId, created.sessionId));
    const after = await recovered.run(() => recovered!.p.calendarOperationsV2.getByTurn(
      recovered!.identity.userId, created.sessionId, created.turnId));
    expect(after).toMatchObject({ googleEventId: pinned, state: 'succeeded' });
    expect(recovered.provider.posts).toHaveLength(1);
    expect(recovered.provider.gets.every(row => row.eventId === pinned)).toBe(true);
    expect(recovered.modelBodies).toHaveLength(0);
  } catch (error) { failure = error; }
  postRelease.resolve();
  f.provider.holdResponses(null);
  if (recovered) failure = await closing(recovered, failure);
  if (!originalClosed) failure = await closing(f, failure);
  if (failure !== undefined) throw failure;
});
