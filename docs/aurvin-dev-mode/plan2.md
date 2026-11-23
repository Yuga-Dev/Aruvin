# Aurvin P2: Config-only User and Dev Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a full-access super-admin save **Enable dev mode** and select **User** or **Dev** only in Manage Aurvin → Config.

**Architecture:** Put both controls in the same Config section. The checkbox is an ordinary revisioned draft field; the session selector reads and writes P1’s control-plane endpoint and takes its initial visibility and selected value only from the active-mode GET. No mode state, request, prop, or await enters App’s chat or voice paths.

**Tech Stack:** Existing React/TypeScript Config dashboard, bounded fetch client, Vitest in Node, and the existing Vite closed-browser fixture.

---

## Contract and ownership

- Read [goal.md](goal.md) and [state.md](state.md). Start worker execution after P1 is verified and committed. P1 plan: `b7880f7`; no redesign.
- `GET /api/admin/config` and revisioned `PUT /api/admin/config` carry `settings.devModeEnabled` (missing is off). The update is still `{ protocolVersion: 1, expectedRevision, settings }`. **An eligible admin needs the unchecked checkbox to turn the feature on; when off, the User/Dev selector is absent.** Neither control belongs anywhere outside the eligible Config view.
- `GET /api/admin/config/dev-mode` → `200 { protocolVersion: 1, enabled: false, mode: null }` or `200 { protocolVersion: 1, enabled: true, mode: "user" | "dev" }`. `PUT` takes exactly `{ protocolVersion: 1, mode }` and returns the same response shape. Config faults are versioned (including `400 INVALID_CONFIG_REQUEST` and `409 DEV_MODE_DISABLED`); P1 auth faults are `{ error: { code, retryable } }` (`401 UNAUTHENTICATED`, `403 FORBIDDEN`/`PASSWORD_CHANGE_REQUIRED`, `503 NOT_READY`).
- `backend/src/contracts/admin-config-wire.ts` is P1-owned on this shared branch. **P2 makes no edits there or elsewhere in `backend/`.** The Task 1 browser mirror lists exactly what to reuse/add. If actual backend behavior differs from the handoff, report it to the P1 owner instead of loosening the browser parser.
- `frontend/src/api/admin-config-protocol.ts` and `frontend/src/api/admin-config-client.ts`: mirror and transport. `frontend/src/features/admin-config/config-edit-state.ts`: checkbox field catalog/default/dirty behavior; existing `ConfigFields.tsx` renders it unchanged. `frontend/src/features/admin-config/AdminDashboard.tsx`: gate and mount the section, retain the existing save flow, and coordinate busy state. New `frontend/src/features/admin-config/DevModeControls.tsx`: local GET/PUT lifecycle, status, and selector only.
- Test-only scope: the existing Admin Config unit tests and Vite fixture, a new fixture module beside that fixture, and absence assertions in the existing chat-shell and live-voice tests. Do not add dependencies, a test framework, separate runtime state, storage, polling, or capability refreshes for mode operations.
- All `npm` commands below run from `frontend/`; all `git` commands run from the repo root. Use the AGENTS.md file headers on new code/test modules. In shared `main`, stage only the named new files and use `git commit --only` with explicit paths; on `index.lock`, let the concurrent Git operation finish and retry once, never remove the lock.

### Task 1: Add the strict browser control-plane calls

**Files:** Modify `frontend/src/api/admin-config-protocol.ts`, `frontend/src/api/admin-config-client.ts`, `frontend/src/features/admin-config/config-edit-state.ts`, `frontend/src/features/admin-config/admin-config-client.test.ts`, `frontend/src/features/admin-config/admin-dashboard.test.ts`, and `frontend/src/features/admin-config/role-aware-dashboard.test.ts`.

- [ ] **Red test.** Append in `frontend/src/features/admin-config/admin-config-client.test.ts` (reuse `jsonResponse`, `publicConfig`, `adminFailure`, and `createAdminConfigClient`):

