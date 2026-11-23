# TinyFish authentication: technical research

## Unauthenticated discovery observations

On 15 November 2026, `curl.exe` made the eight specified GETs with a 10-second
timeout and no redirect following. HTTP status and relevant body are:

| URL | Status | Body, trimmed |
| --- | --- | --- |
| https://agent.tinyfish.ai/.well-known/oauth-protected-resource | 404 | HTML 404 page. |
| https://agent.tinyfish.ai/.well-known/oauth-protected-resource/mcp | 200 | JSON below. |
| https://agent.tinyfish.ai/.well-known/oauth-authorization-server | 404 | HTML 404 page. |
| https://agent.tinyfish.ai/.well-known/oauth-authorization-server/mcp | 404 | HTML 404 page. |
| https://agent.tinyfish.ai/.well-known/openid-configuration | 404 | HTML 404 page. |
| https://agent.tinyfish.ai/mcp/.well-known/openid-configuration | 401 | `{"jsonrpc":"2.0","error":{"code":-31001,"message":"Unauthorized: Valid OAuth Bearer token required"},"id":-1}` |
| https://accounts.tinyfish.ai/.well-known/oauth-authorization-server | 404 | HTML page titled “Page not found”. |
| https://accounts.tinyfish.ai/.well-known/openid-configuration | 404 | HTML page titled “Page not found”. |

Path-specific protected-resource response, complete:

```json
{"resource":"https://agent.tinyfish.ai/mcp","authorization_servers":["https://clerk.tinyfish.ai"],"token_types_supported":["urn:ietf:params:oauth:token-type:access_token"],"token_introspection_endpoint":"https://clerk.tinyfish.ai/oauth/token","token_introspection_endpoint_auth_methods_supported":["client_secret_post","client_secret_basic"],"jwks_uri":"https://clerk.tinyfish.ai/.well-known/jwks.json","authorization_data_types_supported":["oauth_scope"],"authorization_data_locations_supported":["header","body"],"key_challenges_supported":[{"challenge_type":"urn:ietf:params:oauth:pkce:code_challenge","challenge_algs":["S256"]}],"service_documentation":"https://clerk.com/docs","scopes_supported":["openid","profile","email","offline_access"]}
```

One unauthenticated initialize POST to https://agent.tinyfish.ai/mcp, with the
requested JSON-RPC body and headers, returned **401**. Its complete challenge:

```text
www-authenticate: Bearer resource_metadata="https://agent.tinyfish.ai/.well-known/oauth-protected-resource/mcp"
```

Body: `{"jsonrpc":"2.0","error":{"code":-31001,"message":"Unauthorized: Valid OAuth Bearer token required"},"id":-1}`.
No credentials, keyed requests, account creation, or paid tool calls were used.
The Clerk issuer's own discovery URLs were **not probed in the initial round**;
the separately authorized follow-up below supersedes that limitation.
The 404s do not establish that other authorization-server metadata does not exist.

## Initial unchanged Aurvin OAuth gate evaluation

Evidence is compared with `backend/src/plugins/web-search/oauth.ts:195-203,205-264,288-310`
and `backend/src/plugins/web-search/providers.ts:45-52`. “Not established” is
not a claim that the provider lacks the capability; it cannot be treated as a
pass for enablement.

| # | Condition | Result |
| --- | --- | --- |
| 1 | RFC 9728 resource metadata exists and parses | **Pass**: path-specific GET returned 200 JSON; the installed SDK `OAuthProtectedResourceMetadataSchema.safeParse` accepted the observed object. |
| 2 | `resource.resource` matches configured MCP endpoint | **Pass**: exact `https://agent.tinyfish.ai/mcp`. |
| 3 | An advertised authorization server has an allowed origin | **Fail**: sole advertised issuer `https://clerk.tinyfish.ai` is neither `https://agent.tinyfish.ai` nor `https://accounts.tinyfish.ai`. SDK selects the first issuer; `oauthFetch` blocks requests outside the fixed origins before metadata validation. |
| 4 | Authorization-server metadata exists and issuer exactly matches its server URL | **Not established / no pass**: agent and accounts probe URLs returned 404; Clerk's discovery was not probed. Code compares normalized `URL.toString()` values. |
| 5 | Authorization, token, optional registration endpoints are credential-free HTTPS within allowed origins | **Not established / no pass**: no authorization-server metadata obtained. The resource document's introspection URL is not the required token endpoint. |
| 6 | Response type `code`; grants `authorization_code` and `refresh_token` | **Not established / no pass**: authorization-server metadata not obtained. |
| 7 | `code_challenge_methods_supported` includes `S256` | **Not established / no pass**: resource `key_challenges_supported` mentions `S256`, but that is not the authorization-server metadata field Aurvin checks. |
| 8 | `token_endpoint_auth_methods_supported` includes `none` | **Not established / no pass**: resource introspection authentication methods are a different field. |
| 9 | DCR or public pre-registered client, secret-free | **Not established / no pass**: neither DCR nor a public client ID was observed in the checked documents; no registration request was made, so a secret-free response is unknown. Moreover Aurvin currently always calls `registerClient` and rejects a returned client secret (`oauth.ts:297-310`); a pre-registered ID alone is not an existing alternative in its code. |
| 10 | Local callback and loopback rules | **Callback pass, provider acceptance unobservable**: with `frontendOrigin=http://127.0.0.1:5173`, Aurvin constructs `http://127.0.0.1:5173/api/plugins/web-search/providers/tinyfish/oauth/callback`. The checked vendor pages do not specify whether arbitrary loopback redirect URIs are accepted; no registration was attempted. |

