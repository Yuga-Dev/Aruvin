# P4 — Runtime User Memory Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship session-pinned user memory, off-path learning, honest explicit updates, and safe Temporary Chat cleanup in the existing Text and Live Voice backend.

**Architecture:** The single-process runtime reads the pre-rendered RAM pin once at creation and once per actual compaction promotion; save and recovery paths carry that exact pin. One bounded passive scheduler sends only eligible finalized turn deltas to the existing per-user writer; native tool loops execute explicit updates after model dispatch and publish only confirmed receipts. `AppService` owns shared dependencies, configuration activation, and an indexed orphan sweep.

**Tech Stack:** TypeScript/NodeNext, NestJS/Express, LangGraph, MongoDB `RecordStore`, OpenRouter native SSE, Vitest and deterministic provider/storage fixtures.

---

## Work gate and contract reconciliation

- Inputs: [approved goal](goal.md) (`836ed14`), [research](research.md) (`1df0789`), [P4 ownership/dependencies](state.md#p4--runtime-integration-pinning-compaction-refresh-passive-scheduler-explicit-tool-voice--app-wiring), [P2 plan](plan2.md) (`8f12e72`), [P3 plan](plan3.md) (`310bc73`), and [repository rules](../../AGENTS.md). Do not start implementation until **both P2 and P3 workers** are complete with verified commits. Check the exact returned commits and current source; a changed signature is a gate to reconcile with that owner, not permission for a duplicate service or a cross-owner edit.
- Precedence: the approved idle timeout is **120,000 ms**, not the older 10-minute research sketch. The threshold is **eight eligible user turns**, not eight sequence numbers. Explicit-tool turns are **not excluded** from later passive learning. The operational watermark is `SessionRecord.memoryWatermarkSequence`; only the pin belongs in the versioned `AgentMemoryManifest`. The real route is `/api/sessions/:sessionId`.
- P1: `RuntimeConfigSnapshot.memoryModelId` is already resolved from `settings.memory` (`main | custom`); carry it, do not add a live `compaction` mode. `submitTurnRequestSchema` already accepts the optional boolean, `sessionSummarySchema` projects it, `CreateVoiceSessionRequest` already permits it, and `completed` / `VisibleMessage` already accept `memoryUpdated`. `contracts/runtime.ts` does **not** expose `ephemeral` on the internal command: widen locally in P4's `ports.ts`. Use `UPDATE_USER_MEMORY_NATIVE_TOOL` for Calendar definitions, `UPDATE_USER_MEMORY_TOOL_DEFINITION` for OpenRouter wire JSON, and `updateUserMemoryDecisionSchema` / `updateUserMemoryReceiptSchema` for their distinct boundaries. `SKILL_NATIVE_TOOLS` is the original base list.
- P2: `new MongoUserMemoryRepository(store, owner, maxDocumentBytes)`; `new UserMemoryService({ repository })`; `cachedMemory(u)` distinguishes **undefined** (unwarmed/error: deny tools/learning), **null** (confirmed absence: default enabled), and a frozen stored row. `cachedSnapshot(u)` returns a frozen pre-rendered pin or `null`; `warm(u)`, `evict(u)`, and `clearCache()` handle lifecycle. `new MemoryWriterService({ memory, currentConfig, putAccounting, fetcher, report })`; `applyInstruction(u, instruction, { source: 'tool', sessionId, turnId, signal })` and `synthesize(u, delta, { sessionId, turnId, signal })` return `{ changed, memory, changeSummary }`. `changed: true` means confirmed CAS, not merely provider success. `MemoryWriterConfig.memoryModelLimits` must attest the exact distinct custom model. `PersonalizationModule` options are `userMemoryService` and `memoryWriter`.
- P3: `buildReferenceManifest(..., activeSummaryRef, pinnedUserMemory?)`; preserve omitted legacy pin vs explicit `null`. `MongoSessions.hardPurgeSession(u,s)`, `listExpiredEphemeral(cutoffIso,limit)`, `advanceMemoryWatermark(u,s,sequence)`, `MongoMessages.markMemoryUpdated(u,s,messageId)`, and `EPHEMERAL_SESSION_MAX_AGE_MS` are the concrete primitives. Hard purge is owner-scoped, refuses busy durable markers, deletes the root last, and retains `kind: 'accounting'`. Do not recreate these operations in runtime code.
- Rechecked after the workers committed: P2 `5c94e63` … `79c0d06` and P3 `e994748` … `1593082`, completion records `6cbdc08` and `14f3596`. Their shipped runtime-facing signatures match the bindings above. Do not mistake the older pre-feature baseline failures documented in the state for green evidence.
- Latency boundary: prove **zero foreground application-storage commands and zero memory-writer LLM dispatches** from warmed admission/finalized speech through the first main-model POST on the production memory-first path; on an ordinary fresh turn also assert exactly one main POST. Cold authenticated owner/history selection may warm before a turn independent of chat mode. Old durable fallback already has ownership/checkpoint I/O and a context-limit fallback can run an existing compactor; this plan adds **no** memory reads/writes or writer-model calls before their first main-model POST. Do not weaken fences to make a measurement pass. Calendar mutations retain the existing essential pre-effect barrier.
- Freeze the prefix until compaction even after a composer save, clear, or toggle. Disabled/empty/unwarmed cache pins `null` at origin/refresh; a mid-session pause immediately stops tool availability/learning but does not rewrite an old pin. Dev strips the fixed prefix at the actual dispatch mode boundary, never mutates the pin, and never contributes a passive delta. Temporary Chat skips the pin lookup entirely. Live Voice in Temporary Chat remains **unapproved**; Task 10 implements gated propagation without enabling it.
- Retain guards on authenticating/revoking accounts, serialized session work, provider budgets, and Calendar effects. `user_memory` writes are local CAS writes; the explicit native call is bounded and waits for its receipt, but the main model's initial dispatch, passive scheduling, and unrelated saves do not wait for it.
- Run `npm` commands from `backend/`, Git commands from repo root. Use `.js` local import specifiers, required file headers, and deterministic fixtures only. Coordinate staging with the parent; stage named paths and never stage the pre-existing `speechSockets(signal)` hunks in `backend/src/app.service.ts`. Use `git add -p -- backend/src/app.service.ts` and inspect `git diff --cached -- backend/src/app.service.ts` on every overlapping commit. No modifications to the two known P5/P6 mirror specs, no `main.ts`/contracts/frontend edits, no reviewer/fixer.

## File map

| Owned paths | Responsibility |
| --- | --- |
| `backend/src/chat-runtime/ports.ts`, `backend/src/chat-runtime/durable-chat-runtime.ts`, `backend/src/chat-runtime/memory-text.ts` | Trusted pin acquisition, turn/session classification, passive scheduler hooks, explicit writer execution, scoped deletion fence. |
| `backend/src/chat-runtime/memory-first-foundation.ts`, `backend/src/persistence/memory-text-archive.ts`, `backend/src/chat-runtime/finalization.ts`, `backend/src/chat-runtime/reconciliation.ts` | Freeze origin/compaction pin in save evidence, preserve it at every rebuild, publish verified indicators without invalidating boundaries. |
| `backend/src/chat-runtime/user-memory-scheduler.ts`, `backend/src/chat-runtime/user-memory-scheduler.spec.ts` | Finite per-session passive batches, projection, watermark, retry and abort; deterministic timer tests. |
| `backend/src/model/web-native.ts`, `backend/src/model/calendar-validation.ts`, `backend/src/model/calendar-policy.ts`, `backend/src/model/calendar-adapter.ts`, `backend/src/model/calendar-repair.ts` | Exact opt-in tool sets, shared strict candidate inspection, bounded receipt continuation and provider policy. |
| `backend/src/chat-runtime/calendar-loop.ts`, `backend/src/context/calendar-context.ts` | Execute local memory command under turn authority, keep its paired evidence current-turn-only, preserve Calendar history/effect rules. |
| `backend/src/http/chat-http.controller.ts`, `backend/src/http/chat-http.service.ts`, `backend/src/http/validation.ts`, `backend/src/http/chat-stream.transport.ts` | Existing create/DELETE/SSE routes, creation-only mode, scoped temporary transport teardown. |
| `backend/src/voice/agent/agent-voice-adapter.ts`, `backend/src/voice/session/voice-session.service.ts` | Trusted fresh-conversation propagation, existing conversation ownership, bounded call teardown. |
| `backend/src/persistence/persistence.ts`, `backend/src/app.service.ts`, `backend/src/app.module.ts` | One persistence/service/writer owner, off-path model verification, private registration, shutdown and sweep. |
| `backend/test/runtime/user-memory-runtime.spec.ts` | Integrated admission, archive, compaction, tool, private transport, voice and lifecycle fixtures. |

### Task 1: Pin in RAM on admission; persist the same origin pin and mode

**Files:** Create `backend/test/runtime/user-memory-runtime.spec.ts`. Modify `backend/src/chat-runtime/{ports,durable-chat-runtime,memory-text,memory-first-foundation,calendar-loop,finalization,reconciliation}.ts` and `backend/src/persistence/memory-text-archive.ts`.

- [ ] **Write the failing tests.** Use the real ordered archive and driver-command fixture. Keep the memory cache double synchronous; `warm` is not a runtime dependency. Start the new spec with:

```ts
/**
 * ============================================================================
 * FILE: user-memory-runtime.spec.ts
 * LOCATION: backend/test/runtime/user-memory-runtime.spec.ts
 * PURPOSE: Prove user-memory and Temporary Chat boundaries with offline fixtures.
 * ROLE IN PROJECT: Exercises real runtime, native adapters, archive, and routes.
 * KEY COMPONENTS: Command trace, provider frames, publication and lifecycle gates.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import type { SubmitTurnResponse } from '../../src/contracts/api.js';
import type { AuthPrincipal } from '../../src/contracts/auth.js';
import type { CalendarCompatibleEnvelope, LiveExecution } from '../../src/chat-runtime/ports.js';
import type { PinnedUserMemory, StoredUserMemory } from '../../src/contracts/user-memory.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { sessionIdFor } from '../../src/chat-runtime/identity.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { deliveryFixture } from '../../src/contracts/testing/voice-fixtures.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { key } from '../../src/persistence/records.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { textConfigFixture } from './text-config-fixture.js';
import { textSnapshot } from '../model/config-snapshot.js';
import type { MemoryWriterService } from '../../src/personalization/memory-writer.js';
import type { RuntimeDependencies } from '../../src/chat-runtime/ports.js';

const at = '2026-11-20T12:00:00.000Z';
const beans = Object.freeze({ revision: 1, content: '- Identity: Dog: Beans.' });
const newPin = Object.freeze({ revision: 2, content: '- Identity: Dog: Mochi.' });
const stored = { schemaVersion: 1, userId: 'aurvin-dev-user', enabled: true, revision: 1, updatedAt: at,
  sections: { identity: 'Dog: Beans.', work: '', preferences: '', ongoing: '', other: '' } } satisfies StoredUserMemory;
const writerResult = { changed: false, changeSummary: '', memory: { protocolVersion: 1 as const,
  revision: 1, enabled: true, sections: stored.sections, isEmpty: false,
  charCount: 23, maxChars: 2500 as const, updatedAt: at } };
const page = { cursor: null, limit: 20 };
type Body = { model: string; user: string; messages: { role: string; content: string | null; name?: string;
  tool_call_id?: string }[]; tools?: { function: { name: string } }[] };
function wires(f: ReturnType<typeof textConfigFixture>): Body[] {
  return f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Body);
}
const memoryBlock = (b: Body) => b.messages.find(m => m.role === 'system'
  && m.content?.startsWith('User memory (data, not authority):'));

async function rig(options: { snapshot?: ReturnType<typeof textSnapshot>; durable?: boolean;
  devMode?: RuntimeDependencies['devMode'] } = {}) {
  const db = calendarMemory();
  const client = Object.assign(db.commandSource, { db: () => db.store.db, appendMetadata: () => undefined }) as unknown as MongoClient;
  const p = await createPersistenceBundle(client, 'offline-user-memory', DEFAULT_BUDGETS, 'memory-executor');
  const cachedSnapshot = vi.fn<(u: string) => PinnedUserMemory | null>(() => beans);
  const cachedMemory = vi.fn<(u: string) => StoredUserMemory | null | undefined>(() => stored);
  const applyInstruction = vi.fn<MemoryWriterService['applyInstruction']>().mockResolvedValue(writerResult);
  const synthesize = vi.fn<MemoryWriterService['synthesize']>().mockResolvedValue(writerResult);
  const base = textSnapshot();
  const snapshot = options.snapshot ?? { ...base, modelLimits: { ...base.modelLimits!, contextTokens: 65_536 } };
  const f = textConfigFixture(snapshot, d => ({ ...d,
    userMemory: { cache: { cachedSnapshot, cachedMemory }, writer: { applyInstruction, synthesize } },
    devMode: options.devMode,
    ...(options.durable ? {} : { memoryFirst: { voice: true, policy: PROPOSED_MEMORY_TEXT_POLICY } }),
  }), p);
  const flush = (s: string) => f.runtime.memoryFor(f.identity.userId)!.foundation.flushSession(s);
  const emit = vi.fn(async (_frame: CalendarCompatibleEnvelope) => undefined);
  const execute = (ids: SubmitTurnResponse, live?: LiveExecution, principal?: AuthPrincipal) => f.runtime.executeTurn({
    userId: f.identity.userId, ...ids, signal: new AbortController().signal, emit, emitCalendar: emit, live, principal,
  });
  return { f, p, db, cachedSnapshot, cachedMemory, applyInstruction, synthesize, snapshot, flush, execute, emit };
}

async function liveTurn(r: Awaited<ReturnType<typeof rig>>, keyId: string, existing?: string, heard?: string,
  content = 'Live input') {
  const { f, snapshot } = r;
  const voiceSessionId = 'memory-voice';
  const reserved = await f.runtime.reservations.acquire({ identity: f.identity, conversationId: existing ?? null,
    owner: { kind: 'live', voiceSessionId } });
  const sessionId = existing ?? sessionIdFor(f.identity.userId, null, keyId);
  const reservation = existing ? reserved : await f.runtime.reservations.bindConversation({
    identity: f.identity, reservationId: reserved.reservationId, conversationId: sessionId,
  });
  const cmd = { identity: f.identity, sessionId, content, idempotencyKey: keyId,
    reservation, configSnapshot: snapshot, freshConversation: !existing,
    voice: { voiceSessionId, socketEpoch: 1, providerTurnId: keyId } };
  let terminal: ((text: string) => Promise<void>) | undefined;
  const live: LiveExecution = {
    reservation, delta: async () => {}, finish: async () => {},
    start: async (a, write) => {
      const pending = { ...deliveryFixture(), userId: a.userId, sessionId, turnId: a.turnId,
        attemptId: a.attemptId, voiceSessionId, createdAt: a.createdAt, updatedAt: a.createdAt,
        responseId: key('voice-response', a.userId, sessionId, a.attemptId),
        status: 'pending' as const, textGenerated: '' };
      await write(pending);
      terminal = text => write({ ...pending, sequence: 2,
        status: heard !== undefined && heard !== text ? 'interrupted' : 'completed', textGenerated: text,
        textSpoken: heard ?? text, textRemaining: heard !== undefined ? text.slice(heard.length) : '',
      }, 1);
    },
    settle: async text => { if (!terminal) throw new Error('no voice delivery start'); await terminal(text); },
  };
  return { cmd, live, release: () => f.runtime.reservations.release({
    identity: f.identity, reservationId: reservation.reservationId,
  }) };
}

it('pins on the first accepted turn and freezes the same Text and Voice prefix through archive and restart', async () => {
  const r = await rig();
  const { f, db, cachedSnapshot, p } = r;
  try {
    const seen: number[] = [];
    const provider = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation((...args) => { seen.push(db.calls.length); return provider(...args); });
    const base = db.calls.length;
    const one = await f.submit('My dog has a new toy.');
    cachedSnapshot.mockReturnValue(newPin);
    await r.execute(one);
    expect(seen).toEqual([base]);
    expect(wires(f)).toHaveLength(1);
    expect(r.applyInstruction).not.toHaveBeenCalled();
    expect(r.synthesize).not.toHaveBeenCalled();
    expect(cachedSnapshot.mock.calls).toEqual([[f.identity.userId]]);
    expect(memoryBlock(wires(f)[0])?.content).toContain(beans.content);
    await r.flush(one.sessionId);
    expect((await p.memory.get(f.identity.userId, one.sessionId))?.pinnedUserMemory).toEqual(beans);
    await f.restart();
    await f.runtime.prepareSession(f.identity.userId, one.sessionId);
    const voice = await liveTurn(r, 'voice-pin-0001', one.sessionId);
    const voiceBase = db.calls.length;
    expect(await f.runtime.findLiveSubmission(voice.cmd)).toBeNull();
    const two = await f.runtime.submitLiveTurn(voice.cmd);
    await r.execute(two, voice.live);
    await voice.release();
    expect(seen[1]).toBe(voiceBase);
    expect(wires(f)).toHaveLength(2);
    const prefix = (b: Body) => JSON.stringify(b.messages.slice(0,
      b.messages.findIndex(m => m.content?.startsWith('Response mode:'))));
    expect(prefix(wires(f)[1])).toBe(prefix(wires(f)[0]));
    expect(cachedSnapshot).toHaveBeenCalledTimes(1);
    await r.flush(one.sessionId);
    expect((await p.memory.get(f.identity.userId, one.sessionId))?.pinnedUserMemory).toEqual(beans);
  } finally { await f.dispose(); }
});

it('pins a fresh Live Voice chat before storage and never repins a duplicate or a follow-up', async () => {
  const r = await rig();
  try {
    const voice = await liveTurn(r, 'voice-pin-0002');
    const before = r.db.calls.length;
    const ids = await r.f.runtime.submitLiveTurn(voice.cmd);
    r.cachedSnapshot.mockReturnValue(newPin);
    expect(await r.f.runtime.findLiveSubmission(voice.cmd)).toEqual(ids);
    const provider = r.f.fetcher.getMockImplementation()!;
    r.f.fetcher.mockImplementationOnce((...args) => {
      expect(r.db.calls).toHaveLength(before);
      return provider(...args);
    });
    await r.execute(ids, voice.live);
    await voice.release();
    expect(memoryBlock(wires(r.f)[0])?.content).toContain(beans.content);
    expect(r.cachedSnapshot).toHaveBeenCalledTimes(1);
  } finally { await r.f.dispose(); }
});

it('never reads a pin for Temporary Chat, and hides its RAM and archived rows', async () => {
  const r = await rig();
  const { f, p } = r;
  const c = { identity: f.identity, sessionId: null, content: 'Temporary input',
    idempotencyKey: 'temporary-memory-1', ephemeral: true };
  try {
    const ids = await f.runtime.submitTurn(c);
    await expect(f.runtime.submitTurn({ ...c, ephemeral: false }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    expect(f.runtime.memorySession(f.identity.userId, ids.sessionId)?.ephemeral).toBe(true);
    expect(f.runtime.overlaySessions(f.identity.userId, page, { items: [], nextCursor: null }).items).toEqual([]);
    await r.execute(ids);
    expect(memoryBlock(wires(f)[0])).toBeUndefined();
    expect(r.cachedSnapshot).not.toHaveBeenCalled();
    await r.flush(ids.sessionId);
    expect((await p.sessions.get(f.identity.userId, ids.sessionId))?.ephemeral).toBe(true);
    expect((await p.memory.get(f.identity.userId, ids.sessionId))?.pinnedUserMemory).toBeNull();
    expect((await p.sessions.list(f.identity.userId, page)).items).toEqual([]);
  } finally { await f.dispose(); }
});
```

- [ ] **Verify red.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "pins on|fresh Live Voice|never reads a pin"` — no memory prefix or Temporary Chat classification before the change; the real provider spy must run. Test the database count at dispatch, not after async archiving.
- [ ] **Implement origin capture and immutable propagation.** In `ports.ts` alias the imported contract and export a local `SubmitTurnCommand` intersection. `SubmitLiveTurn` continues to derive from it. Add optional composition; do not make older fixtures construct a user-memory service.

```ts
import type { SubmitTurnCommand as AgentSubmitTurn } from '../contracts/runtime.js';
import type { UserMemoryService } from '../personalization/user-memory.service.js';
import type { MemoryWriterService } from '../personalization/memory-writer.js';

export type SubmitTurnCommand = AgentSubmitTurn & { ephemeral?: boolean };
export type UserMemoryRuntime = {
  cache: Pick<UserMemoryService, 'cachedMemory' | 'cachedSnapshot'>;
  writer: Pick<MemoryWriterService, 'applyInstruction' | 'synthesize'>;
  trackWrite?: <T>(run: () => Promise<T>) => Promise<T>;
};
```

Inside `RuntimeDependencies`, add `userMemory?: UserMemoryRuntime;`. Update the `SubmitTurnCommand` imports in the two runtime files to use this local port without changing `AgentRuntime`. Use the existing config/identity and session-ID checks.

In `DurableChatRuntime`, `submitTurn`, `submitLiveTurn`, and `acceptNewTurn` must include `ephemeral: command.ephemeral` in their strict request parse. A supplied flag is legal only for `sessionId === null` or a trusted `freshConversation` with the deterministic new conversation ID. Keep the accepted boolean in the join hash (`body.ephemeral === true`) and validate it against the persisted classification on a duplicate creation. A follow-up or retry inherits the existing record, never writes a new value. Keep the attempt's existing content hash unchanged (it is checked against the accepted message).

In `MemoryText.submit`, derive effective `ephemeral` from `this.sessions.get(sessionId)?.session` for non-creation, and from `c.ephemeral === true` for creation. Carry it through `acceptanceSchema`, the foundation payload hash, `MemoryTurn`, and the new `Cold.session` (`...(ephemeral ? { ephemeral: true } : {})`). Pass a lazy **synchronous** second argument to `foundation.accept`, read only in the branch allocating a new session after idempotency/capacity checks:

```ts
// MemoryText.submit, after defining `creating` and deriving the effective boolean:
const readOriginPin = () => ephemeral ? null
  : this.d.userMemory?.cache.cachedSnapshot(identity.userId);
// Existing accept closure calls foundation.accept({ ...existingFields, ephemeral }, readOriginPin).
// In the duplicate branch pass the request's normalized flag for a creation replay;
// derive effective session mode for ordinary duplicate follow-ups (also compare against a
// rehydrated scoped row when stale). No lookup of a new pin on either replay path.
```

In `memory-first-foundation.ts`, add `ephemeral: z.boolean().optional()` to `acceptanceSchema`; add `pinnedUserMemory?: AgentMemoryManifest['pinnedUserMemory']` to `Session` and `TerminalEnvelope`. With a zero-I/O callback supplied only by runtime, keep fixture-created legacy sessions compatible:

```ts
// accept(value: MemoryAcceptance, originPin?: () => AgentMemoryManifest['pinnedUserMemory'])
// Include String(c.ephemeral === true) in the existing payloadHash key.
const pin = s ? s.pinnedUserMemory : c.ephemeral ? null : originPin?.();
// Add `pinnedUserMemory: pin` to the object literal allocating the new Session.
// context(): include this property in the manifest before schema validation.
...(s.pinnedUserMemory === undefined ? {} : { pinnedUserMemory: s.pinnedUserMemory }),
// terminalEnvelope(..., weatherView?, pinnedUserMemory?): include the optional field there too.
...(pinnedUserMemory === undefined ? {} : { pinnedUserMemory }),
```

Pass `pin` to `terminalEnvelope` for admission's `minimal`; in `complete` and `commitPromoted` use `s.pinnedUserMemory` (or the verified equal promoted manifest pin). In `hydrate` / `commitPromoted`, assign `entry.pinnedUserMemory = manifest.pinnedUserMemory` / `s.pinnedUserMemory = manifest.pinnedUserMemory`. Count the pin inside existing encoded-byte accounting; do not reserve unbounded extra capacity or recompute its content.

In `MemoryTextArchive.project`, set `ephemeral: true` on the initial session write only, then compare `(session.ephemeral === true) === (e.request.ephemeral === true)` before writing children. Initialize the new manifest from `e.pinnedUserMemory` when there is no prior manifest; otherwise require the prior pin to agree with the captured envelope (including an already-written same-version target on retry):

```ts
if (prior && !isDeepStrictEqual(prior.pinnedUserMemory, e.pinnedUserMemory))
  return { kind: 'failed', retryable: false };
const target = buildReferenceManifest(e.userId, e.sessionId, e.version,
  [...records.values()], this.assets, p.memory.budgets, activeSummaryRef, e.pinnedUserMemory);
```

Do not fetch memory from the archive; use the existing capacity checks and storage bounds with the new field included. `ensureMutationAccepted` / `promoteTurn` already use `cold.session` for initial durable creation; keep eager native writes limited to existing barriers. Exclude `ephemeral` in `MemoryText.overlaySessions` **before** merging/cursor slicing.

In durable `acceptNewTurn`, after the existing scoped session/idempotency checks, use the current session's classification or the normalized creation flag. A true creation pins synchronously once, before the existing context preparation:

```ts
const newSessionPin = existingSession ? undefined : body.ephemeral === true ? null
  : this.d.userMemory?.cache.cachedSnapshot(id.userId);
// Only the new sessionRecord gets ...(body.ephemeral === true ? { ephemeral: true } : {}).
// Append newSessionPin as the final optional argument to both loadHealthyContext
// and checkBoundary at this admission call; consume it only in their v0 bootstrap.
const manifest = buildReferenceManifest(u, s, 0, [], this.d.assets, p.memory.budgets,
  null, newSessionPin);
```

`checkBoundary`'s v0 bootstrap and `loadHealthyContext`'s fresh voice bootstrap must use the same value; when a valid manifest exists ignore the new argument. An archived/old session without a manifest must follow the existing recovery path, not acquire a new pin. Existing callers that omit it preserve legacy absence. Use Task 2's forwarding map now for ordinary same-session builders (without the new compaction support).

- [ ] **Verify green.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "pins on|fresh Live Voice|never reads a pin"`; `npm test -- test/performance/memory-first-voice.spec.ts test/performance/memory-first-text.spec.ts test/runtime/personalization-runtime.spec.ts`. Check that the warm voice assertion includes `findLiveSubmission` and that a held prior archive does not add a pre-model read. Build after propagating local command types.
- [ ] **Commit.**

```sh
git add -- backend/src/chat-runtime/ports.ts backend/src/chat-runtime/durable-chat-runtime.ts backend/src/chat-runtime/memory-text.ts backend/src/chat-runtime/memory-first-foundation.ts backend/src/chat-runtime/calendar-loop.ts backend/src/chat-runtime/finalization.ts backend/src/chat-runtime/reconciliation.ts backend/src/persistence/memory-text-archive.ts backend/test/runtime/user-memory-runtime.spec.ts
git commit -m "feat(user-memory): pin the session snapshot at turn admission"
```

### Task 2: Promote one refreshed pin; preserve it through archive, asset rebase, and recovery

**Files:** Modify `backend/src/chat-runtime/memory-text.ts`, `backend/src/chat-runtime/memory-first-foundation.ts`, `backend/src/persistence/memory-text-archive.ts`, and `backend/test/runtime/user-memory-runtime.spec.ts`. Review the Task 1 forwarding in `backend/src/chat-runtime/{durable-chat-runtime,calendar-loop,reconciliation,finalization}.ts`.

- [ ] **Write the failing tests.** Add `COMPACTION_SECTIONS` from `../../src/context/compaction-prompt.js`, and `graphConfig` and `boundaryFor` from `../../src/chat-runtime/finalization.js` and `../../src/agent/state.js`. Use distinct synthetic generation IDs:

```ts
function reply(id: string, content: string) {
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  return new Response(data({ id, model: 'fixture/model', choices: [{ index: 0, delta: { content }, finish_reason: null }] })
    + data({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 32, completion_tokens: 16, cost: 0.000064 } }) + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } });
}

it('refreshes the RAM pin at compaction promotion and archives that exact snapshot', async () => {
  const base = textSnapshot();
  const snapshot = { ...base, modelLimits: { ...base.modelLimits!, contextTokens: 65_536 },
    settings: { ...base.settings, compaction: { ...base.settings.compaction, enabled: true } } };
  const r = await rig({ snapshot });
  const { f, p, cachedSnapshot } = r;
  let s: string | null = null;
  const summaryEntered = Promise.withResolvers<void>();
  const summaryRelease = Promise.withResolvers<void>();
  let archiveGate: ReturnType<typeof r.db.pauseNextUpdate> | undefined;
  const saveSummary = p.metadata.putCompactionSummary.bind(p.metadata);
  vi.spyOn(p.metadata, 'putCompactionSummary').mockImplementationOnce(async value => {
    await saveSummary(value);
    archiveGate = r.db.pauseNextUpdate();
  });
  const provider = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (...args) => {
    if (!String(args[1]?.body).includes('Compact the preceding conversation data')) return provider(...args);
    summaryEntered.resolve();
    await summaryRelease.promise;
    return reply('memory-compaction', '<summary>\n' + COMPACTION_SECTIONS.map((label, i) =>
      `## ${i + 1}. ${label}\nA retained fixture fact.`).join('\n\n') + '\n</summary>');
  });
  try {
    for (let i = 0; i < 5; i++) {
      const ids = await f.submit(`Turn ${i}`, s); s = ids.sessionId;
      await r.execute(ids);
    }
    await r.flush(s!);
    const m = f.runtime.memoryFor(f.identity.userId)!;
    m['scheduleCompactionIfNeeded'](s!, snapshot, true);
    await summaryEntered.promise;
    cachedSnapshot.mockReturnValue(newPin);
    summaryRelease.resolve();
    await vi.waitFor(() => expect(cachedSnapshot).toHaveBeenCalledTimes(2));
    // Stall the compaction publication itself, not the compactor's accounting.
    await vi.waitFor(() => expect(archiveGate).toBeDefined());
    await archiveGate!.started;
    cachedSnapshot.mockReturnValue(null);
    const next = await f.submit('After compaction', s);
    await r.execute(next);
    expect(memoryBlock(wires(f).at(-1)!)?.content).toContain(newPin.content);
    archiveGate!.resume();
    await r.flush(next.sessionId);
    const persisted = await p.memory.get(f.identity.userId, next.sessionId);
    expect(persisted).toMatchObject({ activeSummaryRef: expect.any(Object), pinnedUserMemory: newPin });
    const row = (await p.sessions.get(f.identity.userId, next.sessionId))!;
    const graph = await f.runtime.graph({ userId: row.userId, sessionId: row.sessionId,
      ownerId: p.owner.executorId, generation: row.execution.generation, leaseExpiresAt: f.runtime.now() });
    expect((await graph.getState(graphConfig(row.userId, row.sessionId))).values.boundary).toEqual(boundaryFor(persisted!));
  } finally { summaryRelease.resolve(); archiveGate?.resume(); await f.dispose(); }
});

