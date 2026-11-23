/**
 * ============================================================================
 * FILE: web-search-client.test.ts
 * LOCATION: frontend/src/api/web-search-client.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify bounded HTTP client behavior, error mapping, and secret hygiene.
 *
 * ROLE IN PROJECT:
 *    Proves WebSearchClient validates outgoing/incoming contracts, enforces
 *    no-store/redirect-error options, and never leaks candidate keys in errors.
 *
 * KEY COMPONENTS:
 *    - createWebSearchClient: Status, enable/disable, connect, disconnect, OAuth.
 *    - WebSearchClientError: Closed non-secret error surface.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { createWebSearchClient, WebSearchClientError } from './web-search-client.ts';
import { WEB_SEARCH_PROVIDERS, type WebSearchPublicStatus } from './web-search-protocol.ts';

function statusFixture(revision = 1, enabled = false): WebSearchPublicStatus {
  const connectedProvider = revision > 1 ? 'exa' : null;
  return {
    protocolVersion: 1,
    revision,
    enabled,
    effectiveEnabled: enabled && connectedProvider !== null,
    providers: WEB_SEARCH_PROVIDERS.map((provider) => ({
      provider,
      state: provider === connectedProvider ? 'connected' : 'not-connected',
      authMethod: provider === connectedProvider ? 'api-key' : null,
      authSupport: { apiKey: 'supported', browserAuthorization: 'unsupported' },
      capabilities: { browse: provider === connectedProvider, fetch: provider === connectedProvider },
      lastValidatedAt: provider === connectedProvider ? '2026-11-14T00:00:00.000Z' : null,
    })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('web-search-client', () => {
  it('fetches status with no-store, same-origin, and redirect error', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(statusFixture(0, false)));
    const client = createWebSearchClient({ baseUrl: '/api', fetch: fetchMock });
    const status = await client.status();
    expect(status.revision).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/web-search/status',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        credentials: 'same-origin',
      }),
    );
  });

  it('rejects status payloads carrying extra secret properties', async () => {
    const leaked = { ...statusFixture(1, false), apiKey: 'raw-secret' };
    const client = createWebSearchClient({
      baseUrl: '/api',
      fetch: vi.fn(async () => jsonResponse(leaked)),
    });
    await expect(client.status()).rejects.toMatchObject({ code: 'INVALID_WEB_RESPONSE' });
  });

  it('validates requests locally and never reflects candidate keys on errors', async () => {
    const candidate = 'secret-provider-key-should-not-leak';
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          protocolVersion: 1,
          error: { code: 'WEB_INVALID_KEY', retryable: false, currentRevision: 1 },
        },
        422,
      ),
    );
    const client = createWebSearchClient({ baseUrl: '/api', fetch: fetchMock });

    await expect(
      client.connectProvider('exa', { protocolVersion: 1, expectedRevision: 0, candidate: ' bad key ' }),
    ).rejects.toMatchObject({ code: 'WEB_INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();

    let caught: unknown;
    try {
      await client.connectProvider('exa', { protocolVersion: 1, expectedRevision: 1, candidate });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WebSearchClientError);
    expect((caught as WebSearchClientError).code).toBe('WEB_INVALID_KEY');
    expect(JSON.stringify(caught)).not.toContain(candidate);
    expect((caught as Error).message).not.toContain(candidate);
  });

  it('handles settings, disconnect, oauth start, and oauth complete cleanly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(statusFixture(2, true)))
      .mockResolvedValueOnce(jsonResponse(statusFixture(3, false)))
      .mockResolvedValueOnce(
        jsonResponse({
          protocolVersion: 1,
          authorizationUrl: 'https://provider.example.com/auth?state=pub',
          expiresAt: '2026-11-14T00:10:00.000Z',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, outcome: 'connected' }));

    const client = createWebSearchClient({ baseUrl: '/api', fetch: fetchMock });

    const enabled = await client.setEnabled({ protocolVersion: 1, expectedRevision: 2, enabled: true });
    expect(enabled.effectiveEnabled).toBe(true);

    const disconnected = await client.disconnectProvider('exa', {
      protocolVersion: 1,
      expectedRevision: 2,
      confirm: true,
    });
    expect(disconnected.revision).toBe(3);

    const oauth = await client.startOAuth('tinyfish', { protocolVersion: 1, expectedRevision: 3 });
    expect(oauth.authorizationUrl).toBe('https://provider.example.com/auth?state=pub');

    const completed = await client.completeOAuth('tinyfish', {
      protocolVersion: 1,
      rawQuery: 'code=abc&state=pub',
    });
    expect(completed).toEqual({ protocolVersion: 1, outcome: 'connected' });
  });

  it('marks WEB_WRITE_UNCERTAIN as uncertain and respects oversized HTTP bodies', async () => {
    const uncertainClient = createWebSearchClient({
      baseUrl: '/api',
      fetch: vi.fn(async () =>
        jsonResponse(
          {
            protocolVersion: 1,
            error: { code: 'WEB_WRITE_UNCERTAIN', retryable: false, currentRevision: null },
          },
          503,
        ),
      ),
    });
    await expect(
      uncertainClient.setEnabled({ protocolVersion: 1, expectedRevision: 1, enabled: true }),
    ).rejects.toMatchObject({ code: 'WEB_WRITE_UNCERTAIN', uncertain: true });

    const hugeClient = createWebSearchClient({
      baseUrl: '/api',
      fetch: vi.fn(
        async () =>
          new Response('{"x":"' + 'a'.repeat(70_000) + '"}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    });
    await expect(hugeClient.status()).rejects.toMatchObject({ code: 'INVALID_WEB_RESPONSE' });
  });
});
