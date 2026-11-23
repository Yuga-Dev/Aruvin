/**
 * ============================================================================
 * FILE: ModelSelectionFields.tsx
 * LOCATION: frontend/src/features/admin-config/ModelSelectionFields.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render a unified searchable OpenRouter model dropdown and thinking-effort selector.
 *
 * ROLE IN PROJECT:
 *    Presentational controls for the OpenRouter section of AdminDashboard.
 *    Combines catalogue search and selection in one popover while preserving
 *    missing configured IDs and declared reasoning effort bounds.
 *
 * KEY COMPONENTS:
 *    - ModelCombobox: Single-trigger searchable dropdown for OpenRouter models.
 *    - ModelSelectionFields: Model combobox, effort selector, and catalogue status.
 * ============================================================================
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  AdminConfigError,
  AdminConfigFieldPath,
  ExplicitReasoningEffort,
  ModelCatalogueItem,
  ReasoningEffort,
} from '../../api/admin-config-protocol.ts';
import { AdminSelect, type AdminSelectOption } from './AdminSelect.tsx';
import { fieldDomId } from './ConfigFields.tsx';

export type ModelSelectionFieldsProps = {
  models: ModelCatalogueItem[];
  modelId: string;
  effort: ReasoningEffort;
  originalModelId?: string;
  originalEffort?: ReasoningEffort;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  errors: AdminConfigError['error']['fieldErrors'];
  onChange: (path: AdminConfigFieldPath, value: string) => void;
  onRetry: () => void;
};

const EFFORT_LABELS: Record<ExplicitReasoningEffort, string> = {
  max: 'Max',
  xhigh: 'Extra high',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  minimal: 'Minimal',
  none: 'None (disable reasoning)',
};

function errorsFor(path: AdminConfigFieldPath, errors: ModelSelectionFieldsProps['errors']) {
  return errors.filter((error) => error.path === path);
}

function matchesQuery(item: ModelCatalogueItem, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const name = item.name.toLowerCase();
  const id = item.id.toLowerCase();
  return tokens.every((token) => name.includes(token) || id.includes(token));
}

function supportsReasoning(item: ModelCatalogueItem): boolean {
  return item.reasoning.selection === 'declared' || item.reasoning.selection === 'all';
}

export type ModelComboboxProps = {
  id: string;
  models: ModelCatalogueItem[];
  modelId: string;
  selectedModel: ModelCatalogueItem | undefined;
  loading: boolean;
  disabled: boolean;
  invalid: boolean;
  describedBy: string;
  onSelect: (modelId: string) => void;
};

export function ModelCombobox({
  id,
  models,
  modelId,
  selectedModel,
  loading,
  disabled,
  invalid,
  describedBy,
  onSelect,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const isOpen = open && !disabled;

  const tokens = useMemo(
    () => search.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [search],
  );

  const filtered = useMemo(
    () => (tokens.length === 0 ? models : models.filter((item) => matchesQuery(item, tokens))),
    [models, tokens],
  );

  const missingConfiguredMatches = Boolean(
    modelId !== '' &&
    !selectedModel &&
    (tokens.length === 0 || tokens.every((token) => modelId.toLowerCase().includes(token))),
  );

  type DropdownEntry =
    | { kind: 'missing'; id: string }
    | { kind: 'model'; item: ModelCatalogueItem };

  const entries: DropdownEntry[] = useMemo(() => {
    const list: DropdownEntry[] = [];
    if (missingConfiguredMatches) list.push({ kind: 'missing', id: modelId });
    for (const item of filtered) list.push({ kind: 'model', item });
    return list;
  }, [filtered, missingConfiguredMatches, modelId]);

  const resolvedActiveIndex = entries.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), entries.length - 1);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    queueMicrotask(() => searchInputRef.current?.focus());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || resolvedActiveIndex < 0) return;
    optionRefs.current[resolvedActiveIndex]?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, resolvedActiveIndex]);

  const openMenu = () => {
    if (disabled) return;
    const selectedIdx = entries.findIndex((entry) =>
      entry.kind === 'missing' ? entry.id === modelId : entry.item.id === modelId);
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0);
    setOpen(true);
  };

  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    setSearch('');
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };

  const commitSelection = (nextId: string) => {
    onSelect(nextId);
    closeMenu(true);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (isOpen) closeMenu(false);
      else openMenu();
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (entries.length > 0) setActiveIndex((resolvedActiveIndex + 1) % entries.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (entries.length > 0) setActiveIndex((resolvedActiveIndex - 1 + entries.length) % entries.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = entries[resolvedActiveIndex];
      if (!target) return;
      commitSelection(target.kind === 'missing' ? target.id : target.item.id);
      return;
    }
    if (event.key === 'Tab') {
      closeMenu(false);
    }
  };

  const missingInCatalogue = modelId !== '' && !selectedModel;

  return (
    <div ref={containerRef} className={`aurvin-admin-dropdown aurvin-admin-model-dropdown${isOpen ? ' is-open' : ''}`}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        className="aurvin-admin-dropdown-trigger"
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onClick={() => (isOpen ? closeMenu(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="aurvin-admin-dropdown-value">
          {selectedModel ? (
            <>
              <span className="aurvin-admin-dropdown-primary">{selectedModel.name}</span>
              {selectedModel.id !== selectedModel.name ? (
                <span className="aurvin-admin-dropdown-mono">{selectedModel.id}</span>
              ) : null}
            </>
          ) : missingInCatalogue ? (
            <>
              <span className="aurvin-admin-dropdown-primary aurvin-admin-mono">{modelId}</span>
              <span className="aurvin-admin-dropdown-badge is-warning">Not in catalogue</span>
            </>
          ) : (
            <span className="aurvin-admin-dropdown-placeholder">
              {loading ? 'Loading models…' : 'Select a model…'}
            </span>
          )}
        </span>
        <span className="aurvin-admin-dropdown-end">
          {selectedModel && supportsReasoning(selectedModel) ? (
            <span className="aurvin-admin-dropdown-badge">Reasoning</span>
          ) : null}
          <svg
            className="aurvin-admin-dropdown-chevron"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M4 6L8 10L12 6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {isOpen ? (
        <div className="aurvin-admin-dropdown-menu aurvin-admin-model-menu">
          <div className="aurvin-admin-dropdown-search">
            <svg
              className="aurvin-admin-search-icon"
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.5 10.5L13.75 13.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              ref={searchInputRef}
              type="search"
              maxLength={200}
              value={search}
              placeholder={models.length > 0 ? `Search ${models.length} models by name or ID…` : 'Search models…'}
              aria-label="Search models"
              aria-controls={listboxId}
              aria-activedescendant={resolvedActiveIndex >= 0 && entries[resolvedActiveIndex] ? `${listboxId}-opt-${resolvedActiveIndex}` : undefined}
              onChange={(event) => {
                setSearch(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
            />
            {search !== '' ? (
              <button
                type="button"
                className="aurvin-admin-search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setSearch('');
                  setActiveIndex(0);
                  searchInputRef.current?.focus();
                }}
              >
                ×
              </button>
            ) : null}
            <span className="aurvin-admin-search-count" aria-live="polite">
              {loading && models.length === 0
                ? 'Loading…'
                : search.trim() !== ''
                  ? `${filtered.length} / ${models.length}`
                  : `${models.length}`}
            </span>
          </div>

          <div id={listboxId} role="listbox" aria-label="OpenRouter models" className="aurvin-admin-dropdown-list">
            {entries.length === 0 ? (
              <p className="aurvin-admin-dropdown-empty">
                {loading
                  ? 'Loading OpenRouter model catalogue…'
                  : search.trim() !== ''
                    ? `No models match “${search.trim()}”.`
                    : 'No verifiable text-chat models available.'}
              </p>
            ) : (
              entries.map((entry, index) => {
                const entryId = entry.kind === 'missing' ? entry.id : entry.item.id;
                const isSelected = entryId === modelId;
                const isActive = index === resolvedActiveIndex;
                return (
                  <button
                    key={entry.kind === 'missing' ? `missing:${entry.id}` : entry.item.id}
                    ref={(el) => { optionRefs.current[index] = el; }}
                    id={`${listboxId}-opt-${index}`}
                    type="button"
                    role="option"
                    value={entryId}
                    aria-selected={isSelected}
                    className={`aurvin-admin-dropdown-option${isSelected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commitSelection(entryId)}
                  >
                    <span className="aurvin-admin-dropdown-option-text">
                      <span className="aurvin-admin-dropdown-option-title">
                        {entry.kind === 'missing' ? entry.id : entry.item.name}
                      </span>
                      {entry.kind === 'missing' ? (
                        <span className="aurvin-admin-dropdown-option-sub">
                          Configured model — not in current catalogue
                        </span>
                      ) : entry.item.id !== entry.item.name ? (
                        <span className="aurvin-admin-dropdown-option-sub aurvin-admin-mono">
                          {entry.item.id}
                        </span>
                      ) : null}
                    </span>
                    <span className="aurvin-admin-dropdown-option-meta">
                      {entry.kind === 'model' && supportsReasoning(entry.item) ? (
                        <span className="aurvin-admin-dropdown-badge">Reasoning</span>
                      ) : null}
                      {isSelected ? (
                        <svg
                          className="aurvin-admin-dropdown-check"
                          width="15"
                          height="15"
                          viewBox="0 0 16 16"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M3.5 8.5L6.5 11.5L12.5 4.5"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ModelSelectionFields({
  models,
  modelId,
  effort,
  originalModelId,
  originalEffort,
  loading,
  error,
  disabled,
  errors,
  onChange,
  onRetry,
}: ModelSelectionFieldsProps) {
  const selectedModel = models.find((item) => item.id === modelId);

  const modelDomId = fieldDomId('openRouter.modelId');
  const modelHelpId = `${modelDomId}-help`;
  const modelWasId = `${modelDomId}-was`;
  const modelErrorId = `${modelDomId}-error`;
  const modelErrors = errorsFor('openRouter.modelId', errors);
  const modelInvalid = modelErrors.length > 0;
  const modelChanged = originalModelId !== undefined && modelId !== originalModelId;

  const effortDomId = fieldDomId('openRouter.reasoningEffort');
  const effortHelpId = `${effortDomId}-help`;
  const effortWasId = `${effortDomId}-was`;
  const effortErrorId = `${effortDomId}-error`;
  const effortErrors = errorsFor('openRouter.reasoningEffort', errors);
  const effortInvalid = effortErrors.length > 0;
  const effortChanged = originalEffort !== undefined && effort !== originalEffort;

  const declaredEfforts = selectedModel?.reasoning.efforts ?? [];
  const effortMissingInList = effort !== 'provider-default' && !declaredEfforts.includes(effort);

  const effortOptions: AdminSelectOption[] = [
    { value: 'provider-default', label: 'Provider default' },
    ...declaredEfforts.map((choice) => ({
      value: choice,
      label: EFFORT_LABELS[choice],
    })),
    ...(effortMissingInList
      ? [{ value: effort, label: `${effort} — not declared for current selection`, disabled: true }]
      : []),
  ];

  const effortNote = !selectedModel
    ? 'Only Provider default is available until catalogue effort metadata loads for the selected model.'
    : selectedModel.reasoning.selection === 'declared' || selectedModel.reasoning.selection === 'all'
      ? selectedModel.reasoning.mandatory
        ? 'Reasoning is mandatory for this model. Disabling reasoning is not offered.'
        : 'Select Provider default (sends no override) or a declared effort.'
      : 'Catalogue metadata does not declare effort selection for this model; only Provider default is available.';

  return (
    <fieldset className="aurvin-admin-fieldset">
      <legend>Model configuration</legend>

      <div className={modelChanged ? 'aurvin-admin-field is-changed' : 'aurvin-admin-field'}>
        <label htmlFor={modelDomId}>
          Model
          {modelChanged ? <span className="aurvin-admin-dirty">Changed</span> : null}
        </label>
        <ModelCombobox
          id={modelDomId}
          models={models}
          modelId={modelId}
          selectedModel={selectedModel}
          loading={loading}
          disabled={disabled}
          invalid={modelInvalid}
          describedBy={[modelHelpId, modelChanged ? modelWasId : null, modelInvalid ? modelErrorId : null]
            .filter(Boolean).join(' ')}
          onSelect={(nextId) => onChange('openRouter.modelId', nextId)}
        />
        <p id={modelHelpId} className="aurvin-admin-help">
          {modelId !== '' && !selectedModel
            ? 'Configured model — not in current catalogue. Retained without automatic replacement.'
            : loading && models.length === 0
              ? 'Loading verifiable text-chat models from OpenRouter…'
              : `${models.length} verifiable text-chat models from the OpenRouter catalogue.`}
        </p>
        {modelChanged ? (
          <p id={modelWasId} className="aurvin-admin-changed-was">
            Was {originalModelId === '' ? 'Empty' : originalModelId}
          </p>
        ) : null}
        {error ? (
          <div className="aurvin-admin-alert" role="alert">
            <span>{error}</span>
            <button type="button" onClick={onRetry} disabled={loading}>
              Retry catalogue
            </button>
          </div>
        ) : null}
        {modelInvalid ? (
          <p id={modelErrorId} className="aurvin-admin-field-error">
            {modelErrors.map((item) => item.code).join(', ')}
          </p>
        ) : null}
      </div>

      <div className={effortChanged ? 'aurvin-admin-field is-changed' : 'aurvin-admin-field'}>
        <label htmlFor={effortDomId}>
          Thinking effort
          {effortChanged ? <span className="aurvin-admin-dirty">Changed</span> : null}
        </label>
        <AdminSelect
          id={effortDomId}
          value={effort}
          options={effortOptions}
          disabled={disabled}
          invalid={effortInvalid}
          describedBy={[effortHelpId, effortChanged ? effortWasId : null, effortInvalid ? effortErrorId : null]
            .filter(Boolean).join(' ')}
          onChange={(nextEffort) => onChange('openRouter.reasoningEffort', nextEffort)}
        />
        <p id={effortHelpId} className="aurvin-admin-help">
          {effortNote} Reasoning consumes the finite output token budget and may leave little or no visible answer.
        </p>
        {effortChanged ? (
          <p id={effortWasId} className="aurvin-admin-changed-was">
            Was {originalEffort === 'provider-default' ? 'Provider default' : originalEffort}
          </p>
        ) : null}
        {effortInvalid ? (
          <p id={effortErrorId} className="aurvin-admin-field-error">
            {effortErrors.map((item) => item.code).join(', ')}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}
