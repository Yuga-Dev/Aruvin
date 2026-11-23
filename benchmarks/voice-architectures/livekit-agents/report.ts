/**
 * ============================================================================
 * FILE: report.ts
 * LOCATION: benchmarks/voice-architectures/livekit-agents/report.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Pure deterministic presentation of shared report data; no independent writer or cost estimator.
 *
 * ROLE IN PROJECT:
 *    Supplies P2's standalone framework candidate without changing Aurvin.
 *    Consumes only the isolated package and P1-owned run configuration.
 *
 * KEY COMPONENTS:
 *    - withLivekitBoundaries — candidate-specific disclosures
 *    - shared formatter/writer wrappers — preserve raw evidence and nulls
 * ============================================================================
 */
import { renderArchitectureReport, writeArchitectureReport } from '../shared/compiler.js';
import { reportSchema, type ArchitectureReport, type RunContext } from '../shared/contracts.js';

export function withLivekitBoundaries(raw: ArchitectureReport): ArchitectureReport {
  const report = reportSchema.parse(raw);
  if (report.candidate !== 'livekit-agents') throw new Error('REPORT_CANDIDATE_MISMATCH');
  return {
    ...report,
    provenance: {
      ...report.provenance,
      historyBoundary: 'framework-playback-estimated',
      cancellationBoundary: 'stream abort + RoomIO buffer clear',
      providerPlaybackOffsetInterrupt: false,
    },
    limitations: Array.from(new Set([
      ...report.limitations,
      'Decoded PCM receipt is not physical audibility.',
      'TTSv2 uses stream abort + RoomIO buffer clear, not provider Interrupt(playback_offset).',
      'chatCtx truncation is framework-playback-estimated, not proven heard-history.',
      'Framework completion is not Aurvin durable playback completion. Unified review: skipped.',
      ...(!report.turns.some((turn) => turn.submitted) ? ['No turns submitted.'] : []),
    ])),
  };
}

export function formatLivekitReport(report: ArchitectureReport) {
  return renderArchitectureReport(withLivekitBoundaries(report));
}

export function writeReport(context: RunContext, report: ArchitectureReport) {
  return writeArchitectureReport(context, withLivekitBoundaries(report));
}
