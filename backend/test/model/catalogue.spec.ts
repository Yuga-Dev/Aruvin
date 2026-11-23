/**
 * ============================================================================
 * FILE: catalogue.spec.ts
 * LOCATION: backend/test/model/catalogue.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify non-inference model capability lookup and attempt factory handoff.
 *
 * ROLE IN PROJECT:
 *    Ensures P8/P9 can load selected-model limits without a paid health call
 *    and create a one-shot adapter whose accounting snapshot stays attempt-scoped.
 *
 * KEY COMPONENTS:
 *    - loadModelLimits tests: Context/output/max_tokens readiness evidence.
 *    - createModelServices tests: Attempt-bound adapter without Nest wiring.
 * ============================================================================
 */

import { loadModelLimits, createModelServices, prepareTextConfiguration } from '../../src/model/index.js';
import { readModelCatalogue } from '../../src/model/catalogue.js';
import { config, limits, seed, sink, request, response, collect } from './helpers.js';
import { FRAMES } from '../fixtures/openrouter/frames.js';
import { assets } from '../context/fixtures.js';
import { textSnapshot } from './config-snapshot.js';
import { fixturePricing } from './calendar-fixtures.js';
const entry = {
  id: 'fixture/model',
  name: 'Fixture',
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  endpoints: ['/api/v1/chat/completions'],
  context_length: 65536,
  top_provider: { max_completion_tokens: 4096 },
  supported_parameters: ['max_tokens'],
};

it('preflights a changed model and limits without inference or publication', async () => {
  const snap = textSnapshot(2, { maxOutputTokens: 512, maxContextTokens: 32768 }, 'fixture/new', 'fixture-B');
  const c = { identity: { userId: 'aurvin-dev-user' },
    budgets: snap.budgets, openRouter: snap.openRouter };
  const f = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{
    id: 'fixture/new',
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    endpoints: ['/api/v1/chat/completions'],
    context_length: 65536,
    top_provider: { max_completion_tokens: 1024 }, supported_parameters: ['max_tokens'],
  }] })));
  expect(await prepareTextConfiguration(c, assets, new AbortController().signal, f))
    .toMatchObject({ modelId: 'fixture/new', outputTokens: 1024, source: 'catalogue' });
  expect(f).toHaveBeenCalledTimes(1);
  expect(f.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models?output_modalities=all');
  expect(f.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  expect(f.mock.calls[0][1]?.headers ?? {}).not.toHaveProperty('Authorization');
});
it('loads only selected model limits without a paid health call',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({data:[entry]})));
  expect(await loadModelLimits(config(),new AbortController().signal,fetcher)).toMatchObject({...limits,source:'catalogue'});
  expect(fetcher.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models?output_modalities=all');expect(fetcher.mock.calls[0][1]?.method).not.toBe('POST');
});
it.each([{...entry,context_length:8192},{...entry,top_provider:{max_completion_tokens:null}},{...entry,supported_parameters:[]}])('fails readiness on unverified/insufficient caps',async bad=>{
  const f=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({data:[bad]})));
  await expect(loadModelLimits(config(),new AbortController().signal,f)).rejects.toMatchObject({code:'CONFIGURATION_ERROR'});
});
it('exports an attempt-bound adapter without central Nest wiring',async()=>{
  const repo=sink();const f=vi.fn<typeof fetch>().mockImplementation(async()=>response(FRAMES.normal));
  const services=createModelServices(config(),limits,repo,f,()=>0);
  const a=services.createAttemptAdapter(seed(),async()=>undefined);
  expect((await collect(a.stream(request()))).at(-1)).toEqual({type:'end'});
  expect(a.accounting.snapshot('aurvin-dev-user','sess_fixture','att_fixture')).toMatchObject({reportedProvider:'Fixture',outcome:'finalizing'});
  expect(typeof services.accounting.reconcile).toBe('function');
});
afterEach(()=>vi.useRealTimers());
it.each([JSON.stringify({data:[]}),JSON.stringify({data:[{id:'fixture/model'}]}),'x'.repeat(4194305)])('rejects unavailable/missing/oversized catalogue',async body=>{
  const f=vi.fn<typeof fetch>().mockResolvedValue(new Response(body));await expect(loadModelLimits(config(),new AbortController().signal,f)).rejects.toMatchObject({code:'CONFIGURATION_ERROR'});
});
it('pre-abort/disabled transforms avoid capability fetch, HTTP failure is sanitized',async()=>{
  const f=vi.fn<typeof fetch>().mockResolvedValue(new Response('{}',{status:503}));const ctrl=new AbortController();ctrl.abort();
  await expect(loadModelLimits(config(),ctrl.signal,f)).rejects.toThrow();expect(f).not.toHaveBeenCalled();
  await expect(loadModelLimits({...config(),openRouter:{...config().openRouter,disableTransforms:false}},new AbortController().signal,f)).rejects.toThrow();expect(f).not.toHaveBeenCalled();
  await expect(loadModelLimits(config(),new AbortController().signal,f)).rejects.toMatchObject({code:'CONFIGURATION_ERROR'});expect(f).toHaveBeenCalledTimes(1);
});
it('times out catalogue connection/body with no paid POST or restart loop',async()=>{
  vi.useFakeTimers();const c={...config(),budgets:{...config().budgets,connectTimeoutMs:5}};
  const f=vi.fn<typeof fetch>().mockImplementation(async(_,init)=>new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('private')),{once:true})));
  const result=expect(loadModelLimits(c,new AbortController().signal,f)).rejects.toMatchObject({code:'CONFIGURATION_ERROR'});await vi.advanceTimersByTimeAsync(10);await result;expect(f).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});

