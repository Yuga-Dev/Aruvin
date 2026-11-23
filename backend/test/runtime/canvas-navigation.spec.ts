/**
 * ============================================================================
 * FILE: canvas-navigation.spec.ts
 * LOCATION: backend/test/runtime/canvas-navigation.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify native Canvas navigation availability is independent of Calendar.
 *
 * ROLE IN PROJECT:
 *    Proves disabled/absent Calendar execution still advertises the frozen
 *    native tools, keeps the plugin catalog empty, blocks plugin execution,
 *    and preserves static policy for voice-only navigation.
 *
 * KEY COMPONENTS:
 *    - Memory-first fixture with disabled/absent Calendar dependency.
 *    - Frozen native tool bodies, catalog position, and bounded plugin failures.
 *    - Static instruction policy checks.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { calendarFixture, textWire, skillWire } from '../runtime/calendar-runtime.fixture.js';
import { calendarLiveFixture } from './calendar-live.fixture.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { SKILL_NATIVE_TOOLS } from '../../src/contracts/calendar-tools.js';
import type { LiveExecution } from '../../src/chat-runtime/ports.js';
import type { SubmitTurnResponse } from '../../src/contracts/api.js';
import { CalendarLoop } from '../../src/chat-runtime/calendar-loop.js';
import { CalendarTurnLedger } from '../../src/chat-runtime/calendar-budget.js';
import { MemoryCalendarLedger } from '../../src/chat-runtime/memory-calendar-ledger.js';
import { MemoryCalendarStage } from '../../src/chat-runtime/memory-calendar-state.js';
import { AppError } from '../../src/platform/errors/app-error.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const nativeTools = () => SKILL_NATIVE_TOOLS.map(tool => ({ type: 'function', function: {
  name: tool.name, description: tool.description, parameters: tool.inputSchema } }));

const disabled = () => calendarFixture(undefined, undefined, {
  policy: PROPOSED_MEMORY_TEXT_POLICY, save: async () => ({ kind: 'unknown', retryable: false }),
});

function catalogOf(body: Record<string, unknown>): string | undefined {
  return (body.messages as { role: string; content: string }[])
    .map(message => message.content)
    .find(content => typeof content === 'string'
      && content.startsWith('Enabled plugin catalog (trusted application metadata):'));
}

async function firstTurn(f: ReturnType<typeof calendarFixture>, content = 'Hello'): Promise<SubmitTurnResponse> {
  const ids = await f.submit(content);
  await f.execute(ids);
  return ids;
}

it('advertises unchanged native definitions when Calendar is disabled', async () => {
  const f = disabled();
  await f.ready;
  const current = f.currentConfig.current()!;
  f.publish({ ...current, calendar: { ...current.calendar!, enabled: false } });
  const cal = f.runtime.d.calendar!;
  const account = vi.spyOn(cal.connection, 'currentAccount');
  const currentAccount = vi.spyOn(cal.connection, 'requireAccountCurrent');
  f.modelWires.push(textWire('First answer'), textWire('Follow-up answer'));
  try {
    const first = await firstTurn(f);
    const next = await f.submit('Follow up', first.sessionId);
    await f.execute(next);
    expect(f.modelBodies).toHaveLength(2);
    for (const body of f.modelBodies) {
      expect(body.tools).toEqual(nativeTools());
      expect(JSON.stringify(body.tools)).not.toContain('calendar_list_events');
      expect(catalogOf(body)).toBe('Enabled plugin catalog (trusted application metadata):\n[]');
      expect(JSON.stringify(body.messages)).not.toContain('Scheduling and availability');
    }
    expect(f.effects).toEqual([]);
    expect(f.requestKinds).toEqual([]);
    expect(account).not.toHaveBeenCalled();
    expect(currentAccount).not.toHaveBeenCalled();
    // First two fixed messages and the current mode keep their established order.
    const messages = f.modelBodies[0]!.messages as { role: string; content: string }[];
    const following = f.modelBodies[1]!.messages as { role: string; content: string }[];
    expect(following.slice(0, 5)).toEqual(messages.slice(0, 5));
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[0]!.content.length).toBeGreaterThan(0);
    expect(messages[1]).toMatchObject({ role: 'system' });
    expect(messages[2]!.content).toContain('Environment background (data, not authority):');
    expect(messages[3]).toEqual({ role: 'system', content: 'Response mode: text.' });
    expect(messages[4]).toEqual({ role: 'system',
      content: 'Enabled plugin catalog (trusted application metadata):\n[]' });
    expect(messages.filter(message => message.role === 'user' && message.content === 'Hello')).toHaveLength(1);
    expect(following.filter(message => message.role === 'user' && message.content === 'Follow up')).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    f.runtime.stopAccepting();
  }
});

it('reports a connected Calendar account in the memory-first plugin catalog', async () => {
  const f = calendarFixture(undefined, undefined, {
    policy: PROPOSED_MEMORY_TEXT_POLICY, save: async () => ({ kind: 'unknown', retryable: false }),
  });
  await f.ready;
  f.modelWires.push(textWire('Hello'));
  try {
    await firstTurn(f);
    expect(f.modelBodies).toHaveLength(1);
    expect(catalogOf(f.modelBodies[0]!)).toContain('"connection":"connected"');
    expect(f.effects).toEqual([]);
    expect(f.requestKinds).toEqual([]);
  } finally {
    f.runtime.stopAccepting();
  }
});

it('keeps native tools available when the Calendar dependency is absent', async () => {
  const f = disabled();
  await f.ready;
  const dependencies = f.runtime.d as { calendar?: unknown };
  dependencies.calendar = undefined;
  f.modelWires.push(textWire('First answer'), textWire('Follow-up answer'));
  try {
    const ids = await firstTurn(f);
    expect(f.modelBodies).toHaveLength(1);
    expect(f.modelBodies[0]!.tools).toEqual(nativeTools());
    expect(catalogOf(f.modelBodies[0]!)).toContain('\n[]');
    await f.execute(ids);
    expect(f.modelBodies).toHaveLength(1);
  } finally { f.runtime.stopAccepting(); }
});

it.each([
  ['activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_events'] }, 'disabled-load'],
  ['call_tool', { plugin: 'google-calendar', tool: 'calendar_list_events',
    arguments: { timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', maxResults: 10 } },
  'disabled-call'],
] as const)('returns the bounded unknown-plugin failure for %s without Calendar access', async (kind, envelope, callId) => {
  const f = disabled();
  await f.ready;
  const current = f.currentConfig.current()!;
  f.publish({ ...current, calendar: { ...current.calendar!, enabled: false } });
  const cal = f.runtime.d.calendar!;
  const account = vi.spyOn(cal.connection, 'currentAccount');
  const currentAccount = vi.spyOn(cal.connection, 'requireAccountCurrent');
  f.modelWires.push(skillWire(kind, envelope, callId));
  try {
    const ids = await firstTurn(f, 'Use Calendar');
    expect(f.modelBodies).toHaveLength(1);
    expect(f.modelBodies[0]!.tools).toEqual(nativeTools());
    const memory = f.runtime.memoryFor(f.identity.userId)!;
    const state = memory.foundation.result(memory.find(ids.sessionId, ids.turnId)!.turn)!.calendar!;
    expect(state.results).toHaveLength(1);
    expect(state.results[0]!.resultRef.content).toContain('UNKNOWN_PLUGIN');
    expect(f.effects).toEqual([]);
    expect(f.requestKinds).toEqual([]);
    expect(account).not.toHaveBeenCalled();
    expect(currentAccount).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    f.runtime.stopAccepting();
  }
});

it('does not let a retained disclosure bypass the disabled plugin guard', async () => {
  const f = disabled();
  await f.ready;
  f.modelWires.push(
    skillWire('activate_skill', { plugin: 'google-calendar', tools: ['calendar_list_events'] }, 'retained-load'),
    textWire('Schema loaded.'),
  );
  try {
    const first = await firstTurn(f, 'Load the Calendar schema');
    expect(f.modelBodies).toHaveLength(2);
    const current = f.currentConfig.current()!;
    f.publish({ ...current, calendar: { ...current.calendar!, enabled: false } });
    f.modelWires.push(skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_events',
      arguments: { timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', maxResults: 10 } },
    'retained-call'));
    const second = await f.submit('Use the loaded schema', first.sessionId);
    await f.execute(second);
    expect(f.effects).toEqual([]);
    const turn = f.runtime.memoryFor(f.identity.userId)!.find(second.sessionId, second.turnId)!.turn;
    const state = f.runtime.memoryFor(f.identity.userId)!.foundation.result(turn)!.calendar!;
    expect(state.results.some(result => result.resultRef.content.includes('UNKNOWN_PLUGIN'))).toBe(true);
    expect(state.results.some(result => result.resultRef.content.includes('SCHEMA_NOT_LOADED'))).toBe(false);
  } finally { f.runtime.stopAccepting(); }
});

it('keeps native tools when legacy durable account acquisition fails', async () => {
  const f = calendarFixture();
  await f.ready;
  const cal = f.runtime.d.calendar!;
  const account = vi.spyOn(cal.connection, 'currentAccount').mockRejectedValue(new Error('offline'));
  f.modelWires.push(textWire('Durable answer'), textWire('Follow-up answer'));
  try {
    const first = await f.submit('Hello');
    await f.execute(first);
    expect(f.modelBodies).toHaveLength(1);
    expect(f.modelBodies[0]!.tools).toEqual(nativeTools());
    const next = await f.submit('Follow up', first.sessionId);
    await f.execute(next);
    expect(f.modelBodies).toHaveLength(2);
    expect(f.modelBodies[1]!.tools).toEqual(nativeTools());
    expect(f.effects).toEqual([]);
    expect(f.requestKinds).toEqual([]);
    expect(account).toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    f.runtime.stopAccepting();
  }
});

it('publishes the voice-only navigation policy without contradicting generation rules', () => {
  const text = readFileSync(new URL('../../src/instructions/system.md', import.meta.url), 'utf8');
  expect(text).not.toContain('show_canvas');
  expect(text).toContain('control_canvas is a directly advertised built-in, not a plugin tool.');
  expect(text).toContain('Voice turns include instantaneous Canvas state with fields mode, canvas_count, canvas_ids (entries of { canvas_id, title }), open, fullscreen, and zoomable.');
  expect(text).toContain('Never call control_canvas in text mode, including dictation submitted as text.');
  expect(text).toContain('when more than one candidate is plausible, ask a short clarification');
  expect(text).toContain('Never invent an ID, choose an unrelated fallback, or regenerate an artifact merely to reopen it.');
  expect(text).toContain('If inventory is incomplete, acknowledge that limitation');
  expect(text).toContain('An authorized request to open, focus, or adjust an existing Canvas is an exception to the new-visual requirement');
  expect(text).toContain('A requested outcome means a presentation request was queued, not proof the browser displayed it.');
  expect(text).toContain('Except for an authorized control_canvas request');
  expect(text).toContain('never claim confirmed display, synchronized delivery, or interface switches');
  expect(text).not.toMatch(/Do not claim to switch the interface\.\r?\n/);
});

it('documents presentation controls without requiring replacement content or confirmed display', () => {
  const text = readFileSync(new URL('../../src/instructions/system.md', import.meta.url), 'utf8');
  expect(text).toContain('control_canvas is a directly advertised built-in');
  expect(text).toContain('Never call control_canvas in text mode, including dictation submitted as text');
  for (const action of ['open', 'zoom_in', 'zoom_out', 'fit_to_view', 'scroll', 'close', 'reset_view', 'fullscreen']) {
    expect(text).toContain(action);
  }
  expect(text).toContain('scroll moves content in up, down, left, or right direction');
  expect(text).toContain('fit_to_view measures and centers the rendered diagram');
  expect(text).toContain('reset_view restores 100% zoom and neutral position');
  expect(text).toContain('fullscreen uses state enter or exit for application panel expansion');
  expect(text).toContain('Answer directly from the Canvas state without calling control_canvas when state already precludes or satisfies the request');
  expect(text).toContain('A valid control_canvas call completes the turn in one step with a deterministic spoken confirmation.');
  expect(text).toContain('Controlling Canvas does not approve or mutate Calendar data');
  expect(text).toContain('Control_canvas requested is not confirmation that the browser displayed or applied it');
  expect(text).toContain('authorized control_canvas');
});

/**
 * Seeds one real Canvas artifact through a scripted voice turn and exposes the
 * trusted call-scoped port for the next request.
 */
