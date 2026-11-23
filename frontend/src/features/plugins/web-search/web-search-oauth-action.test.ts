/**
 * ============================================================================
 * FILE: web-search-oauth-action.test.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-oauth-action.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify unverified OAuth actions use the real client and safe error path.
 *
 * ROLE IN PROJECT:
 *    Node-only component-handler fixture proving rendered support-check wiring.
 *    It is not browser or live provider compatibility evidence.
 *
 * KEY COMPONENTS:
 *    - Hook stubs and rendered action traversal.
 *    - Closed fetch and real-client/reducer error projection.
 * ============================================================================
 */

import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createWebSearchClient } from '../../../api/web-search-client.ts';
import { WEB_SEARCH_PROVIDERS, type WebSearchPublicStatus } from '../../../api/web-search-protocol.ts';
import { WebSearchPanel } from './WebSearchPanel.tsx';
import {
  mapWebClientError, type WebSearchSetupAction, type WebSearchSetupState,
} from './web-search-setup-state.ts';

const hooks = vi.hoisted(() => ({ state: undefined as WebSearchSetupState | undefined }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: () => {},
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    useState: (value: unknown) => [value, vi.fn()],
    useReducer: (
      reducer: (state: WebSearchSetupState, action: WebSearchSetupAction) => WebSearchSetupState,
      initial: WebSearchSetupState,
    ) => {
      hooks.state ??= initial;
      return [hooks.state, (action: WebSearchSetupAction) => {
        hooks.state = reducer(hooks.state!, action);
      }];
    },
  };
});

type NodeProps = { children?: ReactNode; onClick?: () => void; disabled?: boolean };
function nodes(value: ReactNode): ReactElement<NodeProps>[] {
  if (!isValidElement<NodeProps>(value)) return [];
  if (typeof value.type === 'function') {
    // Only expand the local card; ConfirmDialog and other components are not under test.
    if (value.type.name !== 'ProviderCard') return [];
    return nodes((value.type as (props: unknown) => ReactNode)(value.props));
  }
  return [value, ...Children.toArray(value.props.children).flatMap(nodes)];
}
function initialStatus(): WebSearchPublicStatus {
  return {
    protocolVersion: 1, revision: 7, enabled: false, effectiveEnabled: false,
    providers: WEB_SEARCH_PROVIDERS.map(provider => ({
      provider, state: 'not-connected', authMethod: null,
      authSupport: { apiKey: 'supported', browserAuthorization: 'unverified' },
      capabilities: { browse: false, fetch: false }, lastValidatedAt: null,
    })),
  };
}
beforeEach(() => { hooks.state = undefined; });

it.each(['WEB_AUTH_UNSUPPORTED', 'WEB_PROVIDER_UNAVAILABLE'] as const)(
  'unverified support action calls oauth/start and displays real %s without changing support', async code => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      protocolVersion: 1, error: { code, retryable: code === 'WEB_PROVIDER_UNAVAILABLE', currentRevision: null },
    }, { status: code === 'WEB_AUTH_UNSUPPORTED' ? 422 : 502 }));
    const navigate = vi.fn();
    const client = createWebSearchClient({ fetch: fetcher });
    const tree = WebSearchPanel({ client, initialStatus: initialStatus(), onNavigateUrl: navigate });
    const button = nodes(tree).find(node =>
      node.type === 'button' && node.props.children === 'Check TinyFish browser authorization support');
    expect(button).toBeDefined();
    expect(button!.props.disabled).toBe(false);
    button!.props.onClick!();
    await vi.waitFor(() => { expect(hooks.state?.error).toBe(mapWebClientError(code)); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('/api/plugins/web-search/providers/tinyfish/oauth/start');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ protocolVersion: 1, expectedRevision: 7 });
    expect(hooks.state?.pending).toBeNull();
    expect(hooks.state?.status).toEqual(initialStatus());
    expect(navigate).not.toHaveBeenCalled();
    const rerendered = WebSearchPanel({ client, initialStatus: initialStatus(), onNavigateUrl: navigate });
    expect(nodes(rerendered).some(node => node.props.children === mapWebClientError(code))).toBe(true);
  },
);

it('unverified support action navigates only after actual successful oauth/start, without declaring support', async () => {
  const authorizationUrl = 'https://clerk.tinyfish.ai/oauth/authorize?state=fixture-state';
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({
    protocolVersion: 1, authorizationUrl, expiresAt: '2026-11-15T00:10:00.000Z',
  }));
  const navigate = vi.fn();
  const tree = WebSearchPanel({
    client: createWebSearchClient({ fetch: fetcher }),
    initialStatus: initialStatus(), onNavigateUrl: navigate,
  });
  const button = nodes(tree).find(node =>
    node.type === 'button' && node.props.children === 'Check TinyFish browser authorization support');
  expect(button).toBeDefined();
  expect(navigate).not.toHaveBeenCalled();
  button!.props.onClick!();
  await vi.waitFor(() => { expect(navigate).toHaveBeenCalledWith(authorizationUrl); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(hooks.state?.status).toEqual(initialStatus());
});
