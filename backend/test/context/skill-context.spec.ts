/**
 * ============================================================================
 * FILE: skill-context.spec.ts
 * LOCATION: backend/test/context/skill-context.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify historical local skill groups are inserted at their originating turn
 *    without rewriting the existing stable prefix.
 *
 * ROLE IN PROJECT:
 *    Guards P2 context assembly: position metadata, local-result classification,
 *    disclosure authority, and context limits.
 *
 * KEY COMPONENTS:
 *    - PositionedContext fixture with an old user turn.
 *    - calendarContext insertion and loaded-skill derivation assertions.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import { CALENDAR_TOOLS, SKILL_NATIVE_TOOLS } from '../../src/contracts/calendar-tools.js';
import { CALENDAR_LIMITS } from '../../src/contracts/calendar-policy.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { calendarContext } from '../../src/context/calendar-context.js';
import { estimateMessagesTokens } from '../../src/context/context-budget.js';
import { compactedHistoryMessage } from '../../src/context/compaction-prompt.js';
import type { PositionedContext } from '../../src/context/referenced-context-assembler.js';
import { assembleTurnCalendarContext } from '../../src/chat-runtime/calendar-loop.js';
import { activateLocalSkill } from '../../src/chat-runtime/calendar-skills.js';
import { webToolGroupSchema } from '../../src/chat-runtime/memory-web-state.js';
import { completeToolGroupV2Schema } from '../../src/contracts/calendar-model.js';
import { CALENDAR_TOMBSTONE } from '../../src/contracts/calendar-sources.js';
import { repairInstruction } from '../../src/model/calendar-repair.js';
import { textSnapshot } from '../model/config-snapshot.js';

it('inserts local groups in the original turn without rewriting the existing prefix', () => {
  const envelope = { plugin: 'google-calendar', tools: ['calendar_get_event'] };
  const result = activateLocalSkill(envelope, new Map(), 16384);
  const group = completeToolGroupV2Schema.parse({ assistant: { role: 'assistant', content: 'Looking up the schema.',
    tool_calls: [{ id: 'load-old', type: 'function', function: { name: 'activate_skill',
      arguments: JSON.stringify(envelope) } }] }, result: { role: 'tool', name: 'activate_skill',
    tool_call_id: 'load-old', content: JSON.stringify(result) }, sources: [] });
  const context: PositionedContext = { contextVersion: 1, instructionVersion: 'i', knowledgeContentHash: 'k',
    graphSchemaVersion: 'g', messages: [{ role: 'system', content: 'unchanged' },
      { role: 'user', content: 'Read it' }, { role: 'assistant', content: 'Done' },
      { role: 'user', content: 'Read it' }], prefixCount: 1, historyPositions: [
      { messageId: 'u1', turnId: 't1', role: 'user', index: 1 },
      { messageId: 'a1', turnId: 't1', role: 'assistant', index: 2 }] };
  const assembled = calendarContext({ context, acceptedInput: 'Read it', groups: [], repair: null,
    tools: SKILL_NATIVE_TOOLS, historicalGroups: new Map([['t1', [group]]]),
    budgets: DEFAULT_BUDGETS, limits: CALENDAR_LIMITS, binding: {
      userId: 'u', connectionId: 'c', connectionRevision: 1, googleSubjectId: 'sub' }, now: Date.now() });
  const withoutCatalog = assembled.messages.filter(message => !message.content?.startsWith('Enabled plugin catalog (trusted application metadata):'));
  expect(withoutCatalog).toEqual([context.messages[0], context.messages[1],
    group.assistant, group.result, context.messages[2], context.messages[3]]);
  expect(assembled.loadedSkills.get('google-calendar:calendar_get_event')).toMatchObject({ disclosureCallId: 'load-old' });
  expect(CALENDAR_TOOLS.find(t => t.name === 'calendar_get_event')!.inputSchema).toEqual(
    result.kind === 'skill-disclosure' ? result.disclosures[0]!.inputSchema : null);
  expect(() => calendarContext({ context, acceptedInput: 'Read it', groups: [], repair: null,
    tools: SKILL_NATIVE_TOOLS, historicalGroups: new Map([['t1', [group]]]),
    budgets: { ...DEFAULT_BUDGETS, maxMessagesInContext: 4 }, limits: CALENDAR_LIMITS,
    binding: { userId: 'u', connectionId: 'c', connectionRevision: 1, googleSubjectId: 'sub' }, now: Date.now() }))
    .toThrow(/context limit/);
});

it('does not present withheld calendar history as a failed lookup the user never saw', () => {
  const listing = 'You have one event today: ND3.0 Progress Updates, 10:30 to 11:00 UTC';
  const unavailable = JSON.stringify({
    kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE,
  });
  const group = completeToolGroupV2Schema.parse({
    assistant: { role: 'assistant', content: null, tool_calls: [{ id: 'list-old', type: 'function',
      function: { name: 'call_tool', arguments: JSON.stringify({
        plugin: 'google-calendar', tool: 'calendar_list_events', arguments: {},
      }) } }] },
    result: { role: 'tool', name: 'call_tool', tool_call_id: 'list-old', content: unavailable },
    sources: [],
  });
  const context: PositionedContext = {
    contextVersion: 1, instructionVersion: 'i', knowledgeContentHash: 'k', graphSchemaVersion: 'g',
    messages: [
      { role: 'system', content: 'unchanged' },
      { role: 'user', content: 'What is on my calendar today?' },
      { role: 'assistant', content: listing },
      { role: 'user', content: 'nice' },
    ],
    prefixCount: 1,
    historyPositions: [
      { messageId: 'u1', turnId: 't1', role: 'user', index: 1 },
      { messageId: 'a1', turnId: 't1', role: 'assistant', index: 2 },
    ],
  };
  const assembled = calendarContext({
    context, acceptedInput: 'nice', groups: [], repair: null, tools: SKILL_NATIVE_TOOLS,
    historicalGroups: new Map([['t1', [group]]]), budgets: DEFAULT_BUDGETS, limits: CALENDAR_LIMITS,
    binding: { userId: 'u', connectionId: 'c', connectionRevision: 1, googleSubjectId: 'sub' },
    now: Date.now(), compatibility: 'historical',
  });
  const prompt = JSON.stringify(assembled.messages);
  expect(assembled.messages).toContainEqual({ role: 'assistant', content: listing });
  expect(assembled.messages).toContainEqual({ role: 'user', content: 'nice' });
  expect(assembled.messages).not.toContainEqual(group.assistant);
  expect(assembled.messages).not.toContainEqual(group.result);
  expect(prompt).not.toContain(CALENDAR_TOMBSTONE);
  expect(prompt).toMatch(/do not recant/i);
});

it('reports the trusted Calendar account connection in the plugin catalog', () => {
  const context: PositionedContext = { contextVersion: 1, instructionVersion: 'i',
    knowledgeContentHash: 'k', graphSchemaVersion: 'g', messages: [
      { role: 'system', content: 'unchanged' }, { role: 'user', content: 'Hello' }],
    prefixCount: 1, historyPositions: [] };
  const assemble = (calendarConnection: 'connected' | 'not-connected') => calendarContext({
    context, acceptedInput: 'Hello', groups: [], repair: null, tools: SKILL_NATIVE_TOOLS,
    budgets: DEFAULT_BUDGETS, limits: CALENDAR_LIMITS, calendarConnection,
    binding: { userId: 'u', connectionId: 'c', connectionRevision: 1, googleSubjectId: 'sub' },
    now: Date.now(),
  }).messages.find(message => message.content?.startsWith(
    'Enabled plugin catalog (trusted application metadata):'))?.content ?? '';
  expect(assemble('connected')).toContain('"connection":"connected"');
  expect(assemble('not-connected')).toContain('"connection":"not-connected"');
});

it('serializes an empty enabled plugin catalog when the plugin is disabled', () => {
  const context: PositionedContext = { contextVersion: 1, instructionVersion: 'i',
    knowledgeContentHash: 'k', graphSchemaVersion: 'g', messages: [
      { role: 'system', content: 'unchanged' }, { role: 'system', content: 'Environment' },
      { role: 'system', content: 'Response mode: voice.' }, { role: 'user', content: 'Hello' }],
    prefixCount: 3, historyPositions: [] };
  const assembled = calendarContext({ context, acceptedInput: 'Hello', groups: [], repair: null,
    tools: SKILL_NATIVE_TOOLS, budgets: DEFAULT_BUDGETS, limits: CALENDAR_LIMITS,
    enabledPluginTools: [], binding: {
      userId: 'u', connectionId: 'c', connectionRevision: 1, googleSubjectId: 'sub' }, now: Date.now() });
  const catalog = assembled.messages.find(message => message.content?.startsWith(
    'Enabled plugin catalog (trusted application metadata):'));
  expect(catalog).toEqual({ role: 'system',
    content: 'Enabled plugin catalog (trusted application metadata):\n[]' });
  expect(assembled.messages.filter(message => message.role === 'user')).toHaveLength(1);
  expect(JSON.stringify(assembled.messages)).not.toContain('Scheduling and availability');
  expect(assembled.messages.slice(0, 3)).toEqual(context.messages.slice(0, 3));
});

it.each([false, true])('bounds the voice suffix without rewriting native history (composite=%s)', composite => {
  const acceptedInput = '  Keep my exact input.\n ';
  const summary = compactedHistoryMessage('Earlier task.');
  const oldUser = { role: 'user' as const, content: 'Old question' };
  const oldAnswer = { role: 'assistant' as const, content: 'Old answer' };
  const context: PositionedContext = {
    contextVersion: 1, instructionVersion: 'i', knowledgeContentHash: 'k', graphSchemaVersion: 'g',
    messages: [{ role: 'system', content: 'Fixture rules' }, summary, oldUser, oldAnswer,
      { role: 'user', content: acceptedInput }],
    prefixCount: 1, historyPositions: [
      { messageId: 'u1', turnId: 't1', role: 'user', index: 2 },
      { messageId: 'a1', turnId: 't1', role: 'assistant', index: 3 },
    ],
  };
  const envelope = { plugin: 'google-calendar', tools: ['calendar_get_event'] };
  const local = (id: string) => completeToolGroupV2Schema.parse({
    assistant: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function',
      function: { name: 'activate_skill', arguments: JSON.stringify(envelope) } }] },
    result: { role: 'tool', name: 'activate_skill', tool_call_id: id,
      content: JSON.stringify(activateLocalSkill(envelope, new Map(), 16384)) },
    sources: [],
  });
  const web = (id: string) => webToolGroupSchema.parse({
    ordinal: 0, afterCalendarGroups: 0,
    assistant: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function',
      function: { name: 'web_tool', arguments: '{"mode":"fetch","url":"https://example.test/a"}' } }] },
    result: { role: 'tool', name: 'web_tool', tool_call_id: id,
      content: '{"url":"https://example.test/a","body":"retained"}' },
    sources: [],
  });
  const oldLocal = local('old-calendar'), currentLocal = local('current-calendar');
  const oldWeb = web('old-web'), currentWeb = web('current-web');
  const snapshot = textSnapshot();
  const repair = { rejectedDecisionId: 'bad-decision', diagnostics: [
    { path: 'summary', code: 'missing' as const, expected: 'string' },
  ] };
  const assemble = (responseMode: 'voice' | 'text', budgets = snapshot.budgets, note?: string) =>
    assembleTurnCalendarContext({
      context, acceptedInput, groups: [currentLocal],
      historicalGroups: new Map([['t1', [oldLocal]]]),
      ...(composite ? {
        historicalWebGroups: new Map([['t1', [oldWeb]]]), webGroups: [currentWeb],
      } : {}),
      repair, snapshot: { ...snapshot, budgets }, limits: CALENDAR_LIMITS,
      binding: { userId: 'u', connectionId: 'c', connectionRevision: 1, googleSubjectId: 'sub' },
      nowMs: Date.parse('2026-10-21T09:00:00Z'), responseMode, note,
      canvasInventory: { items: [], omitted: 0 },
    });
  const old = [summary, oldUser, ...(composite ? [oldWeb.assistant, oldWeb.result] : []),
    oldLocal.assistant, oldLocal.result, oldAnswer];
  const current = [{ role: 'user', content: acceptedInput },
    ...(composite ? [currentWeb.assistant, currentWeb.result] : []),
    currentLocal.assistant, currentLocal.result,
    { role: 'system', content: repairInstruction(repair.diagnostics) }];
  const historyCap = estimateMessagesTokens([...old, ...current]);
  const roomy = { ...snapshot.budgets, maxContextTokens: 30_000 };
  const exact = { ...roomy, maxHistoryTokens: historyCap };
  const voice = assemble('voice', exact);
  const text = assemble('text', exact);
  expect(voice.messages[1]?.content).toContain('Enabled plugin catalog');
  expect(text.messages.slice(2)).toEqual([...old, ...current]);
  expect(voice.messages.slice(2, 2 + old.length)).toEqual(old);
  expect(voice.messages[2 + old.length]).toMatchObject({
    role: 'system', content: expect.stringMatching(/^Canvas state \(voice-only/),
  });
  expect(voice.messages.slice(3 + old.length)).toEqual(current);
  expect(voice.estimatedInputTokens).toBeGreaterThan(text.estimatedInputTokens);
  const note = 'Model-only note.';
  expect(assemble('voice', { ...roomy, maxHistoryTokens: 10_000 }, note).messages)
    .toEqual([...voice.messages, { role: 'system', content: note }]);
  expect(() => assemble('voice', { ...exact, maxHistoryTokens: historyCap - 1 }))
    .toThrow("This chat's saved history exceeds the configured history limit.");
  expect(() => assemble('voice', { ...exact, maxMessagesInContext: voice.messages.length - 1 }))
    .toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
  const fullCap = voice.estimatedInputTokens + exact.maxOutputTokens + exact.modelMarginTokens;
  expect(assemble('voice', { ...exact, maxContextTokens: fullCap }).messages).toEqual(voice.messages);
  expect(() => assemble('voice', { ...exact, maxContextTokens: fullCap - 1 }))
    .toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
});
