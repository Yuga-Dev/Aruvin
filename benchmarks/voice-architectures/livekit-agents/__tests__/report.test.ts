/**
 * ============================================================================
 * FILE: report.test.ts
 * LOCATION: benchmarks/voice-architectures/livekit-agents/__tests__/report.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    deterministic report fixture; proof/cost/escaping assertions.
 *
 * ROLE IN PROJECT:
 *    Supplies P2's standalone framework candidate without changing Aurvin.
 *    Consumes only the isolated package and P1-owned run configuration.
 *
 * KEY COMPONENTS:
 *    - deterministic report fixture; proof/cost/escaping assertions.
 * ============================================================================
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { newReport } from '../../shared/compiler.js';
import { emptyTurn, offlinePreflight, type ArchitectureReport, type RunContext } from '../../shared/contracts.js';
import { SecretRedactor } from '../../shared/credentials.js';
import { formatLivekitReport, withLivekitBoundaries, writeReport } from '../report.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const result = newReport('livekit-agents', '10000000-0000-4000-8000-000000000001',
  'dry-run', offlinePreflight('livekit-agents', ['BLOCKED_SILERO_NATIVE_LOAD']));

it('formats the exact LiveKit report destination with honest blocked and proof boundaries', () => {
  const text = formatLivekitReport(result);
  expect(text).toContain('# livekit-agents voice architecture screening');
  expect(text).toContain('BLOCKED_SILERO_NATIVE_LOAD');
  expect(text).toContain('No turns submitted');
  expect(text).toContain('not physical audibility');
  expect(text).toContain('stream abort + RoomIO buffer clear');
  expect(text).toContain('framework-playback-estimated');
  expect(text).toContain('review: skipped');
  expect(formatLivekitReport(result)).toBe(text);
  expect(withLivekitBoundaries(withLivekitBoundaries(result)))
    .toEqual(withLivekitBoundaries(result));
});

it('uses shared null/escaping/group behavior and keeps all six attempted outcomes', () => {
  const turns = Array.from({ length: 6 }, (_, index) => ({
    ...emptyTurn('livekit-agents', index),
    outcome: 'failed' as const, failureCode: `fixture|reason-${index}`,
    durableCompletionStatus: 'not-applicable' as const,
  }));
  const text = formatLivekitReport({ ...result, turns });
  expect(text).toContain('fixture\\|reason');
  expect(text).toContain('unknown');
  for (let index = 0; index < 6; index++) expect(text).toContain(`reason-${index}`);
  expect(text).toContain('Ordinary/Warm');
  expect(text).toContain('Interruption');
});

it('keeps every attempt, zeros, and unknown costs distinct across outcomes', () => {
  const turns: ArchitectureReport['turns'] = [
    { ...emptyTurn('livekit-agents', 0), outcome: 'blocked', submitted: false,
      durableCompletionStatus: 'not-applicable', setupMs: 0 },
    { ...emptyTurn('livekit-agents', 1), outcome: 'completed',
      durableCompletionStatus: 'not-applicable', speechEndToFirstAudioMs: 12 },
    { ...emptyTurn('livekit-agents', 2), outcome: 'early-endpoint', earlyEndpoint: true,
      durableCompletionStatus: 'not-applicable', speechEndToFirstAudioMs: null },
    { ...emptyTurn('livekit-agents', 3), outcome: 'failed', failureCode: 'fixture-fail',
      durableCompletionStatus: 'not-applicable' },
    { ...emptyTurn('livekit-agents', 4), outcome: 'interrupted-ok',
      interruptionAnchorObserved: true, interruptionToCutoffMs: null,
      interruptionAttribution: 'boundary-window-only',
      durableCompletionStatus: 'not-applicable' },
    { ...emptyTurn('livekit-agents', 5), outcome: 'timeout', failureCode: 'BENCHMARK_TIMEOUT',
      durableCompletionStatus: 'not-applicable' },
  ];
  const report = { ...result, mode: 'live' as const, turns };
  const text = formatLivekitReport(report);
  expect(text).toContain('reason-'.slice(0, 0) + 'fixture-fail');
  expect(text).toContain('BENCHMARK_TIMEOUT');
  expect(text).toContain('unknown');
  expect(text).toContain('| 0 |');
  expect(text).not.toContain('$0');
  expect(JSON.stringify(withLivekitBoundaries(report))).toContain('"providerReportedUsd":null');
  expect(text).toContain('framework-playback-estimated');
});

it('refuses both artifacts when a secret sentinel is present', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-p2-'));
  roots.push(directory);
  const context: RunContext = {
    mode: 'dry-run', runId: result.runId, repoRoot: resolve('../..'),
    packageRoot: process.cwd(), outputDir: directory,
    startedAtIso: '2026-11-16T00:00:00.000Z', clock: { now: () => 0 },
    signal: new AbortController().signal, credentials: null, guard: null, corpus: [],
    redactor: new SecretRedactor(['fixture-private-sentinel']),
  };
  const secret = { ...result, limitations: [...result.limitations, 'fixture-private-sentinel'] };
  await expect(writeReport(context, secret)).rejects.toThrow('BENCHMARK_REDACTION_FAILED');
  await expect(readFile(resolve(directory, 'livekit-agents/report.md'), 'utf8'))
    .rejects.toThrow();
});

it('writes the shared markdown to the candidate report path on a safe fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-p2-'));
  roots.push(directory);
  const context: RunContext = {
    mode: 'dry-run', runId: result.runId, repoRoot: resolve('../..'),
    packageRoot: process.cwd(), outputDir: directory,
    startedAtIso: '2026-11-16T00:00:00.000Z', clock: { now: () => 0 },
    signal: new AbortController().signal, credentials: null, guard: null, corpus: [],
    redactor: new SecretRedactor(['fixture-private-sentinel']),
  };
  const written = await writeReport(context, result);
  expect(written.markdown).toBe(formatLivekitReport(result));
  expect(await readFile(resolve(directory, 'livekit-agents/report.md'), 'utf8'))
    .toBe(written.markdown);
});
