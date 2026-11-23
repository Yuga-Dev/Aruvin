/**
 * ============================================================================
 * FILE: report.test.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/__tests__/report.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Check shared-report integration for Deepgram's zero-network policy block.
 *
 * ROLE IN PROJECT:
 *    Offline P3 evidence serialization checks.
 *    No fixture result is presented as a live provider observation.
 *
 * KEY COMPONENTS:
 *    - Report checks: Unknown metrics, policy reasons, boundaries and counts.
 *    - Writer checks: Existing shared redaction and owned candidate paths.
 * ============================================================================
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { reportSchema, type RunContext } from '../../shared/contracts.js';
import { newReport } from '../../shared/compiler.js';
import { SecretRedactor } from '../../shared/credentials.js';
import { makeBlockedRun, preflightDeepgramAgent } from '../harness.js';
import { renderDeepgramReport, writeReport } from '../report.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(), writeFile: vi.fn() };
});
afterEach(() => vi.clearAllMocks());
const runId = '00000000-0000-4000-8000-000000000003';
const at = '2026-11-16T00:00:00.000Z';
function context(): RunContext {
  return {
    mode: 'dry-run', runId, startedAtIso: at,
    repoRoot: process.cwd(), packageRoot: process.cwd(),
    outputDir: resolve('results', 'fixture-p3'),
    clock: { now: () => 0 }, signal: new AbortController().signal,
    credentials: null, guard: null, corpus: [],
    redactor: new SecretRedactor(['fixture-secret']),
  };
}

it('formats US$0 policy and nulls even when the runner skips the blocked run method', () => {
  const p = preflightDeepgramAgent(at);
  // This is P1's actual blocked-selection path: run() is not called.
  const result = newReport('deepgram-agent', runId, 'live', p);
  expect(reportSchema.parse(result).turns).toEqual([]);
  const text = renderDeepgramReport(result);
  for (const expected of [
    '# deepgram-agent voice architecture screening',
    'BLOCKED_BYO_CONTROLS_UNSUPPORTED', 'US$0 spent',
    'max_tokens / max_completion_tokens', 'provider.allow_fallbacks: false',
    'OpenAI-only model enum', 'not physical speaker audibility',
    '"modelFirstOutputMs": null', '"ttsFirstAudioMs": null',
    '"generationId": null', '"providerReportedUsd": null',
    '"submittedTurns": 0', 'Review skipped',
  ]) expect(text).toContain(expected);
  expect(text).not.toContain('p95: 0');
  expect(result.turns).toHaveLength(0);
});

it('uses the shared validated writer and candidate-owned result/report paths', async () => {
  const ctx = context();
  await writeReport(ctx, makeBlockedRun('dry-run', at, runId));
  expect(vi.mocked(writeFile).mock.calls.map(([path]) => String(path))).toEqual([
    resolve(ctx.outputDir, 'deepgram-agent', 'result.json'),
    resolve(ctx.outputDir, 'deepgram-agent', 'report.md'),
  ]);
  expect(writeFile).toHaveBeenCalledWith(
    expect.any(String), expect.any(String), expect.objectContaining({ flag: 'wx' }),
  );
});

it('fails redaction before any report directory or file is written', async () => {
  const result = makeBlockedRun('dry-run', at, runId);
  result.provenance.injectedSecret = 'fixture-secret';
  await expect(writeReport(context(), result)).rejects.toThrow('BENCHMARK_REDACTION_FAILED');
  expect(mkdir).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
});