async function seededLiveNavigation(options: Parameters<typeof calendarLiveFixture>[1] = {}) {
  const f = await calendarLiveFixture('memory', options);
  const show = vi.fn((_canvasId: string) => true);
  f.h.modelWires.push(textWire('Pricing summary.\n\n```mermaid title="Pricing comparison"\n'
    + 'flowchart TD\nA --> B\n```'));
  const seed = await f.submit('Draw the pricing comparison.');
  await f.execute(seed);
  const memory = f.h.runtime.memoryFor(f.h.identity.userId)!;
  const assistant = memory.foundation.history(f.sessionId)
    .find(record => record.role === 'assistant' && record.turnId === seed.turnId)!;
  const target = `${assistant.messageId}::canvas::0`;
  const canvas: NonNullable<LiveExecution['canvas']> = {
    inventory: () => ({ items: [{ canvasId: target, title: 'Pricing comparison',
      owner: { kind: 'message', id: assistant.messageId } }], omitted: 0 }),
    active: () => true,
    show: (canvasId: string) => show(canvasId),
  };
  return { f, show, seed, assistant, target, canvas, memory };
}

it('keeps older wire messages byte-stable when Canvas changes on a voice continuation', async () => {
  const { f, canvas, target } = await seededLiveNavigation();
  try {
    f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'old-open'));
    await f.execute(await f.submit('Open the pricing comparison.'), undefined, canvas);
    const before = f.h.modelBodies.length;
    const current = '  Load the Calendar schema.\nPlease.  ';
    const args = { plugin: 'google-calendar', tools: ['calendar_get_event'] };
    f.h.modelWires.push(skillWire('activate_skill', args, 'current-load'), textWire('Ready.'));
    await f.execute(await f.submit(current), undefined, {
      ...canvas,
      selection: () => f.h.modelBodies.length === before ? null
        : { canvasId: target, revision: 1, open: true, mode: 'diagram', fullscreen: true },
    });
    const bodies = f.h.modelBodies.slice(before);
    expect(bodies).toHaveLength(2);
    const messages = bodies.map(body => body.messages as {
      role: string; content?: string | null; tool_call_id?: string;
    }[]);
    const olderWire: string[] = [];
    for (const [index, list] of messages.entries()) {
      const canvases = list.filter(m => m.role === 'system'
        && m.content?.startsWith('Canvas state (voice-only instantaneous state;'));
      expect(canvases).toHaveLength(1);
      const stateIndex = list.indexOf(canvases[0]!);
      const accepted = { role: 'user', content: current };
      expect(list.filter(m => m.role === 'user' && m.content === current)).toEqual([accepted]);
      expect(list[stateIndex + 1]).toEqual(accepted);
      expect(JSON.parse(canvases[0]!.content!.split('\n')[1]!)).toEqual({
        mode: 'voice', canvas_count: 1, canvas_ids: [{ canvas_id: target, title: 'Pricing comparison' }],
        open: index === 1, fullscreen: index === 1, zoomable: index === 1,
      });
      const oldTool = list.findIndex(m => m.role === 'tool' && m.tool_call_id === 'old-open');
      expect(oldTool).toBeGreaterThan(0);
      expect(list[oldTool - 1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'old-open' }] });
      expect(oldTool).toBeLessThan(stateIndex);
      expect(list.slice(oldTool + 1, stateIndex)).toContainEqual({
        role: 'assistant', content: 'Voice reply delivery is unknown; do not assume generated content was heard.',
      });
      olderWire.push(JSON.stringify(list.slice(0, stateIndex)));
      const afterInput = list.slice(stateIndex + 2);
      if (index === 0) expect(afterInput).toEqual([]);
      else {
        expect(afterInput).toHaveLength(2);
        expect(afterInput[0]).toMatchObject({ role: 'assistant', tool_calls: [{
          id: 'current-load', function: { name: 'activate_skill', arguments: JSON.stringify(args) },
        }] });
        expect(afterInput[1]).toMatchObject({ role: 'tool', tool_call_id: 'current-load' });
      }
    }
    expect(olderWire[1]).toBe(olderWire[0]);
    expect(f.h.effects).toEqual([]);
  } finally { await f.dispose(); }
}, 5000);

