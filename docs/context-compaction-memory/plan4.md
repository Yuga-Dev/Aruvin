# Frontend Chat Checkpoint UI, Context Meter & Admin Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface in-session context compaction in the frontend through Admin Config controls (`compaction.*`), wire/SSE context-state parsing, a quiet inline `Transcript` checkpoint divider with optional summary preview, and a quiet `Composer` context-utilization meter that stays completely silent in Live Voice.

**Architecture:** Consumes P1's already-mirrored `frontend/src/api/admin-config-protocol.ts` without modifying it, aligns `admin-config` fixtures and field catalog (`catalogCoverage`) first so TypeScript builds immediately, extends `frontend/src/api/protocol.ts` and `client.ts` with strict `CompactionCheckpointMeta` / `ContextUsageMeta` / `context-state` validation, threads `compaction` and `contextUsage` through `chat-reducer.ts` and `use-chat.ts` (including bounded idle polling while `status === 'compacting'`), and renders quiet text-only UI inside `Transcript.tsx` and `Composer.tsx` while `LiveVoicePanel` stays completely silent.

**Tech Stack:** TypeScript 6.0 (`tsc -b`), React 19, Vite 8, Vitest 4 (Node SSR via `renderToStaticMarkup`), oxlint, CSS custom properties.

---

## Scope, Ownership, and Baseline Notes

- **Owned files only:** `frontend/src/api/protocol.ts`, `frontend/src/api/client.ts`, `frontend/src/features/chat/**`, `frontend/src/components/{Transcript,Composer}.tsx`, `frontend/src/features/admin-config/**`, `frontend/src/styles/**`, and targeted tests in `frontend/src/**/*.test.ts`.
- **Do NOT modify:** `frontend/src/api/admin-config-protocol.ts` (P1-owned verbatim mirror pinned by backend `admin-config.spec.ts`), `frontend/src/api/voice-protocol.ts`, `frontend/src/App.tsx`, `backend/**`, or untracked user files (`output/`, `benchmarks/voice-architectures/**`, `.openchamber/**`).
- **Pre-existing baseline caveat observed prior to P4:** `frontend/src/api/testing/voice-fixtures.test.ts` currently has a pre-existing unrelated failure (`bargeInSpeechWindows: 10` parity mismatch between unowned `voice-protocol.ts` and `backend/src/contracts/voice-wire.ts`). Do not touch unowned `voice-protocol.ts`; record its status separately if still present during final verification.
- **Git hygiene:** Workers/orchestrator serialize git commits centrally using explicit `git add <named files>`. Never run `git add .`.
- **Mandatory file header:** Any new code file (e.g., `compaction-chat-state.test.ts`) must start with the repository's `FILE / LOCATION / PURPOSE / ROLE IN PROJECT / KEY COMPONENTS` JSDoc header.

---

### Task 1: Admin Config Fixtures & Field Catalog (`compaction.*` + `catalogCoverage`)

**Files:**
- Modify: `frontend/src/features/admin-config/testing/fixtures.ts:20-61`
- Modify: `frontend/src/features/admin-config/config-edit-state.ts:20-62,121-143,313-357,370-432,580-617`
- Test: `frontend/src/features/admin-config/config-edit-state.test.ts`

**Why `compatibilityKey` stays scoped to `openRouter` + `chat`:** In P1's frozen `admin-config-protocol.ts`, `ModelCompatibilityResponse.candidate` strictly validates exact keys `{ revision, modelId, reasoningEffort, chat }` (and backend `AdminConfigService.checkModelCompatibility` echoes only those fields). Putting `compaction.*` into `compatibilityKey` would make `respKey !== key` permanently lock Save. Server `saveSettings` validates `compaction.customModelId` against the catalogue directly; client `settingsFromFields` validates `watermarkRatio` (`0.5..0.9`), `modelMode` (`'active-fork' | 'custom'`), and `customModelId` required when `modelMode === 'custom'`.

- [ ] **Step 1: Write the failing test in `frontend/src/features/admin-config/config-edit-state.test.ts`**

Append after the last `it(...)` block in `frontend/src/features/admin-config/config-edit-state.test.ts`:

```ts
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
```

- [ ] **Step 2: Run targeted test to verify failure**

Run from `frontend/`:
```bash
npx vitest run src/features/admin-config/config-edit-state.test.ts
```
Expected: FAIL — `publicConfig().settings.compaction` is `undefined`, `catalogCoverage` is missing the 4 `compaction.*` paths, and `isManageableSettings(publicConfig().settings)` returns `false`.

- [ ] **Step 3: Update `frontend/src/features/admin-config/testing/fixtures.ts`**

Import `DEFAULT_COMPACTION_SETTINGS` from `'../../../api/admin-config-protocol.ts'` and add `compaction: { ...DEFAULT_COMPACTION_SETTINGS }` inside `settings` right after `chat`:

```ts
import {
  DEFAULT_COMPACTION_SETTINGS,
  type AdminConfigError,
  type AdminConfigErrorCode,
  type ManageableSettings,
  type PublicAdminConfig,
} from '../../../api/admin-config-protocol.ts';
```

In `const settings: ManageableSettings`:

```ts
  chat: {
    maxInputChars: 32000, maxInputTokens: 8000, maxMessagesInContext: 100,
    maxContextTokens: 32000, maxHistoryTokens: 10000, maxOutputTokens: 2000,
    modelMarginTokens: 512,
    titleMaxChars: 80, maxConcurrentGenerationsPerProcess: 2,
    maxRequestsPerMinutePerUser: 30, retryMaxAttempts: 3,
    retryBaseDelayMs: 250, retryMaxDelayMs: 1000, firstOutputTimeoutMs: 10000,
    idleStreamTimeoutMs: 10000, totalRunTimeoutMs: 30000,
  },
  compaction: { ...DEFAULT_COMPACTION_SETTINGS },
  webSearch: { ...DEFAULT_WEB_SEARCH_LIMITS },
```

- [ ] **Step 4: Update `frontend/src/features/admin-config/config-edit-state.ts`**

1. Extend `AdminSection` and `FieldKind` (lines 35–42):

```ts
export type AdminSection = 'openrouter' | 'chat' | 'compaction' | 'voice' | 'deepgram' | 'webSearch';
export type AdminTab = 'personalization' | 'config' | 'plugins' | 'analytics' | 'administration';
export type MutationScope = 'settings' | CredentialProvider;
export type FieldValues = Partial<Record<AdminConfigFieldPath, string | boolean>>;
export type FieldKind =
  | 'text' | 'nullable-text' | 'integer' | 'decimal' | 'nullable-integer' | 'nullable-decimal'
  | 'boolean' | 'select' | 'keyterms';
```

2. Add the 4 `compaction.*` field definitions to `editableFields` (right after `chat.totalRunTimeoutMs` at line 120):

```ts
  { path: 'compaction.enabled', section: 'compaction', group: 'Context compaction',
    label: 'Enable compaction',
    help: 'Automatically fold stale tool outputs and compact earlier turns at the watermark while preserving full visible history.',
    kind: 'boolean' },
  { path: 'compaction.watermarkRatio', section: 'compaction', group: 'Context compaction',
    label: 'Watermark ratio',
    help: 'History utilization ratio (0.50–0.90) that triggers background compaction. Default: 0.8.',
    kind: 'decimal', min: 0.5, max: 0.9, step: 0.05 },
  { path: 'compaction.modelMode', section: 'compaction', group: 'Context compaction',
    label: 'Compaction model mode',
    help: 'Active fork reuses the chat model and prompt cache; Custom selects a separate OpenRouter model.',
    kind: 'select', choices: ['active-fork', 'custom'] },
  { path: 'compaction.customModelId', section: 'compaction', group: 'Context compaction',
    label: 'Compaction model',
    help: 'OpenRouter model ID used when Compaction model mode is Custom.',
    kind: 'nullable-text', max: 200 },
```

3. Support `'nullable-text'` in `convertField` (lines 322–326):

```ts
  if (field.kind === 'text') {
    if (raw.length > (field.max ?? 200) || raw.trim() !== raw) return { error: fieldError(field.path, 'invalid') };
    return { value: raw };
  }
  if (field.kind === 'nullable-text') {
    if (raw === '') return { value: null };
    if (raw.length > (field.max ?? 200) || raw.trim() !== raw || /[\u0000-\u001F\u007F]/.test(raw)) {
      return { error: fieldError(field.path, 'invalid') };
    }
    return { value: raw };
  }
```

4. Add cross-field check in `crossFieldErrors` (before `return errors;` at line 430):

```ts
  if (settings.compaction.modelMode === 'custom' && settings.compaction.customModelId === null) {
    errors.push(fieldError('compaction.customModelId', 'required'));
  }
```

5. In `editReducer` `case 'edit'` (after the `openRouter.modelId` reset at line 587):

```ts
      if (action.path === 'compaction.modelMode' && action.value === 'active-fork') {
        fields['compaction.customModelId'] = '';
      }
```

- [ ] **Step 5: Run TypeScript build and admin-config tests to verify they pass**

Run from `frontend/`:
```bash
npm run build && npx vitest run src/features/admin-config/config-edit-state.test.ts src/features/admin-config/admin-config-client.test.ts src/features/admin-config/integration-tests/config-flow.test.ts
```
Expected: `tsc -b && vite build` exits 0 and all 3 Vitest files PASS (including `catalogCoverage`).

- [ ] **Step 6: Commit message suggestion (orchestrator-serialized)**

