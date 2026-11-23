/**
 * ============================================================================
 * FILE: WebSearchPanel.tsx
 * LOCATION: frontend/src/features/plugins/web-search/WebSearchPanel.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render Web Search plugin account settings and five ordered provider cards.
 *
 * ROLE IN PROJECT:
 *    Lets users and admins connect, replace, disconnect, or authorize supported
 *    web-search providers in fixed fallback priority and control the global
 *    default-off web-search toggle without persisting keys in the browser.
 *
 * KEY COMPONENTS:
 *    - WebSearchPanel: Container managing bounded async actions and OAuth finish.
 *    - ProviderCard: Local ephemeral masked key input, verified console link,
 *      state badge, Connect/Replace/Disconnect, and a capability-gated account
 *      action that offers Connect for supported and a real support check for
 *      unverified browser authorization.
 * ============================================================================
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  WEB_SEARCH_PROVIDER_CATALOG,
  type WebSearchOAuthCallbackResult,
  type WebSearchOAuthOutcome,
  type WebSearchProvider,
  type WebSearchProviderCatalogEntry,
  type WebSearchPublicProvider,
  type WebSearchPublicStatus,
} from '../../../api/web-search-protocol.ts';
import { WebSearchClientError, type WebSearchClient } from '../../../api/web-search-client.ts';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import {
  canToggleWebSearchEnabled,
  createInitialWebSearchSetupState,
  describeOAuthOutcome,
  describeWebConnectionState,
  mapWebClientError,
  webSearchSetupReducer,
} from './web-search-setup-state.ts';
import './web-search-plugin.css';

export type WebSearchPanelProps = {
  client: WebSearchClient;
  initialStatus?: WebSearchPublicStatus;
  initialOAuthCallback?: WebSearchOAuthCallbackResult | null;
  oauthOutcome?: WebSearchOAuthOutcome | null;
  onDismissOAuthOutcome?: () => void;
  onConsumeOAuthCallback?: () => void;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  onNavigateUrl?: (url: string) => void;
};

type ProviderCardProps = {
  catalog: WebSearchProviderCatalogEntry;
  providerState: WebSearchPublicProvider;
  disabled: boolean;
  editing: boolean;
  pendingKind: 'connect' | 'replace' | 'disconnect' | 'oauth-start' | 'oauth-complete' | null;
  onConnectKey: (provider: WebSearchProvider, candidate: string, replace: boolean) => Promise<boolean>;
  onOpenReplace: (provider: WebSearchProvider) => void;
  onCloseReplace: () => void;
  onRequestDisconnect: (provider: WebSearchProvider) => void;
  onStartOAuth: (provider: WebSearchProvider) => Promise<void>;
};

function ProviderCard({
  catalog,
  providerState,
  disabled,
  editing,
  pendingKind,
  onConnectKey,
  onOpenReplace,
  onCloseReplace,
  onRequestDisconnect,
  onStartOAuth,
}: ProviderCardProps) {
  const [candidate, setCandidate] = useState('');
  const inputId = `web-search-key-${catalog.provider}`;
  const helpId = `${inputId}-help`;
  const isConnected = providerState.state === 'connected';
  const showDisconnectedConnectForm = providerState.state === 'not-connected' || providerState.state === 'unsupported';
  const showKeyInput =
    providerState.authSupport.apiKey !== 'unsupported' && (showDisconnectedConnectForm || editing);
  const canDisconnect = providerState.state !== 'not-connected';
  const effectiveState =
    pendingKind === 'connect' || pendingKind === 'replace' ? 'connecting' : providerState.state;
  const statusLabel = describeWebConnectionState(effectiveState);
  const canSubmitKey = candidate.trim().length > 0 && !disabled && pendingKind === null;

  useEffect(() => {
    return () => {
      setCandidate('');
    };
  }, []);

  const handleSubmit = async (replace: boolean) => {
    const raw = candidate;
    setCandidate('');
    const ok = await onConnectKey(catalog.provider, raw, replace);
    if (!ok) {
      // Do not repopulate candidate into DOM/memory after failed/aborted request.
    }
  };

  return (
    <article
      className="aurvin-web-provider-card"
      data-provider={catalog.provider}
      data-state={effectiveState}
      aria-labelledby={`web-search-title-${catalog.provider}`}
    >
      <div className="aurvin-web-provider-header">
        <div>
          <span className="aurvin-web-priority">Priority {catalog.priority}</span>
          <h4 id={`web-search-title-${catalog.provider}`} className="aurvin-web-provider-title">
            {catalog.displayName}
          </h4>
        </div>
        <span
          className={`aurvin-web-state-pill aurvin-web-state-${effectiveState}`}
          aria-live="polite"
        >
          {statusLabel}
        </span>
      </div>

      <p id={helpId} className="aurvin-admin-help">
        {catalog.keyInstructions}
      </p>
      {catalog.compatibilityNote ? (
        <p className="aurvin-web-compatibility-note">{catalog.compatibilityNote}</p>
      ) : null}

      <div className="aurvin-web-meta-row">
        <a
          className="aurvin-admin-button aurvin-web-console-link"
          href={catalog.consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {catalog.consoleLabel}
        </a>
        {isConnected ? (
          <span className="aurvin-web-capabilities">
            {providerState.capabilities.browse && providerState.capabilities.fetch
              ? 'Search & page fetch active'
              : providerState.capabilities.browse
                ? 'Search only (fetch unsupported)'
                : 'Page fetch only'}
          </span>
        ) : null}
        {providerState.lastValidatedAt ? (
          <span className="aurvin-web-validated">
            Validated {providerState.lastValidatedAt.slice(0, 10)}
          </span>
        ) : null}
      </div>

      {showKeyInput ? (
        <form
          className="aurvin-web-key-form"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmitKey) void handleSubmit(editing);
          }}
        >
          <label htmlFor={inputId}>{catalog.displayName} API key</label>
          <div className="aurvin-web-key-controls">
            <input
              id={inputId}
              name={`web-search-${catalog.provider}-key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={candidate}
              aria-describedby={helpId}
              disabled={disabled || pendingKind !== null}
              placeholder="Paste API key"
              onChange={(event) => setCandidate(event.target.value)}
            />
            <button
              type="submit"
              className="aurvin-admin-button aurvin-admin-button-primary"
              disabled={!canSubmitKey}
            >
              {pendingKind === 'connect' || pendingKind === 'replace'
                ? 'Connecting…'
                : editing
                  ? 'Save replacement'
                  : 'Connect'}
            </button>
            {editing ? (
              <button
                type="button"
                className="aurvin-admin-button"
                disabled={pendingKind !== null}
                onClick={() => {
                  setCandidate('');
                  onCloseReplace();
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      <div className="aurvin-web-card-actions">
        {!showDisconnectedConnectForm && !editing && providerState.authSupport.apiKey !== 'unsupported' ? (
          <button
            type="button"
            className="aurvin-admin-button"
            disabled={disabled || pendingKind !== null}
            onClick={() => onOpenReplace(catalog.provider)}
          >
            Replace
          </button>
        ) : null}

        {providerState.authSupport.browserAuthorization !== 'unsupported' ? (
          <button
            type="button"
            className="aurvin-admin-button"
            disabled={disabled || pendingKind !== null}
            onClick={() => {
              void onStartOAuth(catalog.provider);
            }}
          >
            {pendingKind === 'oauth-start' ? 'Starting…'
              : providerState.authSupport.browserAuthorization === 'supported'
                ? `Connect ${catalog.displayName} account`
                : `Check ${catalog.displayName} browser authorization support`}
          </button>
        ) : null}

        {canDisconnect ? (
          <button
            type="button"
            className="aurvin-admin-button aurvin-web-disconnect-btn"
            disabled={disabled || pendingKind !== null}
            onClick={() => onRequestDisconnect(catalog.provider)}
          >
            Disconnect
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function WebSearchPanel({
  client,
  initialStatus,
  initialOAuthCallback = null,
  oauthOutcome = null,
  onDismissOAuthOutcome,
  onConsumeOAuthCallback,
  disabled = false,
  onBusy,
  onNavigateUrl,
}: WebSearchPanelProps) {
  const [state, dispatch] = useReducer(
    webSearchSetupReducer,
    createInitialWebSearchSetupState(initialStatus, oauthOutcome),
  );
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const statusRef = useRef<WebSearchPublicStatus | null>(initialStatus ?? null);
  statusRef.current = state.status;

  useEffect(() => {
    onBusy?.(state.pending !== null);
  }, [onBusy, state.pending]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const loadStatus = useCallback(async (notice?: string | null) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestSeqRef.current;
    dispatch({ type: 'loading', requestId });
    try {
      const next = await client.status(controller.signal);
      dispatch({ type: 'loaded', requestId, status: next, notice });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message =
        error instanceof WebSearchClientError
          ? mapWebClientError(error.code)
          : 'Web search status could not be loaded.';
      dispatch({ type: 'unavailable', requestId, message });
    }
  }, [client]);

  useEffect(() => {
    if (initialOAuthCallback?.kind === 'complete-query') {
      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = ++requestSeqRef.current;
      dispatch({
        type: 'begin',
        requestId,
        pending: { kind: 'oauth-complete', provider: initialOAuthCallback.provider },
      });
      void client
        .completeOAuth(
          initialOAuthCallback.provider,
          { protocolVersion: 1, rawQuery: initialOAuthCallback.rawQuery },
          controller.signal,
        )
        .then((res) => {
          if (controller.signal.aborted) return;
          onConsumeOAuthCallback?.();
          return loadStatus(describeOAuthOutcome(res.outcome));
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          onConsumeOAuthCallback?.();
          const code = error instanceof WebSearchClientError ? error.code : 'WEB_HTTP_ERROR';
          dispatch({ type: 'failed', requestId, code, message: mapWebClientError(code) });
        });
      return () => {
        controller.abort();
      };
    }

    if (!initialStatus) {
      void loadStatus();
    }
    return undefined;
  }, [client, initialOAuthCallback, initialStatus, loadStatus, onConsumeOAuthCallback]);

  const handleToggleEnabled = async (nextEnabled: boolean) => {
    if (!statusRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestSeqRef.current;
    dispatch({ type: 'begin', requestId, pending: { kind: 'toggle' } });
    try {
      const next = await client.setEnabled(
        {
          protocolVersion: 1,
          expectedRevision: statusRef.current.revision,
          enabled: nextEnabled,
        },
        controller.signal,
      );
      dispatch({
        type: 'statusUpdated',
        requestId,
        status: next,
        notice: next.effectiveEnabled
          ? 'Web search enabled for new turns.'
          : 'Web search disabled.',
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof WebSearchClientError ? error.code : 'WEB_HTTP_ERROR';
      dispatch({ type: 'failed', requestId, code, message: mapWebClientError(code) });
    }
  };

  const handleConnectKey = async (
    provider: WebSearchProvider,
    candidate: string,
    replace: boolean,
  ): Promise<boolean> => {
    if (!statusRef.current) return false;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestSeqRef.current;
    dispatch({
      type: 'begin',
      requestId,
      pending: { kind: replace ? 'replace' : 'connect', provider },
    });
    try {
      const next = await client.connectProvider(
        provider,
        {
          protocolVersion: 1,
          expectedRevision: statusRef.current.revision,
          candidate: candidate.trim(),
        },
        controller.signal,
      );
      const label =
        WEB_SEARCH_PROVIDER_CATALOG.find((item) => item.provider === provider)?.displayName ?? provider;
      dispatch({
        type: 'statusUpdated',
        requestId,
        status: next,
        notice: `${label} key saved and validated.`,
      });
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      const code = error instanceof WebSearchClientError ? error.code : 'WEB_HTTP_ERROR';
      dispatch({ type: 'failed', requestId, code, message: mapWebClientError(code) });
      return false;
    }
  };

  const handleConfirmDisconnect = async () => {
    const provider = state.confirmDisconnectProvider;
    if (!provider || !statusRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestSeqRef.current;
    dispatch({ type: 'begin', requestId, pending: { kind: 'disconnect', provider } });
    try {
      const next = await client.disconnectProvider(
        provider,
        {
          protocolVersion: 1,
          expectedRevision: statusRef.current.revision,
          confirm: true,
        },
        controller.signal,
      );
      const label =
        WEB_SEARCH_PROVIDER_CATALOG.find((item) => item.provider === provider)?.displayName ?? provider;
      dispatch({
        type: 'statusUpdated',
        requestId,
        status: next,
        notice: `${label} disconnected.`,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof WebSearchClientError ? error.code : 'WEB_HTTP_ERROR';
      dispatch({ type: 'failed', requestId, code, message: mapWebClientError(code) });
    }
  };

  const handleStartOAuth = async (provider: WebSearchProvider) => {
    if (!statusRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestSeqRef.current;
    dispatch({ type: 'begin', requestId, pending: { kind: 'oauth-start', provider } });
    try {
      const response = await client.startOAuth(
        provider,
        {
          protocolVersion: 1,
          expectedRevision: statusRef.current.revision,
        },
        controller.signal,
      );
      if (onNavigateUrl) {
        onNavigateUrl(response.authorizationUrl);
      } else if (typeof window !== 'undefined') {
        window.location.assign(response.authorizationUrl);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof WebSearchClientError ? error.code : 'WEB_HTTP_ERROR';
      dispatch({ type: 'failed', requestId, code, message: mapWebClientError(code) });
    }
  };

  const mutationLocked = disabled || state.pending !== null || state.stale || state.uncertain;
  const hasConnected = Boolean(state.status?.providers.some((item) => item.state === 'connected'));
  const savedProviders = state.status?.providers.filter((item) => item.authMethod !== null) ?? [];
  const needsReconnect = savedProviders.length > 0
    && savedProviders.every((item) => item.state === 'invalid-key' || item.state === 'reconnect-required');
  const toggleDisabled = !canToggleWebSearchEnabled(state) || disabled;

  return (
    <section className="aurvin-web-plugin" aria-label="Web Search configuration">
      <div className="aurvin-web-disclosure">
        <p>
          When enabled, Aurvin may send search queries and requested page URLs to your highest-priority
          connected provider in order (TinyFish, Keenable, Exa, Tavily, Firecrawl). Fetched external web
          content is treated as untrusted data. Credentials remain encrypted on the server and are never
          stored or redisplayed in the browser.
        </p>
      </div>

      {state.error ? (
        <div className="aurvin-admin-status aurvin-admin-status-error" role="alert">
          <span>{state.error}</span>
          {(state.stale || state.uncertain || state.phase === 'unavailable') ? (
            <button
              type="button"
              className="aurvin-admin-button"
              disabled={state.pending !== null}
              onClick={() => {
                void loadStatus();
              }}
            >
              Reload status
            </button>
          ) : null}
        </div>
      ) : null}

      {state.notice ? (
        <div className="aurvin-admin-status aurvin-admin-status-saved" role="status" aria-live="polite">
          <span>{state.notice}</span>
          {oauthOutcome ? (
            <button
              type="button"
              className="aurvin-admin-button"
              onClick={() => {
                dispatch({ type: 'setOAuthOutcome', outcome: null });
                onDismissOAuthOutcome?.();
              }}
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}

      {state.phase === 'loading' && !state.status ? (
        <p className="aurvin-admin-status" role="status" aria-live="polite">
          Loading web search status…
        </p>
      ) : null}

      {state.status ? (
        <>
          <div className="aurvin-web-global-card">
            <label className="aurvin-admin-check" htmlFor="web-search-account-enabled">
              <input
                id="web-search-account-enabled"
                type="checkbox"
                checked={state.status.enabled}
                disabled={toggleDisabled}
                aria-describedby="web-search-account-enabled-help"
                onChange={(event) => {
                  void handleToggleEnabled(event.target.checked);
                }}
              />
              <span>Enable web search</span>
            </label>
            <p id="web-search-account-enabled-help" className="aurvin-admin-help">
              {state.status.enabled && needsReconnect
                ? 'Reconnect a provider to use Web Search.'
                : !hasConnected && !state.status.enabled
                  ? 'Connect at least one provider below before enabling web search.'
                  : state.status.effectiveEnabled
                    ? 'Active for new chat and voice turns (per-turn search and fetch budgets apply).'
                    : state.status.enabled
                      ? 'Web Search is temporarily unavailable.'
                      : 'Off by default until enabled here.'}
            </p>
          </div>

          <div className="aurvin-web-provider-list">
            {WEB_SEARCH_PROVIDER_CATALOG.map((catalog) => {
              const providerState =
                state.status!.providers.find((p) => p.provider === catalog.provider) ?? {
                  provider: catalog.provider,
                  state: 'not-connected' as const,
                  authMethod: null,
                  authSupport: { apiKey: 'unverified' as const, browserAuthorization: 'unverified' as const },
                  capabilities: { browse: false, fetch: false },
                  lastValidatedAt: null,
                };
              const pendingKind =
                state.pending && 'provider' in state.pending && state.pending.provider === catalog.provider
                  ? state.pending.kind
                  : null;
              return (
                <ProviderCard
                  key={catalog.provider}
                  catalog={catalog}
                  providerState={providerState}
                  disabled={mutationLocked}
                  editing={state.editingProvider === catalog.provider}
                  pendingKind={pendingKind}
                  onConnectKey={handleConnectKey}
                  onOpenReplace={(p) => dispatch({ type: 'openReplace', provider: p })}
                  onCloseReplace={() => dispatch({ type: 'closeReplace' })}
                  onRequestDisconnect={(p) => dispatch({ type: 'openDisconnect', provider: p })}
                  onStartOAuth={handleStartOAuth}
                />
              );
            })}
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={state.confirmDisconnectProvider !== null}
        title="Disconnect provider?"
        message="Remove this stored provider credential from your Aurvin account? Web search will skip this provider unless reconnected."
        confirmLabel="Disconnect"
        cancelLabel="Cancel"
        variant="danger"
        busy={state.pending?.kind === 'disconnect'}
        onConfirm={() => {
          void handleConfirmDisconnect();
        }}
        onCancel={() => dispatch({ type: 'closeDisconnect' })}
      />
    </section>
  );
}
