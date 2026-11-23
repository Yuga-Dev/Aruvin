/**
 * ============================================================================
 * FILE: admin-config.spec.ts
 * LOCATION: backend/src/contracts/admin-config.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify strict manageable settings, request, storage, and public-read contracts.
 *
 * ROLE IN PROJECT:
 *    Protects the admin configuration boundary before persistence, activation,
 *    and browser clients consume the shared types and schemas.
 *
 * KEY COMPONENTS:
 *    - Default settings tests: Unconfigured, independently off, and strict.
 *    - Boundary tests: Reject unknown, policy, numeric, and voice-field failures.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  credentialUpdateRequestSchema,
  manageableSettingsSchema,
  saveSettingsRequestSchema,
  storedConfigDocumentSchema,
} from './admin-config.js';
import {
  defaultManageableSettings,
  projectPublicAdminConfig,
} from '../platform/config/manageable-config.js';
import {
  ADMIN_CONFIG_FIELD_PATHS, isManageableSettings, isPublicAdminConfig,
  type ManageableSettings,
} from './admin-config-wire.js';
import type { FixedAssets } from '../instructions/fixed-assets.js';
import { loadBootstrapConfig } from '../platform/config/bootstrap-config.js';
import { parseLegacyConfigImport } from '../platform/config/legacy-config-import.js';

const floorAssets: FixedAssets = Object.freeze({
  instructions: 'System rules', knowledge: 'Product knowledge',
  instructionVersion: 'a'.repeat(64), knowledgeContentHash: 'b'.repeat(64),
  graphSchemaVersion: 'fixture-v1',
});

function settingsWith(
  mutate: (settings: ManageableSettings) => unknown,
): unknown {
  return mutate(defaultManageableSettings());
}

describe('manageable settings', () => {
  it('accepts the selected Cole voice through the public wire guard', () => {
    const settings = defaultManageableSettings();
    settings.deepgram.ttsModel = 'flux-cole-en';
    expect(isManageableSettings(settings)).toBe(true);
  });

  it('keeps defaults unconfigured, independently off and strict', () => {
    const s = defaultManageableSettings();
    expect(manageableSettingsSchema.parse(s)).toEqual(s);
    expect(s.openRouter).toEqual({
      modelId: '',
      reasoningEffort: 'provider-default',
      dataCollection: 'deny',
      disableTransforms: true,
    });
    expect(s.voice.enabledModes).toEqual({ dictation: false, live: false });
    expect(s.voice.dictationWarningMs).toBe(270000);
    expect(s.deepgram.rates).toEqual({ novaPerMinuteUsd: null,
      fluxSttPerMinuteUsd: null, fluxTtsPerThousandCharsUsd: null });
    for (const raw of [
      { ...s, userId: 'browser-user' },
      { ...s, openRouter: { ...s.openRouter, dataCollection: 'allow' } },
      { ...s, openRouter: { ...s.openRouter, disableTransforms: false } },
      { ...s, chat: { ...s.chat, connectTimeoutMs: 1 } },
      { ...s, chat: { ...s.chat, maxConcurrentAttemptsPerSession: 2 } },
      { ...s, voice: { ...s.voice, apiKey: 'candidate' } },
      { ...s, deepgram: { ...s.deepgram, region: 'https://evil.invalid' } },
    ]) expect(manageableSettingsSchema.safeParse(raw).success).toBe(false);
  });

  it.each([[299, false], [300, true], [500, true], [800, true], [2000, true], [2001, false]] as const)(
    'validates dictation endpointing %i consistently', (endpointingMs, valid) => {
      const s = defaultManageableSettings();
      s.deepgram.endpointingMs = endpointingMs;
      expect(manageableSettingsSchema.safeParse(s).success).toBe(valid);
      expect(isManageableSettings(s)).toBe(valid);
    },
  );

  it('defaults new dictation settings to 800 without rewriting stored 300', () => {
    const settings = defaultManageableSettings();
    expect(settings.deepgram.endpointingMs).toBe(800);
    settings.deepgram.endpointingMs = 300;
    const stored = storedConfigDocumentSchema.parse({
      _id: 'aurvin', schemaVersion: 1, revision: 7, settings,
      credentials: { openrouter: null, deepgram: null },
      updatedAt: '2026-11-10T00:00:00.000Z', updatedBy: 'admin',
    });
    expect(stored.settings.deepgram.endpointingMs).toBe(300);
    expect(stored.revision).toBe(7);
  });

  it.each([
    ['chat.maxInputChars=32001', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, maxInputChars: 32001 } })],
    ['chat.titleMaxChars=81', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, titleMaxChars: 81 } })],
    ['chat.maxMessagesInContext=501', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, maxMessagesInContext: 501 } })],
    ['chat.retryMaxAttempts=4', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, retryMaxAttempts: 4 } })],
    ['Infinity', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, maxInputTokens: Infinity } })],
    ['NaN', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, maxOutputTokens: Number.NaN } })],
    ['fraction', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, retryBaseDelayMs: 1.5 } })],
    ['unsafe integer', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, maxRequestsPerMinutePerUser: 2 ** 53 } })],
    ['numeric string', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, maxInputChars: '32000' } })],
    ['null number', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, modelMarginTokens: null } })],
    ['model whitespace', (s: ManageableSettings) => ({ ...s, openRouter: { ...s.openRouter, modelId: ' fixture/model ' } })],
    ['model over 200', (s: ManageableSettings) => ({ ...s, openRouter: { ...s.openRouter, modelId: 'm'.repeat(201) } })],
    ['model control', (s: ManageableSettings) => ({ ...s, openRouter: { ...s.openRouter, modelId: 'fix\nture' } })],
    ['Flux model expansion', (s: ManageableSettings) => ({ ...s, deepgram: { ...s.deepgram, ttsModel: 'flux-thalia-en' } })],
    ['untrimmed keyterm', (s: ManageableSettings) => ({ ...s, deepgram: { ...s.deepgram, keyterms: [' Aurvin'] } })],
    ['51 keyterms', (s: ManageableSettings) => ({ ...s, deepgram: { ...s.deepgram, keyterms: Array.from({ length: 51 }, (_, i) => `term${i}`) } })],
    ['threshold 1.1', (s: ManageableSettings) => ({ ...s, deepgram: { ...s.deepgram, eotThreshold: 1.1 } })],
    ['live warning too high', (s: ManageableSettings) => ({
      ...s, voice: { ...s.voice, limits: { ...s.voice.limits, liveWarningMs: s.voice.limits.liveMaxMs } },
    })],
    ['identity concurrent above global', (s: ManageableSettings) => ({
      ...s, voice: { ...s.voice, quotas: { ...s.voice.quotas, identityConcurrent: 5, globalConcurrent: 4 } },
    })],
    ['identity minutes above global', (s: ManageableSettings) => ({
      ...s, voice: { ...s.voice, quotas: { ...s.voice.quotas, identityDailyMinutes: 121 } },
    })],
    ['null rate with spend', (s: ManageableSettings) => ({
      ...s,
      voice: { ...s.voice, quotas: { ...s.voice.quotas, dailySpendUsd: 1 } },
      deepgram: { ...s.deepgram, rates: { novaPerMinuteUsd: 0, fluxSttPerMinuteUsd: 0, fluxTtsPerThousandCharsUsd: null } },
    })],
    ['negative rate', (s: ManageableSettings) => ({
      ...s, deepgram: { ...s.deepgram, rates: { ...s.deepgram.rates, novaPerMinuteUsd: -0.01 } },
    })],
    ['zero spend', (s: ManageableSettings) => ({
      ...s, voice: { ...s.voice, quotas: { ...s.voice.quotas, dailySpendUsd: 0 } },
    })],
    ['dictation warning at max', (s: ManageableSettings) => ({
      ...s, voice: { ...s.voice, dictationWarningMs: s.voice.limits.dictationMaxMs },
    })],
  ] as const)('rejects %s', (_name, mutate) => {
    expect(manageableSettingsSchema.safeParse(settingsWith(mutate)).success).toBe(false);
  });

  it.each([
    ['chat.maxInputChars=32000', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, maxInputChars: 32000 } })],
    ['chat.titleMaxChars=80', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, titleMaxChars: 80 } })],
    ['chat.maxMessagesInContext=500', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, maxMessagesInContext: 500 } })],
    ['chat.retryMaxAttempts=3', (s: ManageableSettings) => ({ ...s, chat: { ...s.chat, retryMaxAttempts: 3 } })],
    ['empty model id', (s: ManageableSettings) => ({ ...s, openRouter: { ...s.openRouter, modelId: '' } })],
    ['200-char model id', (s: ManageableSettings) => ({ ...s, openRouter: { ...s.openRouter, modelId: 'm'.repeat(200) } })],
    ['tts flux-cole-en', (s: ManageableSettings) => ({ ...s, deepgram: { ...s.deepgram, ttsModel: 'flux-cole-en' } })],
    ['tts flux-priya-en', (s: ManageableSettings) => ({ ...s, deepgram: { ...s.deepgram, ttsModel: 'flux-priya-en' } })],
    ['50 keyterms', (s: ManageableSettings) => ({
      ...s, deepgram: { ...s.deepgram, keyterms: Array.from({ length: 50 }, (_, i) => `term${i}`) },
    })],
    ['threshold 0.5', (s: ManageableSettings) => ({ ...s, deepgram: { ...s.deepgram, eotThreshold: 0.5 } })],
    ['threshold 1', (s: ManageableSettings) => ({ ...s, deepgram: { ...s.deepgram, eotThreshold: 1 } })],
    ['live warning just below max', (s: ManageableSettings) => ({
      ...s, voice: { ...s.voice, limits: { ...s.voice.limits, liveWarningMs: s.voice.limits.liveMaxMs - 1 } },
    })],
    ['equal identity and global quotas', (s: ManageableSettings) => ({
      ...s, voice: { ...s.voice, quotas: { ...s.voice.quotas, identityConcurrent: 4, globalConcurrent: 4 } },
    })],
    ['zero known rates with positive spend', (s: ManageableSettings) => ({
      ...s,
      voice: { ...s.voice, quotas: { ...s.voice.quotas, dailySpendUsd: 1 } },
      deepgram: { ...s.deepgram, rates: { novaPerMinuteUsd: 0, fluxSttPerMinuteUsd: 0, fluxTtsPerThousandCharsUsd: 0 } },
    })],
    ['null dictation warning', (s: ManageableSettings) => ({ ...s, voice: { ...s.voice, dictationWarningMs: null } })],
    ['dictation warning just below max', (s: ManageableSettings) => ({
      ...s, voice: { ...s.voice, dictationWarningMs: s.voice.limits.dictationMaxMs - 1 },
    })],
    ['dictation on live off', (s: ManageableSettings) => ({
      ...s, voice: { ...s.voice, enabledModes: { dictation: true, live: false } },
    })],
    ['live on dictation off', (s: ManageableSettings) => ({
      ...s, voice: { ...s.voice, enabledModes: { dictation: false, live: true } },
    })],
  ] as const)('accepts %s', (_name, mutate) => {
    expect(manageableSettingsSchema.safeParse(settingsWith(mutate)).success).toBe(true);
  });

  it('retains legacy idle fields without treating their sum as a live duration bound', () => {
    const s = defaultManageableSettings();
    s.voice.limits.liveMaxMs = 30_000;
    s.voice.limits.liveWarningMs = 20_000;
    expect(manageableSettingsSchema.safeParse(s).success).toBe(true);
    expect(manageableSettingsSchema.safeParse({ ...s, voice: { ...s.voice,
      limits: { ...s.voice.limits, idleExitAfterWarningMs: 0 } } }).success).toBe(false);
    expect(manageableSettingsSchema.safeParse({ ...s, voice: { ...s.voice,
      silenceGateMs: 5000 } }).success).toBe(false);
  });

  it('defaults legacy dev enablement off, accepting only a boolean and never a mode', () => {
    const defaults = defaultManageableSettings();
    const legacy = { ...defaults };
    delete legacy.devModeEnabled;
    expect(isManageableSettings(legacy)).toBe(true);
    const doc = {
      _id: 'aurvin', schemaVersion: 1, revision: 1, settings: legacy,
      credentials: { openrouter: null, deepgram: null },
      updatedAt: '2026-11-10T00:00:00.000Z', updatedBy: 'admin',
    };
    expect(storedConfigDocumentSchema.parse(doc).settings.devModeEnabled).toBe(false);
    expect(defaults.devModeEnabled).toBe(false);
    const enabled = { ...defaults, devModeEnabled: true };
    expect(manageableSettingsSchema.parse(enabled).devModeEnabled).toBe(true);
    expect(isManageableSettings(enabled)).toBe(true);
    for (const raw of [{ ...defaults, devModeEnabled: 'true' },
      { ...defaults, devModeEnabled: null }, { ...defaults, mode: 'dev' }]) {
      expect(manageableSettingsSchema.safeParse(raw).success).toBe(false);
      expect(storedConfigDocumentSchema.safeParse({ ...doc, settings: raw }).success).toBe(false);
      expect(isManageableSettings(raw)).toBe(false);
    }
  });
});

describe('admin config requests and storage', () => {
  it('scopes CAS credential operations separately from nonsecret saves', () => {
    const settings = defaultManageableSettings();
    const save = { protocolVersion: 1, expectedRevision: 0, settings };
    expect(saveSettingsRequestSchema.safeParse(save).success).toBe(true);
    expect(saveSettingsRequestSchema.safeParse({ ...save, candidate: 'fixture-key' }).success).toBe(false);
    const replace = { protocolVersion: 1, expectedRevision: 7, action: 'replace', candidate: 'fixture-key' };
    expect(credentialUpdateRequestSchema.safeParse(replace).success).toBe(true);
    for (const raw of [
      { ...replace, settings }, { ...replace, providerUrl: 'https://evil.invalid' },
      { ...replace, role: 'super-admin' }, { ...replace, expectedRevision: -1 },
      { ...replace, candidate: '' }, { ...replace, candidate: ' x ' },
      { ...replace, candidate: 'x'.repeat(4097) },
      { protocolVersion: 1, expectedRevision: 7, action: 'remove' },
      { protocolVersion: 1, expectedRevision: 7, action: 'remove', confirm: false },
    ]) expect(credentialUpdateRequestSchema.safeParse(raw).success).toBe(false);
    expect(credentialUpdateRequestSchema.safeParse({ protocolVersion: 1,
      expectedRevision: 7, action: 'remove', confirm: true }).success).toBe(true);
  });

  it('rejects invalid stored documents and noncanonical envelopes', () => {
    const valid = {
      _id: 'aurvin', schemaVersion: 1, revision: 1, settings: defaultManageableSettings(),
      credentials: { openrouter: null, deepgram: null },
      updatedAt: '2026-10-13T00:00:00.000Z', updatedBy: 'aurvin-dev-user',
    };
    expect(storedConfigDocumentSchema.safeParse(valid).success).toBe(true);
    const envelope = {
      algorithm: 'aes-256-gcm',
      nonce: Buffer.alloc(12).toString('base64'),
      tag: Buffer.alloc(16).toString('base64'),
      ciphertext: Buffer.from('fixture').toString('base64'),
    };
    expect(storedConfigDocumentSchema.safeParse({
      ...valid,
      credentials: {
        openrouter: { validatedAt: '2026-10-13T00:00:00.000Z', envelope },
        deepgram: null,
      },
    }).success).toBe(true);
    for (const raw of [
      { ...valid, revision: 0 },
      { ...valid, revision: 2 ** 53 },
      { ...valid, extra: true },
      { ...valid, _id: 'other' },
      { ...valid, schemaVersion: 2 },
      { ...valid, credentials: { openrouter: { apiKey: 'plaintext' }, deepgram: null } },
      { ...valid, credentials: { openrouter: { validatedAt: '2026-10-13T00:00:00.000Z', envelope: { ...envelope, algorithm: 'aes-256-cbc' } }, deepgram: null } },
      { ...valid, credentials: { openrouter: { validatedAt: '2026-10-13T00:00:00.000Z', envelope: { ...envelope, ciphertext: envelope.ciphertext.replace(/=/g, '') } }, deepgram: null } },
      { ...valid, credentials: { openrouter: { validatedAt: '2026-10-13T00:00:00.000Z', envelope: { ...envelope, ciphertext: Buffer.alloc(4097).toString('base64') } }, deepgram: null } },
      { ...valid, updatedAt: 'not-a-date' },
      { ...valid, updatedBy: '' },
    ]) expect(storedConfigDocumentSchema.safeParse(raw).success).toBe(false);
  });

  it('projects only configured-state metadata, not envelopes or secrets', () => {
    const document = storedConfigDocumentSchema.parse({
      _id: 'aurvin', schemaVersion: 1, revision: 2, settings: defaultManageableSettings(),
      credentials: { openrouter: { validatedAt: '2026-10-13T00:00:00.000Z', envelope: {
        algorithm: 'aes-256-gcm', nonce: Buffer.alloc(12).toString('base64'),
        tag: Buffer.alloc(16).toString('base64'), ciphertext: Buffer.from('fixture-secret').toString('base64'),
      } }, deepgram: null }, updatedAt: '2026-10-13T00:00:00.000Z', updatedBy: 'aurvin-dev-user',
    });
    const pub = projectPublicAdminConfig(document, null, 'blocked', floorAssets);
    expect(pub.credentials).toEqual({ openrouter: { configured: true,
      validatedAt: '2026-10-13T00:00:00.000Z' }, deepgram: { configured: false, validatedAt: null } });
    expect(pub.activeRevision).toBeNull();
    expect(pub.roleAssumption.authentication).toBe('session');
    const text = JSON.stringify(pub);
    for (const word of ['fixture-secret', 'envelope', 'ciphertext', 'nonce', 'fingerprint', 'updatedBy'])
      expect(text).not.toContain(word);
    expect(isPublicAdminConfig(pub)).toBe(true);
    expect(isPublicAdminConfig({ ...pub, credentials: { ...pub.credentials,
      openrouter: { ...pub.credentials.openrouter, lastCharacters: 'secret' } } })).toBe(false);
  });

  it('mirrors only the public admin contract into the frontend', () => {
    const backendText = readFileSync(new URL('./admin-config-wire.ts', import.meta.url), 'utf8');
    const frontendText = readFileSync(new URL('../../../frontend/src/api/admin-config-protocol.ts', import.meta.url), 'utf8');
    const exportedBody = (text: string) => text.slice(text.indexOf('export const ADMIN_CONFIG_PROTOCOL_VERSION'));
    const normalize = (text: string) => text.replace(/\r\n/g, '\n');
    // Frontend admin-protocol cutover completed: verify direct mirror of the public admin wire contract.
    expect(normalize(exportedBody(frontendText))).toBe(normalize(exportedBody(backendText)));
    expect(frontendText).not.toMatch(/from ['"].*(platform|admin-config-runtime|config-runtime|persistence|node:)/);
    for (const word of ['AURVIN_CONFIG_ENCRYPTION_KEY', 'StoredConfigDocument',
      'EncryptedCredentialEnvelope', 'DecryptedCredentials', 'RuntimeConfigSnapshot'])
      expect(frontendText).not.toContain(word);
  });
});

describe('webSearch manageable limits', () => {
  it('defaults to 5/5 with empty blockedDomains and exposes three manageable paths', () => {
    const settings = defaultManageableSettings();
    expect(settings.webSearch).toEqual({
      maxSearchesPerTurn: 5, maxFetchesPerTurn: 5, blockedDomains: [],
    });
    expect(ADMIN_CONFIG_FIELD_PATHS.filter(p => p.startsWith('webSearch.'))).toEqual([
      'webSearch.maxSearchesPerTurn', 'webSearch.maxFetchesPerTurn', 'webSearch.blockedDomains',
    ]);
    expect(manageableSettingsSchema.parse(settings).webSearch).toEqual(settings.webSearch);
    expect(isManageableSettings(settings)).toBe(true);
  });
  it.each([0, -1, 21, 1.5, '5', null, Infinity, Number.NaN, 2 ** 53])(
    'rejects webSearch limit %s at schema and public guard', value => {
      for (const field of ['maxSearchesPerTurn', 'maxFetchesPerTurn']) {
        const s = defaultManageableSettings();
        const raw = { ...s, webSearch: { ...s.webSearch, [field]: value } };
        expect(manageableSettingsSchema.safeParse(raw).success).toBe(false);
        expect(isManageableSettings(raw)).toBe(false);
      }
    });
  it.each([1, 5, 20])('accepts independent integer webSearch limits %s', value => {
    const s = defaultManageableSettings();
    s.webSearch = { maxSearchesPerTurn: value, maxFetchesPerTurn: 21 - value, blockedDomains: [] };
    expect(manageableSettingsSchema.safeParse(s).success).toBe(true);
    expect(isManageableSettings(s)).toBe(true);
  });
  it('validates unique canonical blockedDomains up to 100 entries', () => {
    const valid = defaultManageableSettings();
    valid.webSearch.blockedDomains = ['reddit.com', 'old.reddit.com', 'docs.example.co.uk'];
    expect(manageableSettingsSchema.safeParse(valid).success).toBe(true);
    expect(isManageableSettings(valid)).toBe(true);
    for (const blockedDomains of [
      ['https://reddit.com'],
      ['reddit.com/r/news'],
      ['REDDIT.COM'],
      ['reddit.com', 'reddit.com'],
      ['localhost'],
      ['127.0.0.1'],
      ['*.reddit.com'],
      Array.from({ length: 101 }, (_, i) => `site-${i}.example.com`),
    ]) {
      const s = defaultManageableSettings();
      const raw = { ...s, webSearch: { ...s.webSearch, blockedDomains } };
      expect(manageableSettingsSchema.safeParse(raw).success).toBe(false);
      expect(isManageableSettings(raw)).toBe(false);
    }
  });
  it('keeps enablement, secrets and fixed repairs outside administrator settings', () => {
    const s = defaultManageableSettings();
    for (const extra of [{ enabled: true }, { apiKey: 'secret' },
      { maxSchemaRepairAttemptsPerTurn: 9 }, { provider: 'exa' }]) {
      const raw = { ...s, webSearch: { ...s.webSearch, ...extra } };
      expect(manageableSettingsSchema.safeParse(raw).success).toBe(false);
      expect(isManageableSettings(raw)).toBe(false);
    }
  });
  it('upcasts only absent legacy stored webSearch settings, not malformed values or new saves', () => {
    const full = defaultManageableSettings();
    const { webSearch: ignored, ...legacySettings } = full;
    expect(ignored.maxSearchesPerTurn).toBe(5);
    const legacy = { _id: 'aurvin', schemaVersion: 1, revision: 7, settings: legacySettings,
      credentials: { openrouter: null, deepgram: null },
      updatedAt: '2026-11-14T00:00:00.000Z', updatedBy: 'fixture-user' };
    const parsed = storedConfigDocumentSchema.parse(legacy);
    expect(parsed.settings.webSearch).toEqual({
      maxSearchesPerTurn: 5, maxFetchesPerTurn: 5, blockedDomains: [],
    });
    expect(parsed.revision).toBe(7);
    expect(legacy.settings).not.toHaveProperty('webSearch');
    const legacyWithoutBlocklist = storedConfigDocumentSchema.parse({
      ...legacy, settings: { ...legacySettings, webSearch: { maxSearchesPerTurn: 3, maxFetchesPerTurn: 4 } },
    });
    expect(legacyWithoutBlocklist.settings.webSearch).toEqual({
      maxSearchesPerTurn: 3, maxFetchesPerTurn: 4, blockedDomains: [],
    });
    expect(saveSettingsRequestSchema.safeParse({
      protocolVersion: 1, expectedRevision: 7, settings: legacySettings,
    }).success).toBe(false);
    for (const webSearch of [null, {}, { maxSearchesPerTurn: 5 }, { maxSearchesPerTurn: 0, maxFetchesPerTurn: 5 }]) {
      expect(storedConfigDocumentSchema.safeParse({
        ...legacy, settings: { ...legacySettings, webSearch },
      }).success).toBe(false);
    }
  });

  it('defaults only an absent stored reasoning effort without accepting malformed settings', () => {
    const settings = defaultManageableSettings();
    expect(settings.openRouter.reasoningEffort).toBe('provider-default');
    const legacy = JSON.parse(JSON.stringify({
      _id: 'aurvin', schemaVersion: 1, revision: 7, settings,
      credentials: { openrouter: null, deepgram: null },
      updatedAt: '2026-11-16T12:00:00.000Z', updatedBy: 'aurvin-dev-user',
    }));
    delete legacy.settings.openRouter.reasoningEffort;
    const normalized = storedConfigDocumentSchema.parse(legacy);
    expect(normalized.revision).toBe(7);
    expect(normalized.settings.openRouter.reasoningEffort).toBe('provider-default');
    expect(manageableSettingsSchema.safeParse(legacy.settings).success).toBe(false);
    for (const value of [null, 'automatic', 1]) {
      legacy.settings.openRouter.reasoningEffort = value;
      expect(storedConfigDocumentSchema.safeParse(legacy).success).toBe(false);
    }
  });
});

describe('compaction manageable settings', () => {
  const defaults = { enabled: true, watermarkRatio: 0.8,
    modelMode: 'active-fork', customModelId: null };
  it('defaults fresh and legacy-import settings without sharing mutable state', () => {
    const first = defaultManageableSettings();
    expect(first.compaction).toEqual(defaults);
    expect(parseLegacyConfigImport({}, loadBootstrapConfig({})).settings.compaction).toEqual(defaults);
    first.compaction.enabled = false;
    expect(defaultManageableSettings().compaction).toEqual(defaults);
    expect(ADMIN_CONFIG_FIELD_PATHS.filter(path => path.startsWith('compaction.'))).toEqual([
      'compaction.enabled', 'compaction.watermarkRatio',
      'compaction.modelMode', 'compaction.customModelId',
    ]);
  });
  it.each([0.5, 0.8, 0.9])('accepts bounded watermark %s through schema and wire', watermarkRatio => {
    const s = defaultManageableSettings();
    const raw = { ...s, compaction: { ...defaults, watermarkRatio } };
    expect(manageableSettingsSchema.safeParse(raw).success).toBe(true);
    expect(isManageableSettings(raw)).toBe(true);
  });
  it('accepts custom mode only with a nonempty bounded model ID', () => {
    const s = defaultManageableSettings();
    for (const customModelId of ['fixture/cheap', 'm'.repeat(200)]) {
      const raw = { ...s, compaction: { ...defaults, modelMode: 'custom', customModelId } };
      expect(manageableSettingsSchema.safeParse(raw).success).toBe(true);
      expect(isManageableSettings(raw)).toBe(true);
    }
    for (const compaction of [
      null, {}, { ...defaults, enabled: 'true' }, { ...defaults, watermarkRatio: 0.49 },
      { ...defaults, watermarkRatio: 0.91 }, { ...defaults, watermarkRatio: Infinity },
      { ...defaults, watermarkRatio: Number.NaN }, { ...defaults, watermarkRatio: '0.8' },
      { ...defaults, modelMode: 'other' }, { ...defaults, modelMode: 'custom' },
      { ...defaults, customModelId: '' }, { ...defaults, customModelId: ' x ' },
      { ...defaults, customModelId: 'a\nb' }, { ...defaults, customModelId: 'm'.repeat(201) },
      { ...defaults, apiKey: 'secret' },
    ]) {
      const raw = { ...s, compaction };
      expect(manageableSettingsSchema.safeParse(raw).success).toBe(false);
      expect(isManageableSettings(raw)).toBe(false);
    }
  });
  it('defaults only absent stored compaction, never malformed values or new saves', () => {
    const full = defaultManageableSettings();
    const { compaction: ignored, ...oldSettings } = full;
    expect(ignored).toEqual(defaults);
    const old = { _id: 'aurvin', schemaVersion: 1, revision: 7, settings: oldSettings,
      credentials: { openrouter: null, deepgram: null },
      updatedAt: '2026-11-17T11:00:00.000Z', updatedBy: 'fixture-user' };
    expect(storedConfigDocumentSchema.parse(old).settings.compaction).toEqual(defaults);
    expect(old.settings).not.toHaveProperty('compaction');
    expect(saveSettingsRequestSchema.safeParse({
      protocolVersion: 1, expectedRevision: 7, settings: oldSettings,
    }).success).toBe(false);
    for (const compaction of [null, {}, { enabled: false }]) {
      expect(storedConfigDocumentSchema.safeParse({
        ...old, settings: { ...oldSettings, compaction },
      }).success).toBe(false);
    }
  });
});
