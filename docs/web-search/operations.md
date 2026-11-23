# Web Search — Operations Runbook

**Scope and evidence.** This runbook covers local and access-controlled use of the delivered Web Search plugin. It does not authorize infrastructure provisioning, public deployment, paid provider checks, or live OAuth/MCP certification. Unified review is **skipped**, never passed. Current evidence is in [verification.md](verification.md); provider compatibility remains **0/5 live-tested** for authenticated MCP/OAuth flows, browser OAuth is **fixture-only**, TinyFish's `Authorization: Bearer` API-key path is vendor-documented and fixture-tested but not live-verified, and page fetch is **admitted under the client-side guard** for all five providers while provider-side redirect/private-network behavior remains **unverified**. Historical Phase 1, Calendar, and WorkOS documents are patterns, not current Web Search API authority.

## Provider setup and rotation

Users connect their own providers from the Plugins page. Keys are per-account, encrypted server-side, and never returned to the browser. Config/admin credentials are not search keys. Connecting never enables the plugin.

| Provider | Priority | API-key MCP endpoint | Browse tool | Fetch tool | Console destination |
| --- | --- | --- | --- | --- | --- |
| TinyFish | 1 | `https://agent.tinyfish.ai/mcp` | `search` | `fetch_content` | `https://agent.tinyfish.ai/api-keys` |
| Keenable | 2 | `https://api.keenable.ai/mcp` | `search_web_pages` | `fetch_page_content` | `https://app.keenable.ai/` |
| Exa | 3 | `https://mcp.exa.ai/mcp` | `web_search_exa` | `web_fetch_exa` (`urls:[url]`) | `https://dashboard.exa.ai/api-keys` |
| Tavily | 4 | `https://mcp.tavily.com/mcp/` | `tavily_search` | `tavily_extract` | `https://app.tavily.com/home` |
| Firecrawl | 5 | `https://mcp.firecrawl.dev/v2/mcp` | `firecrawl_search` | `firecrawl_scrape` | `https://www.firecrawl.dev/app/api-keys` |

TinyFish keys use the documented `sk-tinyfish-...` format and the hosted MCP header `Authorization: Bearer <key>`; `X-API-Key` is not the TinyFish MCP route. Aurvin validates the candidate with the existing bounded MCP probe before encrypted save. A rejected key leaves no new connection and never invokes another provider as a setup fallback. This is vendor-documented and fixture-tested, not live authenticated verification.

The delivered frontend catalog matches the approved console destinations after D1 was resolved at `26c6461`.

Connect validates MCP capabilities outside turns and may consume a bounded explicit validation probe and provider credits. Only the allowlisted search/fetch tools are used; provider tool catalogs are never exposed to the model. There is no anonymous, keyless, REST, or endpoint-override fallback. Invalid key, unavailable service, and reconnect-required states are distinct.

**Saved-key renewal.** API-key connections stay saved until disconnected. Aurvin renews the cached capability check without a search probe: the control-plane sweep and plugin-open/enable preparation re-authenticate with bounded MCP initialization and tool discovery at most every 60 seconds, beginning five minutes before the 24-hour validation cache expires. Renewal does not write a new account revision and does not enable the account. If an operation cannot authenticate, Aurvin continues to the next eligible provider in priority order (TinyFish → Keenable → Exa → Tavily → Firecrawl), at most once per provider per lookup. Reconnect only for invalid or expired credentials; temporary provider failures do not remove the connection or turn off the saved enablement. A provider-confirmed rejection marks that credential version unusable in memory and is retried only after replacement or account reload. With every saved provider for the requested operation confirmed rejected, text and Live Voice report that the saved credentials are invalid or expired and direct the user to reconnect in Plugins → Web Search. A timeout, rate limit, temporary outage, missing session, or expired validation cache is not a confirmed rejection and reports temporary unavailability instead. If a backup provider succeeds, its sources are shown without asking the user to fix the primary first.

Limitations: this renewal is fixture-tested, not live-certified for any provider. Automatic validation uses MCP initialization and discovery; a provider that verifies a key only on an actual tool call supplies the definitive rejection there. The reject-until-replacement decision is in-memory, so a restart revalidates saved credentials from the existing encrypted records. The 60-second sweep skips disabled accounts; plugin-open, enable, and authenticated preparation still run for the current owner.

Rotation: use the existing provider card to submit a replacement key. Only a confirmed setup publishes a new credential version and invalidates old transports/results. A failed replacement preserves the old confirmed authority; an uncertain outcome is not durable success. Saved values are never redisplayed. Revoke or rotate keys at the provider's own account controls when necessary; local disconnect does not call a universal remote-revocation API. Do not rotate `AURVIN_CONFIG_ENCRYPTION_KEY` in place; preserve the current key/backup and plan an independent migration.

## Enable, disable, and removal

1. **Enable** requires at least one connected provider. The account-wide toggle applies to that user's text and voice conversations; there is no composer toggle.
2. **Disable** memory-fences new calls immediately and best-effort aborts current work. It does not revoke vendor credentials or retract already-dispatched requests.
3. **Disconnect** removes the local provider. Removing the last provider clears saved enablement and the UI explains why. Reconnection requires an explicit enable.
4. `WEB_WRITE_UNCERTAIN` stays denied in the live process. An unconfirmed disconnect may restore saved authority after restart; reconcile control-plane storage while quiesced before resuming. Never claim durable revocation from an uncertain write.

## OAuth callbacks and revocation

The five static callback paths are:

```
/api/plugins/web-search/providers/{tinyfish|keenable|exa|tavily|firecrawl}/oauth/callback
```

