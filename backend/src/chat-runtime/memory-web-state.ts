/**
 * ============================================================================
 * FILE: memory-web-state.ts
 * LOCATION: backend/src/chat-runtime/memory-web-state.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define strict, bounded, data-only web evidence for one accepted turn.
 *
 * ROLE IN PROJECT:
 *    Gives the shared text/voice runtime one complete native group shape,
 *    finite counters, bounded projections, and an archive schema without
 *    holding credentials, repositories, or provider objects.
 *
 * KEY COMPONENTS:
 *    - WebNativeCall / WebToolGroup: One complete native call/result group.
 *    - MemoryWebState: Counters, limits, groups, activities, sources, dispatches.
 *    - webEvidenceBytes / projectWebSources: Bounded projection helpers.
 * ============================================================================
 */

import { z } from 'zod';
import { idSchema, isoDateSchema } from '../contracts/identifiers.js';
import {
  DEFAULT_WEB_SEARCH_LIMITS,
  WEB_SEARCH_POLICY,
  type WebSearchLimits,
} from '../contracts/web-search-policy.js';
import {
  webSearchActivitySchema, webSourceReferenceSchema,
  type WebSearchActivity, type WebSourceReference,
} from '../contracts/web-search-wire.js';

export const WEB_GROUP_LIMITS = Object.freeze({
  argumentBytes: WEB_SEARCH_POLICY.argumentBytes,
  resultBytes: WEB_SEARCH_POLICY.maxFetchResultBytes,
  maxGroups: 20,
  maxEvidenceBytes: WEB_SEARCH_POLICY.maxTurnWebEvidenceBytes,
});

export type WebNativeCall = Readonly<{
  id: string; type: 'function';
  function: Readonly<{ name: 'web_tool'; arguments: string }>;
}>;
export type WebToolGroup = Readonly<{
  ordinal: number;
  afterCalendarGroups: number;
  assistant: Readonly<{ role: 'assistant'; content: string | null; tool_calls: readonly [WebNativeCall] }>;
  result: Readonly<{ role: 'tool'; tool_call_id: string; name: 'web_tool'; content: string }>;
  sources: readonly WebSourceReference[];
}>;
export type WebCounters = {
  searchesUsed: number; fetchesUsed: number; schemaRepairsUsed: number;
  modelAttemptsUsed: number; evidenceBytes: number;
};
export type MemoryWebState = {
  schemaVersion: 1; userId: string; sessionId: string; turnId: string;
  acceptedAtMonotonic: number; runDeadlineAt: number; webDeadlineAt: number;
  limits: WebSearchLimits; advertised: boolean;
  counters: WebCounters;
  groups: WebToolGroup[];
  activities: WebSearchActivity[];
  sources: WebSourceReference[];
  dispatches: readonly unknown[];
};

export const webNativeCallSchema = z.object({
  id: idSchema, type: z.literal('function'),
  function: z.object({
    name: z.literal('web_tool'),
    arguments: z.string().min(1).max(WEB_GROUP_LIMITS.argumentBytes),
  }).strict(),
}).strict();
export const webToolGroupSchema = z.object({
  ordinal: z.number().int().nonnegative().max(WEB_GROUP_LIMITS.maxGroups - 1),
  afterCalendarGroups: z.number().int().nonnegative().max(64),
  assistant: z.object({
    role: z.literal('assistant'), content: z.string().max(32_000).nullable(),
    tool_calls: z.tuple([webNativeCallSchema]),
  }).strict(),
  result: z.object({
    role: z.literal('tool'), tool_call_id: idSchema, name: z.literal('web_tool'),
    content: z.string().min(1).max(WEB_GROUP_LIMITS.resultBytes),
  }).strict(),
  sources: z.array(webSourceReferenceSchema).max(WEB_SEARCH_POLICY.maxSourcesPerMessage),
}).strict().refine(v => v.result.tool_call_id === v.assistant.tool_calls[0].id
  && v.sources.every(s => s.toolCallId === v.result.tool_call_id));
