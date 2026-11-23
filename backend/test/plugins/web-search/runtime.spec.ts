/**
 * ============================================================================
 * FILE: runtime.spec.ts
 * LOCATION: backend/test/plugins/web-search/runtime.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the small execution port, tickets, and ordered bounded fallback.
 *
 * ROLE IN PROJECT:
 *    Proves one attempt per eligible provider, no fan-out, no anonymous
 *    fallback, nested deadlines, and no late publish after revocation.
 *
 * KEY COMPONENTS:
 *    - Fixed-priority fallback and provider-call accounting.
 *    - Unsafe input, off/cancel/deadline, missing session, mode filtering.
 *    - Held-result disable/disconnect races and TinyFish OAuth success.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import {
  WEB_CREDENTIALS_INVALID_MESSAGE, webToolResultSchema,
} from '../../../src/contracts/web-search-tools.js';
import { runtimeFixture } from './fixtures.js';

it('tries each eligible connected provider once in fixed order without fan-out', async () => {
  const f = runtimeFixture();
  await f.connect(['firecrawl', 'exa', 'keenable', 'tavily']);
  f.failProvider('keenable', 'WEB_PROVIDER_RATE_LIMITED');
  f.failProvider('exa', 'WEB_UNUSABLE_RESULT');
  const result = await f.call({ mode: 'browse', query: 'example' });
  expect(f.providerCalls()).toEqual(['keenable', 'exa', 'tavily']);
  expect(result).toMatchObject({ ok: true, provider: 'tavily' });
  expect(f.maxConcurrentProviderCalls()).toBe(1);
  expect(f.storageCallsSincePrepared()).toBe(0);
  expect(webToolResultSchema.safeParse(result).success).toBe(true);
});

it('never falls back anonymously when all connected providers fail', async () => {
  const f = runtimeFixture();
  await f.connect(['exa']);
  f.failProvider('exa', 'WEB_PROVIDER_AUTH');
  expect(await f.call({ mode: 'browse', query: 'example' })).toMatchObject({
    ok: false, error: { code: 'WEB_PROVIDER_AUTH', retryable: false },
  });
  expect(f.providerCalls()).toEqual(['exa']);
  expect(f.anyAnonymousRequest()).toBe(false);
});

it('skips a rejected primary on subsequent searches and uses the backup', async () => {
  const f = runtimeFixture();
  await f.connect(['tavily', 'exa']);
  f.failProvider('exa', 'WEB_PROVIDER_AUTH');
  expect(await f.call({ mode: 'browse', query: 'example' }))
    .toMatchObject({ ok: true, provider: 'tavily' });
  expect(await f.call({ mode: 'browse', query: 'another example' }))
    .toMatchObject({ ok: true, provider: 'tavily' });
  expect(f.providerCalls()).toEqual(['exa', 'tavily', 'tavily']);
});

it.each([
  ['WEB_PROVIDER_AUTH', 'WEB_PROVIDER_AUTH'],
  ['WEB_PROVIDER_TIMEOUT', 'WEB_PROVIDERS_EXHAUSTED'],
] as const)('classifies a rejected primary followed by %s', async (backup, terminal) => {
  const f = runtimeFixture();
  await f.connect(['tavily', 'exa']);
  f.failProvider('exa', 'WEB_PROVIDER_AUTH');
  f.failProvider('tavily', backup);
  expect(await f.call({ mode: 'browse', query: 'example' }))
    .toMatchObject({ ok: false, error: { code: terminal } });
  expect(f.providerCalls()).toEqual(['exa', 'tavily']);
});

it('returns the fixed reconnect message without a provider call once every saved key is rejected', async () => {
  const f = runtimeFixture();
  await f.connect(['exa']);
  f.failProvider('exa', 'WEB_PROVIDER_AUTH');
  await f.call({ mode: 'browse', query: 'example' });
  const before = f.providerCalls().length;
  const validated = await f.validate({ mode: 'browse', query: 'again' });
  expect(validated).toMatchObject({
    ok: false,
    error: { code: 'WEB_PROVIDER_AUTH', retryable: false },
    message: WEB_CREDENTIALS_INVALID_MESSAGE,
  });
  expect(webToolResultSchema.safeParse(validated).success).toBe(true);
  expect(f.providerCalls()).toHaveLength(before);
  expect(f.activities.at(-1)).toMatchObject({
    phase: 'failed', provider: null, code: 'WEB_PROVIDER_AUTH',
  });
  expect(f.connections.snapshot('u_a')).toMatchObject({
    providers: [], credentialsRejected: true,
  });
});

it('exhausts all five slots in fixed priority order', async () => {
  const f = runtimeFixture();
  await f.connect(['tavily', 'firecrawl', 'exa', 'keenable']);
  for (const provider of ['keenable', 'exa', 'tavily', 'firecrawl'] as const) {
    f.failProvider(provider, 'WEB_PROVIDER_UNAVAILABLE');
  }
  expect(await f.call({ mode: 'browse', query: 'example' })).toMatchObject({
    ok: false, error: { code: 'WEB_PROVIDERS_EXHAUSTED' },
  });
  expect(f.providerCalls()).toEqual(['keenable', 'exa', 'tavily', 'firecrawl']);
});

it('skips a missing session and requests maintenance without discovery', async () => {
  const f = runtimeFixture();
  await f.connect(['exa']);
  const validated = await f.validate({ mode: 'browse', query: 'example' });
  if ('ok' in validated) throw new Error('expected a ticket');
  f.dropSession('exa');
  const before = f.prepares();
  expect(await f.execute(validated)).toMatchObject({
    ok: false, error: { code: 'WEB_PROVIDERS_EXHAUSTED' },
  });
  expect(f.providerCalls()).toEqual([]);
  expect(f.prepares()).toBe(before);
});

it('filters by mode capability and rejects unsafe fetch input before dispatch', async () => {
  const browseOnly = runtimeFixture();
  await browseOnly.installOAuth('exa', { browse: true, fetch: false });
  expect(await browseOnly.call({ mode: 'fetch', url: 'https://example.com/page' })).toMatchObject({
    ok: false, error: { code: 'WEB_CONNECTION_REQUIRED' },
  });
  expect(browseOnly.providerCalls()).toEqual([]);

  const unsafe = runtimeFixture();
  await unsafe.installOAuth('exa', { browse: true, fetch: true });
  expect(await unsafe.call({ mode: 'fetch', url: 'http://127.0.0.1/' })).toMatchObject({
    ok: false, error: { code: 'WEB_URL_UNSAFE' },
  });
  expect(unsafe.providerCalls()).toEqual([]);
});

it('does not fall back for disabled, cancelled, or expired calls', async () => {
  const disabled = runtimeFixture();
  await disabled.connect(['exa']);
  await disabled.disable();
  expect(await disabled.call({ mode: 'browse', query: 'example' })).toMatchObject({
    ok: false, error: { code: 'WEB_DISABLED' },
  });
  expect(disabled.providerCalls()).toEqual([]);

  const cancelled = runtimeFixture();
  await cancelled.connect(['exa']);
  cancelled.abort();
  expect(await cancelled.call({ mode: 'browse', query: 'example' })).toMatchObject({
    ok: false, error: { code: 'WEB_CANCELLED' },
  });
  expect(cancelled.providerCalls()).toEqual([]);

  const expired = runtimeFixture();
  await expired.connect(['exa']);
  expired.setWebDeadline(performance.now());
  expect(await expired.call({ mode: 'browse', query: 'example' })).toMatchObject({
    ok: false, error: { code: 'WEB_DEADLINE_EXCEEDED' },
  });
  expect(expired.providerCalls()).toEqual([]);
});

it('bounds each provider slot by twelve seconds within the logical call', async () => {
  const f = runtimeFixture();
  await f.connect(['exa']);
  const held = f.holdProvider('exa');
  const started = performance.now();
  const pending = f.call({ mode: 'browse', query: 'example' });
  await held.entered;
  const deadline = f.lastDeadline('exa')!;
  expect(deadline).toBeLessThanOrEqual(started + 12_000 + 50);
  expect(deadline).toBeLessThanOrEqual(started + 25_000 + 50);
  held.release();
  expect((await pending).ok).toBe(true);
});

it('makes one call per provider without an auth refresh or replay', async () => {
  const f = runtimeFixture();
  await f.connect(['exa', 'tavily']);
  f.failProvider('exa', 'WEB_PROVIDER_AUTH');
  const before = f.prepares();
  const result = await f.call({ mode: 'browse', query: 'example' });
  expect(result).toMatchObject({ ok: true, provider: 'tavily' });
  expect(f.providerCalls()).toEqual(['exa', 'tavily']);
  expect(f.prepares()).toBe(before);
});

it('rejects a ticket reused under another owner or turn', async () => {
  const f = runtimeFixture();
  await f.connect(['exa']);
  const validated = await f.validate({ mode: 'browse', query: 'example' });
  if ('ok' in validated) throw new Error('expected a ticket');
  const other = { ...f.context, turnId: 'turn_2' };
  expect(await f.execute(validated, other)).toMatchObject({
    ok: false, error: { code: 'WEB_INTERRUPTED' },
  });
  expect(f.providerCalls()).toEqual([]);
});

it('publishes no completed activity after a held result is disabled', async () => {
  const f = runtimeFixture();
  await f.connect(['exa']);
  const held = f.holdProvider('exa');
  const pending = f.call({ mode: 'browse', query: 'example' });
  await held.entered;
  await f.disable();
  held.release();
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(f.activities.some(activity => activity.phase === 'completed')).toBe(false);
});

it('publishes no completed activity after a held result is disconnected', async () => {
  const f = runtimeFixture();
  await f.connect(['exa']);
  const held = f.holdProvider('exa');
  const pending = f.call({ mode: 'browse', query: 'example' });
  await held.entered;
  await f.disconnect('exa');
  held.release();
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(f.activities.some(activity => activity.phase === 'completed')).toBe(false);
});

it('runs a fixture-authorized TinyFish OAuth browse at the top priority', async () => {
  const f = runtimeFixture();
  await f.installOAuth('tinyfish');
  const result = await f.call({ mode: 'browse', query: 'example' });
  expect(result).toMatchObject({ ok: true, provider: 'tinyfish', mode: 'browse' });
  expect(f.providerCalls()).toEqual(['tinyfish']);
});

it('emits searching and completed activity for a successful call', async () => {
  const f = runtimeFixture();
  await f.connect(['exa']);
  await f.call({ mode: 'browse', query: 'example' });
  expect(f.activities.map(activity => activity.phase)).toEqual(['searching', 'completed']);
  expect(f.activities.every(activity => activity.toolCallId === 'call_1')).toBe(true);
});
