/**
 * ============================================================================
 * FILE: web-search-composition.spec.ts
 * LOCATION: backend/test/assembly/web-search-composition.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify one web-search assembly over the existing AppService/runtime owner.
 *
 * ROLE IN PROJECT:
 *    Proves the plugin, runtime dependency, readiness, shutdown, and real HTTP
 *    authentication share one composition and never prepare web inside a turn.
 *
 * KEY COMPONENTS:
 *    - webCompositionFixture: Assembly fixture with captured runtime dependencies.
 *    - Composition/lifecycle: one open, one runtime, no readiness traffic.
 *    - Real HTTP auth: /auth/me warms outside the turn; submit/SSE do not.
 * ============================================================================
 */

import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { AppService } from '../../src/app.service.js';
import { configureApplication } from '../../src/main.js';
import { AURVIN_CONFIG } from '../../src/platform/tokens.js';
import { RequestIdentityStore } from '../../src/platform/identity/request-identity-store.js';
import { ServerIdentityResolver } from '../../src/platform/identity/server-identity-resolver.js';
import type { RuntimeDependencies } from '../../src/chat-runtime/ports.js';
import { ChatHttpModule } from '../../src/http/index.js';
import { AuthModule } from '../../src/auth/index.js';
import { configureChatHttp } from '../../src/http/configure-chat-http.js';
import { configurePrivateHttp } from '../../src/http/configure-private-http.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { assemblyFixture } from './admin-config-fixture.js';
import { admittedAccount, authFixture } from '../auth/fixtures.js';
import { session } from '../persistence/fixtures.js';

async function webCompositionFixture() {
  const f = assemblyFixture();
  const auth = await authFixture(admittedAccount());
  Object.assign(f.bundle, { users: auth.users });
  const identities = new RequestIdentityStore();
  const identity = new ServerIdentityResolver(identities);
  const dependencies: RuntimeDependencies[] = [];
  const runtime = vi.fn((d: RuntimeDependencies) => {
    dependencies.push(d);
    return f.raw as never;
  });
  const service = await AppService.create(f.bootstrap, {
    ...f.ports, identities, identity, runtime: runtime as never,
    authProvider: () => auth.provider,
  });
  return { f, auth, service, identities, identity, dependencies, runtime,
    origin: f.bootstrap.frontendOrigin };
}

async function assembled(f: Awaited<ReturnType<typeof webCompositionFixture>>) {
  const previous = { NODE_ENV: process.env.NODE_ENV, FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN };
  process.env.NODE_ENV = 'development';
  process.env.FRONTEND_ORIGIN = f.origin;
  try {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AURVIN_CONFIG).useValue(f.f.bootstrap)
      .overrideProvider(AppService).useValue(f.service).compile();
    const app = module.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    configureApplication(app);
    await app.init();
    return app;
  } finally {
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.FRONTEND_ORIGIN === undefined) delete process.env.FRONTEND_ORIGIN;
    else process.env.FRONTEND_ORIGIN = previous.FRONTEND_ORIGIN;
  }
}

