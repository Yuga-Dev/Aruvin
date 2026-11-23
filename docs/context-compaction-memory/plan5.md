# Integrated Verification, Native Long-Session E2E & Eval Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is P5 only: P1–P4 workers are complete; do not change their source. Unified review is **skipped**, not passed. The orchestrator serializes commits.

**Goal:** Add integrated evidence that compaction persists and hydrates sessions past the former limits, preserves full scrollback and privacy/cache/voice invariants, recovers an ambiguous compaction save, and aligns evaluation pins with P2's product copy.

**Architecture:** Use one owned integration spec to exercise the real P2/P3 runtime and persistence adapters against both the existing deterministic in-memory Mongo driver and an isolated native MongoDB database. No production code or dependencies are added. Keep native DB evidence explicitly conditional on the operator's isolated test URI; the offline fallback always runs and remains meaningful when native prerequisites are absent.

**Tech Stack:** TypeScript ESM/NodeNext (`.js` local imports), Vitest, existing `calendarMemory` deterministic Mongo driver, existing `MemoryTextArchive`/`textConfigFixture`, real MongoDB repositories and LangGraph checkpointer, deterministic OpenRouter SSE fixtures.

---

## Scope, inputs, and file ownership

Read `goal.md` section 6, the P5 and research-handoff sections of `state.md`, `research.md`, and `plan2.md`–`plan4.md` before execution. P1–P4 implementation is complete; use the existing source and tests as evidence targets, not as permission to reopen their implementation.

**Modify only these P5-owned files:**

- Create `backend/test/integration/compaction.native.e2e-spec.ts`: always-on deterministic integration fallback, conditionally run native MongoDB long-session evidence, plus cross-layer Calendar, voice-silence, and cache-prefix assertions.
- Modify `backend/test/evaluations/deterministic.behavior.spec.ts`: update only the product-knowledge phrase and `KNOWLEDGE_DIGEST` affected by P2.
- Modify `backend/test/evaluations/cases.json`: align only the `PK-01` deterministic/live claims with the shipped P2 copy.

Reuse, do not modify: `backend/test/persistence/calendar-multi-memory.ts`, `backend/test/runtime/text-config-fixture.ts`, `backend/test/runtime/compaction-runtime.spec.ts`, `backend/test/runtime/compaction-hydration.spec.ts`, `backend/test/persistence/native.ts`, and `backend/src/**`.

Do not touch voice/VAD work, `backend/src/contracts/voice-wire.ts`, `frontend/src/api/voice-protocol.ts`, `output/`, `benchmarks/voice-architectures/**`, `.openchamber/**`, or any P1–P4 implementation files. Do not run git commands; report named files and suggested commit messages to the orchestrator.

### Evidence boundaries and known baselines

- The native fixture requires operator-supplied `AURVIN_TEST_MONGODB_URI` and `AURVIN_TEST_DB_PREFIX=aurvin_p2_test_`. It creates and drops a unique generated database. Never use application/production data and never print the URI or credentials.
- A native suite skipped for missing prerequisites is **not** a pass. The deterministic fallback must run and prove the same long-session, scrollback, and persisted-summary path using the real persistence adapters over the existing offline Mongo test driver.
- `MemoryFirstFoundation.snapshot()` exposes configured encoded-capacity reservations, not V8 heap/RSS measurements. Assert the manifest, active working set, and configured reservation bounds; do not claim a measured process-memory ceiling.
- `product_knowledge.md` now says automatic in-session compaction keeps full visible history scrollable. Its current SHA-256 is `568E38BF301C2765C6B7FB5C0D9D57B4EA2D4A94EA72884CA75E898F5B00B928`; verify from the current file before pinning.
- `test:behavior` had two pre-existing failures before this workflow: `SYSTEM_DIGEST` and `<canvas_guidelines>` drift. Update `KNOWLEDGE_DIGEST`/`PK-01` only; do not “fix” `system.md`, `SYSTEM_DIGEST`, or unrelated instructions.
- Full backend `npm test` has known pre-existing assembly 503s, frozen latency caps, and similar baseline failures. The full frontend suite has a pre-existing `voice-fixtures.test.ts` mismatch: uncommitted `backend/src/contracts/voice-wire.ts` has `bargeInSpeechWindows: 10`, while `frontend/src/api/voice-protocol.ts` does not. Leave both unrelated code paths untouched; report actual results separately.
- Do not run live Google, OpenRouter, LiveKit, paid evaluation, or infrastructure provisioning. Every model response in this plan is a local deterministic SSE fixture.

