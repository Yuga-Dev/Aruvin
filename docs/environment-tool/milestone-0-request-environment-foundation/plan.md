# Milestone 0: Request Environment Foundation & Browser Timezone Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture zero-permission browser IANA timezones (`X-Aurvin-Time-Zone`) and fail-closed trusted proxy geolocation headers (`CF-IP*` / `x-vercel-ip-*`) into a request-scoped store, propagate `clientTimeZone` across text and live-voice turns, and fix the hardcoded `'Etc/UTC'` fallback in `MemoryTextRuntime`.

**Architecture:** The frontend reads `Intl.DateTimeFormat().resolvedOptions().timeZone` without permissions and sends it on turn submission, retry, and voice session creation via the `X-Aurvin-Time-Zone` header without altering strict JSON request bodies or `sessionStorage` recovery records. On the backend, `RequestEnvironmentStore` (an `AsyncLocalStorage` + `WeakMap` twin of `RequestIdentityStore`) extracts normalized timezones and loopback/TLS-gated edge geo hints at HTTP admission, passes `clientTimeZone` through HTTP/voice into `DurableChatRuntime` and `MemoryTextRuntime` (`clientTimeZone -> calendar.trustedTimeZone -> Etc/UTC`), and keeps idempotency payload hashes untouched.

**Tech Stack:** TypeScript (ESM NodeNext with `.js` specifiers on backend, `.ts` on frontend), NestJS 12, Express 5, Node `AsyncLocalStorage`, Vitest 4, Oxlint.

> **Status (2026-11-19):** Tasks 1–5 are implemented and committed (`3c6f28e`). Task 6's `admin-http.spec.ts` `503` blocker is fixed in `670110f`: the fixture booted a cold account authority, so it now performs the same `/auth/me`-equivalent warm used by `voice-bootstrap.e2e-spec.ts`. Backend `npm run build` and `npm run lint` pass, the three environment specs pass (15 tests), and frontend `npm run build`, `npm run lint`, and `npm test` pass (111 files / 953 tests). The full backend suite still reports 61 failures across 16 files (performance baselines, native-Mongo prerequisites, and pre-existing assembly fixtures); all 16 files fail identically at parent commit `078dc20`, so they are not Milestone 0 regressions.

---

## File Structure

| Action | File | Responsibility |
| --- | --- | --- |
| Create | `backend/src/platform/environment/request-environment.ts` | Normalize `X-Aurvin-Time-Zone`, gate proxy geo behind `trustedGeoProxyIngress`, sanitize Cloudflare/Vercel city/region/country headers without storing raw IPs. |
| Create | `backend/src/platform/environment/request-environment-store.ts` | `AsyncLocalStorage` + `WeakMap` request store with `run`, `attach`, `restore`, `current`, `timeZone`, and `geo`. |
| Create | `backend/src/platform/environment/index.ts` | Barrel export for request environment types, extractors, and store. |
| Create | `backend/src/platform/environment/request-environment.spec.ts` | Unit tests for timezone normalization, proxy spoofing rejection, percent-decoding, placeholders, and ALS concurrency isolation. |
| Modify | `backend/src/platform/index.ts` | Re-export request environment primitives from `@platform`. |
| Modify | `backend/src/platform/platform.module.ts` | Register and export `RequestEnvironmentStore`. |
| Modify | `backend/src/http/configure-private-http.ts` | Extract `RequestEnvironment` on private requests and wrap downstream middleware in `environments.run(...)`. |
| Modify | `backend/src/app.module.ts` | Inject `RequestEnvironmentStore` into `AssemblyModule`'s `AppService` factory. |
| Modify | `backend/src/app.service.ts` | Expose `environments: RequestEnvironmentStore` and pass it into `httpOptions()`. |
| Modify | `backend/src/main.ts` | Allow `X-Aurvin-Time-Zone` in CORS `allowedHeaders`, wire `environments` + `trustedGeoProxyIngress` into `configurePrivateHttp`, and call `service.environments.restore(req)`. |
| Modify | `backend/src/http/options.ts` | Add optional `environment` port on `ChatHttpOptions`. |
| Modify | `backend/src/http/chat-http.service.ts` | Forward `this.o.environment?.timeZone()` into `submitTurn` and `retryTurn`. |
| Modify | `backend/src/voice/session/voice-session.options.ts` | Add optional `clientTimeZone` and `requestGeo` snapshots on `SessionContext`. |
| Modify | `backend/src/voice/session/voice-session.controller.ts` | Inject optional `RequestEnvironmentStore`, capture request environment on `POST /voice/sessions`, pass to `sessions.create()`. |
| Modify | `backend/src/voice/session/voice-session.service.ts` | Accept optional `RequestEnvironment` in `create()` / `createOnce()` and store normalized `clientTimeZone` and `requestGeo` on `SessionContext`. |
| Modify | `backend/src/voice/agent/agent-voice-adapter.ts` | Forward `c.clientTimeZone` on `runtime.submitLiveTurn()`. |
| Create | `backend/test/http/request-environment-http.spec.ts` | Integration tests for chat HTTP submit/retry, CORS preflight, and voice session capture/forwarding. |
| Modify | `backend/src/contracts/runtime.ts` | Add optional `clientTimeZone?: string \| null` to `SubmitTurnCommand` and `RetryTurnCommand`. |
| Modify | `backend/src/chat-runtime/ports.ts` | Add optional `clientTimeZone?: string \| null` to `SubmitLiveTurn`. |
| Modify | `backend/src/chat-runtime/admission-receipt.ts` | Add optional `clientTimeZone?: string \| null` to `AdmissionReceipt`. |
| Modify | `backend/src/chat-runtime/durable-chat-runtime.ts` | Track `attemptTimeZone`, preserve idempotency hashes, thread `clientTimeZone` across boundary/receipt/confirmedState paths, and resolve `clientTimeZone -> trustedTimeZone -> Etc/UTC`. |
| Modify | `backend/src/chat-runtime/memory-text.ts` | Store `clientTimeZone` on `Entry`, preserve/update on retry, and replace hardcoded `'Etc/UTC'` with `e.clientTimeZone ?? this.d.calendar?.trustedTimeZone ?? 'Etc/UTC'`. |
| Create | `backend/test/runtime/request-environment-runtime.spec.ts` | Regression tests for `MemoryText` and `DurableChatRuntime` timezone precedence, retry, live voice, receipt reuse, and hash stability. |
| Create | `frontend/src/api/client-timezone.ts` | Zero-permission `detectBrowserTimeZone()` and non-clobbering `withClientTimeZoneHeader()`. |
| Create | `frontend/src/api/client-timezone.test.ts` | Unit tests for `detectBrowserTimeZone()` and `withClientTimeZoneHeader()`. |
| Modify | `frontend/src/api/client.ts` | Attach `X-Aurvin-Time-Zone` on `ApiClient.submitTurn` and `ApiClient.retryTurn`. |
| Modify | `frontend/src/api/client.test.ts` | Update `headers` expectations on `submitTurn` and test `submitTurn`/`retryTurn` header attachment. |
| Modify | `frontend/src/api/voice-client.ts` | Attach `X-Aurvin-Time-Zone` on JSON body requests (`POST /voice/sessions`) in `VoiceHttpClient`. |
| Modify | `frontend/src/features/voice/transport/voice-client.test.ts` | Test `X-Aurvin-Time-Zone` attachment on `VoiceHttpClient.create` and omission when unavailable or on `end()`. |

