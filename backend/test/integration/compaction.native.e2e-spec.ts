/**
 * ============================================================================
 * FILE: compaction.native.e2e-spec.ts
 * LOCATION: backend/test/integration/compaction.native.e2e-spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify compaction through persistence, cold hydration, scrollback, privacy,
 *    cache alignment, voice silence, and isolated native MongoDB.
 *
 * ROLE IN PROJECT:
 *    P5 integrated evidence for P2–P4 without changing their implementation.
 *    The offline Mongo driver is the deterministic fallback; native MongoDB is
 *    separately gated by the operator's isolated test configuration.
 *
 * KEY COMPONENTS:
 *    - Long-session native and deterministic fallback tests.
 *    - Calendar expiry, Live Voice silence, and cache-prefix assertions.
 * ============================================================================
 */
import type { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { activeSummaryRecordSchema } from '../../src/contracts/agent-memory.js';
import { CALENDAR_TOMBSTONE } from '../../src/contracts/calendar-sources.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { ReferencedContextAssembler } from '../../src/context/referenced-context-assembler.js';
import { buildReferenceManifest } from '../../src/context/reference-selection.js';
import { ChatHttpService } from '../../src/http/chat-http.service.js';
import { MemoryTextArchive } from '../../src/persistence/memory-text-archive.js';
import { MongoMetadata } from '../../src/persistence/metadata.js';
import { createPersistenceBundle, type PersistenceBundle } from '../../src/persistence/persistence.js';
import { key } from '../../src/persistence/records.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { sessionIdFor } from '../../src/chat-runtime/identity.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { assets } from '../context/fixtures.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { nativeDatabase } from '../persistence/native.js';
import { textConfigFixture } from '../runtime/text-config-fixture.js';

const nativeConfigured = Boolean(process.env.AURVIN_TEST_MONGODB_URI)
  && process.env.AURVIN_TEST_DB_PREFIX === 'aurvin_p2_test_';

const USER = 'aurvin-dev-user';
const LONG_TURNS = 260;
const MESSAGE_WATERMARK = Math.ceil(DEFAULT_BUDGETS.maxMessagesInContext * 0.8);
const BASE_NOW = Date.parse('2026-11-17T12:00:00.000Z');
// ponytail: shortened backoff keeps one intentionally lost ack recoverable
// inside the bounded deterministic test; production policy stays untouched.
const TEST_POLICY = Object.freeze({ ...PROPOSED_MEMORY_TEXT_POLICY, retryBackoffMs: 5 });

type Body = {
  messages?: { role?: string; content?: string | null }[];
  session_id?: string;
  cache_control?: unknown;
};
type Harness = { persistence: PersistenceBundle; close(): Promise<void> };

function fixtureResponse(text: string, id: string): Response {
  const frames = [
    { id, model: 'anthropic/claude-3.5-haiku',
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 24, cost: 0 } },
  ];
  return new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function summaryResponse(): string {
  const sections = COMPACTION_SECTIONS.map((heading, index) =>
    `## ${index + 1}. ${heading}\n${index === 0 ? 'Preserve the long-session objective.' : 'None.'}`,
  ).join('\n\n');
  return `<analysis>fixture scratchpad is never retained</analysis>\n<summary>${sections}</summary>`;
}

async function openDeterministicPersistence() {
  const memory = calendarMemory(undefined, { databaseName: 'p5-deterministic' });
  const client = Object.assign(memory.commandSource, {
    appendMetadata: () => undefined,
    db: () => memory.store.db,
    close: async () => undefined,
  }) as unknown as MongoClient;
  const persistence = await createPersistenceBundle(
    client, 'p5-deterministic', DEFAULT_BUDGETS, 'p5-deterministic-executor',
  );
  return {
    persistence,
    async close() {
      await persistence.owner.drain();
      await persistence.owner.releaseExecutor();
      await client.close();
    },
  };
}

async function openNativePersistence() {
  const database = await nativeDatabase();
  const persistence = await createPersistenceBundle(
    database.client, database.name, DEFAULT_BUDGETS, 'p5-native-executor',
  );
  return {
    persistence,
    async close() {
      await persistence.owner.drain();
      await persistence.owner.releaseExecutor();
      await database.close();
    },
  };
}

function makeRuntime(persistence: PersistenceBundle, options: { live?: boolean } = {}) {
  const base = textSnapshot(1, {}, 'anthropic/claude-3.5-haiku', 'fixture-key', USER);
  const settings = {
    ...base.settings,
    voice: {
      ...base.settings.voice,
      enabledModes: { ...base.settings.voice.enabledModes, live: options.live === true },
    },
  };
  const snapshot = Object.freeze({ ...base, settings: Object.freeze(settings) });
  const archive = new MemoryTextArchive(persistence, assets);
  let loseNextCompactionAck = true;
  let lostCompactionAcks = 0;
  let lostSummaryId: string | null = null;
  const compactionSaveAttempts = new Map<string, number>();
  const save: typeof archive.save = async (envelope, limits) => {
    const outcome = await archive.save(envelope, limits);
    if ('kind' in envelope && envelope.kind === 'compaction') {
      const id = envelope.summary.summaryId;
      compactionSaveAttempts.set(id, (compactionSaveAttempts.get(id) ?? 0) + 1);
      if (loseNextCompactionAck) {
        loseNextCompactionAck = false;
        lostCompactionAcks += 1;
        lostSummaryId = id;
        return { kind: 'unknown', retryable: true };
      }
    }
    return outcome;
  };
  // ponytail: elapsed real time, not a frozen clock, so the bounded save
  // backoff can mature while the long-session turn loop stays deterministic.
  const startedAt = Date.now();
  const clock = () => BASE_NOW + (Date.now() - startedAt);
  const fixture = textConfigFixture(snapshot, dependencies => ({
    ...dependencies,
    now: clock,
    memoryFirst: { policy: TEST_POLICY, save, voice: options.live === true },
  }), persistence);
  const bodies: Body[] = [];
  fixture.fetcher.mockImplementation(async (url, init) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (!href.includes('/chat/completions')) throw new Error('Unexpected fetch URL');
    if (typeof init?.body !== 'string') throw new Error('Unexpected fetch body');
    const body = JSON.parse(init.body) as Body;
    bodies.push(body);
    const final = body.messages?.at(-1)?.content ?? '';
    return fixtureResponse(
      final.includes('Compact the preceding conversation data') ? summaryResponse() : 'Fixture answer.',
      `gen-p5-${bodies.length}`,
    );
  });
  return {
    fixture, bodies,
    getLostCompactionAcks: () => lostCompactionAcks,
    getLostSummarySaveAttempts: () => lostSummaryId ? compactionSaveAttempts.get(lostSummaryId) ?? 0 : 0,
  };
}