The installed `@modelcontextprotocol/sdk` 1.32.2 (`backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js:751-767`,
version pinned in `backend/package-lock.json`) falls back to the MCP origin as
authorization server if protected-resource discovery fails or lists no server.
Aurvin rejects missing resource metadata at `oauth.ts:254` even if the SDK
fallback discovers an authorization server. Here fallback is not the decisive
case: resource discovery succeeded and advertises a **disallowed** Clerk origin.
Neither fallback nor working third-party clients make this a go under Aurvin's
unchanged gate.

## Vendor API-key evidence

| Source | Documented claim and limitation |
| --- | --- |
| https://docs.tinyfish.ai/mcp-integration | Manual configuration → Command Code gives `https://agent.tinyfish.ai/mcp` with `Authorization: Bearer YOUR_API_KEY`, and its CLI example uses `sk-tinyfish-...`; it says this particular client connects by API key because it has no browser sign-in. The page also describes browser OAuth for other clients. |
| https://docs.tinyfish.ai/authentication | REST authentication requires `X-API-Key`; its MCP section describes OAuth 2.1. This page does not document `X-API-Key` for MCP. |

The Bearer-key route is **vendor-documented only**, not live-verified. The
unauthenticated 401 is not a key validation test. No key was used.

## Existing code and test sites

| Site | Minimal action or relevance |
| --- | --- |
| `backend/src/plugins/web-search/providers.ts:45-51,129-150` | Change TinyFish `apiKeyHeader: null` to `Authorization`; existing Bearer branch emits the documented header. Update stale file header at line 18. |
| `backend/src/plugins/web-search/connection.ts:299-313` | Remove TinyFish-specific unsupported API-key status in both `notConnected` and `publicProvider`. |
| `backend/src/plugins/web-search/connection.ts:417-452` | Existing generic connect prepares with the key and probes before save; reuse rather than special-case. |
| `backend/src/plugins/web-search/connection.ts:126-128,636-701` | `markOAuthSupported` has no source callers; remove it or wire only to successful real discovery. `installOAuth` sets supported only after successful install; do not claim support by assumption. |
| `frontend/src/api/web-search-protocol.ts:240-246` | Replace TinyFish key instructions and compatibility note with documented Bearer-key and honest OAuth status. |
| `frontend/src/features/plugins/web-search/WebSearchPanel.tsx:85-87,163-185,215-237` | Key field follows status already; expose a clearly labeled actual support check for `unverified` instead of showing the OAuth action only when `supported`, while retaining real error handling. |
| `backend/test/plugins/web-search/providers.spec.ts:44-45,86` | Replace TinyFish key refusal and null-header assertions with Bearer assertions. |
| `backend/test/plugins/web-search/connections.spec.ts:235-241` | Replace refused-connect expectation with success and failure-closed coverage. |
| `backend/test/plugins/web-search/fixtures.ts:161-163,645-647` | Two fixture MCP implementations hardcode TinyFish key rejection; update so fixture behavior does not mask the implementation. |
| `backend/test/assembly/web-search-acceptance-fixture.ts:349` | `connect` excludes TinyFish by type; allow it where testing actual route. |
| `frontend/src/features/plugins/web-search/web-search-panel.test.ts:89-106` | Replace TinyFish browser-only/hidden-key text assertions; update supported-only OAuth action assertion for the new unverified support check. |

Existing fixture-authorized OAuth success tests are not evidence of live
compatibility. Routine fixture/build/lint verification belongs to implementation;
this research performed no application test suite.

## Initial verdict

