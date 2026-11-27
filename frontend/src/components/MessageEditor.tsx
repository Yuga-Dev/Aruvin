/**
 * ============================================================================
 * FILE: MessageEditor.tsx
 * LOCATION: frontend/src/components/MessageEditor.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Inline editor for the latest user message (Release 1 edit).
 *
 * ROLE IN PROJECT:
 *    Rendered by MessageRevisionControls through MessageItem's action slot. Save sends a new
 *    turn; Cancel restores. It never talks to the API itself.
 *
 * KEY COMPONENTS:
 *    - canSaveEdit: Save is allowed only for non-empty, changed, in-bounds text.
 *    - MessageEditor: textarea with a character counter and Save / Cancel.
 * ============================================================================
 */

import { useState } from 'react';
import './MessageEditor.css';

export const MAX_EDIT_CHARS = 32_000;

export function canSaveEdit(original: string, draft: string, max = MAX_EDIT_CHARS): boolean {
  const text = draft.trim();
  return text.length > 0 && draft.length <= max && text !== original.trim();
}

export function MessageEditor({ initial, max = MAX_EDIT_CHARS, onSave, onCancel }: {
  initial: string;
  max?: number;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ok = canSaveEdit(initial, draft, max);
  return (
    <form
      className="aurvin-message-editor"
      onSubmit={(event) => { event.preventDefault(); if (ok) onSave(draft.trim()); }}
    >
      <textarea
        aria-label="Edit your message"
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}
      />
      <div className="aurvin-message-editor-row">
        <button type="submit" className="aurvin-quiet-btn" disabled={!ok}>Save</button>
        <button type="button" className="aurvin-quiet-btn" onClick={onCancel}>Cancel</button>
        <span className="aurvin-message-editor-count" data-over={draft.length > max} aria-live="polite">
          {draft.length}/{max}
        </span>
      </div>
    </form>
  );
}
