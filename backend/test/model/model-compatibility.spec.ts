/**
 * ============================================================================
 * FILE: model-compatibility.spec.ts
 * LOCATION: backend/test/model/model-compatibility.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify pure OpenRouter catalogue compatibility evaluation and effort metadata.
 *
 * ROLE IN PROJECT:
 *    Tests deterministic model capability, capacity, output-cap, effort,
 *    context-floor, and optional-tool pricing rules without HTTP or inference.
 *
 * KEY COMPONENTS:
 *    - catalogueEfforts tests: Absent, null, mandatory, and malformed reasoning metadata.
 *    - evaluateModelCompatibility tests: Blockers, warnings, and limits emission.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import { evaluateModelCompatibility, catalogueEfforts } from '../../src/model/catalogue.js';
import { config } from './helpers.js';
import { assets } from '../context/fixtures.js';
import { composeRuntimeBudgets, freshInstallSettings } from '../../src/platform/config/manageable-config.js';
import { loadBootstrapConfig } from '../../src/platform/config/bootstrap-config.js';

const settings = freshInstallSettings(assets);
const c = {
  ...config(),
  budgets: composeRuntimeBudgets(settings, loadBootstrapConfig({}).safety),
};
const entry = {
  id: 'fixture/model', name: 'Fixture',
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  endpoints: ['/api/v1/chat/completions'],
  context_length: 131072, top_provider: { max_completion_tokens: 8192 },
  supported_parameters: ['max_tokens', 'reasoning'],
  reasoning: { supported_efforts: ['high', 'low', 'none'], mandatory: true },
};
const snap = (value: Record<string, unknown>) => ({
  observedAt: '2026-11-16T12:00:00.000Z', entries: [value],
});

it('distinguishes absent and null effort metadata and mandatory reasoning', () => {
  expect(catalogueEfforts({ reasoning: {} })).toMatchObject({
    selection: 'unavailable', efforts: [],
  });
  expect(catalogueEfforts({ reasoning: { supported_efforts: null, mandatory: true } }))
    .toMatchObject({ selection: 'all',
      efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'] });
  const result = evaluateModelCompatibility({
    ...c, openRouter: { ...c.openRouter, reasoningEffort: 'none' },
  }, assets, snap(entry));
  expect(result.report.status).toBe('incompatible');
  expect(result.report.blockers).toContainEqual({
    code: 'REASONING_REQUIRED', path: 'openRouter.reasoningEffort',
  });
  expect(result.limits).toBeNull();
});

it('admits a declared equivalent finite cap but never an absent cap', () => {
  const good = evaluateModelCompatibility(c, assets, snap({
    ...entry, supported_parameters: ['max_completion_tokens'],
  }));
  expect(good.report.status).toBe('catalogue-compatible');
  expect(good.limits).toMatchObject({
    supportsMaxTokens: false, outputCapParameter: 'max_completion_tokens',
  });
  const bad = evaluateModelCompatibility(c, assets, snap({
    ...entry, supported_parameters: [],
  }));
  expect(bad.report.blockers).toContainEqual({
    code: 'OUTPUT_CAP_UNSUPPORTED', path: 'openRouter.modelId',
  });
});

it('handles all effort metadata variants and precedence', () => {
  expect(catalogueEfforts({})).toEqual({ selection: 'unavailable', efforts: [], mandatory: null });
  expect(catalogueEfforts({ reasoning: { supported_efforts: [] } })).toEqual({
    selection: 'declared', efforts: [], mandatory: null,
  });
  expect(catalogueEfforts({ reasoning: { supported_efforts: ['unknown_tier'] } })).toEqual({
    selection: 'unknown', efforts: [], mandatory: null,
  });
  expect(catalogueEfforts({ reasoning: { supported_efforts: null, mandatory: 'yes' } })).toEqual({
    selection: 'unknown', efforts: [], mandatory: null,
  });

  // provider-default needs no metadata
  const defNoMeta = evaluateModelCompatibility(c, assets, snap({
    id: 'fixture/model',
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    endpoints: ['/api/v1/chat/completions'],
    context_length: 131072,
    top_provider: { max_completion_tokens: 8192 },
    supported_parameters: ['max_tokens'],
  }));
  expect(defNoMeta.report.status).toBe('catalogue-compatible');

  // explicit effort without reasoning parameter -> incompatible
  const noParam = evaluateModelCompatibility({
    ...c, openRouter: { ...c.openRouter, reasoningEffort: 'high' },
  }, assets, snap({ ...entry, supported_parameters: ['max_tokens'] }));
  expect(noParam.report.status).toBe('incompatible');
  expect(noParam.report.blockers).toContainEqual({
    code: 'EFFORT_UNSUPPORTED', path: 'openRouter.reasoningEffort',
  });

  // explicit effort with unknown effort metadata -> unable-to-verify
  const unknownMeta = evaluateModelCompatibility({
    ...c, openRouter: { ...c.openRouter, reasoningEffort: 'high' },
  }, assets, snap({ ...entry, reasoning: { supported_efforts: ['future-tier'] } }));
  expect(unknownMeta.report.status).toBe('unable-to-verify');
  expect(unknownMeta.report.blockers).toContainEqual({
    code: 'EFFORT_EVIDENCE_MISSING', path: 'openRouter.reasoningEffort',
  });

  // concrete blocker takes precedence over missing evidence
  const mixed = evaluateModelCompatibility({
    ...c, openRouter: { ...c.openRouter, reasoningEffort: 'high' },
  }, assets, snap({
    ...entry,
    endpoints: ['/api/v1/completions'], // concrete incompatible
    reasoning: { supported_efforts: ['future-tier'] }, // missing evidence
  }));
  expect(mixed.report.status).toBe('incompatible');
});

it('validates model presence, applicability, capacities, and fixed context floors', () => {
  const emptyId = evaluateModelCompatibility({
    ...c, openRouter: { ...c.openRouter, modelId: '' },
  }, assets, snap(entry));
  expect(emptyId.report.status).toBe('incompatible');
  expect(emptyId.report.blockers).toContainEqual({ code: 'MODEL_REQUIRED', path: 'openRouter.modelId' });

  const notListed = evaluateModelCompatibility({
    ...c, openRouter: { ...c.openRouter, modelId: 'other/model' },
  }, assets, snap(entry));
  expect(notListed.report.status).toBe('incompatible');
  expect(notListed.report.blockers).toContainEqual({ code: 'MODEL_NOT_LISTED', path: 'openRouter.modelId' });

  // endpoint/modality missing vs excluded
  expect(evaluateModelCompatibility(c, assets, snap({
    ...entry, endpoints: undefined,
  })).report.status).toBe('unable-to-verify');
  expect(evaluateModelCompatibility(c, assets, snap({
    ...entry, endpoints: ['/api/v1/completions'],
  })).report.status).toBe('incompatible');
  expect(evaluateModelCompatibility(c, assets, snap({
    ...entry, architecture: { input_modalities: ['image'], output_modalities: ['text'] },
  })).report.status).toBe('incompatible');

  // invalid/zero/fractional/unsafe capacities
  for (const badCap of [null, 0, 1024.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(evaluateModelCompatibility(c, assets, snap({
      ...entry, context_length: badCap,
    })).report.status).toBe('unable-to-verify');
    expect(evaluateModelCompatibility(c, assets, snap({
      ...entry, top_provider: { max_completion_tokens: badCap },
    })).report.status).toBe('unable-to-verify');
  }

  // exact vs below cap
  const exactCap = evaluateModelCompatibility(c, assets, snap({
    ...entry,
    context_length: c.budgets.maxContextTokens,
    top_provider: { max_completion_tokens: c.budgets.maxOutputTokens },
  }));
  expect(exactCap.report.status).toBe('catalogue-compatible');
  expect(exactCap.limits?.contextTokens).toBe(c.budgets.maxContextTokens);
  expect(exactCap.limits?.outputTokens).toBe(c.budgets.maxOutputTokens);

  const belowCap = evaluateModelCompatibility(c, assets, snap({
    ...entry,
    context_length: c.budgets.maxContextTokens - 1,
  }));
  expect(belowCap.report.status).toBe('incompatible');
  expect(belowCap.report.blockers).toContainEqual({
    code: 'CONTEXT_CAPACITY_TOO_SMALL', path: 'chat.maxContextTokens',
  });

  // fixed assets / floor overflow
  const floorFail = evaluateModelCompatibility({
    ...c, budgets: { ...c.budgets, maxContextTokens: c.budgets.maxContextTokens - 1 },
  }, assets, snap(entry));
  expect(floorFail.report.status).toBe('incompatible');
  expect(floorFail.report.blockers.some(b => b.code === 'CONTEXT_FLOOR_NOT_MET')).toBe(true);

  const fixedFail = evaluateModelCompatibility(c, {
    ...assets, instructions: 'x'.repeat(70_000),
  }, snap(entry));
  expect(fixedFail.report.status).toBe('incompatible');
  expect(fixedFail.report.blockers.some(b => b.code === 'FIXED_CONTEXT_DOES_NOT_FIT')).toBe(true);
});

it('evaluates optional tools and pricing overrides conservatively', () => {
  // tools without prices -> webTool declared-available, calendar unavailable, price warning
  const toolsNoPrice = evaluateModelCompatibility(c, assets, snap({
    ...entry, supported_parameters: ['max_tokens', 'tools'],
  }));
  expect(toolsNoPrice.report.status).toBe('catalogue-compatible');
  expect(toolsNoPrice.report.capabilities).toEqual({
    calendar: 'unavailable', webTool: 'declared-available', pricing: 'unverified',
  });
  expect(toolsNoPrice.report.warnings).toContain('CALENDAR_PRICE_UNVERIFIED');
  expect(toolsNoPrice.limits?.tools).toBe(true);
  expect(toolsNoPrice.limits?.calendar).toBeUndefined();

  // zero known prices with tools -> calendar declared-available
  const zeroPrice = evaluateModelCompatibility(c, assets, snap({
    ...entry,
    supported_parameters: ['max_tokens', 'tools'],
    pricing: { prompt: '0', completion: '0' },
  }));
  expect(zeroPrice.report.capabilities).toEqual({
    calendar: 'declared-available', webTool: 'declared-available', pricing: 'usable',
  });
  expect(zeroPrice.limits?.calendar).toBeDefined();

  // dynamic / negative / separate internal_reasoning rate -> calendar disabled
  for (const badPricing of [
    { prompt: '-0.000001', completion: '0.000002' },
    { prompt: 'dynamic', completion: '0.000002' },
    { prompt: '0.000001', completion: '0.000002', internal_reasoning: '0.000005' },
    { prompt: '0.000001', completion: '0.000002', pricing_overrides: [{ min_prompt_tokens: 1000 }] },
  ]) {
    const res = evaluateModelCompatibility(c, assets, snap({
      ...entry,
      supported_parameters: ['max_tokens', 'tools'],
      pricing: badPricing,
    }));
    expect(res.report.status).toBe('catalogue-compatible');
    expect(res.report.capabilities.calendar).toBe('unavailable');
    expect(res.report.capabilities.pricing).toBe('unverified');
    expect(res.report.warnings).toContain('CALENDAR_PRICE_UNVERIFIED');
  }

  // pricing override strictly above admitted context does not apply
  const highOverride = evaluateModelCompatibility(c, assets, snap({
    ...entry,
    supported_parameters: ['max_tokens', 'tools'],
    pricing: {
      prompt: '0.000001',
      completion: '0.000002',
      pricing_overrides: [{ min_prompt_tokens: 131073 }],
    },
  }));
  expect(highOverride.report.capabilities.calendar).toBe('declared-available');
  expect(highOverride.report.capabilities.pricing).toBe('usable');
});