---

### Task 1: Backend `RequestEnvironment` Extractor & `RequestEnvironmentStore`

**Files:**
- Create: `backend/src/platform/environment/request-environment.ts`
- Create: `backend/src/platform/environment/request-environment-store.ts`
- Create: `backend/src/platform/environment/index.ts`
- Modify: `backend/src/platform/index.ts:28-44`
- Modify: `backend/src/platform/platform.module.ts:20-44`
- Test: `backend/src/platform/environment/request-environment.spec.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `backend/src/platform/environment/request-environment.spec.ts`:

```typescript
/**
 * ============================================================================
 * FILE: request-environment.spec.ts
 * LOCATION: backend/src/platform/environment/request-environment.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify time zone normalization, trusted proxy geo gating, and ALS isolation.
 *
 * ROLE IN PROJECT:
 *    Tests fail-closed proxy trust, URL decoding, placeholder/control-char
 *    rejection, absence of raw IP retention, and concurrent ALS isolation.
 *
 * KEY COMPONENTS:
 *    - normalizeTimeZone: Valid, invalid, overlong, control-char, multi-value cases.
 *    - extractTrustedGeo / trustedGeoProxyIngress: Cloudflare, Vercel, spoofing.
 *    - RequestEnvironmentStore: AsyncLocalStorage and WeakMap attach/restore isolation.
 * ============================================================================
 */

import { setImmediate } from 'node:timers/promises';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_TIME_ZONE_HEADER,
  RequestEnvironmentStore,
  extractRequestEnvironment,
  extractTrustedGeo,
  normalizeTimeZone,
  trustedGeoProxyIngress,
} from './index.js';

function fakeRequest(input: {
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
} = {}): Request {
  return {
    headers: input.headers ?? {},
    socket: { remoteAddress: input.remoteAddress },
  } as unknown as Request;
}

