/**
 * ============================================================================
 * FILE: authority-http.spec.ts
 * LOCATION: backend/test/auth/authority-http.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove real private HTTP authentication reaches model dispatch with no
 *    application database operation before the first model request.
 *
 * ROLE IN PROJECT:
 *    Uses the real AuthService, private middleware, chat controllers/SSE
 *    transport, DurableChatRuntime/MemoryText, and the model fetch boundary.
 *
 * KEY COMPONENTS:
 *    - Zero pre-model storage with a prepared account authority.
 *    - Cold/expired/uncertain/closed denial without a turn-path lookup.
 *    - Confirmed missing, inactive, onboarding, role, provider, and race cases.
 * ============================================================================
 */

import 'reflect-metadata';
import express from 'express';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { AccountAuthority } from '../../src/auth/account-authority.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { AuthFault } from '../../src/auth/errors.js';
import { configurePrivateHttp } from '../../src/http/configure-private-http.js';
import { ChatHttpModule } from '../../src/http/index.js';
import { configureChatHttp } from '../../src/http/configure-chat-http.js';
import { RequestIdentityStore } from '../../src/platform/identity/request-identity-store.js';
import { ServerIdentityResolver } from '../../src/platform/identity/server-identity-resolver.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { textConfigFixture } from '../runtime/text-config-fixture.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { admittedAccount, authFixture } from './fixtures.js';

it('real HTTP authentication reaches model dispatch with zero pre-model database operations', async () => {
  const identities = new RequestIdentityStore();
  const identity = new ServerIdentityResolver(identities);
  const f = await authFixture(admittedAccount({ userId: 'aurvin-dev-user' }));
  const h = textConfigFixture(textSnapshot(1), dependencies => ({
    ...dependencies,
    memoryFirst: {
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async envelope => ({
        kind: 'saved' as const, epoch: envelope.epoch, sessionId: envelope.sessionId,
        version: envelope.version, fence: envelope.fence,
      }),
    },
  }));
  const module = await Test.createTestingModule({
    imports: [ChatHttpModule.register({
      runtime: h.runtime, sessions: h.p.sessions, messages: h.p.messages,
      identity, principal: () => identities.principal(), budgets: DEFAULT_BUDGETS,
      currentConfig: h.currentConfig,
    })],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  app.setGlobalPrefix('api');
  configurePrivateHttp(app, {
    auth: f.service, identities, frontendOrigin: 'http://localhost:5173', secureCookie: false,
  });
  configureChatHttp(app, DEFAULT_BUDGETS);
  let operations = 0;
  const fail = () => { operations++; throw new Error('blocked-application-storage'); };
  const spies: Array<{ mockRestore(): void }> = [
    vi.spyOn(f.collection, 'findOne').mockImplementation(fail),
    vi.spyOn(f.collection, 'find').mockImplementation(fail),
    vi.spyOn(f.collection, 'updateOne').mockImplementation(fail),
    vi.spyOn(f.collection, 'replaceOne').mockImplementation(fail),
  ];
  // Guard every existing runtime persistence method too, not only users.bySubject.
  for (const port of Object.values(h.p)) {
    if (!port || typeof port !== 'object') continue;
    for (const key of Object.keys(port)) {
      if (typeof (port as Record<string, unknown>)[key] === 'function')
        spies.push(vi.spyOn(port as Record<string, () => unknown>, key).mockImplementation(fail));
    }
  }
  const wire = h.fetcher.getMockImplementation()!;
  let beforeModel: number | undefined;
  h.fetcher.mockImplementation(async (url, init) => {
    beforeModel = operations;
    expect(f.provider.read).toHaveBeenCalled();
    return wire(url, init);
  });
  try {
    await app.init();
    const api = request(app.getHttpServer());
    const accepted = await api.post('/api/sessions')
      .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', 'http://localhost:5173')
      .send({ sessionId: null, content: 'Hello', idempotencyKey: 'authority-http-0001' }).expect(202);
    await api.get(`/api${accepted.body.streamPath}`)
      .set('Cookie', 'aurvin_wos_session=sealed_1').expect(200);
    expect(beforeModel).toBe(0);
    expect(operations).toBe(0);
    expect(f.provider.read).toHaveBeenCalledTimes(2);
    const modelBody = JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body));
    expect(modelBody.user).toBe('aurvin-dev-user');
  } finally {
    for (const spy of spies) spy.mockRestore();
    await app.close();
    await h.dispose();
  }
});

