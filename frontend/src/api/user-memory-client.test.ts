/**
 * ============================================================================
 * FILE: user-memory-client.test.ts
 * LOCATION: frontend/src/api/user-memory-client.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify user-memory wire guards, instruction validation, and HTTP client.
 *
 * ROLE IN PROJECT:
 *    Locks /api/personalization/memory* routes, pre-network secret/cap checks,
 *    revision conflict handling, and bounded JSON decoding in Node Vitest.
 *
 * KEY COMPONENTS:
 *    - Protocol section rendering, char counting, and strict response guards.
 *    - Client GET / PATCH enabled / POST edit / POST clear and error mapping.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUserMemoryClient,
  UserMemoryClientError,
} from './user-memory-client.ts';
import {
  emptyUserMemorySections,
  isUserMemoryEditResponse,
  isUserMemoryErrorBody,
  isUserMemoryResponse,
  renderUserMemorySections,
  USER_MEMORY_INSTRUCTION_MAX_CHARS,
  USER_MEMORY_MAX_CHARS,
  userMemoryCharCount,
  validateMemoryInstruction,
  type UserMemoryEditResponse,
  type UserMemoryResponse,
} from './user-memory-protocol.ts';

function sampleMemory(overrides: Partial<UserMemoryResponse> = {}): UserMemoryResponse {
  const sections = overrides.sections ?? {
    ...emptyUserMemorySections(),
    identity: 'Name: Peter. Dog: Beans.',
  };
  const rendered = renderUserMemorySections(sections);
  return {
    protocolVersion: 1,
    revision: 1,
    enabled: true,
    sections,
    isEmpty: rendered.length === 0,
    charCount: userMemoryCharCount(rendered),
    maxChars: USER_MEMORY_MAX_CHARS,
    updatedAt: '2026-11-20T12:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('user-memory protocol helpers and guards', () => {
  it('renders non-empty sections in canonical order and counts Unicode code points', () => {
    const sections = {
      ...emptyUserMemorySections(),
      identity: 'Dog: Beans 🐶',
      preferences: 'Concise answers.',
    };
    const rendered = renderUserMemorySections(sections);
    expect(rendered).toBe('- Identity: Dog: Beans 🐶\n- Preferences: Concise answers.');
    expect(userMemoryCharCount('🐶')).toBe(1);
    expect(userMemoryCharCount(rendered)).toBe(Array.from(rendered).length);
  });

  it('validates composer instructions for empty, secret, control chars, and 500-char cap', () => {
    expect(validateMemoryInstruction('   ').error).toBe('required');
    expect(validateMemoryInstruction('Remember my key sk-or-v1-secret123').error).toBe('secret_pattern');
    expect(validateMemoryInstruction('mongodb+srv://user:pass@host/db').error).toBe('secret_pattern');
    expect(validateMemoryInstruction('Bad\u0007bell').error).toBe('disallowed_characters');
    expect(validateMemoryInstruction('a'.repeat(USER_MEMORY_INSTRUCTION_MAX_CHARS)).error).toBeNull();
    expect(validateMemoryInstruction('a'.repeat(USER_MEMORY_INSTRUCTION_MAX_CHARS + 1)).error).toBe('out_of_range');
    expect(validateMemoryInstruction('🐶'.repeat(USER_MEMORY_INSTRUCTION_MAX_CHARS)).error).toBeNull();
  });

  it('validates strict UserMemoryResponse, UserMemoryEditResponse, and UserMemoryErrorBody shapes', () => {
    const base = sampleMemory();
    expect(isUserMemoryResponse(base)).toBe(true);
    expect(isUserMemoryResponse({ ...base, extra: true })).toBe(false);
    expect(isUserMemoryResponse({ ...base, revision: 0, updatedAt: null, isEmpty: true, charCount: 0, sections: emptyUserMemorySections() })).toBe(true);
    expect(isUserMemoryResponse({ ...base, maxChars: 3000 })).toBe(false);

    const editRes: UserMemoryEditResponse = { ...base, changeSummary: 'Added dog Beans to Identity' };
    expect(isUserMemoryEditResponse(editRes)).toBe(true);
    expect(isUserMemoryEditResponse(base)).toBe(false);
    expect(isUserMemoryEditResponse({ ...editRes, changeSummary: 'sk-or-v1-leak' })).toBe(false);

    expect(
      isUserMemoryErrorBody({
        protocolVersion: 1,
        error: {
          code: 'MEMORY_CONFLICT',
          message: 'Memory changed elsewhere. Reload and try again.',
          retryable: false,
          currentRevision: 4,
        },
      }),
    ).toBe(true);
    expect(
      isUserMemoryErrorBody({
        protocolVersion: 1,
        error: { code: 'UNKNOWN', message: 'nope', retryable: false, currentRevision: null },
      }),
    ).toBe(false);
  });
});

describe('user-memory HTTP client', () => {
  it('calls GET, PATCH enabled, POST edit, and POST clear with no-store private fetch options', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createUserMemoryClient({ baseUrl: '/api/', fetch: fetcher });

    const initial = sampleMemory({ revision: 1, enabled: true });
    const paused = sampleMemory({ revision: 2, enabled: false });
    const edited: UserMemoryEditResponse = {
      ...sampleMemory({
        revision: 3,
        enabled: false,
        sections: { ...emptyUserMemorySections(), identity: 'Name: Peter. Dog: Beans.', work: 'Builds Aurvin.' },
      }),
      changeSummary: 'Updated Work',
    };
    const cleared = sampleMemory({
      revision: 4,
      enabled: false,
      sections: emptyUserMemorySections(),
    });

    fetcher
      .mockResolvedValueOnce(jsonResponse(initial))
      .mockResolvedValueOnce(jsonResponse(paused))
      .mockResolvedValueOnce(jsonResponse(edited))
      .mockResolvedValueOnce(jsonResponse(cleared));

    await expect(client.read()).resolves.toEqual(initial);
    await expect(client.setEnabled({ protocolVersion: 1, expectedRevision: 1, enabled: false })).resolves.toEqual(paused);
    await expect(
      client.edit({ protocolVersion: 1, expectedRevision: 2, instruction: '  I build Aurvin.  ' }),
    ).resolves.toEqual(edited);
    await expect(client.clear({ protocolVersion: 1, expectedRevision: 3 })).resolves.toEqual(cleared);

    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/personalization/memory');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      credentials: 'same-origin',
    });

    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/personalization/memory/enabled');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH', cache: 'no-store' });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      protocolVersion: 1,
      expectedRevision: 1,
      enabled: false,
    });

    expect(fetcher.mock.calls[2]?.[0]).toBe('/api/personalization/memory/edit');
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', cache: 'no-store' });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      protocolVersion: 1,
      expectedRevision: 2,
      instruction: 'I build Aurvin.',
    });

    expect(fetcher.mock.calls[3]?.[0]).toBe('/api/personalization/memory/clear');
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({ method: 'POST', cache: 'no-store' });
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({
      protocolVersion: 1,
      expectedRevision: 3,
    });
  });

  it('rejects invalid requests before fetch without hitting the network', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createUserMemoryClient({ fetch: fetcher });

    await expect(
      client.edit({ protocolVersion: 1, expectedRevision: 0, instruction: '   ' }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_MEMORY_REQUEST' });
    await expect(
      client.edit({ protocolVersion: 1, expectedRevision: 0, instruction: 'Use sk-or-v1-secret123' }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_MEMORY_REQUEST' });
    await expect(
      client.edit({ protocolVersion: 1, expectedRevision: 0, instruction: 'x'.repeat(501) }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_MEMORY_REQUEST' });
    await expect(
      client.clear({ protocolVersion: 1, expectedRevision: -1 }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_MEMORY_REQUEST' });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('surfaces 409 MEMORY_CONFLICT with currentRevision, 503 writer errors, and rejects oversized responses', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createUserMemoryClient({ fetch: fetcher });

    fetcher.mockResolvedValueOnce(
      jsonResponse(
        {
          protocolVersion: 1,
          error: {
            code: 'MEMORY_CONFLICT',
            message: 'Memory changed elsewhere. Reload and try again.',
            retryable: false,
            currentRevision: 7,
          },
        },
        409,
      ),
    );
    const conflict = await client
      .clear({ protocolVersion: 1, expectedRevision: 3 })
      .catch(err => err);
    expect(conflict).toBeInstanceOf(UserMemoryClientError);
    expect(conflict).toMatchObject({
      code: 'MEMORY_CONFLICT',
      status: 409,
      retryable: false,
      currentRevision: 7,
    });

    fetcher.mockResolvedValueOnce(
      jsonResponse(
        {
          protocolVersion: 1,
          error: {
            code: 'MEMORY_WRITER_UNAVAILABLE',
            message: 'The memory writer could not apply this request.',
            retryable: true,
            currentRevision: null,
          },
        },
        503,
      ),
    );
    await expect(
      client.edit({ protocolVersion: 1, expectedRevision: 7, instruction: 'Remember I like tea.' }),
    ).rejects.toMatchObject({
      code: 'MEMORY_WRITER_UNAVAILABLE',
      status: 503,
      retryable: true,
    });

    fetcher.mockResolvedValueOnce(new Response('x'.repeat(32_769), { status: 200 }));
    await expect(client.read()).rejects.toMatchObject({
      code: 'INVALID_USER_MEMORY_RESPONSE',
      status: 200,
    });
  });

  it('classifies caller abort and request timeout cleanly', async () => {
    const abort = new AbortController();
    const hanging = vi.fn<typeof fetch>((_url, init) => new Promise((_, reject) => {
      const fail = () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener('abort', fail, { once: true });
    }));
    const client = createUserMemoryClient({ fetch: hanging });

    const abortedRead = client.read(abort.signal);
    abort.abort();
    await expect(abortedRead).rejects.toMatchObject({ code: 'ABORTED', retryable: false });

    vi.useFakeTimers();
    const timedOut = client.read();
    const expectation = expect(timedOut).rejects.toMatchObject({
      code: 'USER_MEMORY_REQUEST_TIMEOUT',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
  });
});
