/**
 * ============================================================================
 * FILE: url-safety.spec.ts
 * LOCATION: backend/test/plugins/web-search/url-safety.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify public HTTP(S) target validation before any provider dispatch.
 *
 * ROLE IN PROJECT:
 *    Proves loopback/private/transition addresses, credential URLs, secret
 *    query keys, and unsafe DNS answers fail closed with no local page fetch.
 *
 * KEY COMPONENTS:
 *    - Syntax, port, hostname, and CIDR rejection matrix.
 *    - Abortable bounded DNS lookup and mixed-answer rejection.
 *    - Provider-returned source/final/redirect chain validation.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import {
  assertPublicChain, assertPublicUrl, isPublicAddress,
} from '../../../src/plugins/web-search/url-safety.js';

const options = () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  signal: new AbortController().signal, deadlineAt: performance.now() + 1000,
  nowMs: () => performance.now(),
});

it.each([
  'file:///etc/passwd', 'https://a:b@example.com/', 'http://localhost/',
  'http://127.1/', 'http://2130706433/', 'http://0x7f000001/',
  'http://10.0.0.1/', 'http://100.64.0.1/', 'http://169.254.169.254/',
  'http://192.168.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
  'http://[fe80::1]/', 'http://[fc00::1]/', 'http://intranet/',
  'https://host.internal./', 'https://example.com:3000/', 'https://example.com/?apiKey=secret',
])('rejects unsafe target %s before dispatch', async raw => {
  await expect(assertPublicUrl(raw, options())).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
});

it('rejects mixed public/private DNS answers and permits no local page fetch', async () => {
  const o = options();
  o.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  await expect(assertPublicUrl('https://example.com/', o)).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
  const good = options();
  expect(await assertPublicUrl('https://example.com/', good)).toBe('https://example.com/');
  expect(good.lookup).toHaveBeenCalledTimes(1);
});

it.each([
  'http://0.0.0.0/', 'http://192.0.2.1/', 'http://198.51.100.1/', 'http://203.0.113.1/',
  'http://198.18.0.1/', 'http://224.0.0.1/', 'http://239.255.255.250/', 'http://192.88.99.1/',
  'http://[2001:db8::1]/', 'http://[2002::1]/', 'http://[3fff::1]/', 'http://[ff02::1]/',
  'http://[::]/', 'http://metadata.google.internal/', 'http://foo.localhost/',
  'http://foo.local/', 'http://foo.home.arpa/', 'http://foo.lan/', 'http://foo.test/',
  'http://foo.invalid/', 'http://foo.example/', 'http://foo.onion/',
])('rejects special-use address or hostname %s', async raw => {
  await expect(assertPublicUrl(raw, options())).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
});

it.each([
  'https://example.com\\@evil.com/', 'https://exa mple.com/', 'https://example.com/\n',
  'https://example.com/?exaApiKey=secret', 'https://example.com/?access_token=secret',
  'https://example.com/?code_verifier=secret', 'https://example.com/?client_secret=secret',
  'https://example.com/?authorization=secret', 'ftp://example.com/', 'javascript:alert(1)',
  'https://example.com/#fragment', 'https://example.com:8443/',
])('rejects ambiguous or non-public syntax %s', async raw => {
  await expect(assertPublicUrl(raw, options())).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
});

it('normalizes WHATWG variants and default ports before classification', async () => {
  const o = options();
  expect(await assertPublicUrl('HTTPS://EXAMPLE.COM:443/a?b=1', o)).toBe('https://example.com/a?b=1');
  const http = options();
  expect(await assertPublicUrl('http://example.com:80/', http)).toBe('http://example.com/');
  const unicode = options();
  expect(await assertPublicUrl('https://bücher.example.com/', unicode))
    .toBe('https://xn--bcher-kva.example.com/');
  const trailing = options();
  expect(await assertPublicUrl('https://example.com./', trailing)).toBe('https://example.com./');
});

it('classifies IPv4 and IPv6 without a network request', () => {
  expect(isPublicAddress('93.184.216.34')).toBe(true);
  expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  expect(isPublicAddress('10.0.0.1')).toBe(false);
  expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
  expect(isPublicAddress('2001:db8::1')).toBe(false);
  expect(isPublicAddress('not-an-ip')).toBe(false);
});

it('fails closed on empty, oversized, failed, or mapped DNS answers', async () => {
  const empty = options();
  empty.lookup.mockResolvedValue([]);
  await expect(assertPublicUrl('https://example.com/', empty)).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
  const many = options();
  many.lookup.mockResolvedValue(Array.from({ length: 17 }, () => ({ address: '93.184.216.34', family: 4 })));
  await expect(assertPublicUrl('https://example.com/', many)).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
  const failed = options();
  failed.lookup.mockRejectedValue(new Error('lookup failed'));
  await expect(assertPublicUrl('https://example.com/', failed)).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
  const mapped = options();
  mapped.lookup.mockResolvedValue([{ address: '::ffff:93.184.216.34', family: 6 }]);
  await expect(assertPublicUrl('https://example.com/', mapped)).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
});

it('rejects at the exact deadline and aborts a held lookup', async () => {
  const exact = options();
  exact.deadlineAt = exact.nowMs();
  await expect(assertPublicUrl('https://example.com/', exact)).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
  expect(exact.lookup).not.toHaveBeenCalled();

  const controller = new AbortController();
  const held = options();
  held.signal = controller.signal;
  held.lookup.mockImplementation(() => new Promise(() => undefined));
  const pending = assertPublicUrl('https://example.com/', held);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
});

it('bounds a held lookup by the remaining deadline without waiting one second', async () => {
  const o = options();
  o.deadlineAt = o.nowMs() + 30;
  o.lookup.mockImplementation(() => new Promise(() => undefined));
  const started = performance.now();
  await expect(assertPublicUrl('https://example.com/', o)).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
  expect(performance.now() - started).toBeLessThan(500);
});

it('validates every provider-returned final and redirect-chain URL', async () => {
  const o = options();
  expect(await assertPublicChain(['https://example.com/', 'https://example.org/'], o))
    .toEqual(['https://example.com/', 'https://example.org/']);
  const privateFinal = options();
  await expect(assertPublicChain(['https://example.com/', 'http://10.0.0.1/'], privateFinal))
    .rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
  const redirect = options();
  redirect.lookup.mockImplementation(async (host: string) => host === 'example.com'
    ? [{ address: '93.184.216.34', family: 4 }]
    : [{ address: '127.0.0.1', family: 4 }]);
  await expect(assertPublicChain(['https://example.com/', 'https://redirect.example/'], redirect))
    .rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
});
