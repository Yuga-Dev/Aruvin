/**
 * ============================================================================
 * FILE: export-http.controller.ts
 * LOCATION: backend/src/http/export-http.controller.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose GET /sessions/:id/export.md (Release 1 unit 0 stub).
 *
 * ROLE IN PROJECT:
 *    Thin controller; unit C sets Content-Type and Content-Disposition.
 *
 * KEY COMPONENTS:
 *    - ExportHttpController: one GET route.
 * ============================================================================
 */

import { Controller, Get, Inject, Param, Query, UseFilters } from '@nestjs/common';
import { ChatHttpFilter } from './chat-http.filter.js';
import { ExportHttpService } from './export-http.service.js';
import { noQuery, pathId } from './validation.js';

@Controller('sessions')
@UseFilters(ChatHttpFilter)
export class ExportHttpController {
  constructor(@Inject(ExportHttpService) private service: ExportHttpService) {}
  @Get(':sessionId/export.md')
  export(@Param('sessionId') s: string, @Query() q: unknown) {
    noQuery(q); return this.service.export(pathId(s));
  }
}
