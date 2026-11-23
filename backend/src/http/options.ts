/**
 * ============================================================================
 * FILE: options.ts
 * LOCATION: backend/src/http/options.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Declare the structural ports required to compose the chat HTTP module.
 *
 * ROLE IN PROJECT:
 *    Lets P9 inject one existing P5 runtime, read-only P2 repositories, the
 *    server identity resolver, and validated budgets without HTTP constructing
 *    a second runtime or owning persistence lifecycle.
 *
 * KEY COMPONENTS:
 *    - ChatHttpOptions: Runtime, repository, identity, and budget composition.
 * ============================================================================
 */

import type { ChatRuntime } from '../chat-runtime/index.js';
import type { SessionRepository, MessageRepository } from '../contracts/repositories.js';
import type { BudgetConfig } from '../contracts/budgets.js';
import type { ServerIdentityResolver } from '../platform/identity/server-identity-resolver.js';
import type { RequestEnvironmentStore } from '../platform/environment/request-environment-store.js';
import type { CurrentConfigPort } from '../contracts/config-runtime.js';
import type { AuthPrincipal } from '../contracts/auth.js';
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
