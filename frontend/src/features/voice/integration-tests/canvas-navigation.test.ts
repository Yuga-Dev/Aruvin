/**
 * ============================================================================
 * FILE: canvas-navigation.test.ts
 * LOCATION: frontend/src/features/voice/integration-tests/canvas-navigation.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Offline integration coverage for reopening an existing Canvas from a scoped
 *    live voice navigation request.
 *
 * ROLE IN PROJECT:
 *    Composes the real LiveKit voice client, live voice controller, chat reducer, and
 *    the merged Canvas surface over deterministic SDK doubles. It proves that a
 *    bounded inventory advertisement and one `canvas.show` reopen an already existing
 *    tab through the existing reducer without generation, Calendar access, or media
 *    change. This is not a browser, microphone, or SFU test.
 *
 * KEY COMPONENTS:
 *    - surfaceFixture: Four existing artifacts (two archived text, one previous live
 *      response, one same-call projection) with two closed tabs.
 *    - Reception: Scoped reopen, duplicate navigation ids, requester fencing, aliases.
 *    - Projection parity: Bounded inventory refreshes and omission semantics.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { matrixFixture } from './matrix-fixture.ts';
import { settle } from '../state/testing/live-voice-fixture.ts';
import type { LiveVoiceBindings } from '../state/live-voice-controller.ts';
import { chatReducer, initialChatState } from '../../chat/state/chat-reducer.ts';
import { collectSessionCanvasArtifacts, mergeSessionCanvasArtifacts }
  from '../../canvas/canvas-artifacts.ts';
import { matchesCalendarArtifact, mergeCalendarWorkspaces }
  from '../../canvas/calendar-workspace.ts';
import type { CalendarWorkspace } from '../../canvas/calendar-workspace.ts';
import { canvasInventory } from '../../canvas/canvas-navigation.ts';
import type { CanvasArtifact } from '../../canvas/canvas-types.ts';
import { applyCanvasControl } from '../../canvas/canvas-controls.ts';
import { agenda } from '../../canvas/testing/calendar-view-fixtures.ts';
import type { CanvasArtifactProjection, CanvasControlArguments } from '../../../api/voice-protocol.ts';
import { parseVoiceControl } from '../../../api/voice-protocol.ts';
import type { VisibleMessage } from '../../../api/protocol.ts';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const diagram = (title: string) => '```mermaid\n---\ntitle: ' + title + '\n---\nflowchart TD\nA --> B\n```';

const message = (messageId: string, content: string, extra: Partial<VisibleMessage> = {}): VisibleMessage => ({
  messageId, turnId: `turn-${messageId}`, eventId: `event-${messageId}`, sequence: 1, role: 'assistant',
  content, createdAt: '2026-11-02T10:00:00Z', completionStatus: 'completed', truncated: false, ...extra });

const previousLive: CanvasArtifactProjection = { responseId: 'response-previous', ordinal: 0,
  kind: 'chart', subType: 'Bar Chart', title: 'Previous live chart',
  rawSource: '{"type":"bar","labels":["A"],"datasets":[{"label":"Count","data":[1]}]}' };

const workspace = (turnIds: string[]): CalendarWorkspace => ({ id: `calendar:${turnIds[0]}`,
  turnIds, artifactAliases: ['archived-calendar-1::canvas::calendar'], intentId: null, proposalId: null,
  operationId: null, view: agenda(), proposal: null, phase: null, interactive: false, pending: false });

/** Real controller settle: one live client, ready event, then the listening handshake. */
async function live(bindings: LiveVoiceBindings) {
  const f = matrixFixture('granted', { bindings });
  await f.begin();
  f.event({ type: 'conversation.bound', conversationId: 'conversation-1' });
  return f;
}

const bindingsFor = (openCanvasArtifact: (id: string) => void, select: () => string | null): LiveVoiceBindings => ({
  claimVoiceInput: vi.fn(() => 'lease-1'), writeVoiceDraft: vi.fn(() => true),
  releaseVoiceInput: vi.fn(), bindVoiceConversation: vi.fn(() => true), refreshSessions: vi.fn(),
  getActiveConversationId: select, openCanvasArtifact });

