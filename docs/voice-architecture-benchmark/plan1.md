# P1 Shared Voice Benchmark and Aurvin Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the isolated shared safety/measurement/reporting package and a real Aurvin baseline without changing application files, application settings, or application data.

**Architecture:** Share one run-scoped authorization, budget ledger, synthetic corpus, monotonic clock, and evidence compiler across three independently selected adapters. Aurvin dynamically imports the existing compiled application, opens only a newly claimed benchmark database, uses actual application voice admission and LiveKit media, and preserves unknown playback delivery rather than manufacturing completion.

**Tech Stack:** Node 24.18.0 on Windows x64; ESM TypeScript 6.0.3/NodeNext; Vitest 4.1.11; native LiveKit RTC; MongoDB 6.21.0; Windows System.Speech; exact dependency pins below.

---

## Boundaries, execution order, and handoff

This is an implementation plan, not implementation or live evidence. Research prerequisite: `7a40c2a`. Read `goal.md`, `research.md`, `state.md`, and repository `AGENTS.md` before executing. Unified review is **skipped**, not passed. P1 runs deterministic checks only; V1 owns the bounded pilot and final evidence.

**Never write to** `backend/`, `frontend/`, root manifests, `.env`, or the source/application database. Do not run the backend build: even untracked `backend/dist/` output violates the current zero-write instruction. The research recorded stale compiled output. A stale baseline is a legitimate `BASELINE_BUILD_STALE` blocked result; an independently refreshed build requires an operator/orchestrator decision outside this task. Never silently import stale code.

Do not read application chats, users, calendars, messages, integration connections, or executor state. The only optional source-database access is one explicit read of `config._id = 'aurvin'`. A synthetic account is inserted through the actual application's `users.insert` **after** opening the isolated database, not by writing an invalid raw Mongo account without its persistence envelope.

Commit suggestions below are requests to the orchestrator, not permission to manipulate the shared index. Ask for serialized commit ownership; stage only named task files after permission. Do not stage concurrent P2/P3/user changes. No live run, package installation, or git staging/commit occurs while authoring this plan.

### File map (all paths relative to `benchmarks/voice-architectures/`)

| Files | Responsibility |
| --- | --- |
| `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `README.md` | Standalone package, exact versions, no workspace wiring |
| `shared/contracts.ts` | P2/P3 adapter, input, metrics, evidence, and report interfaces |
| `shared/credentials.ts` | Native `.env` parsing, optional one-record read/decryption, secret gate |
| `shared/corpus.ts`, `shared/make-corpus.ps1` | Offline six-turn corpus, hashes, exact sample markers |
| `shared/timing.ts` | One clock, pacing, decoded/cutoff measurement, summaries, bounded cleanup |
| `shared/budget-guard.ts` | Aggregate authorization, reservations, turn/model/speech/time egress controls |
| `shared/webrtc-participant.ts` | Reusable native caller, reliable control lane, uninterrupted decoded consumer |
| `shared/compiler.ts` | Validated JSON evidence, per-candidate Markdown, separated main verdict |
| `shared/cli.ts` | Offline default, independent lazy selection, exclusive sequential execution |
| `aurvin/preflight.ts` | Read-only build verification and isolated bootstrap construction |
| `aurvin/harness.ts`, `aurvin/report.ts` | Real AppService adapter and common report writer integration |
| `shared/__tests__/*.test.ts`, `aurvin/__tests__/*.test.ts` | Deterministic no-network safety/lifecycle checks |
| `audio/`, `results/<runId>/` | Ignored offline corpus and immutable run evidence |
| `<candidate>/report.md`, `report.md` | Generated nonsecret human-readable reports, tracked by V1 |

No P1 implementation in `livekit-agents/` or `deepgram-agent/`. The runner uses lazy imports so P1 builds/tests without those workers' files existing. Their missing entries yield `CANDIDATE_NOT_IMPLEMENTED`, never a fake framework or fake managed run.

### Non-negotiable P2/P3 interface

Both workers export `harness: ArchitectureHarness` from their `harness.ts`. The runner calls `preflight(context)` first and `run(context, preflight)` only when ready. A blocked preflight produces a report with zero submitted turns and zero paid connections. All reports go through `writeArchitectureReport`; raw exceptions, headers, credentials, transcripts, and arbitrary SDK payloads must never be serialized.

P2 consumes `context.guard.fetch`, `guard.submitTurn`, `guard.openCandidate`, `guard.speechOpen`, `guard.speechSend`, `guard.sockets`, `guard.signal`, `createParticipant`, `Participant.play(pcm, firstFrame?)`, `DecodedObserver`, `pacePcm`, `newReport`, and `writeArchitectureReport`. Wrap **actual** installed-plugin STT/TTS opens/sends with `speechOpen`/`speechSend`/`sockets`; caller-side PCM counts are not enough. If the installed SDK has no safe injectable seam, block live rather than let unguarded SDK traffic escape. `OpenAI.maxRetries = 0` and framework `connOptions.*.maxRetry = 0` are distinct required controls. One model attempt per submitted input; no greeting, speculative request, fallback, reconnect retry, or `allowSpeechRecovery` except Aurvin's documented unknown-delivery pause.

P3 consumes the same contracts, clock, redactor, compiler, `pacePcm`, and `DecodedObserver` for protocol fixtures. Its real managed client remains live-blocked with `BLOCKED_BYO_CONTROLS_UNSUPPORTED`. Optional nonbillable entitlement reads require explicit live/preflight authorization; dry-run performs none. Do not acquire a paid candidate lease or send a Settings frame containing the OpenRouter key on the blocked path.

### Headers for every code file

Every TypeScript/PowerShell file, including tests and configuration, starts with the repository header. The compact filled headers in this plan contain every required section. Strict JSON, `.gitignore`, generated lockfiles, PCM, and Markdown do not get comments. Local TypeScript imports use `.js`.

## Task 1: Establish the isolated package and executable adapter contract

**Files:** Create the six scaffold files, `shared/contracts.ts`, and `shared/__tests__/contracts.test.ts`. Generate `package-lock.json` only during authorized implementation installation.

- [ ] **Step 1: Write the failing contract/scaffold test.**

Create `shared/__tests__/contracts.test.ts`:

```ts
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
```

- [ ] **Step 2: Verify RED.**

From `benchmarks/voice-architectures/`, after the implementation worker's isolated installation, run `npm test -- shared/__tests__/contracts.test.ts`. Expected initial failure: missing `shared/contracts.js`. Do not count missing npm/Vitest as the behavior's red test.

- [ ] **Step 3: Write the scaffold.**

`package.json`:

```json
{
  "name": "voice-architecture-benchmark",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": "^22.22.3 || ^24.15.0 || >=26.0.0" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "corpus:generate": "powershell.exe -NoProfile -File shared/make-corpus.ps1",
    "bench": "node dist/shared/cli.js",
    "bench:aurvin": "node dist/shared/cli.js --candidate=aurvin",
    "bench:livekit-agents": "node dist/shared/cli.js --candidate=livekit-agents",
    "bench:deepgram-agent": "node dist/shared/cli.js --candidate=deepgram-agent",
    "bench:compile": "node dist/shared/cli.js --compile-only"
  },
  "dependencies": {
    "@livekit/agents": "1.10.0",
    "@livekit/agents-plugin-deepgram": "1.10.0",
    "@livekit/agents-plugin-openai": "1.10.0",
    "@livekit/agents-plugin-silero": "1.10.0",
    "@livekit/rtc-node": "1.2.2",
    "livekit-server-sdk": "2.19.2",
    "mongodb": "6.21.0",
    "openai": "6.8.1",
    "ws": "8.22.0",
    "zod": "3.25.76"
  },
  "devDependencies": {
    "@types/node": "24.0.0",
    "@types/ws": "8.5.14",
    "typescript": "6.0.3",
    "vitest": "4.1.11"
  }
}
```

These replace research ranges with exact pins. Do not add Nest testing or dotenv: backend modules resolve their own dependencies, and Node's `util.parseEnv` supplies the `.env` parser. P1 alone owns dependency reconciliation. Lock native transitive dependencies in the package lock; verify the resolved Agents Silero ONNX version against research (`1.24.3`) and report differences before live admission.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"],
    "rootDir": ".",
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["shared/**/*.ts", "aurvin/**/*.ts", "livekit-agents/**/*.ts",
    "deepgram-agent/**/*.ts", "vitest.config.ts"],
  "exclude": ["dist", "node_modules", "results", "audio"]
}
```

`vitest.config.ts`:

```ts
/**
 * ============================================================================
 * FILE: vitest.config.ts
 * LOCATION: benchmarks/voice-architectures/vitest.config.ts
 * PURPOSE: Run isolated deterministic Node checks without service discovery.
 * ROLE IN PROJECT: Never imports the backend build or starts live candidates.
 * KEY COMPONENTS: Explicit test glob; finite fixture deadlines.
 * ============================================================================
 */
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['**/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'], testTimeout: 10_000, hookTimeout: 10_000 }
});
```

`.gitignore`:

```gitignore
node_modules/
dist/
results/
audio/
*.pcm
*.wav
*.local.json
*-result.json
*.log
.env
.env.*
```

- [ ] **Step 4: Create `shared/contracts.ts`.**

The inferred schema is the runtime report-validation contract; do not maintain a second divergent JSON interface. Candidate implementations may have additional in-memory private state but return only these fields.

```ts
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
```

The public exported `Clock` alias is the contract consumed by candidate workers.

- [ ] **Step 5: Install only here, verify GREEN, request an atomic commit.**

Implementation worker only: `npm install --package-lock-only`, then `npm ci`, with cwd exactly `benchmarks/voice-architectures/`. This is dependency preparation, not a paid service call. Do not disable native installation scripts and then claim native readiness. Keep installation logs out of evidence if they contain local environment values.

Run `npm test -- shared/__tests__/contracts.test.ts`. Expect 2 passing tests after dependent type-only files land; Task 1 runtime tests do not resolve type-only imports. Full `npm run build` becomes required at Task 10.

Suggested commit: `build(voice-bench): scaffold isolated package and shared contracts`.

## Task 2: Implement the single-clock observer and real-time PCM pacer

**Files:** Create `shared/timing.ts`, `shared/__tests__/timing.test.ts`.

- [ ] **Step 1: Write the failing tests.**

```ts
/**
 * ============================================================================
 * FILE: timing.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/timing.test.ts
 * PURPOSE: Prove exact measurement boundaries without waiting in real time.
 * ROLE IN PROJECT: Deterministic decoded-receipt and interruption evidence.
 * KEY COMPONENTS: Nonzero gate; early endpoint; stale tail; no burst catch-up.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import { DecodedObserver, pacePcm, summarize } from '../timing.js';
it('keeps silence, early output, and cancelled stale audio distinct', () => {
  let now = 1000;
  const observer = new DecodedObserver({ now: () => now });
  observer.begin('r1', 1100);
  observer.frame(new Int16Array(240), 24000, 1);
  expect(observer.snapshot().speechEndToFirstAudioMs).toBeNull();
  now = 1080; observer.frame(Int16Array.of(1), 24000, 1);
  expect(observer.snapshot().earlyEndpoint).toBe(true);
  expect(observer.snapshot().speechEndToFirstAudioMs).toBeNull();
  now = 1700; observer.interrupt();
  now = 1720; observer.frame(Int16Array.of(1), 24000, 1);
  now = 1830; observer.tick();
  now = 1900; observer.frame(Int16Array.of(1), 24000, 1);
  now = 2830; observer.tick();
  expect(observer.snapshot()).toMatchObject({ interruptionAnchorObserved: true,
    staleTailNonzeroFrames: 1, staleTailObservedMs: 1000 });
  expect(observer.snapshot().interruptionToCutoffMs).toBeCloseTo(20 + 1 / 24);
});
it('paces 80 ms frames and refuses catch-up bursts', async () => {
  let now = 0;
  const at: number[] = [];
  await pacePcm(new Uint8Array(5120), { now: () => now }, async ms => { now += ms; },
    async () => { at.push(now); }, new AbortController().signal);
  expect(at).toEqual([0, 80]);
  now = 0;
  await expect(pacePcm(new Uint8Array(5120), { now: () => now }, async ms => { now += ms; },
    async () => { now += 200; }, new AbortController().signal)).rejects.toThrow('INPUT_PACING_INVALID');
});
it('summarizes no observations as null, not zero or a stable percentile', () => {
  expect(summarize([])).toEqual({ count: 0, median: null, min: null, max: null, exploratoryP95: null });
  expect(summarize([30, 10, 20])).toMatchObject({ count: 3, median: 20, min: 10, max: 30 });
});
```

- [ ] **Step 2: Run RED:** `npm test -- shared/__tests__/timing.test.ts`; expect unresolved module.
- [ ] **Step 3: Create `shared/timing.ts`.**

```ts
/**
 * ============================================================================
 * FILE: timing.ts
 * LOCATION: benchmarks/voice-architectures/shared/timing.ts
 * PURPOSE: Measure local monotonic decoded boundaries and pace finite PCM.
 * ROLE IN PROJECT: Shared by native callers and managed protocol fixtures.
 * KEY COMPONENTS: Clock; DecodedObserver; pacePcm; bounded; summarize.
 * ============================================================================
 */
import { setTimeout as sleep } from 'node:timers/promises';
export interface Clock { now(): number }
export const monotonicClock: Clock = { now: () => performance.now() };
export const wait = (ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal });
export async function bounded<T>(job: Promise<T>, ms: number, code = 'BENCHMARK_TIMEOUT'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([job, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error(code)), ms);
  })]); } finally { clearTimeout(timer); }
}
export async function pacePcm(pcm: Uint8Array, clock: Clock,
  sleepFor: (ms: number) => Promise<unknown>,
  send: (frame: Uint8Array) => Promise<unknown>, signal: AbortSignal): Promise<number> {
  if (!pcm.length || pcm.length % 2560) throw Error('PCM_FRAME_INVALID');
  const started = clock.now(); let lateness = 0;
  for (let offset = 0; offset < pcm.length; offset += 2560) {
    signal.throwIfAborted();
    const due = started + offset / 32;
    await sleepFor(Math.max(0, due - clock.now()));
    signal.throwIfAborted();
    const late = clock.now() - due;
    if (!Number.isFinite(late) || late < 0 || late > 80) throw Error('INPUT_PACING_INVALID');
    lateness = Math.max(lateness, late);
    await send(pcm.subarray(offset, offset + 2560));
  }
  return lateness;
}
export function summarize(raw: number[]) {
  const values = [...raw].sort((a, b) => a - b);
  if (values.some(x => !Number.isFinite(x) || x < 0)) throw Error('METRIC_INVALID');
  const n = values.length;
  return { count: n, median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
    min: n ? values[0] : null, max: n ? values[n - 1] : null,
    exploratoryP95: n ? values[Math.ceil(n * .95) - 1] : null };
}
export class DecodedObserver {
  private speechEnd = 0; private first: number | null = null;
  private lastNonzeroEnd: number | null = null; private lastFrame: number | null = null;
  private marker: number | null = null; private cutoff: number | null = null;
  private completedWindow = false; private tailFrames = 0; private tailBytes = 0;
  private gaps = 0; private maxGap = 0; private early = false; private anchor = false;
  private response: string | null = null;
  constructor(private clock: Clock) {}
  begin(response: string, speechEndClockMs: number) {
    if (this.response !== null) throw Error('OBSERVER_ALREADY_STARTED');
    if (!Number.isFinite(speechEndClockMs)) throw Error('METRIC_INVALID');
    this.response = response; this.speechEnd = speechEndClockMs;
  }
  frame(data: Int16Array, sampleRate: number, channels: number) {
    if (sampleRate !== 24000 || channels !== 1 || !data.length) throw Error('DECODE_FORMAT_INVALID');
    if (!this.response) return;
    const now = this.clock.now();
    if (this.lastFrame !== null) {
      const gap = now - this.lastFrame;
      if (gap < 0) throw Error('CLOCK_REVERSED');
      if (gap > 100) this.gaps++;
      this.maxGap = Math.max(this.maxGap, gap);
    }
    this.lastFrame = now;
    if (!data.some(sample => sample !== 0)) { this.tick(); return; }
    if (this.first === null) { this.first = now; this.early = now < this.speechEnd; }
    if (this.cutoff !== null && now <= this.cutoff + 1000) {
      this.tailFrames++; this.tailBytes += data.byteLength;
    }
    this.lastNonzeroEnd = now + data.length / 24;
    this.tick();
  }
  interrupt() {
    this.marker = this.clock.now();
    this.anchor = this.first !== null && this.marker - this.first >= 600 &&
      this.lastNonzeroEnd !== null && this.marker - this.lastNonzeroEnd <= 100;
  }
  tick() {
    const now = this.clock.now();
    // ponytail: 100 ms decoded quiet defines an observed cutoff, not a DAC stop.
    // A browser/audio-worklet probe is the upgrade path for physical playback.
    if (this.anchor && this.marker !== null && this.cutoff === null &&
      this.lastNonzeroEnd !== null && now - this.lastNonzeroEnd >= 100) {
      this.cutoff = Math.max(this.marker, this.lastNonzeroEnd);
    }
    if (this.cutoff !== null && now >= this.cutoff + 1000) this.completedWindow = true;
  }
  snapshot() {
    return { speechEndToFirstAudioMs: this.first === null || this.early ? null : this.first - this.speechEnd,
      earlyEndpoint: this.early, interruptionAnchorObserved: this.anchor,
      interruptionToCutoffMs: this.completedWindow && this.marker !== null && this.cutoff !== null
        ? this.cutoff - this.marker : null,
      staleTailObservedMs: this.completedWindow ? 1000 : null,
      staleTailNonzeroFrames: this.completedWindow ? this.tailFrames : null,
      staleTailBytes: this.completedWindow ? this.tailBytes : null,
      streamGapCount: this.gaps, maxStreamGapMs: this.lastFrame === null ? null : this.maxGap };
  }
}
```

The quiet-window cutoff is provisional: nonzero audio returning within the fixed window is stale-tail evidence and disqualifies an `interrupted-ok` result. A response boundary absent from the decoded transport stays `boundary-window-only`, not falsely response-correlated. Provider events never satisfy the observer's anchor or cutoff. CPU/event-loop metrics remain unavailable unless the adapter genuinely records them; no cross-process clock subtraction.

- [ ] **Step 4: Run GREEN:** `npm test -- shared/__tests__/timing.test.ts` (3 tests). Also test `frame(..., 16000, 1)` throws and an interruption without prior audio leaves cutoff null by adding direct assertions in the first test.
- [ ] **Step 5: Request commit:** `feat(voice-bench): add monotonic PCM pacing and decoded observers`.

## Task 3: Generate and validate the offline six-turn corpus

**Files:** Create `shared/corpus.ts`, `shared/make-corpus.ps1`, `shared/__tests__/corpus.test.ts`.

- [ ] **Step 1: Add the exact validator tests.**

```ts
/**
 * ============================================================================
 * FILE: corpus.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/corpus.test.ts
 * PURPOSE: Reject altered PCM and incorrect speech-end markers.
 * ROLE IN PROJECT: Offline corpus format/hash contract for every candidate.
 * KEY COMPONENTS: Byte alignment; exact last nonzero sample; six roles.
 * ============================================================================
 */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { validateAudio, utterances } from '../corpus.js';