```ts
it('uses the dev mode control plane separately from settings', async () => {
  const off = { protocolVersion: 1, enabled: false, mode: null };
  const on = { protocolVersion: 1, enabled: true, mode: 'dev' };
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(jsonResponse(off))
    .mockResolvedValueOnce(jsonResponse(on))
    .mockResolvedValueOnce(jsonResponse({
      ...publicConfig(2), settings: { ...publicConfig().settings, devModeEnabled: true },
    }));
  const client = createAdminConfigClient({ baseUrl: '/api/', fetch: fetcher });
  await expect(client.readDevMode()).resolves.toEqual(off);
  await expect(client.setDevMode({ protocolVersion: 1, mode: 'dev' })).resolves.toEqual(on);
  const settings = { ...publicConfig().settings, devModeEnabled: true };
  await expect(client.saveSettings({ protocolVersion: 1, expectedRevision: 1, settings }))
    .resolves.toMatchObject({ revision: 2, settings: { devModeEnabled: true } });
  const [[get, read], [put, write], [config, save]] = fetcher.mock.calls;
  expect([get, put, config]).toEqual([
    '/api/admin/config/dev-mode', '/api/admin/config/dev-mode', '/api/admin/config',
  ]);
  expect(read).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'same-origin' });
  expect(read?.body).toBeUndefined();
  expect(write).toMatchObject({ method: 'PUT', cache: 'no-store', credentials: 'same-origin' });
  expect(JSON.parse(String(write?.body))).toEqual({ protocolVersion: 1, mode: 'dev' });
  expect(JSON.parse(String(save?.body))).toEqual({ protocolVersion: 1, expectedRevision: 1, settings });
});

it('rejects extra dev mode request keys and malformed response combinations', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, enabled: false, mode: 'dev' }))
    .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, enabled: true, mode: null }))
    .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, enabled: true, mode: 'user', extra: true }));
  const client = createAdminConfigClient({ fetch: fetcher });
  const invalid = { protocolVersion: 1 as const, mode: 'dev' as const, enabled: true };
  await expect(client.setDevMode(invalid)).rejects.toMatchObject({ code: 'INVALID_ADMIN_REQUEST' });
  expect(fetcher).not.toHaveBeenCalled();
  for (let i = 0; i < 3; i += 1) {
    await expect(client.readDevMode()).rejects.toMatchObject({ code: 'INVALID_ADMIN_RESPONSE' });
  }
});

it.each([
  [400, 'INVALID_CONFIG_REQUEST', adminFailure('INVALID_CONFIG_REQUEST')],
  [401, 'UNAUTHENTICATED', { error: { code: 'UNAUTHENTICATED', retryable: false } }],
  [403, 'FORBIDDEN', { error: { code: 'FORBIDDEN', retryable: false } }],
  [403, 'PASSWORD_CHANGE_REQUIRED', { error: { code: 'PASSWORD_CHANGE_REQUIRED', retryable: false } }],
  [409, 'DEV_MODE_DISABLED', adminFailure('DEV_MODE_DISABLED')],
  [503, 'NOT_READY', { error: { code: 'NOT_READY', retryable: true } }],
] as const)('maps dev mode HTTP %i %s without replaying the PUT', async (status, code, body) => {
  const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(body, status));
  const client = createAdminConfigClient({ fetch: fetcher });
  await expect(client.setDevMode({ protocolVersion: 1, mode: 'dev' }))
    .rejects.toMatchObject({ code, status, message: 'Configuration could not be completed.' });
  expect(fetcher).toHaveBeenCalledOnce();
});
```

- [ ] **Run red:** `npm test -- src/features/admin-config/admin-config-client.test.ts` → new cases fail because `readDevMode`/`setDevMode` are missing.
- [ ] **Minimal implementation.** In `frontend/src/api/admin-config-protocol.ts`, keep P1’s browser mirror additions `ADMIN_CONFIG_ROUTES.devMode`, `DEV_MODES`, `DevMode`, `DevModeResponse`, optional boolean `ManageableSettings.devModeEnabled` with its strict optional check, `ADMIN_CONFIG_FIELD_PATHS` entry `devModeEnabled`, and `ADMIN_CONFIG_ERROR_CODES` entry `DEV_MODE_DISABLED`. Add after `DevModeResponse` and after the existing guard helpers, respectively:

```ts
export type SetDevModeRequest = { protocolVersion: 1; mode: DevMode };
```

```ts
export function isDevMode(value: unknown): value is DevMode {
  return value === 'user' || value === 'dev';
}

export function isDevModeResponse(value: unknown): value is DevModeResponse {
  return record(value) && exact(value, {
    protocolVersion: v => v === ADMIN_CONFIG_PROTOCOL_VERSION,
    enabled: bool,
    mode: v => value.enabled === true ? isDevMode(v) : v === null,
  });
}
```

In `frontend/src/api/admin-config-client.ts`, import `isDevMode`, `isDevModeResponse`, `type DevModeResponse`, `type SetDevModeRequest` and `isAuthErrorResponse` (from `./auth-protocol.ts`). Add `'UNAUTHENTICATED' | 'FORBIDDEN' | 'PASSWORD_CHANGE_REQUIRED' | 'NOT_READY'` to `AdminConfigClientErrorCode`. Inside `if (!response.ok)` just before the existing `isAdminConfigError` branch, reuse the strict existing auth guard:

```ts
if (isAuthErrorResponse(payload)) {
  const { code, retryable } = payload.error;
  const status = response.status;
  if ((status === 401 && code === 'UNAUTHENTICATED')
      || (status === 403 && (code === 'FORBIDDEN' || code === 'PASSWORD_CHANGE_REQUIRED'))
      || (status === 503 && code === 'NOT_READY')) {
    throw new AdminConfigClientError({ code, status, retryable });
  }
}
```

Add to `AdminConfigClient`:

```ts
readDevMode(signal?: AbortSignal): Promise<DevModeResponse>;
setDevMode(request: SetDevModeRequest, signal?: AbortSignal): Promise<DevModeResponse>;
```

Add after `read` in the factory result:

```ts
async readDevMode(signal) {
  return request('GET', ADMIN_CONFIG_ROUTES.devMode, undefined, signal, false, isDevModeResponse);
},
async setDevMode(input, signal) {
  if (!input || typeof input !== 'object' || !exactKeys(input, ['protocolVersion', 'mode'])
      || input.protocolVersion !== ADMIN_CONFIG_PROTOCOL_VERSION || !isDevMode(input.mode)) {
    invalidRequest();
  }
  return request('PUT', ADMIN_CONFIG_ROUTES.devMode,
    JSON.stringify({ protocolVersion: ADMIN_CONFIG_PROTOCOL_VERSION, mode: input.mode }),
    signal, true, isDevModeResponse);
},
```

Keep the `DEV_MODE_DISABLED` entry P1 added to `ADMIN_ERROR_COPY` in `frontend/src/features/admin-config/config-edit-state.ts` (`68cff91`). Add these four safe strings to its `CLIENT_ERROR_COPY`:

```ts
UNAUTHENTICATED: 'Sign in again to manage configuration.',
FORBIDDEN: 'Full super-admin access is required to manage configuration.',
PASSWORD_CHANGE_REQUIRED: 'Change your password before managing configuration.',
NOT_READY: 'Configuration is temporarily unavailable. Try again.',
```

