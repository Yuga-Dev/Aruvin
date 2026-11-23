/**
 * ============================================================================
 * FILE: personalization.controller.ts
 * LOCATION: backend/src/personalization/personalization.controller.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose GET/PUT /api/personalization and POST /api/personalization/reset.
 *
 * ROLE IN PROJECT:
 *    Routes authenticated user requests to PersonalizationService using the
 *    server-resolved identity without trusting client-supplied user identifiers.
 *
 * KEY COMPONENTS:
 *    - PersonalizationController: Thin Nest controller with query enforcement.
 *    - PersonalizationFilter: Maps faults to closed PersonalizationErrorBody.
 * ============================================================================
 */

import {
  Body,
  Catch,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
  Query,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthFault } from '../auth/errors.js';
import type {
  PersonalizationResponse,
  ReverseGeocodeResponse,
} from '../contracts/personalization.js';
import { PersonalizationFault } from './errors.js';
import { PersonalizationService } from './personalization.service.js';

export const PERSONALIZATION_USER_ID = Symbol('PERSONALIZATION_USER_ID');

@Catch()
class PersonalizationFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) {
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (error instanceof AuthFault) {
      res.status(error.status).json(error.body());
      return;
    }
    const fault =
      error instanceof PersonalizationFault
        ? error
        : new PersonalizationFault('PERSISTENCE_ERROR');
    res.status(fault.status).json(fault.body());
  }
}

@Controller('personalization')
@UseFilters(PersonalizationFilter)
export class PersonalizationController {
  constructor(
    @Inject(PersonalizationService) private readonly service: PersonalizationService,
    @Inject(PERSONALIZATION_USER_ID) private readonly resolveUserId: () => string,
  ) {}

  @Get()
  get(@Query() query: unknown): Promise<PersonalizationResponse> {
    rejectQuery(query);
    return this.service.read(this.resolveUserId());
  }

  @Put()
  put(@Body() body: unknown, @Query() query: unknown): Promise<PersonalizationResponse> {
    rejectQuery(query);
    return this.service.save(body, this.resolveUserId());
  }

  @Post('reset')
  @HttpCode(200)
  reset(@Body() body: unknown, @Query() query: unknown): Promise<PersonalizationResponse> {
    rejectQuery(query);
    return this.service.reset(body, this.resolveUserId());
  }

  @Post('reverse-geocode')
  @HttpCode(200)
  reverseGeocode(
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<ReverseGeocodeResponse> {
    rejectQuery(query);
    this.resolveUserId();
    return this.service.reverseGeocode(body);
  }
}

function rejectQuery(query: unknown): void {
  if (
    query !== undefined &&
    query !== null &&
    typeof query === 'object' &&
    Object.keys(query as object).length > 0
  ) {
    throw new PersonalizationFault('INVALID_REQUEST');
  }
}