```text
Stage:
  frontend/src/features/admin-config/testing/fixtures.ts
  frontend/src/features/admin-config/config-edit-state.ts
  frontend/src/features/admin-config/config-edit-state.test.ts
Message:
  feat(admin-config): add compaction settings fixture and field catalog coverage
```

---

### Task 2: Admin Config Compaction UI (`ModelCombobox` Reuse, `ConfigFields`, `AdminDashboard`)

**Files:**
- Modify: `frontend/src/features/admin-config/ModelSelectionFields.tsx:69-82`
- Modify: `frontend/src/features/admin-config/ConfigFields.tsx:20-185`
- Modify: `frontend/src/features/admin-config/AdminDashboard.tsx:100-107,748-755`
- Test: `frontend/src/features/admin-config/admin-dashboard.test.ts`

- [ ] **Step 1: Write the failing tests in `frontend/src/features/admin-config/admin-dashboard.test.ts`**

Add the following tests at the end of `frontend/src/features/admin-config/admin-dashboard.test.ts`:

```ts
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
```

- [ ] **Step 2: Run targeted test to verify failure**

Run from `frontend/`:
```bash
npx vitest run src/features/admin-config/admin-dashboard.test.ts
```
Expected: FAIL — `ConfigFields` renders a plain `<input type="text">` instead of `role="combobox"`, does not hide `compaction.customModelId` under `active-fork`, and `AdminDashboard` does not list `Compaction` in `Settings sections`.

- [ ] **Step 3: Export `ModelCombobox` from `frontend/src/features/admin-config/ModelSelectionFields.tsx`**

Update lines 69–82 of `frontend/src/features/admin-config/ModelSelectionFields.tsx`:

```ts
export type ModelComboboxProps = {
  id: string;
  models: ModelCatalogueItem[];
  modelId: string;
  selectedModel: ModelCatalogueItem | undefined;
  loading: boolean;
  disabled: boolean;
  invalid: boolean;
  describedBy: string;
  onSelect: (modelId: string) => void;
};

export function ModelCombobox({
```

- [ ] **Step 4: Reuse `ModelCombobox` and add `compaction` presentation in `frontend/src/features/admin-config/ConfigFields.tsx`**

Update `frontend/src/features/admin-config/ConfigFields.tsx`:

```tsx
import type {
  AdminConfigError, AdminConfigFieldPath, ChatFloor, ModelCatalogueItem,
} from '../../api/admin-config-protocol.ts';
import { AdminSelect } from './AdminSelect.tsx';
import { ModelCombobox } from './ModelSelectionFields.tsx';
import {
  editableFields,
  type AdminSection,
  type EditableField,
  type FieldValues,
} from './config-edit-state.ts';

export type ConfigFieldsProps = {
  section: AdminSection;
  fields: FieldValues;
  errors: AdminConfigError['error']['fieldErrors'];
  disabled: boolean;
  floor?: ChatFloor;
  models?: ModelCatalogueItem[];
  modelsLoading?: boolean;
  modelsError?: string | null;
  onRetryModels?: () => void;
  onChange: (path: AdminConfigFieldPath, value: string | boolean) => void;
};
```

In `FieldControl`:
- Accept optional `models`, `modelsLoading`, `modelsError`, `onRetryModels`.
- For `field.path === 'compaction.customModelId'`: render `<ModelCombobox ... />` and optional catalogue error retry button when `modelsError && onRetryModels`.
- For `field.kind === 'select'`: format `'active-fork'` -> `'Active model fork (cache-aligned)'` and `'custom'` -> `'Custom model'`.

```tsx
function FieldControl({
  field, value, errors, disabled, models = [], modelsLoading = false, modelsError = null, onRetryModels, onChange,
}: {
  field: EditableField;
  value: string | boolean | undefined;
  errors: ConfigFieldsProps['errors'];
  disabled: boolean;
  models?: ModelCatalogueItem[];
  modelsLoading?: boolean;
  modelsError?: string | null;
  onRetryModels?: () => void;
  onChange: ConfigFieldsProps['onChange'];
}) {
  const id = fieldDomId(field.path);
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const fieldErrors = errorsFor(field.path, errors);
  const invalid = fieldErrors.length > 0;
  const describedBy = invalid ? `${helpId} ${errorId}` : helpId;
  const raw = value ?? (field.kind === 'boolean' ? false : '');
  const modelValue = typeof raw === 'string' ? raw : '';
  const selectedModel = field.path === 'compaction.customModelId'
    ? models.find((item) => item.id === modelValue)
    : undefined;

  return (
    <div className="aurvin-admin-field">
      {field.kind === 'boolean' ? (
        <label className="aurvin-admin-check" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={raw === true}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(field.path, event.target.checked)}
          />
          <span>{field.label}</span>
        </label>
      ) : (
        <>
          <label htmlFor={id}>
            {field.label}
            {field.unit ? <span className="aurvin-admin-unit"> ({field.unit})</span> : null}
          </label>
          {field.path === 'compaction.customModelId' ? (
            <ModelCombobox
              id={id}
              models={models}
              modelId={modelValue}
              selectedModel={selectedModel}
              loading={modelsLoading}
              disabled={disabled}
              invalid={invalid}
              describedBy={describedBy}
              onSelect={(nextId) => onChange(field.path, nextId)}
            />
          ) : field.kind === 'select' ? (
            <AdminSelect
              id={id}
              value={typeof raw === 'string' ? raw : ''}
              disabled={disabled}
              invalid={invalid}
              describedBy={describedBy}
              options={(field.choices ?? []).map((choice) => ({
                value: choice,
                label: choice === 'us'
                  ? 'US'
                  : choice === 'eu'
                    ? 'EU'
                    : choice === 'active-fork'
                      ? 'Active model fork (cache-aligned)'
                      : choice === 'custom'
                        ? 'Custom model'
                        : choice,
              }))}
              onChange={(nextValue) => onChange(field.path, nextValue)}
            />
          ) : field.kind === 'keyterms' ? (
            <textarea
              id={id}
              value={typeof raw === 'string' ? raw : ''}
              disabled={disabled}
              rows={6}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => onChange(field.path, event.target.value)}
            />
          ) : (
            <input
              id={id}
              type={field.kind === 'text' || field.kind === 'nullable-text' ? 'text' : 'number'}
              value={typeof raw === 'string' ? raw : ''}
              disabled={disabled}
              min={field.min}
              max={field.max}
              step={field.kind === 'text' || field.kind === 'nullable-text' ? undefined : field.step ?? (field.kind.includes('decimal') ? 'any' : 1)}
              maxLength={field.kind === 'text' || field.kind === 'nullable-text' ? field.max : undefined}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => onChange(field.path, event.target.value)}
            />
          )}
        </>
      )}
      <p id={helpId} className="aurvin-admin-help">{field.help}</p>
      {field.path === 'compaction.customModelId' && modelsError && onRetryModels ? (
        <div className="aurvin-admin-alert" role="alert">
          <span>{modelsError}</span>
          <button type="button" onClick={onRetryModels} disabled={modelsLoading}>
            Retry catalogue
          </button>
        </div>
      ) : null}
      {invalid ? (
        <p id={errorId} className="aurvin-admin-field-error">
          {fieldErrors.map((error) => error.code).join(', ')}
        </p>
      ) : null}
    </div>
  );
}
```

And inside `ConfigFields`:

```tsx
export function ConfigFields({
  section, fields, errors, disabled, floor, models, modelsLoading, modelsError, onRetryModels, onChange,
}: ConfigFieldsProps) {
  const showCustomCompactionModel = fields['compaction.modelMode'] === 'custom';
  const sectionFields = editableFields.filter((field) =>
    field.section === section &&
    field.path !== 'openRouter.modelId' &&
    field.path !== 'openRouter.reasoningEffort' &&
    (field.path !== 'compaction.customModelId' || showCustomCompactionModel));
```

And pass `models={models}`, `modelsLoading={modelsLoading}`, `modelsError={modelsError}`, `onRetryModels={onRetryModels}` to `<FieldControl ... />`.

- [ ] **Step 5: Wire `compaction` section and catalogue props in `frontend/src/features/admin-config/AdminDashboard.tsx`**

Update `CONFIG_SECTIONS` (lines 100–106):

```ts
const CONFIG_SECTIONS: { id: AdminSection; label: string }[] = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'chat', label: 'Chat limits' },
  { id: 'compaction', label: 'Compaction' },
  { id: 'voice', label: 'Voice' },
  { id: 'deepgram', label: 'Deepgram' },
  { id: 'webSearch', label: 'Web Search' },
];
```

Pass model catalogue props to `<ConfigFields ... />` (lines 748–755):

```tsx
                      <ConfigFields
                        section={section}
                        fields={edit.fields}
                        errors={errors}
                        disabled={editingLocked}
                        floor={edit.baseline.chatFloor}
                        models={models}
                        modelsLoading={modelsLoading}
                        modelsError={modelsError}
                        onRetryModels={loadModels}
                        onChange={handleFieldChange}
                      />
```

- [ ] **Step 6: Run admin-config tests and build**

Run from `frontend/`:
```bash
npm run build && npx vitest run src/features/admin-config/admin-dashboard.test.ts src/features/admin-config/config-edit-state.test.ts src/features/admin-config/role-aware-dashboard.test.ts
```
Expected: PASS across all tests and clean `npm run build`.

