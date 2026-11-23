/**
 * ============================================================================
 * FILE: calendar-loop.spec.ts
 * LOCATION: backend/test/runtime/calendar-loop.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Calendar loop repairs, confirmations, spoken labels, and proposal expiry.
 *
 * ROLE IN PROJECT:
 *    Pins decide-execute-seal behavior for conversational Calendar turns:
 *    repair reuse, confirmation narration, identity wording, and hard retention
 *    ceilings for draft proposal content.
 *
 * KEY COMPONENTS:
 *    - Repair/execute: Rejected decisions reuse the last valid boundary once.
 *    - friendlyCalendarLabel / formatEventPhrase: Spoken confirmation copy.
 *    - Proposal expiry: 10-minute drafts clamped to retention, never extended.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import type { NativeCalendarModelMessage } from '../../src/contracts/calendar-model.js';
import {
  friendlyCalendarLabel,
  formatEventPhrase,
  formatBusyInterval,
} from '../../src/chat-runtime/calendar-loop.js';
import { publishProposal } from '../../src/chat-runtime/calendar-authority.js';
import { createWire, loadWire, nativeWire, skillWire, textWire } from './calendar-runtime.fixture.js';
import { calendarFixture } from './calendar-runtime.fixture.js';
import { busy, disclose, event } from './calendar-multi-fixture.js';

it('repairs a rejected decision from the last valid boundary and executes the repair once', async () => {
  const h = calendarFixture();
  try {
    const ids = await h.submit('Read event abcde');
    h.modelWires.push(loadWire('calendar_get_event'),
      nativeWire('{"eventId":'), nativeWire('{"eventId":"abcde"}'), textWire('Found it.'));
    await h.execute(ids);
    const budget = await h.p.calendarAccounting.getBudget(h.identity.userId, ids.sessionId, ids.turnId);
    expect(budget).toMatchObject({ modelDispatches: 4, repairs: 1, logicalTools: 1, creates: 0 });
    expect(h.effects.filter(e => e.kind === 'get')).toHaveLength(1);
    const repaired = h.modelBodies[2].messages as NativeCalendarModelMessage[];
    expect(repaired.filter(m => m.role === 'user' && m.content === 'Read event abcde')).toHaveLength(1);
    // Only the successful disclosure pair is present; the malformed call left no group.
    expect(repaired.filter(m => 'tool_calls' in m).flatMap(m => m.tool_calls)
      .map(call => call.function.name)).toEqual(['activate_skill']);
    expect(repaired.filter(m => m.role === 'tool')).toHaveLength(1);
    expect(repaired.at(-1)?.content).toContain('This rejected decision performed no Canvas navigation and no calendar write.');
  } finally { await h.dispose(); }
});

it('uses the stored event on yes and creates without a second model turn', async () => {
  const h = calendarFixture();
  try {
    h.setAvailability({ busy: [busy('2026-11-03T10:15:00Z', '2026-11-03T10:30:00Z')] });
    const first = await disclose(
      h,
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
      event(),
    );
    const priorDispatches = h.modelBodies.length;
    const reply = await h.reply(first.proposal, 'Go ahead', first.ids.sessionId);
    await h.execute(reply);
    expect(h.modelBodies).toHaveLength(priorDispatches);
    expect(h.effects.filter(e => e.kind === 'create')).toHaveLength(1);
    const messages = await h.p.messages.list(h.identity.userId, reply.sessionId, { cursor: null, limit: 50 });
    expect(messages.items.find(m => m.role === 'assistant' && m.turnId === reply.turnId)?.content)
      .toContain('Created "Planning"');
  } finally { await h.dispose(); }
});

it('seals the clarification from the saved proposal with the target, the event and the coverage', async () => {
  const h = calendarFixture();
  try {
    h.setAvailability({ busy: [busy('2026-11-03T10:15:00Z', '2026-11-03T10:30:00Z')] });
    const ids = await h.submit('Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.');
    h.modelWires.push(loadWire('calendar_create_event'), createWire(event(), 'create-one'));
    await h.execute(ids);
    // The clarification is persisted before the assistant message is sealed.
    expect(await h.currentProposal(ids.sessionId)).toMatchObject({ purpose: 'conflict' });
    const messages = await h.p.messages.list(h.identity.userId, ids.sessionId, { cursor: null, limit: 50 });
    const assistant = messages.items.filter(message => message.role === 'assistant');
    expect(assistant).toHaveLength(1);
    const text = assistant[0].content;
    // The target, the event, the busy interval and the two accepted answers.
    expect(text).toContain('Personal');
    expect(text).toContain('Planning');
    expect(text).toContain('Tuesday, November 3, 2026');
    expect(text).toContain('10:00 AM');
    expect(text).toContain('11:00 AM');
    expect(text).toContain('10:15 AM to 10:30 AM');
    expect(text).toContain('create the event anyway');
    expect(text).toContain('different time');
    expect(text).not.toContain('2026-11-03T10:00:00+00:00');
    expect(text).not.toContain('Etc/UTC');
    // No operation identity, credential or internal revision leaks out.
    expect(text).not.toMatch(/operationId|revision|credential|https?:/iu);
  } finally { await h.dispose(); }
});

it('adds one matched result group for the model-requested read', async () => {
  const h = calendarFixture();
  try {
    const ids = await h.submit('Read event abcde');
    h.modelWires.push(loadWire('calendar_get_event'), nativeWire('{"eventId":"abcde"}'), textWire('Found it.'));
    await h.execute(ids);
    const messages = h.modelBodies.at(-1)!.messages as NativeCalendarModelMessage[];
    // Two complete groups: the original disclosure plus the executed read.
    const pairs = messages.flatMap((message, index) => {
      if (!('tool_calls' in message)) return [];
      const result = messages[index + 1];
      return result?.role === 'tool' ? [{ call: message.tool_calls[0], result }] : [];
    });
    expect(pairs).toHaveLength(2);
    for (const pair of pairs) expect(pair.result.tool_call_id).toBe(pair.call.id);
    expect(pairs.map(pair => pair.result.name)).toEqual(['activate_skill', 'call_tool']);
    expect(JSON.parse(pairs[1]!.result.content)).toMatchObject({ tool: 'calendar_get_event' });
  } finally { await h.dispose(); }
});

it('answers an unknown read target with a bounded clarification instead of a provider error', async () => {
  const h = calendarFixture();
  try {
    const ids = await h.submit('Read event abcde');
    h.modelWires.push(loadWire('calendar_get_event'),
      nativeWire('{"eventId":"abcde","calendarId":"missing@example.test"}'));
    await h.execute(ids);
    expect(h.effects.filter(e => e.kind === 'get')).toHaveLength(0);
    const messages = await h.p.messages.list(h.identity.userId, ids.sessionId, { cursor: null, limit: 50 });
    const assistant = messages.items.filter(message => message.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toContain('Which calendar should I use?');
  } finally { await h.dispose(); }
});

it('keeps an unrelated message as ordinary chat and leaves the proposal pending', async () => {
  const h = calendarFixture();
  try {
    h.setAvailability({ busy: [busy('2026-11-03T10:15:00Z', '2026-11-03T10:30:00Z')] });
    const first = await disclose(
      h,
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
      event(),
    );
    const unrelated = await h.reply(first.proposal, 'the quarterly report is done', first.ids.sessionId);
    h.modelWires.push(textWire('Noted.'));
    await h.execute(unrelated);
    // The message is not an answer: it neither consumes nor tombstones the
    // proposal, and it never becomes authority for an effect.
    expect(await h.proposalAuthority(first.proposal)).toMatchObject({ state: 'pending' });
    expect(await h.operationFor(unrelated)).toBeNull();
    expect(h.effects.filter(e => e.kind === 'create')).toHaveLength(0);
    const answered = await h.p.messages.list(h.identity.userId, unrelated.sessionId, { cursor: null, limit: 50 });
    expect(answered.items.filter(m => m.role === 'assistant').at(-1)?.content).toBe('Noted.');
  } finally { await h.dispose(); }
});

it('asks again for an ambiguous reply and never consumes the proposal', async () => {
  const h = calendarFixture();
  try {
    h.setAvailability({ busy: [busy('2026-11-03T10:15:00Z', '2026-11-03T10:30:00Z')] });
    const first = await disclose(
      h,
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
      event(),
    );
    const unsure = await h.reply(first.proposal, 'maybe?', first.ids.sessionId);
    await h.execute(unsure);
    expect(await h.proposalAuthority(first.proposal)).toMatchObject({ state: 'pending' });
    expect(await h.operationFor(unsure)).toBeNull();
    expect(h.effects.filter(e => e.kind === 'create')).toHaveLength(0);
    const asked = await h.p.messages.list(h.identity.userId, unsure.sessionId, { cursor: null, limit: 50 });
    expect(asked.items.filter(m => m.role === 'assistant').at(-1)?.content)
      .toContain('Should I create the event anyway');
  } finally { await h.dispose(); }
});

it('answers an inverted list window with a bounded clarification', async () => {
  const h = calendarFixture();
  try {
    const ids = await h.submit('What is on my calendar today?');
    h.modelWires.push(loadWire('calendar_list_events'),
      skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_events',
        arguments: { timeMin: '2026-11-03T11:00:00Z', timeMax: '2026-11-03T10:00:00Z', maxResults: 10 } },
      'list-one'),
      skillWire('call_tool', { plugin: 'google-calendar', tool: 'calendar_list_events',
        arguments: { timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', maxResults: 10 } },
      'list-corrected'), textWire('No events in that time range.'));
    await h.execute(ids);
    expect(h.effects.filter(e => e.kind === 'list')).toHaveLength(0);
    expect(h.modelBodies).toHaveLength(2);
    expect(await h.p.calendarAccountingV2.getBudget(h.identity.userId, ids.sessionId, ids.turnId))
      .toMatchObject({ repairs: 0, logicalTools: 0 });
    const messages = await h.p.messages.list(h.identity.userId, ids.sessionId, { cursor: null, limit: 50 });
    const assistant = messages.items.filter(message => message.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toContain('unambiguous date');
  } finally { await h.dispose(); }
});

it('answers a date-only create with a bounded clarification instead of interrupting the stream', async () => {
  const h = calendarFixture();
  try {
    const ids = await h.submit('Schedule Planning on 2026-11-03.');
    h.modelWires.push(loadWire('calendar_create_event'), createWire({ ...event(), start: '2026-11-03' }));
    await h.execute(ids);
    expect(h.effects.filter(e => e.kind === 'create')).toHaveLength(0);
    const messages = await h.p.messages.list(h.identity.userId, ids.sessionId, { cursor: null, limit: 50 });
    const assistant = messages.items.filter(message => message.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toMatch(/unambiguous|timed/);
  } finally { await h.dispose(); }
});

it('formats voice-friendly confirmation and date/time without raw ISO timestamps', () => {
  // 1. Friendly calendar label
  expect(friendlyCalendarLabel(null)).toBe('the selected calendar');
  expect(friendlyCalendarLabel({
    calendarId: 'owner@example.com',
    calendarLabel: 'owner@example.com',
    selectedBy: 'primary',
  } as any)).toBe('your primary calendar');
  expect(friendlyCalendarLabel({
    calendarId: 'primary',
    calendarLabel: 'owner@example.com',
    selectedBy: 'explicit',
  } as any)).toBe('your primary calendar');
  expect(friendlyCalendarLabel({
    calendarId: 'c_abc123@group.calendar.google.com',
    calendarLabel: 'Work',
    selectedBy: 'explicit',
  } as any)).toBe('Work');
  expect(friendlyCalendarLabel({
    calendarId: 'personal@example.test',
    calendarLabel: 'Personal',
    selectedBy: 'saved-default',
  } as any)).toBe('Personal');
  expect(friendlyCalendarLabel({
    calendarId: 'team@example.test',
    calendarLabel: 'team@example.test',
    selectedBy: 'saved-default',
  } as any)).toBe('team@example.test');
  expect(friendlyCalendarLabel({
    calendarId: 'team@example.test',
    calendarLabel: 'team@example.test',
    selectedBy: 'explicit',
  } as any)).toBe('team@example.test');

  // 2. Same-day event formatting (e.g. Friday, November 13, 2026, from 7:00 PM to 9:00 PM)
  const sameDayAction = {
    summary: 'pickleball game',
    start: '2026-11-13T19:00:00+05:30',
    end: '2026-11-13T21:00:00+05:30',
    timeZone: 'Asia/Kolkata',
  };
  const sameDayPhrase = formatEventPhrase(sameDayAction, 'your primary calendar');
  expect(sameDayPhrase).toBe(
    '"pickleball game" on your primary calendar on Friday, November 13, 2026, from 7:00 PM to 9:00 PM',
  );
  expect(sameDayPhrase).not.toContain('2026-11-13T19:00:00+05:30');
  expect(sameDayPhrase).not.toContain('Asia/Kolkata');
  expect(sameDayPhrase).not.toContain('+05:30');

  const confirmationMsg = `Please confirm: create ${sameDayPhrase}. Reply yes to confirm, or cancel.`;
  expect(confirmationMsg).toBe(
    'Please confirm: create "pickleball game" on your primary calendar on Friday, November 13, 2026, from 7:00 PM to 9:00 PM. Reply yes to confirm, or cancel.',
  );

  // 3. Multi-day event formatting (from Friday, Nov 13, 2026, 7:00 PM to Saturday, Nov 14, 2026, 9:00 PM)
  const multiDayAction = {
    summary: 'hackathon',
    start: '2026-11-13T19:00:00+05:30',
    end: '2026-11-14T21:00:00+05:30',
    timeZone: 'Asia/Kolkata',
  };
  const multiDayPhrase = formatEventPhrase(multiDayAction, 'Work');
  expect(multiDayPhrase).toBe(
    '"hackathon" on Work from Friday, Nov 13, 2026, 7:00 PM to Saturday, Nov 14, 2026, 9:00 PM',
  );
  expect(multiDayPhrase).not.toContain('2026-11-13T19:00:00+05:30');
  expect(multiDayPhrase).not.toContain('+05:30');

  // 4. Clean busy intervals
  const eventStart = new Date('2026-11-13T19:00:00+05:30');
  const sameDayBusy = formatBusyInterval(
    '2026-11-13T19:30:00+05:30',
    '2026-11-13T20:00:00+05:30',
    'Asia/Kolkata',
    eventStart,
  );
  expect(sameDayBusy).toBe('7:30 PM to 8:00 PM');
  expect(sameDayBusy).not.toContain('2026-11-13');
  expect(sameDayBusy).not.toContain('+05:30');

  const multiDayBusy = formatBusyInterval(
    '2026-11-13T23:30:00+05:30',
    '2026-11-14T01:00:00+05:30',
    'Asia/Kolkata',
    eventStart,
  );
  expect(multiDayBusy).toBe('Nov 13, 11:30 PM to Nov 14, 1:00 AM');
  expect(multiDayBusy).not.toContain('T');
  expect(multiDayBusy).not.toContain('+05:30');
});

it('uses the standard 10-minute draft ceiling when retention policy is 24h', async () => {
  const h = calendarFixture();
  try {
    const conn = (await h.p.calendarConnectionsV2.get('aurvin-dev-user'))!;
    expect(conn.schemaVersion).toBe(2);
    const retentionMs = Date.parse(conn.discovery!.retentionExpiresAt) - h.clock();
    expect(retentionMs).toBe(86400000);

    h.setAvailability({ busy: [busy('2026-11-03T10:15:00Z', '2026-11-03T10:30:00Z')] });
    const first = await disclose(
      h,
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
      event(),
    );

    expect(Date.parse(first.proposal.expiresAt) - h.clock()).toBe(600000);
    expect(Date.parse(first.proposal.contentExpiresAt)).toBeLessThanOrEqual(
      Date.parse(conn.discovery!.retentionExpiresAt),
    );
  } finally {
    await h.dispose();
  }
});

it('clamps a draft proposal to a short retention ceiling without failing validation', async () => {
  const h = calendarFixture();
  try {
    const current = (await h.p.calendarConnectionsV2.get('aurvin-dev-user'))!;
    if (current.schemaVersion !== 2 || !current.discovery) throw new Error('missing v2 discovery');
    const retentionAt = new Date(h.clock() + 120000).toISOString();
    const patched = await h.p.calendarConnectionsV2.compareAndSwap({
      userId: 'aurvin-dev-user',
      expectedRevision: current.revision,
      expectedConnectionRevision: current.connectionRevision,
      expectedDefaultSettingRevision: current.defaultSetting.defaultSettingRevision,
      next: {
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date(h.clock()).toISOString(),
        discovery: {
          ...current.discovery,
          discoveryRevision: current.revision + 1,
          connectionRevision: current.connectionRevision,
          expiresAt: retentionAt,
          retentionExpiresAt: retentionAt,
        },
      },
    });
    expect(patched.outcome).toBe('confirmed');

    h.setAvailability({ busy: [busy('2026-11-03T10:15:00Z', '2026-11-03T10:30:00Z')] });
    const first = await disclose(
      h,
      'Schedule Planning on 2026-11-03 from 10:00 to 11:00 Etc/UTC.',
      event(),
    );

    expect(Date.parse(first.proposal.expiresAt) - h.clock()).toBe(120000);
    expect(first.proposal.contentExpiresAt).toBe(retentionAt);
    expect(first.proposal.state).toBe('pending');
  } finally {
    await h.dispose();
  }
});

it('does not inherit an expired proposal timestamp when publishing for the same intent', async () => {
  const nowMs = 1700000000000;
  const expiredProposal = {
    userId: 'user-1',
    sessionId: 'session-1',
    proposalId: 'prop-1',
    revision: 1,
    intentId: 'intent-1',
    purpose: 'details' as const,
    state: 'pending' as const,
    target: null,
    canonicalActionHash: null,
    conditionFingerprint: null,
    candidates: [],
    incomplete: { missing: ['start'] as ('start'[]), messageRefs: [] },
    discoveryRevision: 1,
    availabilityRevision: null,
    disclosedLimitations: [],
    connectionId: 'conn-1',
    connectionRevision: 1,
    googleSubjectId: 'sub-1',
    retentionPolicyId: 'policy-1',
    contentExpiresAt: new Date(nowMs + 600000).toISOString(),
    originatingTurnId: 'turn-1',
    originatingAcceptedMessageId: 'msg-1',
    originatingAttemptId: 'attempt-1',
    createdAt: new Date(nowMs - 600000).toISOString(),
    expiresAt: new Date(nowMs - 1000).toISOString(),
    consumedBy: null,
  };

  const fakeStore = {
    getCurrent: async () => expiredProposal as any,
    putCurrent: async ({ proposal }: any) => ({ outcome: 'confirmed', proposal }),
  } as any;

  const published = await publishProposal({
    account: { userId: 'user-1', connectionId: 'conn-1', connectionRevision: 1, googleSubjectId: 'sub-1' },
    intent: {
      intentId: 'intent-1',
      originatingTurnId: 'turn-1',
      originatingAcceptedMessageId: 'msg-1',
      originatingAttemptId: 'attempt-1',
    } as any,
    purpose: 'details',
    target: null,
    action: null,
    candidates: [],
    conditionFingerprint: null,
    incomplete: { missing: ['start'], messageRefs: [] },
    discoveryRevision: 1,
    availabilityRevision: null,
    retentionPolicyId: 'policy-1',
    contentExpiresAt: new Date(nowMs + 600000).toISOString(),
    limits: { proposalLifetimeMs: 600000 } as any,
    clock: () => nowMs,
    proposals: fakeStore,
    sessionId: 'session-1',
  });

  expect(Date.parse(published.expiresAt)).toBeGreaterThan(nowMs);
  expect(Date.parse(published.expiresAt) - nowMs).toBe(600000);
});

it('captures notice message based on check_availability conflict and coverage', async () => {
  const h = calendarFixture();
  try {
    // 1. Complete with conflict
    h.setAvailability({ busy: [busy('2026-11-03T10:15:00Z', '2026-11-03T10:30:00Z')] });
    const ids1 = await h.submit('Check availability 1');
    h.modelWires.push(loadWire('calendar_check_availability'), skillWire('call_tool', {
      plugin: 'google-calendar', tool: 'calendar_check_availability', arguments: {
        timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' } }, 'check-1'),
      textWire('Found a conflict.'));
    await h.execute(ids1);
    const completion1 = h.frames.find(f => f.turnId === ids1.turnId && f.event.type === 'completed');
    expect(completion1?.event).toMatchObject({
      calendarView: { kind: 'notice', message: 'Availability checked: conflict found.', coverage: 'complete', conflict: 'conflict' },
    });

    // 2. Complete free (no conflict)
    h.setAvailability({ busy: [] });
    const ids2 = await h.submit('Check availability 2');
    h.modelWires.push(loadWire('calendar_check_availability'), skillWire('call_tool', {
      plugin: 'google-calendar', tool: 'calendar_check_availability', arguments: {
        timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' } }, 'check-2'),
      textWire('Time is free.'));
    await h.execute(ids2);
    const completion2 = h.frames.find(f => f.turnId === ids2.turnId && f.event.type === 'completed');
    expect(completion2?.event).toMatchObject({
      calendarView: { kind: 'notice', message: 'Availability checked: time is free.', coverage: 'complete', conflict: 'clear' },
    });

    // 3. Incomplete coverage
    h.setAvailability({ calendarErrors: { 'read@example.test': 'notFound' }, busy: [] });
    const ids3 = await h.submit('Check availability 3');
    h.modelWires.push(loadWire('calendar_check_availability'), skillWire('call_tool', {
      plugin: 'google-calendar', tool: 'calendar_check_availability', arguments: {
        timeMin: '2026-11-03T10:00:00Z', timeMax: '2026-11-03T11:00:00Z', timeZone: 'Etc/UTC' } }, 'check-3'),
      textWire('Availability checked across active calendars.'));
    await h.execute(ids3);
    const completion3 = h.frames.find(f => f.turnId === ids3.turnId && f.event.type === 'completed');
    expect(completion3?.event).toMatchObject({
      calendarView: { kind: 'notice', message: 'Availability checked across active calendars.', coverage: 'incomplete' },
    });
  } finally { await h.dispose(); }
});
