/**
 * ============================================================================
 * FILE: openrouter-client.test.ts
 * LOCATION: benchmarks/voice-architectures/livekit-agents/__tests__/openrouter-client.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    request policy fixtures; zero-retry/cancellation fixtures.
 *
 * ROLE IN PROJECT:
 *    Supplies P2's standalone framework candidate without changing Aurvin.
 *    Consumes only the isolated package and P1-owned run configuration.
 *
 * KEY COMPONENTS:
 *    - request policy fixtures; zero-retry/cancellation fixtures.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import { guardedFetch, createOpenRouterLlm, type RouterPolicy } from '../openrouter-client.js';

const policy: RouterPolicy = {
  modelId: 'fixture/model', userId: 'fixture-user', apiKey: 'fixture-key',
  outputCap: 128, capParameter: 'max_tokens',
  contextCap: 4096, timeoutMs: 10000,
};
const payload = {
  model: policy.modelId, messages: [{ role: 'user', content: 'synthetic input' }],
  stream: true, max_completion_tokens: 128,
};
function setup() {
  const reserve = vi.fn();
  const signal = new AbortController().signal;
  const transport = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
  const fetcher = guardedFetch(policy, { reserve, signal }, transport);
  return { reserve, transport, fetcher };
}

it('rewrites the real outbound request with trusted attribution, privacy, and one cap', async () => {
  const s = setup();
  await s.fetcher('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', body: JSON.stringify(payload),
  });
  const [request] = s.transport.mock.calls[0]!;
  const sent = request instanceof Request ? request : new Request(request);
  const body = await sent.json();
  expect(body).toMatchObject({
    user: 'fixture-user', max_tokens: 128,
    provider: { data_collection: 'deny', require_parameters: true, allow_fallbacks: false },
    transforms: [],
    plugins: [
      { id: 'context-compression', enabled: false }, { id: 'web', enabled: false },
      { id: 'file-parser', enabled: false }, { id: 'response-healing', enabled: false },
    ],
    stream_options: { include_usage: true },
  });
  expect(body).not.toHaveProperty('max_completion_tokens');
  expect(body).not.toHaveProperty('tools');
  expect(sent.redirect).toBe('error');
  expect(s.reserve).toHaveBeenCalledTimes(1);
  expect(s.reserve.mock.invocationCallOrder[0])
    .toBeLessThan(s.transport.mock.invocationCallOrder[0]!);
});

it('strips empty tools array emitted by AgentSession without forwarding tools', async () => {
  const s = setup();
  await s.fetcher('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ ...payload, tools: [], tool_choice: 'none' }),
  });
  expect(s.transport).toHaveBeenCalledTimes(1);
  const forwarded = JSON.parse(String(s.transport.mock.calls[0]![0] instanceof Request
    ? await s.transport.mock.calls[0]![0].text()
    : s.transport.mock.calls[0]![1]?.body)) as Record<string, unknown>;
  expect(forwarded).not.toHaveProperty('tools');
  expect(forwarded).not.toHaveProperty('tool_choice');
});

it.each([
  ['https://api.openai.com/v1/chat/completions', payload],
  ['https://openrouter.ai/api/v1/chat/completions?route=other', payload],
  ['https://openrouter.ai/api/v1/models', payload],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, model: 'other/model' }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, user: 'other-user' }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, max_tokens: 129 }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, tools: [{}] }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, n: 2 }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, messages: [] }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, messages: [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://invalid/' } }] },
  ] }],
  ['http://openrouter.ai/api/v1/chat/completions', payload],
  ['https://user:pass@openrouter.ai/api/v1/chat/completions', payload],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, max_tokens: 0 }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, max_tokens: -1 }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, max_tokens: 1.5 }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, max_tokens: 64, max_completion_tokens: 128 }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, functions: [{}] }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, web_search_options: {} }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, messages: [
    { role: 'assistant', content: '', tool_calls: [{}] },
  ] }],
  ['https://openrouter.ai/api/v1/chat/completions', { ...payload, messages: [
    { role: 'user', content: 'x'.repeat(5000) },
  ] }],
])('rejects unsupported egress/body before reservation or transport: %s', async (url, body) => {
  const s = setup();
  await expect(s.fetcher(url, { method: 'POST', body: JSON.stringify(body) })).rejects.toThrow();
  expect(s.reserve).not.toHaveBeenCalled();
  expect(s.transport).not.toHaveBeenCalled();
});

it.each([
  ['missing body', { method: 'POST' as const }],
  ['undefined body', { method: 'POST' as const, body: undefined }],
  ['invalid JSON', { method: 'POST' as const, body: '{not-json' }],
  ['GET method', { method: 'GET' as const }],
])('rejects %s before reservation or transport', async (_label, init) => {
  const s = setup();
  await expect(s.fetcher('https://openrouter.ai/api/v1/chat/completions', init)).rejects.toThrow();
  expect(s.reserve).not.toHaveBeenCalled();
  expect(s.transport).not.toHaveBeenCalled();
});

it('does not transmit when shared reservation is denied or cancellation already occurred', async () => {
  const s = setup();
  s.reserve.mockImplementation(() => { throw new Error('BUDGET_ENVELOPE_EXCEEDED'); });
  await expect(s.fetcher('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', body: JSON.stringify(payload),
  })).rejects.toThrow();
  expect(s.transport).not.toHaveBeenCalled();
  const abort = new AbortController();
  abort.abort();
  await expect(s.fetcher('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', signal: abort.signal, body: JSON.stringify(payload),
  })).rejects.toThrow();
  expect(s.transport).not.toHaveBeenCalled();
});

it('supports the verified max_completion_tokens variant without also sending max_tokens', async () => {
  const reserve = vi.fn();
  let sent: Record<string, unknown> = {};
  const transport: typeof fetch = async (input, init) => {
    sent = await new Request(input, init).json();
    return new Response('');
  };
  await guardedFetch({ ...policy, capParameter: 'max_completion_tokens' }, {
    reserve, signal: new AbortController().signal,
  }, transport)('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ ...payload, max_tokens: 128 }),
  });
  expect(sent.max_completion_tokens).toBe(128);
  expect(sent).not.toHaveProperty('max_tokens');
});

it('propagates cancellation to the actual in-flight fetch without another dispatch', async () => {
  const abort = new AbortController();
  let reached!: () => void;
  const ready = new Promise<void>((resolve) => { reached = resolve; });
  const transport = vi.fn<typeof fetch>((input, init) => {
    const request = new Request(input, init);
    reached();
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  });
  const pending = guardedFetch(policy, { reserve: vi.fn(), signal: abort.signal }, transport)(
    'https://openrouter.ai/api/v1/chat/completions',
    { method: 'POST', body: JSON.stringify(payload) },
  );
  await ready;
  abort.abort(new Error('BENCHMARK_CANCELLED'));
  await expect(pending).rejects.toThrow('BENCHMARK_CANCELLED');
  expect(transport).toHaveBeenCalledTimes(1);
});

it('uses the real OpenAI client with zero retry on a retryable 429', async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    new Response('{"error":{"message":"fixture"}}', {
      status: 429, headers: { 'content-type': 'application/json' },
    }));
  const reserve = vi.fn();
  const { client } = createOpenRouterLlm(policy, {
    reserve, signal: new AbortController().signal,
  }, transport);
  expect(client.maxRetries).toBe(0);
  await expect(client.chat.completions.create({
    model: policy.modelId, messages: [{ role: 'user', content: 'synthetic' }],
    stream: true, max_completion_tokens: 128,
  })).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(reserve).toHaveBeenCalledTimes(1);
});