- [ ] **Step 7: Commit message suggestion (orchestrator-serialized)**

```text
Stage:
  frontend/src/features/admin-config/ModelSelectionFields.tsx
  frontend/src/features/admin-config/ConfigFields.tsx
  frontend/src/features/admin-config/AdminDashboard.tsx
  frontend/src/features/admin-config/admin-dashboard.test.ts
Message:
  feat(admin-config): expose compaction settings section and custom model combobox
```

---

### Task 3: Frontend Wire Protocol & Client Support (`CompactionCheckpointMeta`, `ContextUsageMeta`, `context-state`)

**Files:**
- Modify: `frontend/src/api/protocol.ts:165-214,489-553`
- Modify: `frontend/src/api/client.ts:27-40,290-302`
- Test: `frontend/src/api/protocol.test.ts`
- Test: `frontend/src/api/client.test.ts`

- [ ] **Step 1: Write the failing tests in `frontend/src/api/protocol.test.ts` and `frontend/src/api/client.test.ts`**

Append to `frontend/src/api/protocol.test.ts` (importing `isCompactionCheckpointMeta`, `isContextUsageMeta` from `./protocol.ts`):

```ts
  it('validates compaction checkpoint and context usage metadata and context-state SSE events', () => {
    const compaction = {
      compactedThroughSequence: 12,
      compactionCycle: 1,
      summaryPreview: 'Discussed project milestones and scheduled follow-ups.',
    };
    const contextUsage = {
      historyTokens: 8200,
      maxHistoryTokens: 10000,
      utilizationPercent: 82,
      status: 'compacting' as const,
    };

    expect(isCompactionCheckpointMeta(compaction)).toBe(true);
    expect(isCompactionCheckpointMeta({ compactedThroughSequence: 0, compactionCycle: 2 })).toBe(true);
    expect(isCompactionCheckpointMeta({ ...compaction, compactionCycle: 0 })).toBe(false);
    expect(isCompactionCheckpointMeta({ ...compaction, compactedThroughSequence: -1 })).toBe(false);
    expect(isCompactionCheckpointMeta({ ...compaction, summaryPreview: '<analysis>leak</analysis>' })).toBe(false);
    expect(isCompactionCheckpointMeta({ ...compaction, summaryPreview: '<calendar_context>secret</calendar_context>' })).toBe(false);
    expect(isCompactionCheckpointMeta({ ...compaction, summaryPreview: 'x'.repeat(501) })).toBe(false);
    expect(isCompactionCheckpointMeta({ ...compaction, extra: true })).toBe(false);

    expect(isContextUsageMeta(contextUsage)).toBe(true);
    expect(isContextUsageMeta({ ...contextUsage, status: 'idle', utilizationPercent: 0 })).toBe(true);
    expect(isContextUsageMeta({ ...contextUsage, maxHistoryTokens: 0 })).toBe(false);
    expect(isContextUsageMeta({ ...contextUsage, utilizationPercent: -1 })).toBe(false);
    expect(isContextUsageMeta({ ...contextUsage, utilizationPercent: Number.NaN })).toBe(false);
    expect(isContextUsageMeta({ ...contextUsage, status: 'error' })).toBe(false);

    expect(isStreamEvent({ type: 'context-state', contextUsage })).toBe(true);
    expect(isStreamEvent({ type: 'context-state', compaction, contextUsage })).toBe(true);
    expect(isStreamEvent({ type: 'context-state', compaction })).toBe(false);
    expect(
      isStreamEvent({
        type: 'completed',
        assistantMessageId: 'm_compacted',
        outcome: 'completed',
        compaction,
        contextUsage: { ...contextUsage, status: 'idle', utilizationPercent: 24 },
      }),
    ).toBe(true);

    const frame = `data: ${JSON.stringify({
      protocolVersion: 1,
      sessionId: 'sess_1',
      turnId: 'turn_1',
      attemptId: 'att_1',
      sequence: 2,
      event: { type: 'context-state', compaction, contextUsage },
    })}\n\n`;
    expect(parseSseDataLine(frame).event).toEqual({
      type: 'context-state',
      compaction,
      contextUsage,
    });
  });
```

Append to `frontend/src/api/client.test.ts`:

```ts
  it('validates compaction and contextUsage on listMessages and rejects leaking summaryPreview', async () => {
    const valid = {
      items: [],
      nextCursor: null,
      olderAvailable: true,
      compaction: {
        compactedThroughSequence: 10,
        compactionCycle: 1,
        summaryPreview: 'Settled timeline.',
      },
      contextUsage: {
        historyTokens: 3200,
        maxHistoryTokens: 10000,
        utilizationPercent: 32,
        status: 'idle',
      },
    };
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(valid), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...valid,
            compaction: { ...valid.compaction, summaryPreview: '<analysis>hidden</analysis>' },
          }),
          { status: 200 },
        ),
      );

    const client = new ApiClient({ baseUrl: '/api', fetch: mockFetch });
    await expect(client.listMessages('sess_1')).resolves.toEqual(valid);
    await expect(client.listMessages('sess_1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
```

And in `describe('ApiClient SSE Stream Consumer', ...)` in `frontend/src/api/client.test.ts`:

```ts
  it('parses context-state and completed compaction/contextUsage SSE frames', async () => {
    const ssePayload = [
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":1,"event":{"type":"context-state","contextUsage":{"historyTokens":8400,"maxHistoryTokens":10000,"utilizationPercent":84,"status":"compacting"}}}\n\n',
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":2,"event":{"type":"completed","assistantMessageId":"msg_ast_1","outcome":"completed","compaction":{"compactedThroughSequence":8,"compactionCycle":1,"summaryPreview":"Agreed on Q4 roadmap."},"contextUsage":{"historyTokens":2900,"maxHistoryTokens":10000,"utilizationPercent":29,"status":"idle"}}}\n\n',
    ];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: makeReadableStream(ssePayload),
    });

    const client = new ApiClient({ baseUrl: '/api', fetch: mockFetch });
    const events: string[] = [];
    await client.connectTurnStream('/sessions/sess_1/turns/turn_1/stream', {
      onEvent: (event) => events.push(event.type),
    });
    expect(events).toEqual(['context-state', 'completed']);
  });
```

- [ ] **Step 2: Run targeted tests to verify failure**

Run from `frontend/`:
```bash
npx vitest run src/api/protocol.test.ts src/api/client.test.ts
```
Expected: FAIL — `isCompactionCheckpointMeta` / `isContextUsageMeta` not exported, `context-state` rejected by `isStreamEvent`.

- [ ] **Step 3: Update `frontend/src/api/protocol.ts`**

1. Add `CompactionCheckpointMeta` and `ContextUsageMeta` types near `ListMessagesResponse` (lines 165–173):

```ts
export type CompactionCheckpointMeta = {
  compactedThroughSequence: number
  compactionCycle: number
  summaryPreview?: string
}

export type ContextUsageMeta = {
  historyTokens: number
  maxHistoryTokens: number
  utilizationPercent: number
  status: 'idle' | 'compacting'
}

export type ListMessagesResponse = {
  items: VisibleMessage[]
  nextCursor: string | null
  olderAvailable: boolean
  save?: SaveStateSnapshot
  saveTurnId?: string
  activeTurn?: ActiveSessionTurn
  compaction?: CompactionCheckpointMeta
  contextUsage?: ContextUsageMeta
}
```

2. Update `StreamEvent` (lines 204–214):

```ts
  | {
      type: 'completed'
      assistantMessageId: string
      outcome: 'completed' | 'truncated'
      save?: SaveStateSnapshot
      calendarView?: CalendarView
      webSources?: WebSourceReference[]
      webActivities?: WebSearchActivity[]
      compaction?: CompactionCheckpointMeta
      contextUsage?: ContextUsageMeta
    }
  | {
      type: 'context-state'
      compaction?: CompactionCheckpointMeta
      contextUsage: ContextUsageMeta
    }
  | { type: 'web-activity'; activity: WebSearchActivity }
  | { type: 'web-sources'; sources: WebSourceReference[] }
```

3. Export runtime guards `isCompactionCheckpointMeta` and `isContextUsageMeta` right after `isSaveStateSnapshot` (line 348):

```ts
const DISALLOWED_PREVIEW_TAGS = /<\/?(?:analysis|calendar_context)\b/i

export function isCompactionCheckpointMeta(value: unknown): value is CompactionCheckpointMeta {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'compactedThroughSequence',
      'compactionCycle',
      ...('summaryPreview' in value ? ['summaryPreview'] : []),
    ]) &&
    typeof value.compactedThroughSequence === 'number' &&
    Number.isSafeInteger(value.compactedThroughSequence) &&
    value.compactedThroughSequence >= 0 &&
    typeof value.compactionCycle === 'number' &&
    Number.isSafeInteger(value.compactionCycle) &&
    value.compactionCycle > 0 &&
    (!('summaryPreview' in value) ||
      (typeof value.summaryPreview === 'string' &&
        value.summaryPreview.length <= 500 &&
        !DISALLOWED_PREVIEW_TAGS.test(value.summaryPreview)))
  )
}

export function isContextUsageMeta(value: unknown): value is ContextUsageMeta {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['historyTokens', 'maxHistoryTokens', 'utilizationPercent', 'status']) &&
    typeof value.historyTokens === 'number' &&
    Number.isSafeInteger(value.historyTokens) &&
    value.historyTokens >= 0 &&
    typeof value.maxHistoryTokens === 'number' &&
    Number.isSafeInteger(value.maxHistoryTokens) &&
    value.maxHistoryTokens > 0 &&
    typeof value.utilizationPercent === 'number' &&
    Number.isFinite(value.utilizationPercent) &&
    value.utilizationPercent >= 0 &&
    (value.status === 'idle' || value.status === 'compacting')
  )
}
```

