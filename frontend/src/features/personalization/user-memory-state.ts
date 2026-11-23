/**
 * ============================================================================
 * FILE: user-memory-state.ts
 * LOCATION: frontend/src/features/personalization/user-memory-state.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Pure reducer and selectors for the independent Personalization MemoryCard.
 *
 * ROLE IN PROJECT:
 *    Owns memory revision CAS, enabled toggle, categorized read-only summary,
 *    char budget meter, and composer state strictly isolated from Tone, Custom
 *    Instructions, and Location form drafts.
 *
 * KEY COMPONENTS:
 *    - userMemoryReducer / initialUserMemoryState
 *    - nonEmptyMemorySections / memoryBudgetStatus / clientComposerValidationError
 *    - canSubmitMemoryEdit / canClearMemory / formatMemoryApplyStatus
 * ============================================================================
 */

import {
  cloneUserMemorySections,
  emptyUserMemorySections,
  USER_MEMORY_INSTRUCTION_MAX_CHARS,
  USER_MEMORY_MAX_CHARS,
  USER_MEMORY_SECTION_KEYS,
  USER_MEMORY_SECTION_LABELS,
  validateMemoryInstruction,
  type UserMemoryEditResponse,
  type UserMemoryErrorCode,
  type UserMemoryResponse,
  type UserMemorySectionKey,
  type UserMemorySections,
} from '../../api/user-memory-protocol.ts';

export type UserMemoryPhase = 'loading' | 'ready' | 'unavailable';
export type UserMemoryBusy = 'toggling' | 'editing' | 'clearing' | null;

export type UserMemoryState = {
  phase: UserMemoryPhase;
  revision: number;
  enabled: boolean;
  sections: UserMemorySections;
  isEmpty: boolean;
  charCount: number;
  maxChars: number;
  updatedAt: string | null;
  composerDraft: string;
  busy: UserMemoryBusy;
  conflictRevision: number | null;
  statusMessage: string | null;
  errorMessage: string | null;
};

export type UserMemoryAction =
  | { type: 'loading' }
  | { type: 'loaded'; response: UserMemoryResponse; statusMessage?: string | null }
  | { type: 'editSucceeded'; response: UserMemoryEditResponse }
  | { type: 'loadFailed'; message: string }
  | { type: 'setComposerDraft'; value: string }
  | { type: 'begin'; kind: Exclude<UserMemoryBusy, null> }
  | {
      type: 'failed';
      code?: UserMemoryErrorCode | string;
      message: string;
      currentRevision?: number | null;
    };

export type RenderedMemorySection = {
  key: UserMemorySectionKey;
  label: string;
  text: string;
};

export type MemoryBudgetStatus = {
  percent: number;
  level: 'normal' | 'near' | 'full';
  label: string;
};

export function initialUserMemoryState(): UserMemoryState {
  return {
    phase: 'loading',
    revision: 0,
    enabled: true,
    sections: emptyUserMemorySections(),
    isEmpty: true,
    charCount: 0,
    maxChars: USER_MEMORY_MAX_CHARS,
    updatedAt: null,
    composerDraft: '',
    busy: null,
    conflictRevision: null,
    statusMessage: null,
    errorMessage: null,
  };
}

export function nonEmptyMemorySections(sections: UserMemorySections): RenderedMemorySection[] {
  const result: RenderedMemorySection[] = [];
  for (const key of USER_MEMORY_SECTION_KEYS) {
    const text = sections[key];
    if (text !== '') {
      result.push({ key, label: USER_MEMORY_SECTION_LABELS[key], text });
    }
  }
  return result;
}

export function memoryBudgetStatus(charCount: number, maxChars: number): MemoryBudgetStatus {
  const safeMax = maxChars > 0 ? maxChars : USER_MEMORY_MAX_CHARS;
  const clamped = Math.max(0, Math.min(charCount, safeMax));
  const percent = Math.round((clamped / safeMax) * 100);
  const level: MemoryBudgetStatus['level'] =
    clamped >= safeMax ? 'full' : percent >= 85 ? 'near' : 'normal';
  return { percent, level, label: `${charCount} / ${safeMax} chars` };
}

export function clientComposerValidationError(draft: string): string | null {
  if (draft.trim().length === 0) return null;
  const checked = validateMemoryInstruction(draft);
  if (checked.error === 'disallowed_characters') {
    return 'Memory updates cannot contain unsupported control characters.';
  }
  if (checked.error === 'secret_pattern') {
    return 'Memory updates cannot contain API keys, tokens, or connection strings.';
  }
  if (checked.error === 'out_of_range') {
    return `Memory updates must be ${USER_MEMORY_INSTRUCTION_MAX_CHARS} characters or fewer.`;
  }
  return null;
}

export function canSubmitMemoryEdit(state: UserMemoryState): boolean {
  if (state.phase !== 'ready' || state.busy !== null || state.conflictRevision !== null) {
    return false;
  }
  return validateMemoryInstruction(state.composerDraft).error === null;
}

export function canClearMemory(state: UserMemoryState): boolean {
  return (
    state.phase === 'ready' &&
    !state.isEmpty &&
    state.busy === null &&
    state.conflictRevision === null
  );
}

export function formatMemoryApplyStatus(changeSummary: string): string {
  const summary = changeSummary.trim();
  if (summary.length === 0) return 'Memory checked — no changes needed.';
  return `${summary} — applies to new chats.`;
}

function applyResponse(
  state: UserMemoryState,
  response: UserMemoryResponse,
  options: { statusMessage: string | null; clearDraft: boolean },
): UserMemoryState {
  return {
    phase: 'ready',
    revision: response.revision,
    enabled: response.enabled,
    sections: cloneUserMemorySections(response.sections),
    isEmpty: response.isEmpty,
    charCount: response.charCount,
    maxChars: response.maxChars,
    updatedAt: response.updatedAt,
    composerDraft: options.clearDraft ? '' : state.composerDraft,
    busy: null,
    conflictRevision: null,
    statusMessage: options.statusMessage,
    errorMessage: null,
  };
}

export function userMemoryReducer(
  state: UserMemoryState,
  action: UserMemoryAction,
): UserMemoryState {
  switch (action.type) {
    case 'loading':
      return {
        ...state,
        phase: 'loading',
        busy: null,
        conflictRevision: null,
        errorMessage: null,
      };
    case 'loaded':
      return applyResponse(state, action.response, {
        statusMessage: action.statusMessage ?? null,
        clearDraft: false,
      });
    case 'editSucceeded':
      return applyResponse(state, action.response, {
        statusMessage: formatMemoryApplyStatus(action.response.changeSummary),
        clearDraft: true,
      });
    case 'loadFailed':
      return {
        ...state,
        phase: 'unavailable',
        busy: null,
        statusMessage: null,
        errorMessage: action.message,
      };
    case 'setComposerDraft':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        composerDraft: action.value,
        errorMessage: null,
      };
    case 'begin':
      if (state.phase !== 'ready' || state.busy !== null || state.conflictRevision !== null) {
        return state;
      }
      return {
        ...state,
        busy: action.kind,
        statusMessage: null,
        errorMessage: null,
      };
    case 'failed':
      return {
        ...state,
        busy: null,
        conflictRevision:
          action.code === 'MEMORY_CONFLICT'
            ? (action.currentRevision ?? state.revision)
            : state.conflictRevision,
        errorMessage: action.message,
      };
    default:
      return state;
  }
}