async function waitForCheckpoint(persistence: PersistenceBundle,
  sessionId: string, minimumCycle: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const session = await persistence.sessions.get(USER, sessionId);
    const manifest = await persistence.memory.get(USER, sessionId);
    const checkpoint = session?.compactionCheckpoint;
    if (checkpoint && checkpoint.compactionCycle >= minimumCycle
      && manifest?.activeSummaryRef?.summaryId === checkpoint.summaryId) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`compaction cycle ${minimumCycle} was not durably published`);
}

async function runLongSession(harness: Harness): Promise<void> {
  const { persistence } = harness;
  const runtimeHarness = makeRuntime(persistence);
  const { fixture, bodies } = runtimeHarness;
  let sessionId: string | null = null;
  try {
    for (let index = 0; index < LONG_TURNS; index += 1) {
      const prior = sessionId ? await persistence.sessions.get(USER, sessionId) : null;
      const priorCycle = prior?.compactionCheckpoint?.compactionCycle ?? 0;
      const accepted = await fixture.submit(`Long-session turn ${index}`, sessionId);
      sessionId = accepted.sessionId;
      await fixture.execute(accepted);
      const working = fixture.runtime.memoryFor(USER)?.foundation.records(sessionId).length ?? 0;
      if (working >= MESSAGE_WATERMARK) {
        await waitForCheckpoint(persistence, sessionId, priorCycle + 1);
      }
    }

    if (!sessionId) throw new Error('long session was not created');
    const beforeRestart = await persistence.sessions.get(USER, sessionId);
    expect(beforeRestart?.compactionCheckpoint?.compactionCycle).toBeGreaterThan(0);
    const compacted = await persistence.memory.get(USER, sessionId);
    expect(compacted?.activeSummaryRef).not.toBeNull();
    expect(compacted!.messageRefs.length).toBeLessThanOrEqual(500);
    const activeSummary = await persistence.metadata.getCompactionSummary(
      USER, sessionId, compacted!.activeSummaryRef!.summaryId,
    );
    expect(activeSummary).not.toBeNull();
    expect(activeSummary!.content).not.toMatch(/<\/?analysis\b/i);
    expect(fixture.runtime.memoryFor(USER)!.foundation.records(sessionId).length).toBeLessThanOrEqual(500);
    expect(fixture.runtime.memoryFor(USER)!.foundation.snapshot().reservedMemoryBytes)
      .toBeLessThanOrEqual(PROPOSED_MEMORY_TEXT_POLICY.maxMemoryBytes);
    expect(runtimeHarness.getLostCompactionAcks()).toBe(1);

    const compactionCallsBeforeRestart = bodies.filter(body =>
      body.messages?.at(-1)?.content?.includes('Compact the preceding conversation data')).length;
    await fixture.restart();
    expect(runtimeHarness.getLostSummarySaveAttempts()).toBeGreaterThanOrEqual(2);
    for (const [index, content] of ['After cold restart A', 'After cold restart B'].entries()) {
      if (index > 0) await fixture.restart();
      const accepted = await fixture.submit(content, sessionId);
      await fixture.execute(accepted);
    }
    expect(bodies.filter(body =>
      body.messages?.at(-1)?.content?.includes('Compact the preceding conversation data')))
      .toHaveLength(compactionCallsBeforeRestart);
    const chats = bodies.filter(body =>
      !body.messages?.at(-1)?.content?.includes('Compact the preceding conversation data'));
    const first = chats.at(-2)!;
    const second = chats.at(-1)!;
    const summaryIndex = first.messages!.findIndex(message =>
      message.content?.includes('<compacted_history>'));
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(first.messages!.slice(0, summaryIndex + 1))
      .toEqual(second.messages!.slice(0, summaryIndex + 1));
    expect(first.session_id).toBe(second.session_id);
    expect(first.cache_control).toEqual({ type: 'ephemeral' });
    await fixture.runtime.memoryFor(USER)!.foundation.flushSession(sessionId);

    const http = new ChatHttpService({
      identity: { resolve: () => ({ userId: USER, source: 'local-default' }),
        assertNoClientOverrides: () => undefined },
      sessions: persistence.sessions,
      messages: persistence.messages,
      budgets: DEFAULT_BUDGETS,
      runtime: fixture.runtime,
    } as never);
    const transcript: { content: string; sequence: number }[] = [];
    let cursor: string | null = null;
    do {
      const page = await http.messages(sessionId, { ...(cursor ? { cursor } : {}), limit: '50' });
      // Scrollback pages arrive newest-first; prepend to rebuild oldest-first order.
      transcript.unshift(...page.items.map(message => ({ content: message.content, sequence: message.sequence })));
      cursor = page.nextCursor;
    } while (cursor);
    expect(transcript).toHaveLength((LONG_TURNS + 2) * 2);
    for (let index = 0; index < LONG_TURNS; index += 1) {
      expect(transcript.some(message => message.content === `Long-session turn ${index}`)).toBe(true);
    }
    expect(transcript.map(message => message.sequence)).toEqual(
      transcript.map(message => message.sequence).sort((left, right) => left - right),
    );
  } finally {
    await fixture.dispose();
  }
}

