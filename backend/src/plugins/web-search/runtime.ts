/**
 * ============================================================================
 * FILE: runtime.ts
 * LOCATION: backend/src/plugins/web-search/runtime.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate web tool input and execute prepared MCP reads with ordered fallback.
 *
 * ROLE IN PROJECT:
 *    Keeps the model-facing port small: one issued ticket, current-memory
 *    permission checks, nested deadlines, and one attempt per provider.
 *
 * KEY COMPONENTS:
 *    - snapshot: Secret-free prepared account advertisement.
 *    - validateInput: URL safety, permission checks, and a single-use ticket.
 *    - execute: Sequential fixed-order provider attempts and bounded results.
 * ============================================================================
 */

import { WEB_SEARCH_POLICY, WEB_SEARCH_PROVIDERS } from '../../contracts/web-search-policy.js';
import type { WebSearchMode } from '../../contracts/web-search-policy.js';
import type {
  WebToolArguments, WebToolResult,
} from '../../contracts/web-search-tools.js';
import { WEB_CREDENTIALS_INVALID_MESSAGE } from '../../contracts/web-search-tools.js';
import type { WebSearchActivity, WebToolErrorCode } from '../../contracts/web-search-wire.js';
import { WebSearchConnections } from './connection.js';
import { WebToolFault } from './errors.js';
import type { WebMcpClient } from './mcp-client.js';
import { mapCall } from './providers.js';
import { normalizeResult } from './results.js';
import type {
  PreparedWebAccount, ValidatedWebInput, WebCallContext, WebSearchPort,
} from './types.js';
import { assertPublicUrl, type WebLookup } from './url-safety.js';

export type WebSearchRuntimeOptions = {
  connections: WebSearchConnections; mcp: WebMcpClient;
  excludedDomains?: () => readonly string[];
  lookup?: typeof import('node:dns/promises').lookup;
  nowMs?: () => number; now?: () => Date;
};

type Failure = Extract<WebToolResult, { ok: false }>;

const FALLBACK_CODES = new Set<WebToolErrorCode>([
  'WEB_PROVIDER_AUTH', 'WEB_PROVIDER_CREDITS', 'WEB_PROVIDER_RATE_LIMITED',
  'WEB_PROVIDER_TIMEOUT', 'WEB_PROVIDER_UNAVAILABLE', 'WEB_UNUSABLE_RESULT',
]);
const TERMINAL_CODES = new Set<WebToolErrorCode>([
  'WEB_CANCELLED', 'WEB_DEADLINE_EXCEEDED', 'WEB_INTERRUPTED',
  'WEB_DISABLED', 'WEB_CONNECTION_REQUIRED',
]);
const RETRYABLE = new Set<WebToolErrorCode>([
  'WEB_PROVIDER_CREDITS', 'WEB_PROVIDER_RATE_LIMITED',
  'WEB_PROVIDER_TIMEOUT', 'WEB_PROVIDER_UNAVAILABLE', 'WEB_UNUSABLE_RESULT',
  'WEB_PROVIDERS_EXHAUSTED',
]);

export class WebSearchRuntime implements WebSearchPort {
  private readonly connections: WebSearchConnections;
  private readonly mcp: WebMcpClient;
  private readonly excludedDomains: () => readonly string[];
  private readonly lookup: WebLookup | undefined;
  private readonly nowMs: () => number;
  private readonly now: () => Date;
  private readonly tickets = new WeakMap<object, { expiresAt: number; used: boolean }>();

  constructor(options: WebSearchRuntimeOptions) {
    this.connections = options.connections;
    this.mcp = options.mcp;
    this.excludedDomains = options.excludedDomains ?? (() => []);
    this.lookup = options.lookup as unknown as WebLookup | undefined;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.now = options.now ?? (() => new Date());
  }

  snapshot(userId: string): PreparedWebAccount {
    return this.connections.snapshot(userId);
  }

