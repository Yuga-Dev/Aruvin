/**
 * ============================================================================
 * FILE: web-native.spec.ts
 * LOCATION: backend/test/model/web-native.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify bounded web_tool candidate validation, denial, and repair feedback.
 *
 * ROLE IN PROJECT:
 *    Proves the web boundary classifies syntax, unsafety, and advertisement
 *    without dispatching a provider or widening Calendar schemas.
 *
 * KEY COMPONENTS:
 *    - candidate: Test-local native candidate builder.
 *    - validateWebCandidate cases: browse/fetch, malformed, mixed, denied.
 *    - webRepairFeedback cases: canonical schema, bounded length.
 * ============================================================================
 */

import { WEB_TOOL_PARAMETERS } from '../../src/contracts/web-search-tools.js';
import {
  createWebNativeModelPort,
  environmentRepairFeedback,
  validateEnvironmentCandidate,
  validateWebCandidate,
  webRepairFeedback,
} from '../../src/model/web-native.js';
import { GET_ENVIRONMENT_PARAMETERS } from '../../src/contracts/environment-tools.js';
import { config, limits, response } from './helpers.js';
import { FRAMES } from '../fixtures/openrouter/frames.js';

const candidate = (raw: string, name = 'web_tool') => ({
  calls: [{ index: 0, id: 'web_call_1', type: 'function', name,
    arguments: raw, envelopeInvalid: false }],
  terminal: 'tool_calls',
  envelopeInvalid: false,
});

it('validates browse and fetch without dispatching or conflating safety with syntax', () => {
  expect(validateWebCandidate(candidate('{"mode":"browse","query":"  news  "}'), true))
    .toMatchObject({ kind: 'web_tool', args: { mode: 'browse', query: 'news' } });
  expect(validateWebCandidate(candidate('{"mode":"fetch","url":"http://127.0.0.1/"}'), true))
    .toMatchObject({ kind: 'web_tool', args: { mode: 'fetch' } });
  expect(validateWebCandidate(candidate('{"mode":"fetch","url":"not a URL"}'), true).kind)
    .toBe('web-invalid');
  expect(webRepairFeedback(['query:required'])).toContain(JSON.stringify(WEB_TOOL_PARAMETERS));
  expect(webRepairFeedback(['query:required']).length).toBeLessThanOrEqual(1500);
});

it.each([
  ['wrong mode', '{"mode":"crawl","query":"news"}'],
  ['both mode fields', '{"mode":"browse","query":"news","url":"https://example.com/"}'],
  ['missing field', '{"mode":"browse"}'],
  ['empty query', '{"mode":"browse","query":"   "}'],
  ['oversize query', JSON.stringify({ mode: 'browse', query: 'a'.repeat(401) })],
  ['malformed json', '{"mode":"browse"'],
  ['duplicate keys', '{"mode":"browse","mode":"fetch"}'],
  ['prototype key', '{"mode":"browse","query":"news","__proto__":{}}'],
  ['unknown field', '{"mode":"browse","query":"news","extra":1}'],
])('rejects invalid web arguments as repairable: %s', (_, raw) => {
  const decision = validateWebCandidate(candidate(raw), true);
  expect(decision.kind).toBe('web-invalid');
  if (decision.kind !== 'web-invalid') return;
  expect(decision.diagnostics.length).toBeLessThanOrEqual(4);
  expect(webRepairFeedback(decision.diagnostics).length).toBeLessThanOrEqual(1500);
});