it('handles missing key or model without fetch while still asserting fixed context fits', async () => {
  const snap = textSnapshot(1, {}, '', '');
  const cNoKey = { identity: { userId: 'aurvin-dev-user' }, budgets: snap.budgets, openRouter: { ...snap.openRouter, apiKey: '' } };
  const f = vi.fn<typeof fetch>();
  expect(await prepareTextConfiguration(cNoKey, assets, new AbortController().signal, f)).toBeNull();
  expect(f).not.toHaveBeenCalled();

  const cNoModel = { identity: { userId: 'aurvin-dev-user' }, budgets: snap.budgets, openRouter: { ...snap.openRouter, modelId: '' } };
  expect(await prepareTextConfiguration(cNoModel, assets, new AbortController().signal, f)).toBeNull();
  expect(f).not.toHaveBeenCalled();

  const badBudgets = { ...snap.budgets, maxMessageBytes: 10 };
  const cBadBudgets = { identity: { userId: 'aurvin-dev-user' }, budgets: badBudgets, openRouter: { ...snap.openRouter, apiKey: '' } };
  await expect(prepareTextConfiguration(cBadBudgets, assets, new AbortController().signal, f))
    .rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  expect(f).not.toHaveBeenCalled();
});

it.each([
  [['max_tokens', 'tools'], true],
  [['max_tokens'], false],
])('publishes tools independently of Calendar pricing: %j', async (supported, expected) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    data: [{ ...entry, supported_parameters: supported }],
  }));
  const result = await loadModelLimits(config(), new AbortController().signal, fetcher);
  expect(result.tools).toBe(expected);
  expect(result.calendar).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models?output_modalities=all');
});

it.each([
  ['absent model entry', [{ id: 'other/model' }]],
  ['null context', [{ id: 'fixture/model', context_length: null, top_provider: { max_completion_tokens: 4096 }, supported_parameters: ['max_tokens'] }]],
  ['zero context', [{ id: 'fixture/model', context_length: 0, top_provider: { max_completion_tokens: 4096 }, supported_parameters: ['max_tokens'] }]],
  ['fractional context', [{ id: 'fixture/model', context_length: 32768.5, top_provider: { max_completion_tokens: 4096 }, supported_parameters: ['max_tokens'] }]],
  ['unsafe context', [{ id: 'fixture/model', context_length: 9007199254740992, top_provider: { max_completion_tokens: 4096 }, supported_parameters: ['max_tokens'] }]],
  ['null output', [{ id: 'fixture/model', context_length: 32768, top_provider: { max_completion_tokens: null }, supported_parameters: ['max_tokens'] }]],
  ['zero output', [{ id: 'fixture/model', context_length: 32768, top_provider: { max_completion_tokens: 0 }, supported_parameters: ['max_tokens'] }]],
  ['fractional output', [{ id: 'fixture/model', context_length: 32768, top_provider: { max_completion_tokens: 1024.5 }, supported_parameters: ['max_tokens'] }]],
  ['unsafe output', [{ id: 'fixture/model', context_length: 32768, top_provider: { max_completion_tokens: 9007199254740992 }, supported_parameters: ['max_tokens'] }]],
  ['output below candidate', [{ id: 'fixture/model', context_length: 32768, top_provider: { max_completion_tokens: 512 }, supported_parameters: ['max_tokens'] }]],
  ['context below candidate', [{ id: 'fixture/model', context_length: 16384, top_provider: { max_completion_tokens: 4096 }, supported_parameters: ['max_tokens'] }]],
  ['missing max_tokens', [{ id: 'fixture/model', context_length: 32768, top_provider: { max_completion_tokens: 4096 }, supported_parameters: ['other'] }]],
])('preflight rejects invalid catalogue entries: %s', async (_, data) => {
  const snap = textSnapshot(1, { maxOutputTokens: 1024, maxContextTokens: 32768 }, 'fixture/model', 'fixture-key');
  const c = { identity: { userId: 'aurvin-dev-user' }, budgets: snap.budgets, openRouter: snap.openRouter };
  const f = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data })));
  await expect(prepareTextConfiguration(c, assets, new AbortController().signal, f))
    .rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  expect(f.mock.calls[0]?.[1]?.method).not.toBe('POST');
});

