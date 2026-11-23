/**
 * ============================================================================
 * FILE: user-memory-http.spec.ts
 * LOCATION: backend/src/personalization/user-memory-http.spec.ts
 * PURPOSE: Exercise the private memory routes without external services.
 * ROLE IN PROJECT: Runs real Nest, ingress validation, and cookie/CSRF admission.
 * KEY COMPONENTS: Two-role fixtures, revision flow, closed failures and headers.
 * ============================================================================
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { AuthFault } from '../auth/errors.js';
import { DEFAULT_BUDGETS } from '../contracts/budgets.js';
import type { UserMemoryRepository } from '../contracts/repositories.js';
import { userMemoryEditResponseSchema, userMemoryResponseSchema, type StoredUserMemory } from '../contracts/user-memory.js';
import { configurePrivateHttp } from '../http/configure-private-http.js';
import { RequestIdentityStore } from '../platform/identity/request-identity-store.js';
import { principal } from '../../test/assembly/auth-principal-fixture.js';
import { configurePersonalizationHttp, PersonalizationModule, PersonalizationService } from './index.js';
import { MemoryWriterService } from './memory-writer.js';
import { UserMemoryService } from './user-memory.service.js';

const path = '/api/personalization/memory';
const origin = 'http://127.0.0.1:5173';
const time = '2026-11-20T12:00:00.000Z';
const empty = { identity: '', work: '', preferences: '', ongoing: '', other: '' };
const revision = (expectedRevision: number) => ({ protocolVersion: 1, expectedRevision });
const cookie = (name: string) => `aurvin_wos_session=${name}`;

async function fixture(wired = true) {
  const rows = new Map<string, StoredUserMemory>(['alice', 'bob'].map(userId => [userId, {
    userId, schemaVersion: 1, enabled: true, revision: 1, updatedAt: time,
    sections: { ...empty, identity: userId === 'alice' ? 'Dog: Beans.' : 'Private Bob fact.' },
  }]));
  const save = async (...[userId, expected, settings, updatedAt]:
    Parameters<UserMemoryRepository['compareAndSwap']>) => {
    const currentRevision = rows.get(userId)?.revision ?? 0;
    if (expected !== currentRevision) return { outcome: 'conflict', currentRevision } as const;
    const record = { ...settings, schemaVersion: 1 as const, userId, revision: expected + 1, updatedAt };
    rows.set(userId, record);
    return { outcome: 'confirmed', record } as const;
  };
  const repo = {
    read: vi.fn<UserMemoryRepository['read']>(async userId => rows.get(userId) ?? null),
    createIfAbsent: vi.fn<UserMemoryRepository['createIfAbsent']>((id, settings, at) => save(id, 0, settings, at)),
    compareAndSwap: vi.fn<UserMemoryRepository['compareAndSwap']>(save),
  };
  const memory = new UserMemoryService({ repository: () => repo, now: () => new Date(time) });
  const fetcher = vi.fn<typeof fetch>(async () => {
    const content = JSON.stringify({ changed: true, changeSummary: 'Updated preferences',
      sections: { ...empty, identity: 'Dog: Beans.', preferences: 'Concise.' } });
    const event = JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
    return new Response(`data: ${event}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  const writer = new MemoryWriterService({ memory, fetcher, putAccounting: async () => undefined,
    currentConfig: () => ({
      memoryModelId: 'fixture/main', budgets: DEFAULT_BUDGETS,
      settings: { memory: { modelMode: 'main', customModelId: null } },
      openRouter: { apiKey: 'fixture-key', modelId: 'fixture/main', reasoningEffort: 'provider-default',
        dataCollection: 'deny', disableTransforms: true },
      modelLimits: { modelId: 'fixture/main', contextTokens: 32_768, outputTokens: 4096,
        supportsMaxTokens: true, source: 'fixture' },
    }),
  });
  const identities = new RequestIdentityStore();
  const mod = await Test.createTestingModule({
    imports: [PersonalizationModule.registerAsync({ useFactory: () => ({
      service: new PersonalizationService({ repository: () => null }),
      userId: () => identities.resolve().userId,
      userMemoryService: wired ? memory : undefined,
      memoryWriter: wired ? writer : undefined,
    }) })],
  }).compile();
  const app = mod.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  app.setGlobalPrefix('api');
  configurePrivateHttp(app, { identities, frontendOrigin: origin, secureCookie: false, auth: {
    authenticate: async c => {
      if (!c) throw new AuthFault('UNAUTHENTICATED');
      return { principal: principal(c, c === 'bob' ? 'super-admin' : 'user', c === 'pending') };
    },
  } });
  configurePersonalizationHttp(app);
  app.use((req: Request, _res: ExpressResponse, next: NextFunction) => {
    identities.restore(req);
    next();
  });
  await app.init();
  const http = request(app.getHttpServer());
  return { app, http, repo, fetcher };
}

function expectPrivate(headers: Record<string, unknown>): void {
  expect(headers['cache-control']).toBe('no-store');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['etag']).toBeUndefined();
}

it('reads only the server-resolved owner and allows edit/clear while paused', async () => {
  const { app, http, fetcher } = await fixture();
  try {
    const alice = await http.get(path).set('Cookie', cookie('alice')).expect(200);
    expectPrivate(alice.headers);
    expect(userMemoryResponseSchema.parse(alice.body)).toEqual({
      protocolVersion: 1, revision: 1, enabled: true, sections: { ...empty, identity: 'Dog: Beans.' },
      isEmpty: false, charCount: 23, maxChars: 2500, updatedAt: time,
    });
    const bob = await http.get(path).set('Cookie', cookie('bob')).expect(200);
    expect(bob.body.sections.identity).toBe('Private Bob fact.');
    const absent = await http.get(path).set('Cookie', cookie('zoe')).expect(200);
    expect(userMemoryResponseSchema.parse(absent.body)).toEqual({
      protocolVersion: 1, revision: 0, enabled: true, sections: empty, isEmpty: true,
      charCount: 0, maxChars: 2500, updatedAt: null,
    });

    const pause = await http.patch(`${path}/enabled`).set('Cookie', cookie('alice')).set('Origin', origin)
      .send({ ...revision(1), enabled: false }).expect(200);
    expect(pause.body).toMatchObject({ revision: 2, enabled: false, sections: { identity: 'Dog: Beans.' } });
    const stale = await http.post(`${path}/edit`).set('Cookie', cookie('alice')).set('Origin', origin)
      .send({ ...revision(1), instruction: 'Prefer concise replies' }).expect(409);
    expectPrivate(stale.headers);
    expect(stale.body).toMatchObject({ protocolVersion: 1, error: {
      code: 'MEMORY_CONFLICT', retryable: false, currentRevision: 2,
    } });
    expect(fetcher).not.toHaveBeenCalled();
    const edit = await http.post(`${path}/edit`).set('Cookie', cookie('alice')).set('Origin', origin)
      .send({ ...revision(2), instruction: 'Prefer concise replies' }).expect(200);
    expect(userMemoryEditResponseSchema.parse(edit.body)).toMatchObject({
      revision: 3, enabled: false, sections: { preferences: 'Concise.' }, changeSummary: 'Updated preferences',
    });
    const clear = await http.post(`${path}/clear`).set('Cookie', cookie('alice')).set('Origin', origin)
      .send(revision(3)).expect(200);
    expect(clear.body).toMatchObject({ revision: 4, enabled: false, sections: empty, isEmpty: true, charCount: 0 });
    expect((await http.get(path).set('Cookie', cookie('bob')).expect(200)).body).toEqual(bob.body);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

it('rejects unauthenticated, onboarding, cross-site and wrong-origin requests before memory work', async () => {
  const { app, http, repo, fetcher } = await fixture();
  try {
    expectPrivate((await http.get(path).expect(401)).headers);
    await http.get(path).set('Cookie', cookie('pending')).expect(403);
    await http.post(`${path}/edit`).set('Cookie', cookie('alice')).send({}).expect(403);
    await http.post(`${path}/edit`).set('Cookie', cookie('alice')).set('Origin', 'https://other.example')
      .send({}).expect(403);
    await http.patch(`${path}/enabled`).set('Cookie', cookie('alice')).set('Origin', origin)
      .set('Sec-Fetch-Site', 'cross-site').send({}).expect(403);
    await http.post(`${path}/clear`).set('Origin', origin).send(revision(1)).expect(401);
    expect(repo.read).not.toHaveBeenCalled();
    expect(repo.createIfAbsent).not.toHaveBeenCalled();
    expect(repo.compareAndSwap).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('guards query, identity, strict JSON, byte limit, and unsafe instruction before provider work', async () => {
  const { app, http, repo, fetcher } = await fixture();
  try {
    const edit = (suffix = '') => http.post(`${path}/edit${suffix}`).set('Cookie', cookie('alice')).set('Origin', origin);
    const query = await http.get(`${path}?userId=bob`).set('Cookie', cookie('alice')).expect(400);
    expectPrivate(query.headers);
    expect(query.body).toMatchObject({ protocolVersion: 1, error: { code: 'INVALID_REQUEST' } });
    await http.head(`${path}?userId=bob`).set('Cookie', cookie('alice')).expect(400);
    await http.get(path).set('Cookie', cookie('alice')).send({ userId: 'bob' }).expect(400);
    await edit('?userId=bob').send({ ...revision(1), instruction: 'Safe' }).expect(400);
    await edit().send({ ...revision(1), instruction: 'Safe', userId: 'bob' }).expect(400);
    await edit().set('Content-Type', 'application/json').send('[]').expect(400);
    await edit().set('Content-Type', 'application/json').send('{').expect(400);
    await edit().set('Content-Type', 'text/plain').send('{}').expect(400);
    await edit().set('Content-Encoding', 'gzip').send({}).expect(400);
    await edit().send({ ...revision(1), instruction: 'x'.repeat(17_000) }).expect(413);
    for (const instruction of ['x'.repeat(501), '\u0000a', 'sk-or-v1-fixture']) {
      const result = await edit().send({ ...revision(1), instruction }).expect(400);
      expect(result.body.error.code).toBe('INVALID_REQUEST');
      expect(JSON.stringify(result.body)).not.toContain(instruction);
    }
    expect(repo.read).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('uses closed 503 responses for missing composition, storage, or writer failure', async () => {
  const disabled = await fixture(false);
  try {
    const result = await disabled.http.get(path).set('Cookie', cookie('alice')).expect(503);
    expectPrivate(result.headers);
    expect(result.body).toMatchObject({ protocolVersion: 1, error: { code: 'NOT_READY' } });
  } finally {
    await disabled.app.close();
  }
  const { app, http, repo, fetcher } = await fixture();
  try {
    repo.read.mockRejectedValueOnce(new Error('raw storage fixture message'));
    const storage = await http.get(path).set('Cookie', cookie('alice')).expect(503);
    expect(storage.body.error.code).toBe('PERSISTENCE_ERROR');
    expect(JSON.stringify(storage.body)).not.toContain('raw storage fixture message');
    fetcher.mockResolvedValueOnce(Response.json({ error: { message: 'raw provider fixture message' } }, { status: 503 }));
    const writer = await http.post(`${path}/edit`).set('Cookie', cookie('alice')).set('Origin', origin)
      .send({ ...revision(1), instruction: 'Remember work' }).expect(503);
    expect(writer.body.error.code).toBe('MEMORY_WRITER_UNAVAILABLE');
    expect(JSON.stringify(writer.body)).not.toContain('raw provider fixture message');
  } finally {
    await app.close();
  }
});
