/**
 * ============================================================================
 * FILE: MessageRevisionControls.tsx
 * LOCATION: frontend/src/components/MessageRevisionControls.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Edit, regenerate and "Version n of m" controls for one message (Release 1).
 *
 * ROLE IN PROJECT:
 *    Plugged into MessageItem only through its actionsStart slot; reads chat state itself so the
 *    memoised MessageItem is not re-rendered by streaming. Off unless FEATURE_FLAGS.messageEdit.
 *
 * KEY COMPONENTS:
 *    - MessageRevisionControls: buttons, inline editor and version arrows.
 *    - useRevisionSlots: one stable element per displayed message.
 * ============================================================================
 */

import { useMemo, useState, type ReactNode } from 'react';
import type { VisibleMessage } from '../api/protocol.ts';
import { FEATURE_FLAGS } from '../app/feature-flags.ts';
import { useChat } from '../features/chat/state/chat-context.tsx';
import { selectVisibleMessages, versionInfo } from '../features/chat/state/chat-reducer.ts';
import { revisionActions } from '../features/chat/state/revision.ts';
import { MessageEditor } from './MessageEditor.tsx';

function MessageRevisionControls({ message }: { message: VisibleMessage }) {
  const { state, actions, dispatch } = useChat();
  const [editing, setEditing] = useState(false);
  const visible = useMemo(
    () => selectVisibleMessages(state.messages, state.revisionSelection, state.revisionSupersedes),
    [state.messages, state.revisionSelection, state.revisionSupersedes],
  );
  const busy = state.isStreaming || state.isSubmitting || state.turnStatus === 'submitting' ||
    state.turnStatus === 'accepted' || state.turnStatus === 'generating' || state.turnStatus === 'finalizing' ||
    state.voiceInput !== null;
  const { canEdit, canRegenerate } = revisionActions(visible, message, {
    enabled: FEATURE_FLAGS.messageEdit, busy, compactedThroughSequence: state.compaction?.compactedThroughSequence ?? null,
  });
  const info = versionInfo(state.messages, message.messageId);
  const select = (messageId: string | null) => {
    if (messageId && info) dispatch({ type: 'REVISION_SELECT', payload: { tipId: info.tipId, messageId } });
  };
  return (
    <>
      {info ? (
        <span className="aurvin-version-nav">
          <button type="button" className="aurvin-quiet-btn" aria-label="Previous version" disabled={!info.prevId} onClick={() => select(info.prevId)}>&lsaquo;</button>
          <span>Version {info.index} of {info.total}</span>
          <button type="button" className="aurvin-quiet-btn" aria-label="Next version" disabled={!info.nextId} onClick={() => select(info.nextId)}>&rsaquo;</button>
        </span>
      ) : null}
      {canRegenerate ? (
        <button type="button" className="aurvin-quiet-btn" onClick={() => { void actions.regenerateTurn(message.turnId, message.messageId); }}>
          Regenerate
        </button>
      ) : null}
      {canEdit && !editing ? (
        <button type="button" className="aurvin-quiet-btn" aria-label="Edit message" onClick={() => setEditing(true)}>Edit</button>
      ) : null}
      {canEdit && editing ? (
        <MessageEditor
          initial={message.content}
          onCancel={() => setEditing(false)}
          onSave={(text) => { setEditing(false); void actions.editTurn(message.turnId, message.messageId, text); }}
        />
      ) : null}
    </>
  );
}

/** One element per message id, rebuilt only when the displayed list changes (keeps MessageItem memoisation). */
// oxlint-disable-next-line react/only-export-components -- hook colocated with its component
export function useRevisionSlots(messages: readonly VisibleMessage[]): ReadonlyMap<string, ReactNode> {
  return useMemo(() => new Map<string, ReactNode>(FEATURE_FLAGS.messageEdit
    ? messages.map((m) => [m.messageId, <MessageRevisionControls key={m.messageId} message={m} />])
    : []), [messages]);
}
