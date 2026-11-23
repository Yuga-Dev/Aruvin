/**
 * ============================================================================
 * FILE: ConfigFields.tsx
 * LOCATION: frontend/src/features/admin-config/ConfigFields.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render one admin section of labeled nonsecret controls and field errors.
 *
 * ROLE IN PROJECT:
 *    Presentational catalog controls for AdminDashboard. Keeps credential
 *    candidates and analytics markup out of the settings form.
 *
 * KEY COMPONENTS:
 *    - Grouped fieldset controls from editableFields
 *    - Fixed OpenRouter privacy policy text
 * ============================================================================
 */

import { useState } from 'react';
import type {
  AdminConfigError, AdminConfigFieldPath, ChatFloor, ModelCatalogueItem,
} from '../../api/admin-config-protocol.ts';
import {
  MAX_WEB_SEARCH_BLOCKED_DOMAINS,
  normalizeBlockedWebDomain,
} from '../../api/web-search-protocol.ts';
import { AdminSelect } from './AdminSelect.tsx';
import { ModelCombobox } from './ModelSelectionFields.tsx';
import {
  applyCompactionModelToMemory,
  displayFieldValue,
  editableFields,
  type AdminSection,
  type EditableField,
  type FieldValues,
} from './config-edit-state.ts';

export type ConfigFieldsProps = {
  section: AdminSection;
  fields: FieldValues;
  original?: FieldValues;
  errors: AdminConfigError['error']['fieldErrors'];
  disabled: boolean;
  floor?: ChatFloor;
  models?: ModelCatalogueItem[];
  modelsLoading?: boolean;
  modelsError?: string | null;
  onRetryModels?: () => void;
  onChange: (path: AdminConfigFieldPath, value: string | boolean) => void;
};

export function fieldDomId(path: AdminConfigFieldPath): string {
  return `admin-field-${path.replace(/\./g, '-')}`;
}

function errorsFor(path: AdminConfigFieldPath, errors: ConfigFieldsProps['errors']) {
  return errors.filter((error) => error.path === path);
}

function DomainBlocklistControl({
  id,
  value,
  max = MAX_WEB_SEARCH_BLOCKED_DOMAINS,
  disabled,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  value: string;
  max?: number;
  disabled: boolean;
  invalid: boolean;
  describedBy: string;
  onChange: (next: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [hint, setHint] = useState<string | null>(null);

  const domains = value === '' ? [] : value.split('\n').filter(Boolean);
  const atLimit = domains.length >= max;
  const query = filter.trim().toLowerCase();
  const visible = query ? domains.filter((domain) => domain.includes(query)) : domains;

  const commit = (next: string[]) => onChange(next.join('\n'));

  const handleAdd = () => {
    if (disabled || atLimit) return;
    const normalized = normalizeBlockedWebDomain(draft);
    if (!normalized) {
      setHint('Enter a valid URL or domain (e.g. reddit.com or https://example.com/page).');
      return;
    }
    if (domains.includes(normalized)) {
      setHint(`${normalized} is already blocked.`);
      return;
    }
    commit([...domains, normalized]);
    setDraft('');
    setHint(null);
  };

  const handleRemove = (target: string) => {
    if (disabled) return;
    commit(domains.filter((domain) => domain !== target));
    setHint(null);
  };

  const handleClear = () => {
    if (disabled || domains.length === 0) return;
    commit([]);
    setFilter('');
    setHint(null);
  };

  return (
    <div className="aurvin-admin-blocklist">
      <div className="aurvin-admin-blocklist-add">
        <input
          id={id}
          type="text"
          value={draft}
          placeholder="e.g. reddit.com or https://example.com/page"
          disabled={disabled || atLimit}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            setDraft(event.target.value);
            if (hint) setHint(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              handleAdd();
            }
          }}
        />
        <button
          type="button"
          className="aurvin-admin-button"
          disabled={disabled || atLimit || draft.trim() === ''}
          onClick={handleAdd}
        >
          Add
        </button>
      </div>
      {hint ? <p className="aurvin-admin-blocklist-hint" role="status">{hint}</p> : null}
      {domains.length > 0 ? (
        <>
          <div className="aurvin-admin-blocklist-bar">
            <span className="aurvin-admin-blocklist-count">
              {domains.length} / {max} blocked
            </span>
            <div className="aurvin-admin-blocklist-tools">
              {domains.length > 6 ? (
                <input
                  type="search"
                  className="aurvin-admin-blocklist-filter"
                  value={filter}
                  placeholder="Filter domains..."
                  aria-label="Filter blocked domains"
                  disabled={disabled}
                  onChange={(event) => setFilter(event.target.value)}
                />
              ) : null}
              <button
                type="button"
                className="aurvin-admin-blocklist-clear"
                disabled={disabled}
                onClick={handleClear}
              >
                Clear all
              </button>
            </div>
          </div>
          <div className="aurvin-admin-blocklist-list" role="list" aria-label="Blocked domains">
            {visible.length > 0 ? visible.map((domain) => (
              <span key={domain} className="aurvin-admin-blocklist-chip" role="listitem">
                <span className="aurvin-admin-blocklist-domain">{domain}</span>
                <button
                  type="button"
                  className="aurvin-admin-blocklist-remove"
                  aria-label={`Remove ${domain}`}
                  disabled={disabled}
                  onClick={() => handleRemove(domain)}
                >
                  ×
                </button>
              </span>
            )) : (
              <span className="aurvin-admin-blocklist-empty">No matching domains.</span>
            )}
          </div>
        </>
      ) : (
        <p className="aurvin-admin-blocklist-empty">No blocked domains yet.</p>
      )}
    </div>
  );
}