## Task 1: Add deterministic persistence fallback and 260-turn cold-restart integration

**Files**

- Create: `backend/test/integration/compaction.native.e2e-spec.ts`
- Reuse: `backend/test/persistence/calendar-multi-memory.ts`
- Reuse: `backend/test/runtime/text-config-fixture.ts`
- Reuse: `backend/src/persistence/persistence.ts`, `backend/src/persistence/memory-text-archive.ts`, `backend/src/http/chat-http.service.ts`

- [ ] **Step 1: Start with the exact failing integration assertion**

Create the new spec with the required header, imports, and this first test. It intentionally names the helper that Step 3 will add; the initial red command must fail with an unresolved `runLongSession` symbol, not silently skip:

```typescript
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
import { describe, expect, it } from 'vitest';

const nativeConfigured = Boolean(process.env.AURVIN_TEST_MONGODB_URI)
  && process.env.AURVIN_TEST_DB_PREFIX === 'aurvin_p2_test_';

describe('P5 integrated context compaction', () => {
  it('persists, cold-hydrates, and pages a 260-turn session in the deterministic fallback', async () => {
    await runLongSession(await openDeterministicPersistence());
  }, 120_000);
});
```

- [ ] **Step 2: Run the red test before adding its helper**

Run in `backend/`:

```powershell
npm run test:e2e -- test/integration/compaction.native.e2e-spec.ts
```

Expected: FAIL at test-file compilation with `Cannot find name 'runLongSession'` and `Cannot find name 'openDeterministicPersistence'`. This is an intentionally incomplete test-first seam; the completed integration assertion below is the evidence, not this compile failure.

- [ ] **Step 3: Add deterministic SSE, persistence, and long-session helpers**

Add the following imports to the new spec. Keep every relative TypeScript import on a `.js` specifier:

```typescript
import type { MongoClient } from 'mongodb';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { activeSummaryRecordSchema } from '../../src/contracts/agent-memory.js';
import { CALENDAR_TOMBSTONE } from '../../src/contracts/calendar-sources.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { ReferencedContextAssembler } from '../../src/context/referenced-context-assembler.js';
import { buildReferenceManifest } from '../../src/context/reference-selection.js';
import { ChatHttpService } from '../../src/http/chat-http.service.js';
import { MemoryTextArchive } from '../../src/persistence/memory-text-archive.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { key } from '../../src/persistence/records.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { sessionIdFor } from '../../src/chat-runtime/identity.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { assets } from '../context/fixtures.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { nativeDatabase } from '../persistence/native.js';
import { textConfigFixture } from '../runtime/text-config-fixture.js';
```

Add these exact helpers above `describe`. The 260 completed turns deliberately produce 520 visible messages: 150 turns would not cross the former 500-message cap.

```typescript
const USER = 'p5-compaction-user';
const LONG_TURNS = 260;
const MESSAGE_WATERMARK = Math.ceil(DEFAULT_BUDGETS.maxMessagesInContext * 0.8);
type Body = {
  messages?: { role?: string; content?: string | null }[];
  session_id?: string;
  cache_control?: unknown;
};

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

function makeRuntime(persistence: Awaited<ReturnType<typeof openDeterministicPersistence>>['persistence'],
  options: { live?: boolean } = {}) {
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
  const fixture = textConfigFixture(snapshot, dependencies => ({
    ...dependencies,
    now: () => Date.parse('2026-11-17T12:00:00.000Z'),
    memoryFirst: { policy: PROPOSED_MEMORY_TEXT_POLICY, save, voice: options.live === true },
  }), persistence);
  const bodies: Body[] = [];
  fixture.fetcher.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
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

async function waitForCheckpoint(persistence: Awaited<ReturnType<typeof openDeterministicPersistence>>['persistence'],
  sessionId: string, minimumCycle: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const session = await persistence.sessions.get(USER, sessionId);
    const manifest = await persistence.memory.get(USER, sessionId);
    const checkpoint = session?.compactionCheckpoint;
    if (checkpoint && checkpoint.compactionCycle >= minimumCycle
      && manifest?.activeSummaryRef?.summaryId === checkpoint.summaryId) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`compaction cycle ${minimumCycle} was not durably published`);
}

async function runLongSession(harness: Awaited<ReturnType<typeof openDeterministicPersistence>>) {
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
      const page = await http.messages(sessionId, { cursor, limit: 50 });
      transcript.push(...page.items.map(message => ({ content: message.content, sequence: message.sequence })));
      cursor = page.nextCursor;
    } while (cursor);
    expect(transcript).toHaveLength((LONG_TURNS + 2) * 2);
    for (let index = 0; index < LONG_TURNS; index += 1) {
      expect(transcript.some(message => message.content === `Long-session turn ${index}`)).toBe(true);
    }
    expect(transcript.map(message => message.sequence)).toEqual(
      [...transcript.map(message => message.sequence)].sort((left, right) => left - right),
    );
  } finally {
    await fixture.dispose();
  }
}
```

