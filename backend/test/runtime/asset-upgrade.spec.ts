/**
 * ============================================================================
 * FILE: asset-upgrade.spec.ts
 * LOCATION: backend/test/runtime/asset-upgrade.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify existing chats reopen after instructions/knowledge hashes change.
 *
 * ROLE IN PROJECT:
 *    Proves the memory-first and durable admission paths upgrade only asset
 *    versions while still refusing schema changes and boundary disagreement.
 *
 * KEY COMPONENTS:
 *    - fixture: Shared cold-runtime setup over an in-memory persistence bundle.
 *    - MemoryTextRuntime cases: hydration upgrade, schema mismatch, boundary mismatch.
 *    - DurableChatRuntime cases: same upgrade/rejection guarantees.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import type { FixedAssets } from '../../src/instructions/fixed-assets.js';
import type { PersistenceBundle } from '../../src/persistence/persistence.js';
import { ReferencedContextAssembler } from '../../src/context/referenced-context-assembler.js';
import { DurableChatRuntime } from '../../src/chat-runtime/durable-chat-runtime.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { graphConfig } from '../../src/chat-runtime/finalization.js';
import { key } from '../../src/persistence/records.js';
import { boundaryFor } from '../../src/agent/state.js';
import { textConfigFixture, type TextConfigFixture } from './text-config-fixture.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { assets as fixtureAssets } from '../context/fixtures.js';

const oldAssets: FixedAssets = { ...fixtureAssets,
  instructionVersion: 'c'.repeat(64), knowledgeContentHash: 'd'.repeat(64) };
const newAssets: FixedAssets = { ...fixtureAssets,
  instructionVersion: 'e'.repeat(64), knowledgeContentHash: 'f'.repeat(64) };

async function fixture(memoryFirst: boolean, assets: FixedAssets = oldAssets) {
  const memory = calendarMemory();
  const client = Object.assign(memory.commandSource,
    { db: () => memory.store.db, appendMetadata: () => undefined }) as unknown as MongoClient;
  const p = await createPersistenceBundle(client, 'offline-asset-upgrade', DEFAULT_BUDGETS, 'offline-asset-executor');
  const assembler = new ReferencedContextAssembler({ memory: p.memory, messages: p.messages,
    metadata: p.metadata, budgets: textSnapshot(1).budgets, assets });
  const f = textConfigFixture(textSnapshot(1), d => ({ ...d, assets, assembler,
    ...(memoryFirst ? { memoryFirst: { policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 30 } } } : {}) }), p);
  return { f, p };
}

function coldRuntime(f: TextConfigFixture, p: PersistenceBundle, assets: FixedAssets) {
  return new DurableChatRuntime({ ...f.runtime.d, assets,
    assembler: new ReferencedContextAssembler({ memory: p.memory, messages: p.messages, metadata: p.metadata,
      budgets: textSnapshot(1).budgets, assets }) });
}

function fakeLease(userId: string, sessionId: string) {
  return { userId, sessionId, ownerId: 'test-executor', generation: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
}

async function savedManifest(p: PersistenceBundle, userId: string, sessionId: string) {
  const manifest = await p.memory.get(userId, sessionId);
  expect(manifest).not.toBeNull();
  return manifest!;
}

async function setManifestSchema(p: PersistenceBundle, userId: string, sessionId: string, value: string) {
  const result = await p.owner.store!.collection('agent-memory').updateOne(
    { _id: key('memory', userId, sessionId), userId, sessionId },
    { $set: { graphSchemaVersion: value }, $inc: { _revision: 1 } });
  expect(result.acknowledged).toBe(true);
}

async function corruptBoundary(runtime: DurableChatRuntime, p: PersistenceBundle,
  userId: string, sessionId: string) {
  const owned = await p.owner.acquire({ userId, sessionId, ownerId: p.owner.executorId, leaseMs: 60_000 });
  if (!owned.ok) throw new Error('Could not acquire the test lease.');
  try {
    const graph = await runtime.graph(owned.lease);
    await graph.updateState(graphConfig(userId, sessionId),
      { boundary: { contextVersion: 99, manifestHash: '0'.repeat(64) } }, 'seal');
  } finally {
    await p.owner.release(owned.lease);
  }
}

async function boundary(runtime: DurableChatRuntime, userId: string, sessionId: string) {
  const graph = await runtime.graph(fakeLease(userId, sessionId));
  return graph.getState(graphConfig(userId, sessionId));
}

async function firstTurn(f: TextConfigFixture, memoryFirst: boolean, content = 'First') {
  const ids = await f.submit(content);
  await f.execute(ids);
  if (memoryFirst) {
    await vi.waitFor(async () => expect((await f.runtime.getTurnStatus(f.identity.userId,
      ids.sessionId, ids.turnId)).save?.state).toBe('saved'));
  } else {
    expect(await f.runtime.getTurnStatus(f.identity.userId, ids.sessionId, ids.turnId))
      .toMatchObject({ status: 'completed' });
  }
  return ids;
}

it.each([
  ['instruction and knowledge versions', oldAssets],
  ['only the knowledge hash', { ...newAssets, instructionVersion: oldAssets.instructionVersion }],
] as const)('memory-first hydrates an existing chat whose %s changed and saves the upgrade', async (_label, previous) => {
  const { f, p } = await fixture(true, previous);
  const first = await firstTurn(f, true);
  expect(await p.memory.get(f.identity.userId, first.sessionId))
    .toMatchObject({ instructionVersion: previous.instructionVersion,
      knowledgeContentHash: previous.knowledgeContentHash });
  const cold = coldRuntime(f, p, newAssets);
  try {
    const second = await cold.submitTurn({ identity: f.identity, sessionId: first.sessionId,
      content: 'Second', idempotencyKey: `asset-upgrade-${previous.knowledgeContentHash.slice(0, 4)}` });
    await cold.executeTurn({ userId: f.identity.userId, ...second,
      signal: new AbortController().signal, emit: async () => {} });
    await vi.waitFor(async () => expect((await cold.getTurnStatus(f.identity.userId,
      second.sessionId, second.turnId)).save?.state).toBe('saved'));
    const upgraded = await savedManifest(p, f.identity.userId, first.sessionId);
    expect(upgraded).toMatchObject({ instructionVersion: newAssets.instructionVersion,
      knowledgeContentHash: newAssets.knowledgeContentHash, graphSchemaVersion: newAssets.graphSchemaVersion });
    const state = await boundary(cold, f.identity.userId, first.sessionId);
    expect(state.next).toEqual([]);
    expect(state.values.boundary).toEqual(boundaryFor(upgraded));
    const { items } = await p.messages.listForContext(f.identity.userId, first.sessionId, { cursor: null, limit: 20 });
    expect(items.map(item => item.content)).toEqual(['First', 'Hello 🌍', 'Second', 'Hello 🌍']);
    const body = JSON.parse(f.fetcher.mock.calls[1][1]?.body as string);
    expect(body.messages.filter((message: { role: string }) => message.role !== 'system')
      .map((message: { content: string }) => message.content)).toEqual(['First', 'Hello 🌍', 'Second']);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  } finally {
    await cold.drain(1000);
    await f.dispose();
  }
});

it('memory-first still refuses a graph schema mismatch', async () => {
  const { f, p } = await fixture(true);
  const first = await firstTurn(f, true);
  await setManifestSchema(p, f.identity.userId, first.sessionId, 'phase1.v0');
  const cold = coldRuntime(f, p, newAssets);
  try {
    await expect(cold.submitTurn({ identity: f.identity, sessionId: first.sessionId,
      content: 'Second', idempotencyKey: 'asset-schema-mismatch' }))
      .rejects.toMatchObject({ code: 'NOT_READY' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await cold.drain(1000);
    await f.dispose();
  }
});

it('memory-first still refuses when the checkpoint boundary disagrees with the stored manifest', async () => {
  const { f, p } = await fixture(true);
  const first = await firstTurn(f, true);
  const cold = coldRuntime(f, p, newAssets);
  try {
    await corruptBoundary(cold, p, f.identity.userId, first.sessionId);
    await expect(cold.submitTurn({ identity: f.identity, sessionId: first.sessionId,
      content: 'Second', idempotencyKey: 'asset-boundary-mismatch' }))
      .rejects.toMatchObject({ code: 'NOT_READY' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await cold.drain(1000);
    await f.dispose();
  }
});

it('durable chat continues an existing chat after asset versions change', async () => {
  const { f, p } = await fixture(false);
  const first = await firstTurn(f, false);
  expect(await p.memory.get(f.identity.userId, first.sessionId))
    .toMatchObject({ instructionVersion: oldAssets.instructionVersion,
      knowledgeContentHash: oldAssets.knowledgeContentHash });
  const cold = coldRuntime(f, p, newAssets);
  try {
    const second = await cold.submitTurn({ identity: f.identity, sessionId: first.sessionId,
      content: 'Second', idempotencyKey: 'durable-asset-upgrade' });
    await cold.executeTurn({ userId: f.identity.userId, ...second,
      signal: new AbortController().signal, emit: async () => {} });
    expect(await cold.getTurnStatus(f.identity.userId, second.sessionId, second.turnId))
      .toMatchObject({ status: 'completed' });
    const upgraded = await savedManifest(p, f.identity.userId, first.sessionId);
    expect(upgraded).toMatchObject({ instructionVersion: newAssets.instructionVersion,
      knowledgeContentHash: newAssets.knowledgeContentHash, graphSchemaVersion: newAssets.graphSchemaVersion });
    const state = await boundary(cold, f.identity.userId, first.sessionId);
    expect(state.next).toEqual([]);
    expect(state.values.boundary).toEqual(boundaryFor(upgraded));
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  } finally {
    await cold.drain(1000);
    await f.dispose();
  }
});

it('durable chat still refuses a graph schema mismatch', async () => {
  const { f, p } = await fixture(false);
  const first = await firstTurn(f, false);
  await setManifestSchema(p, f.identity.userId, first.sessionId, 'phase1.v0');
  const cold = coldRuntime(f, p, newAssets);
  try {
    await expect(cold.submitTurn({ identity: f.identity, sessionId: first.sessionId,
      content: 'Second', idempotencyKey: 'durable-schema-mismatch' }))
      .rejects.toMatchObject({ code: 'NOT_READY' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await cold.drain(1000);
    await f.dispose();
  }
});

it('durable chat refuses an old asset manifest whose checkpoint boundary disagrees', async () => {
  const { f, p } = await fixture(false);
  const first = await firstTurn(f, false);
  const cold = coldRuntime(f, p, newAssets);
  try {
    await corruptBoundary(cold, p, f.identity.userId, first.sessionId);
    await expect(cold.submitTurn({ identity: f.identity, sessionId: first.sessionId,
      content: 'Second', idempotencyKey: 'durable-boundary-mismatch' }))
      .rejects.toMatchObject({ code: 'NOT_READY' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await cold.drain(1000);
    await f.dispose();
  }
});
