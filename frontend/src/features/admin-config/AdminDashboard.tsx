/**
 * ============================================================================
 * FILE: AdminDashboard.tsx
 * LOCATION: frontend/src/features/admin-config/AdminDashboard.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Load/save orchestration for the Config, Plugins, and empty Analytics dashboard.
 *
 * ROLE IN PROJECT:
 *    Owns admin page state, section/tab navigation, unsaved-exit guards, and
 *    post-save capability refresh without mounting a second chat provider.
 *
 * KEY COMPONENTS:
 *    - Config/Plugins/Analytics tabs and section navigation
 *    - Settings save with revision fencing and in-flight click guard
 * ============================================================================
 */

import { useCallback, useEffect, useId, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import type { AdminConfigClient } from '../../api/admin-config-client.ts';
import { AdminConfigClientError } from '../../api/admin-config-client.ts';
import { createAdministrationClient, type AdministrationClient } from '../../api/administration-client.ts';
import type {
  AdminConfigError,
  AdminConfigFieldPath,
  ModelCatalogueItem,
  ModelCompatibilityCode,
  ModelCompatibilityReport,
  ModelCompatibilityWarning,
  PublicAdminConfig,
  ReasoningEffort,
} from '../../api/admin-config-protocol.ts';
import type { AuthUser } from '../../api/auth-protocol.ts';
import { createCalendarClient, type CalendarClient } from '../../api/calendar-client.ts';
import type { PersonalizationClient } from '../../api/personalization-client.ts';
import type {
  CalendarOAuthCallbackOutcome,
  CalendarPublicStatus,
} from '../../api/calendar-protocol.ts';
import { createWebSearchClient, type WebSearchClient } from '../../api/web-search-client.ts';
import type {
  WebSearchOAuthCallbackResult,
  WebSearchOAuthOutcome,
  WebSearchPublicStatus,
} from '../../api/web-search-protocol.ts';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import { MEMORY_CARD_ELEMENT_ID } from '../personalization/MemoryCard.tsx';
import { PersonalizationPanel } from '../personalization/index.ts';
import { GoogleCalendarPanel } from '../plugins/google-calendar/index.ts';
import { WebSearchPanel } from '../plugins/web-search/WebSearchPanel.tsx';
import { AdministrationPanel } from './AdministrationPanel.tsx';
import { ConfigFields, fieldDomId } from './ConfigFields.tsx';
import { DevModeControls } from './DevModeControls.tsx';
import { ModelSelectionFields } from './ModelSelectionFields.tsx';
import { CredentialRow } from './CredentialRow.tsx';
import {
  compatibilityKey,
  createEditState,
  dirtyFields,
  editReducer,
  editableFields,
  errorCopy,
  fieldsFromSettings,
  hasMatchingCompatibility,
  navigationDecision,
  requiresCompatibilityCheck,
  saveLocked,
  settingsFromFields,
  type AdminSection,
  type AdminTab,
  type EditableField,
  type EditAction,
  type EditState,
} from './config-edit-state.ts';
import './admin-config.css';

export type PluginSection = 'calendar' | 'web-search';
export type PersonalizationSection = 'personalization';
export type DashboardSection = AdminSection | PluginSection | PersonalizationSection;

export type AdminDashboardProps = {
  client: AdminConfigClient;
  calendarClient?: CalendarClient;
  adminClient?: AdministrationClient;
  personalizationClient?: PersonalizationClient;
  webSearchClient?: WebSearchClient;
  user?: AuthUser | null;
  onBackToChat: () => void;
  refreshCapabilities: () => Promise<boolean>;
  chatActive?: boolean;
  initialSection?: DashboardSection;
  initialCalendarStatus?: CalendarPublicStatus | null;
  oauthOutcome?: CalendarOAuthCallbackOutcome | null;
  onDismissOAuthOutcome?: () => void;
  initialWebSearchStatus?: WebSearchPublicStatus;
  initialWebSearchOAuthCallback?: WebSearchOAuthCallbackResult | null;
  webSearchOAuthOutcome?: WebSearchOAuthOutcome | null;
  onDismissWebSearchOAuthOutcome?: () => void;
  onConsumeWebSearchOAuthCallback?: () => void;
  focusTarget?: 'memory' | null;
  onConsumeFocusTarget?: () => void;
};

const CONFIG_SECTIONS: { id: AdminSection; label: string }[] = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'chat', label: 'Chat limits' },
  { id: 'compaction', label: 'Compaction' },
  { id: 'voice', label: 'Voice' },
  { id: 'deepgram', label: 'Deepgram' },
  { id: 'webSearch', label: 'Web Search' },
  { id: 'devMode', label: 'Dev mode' },
];
const PLUGIN_SECTIONS: { id: PluginSection; label: string }[] = [
  { id: 'calendar', label: 'Google Calendar' },
  { id: 'web-search', label: 'Web Search' },
];
const SUPER_ADMIN_TABS: { id: AdminTab; label: string }[] = [
  { id: 'personalization', label: 'Personalization' },
  { id: 'config', label: 'Config' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'administration', label: 'Administration' },
];

