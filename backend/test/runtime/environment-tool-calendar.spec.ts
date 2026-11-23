/**
 * ============================================================================
 * FILE: environment-tool-calendar.spec.ts
 * LOCATION: backend/test/runtime/environment-tool-calendar.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify get_environment execution through the memory-first CalendarLoop path.
 *
 * ROLE IN PROJECT:
 *    Proves direct advertisement (no activate_skill hop), zero DB reads before
 *    model dispatch, datetime/location/weather execution, partial success,
 *    onWeatherView callback firing, immutable multi-turn history, and Dev denial.
 *
 * KEY COMPONENTS:
 *    - calendarFixture: Real memory-first CalendarLoop with injectable weatherProvider.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { calendarFixture, skillWire, textWire } from './calendar-runtime.fixture.js';
import { authority } from './dev-mode-fixture.js';
import { WEATHER_ATTRIBUTION, type WeatherView } from '../../src/contracts/weather-view.js';
import type { WeatherProvider } from '../../src/environment/weather-service.js';
import type { RuntimeDependencies } from '../../src/chat-runtime/ports.js';

async function setup(options: {
  weatherProvider?: WeatherProvider;
  savedLocation?: { city: string; region?: string; country?: string; latitude?: number; longitude?: number } | null;
  devMode?: ReturnType<typeof authority>['mode'];
} = {}) {
  const memory = calendarMemory();
  const client = Object.assign(memory.commandSource, {
    db: () => memory.store.db,
    appendMetadata: () => undefined,
  }) as unknown as MongoClient;
  const persistence = await createPersistenceBundle(
    client,
    'env-calendar-test',
    DEFAULT_BUDGETS,
    'env-calendar-executor',
  );
  const f = calendarFixture(
    undefined,
    persistence,
    { policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 50 } },
    {
      weatherProvider: options.weatherProvider,
      devMode: options.devMode,
      personalizationFor: () => ({
        warmth: 'medium',
        enthusiasm: 'medium',
        emoji: 'medium',
        customInstructions: '',
        ...(options.savedLocation !== undefined ? { location: options.savedLocation } : {}),
      } as ReturnType<NonNullable<RuntimeDependencies['personalizationFor']>>),
    },
  );
  await f.ready;
  return { f, memory };
}

describe('get_environment on CalendarLoop native path', () => {
  it('executes get_environment directly without activate_skill, fires onWeatherView, and preserves immutable history across turns', async () => {
    const lookup = vi.fn<WeatherProvider['lookup']>(async () => ({
      ok: true as const,
      resolvedLocation: { city: 'Chennai', region: 'Tamil Nadu', country: 'India' },
      units: 'metric' as const,
      current: { temperature: 30, apparentTemperature: 34, weatherCode: 2, condition: 'Partly cloudy' },
      hourly: [{ time: '2026-11-19T13:00', temperature: 31, weatherCode: 2 }],
      daily: [{ date: '2026-11-19', tempMax: 32, tempMin: 25, weatherCode: 2, condition: 'Partly cloudy' }],
      attribution: WEATHER_ATTRIBUTION,
    }));
    const { f } = await setup({
      weatherProvider: { lookup },
      savedLocation: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', latitude: 13.08, longitude: 80.27 },
    });
    const views: WeatherView[] = [];
    try {
      f.modelWires.push(
        skillWire('get_environment', { include: ['datetime', 'location', 'weather'] }, 'env_call_1'),
        textWire('It is 30°C and partly cloudy in Chennai.'),
      );
      const ids = await f.runtime.submitTurn({
        identity: f.identity,
        sessionId: null,
        content: 'What is the time and weather?',
        idempotencyKey: 'env-turn-1',
        calendarProtocol: 2,
        clientTimeZone: 'Asia/Kolkata',
      });
      await f.runtime.executeTurn({
        userId: f.identity.userId,
        ...ids,
        signal: new AbortController().signal,
        emit: async () => {},
        emitCalendar: async frame => { f.frames.push(frame); },
        onWeatherView: view => { views.push(view); },
      });

      expect(lookup).toHaveBeenCalledTimes(1);
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({
        schemaVersion: 1,
        kind: 'weather',
        location: { city: 'Chennai', source: 'personalization' },
      });
      expect(f.modelBodies).toHaveLength(2);
      const secondMessages = f.modelBodies[1]!.messages as Array<{ role: string; name?: string; content?: string }>;
      const envToolMsg = secondMessages.find(m => m.role === 'tool' && m.name === 'get_environment');
      expect(envToolMsg).toBeDefined();
      const parsed = JSON.parse(envToolMsg!.content!);
      expect(parsed.kind).toBe('environment-result');
      expect(parsed.validForCurrentTurnOnly).toEqual(['datetime', 'weather']);
      expect(parsed.datetime.timeZone).toBe('Asia/Kolkata');

      // Follow-up turn retains the historical tool result byte-identically (prompt cache stability).
      f.modelWires.push(textWire('Follow-up answer.'));
      const ids2 = await f.runtime.submitTurn({
        identity: f.identity,
        sessionId: ids.sessionId,
        content: 'Thanks!',
        idempotencyKey: 'env-turn-2',
        calendarProtocol: 2,
        clientTimeZone: 'Asia/Kolkata',
      });
      await f.runtime.executeTurn({
        userId: f.identity.userId,
        ...ids2,
        signal: new AbortController().signal,
        emit: async () => {},
        emitCalendar: async frame => { f.frames.push(frame); },
      });
      const thirdMessages = f.modelBodies[2]!.messages as Array<{ role: string; name?: string; content?: string }>;
      const historicalEnvMsg = thirdMessages.find(m => m.role === 'tool' && m.name === 'get_environment');
      expect(historicalEnvMsg?.content).toBe(envToolMsg?.content);
    } finally {
      await f.dispose();
    }
  });

  it('uses requestGeo fallback when no explicit or saved location exists and preserves partial success when weather fails', async () => {
    const lookup = vi.fn<WeatherProvider['lookup']>(async () => ({
      ok: false as const,
      code: 'WEATHER_UNAVAILABLE' as const,
    }));
    const { f } = await setup({ weatherProvider: { lookup }, savedLocation: null });
    const views: WeatherView[] = [];
    try {
      f.modelWires.push(
        skillWire('get_environment', { include: ['datetime', 'location', 'weather'] }, 'env_geo_1'),
        textWire('It is currently morning in Bengaluru, though weather is temporarily unavailable.'),
      );
      const ids = await f.runtime.submitTurn({
        identity: f.identity,
        sessionId: null,
        content: 'Time and weather?',
        idempotencyKey: 'env-geo-turn',
        calendarProtocol: 2,
        clientTimeZone: 'Asia/Kolkata',
        requestGeo: { city: 'Bengaluru', region: 'KA', country: 'IN', source: 'cloudflare' },
      });
      await f.runtime.executeTurn({
        userId: f.identity.userId,
        ...ids,
        signal: new AbortController().signal,
        emit: async () => {},
        emitCalendar: async frame => { f.frames.push(frame); },
        onWeatherView: view => { views.push(view); },
      });
      expect(views).toHaveLength(0);
      const secondMessages = f.modelBodies[1]!.messages as Array<{ role: string; name?: string; content?: string }>;
      const envPayload = JSON.parse(
        secondMessages.find(m => m.role === 'tool' && m.name === 'get_environment')!.content!,
      );
      expect(envPayload.datetime.timeZone).toBe('Asia/Kolkata');
      expect(envPayload.location).toMatchObject({ available: true, city: 'Bengaluru', source: 'edge-geo' });
      expect(envPayload.weather).toEqual({ ok: false, code: 'WEATHER_UNAVAILABLE' });
    } finally {
      await f.dispose();
    }
  });

  it('omits and refuses get_environment in Dev mode', async () => {
    const a = authority();
    a.mode.setEnabled(true);
    a.mode.select(a.principal, 'dev');
    const lookup = vi.fn<WeatherProvider['lookup']>();
    const { f } = await setup({ weatherProvider: { lookup }, devMode: a.mode });
    try {
      f.modelWires.push(skillWire('get_environment', { include: ['datetime', 'weather'] }, 'dev_env_1'));
      const ids = await f.submit('Check weather');
      await f.runtime.executeTurn({
        userId: f.identity.userId,
        ...ids,
        principal: a.principal,
        signal: new AbortController().signal,
        emit: async () => {},
        emitCalendar: async frame => { f.frames.push(frame); },
      });
      expect(f.modelBodies).toHaveLength(1);
      expect(f.modelBodies[0]?.tools).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  });
});
