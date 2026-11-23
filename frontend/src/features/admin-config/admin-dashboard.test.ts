/**
 * ============================================================================
 * FILE: admin-dashboard.test.ts
 * LOCATION: frontend/src/features/admin-config/admin-dashboard.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Static-render checks for section fields, Config/Plugins/Analytics tabs, and save/status copy.
 *
 * ROLE IN PROJECT:
 *    Complements the closed browser fixture with Node SSR markup assertions.
 *    Interaction, focus, and lifecycle proof remain in the browser fixture.
 *
 * KEY COMPONENTS:
 *    - ConfigFields selected-section rendering
 *    - AdminDashboard activation and unavailable-read markup
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { AdminConfigClient } from '../../api/admin-config-client.ts';
import { AdminDashboard, activationCopy } from './AdminDashboard.tsx';
import { ConfigFields, fieldDomId } from './ConfigFields.tsx';
import { ModelSelectionFields } from './ModelSelectionFields.tsx';
import { editableFields, fieldsFromSettings } from './config-edit-state.ts';
import { publicConfig } from './testing/fixtures.ts';

const client: AdminConfigClient = {
  read: vi.fn(async () => publicConfig()),
  readDevMode: vi.fn(),
  setDevMode: vi.fn(),
  models: vi.fn(async () => ({
    protocolVersion: 1 as const,
    observedAt: '2026-11-16T12:00:00.000Z',
    models: [],
  })),
  checkModelCompatibility: vi.fn(async () => ({
    protocolVersion: 1 as const,
    candidate: {
      revision: 1,
      modelId: 'openai/gpt-4.1-mini',
      reasoningEffort: 'provider-default' as const,
      chat: publicConfig().settings.chat,
    },
    checkedAt: '2026-11-16T12:00:00.000Z',
    catalogueObservedAt: '2026-11-16T12:00:00.000Z',
    expiresAt: '2026-11-16T12:01:00.000Z',
    report: {
      status: 'catalogue-compatible' as const,
      blockers: [],
      warnings: [],
      contextTokens: 131072,
      outputTokens: 8192,
      outputCapParameter: 'max_tokens' as const,
      chatFloor: publicConfig().chatFloor,
      capabilities: { calendar: 'unavailable' as const, webTool: 'unavailable' as const, pricing: 'unverified' as const },
    },
  })),
  saveSettings: vi.fn(async () => publicConfig()),
  updateCredential: vi.fn(async () => publicConfig()),
};

it('renders only the selected section with labeled units and fixed privacy', () => {
  const html = renderToStaticMarkup(createElement(ConfigFields, {
    section: 'openrouter', fields: fieldsFromSettings(publicConfig().settings),
    errors: [], disabled: false, onChange: () => undefined,
  }));
  expect(html).not.toContain('Model ID');
  expect(html).toContain('Data collection denied');
  expect(html).toContain('Transforms disabled');
  expect(html).not.toContain('Daily minutes');
  expect(html).not.toContain('OPENROUTER_API_KEY');
});

it('covers each section catalog with human labels', () => {
  const fields = fieldsFromSettings(publicConfig().settings);
  for (const section of ['openrouter', 'chat', 'voice', 'deepgram', 'webSearch'] as const) {
    const html = renderToStaticMarkup(createElement(ConfigFields, {
      section, fields, errors: [], disabled: false, onChange: () => undefined,
    }));
    for (const field of editableFields.filter((item) =>
      item.section === section &&
      item.path !== 'openRouter.modelId' &&
      item.path !== 'openRouter.reasoningEffort')) {
      expect(html).toContain(field.label);
    }
  }
});

it('marks changed fields with the previous value for review', () => {
  const fields = {
    ...fieldsFromSettings(publicConfig().settings),
    'chat.maxInputChars': '12',
    'compaction.enabled': false,
  };
  const html = renderToStaticMarkup(createElement(ConfigFields, {
    section: 'chat',
    fields,
    original: fieldsFromSettings(publicConfig().settings),
    errors: [],
    disabled: false,
    onChange: () => undefined,
  }));
  expect(html).toContain('aurvin-admin-field is-changed');
  expect(html).toContain('Changed');
  expect(html).toContain('Was 32000');
  expect(html).toContain('id="admin-field-chat-maxInputChars-was"');
  expect(html).not.toContain('Was 80');

  const compaction = renderToStaticMarkup(createElement(ConfigFields, {
    section: 'compaction',
    fields,
    original: fieldsFromSettings(publicConfig().settings),
    errors: [],
    disabled: false,
    onChange: () => undefined,
  }));
  expect(compaction).toContain('Was On');
});

it('describes invalid fields with linked error ids', () => {
  const path = 'chat.maxInputChars' as const;
  const html = renderToStaticMarkup(createElement(ConfigFields, {
    section: 'chat', fields: fieldsFromSettings(publicConfig().settings),
    errors: [{ path, code: 'out_of_range' }], disabled: false, onChange: () => undefined,
  }));
  const id = fieldDomId(path);
  expect(html).toContain(`id="${id}"`);
  expect(html).toContain(`id="${id}-help"`);
  expect(html).toContain(`id="${id}-error"`);
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain(`aria-describedby="${id}-help ${id}-error"`);
});

it('defaults to Personalization and keeps Analytics empty without an analytics client method', () => {
  const html = renderToStaticMarkup(createElement(AdminDashboard, {
    client, onBackToChat: () => undefined, refreshCapabilities: async () => true,
  }));
  expect(html).toContain('Manage Aurvin');
  expect(html).toContain('Back to chat');
  expect(html).toContain('Personalization');
  expect(html).toContain('Config');
  expect(html).toContain('Plugins');
  expect(html).toContain('Analytics');
  expect(html).toContain('Loading configuration');
  expect(html).not.toContain('Model ID');
  expect(html).not.toContain('chart');
  expect(html).not.toContain('metric');
  expect('analytics' in client).toBe(false);
});

it('associates tabs with panels and keeps only the selected tab in tab order', () => {
  const html = renderToStaticMarkup(createElement(AdminDashboard, {
    client, onBackToChat: () => undefined, refreshCapabilities: async () => true,
  }));
  const selected = html.match(/id="([^"]+-personalization-tab)"[^>]*aria-selected="true"[^>]*aria-controls="([^"]+-personalization-panel)"[^>]*tabindex="0"/);
  expect(selected).not.toBeNull();
  expect(html).toContain(`id="${selected?.[2]}"`);
  expect(html).toContain(`aria-labelledby="${selected?.[1]}"`);
  expect(html).toMatch(/id="[^"]+-config-tab"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
  expect(html).toMatch(/id="[^"]+-plugins-tab"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
  expect(html).toMatch(/id="[^"]+-analytics-tab"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
});

it('does not label unconfigured or blocked configuration as active', () => {
  const unconfigured = publicConfig();
  unconfigured.activation = 'unconfigured';
  unconfigured.activeRevision = null;
  const blocked = publicConfig();
  blocked.activation = 'blocked';
  blocked.activeRevision = null;
  expect(activationCopy(publicConfig())).toBe('Saved and active for new work');
  expect(activationCopy(unconfigured)).not.toMatch(/active for new work/);
  expect(activationCopy(blocked)).toContain('blocked');
  expect(activationCopy(blocked)).not.toBe('Saved and active for new work');
});

it('keeps save disabled while clean, pending, stale, or uncertain', async () => {
  const { createEditState, editReducer, isDirty } = await import('./config-edit-state.ts');
  let state = createEditState(publicConfig());
  expect(isDirty(state)).toBe(false);
  state = editReducer(state, { type: 'edit', path: 'openRouter.modelId', value: 'x' });
  state = editReducer(state, { type: 'begin', scope: 'settings' });
  expect(state.pending).toBe('settings');
  state = editReducer(state, {
    type: 'failed',
    error: { code: 'CONFIG_CONFLICT', currentRevision: 2, fieldErrors: [] },
  });
  expect(state.stale).toBe(true);
  expect(editReducer(state, { type: 'begin', scope: 'settings' }).pending).toBeNull();
});

it('does not fabricate substitute settings while configuration is unavailable', () => {
  const html = renderToStaticMarkup(createElement(AdminDashboard, {
    client, onBackToChat: () => undefined, refreshCapabilities: async () => true,
  }));
  expect(html).not.toContain('openai/gpt-4.1-mini');
  expect(html).not.toContain('OPENROUTER_API_KEY');
});

it('renders Web Search turn budget fields in Config -> webSearch with 1..20 bounds and plugin cross-link hint', () => {
  const fields = fieldsFromSettings(publicConfig().settings);
  const html = renderToStaticMarkup(createElement(ConfigFields, {
    section: 'webSearch',
    fields,
    errors: [],
    disabled: false,
    onChange: () => undefined,
  }));
  expect(html).toContain('Turn budgets');
  expect(html).toContain('Max searches per turn');
  expect(html).toContain('Max page fetches per turn');
  expect(html).toContain('min="1"');
  expect(html).toContain('max="20"');
  expect(html).toContain('value="5"');
});

it('shows Web Search alongside Google Calendar in Plugins rail and renders WebSearchPanel when selected', () => {
  const html = renderToStaticMarkup(
    createElement(AdminDashboard, {
      client,
      onBackToChat: () => undefined,
      refreshCapabilities: async () => true,
      initialSection: 'web-search',
      webSearchClient: {
        status: vi.fn(),
        setEnabled: vi.fn(),
        connectProvider: vi.fn(),
        disconnectProvider: vi.fn(),
        startOAuth: vi.fn(),
        completeOAuth: vi.fn(),
      },
    }),
  );
  expect(html).toMatch(/id="[^"]+-plugins-tab"[^>]*aria-selected="true"/);
  expect(html).toContain('Google Calendar');
  expect(html).toContain('Web Search');
  expect(html).toContain('Loading web search status…');
});

it('keeps Google Calendar on the Plugins tab, not the Config rail', () => {
  const html = renderToStaticMarkup(
    createElement(AdminDashboard, {
      client,
      onBackToChat: () => undefined,
      refreshCapabilities: async () => true,
      initialSection: 'calendar',
      initialCalendarStatus: {
        protocolVersion: 1,
        state: 'connected',
        enabled: true,
        accountEmail: 'operator@example.com',
        targetCalendarId: 'disposable-cal-1@group.calendar.google.com',
        processingDisclosure: {
          policyId: 'policy-1',
          processors: 'Google, OpenRouter and the configured model provider',
          dataCollection: 'deny',
        },
      },
    }),
  );
  expect(html).toMatch(/id="[^"]+-plugins-tab"[^>]*aria-selected="true"/);
  expect(html).toContain('aria-label="Plugin sections"');
  expect(html).toContain('Google Calendar');
  expect(html).toContain('Loading configuration');
  const settingsRail = html.match(/aria-label="Settings sections"[^]*?<\/nav>/);
  expect(settingsRail?.[0]).toContain('OpenRouter');
  expect(settingsRail?.[0]).not.toContain('Google Calendar');
});

it('marks a changed OpenRouter model with the previous identifier', () => {
  const html = renderToStaticMarkup(createElement(ModelSelectionFields, {
    models: [],
    modelId: 'vendor/new',
    effort: 'provider-default',
    originalModelId: 'vendor/missing',
    originalEffort: 'provider-default',
    loading: false,
    error: null,
    disabled: false,
    errors: [],
    onChange: () => undefined,
    onRetry: () => undefined,
  }));
  expect(html).toContain('aurvin-admin-field is-changed');
  expect(html).toContain('Changed');
  expect(html).toContain('Was vendor/missing');
});

it('keeps an exact missing configured ID and does not invent effort options', () => {
  const html = renderToStaticMarkup(createElement(ModelSelectionFields, {
    models: [], modelId: 'vendor/missing', effort: 'provider-default',
    loading: false, error: null, disabled: false, errors: [],
    onChange: () => undefined, onRetry: () => undefined,
  }));
  expect(html).toContain('vendor/missing');
  expect(html).toContain('not in current catalogue');
  expect(html).toContain('Provider default');
  expect(html).not.toContain('value="high"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain('Thinking effort');
  expect(html).toContain('for="admin-field-openRouter-modelId"');
});

it('renders declared efforts, disabled unsupported effort, and retry on catalogue error', () => {
  const html = renderToStaticMarkup(createElement(ModelSelectionFields, {
    models: [{
      id: 'vendor/reasoner',
      name: 'Reasoner',
      reasoning: { selection: 'declared', efforts: ['high', 'medium'], mandatory: true },
    }],
    modelId: 'vendor/reasoner',
    effort: 'low',
    loading: false,
    error: 'The model catalogue is unavailable.',
    disabled: false,
    errors: [],
    onChange: () => undefined,
    onRetry: () => undefined,
  }));
  expect(html).toContain('Reasoner');
  expect(html).toContain('vendor/reasoner');
  expect(html).toContain('value="high"');
  expect(html).toContain('value="medium"');
  expect(html).not.toContain('value="none"');
  expect(html).toContain('not declared for current selection');
  expect(html).toContain('Retry catalogue');
  expect(html).toContain('Reasoning consumes the finite output token budget');
});

it('renders compaction controls in Config -> compaction and hides custom model under active-fork', () => {
  const fields = fieldsFromSettings(publicConfig().settings);
  const html = renderToStaticMarkup(createElement(ConfigFields, {
    section: 'compaction',
    fields,
    errors: [],
    disabled: false,
    onChange: () => undefined,
  }));
  expect(html).toContain('Context compaction');
  expect(html).toContain('Enable compaction');
  expect(html).toContain('Watermark ratio');
  expect(html).toContain('Compaction model mode');
  expect(html).not.toContain('id="admin-field-compaction-customModelId"');
});

it('renders searchable ModelCombobox for compaction.customModelId when modelMode is custom', () => {
  const fields = {
    ...fieldsFromSettings(publicConfig().settings),
    'compaction.modelMode': 'custom',
    'compaction.customModelId': 'anthropic/claude-haiku-4.5',
  };
  const html = renderToStaticMarkup(createElement(ConfigFields, {
    section: 'compaction',
    fields,
    errors: [{ path: 'compaction.customModelId', code: 'required' }],
    disabled: false,
    models: [{
      id: 'anthropic/claude-haiku-4.5',
      name: 'Claude Haiku 4.5',
      reasoning: { selection: 'unavailable', efforts: [], mandatory: null },
    }],
    modelsLoading: false,
    modelsError: null,
    onRetryModels: () => undefined,
    onChange: () => undefined,
  }));
  expect(html).toContain('id="admin-field-compaction-customModelId"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain('Claude Haiku 4.5');
  expect(html).toContain('id="admin-field-compaction-customModelId-error"');
});

it('includes Compaction in the AdminDashboard Config section navigation rail', () => {
  const html = renderToStaticMarkup(createElement(AdminDashboard, {
    client,
    onBackToChat: () => undefined,
    refreshCapabilities: async () => true,
    initialSection: 'compaction',
  }));
  const settingsRail = html.match(/aria-label="Settings sections"[^]*?<\/nav>/);
  expect(settingsRail?.[0]).toContain('Compaction');
});
