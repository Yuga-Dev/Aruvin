/**
 * ============================================================================
 * FILE: account-authority.ts
 * LOCATION: backend/src/auth/account-authority.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Hold one bounded, server-only snapshot of confirmed account authority.
 *
 * ROLE IN PROJECT:
 *    Replaces the per-request account lookup in AuthService.authenticate with
 *    an explicitly warmed, revision-fenced memory snapshot while WorkOS still
 *    verifies every sealed session and admitAccount still enforces local state.
 *
 * KEY COMPONENTS:
 *    - AccountAuthorityPort: snapshot, warm, fence, publish, fail, close.
 *    - AccountAuthority: Bounded map, generation tokens, revision/epoch guards.
 * ============================================================================
 */

import { isDeepStrictEqual } from 'node:util';
import {
  userAccountSchema,
  type AccountRead,
  type UserAccount,
  type UsersRepository,
} from '../contracts/auth.js';
import { idSchema } from '../contracts/identifiers.js';
import { AuthFault } from './errors.js';

export const ACCOUNT_AUTHORITY_POLICY = Object.freeze({
  maxEntries: 1024,
  maxSnapshotBytes: 2048,
  maxAgeMs: 900_000,
  maxWarmReads: 4,
});

export type AccountAuthorityPolicy = {
  maxEntries: number;
  maxSnapshotBytes: number;
  maxAgeMs: number;
  maxWarmReads: number;
};
export type AccountAuthorityChange = 'replacement' | 'revocation';

export type AccountAuthoritySnapshot = Readonly<{
  workosUserId: string;
  account: Readonly<UserAccount> | null;
  revision: number | null;
  generation: number;
  verifiedAt: number;
  expiresAt: number;
}>;

declare const authorityFenceBrand: unique symbol;
export type AccountAuthorityFence = Readonly<{
  workosUserId: string;
  generation: number;
  [authorityFenceBrand]: true;
}>;

export interface AccountAuthorityPort {
  snapshot(workosUserId: string): AccountAuthoritySnapshot;
  warm(workosUserId: string): Promise<void>;
  fence(workosUserId: string, change?: AccountAuthorityChange): AccountAuthorityFence;
  publish(fence: AccountAuthorityFence, value: AccountRead | null): boolean;
  fail(fence: AccountAuthorityFence): void;
  close(): void;
}

type AccountAuthorityOptions = {
  users: Pick<UsersRepository, 'bySubject'>;
  onSessionFence?: (workosUserId: string) => void;
  nowMs?: () => number;
  policy?: AccountAuthorityPolicy;
};

type Entry = {
  token: AccountAuthorityFence;
  state: 'warming' | 'fenced' | 'uncertain' | 'ready';
  change: AccountAuthorityChange | null;
  floor: AccountRead | null;
  snapshot: AccountAuthoritySnapshot | null;
};

export class AccountAuthority implements AccountAuthorityPort {
  private readonly entries = new Map<string, Entry>();
  private readonly policy: AccountAuthorityPolicy;
  private sequence = 0;
  private lastNow = -Infinity;
  private closed = false;
  private warmReads = 0;

  constructor(private readonly o: AccountAuthorityOptions) {
    this.policy = { ...ACCOUNT_AUTHORITY_POLICY, ...o.policy };
    if (Object.values(this.policy).some(n => !Number.isSafeInteger(n) || n <= 0) ||
        this.policy.maxWarmReads > this.policy.maxEntries) throw new AuthFault('NOT_READY');
  }

  private assertOpen(): number {
    if (this.closed) throw new AuthFault('NOT_READY');
    const now = (this.o.nowMs ?? (() => performance.now()))();
    if (!Number.isFinite(now) || now < 0 || now < this.lastNow) {
      this.close();
      throw new AuthFault('NOT_READY');
    }
    this.lastNow = now;
    return now;
  }

