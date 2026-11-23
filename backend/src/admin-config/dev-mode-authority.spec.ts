/**
 * ============================================================================
 * FILE: dev-mode-authority.spec.ts
 * LOCATION: backend/src/admin-config/dev-mode-authority.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify one synchronous, session-fenced User/Dev decision and announcement.
 *
 * ROLE IN PROJECT:
 *    Protects the Config and turn boundary contract without storage, network,
 *    timers, or asynchronous work on the authority path.
 *
 * KEY COMPONENTS:
 *    - Session fencing: Sign-in/revocation clears a cached selection.
 *    - One-shot announcement: Shared atomically between equivalent sessions.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { AccountAuthority } from '../auth/account-authority.js';
import { admitAccount } from '../auth/access.js';
import { admittedAccount } from '../../test/auth/fixtures.js';
import { DevModeAuthority } from './dev-mode-authority.js';

it('shares one synchronous announcement and fences sessions without I/O', async () => {
  const account = admittedAccount({ role: 'super-admin' });
  const subject = account.workosUserId;
  const bySubject = vi.fn(async () => ({ account, revision: 1 }));
  const accounts = new AccountAuthority({ users: { bySubject }, onSessionFence: (id): void => { mode.invalidate(id); } });
  const mode = new DevModeAuthority(accounts);
  accounts.publish(accounts.fence(subject), { account, revision: 1 });
  const text = admitAccount(account, 'sid_1');
  const voice = admitAccount({ ...account }, 'sid_1');
  const other = { ...account, workosUserId: 'other_subject', userId: 'other_user' };
  accounts.publish(accounts.fence(other.workosUserId), { account: other, revision: 1 });
  const otherAdmin = admitAccount(other, 'sid_1');
  expect(mode.peek(text)).toBeNull();
  mode.setEnabled(true);
  expect(mode.peek()).toBeNull();
  expect(mode.peek(admitAccount({ ...account, role: 'user' }, 'sid_1'))).toBeNull();
  expect(mode.peek(admitAccount({ ...account, passwordChangeRequired: true }, 'sid_1'))).toBeNull();
  expect(mode.peek(text)).toEqual({ mode: 'user', announce: true });
  expect(mode.consumeForDispatch(voice)).toEqual({ mode: 'user', announce: true });
  expect(mode.consumeForDispatch(text)).toEqual({ mode: 'user', announce: false });
  mode.select(text, 'dev');
  mode.select(voice, 'user');
  mode.select(text, 'dev');
  expect(mode.read(otherAdmin)).toBe('user');
  expect(mode.read(text)).toBe('dev');
  const frozen = mode.consumeForDispatch(text);
  expect(frozen).toEqual({ mode: 'dev', announce: true });
  mode.select(voice, 'dev');
  expect(mode.consumeForDispatch(voice)).toEqual({ mode: 'dev', announce: false });
  expect(bySubject).not.toHaveBeenCalled();
  await accounts.warm(subject);
  mode.setEnabled(true); // e.g. a confirmed unrelated settings save
  expect(mode.peek(voice)).toEqual({ mode: 'dev', announce: false });
  mode.select(text, 'user');
  expect(mode.consumeForDispatch(voice)).toEqual({ mode: 'user', announce: true });
  expect(mode.consumeForDispatch(text)).toEqual({ mode: 'user', announce: false });
  mode.select(text, 'dev');
  mode.setEnabled(false);
  expect(mode.peek(voice)).toBeNull();
  expect(frozen).toEqual({ mode: 'dev', announce: true });
  mode.setEnabled(true);
  expect(mode.peek(text)).toEqual({ mode: 'user', announce: true });
  mode.select(voice, 'dev');
  // A sign-in fence clears cached mode even if the test provider reuses the ID.
  accounts.publish(accounts.fence(subject), { account, revision: 1 });
  expect(mode.peek(text)).toEqual({ mode: 'user', announce: true });
  mode.select(voice, 'dev');
  const ticket = accounts.fence(subject, 'revocation');
  expect(mode.consumeForDispatch(voice)).toBeNull();
  accounts.publish(ticket, { account: { ...account, currentWorkosSessionId: null, sessionEpoch: 1 }, revision: 2 });
  const fresh = { ...account, currentWorkosSessionId: 'sid_next', sessionEpoch: 1 };
  accounts.publish(accounts.fence(subject), { account: fresh, revision: 3 });
  expect(mode.peek(text)).toBeNull();
  expect(mode.consumeForDispatch(admitAccount(fresh, 'sid_next'))).toEqual({ mode: 'user', announce: true });
  expect(bySubject).toHaveBeenCalledTimes(1); // only the explicit warm
});
