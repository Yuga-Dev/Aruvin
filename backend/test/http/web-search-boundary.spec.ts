/**
 * ============================================================================
 * FILE: web-search-boundary.spec.ts
 * LOCATION: backend/test/http/web-search-boundary.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the bounded plugin JSON parser and exact callback exemptions.
 *
 * ROLE IN PROJECT:
 *    Proves oversized/malformed plugin bodies are rejected before buffering,
 *    unrelated routes keep their parser, and only the five static callbacks
 *    bypass private authentication.
 * ============================================================================
 */

import express from 'express';
import request from 'supertest';
import { configurePrivateHttp } from '../../src/http/configure-private-http.js';
import { configureWebSearchHttp, WEB_SEARCH_CALLBACK_PATHS }
  from '../../src/http/web-search-boundary.js';
import { WEB_SEARCH_ROUTES } from '../../src/contracts/web-search-wire.js';
import { WEB_SEARCH_PROVIDERS } from '../../src/contracts/web-search-policy.js';
import { RequestIdentityStore } from '../../src/platform/identity/request-identity-store.js';
import { admittedAccount, authFixture } from '../auth/fixtures.js';

const settings = `/api${WEB_SEARCH_ROUTES.settings}`;
const complete = `/api${WEB_SEARCH_ROUTES.oauthComplete('exa')}`;

function appWith(auth: Awaited<ReturnType<typeof authFixture>>) {
  const app = express();
  const identities = new RequestIdentityStore();
  configurePrivateHttp({ use: app.use.bind(app) }, {
    auth: auth.service, identities, frontendOrigin: 'http://localhost:5173', secureCookie: false,
  });
  configureWebSearchHttp({ use: app.use.bind(app) });
  app.use(express.json({ limit: 262_144 }));
  app.patch(settings, (req, res) => {
    res.status(200).json({ seen: req.body });
  });
  app.post('/api/plugins/web-search/providers/:provider/connect', (req, res) => {
    res.status(200).json({ seen: req.body });
  });
  app.get('/api/plugins/web-search/providers/:provider/oauth/callback', (_req, res) => {
    res.status(200).type('html').send('<html>callback</html>');
  });
  app.post(complete, (_req, res) => {
    res.status(200).json({});
  });
  app.post('/api/sessions', (_req, res) => { res.status(202).json({}); });
  return app;
}

const cookie = 'aurvin_wos_session=sealed_1';
const origin = 'http://localhost:5173';

it('rejects a 16,385-byte plugin body with the P1 error before buffering', async () => {
  const auth = await authFixture(admittedAccount());
  const app = appWith(auth);
  const body = JSON.stringify({ protocolVersion: 1, expectedRevision: 0, enabled: true,
    pad: 'a'.repeat(16_385) });
  expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(16_384);
  const response = await request(app).patch(settings)
    .set('Cookie', cookie).set('Origin', origin)
    .set('Content-Type', 'application/json').send(body).expect(413);
  expect(response.body).toMatchObject({ protocolVersion: 1,
    error: { code: 'WEB_INPUT_TOO_LARGE', retryable: false, currentRevision: null } });
});

it('accepts a bounded plugin body and rejects malformed JSON without parser text', async () => {
  const auth = await authFixture(admittedAccount());
  const app = appWith(auth);
  const ok = await request(app).patch(settings)
    .set('Cookie', cookie).set('Origin', origin)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ protocolVersion: 1, expectedRevision: 0, enabled: true }))
    .expect(200);
  expect(ok.body.seen).toMatchObject({ enabled: true });
  const bad = await request(app).patch(settings)
    .set('Cookie', cookie).set('Origin', origin)
    .set('Content-Type', 'application/json').send('{"enabled":').expect(400);
  expect(bad.body).toMatchObject({ error: { code: 'WEB_INVALID_REQUEST' } });
});

it('keeps unrelated routes on the generic parser and protects plugin mutations', async () => {
  const auth = await authFixture(admittedAccount());
  const app = appWith(auth);
  await request(app).post('/api/sessions').set('Cookie', cookie).set('Origin', origin)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ pad: 'a'.repeat(20_000) })).expect(202);
  await request(app).patch(settings)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ protocolVersion: 1, expectedRevision: 0, enabled: true }))
    .expect(403);
});

it('exempts exactly the five static GET callbacks and nothing else', async () => {
  const auth = await authFixture(admittedAccount());
  const app = appWith(auth);
  expect([...WEB_SEARCH_CALLBACK_PATHS].sort()).toEqual(
    WEB_SEARCH_PROVIDERS
      .map(provider => `/api${WEB_SEARCH_ROUTES.oauthCallback(provider)}`).sort());
  for (const path of WEB_SEARCH_CALLBACK_PATHS) {
    await request(app).get(path).expect(200);
  }
  await request(app).get('/api/plugins/web-search/status').expect(401);
  await request(app).post(complete)
    .set('Content-Type', 'application/json').send('{}').expect(403);
});