it('validates exact 16 kHz mono PCM16 and trailing silence', () => {
  const pcm = Buffer.alloc(66560); pcm.writeInt16LE(50, 2);
  const hash = createHash('sha256').update(pcm).digest('hex');
  expect(validateAudio(pcm, hash, 2 / 16)).toBe(2080);
  expect(() => validateAudio(pcm, '0'.repeat(64), 2 / 16)).toThrow('CORPUS_INVALID');
  expect(() => validateAudio(pcm, hash, 0)).toThrow('CORPUS_INVALID');
  expect(utterances).toHaveLength(6);
  expect(utterances[3]).toEqual(['Wait', 'why do clouds look white?']);
});
```

- [ ] **Step 2: Run RED:** `npm test -- shared/__tests__/corpus.test.ts`.
- [ ] **Step 3: Create the loader and offline generator.**

`shared/corpus.ts`:

```ts
/**
 * ============================================================================
 * FILE: corpus.ts
 * LOCATION: benchmarks/voice-architectures/shared/corpus.ts
 * PURPOSE: Load only hash-validated synthetic six-turn raw PCM.
 * ROLE IN PROJECT: Identical input audio and markers across architecture runs.
 * KEY COMPONENTS: utterances; validateAudio; loadCorpus.
 * ============================================================================
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { scenarios, type CorpusTurn } from './contracts.js';
export const utterances = [
  ['Hello Aurvin, please confirm you can hear me in one short sentence.'],
  ['In two short sentences, explain why the sky looks blue.'],
  ['And in one short sentence, why does it look orange at sunset?'],
  ['Wait', 'why do clouds look white?'],
  ['In four complete sentences, explain how the water cycle moves water from oceans to rain.'],
  ['Stop, just tell me what evaporation means in one sentence.']
] as const;
const manifestSchema = z.object({
  sampleRate: z.literal(16000), channels: z.literal(1), encoding: z.literal('pcm16le'),
  generatorVoice: z.string().min(1), turns: z.array(z.object({
    index: z.number().int().min(0).max(5), file: z.string().regex(/^[0-5]\.pcm$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), speechEndMs: z.number().finite().positive(),
    text: z.string().min(1), hesitationMs: z.number().int().nonnegative()
  }).strict()).length(6)
}).strict();
export function validateAudio(pcm: Uint8Array, expectedHash: string, speechEndMs: number): number {
  const fail = () => { throw Error('CORPUS_INVALID'); };
  if (!pcm.length || pcm.length % 2560 || pcm.length > 320000) fail();
  if (createHash('sha256').update(pcm).digest('hex') !== expectedHash) fail();
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let last = -1;
  for (let i = 0; i < pcm.length / 2; i++) if (view.getInt16(i * 2, true) !== 0) last = i;
  const end = (last + 1) / 16;
  if (last < 0 || end !== speechEndMs || pcm.length / 32 - end < 2000 ||
    pcm.length / 32 - end >= 2080) fail();
  return pcm.length / 32;
}
export async function loadCorpus(directory: string): Promise<CorpusTurn[]> {
  const manifest = manifestSchema.parse(JSON.parse(
    (await readFile(resolve(directory, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, '')));
  const turns: CorpusTurn[] = [];
  for (let index = 0; index < 6; index++) {
    const entry = manifest.turns[index];
    const text = utterances[index].join(index === 3 ? ' [800 ms pause] ' : '');
    if (entry.index !== index || entry.file !== `${index}.pcm` || entry.text !== text ||
      entry.hesitationMs !== (index === 3 ? 800 : 0)) throw Error('CORPUS_INVALID');
    const pcm = await readFile(resolve(directory, entry.file));
    const durationMs = validateAudio(pcm, entry.sha256, entry.speechEndMs);
    if (index === 3) {
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      let zeros = 0, found = false, hadSpeech = false;
      for (let sample = 0; sample < entry.speechEndMs * 16; sample++) {
        if (view.getInt16(sample * 2, true) === 0) { if (hadSpeech) zeros++; }
        else { if (hadSpeech && zeros === 12800) found = true; hadSpeech = true; zeros = 0; }
      }
      if (!found) throw Error('CORPUS_HESITATION_INVALID');
    }
    turns.push({ index, scenario: scenarios[index], text, pcm, sha256: entry.sha256,
      speechEndMs: entry.speechEndMs, durationMs });
  }
  if (turns.reduce((n, turn) => n + turn.durationMs, 0) > 60000) throw Error('CORPUS_AUDIO_CAP');
  return turns;
}
```

`shared/make-corpus.ps1` (Windows PowerShell, no provider SDK or network):

```powershell
<#
============================================================================
FILE: make-corpus.ps1
LOCATION: benchmarks/voice-architectures/shared/make-corpus.ps1
PURPOSE: Generate six nonprivate speech inputs offline as raw PCM.
ROLE IN PROJECT: Own only this package's new audio directory; never overwrite.
KEY COMPONENTS: System.Speech; 800 ms hesitation; exact hashes/end markers.
============================================================================
#>
param([string]$Output = (Join-Path $PSScriptRoot '../audio'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
if (Test-Path $Output) { throw 'CORPUS_OUTPUT_EXISTS' }
$null = New-Item -ItemType Directory -Path $Output
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)
function Speak-Trimmed([string]$Text) {
  $stream = New-Object System.IO.MemoryStream
  try {
    $synth.SetOutputToAudioStream($stream, $format)
    $synth.Speak($Text)
    $bytes = $stream.ToArray()
    $end = $bytes.Length
    while ($end -ge 2 -and $bytes[$end-1] -eq 0 -and $bytes[$end-2] -eq 0) { $end -= 2 }
    if ($end -eq 0) { throw 'EMPTY_SYNTHESIS' }
    $result = New-Object byte[] $end
    [Array]::Copy($bytes, $result, $end)
    return ,$result
  } finally { $synth.SetOutputToNull(); $stream.Dispose() }
}
$texts = @(
  'Hello Aurvin, please confirm you can hear me in one short sentence.',
  'In two short sentences, explain why the sky looks blue.',
  'And in one short sentence, why does it look orange at sunset?',
  'Wait [800 ms pause] why do clouds look white?',
  'In four complete sentences, explain how the water cycle moves water from oceans to rain.',
  'Stop, just tell me what evaporation means in one sentence.'
)
$turns = @()
try {
  for ($i = 0; $i -lt 6; $i++) {
    if ($i -eq 3) {
      $a = Speak-Trimmed 'Wait'
      $b = Speak-Trimmed 'why do clouds look white?'
      $spoken = New-Object byte[] ($a.Length + 25600 + $b.Length)
      [Array]::Copy($a, 0, $spoken, 0, $a.Length)
      [Array]::Copy($b, 0, $spoken, $a.Length + 25600, $b.Length)
    } else { $spoken = Speak-Trimmed $texts[$i] }
    $length = [int]([Math]::Ceiling(($spoken.Length + 64000) / 2560.0) * 2560)
    $pcm = New-Object byte[] $length
    [Array]::Copy($spoken, $pcm, $spoken.Length)
    $file = Join-Path $Output "$i.pcm"
    [System.IO.File]::WriteAllBytes($file, $pcm)
    $turns += @{ index=$i; file="$i.pcm"; text=$texts[$i];
      sha256=(Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant();
      speechEndMs=$spoken.Length / 32.0; hesitationMs=$(if ($i -eq 3) {800} else {0}) }
  }
  @{ sampleRate=16000; channels=1; encoding='pcm16le';
    generatorVoice=$synth.Voice.Name; turns=$turns } |
    ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $Output 'manifest.json')
} finally { $synth.Dispose() }
```

PowerShell 5 writes a UTF-8 BOM; the loader strips exactly that leading manifest marker. Do not remove BOMs from PCM. Add a loader fixture that confirms this generator/loader interop.

- [ ] **Step 4: Run GREEN:** `npm test -- shared/__tests__/corpus.test.ts`; implementation worker may run `npm run corpus:generate` offline once. Validate the result with `loadCorpus`, including total duration and 800 ms mid-pause. If System.Speech is unavailable, report `OFFLINE_CORPUS_GENERATOR_UNAVAILABLE`; do not switch to paid synthesis.
- [ ] **Step 5: Request commit:** `feat(voice-bench): add bounded offline synthetic voice corpus`.

## Task 4: Import credentials read-only and fail closed on secret evidence

**Files:** Create `shared/credentials.ts`, `shared/__tests__/credentials.test.ts`.

- [ ] **Step 1: Write the following failing tests.**

```ts
/**
 * ============================================================================
 * FILE: credentials.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/credentials.test.ts
 * PURPOSE: Prove env isolation and redaction before any service operation.
 * ROLE IN PROJECT: Trust-boundary tests using synthetic credentials only.
 * KEY COMPONENTS: Native env parser; exact/encoded secrets; fail-closed JSON.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import { parseEnvironment, SecretRedactor, readConfigOnly } from '../credentials.js';
it('parses quoted env values without mutating process.env', () => {
  const before = { ...process.env };
  expect(parseEnvironment('OPENROUTER_MODEL="vendor/example"\nA="a=b"\n', { A: 'override' }))
    .toMatchObject({ OPENROUTER_MODEL: 'vendor/example', A: 'override' });
  expect(process.env).toEqual(before);
});
it('fails closed for secrets, JWTs, authorization, getters, and cycles', () => {
  const redactor = new SecretRedactor(['private+key/example']);
  for (const value of ['private+key/example', encodeURIComponent('private+key/example'),
    'Bearer arbitrary', 'Token arbitrary', 'sk-abcdefgh1234', 'eyJhbGciOiJIUzI1NiJ9.e30.signature']) {
    expect(() => redactor.encode({ nested: [value] })).toThrow('BENCHMARK_REDACTION_FAILED');
  }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(() => redactor.encode(cycle)).toThrow('BENCHMARK_REDACTION_FAILED');
  expect(() => redactor.encode({ get token() { throw Error('must not run'); } }))
    .toThrow('BENCHMARK_REDACTION_FAILED');
  expect(redactor.encode({ observed: null, count: 0 })).toContain('"count": 0');
});
it('reads only config/aurvin and closes the source client on parse failure', async () => {
  const calls: unknown[] = [];
  const client = { connect: async () => { calls.push('connect'); },
    db: (name: string) => ({ collection: (collection: string) => ({
      findOne: async (filter: unknown, options: unknown) => {
        calls.push([name, collection, filter, options]); return { broken: true };
      }
    }) }), close: async () => { calls.push('close'); } };
  await expect(readConfigOnly(client, 'source-config', () => { throw Error('invalid'); }))
    .rejects.toThrow('CONFIG_READ_UNAVAILABLE');
  expect(calls).toEqual(['connect', ['source-config', 'config', { _id: 'aurvin' },
    { maxTimeMS: 10000 }], 'close']);
});
```

- [ ] **Step 2: Run RED:** `npm test -- shared/__tests__/credentials.test.ts`.
- [ ] **Step 3: Create the importer.**

Use structural types only for the compiled seam; never import backend TypeScript into this package's compiler root. The existing backend schemas, not structural typing, validate the actual data at runtime.

```ts
/**
 * ============================================================================
 * FILE: credentials.ts
 * LOCATION: benchmarks/voice-architectures/shared/credentials.ts
 * PURPOSE: Resolve server credentials read-only and prevent secret evidence.
 * ROLE IN PROJECT: Sole source-config importer, never a production repository.
 * KEY COMPONENTS: parseEnvironment; readConfigOnly; loadCredentials; SecretRedactor.
 * ============================================================================
 */
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MongoClient } from 'mongodb';
export type Settings = {
  openRouter: { modelId: string; reasoningEffort: string; dataCollection: 'deny'; disableTransforms: true };
  chat: Record<string, number>;
  voice: { enabledModes: { dictation: boolean; live: boolean };
    limits: Record<string, number>; dictationWarningMs: number | null;
    quotas: Record<string, number | null> };
  deepgram: { region: 'us' | 'eu'; liveModel: string; ttsModel: string;
    eotThreshold: number; eotTimeoutMs: number; rates: Record<string, number | null>;
    [key: string]: unknown };
  webSearch: Record<string, unknown>;
};
export type Bootstrap = {
  port: number; frontendOrigin: string; nodeEnv: string; identity: { userId: string };
  persistence: { profile: string; mongoUri: string; mongoDbName: string; documentHeadroomBytes: number };
  topology: { executor: 'single-process'; localCrashRecovery: boolean };
  safety: Record<string, number>; encryption: { status: string; key?: Uint8Array };
  livekit?: { url: string; apiKey: string; apiSecret: string } | null;
  calendar?: unknown; workos?: unknown;
};
export type StoredDocument = {
  _id: 'aurvin'; schemaVersion: 1; revision: number; settings: Settings;
  credentials: Record<'openrouter' | 'deepgram', { envelope: unknown; validatedAt: string } | null>;
  updatedAt: string; updatedBy: string;
};
export type CredentialBundle = {
  bootstrap: Bootstrap; settings: Settings; document: StoredDocument;
  openrouter: string; deepgram: string; redactor: SecretRedactor;
  sourceRevision: number | null; configHash: string; overrides: string[];
};
export async function backendModule<T>(root: string, name: string): Promise<T> {
  if (!/^[a-z0-9/.-]+\.js$/.test(name) || name.includes('..')) throw Error('BACKEND_MODULE_INVALID');
  return import(pathToFileURL(resolve(root, 'backend/dist', name)).href) as Promise<T>;
}
export function parseEnvironment(text: string, overrides: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...parseEnv(text), ...overrides })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
}
export class SecretRedactor {
  private values = new Set<string>();
  constructor(values: string[] = []) { this.add(values); }
  add(values: string[]) {
    for (const value of values.filter(Boolean)) {
      this.values.add(value); this.values.add(encodeURIComponent(value));
      this.values.add(JSON.stringify(value).slice(1, -1));
    }
  }
  encode(value: unknown): string {
    try {
      const seen = new Set<object>();
      const visit = (v: unknown): void => {
        if (typeof v === 'string') {
          if ([...this.values].some(secret => v.includes(secret)) ||
            /sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|Token\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(v))
            throw Error();
          return;
        }
        if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return;
        if (typeof v !== 'object' || seen.has(v)) throw Error();
        if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype &&
          Object.getPrototypeOf(v) !== null) throw Error();
        seen.add(v);
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
          visit(key);
          if (!('value' in descriptor)) throw Error();
          if (Array.isArray(v) && key === 'length') continue;
          visit(descriptor.value);
        }
        seen.delete(v);
      };
      visit(value);
      return JSON.stringify(value, null, 2);
    } catch { throw Error('BENCHMARK_REDACTION_FAILED'); }
  }
}
type ReadClient = {
  connect(): Promise<unknown>;
  db(name: string): { collection(name: string): {
    findOne(filter: { _id: string }, options: { maxTimeMS: number }): Promise<unknown> } };
  close(): Promise<unknown>;
};
export async function readConfigOnly<T>(client: ReadClient, database: string,
  parse: (raw: unknown) => T): Promise<T | null> {
  try {
    await client.connect();
    const raw = await client.db(database).collection('config').findOne({ _id: 'aurvin' }, { maxTimeMS: 10000 });
    return raw === null ? null : parse(raw);
  } catch { throw Error('CONFIG_READ_UNAVAILABLE'); }
  finally { await client.close(); }
}
type CredentialServicePort = {
  decrypt(doc: StoredDocument): { openrouter: string | null; deepgram: string | null };
  seal(provider: 'openrouter' | 'deepgram', value: string): unknown;
};
export async function loadCredentials(options: {
  repoRoot: string; envFile?: string; env?: NodeJS.ProcessEnv; readStoredConfig: boolean;
  configHash: (value: unknown) => string;
}): Promise<CredentialBundle> {
  const file = options.envFile ?? resolve(options.repoRoot, 'backend/.env');
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (options.envFile || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('ENV_READ_UNAVAILABLE');
  }
  const env = parseEnvironment(text, options.env ?? process.env);
  const redactor = new SecretRedactor(Object.entries(env)
    .filter(([key]) => /KEY|SECRET|PASSWORD|TOKEN|MONGODB_URI/.test(key)).map(([, value]) => value));
  const { loadBootstrapConfig } = await backendModule<{
    loadBootstrapConfig(env: Record<string, string>): Bootstrap }>(options.repoRoot, 'platform/config/bootstrap-config.js');
  const { parseLegacyConfigImport } = await backendModule<{
    parseLegacyConfigImport(env: Record<string, string>, bootstrap: Bootstrap): {
      settings: Settings; credentials: { openrouter: string | null; deepgram: string | null } }
  }>(options.repoRoot, 'platform/config/legacy-config-import.js');
  const { storedConfigDocumentSchema } = await backendModule<{
    storedConfigDocumentSchema: { parse(value: unknown): StoredDocument }
  }>(options.repoRoot, 'contracts/admin-config.js');
  const { CredentialService } = await backendModule<{
    CredentialService: new (key: Bootstrap['encryption'],
      validator: { validate(): Promise<never> }) => CredentialServicePort
  }>(options.repoRoot, 'admin-config/credential-service.js');
  const bootstrap = loadBootstrapConfig(env);
  const legacy = parseLegacyConfigImport(env, bootstrap);
  let stored: StoredDocument | null = null;
  // An explicit switch is required: env-only mode never opens source storage.
  if (options.readStoredConfig) {
    const client = new MongoClient(bootstrap.persistence.mongoUri, { readPreference: 'primary',
      serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, timeoutMS: 10000,
      retryReads: false, retryWrites: false });
    stored = await readConfigOnly(client as unknown as ReadClient, bootstrap.persistence.mongoDbName,
      raw => storedConfigDocumentSchema.parse(raw));
  }
  const unavailableValidator = { validate: async (): Promise<never> => { throw Error('NO_CREDENTIAL_PROBE'); } };
  const fromStore = stored
    ? new CredentialService(bootstrap.encryption, unavailableValidator).decrypt(stored) : null;
  const openrouter = legacy.credentials.openrouter ?? fromStore?.openrouter ?? '';
  const deepgram = legacy.credentials.deepgram ?? fromStore?.deepgram ?? '';
  redactor.add([openrouter, deepgram]);
  const settings = structuredClone(stored?.settings ?? legacy.settings);
  // Settings mirror one explicit source; env credentials do not overlay stored settings.
  const overrides = ['retryMaxAttempts=1', 'maxOutputTokens=1024',
    'maxContextTokens=45000', 'totalRunTimeoutMs<=60000', 'liveMaxMs=300000'];
  Object.assign(settings.chat, { retryMaxAttempts: 1, maxOutputTokens: 1024,
    maxContextTokens: 45000, totalRunTimeoutMs: Math.min(settings.chat.totalRunTimeoutMs, 60000) });
  Object.assign(settings.voice.limits, { liveMaxMs: 300000, liveWarningMs: 270000 });
  const key = randomBytes(32);
  const ephemeralBootstrap = { ...bootstrap, encryption: { status: 'ready', key } };
  redactor.add([key.toString('base64'), key.toString('hex')]);
  const sealer = new CredentialService(ephemeralBootstrap.encryption, unavailableValidator);
  const now = new Date().toISOString();
  const document = storedConfigDocumentSchema.parse({ _id: 'aurvin', schemaVersion: 1,
    revision: stored?.revision ?? 1, settings,
    credentials: { openrouter: openrouter ? { envelope: sealer.seal('openrouter', openrouter), validatedAt: now } : null,
      deepgram: deepgram ? { envelope: sealer.seal('deepgram', deepgram), validatedAt: now } : null },
    updatedAt: now, updatedBy: 'voice-architecture-benchmark' });
  const configHash = options.configHash({ settings, sourceRevision: stored?.revision ?? null,
    identity: bootstrap.identity.userId, livekitUrl: bootstrap.livekit?.url ?? null });
  return { bootstrap: ephemeralBootstrap, settings, document, openrouter, deepgram,
    redactor, sourceRevision: stored?.revision ?? null, configHash, overrides };
}
```

The importer requires `--read-stored-config` rather than silently connecting when env keys are blank. Missing keys without that opt-in yield a blocked preflight and private secret-tool escalation through the orchestrator; no prompt for secrets in stdout/chat. Resealing happens only in memory, even when mirroring a stored revision. Never write the synthetic `StoredDocument` to source or isolated Mongo: `ports.configRepository` serves it from memory.

Wrap importer errors at the CLI boundary into allowlisted codes; Zod/driver messages can contain input and must not reach stdout. A log containing a loaded secret causes `BENCHMARK_REDACTION_FAILED`, stops the guard, and is not written. Redaction inspects object keys as well as values; arbitrary methods/getters are never executed.

- [ ] **Step 4: Run GREEN:** `npm test -- shared/__tests__/credentials.test.ts`. Assert source file bytes and `process.env` stay unchanged and the source client closes before candidate admission. No application database is used in tests.
- [ ] **Step 5: Request commit:** `feat(voice-bench): import credentials read-only with fail-closed redaction`.

## Task 5: Enforce the shared monetary/turn/time ledger before every paid send

**Files:** Create `shared/budget-guard.ts`, `shared/__tests__/budget-guard.test.ts`.

- [ ] **Step 1: Write RED tests, including boundary conditions.**

```ts
/**
 * ============================================================================
 * FILE: budget-guard.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/budget-guard.test.ts
 * PURPOSE: Deny paid traffic before any uncertain or exceeded reservation.
 * ROLE IN PROJECT: Deterministic aggregate envelope and egress safety check.
 * KEY COMPONENTS: Dynamic catalogue; one lease; six turns; zero automatic retry.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import { BudgetGuard, priceEnvelope, readRates } from '../budget-guard.js';
const rates = { prompt: .0000005, completion: .0000025, request: 0 };
const policy = { modelId: 'vendor/example', userId: 'synthetic-user',
  maxContextTokens: 45000, maxOutputTokens: 1024, modelMarginTokens: 1024,
  region: 'us' as const, sttModel: 'flux-general-en', ttsModel: 'flux-haley-en',
  outputParameter: 'max_tokens' as const, expiresAtMs: Date.now() + 900000 };
it('reserves the whole envelope with LiveKit buffer and margin', () => {
  expect(priceEnvelope(rates, 45000, 1024)).toBeCloseTo(1.710038, 5);
  expect(() => new BudgetGuard(policy, { prompt: 1, completion: 1, request: 1 }))
    .toThrow('BUDGET_ENVELOPE_EXCEEDED');
  expect(() => readRates({ pricing: { prompt: '-1', completion: '0' } }))
    .toThrow('MODEL_PRICING_UNPROVEN');
  expect(readRates({ pricing: { prompt: '0.1', completion: '0.2', request: '0',
    pricing_overrides: [{ min_prompt_tokens: 1000, pricing: { prompt: '0.3', completion: '0.4' } }] } }))
    .toEqual({ prompt: .3, completion: .4, request: 0 });
});
it('cannot transfer a blocked candidate allowance or overlap candidates', () => {
  const guard = new BudgetGuard(policy, rates);
  const close = guard.openCandidate('aurvin');
  expect(() => guard.openCandidate('livekit-agents')).toThrow('LIVE_CONCURRENCY_DENIED');
  for (let i = 0; i < 6; i++) guard.submitTurn('aurvin', i);
  expect(() => guard.submitTurn('aurvin', 5)).toThrow('TURN_ALREADY_SUBMITTED');
  expect(() => guard.submitTurn('aurvin', 6)).toThrow('TURN_LIMIT');
  close(); guard.stop();
});
it('sends at most once, counts failures, and rejects changed attribution before fetch', async () => {
  const guard = new BudgetGuard(policy, rates); const close = guard.openCandidate('aurvin');
  guard.submitTurn('aurvin', 0);
  const network = vi.fn<typeof fetch>().mockRejectedValue(Error('fixture-network'));
  const guarded = guard.fetch(network);
  const body = { model: policy.modelId, user: policy.userId,
    messages: [{ role: 'user', content: 'Synthetic hello' }], max_tokens: 1024 };
  await expect(guarded('https://openrouter.ai/api/v1/chat/completions',
    { method: 'POST', body: JSON.stringify({ ...body, user: 'other' }) })).rejects.toThrow('EGRESS_POLICY_DENIED');
  expect(network).not.toHaveBeenCalled();
  // A policy denial stops this run; test a fresh authorized fixture, not a live retry.
  close(); guard.stop();
  const second = new BudgetGuard(policy, rates); second.openCandidate('aurvin'); second.submitTurn('aurvin', 0);
  const send = second.fetch(network);
  await expect(send('https://openrouter.ai/api/v1/chat/completions',
    { method: 'POST', body: JSON.stringify(body) })).rejects.toThrow('fixture-network');
  await expect(send('https://openrouter.ai/api/v1/chat/completions',
    { method: 'POST', body: JSON.stringify(body) })).rejects.toThrow('MODEL_ATTEMPT_LIMIT');
  expect(network).toHaveBeenCalledTimes(1);
  second.stop();
});
it('expires at the exact time and rejects bytes before writing them', () => {
  let now = 0; const guard = new BudgetGuard(policy, rates, { now: () => now });
  guard.openCandidate('livekit-agents');
  guard.speechSend('stt', new Uint8Array(150000 * 32));
  expect(() => guard.speechSend('stt', new Uint8Array(2))).toThrow('SPEECH_LIMIT');
  const other = new BudgetGuard(policy, rates, { now: () => now }); other.openCandidate('aurvin');
  now = 300000;
  expect(() => other.submitTurn('aurvin', 0)).toThrow('ACTIVE_TIME_LIMIT');
  guard.stop(); other.stop();
});
```

- [ ] **Step 2: Run:** `npm test -- shared/__tests__/budget-guard.test.ts`. Expect RED (module absent).
- [ ] **Step 3: Create the ledger and guarded transports.**

```ts
/**
 * ============================================================================
 * FILE: budget-guard.ts
 * LOCATION: benchmarks/voice-architectures/shared/budget-guard.ts
 * PURPOSE: Fail closed on every paid dispatch outside one finite pilot.
 * ROLE IN PROJECT: Shared run ledger, never a provider-enforced invoice cap.
 * KEY COMPONENTS: Dynamic rates; candidate leases; fetch/socket send barriers.
 * ============================================================================
 */