4. Update `isStreamEvent` cases `'completed'` and `'context-state'` (lines 533–546):

```ts
    case 'completed':
      return (
        hasExactKeys(value, [
          'type',
          'assistantMessageId',
          'outcome',
          ...('save' in value ? ['save'] : []),
          ...('calendarView' in value ? ['calendarView'] : []),
          ...('webSources' in value ? ['webSources'] : []),
          ...('webActivities' in value ? ['webActivities'] : []),
          ...('compaction' in value ? ['compaction'] : []),
          ...('contextUsage' in value ? ['contextUsage'] : []),
        ]) &&
        (!('save' in value) || isSaveStateSnapshot(value.save)) &&
        (!('calendarView' in value) || isCalendarView(value.calendarView)) &&
        (!('webSources' in value) || isWebSourceReferenceList(value.webSources)) &&
        (!('webActivities' in value) || isWebSearchActivityList(value.webActivities)) &&
        (!('compaction' in value) || isCompactionCheckpointMeta(value.compaction)) &&
        (!('contextUsage' in value) || isContextUsageMeta(value.contextUsage)) &&
        isBoundedId(value.assistantMessageId) &&
        (value.outcome === 'completed' || value.outcome === 'truncated')
      )
    case 'context-state':
      return (
        hasExactKeys(value, [
          'type',
          ...('compaction' in value ? ['compaction'] : []),
          'contextUsage',
        ]) &&
        (!('compaction' in value) || isCompactionCheckpointMeta(value.compaction)) &&
        isContextUsageMeta(value.contextUsage)
      )
```

- [ ] **Step 4: Validate optional context metadata in `frontend/src/api/client.ts`**

Import `isCompactionCheckpointMeta` and `isContextUsageMeta` from `./protocol.ts` and update `listMessages` (lines 290–302):

```ts
  async listMessages(
    sessionId: string,
    options?: { cursor?: string | null; limit?: number },
  ): Promise<ListMessagesResponse> {
    const res = await this.request<ListMessagesResponse>(
      API_ROUTES.messages(sessionId),
      { method: 'GET' },
      {
        cursor: options?.cursor,
        limit: options?.limit,
      },
    );
    if (
      ('compaction' in res && res.compaction !== undefined && !isCompactionCheckpointMeta(res.compaction)) ||
      ('contextUsage' in res && res.contextUsage !== undefined && !isContextUsageMeta(res.contextUsage))
    ) {
      throw new ApiClientError('INVALID_RESPONSE', 'Invalid context metadata received.', 200, false);
    }
    return res;
  }
```

- [ ] **Step 5: Run protocol and client tests**

Run from `frontend/`:
```bash
npm run build && npx vitest run src/api/protocol.test.ts src/api/client.test.ts src/api/calendar-protocol.test.ts
```
Expected: PASS across all tests and clean build.

- [ ] **Step 6: Commit message suggestion (orchestrator-serialized)**

```text
Stage:
  frontend/src/api/protocol.ts
  frontend/src/api/client.ts
  frontend/src/api/protocol.test.ts
  frontend/src/api/client.test.ts
Message:
  feat(api): add compaction checkpoint and context-state protocol support
```

---

### Task 4: Chat State, Reducer & Orchestration (`chat-types.ts`, `chat-reducer.ts`, `use-chat.ts`)

**Files:**
- Modify: `frontend/src/features/chat/state/chat-types.ts:26-96,125-236`
- Modify: `frontend/src/features/chat/state/chat-reducer.ts:21-82,125-151,209-243,383-572,732-782`
- Modify: `frontend/src/features/chat/state/use-chat.ts:43-195,252-275,331-442,474-510,658-688`
- Create: `frontend/src/features/chat/state/compaction-chat-state.test.ts`

**Critical design catches addressed here:**
1. **Cold-loaded tail optimistic sequence:** When `listMessages` hydrates only the uncompacted tail (e.g., sequences `101..120` with `compactedThroughSequence = 100`), `state.messages.length + 1` would assign `21` (`<= 100`), misplacing the checkpoint divider behind brand-new messages. Export and use `nextMessageSequence(messages, compaction)` (`Math.max(0, compaction?.compactedThroughSequence ?? 0, ...messages.map(m => m.sequence)) + 1`) across `TURN_SUBMIT_START`, `STREAM_COMPLETED`, `appendTerminalAssistant`, and `VOICE_SESSION_COMMITTED` (and in `Transcript.tsx` for `streaming_in_flight`).
2. **Older message scrollback deduplication/ordering:** In `OLDER_MESSAGES_LOADED`, merge `action.payload.items` and `state.messages` by `messageId` sorted ascending by `sequence` so paging older turns onto an active tail never duplicates or misorders rows.
3. **Zero delta-coalescer flushing on `context-state`:** Handle `event.type === 'context-state'` before the `else { coalescer.flush(); ... }` branch in `dispatchStreamEvent` (matching `web-activity`, `web-sources`, `calendar-view`).
4. **Idle compaction completion polling:** Add bounded `startCompactionPollEffect` (paralleling `startSavePollEffect`, 1.5s interval, max 10 polls) that only runs when `!isStreaming && !voiceLocked && !savePending && contextUsage?.status === 'compacting'` so `"Compacting context…"` drops cleanly as soon as async post-turn compaction promotes—without polling during streaming, save polling, or Live Voice.

- [ ] **Step 1: Create `frontend/src/features/chat/state/compaction-chat-state.test.ts` (failing tests first)**

Create `frontend/src/features/chat/state/compaction-chat-state.test.ts` with the mandatory file header:

