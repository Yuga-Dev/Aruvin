/**
 * ============================================================================
 * FILE: turn-model-mode.ts
 * LOCATION: backend/src/chat-runtime/turn-model-mode.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Freeze one User/Dev decision immediately before a model dispatch.
 *
 * ROLE IN PROJECT:
 *    Wraps P1's synchronous authority into a request-local handle. The handle
 *    is created only after ownership checks, spends at most one announcement
 *    per admitted execution, and never performs I/O or asynchronous work.
 *
 * KEY COMPONENTS:
 *    - createTurnModelMode: Eligibility, last-moment peek, freeze/consume.
 *    - admitEffect: Deny Dev mutations and freeze related User operations.
 *    - dispatchStream: Optional second adapter argument for the wire projection.
 * ============================================================================
 */

import type { DevModeDecision, DevModeTurnAuthority } from '../admin-config/dev-mode-authority.js';
import type { AuthPrincipal } from '../contracts/auth.js';
import type { ContextChatMessage } from '../contracts/context.js';

export type TurnModeHandle = {
  /** Frozen decision after dispatch/effect admission; otherwise the latest peek. */
  current(): DevModeDecision | null;
  /** Build/serialize, run a late check, then freeze and optionally consume. */
  prepare<T>(build: (decision: DevModeDecision | null) => T, check: () => void): T;
  frozen(): DevModeDecision | null | undefined;
  /** Non-consuming synchronous mutation/effect admission. */
  admitEffect(related: boolean): boolean;
};

export type TurnModelDispatch = {
  readonly handle: TurnModeHandle;
  /** Exact messages for the selected mode; the same reference when off. */
  project(decision: DevModeDecision | null): readonly ContextChatMessage[];
  /** Original accepted input; trusted overhead is not new user input. */
  readonly rawInput: string;
};

export function createTurnModelMode(authority: DevModeTurnAuthority | undefined,
  principal: AuthPrincipal | undefined, owner: string, canAnnounce = true): TurnModeHandle | undefined {
  if (!authority || !principal || principal.account.role !== 'super-admin' ||
      principal.account.passwordChangeRequired || principal.identity.source !== 'authenticated-session' ||
      principal.identity.userId !== owner || principal.account.userId !== owner) return undefined;
  let frozen: DevModeDecision | null | undefined; // undefined = not yet admitted for model/effect
  const source = authority;
  const current = () => frozen !== undefined ? frozen : source.peek(principal);
  function prepare<T>(build: (decision: DevModeDecision | null) => T, check: () => void): T {
    const decision = current();
    const ready = build(decision); // pure validation + serialization; may throw
    if (decision) check();         // late cancellation check for decorated wire; no yield
    if (frozen === undefined) {
      frozen = decision
        ? canAnnounce ? source.consumeForDispatch(principal) : Object.freeze({ ...decision, announce: false })
        : null;
    }
    return ready;
  }
  function admitEffect(related: boolean): boolean {
    const d = current();
    if (d?.mode === 'dev') return false;
    if (related && frozen === undefined) frozen = d ? Object.freeze({ ...d, announce: false }) : null;
    return true;
  }
  return { current, prepare, frozen: () => frozen, admitEffect };
}

/** Pass the optional model-only projection without widening public contracts. */
export function dispatchStream<R, T>(adapter: { stream(request: R): AsyncIterable<T> },
  request: R, dispatch?: TurnModelDispatch): AsyncIterable<T> {
  if (!dispatch) return adapter.stream(request);
  return (adapter.stream as (r: R, d?: TurnModelDispatch) => AsyncIterable<T>)(request, dispatch);
}
