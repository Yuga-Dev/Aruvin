/**
 * ============================================================================
 * FILE: memory-web-records.ts
 * LOCATION: backend/src/persistence/memory-web-records.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define and read one bounded web-evidence metadata record per attempt.
 *
 * ROLE IN PROJECT:
 *    Carries complete native web groups and counters through the existing
 *    terminal save; it never stores credentials, pages, or provider objects.
 *
 * KEY COMPONENTS:
 *    - memoryWebRecordSchema: Strict bounded archive record.
 *    - memoryWebRecordId: Deterministic owner/session/attempt identity.
 *    - readMemoryWebRecords: Bounded selected-attempt hydration.
 * ============================================================================
 */

import { z } from 'zod';
import { idSchema } from '../contracts/identifiers.js';
import { WEB_SEARCH_POLICY } from '../contracts/web-search-policy.js';
import type { RecordStore } from './store.js';
import { key } from './records.js';
import {
  memoryWebStateSchema, webToolGroupSchema,
} from '../chat-runtime/memory-web-state.js';

export const memoryWebRecordSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('memory-web-native'),
  userId: idSchema, sessionId: idSchema, turnId: idSchema, attemptId: idSchema,
  epoch: idSchema, version: z.number().int().nonnegative(), fence: z.number().int().nonnegative(),
  state: memoryWebStateSchema,
  groups: z.array(webToolGroupSchema).max(20),
}).strict().refine(v => v.state.userId === v.userId && v.state.sessionId === v.sessionId
  && v.state.turnId === v.turnId
  && Buffer.byteLength(JSON.stringify(v), 'utf8') <= WEB_SEARCH_POLICY.maxTurnWebEvidenceBytes);
export type MemoryWebRecord = z.infer<typeof memoryWebRecordSchema>;

export function memoryWebRecordId(userId: string, sessionId: string, attemptId: string): string {
  return key('memory-web-native', userId, sessionId, attemptId);
}

/** Read only the bounded records for the selected attempts; no inference. */
export async function readMemoryWebRecords(
  store: Pick<RecordStore, 'read'>,
  userId: string,
  sessionId: string,
  attemptIds: readonly string[],
): Promise<MemoryWebRecord[]> {
  const out: MemoryWebRecord[] = [];
  for (const attemptId of attemptIds.slice(0, 32)) {
    const record = await store.read('metadata', memoryWebRecordSchema, {
      _id: memoryWebRecordId(userId, sessionId, attemptId),
      userId, sessionId, kind: 'memory-web-native',
    });
    if (record && record.attemptId === attemptId) out.push(record);
  }
  return out;
}
