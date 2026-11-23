/**
 * ============================================================================
 * FILE: corpus.ts
 * LOCATION: benchmarks/voice-architectures/shared/corpus.ts
 * PURPOSE: Load only hash-validated synthetic six-turn raw PCM.
 * ROLE IN PROJECT: Identical input audio and markers across architecture runs.
 * KEY COMPONENTS: utterances; validateAudio; loadCorpus.
 * ============================================================================
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { scenarios, type CorpusTurn } from './contracts.js';
export const utterances = [
  ['Hello Aurvin, please confirm you can hear me in one short sentence.'],
  ['In two short sentences, explain why the sky looks blue.'],
  ['And in one short sentence, why does it look orange at sunset?'],
  ['Wait', 'why do clouds look white?'],
  ['In four complete sentences, explain how the water cycle moves water from oceans to rain.'],
  ['Stop, just tell me what evaporation means in one sentence.']
] as const;
const manifestSchema = z.object({
  sampleRate: z.literal(16000), channels: z.literal(1), encoding: z.literal('pcm16le'),
  generatorVoice: z.string().min(1), turns: z.array(z.object({
    index: z.number().int().min(0).max(5), file: z.string().regex(/^[0-5]\.pcm$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), speechEndMs: z.number().finite().positive(),
    text: z.string().min(1), hesitationMs: z.number().int().nonnegative()
  }).strict()).length(6)
}).strict();
export function validateAudio(pcm: Uint8Array, expectedHash: string, speechEndMs: number): number {
  const fail = () => { throw Error('CORPUS_INVALID'); };
  if (!pcm.length || pcm.length % 2560 || pcm.length > 320000) fail();
  if (createHash('sha256').update(pcm).digest('hex') !== expectedHash) fail();
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let last = -1;
  for (let i = 0; i < pcm.length / 2; i++) if (view.getInt16(i * 2, true) !== 0) last = i;
  const end = (last + 1) / 16;
  if (last < 0 || end !== speechEndMs || pcm.length / 32 - end < 2000 ||
    pcm.length / 32 - end >= 2080) fail();
  return pcm.length / 32;
}
export async function loadCorpus(directory: string): Promise<CorpusTurn[]> {
  const manifest = manifestSchema.parse(JSON.parse(
    (await readFile(resolve(directory, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, '')));
  const turns: CorpusTurn[] = [];
  for (let index = 0; index < 6; index++) {
    const entry = manifest.turns[index];
    const text = utterances[index].join(index === 3 ? ' [800 ms pause] ' : '');
    if (entry.index !== index || entry.file !== `${index}.pcm` || entry.text !== text ||
      entry.hesitationMs !== (index === 3 ? 800 : 0)) throw Error('CORPUS_INVALID');
    const pcm = await readFile(resolve(directory, entry.file));
    const durationMs = validateAudio(pcm, entry.sha256, entry.speechEndMs);
    if (index === 3) {
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      let zeros = 0, found = false, hadSpeech = false;
      for (let sample = 0; sample < entry.speechEndMs * 16; sample++) {
        if (view.getInt16(sample * 2, true) === 0) { if (hadSpeech) zeros++; }
        else { if (hadSpeech && zeros === 12800) found = true; hadSpeech = true; zeros = 0; }
      }
      if (!found) throw Error('CORPUS_HESITATION_INVALID');
    }
    turns.push({ index, scenario: scenarios[index], text, pcm, sha256: entry.sha256,
      speechEndMs: entry.speechEndMs, durationMs });
  }
  if (turns.reduce((n, turn) => n + turn.durationMs, 0) > 60000) throw Error('CORPUS_AUDIO_CAP');
  return turns;
}