function expectation(target: string | null, outcome: string): string {
  return JSON.stringify({ kind: 'canvas-control', outcome, action: 'open', canvas_id: target });
}

it('reopens an owned Canvas from a trusted live request in one LLM call and keeps the exact pair', async () => {
  const { f, show, assistant, target, canvas, memory } = await seededLiveNavigation();
  try {
    expect(assistant.canvasArtifacts?.[0]).toMatchObject({ kind: 'mermaid', ordinal: 0,
      responseId: expect.any(String) });
    const before = f.h.modelBodies.length;
    const spokenBefore = f.spoken.length;
    f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-existing-1'));
    const ids = await f.submit('Open the pricing comparison.');
    await f.execute(ids, undefined, canvas);
    expect(show).toHaveBeenCalledExactlyOnceWith(target);
    expect(f.h.modelBodies.length - before).toBe(1);
    expect(f.spoken.slice(spokenBefore).join('')).toBe('You are looking at Pricing comparison right now');
    const pair = memory.foundation.result(memory.find(ids.sessionId, ids.turnId)!.turn)!.calendar!;
    expect(pair.results).toHaveLength(1);
    expect(pair.results[0]).toMatchObject({ toolCallId: 'open-existing-1',
      resultRef: { storage: 'local', content: expectation(target, 'requested') } });
    expect(pair.decisions.find(decision => decision.decision?.kind === 'control_canvas')!.decision)
      .toMatchObject({ kind: 'control_canvas', nativeCall: { id: 'open-existing-1' } });
    expect(memory.foundation.history(f.sessionId)
      .find(record => record.role === 'assistant' && record.turnId === ids.turnId)?.canvasArtifacts).toBeUndefined();
    expect(f.frames).toEqual([]);
    expect(f.h.effects).toEqual([]);
    expect(f.h.requestKinds).toEqual([]);
    // Follow-up sees the (assistant tool_call, tool result) pair right before the deterministic assistant message.
    f.h.modelWires.push(textWire('Continuing.'));
    const follow = await f.submit('Next question.');
    await f.execute(follow, undefined, canvas);
    const followMessages = f.h.modelBodies.at(-1)!.messages as Record<string, unknown>[];
    const toolIndex = followMessages.findIndex(m => m.role === 'tool' && m.tool_call_id === 'open-existing-1');
    expect(toolIndex).toBeGreaterThan(0);
    expect(followMessages[toolIndex - 1]).toMatchObject({ role: 'assistant',
      tool_calls: [expect.objectContaining({ id: 'open-existing-1',
        function: expect.objectContaining({ name: 'control_canvas' }) })] });
    expect(followMessages[toolIndex]).toMatchObject({ role: 'tool', name: 'control_canvas',
      tool_call_id: 'open-existing-1', content: expectation(target, 'requested') });
    expect(followMessages[toolIndex + 1]).toEqual({ role: 'assistant',
      content: 'Voice reply delivery is unknown; do not assume generated content was heard.' });
    // A same-process replay of the same turn never redispatches navigation.
    const bodies = f.h.modelBodies.length;
    await f.execute(ids, undefined, canvas);
    expect(f.h.modelBodies.length).toBe(bodies);
    expect(show).toHaveBeenCalledTimes(1);
  } finally { await f.dispose(); }
}, 5000);

it('pairs a mode rejection for a text request without any presentation effect or Canvas state exposure', async () => {
  const { f, show, target, canvas } = await seededLiveNavigation();
  try {
    expect(canvas.active()).toBe(true);
    expect(show).not.toHaveBeenCalled();
    const beforeBodies = f.h.modelBodies.length;
    f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-text-1'));
    const ids = await f.h.submit('Open the pricing comparison.');
    await f.h.execute(ids);
    expect(show).not.toHaveBeenCalled();
    expect(f.h.modelBodies.length - beforeBodies).toBe(1);
    expect(JSON.stringify(f.h.modelBodies.at(-1)!.messages)).not.toContain('Canvas state');
    const memory = f.h.runtime.memoryFor(f.h.identity.userId)!;
    const pair = memory.foundation.result(memory.find(ids.sessionId, ids.turnId)!.turn)!.calendar!;
    expect(pair.results[0]!.resultRef.content).toBe(expectation(target, 'mode-not-allowed'));
    expect(pair.dispatches).toHaveLength(1);
    expect(f.frames).toEqual([]);
    expect(f.h.effects).toEqual([]);
    expect(f.h.requestKinds).toEqual([]);
  } finally { await f.dispose(); }
}, 5000);

it('keeps a navigation pair eligible when the background save fails', async () => {
  const { f, show, seed, target, canvas, memory } = await seededLiveNavigation({
    save: async () => ({ kind: 'unknown', retryable: false }) });
  try {
    await vi.waitFor(() => expect(memory.foundation
      .saveState(memory.find(f.sessionId, seed.turnId)!.turn)).toBe('unknown'));
    f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-unsaved-1'));
    const ids = await f.submit('Open the pricing comparison.');
    await f.execute(ids, undefined, canvas);
    expect(show).toHaveBeenCalledExactlyOnceWith(target);
    expect(memory.foundation.saveState(memory.find(ids.sessionId, ids.turnId)!.turn)).not.toBe('saved');
    f.h.modelWires.push(textWire('Still here.'));
    const before = f.h.modelBodies.length;
    const followUp = await f.submit('Thanks.');
    await f.execute(followUp, undefined, canvas);
    expect(f.h.modelBodies.length - before).toBe(1);
    const request = f.h.modelBodies.at(-1)!.messages as Record<string, unknown>[];
    expect(request).toContainEqual(expect.objectContaining({ role: 'tool', name: 'control_canvas',
      tool_call_id: 'open-unsaved-1', content: expectation(target, 'requested') }));
    expect(show).toHaveBeenCalledTimes(1);
  } finally { await f.dispose(); }
}, 5000);

it('queues Canvas before any execute-time context assembly or result-capacity preflight', async () => {
  const { f, show, target, canvas, memory } = await seededLiveNavigation();
  const assembly = vi.spyOn(CalendarLoop.prototype as unknown as { assemble: (...args: unknown[]) => unknown }, 'assemble');
  const capacity = vi.spyOn(MemoryCalendarStage.prototype, 'assertResultCapacity');
  const put = vi.spyOn(MemoryCalendarStage.prototype, 'putResult');
  const observations: number[][] = [];
  show.mockImplementation(() => {
    observations.push([assembly.mock.calls.length, capacity.mock.calls.length, put.mock.calls.length]);
    return true;
  });
  try {
    f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-fast-1'));
    const ids = await f.submit('Open it.');
    await f.execute(ids, undefined, canvas);
    // Only the initial model prompt was assembled; no second assemble or storage gate runs.
    expect(observations).toEqual([[1, 0, 0]]);
    expect(assembly).toHaveBeenCalledTimes(1);
    const state = memory.foundation.result(memory.find(ids.sessionId, ids.turnId)!.turn)!.calendar!;
    expect(state.results[0]!.resultRef.content).toBe(expectation(target, 'requested'));
  } finally { vi.restoreAllMocks(); await f.dispose(); }
});