it.each(['cold', 'expired', 'uncertain', 'closed'] as const)(
  'denies %s authority without opening storage or reaching the model', async mode => {
    const f = await authFixture(admittedAccount(), { warm: false });
    let now = 0;
    const authority = new AccountAuthority({ users: f.users, nowMs: () => now });
    if (mode !== 'cold') await authority.warm('user_fixture_1');
    if (mode === 'expired') now = 900_000;
    if (mode === 'uncertain') authority.fail(authority.fence('user_fixture_1'));
    if (mode === 'closed') authority.close();
    const auth = new AuthService({ users: f.users, provider: f.provider, authority });
    const app = express();
    const identities = new RequestIdentityStore();
    const dispatch = vi.fn();
    const lookup = vi.spyOn(f.users, 'bySubject').mockRejectedValue(new Error('blocked'));
    configurePrivateHttp({ use: app.use.bind(app) }, {
      auth, identities, frontendOrigin: 'http://localhost:5173', secureCookie: false,
    });
    app.post('/api/sessions', (_req, res) => { dispatch(); res.status(202).json({}); });
    const response = await request(app).post('/api/sessions')
      .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', 'http://localhost:5173')
      .send({}).expect(503);
    expect(response.body).toEqual({ error: { code: 'NOT_READY', retryable: true } });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  },
);

function privateApp(auth: AuthService, identities: RequestIdentityStore) {
  const app = express();
  configurePrivateHttp({ use: app.use.bind(app) }, {
    auth, identities, frontendOrigin: 'http://localhost:5173', secureCookie: false,
  });
  return app;
}

it('returns 401 for a confirmed missing mapping without a turn-path lookup', async () => {
  const f = await authFixture(admittedAccount(), { warm: false });
  const authority = new AccountAuthority({ users: f.users });
  await authority.warm('user_unmapped');
  f.provider.read.mockResolvedValue({ workosUserId: 'user_unmapped', sessionId: 'sid_1' });
  const auth = new AuthService({ users: f.users, provider: f.provider, authority });
  const app = privateApp(auth, new RequestIdentityStore());
  app.post('/api/sessions', (_req, res) => res.status(202).json({}));
  const response = await request(app).post('/api/sessions')
    .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', 'http://localhost:5173').send({}).expect(401);
  expect(response.body).toEqual({ error: { code: 'UNAUTHENTICATED', retryable: false } });
  expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
});

it.each([
  { status: 'inactive' as const },
  { currentWorkosSessionId: 'sid_other' },
])('returns 401 for an inactive or mismatched-SID authority %j', async patch => {
  const f = await authFixture(admittedAccount(patch));
  const app = privateApp(f.service, new RequestIdentityStore());
  app.post('/api/sessions', (_req, res) => res.status(202).json({}));
  const response = await request(app).post('/api/sessions')
    .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', 'http://localhost:5173').send({}).expect(401);
  expect(response.body).toEqual({ error: { code: 'UNAUTHENTICATED', retryable: false } });
});

it('returns 403 for an onboarding-gated account and a User admin route', async () => {
  const pending = await authFixture(admittedAccount({ passwordChangeRequired: true }));
  const pendingApp = privateApp(pending.service, new RequestIdentityStore());
  pendingApp.post('/api/sessions', (_req, res) => res.status(202).json({}));
  const onboarding = await request(pendingApp).post('/api/sessions')
    .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', 'http://localhost:5173').send({}).expect(403);
  expect(onboarding.body).toEqual({ error: { code: 'PASSWORD_CHANGE_REQUIRED', retryable: false } });

  const user = await authFixture(admittedAccount());
  const userApp = privateApp(user.service, new RequestIdentityStore());
  userApp.get('/api/admin/config', (_req, res) => res.json({ secret: 'must-not-be-read' }));
  const denied = await request(userApp).get('/api/admin/config')
    .set('Cookie', 'aurvin_wos_session=sealed_1').expect(403);
  expect(denied.body).toEqual({ error: { code: 'FORBIDDEN', retryable: false } });
  expect(JSON.stringify(denied.body)).not.toContain('must-not-be-read');
});

