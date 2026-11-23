/**
 * ============================================================================
 * FILE: user-memory.test.ts
 * LOCATION: frontend/src/features/personalization/user-memory.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify independent user-memory state reducer, budget/composer selectors,
 *    isolation from Tone/Location personalization state, and MemoryCard SSR.
 *
 * ROLE IN PROJECT:
 *    Exercises AC7 Personalization MemoryCard state and markup cleanly in
 *    Vitest's Node environment without browser DOM dependencies.
 *
 * KEY COMPONENTS:
 *    - Reducer transitions: load, toggle, composer edit, clear, 409 conflict.
 *    - Isolation check against personalizationReducer dirty/revision state.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createUserMemoryClient } from '../../api/user-memory-client.ts';
import { createPersonalizationClient } from '../../api/personalization-client.ts';
import { defaultPersonalizationSettings } from '../../api/personalization-protocol.ts';
import {
  emptyUserMemorySections,
  renderUserMemorySections,
  USER_MEMORY_INSTRUCTION_MAX_CHARS,
  USER_MEMORY_MAX_CHARS,
  userMemoryCharCount,
  type UserMemoryEditResponse,
  type UserMemoryResponse,
} from '../../api/user-memory-protocol.ts';
import { MemoryCard } from './MemoryCard.tsx';
import { PersonalizationPanel } from './PersonalizationPanel.tsx';
import {
  initialPersonalizationState,
  isPersonalizationDirty,
  personalizationReducer,
} from './personalization-state.ts';
import {
  canClearMemory,
  canSubmitMemoryEdit,
  clientComposerValidationError,
  formatMemoryApplyStatus,
  initialUserMemoryState,
  memoryBudgetStatus,
  nonEmptyMemorySections,
  userMemoryReducer,
} from './user-memory-state.ts';

function memoryResponse(overrides: Partial<UserMemoryResponse> = {}): UserMemoryResponse {
  const sections = overrides.sections ?? emptyUserMemorySections();
  const rendered = renderUserMemorySections(sections);
  return {
    protocolVersion: 1,
    revision: 0,
    enabled: true,
    sections,
    isEmpty: rendered.length === 0,
    charCount: userMemoryCharCount(rendered),
    maxChars: USER_MEMORY_MAX_CHARS,
    updatedAt: null,
    ...overrides,
  };
}

describe('user-memory state reducer and selectors', () => {
  it('computes non-empty categorized sections and char budget levels accurately', () => {
    const sections = {
      ...emptyUserMemorySections(),
      identity: 'Name: Peter. Dog: Beans.',
      ongoing: 'Shipping Aurvin user memory.',
    };
    expect(nonEmptyMemorySections(sections)).toEqual([
      { key: 'identity', label: 'Identity', text: 'Name: Peter. Dog: Beans.' },
      { key: 'ongoing', label: 'Ongoing', text: 'Shipping Aurvin user memory.' },
    ]);
    expect(nonEmptyMemorySections(emptyUserMemorySections())).toEqual([]);

    expect(memoryBudgetStatus(0, 2500)).toEqual({
      percent: 0,
      level: 'normal',
      label: '0 / 2500 chars',
    });
    expect(memoryBudgetStatus(2125, 2500)).toEqual({
      percent: 85,
      level: 'near',
      label: '2125 / 2500 chars',
    });
    expect(memoryBudgetStatus(2500, 2500)).toEqual({
      percent: 100,
      level: 'full',
      label: '2500 / 2500 chars',
    });
  });

  it('validates composer drafts inline without flagging a pristine empty composer', () => {
    expect(clientComposerValidationError('')).toBeNull();
    expect(clientComposerValidationError('   ')).toBeNull();
    expect(clientComposerValidationError('My dog is named Beans')).toBeNull();
    expect(clientComposerValidationError('Use sk-or-v1-secret123')).toContain('API keys');
    expect(clientComposerValidationError('bad\u0007char')).toContain('control characters');
    expect(clientComposerValidationError('a'.repeat(USER_MEMORY_INSTRUCTION_MAX_CHARS + 1))).toContain(
      String(USER_MEMORY_INSTRUCTION_MAX_CHARS),
    );
    expect(formatMemoryApplyStatus('Updated Identity')).toBe(
      'Updated Identity — applies to new chats.',
    );
    expect(formatMemoryApplyStatus('   ')).toBe('Memory checked — no changes needed.');
  });

  it('handles load, toggle pause, paused edit/clear eligibility, composer apply, and 409 conflict reload', () => {
    let state = initialUserMemoryState();
    expect(state.phase).toBe('loading');
    expect(canClearMemory(state)).toBe(false);
    expect(canSubmitMemoryEdit(state)).toBe(false);

    // Load populated memory
    state = userMemoryReducer(state, {
      type: 'loaded',
      response: memoryResponse({
        revision: 2,
        enabled: true,
        sections: { ...emptyUserMemorySections(), identity: 'Name: Peter.' },
        updatedAt: '2026-11-20T12:00:00.000Z',
      }),
    });
    expect(state.phase).toBe('ready');
    expect(state.revision).toBe(2);
    expect(canClearMemory(state)).toBe(true);
    expect(canSubmitMemoryEdit(state)).toBe(false);

    // Pause memory: edit and clear remain allowed while paused
    state = userMemoryReducer(state, { type: 'begin', kind: 'toggling' });
    expect(state.busy).toBe('toggling');
    state = userMemoryReducer(state, {
      type: 'loaded',
      response: memoryResponse({
        revision: 3,
        enabled: false,
        sections: { ...emptyUserMemorySections(), identity: 'Name: Peter.' },
        updatedAt: '2026-11-20T12:01:00.000Z',
      }),
      statusMessage: 'Memory paused. Existing details stay saved until you clear them.',
    });
    expect(state.enabled).toBe(false);
    expect(state.revision).toBe(3);
    expect(canClearMemory(state)).toBe(true);

    // Type composer instruction while paused and apply
    state = userMemoryReducer(state, { type: 'setComposerDraft', value: 'My dog is Beans' });
    expect(canSubmitMemoryEdit(state)).toBe(true);
    state = userMemoryReducer(state, { type: 'begin', kind: 'editing' });
    expect(canSubmitMemoryEdit(state)).toBe(false);

    const editRes: UserMemoryEditResponse = {
      ...memoryResponse({
        revision: 4,
        enabled: false,
        sections: { ...emptyUserMemorySections(), identity: 'Name: Peter. Dog: Beans.' },
        updatedAt: '2026-11-20T12:02:00.000Z',
      }),
      changeSummary: 'Updated Identity',
    };
    state = userMemoryReducer(state, { type: 'editSucceeded', response: editRes });
    expect(state.revision).toBe(4);
    expect(state.composerDraft).toBe('');
    expect(state.statusMessage).toBe('Updated Identity — applies to new chats.');
    expect(state.sections.identity).toBe('Name: Peter. Dog: Beans.');

    // Failed edit preserves composerDraft; MEMORY_CONFLICT locks mutations until reload
    state = userMemoryReducer(state, { type: 'setComposerDraft', value: 'Prefer dark mode' });
    state = userMemoryReducer(state, { type: 'begin', kind: 'editing' });
    state = userMemoryReducer(state, {
      type: 'failed',
      code: 'MEMORY_CONFLICT',
      message: 'Memory changed elsewhere. Reload and try again.',
      currentRevision: 6,
    });
    expect(state.conflictRevision).toBe(6);
    expect(state.composerDraft).toBe('Prefer dark mode');
    expect(canSubmitMemoryEdit(state)).toBe(false);
    expect(canClearMemory(state)).toBe(false);

    // Reload clears conflict and restores cleared empty state
    state = userMemoryReducer(state, {
      type: 'loaded',
      response: memoryResponse({ revision: 6, enabled: true, sections: emptyUserMemorySections() }),
    });
    expect(state.conflictRevision).toBeNull();
    expect(state.isEmpty).toBe(true);
    expect(canClearMemory(state)).toBe(false);
  });

  it('keeps memory revision, composer draft, and clear state completely isolated from Tone/Instructions/Location state', () => {
    let pState = personalizationReducer(initialPersonalizationState(), {
      type: 'loaded',
      response: {
        protocolVersion: 1,
        revision: 5,
        settings: defaultPersonalizationSettings(),
        isDefault: true,
      },
    });
    let mState = userMemoryReducer(initialUserMemoryState(), {
      type: 'loaded',
      response: memoryResponse({
        revision: 1,
        enabled: true,
        sections: { ...emptyUserMemorySections(), work: 'Builds Aurvin.' },
      }),
    });

    // Mutate Tone and Instructions to make Personalization dirty
    pState = personalizationReducer(pState, { type: 'setAmplitude', field: 'warmth', value: 'high' });
    pState = personalizationReducer(pState, {
      type: 'setCustomInstructions',
      value: 'Use short bullets.',
    });
    expect(isPersonalizationDirty(pState)).toBe(true);

    // Mutating and clearing Memory changes only mState revision/sections, never pState
    mState = userMemoryReducer(mState, { type: 'setComposerDraft', value: 'Forget my work' });
    mState = userMemoryReducer(mState, {
      type: 'loaded',
      response: memoryResponse({ revision: 2, enabled: true, sections: emptyUserMemorySections() }),
      statusMessage: 'Memory cleared.',
    });
    expect(mState.revision).toBe(2);
    expect(mState.isEmpty).toBe(true);
    expect(pState.revision).toBe(5);
    expect(pState.draft.warmth).toBe('high');
    expect(pState.draft.customInstructions).toBe('Use short bullets.');
    expect(isPersonalizationDirty(pState)).toBe(true);
  });
});

describe('MemoryCard rendering', () => {
  const noopClient = createUserMemoryClient({
    fetch: vi.fn(async () => new Response('{}', { status: 200 })),
  });

  it('renders empty state, master toggle switch, budget meter, disabled clear, and bottom composer', () => {
    const emptyState = userMemoryReducer(initialUserMemoryState(), {
      type: 'loaded',
      response: memoryResponse({ revision: 0, enabled: true, sections: emptyUserMemorySections() }),
    });
    const html = renderToStaticMarkup(
      createElement(MemoryCard, { client: noopClient, initialState: emptyState }),
    );
    expect(html).toContain('id="aurvin-personalization-memory"');
    expect(html).toContain('Memory');
    expect(html).toContain('Aurvin learns concise personal details across chats and applies updates to new sessions.');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Nothing remembered yet. Aurvin will learn as you chat, or tell it below.');
    expect(html).toContain('0 / 2500 chars');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('placeholder="e.g., My dog&#x27;s name is Beans"');
    expect(html).toContain('Clear memory');
    expect(html).not.toContain('<textarea');
  });

  it('renders only non-empty read-only categorized sections, paused notice, status banner, and conflict reload', () => {
    const populated = userMemoryReducer(initialUserMemoryState(), {
      type: 'loaded',
      response: memoryResponse({
        revision: 3,
        enabled: false,
        sections: {
          ...emptyUserMemorySections(),
          identity: 'Name: Peter. Dog: Beans.',
          preferences: 'Concise answers.',
        },
        updatedAt: '2026-11-20T12:00:00.000Z',
      }),
      statusMessage: 'Updated Identity — applies to new chats.',
    });
    const html = renderToStaticMarkup(
      createElement(MemoryCard, { client: noopClient, initialState: populated }),
    );
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('Memory is paused');
    expect(html).toContain('>Identity<');
    expect(html).toContain('Name: Peter. Dog: Beans.');
    expect(html).toContain('>Preferences<');
    expect(html).toContain('Concise answers.');
    expect(html).not.toContain('>Work<');
    expect(html).not.toContain('>Ongoing<');
    expect(html).not.toContain('>Other<');
    expect(html).toContain('Updated Identity — applies to new chats.');

    const conflicted = userMemoryReducer(populated, {
      type: 'failed',
      code: 'MEMORY_CONFLICT',
      message: 'Memory changed elsewhere. Reload and try again.',
      currentRevision: 5,
    });
    const conflictHtml = renderToStaticMarkup(
      createElement(MemoryCard, { client: noopClient, initialState: conflicted }),
    );
    expect(conflictHtml).toContain('Reload memory');
    expect(conflictHtml).toContain('Memory changed elsewhere');
  });

  it('mounts MemoryCard independently inside PersonalizationPanel before personalization finishes loading', () => {
    const pClient = createPersonalizationClient({
      fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    });
    const html = renderToStaticMarkup(
      createElement(PersonalizationPanel, { client: pClient, userMemoryClient: noopClient }),
    );
    expect(html).toContain('Personalization');
    expect(html).toContain('Loading personalization settings');
    expect(html).toContain('id="aurvin-personalization-memory"');
    expect(html).toContain('Loading memory');
  });
});
