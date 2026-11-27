/**
 * ============================================================================
 * FILE: export-http.service.ts
 * LOCATION: backend/src/http/export-http.service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Serve an owned, non-temporary chat as Markdown.
 *
 * ROLE IN PROJECT:
 *    Release 1 unit C. A separate read route; never touches chat admission.
 *    Reads unsaved messages from runtime memory like the messages route.
 *
 * KEY COMPONENTS:
 *    - ExportHttpService.export: bounded paged walk (2000 messages) then exportMarkdown.
 * ============================================================================
 */

import type { ListMessagesResponse, VisibleMessage } from '../contracts/api.js';
import { AppError } from '../platform/errors/app-error.js';
import { exportFilename, exportMarkdown } from './export-markdown.js';
import type { ChatHttpOptions } from './options.js';

export const EXPORT_MAX_MESSAGES = 2000;

export class ExportHttpService {
  constructor(readonly _o: ChatHttpOptions) {}
  async export(sessionId: string): Promise<{ markdown: string; filename: string }> {
    const o = this._o;
    const userId = o.identity.resolve().userId;
    const session = o.runtime.memorySession?.(userId, sessionId) ?? await o.sessions.get(userId, sessionId);
    if (!session || session.userId !== userId || session.sessionId !== sessionId
      || session.lifecycle !== 'active' || session.ephemeral === true) throw new AppError('NOT_FOUND', 'Chat not found.');
    const limit = o.budgets.maxPageSize;
    const published = session.memoryPublication
      ? session.memoryPublication.version === 0 ? -1 : session.memoryPublication.sequence : undefined;
    const collected: VisibleMessage[] = [];
    let cursor: string | null = null;
    let olderOmitted = false;
    for (;;) {
      const page = { cursor, limit };
      const res: ListMessagesResponse = o.runtime.memoryMessages?.(userId, sessionId, page)
        ?? (published !== undefined && o.messages.listPublished
          ? await o.messages.listPublished(userId, sessionId, page, published)
          : await o.messages.list(userId, sessionId, page));
      collected.unshift(...res.items);
      if (!res.olderAvailable || !res.nextCursor || res.nextCursor === cursor || res.items.length === 0) break;
      if (collected.length >= EXPORT_MAX_MESSAGES) { olderOmitted = true; break; }
      cursor = res.nextCursor;
    }
    const now = new Date();
    return {
      markdown: exportMarkdown({ title: session.title, messages: collected, now, olderOmitted }),
      filename: exportFilename(session.title, now),
    };
  }
}