async function verifyCalendarExpiry(persistence: PersistenceBundle): Promise<void> {
  const expiresAt = '2026-11-17T12:00:00.000Z';
  const summaryId = 'p5-expired-calendar-summary';
  const sourceRange = { fromSequence: 0, toSequence: 1, fromEventId: 'p5-e0', toEventId: 'p5-e1' };
  const content = COMPACTION_SECTIONS.map((heading, index) =>
    `## ${index + 1}. ${heading}\n${index === 6
      ? '<calendar_context>Private P5 event at 4pm.</calendar_context>'
      : 'Keep non-Calendar context.'}`,
  ).join('\n\n');
  const summary = activeSummaryRecordSchema.parse({
    schemaVersion: 1, kind: 'memory-summary', userId: USER,
    sessionId: 'p5-calendar-expiry', summaryId, compactionCycle: 1, sourceRange,
    content, tokenEstimate: 100,
    calendarProvenance: {
      containsCalendarContent: true, connectionId: 'p5-connection',
      connectionRevision: 1, earliestExpiresAt: expiresAt, redactedAt: null,
    },
    modelId: 'fixture/model', createdAt: '2026-11-17T11:00:00.000Z',
  });
  const store = persistence.owner.store;
  if (!store) throw new Error('test persistence store is unavailable');
  const exactClockMetadata = new MongoMetadata(
    store, DEFAULT_BUDGETS, () => Date.parse(expiresAt),
  );
  await exactClockMetadata.putCompactionSummary(summary);
  const projected = await exactClockMetadata.getCompactionSummary(USER, 'p5-calendar-expiry', summaryId);
  expect(projected?.content).toContain(CALENDAR_TOMBSTONE);
  expect(projected?.content).not.toContain('Private P5 event');
  const persisted = await exactClockMetadata.redactCompactionSummary(
    USER, 'p5-calendar-expiry', summaryId, expiresAt,
  );
  expect(persisted?.calendarProvenance.redactedAt).toBe(expiresAt);
  const raw = await store.raw('metadata', {
    _id: key('memory-summary', USER, 'p5-calendar-expiry', summaryId),
  });
  expect(JSON.stringify(raw)).not.toContain('Private P5 event');

  const manifest = buildReferenceManifest(
    USER, 'p5-calendar-expiry', 1, [], assets, DEFAULT_BUDGETS,
    { summaryId, sourceRange },
  );
  await persistence.memory.put(manifest);
  const assembler = new ReferencedContextAssembler({
    memory: persistence.memory, messages: persistence.messages,
    metadata: persistence.metadata, assets, budgets: DEFAULT_BUDGETS,
  });
  const result = await assembler.assemble({
    userId: USER, sessionId: 'p5-calendar-expiry', turnId: 'p5-followup',
    newUserInput: 'Continue without expired Calendar details.',
    responseMode: 'text',
    environment: { timeZone: 'Etc/UTC', currentDate: '2026-11-17', dayOfWeek: 'Tuesday' },
  });
  if (!result.ok) throw new Error('expected an assembled context');
  const serialized = JSON.stringify(result.context.messages);
  expect(serialized).toContain(CALENDAR_TOMBSTONE);
  expect(serialized).not.toContain('Private P5 event');
  expect(serialized).not.toContain('4pm');
}