const USER_TABS: { id: AdminTab; label: string }[] = [
  { id: 'personalization', label: 'Personalization' },
  { id: 'plugins', label: 'Plugins' },
];

function isPluginSection(id: DashboardSection): id is PluginSection {
  return id === 'calendar' || id === 'web-search';
}

function isPersonalizationSection(id: DashboardSection): id is PersonalizationSection {
  return id === 'personalization';
}

export function activationCopy(config: PublicAdminConfig): string {
  if (config.activation === 'active' && config.activeRevision === config.revision) {
    return 'Saved and active for new work';
  }
  if (config.activation === 'blocked') {
    return 'Saved. Activation is blocked. New work cannot use these settings yet.';
  }
  return 'Saved. Configuration is unconfigured until required keys are present.';
}

const COMPATIBILITY_STATUS_LABELS: Record<ModelCompatibilityReport['status'], string> = {
  'catalogue-compatible': 'Catalogue compatible',
  incompatible: 'Incompatible',
  'unable-to-verify': 'Unable to verify',
};

const BLOCKER_COPY: Record<ModelCompatibilityCode, string> = {
  MODEL_REQUIRED: 'Select an OpenRouter model before checking compatibility.',
  MODEL_NOT_LISTED: 'The selected model ID is not present in the current OpenRouter catalogue.',
  TEXT_CHAT_UNSUPPORTED: 'The model does not declare text input/output on /api/v1/chat/completions.',
  TEXT_CHAT_EVIDENCE_MISSING: 'Catalogue metadata is missing text chat applicability evidence.',
  CONTEXT_CAPACITY_MISSING: 'Catalogue metadata is missing a valid positive context length.',
  CONTEXT_CAPACITY_TOO_SMALL: 'Model context capacity is smaller than the configured Context tokens.',
  OUTPUT_CAPACITY_MISSING: 'Catalogue metadata is missing a valid positive output token capacity.',
  OUTPUT_CAPACITY_TOO_SMALL: 'Model output capacity is smaller than the configured Output tokens.',
  OUTPUT_CAP_UNSUPPORTED: 'Model does not declare support for max_tokens or max_completion_tokens.',
  OUTPUT_CAP_EVIDENCE_MISSING: 'Catalogue metadata is missing supported parameter declarations.',
  EFFORT_UNSUPPORTED: 'The selected thinking effort is not declared as supported for this model.',
  EFFORT_EVIDENCE_MISSING: 'Catalogue metadata is missing valid reasoning effort declarations.',
  REASONING_REQUIRED: 'This model requires reasoning and cannot disable it with None.',
  CONTEXT_FLOOR_NOT_MET: 'Configured Context tokens are below the server-computed context floor.',
  FIXED_CONTEXT_DOES_NOT_FIT: 'Fixed Aurvin instructions and knowledge exceed the configured context budget.',
  CATALOGUE_UNAVAILABLE: 'The OpenRouter model catalogue could not be reached.',
  CATALOGUE_RESPONSE_INVALID: 'The OpenRouter model catalogue response failed validation.',
};

const WARNING_COPY: Record<ModelCompatibilityWarning, string> = {
  PRIVACY_ROUTE_UNVERIFIED: 'Public catalogue metadata does not prove account-specific privacy route eligibility.',
  STREAMING_UNTESTED: 'Actual SSE streaming has not been tested by this catalogue check.',
  TOOL_BEHAVIOR_UNTESTED: 'Actual tool-calling behavior has not been tested by this catalogue check.',
  REASONING_CONTINUITY_UNTESTED: 'Reasoning continuity across tool rounds is untested.',
  REASONING_USES_OUTPUT_BUDGET: 'Reasoning consumes the finite output token budget and may reduce visible output.',
  CREDENTIAL_NOT_CONFIGURED: 'OpenRouter API key is not configured yet. Save or add a key before running chat.',
  CALENDAR_PRICE_UNVERIFIED: 'Calendar tool pricing could not be verified from the catalogue; Calendar tool use will be disabled.',
};

function fieldSection(path: string): AdminSection | null {
  return editableFields.find((field) => field.path === path)?.section ?? null;
}

function dashboardReducer(state: EditState | null, action: EditAction): EditState | null {
  if (!state) {
    if (action.type === 'loaded' || action.type === 'settingsSaved' || action.type === 'credentialSaved') {
      return createEditState(action.config);
    }
    return state;
  }
  return editReducer(state, action);
}

// oxlint-disable-next-line react/only-export-components -- pure focus helper shared with tests
export function focusMemoryCardElement(
  doc: Pick<Document, 'getElementById'> | null = typeof document !== 'undefined' ? document : null,
): boolean {
  const node = doc?.getElementById(MEMORY_CARD_ELEMENT_ID);
  if (!node) return false;
  node.scrollIntoView?.({ block: 'center' });
  node.focus?.();
  return true;
}

