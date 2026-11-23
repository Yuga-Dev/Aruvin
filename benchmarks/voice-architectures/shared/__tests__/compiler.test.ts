/**
 * ============================================================================
 * FILE: compiler.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/compiler.test.ts
 * PURPOSE: Prevent unlike proof contracts or missing data creating a winner.
 * ROLE IN PROJECT: Deterministic report and compiler truthfulness gate.
 * KEY COMPONENTS: Blocked reports; warmup exclusion; unverified onset retention.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import { candidateIds, emptyTurn, offlinePreflight } from '../contracts.js';
import { newReport, renderArchitectureReport, compileReports } from '../compiler.js';
const runId = '00000000-0000-4000-8000-000000000001';
it('preserves unverified onset and excludes warmup from warm summaries', () => {
  const report = newReport('aurvin', runId, 'live', offlinePreflight('aurvin'));
  report.turns = [0, 1].map(index => ({ ...emptyTurn('aurvin', index), submitted: true,
    outcome: 'unverified-playback', failureCode: 'BENCHMARK_UNPROVEN_PLAYBACK',
    speechEndToFirstAudioMs: index === 0 ? 999 : 123 }));
  const markdown = renderArchitectureReport(report);
  expect(markdown).toContain('BENCHMARK_UNPROVEN_PLAYBACK');
  expect(markdown).toContain('not physical audibility');
  expect(markdown).toContain('Ordinary/Warm | 1 | 123');
  expect(markdown).not.toContain('Ordinary/Warm | 2');
});
it('never invents a live managed observation or a completion winner', () => {
  const reports = candidateIds.map(id => newReport(id, runId, 'dry-run', offlinePreflight(id)));
  const markdown = compileReports(reports, reports[0].envelope);
  expect(markdown).toContain('No successful-completion winner');
  expect(markdown).toContain('deepgram-agent');
  expect(markdown).toContain('unknown');
  expect(() => compileReports([reports[0], reports[0]], reports[0].envelope)).toThrow('REPORT_SET_INVALID');
});
