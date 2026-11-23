/**
 * ============================================================================
 * FILE: corpus.test.ts
 * LOCATION: benchmarks/voice-architectures/shared/__tests__/corpus.test.ts
 * PURPOSE: Reject altered PCM and incorrect speech-end markers.
 * ROLE IN PROJECT: Offline corpus format/hash contract for every candidate.
 * KEY COMPONENTS: Byte alignment; exact last nonzero sample; six roles.
 * ============================================================================
 */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { validateAudio, utterances } from '../corpus.js';
it('validates exact 16 kHz mono PCM16 and trailing silence', () => {
  const pcm = Buffer.alloc(66560); pcm.writeInt16LE(50, 2);
  const hash = createHash('sha256').update(pcm).digest('hex');
  expect(validateAudio(pcm, hash, 2 / 16)).toBe(2080);
  expect(() => validateAudio(pcm, '0'.repeat(64), 2 / 16)).toThrow('CORPUS_INVALID');
  expect(() => validateAudio(pcm, hash, 0)).toThrow('CORPUS_INVALID');
  expect(utterances).toHaveLength(6);
  expect(utterances[3]).toEqual(['Wait', 'why do clouds look white?']);
});
