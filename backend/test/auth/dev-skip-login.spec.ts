/**
 * ============================================================================
 * FILE: dev-skip-login.spec.ts
 * LOCATION: backend/test/auth/dev-skip-login.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the local-dev login bypass admits the configured account only.
 *
 * ROLE IN PROJECT:
 *    Locks AuthService.devLoginUserId behaviour: no cookie or provider call,
 *    a real session binding, and normal account gates still enforced.
 *
 * KEY COMPONENTS:
 *    - bypass admission, inactive refusal, and default-off checks.
 * ============================================================================
 */

import { AccountAuthority } from '../../src/auth/account-authority.js';
import { AuthService, DEV_LOGIN_SESSION_ID } from '../../src/auth/auth.service.js';
import { AuthFault } from '../../src/auth/errors.js';
import { MongoUsers } from '../../src/persistence/users.js';
import { usersStore } from '../persistence/auth-users-fixture.js';
import { admittedAccount, at, authFixture, providerFixture } from './fixtures.js';

async function devService(initial = admittedAccount({ role: 'super-admin' })) {
  const storage = usersStore(); const users = new MongoUsers(storage.store, storage.owner, 8192);
  await users.insert(initial); const provider = providerFixture();
  const service = new AuthService({ users, provider, authority: new AccountAuthority({ users }),
    now: () => new Date(at), devLoginUserId: initial.userId });
  return { users, provider, service };
}

describe('dev skip-login bypass', () => {
  it('admits the configured account without a cookie or provider call', async () => {
    const f = await devService();
    const prepared = await f.service.prepare(null);
    expect(prepared.principal.identity.userId).toBe('u1');
    expect(prepared.principal.sessionId).toBe(DEV_LOGIN_SESSION_ID);
    expect((await f.users.get('u1'))!.account.currentWorkosSessionId).toBe(DEV_LOGIN_SESSION_ID);
    const fast = await f.service.authenticate(null);
    expect(fast.principal.account.role).toBe('super-admin');
    await f.service.logout(fast.principal);
    expect((await f.service.authenticate(null)).principal.identity.userId).toBe('u1');
    expect(f.provider.read).not.toHaveBeenCalled();
    expect(f.provider.revoke).not.toHaveBeenCalled();
  });

  it('still refuses an inactive account', async () => {
    const f = await devService(admittedAccount({ status: 'inactive' }));
    await expect(f.service.prepare(null)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(f.service.authenticate(null)).rejects.toBeInstanceOf(AuthFault);
  });

  it('is off by default: no cookie stays unauthenticated', async () => {
    const f = await authFixture(admittedAccount());
    await expect(f.service.authenticate(null)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