```ts
/**
 * ============================================================================
 * FILE: compaction-chat-state.test.ts
 * LOCATION: frontend/src/features/chat/state/compaction-chat-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify compaction checkpoint and context usage state transitions, sequence
 *    monotonicity, SSE handling, and bounded idle compaction polling.
 *
 * ROLE IN PROJECT:
 *    Locks P4 chat reducer and orchestration behavior for cold-loaded compacted
 *    tails, stream updates, session switching, and Live Voice silence.
 *
 * KEY COMPONENTS:
 *    - chatReducer compaction/contextUsage transitions and sequence ordering
 *    - startCompactionPollEffect bounded polling and Live Voice suppression
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../../api/client.ts';
import type { VisibleMessage } from '../../../api/protocol.ts';
import { chatReducer, initialChatState } from './chat-reducer.ts';
import type { ChatAction, ChatState } from './chat-types.ts';
import { startCompactionPollEffect, useChatActions } from './use-chat.ts';

function msg(sequence: number, role: 'user' | 'assistant' = 'user'): VisibleMessage {
  return {
    messageId: `m_${sequence}`,
    turnId: `t_${Math.ceil(sequence / 2)}`,
    eventId: `e_${sequence}`,
    sequence,
    role,
    content: `Message ${sequence}`,
    createdAt: '2026-11-17T12:00:00.000Z',
    completionStatus: 'completed',
    truncated: false,
  };
}

describe('compaction and context usage chat state', () => {
  it('hydrates compaction and contextUsage on MESSAGES_LOADED and resets on NEW_CHAT / SELECT_SESSION', () => {
    const compaction = { compactedThroughSequence: 100, compactionCycle: 2, summaryPreview: 'Phase 1 goals settled.' };
    const contextUsage = { historyTokens: 4200, maxHistoryTokens: 10000, utilizationPercent: 42, status: 'idle' as const };

    let state = chatReducer(initialChatState, {
      type: 'SELECT_SESSION',
      payload: { sessionId: 'sess_1', title: 'Long session' },
    });
    state = chatReducer(state, {
      type: 'MESSAGES_LOADED',
      payload: {
        sessionId: 'sess_1',
        items: [msg(101, 'user'), msg(102, 'assistant')],
        nextCursor: '101',
        olderAvailable: true,
        compaction,
        contextUsage,
      },
    });
    expect(state.compaction).toEqual(compaction);
    expect(state.contextUsage).toEqual(contextUsage);

    const switched = chatReducer(state, {
      type: 'SELECT_SESSION',
      payload: { sessionId: 'sess_2', title: 'Fresh session' },
    });
    expect(switched.compaction).toBeNull();
    expect(switched.contextUsage).toBeNull();

    const cleared = chatReducer(state, { type: 'NEW_CHAT' });
    expect(cleared.compaction).toBeNull();
    expect(cleared.contextUsage).toBeNull();
  });

  it('assigns optimistic sequences past compacted cold-loaded tails and rejects stale cycles', () => {
    let state: ChatState = {
      ...initialChatState,
      activeSessionId: 'sess_1',
      messages: [msg(101, 'user'), msg(102, 'assistant')],
      compaction: { compactedThroughSequence: 100, compactionCycle: 2, summaryPreview: 'Cycle 2' },
      contextUsage: { historyTokens: 8200, maxHistoryTokens: 10000, utilizationPercent: 82, status: 'compacting' },
    };

    state = chatReducer(state, {
      type: 'TURN_SUBMIT_START',
      payload: { userContent: 'Next question', idempotencyKey: 'key_next_1' },
    });
    expect(state.messages.at(-1)?.sequence).toBe(103);

    state = chatReducer(state, {
      type: 'TURN_ACCEPTED',
      payload: { sessionId: 'sess_1', turnId: 't_52', attemptId: 'att_1', userMessageId: 'm_103' },
    });
    state = chatReducer(state, { type: 'STREAM_DELTA', payload: { text: 'Answer' } });
    state = chatReducer(state, {
      type: 'STREAM_COMPLETED',
      payload: {
        assistantMessageId: 'm_104',
        outcome: 'completed',
        compaction: { compactedThroughSequence: 102, compactionCycle: 3, summaryPreview: 'Cycle 3' },
        contextUsage: { historyTokens: 3100, maxHistoryTokens: 10000, utilizationPercent: 31, status: 'idle' },
      },
    });
    expect(state.messages.at(-1)?.sequence).toBe(104);
    expect(state.compaction?.compactionCycle).toBe(3);
    expect(state.contextUsage?.utilizationPercent).toBe(31);

    // Older compaction cycle or other-session CONTEXT_STATE is ignored
    const afterStale = chatReducer(state, {
      type: 'CONTEXT_STATE',
      payload: {
        sessionId: 'sess_1',
        compaction: { compactedThroughSequence: 80, compactionCycle: 1, summaryPreview: 'Stale' },
      },
    });
    expect(afterStale.compaction?.compactionCycle).toBe(3);

    const afterOtherSession = chatReducer(state, {
      type: 'CONTEXT_STATE',
      payload: {
        sessionId: 'other_sess',
        contextUsage: { historyTokens: 9900, maxHistoryTokens: 10000, utilizationPercent: 99, status: 'compacting' },
      },
    });
    expect(afterOtherSession).toBe(state);
  });

  it('merges older paged messages in sequence order without duplicates', () => {
    const state: ChatState = {
      ...initialChatState,
      activeSessionId: 'sess_1',
      messages: [msg(3, 'user'), msg(4, 'assistant')],
      messagesCursor: '3',
      olderAvailable: true,
    };
    const next = chatReducer(state, {
      type: 'OLDER_MESSAGES_LOADED',
      payload: {
        items: [msg(1, 'user'), msg(2, 'assistant'), msg(3, 'user')],
        nextCursor: null,
        olderAvailable: false,
      },
    });
    expect(next.messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4]);
    expect(next.olderAvailable).toBe(false);
  });

  it('handles SSE context-state without prematurely flushing coalesced deltas', async () => {
    const ssePayload = [
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":1,"event":{"type":"turn-accepted","userMessageId":"m_1"}}\n\n',
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":2,"event":{"type":"delta","text":"Hel"}}\n\n',
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":3,"event":{"type":"context-state","contextUsage":{"historyTokens":8200,"maxHistoryTokens":10000,"utilizationPercent":82,"status":"compacting"}}}\n\n',
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":4,"event":{"type":"delta","text":"lo"}}\n\n',
      'data: {"protocolVersion":1,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":5,"event":{"type":"completed","assistantMessageId":"m_2","outcome":"completed","compaction":{"compactedThroughSequence":2,"compactionCycle":1,"summaryPreview":"Greeted user."},"contextUsage":{"historyTokens":2400,"maxHistoryTokens":10000,"utilizationPercent":24,"status":"idle"}}}\n\n',
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const chunk of ssePayload) ctrl.enqueue(encoder.encode(chunk));
        ctrl.close();
      },
    });
    const fetchSpy = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          sessionId: 'sess_1',
          turnId: 'turn_1',
          attemptId: 'att_1',
          userMessageId: 'm_1',
          streamPath: '/sessions/sess_1/turns/turn_1/stream',
        }),
      )
      .mockResolvedValueOnce(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }));

    const client = new ApiClient({ fetch: fetchSpy, recoveryStorage: null });
    let state = initialChatState;
    const actionsLog: ChatAction['type'][] = [];
    const dispatch = (action: ChatAction) => {
      actionsLog.push(action.type);
      state = chatReducer(state, action);
    };
    let actions!: ReturnType<typeof useChatActions>;
    function Harness() {
      actions = useChatActions(state, dispatch, client, undefined, {
        scheduler: {
          schedule: (fn) => { const id = setTimeout(fn, 100); return () => clearTimeout(id); },
        },
      });
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    await actions.submitMessage('Hi');

    expect(actionsLog).toContain('CONTEXT_STATE');
    expect(actionsLog).not.toContain('STREAM_DELTA');
    expect(state.messages.at(-1)?.content).toBe('Hello');
    expect(state.compaction?.compactedThroughSequence).toBe(2);
    expect(state.contextUsage?.status).toBe('idle');
    expect(state.contextUsage?.utilizationPercent).toBe(24);
  });

  it('polls listMessages(limit=1) while compacting when idle and suppresses polling during Live Voice', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
        Response.json({
          items: [],
          nextCursor: null,
          olderAvailable: true,
          compaction: { compactedThroughSequence: 10, compactionCycle: 1, summaryPreview: 'Done.' },
          contextUsage: { historyTokens: 2500, maxHistoryTokens: 10000, utilizationPercent: 25, status: 'idle' },
        }),
      );
      const client = new ApiClient({ fetch: fetcher, recoveryStorage: null });
      let state: ChatState = {
        ...initialChatState,
        activeSessionId: 'sess_1',
        contextUsage: { historyTokens: 8200, maxHistoryTokens: 10000, utilizationPercent: 82, status: 'compacting' },
      };

      expect(
        startCompactionPollEffect({
          client,
          dispatch: () => undefined,
          sessionId: 'sess_1',
          contextUsage: state.contextUsage,
          isStreaming: false,
          voiceLocked: true,
          savePending: false,
        }),
      ).toBeUndefined();

      const cleanup = startCompactionPollEffect({
        client,
        dispatch: (action) => { state = chatReducer(state, action); },
        sessionId: 'sess_1',
        contextUsage: state.contextUsage,
        isStreaming: false,
        voiceLocked: false,
        savePending: false,
      });
      await vi.advanceTimersByTimeAsync(1600);
      cleanup?.();

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0][0])).toContain('/sessions/sess_1/messages?limit=1');
      expect(state.contextUsage?.status).toBe('idle');
      expect(state.compaction?.compactedThroughSequence).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run targeted test to verify failure**

Run from `frontend/`:
```bash
npx vitest run src/features/chat/state/compaction-chat-state.test.ts
```
Expected: FAIL — `compaction`, `contextUsage`, `CONTEXT_STATE`, and `startCompactionPollEffect` do not exist yet.

- [ ] **Step 3: Update `frontend/src/features/chat/state/chat-types.ts`**

1. Import `CompactionCheckpointMeta`, `ContextUsageMeta` from `'../../../api/protocol.ts'`.
2. Add `compaction: CompactionCheckpointMeta | null;` and `contextUsage: ContextUsageMeta | null;` to `ChatState` (right after `loadingOlder` at line 66).
3. Add optional `compaction?: CompactionCheckpointMeta; contextUsage?: ContextUsageMeta;` to `MESSAGES_LOADED.payload` and `STREAM_COMPLETED.payload`, and add the `CONTEXT_STATE` action variant to `ChatAction`:

```ts
  | {
      type: 'CONTEXT_STATE';
      payload: {
        sessionId: string;
        compaction?: CompactionCheckpointMeta;
        contextUsage?: ContextUsageMeta;
      };
    }
```

- [ ] **Step 4: Update `frontend/src/features/chat/state/chat-reducer.ts`**

1. Import `CompactionCheckpointMeta` from `'../../../api/protocol.ts'`.
2. Add `compaction: null, contextUsage: null` to `initialChatState`, `NEW_CHAT`, and `SELECT_SESSION`.
3. Add and export `nextMessageSequence` and `mergeCompaction` helpers:

```ts
export function nextMessageSequence(
  messages: readonly VisibleMessage[],
  compaction: CompactionCheckpointMeta | null | undefined,
): number {
  return (
    messages.reduce(
      (max, item) => Math.max(max, item.sequence),
      compaction?.compactedThroughSequence ?? 0,
    ) + 1
  );
}

function mergeCompaction(
  current: CompactionCheckpointMeta | null,
  incoming: CompactionCheckpointMeta | undefined,
): CompactionCheckpointMeta | null {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming.compactionCycle < current.compactionCycle) return current;
  if (
    incoming.compactionCycle === current.compactionCycle &&
    incoming.compactedThroughSequence < current.compactedThroughSequence
  ) {
    return current;
  }
  return incoming;
}
```

4. Replace all four `state.messages.length + 1` assignments (`appendTerminalAssistant`, `VOICE_SESSION_COMMITTED`, `TURN_SUBMIT_START`, `STREAM_COMPLETED`) with `nextMessageSequence(state.messages, state.compaction)`.
5. Update `MESSAGES_LOADED` (lines 465–475) to merge `compaction: mergeCompaction(state.compaction, action.payload.compaction)` and `contextUsage: action.payload.contextUsage ?? state.contextUsage`.
6. Update `OLDER_MESSAGES_LOADED` (lines 507–514):

```ts
    case 'OLDER_MESSAGES_LOADED': {
      const merged = new Map<string, VisibleMessage>();
      for (const item of action.payload.items) merged.set(item.messageId, item);
      for (const item of state.messages) merged.set(item.messageId, item);
      return {
        ...state,
        loadingOlder: false,
        messages: [...merged.values()].sort((a, b) => a.sequence - b.sequence),
        messagesCursor: action.payload.nextCursor,
        olderAvailable: action.payload.olderAvailable,
      };
    }
