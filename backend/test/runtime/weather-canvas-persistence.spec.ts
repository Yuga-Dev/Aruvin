/**
 * ============================================================================
 * FILE: weather-canvas-persistence.spec.ts
 * LOCATION: backend/test/runtime/weather-canvas-persistence.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the durable Calendar path persists and streams Weather Canvas views.
 *
 * ROLE IN PROJECT:
 *    Covers completion, interruption, transcript reload, and every persisted
 *    Canvas shape (markdown fences, <aurvin-canvas>, live artifacts, weather).
 *
 * KEY COMPONENTS:
 *    - weatherFixture: Durable runtime over in-memory stores with a weather provider.
 *    - round-trip assertions for toVisibleMessage/hasCanvasContent.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { calendarFixture, skillWire, textWire, type CalendarRuntimeFixture } from './calendar-runtime.fixture.js';
import { FRAMES } from '../fixtures/openrouter/frames.js';
import { hasCanvasContent, toVisibleMessage } from '../../src/contracts/api.js';
import { messageRecordSchema } from '../../src/contracts/message.js';
import type { WeatherProvider } from '../../src/environment/weather-service.js';
import { WEATHER_ATTRIBUTION, type WeatherView } from '../../src/contracts/weather-view.js';
import type { StreamEnvelope } from '../../src/contracts/stream.js';
import type { RuntimeDependencies } from '../../src/chat-runtime/ports.js';

const lookup = vi.fn<WeatherProvider['lookup']>(async () => ({
  ok: true as const,
  resolvedLocation: { city: 'Chennai', region: 'Tamil Nadu', country: 'India' },
  units: 'metric' as const,
  current: { temperature: 30, apparentTemperature: 34, weatherCode: 2, condition: 'Partly cloudy' },
  hourly: [{ time: '2026-11-19T13:00', temperature: 31, weatherCode: 2 }],
  daily: [{ date: '2026-11-19', tempMax: 32, tempMin: 25, weatherCode: 2, condition: 'Partly cloudy' }],
  attribution: WEATHER_ATTRIBUTION,
}));

async function weatherFixture(): Promise<CalendarRuntimeFixture> {
  const f = calendarFixture(undefined, undefined, undefined, {
    weatherProvider: { lookup },
    personalizationFor: () => ({ warmth: 'medium', enthusiasm: 'medium', emoji: 'medium',
      customInstructions: '',
      location: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', latitude: 13.08, longitude: 80.27 },
    } as ReturnType<NonNullable<RuntimeDependencies['personalizationFor']>>),
  });
  await f.ready;
  return f;
}

async function execute(f: CalendarRuntimeFixture,
  ids: Awaited<ReturnType<CalendarRuntimeFixture['submit']>>,
  frames: StreamEnvelope[], views: WeatherView[]) {
  await f.runtime.executeTurn({ userId: f.identity.userId, ...ids,
    signal: new AbortController().signal,
    emit: async frame => { frames.push(frame); },
    emitCalendar: async frame => { f.frames.push(frame); },
    onWeatherView: view => { views.push(view); },
  });
}

it('persists, streams, and reloads a Weather Canvas from the durable Calendar path', async () => {
  const f = await weatherFixture();
  try {
    f.modelWires.push(
      skillWire('get_environment', { include: ['datetime', 'location', 'weather'] }, 'env_call_1'),
      textWire('It is 30C and partly cloudy in Chennai.'),
    );
    const ids = await f.submit('What is the weather?');
    const frames: StreamEnvelope[] = [];
    const views: WeatherView[] = [];
    await execute(f, ids, frames, views);
    expect(views).toHaveLength(1);
    const weatherFrame = frames.find(frame => frame.event.type === 'weather-view');
    expect(weatherFrame).toMatchObject({ protocolVersion: 1, sessionId: ids.sessionId,
      turnId: ids.turnId, attemptId: ids.attemptId, event: { type: 'weather-view', view: views[0] } });
    const completed = f.frames.find(frame => frame.event.type === 'completed');
    expect(completed?.event).toMatchObject({ type: 'completed', weatherView: views[0] });
    const listed = await f.p.messages.listForContext(f.identity.userId, ids.sessionId, { cursor: null, limit: 20 });
    const assistant = listed.items.find(item => item.role === 'assistant');
    expect(assistant).toMatchObject({ completionStatus: 'completed', weatherView: views[0] });
    expect(hasCanvasContent(assistant!)).toBe(true);
    const visible = toVisibleMessage(assistant!);
    expect(visible.weatherView).toEqual(views[0]);
    expect(JSON.parse(JSON.stringify({ items: listed.items.map(toVisibleMessage) })).items)
      .toContainEqual(expect.objectContaining({ messageId: assistant!.messageId, weatherView: views[0] }));
  } finally {
    await f.dispose();
  }
});

it('persists the captured Weather Canvas when the answer is interrupted before sealing', async () => {
  const f = await weatherFixture();
  try {
    f.modelWires.push(
      skillWire('get_environment', { include: ['weather'] }, 'env_call_2'),
      FRAMES.errorBefore,
    );
    const ids = await f.submit('Weather now?');
    const before = f.frames.length;
    const frames: StreamEnvelope[] = [];
    const views: WeatherView[] = [];
    await expect(execute(f, ids, frames, views)).rejects.toBeDefined();
    expect(views).toHaveLength(1);
    expect(frames.some(frame => frame.event.type === 'weather-view')).toBe(true);
    const listed = await f.p.messages.listForContext(f.identity.userId, ids.sessionId, { cursor: null, limit: 20 });
    const assistant = listed.items.find(item => item.role === 'assistant');
    expect(assistant?.weatherView).toEqual(views[0]);
    expect(['pending', 'interrupted', 'failed']).toContain(assistant?.completionStatus);
    expect(hasCanvasContent(assistant!)).toBe(true);
    expect(f.frames.length).toBeGreaterThanOrEqual(before);
  } finally {
    await f.dispose();
  }
});

it('preserves markdown canvases, aurvin-canvas tags, and live canvas artifacts on reload', () => {
  const cases = [
    '```mermaid\nflowchart TD\nA --> B\n```',
    '```chart\n{"type":"bar","data":{"labels":["A"],"datasets":[{"label":"n","data":[1]}]}}\n```',
    '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>\n```',
    '<aurvin-canvas type="chart">{"type":"line","data":{"labels":["A"],"datasets":[]}}</aurvin-canvas>',
  ];
  for (const [index, content] of cases.entries()) {
    const record = messageRecordSchema.parse({
      schemaVersion: 1, userId: 'u1', sessionId: 's1', turnId: `t${index}`,
      messageId: `m${index}`, eventId: `e${index}`, sequence: index, role: 'assistant',
      content, createdAt: '2026-11-20T00:00:00.000Z', completionStatus: 'completed',
      attemptId: `a${index}`, truncated: false,
    });
    expect(hasCanvasContent(record)).toBe(true);
    const visible = toVisibleMessage(record);
    expect(visible.content).toBe(content);
    expect(hasCanvasContent(visible)).toBe(true);
  }
  const live = messageRecordSchema.parse({
    schemaVersion: 1, userId: 'u1', sessionId: 's1', turnId: 'tl', messageId: 'ml', eventId: 'el',
    sequence: 9, role: 'assistant', content: 'Spoken answer', createdAt: '2026-11-20T00:00:00.000Z',
    completionStatus: 'completed', attemptId: 'al', truncated: false, visibility: 'internal', mode: 'live',
    voiceSessionId: 'v1',
    canvasArtifacts: [{ responseId: 'response-1', ordinal: 0, kind: 'mermaid', subType: 'flowchart',
      title: 'Diagram', rawSource: 'flowchart TD\nA --> B' }],
  });
  const visibleLive = toVisibleMessage(live);
  expect(visibleLive.canvasArtifacts).toEqual(live.canvasArtifacts);
  expect(hasCanvasContent(live)).toBe(true);
});