it('preserves the pin on durable completion, replay, and a later interrupted attempt', async () => {
  const r = await rig({ durable: true });
  try {
    const a = await r.f.submit('Durable input');
    r.cachedSnapshot.mockReturnValue(newPin);
    await r.execute(a);
    await r.execute(a);
    const b = await r.f.submit('Later interrupted', a.sessionId);
    await r.f.runtime.cancelTurn({ identity: r.f.identity, ...b });
    expect((await r.p.memory.get(r.f.identity.userId, a.sessionId))?.pinnedUserMemory).toEqual(beans);
    expect(r.cachedSnapshot).toHaveBeenCalledTimes(1);
  } finally { await r.f.dispose(); }
});
```

All earlier turns are flushed before forcing compaction. The gate is armed after the observed summary write, independently of the compactor's accounting and scheduler.

- [ ] **Verify red.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "refreshes the RAM pin|durable completion"` — absent refresh/rebuilt manifest disagreement (the durable test can already be green for forwarding done in Task 1; record it as regression coverage).
- [ ] **Implement compaction and pin-preserving builders.** In `MemoryText.tryPromotePendingCompaction`, after checking promotion is possible and before changing the base, compute exactly once `const pin = cold.session.ephemeral ? null : this.d.userMemory?.cache.cachedSnapshot(this.ownerId);`. Pass it to `promoteCompaction(..., pending.checkpoint, pin)` / `rebaseActiveTurnForCompaction(..., pending.checkpoint, pin)`. No new wait, repository or writer call. Keep optional params for existing fixture callers:

```ts
// applyCompaction(..., checkpoint, rebaseTurn?: MemoryTurn,
//                 refresh?: AgentMemoryManifest['pinnedUserMemory'])
const pin = refresh === undefined ? s.pinnedUserMemory : refresh;
const pinField = pin === undefined ? {} : { pinnedUserMemory: pin };
// Spread pinField into the new manifest and the immutable CompactionEnvelope.
// After validation: s.pinnedUserMemory = pin; then install base and queue as before.
```

In `evictSettledForCapacity` copy `s.pinnedUserMemory` into the reconstructed base. In `MemoryTextArchive.projectCompaction`, append `e.pinnedUserMemory === undefined ? prior?.pinnedUserMemory : e.pinnedUserMemory` to the target builder, never replace a deliberate `null`. On the existing same-version published fast path verify the persisted pin against the captured pin when supplied. Charge target bytes before writing and keep `boundaryFor(target)` and the publication CAS paired. A retry consumes the captured envelope, not the live cache.

Apply this exhaustive forwarding rule to the existing builders (not to their validation schemas):

```ts
// Given a same-session base m, preserve summary and pin alongside the original args:
buildReferenceManifest(u, s, version, records, assets, budgets,
  m.activeSummaryRef, m.pinnedUserMemory);
// Where m can be missing during interruption:
buildReferenceManifest(u, s, current?.contextVersion ?? 0, targetRecords, assets, budgets,
  current?.activeSummaryRef ?? null, current?.pinnedUserMemory);
```

| Exact anchor | Base whose fields must be carried |
| --- | --- |
| `durable-chat-runtime.ts`: `checkBoundary` expected, saved-assets and target; `loadHealthyContext` expected | `manifest` / `current`; only the v0 creation branches in Task 1 can use RAM. |
| `durable-chat-runtime.ts`: `generateTurn` reusable/source equality and final target; `rebaseSession` verified/next | `manifest` / `old`. Keep the optional field absent for legacy. |
| `memory-text.ts`: both generated-result `target:` calls | `source.manifest`, including after active compaction rebase. |
| `calendar-loop.ts`: `seal` target | `this.ctx.manifest`, including `activeSummaryRef` which the current builder drops. |
| `finalization.ts`: `checkedResult` expected target | `current.pinnedUserMemory`, compared with `r.target` alongside `activeSummaryRef`. In recovery `current` may already equal the target; both have the same pin. |
| `reconciliation.ts`: `interruptAttempt` candidate; `finishRebase` verified | `current` / `intent.target`; keep only post-summary tail records with `sequence > activeSummaryRef.sourceRange.toSequence` when rebuilding from `acceptedHistory`. |

In `finishRebase`, when `current` still names the base, require exact old/target pin equality (undefined is allowed; do not coerce to `null`). Any helper taking broad `acceptedHistory` and a summary must filter compacted records before building, while retaining the current eligible input. Never clear a pin to force a hash comparison to pass.

- [ ] **Verify green.** `npm test -- test/runtime/user-memory-runtime.spec.ts test/runtime/compaction-runtime.spec.ts test/runtime/compaction-foundation.spec.ts test/runtime/compaction-archive.spec.ts test/runtime/compaction-hydration.spec.ts test/runtime/asset-upgrade.spec.ts test/performance/memory-text-archive.spec.ts`. Verify that restart/asset rebase never consults fresh memory for an old pin. Run `rg -n "buildReferenceManifest\\(" src/chat-runtime src/persistence/memory-text-archive.ts` to account for every runtime/archive caller.
- [ ] **Commit.**

```sh
git add -- backend/src/chat-runtime/memory-text.ts backend/src/chat-runtime/memory-first-foundation.ts backend/src/persistence/memory-text-archive.ts backend/test/runtime/user-memory-runtime.spec.ts
git commit -m "feat(user-memory): preserve and refresh versioned session pins"
```

### Task 3: Implement the bounded passive scheduler and its delta projection

**Files:** Create `backend/src/chat-runtime/user-memory-scheduler.ts` and `backend/src/chat-runtime/user-memory-scheduler.spec.ts`.

- [ ] **Write the failing timer tests.**

```ts
/**
 * ============================================================================
 * FILE: user-memory-scheduler.spec.ts
 * LOCATION: backend/src/chat-runtime/user-memory-scheduler.spec.ts
 * PURPOSE: Verify passive memory batching and lifecycle with a virtual clock.
 * ROLE IN PROJECT: Proves no-op, retry, privacy, and cancellation boundaries.
 * KEY COMPONENTS: Idle debounce, eight-turn/compaction wake, and held writer.
 * ============================================================================
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UserMemoryScheduler, type PassiveTurn } from './user-memory-scheduler.js';

const idle = 120_000;
const u = 'memory-user';
const s = 'session-1';
function turn(n: number, fields: Partial<PassiveTurn> = {}): PassiveTurn {
  return { turnId: `t${n}`, messageId: `m${n}`, version: n, sequence: n * 3 - 2,
    userText: `User ${n}`, assistantText: `Assistant ${n}`, ...fields };
}
function fixture() {
  const synthesize = vi.fn<ConstructorParameters<typeof UserMemoryScheduler>[0]['synthesize']>()
    .mockResolvedValue({ changed: false });
  const publish = vi.fn<ConstructorParameters<typeof UserMemoryScheduler>[0]['publish']>()
    .mockResolvedValue(undefined);
  const enabled = vi.fn(() => true);
  const report = vi.fn();
  const scheduler = new UserMemoryScheduler({ enabled, synthesize, publish, report });
  return { scheduler, synthesize, publish, enabled, report };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('debounces for two minutes and advances only the finalized assistant sequence on no change', async () => {
  const f = fixture();
  f.scheduler.completed(u, s, -1, turn(1));
  await vi.advanceTimersByTimeAsync(idle - 1);
  f.scheduler.completed(u, s, -1, turn(2));
  await vi.advanceTimersByTimeAsync(idle - 1);
  expect(f.synthesize).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize).toHaveBeenCalledExactlyOnceWith(u, [
    { role: 'user', content: 'User 1' }, { role: 'assistant', content: 'Assistant 1' },
    { role: 'user', content: 'User 2' }, { role: 'assistant', content: 'Assistant 2' },
  ], expect.objectContaining({ sessionId: s, turnId: 't2' }));
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(u, s, turn(2), false, expect.any(AbortSignal));
  f.scheduler.completed(u, s, 4, turn(2)); // persisted watermark excludes replay
  await vi.advanceTimersByTimeAsync(idle);
  expect(f.synthesize).toHaveBeenCalledTimes(1);
});

it('kicks off only at eight user turns, and compaction can wake a shorter batch asynchronously', async () => {
  const f = fixture();
  for (let i = 1; i <= 7; i++) f.scheduler.completed(u, s, 0, turn(i));
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize).not.toHaveBeenCalled();
  f.scheduler.completed(u, s, 0, turn(8));
  expect(f.synthesize).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize.mock.calls[0]?.[1]).toHaveLength(16);
  f.scheduler.completed(u, s, turn(8).sequence, turn(9));
  f.scheduler.compacting(u, s);
  expect(f.synthesize).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize.mock.calls[1]?.[1]).toEqual([
    { role: 'user', content: 'User 9' }, { role: 'assistant', content: 'Assistant 9' },
  ]);
});

it('projects only safe full user text and 400 code points of assistant prose', async () => {
  const f = fixture();
  f.scheduler.completed(u, s, 0, turn(1, {
    userText: 'My whole response should remain intact. '.repeat(21).trim(),
    assistantText: '```ts\nPRIVATE_CODE\n```\n' + '😀'.repeat(405),
  }));
  f.scheduler.completed(u, s, 0, turn(2, { assistantText: '' })); // unknown/no voice heard
  f.scheduler.completed(u, s, 0, turn(3, {
    userText: 'sk-or-v1-fixture', assistantText: 'Never pair an answer with a secret.',
  }));
  f.scheduler.compacting(u, s);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize.mock.calls[0]?.[1]).toEqual([
    { role: 'user', content: 'My whole response should remain intact. '.repeat(21).trim() },
    { role: 'assistant', content: '😀'.repeat(400) },
    { role: 'user', content: 'User 2' },
  ]);
});

it('caps two failed jobs until a new eligible turn and never advances on synthesis failure', async () => {
  const f = fixture();
  f.synthesize.mockRejectedValueOnce(new Error('PRIVATE_WRITER_PAYLOAD'))
    .mockRejectedValueOnce(new Error('PRIVATE_WRITER_PAYLOAD'));
  f.scheduler.completed(u, s, 0, turn(1));
  await vi.advanceTimersByTimeAsync(idle * 3);
  f.scheduler.compacting(u, s);
  await vi.advanceTimersByTimeAsync(idle);
  expect(f.synthesize).toHaveBeenCalledTimes(2);
  expect(f.publish).not.toHaveBeenCalled();
  expect(JSON.stringify(f.report.mock.calls)).not.toContain('PRIVATE_WRITER_PAYLOAD');
  f.scheduler.completed(u, s, 0, turn(2));
  f.scheduler.compacting(u, s);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.synthesize).toHaveBeenCalledTimes(3);
  expect(f.publish.mock.calls[0]?.[2]).toEqual(turn(1));
  await vi.advanceTimersByTimeAsync(idle);
  expect(f.publish.mock.calls[1]?.[2]).toEqual(turn(2));
});

it('retries marker/watermark publication without rerunning a confirmed writer', async () => {
  const f = fixture();
  f.synthesize.mockResolvedValue({ changed: true });
  f.publish.mockRejectedValueOnce(new Error('unconfirmed archive'));
  f.scheduler.completed(u, s, 0, turn(1));
  await vi.advanceTimersByTimeAsync(idle * 2);
  expect(f.synthesize).toHaveBeenCalledTimes(1);
  expect(f.publish.mock.calls.map(call => call.slice(0, 4))).toEqual([
    [u, s, turn(1), true], [u, s, turn(1), true],
  ]);
});

it('cancels idle timers on close and revokes running work without late projection', async () => {
  const f = fixture();
  const held = Promise.withResolvers<{ changed: boolean }>();
  f.synthesize.mockReturnValueOnce(held.promise);
  f.scheduler.completed(u, s, 0, turn(1));
  f.scheduler.completed('other', s, 0, turn(1));
  f.scheduler.compacting(u, s);
  await vi.advanceTimersByTimeAsync(1);
  const signal = f.synthesize.mock.calls[0]![2].signal!;
  f.scheduler.deactivate(u);
  expect(signal.aborted).toBe(true);
  held.resolve({ changed: true });
  f.scheduler.close();
  await vi.advanceTimersByTimeAsync(idle * 3);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.synthesize).toHaveBeenCalledTimes(1);
});

it('does not start an idle synthesis once memory is disabled', async () => {
  const f = fixture();
  f.scheduler.completed(u, s, 0, turn(1));
  f.enabled.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(idle);
  expect(f.synthesize).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});
```