it.each([
  ['instructions exceed message bytes', { ...assets, instructions: 'x'.repeat(70000) }, textSnapshot(1).budgets],
  ['fixed pair plus user exceeds context', assets, { ...textSnapshot(1).budgets, maxContextTokens: 100 }],
  ['fixed pair plus user exceeds messages', assets, { ...textSnapshot(1).budgets, maxMessagesInContext: 2 }],
])('preflight asserts fixed context fits: %s', async (_, testAssets, budgets) => {
  const snap = textSnapshot(1);
  const c = { identity: { userId: 'aurvin-dev-user' }, budgets, openRouter: snap.openRouter };
  const f = vi.fn<typeof fetch>();
  await expect(prepareTextConfiguration(c, testAssets, new AbortController().signal, f))
    .rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  expect(f).not.toHaveBeenCalled();
});

it.each([
  ['302 redirect', new Response('', { status: 302, headers: { Location: 'https://evil.com' } })],
  ['oversized body', new Response('x'.repeat(4194305))],
  ['malformed json', new Response('not json', { headers: { 'content-type': 'application/json' } })],
])('preflight handles fetch error: %s', async (_, res) => {
  const snap = textSnapshot(1);
  const c = { identity: { userId: 'aurvin-dev-user' }, budgets: snap.budgets, openRouter: snap.openRouter };
  const f = vi.fn<typeof fetch>().mockResolvedValue(res);
  await expect(prepareTextConfiguration(c, assets, new AbortController().signal, f))
    .rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
});

it('repeats fit checks on a same-model output/context edit', async () => {
  const snap = textSnapshot(1, { maxOutputTokens: 4096, maxContextTokens: 65_536 }, 'fixture/model', '');
  const c = { identity: { userId: 'aurvin-dev-user' }, budgets: snap.budgets,
    openRouter: { ...snap.openRouter, apiKey: 'fixture-key' } };
  const f = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    data: [{ ...entry, context_length: 65_536 }],
  })));
  const result = await prepareTextConfiguration(c, assets, new AbortController().signal, f);
  expect(result).toMatchObject({ modelId: 'fixture/model', outputTokens: 4096 });
});

const calendarEntry = { ...entry, supported_parameters: ['max_tokens', 'tools', 'parallel_tool_calls'],
  pricing: { prompt: '0.000001', completion: '0.000002', request: '0' } };
const evidence = { pricing: fixturePricing, nativeStrict: false, parallelToolCallsParameter: true };

it('publishes calendar evidence only when tools and matching prices are verified', async () => {
  const f = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [calendarEntry] })));
  const result = await loadModelLimits(config(), new AbortController().signal, f, evidence);
  expect(result.calendar).toMatchObject({ tools: true, nativeStrict: false, parallelToolCallsParameter: true,
    pricing: fixturePricing });
  expect(f.mock.calls[0][1]?.method).not.toBe('POST');
});

