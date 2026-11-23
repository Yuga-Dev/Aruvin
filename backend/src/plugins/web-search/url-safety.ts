/**
 * ============================================================================
 * FILE: url-safety.ts
 * LOCATION: backend/src/plugins/web-search/url-safety.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate public HTTP(S) targets and provider-returned URLs before use.
 *
 * ROLE IN PROJECT:
 *    Applies syntax, hostname, CIDR, and bounded DNS checks so model-supplied
 *    and provider-returned URLs cannot reach private or internal destinations.
 *
 * KEY COMPONENTS:
 *    - isPublicAddress: Explicit IPv4/IPv6 CIDR classification with BlockList.
 *    - assertPublicUrl: Canonical public URL or closed WEB_URL_UNSAFE fault.
 *    - assertPublicChain: Same policy for final/redirect-chain URLs.
 * ============================================================================
 */

import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { WebToolFault } from './errors.js';

export type WebLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly { address: string; family: number }[]>;

export type UrlSafetyOptions = {
  lookup?: WebLookup;
  signal: AbortSignal;
  deadlineAt: number;
  nowMs?: () => number;
};

const denied4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) denied4.addSubnet(network, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const denied6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) denied6.addSubnet(network, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied4.check(address, 'ipv4') :
    family === 6 && global6.check(address, 'ipv6') && !denied6.check(address, 'ipv6');
}

const BLOCKED_SUFFIXES = [
  '.localhost', '.local', '.internal', '.home.arpa', '.lan', '.test', '.invalid', '.example', '.onion',
] as const;
const BLOCKED_EXACT = new Set(['localhost', 'metadata.google.internal']);
const SECRET_KEYS = new Set([
  'apikey', 'exaapikey', 'tavilyapikey', 'access_token', 'refresh_token',
  'code_verifier', 'client_secret', 'authorization',
]);
const CONTROL = /[\u0000-\u0020\u007f]/u;
const MAX_URL = 2_048;
const MAX_DNS_ANSWERS = 16;
const DNS_TIMEOUT_MS = 1_000;

function unsafe(): never {
  throw new WebToolFault('WEB_URL_UNSAFE');
}

function parse(raw: string): URL {
  if (raw.length < 1 || raw.length > MAX_URL || CONTROL.test(raw) || raw.includes('\\')) unsafe();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    unsafe();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') unsafe();
  if (url.username !== '' || url.password !== '') unsafe();
  if (url.hash !== '') unsafe();
  if (url.port !== '' && !((url.protocol === 'http:' && url.port === '80')
    || (url.protocol === 'https:' && url.port === '443'))) unsafe();
  for (const key of url.searchParams.keys()) {
    if (SECRET_KEYS.has(key.toLowerCase())) unsafe();
  }
  return url;
}

function assertHostnameSyntax(hostname: string): { host: string; ip: boolean } {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const host = hostname.slice(1, -1);
    if (host.includes('%') || isIP(host) === 0) unsafe();
    return { host, ip: true };
  }
  if (hostname.includes('%') || hostname.includes(':')) unsafe();
  const bare = hostname.replace(/\.+$/, '');
  if (bare.length === 0) unsafe();
  if (isIP(bare) !== 0) return { host: bare, ip: true };
  if (BLOCKED_EXACT.has(bare)) unsafe();
  for (const suffix of BLOCKED_SUFFIXES) {
    if (bare === suffix.slice(1) || bare.endsWith(suffix)) unsafe();
  }
  if (!bare.includes('.')) unsafe();
  return { host: bare, ip: false };
}

async function resolvePublic(host: string, options: UrlSafetyOptions): Promise<void> {
  if (options.signal.aborted) unsafe();
  const nowMs = options.nowMs ?? (() => performance.now());
  const remaining = Math.min(DNS_TIMEOUT_MS, options.deadlineAt - nowMs());
  if (!(remaining > 0)) unsafe();
  const lookup = options.lookup ?? dnsLookup as unknown as WebLookup;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    const answers = await new Promise<readonly { address: string; family: number }[]>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('lookup timeout')), remaining);
      timer.unref?.();
      aborted = () => reject(new Error('lookup aborted'));
      options.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve(lookup(host, { all: true, verbatim: true })).then(resolve, reject);
    });
    if (!Array.isArray(answers) || answers.length < 1 || answers.length > MAX_DNS_ANSWERS) unsafe();
    for (const answer of answers) {
      if (!answer || typeof answer.address !== 'string' || !isPublicAddress(answer.address)) unsafe();
    }
  } catch {
    unsafe();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (aborted !== undefined) options.signal.removeEventListener('abort', aborted);
  }
}

export async function assertPublicUrl(raw: string, options: UrlSafetyOptions): Promise<string> {
  const url = parse(raw);
  const { host, ip } = assertHostnameSyntax(url.hostname);
  if (ip) {
    if (!isPublicAddress(host)) unsafe();
  } else {
    await resolvePublic(host, options);
  }
  return url.toString();
}

export async function assertPublicChain(urls: readonly string[], options: UrlSafetyOptions): Promise<string[]> {
  const canonical: string[] = [];
  for (const url of urls) canonical.push(await assertPublicUrl(url, options));
  return canonical;
}
