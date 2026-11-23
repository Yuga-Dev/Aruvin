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
    const config = ts.readConfigFile(resolve(root, 'tsconfig.build.json'), ts.sys.readFile);
    if (config.error) throw Error();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    if (parsed.errors.length || !parsed.fileNames.length) throw Error();
    const emitted = new Map<string, string>();
    const program = ts.createProgram(parsed.fileNames, {
      ...parsed.options, sourceMap: false, declaration: false, incremental: false, noEmit: false,
    });
    program.emit(undefined, (fileName, text) => {
      if (fileName.endsWith('.js')) emitted.set(resolve(fileName), text);
    });
    const normalize = (text: string) => text.replace(/\r\n/g, '\n')
      .replace(/^\/\/# sourceMappingURL=.*$/gm, '').trim();
    const sourceRecords: string[] = [], builtRecords: string[] = [];
    for (const file of await files(sourceRoot)) {
      if (!file.endsWith('.ts') || file.endsWith('.d.ts') || /\.(spec|test)\.ts$/.test(file)) continue;
      const name = relative(sourceRoot, file).replaceAll('\\', '/');
      const builtPath = resolve(dist, name.replace(/\.ts$/, '.js'));
      const expected = emitted.get(builtPath);
      const built = await readFile(builtPath, 'utf8');
      if (expected === undefined || normalize(expected) !== normalize(built)) throw Error();
      sourceRecords.push(`${name}\0${await readFile(file, 'utf8')}`);
    }
    for (const file of await files(dist)) {
      if (/\.(js|map|json)$/.test(file)) builtRecords.push(
        `${relative(dist, file).replaceAll('\\', '/')}\0${await readFile(file, 'utf8')}`);
    }
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'nest-cli.json']) {
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
  operations: { readiness: { read(): Promise<{ acceptReady: boolean; speech: string; issues: string[] }> };
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
    AppService: { create(bootstrap: unknown, ports: Record<string, unknown>): Promise<AurvinService> }
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
  let cachedModels: { status: number; headers: [string, string][]; body: string } | null = null;
  const catalogueFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    if (req.method === 'GET' && req.url === 'https://openrouter.ai/api/v1/models') {
      if (!cachedModels) {
        const res = await fetch(req, { redirect: 'error', signal: AbortSignal.any([req.signal, AbortSignal.timeout(45000)]) });
        if (!res.ok) return res;
        cachedModels = { status: res.status, headers: [...res.headers.entries()], body: await res.text() };
      }
      return new Response(cachedModels.body, { status: cachedModels.status, headers: cachedModels.headers });
    }
    return fetch(req, init);
  };
  const service = await AppService.create(bootstrap, {
    assets: async () => assets, authProvider: () => authProvider,
    configRepository: () => readOnlyConfig(credentials.document),
    livekitAdmission: admission, fetcher: guard.fetch(catalogueFetch),
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
  let failCode = 'BASELINE_NOT_READY';
  try {
    await service.users.insert(account);
    let readiness = await service.operations.readiness.read();
    for (let attempt = 0; attempt < 3 && (!readiness.acceptReady || readiness.speech !== 'ready'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5100));
      readiness = await service.operations.readiness.read();
    }
    if (!readiness.acceptReady || readiness.speech !== 'ready') {
      const detail = readiness.issues.join('_').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
      failCode = detail ? `BASELINE_NOT_READY_${detail}` : `BASELINE_NOT_READY_SPEECH_${readiness.speech.toUpperCase()}`;
      throw Error(failCode);
    }
  } catch (error) {
    if (error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)) failCode = error.message;
    await bounded(service.operations.shutdown(), 10000).catch(() => undefined);
    throw Error(failCode);
  }
  return { service, principal, bootstrap, rooms, roomClient };
}