function FieldControl({
  field, value, original, errors, disabled, models = [], modelsLoading = false, modelsError = null, onRetryModels, onChange,
}: {
  field: EditableField;
  value: string | boolean | undefined;
  original: string | boolean | undefined;
  errors: ConfigFieldsProps['errors'];
  disabled: boolean;
  models?: ModelCatalogueItem[];
  modelsLoading?: boolean;
  modelsError?: string | null;
  onRetryModels?: () => void;
  onChange: ConfigFieldsProps['onChange'];
}) {
  const id = fieldDomId(field.path);
  const helpId = `${id}-help`;
  const wasId = `${id}-was`;
  const errorId = `${id}-error`;
  const fieldErrors = errorsFor(field.path, errors);
  const invalid = fieldErrors.length > 0;
  const changed = original !== undefined && value !== original;
  const describedBy = [
    helpId,
    changed ? wasId : null,
    invalid ? errorId : null,
  ].filter(Boolean).join(' ');
  const raw = value ?? (field.kind === 'boolean' ? false : '');
  const modelValue = typeof raw === 'string' ? raw : '';
  const isCustomModelField =
    field.path === 'compaction.customModelId' || field.path === 'memory.customModelId';
  const selectedModel = isCustomModelField
    ? models.find((item) => item.id === modelValue)
    : undefined;
  const changedMark = changed ? <span className="aurvin-admin-dirty">Changed</span> : null;
  const wasHint = changed ? (
    <p id={wasId} className="aurvin-admin-changed-was">
      Was {displayFieldValue(field, original)}
    </p>
  ) : null;

  return (
    <div className={changed ? 'aurvin-admin-field is-changed' : 'aurvin-admin-field'}>
      {field.kind === 'boolean' ? (
        <label className="aurvin-admin-check" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={raw === true}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(field.path, event.target.checked)}
          />
          <span>{field.label}</span>
          {changedMark}
        </label>
      ) : (
        <>
          <label htmlFor={id}>
            {field.label}
            {field.unit ? <span className="aurvin-admin-unit"> ({field.unit})</span> : null}
            {changedMark}
          </label>
          {isCustomModelField ? (
            <ModelCombobox
              id={id}
              models={models}
              modelId={modelValue}
              selectedModel={selectedModel}
              loading={modelsLoading}
              disabled={disabled}
              invalid={invalid}
              describedBy={describedBy}
              onSelect={(nextId) => onChange(field.path, nextId)}
            />
          ) : field.kind === 'select' ? (
            <AdminSelect
              id={id}
              value={typeof raw === 'string' ? raw : ''}
              disabled={disabled}
              invalid={invalid}
              describedBy={describedBy}
              options={(field.choices ?? []).map((choice) => ({
                value: choice,
                label: choice === 'us'
                  ? 'US'
                  : choice === 'eu'
                    ? 'EU'
                    : choice === 'active-fork'
                      ? 'Active model fork (cache-aligned)'
                      : choice === 'main'
                        ? 'Main chat model'
                        : choice === 'custom'
                          ? 'Custom model'
                          : choice,
              }))}
              onChange={(nextValue) => onChange(field.path, nextValue)}
            />
          ) : field.kind === 'keyterms' ? (
            <textarea
              id={id}
              value={typeof raw === 'string' ? raw : ''}
              disabled={disabled}
              rows={6}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => onChange(field.path, event.target.value)}
            />
          ) : field.kind === 'domain-list' ? (
            <DomainBlocklistControl
              id={id}
              value={typeof raw === 'string' ? raw : ''}
              max={field.max}
              disabled={disabled}
              invalid={invalid}
              describedBy={describedBy}
              onChange={(nextValue) => onChange(field.path, nextValue)}
            />
          ) : (
            <input
              id={id}
              type={field.kind === 'text' || field.kind === 'nullable-text' ? 'text' : 'number'}
              value={typeof raw === 'string' ? raw : ''}
              disabled={disabled}
              min={field.min}
              max={field.max}
              step={field.kind === 'text' || field.kind === 'nullable-text' ? undefined : field.step ?? (field.kind.includes('decimal') ? 'any' : 1)}
              maxLength={field.kind === 'text' || field.kind === 'nullable-text' ? field.max : undefined}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              onChange={(event) => onChange(field.path, event.target.value)}
            />
          )}
        </>
      )}
      <p id={helpId} className="aurvin-admin-help">{field.help}</p>
      {wasHint}
      {isCustomModelField && modelsError && onRetryModels ? (
        <div className="aurvin-admin-alert" role="alert">
          <span>{modelsError}</span>
          <button type="button" onClick={onRetryModels} disabled={modelsLoading}>
            Retry catalogue
          </button>
        </div>
      ) : null}
      {invalid ? (
        <p id={errorId} className="aurvin-admin-field-error">
          {fieldErrors.map((error) => error.code).join(', ')}
        </p>
      ) : null}
    </div>
  );
}

