/**
 * ============================================================================
 * FILE: chat-http.service.ts
 * LOCATION: backend/src/http/chat-http.service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Project scoped session/message reads and delegate P5 chat commands.
 *
 * ROLE IN PROJECT:
 *    Keeps HTTP controllers thin: server identity, input bounds, and strict
 *    response schemas sit here while acceptance, retry, cancel, and status
 *    remain owned by the injected ChatRuntime.
 *
 * KEY COMPONENTS:
 *    - sessions/session/messages: Ownership-scoped archive projections.
 *    - submit/retry/cancel/status: Validated command and result mapping.
 * ============================================================================
 */

import { submitTurnRequestSchema, retryTurnRequestSchema, retrySaveRequestSchema, cancelTurnRequestSchema, submitTurnResponseSchema,
  sessionSummarySchema, listSessionsResponseSchema, listMessagesResponseSchema, hasCanvasContent,
  turnStatusResponseSchema, type VisibleMessage } from '../contracts/api.js';
import { AppError } from '../platform/errors/app-error.js';
import type { ChatHttpOptions } from './options.js';
import { parseBody, pageQuery, pathId, inputBounds, assertTemporaryCreation } from './validation.js';
import { errorBody } from './client-errors.js';
import { z } from 'zod';
const sessionUpdateSchema = z.object({ title: z.string().trim().min(1).max(80).optional(),
  pinned: z.boolean().optional() }).strict().refine(body => body.title !== undefined || body.pinned !== undefined);
