/**
 * ============================================================================
 * FILE: MemoryView.tsx
 * LOCATION: frontend/src/features/memory/MemoryView.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Memory inspection and editing: view sections, edit or clear one section,
 *    clear everything, natural-language composer, and change history.
 *
 * ROLE IN PROJECT:
 *    Release 5 replacement for MemoryCard behind FEATURE_FLAGS.memory. Server
 *    state reuses userMemoryReducer (revision CAS, conflict). A revision
 *    conflict from another tab keeps the draft, blocks saving, and offers
 *    reload-and-retry; nothing is ever overwritten silently. All memory text
 *    renders as plain text (no HTML injection).
 *
 * KEY COMPONENTS:
 *    - MemoryView: self-contained fetch / CAS view anchored at the memory element id
 *    - HistoryList: counts-only audit rows with gap notice
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
  USER_MEMORY_SECTION_KEYS,
  USER_MEMORY_SECTION_LABELS,
  userMemoryCharCount,
  type MemoryAuditView,
  type UserMemorySectionKey,
} from '../../api/user-memory-protocol.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { MEMORY_CARD_ELEMENT_ID } from '../personalization/MemoryCard.tsx';
import {
  canClearMemory,
  canSubmitMemoryEdit,
  clientComposerValidationError,
  initialUserMemoryState,
  memoryBudgetStatus,
  userMemoryReducer,
  type UserMemoryAction,
  type UserMemoryState,
} from '../personalization/user-memory-state.ts';
import {
  describeHistoryEntry,
  historyHasGap,
  newRequestId,
  sectionDraftChanged,
  sectionDraftError,
  sectionUsage,
} from './memory-state.ts';
import './memory.css';

export type MemoryHistoryState = {
  status: 'loading' | 'ready' | 'error';
  items: MemoryAuditView[];
  nextCursor: string | null;
};

export type MemoryViewProps = {
  client?: UserMemoryClient;
  disabled?: boolean;
  initialState?: UserMemoryState;
  initialHistory?: MemoryHistoryState;
  onBusyChange?: (busy: boolean) => void;
};

const defaultClient = createUserMemoryClient();
const CHATS_NOTE = 'Deleting memory does not delete your chats or what you said in earlier chats.';
const CONFLICT_MESSAGE = 'Memory changed in another tab. Reload to see the latest, then try again.';

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

export function MemoryView({
  client = defaultClient,
  disabled = false,
  initialState,
  initialHistory,
  onBusyChange,
}: MemoryViewProps) {
  const ids = useId();
  const [state, dispatch] = useReducer(
    userMemoryReducer,
    initialState,
    (provided?: UserMemoryState) => provided ?? initialUserMemoryState(),
  );
  const [history, setHistory] = useState<MemoryHistoryState>(
    initialHistory ?? { status: 'loading', items: [], nextCursor: null },
  );
  const [editing, setEditing] = useState<{ key: UserMemorySectionKey; draft: string } | null>(null);
  const [confirmClearKey, setConfirmClearKey] = useState<UserMemorySectionKey | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const requestEpoch = useRef(0);
  // One idempotency key per distinct change, reused when the same change is retried.
  const pendingRequest = useRef<{ signature: string; id: string } | null>(null);

  const busy = state.busy !== null;
  const locked = disabled || busy || state.conflictRevision !== null;
  const budget = memoryBudgetStatus(state.charCount, state.maxChars);
  const composerError = state.phase === 'ready' ? clientComposerValidationError(state.composerDraft) : null;
  const composerCount = userMemoryCharCount(state.composerDraft);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const loadHistory = useCallback(
    (cursor: string | null = null) => {
      setHistory(h => (cursor ? h : { status: 'loading', items: [], nextCursor: null }));
      client
        .history({ cursor })
        .then(page =>
          setHistory(h => ({
            status: 'ready',
            items: cursor ? [...h.items, ...page.items] : page.items,
            nextCursor: page.nextCursor,
          })),
        )
        // History is optional: a failure never affects the memory view itself.
        .catch(() => setHistory(h => ({ ...h, status: 'error' })));
    },
    [client],
  );

  const loadMemory = useCallback(() => {
    const epoch = ++requestEpoch.current;
    const abort = new AbortController();
    dispatch({ type: 'loading' });
    void client
      .read(abort.signal)
      .then(response => {
        if (epoch === requestEpoch.current) dispatch({ type: 'loaded', response });
      })
      .catch(error => {
        if (epoch !== requestEpoch.current) return;
        dispatch({
          type: 'loadFailed',
          message:
            error instanceof UserMemoryClientError && error.code === 'NOT_READY'
              ? 'Memory storage is unavailable right now.'
              : 'Memory could not be loaded.',
        });
      });
    return () => {
      abort.abort();
      requestEpoch.current += 1;
    };
  }, [client]);

  useEffect(() => {
    if (initialState) return undefined;
    const cancel = loadMemory();
    loadHistory();
    return cancel;
  }, [initialState, loadMemory, loadHistory]);

  /** Runs one mutation; the epoch guard drops results that arrive after a newer request. */
  const mutate = async (
    kind: 'toggling' | 'editing' | 'clearing',
    call: () => Promise<UserMemoryAction>,
    failure: string,
    after?: () => void,
  ) => {
    const epoch = ++requestEpoch.current;
    dispatch({ type: 'begin', kind });
    try {
      const action = await call();
      if (epoch !== requestEpoch.current) return;
      dispatch(action);
      after?.();
      loadHistory();
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      if (error instanceof UserMemoryClientError) {
        dispatch({
          type: 'failed',
          code: error.code,
          message: error.code === 'MEMORY_CONFLICT' ? CONFLICT_MESSAGE : error.message,
          currentRevision: error.currentRevision,
        });
      } else {
        dispatch({ type: 'failed', message: failure });
      }
    }
  };

  const changeSection = (key: UserMemorySectionKey, text: string, status: string) => {
    const signature = `${state.revision}\n${key}\n${text}`;
    // Same change retried after an unknown outcome keeps its id so the server can dedupe it.
    if (pendingRequest.current?.signature !== signature) {
      pendingRequest.current = { signature, id: newRequestId() };
    }
    const requestId = pendingRequest.current.id;
    return mutate(
      text === '' ? 'clearing' : 'editing',
      async () => ({
        type: 'loaded' as const,
        response: await client.editSection(key, {
          protocolVersion: 1,
          expectedRevision: state.revision,
          requestId,
          text,
        }),
        statusMessage: status,
      }),
      'Memory could not be updated.',
      () => {
        pendingRequest.current = null;
        setEditing(null);
        setConfirmClearKey(null);
      },
    );
  };

  const saveEditing = () => {
    if (!editing || locked) return;
    if (sectionDraftError(state.sections, editing.key, editing.draft) !== null) return;
    if (!sectionDraftChanged(state.sections, editing.key, editing.draft)) return;
    void changeSection(
      editing.key,
      editing.draft.replace(/\r\n?/g, '\n').trim(),
      `${USER_MEMORY_SECTION_LABELS[editing.key]} saved. Applies from your next message.`,
    );
  };

  const toggleEnabled = () => {
    if (locked || state.phase !== 'ready') return;
    const enabled = !state.enabled;
    void mutate(
      'toggling',
      async () => ({
        type: 'loaded' as const,
        response: await client.setEnabled({ protocolVersion: 1, expectedRevision: state.revision, enabled }),
        statusMessage: enabled ? 'Memory turned on.' : 'Memory paused. Saved details remain until you clear them.',
      }),
      'Memory setting could not be updated.',
    );
  };

  const applyComposer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !canSubmitMemoryEdit(state)) return;
    void mutate(
      'editing',
      async () => ({
        type: 'editSucceeded' as const,
        response: await client.edit({
          protocolVersion: 1,
          expectedRevision: state.revision,
          instruction: state.composerDraft,
        }),
      }),
      'Memory update could not be applied.',
    );
  };

  const clearAll = () => {
    setConfirmClearAll(false);
    if (disabled || !canClearMemory(state)) return;
    void mutate(
      'clearing',
      async () => ({
        type: 'loaded' as const,
        response: await client.clear({ protocolVersion: 1, expectedRevision: state.revision }),
        statusMessage: 'Memory cleared. Applies from your next message.',
      }),
      'Memory could not be cleared.',
    );
  };

  const editingError = editing ? sectionDraftError(state.sections, editing.key, editing.draft) : null;

  return (
    <section
      id={MEMORY_CARD_ELEMENT_ID}
      tabIndex={-1}
      className="aurvin-personalization-card aurvin-memory-card aurvin-memory-view"
      aria-labelledby={`${ids}-title`}
    >
      <div className="aurvin-memory-header">
        <div className="aurvin-memory-heading-group">
          <h3 id={`${ids}-title`} className="aurvin-personalization-card-title">
            Memory
          </h3>
          <p className="aurvin-memory-subtitle">
            What Aurvin remembers about you. Edits and deletions apply from your next message.
          </p>
        </div>
        {state.phase === 'ready' ? (
          <div className="aurvin-memory-toggle-wrap">
            <span id={`${ids}-enable`} className="aurvin-memory-toggle-label">
              Enable memory
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={state.enabled}
              aria-labelledby={`${ids}-enable`}
              className={`aurvin-memory-switch${state.enabled ? ' is-on' : ''}`}
              disabled={locked}
              onClick={toggleEnabled}
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
          <button type="button" className="aurvin-personalization-btn" onClick={() => loadMemory()}>
            Retry
          </button>
        </div>
      ) : null}

      {state.phase === 'ready' ? (
        <>
          {!state.enabled ? (
            <p className="aurvin-memory-paused-note">
              Memory is paused. Aurvin is not learning or using it, but saved details remain and you can
              still edit or clear them.
            </p>
          ) : null}

          {state.conflictRevision !== null ? (
            <div className="aurvin-personalization-alert is-warning" role="alert">
              <p>{state.errorMessage ?? CONFLICT_MESSAGE} Your draft is kept.</p>
              <button type="button" className="aurvin-personalization-btn" onClick={() => loadMemory()}>
                Reload memory
              </button>
            </div>
          ) : state.errorMessage ? (
            <div className="aurvin-personalization-alert is-error" role="alert">
              <p>{state.errorMessage}</p>
            </div>
          ) : null}

          {state.isEmpty ? (
            <p className="aurvin-memory-empty">
              Aurvin hasn&apos;t remembered anything yet. It will learn as you chat, or you can add details
              below.
            </p>
          ) : null}

          <ul className="aurvin-memory-sections aurvin-memory-section-list">
            {USER_MEMORY_SECTION_KEYS.map(key => {
              const text = state.sections[key];
              const isEditing = editing?.key === key;
              const label = USER_MEMORY_SECTION_LABELS[key];
              return (
                <li key={key} className="aurvin-memory-section" data-section={key}>
                  <div className="aurvin-memory-section-head">
                    <h4 className="aurvin-memory-section-label">{label}</h4>
                    <span className="aurvin-memory-section-count">{userMemoryCharCount(text)} chars</span>
                  </div>
                  {isEditing ? (
                    <div className="aurvin-memory-editor">
                      <label className="aurvin-memory-sr" htmlFor={`${ids}-${key}`}>
                        {label} text
                      </label>
                      <textarea
                        id={`${ids}-${key}`}
                        className="aurvin-personalization-input aurvin-memory-textarea"
                        rows={4}
                        value={editing.draft}
                        disabled={disabled || busy}
                        aria-invalid={editingError ? 'true' : undefined}
                        aria-describedby={`${ids}-${key}-count${editingError ? ` ${ids}-${key}-err` : ''}`}
                        onChange={event => setEditing({ key, draft: event.target.value })}
                      />
                      <div className="aurvin-memory-composer-footer">
                        <span
                          id={`${ids}-${key}-count`}
                          className={`aurvin-personalization-counter${editingError ? ' is-over' : ''}`}
                        >
                          {(() => {
                            const usage = sectionUsage(state.sections, key, editing.draft);
                            return `Total memory ${usage.used} / ${usage.max} chars`;
                          })()}
                        </span>
                      </div>
                      {editingError ? (
                        <p id={`${ids}-${key}-err`} className="aurvin-personalization-field-error" role="alert">
                          {editingError}
                        </p>
                      ) : null}
                      <div className="aurvin-memory-actions">
                        <button
                          type="button"
                          className="aurvin-personalization-save"
                          disabled={
                            locked || editingError !== null || !sectionDraftChanged(state.sections, key, editing.draft)
                          }
                          onClick={saveEditing}
                        >
                          {state.busy === 'editing' ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          className="aurvin-personalization-btn"
                          disabled={busy}
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className={`aurvin-memory-section-text${text ? '' : ' is-empty'}`}>
                        {text || 'Nothing saved.'}
                      </p>
                      {confirmClearKey === key ? (
                        <div className="aurvin-memory-inline-confirm" role="group" aria-label={`Clear ${label}`}>
                          <p>
                            Clear {label}? {CHATS_NOTE}
                          </p>
                          <div className="aurvin-memory-actions">
                            <button
                              type="button"
                              className="aurvin-personalization-btn is-danger"
                              disabled={locked}
                              onClick={() =>
                                void changeSection(key, '', `${label} cleared. Applies from your next message.`)
                              }
                            >
                              {state.busy === 'clearing' ? 'Clearing…' : `Clear ${label}`}
                            </button>
                            <button
                              type="button"
                              className="aurvin-personalization-btn"
                              disabled={busy}
                              onClick={() => setConfirmClearKey(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="aurvin-memory-actions">
                          <button
                            type="button"
                            className="aurvin-personalization-btn"
                            disabled={locked}
                            aria-label={`Edit ${label}`}
                            onClick={() => {
                              setConfirmClearKey(null);
                              setEditing({ key, draft: text });
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="aurvin-personalization-btn"
                            disabled={locked || text === ''}
                            aria-label={`Clear ${label}`}
                            onClick={() => {
                              setEditing(null);
                              setConfirmClearKey(key);
                            }}
                          >
                            Clear
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="aurvin-memory-meta-row">
            <div className="aurvin-memory-budget">
              <div className="aurvin-memory-budget-top">
                <span className="aurvin-memory-budget-label">
                  Memory capacity{state.updatedAt ? ` · updated ${formatWhen(state.updatedAt)}` : ''}
                </span>
                <span
                  className={`aurvin-personalization-counter${
                    budget.level === 'full' ? ' is-over' : budget.level === 'near' ? ' is-near' : ''
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
                <div className={`aurvin-memory-budget-fill is-${budget.level}`} style={{ width: `${budget.percent}%` }} />
              </div>
            </div>
            <button
              type="button"
              className="aurvin-personalization-btn"
              disabled={disabled || !canClearMemory(state)}
              onClick={() => setConfirmClearAll(true)}
            >
              Clear all memory
            </button>
          </div>

          <form className="aurvin-memory-composer" onSubmit={applyComposer}>
            <label htmlFor={`${ids}-composer`} className="aurvin-personalization-field-label">
              Update or forget something
            </label>
            <div className="aurvin-memory-composer-row">
              <input
                id={`${ids}-composer`}
                type="text"
                className="aurvin-personalization-input"
                value={state.composerDraft}
                disabled={locked}
                placeholder="e.g., My dog's name is Beans"
                aria-invalid={composerError ? 'true' : undefined}
                aria-describedby={composerError ? `${ids}-composer-err` : undefined}
                onChange={event => dispatch({ type: 'setComposerDraft', value: event.target.value })}
              />
              <button
                type="submit"
                className="aurvin-personalization-save"
                disabled={disabled || !canSubmitMemoryEdit(state)}
              >
                Update
              </button>
            </div>
            <div className="aurvin-memory-composer-footer">
              <p className="aurvin-memory-composer-help">
                Tell Aurvin in plain language what to remember or forget. Avoid secrets or API keys.
              </p>
              <span
                className={`aurvin-personalization-counter${
                  composerCount > USER_MEMORY_INSTRUCTION_MAX_CHARS ? ' is-over' : ''
                }`}
              >
                {composerCount} / {USER_MEMORY_INSTRUCTION_MAX_CHARS}
              </span>
            </div>
            {composerError ? (
              <p id={`${ids}-composer-err`} className="aurvin-personalization-field-error" role="alert">
                {composerError}
              </p>
            ) : null}
          </form>

          {state.statusMessage ? (
            <p className="aurvin-memory-status" role="status" aria-live="polite">
              {state.statusMessage}
            </p>
          ) : null}

          <HistoryList history={history} onMore={() => loadHistory(history.nextCursor)} onRetry={() => loadHistory()} />

          <p className="aurvin-memory-footnote">{CHATS_NOTE}</p>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmClearAll}
        title="Clear all memory?"
        message={`This permanently removes everything Aurvin remembers about you. It cannot be undone. ${CHATS_NOTE} Tone, Custom instructions, and Location are not changed.`}
        confirmLabel="Clear all memory"
        cancelLabel="Cancel"
        variant="danger"
        busy={state.busy === 'clearing'}
        busyLabel="Clearing…"
        onConfirm={clearAll}
        onCancel={() => setConfirmClearAll(false)}
      />
    </section>
  );
}

export function HistoryList({
  history,
  onMore,
  onRetry,
}: {
  history: MemoryHistoryState;
  onMore: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="aurvin-memory-history">
      <h4 className="aurvin-memory-section-label">Recent changes</h4>
      {history.status === 'loading' ? <p className="aurvin-memory-history-note">Loading history…</p> : null}
      {history.status === 'error' ? (
        <p className="aurvin-memory-history-note" role="status">
          History is unavailable right now.{' '}
          <button type="button" className="aurvin-personalization-btn" onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : null}
      {history.status === 'ready' && history.items.length === 0 ? (
        <p className="aurvin-memory-history-note">No changes recorded yet.</p>
      ) : null}
      {history.items.length > 0 ? (
        <>
          {historyHasGap(history.items) ? (
            <p className="aurvin-memory-history-note" role="status">
              Some history is unavailable.
            </p>
          ) : null}
          <ol className="aurvin-memory-history-list">
            {history.items.map(entry => {
              const row = describeHistoryEntry(entry);
              return (
                <li key={entry.memoryRevision} className="aurvin-memory-history-item">
                  <span className="aurvin-memory-history-title">{row.title}</span>
                  <span className="aurvin-memory-history-meta">
                    {formatWhen(entry.at)} · {row.source}
                    {row.sections ? ` · ${row.sections}` : ''} · {row.size}
                  </span>
                </li>
              );
            })}
          </ol>
          {history.nextCursor ? (
            <button type="button" className="aurvin-personalization-btn" onClick={onMore}>
              Show older changes
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