- [ ] **Verify red.** `npm test -- src/chat-runtime/user-memory-scheduler.spec.ts` — module does not exist.
- [ ] **Implement the scheduler.** It owns one bounded queue/timer per session, not a new writer queue per user. P2 owns per-user serialization and CAS. Use the existing text scrubber off-path, with no artifact sink. Treat history without trusted turn-mode provenance (pre-feature/previous process) as ineligible, rather than mining an archive that may contain Dev turns. No startup replay of private transcript or pending synthesis. A new turn after restart starts from the durable watermark and only known eligible evidence. Add to `backend/src/chat-runtime/user-memory-scheduler.ts`:

```ts
/**
 * ============================================================================
 * FILE: user-memory-scheduler.ts
 * LOCATION: backend/src/chat-runtime/user-memory-scheduler.ts
 * PURPOSE: Batch eligible finalized chat turns off the model and transport paths.
 * ROLE IN PROJECT: Coordinates the shared writer and independent session watermark.
 * KEY COMPONENTS: Bounded per-session queue, idle timer, projection and cancellation.
 * ============================================================================
 */
import { hasDisallowedControlChars, hasSecretPattern } from '../contracts/personalization.js';
import { SpeechProse } from '../voice/agent/speech-prose.js';
import { UserMemoryFault } from '../personalization/errors.js';
import type { MemoryWriterDeltaMessage, MemoryWriterScope } from '../personalization/memory-writer.js';
import { diagnose, type DiagnosticSink } from './ports.js';

export const USER_MEMORY_IDLE_MS = 120_000;
const BATCH = 8;
const MAX_SESSIONS = 32;
const MAX_PENDING_TURNS = 24;
export type PassiveTurn = { turnId: string; messageId: string; sequence: number; version: number;
  userText: string; assistantText: string };
type Slot = { userId: string; sessionId: string; queue: PassiveTurn[]; seen: number; idleAt: number;
  failures: number; running: boolean; overflowed: boolean; urgent: boolean; wake?: ReturnType<typeof setTimeout>;
  abort: AbortController; batch?: { turns: PassiveTurn[]; changed?: boolean; mark?: PassiveTurn } };
type Options = {
  enabled(userId: string): boolean;
  synthesize(userId: string, delta: readonly MemoryWriterDeltaMessage[], scope: MemoryWriterScope):
    Promise<{ changed: boolean }>;
  publish(userId: string, sessionId: string, last: PassiveTurn, changed: boolean,
    signal: AbortSignal, mark?: PassiveTurn): Promise<void>;
  report?: DiagnosticSink;
};

const safe = (text: string) => !hasDisallowedControlChars(text) && !hasSecretPattern(text);
function project(turn: PassiveTurn): MemoryWriterDeltaMessage[] {
  if (!turn.userText.trim() || !safe(turn.userText)) return [];
  const result: MemoryWriterDeltaMessage[] = [{ role: 'user', content: turn.userText }];
  if (!turn.assistantText || !safe(turn.assistantText)) return result;
  const prose = new SpeechProse(turn.assistantText.length, undefined, () => false);
  const assistant = Array.from((prose.push(turn.assistantText) + prose.finish()).trim()).slice(0, 400).join('');
  if (assistant && safe(assistant)) result.push({ role: 'assistant', content: assistant });
  return result;
}

export class UserMemoryScheduler {
  private readonly slots = new Map<string, Slot>();
  private closed = false;
  constructor(private readonly options: Options) {}
  private key(u: string, s: string) { return JSON.stringify([u, s]); }

  // Callers supply only trusted, successful non-Dev, non-temporary turns.
  completed(u: string, s: string, watermark: number, turn: PassiveTurn): void {
    if (this.closed) return;
    if (!this.options.enabled(u)) { this.cancel(u, s); return; }
    const key = this.key(u, s);
    let slot = this.slots.get(key);
    if (!slot && turn.sequence > watermark) {
      if (this.slots.size >= MAX_SESSIONS) {
        diagnose(this.options.report, { stage: 'runtime-error', state: 'skipped', code: 'CONCURRENCY_LIMIT' });
        return;
      }
      slot = { userId: u, sessionId: s, queue: [], seen: watermark, idleAt: 0, failures: 0,
        running: false, overflowed: false, urgent: false, abort: new AbortController() };
      this.slots.set(key, slot);
    }
    if (!slot || turn.sequence <= Math.max(slot.seen, watermark)) return;
    slot.seen = turn.sequence;
    slot.idleAt = Date.now() + USER_MEMORY_IDLE_MS;
    if (slot.failures >= 2) slot.failures = 0;
    // ponytail: bounded per-process best effort; do not skip over a dropped
    // range in the same process. A durable eligible-turn index would permit catch-up.
    if (slot.overflowed || slot.queue.length >= MAX_PENDING_TURNS) {
      if (!slot.overflowed)
        diagnose(this.options.report, { stage: 'runtime-error', state: 'skipped', code: 'STORAGE_BUDGET_EXCEEDED' });
      slot.overflowed = true;
      if (!slot.wake && slot.queue.length) this.arm(slot, USER_MEMORY_IDLE_MS);
      return;
    }
    slot.queue.push(turn);
    this.arm(slot, slot.urgent || slot.queue.length >= BATCH ? 0 : USER_MEMORY_IDLE_MS);
  }

  compacting(u: string, s: string): void {
    const slot = this.slots.get(this.key(u, s));
    if (slot?.queue.length) { slot.urgent = true; this.arm(slot, 0); }
  }

  cancel(u: string, s: string): void {
    const key = this.key(u, s), slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    clearTimeout(slot.wake);
    slot.abort.abort();
  }
  deactivate(u: string): void {
    for (const slot of this.slots.values()) if (slot.userId === u) this.cancel(u, slot.sessionId);
  }
  close(): void {
    this.closed = true;
    for (const slot of this.slots.values()) this.cancel(slot.userId, slot.sessionId);
  }

  private arm(slot: Slot, delay: number): void {
    if (this.closed || slot.abort.signal.aborted || slot.running || slot.failures >= 2) return;
    clearTimeout(slot.wake);
    slot.wake = setTimeout(() => { slot.wake = undefined; void this.run(slot); }, delay);
    slot.wake.unref?.();
  }
  private async run(slot: Slot): Promise<void> {
    const { userId, sessionId, abort: { signal } } = slot;
    if (signal.aborted || slot.running || slot.failures >= 2 || !slot.queue.length) return;
    if (!this.options.enabled(userId)) { this.cancel(userId, sessionId); return; }
    slot.running = true;
    slot.urgent = false;
    const batch = slot.batch ??= { turns: slot.queue.slice(0, BATCH) };
    const last = batch.turns.at(-1)!;
    try {
      if (batch.changed === undefined) {
        const projected = batch.turns.map(turn => ({ turn, messages: project(turn) }));
        const usable = projected.filter(row => row.messages.length > 0);
        const delta = usable.flatMap(row => row.messages);
        batch.mark = usable.at(-1)?.turn;
        batch.changed = delta.length > 0 &&
          (await this.options.synthesize(userId, delta, { sessionId, turnId: batch.mark!.turnId, signal })).changed;
      }
      if (signal.aborted) return;
      if (!this.options.enabled(userId)) { this.cancel(userId, sessionId); return; }
      if (batch.changed && batch.mark && batch.mark !== last)
        await this.options.publish(userId, sessionId, last, true, signal, batch.mark);
      else await this.options.publish(userId, sessionId, last, batch.changed, signal);
      if (signal.aborted) return;
      slot.queue.splice(0, batch.turns.length);
      slot.batch = undefined;
      slot.failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof UserMemoryFault && error.code === 'MEMORY_DISABLED') {
        this.cancel(userId, sessionId); return;
      }
      slot.failures++;
      diagnose(this.options.report, { stage: 'runtime-error', state: 'error',
        code: batch.changed === undefined ? 'PROVIDER_ERROR' : 'PERSISTENCE_ERROR' });
    } finally {
      slot.running = false;
      if (!signal.aborted && slot.queue.length)
        this.arm(slot, slot.failures ? USER_MEMORY_IDLE_MS : (slot.urgent || slot.queue.length >= BATCH)
          ? 0 : Math.max(0, slot.idleAt - Date.now()));
      else if (!signal.aborted && !slot.overflowed) this.slots.delete(this.key(userId, sessionId));
    }
  }
}
```

The writer's own message/model ceilings are authoritative. When the caller can prove a batch would exceed them, send only the oldest **whole turns**, never a truncated user message. P2 currently unifies budget/provider failure as `MEMORY_WRITER_UNAVAILABLE`; do not shrink and retry after that fault because it does not prove the call was unsent. Leave the watermark unchanged and apply the failure cap. Unsafe pairs omitted locally may advance past their sequence as examined, but never earn the indicator; a successful batch marks the last assistant whose user text was actually sent.

- [ ] **Verify green.** `npm test -- src/chat-runtime/user-memory-scheduler.spec.ts`; `npm run build`. Confirm the added disabled-cache case, and have a new completion during an in-flight batch exercise the original last-completed idle deadline.
- [ ] **Commit.**

```sh
git add -- backend/src/chat-runtime/user-memory-scheduler.ts backend/src/chat-runtime/user-memory-scheduler.spec.ts
git commit -m "feat(user-memory): schedule bounded passive turn batches"
```

### Task 4: Feed finalized turns, kick off compaction learning, and publish markers off path

**Files:** Modify `backend/src/chat-runtime/{durable-chat-runtime,memory-text,memory-first-foundation}.ts`, `backend/src/persistence/memory-text-archive.ts`, `backend/src/chat-runtime/finalization.ts`, and `backend/test/runtime/user-memory-runtime.spec.ts`.

- [ ] **Write the failing integration tests.** Use the `rig` helpers above; virtualize timer APIs but not `Date` or the provider deadline.

```ts
it('passes heard Live Voice text to passive memory and marks only after confirmed change', async () => {
  const r = await rig();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const voice = await liveTurn(r, 'voice-passive-1', undefined, 'Hello');
    const ids = await r.f.runtime.submitLiveTurn(voice.cmd);
    await r.execute(ids, voice.live);
    await voice.release();
    await r.flush(ids.sessionId);
    const u = r.f.identity.userId, s = ids.sessionId;
    expect(r.synthesize).not.toHaveBeenCalled();
    expect(r.emit.mock.calls.find(([f]) => f.event.type === 'completed')?.[0].event)
      .not.toHaveProperty('memoryUpdated');
    const written = Promise.withResolvers<void>();
    const advance = r.p.sessions.advanceMemoryWatermark.bind(r.p.sessions);
    const watermark = vi.spyOn(r.p.sessions, 'advanceMemoryWatermark').mockImplementation(async (...args) => {
      await advance(...args); written.resolve();
    });
    r.synthesize.mockResolvedValueOnce({ ...writerResult, changed: true, changeSummary: 'Saved a detail' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.synthesize.mock.calls[0]?.[1]).toEqual([
      { role: 'user', content: 'Live input' }, { role: 'assistant', content: 'Hello' },
    ]);
    await written.promise;
    expect(watermark).toHaveBeenCalledWith(u, s, 1);
    expect((await r.p.sessions.get(u, s))?.memoryWatermarkSequence).toBe(1);
    expect(r.f.runtime.memoryMessages(u, s, page)?.items.at(-1)?.memoryUpdated).toBe(true);
    expect((await r.p.messages.list(u, s, page)).items.at(-1)?.memoryUpdated).toBe(true);
    expect((await r.p.memory.get(u, s))?.contextVersion).toBe(1);
  } finally { vi.useRealTimers(); await r.f.dispose(); }
});

it('compaction refresh and follow-up complete while passive synthesis is still held', async () => {
  const base = textSnapshot();
  const snapshot = { ...base, modelLimits: { ...base.modelLimits!, contextTokens: 65_536 },
    settings: { ...base.settings, compaction: { ...base.settings.compaction, enabled: true } } };
  const r = await rig({ snapshot });
  const provider = r.f.fetcher.getMockImplementation()!;
  r.f.fetcher.mockImplementation((...args) =>
    String(args[1]?.body).includes('Compact the preceding conversation data')
      ? Promise.resolve(reply('async-summary', '<summary>\n' + COMPACTION_SECTIONS.map((label, i) =>
        `## ${i + 1}. ${label}\nRetained fact.`).join('\n\n') + '\n</summary>'))
      : provider(...args));
  const held = Promise.withResolvers<typeof writerResult>();
  r.synthesize.mockReturnValueOnce(held.promise);
  try {
    let s: string | null = null;
    for (let i = 0; i < 5; i++) {
      const ids = await r.f.submit(`Input ${i}`, s); s = ids.sessionId;
      await r.execute(ids);
    }
    const u = r.f.identity.userId, owner = r.f.runtime.memoryFor(u)!;
    await r.flush(s!);
    r.cachedSnapshot.mockReturnValue(newPin);
    owner['scheduleCompactionIfNeeded'](s!, snapshot, true);
    await vi.waitFor(() => expect(r.synthesize).toHaveBeenCalledTimes(1));
    await r.flush(s!); // The summary publishes even while the writer is unresolved.
    const next = await r.f.submit('Continue immediately', s);
    await r.execute(next);
    expect(memoryBlock(wires(r.f).at(-1)!)?.content).toContain(newPin.content);
    expect(r.synthesize.mock.calls[0]?.[1][0]).toEqual({ role: 'user', content: 'Input 0' });
    expect((await r.p.sessions.get(u, s!))?.memoryWatermarkSequence).toBeUndefined();
  } finally { held.resolve(writerResult); await r.f.dispose(); }
});

it('a passive no-op advances the session watermark without touching user memory or marking an assistant', async () => {
  const r = await rig();
  const mark = vi.spyOn(r.p.messages, 'markMemoryUpdated');
  const advance = vi.spyOn(r.p.sessions, 'advanceMemoryWatermark');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const ids = await r.f.submit('A made-up fixture fact');
    await r.execute(ids); await r.flush(ids.sessionId);
    const before = r.db.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    const u = r.f.identity.userId;
    expect(advance).toHaveBeenCalledWith(u, ids.sessionId, 1);
    expect(mark).not.toHaveBeenCalled();
    expect(r.db.calls.slice(before).some(call => call.collection === 'user_memory' || call.collection === 'agent-memory'))
      .toBe(false);
    expect(r.f.runtime.memorySession(u, ids.sessionId)?.memoryWatermarkSequence).toBe(1);
  } finally { vi.useRealTimers(); await r.f.dispose(); }
});
```

- [ ] **Verify red.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "heard Live Voice|passive synthesis is still held|passive no-op"` — neither synthesis nor passive publication is connected.
- [ ] **Wire finalized evidence and projections.** In `DurableChatRuntime`, construct the optional scheduler once, after `work`/`reservations`; share it with its `MemoryText` owners. Use `cachedMemory` gating (no coercion of `undefined` to default-enabled):

```ts
// Public to MemoryText, not an HTTP method.
memoryEnabled(u: string): boolean {
  const memory = this.d.userMemory?.cache.cachedMemory(u);
  return memory === null || memory?.enabled === true;
}
// readonly userMemoryScheduler?: UserMemoryScheduler; initialize only when d.userMemory exists.
this.userMemoryScheduler = new UserMemoryScheduler({
  enabled: u => this.memoryEnabled(u),
  synthesize: (u, delta, scope) => d.userMemory!.writer.synthesize(u, delta, scope),
  publish: (u, s, last, changed, signal, mark = last) => {
    const write = async () => {
      signal.throwIfAborted();
      const owner = this.memoryFor(u);
      if (owner?.owns(s) && last.version !== 0)
        await owner.foundation.flushSession(s, last.version);
      await d.persistence.owner.assertExecutor();
      signal.throwIfAborted();
      if (changed) {
        await d.persistence.messages.markMemoryUpdated(u, s, mark.messageId);
        if (!signal.aborted) owner?.projectPassiveMarker(s, mark.messageId);
      }
      signal.throwIfAborted();
      await d.persistence.sessions.advanceMemoryWatermark(u, s, last.sequence);
      if (!signal.aborted) owner?.projectMemoryWatermark(s, last.sequence);
    };
    return d.userMemory!.trackWrite ? d.userMemory!.trackWrite(write) : write();
  },
  report: d.diagnostics?.emit,
});
```

`flushSession(sessionId, throughVersion?)` reuses the existing ordered wait and per-write timeout. For a supplied version, stop before inspecting later jobs when `s.durableVersion >= throughVersion`; unresolved/unknown earlier saves still fail, a later active/dirtier turn is not a prerequisite. In production, use the whole job's tracking in `AppService` for shutdown; no await from the turn. Confirmed CAS + failed marker/watermark stays a projection-only retry. For fixtures lacking the P3 methods, leave existing compositions without `d.userMemory`, rather than fabricating success.

Add a pure mapper in the owned `durable-chat-runtime.ts` (or in the scheduler next to `PassiveTurn`). Use actual result records, not constructed history:

```ts
// Imports: MessageRecord, SessionRecord, VoiceDeliveryRecord, TurnModeHandle.
recordMemoryTurn(session: SessionRecord | null | undefined, input: MessageRecord,
  output: MessageRecord, version: number, mode: TurnModeHandle | undefined,
  delivery: VoiceDeliveryRecord | null | undefined, toolDerived = false, localToolControl = false): void {
  if (!this.userMemoryScheduler || !session || session.lifecycle !== 'active' ||
      session.ephemeral || localToolControl || (mode?.frozen() ?? mode?.current())?.mode === 'dev' ||
      !['completed', 'truncated'].includes(output.completionStatus)) return;
  this.userMemoryScheduler.completed(session.userId, session.sessionId,
    session.memoryWatermarkSequence ?? -1, {
      turnId: output.turnId, messageId: output.messageId, sequence: output.sequence, version,
      userText: input.content,
      assistantText: toolDerived || output.sourceProvenance?.length || output.calendarView ||
        output.webSources?.length || output.webActivities?.length || output.weatherView
        ? '' : output.mode === 'live' || input.mode === 'live' ? delivery?.textSpoken ?? '' : output.content,
    });
}
```

- In `MemoryText.execute`, call from the first success terminal boundary with `foundation.result(e.turn)` after `finish()` or `commitPromoted` and, for Live Voice, after `settle()`. Do not use generated text as a fallback for missing/unknown heard evidence. Call exactly once, not in the prior-result replay. Suppress assistant prose when current Web/Calendar evidence was fetched even if there was no visible view (e.g. use execution/ledger state before it is cleared). Mark text local-control turns ineligible if they are scripted internal actions. Cross-check finalized writer and transport ordering; queue scheduling is synchronous constant-bounded bookkeeping, projection and I/O are in the timer.
- The compaction kickoff lives in `scheduleCompactionIfNeeded` after a real cutpoint is selected and before calling `runCompactionJob`: `this.runtime.userMemoryScheduler?.compacting(this.ownerId, sessionId)` (guard `!cold.session.ephemeral`). Queue the freshly completed turn before that call. Current `finish` and the tail of `execute` both schedule; centralize their **success** scheduling behind terminal result availability so compaction cannot drop the batch before it is registered. The timer can run after the real compactor starts; the pin refresh at promotion never waits for it.
- In durable fallback `executeOwnedTurn` and `runCalendarTurn`, enqueue once when the turn is durably terminal and delivery is settled. Pass `version: 0` as a sentinel for already-durable records. For the plain voice branch capture the successful `finalResult` and `lastConfirmedDelivery` and enqueue after the existing final `c.live.settle(...)` / release, not on the earlier generated-text terminal. Calendar fallback can use the published narration, actual assistant sequence and `lastConfirmedDelivery` supplied by the caller after `voiceOutput.complete`. Skip ambiguous/uncommitted recovery results; do not synthesize on reconnect or rebase.
- In `MemoryText`, `projectMemoryWatermark` updates `cold.session = { ...cold.session, memoryWatermarkSequence: Math.max(sequence, cold.session.memoryWatermarkSequence ?? 0) }` when still resident. For the RAM indicator use a bounded per-`Cold` `Set<string>` of successfully marked output IDs (cap at the admitted per-session history limit, evict oldest after explicit verification; durable fallback already projects from messages). In `messages` use `toVisibleMessage(record.memoryUpdated || !cold.memoryUpdated?.has(record.messageId) ? record : { ...record, memoryUpdated: true })` for both page and Canvas archive projection. Do not mutate a frozen terminal job or change manifest hashes. If evicted/restarted, hydrate the flag from the archived message.
- Archive retries / durable recovery compare the same underlying assistant record while allowing an existing `memoryUpdated: true` to survive a replay of an unmarked original. In `mergeMonotonicMessage`, compare base fields without `memoryUpdated` (retain every other identity/privacy comparison) and compute the merged marker as monotonic OR for an assistant. In `publishResult.append`, strip the already-published passive `true` only from the comparison when the sealed result omitted it; keep a true explicit flag as part of the exact sealed evidence. No writes can demote a true flag or attach it to a user message.
- `stopAccepting` closes scheduler immediately (also at direct `drain` entry if invoked without `stopAccepting`); `interruptUser` cancels that user's slots before awaiting anything. The app evicts P2 cache on deactivation. Add `scheduler.cancel(u,s)` to the session mutation/delete handoff only for deletion, not rename, in Task 9.

- [ ] **Verify green.** `npm test -- src/chat-runtime/user-memory-scheduler.spec.ts test/runtime/user-memory-runtime.spec.ts test/runtime/compaction-runtime.spec.ts test/performance/memory-first-voice.spec.ts test/performance/memory-text-archive.spec.ts`. Assert a no-op persists **only** the watermark outside writer accounting (spy `markMemoryUpdated` and user-memory writes); assert an explicit-tool turn can still enqueue (Task 6). Use a held writer with real archived progress to demonstrate separation, not a wall-clock SLA.
- [ ] **Commit.**

```sh
git add -- backend/src/chat-runtime/durable-chat-runtime.ts backend/src/chat-runtime/memory-text.ts backend/src/chat-runtime/memory-first-foundation.ts backend/src/chat-runtime/finalization.ts backend/src/persistence/memory-text-archive.ts backend/test/runtime/user-memory-runtime.spec.ts
git commit -m "feat(user-memory): learn asynchronously from finalized turn evidence"
```

### Task 5: Admit one strict explicit tool decision in both native adapters

**Files:** Modify `backend/src/model/web-native.ts`, `backend/src/model/calendar-validation.ts`, `backend/src/model/calendar-policy.ts`, `backend/src/model/calendar-adapter.ts`, `backend/src/model/calendar-repair.ts`, `backend/test/runtime/user-memory-runtime.spec.ts`.

- [ ] **Write the failing tests.** Import `readMemoryToolCandidate` from `../../src/model/calendar-validation.js`, `createWebNativeModelPort` from `../../src/model/web-native.js`, `createCalendarModelPortV2` from `../../src/model/calendar-adapter.js`, `CALENDAR_LIMITS` from `../../src/contracts/calendar-policy.js`, and `UPDATE_USER_MEMORY_NATIVE_TOOL`, `UPDATE_USER_MEMORY_TOOL_DEFINITION` from `../../src/contracts/user-memory.js`. Use `calendarBinding`, `calendarLimits`, `skillRequest`, `nativeFrame` from `../model/calendar-fixtures.js` and `collect`, `config` from `../model/helpers.js`. Add:

```ts
const memoryTool = 'update_user_memory';
function toolReply(raw = '{"instruction":"Remember my dog Beans."}', terminal = 'tool_calls',
  name = memoryTool, id = 'memory-tool-1', generationId = 'memory-tool-generation') {
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  return new Response((nativeFrame({ tool_calls: [{ index: 0, type: 'function', id,
    function: { name, arguments: raw } }] }) + nativeFrame({}, terminal)).replaceAll('gen_fixture', generationId)
    + data({ id: generationId, choices: [], usage: { prompt_tokens: 32, completion_tokens: 16, cost: 0.000064 } })
    + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } });
}

it('validates one memory candidate and never forwards arguments from a secret or an invalid batch', () => {
  const call = { index: 0, id: 'memory-tool-1', type: 'function', name: memoryTool,
    arguments: '{"instruction":"Remember my dog Beans."}', envelopeInvalid: false };
  const batch = { calls: [call], terminal: 'tool_calls', envelopeInvalid: false };
  expect(readMemoryToolCandidate(batch, true, CALENDAR_LIMITS)).toMatchObject({
    kind: 'update_user_memory', envelope: { instruction: 'Remember my dog Beans.' },
  });
  expect(readMemoryToolCandidate(batch, false, CALENDAR_LIMITS)).toEqual({ kind: 'memory-invalid' });
  for (const raw of ['{"instruction":"a","instruction":"b"}', '{"instruction":"a","extra":true}',
    '{"instruction":42}', JSON.stringify({ instruction: 'x'.repeat(501) })]) {
    expect(readMemoryToolCandidate({ ...batch, calls: [{ ...call, arguments: raw }] }, true, CALENDAR_LIMITS))
      .toEqual({ kind: 'memory-invalid' });
  }
  for (const malformed of [{ ...batch, terminal: 'length' },
    { ...batch, calls: [call, { ...call, index: 1, name: 'get_environment' }] }]) {
    expect(readMemoryToolCandidate(malformed, true, CALENDAR_LIMITS)).toEqual({ kind: 'memory-invalid' });
  }
  expect(readMemoryToolCandidate({ ...batch, calls: [{ ...call, arguments: '{"instruction":"sk-or-v1-fixture"}' }] },
    true, CALENDAR_LIMITS)).toEqual({ kind: 'memory-secret', toolCallId: 'memory-tool-1' });
});

it('advertises the canonical opt-in definition and parses the memory decision on both native paths', async () => {
  const seed = skillRequest();
  const settings = config();
  const limits = { ...calendarLimits, tools: true };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => toolReply());
  const adapter = createWebNativeModelPort({ ...settings, sessionId: 's1' }, limits, fetcher);
  const web = await collect(adapter.stream({ ...seed, tools: [UPDATE_USER_MEMORY_TOOL_DEFINITION],
    advertised: false, envAdvertised: false }));
  expect(web.find(c => c.type === 'decision')?.decision.kind).toBe(memoryTool);
  const calendar = createCalendarModelPortV2(settings, limits, calendarBinding(), fetcher, undefined, false, true);
  const chunks = await collect(calendar.stream({
    ...seed, tools: [...seed.tools, UPDATE_USER_MEMORY_NATIVE_TOOL],
  }));
  expect(chunks.find(c => c.type === 'decision')?.decision.kind).toBe(memoryTool);
  const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies).toHaveLength(2);
  for (const body of bodies) expect(body.tools.at(-1)).toEqual(UPDATE_USER_MEMORY_TOOL_DEFINITION);
});
```

- [ ] **Verify red.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "one memory candidate|canonical opt-in"` — no shared candidate reader and the old tool equality rejects the optional definition.
- [ ] **Implement the shared, closed candidate.** In `calendar-validation.ts` use the existing scanner, not a new JSON parser. `MemoryToolCandidate` is a local type; it is never parsed as a persisted `SkillDecision`. Diagnostics never contain instruction, raw arguments, response text or user-supplied keys. If a memory fragment is present in a mixed batch, refuse the whole batch; do not fall back to dispatching Web/Calendar/the first tool.

```ts
import { UPDATE_USER_MEMORY_TOOL_NAME, updateUserMemoryArgumentsSchema } from '../contracts/user-memory.js';
import { updateUserMemoryDecisionSchema, type MemoryCompatibleSkillDecision } from '../contracts/calendar-model.js';

export type MemoryToolCandidate = Extract<MemoryCompatibleSkillDecision, { kind: 'update_user_memory' }>
  | { kind: 'memory-invalid' } | { kind: 'memory-secret'; toolCallId: string };

export function readMemoryToolCandidate(batch: CandidateBatch, advertised: boolean,
  limits: CalendarLimits, decisionId = 'memory-local'): MemoryToolCandidate | null {
  if (!batch.calls.some(call => call.name === UPDATE_USER_MEMORY_TOOL_NAME)) return null;
  const invalid = { kind: 'memory-invalid' } as const;
  const call = batch.calls[0];
  if (!advertised || batch.calls.length !== 1 || batch.terminal !== 'tool_calls' ||
      batch.envelopeInvalid || !call || call.index !== 0 || call.envelopeInvalid ||
      call.type !== 'function' || !idSchema.safeParse(call.id).success) return invalid;
  const scan = scanJsonObject(call.arguments, limits);
  if (scan.code || scan.forbidden) return invalid;
  let value: unknown;
  try { value = JSON.parse(call.arguments) as unknown; } catch { return invalid; }
  const args = updateUserMemoryArgumentsSchema.safeParse(value);
  if (!args.success) return args.error.issues.every(issue => issue.message === 'secret_pattern')
    ? { kind: 'memory-secret', toolCallId: call.id! } : invalid;
  return updateUserMemoryDecisionSchema.parse({
    kind: UPDATE_USER_MEMORY_TOOL_NAME, decisionId,
    nativeCall: { id: call.id!, type: 'function',
      function: { name: UPDATE_USER_MEMORY_TOOL_NAME, arguments: call.arguments } },
    assistantContent: null, envelope: args.data, terminal: 'tool_calls',
  });
}
```

Include `MemoryToolCandidate` in `WebNativeDecision`; extend the **wire** `WebModelRequest.tools` union with `typeof UPDATE_USER_MEMORY_TOOL_DEFINITION`. Add optional synchronous `memoryAllowed?: () => boolean` to `WebModelRequest` and `WebNativeRequest` for late removal (the trusted scope is checked at execution too). `createWebNativeModelPort.finish` calls the reader before Web/Environment delegation:

```ts
const memory = readMemoryToolCandidate(raw.batch, sentMemory, webLimits);
if (memory) return [{ type: 'decision', decision: memory }];
```

In `createWebNativeModelPort.stream` reject a memory definition unless it deep-equals the sole canonical definition, it is not duplicated, and `limits.tools === true`; no arbitrary definition authorizes a tool. Limit tool cardinality with the existing parser even when OpenRouter has no verified `parallel_tool_calls` parameter. Set `sentMemory` **once at actual dispatch**, not when parsing the response. When `lateBody` runs with or without a mode handle, call the same synchronous projection that removes just memory when `request.memoryAllowed?.() === false` or all tools for Dev:

```ts
const isMemoryDefinition = (tool: WebModelRequest['tools'][number]) =>
  'function' in tool && tool.function.name === UPDATE_USER_MEMORY_TOOL_NAME;
// In the late-body projection, after determining `dev`; run it even when the
// projected messages have the original reference if memory availability changed.
const tools = dev ? [] : request.memoryAllowed?.() === false
  ? request.tools.filter(t => !isMemoryDefinition(t)) : request.tools;
sentMemory = tools.some(isMemoryDefinition);
const { tools: _unused, ...rest } = cleanBody();
return { ...rest, messages, ...(tools.length ? { tools } : {}) };
```

Move the return after the existing budget/deadline check for these projected messages and tools. When no projection is needed preserve the original body. Leave Web/Environment and non-tool response parsing unchanged.

In `calendar-policy.ts` centralize canonical selection and make every estimate/body/reservation check use **the same ordered tools**:

```ts
export const skillToolsFor = (memory: boolean): readonly SkillNativeDefinition[] =>
  memory ? [...SKILL_NATIVE_TOOLS, UPDATE_USER_MEMORY_NATIVE_TOOL] : SKILL_NATIVE_TOOLS;
// Add `memory = false` to buildCalendarBody after composite; enforce limits.tools === true if memory.
// `expected = composite ? [...skillToolsFor(memory), WEB_TOOL_DEFINITION] : skillToolsFor(memory)`.
// Deep compare request.tools to expected, then serialize only the admitted list:
export function calendarWireTools(memory: boolean, composite: boolean): readonly unknown[] {
  const base = nativeToolDefinitions(skillToolsFor(memory));
  return composite ? [...base, WEB_TOOL_DEFINITION] : base;
}
```

Use `calendarWireTools(memory, composite)` in `buildCalendarBody`'s estimate and result, and in `assertProjectedNativeBody` for a non-Dev late projection (add a final optional `memory` argument). Do not alter the existing hold/pricing/deadline evidence or treat the mixed JS definition list as already provider-shaped. Keep the canonical order **base native tools, memory if enabled, Web if enabled**.

In `calendar-adapter.ts`, add optional `memory = false` to `createCalendarModelPortV2` and to the internal adapter and a typed native opt-in `MemoryCalendarModelPort` returning `WebNativeChunk` via an overload (seven-argument call, `memory: boolean`). Keep the six-argument overload and old `SkillModelPort` users intact. Pass flags to `buildCalendarBody`/`assertProjectedNativeBody`; initialize `CalendarStreamAssembly(skillToolsFor(memory), ...)`. In the late projection restrict actual advertisement with `sentMemory = this.memory && !dev && (!('memoryAllowed' in request) || request.memoryAllowed?.() !== false)`; serialize `calendarWireTools(sentMemory, this.composite)` for User, strip tools and the parallel parameter in Dev. Track this per POST even if the message reference is unchanged. After real `[DONE]`, and before `assembly.finish()` or Web candidate selection, use `readMemoryToolCandidate(assembly.rawCandidate().batch, sentMemory, this.binding.limits, request.decisionId)`. Preserve terminal accounting and observation flush before yielding the typed decision; never use the Canvas early dispatch path for memory. Existing early Canvas validation still cannot execute an element of a mixed memory batch.

In `calendar-repair.ts`, in `assertNativeHistory` after strict scan/JSON parse and paired name/id validation add this branch before `historicalSkillNativeNameSchema`:

```ts
if (call.function.name === UPDATE_USER_MEMORY_TOOL_NAME) {
  if (group.sources.length) throw new Error('Unexpected memory tool sources.');
  updateUserMemoryArgumentsSchema.parse(args);
  updateUserMemoryReceiptSchema.parse(JSON.parse(group.result.content));
} else if (historicalSkillNativeNameSchema.safeParse(call.function.name).success) {
  // existing validation body
}
```

This validates only complete current-turn receipt pairs. Malformed/extra/parallel or unknown tool requests are rejected with no memory writer dispatch; no extra repair budget for a secret denial or ambiguous persistence answer. Keep existing bounded Calendar repairs for other tools and use fixed, payload-free wording for malformed memory calls.

- [ ] **Verify green.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "one memory candidate|canonical opt-in"` and `npm test -- test/model/calendar-policy.spec.ts test/model/calendar-adapter.spec.ts test/model`. Verify a forged definition/mixed batch cannot open the writer and late Dev emits no tools. Run `npm run build` to catch overload/call-site drift.
- [ ] **Commit.**

```sh
git add -- backend/src/model/web-native.ts backend/src/model/calendar-validation.ts backend/src/model/calendar-policy.ts backend/src/model/calendar-adapter.ts backend/src/model/calendar-repair.ts backend/test/runtime/user-memory-runtime.spec.ts
git commit -m "feat(model): validate and advertise the opt-in native memory tool"
```

### Task 6: Execute memory commands and project receipts through the Web/native Text and Voice paths

**Files:** Modify `backend/src/chat-runtime/{ports,durable-chat-runtime,memory-text,memory-first-foundation}.ts`, `backend/src/model/web-native.ts`, `backend/test/runtime/user-memory-runtime.spec.ts`.

- [ ] **Write the failing tests.** Import `UserMemoryFault` from `../../src/personalization/errors.js` and `authority` from `./dev-mode-fixture.js`. Add:

```ts
function toolSnapshot(capable: boolean) {
  const base = textSnapshot();
  return { ...base, modelLimits: { ...base.modelLimits!, contextTokens: 65_536, tools: capable } };
}
const updated = { ...writerResult, changed: true, changeSummary: 'Updated Identity.' };
it.each([
  ['updated', null, updated, { ok: true, status: 'updated', summary: 'Updated Identity.' }, true],
  ['no-change', null, writerResult, { ok: true, status: 'no_change', summary: '' }, false],
  ['persistence-failure', new UserMemoryFault('PERSISTENCE_ERROR'), null,
    { ok: false, error: { code: 'PERSISTENCE_ERROR', retryable: true } }, false],
  ['writer-failure', new UserMemoryFault('MEMORY_WRITER_UNAVAILABLE'), null,
    { ok: false, error: { code: 'WRITER_UNAVAILABLE', retryable: true } }, false],
  ['durable-updated', null, updated, { ok: true, status: 'updated', summary: 'Updated Identity.' }, true],
] as const)('sends an honest %s receipt and only a confirmed memory marker', async (label, error, result, receipt, mark) => {
  const durable = label === 'durable-updated';
  const r = await rig({ snapshot: toolSnapshot(true), durable });
  if (error) r.applyInstruction.mockRejectedValueOnce(error);
  else r.applyInstruction.mockResolvedValueOnce(result!);
  r.f.fetcher.mockResolvedValueOnce(toolReply()).mockResolvedValueOnce(reply('memory-answer', 'A fixture response.'));
  try {
    const a = await r.f.submit('Remember my dog Beans.');
    await r.execute(a);
    const [first, second] = wires(r.f);
    expect(first.tools?.map(t => t.function.name)).toContain(memoryTool);
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', name: memoryTool, tool_call_id: 'memory-tool-1',
      content: JSON.stringify(receipt) });
    expect(r.applyInstruction).toHaveBeenCalledExactlyOnceWith(r.f.identity.userId, 'Remember my dog Beans.',
      expect.objectContaining({ source: 'tool', sessionId: a.sessionId, turnId: a.turnId, signal: expect.any(AbortSignal) }));
    const complete = r.emit.mock.calls.map(([e]) => e.event).find(e => e.type === 'completed')!;
    if (mark) expect(complete).toHaveProperty('memoryUpdated', true);
    else expect(complete).not.toHaveProperty('memoryUpdated');
    if (!durable) await r.flush(a.sessionId);
    expect((await r.p.sessions.get(r.f.identity.userId, a.sessionId))?.memoryWatermarkSequence).toBeUndefined();
    const messages = await r.p.messages.list(r.f.identity.userId, a.sessionId, page);
    expect(messages.items.at(-1)?.memoryUpdated).toBe(mark ? true : undefined);
    expect(r.synthesize).not.toHaveBeenCalled(); // eligibility is retained for the later idle job
  } finally { await r.f.dispose(); }
});

it('returns a secret receipt without repeating the rejected argument or calling the writer', async () => {
  const r = await rig({ snapshot: toolSnapshot(true) });
  r.f.fetcher.mockResolvedValueOnce(toolReply('{"instruction":"sk-or-v1-fixture"}'))
    .mockResolvedValueOnce(reply('memory-secret-answer', 'I could not save that.'));
  try {
    const ids = await r.f.submit('Remember something.');
    await r.execute(ids);
    const second = wires(r.f)[1];
    expect(second.messages.at(-1)).toMatchObject({ content: JSON.stringify({
      ok: false, error: { code: 'SECRET_REJECTED', retryable: false },
    }) });
    expect(JSON.stringify(second)).not.toContain('sk-or-v1-fixture');
    expect(r.applyInstruction).not.toHaveBeenCalled();
  } finally { await r.f.dispose(); }
});

it('runs the explicit tool and completion on fresh Live Voice; a repeated provider call cannot write again', async () => {
  const r = await rig({ snapshot: toolSnapshot(true) });
  r.applyInstruction.mockResolvedValueOnce(updated);
  r.f.fetcher.mockResolvedValueOnce(toolReply()).mockResolvedValueOnce(
    toolReply(undefined, 'tool_calls', memoryTool, 'second-attempted-tool', 'repeated-tool-generation'));
  try {
    const voice = await liveTurn(r, 'voice-explicit-1', undefined, undefined, 'Remember my dog Beans.');
    const a = await r.f.runtime.submitLiveTurn(voice.cmd);
    await r.execute(a, voice.live);
    await voice.release();
    expect(r.applyInstruction).toHaveBeenCalledTimes(1);
    expect(r.emit.mock.calls.map(([f]) => f.event).find(e => e.type === 'completed'))
      .toMatchObject({ memoryUpdated: true });
    await r.flush(a.sessionId);
    expect(r.f.runtime.memoryMessages(r.f.identity.userId, a.sessionId, page)?.items.at(-1)?.memoryUpdated)
      .toBe(true);
  } finally { await r.f.dispose(); }
});

it.each(['paused', 'unwarmed', 'temporary', 'no-native-capability'] as const)('omits the memory tool for %s', async mode => {
  const r = await rig({ snapshot: toolSnapshot(mode !== 'no-native-capability') });
  if (mode === 'paused') { r.cachedMemory.mockReturnValue({ ...stored, enabled: false }); r.cachedSnapshot.mockReturnValue(null); }
  if (mode === 'unwarmed') { r.cachedMemory.mockReturnValue(undefined); r.cachedSnapshot.mockReturnValue(null); }
  try {
    const ids = await r.f.runtime.submitTurn({ identity: r.f.identity, sessionId: null,
      content: 'Hello', idempotencyKey: 'omit-memory-tool', ...(mode === 'temporary' ? { ephemeral: true } : {}) });
    await r.execute(ids);
    expect(wires(r.f)[0].tools?.map(t => t.function.name) ?? []).not.toContain(memoryTool);
    if (mode !== 'no-native-capability') expect(memoryBlock(wires(r.f)[0])).toBeUndefined();
    expect(r.applyInstruction).not.toHaveBeenCalled();
  } finally { await r.f.dispose(); }
});

it('uses the frozen Dev dispatch to omit memory and never learns from the Dev answer', async () => {
  const a = authority();
  a.mode.setEnabled(true);
  const r = await rig({ snapshot: toolSnapshot(true), devMode: a.mode });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const ids = await r.f.submit('Private Dev text');
    a.mode.select(a.principal, 'dev');
    await r.execute(ids, undefined, a.principal);
    const first = wires(r.f)[0];
    expect(first.tools).toBeUndefined();
    expect(memoryBlock(first)).toBeUndefined();
    expect(first.messages.at(-1)?.content).toContain('[Current mode: Dev]');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.synthesize).not.toHaveBeenCalled();
    expect(r.applyInstruction).not.toHaveBeenCalled();
    await r.flush(ids.sessionId);
    expect((await r.p.memory.get(r.f.identity.userId, ids.sessionId))?.pinnedUserMemory).toEqual(beans);
  } finally { vi.useRealTimers(); await r.f.dispose(); }
});

it('advertises a command for a confirmed empty account without adding a prompt block', async () => {
  const r = await rig({ snapshot: toolSnapshot(true) });
  r.cachedMemory.mockReturnValue(null);
  r.cachedSnapshot.mockReturnValue(null);
  try {
    await r.execute(await r.f.submit('Ordinary text'));
    expect(memoryBlock(wires(r.f)[0])).toBeUndefined();
    expect(wires(r.f)[0].tools?.map(t => t.function.name)).toContain(memoryTool);
    expect(r.applyInstruction).not.toHaveBeenCalled();
  } finally { await r.f.dispose(); }
});
```

For the non-tool case still allow a pinned prefix and passive learning; only native advertisement is absent. P3's system policy assigns semantic explicit-only intent to the main model; P4 enforces native admission/receipt authority, not an additional natural-language classifier or pre-model inference.

- [ ] **Verify red.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "honest|secret receipt|explicit tool|omits the memory tool|frozen Dev|confirmed empty"` — missing advertisement/continuation and indicator (negative cases may already pass).
- [ ] **Implement one scoped executor and current-turn receipt pair.** Add to `ports.ts` a type-only contract; do not widen P1's accounting or historical decision schemas:

```ts
// imports: types CompatibleCalendarToolGroup, MemoryToolCandidate, UpdateUserMemoryReceipt
export type MemoryToolTurn = {
  allowed(): boolean;
  receipt(): UpdateUserMemoryReceipt | null;
  run(candidate: Exclude<MemoryToolCandidate, { kind: 'memory-invalid' }>, signal: AbortSignal):
    Promise<CompatibleCalendarToolGroup>;
};
```

In `DurableChatRuntime`, create this once per actual attempt, capture the server session/turn, and call `applyInstruction` only after the tool decision's real terminal frame, authority checks, and continuation headroom check. Never pass client IDs or a cached provider authorization. Return `undefined` for missing writer, missing session, temporary, internal local controls or a model without verified `tools`. The checked store CAS in the writer is the commit; no extra external-mutation barrier or archive wait for this local call.

```ts
// Imports: UPDATE_USER_MEMORY_TOOL_NAME, updateUserMemoryReceiptSchema, nativeToolCallSchema,
// UserMemoryFault, MemoryToolTurn, SessionRecord, TurnModeHandle.
explicitMemory(session: SessionRecord | null | undefined, turnId: string,
  snapshot: RuntimeConfigSnapshot, mode: TurnModeHandle | undefined, localControl?: boolean): MemoryToolTurn | undefined {
  const memory = this.d.userMemory;
  if (!memory || !session || session.ephemeral || session.lifecycle !== 'active' ||
      localControl || snapshot.modelLimits?.tools !== true) return undefined;
  const { userId, sessionId } = session;
  let receipt: ReturnType<typeof updateUserMemoryReceiptSchema.parse> | null = null;
  const eligible = () => mode?.current()?.mode !== 'dev' && this.memoryEnabled(userId);
  return {
    // Eligibility excludes live storage. Recheck after the first model decision.
    allowed: () => receipt === null && eligible(),
    receipt: () => receipt,
    async run(candidate, signal) {
      signal.throwIfAborted();
    if (!receipt) {
        if (!eligible()) receipt = { ok: false, error: { code: 'MEMORY_DISABLED', retryable: false } };
        else if (candidate.kind === 'memory-secret')
          receipt = { ok: false, error: { code: 'SECRET_REJECTED', retryable: false } };
        else {
          try {
            const edit = await memory.writer.applyInstruction(userId, candidate.envelope.instruction,
              { source: 'tool', sessionId, turnId, signal });
            receipt = { ok: true, status: edit.changed ? 'updated' : 'no_change', summary: edit.changeSummary };
          } catch (error) {
            const fault = error instanceof UserMemoryFault ? error : null;
            const code = fault?.secretRejected ? 'SECRET_REJECTED' : fault?.code === 'MEMORY_DISABLED' ? 'MEMORY_DISABLED'
              : fault?.code === 'PERSISTENCE_ERROR' || fault?.code === 'MEMORY_CONFLICT' ? 'PERSISTENCE_ERROR'
              : 'WRITER_UNAVAILABLE';
            receipt = { ok: false, error: { code, retryable: fault?.retryable ?? false } };
          }
        }
      }
      return memoryToolPair(memoryCallId(candidate), receipt);
    },
  };
}
```

Add the following to `web-native.ts` (type `CompatibleCalendarToolGroup` from `../context/calendar-context.js`; validate the receipt with the P1 schema). Use the **same** pair in Web/Calendar before and after the writer, and fixed narration when no continuation is possible or a duplicate/unadvertised request arrives:

```ts
export function memoryCallId(candidate: Exclude<MemoryToolCandidate, { kind: 'memory-invalid' }>): string {
  return candidate.kind === 'memory-secret' ? candidate.toolCallId : candidate.nativeCall.id;
}
export function memoryToolPair(id: string, receipt: UpdateUserMemoryReceipt): CompatibleCalendarToolGroup {
  const call = nativeToolCallSchema.parse({ id, type: 'function',
    function: { name: UPDATE_USER_MEMORY_TOOL_NAME, arguments: '{"instruction":"[withheld]"}' } });
  return { assistant: { role: 'assistant', content: null, tool_calls: [call] },
    result: { role: 'tool', name: UPDATE_USER_MEMORY_TOOL_NAME, tool_call_id: id,
      content: JSON.stringify(updateUserMemoryReceiptSchema.parse(receipt)) }, sources: [] };
}
export const memoryReceiptHeadroom = (id: string) => memoryToolPair(id, {
  ok: true, status: 'updated', summary: '\\'.repeat(500),
});
export function memoryReceiptText(receipt: UpdateUserMemoryReceipt | null | undefined): string {
  return receipt?.ok ? receipt.status === 'updated' ? 'I updated your memory.' : 'Nothing in your memory changed.'
    : receipt?.error.code === 'SECRET_REJECTED' ? 'I did not save that sensitive information.'
    : 'I could not confirm a memory update.';
}
```

In `MemoryText.execute` create `memoryToolTurn` from `cold.session`, snapshot, and the same `turnMode` that controls outgoing prompts. Reuse the attempt closure on same-process Calendar resumptions (`e.native.loop` owns it). Extend `textNativeTools` with canonical memory **when eligible**; use the same exact maximum tool list in `preflightNative`, `admit`, and the dispatch request. Set `memoryAllowed: memoryToolTurn?.allowed`; late projection can only subtract from that admitted list. Keep `else if (e.web || envToolCapable || memoryToolTurn?.allowed())` explicit. Before the existing Environment/Web branches:

```ts
const previousReceipt = memoryToolTurn?.receipt();
if (decision.kind === 'memory-invalid' || (previousReceipt
    && (decision.kind === 'update_user_memory' || decision.kind === 'memory-secret'))) {
  const text = memoryReceiptText(previousReceipt);
  await publish(prose ? prose.push(text) : text);
  answered = true; break;
}
if (decision.kind === 'update_user_memory' || decision.kind === 'memory-secret') {
  if (!memoryToolTurn) throw new AppError('PROVIDER_ERROR', 'Memory is unavailable.', false);
  job.check();
  const proof = memoryReceiptHeadroom(memoryCallId(decision));
  admit([...messages, proof.assistant, proof.result]);
  const remaining = Date.parse(request.deadlineAt) - Date.now();
  if (remaining <= 0) throw new AppError('TIMEOUT', 'The turn deadline has passed.', false);
  const signal = AbortSignal.any([job.signal, AbortSignal.timeout(remaining)]);
  const group = await job.track(memoryToolTurn.run(decision, signal));
  const receipt = memoryToolTurn.receipt();
  if (receipt?.ok && receipt.status === 'updated') e.memoryUpdated = true;
  job.check();
  messages.push(group.assistant, group.result);
  continue;
}
```

Handle `kind === 'text'` before this branch as today. The headroom estimate reserves 500 escaped code points (worst receipt framing); use `admit` on the actual pair again for continuation. For a context-budget failure **before** `run`, seal fixed failure narration rather than spend on an undeliverable update. If a continuation fails after a receipt, fall back to `memoryReceiptText(receipt)` unless the whole turn was cancelled or output failed. One writer invocation per attempt, no automatic writer retry in the loop, no raw tool error/arguments in transient pairs. Do not retain pairs in Web history, transcript, compactor input or passive deltas. A late toggle cannot authorize a write after one was advertised; a late Dev mode strips tools/prefix and cannot execute a forged candidate. Keep the real write tracked through cancellation; do not treat an abort during CAS as proof that CAS did not apply.

Propagate `memoryUpdated?: true` in `Entry`, `MemoryTerminal`, `terminalEnvelope`'s assistant, the prepared assistant record in the Web path, and both `MemoryText.execute` `completed` emissions (first and replay). Emit only on `true`; voice uses the same runtime boundary. Reserve the extra serialized marker bytes in `DurableChatRuntime.outputBudget` and foundation envelope bounds before dispatch. For a confirmed change followed by interrupted narration any resulting assistant can retain the true archive flag; do not fabricate a successful completion. No explicit method writes a watermark.

**Older durable non-Calendar path:** when eligible and `limits.calendar?.tools` is absent, use `createWebNativeModelPort` inside `executeOwnedTurn.generateTurn` for this one additional built-in; keep the existing `AttemptAdapter` unchanged otherwise. Add an optional `observeUsage?: (raw: unknown) => void` to `WebModelRequest` (`observe: async raw => { request.observeUsage?.(raw); }`, never in `beforeDispatch`). For the durable native branch, reuse the existing `publishFiltered`, `SpeechProse`, `job`, `openRouterUser`, and configured `AttemptAdapter` accounting save callback, not a second persistence module. The following runs in place of the plain stream block in `generateTurn`; normal finalization remains shared:

```ts
// `seed` is the existing main-attempt accounting seed lifted before adapter construction.
const native = createWebNativeModelPort({ ...attemptConfig, sessionId: a.sessionId },
  limits, this.d.fetcher, this.d.diagnostics?.emit);
const records: AccountingRecord[] = [];
let messages: readonly WebNativeMessage[] = projected.messages;
const prefixCount = (projected as PositionedContext).prefixCount;
const deadlineAt = new Date(Date.parse(a.createdAt) + snapshot.budgets.totalRunTimeoutMs).toISOString();
const sendText = async (text: string) => {
  c.live?.modelOutput?.();
  await publishFiltered(prose ? prose.push(text) : text);
};
for (let index = 0; index < 2 && !ended; index++) {
  job.check();
  const tools = action.allowed() ? [UPDATE_USER_MEMORY_TOOL_DEFINITION] : [];
  const admitted = admitNativePrompt({ messages, prefixCount, tools,
    budgets: snapshot.budgets, contextTokens: limits.contextTokens });
  let run: AccountingRecord = { ...seed, startedAt: this.now() };
  let candidate: WebNativeDecision | undefined;
  let failed = false;
  for await (const chunk of dispatchStream(native, { messages: admitted.messages, tools, deadlineAt,
    modelId: a.modelId, user: a.openRouterUser, maxOutputTokens: snapshot.budgets.maxOutputTokens,
    remainingContextTokens: admitted.remainingContextTokens, signal: job.signal,
    dataCollection: 'deny', advertised: false, memoryAllowed: action.allowed,
    observeUsage: raw => {
      const frame = object(raw);
      run = mergeUsage({ ...run, generationId: identifier(frame.id) ?? run.generationId,
        reportedModel: identifier(frame.model) ?? run.reportedModel,
        reportedProvider: identifier(frame.provider) ?? run.reportedProvider }, frame.usage);
    },
  }, dispatch && { ...dispatch, project: decision => {
    const userIndex = admitted.messages.findLastIndex(message => message.role === 'user');
    return projectTurnMessages(admitted.messages as readonly ContextChatMessage[], userIndex,
      projected as PositionedContext, decision);
  } })) {
    job.check();
    if (chunk.type === 'decision') candidate = chunk.decision;
    else if (chunk.type === 'failure') failed = true;
    else await sendText(chunk.text);
  }
  records.push(run);
  if (index === 0 && run.generationId) {
    const identified = await advanceAttempt(p, owned, job, a, attemptReceipt,
      'generating', null, { generationId: run.generationId });
    a = identified.attempt; attemptReceipt = identified.receipt;
  }
  if (candidate?.kind === 'text' && !failed) {
    ended = true; length = candidate.truncated;
  } else if (!failed && index === 0 &&
      (candidate?.kind === 'update_user_memory' || candidate?.kind === 'memory-secret')) {
    const proof = memoryReceiptHeadroom(memoryCallId(candidate));
    admitNativePrompt({ messages: [...messages, proof.assistant, proof.result], prefixCount, tools: [],
      budgets: snapshot.budgets, contextTokens: limits.contextTokens });
    const remaining = Date.parse(deadlineAt) - Date.now();
    if (remaining <= 0) throw new AppError('TIMEOUT', 'The turn deadline has passed.', false);
    const signal = AbortSignal.any([job.signal, AbortSignal.timeout(remaining)]);
    const pair = await job.track(action.run(candidate, signal));
    const receipt = action.receipt();
    memoryUpdated = receipt?.ok === true && receipt.status === 'updated';
    job.check();
    messages = [...messages, pair.assistant, pair.result];
  } else if (action.receipt() || candidate?.kind === 'memory-invalid') {
    await sendText(memoryReceiptText(action.receipt()));
    ended = true;
  } else throw new AppError('PROVIDER_ERROR', 'The model service could not answer.', false);
}
const total = (name: 'promptTokens' | 'completionTokens' | 'cost') =>
  records.every(row => row[name] !== null)
    ? records.reduce((sum, row) => sum + (row[name] ?? 0), 0) : null;
