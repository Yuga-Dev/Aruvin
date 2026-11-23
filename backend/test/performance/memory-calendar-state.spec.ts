/**
 * ============================================================================
 * FILE: memory-calendar-state.spec.ts
 * LOCATION: backend/test/performance/memory-calendar-state.spec.ts
 * ============================================================================
 * PURPOSE: Verify volatile native accounting, bounded pairs and archive visibility.
 * ROLE IN PROJECT: Deterministic foundation checks independent of runtime routing.
 * KEY COMPONENTS: Real provider adapter, shared memory, partial publication reader.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import { MemoryCalendarLedger } from '../../src/chat-runtime/memory-calendar-ledger.js';
import {
  MemoryCalendarStage, eraseMemoryCalendarState, memoryCalendarGroups,
  memoryCalendarIntegrity, memoryCalendarStateSchema, memoryCalendarRecordSchema,
} from '../../src/chat-runtime/memory-calendar-state.js';
import { loadedSkillRevisions } from '../../src/chat-runtime/calendar-skills.js';
import { CALENDAR_LIMITS } from '../../src/contracts/calendar-policy.js';
import { SKILL_NATIVE_TOOLS } from '../../src/contracts/calendar-tools.js';
import { createCalendarModelPortV2 } from '../../src/model/calendar-adapter.js';
import { fixturePricing, calendarLimits, skillRequest } from '../model/calendar-fixtures.js';
import { config } from '../model/helpers.js';
import { textWire } from '../runtime/calendar-runtime.fixture.js';
import {
  CALENDAR_TOMBSTONE, calendarToolResultRecordV2Schema, localSkillResultRecordSchema, sourceReferenceV2Schema,
} from '../../src/contracts/calendar-sources.js';
import { calendarPage, sourceV2 } from '../contracts/calendar-multi-fixtures.js';
import { resumableSkillDecisionSchema } from '../../src/contracts/calendar-model.js';
import { MemoryFirstFoundation } from '../../src/chat-runtime/memory-first-foundation.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { assets, ports, environment } from '../context/fixtures.js';
import { readMemoryCalendarStates } from '../../src/persistence/memory-calendar-reader.js';
import type { PersistenceBundle } from '../../src/persistence/persistence.js';
import type { SessionRecord } from '../../src/contracts/session.js';
import { activateLocalSkill } from '../../src/chat-runtime/calendar-skills.js';
import { estimateCalendarInput } from '../../src/model/calendar-policy.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { MemoryTextArchive } from '../../src/persistence/memory-text-archive.js';
import type { MongoClient } from 'mongodb';
import { messageRecordSchema } from '../../src/contracts/message.js';
import { emptyCalendarObservation, mergeCalendarObservation } from '../../src/model/calendar-usage.js';
import { ReferencedContextAssembler } from '../../src/context/referenced-context-assembler.js';
import { calendarContext } from '../../src/context/calendar-context.js';
import { key } from '../../src/persistence/records.js';
import { calendarHistory } from '../../src/chat-runtime/calendar-history.js';
import { connectionV2 } from '../persistence/calendar-multi-fixtures.js';

function ledger(overrides: Partial<ConstructorParameters<typeof MemoryCalendarLedger>[0]> = {}) {
  const c = config(), now = Date.now();
  return new MemoryCalendarLedger({ identity: { userId: c.identity.userId, sessionId: 'session-native',
    turnId: 'turn-native', attemptId: 'attempt-native', openRouterUser: c.identity.userId,
    createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 30000).toISOString() },
    clock: () => now, limits: CALENDAR_LIMITS, modelId: 'fixture/model', pricing: fixturePricing,
    configRevision: 1, maxOutputTokens: 256, processingPolicyId: 'fixture-policy',
    job: { check() {}, signal: new AbortController().signal, wait: promise => promise }, ...overrides });
}

async function localState(l = ledger()) {
  const dispatch = await l.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  const stage = new MemoryCalendarStage(32768, 8);
  const envelope = { plugin: 'google-calendar', tools: ['calendar_list_calendars'] };
  const decision = resumableSkillDecisionSchema.parse({ schemaVersion: 3, kind: 'calendar-model-decision',
    protocolVersion: 'plugin-skills.v1', userId: dispatch.userId, sessionId: dispatch.sessionId,
    turnId: dispatch.turnId, attemptId: dispatch.attemptId, decisionId: dispatch.decisionId,
    dispatchId: dispatch.dispatchId, configRevision: 1, connectionId: 'memory-unbound', connectionRevision: 1,
    schemaRevision: 'google-calendar.v2', rejectedDecisionId: null, sources: [], operationId: null,
    intentId: null, proposalId: null, createdAt: dispatch.startedAt,
    decision: { kind: 'activate_skill', decisionId: dispatch.decisionId, assistantContent: null,
      nativeCall: { id: 'native-call', type: 'function', function: { name: 'activate_skill', arguments: JSON.stringify(envelope) } },
      envelope, terminal: 'tool_calls' } });
  stage.putDecision(decision);
  const result = localSkillResultRecordSchema.parse({ schemaVersion: 3, kind: 'calendar-tool-result',
    protocolVersion: 'plugin-skills.v1', userId: dispatch.userId, sessionId: dispatch.sessionId,
    turnId: dispatch.turnId, attemptId: dispatch.attemptId, decisionId: dispatch.decisionId,
    eventId: 'native-result-event', sequence: 0, toolCallId: 'native-call', createdAt: dispatch.startedAt,
    resultRef: { storage: 'local', toolCallId: 'native-call', content: JSON.stringify(activateLocalSkill(
      { plugin: 'google-calendar', tools: ['calendar_list_calendars'] }, new Map(), 16384)) } });
  stage.putResult(result);
  await l.finishDispatch(dispatch.dispatchId, null); await l.aggregate();
  return { state: memoryCalendarStateSchema.parse({ ...l.freeze(), ...stage.records() }), stage, decision, result };
}

async function readState(l = ledger(), volatile = false) {
  const base = await localState(l);
  const fetchedAt = base.state.budget.createdAt;
  const source = sourceReferenceV2Schema.parse({ ...sourceV2, operationIds: [],
    toolCallIds: ['native-call'], fetchedAt,
    expiresAt: volatile ? fetchedAt : new Date(Date.parse(fetchedAt) + 60000).toISOString(),
    permission: { ...sourceV2.permission, content: volatile ? 'volatile' : 'retained' },
    targets: sourceV2.targets.map(t => ({ ...t, calendarLabel: volatile ? null : t.calendarLabel })) });
  const envelope = { plugin: 'google-calendar', tool: 'calendar_list_calendars', arguments: {} };
  const decision = resumableSkillDecisionSchema.parse({ ...base.decision,
    connectionId: source.connectionId, connectionRevision: source.connectionRevision,
    decision: { kind: 'call_tool', decisionId: base.decision.decisionId, assistantContent: null,
      nativeCall: { id: 'native-call', type: 'function', function: {
        name: 'call_tool', arguments: JSON.stringify(envelope) } }, envelope, terminal: 'tool_calls' } });
  const result = calendarToolResultRecordV2Schema.parse({ schemaVersion: 2, kind: 'calendar-tool-result',
    userId: decision.userId, sessionId: decision.sessionId, turnId: decision.turnId,
    attemptId: decision.attemptId, decisionId: decision.decisionId,
    eventId: 'read-result-event', sequence: 0, toolCallId: 'native-call', createdAt: fetchedAt,
    resultRef: volatile ? { storage: 'reference', source, toolCallId: 'native-call', operationId: null, outcome: 'ok' }
      : { storage: 'retained', source, toolCallId: 'native-call', operationId: null,
          result: { ...calendarPage, fetchedAt, expiresAt: source.expiresAt } } });
  const state = memoryCalendarStateSchema.parse({ ...base.state,
    budget: { ...base.state.budget, logicalTools: 1 }, decisions: [decision], results: [result] });
  return { state, source, decision, result };
}

it('keeps retained read evidence usable until its expiry and tombstones it at the exact boundary', async () => {
  const { state, source } = await readState();
  const expiresAt = Date.parse(source.expiresAt);
  const before = memoryCalendarGroups(state, expiresAt - 1);
  expect(before).toHaveLength(1);
  expect(before[0]!.sources).toEqual([source]);
  expect(JSON.parse(before[0]!.result.content)).toMatchObject({ tool: 'calendar_list_calendars' });
  for (const now of [expiresAt, expiresAt + 1]) {
    const after = memoryCalendarGroups(state, now);
    expect(after).toHaveLength(1);
    expect(after[0]!.sources).toEqual([]);
    expect(JSON.parse(after[0]!.result.content)).toEqual({
      kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE,
    });
    expect(JSON.stringify(after)).not.toContain('"calendars"');
  }
});

it('dispatches the actual native adapter with volatile accounting and no persistence port', async () => {
  const l = ledger(), request = skillRequest(), dispatch = await l.reserveDispatch('initial', {
    estimatedInputTokens: estimateCalendarInput(request.messages, SKILL_NATIVE_TOOLS) }, null);
  const binding = await l.bindingFor(dispatch);
  const fetcher = vi.fn<typeof fetch>(async () => new Response(textWire('Native ordinary answer'), {
    headers: { 'content-type': 'text/event-stream' },
  }));
  const adapter = createCalendarModelPortV2(config(), calendarLimits, binding, fetcher);
  const chunks = [];
  for await (const chunk of adapter.stream({ ...request, dispatchId: dispatch.dispatchId,
    decisionId: dispatch.decisionId, deadlineAt: l.deadlineAt(), tools: SKILL_NATIVE_TOOLS })) chunks.push(chunk);
  expect(chunks, JSON.stringify(chunks)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text-delta' })]));
  expect(chunks.find(chunk => chunk.type === 'decision')).toMatchObject({ decision: { kind: 'text', content: 'Native ordinary answer' } });
  const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
  expect(body.tools).toEqual(SKILL_NATIVE_TOOLS.map(tool => ({ type: 'function', function: {
    name: tool.name, description: tool.description, parameters: tool.inputSchema,
  } })));
  expect(body.user).toBe(config().identity.userId);
  await l.finishDispatch(dispatch.dispatchId, null);
  const aggregate = await l.aggregate();
  expect(aggregate.costStatus).not.toBe('known');
  expect(l.freeze()).toMatchObject({ storage: 'volatile', dispatches: [{ status: 'terminal' }] });
  await expect(binding.hooks.beforeDispatch()).rejects.toThrow(/frozen/);
});

it('debits finite memory Calendar work once per logical identity', async () => {
  const l = ledger({ limits: { ...CALENDAR_LIMITS, logicalTools: 2,
    creates: 1, calendarRequests: 1, refreshRequests: 1 } });
  await l.chargeLogicalTool('read-decision');
  await l.chargeLogicalTool('read-decision');
  await l.chargeCalendarRequest('get');
  await l.chargeRefreshRequest();
  await l.chargeCreate('create-intent');
  await l.chargeCreate('create-intent');
  expect(l.snapshot().budget).toMatchObject({ logicalTools: 2, creates: 1,
    calendarRequests: 1, refreshRequests: 1, debits: expect.any(Array) });
  await expect(l.chargeLogicalTool('extra-read')).rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
  await expect(l.chargeCalendarRequest('get')).rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
  await expect(l.chargeRefreshRequest()).rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });
  const d = await l.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  await l.finishDispatch(d.dispatchId, null);
  expect(await l.aggregate()).toMatchObject({ calendarRequests: 1, refreshRequests: 1 });
  l.freeze();
  await expect(l.chargeCalendarRequest('get')).rejects.toThrow(/frozen/);
});

it('serializes concurrent memory request debits and preserves retry debit identities across ceilings and cancellation', async () => {
  const limited = ledger({ limits: { ...CALENDAR_LIMITS, logicalTools: 1, creates: 0, calendarRequests: 1, refreshRequests: 1 } });
  const settled = await Promise.allSettled([limited.chargeCalendarRequest('list'), limited.chargeCalendarRequest('get')]);
  expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(settled.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect(limited.snapshot().budget.calendarRequests).toBe(1);
  await expect(limited.chargeCreate('create-over-zero')).rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });

  const first = ledger({ limits: { ...CALENDAR_LIMITS, logicalTools: 2, creates: 1 } });
  await first.chargeLogicalTool('decision-1');
  await first.chargeCreate('intent-1');
  const retry = ledger({ initialBudget: first.snapshot().budget, limits: { ...CALENDAR_LIMITS, logicalTools: 2, creates: 1 } });
  await retry.chargeLogicalTool('decision-1');
  await retry.chargeCreate('intent-1');
  expect(retry.snapshot().budget).toMatchObject({ logicalTools: 2, creates: 1 });
  await expect(retry.chargeLogicalTool('decision-2')).rejects.toMatchObject({ code: 'STORAGE_BUDGET_EXCEEDED' });

  let now = Date.now();
  let aborted = false;
  const guarded = ledger({
    clock: () => now,
    job: { check() { if (aborted) throw new Error('cancelled'); }, signal: new AbortController().signal, wait: p => p },
  });
  aborted = true;
  await expect(guarded.chargeCalendarRequest('list')).rejects.toThrow(/cancelled/);
  aborted = false;
  now += 60000;
  await expect(guarded.chargeRefreshRequest()).rejects.toMatchObject({ code: 'TIMEOUT' });
});

it('reserves finite paid dispatch budgets, attribution and stable IDs before work', async () => {
  const l = ledger({ limits: { ...CALENDAR_LIMITS, modelDispatches: 1 } });
  const d = await l.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  const binding = await l.bindingFor(d);
  await binding.hooks.beforeDispatch();
  await expect(binding.hooks.beforeDispatch()).rejects.toThrow(/already/);
  await expect(l.reserveDispatch('continuation', { estimatedInputTokens: 100 }, null)).rejects.toThrow(/exhausted/);
  expect(l.snapshot().dispatches).toHaveLength(1);
  expect(l.snapshot().budget.modelDispatches).toBe(1);
  expect(d.openRouterUser).toBe(config().identity.userId);
  const original = ledger();
  const same = await original.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  expect(same.dispatchId).toBe(d.dispatchId);
  const identity = { userId: config().identity.userId, sessionId: 'session-native', turnId: 'turn-native',
    attemptId: 'attempt-retry', openRouterUser: config().identity.userId,
    createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString() };
  const retry = await ledger({ identity }).reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  expect(retry.dispatchId).not.toBe(d.dispatchId);
  expect(retry.decisionId).not.toBe(d.decisionId);
});

it('seeds retry budgets without forgetting earlier attempts money or dispatch indexes', async () => {
  const original = ledger();
  const first = await original.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  await original.observe(first.dispatchId, mergeCalendarObservation(emptyCalendarObservation(), {
    id: 'prior-generation', usage: { prompt_tokens: 100, completion_tokens: 20, cost: '0.001' } }));
  await original.finishDispatch(first.dispatchId, null);
  const seed = original.snapshot().budget;
  const retry = ledger({ initialBudget: seed });
  const second = await retry.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  expect(second.dispatchIndex).toBe(2);
  await retry.observe(second.dispatchId, mergeCalendarObservation(emptyCalendarObservation(), {
    id: 'next-generation', usage: { prompt_tokens: 100, completion_tokens: 20, cost: '0.002' } }));
  expect(retry.snapshot().budget).toMatchObject({ modelDispatches: 2, settledUsd: '0.003', reservedUsd: '0',
    deadlineAt: seed.deadlineAt });
  await retry.finishDispatch(second.dispatchId, null); await retry.aggregate();
  expect(memoryCalendarStateSchema.safeParse({ ...retry.freeze(), decisions: [], rejected: [], results: [] }).success).toBe(true);
  const exhausted = ledger({ initialBudget: { ...seed, modelDispatches: CALENDAR_LIMITS.modelDispatches } });
  await expect(exhausted.reserveDispatch('initial', { estimatedInputTokens: 100 }, null)).rejects.toThrow(/exhausted/);
});

it('rebinds a retained decision ledger to the resumed execution job', async () => {
  const old = vi.fn(), current = vi.fn();
  const l = ledger({ job: { check: old, signal: new AbortController().signal, wait: promise => promise } });
  await l.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  l.rebindJob({ check: current, signal: new AbortController().signal, wait: promise => promise });
  old.mockClear();
  await l.ensureBudget();
  expect(current).toHaveBeenCalledOnce();
  expect(old).not.toHaveBeenCalled();
});

it('preserves absolute usage and known cost through missing observations and refuses contradictory evidence', async () => {
  const l = ledger(), dispatch = await l.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  const known = mergeCalendarObservation(emptyCalendarObservation(), { id: 'generation-native',
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: '0.001', prompt_tokens_details: { cached_tokens: 5 } } });
  await l.observe(dispatch.dispatchId, known);
  const retained = await l.observe(dispatch.dispatchId, emptyCalendarObservation());
  expect(retained).toMatchObject({ generationId: 'generation-native', promptTokens: 100, completionTokens: 20,
    cachedPromptTokens: 5, money: { costStatus: 'known', reportedAmount: '0.001' }, reservationStatus: 'settled' });
  await expect(l.observe(dispatch.dispatchId, { ...known, generationId: 'changed' })).rejects.toThrow(/identity/);
  await expect(l.observe(dispatch.dispatchId, { ...known, cachedPromptTokens: 4 })).rejects.toThrow(/disagreed/);
  await expect(l.observe(dispatch.dispatchId, { ...known, money: { ...known.money, reportedAmount: '0.002' } }))
    .rejects.toThrow(/disagreed/);
  expect(await l.aggregate()).toMatchObject({ reportedUsd: '0.001', costStatus: 'known', heldReservationUsd: '0',
    promptTokens: 100, completionTokens: 20 });
  const frozen = l.freeze();
  await expect(l.observe(dispatch.dispatchId, known)).rejects.toThrow(/frozen/);
  await expect(l.reserveDispatch('continuation', { estimatedInputTokens: 100 }, null)).rejects.toThrow(/frozen/);
  expect(l.snapshot()).toEqual(frozen);
});

it('retains complete native groups, rejects mismatched scope and bounds stage bytes', async () => {
  const { state, stage, decision, result } = await localState();
  expect(memoryCalendarStateSchema.safeParse({ ...state, results: [{ ...result, toolCallId: 'wrong',
    resultRef: { ...result.resultRef, toolCallId: 'wrong' } }] }).success).toBe(false);
  expect(memoryCalendarStateSchema.safeParse({ ...state, dispatches: [...state.dispatches, state.dispatches[0]] }).success).toBe(false);
  stage.putDecision(decision); expect(stage.records().decisions).toHaveLength(1);
  expect(() => stage.putDecision({ ...decision, configRevision: 2 })).toThrow(/identity/);
  expect(() => new MemoryCalendarStage(1, 8).putDecision(decision)).toThrow(/budget/);
  stage.records().decisions[0]!.configRevision = 99;
  expect(stage.getDecision(decision.decisionId)?.configRevision).toBe(1);
});

it('stages complete retained Calendar pairs and volatile references without payload copies', async () => {
  const retained = await readState(), volatile = await readState(ledger(), true);
  const stage = new MemoryCalendarStage(32768, 8);
  stage.putDecision(retained.decision); stage.putResult(retained.result);
  expect(stage.records().results).toEqual([retained.result]);
  expect(JSON.stringify(volatile.state.results)).not.toContain('"calendars"');
  expect(volatile.result.resultRef.storage).toBe('reference');
  expect(memoryCalendarStateSchema.safeParse({ ...retained.state,
    results: [{ ...retained.result, attemptId: 'other-attempt' }] }).success).toBe(false);
});

it('validates read joins, source bounds, one-byte overflow, and terminalCall markers', async () => {
  const l = ledger();
  const base = await readState(l);
  const textDispatch = await ledger({
    initialBudget: base.state.budget,
    identity: { userId: base.decision.userId, sessionId: base.decision.sessionId,
      turnId: base.decision.turnId, attemptId: base.decision.attemptId,
      openRouterUser: base.decision.userId, createdAt: base.decision.createdAt,
      deadlineAt: base.state.budget.deadlineAt },
  });
  const d1 = await textDispatch.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  await textDispatch.finishDispatch(d1.dispatchId, null);
  const d2 = await textDispatch.reserveDispatch('continuation', { estimatedInputTokens: 100 }, null);
  await textDispatch.finishDispatch(d2.dispatchId, null);
  await textDispatch.aggregate();
  const frozen = textDispatch.freeze();

  const textDecision = resumableSkillDecisionSchema.parse({
    ...base.decision, dispatchId: d2.dispatchId, decisionId: d2.decisionId,
    sources: [base.source],
    decision: { kind: 'text', decisionId: d2.decisionId, content: 'You have one calendar.', truncated: false },
  });
  const callDecision = resumableSkillDecisionSchema.parse({
    ...base.decision, dispatchId: d1.dispatchId, decisionId: d1.decisionId,
    decision: { ...base.decision.decision!, decisionId: d1.decisionId },
  });
  const pairedResult = calendarToolResultRecordV2Schema.parse({ ...base.result, decisionId: d1.decisionId });
  const withText = memoryCalendarStateSchema.parse({
    ...frozen, budget: { ...frozen.budget, logicalTools: 1 }, rejected: [],
    decisions: [callDecision, textDecision], results: [pairedResult],
  });
  expect(memoryCalendarGroups(withText, Date.parse(base.source.fetchedAt))).toHaveLength(1);

  // Wrong target / tool / source / account / duplicate sequence, call, event / missing result / ninth entry
  expect(memoryCalendarStateSchema.safeParse({
    ...base.state,
    results: [{ ...base.result, resultRef: { ...base.result.resultRef,
      result: { ...base.result.resultRef.result, tool: 'calendar_list_events' } } }],
  }).success).toBe(false);
  expect(memoryCalendarStateSchema.safeParse({
    ...base.state,
    results: [{ ...base.result, resultRef: { ...base.result.resultRef,
      source: { ...base.source, connectionRevision: base.source.connectionRevision + 1 } } }],
  }).success).toBe(false);
  expect(memoryCalendarStateSchema.safeParse({
    ...base.state,
    results: [{ ...base.result, resultRef: { ...base.result.resultRef,
      source: { ...base.source, toolCallIds: ['other-call'] } } }],
  }).success).toBe(false);
  expect(memoryCalendarStateSchema.safeParse({
    ...base.state,
    results: [{ ...base.result, resultRef: { ...base.result.resultRef,
      source: { ...base.source, targets: [] } } }],
  }).success).toBe(false);
  expect(memoryCalendarStateSchema.safeParse({
    ...withText,
    results: [pairedResult, { ...pairedResult, toolCallId: 'call-2', eventId: 'event-2' }],
  }).success).toBe(false);
  expect(memoryCalendarStateSchema.safeParse({
    ...withText,
    results: [pairedResult, { ...pairedResult, sequence: 1 }],
  }).success).toBe(false);
  expect(memoryCalendarStateSchema.safeParse({
    ...withText,
    results: [pairedResult, { ...pairedResult, toolCallId: 'call-2', sequence: 1 }],
  }).success).toBe(false);
  expect(memoryCalendarRecordSchema.safeParse({
    schemaVersion: 1, kind: 'memory-calendar-native', userId: base.decision.userId,
    sessionId: base.decision.sessionId, turnId: base.decision.turnId, attemptId: base.decision.attemptId,
    epoch: 'ep', version: 1, fence: 0,
    state: { ...base.state, results: [] },
  }).success).toBe(false);

  // Retained permission denied / volatile raw result rejected
  expect(calendarToolResultRecordV2Schema.safeParse({
    ...base.result,
    resultRef: { ...base.result.resultRef, source: { ...base.source, permission: { ...base.source.permission, minimalEvidenceAllowed: false } } },
  }).success).toBe(false);
  expect(calendarToolResultRecordV2Schema.safeParse({
    ...base.result,
    resultRef: { ...base.result.resultRef, source: { ...base.source, permission: { ...base.source.permission, content: 'volatile' } } },
  }).success).toBe(false);

  // Ninth entry and one-byte stage overflow
  const fullStage = new MemoryCalendarStage(512000, 8);
  for (let i = 0; i < 8; i++) {
    fullStage.putDecision({ ...base.decision, decisionId: `dec-${i}`,
      decision: { ...base.decision.decision!, decisionId: `dec-${i}` } });
  }
  expect(() => fullStage.putDecision({ ...base.decision, decisionId: 'dec-8',
    decision: { ...base.decision.decision!, decisionId: 'dec-8' } })).toThrow(/budget/);
  const exactBytes = Buffer.byteLength(JSON.stringify(new MemoryCalendarStage(512000, 8).records()), 'utf8')
    + Buffer.byteLength(JSON.stringify(base.decision), 'utf8');
  expect(() => new MemoryCalendarStage(exactBytes - 1, 8).putDecision(base.decision)).toThrow(/budget/);
  new MemoryCalendarStage(exactBytes, 8).putDecision(base.decision);

  // terminalCall for denied / clarification / failed / cancelled, and forged marker rejection
  for (const outcome of ['denied', 'clarification', 'failed', 'cancelled'] as const) {
    const stage = new MemoryCalendarStage(32768, 8);
    stage.putDecision(base.decision);
    stage.putTerminalCall({ decisionId: base.decision.decisionId, toolCallId: 'native-call', outcome });
    stage.putTerminalCall({ decisionId: base.decision.decisionId, toolCallId: 'native-call', outcome });
    const termState = memoryCalendarStateSchema.parse({ ...base.state, ...stage.records() });
    const termRecord = memoryCalendarRecordSchema.parse({
      schemaVersion: 2, kind: 'memory-calendar-native', userId: base.decision.userId,
      sessionId: base.decision.sessionId, turnId: base.decision.turnId, attemptId: base.decision.attemptId,
      epoch: 'ep', version: 1, fence: 0, integrity: memoryCalendarIntegrity(termState),
      redactedAt: null, state: termState,
    });
    expect(termRecord.state.terminalCall?.outcome).toBe(outcome);
    expect(memoryCalendarGroups(termState, Date.parse(base.source.fetchedAt))).toEqual([]);
  }
  // Forged marker on a decision that already has a result or is not the last dispatch
  expect(memoryCalendarStateSchema.safeParse({
    ...base.state,
    terminalCall: { decisionId: base.decision.decisionId, toolCallId: 'native-call', outcome: 'denied' },
  }).success).toBe(false);
  expect(memoryCalendarStateSchema.safeParse({
    ...withText,
    results: [],
    terminalCall: { decisionId: d1.decisionId, toolCallId: 'native-call', outcome: 'denied' },
  }).success).toBe(false);
});

it('erases Calendar evidence idempotently and renders volatile or erased history safely unavailable', async () => {
  const retained = await readState();
  const volatile = await readState(ledger(), true);
  const now = Date.parse(retained.source.fetchedAt) + 120000;

  const volatileGroups = memoryCalendarGroups(volatile.state, Date.parse(volatile.source.fetchedAt));
  expect(volatileGroups).toHaveLength(1);
  expect(volatileGroups[0]!.sources).toEqual([]);
  expect(JSON.parse(volatileGroups[0]!.result.content)).toEqual({
    kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE,
  });
  expect(loadedSkillRevisions([volatileGroups[0]!.assistant, volatileGroups[0]!.result]).size).toBe(0);

  const l = ledger();
  const d1 = await l.reserveDispatch('initial', { estimatedInputTokens: 100 }, null);
  await l.finishDispatch(d1.dispatchId, null);
  const d2 = await l.reserveDispatch('continuation', { estimatedInputTokens: 100 }, null);
  await l.finishDispatch(d2.dispatchId, null);
  await l.aggregate();
  const frozen = l.freeze();
  const callDecision = resumableSkillDecisionSchema.parse({
    ...retained.decision, dispatchId: d1.dispatchId, decisionId: d1.decisionId,
    decision: { ...retained.decision.decision, decisionId: d1.decisionId, assistantContent: 'Checking team calendar' } as typeof retained.decision.decision,
  });
  const textDecision = resumableSkillDecisionSchema.parse({
    ...retained.decision, dispatchId: d2.dispatchId, decisionId: d2.decisionId,
    sources: [retained.source],
    decision: { kind: 'text', decisionId: d2.decisionId, content: 'Private team calendar answer', truncated: false },
  });
  const fullState = memoryCalendarStateSchema.parse({
    ...frozen, budget: { ...frozen.budget, logicalTools: 1 }, rejected: [],
    decisions: [callDecision, textDecision],
    results: [{ ...retained.result, decisionId: d1.decisionId }],
  });

  const erasedOnce = eraseMemoryCalendarState(fullState, now, 'expired');
  const erasedTwice = eraseMemoryCalendarState(erasedOnce, now + 5000, 'disconnected');
  expect(erasedTwice).toEqual(erasedOnce);
  expect(JSON.stringify(erasedOnce)).not.toContain('Team');
  expect(JSON.stringify(erasedOnce)).not.toContain('Private team calendar answer');
  expect(erasedOnce.decisions[1]!.decision).toBeNull();
  expect(erasedOnce.decisions[1]!.sources[0]!.redactedAt).toBe(new Date(now).toISOString());
  expect(erasedOnce.results[0]!.schemaVersion).toBe(2);
  if (erasedOnce.results[0]!.schemaVersion === 2) {
    expect(erasedOnce.results[0]!.resultRef.storage).toBe('tombstone');
  }
  const erasedGroups = memoryCalendarGroups(erasedOnce, now);
  expect(erasedGroups).toHaveLength(1);
  expect(erasedGroups[0]!.sources).toEqual([]);
  expect(JSON.parse(erasedGroups[0]!.result.content)).toEqual({
    kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE,
  });
  expect(loadedSkillRevisions([erasedGroups[0]!.assistant, erasedGroups[0]!.result]).size).toBe(0);
});

it('preflights the exact local result read-only before any presentation effect', async () => {
  const { stage, decision, result } = await localState();
  const code = (action: () => void) => {
    try { action(); return null; } catch (error) { return (error as { code?: string }).code ?? null; }
  };
  const navigation = localSkillResultRecordSchema.parse({ ...result, toolCallId: 'navigation-call',
    resultRef: { storage: 'local', toolCallId: 'navigation-call', content: JSON.stringify({
      kind: 'canvas-navigation', outcome: 'requested', canvas_id: 'old-response::canvas::0' }) } });
  const before = stage.records().results;
  stage.assertResultCapacity(navigation);
  expect(stage.records().results).toEqual(before);
  stage.putResult(navigation);
  stage.assertResultCapacity(navigation);
  expect(stage.records().results).toHaveLength(2);
  expect(code(() => stage.assertResultCapacity({ ...navigation, resultRef: { ...navigation.resultRef,
    content: JSON.stringify({ kind: 'canvas-navigation', outcome: 'unavailable', canvas_id: null }) } })))
    .toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  expect(stage.records().results[1]!.resultRef.content).toBe(navigation.resultRef.content);
  const full = new MemoryCalendarStage(1, 8);
  expect(code(() => full.assertResultCapacity(navigation))).toBe('STORAGE_BUDGET_EXCEEDED');
  expect(full.records().results).toEqual([]);
  // A refused preflight never removes capacity from the live stage.
  stage.putResult({ ...navigation, toolCallId: 'follow-up-call',
    resultRef: { ...navigation.resultRef, toolCallId: 'follow-up-call' } });
  expect(stage.records().results.map(record => record.toolCallId)).toEqual(['native-call', 'navigation-call',
    'follow-up-call']);
  expect(decision.decisionId).toBe(result.decisionId);
});

it('uses complete original local native pairs exactly once in shared memory and reserves their bytes', async () => {
  const memory = new MemoryFirstFoundation({ userId: config().identity.userId, epoch: 'native-epoch',
    policy: PROPOSED_MEMORY_TEXT_POLICY, save: async () => ({ kind: 'unknown', retryable: false }) });
  const accepted = memory.accept({ sessionId: 'session-native', requestKey: 'native-request', mode: 'text',
    content: 'First', voice: null, calendarReplyTo: null, config: { revision: '1', modelId: 'fixture/model',
      instructionVersion: assets.instructionVersion, knowledgeContentHash: assets.knowledgeContentHash,
      graphSchemaVersion: assets.graphSchemaVersion } });
  const l = ledger({ identity: { userId: accepted.userId, sessionId: accepted.sessionId,
    turnId: accepted.turnId, attemptId: accepted.attemptId, openRouterUser: accepted.userId,
    createdAt: accepted.createdAt, deadlineAt: new Date(Date.parse(accepted.createdAt) + 30000).toISOString() } });
  const { state } = await localState(l);
  memory.complete(accepted, { content: 'Answer', status: 'completed', calendar: state });
  expect(memory.nativeGroups(accepted.sessionId).get(accepted.turnId)).toHaveLength(1);
  const pairs = memory.nativeGroups(accepted.sessionId).get(accepted.turnId)!;
  expect(pairs[0]!.assistant.tool_calls[0].id).toBe(pairs[0]!.result.tool_call_id);
  expect(memory.result(accepted)?.calendar).toEqual(state);
  expect(memory.session(accepted.sessionId).durableVersion).toBe(0);
  const second = memory.accept({ requestKey: 'native-followup', content: 'Second',
    sessionId: accepted.sessionId, config: accepted.config, mode: 'text', voice: null, calendarReplyTo: null });
  const request = { userId: second.userId, sessionId: second.sessionId, turnId: second.turnId,
    newUserInput: second.content, responseMode: 'text' as const, environment };
  const assembled = await new ReferencedContextAssembler(ports([])).assemble(request, memory.context(second));
  expect(assembled.ok).toBe(true);
  if (!assembled.ok) throw new Error('Fixture context overflow');
  const context = calendarContext({ context: assembled.context, acceptedInput: second.content,
    groups: [], historicalGroups: memory.nativeGroups(second.sessionId), repair: null,
    tools: SKILL_NATIVE_TOOLS, budgets: DEFAULT_BUDGETS, limits: CALENDAR_LIMITS,
    binding: { userId: second.userId, connectionId: 'memory-unbound', connectionRevision: 1, googleSubjectId: 'memory-unbound' },
    compatibility: 'historical', now: Date.now() });
  expect(context.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['First', 'Second']);
  expect(context.messages.filter(message => 'tool_calls' in message)).toHaveLength(1);
  expect(context.messages.filter(message => message.role === 'tool')).toHaveLength(1);
  expect(context.loadedSkills.has('google-calendar:calendar_list_calendars')).toBe(true);
  memory.complete(second, { content: 'Next answer', status: 'completed' });
  memory.stopAdmission(); await memory.drain(20);
});

it('hides partial native publications and refuses fenced or mismatched cold evidence', async () => {
  const { state } = await localState();
  const native = memoryCalendarRecordSchema.parse({ schemaVersion: 1, kind: 'memory-calendar-native',
    userId: state.budget.userId, sessionId: state.budget.sessionId, turnId: state.budget.turnId,
    attemptId: 'attempt-native', epoch: 'native-epoch', version: 1, fence: 0, state });
  const session: SessionRecord = { schemaVersion: 1, userId: native.userId, sessionId: native.sessionId,
    title: 'Native', createdAt: state.budget.createdAt, updatedAt: state.budget.createdAt,
    lastActivityAt: state.budget.createdAt, graphThreadId: 'native-thread', latestTurnId: native.turnId,
    lifecycle: 'active', execution: { ownerId: null, activeAttemptId: null, leaseExpiresAt: null, generation: 0 },
    memoryPublication: { version: 0, sequence: 2, epoch: 'native-epoch', fence: 0 } };
  const read = vi.fn(async () => native);
  const p = { owner: { store: { read } } } as unknown as PersistenceBundle;
  const messages = [messageRecordSchema.parse({ schemaVersion: 1, userId: native.userId, sessionId: native.sessionId,
    turnId: native.turnId, attemptId: native.attemptId, sequence: 1, messageId: 'native-message', eventId: 'native-event',
    role: 'assistant', content: 'Answer', createdAt: state.budget.createdAt, completionStatus: 'completed', truncated: false })];
  expect(await readMemoryCalendarStates(p, session, messages, 128)).toEqual([]);
  session.memoryPublication!.version = 1;
  expect(await readMemoryCalendarStates(p, session, messages, 128)).toEqual([state]);
  session.memoryPublication!.fence = 1;
  await expect(readMemoryCalendarStates(p, session, messages, 128)).rejects.toThrow(/reconciliation/);
  session.lifecycle = 'archived'; read.mockClear();
  expect(await readMemoryCalendarStates(p, session, messages, 128)).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

it('publishes one consolidated native record before visibility and cold-hydrates the exact original pairs', async () => {
  const db = calendarMemory();
  const client = Object.assign(db.commandSource, { db: () => db.store.db, appendMetadata: () => undefined }) as unknown as MongoClient;
  const p = await createPersistenceBundle(client, 'offline-native-memory', DEFAULT_BUDGETS, 'offline-native-executor');
  const adapter = new MemoryTextArchive(p, assets);
  const memory = new MemoryFirstFoundation({ userId: config().identity.userId, epoch: 'native-epoch',
    policy: { ...PROPOSED_MEMORY_TEXT_POLICY, maxAttempts: 1 }, save: adapter.save });
  const accepted = memory.accept({ sessionId: 'session-native', requestKey: 'native-request', mode: 'text',
    content: 'First', voice: null, calendarReplyTo: null, config: { revision: '1', modelId: 'fixture/model',
      instructionVersion: assets.instructionVersion, knowledgeContentHash: assets.knowledgeContentHash,
      graphSchemaVersion: assets.graphSchemaVersion } });
  const l = ledger({ identity: { userId: accepted.userId, sessionId: accepted.sessionId,
    turnId: accepted.turnId, attemptId: accepted.attemptId, openRouterUser: accepted.userId,
    createdAt: accepted.createdAt, deadlineAt: new Date(Date.parse(accepted.createdAt) + 30000).toISOString() } });
  const { state } = await localState(l);
  vi.spyOn(p.memory, 'put').mockRejectedValueOnce(new Error('Partial native publication'));
  const envelope = memory.complete(accepted, { content: 'Answer', status: 'completed', calendar: state });
  await vi.waitFor(() => expect(memory.saveState(accepted)).toBe('unknown'));
  expect(memory.session(accepted.sessionId).durableVersion).toBe(0);
  expect([...db.rows('metadata')!.values()].filter(record => record.kind === 'memory-calendar-native')).toHaveLength(1);
  const partial = (await p.sessions.get(accepted.userId, accepted.sessionId))!;
  expect(await readMemoryCalendarStates(p, partial, [envelope.input, envelope.output], 128)).toEqual([]);
  expect((await adapter.save(envelope, { maxOperations: 32, maxBytes: 524288 })).kind).toBe('saved');
  expect([...db.rows('metadata')!.values()].filter(record => record.kind === 'memory-calendar-native')).toHaveLength(1);
  const session = (await p.sessions.get(accepted.userId, accepted.sessionId))!;
  const manifest = (await p.memory.get(accepted.userId, accepted.sessionId))!;
  const records = await p.messages.getReferences(accepted.userId, accepted.sessionId, manifest.messageRefs);
  const attempts = (await p.metadata.listAttempts(accepted.userId, accepted.sessionId, { cursor: null, limit: 50 })).items;
  expect(attempts[0]).toMatchObject({ nativePublication: { epoch: accepted.epoch, version: 1, fence: 0 } });
  const native = await readMemoryCalendarStates(p, session, records, 128, attempts);
  const groups = await calendarHistory(p, accepted.userId, accepted.sessionId, records);
  expect(groups.get(accepted.turnId)?.[0]?.assistant.tool_calls[0].id).toBe('native-call');
  const nativeRead = p.owner.store!.read.bind(p.owner.store!);
  const read = vi.spyOn(p.owner.store!, 'read').mockImplementation(async (collection, schema, query) =>
    query._id === key('memory-calendar-native', accepted.userId, accepted.sessionId, accepted.attemptId)
      ? null : nativeRead(collection, schema, query));
  await expect(readMemoryCalendarStates(p, session, records, 128, attempts)).rejects.toMatchObject({ code: 'NOT_READY' });
  read.mockRestore();
  const changed = vi.spyOn(p.owner.store!, 'read').mockImplementation(async (collection, schema, query) => {
    const record = await nativeRead(collection, schema, query);
    if (record?.kind === 'memory-calendar-native') {
      const copy = structuredClone(record) as ReturnType<typeof memoryCalendarRecordSchema.parse>;
      copy.state.dispatches[0]!.providerRequestId = 'changed-published-evidence';
      return copy as typeof record;
    }
    return record;
  });
  await expect(readMemoryCalendarStates(p, session, records, 128, attempts)).rejects.toMatchObject({ code: 'NOT_READY' });
  changed.mockRestore();
  const cold = new MemoryFirstFoundation({ userId: accepted.userId, epoch: 'cold-epoch',
    policy: PROPOSED_MEMORY_TEXT_POLICY, save: adapter.save });
  cold.hydrate({ manifest, records }, [], accepted.sequence + 3, records, native);
  expect(cold.nativeGroups(accepted.sessionId)).toEqual(memory.nativeGroups(accepted.sessionId));
  // An adapter acknowledgement is not a receipt owned by the original foundation.
  expect(memory.session(accepted.sessionId).durableVersion).toBe(0);
  await p.sessions.delete(accepted.userId, accepted.sessionId);
  expect((await adapter.save(envelope, { maxOperations: 32, maxBytes: 524288 })).kind).toBe('failed');
  memory.stopAdmission(); cold.stopAdmission(); await memory.drain(20); await cold.drain(20);
});

it('archives Calendar evidence as one bounded native dependency with verified erasure', async () => {
  const db = calendarMemory();
  const client = Object.assign(db.commandSource, { db: () => db.store.db, appendMetadata: () => undefined }) as unknown as MongoClient;
  const p = await createPersistenceBundle(client, 'offline-native-calendar', DEFAULT_BUDGETS, 'offline-native-executor');
  const adapter = new MemoryTextArchive(p, assets);
  const memory = new MemoryFirstFoundation({ userId: config().identity.userId, epoch: 'native-epoch',
    policy: PROPOSED_MEMORY_TEXT_POLICY, save: adapter.save });
  const accepted = memory.accept({ sessionId: 'session-calendar', requestKey: 'calendar-request', mode: 'text',
    content: 'List calendars', voice: null, calendarReplyTo: null, config: { revision: '1', modelId: 'fixture/model',
      instructionVersion: assets.instructionVersion, knowledgeContentHash: assets.knowledgeContentHash,
      graphSchemaVersion: assets.graphSchemaVersion } });
  const l = ledger({ identity: { userId: accepted.userId, sessionId: accepted.sessionId,
    turnId: accepted.turnId, attemptId: accepted.attemptId, openRouterUser: accepted.userId,
    createdAt: accepted.createdAt, deadlineAt: new Date(Date.parse(accepted.createdAt) + 30000).toISOString() } });
  const { state, source } = await readState(l);
  const conn = connectionV2();
  await p.calendarConnectionsV2.create({ ...conn, userId: accepted.userId,
    connectionId: source.connectionId, revision: source.connectionRevision, googleSubjectId: 'sub' });
  const beforeCmds = db.wireCalls.length;
  memory.complete(accepted, { content: 'Answer', status: 'completed', calendar: state });
  await vi.waitFor(() => expect(memory.session(accepted.sessionId).durableVersion).toBe(1));
  const archiveCmds = db.wireCalls.slice(beforeCmds);
  console.info('Calendar native archive command profile', {
    commands: archiveCmds.length,
    writes: archiveCmds.filter(c => c.kind === 'write').length,
  });
  expect(archiveCmds.filter(c => c.kind === 'write').length).toBeLessThan(20);

  const rows = [...db.rows('metadata')!.values()];
  expect(rows.filter(r => r.kind === 'memory-calendar-native')).toHaveLength(1);
  expect(rows.filter(r => ['calendar-source', 'calendar-tool-result', 'calendar-model-decision',
    'calendar-model-dispatch', 'calendar-model-aggregate'].includes(String(r.kind)))).toEqual([]);
  const session = (await p.sessions.get(accepted.userId, accepted.sessionId))!;
  const manifest = (await p.memory.get(accepted.userId, accepted.sessionId))!;
  const records = await p.messages.getReferences(accepted.userId, accepted.sessionId, manifest.messageRefs);
  const attempts = (await p.metadata.listAttempts(accepted.userId, accepted.sessionId, { cursor: null, limit: 50 })).items;
  expect(attempts[0]!.nativePublication).toMatchObject({ epoch: accepted.epoch, version: 1, fence: 0 });
  expect(await readMemoryCalendarStates(p, session, records, 128, attempts)).toEqual([state]);

  // Verify canonical erasure passes integrity checks and renders cold history safely unavailable.
  const nativeId = key('memory-calendar-native', accepted.userId, accepted.sessionId, accepted.attemptId);
  const nativeRead = p.owner.store!.read.bind(p.owner.store!);
  const stored = (await nativeRead('metadata', memoryCalendarRecordSchema, { _id: nativeId, userId: accepted.userId, sessionId: accepted.sessionId }))!;
  const erasedAt = new Date(Date.parse(source.fetchedAt) + 120000).toISOString();
  const erasedState = eraseMemoryCalendarState(state, Date.parse(erasedAt), 'expired');
  const erasedRecord = memoryCalendarRecordSchema.parse({ ...stored, redactedAt: erasedAt, state: erasedState });
  const readSpy = vi.spyOn(p.owner.store!, 'read').mockImplementation(async (collection, schema, query) =>
    query._id === nativeId ? erasedRecord as never : nativeRead(collection, schema, query));
  const readStates = await readMemoryCalendarStates(p, session, records, 128, attempts);
  expect(readStates).toEqual([erasedState]);
  const groups = memoryCalendarGroups(readStates[0]!, Date.parse(erasedAt));
  expect(JSON.parse(groups[0]!.result.content)).toEqual({
    kind: 'calendar-history-unavailable', message: CALENDAR_TOMBSTONE,
  });
  readSpy.mockRestore();

  // Independent tampering checks: each must reject NOT_READY.
  const tamper = async (mutate: (copy: ReturnType<typeof memoryCalendarRecordSchema.parse>) => void) => {
    const spy = vi.spyOn(p.owner.store!, 'read').mockImplementation(async (collection, schema, query) => {
      const rec = await nativeRead(collection, schema, query);
      if (rec?.kind === 'memory-calendar-native') {
        const copy = structuredClone(rec) as ReturnType<typeof memoryCalendarRecordSchema.parse>;
        mutate(copy);
        return copy as never;
      }
      return rec;
    });
    try {
      await expect(readMemoryCalendarStates(p, session, records, 128, attempts)).rejects.toMatchObject({ code: 'NOT_READY' });
    } finally {
      spy.mockRestore();
    }
  };
  await tamper(copy => { copy.state.dispatches[0]!.providerRequestId = 'tampered-provider-req'; });
  await tamper(copy => { copy.state.decisions[0]!.decisionId = 'tampered-decision'; });
  await tamper(copy => { copy.state.results[0]!.toolCallId = 'tampered-call'; });
  await tamper(copy => { copy.state.results[0]!.sequence = 7; });
  await tamper(copy => { copy.userId = 'other-user'; });
  await tamper(copy => {
    const r = copy.state.results[0]!;
    if (r.schemaVersion === 2 && r.resultRef.storage === 'retained') {
      r.resultRef.result.calendars[0]!.label = 'Tampered Label';
    }
  });
  await tamper(copy => {
    if (copy.schemaVersion === 2) copy.integrity.stateHash = '0'.repeat(64);
  });
  await tamper(copy => {
    if (copy.schemaVersion === 2) copy.redactedAt = erasedAt;
  });

  // Also test local disclosure tampering on a local-only v2 or v1 record via localState.
  const localAttemptId = 'local-tamper-attempt';
  const localTurn = memory.accept({ sessionId: accepted.sessionId, requestKey: 'local-tamper-request', mode: 'text',
    content: 'Local second', voice: null, calendarReplyTo: null, config: accepted.config });
  const localLedger = ledger({ identity: { userId: localTurn.userId, sessionId: localTurn.sessionId,
    turnId: localTurn.turnId, attemptId: localTurn.attemptId, openRouterUser: localTurn.userId,
    createdAt: localTurn.createdAt, deadlineAt: new Date(Date.parse(localTurn.createdAt) + 30000).toISOString() } });
  const localOnly = await localState(localLedger);
  memory.complete(localTurn, { content: 'Local answer', status: 'completed', calendar: localOnly.state });
  await vi.waitFor(() => expect(memory.session(accepted.sessionId).durableVersion).toBe(2));
  const s2 = (await p.sessions.get(accepted.userId, accepted.sessionId))!;
  const m2 = (await p.memory.get(accepted.userId, accepted.sessionId))!;
  const r2 = await p.messages.getReferences(accepted.userId, accepted.sessionId, m2.messageRefs);
  const a2 = (await p.metadata.listAttempts(accepted.userId, accepted.sessionId, { cursor: null, limit: 50 })).items;
  const localNativeId = key('memory-calendar-native', accepted.userId, accepted.sessionId, localTurn.attemptId);
  const localSpy = vi.spyOn(p.owner.store!, 'read').mockImplementation(async (collection, schema, query) => {
    const rec = await nativeRead(collection, schema, query);
    if (query._id === localNativeId && rec?.kind === 'memory-calendar-native') {
      const copy = structuredClone(rec) as ReturnType<typeof memoryCalendarRecordSchema.parse>;
      const res = copy.state.results[0]!;
      if (res.schemaVersion === 3) res.resultRef.content = '{"tampered":true}';
      return copy as never;
    }
    return rec;
  });
  await expect(readMemoryCalendarStates(p, s2, r2, 128, a2)).rejects.toMatchObject({ code: 'NOT_READY' });
  localSpy.mockRestore();
  void localAttemptId;

  memory.stopAdmission(); await memory.drain(20);
});
