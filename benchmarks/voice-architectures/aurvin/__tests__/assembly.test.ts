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
