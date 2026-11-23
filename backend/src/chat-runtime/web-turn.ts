/**
 * ============================================================================
 * FILE: web-turn.ts
 * LOCATION: backend/src/chat-runtime/web-turn.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Own one accepted turn's bounded, read-only web execution and evidence.
 *
 * ROLE IN PROJECT:
 *    Sits between the shared text/voice model loop and P2's secret-free port:
 *    it validates, charges one logical call, executes once, and publishes
 *    bounded activity/source evidence without holding repositories or secrets.
 *
 * KEY COMPONENTS:
 *    - WebTurn: Counters, duplicate-ID reuse, current permission, deadlines.
 *    - execute: Single-use ticket flow with closed failure mapping.
 *    - sourcesFor: Provenance derived from the returned URLs.
 *    - repair/beforeModel: Independent repair and model-attempt budgets.
 *    - freeze/presentation: Data-only archive and presentation projections.
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import type { ResolvedIdentity } from '../contracts/identity.js';
import { WEB_SEARCH_POLICY, webModelAttemptLimit, type WebSearchLimits,
  type WebSearchMode } from '../contracts/web-search-policy.js';
import { webModelContent, webToolResultSchema, type WebToolResult }
  from '../contracts/web-search-tools.js';
import type { WebPresentationEvent, WebSearchActivity, WebSourceReference }
  from '../contracts/web-search-wire.js';
import type { WebCallContext, WebSearchPort }
  from '../plugins/web-search/types.js';
import { sourceTitle } from '../plugins/web-search/results.js';
import {
  initialWebCounters, memoryWebStateSchema, webEvidenceBytes, webLimits, WEB_GROUP_LIMITS,
  projectWebActivities, projectWebSources,
  type MemoryWebState, type WebToolGroup,
} from './memory-web-state.js';
import type { WebDecision } from '../model/web-native.js';
import { webRepairFeedback } from '../model/web-native.js';

type Failure = Extract<WebToolResult, { ok: false }>;
type Success = Extract<WebToolResult, { ok: true }>;

/**
 * Provenance is derived from the returned URLs instead of being carried in the
 * model-facing result, so the model only sees url/title/body.
 */
function sourcesFor(result: Success, turnId: string, toolCallId: string): WebSourceReference[] {
  const entries = result.mode === 'browse'
    ? result.results.map(entry => ({ url: entry.url, title: entry.title }))
    : [{ url: result.url, title: sourceTitle(result.url) }];
  return entries.map(entry => ({
    sourceId: `ws_${createHash('sha256').update(JSON.stringify([
      turnId, toolCallId, result.provider, entry.url,
    ]), 'utf8').digest('hex').slice(0, 40)}`,
    toolCallId, provider: result.provider, kind: result.mode,
    title: entry.title, url: entry.url, retrievedAt: result.retrievedAt,
  }));
}

export type WebExecution =
  | { group: WebToolGroup; reused: boolean }
  | { failure: Failure };
export type WebRepair = {
  retry: boolean; feedback: string;
  code: 'WEB_SCHEMA_INVALID' | 'WEB_SCHEMA_REPAIR_EXHAUSTED' | 'WEB_CONTEXT_LIMIT'
    | 'WEB_DEADLINE_EXCEEDED';
};
export type WebTurnOptions = {
  port: WebSearchPort;
  identity: Readonly<ResolvedIdentity>;
  sessionId: string; turnId: string;
  limits: WebSearchLimits;
  advertised: boolean;
  acceptedAtMonotonic: number;
  runTimeoutMs: number;
  nowMs: () => number;
  signal: AbortSignal;
  present: (event: WebPresentationEvent) => void;
  headroom: (mode: WebSearchMode | null, feedback?: string) => boolean;
};

const TERMINAL = new Set(['WEB_CANCELLED', 'WEB_DEADLINE_EXCEEDED', 'WEB_INTERRUPTED',
  'WEB_DISABLED', 'WEB_CONNECTION_REQUIRED']);

export class WebTurn {
  private readonly port: WebSearchPort;
  private readonly identity: Readonly<ResolvedIdentity>;
  private readonly limits: WebSearchLimits;
  private readonly advertised: boolean;
  private readonly nowMs: () => number;
  private readonly presentEvent: (event: WebPresentationEvent) => void;
  private readonly headroom: WebTurnOptions['headroom'];
  private signal: AbortSignal;
  private readonly state: MemoryWebState;
  private readonly completed = new Map<string, WebToolGroup>();
  private readonly failed = new Map<string, Failure>();
  private readonly latestActivity = new Map<string, WebSearchActivity>();

  constructor(options: WebTurnOptions) {
    this.port = options.port;
    this.identity = options.identity;
    this.limits = webLimits(options.limits);
    this.advertised = options.advertised;
    this.nowMs = options.nowMs;
    this.signal = options.signal;
    this.presentEvent = options.present;
    this.headroom = options.headroom;
    const runDeadlineAt = options.acceptedAtMonotonic + options.runTimeoutMs;
    this.state = {
      schemaVersion: 1, userId: options.identity.userId,
      sessionId: options.sessionId, turnId: options.turnId,
      acceptedAtMonotonic: options.acceptedAtMonotonic,
      runDeadlineAt,
      webDeadlineAt: Math.min(runDeadlineAt,
        options.acceptedAtMonotonic + WEB_SEARCH_POLICY.turnDeadlineMs),
      limits: this.limits, advertised: options.advertised,
      counters: initialWebCounters(), groups: [], activities: [], sources: [], dispatches: [],
    };
  }

