/**
 * ============================================================================
 * FILE: config-edit-state.test.ts
 * LOCATION: frontend/src/features/admin-config/config-edit-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Field catalog, draft conversion, and revision-fence reducer tests.
 *
 * ROLE IN PROJECT:
 *    Locks lossless nonsecret drafts, dirty overlay after credential saves,
 *    and lower-revision snapshot rejection without credential candidates.
 *
 * KEY COMPONENTS:
 *    - createEditState / editReducer / isDirty
 *    - fieldsFromSettings / settingsFromFields catalog round trips
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_CONFIG_ERROR_CODES, ADMIN_CONFIG_FIELD_PATHS,
  isManageableSettings, isPublicAdminConfig,
} from '../../api/admin-config-protocol.ts';
import {
  ADMIN_ERROR_COPY,
  applyCompactionModelToMemory,
  catalogCoverage,
  compatibilityKey,
  createEditState,
  dirtyFields,
  displayFieldValue,
  editableFields,
  editReducer,
  errorCopy,
  fieldsFromSettings,
  hasMatchingCompatibility,
  isDirty,
  navigationDecision,
  requiresCompatibilityCheck,
  saveLocked,
  settingsFromFields,
} from './config-edit-state.ts';
import { ConfigFields } from './ConfigFields.tsx';
import { publicConfig } from './testing/fixtures.ts';

it('accepts the redacted public fixture with its server-computed floor', () => {
  expect(isManageableSettings(publicConfig().settings)).toBe(true);
  expect(isPublicAdminConfig(publicConfig())).toBe(true);
  const withoutFloor = publicConfig() as unknown as Record<string, unknown>;
  delete withoutFloor.chatFloor;
  expect(isPublicAdminConfig(withoutFloor)).toBe(false);
});

it('raises context tokens live when the history limit exceeds the current total', () => {
  let state = createEditState(publicConfig());
  state = editReducer(state, { type: 'edit', path: 'chat.maxHistoryTokens', value: '15000' });
  expect(state.fields['chat.maxHistoryTokens']).toBe('15000');
  // prefix 16000 + history 15000 + output 2000 + margin 512
  expect(state.fields['chat.maxContextTokens']).toBe('33512');
  expect(isDirty(state)).toBe(true);
});

it('keeps a larger context total and never lowers it while editing history', () => {
  let state = createEditState(publicConfig());
  state = editReducer(state, { type: 'edit', path: 'chat.maxHistoryTokens', value: '10000' });
  expect(state.fields['chat.maxContextTokens']).toBe('32000');
  state = editReducer(state, { type: 'edit', path: 'chat.maxContextTokens', value: '40000' });
  state = editReducer(state, { type: 'edit', path: 'chat.maxHistoryTokens', value: '12000' });
  expect(state.fields['chat.maxContextTokens']).toBe('40000');
});

it('rejects a context total below the server floor and annotates its inputs', () => {
  const baseline = publicConfig().settings;
  const fields = { ...fieldsFromSettings(baseline),
    'chat.maxHistoryTokens': '12000', 'chat.maxContextTokens': '30000' };
  const failed = settingsFromFields(baseline, fields, publicConfig().chatFloor);
  expect(failed.settings).toBeNull();
  expect(failed.fieldErrors.map((error) => error.path)).toEqual(expect.arrayContaining([
    'chat.maxContextTokens', 'chat.maxHistoryTokens',
    'chat.maxOutputTokens', 'chat.modelMarginTokens',
  ]));
  const accepted = settingsFromFields(baseline,
    { ...fields, 'chat.maxContextTokens': '30512' }, publicConfig().chatFloor);
  expect(accepted.settings?.chat.maxContextTokens).toBe(30512);
});

it('covers every manageable field except request and candidate paths', () => {
  const managed = ADMIN_CONFIG_FIELD_PATHS.filter((path) => path !== 'candidate' && path !== 'expectedRevision');
  expect([...catalogCoverage].sort()).toEqual([...managed].sort());
});

it('advances credential revision without saving or discarding dirty fields', () => {
  let state = createEditState(publicConfig());
  state = editReducer(state, { type: 'edit', path: 'openRouter.modelId', value: 'new/model' });
  state = editReducer(state, { type: 'credentialSaved', config: publicConfig(2) });
  expect(state.baseline.revision).toBe(2);
  expect(state.fields['openRouter.modelId']).toBe('new/model');
  expect(state.baseline.settings.openRouter.modelId).toBe('openai/gpt-4.1-mini');
  expect(isDirty(state)).toBe(true);
  expect(JSON.stringify(state)).not.toContain('candidate');
});

it('treats reverted edits as clean', () => {
  let state = createEditState(publicConfig());
  state = editReducer(state, { type: 'edit', path: 'chat.titleMaxChars', value: '40' });
  expect(isDirty(state)).toBe(true);
  state = editReducer(state, { type: 'edit', path: 'chat.titleMaxChars', value: '80' });
  expect(isDirty(state)).toBe(false);
});

it('lists only the fields that differ from the baseline', () => {
  let state = createEditState(publicConfig());
  expect(dirtyFields(state)).toEqual([]);
  state = editReducer(state, { type: 'edit', path: 'chat.titleMaxChars', value: '40' });
  state = editReducer(state, { type: 'edit', path: 'compaction.enabled', value: false });
  expect(dirtyFields(state).map((field) => field.path)).toEqual([
    'chat.titleMaxChars',
    'compaction.enabled',
  ]);
  expect(displayFieldValue(dirtyFields(state)[0], '80')).toBe('80');
  expect(displayFieldValue(dirtyFields(state)[1], true)).toBe('On');
});

it('discards local edits without advancing revision and ignores discard while saving', () => {
  let state = createEditState(publicConfig());
  state = editReducer(state, { type: 'edit', path: 'chat.titleMaxChars', value: '40' });
  state = editReducer(state, { type: 'discard' });
  expect(isDirty(state)).toBe(false);
  expect(state.fields['chat.titleMaxChars']).toBe('80');
  expect(state.baseline.revision).toBe(1);

  state = editReducer(state, { type: 'edit', path: 'chat.titleMaxChars', value: '40' });
  state = editReducer(state, { type: 'begin', scope: 'settings' });
  state = editReducer(state, { type: 'discard' });
  expect(state.pending).toBe('settings');
  expect(state.fields['chat.titleMaxChars']).toBe('40');
});

it('keeps blank required numbers invalid and allows blank nullable or known-zero rates', () => {
  const baseline = publicConfig().settings;
  const fields = fieldsFromSettings(baseline);
  expect(settingsFromFields(baseline, { ...fields, 'chat.maxInputChars': '' }).settings).toBeNull();
  expect(settingsFromFields(baseline, { ...fields, 'chat.maxInputChars': '' }).fieldErrors)
    .toContainEqual({ path: 'chat.maxInputChars', code: 'required' });
  expect(settingsFromFields(baseline, { ...fields, 'voice.dictationWarningMs': '' }).settings?.voice.dictationWarningMs)
    .toBeNull();
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.rates.novaPerMinuteUsd': '' })
    .settings?.deepgram.rates.novaPerMinuteUsd).toBeNull();
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.rates.novaPerMinuteUsd': '0' })
    .settings?.deepgram.rates.novaPerMinuteUsd).toBe(0);
  expect(settingsFromFields(baseline, { ...fields, 'voice.quotas.dailySpendUsd': '0' }).settings).toBeNull();
});

it('round-trips every catalog leaf from the fixture', () => {
  const baseline = publicConfig().settings;
  const result = settingsFromFields(baseline, fieldsFromSettings(baseline));
  expect(result.fieldErrors).toEqual([]);
  // A missing optional enablement leaf is normalized to its explicit default-off root boolean.
  expect(result.settings).toEqual({ ...baseline, devModeEnabled: false });
});

it('accepts only documented select allowlists', () => {
  const baseline = publicConfig().settings;
  const fields = fieldsFromSettings(baseline);
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.region': 'eu' }).settings?.deepgram.region).toBe('eu');
  expect(isManageableSettings({ ...baseline, deepgram: { ...baseline.deepgram, ttsModel: 'flux-cole-en' } })).toBe(true);
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.ttsModel': 'flux-cole-en' })
    .settings?.deepgram.ttsModel).toBe('flux-cole-en');
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.ttsModel': 'flux-priya-en' })
    .settings?.deepgram.ttsModel).toBe('flux-priya-en');
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.region': 'ap' }).fieldErrors)
    .toContainEqual({ path: 'deepgram.region', code: 'unsupported' });
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.dictationModel': 'nova-2' }).settings).toBeNull();
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.liveModel': 'other' }).settings).toBeNull();
});

it('enforces the 10,000-token history admission minimum in the catalog and guard', () => {
  const baseline = publicConfig().settings;
  const fields = fieldsFromSettings(baseline);
  expect(settingsFromFields(baseline, { ...fields, 'chat.maxHistoryTokens': '9999' })
    .fieldErrors).toContainEqual({ path: 'chat.maxHistoryTokens', code: 'out_of_range' });
  expect(isManageableSettings({
    ...baseline, chat: { ...baseline.chat, maxHistoryTokens: 9_999 },
  })).toBe(false);
});

it('rejects fractional integers, oversized keyterms, and empty keyterm lines without dropping them', () => {
  const baseline = publicConfig().settings;
  const fields = fieldsFromSettings(baseline);
  expect(settingsFromFields(baseline, { ...fields, 'chat.maxInputTokens': '1.5' }).fieldErrors)
    .toContainEqual({ path: 'chat.maxInputTokens', code: 'invalid' });
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.keyterms': 'alpha\n\nbeta' }).settings).toBeNull();
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.keyterms': `${'a'.repeat(65)}` }).fieldErrors)
    .toContainEqual({ path: 'deepgram.keyterms', code: 'out_of_range' });
  const tooMany = Array.from({ length: 51 }, (_, index) => `term-${index}`).join('\n');
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.keyterms': tooMany }).settings).toBeNull();
  expect(settingsFromFields(baseline, { ...fields, 'deepgram.keyterms': 'alpha\nbeta' }).settings?.deepgram.keyterms)
    .toEqual(['alpha', 'beta']);
});

it('preserves fixed privacy policies while replacing catalog fields', () => {
  const baseline = publicConfig().settings;
  const fields = fieldsFromSettings(baseline);
  const result = settingsFromFields(baseline, { ...fields, 'openRouter.modelId': 'openai/gpt-4.1' });
  expect(result.settings?.openRouter).toEqual({
    modelId: 'openai/gpt-4.1', reasoningEffort: 'provider-default', dataCollection: 'deny', disableTransforms: true,
  });
  expect(editableFields.some((field) => field.path === 'openRouter.dataCollection')).toBe(false);
});

it('annotates context, warning, retry, quota, and spend cross-field failures', () => {
  const baseline = publicConfig().settings;
  const fields = fieldsFromSettings(baseline);
  const context = settingsFromFields(baseline, {
    ...fields, 'chat.maxContextTokens': '10', 'chat.maxOutputTokens': '8', 'chat.modelMarginTokens': '8',
  });
  expect(context.settings).toBeNull();
  expect(context.fieldErrors.map((error) => error.path)).toEqual(expect.arrayContaining([
    'chat.maxContextTokens', 'chat.maxOutputTokens', 'chat.modelMarginTokens',
  ]));
  const warning = settingsFromFields(baseline, {
    ...fields, 'voice.dictationWarningMs': String(baseline.voice.limits.dictationMaxMs),
  });
  expect(warning.fieldErrors.map((error) => error.path)).toEqual(expect.arrayContaining([
    'voice.dictationWarningMs', 'voice.limits.dictationMaxMs',
  ]));
  const retry = settingsFromFields(baseline, {
    ...fields, 'chat.retryBaseDelayMs': '1000', 'chat.retryMaxDelayMs': '250',
  });
  expect(retry.fieldErrors.map((error) => error.path)).toEqual(expect.arrayContaining([
    'chat.retryBaseDelayMs', 'chat.retryMaxDelayMs',
  ]));
  const quota = settingsFromFields(baseline, {
    ...fields, 'voice.quotas.identityConcurrent': '5', 'voice.quotas.globalConcurrent': '2',
  });
  expect(quota.fieldErrors.map((error) => error.path)).toEqual(expect.arrayContaining([
    'voice.quotas.identityConcurrent', 'voice.quotas.globalConcurrent',
  ]));
  const spend = settingsFromFields(baseline, { ...fields, 'voice.quotas.dailySpendUsd': '12.5' });
  expect(spend.fieldErrors.map((error) => error.path)).toEqual(expect.arrayContaining([
    'voice.quotas.dailySpendUsd', 'deepgram.rates.novaPerMinuteUsd',
  ]));
});

it('replaces drafts after a successful settings save', () => {
  let state = createEditState(publicConfig());
  state = editReducer(state, { type: 'edit', path: 'openRouter.modelId', value: 'saved/model' });
  state = editReducer(state, { type: 'begin', scope: 'settings' });
  const saved = publicConfig(2);
  saved.settings.openRouter.modelId = 'saved/model';
  state = editReducer(state, { type: 'settingsSaved', config: saved });
  expect(state.baseline.revision).toBe(2);
  expect(state.fields['openRouter.modelId']).toBe('saved/model');
  expect(state.pending).toBeNull();
  expect(isDirty(state)).toBe(false);
});

it('preserves fields and revision after a failed credential mutation', () => {
  let state = createEditState(publicConfig());
  state = editReducer(state, { type: 'edit', path: 'chat.titleMaxChars', value: '40' });
  state = editReducer(state, { type: 'begin', scope: 'openrouter' });
  state = editReducer(state, {
    type: 'failed',
    error: { code: 'CREDENTIAL_REJECTED', currentRevision: 9, fieldErrors: [] },
  });
  expect(state.baseline.revision).toBe(1);
  expect(state.fields['chat.titleMaxChars']).toBe('40');
  expect(state.stale).toBe(false);
  expect(state.pending).toBeNull();
  expect(state.error?.currentRevision).toBe(9);
});

it('locks mutations on conflict without using currentRevision as expectedRevision', () => {
  let state = createEditState(publicConfig());
  state = editReducer(state, { type: 'edit', path: 'openRouter.modelId', value: 'kept/model' });
  state = editReducer(state, {
    type: 'failed',
    error: { code: 'CONFIG_CONFLICT', currentRevision: 4, fieldErrors: [] },
  });
  expect(state.stale).toBe(true);
  expect(state.baseline.revision).toBe(1);
  expect(state.fields['openRouter.modelId']).toBe('kept/model');
  expect(editReducer(state, { type: 'begin', scope: 'settings' }).pending).toBeNull();
});

it('rejects older load and save snapshots after a newer baseline', () => {
  let state = createEditState(publicConfig(3));
  state = editReducer(state, { type: 'edit', path: 'openRouter.modelId', value: 'newer/model' });
  state = editReducer(state, { type: 'loaded', config: publicConfig(1) });
  state = editReducer(state, { type: 'settingsSaved', config: publicConfig(2) });
  state = editReducer(state, { type: 'credentialSaved', config: publicConfig(2) });
  expect(state.baseline.revision).toBe(3);
  expect(state.fields['openRouter.modelId']).toBe('newer/model');
});

it('does not undo a saved revision when capability refresh fails', () => {
  let state = createEditState(publicConfig(2));
  state = editReducer(state, { type: 'capabilities', ok: false });
  expect(state.baseline.revision).toBe(2);
  expect(state.capabilityWarning).toBe(true);
  state = editReducer(state, { type: 'capabilities', ok: true });
  expect(state.capabilityWarning).toBe(false);
});

it('covers every protocol error code with a safe message', () => {
  const missing = ADMIN_CONFIG_ERROR_CODES.filter((code) => !ADMIN_ERROR_COPY[code]);
  expect(missing).toEqual([]);
  expect(errorCopy('CONFIG_CONFLICT')).toContain('Settings changed elsewhere');
  expect(errorCopy('CONFIG_WRITE_UNCERTAIN')).toContain('unknown');
  expect(errorCopy('NETWORK_ERROR')).not.toContain('exception');
});

it('leaves only after an accepted discard when no save is pending', () => {
  expect(navigationDecision({ dirty: true, pending: false }, () => true)).toBe('leave');
  expect(navigationDecision({ dirty: false, pending: false }, () => true)).toBe('leave');
});

describe('uncertain failures', () => {
  it('locks further mutations until an explicit reload', () => {
    let state = createEditState(publicConfig());
    state = editReducer(state, {
      type: 'failed',
      error: { code: 'CONFIG_WRITE_UNCERTAIN', currentRevision: null, fieldErrors: [] },
    });
    expect(state.uncertain).toBe(true);
    expect(editReducer(state, { type: 'begin', scope: 'deepgram' }).pending).toBeNull();
    state = editReducer(state, { type: 'loaded', config: publicConfig(2) });
    expect(state.uncertain).toBe(false);
    expect(state.baseline.revision).toBe(2);
  });
});

it('accepts stored legacy idle timings without advertising automatic hang-up', () => {
  const baseline = publicConfig().settings;
  const fields = { ...fieldsFromSettings(baseline),
    'voice.limits.liveMaxMs': '30000', 'voice.limits.liveWarningMs': '20000' };
  expect(settingsFromFields(baseline, fields).fieldErrors).toEqual([]);
  expect(editableFields.find(f => f.path === 'voice.limits.idleExitAfterWarningMs')?.help)
    .toBe('Stored for compatibility only. Does not end or suspend a live call.');
});

it('round-trips webSearch turn budgets (default 5/5) and blockedDomains and rejects invalid values', () => {
  const baseline = publicConfig().settings;
  expect(baseline.webSearch).toEqual({ maxSearchesPerTurn: 5, maxFetchesPerTurn: 5, blockedDomains: [] });
  const fields = fieldsFromSettings(baseline);
  expect(fields['webSearch.maxSearchesPerTurn']).toBe('5');
  expect(fields['webSearch.maxFetchesPerTurn']).toBe('5');
  expect(fields['webSearch.blockedDomains']).toBe('');

  const updated = settingsFromFields(baseline, {
    ...fields,
    'webSearch.maxSearchesPerTurn': '1',
    'webSearch.maxFetchesPerTurn': '20',
    'webSearch.blockedDomains': 'reddit.com\npinterest.com',
  });
  expect(updated.fieldErrors).toEqual([]);
  expect(updated.settings?.webSearch).toEqual({
    maxSearchesPerTurn: 1,
    maxFetchesPerTurn: 20,
    blockedDomains: ['reddit.com', 'pinterest.com'],
  });

  for (const [path, badValue] of [
    ['webSearch.maxSearchesPerTurn', '0'],
    ['webSearch.maxSearchesPerTurn', '21'],
    ['webSearch.maxSearchesPerTurn', '2.5'],
    ['webSearch.maxSearchesPerTurn', ''],
    ['webSearch.maxFetchesPerTurn', '0'],
    ['webSearch.maxFetchesPerTurn', '21'],
    ['webSearch.blockedDomains', 'https://reddit.com'],
    ['webSearch.blockedDomains', 'reddit.com\nreddit.com'],
    ['webSearch.blockedDomains', Array.from({ length: 101 }, (_, i) => `d${i}.example.com`).join('\n')],
  ] as const) {
    const failed = settingsFromFields(baseline, { ...fields, [path]: badValue });
    expect(failed.settings).toBeNull();
    expect(failed.fieldErrors.some((e) => e.path === path)).toBe(true);
  }
});

it('resets effort and invalidates a result even when the model changes away and back', () => {
  let s = createEditState(publicConfig());
  s = editReducer(s, { type: 'edit', path: 'openRouter.reasoningEffort', value: 'high' });
  const originalId = String(s.fields['openRouter.modelId']);
  const before = s.checkEpoch;
  s = editReducer(s, { type: 'edit', path: 'openRouter.modelId', value: 'fixture/new' });
  expect(s.fields['openRouter.reasoningEffort']).toBe('provider-default');
  s = editReducer(s, { type: 'edit', path: 'openRouter.modelId', value: originalId });
  expect(s.checkEpoch).toBeGreaterThan(before);
  expect(s.compatibility).toBeNull();
});

it('fences check results to exact epoch, candidate, revision, expiry, and saveLocked', () => {
  const base = publicConfig(1);
  const now = Date.parse('2026-11-16T12:00:00.000Z');
  const expiresAt = new Date(now + 60_000).toISOString();
  let s = createEditState(base);

  // Title-only edit needs no compatibility check
  s = editReducer(s, { type: 'edit', path: 'chat.titleMaxChars', value: '50' });
  expect(requiresCompatibilityCheck(s)).toBe(false);
  expect(saveLocked(s, now)).toBe(false);

  // Model change requires compatibility check
  s = editReducer(s, { type: 'edit', path: 'openRouter.modelId', value: 'fixture/new' });
  expect(requiresCompatibilityCheck(s)).toBe(true);
  expect(saveLocked(s, now)).toBe(true);

  const key = compatibilityKey(s)!;
  const epoch = s.checkEpoch;
  const compatResponse = {
    protocolVersion: 1 as const,
    candidate: {
      revision: 1,
      modelId: 'fixture/new',
      reasoningEffort: 'provider-default' as const,
      chat: { ...base.settings.chat, titleMaxChars: 50 },
    },
    checkedAt: new Date(now).toISOString(),
    catalogueObservedAt: new Date(now).toISOString(),
    expiresAt,
    report: {
      status: 'catalogue-compatible' as const,
      blockers: [],
      warnings: [],
      contextTokens: 131072,
      outputTokens: 8192,
      outputCapParameter: 'max_tokens' as const,
      chatFloor: base.chatFloor,
      capabilities: { calendar: 'unavailable' as const, webTool: 'unavailable' as const, pricing: 'unverified' as const },
    },
  };

  // Out-of-order stale epoch is ignored
  s = editReducer(s, { type: 'checkFinished', epoch: epoch - 1, key, response: compatResponse });
  expect(s.compatibility).toBeNull();

  // Mismatched echoed candidate is ignored
  s = editReducer(s, {
    type: 'checkFinished',
    epoch,
    key,
    response: { ...compatResponse, candidate: { ...compatResponse.candidate, modelId: 'other/model' } },
  });
  expect(s.compatibility).toBeNull();

  // Valid finish unlocks save before expiry, locks at exact expiresAt
  s = editReducer(s, { type: 'checkStarted', epoch, key });
  expect(s.checkPending).toBe(true);
  s = editReducer(s, { type: 'checkFinished', epoch, key, response: compatResponse });
  expect(s.checkPending).toBe(false);
  expect(hasMatchingCompatibility(s, now + 59_999)).toBe(true);
  expect(saveLocked(s, now + 59_999)).toBe(false);
  expect(hasMatchingCompatibility(s, now + 60_000)).toBe(false);
  expect(saveLocked(s, now + 60_000)).toBe(true);

  // Check failure never sets uncertain or discards dirty fields
  s = editReducer(s, { type: 'checkFailed', epoch, key, code: 'MODEL_CATALOGUE_UNAVAILABLE' });
  expect(s.uncertain).toBe(false);
  expect(s.checkError).toBe('MODEL_CATALOGUE_UNAVAILABLE');
  expect(s.fields['openRouter.modelId']).toBe('fixture/new');

  // credentialSaved invalidates compatibility but preserves dirty fields
  s = editReducer(s, { type: 'credentialSaved', config: publicConfig(2) });
  expect(s.baseline.revision).toBe(2);
  expect(s.compatibility).toBeNull();
  expect(s.fields['openRouter.modelId']).toBe('fixture/new');
});

it('round-trips compaction settings, validates customModelId requirement, and resets customModelId on active-fork', () => {
  const baseline = publicConfig().settings;
  expect(baseline.compaction).toEqual({
    enabled: true,
    watermarkRatio: 0.8,
    modelMode: 'active-fork',
    customModelId: null,
  });

  const fields = fieldsFromSettings(baseline);
  expect(fields['compaction.enabled']).toBe(true);
  expect(fields['compaction.watermarkRatio']).toBe('0.8');
  expect(fields['compaction.modelMode']).toBe('active-fork');
  expect(fields['compaction.customModelId']).toBe('');

  for (const badRatio of ['0.49', '0.91', 'abc', '']) {
    const failed = settingsFromFields(baseline, {
      ...fields,
      'compaction.watermarkRatio': badRatio,
    });
    expect(failed.settings).toBeNull();
    expect(failed.fieldErrors.some((e) => e.path === 'compaction.watermarkRatio')).toBe(true);
  }

  const missingCustom = settingsFromFields(baseline, {
    ...fields,
    'compaction.modelMode': 'custom',
    'compaction.customModelId': '',
  });
  expect(missingCustom.settings).toBeNull();
  expect(missingCustom.fieldErrors).toContainEqual({
    path: 'compaction.customModelId',
    code: 'required',
  });

  const validCustom = settingsFromFields(baseline, {
    ...fields,
    'compaction.enabled': false,
    'compaction.watermarkRatio': '0.75',
    'compaction.modelMode': 'custom',
    'compaction.customModelId': 'anthropic/claude-haiku-4.5',
  });
  expect(validCustom.fieldErrors).toEqual([]);
  expect(validCustom.settings?.compaction).toEqual({
    enabled: false,
    watermarkRatio: 0.75,
    modelMode: 'custom',
    customModelId: 'anthropic/claude-haiku-4.5',
  });

  let state = createEditState(publicConfig());
  state = editReducer(state, { type: 'edit', path: 'compaction.modelMode', value: 'custom' });
  state = editReducer(state, {
    type: 'edit',
    path: 'compaction.customModelId',
    value: 'anthropic/claude-haiku-4.5',
  });
  expect(requiresCompatibilityCheck(state)).toBe(false);
  expect(saveLocked(state)).toBe(false);

  state = editReducer(state, { type: 'edit', path: 'compaction.modelMode', value: 'active-fork' });
  expect(state.fields['compaction.customModelId']).toBe('');
  expect(isDirty(state)).toBe(false);
});

it('drafts dev mode enablement as an ordinary default-off revisioned setting', () => {
  const initial = publicConfig(3);
  delete initial.settings.devModeEnabled;
  expect(isManageableSettings(initial.settings)).toBe(true);
  expect(isManageableSettings({ ...initial.settings, devModeEnabled: 'true' })).toBe(false);
  const state = createEditState(initial);
  expect(state.fields.devModeEnabled).toBe(false);
  expect(isDirty(state)).toBe(false);
  const draft = editReducer(state, { type: 'edit', path: 'devModeEnabled', value: true });
  expect(dirtyFields(draft).map((field) => field.path)).toEqual(['devModeEnabled']);
  expect(requiresCompatibilityCheck(draft)).toBe(false);
  const settings = settingsFromFields(draft.baseline.settings, draft.fields).settings!;
  expect(settings).toEqual({ ...initial.settings, devModeEnabled: true });
  const saving = editReducer(draft, { type: 'begin', scope: 'settings' });
  expect(saveLocked(saving)).toBe(true);
  const failed = editReducer(saving, { type: 'failed', error: {
    code: 'CONFIG_CONFLICT', currentRevision: 4, fieldErrors: [],
  } });
  expect(failed.baseline.revision).toBe(3);
  expect(failed.baseline.settings.devModeEnabled).toBeUndefined();
  expect(failed.fields.devModeEnabled).toBe(true);
  expect(saveLocked(failed)).toBe(true);
  expect(editReducer(draft, { type: 'discard' }).fields.devModeEnabled).toBe(false);
  const saved = editReducer(saving, { type: 'settingsSaved', config: { ...publicConfig(4), settings } });
  expect(saved.baseline.revision).toBe(4);
  expect(saved.fields.devModeEnabled).toBe(true);
  expect(isDirty(saved)).toBe(false);
  const disabled = editReducer(saved, { type: 'edit', path: 'devModeEnabled', value: false });
  expect(settingsFromFields(saved.baseline.settings, disabled.fields).settings?.devModeEnabled).toBe(false);
});

it('validates dictation endpointing in the browser and explains spoken punctuation', () => {
  const baseline = publicConfig().settings;
  const fields = fieldsFromSettings(baseline);
  expect(fields['deepgram.endpointingMs']).toBe('800');
  for (const endpointingMs of [300, 800, 2000]) {
    expect(isManageableSettings({ ...baseline, deepgram: { ...baseline.deepgram, endpointingMs } }))
      .toBe(true);
    expect(settingsFromFields(baseline, { ...fields, 'deepgram.endpointingMs': String(endpointingMs) })
      .settings?.deepgram.endpointingMs).toBe(endpointingMs);
  }
  for (const endpointingMs of [299, 2001]) {
    expect(isManageableSettings({ ...baseline, deepgram: { ...baseline.deepgram, endpointingMs } }))
      .toBe(false);
    expect(settingsFromFields(baseline, { ...fields, 'deepgram.endpointingMs': String(endpointingMs) })
      .fieldErrors).toContainEqual({ path: 'deepgram.endpointingMs', code: 'out_of_range' });
  }
  expect(editableFields.find(f => f.path === 'deepgram.spokenPunctuation')?.help)
    .toBe('Convert spoken punctuation words (for example, "period" or "question mark") into punctuation marks.');
});

it('round-trips memory writer settings, enforces customModelId, resets on main, and defaults absent legacy memory', () => {
  const baseline = publicConfig().settings;
  expect(baseline.memory).toEqual({ modelMode: 'main', customModelId: null });

  const fields = fieldsFromSettings(baseline);
  expect(fields['memory.modelMode']).toBe('main');
  expect(fields['memory.customModelId']).toBe('');

  const missingCustom = settingsFromFields(baseline, {
    ...fields,
    'memory.modelMode': 'custom',
    'memory.customModelId': '',
  });
  expect(missingCustom.settings).toBeNull();
  expect(missingCustom.fieldErrors).toContainEqual({
    path: 'memory.customModelId',
    code: 'required',
  });

  for (const [path, value] of [
    ['memory.modelMode', 'compaction'],
    ['memory.customModelId', ' spaced/model '],
    ['memory.customModelId', 'a\nb'],
    ['memory.customModelId', 'm'.repeat(201)],
  ] as const) {
    const invalid = settingsFromFields(baseline, {
      ...fields,
      'memory.modelMode': 'custom',
      'memory.customModelId': 'openai/gpt-4.1-mini',
      [path]: value,
    });
    expect(invalid.settings).toBeNull();
    expect(invalid.fieldErrors.some((error) => error.path === path)).toBe(true);
  }

  const validCustom = settingsFromFields(baseline, {
    ...fields,
    'memory.modelMode': 'custom',
    'memory.customModelId': 'anthropic/claude-haiku-4.5',
  });
  expect(validCustom.fieldErrors).toEqual([]);
  expect(validCustom.settings?.memory).toEqual({
    modelMode: 'custom',
    customModelId: 'anthropic/claude-haiku-4.5',
  });

  // Switching back to main clears memory.customModelId and leaves compatibility unlocked
  let state = createEditState(publicConfig());
  state = editReducer(state, { type: 'edit', path: 'memory.modelMode', value: 'custom' });
  state = editReducer(state, {
    type: 'edit',
    path: 'memory.customModelId',
    value: 'anthropic/claude-haiku-4.5',
  });
  expect(requiresCompatibilityCheck(state)).toBe(false);
  expect(saveLocked(state)).toBe(false);

  state = editReducer(state, { type: 'edit', path: 'memory.modelMode', value: 'main' });
  expect(state.fields['memory.customModelId']).toBe('');
  expect(isDirty(state)).toBe(false);

  // Legacy baseline missing memory defaults cleanly to main/null
  const legacy = structuredClone(baseline) as Omit<typeof baseline, 'memory'> & {
    memory?: typeof baseline.memory;
  };
  delete legacy.memory;
  expect(isManageableSettings(legacy)).toBe(true);
  const legacyFields = fieldsFromSettings(legacy as typeof baseline);
  expect(legacyFields['memory.modelMode']).toBe('main');
  expect(legacyFields['memory.customModelId']).toBe('');
  const rebuilt = settingsFromFields(legacy as typeof baseline, legacyFields);
  expect(rebuilt.fieldErrors).toEqual([]);
  expect(rebuilt.settings?.memory).toEqual({ modelMode: 'main', customModelId: null });
});

it('maps the approved Compaction model choice explicitly to main or a copy of compaction.customModelId', () => {
  const baseFields = fieldsFromSettings(publicConfig().settings);
  expect(applyCompactionModelToMemory(baseFields)).toEqual({
    modelMode: 'main',
    customModelId: '',
  });
  expect(
    applyCompactionModelToMemory({
      ...baseFields,
      'compaction.modelMode': 'custom',
      'compaction.customModelId': 'anthropic/claude-haiku-4.5',
    }),
  ).toEqual({
    modelMode: 'custom',
    customModelId: 'anthropic/claude-haiku-4.5',
  });
  expect(
    applyCompactionModelToMemory({
      ...baseFields,
      'compaction.modelMode': 'custom',
      'compaction.customModelId': '   ',
    }),
  ).toEqual({
    modelMode: 'main',
    customModelId: '',
  });
});

it('renders Memory writer model controls in ConfigFields compaction section and toggles ModelCombobox by mode', () => {
  const fields = fieldsFromSettings(publicConfig().settings);
  const mainHtml = renderToStaticMarkup(
    createElement(ConfigFields, {
      section: 'compaction',
      fields,
      errors: [],
      disabled: false,
      onChange: () => undefined,
    }),
  );
  expect(mainHtml).toContain('User memory');
  expect(mainHtml).toContain('Memory writer model mode');
  expect(mainHtml).toContain('Main chat model');
  expect(mainHtml).toContain('Use compaction model');
  expect(mainHtml).not.toContain('id="admin-field-memory-customModelId"');

  const customHtml = renderToStaticMarkup(
    createElement(ConfigFields, {
      section: 'compaction',
      fields: {
        ...fields,
        'memory.modelMode': 'custom',
        'memory.customModelId': 'anthropic/claude-haiku-4.5',
      },
      errors: [{ path: 'memory.customModelId', code: 'required' }],
      disabled: false,
      models: [
        {
          id: 'anthropic/claude-haiku-4.5',
          name: 'Claude Haiku 4.5',
          reasoning: { selection: 'unavailable', efforts: [], mandatory: null },
        },
      ],
      modelsLoading: false,
      modelsError: null,
      onRetryModels: () => undefined,
      onChange: () => undefined,
    }),
  );
  expect(customHtml).toContain('id="admin-field-memory-customModelId"');
  expect(customHtml).toContain('role="combobox"');
  expect(customHtml).toContain('Claude Haiku 4.5');
  expect(customHtml).toContain('id="admin-field-memory-customModelId-error"');
});
