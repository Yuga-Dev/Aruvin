# Web Search Plugin — P4 Frontend Plugin, Setup/Config UI, and Source Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement P4 — mirror the frozen P1 admin-config and voice wire contracts into the frontend, add the secret-free Web Search plugin protocol/client and `Plugins -> Web Search` UI (global default-off toggle, five fixed ordered provider cards with verified key instructions and optional capability-gated browser authorization), add `Config -> Web Search` turn budget controls (`1..20`, default `5/5`), and render concise text and live voice web activity plus strict HTTP(S)-only source citations with no Composer toggle and zero browser secret exposure.

**Architecture:** P1's backend contracts (`web-search-policy.ts`, `web-search-wire.ts`, `admin-config-wire.ts`, `voice-wire.ts`, `stream.ts`, `api.ts`) remain the single source of truth. The browser never validates credentials locally beyond bounded syntax, never stores or logs candidate keys or tokens (`localStorage`/`sessionStorage`/DOM/`VITE_*`), never uses external provider overrides in chat/voice turn requests, and enforces strict HTTP(S) sanitization (`sanitizeWebSourceUrl`) on every rendered link. Live SSE and LiveKit voice frames project bounded progress (`searching`/`reading`/`fallback`/`completed`/`failed`/`cancelled`) and verified HTTP(S) sources without modifying existing Calendar plugin behavior or adding any Composer toggle.

**Tech Stack:** React 19, TypeScript (`~6.0.2`, Node/Bundler ESM with `.ts` extensions in frontend imports), Vite 8, Vitest 4 (`environment: 'node'`, `renderToStaticMarkup` + pure reducer/controller/protocol/client unit tests), oxlint, plain CSS (`admin-config.css`, `chat.css`, `live-voice.css`, `web-search-plugin.css`).

**MAW / Execution Constraints:**
- Per repository instructions, unified review is **skipped** (never recorded as passed); meaningful unit tests, contract mirror assertions, defect fixes, and final build/lint/test verification remain required.
- Every new TypeScript/TSX/CSS code file MUST begin with the mandatory `AGENTS.md` file header (`FILE`, `LOCATION`, `PURPOSE`, `ROLE IN PROJECT`, `KEY COMPONENTS`). Existing files modified `>30%` also require the header if missing.
- Keep `backend/src/contracts/**`, `frontend/src/features/plugins/google-calendar/**`, `frontend/src/api/calendar-*.ts`, and `frontend/src/components/Composer.tsx` untouched (except adding non-toggle assertions in `Composer.test.ts` and running existing backend mirror specs).
- Do not install packages or run paid/live provider checks.

---

## File Ownership & P2/P3 Dependencies

### P4-Owned New Files
- `frontend/src/api/web-search-protocol.ts`
- `frontend/src/api/web-search-protocol.test.ts`
- `frontend/src/api/web-search-client.ts`
- `frontend/src/api/web-search-client.test.ts`
- `frontend/src/features/plugins/web-search/web-search-setup-state.ts`
- `frontend/src/features/plugins/web-search/web-search-setup-state.test.ts`
- `frontend/src/features/plugins/web-search/WebSearchPanel.tsx`
- `frontend/src/features/plugins/web-search/web-search-panel.test.ts`
- `frontend/src/features/plugins/web-search/web-search-plugin.css`
- `frontend/src/features/plugins/web-search/web-search-presentation.ts`
- `frontend/src/features/plugins/web-search/web-search-presentation.test.ts`
- `frontend/src/features/plugins/web-search/WebSearchActivityView.tsx`
- `frontend/src/features/plugins/web-search/index.ts`
- `frontend/src/features/chat/state/web-search-chat-state.test.ts`

### P4-Owned Modified Files
- `frontend/src/api/admin-config-protocol.ts` (exact mirror of `backend/src/contracts/admin-config-wire.ts` after `ADMIN_CONFIG_PROTOCOL_VERSION`, CRLF preserved)
- `frontend/src/api/voice-protocol.ts` (exact mirror of `backend/src/contracts/voice-wire.ts` `web.frame` additions, CRLF preserved)
- `frontend/src/api/testing/voice-fixtures.test.ts` (strip `web-search` import in `stripCalendarExtension`)
- `frontend/src/api/voice-protocol.test.ts` (`web.frame` live acceptance, dictation rejection, 16,384-byte limit)
- `frontend/src/api/protocol.ts` & `frontend/src/api/protocol.test.ts` (`web-activity`, `web-sources`, `completed` attachments, assistant-only `VisibleMessage`/`VoiceTranscriptItem`)
- `frontend/src/api/client.test.ts` (SSE parsing of `web-activity`, `web-sources`, `completed`)
- `frontend/src/features/chat/markdown/sanitize-url.ts` & `frontend/src/features/chat/markdown/markdown.test.ts` (strict `sanitizeWebSourceUrl` and `isSafeHttpsAuthorizationUrl`, preserving Markdown `sanitizeUrl`)
- `frontend/src/features/admin-config/testing/fixtures.ts` (`webSearch: { maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 }`)
- `frontend/src/features/admin-config/config-edit-state.ts` & `frontend/src/features/admin-config/config-edit-state.test.ts` (`'webSearch'` section, `maxSearchesPerTurn` / `maxFetchesPerTurn` 1..20)
- `frontend/src/features/admin-config/AdminDashboard.tsx`, `frontend/src/features/admin-config/admin-dashboard.test.ts`, `frontend/src/features/admin-config/role-aware-dashboard.test.ts` (`CONFIG_SECTIONS`, `PLUGIN_SECTIONS`, `WebSearchPanel` mounting)
- `frontend/src/App.tsx` & `frontend/src/App.assembly.test.ts` (`webSearchClient` injection, OAuth callback query extraction & URL scrubbing)
- `frontend/src/features/chat/state/chat-types.ts`, `chat-reducer.ts`, `use-chat.ts`
- `frontend/src/components/Transcript.tsx`, `MessageItem.tsx`, `MessageItem.test.ts`, `group-voice-messages.ts`, `VoiceTranscriptModal.tsx`, `VoiceTranscriptModal.test.ts`, `Composer.test.ts`, `frontend/src/styles/chat.css`
- `frontend/src/features/voice/state/live-voice-reducer.ts`, `live-voice-reducer.test.ts`, `live-voice-controller.ts`, `live-voice-controller.test.ts`, `frontend/src/features/voice/live/LiveVoicePanel.tsx`, `live-voice-surface.test.ts`, `live-voice.css`

### Upstream P1 / P2 / P3 Boundaries (Not Modified by P4)
- **P1 (`complete`):** Frozen schemas in `backend/src/contracts/web-search-policy.ts`, `web-search-wire.ts`, `admin-config-wire.ts`, `voice-wire.ts`, `stream.ts`, `api.ts`. Read `backend/src/contracts/web-search-wire.ts` during Task 2 if asserting 1:1 `WEB_TOOL_ERROR_CODES` array parity.
- **P2 (`pending` — backend REST/storage/OAuth):** Owns HTTP routes under `WEB_SEARCH_ROUTES` (`/plugins/web-search/status`, `settings`, `providers/:provider/connect|disconnect|oauth/start|oauth/callback|oauth/complete`) and persistence/encryption. Coordinate OAuth browser return convention: if `GET /plugins/web-search/providers/:provider/oauth/callback` returns to the SPA, it must redirect to `/?plugin=web-search&provider=<provider>&<rawQuery>` (when frontend calls `oauthComplete`) or `/?plugin=web-search&provider=<provider>&oauth=<connected|denied|expired|failed>`.
- **P3 (`pending` — backend agent/runtime streaming):** Owns emitting `web-activity`, `web-sources`, and `completed.webSources`/`webActivities` over text SSE, saving assistant-only provenance on messages, and sending `web.frame` payloads over LiveKit voice control. Until P2 and P3 land, live runtime integration cannot be executed against the backend.

---

## Task 1: Strict Web Source & HTTPS URL Sanitization (`sanitize-url.ts`)

**Files:**
- Modify: `frontend/src/features/chat/markdown/sanitize-url.ts`
- Modify: `frontend/src/features/chat/markdown/markdown.test.ts`

- [ ] **Step 1: Write failing tests for strict HTTP(S)-only source URLs and HTTPS-only OAuth URLs**

Append to `frontend/src/features/chat/markdown/markdown.test.ts` (updating the import from `./sanitize-url.ts` to include `sanitizeWebSourceUrl` and `isSafeHttpsUrl`):

```ts
import { isSafeHttpsUrl, sanitizeUrl, sanitizeWebSourceUrl } from './sanitize-url.ts';

describe('sanitizeWebSourceUrl and isSafeHttpsUrl', () => {
  it('accepts valid absolute http and https source URLs within byte limits', () => {
    expect(sanitizeWebSourceUrl('https://example.com/docs?q=1#top')).toBe(
      'https://example.com/docs?q=1#top',
    );
    expect(sanitizeWebSourceUrl('http://news.example.org/item')).toBe(
      'http://news.example.org/item',
    );
    expect(isSafeHttpsUrl('https://agent.tinyfish.ai')).toBe(true);
  });

  it('rejects mailto, relative paths, hashes, credentials, whitespace, dangerous schemes, and oversized URLs', () => {
    for (const unsafe of [
      '',
      '   ',
      ' https://example.com/',
      'https://example.com/ ',
      'https://example.com/a\nb',
      'mailto:peter@example.com',
      '/docs/quickstart',
      '#heading-1',
      '//evil.example.com/phish',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/123',
      'ftp://example.com/file',
      'https://user:pass@example.com/',
      `https://example.com/${'a'.repeat(1024)}`,
    ]) {
      expect(sanitizeWebSourceUrl(unsafe)).toBe('');
      expect(isSafeHttpsUrl(unsafe)).toBe(false);
    }
    expect(isSafeHttpsUrl('http://example.com/oauth')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`):
```powershell
npm test -- src/features/chat/markdown/markdown.test.ts
```
Expected: FAIL because `sanitizeWebSourceUrl` and `isSafeHttpsUrl` are not exported yet.

- [ ] **Step 3: Implement `sanitizeWebSourceUrl` and `isSafeHttpsUrl` in `sanitize-url.ts` without breaking Markdown `sanitizeUrl`**

Edit `frontend/src/features/chat/markdown/sanitize-url.ts`:

```ts
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const WEB_HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_WEB_URL_BYTES = 1_024;
const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007f]/u;

function parseBoundedUrl(raw: string, protocols: ReadonlySet<string>, maxBytes = MAX_WEB_URL_BYTES): string {
  if (!raw || raw !== raw.trim() || CONTROL_OR_SPACE_RE.test(raw)) return '';
  if (new TextEncoder().encode(raw).byteLength > maxBytes) return '';
  try {
    const parsed = new URL(raw);
    if (!protocols.has(parsed.protocol)) return '';
    if (!parsed.hostname || parsed.username || parsed.password) return '';
    return raw;
  } catch {
    return '';
  }
}

export function sanitizeWebSourceUrl(url: string): string {
  return parseBoundedUrl(url, WEB_HTTP_PROTOCOLS, MAX_WEB_URL_BYTES);
}

export function isSafeHttpsUrl(url: string, maxBytes = 2_048): boolean {
  return parseBoundedUrl(url, new Set(['https:']), maxBytes) !== '';
}
```
Keep the existing `export function sanitizeUrl(url: string): string` implementation unchanged so existing Markdown/mailto/relative-path behavior and tests remain intact.

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`):
```powershell
npm test -- src/features/chat/markdown/markdown.test.ts
```
Expected: PASS (all existing `sanitizeUrl` tests + new `sanitizeWebSourceUrl` & `isSafeHttpsUrl` tests green).

- [ ] **Step 5: Commit**

```powershell
git add -- frontend/src/features/chat/markdown/sanitize-url.ts frontend/src/features/chat/markdown/markdown.test.ts
git commit -m "feat(frontend): add strict HTTP(S)-only web source URL sanitization"
```

---

## Task 2: Web Search Protocol, Provider Catalog, and OAuth Callback Extractor (`web-search-protocol.ts`)

**Files:**
- Create: `frontend/src/api/web-search-protocol.ts`
- Create: `frontend/src/api/web-search-protocol.test.ts`

- [ ] **Step 1: Write failing protocol tests covering status, secret rejection, error codes, OAuth bounds, sources, activities, and callback scrubbing**

Create `frontend/src/api/web-search-protocol.test.ts` (including mandatory header):

