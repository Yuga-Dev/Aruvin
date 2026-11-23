/**
 * ============================================================================
 * FILE: web-search-setup-state.test.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-setup-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify race-fenced setup reducer state, conflict locking, and zero-secret storage.
 *
 * ROLE IN PROJECT:
 *    Protects default-off enablement gating, pending provider transitions, and
 *    conflict/uncertain error handling for WebSearchPanel.
 *
 * KEY COMPONENTS:
 *    - createInitialWebSearchSetupState / webSearchSetupReducer
 *    - canToggleWebSearchEnabled / describeWebConnectionState
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { WEB_SEARCH_PROVIDERS, type WebSearchPublicStatus } from '../../../api/web-search-protocol.ts';
import {
  canToggleWebSearchEnabled,
  createInitialWebSearchSetupState,
  describeWebConnectionState,
  webSearchSetupReducer,
} from './web-search-setup-state.ts';

function status(patch: Partial<WebSearchPublicStatus> = {}): WebSearchPublicStatus {
  return {
    protocolVersion: 1,
    revision: 1,
    enabled: false,
    effectiveEnabled: false,
    providers: WEB_SEARCH_PROVIDERS.map((provider) => ({
      provider,
      state: 'not-connected',
      authMethod: null,
      authSupport: { apiKey: 'supported', browserAuthorization: 'unsupported' },
      capabilities: { browse: false, fetch: false },
      lastValidatedAt: null,
    })),
    ...patch,
  };
}

describe('web-search-setup-state', () => {
  it('blocks global toggle when no provider is connected or while conflict/uncertain locks apply', () => {
    const empty = createInitialWebSearchSetupState(status());
    expect(canToggleWebSearchEnabled(empty)).toBe(false);

    const connectedStatus = status({
      providers: status().providers.map((p) =>
        p.provider === 'exa'
          ? {
              ...p,
              state: 'connected',
              authMethod: 'api-key',
              capabilities: { browse: true, fetch: true },
              lastValidatedAt: '2026-11-14T00:00:00.000Z',
            }
          : p,
      ),
    });
    const ready = createInitialWebSearchSetupState(connectedStatus);
    expect(canToggleWebSearchEnabled(ready)).toBe(true);

    const enabledBroken = createInitialWebSearchSetupState(status({
      enabled: true,
      providers: status().providers.map((p) =>
        p.provider === 'exa'
          ? { ...p, state: 'invalid-key', authMethod: 'api-key', lastValidatedAt: '2026-11-14T00:00:00.000Z' }
          : p,
      ),
    }));
    expect(canToggleWebSearchEnabled(enabledBroken)).toBe(true);

    const conflicted = webSearchSetupReducer(ready, {
      type: 'failed',
      requestId: 1,
      message: 'Changed elsewhere',
      code: 'WEB_SETTINGS_CONFLICT',
    });
    expect(conflicted.stale).toBe(true);
    expect(canToggleWebSearchEnabled(conflicted)).toBe(false);

    const uncertain = webSearchSetupReducer(ready, {
      type: 'failed',
      requestId: 1,
      message: 'Unknown save',
      code: 'WEB_WRITE_UNCERTAIN',
    });
    expect(uncertain.uncertain).toBe(true);
    expect(canToggleWebSearchEnabled(uncertain)).toBe(false);
  });

  it('ignores stale request IDs and stores zero credential secrets in reducer state', () => {
    let state = createInitialWebSearchSetupState(status({ revision: 2 }));
    state = webSearchSetupReducer(state, {
      type: 'begin',
      requestId: 5,
      pending: { kind: 'connect', provider: 'exa' },
    });
    expect(state.pending).toEqual({ kind: 'connect', provider: 'exa' });

    const ignored = webSearchSetupReducer(state, {
      type: 'statusUpdated',
      requestId: 4,
      status: status({ revision: 3 }),
    });
    expect(ignored.status?.revision).toBe(2);
    expect(ignored.pending).toEqual({ kind: 'connect', provider: 'exa' });

    const applied = webSearchSetupReducer(state, {
      type: 'statusUpdated',
      requestId: 5,
      status: status({ revision: 3 }),
      notice: 'Exa updated.',
    });
    expect(applied.status?.revision).toBe(3);
    expect(applied.pending).toBeNull();
    expect(applied.notice).toBe('Exa updated.');
    expect(JSON.stringify(applied)).not.toContain('candidate');
  });

  it('provides accessible labels for every documented connection state', () => {
    for (const value of [
      'not-connected',
      'connecting',
      'connected',
      'invalid-key',
      'unavailable',
      'reconnect-required',
      'unsupported',
    ] as const) {
      expect(describeWebConnectionState(value).length).toBeGreaterThan(0);
    }
  });
});
