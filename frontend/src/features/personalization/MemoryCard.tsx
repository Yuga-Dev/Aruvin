/**
 * ============================================================================
 * FILE: MemoryCard.tsx
 * LOCATION: frontend/src/features/personalization/MemoryCard.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render the independent cross-session User Memory card inside Personalization.
 *
 * ROLE IN PROJECT:
 *    Exposes the master enable toggle, read-only categorized caveman summary,
 *    char budget meter, Claude-style natural-language composer, and danger
 *    ConfirmDialog clear-all with revision state isolated from Tone/Location.
 *
 * KEY COMPONENTS:
 *    - MemoryCard: Self-contained fetch/CAS card anchored at #aurvin-personalization-memory.
 * ============================================================================
 */

import { useCallback, useEffect, useId, useReducer, useRef, useState, type FormEvent } from 'react';
import {
  createUserMemoryClient,
  UserMemoryClientError,
  type UserMemoryClient,
} from '../../api/user-memory-client.ts';
import {
  USER_MEMORY_INSTRUCTION_MAX_CHARS,
  userMemoryCharCount,
} from '../../api/user-memory-protocol.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import {
  canClearMemory,
  canSubmitMemoryEdit,
  clientComposerValidationError,
  initialUserMemoryState,
  memoryBudgetStatus,
  nonEmptyMemorySections,
  userMemoryReducer,
  type UserMemoryState,
} from './user-memory-state.ts';

export const MEMORY_CARD_ELEMENT_ID = 'aurvin-personalization-memory';

export type MemoryCardProps = {
  client?: UserMemoryClient;
  disabled?: boolean;
  initialState?: UserMemoryState;
  onBusyChange?: (busy: boolean) => void;
};

const defaultMemoryClient = createUserMemoryClient();

function initState(provided?: UserMemoryState): UserMemoryState {
  return provided ?? initialUserMemoryState();
}

