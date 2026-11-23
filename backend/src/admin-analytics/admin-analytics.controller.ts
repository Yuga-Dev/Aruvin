/**
 * ============================================================================
 * FILE: admin-analytics.controller.ts
 * LOCATION: backend/src/admin-analytics/admin-analytics.controller.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose GET /api/admin/analytics: super-admin-only accounting totals.
 *
 * ROLE IN PROJECT:
 *    Thin HTTP edge over the existing bounded read-only accounting reporting
 *    port. Validates the query, re-checks the super-admin role, and maps
 *    failures to the closed auth/admin error body. No aggregation lives here.
 *
 * KEY COMPONENTS:
 *    - AdminAnalyticsController: One GET route; ADMIN_ANALYTICS_REPORT port.
 *    - parseAnalyticsQuery: Strict wire query to AccountingQuery.
 * ============================================================================
 */
import { Catch, Controller, Get, Inject, Query, UseFilters,
  type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { requireSuperAdmin } from '../auth/access.js';
import { AuthFault } from '../auth/errors.js';
import { ADMINISTRATION_PRINCIPAL } from '../administration/administration.controller.js';
import { safeAdministrationFault } from '../administration/errors.js';
import { accountingQuerySchema, type AccountingQuery, type AccountingTotals } from '../contracts/accounting-reporting.js';
import type { AuthPrincipal } from '../contracts/auth.js';
import { AppError } from '../platform/errors/app-error.js';

export const ADMIN_ANALYTICS_REPORT = Symbol('ADMIN_ANALYTICS_REPORT');
export type AdminAnalyticsReport = (query: AccountingQuery) =>
  Promise<{ items: AccountingTotals[]; nextCursor: string | null }>;

const wireQuery = z.object({ start: z.string(), end: z.string(),
  byUser: z.enum(['true', 'false']).optional(), cursor: z.string().optional() }).strict();

/** Fixed page size keeps the report within the persistence page budget (<= 50). */
export function parseAnalyticsQuery(raw: unknown, pageSize: number): AccountingQuery {
  const wire = wireQuery.safeParse(raw);
  if (!wire.success) throw new AuthFault('INVALID_REQUEST');
  const { start, end, byUser, cursor } = wire.data;
  const parsed = accountingQuerySchema.safeParse({ start, end, limit: pageSize,
    ...(byUser === 'true' ? { byUser: true } : {}), ...(cursor ? { cursor } : {}) });
  if (!parsed.success) throw new AuthFault('INVALID_REQUEST');
  return parsed.data;
}

@Catch()
class AdminAnalyticsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent || res.writableEnded) return;
    // A range with too many records is the caller's to narrow, not a server fault.
    const fault = error instanceof AppError && error.code === 'STORAGE_BUDGET_EXCEEDED'
      ? new AuthFault('INVALID_REQUEST') : safeAdministrationFault(error);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(fault.status).json(fault.body());
  }
}

@Controller('admin/analytics')
@UseFilters(AdminAnalyticsFilter)
export class AdminAnalyticsController {
  constructor(@Inject(ADMIN_ANALYTICS_REPORT) private readonly report: AdminAnalyticsReport,
    @Inject(ADMINISTRATION_PRINCIPAL) private readonly principal: () => AuthPrincipal | null,
    @Inject('ADMIN_ANALYTICS_PAGE_SIZE') private readonly pageSize: number) {}
  @Get()
  async get(@Query() query: unknown) {
    const principal = this.principal();
    if (!principal) throw new AuthFault('UNAUTHENTICATED');
    requireSuperAdmin(principal);
    const result = await this.report(parseAnalyticsQuery(query, this.pageSize));
    return { items: result.items, nextCursor: result.nextCursor };
  }
}
