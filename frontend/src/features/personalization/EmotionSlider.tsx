/**
 * ============================================================================
 * FILE: EmotionSlider.tsx
 * LOCATION: frontend/src/features/personalization/EmotionSlider.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render an accessible, spring-animated 3-stop segmented pill slider.
 *
 * ROLE IN PROJECT:
 *    Powers Warmth, Enthusiasm, and Emoji tuning in PersonalizationPanel with
 *    clickable stops, pointer drag scrubbing, ARIA slider keyboard support,
 *    and reduced-motion compliance.
 *
 * KEY COMPONENTS:
 *    - EmotionSlider: Controlled 3-stop slider component ('low' | 'medium' | 'high').
 * ============================================================================
 */

import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import {
  PERSONALIZATION_AMPLITUDES,
  type PersonalizationAmplitude,
} from '../../api/personalization-protocol.ts';

export type EmotionSliderProps = {
  id: string;
  label: string;
  description: string;
  value: PersonalizationAmplitude;
  disabled?: boolean;
  onChange: (next: PersonalizationAmplitude) => void;
};

const STOP_COPY: Record<PersonalizationAmplitude, { short: string; aria: string }> = {
  low: { short: 'Low', aria: 'Low' },
  medium: { short: 'Medium (Default)', aria: 'Medium (Default)' },
  high: { short: 'High', aria: 'High' },
};

function stopIndex(value: PersonalizationAmplitude): 0 | 1 | 2 {
  if (value === 'low') return 0;
  if (value === 'high') return 2;
  return 1;
}

function amplitudeAtRatio(ratio: number): PersonalizationAmplitude {
  if (ratio < 0.25) return 'low';
  if (ratio > 0.75) return 'high';
  return 'medium';
}

export function EmotionSlider({
  id,
  label,
  description,
  value,
  disabled = false,
  onChange,
}: EmotionSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const pointerActiveRef = useRef(false);

  const index = stopIndex(value);
  const ratio = dragRatio ?? index / 2;

  const updateFromClientX = (clientX: number, commit: boolean) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const raw = (clientX - rect.left) / rect.width;
    const clamped = Math.max(0, Math.min(1, raw));
    if (commit) {
      setDragRatio(null);
      const next = amplitudeAtRatio(clamped);
      if (next !== value) onChange(next);
    } else {
      setDragRatio(clamped);
      const snapped = amplitudeAtRatio(clamped);
      if (snapped !== value) onChange(snapped);
    }
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    pointerActiveRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateFromClientX(event.clientX, false);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointerActiveRef.current || disabled) return;
    updateFromClientX(event.clientX, false);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointerActiveRef.current) return;
    pointerActiveRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    updateFromClientX(event.clientX, true);
  };

  const handlePointerCancel = () => {
    pointerActiveRef.current = false;
    setDragRatio(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = PERSONALIZATION_AMPLITUDES[Math.min(2, index + 1)];
      if (next !== value) onChange(next);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      const next = PERSONALIZATION_AMPLITUDES[Math.max(0, index - 1)];
      if (next !== value) onChange(next);
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (value !== 'low') onChange('low');
    } else if (event.key === 'End') {
      event.preventDefault();
      if (value !== 'high') onChange('high');
    }
  };

  const styleVars = {
    '--slider-ratio': String(ratio),
    '--slider-index': String(index),
  } as CSSProperties;

  return (
    <div
      className={`aurvin-emotion-row${dragRatio !== null ? ' is-dragging' : ''}${
        disabled ? ' is-disabled' : ''
      }`}
      data-value={value}
    >
      <div className="aurvin-emotion-header">
        <div className="aurvin-emotion-title-group">
          <span id={`${id}-label`} className="aurvin-emotion-label">
            {label}
          </span>
          <p id={`${id}-desc`} className="aurvin-emotion-desc">
            {description}
          </p>
        </div>
        <span className="aurvin-emotion-badge" data-level={value} aria-hidden="true">
          {STOP_COPY[value].short}
        </span>
      </div>

      <div className="aurvin-emotion-control" style={styleVars}>
        <div
          ref={trackRef}
          id={id}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-desc`}
          aria-valuemin={0}
          aria-valuemax={2}
          aria-valuenow={index}
          aria-valuetext={STOP_COPY[value].aria}
          aria-disabled={disabled || undefined}
          className="aurvin-emotion-rail"
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <span className="aurvin-emotion-track" aria-hidden="true">
            <span className="aurvin-emotion-fill" />
            <span className="aurvin-emotion-pips">
              <span className={`aurvin-emotion-pip${index >= 0 ? ' is-lit' : ''}`} />
              <span className={`aurvin-emotion-pip${index >= 1 ? ' is-lit' : ''}`} />
              <span className={`aurvin-emotion-pip${index >= 2 ? ' is-lit' : ''}`} />
            </span>
            <span className="aurvin-emotion-thumb" />
          </span>
        </div>

        <div className="aurvin-emotion-stops" role="group" aria-label={`${label} presets`}>
          {PERSONALIZATION_AMPLITUDES.map(stop => {
            const active = value === stop;
            return (
              <button
                key={stop}
                type="button"
                className={`aurvin-emotion-stop${active ? ' is-active' : ''}`}
                disabled={disabled}
                aria-pressed={active}
                onClick={() => {
                  if (!disabled && stop !== value) onChange(stop);
                }}
              >
                {STOP_COPY[stop].short}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