  /** Bind the later Work signal; a retry never reuses an aborted signal. */
  bind(signal: AbortSignal): void { this.signal = signal; }

  snapshot(): MemoryWebState {
    return structuredClone(this.state);
  }

  /** Count one actual model HTTP attempt; false means the ceiling is spent. */
  beforeModel(): boolean {
    if (this.state.counters.modelAttemptsUsed >= webModelAttemptLimit(this.limits)) return false;
    this.state.counters.modelAttemptsUsed += 1;
    return true;
  }

  /** Consume one of three schema repairs, or report the binding limit. */
  repair(diagnostics: readonly string[], _call: unknown): WebRepair {
    if (this.state.counters.schemaRepairsUsed >= WEB_SEARCH_POLICY.maxSchemaRepairAttemptsPerTurn) {
      return { retry: false, feedback: '', code: 'WEB_SCHEMA_REPAIR_EXHAUSTED' };
    }
    if (this.signal.aborted) {
      return { retry: false, feedback: '', code: 'WEB_DEADLINE_EXCEEDED' };
    }
    if (this.nowMs() >= this.state.webDeadlineAt) {
      return { retry: false, feedback: '', code: 'WEB_DEADLINE_EXCEEDED' };
    }
    if (this.state.counters.modelAttemptsUsed >= webModelAttemptLimit(this.limits)) {
      return { retry: false, feedback: '', code: 'WEB_SCHEMA_REPAIR_EXHAUSTED' };
    }
    const feedback = webRepairFeedback(diagnostics);
    if (!this.headroom(null, feedback)) {
      return { retry: false, feedback: '', code: 'WEB_CONTEXT_LIMIT' };
    }
    this.state.counters.schemaRepairsUsed += 1;
    return { retry: true, feedback, code: 'WEB_SCHEMA_INVALID' };
  }

  async execute(decision: Extract<WebDecision, { kind: 'web_tool' }>,
    afterCalendarGroups: number): Promise<WebExecution> {
    if (!this.advertised) return { failure: this.failure(decision.args.mode, 'WEB_DISABLED') };
    const existing = this.completed.get(decision.call.id);
    if (existing) {
      return existing.assistant.tool_calls[0].function.arguments === decision.call.function.arguments
        ? { group: existing, reused: true }
        : { failure: this.failure(decision.args.mode, 'WEB_INTERRUPTED') };
    }
    const previousFailure = this.failed.get(decision.call.id);
    if (previousFailure) return { failure: previousFailure };
    const context = this.context(decision.call.id);
    const checked = await this.port.validateInput(decision.args, context);
    if ('ok' in checked) return { failure: checked };
    const blocked = this.blocked(decision.args.mode);
    if (blocked) return { failure: blocked };
    const field = decision.args.mode === 'browse' ? 'searchesUsed' : 'fetchesUsed';
    const limit = decision.args.mode === 'browse'
      ? this.limits.maxSearchesPerTurn : this.limits.maxFetchesPerTurn;
    if (this.state.counters[field] >= limit) {
      return { failure: this.failure(decision.args.mode,
        decision.args.mode === 'browse' ? 'WEB_SEARCH_LIMIT' : 'WEB_FETCH_LIMIT') };
    }
    if (!this.headroom(decision.args.mode)) {
      return { failure: this.failure(decision.args.mode, 'WEB_CONTEXT_LIMIT') };
    }
    this.state.counters[field] += 1;
    let result: WebToolResult;
    try {
      result = await this.port.execute(checked, context);
    } catch {
      return { failure: this.failure(decision.args.mode, 'WEB_PROVIDER_UNAVAILABLE') };
    }
    const confirmedAuthFailure = !result.ok && result.error.code === 'WEB_PROVIDER_AUTH'
      && !result.error.retryable;
    const after = this.blocked(decision.args.mode, !confirmedAuthFailure);
    if (after) return { failure: after };
    const parsed = webToolResultSchema.safeParse(result);
    if (!parsed.success) return { failure: this.failure(decision.args.mode, 'WEB_UNUSABLE_RESULT') };
    if (!parsed.data.ok && parsed.data.error.code === 'WEB_PROVIDER_AUTH'
      && !parsed.data.error.retryable) {
      return { failure: parsed.data };
    }
    const sources = parsed.data.ok
      ? sourcesFor(parsed.data, this.state.turnId, decision.call.id)
      : [];
    const content = webModelContent(parsed.data);
    const group: WebToolGroup = Object.freeze({
      ordinal: this.state.groups.length,
      afterCalendarGroups,
      assistant: Object.freeze({ role: 'assistant' as const,
        content: decision.assistantContent,
        tool_calls: Object.freeze([decision.call]) as unknown as readonly [typeof decision.call] }),
      result: Object.freeze({ role: 'tool' as const, tool_call_id: decision.call.id,
        name: 'web_tool' as const, content }),
      sources: Object.freeze(sources) as readonly WebSourceReference[],
    });
    this.state.groups.push(group);
    this.completed.set(decision.call.id, group);
    if (sources.length) {
      this.state.sources.push(...sources);
      this.state.sources = projectWebSources(this.state.sources);
      this.present({ type: 'web-sources', sources: projectWebSources(this.state.sources) });
    }
    this.state.counters.evidenceBytes = webEvidenceBytes(this.state);
    return { group, reused: false };
  }