```ts
/**
 * ============================================================================
 * FILE: web-search-protocol.test.ts
 * LOCATION: frontend/src/api/web-search-protocol.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify frontend web-search wire guards, provider order, bounds, and URL rules.
 *
 * ROLE IN PROJECT:
 *    Prevents raw credentials, client overrides, oversized payloads, invalid
 *    connection states, or non-HTTP(S) URLs from entering UI state.
 *
 * KEY COMPONENTS:
 *    - Status, provider catalog, and request/response guards
 *    - WebSourceReference and WebSearchActivity bounds and invariants
 *    - OAuth URL validation and callback parameter extraction/scrubbing
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_SEARCH_ENABLED,
  DEFAULT_WEB_SEARCH_LIMITS,
  WEB_SEARCH_HTTP_ERROR_CODES,
  WEB_SEARCH_HTTP_ERRORS,
  WEB_SEARCH_POLICY,
  WEB_SEARCH_PROVIDER_CATALOG,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_ROUTES,
  extractAndScrubWebSearchOAuthCallback,
  isWebPresentationEvent,
  isWebSearchActivity,
  isWebSearchActivityList,
  isWebSearchConnectRequest,
  isWebSearchDisconnectRequest,
  isWebSearchHttpError,
  isWebSearchLimits,
  isWebSearchOAuthCompleteRequest,
  isWebSearchOAuthStartResponse,
  isWebSearchPublicStatus,
  isWebSearchSettingsRequest,
  isWebSourceReference,
  isWebSourceReferenceList,
  type WebSearchPublicStatus,
} from './web-search-protocol.ts';

function disconnectedStatus(): WebSearchPublicStatus {
  return {
    protocolVersion: 1,
    revision: 0,
    enabled: false,
    effectiveEnabled: false,
    providers: WEB_SEARCH_PROVIDERS.map((provider) => ({
      provider,
      state: 'not-connected',
      authMethod: null,
      authSupport: { apiKey: 'unverified', browserAuthorization: 'unverified' },
      capabilities: { browse: false, fetch: false },
      lastValidatedAt: null,
    })),
  };
}

const sourceFixture = {
  sourceId: 'src_1',
  toolCallId: 'call_1',
  provider: 'exa' as const,
  kind: 'browse' as const,
  title: 'Example Docs',
  url: 'https://example.com/docs',
  retrievedAt: '2026-11-14T00:00:00.000Z',
};

describe('web-search-protocol', () => {
  it('freezes default-off policy, 5/5 defaults, routes, and ordered provider catalog', () => {
    expect(DEFAULT_WEB_SEARCH_ENABLED).toBe(false);
    expect(DEFAULT_WEB_SEARCH_LIMITS).toEqual({ maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 });
    expect(WEB_SEARCH_PROVIDERS).toEqual(['tinyfish', 'keenable', 'exa', 'tavily', 'firecrawl']);
    expect(WEB_SEARCH_PROVIDER_CATALOG.map((item) => item.provider)).toEqual([...WEB_SEARCH_PROVIDERS]);
    expect(WEB_SEARCH_ROUTES.status).toBe('/plugins/web-search/status');
    expect(WEB_SEARCH_ROUTES.settings).toBe('/plugins/web-search/settings');
    expect(WEB_SEARCH_ROUTES.connect('exa')).toBe('/plugins/web-search/providers/exa/connect');
    expect(WEB_SEARCH_ROUTES.disconnect('tavily')).toBe('/plugins/web-search/providers/tavily/disconnect');
    expect(WEB_SEARCH_ROUTES.oauthStart('tinyfish')).toBe('/plugins/web-search/providers/tinyfish/oauth/start');
    expect(WEB_SEARCH_ROUTES.oauthComplete('firecrawl')).toBe('/plugins/web-search/providers/firecrawl/oauth/complete');
    for (const entry of WEB_SEARCH_PROVIDER_CATALOG) {
      expect(entry.consoleUrl.startsWith('https://')).toBe(true);
    }
  });

  it('validates WebSearchLimits integers bounded 1..20', () => {
    expect(isWebSearchLimits({ maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 })).toBe(true);
    expect(isWebSearchLimits({ maxSearchesPerTurn: 1, maxFetchesPerTurn: 20 })).toBe(true);
    for (const bad of [
      { maxSearchesPerTurn: 0, maxFetchesPerTurn: 5 },
      { maxSearchesPerTurn: 21, maxFetchesPerTurn: 5 },
      { maxSearchesPerTurn: 1.5, maxFetchesPerTurn: 5 },
      { maxSearchesPerTurn: 5, maxFetchesPerTurn: 5, extra: true },
    ]) {
      expect(isWebSearchLimits(bad)).toBe(false);
    }
  });

  it('validates public status order, effectiveEnabled invariant, capabilities, and secret rejection', () => {
    const base = disconnectedStatus();
    expect(isWebSearchPublicStatus(base)).toBe(true);
    expect(isWebSearchPublicStatus({ ...base, effectiveEnabled: true })).toBe(false);
    expect(isWebSearchPublicStatus({ ...base, enabled: true })).toBe(true);
    expect(isWebSearchPublicStatus({ ...base, enabled: true, effectiveEnabled: true })).toBe(false);
    expect(isWebSearchPublicStatus({ ...base, providers: [...base.providers].reverse() })).toBe(false);
    expect(isWebSearchPublicStatus({ ...base, providers: base.providers.slice(1) })).toBe(false);

    const withConnected: WebSearchPublicStatus = {
      ...base,
      revision: 2,
      enabled: true,
      effectiveEnabled: true,
      providers: base.providers.map((item) =>
        item.provider === 'exa'
          ? {
              ...item,
              state: 'connected',
              authMethod: 'api-key',
              authSupport: { apiKey: 'supported', browserAuthorization: 'unsupported' },
              capabilities: { browse: true, fetch: true },
              lastValidatedAt: sourceFixture.retrievedAt,
            }
          : item,
      ),
    };
    expect(isWebSearchPublicStatus(withConnected)).toBe(true);

    const noCapabilities = {
      ...withConnected,
      providers: withConnected.providers.map((item) =>
        item.provider === 'exa' ? { ...item, capabilities: { browse: false, fetch: false } } : item,
      ),
    };
    expect(isWebSearchPublicStatus(noCapabilities)).toBe(false);

    for (const secretField of ['candidate', 'apiKey', 'accessToken', 'refreshToken', 'envelope', 'userId', 'endpoint']) {
      expect(isWebSearchPublicStatus({ ...withConnected, [secretField]: 'leaked' })).toBe(false);
      expect(
        isWebSearchPublicStatus({
          ...withConnected,
          providers: withConnected.providers.map((item, idx) =>
            idx === 0 ? { ...item, [secretField]: 'leaked' } : item,
          ),
        }),
      ).toBe(false);
    }
  });

  it('validates write-only mutations, bounded candidates, HTTP errors, and HTTPS OAuth responses', () => {
    expect(isWebSearchSettingsRequest({ protocolVersion: 1, expectedRevision: 0, enabled: true })).toBe(true);
    expect(isWebSearchSettingsRequest({ protocolVersion: 1, expectedRevision: 0, enabled: true, userId: 'u' })).toBe(false);
    expect(isWebSearchConnectRequest({ protocolVersion: 1, expectedRevision: 1, candidate: 'key-123' })).toBe(true);
    for (const candidate of ['', ' key ', 'a\nb', 'x'.repeat(WEB_SEARCH_POLICY.maxApiKeyBytes + 1), '😀'.repeat(1025)]) {
      expect(isWebSearchConnectRequest({ protocolVersion: 1, expectedRevision: 1, candidate })).toBe(false);
    }
    expect(isWebSearchDisconnectRequest({ protocolVersion: 1, expectedRevision: 1, confirm: true })).toBe(true);
    expect(isWebSearchDisconnectRequest({ protocolVersion: 1, expectedRevision: 1, confirm: false })).toBe(false);

    expect(
      isWebSearchOAuthStartResponse({
        protocolVersion: 1,
        authorizationUrl: 'https://provider.example.com/oauth/authorize?state=public',
        expiresAt: sourceFixture.retrievedAt,
      }),
    ).toBe(true);
    for (const url of [
      'http://provider.example.com/oauth',
      'javascript:alert(1)',
      'https://u:p@provider.example.com/oauth',
      'https://provider.example.com/oauth?access_token=secret',
      'https://provider.example.com/oauth?apiKey=secret',
    ]) {
      expect(
        isWebSearchOAuthStartResponse({
          protocolVersion: 1,
          authorizationUrl: url,
          expiresAt: sourceFixture.retrievedAt,
        }),
      ).toBe(false);
    }
    expect(isWebSearchOAuthCompleteRequest({ protocolVersion: 1, rawQuery: 'code=abc&state=xyz' })).toBe(true);
    expect(isWebSearchOAuthCompleteRequest({ protocolVersion: 1, rawQuery: 'x'.repeat(4097) })).toBe(false);

    for (const code of WEB_SEARCH_HTTP_ERROR_CODES) {
      expect(
        isWebSearchHttpError({
          protocolVersion: 1,
          error: { code, retryable: WEB_SEARCH_HTTP_ERRORS[code].retryable, currentRevision: null },
        }),
      ).toBe(true);
    }
    expect(
      isWebSearchHttpError({
        protocolVersion: 1,
        error: { code: 'WEB_INVALID_KEY', retryable: false, currentRevision: 1, message: 'raw' },
      }),
    ).toBe(false);
  });

  it('enforces WebSourceReference, WebSearchActivity, and WebPresentationEvent bounds and invariants', () => {
    expect(isWebSourceReference(sourceFixture)).toBe(true);
    expect(isWebSourceReference({ ...sourceFixture, url: 'javascript:alert(1)' })).toBe(false);
    expect(isWebSourceReference({ ...sourceFixture, url: 'https://example.com/?apiKey=secret' })).toBe(false);
    expect(isWebSourceReferenceList([sourceFixture, sourceFixture])).toBe(false);
    expect(
      isWebSourceReferenceList(
        Array.from({ length: WEB_SEARCH_POLICY.maxSourcesPerMessage + 1 }, (_, i) => ({
          ...sourceFixture,
          sourceId: `src_${i}`,
        })),
      ),
    ).toBe(false);
    expect(
      isWebSourceReferenceList(
        Array.from({ length: 15 }, (_, i) => ({
          ...sourceFixture,
          sourceId: `src_${i}`,
          title: '界'.repeat(160),
          url: `https://example.com/${'x'.repeat(950)}`,
        })),
      ),
    ).toBe(false);

    const browseOk = {
      toolCallId: 'call_1',
      mode: 'browse' as const,
      phase: 'searching' as const,
      provider: 'tinyfish' as const,
      code: null,
    };
    const fetchOk = {
      toolCallId: 'call_2',
      mode: 'fetch' as const,
      phase: 'reading' as const,
      provider: 'exa' as const,
      code: null,
    };
    const failedOk = {
      toolCallId: 'call_3',
      mode: 'fetch' as const,
      phase: 'failed' as const,
      provider: 'exa' as const,
      code: 'WEB_URL_UNSAFE',
    };
    expect(isWebSearchActivity(browseOk)).toBe(true);
    expect(isWebSearchActivity(fetchOk)).toBe(true);
    expect(isWebSearchActivity(failedOk)).toBe(true);
    expect(isWebSearchActivity({ ...browseOk, phase: 'reading' })).toBe(false);
    expect(isWebSearchActivity({ ...fetchOk, phase: 'searching' })).toBe(false);
    expect(isWebSearchActivity({ ...browseOk, phase: 'failed', code: null })).toBe(false);
    expect(isWebSearchActivity({ ...browseOk, phase: 'completed', code: 'WEB_URL_UNSAFE' })).toBe(false);
    expect(isWebSearchActivity({ ...browseOk, query: 'leak' })).toBe(false);
    expect(
      isWebSearchActivityList(
        Array.from({ length: WEB_SEARCH_POLICY.maxActivitiesPerMessage + 1 }, (_, i) => ({
          ...browseOk,
          toolCallId: `call_${i}`,
        })),
      ),
    ).toBe(false);

    expect(isWebPresentationEvent({ type: 'web-activity', activity: browseOk })).toBe(true);
    expect(isWebPresentationEvent({ type: 'web-sources', sources: [sourceFixture] })).toBe(true);
    expect(isWebPresentationEvent({ type: 'web-activity', activity: browseOk, extra: true })).toBe(false);
  });

  it('extracts and scrubs Web Search OAuth callback parameters without touching Calendar callbacks', () => {
    expect(
      extractAndScrubWebSearchOAuthCallback(
        'http://127.0.0.1:5173/?plugin=google-calendar&oauth=connected&code=secret&state=nonce',
      ),
    ).toBeNull();

    expect(
      extractAndScrubWebSearchOAuthCallback(
        'http://127.0.0.1:5173/?plugin=web-search&provider=exa&code=oauth_code&state=oauth_state&keep=1',
      ),
    ).toEqual({
      kind: 'complete-query',
      provider: 'exa',
      rawQuery: 'plugin=web-search&provider=exa&code=oauth_code&state=oauth_state&keep=1',
      scrubbedPathAndSearch: '/?keep=1',
    });

    expect(
      extractAndScrubWebSearchOAuthCallback(
        'http://127.0.0.1:5173/?section=web-search&provider=tavily&oauth=connected',
      ),
    ).toEqual({
      kind: 'resolved',
      provider: 'tavily',
      outcome: 'connected',
      scrubbedPathAndSearch: '/',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`):
```powershell
npm test -- src/api/web-search-protocol.test.ts
```
Expected: FAIL because `frontend/src/api/web-search-protocol.ts` does not exist yet.

- [ ] **Step 3: Implement `frontend/src/api/web-search-protocol.ts`**

> **Parity note:** When implementing this file, verify `WEB_TOOL_ERROR_CODES` against `webToolErrorCodeSchema` in `backend/src/contracts/web-search-wire.ts` so every server-emitted `WebToolErrorCode` is included explicitly in `WEB_TOOL_ERROR_CODES` as well as matching `/^WEB_[A-Z0-9_]{1,60}$/`.

Create `frontend/src/api/web-search-protocol.ts`:

```ts
/**
 * ============================================================================
 * FILE: web-search-protocol.ts
 * LOCATION: frontend/src/api/web-search-protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Provide secret-free Web Search wire contracts, provider catalog metadata,
 *    runtime structural guards, and OAuth callback scrubbing for the browser.
 *
 * ROLE IN PROJECT:
 *    Mirrors frozen P1 backend web-search policy and wire shapes using pure
 *    runtime guards without Zod or backend runtime imports.
 *
 * KEY COMPONENTS:
 *    - WEB_SEARCH_PROVIDERS / WEB_SEARCH_PROVIDER_CATALOG: Priority 1..5 providers.
 *    - WEB_SEARCH_ROUTES / WEB_SEARCH_HTTP_ERRORS: REST routes and closed errors.
 *    - isWebSearchPublicStatus / isWebPresentationEvent: Strict boundary guards.
 *    - extractAndScrubWebSearchOAuthCallback: OAuth query capture & history scrub.
 * ============================================================================
 */

import { isSafeHttpsUrl, sanitizeWebSourceUrl } from '../features/chat/markdown/sanitize-url.ts';

export const WEB_SEARCH_PROTOCOL_VERSION = 1 as const;

export const WEB_SEARCH_PROVIDERS = [
  'tinyfish',
  'keenable',
  'exa',
  'tavily',
  'firecrawl',
] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export type WebSearchMode = 'browse' | 'fetch';

export type WebSearchLimits = {
  maxSearchesPerTurn: number;
  maxFetchesPerTurn: number;
};

export const DEFAULT_WEB_SEARCH_ENABLED = false as const;

export const DEFAULT_WEB_SEARCH_LIMITS: Readonly<WebSearchLimits> = Object.freeze({
  maxSearchesPerTurn: 5,
  maxFetchesPerTurn: 5,
});

export const WEB_SEARCH_POLICY = Object.freeze({
  maxSourcesPerMessage: 15,
  maxSourceProvenanceBytes: 12_000,
  maxActivitiesPerMessage: 40,
  maxActivityProjectionBytes: 12_000,
  maxTitleChars: 160,
  maxSourceUrlChars: 1_024,
  maxHttpBodyBytes: 16_384,
  maxApiKeyBytes: 4_096,
  maxOAuthRawQueryBytes: 4_096,
  oauthStateTtlMs: 600_000,
});

export const WEB_SEARCH_ROUTES = {
  status: '/plugins/web-search/status',
  settings: '/plugins/web-search/settings',
  connect: (provider: WebSearchProvider) => `/plugins/web-search/providers/${provider}/connect`,
  disconnect: (provider: WebSearchProvider) => `/plugins/web-search/providers/${provider}/disconnect`,
  oauthStart: (provider: WebSearchProvider) => `/plugins/web-search/providers/${provider}/oauth/start`,
  oauthCallback: (provider: WebSearchProvider) => `/plugins/web-search/providers/${provider}/oauth/callback`,
  oauthComplete: (provider: WebSearchProvider) => `/plugins/web-search/providers/${provider}/oauth/complete`,
} as const;

export type WebSearchAuthSupport = 'supported' | 'unsupported' | 'unverified';
export type WebSearchAuthMethod = 'api-key' | 'oauth';

export const WEB_SEARCH_CONNECTION_STATES = [
  'not-connected',
  'connecting',
  'connected',
  'invalid-key',
  'unavailable',
  'reconnect-required',
  'unsupported',
] as const;
export type WebSearchConnectionState = (typeof WEB_SEARCH_CONNECTION_STATES)[number];

export const WEB_SEARCH_ACTIVITY_PHASES = [
  'searching',
  'reading',
  'fallback',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WebSearchActivityPhase = (typeof WEB_SEARCH_ACTIVITY_PHASES)[number];

export type WebToolErrorCode = string;

export type WebSearchPublicProvider = {
  provider: WebSearchProvider;
  state: WebSearchConnectionState;
  authMethod: WebSearchAuthMethod | null;
  authSupport: {
    apiKey: WebSearchAuthSupport;
    browserAuthorization: WebSearchAuthSupport;
  };
  capabilities: {
    browse: boolean;
    fetch: boolean;
  };
  lastValidatedAt: string | null;
};

export type WebSearchPublicStatus = {
  protocolVersion: 1;
  revision: number;
  enabled: boolean;
  effectiveEnabled: boolean;
  providers: WebSearchPublicProvider[];
};

export type WebSearchSettingsRequest = {
  protocolVersion: 1;
  expectedRevision: number;
  enabled: boolean;
};

export type WebSearchConnectRequest = {
  protocolVersion: 1;
  expectedRevision: number;
  candidate: string;
};

export type WebSearchDisconnectRequest = {
  protocolVersion: 1;
  expectedRevision: number;
  confirm: true;
};

export type WebSearchOAuthStartRequest = {
  protocolVersion: 1;
  expectedRevision: number;
};

export type WebSearchOAuthStartResponse = {
  protocolVersion: 1;
  authorizationUrl: string;
  expiresAt: string;
};

export type WebSearchOAuthOutcome = 'connected' | 'denied' | 'expired' | 'failed';

export type WebSearchOAuthCompleteRequest = {
  protocolVersion: 1;
  rawQuery: string;
};

export type WebSearchOAuthCompleteResponse = {
  protocolVersion: 1;
  outcome: WebSearchOAuthOutcome;
};

export const WEB_SEARCH_HTTP_ERRORS = {
  WEB_INVALID_REQUEST: { status: 400, retryable: false },
  WEB_INPUT_TOO_LARGE: { status: 413, retryable: false },
  WEB_SETTINGS_CONFLICT: { status: 409, retryable: false },
  WEB_CONNECTION_REQUIRED: { status: 409, retryable: false },
  WEB_INVALID_KEY: { status: 422, retryable: false },
  WEB_AUTH_UNSUPPORTED: { status: 422, retryable: false },
  WEB_CAPABILITY_UNSUPPORTED: { status: 422, retryable: false },
  WEB_OAUTH_BINDING_MISMATCH: { status: 403, retryable: false },
  WEB_OAUTH_STATE_INVALID: { status: 400, retryable: false },
  WEB_OAUTH_EXPIRED: { status: 410, retryable: false },
  WEB_RATE_LIMITED: { status: 429, retryable: true },
  WEB_PROVIDER_UNAVAILABLE: { status: 502, retryable: true },
  WEB_SETUP_TIMEOUT: { status: 504, retryable: true },
  WEB_STORAGE_UNAVAILABLE: { status: 503, retryable: true },
  WEB_WRITE_UNCERTAIN: { status: 503, retryable: false },
  WEB_ENCRYPTION_UNAVAILABLE: { status: 503, retryable: false },
} as const;

export type WebSearchHttpErrorCode = keyof typeof WEB_SEARCH_HTTP_ERRORS;
export const WEB_SEARCH_HTTP_ERROR_CODES = Object.keys(
  WEB_SEARCH_HTTP_ERRORS,
) as WebSearchHttpErrorCode[];

export type WebSearchHttpError = {
  protocolVersion: 1;
  error: {
    code: WebSearchHttpErrorCode;
    retryable: boolean;
    currentRevision: number | null;
  };
};

export type WebSourceReference = {
  sourceId: string;
  toolCallId: string;
  provider: WebSearchProvider;
  kind: WebSearchMode;
  title: string;
  url: string;
  retrievedAt: string;
  publishedAt?: string;
  siteName?: string;
};

export type WebSearchActivity = {
  toolCallId: string;
  mode: WebSearchMode;
  phase: WebSearchActivityPhase;
  provider: WebSearchProvider | null;
  code: WebToolErrorCode | null;
};

export type WebPresentationEvent =
  | { type: 'web-activity'; activity: WebSearchActivity }
  | { type: 'web-sources'; sources: WebSourceReference[] };

export type WebSearchProviderCatalogEntry = {
  provider: WebSearchProvider;
  priority: 1 | 2 | 3 | 4 | 5;
  displayName: string;
  consoleUrl: string;
  consoleLabel: string;
  keyInstructions: string;
  compatibilityNote?: string;
};

export const WEB_SEARCH_PROVIDER_CATALOG: readonly WebSearchProviderCatalogEntry[] = Object.freeze([
  {
    provider: 'tinyfish',
    priority: 1,
    displayName: 'TinyFish',
    consoleUrl: 'https://agent.tinyfish.ai',
    consoleLabel: 'Open TinyFish Agent',
    keyInstructions: 'Sign in at agent.tinyfish.ai, copy your TinyFish API or MCP credential from your account settings, and paste it here.',
    compatibilityNote: 'Hosted MCP header compatibility depends on TinyFish account validation on the server.',
  },
  {
    provider: 'keenable',
    priority: 2,
    displayName: 'Keenable',
    consoleUrl: 'https://keenable.ai',
    consoleLabel: 'Open Keenable',
    keyInstructions: 'Sign in at keenable.ai, open your developer API token settings, create or copy an API key, and paste it here.',
  },
  {
    provider: 'exa',
    priority: 3,
    displayName: 'Exa',
    consoleUrl: 'https://dashboard.exa.ai/api-keys',
    consoleLabel: 'Open Exa API Keys',
    keyInstructions: 'Sign in to dashboard.exa.ai, open API Keys, create a key, copy it, and paste it here.',
  },
  {
    provider: 'tavily',
    priority: 4,
    displayName: 'Tavily',
    consoleUrl: 'https://app.tavily.com/home',
    consoleLabel: 'Open Tavily Dashboard',
    keyInstructions: 'Sign in to app.tavily.com, copy your API key (for example tvly-...), and paste it here.',
  },
  {
    provider: 'firecrawl',
    priority: 5,
    displayName: 'Firecrawl',
    consoleUrl: 'https://www.firecrawl.dev/app/api-keys',
    consoleLabel: 'Open Firecrawl API Keys',
    keyInstructions: 'Sign in to firecrawl.dev/app/api-keys, create or copy your API key (for example fc-...), and paste it here.',
  },
]);

export type WebSearchOAuthCallbackResult =
  | {
      kind: 'complete-query';
      provider: WebSearchProvider;
      rawQuery: string;
      scrubbedPathAndSearch: string;
    }
  | {
      kind: 'resolved';
      provider: WebSearchProvider;
      outcome: WebSearchOAuthOutcome;
      scrubbedPathAndSearch: string;
    };

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'apikey',
  'api_key',
  'authorization',
  'code',
  'code_verifier',
  'refresh_token',
  'secret',
  'token',
]);

const CALLBACK_SCRUB_PARAMS = [
  'plugin',
  'section',
  'provider',
  'oauth',
  'code',
  'state',
  'scope',
  'error',
  'error_description',
] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const PROVIDER_SET = new Set<string>(WEB_SEARCH_PROVIDERS);
const STATE_SET = new Set<string>(WEB_SEARCH_CONNECTION_STATES);
const PHASE_SET = new Set<string>(WEB_SEARCH_ACTIVITY_PHASES);
const AUTH_SUPPORT_SET = new Set<string>(['supported', 'unsupported', 'unverified']);
const OAUTH_OUTCOME_SET = new Set<string>(['connected', 'denied', 'expired', 'failed']);
const HTTP_ERROR_SET = new Set<string>(WEB_SEARCH_HTTP_ERROR_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isNonEmptyString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxChars &&
    value.trim().length > 0
  );
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_RE.test(value) && Number.isFinite(Date.parse(value));
}

function hasSensitiveQueryParam(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return typeof value === 'string' && PROVIDER_SET.has(value);
}

export function isWebSearchLimits(value: unknown): value is WebSearchLimits {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['maxSearchesPerTurn', 'maxFetchesPerTurn']) &&
    typeof value.maxSearchesPerTurn === 'number' &&
    Number.isSafeInteger(value.maxSearchesPerTurn) &&
    value.maxSearchesPerTurn >= 1 &&
    value.maxSearchesPerTurn <= 20 &&
    typeof value.maxFetchesPerTurn === 'number' &&
    Number.isSafeInteger(value.maxFetchesPerTurn) &&
    value.maxFetchesPerTurn >= 1 &&
    value.maxFetchesPerTurn <= 20
  );
}

export function isWebSearchPublicProvider(value: unknown): value is WebSearchPublicProvider {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'provider',
      'state',
      'authMethod',
      'authSupport',
      'capabilities',
      'lastValidatedAt',
    ])
  ) {
    return false;
  }
  if (!isWebSearchProvider(value.provider)) return false;
  if (typeof value.state !== 'string' || !STATE_SET.has(value.state)) return false;
  if (value.authMethod !== null && value.authMethod !== 'api-key' && value.authMethod !== 'oauth') {
    return false;
  }
  if (!isRecord(value.authSupport) || !hasExactKeys(value.authSupport, ['apiKey', 'browserAuthorization'])) {
    return false;
  }
  if (
    typeof value.authSupport.apiKey !== 'string' ||
    !AUTH_SUPPORT_SET.has(value.authSupport.apiKey) ||
    typeof value.authSupport.browserAuthorization !== 'string' ||
    !AUTH_SUPPORT_SET.has(value.authSupport.browserAuthorization)
  ) {
    return false;
  }
  if (!isRecord(value.capabilities) || !hasExactKeys(value.capabilities, ['browse', 'fetch'])) {
    return false;
  }
  if (typeof value.capabilities.browse !== 'boolean' || typeof value.capabilities.fetch !== 'boolean') {
    return false;
  }
  if (value.state === 'connected' && !value.capabilities.browse && !value.capabilities.fetch) {
    return false;
  }
  if (value.lastValidatedAt !== null && !isIsoDateString(value.lastValidatedAt)) {
    return false;
  }
  return true;
}

export function isWebSearchPublicStatus(value: unknown): value is WebSearchPublicStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['protocolVersion', 'revision', 'enabled', 'effectiveEnabled', 'providers'])
  ) {
    return false;
  }
  if (value.protocolVersion !== WEB_SEARCH_PROTOCOL_VERSION) return false;
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    return false;
  }
  if (typeof value.enabled !== 'boolean' || typeof value.effectiveEnabled !== 'boolean') {
    return false;
  }
  if (!Array.isArray(value.providers) || value.providers.length !== WEB_SEARCH_PROVIDERS.length) {
    return false;
  }
  for (let i = 0; i < WEB_SEARCH_PROVIDERS.length; i++) {
    const provider = value.providers[i];
    if (!isWebSearchPublicProvider(provider) || provider.provider !== WEB_SEARCH_PROVIDERS[i]) {
      return false;
    }
  }
  const hasConnected = value.providers.some((item) => item.state === 'connected');
  if (value.effectiveEnabled !== (value.enabled && hasConnected)) return false;
  return true;
}

export function isWebSearchSettingsRequest(value: unknown): value is WebSearchSettingsRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'expectedRevision', 'enabled']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.expectedRevision === 'number' &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    typeof value.enabled === 'boolean'
  );
}

export function isWebSearchCandidateString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    utf8Bytes(value) <= WEB_SEARCH_POLICY.maxApiKeyBytes
  );
}

export function isWebSearchConnectRequest(value: unknown): value is WebSearchConnectRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'expectedRevision', 'candidate']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.expectedRevision === 'number' &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    isWebSearchCandidateString(value.candidate)
  );
}

export function isWebSearchDisconnectRequest(value: unknown): value is WebSearchDisconnectRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'expectedRevision', 'confirm']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.expectedRevision === 'number' &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    value.confirm === true
  );
}

export function isWebSearchOAuthStartRequest(value: unknown): value is WebSearchOAuthStartRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'expectedRevision']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.expectedRevision === 'number' &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0
  );
}

export function isWebSearchOAuthStartResponse(value: unknown): value is WebSearchOAuthStartResponse {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'authorizationUrl', 'expiresAt']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.authorizationUrl === 'string' &&
    isSafeHttpsUrl(value.authorizationUrl) &&
    !hasSensitiveQueryParam(value.authorizationUrl) &&
    isIsoDateString(value.expiresAt)
  );
}

export function isWebSearchOAuthCompleteRequest(value: unknown): value is WebSearchOAuthCompleteRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'rawQuery']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.rawQuery === 'string' &&
    value.rawQuery.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value.rawQuery) &&
    utf8Bytes(value.rawQuery) <= WEB_SEARCH_POLICY.maxOAuthRawQueryBytes
  );
}

export function isWebSearchOAuthCompleteResponse(value: unknown): value is WebSearchOAuthCompleteResponse {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['protocolVersion', 'outcome']) &&
    value.protocolVersion === WEB_SEARCH_PROTOCOL_VERSION &&
    typeof value.outcome === 'string' &&
    OAUTH_OUTCOME_SET.has(value.outcome)
  );
}

export function isWebSearchHttpError(value: unknown): value is WebSearchHttpError {
  if (!isRecord(value) || !hasExactKeys(value, ['protocolVersion', 'error'])) return false;
  if (value.protocolVersion !== WEB_SEARCH_PROTOCOL_VERSION) return false;
  const err = value.error;
  if (!isRecord(err) || !hasExactKeys(err, ['code', 'retryable', 'currentRevision'])) return false;
  if (typeof err.code !== 'string' || !HTTP_ERROR_SET.has(err.code)) return false;
  if (typeof err.retryable !== 'boolean') return false;
  if (
    err.currentRevision !== null &&
    (typeof err.currentRevision !== 'number' ||
      !Number.isSafeInteger(err.currentRevision) ||
      err.currentRevision < 0)
  ) {
    return false;
  }
  return true;
}

