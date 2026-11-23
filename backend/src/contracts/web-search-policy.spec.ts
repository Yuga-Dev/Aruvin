/**
 * ============================================================================
 * FILE: web-search-policy.spec.ts
 * LOCATION: backend/src/contracts/web-search-policy.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify fixed web-search policy values and pure advertisement/repair decisions.
 *
 * ROLE IN PROJECT:
 *    Protects the shared bounds consumed by the provider, runtime, and frontend
 *    workers before any network, storage, or model dispatch exists.
 *
 * KEY COMPONENTS:
 *    - Policy defaults: Default-off, 5/5 limits, provider order, nested deadlines.
 *    - Pure decisions: Advertisement gating and bounded schema-repair allowance.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_SEARCH_ENABLED, DEFAULT_WEB_SEARCH_LIMITS, WEB_SEARCH_POLICY,
  WEB_SEARCH_PROVIDERS, canRepairWebSchema, shouldAdvertiseWebTool, webModelAttemptLimit,
} from './web-search-policy.js';

describe('webSearch fixed policy', () => {
  it('freezes default off, 5/5, provider order and finite nested deadlines', () => {
    expect(DEFAULT_WEB_SEARCH_ENABLED).toBe(false);
    expect(DEFAULT_WEB_SEARCH_LIMITS).toEqual({ maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 });
    expect(Object.isFrozen(DEFAULT_WEB_SEARCH_LIMITS)).toBe(true);
    expect(WEB_SEARCH_PROVIDERS).toEqual(['tinyfish', 'keenable', 'exa', 'tavily', 'firecrawl']);
    expect(WEB_SEARCH_POLICY).toMatchObject({
      maxSchemaRepairAttemptsPerTurn: 3, maxProviderFallbackAttemptsPerCall: 5,
      maxAttemptsPerProviderPerCall: 1, mcpConnectTimeoutMs: 4000,
      providerCallTimeoutMs: 12000, logicalCallTimeoutMs: 25000,
      turnDeadlineMs: 45000, maxMcpWireResponseBytes: 524288,
    });
    expect(webModelAttemptLimit(DEFAULT_WEB_SEARCH_LIMITS)).toBe(15);
    expect(webModelAttemptLimit({ maxSearchesPerTurn: 20, maxFetchesPerTurn: 20 })).toBe(45);
  });

  it.each([
    [false, true, true, false], [true, false, true, false],
    [true, true, false, false], [true, true, undefined, false],
    [true, true, true, true],
  ] as const)('advertises only for enabled=%s eligible=%s tools=%s', (enabled, eligible, tools, expected) => {
    expect(shouldAdvertiseWebTool({ enabled, hasEligibleProvider: eligible, modelSupportsTools: tools }))
      .toBe(expected);
  });

  it('advertises a status-only tool only for an enabled account with rejected saved credentials', () => {
    expect(shouldAdvertiseWebTool({
      enabled: true, hasEligibleProvider: false, credentialsRejected: true, modelSupportsTools: true,
    })).toBe(true);
    expect(shouldAdvertiseWebTool({
      enabled: true, hasEligibleProvider: false, credentialsRejected: true, modelSupportsTools: false,
    })).toBe(false);
    expect(shouldAdvertiseWebTool({
      enabled: false, hasEligibleProvider: false, credentialsRejected: true, modelSupportsTools: true,
    })).toBe(false);
    expect(shouldAdvertiseWebTool({
      enabled: true, hasEligibleProvider: false, modelSupportsTools: true,
    })).toBe(false);
  });

  it('permits exactly three additional schema repair model requests', () => {
    const state = { modelAttemptsRemaining: 10, hasContextHeadroom: true, deadlineRemainingMs: 1000 };
    let schemaRepairsUsed = 0;
    const repairDispatches: number[] = [];
    while (canRepairWebSchema({ ...state, schemaRepairsUsed })) {
      repairDispatches.push(++schemaRepairsUsed);
    }
    expect(repairDispatches).toEqual([1, 2, 3]);
    expect(schemaRepairsUsed).toBe(3);
    for (const count of [-1, 3, 4, 1.5, Number.NaN, Infinity]) {
      expect(canRepairWebSchema({ ...state, schemaRepairsUsed: count })).toBe(false);
    }
    expect(canRepairWebSchema({ ...state, schemaRepairsUsed: 0, modelAttemptsRemaining: 0 })).toBe(false);
    expect(canRepairWebSchema({ ...state, schemaRepairsUsed: 0, hasContextHeadroom: false })).toBe(false);
    expect(canRepairWebSchema({ ...state, schemaRepairsUsed: 0, deadlineRemainingMs: 0 })).toBe(false);
  });
});
