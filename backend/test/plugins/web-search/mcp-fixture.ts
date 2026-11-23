/**
 * ============================================================================
 * FILE: mcp-fixture.ts
 * LOCATION: backend/test/plugins/web-search/mcp-fixture.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Provide a deterministic Streamable HTTP wire fixture for the real SDK.
 *
 * ROLE IN PROJECT:
 *    Exercises initialization, discovery, and tool calls over actual SDK
 *    transport code without a mocked Client or any live provider request.
 *
 * KEY COMPONENTS:
 *    - mcpFixture: Fixed-origin JSON-RPC responder and request recorder.
 *    - setStatus/setResult/setSseChunks/setRawBody: Deterministic failure modes.
 *    - holdCall: Barrier for deadline, abort, and cleanup checks.
 * ============================================================================
 */

import { vi } from 'vitest';

const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
const requestBody = (body: BodyInit | null | undefined): string => {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  return body instanceof URLSearchParams ? body.toString() : '';
};

export type FixtureTool = { name: string; inputSchema: Record<string, unknown> };

export type FixtureCall = {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
};

export function mcpFixture(
  tools: FixtureTool[],
  options: { endpoint?: string } = {},
) {
  const endpoint = options.endpoint ?? 'https://mcp.exa.ai/mcp';
  const calls: FixtureCall[] = [];
  let response: unknown = { content: [{ type: 'text', text: '{"results":[]}' }] };
  let status: number | null = null;
  let callStatus: number | null = null;
  let location: string | null = null;
  let listCursor: string | null = null;
  let serverInfo: Record<string, unknown> = { name: 'fixture-only', version: '1' };
  let instructions: string | null = null;
  let rawBody: { bytes: Uint8Array; contentType: string } | null = null;
  let sseChunks: string[] | null = null;
  let held: { promise: Promise<void>; release: () => void } | null = null;
  let entered: (() => void) | null = null;

  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url !== endpoint) throw new Error('unexpected fixture endpoint');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = method === 'POST'
      ? JSON.parse(requestBody(init?.body) || '{}') as Record<string, unknown>
      : {};
    calls.push({ url, method, headers, body });
    if (method === 'GET') return new Response(null, { status: 405 });
    if (method === 'DELETE') return new Response(null, { status: 200 });
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (held && body.method === 'tools/call') {
      entered?.();
      await held.promise;
    }
    if (status !== null) {
      return new Response('fixture failure', {
        status, headers: location ? { Location: location } : undefined,
      });
    }
    if (callStatus !== null && body.method === 'tools/call') {
      return new Response('fixture call failure', { status: callStatus });
    }
    if (rawBody) {
      return new Response(rawBody.bytes, {
        status: 200, headers: { 'content-type': rawBody.contentType },
      });
    }
    if (sseChunks) {
      const chunks = sseChunks;
      sseChunks = null;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }
    const result = body.method === 'initialize' ? {
      protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo,
      ...(instructions === null ? {} : { instructions }),
    } : body.method === 'tools/list' ? {
      tools,
      ...(listCursor === null ? {} : { nextCursor: listCursor }),
    } : response;
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  });

  return {
    request,
    calls,
    endpoint,
    setResult(value: unknown) { response = value; },
    setStatus(value: number | null) { status = value; },
    setCallStatus(value: number | null) { callStatus = value; },
    setLocation(value: string | null) { location = value; },
    setListCursor(value: string | null) { listCursor = value; },
    setServerInfo(value: Record<string, unknown>) { serverInfo = value; },
    setInstructions(value: string | null) { instructions = value; },
    setRawBody(bytes: Uint8Array, contentType = 'application/json') {
      rawBody = { bytes, contentType };
    },
    setSseChunks(chunks: string[]) { sseChunks = chunks; },
    holdCall() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      held = { promise, release: () => { held = null; entered = null; release(); } };
      return { release: () => held?.release(), entered: enteredPromise };
    },
  };
}
