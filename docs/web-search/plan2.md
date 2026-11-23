# Web Search MCP Providers and Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the five fixed, account-bound MCP adapters, encrypted connection lifecycle, prepared memory authority, bounded browse/fetch port, and plugin HTTP module without changing central application composition or Calendar.

**Architecture:** One WebSearchConnections service owns a bounded per-account memory snapshot and control-plane CAS writes; one WebSearchRuntime executes sequential provider attempts using prepared capabilities and credentials. Use the installed MCP SDK for Streamable HTTP and OAuth primitives, the existing AES-GCM pattern for secrets, and one bounded account aggregate plus single-use OAuth documents in `web_search_connections`. Unsupported authentication, changed capabilities, and unverified remote-fetch safety fail closed.

**Tech Stack:** Node.js 22/24+, TypeScript NodeNext ESM, NestJS 12, Zod 3.25, MongoDB 6 driver/RecordStore, Vitest, installed `@modelcontextprotocol/sdk@1.32.2`, Node `crypto`, `net`, `dns/promises`, `AbortSignal`.

---

## Authority, scope, and current evidence

- Execute only after P1's worker commits recorded in [state.md](state.md) are available and the orchestrator assigns P2 execution. This document is a plan, not an implementation or a provider-compatibility result.
- Read [goal.md](goal.md), [research.md](research.md), [plan1.md](plan1.md), root `AGENTS.md`, and the actual frozen `backend/src/contracts/web-search-{policy,wire,tools}.ts`. Actual P1 exports prevail over research suggestions.
- Use the available `executing-plans` and `test-driven-development` skills. The required header's `superpowers:` names do not authorize inventing skills or delegating this worker's work.
- Keep unified review **skipped**. Planning self-checks, tests, defect correction, and final verification remain required.
- All new code/test files require the repository FILE/LOCATION/PURPOSE/ROLE IN PROJECT/KEY COMPONENTS header. Use local `.js` import specifiers. No new packages or manifest edits.
- Never edit P1 contracts, frontend files, Calendar code/tests, or central application files. Report any necessary contract change to P1 through the orchestrator before implementing it.
- Preserve `.commandcode/`, `.openchamber/`, and intervening user changes. Request serialized commit ownership before staging each implementation commit; stage only that task's explicitly named files.
- **No live MCP calls, OAuth flows, model requests, paid checks, or native database provisioning during implementation verification.** Setup behavior described below is application behavior exercised through fixtures, not authorization to run it against vendors.

### Planning-only documentation reconciliation, 2026-11-14

Primary documentation reads, not provider invocations, resolved two research ambiguities:

1. TinyFish's current [MCP page](https://docs.tinyfish.ai/mcp-integration) names **`search`** and **`fetch_content`**. Do not guess `tiny_search`/`tiny_fetch` aliases.
2. Current [Tavily documentation](https://docs.tavily.com/documentation/mcp) and [official server source](https://github.com/tavily-ai/tavily-mcp/blob/main/src/index.ts) name **`tavily_search`** and **`tavily_extract`**, not the research table's hyphenated spellings. Only these two current exact names are accepted. An actual hosted server exposing only legacy names is unsupported until a separately evidenced mapping change; no fuzzy tool-name selection.
3. [Exa's official fetch implementation](https://github.com/exa-labs/exa-mcp-server/blob/main/src/tools/webFetch.ts) accepts **`urls: string[]`**, with optional `maxCharacters`, not `url`. [Search implementation](https://github.com/exa-labs/exa-mcp-server/blob/main/src/tools/webSearch.ts) accepts `query` and `numResults`; no invented `objective` field.
4. [Keenable's MCP reference](https://docs.keenable.ai/mcp-server) documents JSON output, `disable_cards`, `max_chars`, and the exact two tools below. `https://docs.keenable.ai/mcp` is the **documentation site's MCP**, not the web-search service; never configure it.
5. SDK 1.32.2 documentation was queried through Context7, and installed `client/{auth,streamableHttp}.d.ts` was inspected. `authProvider` can automatically refresh and resend a POST after 401. **Do not attach it to runtime transports.** Use SDK auth helpers explicitly on the control plane.

**Compatibility remains unrun: 0/5 hosted providers tested.** Documentation/source reads and synthetic schemas do not establish hosted behavior, account billing attribution, callback acceptance, or redirect protection.

## File map and ownership

| Action/owner | Exact path | Responsibility |
| --- | --- | --- |
| P2 create | `backend/src/plugins/web-search/types.ts` | Plugin-private storage schemas, ports, options, and prepared authority types; imports P1 public types |
| P2 create | `backend/src/plugins/web-search/errors.ts` | Closed HTTP/tool fault conversion; never raw exception serialization |
| P2 create | `backend/src/plugins/web-search/providers.ts` | Five exact endpoints, headers, tool names, argument mapping, capability selection, OAuth origin policy |
| P2 create | `backend/src/plugins/web-search/url-safety.ts` | Public URL/IP/hostname/DNS checks and remote-fetch safety gate |
| P2 create | `backend/src/plugins/web-search/results.ts` | Provider-specific bounded extraction and normalization into P1 results |
| P2 create | `backend/src/plugins/web-search/mcp-client.ts` | SDK client/session ownership, guarded HTTP, bounded discovery/calls, no automatic replay |
| P2 create | `backend/src/plugins/web-search/connection.ts` | Control-plane mutations, account-global revision, prepared map, lifecycle epochs |
| P2 create | `backend/src/plugins/web-search/oauth.ts` | SDK discovery/DCR/PKCE/code exchange/refresh, one-use state, bounded lifecycle |
| P2 create | `backend/src/plugins/web-search/runtime.ts` | Small browse/fetch port, current-memory permission checks, deterministic fallback |
| P2 create | `backend/src/plugins/web-search/controller.ts` | P1 routes/schemas, request identity, safe responses |
| P2 create | `backend/src/plugins/web-search/module.ts` | Configurable Nest module/options; no application import |
| P2 create | `backend/src/plugins/web-search/oauth-callback-page.ts` | Static CSP-protected callback bridge using fixed provider paths |
| P2 create | `backend/src/platform/crypto/web-search-secret-cipher.ts` | Web-domain AES-GCM/AAD implementation following, not modifying, Calendar's cipher |
| P2 create | `backend/src/persistence/web-search-connections.ts` | Scoped aggregate CAS and OAuth consume; existing RecordStore/ownership/bounds |
| P2 modify narrowly | `backend/src/persistence/indexes.ts` | Add `WEB_SEARCH_INDEXES` and include them in `setupIndexes`; leave `CALENDAR_INDEXES` unchanged |
| P2 create tests | `backend/test/plugins/web-search/fixtures.ts`, `mcp-fixture.ts` | Small deterministic owner/store/clock and actual SDK wire fixtures |
| P2 create tests | `backend/test/plugins/web-search/{providers,url-safety,results,mcp-client,connections,oauth,runtime,http,prepared}.spec.ts` | Named red/green checks in tasks below |
| P2 create tests | `backend/test/persistence/{web-search-connections,web-search-native}.spec.ts` | Fake-store CAS/index checks; separately prerequisite-gated isolated native checks |
| P2 create tests | `backend/src/platform/crypto/web-search-secret-cipher.spec.ts` | AAD/tamper/isolation checks |
| P3 handoff; **not P2 edits** | `backend/src/app.service.ts`, `backend/src/app.module.ts`, `backend/src/http/configure-private-http.ts` | Instantiate once, module registration, identity/callback/body-parser routing, outside-turn preparation, logout/deactivation, drain |
| P3 handoff; **not P2 edits** | `backend/src/persistence/persistence.ts` if bundle export is necessary | Construct P2 repository from the existing guarded store/owner; no second DB/close owner |
| P3 handoff; **not P2 edits** | `backend/src/chat-runtime/**`, `backend/src/model/**`, `backend/src/agent/**`, `backend/src/context/**`, `backend/src/voice/**` | Accepted-turn counters/deadline, schema repair, stable advertisement, coexistence, text/voice/source/archive integration |

No barrel, generic plugin framework, general MCP configuration, new queue/cache service, REST adapter, or provider-picker abstraction.

## Frozen public boundary: do not change P1

Import these exact exports rather than reproducing them:

```ts
import {
  WEB_SEARCH_PROVIDERS, WEB_SEARCH_POLICY,
  type WebSearchMode, type WebSearchProvider,
} from '../../contracts/web-search-policy.js';
import {
  WEB_SEARCH_ROUTES, WEB_SEARCH_HTTP_ERRORS,
  webSearchPublicStatusSchema, webSearchProviderSchema,
  webSearchSettingsRequestSchema, webSearchConnectRequestSchema,
  webSearchDisconnectRequestSchema, webSearchOAuthStartRequestSchema,
  webSearchOAuthStartResponseSchema, webSearchOAuthCompleteRequestSchema,
  webSearchOAuthCompleteResponseSchema, webSearchHttpErrorSchema,
  type WebSearchPublicStatus, type WebSearchPublicProvider,
  type WebSearchActivity, type WebSearchHttpErrorCode,
  type WebToolErrorCode,
} from '../../contracts/web-search-wire.js';
import {
  webToolArgumentsSchema, webToolResultSchema,
  type WebToolArguments, type WebToolResult,
} from '../../contracts/web-search-tools.js';
```

Settings are user-level `enabled`, revision starts at 0, and all five cards always appear in P1 priority order. `effectiveEnabled = enabled && providers.some(p => p.state === 'connected')`. `connected` requires an authenticated setup, timestamp, and at least one verified mode. The administrator's separate 5/5 limits are already in `RuntimeConfigSnapshot.settings.webSearch`; P2 adds no settings engine.

Source/message/SSE/voice shapes already exist in `web-search-wire.ts`, `stream.ts`, `message.ts`, `api.ts`, and `voice-wire.ts`: P2 returns results and optional activity notifications only. P3 owns `web-activity`, `web-sources`, `web.frame`, visible-message association, and consolidated post-response archival. No direct chat/voice event writer or persistence in this plugin's read port.

Exact controller surface (all paths have the existing `/api` prefix):

| Method/P1 route member | Path after `/api` | Exact request | Response |
| --- | --- | --- | --- |
| GET `status` | `/plugins/web-search/status` | No body/query; control-plane `warmOwner` then status | `WebSearchPublicStatus` |
| PATCH `settings` | `/plugins/web-search/settings` | `{ protocolVersion:1, expectedRevision, enabled }` | `WebSearchPublicStatus` |
| POST `connect(provider)` | `/plugins/web-search/providers/:provider/connect` | `{ protocolVersion:1, expectedRevision, candidate }` | `WebSearchPublicStatus`; same route replaces a key |
| POST `disconnect(provider)` | `/plugins/web-search/providers/:provider/disconnect` | `{ protocolVersion:1, expectedRevision, confirm:true }` | `WebSearchPublicStatus` |
| POST `oauthStart(provider)` | `/plugins/web-search/providers/:provider/oauth/start` | `{ protocolVersion:1, expectedRevision }` | `{ protocolVersion:1, authorizationUrl, expiresAt }` plus bound cookie |
| GET `oauthCallback(provider)` | `/plugins/web-search/providers/:provider/oauth/callback` | Static page only; query is request-only | No-store HTML, never success/credential JSON |
| POST `oauthComplete(provider)` | `/plugins/web-search/providers/:provider/oauth/complete` | `{ protocolVersion:1, rawQuery }` plus server session/browser cookie | `{ protocolVersion:1, outcome:'connected'\|'denied'\|'expired'\|'failed' }` |

All POST successes use HTTP200. Empty-query routes reject unknown/duplicate query parameters; callback alone carries the strict OAuth query. Setup mutations can warm on their control path; snapshot/execute never do.

## Exact provider mapping

Use Streamable HTTP only. No stdio processes, SSE-endpoint guessing, endpoint query configuration, or `/mcp-public`. Credential headers are required on **every MCP request**, including initialization, list, GET/SSE, cancellation, and optional session cleanup. OAuth metadata/registration is allowed to be unauthenticated control-plane traffic; unauthenticated **retrieval** never is.

| Priority/provider | API-key MCP endpoint + header | OAuth MCP endpoint | Browse tool and complete arguments | Fetch tool and complete arguments |
| --- | --- | --- | --- | --- |
| 1 `tinyfish` | `https://agent.tinyfish.ai/mcp`; **no usable API-key mapping**; return `WEB_AUTH_UNSUPPORTED` before any request | `https://agent.tinyfish.ai/mcp` | `search` → `{ query }` | `fetch_content` → `{ urls: [url], format: 'markdown', links: false, image_links: false, per_url_timeout_ms: min(10000, remainingMs) }` |
| 2 `keenable` | `https://api.keenable.ai/mcp`; `X-API-Key: candidate` | `https://api.keenable.ai/mcp-oauth` | `search_web_pages` → `{ query, max_results: 5, snippet_max_length: 320, output_format: 'json', disable_cards: true }` | `fetch_page_content` → `{ url, live: true, max_chars: 4000, output_format: 'json' }` |
| 3 `exa` | `https://mcp.exa.ai/mcp`; `x-api-key: candidate` | `https://mcp.exa.ai/mcp/oauth` | `web_search_exa` → `{ query, numResults: 5 }` | `web_fetch_exa` → `{ urls: [url], maxCharacters: 4000 }` |
| 4 `tavily` | `https://mcp.tavily.com/mcp/`; `Authorization: Bearer candidate` | `https://mcp.tavily.com/mcp/` | `tavily_search` → `{ query, search_depth: 'basic', max_results: 5, include_images: false, include_raw_content: false }` | `tavily_extract` → `{ urls: [url], extract_depth: 'basic', format: 'markdown' }` |
| 5 `firecrawl` | `https://mcp.firecrawl.dev/v2/mcp`; `Authorization: Bearer candidate` | `https://mcp.firecrawl.dev/v2/mcp-oauth` | `firecrawl_search` → `{ query, limit: 5 }` | `firecrawl_scrape` → `{ url, formats: ['markdown'], onlyMainContent: true, blockAds: true, storeInCache: false }` |

- OAuth always uses `Authorization: Bearer accessToken`, not the API-key header.
- Do not pass chat history, user identity, Calendar data, prompt instructions, query-purpose synthesis, raw custom headers, or model-controlled provider selection. Do not pass Firecrawl `scrapeOptions`, crawl, map, browser, agent, research, wallet, purchase, or automation options.
- Check these **complete mapped objects** against discovered input schemas during setup. Required unknown properties, unsupported options, duplicate tool names, external `$ref`, an unbounded schema, missing `tools` support, or missing exact names mark that mode unsupported. Never silently drop a security flag to fit a schema.
- Accept partial capability, e.g. browse true/fetch false. Both false fails `WEB_CAPABILITY_UNSUPPORTED`; do not persist candidate credentials. Report gaps, not provider success.
- `tools/list` is setup/background-only, maximum 3 pages, 100 advertised tools total, schema JSON <=16,384 bytes/tool, depth <=12, no remote references. Stop at the first breached bound. Ignore resources/prompts and server `instructions`; do not add them to model context.
- A server may advertise unrelated tools; retain only the exact two static names for that provider. Neither MCP server descriptions nor incoming notifications can expand the allowlist.
- TinyFish API-key support remains unverified; setting a key in a header speculatively, REST fallback, CLI integration, and an unauthenticated trial do not satisfy it.

### OAuth origin and resource policy

These are **exact HTTPS origins**, not wildcard suffix matches. Reject userinfo, nonstandard ports, fragments, secret query parameters, redirects on backend HTTP, and metadata naming any other origin.

| Provider | Allowed metadata/token/registration/authorization origins | Required resource/audience gate |
| --- | --- | --- |
| TinyFish | `https://agent.tinyfish.ai`, `https://accounts.tinyfish.ai` | Protected-resource metadata must identify this provider's fixed MCP resource and allowed issuer; absent/inconsistent metadata is unsupported |
| Keenable | `https://api.keenable.ai`, `https://app.keenable.ai` | Same fixed MCP protected-resource/issuer binding; no device-flow shortcut |
| Exa | `https://mcp.exa.ai`, `https://auth.exa.ai` | Same binding; do not infer REST audience or follow an unlisted Okta origin |
| Tavily | `https://mcp.tavily.com`, `https://app.tavily.com` | Same binding; linked account must not switch automatically |
| Firecrawl | `https://mcp.firecrawl.dev`, `https://www.firecrawl.dev` | Documented `resource = https://api.firecrawl.dev/`; require discovered MCP authorization metadata to agree before exchange |

Firecrawl known documentation: metadata `https://www.firecrawl.dev/.well-known/oauth-authorization-server`; authorize `/api/oauth/authorize`; token `/api/oauth/token`; registration `/api/oauth/register`; revocation `/api/oauth/revoke`; `S256`, public-client `token_endpoint_auth_method: 'none'`, scopes `firecrawl:global offline_access`. Do not contact the resource audience URL as an API.

Other four providers start browser auth support as `unverified`. Even Firecrawl is not locally certified: complete trusted metadata, DCR (or an explicitly supplied, issuer-bound public client registration), exact local callback acceptance, S256, authorization-code/refresh support, and authenticated MCP capabilities are gates. Failed discovery/registration returns `WEB_AUTH_UNSUPPORTED`; never invent endpoints or claim a provider dashboard login is a connection.

Discovery can raise support to `supported` when its gates are established, without claiming a successful account connection. If an issuer is outside this static table, report the compatibility gap; do not broaden it from untrusted metadata. Tokens intended for REST alone are not admitted.

## URL safety and the unresolved redirect boundary

> **Policy update (2026-11-15):** This gate is superseded. All five providers are now admitted as `verified` under Aurvin's client-side URL guard, public-DNS checks, provider-returned URL validation, and the untrusted-evidence prompt guardrail. `verified` does not assert provider-side redirect/private-network enforcement; that boundary remains unverified. The original rationale below is retained as history.

**Hard blocker, not a disclaimer-only exception:** research found no documented guarantee that any hosted provider blocks every redirect/private-network destination. Initial URL validation and final-URL checking cannot prove intermediate-hop safety. Thus all five production `fetchSafety` entries start **`unverified`**, and effective fetch capability is **false**, even when an MCP read tool is advertised.

The implementation supplies/tests both mode mappings, but **must not enable real fetch for a provider** until primary documentation plus a separately authorized, bounded service check establishes provider-side DNS/rebinding/private-range and every-redirect-hop enforcement (or a documented no-redirect mode that the mapped MCP call can enforce). Record provider/version/evidence in the source policy before enabling that entry. This is a safety gate, not permission for P2 to run checks. Goal AC4/AC9 full fetch acceptance remains blocked while this gate is closed; tell the orchestrator/P4/P5.

Do not add local HEAD requests, redirect chasing, a browser, or a local page-fetch fallback to work around this. Fixture-only trusted safety records exercise successful fetches; production constructors do not expose a browser/request field that disables this gate.

Before a fetch logical call can be charged, P3 calls `validateInput`; P2 repeats only the cheap canonical/ticket identity checks at execution. The validator:

1. Parses P1-validated syntax, allows `http:`/`https:` only, no username/password, no secret query keys from P1, and only omitted/default scheme ports (HTTP 80, HTTPS 443).
2. Rejects whitespace/control/backslash ambiguity; single-label names; trailing-dot variants of blocked names; `.localhost`, `.local`, `.internal`, `.home.arpa`, `.lan`, `.test`, `.invalid`, `.example`, `.onion`, and exact `localhost`/`metadata.google.internal`.
3. Uses WHATWG normalization before IP classification (reject numeric/octal/hex loopback variants). Rejects zone identifiers and all IPv4-mapped/transition IPv6 literals. Conservative IPv6 policy permits only global-unicast `2000::/3`, excluding documentation/benchmark/transition/reserved subranges.
4. Denies IPv4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, multicast/reserved `224/3`, and special-use `192.88.99/24`. Keep a table, not a simplistic private-IP regex.
5. Resolves hostnames with injected `lookup(host, { all: true, verbatim: true })` on the **post-model tool path**, capped at 1s within shared deadlines. No results, lookup failure, >16 answers, or **any** denied answer fails closed. DNS is not DB/MCP preparation and never runs before initial model dispatch. Use Node `net.BlockList`, `isIP`, and explicit CIDR tables; no new IP package.
6. Validates provider-returned source/final/redirect-chain URLs with the same policy before publishing content. Unsafe input returns `WEB_URL_UNSAFE` with zero provider attempts/budget charge; unsafe provider output is `WEB_UNUSABLE_RESULT`, permitting bounded fallback. A provider redirect to a private target is rejected, with no private content emitted.

Aurvin's DNS lookup still cannot bind the vendor's resolver. The closed remote-fetch gate is what prevents claiming otherwise. Browse can use syntactically safe public result links, then resolve at most five candidate hosts within the slot budget before publishing; reject private/failed candidates and never follow them locally.

## Plugin-private exact types

Put these types in `types.ts`; implement strict Zod schemas there for every durable record. They do not replace or widen P1 wire types.

```ts
import type { AuthPrincipal } from '../../contracts/auth.js';
import type { WebSearchProvider, WebSearchMode } from '../../contracts/web-search-policy.js';
import type { WebToolArguments, WebToolResult } from '../../contracts/web-search-tools.js';
import type {
  WebSearchActivity, WebSearchPublicStatus, WebSearchPublicProvider,
  WebSearchHttpErrorCode, WebToolErrorCode,
} from '../../contracts/web-search-wire.js';

export type SecretEnvelope = {
  version: 1; iv: string; tag: string; ciphertext: string;
};
export type SecretBinding = {
  userId: string; provider: WebSearchProvider; connectionId: string;
  credentialVersion: number; tokenKind: 'credential-bundle' | 'pkce';
};
export type OAuthBinding = {
  issuer: string; resource: string; redirectUri: string; clientId: string;
  authorizationEndpoint: string; tokenEndpoint: string;
  registrationEndpoint: string | null; scope: string;
};
export type CredentialBundle =
  | { method: 'api-key'; apiKey: string }
  | { method: 'oauth'; accessToken: string; refreshToken: string | null;
      expiresAt: string; binding: OAuthBinding };
export type ModeCapabilities = Readonly<{ browse: boolean; fetch: boolean }>;
export type StoredWebConnection = {
  connectionId: string; credentialVersion: number;
  authMethod: 'api-key' | 'oauth'; secret: SecretEnvelope;
  capabilities: ModeCapabilities; schemaDigest: string;
  lastValidatedAt: string; capabilitiesExpireAt: string;
  state: 'connected' | 'reconnect-required';
  oauthRefresh: 'idle' | 'dispatching' | 'reconnect-required';
};
export type StoredWebAccount = {
  kind: 'account'; schemaVersion: 1; userId: string; revision: number;
  enabled: boolean; updatedAt: string;
  connections: Partial<Record<WebSearchProvider, StoredWebConnection>>;
};
export type StoredWebOAuthState = {
  kind: 'oauth-state'; schemaVersion: 1; userId: string;
  provider: WebSearchProvider; expectedRevision: number;
  connectionId: string; credentialVersion: number;
  stateHash: string; browserHash: string; sessionHash: string;
  encryptedVerifier: SecretEnvelope; binding: OAuthBinding;
  createdAt: string; expiresAt: Date; consumedAt: string | null;
};
export type WebAccountCas =
  | { outcome: 'confirmed'; record: StoredWebAccount }
  | { outcome: 'conflict'; currentRevision: number }
  | { outcome: 'uncertain' };
export interface WebSearchStore {
  readAccount(userId: string): Promise<StoredWebAccount | null>;
  saveAccount(expectedRevision: number, next: StoredWebAccount): Promise<WebAccountCas>;
  putOAuthState(record: StoredWebOAuthState): Promise<'confirmed' | 'uncertain'>;
  readOAuthState(userId: string, provider: WebSearchProvider,
    stateHash: string): Promise<StoredWebOAuthState | null>;
  consumeOAuthState(input: {
    userId: string; provider: WebSearchProvider; stateHash: string;
    browserHash: string; sessionHash: string; now: string;
  }): Promise<'consumed' | 'not-found' | 'uncertain'>;
}
export type PreparedProvider = Readonly<{
  provider: WebSearchProvider; connectionId: string; credentialVersion: number;
  generation: number; capabilities: ModeCapabilities; credentials: CredentialBundle;
  capabilitiesExpireAt: number; lastValidatedAt: string;
}>;
export type PreparedWebAccount = Readonly<{
  userId: string; revision: number; generation: number; enabled: boolean;
  prepared: boolean;
  providers: readonly Readonly<{ provider: WebSearchProvider; capabilities: ModeCapabilities }>[];
}>;
export type WebCallContext = Readonly<{
  userId: string; turnId: string; toolCallId: string;
  /** min(existing run deadline, accepted-turn monotonic start + 45_000). */
  webDeadlineAt: number; signal: AbortSignal;
  activity?: (activity: WebSearchActivity) => void;
}>;
export type ValidatedWebInput = Readonly<{
  args: WebToolArguments; userId: string; turnId: string; toolCallId: string;
}>;
export interface WebSearchPort {
  snapshot(userId: string): PreparedWebAccount;
  validateInput(args: WebToolArguments, context: WebCallContext):
    Promise<ValidatedWebInput | Extract<WebToolResult, { ok: false }>>;
  execute(input: ValidatedWebInput, context: WebCallContext): Promise<WebToolResult>;
}
export type WebSearchModuleOptions = {
  connections: () => WebSearchConnectionsApi;
  oauth: () => WebSearchOAuthApi;
  principal: () => AuthPrincipal;
  assertNoClientOverrides: (body: unknown) => void;
  frontendOrigin: string; secureCookie: boolean;
};
export interface WebSearchConnectionsApi {
  status(userId: string): WebSearchPublicStatus;
  warmOwner(userId: string): Promise<void>;
  isPrepared(userId: string): boolean;
  settings(userId: string, body: unknown, signal: AbortSignal): Promise<WebSearchPublicStatus>;
  connect(userId: string, provider: WebSearchProvider, body: unknown,
    signal: AbortSignal): Promise<WebSearchPublicStatus>;
  disconnect(userId: string, provider: WebSearchProvider, body: unknown,
    signal: AbortSignal): Promise<WebSearchPublicStatus>;
  evict(userId: string): void;
  close(): Promise<void>;
}
export interface WebSearchOAuthApi {
  start(principal: AuthPrincipal, provider: WebSearchProvider, body: unknown,
    signal: AbortSignal): Promise<{ authorizationUrl: string; expiresAt: string; browserCookie: string }>;
  complete(principal: AuthPrincipal, provider: WebSearchProvider,
    input: { rawQuery: string; cookieHeader: string | undefined },
    signal: AbortSignal): Promise<'connected' | 'denied' | 'expired' | 'failed'>;
  maintainOwner(userId: string, signal: AbortSignal): Promise<void>;
  invalidate(userId: string, provider?: WebSearchProvider): void;
  close(): Promise<void>;
}
export type WebSearchFaultData = {
  code: WebSearchHttpErrorCode; currentRevision: number | null;
};
```

`PreparedProvider` is **P2-private and contains secrets**; never serialize it, attach it to runtime config/prompts, or pass it to HTTP/P3. `PreparedWebAccount` is the deliberately secret-free backend advertisement projection; its providers contain only currently executable, prepared providers. A hydrated connection with no live prepared session is not in this list. `status()` constructs a separate P1 projection; missing sessions project unavailable, preserving saved enabled preference. Use readonly projections; no deep-copying credentials in token callbacks.

Additional adapter interfaces belong to their focused files:

```ts
// providers.ts
export type ProviderDefinition = Readonly<{
  provider: WebSearchProvider; apiKeyEndpoint: string; oauthEndpoint: string;
  apiKeyHeader: 'X-API-Key' | 'x-api-key' | 'Authorization' | null;
  browseTool: string; fetchTool: string;
  oauthOrigins: readonly string[]; fetchSafety: 'unverified' | 'verified';
}>;
export type MappedCall = { name: string; arguments: Record<string, unknown> };

// mcp-client.ts; not a model-facing or user-configurable MCP framework
export interface PreparedMcpSession {
  call(call: MappedCall, signal: AbortSignal, deadlineAt: number): Promise<unknown>;
  close(): Promise<void>;
}
export interface WebMcpClient {
  prepare(input: { userId: string; provider: WebSearchProvider;
    connectionId: string; credentialVersion: number; credentials: CredentialBundle;
    signal: AbortSignal; deadlineAt: number }): Promise<{
      session: PreparedMcpSession; capabilities: ModeCapabilities; schemaDigest: string;
    }>;
  publish(userId: string, provider: PreparedProvider, session: PreparedMcpSession): void;
  session(provider: PreparedProvider, userId: string): PreparedMcpSession | null;
  invalidate(userId: string, provider?: WebSearchProvider): void;
  close(): Promise<void>;
}
```

Define the two fault classes in `errors.ts` explicitly so URL/provider faults cannot be confused with HTTP setup faults:

```ts
export class WebSearchFault extends Error {
  constructor(readonly code: WebSearchHttpErrorCode, readonly currentRevision: number | null = null) {
    super(code);
  }
}
export class WebToolFault extends Error {
  constructor(readonly toolCode: WebToolErrorCode) { super(toolCode); }
}
```

`mapCall` is pure; the URL guard uses `WebToolFault('WEB_URL_UNSAFE')`; HTTP setup catches/converts only the closed error codes. Do not attach raw causes or provider values to either class.

Exact construction options, defined beside each implementation rather than in public contracts:

```ts
// connection.ts
export type WebSearchConnectionsOptions = {
  store: () => WebSearchStore | null; cipher: WebSearchSecretCipher; mcp: WebMcpClient;
  now?: () => Date; nowMs?: () => number;
};
// mcp-client.ts
export type McpWebClientOptions = { fetch?: typeof globalThis.fetch;
  nowMs?: () => number; now?: () => Date };
// oauth.ts
export type WebSearchOAuthOptions = {
  connections: WebSearchConnections; store: () => WebSearchStore | null;
  cipher: WebSearchSecretCipher; mcp: WebMcpClient; frontendOrigin: string;
  secureCookie: boolean; fetch?: typeof globalThis.fetch; now?: () => Date; nowMs?: () => number;
};
// runtime.ts
export type WebSearchRuntimeOptions = {
  connections: WebSearchConnections; mcp: WebMcpClient;
  lookup?: typeof import('node:dns/promises').lookup;
  nowMs?: () => number; now?: () => Date;
};
```

Import these referenced classes/interfaces with `import type` from the exact focused paths in the file map. `WebSearchConnections` adds these P2-internal methods used by runtime/OAuth:

```ts
snapshot(userId: string): PreparedWebAccount;
currentEligibleProvider(userId: string, provider: WebSearchProvider, mode: WebSearchMode): PreparedProvider | null;
isCurrent(userId: string, provider: PreparedProvider): boolean;
callSignal(userId: string, provider: PreparedProvider): AbortSignal;
requestMaintenance(userId: string): void;
setMaintenance(run: (userId: string, signal: AbortSignal) => Promise<void>): void;
```

`isCurrent` compares captured provider identity/version/generation to the current owner map, not merely provider name. No P3 use of these secret-bearing helpers. `mcp.prepare` creates an isolated candidate session; only `mcp.publish` adopts it into the executable pool **after confirmed account CAS and a generation check**, atomically replacing/closing older sessions. Failed candidates close only themselves, never the previous confirmed session. Key active sessions by `(userId, provider, connectionId, credentialVersion)`; track candidate sessions for cleanup too.

`prepare` owns authenticated initialization/discovery and no retrieval on ordinary warm. A user-requested connect may perform at most **one** bounded allowlisted browse validation probe (`query: 'example.com'`, other arguments exactly as mapped) if the provider defers credential checking until `tools/call`; its setup disclosure must mention possible credits. Do not accept a key merely because unauthenticated `initialize`/`tools/list` works. Any response explicitly indicating shared/public/keyless mode is rejected. If account-authenticated usage cannot be established by documented protected behavior/setup response, return `WEB_AUTH_UNSUPPORTED`; do not label the key connected on an unprotected catalog response. Fixtures must cover permissive-catalog/invalid-key behavior. This remains a hosted attribution verification limitation, not proof from fixtures.

`ValidatedWebInput` is issued by the runtime into a private `WeakMap<object, { expiresAt:number; used:boolean }>`; `execute` accepts only an issued, unused object matching owner/turn/call/arguments and atomically marks it used before the first await. Deep-freeze its small arguments object too. P3 does not construct its own ticket or mutate it. The ticket avoids repeating DNS before P3 charges a call; it expires after 1s or the shared deadline, whichever is earlier. On expiry return `WEB_URL_UNSAFE` without provider dispatch; a later explicit logical call can validate again. P3 charges immediately after validation; never perform provider setup there. Reusing a consumed/cross-owner ticket returns `WEB_INTERRUPTED`, with no provider request.

## Persistence and encryption

### Bounded aggregate, not cross-document transactions

Use **one account document with at most five fixed provider slots** so account revision, last-provider removal, preference, and credential replacement change atomically. This is the P1-permitted bounded account/connection storage, not an unbounded transcript array. It avoids a settings-plus-five-record transaction protocol. OAuth state is independent and bounded to one pending document per owner/provider.

- Account `_id = key('web-search-account', userId)` using `persistence/records.ts`; `kind: 'account'`; stored public revision starts at 1, absent account projects revision 0.
- State `_id = key('web-search-oauth', userId, provider)`, replacing a previous start for that owner/provider. `stateHash` uniqueness prevents collisions/replay.
- Account schema: exactly five optional literal provider keys, no passthrough/index signature in Zod; <=262,144 BSON bytes **and** existing `budgets.maxDocumentBytes`, whichever is smaller.
- Connection: IDs use `idSchema`, positive safe credential versions, dates use `isoDateSchema`, digest lowercase SHA-256, at least one effective mode. Each secret bundle plaintext <=16,384 UTF-8 bytes; each access/refresh token <=8,192 bytes, API key <=4,096 bytes, public OAuth client ID <=512 characters. State <=32,768 BSON bytes; PKCE plaintext 43..128 URL-safe characters.
- `revision` stays within P1's range. At the maximum, reject mutations with `WEB_SETTINGS_CONFLICT`; never overflow. Background changes also CAS/increment revision.
- Every Mongo query/mutation includes the owner `userId`, exact `_id`, `kind`, and provider where applicable. Use existing guarded `RecordStore`, finite options, ownership `assertExecutor`, `assertBytes`, and acknowledged majority writes. No new connection, executor, or close owner.
- `saveAccount(0, next)` uses `$setOnInsert`; later saves use exact revision `replaceOne`. A lost ACK gets at most **one exact scoped reread** and `isDeepStrictEqual` confirmation. No blind write retry, no cross-collection transaction, no resurrection on conflict.
- `consumeOAuthState` atomically matches state/browser/session hashes, owner/provider, `consumedAt: null`, and `expiresAt > now`. A lost/uncertain consume ACK **must not exchange a code**; fail closed.

Exact indexes added to `indexes.ts`:

```ts
export const WEB_SEARCH_INDEXES: AppIndex[] = [
  {
    collection: 'web_search_connections', keys: { userId: 1, kind: 1 },
    options: { name: 'web_search_account_owner', unique: true,
      partialFilterExpression: { kind: 'account' } },
  },
  {
    collection: 'web_search_connections', keys: { userId: 1, provider: 1, kind: 1 },
    options: { name: 'web_search_oauth_owner_provider', unique: true,
      partialFilterExpression: { kind: 'oauth-state' } },
  },
  {
    collection: 'web_search_connections', keys: { stateHash: 1 },
    options: { name: 'web_search_oauth_hash', unique: true,
      partialFilterExpression: { kind: 'oauth-state' } },
  },
  {
    collection: 'web_search_connections', keys: { expiresAt: 1 },
    options: { name: 'web_search_oauth_expiry', expireAfterSeconds: 0,
      partialFilterExpression: { kind: 'oauth-state' } },
  },
];
```

Include `...WEB_SEARCH_INDEXES` in `setupIndexes`' existing loop. Account records have **no `expiresAt` field**. TTL is cleanup only: application expiry and consume checks are authoritative; delayed TTL never permits exchange. No changes to Calendar indexes or `integration_connections`.

### Cipher

Use `EncryptionBootstrap`/`AURVIN_CONFIG_ENCRYPTION_KEY` and Node `crypto`, following `calendar-secret-cipher.ts`. Do not reuse its Calendar-specific AAD/subject requirement or refactor it.

```ts
const aad = (b: SecretBinding) => Buffer.from(JSON.stringify([
  'aurvin', 'web-search', 1, b.userId, b.provider, b.connectionId,
  b.credentialVersion, b.tokenKind,
]), 'utf8');
```

AES-256-GCM; fresh 12-byte IV, 16-byte tag, canonical base64, strict envelope version 1. Encrypt the complete credential JSON bundle. For PKCE, additionally include stateHash/browserHash/sessionHash/redirectUri in authenticated plaintext/binding validation before opening; no raw verifier/state/cookie/code persisted. If the key is missing, tampered, swapped across owner/provider/version/kind, or envelope invalid, return only `WEB_ENCRYPTION_UNAVAILABLE`. Status may show reconnect-required without throwing chat readiness down. Never persist plaintext tokens, candidate fingerprints/suffixes, session cookies, authorization codes, or provider response dumps.

## Connection state machine and revision semantics

Keep stored confirmed authority separate from transient setup views. Use at most one active control-plane mutation per owner and two setup network jobs process-wide; excess requests fail fast with `WEB_RATE_LIMITED` (no unbounded waiter queue). A current permission check/read never waits for that slot. Abort/disable/disconnect installs a memory fence **synchronously before the first await**, even if its save cannot acquire a busy slot; return a failure rather than claim durable revocation in that case. No global tool lock or waiting for turn archival. The separate maintenance cap is two jobs, giving a hard maximum four control-plane network jobs.

| Event | Memory/public transition | Durable action and effect |
| --- | --- | --- |
| No saved account | default off, not-connected, revision 0 | None until setup saves |
| API-key/OAuth setup starts | target connecting if no old connection; old confirmed connection stays usable for replacement | Validate exact tools/auth off-turn; candidate is isolated |
| Unsupported auth/capability | target unsupported for first setup; old replacement authority unchanged | No candidate save; 422 |
| Invalid key | invalid-key for first setup | No candidate save; `WEB_INVALID_KEY` |
| Setup transient/timeout | unavailable for first setup; old replacement authority unchanged | No candidate save; 502/504; preference unchanged |
| Successful connection/replacement | publish confirmed new version, close old session, invalidate old generation/results | Single account CAS, revision +1; enabled unchanged |
| Replacement conflict/failure | old connection preserved unless write is uncertain | 409/503, close candidate; no auto-enable |
| Explicit enable | permitted only with >=1 currently connected effective mode | CAS revision +1; publish only after confirmed save |
| Explicit disable | enabled false immediately, epoch++, abort in-flight reads, discard late results | CAS revision +1; on failure **stay off** in memory; do not restore stale permission |
| Disconnect | fence provider immediately, epoch++, abort/close that provider | CAS removes slot; if last saved connection, enabled false; revision +1 |
| Disconnect/disable uncertain write | keep memory deny fence, report 503 nonretryable uncertain | Control-plane reconciliation only; never a turn-triggered reread or automatic re-enable |
| Token expiry/revocation | reconnect-required/ineffective until bounded lifecycle repair succeeds | Preserve saved enabled preference and slot; do not silently delete |
| Transient network outage | unavailable with bounded cooldown, retain saved preference | No turn-path save; maintenance/setup may restore current generation |
| Capabilities expire/change | unavailable/unsupported for affected mode | Background revalidation; no chat discovery |
| Last-provider reconnect | connected but enabled remains false after explicit last removal | New explicit enable required |
| Evict/logout/deactivate/close | account-generation tombstone, abort calls/setup/renewals, drop secrets/session | In-flight warm/complete/refresh cannot publish after tombstone |

Account generation changes on global disable/evict; provider generation changes on disconnect/replacement. Removing provider A aborts A and permits an existing call to fall back to still-authorized B; unrelated removal must not poison B. If no providers remain, return `WEB_CONNECTION_REQUIRED`. A global disable returns `WEB_DISABLED`; caller cancellation returns `WEB_CANCELLED`. Never publish A's late result or resurrect A via an older warm/OAuth/refresh callback.

Failed permission-reducing writes cannot be reported as saved. While fail-closed memory fencing is active, show `enabled: false` for global denial and preserve confirmed revision; every new mutating setup must reconcile control-plane state first. Process restart after an **unconfirmed** disconnect can restore a previously saved connection; explicitly report this operational limitation with `WEB_WRITE_UNCERTAIN`, not a successful durable revocation.

### Prepared lifecycle and finite bounds

- `warmOwner(userId)` does bounded account loading/decryption only, once and deduplicated. Capture account generation before awaiting; discard load if mutation/eviction advanced it. No MCP connect/list, OAuth discovery/refresh, or DNS. A warm hit does **zero storage operations**.
- Cold admitted turns receive a closed, unprepared snapshot and proceed as ordinary chat without web; do not await `warmOwner` from submit/voice admission. P3 arranges warm on login, Plugins status/setup, or tracked background startup work **outside admitted turns**. Research's suggestion to await a cold warm on `/turns` is not compatible with the stricter goal.
- Setup builds/retains sessions in memory. Restart can hydrate validated capabilities/credentials without a session; `execute` skips a missing session and requests bounded maintenance, never lists/connects before model dispatch. The background lifecycle reopens sessions independently; no retrieval probes without an explicit Connect action.
- `capabilitiesExpireAt = lastValidatedAt + 24h`. At exact expiry the provider is ineligible until background setup revalidates. Trust neither stale schema nor provider notifications.
- Maintain one service-owned, tracked/unref'ed timer over already-prepared owners. At most 2 maintenance network jobs process-wide, 1 per `(owner, provider)`, 5 provider slots per owner, each <=12s; no unbounded pending queue. Coalesce work in the existing maps; if slots are busy, skip and reschedule. A 60s sweep and 30s transient cooldown are fixed internal values, not new Config fields.
- OAuth renewal becomes due at access expiry minus 60s; attempt once per due generation, <=4s. Non-expiring/unknown-expiry tokens are not assumed perpetual; require finite positive `expires_in <=86400` at exchange. Expired access with no successful renewal is ineligible.
- **No runtime token refresh.** P1's “at most one” allows zero. Skip stale tokens and fall back; setup/background performs renewal. This is smaller and avoids SDK resend/persistence coupling in the tool path.
- Before a rotating refresh is sent, durably CAS `oauthRefresh: 'dispatching'` on the control plane. After success, encrypt/save returned tokens under credentialVersion +1 before publishing/closing stale session. Lost response, write uncertainty, or restart with dispatching flag becomes reconnect-required; never replay a possibly consumed single-use refresh token. A definitive `invalid_grant` requires reconnect. Finite transient backoff may retry later **only** when no refresh POST was sent; no retry after ambiguous send.
- Post-refresh and capability saves can be slow/blocked without blocking initial model, tool-loop continuation, or immediate follow-ups. Expired provider is simply unavailable; ordinary chat stays up.
- `close()` aborts timers/jobs/sessions and waits at most 5s for tracked work; service owns no database close and no network readiness probe. No provider calls when plugin disabled except explicit setup/maintenance necessary for an existing authorized connection, and no search/fetch from maintenance.

## Deadlines, normalization, and errors

### Nested numeric bounds

Consume P1 constants, do not duplicate configurable values:

| Bound | Value/behavior |
| --- | --- |
| MCP preparation connect | 4,000ms within 12,000ms preparation slot |
| Provider slot | 12,000ms, includes mapping/call/DNS/result normalization |
| Logical call | 25,000ms across all five sequential slots |
| Turn web deadline | accepted-turn monotonic start +45,000ms, min existing run deadline; supplied by P3 |
| Runtime attempts | one `tools/call` per provider per logical call, <=5 total; no fan-out or auth resend |
| Wire bytes | <=524,288 cumulative decompressed UTF-8 bytes per HTTP body, including SSE; abort reader on excess |
| Setup discovery | 3 pages /100 tools /16KiB schema /12 depth; total setup <=12s |
| DNS | <=1,000ms, <=16 answers/host within the existing slot |
| Browse | <=5 results; titles160, URLs1024, snippets320 characters; **whole P1 JSON <=2400 bytes** |
| Fetch | input URL2048; source URL1024; title160; content4000 chars; **whole JSON <=4600 bytes** |
| OAuth state/body | state600,000ms; P1 HTTP body16,384 bytes; callback rawQuery8192 characters **and <=8192 UTF-8 bytes** |

Use `performance.now()` as default monotonic clock and injected `nowMs()` in fixtures; Date only for durable expiry/source timestamps. `slotDeadline = min(callStart+25000, context.webDeadlineAt, slotStart+12000)`; connect uses min(slotDeadline, start+4000), never additive. Stop before constructing/sending another request when remaining <=0. SDK progress notifications do not extend timeouts. P3 owns accepted-turn logical 5/5 counters, evidence 24,000-byte ceiling, 1,024-token synthesis headroom, and repair/model limits.

### Result extraction

`structuredContent` object wins; otherwise parse a bounded JSON text block with `JSON.parse`; otherwise use the provider's exact text grammar below. No generic link-scraping from arbitrary Markdown and no execution of embedded instructions.

| Provider | Browse extraction | Fetch extraction (only with verified safety gate) |
| --- | --- | --- |
| TinyFish | `results[]`: `title`, `url`, `snippet`, optional `site_name`/publication time; provider ranking order, ignore `position` for identity | `results[]` matching requested URL: `content` or `markdown`, `page_metadata.title`; require one matching page |
| Keenable | JSON `results[]`: `title`, `url`, `snippet`; optional `published_at`/`acquired_at` (only published time becomes publishedAt) | JSON `title`, `url`, `content`; accept documented wrapper `data` only when fixture explicitly covers it |
| Exa | Structured `results[]` with `highlights[]`/`text`; text blocks `Title: ...`, `URL: ...`, `Published: ...`, `Author: ...`, then `Highlights:`/`Text:`, delimited by `\n\n---\n\n` | Text `# title\nURL: absolute-url\n[Published: ...]\n[Author: ...]\n\nbody`, or structured `results[]` `url/title/text`; require one page |
| Tavily | JSON `results[]`: `title`, `url`, `content`; ignore synthesized `answer`/images | JSON `results[]`: `url`, `raw_content`; any `failed_results` for target without usable body makes it unusable |
| Firecrawl | JSON `data` array or `data.web[]`/`web[]`: `title`, `url`, `description`; no inline scraped page required | JSON `data.markdown`/`markdown`, `metadata.title`, `metadata.sourceURL`/`metadata.url`; validate every reported destination |

Unknown shape, mismatched URL, `isError`, empty body/snippet, known “no results” or blocked/login/error envelope, invalid UTF-8/oversize wire, and no usable public source count as unusable, not grounded success. Pure plain prose without a trustworthy source is never given an invented citation. A public URL may be the title when no provider title exists; do not invent metadata.

Build sources with server `retrievedAt`, stable `sourceId = 'ws_' + sha256(JSON.stringify([turnId, toolCallId, provider, canonicalURL])).slice(0,40)`, original `toolCallId`, and successful provider/mode. Deduplicate canonical source URLs preserving rank. Never truncate IDs/URLs or publication timestamps; drop an oversized/unsafe source.

Trim text once with code-point-safe slicing. Fit serialized P1 JSON bytes after metadata: deterministically remove lowest-ranked browse entries, then shorten retained snippets (never below one useful code point); for fetch, shorten content to fit. Binary-search the longest fitting code-point prefix rather than repeatedly slicing one character. Mark `truncated` for omitted entries, clipped fields, or documented upstream truncation. If no useful evidence fits, return unusable. Validate the final object with `webToolResultSchema` **once** before returning; do not repeatedly schema-validate during streaming.

### Closed error mapping

Implement the two declared fault classes with fixed code/currentRevision only; `message` is the safe code, no `cause`/raw payload attached. HTTP uses P1 `WEB_SEARCH_HTTP_ERRORS` directly and `webSearchHttpErrorSchema`; existing authentication faults remain their normal auth-protocol bodies.

| Condition | Setup HTTP code | Runtime result/activity code | Fallback? |
| --- | --- | --- | --- |
| Request/schema/body bound | `WEB_INVALID_REQUEST`/`WEB_INPUT_TOO_LARGE` | P3 schema handling; not provider execution | No |
| TinyFish key / OAuth metadata-registration gap | `WEB_AUTH_UNSUPPORTED` | provider not eligible | Skip |
| Missing exact tools/input support/unsafe fetch | `WEB_CAPABILITY_UNSUPPORTED` | no eligible mode → `WEB_CONNECTION_REQUIRED` | Skip |
| Explicit key 401/invalid credential | `WEB_INVALID_KEY` | `WEB_PROVIDER_AUTH` | Yes, next connected provider |
| 403 explicit insufficient-credit code /402 | `WEB_PROVIDER_UNAVAILABLE` | `WEB_PROVIDER_CREDITS` | Yes |
| Other 403/expired/revoked auth | `WEB_INVALID_KEY` | `WEB_PROVIDER_AUTH` | Yes |
| 429 | `WEB_RATE_LIMITED` | `WEB_PROVIDER_RATE_LIMITED` | Yes, no wait/retry |
| Slot timeout | `WEB_SETUP_TIMEOUT` | `WEB_PROVIDER_TIMEOUT` | Yes if shared deadline remains |
| Network, 5xx, MCP protocol/session error | `WEB_PROVIDER_UNAVAILABLE` | `WEB_PROVIDER_UNAVAILABLE` | Yes |
| Unsafe/empty/malformed provider evidence | `WEB_CAPABILITY_UNSUPPORTED` during validation | `WEB_UNUSABLE_RESULT` | Yes |
| Unsafe input | not setup | `WEB_URL_UNSAFE` | No |
| Off / no connections | `WEB_CONNECTION_REQUIRED` on enable | `WEB_DISABLED` /`WEB_CONNECTION_REQUIRED` | No |
| Caller aborted /deadline | setup maps closed unavailable/timeout; no new error enum | `WEB_CANCELLED` /`WEB_DEADLINE_EXCEEDED` | No |
| Settings CAS mismatch | `WEB_SETTINGS_CONFLICT` | no turn storage | No |
| Definitive storage failure /ambiguous ACK | `WEB_STORAGE_UNAVAILABLE` /`WEB_WRITE_UNCERTAIN` | no turn storage | No |
| Cipher unavailable/tampered | `WEB_ENCRYPTION_UNAVAILABLE` | provider unavailable, never cleartext fallback | Skip |
| OAuth binding/state/expiry | `WEB_OAUTH_BINDING_MISMATCH` /`WEB_OAUTH_STATE_INVALID` /`WEB_OAUTH_EXPIRED` | not runtime work | No |
| All attempted providers fail | not setup | `WEB_PROVIDERS_EXHAUSTED` | Terminal |

Only parse explicit allowlisted structured provider error codes/statuses; never regex arbitrary provider prose into authority. `retryable` on a failure is advice for explicit user retry, not permission for an internal second provider attempt. Activities contain P1 fields only. Logs accept only `{ component:'web-search', provider, code, elapsedMs }` and server correlation IDs; never pass Error objects, query, URL, tokens, MCP session IDs, callback query, or response bodies.

## TDD execution sequence

Each checkbox is one small action. Split a larger implementation checkbox by the listed function if it cannot fit a short red/green cycle; keep the same ownership and assertions. Code blocks are the authoritative kernels/signatures; the preceding exact tables define the remaining branches, limits, and schemas. Do not make an empty mock stand in for SDK, database, HTTP, or runtime proof.

### Task 1: Provider definitions and closed plugin types

**Files:** create `backend/src/plugins/web-search/{types,errors,providers}.ts`; test `backend/test/plugins/web-search/providers.spec.ts`.

- [ ] Write the first failing mapping tests (required file header first):

```ts
import { expect, it } from 'vitest';
import { WEB_SEARCH_PROVIDERS } from '../../../src/contracts/web-search-policy.js';
import { providerDefinition, mapCall, credentialHeaders } from '../../../src/plugins/web-search/providers.js';

it('maps only the exact five search/read tools and header credentials', () => {
  const expected = [
    ['tinyfish', 'search', 'fetch_content'],
    ['keenable', 'search_web_pages', 'fetch_page_content'],
    ['exa', 'web_search_exa', 'web_fetch_exa'],
    ['tavily', 'tavily_search', 'tavily_extract'],
    ['firecrawl', 'firecrawl_search', 'firecrawl_scrape'],
  ];
  expect(WEB_SEARCH_PROVIDERS.map(p => {
    const d = providerDefinition(p); return [p, d.browseTool, d.fetchTool];
  })).toEqual(expected);
  expect(mapCall('exa', { mode: 'fetch', url: 'https://example.com/' }, 12000))
    .toEqual({ name: 'web_fetch_exa', arguments: { urls: ['https://example.com/'], maxCharacters: 4000 } });
  expect(mapCall('firecrawl', { mode: 'browse', query: 'example' }, 12000))
    .toEqual({ name: 'firecrawl_search', arguments: { query: 'example', limit: 5 } });
  expect(credentialHeaders('keenable', { method: 'api-key', apiKey: 'fixture-secret' }))
    .toEqual({ 'X-API-Key': 'fixture-secret' });
  expect(() => credentialHeaders('tinyfish', { method: 'api-key', apiKey: 'fixture-secret' }))
    .toThrow('WEB_AUTH_UNSUPPORTED');
  expect(WEB_SEARCH_PROVIDERS.every(p => new URL(providerDefinition(p).apiKeyEndpoint).search === ''))
    .toBe(true);
});
```

- [ ] Run RED from `backend`: `npm test -- test/plugins/web-search/providers.spec.ts`; expect missing module/exports, not no-test success.
- [ ] Add `types.ts` exactly as defined above, strict durable schemas, `WebSearchFault`, and fixed definition table. Implement the argument branches with an exhaustive switch, not discovered names:

```ts
export function mapCall(provider: WebSearchProvider, args: WebToolArguments, remainingMs: number): MappedCall {
  if (args.mode === 'browse') {
    switch (provider) {
      case 'tinyfish': return { name: 'search', arguments: { query: args.query } };
      case 'keenable': return { name: 'search_web_pages', arguments: {
        query: args.query, max_results: 5, snippet_max_length: 320, output_format: 'json', disable_cards: true } };
      case 'exa': return { name: 'web_search_exa', arguments: { query: args.query, numResults: 5 } };
      case 'tavily': return { name: 'tavily_search', arguments: {
        query: args.query, search_depth: 'basic', max_results: 5, include_images: false, include_raw_content: false } };
      case 'firecrawl': return { name: 'firecrawl_search', arguments: { query: args.query, limit: 5 } };
    }
  }
  switch (provider) {
    case 'tinyfish': return { name: 'fetch_content', arguments: { urls: [args.url], format: 'markdown',
      links: false, image_links: false, per_url_timeout_ms: Math.min(10000, Math.floor(remainingMs)) } };
    case 'keenable': return { name: 'fetch_page_content', arguments: {
      url: args.url, live: true, max_chars: 4000, output_format: 'json' } };
    case 'exa': return { name: 'web_fetch_exa', arguments: { urls: [args.url], maxCharacters: 4000 } };
    case 'tavily': return { name: 'tavily_extract', arguments: {
      urls: [args.url], extract_depth: 'basic', format: 'markdown' } };
    case 'firecrawl': return { name: 'firecrawl_scrape', arguments: { url: args.url, formats: ['markdown'],
      onlyMainContent: true, blockAds: true, storeInCache: false } };
  }
}
```

- [ ] Extend the same test with exact-object assertions for the other eight mode/provider combinations from the table, OAuth Bearer override, unknown-provider schema rejection, zero auth headers for no credential **rejected**, and all five unverified fetch gates. Run GREEN using the same command.
- [ ] Commit after serialized permission: explicitly add the four named files; message `feat(web-search): define fixed MCP mappings and private ports`.

### Task 2: URL safety before any provider request

**Files:** create `backend/src/plugins/web-search/url-safety.ts`; test `backend/test/plugins/web-search/url-safety.spec.ts`.

- [ ] Write failing checks against the exact `assertPublicUrl(raw, { lookup, signal, deadlineAt, nowMs })` API. It returns canonical URL or throws a fault with `.toolCode === 'WEB_URL_UNSAFE'`:

```ts
import { expect, it, vi } from 'vitest';
import { assertPublicUrl } from '../../../src/plugins/web-search/url-safety.js';
const options = () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  signal: new AbortController().signal, deadlineAt: performance.now() + 1000,
  nowMs: () => performance.now(),
});
it.each([
  'file:///etc/passwd', 'https://a:b@example.com/', 'http://localhost/',
  'http://127.1/', 'http://2130706433/', 'http://0x7f000001/',
  'http://10.0.0.1/', 'http://100.64.0.1/', 'http://169.254.169.254/',
  'http://192.168.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
  'http://[fe80::1]/', 'http://[fc00::1]/', 'http://intranet/',
  'https://host.internal./', 'https://example.com:3000/', 'https://example.com/?apiKey=secret',
])('rejects unsafe target %s before dispatch', async raw => {
  await expect(assertPublicUrl(raw, options())).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
});
it('rejects mixed public/private DNS answers and permits no local page fetch', async () => {
  const o = options();
  o.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  await expect(assertPublicUrl('https://example.com/', o)).rejects.toMatchObject({ toolCode: 'WEB_URL_UNSAFE' });
  const good = options();
  expect(await assertPublicUrl('https://example.com/', good)).toBe('https://example.com/');
  expect(good.lookup).toHaveBeenCalledTimes(1);
});
```

- [ ] Run RED: `npm test -- test/plugins/web-search/url-safety.spec.ts`.
- [ ] Implement the hostname checks and explicit CIDR classification using stdlib; the core classification is:

```ts
import { BlockList, isIP } from 'node:net';
const denied4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) denied4.addSubnet(network, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const denied6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) denied6.addSubnet(network, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied4.check(address, 'ipv4') :
    family === 6 && global6.check(address, 'ipv6') && !denied6.check(address, 'ipv6');
}
```

Add syntax/port/secret checks before DNS, bounded abortable lookup after syntax, and return canonical complete URLs. Do not make page HTTP requests. A returned final URL is never trusted without this guard.

- [ ] Add exact-deadline/abort, empty answers, >16 answers, lookup timeout, public IPv4/IPv6, mapped IPv6 DNS, trailing dots, punycode/normalization, default ports, multicast, and a safe source → private final/redirect chain rejection. Run GREEN.
- [ ] Commit only the two files: `feat(web-search): enforce public URL and remote-read gates`.

### Task 3: Secret cipher and bounded persistence CAS

**Files:** create cipher/test, `backend/src/persistence/web-search-connections.ts`, `backend/test/persistence/web-search-connections.spec.ts`; narrowly modify `backend/src/persistence/indexes.ts`.

- [ ] Write failing cipher checks:

```ts
import { expect, it } from 'vitest';
import { WebSearchSecretCipher } from './web-search-secret-cipher.js';
it('binds encrypted credentials to owner provider connection version and kind', () => {
  const cipher = new WebSearchSecretCipher({ status: 'ready', key: Buffer.alloc(32, 7) });
  const binding = { userId: 'u_a', provider: 'exa' as const, connectionId: 'conn_a',
    credentialVersion: 1, tokenKind: 'credential-bundle' as const };
  const envelope = cipher.seal(binding, '{"method":"api-key","apiKey":"fixture-secret"}');
  expect(JSON.stringify(envelope)).not.toContain('fixture-secret');
  expect(cipher.open(binding, envelope)).toContain('fixture-secret');
  for (const changed of [{ userId: 'u_b' }, { provider: 'tavily' }, { connectionId: 'conn_b' },
    { credentialVersion: 2 }, { tokenKind: 'pkce' }]) {
    expect(() => cipher.open({ ...binding, ...changed } as typeof binding, envelope))
      .toThrow('WEB_ENCRYPTION_UNAVAILABLE');
  }
  expect(cipher.seal(binding, 'x').iv).not.toBe(cipher.seal(binding, 'x').iv);
});
```

- [ ] Run RED: `npm test -- src/platform/crypto/web-search-secret-cipher.spec.ts`.
- [ ] Implement `seal(binding, plaintext)`/`open(binding,envelope)` with the exact cipher/AAD rules above and strict schemas. Add malformed base64/tag/IV/ciphertext, missing bootstrap key, oversized plaintext, and PKCE binding tests; run GREEN.
- [ ] Write this repository/index RED check, then fake-collection tests: owner A cannot read/replace/consume B; first create revision1; concurrent same revision one winner; exact lost-ACK reread confirms once; unreadable ACK uncertain; revision overflow/oversize rejected; state consume once and exactly-at-expiry denies. Use `vi.fn` collection methods rather than a Mongo emulator; inspect every filter.

```ts
import { expect, it } from 'vitest';
import { WEB_SEARCH_INDEXES, CALENDAR_INDEXES } from '../../src/persistence/indexes.js';
it('indexes only bounded web account and expiring OAuth records without Calendar collisions', () => {
  expect(WEB_SEARCH_INDEXES).toHaveLength(4);
  expect(WEB_SEARCH_INDEXES.every(i => i.collection === 'web_search_connections')).toBe(true);
  expect(WEB_SEARCH_INDEXES.find(i => i.options.name === 'web_search_account_owner'))
    .toMatchObject({ keys: { userId: 1, kind: 1 }, options: {
      unique: true, partialFilterExpression: { kind: 'account' } } });
  expect(WEB_SEARCH_INDEXES.find(i => i.options.name === 'web_search_oauth_expiry'))
    .toMatchObject({ keys: { expiresAt: 1 }, options: {
      expireAfterSeconds: 0, partialFilterExpression: { kind: 'oauth-state' } } });
  expect(CALENDAR_INDEXES.some(i => i.collection === 'web_search_connections')).toBe(false);
});
```
- [ ] Run RED: `npm test -- test/persistence/web-search-connections.spec.ts`.
- [ ] Implement the exact aggregate schemas/keys/CAS above with this replacement kernel inside `saveAccount`:

```ts
await owner.assertExecutor();
const result = await store.collection('web_search_connections').replaceOne(
  { _id: key('web-search-account', next.userId), userId: next.userId,
    kind: 'account', revision: expectedRevision },
  boundedDocument,
  { ...store.options(), timeoutMS: store.timeoutMs, writeConcern: { w: 'majority', j: true } },
);
if (result.acknowledged && result.matchedCount === 1) {
  await owner.assertExecutor();
  return { outcome: 'confirmed', record: next };
}
```

Here `boundedDocument` is `{_id, ...strictParsedNext}` after `assertBytes`; owner/store/next are method locals/constructor dependencies. Missing match rereads revision; thrown/unacknowledged outcomes perform one exact reread and deep comparison, otherwise uncertain. Creation uses the stated `$setOnInsert` branch. Do not use `RecordStore.raw`'s generic decoder for a different on-disk shape.

- [ ] Add exact `WEB_SEARCH_INDEXES`, append them in setup, and test index specs/TTL BSON Date behavior and unchanged `CALENDAR_INDEXES`. Run GREEN: `npm test -- test/persistence/web-search-connections.spec.ts src/platform/crypto/web-search-secret-cipher.spec.ts test/persistence/calendar-multi-indexes.spec.ts`.
- [ ] Commit only the five named source/test paths: `feat(web-search): persist encrypted account connections with scoped CAS`.

### Task 4: Actual SDK transport fixture and guarded client

**Files:** create `backend/src/plugins/web-search/mcp-client.ts`, `backend/test/plugins/web-search/mcp-fixture.ts`, `backend/test/plugins/web-search/mcp-client.spec.ts`; extend provider capability checks.

- [ ] Build the minimal **wire** fixture in `mcp-fixture.ts`, not a mocked `Client.callTool`:

```ts
import { vi } from 'vitest';
export function mcpFixture(tools: Array<{ name: string; inputSchema: Record<string, unknown> }>) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  let response: unknown = { content: [{ type: 'text', text: '{"results":[]}' }] };
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, headers: new Headers(init?.headers), body });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? {
      protocolVersion: '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'fixture-only', version: '1' },
    } : body.method === 'tools/list' ? { tools } : response;
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  });
  return { request, calls, setResult(value: unknown) { response = value; } };
}
```

Retain a deterministic fixture `setStatus(status)`/`holdCall()`/SSE chunk response extension when its first test needs it. Make unknown outbound hosts throw; never let a missed fixture invoke global fetch.

- [ ] Write RED using the real SDK-backed `McpWebClient`; then extend its catalog with `get_wallet`, `firecrawl_crawl`, and malicious instructions, none selectable:

```ts
import { expect, it } from 'vitest';
import { McpWebClient } from '../../../src/plugins/web-search/mcp-client.js';
import { mcpFixture } from './mcp-fixture.js';
it('prepares only exact tools and does not rediscover during a call', async () => {
  const f = mcpFixture([
    { name: 'web_search_exa', inputSchema: { type: 'object',
      properties: { query: { type: 'string' }, numResults: { type: 'number' } }, required: ['query'] } },
    { name: 'agent_run', inputSchema: { type: 'object' } },
  ]);
  const mcp = new McpWebClient({ fetch: f.request });
  try {
    const prepared = await mcp.prepare({
      userId: 'u_a', provider: 'exa', connectionId: 'c_a', credentialVersion: 1,
      credentials: { method: 'api-key', apiKey: 'fixture-key' },
      signal: new AbortController().signal, deadlineAt: performance.now() + 12000,
    });
    const before = f.calls.filter(c => c.body.method === 'tools/list').length;
    await prepared.session.call({ name: 'web_search_exa',
      arguments: { query: 'example', numResults: 5 } }, new AbortController().signal,
      performance.now() + 12000);
    expect(f.calls.filter(c => c.body.method === 'tools/list')).toHaveLength(before);
    expect(f.calls.every(c => c.headers.get('x-api-key') === 'fixture-key')).toBe(true);
    expect(f.calls.every(c => !c.url.includes('fixture-key'))).toBe(true);
    await expect(prepared.session.call({ name: 'agent_run', arguments: {} },
      new AbortController().signal, performance.now() + 1000)).rejects.toBeDefined();
  } finally { await mcp.close(); }
});
```

The fixture represents a documented protected MCP handshake; a separate permissive-catalog test requires a credential validation probe before setup can succeed. Its attribution evidence is fixture-only.
- [ ] Run RED: `npm test -- test/plugins/web-search/mcp-client.spec.ts`.
- [ ] Implement SDK ownership with this construction kernel:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  fetch: guardedFetch,
  requestInit: { headers: credentialHeaders(provider, credentials), redirect: 'error', cache: 'no-store' },
  redirectPolicy: 'follow',
  reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1,
    maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 },
});
const client = new Client({ name: 'aurvin-web-search', version: '1' }, { capabilities: {} });
await client.connect(transport, { timeout: connectRemainingMs });
const result = await client.callTool(mappedCall, CallToolResultSchema, {
  signal, timeout: remainingMs, maxTotalTimeout: remainingMs, resetTimeoutOnProgress: false,
});
```

These are locals in `prepare`/session `call`, not module-global calls. `redirectPolicy:'follow'` deliberately leaves enforcement to the custom fetch, which always overwrites redirect with **`'error'`**, including SDK GET/OAuth requests; it never follows anything. No `authProvider`, no automatic 401 refresh/resend, no 404 session replay, no SSE resume. Abort/close on prepare timeout and evict unusable sessions.

- [ ] Implement `guardedFetch` as a streaming Response wrapper, not `await response.text()` prebuffering: exact endpoint allowlist, no credentials in URL, merge required authorization headers even for SDK GET/DELETE, `redirect:'error'`, `cache:'no-store'`, combined slot/lifecycle/transport signal, cancel underlying reader at byte cap/timeout. Preserve streaming SSE headers/status and backpressure; bound the **sum** of chunks including SSE comments; reader cancellation aborts the underlying request. No unbounded idle SSE subscription beyond prepared session lifetime.
- [ ] During setup compile bounded discovered input schemas using installed SDK `AjvJsonSchemaValidator` from `@modelcontextprotocol/sdk/validation/ajv-provider.js`; reject remote `$ref` first. Validate representative mapped browse/fetch objects against the exact tools, hash their canonical schemas, and store only the selected schema digest/capability booleans. Zero tools/call unless explicit setup validation probe is needed.
- [ ] Add chunked JSON/SSE overflow, malformed UTF-8, 302-to-private/credential stripping, metadata-origin rejection, absent credentials, permissive catalog then rejected probe, keyless marker, 401 **exactly one call**, 404 no replay, timeout/progress, abort, >100 tools, repeated cursor, missing exact tool, changed schema, and cleanup checks. GREEN: same command plus `providers.spec.ts`.
- [ ] Commit named files only: `feat(web-search): add bounded authenticated MCP client without replay`.

### Task 5: Deterministic normalizers for all ten mappings

**Files:** create `backend/src/plugins/web-search/results.ts`, `backend/test/plugins/web-search/results.spec.ts`; extend `mcp-fixture.ts` only for fixture payloads.

- [ ] Write RED with direct provider-shaped payloads, not already normalized P1 results:

```ts
import { expect, it } from 'vitest';
import { normalizeResult } from '../../../src/plugins/web-search/results.js';
it('normalizes structured Tavily search and preserves tool provenance', async () => {
  const result = await normalizeResult({
    provider: 'tavily', args: { mode: 'browse', query: 'example' },
    payload: { content: [{ type: 'text', text: JSON.stringify({
      results: [{ title: 'Example', url: 'https://example.com/', content: 'Useful evidence' }],
      answer: 'Untrusted synthesized answer is not a source',
    }) }] },
    turnId: 'turn_1', toolCallId: 'call_1', retrievedAt: '2026-11-14T00:00:00.000Z',
    publicUrl: async (url: string) => url,
  });
  expect(result).toMatchObject({ ok: true, provider: 'tavily', mode: 'browse',
    results: [{ source: { toolCallId: 'call_1', provider: 'tavily', kind: 'browse',
      url: 'https://example.com/' }, snippet: 'Useful evidence' }] });
  expect(JSON.stringify(result)).not.toContain('Untrusted synthesized');
});
```

`normalizeResult(input)` accepts the exact fields above, with `args: WebToolArguments`, `payload: unknown`, and `publicUrl: (raw:string)=>Promise<string>`; returns `Promise<WebToolResult>`. It reports unusable failure rather than throwing raw parse errors.

- [ ] Run RED: `npm test -- test/plugins/web-search/results.spec.ts`.
- [ ] Implement the extraction table, source-ID rule, URL validation, code-point truncation, and serialized-byte fit above. The byte fitting primitive:

```ts
export function fittingPrefix(text: string, fits: (candidate: string) => boolean): string {
  const points = Array.from(text);
  let low = 0, high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(points.slice(0, mid).join(''))) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join('');
}
```

`fits` measures the **complete** candidate result `Buffer.byteLength(JSON.stringify(result),'utf8')`, not content alone. Provider fields must be copied into explicit output fields; never object-spread raw JSON into result/source/activity.

- [ ] Add one browse and one fetch fixture for each provider from the extraction table, Exa text grammars, Firecrawl nested web, TinyFish exact source matching, UTF-8 multibyte overflow, 6 results, duplicate URLs, complete long URL drop (not truncate), private returned/final/redirect URL rejection, blocked/login shell, wrong-source page, prompt-injection text treated only as content, isError, unknown shape, and truthful `truncated`. Assert every success passes P1 schema/bytes and contains no raw secret field.
- [ ] Run GREEN: same command. Commit only named files: `feat(web-search): normalize bounded evidence from five MCP providers`.

### Task 6: Prepared connections and atomic control-plane changes

**Files:** create `backend/src/plugins/web-search/connection.ts`, `backend/test/plugins/web-search/fixtures.ts`, `backend/test/plugins/web-search/connections.spec.ts`.

- [ ] Create a small fixture with real connections/cipher and fake `WebSearchStore`/`WebMcpClient`:

```ts
// fixtures.ts exports this exact test API; build each method only when its first test needs it.
export type ConnectionFixture = {
  service: WebSearchConnectionsApi;
  store: WebSearchStore;
  calls: { reads: number; writes: number; prepares: number; closes: number };
  connect(provider: WebSearchProvider, userId?: string): Promise<WebSearchPublicStatus>;
  setEnabled(enabled: boolean, userId?: string): Promise<WebSearchPublicStatus>;
  failNextSave(outcome: 'uncertain' | 'conflict'): void;
  holdNextSave(): { release(): void; entered: Promise<void> };
  rejectNextPrepare(code: WebSearchHttpErrorCode): void;
};
```

The implementation uses `structuredClone` and a map for store records, incremented counters on each fake port call, deferred promises for barriers, fixture-only keys/capabilities/sessions, and a new service per fixture. Do not bypass real service validation/public projection in convenience methods. `connect` reads the current service status revision and submits P1 body; defaults userId `'u_a'`.

- [ ] Write RED:

```ts
it('does not enable on connect and preserves an old connection on failed replacement', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a');
  expect((await f.connect('exa')).enabled).toBe(false);
  await f.setEnabled(true);
  f.rejectNextPrepare('WEB_INVALID_KEY');
  await expect(f.connect('exa')).rejects.toMatchObject({ code: 'WEB_INVALID_KEY' });
  expect(f.service.status('u_a')).toMatchObject({ enabled: true, effectiveEnabled: true });
});
it('last-provider removal stays off after reconnect', async () => {
  const f = connectionFixture();
  await f.service.warmOwner('u_a'); await f.connect('exa'); await f.setEnabled(true);
  const s = f.service.status('u_a');
  await f.service.disconnect('u_a', 'exa', { protocolVersion: 1, expectedRevision: s.revision, confirm: true },
    new AbortController().signal);
  expect((await f.connect('exa')).enabled).toBe(false);
});
```

- [ ] Run RED: `npm test -- test/plugins/web-search/connections.spec.ts`.
- [ ] Implement `WebSearchConnections` with the declared API, a `Map` of confirmed account/prepared state and generation tombstones, deduplicated warm, per-owner control mutex, transient setup views, immediate restrictive fences, and confirmation-before-publication. Reuse `status()` P1 schema and fixed provider order. Core permission fence:

```ts
// Executed synchronously before any disable/disconnect/evict await:
entry.generation += 1;
entry.denied = true; // global disable/evict only; provider removal uses provider fence
for (const work of entry.inFlight) work.abort();
mcp.invalidate(userId);
```

Per-provider replacement/removal uses its own generation/controller set, not the global `denied` bit. Candidate validation returns effective capabilities `discovered && remoteSafety` and remains isolated until CAS. Every post-await publish rechecks owner/provider generation and expected revision; no stale setup can resurrect a disconnected slot.

- [ ] Add account B isolation (including cached MCP session key), invalid/unsupported first setup projections, enable-without-connection409, successful replacement invalidates old version, parallel stale revision conflict, disable before held save, uncertain save staying denied, concurrent warm/new mutation, evict during warm/prepare, transient outage preserves preference, expiry exactly at timestamp, and secret-free `JSON.stringify(status/errors/logs)`.
- [ ] Run GREEN: connections/provider/persistence/cipher focused commands. Commit named files: `feat(web-search): manage per-user prepared connections and permission fences`.

### Task 7: Capability-gated browser OAuth and single-use callbacks

**Files:** create `backend/src/plugins/web-search/oauth.ts`, `backend/test/plugins/web-search/oauth.spec.ts`; extend `fixtures.ts` with bounded OAuth fake HTTP.

- [ ] Write RED against real service methods, with an in-process mock metadata/DCR/token server via injected fetch:

```ts
it('binds OAuth to provider owner session browser and one callback exchange', async () => {
  const f = oauthFixture('firecrawl');
  const started = await f.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  expect(new URL(started.authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256');
  await expect(f.complete({ state, code: 'fixture-code', cookie: 'wrong-cookie' }))
    .rejects.toMatchObject({ code: 'WEB_OAUTH_BINDING_MISMATCH' });
  expect(f.tokenPosts()).toBe(0);
  expect(await f.complete({ state, code: 'fixture-code', cookie: started.browserCookie })).toBe('connected');
  await expect(f.complete({ state, code: 'fixture-code', cookie: started.browserCookie }))
    .rejects.toMatchObject({ code: 'WEB_OAUTH_STATE_INVALID' });
  expect(f.tokenPosts()).toBe(1);
  expect(f.status().enabled).toBe(false);
});
```

Define `oauthFixture(provider)` in the existing test fixture file with `start()`, `complete({state,code?,error?,cookie,owner?,session?})`, `status()`, `tokenPosts()`, `advance(ms)`, `setMetadata(value)`, `setTokenResponse(value)`, `loseConsumeAck()`, `holdTokenResponse()`. It uses real OAuth/connection/store logic and fixed-origin stub fetch, not a mocked successful `complete`.

- [ ] Run RED: `npm test -- test/plugins/web-search/oauth.spec.ts`.
- [ ] Implement explicit SDK primitives, not a custom OAuth stack:

```ts
import {
  discoverOAuthServerInfo, registerClient, startAuthorization,
  exchangeAuthorization, refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
```

Flow: validate P1 request/revision → fixed endpoint discovery with guarded 64KiB metadata/32KiB token fetch and 12s total bound → require allowed issuer/resource/endpoints, S256/code/refresh/public-client support → DCR with exact `redirect_uris`/`response_types:['code']`/`grant_types:['authorization_code','refresh_token']`/auth method none → validate returned registration/issuer (no client secret fallback) → random32-byte state/cookie, SHA256 hashes/session binding → SDK `startAuthorization` → encrypted verifier/state save confirmed → return P1 start response and dedicated provider cookie. No cookie if state write failed.

`redirectUri` is server-derived `new URL('/api' + WEB_SEARCH_ROUTES.oauthCallback(provider), frontendOrigin)`, never body/query supplied. Require HTTPS outside existing approved loopback local mode. Cookie name `aurvin_web_search_oauth_<provider>`; Path `/api/plugins/web-search/providers/<provider>/oauth`; HttpOnly; SameSite=Lax; Max-Age600; Secure according to configured deployment. Reject duplicate cookies. Do not reuse Calendar cookie or OAuth state record.

Completion: parse percent-encoding/duplicates strictly → require one state and exactly code or error, optional issuer only if exact binding → compare owner/provider/session/browser, expected revision, not expired → atomic consume acknowledged → denied returns `denied` without exchange → decrypt bound verifier → SDK exchange with pinned issuer/resource/public client → validate Bearer tokens/expiry → prepare exact authenticated MCP capabilities → account CAS → publish only if lifecycle epoch unchanged. Code/denial never enters logs/URLs after bridge cleanup. A second simultaneous completion never exchanges.

- [ ] Add five-provider OAuth success **fixtures** and capability-denial cases: no registration, unsupported PKCE, off-origin issuer/token URL, missing refresh support/audience, callback mismatch, malformed duplicates/query, wrong owner/session/provider/browser, denial, expiry at 600000ms, lost consume ACK, concurrent complete, stale revision, disconnect/disable/evict while token exchange held. No old slot replacement on failed flow.
- [ ] Run GREEN: OAuth/connections/MCP focused suites. Commit named files: `feat(web-search): add bound capability-gated MCP OAuth setup`.

### Task 8: Bounded background renewal and capability maintenance

**Files:** extend `oauth.ts`, `connection.ts`, `mcp-client.ts`, `oauth.spec.ts`, `connections.spec.ts`.

- [ ] Add RED with `oauthFixture` extended by `oauth`, `expireAccess()`, and `refreshPosts()` accessors. Initialize a fixture-authorized OAuth connection, then:

```ts
it('renewal is off-turn and coalesces concurrent single-use refresh work', async () => {
  const f = oauthFixture('firecrawl');
  const started = await f.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  await f.complete({ state, code: 'fixture-code', cookie: started.browserCookie });
  f.expireAccess();
  expect(f.refreshPosts()).toBe(0);
  f.status(); // synchronous, no token I/O
  expect(f.refreshPosts()).toBe(0);
  const signal = new AbortController().signal;
  await Promise.all([f.oauth.maintainOwner('u_a', signal), f.oauth.maintainOwner('u_a', signal)]);
  expect(f.refreshPosts()).toBe(1);
});
```

Hold the store independently in a sibling case: snapshot/status still returns immediately, runtime skips the expired token without refresh, and renewal waits only in its tracked background job.
- [ ] Run RED: `npm test -- test/plugins/web-search/oauth.spec.ts -t "renewal"`.
- [ ] Implement the service-owned 60s lifecycle sweep/2-slot bound and pre-refresh durable dispatch marker described above. Explicit renewal kernel:

```ts
const tokens = await refreshAuthorization(binding.issuer, {
  metadata: pinnedMetadata,
  clientInformation: { client_id: binding.clientId, issuer: binding.issuer },
  refreshToken: bundle.refreshToken!,
  resource: binding.resource,
  fetchFn: boundedOAuthFetch,
});
```

This runs only after the `dispatching` save is confirmed and current generation rechecked. Preserve SDK issuer provenance, validate returned tokens, rotate version and persist before publish. No `authProvider` appears on MCP transports. `maintainOwner` also reopens a missing session/revalidates expired capability within its slot but performs no search probe.

- [ ] Add success/denial/expired refresh, access expiry exact boundary, rotating refresh result persisted before memory, lost token response, lost ACK after rotation, restart with dispatching marker, no automatic second POST, no stale refresh publish after replacement/disconnect/logout, 2-job global cap, 24h capabilities expiry, cooldown, and bounded close. Run GREEN without advancing real timers/sleep; use injected clocks and Vitest fake timers.
- [ ] Commit only touched P2 files: `feat(web-search): bound off-turn OAuth renewal and capability maintenance`.

### Task 9: Small execution port and ordered fallback

**Files:** create `backend/src/plugins/web-search/runtime.ts`, `backend/test/plugins/web-search/runtime.spec.ts`; extend `fixtures.ts` with runtime convenience methods.

- [ ] Write RED using real connection authority plus prepared fake sessions:

```ts
it('tries each eligible connected provider once in fixed order without fan-out', async () => {
  const f = runtimeFixture();
  await f.connect(['firecrawl', 'exa', 'keenable', 'tavily']);
  f.failProvider('keenable', 'WEB_PROVIDER_RATE_LIMITED');
  f.failProvider('exa', 'WEB_UNUSABLE_RESULT');
  const result = await f.call({ mode: 'browse', query: 'example' });
  expect(f.providerCalls()).toEqual(['keenable', 'exa', 'tavily']);
  expect(result).toMatchObject({ ok: true, provider: 'tavily' });
  expect(f.maxConcurrentProviderCalls()).toBe(1);
  expect(f.storageCallsSincePrepared()).toBe(0);
});
it('never falls back anonymously when all connected providers fail', async () => {
  const f = runtimeFixture(); await f.connect(['exa']);
  f.failProvider('exa', 'WEB_PROVIDER_AUTH');
  expect(await f.call({ mode: 'browse', query: 'example' })).toMatchObject({
    ok: false, error: { code: 'WEB_PROVIDERS_EXHAUSTED' },
  });
  expect(f.providerCalls()).toEqual(['exa']);
  expect(f.anyAnonymousRequest()).toBe(false);
});
```

`runtimeFixture` methods: `connect(providers)` performs real setup/toggle; `call(args)` invokes `validateInput` then `execute` with stable owner/turn/call context; `failProvider`, `holdProvider`, `providerCalls`, `maxConcurrentProviderCalls`, `storageCallsSincePrepared`, `anyAnonymousRequest`, `advance`, `disable`, `disconnect`. Wire them through fake prepared sessions and injected clocks; do not replace runtime's loop.

- [ ] Run RED: `npm test -- test/plugins/web-search/runtime.spec.ts`.
- [ ] Implement the private validation ticket, current-memory admission, nested deadlines, source normalization, and fixed traversal:

```ts
const callDeadline = Math.min(context.webDeadlineAt, nowMs() + WEB_SEARCH_POLICY.logicalCallTimeoutMs);
for (const provider of WEB_SEARCH_PROVIDERS) {
  const current = currentEligibleProvider(context.userId, provider, input.args.mode);
  if (!current) continue;
  assertCurrentPermissionAndDeadline(context, callDeadline);
  const slotDeadline = Math.min(callDeadline, nowMs() + WEB_SEARCH_POLICY.providerCallTimeoutMs);
  const session = mcp.session(current, context.userId);
  if (!session) { requestMaintenance(context.userId); continue; }
  // One iteration = at most one tools/call. No connect/list/refresh or persistence here.
  const mapped = mapCall(provider, input.args, slotDeadline - nowMs());
  const payload = await session.call(mapped, combinedSignal, slotDeadline);
  assertSameCurrentGeneration(current, context);
  const normalized = await normalizeResult(normalizerInput(payload, current, input, context, slotDeadline));
  assertSameCurrentGeneration(current, context);
  if (normalized.ok) return normalized;
}
```

Each referenced helper is a private method in `WebSearchRuntime`: `currentEligibleProvider` reads current service memory; permission helpers return/throw closed tool faults; `combinedSignal` combines caller, account/provider lifecycle, and slot signals; `normalizerInput` supplies the declared normalization fields and URL guard. Catch only fixed classified provider faults per slot, emit fallback activity, and continue. Catch cancellation/global denial/deadline outside that fallback branch; return P1 failures. Add `attempted` Set defensively keyed by provider; never restart traversal after capability/credential changes. Completed calls are not cached/replayed by P2.

- [ ] Add success at each priority including fixture-authorized TinyFish OAuth; 5-attempt exhaustion; missing-session skip; mode capability filtering; all provider failure classes; no fallback for unsafe input/off/cancel/deadline; 12/25/45s exact bounds; one-call/provider despite401/404; no auth refresh; invalid ticket owner/turn; safe normalized output; disable, disconnect-one/last, replace, eviction, caller cancel, voice-style abort, and shutdown while provider result held. After a revocation late result emits no source/completed activity.
- [ ] Run GREEN: `npm test -- test/plugins/web-search/runtime.spec.ts test/plugins/web-search/url-safety.spec.ts test/plugins/web-search/results.spec.ts`.
- [ ] Commit named files: `feat(web-search): execute prepared MCP reads with bounded ordered fallback`.

### Task 10: HTTP routes, static callback, and configurable module

**Files:** create `backend/src/plugins/web-search/{controller,module,oauth-callback-page}.ts`; test `backend/test/plugins/web-search/http.spec.ts`.

- [ ] Write RED with `@nestjs/testing`, existing Express adapter/supertest, real P2 services behind a principal fixture. Define `httpFixture()` in `fixtures.ts`: it returns `{ app, close, asOwner }`, where `app.getHttpServer()` is the Nest server, `close()` tears down the module/services, and `asOwner(userId)` binds the request-identity fixture. Its local admission middleware requires `Origin: https://aurvin.example.com` for mutations and uses the same server principal source, not a body userId.

```ts
import request from 'supertest';
import { expect, it } from 'vitest';
import { WEB_SEARCH_ROUTES, webSearchPublicStatusSchema } from '../../../src/contracts/web-search-wire.js';
import { httpFixture } from './fixtures.js';
it('serves P1 status and rejects client ownership overrides without secrets', async () => {
  const f = await httpFixture();
  try {
    const r = await request(f.app.getHttpServer()).get('/api' + WEB_SEARCH_ROUTES.status).expect(200);
    expect(webSearchPublicStatusSchema.parse(r.body).providers.map(p => p.provider))
      .toEqual(['tinyfish', 'keenable', 'exa', 'tavily', 'firecrawl']);
    const denied = await request(f.app.getHttpServer())
      .post('/api' + WEB_SEARCH_ROUTES.connect('exa'))
      .set('Origin', 'https://aurvin.example.com')
      .send({ protocolVersion: 1, expectedRevision: 0, candidate: 'fixture-key', userId: 'u_b' })
      .expect(400);
    expect(JSON.stringify(denied.body)).not.toContain('fixture-key');
    expect(JSON.stringify(r.body)).not.toContain('credential');
  } finally { await f.close(); }
});
```

Extend route parity against P1 paths, connect/replace/disconnect/settings/OAuth start/complete, provider path/body/query overrides, wrong methods, missing origin, body bound, unauthenticated and cross-account contexts. These local middleware checks are not P3's real admission integration.
- [ ] Run RED: `npm test -- test/plugins/web-search/http.spec.ts`.
- [ ] Implement `WebSearchModule` using `ConfigurableModuleBuilder<WebSearchModuleOptions>().build()`, options-injected controller factory tokens, and no imports from AppService. Register with `@Controller('plugins/web-search')`; use P1 path suffixes and provider schema (no arbitrary name). Every private method invokes server `principal()`, `assertNoClientOverrides(body)`, and the exact P1 request schema before calling owner-specific service methods. Validate public response schemas.
- [ ] Convert `assertNoClientOverrides`'s existing `AppError` codes `IDENTITY_OVERRIDE_REJECTED`/`MODEL_OVERRIDE_REJECTED` into `WebSearchFault('WEB_INVALID_REQUEST')` locally, preserving the guard and HTTP400 without widening global errors. Do not treat them as unknown502.
- [ ] Implement the public **static-only** callback bridge as a fixed provider map with no request query interpolation:

```ts
const scriptFor = (provider: WebSearchProvider) => `(async()=>{
const rawQuery=location.search.slice(1);history.replaceState(null,'',location.pathname);
try{const r=await fetch(${JSON.stringify('/api' + WEB_SEARCH_ROUTES.oauthComplete(provider))},{
method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
body:JSON.stringify({protocolVersion:1,rawQuery})});
if(!r.ok)throw Error();const x=await r.json();
if(!['connected','denied','expired','failed'].includes(x.outcome))throw Error();
location.replace('/?plugin=web-search&oauth='+encodeURIComponent(x.outcome));
}catch{document.getElementById('status').textContent='Sign in to Aurvin and start the connection again.';}
})();`;
```

Use SHA256 CSP hash for the exact script, `default-src 'none'; script-src 'sha256-...'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`, no-store/no-referrer/nosniff. Provider comes from a static typed allowlist, never raw path concatenation. GET exchanges nothing and claims no connection. POST completion requires existing session and origin; no custom header bypass. Clear provider binding cookie on terminal completion; malformed/binding-mismatch responses never consume another user's valid state.

- [ ] Add a local controller abort helper that removes listeners when response finishes; propagate request-aborted/socket-close without treating a fully received POST's ordinary close as cancellation. `WebSearchFilter` maps only P1 plugin faults/Zod/input-size failures; preserve AuthFault bodies; unknown errors become `WEB_PROVIDER_UNAVAILABLE` with no raw error logging.
- [ ] Add full P1 HTTP status/retryability table tests, no response token suffix/envelope/query, callback CSP/secret removal/fixed complete path, duplicate OAuth query/cookie handling, multiple simultaneous users/providers, parser413, cache headers, and no request identity default. **P3** must mount the real private HTTP middleware in assembled checks; this task's fixture cannot certify that central routing.
- [ ] Run GREEN: HTTP/OAuth/connections focused suites. Commit named files: `feat(web-search): expose strict per-user plugin HTTP and callback module`.

### Task 11: Prepared-path, cancellation, and held-storage proof

**Files:** create `backend/test/plugins/web-search/prepared.spec.ts`; extend relevant P2 specs only.

- [ ] Write RED for the isolated port contract with throwing storage/provider-preparation spies after setup:

```ts
it('prepared snapshot and initial dispatch do not touch storage discovery connect or refresh', async () => {
  const f = preparedFixture();
  await f.setupConnectedAccount();
  f.blockStorageAndPreparation();
  const snapshot = f.runtime.snapshot('u_a');
  expect(snapshot.prepared).toBe(true);
  f.markInitialModelDispatch(snapshot); // records boundary only; P3 supplies the real model fixture
  expect(f.eventsBeforeDispatch()).toEqual([]);
  expect((await f.executeBrowse()).ok).toBe(true);
  expect(f.storageOperations()).toBe(0);
  expect(f.preparationOperations()).toBe(0);
});
```

Define `preparedFixture()` in existing `fixtures.ts` with the seven methods used above; its runtime/authority/SDK sessions are real P2 objects and its storage/HTTP are instrumented fixtures. `markInitialModelDispatch` cannot be presented as assembled text/voice evidence.

- [ ] Run RED: `npm test -- test/plugins/web-search/prepared.spec.ts`.
- [ ] If any check finds a port-path call to persistence/connect/list/refresh, remove it from that shared P2 path and move it to the declared setup/maintenance method; add the failing caller regression before the fix. Do not patch P3's runtime or weaken spies.
- [ ] Add warm hit zero reads; cold snapshot closed with no implicit warm; blocked store while ordinary snapshot/next call progresses; held rotation save never delaying initial model boundary; real SDK prepared browse/fetch fixtures for each provider; off/unused external count0; owner-specific missing/expired credentials skip0; account invalidation/disconnect/disable during every await; failed last-provider removal durable limitation; no stale warm/refresh/capability callback resurrection.
- [ ] For successful fetch-path fixtures only, override the provider **module** in the test, not a production constructor/request field. This explicit trust fiction must be named in the test and reset after each case:

```ts
import { afterEach, vi } from 'vitest';
import type { WebSearchProvider } from '../../../src/contracts/web-search-policy.js';
const fixtureTrust = vi.hoisted(() => ({ remoteReadsVerified: false }));
vi.mock('../../../src/plugins/web-search/providers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/plugins/web-search/providers.js')>();
  return { ...actual, providerDefinition: (provider: WebSearchProvider) => ({
    ...actual.providerDefinition(provider),
    fetchSafety: fixtureTrust.remoteReadsVerified ? 'verified' as const : 'unverified' as const,
  }) };
});
afterEach(() => { fixtureTrust.remoteReadsVerified = false; });
```

Set `fixtureTrust.remoteReadsVerified = true` only inside named synthetic successful-fetch cases. A separate unmocked provider suite proves all five production entries remain unverified; no mock trust setting ships in production code or compatibility evidence. Every synthetic network request still uses the fixed-origin fixture fetch.
- [ ] Run GREEN: `npm test -- test/plugins/web-search/ test/persistence/web-search-connections.spec.ts src/platform/crypto/web-search-secret-cipher.spec.ts`.
- [ ] Commit named test paths only (plus any TDD-proven P2-owned defect correction): `test(web-search): prove prepared reads and lifecycle isolation`.

### Task 12: Isolated native suite, regression evidence, and handoff

**Files:** create only `backend/test/persistence/web-search-native.spec.ts` for native checks. This plan document is the only workflow artifact P2 may edit; return execution evidence to the orchestrator rather than writing P5 reports.

- [ ] Add prerequisite-gated native tests using existing `backend/test/persistence/native.ts`, `nativeDatabase()`, `RecordStore`, and normal owner claim/release. Require operator-supplied `AURVIN_TEST_MONGODB_URI` and exact prefix `aurvin_p2_test_`; never print them or create prerequisites. Begin with this runnable index check, then add repository cases:

```ts
import { describe, expect, it } from 'vitest';
import { nativeDatabase } from './native.js';
import { setupIndexes } from '../../src/persistence/indexes.js';
const supplied = Boolean(process.env.AURVIN_TEST_MONGODB_URI) &&
  process.env.AURVIN_TEST_DB_PREFIX === 'aurvin_p2_test_';
describe.skipIf(!supplied)('web-search native isolated storage', () => {
  it('creates actual scoped web indexes alongside Calendar indexes', async () => {
    const f = await nativeDatabase();
    try {
      await setupIndexes(f.db);
      const indexes = await f.db.collection('web_search_connections').listIndexes().toArray();
      expect(indexes.find(i => i.name === 'web_search_account_owner')?.unique).toBe(true);
      expect(indexes.find(i => i.name === 'web_search_oauth_expiry')?.expireAfterSeconds).toBe(0);
      expect(await f.db.collection('integration_connections').listIndexes().toArray())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'calendar_owner' })]));
    } finally { await f.close(); }
  });
});
```
- [ ] RED/GREEN the repository logic with fake stores first. The native suite asserts actual index creation, per-owner aggregate isolation/CAS, two callbacks consuming once, BSON Date expiry, valid encrypted round trip, and Calendar/web collections coexisting. TTL deletion timing is **not** asserted as an SLA; exact application expiry is tested independently.
- [ ] Run from `backend`:

```powershell
npm test -- test/persistence/web-search-native.spec.ts
npm test -- test/plugins/web-search/ test/persistence/web-search-connections.spec.ts src/platform/crypto/web-search-secret-cipher.spec.ts
npm test -- src/contracts/web-search-policy.spec.ts src/contracts/web-search-wire.spec.ts src/contracts/web-search-tools.spec.ts test/persistence/calendar-multi-indexes.spec.ts
npm run build
npm run lint
npm test
npm run test:e2e
```

Native tests without prerequisites must report **skipped**, not passed. Full routine baseline in `state.md` already has failures; record actual file/test counts and compare affected checks, never classify a failure as pre-existing without evidence. Do not change P4's frontend contract mirrors, Calendar failures, or unrelated source to force green.

- [ ] Commit the native test after permission: `test(web-search): cover isolated native connection persistence`.
- [ ] Inspect final named diff, whitespace, status, and commit list. Confirm no Calendar/P1/frontend/central-composition changes. Report planned versus actually executed checks, individual prerequisite skips, compatibility gates, and review **skipped**.

## Exact P3 handoff

P3 receives these stable private APIs; report any implementation signature discrepancy before P3 starts:

```ts
const connections = new WebSearchConnections({
  store: () => webSearchStoreOrNull,
  cipher, mcp,
  now: () => new Date(),
  nowMs: () => performance.now(),
});
const oauth = new WebSearchOAuth({ connections, store: () => webSearchStoreOrNull,
  cipher, mcp, frontendOrigin, secureCookie, fetch: guardedOAuthFetch });
const webSearch: WebSearchPort = new WebSearchRuntime({ connections, mcp,
  lookup, nowMs: () => performance.now(), now: () => new Date() });
connections.setMaintenance((userId, signal) => oauth.maintainOwner(userId, signal));
```

The constructors accept optional clocks/fetch/DNS only as backend-injected dependencies; no HTTP input controls them. Production definitions keep fetch safety closed. `connections` exposes backend-private `snapshot`, `currentEligibleProvider`, provider/account generation checks, `requestMaintenance`, and lifecycle abort subscriptions used only by P2 runtime/OAuth. `oauth.maintainOwner` is bound once to the connection service's bounded maintenance callback after construction; construction itself makes zero requests. No circular AppService import.

P3 actions:

1. Instantiate P2 once using the existing admitted/guarded RecordStore and MongoOwnership. If `PersistenceBundle` needs a web repository property, P3 owns that narrow composition edit. Reuse the existing encryption bootstrap; no second persistence owner.
2. `WebSearchModule.registerAsync` injects AppService factories for `connections`, `oauth`, server principal, override guard, frontend origin, secureCookie. P2 module/controller never instantiate application services.
3. Add exact static GET callback exemptions for the five P1 callback routes to `configurePrivateHttp`. Existing middleware rejects cross-site callbacks before auth; a blanket `/plugins/web-search` exemption would be a security bug. Every other route remains full-account/session/origin protected. POST complete is private.
4. Apply P1 16,384-byte body bound **before** large JSON buffering on these routes; reuse existing raw-parser validation infrastructure. Do not rely on measuring a parsed object. Preserve request/session/CORS/CSRF policy.
5. Warm from authenticated login/plugin setup/status or tracked startup/background work outside admitted turns. A prepared `prepareOwner` hit performs no DB work. **Never await cold web preparation in HTTP turn/voice turn admission.** An unprepared owner gets ordinary chat and can use web on a later prepared turn.
6. Read `webSearch.snapshot(userId)` synchronously for advertisement; require `enabled`, eligible prepared provider, and `snapshot.modelLimits?.tools === true`. Do not gate web on `calendar.tools` or put private credential snapshots into prompts.
7. After initial model emits a valid web call, build `WebCallContext` from immutable accepted owner/turn/call, caller signal, and shared monotonic deadline; call `validateInput`. Its discriminant is `'ok' in validated` for an immediate failure versus `'args' in validated` for a valid ticket. On success reserve one accepted-turn mode budget/context slot, then `execute`. Invalid/unsafe calls spend no logical budget; fallback spends no extra logical budget.
8. P3 owns one accepted-turn search counter, fetch counter, repair counter3, context/evidence limits, model retries, and honest terminal failure/synthesis. All subsequent model requests and next-turn eligibility remain independent of persistence.
9. Translate optional P2 activity and success sources into P1 text/voice events, discard late emissions using runtime/turn signal checks, and archive bounded tool/result/source/accounting linkage through the existing asynchronous consolidated path.
10. On logout/deactivation/shutdown call `connections.evict(userId)`, `oauth.invalidate(userId)`, or bounded `close` as appropriate; invalidate in-flight work before any rehydration. P2 setup/background work must be tracked in normal shutdown, not readiness.
11. Preserve root Calendar critical-path tests, mutation barriers, held-archive continuation, exact expiry, and multi-tool coexistence. P2 adds read-only tools and **no durable pre-effect barrier** to reads.

P4/P5 must be told: the fixed cards and P1 API are present; manual TinyFish keys remain unsupported; OAuth buttons require actual capability support; **all real fetch capabilities remain gated until redirect/private-target guarantees are established**. A P1 card with browse true/fetch false is valid, but the frontend must explain the partial mode without claiming full provider compatibility.

Browser auth support can be `unverified` before the user explicitly requests `oauthStart`; that control-plane operation may discover support and start a real flow, or return `WEB_AUTH_UNSUPPORTED`. A UI may offer a clearly labeled support-check/connect action for this state, but must not display “supported/connected” merely from a provider link. A status read does not perform network discovery.

## Exact implementation commit commands

Run `git status --short` and obtain serialized commit ownership first. Each row is two separate shell invocations, **not** a command chain. Add only these files actually owned/changed by that task; an empty follow-up needs no empty commit.

| Task | Explicit staging command | Commit command |
| --- | --- | --- |
| 1 | `git add -- backend/src/plugins/web-search/types.ts backend/src/plugins/web-search/errors.ts backend/src/plugins/web-search/providers.ts backend/test/plugins/web-search/providers.spec.ts` | `git commit -m "feat(web-search): define fixed MCP mappings and private ports"` |
| 2 | `git add -- backend/src/plugins/web-search/url-safety.ts backend/test/plugins/web-search/url-safety.spec.ts` | `git commit -m "feat(web-search): enforce public URL and remote-read gates"` |
| 3 | `git add -- backend/src/platform/crypto/web-search-secret-cipher.ts backend/src/platform/crypto/web-search-secret-cipher.spec.ts backend/src/persistence/web-search-connections.ts backend/src/persistence/indexes.ts backend/test/persistence/web-search-connections.spec.ts` | `git commit -m "feat(web-search): persist encrypted account connections with scoped CAS"` |
| 4 | `git add -- backend/src/plugins/web-search/mcp-client.ts backend/src/plugins/web-search/providers.ts backend/test/plugins/web-search/mcp-fixture.ts backend/test/plugins/web-search/mcp-client.spec.ts` | `git commit -m "feat(web-search): add bounded authenticated MCP client without replay"` |
| 5 | `git add -- backend/src/plugins/web-search/results.ts backend/test/plugins/web-search/results.spec.ts backend/test/plugins/web-search/mcp-fixture.ts` | `git commit -m "feat(web-search): normalize bounded evidence from five MCP providers"` |
| 6 | `git add -- backend/src/plugins/web-search/connection.ts backend/test/plugins/web-search/fixtures.ts backend/test/plugins/web-search/connections.spec.ts` | `git commit -m "feat(web-search): manage per-user prepared connections and permission fences"` |
| 7 | `git add -- backend/src/plugins/web-search/oauth.ts backend/test/plugins/web-search/oauth.spec.ts backend/test/plugins/web-search/fixtures.ts` | `git commit -m "feat(web-search): add bound capability-gated MCP OAuth setup"` |
| 8 | `git add -- backend/src/plugins/web-search/oauth.ts backend/src/plugins/web-search/connection.ts backend/src/plugins/web-search/mcp-client.ts backend/test/plugins/web-search/oauth.spec.ts backend/test/plugins/web-search/connections.spec.ts backend/test/plugins/web-search/fixtures.ts` | `git commit -m "feat(web-search): bound off-turn OAuth renewal and capability maintenance"` |
| 9 | `git add -- backend/src/plugins/web-search/runtime.ts backend/test/plugins/web-search/runtime.spec.ts backend/test/plugins/web-search/fixtures.ts` | `git commit -m "feat(web-search): execute prepared MCP reads with bounded ordered fallback"` |
| 10 | `git add -- backend/src/plugins/web-search/controller.ts backend/src/plugins/web-search/module.ts backend/src/plugins/web-search/oauth-callback-page.ts backend/test/plugins/web-search/http.spec.ts backend/test/plugins/web-search/fixtures.ts` | `git commit -m "feat(web-search): expose strict per-user plugin HTTP and callback module"` |
| 11 | `git add -- backend/test/plugins/web-search/prepared.spec.ts backend/test/plugins/web-search/fixtures.ts` | `git commit -m "test(web-search): prove prepared reads and lifecycle isolation"` |
| 12 | `git add -- backend/test/persistence/web-search-native.spec.ts` | `git commit -m "test(web-search): cover isolated native connection persistence"` |

If a red/green defect correction changes another P2 file, report that exact path and amend the task's staging list before staging; never replace it with a directory-wide add.

## Exit checklist, acceptance gaps, and reporting

- [ ] Exact fixed endpoints, five provider/ten mode mappings, static allowlist, headers-only credentials, no general catalog exposure or REST/keyless escape.
- [ ] Account-global CAS preference, encrypted credentials/OAuth states, owner/provider/session/browser isolation, replacement preservation, last-provider off, fail-closed revocations.
- [ ] Zero storage/connect/discovery/refresh in prepared snapshot and read authority; no cold web setup before initial model dispatch; bounded background work and no readiness requests.
- [ ] One tools/call/provider/logical call, sequential fallback, nested deadlines, no SDK resend, URL/DNS/result bounds, no local page fetch.
- [ ] Deterministic auth success/denial/expiry/refresh/unsupported, all five modes through fixtures, URL redirect/private rejection, disconnect/disable/cancel/late-result races.
- [ ] P1 schemas/types unchanged; central composition/P3 and frontend/P4 untouched; Calendar preserved.
- [ ] Build/lint/focused/unit/e2e outcomes recorded honestly; native skips separate; no live provider/OAuth/model checks; review skipped.

**Unresolved service limitations are deliberate acceptance blockers, not hidden implementation omissions:**

1. TinyFish hosted API-key-over-MCP unsupported pending verified evidence; OAuth discovery/DCR/local callback/refresh for TinyFish/Keenable/Exa/Tavily still conditional.
2. Current primary sources do not establish every-hop private-network/redirect guarantees for any of the five hosted read tools. Successful synthetic fetch fixtures do not enable production fetch or satisfy live safety/compatibility acceptance.
3. An authenticated MCP session/capability catalog may not validate an API key or prove user-account billing if a server transparently serves public results. Fail closed when authenticated usage cannot be established; report actual provider behavior only after separately authorized checks.
4. Local callback acceptance, hosted schema variants, redirect behavior, OAuth token rotation, billing/quota behavior, native MongoDB and staging are **unrun** until their prerequisites/authorization are supplied.
5. Disabling/disconnecting cannot retract a sent request or guarantee no charges. An uncertain revocation is not durable success; process restart can restore previously saved authority until reconciliation.

Return to the orchestrator: plan/implementation commit hashes, exact changed files, public/private API signature summary, ten mapping table, auth/fetch gates, executed commands/counts/skips/failures, and P3/P4/P5 handoff. Do not mark full Web Search acceptance complete from P2 source or fixture existence.

### Plan self-check coverage

| P2 requirement | Specified implementation/test tasks |
| --- | --- |
| Five providers, exact MCP mappings, static allowlist | 1, 4, 5, 9 |
| Header-only keys, unsupported TinyFish, capability-gated OAuth | 1, 4, 6, 7 |
| Dedicated encrypted per-user collection/index/CAS | 3, 6, 7, 12 |
| Connect/replace/disconnect/status/settings/OAuth routes | 6, 7, 10 |
| Prepared no-I/O memory, bounded renewal and capability lifecycle | 6, 8, 9, 11 |
| Shared deadlines, ordered one-attempt fallback, no anonymous/fan-out | 4, 9 |
| Initial/returned/redirect/private URL rejection; no local fetch | 2, 4, 5, 9 |
| Isolation, secret-free response/logging, denial/expiry/refresh/races | 3, 6, 7, 8, 9, 10, 11 |
| P1 preserved; no central composition or Calendar edits | File map, Task12, P3 handoff |
| Unrun live limitations and skipped review | Authority, safety gate, exit checklist |

Planning verification is document/contract/ownership consistency only. Application test commands above are **planned, not run for this documentation-only change**.
