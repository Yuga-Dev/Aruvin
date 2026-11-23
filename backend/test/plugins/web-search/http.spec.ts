/**
 * ============================================================================
 * FILE: http.spec.ts
 * LOCATION: backend/test/plugins/web-search/http.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify strict web-search plugin HTTP routes, identity, and safe errors.
 *
 * ROLE IN PROJECT:
 *    Proves P1 route parity, server-side identity, origin/body bounds, static
 *    callback safety, and secret-free responses through the real controller.
 *
 * KEY COMPONENTS:
 *    - Status/settings/connect/disconnect/OAuth route checks.
 *    - Unknown provider, wrong method, query/body/origin overrides.
 *    - Unauthenticated, cross-account, callback CSP, and cache headers.
 * ============================================================================
 */

import request from 'supertest';
import { expect, it } from 'vitest';
import {
  WEB_SEARCH_ROUTES, webSearchPublicStatusSchema,
} from '../../../src/contracts/web-search-wire.js';
import { httpFixture } from './fixtures.js';

const origin = 'https://aurvin.example.com';

it('serves P1 status and rejects client ownership overrides without secrets', async () => {
  const f = await httpFixture();
  try {
    const r = await request(f.app.getHttpServer())
      .get('/api' + WEB_SEARCH_ROUTES.status).expect(200);
    expect(webSearchPublicStatusSchema.parse(r.body).providers.map(provider => provider.provider))
      .toEqual(['tinyfish', 'keenable', 'exa', 'tavily', 'firecrawl']);
    expect(r.headers['cache-control']).toBe('no-store');
    const denied = await request(f.app.getHttpServer())
      .post('/api' + WEB_SEARCH_ROUTES.connect('exa'))
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key', userId: 'u_b' })
      .expect(400);
    expect(JSON.stringify(denied.body)).not.toContain('fixture-key');
    expect(JSON.stringify(r.body)).not.toContain('credential');
  } finally { await f.close(); }
});

it('connects, enables, disconnects, and keeps the account off', async () => {
  const f = await httpFixture();
  try {
    const connected = await request(f.app.getHttpServer())
      .post('/api' + WEB_SEARCH_ROUTES.connect('exa'))
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key' })
      .expect(200);
    expect(connected.body).toMatchObject({ revision: 1, enabled: false });
    expect(JSON.stringify(connected.body)).not.toContain('fixture-key');
    const enabled = await request(f.app.getHttpServer())
      .patch('/api' + WEB_SEARCH_ROUTES.settings)
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 1, enabled: true })
      .expect(200);
    expect(enabled.body).toMatchObject({ enabled: true, effectiveEnabled: true });
    const disconnected = await request(f.app.getHttpServer())
      .post('/api' + WEB_SEARCH_ROUTES.disconnect('exa'))
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 2, confirm: true })
      .expect(200);
    expect(disconnected.body).toMatchObject({ enabled: false, effectiveEnabled: false });
    expect(disconnected.body.providers.find((p: { provider: string }) => p.provider === 'exa').state)
      .toBe('not-connected');
  } finally { await f.close(); }
});

it('restores the API-key session when enabling after a restart', async () => {
  const f = await httpFixture();
  try {
    await request(f.app.getHttpServer())
      .post('/api' + WEB_SEARCH_ROUTES.connect('exa'))
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key' })
      .expect(200);
    await request(f.app.getHttpServer())
      .patch('/api' + WEB_SEARCH_ROUTES.settings)
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 1, enabled: true })
      .expect(200);
    // Simulate a restart: the stored account survives, memory and sessions do not.
    f.connections.evict('u_a');
    expect(f.connections.snapshot('u_a').providers).toEqual([]);
    const enabled = await request(f.app.getHttpServer())
      .patch('/api' + WEB_SEARCH_ROUTES.settings)
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 2, enabled: true })
      .expect(200);
    expect(enabled.body).toMatchObject({ enabled: true, effectiveEnabled: true });
    expect(f.connections.snapshot('u_a').providers.map(provider => provider.provider))
      .toEqual(['exa']);
  } finally { await f.close(); }
});

