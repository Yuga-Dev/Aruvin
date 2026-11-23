/**
 * ============================================================================
 * FILE: web-search-flow.test.ts
 * LOCATION: frontend/src/features/plugins/integration-tests/web-search-flow.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Exercise the real Web Search client, setup reducer, SSE parser, chat reducer,
 *    and safe source rendering across the frontend boundary.
 *
 * ROLE IN PROJECT:
 *    P5 integrated frontend evidence in the Node environment. It is not a browser
 *    interaction test and does not certify live provider or OAuth behaviour.
 *
 * KEY COMPONENTS:
 *    - Client/status: Five exact provider destinations and masked key input.
 *    - Connect/replace: Confirmed-only reducer state without candidate retention.
 *    - SSE: Actual ApiClient chunked stream into chat reducer and safe rendering.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ApiClient } from '../../../api/client.ts';
import { createWebSearchClient, WebSearchClientError } from '../../../api/web-search-client.ts';
import {
  WEB_SEARCH_PROVIDERS,
  type WebSearchPublicStatus,
} from '../../../api/web-search-protocol.ts';
import { WebSearchPanel } from '../web-search/WebSearchPanel.tsx';
import { WebSearchActivityView } from '../web-search/WebSearchActivityView.tsx';
import {
  createInitialWebSearchSetupState,
  mapWebClientError,
  webSearchSetupReducer,
} from '../web-search/web-search-setup-state.ts';
import { chatReducer, initialChatState } from '../../chat/state/chat-reducer.ts';
import type { ChatState } from '../../chat/state/chat-types.ts';

function statusOf(override: Partial<WebSearchPublicStatus> = {}): WebSearchPublicStatus {
  return {
    protocolVersion: 1, revision: 1, enabled: false, effectiveEnabled: false,
    providers: WEB_SEARCH_PROVIDERS.map(provider => ({
      provider, state: 'not-connected', authMethod: null,
      authSupport: { apiKey: 'unverified', browserAuthorization: 'unverified' },
      capabilities: { browse: false, fetch: false }, lastValidatedAt: null,
    })),
    ...override,
  };
}

function connectedStatus(): WebSearchPublicStatus {
  const base = statusOf({ revision: 2 });
  return {
    ...base,
    providers: base.providers.map(provider => provider.provider === 'exa'
      ? { ...provider, state: 'connected' as const, authMethod: 'api-key' as const,
          authSupport: { apiKey: 'supported' as const, browserAuthorization: 'unverified' as const },
          capabilities: { browse: true, fetch: false },
          lastValidatedAt: '2026-11-14T00:00:00.000Z' }
      : provider),
  };
}

it('[AC1][AC2] client status renders five ordered cards without enabling on connect', async () => {
  const status = statusOf();
  const fetcher = vi.fn<typeof fetch>(async input => {
    expect(String(input)).toBe('/api/plugins/web-search/status');
    return Response.json(status);
  });
  const client = createWebSearchClient({ fetch: fetcher });
  const parsed = await client.status();
  const state = webSearchSetupReducer(createInitialWebSearchSetupState(), {
    type: 'loaded', requestId: 1, status: parsed,
  });
  const html = renderToStaticMarkup(createElement(WebSearchPanel, { client, initialStatus: state.status! }));
  const names = ['TinyFish', 'Keenable', 'Exa', 'Tavily', 'Firecrawl'];
  const positions = names.map(name => html.indexOf(name));
  expect(positions.every(index => index >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(html).toContain('type="password"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(state.status?.enabled).toBe(false);
  expect(html).not.toContain('Connect Exa account');
});

it('[AC1] goal console destinations match the approved specification', async () => {
  // Approved goal destinations for all five providers.
  const client = createWebSearchClient({ fetch: async () => Response.json(statusOf()) });
  const html = renderToStaticMarkup(createElement(WebSearchPanel, {
    client, initialStatus: statusOf(),
  }));
  for (const url of [
    'https://agent.tinyfish.ai/api-keys', 'https://app.keenable.ai/',
    'https://dashboard.exa.ai/api-keys', 'https://app.tavily.com/home',
    'https://www.firecrawl.dev/app/api-keys',
  ]) expect(html).toContain(`href="${url}"`);
});

it('[AC2][AC9] connect response keeps the plugin off and never retains the candidate', async () => {
  const connected = connectedStatus();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe('/api/plugins/web-search/providers/exa/connect');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      protocolVersion: 1, expectedRevision: 1, candidate: 'fixture-key',
    });
    return Response.json(connected);
  });
  const client = createWebSearchClient({ fetch: fetcher });
  const parsed = await client.connectProvider('exa', {
    protocolVersion: 1, expectedRevision: 1, candidate: 'fixture-key',
  });
  let state = webSearchSetupReducer(createInitialWebSearchSetupState(statusOf()), {
    type: 'begin', requestId: 1, pending: { kind: 'connect', provider: 'exa' },
  });
  state = webSearchSetupReducer(state, { type: 'statusUpdated', requestId: 1, status: parsed });
  expect(state.status?.enabled).toBe(false);
  expect(state.status?.effectiveEnabled).toBe(false);
  expect(state.status?.providers.find(item => item.provider === 'exa')?.capabilities)
    .toEqual({ browse: true, fetch: false });
  expect(JSON.stringify(state)).not.toContain('fixture-key');
});

it('[AC2][AC9] failed replacement keeps the old confirmed status and safe error', async () => {
  const confirmed = connectedStatus();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({
    protocolVersion: 1,
    error: { code: 'WEB_INVALID_KEY', retryable: false, currentRevision: 2 },
  }, { status: 400 }));
  const client = createWebSearchClient({ fetch: fetcher });
  const error = await client.connectProvider('exa', {
    protocolVersion: 1, expectedRevision: 2, candidate: 'fixture-key',
  }).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(WebSearchClientError);
  if (!(error instanceof WebSearchClientError)) throw new Error('Expected safe client error.');
  let state = createInitialWebSearchSetupState(confirmed);
  state = webSearchSetupReducer(state, { type: 'openReplace', provider: 'exa' });
  state = webSearchSetupReducer(state, {
    type: 'begin', requestId: 1, pending: { kind: 'replace', provider: 'exa' },
  });
  state = webSearchSetupReducer(state, {
    type: 'failed', requestId: 1, message: mapWebClientError(error.code), code: error.code,
  });
  expect(state.status).toEqual(confirmed);
  expect(state.status?.providers.find(item => item.provider === 'exa')?.state).toBe('connected');
  expect(state.error).not.toContain('fixture-key');
  expect(state.error).not.toContain('provider detail');
});

it('[AC8][AC9] actual chunked SSE folds activity and safe sources into the chat reducer', async () => {
  const encoder = new TextEncoder();
  const envelope = (sequence: number, event: Record<string, unknown>) => ({
    protocolVersion: 1, sessionId: 'sess_1', turnId: 'turn_1', attemptId: 'att_1',
    sequence, event,
  });
  const safe = {
    sourceId: 'ws_safe', toolCallId: 'call_1', provider: 'exa', kind: 'browse',
    title: 'Example', url: 'https://example.com/', retrievedAt: '2026-11-14T00:00:00.000Z',
  };
  const unsafe = { ...safe, sourceId: 'ws_unsafe', url: 'javascript:alert(1)' };
  const frames = [
    envelope(0, { type: 'status', status: 'generating', truncated: false }),
    envelope(1, { type: 'web-activity', activity: {
      toolCallId: 'call_1', mode: 'browse', phase: 'searching', provider: 'exa', code: null,
    } }),
    envelope(2, { type: 'web-sources', sources: [safe] }),
    envelope(3, { type: 'web-sources', sources: [unsafe] }),
    envelope(4, { type: 'completed', assistantMessageId: 'msg_a', outcome: 'completed' }),
  ];
  const chunks = frames.map(frame => encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const client = new ApiClient({ fetch: async () => new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  }) });
  let state: ChatState = {
    ...initialChatState,
    activeSessionId: 'sess_1', activeTurnId: 'turn_1', activeAttemptId: 'att_1',
    isStreaming: true, streamText: 'Partial answer',
  };
  const errors: string[] = [];
  await client.connectTurnStream('/sessions/sess_1/turns/turn_1/stream', {
    onError: error => { errors.push(error.code); },
    onEnvelope: parsed => {
      if (parsed.event.type === 'web-activity') {
        state = chatReducer(state, { type: 'WEB_ACTIVITY', payload: {
          sessionId: parsed.sessionId, turnId: parsed.turnId, attemptId: parsed.attemptId,
          sequence: parsed.sequence, activity: parsed.event.activity,
        } });
      } else if (parsed.event.type === 'web-sources') {
        state = chatReducer(state, { type: 'WEB_SOURCES', payload: {
          sessionId: parsed.sessionId, turnId: parsed.turnId, attemptId: parsed.attemptId,
          sequence: parsed.sequence, sources: parsed.event.sources,
        } });
      } else if (parsed.event.type === 'completed') {
        state = chatReducer(state, { type: 'STREAM_COMPLETED', payload: {
          assistantMessageId: parsed.event.assistantMessageId, outcome: parsed.event.outcome,
        } });
      }
    },
  });
  expect(state.webSourcesByTurn['turn_1']).toBeUndefined();
  expect(errors).toContain('INVALID_STREAM_ENVELOPE');
  const assistant = state.messages.at(-1);
  expect(assistant?.webSources?.map(source => source.sourceId)).toEqual(['ws_safe']);
  expect(assistant?.webActivities?.[0]).toMatchObject({ toolCallId: 'call_1', phase: 'searching' });
  const html = renderToStaticMarkup(createElement(WebSearchActivityView, {
    activities: assistant?.webActivities ?? [], sources: assistant?.webSources ?? [],
  }));
  expect(html).toContain('href="https://example.com/"');
  expect(html).not.toContain('javascript:alert(1)');
  expect(html).toContain('exa');
});

it('[AC8] stale session/turn/attempt/sequence frames never attach to the active turn', () => {
  const state: ChatState = {
    ...initialChatState,
    activeSessionId: 'sess_1', activeTurnId: 'turn_1', activeAttemptId: 'att_1',
    isStreaming: true,
  };
  const source = {
    sourceId: 'ws_stale', toolCallId: 'call_1', provider: 'exa' as const, kind: 'browse' as const,
    title: 'Example', url: 'https://example.com/', retrievedAt: '2026-11-14T00:00:00.000Z',
  };
  for (const bad of [
    { sessionId: 'sess_2' }, { turnId: 'turn_2' }, { attemptId: 'att_2' },
  ]) {
    const next = chatReducer(state, { type: 'WEB_SOURCES', payload: {
      sessionId: 'sess_1', turnId: 'turn_1', attemptId: 'att_1', sequence: 1,
      sources: [source], ...bad,
    } });
    expect(next).toBe(state);
  }
});
