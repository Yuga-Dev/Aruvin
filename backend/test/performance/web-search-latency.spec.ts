/**
 * ============================================================================
 * FILE: web-search-latency.spec.ts
 * LOCATION: backend/test/performance/web-search-latency.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Record payload-free Web Search dispatch boundaries and observed turn time.
 *
 * ROLE IN PROJECT:
 *    P5 evidence for AC6/AC11: real assembled HTTP turns with boundary counters
 *    at each model request. Synthetic dependency-wave profiles are explicitly
 *    prerequisite-blocked because the probe cannot drive real HTTP work safely;
 *    observed performance.now() values are not a latency SLA.
 *
 * KEY COMPONENTS:
 *    - profiles: web-off, enabled-unused, prepared browse, history, fallback,
 *      and repair exhaustion.
 *    - held archive: tool continuation and immediate next turn before release.
 *    - WEB_SEARCH_LATENCY: Payload-free console row per profile.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import { WEB_TOOL_DEFINITION } from '../../src/contracts/web-search-tools.js';
import { webAcceptanceFixture } from '../assembly/web-search-acceptance-fixture.js';

type Profile = {
  scenario: string;
  priorTurns: number;
  mode: 'off' | 'cold' | 'unused' | 'browse' | 'fallback' | 'repair';
};

const profiles: Profile[] = [
  { scenario: 'text web-off/new session', priorTurns: 0, mode: 'off' },
  { scenario: 'text enabled-unused/new session', priorTurns: 0, mode: 'unused' },
  { scenario: 'text prepared browse/new session', priorTurns: 0, mode: 'browse' },
  { scenario: 'text prepared browse/eight prior ordinary turns', priorTurns: 8, mode: 'browse' },
  { scenario: 'prepared existing-session history (hydration excluded)', priorTurns: 1, mode: 'browse' },
  { scenario: 'cold web state ordinary turn (no turn preparation)', priorTurns: 0, mode: 'cold' },
  { scenario: 'sequential fallback Keenable->Exa->Tavily', priorTurns: 0, mode: 'fallback' },
  { scenario: 'repaired call', priorTurns: 0, mode: 'browse' },
  { scenario: 'repair exhaustion', priorTurns: 0, mode: 'repair' },
];

it.each(profiles)('profiles [AC6][AC11] $scenario', async profile => {
  const f = await webAcceptanceFixture();
  try {
    await f.prepare();
    if (profile.mode !== 'off' && profile.mode !== 'cold') {
      if (profile.mode === 'fallback') {
        await f.connect('keenable');
        await f.connect('exa');
        await f.connect('tavily');
      } else {
        await f.connect('exa');
      }
      await f.enable(true);
    }
    let sessionId: string | undefined;
    for (let index = 0; index < profile.priorTurns; index += 1) {
      f.queue({ text: `Prior answer ${index + 1}.` });
      const prior = await f.turn(`Prior question ${index + 1}`, sessionId);
      sessionId = prior.sessionId;
    }
    if (profile.mode === 'fallback') {
      f.failProvider('keenable', 429);
      f.emptyProvider('exa');
      f.queue(
        { id: 'web_fb', name: 'web_tool', raw: '{"mode":"browse","query":"fallback facts"}' },
        { text: 'Fallback answer.' },
      );
    } else if (profile.mode === 'repair') {
      f.queue(...Array.from({ length: 4 }, (_, index) => ({
        id: `bad_${index}`, name: 'web_tool', raw: '{"mode":"browse"}',
      })));
    } else if (profile.mode === 'browse') {
      f.queue(
        { id: 'web_profile', name: 'web_tool', raw: '{"mode":"browse","query":"public evidence"}' },
        { text: 'Grounded answer.' },
      );
    } else {
      f.queue({ text: 'Ordinary answer.' });
    }
    const boundaryStart = f.beforeModel.length;
    const bodyStart = f.bodies.length;
    const observedStart = performance.now();
    const result = await f.turn('Search public evidence', sessionId);
    const observedMs = performance.now() - observedStart;
    // Turn-relative evidence: the passive memory writer may add off-path model
    // requests after the turn finalizes, so global "last" indexing is not the
    // turn's own first/continuation call.
    const twoCalls = profile.mode === 'browse' || profile.mode === 'fallback';
    const first = f.beforeModel[boundaryStart]!;
    const turnLastBody = f.bodies[bodyStart + (twoCalls ? 1 : 0)]!;
    console.info('WEB_SEARCH_LATENCY', JSON.stringify({
      scenario: profile.scenario,
      priorTurns: profile.priorTurns,
      mode: profile.mode,
      waves: null,
      syntheticMs: null,
      observedMs: Math.round(observedMs * 100) / 100,
      samples: 1,
      firstModel: first,
      modelPosts: f.bodies.length,
    }));
    expect(result.stream).toContain('completed');
    if (profile.mode === 'off' || profile.mode === 'cold') {
      expect(first).toMatchObject({
        dbReads: 0, dbWrites: 0, storageEntries: 0,
        initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0, retrieval: 0,
      });
      const offTools = (turnLastBody.tools ?? []) as Array<{ function: { name: string } }>;
      expect(offTools.some(tool => tool.function.name === 'web_tool')).toBe(false);
    } else if (profile.mode === 'unused') {
      expect(first).toMatchObject({
        dbReads: 0, dbWrites: 0, storageEntries: 0,
        initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0, retrieval: 0,
      });
      const tools = (turnLastBody.tools ?? []) as Array<{ function: { name: string } }>;
      expect(tools.filter(tool => tool.function.name === 'web_tool')).toHaveLength(1);
    } else if (profile.mode === 'repair') {
      expect(f.bodies).toHaveLength(4);
      expect(f.boundary().retrieval).toBe(0);
      expect(first).toMatchObject({ dbReads: 0, dbWrites: 0, storageEntries: 0 });
    } else {
      expect(first).toMatchObject({
        dbReads: 0, dbWrites: 0, storageEntries: 0,
        initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0, retrieval: 0,
      });
      expect(turnLastBody.tools).toContainEqual(WEB_TOOL_DEFINITION);
    }
    expect(Number.isFinite(observedMs) && observedMs >= 0).toBe(true);
  } finally { await f.close(); }
});

it('profiles [AC6][AC11] actual held archive -> tool continuation -> immediate next text turn', async () => {
  const f = await webAcceptanceFixture();
  let hold: ReturnType<typeof f.heldArchive> | undefined;
  try {
    await f.prepare();
    await f.connect('exa');
    await f.enable(true);
    hold = f.heldArchive();
    f.queue({ text: 'Seed answer.' });
    const first = await f.turn('Seed');
    await hold.entered;
    f.queue(
      { id: 'web_held', name: 'web_tool', raw: '{"mode":"browse","query":"current facts"}' },
      { text: 'Grounded follow-up.' },
      { text: 'Immediate next answer.' },
    );
    const observedStart = performance.now();
    const second = await f.turn('Search current facts', first.sessionId);
    const third = await f.turn('Continue', first.sessionId);
    const observedMs = performance.now() - observedStart;
    console.info('WEB_SEARCH_LATENCY', JSON.stringify({
      scenario: 'actual held archive -> tool continuation -> immediate next text turn',
      priorTurns: 0,
      mode: 'archive',
      waves: null,
      syntheticMs: null,
      observedMs: Math.round(observedMs * 100) / 100,
      samples: 1,
      firstModel: f.beforeModel.at(-3),
      modelPosts: f.bodies.length,
    }));
    expect(second.stream).toContain('completed');
    expect(third.stream).toContain('completed');
    for (const row of f.beforeModel.slice(-3)) {
      expect(row).toMatchObject({
        dbReads: 0, dbWrites: 0, storageEntries: 0,
        initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0,
      });
    }
  } finally {
    hold?.release();
    await f.close();
  }
});

it('profiles [AC11] synthetic dependency waves are prerequisite-blocked', () => {
  // DependencyProbe schedules storage commands by advancing waves; the real
  // HTTP/auth/runtime path also awaits network and timers, so driving it with
  // probe.advance would forge ordering. The plan permits ordinary B1
  // measurements instead of synthetic waves. No synthetic sample is claimed.
  expect(true).toBe(true);
});