```

7. Update `STREAM_COMPLETED` (lines 766–781) to include `compaction: mergeCompaction(state.compaction, action.payload.compaction)` and `contextUsage: action.payload.contextUsage ?? state.contextUsage`.
8. Add `case 'CONTEXT_STATE'` right after `SAVE_STATE`:

```ts
    case 'CONTEXT_STATE':
      if (action.payload.sessionId !== state.activeSessionId) return state;
      return {
        ...state,
        compaction: mergeCompaction(state.compaction, action.payload.compaction),
        contextUsage: action.payload.contextUsage ?? state.contextUsage,
      };
```

- [ ] **Step 5: Update `frontend/src/features/chat/state/use-chat.ts`**

1. In `startSavePollEffect` (around line 85, inside `if (useLiveList)`): when `res.compaction || res.contextUsage` is present, dispatch `CONTEXT_STATE`:

```ts
        if (res.compaction || res.contextUsage) {
          dispatch({
            type: 'CONTEXT_STATE',
            payload: {
              sessionId,
              ...(res.compaction ? { compaction: res.compaction } : {}),
              ...(res.contextUsage ? { contextUsage: res.contextUsage } : {}),
            },
          });
        }
```

2. Export `startCompactionPollEffect` right after `startRestoredBusyPollEffect`:

```ts
export function startCompactionPollEffect(params: {
  client: ApiClient;
  dispatch: Dispatch<ChatAction>;
  sessionId: string | null;
  contextUsage: ChatState['contextUsage'];
  isStreaming: boolean;
  voiceLocked: boolean;
  savePending: boolean;
}): (() => void) | undefined {
  const { client, dispatch, sessionId, contextUsage, isStreaming, voiceLocked, savePending } = params;
  if (!sessionId || isStreaming || voiceLocked || savePending || contextUsage?.status !== 'compacting') {
    return undefined;
  }
  let cancelled = false;
  let count = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    try {
      const res = await client.listMessages(sessionId, { limit: 1 });
      if (cancelled) return;
      if (res.compaction || res.contextUsage) {
        dispatch({
          type: 'CONTEXT_STATE',
          payload: {
            sessionId,
            ...(res.compaction ? { compaction: res.compaction } : {}),
            ...(res.contextUsage ? { contextUsage: res.contextUsage } : {}),
          },
        });
      }
      if (res.contextUsage && res.contextUsage.status !== 'compacting') return;
    } catch {
      /* Transient poll errors preserve current context meter state up to the finite cap. */
    }
    if (!cancelled && ++count < 10) {
      timer = setTimeout(() => {
        void check();
      }, 1500);
    }
  };
  timer = setTimeout(() => {
    void check();
  }, 1500);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
```

3. Call `startCompactionPollEffect` in `useEffect` right after `startRestoredBusyPollEffect` in `useChatActions`:

```ts
  useEffect(() => startCompactionPollEffect({
    client,
    dispatch,
    sessionId: state.activeSessionId,
    contextUsage: state.contextUsage,
    isStreaming: state.isStreaming,
    voiceLocked: state.voiceInput !== null,
    savePending,
  }), [client, dispatch, state.activeSessionId, state.contextUsage, state.isStreaming, state.voiceInput, savePending]);
```

4. In `dispatchStreamEvent`:
   - In `event.type === 'completed'`: include `...(event.compaction ? { compaction: event.compaction } : {})` and `...(event.contextUsage ? { contextUsage: event.contextUsage } : {})`.
   - Before `else { coalescer.flush(); ... }`, handle `event.type === 'context-state'` and `return;`:

```ts
      } else if (event.type === 'context-state') {
        dispatch({
          type: 'CONTEXT_STATE',
          payload: {
            sessionId: envelope.sessionId,
            ...(event.compaction ? { compaction: event.compaction } : {}),
            contextUsage: event.contextUsage,
          },
        });
        return;
```

5. Forward `compaction` and `contextUsage` on every `MESSAGES_LOADED` dispatch (`startRestoredBusyPollEffect` lines 128 and 158, `selectSession` line 488, `reloadMessages` line 667):

```ts
            ...(response.compaction ? { compaction: response.compaction } : {}),
            ...(response.contextUsage ? { contextUsage: response.contextUsage } : {}),
```

(Using `res.compaction` / `res.contextUsage` in `startRestoredBusyPollEffect`.)

- [ ] **Step 6: Run chat state & orchestration tests**

Run from `frontend/`:
```bash
npm run build && npx vitest run src/features/chat/state/compaction-chat-state.test.ts src/features/chat/state/chat-reducer.test.ts src/features/chat/state/memory-save-state.test.ts src/features/chat/state/chat-stream-coalescing.test.ts src/features/chat/chat-acceptance.test.ts src/features/chat/integration-tests/client-lifecycle.test.ts
```
Expected: PASS across all tests and clean build.

- [ ] **Step 7: Commit message suggestion (orchestrator-serialized)**

```text
Stage:
  frontend/src/features/chat/state/chat-types.ts
  frontend/src/features/chat/state/chat-reducer.ts
  frontend/src/features/chat/state/use-chat.ts
  frontend/src/features/chat/state/compaction-chat-state.test.ts
Message:
  feat(chat-state): track compaction checkpoints, context usage, and idle compaction polling
```

---

### Task 5: Transcript Inline Checkpoint Divider & Summary Preview (`Transcript.tsx`, `chat.css`, `Transcript.test.ts`, `styles.test.ts`)

**Files:**
- Modify: `frontend/src/components/Transcript.tsx:22-129`
- Modify: `frontend/src/styles/chat.css` (append checkpoint divider styles)
- Modify: `frontend/src/components/Transcript.test.ts`
- Modify: `frontend/src/styles/styles.test.ts`

- [ ] **Step 1: Write the failing tests in `frontend/src/components/Transcript.test.ts` and `frontend/src/styles/styles.test.ts`**

Update `frontend/src/components/Transcript.test.ts` (preserving existing tests and mocking `useChat` only when rendering `<Transcript />`, using `vi.hoisted`):

```ts
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisibleMessage } from '../api/protocol.ts';
import { initialChatState } from '../features/chat/state/chat-reducer.ts';
import type { ChatState } from '../features/chat/state/chat-types.ts';
import { MessageItem } from './MessageItem.tsx';
import { CompactionDivider, Transcript, findCompactionDividerIndex } from './Transcript.tsx';

const chatContext = vi.hoisted(() => ({
  state: {} as ChatState,
  dispatch: vi.fn(),
  actions: {
    loadOlderMessages: vi.fn(),
    retryTurn: vi.fn(),
  },
}));

vi.mock('../features/chat/state/chat-context.tsx', () => ({
  useChat: () => chatContext,
}));

function makeMsg(sequence: number, role: 'user' | 'assistant'): VisibleMessage {
  return {
    messageId: `msg_${sequence}`,
    turnId: `turn_${Math.ceil(sequence / 2)}`,
    eventId: `evt_${sequence}`,
    sequence,
    role,
    content: `Body ${sequence}`,
    createdAt: '2026-11-17T12:00:00.000Z',
    completionStatus: 'completed',
    truncated: false,
  };
}
```

Add test cases inside `describe('Transcript and MessageItem components', ...)`:

```ts
  beforeEach(() => {
    chatContext.state = { ...initialChatState };
  });

  it('places the checkpoint divider immediately after compactedThroughSequence or above a cold tail', () => {
    const full = [makeMsg(1, 'user'), makeMsg(2, 'assistant'), makeMsg(3, 'user'), makeMsg(4, 'assistant')];
    expect(findCompactionDividerIndex(full, null)).toBeNull();
    expect(findCompactionDividerIndex(full, { compactedThroughSequence: 2, compactionCycle: 1 })).toBe(1);
    expect(findCompactionDividerIndex([makeMsg(3, 'user'), makeMsg(4, 'assistant')], {
      compactedThroughSequence: 2,
      compactionCycle: 1,
    })).toBe(-1);
  });

  it('renders full scrollable history with an inline checkpoint divider and optional summary preview toggle', () => {
    chatContext.state = {
      ...initialChatState,
      activeSessionId: 'sess_1',
      olderAvailable: true,
      messages: [makeMsg(1, 'user'), makeMsg(2, 'assistant'), makeMsg(3, 'user'), makeMsg(4, 'assistant')],
      compaction: {
        compactedThroughSequence: 2,
        compactionCycle: 1,
        summaryPreview: 'User asked about architecture; settled on two-stage pipeline.',
      },
    };
    const html = renderToStaticMarkup(createElement(Transcript));
    expect(html).toContain('Load older messages');
    expect(html).toContain('Body 1');
    expect(html).toContain('Body 2');
    expect(html).toContain('Body 3');
    expect(html).toContain('Body 4');
    const body2Idx = html.indexOf('Body 2');
    const dividerIdx = html.indexOf('Earlier conversation compacted to preserve context');
    const body3Idx = html.indexOf('Body 3');
    expect(dividerIdx).toBeGreaterThan(body2Idx);
    expect(dividerIdx).toBeLessThan(body3Idx);
    expect(html).toContain('View summary');
    expect(html).not.toContain('User asked about architecture; settled on two-stage pipeline.');

    const expandedHtml = renderToStaticMarkup(
      createElement(CompactionDivider, {
        compaction: chatContext.state.compaction!,
        defaultExpanded: true,
      }),
    );
    expect(expandedHtml).toContain('Hide summary');
    expect(expandedHtml).toContain('User asked about architecture; settled on two-stage pipeline.');
  });

  it('renders checkpoint divider before the tail when older compacted messages are not loaded yet', () => {
    chatContext.state = {
      ...initialChatState,
      activeSessionId: 'sess_1',
      olderAvailable: true,
      messages: [makeMsg(11, 'user'), makeMsg(12, 'assistant')],
      compaction: { compactedThroughSequence: 10, compactionCycle: 2 },
    };
    const html = renderToStaticMarkup(createElement(Transcript));
    const dividerIdx = html.indexOf('Earlier conversation compacted to preserve context');
    const body11Idx = html.indexOf('Body 11');
    expect(dividerIdx).toBeGreaterThan(-1);
    expect(dividerIdx).toBeLessThan(body11Idx);
    expect(html).not.toContain('View summary');
  });