Add `readDevMode: vi.fn(), setDevMode: vi.fn(),` after `checkModelCompatibility` or after `updateCredential` in each of the four explicit `AdminConfigClient` fixtures (one in `frontend/src/features/admin-config/admin-dashboard.test.ts`, three in `frontend/src/features/admin-config/role-aware-dashboard.test.ts`, including the inline `client` prop). Do not make production client methods optional for tests.

- [ ] **Run green:** `npm test -- src/features/admin-config/admin-config-client.test.ts src/features/admin-config/admin-dashboard.test.ts src/features/admin-config/role-aware-dashboard.test.ts` → pass.
- [ ] **Commit:** `git commit --only -m "feat(config-ui): add dev mode control-plane client" -- frontend/src/api/admin-config-protocol.ts frontend/src/api/admin-config-client.ts frontend/src/features/admin-config/config-edit-state.ts frontend/src/features/admin-config/admin-config-client.test.ts frontend/src/features/admin-config/admin-dashboard.test.ts frontend/src/features/admin-config/role-aware-dashboard.test.ts`

### Task 2: Put enablement in the existing revisioned draft

**Files:** Modify `frontend/src/features/admin-config/config-edit-state.ts` and `frontend/src/features/admin-config/config-edit-state.test.ts`.

- [ ] **Red test.** Append in `frontend/src/features/admin-config/config-edit-state.test.ts`:

```ts
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
```

- [ ] **Run red:** `npm test -- src/features/admin-config/config-edit-state.test.ts` → missing default-off draft field and catalog coverage.
- [ ] **Minimal implementation.** Add `'devMode'` to `AdminSection`. Append this catalog item to `editableFields`:

```ts
{ path: 'devModeEnabled', section: 'devMode', group: 'Enablement',
  label: 'Enable dev mode', help: 'This setting takes effect only after you save changes.',
  kind: 'boolean' },
```

The current boolean branch in `fieldsFromSettings` maps a missing leaf to false. The current converter writes the root boolean, shows a changed marker, integrates with discard/revision locks, and does not put enablement into the compatibility key. Do not create a second draft, save button, or compatibility check.

- [ ] **Run green:** `npm test -- src/features/admin-config/config-edit-state.test.ts` → pass.
- [ ] **Commit:** `git commit --only -m "feat(config-ui): draft dev mode enablement in revisioned settings" -- frontend/src/features/admin-config/config-edit-state.ts frontend/src/features/admin-config/config-edit-state.test.ts`

### Task 3: Render the checkbox only in eligible Config

**Files:** Modify `frontend/src/features/admin-config/AdminDashboard.tsx` and `frontend/src/features/admin-config/integration-tests/dashboard-browser.tsx`; create `frontend/src/features/admin-config/integration-tests/dev-mode-browser-checks.tsx`.

- [ ] **Red test.** Create `frontend/src/features/admin-config/integration-tests/dev-mode-browser-checks.tsx` with the repository header and:

```tsx
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createAdminConfigClient } from '../../../api/admin-config-client.ts';
import type { SaveSettingsRequest } from '../../../api/admin-config-protocol.ts';
import type { AuthUser } from '../../../api/auth-protocol.ts';
import { AdminDashboard, type DashboardSection } from '../AdminDashboard.tsx';
import { byLabel, check } from '../testing/browser-checks.ts';
import { publicConfig } from '../testing/fixtures.ts';

const fullAdmin: AuthUser = {
  userId: 'usr-dev-fixture', email: 'admin@example.test',
  role: 'super-admin', passwordChangeRequired: false,
};
const sessionAdmin = { role: 'super-admin', authentication: 'session', source: 'local-account' } as const;
const checkbox = (root: ParentNode) => root.querySelector<HTMLInputElement>('#admin-field-devModeEnabled');
const selector = (root: ParentNode) => root.querySelector<HTMLSelectElement>('#admin-dev-mode');
const json = (body: unknown, status = 200) => Response.json(body, { status });

function button(root: ParentNode, label: string): HTMLButtonElement {
  const node = byLabel(root, label);
  check(node instanceof HTMLButtonElement, `Missing button: ${label}`);
  return node;
}

async function click(node: HTMLElement) {
  await act(async () => { node.click(); });
}

async function setup(root: HTMLElement, options: {
  user?: AuthUser | null;
  legacy?: boolean;
  initialSection?: DashboardSection;
  enabled?: boolean;
} = {}) {
  let config = publicConfig();
  if (!options.legacy) config.roleAssumption = sessionAdmin;
  if (options.enabled !== undefined) config.settings.devModeEnabled = options.enabled;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const handlers = {
    save: (body: SaveSettingsRequest): Response | Promise<Response> => {
      check(body.expectedRevision === config.revision, 'Save did not use the loaded revision');
      config = { ...config, revision: config.revision + 1, activeRevision: config.revision + 1,
        settings: body.settings };
      return json(config);
    },
  };
  let capabilityRefreshes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input), location.origin).pathname;
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    if (path === '/api/admin/config' && method === 'GET') return json(config);
    if (path === '/api/admin/config' && method === 'PUT') return handlers.save(body as SaveSettingsRequest);
    if (path === '/api/admin/config/models' && method === 'GET') {
      return json({ protocolVersion: 1, models: [], observedAt: '2026-11-18T00:00:00Z' });
    }
    throw new Error(`Unexpected dev mode fixture request: ${method} ${path}`);
  };
  const react = createRoot(root);
  const denyPersonalization = async (): Promise<never> => { throw new Error('Fixture: not available'); };
  await act(async () => {
    react.render(<AdminDashboard
      client={createAdminConfigClient({ fetch: fetcher, baseUrl: '/api' })}
      personalizationClient={{ read: denyPersonalization, save: denyPersonalization, reset: denyPersonalization }}
      user={options.user === undefined ? fullAdmin : options.user}
      initialSection={options.initialSection ?? 'devMode'}
      onBackToChat={() => undefined}
      refreshCapabilities={async () => { capabilityRefreshes += 1; return true; }}
    />);
  });
  return { requests, handlers, refreshes: () => capabilityRefreshes, close: () => act(async () => react.unmount()) };
}

async function checkCheckbox(root: HTMLElement) {
  const fixture = await setup(root, { initialSection: 'openrouter' });
  try {
    await click(button(root, 'Dev mode'));
    const input = checkbox(root);
    check(input?.labels?.[0]?.textContent === 'Enable dev mode' && !input.checked,
      'Eligible Config must show the labeled, default-off checkbox');
    check(!selector(root), 'Off must not expose a selector');
    const before = fixture.requests.length;
    await click(input);
    check(input.checked && fixture.requests.length === before && !selector(root),
      'An unsaved checkbox must not call an API or expose the selector');
    await click(button(root, 'Save changes'));
    const writes = fixture.requests.filter((entry) => entry.method === 'PUT');
    check(writes.length === 1 && writes[0].path === '/api/admin/config', 'Checkbox bypassed settings PUT');
    check((writes[0].body as SaveSettingsRequest).settings.devModeEnabled === true, 'Checkbox was not persisted');
    check(fixture.refreshes() === 1, 'Existing capability refresh changed');
    await click(button(root, 'Personalization'));
    check(!checkbox(root) && !selector(root), 'Controls mounted outside the Config tab');
  } finally {
    await fixture.close();
  }

  for (const options of [
    { user: { ...fullAdmin, role: 'user' } as const },
    { user: { ...fullAdmin, passwordChangeRequired: true } },
    { user: null },
    { legacy: true },
  ]) {
    const denied = await setup(root, { ...options, enabled: true });
    try {
      check(!checkbox(root) && !selector(root) && !byLabel(root, 'Dev mode'), 'Ineligible dashboard exposed controls');
      check(!denied.requests.some((entry) => entry.path.endsWith('/dev-mode')), 'Ineligible dashboard read mode');
    } finally {
      await denied.close();
    }
  }
}

export async function runDevModeChecks(name: string) {
  const root = document.getElementById('root');
  const status = document.getElementById('fixture-status');
  check(root && status, 'Missing fixture markup');
  check(name === 'checkbox', 'Unknown dev mode test case');
  await checkCheckbox(root);
  status.textContent = `PASS dev-mode ${name}`;
}
```

In `frontend/src/features/admin-config/integration-tests/dashboard-browser.tsx`, replace `void run().catch(...)` at the bottom with this entry while keeping the existing `.catch` body:

```ts
const devModeCase = new URLSearchParams(location.search).get('dev-mode');
void (devModeCase
  ? import('./dev-mode-browser-checks.tsx').then(({ runDevModeChecks }) => runDevModeChecks(devModeCase))
  : run()).catch((error) => {
  const status = document.getElementById('fixture-status');
  if (status) status.textContent = `Fixture crashed: ${error instanceof Error ? error.message : 'unknown'}`;
});
```

- [ ] **Run red.** From `frontend/`, start `npm run dev -- --host 127.0.0.1 --port 5178 --strictPort` in a separate terminal (Vite only, no backend). In PowerShell, run the following; keep the server for Task 4:

```powershell
function Test-DevModeFixture([string]$Case) {
  $chrome = "$env:ProgramFiles/Google/Chrome/Application/chrome.exe"
  $profile = Join-Path $env:LOCALAPPDATA ("Temp/opencode/aurvin-dev-mode-" + [guid]::NewGuid())
  $url = "http://127.0.0.1:5178/src/features/admin-config/integration-tests/dashboard-browser.html?dev-mode=$Case"
  $dom = & $chrome --headless --disable-gpu --no-first-run "--user-data-dir=$profile" --dump-dom --virtual-time-budget=10000 $url
  $status = ($dom | Select-String '<p id="fixture-status">').Line
  if ($status -notlike "*PASS dev-mode $Case*") { throw "Dev mode fixture: $status" }
  $status
}
Test-DevModeFixture checkbox
```

Expected red: `Fixture crashed: Missing button: Dev mode`. A server/fixture load error does not count as red.

- [ ] **Minimal implementation.** In `frontend/src/features/admin-config/AdminDashboard.tsx`, append `{ id: 'devMode', label: 'Dev mode' },` to `CONFIG_SECTIONS`. After `ready`, compute:

```ts
const canShowDevMode = ready && user?.role === 'super-admin' && user.passwordChangeRequired === false
  && edit.baseline.roleAssumption.role === 'super-admin'
  && edit.baseline.roleAssumption.authentication === 'session'
  && edit.baseline.roleAssumption.source === 'local-account';
const configSections = canShowDevMode ? CONFIG_SECTIONS : CONFIG_SECTIONS.filter(({ id }) => id !== 'devMode');
const configSection = !canShowDevMode && section === 'devMode' ? 'openrouter' : section;
const showDevModeSection = canShowDevMode && tab === 'config' && configSection === 'devMode';
```

Use `configSections` for both rail and mobile picker maps and section-label lookups, and `configSection` for the selected rail button/picker value/heading and section-dependent credential, model, error and field rendering. The default/initial state and navigation still write `section`. At the existing `ConfigFields` call site use:

```tsx
{configSection !== 'devMode' || showDevModeSection ? (
  <ConfigFields
    section={configSection}
    fields={edit.fields}
    original={originalFields}
    errors={errors}
    disabled={editingLocked}
    floor={edit.baseline.chatFloor}
    models={models}
    modelsLoading={modelsLoading}
    modelsError={modelsError}
    onRetryModels={loadModels}
    onChange={handleFieldChange}
  />
) : null}
```

An ineligible direct `initialSection="devMode"` cannot bypass the gate. Leave `AdminDashboardProps`, `ConfigFieldsProps`, role-specific tabs, and existing save code unchanged in this task.

- [ ] **Run green:** `Test-DevModeFixture checkbox` → `PASS dev-mode checkbox`; `npm test -- src/features/admin-config/admin-dashboard.test.ts src/features/admin-config/role-aware-dashboard.test.ts` → pass.
- [ ] **Commit:** `git add -- frontend/src/features/admin-config/integration-tests/dev-mode-browser-checks.tsx` then `git commit --only -m "feat(config-ui): gate the dev mode checkbox to authenticated Config" -- frontend/src/features/admin-config/AdminDashboard.tsx frontend/src/features/admin-config/integration-tests/dashboard-browser.tsx frontend/src/features/admin-config/integration-tests/dev-mode-browser-checks.tsx`

### Task 4: Confirm active enablement, then allow a server-owned mode change

**Files:** Modify `frontend/src/features/admin-config/AdminDashboard.tsx` and `frontend/src/features/admin-config/integration-tests/dev-mode-browser-checks.tsx`; create `frontend/src/features/admin-config/DevModeControls.tsx`.

- [ ] **Red test.** Extend `frontend/src/features/admin-config/integration-tests/dev-mode-browser-checks.tsx`. Import `DevMode`, `DevModeResponse` as types and `adminFailure` from `../testing/fixtures.ts`. Allow `options.activation?: 'unconfigured'`; if present, set `config.activation = options.activation` and `config.activeRevision = null` after creating the fixture config. Add mode route handling to `fetcher` (retain its `requests.push`), and these callbacks to `handlers`:

```ts
let mode: DevMode = 'user'; // in setup before handlers
```

```ts
readMode: (): Response | Promise<Response> => json(config.settings.devModeEnabled
  ? { protocolVersion: 1, enabled: true, mode }
  : { protocolVersion: 1, enabled: false, mode: null }),
writeMode: (next: DevMode): Response | Promise<Response> => {
  mode = next;
  return json({ protocolVersion: 1, enabled: true, mode });
},
```

```ts
if (path === '/api/admin/config/dev-mode' && method === 'GET') return handlers.readMode();
if (path === '/api/admin/config/dev-mode' && method === 'PUT') {
  return handlers.writeMode((body as { mode: DevMode }).mode);
}
```

In `setup`, accept `options.readMode?: () => Response | Promise<Response>` and assign `handlers.readMode = options.readMode ?? handlers.readMode` before the first render. Append the following checks; replace the name guard and direct check call in `runDevModeChecks` with the dispatcher at the end of this block:

```tsx
function modeResponse(mode: DevMode | null): Response {
  const body: DevModeResponse = mode === null
    ? { protocolVersion: 1, enabled: false, mode }
    : { protocolVersion: 1, enabled: true, mode };
  return json(body);
}

function holdResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function selectMode(root: HTMLElement, value: DevMode) {
  const input = selector(root);
  check(input, 'Session mode selector is missing');
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function checkSelector(root: HTMLElement) {
  const read = holdResponse();
  const fixture = await setup(root, { enabled: true, activation: 'unconfigured', readMode: () => read.promise });
  const modeRequests = () => fixture.requests.filter((entry) => entry.path.endsWith('/dev-mode'));
  const writes = () => modeRequests().filter((entry) => entry.method === 'PUT');
  try {
    check(modeRequests().length === 1 && !selector(root), 'Selector appeared before active GET confirmed it');
    check(root.querySelector('#admin-dev-mode-status[role="status"]')?.textContent?.includes('Checking active dev mode'),
      'GET loading was not announced');
    await act(async () => read.resolve(modeResponse('user')));
    check(selector(root)?.value === 'user' && selector(root)?.labels?.[0]?.textContent === 'Session mode',
      'Active GET must select User even when chat is unconfigured');
    await selectMode(root, 'user');
    check(writes().length === 0, 'Reselecting User sent a PUT');

    const write = holdResponse();
    fixture.handlers.writeMode = () => write.promise;
    await selectMode(root, 'dev');
    check(selector(root)?.disabled && selector(root)?.value === 'user' && checkbox(root)?.disabled,
      'During a PUT the old confirmed value must remain visible and both controls must be disabled');
    check(root.querySelector('#admin-dev-mode-status[role="status"]')?.textContent?.includes('Changing session mode'),
      'Mode write was not announced');
    check(JSON.stringify(writes()[0]?.body) === JSON.stringify({ protocolVersion: 1, mode: 'dev' }),
      'Mode change did not send exactly the session-mode body');
    await act(async () => write.resolve(modeResponse('dev')));
    check(selector(root)?.value === 'dev' && fixture.refreshes() === 0, 'Mode PUT was not isolated from settings');
    check(root.querySelector('#admin-dev-mode-status[role="status"]')?.textContent?.includes('Current session mode: Dev'),
      'Confirmed mode change was not announced');
    await selectMode(root, 'dev');
    check(writes().length === 1, 'Reselecting Dev sent a PUT');

    const input = checkbox(root);
    check(input, 'Missing checkbox before disable');
    await click(input);
    check(selector(root)?.disabled && selector(root)?.value === 'dev' && modeRequests().length === 2,
      'An unsaved disable must not change active server state');
    fixture.handlers.save = () => json(adminFailure('CONFIG_CONFLICT', 2), 409);
    await click(button(root, 'Save changes'));
    check(!input.checked && selector(root)?.disabled && modeRequests().length === 2,
      'A conflicted save must retain the draft and not refresh or change mode');
    check(byLabel(root, 'Reload saved settings'), 'Conflict recovery is missing');
  } finally {
    await fixture.close();
  }
}

async function checkSaveConfirmation(root: HTMLElement) {
  const storedOnly = await setup(root, { enabled: true, readMode: () => modeResponse(null) });
  try {
    check(checkbox(root)?.checked && !selector(root), 'Stored enablement is not active confirmation');
  } finally {
    await storedOnly.close();
  }

  const fixture = await setup(root, { readMode: () => modeResponse(null) });
  const reads = () => fixture.requests.filter((entry) => entry.method === 'GET' && entry.path.endsWith('/dev-mode'));
  try {
    const input = checkbox(root);
    check(input && !input.checked && !selector(root), 'Off GET did not hide the selector');
    await click(input);
    const save = fixture.handlers.save;
    fixture.handlers.save = () => json(adminFailure('CONFIG_STORAGE_UNAVAILABLE'), 503);
    await click(button(root, 'Save changes'));
    check(input.checked && reads().length === 1 && !selector(root),
      'A failed enable save must retain the draft without making mode available');
    const confirmed = holdResponse();
    fixture.handlers.save = save;
    fixture.handlers.readMode = () => confirmed.promise;
    await click(button(root, 'Save changes'));
    check(reads().length === 2 && !selector(root), 'Saved enablement must wait for a fresh active GET');
    await act(async () => confirmed.resolve(modeResponse('user')));
    check(selector(root)?.value === 'user', 'Fresh GET did not confirm User after enabling');
    const checked = checkbox(root);
    check(checked?.checked, 'Missing saved enablement');
    fixture.handlers.readMode = () => modeResponse(null);
    await click(checked);
    await click(button(root, 'Save changes'));
    check(reads().length === 3 && !selector(root) && !checkbox(root)?.checked, 'Confirmed disable did not remove selector');
  } finally {
    await fixture.close();
  }
}

// Inside runDevModeChecks, replace the single-case guard and call:
const cases = { checkbox: checkCheckbox, selector: checkSelector, save: checkSaveConfirmation };
const run = cases[name as keyof typeof cases];
check(Object.hasOwn(cases, name) && run, 'Unknown dev mode test case');
await run(root);
```

- [ ] **Run red:** `Test-DevModeFixture selector`, `Test-DevModeFixture save` → no GET/selector exists yet, so expect `Selector appeared before active GET confirmed it` and `A failed enable save must retain the draft without making mode available`, respectively. Run cases separately so a thrown assertion for the first case does not skip the next.
- [ ] **Minimal implementation.** Create `frontend/src/features/admin-config/DevModeControls.tsx` with the repository header and:

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdminConfigClient } from '../../api/admin-config-client.ts';
import { isDevMode, type DevModeResponse } from '../../api/admin-config-protocol.ts';

export type DevModeControlsProps = {
  client: AdminConfigClient;
  disabled: boolean;
  enablementDirty: boolean;
  onBusy: (busy: boolean) => void;
  children: ReactNode;
};

type State =
  | { phase: 'loading' }
  | { phase: 'ready' | 'saving'; value: DevModeResponse }
  | { phase: 'error' };

