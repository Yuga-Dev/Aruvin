# TinyFish Authentication Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable TinyFish's documented Bearer-key MCP connection and evidenced Clerk-origin OAuth path, make unverified browser authorization actionable, and reconcile compatibility documentation without claiming live authenticated verification.

**Architecture:** Reuse the generic credential-header, probe-before-save, SDK discovery/DCR/PKCE, and confirmed-install paths. Add only the approved exact Clerk origin; remove the unused support setter and let the existing panel handler perform the real support check. Restrict TinyFish's explicit OAuth request to `offline_access`, rather than interpreting Clerk's capability advertisement as permission to request identity and metadata scopes.

**Tech Stack:** TypeScript/NodeNext, NestJS, MCP TypeScript SDK **1.32.2**, React 19, Vite, existing Vitest/Node fixtures; no dependency or lockfile changes.

---

## Execution contract and decisions

- This is P1, including collapsed P2. Execute **A → B → C**, with exactly one atomic implementation commit per group. Individual test/implementation steps below do not get separate commits.
- In this harness, the header's execution skill maps to `executing-plans`; also load `test-driven-development`. This is a worker assignment, not permission to delegate further. Unified review remains **skipped**.
- Scope sources: [goal.md](goal.md), especially AC1–AC8, and [research.md](research.md). The approved 15 November Clerk-origin addition supersedes the research's **initial** no-go/recommendation and the older P1 scope paragraph in `state.md`.
- AC4 is already evidenced by research commits `bc9c5b9`/`7784abc`. Do not repeat probes or issue any live provider, DCR, consent, keyed, paid, account-creation, or deployment request.
- Preserve all unrelated dirty files. In the planner's starting tree, nine Calendar/chat/model/context files were dirty; `backend/test/runtime/web-search-followup-verify.spec.ts` was untracked user work. **Never edit, stage, delete, or use that test as a fixture.** Full routine discovery may include it; report its results separately if it fails.
- During planning, `docs/web-search/operations.md` also acquired an unrelated paragraph about append-only prompt evidence/cache stability. Preserve it. Before Group C, coordinate with its owner/orchestrator to commit that unrelated change separately or explicitly agree hunk ownership; **do not stage the entire file with that unrelated delta still present**. Named-file staging alone does not prevent mixed ownership.
- Run commands in their specified package directories. There is no root npm workspace. Node must satisfy `^22.22.3 || ^24.15.0 || >=26.0.0`. Installed dependencies already suffice; do not upgrade SDK/React or regenerate lockfiles.
- All new code files need the complete repository file header before imports; heavily modified existing files (>30%) need it too. Existing owned files already have headers: preserve them and correct stale descriptions of TinyFish key refusal or supported-only actions.
- Keep `assertMetadata`, `assertOrigins`, callback/state/cookie binding, S256, public-client/no-secret validation, `redirect: 'error'`, transport bounds, encrypted server-only credentials, and provider priority unchanged. No REST/keyless/anonymous fallback, wildcard, or additional trusted origin.

### OAuth affordance decision

**Remove `WebSearchConnections.markOAuthSupported` and show “Check {provider} browser authorization support” for `browserAuthorization: 'unverified'`.** Reuse the existing `handleStartOAuth` → `client.startOAuth` → real `oauth/start` route, including its existing safe error mapping and navigation on success. Retain “Connect {provider} account” for `supported` and no action for `unsupported`. This is smaller and more honest than adding discovery work to status/warm paths or inventing a third state machine: a failed check displays the actual error without changing support, and even successful start/discovery does not claim connected/supported. Only the existing successful, confirmed `complete`/`installOAuth` flow sets supported.

### Scope-selection decision

For **TinyFish only**, request the explicit literal **`offline_access`** in both DCR `clientMetadata.scope` and the authorization URL, and save that exact scope in the existing binding. Require that both the authorization-server and protected-resource documents advertise it; otherwise fail `WEB_AUTH_UNSUPPORTED` before registration or state save. Do not request `openid`, `profile`, `email`, `public_metadata`, `private_metadata`, `user:org:read`, or future advertised scopes: Aurvin needs an MCP access token with the existing refresh lifecycle, not an OIDC login or user data. Do not omit scope: Clerk can apply default `profile email` scopes when it is omitted. SDK 1.32.2's direct `startAuthorization` honors explicit scope and adds `prompt=consent` for `offline_access`; no SDK override is needed. Preserve the other four providers' current scope behavior in this focused change. Live acceptance of this least-privilege choice remains unverified; an `invalid_scope` or DCR refusal must surface as failure, never cause scope expansion, omission/defaulting, or a broader retry.