  async validateInput(
    args: WebToolArguments, context: WebCallContext,
  ): Promise<ValidatedWebInput | Failure> {
    if (context.signal.aborted) return this.failure(args.mode, 'WEB_CANCELLED');
    if (this.nowMs() >= context.webDeadlineAt) {
      return this.failure(args.mode, 'WEB_DEADLINE_EXCEEDED');
    }
    const snapshot = this.connections.snapshot(context.userId);
    if (!snapshot.prepared) return this.failure(args.mode, 'WEB_CONNECTION_REQUIRED');
    if (!snapshot.enabled) return this.failure(args.mode, 'WEB_DISABLED');
    if (this.connections.allCredentialsRejected(context.userId, args.mode)) {
      return this.authTerminal(context, args.mode);
    }
    if (!this.connections.hasEligibleProvider(context.userId, args.mode)) {
      return this.failure(args.mode, 'WEB_CONNECTION_REQUIRED');
    }
    if (args.mode === 'fetch') {
      try {
        await assertPublicUrl(args.url, {
          lookup: this.lookup,
          signal: context.signal,
          deadlineAt: Math.min(context.webDeadlineAt, this.nowMs() + 1_000),
          nowMs: this.nowMs,
        });
      } catch {
        return this.failure('fetch', 'WEB_URL_UNSAFE');
      }
    }
    const frozenArgs = Object.freeze({ ...args }) as WebToolArguments;
    const input: ValidatedWebInput = Object.freeze({
      args: frozenArgs, userId: context.userId,
      turnId: context.turnId, toolCallId: context.toolCallId,
    });
    this.tickets.set(input, {
      expiresAt: Math.min(context.webDeadlineAt, this.nowMs() + 1_000), used: false,
    });
    return input;
  }

  async execute(input: ValidatedWebInput, context: WebCallContext): Promise<WebToolResult> {
    const mode = input.args.mode;
    const ticket = this.tickets.get(input);
    if (!ticket || ticket.used) return this.failure(mode, 'WEB_INTERRUPTED');
    if (input.userId !== context.userId || input.turnId !== context.turnId
      || input.toolCallId !== context.toolCallId) {
      return this.failure(mode, 'WEB_INTERRUPTED');
    }
    if (ticket.expiresAt <= this.nowMs()) return this.failure(mode, 'WEB_URL_UNSAFE');
    ticket.used = true;
    if (context.signal.aborted) return this.failure(mode, 'WEB_CANCELLED');
    if (this.nowMs() >= context.webDeadlineAt) {
      return this.failure(mode, 'WEB_DEADLINE_EXCEEDED');
    }
    const snapshot = this.connections.snapshot(context.userId);
    if (!snapshot.enabled) return this.failure(mode, 'WEB_DISABLED');
    if (this.connections.allCredentialsRejected(context.userId, mode)) {
      return this.authTerminal(context, mode);
    }
    if (!this.connections.hasEligibleProvider(context.userId, mode)) {
      return this.failure(mode, 'WEB_CONNECTION_REQUIRED');
    }
    const callDeadline = Math.min(
      context.webDeadlineAt, this.nowMs() + WEB_SEARCH_POLICY.logicalCallTimeoutMs);
    this.emit(context, {
      toolCallId: context.toolCallId, mode,
      phase: mode === 'browse' ? 'searching' : 'reading', provider: null, code: null,
    });
    const excludedDomains = mode === 'browse' ? this.excludedDomains() : undefined;
    for (const provider of WEB_SEARCH_PROVIDERS) {
      const current = this.connections.currentEligibleProvider(context.userId, provider, mode);
      if (!current) continue;
      const global = this.globalFault(context, callDeadline);
      if (global !== null) return this.terminal(context, mode, global);
      const slotDeadline = Math.min(
        callDeadline, this.nowMs() + WEB_SEARCH_POLICY.providerCallTimeoutMs);
      const session = this.mcp.session(current, context.userId);
      if (!session) {
        this.connections.requestMaintenance(context.userId);
        continue;
      }
      const mapped = mapCall(provider, input.args, slotDeadline - this.nowMs(), excludedDomains);
      const slotSignal = AbortSignal.any([
        context.signal,
        this.connections.callSignal(context.userId, current),
        AbortSignal.timeout(Math.max(1, Math.floor(slotDeadline - this.nowMs()))),
      ]);
      let payload: unknown;
      try {
        payload = await session.call(mapped, slotSignal, slotDeadline);
      } catch (error) {
        const code = error instanceof WebToolFault ? error.toolCode : 'WEB_PROVIDER_UNAVAILABLE';
        if (TERMINAL_CODES.has(code)) return this.terminal(context, mode, code);
        if (code === 'WEB_PROVIDER_AUTH') {
          const global = this.globalFault(context, callDeadline);
          if (global !== null) return this.terminal(context, mode, global);
          if (!this.connections.isCurrent(context.userId, current)) {
            return this.terminal(context, mode,
              context.signal.aborted ? 'WEB_CANCELLED' : 'WEB_INTERRUPTED');
          }
          this.connections.rejectApiKey(context.userId, current);
        }
        this.emit(context, {
          toolCallId: context.toolCallId, mode, phase: 'fallback',
          provider, code: this.fallbackCode(code),
        });
        continue;
      }
      if (!this.connections.isCurrent(context.userId, current)) {
        return this.terminal(context, mode,
          context.signal.aborted ? 'WEB_CANCELLED' : 'WEB_INTERRUPTED');
      }
      const normalized = await normalizeResult({
        provider, args: input.args, payload,
        retrievedAt: this.now().toISOString(),
        publicUrl: (raw: string) => assertPublicUrl(raw, {
          lookup: this.lookup, signal: slotSignal,
          deadlineAt: slotDeadline, nowMs: this.nowMs,
        }),
      });
      if (!this.connections.isCurrent(context.userId, current)) {
        return this.terminal(context, mode,
          context.signal.aborted ? 'WEB_CANCELLED' : 'WEB_INTERRUPTED');
      }
      if (normalized.ok) {
        this.emit(context, {
          toolCallId: context.toolCallId, mode, phase: 'completed',
          provider, code: null,
        });
        return normalized;
      }
      this.emit(context, {
        toolCallId: context.toolCallId, mode, phase: 'fallback',
        provider, code: this.fallbackCode(normalized.error.code),
      });
    }
    const interrupted = this.globalFault(context, callDeadline);
    if (interrupted !== null) return this.terminal(context, mode, interrupted);
    return this.connections.allCredentialsRejected(context.userId, mode)
      ? this.authTerminal(context, mode)
      : this.terminal(context, mode, 'WEB_PROVIDERS_EXHAUSTED');
  }

