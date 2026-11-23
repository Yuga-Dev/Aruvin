/**
 * ============================================================================
 * FILE: web-search-secret-cipher.ts
 * LOCATION: backend/src/platform/crypto/web-search-secret-cipher.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Seal and open web-search credential bundles and PKCE verifiers.
 *
 * ROLE IN PROJECT:
 *    Applies the existing AES-256-GCM/AAD pattern with a web-search domain
 *    binding, without modifying Calendar's cipher or its subject requirement.
 *
 * KEY COMPONENTS:
 *    - WebSearchSecretCipher: Constructor from the shared encryption bootstrap.
 *    - seal/open: Strict envelope, fresh IV, canonical base64, closed failures.
 * ============================================================================
 */

import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import type { EncryptionBootstrap } from '../config/bootstrap-config.js';
import { WebSearchFault } from '../../plugins/web-search/errors.js';
import {
  secretBindingSchema, secretEnvelopeSchema,
  type SecretBinding, type SecretEnvelope,
} from '../../plugins/web-search/types.js';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PKCE = /^[A-Za-z0-9\-._~]{43,128}$/;
const MAX_PLAINTEXT_BYTES = 16_384;

const aad = (binding: SecretBinding) => Buffer.from(JSON.stringify([
  'aurvin', 'web-search', 1, binding.userId, binding.provider, binding.connectionId,
  binding.credentialVersion, binding.tokenKind,
]), 'utf8');

function unavailable(): never {
  throw new WebSearchFault('WEB_ENCRYPTION_UNAVAILABLE');
}

export class WebSearchSecretCipher {
  private readonly key: KeyObject | null;

  constructor(encryption: EncryptionBootstrap) {
    this.key = encryption.status === 'ready'
      ? createSecretKey(Buffer.from(encryption.key))
      : null;
  }

  seal(binding: unknown, plaintext: string): SecretEnvelope {
    return this.guard(() => this.sealBound(secretBindingSchema.parse(binding), plaintext));
  }

  open(binding: unknown, envelope: SecretEnvelope): string {
    return this.guard(() => this.openBound(secretBindingSchema.parse(binding), envelope));
  }

  private guard<T>(run: () => T): T {
    try {
      return run();
    } catch {
      unavailable();
    }
  }

  private requireKey(): KeyObject {
    if (this.key === null) unavailable();
    return this.key;
  }

  private assertPlaintext(binding: SecretBinding, plaintext: string): string {
    if (binding.tokenKind === 'pkce') {
      if (!PKCE.test(plaintext)) unavailable();
      return plaintext;
    }
    const bytes = Buffer.byteLength(plaintext, 'utf8');
    if (bytes < 1 || bytes > MAX_PLAINTEXT_BYTES || /[\u0000-\u001f\u007f]/u.test(plaintext)) {
      unavailable();
    }
    return plaintext;
  }

  private canonical(value: string, expectedBytes?: number): Buffer {
    if (!BASE64.test(value)) unavailable();
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) unavailable();
    if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) unavailable();
    return decoded;
  }

  private sealBound(binding: SecretBinding, plaintext: string): SecretEnvelope {
    const value = this.assertPlaintext(binding, plaintext);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv, { authTagLength: 16 });
    cipher.setAAD(aad(binding));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const envelope = secretEnvelopeSchema.parse({
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
    this.canonical(envelope.iv, 12);
    this.canonical(envelope.tag, 16);
    this.canonical(envelope.ciphertext);
    return envelope;
  }

  private openBound(binding: SecretBinding, envelope: SecretEnvelope): string {
    const parsed = secretEnvelopeSchema.parse(envelope);
    const iv = this.canonical(parsed.iv, 12);
    const tag = this.canonical(parsed.tag, 16);
    const ciphertext = this.canonical(parsed.ciphertext);
    const decipher = createDecipheriv('aes-256-gcm', this.requireKey(), iv, { authTagLength: 16 });
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return this.assertPlaintext(binding, plaintext);
  }
}
