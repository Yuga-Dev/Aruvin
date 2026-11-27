/**
 * ============================================================================
 * FILE: memory-state.ts
 * LOCATION: frontend/src/features/memory/memory-state.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Pure helpers for section editing and change history in the Memory view.
 *
 * ROLE IN PROJECT:
 *    Client-side mirror of the server's section validation (bounds, control
 *    characters, secrets, rendered cap) so the editor can warn before sending;
 *    the server stays authoritative. Also formats history rows and detects
 *    missing revisions. Server memory state reuses userMemoryReducer.
 *
 * KEY COMPONENTS:
 *    - sectionDraftError / sectionUsage: draft validation and total counter
 *    - historyHasGap: contiguous-revision check (never timestamps alone)
 *    - describeHistoryEntry: counts-only row text
 *    - newRequestId: idempotency key for one section change
 * ============================================================================
 */

import { FEATURE_FLAGS } from '../../app/feature-flags.ts';
import {
  hasDisallowedControlChars,
  hasSecretPattern,
  normalizeCustomInstructions,
  utf8ByteLength,
} from '../../api/personalization-protocol.ts';
import {
  renderUserMemorySections,
  USER_MEMORY_MAX_BYTES,
  USER_MEMORY_MAX_CHARS,
  USER_MEMORY_SECTION_LABELS,
  userMemoryCharCount,
  type MemoryAuditView,
  type UserMemorySectionKey,
  type UserMemorySections,
} from '../../api/user-memory-protocol.ts';

/** Sections as they would be stored if `draft` replaced `key` (normalized). */
function withDraft(sections: UserMemorySections, key: UserMemorySectionKey, draft: string) {
  return { ...sections, [key]: normalizeCustomInstructions(draft) };
}

/** Rendered total characters after the edit, against the shared memory cap. */
export function sectionUsage(
  sections: UserMemorySections,
  key: UserMemorySectionKey,
  draft: string,
): { used: number; max: number } {
  return {
    used: userMemoryCharCount(renderUserMemorySections(withDraft(sections, key, draft))),
    max: USER_MEMORY_MAX_CHARS,
  };
}

export function sectionDraftError(
  sections: UserMemorySections,
  key: UserMemorySectionKey,
  draft: string,
): string | null {
  if (hasDisallowedControlChars(draft)) return 'Memory cannot contain unsupported control characters.';
  if (hasSecretPattern(draft)) return 'Memory cannot contain API keys, tokens, or connection strings.';
  const rendered = renderUserMemorySections(withDraft(sections, key, draft));
  if (
    userMemoryCharCount(rendered) > USER_MEMORY_MAX_CHARS ||
    utf8ByteLength(rendered) > USER_MEMORY_MAX_BYTES
  ) {
    return `Memory would be over its ${USER_MEMORY_MAX_CHARS}-character limit. Shorten this section.`;
  }
  return null;
}

/** True when the draft (normalized) differs from the saved section text. */
export function sectionDraftChanged(
  sections: UserMemorySections,
  key: UserMemorySectionKey,
  draft: string,
): boolean {
  return normalizeCustomInstructions(draft) !== sections[key];
}

export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/** Items are newest first by memoryRevision; a jump of more than 1 is a gap. */
export function historyHasGap(items: readonly MemoryAuditView[]): boolean {
  for (let i = 1; i < items.length; i += 1) {
    const prev = items[i - 1]!;
    const next = items[i]!;
    if (prev.memoryRevision - next.memoryRevision > 1) return true;
  }
  return false;
}

const ACTION_LABELS: Record<MemoryAuditView['action'], string> = {
  'edit-section': 'Section edited',
  'clear-section': 'Section cleared',
  'clear-all': 'Memory cleared',
  enable: 'Memory turned on',
  disable: 'Memory paused',
  instruction: 'Updated by instruction',
  tool: 'Saved by Aurvin',
  passive: 'Learned from chat',
};

const SOURCE_LABELS: Record<MemoryAuditView['source'], string> = {
  'user-ui': 'You',
  composer: 'You (instruction)',
  tool: 'Aurvin',
  passive: 'Aurvin',
};

export function describeHistoryEntry(entry: MemoryAuditView): {
  title: string;
  source: string;
  sections: string;
  size: string;
} {
  const delta = entry.charsAfter - entry.charsBefore;
  return {
    title: ACTION_LABELS[entry.action],
    source: SOURCE_LABELS[entry.source],
    sections: entry.sections.map(k => USER_MEMORY_SECTION_LABELS[k]).join(', '),
    size: `${entry.charsBefore} to ${entry.charsAfter} characters (${delta >= 0 ? '+' : ''}${delta})`,
  };
}

/** Memory view ships dark: Personalization keeps the old MemoryCard until the flag is on. */
export function memoryViewEnabled(flags: { memory: boolean } = FEATURE_FLAGS): boolean {
  return flags.memory;
}
