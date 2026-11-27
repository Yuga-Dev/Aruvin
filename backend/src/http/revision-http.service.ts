/**
 * ============================================================================
 * FILE: revision-http.service.ts
 * LOCATION: backend/src/http/revision-http.service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Validate edit and regenerate requests and hand them to runtime.reviseTurn.
 *
 * ROLE IN PROJECT:
 *    Same admission envelope as retry (identity, epoch, calendar protocol, one active text turn); 202 SubmitTurnResponse.
 *
 * KEY COMPONENTS:
 *    - RevisionHttpService.edit/regenerate: strict body parse, then one shared revise().
 * ============================================================================
 */

import { editTurnRequestSchema, regenerateTurnRequestSchema, submitTurnResponseSchema } from '../contracts/api.js';
import type { ChatHttpOptions } from './options.js';
import { AppError } from '../platform/errors/app-error.js';
import { parseBody, pathId } from './validation.js';

export class RevisionHttpService {
  constructor(private readonly o: ChatHttpOptions) {}
  async edit(sessionId: string, turnId: string, raw: unknown) {
    return this.revise('edit', sessionId, turnId, parseBody(editTurnRequestSchema, raw, this.o.identity));
  }
  async regenerate(sessionId: string, turnId: string, raw: unknown) {
    return this.revise('regenerate', sessionId, turnId, parseBody(regenerateTurnRequestSchema, raw, this.o.identity));
  }
  private async revise(kind: 'edit' | 'regenerate', sessionId: string, turnId: string,
    body: { idempotencyKey: string; expectedEpoch?: string; calendarProtocol?: 2 | 3; content?: string }) {
    const identity = this.o.identity.resolve();
    if (this.o.currentConfig?.current()?.calendar?.enabled && body.calendarProtocol !== 2)
      throw new AppError('INVALID_REQUEST', 'Calendar stream support is required.', false);
    if (body.expectedEpoch !== undefined && this.o.runtime.processEpoch && body.expectedEpoch !== this.o.runtime.processEpoch())
      throw new AppError('INTERRUPTED', 'This request belongs to an earlier server session; its outcome is unknown.', false);
    if (!this.o.runtime?.reviseTurn) throw new AppError('NOT_READY', 'Editing is unavailable.');
    const userId = identity.userId;
    const session = this.o.runtime.memorySession?.(userId, pathId(sessionId)) ?? await this.o.sessions.get(userId, pathId(sessionId));
    if (!session || session.lifecycle !== 'active' || session.userId !== userId) throw new AppError('NOT_FOUND', 'Chat not found.');
    this.o.executionReservations?.assertText(userId, sessionId);
    const clientTimeZone = this.o.environment?.timeZone() ?? null;
    const requestGeo = this.o.environment?.geo() ?? null;
    return submitTurnResponseSchema.parse(await this.o.runtime.reviseTurn({
      ...body, kind, identity, sessionId: pathId(sessionId), turnId: pathId(turnId),
      ...(clientTimeZone ? { clientTimeZone } : {}), ...(requestGeo ? { requestGeo } : {}),
    }));
  }
}
