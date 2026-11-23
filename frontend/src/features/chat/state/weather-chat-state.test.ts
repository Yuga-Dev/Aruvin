/**
 * ============================================================================
 * FILE: weather-chat-state.test.ts
 * LOCATION: frontend/src/features/chat/state/weather-chat-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Weather SSE reducer fencing, terminal attachment, active artifact
 *    migration, text-mode inline CanvasArtifactCard rendering, and voice call
 *    transcript modal preservation.
 *
 * ROLE IN PROJECT:
 *    Guarantees weather views stay scoped to their active turn, never auto-open
 *    Canvas in text mode, render a clean clickable Canvas card button on the
 *    assistant message, and survive voice session grouping.
 *
 * KEY COMPONENTS:
 *    - chatReducer WEATHER_VIEW & STREAM_COMPLETED tests.
 *    - MessageItem inline text-mode CanvasArtifactCard render check.
 *    - groupVoiceMessages + VoiceTranscriptModal weatherView tests.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VisibleMessage } from '../../../api/protocol.ts';
import type { WeatherView } from '../../../api/weather-protocol.ts';
import { groupVoiceMessages } from '../../../components/group-voice-messages.ts';
import { MessageItem } from '../../../components/MessageItem.tsx';
import { VoiceTranscriptModal } from '../../../components/VoiceTranscriptModal.tsx';
import { chatReducer, initialChatState } from './chat-reducer.ts';
import type { ChatState } from './chat-types.ts';

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

const activeState = (): ChatState => ({
  ...initialChatState,
  activeSessionId: 'session-1',
  activeTurnId: 'turn-w1',
  activeAttemptId: 'att-w1',
  isStreaming: true,
  streamText: 'It is 30°C and partly cloudy in Chennai.',
});

describe('weather chat state and text-mode card rendering', () => {
  it('fences WEATHER_VIEW to active session/turn/attempt/sequence and does not auto-open Canvas in text mode', () => {
    const view = sampleView();
    const s1 = chatReducer(activeState(), {
      type: 'WEATHER_VIEW',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-w1',
        attemptId: 'att-w1',
        sequence: 2,
        view,
      },
    });
    expect(s1.weatherViewsByTurn['turn-w1']).toEqual(view);
    expect(s1.canvasOpen).toBe(false);

    for (const stale of [
      { sessionId: 'other-session' },
      { turnId: 'other-turn' },
      { attemptId: 'old-att' },
      { sequence: 2 },
    ]) {
      expect(
        chatReducer(s1, {
          type: 'WEATHER_VIEW',
          payload: {
            sessionId: 'session-1',
            turnId: 'turn-w1',
            attemptId: 'att-w1',
            sequence: 3,
            view: sampleView('Wrong City'),
            ...stale,
          },
        }),
      ).toBe(s1);
    }

    // If user manually opened the streaming Weather card, STREAM_COMPLETED migrates activeCanvasArtifactId
    const opened = chatReducer(s1, {
      type: 'OPEN_CANVAS_ARTIFACT',
      payload: { artifactId: 'turn-w1::canvas::weather' },
    });
    const completed = chatReducer(opened, {
      type: 'STREAM_COMPLETED',
      payload: {
        assistantMessageId: 'msg-asst-w1',
        outcome: 'completed',
      },
    });
    expect(completed.messages.at(-1)?.weatherView).toEqual(view);
    expect(completed.weatherViewsByTurn['turn-w1']).toBeUndefined();
    expect(completed.activeCanvasArtifactId).toBe('msg-asst-w1::canvas::weather');
  });

  it('clears weatherViewsByTurn on NEW_CHAT and SELECT_SESSION', () => {
    const s1 = chatReducer(activeState(), {
      type: 'WEATHER_VIEW',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-w1',
        attemptId: 'att-w1',
        sequence: 1,
        view: sampleView(),
      },
    });
    expect(chatReducer(s1, { type: 'NEW_CHAT' }).weatherViewsByTurn).toEqual({});
    expect(
      chatReducer(s1, {
        type: 'SELECT_SESSION',
        payload: { sessionId: 'session-2', title: 'Other' },
      }).weatherViewsByTurn,
    ).toEqual({});
  });

  it('renders a compact inline CanvasArtifactCard on text assistant messages with weatherView', () => {
    const message: VisibleMessage = {
      messageId: 'msg-asst-w1',
      turnId: 'turn-w1',
      eventId: 'evt-w1',
      sequence: 1,
      role: 'assistant',
      content: 'It is 30°C and partly cloudy in Chennai.',
      createdAt: '2026-11-19T06:30:01.000Z',
      completionStatus: 'completed',
      truncated: false,
      weatherView: sampleView('Chennai'),
    };
    const html = renderToStaticMarkup(
      createElement(MessageItem, {
        message,
        onOpenArtifact: vi.fn(),
      }),
    );
    expect(html).toContain('data-canvas-kind="weather"');
    expect(html).toContain('data-canvas-artifact-id="msg-asst-w1::canvas::weather"');
    expect(html).toContain('Weather · Chennai');
    expect(html).toContain('View weather in Canvas');
  });

  it('preserves weatherView when grouping voice call messages and renders its card in VoiceTranscriptModal', () => {
    const voiceMsg: VisibleMessage = {
      messageId: 'msg-voice-w1',
      turnId: 'turn-voice-w1',
      eventId: 'evt-vw1',
      sequence: 2,
      role: 'assistant',
      content: '',
      createdAt: '2026-11-19T06:30:01.000Z',
      completionStatus: 'completed',
      truncated: false,
      mode: 'live',
      visibility: 'visible',
      voiceSessionId: 'vs-1',
      voiceDurationSeconds: 20,
      voiceTranscripts: [{ role: 'assistant', content: 'It is 30 degrees in Chennai.' }],
      weatherView: sampleView('Chennai'),
    };
    const grouped = groupVoiceMessages([voiceMsg]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.voiceTranscripts?.[0]?.weatherView?.location.city).toBe('Chennai');

    const modalHtml = renderToStaticMarkup(
      createElement(VoiceTranscriptModal, {
        durationSeconds: 20,
        transcripts: grouped[0]!.voiceTranscripts ?? [],
        onOpenArtifact: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(modalHtml).toContain('data-canvas-kind="weather"');
    expect(modalHtml).toContain('Weather · Chennai');
  });
});