export function isWebSourceReference(value: unknown): value is WebSourceReference {
  if (!isRecord(value)) return false;
  const requiredKeys = ['sourceId', 'toolCallId', 'provider', 'kind', 'title', 'url', 'retrievedAt'];
  const allowedOptionalKeys = ['publishedAt', 'siteName'];
  const actualKeys = Object.keys(value);
  if (!requiredKeys.every((k) => actualKeys.includes(k))) return false;
  if (actualKeys.some((k) => !requiredKeys.includes(k) && !allowedOptionalKeys.includes(k))) {
    return false;
  }
  if (!isNonEmptyString(value.sourceId, 128) || !isNonEmptyString(value.toolCallId, 128)) {
    return false;
  }
  if (!isWebSearchProvider(value.provider)) return false;
  if (value.kind !== 'browse' && value.kind !== 'fetch') return false;
  if (!isNonEmptyString(value.title, WEB_SEARCH_POLICY.maxTitleChars)) return false;
  if (typeof value.url !== 'string' || sanitizeWebSourceUrl(value.url) === '') return false;
  if (hasSensitiveQueryParam(value.url)) return false;
  if (!isIsoDateString(value.retrievedAt)) return false;
  if (value.publishedAt !== undefined && !isNonEmptyString(value.publishedAt, 64)) return false;
  if (value.siteName !== undefined && !isNonEmptyString(value.siteName, 128)) return false;
  return true;
}

export function isWebSourceReferenceList(value: unknown): value is WebSourceReference[] {
  if (!Array.isArray(value) || value.length > WEB_SEARCH_POLICY.maxSourcesPerMessage) {
    return false;
  }
  const seenIds = new Set<string>();
  for (const item of value) {
    if (!isWebSourceReference(item) || seenIds.has(item.sourceId)) return false;
    seenIds.add(item.sourceId);
  }
  return utf8Bytes(JSON.stringify(value)) <= WEB_SEARCH_POLICY.maxSourceProvenanceBytes;
}

export function isWebSearchActivity(value: unknown): value is WebSearchActivity {
  if (!isRecord(value) || !hasExactKeys(value, ['toolCallId', 'mode', 'phase', 'provider', 'code'])) {
    return false;
  }
  if (!isNonEmptyString(value.toolCallId, 128)) return false;
  if (value.mode !== 'browse' && value.mode !== 'fetch') return false;
  if (typeof value.phase !== 'string' || !PHASE_SET.has(value.phase)) return false;
  if (value.provider !== null && !isWebSearchProvider(value.provider)) return false;
  if (value.phase === 'searching' && value.mode !== 'browse') return false;
  if (value.phase === 'reading' && value.mode !== 'fetch') return false;
  if (value.phase === 'failed') {
    if (typeof value.code !== 'string' || !/^WEB_[A-Z0-9_]{1,60}$/.test(value.code)) {
      return false;
    }
  } else if (value.code !== null) {
    return false;
  }
  return true;
}

export function isWebSearchActivityList(value: unknown): value is WebSearchActivity[] {
  if (!Array.isArray(value) || value.length > WEB_SEARCH_POLICY.maxActivitiesPerMessage) {
    return false;
  }
  if (!value.every(isWebSearchActivity)) return false;
  return utf8Bytes(JSON.stringify(value)) <= WEB_SEARCH_POLICY.maxActivityProjectionBytes;
}

export function isWebPresentationEvent(value: unknown): value is WebPresentationEvent {
  if (!isRecord(value)) return false;
  if (value.type === 'web-activity') {
    return hasExactKeys(value, ['type', 'activity']) && isWebSearchActivity(value.activity);
  }
  if (value.type === 'web-sources') {
    return hasExactKeys(value, ['type', 'sources']) && isWebSourceReferenceList(value.sources);
  }
  return false;
}

