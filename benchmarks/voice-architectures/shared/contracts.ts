/**
 * ============================================================================
 * FILE: contracts.ts
 * LOCATION: benchmarks/voice-architectures/shared/contracts.ts
 * PURPOSE: Define shared adapter, corpus, metric, and report boundaries.
 * ROLE IN PROJECT: Stable P1 API for independently implemented P2/P3 harnesses.
 * KEY COMPONENTS: Runtime evidence schemas; ArchitectureHarness; emptyTurn.
 * ============================================================================
 */
import { z } from 'zod';
import type { BudgetGuard } from './budget-guard.js';
import type { CredentialBundle, SecretRedactor } from './credentials.js';
export const candidateIds = ['aurvin', 'livekit-agents', 'deepgram-agent'] as const;
export type CandidateId = typeof candidateIds[number];
export const scenarios = ['warmup-cold', 'ordinary-reply', 'warm-followup',
  'hesitation-pause', 'interrupt-target', 'barge-in-interrupt'] as const;
export type TurnScenario = typeof scenarios[number];
export type CorpusTurn = { index: number; scenario: TurnScenario; text: string;
  pcm: Uint8Array; sha256: string; speechEndMs: number; durationMs: number };
export type Clock = import('./timing.js').Clock;
const ms = z.number().finite().nonnegative().nullable();
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const capability = z.union([z.boolean(), z.literal('unknown')]);
export const preflightSchema = z.object({
  candidate: z.enum(candidateIds), status: z.enum(['ready', 'blocked', 'failed']),
  reasons: z.array(z.string().max(200)).max(30), checkedAtIso: z.string().datetime(),
  capabilities: z.object({ userAttribution: capability, zeroDataRetention: capability,
    maxOutputTokensEnforced: capability, zeroRetriesEnforced: capability,
    speculationDisabled: capability, fluxSttSupported: z.boolean(), fluxTtsSupported: z.boolean() }).strict(),
  provenance: z.record(scalar)
}).strict();
export type PreflightResult = z.infer<typeof preflightSchema>;
export const turnSchema = z.object({
  candidate: z.enum(candidateIds), turnIndex: z.number().int().min(0).max(5),
  scenario: z.enum(scenarios), warmup: z.boolean(), submitted: z.boolean(),
  sessionPhase: z.enum(['cold-setup', 'warm-session', 'recovered-session']),
  outcome: z.enum(['completed', 'unverified-playback', 'interrupted-ok', 'early-endpoint',
    'blocked', 'failed', 'timeout']), failureCode: z.string().max(200).nullable(),
  setupMs: ms, connectStageMs: z.record(ms), speechEndToFirstAudioMs: ms,
  speechEndToThinkingMs: ms, modelFirstOutputMs: ms, ttsFirstAudioMs: ms,
  interruptionToCutoffMs: ms, staleTailObservedMs: ms,
  staleTailNonzeroFrames: ms, staleTailBytes: ms, interruptionAnchorObserved: z.boolean(),
  interruptionAttribution: z.enum(['response-correlated', 'boundary-window-only', 'unknown']),
  streamGapCount: z.number().int().nonnegative(), maxStreamGapMs: ms,
  inputPacingMaxLatenessMs: ms, maxInputQueuedMs: ms, earlyEndpoint: z.boolean(),
  decodedPlaybackProof: z.literal('unproven-headless-pcm-only'),
  durableCompletionStatus: z.enum(['completed', 'unknown', 'not-applicable']),
  semanticOutcome: z.enum(['verified', 'failed', 'unknown']),
  usage: z.object({ promptTokens: ms, completionTokens: ms, providerReportedUsd: ms,
    sttAudioMs: ms, ttsInputBytes: ms, sessionActiveMs: ms, estimatedCostUsd: ms,
    unknownCostComponents: z.array(z.string().max(200)).max(20) }).strict()
}).strict();
export type TurnObservation = z.infer<typeof turnSchema>;
export const cleanupSchema = z.object({
  resources: z.array(z.object({ kind: z.enum(['room', 'database', 'socket', 'executor', 'participant']),
    id: z.string().max(200), owned: z.boolean(),
    outcome: z.enum(['closed', 'retained', 'failed', 'unknown']) }).strict()).max(100),
  openSockets: z.number().int().nonnegative().nullable(), complete: z.boolean()
}).strict();
export const envelopeSchema = z.object({ submittedTurns: z.number().int().nonnegative(),
  modelDispatches: z.number().int().nonnegative(), activeMs: z.number().finite().nonnegative(),
  sttAudioMs: z.number().finite().nonnegative(), ttsInputBytes: z.number().int().nonnegative(),
  conservativeReserveUsd: z.number().finite().nonnegative(), denied: z.string().nullable() }).strict();
