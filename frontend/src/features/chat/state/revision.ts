/**
 * ============================================================================
 * FILE: revision.ts
 * LOCATION: frontend/src/features/chat/state/revision.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Decide which edit and regenerate controls a message may show.
 *
 * ROLE IN PROJECT:
 *    Pure mirror of the server rules (latest turn only, idle, not live voice, not Canvas-only,
 *    not inside a summarised range) so the UI never offers what the server will refuse.
 *
 * KEY COMPONENTS:
 *    - revisionActions: canEdit / canRegenerate for one visible message.
 * ============================================================================
 */

import type { VisibleMessage } from '../../../api/protocol.ts';

export type RevisionActions = { canEdit: boolean; canRegenerate: boolean };
const NONE: RevisionActions = { canEdit: false, canRegenerate: false };

export function revisionActions(
  visible: readonly VisibleMessage[],
  message: VisibleMessage,
  opts: { enabled: boolean; busy: boolean; compactedThroughSequence: number | null },
): RevisionActions {
  if (!opts.enabled || opts.busy || message.mode === 'live' || message.visibility === 'internal') return NONE;
  if (opts.compactedThroughSequence !== null && message.sequence <= opts.compactedThroughSequence) return NONE;
  // Tool turns repeat or orphan an external effect; Canvas-only messages have nothing to edit or redo.
  if (message.calendarView || message.canvasArtifacts?.length) return NONE;
  const at = visible.findIndex((m) => m.messageId === message.messageId);
  if (at === -1) return NONE;
  const latestTurn = visible.at(-1)?.turnId;
  if (message.turnId !== latestTurn || message.messageId.startsWith('temp_')) return NONE;
  if (message.role === 'assistant') {
    const last = at === visible.length - 1;
    return { canEdit: false, canRegenerate: last && (message.completionStatus === 'completed' || message.completionStatus === 'truncated') };
  }
  // The latest turn's user message is the only user message of that turn.
  return { canEdit: !visible.slice(at + 1).some((m) => m.role === 'user'), canRegenerate: false };
}
