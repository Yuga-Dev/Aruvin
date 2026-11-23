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