describe('request-environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('normalizes valid IANA time zones and trims surrounding whitespace', () => {
    expect(normalizeTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(normalizeTimeZone('America/New_York')).toBe('America/New_York');
    expect(normalizeTimeZone('  Asia/Kolkata  ')).toBe('Asia/Kolkata');
    expect(normalizeTimeZone(['Asia/Kolkata'])).toBe('Asia/Kolkata');
  });

  it('returns null without throwing for invalid, empty, overlong, control-char, or multi-value zones', () => {
    expect(normalizeTimeZone('')).toBeNull();
    expect(normalizeTimeZone('   ')).toBeNull();
    expect(normalizeTimeZone([])).toBeNull();
    expect(normalizeTimeZone(['Asia/Kolkata', 'America/New_York'])).toBeNull();
    expect(normalizeTimeZone('Invalid/Zone')).toBeNull();
    expect(normalizeTimeZone('America/' + 'a'.repeat(95))).toBeNull();
    expect(normalizeTimeZone('Asia/Kolkata\u0000')).toBeNull();
    expect(normalizeTimeZone('Asia/\nKolkata')).toBeNull();
    expect(normalizeTimeZone('Asia/Kolkata\u007f')).toBeNull();
    expect(normalizeTimeZone('\tUTC')).toBeNull();
    expect(normalizeTimeZone(42)).toBeNull();
    expect(normalizeTimeZone(null)).toBeNull();
    expect(normalizeTimeZone(undefined)).toBeNull();
  });

  it('rejects spoofed geo headers from untrusted peers or unencrypted loopback ingress', () => {
    const spoofedRemote = fakeRequest({
      remoteAddress: '198.51.100.25',
      headers: {
        'x-forwarded-proto': 'https',
        'cf-ipcity': 'Chennai',
        'cf-region': 'Tamil%20Nadu',
        'cf-ipcountry': 'IN',
        'x-vercel-ip-city': 'Bengaluru',
      },
    });
    expect(trustedGeoProxyIngress(spoofedRemote)).toBe(false);
    expect(extractTrustedGeo(spoofedRemote)).toBeNull();

    const unencryptedLoopback = fakeRequest({
      remoteAddress: '127.0.0.1',
      headers: {
        'cf-ipcity': 'Chennai',
        'x-vercel-ip-city': 'Bengaluru',
      },
    });
    expect(trustedGeoProxyIngress(unencryptedLoopback)).toBe(false);
    expect(extractTrustedGeo(unencryptedLoopback)).toBeNull();
  });

  it('extracts URL-decoded Cloudflare and Vercel geo from trusted proxies without raw IPs', () => {
    const cfReq = fakeRequest({
      remoteAddress: '::ffff:127.0.0.1',
      headers: {
        'x-forwarded-proto': 'https',
        'cf-connecting-ip': '203.0.113.9',
        'x-forwarded-for': '203.0.113.9',
        'cf-region': 'Tamil%20Nadu',
        'cf-ipcity': 'Chennai',
        'cf-ipcountry': 'IN',
        'x-vercel-ip-city': 'Mumbai',
      },
    });
    const cfGeo = extractTrustedGeo(cfReq);
    expect(cfGeo).toEqual({
      city: 'Chennai',
      region: 'Tamil Nadu',
      country: 'IN',
      source: 'cloudflare',
    });
    expect(JSON.stringify(cfGeo)).not.toContain('203.0.113.9');
    expect(JSON.stringify(cfGeo)).not.toContain('127.0.0.1');

    vi.stubEnv('AURVIN_TRUSTED_PROXY_GEO', 'true');
    const vercelReq = fakeRequest({
      remoteAddress: '::1',
      headers: {
        'x-real-ip': '203.0.113.10',
        'x-vercel-ip-city': 'San%20Francisco',
        'x-vercel-ip-country-region': 'CA',
        'x-vercel-ip-country': 'US',
      },
    });
    const vercelGeo = extractTrustedGeo(vercelReq);
    expect(vercelGeo).toEqual({
      city: 'San Francisco',
      region: 'CA',
      country: 'US',
      source: 'vercel',
    });
    expect(JSON.stringify(vercelGeo)).not.toContain('203.0.113.10');
  });

  it('ignores XX/T1/Unknown placeholders, handles malformed percent encoding, and rejects encoded control chars', () => {
    const placeholders = fakeRequest({
      remoteAddress: '127.0.0.1',
      headers: {
        'x-forwarded-proto': 'https',
        'cf-ipcity': 'Unknown',
        'cf-region': 'T1',
        'cf-ipcountry': 'XX',
        'x-vercel-ip-country': 'unknown',
      },
    });
    expect(extractTrustedGeo(placeholders)).toBeNull();

    const partial = fakeRequest({
      remoteAddress: '127.0.0.1',
      headers: {
        'x-forwarded-proto': 'https',
        'cf-ipcity': '100%RawCity',
        'cf-region': 'Bad%0ARegion',
        'cf-ipcountry': 'T1',
      },
    });
    expect(extractTrustedGeo(partial)).toEqual({
      city: '100%RawCity',
      source: 'cloudflare',
    });

    const env = extractRequestEnvironment(
      fakeRequest({
        remoteAddress: '127.0.0.1',
        headers: {
          [CLIENT_TIME_ZONE_HEADER]: '  Asia/Kolkata  ',
          'x-forwarded-proto': 'https',
          'cf-ipcity': 'Chennai',
          'cf-ipcountry': 'IN',
        },
      }),
    );
    expect(Object.isFrozen(env)).toBe(true);
    expect(env).toEqual({
      timeZone: 'Asia/Kolkata',
      geo: { city: 'Chennai', country: 'IN', source: 'cloudflare' },
    });
  });

  it('isolates overlapping RequestEnvironmentStore ALS runs and supports attach/restore', async () => {
    const store = new RequestEnvironmentStore();
    expect(store.current()).toBeNull();
    expect(store.timeZone()).toBeNull();
    expect(store.geo()).toBeNull();

    const results = await Promise.all([
      store.run({ timeZone: 'Asia/Kolkata', geo: { city: 'Chennai', source: 'cloudflare' } }, async () => {
        await setImmediate();
        return { tz: store.timeZone(), geo: store.geo() };
      }),
      store.run({ timeZone: 'America/New_York', geo: null }, async () => {
        await setImmediate();
        return { tz: store.timeZone(), geo: store.geo() };
      }),
    ]);

    expect(results).toEqual([
      { tz: 'Asia/Kolkata', geo: { city: 'Chennai', source: 'cloudflare' } },
      { tz: 'America/New_York', geo: null },
    ]);
    expect(store.current()).toBeNull();

    const req = {};
    const bound = Object.freeze({ timeZone: 'Europe/London', geo: null });
    await store.run(bound, async () => {
      store.attach(req, bound);
    });
    const restored = await store.run({ timeZone: 'UTC', geo: null }, async () => {
      store.restore(req);
      return store.timeZone();
    });
    expect(restored).toBe('Europe/London');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx vitest run src/platform/environment/request-environment.spec.ts`
Expected: FAIL (`Cannot find module './index.js'`).

- [ ] **Step 3: Implement `request-environment.ts`, `request-environment-store.ts`, barrel, and module exports**

Create `backend/src/platform/environment/request-environment.ts`:

```typescript
/**
 * ============================================================================
 * FILE: request-environment.ts
 * LOCATION: backend/src/platform/environment/request-environment.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate client time zone hints and trusted proxy geolocation headers.
 *
 * ROLE IN PROJECT:
 *    Extracts sanitized, fail-closed request environment metadata at HTTP
 *    admission without trusting unverified proxy headers or retaining raw IPs.
 *
 * KEY COMPONENTS:
 *    - normalizeTimeZone: Validates trimmed IANA time zones safely.
 *    - trustedGeoProxyIngress / extractTrustedGeo: Loopback TLS/opt-in proxy gate.
 *    - extractRequestEnvironment: Combines normalized time zone and geo hints.
 * ============================================================================
 */

import type { Request } from 'express';

export const CLIENT_TIME_ZONE_HEADER = 'x-aurvin-time-zone';

export type RequestGeoSource = 'cloudflare' | 'vercel';

export type RequestGeoHint = Readonly<{
  city?: string;
  region?: string;
  country?: string;
  source: RequestGeoSource;
}>;

export type RequestEnvironment = Readonly<{
  timeZone: string | null;
  geo: RequestGeoHint | null;
}>;

export type TrustedProxyPredicate = (req: Request) => boolean;

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const GEO_PLACEHOLDERS = new Set(['xx', 't1', 'unknown']);
const COUNTRY_CODE_RE = /^[A-Z]{2,3}(?:-[A-Z0-9]{1,12})?$/;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function singleHeaderValue(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === 'string') return raw[0];
  return null;
}

export function normalizeTimeZone(raw: unknown): string | null {
  const candidate = singleHeaderValue(raw);
  if (candidate === null || hasControlChars(candidate)) return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return null;
  }
}

