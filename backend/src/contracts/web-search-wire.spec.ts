/**
 * ============================================================================
 * FILE: web-search-wire.spec.ts
 * LOCATION: backend/src/contracts/web-search-wire.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify secret-free web-search HTTP, source, and activity contracts.
 *
 * ROLE IN PROJECT:
 *    Protects the public plugin protocol and bounded provenance projections
 *    before provider routes, streaming, or UI consumers depend on them.
 *
 * KEY COMPONENTS:
 *    - Public status tests: Fixed cards, effective permission, secret rejection.
 *    - Mutation tests: Write-only candidate, confirmation, OAuth bounds.
 *    - Provenance tests: Source links, UTF-8 bounds, activity invariants.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { WEB_SEARCH_PROVIDERS } from './web-search-policy.js';
import { streamEnvelopeSchema, encodeSseFrame, parseSseDataLine } from './stream.js';
import { visibleMessageSchema } from './api.js';
import { messageRecordSchema } from './message.js';
import { isVoiceClientEvent, isVoiceServerEvent } from './voice-wire.js';
import {
  WEB_SEARCH_HTTP_ERRORS, WEB_SEARCH_ROUTES, webActivitiesSchema,
  webSearchConnectRequestSchema, webSearchDisconnectRequestSchema,
  webSearchHttpErrorSchema, webSearchOAuthCompleteRequestSchema,
  webSearchOAuthStartResponseSchema, webSearchPublicStatusSchema,
  webSearchSettingsRequestSchema, webSearchActivitySchema,
  webSourceReferenceSchema, webSourcesSchema,
} from './web-search-wire.js';

const source = {
  sourceId: 'source_1', toolCallId: 'call_1', provider: 'exa', kind: 'browse',
  title: 'Example', url: 'https://example.com/', retrievedAt: '2026-11-14T00:00:00.000Z',
};
const disconnected = () => ({
  protocolVersion: 1, revision: 0, enabled: false, effectiveEnabled: false,
  providers: WEB_SEARCH_PROVIDERS.map(provider => ({
    provider, state: 'not-connected', authMethod: null,
    authSupport: { apiKey: 'unverified', browserAuthorization: 'unverified' },
    capabilities: { browse: false, fetch: false }, lastValidatedAt: null,
  })),
});

describe('webSearch public contracts', () => {
  it('defaults account off and enforces fixed cards and effective permission', () => {
    const status = disconnected();
    expect(webSearchPublicStatusSchema.parse(status).effectiveEnabled).toBe(false);
    expect(webSearchPublicStatusSchema.safeParse({ ...status, effectiveEnabled: true }).success).toBe(false);
    expect(webSearchPublicStatusSchema.safeParse({ ...status, providers: [...status.providers].reverse() }).success)
      .toBe(false);
    expect(webSearchPublicStatusSchema.safeParse({ ...status, providers: status.providers.slice(1) }).success)
      .toBe(false);
    const connected = { ...status.providers[2], state: 'connected', authMethod: 'api-key',
      authSupport: { apiKey: 'supported', browserAuthorization: 'unverified' },
      capabilities: { browse: true, fetch: true }, lastValidatedAt: source.retrievedAt };
    const providers = status.providers.map(p => p.provider === 'exa' ? connected : p);
    expect(webSearchPublicStatusSchema.parse({ ...status, providers }).enabled).toBe(false);
    expect(webSearchPublicStatusSchema.parse({
      ...status, providers, enabled: true, effectiveEnabled: true,
    }).effectiveEnabled).toBe(true);
    expect(webSearchPublicStatusSchema.safeParse({
      ...status, providers: providers.map(p => p.provider === 'exa'
        ? { ...p, capabilities: { browse: false, fetch: false } } : p),
    }).success).toBe(false);
  });

  it('keeps all response contracts secret-free and rejects identity/endpoint overrides', () => {
    const status = disconnected();
    for (const field of ['candidate', 'apiKey', 'accessToken', 'refreshToken', 'envelope', 'userId', 'endpoint']) {
      expect(webSearchPublicStatusSchema.safeParse({ ...status, [field]: 'secret' }).success).toBe(false);
      expect(webSearchPublicStatusSchema.safeParse({
        ...status, providers: status.providers.map((p, i) => i === 0 ? { ...p, [field]: 'secret' } : p),
      }).success).toBe(false);
      expect(webSourceReferenceSchema.safeParse({ ...source, [field]: 'secret' }).success).toBe(false);
      expect(webSearchSettingsRequestSchema.safeParse({
        protocolVersion: 1, expectedRevision: 0, enabled: true, [field]: 'secret',
      }).success).toBe(false);
    }
    expect(webSearchHttpErrorSchema.safeParse({ protocolVersion: 1, error: {
      code: 'WEB_INVALID_KEY', retryable: false, currentRevision: 1, message: 'provider secret',
    } }).success).toBe(false);
  });

  it('accepts only a write-only bounded candidate and explicit disconnect confirmation', () => {
    const request = { protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key' };
    expect(webSearchConnectRequestSchema.parse(request)).toEqual(request);
    for (const candidate of ['', ' key ', 'line\nbreak', 'x'.repeat(4097), '😀'.repeat(1025)]) {
      expect(webSearchConnectRequestSchema.safeParse({ ...request, candidate }).success).toBe(false);
    }
    expect(webSearchDisconnectRequestSchema.safeParse({
      protocolVersion: 1, expectedRevision: 0, confirm: true,
    }).success).toBe(true);
    expect(webSearchDisconnectRequestSchema.safeParse({
      protocolVersion: 1, expectedRevision: 0,
    }).success).toBe(false);
    expect(WEB_SEARCH_ROUTES.connect('exa')).toBe('/plugins/web-search/providers/exa/connect');
    expect(WEB_SEARCH_ROUTES.oauthComplete('exa')).toBe('/plugins/web-search/providers/exa/oauth/complete');
  });

  it('bounds authorization and never treats a dashboard URL as a completed connection', () => {
    expect(webSearchOAuthStartResponseSchema.safeParse({ protocolVersion: 1,
      authorizationUrl: 'https://example.com/authorize?state=public-nonce',
      expiresAt: source.retrievedAt,
    }).success).toBe(true);
    for (const authorizationUrl of ['javascript:alert(1)', 'http://example.com/', 'https://a:b@example.com/',
      'https://example.com/authorize?access_token=secret', 'https://example.com/authorize?apiKey=secret',
      'https://example.com/authorize?code_verifier=secret']) {
      expect(webSearchOAuthStartResponseSchema.safeParse({
        protocolVersion: 1, authorizationUrl, expiresAt: source.retrievedAt,
      }).success).toBe(false);
    }
    expect(webSearchOAuthCompleteRequestSchema.safeParse({
      protocolVersion: 1, rawQuery: 'code=request-only&state=nonce',
    }).success).toBe(true);
  });

  it('bounds sources in UTF-8, unique IDs, strict links, and activity projections', () => {
    expect(webSourcesSchema.parse([source])).toHaveLength(1);
    expect(webSourcesSchema.safeParse([source, source]).success).toBe(false);
    expect(webSourcesSchema.safeParse(Array.from({ length: 16 }, (_, i) =>
      ({ ...source, sourceId: `s_${i}` }))).success).toBe(false);
    const large = Array.from({ length: 15 }, (_, i) => ({
      ...source, sourceId: `s_${i}`, title: '界'.repeat(160),
      url: `https://example.com/${'x'.repeat(950)}`,
    }));
    expect(webSourcesSchema.safeParse(large).success).toBe(false);
    for (const url of ['javascript:alert(1)', 'data:text/plain,x', '/relative', 'mailto:a@example.com',
      'https://user:pass@example.com/', 'https://example.com/?apiKey=secret',
      `https://example.com/${'x'.repeat(1024)}`]) {
      expect(webSourceReferenceSchema.safeParse({ ...source, url }).success).toBe(false);
    }
    const activity = { toolCallId: 'call_1', mode: 'browse', phase: 'completed', provider: 'exa', code: null };
    expect(webSearchActivitySchema.safeParse(activity).success).toBe(true);
    expect(webSearchActivitySchema.safeParse({ ...activity, query: 'do not expose' }).success).toBe(false);
    expect(webSearchActivitySchema.safeParse({ ...activity, phase: 'reading' }).success).toBe(false);
    expect(webSearchActivitySchema.safeParse({ ...activity, phase: 'failed' }).success).toBe(false);
    expect(webActivitiesSchema.safeParse(Array.from({ length: 41 }, (_, i) =>
      ({ ...activity, toolCallId: `c_${i}` }))).success).toBe(false);
  });

  it('webSearch freezes public HTTP errors without raw provider details', () => {
    expect(WEB_SEARCH_HTTP_ERRORS.WEB_CONNECTION_REQUIRED).toEqual({ status: 409, retryable: false });
    expect(WEB_SEARCH_HTTP_ERRORS.WEB_AUTH_UNSUPPORTED).toEqual({ status: 422, retryable: false });
    for (const [code, spec] of Object.entries(WEB_SEARCH_HTTP_ERRORS)) {
      expect(webSearchHttpErrorSchema.safeParse({
        protocolVersion: 1, error: { code, retryable: spec.retryable, currentRevision: null },
      }).success).toBe(true);
    }
  });
});

describe('webSearch text and voice projections', () => {
  const activity = { toolCallId: 'call_1', mode: 'browse', phase: 'completed', provider: 'exa', code: null };
  const events = [
    { type: 'web-activity', activity },
    { type: 'web-sources', sources: [source] },
  ];
  it('round-trips both web events in the existing turn-scoped SSE envelope', () => {
    for (const event of events) {
      const value = streamEnvelopeSchema.parse({ protocolVersion: 1,
        sessionId: 's_1', turnId: 't_1', attemptId: 'a_1', sequence: 1, event });
      expect(parseSseDataLine(encodeSseFrame(value))).toEqual(value);
    }
    expect(streamEnvelopeSchema.safeParse({ protocolVersion: 1,
      sessionId: 's_1', turnId: 't_1', attemptId: 'a_1', sequence: 2,
      event: { type: 'completed', assistantMessageId: 'm_2', outcome: 'completed',
        webSources: [source], webActivities: [activity] },
    }).success).toBe(true);
  });
  it('accepts optional assistant provenance without changing old messages or user records', () => {
    const old = {
      schemaVersion: 1, userId: 'u_1', sessionId: 's_1', turnId: 't_1',
      messageId: 'm_1', eventId: 'e_1', sequence: 1, role: 'assistant', content: 'Answer.',
      createdAt: source.retrievedAt, completionStatus: 'completed', attemptId: 'a_1', truncated: false,
    };
    expect(messageRecordSchema.safeParse(old).success).toBe(true);
    expect(messageRecordSchema.safeParse({
      ...old, webSources: [source], webActivities: [activity],
    }).success).toBe(true);
    expect(messageRecordSchema.safeParse({
      ...old, role: 'user', webSources: [source],
    }).success).toBe(false);
    const { schemaVersion, userId, sessionId, attemptId, ...visible } = old;
    expect([schemaVersion, userId, sessionId, attemptId]).toHaveLength(4);
    expect(visibleMessageSchema.safeParse({
      ...visible, mode: 'live', webSources: [source], webActivities: [activity],
    }).success).toBe(true);
    expect(visibleMessageSchema.safeParse({
      ...visible, role: 'user', webActivities: [activity],
    }).success).toBe(false);
  });
  it('carries the same events only in server-to-client live voice frames', () => {
    for (const event of events) {
      const frame = { protocolVersion: 1, sessionId: 'v_1', connectionEpoch: 1,
        eventId: 'ev_1', sequence: 1, type: 'web.frame',
        turnId: 't_1', attemptId: 'a_1', responseId: 'r_1', event };
      expect(isVoiceServerEvent(frame, 'live')).toBe(true);
      expect(isVoiceServerEvent(frame, 'dictation')).toBe(false);
      expect(isVoiceClientEvent(frame)).toBe(false);
      expect(isVoiceServerEvent({ ...frame, apiKey: 'secret' }, 'live')).toBe(false);
      expect(isVoiceServerEvent({ ...frame, event: { ...event, rawPage: 'secret' } }, 'live')).toBe(false);
    }
  });
});
