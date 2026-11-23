# Runtime Compaction Engine, Working-Set Eviction & Model Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Aurvin's non-blocking memory compaction engine, $O(\text{tail})$ working-set eviction and hydration, 4-stage burst overflow resolution, silent Live Voice compaction, compaction accounting, and single-catalogue `compaction.customModelId` validation with zero pre-model DB latency on live turns.

**Architecture:** Async background compaction triggers after turn completion once effective history utilization crosses `settings.compaction.watermarkRatio` (80% default) or tail message ratio reaches the same watermark, runs against OpenRouter via a dedicated `CompactionRunner` sharing the active KV-cache prefix (or a validated custom model), stages results into a session-local `pending` slot without stalling concurrent turns `K+1..latest`, promotes between turns in `MemoryFirstFoundation` (evicting `0..K`, pruning orphaned `baseCalendar`/`baseWeb`/`cold.groups`/`cold.webGroups` to tail `turnId`s), and persists via `MemoryTextArchive`'s single FIFO write queue (`CompactionEnvelope`). Burst (`>100%`) overflows resolve inline via Stage 1 tool folding (`foldToolPayloads`), Stage 2 awaiting an in-flight `CompactionJob` (rebasing only `s.active` version), Stage 3 synchronous inline compaction, or Stage 4 physical-floor `CONTEXT_BUDGET_EXCEEDED`.

**Tech Stack:** TypeScript (ESM/NodeNext with `.js` imports), NestJS, Vitest, Zod, MongoDB (`RecordStore`), LangGraph checkpoints, OpenRouter SSE (`/api/v1/chat/completions`, `/models`).

---

## Upstream Prerequisites & Ownership Boundaries

- **P1 (COMPLETE — `b9b6864..11bbd83`):** Provides `activeSummaryRecordSchema`, `summaryRefSchema`, `compactionCheckpointMetaSchema`, `redactSummaryCalendar`, `contextUsageMetaSchema`, `ContextSourceSnapshot.summary`, `accountingRecordSchema.purpose: 'compaction'`, `RuntimeConfigSnapshot.compactionModelLimits`, `CompactionSettings`, `MetadataRepository.{putCompactionSummary,getCompactionSummary,redactCompactionSummary}`, and `MessageRepository.listPublished`.
- **P2 (PLAN `3097f59` COMMITTED — worker MUST complete before P3 execution begins):** P3 assumes P2's context exports exist:
  - `backend/src/context/compaction-prompt.ts`: `COMPACTION_SECTIONS`, `compactedHistoryMessage`, `buildCompactionMessages`, `parseCompactionSummary`
  - `backend/src/context/cutpoint.ts`: `CompactionTurn`, `selectCompactionCutpoint`
  - `backend/src/context/tool-folding.ts`: `FoldableMessage`, `foldToolPayloads`
  - `backend/src/context/reference-selection.ts`: `buildReferenceManifest(..., activeSummaryRef = null)`, `validateManifest`
  - `backend/src/context/referenced-context-assembler.ts`: `ReferencedContextAssembler` reading `source.summary` on warm path or `metadata.getCompactionSummary` on cold path
  - `backend/src/context/calendar-context.ts`: `catalogIndex` prefix anchoring; still throws `INVALID_REQUEST` on orphaned `turnId`s outside `historyPositions` (pruned by P3)
- **No-op P3 files checked during planning (Ponytail/YAGNI):**
  - `backend/src/agent/state.ts`: `boundaryFor(m)` already hashes `agentMemoryManifestSchema` (including `activeSummaryRef`); no code change needed.
  - `backend/src/http/chat-stream.transport.ts`: `calendarCompatibleEnvelopeSchema` already validates `context-state` and `compaction`/`contextUsage` on `completed`; emitting `context-state` before `status`/`completed` streams cleanly without modifying `chat-stream.transport.ts`.
- **File header & ESM rules:** Every new `.ts` file starts with the mandatory `FILE / LOCATION / PURPOSE / ROLE IN PROJECT / KEY COMPONENTS` header comment, and every relative import uses `.js`.
- **Git rule:** Do NOT run git commands during MAW subagent execution; report modified/created files and verification outputs to the orchestrator for centralized commits.
- **Unrelated workspace files:** Never modify `backend/src/voice/**`, `backend/src/contracts/voice*`, `backend/test/voice/**`, `backend/package*.json`, `output/`, `benchmarks/**`, or `.openchamber/**`.

---

## Task 1: Validate `compaction.customModelId` Against Single `/models` Catalogue & Wire `compactionModelLimits`

**Files:**
- Modify: `backend/src/model/catalogue.ts`
- Modify: `backend/src/admin-config/admin-config.service.ts`
- Modify: `backend/src/app.service.ts`
- Test: `backend/src/admin-config/admin-config.service.spec.ts`, `backend/src/app.controller.spec.ts`

- [ ] **Step 1: Write failing tests in `backend/src/admin-config/admin-config.service.spec.ts` and `backend/src/app.controller.spec.ts`**

Add to `backend/src/admin-config/admin-config.service.spec.ts` (imports `expect`, `describe`, `it` and existing fixtures already present at top):

