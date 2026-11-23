/**
 * ============================================================================
 * FILE: history-budget.spec.ts
 * LOCATION: backend/test/context/history-budget.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the explicit history budget and the assets-derived context floor.
 *
 * ROLE IN PROJECT:
 *    Locks the fail-closed prefix/history split, the 10,000-token admission
 *    minimum, the conservative prefix estimator, and fresh-install defaults.
 *
 * KEY COMPONENTS:
 *    - checkContextBudget: Prefix/history boundary and history overflow message.
 *    - computeChatFloor: Maximum personalization plus worst-case tool schemas.
 *    - assertChatFloor / projectPublicAdminConfig: Strict total and fresh defaults.
 * ============================================================================
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGETS, MIN_HISTORY_TOKENS, budgetConfigSchema } from '../../src/contracts/budgets.js';
import { manageableSettingsSchema } from '../../src/contracts/admin-config.js';
import { isPublicAdminConfig } from '../../src/contracts/admin-config-wire.js';
import { SKILL_NATIVE_TOOLS } from '../../src/contracts/calendar-tools.js';
import { UPDATE_USER_MEMORY_TOOL_DEFINITION } from '../../src/contracts/user-memory.js';
import { WEB_TOOL_DEFINITION } from '../../src/contracts/web-search-tools.js';
import { nativeToolDefinitions } from '../../src/model/calendar-policy.js';
import {
  checkContextBudget,
  estimateMessagesTokens,
  HISTORY_BUDGET_MESSAGE,
} from '../../src/context/context-budget.js';
import { admitNativePrompt, webContext, type HistoricalWebResult } from '../../src/context/web-context.js';
import { webToolGroupSchema } from '../../src/chat-runtime/memory-web-state.js';
import {
  assertChatFloor,
  computeChatFloor,
} from '../../src/context/prefix-estimate.js';
import { defaultManageableSettings, projectPublicAdminConfig } from '../../src/platform/config/manageable-config.js';
import { loadFixedAssets } from '../../src/instructions/fixed-assets.js';
import { assets } from './fixtures.js';

const realAssets = await loadFixedAssets({
  instructions: resolve(process.cwd(), 'src/instructions/system.md'),
  knowledge: resolve(process.cwd(), '../product_knowledge.md'),
});

function historyOf(exactTokens: number): { role: 'user'; content: string }[] {
  const overhead = estimateMessagesTokens([{ role: 'user', content: '' }]);
  return [{ role: 'user', content: 'x'.repeat(exactTokens - overhead) }];
}

describe('configured history minimum', () => {
  it('rejects 9,999 and accepts 10,000 through the manageable schema', () => {
    const settings = defaultManageableSettings();
    const withHistory = (maxHistoryTokens: number) => ({
      ...settings, chat: { ...settings.chat, maxHistoryTokens },
    });
    expect(manageableSettingsSchema.safeParse(withHistory(MIN_HISTORY_TOKENS - 1)).success).toBe(false);
    expect(manageableSettingsSchema.safeParse(withHistory(MIN_HISTORY_TOKENS)).success).toBe(true);
    expect(budgetConfigSchema.safeParse({
      ...DEFAULT_BUDGETS, maxHistoryTokens: MIN_HISTORY_TOKENS - 1,
    }).success).toBe(false);
  });
});

describe('runtime history boundary', () => {
  it('accepts a 10,000-token history and rejects one token more', () => {
    const atLimit = historyOf(MIN_HISTORY_TOKENS);
    const overLimit = historyOf(MIN_HISTORY_TOKENS + 1);
    const budgets = { ...DEFAULT_BUDGETS, maxContextTokens: 200_000 };
    expect(checkContextBudget(atLimit, budgets, 0)).toBeNull();
    expect(checkContextBudget(overLimit, budgets, 0)).toMatchObject({
      code: 'CONTEXT_BUDGET_EXCEEDED',
      message: HISTORY_BUDGET_MESSAGE,
    });
  });

  it('excludes the explicit prefix from the history estimate', () => {
    const prefix = [{ role: 'system' as const, content: 'p'.repeat(30_000) }];
    const history = historyOf(MIN_HISTORY_TOKENS);
    const budgets = { ...DEFAULT_BUDGETS, maxContextTokens: 200_000 };
    expect(checkContextBudget([...prefix, ...history], budgets, 1)).toBeNull();
    // Without the boundary the same prompt would be treated as history-only.
    expect(checkContextBudget([...prefix, ...history], budgets, 0)).toMatchObject({
      message: HISTORY_BUDGET_MESSAGE,
    });
  });

  it('rejects history even when the total prompt would fit', () => {
    const messages = [
      { role: 'system' as const, content: 'rules' },
      ...historyOf(MIN_HISTORY_TOKENS + 1),
    ];
    const budgets = { ...DEFAULT_BUDGETS, maxContextTokens: 1_000_000 };
    expect(checkContextBudget(messages, budgets, 1)).toMatchObject({
      code: 'CONTEXT_BUDGET_EXCEEDED',
      message: HISTORY_BUDGET_MESSAGE,
    });
  });

  it('counts current web tool results toward the history limit', () => {
    const group = (ordinal: number) => ({
      ordinal, afterCalendarGroups: 0,
      assistant: { role: 'assistant' as const, content: null,
        tool_calls: [{ id: `web_large_${ordinal}`, type: 'function' as const,
          function: { name: 'web_tool' as const, arguments: '{"mode":"browse","query":"news"}' } }] },
      result: { role: 'tool' as const, tool_call_id: `web_large_${ordinal}`, name: 'web_tool' as const,
        content: JSON.stringify({ truncated: false, results: [{ url: 'https://example.com/',
          title: 'Example', body: 'x'.repeat(4_000) }] }) },
      sources: [],
    });
    expect(() => webContext({
      calendarMessages: [{ role: 'system', content: 'prefix' }, { role: 'user', content: 'q' }],
      webGroups: [group(0), group(1), group(2)],
      budgets: { ...DEFAULT_BUDGETS, maxContextTokens: 1_000_000 },
      contextTokens: 1_000_000,
      tools: [WEB_TOOL_DEFINITION],
      prefixCount: 1,
    })).toThrowError(expect.objectContaining({
      code: 'CONTEXT_BUDGET_EXCEEDED',
      message: HISTORY_BUDGET_MESSAGE,
    }));
  });
});

describe('native prompt admission', () => {
  it('folds only the newest necessary stale Web result, never a pinned or recent one', () => {
    const make = (i: number) => {
      const url = `https://example.test/${i}`;
      return webToolGroupSchema.parse({
        ordinal: 0, afterCalendarGroups: 0,
        assistant: { role: 'assistant', content: null, tool_calls: [{
          id: 'same-call', type: 'function',
          function: { name: 'web_tool', arguments: JSON.stringify({ mode: 'fetch', url }) },
        }] },
        result: { role: 'tool', name: 'web_tool', tool_call_id: 'same-call',
          content: JSON.stringify({ url, truncated: false, body: 'w'.repeat(1_600) }) },
        sources: [{ sourceId: `source-${i}`, toolCallId: 'same-call', url, title: `Title ${i}`,
          kind: 'fetch', provider: 'exa', retrievedAt: '2026-11-14T00:00:00.000Z' }],
      });
    };
    const groups = Array.from({ length: 7 }, (_, i) => make(i));
    const user = { role: 'user' as const, content: 'Identical accepted input' };
    const messages = groups.flatMap(g => [user, g.assistant, g.result]);
    const historicalWebResults: HistoricalWebResult[] = groups.slice(0, -1).map((group, i) => ({
      group, turnId: `t${i}`, resultIndex: i * 3 + 2,
    }));
    const size = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 32 * messages.length;
    const budgets = { maxHistoryTokens: size - 400, maxContextTokens: 24_000,
      maxOutputTokens: 100, modelMarginTokens: 100, maxMessagesInContext: 80 };
    const input = { messages, prefixCount: 0, tools: [WEB_TOOL_DEFINITION], budgets,
      contextTokens: 24_000, historicalWebResults, foldableTurnIds: new Set(['t0', 't1']) };
    const admitted = admitNativePrompt(input);
    expect(admitted.messages.slice(0, 5)).toEqual(messages.slice(0, 5));
    expect(admitted.messages[5]).toMatchObject({ name: 'web_tool', tool_call_id: 'same-call',
      content: expect.stringContaining('"kind":"folded-web-result"') });
    expect(admitted.messages.slice(6)).toEqual(messages.slice(6));
    expect(admitNativePrompt({ ...input, budgets: { ...budgets, maxHistoryTokens: size } }).messages).toBe(messages);
    expect(() => admitNativePrompt({ ...input, budgets: { ...budgets, maxMessagesInContext: 20 } }))
      .toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
    expect(() => admitNativePrompt({ ...input, foldableTurnIds: new Set(['t3', 't4', 't5']) }))
      .toThrowError(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
  });
});

describe('derived context floor', () => {
  it('reserves maximum personalization and worst-case tool schemas', () => {
    const floor = computeChatFloor(assets, defaultManageableSettings().chat);
    expect(floor.breakdown.personalization).toBeGreaterThanOrEqual(6_000);
    expect(floor.breakdown.tools).toBe(Buffer.byteLength(JSON.stringify([
      ...nativeToolDefinitions(SKILL_NATIVE_TOOLS), WEB_TOOL_DEFINITION,
      UPDATE_USER_MEMORY_TOOL_DEFINITION,
    ]), 'utf8'));
    expect(floor.prefixTokens).toBe(
      floor.breakdown.fixed + floor.breakdown.personalization + floor.breakdown.tools);
    expect(floor.minContextTokens).toBe(
      floor.prefixTokens + floor.historyTokens + floor.reserves.maxOutputTokens +
      floor.reserves.modelMarginTokens);
    // The estimator never depends on an enabled plugin set.
    expect(floor.breakdown.tools).toBeGreaterThan(2_000);
    expect(SKILL_NATIVE_TOOLS.some(t => t.name === 'get_environment')).toBe(true);
  });

  it('rejects a total below the floor and accepts the floor and floor + 1', () => {
    const chat = defaultManageableSettings().chat;
    const floor = computeChatFloor(assets, chat);
    expect(() => assertChatFloor(assets, {
      ...chat, maxContextTokens: floor.minContextTokens - 1,
    })).toThrow(/maxContextTokens must be at least/);
    expect(assertChatFloor(assets, {
      ...chat, maxContextTokens: floor.minContextTokens,
    }).minContextTokens).toBe(floor.minContextTokens);
    expect(assertChatFloor(assets, {
      ...chat, maxContextTokens: floor.minContextTokens + 1,
    }).minContextTokens).toBe(floor.minContextTokens);
  });

  it('includes get_environment policy in real system instructions and keeps fixed context within budgets', () => {
    expect(realAssets.instructions).toContain('<environment_tool_policy>');
    expect(realAssets.instructions).toContain('get_environment');
    expect(realAssets.instructions).toContain('validForCurrentTurnOnly');
    const floor = computeChatFloor(realAssets, defaultManageableSettings().chat);
    expect(floor.breakdown.tools).toBeGreaterThan(2_500);
    expect(() => assertChatFloor(realAssets, {
      ...defaultManageableSettings().chat,
      maxContextTokens: floor.minContextTokens,
    })).not.toThrow();
  });

  it('computes a fresh-install default total from real assets, not 16,384', () => {
    const floor = computeChatFloor(realAssets, defaultManageableSettings().chat);
    const pub = projectPublicAdminConfig(null, null, 'unconfigured', realAssets);
    expect(floor.minContextTokens).toBeGreaterThan(DEFAULT_BUDGETS.maxContextTokens);
    expect(pub.chatFloor).toEqual(floor);
    expect(pub.settings.chat.maxContextTokens).toBe(floor.minContextTokens);
    expect(isPublicAdminConfig(pub)).toBe(true);
    expect(() => assertChatFloor(realAssets, pub.settings.chat)).not.toThrow();
  });

  it('raises the floor with a 15,000-token history budget', () => {
    const floor = computeChatFloor(assets, {
      ...defaultManageableSettings().chat, maxHistoryTokens: 15_000,
    });
    expect(floor.minContextTokens).toBe(
      floor.prefixTokens + 15_000 + floor.reserves.maxOutputTokens +
      floor.reserves.modelMarginTokens);
  });
});