it('retains the requested open pair if subsequent accounting fails, without dispatching another model call', async () => {
  const { f, show, target, canvas, memory } = await seededLiveNavigation();
  const finishDispatch = MemoryCalendarLedger.prototype.finishDispatch;
  let shouldFail = true;
  const ledgerSpy = vi.spyOn(MemoryCalendarLedger.prototype, 'finishDispatch')
    .mockImplementation(async function (this: MemoryCalendarLedger, ...args) {
      const out = await finishDispatch.apply(this, args);
      if (shouldFail) {
        shouldFail = false;
        throw new AppError('PROVIDER_ERROR', 'Accounting failed.', false);
      }
      return out;
    });
  try {
    f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-acct-fail'));
    const ids = await f.submit('Open it.');
    const before = f.h.modelBodies.length;
    await f.execute(ids, undefined, canvas);
    expect(show).toHaveBeenCalledExactlyOnceWith(target);
    expect(f.h.modelBodies.length - before).toBe(1);
    const state = memory.foundation.result(memory.find(ids.sessionId, ids.turnId)!.turn)!;
    expect(state.status).toBe('failed');
    expect(state.calendar!.results[0]!.resultRef.content).toBe(expectation(target, 'requested'));
    await f.execute(ids, undefined, canvas);
    expect(show).toHaveBeenCalledTimes(1);
  } finally { ledgerSpy.mockRestore(); await f.dispose(); }
});

it('applies a control before actual runtime ledger finalization and background saving', async () => {
  const saveGate = deferred<{ kind: 'unknown'; retryable: false }>();
  const ledgerGate = deferred();
  const { f, target, canvas } = await seededLiveNavigation({ save: () => saveGate.promise });
  const selected = { canvasId: target, revision: 1, open: true, mode: 'diagram' as const, fullscreen: false };
  const capacity = vi.spyOn(MemoryCalendarStage.prototype, 'assertResultCapacity');
  const finishDispatch = MemoryCalendarLedger.prototype.finishDispatch;
  let hold = true;
  let ledgerSettled = false;
  const spy = vi.spyOn(MemoryCalendarLedger.prototype, 'finishDispatch')
    .mockImplementation(async function (this: MemoryCalendarLedger, ...args) {
      if (hold) await ledgerGate.promise;
      const out = await finishDispatch.apply(this, args);
      ledgerSettled = true;
      return out;
    });
  const applied = vi.fn(() => {
    expect(f.finish).not.toHaveBeenCalled();
    expect(capacity).not.toHaveBeenCalled();
    expect(ledgerSettled).toBe(false);
    return true;
  });
  let run: Promise<void> | undefined;
  try {
    f.finish.mockClear();
    const beforeBodies = f.h.modelBodies.length;
    const spokenBefore = f.spoken.length;
    f.h.modelWires.push(skillWire('control_canvas', { action: 'zoom_in' }, 'control-order-1'));
    const ids = await f.submit('Zoom in.');
    run = f.execute(ids, undefined, { ...canvas, selection: () => selected, control: applied });
    await vi.waitFor(() => expect(applied).toHaveBeenCalledOnce());
    expect(f.finish).not.toHaveBeenCalled();
    expect(ledgerSettled).toBe(false);
    expect(f.h.modelBodies.at(-1)!.messages).not.toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'control-order-1',
    }));
    hold = false;
    ledgerGate.resolve();
    saveGate.resolve({ kind: 'unknown', retryable: false });
    await run;
    expect(ledgerSettled).toBe(true);
    expect(f.h.modelBodies).toHaveLength(beforeBodies + 1);
    expect(f.spoken.slice(spokenBefore).join('')).toBe('Zoomed in.');
    f.h.modelWires.push(textWire('After zoom.'));
    await f.execute(await f.submit('Next.'), undefined, { ...canvas, selection: () => selected, control: applied });
    expect(f.h.modelBodies.at(-1)!.messages).toContainEqual(expect.objectContaining({
      role: 'tool',
      name: 'control_canvas',
      tool_call_id: 'control-order-1',
      content: JSON.stringify({ kind: 'canvas-control', outcome: 'requested', action: 'zoom_in', canvas_id: target }),
    }));
    expect(f.h.modelBodies.at(-1)!.messages).toContainEqual({
      role: 'assistant',
      content: 'Voice reply delivery is unknown; do not assume generated content was heard.',
    });
  } finally {
    hold = false;
    ledgerGate.resolve();
    saveGate.resolve({ kind: 'unknown', retryable: false });
    await run?.catch(() => undefined);
    spy.mockRestore();
    capacity.mockRestore();
    await f.dispose();
  }
}, 5000);

it('applies a control before durable persistence and observations settle', async () => {
  const f = await calendarLiveFixture('durable');
  const decisionGate = deferred();
  const resultGate = deferred();
  const ledgerGate = deferred();
  let decisionPutSettled = false;
  let resultPutSettled = false;
  let ledgerSettled = false;
  let hold = false;
  let modelDispatched = false;
  let getsAfterDispatch = 0;
  let putDecisionSpy: ReturnType<typeof vi.spyOn> | undefined;
  let getDecisionSpy: ReturnType<typeof vi.spyOn> | undefined;
  let putResultSpy: ReturnType<typeof vi.spyOn> | undefined;
  let finishSpy: ReturnType<typeof vi.spyOn> | undefined;
  const fetcherMock = f.h.fetcher as ReturnType<typeof vi.fn<typeof fetch>>;
  const prevFetcherImpl = fetcherMock.getMockImplementation()!;
  let run: Promise<void> | undefined;
  try {
    f.h.modelWires.push(textWire('Architecture.\n\n```mermaid title="System"\nflowchart TD\nA --> B\n```'));
    const seed = await f.submit('Draw the architecture.');
    await f.execute(seed);
    const records = await f.h.p.messages.listForContext(f.h.identity.userId, f.sessionId, { cursor: null, limit: 20 });
    const assistant = records.items.find(record => record.role === 'assistant' && record.turnId === seed.turnId)!;
    const target = `${assistant.messageId}::canvas::0`;
    const selected = { canvasId: target, revision: 1, open: true, mode: 'diagram' as const, fullscreen: false };

    fetcherMock.mockImplementation(async (url, init) => {
      modelDispatched = true;
      return prevFetcherImpl(url, init);
    });
    hold = true;
    const origPutDecision = f.h.p.skillDecisions.put.bind(f.h.p.skillDecisions);
    putDecisionSpy = vi.spyOn(f.h.p.skillDecisions, 'put').mockImplementation(async (rec) => {
      if (hold) await decisionGate.promise;
      await origPutDecision(rec);
      decisionPutSettled = true;
    });
    const origGetDecision = f.h.p.skillDecisions.get.bind(f.h.p.skillDecisions);
    getDecisionSpy = vi.spyOn(f.h.p.skillDecisions, 'get').mockImplementation(async (u, id) => {
      if (modelDispatched) getsAfterDispatch += 1;
      return origGetDecision(u, id);
    });
    const origPutResult = f.h.p.skillResults.put.bind(f.h.p.skillResults);
    putResultSpy = vi.spyOn(f.h.p.skillResults, 'put').mockImplementation(async (rec) => {
      if (hold) await resultGate.promise;
      await origPutResult(rec);
      resultPutSettled = true;
    });
    const origFinish = CalendarTurnLedger.prototype.finishDispatch;
    finishSpy = vi.spyOn(CalendarTurnLedger.prototype, 'finishDispatch').mockImplementation(async function (
      this: CalendarTurnLedger,
      ...args
    ) {
      if (hold) await ledgerGate.promise;
      const out = await origFinish.apply(this, args);
      ledgerSettled = true;
      return out;
    });

    const applied = vi.fn(() => {
      expect(modelDispatched).toBe(true);
      expect(putDecisionSpy).not.toHaveBeenCalled();
      expect(getsAfterDispatch).toBe(0);
      expect(putResultSpy).not.toHaveBeenCalled();
      expect(decisionPutSettled).toBe(false);
      expect(resultPutSettled).toBe(false);
      expect(ledgerSettled).toBe(false);
      expect(f.finish).not.toHaveBeenCalled();
      return true;
    });

    const canvas: NonNullable<LiveExecution['canvas']> = {
      inventory: () => ({ items: [{ canvasId: target, title: 'System',
        owner: { kind: 'message', id: assistant.messageId } }], omitted: 0 }),
      active: () => true,
      show: () => true,
      selection: () => selected,
      control: applied,
    };
    f.finish.mockClear();
    const beforeBodies = f.h.modelBodies.length;
    const spokenBefore = f.spoken.length;
    f.h.modelWires.push(skillWire('control_canvas', { action: 'fit_to_view' }, 'control-durable-1'));
    const ids = await f.submit('Fit it to the screen.');
    run = f.execute(ids, undefined, canvas);
    await vi.waitFor(() => expect(applied).toHaveBeenCalledOnce(), { timeout: 600 });
    expect(putDecisionSpy).not.toHaveBeenCalled();
    expect(getsAfterDispatch).toBe(0);
    expect(putResultSpy).not.toHaveBeenCalled();
    expect(ledgerSettled).toBe(false);
    expect(f.finish).not.toHaveBeenCalled();

    hold = false;
    ledgerGate.resolve();
    decisionGate.resolve();
    resultGate.resolve();
    await run;

    expect(decisionPutSettled).toBe(true);
    expect(resultPutSettled).toBe(true);
    expect(ledgerSettled).toBe(true);
    expect(getsAfterDispatch).toBe(0);
    expect(f.h.modelBodies).toHaveLength(beforeBodies + 1);
    expect(f.spoken.slice(spokenBefore).join('')).toBe('Fitted to view.');
    f.h.modelWires.push(textWire('After fit.'));
    await f.execute(await f.submit('Continue.'), undefined, canvas);
    expect(f.h.modelBodies.at(-1)!.messages).toContainEqual(expect.objectContaining({
      role: 'tool',
      name: 'control_canvas',
      tool_call_id: 'control-durable-1',
      content: JSON.stringify({
        kind: 'canvas-control', outcome: 'requested', action: 'fit_to_view', canvas_id: target,
      }),
    }));
    expect(f.h.modelBodies.at(-1)!.messages).toContainEqual({
      role: 'assistant',
      content: 'Voice reply delivery is unknown; do not assume generated content was heard.',
    });
  } finally {
    hold = false;
    ledgerGate.resolve();
    decisionGate.resolve();
    resultGate.resolve();
    await run?.catch(() => undefined);
    fetcherMock.mockImplementation(prevFetcherImpl);
    putDecisionSpy?.mockRestore();
    getDecisionSpy?.mockRestore();
    putResultSpy?.mockRestore();
    finishSpy?.mockRestore();
    await f.dispose();
  }
}, 5000);

