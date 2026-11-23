/**
 * ============================================================================
 * FILE: openrouter-client.ts
 * LOCATION: benchmarks/voice-architectures/livekit-agents/openrouter-client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    One real OpenAI client; request normalization, policy enforcement, attribution, finite token limits, atomic shared-budget handoff.
 *
 * ROLE IN PROJECT:
 *    Supplies P2's standalone framework candidate without changing Aurvin.
 *    Consumes only the isolated package and P1-owned run configuration.
 *
 * KEY COMPONENTS:
 *    - guardedFetch — last pre-dispatch policy/budget boundary
 *    - createOpenRouterLlm — actual OpenAI/plugin client
 * ============================================================================
 */
import OpenAI from 'openai';
import * as openai from '@livekit/agents-plugin-openai';

export type RouterPolicy = {
  modelId: string;
  userId: string;
  apiKey: string;
  outputCap: number;
  capParameter: 'max_tokens' | 'max_completion_tokens';
  contextCap: number;
  timeoutMs: number;
};
export type GuardPorts = {
  signal: AbortSignal;
  reserve(body: Readonly<Record<string, unknown>>): void;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function boundedJson(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 200000)) {
    throw new Error('OPENROUTER_REQUEST_TOO_LARGE');
  }
  if (!request.body) throw new Error('OPENROUTER_BODY_MISSING');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel(request.signal.reason).catch(() => {}); };
  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 200000) throw new Error('OPENROUTER_REQUEST_TOO_LARGE');
      chunks.push(next.value);
    }
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function checkedPolicy(p: RouterPolicy) {
  if (!p.modelId || !p.userId || !p.apiKey ||
      !Number.isSafeInteger(p.outputCap) || p.outputCap < 1 ||
      !Number.isSafeInteger(p.contextCap) || p.contextCap <= p.outputCap ||
      !Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0 ||
      !['max_tokens', 'max_completion_tokens'].includes(p.capParameter)) {
    throw new Error('INVALID_ROUTER_POLICY');
  }
}

export function guardedFetch(p: RouterPolicy, guard: GuardPorts, transport: typeof fetch): typeof fetch {
  checkedPolicy(p);
  return async (input, init) => {
    const incoming = new Request(input, init);
    const signal = AbortSignal.any([
      incoming.signal, guard.signal, AbortSignal.timeout(p.timeoutMs),
    ]);
    const request = new Request(incoming, { signal });
    const url = new URL(request.url);
    if (url.origin !== 'https://openrouter.ai' ||
        url.pathname !== '/api/v1/chat/completions' ||
        url.search || url.hash || url.username || url.password ||
        request.method !== 'POST') {
      throw new Error('OPENROUTER_EGRESS_DENIED');
    }
    guard.signal.throwIfAborted();
    request.signal.throwIfAborted();
    const raw = await boundedJson(request);
    if (!object(raw) || raw.model !== p.modelId ||
        (raw.user !== undefined && raw.user !== p.userId) ||
        raw.stream !== true || (raw.n !== undefined && raw.n !== 1)) {
      throw new Error('OPENROUTER_REQUEST_DENIED');
    }
    const permitted = new Set([
      'model', 'messages', 'stream', 'stream_options', 'user', 'n',
      'max_tokens', 'max_completion_tokens', 'temperature', 'top_p',
      'provider', 'transforms', 'plugins', 'store', 'tool_choice', 'tools',
    ]);
    if (Object.keys(raw).some((key) => !permitted.has(key)) ||
        (raw.tool_choice !== undefined && raw.tool_choice !== 'none') ||
        (raw.tools !== undefined && (!Array.isArray(raw.tools) || raw.tools.length > 0))) {
      throw new Error('OPENROUTER_UNSUPPORTED_PARAMETER');
    }
    if (!Array.isArray(raw.messages) || raw.messages.length === 0 ||
        raw.messages.some((message: unknown) => !object(message) ||
          !['system', 'user', 'assistant'].includes(String(message.role)) ||
          typeof message.content !== 'string' ||
          Object.keys(message).some((key) => !['role', 'content'].includes(key)))) {
      throw new Error('OPENROUTER_CONTEXT_DENIED');
    }
    if (raw.max_tokens !== undefined && raw.max_completion_tokens !== undefined &&
        raw.max_tokens !== raw.max_completion_tokens) {
      throw new Error('OPENROUTER_OUTPUT_CAP_DENIED');
    }
    for (const key of ['max_tokens', 'max_completion_tokens'] as const) {
      const cap = raw[key];
      if (cap !== undefined && (!Number.isSafeInteger(cap) ||
          typeof cap !== 'number' || cap < 1 || cap > p.outputCap)) {
        throw new Error('OPENROUTER_OUTPUT_CAP_DENIED');
      }
    }
    // Byte ceiling is an additional finite request bound, not a tokenizer claim.
    // The shared reservation independently validates the verified context budget.
    if (Buffer.byteLength(JSON.stringify(raw.messages), 'utf8') > p.contextCap) {
      throw new Error('OPENROUTER_CONTEXT_CAP_DENIED');
    }
    const body: Record<string, unknown> = {
      ...raw,
      user: p.userId,
      provider: { data_collection: 'deny', require_parameters: true, allow_fallbacks: false },
      transforms: [],
      plugins: ['context-compression', 'web', 'file-parser', 'response-healing']
        .map((id) => ({ id, enabled: false })),
      stream_options: { include_usage: true },
      store: false,
    };
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.tool_choice;
    delete body.tools;
    // Use the catalogue-verified parameter; never send both parameters.
    body[p.capParameter] = p.outputCap;
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${p.apiKey}`);
    headers.set('content-type', 'application/json');
    signal.throwIfAborted();
    guard.reserve(Object.freeze(body));
    signal.throwIfAborted();
    return transport(new Request(request.url, {
      method: 'POST', headers, body: JSON.stringify(body),
      redirect: 'error', signal,
    }));
  };
}

class NoProbeLlm extends openai.LLM {
  // Catalogue verification is P1's explicit preflight, not a hidden session probe.
  protected override async _prewarmImpl(_signal: AbortSignal): Promise<void> {}
}

export function createOpenRouterLlm(p: RouterPolicy, guard: GuardPorts, transport: typeof fetch) {
  const client = new OpenAI({
    apiKey: p.apiKey, baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 0, timeout: p.timeoutMs,
    fetch: guardedFetch(p, guard, transport),
  });
  const llm = new NoProbeLlm({
    client, apiKey: p.apiKey, baseURL: 'https://openrouter.ai/api/v1',
    model: p.modelId, user: p.userId, maxCompletionTokens: p.outputCap,
    parallelToolCalls: false, toolChoice: 'none', store: false,
  });
  return { client, llm };
}
