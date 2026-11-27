/**
 * ============================================================================
 * FILE: search-http.controller.ts
 * LOCATION: backend/src/http/search-http.controller.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose GET /sessions/search (Release 1 unit 0 stub).
 *
 * ROLE IN PROJECT:
 *    Registered before ChatHttpController so the word search is never read as a :sessionId.
 *
 * KEY COMPONENTS:
 *    - SearchHttpController: one GET route delegating to SearchHttpService.
 * ============================================================================
 */

import { Controller, Get, Inject, Query, UseFilters } from '@nestjs/common';
import { ChatHttpFilter } from './chat-http.filter.js';
import { SearchHttpService } from './search-http.service.js';

@Controller('sessions')
@UseFilters(ChatHttpFilter)
export class SearchHttpController {
  constructor(@Inject(SearchHttpService) private service: SearchHttpService) {}
  @Get('search') search(@Query() q: unknown) { return this.service.search(q); }
}