function controlExpectation(action: string | null, outcome: string, canvasId: string | null): string {
  return JSON.stringify({ kind: 'canvas-control', outcome, action, canvas_id: canvasId });
}

it('rejects control_canvas in text mode and dictation-submitted text without invoking the port', async () => {
  const { f, target, canvas, memory } = await seededLiveNavigation();
  expect(target).toContain('::canvas::');
  const applied = vi.fn(() => true);
  try {
    const cases = [
      { prompt: 'Zoom in on the diagram.', callId: 'control-text-1', action: 'zoom_in' },
      { prompt: 'Fit to screen.', callId: 'control-dictation-text-1', action: 'fit_to_view' },
    ] as const;
    for (const c of cases) {
      const beforeBodies = f.h.modelBodies.length;
      f.h.modelWires.push(skillWire('control_canvas', { action: c.action }, c.callId));
      const ids = await f.h.submit(c.prompt);
      await f.h.execute(ids);
      expect(applied).not.toHaveBeenCalled();
      expect(canvas.active()).toBe(true);
      expect(f.h.modelBodies.length - beforeBodies).toBe(1);
      expect(JSON.stringify(f.h.modelBodies.at(-1)!.messages)).not.toContain('Canvas state');
      const pair = memory.foundation.result(memory.find(ids.sessionId, ids.turnId)!.turn)!.calendar!;
      expect(pair.results[0]!.resultRef.content).toBe(controlExpectation(c.action, 'mode-not-allowed', null));
      expect(pair.dispatches).toHaveLength(1);
    }
    expect(f.h.effects).toEqual([]);
    expect(f.h.requestKinds).toEqual([]);
  } finally { await f.dispose(); }
}, 5000);

it('admits control_canvas when Calendar is disabled or absent with zero Calendar account or API access', async () => {
  const f = await calendarLiveFixture('memory');
  const current = f.h.currentConfig.current()!;
  f.h.publish({ ...current, calendar: { ...current.calendar!, enabled: false } });
  const cal = f.h.runtime.d.calendar!;
  const account = vi.spyOn(cal.connection, 'currentAccount');
  const currentAccount = vi.spyOn(cal.connection, 'requireAccountCurrent');
  const applied = vi.fn(() => true);
  try {
    f.h.modelWires.push(textWire('Chart.\n\n```mermaid title="Chart"\nflowchart TD\nA --> B\n```'));
    const seed = await f.submit('Draw it.');
    await f.execute(seed);
    const memory = f.h.runtime.memoryFor(f.h.identity.userId)!;
    const assistant = memory.foundation.history(f.sessionId)
      .find(record => record.role === 'assistant' && record.turnId === seed.turnId)!;
    const target = `${assistant.messageId}::canvas::0`;
    const selected = { canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'diagram' as const };
    const canvas: NonNullable<LiveExecution['canvas']> = {
      inventory: () => ({ items: [{ canvasId: target, title: 'Chart',
        owner: { kind: 'message', id: assistant.messageId } }], omitted: 0 }),
      active: () => true,
      show: () => true,
      selection: () => selected,
      control: applied,
    };

    f.h.modelWires.push(skillWire('control_canvas', { action: 'zoom_in' }, 'ctrl-disabled-cal'));
    const disabledTurn = await f.submit('Zoom in.');
    await f.execute(disabledTurn, undefined, canvas);
    expect(applied).toHaveBeenCalledTimes(1);

    (f.h.runtime.d as { calendar?: unknown }).calendar = undefined;
    f.h.modelWires.push(skillWire('control_canvas', { action: 'reset_view' }, 'ctrl-absent-cal'));
    const absentTurn = await f.submit('Reset view.');
    await f.execute(absentTurn, undefined, canvas);
    expect(applied).toHaveBeenCalledTimes(2);
    expect(account).not.toHaveBeenCalled();
    expect(currentAccount).not.toHaveBeenCalled();
    expect(f.h.effects).toEqual([]);
    expect(f.h.requestKinds).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await f.dispose();
  }
}, 5000);

it('rejects control_canvas when selection changes during pending model dispatch', async () => {
  const { f, target, canvas, memory } = await seededLiveNavigation();
  let selected: { canvasId: string; revision: number; open: boolean; fullscreen: boolean; mode: 'diagram' | 'scroll' } = {
    canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'diagram',
  };
  const applied = vi.fn(() => true);
  const fetcherMock = f.h.fetcher as ReturnType<typeof vi.fn<typeof fetch>>;
  const prevImpl = fetcherMock.getMockImplementation()!;
  let mutateNext = true;
  fetcherMock.mockImplementation(async (url, init) => {
    const res = await prevImpl(url, init);
    if (mutateNext) {
      mutateNext = false;
      selected = { ...selected, revision: 2 };
    }
    return res;
  });
  try {
    const spokenBefore = f.spoken.length;
    f.h.modelWires.push(skillWire('control_canvas', { action: 'zoom_in' }, 'ctrl-stale-rev'));
    const ids = await f.submit('Zoom in.');
    await f.execute(ids, undefined, { ...canvas, selection: () => selected, control: applied });
    expect(applied).not.toHaveBeenCalled();
    expect(f.spoken.slice(spokenBefore).join('')).toBe('The Canvas changed before I could apply that.');
    const pair = memory.foundation.result(memory.find(ids.sessionId, ids.turnId)!.turn)!.calendar!;
    expect(pair.results[0]!.resultRef.content).toBe(controlExpectation('zoom_in', 'unavailable', target));
  } finally {
    fetcherMock.mockImplementation(prevImpl);
    await f.dispose();
  }
}, 5000);