accounting = mergeUsage({ ...seed, generationId: a.generationId, outcome: 'generating', endedAt: this.now(),
  reportedModel: records.every(r => r.reportedModel === records[0]?.reportedModel)
    ? records[0]?.reportedModel ?? null : null,
  reportedProvider: records.every(r => r.reportedProvider === records[0]?.reportedProvider)
    ? records[0]?.reportedProvider ?? null : null,
}, { prompt_tokens: total('promptTokens'), completion_tokens: total('completionTokens'), cost: total('cost') });
```

Use the computed `accounting` in the common `SavedResult` publication (fall back to `adapter.accounting.snapshot` only for `AttemptAdapter`). Extract the current durable save callback to reuse for unsuccessful native execution as well: only account the bounded observed evidence of actual POSTs, no generation metadata lookup on this path, no replacement of already-published accounting values, and no silent main-model retransmit. Record the main attempt's stable **first** generation ID; sum known costs/tokens across at most two bounded dispatches, with unknown fields remaining unknown; P2 accounts the writer separately. Preserve the preexisting finalization/cancellation rules. If native accounting ownership cannot be represented by existing ports, report that precise gate rather than introducing an unaccounted tool path.

- [ ] **Verify green.** `npm test -- test/runtime/user-memory-runtime.spec.ts test/runtime/dev-mode-dispatch.spec.ts test/performance/memory-first-voice.spec.ts test/performance/memory-first-text.spec.ts`. Add a durable run of the updated/no-op fixtures (`rig({ snapshot: toolSnapshot(true), durable: true })`), using valid distinct `reply` generation IDs in tool and follow-up; check saved result/replay agree, one writer CAS occurs, no watermark advances, and the durable fallback adds no memory storage before first POST. Run `npm run build`.
- [ ] **Commit.**

```sh
git add -- backend/src/chat-runtime/ports.ts backend/src/chat-runtime/durable-chat-runtime.ts backend/src/chat-runtime/memory-text.ts backend/src/chat-runtime/memory-first-foundation.ts backend/src/model/web-native.ts backend/test/runtime/user-memory-runtime.spec.ts
git commit -m "feat(user-memory): execute explicit memory edits in native text and voice"
```

### Task 7: Run the same memory executor inside Calendar's native loop

**Files:** Modify `backend/src/chat-runtime/calendar-loop.ts`, `backend/src/context/calendar-context.ts`, `backend/src/chat-runtime/{memory-text,durable-chat-runtime}.ts`, and `backend/test/runtime/user-memory-runtime.spec.ts`.

- [ ] **Write the failing tests.** Append to the runtime spec (test the native Calendar branch **with** pricing evidence and no connected Google account; the local built-in must not depend on one):

```ts
it.each([false, true])('continues a Calendar native memory call without Calendar authority (voice=%s)', async isVoice => {
  const snap = toolSnapshot(true);
  const r = await rig({ snapshot: { ...snap, modelLimits: { ...calendarLimits, tools: true } } });
  r.applyInstruction.mockResolvedValueOnce(updated);
  try {
    const voice = isVoice ? await liveTurn(r, 'voice-calendar-memory', undefined, undefined, 'Remember my dog Beans.') : null;
    const a = voice ? await r.f.runtime.submitLiveTurn(voice.cmd)
      : await r.f.submit('Remember my dog Beans.');
    const dispatchCount = r.db.calls.length;
    r.f.fetcher.mockImplementationOnce(async () => {
      expect(r.db.calls).toHaveLength(dispatchCount);
      return toolReply();
    }).mockResolvedValueOnce(reply('cal-memory-answer', 'I updated your memory.'));
    await r.execute(a, voice?.live);
    await voice?.release();
    const [first, second] = wires(r.f);
    expect(first.tools?.map(t => t.function.name)).toEqual([
      'activate_skill', 'call_tool', 'control_canvas', 'get_environment', memoryTool,
    ]);
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', name: memoryTool,
      tool_call_id: 'memory-tool-1', content: '{"ok":true,"status":"updated","summary":"Updated Identity."}' });
    expect(r.applyInstruction).toHaveBeenCalledTimes(1);
    expect(r.emit.mock.calls.map(([e]) => e.event).find(e => e.type === 'completed'))
      .toMatchObject({ memoryUpdated: true });
    await r.flush(a.sessionId);
    expect(await r.p.sessions.get(r.f.identity.userId, a.sessionId)).not.toHaveProperty('memoryWatermarkSequence');
    expect(JSON.stringify([...r.db.rows('metadata').values()])).not.toContain('[withheld]');
    const next = await r.f.submit('Follow up', a.sessionId);
    await r.execute(next);
    expect(wires(r.f).at(-1)?.messages.some(m => m.name === memoryTool)).toBe(false);
    expect(r.applyInstruction).toHaveBeenCalledTimes(1);
  } finally { await r.f.dispose(); }
});

it('does not execute an advertised memory decision after the account pauses memory', async () => {
  const snap = toolSnapshot(true);
  const r = await rig({ snapshot: { ...snap, modelLimits: { ...calendarLimits, tools: true } } });
  try {
    r.f.fetcher.mockImplementationOnce(async () => {
      r.cachedMemory.mockReturnValue({ ...stored, enabled: false });
      return toolReply();
    }).mockResolvedValueOnce(reply('paused-memory-answer', 'Memory is paused.'));
    const a = await r.f.submit('Remember my dog Beans.');
    await r.execute(a);
    expect(r.applyInstruction).not.toHaveBeenCalled();
    expect(wires(r.f)[1].messages.at(-1)?.content)
      .toBe('{"ok":false,"error":{"code":"MEMORY_DISABLED","retryable":false}}');
    expect(wires(r.f)[1].tools?.some(t => t.function.name === memoryTool)).toBe(false);
    expect(r.emit.mock.calls.map(([e]) => e.event).find(e => e.type === 'completed')).not.toHaveProperty('memoryUpdated');
  } finally { await r.f.dispose(); }
});
```

The first test checks driver count **inside** the pre-model callback, not once the real archive has run. Use a distinct ID for every synthetic generation in the session. Run the same exact-tool assertion in the composite case (Task 5's adapter fixture with `composite: true` and `WEB_TOOL_DEFINITION` last). The mixed-candidate unit test rejects the entire batch so neither sibling can execute.

- [ ] **Verify red.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "Calendar native memory call|account pauses memory"` — the existing loop parses only `SkillDecision`, lacks the receipt, and doesn't include the canonical optional definition.
- [ ] **Implement Calendar's opted-in execution.** Add `memoryTool?: MemoryToolTurn` to `CalendarLoopContext` and `memoryAdvertised?: boolean` to `assembleTurnCalendarContext`'s input, not to global tool contracts. Compute one per-decision `memoryAdvertised = this.ctx.memoryTool?.allowed() === true`; thread that boolean to current-context assembly and the selected adapter. `MemoryText.preflightNative` must use that flag for its bounded preflight. Use `skillToolsFor(memoryAdvertised)` for `calendarContext.tools` and `calendarWireTools(memoryAdvertised, true)` for the composite web budget. The actual request is the exact typed list `composite ? webToolsFor(skillToolsFor(memoryAdvertised)) : skillToolsFor(memoryAdvertised)`. For the overlap with existing port injection:

```ts
// In decide(): keep the configured Calendar port on unchanged non-composite requests.
const adapter = composite || memoryAdvertised
  ? createCalendarModelPortV2(modelConfig, this.ctx.snapshot.modelLimits!, binding,
      this.ctx.fetcher, this.ctx.diagnostics?.emit, composite, memoryAdvertised)
  : isCalendarV2(this.ctx.calendar)
    ? this.ctx.calendar.createModelPort(modelConfig, this.ctx.snapshot.modelLimits!, binding, this.ctx.fetcher)
    : createCalendarModelPortV2(modelConfig, this.ctx.snapshot.modelLimits!, binding, this.ctx.fetcher);
// Give the first branch a typed `WebNativeRequest` and the unchanged branch a
// `SkillDecisionRequest`; do not widen persisted SkillDecision or the plugin port.
```

Before the existing `skillDecisionSchema.parse(chunk.decision)` capture a `MemoryToolCandidate` and let the adapter finish/flush usage. If a `memory-invalid` arrives, seal `memoryReceiptText` with no effect. On a valid or secret decision, execute **after** `ledger.finishDispatch` and failure/rejection checks, then move to `next: 'decide'`. There is no durable `pendingDecisionId` for this built-in:

```ts
if (memoryCandidate) {
  const action = this.ctx.memoryTool;
  if (memoryCandidate.kind === 'memory-invalid' || !action || action.receipt())
    return this.answerAndSeal(input, memoryReceiptText(action?.receipt()), null);
  this.ctx.job.check();
  if (this.ctx.turnMode?.frozen()?.mode === 'dev')
    return this.answerAndSeal(input, memoryReceiptText(null), null);
  if (Date.parse(this.ctx.now()) >= Date.parse(this.ctx.ledger.deadlineAt()))
    throw new AppError('TIMEOUT', 'The turn deadline has passed.', false);
  const proof = memoryReceiptHeadroom(memoryCallId(memoryCandidate));
  this.assemble([...this.groups, proof], null);
  const ms = Date.parse(this.ctx.ledger.deadlineAt()) - Date.now();
  if (ms <= 0) throw new AppError('TIMEOUT', 'The turn deadline has passed.', false);
  const signal = AbortSignal.any([this.ctx.job.signal, AbortSignal.timeout(ms)]);
  const group = await this.ctx.job.track(action.run(memoryCandidate, signal));
  this.ctx.job.check();
  this.groups.push(group);
  this.cursor = calendarCursorSchema.parse({ ...this.cursor, next: 'decide', pendingDecisionId: null, repair: null });
  return { calendarCursor: this.cursor, calendarRefs: this.refs() };
}
```

`CalendarLoop` keeps this pair only in the current attempt. Add `memoryWasUpdated()` reading `receipt()?.ok/status`; `toolGroups()` and `refs().toolCallIds` filter out the memory pair. Do not call `recordLocal` / `decisionRecord` / `putDecision` / `putResult` for it. `context/calendar-context.ts` must reject any memory pair outside `input.groups` and any memory pair with a nonempty `sources`; validate the bounded result via `updateUserMemoryReceiptSchema` (the parallel history check in `calendar-repair.ts` validates arguments and linkage). Exclude this pair from `repeatsEarlierRead`, operation authority, provenance, and any durable group count passed to the Web ledger:

```ts
const durableToolGroup = (group: CompatibleCalendarToolGroup) =>
  group.result.name !== UPDATE_USER_MEMORY_TOOL_NAME;
// toolGroups(): structuredClone(this.groups.filter(durableToolGroup));
// refs(): this.groups.filter(durableToolGroup).map(group => group.result.tool_call_id);
// WebTurn.execute/recordFailure: give the length of the same filtered list.
```

Web/context already position current Web evidence immediately after the accepted input; preserve this existing behavior. For Calendar continuation spend/failure exhaustion use `memoryReceiptText` if a memory receipt exists and final prose is unavailable; do not re-execute. Do not use connected Google authority or `promote()` for this local tool; maintain existing Calendar checks for actual Calendar effects.

- [ ] **Connect the terminal bit without expanding ownership.** Pass the `MemoryToolTurn` from `MemoryText.execute` and `DurableChatRuntime.runCalendarTurn` as `memoryTool`. In `MemoryText`, read `loop.memoryWasUpdated()` whenever finishing a new result, even after nested continuation/error; in `publishPromoted` add the marker to the existing `assistantFields` and reconstructed output:

```ts
const memoryUpdated = native.loop.memoryWasUpdated();
const assistantFields = { mode: t.mode,
  ...(t.voice ? { visibility: 'internal' as const, voiceSessionId: t.voice.voiceSessionId } : {}),
  ...(artifacts.length ? { canvasArtifacts: [...artifacts] } : {}),
  ...(memoryUpdated ? { memoryUpdated: true as const } : {}) };
```

For durable Calendar, `publishCalendarTurn` already spreads caller `assistantFields` into the record. Pass a structurally compatible field object with the bit from `loop.memoryWasUpdated()` and add the same true-only projection to the `completed` envelope it forwards; keep its existing protocol, IDs, sequencing, status, and delta path. Terminal replay projects the persisted assistant marker, never a guessed bit. E.g.:

```ts
const memoryUpdated = loop.memoryWasUpdated();
const assistantFields = { ...input.voiceOutput?.fields(),
  ...(memoryUpdated ? { memoryUpdated: true as const } : {}) };
// Existing publishCalendarTurn parameter `assistantFields` receives this object.
const emitPublished = (envelope: CalendarCompatibleEnvelope) =>
  forward(memoryUpdated && envelope.event.type === 'completed'
    ? { ...envelope, event: { ...envelope.event, memoryUpdated: true } } : envelope);
```

The older durable Calendar **strict seal schema** (`backend/src/agent/state.ts`) does not allow this bit. Do not put it in that seal or in unrelated fields. Normal publication (and replay after the assistant row exists) is covered in-scope; if the process dies after memory CAS but before assistant-row publication, that fallback may lose the pill, never assert an unproved update or retry the edit. If pre-archive crash recovery of the indicator is made a hard gate, ask the parent for the exact seal/publisher ownership transfer (`backend/src/agent/state.ts`, `backend/src/chat-runtime/calendar-ports.ts`, `backend/src/chat-runtime/calendar-publication.ts`) rather than editing them here.

- [ ] **Verify green.** `npm test -- test/runtime/user-memory-runtime.spec.ts test/runtime/calendar-memory-voice.spec.ts test/runtime/calendar-durable-voice.spec.ts test/runtime/dev-mode-dispatch.spec.ts test/voice/web-search-voice.spec.ts`. `npm test -- test/performance/calendar-tool-latency.spec.ts` and check the named cases in the exit gate; no new pre-tool Calendar storage or authority changes.
- [ ] **Commit.**

```sh
git add -- backend/src/chat-runtime/calendar-loop.ts backend/src/context/calendar-context.ts backend/src/chat-runtime/memory-text.ts backend/src/chat-runtime/durable-chat-runtime.ts backend/test/runtime/user-memory-runtime.spec.ts
git commit -m "feat(user-memory): integrate the explicit tool with Calendar continuations"
```

### Task 8: Compose the one writer and verify its exact model off path

**Files:** Modify `backend/src/persistence/persistence.ts`, `backend/src/app.service.ts`, `backend/src/app.module.ts`, and `backend/test/runtime/user-memory-runtime.spec.ts`.

- [ ] **Write the failing tests.** Import `AppService`, `prepareConfigurationSnapshot` from `../../src/app.service.js`, `loadModelLimits` from `../../src/model/catalogue.js`, `document` from `../admin-config/fixtures.js`, and `assemblyFixture` from `../assembly/admin-config-fixture.js`. Use `admitAccount` and `admittedAccount` as in the Dev fixtures above. Append:

```ts
const catalogEntry = (id: string, outputCap = 'max_tokens') => ({
  id, architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  endpoints: ['/api/v1/chat/completions'], context_length: 65_536,
  top_provider: { max_completion_tokens: 4096 }, supported_parameters: [outputCap],
});

it('prepares exact distinct writer limits once on activation, never by borrowing the main limits', async () => {
  const f = assemblyFixture();
  const row = document();
  row.settings.openRouter.modelId = 'fixture/model';
  row.settings.openRouter.reasoningEffort = 'provider-default';
  row.settings.memory = { modelMode: 'custom', customModelId: 'fixture/writer' };
  const candidate = { revision: row.revision, settings: row.settings,
    credentials: { openrouter: 'fixture-only', deepgram: null } };
  const read = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    data: [catalogEntry('fixture/model'), catalogEntry('fixture/writer', 'max_completion_tokens')],
  }));
  const prepare = () => prepareConfigurationSnapshot(f.bootstrap, candidate, f.assets,
    loadModelLimits, read, new AbortController().signal);
  const config = await prepare();
  expect(config.memoryModelId).toBe('fixture/writer');
  expect(config.memoryModelLimits).toMatchObject({ modelId: 'fixture/writer', contextTokens: 65_536,
    outputCapParameter: 'max_completion_tokens' });
  expect(config.modelLimits?.modelId).toBe('fixture/model');
  expect(read.mock.calls.every(([url, init]) => String(url).includes('/models?') && init?.method === 'GET')).toBe(true);
  candidate.settings.memory.customModelId = 'fixture/missing';
  await expect(prepare()).rejects.toBeDefined();
});

it('warms once in authenticated owner preparation and uses the active custom writer with native CAS and accounting', async () => {
  const r = await rig();
  const seeded = document();
  seeded.settings.openRouter.modelId = 'fixture/model';
  seeded.settings.openRouter.reasoningEffort = 'provider-default';
  seeded.settings.memory = { modelMode: 'custom', customModelId: 'fixture/writer' };
  const f = assemblyFixture();
  seeded.credentials.openrouter = { envelope: f.credentials.seal('openrouter', 'fixture-only'), validatedAt: at };
  f.seed(seeded);
  f.ports.open = async () => ({ ...r.p, close: async () => {} }) as never;
  const sent: Array<Record<string, unknown>> = [];
  f.ports.fetcher = async (input, init) => {
    if (String(input).includes('/models?'))
      return Response.json({ data: [catalogEntry('fixture/writer', 'max_completion_tokens')] });
    if (!String(input).endsWith('/chat/completions')) throw new Error('Unexpected network fixture');
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return reply('custom-writer-result', JSON.stringify({
      changed: true, changeSummary: 'Saved Identity.',
      sections: { ...stored.sections, identity: 'Dog: Mochi.' },
    }));
  };
  const fromStore = vi.spyOn(r.p.userMemory, 'read');
  const service = await AppService.create(f.bootstrap, f.ports);
  const principal = admitAccount(admittedAccount({ userId: stored.userId }), 'sid_1');
  try {
    await service.prepareOwner(principal);
    await service.prepareOwner(principal);
    expect(fromStore).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    expect(service.userMemory.cachedMemory(stored.userId)).toBeNull();
    await expect(service.memoryWriter.applyInstruction(stored.userId, 'Remember my dog Mochi.', {
      source: 'composer', expectedRevision: 0,
    })).resolves.toMatchObject({ changed: true, memory: { revision: 1 } });
    expect(sent).toEqual([expect.objectContaining({ model: 'fixture/writer', user: stored.userId,
      max_completion_tokens: 1536 })]);
    expect(service.userMemory.cachedSnapshot(stored.userId)?.content).toContain('Dog: Mochi.');
    expect([...r.db.rows('metadata').values()]).toContainEqual(expect.objectContaining({
      kind: 'accounting', purpose: 'memory', userId: stored.userId, requestedModel: 'fixture/writer',
    }));
    await service.onUserDeactivated(stored.userId);
    expect(service.userMemory.cachedMemory(stored.userId)).toBeUndefined();
  } finally { await service.operations.shutdown(); await r.f.dispose(); }
});
```

Include a same-ID fixture (main mode and a matching verified compaction model) by spying on the catalog fetch and asserting no extra GET is used. Add an invalid/expired distinct ID negative case using `expiration_date: '2026-11-01'` in the injected response. Keeping the admin pointer unchanged on invalid activation is part of the existing `prepare` → durable CAS → `publish` contract.

- [ ] **Verify red.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "exact distinct writer|authenticated owner preparation"` — no writer-specific limits/persistence instance is composed.
- [ ] **Implement activation once per snapshot.** Add a local exported type `type PreparedRuntimeSnapshot = RuntimeConfigSnapshot & Pick<MemoryWriterConfig, 'memoryModelLimits'>` in `app.service.ts`. Return it from `prepareConfigurationSnapshot` and `loadPointer`, use it for `current` and `lastPrepared`; no P1 contract edits. `CurrentConfigPort` still exposes a normal snapshot, and every spread (including `configFor`) retains `memoryModelId` plus the verified extra field. After building `baseSnapshot`:

```ts
// Imports from './model/catalogue.js': evaluateMemoryModel, readModelCatalogue.
let memoryModelLimits: ModelLimits | null = null;
if (configured && settings.memory.modelMode === 'custom') {
  const id = baseSnapshot.memoryModelId;
  memoryModelLimits = [limits, compactionLimits].find(l => l?.modelId === id &&
    verifiedOutputCap(l) !== null && l.contextTokens >= budgets.maxContextTokens &&
    l.outputTokens >= budgets.maxOutputTokens) ?? null;
  if (!memoryModelLimits) {
    // ponytail: one extra bounded metadata GET on distinct custom activation;
    // share the catalogue snapshot with the loader if activation latency warrants it.
    const snapshot = await readModelCatalogue(signal, budgets.connectTimeoutMs, fetcher);
    const evaluated = evaluateMemoryModel(id, budgets, snapshot);
    if (evaluated.reportBase.blockers.length || evaluated.limits?.modelId !== id)
      throw new AdminConfigFault('CONFIG_ACTIVATION_UNAVAILABLE');
    memoryModelLimits = evaluated.limits;
  }
}
if (signal.aborted) throw new AdminConfigFault('CONFIG_ACTIVATION_UNAVAILABLE');
return Object.freeze({ ...baseSnapshot,
  compactionModelLimits: compactionLimits ? Object.freeze({ ...compactionLimits }) : null,
  memoryModelLimits: memoryModelLimits ? Object.freeze({ ...memoryModelLimits }) : null });