  private begin(subject: string, state: 'warming' | 'fenced',
    change: AccountAuthorityChange | null = null): AccountAuthorityFence {
    this.assertOpen();
    if (!idSchema.safeParse(subject).success) throw new AuthFault('NOT_READY');
    const previous = this.entries.get(subject);
    if (!previous && this.entries.size >= this.policy.maxEntries) {
      // ponytail: single-process, <=1024 entries; bounded O(n) ready-only eviction.
      // A larger/multi-executor deployment needs coherent authority, not a generic cache.
      const victim = [...this.entries].find(([, entry]) => entry.state === 'ready')?.[0];
      if (victim === undefined) throw new AuthFault('NOT_READY');
      this.entries.delete(victim);
    }
    if (!Number.isSafeInteger(this.sequence + 1)) {
      this.close();
      throw new AuthFault('NOT_READY');
    }
    const token = Object.freeze({
      workosUserId: subject, generation: ++this.sequence,
    }) as AccountAuthorityFence;
    this.entries.delete(subject);
    this.entries.set(subject, {
      token, state, change, floor: previous?.floor ?? null, snapshot: null,
    });
    return token;
  }

  snapshot(subject: string): AccountAuthoritySnapshot {
    const now = this.assertOpen();
    const entry = this.entries.get(subject);
    if (entry?.state !== 'ready' || !entry.snapshot || now >= entry.snapshot.expiresAt)
      throw new AuthFault('NOT_READY');
    return entry.snapshot;
  }

  fence(subject: string, change: AccountAuthorityChange = 'replacement'): AccountAuthorityFence {
    this.assertOpen();
    if (change === 'replacement' && this.entries.get(subject)?.state === 'fenced')
      throw new AuthFault('NOT_READY');
    const ticket = this.begin(subject, 'fenced', change);
    this.o.onSessionFence?.(subject);
    return ticket;
  }

  publish(ticket: AccountAuthorityFence, value: AccountRead | null): boolean {
    const entry = this.entries.get(ticket.workosUserId);
    if (this.closed || entry?.token !== ticket ||
        entry.state === 'ready' || entry.state === 'uncertain') return false;
    const invalid = (): never => { this.fail(ticket); throw new AuthFault('NOT_READY'); };
    const parsed = value === null ? null : userAccountSchema.safeParse(value.account);
    if (parsed && (!parsed.success || !Number.isSafeInteger(value!.revision) || value!.revision < 0))
      return invalid();
    const account = parsed?.success ? parsed.data : null;
    const revision = value?.revision ?? null;
    if (account && account.workosUserId !== ticket.workosUserId) return invalid();
    if (account && entry.change === 'revocation' && (
      account.currentWorkosSessionId !== null ||
      (entry.floor?.account.status === 'inactive' && account.status !== 'inactive')
    )) return invalid();
    if (account && entry.floor && (
      revision! < entry.floor.revision ||
      account.sessionEpoch < entry.floor.account.sessionEpoch ||
      account.userId !== entry.floor.account.userId ||
      account.emailNormalized !== entry.floor.account.emailNormalized ||
      account.role !== entry.floor.account.role ||
      account.createdAt !== entry.floor.account.createdAt ||
      (revision === entry.floor.revision && !isDeepStrictEqual(account, entry.floor.account))
    )) return invalid();
    const verifiedAt = this.assertOpen();
    const expiresAt = verifiedAt + this.policy.maxAgeMs;
    if (!Number.isFinite(expiresAt)) { this.close(); throw new AuthFault('NOT_READY'); }
    const snapshot = Object.freeze({
      workosUserId: ticket.workosUserId,
      account: account ? Object.freeze(account) : null,
      revision,
      generation: ticket.generation, verifiedAt, expiresAt,
    });
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > this.policy.maxSnapshotBytes)
      return invalid();
    entry.state = 'ready';
    entry.snapshot = snapshot;
    if (account) entry.floor = { account, revision: revision! };
    this.entries.delete(ticket.workosUserId);
    this.entries.set(ticket.workosUserId, entry);
    return true;
  }

  fail(ticket: AccountAuthorityFence): void {
    const entry = this.entries.get(ticket.workosUserId);
    if (entry?.token === ticket) {
      entry.state = 'uncertain';
      entry.snapshot = null;
    }
  }

  async warm(workosUserId: string): Promise<void> {
    this.assertOpen();
    const previous = this.entries.get(workosUserId);
    if (this.warmReads >= this.policy.maxWarmReads ||
        (previous && previous.state !== 'ready')) throw new AuthFault('NOT_READY');
    const ticket = this.begin(workosUserId, 'warming');
    this.warmReads++;
    try {
      const value = await this.o.users.bySubject(workosUserId);
      if (!this.publish(ticket, value)) throw new AuthFault('NOT_READY');
    } catch {
      this.fail(ticket);
      throw new AuthFault('NOT_READY');
    } finally {
      this.warmReads--;
    }
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
  }
}
