/**
 * ============================================================================
 * FILE: contracts.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/contracts.test.ts
 * PURPOSE: Assert independent package and report boundary invariants.
 * ROLE IN PROJECT: Offline P1 contract check consumed before P2/P3 execution.
 * KEY COMPONENTS: Package pins; empty observations; no audible-proof claims.
 * ============================================================================
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { candidateIds, emptyTurn, reportSchema } from '../contracts.js';

describe('shared contract', () => {
  it('pins the real framework and all plugins without a root workspace', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    for (const name of ['@livekit/agents', '@livekit/agents-plugin-deepgram',
      '@livekit/agents-plugin-openai', '@livekit/agents-plugin-silero']) {
      expect(pkg.dependencies[name]).toBe('1.10.0');
    }
    expect(Object.values({ ...pkg.dependencies, ...pkg.devDependencies })
      .every(v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v))).toBe(true);
    expect(pkg.workspaces).toBeUndefined();
    expect(candidateIds).toEqual(['aurvin', 'livekit-agents', 'deepgram-agent']);
  });
  it('does not turn missing measurements into zeros or heard playback', () => {
    const turn = emptyTurn('aurvin', 1);
    expect(turn.speechEndToFirstAudioMs).toBeNull();
    expect(turn.interruptionToCutoffMs).toBeNull();
    expect(turn.submitted).toBe(false);
    expect(turn.decodedPlaybackProof).toBe('unproven-headless-pcm-only');
    expect(turn.durableCompletionStatus).toBe('unknown');
    expect(reportSchema.safeParse({ candidate: 'fictional' }).success).toBe(false);
  });
});
