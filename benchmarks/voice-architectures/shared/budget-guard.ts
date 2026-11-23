/**
 * ============================================================================
 * FILE: budget-guard.ts
 * LOCATION: benchmarks/voice-architectures/shared/budget-guard.ts
 * PURPOSE: Fail closed on every paid dispatch outside one finite pilot.
 * ROLE IN PROJECT: Shared run ledger, never a provider-enforced invoice cap.
 * KEY COMPONENTS: Dynamic rates; candidate leases; fetch/socket send barriers.
 * ============================================================================
 */
import type { EventEmitter } from 'node:events';
import type { CandidateId } from './contracts.js';
import { bounded, monotonicClock, type Clock } from './timing.js';
export type Rates = { prompt: number; completion: number; request: number };
export type GuardPolicy = { modelId: string; userId: string; maxContextTokens: number;
  maxOutputTokens: number; modelMarginTokens: number; region: 'us' | 'eu';
  sttModel: string; ttsModel: string; outputParameter: 'max_tokens' | 'max_completion_tokens';
  expiresAtMs: number; allowedAurvinToolsJson?: string };
export interface SpeechSocket extends EventEmitter {
  readyState: number; bufferedAmount: number;
  send(data: string | Uint8Array, callback: (error?: Error) => void): void;
  close(): void; terminate(): void; ping(): void;
}
export type SocketFactory = (url: URL, headers: Record<string, string>) => SpeechSocket;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('MODEL_PRICING_UNPROVEN');
  return value as Record<string, unknown>;
};
const price = (value: unknown): number => {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)))
    throw Error('MODEL_PRICING_UNPROVEN');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw Error('MODEL_PRICING_UNPROVEN');
  return n;
};
export function readRates(entry: unknown): Rates {
  const row = record(entry), base = record(row.pricing);
  const tiers = [base];
  for (const overrides of [row.pricing_overrides, base.pricing_overrides]) {
    if (overrides === undefined) continue;
    if (!Array.isArray(overrides) || overrides.length > 100) throw Error('MODEL_PRICING_UNPROVEN');
    for (const item of overrides) {
      const tier = record(item);
      if (!Number.isSafeInteger(tier.min_prompt_tokens) || Number(tier.min_prompt_tokens) < 0 ||
        Object.keys(tier).some(k => !['min_prompt_tokens', 'pricing'].includes(k)))
        throw Error('MODEL_PRICING_UNPROVEN');
      tiers.push({ ...base, ...record(tier.pricing) });
    }
  }
  for (const tier of tiers) {
    if (tier.internal_reasoning !== undefined && price(tier.internal_reasoning) !== price(tier.completion))
      throw Error('MODEL_PRICING_UNPROVEN');
    for (const [key, value] of Object.entries(tier)) {
      if (['prompt', 'completion', 'request', 'internal_reasoning', 'pricing_overrides',
        'input_cache_read', 'input_cache_write', 'discount'].includes(key)) continue;
      if (price(value) !== 0) throw Error('MODEL_PRICING_UNPROVEN');
    }
    // Cache writes can cost more than uncached input; reserve their worst rate too.
  }
  return { prompt: Math.max(...tiers.flatMap(t => [price(t.prompt),
      ...(t.input_cache_write === undefined ? [] : [price(t.input_cache_write)]),
      ...(t.input_cache_read === undefined ? [] : [price(t.input_cache_read)])])),
    completion: Math.max(...tiers.map(t => price(t.completion))),
    request: Math.max(...tiers.map(t => t.request === undefined ? 0 : price(t.request))) };
}
export function priceEnvelope(rates: Rates, context: number, output: number): number {
  const model = 18 * (context * rates.prompt + output * rates.completion + rates.request);
  const speech = 5 * .0077 + 8000 / 1000 * .045;
  const managed = 5 * .065 + 4000 / 1000 * .045;
  const media = 10 * .02;
  return Math.ceil((model + speech + managed + media) * 1.10 * 1_000_000) / 1_000_000;
}
async function boundedText(body: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await bounded(reader.read(), 10000); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw Error('EGRESS_POLICY_DENIED');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await bounded(reader.cancel().catch(() => undefined), 1000); reader.releaseLock(); }
}
export async function catalogue(fetcher: typeof fetch, modelId: string, signal: AbortSignal): Promise<{
  rates: Rates; outputParameter: 'max_tokens' | 'max_completion_tokens'; entry: Record<string, unknown> }> {
  const response = await fetcher('https://openrouter.ai/api/v1/models',
    { method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  if (!response.ok || !response.body) throw Error('MODEL_CATALOGUE_UNAVAILABLE');
  let parsed: unknown;
  try { parsed = JSON.parse(await boundedText(response.body, 4_194_304)); }
  catch { throw Error('MODEL_CATALOGUE_UNAVAILABLE'); }
  const data = record(parsed).data;
  if (!Array.isArray(data)) throw Error('MODEL_CATALOGUE_UNAVAILABLE');
  const matches = data.filter(row => record(row).id === modelId);
  if (matches.length !== 1) throw Error('MODEL_CATALOGUE_UNAVAILABLE');
  const entry = record(matches[0]);
  const supported = entry.supported_parameters;
  if (!Array.isArray(supported)) throw Error('OUTPUT_CAP_UNPROVEN');
  const outputParameter = supported.includes('max_completion_tokens') ? 'max_completion_tokens'
    : supported.includes('max_tokens') ? 'max_tokens' : null;
  const provider = record(entry.top_provider);
  if (!outputParameter || typeof entry.context_length !== 'number' ||
    !Number.isSafeInteger(entry.context_length) || entry.context_length < 45000 ||
    typeof provider.max_completion_tokens !== 'number' ||
    !Number.isSafeInteger(provider.max_completion_tokens) || provider.max_completion_tokens < 1024)
    throw Error('OUTPUT_CAP_UNPROVEN');
  return { rates: readRates(entry), outputParameter, entry };
}
export class BudgetGuard {
  private aborter = new AbortController();
  private active: { id: CandidateId; started: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private turns = new Map<CandidateId, Set<number>>();
  private dispatched = new Set<string>(); private currentTurn: number | null = null;
  private activeMs = 0; private inputBytes = 0; private ttsBytes = 0;
  private candidateInput = 0; private candidateTts = 0; private socketOpens = 0;
  private openedSpeech = new Set<'stt' | 'tts'>(); private recoveries = 0;
  private denial: string | null = null; private socketsOpen = new Set<SpeechSocket>();
  readonly conservativeReserveUsd: number;
  get signal() { return this.aborter.signal; }
  constructor(readonly policy: GuardPolicy, rates: Rates, private clock: Clock = monotonicClock) {
    if ([rates.prompt, rates.completion, rates.request].some(n => !Number.isFinite(n) || n < 0) ||
      policy.maxContextTokens !== 45000 || policy.maxOutputTokens !== 1024 ||
      !Number.isFinite(policy.expiresAtMs)) throw Error('BUDGET_POLICY_INVALID');
    this.conservativeReserveUsd = priceEnvelope(rates, policy.maxContextTokens, policy.maxOutputTokens);
    if (this.conservativeReserveUsd > 2) throw Error('BUDGET_ENVELOPE_EXCEEDED');
  }
  private deny(code: string): never { this.denial = code; this.stop(); throw Error(code); }
  private check() {
    if (this.signal.aborted) throw Error(this.denial ?? 'BENCHMARK_STOPPED');
    if (Date.now() >= this.policy.expiresAtMs) this.deny('AUTHORIZATION_EXPIRED');
    if (this.active && (this.clock.now() - this.active.started >= 300000 ||
      this.activeMs + this.clock.now() - this.active.started >= 900000)) this.deny('ACTIVE_TIME_LIMIT');
  }
  openCandidate(id: CandidateId): () => void {
    this.check();
    if (this.active) throw Error('LIVE_CONCURRENCY_DENIED');
    if (this.turns.has(id)) this.deny('CANDIDATE_ALREADY_RUN');
    this.turns.set(id, new Set()); this.currentTurn = null;
    this.candidateInput = 0; this.candidateTts = 0; this.socketOpens = 0;
    this.openedSpeech.clear(); this.recoveries = 0;
    const remaining = Math.min(300000, 900000 - this.activeMs, this.policy.expiresAtMs - Date.now());
    const timer = setTimeout(() => { this.denial = 'ACTIVE_TIME_LIMIT'; this.stop(); }, remaining);
    timer.unref(); this.active = { id, started: this.clock.now(), timer };
    let closed = false;
    return () => {
      if (closed) return; closed = true;
      if (this.active?.id === id) {
        this.activeMs += Math.max(0, this.clock.now() - this.active.started);
        clearTimeout(this.active.timer); this.active = null;
      }
    };
  }
  submitTurn(id: CandidateId, index: number) {
    this.check();
    if (!Number.isInteger(index) || index < 0 || index > 5) this.deny('TURN_LIMIT');
    if (this.active?.id !== id) this.deny('LIVE_CANDIDATE_REQUIRED');
    const seen = this.turns.get(id)!;
    if (seen.has(index)) throw Error('TURN_ALREADY_SUBMITTED');
    if ([...this.turns.values()].reduce((n, set) => n + set.size, 0) >= 18) this.deny('TURN_LIMIT');
    seen.add(index); this.currentTurn = index;
  }
  speechSend(kind: 'stt' | 'tts', data: string | Uint8Array) {
    this.check(); if (!this.active) this.deny('LIVE_CANDIDATE_REQUIRED');
    if (kind === 'stt') {
      if (typeof data === 'string' || data.byteLength % 2) this.deny('SPEECH_FORMAT_INVALID');
      if (this.inputBytes + data.byteLength > 300000 * 32 ||
        this.candidateInput + data.byteLength > 150000 * 32) this.deny('SPEECH_LIMIT');
      this.inputBytes += data.byteLength; this.candidateInput += data.byteLength;
    } else {
      if (typeof data !== 'string') this.deny('SPEECH_FORMAT_INVALID');
      const size = Buffer.byteLength(data);
      if (this.ttsBytes + size > 8000 || this.candidateTts + size > 4000) this.deny('SPEECH_LIMIT');
      this.ttsBytes += size; this.candidateTts += size;
    }
  }
  speechOpen(kind: 'stt' | 'tts') {
    this.check();
    if (!this.active || this.openedSpeech.has(kind)) this.deny('SPEECH_RETRY_DENIED');
    this.openedSpeech.add(kind);
  }
  allowSpeechRecovery(reason: 'VOICE_DELIVERY_UNKNOWN') {
    this.check();
    if (reason !== 'VOICE_DELIVERY_UNKNOWN' || !this.active || this.recoveries >= 5)
      this.deny('SPEECH_RETRY_DENIED');
    this.recoveries++; this.openedSpeech.clear();
  }
  fetch(fetcher: typeof fetch): typeof fetch {
    return async (input, init) => {
      this.check();
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== 'https://openrouter.ai' || url.username || url.password) this.deny('EGRESS_POLICY_DENIED');
      if (request.method === 'GET' && ['/api/v1/models', '/api/v1/generation'].includes(url.pathname)) {
        return fetcher(request, { redirect: 'error',
          signal: AbortSignal.any([request.signal, this.signal, AbortSignal.timeout(30000)]) });
      }
      if (request.method !== 'POST' || url.pathname !== '/api/v1/chat/completions' ||
        url.search || !this.active || this.currentTurn === null) this.deny('EGRESS_POLICY_DENIED');
      if (!request.body || Number(request.headers.get('content-length') ?? '0') > 200000)
        this.deny('EGRESS_POLICY_DENIED');
      let body: Record<string, unknown>;
      try { body = record(JSON.parse(await boundedText(request.body!, 200000))); }
      catch { this.deny('EGRESS_POLICY_DENIED'); }
      if (['route', 'functions', 'function_call', 'web_search_options'].some(key => body[key] !== undefined) ||
        body.max_tokens !== undefined && body.max_completion_tokens !== undefined &&
          body.max_tokens !== body.max_completion_tokens) this.deny('EGRESS_POLICY_DENIED');
      if (body.transforms !== undefined &&
        (!Array.isArray(body.transforms) || body.transforms.length)) this.deny('EGRESS_POLICY_DENIED');
      if (body.plugins !== undefined && (!Array.isArray(body.plugins) ||
        body.plugins.some(plugin => !plugin || typeof plugin !== 'object' || plugin.enabled !== false)))
        this.deny('EGRESS_POLICY_DENIED');
      if (body.provider !== undefined) {
        const routing = body.provider as Record<string, unknown>;
        if (!routing || typeof routing !== 'object' || Array.isArray(routing) ||
          Object.keys(routing).some(key => !['data_collection', 'require_parameters', 'allow_fallbacks'].includes(key)) ||
          routing.data_collection !== undefined && routing.data_collection !== 'deny' ||
          routing.require_parameters !== undefined && routing.require_parameters !== true ||
          routing.allow_fallbacks !== undefined && routing.allow_fallbacks !== false)
          this.deny('EGRESS_POLICY_DENIED');
      }
      const parameter = this.policy.outputParameter;
      const output = body.max_tokens ?? body.max_completion_tokens;
      const messages = body.messages;
      const aurvinToolsAllowed = this.active.id === 'aurvin' && this.policy.allowedAurvinToolsJson !== undefined;
      const toolsOk = body.tools === undefined ||
        (aurvinToolsAllowed && JSON.stringify(body.tools) === this.policy.allowedAurvinToolsJson);
      const parallelOk = body.parallel_tool_calls === undefined ||
        (aurvinToolsAllowed && body.parallel_tool_calls === false);
      if (body.model !== this.policy.modelId || body.user !== this.policy.userId ||
        body.models !== undefined || !toolsOk || !parallelOk || body.tool_choice !== undefined ||
        !Array.isArray(messages) || !messages.length || messages.length > 500 ||
        !Number.isSafeInteger(output) || Number(output) < 1 || Number(output) > this.policy.maxOutputTokens)
        this.deny('EGRESS_POLICY_DENIED');
      let estimate = 64 + (body.tools !== undefined ? Buffer.byteLength(JSON.stringify(body.tools), 'utf8') : 0);
      for (const message of messages as Array<Record<string, unknown>>) {
        if (!['system', 'assistant', 'user'].includes(String(message.role)) ||
          typeof message.content !== 'string') this.deny('EGRESS_POLICY_DENIED');
        estimate += Buffer.byteLength(message.content as string) + 32;
      }
      if (estimate + Number(output) + this.policy.modelMarginTokens > this.policy.maxContextTokens)
        this.deny('CONTEXT_BUDGET_EXCEEDED');
      const key = `${this.active.id}:${this.currentTurn}`;
      if (this.dispatched.size >= 18) this.deny('MODEL_ATTEMPT_LIMIT');
      if (this.dispatched.has(key)) throw Error('MODEL_ATTEMPT_LIMIT');
      // Explicit benchmark-only tightening, recorded in provenance; never saved.
      body.provider = { data_collection: 'deny', require_parameters: true, allow_fallbacks: false };
      body.transforms = [];
      body.plugins = ['context-compression', 'web', 'file-parser', 'response-healing']
        .map(id => ({ id, enabled: false }));
      delete body.max_tokens; delete body.max_completion_tokens; body[parameter] = output;
      this.check(); this.dispatched.add(key); // Count even a failed/ambiguous send; never refund.
      return fetcher(new Request(request, { body: JSON.stringify(body) }), { redirect: 'error',
        signal: AbortSignal.any([request.signal, this.signal, AbortSignal.timeout(60000)]) });
    };
  }
  sockets(factory: SocketFactory): SocketFactory {
    return (url, headers) => {
      this.check(); if (!this.active) this.deny('LIVE_CANDIDATE_REQUIRED');
      const expected = this.policy.region === 'eu' ? 'wss://api.eu.deepgram.com' : 'wss://api.deepgram.com';
      const tts = url.pathname === '/v2/speak';
      if (url.origin !== expected || url.username || url.password || this.socketOpens >= 16 ||
        !(tts && url.searchParams.get('model') === this.policy.ttsModel ||
          url.pathname === '/v2/listen' && url.searchParams.get('model') === this.policy.sttModel) ||
        url.searchParams.has('eager_eot_threshold')) this.deny('EGRESS_POLICY_DENIED');
      if (url.searchParams.has('encoding') && url.searchParams.get('encoding') !== 'linear16' ||
        url.searchParams.has('sample_rate') && url.searchParams.get('sample_rate') !== (tts ? '24000' : '16000'))
        this.deny('EGRESS_POLICY_DENIED');
      this.speechOpen(tts ? 'tts' : 'stt');
      this.socketOpens++;
      const socket = factory(url, headers), send = socket.send.bind(socket);
      this.socketsOpen.add(socket); socket.once('close', () => this.socketsOpen.delete(socket));
      socket.send = (data, callback) => {
        try {
          this.check();
          if (typeof data === 'string') {
            const message = JSON.parse(data);
            if (message.type === 'Speak' && tts) this.speechSend('tts', message.text);
            else if (!['Flush', 'Close', 'CloseStream', 'ForceEndTurn', 'Interrupt', 'KeepAlive'].includes(message.type))
              this.deny('EGRESS_POLICY_DENIED');
          } else if (tts) this.deny('EGRESS_POLICY_DENIED'); else this.speechSend('stt', data);
        } catch {
          this.denial ??= 'EGRESS_POLICY_DENIED'; this.stop();
          callback(Error(this.denial)); return;
        }
        send(data, callback);
      };
      return socket;
    };
  }
  snapshot() {
    return { submittedTurns: [...this.turns.values()].reduce((n, set) => n + set.size, 0),
      modelDispatches: this.dispatched.size,
      activeMs: this.activeMs + (this.active ? Math.max(0, this.clock.now() - this.active.started) : 0),
      sttAudioMs: this.inputBytes / 32, ttsInputBytes: this.ttsBytes,
      conservativeReserveUsd: this.conservativeReserveUsd, denied: this.denial };
  }
  submittedIndices(id: CandidateId) { return [...(this.turns.get(id) ?? [])].sort((a, b) => a - b); }
  get openSocketCount() { return this.socketsOpen.size; }
  stop() {
    if (this.active) {
      this.activeMs += Math.max(0, this.clock.now() - this.active.started);
      clearTimeout(this.active.timer); this.active = null;
    }
    this.aborter.abort();
    for (const socket of this.socketsOpen) { try { socket.terminate(); } catch { /* counted as cleanup unknown */ } }
  }
}
