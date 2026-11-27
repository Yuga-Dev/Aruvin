/**
 * ============================================================================
 * FILE: export-http.controller.ts
 * LOCATION: backend/src/http/export-http.controller.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose GET /sessions/:id/export.md as an attachment.
 *
 * ROLE IN PROJECT:
 *    Thin controller; sets Content-Type and Content-Disposition (slug-only filename).
 *
 * KEY COMPONENTS:
 *    - ExportHttpController: one GET route.
 * ============================================================================
 */

import { Controller, Get, Inject, Param, Query, Res, UseFilters } from '@nestjs/common';
import type { Response } from 'express';
import { ChatHttpFilter } from './chat-http.filter.js';
import { ExportHttpService } from './export-http.service.js';
import { noQuery, pathId } from './validation.js';

@Controller('sessions')
@UseFilters(ChatHttpFilter)
export class ExportHttpController {
  constructor(@Inject(ExportHttpService) private service: ExportHttpService) {}
  @Get(':sessionId/export.md')
  async export(@Param('sessionId') s: string, @Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    noQuery(q);
    const { markdown, filename } = await this.service.export(pathId(s));
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return markdown;
  }
}
