/**
 * ============================================================================
 * FILE: LocationCard.tsx
 * LOCATION: frontend/src/features/personalization/LocationCard.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render the optional city-level Location card inside PersonalizationPanel.
 *
 * ROLE IN PROJECT:
 *    Provides editable City, Region / State, and Country inputs, an explicit
 *    one-time Detect my location button, a conditional Clear location button,
 *    coarse coordinate feedback, and accessible alert errors.
 *
 * KEY COMPONENTS:
 *    - LocationCard: Controlled presentational card for SavedUserLocation.
 * ============================================================================
 */

import {
  MAX_LOCATION_FIELD_CHARS,
  type SavedUserLocation,
} from '../../api/personalization-protocol.ts';
import type { LocationTextField } from './personalization-state.ts';

export type LocationCardProps = {
  idPrefix: string;
  location: SavedUserLocation | null;
  disabled: boolean;
  detecting: boolean;
  error: string | null;
  onFieldChange: (field: LocationTextField, value: string) => void;
  onDetect: () => void;
  onClear: () => void;
};

export function LocationCard({
  idPrefix,
  location,
  disabled,
  detecting,
  error,
  onFieldChange,
  onDetect,
  onClear,
}: LocationCardProps) {
  const city = location?.city ?? '';
  const region = location?.region ?? '';
  const country = location?.country ?? '';
  const hasCoordinates =
    location?.latitude !== undefined && location?.longitude !== undefined;
  const helpId = `${idPrefix}-location-help`;
  const errorId = `${idPrefix}-location-error`;
  const describedBy = error ? `${helpId} ${errorId}` : helpId;

  return (
    <div className="aurvin-personalization-card">
      <div className="aurvin-personalization-field-top">
        <h3 className="aurvin-personalization-card-title">Location</h3>
        <div className="aurvin-personalization-location-actions">
          <button
            type="button"
            className="aurvin-personalization-btn"
            disabled={disabled}
            onClick={onDetect}
          >
            {detecting ? 'Detecting…' : 'Detect my location'}
          </button>
          {location !== null ? (
            <button
              type="button"
              className="aurvin-personalization-btn"
              disabled={disabled}
              onClick={onClear}
            >
              Clear location
            </button>
          ) : null}
        </div>
      </div>

      <p id={helpId} className="aurvin-personalization-help">
        Optional city-level location used on demand for local weather or nearby context. Detection
        runs only when you click Detect my location and rounds coordinates to city precision.
      </p>

      <div className="aurvin-personalization-location-grid">
        <div className="aurvin-personalization-location-field">
          <label
            htmlFor={`${idPrefix}-location-city`}
            className="aurvin-personalization-field-label"
          >
            City
          </label>
          <input
            id={`${idPrefix}-location-city`}
            type="text"
            className="aurvin-personalization-input"
            value={city}
            maxLength={MAX_LOCATION_FIELD_CHARS}
            disabled={disabled}
            placeholder="e.g., Austin"
            aria-describedby={describedBy}
            aria-invalid={error ? 'true' : undefined}
            onChange={event => onFieldChange('city', event.target.value)}
          />
        </div>

        <div className="aurvin-personalization-location-field">
          <label
            htmlFor={`${idPrefix}-location-region`}
            className="aurvin-personalization-field-label"
          >
            Region / State
          </label>
          <input
            id={`${idPrefix}-location-region`}
            type="text"
            className="aurvin-personalization-input"
            value={region}
            maxLength={MAX_LOCATION_FIELD_CHARS}
            disabled={disabled}
            placeholder="e.g., Texas"
            aria-describedby={describedBy}
            onChange={event => onFieldChange('region', event.target.value)}
          />
        </div>

        <div className="aurvin-personalization-location-field">
          <label
            htmlFor={`${idPrefix}-location-country`}
            className="aurvin-personalization-field-label"
          >
            Country
          </label>
          <input
            id={`${idPrefix}-location-country`}
            type="text"
            className="aurvin-personalization-input"
            value={country}
            maxLength={MAX_LOCATION_FIELD_CHARS}
            disabled={disabled}
            placeholder="e.g., United States"
            aria-describedby={describedBy}
            onChange={event => onFieldChange('country', event.target.value)}
          />
        </div>
      </div>

      {hasCoordinates ? (
        <p className="aurvin-personalization-coords">
          Coarse coordinates ready to save: {location.latitude!.toFixed(2)},{' '}
          {location.longitude!.toFixed(2)} (editing city, region, or country clears coordinates)
        </p>
      ) : null}

      {error ? (
        <p id={errorId} className="aurvin-personalization-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