- **API-key route: not ready in the current build.** Header configuration,
  status, UI wording and refusal fixtures/tests block or misrepresent it.
  Vendor documentation supports implementation; real keyed compatibility remains
  unverified.
- **OAuth route: no-go under the unchanged gate.** The decisive observed failure
  is the advertised `https://clerk.tinyfish.ai` issuer outside Aurvin's fixed
  allowlist. A pre-registered client alone cannot fix that. The provider would
  need to advertise a gate-compatible allowed-origin authorization server and
  publish compatible metadata, with secret-free DCR and acceptable redirect
  rules established; a pre-registered client would additionally require an
  Aurvin implementation change. Changing the allowlist is outside approved
  scope. Other capabilities remain unknown, not disproven.
- **Recommended plan shape:** collapse conditional P2 into P1: implement the
  documented key route and honest unverified support check, retain the OAuth
  gate, and do not enable TinyFish OAuth on this evidence. This initial
  recommendation is superseded by the follow-up below.

## Follow-up: clerk.tinyfish.ai authorization server

On 15 November 2026, the separately authorized follow-up used unauthenticated
`curl.exe` GETs, a 10-second timeout, and no redirect following. No
registration, credentials, consent flow, account, or paid call was attempted.
Both metadata endpoints returned 200; the advertised issuer is root-only, so
the conditional path-suffix probes were not needed.

| URL | Status | Response body |
| --- | --- | --- |
| https://clerk.tinyfish.ai/.well-known/oauth-authorization-server | 200 | OAuth metadata in the first JSON block below. |
| https://clerk.tinyfish.ai/.well-known/openid-configuration | 200 | OpenID metadata in the second JSON block below. |
| https://clerk.tinyfish.ai/.well-known/oauth-protected-resource | 404 | `404 page not found` |
| https://clerk.tinyfish.ai/.well-known/jwks.json | 200 | JWKS in the third JSON block below. |

OAuth authorization-server metadata:

```json
{"issuer":"https://clerk.tinyfish.ai","authorization_endpoint":"https://clerk.tinyfish.ai/oauth/authorize","token_endpoint":"https://clerk.tinyfish.ai/oauth/token","revocation_endpoint":"https://clerk.tinyfish.ai/oauth/token/revoke","device_authorization_endpoint":"https://clerk.tinyfish.ai/oauth/device_authorization","jwks_uri":"https://clerk.tinyfish.ai/.well-known/jwks.json","registration_endpoint":"https://clerk.tinyfish.ai/oauth/register","response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:device_code"],"token_endpoint_auth_methods_supported":["client_secret_basic","none","client_secret_post"],"scopes_supported":["openid","profile","email","public_metadata","private_metadata","offline_access","user:org:read"],"subject_types_supported":["public"],"id_token_signing_alg_values_supported":["RS256"],"claims_supported":["aud","email","email_verified","exp","family_name","given_name","iat","iss","name","picture","preferred_username","sub","org_id"],"service_documentation":"https://clerk.com/docs/oauth/scoped-access","ui_locales_supported":["en"],"op_tos_uri":"https://clerk.com/legal/standard-terms","code_challenge_methods_supported":["S256"],"authorization_response_iss_parameter_supported":true}
```

OpenID configuration:

```json
{"issuer":"https://clerk.tinyfish.ai","authorization_endpoint":"https://clerk.tinyfish.ai/oauth/authorize","token_endpoint":"https://clerk.tinyfish.ai/oauth/token","revocation_endpoint":"https://clerk.tinyfish.ai/oauth/token/revoke","introspection_endpoint":"https://clerk.tinyfish.ai/oauth/token_info","userinfo_endpoint":"https://clerk.tinyfish.ai/oauth/userinfo","device_authorization_endpoint":"https://clerk.tinyfish.ai/oauth/device_authorization","jwks_uri":"https://clerk.tinyfish.ai/.well-known/jwks.json","scopes_supported":["private_metadata","openid","offline_access","user:org:read","email","profile","public_metadata"],"response_types_supported":["code"],"response_modes_supported":["form_post","query"],"grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:device_code"],"subject_types_supported":["public"],"id_token_signing_alg_values_supported":["RS256"],"token_endpoint_auth_methods_supported":["client_secret_basic","none","client_secret_post"],"claims_supported":["aud","email","email_verified","exp","family_name","given_name","iat","iss","name","picture","preferred_username","sub","org_id"],"code_challenge_methods_supported":["S256"],"backchannel_logout_supported":false,"frontchannel_logout_supported":false,"authorization_response_iss_parameter_supported":true}
```

