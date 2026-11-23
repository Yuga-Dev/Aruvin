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