it('rejects control_canvas when call is inactive, canvas is unowned, or signal is cancelled', async () => {
  const { f, target, canvas, memory } = await seededLiveNavigation();
  const applied = vi.fn(() => true);
  const selected = { canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'diagram' as const };
  try {
    f.h.modelWires.push(skillWire('control_canvas', { action: 'zoom_out' }, 'ctrl-inactive'));
    const inactiveTurn = await f.submit('Zoom out.');
    await f.execute(inactiveTurn, undefined, {
      ...canvas, active: () => false, selection: () => selected, control: applied,
    });
    expect(memory.foundation.result(memory.find(inactiveTurn.sessionId, inactiveTurn.turnId)!.turn)!
      .calendar!.results[0]!.resultRef.content).toBe(controlExpectation('zoom_out', 'delivery-unavailable', target));

    const spokenUnowned = f.spoken.length;
    f.h.modelWires.push(
      skillWire('control_canvas', { action: 'zoom_in' }, 'ctrl-wrong-owner'),
      textWire('No owned Canvas is open.'),
    );
    const unownedTurn = await f.submit('Zoom in.');
    await f.execute(unownedTurn, undefined, {
      ...canvas,
      selection: () => ({ canvasId: 'other-message::canvas::0', revision: 1, open: true, fullscreen: false, mode: 'diagram' }),
      control: applied,
    });
    expect(applied).not.toHaveBeenCalled();
    expect(f.spoken.slice(spokenUnowned).join('')).toBe('No owned Canvas is open.');

    // Switching selection to an unowned Canvas mid-dispatch fails closed via controlCanvas without applying.
    const fetcherMock = f.h.fetcher as ReturnType<typeof vi.fn<typeof fetch>>;
    const prevImpl = fetcherMock.getMockImplementation()!;
    let currentSel: NonNullable<ReturnType<NonNullable<typeof canvas.selection>>> = selected;
    fetcherMock.mockImplementation(async (url, init) => {
      const res = await prevImpl(url, init);
      currentSel = { canvasId: 'other-message::canvas::0', revision: 2, open: true, fullscreen: false, mode: 'diagram' };
      return res;
    });
    const spokenMidUnowned = f.spoken.length;
    f.h.modelWires.push(skillWire('control_canvas', { action: 'zoom_in' }, 'ctrl-mid-unowned'));
    const midUnownedTurn = await f.submit('Zoom in again.');
    await f.execute(midUnownedTurn, undefined, { ...canvas, selection: () => currentSel, control: applied });
    fetcherMock.mockImplementation(prevImpl);
    expect(applied).not.toHaveBeenCalled();
    expect(f.spoken.slice(spokenMidUnowned).join('')).toBe('No Canvas is currently open.');
    expect(memory.foundation.result(memory.find(midUnownedTurn.sessionId, midUnownedTurn.turnId)!.turn)!
      .calendar!.results[0]!.resultRef.content).toBe(controlExpectation('zoom_in', 'unavailable', target));

    const ac = new AbortController();
    fetcherMock.mockImplementation(async (url, init) => {
      const res = await prevImpl(url, init);
      ac.abort();
      return res;
    });
    f.h.modelWires.push(skillWire('control_canvas', { action: 'fit_to_view' }, 'ctrl-aborted'));
    const abortedTurn = await f.submit('Fit it.');
    await f.h.runtime.executeTurn({
      userId: f.h.identity.userId,
      ...abortedTurn,
      signal: ac.signal,
      emit: async () => undefined,
      emitCalendar: async () => undefined,
      live: {
        reservation: f.reservation,
        start: async () => undefined,
        delta: async () => undefined,
        finish: f.finish,
        artifact: async () => false,
        settle: async () => undefined,
        canvas: { ...canvas, selection: () => selected, control: applied },
      },
    }).catch(() => undefined);
    fetcherMock.mockImplementation(prevImpl);

    expect(applied).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
}, 5000);

it('applies distinct native control calls across turns in one LLM call each and skips turn replays', async () => {
  const { f, target, canvas, memory } = await seededLiveNavigation();
  const selected = { canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'diagram' as const };
  const applied = vi.fn(() => true);
  const fullCanvas = { ...canvas, selection: () => selected, control: applied };
  try {
    f.h.modelWires.push(skillWire('control_canvas', { action: 'zoom_in' }, 'ctrl-dup-1'));
    const first = await f.submit('Zoom in.');
    await f.execute(first, undefined, fullCanvas);
    expect(applied).toHaveBeenCalledTimes(1);

    const bodies = f.h.modelBodies.length;
    await f.execute(first, undefined, fullCanvas);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(f.h.modelBodies.length).toBe(bodies);

    f.h.modelWires.push(skillWire('control_canvas', { action: 'zoom_in' }, 'ctrl-repeat-2'));
    const repeatTurn = await f.submit('Zoom in more.');
    await f.execute(repeatTurn, undefined, fullCanvas);
    f.h.modelWires.push(skillWire('control_canvas', { action: 'fit_to_view' }, 'ctrl-distinct-2'));
    const second = await f.submit('Fit to view.');
    await f.execute(second, undefined, fullCanvas);
    expect(applied).toHaveBeenCalledTimes(3);
    expect(applied.mock.calls.map((c: unknown[]) => [c[0], c[2]])).toEqual([
      [{ action: 'zoom_in' }, 'ctrl-dup-1'],
      [{ action: 'zoom_in' }, 'ctrl-repeat-2'],
      [{ action: 'fit_to_view' }, 'ctrl-distinct-2'],
    ]);
    const pair = memory.foundation.result(memory.find(second.sessionId, second.turnId)!.turn)!.calendar!;
    expect(pair.results).toHaveLength(1);
  } finally { await f.dispose(); }
}, 5000);

it('records delivery-unavailable without executing or calling LLM on a restored execute checkpoint for control_canvas', async () => {
  const f = await calendarLiveFixture('durable');
  const applied = vi.fn(() => true);
  let executeCalled = false;
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    f.h.modelWires.push(textWire('Diagram.\n\n```mermaid title="Sys"\nflowchart TD\nA --> B\n```'));
    const seed = await f.submit('Draw Sys.');
    await f.execute(seed);
    const records = await f.h.p.messages.listForContext(f.h.identity.userId, f.sessionId, { cursor: null, limit: 20 });
    const assistant = records.items.find(record => record.role === 'assistant' && record.turnId === seed.turnId)!;
    const target = `${assistant.messageId}::canvas::0`;
    const selected = { canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'diagram' as const };

    const ids = await f.submit('Zoom in.');
    spy = vi.spyOn(CalendarLoop.prototype, 'decide').mockImplementationOnce(async function (this: CalendarLoop) {
      executeCalled = true;
      const internal = this as unknown as {
        ctx: {
          attempt: { userId: string; sessionId: string; turnId: string; attemptId: string; createdAt: string };
          persistence: typeof f.h.p; snapshot: { revision: number };
          binding: { connectionId: string; connectionRevision: number };
          ledger: CalendarTurnLedger;
        };
        groups: unknown[];
        assemble: (groups: unknown[], repair: unknown) => Parameters<CalendarTurnLedger['reserveDispatch']>[1];
        cursor: Record<string, unknown>;
        refs: () => unknown;
      };
      const dispatch = await internal.ctx.ledger.reserveDispatch(
        'initial', internal.assemble(internal.groups, null), null);
      const dispatchBinding = await internal.ctx.ledger.bindingFor(dispatch);
      await dispatchBinding.hooks.beforeDispatch();
      await internal.ctx.ledger.finishDispatch(dispatch.dispatchId, null);
      const decisionId = dispatch.decisionId;
      await internal.ctx.persistence.skillDecisions.put({
        schemaVersion: 3, protocolVersion: 'plugin-skills.v1', kind: 'calendar-model-decision',
        userId: internal.ctx.attempt.userId, sessionId: internal.ctx.attempt.sessionId,
        turnId: internal.ctx.attempt.turnId, attemptId: internal.ctx.attempt.attemptId,
        decisionId, dispatchId: dispatch.dispatchId, configRevision: internal.ctx.snapshot.revision,
        connectionId: internal.ctx.binding.connectionId,
        connectionRevision: internal.ctx.binding.connectionRevision,
        schemaRevision: 'google-calendar.v2',
        rejectedDecisionId: null, sources: [],
        decision: {
          kind: 'control_canvas', decisionId,
          nativeCall: {
            id: 'ctrl-restored-1',
            type: 'function',
            function: { name: 'control_canvas', arguments: '{"action":"zoom_in"}' },
          },
          assistantContent: null,
          envelope: { action: 'zoom_in' },
          terminal: 'tool_calls',
        },
        operationId: null, intentId: null, proposalId: null, createdAt: internal.ctx.attempt.createdAt,
      });
      internal.cursor = { ...internal.cursor, next: 'execute', pendingDecisionId: decisionId, repair: null };
      return { calendarCursor: internal.cursor as never, calendarRefs: internal.refs() as never };
    });

    const beforeBodies = f.h.modelBodies.length;
    const spokenBefore = f.spoken.length;
    const fullCanvas = {
      inventory: () => ({ items: [{ canvasId: target, title: 'Sys',
        owner: { kind: 'message', id: assistant.messageId } }], omitted: 0 }),
      active: () => true,
      show: () => true,
      selection: () => selected,
      control: applied,
    };
    await f.execute(ids, undefined, fullCanvas);
    expect(executeCalled).toBe(true);
    expect(applied).not.toHaveBeenCalled();
    expect(f.h.modelBodies.length - beforeBodies).toBe(0);
    expect(f.spoken.slice(spokenBefore).join('')).toBe("I couldn't reach the Canvas right now.");

    f.h.modelWires.push(textWire('Okay.'));
    const follow = await f.submit('What happened?');
    await f.execute(follow, undefined, fullCanvas);
    expect(f.h.modelBodies.at(-1)!.messages).toContainEqual(expect.objectContaining({
      role: 'tool',
      name: 'control_canvas',
      tool_call_id: 'ctrl-restored-1',
      content: controlExpectation('zoom_in', 'delivery-unavailable', null),
    }));
  } finally {
    spy?.mockRestore();
    await f.dispose();
  }
}, 5000);