JWKS:

```json
{"keys":[{"use":"sig","kty":"RSA","kid":"ins_30pmnAYIobYzwk2n9Zbp3no05AK","alg":"RS256","n":"3qVyjpe1vNAWpDyKYFt5isFp7u0IQAUYIcjY8DeWRZL8x4PzZ-HJK8VLt7dpQw40svhLG-QY8_U9V0azLsqa6O4OdkMEPeRpwGvtwNM9MJdeYzzUTB-F7sfgGnaC64NawIFlK2Af4k6Q_FQmJW_xVk1jTR-1W1aAUKD_Rp06ITRTbQv5pWRleqVmd2VGj-Z2ejwk_S8RO8il3rfcMaEINAqw3tPo5uGM177o4M3jX_h1SXD3QsI5tNX0as_p_b-f6RtoWZx1nfrLBFYMs4CrqK9A4fGyNyRKvRoJuvCFtx2RYkXY-s075hATarNISW1KbmXThkMozLJNucvfSkhdvw","e":"AQAB"}]}
```

The SDK tries the OAuth metadata first for this root issuer
(`client/auth.js:639-654,696-704`); the OIDC document omits
`registration_endpoint`, but the first, OAuth document advertises it.

| Condition | Follow-up evaluation |
| --- | --- |
| 4. Issuer | **Pass:** `https://clerk.tinyfish.ai` equals the advertised authorization server after `new URL(...).toString()` normalization. |
| 5. Endpoints | **Pass for URL properties; currently fail origin pin:** authorization, token, and registration endpoints are HTTPS on `clerk.tinyfish.ai`, without credentials or fragments. They would pass exact-origin pinning if that origin were added. `assertOrigins` itself does not check fragments, but `oauthFetch` rejects them on requests and `assertAuthorizationUrl` rejects them on the generated authorization URL. |
| 6. Response/grants | **Pass:** `code`, `authorization_code`, and `refresh_token` are all advertised. |
| 7. PKCE | **Pass:** `code_challenge_methods_supported` includes `S256`. |
| 8. Public token auth | **Pass:** `token_endpoint_auth_methods_supported` includes `none`. |
| 9. Registration | **Pass for advertisement; response unverified:** OAuth metadata advertises `https://clerk.tinyfish.ai/oauth/register`. No registration was attempted; Aurvin requires a nonempty bounded `client_id` and no `client_secret` in the response. |
| 10. Redirect URI | **Aurvin construction passes; provider acceptance unverified:** local callback is `http://127.0.0.1:5173/api/plugins/web-search/providers/tinyfish/oauth/callback`. Clerk's [scoped-access guide](https://clerk.com/docs/guides/configure/auth-strategies/oauth/scoped-access) uses an `http://localhost:3000/oauth_callback` example for a manually configured app; it does not establish arbitrary loopback acceptance for TinyFish DCR. The [CIMD rules](https://clerk.com/docs/guides/configure/auth-strategies/oauth/client-id-metadata-documents) require an exact registered redirect match, but are not DCR rules. Acceptance of this exact URI is unobservable here without registering and testing. |

**Allowlist addition alone and the metadata gate:** **Yes**, based on the
observed resource and first OAuth metadata documents, adding the exact
`https://clerk.tinyfish.ai` origin would satisfy all of `assertMetadata`'s
static checks, with no remaining observed failing metadata condition. This is
not proof that the entire OAuth start or completion succeeds: DCR response
validation and the actual consent flow occur after the metadata gate.

Adding the origin is a correction of a stale fixed allowlist entry backed by
TinyFish's live protected-resource metadata, although it expands the set of
trusted origins and therefore warrants explicit security approval. It does not
weaken the pinning mechanism: exact-origin equality, no wildcards, and
`redirect: 'error'` remain untouched.

**Residual risks:** DCR may reject Aurvin's client metadata or return a secret;
the exact loopback callback may be rejected; real consent, token exchange,
token lifetime and refresh-token issuance/rotation, authenticated MCP access,
and subsequent refresh are unverified. The requested scopes include every
advertised scope (`oauth.ts:311`), so consent and provider policy should also
be assessed; metadata alone does not establish least-privilege suitability.
These are not observed metadata-gate failures, but a secret-bearing or failed
DCR response would block Aurvin's existing start flow, and rejected callbacks
or failed exchanges would block completion.

**Planner recommendation:** reconsider P2 based on the now-validated metadata,
but seek approval before expanding the allowlist because the approved goal
explicitly prohibits changing it; use deterministic fixtures and retain the
unverified live-flow limitations.