export function trustedGeoProxyIngress(req: Request): boolean {
  const peer = req.socket?.remoteAddress;
  if (!peer || !LOOPBACK_PEERS.has(peer)) return false;
  return req.headers['x-forwarded-proto'] === 'https'
    || process.env.AURVIN_TRUSTED_PROXY_GEO === 'true';
}

function sanitizeGeoField(raw: unknown, maxLen: number): string | undefined {
  const value = singleHeaderValue(raw);
  if (value === null || value.length > 4096) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }
  if (hasControlChars(decoded)) return undefined;
  const trimmed = decoded.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return undefined;
  if (GEO_PLACEHOLDERS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

function sanitizeCountryField(raw: unknown): string | undefined {
  const value = sanitizeGeoField(raw, 16);
  if (!value) return undefined;
  const upper = value.toUpperCase();
  if (GEO_PLACEHOLDERS.has(upper.toLowerCase())) return undefined;
  return COUNTRY_CODE_RE.test(upper) ? upper : undefined;
}

function buildGeoHint(
  headers: Request['headers'],
  keys: { city: string; region: string; country: string },
  source: RequestGeoSource,
): RequestGeoHint | null {
  const city = sanitizeGeoField(headers[keys.city], 100);
  const region = sanitizeGeoField(headers[keys.region], 100);
  const country = sanitizeCountryField(headers[keys.country]);
  if (!city && !region && !country) return null;
  return Object.freeze({
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(country ? { country } : {}),
    source,
  });
}

export function extractTrustedGeo(
  req: Request,
  trustedProxy: TrustedProxyPredicate = trustedGeoProxyIngress,
): RequestGeoHint | null {
  if (!trustedProxy(req)) return null;
  const headers = req.headers ?? {};
  return buildGeoHint(
    headers,
    { city: 'cf-ipcity', region: 'cf-region', country: 'cf-ipcountry' },
    'cloudflare',
  ) ?? buildGeoHint(
    headers,
    { city: 'x-vercel-ip-city', region: 'x-vercel-ip-country-region', country: 'x-vercel-ip-country' },
    'vercel',
  );
}

export function extractRequestEnvironment(
  req: Request,
  trustedProxy: TrustedProxyPredicate = trustedGeoProxyIngress,
): RequestEnvironment {
  const headers = req.headers ?? {};
  return Object.freeze({
    timeZone: normalizeTimeZone(headers[CLIENT_TIME_ZONE_HEADER]),
    geo: extractTrustedGeo(req, trustedProxy),
  });
}
```

Create `backend/src/platform/environment/request-environment-store.ts`:

```typescript
/**
 * ============================================================================
 * FILE: request-environment-store.ts
 * LOCATION: backend/src/platform/environment/request-environment-store.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Hold request-scoped time zone and trusted geo hints in AsyncLocalStorage.
 *
 * ROLE IN PROJECT:
 *    Supplies sanitized environment context from HTTP admission through
 *    middleware transitions to chat and voice services without leaking across requests.
 *
 * KEY COMPONENTS:
 *    - RequestEnvironmentStore: ALS + WeakMap store mirroring RequestIdentityStore.
 * ============================================================================
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { RequestEnvironment, RequestGeoHint } from './request-environment.js';

@Injectable()
export class RequestEnvironmentStore {
  private readonly context = new AsyncLocalStorage<RequestEnvironment>();
  private readonly bound = new WeakMap<object, RequestEnvironment>();

  run<T>(env: RequestEnvironment, next: () => T): T {
    return this.context.run(env, next);
  }

  attach(req: object, env: RequestEnvironment): void {
    this.bound.set(req, env);
    this.context.enterWith(env);
  }

  restore(req: object): void {
    const env = this.bound.get(req);
    if (env) this.context.enterWith(env);
  }

  current(): RequestEnvironment | null {
    return this.context.getStore() ?? null;
  }

  timeZone(): string | null {
    return this.current()?.timeZone ?? null;
  }

  geo(): RequestGeoHint | null {
    return this.current()?.geo ?? null;
  }
}
```

Create `backend/src/platform/environment/index.ts`:

```typescript
/**
 * ============================================================================
 * FILE: index.ts
 * LOCATION: backend/src/platform/environment/index.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Re-export request environment extraction and store primitives.
 *
 * ROLE IN PROJECT:
 *    Provides a single barrel for request environment types, extractors, and
 *    the Nest-injectable RequestEnvironmentStore.
 *
 * KEY COMPONENTS:
 *    - RequestEnvironmentStore: AsyncLocalStorage-backed environment store.
 *    - extractRequestEnvironment / normalizeTimeZone / extractTrustedGeo: Extractors.
 * ============================================================================
 */

export {
  CLIENT_TIME_ZONE_HEADER,
  extractRequestEnvironment,
  extractTrustedGeo,
  normalizeTimeZone,
  trustedGeoProxyIngress,
  type RequestEnvironment,
  type RequestGeoHint,
  type RequestGeoSource,
  type TrustedProxyPredicate,
} from './request-environment.js';
export { RequestEnvironmentStore } from './request-environment-store.js';
```

Export from `backend/src/platform/index.ts` and register/export `RequestEnvironmentStore` in `backend/src/platform/platform.module.ts`:

```typescript
// backend/src/platform/index.ts
export {
  CLIENT_TIME_ZONE_HEADER,
  extractRequestEnvironment,
  extractTrustedGeo,
  normalizeTimeZone,
  trustedGeoProxyIngress,
  RequestEnvironmentStore,
  type RequestEnvironment,
  type RequestGeoHint,
  type RequestGeoSource,
  type TrustedProxyPredicate,
} from './environment/index.js';
```

```typescript
// backend/src/platform/platform.module.ts
import { RequestEnvironmentStore } from './environment/request-environment-store.js';
// add RequestEnvironmentStore to providers & exports
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/platform/environment/request-environment.spec.ts`
Expected: PASS (`6 tests passed`).

---

### Task 2: Backend HTTP Admission, CORS & `AppService` Wiring

**Files:**
- Modify: `backend/src/http/configure-private-http.ts:23-84`
- Modify: `backend/src/app.module.ts:26-57`
- Modify: `backend/src/app.service.ts:88-92,144-150,252-256,335-340,1085-1099`
- Modify: `backend/src/main.ts:41-130`
- Modify: `backend/src/http/options.ts:20-38`
- Modify: `backend/src/http/chat-http.service.ts:135-196`

- [ ] **Step 1: Wire `RequestEnvironmentStore` through `configurePrivateHttp` and `AppService`**

In `backend/src/http/configure-private-http.ts`:

```typescript
import {
  extractRequestEnvironment,
  type TrustedProxyPredicate,
} from '../platform/environment/request-environment.js';
import type { RequestEnvironmentStore } from '../platform/environment/request-environment-store.js';

export type PrivateHttpOptions = { auth: Pick<AuthService, 'authenticate'>;
  identities: RequestIdentityStore; environments?: RequestEnvironmentStore;
  trustedGeoProxy?: TrustedProxyPredicate; frontendOrigin: string; secureCookie: boolean;
  prepareOwner?: (principal: AuthPrincipal) => Promise<void> };
```

Inside `configurePrivateHttp`, after `o.identities.attach(req, p);`:

```typescript
      o.identities.attach(req, p);
      if (o.environments) {
        const env = extractRequestEnvironment(req, o.trustedGeoProxy);
        o.environments.attach(req, env);
        o.environments.run(env, () => o.identities.run(p, () => next()));
      } else {
        o.identities.run(p, () => next());
      }
```

In `backend/src/app.module.ts` (`AssemblyModule`):

```typescript
import { RequestEnvironmentStore } from './platform/environment/request-environment-store.js';

@Module({
  imports: [PlatformModule],
  providers: [{
    provide: AppService,
    inject: [AURVIN_CONFIG, RequestIdentityStore, ServerIdentityResolver, RequestEnvironmentStore],
    useFactory: (
      config: BootstrapConfig,
      identities: RequestIdentityStore,
      identity: ServerIdentityResolver,
      environments: RequestEnvironmentStore,
    ) => AppService.create(config, { identities, identity, environments }),
  }],
  exports: [AppService, PlatformModule],
})
class AssemblyModule {}
```

In `backend/src/app.service.ts`:
- Add `environments?: RequestEnvironmentStore;` to `AssemblyPorts`
- Add `readonly environments: RequestEnvironmentStore;` initialized via `this.environments = overrides.environments ?? new RequestEnvironmentStore();`
- Include `environment: this.environments,` in `httpOptions(identity)`

- [ ] **Step 2: Wire CORS `allowedHeaders`, private HTTP admission, and ALS restore in `backend/src/main.ts`**

```typescript
import { trustedGeoProxyIngress } from './platform/environment/request-environment.js';

  app.enableCors({ origin: service.config.frontendOrigin, credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: calendarCors
      ? ['Content-Type', 'X-Aurvin-Calendar-CSRF', 'X-Aurvin-Time-Zone']
      : ['Content-Type', 'X-Aurvin-Time-Zone'],
    exposedHeaders: ['X-Request-ID', 'Retry-After'], preflightContinue: true });
```

```typescript
  configurePrivateHttp(app, {
    auth: service.auth, identities: service.identities,
    environments: service.environments,
    trustedGeoProxy: trustedGeoProxyIngress,
    frontendOrigin: service.config.frontendOrigin,
    secureCookie: frontend.protocol === 'https:',
    prepareOwner: principal => service.prepareOwner(principal),
  });
```

```typescript
  app.use((req: Request, _res: Response, next: NextFunction) => {
    service.identities.restore(req);
    service.environments.restore(req);
    next();
  });
```

- [ ] **Step 3: Forward `clientTimeZone` in `ChatHttpOptions` and `ChatHttpService`**

In `backend/src/http/options.ts`:

```typescript
import type { RequestEnvironmentStore } from '../platform/environment/request-environment-store.js';

export type ChatHttpOptions = {
  runtime: ChatRuntime;
  sessions: SessionRepository;
  messages: MessageRepository;
  identity: Pick<ServerIdentityResolver, 'resolve' | 'assertNoClientOverrides'>;
  principal: () => AuthPrincipal;
  environment?: Pick<RequestEnvironmentStore, 'current' | 'timeZone' | 'geo'>;
  budgets: BudgetConfig;
  executionReservations?: { assertText(userId: string, sessionId: string): void };
  currentConfig?: CurrentConfigPort;
  /** Off-turn control-plane web preparation for selected history only. */
  prepareWeb?: (userId: string) => Promise<void>;
};
```

In `backend/src/http/chat-http.service.ts` (`submit` and `retry`):

```typescript
    const clientTimeZone = this.o.environment?.timeZone() ?? null;
    return submitTurnResponseSchema.parse(await this.o.runtime.submitTurn({
      ...body,
      identity,
      ...(clientTimeZone ? { clientTimeZone } : {}),
    }));
```

```typescript
    const clientTimeZone = this.o.environment?.timeZone() ?? null;
    return submitTurnResponseSchema.parse(await this.o.runtime.retryTurn({
      ...body,
      identity,
      sessionId: pathId(sessionId),
      turnId: pathId(turnId),
      ...(clientTimeZone ? { clientTimeZone } : {}),
    }));
```

---

### Task 3: Backend Voice Session Capture & Live Turn Forwarding

**Files:**
- Modify: `backend/src/voice/session/voice-session.options.ts:23-70`
- Modify: `backend/src/voice/session/voice-session.controller.ts:17-75`
- Modify: `backend/src/voice/session/voice-session.service.ts:29-35,151-260`
- Modify: `backend/src/voice/agent/agent-voice-adapter.ts:440-455`
- Test: `backend/test/http/request-environment-http.spec.ts`

- [ ] **Step 1: Add `clientTimeZone` and `requestGeo` snapshots to `SessionContext` and `VoiceSessionService.create`**

In `backend/src/voice/session/voice-session.options.ts`:

```typescript
import type { RequestGeoHint } from '../../platform/environment/request-environment.js';

export type SessionContext = {
  // ...existing fields...
  /** Sanitized client time zone snapshot captured at voice session creation. */
  clientTimeZone?: string | null;
  /** Sanitized trusted proxy geo snapshot captured at voice session creation. */
  requestGeo?: RequestGeoHint | null;
  assertPaidWork?(): void;
};
```

In `backend/src/voice/session/voice-session.controller.ts`:

```typescript
import { Body, Controller, Delete, Get, HttpCode, Inject, Optional, Param, Post, Query,
  Req, Res, Catch, UseFilters, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { RequestEnvironmentStore } from '../../platform/environment/request-environment-store.js';
import { extractRequestEnvironment } from '../../platform/environment/request-environment.js';

  constructor(
    @Inject(VoiceSessionService) private readonly sessions: VoiceSessionService,
    @Inject(RequestIdentityStore) private readonly identities: RequestIdentityStore,
    @Optional() @Inject(RequestEnvironmentStore) private readonly environments?: RequestEnvironmentStore,
  ) {}

  @Post('sessions')
  @HttpCode(201)
  async create(@Body() body: unknown, @Query() q: unknown, @Req() req: Request,
    @Res({ passthrough: true }) res: Response) {
    noQuery(q);
    const reqEnv = this.environments?.current() ?? extractRequestEnvironment(req, () => false);
    const result = await this.sessions.create(body, req.headers.origin, this.identities.principal(), reqEnv);
    res.setHeader('Cache-Control', 'no-store');
    if (result.cookie) res.append('Set-Cookie', result.cookie);
    return result.response;
  }
```

In `backend/src/voice/session/voice-session.service.ts`:

```typescript
import { normalizeTimeZone, type RequestEnvironment } from '../../platform/environment/request-environment.js';

  async create(
    body: unknown,
    origin: string | undefined,
    principal: AuthPrincipal,
    environment?: RequestEnvironment,
  ): Promise<CreateResult> {
    // ...pass environment into this.createOnce(body, principal, environment)
  }

    const context: SessionContext = { identity, response, reservation: null, livekitTicket: null, ...captured,
      ...(body.mode === 'live' ? { principal } : {}),
      ...(environment ? {
        clientTimeZone: normalizeTimeZone(environment.timeZone),
        requestGeo: environment.geo ?? null,
      } : {}) };
```

In `backend/src/voice/agent/agent-voice-adapter.ts` (`finalized`):

```typescript
      ...(input.calendarReplyTo ? { calendarReplyTo: input.calendarReplyTo } : {}),
      ...(c.configSnapshot ? { configSnapshot: c.configSnapshot } : {}),
      ...(c.clientTimeZone ? { clientTimeZone: c.clientTimeZone } : {}) });
