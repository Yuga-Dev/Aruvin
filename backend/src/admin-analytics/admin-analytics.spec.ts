/**
 * ============================================================================
 * FILE: admin-analytics.spec.ts
 * LOCATION: backend/src/admin-analytics/admin-analytics.spec.ts
 * PURPOSE: Exercise GET /api/admin/analytics over real Nest and private HTTP admission.
 * ROLE IN PROJECT: Proves super-admin-only access, query validation and the reporting happy path offline.
 * KEY COMPONENTS: Fixture accounting store, role matrix, strict query and paging checks.
 * ============================================================================
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { BSON, type Db, type Document } from 'mongodb';
import request from 'supertest';
import { expect, it } from 'vitest';
import { AuthFault } from '../auth/errors.js';
import { DEFAULT_BUDGETS } from '../contracts/budgets.js';
import { configurePrivateHttp } from '../http/configure-private-http.js';
import { MongoMetadata } from '../persistence/metadata.js';
import { RecordStore } from '../persistence/store.js';
import { RequestIdentityStore } from '../platform/identity/request-identity-store.js';
import { principal } from '../../test/assembly/auth-principal-fixture.js';
import { evaluate } from '../../test/persistence/accounting-reporting-fixture.js';
import { accounting } from '../../test/persistence/fixtures.js';
import { AdminAnalyticsModule } from './admin-analytics.module.js';

const origin = 'http://127.0.0.1:5173';
const path = '/api/admin/analytics';
const start = '2026-10-06T00:00:00.000Z';
const end = '2026-10-07T00:00:00.000Z';
const q = (extra = '') => `?start=${start}&end=${end}${extra}`;

async function fixture(pageSize = 50) {
  const rows: Document[] = [{ ...accounting(), _id: 'a', cost: 0.1, startedAt: start },
    { ...accounting(), _id: 'b', userId: 'u2', sessionId: 's2', cost: 0.2, outcome: 'failed', startedAt: start }];
  const db = { collection: () => ({ aggregate: (pipeline: Document[]) => ({
    toArray: async () => evaluate(rows.map(r => BSON.deserialize(BSON.serialize(r))), pipeline) }) }) } as unknown as Db;
  const metadata = new MongoMetadata(new RecordStore(db, 1000), DEFAULT_BUDGETS);
  const identities = new RequestIdentityStore();
  const mod = await Test.createTestingModule({ imports: [AdminAnalyticsModule.registerAsync({ useFactory: () => ({
    report: query => metadata.accountingTotals(query), principal: () => identities.principal(), pageSize }) })] }).compile();
  const app = mod.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  app.setGlobalPrefix('api');
  configurePrivateHttp(app, { identities, frontendOrigin: origin, secureCookie: false, auth: {
    authenticate: async c => {
      if (!c) throw new AuthFault('UNAUTHENTICATED');
      return { principal: principal(c, c === 'root' ? 'super-admin' : 'user', c === 'pending') };
    } } });
  app.use((req: Request, _res: ExpressResponse, next: NextFunction) => { identities.restore(req); next(); });
  await app.init();
  return { app, http: request(app.getHttpServer()) };
}
const cookie = (name: string) => `aurvin_wos_session=${name}`;

it('requires authentication and the super-admin role', async () => {
  const { app, http } = await fixture();
  try {
    expect((await http.get(path + q()).expect(401)).body.error.code).toBe('UNAUTHENTICATED');
    const user = await http.get(path + q()).set('Cookie', cookie('alice')).expect(403);
    expect(user.body.error.code).toBe('FORBIDDEN');
    expect(user.body.items).toBeUndefined();
    await http.get(path + q()).set('Cookie', cookie('pending')).expect(403);
  } finally { await app.close(); }
});

it('returns bounded UTC totals per unit for a super admin, uncached', async () => {
  const { app, http } = await fixture();
  try {
    const res = await http.get(path + q()).set('Cookie', cookie('root')).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ userId: null, unit: 'text-tokens', currency: 'USD', reportedTotal: '0.3',
      requestCount: 2, failedCount: 1, spendComplete: expect.any(Boolean) });
    const byUser = await http.get(path + q('&byUser=true')).set('Cookie', cookie('root')).expect(200);
    expect(byUser.body.items.map((i: { userId: string }) => i.userId).sort()).toEqual(['u1', 'u2']);
  } finally { await app.close(); }
});

it('pages per-user rows with an opaque cursor bound to the range', async () => {
  const { app, http } = await fixture(1);
  try {
    const first = await http.get(path + q('&byUser=true')).set('Cookie', cookie('root')).expect(200);
    expect(first.body.items).toHaveLength(1);
    expect(typeof first.body.nextCursor).toBe('string');
    const second = await http.get(path + q(`&byUser=true&cursor=${first.body.nextCursor}`)).set('Cookie', cookie('root')).expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].userId).not.toBe(first.body.items[0].userId);
    await http.get(path + `?start=${start}&end=2026-10-08T00:00:00.000Z&byUser=true&cursor=${first.body.nextCursor}`)
      .set('Cookie', cookie('root')).expect(400);
  } finally { await app.close(); }
});

it('rejects malformed, oversized, unknown and client-supplied limit/user queries', async () => {
  const { app, http } = await fixture();
  try {
    const bad = ['', '?start=nope&end=nope', `?start=${end}&end=${start}`, `?start=${start}&end=2026-11-20T00:00:00.000Z`,
      `?start=2026-10-06T00:00:00Z&end=${end}`, q('&limit=500'), q('&userId=u1'), q('&byUser=yes'), q('&extra=1'),
      q('&cursor=garbage&byUser=true'), q('&start=x')];
    for (const query of bad) {
      const res = await http.get(path + query).set('Cookie', cookie('root')).expect(400);
      expect(res.body).toEqual({ error: { code: 'INVALID_REQUEST', retryable: false } });
    }
  } finally { await app.close(); }
});