import type { EventEmitter } from 'node:events';
import type { CandidateId } from './contracts.js';
import { bounded, monotonicClock, type Clock } from './timing.js';
export type Rates = { prompt: number; completion: number; request: number };
export type GuardPolicy = { modelId: string; userId: string; maxContextTokens: number;
  maxOutputTokens: number; modelMarginTokens: number; region: 'us' | 'eu';
  sttModel: string; ttsModel: string; outputParameter: 'max_tokens' | 'max_completion_tokens';
  expiresAtMs: number };
export interface SpeechSocket extends EventEmitter {
  readyState: number; bufferedAmount: number;
  send(data: string | Uint8Array, callback: (error?: Error) => void): void;
  close(): void; terminate(): void; ping(): void;
}
export type SocketFactory = (url: URL, headers: Record<string, string>) => SpeechSocket;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('MODEL_PRICING_UNPROVEN');
  return value as Record<string, unknown>;
};
const price = (value: unknown): number => {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)))
    throw Error('MODEL_PRICING_UNPROVEN');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw Error('MODEL_PRICING_UNPROVEN');
  return n;
};
export function readRates(entry: unknown): Rates {
  const row = record(entry), base = record(row.pricing);
  const tiers = [base];
  for (const overrides of [row.pricing_overrides, base.pricing_overrides]) {
    if (overrides === undefined) continue;
    if (!Array.isArray(overrides) || overrides.length > 100) throw Error('MODEL_PRICING_UNPROVEN');
    for (const item of overrides) {
      const tier = record(item);
      if (!Number.isSafeInteger(tier.min_prompt_tokens) || Number(tier.min_prompt_tokens) < 0 ||
        Object.keys(tier).some(k => !['min_prompt_tokens', 'pricing'].includes(k)))
        throw Error('MODEL_PRICING_UNPROVEN');
      tiers.push({ ...base, ...record(tier.pricing) });
    }
  }
  for (const tier of tiers) {
    if (tier.internal_reasoning !== undefined && price(tier.internal_reasoning) !== price(tier.completion))
      throw Error('MODEL_PRICING_UNPROVEN');
    for (const [key, value] of Object.entries(tier)) {
      if (['prompt', 'completion', 'request', 'internal_reasoning', 'pricing_overrides',
        'input_cache_read', 'input_cache_write', 'discount'].includes(key)) continue;
      if (price(value) !== 0) throw Error('MODEL_PRICING_UNPROVEN');
    }
    // Cache writes can cost more than uncached input; reserve their worst rate too.
  }
  return { prompt: Math.max(...tiers.flatMap(t => [price(t.prompt),
      ...(t.input_cache_write === undefined ? [] : [price(t.input_cache_write)]),
      ...(t.input_cache_read === undefined ? [] : [price(t.input_cache_read)])])),
    completion: Math.max(...tiers.map(t => price(t.completion))),
    request: Math.max(...tiers.map(t => t.request === undefined ? 0 : price(t.request))) };
}
export function priceEnvelope(rates: Rates, context: number, output: number): number {
  const model = 18 * (context * rates.prompt + output * rates.completion + rates.request);
  const speech = 5 * .0077 + 8000 / 1000 * .045;
  const managed = 5 * .065 + 4000 / 1000 * .045;
  const media = 10 * .02;
  return Math.ceil((model + speech + managed + media) * 1.10 * 1_000_000) / 1_000_000;
}
async function boundedText(body: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await bounded(reader.read(), 10000); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw Error('EGRESS_POLICY_DENIED');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await bounded(reader.cancel().catch(() => undefined), 1000); reader.releaseLock(); }
}
export async function catalogue(fetcher: typeof fetch, modelId: string, signal: AbortSignal): Promise<{
  rates: Rates; outputParameter: 'max_tokens' | 'max_completion_tokens'; entry: Record<string, unknown> }> {
  const response = await fetcher('https://openrouter.ai/api/v1/models',
    { method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  if (!response.ok || !response.body) throw Error('MODEL_CATALOGUE_UNAVAILABLE');
  let parsed: unknown;
  try { parsed = JSON.parse(await boundedText(response.body, 4_194_304)); }
  catch { throw Error('MODEL_CATALOGUE_UNAVAILABLE'); }
  const data = record(parsed).data;
  if (!Array.isArray(data)) throw Error('MODEL_CATALOGUE_UNAVAILABLE');
  const matches = data.filter(row => record(row).id === modelId);
  if (matches.length !== 1) throw Error('MODEL_CATALOGUE_UNAVAILABLE');
  const entry = record(matches[0]);
  const supported = entry.supported_parameters;
  if (!Array.isArray(supported)) throw Error('OUTPUT_CAP_UNPROVEN');
  const outputParameter = supported.includes('max_completion_tokens') ? 'max_completion_tokens'
    : supported.includes('max_tokens') ? 'max_tokens' : null;
  const provider = record(entry.top_provider);
  if (!outputParameter || typeof entry.context_length !== 'number' ||
    !Number.isSafeInteger(entry.context_length) || entry.context_length < 45000 ||
    typeof provider.max_completion_tokens !== 'number' ||
    !Number.isSafeInteger(provider.max_completion_tokens) || provider.max_completion_tokens < 1024)
    throw Error('OUTPUT_CAP_UNPROVEN');
  return { rates: readRates(entry), outputParameter, entry };
}
export class BudgetGuard {
  private aborter = new AbortController();
  private active: { id: CandidateId; started: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private turns = new Map<CandidateId, Set<number>>();
  private dispatched = new Set<string>(); private currentTurn: number | null = null;
  private activeMs = 0; private inputBytes = 0; private ttsBytes = 0;
  private candidateInput = 0; private candidateTts = 0; private socketOpens = 0;
  private openedSpeech = new Set<'stt' | 'tts'>(); private recoveries = 0;
  private denial: string | null = null; private socketsOpen = new Set<SpeechSocket>();
  readonly conservativeReserveUsd: number;
  get signal() { return this.aborter.signal; }
  constructor(readonly policy: GuardPolicy, rates: Rates, private clock: Clock = monotonicClock) {
    if ([rates.prompt, rates.completion, rates.request].some(n => !Number.isFinite(n) || n < 0) ||
      policy.maxContextTokens !== 45000 || policy.maxOutputTokens !== 1024 ||
      !Number.isFinite(policy.expiresAtMs)) throw Error('BUDGET_POLICY_INVALID');
    this.conservativeReserveUsd = priceEnvelope(rates, policy.maxContextTokens, policy.maxOutputTokens);
    if (this.conservativeReserveUsd > 2) throw Error('BUDGET_ENVELOPE_EXCEEDED');
  }
  private deny(code: string): never { this.denial = code; this.stop(); throw Error(code); }
  private check() {
    if (this.signal.aborted) throw Error(this.denial ?? 'BENCHMARK_STOPPED');
    if (Date.now() >= this.policy.expiresAtMs) this.deny('AUTHORIZATION_EXPIRED');
    if (this.active && (this.clock.now() - this.active.started >= 300000 ||
      this.activeMs + this.clock.now() - this.active.started >= 900000)) this.deny('ACTIVE_TIME_LIMIT');
  }
  openCandidate(id: CandidateId): () => void {
    this.check();
    if (this.active) throw Error('LIVE_CONCURRENCY_DENIED');
    if (this.turns.has(id)) this.deny('CANDIDATE_ALREADY_RUN');
    this.turns.set(id, new Set()); this.currentTurn = null;
    this.candidateInput = 0; this.candidateTts = 0; this.socketOpens = 0;
    this.openedSpeech.clear(); this.recoveries = 0;
    const remaining = Math.min(300000, 900000 - this.activeMs, this.policy.expiresAtMs - Date.now());
    const timer = setTimeout(() => { this.denial = 'ACTIVE_TIME_LIMIT'; this.stop(); }, remaining);
    timer.unref(); this.active = { id, started: this.clock.now(), timer };
    let closed = false;
    return () => {
      if (closed) return; closed = true;
      if (this.active?.id === id) {
        this.activeMs += Math.max(0, this.clock.now() - this.active.started);
        clearTimeout(this.active.timer); this.active = null;
      }
    };
  }
  submitTurn(id: CandidateId, index: number) {
    this.check();
    if (!Number.isInteger(index) || index < 0 || index > 5) this.deny('TURN_LIMIT');
    if (this.active?.id !== id) this.deny('LIVE_CANDIDATE_REQUIRED');
    const seen = this.turns.get(id)!;
    if (seen.has(index)) throw Error('TURN_ALREADY_SUBMITTED');
    if ([...this.turns.values()].reduce((n, set) => n + set.size, 0) >= 18) this.deny('TURN_LIMIT');
    seen.add(index); this.currentTurn = index;
  }
  speechSend(kind: 'stt' | 'tts', data: string | Uint8Array) {
    this.check(); if (!this.active) this.deny('LIVE_CANDIDATE_REQUIRED');
    if (kind === 'stt') {
      if (typeof data === 'string' || data.byteLength % 2) this.deny('SPEECH_FORMAT_INVALID');
      if (this.inputBytes + data.byteLength > 300000 * 32 ||
        this.candidateInput + data.byteLength > 150000 * 32) this.deny('SPEECH_LIMIT');
      this.inputBytes += data.byteLength; this.candidateInput += data.byteLength;
    } else {
      if (typeof data !== 'string') this.deny('SPEECH_FORMAT_INVALID');
      const size = Buffer.byteLength(data);
      if (this.ttsBytes + size > 8000 || this.candidateTts + size > 4000) this.deny('SPEECH_LIMIT');
      this.ttsBytes += size; this.candidateTts += size;
    }
  }
  speechOpen(kind: 'stt' | 'tts') {
    this.check();
    if (!this.active || this.openedSpeech.has(kind)) this.deny('SPEECH_RETRY_DENIED');
    this.openedSpeech.add(kind);
  }
  allowSpeechRecovery(reason: 'VOICE_DELIVERY_UNKNOWN') {
    this.check();
    if (reason !== 'VOICE_DELIVERY_UNKNOWN' || !this.active || this.recoveries >= 5)
      this.deny('SPEECH_RETRY_DENIED');
    this.recoveries++; this.openedSpeech.clear();
  }
  fetch(fetcher: typeof fetch): typeof fetch {
    return async (input, init) => {
      this.check();
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== 'https://openrouter.ai' || url.username || url.password) this.deny('EGRESS_POLICY_DENIED');
      if (request.method === 'GET' && ['/api/v1/models', '/api/v1/generation'].includes(url.pathname)) {
        return fetcher(request, { redirect: 'error',
          signal: AbortSignal.any([request.signal, this.signal, AbortSignal.timeout(10000)]) });
      }
      if (request.method !== 'POST' || url.pathname !== '/api/v1/chat/completions' ||
        url.search || !this.active || this.currentTurn === null) this.deny('EGRESS_POLICY_DENIED');
      if (!request.body || Number(request.headers.get('content-length') ?? '0') > 200000)
        this.deny('EGRESS_POLICY_DENIED');
      let body: Record<string, unknown>;
      try { body = record(JSON.parse(await boundedText(request.body!, 200000))); }
      catch { this.deny('EGRESS_POLICY_DENIED'); }
      if (['route', 'functions', 'function_call', 'web_search_options'].some(key => body[key] !== undefined) ||
        body.max_tokens !== undefined && body.max_completion_tokens !== undefined &&
          body.max_tokens !== body.max_completion_tokens) this.deny('EGRESS_POLICY_DENIED');
      if (body.transforms !== undefined &&
        (!Array.isArray(body.transforms) || body.transforms.length)) this.deny('EGRESS_POLICY_DENIED');
      if (body.plugins !== undefined && (!Array.isArray(body.plugins) ||
        body.plugins.some(plugin => !plugin || typeof plugin !== 'object' || plugin.enabled !== false)))
        this.deny('EGRESS_POLICY_DENIED');
      if (body.provider !== undefined) {
        const routing = body.provider as Record<string, unknown>;
        if (!routing || typeof routing !== 'object' || Array.isArray(routing) ||
          Object.keys(routing).some(key => !['data_collection', 'require_parameters', 'allow_fallbacks'].includes(key)) ||
          routing.data_collection !== undefined && routing.data_collection !== 'deny' ||
          routing.require_parameters !== undefined && routing.require_parameters !== true ||
          routing.allow_fallbacks !== undefined && routing.allow_fallbacks !== false)
          this.deny('EGRESS_POLICY_DENIED');
      }
      const parameter = this.policy.outputParameter;
      const output = body.max_tokens ?? body.max_completion_tokens;
      const messages = body.messages;
      if (body.model !== this.policy.modelId || body.user !== this.policy.userId ||
        body.models !== undefined || body.tools !== undefined || body.tool_choice !== undefined ||
        !Array.isArray(messages) || !messages.length || messages.length > 500 ||
        !Number.isSafeInteger(output) || Number(output) < 1 || Number(output) > this.policy.maxOutputTokens)
        this.deny('EGRESS_POLICY_DENIED');
      let estimate = 64;
      for (const message of messages as Array<Record<string, unknown>>) {
        if (!['system', 'assistant', 'user'].includes(String(message.role)) ||
          typeof message.content !== 'string') this.deny('EGRESS_POLICY_DENIED');
        estimate += Buffer.byteLength(message.content as string) + 32;
      }
      if (estimate + Number(output) + this.policy.modelMarginTokens > this.policy.maxContextTokens)
        this.deny('CONTEXT_BUDGET_EXCEEDED');
      const key = `${this.active.id}:${this.currentTurn}`;
      if (this.dispatched.has(key) || this.dispatched.size >= 18) this.deny('MODEL_ATTEMPT_LIMIT');
      // Explicit benchmark-only tightening, recorded in provenance; never saved.
      body.provider = { data_collection: 'deny', require_parameters: true, allow_fallbacks: false };
      body.transforms = [];
      body.plugins = ['context-compression', 'web', 'file-parser', 'response-healing']
        .map(id => ({ id, enabled: false }));
      delete body.max_tokens; delete body.max_completion_tokens; body[parameter] = output;
      this.check(); this.dispatched.add(key); // Count even a failed/ambiguous send; never refund.
      return fetcher(new Request(request, { body: JSON.stringify(body) }), { redirect: 'error',
        signal: AbortSignal.any([request.signal, this.signal, AbortSignal.timeout(60000)]) });
    };
  }
  sockets(factory: SocketFactory): SocketFactory {
    return (url, headers) => {
      this.check(); if (!this.active) this.deny('LIVE_CANDIDATE_REQUIRED');
      const expected = this.policy.region === 'eu' ? 'wss://api.eu.deepgram.com' : 'wss://api.deepgram.com';
      const tts = url.pathname === '/v2/speak';
      if (url.origin !== expected || url.username || url.password || this.socketOpens >= 16 ||
        !(tts && url.searchParams.get('model') === this.policy.ttsModel ||
          url.pathname === '/v2/listen' && url.searchParams.get('model') === this.policy.sttModel) ||
        url.searchParams.has('eager_eot_threshold')) this.deny('EGRESS_POLICY_DENIED');
      if (url.searchParams.has('encoding') && url.searchParams.get('encoding') !== 'linear16' ||
        url.searchParams.has('sample_rate') && url.searchParams.get('sample_rate') !== (tts ? '24000' : '16000'))
        this.deny('EGRESS_POLICY_DENIED');
      this.speechOpen(tts ? 'tts' : 'stt');
      this.socketOpens++;
      const socket = factory(url, headers), send = socket.send.bind(socket);
      this.socketsOpen.add(socket); socket.once('close', () => this.socketsOpen.delete(socket));
      socket.send = (data, callback) => {
        try {
          this.check();
          if (typeof data === 'string') {
            const message = JSON.parse(data);
            if (message.type === 'Speak' && tts) this.speechSend('tts', message.text);
            else if (!['Flush', 'Close', 'CloseStream', 'ForceEndTurn', 'Interrupt'].includes(message.type))
              this.deny('EGRESS_POLICY_DENIED');
          } else if (tts) this.deny('EGRESS_POLICY_DENIED'); else this.speechSend('stt', data);
        } catch {
          this.denial ??= 'EGRESS_POLICY_DENIED'; this.stop();
          callback(Error(this.denial)); return;
        }
        send(data, callback);
      };
      return socket;
    };
  }
  snapshot() {
    return { submittedTurns: [...this.turns.values()].reduce((n, set) => n + set.size, 0),
      modelDispatches: this.dispatched.size,
      activeMs: this.activeMs + (this.active ? Math.max(0, this.clock.now() - this.active.started) : 0),
      sttAudioMs: this.inputBytes / 32, ttsInputBytes: this.ttsBytes,
      conservativeReserveUsd: this.conservativeReserveUsd, denied: this.denial };
  }
  submittedIndices(id: CandidateId) { return [...(this.turns.get(id) ?? [])].sort((a, b) => a - b); }
  get openSocketCount() { return this.socketsOpen.size; }
  stop() {
    if (this.active) {
      this.activeMs += Math.max(0, this.clock.now() - this.active.started);
      clearTimeout(this.active.timer); this.active = null;
    }
    this.aborter.abort();
    for (const socket of this.socketsOpen) { try { socket.terminate(); } catch { /* counted as cleanup unknown */ } }
  }
}
```

The socket gate checks explicit PCM format parameters. Omitted parameters may use verified locked-provider defaults only when recorded in provenance. `speechOpen` rejects invisible reconnect/retry attempts; the Aurvin adapter permits a new speech epoch only for an explicitly recorded recoverable unknown-delivery pause, never to replay the accepted input. Guarded plugins must use the same open/send checks. Agent v1 URLs are not admitted: P3 is structurally blocked before paid admission.

Task 11 supplies the remaining exact pricing/expiry/UTF-8/socket/deadline/catalogue table fixtures using synthetic sockets and stubbed fetch. The monetary estimate reserves the entire original 18-turn envelope even when P3 is blocked, so there is no reallocation or hidden second pilot.

- [ ] **Step 4: Run GREEN:** `npm test -- shared/__tests__/budget-guard.test.ts`. Verify expected price formula against a calculator; fix the assertion to the exact rounded formula output, never the production formula to match a historical example.
- [ ] **Step 5: Request commit:** `feat(voice-bench): enforce shared dynamic-price zero-retry egress budget`.

## Task 6: Provide the reusable native WebRTC participant

**Files:** Create `shared/webrtc-participant.ts`, `shared/__tests__/webrtc-participant.test.ts`.

- [ ] **Step 1: Write the failure-oriented native fixture test.**

```ts
/**
 * ============================================================================
 * FILE: webrtc-participant.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/webrtc-participant.test.ts
 * PURPOSE: Verify native caller lifecycle without loading native code/network.
 * ROLE IN PROJECT: Reusable P1/P2 transport fixture with exact frame capture.
 * KEY COMPONENTS: Fake RTC module; input conversion; no playback claims.
 * ============================================================================
 */
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ captured: [] as Int16Array[], controls: [] as unknown[],
  disconnects: 0, clears: 0 }));