```

- [ ] **Step 2: Create `backend/test/http/request-environment-http.spec.ts` and run it**

Verify:
1. `POST /api/sessions`, `POST /api/sessions/:id/turns`, and `POST /api/sessions/:id/turns/:turnId/retry` forward `X-Aurvin-Time-Zone` without weakening strict JSON body schema rejection (`UNKNOWN_FIELD`).
2. `OPTIONS` preflight includes `X-Aurvin-Time-Zone` in `Access-Control-Allow-Headers` for both non-calendar and calendar setups.
3. `VoiceSessionController.create` captures `clientTimeZone` + trusted `requestGeo` (and fails closed when `cf-ipcity` comes from untrusted ingress or when `RequestEnvironmentStore` is omitted) and `AgentVoiceAdapter.finalized` forwards `clientTimeZone` to `submitLiveTurn`.

Run: `cd backend && npx vitest run test/http/request-environment-http.spec.ts`
Expected: PASS (`4 tests passed`).

---

### Task 4: Runtime `clientTimeZone` Propagation & `MemoryText` `'Etc/UTC'` Fix

**Files:**
- Modify: `backend/src/contracts/runtime.ts:57-85`
- Modify: `backend/src/chat-runtime/ports.ts:69-77`
- Modify: `backend/src/chat-runtime/admission-receipt.ts:50-60`
- Modify: `backend/src/chat-runtime/durable-chat-runtime.ts:48-55,140-150,294-305,334-415,422-480,499-645,678-830,875-1230,1338-1655,1815-2890`
- Modify: `backend/src/chat-runtime/memory-text.ts:122-135,455-470,615-655,1838-1848`
- Test: `backend/test/runtime/request-environment-runtime.spec.ts`

- [ ] **Step 1: Add internal command/receipt fields without altering wire schemas or `hashPayload`**

In `backend/src/contracts/runtime.ts`:

```typescript
export type SubmitTurnCommand = {
  // ...existing fields...
  /** Normalized client time zone hint from request admission; never a wire body field. */
  clientTimeZone?: string | null;
};

