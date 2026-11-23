/**
 * ============================================================================
 * FILE: personalization.module.ts
 * LOCATION: backend/src/personalization/personalization.module.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Register the composable NestJS module for user personalization routes.
 *
 * ROLE IN PROJECT:
 *    Receives the shared PersonalizationService and server userId resolver from
 *    AppService without constructing a duplicate persistence owner or cache.
 *
 * KEY COMPONENTS:
 *    - PersonalizationModule.registerAsync: Configurable module wiring.
 *    - Optional shared memory service/writer providers for P2 HTTP composition.
 * ============================================================================
 */

import { ConfigurableModuleBuilder, Module } from '@nestjs/common';
import {
  PERSONALIZATION_USER_ID,
  PersonalizationController,
} from './personalization.controller.js';
import { MemoryWriterService } from './memory-writer.js';
import { PersonalizationService } from './personalization.service.js';
import { UserMemoryController } from './user-memory.controller.js';
import { UserMemoryService } from './user-memory.service.js';

export type PersonalizationModuleOptions = {
  service: PersonalizationService;
  userId: () => string;
  userMemoryService?: UserMemoryService;
  memoryWriter?: MemoryWriterService;
};

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<PersonalizationModuleOptions>().build();

@Module({
  controllers: [PersonalizationController, UserMemoryController],
  providers: [
    {
      provide: UserMemoryService,
      inject: [MODULE_OPTIONS_TOKEN],
      useFactory: (options: PersonalizationModuleOptions) => options.userMemoryService ?? null,
    },
    {
      provide: MemoryWriterService,
      inject: [MODULE_OPTIONS_TOKEN],
      useFactory: (options: PersonalizationModuleOptions) => options.memoryWriter ?? null,
    },
    {
      provide: PersonalizationService,
      inject: [MODULE_OPTIONS_TOKEN],
      useFactory: (options: PersonalizationModuleOptions) => options.service,
    },
    {
      provide: PERSONALIZATION_USER_ID,
      inject: [MODULE_OPTIONS_TOKEN],
      useFactory: (options: PersonalizationModuleOptions) => options.userId,
    },
  ],
  exports: [PersonalizationService],
})
export class PersonalizationModule extends ConfigurableModuleClass {}