it.each([
  ['bad id', { ...candidate('{"mode":"browse","query":"news"}'),
    calls: [{ index: 0, id: '', type: 'function', name: 'web_tool',
      arguments: '{"mode":"browse","query":"news"}', envelopeInvalid: false }] }],
  ['bad type', { ...candidate('{"mode":"browse","query":"news"}'),
    calls: [{ index: 0, id: 'web_call_1', type: 'other', name: 'web_tool',
      arguments: '{"mode":"browse","query":"news"}', envelopeInvalid: false }] }],
  ['unknown name', candidate('{"mode":"browse","query":"news"}', 'calendar_tool')],
  ['duplicate batch', { ...candidate('{"mode":"browse","query":"news"}'),
    calls: [
      { index: 0, id: 'web_call_1', type: 'function', name: 'web_tool',
        arguments: '{"mode":"browse","query":"news"}', envelopeInvalid: false },
      { index: 1, id: 'web_call_2', type: 'function', name: 'web_tool',
        arguments: '{"mode":"browse","query":"other"}', envelopeInvalid: false },
    ] }],
  ['wrong finish marker', { ...candidate('{"mode":"browse","query":"news"}'), terminal: 'stop' }],
])('rejects a structurally invalid web batch: %s', (_, batch) => {
  expect(validateWebCandidate(batch, true).kind).toBe('web-invalid');
});

it('classifies a stale unadvertised web call as a closed denial without repair', () => {
  const decision = validateWebCandidate(candidate('{"mode":"browse","query":"news"}'), false);
  expect(decision).toMatchObject({ kind: 'web-denied',
    result: { ok: false, error: { code: 'WEB_DISABLED', retryable: false } } });
});

it('keeps repair feedback free of raw argument values and credentials', () => {
  const feedback = webRepairFeedback(['url:invalid', 'query:required']);
  expect(feedback).not.toContain('SECRET');
  expect(JSON.parse(feedback)).toMatchObject({
    code: 'WEB_SCHEMA_INVALID', errors: ['url:invalid', 'query:required'],
    expectedSchema: WEB_TOOL_PARAMETERS,
  });
});

it('binds reasoning effort and verified output cap on web-native requests and rejects invalid caps', async () => {
  const base = config();
  const c = { ...base, openRouter: { ...base.openRouter, reasoningEffort: 'low' as const }, sessionId: 'sess_fixture' };
  const l = { ...limits, supportsMaxTokens: false, outputCapParameter: 'max_completion_tokens' as const };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(FRAMES.normal));
  const port = createWebNativeModelPort(c, l, fetcher);
  const req = {
    modelId: c.openRouter.modelId,
    user: c.identity.userId,
    dataCollection: 'deny' as const,
    advertised: true,
    messages: [{ role: 'user' as const, content: 'Search news' }],
    tools: [],
    maxOutputTokens: 512,
    remainingContextTokens: 8192,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    signal: new AbortController().signal,
  };
  for await (const _chunk of port.stream(req)) { /* consume */ }
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
  expect(body.reasoning).toEqual({ effort: 'low', exclude: true });
  expect(body.max_completion_tokens).toBe(512);
  expect(body.max_tokens).toBeUndefined();

  const badPort = createWebNativeModelPort(c, { ...limits, supportsMaxTokens: false }, fetcher);
  await expect(async () => {
    for await (const _chunk of badPort.stream(req)) { /* consume */ }
  }).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
});

it('validates get_environment candidates, denies unadvertised calls, and emits bounded repair feedback', () => {
  expect(
    validateEnvironmentCandidate(
      candidate('{"include":["datetime","weather"],"location":"London","units":"metric"}', 'get_environment'),
      true,
    ),
  ).toMatchObject({
    kind: 'get_environment',
    envelope: { include: ['datetime', 'weather'], location: 'London', units: 'metric' },
  });
  expect(
    validateEnvironmentCandidate(candidate('{"include":[]}', 'get_environment'), true),
  ).toMatchObject({ kind: 'env-invalid', diagnostics: ['include:required'] });
  expect(
    validateEnvironmentCandidate(candidate('{"include":["datetime"]}', 'get_environment'), false),
  ).toMatchObject({ kind: 'env-denied' });
  const feedback = environmentRepairFeedback(['include:required']);
  expect(feedback).toContain('ENV_SCHEMA_INVALID');
  expect(feedback).toContain(JSON.stringify(GET_ENVIRONMENT_PARAMETERS));
  expect(feedback.length).toBeLessThanOrEqual(2000);
});