async function verifyVoiceSilence(persistence: PersistenceBundle): Promise<void> {
  const { fixture, bodies } = makeRuntime(persistence, { live: true });
  const spoken: string[] = [];
  const wireEvents: string[] = [];
  // The seed must equal the first accepted conversation identity, matching the
  // freshLiveConversation guard in MemoryText.submit.
  const seed = sessionIdFor(USER, null, 'p5-live-voice-0-key');
  const reservation = await fixture.runtime.reservations.acquire({
    identity: fixture.identity, conversationId: seed,
    owner: { kind: 'live', voiceSessionId: 'p5-live-voice' },
  });
  let sessionId = seed;
  try {
    for (let index = 0; index < 4; index += 1) {
      const accepted = await fixture.runtime.submitLiveTurn({
        identity: fixture.identity, sessionId, freshConversation: index === 0,
        content: `Voice turn ${index} ${'v'.repeat(2200)}`,
        idempotencyKey: `p5-live-voice-${index}-key`,
        reservation,
        voice: { voiceSessionId: 'p5-live-voice', socketEpoch: 1, providerTurnId: `p5-provider-${index}` },
      });
      sessionId = accepted.sessionId;
      await fixture.runtime.executeTurn({
        userId: USER, sessionId, turnId: accepted.turnId, attemptId: accepted.attemptId,
        signal: new AbortController().signal,
        emit: async event => { wireEvents.push(event.event.type); },
        live: {
          reservation, start: async () => undefined,
          delta: async text => { spoken.push(text); },
          finish: async () => undefined,
          settle: async () => undefined,
        },
      });
    }
    await waitForCheckpoint(persistence, sessionId, 1);
    expect(bodies.some(body =>
      body.messages?.at(-1)?.content?.includes('Compact the preceding conversation data'))).toBe(true);
    expect(wireEvents).not.toContain('context-state');
    expect(spoken.join('')).not.toContain('<summary>');
    expect(spoken.join('')).not.toContain('Preserve the long-session objective.');
  } finally {
    await fixture.dispose();
  }
}

describe('P5 integrated context compaction', () => {
  it('persists, cold-hydrates, and pages a 260-turn session in the deterministic fallback', async () => {
    const harness = await openDeterministicPersistence();
    try {
      await runLongSession(harness);
    } finally {
      await harness.close();
    }
  }, 120_000);

  it('redacts expired Calendar summary at the exact expiry through persistence and context assembly', async () => {
    const harness = await openDeterministicPersistence();
    try {
      await verifyCalendarExpiry(harness.persistence);
    } finally {
      await harness.close();
    }
  });

  it('keeps Live Voice compaction silent', async () => {
    const harness = await openDeterministicPersistence();
    try {
      await verifyVoiceSilence(harness.persistence);
    } finally {
      await harness.close();
    }
  });

  it.skipIf(!nativeConfigured)('persists and cold-hydrates 260 turns in isolated native MongoDB', async () => {
    const harness = await openNativePersistence();
    try {
      await runLongSession(harness);
      await verifyCalendarExpiry(harness.persistence);
    } finally {
      await harness.close();
    }
  }, 240_000);
});
