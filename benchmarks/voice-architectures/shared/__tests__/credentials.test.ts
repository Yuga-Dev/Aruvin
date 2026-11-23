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