export function ConfigFields({
  section, fields, original, errors, disabled, floor, models, modelsLoading, modelsError, onRetryModels, onChange,
}: ConfigFieldsProps) {
  const showCustomCompactionModel = fields['compaction.modelMode'] === 'custom';
  const showCustomMemoryModel = fields['memory.modelMode'] === 'custom';
  const sectionFields = editableFields.filter((field) =>
    field.section === section &&
    field.path !== 'openRouter.modelId' &&
    field.path !== 'openRouter.reasoningEffort' &&
    (field.path !== 'compaction.customModelId' || showCustomCompactionModel) &&
    (field.path !== 'memory.customModelId' || showCustomMemoryModel));
  const groups: { name: string; fields: EditableField[] }[] = [];
  for (const field of sectionFields) {
    const last = groups[groups.length - 1];
    if (last?.name === field.group) last.fields.push(field);
    else groups.push({ name: field.group, fields: [field] });
  }

  return (
    <div className="aurvin-admin-fields">
      {section === 'openrouter' ? (
        <div className="aurvin-admin-policy">
          <p>Data collection denied</p>
          <p>Transforms disabled</p>
        </div>
      ) : null}
      {groups.map((group) => (
        <fieldset key={group.name} className="aurvin-admin-fieldset">
          <legend>{group.name}</legend>
          {group.fields.map((field) => (
            <FieldControl
              key={field.path}
              field={field}
              value={fields[field.path]}
              original={original?.[field.path]}
              errors={errors}
              disabled={disabled}
              models={models}
              modelsLoading={modelsLoading}
              modelsError={modelsError}
              onRetryModels={onRetryModels}
              onChange={onChange}
            />
          ))}
          {section === 'compaction' && group.name === 'User memory' ? (
            <div className="aurvin-admin-field">
              <button
                type="button"
                className="aurvin-admin-button"
                disabled={disabled}
                onClick={() => {
                  const mapped = applyCompactionModelToMemory(fields);
                  onChange('memory.modelMode', mapped.modelMode);
                  if (mapped.modelMode === 'custom') {
                    onChange('memory.customModelId', mapped.customModelId);
                  }
                }}
              >
                Use compaction model
              </button>
              <p className="aurvin-admin-help">
                Copies the current compaction model (Main chat model or custom compaction model ID;
                not a live link).
              </p>
            </div>
          ) : null}
          {section === 'chat' && group.name === 'Input and context' && floor ? (
            <p className="aurvin-admin-help">
              Saved server context floor: {floor.minContextTokens} tokens = prefix{' '}
              {floor.prefixTokens} (fixed {floor.breakdown.fixed} + personalization{' '}
              {floor.breakdown.personalization} + tools {floor.breakdown.tools}) + history{' '}
              {floor.historyTokens} + output {floor.reserves.maxOutputTokens} + margin{' '}
              {floor.reserves.modelMarginTokens}. The backend estimates in bytes; this is not a
              tokenizer count.
            </p>
          ) : null}
        </fieldset>
      ))}
    </div>
  );
}
