/**
 * ============================================================================
 * FILE: AdminSelect.tsx
 * LOCATION: frontend/src/features/admin-config/AdminSelect.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render a dark/light-theme-consistent custom select dropdown for admin settings.
 *
 * ROLE IN PROJECT:
 *    Replaces unstyled native OS <select> popups in AdminDashboard forms so
 *    option lists match Aurvin's surface tokens and stay legible in dark mode.
 *
 * KEY COMPONENTS:
 *    - AdminSelectOption: Option value, label, optional sublabel, and disabled flag.
 *    - AdminSelect: Accessible combobox trigger with keyboard-navigable listbox.
 * ============================================================================
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export type AdminSelectOption = {
  value: string;
  label: string;
  note?: string;
  disabled?: boolean;
};

export type AdminSelectProps = {
  id: string;
  value: string;
  options: readonly AdminSelectOption[];
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  onChange: (value: string) => void;
};

function firstEnabledIndex(options: readonly AdminSelectOption[], preferredValue: string): number {
  const current = options.findIndex((opt) => opt.value === preferredValue && !opt.disabled);
  if (current >= 0) return current;
  return options.findIndex((opt) => !opt.disabled);
}

function nextEnabledIndex(
  options: readonly AdminSelectOption[],
  from: number,
  delta: 1 | -1,
): number {
  if (options.length === 0) return -1;
  let index = from;
  for (let step = 0; step < options.length; step += 1) {
    index = (index + delta + options.length) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}

export function AdminSelect({
  id,
  value,
  options,
  disabled = false,
  invalid = false,
  describedBy,
  placeholder = 'Select…',
  onChange,
}: AdminSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => firstEnabledIndex(options, value));
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const isOpen = open && !disabled;
  const selected = options.find((opt) => opt.value === value);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    queueMicrotask(() => {
      listboxRef.current?.focus();
    });
  }, [isOpen]);

  const selectOption = (opt: AdminSelectOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  };

  const openMenu = () => {
    if (disabled) return;
    setActiveIndex(firstEnabledIndex(options, value));
    setOpen(true);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (isOpen) {
        setOpen(false);
      } else {
        openMenu();
      }
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      queueMicrotask(() => triggerRef.current?.focus());
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => nextEnabledIndex(options, prev < 0 ? -1 : prev, 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => nextEnabledIndex(options, prev < 0 ? 0 : prev, -1));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const target = options[activeIndex];
      if (target && !target.disabled) selectOption(target);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className={`aurvin-admin-dropdown${isOpen ? ' is-open' : ''}`}>
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
        onClick={() => (isOpen ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="aurvin-admin-dropdown-value">
          <span className={selected ? 'aurvin-admin-dropdown-primary' : 'aurvin-admin-dropdown-placeholder'}>
            {selected ? selected.label : placeholder}
          </span>
          {selected?.note ? (
            <span className="aurvin-admin-dropdown-note">{selected.note}</span>
          ) : null}
        </span>
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
      </button>

      <div
        ref={listboxRef}
        id={listboxId}
        role="listbox"
        tabIndex={-1}
        hidden={!isOpen}
        className="aurvin-admin-dropdown-menu"
        aria-activedescendant={isOpen && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
        onKeyDown={onListKeyDown}
      >
        <div className="aurvin-admin-dropdown-list">
          {options.map((opt, index) => {
            const isSelected = opt.value === value;
            const isActive = index === activeIndex;
            return (
              <button
                key={opt.value}
                id={`${listboxId}-opt-${index}`}
                type="button"
                role="option"
                value={opt.value}
                disabled={opt.disabled}
                aria-selected={isSelected}
                className={`aurvin-admin-dropdown-option${isSelected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
                onMouseEnter={() => {
                  if (!opt.disabled) setActiveIndex(index);
                }}
                onClick={() => selectOption(opt)}
              >
                <span className="aurvin-admin-dropdown-option-text">
                  <span className="aurvin-admin-dropdown-option-title">{opt.label}</span>
                  {opt.note ? (
                    <span className="aurvin-admin-dropdown-option-sub">{opt.note}</span>
                  ) : null}
                </span>
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
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