export const reportSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().uuid(), candidate: z.enum(candidateIds),
  mode: z.enum(['dry-run', 'live']), startedAtIso: z.string().datetime(),
  preflight: preflightSchema, provenance: z.record(scalar),
  turns: z.array(turnSchema).max(6), cleanup: cleanupSchema, envelope: envelopeSchema,
  limitations: z.array(z.string().max(2000)).max(50)
}).strict().superRefine((r, ctx) => {
  if (r.preflight.candidate !== r.candidate || r.turns.some(t => t.candidate !== r.candidate) ||
    new Set(r.turns.map(t => t.turnIndex)).size !== r.turns.length ||
    r.turns.some(t => t.scenario !== scenarios[t.turnIndex] || t.warmup !== (t.turnIndex === 0)) ||
    r.mode === 'dry-run' && r.turns.some(t => t.submitted)) {
    ctx.addIssue({ code: 'custom', message: 'REPORT_BOUNDARY_INVALID' });
  }
});
export type ArchitectureReport = z.infer<typeof reportSchema>;
export type RunContext = {
  mode: 'dry-run' | 'live'; runId: string; repoRoot: string; packageRoot: string;
  outputDir: string; startedAtIso: string; clock: Clock; signal: AbortSignal;
  credentials: CredentialBundle | null; guard: BudgetGuard | null;
  corpus: readonly CorpusTurn[]; redactor: SecretRedactor;
  waiveDeepgramByo?: boolean;
};
export interface ArchitectureHarness {
  readonly id: CandidateId;
  preflight(context: RunContext): Promise<PreflightResult>;
  run(context: RunContext, preflight: PreflightResult): Promise<ArchitectureReport>;
}
export function emptyTurn(candidate: CandidateId, turnIndex: number): TurnObservation {
  if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex > 5) throw Error('TURN_INDEX_INVALID');
  return { candidate, turnIndex, scenario: scenarios[turnIndex], warmup: turnIndex === 0,
    submitted: false, sessionPhase: turnIndex === 0 ? 'cold-setup' : 'warm-session',
    outcome: 'blocked', failureCode: null, setupMs: null, connectStageMs: {},
    speechEndToFirstAudioMs: null, speechEndToThinkingMs: null, modelFirstOutputMs: null,
    ttsFirstAudioMs: null, interruptionToCutoffMs: null, staleTailObservedMs: null,
    staleTailNonzeroFrames: null, staleTailBytes: null, interruptionAnchorObserved: false,
    interruptionAttribution: 'unknown', streamGapCount: 0, maxStreamGapMs: null,
    inputPacingMaxLatenessMs: null, maxInputQueuedMs: null, earlyEndpoint: false,
    decodedPlaybackProof: 'unproven-headless-pcm-only', durableCompletionStatus: 'unknown',
    semanticOutcome: 'unknown', usage: { promptTokens: null, completionTokens: null,
      providerReportedUsd: null, sttAudioMs: null, ttsInputBytes: null,
      sessionActiveMs: null, estimatedCostUsd: null, unknownCostComponents: [
        'provider model usage unobserved', 'speech invoice unverified', 'media invoice unverified'] } };
}
export function offlinePreflight(candidate: CandidateId, reasons = ['DRY_RUN_NO_NETWORK']): PreflightResult {
  return { candidate, status: 'blocked', reasons, checkedAtIso: new Date().toISOString(),
    capabilities: { userAttribution: 'unknown', zeroDataRetention: 'unknown',
      maxOutputTokensEnforced: 'unknown', zeroRetriesEnforced: 'unknown',
      speculationDisabled: 'unknown', fluxSttSupported: false, fluxTtsSupported: false },
    provenance: {} };
}