export type RetryTurnCommand = {
  // ...existing fields...
  /** Normalized client time zone hint from request admission; never a wire body field. */
  clientTimeZone?: string | null;
};
```

In `backend/src/chat-runtime/ports.ts` (`SubmitLiveTurn`) and `backend/src/chat-runtime/admission-receipt.ts` (`AdmissionReceipt`), add `clientTimeZone?: string | null;`.

- [ ] **Step 2: Thread `clientTimeZone` through `DurableChatRuntime` with cleanup matching `attemptPersonalization`**

In `backend/src/chat-runtime/durable-chat-runtime.ts`:
- Import `normalizeTimeZone` from `../platform/environment/request-environment.js`.
- Add `private readonly attemptTimeZone = new Map<string, string>();`.
- Update `environmentContext(userId: string, clientTimeZone?: string | null): EnvironmentContext`:

```typescript
  private environmentContext(userId: string, clientTimeZone?: string | null): EnvironmentContext {
    return defaultEnvironmentContext(
      new Date(this.now()),
      normalizeTimeZone(clientTimeZone) ?? this.calendarFor(userId)?.trustedTimeZone ?? 'Etc/UTC',
    );
  }
```

- Normalize `clientTimeZone` in `submitTurn`, `submitLiveTurn`, and `retryTurn` onto `command` without changing `hashPayload(...)`.
- Store/read `attemptTimeZone` alongside `attemptPersonalization`, pass `clientTimeZone` through `acceptNewTurn`, `acceptRetry`, `loadHealthyContext`, `checkBoundary`, `reuseAdmittedContext`, and `executeTurn`, and clear `attemptTimeZone` in every cleanup/terminal/drain site where `attemptPersonalization` is deleted/cleared.

- [ ] **Step 3: Fix hardcoded `'Etc/UTC'` in `backend/src/chat-runtime/memory-text.ts`**

- Add `clientTimeZone?: string | null;` to `Entry`.
- Resolve `clientTimeZone` on `submit()` (falling back to `retry.previous.clientTimeZone ?? null` on retry) and update/forward `nextTimeZone` in `retry()`.
- Replace line 1841's hardcoded `'Etc/UTC'`:

```typescript
        environment: defaultEnvironmentContext(
          new Date(this.runtime.now()),
          e.clientTimeZone ?? this.d.calendar?.trustedTimeZone ?? 'Etc/UTC',
        ),
