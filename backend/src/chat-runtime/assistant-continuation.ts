/**
 * ============================================================================
 * FILE: assistant-continuation.ts
 * LOCATION: backend/src/chat-runtime/assistant-continuation.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Insert a paragraph break between pre-tool narration and the next answer.
 *
 * ROLE IN PROJECT:
 *    Tool rounds concatenate streamed text without a separator, which glues
 *    "Let me look that up." onto "Here is…". Shared by CalendarLoop and the
 *    web-only MemoryText path so both persist and render a blank line.
 *
 * KEY COMPONENTS:
 *    - separateAssistantContinuation: Prefix \n\n when neither side has one.
 * ============================================================================
 */

export function separateAssistantContinuation(prior: string, next: string): string {
  if (!prior || !next) return next;
  if (/\n[ \t]*$/.test(prior) || /^\s/.test(next)) return next;
  return `\n\n${next}`;
}
