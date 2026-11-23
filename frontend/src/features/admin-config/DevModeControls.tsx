/**
 * ============================================================================
 * FILE: DevModeControls.tsx
 * LOCATION: frontend/src/features/admin-config/DevModeControls.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Read and change the server-owned session mode from the Config page only.
 *
 * ROLE IN PROJECT:
 *    Gates the User/Dev selector on an active dev-mode GET and owns the
 *    mode PUT lifecycle, so draft settings and chat activation never reveal it.
 *
 * KEY COMPONENTS:
 *    - DevModeControls: GET lifecycle, busy coordination, and mode selector.
 *    - Abortable scope: Late responses from a replaced revision are ignored.
 * ============================================================================
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AdminConfigClientError, type AdminConfigClient } from '../../api/admin-config-client.ts';
import { isDevMode, type DevModeResponse } from '../../api/admin-config-protocol.ts';
import { errorCopy } from './config-edit-state.ts';

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
  | { phase: 'error'; message: string; denied: boolean };

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

export function DevModeControls({ client, disabled, enablementDirty, onBusy, children }: DevModeControlsProps) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [readAttempt, setReadAttempt] = useState(0);
  const scope = useRef<AbortController | null>(null);
  const writing = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    scope.current = abort;
    void client.readDevMode(abort.signal).then((value) => {
      if (!abort.signal.aborted) setState({ phase: 'ready', value });
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setState(failure(error));
    });
    return () => {
      abort.abort();
      scope.current = null;
      if (writing.current) {
        writing.current = false;
        onBusy(false);
      }
    };
  }, [client, onBusy, readAttempt]);

  const changeMode = (next: string) => {
    const signal = scope.current?.signal;
    if (!signal || signal.aborted || disabled || enablementDirty || writing.current
        || state.phase !== 'ready' || !state.value.enabled || next === state.value.mode || !isDevMode(next)) return;
    writing.current = true;
    onBusy(true);
    setState({ phase: 'saving', value: state.value });
    void client.setDevMode({ protocolVersion: 1, mode: next }, signal).then((value) => {
      if (!signal.aborted) setState({ phase: 'ready', value });
    }).catch((error: unknown) => {
      if (!signal.aborted) setState(failure(error));
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
      {state.phase !== 'error' || !state.denied ? children : null}
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
    </>
  );
}