```

- [ ] **Step 4: Run `backend/test/runtime/request-environment-runtime.spec.ts`**

Run: `cd backend && npx vitest run test/runtime/request-environment-runtime.spec.ts`
Expected: PASS (`5 tests passed`).

---

### Task 5: Frontend Browser Timezone Header Plumbing (`X-Aurvin-Time-Zone`)

**Files:**
- Create: `frontend/src/api/client-timezone.ts`
- Create: `frontend/src/api/client-timezone.test.ts`
- Modify: `frontend/src/api/client.ts:21-45,350-420`
- Modify: `frontend/src/api/client.test.ts:17-150,295-375`
- Modify: `frontend/src/api/voice-client.ts:22-55`
- Modify: `frontend/src/features/voice/transport/voice-client.test.ts:24-80`

- [ ] **Step 1: Write `frontend/src/api/client-timezone.ts` and `frontend/src/api/client-timezone.test.ts`**

`frontend/src/api/client-timezone.ts`:

```typescript
/**
 * ============================================================================
 * FILE: client-timezone.ts
 * LOCATION: frontend/src/api/client-timezone.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Detect and attach the browser's IANA time zone header on HTTP requests.
 *
 * ROLE IN PROJECT:
 *    Provides zero-permission browser time zone detection via Intl.DateTimeFormat
 *    and merges X-Aurvin-Time-Zone into fetch headers for chat turns and voice
 *    session creation without modifying JSON wire payloads or recovery storage.
 *
 * KEY COMPONENTS:
 *    - CLIENT_TIME_ZONE_HEADER: Canonical X-Aurvin-Time-Zone request header name.
 *    - detectBrowserTimeZone: Validated, non-throwing browser time zone reader.
 *    - withClientTimeZoneHeader: Header normalization and non-clobbering merge.
 * ============================================================================
 */

export const CLIENT_TIME_ZONE_HEADER = 'X-Aurvin-Time-Zone';

const MAX_TIME_ZONE_LENGTH = 100;

function hasAsciiControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function detectBrowserTimeZone(): string | null {
  try {
    const raw = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof raw !== 'string' || hasAsciiControlChar(raw)) {
      return null;
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_TIME_ZONE_LENGTH) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

export function withClientTimeZoneHeader(headers?: HeadersInit): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      normalized[key] = value;
    }
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) {
        normalized[key] = value;
      }
    }
  }

  const targetLower = CLIENT_TIME_ZONE_HEADER.toLowerCase();
  const hasCallerHeader = Object.keys(normalized).some((key) => key.toLowerCase() === targetLower);
  if (!hasCallerHeader) {
    const timeZone = detectBrowserTimeZone();
    if (timeZone !== null) {
      normalized[CLIENT_TIME_ZONE_HEADER] = timeZone;
    }
  }

  return normalized;
}
```

- [ ] **Step 2: Wire `withClientTimeZoneHeader` in `ApiClient` (`submitTurn` & `retryTurn`) and `VoiceHttpClient` (`request` with JSON body)**

In `frontend/src/api/client.ts`:
- `submitTurn`: `headers: withClientTimeZoneHeader({ 'Content-Type': 'application/json' })`
- `retryTurn`: `headers: withClientTimeZoneHeader({ 'Content-Type': 'application/json' })`

In `frontend/src/api/voice-client.ts` (`VoiceHttpClient.request`):

```typescript
      const response = await this.fetcher(`${this.base}${path}`, { method, signal: bounded,
        ...(body === undefined ? {} : {
          headers: withClientTimeZoneHeader({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        }) })
```

- [ ] **Step 3: Run frontend verification**

Run: `cd frontend && npm run build && npm run lint && npm test`
Expected: PASS (`build` exits 0, `lint` exits 0 with 0 errors, `test` passes 111 files / 953 tests).

---

### Task 6: Resolve Backend Assembly Regression (`admin-http.spec.ts`), Full Verification Gate & Commit

> **Critical Prerequisite:** `backend/test/assembly/admin-http.spec.ts` currently returns `503 Service Unavailable` on 5 of 7 tests when run against the working-tree edits. Investigate and resolve the root cause before running the full backend gate or committing Milestone 0.

- [ ] **Step 1: Reproduce and inspect the exact `503` response from `admin-http.spec.ts`**

Run: `cd backend && npx vitest run test/assembly/admin-http.spec.ts`
Diagnose why `GET /api/admin/config` and `PUT /api/admin/config` return `503` while `admin-http.spec.ts` executes under `configureApplication` + `configurePrivateHttp` + `AppModule`, and apply the minimal root-cause fix.

- [ ] **Step 2: Run full backend build, lint, and unit test suite**

Run: `cd backend && npm run build && npm run lint && npm test`
Expected: `nest build` exits 0, `oxlint` exits 0 with 0 errors, and all Vitest unit suites pass with 0 failures.

- [ ] **Step 3: Run full frontend build, lint, and unit test suite**

Run: `cd frontend && npm run build && npm run lint && npm test`
Expected: `tsc -b && vite build` exits 0, `oxlint` exits 0 with 0 errors, and all 111 Vitest suites (953 tests) pass.

- [ ] **Step 4: Stage Milestone 0 files explicitly and commit**

```bash
git add \
  backend/src/platform/environment/request-environment.ts \
  backend/src/platform/environment/request-environment-store.ts \
  backend/src/platform/environment/index.ts \
  backend/src/platform/environment/request-environment.spec.ts \
  backend/src/platform/index.ts \
  backend/src/platform/platform.module.ts \
  backend/src/http/configure-private-http.ts \
  backend/src/app.module.ts \
  backend/src/app.service.ts \
  backend/src/main.ts \
  backend/src/http/options.ts \
  backend/src/http/chat-http.service.ts \
  backend/src/voice/session/voice-session.options.ts \
  backend/src/voice/session/voice-session.controller.ts \
  backend/src/voice/session/voice-session.service.ts \
  backend/src/voice/agent/agent-voice-adapter.ts \
  backend/src/contracts/runtime.ts \
  backend/src/chat-runtime/ports.ts \
  backend/src/chat-runtime/admission-receipt.ts \
  backend/src/chat-runtime/durable-chat-runtime.ts \
  backend/src/chat-runtime/memory-text.ts \
  backend/test/http/request-environment-http.spec.ts \
  backend/test/runtime/request-environment-runtime.spec.ts \
  frontend/src/api/client-timezone.ts \
  frontend/src/api/client-timezone.test.ts \
  frontend/src/api/client.ts \
  frontend/src/api/client.test.ts \
  frontend/src/api/voice-client.ts \
  frontend/src/features/voice/transport/voice-client.test.ts
git commit -m "feat(environment): add browser timezone header and request environment foundation"
```

---

## Self-Review

1. **Spec coverage:** Covers frontend `X-Aurvin-Time-Zone` header detection/forwarding, fail-closed backend `RequestEnvironmentStore` for timezone + trusted Cloudflare/Vercel geo headers, CORS + HTTP + voice session propagation, `DurableChatRuntime` + `MemoryText` `'Etc/UTC'` fix, and the open `admin-http.spec.ts` 503 blocker before commit.
2. **Placeholder scan:** No `TODO`, `TBD`, or unimplemented stubs.
3. **Type consistency:** `RequestEnvironmentStore`, `RequestGeoHint`, `CLIENT_TIME_ZONE_HEADER`, `normalizeTimeZone`, `extractRequestEnvironment`, `trustedGeoProxyIngress`, `detectBrowserTimeZone`, and `withClientTimeZoneHeader` match exact definitions across all tasks and existing working-tree files.
