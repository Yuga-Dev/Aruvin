/**
 * ============================================================================
 * FILE: web-search-fixture.ts
 * LOCATION: backend/test/runtime/web-search-fixture.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Provide one deterministic WebSearchPort double and SSE frame helpers.
 *
 * ROLE IN PROJECT:
 *    Lets P3 runtime, Calendar, archive, and voice tests exercise the shared
 *    web loop without live MCP, OAuth, model, database, or paid calls.
 *
 * KEY COMPONENTS:
 *    - webPortFixture: Prepared/enabled account, issued tickets, hold/disable.
 *    - sse/textFrame/webToolFrame: Deterministic OpenRouter native wires.
 * ============================================================================
 */

import { vi } from 'vitest';
import type {
  ValidatedWebInput, WebCallContext, WebSearchPort,
} from '../../src/plugins/web-search/types.js';
import type { WebToolArguments, WebToolResult } from '../../src/contracts/web-search-tools.js';

export const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
export const done = 'data: [DONE]\n\n';
export const sse = (body: string) => new Response(body, {
  headers: { 'content-type': 'text/event-stream' },
});
export const textFrame = (text: string, id = 'gen_text') => event({ id, choices: [{ index: 0,
  delta: { content: text }, finish_reason: 'stop' }] }) + done;
export const webToolFrame = (raw: string, id = 'web_1', gen = 'gen_tool') => event({ id: gen,
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function',
    function: { name: 'web_tool', arguments: raw } }] }, finish_reason: 'tool_calls' }] }) + done;

export type WebPortFixture = {
  port: WebSearchPort;
  executed: ValidatedWebInput[];
  effects: { web: number };
  setEnabled(enabled: boolean): void;
  setPrepared(prepared: boolean): void;
  disconnect(): void;
  holdResult(): { entered: Promise<void>; release(): void };
};

const retrievedAt = '2026-11-14T00:00:00.000Z';

export function webPortFixture(options: {
  enabled?: boolean; prepared?: boolean; browse?: boolean; fetch?: boolean;
} = {}): WebPortFixture {
  let enabled = options.enabled ?? true;
  let prepared = options.prepared ?? true;
  let providers: Array<{ provider: 'exa'; capabilities: { browse: boolean; fetch: boolean } }> = [{
    provider: 'exa', capabilities: { browse: options.browse ?? true, fetch: options.fetch ?? true },
  }];
  let hold: { entered: () => void; wait: Promise<void> } | null = null;
  const executed: ValidatedWebInput[] = [];
  const effects = { web: 0 };
  const port: WebSearchPort = {
    snapshot: userId => ({
      userId, revision: 1, generation: 1, prepared, enabled, providers,
    }),
    validateInput: vi.fn(async (args: WebToolArguments, context: WebCallContext) => Object.freeze({
      args, userId: context.userId, turnId: context.turnId, toolCallId: context.toolCallId,
    })),
    execute: vi.fn(async (input: ValidatedWebInput, context: WebCallContext) => {
      effects.web += 1;
      executed.push(input);
      context.activity?.({ toolCallId: input.toolCallId, mode: input.args.mode,
        phase: input.args.mode === 'browse' ? 'searching' : 'reading', provider: null, code: null });
      if (hold) {
        hold.entered();
        await hold.wait;
        hold = null;
      }
      const value: WebToolResult = input.args.mode === 'browse'
        ? { ok: true as const, mode: 'browse' as const, provider: 'exa' as const, retrievedAt,
            results: [{ url: 'https://example.com/', title: 'Example',
              body: 'Useful public evidence.' }], truncated: false }
        : { ok: true as const, mode: 'fetch' as const, provider: 'exa' as const, retrievedAt,
            url: 'https://example.com/page', body: 'Public page.', truncated: false };
      if (value.ok) context.activity?.({ toolCallId: input.toolCallId, mode: input.args.mode,
        phase: 'completed', provider: 'exa', code: null });
      return value;
    }),
  };
  return {
    port, executed, effects,
    setEnabled(value) { enabled = value; },
    setPrepared(value) { prepared = value; },
    disconnect() { prepared = false; providers = []; },
    holdResult() {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      hold = { entered, wait };
      return { entered: ready, release };
    },
  };
}
