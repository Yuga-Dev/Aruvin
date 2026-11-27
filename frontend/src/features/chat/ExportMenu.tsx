/**
 * ============================================================================
 * FILE: ExportMenu.tsx
 * LOCATION: frontend/src/features/chat/ExportMenu.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Header "more" menu with Export as Markdown for the active saved chat.
 *
 * ROLE IN PROJECT:
 *    Release 1 export entry point, mounted in ChatView's header (flag-gated).
 *
 * KEY COMPONENTS:
 *    - ExportMenu: menu button, loading state, "Export failed. Try again." error.
 * ============================================================================
 */

import { useEffect, useRef, useState } from 'react';
import { useChat } from './state/chat-context.tsx';
import { exportChat } from './export-download.ts';

export function ExportMenu({ sessionId, title, empty }: { sessionId: string; title: string; empty: boolean }) {
  const { client } = useChat();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
      if (e.type === 'mousedown' && root.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return (
    <div className="aurvin-chat-menu" ref={root}>
      <button type="button" className="aurvin-canvas-header-btn" aria-haspopup="menu" aria-expanded={open}
        aria-label="Chat options" onClick={() => { setOpen(!open); setFailed(false); }}>
        <span aria-hidden="true">&#8943;</span>
      </button>
      {open ? (
        <div className="aurvin-chat-menu-panel" role="menu">
          <button type="button" role="menuitem" className="aurvin-chat-menu-item" disabled={empty || busy}
            onClick={() => {
              setBusy(true); setFailed(false);
              void exportChat({ client, sessionId, title }).then((ok) => {
                setBusy(false);
                if (ok) setOpen(false); else setFailed(true);
              });
            }}>
            {busy ? 'Exporting…' : 'Export as Markdown'}
          </button>
          {failed ? <p className="aurvin-chat-menu-error" role="alert">Export failed. Try again.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