vi.mock('@livekit/rtc-node', () => {
  class Room extends EventEmitter {
    name = 'owned-room';
    localParticipant = { publishTrack: async () => ({}),
      publishData: async (data: Uint8Array) => { state.controls.push(JSON.parse(new TextDecoder().decode(data))); } };
    async connect() {} async disconnect() { state.disconnects++; }
  }
  class AudioSource {
    queuedDuration = 0; async captureFrame(frame: { data: Int16Array }) { state.captured.push(frame.data); }
    clearQueue() { state.clears++; } async close() {}
  }
  return { Room, AudioSource, AudioFrame: class { constructor(public data: Int16Array) {} },
    LocalAudioTrack: { createAudioTrack: () => ({ close: async () => undefined }) },
    TrackPublishOptions: class {}, TrackSource: { SOURCE_MICROPHONE: 1 },
    RoomEvent: { DataReceived: 'data', TrackSubscribed: 'track', Disconnected: 'disconnected',
      Reconnecting: 'reconnecting', TrackUnsubscribed: 'unsubscribed', TrackSubscriptionFailed: 'subscription-failed' } };
});
import { createParticipant } from '../webrtc-participant.js';
it('captures aligned PCM and sends only caller-requested controls', async () => {
  let now = 0;
  const participant = await createParticipant({ url: 'wss://fixture.invalid', token: 'not-a-secret-fixture',
    roomName: 'owned-room', agentIdentity: 'synthetic-agent', clock: { now: () => now },
    signal: new AbortController().signal, sleepFor: async ms => { now += ms; },
    onPcm: () => undefined, onControl: () => undefined, onFault: () => undefined });
  const bytes = Buffer.alloc(2560); bytes.writeInt16LE(-123, 0);
  await participant.play(bytes);
  expect(state.captured[0][0]).toBe(-123);
  expect(state.controls).toEqual([]);
  expect(await participant.close()).toBe(true);
  expect(await participant.close()).toBe(true);
  expect(state.disconnects).toBe(1);
  expect(state.clears).toBe(1);
});
```

- [ ] **Step 2: Run RED:** `npm test -- shared/__tests__/webrtc-participant.test.ts`.
- [ ] **Step 3: Create the participant.**

```ts
/**
 * ============================================================================
 * FILE: webrtc-participant.ts
 * LOCATION: benchmarks/voice-architectures/shared/webrtc-participant.ts
 * PURPOSE: Publish paced 16 kHz input and continuously consume 24 kHz decoded PCM.
 * ROLE IN PROJECT: Real headless WebRTC caller, not an audible-playback witness.
 * KEY COMPONENTS: Lazy native import; sender binding; late-join cleanup.
 * ============================================================================
 */
import { bounded, pacePcm, wait, type Clock } from './timing.js';
type Options = { url: string; token: string; roomName: string; agentIdentity: string;
  clock: Clock; signal: AbortSignal; sleepFor?: (ms: number) => Promise<unknown>;
  onPcm(data: Int16Array, rate: number, channels: number): void;
  onControl(data: Uint8Array): void; onFault(code: string): void };
export type Participant = {
  play(pcm: Uint8Array, firstFrame?: (clockMs: number) => void):
    Promise<{ latenessMs: number; maxQueuedMs: number }>;
  sendControl(payload: unknown): Promise<void>;
  close(): Promise<boolean>; connectedAtMs: number;
};
export async function createParticipant(options: Options): Promise<Participant> {
  const rtc = await import('@livekit/rtc-node');
  const room = new rtc.Room(), source = new rtc.AudioSource(16000, 1, 1000);
  let track: ReturnType<typeof rtc.LocalAudioTrack.createAudioTrack> | undefined;
  let reader: ReadableStreamDefaultReader<import('@livekit/rtc-node').AudioFrame> | undefined;
  let media: Promise<void> | undefined; let closing = false;
  let closed: Promise<boolean> | undefined; let joined = false;
  const fault = (code: string) => { if (!closing) options.onFault(code); };
  const disconnect = async () => { if (joined) { joined = false; await room.disconnect(); } };
  const close = (): Promise<boolean> => closed ??= (async () => {
    closing = true; options.signal.removeEventListener('abort', abort);
    source.clearQueue();
    const results = await Promise.allSettled([
      bounded(Promise.resolve(reader?.cancel()), 2000),
      bounded(Promise.resolve(track?.close()), 2000),
      bounded(Promise.resolve(source.close()), 2000), bounded(disconnect(), 2000),
      bounded(media ?? Promise.resolve(), 2000)
    ]);
    room.removeAllListeners();
    return results.every(result => result.status === 'fulfilled');
  })();
  const abort = () => { fault('BENCHMARK_TIMEOUT'); void close(); };
  room.on(rtc.RoomEvent.DataReceived, (bytes, participant, _kind, topic) => {
    if (closing || topic !== 'aurvin.voice.control') return;
    if (participant?.identity !== options.agentIdentity || bytes.length > 131072) {
      fault('CONTROL_BINDING_INVALID'); return;
    }
    options.onControl(bytes);
  });
  room.on(rtc.RoomEvent.TrackSubscribed, (remote, _publication, participant) => {
    if (closing || participant.identity !== options.agentIdentity) return;
    if (!(remote instanceof rtc.RemoteAudioTrack) || reader) { fault('MEDIA_BINDING_INVALID'); return; }
    reader = new rtc.AudioStream(remote, { sampleRate: 24000, numChannels: 1 }).getReader();
    const ownedReader = reader;
    media = (async () => {
      try {
        while (!closing && !options.signal.aborted) {
          const next = await ownedReader.read();
          if (next.done) { if (!closing) fault('MEDIA_EARLY_CLOSE'); return; }
          options.onPcm(next.value.data, next.value.sampleRate, next.value.channels);
        }
      } catch { if (!closing) fault('MEDIA_READ_FAILED'); }
      finally { ownedReader.releaseLock(); }
    })();
  });
  for (const event of [rtc.RoomEvent.Disconnected, rtc.RoomEvent.Reconnecting,
    rtc.RoomEvent.TrackUnsubscribed, rtc.RoomEvent.TrackSubscriptionFailed]) {
    room.on(event, () => fault('MEDIA_CONNECTION_LOST'));
  }
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.signal.throwIfAborted();
    const joining = room.connect(options.url, options.token).then(async () => {
      joined = true; if (closing || options.signal.aborted) await disconnect();
    });
    // Keep this handler attached: a late successful join still leaves its room.
    void joining.catch(() => undefined);
    await bounded(joining, 10000);
    options.signal.throwIfAborted();
    if (closing || room.name !== options.roomName || !room.localParticipant) throw Error('MEDIA_BINDING_INVALID');
    track = rtc.LocalAudioTrack.createAudioTrack('voice-benchmark-input', source);
    await bounded(room.localParticipant.publishTrack(track,
      new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE })), 10000);
    return {
      connectedAtMs: options.clock.now(),
      play: async (pcm, firstFrame) => {
        let maxQueuedMs = 0, first = true;
        const latenessMs = await pacePcm(pcm, options.clock,
          options.sleepFor ?? (ms => wait(ms, options.signal)), async bytes => {
            options.signal.throwIfAborted();
            if (closing || !Number.isFinite(source.queuedDuration) || source.queuedDuration < 0 ||
              source.queuedDuration + 80 > 1000) throw Error('INPUT_QUEUE_OVERFLOW');
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const samples = Int16Array.from({ length: 1280 }, (_, index) => view.getInt16(index * 2, true));
            if (first) { firstFrame?.(options.clock.now()); first = false; }
            await bounded(source.captureFrame(new rtc.AudioFrame(samples, 16000, 1, 1280)), 2000);
            maxQueuedMs = Math.max(maxQueuedMs, source.queuedDuration);
          }, options.signal);
        return { latenessMs, maxQueuedMs };
      },
      sendControl: async payload => {
        options.signal.throwIfAborted(); if (closing) throw Error('PARTICIPANT_CLOSED');
        await bounded(room.localParticipant!.publishData(
          new TextEncoder().encode(JSON.stringify(payload)), { reliable: true,
            topic: 'aurvin.voice.control', destination_identities: [options.agentIdentity] }), 2000);
      }, close
    };
  } catch { await close(); throw Error('BENCHMARK_MEDIA_FAILED'); }
}
```

Do not emit `playback.progress` anywhere in this module. It deliberately knows nothing about Aurvin delivery proof or AgentSession completion. Native queue duration units must be confirmed against locked `rtc-node@1.2.2` `.d.ts`/source; existing backend uses milliseconds. If the installed API differs, adapt this one shared conversion and test it rather than changing each caller.

- [ ] **Step 4: Run GREEN:** `npm test -- shared/__tests__/webrtc-participant.test.ts`. Task 11's lifecycle fixture supplies late-connect, terminal-tail, binding, early-close, abort, and cleanup-failure tests; do not infer their results from this task's one check.
- [ ] **Step 5: Request commit:** `feat(voice-bench): add reusable headless WebRTC participant`.

## Task 7: Compile honest per-architecture evidence and the qualified verdict

**Files:** Create `shared/compiler.ts`, `shared/__tests__/compiler.test.ts`, `aurvin/report.ts`.

- [ ] **Step 1: Write the failing report tests.**

```ts
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
```

- [ ] **Step 2: Run RED:** `npm test -- shared/__tests__/compiler.test.ts`.
- [ ] **Step 3: Create the compiler and Aurvin wrapper.**

```ts
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
    '## Limitations', ...r.limitations.map(line => `- ${line}`), ''
  ].join('\n\n');
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
  return [
    '# Voice architectures: qualified screening verdict',
    '## Verdict',
    violation ? '**ENVELOPE_VIOLATION: retain this failed evidence; no further live work.**'
      : 'Finite envelope: within recorded aggregate bounds.',
    `Live observations: ${live.map(r => r.candidate).join(', ') || 'none'}. ` +
      `Blocked/unrun: ${blocked.map(r => r.candidate).join(', ') || 'none'}.`,
    '**No successful-completion winner is established by decoded headless output.**',
    'Keep Aurvin as the application baseline. Treat real Agents onset/interruption evidence as a follow-up evaluation signal, not migration approval. ' +
      'Keep direct Deepgram BYO blocked until a separate decision resolves attribution, routing/privacy, output caps and retry/dispatch control without unauthorized infrastructure.',
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
    'Unified review: skipped.', ''
  ].join('\n\n');
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
```

`aurvin/report.ts`:

```ts
/**
 * ============================================================================
 * FILE: report.ts
 * LOCATION: benchmarks/voice-architectures/aurvin/report.ts
 * PURPOSE: Expose the shared safe per-architecture writer for Aurvin.
 * ROLE IN PROJECT: Avoid a second report format or playback-proof interpretation.
 * KEY COMPONENTS: writeReport export.
 * ============================================================================
 */
export { writeArchitectureReport as writeReport } from '../shared/compiler.js';
```

- [ ] **Step 4: Run GREEN:** `npm test -- shared/__tests__/compiler.test.ts`. Reports are generated by V1; P1 need not create tracked empirical `report.md` files. P2/P3 use the same wrapper pattern within their ownership.
- [ ] **Step 5: Request commit:** `feat(voice-bench): compile separated onset interruption and proof reports`.

## Task 8: Verify compiled baseline freshness and construct an isolated application

**Files:** Create `aurvin/preflight.ts`, `aurvin/__tests__/preflight.test.ts`.

- [ ] **Step 1: Write these failing pure-boundary tests.**

```ts
/**
 * ============================================================================
 * FILE: preflight.test.ts
 * LOCATION: benchmarks/voice-architectures/aurvin/__tests__/preflight.test.ts
 * PURPOSE: Reject source DB reuse and writable source configuration.
 * ROLE IN PROJECT: Baseline boot admission without Mongo, WorkOS, or providers.
 * KEY COMPONENTS: Isolated bootstrap; immutable repository; build byte match.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import { isolatedBootstrap, readOnlyConfig, emittedMatches } from '../preflight.js';
import type { Bootstrap, StoredDocument } from '../../shared/credentials.js';
it('never reuses the source database or enables external auth/calendar', () => {
  const source = { persistence: { mongoDbName: 'application', mongoUri: 'mongodb://fixture.invalid',
    profile: 'native-mongodb', documentHeadroomBytes: 1 },
    identity: { userId: 'synthetic-user' }, topology: { executor: 'single-process', localCrashRecovery: true },
    encryption: { status: 'missing' }, safety: {}, workos: { live: true }, calendar: { live: true },
    port: 3000, frontendOrigin: 'http://localhost:5173', nodeEnv: 'development' } satisfies Bootstrap;
  const isolated = isolatedBootstrap(source, '00000000-0000-4000-8000-000000000001');
  expect(isolated.persistence.mongoDbName).toBe('aurvin_voice_arch_00000000000040008000000000000001');
  expect(isolated.workos).toBeNull(); expect(isolated.calendar).toBeNull();
  expect(isolated.topology.localCrashRecovery).toBe(false);
  expect(source.persistence.mongoDbName).toBe('application');
});
it('offers a read-only clone rather than a writable config repository', async () => {
  const document = { revision: 1 } as StoredDocument;
  const repository = readOnlyConfig(document);
  const copy = await repository.read(); copy.revision = 9;
  expect((await repository.read()).revision).toBe(1);
  await expect(repository.createIfAbsent()).rejects.toThrow('READ_ONLY_CONFIG');
  await expect(repository.compareAndSwap()).rejects.toThrow('READ_ONLY_CONFIG');
});
it('detects stale emitted code without relying on timestamps', () => {
  expect(emittedMatches('export const value: number = 1;', 'export const value = 1;\n')).toBe(true);
  expect(emittedMatches('export const value: number = 2;', 'export const value = 1;\n')).toBe(false);
});
```

- [ ] **Step 2: Run RED:** `npm test -- aurvin/__tests__/preflight.test.ts`.
- [ ] **Step 3: Create the read-only preflight/boot helpers.**

```ts
/**
 * ============================================================================
 * FILE: preflight.ts
 * LOCATION: benchmarks/voice-architectures/aurvin/preflight.ts
 * PURPOSE: Verify real compiled code and boot only an owned isolated database.
 * ROLE IN PROJECT: Baseline uses production composition, never production data.
 * KEY COMPONENTS: verifyBuild; isolatedBootstrap; readOnlyConfig; startAurvin.
 * ============================================================================
 */