The synthetic provider reply, persisted archive, and native checkpointer are all deterministic; no provider credentials are used.

- [ ] **Step 4: Run the completed deterministic fallback**

Run in `backend/`:

```powershell
npm run test:e2e -- test/integration/compaction.native.e2e-spec.ts -t "deterministic fallback"
```

Expected: PASS with 260 accepted/completed turns, at least one durable compaction checkpoint, more than 128 turns and 500 visible archived messages, successful context assembly after two cold restarts, one recovered ambiguous compaction-save acknowledgement without rerunning the compaction model, stable `[static prefix + active summary]` bytes across the two restarted turns, and all `(260 + 2) * 2 = 524` visible messages returned in sequence order through the HTTP scrollback path. The persisted manifest and foundation remain within their existing bounds.

- [ ] **Step 5: Add and run the conditional isolated native twin**

Append to the same `describe`:

```typescript
  it.skipIf(!nativeConfigured)('persists and cold-hydrates 260 turns in isolated native MongoDB', async () => {
    const harness = await openNativePersistence();
    try {
      await runLongSession(harness);
      await verifyCalendarExpiry(harness.persistence);
    } finally {
      await harness.close();
    }
  }, 240_000);
```

Run without URI (the deterministic case must still pass; the native case is reported as skipped, not passed):

```powershell
npm run test:e2e -- test/integration/compaction.native.e2e-spec.ts
```

Run the native evidence only when the operator has already supplied the isolated environment variables:

```powershell
$env:AURVIN_TEST_DB_PREFIX = 'aurvin_p2_test_'
npm run test:e2e -- test/integration/compaction.native.e2e-spec.ts -t "isolated native MongoDB"
```

Expected: With the correct `AURVIN_TEST_MONGODB_URI` and replica-set test service, PASS against a generated `aurvin_p2_test_<uuid>` database that is dropped during cleanup. Without that URI, the native test is skipped and the offline fallback remains the only integration evidence. Never display or copy the URI into commands, output, artifacts, or the repository.

- [ ] **Step 6: Request the serialized commit**

Suggested message: `test(compaction): verify long-session persistence across cold restarts`.

## Task 2: Verify Calendar expiry redaction across persistence and assembled context

**Files**

- Modify: `backend/test/integration/compaction.native.e2e-spec.ts`
- Reuse: `MongoMetadata`, `ReferencedContextAssembler`, `buildReferenceManifest`, and the isolated/deterministic persistence adapters.

- [ ] **Step 1: Add the exact failing privacy assertion**

Add this test to the existing `describe`; it is intended to fail if expired Calendar content survives either persistence redaction or assembled-context projection:

```typescript
  it('redacts expired Calendar summary at the exact expiry through persistence and context assembly', async () => {
    const harness = await openDeterministicPersistence();
    try {
      await verifyCalendarExpiry(harness.persistence);
    } finally {
      await harness.close();
    }
  });
```

Expected first red command: same focused Vitest command as Task 1 exits nonzero because `verifyCalendarExpiry` has not been added.

- [ ] **Step 1a: Confirm the Calendar test is red**

Run in `backend/`:

```powershell
npm run test:e2e -- test/integration/compaction.native.e2e-spec.ts -t "Calendar summary"
```

Expected: FAIL at test-file compilation with `Cannot find name 'verifyCalendarExpiry'`.

- [ ] **Step 2: Add the exact cross-layer Calendar fixture and assertion**

