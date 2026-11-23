/**
 * ============================================================================
 * FILE: weather-canvas-panel.test.ts
 * LOCATION: frontend/src/features/canvas/weather-canvas-panel.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify CanvasPanel renders structured Weather artifacts in a scrollable
 *    body without pan/zoom/code/download controls and resolves weather aliases.
 *
 * ROLE IN PROJECT:
 *    Pins CanvasPanel's structured-view parity between Calendar and Weather
 *    artifacts, including toArtifactPath and scroll-mode control behavior.
 *
 * KEY COMPONENTS:
 *    - CanvasPanel weather rendering & toolbar suppression checks.
 *    - toArtifactPath weather extension check.
 *    - applyCanvasControl scroll-mode check for weather body.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WeatherView } from '../../api/weather-protocol.ts';
import { applyCanvasControl, DEFAULT_CANVAS_VIEW } from './canvas-controls.ts';
import { CanvasPanel, toArtifactPath } from './CanvasPanel.tsx';
import { weatherViewArtifact } from './weather-workspace.ts';

const sampleView = (): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:30:00.000Z',
  units: 'metric',
  location: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', source: 'explicit' },
  current: {
    temperature: 30,
    apparentTemperature: 34,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14,
    isDay: true,
  },
  hourly: [{ time: '2026-11-19T12:00', temperature: 31, weatherCode: 2, precipitationProbability: 15 }],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32,
      tempMin: 25,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
  ],
  attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
});

describe('CanvasPanel weather structured mode', () => {
  it('renders scrollable weather body without diagram zoom/code/download controls and resolves alias IDs', () => {
    const artifact = {
      ...weatherViewArtifact(sampleView(), 'msg-w1', 'turn-w1'),
      weatherAliases: ['weather:turn-w1::canvas::weather', 'msg-w1::canvas::weather'],
    };

    expect(toArtifactPath(artifact)).toBe('canvas/weather-chennai.weather.json');

    const html = renderToStaticMarkup(
      createElement(CanvasPanel, {
        artifacts: [artifact],
        activeArtifactId: 'weather:turn-w1::canvas::weather',
        onSelectArtifact: vi.fn(),
        onCloseTab: vi.fn(),
        onClosePanel: vi.fn(),
        onChangeCity: vi.fn(),
        onOpenPersonalization: vi.fn(),
      }),
    );

    expect(html).toContain('aurvin-canvas-weather-body');
    expect(html).toContain('Chennai, Tamil Nadu');
    expect(html).toContain('Change city');
    expect(html).toContain('Open-Meteo');
    expect(html).not.toContain('Zoom in');
    expect(html).not.toContain('Copy artifact source');
    expect(html).not.toContain('Download artifact');
    expect(html).not.toContain('>Code<');
  });

  it('supports scroll, fullscreen, and close in scroll mode while rejecting zoom controls', () => {
    const body = { scrollTop: 0, scrollLeft: 0, clientHeight: 400, clientWidth: 500, scrollHeight: 1200, scrollWidth: 500 };
    const setMaximized = vi.fn();
    const close = vi.fn();
    const port = {
      mode: 'scroll' as const,
      open: true,
      getView: () => DEFAULT_CANVAS_VIEW,
      setView: vi.fn(),
      viewport: null,
      stage: null,
      body,
      close,
      setMaximized,
    };

    expect(applyCanvasControl({ action: 'scroll', direction: 'down' }, port)).toBe('applied');
    expect(body.scrollTop).toBe(300);
    expect(applyCanvasControl({ action: 'zoom_in' }, port)).toBe('unsupported');
    expect(applyCanvasControl({ action: 'fullscreen', state: 'enter' }, port)).toBe('applied');
    expect(setMaximized).toHaveBeenCalledWith(true);
    expect(applyCanvasControl({ action: 'close' }, port)).toBe('applied');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