import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import { RoomServiceClient } from 'livekit-server-sdk';
import { backendModule, type Bootstrap, type StoredDocument } from '../shared/credentials.js';
import { hash } from '../shared/compiler.js';
import { bounded } from '../shared/timing.js';
import type { RunContext } from '../shared/contracts.js';
export function emittedMatches(source: string, built: string, filename = 'module.ts',
  options: ts.CompilerOptions = {}): boolean {
  const normalize = (text: string) => text.replace(/\r\n/g, '\n')
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '').trim();
  const emitted = ts.transpileModule(source, { fileName: filename, compilerOptions: {
    ...options, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
    removeComments: true, experimentalDecorators: true, emitDecoratorMetadata: true,
    isolatedModules: true, sourceMap: false, declaration: false
  } });
  return normalize(emitted.outputText) === normalize(built);
}
async function files(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error('BASELINE_BUILD_UNVERIFIABLE');
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) out.push(...await files(full)); else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}
export async function verifyBuild(repoRoot: string) {
  try {
    const root = resolve(repoRoot, 'backend'), sourceRoot = resolve(root, 'src'), dist = resolve(root, 'dist');
    const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
    if (config.error) throw Error();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    if (parsed.errors.length) throw Error();
    const sourceRecords: string[] = [], builtRecords: string[] = [];
    for (const file of await files(sourceRoot)) {
      if (!file.endsWith('.ts') || file.endsWith('.d.ts') || /\.(spec|test)\.ts$/.test(file)) continue;
      const name = relative(sourceRoot, file).replaceAll('\\', '/');
      const source = await readFile(file, 'utf8');
      const built = await readFile(resolve(dist, name.replace(/\.ts$/, '.js')), 'utf8');
      if (!emittedMatches(source, built, file, parsed.options)) throw Error();
      sourceRecords.push(`${name}\0${source}`);
    }
    for (const file of await files(dist)) {
      if (/\.(js|map|json)$/.test(file)) builtRecords.push(
        `${relative(dist, file).replaceAll('\\', '/')}\0${await readFile(file, 'utf8')}`);
    }
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'nest-cli.json']) {
      sourceRecords.push(`${name}\0${await readFile(resolve(root, name), 'utf8')}`);
    }
    sourceRecords.push(await readFile(resolve(repoRoot, 'product_knowledge.md'), 'utf8'));
    sourceRecords.push(await readFile(resolve(sourceRoot, 'instructions/system.md'), 'utf8'));
    if (!sourceRecords.length || !builtRecords.length) throw Error();
    return { sourceHash: hash(sourceRecords.join('\0')), buildHash: hash(builtRecords.join('\0')) };
  } catch { throw Error('BASELINE_BUILD_STALE'); }
}
export function isolatedBootstrap(source: Bootstrap, runId: string): Bootstrap {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw Error('RUN_ID_INVALID');
  const mongoDbName = `aurvin_voice_arch_${runId.replaceAll('-', '')}`;
  if (mongoDbName === source.persistence.mongoDbName || source.persistence.profile !== 'native-mongodb')
    throw Error('ISOLATED_DATABASE_REQUIRED');
  return { ...source, persistence: { ...source.persistence, mongoDbName },
    calendar: null, workos: null, topology: { executor: 'single-process', localCrashRecovery: false } };
}
export function readOnlyConfig(document: StoredDocument) {
  return { read: async () => structuredClone(document),
    createIfAbsent: async (): Promise<never> => { throw Error('READ_ONLY_CONFIG'); },
    compareAndSwap: async (): Promise<never> => { throw Error('READ_ONLY_CONFIG'); } };
}
export type Principal = { account: Record<string, unknown>; sessionId: string;
  identity: { userId: string; openRouterUser: string; source: 'authenticated-session' } };
export type AurvinSession = { sessionId: string; conversationId: string | null; connectionEpoch: number;
  livekit: { url: string; participantToken: string; roomName: string; participantIdentity: string } };
export type AurvinService = {
  users: { insert(account: unknown): Promise<unknown> };
  voiceSessions: { create(body: unknown, origin: string, principal: Principal):
    Promise<{ response: AurvinSession }>; endOwned(id: string, principal: Principal): Promise<void> };
  operations: { readiness: { read(): Promise<{ acceptReady: boolean; speech: string }> };
    shutdown(): Promise<unknown> };
};
export async function startAurvin(context: RunContext, checkBuild = verifyBuild) {
  const credentials = context.credentials, guard = context.guard;
  if (!credentials || !guard || context.mode !== 'live') throw Error('LIVE_CONTEXT_REQUIRED');
  await checkBuild(context.repoRoot);
  const bootstrap = isolatedBootstrap(credentials.bootstrap, context.runId);
  const { setupIndexes } = await backendModule<{ setupIndexes(db: Db): Promise<unknown> }>(
    context.repoRoot, 'persistence/indexes.js');
  const { loadFixedAssets } = await backendModule<{
    loadFixedAssets(paths: { instructions: string; knowledge: string }): Promise<unknown>
  }>(context.repoRoot, 'instructions/fixed-assets.js');
  const { computeChatFloor } = await backendModule<{
    computeChatFloor(assets: unknown, chat: Record<string, number>): { minContextTokens: number }
  }>(context.repoRoot, 'context/prefix-estimate.js');
  const assets = await loadFixedAssets({ instructions: resolve(context.repoRoot, 'backend/src/instructions/system.md'),
    knowledge: resolve(context.repoRoot, 'product_knowledge.md') });
  if (computeChatFloor(assets, credentials.settings.chat).minContextTokens >
    credentials.settings.chat.maxContextTokens) throw Error('BASELINE_CONTEXT_FLOOR');
  const client = new MongoClient(bootstrap.persistence.mongoUri, { serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000, timeoutMS: 10000, retryReads: false, retryWrites: false });
  try {
    await client.connect();
    const db = client.db(bootstrap.persistence.mongoDbName);
    if ((await db.listCollections({}, { nameOnly: true }).toArray()).length) throw Error('BENCHMARK_DATABASE_EXISTS');
    await db.createCollection('benchmark_run'); // Atomic namespace claim; never adopt a preexisting DB.
    await db.collection('benchmark_run').insertOne({ runId: context.runId, createdAt: context.startedAtIso });
    await setupIndexes(db);
  } finally { await client.close(); }
  const { AppService } = await backendModule<{
    AppService: { create(bootstrap: Bootstrap, ports: Record<string, unknown>): Promise<AurvinService> }
  }>(context.repoRoot, 'app.service.js');
  const { socketFactory } = await backendModule<{ socketFactory: import('../shared/budget-guard.js').SocketFactory }>(
    context.repoRoot, 'voice/providers/provider-link.js');
  const forbidden = async (): Promise<never> => { throw Error('BENCHMARK_AUTH_OPERATION_FORBIDDEN'); };
  const authProvider = { login: forbidden, read: forbidden, revoke: forbidden, replacePassword: forbidden,
    sendRecovery: forbidden, reset: forbidden, createUser: forbidden, getUser: forbidden, listSessions: forbidden };
  const roomConfig = bootstrap.livekit;
  if (!roomConfig) throw Error('LIVEKIT_UNCONFIGURED');
  const roomClient = new RoomServiceClient(roomConfig.url, roomConfig.apiKey, roomConfig.apiSecret,
    { requestTimeout: 2, failover: false });
  type Ticket = { transport: AurvinSession['livekit']; agentIdentity: string; agentToken: string };
  const { LiveKitAdmission } = await backendModule<{
    LiveKitAdmission: new () => { issue(command: unknown): Promise<Ticket>; [key: string]: unknown }
  }>(context.repoRoot, 'voice/session/livekit-admission.js');
  const admission = new LiveKitAdmission(), rooms = new Set<string>();
  const issue = admission.issue.bind(admission);
  admission.issue = async command => {
    const ticket = await issue(command);
    context.redactor.add([ticket.transport.participantToken, ticket.agentToken]);
    if ((await bounded(roomClient.listRooms([ticket.transport.roomName]), 3000)).length)
      throw Error('BENCHMARK_ROOM_EXISTS');
    rooms.add(ticket.transport.roomName);
    return ticket;
  };
  const service = await AppService.create(bootstrap, {
    assets: async () => assets, authProvider: () => authProvider,
    configRepository: () => readOnlyConfig(credentials.document),
    livekitAdmission: admission, fetcher: guard.fetch(fetch),
    speechSockets: guard.sockets(socketFactory),
    writeLog: (line: string) => { try { context.redactor.encode(line); }
      catch { guard.stop(); throw Error('BENCHMARK_REDACTION_FAILED'); } }
  });
  const now = new Date().toISOString(), sessionId = `bench_${context.runId}`;
  const account = { schemaVersion: 1, userId: bootstrap.identity.userId, workosUserId: 'user_bench_local',
    emailNormalized: 'voice-benchmark@example.invalid', role: 'super-admin', status: 'active',
    passwordChangeRequired: false, currentWorkosSessionId: sessionId, sessionEpoch: 0,
    createdAt: now, updatedAt: now };
  const principal: Principal = { account, sessionId, identity: { userId: bootstrap.identity.userId,
    openRouterUser: bootstrap.identity.userId, source: 'authenticated-session' } };
  try {
    await service.users.insert(account);
    const readiness = await service.operations.readiness.read();
    if (!readiness.acceptReady || readiness.speech !== 'ready') throw Error('BASELINE_NOT_READY');
  } catch { await bounded(service.operations.shutdown(), 10000); throw Error('BASELINE_NOT_READY'); }
  return { service, principal, bootstrap, rooms, roomClient };
}
```

`emittedMatches` intentionally blocks if compiler output cannot be matched; it does not bless a timestamp-only build. Verify the lockfile's TypeScript version matches the backend build identity. Report an unverifiable compiler difference, do not loosen the check just to admit stale output. A missing `dist/context/prefix-estimate.js` is specifically blocked. All compilation here is in memory; no files under `backend/` are emitted.

Preserve source settings revision in provenance but capture every benchmark-only override. `retryMaxAttempts=1` means one application attempt, not a retry setting of zero accepted by a positive-only schema. The egress ledger remains the final defense against any unexpected second request.

- [ ] **Step 4: Run GREEN:** `npm test -- aurvin/__tests__/preflight.test.ts`. AppService constructor or `initialize` failure must never cause an untracked executor: retain the isolated DB name and report cleanup uncertainty. No preexisting database is dropped; even successful benchmark databases remain retained for audit.
- [ ] **Step 5: Request commit:** `feat(voice-bench): isolate real Aurvin bootstrap and reject stale builds`.

## Task 9: Drive actual Aurvin voice sessions without inventing playback proof

**Files:** Create `aurvin/harness.ts`, `aurvin/__tests__/harness.test.ts`.

- [ ] **Step 1: Write the exact failing delivery/state tests.**

```ts
/**
 * ============================================================================
 * FILE: harness.test.ts
 * LOCATION: benchmarks/voice-architectures/aurvin/__tests__/harness.test.ts
 * PURPOSE: Preserve real baseline delivery failures after decoded onset.
 * ROLE IN PROJECT: Pure deterministic control/PCM fixtures, no AppService boot.
 * KEY COMPONENTS: Unknown delivery; stale response; no forged progress.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import { AurvinTurnState, harness } from '../harness.js';
it('retains onset when application completion becomes unknown', () => {
  let now = 1000;
  const state = new AurvinTurnState(1, 1100, { now: () => now });
  state.event({ type: 'audio.start', turnId: 't1', responseId: 'r1' });
  now = 1200; state.frame(Int16Array.of(1), 24000, 1);
  state.event({ type: 'audio.end', turnId: 't1', responseId: 'r1' });
  state.event({ type: 'session.error', code: 'VOICE_DELIVERY_UNKNOWN', recoverable: true, terminal: false });
  expect(state.result()).toMatchObject({ speechEndToFirstAudioMs: 100,
    outcome: 'unverified-playback', durableCompletionStatus: 'unknown',
    failureCode: 'BENCHMARK_UNPROVEN_PLAYBACK' });
  expect(state.paused).toBe(true);
  expect(state.controlsForRecovery()).toEqual([{ type: 'input.unmute' }]);
});
it('ignores stale terminal response IDs and does not accept provider completion as audible proof', () => {
  let now = 0; const state = new AurvinTurnState(2, 1, { now: () => now });
  state.event({ type: 'audio.start', turnId: 't2', responseId: 'r2' });
  state.event({ type: 'audio.end', turnId: 'old', responseId: 'old' });
  expect(state.ended).toBe(false);
  now = 100; state.frame(Int16Array.of(1), 24000, 1);
  state.event({ type: 'audio.end', turnId: 't2', responseId: 'r2' });
  expect(state.result().outcome).toBe('unverified-playback');
  expect(state.controlsForRecovery().some(control => control.type === 'playback.progress')).toBe(false);
});
it('selects the actual Aurvin adapter, not an existing single-turn backend runner', () => {
  expect(harness.id).toBe('aurvin');
  expect(typeof harness.run).toBe('function');
});
it('keeps early output, post-cancel audio, and unobservable stages distinct', () => {
  let now = 1000;
  const early = new AurvinTurnState(3, 1200, { now: () => now });
  early.event({ type: 'audio.start', turnId: 't3', responseId: 'r3' });
  now = 1100; early.frame(Int16Array.of(1), 24000, 1);
  expect(early.result()).toMatchObject({ earlyEndpoint: true, speechEndToFirstAudioMs: null,
    outcome: 'early-endpoint', modelFirstOutputMs: null, ttsFirstAudioMs: null });
  const late = new AurvinTurnState(4, 1000, { now: () => now });
  late.event({ type: 'audio.start', turnId: 't4', responseId: 'r4' });
  now = 1700; late.frame(Int16Array.of(1), 24000, 1);
  late.observer.interrupt();
  late.event({ type: 'response.cancelled', turnId: 't4', responseId: 'r4' });
  now = 1720; late.frame(Int16Array.of(1), 24000, 1);
  expect(late.result().staleTailNonzeroFrames).toBeNull();
  expect(late.controlsForRecovery().some(control => control.type === 'playback.progress')).toBe(false);
  const failed = new AurvinTurnState(1, 1000, { now: () => now });
  failed.event({ type: 'audio.start', turnId: 't1', responseId: 'r1' });
  failed.event({ type: 'session.error', code: 'STT_UNAVAILABLE', recoverable: false, terminal: true });
  expect(failed.result()).toMatchObject({ outcome: 'failed', failureCode: 'STT_UNAVAILABLE',
    durableCompletionStatus: 'unknown' });
});
```

- [ ] **Step 2: Run RED:** `npm test -- aurvin/__tests__/harness.test.ts`.
- [ ] **Step 3: Create the adapter and turn state.**

```ts
/**
 * ============================================================================
 * FILE: harness.ts
 * LOCATION: benchmarks/voice-architectures/aurvin/harness.ts
 * PURPOSE: Exercise real application admission/context/voice over native WebRTC.
 * ROLE IN PROJECT: Aurvin baseline only; no production patch or playback ACK.
 * KEY COMPONENTS: AurvinTurnState; preflight; sequential six-input driver.
 * ============================================================================
 */
import { randomUUID } from 'node:crypto';
import { emptyTurn, offlinePreflight, type ArchitectureHarness, type Clock,
  type PreflightResult, type RunContext } from '../shared/contracts.js';
