/**
 * ============================================================================
 * FILE: admin-analytics.module.ts
 * LOCATION: backend/src/admin-analytics/admin-analytics.module.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Register the admin analytics route with injected reporting and principal.
 *
 * ROLE IN PROJECT:
 *    Composed once in AppModule; opens no persistence of its own.
 *
 * KEY COMPONENTS:
 *    - AdminAnalyticsModule.registerAsync and its narrow options type.
 * ============================================================================
 */
import { ConfigurableModuleBuilder, Module } from '@nestjs/common';
import type { AuthPrincipal } from '../contracts/auth.js';
import { ADMINISTRATION_PRINCIPAL } from '../administration/administration.controller.js';
import { ADMIN_ANALYTICS_REPORT, AdminAnalyticsController, type AdminAnalyticsReport } from './admin-analytics.controller.js';

export type AdminAnalyticsModuleOptions = {
  report: AdminAnalyticsReport; principal: () => AuthPrincipal | null; pageSize: number;
};
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<AdminAnalyticsModuleOptions>().build();
@Module({ controllers: [AdminAnalyticsController], providers: [
  { provide: ADMIN_ANALYTICS_REPORT, inject: [MODULE_OPTIONS_TOKEN],
    useFactory: (o: AdminAnalyticsModuleOptions) => o.report },
  { provide: ADMINISTRATION_PRINCIPAL, inject: [MODULE_OPTIONS_TOKEN],
    useFactory: (o: AdminAnalyticsModuleOptions) => o.principal },
  { provide: 'ADMIN_ANALYTICS_PAGE_SIZE', inject: [MODULE_OPTIONS_TOKEN],
    useFactory: (o: AdminAnalyticsModuleOptions) => o.pageSize },
] })
export class AdminAnalyticsModule extends ConfigurableModuleClass {}
