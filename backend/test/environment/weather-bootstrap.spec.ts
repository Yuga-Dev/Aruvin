/**
 * ============================================================================
 * FILE: weather-bootstrap.spec.ts
 * LOCATION: backend/test/environment/weather-bootstrap.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify weather bootstrap env parsing and HTTP requestGeo forwarding.
 *
 * ROLE IN PROJECT:
 *    Ensures default Open-Meteo URLs work with zero config, custom HTTPS URLs
 *    and API keys parse safely without leaking secrets, and ChatHttpService
 *    forwards sanitized requestGeo hints to submitTurn/retryTurn.
 *
 * KEY COMPONENTS:
 *    - loadBootstrapConfig: Default and custom AURVIN_WEATHER_* settings.
 *    - ChatHttpService: Forwards environment.geo() on submit and retry.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_ENV_NAMES,
  loadBootstrapConfig,
} from '../../src/platform/config/bootstrap-config.js';
import {
  DEFAULT_OPEN_METEO_FORECAST_URL,
  DEFAULT_OPEN_METEO_GEOCODING_URL,
  DEFAULT_WEATHER_TIMEOUT_MS,
} from '../../src/environment/weather-service.js';
import { ChatHttpService } from '../../src/http/chat-http.service.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';

describe('weather bootstrap config', () => {
  it('defaults to free Open-Meteo endpoints with zero env vars', () => {
    expect(BOOTSTRAP_ENV_NAMES).toContain('AURVIN_WEATHER_GEOCODING_URL');
    expect(BOOTSTRAP_ENV_NAMES).toContain('AURVIN_WEATHER_FORECAST_URL');
    expect(BOOTSTRAP_ENV_NAMES).toContain('AURVIN_WEATHER_API_KEY');
    expect(BOOTSTRAP_ENV_NAMES).toContain('AURVIN_WEATHER_TIMEOUT_MS');

    const cfg = loadBootstrapConfig({ NODE_ENV: 'development' });
    expect(cfg.weather).toEqual({
      geocodingBaseUrl: DEFAULT_OPEN_METEO_GEOCODING_URL,
      forecastBaseUrl: DEFAULT_OPEN_METEO_FORECAST_URL,
      apiKey: null,
      timeoutMs: DEFAULT_WEATHER_TIMEOUT_MS,
    });
  });

  it('accepts custom HTTPS Open-Meteo endpoints and rejects non-HTTP(S) URLs', () => {
    const cfg = loadBootstrapConfig({
      NODE_ENV: 'development',
      AURVIN_WEATHER_GEOCODING_URL: 'https://geo.example.com/v1/search',
      AURVIN_WEATHER_FORECAST_URL: 'https://forecast.example.com/v1/forecast',
      AURVIN_WEATHER_API_KEY: 'key-123',
      AURVIN_WEATHER_TIMEOUT_MS: '3500',
    });
    expect(cfg.weather).toEqual({
      geocodingBaseUrl: 'https://geo.example.com/v1/search',
      forecastBaseUrl: 'https://forecast.example.com/v1/forecast',
      apiKey: 'key-123',
      timeoutMs: 3500,
    });

    expect(() =>
      loadBootstrapConfig({
        NODE_ENV: 'development',
        AURVIN_WEATHER_FORECAST_URL: 'ftp://bad.example.com/forecast',
      }),
    ).toThrow(/Invalid application configuration/);
  });
});

describe('ChatHttpService requestGeo forwarding', () => {
  it('forwards sanitized requestGeo and clientTimeZone on submit and retry', async () => {
    const submitTurn = vi.fn(async () => ({
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a1',
      userMessageId: 'm1',
      streamPath: '/api/sessions/s1/turns/t1/stream',
    }));
    const retryTurn = vi.fn(async () => ({
      sessionId: 's1',
      turnId: 't1',
      attemptId: 'a2',
      userMessageId: 'm1',
      streamPath: '/api/sessions/s1/turns/t1/stream',
    }));
    const geo = { city: 'Chennai', region: 'TN', country: 'IN', source: 'cloudflare' as const };
    const svc = new ChatHttpService({
      runtime: {
        submitTurn,
        retryTurn,
        cancelTurn: vi.fn(),
        getTurnStatus: vi.fn(),
        reconcileSession: vi.fn(),
        executeTurn: vi.fn(),
        stopAccepting: vi.fn(),
        snapshot: vi.fn(),
        drain: vi.fn(),
        allowStoppedOwner: vi.fn(),
        rebaseSession: vi.fn(),
      },
      sessions: {
        get: vi.fn(async () => ({
          schemaVersion: 1 as const,
          userId: 'u1',
          sessionId: 's1',
          title: 'Chat',
          createdAt: '2026-11-19T00:00:00.000Z',
          updatedAt: '2026-11-19T00:00:00.000Z',
          lastActivityAt: '2026-11-19T00:00:00.000Z',
          lifecycle: 'active' as const,
          graphThreadId: 'g1',
          latestTurnId: 't1',
          execution: { ownerId: null, leaseExpiresAt: null, activeAttemptId: null, generation: 0 },
        })),
        list: vi.fn(),
        createIfAbsent: vi.fn(),
        touchActivity: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      messages: {
        append: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        updateCompletion: vi.fn(),
      },
      identity: {
        resolve: () => ({ userId: 'u1', openRouterUser: 'u1', source: 'authenticated-session' as const }),
        assertNoClientOverrides: () => undefined,
      } as never,
      environment: {
        current: () => ({ timeZone: 'Asia/Kolkata', geo }),
        timeZone: () => 'Asia/Kolkata',
        geo: () => geo,
      },
      budgets: DEFAULT_BUDGETS,
    });

    await svc.submit(null, { sessionId: null, content: 'Weather?', idempotencyKey: 'idempotency-key-1' });
    expect(submitTurn).toHaveBeenCalledWith(
      expect.objectContaining({ clientTimeZone: 'Asia/Kolkata', requestGeo: geo }),
    );

    await svc.retry('s1', 't1', { idempotencyKey: 'idempotency-key-2' });
    expect(retryTurn).toHaveBeenCalledWith(
      expect.objectContaining({ clientTimeZone: 'Asia/Kolkata', requestGeo: geo }),
    );
  });
});
