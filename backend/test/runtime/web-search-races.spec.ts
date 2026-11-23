/**
 * ============================================================================
 * FILE: web-search-races.spec.ts
 * LOCATION: backend/test/runtime/web-search-races.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify disable, disconnect, cancellation, and replay races in the loop.
 *
 * ROLE IN PROJECT:
 *    Exercises the real MemoryText web path with a held provider result so a
 *    late response cannot publish sources, activities, or a second effect.
 *
 * KEY COMPONENTS:
 *    - fixture: Memory-first text runtime with a controllable web port.
 *    - race cases: disable/disconnect mid-call, cancellation, no replay.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import { textSnapshot } from '../model/config-snapshot.js';
import { textConfigFixture } from './text-config-fixture.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import type { SaveOutcome, TerminalEnvelope } from '../../src/chat-runtime/memory-first-foundation.js';
import type { StreamEnvelope } from '../../src/contracts/stream.js';
import {
  sse, textFrame, webPortFixture, webToolFrame,
} from './web-search-fixture.js';

const saved = (envelope: TerminalEnvelope): SaveOutcome => ({
  kind: 'saved', epoch: envelope.epoch, sessionId: envelope.sessionId,
  version: envelope.version, fence: envelope.fence,
});

function fixture() {
  const base = textSnapshot(1);
  const snapshot = { ...base, modelLimits: { ...base.modelLimits!, tools: true } };
  const web = webPortFixture();
  const f = textConfigFixture(snapshot, dependencies => ({
    ...dependencies, webSearch: web.port,
    memoryFirst: { policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 30 },
      save: async envelope => saved(envelope) },
  }));
  return { f, web };
}

const framesFor = () => {
  const frames: StreamEnvelope[] = [];
  return { frames, emit: async (frame: StreamEnvelope) => { frames.push(frame); } };
};

it('discards a late provider result after disable and publishes no source', async () => {
  const { f, web } = fixture();
  try {
    const hold = web.holdResult();
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'late_1')))
      .mockResolvedValueOnce(sse(textFrame("I couldn't verify this on the live web. Please try again.")));
    const ids = await f.submit('Search');
    const { frames, emit } = framesFor();
    const running = f.runtime.executeTurn({ userId: f.identity.userId, ...ids,
      signal: new AbortController().signal, emit });
    await hold.entered;
    web.setEnabled(false);
    hold.release();
    await running;
    expect(web.effects.web).toBe(1);
    expect(frames.some(frame => frame.event.type === 'web-sources')).toBe(false);
    const message = f.runtime.memoryMessages(f.identity.userId, ids.sessionId,
      { cursor: null, limit: 10 })?.items.at(-1);
    expect(message?.webSources).toBeUndefined();
    expect(message?.content).toContain("couldn't verify");
  } finally { await f.dispose(); }
});

it('discards a late provider result after disconnect and publishes no source', async () => {
  const { f, web } = fixture();
  try {
    const hold = web.holdResult();
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"fetch","url":"https://example.com/"}', 'late_2')))
      .mockResolvedValueOnce(sse(textFrame("I couldn't verify this on the live web. Please try again.")));
    const ids = await f.submit('Read https://example.com/');
    const { frames, emit } = framesFor();
    const running = f.runtime.executeTurn({ userId: f.identity.userId, ...ids,
      signal: new AbortController().signal, emit });
    await hold.entered;
    web.disconnect();
    hold.release();
    await running;
    expect(web.effects.web).toBe(1);
    expect(frames.some(frame => frame.event.type === 'web-sources')).toBe(false);
    const message = f.runtime.memoryMessages(f.identity.userId, ids.sessionId,
      { cursor: null, limit: 10 })?.items.at(-1);
    expect(message?.webSources).toBeUndefined();
  } finally { await f.dispose(); }
});

it('aborts a held call on cancellation without publishing a source', async () => {
  const { f, web } = fixture();
  try {
    const hold = web.holdResult();
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'cancel_1')))
      .mockResolvedValueOnce(sse(textFrame('A fallback answer.')));
    const ids = await f.submit('Search');
    const { frames, emit } = framesFor();
    const controller = new AbortController();
    const running = f.runtime.executeTurn({ userId: f.identity.userId, ...ids,
      signal: controller.signal, emit });
    await hold.entered;
    controller.abort();
    hold.release();
    await running;
    const status = await f.runtime.getTurnStatus(f.identity.userId, ids.sessionId, ids.turnId);
    expect(['cancelled', 'interrupted']).toContain(status.status);
    expect(web.effects.web).toBe(1);
    expect(frames.some(frame => frame.event.type === 'web-sources')).toBe(false);
    const message = f.runtime.memoryMessages(f.identity.userId, ids.sessionId,
      { cursor: null, limit: 10 })?.items.at(-1);
    expect(message?.webSources).toBeUndefined();
  } finally { await f.dispose(); }
});

it('sends zero provider work when disabled before execution', async () => {
  const { f, web } = fixture();
  try {
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'disabled_1')))
      .mockResolvedValueOnce(sse(textFrame("I couldn't verify this on the live web. Please try again.")));
    const ids = await f.submit('Search');
    web.setEnabled(false);
    await f.execute(ids);
    expect(web.effects.web).toBe(0);
    expect(web.executed).toHaveLength(0);
  } finally { await f.dispose(); }
});

it('sends zero provider work when disconnected before execution', async () => {
  const { f, web } = fixture();
  try {
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'disconnected_1')))
      .mockResolvedValueOnce(sse(textFrame("I couldn't verify this on the live web. Please try again.")));
    const ids = await f.submit('Search');
    web.disconnect();
    await f.execute(ids);
    expect(web.effects.web).toBe(0);
    expect(web.executed).toHaveLength(0);
  } finally { await f.dispose(); }
});

it('never replays a successful call ID in the same accepted turn', async () => {
  const { f, web } = fixture();
  try {
    f.fetcher
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'same')))
      .mockResolvedValueOnce(sse(webToolFrame('{"mode":"browse","query":"news"}', 'same', 'gen_same_2')))
      .mockResolvedValueOnce(sse(textFrame('Verified once.')));
    const ids = await f.submit('Search the news twice');
    await f.execute(ids);
    expect(web.effects.web).toBe(1);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  } finally { await f.dispose(); }
});