  private globalFault(context: WebCallContext, callDeadline: number): WebToolErrorCode | null {
    if (context.signal.aborted) return 'WEB_CANCELLED';
    if (this.nowMs() >= callDeadline) return 'WEB_DEADLINE_EXCEEDED';
    if (!this.connections.snapshot(context.userId).enabled) return 'WEB_DISABLED';
    return null;
  }

  private fallbackCode(code: WebToolErrorCode): WebToolErrorCode {
    return FALLBACK_CODES.has(code) ? code : 'WEB_PROVIDER_UNAVAILABLE';
  }

  private terminal(
    context: WebCallContext, mode: WebSearchMode, code: WebToolErrorCode,
  ): Failure {
    this.emit(context, {
      toolCallId: context.toolCallId, mode,
      phase: code === 'WEB_CANCELLED' ? 'cancelled' : 'failed',
      provider: null, code,
    });
    return this.failure(mode, code);
  }

  /**
   * A saved credential is confirmed rejected: a new query cannot fix it, and
   * the model gets the fixed reconnect instruction instead of a generic error.
   */
  private authTerminal(context: WebCallContext, mode: WebSearchMode): Failure {
    this.emit(context, {
      toolCallId: context.toolCallId, mode, phase: 'failed',
      provider: null, code: 'WEB_PROVIDER_AUTH',
    });
    return {
      ok: false, mode,
      error: { code: 'WEB_PROVIDER_AUTH', retryable: false },
      message: WEB_CREDENTIALS_INVALID_MESSAGE,
    };
  }

  private failure(mode: WebSearchMode | null, code: WebToolErrorCode): Failure {
    return { ok: false, mode, error: { code, retryable: RETRYABLE.has(code) } };
  }

  private emit(context: WebCallContext, activity: WebSearchActivity): void {
    try {
      context.activity?.(activity);
    } catch {
      /* Activity projection cannot affect the tool result. */
    }
  }
}
