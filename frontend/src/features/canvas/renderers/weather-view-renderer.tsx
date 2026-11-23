/**
 * ============================================================================
 * FILE: weather-view-renderer.tsx
 * LOCATION: frontend/src/features/canvas/renderers/weather-view-renderer.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render structured WeatherView snapshots inside Aurvin's Canvas panel.
 *
 * ROLE IN PROJECT:
 *    Presents location provenance, an inline Change city form, hero current
 *    conditions with inline WMO SVG icons, scrollable hourly cards, multi-day
 *    temperature range rows, Open-Meteo CC BY 4.0 attribution, and an isolated
 *    error boundary so display errors never affect chat or live voice.
 *
 * KEY COMPONENTS:
 *    - WeatherGlyph: Zero-dependency inline SVG icons mapped from WMO codes.
 *    - WeatherViewRenderer: Accessible scrollable structured weather card.
 *    - WeatherViewBoundary: Snapshot-keyed render-error containment.
 * ============================================================================
 */

import { Component, useState, type FormEvent, type ReactNode } from 'react';
import {
  OPEN_METEO_ATTRIBUTION_URL,
  isSafeOpenMeteoUrl,
  type WeatherLocation,
  type WeatherLocationSource,
  type WeatherView,
} from '../../../api/weather-protocol.ts';

const WEEKDAYS_UTC = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS_UTC = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function formatWeatherLocation(location: WeatherLocation): string {
  const parts = [location.city];
  if (location.region && location.region.toLowerCase() !== location.city.toLowerCase()) {
    parts.push(location.region);
  } else if (location.country && location.country.toLowerCase() !== location.city.toLowerCase()) {
    parts.push(location.country);
  }
  return parts.join(', ');
}

export function formatWeatherSourceLabel(source: WeatherLocationSource): string {
  switch (source) {
    case 'personalization':
      return 'Saved';
    case 'edge-geo':
      return 'Approximate';
    case 'explicit':
      return 'Requested';
  }
}

function formatHourLabel(isoTime: string): string {
  const match = /T(\d{2}:\d{2})/.exec(isoTime);
  return match?.[1] ?? isoTime;
}

function formatDayLabel(isoDate: string, index: number): string {
  if (index === 0) return 'Today';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(dt.getTime())) return isoDate;
  return `${WEEKDAYS_UTC[dt.getUTCDay()]}, ${MONTHS_UTC[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function formatCapturedAt(isoTimestamp: string): string {
  const dt = new Date(isoTimestamp);
  if (Number.isNaN(dt.getTime())) return isoTimestamp;
  const hh = String(dt.getUTCHours()).padStart(2, '0');
  const mm = String(dt.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS_UTC[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${hh}:${mm} UTC`;
}

export function WeatherGlyph({
  code,
  isDay = true,
  size = 24,
}: {
  code: number;
  isDay?: boolean;
  size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.8',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };

  if (code === 0) {
    return isDay ? (
      <svg {...common} data-weather-glyph="clear-day">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    ) : (
      <svg {...common} data-weather-glyph="clear-night">
        <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
      </svg>
    );
  }
  if (code >= 1 && code <= 2) {
    return (
      <svg {...common} data-weather-glyph="partly-cloudy">
        <path d="M12 3v1.5M5.6 5.6l1.1 1.1M18.4 5.6l-1.1 1.1" />
        <path d="M8.5 11a3.5 3.5 0 0 1 6.4-1.9" />
        <path d="M7 19h10a4 4 0 0 0 .8-7.9A5 5 0 0 0 8.2 10 3.5 3.5 0 0 0 7 19z" />
      </svg>
    );
  }
  if (code === 3) {
    return (
      <svg {...common} data-weather-glyph="overcast">
        <path d="M6.5 18h11a4 4 0 0 0 .7-7.9A5.5 5.5 0 0 0 7.6 8.8 4 4 0 0 0 6.5 18z" />
      </svg>
    );
  }
  if (code === 45 || code === 48) {
    return (
      <svg {...common} data-weather-glyph="fog">
        <path d="M4 9h16M3 13h18M6 17h12" />
      </svg>
    );
  }
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
    return (
      <svg {...common} data-weather-glyph="rain">
        <path d="M6.5 14h11a3.5 3.5 0 0 0 .6-6.9A5 5 0 0 0 8.1 6.2 3.5 3.5 0 0 0 6.5 14z" />
        <path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3" />
      </svg>
    );
  }
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) {
    return (
      <svg {...common} data-weather-glyph="snow">
        <path d="M6.5 14h11a3.5 3.5 0 0 0 .6-6.9A5 5 0 0 0 8.1 6.2 3.5 3.5 0 0 0 6.5 14z" />
        <path d="M9 17.5h.01M12 19h.01M15 17.5h.01" strokeWidth="2.4" />
      </svg>
    );
  }
  if (code >= 95 && code <= 99) {
    return (
      <svg {...common} data-weather-glyph="thunderstorm">
        <path d="M6.5 13.5h11a3.5 3.5 0 0 0 .6-6.9A5 5 0 0 0 8.1 5.7 3.5 3.5 0 0 0 6.5 13.5z" />
        <path d="M13 13.5l-2.5 4h3L11 21.5" />
      </svg>
    );
  }
  return (
    <svg {...common} data-weather-glyph="overcast">
      <path d="M6.5 18h11a4 4 0 0 0 .7-7.9A5.5 5.5 0 0 0 7.6 8.8 4 4 0 0 0 6.5 18z" />
    </svg>
  );
}