```typescript
describe('compaction customModelId compatibility', () => {
  it('validates compaction.customModelId on a single /models fetch when modelMode is custom', async () => {
    let modelCalls = 0;
    const validSettings = fixtureSettings({
      openRouter: { modelId: 'openai/gpt-4o-mini', reasoningEffort: 'none' },
      compaction: {
        enabled: true,
        watermarkRatio: 0.8,
        modelMode: 'custom',
        customModelId: 'anthropic/nonexistent-compact',
      },
    });
    const f = serviceFixture({
      stored: null,
      fetcher: async (url) => {
        if (String(url).includes('/models')) {
          modelCalls += 1;
          return new Response(JSON.stringify({
            data: [{
              id: 'openai/gpt-4o-mini',
              context_length: 128_000,
              architecture: { input_modalities: ['text'], output_modalities: ['text'] },
              endpoints: ['/api/v1/chat/completions'],
              top_provider: { max_completion_tokens: 16_384 },
              supported_parameters: ['max_tokens'],
            }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected URL: ${String(url)}`);
      },
    });

    const response = await f.service.checkModelCompatibility(
      { expectedRevision: 0, settings: validSettings },
      actor(),
    );
    expect(modelCalls).toBe(1);
    expect(response.report.status).toBe('incompatible');
    expect(response.report.blockers).toContainEqual({
      code: 'MODEL_NOT_LISTED',
      path: 'compaction.customModelId',
    });
  });

  it('rejects a custom compaction model whose context or output capacity is below chat budgets', async () => {
    const settings = fixtureSettings({
      openRouter: { modelId: 'openai/gpt-4o-mini', reasoningEffort: 'none' },
      compaction: {
        enabled: true,
        watermarkRatio: 0.8,
        modelMode: 'custom',
        customModelId: 'tiny/model',
      },
    });
    const f = serviceFixture({
      stored: null,
      fetcher: async () => new Response(JSON.stringify({
        data: [
          {
            id: 'openai/gpt-4o-mini',
            context_length: 128_000,
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            endpoints: ['/api/v1/chat/completions'],
            top_provider: { max_completion_tokens: 16_384 },
            supported_parameters: ['max_tokens'],
          },
          {
            id: 'tiny/model',
            context_length: 4_096,
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            endpoints: ['/api/v1/chat/completions'],
            top_provider: { max_completion_tokens: 512 },
            supported_parameters: ['max_tokens'],
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    const response = await f.service.checkModelCompatibility(
      { expectedRevision: 0, settings },
      actor(),
    );
    expect(response.report.status).toBe('incompatible');
    expect(response.report.blockers).toContainEqual({
      code: 'CONTEXT_CAPACITY_TOO_SMALL',
      path: 'compaction.customModelId',
    });
    expect(response.report.blockers).toContainEqual({
      code: 'OUTPUT_CAPACITY_TOO_SMALL',
      path: 'compaction.customModelId',
    });
  });
});
```

Add to `backend/src/app.controller.spec.ts` (imports `prepareConfigurationSnapshot` from `./app.service.js`, `loadModelLimits` from `./model/catalogue.js`, and `loadBootstrapConfig` cleanly):

```typescript
describe('compactionModelLimits configuration snapshot', () => {
  it('populates compactionModelLimits in one /models fetch when modelMode is custom', async () => {
    let modelFetches = 0;
    const bootstrap = loadBootstrapConfig({ PERSISTENCE_PROFILE: 'native-mongodb', MONGODB_URI: 'fixture-only' });
    const candidateSettings = {
      ...bootstrap.safety,
      openRouter: {
        modelId: 'openai/gpt-4o-mini',
        reasoningEffort: 'provider-default' as const,
        dataCollection: 'deny' as const,
        disableTransforms: true as const,
      },
      chat: {
        maxInputChars: 4000,
        maxInputTokens: 1500,
        maxMessageBytes: 64_000,
        maxMessagesInContext: 80,
        maxHistoryTokens: 10_000,
        maxOutputTokens: 2048,
        maxContextTokens: 16_384,
        titleMaxChars: 80,
      },
      compaction: {
        enabled: true,
        watermarkRatio: 0.8,
        modelMode: 'custom' as const,
        customModelId: 'anthropic/claude-haiku',
      },
      voice: { enabled: false, maxSessionMinutes: 15, maxTurnAudioSeconds: 30, ttsVoice: 'aura-2-thalia-en', sttModel: 'flux-general-en' },
      personalization: { tone: 'neutral' as const, responseLength: 'balanced' as const, customInstructions: '' },
      calendar: { enabled: false, processingPolicyId: 'native-local.v1' as const },
    };
    const fetcher: typeof fetch = async () => {
      modelFetches += 1;
      return new Response(JSON.stringify({
        data: [
          {
            id: 'openai/gpt-4o-mini',
            context_length: 128_000,
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            endpoints: ['/api/v1/chat/completions'],
            top_provider: { max_completion_tokens: 16_384 },
            supported_parameters: ['max_tokens'],
          },
          {
            id: 'anthropic/claude-haiku',
            context_length: 200_000,
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            endpoints: ['/api/v1/chat/completions'],
            top_provider: { max_completion_tokens: 8192 },
            supported_parameters: ['max_tokens'],
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const snapshot = await prepareConfigurationSnapshot(
      bootstrap,
      { revision: 1, settings: candidateSettings, credentials: { openrouter: 'sk-test-1234', deepgram: null } },
      { instructions: 'System.', knowledge: 'Knowledge.', instructionVersion: 'v1', knowledgeContentHash: 'k1', graphSchemaVersion: 'g1' },
      loadModelLimits,
      fetcher,
      new AbortController().signal,
    );
    expect(modelFetches).toBe(1);
    expect(snapshot.modelLimits?.modelId).toBe('openai/gpt-4o-mini');
    expect(snapshot.compactionModelLimits?.modelId).toBe('anthropic/claude-haiku');
    expect(snapshot.compactionModelLimits?.contextTokens).toBe(200_000);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run in `backend/`:
```bash
npm test -- src/admin-config/admin-config.service.spec.ts -t "compaction customModelId compatibility"
npm test -- src/app.controller.spec.ts -t "compactionModelLimits configuration snapshot"
```
Expected: FAIL (`checkModelCompatibility` ignores `compaction.customModelId`; `snapshot.compactionModelLimits` is `undefined`).

- [ ] **Step 3: Implement single-catalogue `customModelId` validation in `catalogue.ts`, `admin-config.service.ts`, and `app.service.ts`**

1. **`backend/src/model/catalogue.ts`:**
   - Import `type CompactionSettings` from `../contracts/admin-config-wire.js`.
   - Extend `CompatibilityConfig` (line 52) and add `CompactionModelLoadOptions`:
     ```typescript
     export type CompatibilityConfig = Pick<ModelConfig, 'budgets'> & {
       openRouter: Omit<ModelConfig['openRouter'], 'apiKey'>;
       compaction?: CompactionSettings;
     };
     export type CompactionModelLoadOptions = {
       compaction?: CompactionSettings;
       setCompactionLimits?: (limits: ModelLimits | null) => void;
     };
     ```
   - Export `evaluateCompactionModel(customModelId, budgets, snapshot)` reusing `evaluateModelEvidence` with `reasoningEffort: 'provider-default'` and mapping its blocker paths to `'compaction.customModelId'`:
     ```typescript
     export function evaluateCompactionModel(
       customModelId: string,
       budgets: CompatibilityConfig['budgets'],
       snapshot: CatalogueSnapshot,
     ): {
       blockers: Array<{ code: ModelCompatibilityCode; path: AdminConfigFieldPath | null }>;
       limits: ModelLimits | null;
     } {
       const evaluated = evaluateModelEvidence(
         {
           budgets,
           openRouter: {
             modelId: customModelId,
             reasoningEffort: 'provider-default',
             dataCollection: 'deny',
             disableTransforms: true,
           },
         },
         snapshot,
         undefined,
         [],
       );
       const blockers = evaluated.reportBase.blockers.map((blocker) => ({
         code: blocker.code,
         path: 'compaction.customModelId' as AdminConfigFieldPath,
       }));
       return { blockers, limits: evaluated.limits };
     }
     ```
   - Update `evaluateModelCompatibility` (lines 434-458) so when `config.compaction?.modelMode === 'custom'`, it merges `evaluateCompactionModel(config.compaction.customModelId ?? '', config.budgets, snapshot).blockers` via `addBlocker(...)` and recalculates `status` precedence (`incompatible` > `unable-to-verify` > `catalogue-compatible`).
   - Update `loadModelLimits` (line 599) to accept optional 6th argument `compactionOptions?: CompactionModelLoadOptions`:
     - After the SINGLE `snapshot = await readModelCatalogue(...)` call, when `compactionOptions?.compaction?.modelMode === 'custom'`, evaluate `custom = evaluateCompactionModel(compactionOptions.compaction.customModelId ?? '', c.budgets, snapshot)`.
     - If `custom.blockers.length > 0 || custom.limits === null`: if `assets`, merge `custom.blockers` into `result.report` and throw `ModelCompatibilityFault`; otherwise throw `AppError('CONFIGURATION_ERROR', 'The configured compaction model limits could not be verified.', false)`.
     - Call `compactionOptions.setCompactionLimits?.(custom.limits)` (or `compactionOptions?.setCompactionLimits?.(limits)` in non-custom mode).

2. **`backend/src/admin-config/admin-config.service.ts` (line 178):**
   Pass `compaction: settings.compaction` into `evaluateModelCompatibility({ budgets, openRouter: settings.openRouter, compaction: settings.compaction }, assets, snapshot)`.

3. **`backend/src/app.service.ts` (`prepareConfigurationSnapshot`, lines 189-198):**
   ```typescript
   let compactionLimits: ModelLimits | null = null;
   const limits = configured
     ? await limitsLoader(
         modelConfig,
         signal,
         fetcher,
         evidence ?? undefined,
         assets,
         settings.compaction.modelMode === 'custom'
           ? {
               compaction: settings.compaction,
               setCompactionLimits: (resolved) => {
                 compactionLimits = resolved;
               },
             }
           : undefined,
       )
     : null;
   if (configured && settings.compaction.modelMode === 'active-fork') {
     compactionLimits = limits;
   } else if (configured && settings.compaction.modelMode === 'custom' && compactionLimits === null && limitsLoader !== loadModelLimits) {
     // Preserve custom unit-test limitsLoader doubles that ignore optional 6th argument.
     compactionLimits = limits;
   }
   if (configured) {
     assertChatFloor(assets, settings.chat);
     assertFixedContextFits(assets, budgets);
   }
   if (signal.aborted) throw new AdminConfigFault('CONFIG_ACTIVATION_UNAVAILABLE');
   const baseSnapshot = buildRuntimeSnapshot(bootstrap, { ...candidate, settings }, limits);
   return Object.freeze({
     ...baseSnapshot,
     compactionModelLimits: compactionLimits ? Object.freeze({ ...compactionLimits }) : null,
   });
   ```

- [ ] **Step 4: Run tests**

Run in `backend/`:
```bash
npm test -- src/admin-config/admin-config.service.spec.ts
npm test -- src/app.controller.spec.ts
npm test -- test/model/model-compatibility.spec.ts test/admin-config/model-compatibility.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Orchestrator commit suggestion (do NOT run git directly)**

Report completion of Task 1 files (`catalogue.ts`, `admin-config.service.ts`, `app.service.ts`, `admin-config.service.spec.ts`, `app.controller.spec.ts`) for serialized commit: `feat(model): validate compaction.customModelId on single catalogue snapshot`.

---

## Task 2: `CompactionRunner` & `purpose: 'compaction'` Accounting Emission

**Files:**
- Create: `backend/src/model/compaction-runner.ts`
- Test: `backend/test/runtime/compaction-model.spec.ts`

- [ ] **Step 1: Write failing test `backend/test/runtime/compaction-model.spec.ts`**

```typescript
/**
 * ============================================================================
 * FILE: compaction-model.spec.ts
 * LOCATION: backend/test/runtime/compaction-model.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify CompactionRunner model dispatch, prompt capacity guards, summary
 *    extraction, and purpose='compaction' accounting persistence.
 *
 * ROLE IN PROJECT:
 *    Exercises the background compaction model wrapper in isolation using a
 *    deterministic OpenRouter fetch double.
 *
 * KEY COMPONENTS:
 *    - Active-fork & custom-model dispatch specs.
 *    - Accounting emission & failure/abort handling specs.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import type { AccountingRecord } from '../../src/contracts/metadata.js';
import { CompactionRunner } from '../../src/model/compaction-runner.js';

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function validRawSummary(): string {
  const sections = COMPACTION_SECTIONS.map((heading, idx) =>
    `${idx + 1}. ${heading}:\nDetails for ${heading}.`,
  ).join('\n\n');
  return `<analysis>Internal scratchpad note</analysis>\n<summary>\n${sections}\n</summary>`;
}

describe('CompactionRunner', () => {
  it('forks active model with sticky session_id, lifts message limit, strips analysis, and emits compaction accounting', async () => {
    const savedAccounting: AccountingRecord[] = [];
    const seenBodies: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      seenBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([
        {
          id: 'gen-cmp-1',
          model: 'anthropic/claude-sonnet-4',
          provider: 'Anthropic',
          choices: [{ index: 0, delta: { content: validRawSummary() }, finish_reason: null }],
        },
        {
          id: 'gen-cmp-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1400,
            completion_tokens: 220,
            cost: 0.0042,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        },
      ]);
    };

    const runner = new CompactionRunner({
      putAccounting: async (record) => { savedAccounting.push(record); },
      fetcher,
      now: () => '2026-10-06T12:00:00.000Z',
    });

    const delta = Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `Turn message ${i}`,
    }));

    const out = await runner.run({
      userId: 'user-1',
      sessionId: 'sess-1',
      summaryId: 'sum-1',
      compactionCycle: 1,
      turnId: 'turn-2',
      sourceRange: { fromSequence: 0, toSequence: 3, fromEventId: 'ev-0', toEventId: 'ev-3' },
      prefix: [{ role: 'system', content: 'System prefix' }],
      previousSummary: null,
      deltaMessages: delta,
      calendarProvenance: {
        containsCalendarContent: false,
        connectionId: null,
        connectionRevision: null,
        earliestExpiresAt: null,
        redactedAt: null,
      },
      budgets: { ...DEFAULT_BUDGETS, maxMessagesInContext: 4 },
      openRouter: {
        apiKey: 'sk-test-key',
        modelId: 'anthropic/claude-sonnet-4',
        reasoningEffort: 'low',
        dataCollection: 'deny',
        disableTransforms: true,
      },
      modelLimits: {
        modelId: 'anthropic/claude-sonnet-4',
        contextTokens: 200_000,
        outputTokens: 8192,
        supportsMaxTokens: true,
        outputCapParameter: 'max_tokens',
        source: 'catalogue',
        tools: true,
      },
      compaction: {
        enabled: true,
        watermarkRatio: 0.8,
        modelMode: 'active-fork',
        customModelId: null,
      },
      compactionModelLimits: null,
      signal: new AbortController().signal,
    });

    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0].model).toBe('anthropic/claude-sonnet-4');
    expect(seenBodies[0].session_id).toMatch(/^aurvin-[0-9a-f]{64}$/);
    expect(seenBodies[0].cache_control).toEqual({ type: 'ephemeral' });
    expect((seenBodies[0].messages as unknown[]).length).toBeGreaterThan(4);
    expect(out.summary.content).not.toMatch(/<\/?analysis\b/i);
    expect(savedAccounting).toHaveLength(1);
    expect(savedAccounting[0]).toMatchObject({
      purpose: 'compaction',
      userId: 'user-1',
      sessionId: 'sess-1',
      turnId: 'turn-2',
      attemptId: 'compact-sum-1',
      generationId: 'gen-cmp-1',
      accountingStatus: 'known',
      outcome: 'completed',
      promptTokens: 1400,
      completionTokens: 220,
      cachedPromptTokens: 1000,
      cost: 0.0042,
    });
  });

  it('uses customModelId + compactionModelLimits with provider-default reasoning when configured', async () => {
    const savedAccounting: AccountingRecord[] = [];
    const seenBodies: Record<string, unknown>[] = [];
    const runner = new CompactionRunner({
      putAccounting: async (record) => { savedAccounting.push(record); },
      fetcher: async (_url, init) => {
        seenBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sseResponse([
          {
            id: 'gen-cmp-2',
            model: 'openai/gpt-4o-mini',
            choices: [{ index: 0, delta: { content: validRawSummary() }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 500, completion_tokens: 150, cost: 0.001 },
          },
        ]);
      },
      now: () => '2026-10-06T12:00:00.000Z',
    });

    const out = await runner.run({
      userId: 'user-1',
      sessionId: 'sess-1',
      summaryId: 'sum-2',
      compactionCycle: 2,
      turnId: 'turn-4',
      sourceRange: { fromSequence: 0, toSequence: 7, fromEventId: 'ev-0', toEventId: 'ev-7' },
      prefix: [{ role: 'system', content: 'System prefix' }],
      previousSummary: null,
      deltaMessages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }],
      calendarProvenance: {
        containsCalendarContent: false,
        connectionId: null,
        connectionRevision: null,
        earliestExpiresAt: null,
        redactedAt: null,
      },
      budgets: DEFAULT_BUDGETS,
      openRouter: {
        apiKey: 'sk-test-key',
        modelId: 'anthropic/claude-sonnet-4',
        reasoningEffort: 'high',
        dataCollection: 'deny',
        disableTransforms: true,
      },
      modelLimits: {
        modelId: 'anthropic/claude-sonnet-4',
        contextTokens: 200_000,
        outputTokens: 8192,
        supportsMaxTokens: true,
        outputCapParameter: 'max_tokens',
        source: 'catalogue',
        tools: true,
      },
      compaction: {
        enabled: true,
        watermarkRatio: 0.8,
        modelMode: 'custom',
        customModelId: 'openai/gpt-4o-mini',
      },
      compactionModelLimits: {
        modelId: 'openai/gpt-4o-mini',
        contextTokens: 128_000,
        outputTokens: 16_384,
        supportsMaxTokens: true,
        outputCapParameter: 'max_tokens',
        source: 'catalogue',
        tools: false,
      },
      signal: new AbortController().signal,
    });

    expect(seenBodies[0].model).toBe('openai/gpt-4o-mini');
    expect(seenBodies[0].reasoning).toBeUndefined();
    expect(out.summary.modelId).toBe('openai/gpt-4o-mini');
    expect(savedAccounting[0].requestedModel).toBe('openai/gpt-4o-mini');
    expect(savedAccounting[0].purpose).toBe('compaction');
  });

  it('emits failed compaction accounting when provider errors', async () => {
    const savedAccounting: AccountingRecord[] = [];
    const runner = new CompactionRunner({
      putAccounting: async (record) => { savedAccounting.push(record); },
      fetcher: async () => new Response(JSON.stringify({ error: { message: 'Overloaded' } }), { status: 503 }),
      now: () => '2026-10-06T12:00:00.000Z',
    });

    await expect(runner.run({
      userId: 'user-1',
      sessionId: 'sess-1',
      summaryId: 'sum-err',
      compactionCycle: 1,
      turnId: 'turn-1',
      sourceRange: { fromSequence: 0, toSequence: 1, fromEventId: 'ev-0', toEventId: 'ev-1' },
      prefix: [{ role: 'system', content: 'Sys' }],
      previousSummary: null,
      deltaMessages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }],
      calendarProvenance: {
        containsCalendarContent: false,
        connectionId: null,
        connectionRevision: null,
        earliestExpiresAt: null,
        redactedAt: null,
      },
      budgets: DEFAULT_BUDGETS,
      openRouter: {
        apiKey: 'sk-test-key',
        modelId: 'openai/gpt-4o-mini',
        reasoningEffort: 'none',
        dataCollection: 'deny',
        disableTransforms: true,
      },
      modelLimits: {
        modelId: 'openai/gpt-4o-mini',
        contextTokens: 128_000,
        outputTokens: 4096,
        supportsMaxTokens: true,
        outputCapParameter: 'max_tokens',
        source: 'catalogue',
        tools: false,
      },
      compaction: { enabled: true, watermarkRatio: 0.8, modelMode: 'active-fork', customModelId: null },
      compactionModelLimits: null,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });

    expect(savedAccounting).toHaveLength(1);
    expect(savedAccounting[0]).toMatchObject({
      purpose: 'compaction',
      attemptId: 'compact-sum-err',
      outcome: 'failed',
    });
  });
});
```

- [ ] **Step 2: Run the failing test**

Run in `backend/`:
```bash
npm test -- test/runtime/compaction-model.spec.ts
```
Expected: FAIL (`Cannot find module '../../src/model/compaction-runner.js'`).

- [ ] **Step 3: Create `backend/src/model/compaction-runner.ts`**

Reuses `providerParameters`, `streamNativeCompletion`, `AccountingService`, `mergeUsage`, `identifier`, `buildCompactionMessages`, and `parseCompactionSummary`.

```typescript
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

import { createHash } from 'node:crypto';
import type { DiagnosticSink } from '../chat-runtime/ports.js';
import { buildCompactionMessages, parseCompactionSummary } from '../context/compaction-prompt.js';
import type { CompactionSettings } from '../contracts/admin-config-wire.js';
import type { ActiveSummaryRecord, SourceRange } from '../contracts/agent-memory.js';
import type { BudgetConfig } from '../contracts/budgets.js';
import type { AccountingRecord } from '../contracts/metadata.js';
import type { MetadataRepository } from '../contracts/repositories.js';
import type { WebNativeMessage } from '../contracts/web-search.js';
import { AppError } from '../platform/errors/app-error.js';
import { AccountingService, identifier, mergeUsage } from './accounting.js';
import { object, providerFault } from './faults.js';
import { streamNativeCompletion } from './native-stream.js';
import { providerParameters, verifiedOutputCap, type ModelConfig, type ModelLimits } from './policy.js';

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

function compactionSessionRoutingId(userId: string, sessionId: string): string {
  return `aurvin-${createHash('sha256').update(JSON.stringify([userId, sessionId])).digest('hex')}`;
}

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
    const deadlineAt = new Date(Date.parse(startedAt) + input.budgets.totalRunTimeoutMs).toISOString();
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
          session_id: compactionSessionRoutingId(input.userId, input.sessionId),
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
```

- [ ] **Step 4: Run test**

Run in `backend/`:
```bash
npm test -- test/runtime/compaction-model.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Orchestrator commit suggestion (do NOT run git directly)**

Report completion of Task 2 files (`compaction-runner.ts`, `compaction-model.spec.ts`) for serialized commit: `feat(model): add CompactionRunner with KV-fork routing and compaction accounting`.

---

## Task 3: Foundation Sliding Eviction, Summary State, Promotion, `Finalization` & `DurableChatRuntime` Compaction Compatibility

**Files:**
- Modify: `backend/src/chat-runtime/memory-first-foundation.ts`
- Modify: `backend/src/chat-runtime/finalization.ts`
- Modify: `backend/src/chat-runtime/durable-chat-runtime.ts`
- Test: `backend/test/runtime/compaction-foundation.spec.ts`

- [ ] **Step 1: Write failing test `backend/test/runtime/compaction-foundation.spec.ts`**

```typescript
/**
 * ============================================================================
 * FILE: compaction-foundation.spec.ts
 * LOCATION: backend/test/runtime/compaction-foundation.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify >128 turn sliding eviction, compaction promotion/pruning, active
 *    turn rebasing, calendar invalidation summary redaction, and finalization.
 *
 * ROLE IN PROJECT:
 *    Guards MemoryFirstFoundation invariants so compaction never hits the old
 *    requests.size permanent lock or leaks compacted/orphaned working state.
 *
 * KEY COMPONENTS:
 *    - 140-turn admission/save sliding eviction test.
 *    - Concurrent tail preservation & orphaned Calendar/Web pruning test.
 *    - Finalization non-null activeSummaryRef compatibility test.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { MemoryFirstFoundation, PROPOSED_MEMORY_TEXT_POLICY, type SaveEnvelope } from '../../src/chat-runtime/memory-first-foundation.js';
import { checkedResult } from '../../src/chat-runtime/finalization.js';
import { buildReferenceManifest } from '../../src/context/reference-selection.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import type { ActiveSummaryRecord } from '../../src/contracts/agent-memory.js';
import type { MessageRecord } from '../../src/contracts/message.js';
import type { MemoryCalendarState } from '../../src/chat-runtime/memory-calendar-state.js';
import type { MemoryWebRecord } from '../../src/persistence/memory-web-records.js';
import { boundaryFor } from '../../src/agent/state.js';
import { CALENDAR_LIMITS } from '../../src/contracts/calendar-policy.js';

const cfg = {
  instructionVersion: 'inst-1',
  knowledgeContentHash: 'know-1',
  graphSchemaVersion: 'graph-1',
};

function makeSummary(overrides: Partial<ActiveSummaryRecord> = {}): ActiveSummaryRecord {
  const sections = COMPACTION_SECTIONS.map((h, i) => `${i + 1}. ${h}:\nSummary text.`).join('\n\n');
  return {
    schemaVersion: 1,
    kind: 'memory-summary',
    userId: 'user-1',
    sessionId: 'sess-1',
    summaryId: 'sum-1',
    compactionCycle: 1,
    sourceRange: { fromSequence: 0, toSequence: 5, fromEventId: 'ev-0', toEventId: 'ev-5' },
    content: sections,
    calendarProvenance: {
      containsCalendarContent: false,
      connectionId: null,
      connectionRevision: null,
      earliestExpiresAt: null,
      redactedAt: null,
    },
    modelId: 'openai/gpt-4o-mini',
    tokenEstimate: 64,
    createdAt: '2026-10-06T12:00:00.000Z',
    ...overrides,
  };
}

describe('MemoryFirstFoundation compaction & eviction', () => {
  it('accepts >128 settled turns via sliding eviction without STORAGE_BUDGET_EXCEEDED', async () => {
    const saved: SaveEnvelope[] = [];
    const foundation = new MemoryFirstFoundation({
      userId: 'user-1',
      epoch: 'epoch-1',
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async (envelope) => {
        saved.push(envelope);
        return {
          kind: 'saved',
          epoch: envelope.epoch,
          sessionId: envelope.sessionId,
          version: envelope.version,
          fence: envelope.fence,
        };
      },
    });

    for (let i = 0; i < 140; i++) {
      const turn = foundation.accept({
        mode: 'text',
        sessionId: 'sess-1',
        content: `Turn ${i}`,
        requestKey: `req-${i}`,
        calendarReplyTo: null,
        voice: null,
        config: cfg,
      });
      foundation.complete(turn, {
        status: 'completed',
        content: `Reply ${i}`,
        accounting: null,
        delivery: null,
      });
      await foundation.flushSession('sess-1');
    }

    expect(saved).toHaveLength(140);
    expect(foundation.records('sess-1')).toHaveLength(280);
  });

  it('promotes compaction preserving K+1..latest, prunes orphaned Calendar/Web groups, and redacts summary on disconnect', async () => {
    const saved: SaveEnvelope[] = [];
    const foundation = new MemoryFirstFoundation({
      userId: 'user-1',
      epoch: 'epoch-1',
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async (envelope) => {
        saved.push(envelope);
        return {
          kind: 'saved',
          epoch: envelope.epoch,
          sessionId: envelope.sessionId,
          version: envelope.version,
          fence: envelope.fence,
        };
      },
    });

    const turns = [];
    for (let i = 0; i < 4; i++) {
      const turn = foundation.accept({
        mode: 'text',
        sessionId: 'sess-1',
        content: `Q${i}`,
        requestKey: `req-${i}`,
        calendarReplyTo: null,
        voice: null,
        config: cfg,
      });
      turns.push(turn);
      const calendarState: MemoryCalendarState = {
        storage: 'volatile',
        budget: {
          schemaVersion: 1,
          kind: 'calendar-turn-budget',
          userId: 'user-1',
          sessionId: 'sess-1',
          turnId: turn.turnId,
          attemptId: turn.attemptId,
          openRouterUser: 'user-1',
          modelId: 'openai/gpt-4o-mini',
          configRevision: 1,
          processingPolicyId: 'native-local.v1',
          limits: CALENDAR_LIMITS,
          modelDispatches: 0,
          toolCalls: 0,
          calendarWrites: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          totalEstimatedCost: 0,
          createdAt: '2026-10-06T12:00:00.000Z',
          deadlineAt: '2026-10-06T12:05:00.000Z',
          endedAt: null,
          terminationReason: null,
        },
        dispatches: [],
        aggregate: null,
        decisions: [],
        rejected: [],
        results: [],
      };
      const webRecord: MemoryWebRecord = {
        schemaVersion: 1,
        kind: 'memory-web',
        userId: 'user-1',
        sessionId: 'sess-1',
        turnId: turn.turnId,
        attemptId: turn.attemptId,
        groups: [{
          assistant: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `wc-${i}`, type: 'function', function: { name: 'web_tool', arguments: '{"action":"search"}' } }],
          },
          results: [{ role: 'tool', tool_call_id: `wc-${i}`, content: '{"ok":true}' }],
        }],
        state: { sources: [], activities: [] },
      };
      foundation.complete(turn, {
        status: 'completed',
        content: `A${i}`,
        accounting: null,
        delivery: null,
        calendar: calendarState,
        web: webRecord,
      });
    }
    await foundation.flushSession('sess-1');

    const baseSections = COMPACTION_SECTIONS.map((h, i) =>
      `${i + 1}. ${h}:\n${h === 'Calendar & Time Context' ? '<calendar_context>Meeting at 3pm.</calendar_context>' : 'Overview.'}`,
    ).join('\n\n');
    const summary = makeSummary({
      summaryId: 'sum-cal-1',
      compactionCycle: 1,
      sourceRange: {
        fromSequence: turns[0].sequence,
        toSequence: turns[1].sequence + 1,
        fromEventId: turns[0].inputEventId,
        toEventId: turns[1].outputEventId,
      },
      content: baseSections,
      calendarProvenance: {
        containsCalendarContent: true,
        connectionId: 'conn-1',
        connectionRevision: 2,
        earliestExpiresAt: '2026-10-06T13:00:00.000Z',
        redactedAt: null,
      },
    });

    const promoted = foundation.promoteCompaction(
      'user-1',
      'sess-1',
      summary,
      { compactedThroughSequence: summary.sourceRange.toSequence, compactionCycle: 1 },
    );
    await foundation.flushSession('sess-1');

    expect(promoted.manifest.activeSummaryRef).toEqual({
      summaryId: 'sum-cal-1',
      sourceRange: summary.sourceRange,
    });
    expect(promoted.tailTurnIds).toEqual(new Set([turns[2].turnId, turns[3].turnId]));
    expect(foundation.records('sess-1').map((r) => r.turnId)).toEqual([
      turns[2].turnId,
      turns[2].turnId,
      turns[3].turnId,
      turns[3].turnId,
    ]);
    expect([...foundation.webGroups('sess-1').keys()]).toEqual([turns[2].turnId, turns[3].turnId]);
    expect(saved.at(-1)).toMatchObject({ kind: 'compaction', version: 5, previousVersion: 4 });

    foundation.invalidateCalendarAccount({
      userId: 'user-1',
      connectionId: 'conn-1',
      connectionRevision: 2,
    });
    const nextTurn = foundation.accept({
      mode: 'text',
      sessionId: 'sess-1',
      content: 'Follow-up',
      requestKey: 'req-4',
      calendarReplyTo: null,
      voice: null,
      config: cfg,
    });
    const ctx = foundation.context(nextTurn);
    expect(ctx.summary?.calendarProvenance.redactedAt).not.toBeNull();
    expect(ctx.summary?.content).toContain('[redacted due to account disconnection or expiry]');
  });

  it('rebases active turn during inline burst compaction so complete() uses incremented version', () => {
    const foundation = new MemoryFirstFoundation({
      userId: 'user-1',
      epoch: 'epoch-1',
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async (envelope) => ({
        kind: 'saved',
        epoch: envelope.epoch,
        sessionId: envelope.sessionId,
        version: envelope.version,
        fence: envelope.fence,
      }),
    });
    const t0 = foundation.accept({
      mode: 'text', sessionId: 'sess-1', content: 'U0', requestKey: 'r0',
      calendarReplyTo: null, voice: null, config: cfg,
    });
    foundation.complete(t0, { status: 'completed', content: 'A0', accounting: null, delivery: null });

    const t1 = foundation.accept({
      mode: 'text', sessionId: 'sess-1', content: 'U1', requestKey: 'r1',
      calendarReplyTo: null, voice: null, config: cfg,
    });
    const rebased = foundation.rebaseActiveTurnForCompaction(
      t1,
      makeSummary({
        sourceRange: {
          fromSequence: t0.sequence,
          toSequence: t0.sequence + 1,
          fromEventId: t0.inputEventId,
          toEventId: t0.outputEventId,
        },
      }),
      { compactedThroughSequence: t0.sequence + 1, compactionCycle: 1 },
    );

    expect(rebased.turn.contextVersion).toBe(2);
    const ctx = foundation.context(rebased.turn);
    expect(ctx.manifest.activeSummaryRef?.summaryId).toBe('sum-1');
    foundation.complete(rebased.turn, { status: 'completed', content: 'A1', accounting: null, delivery: null });
    expect(foundation.result(rebased.turn)?.version).toBe(3);
  });

  it('checkedResult preserves and verifies non-null activeSummaryRef', async () => {
    const summaryRef = {
      summaryId: 'sum-1',
      sourceRange: { fromSequence: 0, toSequence: 1, fromEventId: 'ev-0', toEventId: 'ev-1' },
    };
    const msg2: MessageRecord = {
      schemaVersion: 1, userId: 'user-1', sessionId: 'sess-1', turnId: 'turn-2', attemptId: null,
      messageId: 'm2', eventId: 'ev-2', sequence: 3, role: 'user', content: 'Hi',
      createdAt: '2026-10-06T12:01:00.000Z', completionStatus: 'accepted', truncated: false,
    };
    const msg3: MessageRecord = {
      schemaVersion: 1, userId: 'user-1', sessionId: 'sess-1', turnId: 'turn-2', attemptId: 'att-2',
      messageId: 'm3', eventId: 'ev-3', sequence: 4, role: 'assistant', content: 'Yo',
      createdAt: '2026-10-06T12:01:01.000Z', completionStatus: 'completed', truncated: false,
    };
    const assets = {
      instructions: '', knowledge: '', instructionVersion: 'inst-1',
      knowledgeContentHash: 'know-1', graphSchemaVersion: 'graph-1',
    };
    const base = buildReferenceManifest('user-1', 'sess-1', 2, [], assets, DEFAULT_BUDGETS, summaryRef);
    const target = buildReferenceManifest('user-1', 'sess-1', 3, [msg2, msg3], assets, DEFAULT_BUDGETS, summaryRef);
    const fakePersistence = {
      memory: {
        get: async () => base,
        budgets: DEFAULT_BUDGETS,
      },
      messages: {
        getReferences: async () => [],
      },
    } as never;

    const checked = await checkedResult(
      fakePersistence,
      {
        schemaVersion: 1, userId: 'user-1', sessionId: 'sess-1', turnId: 'turn-2', attemptId: 'att-2',
        idempotencyKey: 'k2', status: 'generating', truncated: false, sequence: 3,
        contextVersion: 2, openRouterUser: 'user-1', modelId: 'openai/gpt-4o-mini',
        instructionVersion: 'inst-1', knowledgeContentHash: 'know-1', graphSchemaVersion: 'graph-1',
        createdAt: '2026-10-06T12:01:00.000Z', updatedAt: '2026-10-06T12:01:00.000Z',
        generationId: null, errorCode: null,
      },
      msg2,
      {
        input: { attempt: {} as never, assistantSequence: 4 },
        assistant: msg3,
        accounting: {
          schemaVersion: 1, kind: 'accounting', purpose: 'chat', userId: 'user-1', sessionId: 'sess-1',
          turnId: 'turn-2', attemptId: 'att-2', generationId: null, requestedModel: 'openai/gpt-4o-mini',
          reportedModel: null, reportedProvider: null, promptTokens: null, completionTokens: null,
          cost: null, accountingStatus: 'unknown', outcome: 'completed',
          startedAt: '2026-10-06T12:01:00.000Z', endedAt: null,
        },
        base: boundaryFor(base),
        target,
        outcome: 'completed',
      },
    );
    expect(isDeepStrictEqual(checked.target, target)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run in `backend/`:
```bash
npm test -- test/runtime/compaction-foundation.spec.ts
```
Expected: FAIL (permanent `requests.size >= maxRequestsPerSession` throws `STORAGE_BUDGET_EXCEEDED`, `promoteCompaction` / `rebaseActiveTurnForCompaction` do not exist, and `finalization.ts:163` rejects `activeSummaryRef !== null`).

- [ ] **Step 3: Implement Task 3 changes in `memory-first-foundation.ts`, `finalization.ts`, and `durable-chat-runtime.ts`**

1. **`backend/src/chat-runtime/memory-first-foundation.ts`:**
   - Import `activeSummaryRecordSchema`, `compactionCheckpointMetaSchema`, `redactSummaryCalendar`, `type ActiveSummaryRecord`, `type CompactionCheckpointMeta` from `../contracts/agent-memory.js`.
   - Export `CompactionEnvelope` & `SaveEnvelope = TerminalEnvelope | CompactionEnvelope` and widen `SaveTerminal` to `(e: SaveEnvelope, signal: AbortSignal) => Promise<SaveOutcome>`.
   - Extend `Base` to `{ manifest: AgentMemoryManifest; records: readonly MessageRecord[]; summary: ActiveSummaryRecord | null }`.
   - Add `activeSummaryForRead(summary, nowMs)` redacting expired unredacted Calendar summaries on read.
   - Replace line 371 permanent lock inside `accept(c)` with `this.evictSettledForCapacity(s)`:
     - Fold contiguous oldest durable `s.results` (ascending `version <= s.durableVersion` and not queued in `s.jobs`) into `s.base`, `s.baseDeliveries`, `s.baseCalendar`, `s.baseWeb` (preserving `s.base?.summary ?? null`, `activeSummaryRef`, and filtering folded tail records after `activeSummaryRef?.sourceRange.toSequence ?? -1`), bumping `s.base.manifest.contextVersion` to the highest contiguous folded `version`.
     - Evict oldest settled `reqKey` entries from `s.requests` (excluding `s.active?.requestKey` and keys referenced by `s.jobs`) while `s.requests.size >= this.policy.maxRequestsPerSession`.
     - Trim `s.archive` to at most `Math.min(500, this.policy.maxTurnsPerSession * 2)` newest entries and recalculate `s.retainedBytes` cleanly.
     - Only throw `capacity()` if `s.requests.size >= maxRequestsPerSession` or `s.results.size >= maxTurnsPerSession` still holds (all slots unpersisted/active).
   - Update `commitPromoted(turn, committed)` (line 527) to preserve `summary: activeSummaryForRead(s.base?.summary ?? null, this.now())` inside `s.base`.
   - Update `invalidateCalendarAccount(account)` (lines 582-614) to also redact `s.base.summary` and any non-in-flight `CompactionEnvelope` in `s.jobs` when `connectionId` & `connectionRevision` match.
   - Update `context(turn)` (lines 621-633) to include `activeSummaryRef = s.base?.manifest.activeSummaryRef ?? null`, filter `records` strictly after `activeSummaryRef?.sourceRange.toSequence ?? -1`, and return `summary` on `ContextSourceSnapshot`.
   - Update `hydrate(...)` to validate & retain `source.summary` matching `manifest.activeSummaryRef`.
   - Add `promoteCompaction(userId, sessionId, summary, checkpoint)` and `rebaseActiveTurnForCompaction(turn, summary, checkpoint, checkpointOverrides?)`:
     - Validate monotonic `compactionCycle` / `sourceRange.toSequence`.
     - Redact expired Calendar provenance on `summary`.
     - Filter `tailRecords` (`sequence > summary.sourceRange.toSequence`) and compute `tailTurnIds`.
     - Prune `baseCalendar`, `baseWeb`, and `baseDeliveries` (including unfolded tail results) strictly to `tailTurnIds`.
     - Build `manifest` at `nextVersion = safeSequence(s.version + 1)` with `activeSummaryRef = { summaryId: summary.summaryId, sourceRange: summary.sourceRange }`.
     - Update `s.version = nextVersion`, `s.base = freeze({ manifest, records: freeze(tailRecords), summary: freeze(summary) })`, `s.archive = freeze(tailRecords)`.
     - Evict settled compacted `s.results` (`output.sequence <= summary.sourceRange.toSequence` and not in `s.jobs`) and enqueue `CompactionEnvelope` onto `s.jobs`, then call `this.pump()`.
     - When `rebaseActiveTurnForCompaction` is used for inline burst fallback, clone `activeTurn` with `contextVersion: nextVersion`, replace `s.requests.set(rebasedTurn.requestKey, rebasedTurn)` and `s.active = rebasedTurn`, and return `{ version: nextVersion, manifest, tailTurnIds, turn: rebasedTurn }`.
   - Guard existing `s.jobs` / `applySaved` loops so `'request' in j.envelope` vs `j.envelope.kind === 'compaction'` never accesses `.request` on compaction envelopes.

2. **`backend/src/chat-runtime/finalization.ts` (lines 163 & 191):**
   - Remove `r.target.activeSummaryRef !== null ||` on line 163 and check `isDeepStrictEqual(r.target.activeSummaryRef, current?.activeSummaryRef ?? null)`.
   - Pass `current?.activeSummaryRef ?? null` as 7th arg to `buildReferenceManifest` on line 191.

3. **`backend/src/chat-runtime/durable-chat-runtime.ts`:**
   - Pass `manifest.activeSummaryRef` / `current.activeSummaryRef` / `old.activeSummaryRef` to `buildReferenceManifest(...)` at lines `445, 789, 1654, 1659, 1663, 2829, 2833`, and rebuild Calendar `seal.target` preserving `manifest.activeSummaryRef` if non-null at lines `2118/2188/2447`.
   - In `loadHealthyContext` (line 791), load `summary = current.activeSummaryRef ? await p.metadata.getCompactionSummary?.(u, s, current.activeSummaryRef.summaryId) : null` and pass into `source = { manifest: current, records, ...(summary ? { summary } : {}) }`.
   - Add `compactionState(u: string, s: string) { return this.memoryFor(u, true)?.compactionState(u, s) ?? null; }`.
   - In `drain()` (line 2781), await `await memory.drainCompactions(Math.min(left, this.d.memoryFirst!.policy.shutdownDrainMs));` before `memory.foundation.drain(...)`.

- [ ] **Step 4: Run tests**

Run in `backend/`:
```bash
npm test -- test/runtime/compaction-foundation.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Orchestrator commit suggestion (do NOT run git directly)**

Report completion of Task 3 files (`memory-first-foundation.ts`, `finalization.ts`, `durable-chat-runtime.ts`, `compaction-foundation.spec.ts`) for serialized commit: `feat(runtime): add foundation compaction promotion, >128 sliding eviction, and finalization summary support`.

---

## Task 4: `MemoryTextArchive` Compaction Checkpoint Projection & CAS Ordering

**Files:**
- Modify: `backend/src/persistence/memory-text-archive.ts`
- Test: `backend/test/runtime/compaction-archive.spec.ts`

- [ ] **Step 1: Write failing test `backend/test/runtime/compaction-archive.spec.ts`**

```typescript
/**
 * ============================================================================
 * FILE: compaction-archive.spec.ts
 * LOCATION: backend/test/runtime/compaction-archive.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify MemoryTextArchive compaction checkpoint persistence, concurrent
 *    tail preservation, activeSummaryRef preservation on subsequent turns, and
 *    TOCTOU Calendar summary redaction.
 *
 * ROLE IN PROJECT:
 *    Guards durable CAS ordering between turn saves and compaction saves on
 *    MemoryTextArchive's shared FIFO save pipeline.
 *
 * KEY COMPONENTS:
 *    - CompactionEnvelope projection & LangGraph boundary update test.
 *    - Post-compaction TerminalEnvelope preservation of activeSummaryRef.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { MemoryTextArchive } from '../../src/persistence/memory-text-archive.js';
import { buildReferenceManifest } from '../../src/context/reference-selection.js';
import { boundaryFor } from '../../src/agent/state.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import type { ActiveSummaryRecord, AgentMemoryManifest } from '../../src/contracts/agent-memory.js';
import type { MessageRecord } from '../../src/contracts/message.js';
import type { SessionRecord } from '../../src/contracts/session.js';
import type { CompactionEnvelope } from '../../src/chat-runtime/memory-first-foundation.js';

const assets = {
  instructions: 'Sys',
  knowledge: 'Know',
  instructionVersion: 'inst-1',
  knowledgeContentHash: 'know-1',
  graphSchemaVersion: 'graph-1',
};

function makeMessage(seq: number, role: 'user' | 'assistant', turnId: string, attemptId: string | null): MessageRecord {
  return {
    schemaVersion: 1,
    userId: 'user-1',
    sessionId: 'sess-1',
    turnId,
    attemptId,
    messageId: `msg-${seq}`,
    eventId: `ev-${seq}`,
    sequence: seq,
    role,
    content: `Text ${seq}`,
    createdAt: '2026-10-06T12:00:00.000Z',
    completionStatus: role === 'user' ? 'accepted' : 'completed',
    truncated: false,
  };
}

describe('MemoryTextArchive compaction projection', () => {
  it('saves ActiveSummaryRecord, preserves concurrent tail K+1, updates LangGraph boundary and sessions.compactionCheckpoint', async () => {
    const msgs = [
      makeMessage(0, 'user', 'turn-1', null),
      makeMessage(1, 'assistant', 'turn-1', 'att-1'),
      makeMessage(3, 'user', 'turn-2', null),
      makeMessage(4, 'assistant', 'turn-2', 'att-2'),
    ];
    let currentManifest: AgentMemoryManifest = buildReferenceManifest(
      'user-1', 'sess-1', 2, msgs, assets, DEFAULT_BUDGETS, null,
    );
    const summaries = new Map<string, ActiveSummaryRecord>();
    const sessionDoc: Record<string, unknown> = {
      _id: 'session:user-1:sess-1',
      schemaVersion: 1,
      userId: 'user-1',
      sessionId: 'sess-1',
      title: 'Test',
      lifecycle: 'active',
      createdAt: '2026-10-06T12:00:00.000Z',
      updatedAt: '2026-10-06T12:00:00.000Z',
      lastActivityAt: '2026-10-06T12:00:00.000Z',
      latestTurnId: 'turn-2',
      execution: { ownerId: null, generation: 1, activeAttemptId: null },
      memoryPublication: { version: 2, sequence: 5, epoch: 'epoch-1', fence: 0 },
      _revision: 2,
    };
    const lease = { userId: 'user-1', sessionId: 'sess-1', ownerId: 'exec-1', generation: 1, leaseExpiresAt: '2026-10-06T13:00:00.000Z' };
    const saver = new MemorySaver();

    const fakeStore = {
      options: () => ({}),
      raw: vi.fn(async () => null),
      insert: vi.fn(async () => undefined),
      collection: (name: string) => ({
        updateOne: vi.fn(async (filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) => {
          if (name === 'sessions' && filter['memoryPublication.version'] === 2) {
            Object.assign(sessionDoc, update.$set ?? {});
            return { acknowledged: true, matchedCount: 1 };
          }
          return { acknowledged: true, matchedCount: 0 };
        }),
      }),
    };

    const persistence = {
      owner: {
        executorId: 'exec-1',
        store: fakeStore,
        acquire: vi.fn(async () => lease),
        run: vi.fn(async (_lease, fn: () => Promise<unknown>) => fn()),
        release: vi.fn(async () => undefined),
      },
      sessions: {
        get: vi.fn(async () => sessionDoc as unknown as SessionRecord),
        budgets: DEFAULT_BUDGETS,
      },
      memory: {
        budgets: DEFAULT_BUDGETS,
        get: vi.fn(async () => currentManifest),
        put: vi.fn(async (next: AgentMemoryManifest) => { currentManifest = next; }),
      },
      messages: {
        budgets: DEFAULT_BUDGETS,
        getReferences: vi.fn(async (_u: string, _s: string, refs: readonly { messageId: string }[]) =>
          msgs.filter((m) => refs.some((r) => r.messageId === m.messageId)),
        ),
      },
      metadata: {
        budgets: DEFAULT_BUDGETS,
        putCompactionSummary: vi.fn(async (rec: ActiveSummaryRecord) => { summaries.set(rec.summaryId, rec); }),
        redactCompactionSummary: vi.fn(async (_u: string, _s: string, id: string) => summaries.get(id) ?? null),
      },
      checkpoints: { create: async () => saver },
    } as never;

    const archive = new MemoryTextArchive(persistence, assets, () => Date.parse('2026-10-06T12:01:00.000Z'));
    const sections = COMPACTION_SECTIONS.map((h, i) => `${i + 1}. ${h}:\nCondensed.`).join('\n\n');
    const summary: ActiveSummaryRecord = {
      schemaVersion: 1,
      kind: 'memory-summary',
      userId: 'user-1',
      sessionId: 'sess-1',
      summaryId: 'sum-1',
      compactionCycle: 1,
      sourceRange: { fromSequence: 0, toSequence: 1, fromEventId: 'ev-0', toEventId: 'ev-1' },
      content: sections,
      calendarProvenance: {
        containsCalendarContent: false,
        connectionId: null,
        connectionRevision: null,
        earliestExpiresAt: null,
        redactedAt: null,
      },
      modelId: 'openai/gpt-4o-mini',
      tokenEstimate: 48,
      createdAt: '2026-10-06T12:01:00.000Z',
    };

    const envelope: CompactionEnvelope = {
      schemaVersion: 1,
      kind: 'compaction',
      epoch: 'epoch-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      version: 3,
      previousVersion: 2,
      fence: 0,
      sequence: 6,
      summary,
      checkpoint: { compactedThroughSequence: 1, compactionCycle: 1, summaryPreview: 'Condensed.' },
    };

    const outcome = await archive.save(envelope, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'saved', epoch: 'epoch-1', sessionId: 'sess-1', version: 3, fence: 0 });
    expect(summaries.get('sum-1')).toBeDefined();
    expect(currentManifest.contextVersion).toBe(3);
    expect(currentManifest.activeSummaryRef).toEqual({ summaryId: 'sum-1', sourceRange: summary.sourceRange });
    expect(currentManifest.messageRefs.map((r) => r.sequence)).toEqual([3, 4]);
    expect(sessionDoc.compactionCheckpoint).toEqual({
      compactedThroughSequence: 1,
      compactionCycle: 1,
      summaryPreview: 'Condensed.',
      summaryId: 'sum-1',
    });
    const checkpointState = await saver.getTuple({ configurable: { thread_id: 'user-1:sess-1' } });
    expect(checkpointState?.checkpoint.channel_values.boundary).toEqual(boundaryFor(currentManifest));
  });
});
```

- [ ] **Step 2: Run the failing test**

Run in `backend/`:
```bash
npm test -- test/runtime/compaction-archive.spec.ts
```
Expected: FAIL (`MemoryTextArchive.save` does not handle `kind: 'compaction'` and strips `activeSummaryRef` at line 532).

- [ ] **Step 3: Implement compaction projection & `activeSummaryRef` preservation in `backend/src/persistence/memory-text-archive.ts`**

1. Import `redactSummaryCalendar` from `../contracts/agent-memory.js` and `type CompactionEnvelope`, `type SaveEnvelope` from `../chat-runtime/memory-first-foundation.js`.
2. Update `MemoryTextArchive.save` and `project` to accept `SaveEnvelope`, dispatching `if ('kind' in e && e.kind === 'compaction') return this.projectCompaction(e, signal);`.
3. In existing `TerminalEnvelope` path (`lines 526-535`):
   - Preserve `const activeSummaryRef = prior?.activeSummaryRef ?? null;`
   - Filter `old`, `input`, and `output` strictly to `sequence > (activeSummaryRef?.sourceRange.toSequence ?? -1)`.
   - Pass `activeSummaryRef` as the 7th arg to `buildReferenceManifest`.
4. Implement `private async projectCompaction(e: CompactionEnvelope, signal: AbortSignal): Promise<SaveOutcome>`:
   - Acquire `owned = await op(() => p.owner.acquire(e.userId, e.sessionId, e.version, 'memory-save'))`, verify active session, `activeAttemptId === null`, and monotonic `memoryPublication`.
   - Enforce current Calendar binding & expiry on `e.summary` via `readCurrentCalendarAccountBinding(store, e.userId)` and `this.now()` (`redactSummaryCalendar`, stripping `summaryPreview` if Calendar was redacted).
   - Write `p.metadata.putCompactionSummary!(summary)` (reconciling `IDEMPOTENCY_PAYLOAD_MISMATCH` if redaction happened after an initial insert via `p.metadata.redactCompactionSummary!`).
   - Read `prior = await op(() => p.memory.get(e.userId, e.sessionId))` -> keep tail `old.filter(r => r.sequence > summary.sourceRange.toSequence)` -> `buildReferenceManifest(..., { summaryId: summary.summaryId, sourceRange: summary.sourceRange })` -> `p.memory.put(target)`.
   - Update LangGraph seal boundary `{ input: null, result: null, sealed: false, rebase: null, calendarCursor: null, calendarSeal: null, calendarRefs: null, boundary: boundaryFor(target) }` at `'seal'`.
   - Re-check Calendar account (`latestAccount`) TOCTOU after write and redact in metadata if disconnected mid-write.
   - CAS-update `sessions` `$set: { memoryPublication: { version: e.version, sequence: Math.max(published?.sequence ?? 0, e.sequence), epoch: e.epoch, fence: e.fence }, compactionCheckpoint: { ...checkpoint, summaryId: summary.summaryId } }, $inc: { _revision: 1 }` (treating an already-applied retry at `published?.version === e.version` with matching `compactionCheckpoint.summaryId` as `'saved'`).

- [ ] **Step 4: Run test**

Run in `backend/`:
```bash
npm test -- test/runtime/compaction-archive.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Orchestrator commit suggestion (do NOT run git directly)**

Report completion of Task 4 files (`memory-text-archive.ts`, `compaction-archive.spec.ts`) for serialized commit: `feat(persistence): persist CompactionEnvelope checkpoints and preserve activeSummaryRef in MemoryTextArchive`.

---

## Task 5: $O(\text{tail})$ `calendar-history` & `MemoryText.hydrate` + Older Scrollback Fallback + `compaction`/`contextUsage` Wire Projections

**Files:**
- Modify: `backend/src/chat-runtime/calendar-history.ts`
- Modify: `backend/src/chat-runtime/memory-text.ts`
- Modify: `backend/src/http/chat-http.service.ts`
- Test: `backend/test/runtime/compaction-hydration.spec.ts`

- [ ] **Step 1: Write failing test `backend/test/runtime/compaction-hydration.spec.ts`**

```typescript
/**
 * ============================================================================
 * FILE: compaction-hydration.spec.ts
 * LOCATION: backend/test/runtime/compaction-hydration.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify O(tail) hydration for calendarHistory and MemoryText.hydrate, plus
 *    zero-I/O tail message listing with DB scrollback past compaction cutpoint.
 *
 * ROLE IN PROJECT:
 *    Ensures sessions with >128 turns cold-start and page without full-session
 *    archive or attempt scans.
 *
 * KEY COMPONENTS:
 *    - calendarHistory lower-bound attempt paging test.
 *    - MemoryText.hydrate 200-turn tail-only load via DurableChatRuntime.
 *    - ChatHttpService.messages scrollback fallback test.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { calendarHistory } from '../../src/chat-runtime/calendar-history.js';
import { DurableChatRuntime } from '../../src/chat-runtime/durable-chat-runtime.js';
import { ChatHttpService } from '../../src/http/chat-http.service.js';
import { configurationAdapter } from '../../src/app.service.js';
import { ReferencedContextAssembler } from '../../src/context/referenced-context-assembler.js';
import { buildReferenceManifest } from '../../src/context/reference-selection.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import { boundaryFor } from '../../src/agent/state.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import type { ActiveSummaryRecord } from '../../src/contracts/agent-memory.js';
import type { AttemptRecord } from '../../src/contracts/attempt.js';
import type { MessageRecord } from '../../src/contracts/message.js';
import type { SessionRecord } from '../../src/contracts/session.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-first-foundation.js';
import { loadBootstrapConfig } from '../../src/platform/config/bootstrap-config.js';
import { buildRuntimeSnapshot } from '../../src/platform/config/manageable-config.js';

const assets = {
  instructions: 'Sys',
  knowledge: 'Know',
  instructionVersion: 'inst-1',
  knowledgeContentHash: 'know-1',
  graphSchemaVersion: 'graph-1',
};

function makeMsg(seq: number, turnIdx: number): MessageRecord {
  return {
    schemaVersion: 1,
    userId: 'user-1',
    sessionId: 'sess-200',
    turnId: `turn-${turnIdx}`,
    attemptId: seq % 2 === 0 ? null : `att-${turnIdx}`,
    messageId: `msg-${seq}`,
    eventId: `ev-${seq}`,
    sequence: seq,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${seq}`,
    createdAt: '2026-10-06T12:00:00.000Z',
    completionStatus: seq % 2 === 0 ? 'accepted' : 'completed',
    truncated: false,
  };
}

function makeAttempt(idx: number): AttemptRecord {
  return {
    schemaVersion: 1,
    userId: 'user-1',
    sessionId: 'sess-200',
    turnId: `turn-${idx}`,
    attemptId: `att-${idx}`,
    idempotencyKey: `key-${idx}`,
    status: 'completed',
    truncated: false,
    sequence: idx * 3,
    contextVersion: idx + 1,
    openRouterUser: 'user-1',
    modelId: 'openai/gpt-4o-mini',
    instructionVersion: 'inst-1',
    knowledgeContentHash: 'know-1',
    graphSchemaVersion: 'graph-1',
    createdAt: '2026-10-06T12:00:00.000Z',
    updatedAt: '2026-10-06T12:00:01.000Z',
    generationId: `gen-${idx}`,
    errorCode: null,
  };
}

describe('O(tail) hydration & scrollback', () => {
  it('bounds calendarHistory listAttempts calls when records only contain tail sequences', async () => {
    const allAttempts = Array.from({ length: 300 }, (_, i) => makeAttempt(299 - i));
    const listAttempts = vi.fn(async (_u: string, _s: string, q: { cursor: string | null; limit: number }) => {
      const start = q.cursor ? Number(q.cursor) : 0;
      const items = allAttempts.slice(start, start + 50);
      return { items, nextCursor: start + 50 < allAttempts.length ? String(start + 50) : null };
    });
    const fakePersistence = {
      metadata: {
        budgets: DEFAULT_BUDGETS,
        listAttempts,
        getCalendarStates: vi.fn(async () => []),
      },
      owner: { store: null },
      calendarOperations: null,
      calendarOperationsV2: null,
      calendarSources: null,
      skillDecisions: null,
      calendarProposals: { getCurrentSlot: async () => null },
    } as never;

    const tailRecords = [makeMsg(894, 298), makeMsg(895, 298), makeMsg(897, 299), makeMsg(898, 299)];
    const result = await calendarHistory(fakePersistence, 'user-1', 'sess-200', tailRecords);
    expect(result.size).toBe(0);
    expect(listAttempts).toHaveBeenCalledTimes(1);
  });

  it('hydrates a 200-turn compacted session in O(tail) and delegates older UI scrollback to listPublished', async () => {
    const allAttempts = Array.from({ length: 200 }, (_, i) => makeAttempt(199 - i));
    const allMessages = Array.from({ length: 400 }, (_, i) => {
      const turnIdx = Math.floor(i / 2);
      return makeMsg(turnIdx * 3 + (i % 2), turnIdx);
    });
    const tailMessages = allMessages.slice(-4);
    const summaryRange = {
      fromSequence: allMessages[0].sequence,
      toSequence: allMessages[395].sequence,
      fromEventId: allMessages[0].eventId,
      toEventId: allMessages[395].eventId,
    };
    const summary: ActiveSummaryRecord = {
      schemaVersion: 1,
      kind: 'memory-summary',
      userId: 'user-1',
      sessionId: 'sess-200',
      summaryId: 'sum-200',
      compactionCycle: 4,
      sourceRange: summaryRange,
      content: COMPACTION_SECTIONS.map((h, i) => `${i + 1}. ${h}:\nCondensed 198 turns.`).join('\n\n'),
      calendarProvenance: {
        containsCalendarContent: false,
        connectionId: null,
        connectionRevision: null,
        earliestExpiresAt: null,
        redactedAt: null,
      },
      modelId: 'openai/gpt-4o-mini',
      tokenEstimate: 90,
      createdAt: '2026-10-06T12:00:00.000Z',
    };
    const manifest = buildReferenceManifest(
      'user-1', 'sess-200', 204, tailMessages, assets, DEFAULT_BUDGETS,
      { summaryId: 'sum-200', sourceRange: summaryRange },
    );
    const saver = new MemorySaver();
    await saver.put(
      { configurable: { thread_id: 'user-1:sess-200', checkpoint_ns: '' } },
      {
        v: 1,
        id: 'cp-204',
        ts: '2026-10-06T12:00:00.000Z',
        channel_values: { boundary: boundaryFor(manifest) },
        channel_versions: {},
        versions_seen: {},
      },
      { source: 'update', step: 1, parents: {} },
    );

    const listAttempts = vi.fn(async (_u: string, _s: string, q: { cursor: string | null }) => {
      const start = q.cursor ? Number(q.cursor) : 0;
      const items = allAttempts.slice(start, start + 50);
      return { items, nextCursor: start + 50 < allAttempts.length ? String(start + 50) : null };
    });
    const listForContext = vi.fn(async () => ({
      items: [allMessages.at(-1)!],
      olderAvailable: true,
      nextCursor: 'more-cursor',
    }));
    const listPublished = vi.fn(async () => ({
      items: allMessages.slice(346, 396).map((m) => ({
        messageId: m.messageId,
        turnId: m.turnId,
        eventId: m.eventId,
        sequence: m.sequence,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        completionStatus: m.completionStatus,
        truncated: false,
      })),
      olderAvailable: true,
      nextCursor: 'older-cursor',
    }));
    const sessionRecord: SessionRecord = {
      schemaVersion: 1,
      userId: 'user-1',
      sessionId: 'sess-200',
      title: 'Long Chat',
      lifecycle: 'active',
      createdAt: '2026-10-06T10:00:00.000Z',
      updatedAt: '2026-10-06T12:00:00.000Z',
      lastActivityAt: '2026-10-06T12:00:00.000Z',
      latestTurnId: 'turn-199',
      execution: { ownerId: null, generation: 1, activeAttemptId: null },
      memoryPublication: { version: 204, sequence: 600, epoch: 'epoch-1', fence: 0 },
      compactionCheckpoint: {
        compactedThroughSequence: summaryRange.toSequence,
        compactionCycle: 4,
        summaryPreview: 'Condensed 198 turns.',
        summaryId: 'sum-200',
      },
    };
    const persistence = {
      owner: { executorId: 'exec-1', store: null, drain: vi.fn(async () => ({ drained: true, active: 0, unresolvedWrites: 0 })) },
      sessions: { get: vi.fn(async () => sessionRecord), update: vi.fn(), delete: vi.fn(), list: vi.fn() },
      memory: { budgets: DEFAULT_BUDGETS, get: vi.fn(async () => manifest) },
      messages: {
        budgets: DEFAULT_BUDGETS,
        getReferences: vi.fn(async () => tailMessages),
        listForContext,
        listPublished,
      },
      metadata: {
        budgets: DEFAULT_BUDGETS,
        listAttempts,
        getCompactionSummary: vi.fn(async () => summary),
        getVoiceDeliveries: vi.fn(async () => []),
        putAccounting: vi.fn(async () => undefined),
      },
      calendarProposals: { getCurrentSlot: async () => null },
      checkpoints: { create: async () => saver },
    } as never;

    const bootstrap = loadBootstrapConfig({ PERSISTENCE_PROFILE: 'native-mongodb', MONGODB_URI: 'fixture-only' });
    const limits = { modelId: 'openai/gpt-4o-mini', contextTokens: 128_000, outputTokens: 4096, supportsMaxTokens: true, source: 'catalogue' as const, tools: false };
    const snapshot = Object.freeze({
      ...buildRuntimeSnapshot(
        bootstrap,
        {
          revision: 1,
          settings: {
            ...bootstrap.safety,
            openRouter: { modelId: 'openai/gpt-4o-mini', reasoningEffort: 'none', dataCollection: 'deny', disableTransforms: true },
            chat: {
              maxInputChars: 4000, maxInputTokens: 1500, maxMessageBytes: 64_000, maxMessagesInContext: 80,
              maxHistoryTokens: 10_000, maxOutputTokens: 2048, maxContextTokens: 16_384, titleMaxChars: 80,
            },
            compaction: { enabled: true, watermarkRatio: 0.8, modelMode: 'active-fork', customModelId: null },
            voice: { enabled: false, maxSessionMinutes: 15, maxTurnAudioSeconds: 30, ttsVoice: 'aura-2-thalia-en', sttModel: 'flux-general-en' },
            personalization: { tone: 'neutral', responseLength: 'balanced', customInstructions: '' },
            calendar: { enabled: false, processingPolicyId: 'native-local.v1' },
          },
          credentials: { openrouter: 'sk-test', deepgram: null },
        },
        limits,
      ),
      compactionModelLimits: limits,
    });

    const runtime = new DurableChatRuntime({
      config: configurationAdapter(bootstrap, snapshot),
      persistence,
      assembler: new ReferencedContextAssembler({
        memory: (persistence as { memory: unknown }).memory as never,
        messages: (persistence as { messages: unknown }).messages as never,
        metadata: (persistence as { metadata: unknown }).metadata as never,
        assets,
        budgets: snapshot.budgets,
      }),
      assets,
      limits,
      currentConfig: { current: () => snapshot, revision: () => snapshot.revision },
      fetcher: async () => new Response(),
      now: () => Date.parse('2026-10-06T12:01:00.000Z'),
      memoryFirst: {
        policy: PROPOSED_MEMORY_TEXT_POLICY,
        save: async (e) => ({ kind: 'saved', epoch: e.epoch, sessionId: e.sessionId, version: e.version, fence: e.fence }),
        voice: false,
      },
    });

    await runtime.prepareSession('user-1', 'sess-200');
    expect(listForContext).toHaveBeenCalledTimes(1);
    expect(listAttempts).toHaveBeenCalledTimes(1);

    const page1 = runtime.memoryMessages('user-1', 'sess-200', { cursor: null, limit: 50 });
    expect(page1).not.toBeNull();
    expect(page1!.items).toHaveLength(4);
    expect(page1!.olderAvailable).toBe(true);
    expect(page1!.nextCursor).toEqual(expect.any(String));
    expect(page1!.compaction).toEqual({
      compactedThroughSequence: summaryRange.toSequence,
      compactionCycle: 4,
      summaryPreview: 'Condensed 198 turns.',
    });
    expect(page1!.contextUsage?.maxHistoryTokens).toBe(10_000);
    expect(listPublished).not.toHaveBeenCalled();

    expect(runtime.memoryMessages('user-1', 'sess-200', { cursor: page1!.nextCursor!, limit: 50 })).toBeNull();

    const http = new ChatHttpService({
      identity: { resolve: () => ({ userId: 'user-1', source: 'local-default' }), assertNoClientOverrides: () => undefined } as never,
      sessions: (persistence as { sessions: unknown }).sessions as never,
      messages: (persistence as { messages: unknown }).messages as never,
      budgets: DEFAULT_BUDGETS,
      runtime,
    });
    const olderPage = await http.messages('sess-200', { cursor: page1!.nextCursor! });
    expect(listPublished).toHaveBeenCalledTimes(1);
    expect(olderPage.items).toHaveLength(50);
    expect(olderPage.compaction?.compactionCycle).toBe(4);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run in `backend/`:
```bash
npm test -- test/runtime/compaction-hydration.spec.ts
```
Expected: FAIL (`calendarHistory` pages all 300 attempts and throws `STORAGE_BUDGET_EXCEEDED`; `MemoryText.hydrate` scans full archive via `listForContext`; `messages()` lacks `compaction`/`contextUsage` and doesn't delegate older scrollback).

- [ ] **Step 3: Implement $O(\text{tail})$ hydration and scrollback projections**

1. **`backend/src/chat-runtime/calendar-history.ts` (lines 46-57):**
   - Return `new Map()` early if `records.length === 0`.
   - Compute `const minRecordSequence = Math.min(...records.map(r => r.sequence));`.
   - When paging `p.metadata.listAttempts(userId, sessionId, { cursor, limit })` (`sequence: -1`):
     ```typescript
     const tailOnly = page.items.filter((a) => a.sequence >= minRecordSequence);
     attempts.push(...tailOnly);
     if (page.items.some((a) => a.sequence < minRecordSequence)) break;
     if (attempts.length > 250 || (cursor && attempts.length >= 250)) {
       throw new AppError('STORAGE_BUDGET_EXCEEDED', 'This chat has reached its calendar history limit. Start a new chat.');
     }
     ```
2. **`backend/src/chat-runtime/memory-text.ts` (`hydrate`, `messages`, `compactionState`):**
   - In `hydrate`:
     - When `source.activeSummaryRef`: fetch `summary = await p.metadata.getCompactionSummary?.(u, sessionId, source.activeSummaryRef.summaryId)` (throwing `AppError('NOT_READY', 'Chat summary needs recovery.')` if null or `summaryId`/`sourceRange` mismatch), and redact via `redactSummaryCalendar` when `accountBinding` mismatches or `Date.parse(this.runtime.now()) >= Date.parse(earliestExpiresAt)`.
     - Compute `tailMinSeq = records[0]?.sequence ?? (source.activeSummaryRef ? source.activeSummaryRef.sourceRange.toSequence + 1 : 0)`.
     - Page `listAttempts` (`sequence: -1`), checking `!terminal(a.status) || (session.memoryPublication && a.sequence > session.memoryPublication.sequence)` across fetched items, retaining only `a.sequence >= tailMinSeq`, and breaking once `found.items.some(a => a.sequence < tailMinSeq)` or `!next`.
     - Remove the full `do { listForContext(...) } while (next)` scan; instead fetch ONLY `latestPage = await p.messages.listForContext(u, sessionId, { cursor: null, limit: 1 })`, verify `latestPage.items[0]?.sequence <= session.memoryPublication.sequence`, set `archive = [...records]`, and include `latestPage.items[0]?.sequence ?? -1` in `nextSequence`.
     - Chunk `readMemoryWebRecords` calls in batches of 32 if `tailAttempts.length > 32`.
     - Pass `{ manifest: source, records, ...(summary ? { summary } : {}) }` into `this.foundation.hydrate(...)`.
   - Implement `compactionState(userId: string, sessionId: string)`: computes `compaction?: CompactionCheckpointMeta` and `contextUsage?: ContextUsageMeta` strictly from RAM.
   - Update `messages(userId, sessionId, query)`:
     - Return `null` when `after` cursor is present, `selected.length === 0`, and `Boolean(state?.compaction)` so `ChatHttpService.messages` seamlessly falls back to `listPublished`.
     - Otherwise set `olderAvailable: selected.length > limit || Boolean(state?.compaction)`, anchor `nextCursor` on `oldest`, and attach `compaction` / `contextUsage`.
3. **`backend/src/http/chat-http.service.ts` (`messages`, lines 70-86):**
   - On fallback `listPublished` / `list`, attach `compaction` / `contextUsage` from `(this.o.runtime as { compactionState?: ... }).compactionState?.(userId, id)` (or `session.compactionCheckpoint` stripped of `summaryId` when unhydrated) before `listMessagesResponseSchema.parse(...)`.

- [ ] **Step 4: Run test**

Run in `backend/`:
```bash
npm test -- test/runtime/compaction-hydration.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Orchestrator commit suggestion (do NOT run git directly)**

Report completion of Task 5 files (`calendar-history.ts`, `memory-text.ts`, `chat-http.service.ts`, `compaction-hydration.spec.ts`) for serialized commit: `feat(runtime): bound hydration and calendarHistory to tail sequences with scrollback fallback`.

---

## Task 6: Async 80% Compaction Engine, Concurrent Tail Preservation, Orphan Pruning, Burst Fallback, Calendar Redaction & Silent Live Voice

**Files:**
- Modify: `backend/src/chat-runtime/memory-text.ts`
- Modify: `backend/src/app.service.ts` (`redactInvalidatedRevision` durable summary redaction)
- Test: `backend/test/runtime/compaction-runtime.spec.ts`

- [ ] **Step 1: Write failing test `backend/test/runtime/compaction-runtime.spec.ts`**

```typescript
/**
 * ============================================================================
 * FILE: compaction-runtime.spec.ts
 * LOCATION: backend/test/runtime/compaction-runtime.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify DurableChatRuntime + MemoryText async 80% compaction state
 *    machine, concurrent K+1 preservation with orphan tool pruning, 4-stage
 *    >100% burst fallback, silent Live Voice compaction, and Calendar redaction.
 *
 * ROLE IN PROJECT:
 *    End-to-end runtime verification across P3's orchestration paths.
 *
 * KEY COMPONENTS:
 *    - Async 80% compaction + zero-I/O concurrent turn + orphan pruning test.
 *    - Stage 1 folding -> Stage 3 inline -> Stage 4 floor burst tests.
 *    - Silent Live Voice compaction & AppService Calendar redaction tests.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { DurableChatRuntime } from '../../src/chat-runtime/durable-chat-runtime.js';
import { configurationAdapter } from '../../src/app.service.js';
import { sessionIdFor } from '../../src/chat-runtime/identity.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-first-foundation.js';
import { ReferencedContextAssembler } from '../../src/context/referenced-context-assembler.js';
import { COMPACTION_SECTIONS } from '../../src/context/compaction-prompt.js';
import type { AccountingRecord } from '../../src/contracts/metadata.js';
import type { ActiveSummaryRecord } from '../../src/contracts/agent-memory.js';
import type { MemoryWebRecord } from '../../src/persistence/memory-web-records.js';
import { loadBootstrapConfig } from '../../src/platform/config/bootstrap-config.js';
import { buildRuntimeSnapshot } from '../../src/platform/config/manageable-config.js';

const assets = {
  instructions: 'System prompt.',
  knowledge: 'Product knowledge.',
  instructionVersion: 'inst-1',
  knowledgeContentHash: 'know-1',
  graphSchemaVersion: 'graph-1',
};

function summaryPayload(tag = 'Summary details.'): string {
  return `<summary>\n${COMPACTION_SECTIONS.map((h, i) => `${i + 1}. ${h}:\n${tag}`).join('\n\n')}\n</summary>`;
}

function sseText(id: string, content: string, promptTokens = 200): Response {
  const frames = [
    { id, model: 'openai/gpt-4o-mini', choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: 40, cost: 0.001 } },
  ];
  return new Response(`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function createRuntimeHarness(options?: {
  maxHistoryTokens?: number;
  maxContextTokens?: number;
  fetcherImpl?: typeof fetch;
}) {
  const bootstrap = loadBootstrapConfig({ PERSISTENCE_PROFILE: 'native-mongodb', MONGODB_URI: 'fixture-only' });
  const limits = {
    modelId: 'openai/gpt-4o-mini',
    contextTokens: 128_000,
    outputTokens: 4096,
    supportsMaxTokens: true,
    outputCapParameter: 'max_tokens' as const,
    source: 'catalogue' as const,
    tools: true,
  };
  const baseSnapshot = buildRuntimeSnapshot(
    bootstrap,
    {
      revision: 1,
      settings: {
        ...bootstrap.safety,
        openRouter: { modelId: 'openai/gpt-4o-mini', reasoningEffort: 'none', dataCollection: 'deny', disableTransforms: true },
        chat: {
          maxInputChars: 4000,
          maxInputTokens: 1500,
          maxMessageBytes: 64_000,
          maxMessagesInContext: 80,
          maxHistoryTokens: options?.maxHistoryTokens ?? 400,
          maxOutputTokens: 256,
          maxContextTokens: options?.maxContextTokens ?? 4096,
          titleMaxChars: 80,
        },
        compaction: { enabled: true, watermarkRatio: 0.8, modelMode: 'active-fork', customModelId: null },
        voice: { enabled: true, maxSessionMinutes: 15, maxTurnAudioSeconds: 30, ttsVoice: 'aura-2-thalia-en', sttModel: 'flux-general-en' },
        personalization: { tone: 'neutral', responseLength: 'balanced', customInstructions: '' },
        calendar: { enabled: false, processingPolicyId: 'native-local.v1' },
      },
      credentials: { openrouter: 'sk-test-key', deepgram: 'dg-test-key' },
    },
    limits,
  );
  const snapshot = Object.freeze({ ...baseSnapshot, compactionModelLimits: limits });
  const accounting: AccountingRecord[] = [];
  const summaries = new Map<string, ActiveSummaryRecord>();
  const saver = new MemorySaver();
  const dbReads = vi.fn();
  const persistence = {
    owner: {
      executorId: 'exec-1',
      store: null,
      acquire: async () => ({ userId: 'user-1', sessionId: 's', ownerId: 'exec-1', generation: 1, leaseExpiresAt: '2026-10-06T13:00:00.000Z' }),
      run: async (_l: unknown, fn: () => Promise<unknown>) => fn(),
      release: async () => undefined,
      drain: async () => ({ drained: true, active: 0, unresolvedWrites: 0 }),
    },
    sessions: { get: async () => { dbReads('sessions.get'); return null; } },
    memory: { budgets: snapshot.budgets, get: async () => { dbReads('memory.get'); return null; }, put: async () => undefined },
    messages: {
      budgets: snapshot.budgets,
      getReferences: async () => { dbReads('messages.getReferences'); return []; },
      listForContext: async () => { dbReads('messages.listForContext'); return { items: [], olderAvailable: false, nextCursor: null }; },
    },
    metadata: {
      budgets: snapshot.budgets,
      putAccounting: async (rec: AccountingRecord) => { accounting.push(rec); },
      putCompactionSummary: async (rec: ActiveSummaryRecord) => { summaries.set(rec.summaryId, rec); },
      getCompactionSummary: async (_u: string, _s: string, id: string) => summaries.get(id) ?? null,
      redactCompactionSummary: async () => null,
    },
    calendarProposals: { getCurrentSlot: async () => null },
    checkpoints: { create: async () => saver },
  } as never;

  const fetcher = options?.fetcherImpl ?? (async (_u, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const isCompaction = body.messages.at(-1)?.content.includes('compacting conversation memory');
    return isCompaction
      ? sseText('gen-compact', summaryPayload())
      : sseText('gen-chat', 'Assistant reply.');
  });

  const runtime = new DurableChatRuntime({
    config: configurationAdapter(bootstrap, snapshot),
    persistence,
    assembler: new ReferencedContextAssembler({
      memory: (persistence as { memory: unknown }).memory as never,
      messages: (persistence as { messages: unknown }).messages as never,
      metadata: (persistence as { metadata: unknown }).metadata as never,
      assets,
      budgets: snapshot.budgets,
    }),
    assets,
    limits,
    currentConfig: { current: () => snapshot, revision: () => snapshot.revision },
    fetcher,
    now: () => Date.parse('2026-10-06T12:00:00.000Z'),
    memoryFirst: {
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async (e) => ({ kind: 'saved', epoch: e.epoch, sessionId: e.sessionId, version: e.version, fence: e.fence }),
      voice: true,
    },
  });
  return { runtime, accounting, dbReads, snapshot };
}

describe('DurableChatRuntime async compaction & burst fallback', () => {
  it('runs async compaction at 80%, preserves concurrent K+1 turns, and incurs zero pre-model DB reads', async () => {
    let releaseCompaction!: () => void;
    let resolveStarted!: () => void;
    const startedSignal = new Promise<void>((r) => { resolveStarted = r; });

    const { runtime, accounting, dbReads } = createRuntimeHarness({
      maxHistoryTokens: 250,
      fetcherImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        const isCompaction = body.messages.at(-1)?.content.includes('compacting conversation memory');
        if (isCompaction) {
          resolveStarted();
          await new Promise<void>((r) => { releaseCompaction = r; });
          return sseText('gen-cmp-async', summaryPayload('Async condensed 0..K'));
        }
        return sseText('gen-chat', 'A'.repeat(180));
      },
    });

    let sessionId: string | null = null;
    for (let i = 0; i < 4; i++) {
      const sub = await runtime.submitTurn({
        identity: { userId: 'user-1', source: 'local-default' },
        sessionId,
        content: `Question ${i}: ${'x'.repeat(140)}`,
        idempotencyKey: `k-${i}`,
      });
      sessionId = sub.sessionId;
      await runtime.executeTurn({
        userId: 'user-1',
        sessionId,
        turnId: sub.turnId,
        attemptId: sub.attemptId,
        signal: new AbortController().signal,
        emit: async () => undefined,
      });
    }

    await startedSignal;
    const concurrentSub = await runtime.submitTurn({
      identity: { userId: 'user-1', source: 'local-default' },
      sessionId,
      content: 'Concurrent turn while compacting',
      idempotencyKey: 'k-concurrent',
    });
    const concurrentEvents: string[] = [];
    await runtime.executeTurn({
      userId: 'user-1',
      sessionId: sessionId!,
      turnId: concurrentSub.turnId,
      attemptId: concurrentSub.attemptId,
      signal: new AbortController().signal,
      emit: async (e) => { concurrentEvents.push((e as { event: { type: string } }).event.type); },
    });

    expect(dbReads).not.toHaveBeenCalled();
    expect(concurrentEvents).toContain('completed');

    releaseCompaction();
    await runtime.drain(2000);
    const compactedMsgs = runtime.memoryMessages('user-1', sessionId!, { cursor: null, limit: 50 });
    expect(compactedMsgs?.compaction?.compactionCycle).toBeGreaterThanOrEqual(1);
    expect(compactedMsgs?.items.some((m) => m.content === 'Concurrent turn while compacting')).toBe(true);
    expect(accounting.some((a) => a.purpose === 'compaction')).toBe(true);
  });

  it('resolves Stage 1 web-tool payload bloat by folding without triggering model compaction, and falls back through inline + physical floor', async () => {
    const modelBodies: Record<string, unknown>[] = [];
    const { runtime, accounting } = createRuntimeHarness({
      maxHistoryTokens: 220,
      maxContextTokens: 4096,
      fetcherImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        modelBodies.push(body);
        const isCompaction = body.messages.at(-1)?.content.includes('compacting conversation memory');
        return isCompaction
          ? sseText('gen-cmp-inline', summaryPayload('Tight'))
          : sseText('gen-chat', 'B'.repeat(80));
      },
    });

    // Seed turn 0 with bulky web tool group stored in foundation baseWeb via complete().
    const sub0 = await runtime.submitTurn({
      identity: { userId: 'user-1', source: 'local-default' },
      sessionId: null,
      content: 'Short question 0',
      idempotencyKey: 'fold-0',
    });
    const memoryText = runtime['memoryOwners'].get('user-1')!;
    const turn0 = memoryText.foundation.find(sub0.sessionId, 'fold-0')!;
    const bulkyWeb: MemoryWebRecord = {
      schemaVersion: 1,
      kind: 'memory-web',
      userId: 'user-1',
      sessionId: sub0.sessionId,
      turnId: sub0.turnId,
      attemptId: sub0.attemptId,
      groups: [{
        assistant: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'wt-1', type: 'function', function: { name: 'web_tool', arguments: '{"query":"big"}' } }],
        },
        results: [{ role: 'tool', tool_call_id: 'wt-1', content: JSON.stringify({ snippet: 'W'.repeat(900) }) }],
      }],
      state: { sources: [], activities: [] },
    };
    memoryText.foundation.complete(turn0, {
      status: 'completed',
      content: 'Short answer 0',
      accounting: null,
      delivery: null,
      web: bulkyWeb,
    });
    await memoryText.foundation.flushSession(sub0.sessionId);

    // Stage 1 folds bulky web tool result so follow-up fits without compaction model call.
    const sub1 = await runtime.submitTurn({
      identity: { userId: 'user-1', source: 'local-default' },
      sessionId: sub0.sessionId,
      content: 'Follow-up after bulky web tool',
      idempotencyKey: 'fold-1',
    });
    await runtime.executeTurn({
      userId: 'user-1',
      sessionId: sub0.sessionId,
      turnId: sub1.turnId,
      attemptId: sub1.attemptId,
      signal: new AbortController().signal,
      emit: async () => undefined,
    });
    expect(accounting.some((a) => a.purpose === 'compaction')).toBe(false);

    // Push past history budget so Stage 3 inline compaction fires cleanly, then hit Stage 4 physical floor.
    let sid = sub0.sessionId;
    for (let i = 2; i <= 5; i++) {
      const s = await runtime.submitTurn({
        identity: { userId: 'user-1', source: 'local-default' },
        sessionId: sid,
        content: `Turn ${i} ${'z'.repeat(140)}`,
        idempotencyKey: `burst-${i}`,
      });
      await runtime.executeTurn({
        userId: 'user-1',
        sessionId: sid,
        turnId: s.turnId,
        attemptId: s.attemptId,
        signal: new AbortController().signal,
        emit: async () => undefined,
      });
    }
    expect(accounting.some((a) => a.purpose === 'compaction')).toBe(true);

    const huge = await runtime.submitTurn({
      identity: { userId: 'user-1', source: 'local-default' },
      sessionId: null,
      content: 'h'.repeat(12_000),
      idempotencyKey: 'burst-floor',
    });
    await expect(runtime.executeTurn({
      userId: 'user-1',
      sessionId: huge.sessionId,
      turnId: huge.turnId,
      attemptId: huge.attemptId,
      signal: new AbortController().signal,
      emit: async () => undefined,
    })).rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
  });

  it('compacts silently in Live Voice without emitting context-state or speaking summary text', async () => {
    const { runtime, accounting } = createRuntimeHarness({ maxHistoryTokens: 150 });
    const spokenDeltas: string[] = [];
    const wireEvents: string[] = [];
    const seedId = sessionIdFor('user-1', null, 'voice-0');
    const reservation = await runtime.reservations.acquire({
      identity: { userId: 'user-1', source: 'local-default' },
      conversationId: seedId,
      owner: { kind: 'live', voiceSessionId: 'vs-1' },
    });

    let sessionId: string | null = null;
    for (let i = 0; i < 3; i++) {
      const sub = await runtime.submitLiveTurn({
        identity: { userId: 'user-1', source: 'local-default' },
        sessionId: sessionId ?? seedId,
        freshConversation: i === 0,
        content: `Voice turn ${i} ${'v'.repeat(160)}`,
        idempotencyKey: `voice-${i}`,
        reservation,
        voice: { voiceSessionId: 'vs-1', socketEpoch: 1, providerTurnId: `pv-${i}` },
      });
      sessionId = sub.sessionId;
      await runtime.executeTurn({
        userId: 'user-1',
        sessionId,
        turnId: sub.turnId,
        attemptId: sub.attemptId,
        signal: new AbortController().signal,
        emit: async (e) => { wireEvents.push((e as { event: { type: string } }).event.type); },
        live: {
          reservation,
          start: async () => undefined,
          delta: async (delta) => { spokenDeltas.push(delta); },
          finish: async () => undefined,
          settle: async () => undefined,
        },
      });
    }
    await runtime.drain(2000);

    expect(wireEvents).not.toContain('context-state');
    expect(spokenDeltas.join('')).not.toContain('<summary>');
    expect(accounting.some((a) => a.purpose === 'compaction')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run in `backend/`:
```bash
npm test -- test/runtime/compaction-runtime.spec.ts
```
Expected: FAIL (no async 80% trigger, no `CompactionRunner` integration, no 4-stage burst fallback, no `context-state` / `compaction` telemetry).

- [ ] **Step 3: Implement async compaction engine, orphan pruning, 4-stage burst fallback, and Calendar invalidation wiring**

1. **`backend/src/chat-runtime/memory-text.ts`:**
   - Extend `Cold` with `compaction?: { running: Promise<void> | null; abort: AbortController | null; pending: { summary: ActiveSummaryRecord; checkpoint: CompactionCheckpointMeta; forVersion: number } | null; failures: number; cooldownUntil: number }`.
   - Track active background tasks in `private readonly compactionJobs = new Set<Promise<void>>()` and construct a single `CompactionRunner` with `putAccounting: this.d.persistence.metadata.putAccounting.bind(this.d.persistence.metadata)`, `this.d.fetcher`, `() => this.runtime.now()`, and `this.d.diagnostics?.emit`.
   - `buildTurnsForSession(sessionId, records, snapshot, cold)`: groups `records` by `turnId`, extracts exact `prefix: WebNativeMessage[]` via `ReferencedContextAssembler` on an empty turn with relaxed limits (stripping trailing empty synthetic input) + `catalogIndex` prefix matching `calendarContext`, and joins historical `webGroups` + `calendarGroups` into `CompactionTurn[]`.
   - `resolveCalendarProvenance(...)`: merges unredacted `baseSummary.calendarProvenance`, compacted `records.sourceProvenance`, and compacted `cold.groups`; computes earliest expiry and redacts if disconnected, mismatched, or expired at `nowMs`.
   - `tryPromotePendingCompaction(sessionId, activeTurn?)`: promotes `cold.compaction.pending` via `foundation.promoteCompaction` (idle) or `foundation.rebaseActiveTurnForCompaction` (Stage 2/3 inline), immediately prunes `cold.groups` and `cold.webGroups` strictly to `promoted.tailTurnIds`, and drops settled compacted `this.entries`/`cold.attempts` (`sequence <= toSequence`).
   - `scheduleCompactionIfNeeded(sessionId, snapshot)`: called after `finish()` and `publishPromoted()` for ALL modes (text & Live Voice). Checks `enabled`, not running, past exponential backoff `cooldownUntil`, utilization `>= watermarkRatio`, computes cutpoint via `selectCompactionCutpoint(..., { minTailTurns: 3, pinnedTurnIds })` (pinning open unexpired `pendingProposal.originatingTurnId`), stages into `cold.compaction.pending` (redacting Calendar content if binding changed while in flight), and promotes if `!foundation.session(sessionId).active`.
   - `submit()`: calls `tryPromotePendingCompaction(sessionId)` before `foundation.accept(...)` when idle.
   - `execute()` orphan pruning + 4-stage burst fallback + seal preservation + SSE projections:
     - Prune `historicalWebGroups` and `historicalGroups` (`lines 1469-1472, 1503-1506`) strictly to `new Set(source.records.map(r => r.turnId))` after `delete(c.turnId)`.
     - On `assembler.assemble(...)` overflow or downstream Calendar/Web pre-dispatch context overflow:
       - **Stage 1 (Tool folding):** Fold bulky historical tool payloads via `foldToolPayloads` before `protectedTailIndex` (preserving `protectedToolCallIds` for open proposals; never feeding folded data into `assertV2Provenance`). Dispatch if within original `snapshot.budgets`.
       - **Stage 2 (Await in-flight job):** If `cold.compaction?.running`, await bounded by `totalRunTimeoutMs` / `job.signal`, promote via `tryPromotePendingCompaction(c.sessionId, e.turn)`, rebind `e.turn`, re-fetch `source = foundation.context(e.turn)`, re-prune tool groups, and re-assemble.
       - **Stage 3 (Inline fallback):** Run ONE synchronous compaction pass via `CompactionRunner`, promote via `rebaseActiveTurnForCompaction`, rebind `e.turn`, re-prune tool groups, and re-assemble.
       - **Stage 4 (Physical floor):** Still overflowing -> throw `AppError('CONTEXT_BUDGET_EXCEEDED', overflow.message, false)`.
     - Preserve `source.manifest.activeSummaryRef` in all 3 `buildReferenceManifest` target builds in `execute` (lines `1655`, `1807`, `1846`).
     - When `!c.live`, emit `{ type: 'context-state', compaction, contextUsage }` right before terminal `status` (`line 1903`) and attach `compaction`/`contextUsage` on `{ type: 'completed' }` (`line 1905`); suppress completely when `c.live`.
   - `invalidateCalendarAccount(account, reason)`: redacts `cold.compaction.pending?.summary`, aborts/redacts in-flight Calendar-bearing jobs, and forwards to `foundation.invalidateCalendarAccount(account)`.
   - `drainCompactions(timeoutMs)`: aborts running compaction controllers and awaits `Promise.allSettled(this.compactionJobs)` bounded by `timeoutMs` (called by `DurableChatRuntime.drain` and `stopPending`).

2. **`backend/src/app.service.ts` (`redactInvalidatedRevision`, lines 772-783):**
   Cursor-page `sessions` with `{ userId: account.userId, 'compactionCheckpoint.summaryId': { $exists: true } }` (using `this.store().owner.store` when present) and call `this.store().metadata.redactCompactionSummary?.(account.userId, sessionId, summaryId, now)` when `connectionId` and `connectionRevision` match.

- [ ] **Step 4: Run full Task 6 & P3 exit-gate verification suite**

Run in `backend/`:
```bash
npm run build
npm run lint
npm test
```
Expected: `npm run build`, `npm run lint`, and `npm test` ALL pass cleanly with zero skips on targeted compaction specs.

- [ ] **Step 5: Orchestrator commit suggestion (do NOT run git directly)**

Report completion of Task 6 files (`memory-text.ts`, `app.service.ts`, `compaction-runtime.spec.ts`) for serialized commit: `feat(runtime): implement async 80% compaction engine, burst fallback, and silent voice compaction`.

---

## Final Verification Checklist (P3 Exit Gate)

- [ ] Run `npm run build` in `backend/` -> exits 0 cleanly.
- [ ] Run `npm run lint` in `backend/` -> exits 0 cleanly.
- [ ] Run `npm test` in `backend/` -> all specs pass, including:
  - `src/admin-config/admin-config.service.spec.ts` (single `/models` validation for `compaction.customModelId` + capacity checks)
  - `src/app.controller.spec.ts` (`compactionModelLimits` populated from single catalogue fetch)
  - `test/runtime/compaction-model.spec.ts` (`CompactionRunner`, active-fork KV prefix/session_id, custom model, `purpose: 'compaction'` accounting)
  - `test/runtime/compaction-foundation.spec.ts` (`>128` turns eviction, concurrent tail preservation, orphan pruning, Calendar redaction, active rebase, `finalization.ts`)
  - `test/runtime/compaction-archive.spec.ts` (`MemoryTextArchive` compaction save CAS & boundary sync)
  - `test/runtime/compaction-hydration.spec.ts` ($O(\text{tail})$ `calendarHistory` & `MemoryText.hydrate`, UI `listPublished` scrollback, `compaction`/`contextUsage`)
  - `test/runtime/compaction-runtime.spec.ts` (zero pre-model DB reads, 80% async trigger, concurrent `K+1`, Stage 1 fold -> Stage 2 await -> Stage 3 inline -> Stage 4 floor, silent Live Voice)
- [ ] Verify NO edits outside P3 owned files and zero unrelated user changes touched (handoff to orchestrator for serialized commit).
