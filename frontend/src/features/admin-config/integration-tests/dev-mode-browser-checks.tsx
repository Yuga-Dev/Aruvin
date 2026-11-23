/**
 * ============================================================================
 * FILE: dev-mode-browser-checks.tsx
 * LOCATION: frontend/src/features/admin-config/integration-tests/dev-mode-browser-checks.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Closed Vite fixture checks for the Config-only dev mode controls.
 *
 * ROLE IN PROJECT:
 *    Mounts AdminDashboard against an in-page fetch stub so enablement,
 *    selector visibility, save behavior, and request errors are proven
 *    without a backend, chat provider, or voice surface.
 *
 * KEY COMPONENTS:
 *    - setup: Eligible/ineligible dashboard fixture with revisioned saves.
 *    - checkCheckbox: Labeled default-off checkbox and revisioned persistence.
 * ============================================================================
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createAdminConfigClient } from '../../../api/admin-config-client.ts';
import type {
  DevMode, DevModeResponse, SaveSettingsRequest,
} from '../../../api/admin-config-protocol.ts';
import type { AuthUser } from '../../../api/auth-protocol.ts';
import { AdminDashboard, type DashboardSection } from '../AdminDashboard.tsx';
import { byLabel, check } from '../testing/browser-checks.ts';
import { adminFailure, publicConfig } from '../testing/fixtures.ts';

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
  activation?: 'unconfigured';
  readMode?: () => Response | Promise<Response>;
} = {}) {
  let config = publicConfig();
  if (!options.legacy) config.roleAssumption = sessionAdmin;
  if (options.enabled !== undefined) config.settings.devModeEnabled = options.enabled;
  if (options.activation) {
    config.activation = options.activation;
    config.activeRevision = null;
  }
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let mode: DevMode = 'user';
  const handlers = {
    save: (body: SaveSettingsRequest): Response | Promise<Response> => {
      check(body.expectedRevision === config.revision, 'Save did not use the loaded revision');
      config = { ...config, revision: config.revision + 1, activeRevision: config.revision + 1,
        settings: body.settings };
      return json(config);
    },
    readMode: (): Response | Promise<Response> => json(config.settings.devModeEnabled
      ? { protocolVersion: 1, enabled: true, mode }
      : { protocolVersion: 1, enabled: false, mode: null }),
    writeMode: (next: DevMode): Response | Promise<Response> => {
      mode = next;
      return json({ protocolVersion: 1, enabled: true, mode });
    },
  };
  if (options.readMode) handlers.readMode = options.readMode;
  let capabilityRefreshes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input), location.origin).pathname;
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    if (path === '/api/admin/config' && method === 'GET') return json(config);
    if (path === '/api/admin/config' && method === 'PUT') return handlers.save(body as SaveSettingsRequest);
    if (path === '/api/admin/config/dev-mode' && method === 'GET') return handlers.readMode();
    if (path === '/api/admin/config/dev-mode' && method === 'PUT') {
      return handlers.writeMode((body as { mode: DevMode }).mode);
    }
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
      personalizationClient={{
        read: denyPersonalization,
        save: denyPersonalization,
        reset: denyPersonalization,
        reverseGeocode: denyPersonalization,
      }}
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
    check(input && input.labels?.[0]?.textContent === 'Enable dev mode' && !input.checked,
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

export async function runDevModeChecks(name: string) {
  const root = document.getElementById('root');
  const status = document.getElementById('fixture-status');
  check(root && status, 'Missing fixture markup');
  const cases = {
    checkbox: checkCheckbox, selector: checkSelector, save: checkSaveConfirmation, errors: checkModeErrors,
  };
  const run = cases[name as keyof typeof cases];
  check(Object.hasOwn(cases, name) && run, 'Unknown dev mode test case');
  await run(root);
  status.textContent = `PASS dev-mode ${name}`;
}
