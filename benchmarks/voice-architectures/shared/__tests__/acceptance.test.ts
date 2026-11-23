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
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
