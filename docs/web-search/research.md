# Web Search Plugin — Technical Research (`WEB-R-20261114-01`)

Status: **Complete (Phase R)** — prerequisite for `P1`–`P5`  
Date: 2026-11-14  
Scope: Technical research only. **Zero** live provider/model calls, paid checks, provisioning, credential writes, or production code modifications were performed.

> [!IMPORTANT]
> **Documented vs. Tested Compatibility**: No live MCP handshake, OAuth authorization, or tool invocation was run during Phase R. All provider behaviors below reflect **documented support** checked against primary provider documentation and official repositories; **tested compatibility = unrun (0 / 5 providers)** and requires deterministic fixtures in P2–P5 (plus separate explicit authorization before any live provider test).

---

## 1. Executive Summary & Key Risks

1. **Installed dependency gap**: `backend/package.json` and `backend/package-lock.json` currently contain **no** MCP client package (`eventsource-parser` is only used by `@langchain/openrouter`). Recommend adding **one** direct production dependency in P1: **`@modelcontextprotocol/sdk`** (the unified `1.x` maintenance line; P1 pins the resolved `1.x` release at install) rather than MCP v2 pre-split packages or hand-rolling Streamable HTTP + SSE + OAuth 2.1/DCR/PKCE. The `1.x` line supports `zod ^3.25` alongside Aurvin's pinned `zod@^3.25.32` (`backend/src/platform/dependency-pins.spec.ts`), exposes `StreamableHTTPClientTransport`, `SSEClientTransport`, and `OAuthClientProvider`, and accepts a custom `fetch` hook backed by Node/`undici`.
2. **Provider auth reality (API key vs. OAuth)**:
   - **Keenable, Exa, Tavily, Firecrawl** explicitly document **API-key authentication over their hosted Streamable HTTP MCP endpoints**, in addition to browser OAuth routes.
   - **TinyFish** documents **OAuth 2.1** for hosted MCP (`https://agent.tinyfish.ai/mcp`) and **`X-API-Key`** for direct REST (`agent.tinyfish.ai/v1/*`, `api.search.tinyfish.ai`, `api.fetch.tinyfish.ai`) and local `stdio` wrappers (`tinyfish-mcp`). Public TinyFish docs do **not** establish that `https://agent.tinyfish.ai/mcp` accepts `X-API-Key` directly, nor do they publish standalone `.well-known` OAuth metadata / DCR / callback / refresh specs. Because `goal.md` prohibits native REST fallbacks, P2 must probe/authenticate TinyFish strictly via MCP and report TinyFish API-key-over-hosted-MCP as **unsupported unless verified** in an authorized live check.
   - **OAuth maturity gap across providers**: Only **Firecrawl** publicly publishes full OAuth 2.1 endpoint specs (RFC 8414 metadata, `/api/oauth/authorize`, `/api/oauth/token`, RFC 7591 `/api/oauth/register` DCR, `PKCE S256`, `fco_` 1h access, `fcr_` 90d single-use refresh). Keenable, Exa, Tavily, and TinyFish document browser OAuth MCP connectors without publishing complete public DCR/loopback-callback/refresh guarantees. Therefore, **per-user API key over hosted MCP is the primary universally verified path** (where supported), and **browser OAuth should be enabled per provider only after standard MCP OAuth discovery (`/.well-known/oauth-protected-resource` / `/.well-known/oauth-authorization-server` + DCR or configured registration) succeeds cleanly**.
3. **Context-budget constraint**: `DEFAULT_BUDGETS` (`backend/src/contracts/budgets.ts`) sets `maxContextTokens = 16_384`, `maxOutputTokens = 2_048`, `modelMarginTokens = 1_024` (`usableHistoryTokens = 13_312`), and `backend/src/context/context-budget.ts` uses a conservative **~1 UTF-8 byte ≈ 1 token** check. Unbounded 5-search + 5-fetch payloads would immediately exhaust a 16K turn budget. Recommended bounds clip per-call `browse` results to **2,400 bytes** and `fetch` results to **4,600 bytes**, enforce a **24,000-byte per-turn web evidence ceiling** capped dynamically by remaining context headroom, and fail closed cleanly if context would overflow rather than discarding history.
4. **Calendar critical-path isolation**: `integration_connections` already carries unique indexes `(userId, provider)` and `(userId, connectionId)` without `partialFilterExpression` (`backend/src/persistence/indexes.ts`), and `backend/src/contracts/config-runtime.ts` currently gates tool execution on `modelLimits.calendar.tools`. Web Search must **not** alter Calendar-owned helpers, mutation barriers, or prepared Calendar authority; recommend a dedicated `web_search_connections` collection (or strictly disjoint `provider` keys) and a neutral `modelLimits.tools` capability flag populated in `backend/src/model/catalogue.ts`.

---

## 2. Existing Aurvin Facilities to Reuse

