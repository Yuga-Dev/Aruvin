/**
 * ============================================================================
 * FILE: weather-workspace.test.ts
 * LOCATION: frontend/src/features/canvas/weather-workspace.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Weather Canvas artifact extraction, live voice folding/merging,
 *    voice auto-open claiming, and bounded canvas.inventory ownership.
 *
 * ROLE IN PROJECT:
 *    Ensures archived weather messages and live weather.frame updates converge
 *    without duplicate tabs, auto-open only once per live turn, and publish
 *    weather owner references accepted by backend ownsCanvas().
 *
 * KEY COMPONENTS:
 *    - foldWeatherFrame / mergeWeatherWorkspaces / claimWeatherAutoOpenId tests.
 *    - collectSessionCanvasArtifacts weatherView extraction tests.
 *    - canvasInventory weather owner projection tests.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import type { VisibleMessage } from '../../api/protocol.ts';
import type { WeatherFramePayload } from '../../api/voice-protocol.ts';
import type { WeatherView } from '../../api/weather-protocol.ts';
import { collectSessionCanvasArtifacts } from './canvas-artifacts.ts';
import { canvasInventory } from './canvas-navigation.ts';
import {
  claimWeatherAutoOpenId,
  foldWeatherFrame,
  matchesCanvasArtifact,
  mergeWeatherWorkspaces,
  weatherViewArtifact,
} from './weather-workspace.ts';

const sampleView = (city = 'Chennai'): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:00:00.000Z',
  units: 'metric',
  location: { city, region: 'Tamil Nadu', country: 'India', source: 'explicit' },
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

const frame = (turnId: string, city = 'Chennai'): WeatherFramePayload => ({
  type: 'weather.frame',
  turnId,
  attemptId: `att-${turnId}`,
  responseId: `resp-${turnId}`,
  view: sampleView(city),
});

const weatherMessage = (overrides: Partial<VisibleMessage> = {}): VisibleMessage => ({
  messageId: 'msg-w1',
  turnId: 'turn-w1',
  eventId: 'evt-w1',
  sequence: 1,
  role: 'assistant',
  content: 'It is 30°C and partly cloudy in Chennai.',
  createdAt: '2026-11-19T06:00:01.000Z',
  completionStatus: 'completed',
  truncated: false,
  weatherView: sampleView('Chennai'),
  ...overrides,
});

describe('weather workspace and Canvas artifact extraction', () => {
  it('extracts structured weather artifacts only from assistant messages with valid weatherView', () => {
    const items = collectSessionCanvasArtifacts([weatherMessage()], '', false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      artifactId: 'msg-w1::canvas::weather',
      messageId: 'msg-w1',
      turnId: 'turn-w1',
      kind: 'weather',
      subType: 'Weather',
      title: 'Weather · Chennai',
      buttonLabel: 'View weather in Canvas',
      isStreaming: false,
    });
    expect(collectSessionCanvasArtifacts([weatherMessage({ role: 'user' })], '', false)).toEqual([]);
  });

  it('folds live weather frames, merges without duplicating archived turns, and preserves aliases', () => {
    let workspaces = foldWeatherFrame([], frame('turn-w1', 'Chennai'));
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.id).toBe('weather:turn-w1');

    // Updating the same turn replaces view in place without duplicating workspace
    workspaces = foldWeatherFrame(workspaces, frame('turn-w1', 'Bengaluru'));
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.view.location.city).toBe('Bengaluru');

    const archived = collectSessionCanvasArtifacts([weatherMessage()], '', false);
    const liveMerged = mergeWeatherWorkspaces(archived, workspaces, true);
    expect(liveMerged).toHaveLength(1);
    expect(liveMerged[0]!.artifactId).toBe('weather:turn-w1::canvas::weather');
    expect(matchesCanvasArtifact(liveMerged[0]!, 'msg-w1::canvas::weather')).toBe(true);
    expect(matchesCanvasArtifact(liveMerged[0]!, 'weather:turn-w1::canvas::weather')).toBe(true);

    const settled = mergeWeatherWorkspaces(archived, workspaces, false);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.artifactId).toBe('msg-w1::canvas::weather');
    expect(matchesCanvasArtifact(settled[0]!, 'weather:turn-w1::canvas::weather')).toBe(true);
  });

  it('claims auto-open ID only once per new live voice weather workspace', () => {
    const seen = new Set<string>();
    const w1 = foldWeatherFrame([], frame('turn-w1', 'Chennai'));
    const artifacts1 = mergeWeatherWorkspaces([], w1, true);
    const base = {
      live: true,
      conversationId: 'chat-1',
      selectedId: 'chat-1',
      workspaces: w1,
      artifacts: artifacts1,
      seen,
    };

    expect(claimWeatherAutoOpenId({ ...base, live: false })).toBeNull();
    expect(claimWeatherAutoOpenId({ ...base, selectedId: 'chat-2' })).toBeNull();
    expect(claimWeatherAutoOpenId(base)).toBe('weather:turn-w1::canvas::weather');
    // Respects manual dismissal on subsequent renders for the same workspace
    expect(claimWeatherAutoOpenId(base)).toBeNull();

    const w2 = foldWeatherFrame(w1, frame('turn-w2', 'Tokyo'));
    expect(
      claimWeatherAutoOpenId({
        ...base,
        workspaces: w2,
        artifacts: mergeWeatherWorkspaces([], w2, true),
      }),
    ).toBe('weather:turn-w2::canvas::weather');
  });

  it('publishes weather owner refs in canvasInventory for both live and archived weather cards', () => {
    const archived = weatherViewArtifact(sampleView('London'), 'msg-w1', 'turn-w1');
    const liveWorkspaces = foldWeatherFrame([], frame('turn-w2', 'Tokyo'));
    const merged = mergeWeatherWorkspaces([archived], liveWorkspaces, true);
    const inv = canvasInventory(merged);
    expect(inv.items).toEqual([
      {
        canvasId: 'weather:turn-w2::canvas::weather',
        title: 'Weather · Tokyo',
        owner: { kind: 'weather', id: 'turn-w2' },
      },
      {
        canvasId: 'msg-w1::canvas::weather',
        title: 'Weather · London',
        owner: { kind: 'weather', id: 'msg-w1' },
      },
    ]);
  });
});
