/**
 * ============================================================================
 * FILE: copy-text.ts
 * LOCATION: frontend/src/features/chat/markdown/copy-text.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Shared clipboard helper for message and code-block copy buttons.
 *
 * ROLE IN PROJECT:
 *    Lives beside the renderer so SafeMarkdown can copy code without importing
 *    MessageItem (which imports SafeMarkdown). MessageItem re-exports it.
 *
 * KEY COMPONENTS:
 *    - copyTextToClipboard: true when the Clipboard API accepted the text.
 * ============================================================================
 */

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API unavailable in non-secure or headless context
  }
  return false;
}
