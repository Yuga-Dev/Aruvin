/**
 * ============================================================================
 * FILE: weather-canvas-runtime.spec.ts
 * LOCATION: backend/src/chat-runtime/weather-canvas-runtime.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify weatherView terminal persistence in MemoryFirstFoundation and
 *    control_canvas ownership/scroll authorization for Weather Canvas artifacts.
 *
 * ROLE IN PROJECT:
 *    Proves archived and live weather Canvas IDs pass ownedCanvasInventory only
 *    when backed by an owned assistant record with weatherView, and that scroll,
 *    close, and fullscreen succeed while zoom_in is rejected as unsupported.
 *
 * KEY COMPONENTS:
 *    - ownedCanvasInventory weather authorization tests.
 *    - controlCanvas scroll-mode acceptance and zoom rejection tests.
 *    - MemoryFirstFoundation weatherView persistence round-trip test.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import type { CanvasInventorySnapshot, CanvasSelection } from '../contracts/canvas-navigation.js';
import type { MessageRecord } from '../contracts/message.js';
import type { WeatherView } from '../contracts/weather-view.js';
import { controlCanvas, navigateCanvas, ownedCanvasInventory } from './canvas-navigation.js';
import { MemoryFirstFoundation, type SaveEnvelope } from './memory-first-foundation.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from './memory-text.js';

const sampleWeatherView = (): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:00:00.000Z',
  units: 'metric',
  location: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', source: 'explicit' },
  current: {
    temperature: 30,
    apparentTemperature: 34,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 70,
    windSpeed: 12,
    isDay: true,
  },
  hourly: [{ time: '2026-11-19T12:00', temperature: 31, weatherCode: 2, precipitationProbability: 20 }],
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

const assistantWeatherRecord = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({
  schemaVersion: 1,
  userId: 'user-1',
  sessionId: 'session-1',
  turnId: 'turn-w1',
  messageId: 'msg-w1',
  eventId: 'evt-w1',
  sequence: 1,
  role: 'assistant',
  content: 'It is 30°C in Chennai.',
  createdAt: '2026-11-19T06:00:01.000Z',
  completionStatus: 'completed',
  attemptId: 'att-w1',
  truncated: false,
  weatherView: sampleWeatherView(),
  ...overrides,
});

describe('weather canvas navigation ownership and controls', () => {
  it('admits owned live and archived weather Canvas entries and rejects unowned/cross-session/spoofed ones', () => {
    const snapshot: CanvasInventorySnapshot = {
      items: [
        {
          canvasId: 'weather:turn-w1::canvas::weather',
          title: 'Weather · Chennai',
          owner: { kind: 'weather', id: 'turn-w1' },
        },
        {
          canvasId: 'msg-w1::canvas::weather',
          title: 'Weather · Chennai',
          owner: { kind: 'weather', id: 'msg-w1' },
        },
        {
          canvasId: 'weather:turn-other::canvas::weather',
          title: 'Weather · Spoofed',
          owner: { kind: 'weather', id: 'turn-other' },
        },
        {
          canvasId: 'msg-no-weather::canvas::weather',
          title: 'Weather · Missing view',
          owner: { kind: 'weather', id: 'msg-no-weather' },
        },
        {
          canvasId: 'calendar:turn-w1::canvas::calendar',
          title: 'Wrong owner kind',
          owner: { kind: 'weather', id: 'turn-w1' },
        },
      ],
      omitted: 0,
    };

    const records: MessageRecord[] = [
      assistantWeatherRecord(),
      assistantWeatherRecord({ messageId: 'msg-no-weather', turnId: 'turn-no-weather', weatherView: undefined }),
      assistantWeatherRecord({ sessionId: 'other-session', turnId: 'turn-other', messageId: 'msg-other' }),
    ];

    const owned = ownedCanvasInventory(snapshot, records, 'user-1', 'session-1');
    expect(owned.items.map((item) => item.canvasId)).toEqual([
      'weather:turn-w1::canvas::weather',
      'msg-w1::canvas::weather',
    ]);
    expect(owned.omitted).toBe(3);

    const show = vi.fn(() => true);
    const nav = navigateCanvas({
      envelope: { canvas_id: 'weather:turn-w1::canvas::weather' },
      responseMode: 'voice',
      inventory: owned,
      active: () => true,
      show,
    });
    expect(nav).toEqual({
      kind: 'canvas-navigation',
      outcome: 'requested',
      canvas_id: 'weather:turn-w1::canvas::weather',
    });
    expect(show).toHaveBeenCalledWith('weather:turn-w1::canvas::weather');
  });

  it('allows scroll, fullscreen, and close on open weather scroll selection while rejecting zoom_in', () => {
    const selection: CanvasSelection = {
      canvasId: 'weather:turn-w1::canvas::weather',
      revision: 2,
      open: true,
      fullscreen: false,
      mode: 'scroll',
    };
    const control = vi.fn(() => true);

    expect(
      controlCanvas({
        envelope: { action: 'scroll', direction: 'down' },
        responseMode: 'voice',
        expected: selection,
        selection,
        active: () => true,
        control,
      }).outcome,
    ).toBe('requested');

    expect(
      controlCanvas({
        envelope: { action: 'fullscreen', state: 'enter' },
        responseMode: 'voice',
        expected: selection,
        selection,
        active: () => true,
        control,
      }).outcome,
    ).toBe('requested');

    expect(
      controlCanvas({
        envelope: { action: 'close' },
        responseMode: 'voice',
        expected: selection,
        selection,
        active: () => true,
        control,
      }).outcome,
    ).toBe('requested');

    expect(
      controlCanvas({
        envelope: { action: 'zoom_in' },
        responseMode: 'voice',
        expected: selection,
        selection,
        active: () => true,
        control,
      }).outcome,
    ).toBe('unsupported');
  });
});

describe('MemoryFirstFoundation weatherView persistence', () => {
  it('persists weatherView on the terminal assistant MessageRecord in the save envelope', async () => {
    const saved: SaveEnvelope[] = [];
    const foundation = new MemoryFirstFoundation({
      userId: 'user-1',
      epoch: 'epoch-1',
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async (envelope) => {
        saved.push(envelope);
        return {
          kind: 'saved',
          epoch: envelope.epoch,
          sessionId: envelope.sessionId,
          version: envelope.version,
          fence: envelope.fence,
        };
      },
    });

    const turn = foundation.accept({
      sessionId: 'session-1',
      requestKey: 'req-weather-1',
      content: 'What is the weather in Chennai?',
      mode: 'text',
      voice: null,
      calendarReplyTo: null,
      config: {
        revision: '1',
        modelId: 'openai/gpt-4o-mini',
        instructionVersion: 'v1',
        knowledgeContentHash: 'hash1',
        graphSchemaVersion: '1',
      },
    });

    const view = sampleWeatherView();
    const envelope = foundation.complete(turn, {
      content: 'It is 30°C and partly cloudy in Chennai.',
      status: 'completed',
      weatherView: view,
    });

    expect(envelope.output.weatherView).toEqual(view);
    expect(foundation.history('session-1').at(-1)?.weatherView).toEqual(view);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saved).toHaveLength(1);
    const savedTerminal = saved[0];
    expect(savedTerminal && !('kind' in savedTerminal) ? savedTerminal.output.weatherView : undefined).toEqual(view);
  });
});