it('denies provider verification failure despite a ready snapshot', async () => {
  const f = await authFixture(admittedAccount());
  f.provider.read.mockRejectedValueOnce(new AuthFault('UNAUTHENTICATED'));
  const app = privateApp(f.service, new RequestIdentityStore());
  app.post('/api/sessions', (_req, res) => res.status(202).json({}));
  await request(app).post('/api/sessions')
    .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', 'http://localhost:5173').send({}).expect(401);
});

it('a held provider verification cannot admit after a later deactivation', async () => {
  const f = await authFixture(admittedAccount());
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.provider.read.mockImplementationOnce(async () => {
    entered(); await held;
    return { workosUserId: 'user_fixture_1', sessionId: 'sid_1' };
  });
  const app = privateApp(f.service, new RequestIdentityStore());
  app.post('/api/sessions', (_req, res) => res.status(202).json({}));
  const pending = request(app).post('/api/sessions')
    .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', 'http://localhost:5173').send({})
    .then(response => response);
  await began;
  const current = (await f.users.get('u1'))!;
  const revoke = f.authority.fence('user_fixture_1', 'revocation');
  const deactivated = await f.users.compareAndSwap(current,
    { ...current.account, status: 'inactive', currentWorkosSessionId: null, sessionEpoch: 1 });
  if (deactivated.outcome !== 'confirmed') throw new Error('fixture deactivation was not confirmed');
  f.authority.publish(revoke, deactivated.value);
  release();
  const response = await pending;
  expect(response.status).toBe(401);
  expect(response.body).toEqual({ error: { code: 'UNAUTHENTICATED', retryable: false } });
});

it('keeps credentials and account internals out of HTTP, model, and log projections', async () => {
  const identities = new RequestIdentityStore();
  const identity = new ServerIdentityResolver(identities);
  const f = await authFixture(admittedAccount({ userId: 'aurvin-dev-user' }));
  const h = textConfigFixture(textSnapshot(1), dependencies => ({
    ...dependencies,
    memoryFirst: {
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async envelope => ({
        kind: 'saved' as const, epoch: envelope.epoch, sessionId: envelope.sessionId,
        version: envelope.version, fence: envelope.fence,
      }),
    },
  }));
  const module = await Test.createTestingModule({
    imports: [ChatHttpModule.register({
      runtime: h.runtime, sessions: h.p.sessions, messages: h.p.messages,
      identity, principal: () => identities.principal(), budgets: DEFAULT_BUDGETS,
      currentConfig: h.currentConfig,
    })],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  app.setGlobalPrefix('api');
  configurePrivateHttp(app, {
    auth: f.service, identities, frontendOrigin: 'http://localhost:5173', secureCookie: false,
  });
  configureChatHttp(app, DEFAULT_BUDGETS);
  const logs: string[] = [];
  const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(value => String(value)).join(' '));
    }));
  const responses: unknown[] = [];
  const modelBodies: unknown[] = [];
  try {
    await app.init();
    const api = request(app.getHttpServer());
    const accepted = await api.post('/api/sessions')
      .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', 'http://localhost:5173')
      .send({ sessionId: null, content: 'Hello', idempotencyKey: 'authority-http-0002' }).expect(202);
    responses.push(accepted.body);
    const stream = await api.get(`/api${accepted.body.streamPath}`)
      .set('Cookie', 'aurvin_wos_session=sealed_1').expect(200);
    responses.push(stream.text);
    modelBodies.push(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body)));
    const visible = JSON.stringify({ responses, modelBodies, logs });
    for (const secret of ['raw-password-sentinel', 'raw-reset-token', 'sealed_1', 'raw-access', 'raw-refresh'])
      expect(visible).not.toContain(secret);
    expect(visible).not.toMatch(/sessionEpoch|currentWorkosSessionId|emailNormalized|workosUserId/);
  } finally {
    for (const spy of consoleSpies) spy.mockRestore();
    await app.close();
    await h.dispose();
  }
});
