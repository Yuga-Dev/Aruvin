/**
 * ============================================================================
 * FILE: revision-http.controller.ts
 * LOCATION: backend/src/http/revision-http.controller.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose POST edit and regenerate turn routes (Release 1 unit 0 stub).
 *
 * ROLE IN PROJECT:
 *    Same 202 contract as retry; the existing stream path applies once unit B implements them.
 *
 * KEY COMPONENTS:
 *    - RevisionHttpController: edit and regenerate POSTs.
 * ============================================================================
 */

import { Body, Controller, HttpCode, Inject, Param, Post, Query, UseFilters } from '@nestjs/common';
import { ChatHttpFilter } from './chat-http.filter.js';
import { RevisionHttpService } from './revision-http.service.js';
import { noQuery, pathId } from './validation.js';

@Controller('sessions')
@UseFilters(ChatHttpFilter)
export class RevisionHttpController {
  constructor(@Inject(RevisionHttpService) private service: RevisionHttpService) {}
  @Post(':sessionId/turns/:turnId/edit') @HttpCode(202)
  edit(@Param('sessionId') s: string, @Param('turnId') t: string, @Body() body: unknown, @Query() q: unknown) {
    noQuery(q); return this.service.edit(pathId(s), pathId(t), body);
  }
  @Post(':sessionId/turns/:turnId/regenerate') @HttpCode(202)
  regenerate(@Param('sessionId') s: string, @Param('turnId') t: string, @Body() body: unknown, @Query() q: unknown) {
    noQuery(q); return this.service.regenerate(pathId(s), pathId(t), body);
  }
}
