/**
 * ============================================================================
 * FILE: web-search-browser.tsx
 * LOCATION: frontend/src/features/plugins/integration-tests/web-search-browser.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Run deterministic Web Search plugin checks in a real browser.
 *
 * ROLE IN PROJECT:
 *    Development-only harness that mounts the real panel over a closed local
 *    client. It never contacts the backend proxy, providers, microphone, or live
 *    signaling, and it is not an application route or service proof.
 *
 * KEY COMPONENTS:
 *    - Closed fetch/storage/console guards installed before the panel import.
 *    - Ordered checks for cards, masking, default-off toggle, and privacy.
 * ============================================================================
 */

import { act } from 'react';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { check } from '../../admin-config/testing/browser-checks.ts';
import { createWebSearchClient } from '../../../api/web-search-client.ts';
import { WEB_SEARCH_PROVIDERS, type WebSearchPublicStatus } from '../../../api/web-search-protocol.ts';
import '../../../index.css';

if (!import.meta.env.DEV) {
  throw new Error('The Web Search browser fixture refuses non-development execution.');
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status: WebSearchPublicStatus = {
  protocolVersion: 1, revision: 1, enabled: false, effectiveEnabled: false,
  providers: WEB_SEARCH_PROVIDERS.map(provider => ({
    provider, state: 'not-connected', authMethod: null,
    authSupport: { apiKey: 'unverified', browserAuthorization: 'unverified' },
    capabilities: { browse: false, fetch: false }, lastValidatedAt: null,
  })),
};

let unexpectedNetwork = 0;
let mediaRequests = 0;
const stored: string[] = [];
const consoleLines: string[] = [];

window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url === '/api/plugins/web-search/status') return Response.json(status);
  unexpectedNetwork += 1;
  throw new Error(`closed fixture rejected ${url}`);
}) as typeof fetch;
window.XMLHttpRequest = class {
  open() { unexpectedNetwork += 1; }
  send() { unexpectedNetwork += 1; }
} as unknown as typeof XMLHttpRequest;
Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => {
  unexpectedNetwork += 1;
  return false;
} });
window.WebSocket = class {
  constructor() { unexpectedNetwork += 1; }
} as unknown as typeof WebSocket;
Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: { getUserMedia: async () => { mediaRequests += 1; throw new Error('closed fixture'); } },
});
const originalSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function setItem(key: string, value: string) {
  stored.push(`${key}=${value}`);
  return originalSetItem.call(this, key, value);
};
const originalInfo = console.info.bind(console);
console.info = (...values: unknown[]) => {
  consoleLines.push(values.map(value => String(value)).join(' '));
  originalInfo(...values);
};

const { WebSearchPanel } = await import('../web-search/WebSearchPanel.tsx');

const checks: string[] = [];
const record = (condition: unknown, message: string) => {
  check(condition, message);
  checks.push(message);
};

const root = createRoot(document.getElementById('root')!);
const client = createWebSearchClient({ fetch: window.fetch });
await act(async () => {
  root.render(createElement(WebSearchPanel, { client, initialStatus: status }));
});

const html = document.getElementById('root')!.innerHTML;
record(html.includes('type="password"'), 'masked key input present');
record(html.includes('rel="noopener noreferrer"'), 'console links use safe rel');
const names = ['TinyFish', 'Keenable', 'Exa', 'Tavily', 'Firecrawl'];
const positions = names.map(name => html.indexOf(name));
record(positions.every(index => index >= 0), 'five provider cards present');
record(JSON.stringify(positions) === JSON.stringify([...positions].sort((a, b) => a - b)),
  'provider cards are in priority order');
const toggle = document.querySelector<HTMLInputElement>('#web-search-account-enabled');
record(Boolean(toggle), 'account toggle present');
record(toggle?.disabled === true && toggle.checked === false, 'toggle starts disabled and off');
record(!document.querySelector('.aurvin-composer [data-web-search]'), 'no composer toggle');
record(!stored.some(value => value.includes('fixture-key')), 'no candidate stored');
record(unexpectedNetwork === 0, 'no unexpected outbound request');
record(mediaRequests === 0, 'no microphone request');
record(!consoleLines.some(line => line.includes('fixture-key')), 'no candidate logged');

const list = document.getElementById('fixture-checks')!;
for (const message of checks) {
  const item = document.createElement('li');
  item.textContent = message;
  list.appendChild(item);
}
document.getElementById('fixture-status')!.textContent =
  `${checks.length} passed; unexpected network ${unexpectedNetwork}; media ${mediaRequests}`;

await act(async () => { root.unmount(); });