import { backendModule } from '../shared/credentials.js';
import { newReport } from '../shared/compiler.js';
import { bounded, DecodedObserver, wait } from '../shared/timing.js';
import { createParticipant, type Participant } from '../shared/webrtc-participant.js';
import { startAurvin, verifyBuild, type AurvinSession } from './preflight.js';
type Control = Record<string, unknown> & { type: string };
export class AurvinTurnState {
  readonly observer: DecodedObserver;
  readonly turn: ReturnType<typeof emptyTurn>;
  response: { turnId: string; responseId: string } | null = null;
  ended = false; paused = false; fault: string | null = null;
  firstAudioAt: number | null = null; endAt: number | null = null;
  constructor(index: number, private speechEnd: number, private clock: Clock) {
    this.turn = emptyTurn('aurvin', index); this.observer = new DecodedObserver(clock);
  }
  inputStarted(clockMs: number, speechEndMs: number) { this.speechEnd = clockMs + speechEndMs; }
  event(event: Control) {
    if (event.type === 'audio.start' && !this.response) {
      this.response = { turnId: String(event.turnId), responseId: String(event.responseId) };
      this.observer.begin(this.response.responseId, this.speechEnd);
    }
    if (event.type === 'voice.state' && event.agent === 'thinking' &&
      this.turn.speechEndToThinkingMs === null && this.clock.now() >= this.speechEnd)
      this.turn.speechEndToThinkingMs = this.clock.now() - this.speechEnd;
    if (event.type === 'audio.end' && this.response?.turnId === event.turnId &&
      this.response.responseId === event.responseId) { this.ended = true; this.endAt = this.clock.now(); }
    if (event.type === 'session.error') {
      if (event.code === 'VOICE_DELIVERY_UNKNOWN' && event.recoverable === true && event.terminal === false) {
        this.paused = true;
      } else this.fault = /^[A-Z0-9_]{1,100}$/.test(String(event.code)) ? String(event.code) : 'BASELINE_SESSION_ERROR';
    }
    if (event.type === 'session.ended') this.fault = 'BASELINE_SESSION_ENDED';
  }
  frame(data: Int16Array, rate: number, channels: number) {
    if (!this.response) return; // Decoded bytes preceding audio.start cannot be attributed.
    if (this.firstAudioAt === null && data.some(value => value !== 0)) this.firstAudioAt = this.clock.now();
    this.observer.frame(data, rate, channels);
  }
  controlsForRecovery(): Control[] { return this.paused ? [{ type: 'input.unmute' }] : []; }
  result() {
    Object.assign(this.turn, this.observer.snapshot());
    this.turn.durableCompletionStatus = 'unknown';
    this.turn.outcome = this.fault ? 'failed' : this.turn.earlyEndpoint ? 'early-endpoint' : 'unverified-playback';
    this.turn.failureCode = this.fault ?? 'BENCHMARK_UNPROVEN_PLAYBACK';
    return this.turn;
  }
}
async function until(context: RunContext, predicate: () => boolean, timeoutMs: number) {
  const started = context.clock.now();
  while (!predicate()) {
    context.signal.throwIfAborted();
    if (context.clock.now() - started >= timeoutMs) throw Error('BENCHMARK_TIMEOUT');
    await wait(10, context.signal);
  }
}
export const harness: ArchitectureHarness = {
  id: 'aurvin',
  async preflight(context) {
    if (context.mode !== 'live') return offlinePreflight('aurvin');
    const p = offlinePreflight('aurvin', []);
    try {
      const source = context.credentials;
      if (!source?.openrouter || !source.deepgram || !source.bootstrap.livekit) throw Error('CREDENTIALS_REQUIRED');
      if (!source.settings.voice.enabledModes.live) throw Error('SOURCE_LIVE_MODE_DISABLED');
      if (source.settings.deepgram.liveModel !== 'flux-general-en' ||
        !/^flux-(cole|haley|alexis|priya)-en$/.test(source.settings.deepgram.ttsModel))
        throw Error('SOURCE_SPEECH_FAMILY_UNSUPPORTED');
      const build = await verifyBuild(context.repoRoot);
      p.status = 'ready'; p.provenance = build;
      p.capabilities = { userAttribution: true, zeroDataRetention: true, maxOutputTokensEnforced: true,
        zeroRetriesEnforced: true, speculationDisabled: true, fluxSttSupported: true, fluxTtsSupported: true };
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'BASELINE_PREFLIGHT_FAILED';
      p.reasons = [code];
    }
    return p;
  },
  async run(context, preflight) {
    if (preflight.status !== 'ready' || context.mode !== 'live' || !context.guard || !context.credentials)
      throw Error('BASELINE_LIVE_ADMISSION_REQUIRED');
    const guard = context.guard, report = newReport('aurvin', context.runId, 'live', preflight);
    const expectedDatabase = `aurvin_voice_arch_${context.runId.replaceAll('-', '')}`;
    report.provenance.isolatedDatabase = expectedDatabase;
    const release = guard.openCandidate('aurvin');
    let runtime: Awaited<ReturnType<typeof startAurvin>> | undefined;
    let participant: Participant | undefined; let session: AurvinSession | undefined;
    let state: AurvinTurnState | undefined; let pendingInterrupt: AurvinTurnState | undefined;
    let sequence = 0, serverSequence = -1, ready = false, resumeReady = false, recoveries = 0;
    let connectionFault: string | null = null, recoveryMs: number | null = null;
    const ticker = setInterval(() => pendingInterrupt?.observer.tick(), 10);
    const send = async (payload: Control) => {
      if (!participant || !session || payload.type === 'playback.progress') throw Error('UNPROVEN_CONTROL_DENIED');
      await participant.sendControl({ protocolVersion: 1, sessionId: session.sessionId,
        connectionEpoch: session.connectionEpoch, eventId: randomUUID(), sequence: sequence++, ...payload });
    };
    try {
      runtime = await startAurvin(context);
      report.provenance = { ...preflight.provenance, modelId: context.credentials.settings.openRouter.modelId,
        sttModel: context.credentials.settings.deepgram.liveModel, ttsModel: context.credentials.settings.deepgram.ttsModel,
        region: context.credentials.settings.deepgram.region, configHash: context.credentials.configHash,
        maxContextTokens: 45000, maxOutputTokens: 1024, maxRetries: 0, preemptiveGeneration: false,
        sourceRevision: context.credentials.sourceRevision, benchmarkOverrides: context.credentials.overrides.join('; '),
        routingOverride: 'provider.allow_fallbacks=false', heardHistory: 'application unknown-delivery reconciliation',
        isolatedDatabase: runtime.bootstrap.persistence.mongoDbName };
      const started = context.clock.now();
      session = (await runtime.service.voiceSessions.create({ protocolVersion: 1, mode: 'live',
        conversationId: null, locale: 'en-US', idempotencyKey: context.runId },
        runtime.bootstrap.frontendOrigin, runtime.principal)).response;
      type WireApi = {
        INPUT_AUDIO: Record<string, unknown>; livekitAgentIdentity(sessionId: string): string;
        VoiceControlReassembler: new (direction: 'server', mode: 'live', binding: {
          sessionId: string; connectionEpoch: number }) => { push(bytes: Uint8Array):
            { status: string; event?: Control & { sessionId: string; connectionEpoch: number; sequence: number } } };
      };
      const wire = await backendModule<WireApi>(context.repoRoot, 'contracts/voice-wire.js');
      const reassembler = new wire.VoiceControlReassembler('server', 'live', session);
      participant = await createParticipant({ ...session.livekit, token: session.livekit.participantToken,
        agentIdentity: wire.livekitAgentIdentity(session.sessionId), clock: context.clock, signal: context.signal,
        onPcm: (data, rate, channels) => {
          state?.frame(data, rate, channels); pendingInterrupt?.frame(data, rate, channels);
        },
        onFault: code => { connectionFault = code; },
        onControl: bytes => {
          try {
            const parsed = reassembler.push(bytes); if (parsed.status !== 'complete' || !parsed.event) return;
            const event = parsed.event;
            if (event.sessionId !== session!.sessionId || event.connectionEpoch !== session!.connectionEpoch)
              throw Error('CONTROL_BINDING_INVALID');
            if (event.sequence <= serverSequence) return;
            serverSequence = event.sequence;
            if (event.type === 'session.ready') ready = true;
            if (event.type === 'voice.state' && event.input === 'listening' &&
              event.agent === 'idle' && event.connection === 'connected') resumeReady = true;
            if (event.type === 'audio.start' && pendingInterrupt &&
              pendingInterrupt.observer.snapshot().staleTailObservedMs !== 1000) {
              pendingInterrupt.turn.interruptionAttribution = 'unknown';
            }
            state?.event(event);
          } catch { connectionFault = 'CONTROL_INVALID'; }
        }
      });
      await send({ type: 'session.start', mode: 'live', audioSettings: wire.INPUT_AUDIO });
      await until(context, () => ready || connectionFault !== null, 10000);
      if (connectionFault) throw Error(connectionFault);
      const setupMs = context.clock.now() - started;
      for (const input of context.corpus) {
        if (state?.paused) {
          resumeReady = false;
          const recoveringAt = context.clock.now();
          guard.allowSpeechRecovery('VOICE_DELIVERY_UNKNOWN');
          for (const control of state.controlsForRecovery()) await send(control);
          recoveries++;
          await until(context, () => resumeReady || connectionFault !== null, 10000);
          if (connectionFault) throw Error(connectionFault);
          recoveryMs = context.clock.now() - recoveringAt;
        }
        if (input.index === 5 && !pendingInterrupt) break;
        const inputStart = context.clock.now();
        state = new AurvinTurnState(input.index, inputStart + input.speechEndMs, context.clock);
        const turn = state.turn;
        turn.submitted = true; turn.setupMs = input.index === 0 ? setupMs : null;
        if (recoveryMs !== null) turn.connectStageMs.recoveryMs = recoveryMs;
        turn.sessionPhase = input.index === 0 ? 'cold-setup' : recoveries ? 'recovered-session' : 'warm-session';
        guard.submitTurn('aurvin', input.index);
        report.turns.push(turn);
        const pacing = await participant.play(input.pcm, at => {
          state!.inputStarted(at, input.speechEndMs);
          if (input.index === 5 && pendingInterrupt) {
            pendingInterrupt.observer.interrupt();
            pendingInterrupt.result();
            if (!pendingInterrupt.turn.interruptionAnchorObserved) throw Error('INTERRUPT_ANCHOR_UNOBSERVED');
          }
        });
        turn.inputPacingMaxLatenessMs = pacing.latenessMs; turn.maxInputQueuedMs = pacing.maxQueuedMs;
        if (input.index === 4) {
          await until(context, () => state!.firstAudioAt !== null || state!.fault !== null || state!.paused, 30000);
          if (state.fault || state.paused) throw Error(state.fault ?? 'INTERRUPT_ANCHOR_UNOBSERVED');
          await wait(Math.max(0, state.firstAudioAt! + 600 - context.clock.now()), context.signal);
          if (state.ended) { state.result(); turn.failureCode = 'INTERRUPT_ANCHOR_UNOBSERVED'; break; }
          state.result();
          turn.interruptionAttribution = 'boundary-window-only';
          pendingInterrupt = state; state = undefined;
          continue; // Next input starts while target is speaking; no fabricated interrupt control.
        }
        await until(context, () => state!.paused || state!.fault !== null ||
          state!.ended && state!.endAt !== null && context.clock.now() - state!.endAt! >= 3000, 60000);
        state.result();
        if (connectionFault) throw Error(connectionFault);
        if (state.fault) throw Error(state.fault);
        if (pendingInterrupt) {
          pendingInterrupt.observer.tick();
          const attribution = pendingInterrupt.turn.interruptionAttribution;
          pendingInterrupt.result();
          if (attribution === 'unknown') {
            pendingInterrupt.turn.interruptionToCutoffMs = null;
            pendingInterrupt.turn.staleTailObservedMs = null;
            pendingInterrupt.turn.staleTailNonzeroFrames = null;
            pendingInterrupt.turn.staleTailBytes = null;
          }
          pendingInterrupt = undefined;
        }
      }
      report.provenance.recoveries = recoveries;
      report.limitations.push('VOICE_DELIVERY_UNKNOWN pauses are recovered explicitly; recovered turns are not warm-session equivalence.',
        'No proven playback.progress is sent. Model/TTS internal timings remain null when not genuinely observable.');
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'BASELINE_RUN_FAILED';
      if (state) { state.result(); state.turn.outcome = code === 'BENCHMARK_TIMEOUT' ? 'timeout' : 'failed';
        state.turn.failureCode = code; }
      report.limitations.push(code);
    } finally {
      clearInterval(ticker);
      const cleanup = report.cleanup;
      if (participant) cleanup.complete = await participant.close();
      if (runtime && session) {
        try { await bounded(runtime.service.voiceSessions.endOwned(session.sessionId, runtime.principal), 10000); }
        catch { cleanup.complete = false; }
      }
      if (runtime) {
        try { await bounded(runtime.service.operations.shutdown(), 10000); }
        catch { cleanup.complete = false; }
        for (const room of runtime.rooms) {
          let outcome: 'closed' | 'unknown' = 'unknown';
          try {
            if ((await bounded(runtime.roomClient.listRooms([room]), 3000)).length)
              await bounded(runtime.roomClient.deleteRoom(room), 3000);
            if (!(await bounded(runtime.roomClient.listRooms([room]), 3000)).length) outcome = 'closed';
          } catch { cleanup.complete = false; }
          cleanup.resources.push({ kind: 'room', id: room, owned: true, outcome });
          if (outcome !== 'closed') cleanup.complete = false;
        }
        cleanup.resources.push({ kind: 'database', id: runtime.bootstrap.persistence.mongoDbName,
          owned: true, outcome: 'retained' });
      }
      if (!runtime) {
        cleanup.resources.push({ kind: 'database', id: expectedDatabase, owned: false, outcome: 'unknown' });
        cleanup.complete = false;
      }
      release(); report.envelope = guard.snapshot();
      cleanup.openSockets = guard.openSocketCount;
      if (cleanup.openSockets !== 0) cleanup.complete = false;
      if (!cleanup.complete) guard.stop(); // No next live candidate after uncertain cleanup.
    }
    return report;
  }
};
```

Recovery waits for the actual observed listening/idle/connected control, not an arbitrary delay or a second `session.ready`. It records recovery duration separately and issues no extra model request.

The first-frame hook takes the interruption marker immediately before Turn 5 capture. The observer ticker remains active through quiet decoded intervals; provider cancellation and `audio.end` do not terminate the fixed 1000 ms window. If Turn 5 output overlaps that window, retain unknown attribution instead of inventing a successful cutoff.

- [ ] **Step 4: Run GREEN:** `npm test -- aurvin/__tests__/harness.test.ts` (4 tests). Native participant early-close/timeout/cleanup-false cases live in Task 11 `lifecycle.test.ts`. Assembly/port routing lives in Task 11 `assembly.test.ts`. Never start a Mongo instance/provider in these tests.
- [ ] **Step 5: Request commit:** `feat(voice-bench): drive real Aurvin sessions with honest unknown delivery`.

## Task 10: Add the offline-default sequential CLI and fresh authorization claim

**Files:** Create `shared/cli.ts`, `shared/__tests__/cli.test.ts`; finish `README.md`.

- [ ] **Step 1: Write the failing parser, replay, and independent-selection tests.**

```ts
/**
 * ============================================================================
 * FILE: cli.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/cli.test.ts
 * PURPOSE: Prove no implicit live mode and no reusable authorization token.
 * ROLE IN PROJECT: Offline CLI admission tests without candidate SDK imports.
 * KEY COMPONENTS: Strict options; exact fresh envelope; sequential selection.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import { parseOptions, validateAuthorization, selectedCandidates } from '../cli.js';
it('defaults to dry-run and rejects unknown or incomplete live flags', () => {
  expect(parseOptions([])).toMatchObject({ live: false, candidate: 'all', publish: false });
  expect(() => parseOptions(['--live'])).toThrow('AUTHORIZATION_REQUIRED');
  expect(() => parseOptions(['--retry=1'])).toThrow('CLI_ARGUMENT_INVALID');
  expect(selectedCandidates('aurvin')).toEqual(['aurvin']);
  expect(selectedCandidates('all')).toHaveLength(3);
});
it('requires a fresh source/config/corpus/lock-bound authorization at exact expiry', () => {
  const now = Date.now();
  const pins = { sourceHash: 'a'.repeat(64), configHash: 'b'.repeat(64),
    corpusHash: 'c'.repeat(64), lockHash: 'd'.repeat(64) };
  const authorization = { version: 1, nonce: '00000000-0000-4000-8000-000000000001',
    approvalReference: 'user-request-2026-11-16-low-cost-pilot',
    issuedAtMs: now, expiresAtMs: now + 900000, maxUsd: 2, maxTurns: 18, maxActiveMs: 900000, ...pins };
  expect(validateAuthorization(authorization, pins, now)).toMatchObject({ maxUsd: 2 });
  expect(() => validateAuthorization(authorization, pins, now + 900000)).toThrow('AUTHORIZATION_INVALID');
  expect(() => validateAuthorization(authorization, { ...pins, configHash: 'e'.repeat(64) }, now))
    .toThrow('AUTHORIZATION_INVALID');
});
```

- [ ] **Step 2: Run RED:** `npm test -- shared/__tests__/cli.test.ts`.
- [ ] **Step 3: Create the CLI.**

```ts
/**
 * ============================================================================
 * FILE: cli.ts
 * LOCATION: benchmarks/voice-architectures/shared/cli.ts
 * PURPOSE: Select real adapters and run one finite sequential comparison.
 * ROLE IN PROJECT: Dry-run by default; all paid work requires a claimed envelope.
 * KEY COMPONENTS: Strict options; immutable run directory; pins; sequential runner.
 * ============================================================================
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { candidateIds, emptyTurn, envelopeSchema, offlinePreflight, reportSchema,
  type ArchitectureHarness, type ArchitectureReport, type CandidateId, type RunContext } from './contracts.js';
import { loadCredentials, parseEnvironment, SecretRedactor } from './credentials.js';
import { loadCorpus } from './corpus.js';
import { BudgetGuard, catalogue } from './budget-guard.js';
import { hash, newReport, compileReports, publishReports, writeArchitectureReport } from './compiler.js';
import { monotonicClock } from './timing.js';
type Options = { live: boolean; candidate: CandidateId | 'all'; envFile?: string;
  authorization?: string; readStoredConfig: boolean; compileOnly: boolean; runId?: string; publish: boolean };
export function parseOptions(args: string[]): Options {
  const out: Options = { live: false, candidate: 'all', readStoredConfig: false, compileOnly: false, publish: false };
  const names = new Set<string>();
  for (const arg of args) {
    const index = arg.indexOf('='), name = index < 0 ? arg : arg.slice(0, index);
    const value = index < 0 ? undefined : arg.slice(index + 1);
    if (names.has(name)) throw Error('CLI_ARGUMENT_INVALID'); names.add(name);
    if (name === '--live' && value === undefined) out.live = true;
    else if (name === '--read-stored-config' && value === undefined) out.readStoredConfig = true;
    else if (name === '--compile-only' && value === undefined) out.compileOnly = true;
    else if (name === '--publish-reports' && value === undefined) out.publish = true;
    else if (name === '--candidate' && ['all', ...candidateIds].includes(value ?? '')) out.candidate = value as Options['candidate'];
    else if (name === '--env-file' && value) out.envFile = resolve(value);
    else if (name === '--authorization' && value) out.authorization = resolve(value);
    else if (name === '--run-id' && value && z.string().uuid().safeParse(value).success) out.runId = value;
    else throw Error('CLI_ARGUMENT_INVALID');
  }
  if (out.live && (!out.authorization || out.compileOnly)) throw Error('AUTHORIZATION_REQUIRED');
  if (out.compileOnly && !out.runId) throw Error('RUN_ID_REQUIRED');
  if (!out.live && (out.authorization || out.readStoredConfig)) throw Error('LIVE_FLAG_REQUIRED');
  return out;
}
export const selectedCandidates = (candidate: Options['candidate']): readonly CandidateId[] =>
  candidate === 'all' ? candidateIds : [candidate];
const authorizationSchema = z.object({ version: z.literal(1), nonce: z.string().uuid(),
  approvalReference: z.literal('user-request-2026-11-16-low-cost-pilot'),
  issuedAtMs: z.number().int().nonnegative(), expiresAtMs: z.number().int().positive(),
  maxUsd: z.literal(2), maxTurns: z.literal(18), maxActiveMs: z.literal(900000),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), configHash: z.string().regex(/^[a-f0-9]{64}$/),
  corpusHash: z.string().regex(/^[a-f0-9]{64}$/), lockHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
type Pins = Pick<z.infer<typeof authorizationSchema>, 'sourceHash' | 'configHash' | 'corpusHash' | 'lockHash'>;
export function validateAuthorization(raw: unknown, pins: Pins, now = Date.now()) {
  const parsed = authorizationSchema.safeParse(raw);
  if (!parsed.success) throw Error('AUTHORIZATION_INVALID');
  const auth = parsed.data;
  if (auth.issuedAtMs > now || now - auth.issuedAtMs > 300000 || now >= auth.expiresAtMs ||
    auth.expiresAtMs - auth.issuedAtMs > 900000 ||
    (Object.keys(pins) as Array<keyof Pins>).some(key => auth[key] !== pins[key]))
    throw Error('AUTHORIZATION_INVALID');
  return auth;
}
async function sourceHash(repoRoot: string, packageRoot: string): Promise<string> {
  const entries: string[] = [];
  async function add(directory: string) {
    let list;
    try { list = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('SOURCE_IDENTITY_UNVERIFIABLE');
      if (entry.isDirectory()) await add(name);
      else if (/\.(ts|js|ps1|json)$/.test(entry.name)) entries.push(`${name}\0${await readFile(name, 'utf8')}`);
    }
  }
  await add(resolve(repoRoot, 'backend/src'));
  await add(resolve(repoRoot, 'backend/dist'));
  for (const folder of ['shared', 'aurvin', 'livekit-agents', 'deepgram-agent']) {
    // Only source files; generated per-architecture reports do not change approval.
    await add(resolve(packageRoot, folder));
  }
  for (const name of ['backend/package.json', 'backend/package-lock.json', 'backend/tsconfig.json',
    'backend/nest-cli.json', 'backend/src/instructions/system.md', 'product_knowledge.md']) {
    entries.push(`${name}\0${await readFile(resolve(repoRoot, name), 'utf8')}`);
  }
  entries.push(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  entries.push(await readFile(resolve(packageRoot, 'tsconfig.json'), 'utf8'));
  return hash(entries.join('\0'));
}
async function loadCandidate(packageRoot: string, id: CandidateId): Promise<ArchitectureHarness | null> {
  const path = resolve(packageRoot, 'dist', id, 'harness.js');
  try { await access(path); } catch { return null; }
  const module = await import(pathToFileURL(path).href) as { harness?: ArchitectureHarness };
  if (module.harness?.id !== id || typeof module.harness.preflight !== 'function' ||
    typeof module.harness.run !== 'function') throw Error('CANDIDATE_CONTRACT_INVALID');
  return module.harness;
}
async function compileExisting(options: Options, packageRoot: string, redactor: SecretRedactor) {
  const directory = resolve(packageRoot, 'results', options.runId!);
  const reports = await Promise.all(candidateIds.map(async id => reportSchema.parse(
    JSON.parse(await readFile(resolve(directory, id, 'result.json'), 'utf8')))));
  const envelope = envelopeSchema.parse(JSON.parse(await readFile(resolve(directory, 'envelope.json'), 'utf8')));
  const main = compileReports(reports, envelope); redactor.encode(main);
  if (options.publish) await publishReports(packageRoot, reports, envelope, redactor);
  return reports;
}
export async function runCli(args: string[], rootOverride?: string,
  loader: typeof loadCandidate = loadCandidate): Promise<ArchitectureReport[]> {
  const options = parseOptions(args);
  const packageRoot = rootOverride ?? resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const repoRoot = resolve(packageRoot, '../..');
  const envPath = options.envFile ?? resolve(repoRoot, 'backend/.env');
  let envText = '';
  try { envText = await readFile(envPath, 'utf8'); } catch (error) {
    if (options.envFile || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('ENV_READ_UNAVAILABLE');
  }
  const env = parseEnvironment(envText, process.env);
  let redactor = new SecretRedactor(Object.entries(env)
    .filter(([key]) => /KEY|SECRET|PASSWORD|TOKEN|MONGODB_URI/.test(key)).map(([, value]) => value));
  if (options.compileOnly) return compileExisting(options, packageRoot, redactor);
  const runId = randomUUID(), outputDir = resolve(packageRoot, 'results', runId);
  await mkdir(resolve(packageRoot, 'results'), { recursive: true });
  await mkdir(outputDir); // Not recursive: an existing run is never overwritten.
  const aborter = new AbortController(), watchers: Array<ReturnType<typeof watch>> = [];
  let credentials: RunContext['credentials'] = null, guard: BudgetGuard | null = null;
  let corpus: RunContext['corpus'] = [];
  let pins: Pins | null = null;
  let setupFailure: string | null = null;
  const startedAtIso = new Date().toISOString();
  const shutdown = () => { aborter.abort(); guard?.stop(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  try {
    if (options.live) {
      try {
      credentials = await loadCredentials({ repoRoot, envFile: options.envFile,
        readStoredConfig: options.readStoredConfig, configHash: value => hash(JSON.stringify(value)) });
      redactor = credentials.redactor; corpus = await loadCorpus(resolve(packageRoot, 'audio'));
      pins = { sourceHash: await sourceHash(repoRoot, packageRoot), configHash: credentials.configHash,
        corpusHash: hash(JSON.stringify(corpus.map(t => ({ index: t.index, sha256: t.sha256, speechEndMs: t.speechEndMs })))),
        lockHash: hash(await readFile(resolve(packageRoot, 'package-lock.json'))) };
      const auth = validateAuthorization(JSON.parse(await readFile(options.authorization!, 'utf8')), pins);
      await mkdir(resolve(packageRoot, 'results/authorizations'), { recursive: true });
      try {
        await writeFile(resolve(packageRoot, 'results/authorizations', `${auth.nonce}.claim`),
          redactor.encode({ nonce: auth.nonce, runId, approvalReference: auth.approvalReference, ...pins }),
          { flag: 'wx', mode: 0o600 });
      } catch { throw Error('AUTHORIZATION_ALREADY_CLAIMED'); }
      // The nonce is consumed even if a subsequent preflight fails; a retry needs a new decision.
      const onSourceChange = (_event: string, filename: string | Buffer | null) => {
        const name = String(filename ?? '');
        if (!name || /\.(ts|js|ps1|json|md|env)$/.test(name) && !/^(results|audio|node_modules)[\\/]/.test(name))
          shutdown();
      };
      for (const directory of [resolve(repoRoot, 'backend/src'), resolve(repoRoot, 'backend/dist'),
        resolve(packageRoot, 'shared'), resolve(packageRoot, 'aurvin')]) {
        watchers.push(watch(directory, { recursive: true }, onSourceChange));
      }
      for (const name of ['livekit-agents', 'deepgram-agent']) {
        const directory = resolve(packageRoot, name);
        try { await access(directory); } catch { continue; }
        watchers.push(watch(directory, { recursive: true }, onSourceChange));
      }
      for (const path of [envPath, resolve(repoRoot, 'product_knowledge.md'),
        resolve(packageRoot, 'package.json'), resolve(packageRoot, 'package-lock.json')]) {
        try { watchers.push(watch(path, shutdown)); }
        catch { throw Error('SOURCE_WATCH_UNAVAILABLE'); }
      }
      if (await sourceHash(repoRoot, packageRoot) !== pins.sourceHash) throw Error('SOURCE_CHANGED');
      // Non-inference catalogue GET is after explicit live auth; no paid health probe.
      const info = await catalogue(fetch, credentials.settings.openRouter.modelId, aborter.signal);
      guard = new BudgetGuard({ modelId: credentials.settings.openRouter.modelId,
        userId: credentials.bootstrap.identity.userId, maxContextTokens: 45000,
        maxOutputTokens: 1024, modelMarginTokens: credentials.settings.chat.modelMarginTokens,
        region: credentials.settings.deepgram.region, sttModel: credentials.settings.deepgram.liveModel,
        ttsModel: credentials.settings.deepgram.ttsModel, outputParameter: info.outputParameter,
        expiresAtMs: auth.expiresAtMs }, info.rates);
      } catch (error) {
        setupFailure = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)
          ? error.message : 'RUN_PREFLIGHT_FAILED';
        shutdown();
      }
    }
    const reports: ArchitectureReport[] = [];
    for (const id of selectedCandidates(options.candidate)) {
      if (pins && !setupFailure) {
        try { if (await sourceHash(repoRoot, packageRoot) !== pins.sourceHash) shutdown(); }
        catch { setupFailure = 'SOURCE_CHANGED'; shutdown(); }
      }
      const context: RunContext = { mode: options.live ? 'live' : 'dry-run', runId, repoRoot, packageRoot,
        outputDir, startedAtIso, clock: monotonicClock, signal: guard
          ? AbortSignal.any([aborter.signal, guard.signal]) : aborter.signal,
        credentials, guard, corpus, redactor };
      let report: ArchitectureReport;
      try {
        const candidate = await loader(packageRoot, id);
        const preflight = setupFailure ? offlinePreflight(id, [setupFailure])
          : context.signal.aborted ? offlinePreflight(id, ['PRIOR_RUN_STOPPED'])
          : candidate ? await candidate.preflight(context) : offlinePreflight(id, ['CANDIDATE_NOT_IMPLEMENTED']);
        report = preflight.status === 'ready' && context.mode === 'live' && candidate
          ? await candidate.run(context, preflight) : newReport(id, runId, context.mode, preflight);
      } catch {
        report = newReport(id, runId, context.mode, offlinePreflight(id, ['CANDIDATE_FAILED']));
        report.turns = (guard?.submittedIndices(id) ?? []).map(index => ({
          ...emptyTurn(id, index), submitted: true, outcome: 'failed', failureCode: 'CANDIDATE_FAILED' }));
        if (options.live) shutdown(); // Unexpected adapter rejection cannot authorize another paid session.
      }
      report.startedAtIso = startedAtIso;
      report.envelope = guard?.snapshot() ?? report.envelope;
      report.provenance = { ...report.provenance, node: process.version, platform: process.platform,
        architecture: process.arch, gitCommit: execFileSync('git', ['rev-parse', 'HEAD'],
          { cwd: repoRoot, encoding: 'utf8' }).trim(),
        gitDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()),
        ...(pins ?? {}) };
      await writeArchitectureReport(context, report); reports.push(report);
      if (!report.cleanup.complete) shutdown();
    }
    const envelope = guard?.snapshot() ?? reports[0].envelope;
    await writeFile(resolve(outputDir, 'envelope.json'), redactor.encode(envelope), { flag: 'wx', mode: 0o600 });
    const main = compileReports(reports, envelope); redactor.encode(main);
    await writeFile(resolve(outputDir, 'report.md'), main, { flag: 'wx', mode: 0o600 });
    if (options.publish) {
      if (reports.length !== 3) throw Error('ALL_REPORTS_REQUIRED_FOR_PUBLISH');
      await publishReports(packageRoot, reports, envelope, redactor);
    }
    return reports;
  } finally {
    watchers.forEach(watcher => watcher.close()); shutdown();
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then(reports => {
    console.log(JSON.stringify({ runId: reports[0]?.runId ?? null,
      candidates: reports.map(r => ({ candidate: r.candidate, preflight: r.preflight.status,
        submitted: r.turns.filter(t => t.submitted).length })) }));
  }).catch(() => { console.error('BENCHMARK_FAILED_CLOSED'); process.exitCode = 1; });
}
```

All existing candidate source folders and fixed assets are watched. A failed watcher or changed pin stops before paid work. Hashes are identifiers, not source copies; never persist imported env text or credential documents.

The catalogue lookup returns requested capability/pricing evidence, not a claim of observed model/voice equality. Add the catalogue response hash and the package-lock resolved versions to provenance as nonsecret scalar values. Capture dynamic observed response model/provider identifiers if available through adapter events; otherwise record them as null rather than copying the requested model ID into an “observed” field.

- [ ] **Step 4: Verify GREEN and add the no-network route check.**

Run `npm test -- shared/__tests__/cli.test.ts`. Use a temporary isolated checkout-shaped directory under `~/AppData/Local/Temp/opencode` for `runCli` tests, inject its loader, and stub global fetch to throw. Assert default `runCli([])` invokes each preflight with `mode='dry-run'`, `credentials=null`, `guard=null`, never invokes `run`, and never invokes fetch. The candidate-specific `runCli(['--candidate=aurvin'])` must invoke only the Aurvin loader. The loader is a test injection seam, not an alternate live architecture.

- [ ] **Step 5: Write `README.md` with these exact operational sections.**

```markdown
# Isolated voice architecture screening

This standalone package does not modify the Aurvin application. Default commands are offline.
The three candidates are actual Aurvin, actual LiveKit Agents, and actual managed Deepgram Voice Agent protocol.
The managed candidate currently blocks live BYO because required controls are unsupported.

## Setup (this directory only)

- Node 24.18.0 / Windows x64 is the researched host; install using `npm ci`.
- Run `npm run build`, `npm run lint`, and `npm test`.
- Run `npm run corpus:generate` once. It uses local System.Speech, never a paid voice API.
- A preexisting audio directory is not overwritten. Preserve its manifest and hashes for comparisons.
- Silero native readiness belongs to the P2 offline VAD check, not package installation success.
- Backend dependencies and a verified current `backend/dist/` must already exist for Aurvin.
  This tooling never rebuilds or writes under backend. Stale builds yield BASELINE_BUILD_STALE.

## Independent offline commands

- `npm run bench:aurvin`
- `npm run bench:livekit-agents`
- `npm run bench:deepgram-agent`
- `npm run bench` (sequential all-candidate dry-run)

Dry-run imports no credentials into a candidate, opens no DB, room, socket, or provider connection,
and reports capabilities unknown/unrun rather than inventing timings.
Missing implementation modules remain explicitly CANDIDATE_NOT_IMPLEMENTED until their worker lands.

## Credential import and isolation

Live mode reads `backend/.env` or `--env-file=absolute-path` into a private map, with process env taking precedence.
It never updates process.env, .env, source configuration, or source DB settings.
Optional `--read-stored-config` reads only config/aurvin and decrypts with the existing server routine,
then closes that source client before admission. It does not access chats, calendars, or application users.
Missing secrets must be supplied through the chat's private secret tool, never pasted into reports/commands.
Aurvin uses an aurvin_voice_arch_<uuid> database, a synthetic account, real assets, and a read-only in-memory config repo.
No public listener, proxy/tunnel, service deployment, or production migration is performed.

## Live authorization and finite envelope

Only the execution worker runs a freshly authorized pilot. Add --live and --authorization=absolute-path
to an independent or all-candidate command. The JSON authorization is nonsecret and binds nonce,
approvalReference, issuedAtMs, expiresAtMs, sourceHash, configHash, corpusHash, lockHash,
maxUsd=2, maxTurns=18, maxActiveMs=900000, version=1.
TTL is at most 15 minutes, issuance is at most five minutes old, and the nonce is consumed once.
An existing nonce claim or evidence directory is not deleted to authorize a rerun.

One candidate runs at a time, up to six submitted inputs each. Warmups, errors, cancellations, and
barge-in inputs all count. One model dispatch per input; no hidden retries, greeting, speculation,
fallback, tools, or allowance transfer from a blocked candidate.
The whole conservative reservation uses a fresh OpenRouter model catalogue and includes speech,
managed-agent buffer, media buffer and a 10% margin. Missing/unsupported pricing blocks live work.
Reservations are not a provider-enforced invoice cap; unknown invoice components remain unknown.

## Reports and cleanup

Immutable JSON and Markdown go to results/<runId>/<candidate>/ and results/<runId>/report.md.
All artifacts pass schema and secret checks before being written. Raw credentials and provider payloads are excluded.
Final verification uses --publish-reports for all three candidates to create the three folder report.md files
and this package's main report.md. Recompile retained results with
`npm run bench:compile -- --run-id=<run-uuid> --publish-reports`.
Never point the compiler at a different run or merge multiple pilots.

End owned sessions, stop sockets/participants, drain the executor, and delete only rooms claimed by this run.
Retain the uniquely named benchmark DB and evidence identifiers. No broad DB/room cleanup exists.
Uncertain shutdown blocks further paid work and remains visible in the report.

## Interpretation and future audible evaluation

Receipt of decoded non-silent 24 kHz PCM is not speaker audibility or proven heard-prefix delivery.
Aurvin BENCHMARK_UNPROVEN_PLAYBACK and VOICE_DELIVERY_UNKNOWN remain incomplete outcomes.
Aurvin pauses/recoveries are not pooled with uninterrupted warm-session results.
Model/TTS stage metrics and semantics remain null/unknown unless directly observed/verified.
Separate cold setup, onset, hesitation, interruption and completion/proof groups.
A 100 ms decoded quiet cutoff plus 1000 ms stale-tail window is a headless observation, not a DAC measurement.
Uncorrelated new response audio during that window leaves interruption attribution unknown.
The sample is too small for a stable p95/SLA, p99, capacity, or migration decision.
Future browser evaluation needs separate authorization and AudioWorklet/acoustic loopback timing,
heard-prefix/completion proof, and a larger matched corpus; this pilot does not perform it.
Unified review was skipped, not passed.
```

- [ ] **Step 6: Request commit:** `feat(voice-bench): add offline-default sequential CLI and fresh pilot authorization`.

## Task 11: Close the integration-test matrix and verify the package handoff

**Files:** Create `shared/__tests__/acceptance.test.ts`, `shared/__tests__/lifecycle.test.ts`, `aurvin/__tests__/assembly.test.ts`. Extend the earlier tests with the explicit cases below. These are fixtures, not permission to connect services.

- [ ] **Step 1: Write the failing offline route, corpus-loader, and policy cases.**

`shared/__tests__/acceptance.test.ts`:

```ts
/**
 * ============================================================================
 * FILE: acceptance.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/acceptance.test.ts
 * PURPOSE: Exercise the offline public CLI and negative policy boundaries.
 * ROLE IN PROJECT: P1 integration gate before downstream workers are unblocked.
 * KEY COMPONENTS: No-network routing; BOM corpus; exact expiry; pricing refusal.
 * ============================================================================
 */
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ execFileSync: () => 'fixture-commit' }));
import { runCli } from '../cli.js';
import { offlinePreflight, type ArchitectureHarness } from '../contracts.js';
import { loadCorpus, utterances } from '../corpus.js';
import { BudgetGuard, catalogue, readRates } from '../budget-guard.js';
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const policy = { modelId: 'vendor/example', userId: 'synthetic-user', maxContextTokens: 45000,
  maxOutputTokens: 1024, modelMarginTokens: 1024, region: 'us' as const,
  sttModel: 'flux-general-en', ttsModel: 'flux-haley-en', outputParameter: 'max_tokens' as const,
  expiresAtMs: Date.now() + 900000 };