  /**
   * Record the exact failure pair the model saw so later turns can replay it.
   * An existing group for the same call id is reused: native history must keep
   * one pair per id. `recorded:false` means the bounded evidence cap rejected
   * it; the caller may still show the pair this turn, but it cannot be
   * reinserted later.
   */
  recordFailure(decision: Extract<WebDecision, { kind: 'web_tool' }>,
    failure: Failure, afterCalendarGroups: number): { group: WebToolGroup; recorded: boolean } {
    const existing = this.state.groups.find(group =>
      group.assistant.tool_calls[0].id === decision.call.id);
    if (existing) return { group: existing, recorded: true };
    const group: WebToolGroup = Object.freeze({
      ordinal: this.state.groups.length,
      afterCalendarGroups,
      assistant: Object.freeze({ role: 'assistant' as const,
        content: decision.assistantContent,
        tool_calls: Object.freeze([decision.call]) as unknown as readonly [typeof decision.call] }),
      result: Object.freeze({ role: 'tool' as const, tool_call_id: decision.call.id,
        name: 'web_tool' as const, content: webModelContent(failure) }),
      sources: Object.freeze([]) as readonly WebSourceReference[],
    });
    // ponytail: per-turn evidence cap bounds replayable failures; a rejected
    // failure pair is still shown this turn but that turn's prefix diverges at
    // this point. Raise maxTurnWebEvidenceBytes or store failures separately
    // only if prefix fidelity for exhausted turns becomes required.
    this.failed.set(decision.call.id, failure);
    if (this.state.groups.length >= WEB_GROUP_LIMITS.maxGroups
      || webEvidenceBytes({ ...this.state, groups: [...this.state.groups, group] })
        > WEB_GROUP_LIMITS.maxEvidenceBytes) return { group, recorded: false };
    this.state.groups.push(group);
    this.state.counters.evidenceBytes = webEvidenceBytes(this.state);
    return { group, recorded: true };
  }

  /** Complete groups already executed for this accepted turn. */
  groups(): readonly WebToolGroup[] { return this.state.groups; }

  /** Cumulative bounded presentation evidence for terminal/replay events. */
  presentation(): { sources: readonly WebSourceReference[]; activities: readonly WebSearchActivity[] } {
    return {
      sources: projectWebSources(this.state.sources),
      activities: projectWebActivities(this.state.activities),
    };
  }

  freeze(): MemoryWebState {
    const projected = memoryWebStateSchema.parse({
      ...this.state,
      activities: projectWebActivities(this.state.activities),
      sources: projectWebSources(this.state.sources),
      counters: { ...this.state.counters, evidenceBytes: webEvidenceBytes(this.state) },
    });
    return Object.freeze(structuredClone(projected)) as MemoryWebState;
  }

  private context(toolCallId: string): WebCallContext {
    return {
      userId: this.identity.userId, turnId: this.state.turnId, toolCallId,
      webDeadlineAt: this.state.webDeadlineAt, signal: this.signal,
      activity: activity => this.activity(activity),
    };
  }

  private activity(activity: WebSearchActivity): void {
    this.latestActivity.set(activity.toolCallId, activity);
    this.state.activities = [...this.latestActivity.values()];
    this.present({ type: 'web-activity', activity });
  }

  private present(event: WebPresentationEvent): void {
    try { this.presentEvent(event); } catch { /* Presentation never changes retrieval. */ }
  }

  private blocked(mode: WebSearchMode, requireProvider = true): Failure | null {
    if (this.signal.aborted) return this.failure(mode, 'WEB_CANCELLED');
    if (this.nowMs() >= this.state.webDeadlineAt) return this.failure(mode, 'WEB_DEADLINE_EXCEEDED');
    const account = this.port.snapshot(this.identity.userId);
    if (!account.prepared) return this.failure(mode, 'WEB_CONNECTION_REQUIRED');
    if (!account.enabled) return this.failure(mode, 'WEB_DISABLED');
    const eligible = account.providers.some(provider =>
      mode === 'browse' ? provider.capabilities.browse : provider.capabilities.fetch);
    if (requireProvider && !eligible) return this.failure(mode, 'WEB_CONNECTION_REQUIRED');
    return null;
  }

  private failure(mode: WebSearchMode | null,
    code: Failure['error']['code']): Failure {
    const retryable = !TERMINAL.has(code);
    return { ok: false, mode, error: { code, retryable } };
  }
}