it('admits Calendar from live catalogue prices when the configured model is not in the frozen table', async () => {
  const f = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [calendarEntry] })));
  const result = await loadModelLimits(config(), new AbortController().signal, f);
  expect(result.calendar).toMatchObject({
    tools: true,
    nativeStrict: false,
    parallelToolCallsParameter: false,
    pricing: {
      modelId: 'fixture/model',
      promptUsdPerToken: '0.000001',
      completionUsdPerToken: '0.000002',
      requestUsd: '0',
      providerRoute: 'openrouter-default/fixture',
    },
  });
  expect(f.mock.calls[0][1]?.method).not.toBe('POST');
});

it('keeps text limits when calendar capabilities or prices are unverified', async () => {
  const noTools = { ...calendarEntry, supported_parameters: ['max_tokens'] };
  const f = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [noTools] })));
  expect((await loadModelLimits(config(), new AbortController().signal, f, evidence)).calendar).toBeUndefined();
  const badPrice = { ...calendarEntry, pricing: { prompt: '9', completion: '0.000002', request: '0' } };
  const f2 = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [badPrice] })));
  expect((await loadModelLimits(config(), new AbortController().signal, f2, evidence)).calendar).toBeUndefined();
  const missing = { ...calendarEntry, pricing: { completion: '0.000002' } };
  const f3 = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [missing] })));
  expect((await loadModelLimits(config(), new AbortController().signal, f3, evidence)).calendar).toBeUndefined();
  const nanPrice = { ...calendarEntry, pricing: { prompt: 'NaN', completion: '0.000002' } };
  const f4 = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [nanPrice] })));
  expect((await loadModelLimits(config(), new AbortController().signal, f4, evidence)).calendar).toBeUndefined();
  const textOnly = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [entry] })));
  expect((await loadModelLimits(config(), new AbortController().signal, textOnly)).calendar).toBeUndefined();
});

it('reads public metadata without sending a saved key and rejects redirects', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }));
  const signal = new AbortController().signal;
  const snapshot = await readModelCatalogue(signal, 1000, fetcher);
  expect(snapshot.entries).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(
    'https://openrouter.ai/api/v1/models?output_modalities=all');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  expect(fetcher.mock.calls[0][1]?.headers ?? {}).not.toHaveProperty('Authorization');
});

it('rejects body hang, >2000 entries, duplicate IDs, malformed JSON, 429/503, and fetch rejection without raw errors', async () => {
  vi.useFakeTimers();
  let readerCancelled = false;
  const hangStream = new ReadableStream<Uint8Array>({
    cancel() { readerCancelled = true; },
  });
  const hangFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(hangStream));
  const pending = expect(readModelCatalogue(new AbortController().signal, 50, hangFetch))
    .rejects.toMatchObject({ reasonCode: 'CATALOGUE_UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(60);
  await pending;
  expect(readerCancelled).toBe(true);
  vi.useRealTimers();

  const tooMany = Array.from({ length: 2001 }, (_, i) => ({ id: `vendor/m${i}` }));
  await expect(readModelCatalogue(new AbortController().signal, 1000,
    vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: tooMany }))))
    .rejects.toMatchObject({ reasonCode: 'CATALOGUE_RESPONSE_INVALID' });

  await expect(readModelCatalogue(new AbortController().signal, 1000,
    vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: 'a/b' }, { id: 'a/b' }] }))))
    .rejects.toMatchObject({ reasonCode: 'CATALOGUE_RESPONSE_INVALID' });

  await expect(readModelCatalogue(new AbortController().signal, 1000,
    vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: 'not-array' }))))
    .rejects.toMatchObject({ reasonCode: 'CATALOGUE_RESPONSE_INVALID' });

  await expect(readModelCatalogue(new AbortController().signal, 1000,
    vi.fn<typeof fetch>().mockResolvedValue(new Response('{bad'))))
    .rejects.toMatchObject({ reasonCode: 'CATALOGUE_RESPONSE_INVALID' });

  for (const status of [429, 503]) {
    await expect(readModelCatalogue(new AbortController().signal, 1000,
      vi.fn<typeof fetch>().mockResolvedValue(new Response('secret provider error', { status }))))
      .rejects.toMatchObject({ reasonCode: 'CATALOGUE_UNAVAILABLE', message: 'The model catalogue is unavailable.' });
  }

  await expect(readModelCatalogue(new AbortController().signal, 1000,
    vi.fn<typeof fetch>().mockRejectedValue(new Error('raw network detail'))))
    .rejects.toMatchObject({ reasonCode: 'CATALOGUE_UNAVAILABLE', message: 'The model catalogue is unavailable.' });
});

