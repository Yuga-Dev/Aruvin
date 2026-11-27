/**
 * ============================================================================
 * FILE: search-http.service.ts
 * LOCATION: backend/src/http/search-http.service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate and delegate conversation search (Release 1 unit 0 stub).
 *
 * ROLE IN PROJECT:
 *    Unit A replaces the port behind this service; until then it fails closed with SEARCH_UNAVAILABLE.
 *
 * KEY COMPONENTS:
 *    - SearchHttpService.search: Strict query parse, server identity, port call.
 * ============================================================================
 */

import { searchSessionsQuerySchema, searchSessionsResponseSchema } from '../contracts/api.js';
import type { ChatHttpOptions } from './options.js';
import { AppError } from '../platform/errors/app-error.js';

export class SearchHttpService {
  constructor(private readonly o: ChatHttpOptions) {}
  async search(raw: unknown) {
    const parsed = searchSessionsQuerySchema.safeParse(raw);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid request.');
    if (!this.o.search) throw new AppError('SEARCH_UNAVAILABLE', 'Search is unavailable.');
    const identity = this.o.identity.resolve();
    return searchSessionsResponseSchema.parse(await this.o.search.search(identity.userId, parsed.data));
  }
}
