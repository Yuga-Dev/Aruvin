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
