/**
 * ============================================================================
 * FILE: PersonalizationPanel.tsx
 * LOCATION: frontend/src/features/personalization/PersonalizationPanel.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render the user Personalization tab panel inside Manage Aurvin.
 *
 * ROLE IN PROJECT:
 *    Connects Warmth/Enthusiasm/Emoji sliders, Custom Instructions editor,
 *    revision-fenced Save/Discard/Reset flows, and unsaved/busy callbacks to
 *    AdminDashboard for both standard Users and Super Admins.
 *
 * KEY COMPONENTS:
 *    - PersonalizationPanel: Stateful settings card + ConfirmDialog reset guard.
 * ============================================================================
 */

import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import {
  createPersonalizationClient,
  PersonalizationClientError,
  type PersonalizationClient,
} from '../../api/personalization-client.ts';
import { type UserMemoryClient } from '../../api/user-memory-client.ts';
import {
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  normalizeCustomInstructions,
  normalizeSavedLocation,
} from '../../api/personalization-protocol.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import {
  BrowserGeolocationError,
  requestBrowserCoordinates,
  type BrowserCoordinates,
} from './browser-geolocation.ts';
import { EmotionSlider } from './EmotionSlider.tsx';
import { LocationCard } from './LocationCard.tsx';
import { MemoryCard } from './MemoryCard.tsx';
import { MemoryView } from '../memory/MemoryView.tsx';
import { memoryViewEnabled } from '../memory/memory-state.ts';
import {
  canResetToDefaults,
  clientInstructionsValidationError,
  clientLocationValidationError,
  clientValidationError,
  describeFieldError,
  initialPersonalizationState,
  isPersonalizationDirty,
  personalizationReducer,
} from './personalization-state.ts';
import './personalization.css';

export type PersonalizationPanelProps = {
  client?: PersonalizationClient;
  userMemoryClient?: UserMemoryClient;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  detectCoordinates?: () => Promise<BrowserCoordinates>;
};

const defaultClient = createPersonalizationClient();
const INSTRUCTIONS_PLACEHOLDER =
  'e.g., Keep answers structured with short bullet points, avoid jargon, or explain complex topics with concise examples...';