export function WeatherViewRenderer({
  view,
  onChangeCity,
  changeCityDisabled = false,
  liveVoiceActive = false,
  onOpenPersonalization,
  defaultEditingCity = false,
}: {
  view: WeatherView | null;
  onChangeCity?: (city: string) => void;
  changeCityDisabled?: boolean;
  liveVoiceActive?: boolean;
  onOpenPersonalization?: () => void;
  defaultEditingCity?: boolean;
}) {
  const [editingCity, setEditingCity] = useState(defaultEditingCity);
  const [cityInput, setCityInput] = useState('');

  if (!view) {
    return (
      <div className="aurvin-weather-card">
        <p role="status">Weather details are unavailable.</p>
      </div>
    );
  }

  const tempUnit = view.units === 'imperial' ? '°F' : '°C';
  const windUnit = view.units === 'imperial' ? 'mph' : 'km/h';
  const locationLabel = formatWeatherLocation(view.location);
  const sourceLabel = formatWeatherSourceLabel(view.location.source);
  const today = view.daily[0];
  const attributionUrl = isSafeOpenMeteoUrl(view.attribution.url)
    ? view.attribution.url
    : OPEN_METEO_ATTRIBUTION_URL;

  const dailyTemps = view.daily.flatMap((d) => [d.tempMin, d.tempMax]);
  const globalMin = dailyTemps.length > 0 ? Math.min(...dailyTemps) : 0;
  const globalMax = dailyTemps.length > 0 ? Math.max(...dailyTemps) : 1;
  const globalSpan = Math.max(1, globalMax - globalMin);

  const handleCitySubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = cityInput.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
    if (!trimmed || !onChangeCity || changeCityDisabled || liveVoiceActive) return;
    onChangeCity(trimmed);
    setCityInput('');
    setEditingCity(false);
  };

  return (
    <section
      className="aurvin-weather-card"
      aria-label={`Weather forecast for ${locationLabel}`}
      data-weather-units={view.units}
      data-location-source={view.location.source}
    >
      <header className="aurvin-weather-header">
        <div className="aurvin-weather-location-group">
          <div className="aurvin-weather-location-row">
            <h2 className="aurvin-weather-location">{locationLabel}</h2>
            <span className="aurvin-weather-source-badge">{sourceLabel}</span>
          </div>
          <p className="aurvin-weather-captured">
            Updated <time dateTime={view.capturedAt}>{formatCapturedAt(view.capturedAt)}</time>
          </p>
        </div>

        <button
          type="button"
          className="aurvin-weather-change-city-btn"
          aria-expanded={editingCity}
          onClick={() => setEditingCity((open) => !open)}
        >
          Change city
        </button>
      </header>

      {editingCity ? (
        <div className="aurvin-weather-city-panel">
          {liveVoiceActive ? (
            <p className="aurvin-weather-city-hint" role="status">
              Ask aloud for another city, or end voice to type a city.
            </p>
          ) : (
            <form className="aurvin-weather-city-form" onSubmit={handleCitySubmit}>
              <input
                type="text"
                className="aurvin-weather-city-input"
                aria-label="City name"
                placeholder="Enter a city (e.g. Tokyo, London)"
                maxLength={100}
                value={cityInput}
                disabled={changeCityDisabled}
                onChange={(e) => setCityInput(e.target.value)}
              />
              <button
                type="submit"
                className="aurvin-weather-city-submit"
                disabled={changeCityDisabled || !cityInput.trim() || !onChangeCity}
              >
                Check
              </button>
              <button
                type="button"
                className="aurvin-weather-city-cancel"
                onClick={() => {
                  setEditingCity(false);
                  setCityInput('');
                }}
              >
                Cancel
              </button>
            </form>
          )}
          {onOpenPersonalization && !liveVoiceActive ? (
            <button
              type="button"
              className="aurvin-weather-personalization-link"
              onClick={onOpenPersonalization}
            >
              Save default city in Personalization
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="aurvin-weather-hero">
        <div className="aurvin-weather-hero-main">
          <span className="aurvin-weather-hero-icon">
            <WeatherGlyph code={view.current.weatherCode} isDay={view.current.isDay} size={44} />
          </span>
          <div className="aurvin-weather-hero-temp-block">
            <p className="aurvin-weather-temp">
              {Math.round(view.current.temperature)}
              {tempUnit}
            </p>
            <p className="aurvin-weather-condition">{view.current.condition}</p>
          </div>
        </div>

        <dl className="aurvin-weather-metrics">
          <div className="aurvin-weather-metric">
            <dt>Feels like</dt>
            <dd>
              {Math.round(view.current.apparentTemperature)}
              {tempUnit}
            </dd>
          </div>
          {today ? (
            <div className="aurvin-weather-metric">
              <dt>Today</dt>
              <dd>
                H: {Math.round(today.tempMax)}° · L: {Math.round(today.tempMin)}°
              </dd>
            </div>
          ) : null}
          {view.current.humidityPercent !== undefined ? (
            <div className="aurvin-weather-metric">
              <dt>Humidity</dt>
              <dd>{Math.round(view.current.humidityPercent)}%</dd>
            </div>
          ) : null}
          {view.current.windSpeed !== undefined ? (
            <div className="aurvin-weather-metric">
              <dt>Wind</dt>
              <dd>
                {Math.round(view.current.windSpeed)} {windUnit}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      {view.hourly.length > 0 ? (
        <section className="aurvin-weather-section" aria-label="Hourly forecast">
          <h3 className="aurvin-weather-section-title">Hourly forecast</h3>
          <div className="aurvin-weather-hourly-strip" role="list">
            {view.hourly.map((hour) => (
              <div key={hour.time} className="aurvin-weather-hourly-card" role="listitem">
                <span className="aurvin-weather-hourly-time">{formatHourLabel(hour.time)}</span>
                <span className="aurvin-weather-hourly-icon">
                  <WeatherGlyph code={hour.weatherCode} size={22} />
                </span>
                <span className="aurvin-weather-hourly-temp">{Math.round(hour.temperature)}°</span>
                {hour.precipitationProbability !== undefined ? (
                  <span className="aurvin-weather-precip">{Math.round(hour.precipitationProbability)}%</span>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {view.daily.length > 0 ? (
        <section className="aurvin-weather-section" aria-label="Multi-day forecast">
          <h3 className="aurvin-weather-section-title">Forecast</h3>
          <ul className="aurvin-weather-daily-list">
            {view.daily.map((day, index) => {
              const leftPct = Math.max(0, Math.min(100, ((day.tempMin - globalMin) / globalSpan) * 100));
              const widthPct = Math.max(8, Math.min(100 - leftPct, ((day.tempMax - day.tempMin) / globalSpan) * 100));
              return (
                <li key={day.date} className="aurvin-weather-daily-row">
                  <span className="aurvin-weather-daily-day">{formatDayLabel(day.date, index)}</span>
                  <span className="aurvin-weather-daily-icon">
                    <WeatherGlyph code={day.weatherCode} size={20} />
                  </span>
                  <span className="aurvin-weather-daily-condition">{day.condition}</span>
                  <span className="aurvin-weather-daily-precip">
                    {day.precipitationProbabilityMax !== undefined
                      ? `${Math.round(day.precipitationProbabilityMax)}%`
                      : ''}
                  </span>
                  <span className="aurvin-weather-daily-range">
                    <span className="aurvin-weather-daily-min">{Math.round(day.tempMin)}°</span>
                    <span className="aurvin-weather-range-track" aria-hidden="true">
                      <span
                        className="aurvin-weather-range-fill"
                        style={{ left: `${leftPct.toFixed(1)}%`, width: `${widthPct.toFixed(1)}%` }}
                      />
                    </span>
                    <span className="aurvin-weather-daily-max">{Math.round(day.tempMax)}°</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <footer className="aurvin-weather-footer">
        Weather data by{' '}
        <a href={attributionUrl} target="_blank" rel="noopener noreferrer">
          {view.attribution.label}
        </a>
        {' '}· CC BY 4.0
      </footer>
    </section>
  );
}

type BoundaryProps = { children: ReactNode; value: WeatherView | null };
type BoundaryState = { failed: boolean; value: WeatherView | null };

export class WeatherViewBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false, value: props.value };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState) {
    return props.value !== state.value ? { failed: false, value: props.value } : null;
  }

  render() {
    return this.state.failed ? (
      <p role="status">Weather display is unavailable. Voice and chat can continue.</p>
    ) : (
      this.props.children
    );
  }
}
