/**
 * ============================================================================
 * FILE: auth.service.ts
 * LOCATION: backend/src/auth/auth.service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Implement closed login, admission, logout, password, and recovery flows.
 *
 * ROLE IN PROJECT:
 *    Owns application session binding and onboarding gates while WorkOS owns
 *    credentials. Independently testable before P3 root wiring.
 *
 * KEY COMPONENTS:
 *    - login / authenticate / logout / me: Closed session admission.
 *    - password / forgotPassword / resetPassword: Onboarding and recovery.
 * ============================================================================
 */

import type { ZodType, ZodTypeDef } from 'zod';
import {
  forgotPasswordRequestSchema,
  loginRequestSchema,
  passwordRequestSchema,
  resetPasswordRequestSchema,
  type AccountRead,
  type AuthOkResponse,
  type AuthPrincipal,
  type AuthUser,
  type AuthUserResponse,
  type UserAccount,
  type UsersRepository,
} from '../contracts/auth.js';
import { admitAccount, invalidateAccount, publicUser } from './access.js';
import { AccountAuthority, type AccountAuthorityFence, type AccountAuthorityPort } from './account-authority.js';
import { AttemptLimiter } from './attempt-limiter.js';
import { AuthFault } from './errors.js';
import type { AuthProvider } from './provider.js';

function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new AuthFault('INVALID_REQUEST');
  return result.data;
}

