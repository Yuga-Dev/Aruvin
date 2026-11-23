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
    .filter(([key]) => /KEY|SECRET|PASSWORD|TOKEN|MONGODB_URI/.test(key) &&
      !/^(MAX_.*_TOKENS|DEEPGRAM_KEYTERMS)$/.test(key))
    .map(([, value]) => value));
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