it('returns the closed conflict and connection-required codes', async () => {
  const f = await httpFixture();
  try {
    const required = await request(f.app.getHttpServer())
      .patch('/api' + WEB_SEARCH_ROUTES.settings)
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 0, enabled: true })
      .expect(409);
    expect(required.body.error.code).toBe('WEB_CONNECTION_REQUIRED');
    await request(f.app.getHttpServer())
      .post('/api' + WEB_SEARCH_ROUTES.connect('exa'))
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key' })
      .expect(200);
    const conflict = await request(f.app.getHttpServer())
      .patch('/api' + WEB_SEARCH_ROUTES.settings)
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 0, enabled: true })
      .expect(409);
    expect(conflict.body.error).toMatchObject({ code: 'WEB_SETTINGS_CONFLICT', currentRevision: 1 });
  } finally { await f.close(); }
});

it('serves OAuth start, a static callback, and a bound completion', async () => {
  const f = await httpFixture();
  try {
    const started = await request(f.app.getHttpServer())
      .post('/api' + WEB_SEARCH_ROUTES.oauthStart('exa'))
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 0 })
      .expect(200);
    expect(started.body.authorizationUrl).toContain('https://auth.exa.ai/authorize');
    expect(String(started.headers['set-cookie'])).toContain('aurvin_web_search_oauth_exa=');
    const callback = await request(f.app.getHttpServer())
      .get('/api' + WEB_SEARCH_ROUTES.oauthCallback('exa') + '?state=request-only&code=secret')
      .expect(200);
    expect(callback.headers['content-security-policy']).toContain('sha256-');
    expect(callback.text).not.toContain('request-only');
    expect(callback.text).not.toContain('secret');
    const completed = await request(f.app.getHttpServer())
      .post('/api' + WEB_SEARCH_ROUTES.oauthComplete('exa'))
      .set('Origin', origin)
      .send({ protocolVersion: 1, rawQuery: 'state=request-only&code=request-only' })
      .expect(200);
    expect(completed.body).toEqual({ protocolVersion: 1, outcome: 'connected' });
    expect(String(completed.headers['set-cookie'])).toContain('Max-Age=0');
  } finally { await f.close(); }
});

it('rejects unknown providers, wrong methods, query overrides, and missing origin', async () => {
  const f = await httpFixture();
  try {
    await request(f.app.getHttpServer())
      .post('/api/plugins/web-search/providers/unknown/connect')
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key' })
      .expect(400);
    await request(f.app.getHttpServer())
      .get('/api' + WEB_SEARCH_ROUTES.settings)
      .expect(404);
    await request(f.app.getHttpServer())
      .get('/api' + WEB_SEARCH_ROUTES.status + '?userId=u_b')
      .expect(400);
    await request(f.app.getHttpServer())
      .post('/api' + WEB_SEARCH_ROUTES.connect('exa'))
      .send({ protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key' })
      .expect(403);
  } finally { await f.close(); }
});

it('bounds request bodies before large JSON buffering', async () => {
  const f = await httpFixture();
  try {
    await request(f.app.getHttpServer())
      .post('/api' + WEB_SEARCH_ROUTES.connect('exa'))
      .set('Origin', origin)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ protocolVersion: 1, expectedRevision: 0, candidate: 'x'.repeat(20_000) }))
      .expect(413);
  } finally { await f.close(); }
});

it('preserves auth faults and isolates accounts', async () => {
  const f = await httpFixture();
  try {
    await request(f.app.getHttpServer())
      .post('/api' + WEB_SEARCH_ROUTES.connect('exa'))
      .set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key' })
      .expect(200);
    f.asOwner('u_b');
    const other = await request(f.app.getHttpServer())
      .get('/api' + WEB_SEARCH_ROUTES.status).expect(200);
    expect(other.body.revision).toBe(0);
    expect(other.body.providers.find((p: { provider: string }) => p.provider === 'exa').state)
      .toBe('not-connected');
    f.asOwner(null);
    const unauthenticated = await request(f.app.getHttpServer())
      .get('/api' + WEB_SEARCH_ROUTES.status).expect(401);
    expect(unauthenticated.body).toEqual({
      error: { code: 'UNAUTHENTICATED', retryable: false },
    });
  } finally { await f.close(); }
});