Documentation consulted during planning: MCP SDK [client helpers](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.32.2/docs/client.md), Clerk [scope meanings](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth), and [dynamic-client scope/default behavior](https://clerk.com/docs/guides/ai/mcp/step-up-scopes). The installed SDK's `dist/esm/client/auth.js:781–820` was checked; do not edit dependency files.

## File map

| Group | Exact path | Responsibility/change |
| --- | --- | --- |
| A, B | `backend/src/plugins/web-search/providers.ts` | A: TinyFish `Authorization` header; B: single Clerk-origin addition. |
| A, B | `backend/src/plugins/web-search/connection.ts` | A: both API-key status projections supported; B: delete dead setter only. |
| A | `frontend/src/api/web-search-protocol.ts` | TinyFish key format/header instructions and honest compatibility note. |
| A | `backend/test/plugins/web-search/providers.spec.ts` | Flip key/header assertions; preserve credential rejection checks. |
| A | `backend/test/plugins/web-search/connections.spec.ts` | Replace refused setup with success/status and real-wire rejection coverage. |
| A, B | `backend/test/plugins/web-search/fixtures.ts` | A: remove two artificial key refusals; B: observed Clerk metadata, recorded requests and configurable DCR reply. |
| A | `backend/test/plugins/web-search/prepared.spec.ts` | Delete TinyFish OAuth-only test workaround; exercise keys for all five SDK mappings. |
| A, B | `frontend/src/features/plugins/web-search/web-search-panel.test.ts` | A: visible masked TinyFish key; B: supported/unverified/unsupported action matrix. |
| B | `backend/src/plugins/web-search/oauth.ts` | Explicit minimal TinyFish scope before DCR; keep security gate intact. |
| B | `backend/test/plugins/web-search/oauth.spec.ts` | Clerk start/complete, exact scope, DCR-secret rejection and off-origin negatives. |
| B | `frontend/src/features/plugins/web-search/WebSearchPanel.tsx` | Offer unverified support check via existing handler. |
| B | **Create** `frontend/src/features/plugins/web-search/web-search-oauth-action.test.ts` | Node component-handler fixture proving the rendered action calls the real client and surfaces errors. |
| C | `README.md` | Current compatibility sentence. |
| C | `docs/web-search/verification.md` | Current summary/table/TinyFish row and dated follow-up evidence. |
| C | `docs/web-search/state.md` | Reconcile current P2 gated/unverified notes; preserve historical results. |
| C | `docs/web-search/operations.md` | Setup/header/check behavior and honest residual limitations. |

Do not modify the current workflow's goal/research/state/final report as part of these commits; the orchestrator owns lifecycle records. Do not edit historical `docs/web-search/plan*.md` or `final_report.md`. The old assembled fixture's `connect(providerName: Exclude<WebSearchProvider, 'tinyfish'>)` is not a production restriction and does not need expansion for this plan: new real-SDK connection tests below cover the normal connect method without adding an unrelated assembled-runtime diff.

## Baseline evidence and verification discipline

Planner baseline: **`c284ae98b671dbb0c81273fb70df1c1c036b6d3b` plus the preserved unrelated dirty working tree**, 15 November 2026, Windows/PowerShell. This is not an isolated clean-commit comparison.

| CWD | Command actually executed before this plan | Result |
| --- | --- | --- |
| `backend` | `npm run build` | Pass. |
| `backend` | `npm run lint` | Exit 0, existing warnings. |
| `backend` | `npm test -- test/plugins/web-search/providers.spec.ts test/plugins/web-search/connections.spec.ts test/plugins/web-search/oauth.spec.ts --no-file-parallelism` | 3 files / 55 tests pass, including old TinyFish refusal assertions. |
| `frontend` | `npm run build` | Pass; existing >500 kB chunk warning. |
| `frontend` | `npm run lint` | Exit 0, existing warnings, including control-regex/ref warnings. |
| `frontend` | `npm test -- src/features/plugins/web-search/web-search-panel.test.ts src/features/plugins/integration-tests/web-search-flow.test.ts` | 2 files / 10 tests pass. |
| `frontend` | `npm test` | 108 files / 868 tests pass. |
| `backend` | `npm run test:e2e -- test/assembly/voice-bootstrap.e2e-spec.ts` | **Pre-existing failure reproduced:** 29 fail / 1 pass. Voice endpoints return 503 `NOT_READY` instead of 200/201; one expected `VOICE_CONNECT_TIMEOUT` receives `NOT_READY`. |

The full backend routine suite was **not rerun by the planner**. Historical `docs/web-search/verification.md` R3 records 19 failed files, 73 failed tests and a worker error; R4 records the same voice-bootstrap failure. Calendar/local-guard/voice failures and `memory-first-voice` worker exit are historical warnings, **not a blanket exemption for new failures**. The worker must capture fresh baseline and post-change logs, compare failing test names/errors, and report new or changed failures. Do not repair unrelated Calendar/voice failures or change assertions/security gates to green the suite.

- [ ] **Preflight:** From repository root run `git status --short`, `git diff --name-only`, and `git diff --cached --name-only` as separate commands. If the index contains another owner's work, coordinate with the orchestrator before committing; never unstage/revert it yourself.
- [ ] **Offline prerequisite:** For the worker's test batches, use a child PowerShell session with service/test credential environment variables removed. Do not print their values, read local `.env` secrets, or set native-test prerequisites. In that child session run this once before the npm commands:

```powershell
foreach ($name in @(
  'AURVIN_TEST_MONGODB_URI', 'AURVIN_TEST_DB_PREFIX', 'MONGODB_URI',
  'OPENROUTER_API_KEY', 'WORKOS_API_KEY', 'GOOGLE_CLIENT_SECRET',
  'LIVEKIT_API_SECRET', 'DEEPGRAM_API_KEY'
)) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
```

- [ ] **Fresh baseline:** In `backend`, run `npm test` and `npm run test:e2e`; in `frontend`, run `npm test`. Save output outside tracked source, preferably `~/AppData/Local/Temp/opencode/`, and note HEAD/dirty paths. Native-prerequisite skips are expected and must be counted separately. These runs must remain fixture-only; do not supply MongoDB/service credentials to overcome skips.
- [ ] In every red/green step, run the exact focused command indicated. A new regression that already passes is still valuable security coverage, but do not mislabel it red. The combined new assertions must demonstrably fail for the old header/status, missing Clerk pin, broad scopes, or missing action before production edits.

## Group A — Documented TinyFish API-key-over-MCP

**Atomic commit message:** `feat(web-search): enable TinyFish Bearer API keys`

### Task A1 — Freeze desired header/status behavior first

**Files:** `backend/test/plugins/web-search/providers.spec.ts`, `backend/test/plugins/web-search/connections.spec.ts`, `backend/test/plugins/web-search/fixtures.ts`, `backend/src/plugins/web-search/providers.ts`, `backend/src/plugins/web-search/connection.ts`.

- [ ] **Write failing tests in `backend/test/plugins/web-search/providers.spec.ts`.** Replace the throwing `credentialHeaders('tinyfish', ...)` assertion inside `maps only the exact five search/read tools and header credentials` with:

```typescript
expect(credentialHeaders('tinyfish', { method: 'api-key', apiKey: 'sk-tinyfish-fixture' }))
  .toEqual({ Authorization: 'Bearer sk-tinyfish-fixture' });
```

In `uses the exact fixed endpoints with no query configuration`, change only the TinyFish row's final value from `null` to `'Authorization'`. Add TinyFish to the existing invalid-credential coverage rather than removing validation:

```typescript
it.each(['', ' key', 'key ', 'key\nvalue', 'x'.repeat(4097)])(
  'rejects malformed TinyFish credentials without header construction: %j', apiKey => {
    expect(() => credentialHeaders('tinyfish', { method: 'api-key', apiKey }))
      .toThrow('WEB_AUTH_UNSUPPORTED');
  },
);
```

- [ ] **Write failing tests in `backend/test/plugins/web-search/connections.spec.ts`.** Replace `refuses TinyFish API-key setup before any candidate save` with:

```typescript
it('reports TinyFish API-key support before warm and after a confirmed key connection', async () => {
  const f = connectionFixture();
  try {
    expect(f.service.status('u_a').providers.find(p => p.provider === 'tinyfish'))
      .toMatchObject({ state: 'not-connected', authSupport: { apiKey: 'supported' } });
    await f.service.warmOwner('u_a');
    expect(f.service.status('u_a').providers.find(p => p.provider === 'tinyfish'))
      .toMatchObject({ state: 'not-connected', authSupport: { apiKey: 'supported' } });
    const status = await f.connect('tinyfish');
    expect(status.providers.find(p => p.provider === 'tinyfish')).toMatchObject({
      state: 'connected', authMethod: 'api-key',
      authSupport: { apiKey: 'supported', browserAuthorization: 'unverified' },
    });
    expect(status).toMatchObject({ revision: 1, enabled: false, effectiveEnabled: false });
    expect(f.records.get('u_a')?.connections.tinyfish?.authMethod).toBe('api-key');
    expect(JSON.stringify(f.records.get('u_a'))).not.toContain('fixture-key');
  } finally { await f.service.close(); }
});
```

- [ ] **Verify red (CWD `backend`).**

```powershell
npm test -- test/plugins/web-search/providers.spec.ts test/plugins/web-search/connections.spec.ts --no-file-parallelism
```

Expected: TinyFish header assertion fails with `WEB_AUTH_UNSUPPORTED`; status assertion sees `unsupported`. Do not alter production until these failures are observed.

- [ ] **Minimal implementation.** In `backend/src/plugins/web-search/providers.ts`, set only TinyFish `apiKeyHeader: 'Authorization'`; change the header description to “API-key or OAuth Bearer headers; credentials remain header-only.” Leave `credentialHeaders` implementation, endpoint, key bounds and control/whitespace checks unchanged. In `backend/src/plugins/web-search/connection.ts`, replace the two TinyFish conditional API-key support expressions:

```typescript
// notConnected's authSupport:
apiKey: 'supported',
// publicProvider's inferred authSupport object:
apiKey: 'supported' as const,
```

In `backend/test/plugins/web-search/fixtures.ts`, delete **both** three-line TinyFish API-key rejection blocks in `connectionFixture` and `runtimeFixture`:

```typescript
if (input.provider === 'tinyfish' && input.credentials.method === 'api-key') {
  throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
}
```

These were artificial old-verdict behavior, not provider observations. Retain generic `rejectNextPrepare` fault injection and every other fixture guard. Update the stale key-refusal description in `providers.spec.ts`'s header.

- [ ] **Verify green (CWD `backend`).**

```powershell
npm test -- test/plugins/web-search/providers.spec.ts test/plugins/web-search/connections.spec.ts --no-file-parallelism
```

Expected: both files pass. No commit yet; A2/A3 belong to the same Group A commit.

### Task A2 — Real SDK connect/probe and wrong-key isolation

**Files:** `backend/test/plugins/web-search/connections.spec.ts`, `backend/test/plugins/web-search/prepared.spec.ts`. Production implementation remains the A1 shared configuration change.

- [ ] **Add real-boundary regression tests to `backend/test/plugins/web-search/connections.spec.ts`.** Add imports for `WebSearchConnections`, `McpWebClient`, `WebSearchSecretCipher`, and `mcpFixture` using the existing relative `.js` convention:

```typescript
import { WebSearchConnections } from '../../../src/plugins/web-search/connection.js';
import { McpWebClient } from '../../../src/plugins/web-search/mcp-client.js';
import { WebSearchSecretCipher } from '../../../src/platform/crypto/web-search-secret-cipher.js';
import { mcpFixture } from './mcp-fixture.js';
```

Add this parameterized test; it deliberately uses the real connections service **and real SDK client**, not the prepare stub:

```typescript
it.each(['accepted', '401', 'probe-rejected'] as const)(
  'TinyFish normal key connect is header-only and fail-closed for %s', async outcome => {
    const storage = connectionFixture();
    const wire = mcpFixture([{
      name: 'search',
      inputSchema: {
        type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
      },
    }], { endpoint: 'https://agent.tinyfish.ai/mcp' });
    if (outcome === '401') wire.setStatus(401);
    if (outcome === 'probe-rejected') {
      wire.setResult({ isError: true, content: [{ type: 'text', text: 'rejected fixture key' }] });
    }
    const mcp = new McpWebClient({ fetch: wire.request });
    const service = new WebSearchConnections({
      store: () => storage.store,
      cipher: new WebSearchSecretCipher({ status: 'ready', key: Buffer.alloc(32, 7) }),
      mcp,
    });
    const candidate = 'sk-tinyfish-fixture-not-a-real-key';
    try {
      const pending = service.connect('u_a', 'tinyfish', {
        protocolVersion: 1, expectedRevision: 0, candidate,
      }, signal());
      if (outcome === 'accepted') {
        const status = await pending;
        expect(status.providers.find(p => p.provider === 'tinyfish'))
          .toMatchObject({ state: 'connected', authMethod: 'api-key' });
        expect(status.enabled).toBe(false);
        expect(storage.records.get('u_a')?.connections.tinyfish).toBeDefined();
        expect(JSON.stringify(storage.records.get('u_a'))).not.toContain(candidate);
      } else {
        await expect(pending).rejects.toMatchObject({ code: 'WEB_INVALID_KEY' });
        expect(storage.records.size).toBe(0);
        expect(storage.calls.writes).toBe(0);
        expect(service.preparedProvider('u_a', 'tinyfish')).toBeNull();
        expect(service.status('u_a')).toMatchObject({
          revision: 0, enabled: false, effectiveEnabled: false,
        });
      }
      expect(wire.calls.filter(c => c.body.method === 'initialize')).toHaveLength(1);
      expect(wire.calls.filter(c => c.body.method === 'tools/call'))
        .toHaveLength(outcome === '401' ? 0 : 1);
      expect(wire.calls.length).toBeGreaterThan(0);
      for (const call of wire.calls) {
        expect(call.url).toBe('https://agent.tinyfish.ai/mcp');
        expect(call.headers.get('authorization')).toBe(`Bearer ${candidate}`);
        expect(call.headers.has('x-api-key')).toBe(false);
        expect(call.url).not.toContain(candidate);
      }
      expect(service.status('u_a').providers
        .filter(p => p.provider !== 'tinyfish')
        .every(p => p.state === 'not-connected')).toBe(true);
    } finally {
      await service.close();
      await storage.service.close();
    }
  },
);
```

`mcpFixture` rejects every URL except its fixed endpoint; the nonzero recorded requests and single initialize/probe assertions prove no provider fallback/replay. A1 is the only production change required; these tests would reject the old build before any request. Do not add a TinyFish-specific connect branch or relax probes.

- [ ] **Run the new boundary test (CWD `backend`).**

```powershell
npm test -- test/plugins/web-search/connections.spec.ts -t "TinyFish normal key connect" --no-file-parallelism
```

Expected after A1: all three cases pass. If a rejected-key case gives a different error, inspect the fixture/probe, not the security policy. AC3 permits `WEB_AUTH_UNSUPPORTED`, but these concrete 401/tool-error fixtures should map to the existing `WEB_INVALID_KEY`.

- [ ] **Delete the old test workaround in `backend/test/plugins/web-search/prepared.spec.ts`.** In `prepares real SDK browse and fetch mappings for %s`, replace the endpoint conditional with `const endpoint = definition.apiKeyEndpoint;` and the entire TinyFish-only OAuth credential object/conditional with:

```typescript
const credentials = { method: 'api-key' as const, apiKey: 'fixture-key' };
```

After both browse/fetch calls, add:

```typescript
if (provider === 'tinyfish') {
  expect(f.calls.length).toBeGreaterThan(0);
  expect(f.calls.every(call => call.headers.get('authorization') === 'Bearer fixture-key'))
    .toBe(true);
}
```

This assertion would have failed before A1. Existing five-provider OAuth coverage remains in `oauth.spec.ts`; do not delete that coverage.

- [ ] **Verify A2 and the shared fixtures (CWD `backend`).**

```powershell
npm test -- test/plugins/web-search/connections.spec.ts test/plugins/web-search/prepared.spec.ts test/plugins/web-search/runtime.spec.ts test/plugins/web-search/mcp-client.spec.ts --no-file-parallelism
```

Expected: all focused cases pass, including wrong keys and the unchanged TinyFish OAuth runtime fixture.

### Task A3 — Show the masked key and accurate instructions, then commit A

**Files:** `frontend/src/features/plugins/web-search/web-search-panel.test.ts`, `frontend/src/api/web-search-protocol.ts`; no panel logic change needed for API keys.

- [ ] **Write failing frontend test.** Replace `explains TinyFish browser-only auth and hides its key field when API keys are unsupported` in `frontend/src/features/plugins/web-search/web-search-panel.test.ts` with:

```typescript
it('shows the masked TinyFish key field with documented Bearer-key instructions', () => {
  const html = renderToStaticMarkup(createElement(WebSearchPanel, {
    client: mockClient(),
    initialStatus: makeStatus(item => item.provider === 'tinyfish'
      ? { ...item, authSupport: { apiKey: 'supported', browserAuthorization: 'unverified' } }
      : item),
  }));
  const card = html.match(/<article[^>]*data-provider="tinyfish"[\s\S]*?<\/article>/)?.[0] ?? '';
  expect(card).toMatch(/id="web-search-key-tinyfish"[^>]*type="password"/);
  expect(card).toContain('sk-tinyfish-');
  expect(card).toContain('Authorization: Bearer');
  expect(card).toContain('not live-verified');
  expect(card).not.toContain('no key field');
  expect(card).not.toContain('does not accept');
});
```

- [ ] **Verify red (CWD `frontend`).**

```powershell
npm test -- src/features/plugins/web-search/web-search-panel.test.ts -t "shows the masked TinyFish key field"
```

Expected: instructions/format assertions fail, even though the existing generic field logic already renders a supported key field.

- [ ] **Minimal catalog replacement** in `frontend/src/api/web-search-protocol.ts`, preserving the approved console URL:

```typescript
keyInstructions: 'Create or copy a TinyFish API key (sk-tinyfish-...) at agent.tinyfish.ai/api-keys and paste it here. Aurvin sends it to the hosted MCP endpoint as Authorization: Bearer <key>.',
compatibilityNote: 'Bearer API keys are vendor-documented and validated on connect; authenticated compatibility is not live-verified. Browser authorization remains capability-gated.',
```

React escapes `<key>` in markup; assert the stable “Authorization: Bearer” text, not an unescaped secret placeholder.

- [ ] **Verify A frontend (CWD `frontend`).**

```powershell
npm test -- src/features/plugins/web-search/web-search-panel.test.ts src/features/plugins/integration-tests/web-search-flow.test.ts src/api/web-search-protocol.test.ts src/api/web-search-client.test.ts
npm run build
npm run lint
```

Run the three commands separately. Expected: pass, with baseline-only warnings.

- [ ] **Search for the old verdict (root; inspect matches, do not edit historical evidence blindly).**

```powershell
git grep -n -i -E 'tinyfish|markOAuthSupported' -- backend/src/plugins/web-search backend/test/plugins/web-search frontend/src/api frontend/src/features/plugins/web-search
```

Expected: no remaining production/test assertion that TinyFish API keys are categorically unsupported. `apiKeyHeader === null`'s generic fail-closed guard is not a stale assertion and stays. The dead setter is removed in B; current docs are reconciled in C.

- [ ] **Backend A verification (CWD `backend`).**

```powershell
npm test -- test/plugins/web-search/ --no-file-parallelism
npm run build
npm run lint
```

Expected: web-search fixtures pass; build/lint have no new errors.

- [ ] **Commit only Group A (root).** Inspect `git diff --check` and staged names before committing; stage these named files, not directories:

```powershell
git add backend/src/plugins/web-search/providers.ts backend/src/plugins/web-search/connection.ts backend/test/plugins/web-search/providers.spec.ts backend/test/plugins/web-search/connections.spec.ts backend/test/plugins/web-search/fixtures.ts backend/test/plugins/web-search/prepared.spec.ts frontend/src/api/web-search-protocol.ts frontend/src/features/plugins/web-search/web-search-panel.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat(web-search): enable TinyFish Bearer API keys"
```

## Group B — Clerk-origin OAuth and a reachable, honest support check

**Atomic commit message:** `feat(web-search): enable gated TinyFish Clerk OAuth`

### Task B1 — Observed Clerk fixture, unchanged gate, minimal scopes

**Files:** `backend/test/plugins/web-search/fixtures.ts`, `backend/test/plugins/web-search/oauth.spec.ts`, `backend/test/plugins/web-search/providers.spec.ts`, `backend/src/plugins/web-search/providers.ts`, `backend/src/plugins/web-search/oauth.ts`.

- [ ] **Prepare deterministic evidence-shaped test support in `backend/test/plugins/web-search/fixtures.ts`.** This is fixture work before production changes:
  - Set `OAUTH_ORIGINS.tinyfish` to exactly `https://clerk.tinyfish.ai`.
  - Fix the existing `OAuthFixture.start` declaration to `start(userId?: string): Promise<{ authorizationUrl: string; expiresAt: string; browserCookie: string }>` to match its already-supported implementation/callers.
  - Add these two members to `OAuthFixture`:

```typescript
requests: Array<{ url: string; method: string; redirect: RequestRedirect | undefined; body: string }>;
setRegistrationResponse(value: Record<string, unknown>): void;
```

Inside `oauthFixture`, add `const requests: OAuthFixture['requests'] = [];`. Use these complete replacements for the current `defaultMetadata` function and initial resource/token values:

```typescript
const defaultMetadata = (): Record<string, unknown> => ({
  issuer: origin,
  authorization_endpoint: `${origin}${provider === 'tinyfish' ? '/oauth' : ''}/authorize`,
  token_endpoint: `${origin}${provider === 'tinyfish' ? '/oauth' : ''}/token`,
  registration_endpoint: `${origin}${provider === 'tinyfish' ? '/oauth' : ''}/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: provider === 'tinyfish'
    ? ['client_secret_basic', 'none', 'client_secret_post'] : ['none'],
  scopes_supported: provider === 'tinyfish'
    ? ['openid', 'profile', 'email', 'public_metadata', 'private_metadata', 'offline_access', 'user:org:read']
    : provider === 'firecrawl' ? ['firecrawl:global', 'offline_access'] : ['read'],
});
let metadata = defaultMetadata();
let resourceMetadata: Record<string, unknown> = {
  resource: OAUTH_RESOURCES[provider], authorization_servers: [origin],
  ...(provider === 'tinyfish'
    ? { scopes_supported: ['openid', 'profile', 'email', 'offline_access'] } : {}),
};
let tokenResponse: Record<string, unknown> = {
  access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600,
  refresh_token: 'fixture-refresh', scope: provider === 'tinyfish' ? 'offline_access' : 'read',
};
let registrationResponse: Record<string, unknown> = {
  client_id: 'client_1', redirect_uris: [redirectUri],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
};
```

The fixture still uses a synthetic public-client DCR response, **not** an observed DCR result. In the injected `fetchFn`, after URL/method construction record the call and deny unexpected origins:

```typescript
requests.push({
  url: url.toString(), method, redirect: init?.redirect, body: requestBody(init?.body),
});
if (![new URL(providerDefinition(provider).oauthEndpoint).origin, origin].includes(url.origin)) {
  throw new Error('unexpected fixture OAuth origin');
}
```

In its existing protected-resource GET branch, before returning resource JSON, add:

```typescript
if (provider === 'tinyfish'
  && url.toString() !== 'https://agent.tinyfish.ai/.well-known/oauth-protected-resource/mcp') {
  return new Response(null, { status: 404 });
}
```

In the existing authorization-server GET branch, before its metadata response add:

```typescript
if (provider === 'tinyfish'
  && url.toString() !== 'https://clerk.tinyfish.ai/.well-known/oauth-authorization-server') {
  return new Response(null, { status: 404 });
}
```

This reproduces the actual successful OAuth document rather than inventing agent/accounts discovery. Existing `/register` and `/token` suffix handlers already accept `/oauth/register` and `/oauth/token`; replace their inline registration object with `return Response.json(registrationResponse);`. Retain token counters, holds, refresh handling and all other providers' behavior. Return `requests` and `setRegistrationResponse(value) { registrationResponse = value; }` from the fixture. No call may delegate to real/global fetch.

- [ ] **Add exact allowlist test in `backend/test/plugins/web-search/providers.spec.ts`:**

```typescript
it('pins only the approved TinyFish OAuth origins including Clerk', () => {
  expect(providerDefinition('tinyfish').oauthOrigins).toEqual([
    'https://agent.tinyfish.ai', 'https://accounts.tinyfish.ai', 'https://clerk.tinyfish.ai',
  ]);
});
```

- [ ] **Add Clerk/scope tests to `backend/test/plugins/web-search/oauth.spec.ts`:**

```typescript
it('TinyFish Clerk discovery completes with only offline_access and no premature support claim', async () => {
  const f = oauthFixture('tinyfish');
  try {
    expect(f.status().providers.find(p => p.provider === 'tinyfish')?.authSupport.browserAuthorization)
      .toBe('unverified');
    const started = await f.start();
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://clerk.tinyfish.ai/oauth/authorize');
    expect(url.searchParams.get('resource')).toBe('https://agent.tinyfish.ai/mcp');
    expect(url.searchParams.get('scope')).toBe('offline_access');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(f.oauthStates[0]?.binding.scope).toBe('offline_access');
    expect(f.status().providers.find(p => p.provider === 'tinyfish'))
      .toMatchObject({ state: 'not-connected', authSupport: { browserAuthorization: 'unverified' } });
    const registration = f.requests.find(r => r.method === 'POST'
      && r.url === 'https://clerk.tinyfish.ai/oauth/register');
    expect(registration).toBeDefined();
    expect(JSON.parse(registration!.body)).toMatchObject({
      scope: 'offline_access', token_endpoint_auth_method: 'none',
      redirect_uris: [
        'https://aurvin.example.com/api/plugins/web-search/providers/tinyfish/oauth/callback',
      ],
    });
    const state = url.searchParams.get('state')!;
    expect(await f.complete({ state, code: 'fixture-code', cookie: started.browserCookie }))
      .toBe('connected');
    expect(f.status().providers.find(p => p.provider === 'tinyfish')).toMatchObject({
      state: 'connected', authMethod: 'oauth',
      authSupport: { browserAuthorization: 'supported' },
    });
    expect(f.status().enabled).toBe(false);
    expect(f.tokenPosts()).toBe(1);
    expect(f.requests.some(r => r.url === 'https://agent.tinyfish.ai/.well-known/oauth-protected-resource/mcp'))
      .toBe(true);
    expect(f.requests.some(r => r.url === 'https://clerk.tinyfish.ai/.well-known/oauth-authorization-server'))
      .toBe(true);
    expect(f.requests.every(r => r.redirect === 'error')).toBe(true);
    expect(f.requests.filter(r => r.method === 'POST').map(r => r.url)).toEqual([
      'https://clerk.tinyfish.ai/oauth/register', 'https://clerk.tinyfish.ai/oauth/token',
    ]);
  } finally {
    await f.oauth.close();
    await f.connections.close();
  }
});

