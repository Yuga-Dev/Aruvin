/**
 * ============================================================================
 * FILE: budget-guard.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/budget-guard.test.ts
 * PURPOSE: Deny paid traffic before any uncertain or exceeded reservation.
 * ROLE IN PROJECT: Deterministic aggregate envelope and egress safety check.
 * KEY COMPONENTS: Dynamic catalogue; one lease; six turns; zero automatic retry.
 * ============================================================================
 */
import { expect, it, vi } from 'vitest';
import { BudgetGuard, priceEnvelope, readRates } from '../budget-guard.js';
const rates = { prompt: .0000005, completion: .0000025, request: 0 };
const policy = { modelId: 'vendor/example', userId: 'synthetic-user',
  maxContextTokens: 45000, maxOutputTokens: 1024, modelMarginTokens: 1024,
  region: 'us' as const, sttModel: 'flux-general-en', ttsModel: 'flux-haley-en',
  outputParameter: 'max_tokens' as const, expiresAtMs: Date.now() + 900000 };
it('reserves the whole envelope with LiveKit buffer and margin', () => {
  expect(priceEnvelope(rates, 45000, 1024)).toBe(1.710038);
  expect(() => new BudgetGuard(policy, { prompt: 1, completion: 1, request: 1 }))
    .toThrow('BUDGET_ENVELOPE_EXCEEDED');
  expect(() => readRates({ pricing: { prompt: '-1', completion: '0' } }))
    .toThrow('MODEL_PRICING_UNPROVEN');
  expect(readRates({ pricing: { prompt: '0.1', completion: '0.2', request: '0',
    pricing_overrides: [{ min_prompt_tokens: 1000, pricing: { prompt: '0.3', completion: '0.4' } }] } }))
    .toEqual({ prompt: .3, completion: .4, request: 0 });
});
it('cannot transfer a blocked candidate allowance or overlap candidates', () => {
  const guard = new BudgetGuard(policy, rates);
  const close = guard.openCandidate('aurvin');
  expect(() => guard.openCandidate('livekit-agents')).toThrow('LIVE_CONCURRENCY_DENIED');
  for (let i = 0; i < 6; i++) guard.submitTurn('aurvin', i);
  expect(() => guard.submitTurn('aurvin', 5)).toThrow('TURN_ALREADY_SUBMITTED');
  expect(() => guard.submitTurn('aurvin', 6)).toThrow('TURN_LIMIT');
  close(); guard.stop();
});
it('sends at most once, counts failures, and rejects changed attribution before fetch', async () => {
  const guard = new BudgetGuard(policy, rates); const close = guard.openCandidate('aurvin');
  guard.submitTurn('aurvin', 0);
  const network = vi.fn<typeof fetch>().mockRejectedValue(Error('fixture-network'));
  const guarded = guard.fetch(network);
  const body = { model: policy.modelId, user: policy.userId,
    messages: [{ role: 'user', content: 'Synthetic hello' }], max_tokens: 1024 };
  await expect(guarded('https://openrouter.ai/api/v1/chat/completions',
    { method: 'POST', body: JSON.stringify({ ...body, user: 'other' }) })).rejects.toThrow('EGRESS_POLICY_DENIED');
  expect(network).not.toHaveBeenCalled();
  // A policy denial stops this run; test a fresh authorized fixture, not a live retry.
  close(); guard.stop();
  const second = new BudgetGuard(policy, rates); second.openCandidate('aurvin'); second.submitTurn('aurvin', 0);
  const send = second.fetch(network);
  await expect(send('https://openrouter.ai/api/v1/chat/completions',
    { method: 'POST', body: JSON.stringify(body) })).rejects.toThrow('fixture-network');
  await expect(send('https://openrouter.ai/api/v1/chat/completions',
    { method: 'POST', body: JSON.stringify(body) })).rejects.toThrow('MODEL_ATTEMPT_LIMIT');
  expect(network).toHaveBeenCalledTimes(1);
  second.stop();
  const isolated = new BudgetGuard(policy, rates);
  const net2 = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
  const closeLk = isolated.openCandidate('livekit-agents');
  isolated.submitTurn('livekit-agents', 3);
  await isolated.fetch(net2)('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  await expect(isolated.fetch(net2)('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) }))
    .rejects.toThrow('MODEL_ATTEMPT_LIMIT');
  expect(isolated.signal.aborted).toBe(false);
  closeLk();
  const closeDg = isolated.openCandidate('deepgram-agent');
  isolated.submitTurn('deepgram-agent', 0);
  closeDg();
  isolated.stop();
});
it('expires at the exact time and rejects bytes before writing them', () => {
  let now = 0; const guard = new BudgetGuard(policy, rates, { now: () => now });
  guard.openCandidate('livekit-agents');
  guard.speechSend('stt', new Uint8Array(150000 * 32));
  expect(() => guard.speechSend('stt', new Uint8Array(2))).toThrow('SPEECH_LIMIT');
  const other = new BudgetGuard(policy, rates, { now: () => now }); other.openCandidate('aurvin');
  now = 300000;
  expect(() => other.submitTurn('aurvin', 0)).toThrow('ACTIVE_TIME_LIMIT');
  guard.stop(); other.stop();
});
it('allows only exact Aurvin skill tools for aurvin and blocks tools on other candidates', async () => {
  const tools = [{ type: 'function', function: { name: 'control_canvas', parameters: { type: 'object' } } }];
  const aurvinGuard = new BudgetGuard({ ...policy, allowedAurvinToolsJson: JSON.stringify(tools) }, rates);
  aurvinGuard.openCandidate('aurvin'); aurvinGuard.submitTurn('aurvin', 0);
  const network = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
  const baseBody = { model: policy.modelId, user: policy.userId,
    messages: [{ role: 'user', content: 'Hello' }], max_tokens: 1024 };
  await expect(aurvinGuard.fetch(network)('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ ...baseBody, tools, parallel_tool_calls: false }) })).resolves.toBeInstanceOf(Response);
  expect(network).toHaveBeenCalledTimes(1);
  aurvinGuard.stop();
  const wrongTools = new BudgetGuard({ ...policy, allowedAurvinToolsJson: JSON.stringify(tools) }, rates);
  wrongTools.openCandidate('aurvin'); wrongTools.submitTurn('aurvin', 0);
  await expect(wrongTools.fetch(network)('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ ...baseBody, tools: [{ type: 'function', function: { name: 'calendar_create_event' } }] }) })).rejects.toThrow('EGRESS_POLICY_DENIED');
  wrongTools.stop();
  const lkGuard = new BudgetGuard({ ...policy, allowedAurvinToolsJson: JSON.stringify(tools) }, rates);
  lkGuard.openCandidate('livekit-agents'); lkGuard.submitTurn('livekit-agents', 0);
  await expect(lkGuard.fetch(network)('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ ...baseBody, tools }) })).rejects.toThrow('EGRESS_POLICY_DENIED');
  lkGuard.stop();
});
