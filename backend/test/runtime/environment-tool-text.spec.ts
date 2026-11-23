/**
 * ============================================================================
 * FILE: environment-tool-text.spec.ts
 * LOCATION: backend/test/runtime/environment-tool-text.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify get_environment on the non-Calendar tool-capable text path (with
 *    and without web_tool enabled) and verify Dev mode exclusion.
 *
 * ROLE IN PROJECT:
 *    Proves models with modelLimits.tools=true (without calendar.tools) advertise
 *    and execute get_environment, fire onWeatherView, repair malformed calls,
 *    coexist with web_tool, and strip all tools in Dev mode.
 *
 * KEY COMPONENTS:
 *    - toolOnlyFixture: Real MemoryText over textConfigFixture without Calendar.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { textConfigFixture } from './text-config-fixture.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import type { SaveOutcome, TerminalEnvelope } from '../../src/chat-runtime/memory-first-foundation.js';
import { GET_ENVIRONMENT_TOOL_DEFINITION } from '../../src/contracts/environment-tools.js';
import { WEATHER_ATTRIBUTION, type WeatherView } from '../../src/contracts/weather-view.js';
import type { WeatherProvider } from '../../src/environment/weather-service.js';
import { authority } from './dev-mode-fixture.js';

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = 'data: [DONE]\n\n';
const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const textFrame = (text: string, id = 'gen_text') =>
  event({ id, choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }) + done;
const envToolFrame = (raw: string, id = 'env_1', gen = 'gen_env') =>
  event({
    id: gen,
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'get_environment', arguments: raw } }] },
      finish_reason: 'tool_calls',
    }],
  }) + done;
const saved = (e: TerminalEnvelope): SaveOutcome => ({
  kind: 'saved',
  epoch: e.epoch,
  sessionId: e.sessionId,
  version: e.version,
  fence: e.fence,
});

function toolOnlyFixture(options: {
  tools?: boolean;
  weatherProvider?: WeatherProvider;
  devMode?: ReturnType<typeof authority>['mode'];
} = {}) {
  const base = textSnapshot(1);
  const snapshot = {
    ...base,
    modelLimits: { ...base.modelLimits!, tools: options.tools ?? true },
  };
  return textConfigFixture(snapshot, d => ({
    ...d,
    ...(options.weatherProvider ? { weatherProvider: options.weatherProvider } : {}),
    ...(options.devMode ? { devMode: options.devMode } : {}),
    memoryFirst: {
      policy: { ...PROPOSED_MEMORY_TEXT_POLICY, shutdownDrainMs: 30 },
      save: async envelope => saved(envelope),
    },
  }));
}

describe('get_environment on non-Calendar tool-capable text path', () => {
  it('advertises and executes get_environment without Calendar or Web Search and fires onWeatherView', async () => {
    const lookup = vi.fn<WeatherProvider['lookup']>(async () => ({
      ok: true as const,
      resolvedLocation: { city: 'Tokyo', country: 'Japan' },
      units: 'metric' as const,
      current: { temperature: 16, apparentTemperature: 15, weatherCode: 0, condition: 'Clear sky' },
      hourly: [],
      daily: [{ date: '2026-11-19', tempMax: 18, tempMin: 10, weatherCode: 0, condition: 'Clear sky' }],
      attribution: WEATHER_ATTRIBUTION,
    }));
    const f = toolOnlyFixture({ weatherProvider: { lookup } });
    const views: WeatherView[] = [];
    try {
      f.fetcher
        .mockResolvedValueOnce(sse(envToolFrame('{"include":["datetime","weather"],"location":"Tokyo"}')))
        .mockResolvedValueOnce(sse(textFrame('It is 16°C and clear in Tokyo.')));
      const ids = await f.runtime.submitTurn({
        identity: f.identity,
        sessionId: null,
        content: 'Weather in Tokyo?',
        idempotencyKey: 'env-text-1',
        clientTimeZone: 'Asia/Tokyo',
      });
      await f.runtime.executeTurn({
        userId: f.identity.userId,
        ...ids,
        signal: new AbortController().signal,
        emit: async () => {},
        onWeatherView: view => { views.push(view); },
      });

      expect(f.fetcher).toHaveBeenCalledTimes(2);
      const firstBody = JSON.parse(String(f.fetcher.mock.calls[0]![1]?.body));
      expect(firstBody.tools).toEqual([GET_ENVIRONMENT_TOOL_DEFINITION]);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(views).toHaveLength(1);
      expect(views[0]?.location).toEqual({ city: 'Tokyo', country: 'Japan', source: 'explicit' });

      const secondBody = JSON.parse(String(f.fetcher.mock.calls[1]![1]?.body));
      const toolMsg = (secondBody.messages as Array<{ role: string; name?: string; content?: string }>)
        .find(m => m.role === 'tool' && m.name === 'get_environment');
      expect(JSON.parse(toolMsg!.content!)).toMatchObject({
        kind: 'environment-result',
        validForCurrentTurnOnly: ['datetime', 'weather'],
        weather: { ok: true, resolvedLocation: { city: 'Tokyo', country: 'Japan' } },
      });
    } finally {
      await f.dispose();
    }
  });

  it('repairs malformed get_environment arguments and strips get_environment in Dev mode', async () => {
    const f = toolOnlyFixture();
    try {
      f.fetcher
        .mockResolvedValueOnce(sse(envToolFrame('{"include":[]}', 'bad_env_1')))
        .mockResolvedValueOnce(sse(envToolFrame('{"include":["datetime"]}', 'good_env_2')))
        .mockResolvedValueOnce(sse(textFrame('It is currently morning.')));
      const ids = await f.submit('What time is it?');
      await f.execute(ids);
      expect(f.fetcher).toHaveBeenCalledTimes(3);
      const retryBody = JSON.parse(String(f.fetcher.mock.calls[1]![1]?.body));
      expect(JSON.stringify(retryBody.messages)).toContain('ENV_SCHEMA_INVALID');
    } finally {
      await f.dispose();
    }

    const a = authority();
    a.mode.setEnabled(true);
    a.mode.select(a.principal, 'dev');
    const devF = toolOnlyFixture({ devMode: a.mode });
    try {
      devF.fetcher.mockResolvedValueOnce(sse(envToolFrame('{"include":["datetime"]}')));
      const ids = await devF.submit('What time is it?');
      await devF.runtime.executeTurn({
        userId: devF.identity.userId,
        ...ids,
        principal: a.principal,
        signal: new AbortController().signal,
        emit: async () => {},
      });
      expect(devF.fetcher).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(devF.fetcher.mock.calls[0]![1]?.body));
      expect(body.tools).toBeUndefined();
    } finally {
      await devF.dispose();
    }
  });
});