```

Map an unavailable catalogue to the same closed activation error; do not expose raw provider failures or quietly reuse different model limits. The production loader verifies caps; a fake that ignores the compaction callback never lends main limits to a different ID. Main mode continues to reuse exact main evidence through P2.

- [ ] **Compose and supervise writes.** In `persistence.ts`, create `userMemory: new MongoUserMemoryRepository(store, owner, budgets.maxDocumentBytes)` beside personalization. Do not add another connection/owner. In `AppService` construct `readonly userMemory` / `readonly memoryWriter` once after personalization construction:

```ts
this.userMemory = new UserMemoryService({ repository: () => {
  const p = this.persistence?.userMemory;
  if (this.configClosing || !p) return null;
  return {
    read: u => p.read(u),
    createIfAbsent: (...args) => this.trackConfigJob(() => p.createIfAbsent(...args)),
    compareAndSwap: (...args) => this.trackConfigJob(() => p.compareAndSwap(...args)),
  };
} });
this.memoryWriter = new MemoryWriterService({
  memory: this.userMemory, currentConfig: () => this.current,
  fetcher: this.ports.fetcher, report: fields => this.telemetry.event('process', fields),
  putAccounting: record => this.trackConfigJob(async () => {
    const p = this.store();
    await p.owner.assertExecutor();
    await p.metadata.putAccounting(record);
  }),
});
```

Fence delayed writes at real dispatch too: in the `trackConfigJob` CAS closures check `this.configClosing` and fail before calling the repository if it is now closing. Do **not** drop terminal accounting for an already-dispatched writer. Track the whole `applyInstruction`/`synthesize` call as well as actual DB work so its late usage write cannot race `drainConfigJobs` returning empty. Reuse the shared service object for the composer by wrapping its bound methods the same way existing Admin Config calls are supervised:

```ts
const apply = this.memoryWriter.applyInstruction.bind(this.memoryWriter);
this.memoryWriter.applyInstruction = (...args) => this.trackConfigJob(() => apply(...args));
const synthesize = this.memoryWriter.synthesize.bind(this.memoryWriter);
this.memoryWriter.synthesize = (...args) => this.trackConfigJob(() => synthesize(...args));
```

Guard those tracked closures with `configClosing` and `UserMemoryFault('NOT_READY')` before starting new work. Add `userMemory: { cache: this.userMemory, writer: this.memoryWriter, trackWrite: run => this.trackConfigJob(run) }` in `createRuntime`, only when the persistence repo exists (older deterministic fixtures need not opt in). Extend existing `prepareOwner`'s bounded `Promise.all` with `this.userMemory.warm(principal.identity.userId)`. Existing private middleware invokes this on authenticated admission; warmed calls are resolved without storage. In `onUserDeactivated` immediately `this.userMemory.evict(userId)` before `interruptUser`; `stopConfig` calls `this.userMemory.clearCache()` and stops scheduler admission via the existing runtime stop hook. No paid check goes into readiness, stream attach, or finalized speech.

In `app.module.ts`, pass the two dependencies to the existing factory:

```ts
useFactory: (service: AppService) => ({
  service: service.personalization, userId: () => service.identities.resolve().userId,
  userMemoryService: service.userMemory, memoryWriter: service.memoryWriter,
}),
```

- [ ] **Verify green.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "exact distinct writer|authenticated owner preparation"`; `npm test -- src/personalization/user-memory-http.spec.ts src/personalization/memory-writer.spec.ts src/admin-config/admin-config.service.spec.ts test/performance/auth-memory-owners.spec.ts test/performance/calendar-tool-latency.spec.ts -t "repeated prepared owner|user memory|memory writer|configuration"` (also run the P2 specs **without** the filter). `npm run build`. Confirm `memoryModelId` survives pointer publication and custom writer dispatch does not fetch catalogue evidence.
- [ ] **Commit.** Stage only the P4 hunks from `app.service.ts`.

```sh
git add -- backend/src/persistence/persistence.ts backend/src/app.module.ts backend/test/runtime/user-memory-runtime.spec.ts
git add -p -- backend/src/app.service.ts
git diff --cached -- backend/src/app.service.ts
git commit -m "feat(user-memory): compose storage, writer and verified model activation"
```

### Task 9: Route private DELETE to hard purge under a scoped runtime fence

**Files:** Modify `backend/src/chat-runtime/{ports,durable-chat-runtime,memory-text,memory-first-foundation}.ts`, `backend/src/http/{chat-http.controller,chat-http.service,validation,chat-stream.transport}.ts`, `backend/src/app.service.ts`, and `backend/test/runtime/user-memory-runtime.spec.ts`.

- [ ] **Write the failing tests.** Use `ChatHttpService`, `ChatHttpModule`, `configureChatHttp`, `configurePrivateHttp`, `Test` from `@nestjs/testing`, type `NestExpressApplication`, `request` from `supertest`, `RequestIdentityStore`, `ServerIdentityResolver`, and `authFixture`/`SESSION_COOKIE` from `../auth/fixtures.js`. Add the following local helper rather than changing the shared fake. Use the real P3 cascade; substitute only the absent fake `deleteMany` command:

```ts
function stubCascade(r: Awaited<ReturnType<typeof rig>>) {
  const store = r.p.owner.store;
  const collection = store.collection.bind(store);
  const deletes = vi.fn();
  vi.spyOn(store, 'collection').mockImplementation(name => {
    const col = collection(name);
    col.deleteMany = async filter => {
      if (!filter) throw new Error('Missing scope');
      deletes(name, filter);
      let deletedCount = 0;
      for (const [id, row] of r.db.rows(name)) {
        if (Object.entries(filter).every(([field, value]) => field === 'kind'
          ? value !== null && typeof value === 'object' && '$ne' in value && row.kind !== value.$ne
          : row[field] === value)) {
          r.db.rows(name).delete(id); deletedCount++;
        }
      }
      return { acknowledged: true, deletedCount };
    };
    return col;
  });
  return deletes;
}

it('hard-purges Temporary Chat through private DELETE, not the ordinary soft delete', async () => {
  const r = await rig();
  const u = r.f.identity.userId;
  const auth = await authFixture(admittedAccount({ userId: u }));
  const identities = new RequestIdentityStore();
  const identity = new ServerIdentityResolver(identities);
  const origin = 'http://localhost:5173';
  const deletes = stubCascade(r);
  const normalDelete = vi.spyOn(r.p.sessions, 'delete');
  const module = await Test.createTestingModule({ imports: [ChatHttpModule.register({
    runtime: r.f.runtime, identity, principal: () => identities.principal(), budgets: DEFAULT_BUDGETS,
    sessions: {
      get: r.p.sessions.get.bind(r.p.sessions), list: r.p.sessions.list.bind(r.p.sessions),
      createIfAbsent: r.p.sessions.createIfAbsent.bind(r.p.sessions),
      touchActivity: r.p.sessions.touchActivity.bind(r.p.sessions), update: r.p.sessions.update.bind(r.p.sessions),
      delete: normalDelete, hardPurgeSession: (owner, s) => r.f.runtime.purgeEphemeral(owner, s).then(() => undefined),
    },
    messages: r.p.messages,
  })] }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  app.setGlobalPrefix('api');
  configurePrivateHttp(app, { auth: auth.service, identities, frontendOrigin: origin, secureCookie: false });
  configureChatHttp(app, DEFAULT_BUDGETS);
  await app.init();
  const http = request(app.getHttpServer());
  const path = (id: string) => `/api/sessions/${id}`;
  try {
    const make = (content: string, idempotencyKey: string, ephemeral?: boolean) =>
      http.post('/api/sessions').set('Cookie', SESSION_COOKIE).set('Origin', origin)
        .send({ sessionId: null, content, idempotencyKey, ...(ephemeral === undefined ? {} : { ephemeral }) }).expect(202);
    const normal = (await make('Keep this', 'keep-normal-1')).body as SubmitTurnResponse;
    await r.execute(normal); await r.flush(normal.sessionId);
    const temp = (await make('Forget this conversation', 'purge-temp-1', true)).body as SubmitTurnResponse;
    await r.execute(temp); await r.flush(temp.sessionId);
    await http.post(`${path(normal.sessionId)}/turns`).set('Cookie', SESSION_COOKIE).set('Origin', origin)
      .send({ sessionId: normal.sessionId, idempotencyKey: 'late-temp-mode',
        content: 'Do not change mode', ephemeral: true }).expect(400);
    await http.get(path(temp.sessionId)).set('Cookie', SESSION_COOKIE).expect(200)
      .expect(({ body }) => { expect(body.ephemeral).toBe(true); });
    await http.delete(path(temp.sessionId)).set('Cookie', SESSION_COOKIE).set('Origin', 'https://other.example').expect(403);
    expect(deletes).not.toHaveBeenCalled();
    const purge = await http.delete(path(temp.sessionId)).set('Cookie', SESSION_COOKIE).set('Origin', origin).expect(204);
    expect(purge.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    expect(normalDelete).not.toHaveBeenCalled();
    expect(deletes.mock.calls.map(([name]) => name)).toEqual(['checkpoint_writes', 'checkpoints', 'agent-memory', 'messages', 'metadata']);
    expect(await r.p.sessions.get(u, temp.sessionId)).toBeNull();
    expect(r.f.runtime.memorySession(u, temp.sessionId)).toBeNull();
    expect([...r.db.rows('metadata').values()].filter(row => row.sessionId === temp.sessionId))
      .toEqual([expect.objectContaining({ kind: 'accounting' })]);
    await http.get(path(temp.sessionId)).set('Cookie', SESSION_COOKIE).expect(404);
    await http.delete(path(normal.sessionId)).set('Cookie', SESSION_COOKIE).set('Origin', origin).expect(204);
    expect(await r.p.sessions.get(u, normal.sessionId)).toMatchObject({ lifecycle: 'archived' });
  } finally { await app.close(); await r.f.dispose(); }
});

it('waits out a held archive under the Temporary Chat fence and never resurrects it', async () => {
  const r = await rig();
  const deletes = stubCascade(r);
  const gate = r.db.pauseNextUpdate();
  const c = { identity: r.f.identity, sessionId: null, content: 'Temporary input',
    idempotencyKey: 'held-archive-temp', ephemeral: true };
  try {
    const ids = await r.f.runtime.submitTurn(c);
    await r.execute(ids);
    await gate.started;
    expect(await r.f.runtime.purgeEphemeral(c.identity.userId, ids.sessionId, {
      cutoff: new Date(Date.now() + 60_000).toISOString(),
    })).toBe(false);
    const purge = r.f.runtime.purgeEphemeral(c.identity.userId, ids.sessionId);
    await expect(r.f.runtime.submitTurn(c)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(deletes).not.toHaveBeenCalled();
    gate.resume();
    expect(await purge).toBe(true);
    await expect(r.f.runtime.submitTurn(c)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await r.p.sessions.get(c.identity.userId, ids.sessionId)).toBeNull();
    expect(r.f.runtime.memoryMessages(c.identity.userId, ids.sessionId, page)).toBeNull();
  } finally { gate.resume(); await r.f.dispose(); }
});
```

Add a second held-provider case: `mockImplementationOnce` enters the first POST and waits for its `init.signal` to abort; run DELETE for that session while an unrelated session remains active. Assert the pending provider receives cancel, the unrelated signal never aborts, no child delete occurs before owned work settles, and a duplicate DELETE joins or is idempotent. Try deleting the same scoped ID with a different authenticated owner (no deletes, original still readable). For a fixture without chat accounting use `reply` or the plain `AttemptAdapter`, not WebNative's historical unknown accounting fallback.

- [ ] **Verify red.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "private DELETE|Temporary Chat fence"` — route delegates only to soft delete, and runtime has no safe purge.
- [ ] **Keep transport private and scoped.** In `validation.ts` add and reuse:

```ts
export function assertTemporaryCreation(sessionId: string | null, ephemeral: boolean | undefined): void {
  if (sessionId !== null && ephemeral !== undefined)
    throw new AppError('INVALID_REQUEST', 'Temporary mode is selected when starting a conversation.');
}
```

Call it in `ChatHttpService.submit` after strict parsing and body/route match; enforce the same rule internally in durable/live entry points (fresh trusted live binding can supply the flag). In `ChatHttpService.session`, project `...(record.ephemeral === true ? { ephemeral: true } : {})`. Keep the existing `@Delete`/204 controller; update its header to explain private Temporary Chat purge and preserve `noQuery(q)`.

```ts
async deleteSession(id: string) {
  const u = this.o.identity.resolve().userId;
  const s = pathId(id);
  const session = this.o.runtime.memorySession?.(u, s) ?? await this.o.sessions.get(u, s);
  if (session?.userId === u && session.sessionId === s && session.ephemeral === true) {
    const purge = this.o.sessions.hardPurgeSession;
    if (!purge) throw new AppError('NOT_READY', 'Temporary chat deletion is unavailable.');
    await purge.call(this.o.sessions, u, s);
    return;
  }
  this.o.runtime.assertSessionMutation?.(u, s);
  await this.o.sessions.delete(u, s);
}
```

The optional `hardPurgeSession` **HTTP delegate** points to the runtime fence, not directly to Mongo. `AppService.sessions` uses that existing repository port to avoid editing `observed-runtime.ts` / `http/options.ts`. In `chat-stream.transport.ts` extend each attachment with one `settled = Promise.withResolvers<void>()`; resolve in `open`'s outer `finally` (after slot release and transport cleanup). Add:

```ts
async closeConversation(userId: string, sessionId: string): Promise<void> {
  const attachment = this.attachments.get(JSON.stringify([userId, sessionId]));
  if (!attachment) return;
  attachment.abort.abort();
  if (!attachment.response.writableEnded && !attachment.response.destroyed) attachment.response.end();
  await attachment.settled.promise;
}
```

This is a conversation ID, not the auth-session ID used by `closeUser`. Do not change SSE framing or parse rules: `calendarCompatibleEnvelopeSchema` already carries `memoryUpdated` for protocols 1/2/3.

- [ ] **Implement the runtime fence.** In `ports.ts`, add `purgeEphemeral?(userId, sessionId, options?: { cutoff?: string; stopTransport?: () => Promise<void> }): Promise<boolean>` to `ChatRuntime` using string types for both IDs. `true` means confirmed purge/already removed by this executor, `false` means sweep skipped or no eligible scoped session. Add a bounded keyed map of in-flight purge promises, and a scoped short-lived ID-only tombstone on confirmed removal. Implement public synchronous `assertConversationAdmission` on `DurableChatRuntime`:

```ts
private readonly purging = new Map<string, Promise<boolean>>();
private readonly purgedUntil = new Map<string, number>();
assertConversationAdmission(u: string, s: string): void {
  const scope = this.sessionKey(u, s), expires = this.purgedUntil.get(scope);
  if (expires !== undefined && expires <= Date.now()) this.purgedUntil.delete(scope);
  if (this.purging.has(scope) || (expires !== undefined && expires > Date.now()))
    throw new AppError('NOT_FOUND', 'Chat not found.');
}
```

Use the fence in `submitTurn`, `submitLiveTurn`, `findLiveSubmission`, `retryTurn`, `executeTurn`, `reserveStream`, `prepareSession`, `assertSessionMutation`, `retrySave`, and `rebaseSession` **before** starting new work. Recheck after async selection/admission before installing work (`MemoryText.submit` after `hydrate`, and durable `acceptNewTurn`/`acceptRetry` before `work.open`). `joinAcceptance` keys already include owner/session; keep existing accepted promises so deletion can wait them out, marked `allSettled`, without global quiesce. In `executeTurn` track the real promise per scope (use a bounded in-flight set per key for rejected competitors; remove by identity on settlement). Cleanup paths already owning work may finish normally. Prevent `reconcileSession` from initiating new work while that scope is purging, including voice disconnect; never call general reconciliation as a means of deletion because it can resume a **planned** Calendar POST.

Install the fence before asynchronous scope checks, bounded by the existing request/owner limits (e.g. at most 16 concurrent purges). For repeated explicit DELETE of the same target, join an already-running explicit purge; if a sweep owns the slot and skips, re-enter once as explicit. Expire short-lived tombstones using the existing `requestRetentionMs` (default 5 minutes), cap at 1,024, purge old entries before allocating, and reject new purge admission when the cap is exhausted rather than evicting recent idempotency guards silently. No transcript content or durable tombstones. Keep the fence held until actual operations settle; a timeout observing a raw write is **not** permission to cascade.

```ts
// Core of the scoped action, called only after its fence is installed.
const p = this.d.persistence;
const memory = this.memoryFor(u);
const fromRam = memory?.session(u, s);
const row = fromRam ?? await p.sessions.get(u, s);
if (!row || row.ephemeral !== true) return false;
if (options.cutoff && (row.lastActivityAt >= options.cutoff ||
    this.work.get(u, s) || this.reservations.hasSession(u, s) ||
    memory?.temporaryPurgeBusy(s) || this.hasScopedAcceptance(u, s))) return false;

if (!options.cutoff) {
  this.work.get(u, s)?.abort('CANCELLED');
  // Stop the matching HTTP/voice transports; wait this scope's admitted tasks.
  const quiescent = await boundedResult(Promise.allSettled([
    ...(options.stopTransport ? [options.stopTransport()] : []),
    ...this.scopedAcceptancePromises(u, s), ...this.scopedExecutionPromises(u, s),
  ]), this.d.config.budgets.shutdownDrainMs);
  if (!quiescent.ok || this.work.get(u, s) || this.reservations.hasSession(u, s))
    throw new AppError('CONFLICT_ACTIVE_TURN', 'Wait for chat work to finish before deleting.');
  await memory?.settleTemporaryPurge(s);
}

const durable = await p.sessions.get(u, s);
if (options.cutoff && durable && durable.lastActivityAt >= options.cutoff) return false;
if (durable?.execution.ownerId || durable?.execution.activeAttemptId) {
  if (options.cutoff) return false;
  // A safely unattached accepted attempt may use cancelOwnedTurn after the
  // pending-effect check below; any other durable marker remains fenced by storage.
}
const unresolved = await p.calendarOperationsV2?.listUnresolvedBySession({ userId: u, sessionId: s, limit: 1 });
if (unresolved?.overflow || unresolved?.operations.length) {
  if (options.cutoff) return false;
  throw new AppError('NOT_READY', 'Temporary chat has unresolved work.');
}
// If safe and active marker status is accepted with no owner, cancel using its
// server identity and exact attempt IDs; re-read, never clear a raw marker.
await p.owner.assertExecutor();
await p.sessions.hardPurgeSession(u, s);
memory?.dropTemporarySession(s);
// Clear receipt, confirmed-state, Calendar cache/graph epoch and live attempt keys
// of this scope. Install short-lived ID-only tombstone before releasing the fence.
return true;
```

Define the small helper methods used above directly from the existing keyed maps:

```ts
private scopedAcceptancePromises(u: string, s: string): Promise<SubmitTurnResponse>[] {
  return [...this.accepting.entries()].flatMap(([key, value]) => {
    const [owner, session] = JSON.parse(key) as [string, string, string];
    return owner === u && session === s ? [value.promise] : [];
  });
}
// hasScopedAcceptance(u,s) is scopedAcceptancePromises(u,s).length !== 0.
// scopedExecutionPromises(u,s) returns [...(this.executing.get(this.sessionKey(u,s)) ?? [])].
```

`MemoryText.temporaryPurgeBusy` considers hydration/loading, active/unsettled entries, dirty foundation, running compaction, and owned actual archive. `settleTemporaryPurge`: await an existing scoped hydration with `boundedResult`, cancel the matching accepted unattached RAM turn via `cancel` using its own mode, abort and wait the scoped compactor (guard its publication after abort), and `await foundation.flushSession(s)`; refuse native pending/uncertain effects and unsettled holds. Use `evictClean(sessionId, bypassRetention = true)` after a confirmed purge so only the retention clock is ignored; keep the existing active/job/version fences. `dropTemporarySession` removes `cold`, attempt entries and its observer cache; clear any scheduler slot (ephemeral should have none). Do not abort/evict another owner's session. For normal successful soft delete, cancel passive scheduling for that session (via AppService's `sessions.delete` delegate after success); rename/pin must not affect it.

For AppService's owned `sessions.hardPurgeSession` bridge:

```ts
hardPurgeSession: (u, s) => this.trackConfigJob(async () => {
  const runtime = this.rawRuntime;
  if (this.configClosing || !runtime?.purgeEphemeral)
    throw new AppError('NOT_READY', 'Temporary chat deletion is unavailable.');
  const purged = await runtime.purgeEphemeral(u, s, { stopTransport: async () => {
    await this.transport?.closeConversation(u, s);
    // Task 10 adds scoped Live Voice end/release to this callback.
  } });
  if (!purged) throw new AppError('NOT_FOUND', 'Chat not found.');
}),
```

`AppService.reservations()` must fence new acquire/bind for the scoped conversation by calling `assertConversationAdmission` on the raw durable runtime before delegation; **never** make purge-busy part of the shared `ExecutionReservations` `busy` predicate because `release()` uses it too. Existing Live Voice teardown must be allowed to release the slot. `hardPurgeSession` never opens a provider on its own; if unresolved effects, ambiguous owner/flush, blocked transport, or ownership loss persist, leave the root/evidence for retry/recovery and return non-204. A failed partial cascade is safe to retry because P3 fences the durable root before deleting children. Missing after confirmed purge can be 204 if the scoped tombstone is known, otherwise 404 (no existence leak across owners).

- [ ] **Verify green.** `npm test -- test/runtime/user-memory-runtime.spec.ts src/persistence/ephemeral-purge.spec.ts test/http/session-actions.spec.ts test/http/private-boundary.spec.ts`; `npm run test:e2e -- test/http/routes.e2e-spec.ts`. Verify 204 means actual paused work settled and storage cascade confirmed, not cancellation requested. Keep the normal soft-delete contract.
- [ ] **Commit.** Stage only P4's AppService hunks.

```sh
git add -- backend/src/chat-runtime/ports.ts backend/src/chat-runtime/durable-chat-runtime.ts backend/src/chat-runtime/memory-text.ts backend/src/chat-runtime/memory-first-foundation.ts backend/src/http/chat-http.controller.ts backend/src/http/chat-http.service.ts backend/src/http/validation.ts backend/src/http/chat-stream.transport.ts backend/test/runtime/user-memory-runtime.spec.ts
git add -p -- backend/src/app.service.ts
git diff --cached -- backend/src/app.service.ts
git commit -m "feat(chat): hard purge temporary conversations behind scoped quiescence"
```

### Task 10: Pass trusted Temporary Chat classification through Live Voice conditionally

**Files:** Modify `backend/src/voice/session/voice-session.service.ts`, `backend/src/voice/agent/agent-voice-adapter.ts`, `backend/src/app.service.ts`, and `backend/test/runtime/user-memory-runtime.spec.ts`. Do not edit `voice-wire.ts`, `voice-session.options.ts`, or any frontend files.

- [ ] **Write the failing tests.** Import `VoiceSessionService`, `type VoiceTurnContext` from `../../src/voice/session/voice-session.service.js`, `AgentVoiceAdapter` from `../../src/voice/agent/agent-voice-adapter.js`, and `createSessionFixture`, `createSessionResponseFixture` from `../../src/contracts/testing/voice-fixtures.js`. Reuse the inactive configuration to prove default denial **before admission/paid work**, and a trusted voice context to verify both the positive conditional and the absence on ordinary calls:

```ts
it('does not enable Temporary Live Voice by accepting an optional wire flag', async () => {
  const f = assemblyFixture();
  const service = await AppService.create(f.bootstrap, f.ports);
  const owner = admitAccount(admittedAccount({ userId: stored.userId }), 'sid_1');
  const admit = vi.spyOn(service.voiceSessions.options, 'admission');
  try {
    await expect(service.voiceSessions.create({ ...createSessionFixture('live'), ephemeral: true },
      f.bootstrap.frontendOrigin, owner)).rejects.toMatchObject({ code: 'INVALID_VOICE_REQUEST' });
    expect(admit).not.toHaveBeenCalled();
  } finally { await service.operations.shutdown(); }
});