describe('Frontend Canvas navigation integration', () => {
  it('reopens a closed existing tab from one scoped show without generation or media change', async () => {
    let chat = { ...initialChatState };
    const open = vi.fn((artifactId: string) => {
      chat = chatReducer(chat, { type: 'OPEN_CANVAS_ARTIFACT', payload: { artifactId } });
    });
      const f = await live(bindingsFor(open, () => 'conversation-1'));
    try {
      // One same-call live projection joins the archived text and previous live response.
      f.event({ type: 'canvas.artifact', turnId: 'turn-live', ...previousLive,
        responseId: 'response-live', title: 'Same-call chart' });
      const archived = collectSessionCanvasArtifacts([
        message('message-text-1', diagram('Pricing comparison')),
        message('message-text-2', diagram('Launch plan')),
        message('assistant-voice-1', '', { mode: 'live', voiceSessionId: 'voice-archive-1',
          canvasArtifacts: [previousLive] }),
      ], '', false);
      const surface: CanvasArtifact[] = mergeCalendarWorkspaces(
        mergeSessionCanvasArtifacts(archived, f.controller.getSnapshot().artifacts), [], true);
      expect(surface).toHaveLength(4);
      expect(new Set(surface.map(item => item.artifactId)).size).toBe(4);
      expect(surface.map(item => item.title)).toEqual(['Pricing comparison', 'Launch plan',
        'Previous live chart', 'Same-call chart']);
      f.controller.updateCanvasInventory('conversation-1', surface);
      const inventory = canvasInventory(surface, { responseIds: new Set(['response-live']) });
      expect(inventory.items.find(item => item.canvasId === 'response-live::canvas::0')?.owner)
        .toEqual({ kind: 'response', id: 'response-live' });
      expect(inventory.items.find(item => item.canvasId === 'response-previous::canvas::0')?.owner)
        .toEqual({ kind: 'response', id: 'response-previous' });

      // Two tabs close and the panel hides before the voice request arrives.
      const target = surface[0]!;
      chat = chatReducer(chat, { type: 'CLOSE_CANVAS_TAB', payload: {
        artifactId: target.artifactId, fallbackArtifactId: surface[1]!.artifactId } });
      chat = chatReducer(chat, { type: 'CLOSE_CANVAS_TAB', payload: {
        artifactId: surface[2]!.artifactId, fallbackArtifactId: null } });
      chat = chatReducer(chat, { type: 'CLOSE_CANVAS' });
      expect(chat.canvasOpen).toBe(false);
      expect(chat.closedCanvasArtifactIds).toEqual([target.artifactId, surface[2]!.artifactId]);

      open.mockClear();
      const before = structuredClone(f.controller.getSnapshot().artifacts);
      const captureCalls = f.rtc.microphone.mock.calls.length;
      const publishCalls = f.rtc.participant.publishTrack.mock.calls.length;
      f.event({ type: 'canvas.show', conversationId: 'conversation-1', turnId: 'turn-nav',
        responseId: 'response-nav', navigationId: 'show-existing-1', canvasId: target.artifactId });

      expect(chat.canvasOpen).toBe(true);
      expect(chat.activeCanvasArtifactId).toBe(target.artifactId);
      expect(chat.closedCanvasArtifactIds).not.toContain(target.artifactId);
      expect(open).toHaveBeenCalledExactlyOnceWith(target.artifactId);
      expect(surface).toHaveLength(4); // Closing and opening never change the merged surface.
      expect(f.controller.getSnapshot().artifacts).toEqual(before);
      expect(f.rtc.room.disconnect).not.toHaveBeenCalled();
      expect(f.rtc.microphone).toHaveBeenCalledTimes(captureCalls);
      expect(f.rtc.participant.publishTrack).toHaveBeenCalledTimes(publishCalls);
      expect(f.controller.getSnapshot()).toMatchObject({ phase: 'active', agent: 'idle' });

      // A replayed navigation id at a later presentation sequence stays a single callback.
      f.event({ type: 'canvas.show', conversationId: 'conversation-1', turnId: 'turn-nav',
        responseId: 'response-nav', navigationId: 'show-existing-1', canvasId: surface[1]!.artifactId });
      expect(open).toHaveBeenCalledTimes(1);
      expect(chat.activeCanvasArtifactId).toBe(target.artifactId);
    } finally { f.controller.exit(); await settle(); }
  });

  it('fences requester retirement, cancellation, wrong scope, stale epoch, and missing targets', async () => {
    let chat = { ...initialChatState };
    const open = vi.fn((artifactId: string) => {
      chat = chatReducer(chat, { type: 'OPEN_CANVAS_ARTIFACT', payload: { artifactId } });
    });
    let selected: string | null = 'conversation-1';
    const f = await live(bindingsFor(open, () => selected));
    try {
      const surface = collectSessionCanvasArtifacts([message('message-text-1', diagram('Pricing comparison'))], '', false);
      f.controller.updateCanvasInventory('conversation-1', surface);
      const target = surface[0]!;
      const show = (patch: Record<string, unknown> = {}, epoch?: number) => f.event({ type: 'canvas.show',
        conversationId: 'conversation-1', turnId: 'turn-nav', responseId: 'response-nav',
        navigationId: 'nav-1', canvasId: target.artifactId, ...patch } as never, epoch);

      show();
      expect(open).toHaveBeenCalledOnce();
      show({ navigationId: 'nav-2', canvasId: 'missing::canvas::0' });
      show({ navigationId: 'nav-3', conversationId: 'conversation-2' });
      show({ navigationId: 'nav-4' }, f.response.connectionEpoch - 1); // Stale Room callback.
      expect(open).toHaveBeenCalledOnce();
      // The target's original generation response is irrelevant to exact membership.
      expect(matchesCalendarArtifact(target, target.artifactId)).toBe(true);

      // A later audio response retires the pre-audio requester; the target stays reachable.
      f.event({ type: 'audio.start', turnId: 'turn-a', responseId: 'response-a', sampleRate: 24000,
        firstAudioSequence: 0 });
      show({ navigationId: 'nav-5' });
      expect(open).toHaveBeenCalledOnce();
      show({ navigationId: 'nav-6', responseId: 'response-a', turnId: 'turn-a' });
      expect(open).toHaveBeenCalledTimes(2);

      // A cancelled requester never opens anything.
      f.event({ type: 'response.cancelled', turnId: 'turn-b', responseId: 'response-b',
        lastAudioSequence: null });
      show({ navigationId: 'nav-7', responseId: 'response-b', turnId: 'turn-b' });
      expect(open).toHaveBeenCalledTimes(2);

      // Selection changed outside this call: presentation is refused, media untouched.
      selected = 'conversation-2';
      show({ navigationId: 'nav-8' });
      selected = 'conversation-1';
      expect(open).toHaveBeenCalledTimes(2);
      expect(f.controller.getSnapshot().phase).toBe('active');
      expect(f.rtc.room.disconnect).not.toHaveBeenCalled();
    } finally { f.controller.exit(); await settle(); }
  });

  it('contains a throwing presentation callback and a paused call', async () => {
    const open = vi.fn(() => { throw new Error('presentation failed'); });
    const f = await live(bindingsFor(open, () => 'conversation-1'));
    try {
      const surface = collectSessionCanvasArtifacts([message('message-text-1', diagram('Pricing comparison'))], '', false);
      f.controller.updateCanvasInventory('conversation-1', surface);
      expect(() => f.event({ type: 'canvas.show', conversationId: 'conversation-1',
        turnId: 'turn-nav', responseId: 'response-nav', navigationId: 'nav-throw',
        canvasId: surface[0]!.artifactId })).not.toThrow();
      expect(open).toHaveBeenCalledOnce();
      expect(f.controller.getSnapshot()).toMatchObject({ phase: 'active' });
      f.event({ type: 'session.error', code: 'TTS_UNAVAILABLE', recovery: 'resume_call',
        recoverable: true, terminal: false }); await settle();
      f.event({ type: 'canvas.show', conversationId: 'conversation-1', turnId: 'turn-paused',
        responseId: 'response-paused', navigationId: 'nav-paused',
        canvasId: surface[0]!.artifactId });
      expect(open).toHaveBeenCalledOnce();
      expect(f.controller.getSnapshot().phase).toBe('suspended');
    } finally { f.controller.exit(); await settle(); }
  });

  it('merges Calendar aliases into one navigable item and refreshes same-call projections', async () => {
    const open = vi.fn();
    const f = await live(bindingsFor(open, () => 'conversation-1'));
    try {
      const archived = collectSessionCanvasArtifacts([
        message('message-text-1', diagram('Pricing comparison')),
        message('assistant-calendar-1', '', { calendarView: agenda() }),
      ], '', false);
      const merged = mergeCalendarWorkspaces(mergeSessionCanvasArtifacts(archived, []),
        [workspace(['turn-calendar', 'turn-calendar-2'])], true);
      const canonical = merged.find(item => item.kind === 'calendar' && item.calendarWorkspace)!;
      expect(canonical.calendarAliases).toContain('archived-calendar-1::canvas::calendar');
      f.controller.updateCanvasInventory('conversation-1', merged);
      await settle();
      const inventory = canvasInventory(merged);
      expect(inventory.items.filter(item => item.canvasId === canonical.artifactId)).toHaveLength(1);
      expect(inventory.items.find(item => item.canvasId === canonical.artifactId)?.owner)
        .toEqual({ kind: 'calendar', id: 'turn-calendar' });

      // The alias resolves through exact current membership to the canonical artifact id.
      f.event({ type: 'canvas.show', conversationId: 'conversation-1', turnId: 'turn-nav',
        responseId: 'response-nav', navigationId: 'nav-alias',
        canvasId: 'archived-calendar-1::canvas::calendar' });
      expect(open).toHaveBeenCalledExactlyOnceWith(canonical.artifactId);

      // A same-call visual refreshes the published inventory without replacing the surface.
      f.event({ type: 'canvas.artifact', turnId: 'turn-live', ...previousLive,
        responseId: 'response-live', title: 'Same-call chart' });
      const refreshed = mergeCalendarWorkspaces(
        mergeSessionCanvasArtifacts(archived, f.controller.getSnapshot().artifacts),
        [workspace(['turn-calendar', 'turn-calendar-2'])], true);
      f.controller.updateCanvasInventory('conversation-1', refreshed);
      await settle();
      const published = (f.rtc.packets() as Array<Record<string, unknown>>)
        .filter(packet => packet.type === 'canvas.inventory');
      expect(published.length).toBeGreaterThanOrEqual(2);
      const last = published.at(-1) as { inventory: { items: Array<{ canvasId: string }> } };
      expect(last.inventory.items.some(item => item.canvasId === 'response-live::canvas::0')).toBe(true);
      expect(refreshed).toHaveLength(merged.length + 1);
    } finally { f.controller.exit(); await settle(); }
  });

  it('accepts the backend canvas.show wire shape and keeps requesting/target identity distinct', async () => {
    const open = vi.fn();
    const f = await live(bindingsFor(open, () => 'conversation-1'));
    try {
      const surface = collectSessionCanvasArtifacts([
        message('message-text-1', diagram('Pricing comparison')),
        message('message-text-2', diagram('Launch plan')),
      ], '', false);
      f.controller.updateCanvasInventory('conversation-1', surface);
      const target = surface[0]!;
      // Exactly the backend envelope the offline integration fixture asserts on.
      const wire = { protocolVersion: 1, sessionId: f.response.sessionId,
        connectionEpoch: f.response.connectionEpoch, eventId: 'backend-show-1', sequence: 0,
        type: 'canvas.show' as const, conversationId: 'conversation-1', turnId: 'turn-requesting-1',
        responseId: 'response-requesting-1', navigationId: 'show-existing-1', canvasId: target.artifactId };
      expect(parseVoiceControl(JSON.stringify(wire), 'server', 'live')).toEqual(wire);
      const { protocolVersion: _protocol, sessionId: _session, connectionEpoch: _epoch,
        eventId: _eventId, sequence: _sequence, ...payload } = wire;
      f.event(payload);
      expect(open).toHaveBeenCalledExactlyOnceWith(target.artifactId);
      // Requester retirement is keyed by the requesting response, never the target's response.
      f.event({ type: 'response.cancelled', turnId: 'turn-requesting-1',
        responseId: 'response-requesting-1', lastAudioSequence: null });
      f.event({ ...payload, navigationId: 'show-existing-2' });
      expect(open).toHaveBeenCalledOnce();
      // A later requesting response may still reopen the same target artifact id.
      f.event({ ...payload, navigationId: 'show-existing-3', turnId: 'turn-requesting-2',
        responseId: 'response-requesting-2' });
      expect(open).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenLastCalledWith(target.artifactId);
      expect(f.controller.getSnapshot().artifacts).toEqual([]);
    } finally { f.controller.exit(); await settle(); }
  });

  it('applies distinct relative controls immediately once per identity', async () => {
    const f = await live(bindingsFor(vi.fn(), () => 'conversation-1'));
    let view = { zoom: 100, panX: 0, panY: 0 };
    const apply = vi.fn((command: CanvasControlArguments) => applyCanvasControl(command, {
      mode: 'diagram', open: true, getView: () => view, setView: next => { view = next; },
      viewport: { clientWidth: 400, clientHeight: 200 } as HTMLDivElement,
      stage: {} as HTMLDivElement, body: null, close: vi.fn(), setMaximized: vi.fn(),
    }));
    try {
      const surface = collectSessionCanvasArtifacts([
        message('message-text-1', diagram('Pricing comparison')),
      ], '', false);
      const id = surface[0]!.artifactId;
      f.controller.updateCanvasInventory('conversation-1', surface,
        { canvasId: id, open: true, fullscreen: false, mode: 'diagram', apply });
      await settle();
      const packets = f.rtc.packets() as Array<{ type: string; selection?: { revision: number } }>;
      const revision = packets.filter(packet => packet.type === 'canvas.inventory').at(-1)!.selection!.revision;
      const payload = { type: 'canvas.control' as const, conversationId: 'conversation-1',
        turnId: 'control-turn', responseId: 'control-response', canvasId: id,
        selectionRevision: revision, controlId: 'control-1', command: { action: 'zoom_in' as const } };
      f.event(payload);
      expect(view.zoom).toBe(125); // No settle/ack/effect/persistence wait after receipt.
      f.event(payload);
      expect(view.zoom).toBe(125);
      f.event({ ...payload, controlId: 'control-2' });
      expect(view.zoom).toBe(150);
      expect(apply).toHaveBeenCalledTimes(2);
      expect(f.rtc.room.disconnect).not.toHaveBeenCalled();
    } finally { f.controller.exit(); await settle(); }
  });

  it('applies canvas controls synchronously before deferred save or response completion settles', async () => {
    let resolveSave!: () => void;
    let saveSettled = false;
    const pendingSave = new Promise<void>(resolve => {
      resolveSave = () => { saveSettled = true; resolve(); };
    });
    let resolveCompletion!: () => void;
    let completionSettled = false;
    const pendingCompletion = new Promise<void>(resolve => {
      resolveCompletion = () => { completionSettled = true; resolve(); };
    });
    const order: string[] = [];
    let tick = 0;
    const timings: Record<string, number> = {};
    const f = await live(bindingsFor(vi.fn(), () => 'conversation-1'));
    let view = { zoom: 100, panX: 0, panY: 0 };
    const apply = vi.fn((command: CanvasControlArguments) => {
      order.push('apply');
      timings.apply = ++tick;
      expect(saveSettled).toBe(false);
      expect(completionSettled).toBe(false);
      return applyCanvasControl(command, {
        mode: 'diagram', open: true, getView: () => view, setView: next => { view = next; },
        viewport: { clientWidth: 400, clientHeight: 200 } as HTMLDivElement,
        stage: {} as HTMLDivElement, body: null, close: vi.fn(), setMaximized: vi.fn(),
      });
    });
    try {
      const surface = collectSessionCanvasArtifacts([
        message('message-text-1', diagram('Pricing comparison')),
      ], '', false);
      const id = surface[0]!.artifactId;
      f.controller.updateCanvasInventory('conversation-1', surface,
        { canvasId: id, open: true, fullscreen: false, mode: 'diagram', apply });
      await settle();
      const packets = f.rtc.packets() as Array<{ type: string; selection?: { revision: number } }>;
      const revision = packets.filter(packet => packet.type === 'canvas.inventory').at(-1)!.selection!.revision;

      // Defer background save and turn completion, and keep response audio open.
      void pendingSave.then(() => { order.push('save'); timings.save = ++tick; });
      void pendingCompletion.then(() => { order.push('complete'); timings.complete = ++tick; });
      f.event({ type: 'audio.start', turnId: 'control-turn', responseId: 'control-response',
        sampleRate: 24000, firstAudioSequence: 0 });
      timings.deliver = ++tick;
      order.push('deliver');
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 'control-turn', responseId: 'control-response', canvasId: id,
        selectionRevision: revision, controlId: 'control-early-1', command: { action: 'zoom_in' } });
      expect(view.zoom).toBe(125);
      expect(order).toEqual(['deliver', 'apply']);
      expect(timings.apply).toBeGreaterThan(timings.deliver);
      expect(saveSettled).toBe(false);
      expect(completionSettled).toBe(false);

      resolveSave();
      resolveCompletion();
      f.event({ type: 'audio.end', turnId: 'control-turn', responseId: 'control-response',
        lastAudioSequence: null });
      await settle();
      await Promise.all([pendingSave, pendingCompletion]);
      expect(order).toEqual(['deliver', 'apply', 'save', 'complete']);
      expect(timings.save).toBeGreaterThan(timings.apply);
      expect(timings.complete).toBeGreaterThan(timings.apply);
      expect(apply).toHaveBeenCalledOnce();
    } finally {
      resolveSave();
      resolveCompletion();
      f.controller.exit();
      await settle();
    }
  });

  it('fences A->B->A selection revisions, preview/code switches, and duplicate IDs with different commands', async () => {
    const f = await live(bindingsFor(vi.fn(), () => 'conversation-1'));
    try {
      const surface = collectSessionCanvasArtifacts([
        message('message-text-1', diagram('First diagram')),
        message('message-text-2', diagram('Second diagram')),
      ], '', false);
      const a = surface[0]!.artifactId;
      const b = surface[1]!.artifactId;
      const applied: Array<{ canvasId: string; command: CanvasControlArguments }> = [];
      const makeApply = (canvasId: string) => vi.fn((command: CanvasControlArguments) => {
        applied.push({ canvasId, command });
        return 'applied' as const;
      });
      const revOf = () => (f.rtc.packets() as Array<{ type: string; selection?: { revision: number } }>)
        .filter(packet => packet.type === 'canvas.inventory').at(-1)!.selection!.revision;

      // A (rev r1) -> B (rev r2) -> A (rev r3)
      f.controller.updateCanvasInventory('conversation-1', surface,
        { canvasId: a, open: true, fullscreen: false, mode: 'diagram', apply: makeApply(a) });
      await settle();
      const revA1 = revOf();
      f.controller.updateCanvasInventory('conversation-1', surface,
        { canvasId: b, open: true, fullscreen: false, mode: 'diagram', apply: makeApply(b) });
      await settle();
      f.controller.updateCanvasInventory('conversation-1', surface,
        { canvasId: a, open: true, fullscreen: false, mode: 'diagram', apply: makeApply(a) });
      await settle();
      const revA2 = revOf();
      expect(revA2).toBeGreaterThan(revA1 + 1);

      // Delayed control targeting old A revision r1 or wrong target B is rejected.
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't1', responseId: 'r1', canvasId: a, selectionRevision: revA1,
        controlId: 'ctrl-stale-a', command: { action: 'zoom_in' } });
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't1', responseId: 'r1', canvasId: b, selectionRevision: revA2,
        controlId: 'ctrl-wrong-target', command: { action: 'zoom_in' } });
      expect(applied).toHaveLength(0);

      // Switching preview -> code ('diagram' -> 'scroll') bumps revision and invalidates preview revA2.
      f.controller.updateCanvasInventory('conversation-1', surface,
        { canvasId: a, open: true, fullscreen: false, mode: 'scroll', apply: makeApply(a) });
      await settle();
      const revCode = revOf();
      expect(revCode).toBeGreaterThan(revA2);
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't1', responseId: 'r1', canvasId: a, selectionRevision: revA2,
        controlId: 'ctrl-preview-stale', command: { action: 'zoom_in' } });
      expect(applied).toHaveLength(0);

      // Current code revision accepts scroll once; duplicate controlId with different command is dropped.
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't1', responseId: 'r1', canvasId: a, selectionRevision: revCode,
        controlId: 'ctrl-dup', command: { action: 'scroll', direction: 'down' } });
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't1', responseId: 'r1', canvasId: a, selectionRevision: revCode,
        controlId: 'ctrl-dup', command: { action: 'fullscreen', state: 'enter' } });
      expect(applied).toEqual([{ canvasId: a, command: { action: 'scroll', direction: 'down' } }]);
    } finally { f.controller.exit(); await settle(); }
  });

  it('rejects wrong scopes, retired/cancelled/paused/hidden states, closed non-close actions, and preserves Calendar confirmation', async () => {
    let activeConversation: string | null = 'conversation-1';
    const open = vi.fn();
    const f = await live(bindingsFor(open, () => activeConversation));
    try {
      const merged = mergeCalendarWorkspaces(
        mergeSessionCanvasArtifacts(
          collectSessionCanvasArtifacts([message('message-text-1', diagram('System flow'))], '', false),
          [],
        ),
        [{ id: 'calendar:turn-cal', turnIds: ['turn-cal'], artifactAliases: [], intentId: null,
          proposalId: 'prop-1', operationId: null, view: agenda(), proposal: null,
          phase: null, interactive: true, pending: false }],
        true,
      );
      const diagramId = merged.find(item => item.kind !== 'calendar')!.artifactId;
      const calendarItem = merged.find(item => item.kind === 'calendar')!;
      const apply = vi.fn((command: CanvasControlArguments) => applyCanvasControl(command, {
        mode: 'diagram', open: false, getView: () => ({ zoom: 100, panX: 0, panY: 0 }), setView: vi.fn(),
        viewport: null, stage: null, body: null, close: vi.fn(), setMaximized: vi.fn(),
      }));

      // Closed diagram allows repeated close but rejects fullscreen/scroll/reset_view without reopening.
      f.controller.updateCanvasInventory('conversation-1', merged,
        { canvasId: diagramId, open: false, fullscreen: false, mode: 'diagram', apply });
      await settle();
      const packets = () => f.rtc.packets() as Array<{ type: string; selection?: { revision: number } }>;
      const closedRev = packets().filter(p => p.type === 'canvas.inventory').at(-1)!.selection!.revision;
      for (const [idx, command] of ([
        { action: 'fullscreen', state: 'enter' },
        { action: 'scroll', direction: 'down' },
        { action: 'reset_view' },
      ] as const).entries()) {
        f.event({ type: 'canvas.control', conversationId: 'conversation-1',
          turnId: 't-closed', responseId: 'r-closed', canvasId: diagramId,
          selectionRevision: closedRev, controlId: `closed-nonclose-${idx}`, command });
      }
      expect(apply).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't-closed', responseId: 'r-closed', canvasId: diagramId,
        selectionRevision: closedRev, controlId: 'closed-close', command: { action: 'close' } });
      expect(apply).toHaveBeenCalledExactlyOnceWith({ action: 'close' });

      // Missing target binding advertises no selection and never falls back to another artifact.
      f.controller.updateCanvasInventory('conversation-1', merged,
        { canvasId: 'missing::canvas::0', open: true, fullscreen: false, mode: 'diagram', apply });
      await settle();
      expect(packets().filter(p => p.type === 'canvas.inventory').at(-1)!.selection).toBeUndefined();

      // Switch to Calendar scroll surface: zoom/fit return unsupported; Calendar confirm still sends unchanged.
      let maximized = false;
      const applyCal = vi.fn((command: CanvasControlArguments) => applyCanvasControl(command, {
        mode: 'scroll', open: true, getView: () => ({ zoom: 100, panX: 0, panY: 0 }), setView: vi.fn(),
        viewport: { clientWidth: 400, clientHeight: 200 } as HTMLDivElement,
        stage: null, body: null, close: vi.fn(), setMaximized: v => { maximized = v; },
      }));
      f.controller.updateCanvasInventory('conversation-1', merged,
        { canvasId: calendarItem.artifactId, open: true, fullscreen: false, mode: 'scroll', apply: applyCal });
      await settle();
      const calRev = packets().filter(p => p.type === 'canvas.inventory').at(-1)!.selection!.revision;
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't-cal', responseId: 'r-cal', canvasId: calendarItem.artifactId,
        selectionRevision: calRev, controlId: 'cal-zoom', command: { action: 'zoom_in' } });
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't-cal', responseId: 'r-cal', canvasId: calendarItem.artifactId,
        selectionRevision: calRev, controlId: 'cal-fit', command: { action: 'fit_to_view' } });
      expect(applyCal).toHaveBeenCalledTimes(2);
      expect(applyCal.mock.results.map(r => r.value)).toEqual(['unsupported', 'unsupported']);
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't-cal', responseId: 'r-cal', canvasId: calendarItem.artifactId,
        selectionRevision: calRev, controlId: 'cal-max', command: { action: 'fullscreen', state: 'enter' } });
      expect(maximized).toBe(true);

      // Cancelled, retired (by later audio.start), mismatched epoch/turn, wrong conversation, and hidden surfaces reject.
      f.event({ type: 'canvas.control', conversationId: 'conversation-2',
        turnId: 't-other', responseId: 'r-other', canvasId: calendarItem.artifactId,
        selectionRevision: calRev, controlId: 'bad-conv', command: { action: 'close' } });
      activeConversation = 'conversation-other';
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't-other', responseId: 'r-other', canvasId: calendarItem.artifactId,
        selectionRevision: calRev, controlId: 'bad-active-conv', command: { action: 'close' } });
      activeConversation = 'conversation-1';
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 'wrong-turn', responseId: 'r-cal', canvasId: calendarItem.artifactId,
        selectionRevision: calRev, controlId: 'bad-turn', command: { action: 'close' } });
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't-epoch', responseId: 'r-epoch', canvasId: calendarItem.artifactId,
        selectionRevision: calRev, controlId: 'bad-epoch', command: { action: 'close' } },
        f.response.connectionEpoch - 1);
      f.event({ type: 'response.cancelled', turnId: 't-cal', responseId: 'r-cal', lastAudioSequence: null });
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't-cal', responseId: 'r-cal', canvasId: calendarItem.artifactId,
        selectionRevision: calRev, controlId: 'cancelled-req', command: { action: 'close' } });
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't-pre', responseId: 'r-pre', canvasId: calendarItem.artifactId,
        selectionRevision: calRev, controlId: 'pre-audio', command: { action: 'scroll', direction: 'down' } });
      f.event({ type: 'audio.start', turnId: 't-after', responseId: 'r-after',
        sampleRate: 24000, firstAudioSequence: 0 });
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't-pre', responseId: 'r-pre', canvasId: calendarItem.artifactId,
        selectionRevision: calRev, controlId: 'retired-req', command: { action: 'close' } });

      // Hidden chat/admin clears presentation binding; delayed command is rejected while media stays live.
      f.controller.updateCanvasInventory('conversation-1', merged, null);
      await settle();
      f.event({ type: 'canvas.control', conversationId: 'conversation-1',
        turnId: 't-after', responseId: 'r-after', canvasId: calendarItem.artifactId,
        selectionRevision: calRev, controlId: 'hidden-req', command: { action: 'close' } });
      expect(applyCal).toHaveBeenCalledTimes(4); // cal-zoom, cal-fit, cal-max, pre-audio only.
      expect(f.rtc.room.disconnect).not.toHaveBeenCalled();
    } finally { f.controller.exit(); await settle(); }
  });
});