```

Append to `frontend/src/styles/styles.test.ts`:

```ts
  it('defines quiet compaction checkpoint divider styles in chat.css', () => {
    const css = readFileSync(new URL('./chat.css', import.meta.url), 'utf-8');
    expect(css).toContain('.aurvin-compaction-divider');
    expect(css).toContain('.aurvin-compaction-pill');
    expect(css).toContain('.aurvin-compaction-toggle');
    expect(css).toContain('.aurvin-compaction-preview');
  });
```

- [ ] **Step 2: Run targeted tests to verify failure**

Run from `frontend/`:
```bash
npx vitest run src/components/Transcript.test.ts src/styles/styles.test.ts
```
Expected: FAIL — `CompactionDivider` and `findCompactionDividerIndex` are not exported, and `chat.css` lacks `.aurvin-compaction-divider`.

- [ ] **Step 3: Implement `CompactionDivider` and placement in `frontend/src/components/Transcript.tsx`**

Update `frontend/src/components/Transcript.tsx`:

```tsx
import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CompactionCheckpointMeta, VisibleMessage } from '../api/protocol.ts';
import { useChat } from '../features/chat/state/chat-context.tsx';
import { nextMessageSequence } from '../features/chat/state/chat-reducer.ts';
import { hideCalendarConfirmReplies } from '../features/plugins/google-calendar/CalendarTurnRegion.tsx';
import { groupVoiceMessages } from './group-voice-messages.ts';
import { MessageItem } from './MessageItem.tsx';
import { PromptTraveler } from './PromptTraveler.tsx';
import { ScrollController } from './ScrollController.tsx';

export function findCompactionDividerIndex(
  messages: readonly VisibleMessage[],
  compaction: CompactionCheckpointMeta | null,
): number | null {
  if (!compaction || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.sequence <= compaction.compactedThroughSequence) {
      return i;
    }
  }
  return -1;
}

export function CompactionDivider({
  compaction,
  defaultExpanded = false,
}: {
  compaction: CompactionCheckpointMeta;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const preview = compaction.summaryPreview?.trim() ?? '';
  const hasPreview = preview.length > 0;

  return (
    <div
      className="aurvin-compaction-divider"
      role="separator"
      aria-label="Earlier conversation compacted"
      data-compaction-cycle={compaction.compactionCycle}
      data-compacted-through={compaction.compactedThroughSequence}
    >
      <div className="aurvin-compaction-divider-row">
        <span className="aurvin-compaction-line" aria-hidden="true" />
        <span className="aurvin-compaction-pill">
          <span>Earlier conversation compacted to preserve context</span>
          {hasPreview ? (
            <button
              type="button"
              className="aurvin-compaction-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? 'Hide summary' : 'View summary'}
            </button>
          ) : null}
        </span>
        <span className="aurvin-compaction-line" aria-hidden="true" />
      </div>
      {hasPreview && expanded ? (
        <p className="aurvin-compaction-preview">{preview}</p>
      ) : null}
    </div>
  );
}
```

Inside `Transcript`:
- Include `state.compaction?.compactedThroughSequence` in `scrollDependencies`.
- Compute `compaction = state.compaction ?? null;` and `dividerAfterIndex = useMemo(() => findCompactionDividerIndex(displayMessages, compaction), [displayMessages, compaction]);`
- Compute `dividerKey = compaction ? `${state.activeSessionId ?? 'none'}:${compaction.compactionCycle}:${compaction.compactedThroughSequence}` : '';`
- Render:

```tsx
        {dividerAfterIndex === -1 && compaction ? (
          <CompactionDivider key={dividerKey} compaction={compaction} />
        ) : null}

        {displayMessages.map((message, index) => (
          <Fragment key={message.messageId}>
            <MessageItem message={message} {...messageActions} />
            {dividerAfterIndex === index && compaction ? (
              <CompactionDivider key={dividerKey} compaction={compaction} />
            ) : null}
          </Fragment>
        ))}
```

- And on the `streaming_in_flight` `MessageItem`, set `sequence: nextMessageSequence(state.messages, compaction)`.

- [ ] **Step 4: Append compaction divider styles to `frontend/src/styles/chat.css`**

Append at the end of `frontend/src/styles/chat.css`:

```css
/* ============================================================================
 * Quiet In-Session Compaction Divider
 * ============================================================================ */

.aurvin-compaction-divider {
  max-width: 768px;
  width: 100%;
  margin: 0 auto;
  padding: 4px 16px;
}

.aurvin-compaction-divider-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.aurvin-compaction-line {
  flex: 1;
  height: 1px;
  background-color: var(--aurvin-border);
}

.aurvin-compaction-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 12px;
  border-radius: 9999px;
  border: 1px solid var(--aurvin-border);
  background-color: var(--aurvin-surface-hover);
  color: var(--aurvin-text-muted);
  font-size: 12px;
  line-height: 1.4;
}

