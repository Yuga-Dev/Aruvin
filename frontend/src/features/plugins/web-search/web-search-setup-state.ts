/**
 * ============================================================================
 * FILE: web-search-setup-state.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-setup-state.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Manage race-safe, non-optimistic reducer state for Web Search plugin setup.
 *
 * ROLE IN PROJECT:
 *    Coordinates status loads, global enable/disable toggle gating, provider
 *    connect/replace/disconnect lifecycles, OAuth outcome banners, and
 *    conflict/uncertain revision fencing without ever holding API key secrets.
 *
 * KEY COMPONENTS:
 *    - createInitialWebSearchSetupState / webSearchSetupReducer
 *    - canToggleWebSearchEnabled / describeWebConnectionState / mapWebClientError
 * ============================================================================
 */

import type { WebSearchClientErrorCode } from '../../../api/web-search-client.ts';
import type {
  WebSearchConnectionState,
  WebSearchOAuthOutcome,
  WebSearchProvider,
  WebSearchPublicStatus,
} from '../../../api/web-search-protocol.ts';

export type WebSearchPendingAction =
  | { kind: 'refresh' }
  | { kind: 'toggle' }
  | { kind: 'connect' | 'replace' | 'disconnect' | 'oauth-start' | 'oauth-complete'; provider: WebSearchProvider };

export type WebSearchSetupState = {
  phase: 'loading' | 'ready' | 'unavailable';
  status: WebSearchPublicStatus | null;
  pending: WebSearchPendingAction | null;
  editingProvider: WebSearchProvider | null;
  confirmDisconnectProvider: WebSearchProvider | null;
  error: string | null;
  notice: string | null;
  stale: boolean;
  uncertain: boolean;
  requestId: number;
  lastOAuthOutcome: WebSearchOAuthOutcome | null;
};

export type WebSearchSetupAction =
  | { type: 'loading'; requestId: number }
  | { type: 'loaded'; requestId: number; status: WebSearchPublicStatus; notice?: string | null }
  | { type: 'unavailable'; requestId: number; message: string }
  | { type: 'begin'; requestId: number; pending: WebSearchPendingAction }
  | { type: 'statusUpdated'; requestId: number; status: WebSearchPublicStatus; notice?: string | null }
  | { type: 'failed'; requestId: number; message: string; code?: WebSearchClientErrorCode }
  | { type: 'openReplace'; provider: WebSearchProvider }
  | { type: 'closeReplace' }
  | { type: 'openDisconnect'; provider: WebSearchProvider }
  | { type: 'closeDisconnect' }
  | { type: 'setOAuthOutcome'; outcome: WebSearchOAuthOutcome | null };

export function createInitialWebSearchSetupState(
  initialStatus?: WebSearchPublicStatus,
  initialOAuthOutcome?: WebSearchOAuthOutcome | null,
): WebSearchSetupState {
  return {
    phase: initialStatus ? 'ready' : 'loading',
    status: initialStatus ?? null,
    pending: null,
    editingProvider: null,
    confirmDisconnectProvider: null,
    error: null,
    notice: initialOAuthOutcome ? describeOAuthOutcome(initialOAuthOutcome) : null,
    stale: false,
    uncertain: false,
    requestId: 0,
    lastOAuthOutcome: initialOAuthOutcome ?? null,
  };
}

export function canToggleWebSearchEnabled(state: WebSearchSetupState): boolean {
  if (state.phase !== 'ready' || !state.status) return false;
  if (state.pending !== null || state.stale || state.uncertain) return false;
  return state.status.enabled || state.status.providers.some((item) => item.state === 'connected');
}

export function describeWebConnectionState(value: WebSearchConnectionState): string {
  switch (value) {
    case 'not-connected':
      return 'Not connected';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'invalid-key':
      return 'Invalid or expired key';
    case 'unavailable':
      return 'Temporarily unavailable';
    case 'reconnect-required':
      return 'Reconnect required';
    case 'unsupported':
      return 'Unsupported';
  }
}

export function describeOAuthOutcome(outcome: WebSearchOAuthOutcome): string {
  switch (outcome) {
    case 'connected':
      return 'Provider account connected.';
    case 'denied':
      return 'Browser authorization was cancelled or denied.';
    case 'expired':
      return 'Browser authorization expired. Start connection again.';
    case 'failed':
      return 'Browser authorization could not be completed.';
  }
}

