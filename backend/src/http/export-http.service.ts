/**
 * ============================================================================
 * FILE: export-http.service.ts
 * LOCATION: backend/src/http/export-http.service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Serve a session as Markdown (Release 1 unit 0 stub).
 *
 * ROLE IN PROJECT:
 *    Unit C implements the body with export-markdown.ts; until then it refuses.
 *
 * KEY COMPONENTS:
 *    - ExportHttpService.export: refuses with NOT_FOUND.
 * ============================================================================
 */

import type { ChatHttpOptions } from './options.js';
import { AppError } from '../platform/errors/app-error.js';

export class ExportHttpService {
  constructor(readonly _o: ChatHttpOptions) {}
  async export(_sessionId: string): Promise<never> {
    throw new AppError('NOT_FOUND', 'Not available.', false);
  }
}
