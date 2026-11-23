/**
 * ============================================================================
 * FILE: request-environment-http.spec.ts
 * LOCATION: backend/test/http/request-environment-http.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify HTTP, CORS, and voice request-environment admission and forwarding.
 *
 * ROLE IN PROJECT:
 *    Proves X-Aurvin-Time-Zone flows through configurePrivateHttp, body-parser
 *    ALS restore, ChatHttpService submit/retry, CORS preflight, and
 *    VoiceSessionController -> SessionContext -> AgentVoiceAdapter.finalized
 *    without relaxing strict wire body schemas or idempotency.
 *
 * KEY COMPONENTS:
 *    - Chat HTTP submit/retry forwarding and strict wire-schema enforcement.
 *    - AppModule/configureApplication CORS preflight checks (calendar & plain).
 *    - VoiceSessionController + AgentVoiceAdapter finalized live-turn forwarding.
 * ============================================================================
 */

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { AppService } from '../../src/app.service.js';
import { ChatHttpModule, configureChatHttp } from '../../src/http/index.js';
import { configurePrivateHttp } from '../../src/http/configure-private-http.js';
import { configureApplication } from '../../src/main.js';
import { RequestIdentityStore } from '../../src/platform/identity/request-identity-store.js';
import { ServerIdentityResolver } from '../../src/platform/identity/server-identity-resolver.js';
import { RequestEnvironmentStore } from '../../src/platform/environment/request-environment-store.js';
import { loadBootstrapConfig } from '../../src/platform/config/bootstrap-config.js';
import { VoiceSessionController } from '../../src/voice/session/voice-session.controller.js';
import { VoiceSessionService } from '../../src/voice/session/voice-session.service.js';
import { VOICE_SESSION_OPTIONS } from '../../src/voice/session/voice-session.options.js';
import { AgentVoiceAdapter, type VoiceBridgeRuntime } from '../../src/voice/agent/agent-voice-adapter.js';
import type { LiveFlow } from '../../src/voice/session/live-flow.js';
import { principal } from '../assembly/auth-principal-fixture.js';
import { fixtureOptions, submission } from './fixtures.js';
import { options as voiceOptions, origin as voiceOrigin, owner as voiceOwner, request as voiceRequest } from '../voice/session/fixtures.js';
import { assembledCalendarApp } from '../assembly/calendar-fixture.js';
import { AURVIN_CONFIG } from '../../src/platform/tokens.js';

