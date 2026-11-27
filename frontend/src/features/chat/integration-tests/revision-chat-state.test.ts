/**
 * ============================================================================
 * FILE: revision-chat-state.test.ts
 * LOCATION: frontend/src/features/chat/integration-tests/revision-chat-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify regenerate and edit through the real reducer and chat actions (Release 1 unit B).
 *
 * ROLE IN PROJECT:
 *    Proves new idempotency keys, the shared stream path, disabled states, the summarised-range
 *    notice, stale-epoch recovery and which controls a message may show.
 *
 * KEY COMPONENTS:
 *    - createHarness: reducer plus useChatActions with a spied ApiClient.
 *    - Tests named as in docs/release-1/plan.md section 8.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiClientError } from '../../../api/client.ts';
import type { CalendarCompatibleEnvelope } from '../../../api/calendar-protocol.ts';
import type { VisibleMessage } from '../../../api/protocol.ts';
import { canSaveEdit } from '../../../components/MessageEditor.tsx';
import { chatReducer, initialChatState, selectVisibleMessages } from '../state/chat-reducer.ts';
import type { ChatAction, ChatState } from '../state/chat-types.ts';
import { revisionActions } from '../state/revision.ts';
import { useChatActions } from '../state/use-chat.ts';

const msg = (o: Partial<VisibleMessage> & Pick<VisibleMessage, 'messageId' | 'role' | 'sequence'>): VisibleMessage => ({
  turnId: 'turn_1', eventId: `evt_${o.messageId}`, content: o.messageId, createdAt: '2026-11-27T10:00:00.000Z',
  completionStatus: o.role === 'user' ? 'accepted' : 'completed', truncated: false, ...o,
});
const base: ChatState = { ...initialChatState, activeSessionId: 'sess_1', turnStatus: 'completed',
  messages: [msg({ messageId: 'u1', role: 'user', sequence: 0 }), msg({ messageId: 'a1', role: 'assistant', sequence: 1 })] };
const env = (turnId: string, attemptId: string) => ({ protocolVersion: 2, sessionId: 'sess_1', turnId, attemptId, sequence: 1,
  event: { type: 'delta', text: '' } }) as CalendarCompatibleEnvelope;
const accepted = (turnId: string) => ({ sessionId: 'sess_1', turnId, attemptId: `att_${turnId}`, userMessageId: `u_${turnId}`, streamPath: `/s/${turnId}` });
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

function createHarness(initial: ChatState, client: ApiClient) {
  let state = initial;
  const dispatched: ChatAction[] = [];
  const dispatch = (action: ChatAction) => { dispatched.push(action); state = chatReducer(state, action); };
  let actions!: ReturnType<typeof useChatActions>;
  const render = () => {
    function Harness() { actions = useChatActions(state, dispatch, client); return null; }
    renderToStaticMarkup(createElement(Harness));
  };
  render();
  return { get state() { return state; }, get actions() { return actions; }, render, dispatched };
}
function streaming(client: ApiClient) {
  const handlers: { onEvent?: (e: unknown, envelope: CalendarCompatibleEnvelope) => void }[] = [];
  vi.spyOn(client, 'connectTurnStream').mockImplementation(async (_path, h) => { handlers.push(h as never); });
  return handlers;
}

describe('revision chat state', () => {
  it('regenerate sends a new idempotency key and streams like a submit', async () => {
    const client = new ApiClient({ fetch: vi.fn() });
    const regenerate = vi.spyOn(client, 'regenerateTurn').mockResolvedValueOnce(accepted('turn_1')).mockResolvedValueOnce(accepted('turn_1'));
    const handlers = streaming(client);
    const h = createHarness(base, client);
    await h.actions.regenerateTurn('turn_1', 'a1');
    await flush();
    expect(regenerate).toHaveBeenCalledWith('sess_1', 'turn_1', expect.objectContaining({ calendarProtocol: 2 }), expect.anything());
    expect(h.dispatched.some((a) => a.type === 'REVISION_PENDING' && a.payload.supersedes === 'a1')).toBe(true);
    expect(handlers).toHaveLength(1);
    await h.actions.regenerateTurn('turn_1', 'a1');
    const keys = regenerate.mock.calls.map((c) => c[2].idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a completed regenerate marks the new answer as superseding the old one and hides the old one', async () => {
    const client = new ApiClient({ fetch: vi.fn() });
    vi.spyOn(client, 'regenerateTurn').mockResolvedValue(accepted('turn_1'));
    let release!: () => void;
    let onEvent!: (e: unknown, envelope: CalendarCompatibleEnvelope) => void;
    vi.spyOn(client, 'connectTurnStream').mockImplementation(async (_path, handlers) => {
      onEvent = handlers.onEvent as never;
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const h = createHarness(base, client);
    const running = h.actions.regenerateTurn('turn_1', 'a1');
    await flush();
    onEvent({ type: 'completed', assistantMessageId: 'a1b', outcome: 'completed' }, env('turn_1', 'att_turn_1'));
    release();
    await running;
    expect(h.state.messages.find((m) => m.messageId === 'a1b')?.supersedes).toBe('a1');
    expect(selectVisibleMessages(h.state.messages, {}, h.state.revisionSupersedes).map((m) => m.messageId)).toEqual(['u1', 'a1b']);
  });

  it('edit is disabled while a generation is active', async () => {
    const client = new ApiClient({ fetch: vi.fn() });
    const edit = vi.spyOn(client, 'editTurn');
    const h = createHarness({ ...base, isStreaming: true, turnStatus: 'generating' }, client);
    await h.actions.editTurn('turn_1', 'u1', 'new text');
    expect(edit).not.toHaveBeenCalled();
    expect(revisionActions(base.messages, base.messages[0]!, { enabled: true, busy: true, compactedThroughSequence: null }))
      .toEqual({ canEdit: false, canRegenerate: false });
  });

  it('edit save is disabled for empty or unchanged text', () => {
    expect(canSaveEdit('hello', '')).toBe(false);
    expect(canSaveEdit('hello', '   ')).toBe(false);
    expect(canSaveEdit('hello', ' hello ')).toBe(false);
    expect(canSaveEdit('hello', 'hello!')).toBe(true);
    expect(canSaveEdit('hello', 'x'.repeat(40), 32)).toBe(false);
  });

  it('an edit hides the replaced turn at once and a sent edit supersedes the original user message', async () => {
    const client = new ApiClient({ fetch: vi.fn() });
    vi.spyOn(client, 'editTurn').mockResolvedValue(accepted('turn_2'));
    streaming(client);
    const h = createHarness(base, client);
    await h.actions.editTurn('turn_1', 'u1', 'Edited');
    const edited = h.state.messages.find((m) => m.content === 'Edited')!;
    expect(edited.supersedes).toBe('u1');
    expect(selectVisibleMessages(h.state.messages).map((m) => m.content)).toEqual(['Edited']);
  });

  it('revision too old shows the summarised-conversation notice', async () => {
    const client = new ApiClient({ fetch: vi.fn() });
    const notice = "This message is part of a summarised earlier conversation and can't be edited.";
    vi.spyOn(client, 'editTurn').mockRejectedValue(new ApiClientError('REVISION_TOO_OLD', notice, 409, false));
    const h = createHarness(base, client);
    await h.actions.editTurn('turn_1', 'u1', 'Edited');
    expect(h.state.turnError).toMatchObject({ code: 'REVISION_TOO_OLD', message: notice });
    expect(h.state.messages.map((m) => m.messageId)).toEqual(['u1', 'a1']);
    expect(h.state.isSubmitting).toBe(false);
  });

  it('a stale epoch after refresh uses the interrupted recovery', async () => {
    const client = new ApiClient({ fetch: vi.fn() });
    vi.spyOn(client, 'regenerateTurn').mockRejectedValue(new ApiClientError('INTERRUPTED', 'This request belongs to an earlier server session.', 409, false));
    const h = createHarness(base, client);
    await h.actions.regenerateTurn('turn_1', 'a1');
    expect(h.state.turnError?.code).toBe('INTERRUPTED');
    expect(h.state.turnStatus).toBe('failed');
  });

  it('shows edit and regenerate only for eligible messages', () => {
    const on = { enabled: true, busy: false, compactedThroughSequence: null };
    const [u, a] = base.messages as [VisibleMessage, VisibleMessage];
    expect(revisionActions(base.messages, u, on)).toEqual({ canEdit: true, canRegenerate: false });
    expect(revisionActions(base.messages, a, on)).toEqual({ canEdit: false, canRegenerate: true });
    expect(revisionActions(base.messages, u, { ...on, enabled: false })).toEqual({ canEdit: false, canRegenerate: false });
    expect(revisionActions(base.messages, u, { ...on, compactedThroughSequence: 1 }).canEdit).toBe(false);
    expect(revisionActions(base.messages, { ...a, mode: 'live' }, on).canRegenerate).toBe(false);
    const older = [...base.messages, msg({ messageId: 'u2', role: 'user', sequence: 2, turnId: 'turn_2' }), msg({ messageId: 'a2', role: 'assistant', sequence: 3, turnId: 'turn_2' })];
    expect(revisionActions(older, u, on).canEdit).toBe(false);
    expect(revisionActions(older, a, on).canRegenerate).toBe(false);
  });
});