export class ChatHttpService {
  constructor(readonly o: ChatHttpOptions) {}
  async sessions(query: unknown) {
    const identity = this.o.identity.resolve(), page = pageQuery(query, this.o.budgets);
    const userId = identity.userId;
    const durable = await this.o.sessions.list(userId, page);
    return listSessionsResponseSchema.parse(this.o.runtime.overlaySessions?.(userId, page, durable) ?? durable);
  }
  async session(id: string) {
    const identity = this.o.identity.resolve();
    const userId = identity.userId;
    const record = this.o.runtime.memorySession?.(userId, pathId(id)) ?? await this.o.sessions.get(userId,pathId(id));
    if (!record || record.lifecycle !== 'active' || record.userId !== userId || record.sessionId !== id)
      throw new AppError('NOT_FOUND','Chat not found.');
    return sessionSummarySchema.parse({ sessionId:record.sessionId, title:record.title,
      createdAt:record.createdAt,lastActivityAt:record.lastActivityAt, ...(record.pinned !== undefined ? { pinned:record.pinned } : {}),
      ...(record.ephemeral === true ? { ephemeral: true } : {}) });
  }
  async updateSession(id: string, raw: unknown) {
    const identity = this.o.identity.resolve();
    const changes = parseBody(sessionUpdateSchema,raw,this.o.identity);
    this.o.runtime.assertSessionMutation?.(identity.userId, pathId(id));
    await this.o.sessions.update(identity.userId,pathId(id),changes);
    return this.session(id);
  }
  async deleteSession(id: string) {
    const u = this.o.identity.resolve().userId;
    const s = pathId(id);
    const session = this.o.runtime.memorySession?.(u, s) ?? await this.o.sessions.get(u, s);
    if (session?.userId === u && session.sessionId === s && session.ephemeral === true) {
      const purge = this.o.sessions.hardPurgeSession;
      if (!purge) throw new AppError('NOT_READY', 'Temporary chat deletion is unavailable.');
      await purge.call(this.o.sessions, u, s);
      return;
    }
    this.o.runtime.assertSessionMutation?.(u, s);
    await this.o.sessions.delete(u, s);
  }
  async messages(id: string, query: unknown) {
    const identity = this.o.identity.resolve();
    const page = pageQuery(query,this.o.budgets), userId = identity.userId;
    pathId(id);
    // Selection prewarms inference history. Recovery/capacity failures must not
    // hide the read-only archive; its existing scoped checks still run below.
    try { await this.o.runtime.prepareSession?.(userId, id); }
    catch { /* Preparation is best-effort; archive access remains independent. */ }
    // Web preparation is control-plane only: selected history, never a turn.
    try { await this.o.prepareWeb?.(userId); }
    catch { /* Web preparation is best-effort; chat remains memory-first. */ }
    const memory = this.o.runtime.memoryMessages?.(userId, id, page);
    if (memory) return listMessagesResponseSchema.parse(memory);
    const session = await this.o.sessions.get(userId, id);
    if (!session || session.userId !== userId || session.sessionId !== id || session.lifecycle !== 'active')
      throw new AppError('NOT_FOUND', 'Chat not found.');
    const publishedSequence = session.memoryPublication
      ? session.memoryPublication.version === 0 ? -1 : session.memoryPublication.sequence
      : undefined;
    const listPage = (cursor: string | null, limit: number) => publishedSequence !== undefined
      ? (() => {
          if (!this.o.messages.listPublished) throw new AppError('NOT_READY', 'Saved history is unavailable.');
          return this.o.messages.listPublished(userId, id, { cursor, limit }, publishedSequence);
        })()
      : this.o.messages.list(userId, id, { cursor, limit });
    const listed = await listPage(page.cursor, page.limit);
    // One bounded older walk only on the initial transcript page so compacted
    // Canvas artifacts remain available without changing routine poll counts.
    let canvasMessages: VisibleMessage[] | undefined;
    if (page.cursor === null && page.limit > 1 && listed.olderAvailable && listed.nextCursor) {
      const limit = this.o.budgets.maxPageSize;
      const oldest = listed.items[0]?.sequence ?? Number.POSITIVE_INFINITY;
      const found = new Map<string, VisibleMessage>();
      let canvasCursor: string | null = listed.nextCursor;
      for (let pages = 0; pages < 10 && canvasCursor; pages++) {
        const older = await listPage(canvasCursor, limit);
        for (const message of older.items) {
          if (message.sequence < oldest && hasCanvasContent(message)) found.set(message.messageId, message);
        }
        if (found.size >= 500 || !older.olderAvailable || !older.nextCursor || older.items.length === 0
          || older.nextCursor === canvasCursor) break;
        canvasCursor = older.nextCursor;
      }
      const archived = [...found.values()].sort((a, b) => a.sequence - b.sequence).slice(-limit);
      if (archived.length) canvasMessages = archived;
    }
    const activeTurn = session.execution?.activeAttemptId && this.o.runtime.activeSessionTurn
      ? await this.o.runtime.activeSessionTurn(userId, id)
      : null;
    const extra = (this.o.runtime as { compactionState?: (u: string, s: string) => {
      compaction?: { compactedThroughSequence: number; compactionCycle: number; summaryPreview?: string };
      contextUsage?: unknown;
    } | null }).compactionState?.(userId, id);
    const checkpoint = extra?.compaction ?? (session.compactionCheckpoint
      ? { compactedThroughSequence: session.compactionCheckpoint.compactedThroughSequence,
          compactionCycle: session.compactionCheckpoint.compactionCycle,
          ...(session.compactionCheckpoint.summaryPreview !== undefined
            ? { summaryPreview: session.compactionCheckpoint.summaryPreview } : {}) }
      : undefined);
    return listMessagesResponseSchema.parse({
      ...listed,
      ...(canvasMessages ? { canvasMessages } : {}),
      ...(activeTurn ? { activeTurn } : {}),
      ...(checkpoint ? { compaction: checkpoint } : {}),
      ...(extra?.contextUsage ? { contextUsage: extra.contextUsage } : {}),
    });
  }
  async submit(sessionId: string | null, raw: unknown) {
    const identity = this.o.identity.resolve();
    this.o.identity.assertNoClientOverrides(raw);
    if (raw && typeof raw === 'object' && 'content' in raw && typeof raw.content === 'string') inputBounds(raw.content, { ...this.o.budgets, maxInputChars: 32000 });
    const body = parseBody(submitTurnRequestSchema,raw,this.o.identity);
    if (this.o.currentConfig?.current()?.calendar?.enabled && body.calendarProtocol !== 2) {
      throw new AppError('INVALID_REQUEST', 'Calendar stream support is required.', false);
    }
    if (body.sessionId !== sessionId) throw new AppError('INVALID_REQUEST','Body and route disagree.');
    assertTemporaryCreation(body.sessionId, body.ephemeral);
    if (sessionId !== null) pathId(sessionId);
    if (sessionId !== null) this.o.executionReservations?.assertText(identity.userId, sessionId);
    const clientTimeZone = this.o.environment?.timeZone() ?? null;
    const requestGeo = this.o.environment?.geo() ?? null;
    return submitTurnResponseSchema.parse(await this.o.runtime.submitTurn({
      ...body,
      identity,
      ...(clientTimeZone ? { clientTimeZone } : {}),
      ...(requestGeo ? { requestGeo } : {}),
    }));
  }
  async streamStatus(sessionId: string, turnId: string) {
    const identity = this.o.identity.resolve();
    const userId = identity.userId;
    const s = pathId(sessionId);
    const t = pathId(turnId);
    const hot = this.o.runtime.getStreamAttempt ? await this.o.runtime.getStreamAttempt(userId, s, t) : null;
    if (hot) {
      return turnStatusResponseSchema.parse({
        ...hot,
        error: hot.error ? errorBody(hot.error.code, hot.error.retryable) : null,
      });
    }
    await this.session(sessionId);
    const status = await this.o.runtime.getTurnStatus(userId, s, t);
    return turnStatusResponseSchema.parse({
      ...status,
      error: status.error ? errorBody(status.error.code, status.error.retryable) : null,
    });
  }
  async status(sessionId: string, turnId: string) {
    const identity = this.o.identity.resolve();
    await this.session(sessionId);
    const status = await this.o.runtime.getTurnStatus(identity.userId,pathId(sessionId),pathId(turnId));
    const calendar = await this.o.runtime.getCalendarTurnState?.(
      identity.userId, pathId(sessionId), pathId(turnId),
    );
    return turnStatusResponseSchema.parse({
      ...status,
      error: status.error ? errorBody(status.error.code, status.error.retryable) : null,
      ...(calendar ? { calendar } : {}),
    });
  }
  async retry(sessionId: string, turnId: string, raw: unknown) {
    const identity = this.o.identity.resolve();
    const body = parseBody(retryTurnRequestSchema,raw,this.o.identity);
    if (this.o.currentConfig?.current()?.calendar?.enabled && body.calendarProtocol !== 2) {
      throw new AppError('INVALID_REQUEST', 'Calendar stream support is required.', false);
    }
    if (body.expectedEpoch !== undefined && this.o.runtime.processEpoch && body.expectedEpoch !== this.o.runtime.processEpoch()) {
      throw new AppError('INTERRUPTED', 'This request belongs to an earlier server session; its outcome is unknown.', false);
    }
    await this.session(sessionId);
    this.o.executionReservations?.assertText(identity.userId, sessionId);
    const clientTimeZone = this.o.environment?.timeZone() ?? null;
    const requestGeo = this.o.environment?.geo() ?? null;
    return submitTurnResponseSchema.parse(await this.o.runtime.retryTurn({
      ...body,
      identity,
      sessionId: pathId(sessionId),
      turnId: pathId(turnId),
      ...(clientTimeZone ? { clientTimeZone } : {}),
      ...(requestGeo ? { requestGeo } : {}),
    }));
  }
  async retrySave(sessionId: string, turnId: string, raw: unknown) {
    const identity = this.o.identity.resolve();
    const body = parseBody(retrySaveRequestSchema, raw, this.o.identity);
    if (!this.o.runtime.retrySave) throw new AppError('NOT_READY', 'Saving is unavailable.');
    return turnStatusResponseSchema.parse(await this.o.runtime.retrySave(identity.userId,
      pathId(sessionId), pathId(turnId), body));
  }
  async cancel(sessionId: string, turnId: string, raw: unknown) {
    const identity = this.o.identity.resolve();
    const body = parseBody(cancelTurnRequestSchema,raw,this.o.identity); await this.session(sessionId);
    await this.o.runtime.cancelTurn({ ...body,identity,sessionId:pathId(sessionId),turnId:pathId(turnId) });
  }
}