export function DevModeControls({ client, disabled, enablementDirty, onBusy, children }: DevModeControlsProps) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const scope = useRef<AbortController | null>(null);
  const writing = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    scope.current = abort;
    void client.readDevMode(abort.signal).then((value) => {
      if (!abort.signal.aborted) setState({ phase: 'ready', value });
    }).catch(() => {
      if (!abort.signal.aborted) setState({ phase: 'error' });
    });
    return () => {
      abort.abort();
      scope.current = null;
      if (writing.current) {
        writing.current = false;
        onBusy(false);
      }
    };
  }, [client, onBusy]);

  const changeMode = (next: string) => {
    const signal = scope.current?.signal;
    if (!signal || signal.aborted || disabled || enablementDirty || writing.current
        || state.phase !== 'ready' || !state.value.enabled || next === state.value.mode || !isDevMode(next)) return;
    writing.current = true;
    onBusy(true);
    setState({ phase: 'saving', value: state.value });
    void client.setDevMode({ protocolVersion: 1, mode: next }, signal).then((value) => {
      if (!signal.aborted) setState({ phase: 'ready', value });
    }).catch(() => {
      if (!signal.aborted) setState({ phase: 'error' });
    }).finally(() => {
      if (signal.aborted) return;
      writing.current = false;
      onBusy(false);
    });
  };

  const active = (state.phase === 'ready' || state.phase === 'saving') && state.value.enabled ? state.value : null;
  const status = state.phase === 'loading' ? 'Checking active dev mode…'
    : state.phase === 'saving' ? 'Changing session mode…'
    : enablementDirty ? 'Save or discard the enablement change before selecting a mode.'
    : disabled ? 'Session mode is unavailable while configuration is locked.'
    : active ? `Current session mode: ${active.mode === 'dev' ? 'Dev' : 'User'}.` : '';
  return (
    <>
      {children}
      <p id="admin-dev-mode-status" className="aurvin-admin-help" role="status">{status}</p>
      {active ? (
        <div className="aurvin-admin-field">
          <label htmlFor="admin-dev-mode">Session mode</label>
          <select
            id="admin-dev-mode"
            aria-describedby="admin-dev-mode-status"
            value={active.mode}
            disabled={disabled || enablementDirty || state.phase === 'saving'}
            onChange={(event) => changeMode(event.target.value)}
          >
            <option value="user">User</option>
            <option value="dev">Dev</option>
          </select>
          <p className="aurvin-admin-help">Changes session mode immediately without saving other settings.</p>
        </div>
      ) : null}
      {state.phase === 'error' ? <p role="alert">Could not confirm session mode.</p> : null}
    </>
  );
}
```

In `frontend/src/features/admin-config/AdminDashboard.tsx`, import `DevModeControls`. Add local state alongside the existing busy flags:

```ts
const [devModeBusy, setDevModeBusy] = useState(false);
const [devModeReload, setDevModeReload] = useState(0);
```

After `changed`, derive:

```ts
const enablementDirty = changed.some((field) => field.path === 'devModeEnabled');
```

Increment `devModeReload` only in the accepted `.then` of `performReload` after `dispatch({ type: 'loaded', config })`, so an explicit reload rechecks mode even if the revision is unchanged. Add `devModeBusy` to `mutationBusy`. Add `|| devModeBusy || (enablementDirty && !canShowDevMode)` to Save’s existing `disabled` expression and `save`’s guard. Add `|| devModeBusy` to Discard’s existing `disabled` expression and `disabled={devModeBusy}` to the dirty-chip buttons. Add `if (devModeBusy) return;` at the top of `onTabKey`. These changes serialize mode PUTs against settings mutations and navigation without blocking settings saves on mode GET.

Replace the ConfigFields JSX from Task 3 with a `configFields` element defined above `return` when `ready`, using the same props as before, but with `disabled={editingLocked || (configSection === 'devMode' && (credentialBusy || devModeBusy))}`. The section branch at the original render location is:

```tsx
{configSection !== 'devMode' ? configFields : showDevModeSection ? (
  <DevModeControls
    key={JSON.stringify([user?.userId, edit.baseline.revision, devModeReload])}
    client={client}
    disabled={editingLocked || credentialBusy}
    enablementDirty={enablementDirty}
    onBusy={setDevModeBusy}
  >
    {configFields}
  </DevModeControls>
) : null}
```

The `ready` render branch retains the narrowing for `edit.baseline`. The keyed child starts a fresh GET on entry, revision change, or explicit reload; a late request from an older child is aborted/ignored. A draft edit, discard, or failed settings PUT does not key off draft state and cannot reveal the selector. Do not derive mode or its visibility from `activation`, `activeRevision`, or the save response; do not make the existing settings save wait for mode data or make mode PUT call `refreshCapabilities`.

- [ ] **Run green:** `Test-DevModeFixture checkbox`, `Test-DevModeFixture selector`, `Test-DevModeFixture save` → each reports `PASS dev-mode <case>`.
- [ ] **Commit:** `git add -- frontend/src/features/admin-config/DevModeControls.tsx` then `git commit --only -m "feat(config-ui): select confirmed session mode from Config only" -- frontend/src/features/admin-config/DevModeControls.tsx frontend/src/features/admin-config/AdminDashboard.tsx frontend/src/features/admin-config/integration-tests/dev-mode-browser-checks.tsx`

### Task 5: Fail closed on access loss or unavailable mode

**Files:** Modify `frontend/src/features/admin-config/AdminDashboard.tsx`, `frontend/src/features/admin-config/DevModeControls.tsx`, `frontend/src/features/admin-config/integration-tests/dev-mode-browser-checks.tsx`, `frontend/src/App.assembly.test.ts`, and `frontend/src/features/voice/live/live-voice-surface.test.ts`.

- [ ] **Red test.** Append in `frontend/src/features/admin-config/integration-tests/dev-mode-browser-checks.tsx`; add `errors: checkModeErrors` to `cases`:

```ts
async function checkModeErrors(root: HTMLElement) {
  const fixture = await setup(root, { enabled: true });
  const alert = (text: string) => [...root.querySelectorAll('[role="alert"]')]
    .some((node) => node.textContent?.includes(text));
  const writes = () => fixture.requests.filter((entry) => entry.method === 'PUT');
  try {
    fixture.handlers.writeMode = () => json(adminFailure('DEV_MODE_DISABLED'), 409);
    await selectMode(root, 'dev');
    check(!selector(root) && alert('Dev mode is no longer enabled'), '409 left stale mode or no specific alert');
    fixture.handlers.readMode = () => json({ error: { code: 'NOT_READY', retryable: true } }, 503);
    await click(button(root, 'Refresh mode'));
    check(!selector(root) && alert('Dev mode is temporarily unavailable'), '503 exposed a mode or no specific alert');
    fixture.handlers.readMode = () => modeResponse('user');
    await click(button(root, 'Refresh mode'));
    check(selector(root)?.value === 'user' && writes().length === 1, 'Recovery replayed the failed write');
    fixture.handlers.writeMode = () => json({ error: { code: 'NOT_READY', retryable: true } }, 503);
    await selectMode(root, 'dev');
    check(!selector(root) && alert('Dev mode is temporarily unavailable'), '503 PUT preserved a stale selection');
    await click(button(root, 'Refresh mode'));
    check(selector(root)?.value === 'user' && writes().length === 2, '503 recovery replayed the failed write');
    fixture.handlers.writeMode = () => json({ error: { code: 'PASSWORD_CHANGE_REQUIRED', retryable: false } }, 403);
    await selectMode(root, 'dev');
    check(!selector(root) && !checkbox(root) && alert('Change your password'), '403 did not hide both controls');
    check(!byLabel(root, 'Refresh mode') && writes().length === 3, '403 left a retry or replayed a write');
  } finally {
    await fixture.close();
  }

  const settingsDenied = await setup(root);
  try {
    const input = checkbox(root);
    check(input, 'Missing eligible checkbox before settings denial');
    await click(input);
    settingsDenied.handlers.save = () => json({ error: { code: 'FORBIDDEN', retryable: false } }, 403);
    await click(button(root, 'Save changes'));
    check(!selector(root) && !checkbox(root) && alert('Full super-admin access'), 'Settings 403 was not enforced');
    check(button(root, 'Save changes').disabled, 'Settings 403 left a denied draft saveable');
  } finally {
    await settingsDenied.close();
  }
}
```

Add boundary assertions in `frontend/src/App.assembly.test.ts` inside `mounts one text shell and does not put voice flags or secrets in the client entry`, after the composer assertion, and in `frontend/src/features/voice/live/live-voice-surface.test.ts` inside `announces operational dimensions via sr-only status and renders only the animated bubble and icon controls`, after the live region assertion:

```ts
expect(html).not.toMatch(/Enable dev mode|Session mode|admin-field-devModeEnabled|admin-dev-mode/);
```

These absence assertions should be green already; the positive Config cases prevent vacuous acceptance.

- [ ] **Run red:** `Test-DevModeFixture errors` → `409 left stale mode or no specific alert`, since Task 4 has only generic failure copy.
- [ ] **Minimal implementation.** In `frontend/src/features/admin-config/DevModeControls.tsx`, import `AdminConfigClientError` alongside the client type, and `errorCopy` from `./config-edit-state.ts`. Replace the error `State` variant with `{ phase: 'error'; message: string; denied: boolean }`; add:

```ts
function failure(error: unknown): State {
  if (error instanceof AdminConfigClientError) {
    if (error.status === 401 || error.status === 403) {
      const code = error.status === 401 ? 'UNAUTHENTICATED'
        : error.code === 'PASSWORD_CHANGE_REQUIRED' ? error.code : 'FORBIDDEN';
      return { phase: 'error', denied: true, message: errorCopy(code) };
    }
    if (error.status === 409 || error.status === 503) {
      return { phase: 'error', denied: false, message: error.status === 409
        ? 'Dev mode is no longer enabled. Refresh its status.'
        : 'Dev mode is temporarily unavailable. Refresh its status to try again.' };
    }
  }
  return { phase: 'error', denied: false, message: 'Could not confirm session mode. Refresh its status before changing it.' };
}
```

In `DevModeControls`, add `const [readAttempt, setReadAttempt] = useState(0);` and include `readAttempt` in the GET effect deps. In both existing catches accept `(error: unknown)` and use `setState(failure(error))` inside the existing not-aborted guard. Replace `{children}` with `{state.phase !== 'error' || !state.denied ? children : null}`, and replace the existing error rendering with:

```tsx
{state.phase === 'error' ? (
  <div className="aurvin-admin-alert">
    <p role="alert">{state.message}</p>
    {!state.denied ? (
      <button type="button" disabled={disabled} onClick={() => {
        setState({ phase: 'loading' });
        setReadAttempt((attempt) => attempt + 1);
      }}>Refresh mode</button>
    ) : null}
  </div>
) : null}
```

In `frontend/src/features/admin-config/AdminDashboard.tsx`, add immediately after `enablementDirty`:

```ts
const devModeSettingsDenied = ['UNAUTHENTICATED', 'FORBIDDEN', 'PASSWORD_CHANGE_REQUIRED']
  .includes(edit?.error?.code ?? '');