it.each(['server', 'resource'] as const)(
  'TinyFish refuses missing offline_access in %s metadata instead of broadening scopes', async source => {
    const f = oauthFixture('tinyfish');
    try {
      if (source === 'server') {
        f.setMetadata({ ...f.defaultMetadata(), scopes_supported: ['openid', 'profile', 'email'] });
      } else {
        f.setResourceMetadata({
          resource: 'https://agent.tinyfish.ai/mcp',
          authorization_servers: ['https://clerk.tinyfish.ai'], scopes_supported: ['openid', 'email'],
        });
      }
      await expect(f.start()).rejects.toMatchObject({ code: 'WEB_AUTH_UNSUPPORTED' });
      expect(f.requests.filter(r => r.method === 'POST')).toEqual([]);
      expect(f.oauthStates).toEqual([]);
      expect(f.records.size).toBe(0);
    } finally {
      await f.oauth.close();
      await f.connections.close();
    }
  },
);

it.each(['issuer', 'token_endpoint', 'registration_endpoint'] as const)(
  'TinyFish still rejects off-allowlist %s metadata', async field => {
    const f = oauthFixture('tinyfish');
    try {
      f.setMetadata({ ...f.defaultMetadata(), [field]: `https://clerk.tinyfish.ai.evil.example/${field}` });
      await expect(f.start()).rejects.toMatchObject({ code: 'WEB_AUTH_UNSUPPORTED' });
      expect(f.requests.every(r => !r.url.includes('evil.example'))).toBe(true);
      expect(f.requests.filter(r => r.method === 'POST')).toEqual([]);
      expect(f.oauthStates).toEqual([]);
      expect(f.records.size).toBe(0);
    } finally {
      await f.oauth.close();
      await f.connections.close();
    }
  },
);

