/**
 * ============================================================================
 * FILE: compiler.ts
 * LOCATION: benchmarks/voice-architectures/shared/compiler.ts
 * PURPOSE: Write validated nonsecret evidence and qualified screening reports.
 * ROLE IN PROJECT: One report path for all candidates; no provider truth inference.
 * KEY COMPONENTS: newReport; renderArchitectureReport; compileReports; writers.
 * ============================================================================
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { reportSchema, envelopeSchema, type ArchitectureReport, type CandidateId,
  type PreflightResult, type RunContext } from './contracts.js';
import { SecretRedactor } from './credentials.js';
import { summarize } from './timing.js';
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const escape = (value: unknown) => value === null ? 'unknown'
  : String(value).replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const table = (columns: string[], rows: unknown[][]) =>
  [columns, columns.map(() => '---'), ...rows].map(row => `| ${row.map(escape).join(' | ')} |`).join('\n');
export function newReport(candidate: CandidateId, runId: string, mode: 'dry-run' | 'live',
  preflight: PreflightResult): ArchitectureReport {
  return { schemaVersion: 1, runId, candidate, mode, startedAtIso: new Date().toISOString(),
    preflight, provenance: {}, turns: [], cleanup: { resources: [], openSockets: 0, complete: true },
    envelope: { submittedTurns: 0, modelDispatches: 0, activeMs: 0, sttAudioMs: 0, ttsInputBytes: 0,
      conservativeReserveUsd: 0, denied: null },
    limitations: ['Decoded PCM receipt is not physical audibility.',
      'One warmup plus five varied inputs cannot establish an SLA or stable tail percentile.',
      'Semantic usefulness is unknown unless a separately documented synthetic check verifies it.',
      'Review skipped by instruction; fixture tests are not live/provider/native certification.'] };
}
export function renderArchitectureReport(raw: ArchitectureReport): string {
  const r = reportSchema.parse(raw);
  const groups = [
    ['Cold/warmup', [0]], ['Ordinary/Warm', [1, 2]], ['Recovered ordinary/followup', [1, 2]],
    ['Hesitation', [3]], ['Interruption', [4, 5]]
  ] as const;
  return [
    `# ${r.candidate} voice architecture screening`,
    `Mode: **${r.mode}**. Preflight: **${r.preflight.status}**. Run: ${r.runId}.`,
    '## Boundary and proof',
    '24 kHz decoded non-silent PCM receipt is not physical audibility. No hardware/browser proof is generated.',
    'Aurvin BENCHMARK_UNPROVEN_PLAYBACK / VOICE_DELIVERY_UNKNOWN is incomplete delivery, not successful completion.',
    '## Provenance', '```json', JSON.stringify(r.provenance, null, 2), '```',
    '## Preflight', '```json', JSON.stringify(r.preflight, null, 2), '```',
    '## Every attempted input',
    table(['Index', 'Scenario', 'Submitted', 'Phase', 'Outcome', 'Failure', 'Setup ms', 'Onset ms',
      'Model first ms', 'TTS first ms', 'Cutoff ms', 'Tail frames', 'Gaps', 'Max gap ms', 'Durable'],
    r.turns.map(t => [t.turnIndex, t.scenario, t.submitted, t.sessionPhase, t.outcome, t.failureCode,
      t.setupMs, t.speechEndToFirstAudioMs, t.modelFirstOutputMs, t.ttsFirstAudioMs,
      t.interruptionToCutoffMs, t.staleTailNonzeroFrames, t.streamGapCount, t.maxStreamGapMs,
      t.durableCompletionStatus])),
    '## Separate onset groups',
    table(['Group', 'Count', 'Median ms', 'Min ms', 'Max ms', 'Exploratory small-sample p95 ms'],
      groups.map(([label, indices]) => {
        const s = summarize(r.turns.filter(t => (indices as readonly number[]).includes(t.turnIndex) &&
          (label === 'Ordinary/Warm' ? t.sessionPhase === 'warm-session'
            : label === 'Recovered ordinary/followup' ? t.sessionPhase === 'recovered-session' : true) &&
          t.submitted && !t.earlyEndpoint && t.speechEndToFirstAudioMs !== null)
          .map(t => t.speechEndToFirstAudioMs!));
        return [label, s.count, s.median, s.min, s.max, s.exploratoryP95];
      })),
    '## Costs and envelope',
    'Envelope is a cumulative run-ledger snapshot, not an additive per-candidate invoice.',
    'Reservations are application estimates, not guaranteed provider billing caps.',
    '```json', JSON.stringify({ envelope: r.envelope, usage: r.turns.map(t => ({
      turnIndex: t.turnIndex, ...t.usage })) }, null, 2), '```',
    '## Cleanup', '```json', JSON.stringify(r.cleanup, null, 2), '```',
    '## Limitations', ...r.limitations.map(line => `- ${line}`)
  ].join('\n\n') + '\n';
}
export function compileReports(raw: ArchitectureReport[],
  rawEnvelope: ArchitectureReport['envelope']): string {
  const reports = raw.map(r => reportSchema.parse(r)), envelope = envelopeSchema.parse(rawEnvelope);
  if (!reports.length || new Set(reports.map(r => r.candidate)).size !== reports.length ||
    new Set(reports.map(r => r.runId)).size !== 1 || new Set(reports.map(r => r.mode)).size !== 1 ||
    reports.reduce((n, r) => n + r.turns.filter(t => t.submitted).length, 0) !== envelope.submittedTurns)
    throw Error('REPORT_SET_INVALID');
  const live = reports.filter(r => r.mode === 'live' && r.turns.some(t => t.submitted));
  const blocked = reports.filter(r => r.preflight.status !== 'ready');
  const violation = envelope.submittedTurns > 18 || envelope.modelDispatches > 18 ||
    envelope.activeMs > 900000 || envelope.conservativeReserveUsd > 2;
  const liveSummary = live.map(r => {
    const onsets = r.turns
      .filter(t => t.submitted && !t.warmup && !t.earlyEndpoint && t.speechEndToFirstAudioMs !== null)
      .map(t => t.speechEndToFirstAudioMs!);
    const s = summarize(onsets);
    const interruptTurn = r.turns.find(t => t.turnIndex === 4 && t.interruptionToCutoffMs !== null);
    const failed = r.turns.filter(t => t.outcome === 'failed' || t.outcome === 'timeout').length;
    return `- **${r.candidate}:** ${r.turns.filter(t => t.submitted).length} turns submitted; ` +
      `non-warmup onset median ${s.median ?? 'unknown'} ms (n=${s.count}` +
      `${s.count ? `, range ${s.min}–${s.max} ms` : ''}); ` +
      `interruption cutoff ${interruptTurn?.interruptionToCutoffMs ?? 'unknown'} ms; ` +
      `failed/timeout turns: ${failed}.`;
  });
  return [
    '# Voice architectures: qualified screening verdict',
    '## Verdict',
    violation ? '**ENVELOPE_VIOLATION: retain this failed evidence; no further live work.**'
      : 'Finite envelope: within recorded aggregate bounds.',
    `Live observations: ${live.map(r => r.candidate).join(', ') || 'none'}. ` +
      `Blocked/unrun: ${blocked.map(r => r.candidate).join(', ') || 'none'}.`,
    ...(liveSummary.length ? liveSummary : [
      'No live turns were executed in this run; see preflight blocks above.'
    ]),
    '**No successful-completion winner is established by decoded headless output.**',
    'Keep Aurvin as the application baseline for production semantics; evaluate any observed LiveKit Agents or Deepgram Voice Agent onset/interruption deltas only as screening signals (small-sample headless PCM, not audible browser proof or migration approval).',
    '## A. Capability and policy',
    table(['Candidate', 'Preflight', 'User', 'ZDR', 'Output cap', 'Zero retry', 'Speculation off', 'Playback'],
      reports.map(r => [r.candidate, r.preflight.status, r.preflight.capabilities.userAttribution,
        r.preflight.capabilities.zeroDataRetention, r.preflight.capabilities.maxOutputTokensEnforced,
        r.preflight.capabilities.zeroRetriesEnforced, r.preflight.capabilities.speculationDisabled,
        'unproven headless PCM'])),
    '## B. Setup and onset, not completion',
    table(['Candidate', 'Scenario', 'Session phase', 'Setup ms', 'N', 'Median ms', 'Range ms'], reports.flatMap(r =>
      [0, 1, 2, 3].map(index => {
        const turns = r.turns.filter(t => t.turnIndex === index && t.submitted && !t.earlyEndpoint);
        const s = summarize(turns.flatMap(t => t.speechEndToFirstAudioMs === null ? [] : [t.speechEndToFirstAudioMs]));
        return [r.candidate, ['cold/warmup', 'ordinary', 'warm-followup', 'hesitation'][index],
          turns[0]?.sessionPhase ?? null, turns[0]?.setupMs ?? null, s.count, s.median,
          s.count ? `${s.min}–${s.max}` : null];
      }))),
    'Cold setup and connection stages are separately recorded in each raw/per-architecture report; warm/recovered sessions are not pooled.',
    '## C. Interruption and continuity',
    table(['Candidate', 'Index', 'Anchor', 'Cutoff ms', 'Tail window ms', 'Tail frames', 'Attribution', 'Delivery'],
      reports.flatMap(r => r.turns.filter(t => t.turnIndex >= 4).map(t => [r.candidate,
        t.turnIndex, t.interruptionAnchorObserved, t.interruptionToCutoffMs, t.staleTailObservedMs,
        t.staleTailNonzeroFrames, t.interruptionAttribution, t.durableCompletionStatus]))),
    'Aurvin unknown delivery and Agents framework-estimated heard history are different contracts. Neither proves speaker audibility.',
    '## D. Aggregate envelope and costs', '```json', JSON.stringify(envelope, null, 2), '```',
    'Provider-reported costs, conservative speech/media estimates, and unknown invoice components remain separate in per-turn JSON. Unknown is not zero.',
    '## Reports and artifact hashes',
    ...reports.map(r => `- [${r.candidate}](${r.candidate}/report.md): JSON SHA-256 ${hash(JSON.stringify(r, null, 2))}`),
    '## Limitations and next evaluation',
    'Fixtures, live observations and unrun native/browser claims are distinct. No p99, capacity, SLA or production migration claim follows from this pilot.',
    'A future browser-audible study needs separate authorization: measure AudioWorklet scheduling and acoustic loopback on one clock, independently verify heard-prefix/completion, then repeat a larger matched corpus.',
    'Unified review: skipped.'
  ].join('\n\n') + '\n';
}
export async function writeArchitectureReport(context: RunContext, raw: ArchitectureReport) {
  const report = reportSchema.parse(raw);
  const json = context.redactor.encode(report);
  const markdown = renderArchitectureReport(report); context.redactor.encode(markdown);
  const directory = resolve(context.outputDir, report.candidate);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'result.json'), json, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(directory, 'report.md'), markdown, { flag: 'wx', mode: 0o600 });
  return { report, jsonHash: hash(json), markdown };
}
export async function publishReports(packageRoot: string, reports: ArchitectureReport[],
  envelope: ArchitectureReport['envelope'], redactor: SecretRedactor) {
  const main = compileReports(reports, envelope); redactor.encode(main);
  const pages = reports.map(report => ({ candidate: report.candidate, text: renderArchitectureReport(report) }));
  pages.forEach(page => redactor.encode(page.text)); // Validate all before any publish write.
  for (const page of pages) {
    await mkdir(resolve(packageRoot, page.candidate), { recursive: true });
    await writeFile(resolve(packageRoot, page.candidate, 'report.md'), page.text, 'utf8');
  }
  await writeFile(resolve(packageRoot, 'report.md'), main, 'utf8');
}