it('conditionally forwards trusted temporary mode only when Live Voice creates a new conversation', async () => {
  const r = await rig();
  const initial = await r.f.runtime.reservations.acquire({ identity: r.f.identity, conversationId: null,
    owner: { kind: 'live', voiceSessionId: 'voice-temp-admitted' } });
  const submit = vi.spyOn(r.f.runtime, 'submitLiveTurn');
  try {
    const context: VoiceTurnContext = {
      identity: r.f.identity, voiceConfig: r.snapshot.voice, configSnapshot: r.snapshot,
      response: createSessionResponseFixture('live', { sessionId: 'voice-temp-admitted' }),
      reservation: initial, ephemeral: true,
    };
    const bridge = new AgentVoiceAdapter(r.f.runtime, async (_id, conversationId) => {
      context.reservation = await r.f.runtime.reservations.bindConversation({
        identity: context.identity, reservationId: initial.reservationId, conversationId });
      context.response.conversationId = conversationId;
    });
    const ids = (await bridge.submit(context, { providerSocketEpoch: 1, providerTurnId: 'fresh', text: 'First' }, true))!;
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ ephemeral: true, freshConversation: true });
    expect(r.f.runtime.memorySession(r.f.identity.userId, ids.sessionId)?.ephemeral).toBe(true);
    const next = { providerSocketEpoch: 1, providerTurnId: 'next', text: 'Follow up' };
    await r.f.runtime.cancelLiveTurn({ identity: r.f.identity, ...ids }, context.reservation!);
    await bridge.submit(context, next);
    expect(submit.mock.calls[1]?.[0]).not.toHaveProperty('ephemeral');
    expect(r.cachedSnapshot).not.toHaveBeenCalled();
  } finally { await r.f.dispose(); }
});
```

Add a positive `VoiceSessionService` gated fixture using the existing test port setup in `backend/test/voice/session/controller.spec.ts`: inject `allowTemporaryLive: true`, capture the `SessionContext` delivered to a fake admission, and assert that only an accepted live creation gets `ephemeral: true`. Test a live attach to an existing scoped Temporary Chat denied with the gate off (even when the body omits `ephemeral`), and an attempt to relabel a persistent conversation rejected without new admission.

- [ ] **Verify red.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "Temporary Live Voice|conditionally forwards"` — service/bridge do not gate and forward the mode.
- [ ] **Implement controlled propagation.** In `voice-session.service.ts`, use the local optional type and options extension:

```ts
export type VoiceTurnContext = SessionContext & { readonly ephemeral?: true };
type VoiceOptions = VoiceSessionOptions & { readonly allowTemporaryLive?: boolean };
// VoiceBinding extends VoiceTurnContext instead of SessionContext.
// constructor(@Inject(VOICE_SESSION_OPTIONS) readonly options: VoiceOptions) ...
```

In `create`, after `isCreateVoiceSessionRequest` and `requireFullAccount`, reject `body.ephemeral === true` unless `body.mode === 'live' && options.allowTemporaryLive === true` — before `assertAccountCurrent`, reservation, or `admission`. This is only an internal seam; **leave AppService unset**. In `createOnce`, replace the current existence check:

```ts
const conversation = body.conversationId === null ? null
  : await this.options.sessions.get(identity.userId, body.conversationId);
if (body.conversationId !== null && (!conversation || conversation.lifecycle !== 'active'
    || conversation.userId !== identity.userId || conversation.sessionId !== body.conversationId))
  fault('VOICE_BINDING_MISMATCH');
const ephemeral = conversation ? conversation.ephemeral === true : body.ephemeral === true;
if ((body.ephemeral !== undefined && conversation && body.ephemeral !== ephemeral) ||
    (ephemeral && (body.mode !== 'live' || this.options.allowTemporaryLive !== true)))
  fault('VOICE_BINDING_MISMATCH');
// context: VoiceTurnContext = { ...existing fields, ...(ephemeral ? { ephemeral: true } : {}) }
```

At `matches`, include the original creation classification (`(e.request.ephemeral === true) === (r.ephemeral === true)` for fresh requests; for an attached request any supplied assertion must agree with `e.ephemeral === true`). A duplicate/reconnect cannot reclassify. Keep the field internal and the stored chat classification authoritative on attach. In `AgentVoiceAdapter`, use `VoiceTurnContext` for `finalized`/`submit` (type-only import) and include the same conditional in the existing `findLiveSubmission` and `submitLiveTurn` calls:

```ts
...(freshConversation && c.ephemeral === true ? { ephemeral: true } : {}),
```

A later `SubmitLiveTurn` inherits the already bound conversation's mode. Do not widen a speech or Canvas control payload, mint a new voice session, or add DB/LLM work on finalized speech. Existing voice control-plane account/session checks remain. `VoiceSessionService.stopConversation(u,s)` selects only admitted entries scoped by owner and `response.conversationId`, for live only; revoke tickets before ending:

```ts
async stopConversation(u: string, s: string): Promise<void> {
  const selected = [...this.entries.values()].filter(e => e.identity.userId === u &&
    e.response.mode === 'live' && e.response.conversationId === s);
  for (const e of selected) { e.token = null; e.tokenHash = null; }
  await Promise.all(selected.map(e => this.end(e.response.sessionId)));
}
```

Add it to AppService's **explicit DELETE** callback alongside `closeConversation`; await both, leave failure non-204. Do not purge on ordinary voice barge-in, reconnect, call end, unrelated navigation, or the voice-session DELETE; leaving the **chat** is the purge event. Do not change the existing `conversation.bound` or LiveKit control wire; the shared runtime completion/visible assistant is the indicator source. See the downstream note below for the product switch.

- [ ] **Verify green.** `npm test -- test/runtime/user-memory-runtime.spec.ts test/voice/session/controller.spec.ts test/voice test/performance/memory-first-voice.spec.ts test/performance/voice-critical-path.spec.ts`; `npm run build`. Verify default gate stays off in production and neither gated nor normal voice adds pre-model I/O after warmed admission.
- [ ] **Commit.** Stage only P4's AppService hunks.

```sh
git add -- backend/src/voice/session/voice-session.service.ts backend/src/voice/agent/agent-voice-adapter.ts backend/test/runtime/user-memory-runtime.spec.ts
git add -p -- backend/src/app.service.ts
git diff --cached -- backend/src/app.service.ts
git commit -m "feat(voice): bind temporary conversation mode without enabling it"
```

### Task 11: Sweep orphaned temporary conversations on startup and hourly

**Files:** Modify `backend/src/app.service.ts` and `backend/test/runtime/user-memory-runtime.spec.ts`.

- [ ] **Write the failing lifecycle test.** Import `EPHEMERAL_SESSION_MAX_AGE_MS` from `../../src/persistence/sessions.js` and `session` from `../persistence/fixtures.js`. Reuse the fixture's real store and scoped runtime. To test the timer without changing driver/stale deadlines, virtualize `setInterval`/`clearInterval` and control the cutoff clock explicitly:

```ts
it('sweeps a bounded over-24-hour Temporary page at startup and hourly, then stops on shutdown', async () => {
  const r = await rig();
  const f = assemblyFixture();
  const now = Date.now();
  const older = new Date(now - EPHEMERAL_SESSION_MAX_AGE_MS - 1).toISOString();
  const exact = new Date(now - EPHEMERAL_SESSION_MAX_AGE_MS).toISOString();
  const u = r.f.identity.userId;
  stubCascade(r);
  const put = (id: string, lastActivityAt: string, ephemeral: boolean) =>
    r.p.sessions.createIfAbsent({ ...session(u, id), lastActivityAt, ...(ephemeral ? { ephemeral: true } : {}) });
  await put('startup-old', older, true);
  await put('exact-cutoff', exact, true);
  await put('not-temporary', older, false);
  const list = vi.spyOn(r.p.sessions, 'listExpiredEphemeral');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  f.ports.open = async () => ({ ...r.p, close: async () => {} }) as never;
  f.ports.runtime = () => r.f.runtime;
  const service = await AppService.create(f.bootstrap, f.ports);
  try {
    await vi.waitFor(async () => expect(await r.p.sessions.get(u, 'startup-old')).toBeNull());
    expect((await r.p.sessions.get(u, 'exact-cutoff'))?.ephemeral).toBe(true);
    expect(list).toHaveBeenCalledExactlyOnceWith(exact, Math.min(50, DEFAULT_BUDGETS.maxPageSize));
    expect(await r.p.sessions.get(u, 'not-temporary')).not.toBeNull();
    clock.mockReturnValue(now + 3_600_000);
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(async () => expect(await r.p.sessions.get(u, 'exact-cutoff')).toBeNull());
    expect(list).toHaveBeenCalledTimes(2);
    expect(await service.operations.shutdown()).toMatchObject({ safe: true });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore(); vi.useRealTimers();
    await service.operations.shutdown(); await r.f.dispose();
  }
});
```

Add a sweep gate test holding `listExpiredEphemeral` with `Promise.withResolvers`: advance two hourly ticks, assert one in-flight call; start shutdown, release the page, assert it does not begin more deletes, and no further interval runs. Task 9's held archive covers active-session skipping. Add an exact-cutoff stale-candidate race by changing `lastActivityAt` after listing and verify runtime rechecks under the fence.

- [ ] **Verify red.** `npm test -- test/runtime/user-memory-runtime.spec.ts -t "over-24-hour Temporary"` — startup does not call indexed selection.
- [ ] **Implement the one bounded job.** Add `EPHEMERAL_SWEEP_INTERVAL_MS = 60 * 60_000` and fields for one timer and one in-flight promise to `AppService`. Call `startEphemeralSweep()` at the end of `initialize()`'s runtime try, after `this.rawRuntime = …` / `localRecoveryPending = false` and **before** the `catch`. Diagnostic/open-failure returns and the `current === null` local-recovery return must not reach it. The app is not made unready by a failed sweep. Tie it into the existing shutdown deadline:

```ts
private startEphemeralSweep(): void {
  if (this.configClosing || this.localRecoveryPending || this.ephemeralSweepTimer ||
      !this.rawRuntime?.purgeEphemeral || !this.persistence?.sessions.listExpiredEphemeral) return;
  const tick = () => this.sweepEphemeral();
  this.ephemeralSweepTimer = setInterval(tick, EPHEMERAL_SWEEP_INTERVAL_MS);
  this.ephemeralSweepTimer.unref?.();
  tick();
}

private sweepEphemeral(): void {
  const p = this.persistence, runtime = this.rawRuntime;
  if (this.configClosing || this.localRecoveryPending || this.ephemeralSweepJob ||
      !p?.sessions.listExpiredEphemeral || !runtime?.purgeEphemeral) return;
  const cutoff = new Date(Date.now() - EPHEMERAL_SESSION_MAX_AGE_MS).toISOString();
  const task = this.trackConfigJob(async () => {
    try {
      if (this.configClosing) return;
      await p.owner.assertExecutor();
      const rows = await p.sessions.listExpiredEphemeral(cutoff, Math.min(50, p.sessions.budgets.maxPageSize));
      let deferred = 0;
      // ponytail: one native indexed page per tick; use an indexed continuation
      // if persistently unresolved oldest rows fill a whole page.
      for (const row of rows) {
        if (this.configClosing) break;
        try { if (!await runtime.purgeEphemeral!(row.userId, row.sessionId, { cutoff })) deferred++; }
        catch { deferred++; }
      }
      if (deferred) this.telemetry.event('process', { stage: 'runtime-error', state: 'skipped', code: 'NOT_READY' });
    } catch {
      this.telemetry.event('process', { stage: 'runtime-error', state: 'error', code: 'PERSISTENCE_ERROR' });
    }
  });
  this.ephemeralSweepJob = task;
  const clear = () => { if (this.ephemeralSweepJob === task) this.ephemeralSweepJob = undefined; };
  void task.then(clear, clear);
}
```

Use only telemetry-admitted process fields (`stage: 'runtime-error'`, `state: 'skipped' | 'error'`, and an `APP_ERROR_CODES` `code`; never a custom stage, `count`, text, rows, or raw errors). In `stopConfig`, set the existing flag first and `clearInterval(this.ephemeralSweepTimer); this.ephemeralSweepTimer = undefined;`. No dispatch after stop; an already-issued driver operation is still tracked by `drainConfigJobs` and keeps the sentinel if uncertain. No provider recovery or force-deletion on age alone. If old unresolved rows repeatedly occupy all 50 slots, report those retained orphan blockers to the parent for safe operational reconciliation, rather than widening to an unbounded scan.

- [ ] **Verify green.** `npm test -- test/runtime/user-memory-runtime.spec.ts src/persistence/ephemeral-purge.spec.ts test/operations` and `npm run build`. Verify no duplicate timers, no `setInterval` in diagnostic startup, and no awaited writer or sweep on prepared chat/voice paths.
- [ ] **Commit.** Stage only P4's AppService hunks.

```sh
git add -- backend/test/runtime/user-memory-runtime.spec.ts
git add -p -- backend/src/app.service.ts
git diff --cached -- backend/src/app.service.ts
git commit -m "feat(chat): sweep expired temporary chats at startup and hourly"
```

## Exit gate and evidence

- [ ] Run `npm run build`, `npm run lint`, `npm test`, and `npm run test:e2e` in `backend/`; also run the new `npm test -- src/chat-runtime/user-memory-scheduler.spec.ts test/runtime/user-memory-runtime.spec.ts` without a name filter. Record each task's red/green evidence, commit ID, and tested vs skipped service/topology coverage. Run with no live OpenRouter/Google/LiveKit or inherited `AURVIN_TEST_MONGODB_URI`; native/real-service verification requires authorization and a separately admitted isolated target.
- [ ] Follow [AGENTS.md](../../AGENTS.md#tool-execution-critical-path). Run `npm test -- test/performance/calendar-tool-latency.spec.ts test/performance/calendar-memory-first.spec.ts test/performance/calendar-voice-latency.spec.ts test/runtime/calendar-memory-voice.spec.ts test/runtime/dev-mode-dispatch.spec.ts`; check all four `prepared … dispatches and continues with application storage blocked` cases, repeated prepared owner, held archive and confirmed-create continuation, both essential barrier-vs-archive cases, W1–W4 recovery, pinned-ID recovery, competing tabs, concurrent text/live confirmation, cancellation across dispatching CAS/success, exact expiry, revoked-account invalidation and `profiles …` cases. If a named case lives outside those paths, locate it with `rg -n "<name fragment>" test` and run its owning spec. Report foreground read/write/provider counts separately from off-path archive/writer/sweep activity, synthetic waves separately from `performance.now()` observations.
- [ ] Compare failures against the recorded P2/P3 baseline in [state.md](state.md#execution-record), not just suite totals. `backend/src/contracts/admin-config.spec.ts` (“mirrors only the public admin contract into the frontend”) is P5; `backend/src/contracts/voice.spec.ts` (“mirrors the entire portable voice contract”) is P6. Leave both untouched. Reproduce/report other pre-existing failures separately, including the locally guarded Web Search collection and existing voice bootstrap failures if present. Resolve any P4-attributable regression within scope or ask for a precise ownership transfer; never mark a failed check as passed. Unified review is **skipped**.
- [ ] Verify no unrelated paths/hunks were staged: `git diff --check` and `git show --stat <task-commit>` for each commit. Explicitly compare the pre-planning `speechSockets(signal)` diff and ensure it remains intact and unstaged. Do not edit this workflow's state/report from the worker; return evidence to the parent.

## Downstream contract notes for P6

- `POST /api/sessions` with the existing first-turn body (`sessionId: null`, `content`, `idempotencyKey`, negotiated Calendar protocol if required) may include `ephemeral: true`. The session mode is immutable; omit `ephemeral` on follow-up text turns and retries. Replays use the same creation flag and key; a new chat after exit uses a new key, not a retry of the purged creation. `GET /api/sessions/:id` exposes `ephemeral: true` for an owned active Temporary Chat. Both RAM overlay and durable sidebar omit it.
- `DELETE /api/sessions/:sessionId` is the guarded route for leaving Temporary Chat; no query, identity override, or separate endpoint. 204 means the purge was confirmed; 404 on a repeated attempt can mean already absent. Busy/uncertain outcomes can be retried after quiescence, and a failed `keepalive` is covered by the bounded startup/hourly 24h sweeper, not a guarantee of immediate deletion on OS/network crash. Persistent `DELETE` is still a soft delete.
- `completed.memoryUpdated === true` (including Calendar-compatible SSE) means confirmed explicit update for that assistant ID; never infer it from narration, a tool call, or a save-progress flag. Passive updates appear via `VisibleMessage.memoryUpdated === true` on a later normal transcript hydration, with no dedicated event/poll. Live Voice uses the existing terminal `conversation.bound`/transcript hydration seam; no new protocol field has been added to the LiveKit control payload. The marker is independent of the chat archive's save progress.
- Live Voice in Temporary Chat is a product decision, **not enabled** by this plan; ordinary Live Voice still reads/learns and supports the explicit tool. If approved, the backend gate and frontend must agree before exposure: existing Temporary conversations inherit their classification; only a fresh live creation on the trusted gated path sends `ephemeral: true`, never a follow-up or dictation. Otherwise keep Live Voice unavailable in Temporary Chat. The P6 mirror transfer is required regardless because the optional backend request field is already committed.