export function MemoryCard({
  client = defaultMemoryClient,
  disabled = false,
  initialState,
  onBusyChange,
}: MemoryCardProps) {
  const ids = useId();
  const [state, dispatch] = useReducer(userMemoryReducer, initialState, initState);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const requestEpoch = useRef(0);

  const busy = state.busy !== null;
  const controlsLocked = disabled || busy || state.conflictRevision !== null;
  const sections = nonEmptyMemorySections(state.sections);
  const budget = memoryBudgetStatus(state.charCount, state.maxChars);
  const composerError = state.phase === 'ready' ? clientComposerValidationError(state.composerDraft) : null;
  const composerCharCount = userMemoryCharCount(state.composerDraft);
  const canApply = !disabled && canSubmitMemoryEdit(state);
  const canClear = !disabled && canClearMemory(state);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const loadMemory = useCallback(() => {
    const epoch = ++requestEpoch.current;
    const abort = new AbortController();
    dispatch({ type: 'loading' });
    void client
      .read(abort.signal)
      .then(response => {
        if (epoch !== requestEpoch.current) return;
        dispatch({ type: 'loaded', response });
      })
      .catch(error => {
        if (epoch !== requestEpoch.current) return;
        const message =
          error instanceof UserMemoryClientError && error.code === 'NOT_READY'
            ? 'Memory storage is unavailable right now.'
            : 'Memory could not be loaded.';
        dispatch({ type: 'loadFailed', message });
      });
    return () => {
      abort.abort();
      requestEpoch.current += 1;
    };
  }, [client]);

  useEffect(() => {
    if (initialState) return undefined;
    return loadMemory();
  }, [initialState, loadMemory]);

  const handleToggleEnabled = async () => {
    if (controlsLocked || state.phase !== 'ready') return;
    const nextEnabled = !state.enabled;
    const epoch = ++requestEpoch.current;
    dispatch({ type: 'begin', kind: 'toggling' });
    try {
      const response = await client.setEnabled({
        protocolVersion: 1,
        expectedRevision: state.revision,
        enabled: nextEnabled,
      });
      if (epoch !== requestEpoch.current) return;
      dispatch({
        type: 'loaded',
        response,
        statusMessage: nextEnabled
          ? 'Memory enabled — applies to new chats.'
          : 'Memory paused. Saved details remain stored until you clear them.',
      });
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      if (error instanceof UserMemoryClientError) {
        dispatch({
          type: 'failed',
          code: error.code,
          message:
            error.code === 'MEMORY_CONFLICT'
              ? 'Memory was updated elsewhere. Reload to get the latest details.'
              : error.message,
          currentRevision: error.currentRevision,
        });
      } else {
        dispatch({ type: 'failed', message: 'Memory setting could not be updated.' });
      }
    }
  };

  const handleApplyEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canApply) return;
    const epoch = ++requestEpoch.current;
    dispatch({ type: 'begin', kind: 'editing' });
    try {
      const response = await client.edit({
        protocolVersion: 1,
        expectedRevision: state.revision,
        instruction: state.composerDraft,
      });
      if (epoch !== requestEpoch.current) return;
      dispatch({ type: 'editSucceeded', response });
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      if (error instanceof UserMemoryClientError) {
        dispatch({
          type: 'failed',
          code: error.code,
          message:
            error.code === 'MEMORY_CONFLICT'
              ? 'Memory was updated elsewhere. Reload to get the latest details.'
              : error.message,
          currentRevision: error.currentRevision,
        });
      } else {
        dispatch({ type: 'failed', message: 'Memory update could not be applied.' });
      }
    }
  };

  const executeClear = async () => {
    setConfirmClearOpen(false);
    if (!canClear) return;
    const epoch = ++requestEpoch.current;
    dispatch({ type: 'begin', kind: 'clearing' });
    try {
      const response = await client.clear({
        protocolVersion: 1,
        expectedRevision: state.revision,
      });
      if (epoch !== requestEpoch.current) return;
      dispatch({
        type: 'loaded',
        response,
        statusMessage: 'Memory cleared — applies to new chats.',
      });
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      if (error instanceof UserMemoryClientError) {
        dispatch({
          type: 'failed',
          code: error.code,
          message:
            error.code === 'MEMORY_CONFLICT'
              ? 'Memory was updated elsewhere. Reload to get the latest details.'
              : error.message,
          currentRevision: error.currentRevision,
        });
      } else {
        dispatch({ type: 'failed', message: 'Memory could not be cleared.' });
      }
    }
  };

  return (
    <section
      id={MEMORY_CARD_ELEMENT_ID}
      tabIndex={-1}
      className="aurvin-personalization-card aurvin-memory-card"
      aria-labelledby={`${ids}-memory-title`}
    >
      <div className="aurvin-memory-header">
        <div className="aurvin-memory-heading-group">
          <h3 id={`${ids}-memory-title`} className="aurvin-personalization-card-title">
            Memory
          </h3>
          <p className="aurvin-memory-subtitle">
            Aurvin learns concise personal details across chats and applies updates to new sessions.
          </p>
        </div>

        {state.phase === 'ready' ? (
          <div className="aurvin-memory-toggle-wrap">
            <span id={`${ids}-enable-label`} className="aurvin-memory-toggle-label">
              Enable memory
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={state.enabled}
              aria-labelledby={`${ids}-enable-label`}
              className={`aurvin-memory-switch${state.enabled ? ' is-on' : ''}`}
              disabled={controlsLocked}
              onClick={() => {
                void handleToggleEnabled();
              }}
            >
              <span className="aurvin-memory-switch-thumb" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>

      {state.phase === 'loading' ? (
        <div className="aurvin-memory-loading" role="status">
          Loading memory…
        </div>
      ) : null}

      {state.phase === 'unavailable' ? (
        <div className="aurvin-personalization-alert is-error" role="alert">
          <p>{state.errorMessage ?? 'Memory is unavailable right now.'}</p>
          <button
            type="button"
            className="aurvin-personalization-btn"
            onClick={() => loadMemory()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.phase === 'ready' ? (
        <>
          {!state.enabled ? (
            <p className="aurvin-memory-paused-note">
              Memory is paused. Automatic learning and memory injection into new chats are off, but
              your saved details remain stored and you can still edit or clear them below.
            </p>
          ) : null}

          {state.conflictRevision !== null ? (
            <div className="aurvin-personalization-alert is-warning" role="alert">
              <p>{state.errorMessage}</p>
              <button
                type="button"
                className="aurvin-personalization-btn"
                onClick={() => loadMemory()}
              >
                Reload memory
              </button>
            </div>
          ) : state.errorMessage ? (
            <div className="aurvin-personalization-alert is-error" role="alert">
              <p>{state.errorMessage}</p>
            </div>
          ) : null}

          {sections.length > 0 ? (
            <dl className="aurvin-memory-sections">
              {sections.map(item => (
                <div key={item.key} className="aurvin-memory-section">
                  <dt className="aurvin-memory-section-label">{item.label}</dt>
                  <dd className="aurvin-memory-section-text">{item.text}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="aurvin-memory-empty">
              Nothing remembered yet. Aurvin will learn as you chat, or tell it below.
            </p>
          )}

          <div className="aurvin-memory-meta-row">
            <div className="aurvin-memory-budget">
              <div className="aurvin-memory-budget-top">
                <span className="aurvin-memory-budget-label">Memory capacity</span>
                <span
                  className={`aurvin-personalization-counter${
                    budget.level === 'full'
                      ? ' is-over'
                      : budget.level === 'near'
                        ? ' is-near'
                        : ''
                  }`}
                >
                  {budget.label}
                </span>
              </div>
              <div
                className="aurvin-memory-budget-track"
                role="progressbar"
                aria-label="Memory character budget"
                aria-valuemin={0}
                aria-valuemax={state.maxChars}
                aria-valuenow={state.charCount}
              >
                <div
                  className={`aurvin-memory-budget-fill is-${budget.level}`}
                  style={{ width: `${budget.percent}%` }}
                />
              </div>
            </div>

            <button
              type="button"
              className="aurvin-personalization-btn"
              disabled={!canClear}
              onClick={() => setConfirmClearOpen(true)}
            >
              Clear memory
            </button>
          </div>

          <form
            className="aurvin-memory-composer"
            onSubmit={event => {
              void handleApplyEdit(event);
            }}
          >
            <label htmlFor={`${ids}-composer`} className="aurvin-personalization-field-label">
              Update or forget something
            </label>
            <div className="aurvin-memory-composer-row">
              <input
                id={`${ids}-composer`}
                type="text"
                className="aurvin-personalization-input"
                value={state.composerDraft}
                disabled={controlsLocked}
                placeholder="e.g., My dog's name is Beans"
                aria-invalid={composerError ? 'true' : undefined}
                aria-describedby={
                  composerError
                    ? `${ids}-composer-help ${ids}-composer-error`
                    : `${ids}-composer-help`
                }
                onChange={event =>
                  dispatch({ type: 'setComposerDraft', value: event.target.value })
                }
              />
              <button
                type="submit"
                className="aurvin-personalization-save"
                disabled={!canApply}
              >
                {state.busy === 'editing' ? 'Applying…' : 'Update'}
              </button>
            </div>
            <div className="aurvin-memory-composer-footer">
              <p id={`${ids}-composer-help`} className="aurvin-memory-composer-help">
                Tell Aurvin in plain language what to remember, update, or forget. Avoid secrets or
                API keys.
              </p>
              <span
                className={`aurvin-personalization-counter${
                  composerCharCount > USER_MEMORY_INSTRUCTION_MAX_CHARS ? ' is-over' : ''
                }`}
              >
                {composerCharCount} / {USER_MEMORY_INSTRUCTION_MAX_CHARS}
              </span>
            </div>
            {composerError ? (
              <p
                id={`${ids}-composer-error`}
                className="aurvin-personalization-field-error"
                role="alert"
              >
                {composerError}
              </p>
            ) : null}
            {state.statusMessage ? (
              <p className="aurvin-memory-status" role="status" aria-live="polite">
                {state.statusMessage}
              </p>
            ) : null}
          </form>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmClearOpen}
        title="Clear all memory?"
        message="This permanently removes all saved Memory details across future sessions. Your Tone, Custom instructions, and Location settings will not be changed."
        confirmLabel="Clear memory"
        cancelLabel="Cancel"
        variant="danger"
        busy={state.busy === 'clearing'}
        busyLabel="Clearing…"
        onConfirm={() => {
          void executeClear();
        }}
        onCancel={() => setConfirmClearOpen(false)}
      />
    </section>
  );
}