export function mapWebClientError(code: WebSearchClientErrorCode): string {
  switch (code) {
    case 'WEB_INVALID_REQUEST':
      return 'Enter a valid credential without spaces or line breaks.';
    case 'WEB_INPUT_TOO_LARGE':
      return 'Credential exceeds the maximum allowed byte length.';
    case 'WEB_SETTINGS_CONFLICT':
      return 'Web search settings changed elsewhere. Reload status before saving again.';
    case 'WEB_CONNECTION_REQUIRED':
      return 'Connect at least one provider before enabling web search.';
    case 'WEB_INVALID_KEY':
      return 'The submitted key was rejected by the provider. Check the key and try again.';
    case 'WEB_AUTH_UNSUPPORTED':
      return 'This authentication mode is unsupported for the selected provider.';
    case 'WEB_CAPABILITY_UNSUPPORTED':
      return 'Provider does not expose a supported search or page-fetch capability.';
    case 'WEB_OAUTH_BINDING_MISMATCH':
    case 'WEB_OAUTH_STATE_INVALID':
      return 'Authorization session did not match this request. Start again.';
    case 'WEB_OAUTH_EXPIRED':
      return 'Authorization window expired before completion. Start again.';
    case 'WEB_RATE_LIMITED':
      return 'Provider rate limit reached. Wait briefly and try again.';
    case 'WEB_PROVIDER_UNAVAILABLE':
      return 'Provider service could not be reached. Connection remains unavailable right now.';
    case 'WEB_SETUP_TIMEOUT':
      return 'Connection check timed out. Reload status to confirm before retrying.';
    case 'WEB_STORAGE_UNAVAILABLE':
    case 'WEB_ENCRYPTION_UNAVAILABLE':
      return 'Server credential storage is temporarily unavailable.';
    case 'WEB_WRITE_UNCERTAIN':
      return 'Save outcome is unknown. Reload status before retrying.';
    case 'NETWORK_ERROR':
      return 'Could not reach the Aurvin backend. Check your connection and reload.';
    case 'ABORTED':
      return 'Request cancelled.';
    case 'INVALID_WEB_RESPONSE':
    case 'WEB_HTTP_ERROR':
      return 'Web search configuration could not be updated right now.';
  }
}

export function webSearchSetupReducer(
  state: WebSearchSetupState,
  action: WebSearchSetupAction,
): WebSearchSetupState {
  switch (action.type) {
    case 'loading':
      return {
        ...state,
        phase: state.status ? state.phase : 'loading',
        pending: { kind: 'refresh' },
        error: null,
        requestId: Math.max(state.requestId, action.requestId),
      };
    case 'loaded':
      if (action.requestId < state.requestId) return state;
      return {
        ...state,
        phase: 'ready',
        status: action.status,
        pending: null,
        editingProvider: null,
        confirmDisconnectProvider: null,
        error: null,
        notice: action.notice !== undefined ? action.notice : state.notice,
        stale: false,
        uncertain: false,
        requestId: action.requestId,
      };
    case 'unavailable':
      if (action.requestId < state.requestId) return state;
      return {
        ...state,
        phase: state.status ? state.phase : 'unavailable',
        pending: null,
        error: action.message,
        requestId: action.requestId,
      };
    case 'begin':
      if (action.requestId < state.requestId) return state;
      return {
        ...state,
        pending: action.pending,
        error: null,
        notice: null,
        requestId: action.requestId,
      };
    case 'statusUpdated':
      if (action.requestId < state.requestId) return state;
      return {
        ...state,
        phase: 'ready',
        status: action.status,
        pending: null,
        editingProvider: null,
        confirmDisconnectProvider: null,
        error: null,
        notice: action.notice ?? null,
        stale: false,
        uncertain: false,
        requestId: action.requestId,
      };
    case 'failed':
      if (action.requestId < state.requestId) return state;
      return {
        ...state,
        pending: null,
        confirmDisconnectProvider: null,
        error: action.message,
        stale: state.stale || action.code === 'WEB_SETTINGS_CONFLICT',
        uncertain: state.uncertain || action.code === 'WEB_WRITE_UNCERTAIN',
        requestId: action.requestId,
      };
    case 'openReplace':
      return { ...state, editingProvider: action.provider, error: null };
    case 'closeReplace':
      return { ...state, editingProvider: null };
    case 'openDisconnect':
      return { ...state, confirmDisconnectProvider: action.provider, error: null };
    case 'closeDisconnect':
      return { ...state, confirmDisconnectProvider: null };
    case 'setOAuthOutcome':
      return {
        ...state,
        lastOAuthOutcome: action.outcome,
        notice: action.outcome ? describeOAuthOutcome(action.outcome) : null,
      };
  }
}
