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
import { backendModule, loadCredentials, parseEnvironment, SecretRedactor } from './credentials.js';
import { loadCorpus } from './corpus.js';
import { BudgetGuard, catalogue } from './budget-guard.js';
import { hash, newReport, compileReports, publishReports, writeArchitectureReport } from './compiler.js';
import { monotonicClock } from './timing.js';
type Options = { live: boolean; candidate: CandidateId | 'all'; envFile?: string;
  authorization?: string; readStoredConfig: boolean; compileOnly: boolean; runId?: string; publish: boolean;
  waiveDeepgramByo: boolean };
export function parseOptions(args: string[]): Options {
  const out: Options = { live: false, candidate: 'all', readStoredConfig: false, compileOnly: false, publish: false, waiveDeepgramByo: false };
  const names = new Set<string>();
  for (const arg of args) {
    const index = arg.indexOf('='), name = index < 0 ? arg : arg.slice(0, index);
    const value = index < 0 ? undefined : arg.slice(index + 1);
    if (names.has(name)) throw Error('CLI_ARGUMENT_INVALID'); names.add(name);
    if (name === '--live' && value === undefined) out.live = true;
    else if (name === '--read-stored-config' && value === undefined) out.readStoredConfig = true;
    else if (name === '--compile-only' && value === undefined) out.compileOnly = true;
    else if (name === '--publish-reports' && value === undefined) out.publish = true;
    else if (name === '--waive-deepgram-byo' && value === undefined) out.waiveDeepgramByo = true;
    else if (name === '--candidate' && ['all', ...candidateIds].includes(value ?? '')) out.candidate = value as Options['candidate'];
    else if (name === '--env-file' && value) out.envFile = resolve(value);
    else if (name === '--authorization' && value) out.authorization = resolve(value);
    else if (name === '--run-id' && value && z.string().uuid().safeParse(value).success) out.runId = value;
    else throw Error('CLI_ARGUMENT_INVALID');
  }
  if (out.live && (!out.authorization || out.compileOnly)) throw Error('AUTHORIZATION_REQUIRED');
  if (out.compileOnly && !out.runId) throw Error('RUN_ID_REQUIRED');
  if (!out.live && (out.authorization || out.readStoredConfig || out.waiveDeepgramByo)) throw Error('LIVE_FLAG_REQUIRED');
  return out;
}
export const selectedCandidates = (candidate: Options['candidate']): readonly CandidateId[] =>
  candidate === 'all' ? candidateIds : [candidate];