| Capability | Existing Facility & Location | How Web Search Reuses It | Critical Constraints / Do-Not-Reuse |
| --- | --- | --- | --- |
| **Plugin HTTP & Module Pattern** | `backend/src/app.module.ts`, `backend/src/plugins/google-calendar/{module.ts,controller.ts}` | Add `WebSearchModule` (`registerAsync` injecting `AppService`) serving `/api/plugins/web-search/*` routes behind private HTTP identity guards. | Keep Calendar-owned `connection.ts`, `oauth*.ts`, and dirty Calendar files untouched. |
| **Identity & Anti-Override Guards** | `backend/src/platform/identity/{request-identity-store.ts,server-identity-resolver.ts}` | Resolve `userId` exclusively from server `RequestIdentityStore`; enforce `assertNoClientOverrides` on HTTP requests. | Never trust client-supplied `userId`, `apiKey`, `model`, or provider endpoint URLs. |
| **AES-256-GCM Secret Cipher & AAD** | `backend/src/platform/crypto/calendar-secret-cipher.ts`, `backend/src/admin-config/credential-service.ts` | Encrypt per-user provider API keys, OAuth `access`/`refresh` tokens, and PKCE verifiers with `EncryptionBootstrap` + AAD bound to `{ version, userId, provider, connectionId, credentialVersion, tokenKind }`. | Never log, trace, return, or store plaintext secrets (`credentials` never leave server). Reuse `AURVIN_CONFIG_ENCRYPTION_KEY`; do not reuse `admin-config` credential table (admin-wide only). |
| **OAuth Cookie, PKCE & Single-Use State** | `backend/src/plugins/google-calendar/{oauth.ts,oauth-http.ts}`, `backend/src/contracts/calendar-connections.ts` | Reuse `HttpOnly; SameSite=Lax` browser binding cookie hash (`browserHash`), SHA-256 `stateHash`, encrypted PKCE verifier, 10-minute TTL (`600_000 ms`), single-use CAS `consumeState`, and `redirect: 'error'` on token exchanges. | Note: Web Search OAuth supports the MCP SDK `OAuthClientProvider` (DCR/PKCE `S256`) rather than Google OIDC `id_token` verification. |
| **Manageable Config (Super-Admin Limits)** | `backend/src/contracts/{admin-config.ts,admin-config-wire.ts,config-runtime.ts}`, `backend/src/platform/config/manageable-config.ts`, `frontend/src/features/admin-config/{AdminDashboard.tsx,ConfigFields.tsx}` | Add `webSearch: { maxSearchesPerTurn: 5, maxFetchesPerTurn: 5 }` to `manageableSettingsSchema`, `ADMIN_CONFIG_FIELD_PATHS`, and `RuntimeConfigSnapshot`. | Admin Config is `super-admin`-only (`AdminDashboard.tsx`). Per-user enablement and provider credentials **must not** live here. |
| **Per-User Personalization / Warm Cache** | `backend/src/personalization/personalization.service.ts`, `backend/src/persistence/personalization.ts`, `backend/src/app.service.ts` (`prepareOwner`) | Follow `personalization`’s in-memory `Map<userId, State>` + explicit `warm(userId)` / `evict(userId)` pattern: `prepareOwner` warms memory once on `/api/*` admission; chat turns read synchronously from memory (`0` DB calls). | On `/api/sessions/:id/turns`, `configurePrivateHttp` runs `prepareOwner`; when already prepared in memory, `prepareOwner` must perform **0 DB calls** and **never** perform MCP connect/discovery or OAuth refresh. |
| **OpenRouter Tool Gating & `:web` Disable** | `backend/src/model/policy.ts`, `backend/src/model/catalogue.ts`, `backend/src/model/openrouter-adapter.ts` | `policy.ts` already sets `{ id: 'web', enabled: false }` on `ChatOpenRouter` plugins, preventing unintended OpenRouter web search. Extend `VerifiedModelLimits` in `contracts/config-runtime.ts` with top-level `tools: boolean` from `catalogue.ts`. | Do not gate `web_tool` on `modelLimits.calendar?.tools`; Calendar might be disabled or evolved independently. |
| **JSON Safety, Stream Parsing & Repair Pattern** | `backend/src/model/{strict-json.ts,calendar-stream.ts,calendar-validation.ts,calendar-repair.ts}` | Reuse `scanJsonObject` (byte size, nesting depth, duplicate-key detection, control/forbidden-key checks), streaming `delta.tool_calls` assembly, bounded diagnostics (`repairInstruction`), and `assertNativeHistory` group preservation. | Do not share Calendar's `activate_skill`/`show_canvas`/`CALENDAR_LIMITS` names or Calendar ledger/mutation barriers; keep web repair minimal and focused on `web_tool`. |
| **Shared Text/Voice Execution & Cancel** | `backend/src/chat-runtime/{memory-text.ts,durable-chat-runtime.ts}`, `backend/src/agent/turn-graph.ts`, `backend/src/voice/agent/agent-voice-adapter.ts`, `backend/src/persistence/memory-text-archive.ts` | Hook web-tool loop into `MemoryText.execute` (which handles both text `!c.live` and voice `c.live`), propagate `job.signal` / voice `cancelLiveTurn` into MCP `AbortSignal`, emit activity/sources via stream & `c.live`, and persist bounded transcript provenance via `MemoryTextArchive`. | Search/fetch are **read-only**: do **not** add Calendar mutation barriers or pre-effect DB writes. |
| **Safe URL & Markdown Presentation** | `frontend/src/features/chat/markdown/sanitize-url.ts`, `frontend/src/components/MessageItem.tsx`, `frontend/src/features/plugins/google-calendar/GoogleCalendarPanel.tsx` | Reuse `GoogleCalendarPanel` card/disclosure layout on Plugins tab (`AdminDashboard.tsx`); render clickable source links verified `http:`/`https:` on both backend and `sanitizeUrl` in `MessageItem.tsx`. | `sanitizeUrl` also allows `mailto:` and relative paths; web source links must strictly allow only `http:` and `https:`. |

---

## 3. Five-Provider Hosted MCP & Authorization Matrix

Fixed provider priority (non-editable in Phase 1): **`TinyFish` → `Keenable` → `Exa` → `Tavily` → `Firecrawl`**.  
Anonymous/keyless tiers (`api.keenable.ai/mcp-public`, `mcp.exa.ai` without credentials, `X-Tavily-Access-Mode: keyless`, `mcp.firecrawl.dev/v2/mcp` without auth) are **explicitly forbidden** by `goal.md` and must never be called.

### 3.1 Protocol, Endpoints, Auth & Compatibility Comparison

