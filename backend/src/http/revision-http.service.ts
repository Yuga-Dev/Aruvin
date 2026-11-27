/**
 * ============================================================================
 * FILE: revision-http.service.ts
 * LOCATION: backend/src/http/revision-http.service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate edit and regenerate requests (Release 1 unit 0 stub).
 *
 * ROLE IN PROJECT:
 *    Unit B replaces the rejection with runtime.revise(...); the validation order here is already final.
 *
 * KEY COMPONENTS:
 *    - RevisionHttpService.edit/regenerate: strict body parse, then NOT_FOUND until implemented.
 * ============================================================================
 */

import { editTurnRequestSchema, regenerateTurnRequestSchema } from '../contracts/api.js';
import type { ChatHttpOptions } from './options.js';
import { AppError } from '../platform/errors/app-error.js';
import { parseBody } from './validation.js';

export class RevisionHttpService {
  constructor(private readonly o: ChatHttpOptions) {}
  async edit(_sessionId: string, _turnId: string, raw: unknown): Promise<never> {
    parseBody(editTurnRequestSchema, raw, this.o.identity);
    throw new AppError('NOT_FOUND', 'Not available.', false);
  }
  async regenerate(_sessionId: string, _turnId: string, raw: unknown): Promise<never> {
    parseBody(regenerateTurnRequestSchema, raw, this.o.identity);
    throw new AppError('NOT_FOUND', 'Not available.', false);
  }
}
