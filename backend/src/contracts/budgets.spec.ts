/**
 * ============================================================================
 * FILE: budgets.spec.ts
 * LOCATION: backend/src/contracts/budgets.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify that resource defaults remain finite and preserve context capacity.
 *
 * ROLE IN PROJECT:
 *    Establishes shared bounded defaults for input, output, persistence,
 *    concurrency, paging, retry, and timeout behavior.
 *
 * KEY COMPONENTS:
 *    - Default budget tests: Enforce positive, finite resource limits.
 *    - Context tests: Reserve output and model margin from history capacity.
 * ============================================================================
 */

import {
  DEFAULT_BUDGETS,
  MIN_HISTORY_TOKENS,
  budgetConfigSchema,
  usableInputTokens,
} from './budgets.js';

describe('DEFAULT_BUDGETS', () => {
  it('uses finite positive limits', () => {
    const parsed = budgetConfigSchema.parse(DEFAULT_BUDGETS);
    for (const [key, value] of Object.entries(parsed)) {
      expect(value, key).toBeGreaterThan(0);
      expect(Number.isFinite(value), key).toBe(true);
    }
  });

  it('enforces one active attempt per session', () => {
    expect(DEFAULT_BUDGETS.maxConcurrentAttemptsPerSession).toBe(1);
  });

  it('reserves output tokens plus a model margin so input is not silently dropped', () => {
    const usable = usableInputTokens(DEFAULT_BUDGETS);
    expect(usable).toBe(
      DEFAULT_BUDGETS.maxContextTokens -
        DEFAULT_BUDGETS.maxOutputTokens -
        DEFAULT_BUDGETS.modelMarginTokens,
    );
    expect(usable).toBeGreaterThan(0);
  });

  it('flows a minimum 10,000-token history budget through the default schema', () => {
    expect(DEFAULT_BUDGETS.maxHistoryTokens).toBe(MIN_HISTORY_TOKENS);
    expect(budgetConfigSchema.safeParse(DEFAULT_BUDGETS).success).toBe(true);
    expect(budgetConfigSchema.safeParse({
      ...DEFAULT_BUDGETS, maxHistoryTokens: MIN_HISTORY_TOKENS - 1,
    }).success).toBe(false);
  });

  it('keeps storage bounds under conservative document headroom', () => {
    expect(DEFAULT_BUDGETS.maxDocumentBytes).toBe(1_800_000);
    expect(DEFAULT_BUDGETS.maxMessageBytes).toBeLessThan(
      DEFAULT_BUDGETS.maxDocumentBytes,
    );
    expect(DEFAULT_BUDGETS.maxManifestBytes).toBeLessThan(
      DEFAULT_BUDGETS.maxDocumentBytes,
    );
    expect(DEFAULT_BUDGETS.maxPageSize).toBeLessThanOrEqual(50);
  });

  it('rejects a budget that would leave no history capacity', () => {
    expect(() =>
      budgetConfigSchema.parse({
        ...DEFAULT_BUDGETS,
        maxContextTokens: 100,
        maxOutputTokens: 80,
        modelMarginTokens: 40,
      }),
    ).toThrow();
  });
});
