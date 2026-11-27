/**
 * ============================================================================
 * FILE: user-change-wiring.spec.ts
 * LOCATION: backend/src/chat-runtime/user-change-wiring.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Prove DurableChatRuntime wires user memory changes into the passive-learning scheduler.
 *
 * ROLE IN PROJECT:
 *    Without this wiring, queued passive turns survive a user edit or delete of memory.
 *
 * KEY COMPONENTS:
 *    - Test: the real runtime subscribes once; a user change reaches scheduler.userChanged.
 * ============================================================================
 */

import { expect, it, vi } from 'vitest';
import { textConfigFixture } from '../../test/runtime/text-config-fixture.js';
import { textSnapshot } from '../../test/model/config-snapshot.js';
import type { UserMemoryScheduler } from './user-memory-scheduler.js';

it('a user memory change drops queued passive turns through the real runtime wiring', async () => {
  const listeners: ((userId: string) => void)[] = [];
  const unsubscribe = vi.fn();
  const onUserChange = vi.fn((listener: (userId: string) => void) => { listeners.push(listener); return unsubscribe; });
  const f = textConfigFixture(textSnapshot(1), d => ({ ...d, userMemory: {
    cache: { cachedSnapshot: () => null, cachedMemory: () => null, onUserChange },
    writer: { applyInstruction: vi.fn(), synthesize: vi.fn() } as never,
  } }));
  const scheduler = (f.runtime as unknown as { userMemoryScheduler: UserMemoryScheduler }).userMemoryScheduler;
  expect(onUserChange).toHaveBeenCalledTimes(1);
  const changed = vi.spyOn(scheduler, 'userChanged');
  listeners[0]!(f.identity.userId);
  expect(changed).toHaveBeenCalledWith(f.identity.userId);
  await f.dispose();
});