it('TinyFish rejects a secret-bearing DCR reply without storing or claiming support', async () => {
  const f = oauthFixture('tinyfish');
  try {
    f.setRegistrationResponse({
      client_id: 'client_1', client_secret: 'fixture-forbidden-secret',
      token_endpoint_auth_method: 'none',
      redirect_uris: [
        'https://aurvin.example.com/api/plugins/web-search/providers/tinyfish/oauth/callback',
      ],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
    await expect(f.start()).rejects.toMatchObject({ code: 'WEB_AUTH_UNSUPPORTED' });
    expect(f.requests.filter(r => r.url === 'https://clerk.tinyfish.ai/oauth/register'))
      .toHaveLength(1);
    expect(f.oauthStates).toEqual([]);
    expect(f.records.size).toBe(0);
    expect(f.tokenPosts()).toBe(0);
    expect(f.status().providers.find(p => p.provider === 'tinyfish')?.authSupport.browserAuthorization)
      .toBe('unverified');
  } finally {
    await f.oauth.close();
    await f.connections.close();
  }
});
```

- [ ] **Verify the missing-origin red (CWD `backend`).**

```powershell
npm test -- test/plugins/web-search/providers.spec.ts test/plugins/web-search/oauth.spec.ts --no-file-parallelism
```

Expected: exact-origin test fails, new TinyFish completion and existing five-provider TinyFish success fail at discovery. Off-origin/security denials may already pass.

- [ ] **Make the one approved origin change** in `backend/src/plugins/web-search/providers.ts`:

```typescript
oauthOrigins: ['https://agent.tinyfish.ai', 'https://accounts.tinyfish.ai', 'https://clerk.tinyfish.ai'],
```

No other provider origin changes. Re-run:

```powershell
npm test -- test/plugins/web-search/oauth.spec.ts -t "TinyFish" --no-file-parallelism
```

Expected intermediate red: URL/binding/DCR scope tests expose broad scope selection, and missing-scope cases reach registration/state save instead of failing.

- [ ] **Minimal scope implementation** in `backend/src/plugins/web-search/oauth.ts`. Immediately after `this.assertMetadata(...)` and **before** constructing `clientMetadata`, add:

```typescript
const scope = provider === 'tinyfish' ? 'offline_access' : metadata.scopes_supported?.join(' ') ?? '';
if (provider === 'tinyfish'
  && (!metadata.scopes_supported?.includes(scope)
    || !info.resourceMetadata?.scopes_supported?.includes(scope))) {
  throw new WebSearchFault('WEB_AUTH_UNSUPPORTED');
}
```

Add only this member to the existing `OAuthClientMetadata` object:

```typescript
...(provider === 'tinyfish' ? { scope } : {}),
```

Delete the old `const scope = metadata.scopes_supported?.join(' ') ?? '';` after DCR. Keep the existing authorization argument spread and `binding.scope`: they now reuse the selected scope. Add a short explanatory comment above selection: `// TinyFish needs refresh, not OIDC identity or Clerk user metadata scopes.` No new policy abstraction, new provider state, wider retry, or gate relaxation.

- [ ] **Verify B1 green and regression (CWD `backend`).**

```powershell
npm test -- test/plugins/web-search/providers.spec.ts test/plugins/web-search/oauth.spec.ts --no-file-parallelism
```

Expected: all five existing provider OAuth fixtures and new Clerk/scope/security cases pass. DCR secret denial remains a true rejection; do not convert it to a supported status.

### Task B2 — Reach the real start call without optimistic support

**Files:** `frontend/src/features/plugins/web-search/web-search-panel.test.ts`, **new** `frontend/src/features/plugins/web-search/web-search-oauth-action.test.ts`, `frontend/src/features/plugins/web-search/WebSearchPanel.tsx`, `backend/src/plugins/web-search/connection.ts`.

- [ ] **Write the failing markup matrix** in `frontend/src/features/plugins/web-search/web-search-panel.test.ts`, replacing the supported-only OAuth-action test:

```typescript
it('offers a labeled real support check for unverified providers and connect only for supported ones', () => {
  const html = renderToStaticMarkup(createElement(WebSearchPanel, {
    client: mockClient(),
    initialStatus: makeStatus(item => ({
      ...item,
      authSupport: {
        apiKey: 'supported',
        browserAuthorization: item.provider === 'tinyfish' ? 'unverified'
          : item.provider === 'keenable' ? 'supported' : 'unsupported',
      },
    })),
  }));
  expect(html).toContain('Check TinyFish browser authorization support');
  expect(html).toContain('Connect Keenable account');
  expect(html).not.toContain('Connect TinyFish account');
  expect(html).not.toContain('Check Exa browser authorization support');
  expect(html).not.toContain('Connect Exa account');
});
```

- [ ] **Create the failing component-handler test** at `frontend/src/features/plugins/web-search/web-search-oauth-action.test.ts` with this complete content, including the mandatory header. This follows the existing hook-stub/tree-handler pattern in `frontend/src/features/voice/dictation/composer-events.test.ts`; it is not a new renderer/dependency:

```typescript
/**
 * ============================================================================
 * FILE: web-search-oauth-action.test.ts
 * LOCATION: frontend/src/features/plugins/web-search/web-search-oauth-action.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify unverified OAuth actions use the real client and safe error path.
 *
 * ROLE IN PROJECT:
 *    Node-only component-handler fixture proving rendered support-check wiring.
 *    It is not browser or live provider compatibility evidence.
 *
 * KEY COMPONENTS:
 *    - Hook stubs and rendered action traversal.
 *    - Closed fetch and real-client/reducer error projection.
 * ============================================================================
 */

import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createWebSearchClient } from '../../../api/web-search-client.ts';
import { WEB_SEARCH_PROVIDERS, type WebSearchPublicStatus } from '../../../api/web-search-protocol.ts';
import { WebSearchPanel } from './WebSearchPanel.tsx';
import {
  mapWebClientError, type WebSearchSetupAction, type WebSearchSetupState,
} from './web-search-setup-state.ts';

const hooks = vi.hoisted(() => ({ state: undefined as WebSearchSetupState | undefined }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: () => {},
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    useState: (value: unknown) => [value, vi.fn()],
    useReducer: (
      reducer: (state: WebSearchSetupState, action: WebSearchSetupAction) => WebSearchSetupState,
      initial: WebSearchSetupState,
    ) => {
      hooks.state ??= initial;
      return [hooks.state, (action: WebSearchSetupAction) => {
        hooks.state = reducer(hooks.state!, action);
      }];
    },
  };
});

type NodeProps = { children?: ReactNode; onClick?: () => void; disabled?: boolean };
function nodes(value: ReactNode): ReactElement<NodeProps>[] {
  if (!isValidElement<NodeProps>(value)) return [];
  if (typeof value.type === 'function') {
    // Only expand the local card; ConfirmDialog and other components are not under test.
    if (value.type.name !== 'ProviderCard') return [];
    return nodes((value.type as (props: unknown) => ReactNode)(value.props));
  }
  return [value, ...Children.toArray(value.props.children).flatMap(nodes)];
}
function initialStatus(): WebSearchPublicStatus {
  return {
    protocolVersion: 1, revision: 7, enabled: false, effectiveEnabled: false,
    providers: WEB_SEARCH_PROVIDERS.map(provider => ({
      provider, state: 'not-connected', authMethod: null,
      authSupport: { apiKey: 'supported', browserAuthorization: 'unverified' },
      capabilities: { browse: false, fetch: false }, lastValidatedAt: null,
    })),
  };
}
beforeEach(() => { hooks.state = undefined; });

it.each(['WEB_AUTH_UNSUPPORTED', 'WEB_PROVIDER_UNAVAILABLE'] as const)(
  'unverified support action calls oauth/start and displays real %s without changing support', async code => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      protocolVersion: 1, error: { code, retryable: code === 'WEB_PROVIDER_UNAVAILABLE', currentRevision: null },
    }, { status: code === 'WEB_AUTH_UNSUPPORTED' ? 422 : 502 }));
    const navigate = vi.fn();
    const client = createWebSearchClient({ fetch: fetcher });
    const tree = WebSearchPanel({ client, initialStatus: initialStatus(), onNavigateUrl: navigate });
    const button = nodes(tree).find(node =>
      node.type === 'button' && node.props.children === 'Check TinyFish browser authorization support');
    expect(button).toBeDefined();
    expect(button!.props.disabled).toBe(false);
    button!.props.onClick!();
    await vi.waitFor(() => { expect(hooks.state?.error).toBe(mapWebClientError(code)); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('/api/plugins/web-search/providers/tinyfish/oauth/start');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ protocolVersion: 1, expectedRevision: 7 });
    expect(hooks.state?.pending).toBeNull();
    expect(hooks.state?.status).toEqual(initialStatus());
    expect(navigate).not.toHaveBeenCalled();
    const rerendered = WebSearchPanel({ client, initialStatus: initialStatus(), onNavigateUrl: navigate });
    expect(nodes(rerendered).some(node => node.props.children === mapWebClientError(code))).toBe(true);
  },
);

it('unverified support action navigates only after actual successful oauth/start, without declaring support', async () => {
  const authorizationUrl = 'https://clerk.tinyfish.ai/oauth/authorize?state=fixture-state';
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({
    protocolVersion: 1, authorizationUrl, expiresAt: '2026-11-15T00:10:00.000Z',
  }));
  const navigate = vi.fn();
  const tree = WebSearchPanel({
    client: createWebSearchClient({ fetch: fetcher }),
    initialStatus: initialStatus(), onNavigateUrl: navigate,
  });
  const button = nodes(tree).find(node =>
    node.type === 'button' && node.props.children === 'Check TinyFish browser authorization support');
  expect(button).toBeDefined();
  expect(navigate).not.toHaveBeenCalled();
  button!.props.onClick!();
  await vi.waitFor(() => { expect(navigate).toHaveBeenCalledWith(authorizationUrl); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(hooks.state?.status).toEqual(initialStatus());
});
```

The new test does not invoke effects, provide a DOM, or certify a browser. `createWebSearchClient` is real; only its injected fetch is closed/local. Keep the original static-markup test in its separate module so hook mocks cannot affect server rendering there.

- [ ] **Verify B2 red (CWD `frontend`).**

```powershell
npm test -- src/features/plugins/web-search/web-search-panel.test.ts src/features/plugins/web-search/web-search-oauth-action.test.ts
```

Expected: support-check markup/action absent; handler tests cannot find the button.

- [ ] **Minimal affordance implementation** in `frontend/src/features/plugins/web-search/WebSearchPanel.tsx`. Replace only the existing OAuth action condition and label:

```tsx
{providerState.authSupport.browserAuthorization !== 'unsupported' ? (
  <button
    type="button"
    className="aurvin-admin-button"
    disabled={disabled || pendingKind !== null}
    onClick={() => {
      void onStartOAuth(catalog.provider);
    }}
  >
    {pendingKind === 'oauth-start' ? 'Starting…'
      : providerState.authSupport.browserAuthorization === 'supported'
        ? `Connect ${catalog.displayName} account`
        : `Check ${catalog.displayName} browser authorization support`}
  </button>
) : null}
```

Do not change `handleStartOAuth`, navigation, reducer, HTTP client, response schema, or support constants. The plain button remains keyboard accessible and existing mutation/pending locks still apply. Update this file's header and the static-test header to mention the unverified support check.

- [ ] **Delete the dead setter** from `backend/src/plugins/web-search/connection.ts`, leaving `installOAuth`'s `entry.oauthSupport.set(provider, 'supported')` untouched:

```typescript
markOAuthSupported(userId: string, provider: WebSearchProvider): void {
  this.owner(userId).oauthSupport.set(provider, 'supported');
}
```

Before deletion, confirm callers with `git grep -n "markOAuthSupported" -- backend/src backend/test frontend/src`. Expected: only the method definition. After deletion, the same search should return no matches (exit 1 is expected). Do not add a replacement setter or optimistic discovery-status update.

- [ ] **Verify B2 green (CWD `frontend`).**

```powershell
npm test -- src/features/plugins/web-search/ src/features/plugins/integration-tests/web-search-flow.test.ts src/api/web-search-client.test.ts
```

Expected: supported/unverified/unsupported matrix, both real error mappings, success navigation, and unchanged API-key/secret tests all pass.

- [ ] **Group B complete verification.** Run each command separately:

| CWD | Exact command | Expected |
| --- | --- | --- |
| `backend` | `npm test -- test/plugins/web-search/ --no-file-parallelism` | All deterministic plugin fixtures pass. |
| `backend` | `npm run build` | Pass. |
| `backend` | `npm run lint` | No new errors. |
| `backend` | `npm test` | Compare to fresh preflight baseline; no new failures. |
| `backend` | `npm run test:e2e` | Pre-existing voice-bootstrap failure may persist; compare exact failures/skips. |
| `frontend` | `npm run build` | Pass, baseline chunk warning allowed. |
| `frontend` | `npm run lint` | No new errors. |
| `frontend` | `npm test` | All routine cases pass. |

Do not claim AC7 clean if the suite is red; report task-focused green versus pre-existing full-suite failures distinctly. Fix any new owned-path failure before committing; route unrelated defects back to the orchestrator with the reproducer.

- [ ] **Commit only Group B (root).**

```powershell
git add backend/src/plugins/web-search/providers.ts backend/src/plugins/web-search/connection.ts backend/src/plugins/web-search/oauth.ts backend/test/plugins/web-search/providers.spec.ts backend/test/plugins/web-search/fixtures.ts backend/test/plugins/web-search/oauth.spec.ts frontend/src/features/plugins/web-search/WebSearchPanel.tsx frontend/src/features/plugins/web-search/web-search-panel.test.ts frontend/src/features/plugins/web-search/web-search-oauth-action.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat(web-search): enable gated TinyFish Clerk OAuth"
```

## Group C — Documentation reconciliation

**Atomic commit message:** `docs(web-search): reconcile TinyFish authentication evidence`

### Task C1 — Check current claims, replace only stale current guidance

**Files:** `README.md`, `docs/web-search/verification.md`, `docs/web-search/state.md`, `docs/web-search/operations.md`.

Documentation-only group: use the inline assertion/link check below, not a new framework/test file or unrelated application reruns.

- [ ] **Write/run the failing document check first** from repository root. Paste this PowerShell command verbatim; it writes no repository files. The planner executed this exact check and observed the expected `README.md: stale unsupported key claim` failure:

```powershell
node -e "const assert = require('node:assert/strict'); const {readFileSync,existsSync} = require('node:fs'); const {dirname,resolve} = require('node:path'); const paths = ['README.md','docs/web-search/verification.md','docs/web-search/state.md','docs/web-search/operations.md']; for (const path of paths) { const text = readFileSync(path,'utf8'); assert(!/TinyFish (?:hosted[- ]MCP )?API-key(?:-over-MCP| auth)? (?:is |remains )?(?:\*\*)?unsupported/i.test(text),path + ': stale unsupported key claim'); assert(!/TinyFish API-key-over-MCP rejected before request/i.test(text),path + ': stale pre-request rejection'); assert(text.includes('0/5'),path + ': missing authenticated live-test limitation'); assert(text.includes('offline_access'),path + ': missing explicit scope decision'); assert(text.includes('clerk.tinyfish.ai'),path + ': missing evidenced Clerk origin'); for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) { const target = match[1]; if (/^(?:https?:|mailto:|#)/.test(target)) continue; assert(existsSync(resolve(dirname(path),target.split('#')[0])),path + ': broken link ' + target); } } const verification = readFileSync('docs/web-search/verification.md','utf8'); for (const phrase of ['DCR response','loopback','token exchange','refresh','skipped']) assert(verification.includes(phrase),'verification: missing ' + phrase); console.log('TinyFish documentation/link assertions passed');"
```

Expected before edits: stale unsupported assertion fails. Current README/state do not yet include the scope/origin decision either.

- [ ] **Update `README.md` Web Search compatibility sentence** to this current statement, preserving surrounding feature/limit text and links:

```markdown
Provider compatibility is **0/5 live-tested** for authenticated MCP/OAuth flows. TinyFish's `Authorization: Bearer` API-key path is vendor-documented and fixture-tested, not live-verified. Unauthenticated metadata was observed at `https://clerk.tinyfish.ai`; its exact origin is now pinned for capability-gated OAuth with explicit `offline_access` only. Browser OAuth remains fixture-proven only: DCR response shape, exact loopback acceptance, token exchange, and refresh are unverified live. Page fetch remains admitted for all five providers under Aurvin's client-side URL guard and untrusted-evidence prompt guardrail; provider-side redirect/private-network behavior remains unverified.
```

- [ ] **Reconcile `docs/web-search/verification.md`.** Replace present-tense TinyFish unsupported language in the opening outcome, old AC4 limitation, compatibility row, and final limitations. Preserve the original P5 run table/counts/tested SHAs as historical results; add a dated “15 November 2026 — TinyFish authentication follow-up” section rather than implying P5 ran new tests. Use this TinyFish row under the existing seven-column compatibility table:

```markdown
| TinyFish | `https://agent.tinyfish.ai/mcp`; vendor-documented `Authorization: Bearer sk-tinyfish-...` | Bearer-key connect/probe/rejection and browse/fetch mapping; Clerk-shaped OAuth start/complete with `offline_access` | unrun (0/5 authenticated) | unrun; fixtures only; unauthenticated metadata observed separately | `verified` (client-guarded); provider-side redirects unverified | Exact `https://clerk.tinyfish.ai` pin; DCR response shape, exact loopback acceptance, token exchange and refresh unverified live |
```

In that dated section:
  - Link `[TinyFish metadata research](../web-search-tinyfish-auth/research.md)`; say the path-specific resource and Clerk OAuth documents returned 200. Do not call these authenticated MCP/live OAuth tests.
  - Record actual A/B commit hashes from `git log`, exact package commands, pass/fail/skip counts from worker output, and preserved pre-existing failures. Do not copy baseline counts as new results.
  - State that support remains `unverified` until real successful completion/install, the panel support check calls `oauth/start`, and the requested/registered scope is exactly `offline_access`.
  - State verbatim: “DCR response shape is unverified live; exact loopback acceptance is unverified live; token exchange and refresh are unverified live. Authenticated provider compatibility remains 0/5 live-tested. Review is skipped, never passed.”
  - Explain that any scope/DCR refusal fails closed; no implicit default scopes or broader retry.

The original AC numbers in this file belong to the older Web Search goal; do not relabel them as this workflow's AC1–AC8.

- [ ] **Reconcile `docs/web-search/state.md`.** Update the current compatibility/P2 gated notes and final current-gate limitations that say key setup is rejected/unsupported. Replace current guidance with:

```markdown
- TinyFish follow-up (15 November 2026): Bearer API-key-over-MCP is vendor-documented and fixture-tested through the generic connect/probe-before-save path; authenticated compatibility remains 0/5 live-tested. Unauthenticated metadata evidences `https://clerk.tinyfish.ai`, now an exact pinned origin. TinyFish OAuth explicitly registers/requests only `offline_access`; support stays unverified until confirmed completion. DCR response shape, exact loopback acceptance, token exchange and refresh remain unverified live. Review remains skipped.
```

Use actual A/B commits in the follow-up record. Mark planning-time blockers/old P2 handoff snapshots as **historical, superseded by this follow-up**, rather than erasing their dated results or claiming old tests covered the change. When preserving history, rephrase the old key verdict as “P2 originally refused key setup (historical, superseded)” instead of retaining the current-verdict strings rejected by the document check. Current fetch wording must agree with existing `fetchSafety: 'verified'` client-guarded admission; older “closed for all five” claims may remain only as explicitly historical snapshots. Do not reopen or mark this new workflow complete in the old workflow state.

- [ ] **Reconcile `docs/web-search/operations.md`.** Replace the unsupported phrase in “Scope and evidence” with the same documented/fixture/live distinction. Replace the stale D1 paragraph (which still claims wrong console links) with “The delivered frontend catalog matches the approved console destinations after D1 was resolved at `26c6461`.” Add this setup guidance after the provider table:

```markdown
TinyFish keys use the documented `sk-tinyfish-...` format and the hosted MCP header `Authorization: Bearer <key>`; `X-API-Key` is not the TinyFish MCP route. Aurvin validates the candidate with the existing bounded MCP probe before encrypted save. A rejected key leaves no new connection and never invokes another provider as a setup fallback. This is vendor-documented and fixture-tested, not live authenticated verification.
```

After the OAuth binding paragraph add:

```markdown
For unverified providers, “Check {provider} browser authorization support” runs the real `oauth/start` check and may continue to provider consent only if it succeeds; errors are surfaced without claiming support. TinyFish additionally pins exactly `https://clerk.tinyfish.ai` and explicitly registers/requests `offline_access` only, not Clerk profile/email/metadata scopes. Metadata observation is not a completed flow: DCR response shape, exact loopback acceptance, token exchange and refresh remain unverified live; authenticated compatibility is still 0/5 live-tested. Do not widen scopes, allow origins, accept a client secret, follow redirects, or fall back to REST/keyless to bypass a refusal.
```

- [ ] **Verify documentation green.** Re-run the exact inline Node check above from root, then run these as separate commands:

```powershell
git diff --check
git diff -- README.md docs/web-search/verification.md docs/web-search/state.md docs/web-search/operations.md
git grep -n -i -E 'TinyFish.*(unsupported|rejected before)|0/5|clerk.tinyfish.ai|offline_access|review.*skipped' -- README.md docs/web-search/verification.md docs/web-search/state.md docs/web-search/operations.md
```

Expected: inline assertions and local links pass; any remaining “unsupported” describes actual fail-closed errors, explicitly historical evidence, or another mode—not a current categorical key verdict. No missing artifacts, fabricated results, new live-flow claim, or review-passed claim.

- [ ] **Commit only Group C (root).**

```powershell
git add README.md docs/web-search/verification.md docs/web-search/state.md docs/web-search/operations.md
git diff --cached --check
git diff --cached --name-only
git commit -m "docs(web-search): reconcile TinyFish authentication evidence"
```

## Worker completion handoff

- [ ] Record the three implementation commit hashes, files actually changed, and exact red/green commands/results; give them to the orchestrator for this workflow's final verification/report.
- [ ] Confirm no changes to package manifests/lockfiles, auth gate bodies, `redirect: 'error'`, unrelated dirty files, or the untracked user test.
- [ ] Report focused fixture success separately from full-suite pre-existing failures, native-prerequisite skips, Node-only UI evidence, and **all live checks unrun**. Metadata probe evidence already exists; no repeated probe is required or authorized by this plan.
- [ ] Call out residual risks instead of hiding them: dynamic-client policy may reject `offline_access`; DCR may reject metadata/loopback or return a secret; consent/token exchange/refresh may fail. Preserve those denials and surface them through the existing UI. No authenticated production-readiness claim.

## Acceptance/self-check map

| Criterion | Planned evidence |
| --- | --- |
| AC1 | A1 status/connection fixture and A2 real-SDK normal `connect`, explicit probe and encrypted confirmed record. |
| AC2 | A1 default/warm/connected support projections, A3 masked input and documented format/header. |
| AC3 | A2 real 401 and rejected-probe cases: no record/write/published provider/fallback; malformed-key guards retained. |
| AC4 | Existing committed research with exact probe URLs/status/bodies; C links it without reclassifying it as authenticated verification. |
| AC5 | B1 exact-origin assertion, observed Clerk-shaped discovery, scope-pinned DCR/start/complete and confirmed-install support; off-origin/secret denials. |
| AC6 | B2 action-state matrix, actual rendered handler → real client → local `oauth/start` response/error → safe rendered error; no support guess. |
| AC7 | A/B package build/lint/focused/full commands; current voice-bootstrap baseline reproduced and historical failures distinguished from fresh results. |
| AC8 | C four-document consistency/link check, accurate live residuals and 0/5 count, review explicitly skipped. |

Plan self-check: no new architecture/dependency/state machine, no conditional future OAuth plan, no placeholders in implementation steps, exact paths/commands/commit boundaries supplied. The only new source-tree file is a test with the mandatory header; application changes reuse existing paths and guard functions.