export function AdminDashboard({
  client,
  calendarClient,
  adminClient,
  personalizationClient,
  webSearchClient,
  user,
  onBackToChat,
  refreshCapabilities,
  chatActive = false,
  initialSection,
  initialCalendarStatus = null,
  oauthOutcome = null,
  onDismissOAuthOutcome,
  initialWebSearchStatus,
  initialWebSearchOAuthCallback = null,
  webSearchOAuthOutcome = null,
  onDismissWebSearchOAuthOutcome,
  onConsumeWebSearchOAuthCallback,
  focusTarget = null,
  onConsumeFocusTarget,
}: AdminDashboardProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const inflight = useRef(false);
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const modelsAbortRef = useRef<AbortController | null>(null);
  const modelsEpochRef = useRef(0);
  const checkAbortRef = useRef<AbortController | null>(null);
  const refreshEpoch = useRef(0);
  const isStandardUser = user?.role === 'user';
  const tabs = isStandardUser ? USER_TABS : SUPER_ADMIN_TABS;
  const [models, setModels] = useState<ModelCatalogueItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saveReport, setSaveReport] = useState<ModelCompatibilityReport | null>(null);
  const [, setExpiryTick] = useState(0);
  const [tab, setTab] = useState<AdminTab>(() => {
    if (initialSection && isPluginSection(initialSection)) return 'plugins';
    if (!isStandardUser && initialSection && !isPersonalizationSection(initialSection)) {
      return 'config';
    }
    return 'personalization';
  });
  const [section, setSection] = useState<AdminSection>(
    initialSection && !isPluginSection(initialSection) && !isPersonalizationSection(initialSection)
      ? initialSection
      : 'openrouter',
  );
  const [plugin, setPlugin] = useState<PluginSection>(
    initialSection && isPluginSection(initialSection) ? initialSection : 'calendar',
  );
  const [defaultCalendarClient] = useState(() => createCalendarClient());
  const [defaultAdministrationClient] = useState(() => createAdministrationClient());
  const [defaultWebSearchClient] = useState(() => createWebSearchClient());
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [webSearchBusy, setWebSearchBusy] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [devModeBusy, setDevModeBusy] = useState(false);
  const [devModeReload, setDevModeReload] = useState(0);
  const [personalizationDirty, setPersonalizationDirty] = useState(false);
  const [personalizationBusy, setPersonalizationBusy] = useState(false);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>(() =>
    isStandardUser ? 'ready' : 'loading',
  );
  const [confirmDialog, setConfirmDialog] = useState<'leave' | 'reload' | 'discard' | null>(null);
  const [edit, dispatch] = useReducer(dashboardReducer, null);
  const ready = phase === 'ready' && edit !== null;
  const canShowDevMode = ready && user?.role === 'super-admin' && user.passwordChangeRequired === false
    && edit.baseline.roleAssumption.role === 'super-admin'
    && edit.baseline.roleAssumption.authentication === 'session'
    && edit.baseline.roleAssumption.source === 'local-account';
  const configSections = canShowDevMode ? CONFIG_SECTIONS : CONFIG_SECTIONS.filter(({ id }) => id !== 'devMode');
  const configSection = !canShowDevMode && section === 'devMode' ? 'openrouter' : section;
  const showDevModeSection = canShowDevMode && tab === 'config' && configSection === 'devMode';
  const ids = useId();
  const changed = ready ? dirtyFields(edit) : [];
  const enablementDirty = changed.some((field) => field.path === 'devModeEnabled');
  const devModeSettingsDenied = ['UNAUTHENTICATED', 'FORBIDDEN', 'PASSWORD_CHANGE_REQUIRED']
    .includes(edit?.error?.code ?? '');
  const originalFields = ready ? fieldsFromSettings(edit.baseline.settings) : {};
  const configDirty = changed.length > 0;
  const dirty = configDirty || personalizationDirty;
  const pending = Boolean(edit?.pending);
  const mutationBusy = pending || credentialBusy || calendarBusy || personalizationBusy || webSearchBusy || devModeBusy;
  const showDirtyDock = Boolean(ready && (configDirty || pending));

  useEffect(() => {
    if (!initialSection) return;
    if (isPluginSection(initialSection)) {
      setTab('plugins');
      setPlugin(initialSection);
      return;
    }
    if (isPersonalizationSection(initialSection) || isStandardUser) {
      setTab('personalization');
      return;
    }
    setTab('config');
    setSection(initialSection);
  }, [initialSection, isStandardUser]);

  const initialFocusTargetRef = useRef(focusTarget);

  useEffect(() => {
    if (initialFocusTargetRef.current === 'memory') return;
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (focusTarget !== 'memory') return undefined;
    const run = () => {
      focusMemoryCardElement();
      onConsumeFocusTarget?.();
    };
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(run);
      return () => cancelAnimationFrame(frame);
    }
    queueMicrotask(run);
    return undefined;
  }, [focusTarget, onConsumeFocusTarget]);

  const loadModels = useCallback(() => {
    if (isStandardUser) return;
    modelsAbortRef.current?.abort();
    const epoch = ++modelsEpochRef.current;
    const abort = new AbortController();
    modelsAbortRef.current = abort;
    setModelsLoading(true);
    setModelsError(null);
    void client.models(abort.signal).then((response) => {
      if (epoch !== modelsEpochRef.current) return;
      setModels(response.models);
      setModelsLoading(false);
      setModelsError(null);
    }).catch((error: unknown) => {
      if (epoch !== modelsEpochRef.current) return;
      if (abort.signal.aborted) return;
      const code = error instanceof AdminConfigClientError ? error.code : 'MODEL_CATALOGUE_UNAVAILABLE';
      setModelsLoading(false);
      setModelsError(errorCopy(code));
    });
  }, [client, isStandardUser]);

  useEffect(() => {
    if (isStandardUser) {
      setPhase('ready');
      return;
    }
    const epoch = ++epochRef.current;
    const abort = new AbortController();
    abortRef.current = abort;
    setPhase('loading');
    void client.read(abort.signal).then((config) => {
      if (epoch !== epochRef.current) return;
      dispatch({ type: 'loaded', config });
      setPhase('ready');
    }).catch(() => {
      if (epoch !== epochRef.current) return;
      setPhase('unavailable');
    });
    loadModels();
    return () => {
      abort.abort();
      modelsAbortRef.current?.abort();
      checkAbortRef.current?.abort();
      epochRef.current += 1;
      modelsEpochRef.current += 1;
      refreshEpoch.current += 1;
    };
  }, [client, isStandardUser, loadModels]);

  useEffect(() => {
    if (!edit?.compatibility) return undefined;
    const remaining = Date.parse(edit.compatibility.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return undefined;
    const timer = setTimeout(() => setExpiryTick((tick) => tick + 1), Math.min(remaining, 60_000));
    return () => clearTimeout(timer);
  }, [edit?.compatibility]);

  useEffect(() => {
    if (!dirty && !mutationBusy) return undefined;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty, mutationBusy]);

  const leave = () => {
    if (mutationBusy) return;
    if (dirty) {
      setConfirmDialog('leave');
      return;
    }
    const decision = navigationDecision({ dirty, pending: mutationBusy }, () => true);
    if (decision === 'leave') onBackToChat();
  };

  const requestDiscard = () => {
    if (!ready || edit.pending) return;
    setConfirmDialog('discard');
  };

  const performDiscard = () => {
    checkAbortRef.current?.abort();
    setSaveReport(null);
    dispatch({ type: 'discard' });
  };

  const reviewField = (field: EditableField) => {
    setTab('config');
    setSection(field.section);
    queueMicrotask(() => {
      const node = document.getElementById(fieldDomId(field.path));
      node?.scrollIntoView({ block: 'center' });
      node?.focus();
    });
  };

  const performReload = () => {
    checkAbortRef.current?.abort();
    setSaveReport(null);
    const epoch = ++epochRef.current;
    const abort = new AbortController();
    abortRef.current = abort;
    void client.read(abort.signal).then((config) => {
      if (epoch !== epochRef.current) return;
      dispatch({ type: 'loaded', config });
      setPhase('ready');
      setDevModeReload((reload) => reload + 1);
    }).catch(() => {
      if (epoch !== epochRef.current) return;
      setPhase('unavailable');
    });
  };

  const reload = (confirmDiscard: boolean) => {
    if (confirmDiscard && dirty) {
      setConfirmDialog('reload');
      return;
    }
    performReload();
  };

  const selectTab = (next: AdminTab) => {
    setTab(next);
    queueMicrotask(() => document.getElementById(`${ids}-${next}-tab`)?.focus());
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (devModeBusy) return;
    const index = tabs.findIndex((item) => item.id === tab);
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      selectTab(tabs[(index + 1) % tabs.length].id);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      selectTab(tabs[(index - 1 + tabs.length) % tabs.length].id);
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectTab(tabs[0].id);
    } else if (event.key === 'End') {
      event.preventDefault();
      selectTab(tabs[tabs.length - 1].id);
    }
  };

  const handleFieldChange = (path: AdminConfigFieldPath, value: string | boolean) => {
    if (path === 'openRouter.modelId' || path === 'openRouter.reasoningEffort' || path.startsWith('chat.')) {
      checkAbortRef.current?.abort();
      setSaveReport(null);
    }
    dispatch({ type: 'edit', path, value });
  };

  const handleCredentialBusy = (busy: boolean) => {
    setCredentialBusy(busy);
    if (busy) {
      checkAbortRef.current?.abort();
      setSaveReport(null);
      dispatch({ type: 'checkInvalidated' });
    }
  };

  const runCheck = () => {
    if (!ready || edit.checkPending || edit.stale || edit.uncertain) return;
    const key = compatibilityKey(edit);
    const converted = settingsFromFields(edit.baseline.settings, edit.fields);
    if (key === null || !converted.settings) {
      dispatch({
        type: 'failed',
        error: {
          code: 'CONFIG_VALIDATION_FAILED',
          currentRevision: edit.baseline.revision,
          fieldErrors: converted.fieldErrors,
        },
      });
      return;
    }
    checkAbortRef.current?.abort();
    const abort = new AbortController();
    checkAbortRef.current = abort;
    const epoch = edit.checkEpoch;
    setSaveReport(null);
    dispatch({ type: 'checkStarted', epoch, key });
    void client.checkModelCompatibility({
      protocolVersion: 1,
      expectedRevision: edit.baseline.revision,
      settings: converted.settings,
    }, abort.signal).then((response) => {
      dispatch({ type: 'checkFinished', epoch, key, response });
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return;
      const code = error instanceof AdminConfigClientError ? error.code : 'NETWORK_ERROR';
      dispatch({ type: 'checkFailed', epoch, key, code });
    });
  };

  const save = () => {
    if (!ready || inflight.current || devModeBusy || (enablementDirty && (!canShowDevMode || devModeSettingsDenied))
        || saveLocked(edit, Date.now())) return;
    const converted = settingsFromFields(edit.baseline.settings, edit.fields,
      edit.baseline.chatFloor);
    if (!converted.settings) {
      dispatch({
        type: 'failed',
        error: {
          code: 'CONFIG_VALIDATION_FAILED',
          currentRevision: edit.baseline.revision,
          fieldErrors: converted.fieldErrors,
        },
      });
      queueMicrotask(() => {
        summaryRef.current?.focus();
        const first = converted.fieldErrors[0];
        if (first) document.getElementById(fieldDomId(first.path as AdminConfigFieldPath))?.focus();
      });
      return;
    }
    inflight.current = true;
    setSaveReport(null);
    dispatch({ type: 'begin', scope: 'settings' });
    const epoch = ++refreshEpoch.current;
    void client.saveSettings({
      protocolVersion: 1,
      expectedRevision: edit.baseline.revision,
      settings: converted.settings,
    }).then(async (config) => {
      dispatch({ type: 'settingsSaved', config });
      const ok = await refreshCapabilities();
      if (epoch === refreshEpoch.current) dispatch({ type: 'capabilities', ok });
    }).catch((error: unknown) => {
      const failure = error instanceof AdminConfigClientError
        ? error
        : new AdminConfigClientError({ code: 'NETWORK_ERROR', uncertain: true });
      if (failure.compatibility) setSaveReport(failure.compatibility);
      dispatch({
        type: 'failed',
        error: {
          code: failure.code,
          currentRevision: failure.currentRevision,
          fieldErrors: failure.fieldErrors,
          uncertain: failure.uncertain,
        },
      });
      queueMicrotask(() => summaryRef.current?.focus());
    }).finally(() => {
      inflight.current = false;
    });
  };

  const editingLocked = Boolean(edit?.pending || edit?.stale || edit?.uncertain);
  const errors: AdminConfigError['error']['fieldErrors'] = edit?.error?.fieldErrors ?? [];
  const hiddenErrors = errors.filter((error) => fieldSection(error.path) && fieldSection(error.path) !== configSection);
  const configFields = ready ? (
    <ConfigFields
      section={configSection}
      fields={edit.fields}
      original={originalFields}
      errors={errors}
      disabled={editingLocked || (configSection === 'devMode' && (credentialBusy || devModeBusy))}
      floor={edit.baseline.chatFloor}
      models={models}
      modelsLoading={modelsLoading}
      modelsError={modelsError}
      onRetryModels={loadModels}
      onChange={handleFieldChange}
    />
  ) : null;

  return (
    <div className="aurvin-admin">
      <header className="aurvin-admin-header">
        <button type="button" className="aurvin-admin-back" onClick={leave} disabled={mutationBusy}>
          Back to chat
        </button>
        <h1 ref={headingRef} tabIndex={-1} className="aurvin-admin-title">Manage Aurvin</h1>
        {chatActive ? (
          <p className="aurvin-admin-continue" role="status">Chat/voice continues in the background</p>
        ) : null}
      </header>

      {phase === 'loading' ? <p role="status">Loading configuration</p> : null}
      {phase === 'unavailable' ? (
        <div role="alert">
          <p>Storage or configuration is unavailable.</p>
          <button type="button" onClick={() => reload(false)}>Retry</button>
        </div>
      ) : null}

      {phase !== 'unavailable' ? (
        <>
          <div
            className="aurvin-admin-tabs"
            role="tablist"
            aria-label="Manage Aurvin"
            onKeyDown={onTabKey}
          >
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                id={`${ids}-${item.id}-tab`}
                role="tab"
                aria-selected={tab === item.id}
                aria-controls={`${ids}-${item.id}-panel`}
                tabIndex={tab === item.id ? 0 : -1}
                disabled={mutationBusy}
                onClick={() => selectTab(item.id)}
              >
                {item.label}
                {item.id === 'config' && configDirty ? <span className="aurvin-admin-dirty">Unsaved</span> : null}
              </button>
            ))}
          </div>

          <div
            id={`${ids}-personalization-panel`}
            role="tabpanel"
            aria-labelledby={`${ids}-personalization-tab`}
            hidden={tab !== 'personalization'}
          >
            <PersonalizationPanel
              client={personalizationClient}
              disabled={pending || credentialBusy || calendarBusy}
              onDirtyChange={setPersonalizationDirty}
              onBusyChange={setPersonalizationBusy}
            />
          </div>

          <div
            id={`${ids}-config-panel`}
            role="tabpanel"
            aria-labelledby={`${ids}-config-tab`}
            hidden={tab !== 'config'}
          >
            <div className="aurvin-admin-config">
                <nav className="aurvin-admin-rail" aria-label="Settings sections">
                  {configSections.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-current={configSection === item.id ? 'true' : undefined}
                      disabled={mutationBusy}
                      onClick={() => setSection(item.id)}
                    >
                      {item.label}
                      {changed.some((field) => field.section === item.id) ? <span className="aurvin-admin-dirty">Unsaved</span> : null}
                    </button>
                  ))}
                </nav>
                <label className="aurvin-admin-section-select">
                  Section
                  <select
                    value={configSection}
                    disabled={mutationBusy}
                    onChange={(event) => setSection(event.target.value as AdminSection)}
                  >
                    {configSections.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </select>
                </label>
                <div className="aurvin-admin-main">
                  <h2 className="aurvin-admin-section-title">{configSections.find((item) => item.id === configSection)?.label}</h2>
                  {ready ? (
                    <>
                      {configSection === 'openrouter' || configSection === 'deepgram' ? (
                        <CredentialRow
                          provider={configSection}
                          credential={edit.baseline.credentials[configSection]}
                          expectedRevision={edit.baseline.revision}
                          disabled={Boolean(edit.pending || edit.stale || edit.uncertain)}
                          client={client}
                          onBusy={handleCredentialBusy}
                          onSaved={(config) => {
                            dispatch({ type: 'credentialSaved', config });
                            const epoch = ++refreshEpoch.current;
                            void refreshCapabilities().then((ok) => {
                              if (epoch === refreshEpoch.current) dispatch({ type: 'capabilities', ok });
                            });
                          }}
                          onFailure={(error) => dispatch({
                            type: 'failed',
                            error: {
                              code: error.code,
                              currentRevision: error.currentRevision,
                              fieldErrors: error.fieldErrors,
                              uncertain: error.uncertain,
                            },
                          })}
                        />
                      ) : null}
                      {edit.error ? (
                        <div ref={summaryRef} className="aurvin-admin-summary" role="alert" tabIndex={-1}>
                          <p>{errorCopy(edit.error.code)}</p>
                          {hiddenErrors.map((error) => {
                            const target = fieldSection(error.path);
                            const label = configSections.find((item) => item.id === target)?.label ?? error.path;
                            return (
                              <button key={`${error.path}-${error.code}`} type="button" onClick={() => {
                                if (target) setSection(target);
                              }}>
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      {configSection === 'openrouter' ? (
                        <>
                          <ModelSelectionFields
                            models={models}
                            modelId={String(edit.fields['openRouter.modelId'] ?? '')}
                            effort={(edit.fields['openRouter.reasoningEffort'] ?? 'provider-default') as ReasoningEffort}
                            originalModelId={String(originalFields['openRouter.modelId'] ?? '')}
                            originalEffort={(originalFields['openRouter.reasoningEffort'] ?? 'provider-default') as ReasoningEffort}
                            loading={modelsLoading}
                            error={modelsError}
                            disabled={editingLocked}
                            errors={errors}
                            onChange={(path, value) => handleFieldChange(path, value)}
                            onRetry={loadModels}
                          />
                          <div className="aurvin-admin-compat">
                            <div className="aurvin-admin-compat-actions">
                              <button
                                type="button"
                                className="aurvin-admin-check-btn"
                                disabled={editingLocked || edit.checkPending || compatibilityKey(edit) === null}
                                onClick={runCheck}
                              >
                                {edit.checkPending ? 'Checking compatibility…' : 'Check compatibility'}
                              </button>
                              <span className="aurvin-admin-help">
                                Static non-inference check against the OpenRouter catalogue. Does not save or run the model.
                              </span>
                            </div>
                            {edit.checkPending ? (
                              <p role="status" aria-live="polite">Checking compatibility…</p>
                            ) : null}
                            {edit.checkError ? (
                              <div className="aurvin-admin-alert" role="alert">
                                <span>{errorCopy(edit.checkError)}</span>
                                <button type="button" onClick={runCheck} disabled={editingLocked || edit.checkPending}>
                                  Check again
                                </button>
                              </div>
                            ) : null}
                            {(() => {
                              const activeReport = edit.compatibility?.report ?? saveReport;
                              if (!activeReport) return null;
                              const compatMeta = edit.compatibility;
                              return (
                                <div className="aurvin-admin-compat-report" role="status" aria-live="polite">
                                  <p>
                                    <strong>Status:</strong> {COMPATIBILITY_STATUS_LABELS[activeReport.status]}
                                  </p>
                                  {compatMeta ? (
                                    <p className="aurvin-admin-help">
                                      Checked at {compatMeta.checkedAt}
                                      {compatMeta.catalogueObservedAt ? ` (catalogue observed ${compatMeta.catalogueObservedAt})` : ''}
                                    </p>
                                  ) : null}
                                  {activeReport.blockers.length > 0 ? (
                                    <ul>
                                      {activeReport.blockers.map((blocker, idx) => (
                                        <li key={`${blocker.code}-${idx}`}>
                                          {BLOCKER_COPY[blocker.code]}
                                        </li>
                                      ))}
                                    </ul>
                                  ) : null}
                                  <p className="aurvin-admin-help">
                                    Capacities: context {activeReport.contextTokens ?? 'unknown'}, output{' '}
                                    {activeReport.outputTokens ?? 'unknown'} ({activeReport.outputCapParameter ?? 'none'}),
                                    context floor {activeReport.chatFloor.minContextTokens}.
                                  </p>
                                  <p className="aurvin-admin-help">
                                    Optional tools: Calendar {activeReport.capabilities.calendar}, web search{' '}
                                    {activeReport.capabilities.webTool}, pricing {activeReport.capabilities.pricing}.
                                  </p>
                                  {activeReport.warnings.length > 0 ? (
                                    <ul>
                                      {activeReport.warnings.map((warning) => (
                                        <li key={warning}>{WARNING_COPY[warning]}</li>
                                      ))}
                                    </ul>
                                  ) : null}
                                  <p className="aurvin-admin-help">
                                    Actual routing, SSE streaming, tool behavior, and reasoning continuity: untested.
                                  </p>
                                </div>
                              );
                            })()}
                            {requiresCompatibilityCheck(edit) && !hasMatchingCompatibility(edit) && !edit.checkPending ? (
                              <p className="aurvin-admin-help">
                                Run Check compatibility and obtain Catalogue compatible for this draft before saving.
                              </p>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                      {configSection !== 'devMode' ? configFields : showDevModeSection && !devModeSettingsDenied ? (
                        <DevModeControls
                          key={JSON.stringify([user?.userId, edit.baseline.revision, devModeReload])}
                          client={client}
                          disabled={editingLocked || credentialBusy}
                          enablementDirty={enablementDirty}
                          onBusy={setDevModeBusy}
                        >
                          {configFields}
                        </DevModeControls>
                      ) : null}
                      <div className="aurvin-admin-save-row">
                        <div className="aurvin-admin-save-meta">
                          <p role="status" aria-live="polite">
                            {edit.pending ? 'Saving' : configDirty ? 'Unsaved changes' : activationCopy(edit.baseline)}
                          </p>
                          <p className="aurvin-admin-help">
                            Save changes writes nonsecret edits across sections. It does not save provider keys.
                          </p>
                          {mutationBusy ? <p className="aurvin-admin-help">Wait for the save to finish</p> : null}
                        </div>
                        {edit.stale || edit.uncertain ? (
                          <div className="aurvin-admin-save-actions">
                            <button type="button" onClick={() => reload(true)}>Reload saved settings</button>
                          </div>
                        ) : null}
                        {edit.capabilityWarning ? (
                          <div className="aurvin-admin-save-warning">
                            <p role="status">Saved. Voice availability could not be refreshed. Retry voice refresh before starting a new session.</p>
                            <button type="button" onClick={() => {
                              const epoch = ++refreshEpoch.current;
                              void refreshCapabilities().then((ok) => {
                                if (epoch === refreshEpoch.current) dispatch({ type: 'capabilities', ok });
                              });
                            }}>Retry voice refresh</button>
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
          </div>

          <div
            id={`${ids}-plugins-panel`}
            role="tabpanel"
            aria-labelledby={`${ids}-plugins-tab`}
            hidden={tab !== 'plugins'}
          >
            <div className="aurvin-admin-config">
              <nav className="aurvin-admin-rail" aria-label="Plugin sections">
                {PLUGIN_SECTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={plugin === item.id ? 'true' : undefined}
                    disabled={mutationBusy}
                    onClick={() => setPlugin(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>
              <label className="aurvin-admin-section-select">
                Plugin
                <select
                  value={plugin}
                  disabled={mutationBusy}
                  onChange={(event) => setPlugin(event.target.value as PluginSection)}
                >
                  {PLUGIN_SECTIONS.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
              </label>
              <div className="aurvin-admin-main">
                <h2 className="aurvin-admin-section-title">{PLUGIN_SECTIONS.find((item) => item.id === plugin)?.label}</h2>
                {tab === 'plugins' && plugin === 'calendar' ? (
                  <GoogleCalendarPanel
                    client={calendarClient ?? defaultCalendarClient}
                    initialStatus={initialCalendarStatus}
                    oauthOutcome={oauthOutcome}
                    onDismissOAuthOutcome={onDismissOAuthOutcome}
                    disabled={editingLocked}
                    onBusy={setCalendarBusy}
                  />
                ) : null}
                {tab === 'plugins' && plugin === 'web-search' ? (
                  <WebSearchPanel
                    client={webSearchClient ?? defaultWebSearchClient}
                    initialStatus={initialWebSearchStatus}
                    initialOAuthCallback={initialWebSearchOAuthCallback}
                    oauthOutcome={webSearchOAuthOutcome}
                    onDismissOAuthOutcome={onDismissWebSearchOAuthOutcome}
                    onConsumeOAuthCallback={onConsumeWebSearchOAuthCallback}
                    disabled={editingLocked}
                    onBusy={setWebSearchBusy}
                  />
                ) : null}
              </div>
            </div>
          </div>

          <div
            id={`${ids}-analytics-panel`}
            role="tabpanel"
            aria-labelledby={`${ids}-analytics-tab`}
            hidden={tab !== 'analytics'}
          />

          <div
            id={`${ids}-administration-panel`}
            role="tabpanel"
            aria-labelledby={`${ids}-administration-tab`}
            hidden={tab !== 'administration'}
          >
            {tab === 'administration' && !isStandardUser ? (
              <AdministrationPanel
                client={adminClient ?? defaultAdministrationClient}
                currentUser={user}
              />
            ) : null}
          </div>
        </>
      ) : null}

      {showDirtyDock && ready ? (
        <div className="aurvin-admin-dirty-dock" role="region" aria-label="Unsaved configuration changes">
          <div className="aurvin-admin-dirty-dock-copy">
            <p role="status" aria-live="polite">
              {edit.pending
                ? 'Saving'
                : `${changed.length} unsaved ${changed.length === 1 ? 'change' : 'changes'}`}
            </p>
            {changed.length > 0 ? (
              <div className="aurvin-admin-change-list">
                {changed.map((field) => {
                  const sectionLabel = CONFIG_SECTIONS.find((item) => item.id === field.section)?.label ?? field.section;
                  return (
                    <button
                      key={field.path}
                      type="button"
                      className="aurvin-admin-change-chip"
                      disabled={devModeBusy}
                      onClick={() => reviewField(field)}
                    >
                      {sectionLabel} · {field.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {requiresCompatibilityCheck(edit) && !hasMatchingCompatibility(edit) && !edit.checkPending ? (
              <p className="aurvin-admin-help">
                Check compatibility on OpenRouter before saving.
              </p>
            ) : null}
          </div>
          <div className="aurvin-admin-save-actions">
            <button
              type="button"
              className="aurvin-admin-discard"
              disabled={Boolean(edit.pending || edit.stale || edit.uncertain) || devModeBusy}
              onClick={requestDiscard}
            >
              Discard changes
            </button>
            <button
              type="button"
              className="aurvin-admin-save"
              disabled={saveLocked(edit, Date.now()) || devModeBusy
                || (enablementDirty && (!canShowDevMode || devModeSettingsDenied))}
              onClick={save}
            >
              Save changes
            </button>
          </div>
        </div>
      ) : null}

      {confirmDialog === 'leave' ? (
        <ConfirmDialog
          open={confirmDialog === 'leave'}
          title="Discard unsaved changes?"
          message={
            personalizationDirty && !configDirty
              ? 'Discard unsaved personalization changes and return to chat?'
              : 'Discard unsaved configuration changes and return to chat?'
          }
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          variant="warning"
          onConfirm={() => {
            setConfirmDialog(null);
            onBackToChat();
          }}
          onCancel={() => setConfirmDialog(null)}
        />
      ) : null}

      {confirmDialog === 'reload' ? (
        <ConfirmDialog
          open={confirmDialog === 'reload'}
          title="Discard unsaved changes?"
          message="Discard unsaved configuration changes and reload saved settings?"
          confirmLabel="Discard and reload"
          cancelLabel="Keep editing"
          variant="warning"
          onConfirm={() => {
            setConfirmDialog(null);
            performReload();
          }}
          onCancel={() => setConfirmDialog(null)}
        />
      ) : null}

      {confirmDialog === 'discard' ? (
        <ConfirmDialog
          open={confirmDialog === 'discard'}
          title="Discard unsaved changes?"
          message="Discard unsaved configuration changes and keep editing?"
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          variant="warning"
          onConfirm={() => {
            setConfirmDialog(null);
            performDiscard();
          }}
          onCancel={() => setConfirmDialog(null)}
        />
      ) : null}
    </div>
  );
}
