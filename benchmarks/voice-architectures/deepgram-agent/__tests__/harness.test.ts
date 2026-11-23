/**
 * ============================================================================
 * FILE: harness.test.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/__tests__/harness.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove structural BYO rejection occurs before any paid or network work.
 *
 * ROLE IN PROJECT:
 *    Offline P3 admission regression checks.
 *    No credentials, application state, or provider services are accessed.
 *
 * KEY COMPONENTS:
 *    - Preflight checks: Exact unsupported requirements and zero-spend evidence.
 * ============================================================================
 */
import { afterEach, expect, it, vi } from 'vitest';
import { reportSchema, type ArchitectureHarness, type RunContext } from '../../shared/contracts.js';
import { SecretRedactor } from '../../shared/credentials.js';
import { harness as deepgramAgentHarness, makeBlockedRun, preflightDeepgramAgent } from '../harness.js';

afterEach(() => vi.unstubAllGlobals());

it('blocks direct BYO with all structural reasons before any network open', () => {
  const fetcher = vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); });
  vi.stubGlobal('fetch', fetcher);
  const p = preflightDeepgramAgent('2026-11-16T00:00:00.000Z');
  expect(p.candidate).toBe('deepgram-agent');
  expect(p.status).toBe('blocked');
  expect(p.reasons).toEqual([
    'BLOCKED_BYO_CONTROLS_UNSUPPORTED',
    'BYO_USER_BODY_UNSUPPORTED',
    'BYO_ROUTING_ZDR_TRANSFORMS_UNSUPPORTED',
    'BYO_OUTPUT_TOKEN_CAP_UNSUPPORTED',
    'BYO_LOCAL_BUDGET_AND_ZERO_RETRY_UNENFORCEABLE',
    'BYO_TOKEN_GENERATION_ACCOUNTING_UNOBSERVABLE',
    'BYO_OPENAI_MODEL_ENUM_UNVERIFIED',
  ]);
  expect(p.capabilities).toEqual({
    userAttribution: false,
    zeroDataRetention: false,
    maxOutputTokensEnforced: false,
    zeroRetriesEnforced: false,
    speculationDisabled: 'unknown',
    fluxSttSupported: true,
    fluxTtsSupported: true,
  });
  expect(p.provenance.entitlement).toBe('not-checked-structurally-blocked');
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['dry-run', 'live'] as const)(
  'keeps %s at zero submissions, zero paid time and US$0',
  (mode) => {
    const result = makeBlockedRun(
      mode, '2026-11-16T00:00:00.000Z', '00000000-0000-4000-8000-000000000003',
    );
    expect(result.turns).toEqual([]);
    expect(result.envelope.submittedTurns).toBe(0);
    expect(result.envelope.modelDispatches).toBe(0);
    expect(result.provenance.networkOpens).toBe(0);
    expect(result.envelope.activeMs).toBe(0);
    expect(result.provenance.estimatedCostUsd).toBe(0);
    expect(result.provenance.providerReportedUsd).toBeNull();
    expect(result.cleanup).toEqual({ resources: [], openSockets: 0, complete: true });
  },
);

it('implements the shared candidate contract and keeps repeated public live runs blocked', async () => {
  const harness: ArchitectureHarness = deepgramAgentHarness;
  const context: RunContext = {
    mode: 'live', runId: '00000000-0000-4000-8000-000000000003',
    startedAtIso: '2026-11-16T00:00:00.000Z',
    repoRoot: process.cwd(), packageRoot: process.cwd(), outputDir: 'unused',
    clock: { now: () => 0 }, signal: new AbortController().signal,
    get credentials(): RunContext['credentials'] {
      throw new Error('CREDENTIAL_ACCESS_FORBIDDEN');
    },
    get guard(): RunContext['guard'] { throw new Error('BUDGET_ACCESS_FORBIDDEN'); },
    corpus: [], redactor: new SecretRedactor(),
  };
  const fetcher = vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); });
  vi.stubGlobal('fetch', fetcher);
  expect(harness.id).toBe('deepgram-agent');
  const p = await harness.preflight(context);
  expect(p.status).toBe('blocked');
  const forgedReady = { ...p, status: 'ready' as const, reasons: [] };
  const first = await harness.run(context, forgedReady);
  const second = await harness.run(context, p);
  expect(first).toEqual(makeBlockedRun('live', context.startedAtIso, context.runId));
  expect(second).toEqual(first);
  expect(reportSchema.parse(first).preflight.status).toBe('blocked');
  expect(first.envelope.submittedTurns).toBe(0);
  expect(first.envelope.conservativeReserveUsd).toBe(0);
  expect(first.cleanup).toEqual({ resources: [], openSockets: 0, complete: true });
  expect(fetcher).not.toHaveBeenCalled();
});
