/**
 * ============================================================================
 * FILE: model-compatibility.spec.ts
 * LOCATION: backend/test/admin-config/model-compatibility.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify protected model listing, non-inference compatibility check, and save gate.
 *
 * ROLE IN PROJECT:
 *    Tests AdminConfigService.models and checkModelCompatibility for isolation from
 *    credential decryption, activation, CAS, and tool dispatch, plus race/security bounds.
 *
 * KEY COMPONENTS:
 *    - Non-inference check tests: Read-only catalogue checks without side effects.
 *    - Cache, limiter, and revision-fencing tests: Single-flight, 60s TTL, conflict.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { serviceFixture, actor, settings, document, at, bootstrap, assets } from './fixtures.js';
import { prepareConfigurationSnapshot } from '../../src/app.service.js';
import { loadModelLimits } from '../../src/model/index.js';
import { AdminConfigService } from '../../src/admin-config/admin-config.service.js';
import { CredentialService } from '../../src/admin-config/credential-service.js';
import { CredentialValidator } from '../../src/admin-config/credential-validation.js';
import type { ConfigCasResult, ConfigRepository, RuntimeConfigSnapshot } from '../../src/contracts/config-runtime.js';

const validModelEntry = (id = 'fixture/model', overrides: Record<string, unknown> = {}) => ({
  id,
  name: 'Fixture',
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  endpoints: ['/api/v1/chat/completions'],
  context_length: 131072,
  top_provider: { max_completion_tokens: 8192 },
  supported_parameters: ['max_tokens'],
  ...overrides,
});

it('checks a draft without activation, decryption, CAS, or tool dispatch', async () => {
  const f = serviceFixture();
  f.fetchImpl.mockResolvedValue(Response.json({ data: [{
    id: 'fixture/model', name: 'Fixture',
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    endpoints: ['/api/v1/chat/completions'],
    context_length: 131072, top_provider: { max_completion_tokens: 8192 },
    supported_parameters: ['max_tokens'],
  }] }));
  const decrypt = vi.spyOn(f.credentials, 'decrypt');
  const draft = settings();
  draft.openRouter.modelId = 'fixture/model';
  const result = await f.service.checkModelCompatibility({
    protocolVersion: 1, expectedRevision: 1, settings: draft,
  }, actor);
  expect(result.report.status).toBe('catalogue-compatible');
  expect(result.report.warnings).toContain('CREDENTIAL_NOT_CONFIGURED');
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(f.fetchImpl.mock.calls[0][1]?.method).toBe('GET');
  expect(decrypt).not.toHaveBeenCalled();
  expect(f.activation.prepare).not.toHaveBeenCalled();
  expect(f.activation.publish).not.toHaveBeenCalled();
  expect(f.repository.compareAndSwap).not.toHaveBeenCalled();
  expect(f.stored()?.revision).toBe(1);
});

it('enforces listing 60s TTL exact boundary, single-flight refresh, and no stale fallback', async () => {
  let nowMs = Date.parse(at);
  const f = serviceFixture(document(), () => nowMs);
  let resolveFetch!: (v: Response) => void;
  f.fetchImpl.mockImplementationOnce(() => new Promise<Response>(r => { resolveFetch = r; }));

  const p1 = f.service.models(actor);
  const p2 = f.service.models(actor);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  resolveFetch(Response.json({ data: [validModelEntry()] }));
  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1.models).toHaveLength(1);
  expect(r2.models).toHaveLength(1);

  // Within < 60_000ms -> cache hit
  nowMs += 59_999;
  await f.service.models(actor);
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);

  // At exact observed + 60_000ms -> cache miss, no stale fallback on error
  nowMs += 1;
  f.fetchImpl.mockRejectedValueOnce(new Error('network down'));
  await expect(f.service.models(actor)).rejects.toMatchObject({ code: 'MODEL_CATALOGUE_UNAVAILABLE' });
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
});

it('rejects forged client flags, actor denial, delayed check conflict, and validation rate overflow', async () => {
  const f = serviceFixture();
  const nonAdmin = { ...actor, assumption: { ...actor.assumption, role: 'user' as const } };
  await expect(f.service.models(nonAdmin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(f.service.checkModelCompatibility({
    protocolVersion: 1, expectedRevision: 1, settings: settings(),
  }, nonAdmin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(f.repository.read).not.toHaveBeenCalled();
  expect(f.fetchImpl).not.toHaveBeenCalled();

  await expect(f.service.saveSettings({
    protocolVersion: 1, expectedRevision: 1, settings: settings(), compatible: true,
  }, actor)).rejects.toMatchObject({ code: 'INVALID_CONFIG_REQUEST' });

  // Delayed check vs revision bump -> CONFIG_CONFLICT
  let readCount = 0;
  f.repository.read = vi.fn(async () => {
    readCount++;
    return document(readCount === 1 ? 1 : 2);
  });
  f.fetchImpl.mockResolvedValue(Response.json({ data: [validModelEntry()] }));
  await expect(f.service.checkModelCompatibility({
    protocolVersion: 1, expectedRevision: 1, settings: settings(),
  }, actor)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', currentRevision: 2 });

  // Validation limiter: 6 starts per 60s
  const f2 = serviceFixture();
  f2.fetchImpl.mockImplementation(async () => Response.json({ data: [validModelEntry()] }));
  for (let i = 0; i < 6; i++) {
    await f2.service.checkModelCompatibility({
      protocolVersion: 1, expectedRevision: 1, settings: settings(),
    }, actor);
  }
  await expect(f2.service.checkModelCompatibility({
    protocolVersion: 1, expectedRevision: 1, settings: settings(),
  }, actor)).rejects.toMatchObject({ code: 'ADMIN_RATE_LIMITED' });
});

it('revalidates independently on save and rejects before CAS when catalogue changed', async () => {
  let stored: ReturnType<typeof document> | null = document(1);
  const fetchImpl = vi.fn<typeof fetch>();
  const credentials = new CredentialService(bootstrap.encryption, new CredentialValidator(fetchImpl));
  stored.credentials.openrouter = { envelope: credentials.seal('openrouter', 'fixture-key'), validatedAt: at };
  let active: RuntimeConfigSnapshot | null = null;
  const repository: ConfigRepository = {
    read: vi.fn(async () => stored === null ? null : structuredClone(stored)),
    createIfAbsent: vi.fn(async () => ({ outcome: 'conflict', currentRevision: 1 } as ConfigCasResult)),
    compareAndSwap: vi.fn(async (_exp, next) => {
      stored = structuredClone(next);
      return { outcome: 'confirmed', document: structuredClone(next) };
    }),
  };
  const service = new AdminConfigService({
    bootstrap,
    repository,
    credentials,
    activation: {
      prepare: vi.fn(async candidate =>
        prepareConfigurationSnapshot(bootstrap, candidate, assets, loadModelLimits, fetchImpl, new AbortController().signal)),
      publish: vi.fn(snap => { active = snap; }),
    },
    current: { current: () => active },
    assertWritable: vi.fn(async () => undefined),
    assets: () => assets,
    fetcher: fetchImpl,
  });

  // Check succeeds
  fetchImpl.mockResolvedValueOnce(Response.json({ data: [validModelEntry()] }));
  const draft = settings();
  draft.openRouter.modelId = 'fixture/model';
  const checked = await service.checkModelCompatibility({
    protocolVersion: 1, expectedRevision: 1, settings: draft,
  }, actor);
  expect(checked.report.status).toBe('catalogue-compatible');

  // Catalogue drops model before save -> save rejects with MODEL_INCOMPATIBLE before CAS
  fetchImpl.mockResolvedValueOnce(Response.json({ data: [] }));
  await expect(service.saveSettings({
    protocolVersion: 1, expectedRevision: 1, settings: draft,
  }, actor)).rejects.toMatchObject({
    code: 'MODEL_INCOMPATIBLE',
    compatibility: { status: 'incompatible', blockers: [{ code: 'MODEL_NOT_LISTED', path: 'openRouter.modelId' }] },
  });
  expect(repository.compareAndSwap).not.toHaveBeenCalled();
  expect(active).toBeNull();
});