| Provider | Hosted MCP URL (Verified Docs) | Transport | MCP API-Key Auth | MCP Browser OAuth Auth | OAuth Specs (DCR / PKCE / Audience / Callback / Refresh) | Doc vs. Tested Status |
| --- | --- | --- | --- | --- | --- | --- |
| **1. TinyFish** | `https://agent.tinyfish.ai/mcp` *(community mirrors also cite `mcp.tinyfish.ai`)* | Streamable HTTP | **Unconfirmed on hosted MCP.** Primary docs assign `X-API-Key` to REST (`agent.tinyfish.ai/v1/*`, `api.search.tinyfish.ai`, `api.fetch.tinyfish.ai`) & stdio `tinyfish-mcp`, and **OAuth 2.1** to hosted MCP. | Documented **OAuth 2.1** on hosted MCP (`agent.tinyfish.ai/mcp`). | **Incomplete public spec:** Public docs mention browser login flow (e.g. `accounts.tinyfish.ai`), but do **not** publish standalone `.well-known` metadata paths, DCR endpoint, `redirect_uri` rules, `resource`/audience, or refresh token policy. | Documented only; **0 live tests**. **Blocker:** API-key-over-MCP unconfirmed; OAuth DCR/refresh details unpublished. |
| **2. Keenable** | `https://api.keenable.ai/mcp` (API key) <br>`https://api.keenable.ai/mcp-oauth` (OAuth) | Streamable HTTP | **Supported:** `X-API-Key: keen_<key>` or `Authorization: Bearer keen_<key>`. | Documented at `https://api.keenable.ai/mcp-oauth` (plus CLI `keenable login` device flow). | **Partial public spec:** Docs describe MCP OAuth / PKCE & refresh flow for `/mcp-oauth` (auth UI via `app.keenable.ai`), but do **not** publish explicit `.well-known` / DCR URLs, `redirect_uri` restrictions, or refresh lifetime rules. | Documented only; **0 live tests**. API-key MCP documented cleanly; `/mcp-oauth` DCR/loopback **unverified live**. |
| **3. Exa** | `https://mcp.exa.ai/mcp` <br>*(OAuth trigger: `?login` or `/mcp/oauth`)* | Streamable HTTP | **Supported:** `x-api-key: <key>`, `Authorization: Bearer <key>`, or `?exaApiKey=<key>` *(Aurvin must use header only, never URL query param)*. | Documented (`https://mcp.exa.ai/mcp/oauth`, `?login`, Okta EMA `auth.exa.ai`). | **Partial public spec:** Supports MCP client OAuth login (links Google/email to Exa account), but public docs do **not** explicitly guarantee RFC 7591 DCR URLs, loopback redirect URI allowlist, or refresh rotation semantics. | Documented only; **0 live tests**. API-key header documented cleanly; OAuth DCR/refresh **unverified live**. |
| **4. Tavily** | `https://mcp.tavily.com/mcp/` | Streamable HTTP | **Supported:** `Authorization: Bearer tvly-...` or `?tavilyApiKey=...` *(Aurvin must use `Authorization: Bearer` header only)*. | Documented against `https://mcp.tavily.com/mcp/` (redirects to `app.tavily.com` to select/link account). | **Partial public spec:** Uses browser OAuth account linking back to `app.tavily.com`; public docs do **not** publish standalone DCR, `redirect_uri` allowlist, audience, or refresh token rotation details. | Documented only; **0 live tests**. `Bearer` API-key header documented cleanly; OAuth DCR/refresh **unverified live**. |
| **5. Firecrawl** | `https://mcp.firecrawl.dev/v2/mcp` (API key) <br>`https://mcp.firecrawl.dev/v2/mcp-oauth` (OAuth) | Streamable HTTP | **Supported:** `Authorization: Bearer fc-...` on `/v2/mcp`. | Documented on `/v2/mcp-oauth` (team selection consent screen). | **Fully documented OAuth 2.1:** Discovery `https://www.firecrawl.dev/.well-known/oauth-authorization-server`; Authorize `/api/oauth/authorize`; Token `/api/oauth/token`; DCR `/api/oauth/register` (RFC 7591, `token_endpoint_auth_method: "none"`); Revoke `/api/oauth/revoke`; `resource`: `https://api.firecrawl.dev/`; PKCE **`S256` required**; scopes `firecrawl:global` + `offline_access`; access token `fco_` (1h); refresh token `fcr_` (90d single-use). Redirect URI localhost vs HTTPS policy not explicitly detailed in summary. | Documented only; **0 live tests**. Best-specified OAuth 2.1 + Bearer API-key provider. |

### 3.2 Actual Search & Fetch MCP Tool Names, Arguments, and Result Shapes

Because MCP servers return tools dynamically via `tools/list`, P2 **must enforce a static provider-keyed allowlist** and normalize inputs/outputs behind one adapter interface—never exposing other provider tools (such as TinyFish `run_web_automation`/`create_browser_session`/`get_wallet`, Exa `agent_run`, or Firecrawl `firecrawl_crawl`/`firecrawl_interact`) to the model or caller.

| Provider | Allowlisted Browse (Search) Tool | Search Args Passed by Aurvin | Expected Search Result Shape (MCP `content`/`structuredContent`) | Allowlisted Fetch (Read) Tool | Fetch Args Passed by Aurvin | Expected Fetch Result Shape |
| --- | --- | --- | --- | --- | --- | --- |
| **TinyFish** | `search` *(or `tiny_search` / `tinyfish_search` — verify canonical `tools/list` name in live/sandbox fixture)* | `{ query }` | Text/JSON containing ranked items: `position`, `title`, `url`, `site_name`, `snippet` | `fetch_content` *(or `tiny_fetch` / `tinyfish_fetch` — some docs label `Fetch URLs`)* | `{ urls: [url] }` *(or `{ url }` per discovered `inputSchema`)*, markdown/text | Extracted clean Markdown/text + optional `page_metadata`, `links` |
| **Keenable** | `search_web_pages` | `{ query, max_results: 5, snippet_max_length: 320 }` | JSON/text array with `title`, `url`, `snippet`, optional publication/acquisition timestamps | `fetch_page_content` | `{ url, live: true }` *(falls back / indexed behavior server-side)* | Structured object / text with `title` and clean Markdown `content` |
| **Exa** | `web_search_exa` | `{ query, numResults: 5 }` *(per MCP schema)* | Clean text/Markdown or structured items with `title`, `url`, highlights/snippets | `web_fetch_exa` | `{ url }` *(or `[url]` per schema)* | Full page text formatted as clean Markdown + URL/title metadata |
| **Tavily** | `tavily-search` | `{ query, search_depth: 'basic', max_results: 5 }` | Structured JSON text with `results: [{ title, url, content, score }]` | `tavily-extract` | `{ urls: [url], extract_depth: 'basic' }` | Structured JSON text with extracted clean text/Markdown per URL + `url` |
| **Firecrawl** | `firecrawl_search` | `{ query, limit: 5 }` *(omit `scrapeOptions` so browse stays search-only)* | Titles, descriptions, `url`s, and search snippets *(without full-page inline crawl)* | `firecrawl_scrape` | `{ url, formats: ['markdown'], onlyMainContent: true, blockAds: true, storeInCache: false }` | Clean Markdown body + page `metadata` (`title`, `sourceURL`, etc.) |

