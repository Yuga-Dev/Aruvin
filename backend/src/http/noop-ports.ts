/**
 * ============================================================================
 * FILE: noop-ports.ts
 * LOCATION: backend/src/http/noop-ports.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Fail-closed placeholder ports for Release 1 search and feedback.
 *
 * ROLE IN PROJECT:
 *    Single seam spread in app.service.ts; units A and C replace these with real repositories.
 *
 * KEY COMPONENTS:
 *    - NOOP_FEATURE_PORTS: search and feedback ports that always refuse.
 * ============================================================================
 */

import { AppError } from '../platform/errors/app-error.js';
import type { ChatHttpOptions } from './options.js';

export const NOOP_FEATURE_PORTS: Pick<ChatHttpOptions, 'search' | 'feedback'> = {
  search: { search: async () => { throw new AppError('SEARCH_UNAVAILABLE', 'Search is unavailable.'); } },
  feedback: { put: async () => { throw new AppError('NOT_FOUND', 'Not available.', false); } },
};
