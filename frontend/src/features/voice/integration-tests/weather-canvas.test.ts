/**
 * ============================================================================
 * FILE: weather-canvas.test.ts
 * LOCATION: frontend/src/features/voice/integration-tests/weather-canvas.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    End-to-end frontend integration tests for live voice weather.frame handling,
 *    voice-first auto-open, dismissal stickiness, and control_canvas reopening.
 *
 * ROLE IN PROJECT:
 *    Exercises LiveVoiceController, liveVoiceReducer, mergeWeatherWorkspaces,
 *    claimWeatherAutoOpenId, and canvasInventory together in Node Vitest.
 *
 * KEY COMPONENTS:
 *    - Live weather.frame fencing (ready, conversation, sequence, cancelled response).
 *    - Voice-first auto-open claiming and archived handoff without duplicate tabs.
 *    - canvas.show reopening a dismissed weather card via alias resolution.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import type { VisibleMessage } from '../../../api/protocol.ts';
import type { WeatherView } from '../../../api/weather-protocol.ts';
import { collectSessionCanvasArtifacts } from '../../canvas/canvas-artifacts.ts';
import { canvasInventory } from '../../canvas/canvas-navigation.ts';
import { claimWeatherAutoOpenId, mergeWeatherWorkspaces } from '../../canvas/weather-workspace.ts';
import type { LiveVoiceBindings } from '../state/live-voice-controller.ts';
import { liveVoiceFixture, settle } from '../state/testing/live-voice-fixture.ts';

const sampleView = (city = 'Chennai'): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:30:00.000Z',
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

describe('live voice weather Canvas integration', () => {
  it('accepts fenced weather.frame, auto-opens in live mode, publishes scroll inventory, and reopens via canvas.show', async () => {
    const openCanvasArtifact = vi.fn();
    const f = liveVoiceFixture({
      bindings: { openCanvasArtifact } as Partial<LiveVoiceBindings> as LiveVoiceBindings,
    });
    await f.begin();
    f.event({ type: 'conversation.bound', conversationId: 'chat-1' });
    f.selectConversation('chat-1');

    f.event({
      type: 'weather.frame',
      turnId: 'turn-w1',
      attemptId: 'att-w1',
      responseId: 'resp-w1',
      view: sampleView('Chennai'),
    });

    const snap = f.controller.getSnapshot();
    expect(snap.weatherWorkspaces).toHaveLength(1);
    expect(snap.weatherWorkspaces[0]).toMatchObject({
      id: 'weather:turn-w1',
      turnId: 'turn-w1',
    });

    // Reject wrong attempt for same turn
    f.event({
      type: 'weather.frame',
      turnId: 'turn-w1',
      attemptId: 'att-w2-stale',
      responseId: 'resp-w1',
      view: sampleView('Wrong'),
    });
    expect(f.controller.getSnapshot().weatherWorkspaces[0]!.view.location.city).toBe('Chennai');

    const seen = new Set<string>();
    const liveArtifacts = mergeWeatherWorkspaces([], snap.weatherWorkspaces, true);
    const autoOpenId = claimWeatherAutoOpenId({
      live: true,
      conversationId: snap.conversationId,
      selectedId: 'chat-1',
      workspaces: snap.weatherWorkspaces,
      artifacts: liveArtifacts,
      seen,
    });
    expect(autoOpenId).toBe('weather:turn-w1::canvas::weather');

    // Publish inventory and verify canvas.show reopens the weather card by archived alias
    const archivedMsg: VisibleMessage = {
      messageId: 'msg-w1',
      turnId: 'turn-w1',
      eventId: 'evt-w1',
      sequence: 1,
      role: 'assistant',
      content: 'It is 30°C in Chennai.',
      createdAt: '2026-11-19T06:30:01.000Z',
      completionStatus: 'completed',
      truncated: false,
      mode: 'live',
      weatherView: sampleView('Chennai'),
    };
    const mergedWithArchive = mergeWeatherWorkspaces(
      collectSessionCanvasArtifacts([archivedMsg], '', false),
      snap.weatherWorkspaces,
      true,
    );
    expect(mergedWithArchive).toHaveLength(1);
    expect(canvasInventory(mergedWithArchive).items[0]).toEqual({
      canvasId: 'weather:turn-w1::canvas::weather',
      title: 'Weather · Chennai',
      owner: { kind: 'weather', id: 'turn-w1' },
    });

    f.controller.updateCanvasInventory('chat-1', mergedWithArchive, {
      canvasId: 'weather:turn-w1::canvas::weather',
      open: false,
      fullscreen: false,
      mode: 'scroll',
      apply: () => 'applied',
    });

    f.event({
      type: 'canvas.show',
      conversationId: 'chat-1',
      turnId: 'turn-w2',
      responseId: 'resp-w2',
      navigationId: 'nav-w1',
      canvasId: 'msg-w1::canvas::weather',
    });
    expect(openCanvasArtifact).toHaveBeenCalledWith('weather:turn-w1::canvas::weather');

    f.controller.exit();
    await settle();
  });

  it('ignores weather.frame for cancelled responses', async () => {
    const f = liveVoiceFixture();
    await f.begin();
    f.event({ type: 'conversation.bound', conversationId: 'chat-1' });
    f.selectConversation('chat-1');
    f.event({ type: 'response.cancelled', turnId: 'turn-c1', responseId: 'resp-c1', lastAudioSequence: null });
    f.event({
      type: 'weather.frame',
      turnId: 'turn-c1',
      attemptId: 'att-c1',
      responseId: 'resp-c1',
      view: sampleView('Cancelled City'),
    });
    expect(f.controller.getSnapshot().weatherWorkspaces).toEqual([]);
    f.controller.exit();
    await settle();
  });
});
