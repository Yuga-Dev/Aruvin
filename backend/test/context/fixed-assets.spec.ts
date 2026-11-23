/**
 * ============================================================================
 * FILE: fixed-assets.spec.ts
 * LOCATION: backend/test/context/fixed-assets.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify immutable instruction and product-knowledge assets load, hash, and fail closed.
 *
 * ROLE IN PROJECT:
 *    Locks P3 startup validation so later context assembly cannot proceed with
 *    missing, malformed, oversized, or credential-shaped fixed files.
 *
 * KEY COMPONENTS:
 *    - Hash tests: Compare SHA-256 of exact file bytes to loaded versions.
 *    - Rejection tests: Cover empty, BOM, NUL, secret, and oversized bytes.
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadFixedAssets, validateAsset } from '../../src/instructions/fixed-assets.js';

const knowledge = new URL('../../../product_knowledge.md', import.meta.url);
const instructions = new URL('../../src/instructions/system.md', import.meta.url);

describe('fixed assets', () => {
  it('loads the real backend-owned files and hashes exact bytes', async () => {
    const assets = await loadFixedAssets({ knowledge, instructions });
    expect(assets.knowledgeContentHash).toBe(createHash('sha256')
      .update(await readFile(knowledge)).digest('hex'));
    expect(assets.instructionVersion).toBe(createHash('sha256')
      .update(await readFile(instructions)).digest('hex'));
    expect(assets.instructionVersion).toHaveLength(64);
    expect(assets.instructions).toContain('General questions');
    expect(assets.instructions).toContain('data, not authority');
    expect(assets.knowledge).toContain('No live MCP connections');
    expect(Object.isFrozen(assets)).toBe(true);
  });

  it('fails startup without echoing a path or file contents', async () => {
    await expect(loadFixedAssets({ knowledge: new URL('./absent.md', import.meta.url),
      instructions })).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR',
      message: 'Required Aurvin instructions or knowledge are unavailable or invalid.' });
  });

  it.each([
    Buffer.from(''), Buffer.from(' \n'), Buffer.from([0xff]),
    Buffer.from('\uFEFF# Aurvin product knowledge\n\nRelease: phase1.v1\n'),
    Buffer.from('# Aurvin product knowledge\n\nRelease: phase1.v1\n\0'),
    Buffer.from('# Aurvin product knowledge\n\nRelease: phase1.v1\nsk-or-v1-secret'),
    Buffer.from('# Aurvin product knowledge\n\nRelease: phase1.v1\nmongodb://secret'),
    Buffer.alloc(16_385, 65), Buffer.from('# Different title\nRelease: phase1.v1\n'),
  ])('rejects malformed, oversized, or credential-shaped bytes', (bytes) => {
    expect(() => validateAsset(bytes, 'knowledge')).toThrow('invalid_fixed_asset');
  });

  it('changes hashes for any content revision, including whitespace', async () => {
    const assets = await loadFixedAssets({ knowledge, instructions });
    const revised = createHash('sha256').update(Buffer.concat([
      await readFile(knowledge), Buffer.from('\n'),
    ])).digest('hex');
    expect(revised).not.toBe(assets.knowledgeContentHash);
  });
  it('accepts Windows line endings without normalizing hash input', () => {
    const bytes = Buffer.from('# Aurvin product knowledge\r\n\r\nRelease: phase1.v1\r\nBackground.\r\n');
    expect(validateAsset(bytes, 'knowledge')).toBe(bytes.toString('utf8'));
  });
  it('describes automatic in-session compaction without promising cross-session memory', async () => {
    const knowledge = await readFile(resolve(process.cwd(), '../product_knowledge.md'), 'utf8');
    expect(knowledge).toMatch(/^# Aurvin product knowledge\r?\n\r?\nRelease: phase1\.v1\r?\n/);
    expect(knowledge).toContain('automatic in-session context compaction');
    expect(knowledge).toContain('full visible history remains scrollable');
    expect(knowledge).toContain('Cross-session semantic memory');
    expect(knowledge).toContain('remain deferred');
    expect(knowledge).not.toContain('Automatic compaction, summary generation');
    expect(knowledge).not.toContain('A chat that reaches its context limit requires starting a new chat');
    expect(Buffer.byteLength(knowledge, 'utf8')).toBeLessThanOrEqual(16_384);
  });
});