export type AuthServiceOptions = {
  users: UsersRepository; provider: AuthProvider | null;
  authority?: AccountAuthorityPort; now?: () => Date;
};
export class AuthService {
  readonly authority: AccountAuthorityPort;
  private readonly limiter = new AttemptLimiter();
  constructor(private readonly o: AuthServiceOptions) {
    this.authority = o.authority ?? new AccountAuthority({ users: o.users });
  }
  private now() { return (this.o.now ?? (() => new Date()))().toISOString(); }
  private provider(): AuthProvider { if (!this.o.provider) throw new AuthFault('NOT_READY'); return this.o.provider; }
  private async confirmed(expected: AccountRead, next: UserAccount): Promise<AccountRead> {
    const r = await this.o.users.compareAndSwap(expected, next);
    if (r.outcome !== 'confirmed') throw new AuthFault('NOT_READY'); return r.value;
  }
  private publish(ticket: AccountAuthorityFence, value: AccountRead): AccountRead {
    if (!this.authority.publish(ticket, value)) throw new AuthFault('NOT_READY');
    return value;
  }
  private fenceRepresentedSession(subject: string, sessionId: string): void {
    try {
      const current = this.authority.snapshot(subject);
      if (current.account?.currentWorkosSessionId === sessionId)
        this.authority.fail(this.authority.fence(subject, 'revocation'));
    } catch (error) {
      if (!(error instanceof AuthFault) || error.code !== 'NOT_READY') throw error;
      // Already closed: this helper must not hydrate or replace a newer operation.
    }
  }
  async login(body: unknown): Promise<{ user: AuthUser; sealedSession: string }> {
    this.limiter.takeGlobal();
    const request = parse(loginRequestSchema, body); this.limiter.take('login', request.email);
    const provider = this.provider();
    // Snapshot before inference-like external work; a concurrent deactivate/reset must win the CAS.
    const local = await this.o.users.byEmail(request.email);
    const session = await provider.login(request.email, request.password);
    if (!local || local.account.status !== 'active' || local.account.workosUserId !== session.workosUserId) {
      await provider.revoke(session.sessionId).catch(() => undefined); throw new AuthFault('UNAUTHENTICATED');
    }
    // ponytail: one live WorkOS session per account; use a bounded session store if concurrent devices become required.
    let ticket: AccountAuthorityFence | undefined;
    let saved: AccountRead;
    try {
      ticket = this.authority.fence(session.workosUserId);
      saved = this.publish(ticket, await this.confirmed(local, {
        ...local.account, currentWorkosSessionId: session.sessionId, updatedAt: this.now(),
      }));
    } catch (error) {
      if (ticket) this.authority.fail(ticket);
      this.fenceRepresentedSession(session.workosUserId, session.sessionId);
      await provider.revoke(session.sessionId).catch(() => undefined);
      throw error;
    }
    return { user: publicUser(saved.account), sealedSession: session.sealedSession };
  }
  async authenticate(cookie: string | null): Promise<{ principal: AuthPrincipal; sealedSession?: string }> {
    const provider = this.provider(); if (!cookie) throw new AuthFault('UNAUTHENTICATED');
    const session = await provider.read(cookie);
    const local = this.authority.snapshot(session.workosUserId);
    const principal = admitAccount(local.account, session.sessionId);
    return { principal, ...(session.sealedSession ? { sealedSession: session.sealedSession } : {}) };
  }
  async prepare(cookie: string | null): Promise<{ principal: AuthPrincipal; sealedSession?: string }> {
    const provider = this.provider();
    if (!cookie) throw new AuthFault('UNAUTHENTICATED');
    const session = await provider.read(cookie);
    await this.authority.warm(session.workosUserId);
    const principal = admitAccount(this.authority.snapshot(session.workosUserId).account, session.sessionId);
    return { principal, ...(session.sealedSession ? { sealedSession: session.sealedSession } : {}) };
  }
  async logout(principal: AuthPrincipal): Promise<void> {
    const provider = this.provider();
    let current: AccountRead | null;
    try { current = await this.o.users.get(principal.account.userId); }
    catch (error) {
      this.fenceRepresentedSession(principal.account.workosUserId, principal.sessionId);
      throw error;
    }
    if (current && current.account.currentWorkosSessionId === principal.sessionId) {
      const ticket = this.authority.fence(current.account.workosUserId, 'revocation');
      try {
        this.publish(ticket, await this.confirmed(current, invalidateAccount(current.account, this.now())));
      } catch (error) {
        this.authority.fail(ticket);
        throw error;
      }
    }
    await provider.revoke(principal.sessionId);
  }
  me(principal: AuthPrincipal): AuthUserResponse { return { user: publicUser(principal.account) }; }
  async password(principal: AuthPrincipal, body: unknown): Promise<{ user: AuthUser; sealedSession: string }> {
    this.limiter.takeGlobal(); const request = parse(passwordRequestSchema, body); const provider = this.provider();
    const current = await this.o.users.get(principal.account.userId);
    if (!current) throw new AuthFault('UNAUTHENTICATED'); admitAccount(current.account, principal.sessionId);
    this.limiter.take('login', current.account.emailNormalized);
    const proof = await provider.login(current.account.emailNormalized, request.currentPassword);
    try {
      if (proof.workosUserId !== current.account.workosUserId) throw new AuthFault('UNAUTHENTICATED');
    } finally { await provider.revoke(proof.sessionId); }
    // Remove old application access before dispatching a credential mutation. A timeout cannot unlock it.
    const ticket = this.authority.fence(current.account.workosUserId);
    let fenced: AccountRead;
    try {
      fenced = await this.confirmed(current, invalidateAccount(current.account, this.now()));
    } catch (error) {
      this.authority.fail(ticket);
      throw error;
    }
    try {
      await provider.replacePassword(current.account.workosUserId, request.newPassword);
    } catch (error) {
      if (error instanceof AuthFault && error.code === 'INVALID_REQUEST') {
        await this.confirmed(fenced, { ...current.account, sessionEpoch: fenced.account.sessionEpoch, updatedAt: this.now() })
          .then(saved => this.publish(ticket, saved))
          .catch(() => this.authority.fail(ticket));
      } else {
        this.authority.fail(ticket);
      }
      throw error;
    }
    let fresh;
    try {
      fresh = await provider.login(current.account.emailNormalized, request.newPassword);
    } catch (error) {
      this.authority.fail(ticket);
      throw error;
    }
    if (fresh.workosUserId !== current.account.workosUserId) {
      this.authority.fail(ticket);
      await provider.revoke(fresh.sessionId).catch(() => undefined); throw new AuthFault('UNAUTHENTICATED');
    }
    let saved: AccountRead;
    try {
      saved = this.publish(ticket, await this.confirmed(fenced, { ...fenced.account, passwordChangeRequired: false,
        currentWorkosSessionId: fresh.sessionId, updatedAt: this.now() }));
    } catch (error) {
      this.authority.fail(ticket);
      this.fenceRepresentedSession(fresh.workosUserId, fresh.sessionId);
      await provider.revoke(fresh.sessionId).catch(() => undefined);
      throw error;
    }
    await provider.revoke(principal.sessionId).catch(() => undefined);
    return { user: publicUser(saved.account), sealedSession: fresh.sealedSession };
  }
  async forgotPassword(body: unknown): Promise<AuthOkResponse> {
    this.limiter.takeGlobal(); const { email } = parse(forgotPasswordRequestSchema, body);
    this.limiter.take('recovery', email);
    // Uniform even if configured provider/storage is unavailable; no account-existence signal.
    try {
      const provider = this.provider(); const local = await this.o.users.byEmail(email);
      if (local?.account.status === 'active') await provider.sendRecovery(local.account.emailNormalized);
    } catch { /* No token/error payload is logged or reflected. Same response as unknown email. */ }
    return { ok: true };
  }
  async resetPassword(body: unknown): Promise<AuthOkResponse> {
    this.limiter.takeGlobal(); const { token, newPassword } = parse(resetPasswordRequestSchema, body);
    const result = await this.provider().reset(token, newPassword);
    // Provider identifies the subject. Do not infer an owner from email or a client id.
    const ticket = this.authority.fence(result.workosUserId, 'revocation');
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await this.o.users.bySubject(result.workosUserId);
        if (!current) throw new AuthFault('UNAUTHENTICATED');
        const next = { ...invalidateAccount(current.account, this.now()), passwordChangeRequired: false };
        const saved = await this.o.users.compareAndSwap(current, next);
        if (saved.outcome === 'confirmed') { this.publish(ticket, saved.value); return { ok: true }; }
        if (saved.outcome === 'uncertain') throw new AuthFault('NOT_READY');
      }
      throw new AuthFault('NOT_READY');
    } catch (error) {
      this.authority.fail(ticket);
      throw error;
    }
  }
}