export const webCountersSchema = z.object({
  searchesUsed: z.number().int().min(0).max(20),
  fetchesUsed: z.number().int().min(0).max(20),
  schemaRepairsUsed: z.number().int().min(0).max(3),
  modelAttemptsUsed: z.number().int().min(0).max(45),
  evidenceBytes: z.number().int().min(0).max(WEB_GROUP_LIMITS.maxEvidenceBytes),
}).strict();
export const memoryWebStateSchema = z.object({
  schemaVersion: z.literal(1), userId: idSchema, sessionId: idSchema, turnId: idSchema,
  acceptedAtMonotonic: z.number().finite().nonnegative(),
  runDeadlineAt: z.number().finite().nonnegative(),
  webDeadlineAt: z.number().finite().nonnegative(),
  limits: z.object({
    maxSearchesPerTurn: z.number().int().min(1).max(20),
    maxFetchesPerTurn: z.number().int().min(1).max(20),
  }).strict(),
  advertised: z.boolean(),
  counters: webCountersSchema,
  groups: z.array(webToolGroupSchema).max(WEB_GROUP_LIMITS.maxGroups),
  activities: z.array(webSearchActivitySchema).max(WEB_SEARCH_POLICY.maxActivitiesPerMessage),
  sources: z.array(webSourceReferenceSchema).max(WEB_SEARCH_POLICY.maxSourcesPerMessage),
  dispatches: z.array(z.unknown()).max(45),
}).strict().refine(v => v.webDeadlineAt <= v.runDeadlineAt
  && new Set(v.groups.map(g => g.ordinal)).size === v.groups.length
  && new Set(v.groups.map(g => g.assistant.tool_calls[0].id)).size === v.groups.length
  && new Set(v.sources.map(s => s.sourceId)).size === v.sources.length
  && new Set(v.activities.map(a => a.toolCallId)).size === v.activities.length);

export function initialWebCounters(): WebCounters {
  return { searchesUsed: 0, fetchesUsed: 0, schemaRepairsUsed: 0, modelAttemptsUsed: 0, evidenceBytes: 0 };
}
export function webLimits(limits?: Partial<WebSearchLimits> | null): WebSearchLimits {
  return Object.freeze({
    maxSearchesPerTurn: limits?.maxSearchesPerTurn ?? DEFAULT_WEB_SEARCH_LIMITS.maxSearchesPerTurn,
    maxFetchesPerTurn: limits?.maxFetchesPerTurn ?? DEFAULT_WEB_SEARCH_LIMITS.maxFetchesPerTurn,
  });
}
export function webEvidenceBytes(state: Pick<MemoryWebState, 'groups' | 'activities' | 'sources'>): number {
  return Buffer.byteLength(JSON.stringify({
    groups: state.groups, activities: state.activities, sources: state.sources,
  }), 'utf8');
}
/** Keep the latest activity per tool call within the bounded projection. */
export function projectWebActivities(input: readonly WebSearchActivity[]): WebSearchActivity[] {
  const latest = new Map<string, WebSearchActivity>();
  for (const activity of input) latest.set(activity.toolCallId, activity);
  const out = [...latest.values()].slice(-WEB_SEARCH_POLICY.maxActivitiesPerMessage);
  while (out.length > 0 && Buffer.byteLength(JSON.stringify(out), 'utf8')
    > WEB_SEARCH_POLICY.maxActivityProjectionBytes) out.shift();
  return out;
}
/** Cumulative bounded successful source references, newest last. */
export function projectWebSources(input: readonly WebSourceReference[]): WebSourceReference[] {
  const seen = new Set<string>();
  const out: WebSourceReference[] = [];
  for (const source of input) {
    if (seen.has(source.sourceId)) continue;
    seen.add(source.sourceId);
    out.push(source);
  }
  const bounded = out.slice(-WEB_SEARCH_POLICY.maxSourcesPerMessage);
  while (bounded.length > 0 && Buffer.byteLength(JSON.stringify(bounded), 'utf8')
    > WEB_SEARCH_POLICY.maxSourceProvenanceBytes) bounded.shift();
  return bounded;
}
export const webEvidenceRecordSchema = z.object({
  webSources: z.array(webSourceReferenceSchema).max(WEB_SEARCH_POLICY.maxSourcesPerMessage).optional(),
  webActivities: z.array(webSearchActivitySchema).max(WEB_SEARCH_POLICY.maxActivitiesPerMessage).optional(),
}).strict();
export type WebEvidenceRecord = z.infer<typeof webEvidenceRecordSchema>;
export const webProjection = (sources: readonly WebSourceReference[],
  activities: readonly WebSearchActivity[]): WebEvidenceRecord => ({
  ...(sources.length ? { webSources: projectWebSources(sources) } : {}),
  ...(activities.length ? { webActivities: projectWebActivities(activities) } : {}),
});
export const webRetrievedAt = (value: Date): string => isoDateSchema.parse(value.toISOString());