describe('request environment HTTP and voice propagation', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it('forwards X-Aurvin-Time-Zone on chat submit and retry while keeping wire body schemas strict', async () => {
    const o = fixtureOptions();
    const identities = new RequestIdentityStore();
    const environments = new RequestEnvironmentStore();
    const identityResolver = new ServerIdentityResolver(identities);
    const admitted = principal('server-user');

    const module = await Test.createTestingModule({
      imports: [
        ChatHttpModule.register({
          ...o,
          identity: identityResolver,
          principal: () => identities.principal(),
          environment: environments,
        }),
      ],
    }).compile();

    const app = module.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    app.setGlobalPrefix('api');
    configurePrivateHttp(app, {
      auth: { authenticate: async () => ({ principal: admitted }) },
      identities,
      environments,
      frontendOrigin: 'http://127.0.0.1:5173',
      secureCookie: false,
    });
    configureChatHttp(app, o.budgets);
    app.use((req: Request, _res: Response, next: NextFunction) => {
      identities.restore(req);
      environments.restore(req);
      next();
    });
    await app.init();
    cleanups.push(() => app.close());

    const agent = request(app.getHttpServer());

    await agent
      .post('/api/sessions')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'aurvin_wos_session=ok')
      .set('X-Aurvin-Time-Zone', 'Asia/Kolkata')
      .send(submission)
      .expect(202);
    expect(o.runtime.submitTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientTimeZone: 'Asia/Kolkata', content: submission.content }),
    );

    await agent
      .post('/api/sessions/s1/turns')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'aurvin_wos_session=ok')
      .set('X-Aurvin-Time-Zone', '  America/New_York  ')
      .send({ ...submission, sessionId: 's1', idempotencyKey: 'request-0002' })
      .expect(202);
    expect(o.runtime.submitTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientTimeZone: 'America/New_York', sessionId: 's1' }),
    );

    await agent
      .post('/api/sessions/s1/turns/t1/retry')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'aurvin_wos_session=ok')
      .set('X-Aurvin-Time-Zone', 'Europe/London')
      .send({ idempotencyKey: 'retry-0001' })
      .expect(202);
    expect(o.runtime.retryTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientTimeZone: 'Europe/London', sessionId: 's1', turnId: 't1' }),
    );

    // Invalid timezone header normalizes to null (omitted) without breaking valid request
    await agent
      .post('/api/sessions')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'aurvin_wos_session=ok')
      .set('X-Aurvin-Time-Zone', 'Invalid/Zone')
      .send({ ...submission, idempotencyKey: 'request-0003' })
      .expect(202);
    const lastCall = vi.mocked(o.runtime.submitTurn).mock.calls.at(-1)?.[0];
    expect(lastCall?.clientTimeZone).toBeUndefined();

    // Strict wire body schema still rejects client timeZone field in JSON body
    const rejected = await agent
      .post('/api/sessions')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'aurvin_wos_session=ok')
      .send({ ...submission, idempotencyKey: 'request-0004', timeZone: 'Asia/Kolkata' })
      .expect(400);
    expect(rejected.body.error?.code ?? rejected.body.code).toBe('UNKNOWN_FIELD');
  });

  it('includes X-Aurvin-Time-Zone in CORS allowedHeaders for both non-calendar and calendar configurations', async () => {
    const previous = { NODE_ENV: process.env.NODE_ENV, FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN };
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_ORIGIN = 'https://app.example.test';
    try {
      const nonCalService = await AppService.create(
        loadBootstrapConfig({ NODE_ENV: 'production', FRONTEND_ORIGIN: 'https://app.example.test' }),
        { writeLog: () => undefined },
      );
      cleanups.push(() => nonCalService.operations.shutdown().then(() => undefined));
      const nonCalMod = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AppService).useValue(nonCalService)
        .compile();
      const nonCalApp = nonCalMod.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
      configureApplication(nonCalApp);
      await nonCalApp.init();
      cleanups.push(() => nonCalApp.close());

      const plainPreflight = await request(nonCalApp.getHttpServer())
        .options('/api/sessions')
        .set('Origin', 'https://app.example.test')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);
      expect(plainPreflight.headers['access-control-allow-headers']).toContain('X-Aurvin-Time-Zone');
    } finally {
      if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.NODE_ENV;
      if (previous.FRONTEND_ORIGIN === undefined) delete process.env.FRONTEND_ORIGIN;
      else process.env.FRONTEND_ORIGIN = previous.FRONTEND_ORIGIN;
    }

    const cal = await assembledCalendarApp({ connected: true });
    cleanups.push(() => cal.dispose());
    const prevCal = { NODE_ENV: process.env.NODE_ENV, FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN };
    process.env.NODE_ENV = 'development';
    process.env.FRONTEND_ORIGIN = 'http://127.0.0.1:5173';
    try {
      const calMod = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AURVIN_CONFIG).useValue(cal.bootstrap)
        .overrideProvider(AppService).useValue(cal.service)
        .compile();
      const calApp = calMod.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
      configureApplication(calApp);
      await calApp.init();
      cleanups.push(() => calApp.close());

      const calPreflight = await request(calApp.getHttpServer())
        .options('/api/sessions')
        .set('Origin', 'http://127.0.0.1:5173')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);
      expect(calPreflight.headers['access-control-allow-headers']).toContain('X-Aurvin-Time-Zone');
      expect(calPreflight.headers['access-control-allow-headers']).toContain('X-Aurvin-Calendar-CSRF');
    } finally {
      if (prevCal.NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevCal.NODE_ENV;
      if (prevCal.FRONTEND_ORIGIN === undefined) delete process.env.FRONTEND_ORIGIN;
      else process.env.FRONTEND_ORIGIN = prevCal.FRONTEND_ORIGIN;
    }
  });

  it('captures X-Aurvin-Time-Zone on VoiceSessionController creation and forwards it through AgentVoiceAdapter.finalized', async () => {
    const o = voiceOptions();
    const identities = new RequestIdentityStore();
    const environments = new RequestEnvironmentStore();

    const module = await Test.createTestingModule({
      controllers: [VoiceSessionController],
      providers: [
        { provide: VOICE_SESSION_OPTIONS, useValue: o },
        VoiceSessionService,
        { provide: RequestIdentityStore, useValue: identities },
        { provide: RequestEnvironmentStore, useValue: environments },
      ],
    }).compile();

    const app = module.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    app.setGlobalPrefix('api');
    configurePrivateHttp(app, {
      auth: { authenticate: async () => ({ principal: voiceOwner }) },
      identities,
      environments,
      frontendOrigin: voiceOrigin,
      secureCookie: false,
    });
    configureChatHttp(app);
    app.use((req: Request, _res: Response, next: NextFunction) => {
      identities.restore(req);
      environments.restore(req);
      next();
    });
    await app.init();
    const sessions = app.get(VoiceSessionService);
    cleanups.push(async () => {
      await sessions.drain();
      await app.close();
    });

    const agent = request(app.getHttpServer());

    // Strict DTO still rejects clientTimeZone in body
    await agent
      .post('/api/voice/sessions')
      .set('Origin', voiceOrigin)
      .set('Cookie', 'aurvin_wos_session=ok')
      .send({ ...voiceRequest, mode: 'live', clientTimeZone: 'Asia/Kolkata' })
      .expect(400);

    // Valid POST with X-Aurvin-Time-Zone and spoofed untrusted cf-ipcity header
    const created = await agent
      .post('/api/voice/sessions')
      .set('Origin', voiceOrigin)
      .set('Cookie', 'aurvin_wos_session=ok')
      .set('X-Aurvin-Time-Zone', 'Asia/Kolkata')
      .set('cf-ipcity', 'SpoofedCity')
      .send({ ...voiceRequest, mode: 'live', idempotencyKey: 'voice-tz-req-1' })
      .expect(201);

    const binding = sessions.claimLive(
      created.body.sessionId,
      created.body.livekit.participantIdentity,
      created.body.livekit.roomName,
    );
    expect(binding.clientTimeZone).toBe('Asia/Kolkata');
    expect(binding.requestGeo).toBeNull();

    const runtime: VoiceBridgeRuntime = {
      submitLiveTurn: vi.fn(async cmd => ({
        sessionId: cmd.sessionId,
        turnId: 'vt-1',
        attemptId: 'va-1',
        userMessageId: 'vm-1',
        streamPath: '/stream',
      })),
      findLiveSubmission: vi.fn(async () => null),
      reconcileSession: vi.fn(async () => undefined),
      getLiveTurnStatus: vi.fn(async (_u, s, t) => ({
        sessionId: s,
        turnId: t,
        attemptId: 'va-1',
        status: 'completed' as const,
        truncated: false,
        error: null,
      })),
      getLiveDelivery: vi.fn(async () => null),
      cancelLiveTurn: vi.fn(async () => undefined),
      executeTurn: vi.fn(async () => undefined),
    };
    const bridge = new AgentVoiceAdapter(runtime, async (_voiceId, conversationId) => {
      binding.response.conversationId = conversationId;
      binding.reservation = { ...binding.reservation!, conversationId };
    });
    const flow = {
      waitForOutput: async () => true,
      providerSocketId: 'sock-1',
      prepareResponse: () => ({ providerBaseSamples: 0 }),
      modelStarted: vi.fn(),
      modelOutput: vi.fn(),
      deliverySettled: vi.fn(),
    } as unknown as LiveFlow;
    const sink = {
      outputSamples: () => 0,
      event: vi.fn(),
      audio: vi.fn(),
      invalidate: vi.fn(),
      finish: vi.fn(),
    };
    bridge.attach(binding, flow, sink);
    await bridge.finalized(
      binding,
      { providerSocketEpoch: 0, providerTurnId: 'p-1', text: 'What time is it?' },
      new AbortController().signal,
    );

    expect(runtime.submitLiveTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        clientTimeZone: 'Asia/Kolkata',
        content: 'What time is it?',
      }),
    );
  });

  it('captures trusted geo when RequestEnvironmentStore runs under trustedGeoProxy and still captures X-Aurvin-Time-Zone when RequestEnvironmentStore is optional/omitted', async () => {
    const o1 = voiceOptions();
    const identities1 = new RequestIdentityStore();
    const environments1 = new RequestEnvironmentStore();
    const modWithTrustedProxy = await Test.createTestingModule({
      controllers: [VoiceSessionController],
      providers: [
        { provide: VOICE_SESSION_OPTIONS, useValue: o1 },
        VoiceSessionService,
        { provide: RequestIdentityStore, useValue: identities1 },
        { provide: RequestEnvironmentStore, useValue: environments1 },
      ],
    }).compile();
    const app1 = modWithTrustedProxy.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    app1.setGlobalPrefix('api');
    configurePrivateHttp(app1, {
      auth: { authenticate: async () => ({ principal: voiceOwner }) },
      identities: identities1,
      environments: environments1,
      trustedGeoProxy: req => req.headers['x-forwarded-proto'] === 'https',
      frontendOrigin: voiceOrigin,
      secureCookie: false,
    });
    configureChatHttp(app1);
    app1.use((req: Request, _res: Response, next: NextFunction) => {
      identities1.restore(req);
      environments1.restore(req);
      next();
    });
    await app1.init();
    const sessions1 = app1.get(VoiceSessionService);
    cleanups.push(async () => {
      await sessions1.drain();
      await app1.close();
    });

    const trustedRes = await request(app1.getHttpServer())
      .post('/api/voice/sessions')
      .set('Origin', voiceOrigin)
      .set('Cookie', 'aurvin_wos_session=ok')
      .set('x-forwarded-proto', 'https')
      .set('X-Aurvin-Time-Zone', 'Asia/Kolkata')
      .set('cf-ipcity', 'Chennai')
      .set('cf-region', 'Tamil%20Nadu')
      .set('cf-ipcountry', 'IN')
      .send({ ...voiceRequest, mode: 'live', idempotencyKey: 'voice-geo-trusted-1' })
      .expect(201);
    const trustedBinding = sessions1.claimLive(
      trustedRes.body.sessionId,
      trustedRes.body.livekit.participantIdentity,
      trustedRes.body.livekit.roomName,
    );
    expect(trustedBinding.clientTimeZone).toBe('Asia/Kolkata');
    expect(trustedBinding.requestGeo).toEqual({
      city: 'Chennai',
      region: 'Tamil Nadu',
      country: 'IN',
      source: 'cloudflare',
    });

    // Without RequestEnvironmentStore injected, controller still captures X-Aurvin-Time-Zone and fails closed on geo
    const o2 = voiceOptions();
    const identities2 = new RequestIdentityStore();
    const modWithoutStore = await Test.createTestingModule({
      controllers: [VoiceSessionController],
      providers: [
        { provide: VOICE_SESSION_OPTIONS, useValue: o2 },
        VoiceSessionService,
        { provide: RequestIdentityStore, useValue: identities2 },
      ],
    }).compile();
    const app2 = modWithoutStore.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    app2.setGlobalPrefix('api');
    app2.use((_req: Request, _res: Response, next: NextFunction) => identities2.run(voiceOwner, next));
    configureChatHttp(app2);
    await app2.init();
    const sessions2 = app2.get(VoiceSessionService);
    cleanups.push(async () => {
      await sessions2.drain();
      await app2.close();
    });

    const fallbackRes = await request(app2.getHttpServer())
      .post('/api/voice/sessions')
      .set('Origin', voiceOrigin)
      .set('x-forwarded-proto', 'https')
      .set('X-Aurvin-Time-Zone', 'America/New_York')
      .set('cf-ipcity', 'Chennai')
      .send({ ...voiceRequest, mode: 'live', idempotencyKey: 'voice-geo-optional-1' })
      .expect(201);
    const fallbackBinding = sessions2.claimLive(
      fallbackRes.body.sessionId,
      fallbackRes.body.livekit.participantIdentity,
      fallbackRes.body.livekit.roomName,
    );
    expect(fallbackBinding.clientTimeZone).toBe('America/New_York');
    expect(fallbackBinding.requestGeo).toBeNull();
  });
});
