/**
 * ============================================================================
 * FILE: weather-view-renderer.test.ts
 * LOCATION: frontend/src/features/canvas/renderers/weather-view-renderer.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify WeatherViewRenderer markup, WMO SVG icons, source badges, Change city
 *    inline controls, Open-Meteo attribution, and error boundary isolation.
 *
 * ROLE IN PROJECT:
 *    Tests the structured Weather Canvas card in Node Vitest using React
 *    renderToStaticMarkup without requiring a browser DOM.
 *
 * KEY COMPONENTS:
 *    - WeatherViewRenderer static HTML & interactive state assertions.
 *    - WeatherViewBoundary derived-state reset check.
 *    - formatWeatherLocation / formatWeatherSourceLabel helper checks.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WeatherView } from '../../../api/weather-protocol.ts';
import { ArtifactKindIcon } from '../CanvasArtifactCard.tsx';
import {
  WeatherViewBoundary,
  WeatherViewRenderer,
  formatWeatherLocation,
  formatWeatherSourceLabel,
} from './weather-view-renderer.tsx';

const sampleView = (overrides: Partial<WeatherView> = {}): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:30:00.000Z',
  units: 'metric',
  location: {
    city: 'Chennai',
    region: 'Tamil Nadu',
    country: 'India',
    source: 'personalization',
  },
  current: {
    temperature: 30.4,
    apparentTemperature: 34.1,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14.5,
    isDay: true,
  },
  hourly: [
    { time: '2026-11-19T12:00', temperature: 31.2, weatherCode: 2, precipitationProbability: 15 },
    { time: '2026-11-19T13:00', temperature: 31.8, weatherCode: 61, precipitationProbability: 65 },
  ],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32.4,
      tempMin: 25.6,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
    {
      date: '2026-11-20',
      tempMax: 30.0,
      tempMin: 24.0,
      weatherCode: 63,
      condition: 'Moderate rain',
      precipitationProbabilityMax: 80,
    },
  ],
  attribution: {
    label: 'Open-Meteo',
    url: 'https://open-meteo.com/',
  },
  ...overrides,
});

describe('WeatherViewRenderer', () => {
  it('renders location, source badge, hero metrics, hourly strip, daily rows, and CC BY 4.0 Open-Meteo link', () => {
    const html = renderToStaticMarkup(
      createElement(WeatherViewRenderer, {
        view: sampleView(),
        onChangeCity: vi.fn(),
        onOpenPersonalization: vi.fn(),
      }),
    );

    expect(html).toContain('Chennai, Tamil Nadu');
    expect(html).toContain('Saved');
    expect(html).toContain('Change city');
    expect(html).toContain('30°C');
    expect(html).toContain('Partly cloudy');
    expect(html).toContain('Feels like');
    expect(html).toContain('34°C');
    expect(html).toContain('72%');
    expect(html).toContain('15 km/h');
    expect(html).toContain('H: 32°');
    expect(html).toContain('L: 26°');
    expect(html).toContain('12:00');
    expect(html).toContain('65%');
    expect(html).toContain('Moderate rain');
    expect(html).toContain('80%');
    expect(html).toContain('Weather data by');
    expect(html).toContain('CC BY 4.0');
    expect(html).toContain('href="https://open-meteo.com/"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<svg');
  });

  it('formats imperial units and all three location source badges accurately', () => {
    expect(formatWeatherSourceLabel('personalization')).toBe('Saved');
    expect(formatWeatherSourceLabel('edge-geo')).toBe('Approximate');
    expect(formatWeatherSourceLabel('explicit')).toBe('Requested');
    expect(formatWeatherLocation({ city: 'Tokyo', country: 'Japan', source: 'explicit' })).toBe('Tokyo, Japan');
    expect(formatWeatherLocation({ city: 'Singapore', region: 'Singapore', source: 'explicit' })).toBe('Singapore');

    const imperialHtml = renderToStaticMarkup(
      createElement(WeatherViewRenderer, {
        view: sampleView({
          units: 'imperial',
          location: { city: 'Austin', region: 'Texas', country: 'US', source: 'edge-geo' },
          current: {
            temperature: 78.6,
            apparentTemperature: 80.2,
            weatherCode: 0,
            condition: 'Clear sky',
            humidityPercent: 45,
            windSpeed: 9.4,
            isDay: false,
          },
        }),
      }),
    );
    expect(imperialHtml).toContain('Austin, Texas');
    expect(imperialHtml).toContain('Approximate');
    expect(imperialHtml).toContain('79°F');
    expect(imperialHtml).toContain('9 mph');
  });

  it('renders inline Change city form when defaultEditingCity is enabled and shows live voice hint when voice is active', () => {
    const formHtml = renderToStaticMarkup(
      createElement(WeatherViewRenderer, {
        view: sampleView(),
        defaultEditingCity: true,
        onChangeCity: vi.fn(),
        onOpenPersonalization: vi.fn(),
      }),
    );
    expect(formHtml).toContain('aurvin-weather-city-form');
    expect(formHtml).toContain('aria-label="City name"');
    expect(formHtml).toContain('Save default city in Personalization');

    const voiceHtml = renderToStaticMarkup(
      createElement(WeatherViewRenderer, {
        view: sampleView(),
        defaultEditingCity: true,
        liveVoiceActive: true,
      }),
    );
    expect(voiceHtml).toContain('Ask aloud for another city');
  });

  it('renders dedicated weather icon in ArtifactKindIcon and resets WeatherViewBoundary only on new snapshots', () => {
    const iconHtml = renderToStaticMarkup(createElement(ArtifactKindIcon, { kind: 'weather', size: 16 }));
    expect(iconHtml).toContain('<svg');
    expect(iconHtml).toContain('data-icon="weather"');

    const v1 = sampleView();
    const state = { value: v1, failed: true };
    expect(WeatherViewBoundary.getDerivedStateFromProps({ value: v1, children: null }, state)).toBeNull();
    expect(
      WeatherViewBoundary.getDerivedStateFromProps({ value: sampleView({ units: 'imperial' }), children: null }, state),
    ).toMatchObject({ failed: false });
  });
});
