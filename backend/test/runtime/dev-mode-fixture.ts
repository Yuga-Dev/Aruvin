/**
 * ============================================================================
 * FILE: dev-mode-fixture.ts
 * LOCATION: backend/test/runtime/dev-mode-fixture.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Provide one real DevModeAuthority and runtime harness for dispatch tests.
 *
 * ROLE IN PROJECT:
 *    Lets text, voice, and persistence specs share the same one-shot latch and
 *    captured OpenRouter bodies without native storage or a live provider.
 *
 * KEY COMPONENTS:
 *    - authority: AccountAuthority + DevModeAuthority with a published admin.
 *    - fixture: textConfigFixture decorated with the authority and a held save.
 *    - wire / execute: Captured request body and principal-bound execution.
 * ============================================================================
 */

import { vi } from 'vitest';
import { AccountAuthority } from '../../src/auth/account-authority.js';
import { admitAccount } from '../../src/auth/access.js';
import type { AuthPrincipal } from '../../src/contracts/auth.js';
import { DevModeAuthority } from '../../src/admin-config/dev-mode-authority.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from '../../src/chat-runtime/memory-text.js';
import type { TerminalEnvelope } from '../../src/chat-runtime/memory-first-foundation.js';
import type { ChatLimits } from '../../src/contracts/admin-config-wire.js';
import { admittedAccount } from '../auth/fixtures.js';
import { textSnapshot } from '../model/config-snapshot.js';
import { textConfigFixture } from './text-config-fixture.js';

export function authority(role: 'user' | 'super-admin' = 'super-admin') {
  const account = admittedAccount({ userId: 'aurvin-dev-user', role });
  const bySubject = vi.fn(async () => ({ account, revision: 1 }));
  const accounts = new AccountAuthority({ users: { bySubject }, onSessionFence: id => mode.invalidate(id) });
  const mode = new DevModeAuthority(accounts);
  accounts.publish(accounts.fence(account.workosUserId), { account, revision: 1 });
  return { mode, accounts, account, bySubject, principal: admitAccount(account, 'sid_1') };
}

export function fixture({ mode }: ReturnType<typeof authority>, durable = false,
  chat: Partial<ChatLimits> = {}) {
  const save = vi.fn(async (e: TerminalEnvelope) =>
    ({ kind: 'saved' as const, sessionId: e.sessionId, epoch: e.epoch, version: e.version, fence: e.fence }));
  const f = textConfigFixture(textSnapshot(1, chat), d => ({
    ...d, devMode: mode, now: () => Date.parse('2026-11-18T12:00:00Z'),
    ...(durable ? {} : { memoryFirst: { policy: { ...PROPOSED_MEMORY_TEXT_POLICY }, voice: true, save } }),
  }));
  return { f, save };
}

export type Wire = { messages: { role: string; content: string }[]; tools?: unknown };
export const wire = (f: ReturnType<typeof textConfigFixture>, i = 0): Wire =>
  JSON.parse(String(f.fetcher.mock.calls[i]?.[1]?.body)) as Wire;

export function execute(f: ReturnType<typeof textConfigFixture>, ids: Awaited<ReturnType<typeof textConfigFixture>['submit']>,
  principal: AuthPrincipal, signal = new AbortController().signal,
  emit: Parameters<typeof f.runtime.executeTurn>[0]['emit'] = async () => {}) {
  return f.runtime.executeTurn({ ...ids, userId: f.identity.userId, principal, signal, emit });
}
