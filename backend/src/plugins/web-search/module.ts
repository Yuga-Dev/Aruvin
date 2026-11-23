/**
 * ============================================================================
 * FILE: module.ts
 * LOCATION: backend/src/plugins/web-search/module.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define the configurable NestJS module for the web-search plugin.
 *
 * ROLE IN PROJECT:
 *    Provides controller injection tokens from backend-supplied options without
 *    importing central application services or creating a second composition.
 *
 * KEY COMPONENTS:
 *    - WebSearchModule: Dynamic module with controller and option factories.
 *    - WebSearchModuleOptions: Connections/OAuth/principal/override wiring.
 * ============================================================================
 */

import { ConfigurableModuleBuilder, Module } from '@nestjs/common';
import {
  WEB_SEARCH_CONNECTIONS, WEB_SEARCH_OAUTH, WEB_SEARCH_OPTIONS,
  WEB_SEARCH_OVERRIDES, WEB_SEARCH_PRINCIPAL, WebSearchController,
} from './controller.js';
import type { WebSearchModuleOptions } from './types.js';

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<WebSearchModuleOptions>().build();

@Module({
  controllers: [WebSearchController],
  providers: [
    {
      provide: WEB_SEARCH_CONNECTIONS,
      inject: [MODULE_OPTIONS_TOKEN],
      useFactory: (options: WebSearchModuleOptions) => options.connections,
    },
    {
      provide: WEB_SEARCH_OAUTH,
      inject: [MODULE_OPTIONS_TOKEN],
      useFactory: (options: WebSearchModuleOptions) => options.oauth,
    },
    {
      provide: WEB_SEARCH_PRINCIPAL,
      inject: [MODULE_OPTIONS_TOKEN],
      useFactory: (options: WebSearchModuleOptions) => options.principal,
    },
    {
      provide: WEB_SEARCH_OVERRIDES,
      inject: [MODULE_OPTIONS_TOKEN],
      useFactory: (options: WebSearchModuleOptions) => options.assertNoClientOverrides,
    },
    {
      provide: WEB_SEARCH_OPTIONS,
      inject: [MODULE_OPTIONS_TOKEN],
      useFactory: (options: WebSearchModuleOptions) => options,
    },
  ],
  exports: [
    WEB_SEARCH_CONNECTIONS, WEB_SEARCH_OAUTH, WEB_SEARCH_PRINCIPAL,
    WEB_SEARCH_OVERRIDES, WEB_SEARCH_OPTIONS,
  ],
})
export class WebSearchModule extends ConfigurableModuleClass {}
