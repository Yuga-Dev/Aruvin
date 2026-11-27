/**
 * ============================================================================
 * FILE: feedback-http.controller.ts
 * LOCATION: backend/src/http/feedback-http.controller.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose PUT /sessions/:id/messages/:messageId/feedback (Release 1 unit 0 stub).
 *
 * ROLE IN PROJECT:
 *    Thin controller; ownership checks and storage belong to unit C.
 *
 * KEY COMPONENTS:
 *    - FeedbackHttpController: one PUT route.
 * ============================================================================
 */

import { Body, Controller, Inject, Param, Put, Query, UseFilters } from '@nestjs/common';
import { ChatHttpFilter } from './chat-http.filter.js';
import { FeedbackHttpService } from './feedback-http.service.js';
import { noQuery, pathId } from './validation.js';

@Controller('sessions')
@UseFilters(ChatHttpFilter)
export class FeedbackHttpController {
  constructor(@Inject(FeedbackHttpService) private service: FeedbackHttpService) {}
  @Put(':sessionId/messages/:messageId/feedback')
  put(@Param('sessionId') s: string, @Param('messageId') m: string, @Body() body: unknown, @Query() q: unknown) {
    noQuery(q); return this.service.put(pathId(s), pathId(m), body);
  }
}
