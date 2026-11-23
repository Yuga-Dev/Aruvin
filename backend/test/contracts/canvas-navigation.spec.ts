/**
 * ============================================================================
 * FILE: canvas-navigation.spec.ts
 * LOCATION: backend/test/contracts/canvas-navigation.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the direct native show_canvas catalogue entry, strict arguments,
 *    bounded results, and source-free native history compatibility.
 *
 * ROLE IN PROJECT:
 *    Contract coverage for voice-only Canvas navigation before runtime wiring.
 *
 * KEY COMPONENTS:
 *    - SKILL_NATIVE_TOOLS show_canvas definition and stable order.
 *    - showCanvasArgumentsSchema / canvasNavigationResultSchema bounds.
 *    - skillDecisionSchema, skillGroup, and nativeLocalResultSchema pairing.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  SKILL_NATIVE_TOOLS, nativeLocalResultSchema, serializeNativeLocalResult,
} from '../../src/contracts/calendar-tools.js';
import {
  canvasControlResultSchema, canvasNavigationResultSchema, controlCanvasArgumentsSchema,
  controlCanvasEnvelopeSchema, showCanvasArgumentsSchema,
} from '../../src/contracts/canvas-navigation.js';
import {
  historicalSkillDecisionSchema, resumableSkillDecisionSchema, skillDecisionSchema,
} from '../../src/contracts/calendar-model.js';
import { redactCalendarDecisionForAccount } from '../../src/persistence/calendar-records.js';
import { repairInstruction, assertNativeHistory } from '../../src/model/calendar-repair.js';
import { validateCalendarCandidate, type CandidateBatch } from '../../src/model/calendar-validation.js';
import { CALENDAR_LIMITS, SKILL_PROTOCOL_VERSION } from '../../src/contracts/calendar-policy.js';
import { skillGroup } from '../../src/chat-runtime/calendar-skills.js';
import { calendarContext } from '../../src/context/calendar-context.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import type { PositionedContext } from '../../src/context/referenced-context-assembler.js';

describe('unified control_canvas open contract and historical show_canvas support', () => {
  it('advertises unified control_canvas (with open) and omits show_canvas from live SKILL_NATIVE_TOOLS', () => {
    expect(SKILL_NATIVE_TOOLS.map(t => t.name)).toEqual([
      'activate_skill', 'call_tool', 'control_canvas', 'get_environment',
    ]);
    const tool = SKILL_NATIVE_TOOLS[2]!;
    expect(Object.isFrozen(tool)).toBe(true);
    expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false,
      required: ['action'], properties: {
        action: { type: 'string', enum: ['open', 'zoom_in', 'zoom_out', 'fit_to_view', 'scroll', 'close', 'reset_view', 'fullscreen'] },
        canvas_id: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' },
      } });
    expect(controlCanvasArgumentsSchema.parse({ action: 'open', canvas_id: 'old-response::canvas::0' }))
      .toEqual({ action: 'open', canvas_id: 'old-response::canvas::0' });
    for (const input of [{ action: 'open' }, { action: 'open', canvas_id: '' }, { action: 'open', canvas_id: 'bad id' },
      { action: 'open', canvas_id: 'a', mode: 'voice' }, { action: 'open', canvas_id: 'a', state: 'enter' },
      { action: 'open', canvas_id: 'a', conversationId: 'other' }]) {
      expect(controlCanvasArgumentsSchema.safeParse(input).success).toBe(false);
    }
    expect(showCanvasArgumentsSchema.parse({ canvas_id: 'old-response::canvas::0' }))
      .toEqual({ canvas_id: 'old-response::canvas::0' });
  });

  it('bounds legacy navigation outcomes and rejects extra result fields', () => {
    for (const outcome of ['requested', 'mode-not-allowed', 'invalid-arguments',
      'unavailable', 'delivery-unavailable']) {
      expect(canvasNavigationResultSchema.safeParse({ kind: 'canvas-navigation',
        outcome, canvas_id: 'a' }).success).toBe(true);
    }
    expect(canvasNavigationResultSchema.safeParse({ kind: 'canvas-navigation',
      outcome: 'displayed', canvas_id: 'a' }).success).toBe(false);
    expect(canvasNavigationResultSchema.safeParse({ kind: 'canvas-navigation',
      outcome: 'requested', canvas_id: 'a', extra: true }).success).toBe(false);
    expect(canvasNavigationResultSchema.safeParse({ kind: 'canvas-navigation',
      outcome: 'requested', canvas_id: 'x'.repeat(257) }).success).toBe(false);
    expect(canvasNavigationResultSchema.safeParse({ kind: 'canvas-navigation',
      outcome: 'requested', canvas_id: null }).success).toBe(true);
  });

  it('rejects live show_canvas calls while retaining historical show_canvas decision parsing', () => {
    const raw = '{ "canvas_id": "old-response::canvas::0" }';
    const legacy = { kind: 'show_canvas', decisionId: 'd',
      nativeCall: { id: 'navigation-1', type: 'function', function: { name: 'show_canvas', arguments: raw } },
      assistantContent: null, envelope: { canvas_id: 'old-response::canvas::0' }, terminal: 'tool_calls' };
    expect(skillDecisionSchema.safeParse(legacy).success).toBe(false);
    const decision = historicalSkillDecisionSchema.parse(legacy);
    const content = JSON.stringify(canvasNavigationResultSchema.parse({ kind: 'canvas-navigation',
      outcome: 'requested', canvas_id: 'old-response::canvas::0' }));
    const group = skillGroup(decision, content);
    expect(group.assistant.tool_calls[0]!.function.arguments).toBe(raw);
    expect(group.result).toMatchObject({ name: 'show_canvas', tool_call_id: 'navigation-1', content });
    expect(group.sources).toEqual([]);
    expect(nativeLocalResultSchema.parse(JSON.parse(content))).toMatchObject({ outcome: 'requested' });
    expect(serializeNativeLocalResult(JSON.parse(content), CALENDAR_LIMITS.resultBytes)).toBe(content);

    const savedLegacy = resumableSkillDecisionSchema.parse({
      schemaVersion: 3, kind: 'calendar-model-decision', protocolVersion: SKILL_PROTOCOL_VERSION,
      userId: 'u', sessionId: 's', turnId: 't1', attemptId: 'a1', decisionId: 'd',
      dispatchId: 'disp-1', configRevision: 1, connectionId: 'c', connectionRevision: 1,
      schemaRevision: 'google-calendar.v2', rejectedDecisionId: null, decision,
      sources: [], operationId: null, intentId: null, proposalId: null,
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(savedLegacy.decision).toEqual(decision);
    expect(redactCalendarDecisionForAccount(
      savedLegacy,
      { userId: 'u', connectionId: 'c', connectionRevision: 2, googleSubjectId: 'sub' },
      1_700_000_001_000,
    )).toEqual(savedLegacy);
  });

  it('keeps decision identity strict for control_canvas open calls', () => {
    const raw = '{"action":"open","canvas_id":"a::canvas::0"}';
    const base = { kind: 'control_canvas', decisionId: 'd', nativeCall: { id: 'n1', type: 'function',
      function: { name: 'control_canvas', arguments: raw } }, assistantContent: null,
      envelope: { action: 'open', canvas_id: 'a::canvas::0' }, terminal: 'tool_calls' };
    expect(skillDecisionSchema.safeParse(base).success).toBe(true);
    expect(skillDecisionSchema.safeParse({ ...base, kind: 'show_canvas' }).success).toBe(false);
    expect(skillDecisionSchema.safeParse({ ...base,
      nativeCall: { ...base.nativeCall, function: { name: 'show_canvas', arguments: raw } } }).success).toBe(false);
    expect(skillDecisionSchema.safeParse({ ...base, envelope: { action: 'open', canvas_id: 'other::canvas::0' } }).success).toBe(false);
  });
});

describe('control_canvas candidate validation and legacy show_canvas rejection', () => {
  const candidate = (raw: string, name = 'control_canvas'): CandidateBatch => ({
    calls: [{ index: 0, id: 'navigation-1', type: 'function', name,
      arguments: raw, envelopeInvalid: false }], terminal: 'tool_calls', envelopeInvalid: false,
  });

  it('rejects unadvertised show_canvas candidates without admitting a decision', () => {
    const rejected = validateCalendarCandidate(
      candidate('{"canvas_id":"old-response::canvas::0"}', 'show_canvas'),
      SKILL_NATIVE_TOOLS,
      CALENDAR_LIMITS,
    );
    expect(rejected).toMatchObject({ kind: 'failure', failure: { code: 'UNKNOWN_OR_DISABLED_TOOL' } });
  });

  it('accepts one strict control_canvas open object and retains raw bytes', () => {
    const raw = '{ "action": "open", "canvas_id": "old-response::canvas::0" }';
    expect(validateCalendarCandidate(candidate(raw), SKILL_NATIVE_TOOLS, CALENDAR_LIMITS))
      .toEqual({ kind: 'valid', nativeCall: { id: 'navigation-1', type: 'function',
        function: { name: 'control_canvas', arguments: raw } },
        envelope: { action: 'open', canvas_id: 'old-response::canvas::0' } });
  });

  it.each([
    ['{}'],
    ['{"action":"open"}'],
    ['{"action":"open","canvas_id":7}'],
    ['{"action":"open","canvas_id":"bad id"}'],
    ['{"action":"open","canvas_id":"a","mode":"voice"}'],
  ])('retains a parseable object envelope for structured execution rejection: %s', (raw) => {
    const result = validateCalendarCandidate(candidate(raw), SKILL_NATIVE_TOOLS, CALENDAR_LIMITS);
    expect(result).toMatchObject({ kind: 'valid', envelope: JSON.parse(raw) });
    expect(controlCanvasArgumentsSchema.safeParse(JSON.parse(raw)).success).toBe(false);
  });

  it('rejects malformed and truncated arguments without preserving raw payloads', () => {
    for (const raw of ['{', '{"action":"open","action":"close"}', '[]', 'null', '"a"']) {
      const result = validateCalendarCandidate(candidate(raw), SKILL_NATIVE_TOOLS, CALENDAR_LIMITS);
      expect(result).toMatchObject({ kind: 'rejected' });
      expect(JSON.stringify(result)).not.toContain('SECRET');
    }
    const truncated = { ...candidate('{"action":"open","canvas_id":"a"}'), terminal: 'length' };
    expect(validateCalendarCandidate(truncated, SKILL_NATIVE_TOOLS, CALENDAR_LIMITS))
      .toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'truncated' }] });
    const parallel = { ...candidate('{"action":"open","canvas_id":"a"}'), calls: [
      candidate('{"action":"open","canvas_id":"a"}').calls[0]!,
      { ...candidate('{"action":"open","canvas_id":"b"}').calls[0]!, index: 1, id: 'navigation-2' }] };
    expect(validateCalendarCandidate(parallel, SKILL_NATIVE_TOOLS, CALENDAR_LIMITS))
      .toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'cardinality' }] });
  });

  it('tailors repair without suggesting activate_skill or show_canvas for a rejected Canvas control', () => {
    const text = repairInstruction([{ path: 'canvas_id', code: 'wrong-type', expected: 'string' }]);
    expect(text).toContain('no presentation action');
    expect(text).toContain('control_canvas');
    expect(text).not.toContain('activate_skill');
    expect(text).not.toContain('show_canvas');
  });
});

describe('historical show_canvas native history', () => {
  const raw = '{"canvas_id":"old-response::canvas::0"}';
  const decision = historicalSkillDecisionSchema.parse({ kind: 'show_canvas', decisionId: 'd',
    nativeCall: { id: 'navigation-1', type: 'function', function: { name: 'show_canvas', arguments: raw } },
    assistantContent: null, envelope: { canvas_id: 'old-response::canvas::0' }, terminal: 'tool_calls' });
  const result = JSON.stringify({ kind: 'canvas-navigation', outcome: 'requested',
    canvas_id: 'old-response::canvas::0' });
  const group = skillGroup(decision, result);

  it('stays paired and is not parsed as Calendar provenance', () => {
    expect(() => assertNativeHistory([group.assistant, group.result])).not.toThrow();
  });

  it('is classified as a local source-free group in historical context without leaking text-mode Canvas state', () => {
    const context: PositionedContext = { contextVersion: 1, instructionVersion: 'i',
      knowledgeContentHash: 'k', graphSchemaVersion: 'g', messages: [
        { role: 'system', content: 'unchanged' }, { role: 'user', content: 'Open it' },
        { role: 'assistant', content: 'Done' }, { role: 'user', content: 'Thanks' }],
      prefixCount: 1,
      historyPositions: [{ messageId: 'u1', turnId: 't1', role: 'user', index: 1 },
        { messageId: 'a1', turnId: 't1', role: 'assistant', index: 2 }] };
    const assembled = calendarContext({ context, acceptedInput: 'Thanks', groups: [], repair: null,
      tools: SKILL_NATIVE_TOOLS, historicalGroups: new Map([['t1', [group]]]),
      canvasInventory: { items: [{ canvasId: 'old-response::canvas::0', title: 'Old diagram' }], omitted: 0 },
      canvasSelection: { canvasId: 'old-response::canvas::0', revision: 2, open: true, fullscreen: false, mode: 'diagram' },
      responseMode: 'text',
      budgets: DEFAULT_BUDGETS, limits: CALENDAR_LIMITS, compatibility: 'historical',
      binding: { userId: 'u', connectionId: 'c', connectionRevision: 1, googleSubjectId: 'sub' },
      now: Date.now() });
    expect(assembled.messages).toContainEqual(group.assistant);
    expect(assembled.messages).toContainEqual(group.result);
    expect(assembled.messages.find(message => message.role === 'tool')?.content).toBe(result);
    expect(JSON.stringify(assembled.messages)).not.toContain('Canvas state');

    const voiceAssembled = calendarContext({ context, acceptedInput: 'Thanks', groups: [], repair: null,
      tools: SKILL_NATIVE_TOOLS, historicalGroups: new Map([['t1', [group]]]),
      canvasInventory: { items: [{ canvasId: 'old-response::canvas::0', title: 'Old diagram' }], omitted: 0 },
      canvasSelection: { canvasId: 'old-response::canvas::0', revision: 2, open: true, fullscreen: false, mode: 'diagram' },
      responseMode: 'voice',
      budgets: DEFAULT_BUDGETS, limits: CALENDAR_LIMITS, compatibility: 'historical',
      binding: { userId: 'u', connectionId: 'c', connectionRevision: 1, googleSubjectId: 'sub' },
      now: Date.now() });
    const stateMsg = voiceAssembled.messages.find(m => m.role === 'system' && m.content?.startsWith('Canvas state'));
    expect(stateMsg?.content).toContain('"mode":"voice"');
    expect(stateMsg?.content).toContain('"canvas_count":1');
    expect(stateMsg?.content).toContain('"canvas_id":"old-response::canvas::0"');
    expect(stateMsg?.content).toContain('"title":"Old diagram"');
    expect(stateMsg?.content).toContain('"open":true');
    expect(stateMsg?.content).toContain('"fullscreen":false');
    expect(stateMsg?.content).toContain('"zoomable":true');
    expect(stateMsg?.content).not.toContain('current_canvas');
    expect(stateMsg?.content).not.toContain('"revision"');
  });
});

describe('direct native control_canvas contract', () => {
  it('advertises exactly one unified control with eight strict action variants', () => {
    expect(SKILL_NATIVE_TOOLS.map(tool => tool.name)).toEqual([
      'activate_skill', 'call_tool', 'control_canvas', 'get_environment',
    ]);
    const tool = SKILL_NATIVE_TOOLS[2]!;
    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.isFrozen(tool.inputSchema)).toBe(true);
    const valid = [
      { action: 'open', canvas_id: 'a::canvas::0' },
      { action: 'zoom_in' },
      { action: 'zoom_out' },
      { action: 'fit_to_view' },
      { action: 'scroll', direction: 'up' },
      { action: 'scroll', direction: 'down' },
      { action: 'scroll', direction: 'left' },
      { action: 'scroll', direction: 'right' },
      { action: 'close' },
      { action: 'reset_view' },
      { action: 'fullscreen', state: 'enter' },
      { action: 'fullscreen', state: 'exit' },
    ];
    for (const value of valid) expect(controlCanvasArgumentsSchema.safeParse(value).success).toBe(true);
    for (const value of [
      {}, { action: 'toggle' }, { action: 'open' }, { action: 'open', canvas_id: 'bad id' },
      { action: 'open', canvas_id: 'a', state: 'enter' }, { action: 'zoom_in', amount: 50 },
      { action: 'zoom_in', state: 'enter' }, { action: 'fit_to_view', padding: 16 },
      { action: 'scroll' }, { action: 'scroll', direction: 'diagonal' }, { action: 'scroll', state: 'enter' },
      { action: 'fullscreen' }, { action: 'fullscreen', state: true }, { action: 'fullscreen', direction: 'up' },
      { action: 'close', canvas_id: 'other::canvas::0' },
      { action: 'reset_view', conversationId: 'other' },
      { action: 'zoom_out', direction: 'left' },
    ]) expect(controlCanvasArgumentsSchema.safeParse(value).success).toBe(false);
    expect(controlCanvasEnvelopeSchema.safeParse({ huge: 'x'.repeat(16385) }).success).toBe(false);
  });

  it('bounds all six control outcomes and result fields', () => {
    for (const outcome of ['requested', 'mode-not-allowed', 'invalid-arguments',
      'unavailable', 'delivery-unavailable', 'unsupported'] as const) {
      for (const action of ['open', 'zoom_in'] as const) {
        expect(canvasControlResultSchema.safeParse({
          kind: 'canvas-control', outcome, action, canvas_id: 'a::canvas::0',
        }).success).toBe(true);
      }
    }
    expect(canvasControlResultSchema.safeParse({
      kind: 'canvas-control', outcome: 'requested', action: null, canvas_id: null,
    }).success).toBe(true);
    expect(canvasControlResultSchema.safeParse({
      kind: 'canvas-control', outcome: 'applied', action: 'zoom_in', canvas_id: 'a',
    }).success).toBe(false);
    expect(canvasControlResultSchema.safeParse({
      kind: 'canvas-control', outcome: 'requested', action: 'toggle', canvas_id: 'a',
    }).success).toBe(false);
    expect(canvasControlResultSchema.safeParse({
      kind: 'canvas-control', outcome: 'requested', action: 'zoom_in', canvas_id: 'x'.repeat(257),
    }).success).toBe(false);
    expect(canvasControlResultSchema.safeParse({
      kind: 'canvas-control', outcome: 'requested', action: 'zoom_in', canvas_id: 'a', extra: 1,
    }).success).toBe(false);
  });

  it('validates control_canvas candidates, preserves parseable invalid arguments, and tailors repair', () => {
    const candidate = (raw: string): CandidateBatch => ({
      calls: [{ index: 0, id: 'control-1', type: 'function', name: 'control_canvas',
        arguments: raw, envelopeInvalid: false }],
      terminal: 'tool_calls', envelopeInvalid: false,
    });
    const raw = '{ "action": "scroll", "direction": "down" }';
    expect(validateCalendarCandidate(candidate(raw), SKILL_NATIVE_TOOLS, CALENDAR_LIMITS))
      .toEqual({
        kind: 'valid',
        nativeCall: { id: 'control-1', type: 'function', function: { name: 'control_canvas', arguments: raw } },
        envelope: { action: 'scroll', direction: 'down' },
      });
    for (const badArgs of ['{}', '{"action":"zoom_in","amount":2}', '{"action":"scroll","direction":"diagonal"}']) {
      const retained = validateCalendarCandidate(candidate(badArgs), SKILL_NATIVE_TOOLS, CALENDAR_LIMITS);
      expect(retained).toMatchObject({ kind: 'valid', envelope: JSON.parse(badArgs) });
      expect(controlCanvasArgumentsSchema.safeParse(JSON.parse(badArgs)).success).toBe(false);
    }
    for (const malformed of ['{', '{"action":"zoom_in","action":"zoom_out"}', '[]', 'null', '"zoom_in"']) {
      expect(validateCalendarCandidate(candidate(malformed), SKILL_NATIVE_TOOLS, CALENDAR_LIMITS))
        .toMatchObject({ kind: 'rejected' });
    }
    const truncated = { ...candidate('{"action":"zoom_in"}'), terminal: 'length' };
    expect(validateCalendarCandidate(truncated, SKILL_NATIVE_TOOLS, CALENDAR_LIMITS))
      .toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'truncated' }] });
    const parallel = {
      ...candidate('{"action":"zoom_in"}'),
      calls: [
        candidate('{"action":"zoom_in"}').calls[0]!,
        { ...candidate('{"action":"fit_to_view"}').calls[0]!, index: 1, id: 'control-2' },
      ],
    };
    expect(validateCalendarCandidate(parallel, SKILL_NATIVE_TOOLS, CALENDAR_LIMITS))
      .toMatchObject({ kind: 'rejected', diagnostics: [{ code: 'cardinality' }] });
    const repair = repairInstruction([{ path: 'action', code: 'wrong-type', expected: 'string' }]);
    expect(repair).toContain('no presentation action');
    expect(repair).toContain('control_canvas');
    expect(repair).not.toContain('activate_skill');
    expect(repair).not.toContain('show_canvas');
  });

  it('retains control_canvas history cleanly without Calendar provenance or account redaction', () => {
    const raw = '{ "action": "fullscreen", "state": "enter" }';
    const decision = skillDecisionSchema.parse({
      kind: 'control_canvas', decisionId: 'd-ctrl',
      nativeCall: { id: 'control-1', type: 'function', function: { name: 'control_canvas', arguments: raw } },
      assistantContent: null, envelope: { action: 'fullscreen', state: 'enter' }, terminal: 'tool_calls',
    });
    expect(skillDecisionSchema.safeParse({ ...decision, kind: 'show_canvas' }).success).toBe(false);
    const content = JSON.stringify(canvasControlResultSchema.parse({
      kind: 'canvas-control', outcome: 'requested', action: 'fullscreen', canvas_id: 'm1::canvas::0',
    }));
    const group = skillGroup(decision, content);
    expect(group.assistant.tool_calls[0]!.function.arguments).toBe(raw);
    expect(group.result).toMatchObject({ name: 'control_canvas', tool_call_id: 'control-1', content });
    expect(group.sources).toEqual([]);
    expect(nativeLocalResultSchema.parse(JSON.parse(content))).toMatchObject({ kind: 'canvas-control' });
    expect(serializeNativeLocalResult(JSON.parse(content), CALENDAR_LIMITS.resultBytes)).toBe(content);
    expect(() => assertNativeHistory([group.assistant, group.result])).not.toThrow();

    const context: PositionedContext = { contextVersion: 1, instructionVersion: 'i',
      knowledgeContentHash: 'k', graphSchemaVersion: 'g', messages: [
        { role: 'system', content: 'unchanged' }, { role: 'user', content: 'Expand it' },
        { role: 'assistant', content: 'Expanded' }, { role: 'user', content: 'Thanks' }],
      prefixCount: 1,
      historyPositions: [{ messageId: 'u1', turnId: 't1', role: 'user', index: 1 },
        { messageId: 'a1', turnId: 't1', role: 'assistant', index: 2 }] };
    const assembled = calendarContext({ context, acceptedInput: 'Thanks', groups: [], repair: null,
      tools: SKILL_NATIVE_TOOLS, historicalGroups: new Map([['t1', [group]]]),
      budgets: DEFAULT_BUDGETS, limits: CALENDAR_LIMITS, compatibility: 'historical',
      binding: { userId: 'u', connectionId: 'c', connectionRevision: 1, googleSubjectId: 'sub' },
      now: Date.now() });
    expect(assembled.messages).toContainEqual(group.assistant);
    expect(assembled.messages).toContainEqual(group.result);

    const saved = resumableSkillDecisionSchema.parse({
      schemaVersion: 3, kind: 'calendar-model-decision', protocolVersion: SKILL_PROTOCOL_VERSION,
      userId: 'u', sessionId: 's', turnId: 't1', attemptId: 'a1', decisionId: 'd-ctrl',
      dispatchId: 'disp-1', configRevision: 1, connectionId: 'c', connectionRevision: 1,
      schemaRevision: 'google-calendar.v2', rejectedDecisionId: null, decision,
      sources: [], operationId: null, intentId: null, proposalId: null,
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(redactCalendarDecisionForAccount(
      saved,
      { userId: 'u', connectionId: 'c', connectionRevision: 2, googleSubjectId: 'sub' },
      1_700_000_001_000,
    )).toEqual(saved);
  });
});