async function chatApp(f: Awaited<ReturnType<typeof webCompositionFixture>>) {
  const module = await Test.createTestingModule({
    imports: [
      AuthModule.register({ service: f.service.auth, secureCookie: false }),
      ChatHttpModule.register({
        ...f.service.httpOptions(f.service.identity),
        runtime: f.f.raw as never,
        sessions: {
          get: vi.fn(async (userId: string, sessionId: string) => session(userId, sessionId)),
          list: vi.fn(async () => ({ items: [], nextCursor: null })),
          createIfAbsent: vi.fn(async record => record),
          touchActivity: vi.fn(async () => undefined),
          update: vi.fn(async () => undefined),
          delete: vi.fn(async () => undefined),
        },
        budgets: DEFAULT_BUDGETS,
      }),
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  app.setGlobalPrefix('api');
  configurePrivateHttp(app, {
    auth: f.service.auth, identities: f.identities, frontendOrigin: f.origin, secureCookie: false,
    prepareOwner: principal => f.service.prepareOwner(principal),
  });
  configureChatHttp(app, DEFAULT_BUDGETS);
  await app.init();
  return app;
}

it('shares one persistence owner and runtime with plugin and voice and does not probe readiness', async () => {
  const f = await webCompositionFixture();
  expect(f.runtime).toHaveBeenCalledTimes(1);
  expect(f.f.open).toHaveBeenCalledTimes(1);
  expect(f.dependencies[0]!.webSearch).toBe(f.service.webSearchRuntime);
  expect(f.service.webSearchConnections).toBeDefined();
  expect(f.service.webSearchOAuth).toBeDefined();
  const app = await assembled(f);
  try {
    const agent = request(app.getHttpServer());
    await agent.get('/api/operations/live').expect(200);
    await agent.get('/api/operations/ready').expect(401);
    expect(f.f.fetcher).not.toHaveBeenCalled();
  } finally { await app.close(); }
  await f.service.operations.shutdown();
  expect(f.f.close).toHaveBeenCalledTimes(1);
});

it('warms web only on the real /auth/me control plane and never on submit or SSE', async () => {
  const f = await webCompositionFixture();
  const warm = vi.spyOn(f.service.webSearchConnections, 'warmOwner');
  const app = await chatApp(f);
  try {
    const agent = request(app.getHttpServer());
    await agent.get('/api/auth/me').set('Cookie', 'aurvin_wos_session=sealed_1').expect(200);
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith('u1');
    const accepted = await agent.post('/api/sessions')
      .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', f.origin)
      .send({ sessionId: null, content: 'Hello', idempotencyKey: 'web-composition-0001' })
      .expect(202);
    await agent.get(`/api${accepted.body.streamPath}`)
      .set('Cookie', 'aurvin_wos_session=sealed_1').expect(200);
    expect(warm).toHaveBeenCalledTimes(1);
  } finally { await app.close(); await f.service.operations.shutdown(); }
});

it('performs no application storage work from submit and SSE authentication to dispatch', async () => {
  const f = await webCompositionFixture();
  const app = await chatApp(f);
  const operations: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];
  try {
    const agent = request(app.getHttpServer());
    // Selected history and account/plugin state are prepared outside the turn.
    await agent.get('/api/auth/me').set('Cookie', 'aurvin_wos_session=sealed_1').expect(200);
    const fail = (label: string) => () => { operations.push(label); throw new Error('blocked-application-storage'); };
    for (const [name, port] of Object.entries(f.f.bundle)) {
      if (!port || typeof port !== 'object') continue;
      for (const key of Object.keys(port)) {
        if (typeof (port as Record<string, unknown>)[key] !== 'function') continue;
        spies.push(vi.spyOn(port as Record<string, () => unknown>, key)
          .mockImplementation(fail(`${name}.${key}`)));
      }
    }
    // Account authority must be memory-only: both account reads are blocked.
    spies.push(vi.spyOn(f.auth.users, 'bySubject').mockImplementation(fail('users.bySubject') as never));
    spies.push(vi.spyOn(f.auth.users, 'get').mockImplementation(fail('users.get') as never));
    const accepted = await agent.post('/api/sessions')
      .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', f.origin)
      .send({ sessionId: null, content: 'Hello', idempotencyKey: 'web-composition-0002' })
      .expect(202);
    await agent.get(`/api${accepted.body.streamPath}`)
      .set('Cookie', 'aurvin_wos_session=sealed_1').expect(200);
    // The only application-storage call is Calendar's existing prepareOwner
    // status refresh, which P3 must preserve. Web and account authority add none.
    expect(operations.filter(op => !op.startsWith('calendarConnectionsV2.'))).toEqual([]);
    expect(operations.every(op => op === 'calendarConnectionsV2.get')).toBe(true);
    expect(f.auth.provider.read).toHaveBeenCalledTimes(3);
  } finally {
    for (const spy of spies) spy.mockRestore();
    await app.close();
    await f.service.operations.shutdown();
  }
});

it('denies expired or uncertain authority before any dispatch', async () => {
  const f = await webCompositionFixture();
  const app = await chatApp(f);
  try {
    const agent = request(app.getHttpServer());
    await agent.get('/api/auth/me').set('Cookie', 'aurvin_wos_session=sealed_1').expect(200);
    f.service.auth.authority.close();
    await agent.post('/api/sessions')
      .set('Cookie', 'aurvin_wos_session=sealed_1').set('Origin', f.origin)
      .send({ sessionId: null, content: 'Hello', idempotencyKey: 'web-composition-0003' })
      .expect(503);
    expect(f.f.raw.submitTurn).not.toHaveBeenCalled();
  } finally { await app.close(); await f.service.operations.shutdown(); }
});