Add these imports:

```typescript
import { MongoMetadata } from '../../src/persistence/metadata.js';
```

Add the helper above `describe`:

```typescript
async function verifyCalendarExpiry(
  persistence: Awaited<ReturnType<typeof openDeterministicPersistence>>['persistence'],
): Promise<void> {
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
```

- [ ] **Step 3: Verify deterministic and native Calendar paths**

Run in `backend/`:

```powershell
npm run test:e2e -- test/integration/compaction.native.e2e-spec.ts -t "Calendar summary"
```

Expected: PASS at equality (`now === earliestExpiresAt`), including raw persisted storage and a cold `ReferencedContextAssembler` read. Then invoke the same `verifyCalendarExpiry` assertion against the native persistence created by Task 1 from its native test body (after the long-session run); do not create a second native database. No expired Calendar source may appear outside the tombstone.

- [ ] **Step 4: Request the serialized commit**

Suggested message: `test(compaction): verify Calendar expiry redaction across storage and context`.

## Task 3: Verify Live Voice silence and cache-prefix invariance in the owned integration spec

**Files**

- Modify: `backend/test/integration/compaction.native.e2e-spec.ts`
- Reuse: the deterministic provider, `textConfigFixture`, and `sessionIdFor` helper already defined in Task 1.

- [ ] **Step 1: Add the exact failing Live Voice assertions**

Add a test named `keeps Live Voice compaction silent`. Its initial red run fails because the helper `verifyVoiceSilence` is not yet defined. Cache-prefix invariance is asserted by `runLongSession` in Task 1:

```typescript
  it('keeps Live Voice compaction silent', async () => {
    const harness = await openDeterministicPersistence();
    try {
      await verifyVoiceSilence(harness.persistence);
    } finally {
      await harness.close();
    }
  });
```

- [ ] **Step 1a: Confirm the Live Voice test is red**

Run in `backend/`:

```powershell
npm run test:e2e -- test/integration/compaction.native.e2e-spec.ts -t "Live Voice compaction silent"
```

Expected: FAIL at test-file compilation with `Cannot find name 'verifyVoiceSilence'`.

- [ ] **Step 2: Implement the bounded deterministic voice fixture**

Add the following helper. It copies the already-established `MemoryText` Live Voice fixture pattern: no audio provider, no TTS request, and no production voice-contract changes.

```typescript
async function verifyVoiceSilence(
  persistence: Awaited<ReturnType<typeof openDeterministicPersistence>>['persistence'],
): Promise<void> {
  const { fixture, bodies } = makeRuntime(persistence, { live: true });
  const spoken: string[] = [];
  const wireEvents: string[] = [];
  const seed = sessionIdFor(USER, null, 'p5-live-voice-seed');
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
```

- [ ] **Step 3: Run cross-layer voice, cache, and privacy assertions**

Run in `backend/`:

```powershell
npm run test:e2e -- test/integration/compaction.native.e2e-spec.ts
npm test -- test/context/tool-folding.spec.ts test/context/cutpoint.spec.ts test/context/compaction-prompt.spec.ts test/model/prompt-caching.spec.ts test/runtime/compaction-runtime.spec.ts test/runtime/compaction-hydration.spec.ts test/runtime/compaction-archive.spec.ts
```

Expected: PASS for the new deterministic voice-silence and cache-prefix assertions and the focused existing P3 suites. `runLongSession` checks stable static-prefix + summary bytes, `session_id`, and Anthropic `cache_control`; `verifyVoiceSilence` proves that an actual fixture compaction call emits no Live Voice `context-state` event and no summary text to speech. These tests do not claim a provider cache-hit rate, real audio quality, or live Calendar certification.

- [ ] **Step 4: Request the serialized commit**

Suggested message: `test(compaction): cover voice silence and cache-aligned prefixes`.

## Task 4: Align the behavior evaluation with P2's product-knowledge edit

**Files**

- Modify: `backend/test/evaluations/deterministic.behavior.spec.ts`
- Modify: `backend/test/evaluations/cases.json`
- Read only: `product_knowledge.md`

- [ ] **Step 1: Verify the new digest and write the red assertion**

Run from `backend/` to calculate the current product-knowledge digest without printing any secrets:

```powershell
node -e "const fs=require('node:fs');const c=require('node:crypto');console.log(c.createHash('sha256').update(fs.readFileSync('../product_knowledge.md','utf8')).digest('hex').toUpperCase())"
```

Expected for the currently inspected P2 copy: `568E38BF301C2765C6B7FB5C0D9D57B4EA2D4A94EA72884CA75E898F5B00B928`. Recalculate if P2's final copy differs.

The exact focused assertion replacing the obsolete pin is:

```typescript
expect(knowledge).toContain('full visible history remains scrollable');
```

Run before changing the eval pin:

```powershell
npm run test:behavior -- test/evaluations/deterministic.behavior.spec.ts -t "required deterministic proofs"
```

Expected: FAIL only at the outdated `does not silently remove history` product-copy assertion.

- [ ] **Step 2: Update only the product-knowledge pins**

In `backend/test/evaluations/deterministic.behavior.spec.ts`:

1. Replace `KNOWLEDGE_DIGEST` with the verified digest.
2. Replace only `knowledge.toContain('does not silently remove history')` with the exact assertion above.
3. Leave `SYSTEM_DIGEST`, instruction assertions, and all unrelated behavior pins unchanged.

In `backend/test/evaluations/cases.json`, change only `PK-01`:

```json
{
  "id": "PK-01",
  "category": "product-knowledge",
  "prompt": "What happens when an Aurvin chat reaches its context limit?",
  "deterministic": {
    "systemContains": "full visible history remains scrollable"
  },
  "live": {
    "includes": ["automatic in-session context compaction", "full visible history"],
    "forbidsClaiming": ["history was deleted"]
  }
}
```

Preserve `cases.json` version and all other case IDs/categories/content.

- [ ] **Step 3: Verify eval alignment and explicitly retain baseline failures**

Run in `backend/`:

```powershell
npm run test:behavior -- test/evaluations/deterministic.behavior.spec.ts
```

Expected: the knowledge digest, product-copy assertion, case catalogue, and non-system checks pass. The two known pre-existing failures involving `SYSTEM_DIGEST` and `<canvas_guidelines>` remain visible and are reported as baseline failures. Do not mark `test:behavior` fully passed and do not edit `backend/src/instructions/system.md`.

- [ ] **Step 4: Request the serialized commit**

Suggested message: `test(evaluations): align PK-01 and knowledge digest with compaction copy`.

## Task 5: Run full package verification and report each baseline independently

**Files**

- No additional code files. The evidence/report is written by the orchestrator in the workflow's final verification artifacts.

- [ ] **Step 1: Run the full backend checks from `backend/`**

```powershell
npm run build
npm run lint
npm test
npm run test:e2e
```

Expected: Record each actual exit code, pass count, failure count, and skip count. `npm test` failures already seen in assembly 503s, frozen latency caps, or similar are baseline/unrelated unless this work adds a regression. `npm run test:e2e` native skips without a URI are not native evidence; the always-on deterministic P5 fallback must pass.

- [ ] **Step 2: Run the full frontend checks from `frontend/`**

```powershell
npm run build
npm run lint
npm test
```

Expected: Record all results. If `src/api/testing/voice-fixtures.test.ts` fails on `bargeInSpeechWindows: 10` parity, cite the uncommitted backend contract/frontend protocol mismatch as pre-existing and leave both files unchanged.

- [ ] **Step 3: Re-run the owned focused evidence after any P5-only correction**

From `backend/`:

```powershell
npm run test:e2e -- test/integration/compaction.native.e2e-spec.ts
npm run test:behavior -- test/evaluations/deterministic.behavior.spec.ts
```

Expected: P5 fallback and all non-baseline eval pins pass. Any defect traced to P1–P4 implementation is reported and routed to its owning worker; do not patch unowned source from P5.

- [ ] **Step 4: Provide commit and evidence handoff**

Suggested final P5 commit message: `test(compaction): add integrated native and deterministic evidence`.

The orchestrator stages only `backend/test/integration/compaction.native.e2e-spec.ts`, `backend/test/evaluations/deterministic.behavior.spec.ts`, and `backend/test/evaluations/cases.json`. Include native URI availability without its value, explicit native skip/pass status, fallback results, all full-suite outcomes, the unchanged behavior-eval baseline, the known backend/frontend baseline failures, and limitations. Never describe a skipped native suite or skipped review as passed.
