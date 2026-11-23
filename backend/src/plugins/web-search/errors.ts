/**
 * ============================================================================
 * FILE: errors.ts
 * LOCATION: backend/src/plugins/web-search/errors.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define the two closed web-search fault classes.
 *
 * ROLE IN PROJECT:
 *    Separates HTTP setup faults from tool-path faults so URL/provider failures
 *    cannot be mistaken for control-plane errors or serialize raw causes.
 *
 * KEY COMPONENTS:
 *    - WebSearchFault: Closed HTTP error code plus optional current revision.
 *    - WebToolFault: Closed model-facing tool error code.
 * ============================================================================
 */

import type { WebSearchHttpErrorCode, WebToolErrorCode } from '../../contracts/web-search-wire.js';

export class WebSearchFault extends Error {
  constructor(readonly code: WebSearchHttpErrorCode, readonly currentRevision: number | null = null) {
    super(code);
    this.name = 'WebSearchFault';
  }
}

export class WebToolFault extends Error {
  constructor(readonly toolCode: WebToolErrorCode) {
    super(toolCode);
    this.name = 'WebToolFault';
  }
}
