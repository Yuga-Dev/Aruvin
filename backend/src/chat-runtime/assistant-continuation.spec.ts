/**
 * ============================================================================
 * FILE: assistant-continuation.spec.ts
 * LOCATION: backend/src/chat-runtime/assistant-continuation.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify paragraph breaks between pre-tool narration and the next answer.
 *
 * ROLE IN PROJECT:
 *    Guards the shared continuation helper used by CalendarLoop and MemoryText.
 *
 * KEY COMPONENTS:
 *    - Glue vs already-separated cases for streamed tool-round text.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { separateAssistantContinuation } from './assistant-continuation.js';

describe('separateAssistantContinuation', () => {
  it('inserts a blank line when the model glued the next sentence onto the preamble', () => {
    expect(separateAssistantContinuation(
      'Let me look up the NRSV text for 1 Peter 3:5.',
      'Here is 1 Peter 3:5 from the NRSV.',
    )).toBe('\n\nHere is 1 Peter 3:5 from the NRSV.');
  });

  it('leaves already-separated or empty sides unchanged', () => {
    expect(separateAssistantContinuation('Preamble.\n', 'Here is the verse.')).toBe('Here is the verse.');
    expect(separateAssistantContinuation('Preamble.\n\n', 'Here is the verse.')).toBe('Here is the verse.');
    expect(separateAssistantContinuation('Preamble.', '\nHere is the verse.')).toBe('\nHere is the verse.');
    expect(separateAssistantContinuation('Preamble.', ' Here is the verse.')).toBe(' Here is the verse.');
    expect(separateAssistantContinuation('', 'Here is the verse.')).toBe('Here is the verse.');
    expect(separateAssistantContinuation('Preamble.', '')).toBe('');
  });
});