export function PersonalizationPanel({
  client = defaultClient,
  userMemoryClient,
  disabled = false,
  onDirtyChange,
  onBusyChange,
  detectCoordinates,
}: PersonalizationPanelProps) {
  const ids = useId();
  const [state, dispatch] = useReducer(personalizationReducer, undefined, initialPersonalizationState);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const requestEpoch = useRef(0);
  const detectAbortRef = useRef<AbortController | null>(null);

  const dirty = isPersonalizationDirty(state);
  const busy = state.busy !== null;
  const resettable = canResetToDefaults(state);
  const validationProblem =
    state.phase === 'ready' ? clientValidationError(state.draft) : null;
  const instructionValidationProblem =
    state.phase === 'ready'
      ? clientInstructionsValidationError(state.draft.customInstructions)
      : null;
  const locationValidationProblem =
    state.phase === 'ready' ? clientLocationValidationError(state.draft.location) : null;
  const serverInstructionError = state.fieldErrors.find(
    item => item.path === 'customInstructions',
  );
  const serverLocationError = state.fieldErrors.find(
    item => item.path === 'location' || item.path.startsWith('location.'),
  );
  const effectiveInstructionError =
    instructionValidationProblem ??
    (serverInstructionError ? describeFieldError(serverInstructionError) : null);
  const effectiveLocationError =
    locationValidationProblem ??
    state.locationError ??
    (serverLocationError ? describeFieldError(serverLocationError) : null);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onBusyChange?.(busy || memoryBusy);
  }, [busy, memoryBusy, onBusyChange]);

  const loadSettings = useCallback(() => {
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
          error instanceof PersonalizationClientError && error.code === 'NOT_READY'
            ? 'Personalization storage is unavailable right now.'
            : 'Personalization settings could not be loaded.';
        dispatch({ type: 'loadFailed', message });
      });
    return () => {
      abort.abort();
      requestEpoch.current += 1;
    };
  }, [client]);

  useEffect(() => loadSettings(), [loadSettings]);

  useEffect(() => () => detectAbortRef.current?.abort(), []);

  const handleSave = async () => {
    if (
      disabled ||
      state.phase !== 'ready' ||
      busy ||
      !dirty ||
      validationProblem !== null ||
      state.conflictRevision !== null
    ) {
      return;
    }
    const epoch = ++requestEpoch.current;
    dispatch({ type: 'begin', kind: 'saving' });
    try {
      const response = await client.save({
        protocolVersion: 1,
        expectedRevision: state.revision,
        settings: {
          warmth: state.draft.warmth,
          enthusiasm: state.draft.enthusiasm,
          emoji: state.draft.emoji,
          customInstructions: normalizeCustomInstructions(state.draft.customInstructions),
          location: normalizeSavedLocation(state.draft.location),
        },
      });
      if (epoch !== requestEpoch.current) return;
      dispatch({
        type: 'loaded',
        response,
        statusMessage: 'Saved. New turns will use your updated personalization.',
      });
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      if (error instanceof PersonalizationClientError) {
        dispatch({
          type: 'failed',
          code: error.code,
          message:
            error.code === 'PERSONALIZATION_CONFLICT'
              ? 'Personalization was updated in another session. Reload to get the latest settings.'
              : error.message,
          currentRevision: error.currentRevision,
          fieldErrors: error.fieldErrors,
        });
      } else {
        dispatch({
          type: 'failed',
          message: 'Personalization settings could not be saved.',
        });
      }
    }
  };

  const handleDetectLocation = async () => {
    if (disabled || state.phase !== 'ready' || busy || state.conflictRevision !== null) {
      return;
    }
    const epoch = ++requestEpoch.current;
    detectAbortRef.current?.abort();
    const abort = new AbortController();
    detectAbortRef.current = abort;
    dispatch({ type: 'begin', kind: 'detecting' });
    try {
      const coords = detectCoordinates
        ? await detectCoordinates()
        : await requestBrowserCoordinates(
            typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
          );
      if (epoch !== requestEpoch.current || abort.signal.aborted) return;
      const response = await client.reverseGeocode(
        {
          protocolVersion: 1,
          latitude: coords.latitude,
          longitude: coords.longitude,
        },
        abort.signal,
      );
      if (epoch !== requestEpoch.current || abort.signal.aborted) return;
      dispatch({
        type: 'locationDetected',
        location: response.location,
        statusMessage: 'Location detected. Review and click Save to keep it.',
      });
    } catch (error) {
      if (epoch !== requestEpoch.current || abort.signal.aborted) return;
      if (error instanceof BrowserGeolocationError) {
        dispatch({ type: 'detectLocationFailed', message: error.message });
      } else if (error instanceof PersonalizationClientError) {
        dispatch({
          type: 'detectLocationFailed',
          message:
            error.code === 'LOCATION_UNAVAILABLE'
              ? error.message
              : 'Location could not be determined right now. You can enter your city manually.',
        });
      } else {
        dispatch({
          type: 'detectLocationFailed',
          message: 'Location could not be detected. Enter your city manually.',
        });
      }
    } finally {
      if (detectAbortRef.current === abort) {
        detectAbortRef.current = null;
      }
    }
  };

  const executeReset = async () => {
    setConfirmResetOpen(false);
    if (disabled || state.phase !== 'ready' || busy || state.conflictRevision !== null) return;
    const epoch = ++requestEpoch.current;
    dispatch({ type: 'begin', kind: 'resetting' });
    try {
      const response = await client.reset({
        protocolVersion: 1,
        expectedRevision: state.revision,
      });
      if (epoch !== requestEpoch.current) return;
      dispatch({
        type: 'loaded',
        response,
        statusMessage: 'Personalization reset to defaults.',
      });
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      if (error instanceof PersonalizationClientError) {
        dispatch({
          type: 'failed',
          code: error.code,
          message:
            error.code === 'PERSONALIZATION_CONFLICT'
              ? 'Personalization was updated in another session. Reload to get the latest settings.'
              : error.message,
          currentRevision: error.currentRevision,
          fieldErrors: error.fieldErrors,
        });
      } else {
        dispatch({
          type: 'failed',
          message: 'Personalization settings could not be reset.',
        });
      }
    }
  };

  const charCount = state.draft.customInstructions.length;
  const nearLimit = charCount >= 1300 && charCount <= MAX_CUSTOM_INSTRUCTIONS_CHARS;
  const overLimit = charCount > MAX_CUSTOM_INSTRUCTIONS_CHARS;
  const controlsLocked = disabled || busy || state.conflictRevision !== null;

  return (
    <section className="aurvin-personalization" aria-label="Personalization settings">
      <header className="aurvin-personalization-intro">
        <div>
          <h2 className="aurvin-personalization-heading">Personalization</h2>
          <p className="aurvin-personalization-subtitle">
            Tailor how Aurvin communicates with you across future text and voice conversations.
          </p>
        </div>
        {state.phase === 'ready' && state.revision > 0 ? (
          <span className="aurvin-personalization-rev">Revision {state.revision}</span>
        ) : null}
      </header>

      {state.phase === 'loading' ? (
        <div className="aurvin-personalization-loading" role="status">
          Loading personalization settings…
        </div>
      ) : null}

      {state.phase === 'unavailable' ? (
        <div className="aurvin-personalization-alert is-error" role="alert">
          <p>{state.errorMessage ?? 'Personalization storage is unavailable.'}</p>
          <button
            type="button"
            className="aurvin-personalization-btn"
            onClick={() => loadSettings()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.phase === 'ready' ? (
        <>
          {state.conflictRevision !== null ? (
            <div className="aurvin-personalization-alert is-warning" role="alert">
              <p>{state.errorMessage}</p>
              <button
                type="button"
                className="aurvin-personalization-btn"
                onClick={() => loadSettings()}
              >
                Reload settings
              </button>
            </div>
          ) : state.errorMessage ? (
            <div className="aurvin-personalization-alert is-error" role="alert">
              <p>{state.errorMessage}</p>
            </div>
          ) : null}

          <div className="aurvin-personalization-card">
            <h3 className="aurvin-personalization-card-title">Tone &amp; expression</h3>
            <div className="aurvin-personalization-sliders">
              <EmotionSlider
                id={`${ids}-warmth`}
                label="Warmth"
                description="Kind, approachable, and supportive tone"
                value={state.draft.warmth}
                disabled={controlsLocked}
                onChange={next => dispatch({ type: 'setAmplitude', field: 'warmth', value: next })}
              />
              <EmotionSlider
                id={`${ids}-enthusiasm`}
                label="Enthusiasm"
                description="Energy and excitement in responses"
                value={state.draft.enthusiasm}
                disabled={controlsLocked}
                onChange={next =>
                  dispatch({ type: 'setAmplitude', field: 'enthusiasm', value: next })
                }
              />
              <EmotionSlider
                id={`${ids}-emoji`}
                label="Emoji"
                description="Emoji frequency in text responses (voice mode stays speech-clean)"
                value={state.draft.emoji}
                disabled={controlsLocked}
                onChange={next => dispatch({ type: 'setAmplitude', field: 'emoji', value: next })}
              />
            </div>
          </div>

          <div className="aurvin-personalization-card">
            <div className="aurvin-personalization-field-top">
              <label
                htmlFor={`${ids}-custom-instructions`}
                className="aurvin-personalization-card-title"
              >
                Custom instructions
              </label>
              <span
                className={`aurvin-personalization-counter${
                  overLimit ? ' is-over' : nearLimit ? ' is-near' : ''
                }`}
                aria-live="polite"
              >
                {charCount} / {MAX_CUSTOM_INSTRUCTIONS_CHARS}
              </span>
            </div>
            <p id={`${ids}-instructions-help`} className="aurvin-personalization-help">
              Applies as preference guidance alongside system rules. Avoid secrets, API keys, or
              sensitive credentials.
            </p>
            <textarea
              id={`${ids}-custom-instructions`}
              className="aurvin-personalization-textarea"
              rows={5}
              value={state.draft.customInstructions}
              disabled={controlsLocked}
              placeholder={INSTRUCTIONS_PLACEHOLDER}
              aria-describedby={
                effectiveInstructionError
                  ? `${ids}-instructions-help ${ids}-instructions-error`
                  : `${ids}-instructions-help`
              }
              aria-invalid={effectiveInstructionError ? 'true' : undefined}
              onChange={event =>
                dispatch({ type: 'setCustomInstructions', value: event.target.value })
              }
            />
            {effectiveInstructionError ? (
              <p
                id={`${ids}-instructions-error`}
                className="aurvin-personalization-field-error"
                role="alert"
              >
                {effectiveInstructionError}
              </p>
            ) : null}
          </div>

          <LocationCard
            idPrefix={ids}
            location={state.draft.location}
            disabled={controlsLocked}
            detecting={state.busy === 'detecting'}
            error={effectiveLocationError}
            onFieldChange={(field, value) =>
              dispatch({ type: 'setLocationField', field, value })
            }
            onDetect={() => {
              void handleDetectLocation();
            }}
            onClear={() => dispatch({ type: 'clearLocation' })}
          />

          <div className="aurvin-personalization-actions">
            <div className="aurvin-personalization-status" aria-live="polite">
              {state.statusMessage ? (
                <p role="status">{state.statusMessage}</p>
              ) : dirty ? (
                <p className="is-dirty">Unsaved personalization changes</p>
              ) : null}
            </div>

            <div className="aurvin-personalization-buttons">
              <button
                type="button"
                className="aurvin-personalization-btn"
                disabled={!resettable || disabled}
                onClick={() => setConfirmResetOpen(true)}
              >
                Reset to defaults
              </button>
              <button
                type="button"
                className="aurvin-personalization-btn"
                disabled={!dirty || controlsLocked}
                onClick={() => dispatch({ type: 'discard' })}
              >
                Discard
              </button>
              <button
                type="button"
                className="aurvin-personalization-save"
                disabled={
                  !dirty ||
                  controlsLocked ||
                  validationProblem !== null
                }
                onClick={() => {
                  void handleSave();
                }}
              >
                {state.busy === 'saving' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {memoryViewEnabled() ? (
        <MemoryView client={userMemoryClient} disabled={disabled} onBusyChange={setMemoryBusy} />
      ) : (
        <MemoryCard client={userMemoryClient} disabled={disabled} onBusyChange={setMemoryBusy} />
      )}

      <ConfirmDialog
        open={confirmResetOpen}
        title="Reset personalization to defaults?"
        message="This will reset Warmth, Enthusiasm, Emoji, Custom instructions, and Location back to their defaults for future turns."
        confirmLabel="Reset to defaults"
        cancelLabel="Cancel"
        variant="danger"
        busy={state.busy === 'resetting'}
        onConfirm={() => {
          void executeReset();
        }}
        onCancel={() => setConfirmResetOpen(false)}
      />
    </section>
  );
}
