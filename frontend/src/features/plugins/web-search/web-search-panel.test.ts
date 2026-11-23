/**
 * ============================================================================
 * FILE: web-search-panel.test.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-panel.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify WebSearchPanel DOM markup, ordering, capability gating, and secret hygiene.
 *
 * ROLE IN PROJECT:
 *    Confirms the five fixed cards render in priority order, Connect account appears
 *    for supported browserAuthorization and a real support check for unverified ones,
 *    toggle stays disabled without a connected provider, all states render safely,
 *    and no secret leaks into DOM.
 *
 * KEY COMPONENTS:
 *    - WebSearchPanel static markup assertions
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WebSearchClient } from '../../../api/web-search-client.ts';
import { WEB_SEARCH_PROVIDERS, type WebSearchPublicStatus } from '../../../api/web-search-protocol.ts';
import { WebSearchPanel } from './WebSearchPanel.tsx';

function mockClient(): WebSearchClient {
  return {
    status: vi.fn(),
    setEnabled: vi.fn(),
    connectProvider: vi.fn(),
    disconnectProvider: vi.fn(),
    startOAuth: vi.fn(),
    completeOAuth: vi.fn(),
  };
}

function makeStatus(
  override: (provider: WebSearchPublicStatus['providers'][number]) => WebSearchPublicStatus['providers'][number] = (p) => p,
  enabled = false,
): WebSearchPublicStatus {
  const providers = WEB_SEARCH_PROVIDERS.map((provider) =>
    override({
      provider,
      state: 'not-connected',
      authMethod: null,
      authSupport: { apiKey: 'supported', browserAuthorization: 'unsupported' },
      capabilities: { browse: false, fetch: false },
      lastValidatedAt: null,
    }),
  );
  const effectiveEnabled = enabled && providers.some((p) => p.state === 'connected');
  return {
    protocolVersion: 1,
    revision: 1,
    enabled,
    effectiveEnabled,
    providers,
  };
}

describe('WebSearchPanel', () => {
  it('renders global toggle default off & disabled without connection plus five ordered provider cards', () => {
    const html = renderToStaticMarkup(
      createElement(WebSearchPanel, {
        client: mockClient(),
        initialStatus: makeStatus(),
      }),
    );

    expect(html).toContain('Enable web search');
    expect(html).toMatch(/id="web-search-account-enabled"[^>]*disabled=""/);
    expect(html).not.toMatch(/id="web-search-account-enabled"[^>]*checked=""/);

    const positions = ['TinyFish', 'Keenable', 'Exa', 'Tavily', 'Firecrawl'].map((name) => html.indexOf(name));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    expect(html).toContain('https://agent.tinyfish.ai/api-keys');
    expect(html).toContain('https://app.keenable.ai/');
    expect(html).toContain('https://dashboard.exa.ai/api-keys');
    expect(html).toContain('https://app.tavily.com/home');
    expect(html).toContain('https://www.firecrawl.dev/app/api-keys');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('Connect account');
  });

  it('shows the masked TinyFish key field with documented Bearer-key instructions', () => {
    const html = renderToStaticMarkup(
      createElement(WebSearchPanel, {
        client: mockClient(),
        initialStatus: makeStatus((item) =>
          item.provider === 'tinyfish'
            ? { ...item, authSupport: { apiKey: 'supported', browserAuthorization: 'unverified' } }
            : item,
        ),
      }),
    );
    const card = html.match(/<article[^>]*data-provider="tinyfish"[\s\S]*?<\/article>/)?.[0] ?? '';
    expect(card).toMatch(/id="web-search-key-tinyfish"[^>]*type="password"/);
    expect(card).toContain('sk-tinyfish-');
    expect(card).toContain('Authorization: Bearer');
    expect(card).toContain('not live-verified');
    expect(card).not.toContain('no key field');
    expect(card).not.toContain('does not accept');
  });

  it('offers a labeled real support check for unverified providers and connect only for supported ones', () => {
    const html = renderToStaticMarkup(
      createElement(WebSearchPanel, {
        client: mockClient(),
        initialStatus: makeStatus((item) => ({
          ...item,
          authSupport: {
            apiKey: 'supported',
            browserAuthorization: item.provider === 'tinyfish' ? 'unverified'
              : item.provider === 'keenable' ? 'supported' : 'unsupported',
          },
        })),
      }),
    );
    expect(html).toContain('Check TinyFish browser authorization support');
    expect(html).toContain('Connect Keenable account');
    expect(html).not.toContain('Connect TinyFish account');
    expect(html).not.toContain('Check Exa browser authorization support');
    expect(html).not.toContain('Connect Exa account');
  });

  it('enables toggle when connected and renders invalid-key, unavailable, reconnect-required, and connecting states', () => {
    const initialStatus = makeStatus(
      (item) => {
        if (item.provider === 'tinyfish') return { ...item, state: 'connecting' };
        if (item.provider === 'keenable') return { ...item, state: 'invalid-key' };
        if (item.provider === 'exa') {
          return {
            ...item,
            state: 'connected',
            authMethod: 'api-key',
            capabilities: { browse: true, fetch: true },
            lastValidatedAt: '2026-11-14T00:00:00.000Z',
          };
        }
        if (item.provider === 'tavily') return { ...item, state: 'unavailable' };
        if (item.provider === 'firecrawl') return { ...item, state: 'reconnect-required' };
        return item;
      },
      true,
    );

    const html = renderToStaticMarkup(
      createElement(WebSearchPanel, {
        client: mockClient(),
        initialStatus,
      }),
    );

    expect(html).toMatch(/id="web-search-account-enabled"[^>]*checked=""/);
    expect(html).not.toMatch(/id="web-search-account-enabled"[^>]*disabled=""/);
    expect(html).toContain('Connecting…');
    expect(html).toContain('Invalid or expired key');
    expect(html).toContain('Connected');
    expect(html).toContain('Temporarily unavailable');
    expect(html).toContain('Reconnect required');
    expect(html).toContain('Replace');
    expect(html).toContain('Disconnect');
  });

  it('shows honest unavailable states and keeps an enabled toggle operable to switch off', () => {
    const initialStatus = makeStatus(
      (item) => {
        if (item.provider === 'exa') {
          return { ...item, state: 'invalid-key', authMethod: 'api-key' };
        }
        if (item.provider === 'tavily') {
          return { ...item, state: 'unavailable', authMethod: 'api-key' };
        }
        return item;
      },
      true,
    );

    const html = renderToStaticMarkup(
      createElement(WebSearchPanel, {
        client: mockClient(),
        initialStatus,
      }),
    );

    expect(html).toContain('Invalid or expired key');
    expect(html).toContain('Temporarily unavailable');
    expect(html).not.toContain('Active for new chat and voice turns');
    expect(html).toContain('Web Search is temporarily unavailable.');
    expect(html).toMatch(/id="web-search-account-enabled"[^>]*checked=""/);
    expect(html).not.toMatch(/id="web-search-account-enabled"[^>]*disabled=""/);
    expect(html).toContain('Replace');
    expect(html).toContain('Disconnect');
  });

  it('asks for a reconnect when every saved provider is invalid or needs reconnection', () => {
    const initialStatus = makeStatus(
      (item) => {
        if (item.provider === 'exa') {
          return { ...item, state: 'invalid-key', authMethod: 'api-key' };
        }
        if (item.provider === 'tavily') {
          return { ...item, state: 'reconnect-required', authMethod: 'oauth' };
        }
        return item;
      },
      true,
    );

    const html = renderToStaticMarkup(
      createElement(WebSearchPanel, {
        client: mockClient(),
        initialStatus,
      }),
    );

    expect(html).toContain('Reconnect a provider to use Web Search.');
    expect(html).not.toContain('Active for new chat and voice turns');
  });
});