export function extractAndScrubWebSearchOAuthCallback(urlStr: string): WebSearchOAuthCallbackResult | null {
  let url: URL;
  try {
    url = new URL(urlStr, 'http://127.0.0.1');
  } catch {
    return null;
  }

  const target = url.searchParams.get('plugin') ?? url.searchParams.get('section');
  const providerParam = url.searchParams.get('provider');
  if (target !== 'web-search' || !isWebSearchProvider(providerParam)) {
    return null;
  }

  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const oauthOutcome = url.searchParams.get('oauth');
  const hasCallbackParams =
    url.searchParams.has('code') || url.searchParams.has('state') || url.searchParams.has('error');

  for (const param of CALLBACK_SCRUB_PARAMS) {
    url.searchParams.delete(param);
  }
  const cleanSearch = url.searchParams.toString();
  const scrubbedPathAndSearch = cleanSearch ? `${url.pathname}?${cleanSearch}` : url.pathname;

  if (!hasCallbackParams && oauthOutcome && OAUTH_OUTCOME_SET.has(oauthOutcome)) {
    return {
      kind: 'resolved',
      provider: providerParam,
      outcome: oauthOutcome as WebSearchOAuthOutcome,
      scrubbedPathAndSearch,
    };
  }

  if (hasCallbackParams && utf8Bytes(rawQuery) <= WEB_SEARCH_POLICY.maxOAuthRawQueryBytes && !/[\u0000-\u001f\u007f]/u.test(rawQuery)) {
    return {
      kind: 'complete-query',
      provider: providerParam,
      rawQuery,
      scrubbedPathAndSearch,
    };
  }

  return {
    kind: 'resolved',
    provider: providerParam,
    outcome: 'failed',
    scrubbedPathAndSearch,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`):
```powershell
npm test -- src/api/web-search-protocol.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- frontend/src/api/web-search-protocol.ts frontend/src/api/web-search-protocol.test.ts
git commit -m "feat(frontend): add web-search protocol types, catalog, and guards"
```

---

## Task 3: Restore Exact Backend Contract Mirrors (`admin-config-protocol.ts` & `voice-protocol.ts`)

**Files:**
- Modify: `frontend/src/api/admin-config-protocol.ts`
- Modify: `frontend/src/api/voice-protocol.ts`
- Modify: `frontend/src/api/testing/voice-fixtures.test.ts`
- Modify: `frontend/src/api/voice-protocol.test.ts`
- Modify: `frontend/src/features/admin-config/testing/fixtures.ts`

- [ ] **Step 1: Confirm existing mirror specs currently fail (red) and add frontend `web.frame` test cases**

Run existing mirror tests first:
```powershell
cd backend; npm test -- src/contracts/admin-config.spec.ts src/contracts/voice.spec.ts
```
Expected: FAIL on `mirrors only the public admin contract into the frontend` and `mirrors the entire portable voice contract` because frontend mirrors are missing P1's `webSearch` and `web.frame` additions.

Also add a new test in `frontend/src/api/voice-protocol.test.ts` right after the `calendar.frame` test (~line 221):

```ts
  it('mirrors web.frame in live mode only and enforces 16384-byte payload limits', () => {
    const envelope = {
      protocolVersion: 1,
      sessionId: 'v',
      connectionEpoch: 1,
      eventId: 'e',
      sequence: 1,
    }
    const frame = {
      ...envelope,
      type: 'web.frame' as const,
      turnId: 't_1',
      attemptId: 'a_1',
      responseId: 'r_1',
      event: {
        type: 'web-activity' as const,
        activity: {
          toolCallId: 'call_1',
          mode: 'browse' as const,
          phase: 'searching' as const,
          provider: 'tinyfish' as const,
          code: null,
        },
      },
    }
    expect(isVoiceServerEvent(frame, 'live')).toBe(true)
    expect(isVoiceServerEvent(frame, 'dictation')).toBe(false)
    expect(isVoiceClientEvent(frame)).toBe(false)
    expect(isVoiceServerEvent({ ...frame, extra: true }, 'live')).toBe(false)

    const oversized = {
      ...frame,
      event: {
        type: 'web-sources' as const,
        sources: Array.from({ length: 15 }, (_, i) => ({
          sourceId: `src_${i}`,
          toolCallId: 'call_1',
          provider: 'exa' as const,
          kind: 'browse' as const,
          title: 'T'.repeat(160),
          url: `https://example.com/${'a'.repeat(980)}`,
          retrievedAt: '2026-11-14T00:00:00.000Z',
        })),
      },
    }
    expect(isVoiceServerEvent(oversized, 'live')).toBe(false)
  })
```

- [ ] **Step 2: Run `voice-protocol.test.ts` to verify new test fails before updating mirror**

```powershell
cd frontend; npm test -- src/api/voice-protocol.test.ts
```
Expected: FAIL on `web.frame`.

- [ ] **Step 3: Mirror `backend/src/contracts/admin-config-wire.ts` into `frontend/src/api/admin-config-protocol.ts` and update test fixture**

1. Inspect `backend/src/contracts/admin-config-wire.ts` around lines 18–290 and preserve CRLF (`\r\n`) on `frontend/src/api/admin-config-protocol.ts`.
2. Immediately before `export const ADMIN_CONFIG_PROTOCOL_VERSION = 1 as const;`, import and re-export `WebSearchLimits` from `'./web-search-protocol.ts'`:
```ts
import { isVoiceLimits, type VoiceLimits } from './voice-protocol';
export type { WebSearchLimits } from './web-search-protocol.ts';
```
3. Copy the body of `backend/src/contracts/admin-config-wire.ts` starting at `export const ADMIN_CONFIG_PROTOCOL_VERSION = 1 as const;` verbatim through EOF into `frontend/src/api/admin-config-protocol.ts` (`ManageableSettings.webSearch`, `'webSearch.maxSearchesPerTurn'`, `'webSearch.maxFetchesPerTurn'`, and `webSearch: v => exact(v, { maxSearchesPerTurn: safePos(20), maxFetchesPerTurn: safePos(20) })` inside `isManageableSettings`). Ensure zero imports of backend runtime modules or secret symbols appear.
4. Update `frontend/src/features/admin-config/testing/fixtures.ts` to import `DEFAULT_WEB_SEARCH_LIMITS` from `'../../../api/web-search-protocol.ts'` and add `webSearch: { ...DEFAULT_WEB_SEARCH_LIMITS },` to `settings`.

- [ ] **Step 4: Mirror `backend/src/contracts/voice-wire.ts` into `frontend/src/api/voice-protocol.ts` and update `voice-fixtures.test.ts`**

1. Preserve CRLF (`\r\n`) in `frontend/src/api/voice-protocol.ts` (`voice.spec.ts` asserts `.toBe(body(backend))` without newline normalization).
2. Immediately above `export const VOICE_PROTOCOL_VERSION = 1 as const;` (after the `calendar-protocol.ts` import), add:
```ts
import { isWebPresentationEvent, type WebPresentationEvent } from './web-search-protocol.ts';
```
3. Copy the exact `web.frame` additions from `backend/src/contracts/voice-wire.ts` identically into `frontend/src/api/voice-protocol.ts`:
```ts
// Near CalendarFramePayload:
export type WebFramePayload = { type: 'web.frame'; turnId: string; attemptId: string; responseId: string;
  event: WebPresentationEvent };

// In VoiceServerPayload union:
  | CalendarFramePayload
  | WebFramePayload;

// In serverShapes map:
  'web.frame': { ...response, attemptId: id, event: isWebPresentationEvent },

// In dictation mode rejection check & byte cap (must match backend/src/contracts/voice-wire.ts exact lines):
if (mode === 'dictation' && ['voice.state', 'audio.start', 'audio.watermark', 'audio.end', 'response.cancelled', 'conversation.bound', 'canvas.artifact', 'canvas.show', 'canvas.control', 'calendar.frame', 'web.frame'].includes(v.type)) return false;
if ((v.type === 'calendar.frame' || v.type === 'web.frame') && utf8(JSON.stringify(v)) > 16384) return false;
```
Keep the existing inline `CANVAS_NAVIGATION_LIMITS` and `isCanvasNavigationId` declarations intact, and verify the slice from `export const VOICE_PROTOCOL_VERSION` matches `backend/src/contracts/voice-wire.ts` verbatim (including line wraps and CRLF).
4. Update `stripCalendarExtension` in `frontend/src/api/testing/voice-fixtures.test.ts` to strip both backend and frontend `web-search` import lines:
```ts
      .replace(/^import \{ isWebPresentationEvent, type WebPresentationEvent \} from '\.\/web-search-(?:wire\.js|protocol\.ts)';\n/m, '')
```

- [ ] **Step 5: Run BOTH backend and frontend parity/protocol tests**

```powershell
cd backend; npm test -- src/contracts/admin-config.spec.ts src/contracts/voice.spec.ts src/contracts/web-search-wire.spec.ts
cd ../frontend; npm test -- src/api/voice-protocol.test.ts src/api/testing/voice-fixtures.test.ts src/features/admin-config/config-edit-state.test.ts
```
Expected: ALL PASS (exact CRLF + body parity restored on both mirrors; existing `config-edit-state.test.ts` fails only on `catalogCoverage` until Task 6 adds `'webSearch.maxSearchesPerTurn'` and `'webSearch.maxFetchesPerTurn'` — re-run `voice-protocol.test.ts` + `voice-fixtures.test.ts` + backend specs now to verify green mirrors).

- [ ] **Step 6: Commit**

```powershell
git add -- frontend/src/api/admin-config-protocol.ts frontend/src/api/voice-protocol.ts frontend/src/api/voice-protocol.test.ts frontend/src/api/testing/voice-fixtures.test.ts frontend/src/features/admin-config/testing/fixtures.ts
git commit -m "feat(frontend): mirror backend admin-config webSearch and voice web.frame contracts"
```

---

## Task 4: Bounded Web Search API Client (`web-search-client.ts`)

**Files:**
- Create: `frontend/src/api/web-search-client.ts`
- Create: `frontend/src/api/web-search-client.test.ts`

- [ ] **Step 1: Write failing client tests covering status, settings toggle, connect/disconnect, OAuth start/complete, closed errors, and zero secret retention**

Create `frontend/src/api/web-search-client.test.ts`:

```ts
/**
 * ============================================================================
 * FILE: web-search-client.test.ts
 * LOCATION: frontend/src/api/web-search-client.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify bounded HTTP client behavior, error mapping, and secret hygiene.
 *
 * ROLE IN PROJECT:
 *    Proves WebSearchClient validates outgoing/incoming contracts, enforces
 *    no-store/redirect-error options, and never leaks candidate keys in errors.
 *
 * KEY COMPONENTS:
 *    - createWebSearchClient: Status, enable/disable, connect, disconnect, OAuth.
 *    - WebSearchClientError: Closed non-secret error surface.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { createWebSearchClient, WebSearchClientError } from './web-search-client.ts';
import { WEB_SEARCH_PROVIDERS, type WebSearchPublicStatus } from './web-search-protocol.ts';

function statusFixture(revision = 1, enabled = false): WebSearchPublicStatus {
  const connectedProvider = revision > 1 ? 'exa' : null;
  return {
    protocolVersion: 1,
    revision,
    enabled,
    effectiveEnabled: enabled && connectedProvider !== null,
    providers: WEB_SEARCH_PROVIDERS.map((provider) => ({
      provider,
      state: provider === connectedProvider ? 'connected' : 'not-connected',
      authMethod: provider === connectedProvider ? 'api-key' : null,
      authSupport: { apiKey: 'supported', browserAuthorization: 'unsupported' },
      capabilities: { browse: provider === connectedProvider, fetch: provider === connectedProvider },
      lastValidatedAt: provider === connectedProvider ? '2026-11-14T00:00:00.000Z' : null,
    })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('web-search-client', () => {
  it('fetches status with no-store, same-origin, and redirect error', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(statusFixture(0, false)));
    const client = createWebSearchClient({ baseUrl: '/api', fetch: fetchMock });
    const status = await client.status();
    expect(status.revision).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/web-search/status',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        credentials: 'same-origin',
      }),
    );
  });

  it('rejects status payloads carrying extra secret properties', async () => {
    const leaked = { ...statusFixture(1, false), apiKey: 'raw-secret' };
    const client = createWebSearchClient({
      baseUrl: '/api',
      fetch: vi.fn(async () => jsonResponse(leaked)),
    });
    await expect(client.status()).rejects.toMatchObject({ code: 'INVALID_WEB_RESPONSE' });
  });

  it('validates requests locally and never reflects candidate keys on errors', async () => {
    const candidate = 'secret-provider-key-should-not-leak';
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          protocolVersion: 1,
          error: { code: 'WEB_INVALID_KEY', retryable: false, currentRevision: 1 },
        },
        422,
      ),
    );
    const client = createWebSearchClient({ baseUrl: '/api', fetch: fetchMock });

    await expect(
      client.connectProvider('exa', { protocolVersion: 1, expectedRevision: 0, candidate: ' bad key ' }),
    ).rejects.toMatchObject({ code: 'WEB_INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();

    let caught: unknown;
    try {
      await client.connectProvider('exa', { protocolVersion: 1, expectedRevision: 1, candidate });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WebSearchClientError);
    expect((caught as WebSearchClientError).code).toBe('WEB_INVALID_KEY');
    expect(JSON.stringify(caught)).not.toContain(candidate);
    expect((caught as Error).message).not.toContain(candidate);
  });

  it('handles settings, disconnect, oauth start, and oauth complete cleanly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(statusFixture(2, true)))
      .mockResolvedValueOnce(jsonResponse(statusFixture(3, false)))
      .mockResolvedValueOnce(
        jsonResponse({
          protocolVersion: 1,
          authorizationUrl: 'https://provider.example.com/auth?state=pub',
          expiresAt: '2026-11-14T00:10:00.000Z',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, outcome: 'connected' }));

    const client = createWebSearchClient({ baseUrl: '/api', fetch: fetchMock });

    const enabled = await client.setEnabled({ protocolVersion: 1, expectedRevision: 2, enabled: true });
    expect(enabled.effectiveEnabled).toBe(true);

    const disconnected = await client.disconnectProvider('exa', {
      protocolVersion: 1,
      expectedRevision: 2,
      confirm: true,
    });
    expect(disconnected.revision).toBe(3);

    const oauth = await client.startOAuth('tinyfish', { protocolVersion: 1, expectedRevision: 3 });
    expect(oauth.authorizationUrl).toBe('https://provider.example.com/auth?state=pub');

    const completed = await client.completeOAuth('tinyfish', {
      protocolVersion: 1,
      rawQuery: 'code=abc&state=pub',
    });
    expect(completed).toEqual({ protocolVersion: 1, outcome: 'connected' });
  });

  it('marks WEB_WRITE_UNCERTAIN as uncertain and respects oversized HTTP bodies', async () => {
    const uncertainClient = createWebSearchClient({
      baseUrl: '/api',
      fetch: vi.fn(async () =>
        jsonResponse(
          {
            protocolVersion: 1,
            error: { code: 'WEB_WRITE_UNCERTAIN', retryable: false, currentRevision: null },
          },
          503,
        ),
      ),
    });
    await expect(
      uncertainClient.setEnabled({ protocolVersion: 1, expectedRevision: 1, enabled: true }),
    ).rejects.toMatchObject({ code: 'WEB_WRITE_UNCERTAIN', uncertain: true });

    const hugeClient = createWebSearchClient({
      baseUrl: '/api',
      fetch: vi.fn(
        async () =>
          new Response('{"x":"' + 'a'.repeat(70_000) + '"}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    });
    await expect(hugeClient.status()).rejects.toMatchObject({ code: 'INVALID_WEB_RESPONSE' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd frontend; npm test -- src/api/web-search-client.test.ts
```
Expected: FAIL (`web-search-client.ts` not found).

- [ ] **Step 3: Implement `frontend/src/api/web-search-client.ts`**

Create `frontend/src/api/web-search-client.ts`:

```ts
/**
 * ============================================================================
 * FILE: web-search-client.ts
 * LOCATION: frontend/src/api/web-search-client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Bounded, no-store HTTP client for Web Search plugin setup and OAuth flows.
 *
 * ROLE IN PROJECT:
 *    Sends validated non-secret mutations and write-only key submissions to
 *    backend routes without storing keys or echoing provider responses.
 *
 * KEY COMPONENTS:
 *    - WebSearchClient / createWebSearchClient: Status, settings, connect/disconnect, OAuth.
 *    - WebSearchClientError: Closed safe error surface mapping HTTP error codes.
 * ============================================================================
 */

import {
  WEB_SEARCH_ROUTES,
  isWebSearchConnectRequest,
  isWebSearchDisconnectRequest,
  isWebSearchHttpError,
  isWebSearchOAuthCompleteRequest,
  isWebSearchOAuthCompleteResponse,
  isWebSearchOAuthStartRequest,
  isWebSearchOAuthStartResponse,
  isWebSearchProvider,
  isWebSearchPublicStatus,
  isWebSearchSettingsRequest,
  type WebSearchConnectRequest,
  type WebSearchDisconnectRequest,
  type WebSearchHttpErrorCode,
  type WebSearchOAuthCompleteRequest,
  type WebSearchOAuthCompleteResponse,
  type WebSearchOAuthStartRequest,
  type WebSearchOAuthStartResponse,
  type WebSearchProvider,
  type WebSearchPublicStatus,
  type WebSearchSettingsRequest,
} from './web-search-protocol.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 65_536;
const SAFE_MESSAGE = 'Web search request could not be completed.';

export type WebSearchClientErrorCode =
  | WebSearchHttpErrorCode
  | 'NETWORK_ERROR'
  | 'ABORTED'
  | 'INVALID_WEB_RESPONSE'
  | 'WEB_HTTP_ERROR';

export class WebSearchClientError extends Error {
  readonly code: WebSearchClientErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly currentRevision: number | null;
  readonly uncertain: boolean;

  constructor(options: {
    code: WebSearchClientErrorCode;
    status?: number;
    retryable?: boolean;
    currentRevision?: number | null;
    uncertain?: boolean;
  }) {
    super(SAFE_MESSAGE);
    this.name = 'WebSearchClientError';
    this.code = options.code;
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.currentRevision = options.currentRevision ?? null;
    this.uncertain = options.uncertain ?? false;
  }
}

export type WebSearchClient = {
  status(signal?: AbortSignal): Promise<WebSearchPublicStatus>;
  setEnabled(request: WebSearchSettingsRequest, signal?: AbortSignal): Promise<WebSearchPublicStatus>;
  connectProvider(
    provider: WebSearchProvider,
    request: WebSearchConnectRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchPublicStatus>;
  disconnectProvider(
    provider: WebSearchProvider,
    request: WebSearchDisconnectRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchPublicStatus>;
  startOAuth(
    provider: WebSearchProvider,
    request: WebSearchOAuthStartRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchOAuthStartResponse>;
  completeOAuth(
    provider: WebSearchProvider,
    request: WebSearchOAuthCompleteRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchOAuthCompleteResponse>;
};

function readViteApiBase(): string | undefined {
  try {
    const env = import.meta.env as { VITE_API_BASE?: string } | undefined;
    return env?.VITE_API_BASE;
  } catch {
    return undefined;
  }
}

function invalidRequest(): never {
  throw new WebSearchClientError({ code: 'WEB_INVALID_REQUEST' });
}

function invalidResponse(status = 0): never {
  throw new WebSearchClientError({ code: 'INVALID_WEB_RESPONSE', status });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) invalidResponse(response.status);
    return text ? (JSON.parse(text) as unknown) : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          void reader.cancel();
          invalidResponse(response.status);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return text ? (JSON.parse(text) as unknown) : null;
}

export function createWebSearchClient(
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): WebSearchClient {
  const baseUrl = (options.baseUrl ?? readViteApiBase() ?? '/api').replace(/\/+$/, '');
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    guard: (value: unknown) => value is T,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    const bounded = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const response = await fetcher(`${baseUrl}${path}`, {
        method,
        signal: bounded,
        cache: 'no-store',
        redirect: 'error',
        credentials: 'same-origin',
        headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const parsed = await readBoundedJson(response).catch((err: unknown) => {
        if (err instanceof WebSearchClientError) throw err;
        if (response.ok) invalidResponse(response.status);
        return null;
      });

      if (!response.ok) {
        if (isWebSearchHttpError(parsed)) {
          throw new WebSearchClientError({
            code: parsed.error.code,
            status: response.status,
            retryable: parsed.error.retryable,
            currentRevision: parsed.error.currentRevision,
            uncertain: parsed.error.code === 'WEB_WRITE_UNCERTAIN',
          });
        }
        throw new WebSearchClientError({
          code: 'WEB_HTTP_ERROR',
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      if (!guard(parsed)) invalidResponse(response.status);
      return parsed;
    } catch (error) {
      if (error instanceof WebSearchClientError) throw error;
      if (signal?.aborted) throw new WebSearchClientError({ code: 'ABORTED' });
      if (timeout.signal.aborted) {
        throw new WebSearchClientError({ code: 'WEB_SETUP_TIMEOUT', retryable: true });
      }
      throw new WebSearchClientError({ code: 'NETWORK_ERROR', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    status(signal) {
      return request(WEB_SEARCH_ROUTES.status, 'GET', isWebSearchPublicStatus, undefined, signal);
    },
    setEnabled(body, signal) {
      if (!isWebSearchSettingsRequest(body)) invalidRequest();
      return request(WEB_SEARCH_ROUTES.settings, 'PATCH', isWebSearchPublicStatus, body, signal);
    },
    connectProvider(provider, body, signal) {
      if (!isWebSearchProvider(provider) || !isWebSearchConnectRequest(body)) invalidRequest();
      return request(WEB_SEARCH_ROUTES.connect(provider), 'POST', isWebSearchPublicStatus, body, signal);
    },
    disconnectProvider(provider, body, signal) {
      if (!isWebSearchProvider(provider) || !isWebSearchDisconnectRequest(body)) invalidRequest();
      return request(WEB_SEARCH_ROUTES.disconnect(provider), 'POST', isWebSearchPublicStatus, body, signal);
    },
    startOAuth(provider, body, signal) {
      if (!isWebSearchProvider(provider) || !isWebSearchOAuthStartRequest(body)) invalidRequest();
      return request(
        WEB_SEARCH_ROUTES.oauthStart(provider),
        'POST',
        isWebSearchOAuthStartResponse,
        body,
        signal,
      );
    },
    completeOAuth(provider, body, signal) {
      if (!isWebSearchProvider(provider) || !isWebSearchOAuthCompleteRequest(body)) invalidRequest();
      return request(
        WEB_SEARCH_ROUTES.oauthComplete(provider),
        'POST',
        isWebSearchOAuthCompleteResponse,
        body,
        signal,
      );
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
cd frontend; npm test -- src/api/web-search-client.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- frontend/src/api/web-search-client.ts frontend/src/api/web-search-client.test.ts
git commit -m "feat(frontend): add bounded no-store WebSearchClient"
```

---

## Task 5: Text SSE Events & Assistant-Only Message Provenance (`protocol.ts`)

**Files:**
- Modify: `frontend/src/api/protocol.ts`
- Modify: `frontend/src/api/protocol.test.ts`
- Modify: `frontend/src/api/client.test.ts`

- [ ] **Step 1: Write failing tests for SSE `web-activity`, `web-sources`, `completed` provenance, and user-message rejection**

Append to `frontend/src/api/protocol.test.ts`:

```ts
  it('accepts web-activity, web-sources, and completed web provenance without allowing user-role provenance', () => {
    const activity = {
      toolCallId: 'call_1',
      mode: 'browse' as const,
      phase: 'searching' as const,
      provider: 'exa' as const,
      code: null,
    };
    const webSource = {
      sourceId: 'src_1',
      toolCallId: 'call_1',
      provider: 'exa' as const,
      kind: 'browse' as const,
      title: 'Example',
      url: 'https://example.com/doc',
      retrievedAt: '2026-11-14T00:00:00.000Z',
    };

    expect(isStreamEvent({ type: 'web-activity', activity })).toBe(true);
    expect(isStreamEvent({ type: 'web-sources', sources: [webSource] })).toBe(true);
    expect(
      isStreamEvent({
        type: 'web-sources',
        sources: [{ ...webSource, url: 'javascript:alert(1)' }],
      }),
    ).toBe(false);
    expect(
      isStreamEvent({
        type: 'completed',
        assistantMessageId: 'm_1',
        outcome: 'completed',
        webSources: [webSource],
        webActivities: [activity],
      }),
    ).toBe(true);

    const assistantMsg = {
      messageId: 'm_1',
      turnId: 't_1',
      eventId: 'e_1',
      sequence: 2,
      role: 'assistant',
      content: 'Grounded.',
      createdAt: '2026-11-14T00:00:00.000Z',
      completionStatus: 'completed',
      truncated: false,
      webSources: [webSource],
      webActivities: [activity],
    };
    expect(isVisibleMessageList([assistantMsg])).toBe(true);
    expect(isVisibleMessageList([{ ...assistantMsg, role: 'user' }])).toBe(false);
  });
```

Append to `frontend/src/api/client.test.ts`:

```ts
  it('parses web-activity, web-sources, and completed web provenance SSE frames', async () => {
    const ssePayload = [
      'data: {"protocolVersion":2,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":1,"event":{"type":"web-activity","activity":{"toolCallId":"call_1","mode":"browse","phase":"searching","provider":"exa","code":null}}}\n\n',
      'data: {"protocolVersion":2,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":2,"event":{"type":"web-sources","sources":[{"sourceId":"src_1","toolCallId":"call_1","provider":"exa","kind":"browse","title":"Docs","url":"https://example.com/docs","retrievedAt":"2026-11-14T00:00:00.000Z"}]}}\n\n',
      'data: {"protocolVersion":2,"sessionId":"sess_1","turnId":"turn_1","attemptId":"att_1","sequence":3,"event":{"type":"completed","assistantMessageId":"msg_ast_1","outcome":"completed","webSources":[{"sourceId":"src_1","toolCallId":"call_1","provider":"exa","kind":"browse","title":"Docs","url":"https://example.com/docs","retrievedAt":"2026-11-14T00:00:00.000Z"}]}}\n\n',
    ];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: makeReadableStream(ssePayload),
    });

    const client = new ApiClient({ baseUrl: '/api', fetch: mockFetch });
    const events: string[] = [];
    await client.connectTurnStream('/sessions/sess_1/turns/turn_1/stream', {
      onEvent: (event) => events.push(event.type),
    });
    expect(events).toEqual(['web-activity', 'web-sources', 'completed']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
cd frontend; npm test -- src/api/protocol.test.ts src/api/client.test.ts
```
Expected: FAIL (`isStreamEvent` and `isVisibleMessageList` reject `web-activity`, `web-sources`, `webSources`, `webActivities`).

- [ ] **Step 3: Update `frontend/src/api/protocol.ts`**

1. Import from `./web-search-protocol.ts`:
```ts
import {
  isWebSearchActivity,
  isWebSearchActivityList,
  isWebSourceReferenceList,
  type WebSearchActivity,
  type WebSourceReference,
} from './web-search-protocol.ts';
```
2. Extend `StreamEvent` union:
   - On `{ type: 'completed'; ... }` add `webSources?: WebSourceReference[]; webActivities?: WebSearchActivity[];`
   - Add `| { type: 'web-activity'; activity: WebSearchActivity }`
   - Add `| { type: 'web-sources'; sources: WebSourceReference[] }`
3. Extend `VoiceTranscriptItem` and `VisibleMessage` with:
   - `webSources?: WebSourceReference[];`
   - `webActivities?: WebSearchActivity[];`
4. In `isStreamEvent(value)` (`frontend/src/api/protocol.ts`):
   - Handle `value.type === 'web-activity'`: `hasExactKeys(value, ['type', 'activity']) && isWebSearchActivity(value.activity)`
   - Handle `value.type === 'web-sources'`: `hasExactKeys(value, ['type', 'sources']) && isWebSourceReferenceList(value.sources)`
   - In `value.type === 'completed'`: include optional `'webSources'` / `'webActivities'` in the exact-keys list and assert `(!('webSources' in value) || isWebSourceReferenceList(value.webSources)) && (!('webActivities' in value) || isWebSearchActivityList(value.webActivities))`
5. In `isVisibleMessage(value)` (`frontend/src/api/protocol.ts`) and `isVoiceTranscriptItem(value)`:
   - Allow optional `'webSources'` and `'webActivities'` keys.
   - Enforce `if (('webSources' in value || 'webActivities' in value) && value.role !== 'assistant') return false;`
   - Validate `(!('webSources' in value) || isWebSourceReferenceList(value.webSources)) && (!('webActivities' in value) || isWebSearchActivityList(value.webActivities))`.

- [ ] **Step 4: Run tests to verify they pass**

```powershell
cd frontend; npm test -- src/api/protocol.test.ts src/api/client.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- frontend/src/api/protocol.ts frontend/src/api/protocol.test.ts frontend/src/api/client.test.ts
git commit -m "feat(frontend): add web search SSE events and assistant message provenance guards"
```

---

## Task 6: Config Page Limits Controls (`config-edit-state.ts` & `AdminDashboard.tsx`)

**Files:**
- Modify: `frontend/src/features/admin-config/config-edit-state.ts`
- Modify: `frontend/src/features/admin-config/AdminDashboard.tsx`
- Modify: `frontend/src/features/admin-config/config-edit-state.test.ts`
- Modify: `frontend/src/features/admin-config/admin-dashboard.test.ts`

- [ ] **Step 1: Write failing tests for `'webSearch'` Config section and `1..20` limits**

In `frontend/src/features/admin-config/config-edit-state.test.ts`, add:

```ts
it('round-trips webSearch turn budgets (default 5/5) and rejects out-of-range or non-integer values', () => {
  const baseline = publicConfig().settings;
  expect(baseline.webSearch).toEqual({ maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 });
  const fields = fieldsFromSettings(baseline);
  expect(fields['webSearch.maxSearchesPerTurn']).toBe('5');
  expect(fields['webSearch.maxFetchesPerTurn']).toBe('5');

  const updated = settingsFromFields(baseline, {
    ...fields,
    'webSearch.maxSearchesPerTurn': '1',
    'webSearch.maxFetchesPerTurn': '20',
  });
  expect(updated.fieldErrors).toEqual([]);
  expect(updated.settings?.webSearch).toEqual({ maxSearchesPerTurn: 1, maxFetchesPerTurn: 20 });

  for (const [path, badValue] of [
    ['webSearch.maxSearchesPerTurn', '0'],
    ['webSearch.maxSearchesPerTurn', '21'],
    ['webSearch.maxSearchesPerTurn', '2.5'],
    ['webSearch.maxSearchesPerTurn', ''],
    ['webSearch.maxFetchesPerTurn', '0'],
    ['webSearch.maxFetchesPerTurn', '21'],
  ] as const) {
    const failed = settingsFromFields(baseline, { ...fields, [path]: badValue });
    expect(failed.settings).toBeNull();
    expect(failed.fieldErrors.some((e) => e.path === path)).toBe(true);
  }
});
```

In `frontend/src/features/admin-config/admin-dashboard.test.ts`:
1. Extend the loop at line 49 from `['openrouter', 'chat', 'voice', 'deepgram']` to `['openrouter', 'chat', 'voice', 'deepgram', 'webSearch']`.
2. Add focused rendering test:

```ts
it('renders Web Search turn budget fields in Config -> webSearch with 1..20 bounds and plugin cross-link hint', () => {
  const fields = fieldsFromSettings(publicConfig().settings);
  const html = renderToStaticMarkup(createElement(ConfigFields, {
    section: 'webSearch',
    fields,
    errors: [],
    disabled: false,
    onChange: () => undefined,
  }));
  expect(html).toContain('Turn budgets');
  expect(html).toContain('Max searches per turn');
  expect(html).toContain('Max page fetches per turn');
  expect(html).toContain('min="1"');
  expect(html).toContain('max="20"');
  expect(html).toContain('value="5"');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
cd frontend; npm test -- src/features/admin-config/config-edit-state.test.ts src/features/admin-config/admin-dashboard.test.ts
```
Expected: FAIL (`catalogCoverage` missing `webSearch.maxSearchesPerTurn` / `webSearch.maxFetchesPerTurn`, `AdminSection` / `CONFIG_SECTIONS` missing `'webSearch'`).

- [ ] **Step 3: Implement `'webSearch'` section in `config-edit-state.ts` and `AdminDashboard.tsx`**

1. In `frontend/src/features/admin-config/config-edit-state.ts`:
   - Update `AdminSection`:
     ```ts
     export type AdminSection = 'openrouter' | 'chat' | 'voice' | 'deepgram' | 'webSearch';
     ```
   - Add two entries to `editableFields`:
     ```ts
     {
       path: 'webSearch.maxSearchesPerTurn',
       section: 'webSearch',
       group: 'Turn budgets',
       label: 'Max searches per turn',
       kind: 'integer',
       min: 1,
       max: 20,
       unit: 'searches',
       help: 'Maximum external web searches allowed per turn (1 to 20). Default: 5.',
     },
     {
       path: 'webSearch.maxFetchesPerTurn',
       section: 'webSearch',
       group: 'Turn budgets',
       label: 'Max page fetches per turn',
       kind: 'integer',
       min: 1,
       max: 20,
       unit: 'pages',
       help: 'Maximum web page fetches allowed per turn (1 to 20). Default: 5.',
     },
     ```
2. In `frontend/src/features/admin-config/AdminDashboard.tsx`:
   - Add `{ id: 'webSearch', label: 'Web Search' }` to `CONFIG_SECTIONS`:
     ```ts
     const CONFIG_SECTIONS: { id: AdminSection; label: string }[] = [
       { id: 'openrouter', label: 'OpenRouter' },
       { id: 'chat', label: 'Chat limits' },
       { id: 'voice', label: 'Voice' },
       { id: 'deepgram', label: 'Deepgram' },
       { id: 'webSearch', label: 'Web Search' },
     ];
     ```
   - Also check `sectionForFieldPath` (or error navigation mapping) so errors on `'webSearch.*'` map to `'webSearch'`.

- [ ] **Step 4: Run tests to verify they pass**

```powershell
cd frontend; npm test -- src/features/admin-config/config-edit-state.test.ts src/features/admin-config/admin-dashboard.test.ts src/features/admin-config/role-aware-dashboard.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- frontend/src/features/admin-config/config-edit-state.ts frontend/src/features/admin-config/AdminDashboard.tsx frontend/src/features/admin-config/config-edit-state.test.ts frontend/src/features/admin-config/admin-dashboard.test.ts
git commit -m "feat(frontend): add Config page Web Search turn budget controls (5/5, 1..20)"
```

---

## Task 7: Plugins Page Web Search UI, Reducer, Styles, Dashboard Integration, and `App.tsx` OAuth Wiring

**Files:**
- Create: `frontend/src/features/plugins/web-search/web-search-setup-state.ts`
- Create: `frontend/src/features/plugins/web-search/web-search-setup-state.test.ts`
- Create: `frontend/src/features/plugins/web-search/WebSearchPanel.tsx`
- Create: `frontend/src/features/plugins/web-search/web-search-panel.test.ts`
- Create: `frontend/src/features/plugins/web-search/web-search-plugin.css`
- Create: `frontend/src/features/plugins/web-search/index.ts`
- Modify: `frontend/src/features/admin-config/AdminDashboard.tsx`
- Modify: `frontend/src/features/admin-config/admin-dashboard.test.ts`
- Modify: `frontend/src/features/admin-config/role-aware-dashboard.test.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.assembly.test.ts`

- [ ] **Step 1: Write failing reducer tests (`web-search-setup-state.test.ts`) and UI markup tests (`web-search-panel.test.ts`)**

Create `frontend/src/features/plugins/web-search/web-search-setup-state.test.ts`:

```ts
/**
 * ============================================================================
 * FILE: web-search-setup-state.test.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-setup-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify race-fenced setup reducer state, conflict locking, and zero-secret storage.
 *
 * ROLE IN PROJECT:
 *    Protects default-off enablement gating, pending provider transitions, and
 *    conflict/uncertain error handling for WebSearchPanel.
 *
 * KEY COMPONENTS:
 *    - createInitialWebSearchSetupState / webSearchSetupReducer
 *    - canToggleWebSearchEnabled / describeWebConnectionState
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { WEB_SEARCH_PROVIDERS, type WebSearchPublicStatus } from '../../../api/web-search-protocol.ts';
import {
  canToggleWebSearchEnabled,
  createInitialWebSearchSetupState,
  describeWebConnectionState,
  webSearchSetupReducer,
} from './web-search-setup-state.ts';

function status(patch: Partial<WebSearchPublicStatus> = {}): WebSearchPublicStatus {
  return {
    protocolVersion: 1,
    revision: 1,
    enabled: false,
    effectiveEnabled: false,
    providers: WEB_SEARCH_PROVIDERS.map((provider) => ({
      provider,
      state: 'not-connected',
      authMethod: null,
      authSupport: { apiKey: 'supported', browserAuthorization: 'unsupported' },
      capabilities: { browse: false, fetch: false },
      lastValidatedAt: null,
    })),
    ...patch,
  };
}

describe('web-search-setup-state', () => {
  it('blocks global toggle when no provider is connected or while conflict/uncertain locks apply', () => {
    const empty = createInitialWebSearchSetupState(status());
    expect(canToggleWebSearchEnabled(empty)).toBe(false);

    const connectedStatus = status({
      providers: status().providers.map((p) =>
        p.provider === 'exa'
          ? {
              ...p,
              state: 'connected',
              authMethod: 'api-key',
              capabilities: { browse: true, fetch: true },
              lastValidatedAt: '2026-11-14T00:00:00.000Z',
            }
          : p,
      ),
    });
    const ready = createInitialWebSearchSetupState(connectedStatus);
    expect(canToggleWebSearchEnabled(ready)).toBe(true);

    const conflicted = webSearchSetupReducer(ready, {
      type: 'failed',
      requestId: 1,
      message: 'Changed elsewhere',
      code: 'WEB_SETTINGS_CONFLICT',
    });
    expect(conflicted.stale).toBe(true);
    expect(canToggleWebSearchEnabled(conflicted)).toBe(false);

    const uncertain = webSearchSetupReducer(ready, {
      type: 'failed',
      requestId: 1,
      message: 'Unknown save',
      code: 'WEB_WRITE_UNCERTAIN',
    });
    expect(uncertain.uncertain).toBe(true);
    expect(canToggleWebSearchEnabled(uncertain)).toBe(false);
  });

  it('ignores stale request IDs and stores zero credential secrets in reducer state', () => {
    let state = createInitialWebSearchSetupState(status({ revision: 2 }));
    state = webSearchSetupReducer(state, {
      type: 'begin',
      requestId: 5,
      pending: { kind: 'connect', provider: 'exa' },
    });
    expect(state.pending).toEqual({ kind: 'connect', provider: 'exa' });

    const ignored = webSearchSetupReducer(state, {
      type: 'statusUpdated',
      requestId: 4,
      status: status({ revision: 3 }),
    });
    expect(ignored.status?.revision).toBe(2);
    expect(ignored.pending).toEqual({ kind: 'connect', provider: 'exa' });

    const applied = webSearchSetupReducer(state, {
      type: 'statusUpdated',
      requestId: 5,
      status: status({ revision: 3 }),
      notice: 'Exa updated.',
    });
    expect(applied.status?.revision).toBe(3);
    expect(applied.pending).toBeNull();
    expect(applied.notice).toBe('Exa updated.');
    expect(JSON.stringify(applied)).not.toContain('candidate');
  });

  it('provides accessible labels for every documented connection state', () => {
    for (const value of [
      'not-connected',
      'connecting',
      'connected',
      'invalid-key',
      'unavailable',
      'reconnect-required',
      'unsupported',
    ] as const) {
      expect(describeWebConnectionState(value).length).toBeGreaterThan(0);
    }
  });
});
```

Create `frontend/src/features/plugins/web-search/web-search-panel.test.ts`:

```ts
/**
 * ============================================================================
 * FILE: web-search-panel.test.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-panel.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify WebSearchPanel DOM markup, ordering, capability gating, and secret hygiene.
 *
 * ROLE IN PROJECT:
 *    Confirms the five fixed cards render in priority order, Connect account appears
 *    only when browserAuthorization is supported, toggle stays disabled without a
 *    connected provider, all states render safely, and no secret leaks into DOM.
 *
 * KEY COMPONENTS:
 *    - WebSearchPanel static markup assertions
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WebSearchClient } from '../../../api/web-search-client.ts';
import { WEB_SEARCH_PROVIDERS, type WebSearchPublicStatus } from '../../../api/web-search-protocol.ts';
import { WebSearchPanel } from './WebSearchPanel.tsx';

function mockClient(): WebSearchClient {
  return {
    status: vi.fn(),
    setEnabled: vi.fn(),
    connectProvider: vi.fn(),
    disconnectProvider: vi.fn(),
    startOAuth: vi.fn(),
    completeOAuth: vi.fn(),
  };
}

function makeStatus(
  override: (provider: WebSearchPublicStatus['providers'][number]) => WebSearchPublicStatus['providers'][number] = (p) => p,
  enabled = false,
): WebSearchPublicStatus {
  const providers = WEB_SEARCH_PROVIDERS.map((provider) =>
    override({
      provider,
      state: 'not-connected',
      authMethod: null,
      authSupport: { apiKey: 'supported', browserAuthorization: 'unsupported' },
      capabilities: { browse: false, fetch: false },
      lastValidatedAt: null,
    }),
  );
  const effectiveEnabled = enabled && providers.some((p) => p.state === 'connected');
  return {
    protocolVersion: 1,
    revision: 1,
    enabled,
    effectiveEnabled,
    providers,
  };
}

describe('WebSearchPanel', () => {
  it('renders global toggle default off & disabled without connection plus five ordered provider cards', () => {
    const html = renderToStaticMarkup(
      createElement(WebSearchPanel, {
        client: mockClient(),
        initialStatus: makeStatus(),
      }),
    );

    expect(html).toContain('Enable web search');
    expect(html).toMatch(/id="web-search-account-enabled"[^>]*disabled=""/);
    expect(html).not.toMatch(/id="web-search-account-enabled"[^>]*checked=""/);

    const positions = ['TinyFish', 'Keenable', 'Exa', 'Tavily', 'Firecrawl'].map((name) => html.indexOf(name));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    expect(html).toContain('https://agent.tinyfish.ai');
    expect(html).toContain('https://keenable.ai');
    expect(html).toContain('https://dashboard.exa.ai/api-keys');
    expect(html).toContain('https://app.tavily.com/home');
    expect(html).toContain('https://www.firecrawl.dev/app/api-keys');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('Connect account');
  });

  it('renders Connect account button ONLY for providers with browserAuthorization === supported', () => {
    const html = renderToStaticMarkup(
      createElement(WebSearchPanel, {
        client: mockClient(),
        initialStatus: makeStatus((item) =>
          item.provider === 'keenable'
            ? { ...item, authSupport: { apiKey: 'supported', browserAuthorization: 'supported' } }
            : item,
        ),
      }),
    );
    const matches = html.match(/Connect account/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(html).toContain('Connect Keenable account');
  });

  it('enables toggle when connected and renders invalid-key, unavailable, reconnect-required, and connecting states', () => {
    const initialStatus = makeStatus(
      (item) => {
        if (item.provider === 'tinyfish') return { ...item, state: 'connecting' };
        if (item.provider === 'keenable') return { ...item, state: 'invalid-key' };
        if (item.provider === 'exa') {
          return {
            ...item,
            state: 'connected',
            authMethod: 'api-key',
            capabilities: { browse: true, fetch: true },
            lastValidatedAt: '2026-11-14T00:00:00.000Z',
          };
        }
        if (item.provider === 'tavily') return { ...item, state: 'unavailable' };
        if (item.provider === 'firecrawl') return { ...item, state: 'reconnect-required' };
        return item;
      },
      true,
    );

    const html = renderToStaticMarkup(
      createElement(WebSearchPanel, {
        client: mockClient(),
        initialStatus,
      }),
    );

    expect(html).toMatch(/id="web-search-account-enabled"[^>]*checked=""/);
    expect(html).not.toMatch(/id="web-search-account-enabled"[^>]*disabled=""/);
    expect(html).toContain('Connecting…');
    expect(html).toContain('Invalid key');
    expect(html).toContain('Connected');
    expect(html).toContain('Unavailable');
    expect(html).toContain('Reconnect required');
    expect(html).toContain('Replace');
    expect(html).toContain('Disconnect');
  });
});
```

- [ ] **Step 2: Run new panel tests to verify they fail**

```powershell
cd frontend; npm test -- src/features/plugins/web-search/web-search-setup-state.test.ts src/features/plugins/web-search/web-search-panel.test.ts
```
Expected: FAIL (`web-search-setup-state.ts` and `WebSearchPanel.tsx` do not exist yet).

- [ ] **Step 3: Implement `web-search-setup-state.ts`, `WebSearchPanel.tsx`, `web-search-plugin.css`, and `index.ts`**

Create `frontend/src/features/plugins/web-search/web-search-setup-state.ts`:

```ts
/**
 * ============================================================================
 * FILE: web-search-setup-state.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-setup-state.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Manage race-safe, non-optimistic reducer state for Web Search plugin setup.
 *
 * ROLE IN PROJECT:
 *    Coordinates status loads, global enable/disable toggle gating, provider
 *    connect/replace/disconnect lifecycles, OAuth outcome banners, and
 *    conflict/uncertain revision fencing without ever holding API key secrets.
 *
 * KEY COMPONENTS:
 *    - createInitialWebSearchSetupState / webSearchSetupReducer
 *    - canToggleWebSearchEnabled / describeWebConnectionState / mapWebClientError
 * ============================================================================
 */

import type { WebSearchClientErrorCode } from '../../../api/web-search-client.ts';
import type {
  WebSearchConnectionState,
  WebSearchOAuthOutcome,
  WebSearchProvider,
  WebSearchPublicStatus,
} from '../../../api/web-search-protocol.ts';

export type WebSearchPendingAction =
  | { kind: 'refresh' }
  | { kind: 'toggle' }
  | { kind: 'connect' | 'replace' | 'disconnect' | 'oauth-start' | 'oauth-complete'; provider: WebSearchProvider };

export type WebSearchSetupState = {
  phase: 'loading' | 'ready' | 'unavailable';
  status: WebSearchPublicStatus | null;
  pending: WebSearchPendingAction | null;
  editingProvider: WebSearchProvider | null;
  confirmDisconnectProvider: WebSearchProvider | null;
  error: string | null;
  notice: string | null;
  stale: boolean;
  uncertain: boolean;
  requestId: number;
  lastOAuthOutcome: WebSearchOAuthOutcome | null;
};

export type WebSearchSetupAction =
  | { type: 'loading'; requestId: number }
  | { type: 'loaded'; requestId: number; status: WebSearchPublicStatus; notice?: string | null }
  | { type: 'unavailable'; requestId: number; message: string }
  | { type: 'begin'; requestId: number; pending: WebSearchPendingAction }
  | { type: 'statusUpdated'; requestId: number; status: WebSearchPublicStatus; notice?: string | null }
  | { type: 'failed'; requestId: number; message: string; code?: WebSearchClientErrorCode }
  | { type: 'openReplace'; provider: WebSearchProvider }
  | { type: 'closeReplace' }
  | { type: 'openDisconnect'; provider: WebSearchProvider }
  | { type: 'closeDisconnect' }
  | { type: 'setOAuthOutcome'; outcome: WebSearchOAuthOutcome | null };

export function createInitialWebSearchSetupState(
  initialStatus?: WebSearchPublicStatus,
  initialOAuthOutcome?: WebSearchOAuthOutcome | null,
): WebSearchSetupState {
  return {
    phase: initialStatus ? 'ready' : 'loading',
    status: initialStatus ?? null,
    pending: null,
    editingProvider: null,
    confirmDisconnectProvider: null,
    error: null,
    notice: initialOAuthOutcome ? describeOAuthOutcome(initialOAuthOutcome) : null,
    stale: false,
    uncertain: false,
    requestId: 0,
    lastOAuthOutcome: initialOAuthOutcome ?? null,
  };
}

export function canToggleWebSearchEnabled(state: WebSearchSetupState): boolean {
  if (state.phase !== 'ready' || !state.status) return false;
  if (state.pending !== null || state.stale || state.uncertain) return false;
  return state.status.providers.some((item) => item.state === 'connected');
}

export function describeWebConnectionState(value: WebSearchConnectionState): string {
  switch (value) {
    case 'not-connected':
      return 'Not connected';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'invalid-key':
      return 'Invalid key';
    case 'unavailable':
      return 'Unavailable';
    case 'reconnect-required':
      return 'Reconnect required';
    case 'unsupported':
      return 'Unsupported';
  }
}

export function describeOAuthOutcome(outcome: WebSearchOAuthOutcome): string {
  switch (outcome) {
    case 'connected':
      return 'Provider account connected.';
    case 'denied':
      return 'Browser authorization was cancelled or denied.';
    case 'expired':
      return 'Browser authorization expired. Start connection again.';
    case 'failed':
      return 'Browser authorization could not be completed.';
  }
}

export function mapWebClientError(code: WebSearchClientErrorCode): string {
  switch (code) {
    case 'WEB_INVALID_REQUEST':
      return 'Enter a valid credential without spaces or line breaks.';
    case 'WEB_INPUT_TOO_LARGE':
      return 'Credential exceeds the maximum allowed byte length.';
    case 'WEB_SETTINGS_CONFLICT':
      return 'Web search settings changed elsewhere. Reload status before saving again.';
    case 'WEB_CONNECTION_REQUIRED':
      return 'Connect at least one provider before enabling web search.';
    case 'WEB_INVALID_KEY':
      return 'The submitted key was rejected by the provider. Check the key and try again.';
    case 'WEB_AUTH_UNSUPPORTED':
      return 'This authentication mode is unsupported for the selected provider.';
    case 'WEB_CAPABILITY_UNSUPPORTED':
      return 'Provider does not expose a supported search or page-fetch capability.';
    case 'WEB_OAUTH_BINDING_MISMATCH':
    case 'WEB_OAUTH_STATE_INVALID':
      return 'Authorization session did not match this request. Start again.';
    case 'WEB_OAUTH_EXPIRED':
      return 'Authorization window expired before completion. Start again.';
    case 'WEB_RATE_LIMITED':
      return 'Provider rate limit reached. Wait briefly and try again.';
    case 'WEB_PROVIDER_UNAVAILABLE':
      return 'Provider service could not be reached. Connection remains unavailable right now.';
    case 'WEB_SETUP_TIMEOUT':
      return 'Connection check timed out. Reload status to confirm before retrying.';
    case 'WEB_STORAGE_UNAVAILABLE':
    case 'WEB_ENCRYPTION_UNAVAILABLE':
      return 'Server credential storage is temporarily unavailable.';
    case 'WEB_WRITE_UNCERTAIN':
      return 'Save outcome is unknown. Reload status before retrying.';
    case 'NETWORK_ERROR':
      return 'Could not reach the Aurvin backend. Check your connection and reload.';
    case 'ABORTED':
      return 'Request cancelled.';
    case 'INVALID_WEB_RESPONSE':
    case 'WEB_HTTP_ERROR':
      return 'Web search configuration could not be updated right now.';
  }
}

export function webSearchSetupReducer(
  state: WebSearchSetupState,
  action: WebSearchSetupAction,
): WebSearchSetupState {
  switch (action.type) {
    case 'loading':
      return {
        ...state,
        phase: state.status ? state.phase : 'loading',
        pending: { kind: 'refresh' },
        error: null,
        requestId: Math.max(state.requestId, action.requestId),
      };
    case 'loaded':
      if (action.requestId < state.requestId) return state;
      return {
        ...state,
        phase: 'ready',
        status: action.status,
        pending: null,
        editingProvider: null,
        confirmDisconnectProvider: null,
        error: null,
        notice: action.notice !== undefined ? action.notice : state.notice,
        stale: false,
        uncertain: false,
        requestId: action.requestId,
      };
    case 'unavailable':
      if (action.requestId < state.requestId) return state;
      return {
        ...state,
        phase: state.status ? state.phase : 'unavailable',
        pending: null,
        error: action.message,
        requestId: action.requestId,
      };
    case 'begin':
      if (action.requestId < state.requestId) return state;
      return {
        ...state,
        pending: action.pending,
        error: null,
        notice: null,
        requestId: action.requestId,
      };
    case 'statusUpdated':
      if (action.requestId < state.requestId) return state;
      return {
        ...state,
        phase: 'ready',
        status: action.status,
        pending: null,
        editingProvider: null,
        confirmDisconnectProvider: null,
        error: null,
        notice: action.notice ?? null,
        stale: false,
        uncertain: false,
        requestId: action.requestId,
      };
    case 'failed':
      if (action.requestId < state.requestId) return state;
      return {
        ...state,
        pending: null,
        confirmDisconnectProvider: null,
        error: action.message,
        stale: state.stale || action.code === 'WEB_SETTINGS_CONFLICT',
        uncertain: state.uncertain || action.code === 'WEB_WRITE_UNCERTAIN',
        requestId: action.requestId,
      };
    case 'openReplace':
      return { ...state, editingProvider: action.provider, error: null };
    case 'closeReplace':
      return { ...state, editingProvider: null };
    case 'openDisconnect':
      return { ...state, confirmDisconnectProvider: action.provider, error: null };
    case 'closeDisconnect':
      return { ...state, confirmDisconnectProvider: null };
    case 'setOAuthOutcome':
      return {
        ...state,
        lastOAuthOutcome: action.outcome,
        notice: action.outcome ? describeOAuthOutcome(action.outcome) : null,
      };
  }
}
```

Create `frontend/src/features/plugins/web-search/WebSearchPanel.tsx`:

```tsx
/**
 * ============================================================================
 * FILE: WebSearchPanel.tsx
 * LOCATION: frontend/src/features/plugins/web-search/WebSearchPanel.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render Web Search plugin account settings and five ordered provider cards.
 *
 * ROLE IN PROJECT:
 *    Lets users and admins connect, replace, disconnect, or authorize supported
 *    web-search providers in fixed fallback priority and control the global
 *    default-off web-search toggle without persisting keys in the browser.
 *
 * KEY COMPONENTS:
 *    - WebSearchPanel: Container managing bounded async actions and OAuth finish.
 *    - ProviderCard: Local ephemeral masked key input, verified console link,
 *      state badge, Connect/Replace/Disconnect, and gated Connect account action.
 * ============================================================================
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  WEB_SEARCH_PROVIDER_CATALOG,
  type WebSearchOAuthCallbackResult,
  type WebSearchOAuthOutcome,
  type WebSearchProvider,
  type WebSearchProviderCatalogEntry,
  type WebSearchPublicProvider,
  type WebSearchPublicStatus,
} from '../../../api/web-search-protocol.ts';
import { WebSearchClientError, type WebSearchClient } from '../../../api/web-search-client.ts';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import {
  canToggleWebSearchEnabled,
  createInitialWebSearchSetupState,
  describeOAuthOutcome,
  describeWebConnectionState,
  mapWebClientError,
  webSearchSetupReducer,
} from './web-search-setup-state.ts';
import './web-search-plugin.css';

export type WebSearchPanelProps = {
  client: WebSearchClient;
  initialStatus?: WebSearchPublicStatus;
  initialOAuthCallback?: WebSearchOAuthCallbackResult | null;
  oauthOutcome?: WebSearchOAuthOutcome | null;
  onDismissOAuthOutcome?: () => void;
  onConsumeOAuthCallback?: () => void;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
  onNavigateUrl?: (url: string) => void;
};

type ProviderCardProps = {
  catalog: WebSearchProviderCatalogEntry;
  providerState: WebSearchPublicProvider;
  disabled: boolean;
  editing: boolean;
  pendingKind: 'connect' | 'replace' | 'disconnect' | 'oauth-start' | 'oauth-complete' | null;
  onConnectKey: (provider: WebSearchProvider, candidate: string, replace: boolean) => Promise<boolean>;
  onOpenReplace: (provider: WebSearchProvider) => void;
  onCloseReplace: () => void;
  onRequestDisconnect: (provider: WebSearchProvider) => void;
  onStartOAuth: (provider: WebSearchProvider) => Promise<void>;
};

function ProviderCard({
  catalog,
  providerState,
  disabled,
  editing,
  pendingKind,
  onConnectKey,
  onOpenReplace,
  onCloseReplace,
  onRequestDisconnect,
  onStartOAuth,
}: ProviderCardProps) {
  const [candidate, setCandidate] = useState('');
  const inputId = `web-search-key-${catalog.provider}`;
  const helpId = `${inputId}-help`;
  const isConnected = providerState.state === 'connected';
  const showDisconnectedConnectForm = providerState.state === 'not-connected' || providerState.state === 'unsupported';
  const showKeyInput =
    providerState.authSupport.apiKey !== 'unsupported' && (showDisconnectedConnectForm || editing);
  const canDisconnect = providerState.state !== 'not-connected';
  const effectiveState =
    pendingKind === 'connect' || pendingKind === 'replace' ? 'connecting' : providerState.state;
  const statusLabel = describeWebConnectionState(effectiveState);
  const canSubmitKey = candidate.trim().length > 0 && !disabled && pendingKind === null;

  useEffect(() => {
    return () => {
      setCandidate('');
    };
  }, []);

  const handleSubmit = async (replace: boolean) => {
    const raw = candidate;
    setCandidate('');
    const ok = await onConnectKey(catalog.provider, raw, replace);
    if (!ok) {
      // Do not repopulate candidate into DOM/memory after failed/aborted request.
    }
  };

  return (
    <article
      className="aurvin-web-provider-card"
      data-provider={catalog.provider}
      data-state={effectiveState}
      aria-labelledby={`web-search-title-${catalog.provider}`}
    >
      <div className="aurvin-web-provider-header">
        <div>
          <span className="aurvin-web-priority">Priority {catalog.priority}</span>
          <h4 id={`web-search-title-${catalog.provider}`} className="aurvin-web-provider-title">
            {catalog.displayName}
          </h4>
        </div>
        <span
          className={`aurvin-web-state-pill aurvin-web-state-${effectiveState}`}
          aria-live="polite"
        >
          {statusLabel}
        </span>
      </div>

      <p id={helpId} className="aurvin-admin-help">
        {catalog.keyInstructions}
      </p>
      {catalog.compatibilityNote ? (
        <p className="aurvin-web-compatibility-note">{catalog.compatibilityNote}</p>
      ) : null}

      <div className="aurvin-web-meta-row">
        <a
          className="aurvin-admin-button aurvin-web-console-link"
          href={catalog.consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {catalog.consoleLabel}
        </a>
        {isConnected ? (
          <span className="aurvin-web-capabilities">
            {providerState.capabilities.browse && providerState.capabilities.fetch
              ? 'Search & page fetch active'
              : providerState.capabilities.browse
                ? 'Search only (fetch unsupported)'
                : 'Page fetch only'}
          </span>
        ) : null}
        {providerState.lastValidatedAt ? (
          <span className="aurvin-web-validated">
            Validated {providerState.lastValidatedAt.slice(0, 10)}
          </span>
        ) : null}
      </div>

      {showKeyInput ? (
        <form
          className="aurvin-web-key-form"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmitKey) void handleSubmit(editing);
          }}
        >
          <label htmlFor={inputId}>{catalog.displayName} API key</label>
          <div className="aurvin-web-key-controls">
            <input
              id={inputId}
              name={`web-search-${catalog.provider}-key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={candidate}
              aria-describedby={helpId}
              disabled={disabled || pendingKind !== null}
              placeholder="Paste API key"
              onChange={(event) => setCandidate(event.target.value)}
            />
            <button
              type="submit"
              className="aurvin-admin-button aurvin-admin-button-primary"
              disabled={!canSubmitKey}
            >
              {pendingKind === 'connect' || pendingKind === 'replace'
                ? 'Connecting…'
                : editing
                  ? 'Save replacement'
                  : 'Connect'}
            </button>
            {editing ? (
              <button
                type="button"
                className="aurvin-admin-button"
                disabled={pendingKind !== null}
                onClick={() => {
                  setCandidate('');
                  onCloseReplace();
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      <div className="aurvin-web-card-actions">
        {!showDisconnectedConnectForm && !editing && providerState.authSupport.apiKey !== 'unsupported' ? (
          <button
            type="button"
            className="aurvin-admin-button"
            disabled={disabled || pendingKind !== null}
            onClick={() => onOpenReplace(catalog.provider)}
          >
            Replace
          </button>
        ) : null}

        {providerState.authSupport.browserAuthorization === 'supported' ? (
          <button
            type="button"
            className="aurvin-admin-button"
            disabled={disabled || pendingKind !== null}
            onClick={() => {
              void onStartOAuth(catalog.provider);
            }}
          >
            {pendingKind === 'oauth-start' ? 'Starting…' : `Connect ${catalog.displayName} account`}
          </button>
        ) : null}

        {canDisconnect ? (
          <button
            type="button"
            className="aurvin-admin-button aurvin-web-disconnect-btn"
            disabled={disabled || pendingKind !== null}
            onClick={() => onRequestDisconnect(catalog.provider)}
          >
            Disconnect
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function WebSearchPanel({
  client,
  initialStatus,
  initialOAuthCallback = null,
  oauthOutcome = null,
  onDismissOAuthOutcome,
  onConsumeOAuthCallback,
  disabled = false,
  onBusy,
  onNavigateUrl,
}: WebSearchPanelProps) {
  const [state, dispatch] = useReducer(
    webSearchSetupReducer,
    createInitialWebSearchSetupState(initialStatus, oauthOutcome),
  );
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const statusRef = useRef<WebSearchPublicStatus | null>(initialStatus ?? null);
  statusRef.current = state.status;

  useEffect(() => {
    onBusy?.(state.pending !== null);
  }, [onBusy, state.pending]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const loadStatus = useCallback(async (notice?: string | null) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestSeqRef.current;
    dispatch({ type: 'loading', requestId });
    try {
      const next = await client.status(controller.signal);
      dispatch({ type: 'loaded', requestId, status: next, notice });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message =
        error instanceof WebSearchClientError
          ? mapWebClientError(error.code)
          : 'Web search status could not be loaded.';
      dispatch({ type: 'unavailable', requestId, message });
    }
  }, [client]);

  useEffect(() => {
    if (initialOAuthCallback?.kind === 'complete-query') {
      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = ++requestSeqRef.current;
      dispatch({
        type: 'begin',
        requestId,
        pending: { kind: 'oauth-complete', provider: initialOAuthCallback.provider },
      });
      void client
        .completeOAuth(
          initialOAuthCallback.provider,
          { protocolVersion: 1, rawQuery: initialOAuthCallback.rawQuery },
          controller.signal,
        )
        .then((res) => {
          if (controller.signal.aborted) return;
          onConsumeOAuthCallback?.();
          return loadStatus(describeOAuthOutcome(res.outcome));
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          onConsumeOAuthCallback?.();
          const code = error instanceof WebSearchClientError ? error.code : 'WEB_HTTP_ERROR';
          dispatch({ type: 'failed', requestId, code, message: mapWebClientError(code) });
        });
      return () => {
        controller.abort();
      };
    }

    if (!initialStatus) {
      void loadStatus();
    }
    return undefined;
  }, [client, initialOAuthCallback, initialStatus, loadStatus, onConsumeOAuthCallback]);

  const handleToggleEnabled = async (nextEnabled: boolean) => {
    if (!statusRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestSeqRef.current;
    dispatch({ type: 'begin', requestId, pending: { kind: 'toggle' } });
    try {
      const next = await client.setEnabled(
        {
          protocolVersion: 1,
          expectedRevision: statusRef.current.revision,
          enabled: nextEnabled,
        },
        controller.signal,
      );
      dispatch({
        type: 'statusUpdated',
        requestId,
        status: next,
        notice: next.effectiveEnabled
          ? 'Web search enabled for new turns.'
          : 'Web search disabled.',
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof WebSearchClientError ? error.code : 'WEB_HTTP_ERROR';
      dispatch({ type: 'failed', requestId, code, message: mapWebClientError(code) });
    }
  };

  const handleConnectKey = async (
    provider: WebSearchProvider,
    candidate: string,
    replace: boolean,
  ): Promise<boolean> => {
    if (!statusRef.current) return false;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestSeqRef.current;
    dispatch({
      type: 'begin',
      requestId,
      pending: { kind: replace ? 'replace' : 'connect', provider },
    });
    try {
      const next = await client.connectProvider(
        provider,
        {
          protocolVersion: 1,
          expectedRevision: statusRef.current.revision,
          candidate: candidate.trim(),
        },
        controller.signal,
      );
      const label =
        WEB_SEARCH_PROVIDER_CATALOG.find((item) => item.provider === provider)?.displayName ?? provider;
      dispatch({
        type: 'statusUpdated',
        requestId,
        status: next,
        notice: `${label} key saved and validated.`,
      });
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      const code = error instanceof WebSearchClientError ? error.code : 'WEB_HTTP_ERROR';
      dispatch({ type: 'failed', requestId, code, message: mapWebClientError(code) });
      return false;
    }
  };

  const handleConfirmDisconnect = async () => {
    const provider = state.confirmDisconnectProvider;
    if (!provider || !statusRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestSeqRef.current;
    dispatch({ type: 'begin', requestId, pending: { kind: 'disconnect', provider } });
    try {
      const next = await client.disconnectProvider(
        provider,
        {
          protocolVersion: 1,
          expectedRevision: statusRef.current.revision,
          confirm: true,
        },
        controller.signal,
      );
      const label =
        WEB_SEARCH_PROVIDER_CATALOG.find((item) => item.provider === provider)?.displayName ?? provider;
      dispatch({
        type: 'statusUpdated',
        requestId,
        status: next,
        notice: `${label} disconnected.`,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof WebSearchClientError ? error.code : 'WEB_HTTP_ERROR';
      dispatch({ type: 'failed', requestId, code, message: mapWebClientError(code) });
    }
  };

  const handleStartOAuth = async (provider: WebSearchProvider) => {
    if (!statusRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestSeqRef.current;
    dispatch({ type: 'begin', requestId, pending: { kind: 'oauth-start', provider } });
    try {
      const response = await client.startOAuth(
        provider,
        {
          protocolVersion: 1,
          expectedRevision: statusRef.current.revision,
        },
        controller.signal,
      );
      if (onNavigateUrl) {
        onNavigateUrl(response.authorizationUrl);
      } else if (typeof window !== 'undefined') {
        window.location.assign(response.authorizationUrl);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof WebSearchClientError ? error.code : 'WEB_HTTP_ERROR';
      dispatch({ type: 'failed', requestId, code, message: mapWebClientError(code) });
    }
  };

  const mutationLocked = disabled || state.pending !== null || state.stale || state.uncertain;
  const hasConnected = Boolean(state.status?.providers.some((item) => item.state === 'connected'));
  const toggleDisabled = !canToggleWebSearchEnabled(state) || disabled;

  return (
    <section className="aurvin-web-plugin" aria-label="Web Search configuration">
      <div className="aurvin-admin-policy aurvin-web-disclosure">
        <p>
          When enabled, Aurvin may send search queries and requested page URLs to your highest-priority
          connected provider in order (TinyFish, Keenable, Exa, Tavily, Firecrawl). Fetched external web
          content is treated as untrusted data. Credentials remain encrypted on the server and are never
          stored or redisplayed in the browser.
        </p>
      </div>

      {state.error ? (
        <div className="aurvin-admin-status aurvin-admin-status-error" role="alert">
          <span>{state.error}</span>
          {(state.stale || state.uncertain || state.phase === 'unavailable') ? (
            <button
              type="button"
              className="aurvin-admin-button"
              disabled={state.pending !== null}
              onClick={() => {
                void loadStatus();
              }}
            >
              Reload status
            </button>
          ) : null}
        </div>
      ) : null}

      {state.notice ? (
        <div className="aurvin-admin-status aurvin-admin-status-saved" role="status" aria-live="polite">
          <span>{state.notice}</span>
          {oauthOutcome ? (
            <button
              type="button"
              className="aurvin-admin-button"
              onClick={() => {
                dispatch({ type: 'setOAuthOutcome', outcome: null });
                onDismissOAuthOutcome?.();
              }}
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}

      {state.phase === 'loading' && !state.status ? (
        <p className="aurvin-admin-status" role="status" aria-live="polite">
          Loading web search status…
        </p>
      ) : null}

      {state.status ? (
        <>
          <div className="aurvin-web-global-card">
            <label className="aurvin-admin-check" htmlFor="web-search-account-enabled">
              <input
                id="web-search-account-enabled"
                type="checkbox"
                checked={state.status.enabled}
                disabled={toggleDisabled}
                aria-describedby="web-search-account-enabled-help"
                onChange={(event) => {
                  void handleToggleEnabled(event.target.checked);
                }}
              />
              <span>Enable web search</span>
            </label>
            <p id="web-search-account-enabled-help" className="aurvin-admin-help">
              {!hasConnected
                ? 'Connect at least one provider below before enabling web search.'
                : state.status.effectiveEnabled
                  ? 'Active for new chat and voice turns (per-turn search and fetch budgets apply).'
                  : 'Off by default until enabled here.'}
            </p>
          </div>

          <div className="aurvin-web-provider-list">
            {WEB_SEARCH_PROVIDER_CATALOG.map((catalog) => {
              const providerState =
                state.status!.providers.find((p) => p.provider === catalog.provider) ?? {
                  provider: catalog.provider,
                  state: 'not-connected' as const,
                  authMethod: null,
                  authSupport: { apiKey: 'unverified' as const, browserAuthorization: 'unverified' as const },
                  capabilities: { browse: false, fetch: false },
                  lastValidatedAt: null,
                };
              const pendingKind =
                state.pending && 'provider' in state.pending && state.pending.provider === catalog.provider
                  ? state.pending.kind
                  : null;
              return (
                <ProviderCard
                  key={catalog.provider}
                  catalog={catalog}
                  providerState={providerState}
                  disabled={mutationLocked}
                  editing={state.editingProvider === catalog.provider}
                  pendingKind={pendingKind}
                  onConnectKey={handleConnectKey}
                  onOpenReplace={(p) => dispatch({ type: 'openReplace', provider: p })}
                  onCloseReplace={() => dispatch({ type: 'closeReplace' })}
                  onRequestDisconnect={(p) => dispatch({ type: 'openDisconnect', provider: p })}
                  onStartOAuth={handleStartOAuth}
                />
              );
            })}
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={state.confirmDisconnectProvider !== null}
        title="Disconnect provider?"
        message="Remove this stored provider credential from your Aurvin account? Web search will skip this provider unless reconnected."
        confirmLabel="Disconnect"
        cancelLabel="Cancel"
        variant="danger"
        busy={state.pending?.kind === 'disconnect'}
        onConfirm={() => {
          void handleConfirmDisconnect();
        }}
        onCancel={() => dispatch({ type: 'closeDisconnect' })}
      />
    </section>
  );
}
```

Create `frontend/src/features/plugins/web-search/web-search-plugin.css`:

```css
/**
 * ============================================================================
 * FILE: web-search-plugin.css
 * LOCATION: frontend/src/features/plugins/web-search/web-search-plugin.css
 * ============================================================================
 *
 * PURPOSE:
 *    Responsive styles for the Plugins -> Web Search settings cards and badges.
 *
 * ROLE IN PROJECT:
 *    Reuses admin-config surface tokens and provides accessible wrapping and
 *    focus rings across desktop and mobile viewports.
 *
 * KEY COMPONENTS:
 *    - .aurvin-web-plugin / .aurvin-web-global-card / .aurvin-web-provider-card
 *    - .aurvin-web-state-pill / .aurvin-web-key-form
 * ============================================================================
 */

.aurvin-web-plugin {
  display: grid;
  gap: 16px;
}

.aurvin-web-global-card,
.aurvin-web-provider-card {
  padding: 16px;
  border: 1px solid var(--aurvin-border);
  border-radius: 12px;
  background: var(--aurvin-surface);
  display: grid;
  gap: 10px;
}

.aurvin-web-provider-list {
  display: grid;
  gap: 14px;
}

.aurvin-web-provider-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.aurvin-web-priority {
  font-size: 0.78rem;
  color: var(--aurvin-text-muted);
}

.aurvin-web-provider-title {
  margin: 2px 0 0;
  font-size: 1rem;
}

.aurvin-web-state-pill {
  font-size: 0.82rem;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--aurvin-border);
}

.aurvin-web-state-connected {
  border-color: #2e8555;
  color: #7ee7a8;
}

.aurvin-web-state-invalid-key,
.aurvin-web-state-reconnect-required {
  border-color: #c94a4a;
  color: #ffb3b3;
}

.aurvin-web-compatibility-note,
.aurvin-web-capabilities,
.aurvin-web-validated {
  margin: 0;
  font-size: 0.85rem;
  color: var(--aurvin-text-muted);
}

.aurvin-web-meta-row,
.aurvin-web-card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.aurvin-web-console-link {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}

.aurvin-web-key-form {
  display: grid;
  gap: 6px;
}

.aurvin-web-key-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.aurvin-web-key-controls input {
  flex: 1 1 220px;
  min-width: 0;
  min-height: 38px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--aurvin-border);
  background: var(--aurvin-bg);
  color: var(--aurvin-text);
}

@media (max-width: 600px) {
  .aurvin-web-key-controls button,
  .aurvin-web-card-actions button,
  .aurvin-web-console-link {
    width: 100%;
    justify-content: center;
  }
}
```

- [ ] **Step 4: Wire `Web Search` into `AdminDashboard.tsx`, `App.tsx`, and test files**

2. In `frontend/src/features/admin-config/AdminDashboard.tsx`:
```tsx
// Add imports:
import { createWebSearchClient, type WebSearchClient } from '../../api/web-search-client.ts';
import type {
  WebSearchOAuthCallbackResult,
  WebSearchOAuthOutcome,
  WebSearchPublicStatus,
} from '../../api/web-search-protocol.ts';
import { WebSearchPanel } from '../plugins/web-search/WebSearchPanel.tsx';

// Extend PluginSection & PLUGIN_SECTIONS:
export type PluginSection = 'calendar' | 'web-search';
const PLUGIN_SECTIONS: { id: PluginSection; label: string }[] = [
  { id: 'calendar', label: 'Google Calendar' },
  { id: 'web-search', label: 'Web Search' },
];

// Extend AdminDashboardProps:
export type AdminDashboardProps = {
  // ...existing props preserved...
  webSearchClient?: WebSearchClient;
  initialWebSearchStatus?: WebSearchPublicStatus;
  initialWebSearchOAuthCallback?: WebSearchOAuthCallbackResult | null;
  webSearchOAuthOutcome?: WebSearchOAuthOutcome | null;
  onDismissWebSearchOAuthOutcome?: () => void;
  onConsumeWebSearchOAuthCallback?: () => void;
};

// Inside AdminDashboard():
const [webSearchBusy, setWebSearchBusy] = useState(false);
const defaultWebSearchClient = useMemo(() => createWebSearchClient(), []);
// Include webSearchBusy in mutationBusy:
const mutationBusy = Boolean(configBusy || calendarBusy || webSearchBusy);

// Render beside GoogleCalendarPanel inside .aurvin-admin-main:
{tab === 'plugins' && plugin === 'web-search' ? (
  <WebSearchPanel
    client={webSearchClient ?? defaultWebSearchClient}
    initialStatus={initialWebSearchStatus}
    initialOAuthCallback={initialWebSearchOAuthCallback}
    oauthOutcome={webSearchOAuthOutcome}
    onDismissOAuthOutcome={onDismissWebSearchOAuthOutcome}
    onConsumeOAuthCallback={onConsumeWebSearchOAuthCallback}
    disabled={editingLocked}
    onBusy={setWebSearchBusy}
  />
) : null}
```
Confirm `isStandardUser` still hides `Config`, `Analytics`, and `Administration` tabs without calling `client.read()`, while allowing `Plugins -> Google Calendar` and `Plugins -> Web Search`.

3. In `frontend/src/App.tsx`:
```tsx
// Add imports:
import { createWebSearchClient, type WebSearchClient } from './api/web-search-client.ts';
import {
  extractAndScrubWebSearchOAuthCallback,
  type WebSearchOAuthCallbackResult,
  type WebSearchOAuthOutcome,
} from './api/web-search-protocol.ts';

// Inside App props:
webSearchClient?: WebSearchClient;

// Inside App initial mount alongside extractAndScrubCalendarOAuthCallback:
const [webOAuthState, setWebOAuthState] = useState<{
  callback: WebSearchOAuthCallbackResult | null;
  outcome: WebSearchOAuthOutcome | null;
}>(() => {
  if (typeof window === 'undefined') return { callback: null, outcome: null };
  const parsed = extractAndScrubWebSearchOAuthCallback(window.location.href);
  if (!parsed) return { callback: null, outcome: null };
  window.history.replaceState({}, '', parsed.scrubbedPathAndSearch);
  return parsed.kind === 'resolved'
    ? { callback: null, outcome: parsed.outcome }
    : { callback: parsed, outcome: null };
});

// If webOAuthState.callback || webOAuthState.outcome is non-null on initial load,
// default admin section to 'web-search' and open AdminDashboard; pass:
//   webSearchClient={props.webSearchClient}
//   initialWebSearchOAuthCallback={webOAuthState.callback}
//   webSearchOAuthOutcome={webOAuthState.outcome}
//   onConsumeWebSearchOAuthCallback={() => setWebOAuthState((s) => ({ ...s, callback: null }))}
//   onDismissWebSearchOAuthOutcome={() => setWebOAuthState((s) => ({ ...s, outcome: null }))}
```

4. Also update `frontend/src/App.assembly.test.ts` to verify no `localStorage`/`sessionStorage`/`VITE_` secret exposure across `web-search` modules:
```ts
it('wires webSearchClient, scrubs Web Search OAuth params, and keeps web-search modules free of storage or secret VITE_* flags', async () => {
  const { extractAndScrubWebSearchOAuthCallback } = await import('./api/web-search-protocol.ts');
  const scrubbed = extractAndScrubWebSearchOAuthCallback(
    'http://127.0.0.1:5173/?plugin=web-search&provider=exa&code=c1&state=s1',
  );
  expect(scrubbed).toMatchObject({ kind: 'complete-query', provider: 'exa', scrubbedPathAndSearch: '/' });

  const files = [
    new URL('./App.tsx', import.meta.url),
    new URL('./api/web-search-protocol.ts', import.meta.url),
    new URL('./api/web-search-client.ts', import.meta.url),
    new URL('./features/plugins/web-search/WebSearchPanel.tsx', import.meta.url),
  ];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    expect(content).not.toMatch(/localStorage|sessionStorage/);
    expect(content).not.toMatch(/VITE_(?!API_BASE)/);
  }
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  expect(app).toContain('webSearchClient?: WebSearchClient');
});
```

3. Add tests in:
   - `frontend/src/features/admin-config/admin-dashboard.test.ts`:
     ```ts
     it('shows Web Search alongside Google Calendar in Plugins rail and renders WebSearchPanel when selected', () => {
       const html = renderToStaticMarkup(
         createElement(AdminDashboard, {
           client,
           onBackToChat: () => undefined,
           refreshCapabilities: async () => true,
           initialSection: 'web-search',
           webSearchClient: {
             status: vi.fn(),
             setEnabled: vi.fn(),
             connectProvider: vi.fn(),
             disconnectProvider: vi.fn(),
             startOAuth: vi.fn(),
             completeOAuth: vi.fn(),
           },
         }),
       );
       expect(html).toMatch(/id="[^"]+-plugins-tab"[^>]*aria-selected="true"/);
       expect(html).toContain('Google Calendar');
       expect(html).toContain('Web Search');
       expect(html).toContain('Loading web search status…');
     });
     ```
   - `frontend/src/features/admin-config/role-aware-dashboard.test.ts`:
     ```ts
     it('lets standard Users open Plugins -> Web Search without calling adminClient.read', () => {
       const read = vi.fn(async () => publicConfig());
       const html = renderToStaticMarkup(
         createElement(AdminDashboard, {
           client: { read, saveSettings: vi.fn(), updateCredential: vi.fn() },
           user: { userId: 'u1', email: 'u@example.com', role: 'user', passwordChangeRequired: false },
           onBackToChat: () => undefined,
           refreshCapabilities: async () => true,
           initialSection: 'web-search',
         }),
       );
       expect(html).toContain('Web Search');
       expect(read).not.toHaveBeenCalled();
     });
     ```
   - `frontend/src/App.assembly.test.ts`: assert `expect(app).toContain('webSearchClient?: WebSearchClient')`, `extractAndScrubWebSearchOAuthCallback`, and `expect(app).not.toMatch(/localStorage|sessionStorage/)`.

- [ ] **Step 5: Run tests**

```powershell
cd frontend; npm test -- src/features/plugins/web-search/ src/features/admin-config/admin-dashboard.test.ts src/features/admin-config/role-aware-dashboard.test.ts src/App.assembly.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- frontend/src/features/plugins/web-search/web-search-setup-state.ts frontend/src/features/plugins/web-search/web-search-setup-state.test.ts frontend/src/features/plugins/web-search/WebSearchPanel.tsx frontend/src/features/plugins/web-search/web-search-panel.test.ts frontend/src/features/plugins/web-search/web-search-plugin.css frontend/src/features/admin-config/AdminDashboard.tsx frontend/src/features/admin-config/admin-dashboard.test.ts frontend/src/features/admin-config/role-aware-dashboard.test.ts frontend/src/App.tsx frontend/src/App.assembly.test.ts
git commit -m "feat(frontend): add Plugins Web Search setup UI, default-off gating, and OAuth wiring"
```

---

## Task 8: Text & Live Voice Web Activity and Source Presentation (No Composer Toggle)

**Files:**
- Create: `frontend/src/features/plugins/web-search/web-search-presentation.ts`
- Create: `frontend/src/features/plugins/web-search/web-search-presentation.test.ts`
- Create: `frontend/src/features/plugins/web-search/WebSearchActivityView.tsx`
- Create: `frontend/src/features/chat/state/web-search-chat-state.test.ts`
- Modify: `frontend/src/features/plugins/web-search/index.ts`
- Modify: `frontend/src/features/chat/state/chat-types.ts`, `frontend/src/features/chat/state/chat-reducer.ts`, `frontend/src/features/chat/state/use-chat.ts`
- Modify: `frontend/src/components/Transcript.tsx`, `frontend/src/components/MessageItem.tsx`, `frontend/src/components/MessageItem.test.ts`
- Modify: `frontend/src/components/group-voice-messages.ts`, `frontend/src/components/VoiceTranscriptModal.tsx`, `frontend/src/components/VoiceTranscriptModal.test.ts`, `frontend/src/components/Composer.test.ts`, `frontend/src/styles/chat.css`
- Modify: `frontend/src/features/voice/state/live-voice-reducer.ts`, `live-voice-reducer.test.ts`, `live-voice-controller.ts`, `live-voice-controller.test.ts`
- Modify: `frontend/src/features/voice/live/LiveVoicePanel.tsx`, `frontend/src/features/voice/live/live-voice-surface.test.ts`, `frontend/src/features/voice/live/live-voice.css`

- [ ] **Step 1: Write failing presentation tests (`web-search-presentation.test.ts`) and build pure folding/presentation module + `WebSearchActivityView.tsx`**

Create `frontend/src/features/plugins/web-search/web-search-presentation.test.ts`:

```ts
/**
 * ============================================================================
 * FILE: web-search-presentation.test.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-presentation.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify folding and rendering of web activities and HTTP(S)-only source citations.
 *
 * ROLE IN PROJECT:
 *    Ensures searching/reading/fallback/completed/failed/cancelled labels stay
 *    concise and honest, unsafe URLs never become links, and no sources are invented.
 *
 * KEY COMPONENTS:
 *    - foldWebActivities / foldWebSources / summarizeWebActivities
 *    - WebSearchActivityView rendered markup
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WebSearchActivity, WebSourceReference } from '../../../api/web-search-protocol.ts';
import {
  foldWebActivities,
  foldWebSources,
  summarizeWebActivities,
} from './web-search-presentation.ts';
import { WebSearchActivityView } from './WebSearchActivityView.tsx';

const src = (id: string, url: string): WebSourceReference => ({
  sourceId: id,
  toolCallId: 'call_1',
  provider: 'exa',
  kind: 'browse',
  title: `Source ${id}`,
  url,
  retrievedAt: '2026-11-14T00:00:00.000Z',
});

describe('web-search-presentation', () => {
  it('folds bounded activities and summarizes searching, reading, fallback, failed, and cancelled honestly', () => {
    const acts = foldWebActivities(
      [],
      { toolCallId: 'c1', mode: 'browse', phase: 'searching', provider: 'tinyfish', code: null },
    );
    expect(summarizeWebActivities(acts).label).toContain('Searching');
    expect(summarizeWebActivities(acts).label).toContain('TinyFish');

    const reading = foldWebActivities(acts, {
      toolCallId: 'c2',
      mode: 'fetch',
      phase: 'reading',
      provider: 'exa',
      code: null,
    });
    expect(summarizeWebActivities(reading).label).toContain('Reading page');

    const fallback = foldWebActivities(reading, {
      toolCallId: 'c1',
      mode: 'browse',
      phase: 'fallback',
      provider: 'keenable',
      code: null,
    });
    expect(summarizeWebActivities(fallback).label).toContain('Keenable');

    const failed = summarizeWebActivities([
      { toolCallId: 'c1', mode: 'fetch', phase: 'failed', provider: 'exa', code: 'WEB_URL_UNSAFE' },
    ]);
    expect(failed.tone).toBe('failed');
    expect(failed.label).toContain('blocked');

    const cancelled = summarizeWebActivities([
      { toolCallId: 'c1', mode: 'browse', phase: 'cancelled', provider: null, code: null },
    ]);
    expect(cancelled.tone).toBe('cancelled');
    expect(cancelled.label).toContain('cancelled');
  });

  it('renders only HTTP(S) links as clickable anchors and never fabricates sources', () => {
    const folded = foldWebSources(
      [src('s1', 'https://example.com/one')],
      [
        src('s1', 'https://example.com/one'),
        src('s2', 'http://docs.example.org/two'),
        src('bad1', 'javascript:alert(1)'),
        src('bad2', 'mailto:a@example.com'),
        src('bad3', '/relative'),
      ],
    );
    expect(folded.map((s) => s.sourceId)).toEqual(['s1', 's2']);

    const html = renderToStaticMarkup(
      createElement(WebSearchActivityView, {
        activities: [{ toolCallId: 'c1', mode: 'browse', phase: 'completed', provider: 'exa', code: null }],
        sources: [
          src('s1', 'https://example.com/one'),
          { ...src('tampered', 'javascript:alert(1)'), title: 'Unsafe payload' },
        ],
      }),
    );

    expect(html).toContain('href="https://example.com/one"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Sources');
    expect(html).not.toContain('Verified');

    const emptyHtml = renderToStaticMarkup(
      createElement(WebSearchActivityView, { activities: [], sources: [] }),
    );
    expect(emptyHtml).toBe('');
  });
});
```

Run `npm test -- src/features/plugins/web-search/web-search-presentation.test.ts` -> Expected FAIL.

Implement `frontend/src/features/plugins/web-search/web-search-presentation.ts`, `WebSearchActivityView.tsx`, and `index.ts`:

```ts
/**
 * ============================================================================
 * FILE: web-search-presentation.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-presentation.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Fold bounded web activities and HTTP(S)-safe sources for text and voice UI.
 *
 * ROLE IN PROJECT:
 *    Produces concise user-facing progress labels and filtered clickable links
 *    without exposing raw query strings or inventing unprovided sources.
 *
 * KEY COMPONENTS:
 *    - foldWebActivities / foldWebSources: Bounded immutable accumulators.
 *    - summarizeWebActivities: Phase/provider/error-code label resolver.
 * ============================================================================
 */

import {
  WEB_SEARCH_POLICY,
  WEB_SEARCH_PROVIDER_CATALOG,
  type WebSearchActivity,
  type WebSearchProvider,
  type WebSourceReference,
} from '../../../api/web-search-protocol.ts';
import { sanitizeWebSourceUrl } from '../../chat/markdown/sanitize-url.ts';

export type WebActivitySummary = {
  tone: 'active' | 'completed' | 'failed' | 'cancelled';
  label: string;
};

export function providerDisplayName(provider: WebSearchProvider | null): string {
  if (!provider) return 'web search';
  return WEB_SEARCH_PROVIDER_CATALOG.find((item) => item.provider === provider)?.displayName ?? provider;
}

export function foldWebActivities(
  existing: readonly WebSearchActivity[],
  next: WebSearchActivity,
): WebSearchActivity[] {
  const sameIndex = existing.findIndex(
    (item) => item.toolCallId === next.toolCallId && item.phase === next.phase && item.provider === next.provider,
  );
  if (sameIndex >= 0) {
    return existing.map((item, idx) => (idx === sameIndex ? next : item));
  }
  if (existing.length >= WEB_SEARCH_POLICY.maxActivitiesPerMessage) {
    return [...existing.slice(existing.length - WEB_SEARCH_POLICY.maxActivitiesPerMessage + 1), next];
  }
  return [...existing, next];
}

export function foldWebSources(
  existing: readonly WebSourceReference[],
  incoming: readonly WebSourceReference[],
): WebSourceReference[] {
  const byId = new Map<string, WebSourceReference>();
  for (const item of existing) {
    if (sanitizeWebSourceUrl(item.url) !== '') byId.set(item.sourceId, item);
  }
  for (const item of incoming) {
    if (sanitizeWebSourceUrl(item.url) === '') continue;
    if (!byId.has(item.sourceId) && byId.size >= WEB_SEARCH_POLICY.maxSourcesPerMessage) continue;
    byId.set(item.sourceId, item);
  }
  return [...byId.values()];
}

function describeToolFailureCode(code: string | null): string {
  switch (code) {
    case 'WEB_URL_UNSAFE':
      return 'Page URL blocked by safety policy.';
    case 'WEB_SCHEMA_REPAIR_EXHAUSTED':
      return 'Web lookup could not finish within safety limits.';
    default:
      return 'Web search could not complete cleanly.';
  }
}

export function summarizeWebActivities(
  activities: readonly WebSearchActivity[],
): WebActivitySummary {
  if (activities.length === 0) return { tone: 'completed', label: '' };
  const latest = activities[activities.length - 1]!;
  const name = providerDisplayName(latest.provider);
  switch (latest.phase) {
    case 'searching':
      return {
        tone: 'active',
        label: latest.provider ? `Searching with ${name}…` : 'Searching the web…',
      };
    case 'reading':
      return {
        tone: 'active',
        label: latest.provider ? `Reading page via ${name}…` : 'Reading page…',
      };
    case 'fallback':
      return {
        tone: 'active',
        label: latest.provider ? `Switching to backup provider ${name}…` : 'Trying backup provider…',
      };
    case 'completed': {
      const usedProviders = [...new Set(activities.map((a) => a.provider).filter((p): p is WebSearchProvider => p !== null))];
      const summaryName = usedProviders.length > 0 ? usedProviders.map(providerDisplayName).join(', ') : name;
      return {
        tone: 'completed',
        label: latest.mode === 'fetch' ? `Read page (${summaryName})` : `Searched (${summaryName})`,
      };
    }
    case 'failed':
      return {
        tone: 'failed',
        label: describeToolFailureCode(latest.code),
      };
    case 'cancelled':
      return {
        tone: 'cancelled',
        label: 'Web search cancelled.',
      };
  }
}
```

Create `frontend/src/features/plugins/web-search/WebSearchActivityView.tsx`:

```tsx
/**
 * ============================================================================
 * FILE: WebSearchActivityView.tsx
 * LOCATION: frontend/src/features/plugins/web-search/WebSearchActivityView.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render concise web search/fetch progress and safe clickable HTTP(S) sources.
 *
 * ROLE IN PROJECT:
 *    Shared by text chat assistant bubbles, VoiceTranscriptModal, and LiveVoicePanel.
 *
 * KEY COMPONENTS:
 *    - WebSearchActivityView: Activity status badge + HTTP(S)-filtered source chips.
 * ============================================================================
 */

import type { WebSearchActivity, WebSourceReference } from '../../../api/web-search-protocol.ts';
import { sanitizeWebSourceUrl } from '../../chat/markdown/sanitize-url.ts';
import { providerDisplayName, summarizeWebActivities } from './web-search-presentation.ts';

export type WebSearchActivityViewProps = {
  activities?: readonly WebSearchActivity[];
  sources?: readonly WebSourceReference[];
  variant?: 'chat' | 'voice';
};

function formatHostname(safeUrl: string): string {
  try {
    return new URL(safeUrl).hostname;
  } catch {
    return '';
  }
}

export function WebSearchActivityView({
  activities = [],
  sources = [],
  variant = 'chat',
}: WebSearchActivityViewProps) {
  const safeSources = sources
    .map((source) => ({ source, safeUrl: sanitizeWebSourceUrl(source.url) }))
    .filter((entry) => entry.safeUrl !== '');

  if (activities.length === 0 && safeSources.length === 0) {
    return null;
  }

  const summary = summarizeWebActivities(activities);

  return (
    <section
      className={`aurvin-web-presentation aurvin-web-presentation-${variant}`}
      aria-label="Web search activity and sources"
    >
      {summary.label ? (
        <p
          className={`aurvin-web-activity-pill aurvin-web-activity-${summary.tone}`}
          role="status"
          aria-live="polite"
        >
          {summary.label}
        </p>
      ) : null}

      {safeSources.length > 0 ? (
        <div className="aurvin-web-sources">
          <span className="aurvin-web-sources-heading">Sources</span>
          <ul className="aurvin-web-sources-list">
            {safeSources.map(({ source, safeUrl }) => {
              const host = formatHostname(safeUrl);
              return (
                <li key={source.sourceId} className="aurvin-web-source-item">
                  <a
                    className="aurvin-web-source-link"
                    href={safeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="aurvin-web-source-title">{source.title}</span>
                    <span className="aurvin-web-source-meta">
                      {host ? `${host} · ` : ''}
                      {providerDisplayName(source.provider)}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
```

- Create `frontend/src/features/plugins/web-search/index.ts` (updated with presentation exports in Task 8):

```ts
/**
 * ============================================================================
 * FILE: index.ts
 * LOCATION: frontend/src/features/plugins/web-search/index.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose the Web Search plugin setup panel, turn presentation view, and folding helpers.
 *
 * ROLE IN PROJECT:
 *    Provides a clean public module boundary for AdminDashboard, chat, and live voice.
 *
 * KEY COMPONENTS:
 *    - WebSearchPanel: Plugins -> Web Search setup UI.
 *    - WebSearchActivityView / foldWebActivities / foldWebSources: Turn presentation.
 * ============================================================================
 */

export { WebSearchPanel, type WebSearchPanelProps } from './WebSearchPanel.tsx';
export { WebSearchActivityView, type WebSearchActivityViewProps } from './WebSearchActivityView.tsx';
export {
  foldWebActivities,
  foldWebSources,
  providerDisplayName,
  summarizeWebActivities,
  type WebActivitySummary,
} from './web-search-presentation.ts';
```

Run `npm test -- src/features/plugins/web-search/web-search-presentation.test.ts` -> Expected PASS.

- [ ] **Step 2: Write failing tests for Text Chat / Voice Transcript / Composer & Live Voice `web.frame`**

Create `frontend/src/features/chat/state/web-search-chat-state.test.ts`:

```ts
/**
 * ============================================================================
 * FILE: web-search-chat-state.test.ts
 * LOCATION: frontend/src/features/chat/state/web-search-chat-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Web Search SSE reducer folding, turn/attempt fencing, and terminal attachment.
 *
 * ROLE IN PROJECT:
 *    Prevents stale-session web activity leakage and guarantees honest error/cancel provenance.
 *
 * KEY COMPONENTS:
 *    - chatReducer Web Search tests: Fenced WEB_ACTIVITY / WEB_SOURCES and terminal retention.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { chatReducer, initialChatState } from './chat-reducer.ts';
import type { ChatState } from './chat-types.ts';
import type { WebSearchActivity, WebSourceReference } from '../../../api/web-search-protocol.ts';

const activeState = (): ChatState => ({
  ...initialChatState,
  activeSessionId: 'session-1',
  activeTurnId: 'turn-1',
  activeAttemptId: 'attempt-1',
  isStreaming: true,
  draftInput: 'Keep my draft',
});

const searchActivity: WebSearchActivity = {
  toolCallId: 'call_1',
  mode: 'browse',
  phase: 'searching',
  provider: 'exa',
  code: null,
};

const safeSource: WebSourceReference = {
  sourceId: 'src_1',
  toolCallId: 'call_1',
  provider: 'exa',
  kind: 'browse',
  title: 'TypeScript Docs',
  url: 'https://www.typescriptlang.org/docs/',
  retrievedAt: '2026-11-14T00:00:00.000Z',
};

describe('web-search chat reducer state and fencing', () => {
  it('fences WEB_ACTIVITY and WEB_SOURCES to active session, turn, attempt, and increasing sequence', () => {
    const first = chatReducer(activeState(), {
      type: 'WEB_ACTIVITY',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        attemptId: 'attempt-1',
        sequence: 1,
        activity: searchActivity,
      },
    });
    expect(first.webActivitiesByTurn['turn-1']).toEqual([searchActivity]);

    for (const bad of [
      { sessionId: 'other-session' },
      { turnId: 'other-turn' },
      { attemptId: 'old-attempt' },
      { sequence: 1 },
    ]) {
      expect(
        chatReducer(first, {
          type: 'WEB_ACTIVITY',
          payload: {
            sessionId: 'session-1',
            turnId: 'turn-1',
            attemptId: 'attempt-1',
            sequence: 2,
            activity: { ...searchActivity, phase: 'failed', code: 'WEB_SCHEMA_REPAIR_EXHAUSTED' },
            ...bad,
          },
        }),
      ).toBe(first);
    }

    const withSources = chatReducer(first, {
      type: 'WEB_SOURCES',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        attemptId: 'attempt-1',
        sequence: 2,
        sources: [
          safeSource,
          { ...safeSource, sourceId: 'src_bad', url: 'javascript:alert(1)' },
        ],
      },
    });
    expect(withSources.webSourcesByTurn['turn-1']).toEqual([safeSource]);

    const completed = chatReducer(withSources, {
      type: 'STREAM_COMPLETED',
      payload: {
        assistantMessageId: 'msg_1',
        outcome: 'completed',
      },
    });
    expect(completed.messages.at(-1)?.webActivities).toEqual([searchActivity]);
    expect(completed.messages.at(-1)?.webSources).toEqual([safeSource]);
    expect(completed.webActivitiesByTurn['turn-1']).toBeUndefined();
    expect(completed.webSourcesByTurn['turn-1']).toBeUndefined();
  });

  it('retains failed/cancelled search activities honestly without inventing sources and clears on NEW_CHAT or SELECT_SESSION', () => {
    let state = chatReducer(activeState(), {
      type: 'WEB_ACTIVITY',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        attemptId: 'attempt-1',
        sequence: 1,
        activity: { ...searchActivity, phase: 'cancelled', provider: null },
      },
    });
    state = chatReducer(state, { type: 'STREAM_CANCELLED' });
    expect(state.messages.at(-1)?.webActivities?.[0]?.phase).toBe('cancelled');
    expect(state.messages.at(-1)?.webSources).toBeUndefined();

    const clearedNew = chatReducer(activeState(), { type: 'NEW_CHAT' });
    expect(clearedNew.webActivitiesByTurn).toEqual({});
    expect(clearedNew.webSourcesByTurn).toEqual({});
    expect(clearedNew.draftInput).toBe('Keep my draft');

    const clearedSwitch = chatReducer(activeState(), {
      type: 'SELECT_SESSION',
      payload: { sessionId: 'session-2', title: 'Second' },
    });
    expect(clearedSwitch.webActivitiesByTurn).toEqual({});
    expect(clearedSwitch.webSourcesByTurn).toEqual({});
  });
});
```

Append to `frontend/src/components/MessageItem.test.ts` (inside the outer `describe`, importing `WebSearchActivity`, `WebSourceReference` as needed):

```ts
  it('renders HTTP(S) webSources and activity for assistant messages only and strips unsafe links', () => {
    const html = renderMessage({
      role: 'assistant',
      content: 'Based on the documentation.',
      webActivities: [
        { toolCallId: 'c1', mode: 'browse', phase: 'completed', provider: 'tavily', code: null },
      ],
      webSources: [
        {
          sourceId: 's_ok',
          toolCallId: 'c1',
          provider: 'tavily',
          kind: 'browse',
          title: 'Official Docs',
          url: 'https://docs.example.com/guide',
          retrievedAt: '2026-11-14T00:00:00.000Z',
        },
        {
          sourceId: 's_bad',
          toolCallId: 'c1',
          provider: 'tavily',
          kind: 'browse',
          title: 'Injected Script',
          url: 'javascript:alert(1)',
          retrievedAt: '2026-11-14T00:00:00.000Z',
        },
      ],
    });
    expect(html).toContain('Searched (Tavily)');
    expect(html).toContain('href="https://docs.example.com/guide"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('javascript:alert(1)');

    const liveEmptyHtml = renderMessage(
      {
        role: 'assistant',
        content: '',
        webActivities: [
          { toolCallId: 'c2', mode: 'browse', phase: 'searching', provider: 'exa', code: null },
        ],
      },
      'streaming',
    );
    expect(liveEmptyHtml).toContain('<div class="aurvin-message-body"><span class="aurvin-generating-placeholder">Generating…</span>');
    expect(liveEmptyHtml).toContain('Searching with Exa…');

    const failedHtml = renderMessage({
      role: 'assistant',
      content: 'Could not look that up right now.',
      webActivities: [
        { toolCallId: 'c3', mode: 'fetch', phase: 'failed', provider: 'firecrawl', code: 'WEB_URL_UNSAFE' },
      ],
    });
    expect(failedHtml).toContain('Page URL blocked by safety policy.');
    expect(failedHtml).not.toContain('<a ');

    const userHtml = renderMessage({
      role: 'user',
      content: 'Search for release notes',
      webSources: [
        {
          sourceId: 's_user',
          toolCallId: 'c1',
          provider: 'exa',
          kind: 'browse',
          title: 'Ignored User Source',
          url: 'https://example.com',
          retrievedAt: '2026-11-14T00:00:00.000Z',
        },
      ],
    });
    expect(userHtml).not.toContain('aurvin-web-presentation');
    expect(userHtml).not.toContain('Ignored User Source');
  });
```

Append to `frontend/src/components/VoiceTranscriptModal.test.ts`:

```ts
  it('renders HTTP(S) webSources and activity inside assistant voice transcript bubbles only', () => {
    const html = renderToStaticMarkup(
      createElement(VoiceTranscriptModal, {
        durationSeconds: 20,
        transcripts: [
          {
            role: 'user',
            content: 'Check the changelog',
            webSources: [
              {
                sourceId: 'u_bad',
                toolCallId: 'c1',
                provider: 'exa',
                kind: 'browse',
                title: 'User Disallowed',
                url: 'https://disallowed.example.com',
                retrievedAt: '2026-11-14T00:00:00.000Z',
              },
            ],
          },
          {
            role: 'assistant',
            content: 'Version 2 is available.',
            webActivities: [
              { toolCallId: 'c1', mode: 'browse', phase: 'completed', provider: 'keenable', code: null },
            ],
            webSources: [
              {
                sourceId: 'a_ok',
                toolCallId: 'c1',
                provider: 'keenable',
                kind: 'browse',
                title: 'Release Notes',
                url: 'https://releases.example.com/v2',
                retrievedAt: '2026-11-14T00:00:00.000Z',
              },
              {
                sourceId: 'a_bad',
                toolCallId: 'c1',
                provider: 'keenable',
                kind: 'browse',
                title: 'Unsafe Link',
                url: 'data:text/html,boom',
                retrievedAt: '2026-11-14T00:00:00.000Z',
              },
            ],
          },
        ],
        onClose: () => {},
      }),
    );
    expect(html).toContain('Searched (Keenable)');
    expect(html).toContain('href="https://releases.example.com/v2"');
    expect(html).not.toContain('User Disallowed');
    expect(html).not.toContain('data:text/html');
  });
```

Append to `frontend/src/components/Composer.test.ts`:

```ts
  it('does not include any web-search toggle or provider controls inside the composer', () => {
    const html = renderComposer(initialChatState);
    expect(html).not.toMatch(/web[\s-]?search|tinyfish|keenable|tavily|firecrawl|\bexa\b/i);
    expect(html).not.toContain('role="switch"');
  });
```

Append to `frontend/src/features/voice/state/live-voice-reducer.test.ts`:

```ts
it('tracks bounded webActivities and webSources across WEB_FRAME, resets on START, and respects retainArtifacts on EXIT', () => {
  let state = liveVoiceReducer(initialLiveVoice, { type: 'START', conversationId: 'conv-1' });
  state = liveVoiceReducer(state, {
    type: 'WEB_FRAME',
    frame: {
      turnId: 'turn-1',
      attemptId: 'att-1',
      responseId: 'resp-1',
      event: {
        type: 'web-activity',
        activity: { toolCallId: 'c1', mode: 'browse', phase: 'searching', provider: 'exa', code: null },
      },
    },
  });
  state = liveVoiceReducer(state, {
    type: 'WEB_FRAME',
    frame: {
      turnId: 'turn-1',
      attemptId: 'att-1',
      responseId: 'resp-1',
      event: {
        type: 'web-sources',
        sources: [
          {
            sourceId: 's1',
            toolCallId: 'c1',
            provider: 'exa',
            kind: 'browse',
            title: 'Docs',
            url: 'https://docs.example.com',
            retrievedAt: '2026-11-14T00:00:00.000Z',
          },
          {
            sourceId: 's_bad',
            toolCallId: 'c1',
            provider: 'exa',
            kind: 'browse',
            title: 'Bad',
            url: 'javascript:alert(1)',
            retrievedAt: '2026-11-14T00:00:00.000Z',
          },
        ],
      },
    },
  });
  expect(state.webActivities).toHaveLength(1);
  expect(state.webSources.map((s) => s.sourceId)).toEqual(['s1']);

  const retained = liveVoiceReducer(state, { type: 'EXIT', retainArtifacts: true });
  expect(retained.webSources).toHaveLength(1);
  expect(retained.webActivities).toHaveLength(1);

  const cleared = liveVoiceReducer(state, { type: 'EXIT', retainArtifacts: false });
  expect(cleared.webSources).toEqual([]);
  expect(cleared.webActivities).toEqual([]);

  const restarted = liveVoiceReducer(retained, { type: 'START', conversationId: 'conv-2' });
  expect(restarted.webSources).toEqual([]);
  expect(restarted.webActivities).toEqual([]);
});
```

Append to `frontend/src/features/voice/state/live-voice-controller.test.ts`:

```ts
it('delivers fenced web.frame updates in LiveVoiceController and ignores stale epoch/sequence or mismatched attempt', async () => {
  const f = liveVoiceFixture();
  try {
    await f.begin();
    f.event({ type: 'conversation.bound', conversationId: 'conversation-1' });
    const emitWeb = (patch: Record<string, unknown>) =>
      f.event({
        type: 'web.frame',
        conversationId: 'conversation-1',
        turnId: 'turn-w1',
        responseId: 'resp-w1',
        attemptId: 'att-w1',
        epoch: 1,
        sequence: 1,
        event: {
          type: 'web-activity',
          activity: { toolCallId: 'c1', mode: 'browse', phase: 'searching', provider: 'exa', code: null },
        },
        ...patch,
      } as never);

    emitWeb({ conversationId: 'other-conv' });
    expect(f.controller.getSnapshot().webActivities).toEqual([]);

    emitWeb({ sequence: 1 });
    expect(f.controller.getSnapshot().webActivities).toHaveLength(1);

    // Duplicate sequence, lower epoch, and mismatched attemptId are dropped.
    emitWeb({
      sequence: 1,
      event: {
        type: 'web-activity',
        activity: { toolCallId: 'c1', mode: 'browse', phase: 'failed', provider: 'exa', code: 'WEB_SCHEMA_REPAIR_EXHAUSTED' },
      },
    });
    emitWeb({ epoch: 0, sequence: 99 });
    emitWeb({ sequence: 2, attemptId: 'att-other' });
    expect(f.controller.getSnapshot().webActivities).toHaveLength(1);

    emitWeb({
      sequence: 2,
      event: {
        type: 'web-sources',
        sources: [
          {
            sourceId: 'src-w1',
            toolCallId: 'c1',
            provider: 'exa',
            kind: 'browse',
            title: 'Voice Docs',
            url: 'https://voice.example.com/docs',
            retrievedAt: '2026-11-14T00:00:00.000Z',
          },
        ],
      },
    });
    expect(f.controller.getSnapshot().webSources).toHaveLength(1);
  } finally {
    f.controller.exit();
    await settle();
  }
});
```

Append to `frontend/src/features/voice/live/live-voice-surface.test.ts`:

```ts
it('renders WebSearchActivityView in LiveVoicePanel when web activity or sources exist and announces active phase', () => {
  const baselineHtml = render();
  expect(baselineHtml).not.toContain('aurvin-web-presentation');

  const activeHtml = render({
    webActivities: [
      { toolCallId: 'c1', mode: 'browse', phase: 'searching', provider: 'tinyfish', code: null },
    ],
    webSources: [
      {
        sourceId: 'sv_1',
        toolCallId: 'c1',
        provider: 'tinyfish',
        kind: 'browse',
        title: 'Live Ref',
        url: 'https://live.example.com/ref',
        retrievedAt: '2026-11-14T00:00:00.000Z',
      },
    ],
  });
  expect(activeHtml).toContain('aurvin-web-presentation-voice');
  expect(activeHtml).toContain('Searching with TinyFish…');
  expect(activeHtml).toContain('href="https://live.example.com/ref"');
});
```

Run the affected tests to verify FAIL:
```powershell
cd frontend; npm test -- src/features/chat/state/web-search-chat-state.test.ts src/components/MessageItem.test.ts src/components/VoiceTranscriptModal.test.ts src/components/Composer.test.ts src/features/voice/state/live-voice-reducer.test.ts src/features/voice/state/live-voice-controller.test.ts src/features/voice/live/live-voice-surface.test.ts
```
Expected: FAIL on missing web-search state/rendering.

- [ ] **Step 3: Wire Text Chat SSE, Reducer, `Transcript.tsx`, `MessageItem.tsx`, `VoiceTranscriptModal.tsx`, `group-voice-messages.ts`, and `chat.css`**

1. Update `frontend/src/features/chat/state/chat-types.ts`:

```ts
import type { WebSearchActivity, WebSourceReference } from '../../../api/web-search-protocol.ts';
```

On `ChatState`:
```ts
  webActivitiesByTurn: Record<string, WebSearchActivity[]>;
  webSourcesByTurn: Record<string, WebSourceReference[]>;
  webLastSequenceByTurn: Record<string, number>;
```

On `ChatAction`:
```ts
  | {
      type: 'WEB_ACTIVITY';
      payload: {
        sessionId: string;
        turnId: string;
        attemptId: string;
        sequence: number;
        activity: WebSearchActivity;
      };
    }
  | {
      type: 'WEB_SOURCES';
      payload: {
        sessionId: string;
        turnId: string;
        attemptId: string;
        sequence: number;
        sources: WebSourceReference[];
      };
    }
```
And on the `{ type: 'STREAM_COMPLETED'; payload: ... }` variant of `ChatAction`, add optional properties:
```ts
      webSources?: WebSourceReference[];
      webActivities?: WebSearchActivity[];
```

2. Update `frontend/src/features/chat/state/chat-reducer.ts`:

Add import:
```ts
import { foldWebActivities, foldWebSources } from '../../plugins/web-search/web-search-presentation.ts';
```

In `initialChatState`:
```ts
  webActivitiesByTurn: {},
  webSourcesByTurn: {},
  webLastSequenceByTurn: {},
```

In `case 'NEW_CHAT':` and session-switch actions (`case 'SELECT_SESSION':`, `case 'SELECT_SESSION_SUCCESS':`):
```ts
  webActivitiesByTurn: {},
  webSourcesByTurn: {},
  webLastSequenceByTurn: {},
```

Add helper inside `chat-reducer.ts` (before `chatReducer`):
```ts
function acceptsFencedWebPayload(
  state: ChatState,
  payload: { sessionId: string; turnId: string; attemptId: string; sequence: number },
): boolean {
  if (!state.activeSessionId || payload.sessionId !== state.activeSessionId) return false;
  if (!state.activeTurnId || payload.turnId !== state.activeTurnId) return false;
  if (!state.activeAttemptId || payload.attemptId !== state.activeAttemptId) return false;
  const lastSeq = state.webLastSequenceByTurn[payload.turnId] ?? -1;
  return payload.sequence > lastSeq;
}

function takeTurnWebProvenance(state: ChatState, turnId: string | null) {
  if (!turnId) {
    return {
      webActivities: [],
      webSources: [],
      nextActivitiesByTurn: state.webActivitiesByTurn,
      nextSourcesByTurn: state.webSourcesByTurn,
      nextSeqByTurn: state.webLastSequenceByTurn,
    };
  }
  const webActivities = state.webActivitiesByTurn[turnId] ?? [];
  const webSources = state.webSourcesByTurn[turnId] ?? [];
  const { [turnId]: _a, ...nextActivitiesByTurn } = state.webActivitiesByTurn;
  const { [turnId]: _s, ...nextSourcesByTurn } = state.webSourcesByTurn;
  const { [turnId]: _q, ...nextSeqByTurn } = state.webLastSequenceByTurn;
  return { webActivities, webSources, nextActivitiesByTurn, nextSourcesByTurn, nextSeqByTurn };
}
```

Add `case 'WEB_ACTIVITY':` and `case 'WEB_SOURCES':` to `chatReducer`:
```ts
    case 'WEB_ACTIVITY': {
      if (!acceptsFencedWebPayload(state, action.payload)) return state;
      const { turnId, sequence, activity } = action.payload;
      const existing = state.webActivitiesByTurn[turnId] ?? [];
      return {
        ...state,
        webActivitiesByTurn: {
          ...state.webActivitiesByTurn,
          [turnId]: foldWebActivities(existing, activity),
        },
        webLastSequenceByTurn: { ...state.webLastSequenceByTurn, [turnId]: sequence },
      };
    }

    case 'WEB_SOURCES': {
      if (!acceptsFencedWebPayload(state, action.payload)) return state;
      const { turnId, sequence, sources } = action.payload;
      const existing = state.webSourcesByTurn[turnId] ?? [];
      return {
        ...state,
        webSourcesByTurn: {
          ...state.webSourcesByTurn,
          [turnId]: foldWebSources(existing, sources),
        },
        webLastSequenceByTurn: { ...state.webLastSequenceByTurn, [turnId]: sequence },
      };
    }
```

In `case 'STREAM_COMPLETED':`, `case 'STREAM_ERROR':`, `case 'STREAM_CANCELLED':`, and `case 'STREAM_INTERRUPTED':`:
Call `const web = takeTurnWebProvenance(state, state.activeTurnId);`, clear `webActivitiesByTurn: web.nextActivitiesByTurn`, `webSourcesByTurn: web.nextSourcesByTurn`, `webLastSequenceByTurn: web.nextSeqByTurn`, and when building the finalized assistant `VisibleMessage`:
- On `STREAM_COMPLETED`: resolve `const finalActivities = action.payload.webActivities !== undefined ? action.payload.webActivities.reduce(foldWebActivities, []) : web.webActivities;` and `const finalSources = action.payload.webSources !== undefined ? foldWebSources([], action.payload.webSources) : web.webSources;`. Attach `...(finalActivities.length > 0 ? { webActivities: finalActivities } : {}), ...(finalSources.length > 0 ? { webSources: finalSources } : {})` onto the assistant `VisibleMessage`.
- On `STREAM_ERROR`, `STREAM_CANCELLED`, and `STREAM_INTERRUPTED`: attach `...(web.webActivities.length > 0 ? { webActivities: web.webActivities } : {}), ...(web.webSources.length > 0 ? { webSources: web.webSources } : {})` onto the settled partial/error/cancelled assistant `VisibleMessage` (when appended/updated) so failed/cancelled lookup activity remains visible without inventing unverified sources.

3. Update `frontend/src/features/chat/state/use-chat.ts` inside `dispatchStreamEvent`:

```ts
    case 'web-activity':
      dispatch({
        type: 'WEB_ACTIVITY',
        payload: {
          sessionId: frame.sessionId,
          turnId: frame.turnId,
          attemptId: frame.attemptId,
          sequence: frame.sequence,
          activity: event.activity,
        },
      });
      return;

    case 'web-sources':
      dispatch({
        type: 'WEB_SOURCES',
        payload: {
          sessionId: frame.sessionId,
          turnId: frame.turnId,
          attemptId: frame.attemptId,
          sequence: frame.sequence,
          sources: event.sources,
        },
      });
      return;
```
And in `case 'completed':` inside `dispatchStreamEvent`, include optional completion provenance on the `STREAM_COMPLETED` payload:
```ts
        ...(event.webSources ? { webSources: event.webSources } : {}),
        ...(event.webActivities ? { webActivities: event.webActivities } : {}),
```

4. Update `frontend/src/components/Transcript.tsx`:
   - Include `state.webActivitiesByTurn` and `state.webSourcesByTurn` in `scrollDependencies`.
   - On the synthetic streaming assistant `VisibleMessage` built from `state.activeTurnId`, conditionally attach:
     ```ts
     ...(state.activeTurnId && state.webActivitiesByTurn[state.activeTurnId]?.length
       ? { webActivities: state.webActivitiesByTurn[state.activeTurnId] }
       : {}),
     ...(state.activeTurnId && state.webSourcesByTurn[state.activeTurnId]?.length
       ? { webSources: state.webSourcesByTurn[state.activeTurnId] }
       : {}),
     ```

5. Update `frontend/src/components/MessageItem.tsx`:
   Import `WebSearchActivityView` from `'../features/plugins/web-search/index.ts'`.
   Inside the text-chat assistant `.aurvin-message-body` JSX, render `<WebSearchActivityView>` immediately AFTER the generating placeholder / markdown `.aurvin-message-content` (never inside user bubbles and never leaking outside `.aurvin-voice-chat-indicator` on voice messages):
   ```tsx
   {(message.webActivities?.length || message.webSources?.length) ? (
     <WebSearchActivityView
       activities={message.webActivities}
       sources={message.webSources}
       variant="chat"
     />
   ) : null}
   ```

6. Update `frontend/src/components/group-voice-messages.ts` and `frontend/src/components/VoiceTranscriptModal.tsx`:
   - In `collectGroupTranscripts` (`group-voice-messages.ts`), preserve assistant-only provenance matching the existing `calendarView` pattern (so non-web items stay key-identical):
     ```ts
     ...(item.role === 'assistant' && item.webSources?.length ? { webSources: item.webSources } : {}),
     ...(item.role === 'assistant' && item.webActivities?.length ? { webActivities: item.webActivities } : {}),
     ```
   - In `VoiceTranscriptModal.tsx`, import `WebSearchActivityView` from `'../features/plugins/web-search/index.ts'`, and inside the assistant bubble (after markdown/prose, before Canvas cards):
     ```tsx
     {(item.webActivities?.length || item.webSources?.length) ? (
       <WebSearchActivityView
         activities={item.webActivities}
         sources={item.webSources}
         variant="chat"
       />
     ) : null}
     ```

7. Append responsive light/dark styles to `frontend/src/styles/chat.css`:

```css
.aurvin-web-presentation {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.aurvin-web-activity-pill {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  max-width: 100%;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.8125rem;
  line-height: 1.3;
  border: 1px solid var(--border-subtle, #d1d5db);
  background: var(--surface-subtle, rgba(127, 127, 127, 0.08));
}

.aurvin-web-activity-active {
  border-color: var(--accent, #2563eb);
}

.aurvin-web-activity-failed {
  border-color: #b91c1c;
  color: #b91c1c;
}

.aurvin-web-activity-cancelled {
  opacity: 0.85;
}

.aurvin-web-sources {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aurvin-web-sources-heading {
  font-size: 0.75rem;
  font-weight: 600;
  opacity: 0.8;
}

.aurvin-web-sources-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.aurvin-web-source-link {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border-radius: 8px;
  font-size: 0.8125rem;
  border: 1px solid var(--border-subtle, #d1d5db);
  text-decoration: none;
  overflow-wrap: anywhere;
  max-width: 100%;
}

.aurvin-web-source-link:focus-visible {
  outline: 2px solid var(--accent, #2563eb);
  outline-offset: 2px;
}
```

- [ ] **Step 4: Wire Live Voice `web.frame` into `live-voice-reducer.ts`, `live-voice-controller.ts`, `LiveVoicePanel.tsx`, and `live-voice.css`**

1. Update `frontend/src/features/voice/state/live-voice-reducer.ts`:

Add imports:
```ts
import type { WebFramePayload } from '../../../api/voice-protocol.ts';
import type { WebSearchActivity, WebSourceReference } from '../../../api/web-search-protocol.ts';
import { foldWebActivities, foldWebSources } from '../../plugins/web-search/index.ts';
```

Extend `LiveVoiceState`, `initialLiveVoice`, and `LiveVoiceAction`:
```ts
  webActivities: WebSearchActivity[];
  webSources: WebSourceReference[];
```
```ts
  webActivities: [],
  webSources: [],
```
```ts
  | {
      type: 'WEB_FRAME';
      frame: Pick<WebFramePayload, 'turnId' | 'attemptId' | 'responseId' | 'event'>;
    }
```

Handle `WEB_FRAME` and reset/retain in `liveVoiceReducer`:
```ts
    case 'WEB_FRAME':
      if (action.frame.event.type === 'web-activity') {
        return {
          ...state,
          webActivities: foldWebActivities(state.webActivities, action.frame.event.activity),
        };
      }
      return {
        ...state,
        webSources: foldWebSources(state.webSources, action.frame.event.sources),
      };
```
In `case 'START':` set `webActivities: []`, `webSources: []`. In `case 'ENDING':` / `case 'EXIT':` set:
```ts
  webActivities: action.retainArtifacts ? state.webActivities : [],
  webSources: action.retainArtifacts ? state.webSources : [],
```

2. Update `frontend/src/features/voice/state/live-voice-controller.ts`:

Extend `Run` type and `beginRun` initialization:
```ts
  webSequence: number;
  webEpoch: number | undefined;
  webAttempts: Map<string, string>;
```
```ts
  webSequence: -1,
  webEpoch: undefined,
  webAttempts: new Map(),
```

Add `case 'web.frame':` inside the server control event switch (mirroring `calendar.frame` / `canvas.artifact` fencing):
```ts
        case 'web.frame': {
          if (!run.ready || !run.conversationId || event.conversationId !== run.conversationId) {
            break;
          }
          if (run.cancelledResponses.has(event.responseId) || run.retiredResponses.has(event.responseId)) {
            break;
          }
          if (run.webEpoch !== undefined && event.epoch < run.webEpoch) {
            break;
          }
          const sameEpoch = run.webEpoch === undefined || event.epoch === run.webEpoch;
          if (sameEpoch && event.sequence <= run.webSequence) {
            break;
          }
          const attemptKey = `${event.turnId}\u0000${event.responseId}`;
          const incomingAttempt = event.attemptId ?? '';
          const boundAttempt = run.webAttempts.get(attemptKey);
          if (boundAttempt !== undefined && boundAttempt !== incomingAttempt) {
            break;
          }
          if (boundAttempt === undefined) {
            if (run.webAttempts.size >= 4096) break;
            run.webAttempts.set(attemptKey, incomingAttempt);
          }
          run.webEpoch = event.epoch;
          run.webSequence = event.sequence;
          try {
            this.dispatch({ type: 'WEB_FRAME', frame: event });
          } catch {}
          break;
        }
```

3. Update `frontend/src/features/voice/live/LiveVoicePanel.tsx` and `frontend/src/features/voice/live/live-voice.css`:

In `LiveVoicePanel.tsx`:
```tsx
import { summarizeWebActivities, WebSearchActivityView } from '../../plugins/web-search/index.ts';
```
When computing the sr-only `.aurvin-live-status` string, compute:
```tsx
  const webSummary = voice.view.webActivities.length > 0
    ? summarizeWebActivities(voice.view.webActivities)
    : null;
  const webAnnouncement = webSummary?.tone === 'active' ? ` ${webSummary.label}` : '';
```
Append `{webAnnouncement}` to the sr-only `.aurvin-live-status` text, and render below `.aurvin-live-notice`:
```tsx
      {(voice.view.webActivities.length > 0 || voice.view.webSources.length > 0) ? (
        <WebSearchActivityView
          activities={voice.view.webActivities}
          sources={voice.view.webSources}
          variant="voice"
        />
      ) : null}
```

In `frontend/src/features/voice/live/live-voice.css`:
```css
.aurvin-web-presentation-voice {
  width: min(560px, 100%);
  color: #f8fafc;
}

.aurvin-web-presentation-voice .aurvin-web-activity-pill,
.aurvin-web-presentation-voice .aurvin-web-source-link {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.22);
  color: #f8fafc;
}

.aurvin-web-presentation-voice .aurvin-web-source-link:focus-visible {
  outline: 2px solid #93c5fd;
  outline-offset: 2px;
}
```

- [ ] **Step 5: Run all Task 8 tests**

```powershell
cd frontend; npm test -- src/features/plugins/web-search/ src/features/chat/state/web-search-chat-state.test.ts src/components/MessageItem.test.ts src/components/VoiceTranscriptModal.test.ts src/components/Composer.test.ts src/components/group-voice-messages.test.ts src/features/voice/state/live-voice-reducer.test.ts src/features/voice/state/live-voice-controller.test.ts src/features/voice/live/live-voice-surface.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- frontend/src/features/plugins/web-search/web-search-presentation.ts frontend/src/features/plugins/web-search/web-search-presentation.test.ts frontend/src/features/plugins/web-search/WebSearchActivityView.tsx frontend/src/features/plugins/web-search/index.ts frontend/src/features/chat/state/web-search-chat-state.test.ts frontend/src/features/chat/state/chat-types.ts frontend/src/features/chat/state/chat-reducer.ts frontend/src/features/chat/state/use-chat.ts frontend/src/components/Transcript.tsx frontend/src/components/MessageItem.tsx frontend/src/components/MessageItem.test.ts frontend/src/components/group-voice-messages.ts frontend/src/components/VoiceTranscriptModal.tsx frontend/src/components/VoiceTranscriptModal.test.ts frontend/src/components/Composer.test.ts frontend/src/styles/chat.css frontend/src/features/voice/state/live-voice-reducer.ts frontend/src/features/voice/state/live-voice-reducer.test.ts frontend/src/features/voice/state/live-voice-controller.ts frontend/src/features/voice/state/live-voice-controller.test.ts frontend/src/features/voice/live/LiveVoicePanel.tsx frontend/src/features/voice/live/live-voice-surface.test.ts frontend/src/features/voice/live/live-voice.css
git commit -m "feat(frontend): present text and live voice web search activity and HTTP(S) sources"
```

---

## Task 9: Final Full P4 Verification Gate & Hygiene Checks

**Files:**
- Verify (no edits expected unless defects surface during checks)

- [ ] **Step 1: Run full frontend build, lint, and test suite**

```powershell
cd frontend; npm run build; npm run lint; npm test
```
Expected:
- `tsc -b && vite build` exits 0 with zero TypeScript errors.
- `oxlint` exits 0 with zero errors.
- Vitest discovers and passes all `src/**/*.test.ts` suites (including Calendar integration/panel/canvas tests unchanged).

- [ ] **Step 2: Run backend contract mirror & P1 web-search contract specs**

```powershell
cd backend; npm test -- src/contracts/admin-config.spec.ts src/contracts/voice.spec.ts src/contracts/web-search-policy.spec.ts src/contracts/web-search-wire.spec.ts src/contracts/stream.spec.ts src/contracts/api.spec.ts
```
Expected: ALL PASS — proving exact backend/frontend parity for `admin-config-protocol.ts` and `voice-protocol.ts` without modifying backend files.

- [ ] **Step 3: Check git hygiene and secret/storage/env constraints**

1. Inspect changed files to confirm `backend/**`, `frontend/src/features/plugins/google-calendar/**`, and `frontend/src/components/Composer.tsx` were not modified.
2. Search `frontend/src/**` to verify no `localStorage`/`sessionStorage`, no non-`VITE_API_BASE` `VITE_*` variables, and no hardcoded provider API keys exist.
3. Document explicitly in verification notes that **live provider tests** (TinyFish/Keenable/Exa/Tavily/Firecrawl API keys and OAuth exchanges) and **live HTTP/SSE/LiveKit integration** against unimplemented **P2** and **P3** backend routes remain unrun/blocked until P2 and P3 land; P4 checks verify deterministic fixtures, mirrors, and React SSR/state transitions only.