GET is a static CSP/no-store bridge page. POST completion is private and requires the current session, exact origin, provider, browser cookie, state, PKCE S256 verifier, audience, issuer, and callback binding. State is single-use, expires after 600,000 ms (10 minutes), and is consumed before exchange. Denial, exact expiry, callback mismatch, replay, or an uncertain consume acknowledgement makes zero exchange POSTs. Start again after denial, expiry, or restart. Discovery/registration is capability-gated and loopback acceptance is not certified. Never paste callback code, state, verifier, or tokens into logs or tickets. Refresh is bounded background/control-plane work, never an admitted-turn requirement; an ambiguous rotating refresh requires reconnect, not blind replay.

For unverified providers, “Check {provider} browser authorization support” runs the real `oauth/start` check and may continue to provider consent only if it succeeds; errors are surfaced without claiming support. TinyFish additionally pins exactly `https://clerk.tinyfish.ai` and explicitly registers/requests `offline_access` only, not Clerk profile/email/metadata scopes. Metadata observation is not a completed flow: DCR response shape, exact loopback acceptance, token exchange and refresh remain unverified live; authenticated compatibility is still 0/5 live-tested. Do not widen scopes, allow origins, accept a client secret, follow redirects, or fall back to REST/keyless to bypass a refusal.

## Authentication authority

`/api/auth/me` and login preparation warm the bounded in-memory account authority outside turns. Bounds: 1,024 entries, 2,048 encoded bytes per snapshot, 15-minute validity, four concurrent warm reads. Cold, exactly expired, fenced, uncertain, capacity-unavailable, and closed authority fail `NOT_READY` without a turn-path database fallback. Reload/auth preparation or a fresh confirmed login restores authority; never add a repository fallback inside a turn.

All local mutations use fencing hooks. Direct Mongo writes, bootstrap CLI changes while a process is live, other executors, and WorkOS-dashboard changes have no coherent immediate invalidation: stop/quiesce, reconcile status/session identifiers, then restart/reprepare. A TTL is not immediate revocation. Active WebSocket principals are **not automatically reauthenticated**; existing logout/deactivation/session cleanup is separate, and already-dispatched requests cannot be withdrawn. Unknown-subject provider-reset ambiguity remains operator reconciliation, not atomic local revocation certification.

## Safety, limits, and degradation

- Public HTTP(S) URLs only. Aurvin rejects credential-bearing URLs, localhost/private/internal targets, numeric/mapped-IPv6/loopback/metadata destinations, mixed DNS answers, and non-HTTP(S) schemes. Aurvin contacts only the five fixed provider services; there is no local URL proxy or unrestricted fetch fallback.
- Provider redirect-hop/private-network protections are **unverified**. Fetch is admitted for all five providers under Aurvin's client-side URL guard, public-DNS checks, provider-returned URL validation, and the untrusted-evidence prompt guardrail. This is not a provider-side safety certification.
- Retrieved text is untrusted evidence. It never becomes system instructions or authority to execute another tool; prompt injection stays inside tool evidence.
- Turn limits default to five searches and five fetches, independently editable 1..20. A fallback attempt consumes one logical call, not another allowance. Schema repair is three additional model attempts per accepted turn, shared across modes and iterations; invalid calls never dispatch a provider and successful calls are never replayed.
- Fixed bounds: MCP connect 4 s, provider call 12 s, logical call 25 s, web-turn deadline 45 s inside the existing turn timeout; model attempts default 15 and cap at 45. Context/evidence bounds may stop earlier; history is never silently dropped.
- Web evidence is stored per turn but reinserted into later prompts at its originating turn, append-only, using the same native assistant/tool pairs the model saw. This keeps the prompt prefix byte-stable for cache-friendly request construction; it does not promise provider cache hits. Accumulated evidence that exceeds the context budget fails closed with `CONTEXT_BUDGET_EXCEEDED` rather than dropping an older turn's groups. Failed web calls are replayed the same way when the per-turn evidence cap admits them.
- Readiness/liveness perform no paid web probes. A web outage degrades retrieval, not ordinary text/voice chat, and is not a restart signal.

## Privacy, retention, and billing

Only the necessary query or requested URL is sent to the selected connected provider. Fallback can disclose the same query/URL to another connected provider. Provider credits/charges and third-party retention may apply; there is no permanent free allowance, invoice guarantee, exactly-once billing, or charge prevention. Keys, access/refresh tokens, and PKCE verifiers are encrypted server-side with owner/provider/connection/version binding and never enter prompts, URLs, logs, transcripts, or frontend `VITE_*` settings. Bounded native tool results and source/activity/accounting evidence may persist through the existing terminal archive. Disconnect does not erase prior evidence or provider logs. There is no unbounded raw-page archive and no private model reasoning. Existing retention/backup policy applies; actual web-evidence cleanup/restore behavior is not separately certified here.

## Shutdown and rollback

Shutdown stops admissions and synchronously fences authority/web work, aborts new calls, closes tracked setup/maintenance/sessions within the bounded budgets, drains ordered archives or reports undrained/uncertain work, and closes persistence once. The external 45 s supervisor bound is not a proven drill. Never overlap executors, delete sentinels, replay unsealed tools/model calls, drop web collections/indexes, or roll back credentials by restoring revoked authority. Rollback requires authorized quiescence, a compatible reader for additive fields/records, and a validated full backup/restore; restoring archives does not undo third-party disclosures or charges. Every actual service/shutdown/rollback drill is **unrun** unless separately evidenced.
