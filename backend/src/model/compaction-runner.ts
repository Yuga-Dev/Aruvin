/**
 * ============================================================================
 * FILE: compaction-runner.ts
 * LOCATION: backend/src/model/compaction-runner.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Execute bounded background or inline compaction summarization requests
 *    and record purpose='compaction' usage accounting.
 *
 * ROLE IN PROJECT:
 *    Shared model execution path for P3 async/fallback compaction; forks the
 *    active KV-cache prefix or targets a validated custom compaction model
 *    without mutating canonical conversation state.
 *
 * KEY COMPONENTS:
 *    - CompactionRunInput: Frozen snapshot and model/budget parameters.
 *    - CompactionRunner: Preflight bounds check, OpenRouter SSE call,
 *      summary extraction, and best-effort AccountingService emission.
 * ============================================================================
 */

import type { DiagnosticSink } from '../chat-runtime/ports.js';
import { buildCompactionMessages, parseCompactionSummary } from '../context/compaction-prompt.js';
import type { CompactionSettings } from '../contracts/admin-config-wire.js';
import type { ActiveSummaryRecord, SourceRange } from '../contracts/agent-memory.js';
import type { BudgetConfig } from '../contracts/budgets.js';
import { verifiedOutputCap } from '../contracts/config-runtime.js';
import type { AccountingRecord } from '../contracts/metadata.js';
import type { MetadataRepository } from '../contracts/repositories.js';
import type { WebNativeMessage } from './web-native.js';
import { AppError } from '../platform/errors/app-error.js';
import { AccountingService, identifier, mergeUsage } from './accounting.js';
import { object, providerFault } from './faults.js';
import { streamNativeCompletion } from './native-stream.js';
import { openRouterSessionId, providerParameters, type ModelConfig, type ModelLimits } from './policy.js';

export type CompactionRunInput = {
  userId: string;
  sessionId: string;
  summaryId: string;
  compactionCycle: number;
  turnId: string;
  sourceRange: SourceRange;
  prefix: readonly WebNativeMessage[];
  previousSummary: ActiveSummaryRecord | null;
  deltaMessages: readonly WebNativeMessage[];
  calendarProvenance: ActiveSummaryRecord['calendarProvenance'];
  budgets: BudgetConfig;
  openRouter: ModelConfig['openRouter'];
  modelLimits: ModelLimits | null;
  compaction: CompactionSettings;
  compactionModelLimits: ModelLimits | null;
  signal: AbortSignal;
};

export type CompactionRunResult = {
  summary: ActiveSummaryRecord;
  accounting: AccountingRecord;
};

export class CompactionRunner {
  private readonly fetcher: typeof fetch;
  private readonly now: () => string;
  private readonly random: () => number;

  constructor(
    private readonly dependencies: {
      putAccounting: MetadataRepository['putAccounting'];
      fetcher?: typeof fetch;
      now?: () => string;
      random?: () => number;
      report?: DiagnosticSink;
    },
  ) {
    this.fetcher = dependencies.fetcher ?? fetch;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.random = dependencies.random ?? Math.random;
  }