*Adapter tolerance note*: MCP `tools/call` returns `content: Array<{ type: 'text', text: string } | ...>` and optional `structuredContent`. P2's normalizer must parse JSON from `structuredContent` or JSON-encoded `text`, fall back cleanly to bounded plain-text/Markdown parsing where providers return Markdown text (notably Exa), require non-empty useful content (`title`/`url`/`snippet` for browse; non-empty body for fetch) so empty/blocked shells count as unusable results eligible for fallback, and verify returned `url`s are valid public HTTP(S) URLs.

### 3.3 Concise Key-Creation Instructions & Official Dashboards

1. **TinyFish** — [https://agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys)
   - Sign in at `agent.tinyfish.ai`, open **API Keys**, click **Create API Key**, and copy it immediately (shown once).
   - *Compatibility warning to show in UI if unverified*: TinyFish documents OAuth 2.1 on hosted MCP (`agent.tinyfish.ai/mcp`) and `X-API-Key` on REST APIs; API-key MCP support is pending verification.
2. **Keenable** — [https://app.keenable.ai](https://app.keenable.ai)
   - Sign in to the Keenable console, open **API Keys**, generate a `keen_...` key, and paste it into Aurvin.
3. **Exa** — [https://dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys)
   - Sign in at `dashboard.exa.ai`, navigate to **API Keys**, click **Create API Key**, and paste it into Aurvin.
4. **Tavily** — [https://app.tavily.com](https://app.tavily.com)
   - Sign in at `app.tavily.com`, open **API Keys** on the dashboard Overview, copy or create your `tvly-...` key, and paste it into Aurvin.
5. **Firecrawl** — [https://www.firecrawl.dev/app/api-keys](https://www.firecrawl.dev/app/api-keys)
   - Sign in at `firecrawl.dev`, open **API Keys** in the app dashboard, copy or create an `fc-...` key, and paste it into Aurvin (or use **Connect with Browser** for `/v2/mcp-oauth`).

### 3.4 Public-URL, Redirect, Privacy, and Billing Limitations

| Concern | Documented Provider Behavior & Verified Gaps | Aurvin Boundary Enforcement Required |
| --- | --- | --- |
| **SSRF & Redirects** | Hosted SaaS execution for TinyFish, Keenable, Exa, Tavily, and Firecrawl runs inside vendor cloud infrastructure (not on Aurvin's local network). However, **none of the five providers publicly guarantees strict destination IP filtering or redirect-hop blocking inside its remote scraper**, and Aurvin cannot observe intermediate HTTP `301`/`302` hops executed inside a provider's remote browser. | 1. **Pre-call URL guard (`fetch` input & tool arguments)**: allow strictly `http:`/`https:` with public FQDN or public IP only; reject credentials (`user:pass@`), ports restricted or unusual if desired (standard 80/443 or any public port — recommend allowing only explicit `80`/`443` or omitted port to block internal service probing), `localhost`, `.localhost`, `.local`, `.internal`, `.home.arpa`, single-label hosts, and all loopback, RFC 1918 private, CGNAT `100.64.0.0/10`, link-local/cloud metadata (`169.254.0.0/16`, `fe80::/10`), ULA (`fc00::/7`), unspecified, multicast, or IPv4-mapped IPv6 literals.<br>2. **Aurvin outbound guard**: Aurvin connects **only** to the 5 hardcoded MCP/OAuth origins; OAuth token/metadata HTTP calls enforce `redirect: 'error'` and exact origin checks.<br>3. **Honest doc note**: State explicitly in `operations.md` and setup disclosure that remote provider-side redirects after initial URL handoff are outside Aurvin's inspection. |
| **Privacy & Data Retention** | Queries and fetched URLs leave Aurvin for third-party provider servers. Keenable logs queries/URLs/timestamps on standard tiers; Exa, Tavily, and Firecrawl retain request metadata/logs under standard tiers unless Enterprise Zero Data Retention (ZDR) is contracted (Firecrawl also supports `storeInCache: false`, which Aurvin should pass on `firecrawl_scrape`). **Fallback sends the same query or URL to the next connected provider on failure.** | Show a clear setup disclosure covering third-party query/URL transmission, credit use, and fallback disclosure. Forward **only** `query` or `url`—never chat history, Calendar data, user PII, or Aurvin credentials. |
| **Billing, Free Tiers & Account Attribution** | - **TinyFish**: TinySearch (`~30/min, 500/hr`) & TinyFetch (`~150 URLs/min, 1000/day`) documented free even at `$0` wallet; automation/browser sessions metered from wallet.<br>- **Keenable**: `100,000` free req/mo developer tier, then `$4 / 1k` requests (keyless restricted/prohibited here).<br>- **Exa**: Starter free credits, then PAYG (`~$4–7 / 1k` searches, `~$1 / 1k` contents).<br>- **Tavily**: `1,000` free credits/mo, then subscription/PAYG (`1` credit basic search, `1` credit per 5 basic URLs).<br>- **Firecrawl**: `1,000` credits/mo free (some plans `500` one-time onboarding credits), `2` credits / 10 search results, `1` credit / basic scrape. | Aurvin maps each connected user account's own key/OAuth token (no shared admin search key), sets `search_depth: 'basic'` / `extract_depth: 'basic'` and omits `scrapeOptions` on search to avoid surprise credit burn, never auto-buys credits or enables keyless fallback, and fails cleanly on `402`/`403`/`429` (`PROVIDER_CREDITS` / `RATE_LIMITED`) allowing priority fallback to the next **user-connected** provider. |

---

## 4. Minimal Implementation Behind One `web_tool`

### 4.1 Model-Facing Tool Definition (`P1` Contract + `P3` Dispatch)

Expose **at most one** tool named `web_tool` in OpenRouter `tools` **only when all three conditions hold at initial turn execution**:
1. `webSearchState.enabled === true` in memory for this user,
2. `webSearchState.eligibleProviders.length > 0` in memory (at least one provider connected with usable/non-revoked status),
3. `snapshot.modelLimits?.tools === true` (`catalogue.ts` confirms the configured model supports `tools`).

Otherwise omit `web_tool` completely from `tools`.

**Recommended JSON Schema (sent to OpenRouter) — Flat Strict Object + Server `.superRefine`:**
Many OpenRouter providers reject or mis-parse top-level `oneOf`/`anyOf` in function tool parameters. Use a single flat strict object JSON Schema paired with Zod `.superRefine` validation:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["mode"],
  "properties": {
    "mode": {
      "type": "string",
      "enum": ["browse", "fetch"],
      "description": "Use 'browse' to search the public web for a query, or 'fetch' to read one public web page URL."
    },
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 400,
      "description": "Required when mode is 'browse'. Must be omitted when mode is 'fetch'."
    },
    "url": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2048,
      "description": "Required public http(s) URL when mode is 'fetch'. Must be omitted when mode is 'browse'."
    }
  }
}
```

Backend schema check (`webToolArgumentsSchema` in `P1`) enforces:
- `scanJsonObject` safety (JSON object, max depth `4`, max raw argument bytes `4_096`, no duplicate keys, no `__proto__`/`constructor`/`prototype`).
- Strict keys (`mode`, optional `query`, optional `url`).
- If `mode === 'browse'`: trimmed non-empty `query` (`1..400` chars) required; `url === undefined`.
- If `mode === 'fetch'`: non-empty `url` (`1..2048` chars) required; `query === undefined`; parsed via `URL` + public HTTP(S) IP/host validation (separating *malformed syntax* -> schema error vs *private/forbidden URL* -> non-repairable URL-safety denial).

### 4.2 Fixed Priority, Eligibility & Fallback State Machine (`P2`)

- Order is fixed: `['tinyfish', 'keenable', 'exa', 'tavily', 'firecrawl']`.
- **Eligible** means: connected for `userId`, capability supports requested mode (`browse` vs `fetch`), and not marked terminally revoked/disconnected (`status === 'connected'` and not flagged disabled during turn). An expired OAuth access token with a stored refresh token remains eligible until its post-dispatch refresh attempt fails inside the tool call.
- **One attempt per eligible provider per logical call**:
  - `web_tool` call increments logical budget (`searchesUsed` or `fetchesUsed`) once **after** passing admission, schema, URL-safety, and budget checks (invalid schema & safety rejections consume **0** browse/fetch budget).
  - Iterate eligible providers in fixed priority order within `webPerLogicalCallBudgetMs` and shared `webTurnDeadlineMs`.
  - Reuse cached MCP `Client` + transport per `(userId, provider, credentialVersion)` when already open in memory; otherwise connect lazily (`webMcpConnectTimeoutMs`) **during tool execution only**.
  - **Fallback triggers** (try next eligible provider): HTTP `401`/`403` (after at most 1 bounded OAuth refresh attempt if OAuth + refresh token present), `402` quota/credits exhausted, `429` rate limit, `5xx`, MCP/transport error, connect/call timeout, or empty/unusable tool payload.
  - **Non-fallback terminations** (return immediately, try no further providers): web search turned off mid-turn, provider disconnected mid-turn causing 0 remaining eligible providers, turn cancellation / AbortSignal / voice interruption, turn browse/fetch budget exhausted, or shared web/turn deadline expired.
  - Before **every** provider attempt, recheck `assertWebAllowed(userId)` in memory and `signal.aborted`; invalidate cached MCP transport whenever credentials rotate, disconnect, or user toggles web off.

---

## 5. Memory-First Integration Seams (Text, Voice & Lifecycle)

### 5.1 Zero Pre-Model I/O Path (`AC6` / `AC7`)

```
HTTP /api/plugins/web-search/*  (setup / toggle / OAuth callback / disconnect)
   └─ updates Mongo (encrypted) + synchronously mutates in-memory WebSearchRegistry.set(userId, state)
      and closes stale MCP transport sessions

HTTP /api/* admission (configurePrivateHttp.ts -> AppService.prepareOwner)
   ├─ if WebSearchRegistry.isPrepared(userId) === true  ==> 0 DB calls, 0 MCP/OAuth calls
   └─ if cold (process restart / first request): loads encrypted metadata into memory ONLY
      (NEVER calls remote MCP connect/listTools or OAuth refresh)

POST /api/sessions/:id/turns  OR  Voice turn (AgentVoiceAdapter -> DurableChatRuntime.submitLiveTurn)
   ├─ MemoryText.submit(): reads WebSearchRegistry.snapshotFor(userId) synchronously from memory (0 DB)
   └─ MemoryText.execute():
        1. Initial OpenRouter model request dispatched directly with [web_tool] (if enabled+eligible+tools)
           ==> ZERO DB read/write, ZERO MCP init/discovery, ZERO probe, ZERO OAuth refresh before 1st model call
        2. Only IF model emits web_tool call:
           -> memory checks (enabled, budget, deadline, cancel) -> URL safety -> MCP connect/refresh/call
        3. Loop follow-up OpenRouter dispatches read purely from in-memory message groups (0 DB wait)
        4. On terminal turn completion/fail/cancel:
           -> MemoryTextArchive schedules single consolidated async save (turn + bounded sources + activity)
           -> Next turn is immediately admissible in memory without waiting for save completion
```

### 5.2 Exact Integration Files in Aurvin

- **Composition (`P3` in `backend/src/app.service.ts` & `app.module.ts`)**:
  - Register `WebSearchModule` in `AppModule`.
  - Wire `WebSearchPort` into `AppService`: call `webSearch.warmOwner(userId)` inside `prepareOwner(principal)` alongside `personalization.warm` (no-op once cached in memory), register `webSearch.evict(userId)` on `logout`/`onUserDeactivated`, and close active MCP transports inside `operations` graceful shutdown (`stopWebSearch()`/`drainWebSearch()`).
- **Text & Voice Shared Loop (`P3` in `backend/src/chat-runtime/memory-text.ts`)**:
  - Currently `MemoryText.execute` (`lines 1413-1668`) branches on `if (snapshot.modelLimits?.calendar?.tools)` (`CalendarLoop`) vs `else` (single `OpenRouterAttemptAdapter.stream` via `buildTurnGraph`).
  - Rather than coupling into `CalendarLoop` or duplicating `DurableChatRuntime`, extract/wire a lightweight bounded `WebToolLoop` (or `turn-graph` `web_decide` -> `web_execute` -> `seal` branch, selected when `!calendarEnabled && snapshot.modelLimits?.tools && snapshot.webSearch?.enabled && e.webSearch?.eligible` — **and** ensure if Calendar + Web are ever active simultaneously, research flags multi-tool coexistence if needed, though Phase 1 Calendar critical-path tests must stay isolated from Web Search changes). Keeping a dedicated `WebLoop` invoked cleanly from `MemoryText.execute` when Calendar is not handling the turn guarantees **zero behavior change** to Calendar's `CalendarLoop`, `MemoryCalendarLedger`, `ensureMutationAccepted`, and required Calendar regression cases.
- **Voice Adapter (`P3` in `backend/src/voice/agent/agent-voice-adapter.ts` & `contracts/stream.ts` / `voice-wire.ts`)**:
  - `AgentVoiceAdapter` already delegates turn execution to `runtime.submitLiveTurn` / `runtime.executeTurn` (`MemoryText`) and cancels via `runtime.cancelLiveTurn` on barge-in/disconnect (`job.signal`).
  - Pass concise live status/activity & source references through `LiveExecution` (just like `artifact` or a dedicated optional `webActivity` / `sources` hook on `LiveExecution` in `chat-runtime/ports.ts`) so text SSE `/stream` and voice clients surface bounded search/fetch activity and clickable sources consistently.
- **Live Permission Invalidation & Disconnect Races**:
  - Keeping `WebSearchRegistry` shared in memory by reference (checked dynamically before each `web_tool` dispatch and before emitting late results) ensures toggling Web Search **off** or disconnecting a provider in another tab immediately stops subsequent tool calls in an already-running turn and aborts active MCP `AbortController`s.
  - Because `MemoryText.submit` freezes the `tools` list for the initial request at turn start, if Web Search is enabled mid-turn it takes effect on the next turn; if Web Search is disabled mid-turn while the model emits `web_tool`, backend rejects execution cleanly with a deterministic non-repairable permission tool result (`"Web search is disabled for this account"`) and aborts any in-flight MCP HTTP call.

---

## 6. Recommended Finite Deadlines, Budgets & Content Bounds

All limits below are calibrated against `DEFAULT_BUDGETS` (`maxContextTokens = 16_384`, `maxOutputTokens = 2_048`, `modelMarginTokens = 1_024`, `usableHistoryTokens = 13_312`, `maxMessageBytes = 65_536`, `totalRunTimeoutMs = 180_000`, `connectTimeoutMs = 10_000`, `idleStreamTimeoutMs = 20_000`, `persistenceTimeoutMs = 15_000` in `backend/src/contracts/budgets.ts`):

| Parameter | Recommended Value | Rationale / Owner |
| --- | --- | --- |
| **`webSearch.maxSearchesPerTurn`** | Default **`5`**, Admin-editable int **`1..20`** | Required default `5` (`goal.md`); `1..20` prevents runaway loops on `/config` (`P1` contracts + `manageableSettingsSchema`). |
| **`webSearch.maxFetchesPerTurn`** | Default **`5`**, Admin-editable int **`1..20`** | Required default `5` (`goal.md`); independent counter from searches (`P1`). |
| **`maxSchemaRepairAttemptsPerTurn`** | Fixed **`3`** (not editable) | `1` initial attempt + up to `3` additional repair model attempts per accepted turn (`goal.md`, `P1`/`P3`). |
| **`maxModelAttemptsPerTurn`** | Derived **`1 + maxSearchesPerTurn + maxFetchesPerTurn + 3 + 1`** (capped `<= 45`) | Prevents unbounded looping if a model alternates partial answers (`15` under `5/5` defaults). |
| **`maxProviderFallbackAttemptsPerCall`** | Max **`1` per eligible provider** (at most `5` per logical call) | Guarantees finite provider traversal in priority order; retries do not grant extra logical budget (`P1`/`P2`). |
| **`webMcpConnectTimeoutMs`** | **`4_000 ms`** | Fast fail for unreachable MCP endpoints (`<= connectTimeoutMs 10_000`, `P1`/`P2`). |
| **`webProviderCallTimeoutMs`** | **`12_000 ms`** (includes at most 1 bounded `<= 4_000 ms` OAuth token refresh) | Covers remote headless-browser fetches (TinyFetch/Firecrawl) while bounding stall per provider (`P1`/`P2`). |
| **`webLogicalCallTimeoutMs`** | **`25_000 ms`** | Caps total fallback wait across up to 5 providers for one logical `browse` or `fetch` (`P1`/`P2`). |
| **`webTurnDeadlineMs`** | **`45_000 ms`** (also bounded by remaining `RunDeadlines` total run budget `180_000 ms`) | Preserves responsive interactive text & voice UX without hitting idle/run limits (`P1`/`P3`). |
| **`maxMcpWireResponseBytes`** | **`524_288` bytes (512 KiB)** | Custom `fetch` stream cap protecting Node memory against giant provider responses (`P2`). |
| **`browse` bounds** | `query <= 400` chars; `results <= 5` items/call; `title <= 160` chars; `url <= 1024` chars; `snippet <= 320` chars; **serialized tool result <= `2_400` UTF-8 bytes** | Fits even 2–3 searches inside default 16K context alongside system instructions & history (`P1`/`P2`). |
| **`fetch` bounds** | `url <= 2048` chars; `title <= 160` chars; `content <= 4_000` chars; **serialized tool result <= `4_600` UTF-8 bytes** | ~600–800 words of clean Markdown; leaves room in `13_312`-token default `usableHistoryTokens` without dropping history (`P1`/`P2`). |
| **`maxTurnWebEvidenceBytes`** | **`24_000` bytes** hard cap **AND** dynamic check against remaining `usableHistoryTokens` headroom (`reserve >= 1_024` tokens for synthesis) | Larger `maxContextTokens` models can use all 5+5 calls up to 24 KB; 16K models stop cleanly with a clear budget limit rather than dropping history (`P1`/`P3`). |
| **`maxSourcesPerMessage`** | **`15`** refs, each `{ title <= 160, url <= 1024, provider, kind: 'browse' \| 'fetch' }`, total provenance <= **`12_000` bytes** | Easily fits inside `DEFAULT_BUDGETS.maxMessageBytes = 65_536` (`P1`). |
| **`oauthStateTtlMs`** | **`600_000 ms`** (10 min) | Matches `calendar-connections.ts` `oauthStateSchema` (`P1`/`P2`). |

---

## 7. Three-Retry Schema Repair Loop Semantics (`AC3`)

Modelled closely on `backend/src/model/{calendar-validation.ts,calendar-repair.ts,strict-json.ts}`, simplified for one tool:

1. **Classification boundary**:
   - **Enters repair loop**: JSON parse failure on `tool_calls[].arguments`, duplicate JSON key / scan error (`scanJsonObject`), wrong/unknown tool name while `web_tool` is active, multiple `web_tool` (or mixed) calls in one batch when cardinality is constrained to 1 sequential call (or per-invalid call handling — **recommended: `parallel_tool_calls: false` / enforce max 1 `web_tool` call per decision**, keeping tool-group linkage identical to Calendar!), extra/unknown property, invalid `mode`, missing/empty `query` on `browse`, `url` supplied on `browse`, missing `url` on `fetch`, `query` supplied on `fetch`, or unparseable URL syntax.
   - **Never enters repair loop**: Web disabled mid-turn, zero connected providers, **URL-safety/SSRF denial** (valid URL syntax pointing to `127.0.0.1`, `169.254.169.254`, private subnet, or `ftp:`/`file:` scheme), `browse`/`fetch` logical budget exhausted, turn/web deadline exhausted, cancellation/barge-in, or provider HTTP/MCP failure. Return an immediate non-repairable tool result (or fail/continue synthesis honestly) without consuming repair attempts.
2. **Shared per-turn repair budget (`3`)**:
   - Track `schemaRepairsUsed` (`0..3`) on the accepted turn execution state (never reset across modes, iterations, or providers).
   - Every invalid `web_tool` emission while `schemaRepairsUsed < 3` AND remaining `maxModelAttemptsPerTurn` / `totalRunTimeoutMs` / `usableHistoryTokens` permit:
     - Increments `schemaRepairsUsed += 1`.
     - Consumes **0** `browse`/`fetch` logical calls and dispatches **0** MCP requests.
     - Reconstructs model messages preserving all completed `[assistant, tool]` pairs intact (**no replay** of previously succeeded tool calls!) + injects a concise system/repair note (`<= 1,500` chars) stating the exact invalid field paths, why it failed, and the **full canonical `web_tool` JSON Schema again**, while keeping `tools: [WEB_TOOL_DEFINITION]` intact on the OpenRouter request.
   - When `schemaRepairsUsed === 3` and the model emits a 4th invalid call (or if context/run/model budget runs out first):
     - Stop schema repair immediately. Do **not** exceed overall deadlines or token budgets to squeeze in retries.
     - Either supply one terminal synthetic non-executable outcome instructing the model to answer honestly that tool formatting failed without inventing sources (only if output budget permits) or end cleanly with an explicit ungrounded-verification failure notice.

---

## 8. Dependency Recommendation

- **Does an installed dependency suffice?** **No.** `backend/package.json` and `backend/package-lock.json` currently contain `@langchain/core`, `@langchain/langgraph`, `@langchain/openrouter`, `mongodb`, `undici` (`^6.29.0`), `zod` (`^3.25.32`), and NestJS/Socket.IO packages—none implement MCP JSON-RPC `initialize`, session negotiation (`Mcp-Session-Id`), Streamable HTTP/SSE framing, or MCP OAuth metadata discovery (`RFC 9728` + `RFC 8414` + `RFC 7591` DCR + `PKCE`).
- **Minimum new package (`P1` owns `backend/package.json` & `backend/package-lock.json`)**:
  - Add **`@modelcontextprotocol/sdk`** (latest stable **`1.x`** resolved and pinned in `backend/package.json` and `backend/package-lock.json` during P1).
  - Why `@modelcontextprotocol/sdk@1.x`?
    1. **Zod pin alignment**: `backend/src/platform/dependency-pins.spec.ts` asserts `zod === '^3.25.32'`. The `1.x` line supports `zod ^3.25` via its internal compatibility layer, avoiding a forced upgrade to Zod v4 across the entire repo (note: verify during `P1` `npm ci` + `tsc` that no nested duplicate `zod` triggers `TS2589` and add an `overrides` check only if lockfile inspection shows duplication).
    2. **Modular subpath exports without protocol bloat**: Import only `@modelcontextprotocol/sdk/client/index.js`, `@modelcontextprotocol/sdk/client/streamableHttp.js`, optional `@modelcontextprotocol/sdk/client/sse.js` fallback, and `@modelcontextprotocol/sdk/client/auth.js` (`OAuthClientProvider`, `UnauthorizedError`).
    3. **Custom `fetch` injection**: `StreamableHTTPClientTransport` accepts `{ fetch, requestInit, authProvider }`, letting P2 wrap Node/`undici` `fetch` with per-call `AbortSignal`, origin allowlisting, `512 KiB` body limits, and `X-API-Key`/`Authorization` injection without reimplementing SSE or JSON-RPC.
  - **No** additional frontend dependency is needed.

---

## 9. Verification Strategy & P1–P5 Ownership Reconciliation

### 9.1 Recommended Focused Deterministic Checks (Zero Live Calls)

| Plan | Required Deterministic Checks |
| --- | --- |
| **P1** | Contract schema tests: `web_tool` strict `browse`/`fetch` exclusivity, URL syntax vs SSRF safety boundary, default `5/5` limits + `1..20` validation, `maxSourcesPerMessage` / payload bounds, `VerifiedModelLimits.tools`, source/activity SSE event schemas, zero secret fields in public wire schemas; run `dependency-pins.spec.ts` + `npm run build` + `npm run lint`. |
| **P2** | In-process/mock-transport MCP tests (using `StreamableHTTPClientTransport` custom `fetch` stubs — no live network): all 5 providers' tool-name allowlists (`tools/list` filtering out browser/wallet/crawl tools), arg translation, API-key header placement (never URL query string), OAuth state/cookie/PKCE/DCR/token rotation/expiry/denial/callback mismatch, TinyFish auth-gap failure behavior, ordered fallback without anonymous fallback, disabled mid-call abort, encrypted Mongo persistence (and `integration_connections` non-collision), private/loopback/metadata IP rejection. |
| **P3** | Shared runtime text (`MemoryText`) & voice (`AgentVoiceAdapter`) tests with instrumented persistence & mock MCP/OpenRouter: **0 DB ops and 0 MCP/OAuth calls before initial model dispatch** (cold vs warm `prepareOwner` behavior documented and tested); `web_tool` omitted when off / 0 connected / non-tool model; `3`-retry shared schema repair (canonical schema re-shown, 0 provider calls, prior valid tool groups preserved without replay, non-repairable exclusions); non-blocking async `MemoryTextArchive` saves & immediate follow-ups; `totalRunTimeoutMs` / `webTurnDeadlineMs` / barge-in cancellation; plus all required **Calendar critical-path regression checks** untouched/green. |
| **P4** | Frontend Vitest (`src/**/*.test.ts`) + React render/state fixture tests: 5 provider cards in fixed priority order, concise key instructions & external links, API-key save/replace/disconnect, browser OAuth popup/redirect cancellation & error display, global toggle default-off & gated until connected, no composer toggle, `/config` `5/5` limits, clickable `https:` source pills (`sanitizeUrl` rejects `javascript:`/`data:`), concise search/fetch/fallback status, no secret in DOM/`localStorage`/`VITE_*`. |
| **P5** | Full `backend` (`build`, `lint`, `test`, `test:e2e`, `AURVIN_TEST_MONGODB_URI` isolated DB tests if supplied) + `frontend` (`build`, `lint`, `test`), latency overhead baseline vs live disclaimer, operational runbook (`operations.md`, staging notes on SSRF/redirects/OAuth callbacks), `verification.md`, and `final_report.md` recording review as **skipped**. |

### 9.2 Reconciled P1–P5 Ownership & Dependencies (`docs/web-search/state.md` Updates Recommended)

Research identified **four minor ownership ambiguities** in `docs/web-search/state.md` that the orchestrator should reconcile before dispatching `P1`–`P4` (dependency DAG `R -> P1 -> {P2, P4}`, `P2 -> P3`, `{P3, P4} -> P5` remains sound and unchanged):

1. **P1 contract extensions in existing `backend/src/contracts/` files**:
   - Currently `state.md` lists only "New backend `contracts/web-search*.ts`" + `admin-config*.ts` + `config-runtime*.ts` for P1.
   - **Reconcile**: P1 must also own narrow, additive edits to:
     - `backend/src/contracts/collections.ts` (add dedicated `webSearchConnections: 'web_search_connections'` so P2 never collides with Calendar's `(userId, provider)` unique index on `integration_connections`),
     - `backend/src/contracts/config-runtime.ts` (add top-level `tools: boolean` to `VerifiedModelLimits`),
     - `backend/src/contracts/stream.ts`, `backend/src/contracts/message.ts`, `backend/src/contracts/api.ts`, and `backend/src/contracts/voice-wire.ts` (bounded web activity/source provenance schemas so P2, P3, and P4 share frozen event/message contracts).
2. **P2 persistence index addition**:
   - `backend/src/persistence/indexes.ts` holds `CALENDAR_INDEXES` and `CORE_INDEXES` inside `setupIndexes`. Clarify that **P2 owns** adding `WEB_SEARCH_INDEXES` on `web_search_connections` in `persistence/indexes.ts` (or a `persistence/web-search-indexes.ts` helper imported cleanly into `setupIndexes`) **without modifying any `CALENDAR_INDEXES` or Calendar repository code**.
3. **P3 `model/catalogue.ts` wiring for `VerifiedModelLimits.tools`**:
   - Clarify that **P3** populates `tools: entry.supported_parameters.includes('tools')` in `backend/src/model/catalogue.ts` (using P1's updated `config-runtime.ts` schema) so models supporting tool calling work for `web_tool` independently of `calendar.tools`.
4. **TinyFish hosted MCP limitation reconciliation**:
   - Planners (`P1`, `P2`, `P4`) must explicitly handle TinyFish's unverified API-key support on `https://agent.tinyfish.ai/mcp`: UI key field/instructions should clearly warn if hosted MCP rejects API keys or restrict TinyFish connection activation to verified MCP OAuth (or report hosted MCP API-key incompatibility cleanly without violating `goal.md`'s ban on REST fallback).