it('retains staged local control evidence if accounting fails, without replay', async () => {
  const { f, target, canvas, memory } = await seededLiveNavigation();
  const selected = { canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'diagram' as const };
  const applied = vi.fn(() => true);
  const fullCanvas = { ...canvas, selection: () => selected, control: applied };
  const finishDispatch = MemoryCalendarLedger.prototype.finishDispatch;
  let shouldFail = true;
  const ledgerSpy = vi.spyOn(MemoryCalendarLedger.prototype, 'finishDispatch')
    .mockImplementation(async function (this: MemoryCalendarLedger, ...args) {
      const out = await finishDispatch.apply(this, args);
      if (shouldFail) {
        shouldFail = false;
        throw new AppError('PROVIDER_ERROR', 'Accounting failed.', false);
      }
      return out;
    });
  try {
    f.h.modelWires.push(skillWire('control_canvas', { action: 'fit_to_view' }, 'ctrl-acct-fail'));
    const second = await f.submit('Fit it.');
    const beforeBodies = f.h.modelBodies.length;
    await f.execute(second, undefined, fullCanvas);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(f.h.modelBodies.length - beforeBodies).toBe(1);
    const acctFailed = memory.foundation.result(memory.find(second.sessionId, second.turnId)!.turn)!;
    expect(acctFailed.status).toBe('failed');
    expect(acctFailed.calendar!.results[0]!.resultRef.content)
      .toBe(controlExpectation('fit_to_view', 'requested', target));
    await f.execute(second, undefined, fullCanvas);
    expect(applied).toHaveBeenCalledTimes(1);
  } finally {
    ledgerSpy.mockRestore();
    await f.dispose();
  }
}, 5000);

it('does not block a following turn when background persistence fails or never settles', async () => {
  const saveGate = deferred<{ kind: 'unknown'; retryable: false }>();
  const { f, seed, target, canvas, memory } = await seededLiveNavigation({ save: () => saveGate.promise });
  const selected = { canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'diagram' as const };
  const applied = vi.fn(() => true);
  const fullCanvas = { ...canvas, selection: () => selected, control: applied };
  try {
    expect(memory.foundation.saveState(memory.find(f.sessionId, seed.turnId)!.turn)).not.toBe('saved');
    const spokenBefore = f.spoken.length;
    f.h.modelWires.push(skillWire('control_canvas', { action: 'zoom_out' }, 'ctrl-pending-save'));
    const ids = await f.submit('Zoom out.');
    await f.execute(ids, undefined, fullCanvas);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(f.spoken.slice(spokenBefore).join('')).toBe('Zoomed out.');
    expect(memory.foundation.saveState(memory.find(ids.sessionId, ids.turnId)!.turn)).not.toBe('saved');

    // Next turn proceeds immediately without waiting for saveGate and keeps prior control pair.
    f.h.modelWires.push(textWire('Following response.'));
    const before = f.h.modelBodies.length;
    const followUp = await f.submit('Carry on.');
    await f.execute(followUp, undefined, fullCanvas);
    expect(f.h.modelBodies.length - before).toBe(1);
    expect(f.h.modelBodies.at(-1)!.messages).toContainEqual(expect.objectContaining({
      role: 'tool',
      name: 'control_canvas',
      tool_call_id: 'ctrl-pending-save',
      content: controlExpectation('zoom_out', 'requested', target),
    }));
    expect(applied).toHaveBeenCalledTimes(1);
  } finally {
    saveGate.resolve({ kind: 'unknown', retryable: false });
    await f.dispose();
  }
}, 5000);