const rates = { prompt: .0000005, completion: .0000025, request: 0 };
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'voice-p1-'));
  roots.push(directory); return directory;
}
it('runs only dry preflights by default and selects independent entry points', async () => {
  const directory = await root(), packageRoot = resolve(directory, 'benchmarks/voice-architectures');
  await mkdir(packageRoot, { recursive: true });
  const fetcher = vi.fn(() => { throw Error('NETWORK_FORBIDDEN'); }); vi.stubGlobal('fetch', fetcher);
  const loaded: string[] = [], run = vi.fn();
  const loader = async (_root: string, id: ArchitectureHarness['id']): Promise<ArchitectureHarness> => {
    loaded.push(id);
    return { id, preflight: async context => {
      expect(context.mode).toBe('dry-run'); expect(context.guard).toBeNull();
      expect(context.credentials).toBeNull(); return offlinePreflight(id);
    }, run };
  };
  await runCli([], packageRoot, loader);
  expect(loaded).toEqual(['aurvin', 'livekit-agents', 'deepgram-agent']);
  loaded.length = 0;
  await runCli(['--candidate=aurvin'], packageRoot, loader);
  expect(loaded).toEqual(['aurvin']);
  expect(run).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
it('loads a Windows BOM manifest without altering exact PCM hashes', async () => {
  const directory = await root();
  const ordinary = Buffer.alloc(66560); ordinary.writeInt16LE(50, 2);
  const hesitation = Buffer.alloc(92160);
  hesitation.writeInt16LE(50, 0); hesitation.writeInt16LE(50, 25602);
  const noGap = Buffer.alloc(92160); noGap.writeInt16LE(50, 25602);
  const turn = (index: number, pcm: Buffer) => ({ index, file: `${index}.pcm`,
    sha256: createHash('sha256').update(pcm).digest('hex'),
    speechEndMs: index === 3 ? 12802 / 16 : .125,
    text: utterances[index].join(index === 3 ? ' [800 ms pause] ' : ''),
    hesitationMs: index === 3 ? 800 : 0 });
  for (let index = 0; index < 6; index++) {
    await writeFile(resolve(directory, `${index}.pcm`), index === 3 ? noGap : ordinary);
  }
  const header = { sampleRate: 16000, channels: 1, encoding: 'pcm16le', generatorVoice: 'fixture' };
  await writeFile(resolve(directory, 'manifest.json'), '\uFEFF' + JSON.stringify({ ...header,
    turns: [0, 1, 2, 3, 4, 5].map(index => turn(index, index === 3 ? noGap : ordinary)) }));
  await expect(loadCorpus(directory)).rejects.toThrow('CORPUS_HESITATION_INVALID');
  await writeFile(resolve(directory, '3.pcm'), hesitation);
  await writeFile(resolve(directory, 'manifest.json'), '\uFEFF' + JSON.stringify({ ...header,
    turns: [0, 1, 2, 3, 4, 5].map(index => turn(index, index === 3 ? hesitation : ordinary)) }));
  const corpus = await loadCorpus(directory);
  expect(corpus).toHaveLength(6); expect(corpus[3].speechEndMs).toBe(800.125);
});
it.each([
  { pricing: { prompt: '0', completion: '0', pricing_overrides: [{ strange: 1 }] } },
  { pricing: { prompt: '0', completion: '0', audio: '0.1' } },
  { pricing: { prompt: '0', completion: '0', internal_reasoning: '1' } }
])('blocks unknown pricing units or tiers', entry => {
  expect(() => readRates(entry)).toThrow('MODEL_PRICING_UNPROVEN');
});
it('blocks exact authorization expiry before a paid operation', () => {
  vi.useFakeTimers(); vi.setSystemTime(1000000);
  const guard = new BudgetGuard({ ...policy, expiresAtMs: 1000100 }, rates);
  guard.openCandidate('aurvin'); vi.setSystemTime(1000100);
  expect(() => guard.submitTurn('aurvin', 0)).toThrow('AUTHORIZATION_EXPIRED'); guard.stop();
});
it('counts UTF-8 bytes and refuses a hidden second speech socket', () => {
  const guard = new BudgetGuard(policy, rates); guard.openCandidate('aurvin');
  guard.speechSend('tts', 'é'.repeat(2000));
  expect(guard.snapshot().ttsInputBytes).toBe(4000);
  expect(() => guard.speechSend('tts', 'a')).toThrow('SPEECH_LIMIT');
  const second = new BudgetGuard(policy, rates); second.openCandidate('aurvin'); second.speechOpen('stt');
  expect(() => second.speechOpen('stt')).toThrow('SPEECH_RETRY_DENIED');
  guard.stop(); second.stop();
});
it.each([
  'wss://api.eu.deepgram.com/v2/listen?model=flux-general-en',
  'wss://api.deepgram.com/v2/listen?model=another-model',
  'wss://api.deepgram.com/v2/listen?model=flux-general-en&sample_rate=8000',
  'wss://api.deepgram.com/v2/speak?model=flux-haley-en&encoding=mp3'
])('blocks socket region/model/format mismatch before factory: %s', url => {
  const guard = new BudgetGuard(policy, rates); guard.openCandidate('aurvin');
  const factory = vi.fn();
  expect(() => guard.sockets(factory)(new URL(url), {})).toThrow('EGRESS_POLICY_DENIED');
  expect(factory).not.toHaveBeenCalled(); guard.stop();
});
it('terminates an opened speech socket at the active-lifetime deadline', async () => {
  vi.useFakeTimers();
  const guard = new BudgetGuard({ ...policy, expiresAtMs: Date.now() + 900000 }, rates);
  guard.openCandidate('aurvin');
  const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0,
    send: vi.fn(), close: vi.fn(), terminate: vi.fn(), ping: vi.fn() });
  guard.sockets(() => socket)(new URL('wss://api.deepgram.com/v2/listen?model=flux-general-en'), {});
  await vi.advanceTimersByTimeAsync(300000);
  expect(socket.terminate).toHaveBeenCalled(); expect(guard.signal.aborted).toBe(true); guard.stop();
});
it.each([{}, { context_length: 45000, top_provider: {} },
  { context_length: 45000, top_provider: { max_completion_tokens: null } }])(
  'requires real context and output evidence from catalogue', async missing => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{
      id: policy.modelId, supported_parameters: ['max_tokens'],
      pricing: { prompt: '0', completion: '0' }, ...missing }] })));
    await expect(catalogue(fetcher, policy.modelId, new AbortController().signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
```

The BOM fixture writes ordinary PCM as Turn 3 first so `loadCorpus` fails closed, then restores the real 12,800-sample gap. Manifest labels alone must not validate an 800 ms pause.

- [ ] **Step 2: Run RED** with `npm test -- shared/__tests__/acceptance.test.ts`. Expect unresolved CLI/guard imports first; after implementation, the BOM corpus case passes only with the real internal silence.

- [ ] **Step 3: Write the lifecycle fixture.**

`shared/__tests__/lifecycle.test.ts`:

```ts
/**
 * ============================================================================
 * FILE: lifecycle.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/lifecycle.test.ts
 * PURPOSE: Exercise late/failed native transport lifecycle deterministically.
 * ROLE IN PROJECT: Proves decoded consumption outlives provider terminal controls.
 * KEY COMPONENTS: Fake RTC streams; abort; late join; failure-aware close.
 * ============================================================================
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  room: null as EventEmitter | null, reader: null as ReadableStreamDefaultController<{
    data: Int16Array; sampleRate: number; channels: number }> | null,
  connect: async () => undefined, disconnects: 0, failDisconnect: false,
  remote: (): unknown => null
}));
vi.mock('@livekit/rtc-node', () => {
  class RemoteAudioTrack {}
  native.remote = () => new RemoteAudioTrack();
  class Room extends EventEmitter {
    name = 'owned-room';
    localParticipant = { publishTrack: async () => ({}), publishData: async () => undefined };
    constructor() { super(); native.room = this; }
    async connect() { await native.connect(); }
    async disconnect() { native.disconnects++; if (native.failDisconnect) throw Error('fixture'); }
  }
  return { Room, RemoteAudioTrack,
    AudioSource: class { queuedDuration = 0; clearQueue() {} async close() {} async captureFrame() {} },
    AudioFrame: class {}, TrackPublishOptions: class {}, TrackSource: { SOURCE_MICROPHONE: 1 },
    LocalAudioTrack: { createAudioTrack: () => ({ close: async () => undefined }) },
    AudioStream: class { getReader() { return new ReadableStream({
      start(controller) { native.reader = controller; }
    }).getReader(); } },
    RoomEvent: { DataReceived: 'data', TrackSubscribed: 'track', Disconnected: 'disconnected',
      Reconnecting: 'reconnecting', TrackUnsubscribed: 'unsubscribed', TrackSubscriptionFailed: 'subscription-failed' } };
});
import { createParticipant } from '../webrtc-participant.js';
beforeEach(() => {
  vi.useFakeTimers(); native.room = null; native.reader = null; native.disconnects = 0;
  native.failDisconnect = false; native.connect = async () => undefined;
});
afterEach(() => { vi.useRealTimers(); });
function options(signal = new AbortController().signal) {
  const faults: string[] = [], frames: number[] = [], controls: Uint8Array[] = [];
  return { faults, frames, controls, value: { url: 'wss://fixture.invalid', token: 'fixture',
    roomName: 'owned-room', agentIdentity: 'agent', clock: { now: () => performance.now() }, signal,
    onPcm: (data: Int16Array) => { frames.push(data[0]); },
    onControl: (bytes: Uint8Array) => { controls.push(bytes); }, onFault: (code: string) => { faults.push(code); } } };
}
it.each(['audio.end', 'response.cancelled'])('keeps decoded tail after %s', async type => {
  const fixture = options(), participant = await createParticipant(fixture.value);
  native.room!.emit('track', native.remote(), {}, { identity: 'agent' });
  native.room!.emit('data', new TextEncoder().encode(JSON.stringify({ type })),
    { identity: 'agent' }, undefined, 'aurvin.voice.control');
  native.reader!.enqueue({ data: Int16Array.of(42), sampleRate: 24000, channels: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.frames).toEqual([42]); expect(fixture.controls).toHaveLength(1);
  expect(await participant.close()).toBe(true);
});
it('rejects the wrong control sender and duplicate remote track', async () => {
  const fixture = options(), participant = await createParticipant(fixture.value);
  native.room!.emit('data', new Uint8Array(), { identity: 'other' }, undefined, 'aurvin.voice.control');
  native.room!.emit('track', native.remote(), {}, { identity: 'agent' });
  native.room!.emit('track', native.remote(), {}, { identity: 'agent' });
  expect(fixture.faults).toEqual(['CONTROL_BINDING_INVALID', 'MEDIA_BINDING_INVALID']);
  expect(await participant.close()).toBe(true);
});
it('marks early stream close as failure and aborts an outstanding read', async () => {
  const aborter = new AbortController(), fixture = options(aborter.signal);
  const participant = await createParticipant(fixture.value);
  native.room!.emit('track', native.remote(), {}, { identity: 'agent' });
  native.reader!.close(); await vi.advanceTimersByTimeAsync(0);
  expect(fixture.faults).toContain('MEDIA_EARLY_CLOSE');
  aborter.abort(); expect(await participant.close()).toBe(true);
});
it('keeps failed disconnect visible instead of returning successful cleanup', async () => {
  const participant = await createParticipant(options().value);
  native.failDisconnect = true;
  expect(await participant.close()).toBe(false);
});
it('disconnects a join that succeeds only after its deadline', async () => {
  let release!: () => void;
  native.connect = () => new Promise<void>(resolve => { release = resolve; });
  const pending = createParticipant(options().value).then(() => 'unexpected', error => error.message);
  await vi.advanceTimersByTimeAsync(10001);
  expect(await pending).toBe('BENCHMARK_MEDIA_FAILED');
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(native.disconnects).toBe(1);
});
```

- [ ] **Step 4: Run RED/GREEN:** `npm test -- shared/__tests__/lifecycle.test.ts`. Fix the shared lifecycle helper, not individual adapters, if any case fails. A transient provider event must not close the decoded reader before observing tail audio.

- [ ] **Step 5: Test the actual Aurvin assembly port injection.**

`aurvin/__tests__/assembly.test.ts`:

```ts
/**
 * ============================================================================
 * FILE: assembly.test.ts
 * LOCATION: benchmarks/voice-architectures/aurvin/__tests__/assembly.test.ts
 * PURPOSE: Assert AppService.create receives only isolated application ports.
 * ROLE IN PROJECT: Deterministic boot routing test, not native Mongo certification.
 * KEY COMPONENTS: Module/client doubles; synthetic account; read-only config.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import type { RunContext } from '../../shared/contracts.js';
const assembly = vi.hoisted(() => ({ databases: [] as string[], created: [] as string[],
  ports: null as Record<string, unknown> | null, bootstrap: null as unknown,
  account: null as Record<string, unknown> | null, modules: {} as Record<string, unknown> }));
vi.mock('mongodb', () => ({ MongoClient: class {
  async connect() {} async close() {}
  db(name: string) { assembly.databases.push(name); return {
    listCollections: () => ({ toArray: async () => [] }),
    createCollection: async (collection: string) => { assembly.created.push(collection); },
    collection: () => ({ insertOne: async () => ({ acknowledged: true }) })
  }; }
} }));
vi.mock('livekit-server-sdk', () => ({ RoomServiceClient: class {
  async listRooms() { return []; } async deleteRoom() {}
} }));
vi.mock('../../shared/credentials.js', async original => ({
  ...await original<typeof import('../../shared/credentials.js')>(),
  backendModule: async (_root: string, name: string) => assembly.modules[name]
}));
import { startAurvin } from '../preflight.js';
import { BudgetGuard } from '../../shared/budget-guard.js';
import { SecretRedactor } from '../../shared/credentials.js';
it('routes the baseline through real AppService.create seam with isolated DB/assets/auth/config', async () => {
  const guard = new BudgetGuard({ modelId: 'vendor/example', userId: 'synthetic-user',
    maxContextTokens: 45000, maxOutputTokens: 1024, modelMarginTokens: 1024,
    region: 'us', sttModel: 'flux-general-en', ttsModel: 'flux-haley-en',
    outputParameter: 'max_tokens', expiresAtMs: Date.now() + 900000 },
    { prompt: 0, completion: 0, request: 0 });
  guard.openCandidate('aurvin');
  const assets = { fixture: true };
  const service = { users: { insert: async (account: Record<string, unknown>) => { assembly.account = account; } },
    operations: { readiness: { read: async () => ({ acceptReady: true, speech: 'ready' }) },
      shutdown: async () => undefined } };
  assembly.modules = {
    'persistence/indexes.js': { setupIndexes: async () => undefined },
    'instructions/fixed-assets.js': { loadFixedAssets: async (paths: Record<string, string>) => {
      expect(paths.instructions).toMatch(/backend[\\/]src[\\/]instructions[\\/]system.md$/);
      expect(paths.knowledge).toMatch(/product_knowledge.md$/); return assets;
    } },
    'context/prefix-estimate.js': { computeChatFloor: () => ({ minContextTokens: 40000 }) },
    'app.service.js': { AppService: { create: async (bootstrap: unknown, ports: Record<string, unknown>) => {
      assembly.bootstrap = bootstrap; assembly.ports = ports; return service;
    } } },
    'voice/providers/provider-link.js': { socketFactory: () => { throw Error('NO_SOCKET_EXPECTED'); } },
    'voice/session/livekit-admission.js': { LiveKitAdmission: class { async issue() { throw Error('NO_ROOM_EXPECTED'); } } }
  };
  const redactor = new SecretRedactor();
  const context = { mode: 'live', runId: '00000000-0000-4000-8000-000000000001',
    repoRoot: 'D:/synthetic-repo', packageRoot: 'D:/synthetic-repo/benchmarks/voice-architectures',
    outputDir: 'D:/synthetic-repo/benchmarks/voice-architectures/results/fixture',
    startedAtIso: new Date().toISOString(), clock: { now: () => 0 }, signal: guard.signal,
    guard, corpus: [], redactor, credentials: {
      bootstrap: { persistence: { profile: 'native-mongodb', mongoDbName: 'source-application',
        mongoUri: 'mongodb://fixture.invalid', documentHeadroomBytes: 1 }, identity: { userId: 'synthetic-user' },
        topology: { executor: 'single-process', localCrashRecovery: false }, encryption: { status: 'missing' },
        port: 3000, frontendOrigin: 'http://localhost:5173', nodeEnv: 'test', safety: {},
        livekit: { url: 'wss://fixture.invalid', apiKey: 'fixture', apiSecret: 'fixture' } },
      settings: { chat: { maxContextTokens: 45000 } }, document: { revision: 1 },
      openrouter: 'fixture', deepgram: 'fixture', configHash: 'f'.repeat(64), sourceRevision: null,
      overrides: [], redactor
    }
  } as unknown as RunContext;
  const runtime = await startAurvin(context, async () => ({ sourceHash: 'source', buildHash: 'build' }));
  expect(assembly.databases).toEqual(['aurvin_voice_arch_00000000000040008000000000000001']);
  expect(assembly.created).toEqual(['benchmark_run']);
  expect(assembly.account).toMatchObject({ workosUserId: 'user_bench_local', status: 'active',
    passwordChangeRequired: false, role: 'super-admin', sessionEpoch: 0 });
  const ports = assembly.ports!;
  expect(await (ports.assets as () => Promise<unknown>)()).toEqual(assets);
  const provider = (ports.authProvider as () => { read(): Promise<never> })();
  await expect(provider.read()).rejects.toThrow('BENCHMARK_AUTH_OPERATION_FORBIDDEN');
  const repo = (ports.configRepository as () => { compareAndSwap(): Promise<never> })();
  await expect(repo.compareAndSwap()).rejects.toThrow('READ_ONLY_CONFIG');
  expect(typeof ports.fetcher).toBe('function'); expect(typeof ports.speechSockets).toBe('function');
  await runtime.service.operations.shutdown(); guard.stop();
});
```

- [ ] **Step 6: Run RED/GREEN:** `npm test -- aurvin/__tests__/assembly.test.ts`. The seam is injected only in fixtures; production `harness.run` calls the default `verifyBuild` and loads `backend/dist/app.service.js`. A mock passing does not certify a live database or AppService behavior beyond the verified port contract.

- [ ] **Step 7: Run the complete isolated verification sequence.**

Working directory: `benchmarks/voice-architectures/`.

```bash
npm run build
npm run lint
npm test
npm run bench:aurvin
npm run bench:livekit-agents
npm run bench:deepgram-agent
npm run bench
```

Expected: build and type-only lint exit 0; Vitest discovers and executes all listed files (report counts, no empty-discovery claim); every CLI run is `dry-run` with zero submitted inputs, zero provider/model calls and explicit unknown/blocked outcomes. Before P2/P3 land, their lazy-loaded candidates are `CANDIDATE_NOT_IMPLEMENTED`; after they land, their genuine offline preflights are used. Do not add live flags during P1 verification.

From repository root:

```bash
git diff --check -- benchmarks/voice-architectures docs/voice-architecture-benchmark/plan1.md
git status --short
git diff --stat -- backend frontend package.json package-lock.json
```

Compare status with the pre-task snapshot; concurrent user changes are not P1 changes and must not be reverted. Confirm P1 made no application/root/env writes and created no source-DB executor. Do not run unrelated backend/frontend checks or rebuild backend for a documentation/package-isolation task.

- [ ] **Step 8: Request final atomic check commit:** `test(voice-bench): verify isolated offline routing lifecycle and Aurvin assembly`.

## Exit and V1 handoff

- [ ] Report exact P1 commits only after the orchestrator serializes them.
- [ ] Report build/lint/Vitest/dry-run commands, actual counts, and any failing or skipped check separately.
- [ ] Send P2/P3 the stable API named in Task 1, exact package pins, guard open/send/recovery semantics, `Participant.play` first-frame hook, runtime report schemas, and common report writer.
- [ ] Note Aurvin's stale-build gate and the zero-backend-write restriction. Do not describe blocked baseline execution as completed live work.
- [ ] Note managed Deepgram remains `BLOCKED_BYO_CONTROLS_UNSUPPORTED` and zero paid turns; no allowance transfer.
- [ ] V1 owns fresh authorization, bounded live calls, generated architecture/main reports, exact source/build/package hashes, actual/estimated/unknown cost reconciliation, cleanup evidence, and `docs/voice-architecture-benchmark/final_report.md`.
- [ ] Keep review recorded **skipped**. P1 completion does not mean integrated verification, browser audibility, native Mongo compatibility, or production readiness.

## Plan self-check coverage

| Approved requirement | Implementation/check |
| --- | --- |
| Isolated npm package, exact versions, Windows/Node prerequisites | Tasks 1, 10, 11 |
| Read-only env/config/decryption and fail-closed secret boundary | Task 4; credential tests |
| Six synthetic 16 kHz PCM16 inputs, hashes, hesitation, end markers | Tasks 2–3, 11 |
| US$2 / 18 turns / 15 minutes, one candidate, no retry or paid probes | Tasks 5, 10–11 |
| Real Aurvin AppService, native RTC, isolated DB/user/assets/auth/config | Tasks 6, 8–9, 11 |
| Preserve unknown delivery, onset, warm/recovered distinction | Tasks 2, 7, 9 |
| Interruption anchor, decoded cutoff, stale tail, unknown attribution | Tasks 2, 6, 9, 11 |
| Per-architecture and compiled report with qualified verdict | Tasks 7, 10; actual generation by V1 |
| P2/P3 independent interfaces and honest managed block | Contract/handoff; no P1 candidate substitution |
| No application source/config/data writes, no broad cleanup | Scope gate; Tasks 4, 8, 10–11 |
| Final verification and skipped-review honesty | Task 11 and V1 handoff |

Planner validation: run `git diff --check -- docs/voice-architecture-benchmark/plan1.md`; because a new file is untracked until the orchestrator stages it, additionally inspect its complete contents for trailing spaces/tabs. Do not stage or commit from the planner.
