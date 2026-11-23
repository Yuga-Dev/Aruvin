/**
 * ============================================================================
 * FILE: web-search-secret-cipher.spec.ts
 * LOCATION: backend/src/platform/crypto/web-search-secret-cipher.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify web-search AES-GCM envelope binding and closed failure behavior.
 *
 * ROLE IN PROJECT:
 *    Proves credentials and PKCE verifiers cannot be opened across owner,
 *    provider, connection, version, or token kind, and never leak plaintext.
 *
 * KEY COMPONENTS:
 *    - AAD binding matrix and fresh-IV checks.
 *    - Malformed/canonical envelope and missing-key rejection.
 *    - PKCE and credential-bundle plaintext bounds.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import { WebSearchSecretCipher } from './web-search-secret-cipher.js';

const binding = {
  userId: 'u_a', provider: 'exa' as const, connectionId: 'conn_a',
  credentialVersion: 1, tokenKind: 'credential-bundle' as const,
};
const cipher = (fill = 7) => new WebSearchSecretCipher({ status: 'ready', key: Buffer.alloc(32, fill) });

function expectUnavailable(run: () => unknown, secret = 'fixture-secret') {
  try {
    run();
    expect.fail('expected web-search encryption to be unavailable');
  } catch (error) {
    expect(error).toMatchObject({ code: 'WEB_ENCRYPTION_UNAVAILABLE' });
    const text = `${String(error)}\n${JSON.stringify(error)}\n${(error as Error).stack ?? ''}`;
    expect(text).not.toContain(secret);
    expect(text.toLowerCase()).not.toContain('bad decrypt');
    expect(text).not.toContain('cause');
  }
}

function flipByte(encoded: string, index = 0): string {
  const buf = Buffer.from(encoded, 'base64');
  buf[index] ^= 0xff;
  return buf.toString('base64');
}

it('binds encrypted credentials to owner provider connection version and kind', () => {
  const secretCipher = cipher();
  const envelope = secretCipher.seal(binding, '{"method":"api-key","apiKey":"fixture-secret"}');
  expect(JSON.stringify(envelope)).not.toContain('fixture-secret');
  expect(secretCipher.open(binding, envelope)).toContain('fixture-secret');
  for (const changed of [{ userId: 'u_b' }, { provider: 'tavily' }, { connectionId: 'conn_b' },
    { credentialVersion: 2 }, { tokenKind: 'pkce' }]) {
    expect(() => secretCipher.open({ ...binding, ...changed } as typeof binding, envelope))
      .toThrow('WEB_ENCRYPTION_UNAVAILABLE');
  }
  expect(secretCipher.seal(binding, 'x').iv).not.toBe(secretCipher.seal(binding, 'x').iv);
});

it('rejects ciphertext, tag, iv, and version tampering', () => {
  const secretCipher = cipher();
  const sealed = secretCipher.seal(binding, '{"method":"api-key","apiKey":"fixture-secret"}');
  expectUnavailable(() => secretCipher.open(binding, { ...sealed, ciphertext: flipByte(sealed.ciphertext) }));
  expectUnavailable(() => secretCipher.open(binding, { ...sealed, tag: flipByte(sealed.tag) }));
  expectUnavailable(() => secretCipher.open(binding, { ...sealed, iv: flipByte(sealed.iv) }));
  expectUnavailable(() => secretCipher.open(binding, { ...sealed, version: 2 as never }));
});

it('rejects malformed and noncanonical base64 envelopes', () => {
  const secretCipher = cipher();
  const sealed = secretCipher.seal(binding, '{"method":"api-key","apiKey":"fixture-secret"}');
  expectUnavailable(() => secretCipher.open(binding, { ...sealed, iv: `${sealed.iv}=` }));
  expectUnavailable(() => secretCipher.open(binding, { ...sealed, tag: `${sealed.tag}*` }));
  expectUnavailable(() => secretCipher.open(binding, { ...sealed, ciphertext: `${sealed.ciphertext}=` }));
  expectUnavailable(() => secretCipher.open(binding, { ...sealed, iv: Buffer.alloc(11).toString('base64') }));
  expectUnavailable(() => secretCipher.open(binding, { ...sealed, tag: Buffer.alloc(15).toString('base64') }));
});

it('rejects missing, invalid, and wrong encryption keys', () => {
  const sealed = cipher(7).seal(binding, '{"method":"api-key","apiKey":"fixture-secret"}');
  expectUnavailable(() => cipher(9).open(binding, sealed));
  expectUnavailable(() => new WebSearchSecretCipher({ status: 'missing' }).seal(binding, 'x'));
  expectUnavailable(() => new WebSearchSecretCipher({ status: 'invalid' }).open(binding, sealed));
});

it('bounds credential plaintext and rejects control characters', () => {
  const secretCipher = cipher();
  expectUnavailable(() => secretCipher.seal(binding, ''));
  expectUnavailable(() => secretCipher.seal(binding, 'x'.repeat(16_385)));
  expectUnavailable(() => secretCipher.seal(binding, 'secret\u0000'));
});

it('binds PKCE verifiers and enforces the URL-safe length range', () => {
  const secretCipher = cipher();
  const pkce = { ...binding, tokenKind: 'pkce' as const };
  const verifier = 'A'.repeat(43);
  const sealed = secretCipher.seal(pkce, verifier);
  expect(secretCipher.open(pkce, sealed)).toBe(verifier);
  expectUnavailable(() => secretCipher.open(binding, sealed), verifier);
  expectUnavailable(() => secretCipher.seal(pkce, 'A'.repeat(42)), 'A'.repeat(42));
  expectUnavailable(() => secretCipher.seal(pkce, 'A'.repeat(129)), 'A'.repeat(129));
  expectUnavailable(() => secretCipher.seal(pkce, `${'A'.repeat(42)}+`), `${'A'.repeat(42)}+`);
});

it('rejects unknown providers and invalid bindings at the AAD schema', () => {
  const secretCipher = cipher();
  const sealed = secretCipher.seal(binding, '{"method":"api-key","apiKey":"fixture-secret"}');
  expectUnavailable(() => secretCipher.open({ ...binding, provider: 'unknown' as never }, sealed));
  expectUnavailable(() => secretCipher.open({ ...binding, connectionId: '' }, sealed));
  expectUnavailable(() => secretCipher.open({ ...binding, credentialVersion: 0 }, sealed));
});