it('completes open variants and every control_canvas action with deterministic 1-call TTS confirmation', async () => {
  const { f, show, target, canvas, memory } = await seededLiveNavigation();
  const applied = vi.fn(() => true);
  let selection = {
    canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'diagram' as const,
  };
  const port = { ...canvas, selection: () => selection, control: applied };
  try {
    // open when already open & viewed -> no show, deterministic "already looking at it" message
    let spokenStart = f.spoken.length;
    let bodiesBefore = f.h.modelBodies.length;
    f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-already-1'));
    await f.execute(await f.submit('Open Pricing comparison.'), undefined, port);
    expect(show).not.toHaveBeenCalled();
    expect(f.h.modelBodies.length - bodiesBefore).toBe(1);
    expect(f.spoken.slice(spokenStart).join('')).toBe('You are already looking at it right now');

    // open missing ID -> no show, deterministic not-found message
    spokenStart = f.spoken.length;
    f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: 'missing::canvas::0' }, 'open-miss-1'));
    await f.execute(await f.submit('Open missing.'), undefined, port);
    expect(show).not.toHaveBeenCalled();
    expect(f.spoken.slice(spokenStart).join('')).toBe("I couldn't find that Canvas.");

    // open succeeds even if selection revision changed mid-flight (no revision fencing for open)
    const fetcherMock = f.h.fetcher as ReturnType<typeof vi.fn<typeof fetch>>;
    const prevImpl = fetcherMock.getMockImplementation()!;
    let bumpOnce = true;
    fetcherMock.mockImplementation(async (url, init) => {
      const res = await prevImpl(url, init);
      if (bumpOnce) { bumpOnce = false; selection = { ...selection, revision: 9, open: false }; }
      return res;
    });
    spokenStart = f.spoken.length;
    f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-bumped-1'));
    await f.execute(await f.submit('Reopen Pricing comparison.'), undefined, port);
    fetcherMock.mockImplementation(prevImpl);
    expect(show).toHaveBeenCalledExactlyOnceWith(target);
    expect(f.spoken.slice(spokenStart).join('')).toBe('You are looking at Pricing comparison right now');

    // open delivery-unavailable
    spokenStart = f.spoken.length;
    show.mockReturnValueOnce(false);
    f.h.modelWires.push(skillWire('control_canvas', { action: 'open', canvas_id: target }, 'open-deliv-fail'));
    await f.execute(await f.submit('Reopen again.'), undefined, { ...port, selection: () => ({ ...selection, open: false }) });
    expect(f.spoken.slice(spokenStart).join('')).toBe("I couldn't update the Canvas view right now.");

    // Every remaining action when open & eligible gives deterministic 1-call TTS.
    // Run across two bounded sessions so cumulative historical groups remain well within chat context budgets.
    const batchOne = [
      [{ action: 'zoom_in' }, 'Zoomed in.', false],
      [{ action: 'zoom_out' }, 'Zoomed out.', false],
      [{ action: 'fit_to_view' }, 'Fitted to view.', false],
      [{ action: 'reset_view' }, 'Reset the view.', false],
    ] as const;
    for (const [index, [cmd, tts, fs]] of batchOne.entries()) {
      selection = { canvasId: target, revision: 20 + index, open: true, fullscreen: fs, mode: 'diagram' };
      spokenStart = f.spoken.length;
      bodiesBefore = f.h.modelBodies.length;
      f.h.modelWires.push(skillWire('control_canvas', cmd, `act-b1-${index}`));
      const sub = await f.submit(`Action b1 ${index}`);
      await f.execute(sub, undefined, port);
      expect(memory.find(sub.sessionId, sub.turnId)?.error, `Batch 1 action ${index}`).toBeNull();
      expect(f.h.modelBodies.length - bodiesBefore, `Batch 1 action ${index}`).toBe(1);
      expect(f.spoken.slice(spokenStart).join('')).toBe(tts);
    }

    const second = await seededLiveNavigation();
    try {
      let secondSelection = {
        canvasId: second.target, revision: 1, open: true, fullscreen: false, mode: 'diagram' as const,
      };
      const secondPort = { ...second.canvas, selection: () => secondSelection, control: applied };
      const batchTwo = [
        [{ action: 'fullscreen', state: 'enter' }, 'Entered fullscreen.', false],
        [{ action: 'fullscreen', state: 'exit' }, 'Exited fullscreen.', true],
        [{ action: 'scroll', direction: 'up' }, 'Scrolled up.', false],
        [{ action: 'scroll', direction: 'down' }, 'Scrolled down.', false],
        [{ action: 'scroll', direction: 'left' }, 'Scrolled left.', false],
        [{ action: 'scroll', direction: 'right' }, 'Scrolled right.', false],
        [{ action: 'close' }, 'Closed the Canvas.', false],
      ] as const;
      for (const [index, [cmd, tts, fs]] of batchTwo.entries()) {
        secondSelection = { canvasId: second.target, revision: 30 + index, open: true, fullscreen: fs, mode: 'diagram' };
        const sStart = second.f.spoken.length;
        const bBefore = second.f.h.modelBodies.length;
        second.f.h.modelWires.push(skillWire('control_canvas', cmd, `act-b2-${index}`));
        const sub = await second.f.submit(`Action b2 ${index}`);
        await second.f.execute(sub, undefined, secondPort);
        expect(second.memory.find(sub.sessionId, sub.turnId)?.error, `Batch 2 action ${index}`).toBeNull();
        expect(second.f.h.modelBodies.length - bBefore, `Batch 2 action ${index}`).toBe(1);
        expect(second.f.spoken.slice(sStart).join('')).toBe(tts);
      }
      expect(applied).toHaveBeenCalledTimes(batchOne.length + batchTwo.length);
    } finally {
      await second.f.dispose();
    }
  } finally { await f.dispose(); }
}, 10000);

it('repairs redundant control_canvas calls via repairOrSeal without touching UI and handles exhausted retries', async () => {
  const { f, target, canvas } = await seededLiveNavigation();
  const applied = vi.fn(() => true);
  const show = vi.fn(() => true);
  try {
    const cases = [
      { desc: 'close while closed', sel: { canvasId: target, revision: 1, open: false, fullscreen: false, mode: 'diagram' as const }, cmd: { action: 'close' } },
      { desc: 'fullscreen enter while fullscreen', sel: { canvasId: target, revision: 1, open: true, fullscreen: true, mode: 'diagram' as const }, cmd: { action: 'fullscreen', state: 'enter' } },
      { desc: 'fullscreen enter while closed', sel: { canvasId: target, revision: 1, open: false, fullscreen: false, mode: 'diagram' as const }, cmd: { action: 'fullscreen', state: 'enter' } },
      { desc: 'fullscreen exit while not fullscreen', sel: { canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'diagram' as const }, cmd: { action: 'fullscreen', state: 'exit' } },
      { desc: 'zoom_in while closed', sel: { canvasId: target, revision: 1, open: false, fullscreen: false, mode: 'diagram' as const }, cmd: { action: 'zoom_in' } },
      { desc: 'scroll while closed', sel: { canvasId: target, revision: 1, open: false, fullscreen: false, mode: 'diagram' as const }, cmd: { action: 'scroll', direction: 'down' } },
      { desc: 'zoom_in while scroll mode (zoomable=false)', sel: { canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'scroll' as const }, cmd: { action: 'zoom_in' } },
      { desc: 'fit_to_view while scroll mode (zoomable=false)', sel: { canvasId: target, revision: 1, open: true, fullscreen: false, mode: 'scroll' as const }, cmd: { action: 'fit_to_view' } },
    ] as const;

    for (const [idx, c] of cases.entries()) {
      const port = { ...canvas, show, selection: () => c.sel, control: applied };
      const spokenStart = f.spoken.length;
      const bodiesBefore = f.h.modelBodies.length;
      f.h.modelWires.push(
        skillWire('control_canvas', c.cmd, `redundant-${idx}`),
        textWire(`Handled directly: ${c.desc}`),
      );
      await f.execute(await f.submit(`Redundant ${c.desc}`), undefined, port);
      expect(applied).not.toHaveBeenCalled();
      expect(show).not.toHaveBeenCalled();
      expect(f.h.modelBodies.length - bodiesBefore).toBe(2);
      const retryMsgs = f.h.modelBodies.at(-1)!.messages as { role: string; content?: string }[];
      expect(retryMsgs.at(-1)?.content).toContain('answer from that state instead of repeating it');
      expect(f.spoken.slice(spokenStart).join('')).toBe(`Handled directly: ${c.desc}`);
    }

    // Repeated redundant calls exhaust repair budget (limits.repairs = 2 -> 3 attempts) and seal without UI dispatch.
    const port = {
      ...canvas,
      show,
      selection: () => ({ canvasId: target, revision: 2, open: false, fullscreen: false, mode: 'diagram' as const }),
      control: applied,
    };
    const spokenStart = f.spoken.length;
    f.h.modelWires.push(
      skillWire('control_canvas', { action: 'close' }, 'exhaust-1'),
      skillWire('control_canvas', { action: 'close' }, 'exhaust-2'),
      skillWire('control_canvas', { action: 'close' }, 'exhaust-3'),
    );
    await f.execute(await f.submit('Close it again.'), undefined, port);
    expect(applied).not.toHaveBeenCalled();
    expect(f.spoken.slice(spokenStart).join('')).toContain('I could not complete that Canvas request');
  } finally { await f.dispose(); }
}, 10000);
