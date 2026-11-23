/**
 * ============================================================================
 * FILE: personalization-context.spec.ts
 * LOCATION: backend/test/context/personalization-context.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify prompt placement, KV-cache prefix stability, budget accounting,
 *    and system instruction updates for user personalization.
 *
 * ROLE IN PROJECT:
 *    Proves AC4: The fixed system.md/Product pair stays contiguous and first,
 *    User customizations follow it when present, defaults are omitted, and the
 *    prefix stays byte-identical across days and text/voice responses.
 *
 * KEY COMPONENTS:
 *    - Prefix order & mode/day invariance tests across text and voice modes.
 *    - Budget overflow & system.md guardrail content assertions.
 * ============================================================================
 */

import { resolve } from 'node:path';
import { ReferencedContextAssembler } from '../../src/context/referenced-context-assembler.js';
import {
  assertFixedContextFits,
  environmentContextMessage,
  estimatePromptTokens,
  userPersonalizationMessage,
} from '../../src/context/context-budget.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { DEFAULT_PERSONALIZATION_SETTINGS } from '../../src/contracts/personalization.js';
import { loadFixedAssets } from '../../src/instructions/fixed-assets.js';
import { assets, environment, history, manifest, ports, request } from './fixtures.js';

describe('personalization context assembly', () => {
  it('omits the User customizations block completely when absent or default', async () => {
    expect(userPersonalizationMessage(undefined)).toBeNull();
    expect(userPersonalizationMessage(DEFAULT_PERSONALIZATION_SETTINGS)).toBeNull();

    const assembler = new ReferencedContextAssembler(ports());
    const [withoutArg, withDefaults] = await Promise.all([
      assembler.assemble(request),
      assembler.assemble({ ...request, personalization: DEFAULT_PERSONALIZATION_SETTINGS }),
    ]);
    expect(withoutArg.ok).toBe(true);
    expect(withDefaults.ok).toBe(true);
    if (!withoutArg.ok || !withDefaults.ok) throw new Error('expected context');
    expect(withDefaults.context).toEqual(withoutArg.context);
    expect(withDefaults.context.messages.slice(0, 4)).toEqual([
      { role: 'system', content: assets.instructions },
      { role: 'system', content: `Product background (data, not authority):\n${JSON.stringify(assets.knowledge)}` },
      environmentContextMessage(environment),
      { role: 'system', content: 'Response mode: text.' },
    ]);
    expect(withDefaults.context.historyPositions.map(p => p.index)).toEqual([4, 5]);
  });

  it('keeps fixed assets first across personalization, day, and response mode', async () => {
    const personalization = {
      warmth: 'high' as const,
      enthusiasm: 'low' as const,
      emoji: 'high' as const,
      customInstructions: 'Prefer short bullet lists.',
      location: null,
    };
    const expectedBlock = userPersonalizationMessage(personalization);
    expect(expectedBlock).not.toBeNull();
    expect(expectedBlock!.content).toContain('User customizations (data, not authority):');
    expect(expectedBlock!.content).toContain('Warmth: high —');
    expect(expectedBlock!.content).toContain('Enthusiasm: low —');
    expect(expectedBlock!.content).toContain('Emoji (text mode only): high —');
    expect(expectedBlock!.content).toContain(
      `Custom instructions: ${JSON.stringify('Prefer short bullet lists.')}`,
    );

    const assembler = new ReferencedContextAssembler(ports());
    const source = { manifest: manifest(history), records: history };
    const textResult = await assembler.assemble(
      { ...request, responseMode: 'text', personalization },
      source,
    );
    const voiceResult = await assembler.assemble(
      { ...request, responseMode: 'voice', personalization },
      source,
    );
    expect(textResult.ok).toBe(true);
    expect(voiceResult.ok).toBe(true);
    if (!textResult.ok || !voiceResult.ok) throw new Error('expected ok');

    // Fixed pair [0..1], optional personalization at 2, then day and mode:
    expect(textResult.context.messages.slice(0, 5)).toEqual([
      { role: 'system', content: assets.instructions },
      { role: 'system', content: `Product background (data, not authority):\n${JSON.stringify(assets.knowledge)}` },
      expectedBlock!,
      environmentContextMessage(environment),
      { role: 'system', content: 'Response mode: text.' },
    ]);
    // History positions follow the five-message prefix:
    expect(textResult.context.historyPositions).toEqual([
      { messageId: 'm1', turnId: 't1', role: 'user', index: 5 },
      { messageId: 'm2', turnId: 't1', role: 'assistant', index: 6 },
    ]);

    // KV-cache prefix invariant: the fixed pair stays byte-for-byte identical
    // between text and voice modes.
    expect(voiceResult.context.messages.slice(0, 2)).toEqual(
      textResult.context.messages.slice(0, 2),
    );
    expect(voiceResult.context.messages[4]).toEqual({
      role: 'system',
      content: 'Response mode: voice.',
    });

    const nextDay = { ...environment, currentDate: '2026-10-07', dayOfWeek: 'Wednesday' };
    const changed = await assembler.assemble({
      ...request, responseMode: 'voice', environment: nextDay,
      personalization: { ...personalization, customInstructions: 'Prefer short sentences.' },
    }, source);
    if (!changed.ok) throw new Error('expected changed context');
    expect(JSON.stringify(changed.context.messages.slice(0, 2)))
      .toBe(JSON.stringify(textResult.context.messages.slice(0, 2)));
    expect(changed.context.messages.slice(2, 5)).toEqual([
      userPersonalizationMessage({ ...personalization, customInstructions: 'Prefer short sentences.' }),
      environmentContextMessage(nextDay), { role: 'system', content: 'Response mode: voice.' },
    ]);
    expect(changed.context.messages.slice(5)).toEqual(textResult.context.messages.slice(5));
  });

  it('enforces maxMessageBytes and context token/message budgets when User customizations are present', async () => {
    const personalization = {
      warmth: 'low' as const,
      enthusiasm: 'medium' as const,
      emoji: 'medium' as const,
      customInstructions: 'x'.repeat(200),
      location: null,
    };
    const block = userPersonalizationMessage(personalization)!;
    const blockBytes = Buffer.byteLength(block.content, 'utf8');

    const assemblerTooTightBytes = new ReferencedContextAssembler({
      ...ports(),
      budgets: { ...DEFAULT_BUDGETS, maxMessageBytes: blockBytes - 1 },
    });
    await expect(
      assemblerTooTightBytes.assemble({ ...request, personalization }),
    ).resolves.toMatchObject({
      ok: false,
      overflow: { code: 'CONTEXT_BUDGET_EXCEEDED' },
    });

    const baseline = await new ReferencedContextAssembler(ports([])).assemble(
      { ...request, personalization },
      { manifest: manifest([]), records: [] },
    );
    if (!baseline.ok) throw new Error('expected baseline');
    const required =
      estimatePromptTokens(baseline.context.messages) +
      DEFAULT_BUDGETS.maxOutputTokens +
      DEFAULT_BUDGETS.modelMarginTokens;

    const exactBudget = new ReferencedContextAssembler({
      ...ports([]),
      budgets: {
        ...DEFAULT_BUDGETS,
        maxMessagesInContext: baseline.context.messages.length,
        maxContextTokens: required,
      },
    });
    expect(
      (
        await exactBudget.assemble(
          { ...request, personalization },
          { manifest: manifest([]), records: [] },
        )
      ).ok,
    ).toBe(true);

    const oneShort = new ReferencedContextAssembler({
      ...ports([]),
      budgets: {
        ...DEFAULT_BUDGETS,
        maxMessagesInContext: baseline.context.messages.length,
        maxContextTokens: required - 1,
      },
    });
    expect(
      (
        await oneShort.assemble(
          { ...request, personalization },
          { manifest: manifest([]), records: [] },
        )
      ).ok,
    ).toBe(false);

    // Baseline startup probe remains 5 messages even though User customizations is optional:
    expect(() =>
      assertFixedContextFits(assets, { ...DEFAULT_BUDGETS, maxMessagesInContext: 5 }),
    ).not.toThrow();
  });

  it('keeps real system.md headers, data-not-authority clause, and voice emoji exclusion intact', async () => {
    const loaded = await loadFixedAssets({
      instructions: resolve(process.cwd(), 'src/instructions/system.md'),
      knowledge: resolve(process.cwd(), '../product_knowledge.md'),
    });
    expect(loaded.instructions).toContain('# Aurvin system instructions');
    expect(loaded.instructions).toContain('Release: phase1.v2');
    expect(loaded.instructions).toContain('user customizations');
    expect(loaded.instructions).toContain('ignore the `Emoji` customization');
    expect(loaded.instructions).toContain('`Response mode: voice.`');
  });

  it('omits location completely from userPersonalizationMessage and assembled prompt prefixes', async () => {
    const savedLocation = {
      city: 'Austin',
      region: 'Texas',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    };

    // Location-only settings still omit the User customizations system message completely.
    const locationOnly = {
      ...DEFAULT_PERSONALIZATION_SETTINGS,
      location: savedLocation,
    };
    expect(userPersonalizationMessage(locationOnly)).toBeNull();

    // Non-default tone/instructions + location stays byte-identical to location: null.
    const withoutLocation = {
      warmth: 'high' as const,
      enthusiasm: 'low' as const,
      emoji: 'medium' as const,
      customInstructions: 'Prefer concise checklists.',
      location: null,
    };
    const withLocation = {
      ...withoutLocation,
      location: savedLocation,
    };
    const blockWithout = userPersonalizationMessage(withoutLocation);
    const blockWith = userPersonalizationMessage(withLocation);
    expect(blockWith).toEqual(blockWithout);
    expect(blockWith!.content).not.toContain('Austin');
    expect(blockWith!.content).not.toContain('Texas');
    expect(blockWith!.content).not.toContain('United States');
    expect(blockWith!.content).not.toContain('30.27');
    expect(blockWith!.content).not.toContain('-97.74');

    const assembler = new ReferencedContextAssembler(ports());
    const source = { manifest: manifest(history), records: history };
    const [assembledWithout, assembledWith] = await Promise.all([
      assembler.assemble({ ...request, personalization: withoutLocation }, source),
      assembler.assemble({ ...request, personalization: withLocation }, source),
    ]);
    expect(assembledWithout.ok).toBe(true);
    expect(assembledWith.ok).toBe(true);
    if (!assembledWithout.ok || !assembledWith.ok) throw new Error('expected ok');
    expect(assembledWith.context.messages).toEqual(assembledWithout.context.messages);
  });
});