  async run(input: CompactionRunInput): Promise<CompactionRunResult> {
    const useCustom = input.compaction.modelMode === 'custom';
    const targetModelId = useCustom
      ? input.compaction.customModelId ?? ''
      : input.openRouter.modelId;
    const targetLimits = useCustom ? input.compactionModelLimits : input.modelLimits;
    if (!input.openRouter.apiKey || !targetModelId || !targetLimits || verifiedOutputCap(targetLimits) === null) {
      throw new AppError('CONFIGURATION_ERROR', 'Compaction model configuration is unavailable.', false);
    }

    const promptBudgets: BudgetConfig = {
      ...input.budgets,
      // buildCompactionMessages appends the summary request after prefix/history.
      maxMessagesInContext: Math.max(input.budgets.maxMessagesInContext + 4, input.prefix.length + input.deltaMessages.length + 4),
    };
    const messages = buildCompactionMessages(
      input.prefix,
      input.previousSummary,
      input.deltaMessages,
      promptBudgets,
    );
    const maxOutputTokens = Math.min(input.budgets.maxOutputTokens, targetLimits.outputTokens);
    const estimatedBytes = 64 + Buffer.byteLength(JSON.stringify(messages), 'utf8') + messages.length * 32;
    const contextCeiling = Math.min(input.budgets.maxContextTokens, targetLimits.contextTokens);
    if (estimatedBytes + maxOutputTokens + input.budgets.modelMarginTokens > contextCeiling) {
      throw new AppError('CONTEXT_BUDGET_EXCEEDED', 'Compaction input exceeds model context capacity.', false);
    }

    const runnerConfig: ModelConfig = {
      identity: { userId: input.userId },
      budgets: promptBudgets,
      openRouter: {
        apiKey: input.openRouter.apiKey,
        modelId: targetModelId,
        reasoningEffort: useCustom ? 'provider-default' : input.openRouter.reasoningEffort,
        dataCollection: input.openRouter.dataCollection,
        disableTransforms: input.openRouter.disableTransforms,
      },
    };

    const startedAt = this.now();
    const attemptId = `compact-${input.summaryId}`;
    let accounting: AccountingRecord = {
      schemaVersion: 1,
      kind: 'accounting',
      purpose: 'compaction',
      userId: input.userId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      attemptId,
      generationId: null,
      requestedModel: targetModelId,
      reportedModel: null,
      reportedProvider: null,
      promptTokens: null,
      completionTokens: null,
      cost: null,
      accountingStatus: 'unknown',
      outcome: 'generating',
      startedAt,
      endedAt: null,
    };

    const accountingService = new AccountingService(
      runnerConfig,
      { putAccounting: this.dependencies.putAccounting },
      this.fetcher,
      this.random,
    );

    const maxChars = Math.min(input.budgets.maxMessageBytes, input.budgets.maxOutputTokens * 16);
    const deadlineAt = new Date(Date.now() + input.budgets.totalRunTimeoutMs).toISOString();
    let accumulated = '';
    let truncated = false;
    let streamError: AppError | null = null;
    let ended = false;

    type InternalChunk =
      | { type: 'delta'; text: string }
      | { type: 'length' }
      | { type: 'end' }
      | { type: 'fault'; error: AppError };

    const observe = async (raw: unknown): Promise<void> => {
      const top = object(raw);
      accounting = mergeUsage(
        {
          ...accounting,
          generationId: identifier(top.id) ?? accounting.generationId,
          reportedModel: identifier(top.model) ?? accounting.reportedModel,
          reportedProvider: identifier(top.provider) ?? accounting.reportedProvider,
        },
        top.usage,
      );
    };

    for await (const chunk of streamNativeCompletion<InternalChunk>(
      runnerConfig,
      input.signal,
      deadlineAt,
      {
        body: () => ({
          ...providerParameters(runnerConfig, { user: input.userId, maxOutputTokens }, targetLimits),
          session_id: openRouterSessionId(input.userId, input.sessionId),
          messages,
          stream: true,
        }),
        beforeDispatch: async () => undefined,
        observe: async (raw, isEnd) => {
          await observe(raw);
          if (isEnd) accounting = { ...accounting, endedAt: this.now() };
        },
        frame: (raw) => {
          const top = object(raw);
          const choice = object(Array.isArray(top.choices) ? top.choices[0] : undefined);
          const delta = object(choice.delta);
          const out: InternalChunk[] = [];
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            out.push({ type: 'delta', text: delta.content });
          }
          if (choice.finish_reason === 'length') out.push({ type: 'length' });
          return out;
        },
        finish: () => [{ type: 'end' }],
        rejected: (http, parsed) => [
          { type: 'fault', error: providerFault(http.status, object(object(parsed).error).code) },
        ],
        failed: (error) => [
          {
            type: 'fault',
            error: error instanceof AppError
              ? error
              : new AppError('PROVIDER_ERROR', 'Compaction summarization failed.', false),
          },
        ],
        report: this.dependencies.report,
      },
      this.fetcher,
    )) {
      if (chunk.type === 'delta') {
        if (accumulated.length + chunk.text.length > maxChars) {
          streamError = new AppError('PROVIDER_ERROR', 'Compaction output exceeded size bounds.', false);
          break;
        }
        accumulated += chunk.text;
      } else if (chunk.type === 'length') {
        truncated = true;
      } else if (chunk.type === 'end') {
        ended = true;
      } else if (chunk.type === 'fault') {
        streamError = chunk.error;
      }
    }

    const persistTerminalAccounting = async (
      outcome: AccountingRecord['outcome'],
    ): Promise<AccountingRecord> => {
      const record: AccountingRecord = {
        ...accounting,
        outcome,
        endedAt: accounting.endedAt ?? this.now(),
      };
      try {
        const reconcileCtrl = new AbortController();
        return await accountingService.reconcile(record, reconcileCtrl.signal);
      } catch {
        try {
          await accountingService.saveRaw(record);
        } catch {
          // Best-effort accounting must not crash compaction cleanup or live chat.
        }
        return record;
      }
    };

    if (input.signal.aborted && !ended) {
      await persistTerminalAccounting('cancelled');
      throw new AppError('CANCELLED', 'Compaction was cancelled.', false);
    }
    if (streamError) {
      await persistTerminalAccounting(streamError.code === 'INTERRUPTED' ? 'interrupted' : 'failed');
      throw streamError;
    }
    if (!ended) {
      await persistTerminalAccounting('interrupted');
      throw new AppError('INTERRUPTED', 'Compaction ended before completion.', false);
    }

    let summary: ActiveSummaryRecord;
    try {
      summary = parseCompactionSummary(
        accumulated,
        {
          schemaVersion: 1,
          kind: 'memory-summary',
          userId: input.userId,
          sessionId: input.sessionId,
          summaryId: input.summaryId,
          compactionCycle: input.compactionCycle,
          sourceRange: input.sourceRange,
          calendarProvenance: input.calendarProvenance,
          modelId: targetModelId,
          createdAt: this.now(),
        },
        input.budgets,
      );
    } catch (error) {
      await persistTerminalAccounting(truncated ? 'truncated' : 'failed');
      throw error;
    }

    const finalAccounting = await persistTerminalAccounting(truncated ? 'truncated' : 'completed');
    return { summary, accounting: finalAccounting };
  }
}
