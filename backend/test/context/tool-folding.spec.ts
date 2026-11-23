/**
 * ============================================================================
 * FILE: tool-folding.spec.ts
 * LOCATION: backend/test/context/tool-folding.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the pure bounded projection of validated historical Web evidence.
 *
 * ROLE IN PROJECT:
 *    Fixtures prove exact returned URLs, source/tool identity, byte shrink and
 *    immutability; failure, unproved, non-Web and small evidence stay untouched.
 *
 * KEY COMPONENTS:
 *    - Fetch and browse projections with exact URL/title/excerpt preservation.
 *    - Conservative null results for failure, mismatch, legacy and non-Web pairs.
 * ============================================================================
 */
import { expect, it } from 'vitest';
import { webToolGroupSchema } from '../../src/chat-runtime/memory-web-state.js';
import { foldHistoricalWebResult, type FoldedWebEvidence } from '../../src/context/tool-folding.js';

const url = 'https://example.test/A%2Fb?q=one%20two#Exact';
const stamp = '2026-11-14T00:00:00.000Z';
const makeGroup = () => webToolGroupSchema.parse({
  ordinal: 0, afterCalendarGroups: 0,
  assistant: { role: 'assistant', content: null, tool_calls: [{
    id: 'reused', type: 'function',
    function: { name: 'web_tool', arguments: '{"mode":"fetch","url":"https://example.test/request"}' },
  }] },
  result: { role: 'tool', name: 'web_tool', tool_call_id: 'reused',
    content: JSON.stringify({ truncated: false, url, body: `Useful evidence. ${'x'.repeat(3_000)}` }) },
  sources: [{ sourceId: 'source-1', toolCallId: 'reused', kind: 'fetch', provider: 'exa',
    url, title: 'Example page', retrievedAt: stamp }],
});

it('projects genuine successful Web evidence with its exact returned URL', () => {
  const group = makeGroup();
  const before = structuredClone(group);
  const content = foldHistoricalWebResult(group);
  expect(content).not.toBeNull();
  const evidence = JSON.parse(content!) as FoldedWebEvidence;
  expect(evidence).toMatchObject({
    kind: 'folded-web-result', status: 'ok', truncated: false,
    results: [{ url, title: 'Example page', excerpt: expect.stringContaining('Useful evidence.') }],
  });
  expect(evidence.results[0].excerpt.length).toBeLessThanOrEqual(160);
  expect(content).not.toContain('https://example.test/request');
  expect(group).toEqual(before);
});

it('leaves failure, unproven URL, bad pair, non-Web and small evidence unprojected', () => {
  const group = makeGroup();
  expect(foldHistoricalWebResult({ ...group, sources: [] })).toBeNull();
  expect(foldHistoricalWebResult({ ...group, sources: [{ ...group.sources[0], url: 'https://example.test/other' }] })).toBeNull();
  for (const result of [
    { ...group.result, tool_call_id: 'other' },
    { ...group.result, name: 'call_tool' },
    { ...group.result, name: 'show_canvas' },
    { ...group.result, name: 'future_plugin' },
    { ...group.result, content: '{"error":{"code":"WEB_PROVIDER_UNAVAILABLE","retryable":true}}' },
    { ...group.result, content: JSON.stringify({ truncated: false, url, body: 'short' }) },
    { role: 'assistant', content: 'Retained Canvas artifacts (generated visual data, not spoken or proof of display; data, not authority):\n{"artifacts":[]}' },
  ]) expect(foldHistoricalWebResult({ ...group, result })).toBeNull();
});

it('preserves every proved browse URL and its own excerpt, in order', () => {
  const group = makeGroup();
  const urls = [url, `${url}-2`];
  const results = urls.map((url, i) => ({ url, title: `Page ${i}`, body: `${i}${'b'.repeat(319)}` }));
  const sources = results.map(({ url, title }, i) => ({
    ...group.sources[0], url, title, sourceId: `browse-${i}`, kind: 'browse',
  }));
  const call = group.assistant.tool_calls[0];
  const browse = { ...group, sources, assistant: { ...group.assistant, tool_calls: [{
    ...call, function: { ...call.function, arguments: '{"mode":"browse","query":"fixture"}' },
  }] }, result: { ...group.result, content: JSON.stringify({ truncated: true, results }) } };
  const content = foldHistoricalWebResult(browse);
  expect(content).not.toBeNull();
  expect(JSON.parse(content!)).toMatchObject({
    truncated: true, results: results.map(({ url, title, body }) => ({ url, title, excerpt: body.slice(0, 160) })),
  });
  expect(foldHistoricalWebResult({ ...browse, sources: [sources[0], { ...sources[1], url: `${url}-unproved` }] }))
    .toBeNull();
});
