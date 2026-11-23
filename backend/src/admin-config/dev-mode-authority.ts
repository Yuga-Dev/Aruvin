/**
 * ============================================================================
 * FILE: dev-mode-authority.ts
 * LOCATION: backend/src/admin-config/dev-mode-authority.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Hold one synchronous per-auth-session User/Dev selection and announcement.
 *
 * ROLE IN PROJECT:
 *    Shared by Config controls and future turn dispatch so only a current,
 *    full-access super-admin session can read, change, or spend diagnostics.
 *
 * KEY COMPONENTS:
 *    - DevModeAuthority: Bounded immutable decisions keyed by auth subject.
 *    - peek / consumeForDispatch: Non-consuming and one-shot dispatch reads.
 * ============================================================================
 */

import { requireSuperAdmin } from '../auth/access.js';
import { ACCOUNT_AUTHORITY_POLICY, type AccountAuthorityPort } from '../auth/account-authority.js';
import { AuthFault } from '../auth/errors.js';
import type { DevMode } from '../contracts/admin-config-wire.js';
import type { AuthPrincipal } from '../contracts/auth.js';
import { AdminConfigFault } from './errors.js';

export type DevModeDecision = Readonly<{ mode: DevMode; announce: boolean }>;
export interface DevModeTurnAuthority {
  peek(principal?: AuthPrincipal): DevModeDecision | null;
  consumeForDispatch(principal?: AuthPrincipal): DevModeDecision | null;
}
const initial: DevModeDecision = Object.freeze({ mode: 'user', announce: true });
type Entry = { userId: string; sessionId: string; epoch: number; decision: DevModeDecision };

export class DevModeAuthority implements DevModeTurnAuthority {
  private enabled = false;
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly accounts: Pick<AccountAuthorityPort, 'snapshot'>) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.entries.clear();
  }
  invalidate(subject: string): void { this.entries.delete(subject); }

  private requireCurrentAdmin(p: AuthPrincipal): void {
    requireSuperAdmin(p);
    const a = this.accounts.snapshot(p.account.workosUserId).account;
    if (!a || a.userId !== p.identity.userId || a.userId !== p.account.userId ||
        a.status !== 'active' || a.currentWorkosSessionId !== p.sessionId ||
        a.sessionEpoch !== p.account.sessionEpoch) throw new AuthFault('UNAUTHENTICATED');
    if (a.passwordChangeRequired) throw new AuthFault('PASSWORD_CHANGE_REQUIRED');
    if (a.role !== 'super-admin') throw new AuthFault('FORBIDDEN');
  }
  private decision(p: AuthPrincipal): DevModeDecision | null {
    const e = this.entries.get(p.account.workosUserId);
    if (e?.userId === p.identity.userId && e.sessionId === p.sessionId &&
        e.epoch === p.account.sessionEpoch) return e.decision;
    // ponytail: bound single-process state; never evict a live latch and re-announce.
    // A larger/multi-executor installation needs session state with coherent lifecycle.
    return e || this.entries.size < ACCOUNT_AUTHORITY_POLICY.maxEntries ? initial : null;
  }
  private store(p: AuthPrincipal, mode: DevMode, announce: boolean): void {
    this.entries.set(p.account.workosUserId, {
      userId: p.identity.userId, sessionId: p.sessionId, epoch: p.account.sessionEpoch,
      decision: Object.freeze({ mode, announce }),
    });
  }
  private requireDecision(p: AuthPrincipal): DevModeDecision {
    const d = this.decision(p);
    if (!d) throw new AuthFault('NOT_READY');
    return d;
  }
  read(p: AuthPrincipal): DevMode | null {
    this.requireCurrentAdmin(p);
    return this.enabled ? this.requireDecision(p).mode : null;
  }
  select(p: AuthPrincipal, mode: DevMode): DevMode {
    this.requireCurrentAdmin(p);
    if (!this.enabled) throw new AdminConfigFault('DEV_MODE_DISABLED');
    if (this.requireDecision(p).mode !== mode) this.store(p, mode, true);
    return mode;
  }
  peek(p?: AuthPrincipal): DevModeDecision | null {
    if (!this.enabled || !p || p.account.role !== 'super-admin' || p.account.passwordChangeRequired) return null;
    try { this.requireCurrentAdmin(p); }
    catch (error) { if (error instanceof AuthFault) return null; throw error; }
    return this.decision(p);
  }
  consumeForDispatch(p?: AuthPrincipal): DevModeDecision | null {
    if (!p) return null;
    const d = this.peek(p);
    if (d?.announce) this.store(p, d.mode, false);
    return d;
  }
}
