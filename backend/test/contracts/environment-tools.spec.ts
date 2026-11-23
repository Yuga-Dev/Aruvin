/**
 * ============================================================================
 * FILE: environment-tools.spec.ts
 * LOCATION: backend/test/contracts/environment-tools.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify get_environment schema, native advertisement, and local result bounds.
 *
 * ROLE IN PROJECT:
 *    Locks strict argument validation, Anthropic-safe flat JSON Schema,
 *    SKILL_NATIVE_TOOLS ordering, skillDecisionSchema identity, and result caps.
 *
 * KEY COMPONENTS:
 *    - GET_ENVIRONMENT_NATIVE_TOOL / GET_ENVIRONMENT_TOOL_DEFINITION.
 *    - getEnvironmentEnvelopeSchema / getEnvironmentArgumentsSchema.
 *    - getEnvironmentResultSchema / nativeLocalResultSchema integration.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_TOOL_NAME,
  GET_ENVIRONMENT_NATIVE_TOOL,
  GET_ENVIRONMENT_PARAMETERS,
  GET_ENVIRONMENT_TOOL_DEFINITION,
  getEnvironmentArgumentsSchema,
  getEnvironmentEnvelopeSchema,
  getEnvironmentResultSchema,
} from '../../src/contracts/environment-tools.js';
import {
  SKILL_NATIVE_TOOLS,
  nativeLocalResultSchema,
  repairDiagnosticsSchema,
  serializeNativeLocalResult,
} from '../../src/contracts/calendar-tools.js';
import { skillDecisionSchema } from '../../src/contracts/calendar-model.js';
import { localSkillResultRecordSchema } from '../../src/contracts/calendar-sources.js';
import { WEATHER_ATTRIBUTION } from '../../src/contracts/weather-view.js';

describe('get_environment tool definition and native registration', () => {
  it('registers get_environment as a frozen built-in native tool with flat JSON Schema', () => {
    expect(ENVIRONMENT_TOOL_NAME).toBe('get_environment');
    expect(SKILL_NATIVE_TOOLS.map(t => t.name)).toEqual([
      'activate_skill',
      'call_tool',
      'control_canvas',
      'get_environment',
    ]);
    expect(Object.isFrozen(GET_ENVIRONMENT_NATIVE_TOOL)).toBe(true);
    expect(Object.isFrozen(GET_ENVIRONMENT_TOOL_DEFINITION)).toBe(true);
    expect(GET_ENVIRONMENT_TOOL_DEFINITION).toEqual({
      type: 'function',
      function: {
        name: 'get_environment',
        description: GET_ENVIRONMENT_NATIVE_TOOL.description,
        parameters: GET_ENVIRONMENT_PARAMETERS,
      },
    });
    // Flat schema without top-level oneOf/anyOf/allOf for Anthropic compatibility.
    const schemaKeys = Object.keys(GET_ENVIRONMENT_PARAMETERS);
    expect(schemaKeys).not.toContain('oneOf');
    expect(schemaKeys).not.toContain('anyOf');
    expect(schemaKeys).not.toContain('allOf');
    expect(GET_ENVIRONMENT_PARAMETERS.additionalProperties).toBe(false);
    expect(GET_ENVIRONMENT_PARAMETERS.required).toEqual(['include']);
  });

  it('validates strict envelope arguments and normalizes defaults cleanly', () => {
    const raw = { include: ['datetime', 'weather'], location: ' Tokyo ', forecast_days: 5, units: 'imperial' };
    // Envelope preserves raw strings so verifySkillDecisionIdentity deep-equality holds.
    expect(getEnvironmentEnvelopeSchema.parse(raw)).toEqual(raw);
    expect(getEnvironmentArgumentsSchema.parse(raw)).toEqual({
      include: ['datetime', 'weather'],
      location: 'Tokyo',
      forecast_days: 5,
      units: 'imperial',
    });
    expect(getEnvironmentArgumentsSchema.parse({ include: ['datetime'] })).toEqual({
      include: ['datetime'],
      forecast_days: 3,
      units: 'metric',
    });

    for (const invalid of [
      {},
      { include: [] },
      { include: ['datetime', 'datetime'] },
      { include: ['timezone'] },
      { include: ['weather'], location: '' },
      { include: ['weather'], location: '   ' },
      { include: ['weather'], location: 'a'.repeat(101) },
      { include: ['weather'], location: 'Tokyo\nJapan' },
      { include: ['weather'], forecast_days: 0 },
      { include: ['weather'], forecast_days: 8 },
      { include: ['weather'], forecast_days: 2.5 },
      { include: ['weather'], units: 'kelvin' },
      { include: ['datetime'], extra: true },
    ]) {
      expect(getEnvironmentEnvelopeSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('supports get_environment in skillDecisionSchema, repairDiagnosticsSchema, and local records', () => {
    const rawArgs = '{"include":["datetime","weather"],"location":"Tokyo"}';
    const decision = skillDecisionSchema.parse({
      kind: 'get_environment',
      decisionId: 'dec_env_1',
      nativeCall: {
        id: 'call_env_1',
        type: 'function',
        function: { name: 'get_environment', arguments: rawArgs },
      },
      assistantContent: null,
      envelope: JSON.parse(rawArgs),
      terminal: 'tool_calls',
    });
    expect(decision.kind).toBe('get_environment');

    expect(
      repairDiagnosticsSchema.parse([
        { path: 'include', code: 'missing', expected: 'bounded-value' },
        { path: 'forecast_days', code: 'wrong-type', expected: 'integer' },
        { path: 'units', code: 'wrong-type', expected: 'string' },
      ]),
    ).toHaveLength(3);

    const result = getEnvironmentResultSchema.parse({
      kind: 'environment-result',
      capturedAt: '2026-11-19T06:45:00.000Z',
      validForCurrentTurnOnly: ['datetime', 'weather'],
      datetime: {
        iso: '2026-11-19T06:45:00.000Z',
        localDate: '2026-11-19',
        dayOfWeek: 'Thursday',
        localTime24: '15:45',
        localTime12: '3:45 PM',
        timeZone: 'Asia/Tokyo',
        utcOffset: '+09:00',
      },
      location: { available: true, city: 'Tokyo', country: 'Japan', source: 'explicit' },
      weather: {
        ok: true,
        resolvedLocation: { city: 'Tokyo', country: 'Japan' },
        units: 'metric',
        current: {
          temperature: 14.5,
          apparentTemperature: 13.0,
          weatherCode: 1,
          condition: 'Mainly clear',
        },
        hourly: [],
        daily: [],
        attribution: WEATHER_ATTRIBUTION,
      },
    });
    expect(nativeLocalResultSchema.parse(result)).toEqual(result);
    const serialized = serializeNativeLocalResult(result);
    expect(
      localSkillResultRecordSchema.parse({
        schemaVersion: 3,
        kind: 'calendar-tool-result',
        protocolVersion: 'plugin-skills.v1',
        userId: 'u',
        sessionId: 's',
        turnId: 't',
        attemptId: 'a',
        decisionId: 'dec_env_1',
        eventId: 'evt_env_1',
        sequence: 0,
        toolCallId: 'call_env_1',
        createdAt: '2026-11-19T06:45:00.000Z',
        resultRef: { storage: 'local', toolCallId: 'call_env_1', content: serialized },
      }).resultRef.storage,
    ).toBe('local');

    // Partial-success payload: datetime succeeds while weather returns a closed error.
    expect(
      getEnvironmentResultSchema.parse({
        kind: 'environment-result',
        capturedAt: '2026-11-19T06:45:00.000Z',
        validForCurrentTurnOnly: ['datetime', 'weather'],
        datetime: result.datetime,
        location: { available: false, reason: 'LOCATION_UNKNOWN' },
        weather: { ok: false, code: 'LOCATION_UNKNOWN' },
      }).weather,
    ).toEqual({ ok: false, code: 'LOCATION_UNKNOWN' });
  });
});