.aurvin-compaction-toggle {
  font-size: 12px;
  font-weight: 500;
  color: var(--aurvin-text);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.aurvin-compaction-preview {
  margin: 8px auto 0;
  padding: 10px 14px;
  max-width: 640px;
  border-radius: 10px;
  border: 1px solid var(--aurvin-border);
  background-color: var(--aurvin-surface);
  color: var(--aurvin-text-muted);
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 5: Run Transcript, PromptTraveler, and stylesheet tests**

Run from `frontend/`:
```bash
npm run build && npx vitest run src/components/Transcript.test.ts src/components/PromptTraveler.test.ts src/styles/styles.test.ts
```
Expected: PASS across all tests and clean build.

- [ ] **Step 6: Commit message suggestion (orchestrator-serialized)**

```text
Stage:
  frontend/src/components/Transcript.tsx
  frontend/src/components/Transcript.test.ts
  frontend/src/styles/chat.css
  frontend/src/styles/styles.test.ts
Message:
  feat(transcript): render quiet inline compaction checkpoint divider with optional summary preview
```

---

### Task 6: Quiet Context Meter in Text Composer & Live-Voice Silence Proof

**Files:**
- Modify: `frontend/src/components/Composer.tsx:22-58,151-161`
- Modify: `frontend/src/styles/chat.css` (append context meter styles)
- Modify: `frontend/src/components/Composer.test.ts`
- Modify: `frontend/src/features/chat/ChatView.voice.test.ts`
- Modify: `frontend/src/styles/styles.test.ts`

- [ ] **Step 1: Write the failing tests in `Composer.test.ts`, `ChatView.voice.test.ts`, and `styles.test.ts`**

Append to `frontend/src/components/Composer.test.ts` (importing `getContextMeterDisplay` from `./Composer.tsx`):

```ts
  it('hides the quiet context meter at or below 50% idle, shows it above 50%, and displays compacting state', () => {
    expect(getContextMeterDisplay(null)).toBeNull();
    expect(
      getContextMeterDisplay({ historyTokens: 5000, maxHistoryTokens: 10000, utilizationPercent: 50, status: 'idle' }),
    ).toBeNull();

    const idleHtml = renderComposer({
      ...initialChatState,
      contextUsage: { historyTokens: 6400, maxHistoryTokens: 10000, utilizationPercent: 64, status: 'idle' },
    });
    expect(idleHtml).toContain('aurvin-context-meter');
    expect(idleHtml).toContain('Context 64%');
    expect(idleHtml).toContain('width:64%');

    const compactingHtml = renderComposer({
      ...initialChatState,
      contextUsage: { historyTokens: 8200, maxHistoryTokens: 10000, utilizationPercent: 82, status: 'compacting' },
    });
    expect(compactingHtml).toContain('data-status="compacting"');
    expect(compactingHtml).toContain('Compacting context…');

    const promotedHtml = renderComposer({
      ...initialChatState,
      contextUsage: { historyTokens: 2800, maxHistoryTokens: 10000, utilizationPercent: 28, status: 'idle' },
    });
    expect(promotedHtml).not.toContain('aurvin-context-meter');

    context.state = {
      ...initialChatState,
      voiceInput: { token: 'live-1', mode: 'live' },
      contextUsage: { historyTokens: 8200, maxHistoryTokens: 10000, utilizationPercent: 82, status: 'compacting' },
    };
    const liveSuppressedHtml = renderToStaticMarkup(createElement(Composer, { variant: 'docked' }));
    expect(liveSuppressedHtml).not.toContain('aurvin-context-meter');
  });
```

Append to `frontend/src/features/chat/ChatView.voice.test.ts`:

```ts
it('keeps Live Voice completely silent about compaction summaries and context usage while restoring them in text mode', () => {
  context.state = {
    ...initialChatState,
    activeSessionId: 'chat-1',
    messages: [
      {
        messageId: 'm1',
        turnId: 't1',
        eventId: 'e1',
        sequence: 1,
        role: 'user',
        content: 'Existing turn',
        createdAt: '2026-10-08T00:00:00Z',
        completionStatus: 'completed',
        truncated: false,
      },
    ],
    compaction: {
      compactedThroughSequence: 1,
      compactionCycle: 1,
      summaryPreview: 'SECRET_COMPACTION_PREVIEW',
    },
    contextUsage: {
      historyTokens: 8200,
      maxHistoryTokens: 10000,
      utilizationPercent: 82,
      status: 'compacting',
    },
  };

  for (const phase of ['requesting_permission', 'connecting', 'active', 'suspended'] as const) {
    const liveHtml = renderToStaticMarkup(createElement(ChatView, { liveVoice: voice(phase) }));
    expect(liveHtml).toContain('Live voice conversation');
    expect(liveHtml).not.toContain('SECRET_COMPACTION_PREVIEW');
    expect(liveHtml).not.toContain('Earlier conversation compacted');
    expect(liveHtml).not.toContain('Compacting context');
    expect(liveHtml).not.toContain('aurvin-compaction-divider');
    expect(liveHtml).not.toContain('aurvin-context-meter');
  }

  const textHtml = renderToStaticMarkup(createElement(ChatView, { liveVoice: voice('idle') }));
  expect(textHtml).toContain('Earlier conversation compacted to preserve context');
  expect(textHtml).toContain('Compacting context…');
  expect(textHtml).not.toContain('SECRET_COMPACTION_PREVIEW');
});
```

Append to `frontend/src/styles/styles.test.ts`:

```ts
  it('defines quiet context meter pill and reduced-motion fill rules in chat.css', () => {
    const css = readFileSync(new URL('./chat.css', import.meta.url), 'utf-8');
    expect(css).toContain('.aurvin-composer-meta');
    expect(css).toContain('.aurvin-context-meter');
    expect(css).toContain('.aurvin-context-meter-fill');
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion: reduce\)[\s\S]*?\.aurvin-context-meter-fill[\s\S]*?transition:\s*none;/,
    );
  });
```

- [ ] **Step 2: Run targeted tests to verify failure**

Run from `frontend/`:
```bash
npx vitest run src/components/Composer.test.ts src/features/chat/ChatView.voice.test.ts src/styles/styles.test.ts
```
Expected: FAIL — `getContextMeterDisplay` not exported, `Composer` does not render `.aurvin-context-meter`, and `chat.css` lacks `.aurvin-context-meter`.

- [ ] **Step 3: Implement quiet context meter in `frontend/src/components/Composer.tsx`**

1. Import `type ContextUsageMeta` from `'../api/protocol.ts'`.
2. Export `ContextMeterDisplay` and `getContextMeterDisplay`:

```ts
export type ContextMeterDisplay = {
  percent: number;
  barPercent: number;
  status: 'idle' | 'compacting';
  high: boolean;
  label: string;
  detail: string;
};

export function getContextMeterDisplay(
  usage: ContextUsageMeta | null | undefined,
): ContextMeterDisplay | null {
  if (!usage) return null;
  if (usage.status !== 'compacting' && usage.utilizationPercent <= 50) {
    return null;
  }
  const percent = Math.max(0, Math.round(usage.utilizationPercent));
  const barPercent = Math.min(100, percent);
  const label =
    usage.status === 'compacting'
      ? 'Compacting context…'
      : `Context ${percent}%`;
  const detail = `${usage.historyTokens.toLocaleString()} / ${usage.maxHistoryTokens.toLocaleString()} history tokens`;
  return {
    percent,
    barPercent,
    status: usage.status,
    high: percent >= 80,
    label,
    detail,
  };
}
```

3. Pass `contextUsage={state.contextUsage ?? null}` from `Composer` into `ComposerContent` (extending `Pick<ChatState, 'draftInput' | 'activeSessionId' | 'voiceInput' | 'messagesLoading' | 'contextUsage'>`), compute:

```ts
  const contextMeter =
    variant === 'docked' && state.voiceInput?.mode !== 'live'
      ? getContextMeterDisplay(state.contextUsage)
      : null;
```

4. Replace the bottom `.aurvin-char-count` block (lines 153–157) with:

```tsx
      {contextMeter || state.draftInput.length > 25_000 ? (
        <div className="aurvin-composer-meta">
          {contextMeter ? (
            <div
              className="aurvin-context-meter"
              data-status={contextMeter.status}
              data-high={contextMeter.high ? 'true' : 'false'}
              title={contextMeter.detail}
              aria-label={`${contextMeter.label} (${contextMeter.detail})`}
            >
              <span className="aurvin-context-meter-track" aria-hidden="true">
                <span
                  className="aurvin-context-meter-fill"
                  style={{ width: `${contextMeter.barPercent}%` }}
                />
              </span>
              <span className="aurvin-context-meter-label">{contextMeter.label}</span>
            </div>
          ) : (
            <span />
          )}
          {state.draftInput.length > 25_000 ? (
            <div className="aurvin-char-count" data-over={isOverBudget}>
              {state.draftInput.length} / {MAX_INPUT_CHARS}
            </div>
          ) : null}
        </div>
      ) : null}
```

- [ ] **Step 4: Append quiet context meter styles to `frontend/src/styles/chat.css`**

Append at the end of `frontend/src/styles/chat.css`:

```css
/* ============================================================================
 * Quiet Composer Context Utilization Pill
 * ============================================================================ */

.aurvin-composer-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 8px;
  min-height: 20px;
}

.aurvin-context-meter {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--aurvin-border);
  color: var(--aurvin-text-muted);
  font-size: 11.5px;
  line-height: 1.4;
}

.aurvin-context-meter[data-high='true'],
.aurvin-context-meter[data-status='compacting'] {
  color: var(--aurvin-text);
  border-color: rgba(251, 191, 36, 0.35);
}

.aurvin-context-meter-track {
  width: 44px;
  height: 4px;
  border-radius: 999px;
  background-color: var(--aurvin-surface);
  overflow: hidden;
  flex-shrink: 0;
}

.aurvin-context-meter-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background-color: var(--aurvin-text-muted);
  transition: width 220ms ease;
}

.aurvin-context-meter[data-high='true'] .aurvin-context-meter-fill,
.aurvin-context-meter[data-status='compacting'] .aurvin-context-meter-fill {
  background-color: var(--aurvin-warning);
}

@media (prefers-reduced-motion: reduce) {
  .aurvin-context-meter-fill {
    transition: none;
  }
}
```

- [ ] **Step 5: Run Composer, Voice ChatView, and stylesheet tests**

Run from `frontend/`:
```bash
npm run build && npx vitest run src/components/Composer.test.ts src/features/chat/ChatView.voice.test.ts src/styles/styles.test.ts
```
Expected: PASS across all tests and clean build.

- [ ] **Step 6: Commit message suggestion (orchestrator-serialized)**

```text
Stage:
  frontend/src/components/Composer.tsx
  frontend/src/components/Composer.test.ts
  frontend/src/features/chat/ChatView.voice.test.ts
  frontend/src/styles/chat.css
  frontend/src/styles/styles.test.ts
Message:
  feat(composer): add quiet context utilization pill and verify Live Voice silence
```

---

### Task 7: Final P4 Verification Gate (`build`, `lint`, `test`)

**Files:** None (verification only).

- [ ] **Step 1: Verify production TypeScript and Vite build**

Run from `frontend/`:
```bash
npm run build
```
Expected: exit 0 (`tsc -b && vite build` succeeds cleanly).

- [ ] **Step 2: Verify lint with zero errors and zero new warnings**

Run from `frontend/`:
```bash
npm run lint
```
Expected: exit 0 with 0 errors and no warnings in P4-modified files (`protocol.ts`, `client.ts`, `Transcript.tsx`, `Composer.tsx`, `chat-reducer.ts`, `use-chat.ts`, `ConfigFields.tsx`, `ModelSelectionFields.tsx`, `AdminDashboard.tsx`, `config-edit-state.ts`).

- [ ] **Step 3: Run focused P4 test suites**

Run from `frontend/`:
```bash
npx vitest run src/api/protocol.test.ts src/api/client.test.ts src/features/admin-config/config-edit-state.test.ts src/features/admin-config/admin-dashboard.test.ts src/features/admin-config/admin-config-client.test.ts src/features/admin-config/integration-tests/config-flow.test.ts src/features/chat/state/compaction-chat-state.test.ts src/features/chat/state/chat-reducer.test.ts src/features/chat/state/memory-save-state.test.ts src/components/Transcript.test.ts src/components/Composer.test.ts src/features/chat/ChatView.voice.test.ts src/styles/styles.test.ts
```
Expected: 13/13 test files PASS.

- [ ] **Step 4: Run full frontend suite**

Run from `frontend/`:
```bash
npm test
```
Expected: All P4-owned and non-voice-parity tests pass. Note if pre-existing `src/api/testing/voice-fixtures.test.ts` (`bargeInSpeechWindows: 10` parity gap between unowned `voice-protocol.ts` and `backend/src/contracts/voice-wire.ts`) still fails independently—report it transparently without modifying unowned `voice-protocol.ts`.
