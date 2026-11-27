/**
 * ============================================================================
 * FILE: chat-http.module.ts
 * LOCATION: backend/src/http/chat-http.module.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Export a configurable Nest module for chat HTTP routes and transport.
 *
 * ROLE IN PROJECT:
 *    Lets P9 register one ChatHttpModule with an existing runtime and
 *    repositories; HTTP never constructs a second runtime or global filter.
 *
 * KEY COMPONENTS:
 *    - ChatHttpModule.register / registerAsync: Dynamic composition.
 *    - Factories: ChatHttpService and ChatStreamTransport from options.
 * ============================================================================
 */

import { ConfigurableModuleBuilder,Module } from '@nestjs/common';
import type { ChatHttpOptions } from './options.js';
import { ChatHttpService } from './chat-http.service.js';
import { ChatStreamTransport } from './chat-stream.transport.js';
import { ChatHttpController } from './chat-http.controller.js';
import { SearchHttpController } from './search-http.controller.js';
import { SearchHttpService } from './search-http.service.js';
import { RevisionHttpController } from './revision-http.controller.js';
import { RevisionHttpService } from './revision-http.service.js';
import { FeedbackHttpController } from './feedback-http.controller.js';
import { FeedbackHttpService } from './feedback-http.service.js';
import { ExportHttpController } from './export-http.controller.js';
import { ExportHttpService } from './export-http.service.js';
const { ConfigurableModuleClass,MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<ChatHttpOptions>().build();
// SearchHttpController must precede ChatHttpController so GET /sessions/search is not matched as :sessionId.
@Module({ controllers:[SearchHttpController,ChatHttpController,RevisionHttpController,FeedbackHttpController,ExportHttpController],providers:[
  { provide:SearchHttpService,inject:[MODULE_OPTIONS_TOKEN],useFactory:(o:ChatHttpOptions) => new SearchHttpService(o) },
  { provide:RevisionHttpService,inject:[MODULE_OPTIONS_TOKEN],useFactory:(o:ChatHttpOptions) => new RevisionHttpService(o) },
  { provide:FeedbackHttpService,inject:[MODULE_OPTIONS_TOKEN],useFactory:(o:ChatHttpOptions) => new FeedbackHttpService(o) },
  { provide:ExportHttpService,inject:[MODULE_OPTIONS_TOKEN],useFactory:(o:ChatHttpOptions) => new ExportHttpService(o) },
  { provide:ChatHttpService,inject:[MODULE_OPTIONS_TOKEN],useFactory:(o:ChatHttpOptions) => new ChatHttpService(o) },
  { provide:ChatStreamTransport,inject:[ChatHttpService],useFactory:(s:ChatHttpService) => new ChatStreamTransport(s) },
],exports:[ChatHttpService,ChatStreamTransport] })
export class ChatHttpModule extends ConfigurableModuleClass {}
