# Goal: TinyFish authentication resolution

## Status

Approved by the user on 15 November 2026: "I want you to implement all of em" — in response to the
three-option proposal (API-key route, OAuth metadata probe, dead OAuth button fix). The user also
explicitly authorized the live metadata probe before this goal was written.

## Problem

TinyFish is Aurvin's priority-1 Web Search provider, but it cannot be connected at all:

1. `backend/src/plugins/web-search/providers.ts:49` sets `apiKeyHeader: null`, so
   `credentialHeaders()` throws `WEB_AUTH_UNSUPPORTED` (HTTP 422) before any request.
2. `backend/src/plugins/web-search/connection.ts:303,312` hardcodes
   `apiKey: provider === 'tinyfish' ? 'unsupported' : 'supported'`, so the panel hides the key field.
3. Browser OAuth is capability-gated, and `WebSearchPanel.tsx:226` renders the connect action only
   when status reports `browserAuthorization === 'supported'`. That flag is set only by
   `installOAuth` (`connection.ts:701`); `markOAuthSupported` (`connection.ts:126`) is defined and
   never called. No user can ever start the flow, so the gate is unreachable rather than evaluated.

## Evidence gathered before planning

- TinyFish's own `docs.tinyfish.ai/mcp-integration` (Command Code tab) documents a manual config that
  authenticates the hosted MCP endpoint with an API key:
  `{"url":"https://agent.tinyfish.ai/mcp","headers":{"Authorization":"Bearer YOUR_API_KEY"}}`,
  key format `sk-tinyfish-...`. The same page states that client connects "by API key only" because it
  has no browser sign-in.
- `docs.tinyfish.ai/authentication` still says MCP uses OAuth 2.1, and assigns `X-API-Key` to REST only.
  The two pages are not contradictory: the MCP endpoint accepts a Bearer API key, and OAuth is the
  browser path.
- Neither page publishes RFC 9728 protected-resource metadata, an RFC 8414 authorization-server
  document, a DCR endpoint, `client_id` values, redirect-URI rules, or refresh policy. Zero hits for
  `well-known`, `register`, `client_id`, `PKCE`, or `refresh`.
- `@modelcontextprotocol/sdk` 1.32.2 `client/auth.js:751-767` falls back to treating the MCP origin as
  the authorization server when protected-resource metadata is absent. Aurvin's `assertMetadata`
  (`oauth.ts:231-264`) rejects that fallback: it requires resource metadata, `issuer` equal to the
  authorization server URL, `token_endpoint_auth_methods_supported` containing `none`, and
  `resource.resource` exactly equal to the MCP endpoint. Clients that work with TinyFish may therefore
  be using a path Aurvin refuses.
- Aurvin's `credentialHeaders` already emits `Authorization: Bearer <key>` for any provider whose
  `apiKeyHeader` is `'Authorization'` (`providers.ts:146-149`). `connect()` (`connection.ts:417`)
  validates any key through `prepare(..., probe: true)` with no provider-specific branch, and TinyFish
  search/fetch are free within the daily allowance, so the connect probe costs nothing.

## Scope

### Deliverable A — TinyFish API-key-over-MCP (primary)

Make the documented Bearer-key path work through Aurvin's existing connect flow. No new transport, no
REST fallback, no query-string credentials.

### Deliverable B — OAuth enablement (approved 15 November 2026, after evidence)

R1/R1b established that TinyFish publishes complete RFC 8414 metadata at `https://clerk.tinyfish.ai`,
and that every static gate condition passes except the per-provider origin pin. The user approved adding
that single vendor-published origin to `tinyfish.oauthOrigins`.

This is a correction of a stale configuration entry, not a weakening of the mechanism: exact-origin
equality, the absence of wildcards, `redirect: 'error'`, issuer equality, S256, `none` token auth, and
the secret-free client-id requirement all remain unchanged. Any further origin, any wildcard, or any
relaxation of `assertMetadata`/`assertOrigins` remains out of scope.

### Deliverable C — Honest OAuth affordance

A provider whose browser authorization is `unverified` must expose a clearly labeled action that runs
the real capability check and surfaces the real error, instead of rendering nothing. It must never
display "supported" or "connected" from a provider link or a local guess. `markOAuthSupported` must be
either wired to a real successful discovery or removed.

## Non-goals

- No REST, keyless, or anonymous fallback for any provider.
- No weakening of `assertMetadata`, `assertOrigins`, or the fixed-origin allowlist beyond the single
  approved `https://clerk.tinyfish.ai` entry for TinyFish.
- No new provider, no reordering of the fixed priority, no UI model picker.
- No paid calls, no account creation, no credential entry, no staging or deployment work.
- No claim of production readiness, live compatibility, or an SLA.

## Acceptance criteria

| ID | Criterion |
| --- | --- |
| AC1 | A TinyFish API key connects through the normal `connect` path and reports `state: 'connected'` with `authMethod: 'api-key'`, proven by deterministic fixture tests. |
| AC2 | TinyFish status reports `authSupport.apiKey: 'supported'`, and the panel renders the masked key field with instructions that match the documented Bearer header. |
| AC3 | A wrong or rejected TinyFish key fails closed with `WEB_INVALID_KEY` or `WEB_AUTH_UNSUPPORTED`; no partial connection, no stored record, no fallback. |
| AC4 | The OAuth probe is executed and recorded with exact URLs, status codes, and either the returned metadata or its absence; the conclusion states whether Aurvin's unchanged gate can pass. |
| AC5 | Browser OAuth is enabled for TinyFish by adding only `https://clerk.tinyfish.ai` to `tinyfish.oauthOrigins`; the full start/complete path is proven with fixtures shaped like the observed Clerk metadata, and the `supported` flag is reached through real discovery, not a constant. |
| AC6 | An `unverified` provider exposes a labeled support-check action that surfaces the real error; no provider is shown as `supported` or `connected` without a successful flow. |
| AC7 | Backend `build`, `lint`, `test` and frontend `build`, `lint`, `test` pass with no new failures; any pre-existing failure is reported as pre-existing with evidence. |
| AC8 | `README.md`, `docs/web-search/verification.md`, `docs/web-search/operations.md`, and `docs/web-search/state.md` reflect the new compatibility status honestly; review remains **skipped**, never passed. |

## Constraints

- Preserve the untracked `backend/test/runtime/web-search-followup-verify.spec.ts`; it is unrelated user work.
- Keep provider integration, persistence, context, transport, and UI responsibilities separate.
- Credentials stay server-side, encrypted, and header-only.
- `--skip review` is the standing user instruction for this repository; do not dispatch a reviewer.
