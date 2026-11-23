/**
 * ============================================================================
 * FILE: native-stream.ts
 * LOCATION: backend/src/model/native-stream.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Stream one bounded OpenRouter native completion with shared deadlines.
 *
 * ROLE IN PROJECT:
 *    Extracts the existing POST/SSE/deadline/cleanup transport so the web
 *    adapter and the Calendar wrapper use one implementation without a second
 *    model, retry loop, or inference service.
 *
 * KEY COMPONENTS:
 *    - NativeStreamHooks: Body, dispatch barrier, observation, frame, finish.
 *    - streamNativeCompletion: Bounded POST and SSE generator.
 * ============================================================================
 */

import { AppError } from '../platform/errors/app-error.js';
import { OPENROUTER_BASE, TRANSPORT_LIMITS, type ModelConfig } from './policy.js';
import { RunDeadlines, bounded, readJson } from './deadlines.js';
import { parseSse } from './sse.js';
import { identifier } from './accounting.js';
import { object, providerFault } from './faults.js';
import type { DiagnosticSink } from '../chat-runtime/ports.js';

export type NativeStreamHooks<T> = {
  body: () => Record<string, unknown>;
  beforeDispatch: () => Promise<void>;
  observe: (raw: unknown, ended: boolean) => Promise<void>;
  frame: (raw: unknown) => T[];
  finish: () => T[];
  /** Called once for a non-2xx response after its JSON body is observed. */
  rejected?: (http: Response, parsed: unknown, retryable: boolean) => T[];
  /** Called for transport/parse faults; must return bounded terminal chunks. */
  failed: (error: unknown) => T[];
  /** Last-moment wire projection after barrier/deadline checks; may throw. */
  lateBody?: (check: () => void) => Record<string, unknown> | undefined;
  report?: DiagnosticSink;
};

/**
 * One actual POST. A provider error is never retransmitted here; callers own
 * their finite pre-output rejection policy and must not replay a stream that
 * already produced output.
 */
export async function* streamNativeCompletion<T>(
  config: ModelConfig,
  signal: AbortSignal,
  deadlineAt: string,
  hooks: NativeStreamHooks<T>,
  fetcher: typeof fetch,
): AsyncGenerator<T> {
  if (signal.aborted) return;
  let body: Record<string, unknown>;
  try {
    body = hooks.body();
  } catch (error) {
    for (const chunk of hooks.failed(error)) yield chunk;
    return;
  }
  const deadlines = new RunDeadlines(config.budgets, signal, deadlineAt);
  try {
    if (deadlines.signal.aborted) {
      for (const chunk of hooks.failed(deadlines.failure())) yield chunk;
      return;
    }
    try {
      await bounded(hooks.beforeDispatch(), config.budgets.persistenceTimeoutMs,
        deadlines.signal, 'PERSISTENCE_ERROR');
    } catch (error) {
      for (const chunk of hooks.failed(error)) yield chunk;
      return;
    }
    deadlines.check();
    // Mode handling runs after every barrier and immediately before the POST;
    // its validation error stays a local failure, not an ambiguous send.
    if (hooks.lateBody) {
      try {
        const late = hooks.lateBody(() => deadlines.check());
        if (late) body = late;
      } catch (error) {
        for (const chunk of hooks.failed(error)) yield chunk;
        return;
      }
    }
    deadlines.armConnect();
    const startedAt = performance.now();
    hooks.report?.({ stage: 'model-dispatch', state: 'start', provider: 'openrouter',
      requestKind: 'model', origin: 'provider', delivery: 'attempted' });
    let http: Response;
    try {
      http = await fetcher(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openRouter.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Aurvin',
        },
        body: JSON.stringify(body),
        signal: deadlines.signal,
        redirect: 'error',
      });
    } catch {
      hooks.report?.({ stage: 'model-dispatch', state: 'error', provider: 'openrouter',
        requestKind: 'model', origin: 'provider', delivery: 'attempted',
        reason: 'provider-error', code: 'INTERRUPTED',
        durationMs: performance.now() - startedAt });
      deadlines.check();
      throw new AppError('INTERRUPTED', 'The response could not be confirmed. Retry to continue.', false);
    }
    hooks.report?.({ stage: 'model-response', state: http.ok ? 'ok' : 'error',
      provider: 'openrouter', requestKind: 'model', origin: 'provider',
      delivery: 'response-received', durationMs: performance.now() - startedAt,
      statusClass: http.status >= 500 ? '5xx' : http.status >= 400 ? '4xx'
        : http.status >= 300 ? '3xx' : http.status >= 200 ? '2xx' : 'other' });
    const headerId = identifier(http.headers.get('x-request-id')
      ?? http.headers.get('openrouter-request-id') ?? '');
    if (headerId) {
      hooks.report?.({ stage: 'model-response', provider: 'openrouter',
        providerRequestId: headerId, origin: 'provider', delivery: 'response-received' });
    }
    deadlines.headers();
    if (!http.ok) {
      const parsed = await readJson(http, TRANSPORT_LIMITS.jsonBytes);
      await hooks.observe(parsed, true);
      const retryable = http.status === 429 || http.status === 503;
      for (const chunk of hooks.rejected?.(http, parsed, retryable) ?? hooks.failed(
        providerFault(http.status, object(object(parsed).error).code))) yield chunk;
      return;
    }
    if (!http.body || !http.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      throw new AppError('PROVIDER_ERROR', 'The model service returned an invalid stream.', false);
    }
    let providerEnd = false;
    let sawFinish = false;
    for await (const frame of parseSse(http.body)) {
      deadlines.check();
      deadlines.frame();
      if (frame.type === 'comment') continue;
      if (frame.data === '[DONE]') {
        if (!sawFinish) throw new AppError('INTERRUPTED', 'The response stream ended early. Retry to continue.', false);
        providerEnd = true;
        break;
      }
      let raw: unknown;
      try { raw = JSON.parse(frame.data) as unknown; }
      catch { throw new AppError('PROVIDER_ERROR', 'The response stream was invalid.', false); }
      const top = object(raw);
      if (top.error !== undefined) {
        await hooks.observe(raw, false);
        const fault = providerFault(200, object(top.error).code);
        throw new AppError(fault.code, fault.message, false);
      }
      const choice = object(Array.isArray(top.choices) ? top.choices[0] : undefined);
      if (choice.finish_reason === 'stop' || choice.finish_reason === 'length'
        || choice.finish_reason === 'tool_calls') sawFinish = true;
      for (const chunk of hooks.frame(raw)) yield chunk;
      await hooks.observe(raw, false);
      if (raw && typeof raw === 'object' && Array.isArray((raw as { choices?: unknown }).choices)
        && ((raw as { choices: unknown[] }).choices.length > 0)) deadlines.firstText();
    }
    if (!providerEnd) throw new AppError('INTERRUPTED', 'The response stream ended early. Retry to continue.', false);
    deadlines.providerFinished();
    hooks.report?.({ stage: 'model-complete', state: 'ok', provider: 'openrouter',
      requestKind: 'model', durationMs: performance.now() - startedAt,
      origin: 'provider', delivery: 'response-received' });
    deadlines.check();
    await hooks.observe({}, true);
    for (const chunk of hooks.finish()) yield chunk;
  } catch (error) {
    if (deadlines.signal.aborted) {
      for (const chunk of hooks.failed(deadlines.failure())) yield chunk;
      return;
    }
    for (const chunk of hooks.failed(error)) yield chunk;
  } finally {
    deadlines.stop();
    deadlines.dispose();
  }
}