const authorizationSchema = z.object({ version: z.literal(1), nonce: z.string().uuid(),
  approvalReference: z.literal('user-request-2026-11-16-low-cost-pilot'),
  issuedAtMs: z.number().int().nonnegative(), expiresAtMs: z.number().int().positive(),
  maxUsd: z.literal(2), maxTurns: z.literal(18), maxActiveMs: z.literal(900000),
  waiveDeepgramByo: z.boolean().optional(),
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
    let list: import('node:fs').Dirent[];
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
    .filter(([key]) => /KEY|SECRET|PASSWORD|TOKEN|MONGODB_URI/.test(key) &&
      !/^(MAX_.*_TOKENS|DEEPGRAM_KEYTERMS)$/.test(key))
    .map(([, value]) => value));
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
      if (options.waiveDeepgramByo && auth.waiveDeepgramByo !== true) throw Error('AUTHORIZATION_INVALID');
      await mkdir(resolve(packageRoot, 'results/authorizations'), { recursive: true });
      try {
        await writeFile(resolve(packageRoot, 'results/authorizations', `${auth.nonce}.claim`),
          redactor.encode({ nonce: auth.nonce, runId, approvalReference: auth.approvalReference, ...pins }),
          { flag: 'wx', mode: 0o600 });
      } catch { throw Error('AUTHORIZATION_ALREADY_CLAIMED'); }
      // The nonce is consumed even if a subsequent preflight fails; a retry needs a new decision.
      const envHash = hash(envText);
      let checkingSource = false;
      const verifyWatched = () => {
        if (checkingSource || !pins) return;
        checkingSource = true;
        void Promise.all([
          sourceHash(repoRoot, packageRoot),
          readFile(resolve(packageRoot, 'package-lock.json')).then(hash),
          readFile(envPath, 'utf8').then(hash, () => hash('')),
        ]).then(([s, l, e]) => {
          if (s !== pins!.sourceHash || l !== pins!.lockHash || e !== envHash) shutdown();
        }).catch(() => shutdown()).finally(() => { checkingSource = false; });
      };
      const onSourceChange = (_event: string, filename: string | Buffer | null) => {
        const name = String(filename ?? '');
        if (!name || /\.(ts|js|ps1|json|md|env)$/.test(name) && !/^(results|audio|node_modules)[\\/]/.test(name))
          verifyWatched();
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
        try { watchers.push(watch(path, verifyWatched)); }
        catch { throw Error('SOURCE_WATCH_UNAVAILABLE'); }
      }
      if (await sourceHash(repoRoot, packageRoot) !== pins.sourceHash) throw Error('SOURCE_CHANGED');
      // Non-inference catalogue GET is after explicit live auth; no paid health probe.
      const info = await catalogue(fetch, credentials.settings.openRouter.modelId, aborter.signal);
      const [{ SKILL_NATIVE_TOOLS }, { nativeToolDefinitions }] = await Promise.all([
        backendModule<{ SKILL_NATIVE_TOOLS: readonly unknown[] }>(repoRoot, 'contracts/calendar-tools.js'),
        backendModule<{ nativeToolDefinitions(tools: readonly unknown[]): unknown[] }>(repoRoot, 'model/calendar-policy.js'),
      ]);
      guard = new BudgetGuard({ modelId: credentials.settings.openRouter.modelId,
        userId: credentials.bootstrap.identity.userId, maxContextTokens: 45000,
        maxOutputTokens: 1024, modelMarginTokens: credentials.settings.chat.modelMarginTokens,
        region: credentials.settings.deepgram.region, sttModel: credentials.settings.deepgram.liveModel,
        ttsModel: credentials.settings.deepgram.ttsModel, outputParameter: info.outputParameter,
        expiresAtMs: auth.expiresAtMs,
        allowedAurvinToolsJson: JSON.stringify(nativeToolDefinitions(SKILL_NATIVE_TOOLS)) }, info.rates);
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
        credentials, guard, corpus, redactor, waiveDeepgramByo: options.waiveDeepgramByo };
      let report: ArchitectureReport;
      try {
        const candidate = await loader(packageRoot, id);
        const preflight = setupFailure ? offlinePreflight(id, [setupFailure])
          : context.signal.aborted ? offlinePreflight(id, ['PRIOR_RUN_STOPPED'])
          : candidate ? await candidate.preflight(context) : offlinePreflight(id, ['CANDIDATE_NOT_IMPLEMENTED']);
        report = preflight.status === 'ready' && context.mode === 'live' && candidate
          ? await candidate.run(context, preflight) : newReport(id, runId, context.mode, preflight);
      } catch (error) {
        const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)
          ? error.message : 'CANDIDATE_FAILED';
        report = newReport(id, runId, context.mode, offlinePreflight(id, [code]));
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
    if (options.live) {
      try {
        const rtc = await import('@livekit/rtc-node') as { dispose?: () => Promise<void> };
        await rtc.dispose?.();
      } catch { /* ignore */ }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then(reports => {
    console.log(JSON.stringify({ runId: reports[0]?.runId ?? null,
      candidates: reports.map(r => ({ candidate: r.candidate, preflight: r.preflight.status,
        submitted: r.turns.filter(t => t.submitted).length })) }));
    process.exit(0);
  }).catch((error: unknown) => {
    const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'UNKNOWN';
    console.error('BENCHMARK_FAILED_CLOSED', code);
    process.exit(1);
  });
}