```

Replace `(enablementDirty && !canShowDevMode)` in both Save guards with `(enablementDirty && (!canShowDevMode || devModeSettingsDenied))`; replace `showDevModeSection ?` in the `DevModeControls` render branch with `showDevModeSection && !devModeSettingsDenied ?`. Change the existing summary condition from `errors.length > 0` to `edit.error` and the paragraph to `<p>{errorCopy(edit.error.code)}</p>` so 403/409/503 settings failures are announced even with no field errors. Keep the existing field list, focus, reload and conflict handling. Do not auto-retry any write; only a valid new GET can recover a selectable mode.

- [ ] **Run green:** `Test-DevModeFixture errors` → `PASS dev-mode errors`. Run `Test-DevModeFixture checkbox`, `Test-DevModeFixture selector`, and `Test-DevModeFixture save` again; then `npm test -- src/App.assembly.test.ts src/features/voice/live/live-voice-surface.test.ts src/features/admin-config` → pass.
- [ ] **Commit:** `git commit --only -m "fix(config-ui): fail closed and announce dev mode request errors" -- frontend/src/features/admin-config/DevModeControls.tsx frontend/src/features/admin-config/AdminDashboard.tsx frontend/src/features/admin-config/integration-tests/dev-mode-browser-checks.tsx frontend/src/App.assembly.test.ts frontend/src/features/voice/live/live-voice-surface.test.ts`

## Final verification and handoff

- [ ] From `frontend/`, run `npm test`, `npm run lint`, and `npm run build`. Report their actual outcomes and the four closed browser results separately; Vitest does not discover browser fixtures. Stop the local fixture server after checking it.
- [ ] Confirm only the owned frontend files and tests are in the P2 implementation commits. No backend, chat/voice production, package, or app-shell changes. Report commit hashes, failing and passing cases, any baseline failures, and the Config-only wire names to the orchestrator.
