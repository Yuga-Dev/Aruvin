# Model Selection and Reasoning Effort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a super-admin select a live-catalogue OpenRouter chat model, choose its declared reasoning effort, and check static compatibility before safely saving deployment-wide settings.

**Architecture:** Extend the existing strict settings, catalogue gate, prepare/CAS/publish flow, and immutable attempt snapshots. Share one pure catalogue evaluator between check and activation, and extend the existing shared serializer for effort and the documented equivalent output cap. Use a filtered native model select and the current reducer/client patterns, not another runtime or configuration framework.

**Tech Stack:** Existing TypeScript/NodeNext, Nest/Express, Zod 3, `@langchain/openrouter`, React 19/Vite, native fetch/select, and Vitest fixtures; no new dependency.

---

## Authorization, execution rules, and prerequisites

**This is a plan, not implementation authorization.** The user authorized one
planner only. Stop after the planning handoff. The skill names in the required
header describe a future execution workflow; they do not authorize spawning
agents now or override a future user's delegation constraints.

Read [goal.md](goal.md), [research.md](research.md), and root `AGENTS.md` before
future execution. Unified review is **skipped**, not passed; do not dispatch a
reviewer. Do not access application data, `.env`, saved credentials, real Calendar
data, or paid providers for routine verification. Fixtures use explicit fake keys.
Never restart an existing service or run a second backend against its database.

Baseline: application `c50017b`, approved planning scope `aeea3f4`, research
`5972929`. Preserve unrelated voice-benchmark work and `.openchamber/`.
Use named staging paths and small commits. All code snippets below are planned
changes, not claims they exist or tests passed. New code/test files need the
repository's mandatory file header before the shown imports; retain existing
headers and add them when modifying >30% of a headerless file.

Commands are run in the stated package directory, not the repository root.
Use the repository-supported Node version; `npm ci` only if dependencies are
missing/out of sync. Do not update dependencies/lockfiles for this feature.

## Locked contracts and policy decisions

### 1. Setting, migration, and attempt binding

```ts
export const REASONING_EFFORTS =
  ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'] as const;
export type ExplicitReasoningEffort = typeof REASONING_EFFORTS[number];
export type ReasoningEffort = 'provider-default' | ExplicitReasoningEffort;
// Required normalized field in ManageableSettings.openRouter and runtime shape:
// reasoningEffort: ReasoningEffort
```

- Default `"provider-default"` emits **no reasoning field**. It does not emit
  `"medium"`, `enabled`, `default_effort`, or an implicit disable.
- Explicit choice emits `reasoning: { effort, exclude: true }`. Do not request,
  store, render, log, or replay private reasoning. Existing frame parsers remain
  the authority for visible content; test ignored reasoning fields.
- Keep schema/protocol version 1. Extend the existing **stored-only** preprocess
  to fill absent `openRouter.reasoningEffort`. Do not accept missing/null/unknown
  effort in new settings requests; do not make all settings optional.
- Missing stored property is normalized in memory with no startup write,
  revision bump, or credential-envelope change. Explicit malformed values still
  fail closed. The next normal CAS persists the normalized setting.
- Defaults, legacy import, and `loadConfig` fixtures use Provider default.
  No new `.env` effort setting or browser override.
- `VerifiedModelLimits` retains `supportsMaxTokens` for existing fixture/port
  compatibility and adds `outputCapParameter?: 'max_tokens' |
  'max_completion_tokens'`. New catalogue limits always set it.
  Resolve a legacy true `supportsMaxTokens` to `max_tokens`; false without a
  verified alternative is invalid. Reject contradictory combinations rather
  than silently choosing a cap.
- New catalogue entries prefer declared `max_tokens`; otherwise use declared
  `max_completion_tokens`. Emit exactly one total cap. Never replace the total
  cap with `reasoning.max_tokens`, remove it, or disable `require_parameters`.
- Snapshot at existing admission boundaries: text attempt; explicit retry is a
  new attempt with current settings; automatic rejection retry/tool repair/tool
  continuation keeps the accepted snapshot. Voice sessions/reconnects keep their
  existing session snapshot; new calls use the latest deployment config.
  No runtime settings lookups or catalogue requests are added before inference.

### 2. Bounded public API

Add under the existing protected `/api/admin/config` controller:

- `GET /api/admin/config/models`, no query/body: redacted catalogue list.
- `POST /api/admin/config/model-compatibility`, no query: body is the same strict
  `{ protocolVersion: 1, expectedRevision, settings }` as settings save.
  It is a **read-only POST**, never an uncertain mutation.
- `PUT /api/admin/config` remains the only settings save; no client check token
  or `compatible: true` is accepted or trusted.

Add `ADMIN_CONFIG_ROUTES.models = '/admin/config/models'` and
`ADMIN_CONFIG_ROUTES.modelCompatibility = '/admin/config/model-compatibility'`.
Export strict `isModelCatalogueResponse` and `isModelCompatibilityResponse`
guards from the backend wire contract and frontend mirror.

Public definitions go in `admin-config-wire.ts` and its frontend mirror. Keep
names/signatures consistent throughout this plan:

```ts
export type ModelCatalogueItem = {
  id: string; name: string;
  reasoning: {
    selection: 'declared' | 'all' | 'unavailable' | 'unknown';
    efforts: ExplicitReasoningEffort[];
    mandatory: boolean | null;
  };
};
export type ModelCatalogueResponse = {
  protocolVersion: 1;
  observedAt: string;
  models: ModelCatalogueItem[];
};
export type ModelCompatibilityCode =
  | 'MODEL_REQUIRED' | 'MODEL_NOT_LISTED' | 'TEXT_CHAT_UNSUPPORTED'
  | 'TEXT_CHAT_EVIDENCE_MISSING' | 'CONTEXT_CAPACITY_MISSING'
  | 'CONTEXT_CAPACITY_TOO_SMALL' | 'OUTPUT_CAPACITY_MISSING'
  | 'OUTPUT_CAPACITY_TOO_SMALL' | 'OUTPUT_CAP_UNSUPPORTED'
  | 'OUTPUT_CAP_EVIDENCE_MISSING' | 'EFFORT_UNSUPPORTED'
  | 'EFFORT_EVIDENCE_MISSING' | 'REASONING_REQUIRED'
  | 'CONTEXT_FLOOR_NOT_MET' | 'FIXED_CONTEXT_DOES_NOT_FIT'
  | 'CATALOGUE_UNAVAILABLE' | 'CATALOGUE_RESPONSE_INVALID';
export type ModelCompatibilityWarning =
  | 'PRIVACY_ROUTE_UNVERIFIED' | 'STREAMING_UNTESTED'
  | 'TOOL_BEHAVIOR_UNTESTED' | 'REASONING_CONTINUITY_UNTESTED'
  | 'REASONING_USES_OUTPUT_BUDGET' | 'CREDENTIAL_NOT_CONFIGURED'
  | 'CALENDAR_PRICE_UNVERIFIED';
export type ModelCompatibilityReport = {
  status: 'catalogue-compatible' | 'incompatible' | 'unable-to-verify';
  blockers: Array<{ code: ModelCompatibilityCode; path: AdminConfigFieldPath | null }>;
  warnings: ModelCompatibilityWarning[];
  contextTokens: number | null;
  outputTokens: number | null;
  outputCapParameter: 'max_tokens' | 'max_completion_tokens' | null;
  chatFloor: ChatFloor;
  capabilities: {
    calendar: 'declared-available' | 'unavailable' | 'unknown';
    webTool: 'declared-available' | 'unavailable' | 'unknown';
    pricing: 'usable' | 'unverified';
  };
};
export type ModelCompatibilityResponse = {
  protocolVersion: 1;
  candidate: {
    revision: number; modelId: string; reasoningEffort: ReasoningEffort;
    chat: ChatLimits;
  };
  checkedAt: string; catalogueObservedAt: string | null; expiresAt: string;
  report: ModelCompatibilityReport;
};
```

No arbitrary provider error text/messages, raw catalogue descriptions, account
data, API keys, or raw price records leave the backend. UI maps closed codes to
static safe explanations. `candidate.revision` is the **whole config revision**:
it conservatively fences saved credential changes without exposing credential
fingerprints. A check begun at revision N fails with existing CONFIG_CONFLICT if
revision changes before it returns. Another browser's unseen update can still
make a displayed result stale; save revalidates and CAS remains decisive.

Bounds:

- Upstream fixed-host unauthenticated GET
  `https://openrouter.ai/api/v1/models?output_modalities=all`, redirects rejected,
  4 MiB response, <=2,000 entries, no automatic retry, total headers/body deadline
  `min(connectTimeoutMs, 10_000)`. Use `readJson`; never accept partial data or
  infer missing membership from an incomplete/truncated list.
- Internal acquisition keeps all entries to explain non-chat/missing configured
  IDs. UI list includes every verifiably text-input/text-output Chat Completions
  entry, not just compatible entries. Capacity/tool/effort failures do not hide a
  selectable chat model. IDs <=200 characters, names <=200, no control chars;
  duplicate/invalid IDs or overflow invalidate the response. Missing/invalid name
  falls back to its valid exact ID; do not silently rewrite IDs.
- Model list <=1 MiB serialized, <=2,000 items, seven efforts/item; existing
  config/check/error responses remain <=64 KiB. Arrays: <=12 blockers, <=8 unique
  warnings. Exact-key guards validate dates, enums, finite positive capacities,
  nullable fields, and candidate numeric limits. Reject rather than truncate an
  oversized list or add unbounded fields.
- Only the **listing** gets an in-memory 60-second cache plus single-flight
  refresh. No stale-success fallback after expiry/fetch failure, disk cache,
  background timer, secret-keyed cache, or browser localStorage.
- Explicit check and every configured save/credential activation fetch fresh
  metadata and repeat evaluation; never use the listing cache or earlier UI result
  as admission. Check result expires after 60 seconds for UI use.
- Reuse service validation budget (two external validations in flight, six starts
  per rolling 60 seconds) for listing misses/checks/admin preparation, including
  saves that fetch. Release capacity in `finally`; cache hits do not fetch.
  Existing HTTP 60/min, 16 KiB/5s body, TLS/origin/auth/no-store defenses stay.
  Startup/import use the same bounded acquisition/evaluator without a browser
  validation-rate dependency. No global scheduler.
- Both new routes must skip optional owner warming in
  `backend/src/http/configure-private-http.ts`. Today that middleware calls
  `prepareOwner` for all private requests, which can read Calendar connection/
  discovery state. Skip only the exact GET models and POST check paths, **after**
  full-account/session/super-admin/origin admission. Keep identity attachment,
  account freshness, admin transport/body/rate limits, and revision reads.

### 3. Shared compatibility evaluator

In existing `backend/src/model/catalogue.ts` define these feature-specific seams,
not a generic provider abstraction:

```ts
export type CatalogueSnapshot = {
  observedAt: string; entries: Record<string, unknown>[];
};
export type CompatibilityConfig = Pick<ModelConfig, 'budgets'> & {
  openRouter: Omit<ModelConfig['openRouter'], 'apiKey'>;
};
export type ModelEvaluation = {
  report: ModelCompatibilityReport; limits: ModelLimits | null;
};
export function readModelCatalogue(
  signal: AbortSignal, timeoutMs: number, fetcher?: typeof fetch,
): Promise<CatalogueSnapshot>;
export function projectModelCatalogue(snapshot: CatalogueSnapshot): ModelCatalogueResponse;
export function evaluateModelCompatibility(
  config: CompatibilityConfig, assets: FixedAssets, snapshot: CatalogueSnapshot,
  calendarEvidence?: CalendarCatalogueEvidence,
): ModelEvaluation;
export function catalogueEfforts(entry: Record<string, unknown>): ModelCatalogueItem['reasoning'];
```

These are named implementation targets; implement all signatures in Tasks 2–3.
`ModelCompatibilityFault extends AppError` has existing `CONFIGURATION_ERROR`
code, static safe message, and a readonly `report`. Its report is closed public
data, not a raw cause. `loadModelLimits` retains its callable signature; add an
optional final `assets?: FixedAssets` parameter and pass assets from
`prepareConfigurationSnapshot`/`prepareTextConfiguration`. For direct legacy
callers without assets, still enforce model caps/efforts/modalities; production
activation always supplies assets. Never call `activation.prepare` from check:
it mutates `AppService.lastPrepared`.

Rules, in deterministic order:

1. Reuse `validateManageableSettings`/`composeRuntimeBudgets` at both service and
   activation edges. The pure evaluator uses `computeChatFloor`,
   `assertFixedContextFits` and existing finite context checks, never a browser
   estimator or relaxed history requirement. If optional assets are absent for
   legacy direct limit callers, do not fabricate a public floor; those callers
   consume limits only. Keep one private model-evidence core inside this module:
   `evaluateModelEvidence(config, snapshot, calendarEvidence?)` returns the report
   fields other than `chatFloor`, plus limits. Public evaluation adds the actual
   asset checks/floor. Asset-less legacy loader failures remain a generic
   CONFIGURATION_ERROR rather than a fabricated public report; production passes
   assets and preserves the typed compatibility report.
2. Empty draft ID: incompatible MODEL_REQUIRED. Complete catalogue lacks exact
   ID: incompatible MODEL_NOT_LISTED. Malformed/partial catalogue: unable to
   verify, not “not listed.”
3. Positive declared text input/output **and** `/api/v1/chat/completions` endpoint:
   applicable. Explicit exclusion: incompatible. Missing/malformed applicability
   evidence: unable to verify. Do not infer support from model/vendor names.
4. Context/output capacities must be positive safe integers. Unknown/null/
   unsafe/noninteger: unable to verify. Valid but below candidate's
   `maxContextTokens`/`maxOutputTokens`: incompatible. Context is a combined
   prompt/output window; keep output+margin reservation.
5. Supported parameters must be an actual bounded string array. Missing/malformed:
   unable to verify. Neither total cap present in a valid array: incompatible.
   Prefer `max_tokens`, otherwise documented `max_completion_tokens`.
6. Provider default needs no effort declaration and sends none, even for a
   mandatory reasoning model. Explicit effort requires declared `reasoning`
   parameter **and** per-model effort evidence. Valid supported array is exact,
   deduplicated gateway vocabulary/order; explicit null expands the gateway
   vocabulary, not a model-name table. Absent `supported_efforts`: only default;
   explicit effort incompatible/not exposed. Malformed/unknown vocabulary:
   unknown evidence, only default in UI, explicit effort unable to verify.
   `mandatory: true` always removes/rejects `none`, even if the array includes it.
   Malformed mandatory metadata cannot authorize disabling. `supports_max_tokens`
   is not an effort declaration. Do not use `default_effort` as a saved override.
7. Optional native tools and prices do not determine text admission:
   `tools` positive evidence sets webTool declared-available. Calendar additionally
   needs current usable pricing and existing strict/parallel requirements for
   supplied frozen evidence. Preserve `verifiedCalendar` pins and use
   `derivedCalendar` for unpinned models. Malformed/absent/negative/dynamic prices,
   mismatched pin, applicable/malformed pricing overrides, or different
   `internal_reasoning` unit price disable Calendar with a price warning.
   A valid `min_prompt_tokens` strictly above admitted max context cannot apply;
   otherwise do not add a tier-pricing subsystem or under-reserve.
8. Any concrete blocker makes status incompatible; otherwise missing required
   evidence makes unable-to-verify; otherwise catalogue-compatible. Optional
   capability unknowns remain warnings. No `limits` on non-success.
   Private route/stream/tool/reasoning continuity warnings remain on success.
   No catalogue claim that a data-collection-denied route actually exists.

Missing saved credentials do not change declared catalogue compatibility; add
CREDENTIAL_NOT_CONFIGURED warning and keep activation unconfigured. This permits
the existing first-save/add-key setup flow without a fake credential or a paid
probe. Diagnostic blank-model/key save/removal still uses local budget/floor
checks and publishes an **unconfigured**, non-inference snapshot, as today.
Do not let that path activate an incompatible configured model. UI does not
offer clearing an active model as a substitute for passing a check.

### 4. UI freshness and accessibility

- Controlled native search input + native model `<select>`, filtering name and
  ID case-insensitively in memory. Search has `maxLength=200`.
  Include current/draft selected ID even when filtered out or no longer listed.
  Missing ID displays “Configured model — not in current catalogue” and is not
  auto-replaced; selecting an incompatible **listed** model remains allowed.
  No arbitrary new free-text model ID override.
- Separate effort `<select>`: Provider default then the selected item's declared
  options. Absent metadata/list failure: default only with explanation.
  Preserve an existing explicit unsupported/missing effort as a disabled selected
  option so the user can see and reset it, not silently alter saved state.
  A user model-ID change resets **draft** effort to default in the reducer.
- Give labels, stable `fieldDomId` IDs, help/error `aria-describedby`,
  `aria-invalid`; native keyboard selection, visible focus; no fake ARIA roles.
  Announce loading/result/count with polite status, actionable failures with
  alert, and offer Retry catalogue / Check again. No raw provider error text.
- Every check is keyed to a canonical fixed tuple
  `JSON.stringify([baseline.revision, modelId, reasoningEffort, chat])`, using
  fixed-order normalized chat fields, not an unordered arbitrary object.
  Comparing all chat limits is deliberately conservative and cheap.
  Raw invalid edits invalidate before parsing; do not retain success while the
  user has an invalid numeric string.
- Reducer tracks monotonic `checkEpoch`; starting A then B cannot accept A,
  including A→B→A edits. Completion must match epoch, candidate key, current
  baseline revision and unexpired response. Server echoes candidate values;
  validate equality, not just requested key.
- Model/effort/chat edits, load/save/credential success, catalogue refresh,
  check failure, and revision conflict clear success/increment epoch. Abort
  previous requests on edit/unmount; epoch checks are still required when a mock
  or transport ignores abort. Credential edit **begin** invalidates; completion
  refreshes the revision. Never capture credential candidate text in reducer.
- Check/read errors use separate nonmutating state, not the mutation `failed`
  action that can set `uncertain`. Settings/CAS/credential failures keep their
  existing semantics. Check cannot mark anything saved/active.
- Save enabled for changed model/effort/relevant chat settings only when the matching
  nonexpired report is catalogue-compatible. Unrelated changes need no prior
  UI check but still go through server preparation; missing-initial blank model
  setup retains existing unconfigured saves. Same `saveLocked` helper gates the
  button and click handler. Checking never saves; Save always independently
  prepares again.
  `requiresCompatibilityCheck` compares model, effort, and these seven baseline
  fields: `maxInputChars`, `maxInputTokens`, `maxMessagesInContext`,
  `maxContextTokens`, `maxHistoryTokens`, `maxOutputTokens`, `modelMarginTokens`.
  All chat edits invalidate existing check results conservatively, but a
  title/rate/deadline-only edit with those seven fields unchanged needs no
  preceding UI check. This does not bypass server preparation.
- Show exact status labels, safe blockers, independent Calendar/web/pricing
  status, observation time, and explicitly “Actual routing, SSE streaming, tool
  behavior, and reasoning continuity: untested.” Explain reasoning may exhaust
  the finite output cap and leave little/no visible answer. No paid probe button.

## File responsibility/ownership map

One future implementer can execute serially; no parallel shared-file ownership
is needed. Task dependencies are linear unless stated otherwise.

| Task | Files/responsibility |
| --- | --- |
| 1 | `backend/src/contracts/{admin-config-wire.ts,admin-config.ts,config-runtime.ts}`, `backend/src/platform/config/{manageable-config.ts,load-config.ts}` and frontend `src/api/admin-config-protocol.ts`: normalized setting, strict guards/default migration, cap evidence contract |
| 2 | `backend/src/model/catalogue.ts`: pure capability/effort evaluation, existing optional-tool price derivation |
| 3 | `backend/src/model/{catalogue.ts,index.ts}`, `backend/src/app.service.ts`: bounded acquisition, production shared gate |
| 4 | `backend/src/model/{policy.ts,calendar-policy.ts,web-native.ts}`: all three serializer call sites, cap/effort binding |
| 5 | `backend/src/admin-config/{admin-config.service.ts,admin-config.controller.ts,errors.ts}`, `backend/src/app.service.ts`, `backend/src/http/configure-private-http.ts`: protected routes, listing cache/budget, no Calendar owner warming, check isolation and safe save errors |
| 6 | `frontend/src/api/admin-config-client.ts`: typed guarded nonmutating model requests using existing transport |
| 7 | `frontend/src/features/admin-config/config-edit-state.ts`: reset, freshness, save gating, closed reason copy |
| 8 | create `frontend/src/features/admin-config/ModelSelectionFields.tsx`; modify `ConfigFields.tsx`, `AdminDashboard.tsx`, `admin-config.css`: small presentational model controls and existing page orchestration |
| 9 | existing backend runtime/model/voice fixtures and frontend closed browser harness: cross-path regressions, no speculative runtime refactor |
| 10 | `README.md` (minimal feature/setup note), test/build evidence in handoff; workflow state/final records remain orchestrator-owned |

Exact test paths and fixture adjustments are specified in tasks. Do not modify
speech transport/model selection, persistence barriers, model request contracts
to accept browser effort, or unrelated benchmark source.

## Ordered bite-sized TDD tasks

### Task 1: Strict normalized setting and stored-only default

**Files**
- Modify: contract/default/runtime/frontend-mirror files in map row 1.
- Test: `backend/src/contracts/admin-config.spec.ts`
- Test: `backend/src/platform/config/manageable-config.spec.ts`
- Test: `backend/src/platform/config/legacy-config-import.spec.ts`
- Test: `frontend/src/features/admin-config/admin-config-client.test.ts`
- Fixture: `frontend/src/features/admin-config/testing/fixtures.ts`

- [ ] **1. Write a failing stored migration/default test** in the existing
  contract spec (imports `storedConfigDocumentSchema`, `defaultManageableSettings`
  already exist):

```ts
it('defaults only an absent stored reasoning effort without accepting malformed settings', () => {
  const settings = defaultManageableSettings();
  expect(settings.openRouter.reasoningEffort).toBe('provider-default');
  const legacy = JSON.parse(JSON.stringify({
    _id: 'aurvin', schemaVersion: 1, revision: 7, settings,
    credentials: { openrouter: null, deepgram: null },
    updatedAt: '2026-11-16T12:00:00.000Z', updatedBy: 'aurvin-dev-user',
  }));
  delete legacy.settings.openRouter.reasoningEffort;
  const normalized = storedConfigDocumentSchema.parse(legacy);
  expect(normalized.revision).toBe(7);
  expect(normalized.settings.openRouter.reasoningEffort).toBe('provider-default');
  expect(manageableSettingsSchema.safeParse(legacy.settings).success).toBe(false);
  for (const value of [null, 'automatic', 1]) {
    legacy.settings.openRouter.reasoningEffort = value;
    expect(storedConfigDocumentSchema.safeParse(legacy).success).toBe(false);
  }
});
```

- [ ] **2. Run red**: in `backend`,
  `npm test -- src/contracts/admin-config.spec.ts -t "absent stored reasoning"`.
  Expected FAIL: default setting has no `reasoningEffort`.
- [ ] **3. Implement the narrow schema/default changes**, including the frontend
  strict mirror and field path. Place the preprocess addition alongside existing
  stored defaults:

```ts
const router = record.openRouter;
if (router !== null && typeof router === 'object' && !Array.isArray(router) &&
    !Object.hasOwn(router, 'reasoningEffort')) {
  next = { ...next, openRouter: {
    ...(router as Record<string, unknown>), reasoningEffort: 'provider-default',
  } };
}
// manageableSettingsSchema.openRouter:
// reasoningEffort: z.enum(['provider-default', ...REASONING_EFFORTS])
// defaultManageableSettings/loadConfig:
// reasoningEffort: 'provider-default'
// buildRuntimeSnapshot.openRouter:
// reasoningEffort: clonedSettings.openRouter.reasoningEffort
```

  Add cap contract and one tiny shared resolver in `config-runtime.ts`:

```ts
export function verifiedOutputCap(limits: VerifiedModelLimits):
  'max_tokens' | 'max_completion_tokens' | null {
  if (limits.outputCapParameter === 'max_completion_tokens')
    return limits.supportsMaxTokens === false ? 'max_completion_tokens' : null;
  if (limits.outputCapParameter !== undefined &&
      limits.outputCapParameter !== 'max_tokens') return null;
  return limits.supportsMaxTokens === true ? 'max_tokens' : null;
}
```

  Use it in snapshot validation; retain source/model/capacity checks. Add
  declared `reasoningEffort` to both runtime and legacy config types. Extend
  public response/route/code types/strict guards from the locked contract above,
  plus optional `AdminConfigError.error.compatibility?: ModelCompatibilityReport`;
  old error shapes remain valid, extra unknown keys still fail. Add error codes
  `MODEL_CATALOGUE_UNAVAILABLE`, `MODEL_INCOMPATIBLE`, `MODEL_UNVERIFIED`.
  This task defines shapes; later tasks implement their behavior.
- [ ] **4. Add snapshot/import/mirror assertions and run green**. Prove normalized
  effort survives deep-freeze and never appears in encrypted credentials;
  legacy import still emits default and ignores no new env setting. Update exact
  expected OpenRouter object literals intentionally, not broad snapshots.
  Run backend `npm test -- src/contracts/admin-config.spec.ts src/platform/config/`;
  frontend `npm test -- src/features/admin-config/admin-config-client.test.ts`.
  Expected PASS after fixture literals include the required field.
- [ ] **5. Commit named files**: `feat(config): add default-safe reasoning effort contract`.
  Stage only the source/test/fixture files enumerated in this task.

### Task 2: Pure catalogue compatibility, including unknown evidence

**Files**
- Modify: `backend/src/model/catalogue.ts`
- Test: `backend/test/model/catalogue.spec.ts`
- Create: `backend/test/model/model-compatibility.spec.ts`

- [ ] **1. Write this executable failing test file** (prepend mandatory header):

```ts
import { expect, it } from 'vitest';
import { evaluateModelCompatibility, catalogueEfforts } from '../../src/model/catalogue.js';
import { config } from './helpers.js';
import { assets } from '../context/fixtures.js';
import { composeRuntimeBudgets, freshInstallSettings } from '../../src/platform/config/manageable-config.js';
import { loadBootstrapConfig } from '../../src/platform/config/bootstrap-config.js';

const settings = freshInstallSettings(assets);
const c = {
  ...config(),
  budgets: composeRuntimeBudgets(settings, loadBootstrapConfig({}).safety),
};
const entry = {
  id: 'fixture/model', name: 'Fixture',
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  endpoints: ['/api/v1/chat/completions'],
  context_length: 131072, top_provider: { max_completion_tokens: 8192 },
  supported_parameters: ['max_tokens', 'reasoning'],
  reasoning: { supported_efforts: ['high', 'low', 'none'], mandatory: true },
};
const snap = (value: Record<string, unknown>) => ({
  observedAt: '2026-11-16T12:00:00.000Z', entries: [value],
});
it('distinguishes absent and null effort metadata and mandatory reasoning', () => {
  expect(catalogueEfforts({ reasoning: {} })).toMatchObject({
    selection: 'unavailable', efforts: [],
  });
  expect(catalogueEfforts({ reasoning: { supported_efforts: null, mandatory: true } }))
    .toMatchObject({ selection: 'all',
      efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'] });
  const result = evaluateModelCompatibility({
    ...c, openRouter: { ...c.openRouter, reasoningEffort: 'none' },
  }, assets, snap(entry));
  expect(result.report.status).toBe('incompatible');
  expect(result.report.blockers).toContainEqual({
    code: 'REASONING_REQUIRED', path: 'openRouter.reasoningEffort',
  });
  expect(result.limits).toBeNull();
});
it('admits a declared equivalent finite cap but never an absent cap', () => {
  const good = evaluateModelCompatibility(c, assets, snap({
    ...entry, supported_parameters: ['max_completion_tokens'],
  }));
  expect(good.report.status).toBe('catalogue-compatible');
  expect(good.limits).toMatchObject({
    supportsMaxTokens: false, outputCapParameter: 'max_completion_tokens',
  });
  const bad = evaluateModelCompatibility(c, assets, snap({
    ...entry, supported_parameters: [],
  }));
  expect(bad.report.blockers).toContainEqual({
    code: 'OUTPUT_CAP_UNSUPPORTED', path: 'openRouter.modelId',
  });
});
```

- [ ] **2. Run red**: `npm test -- test/model/model-compatibility.spec.ts`.
  Expected FAIL: evaluator/effort exports do not exist.
- [ ] **3. Implement normalization/evaluation in the existing catalogue module**
  using the locked rules, retaining existing decimal/Calendar helpers.
  The effort core is small:

```ts
const metadata = object(entry.reasoning);
const mandatory = metadata.mandatory === true;
const raw = metadata.supported_efforts;
const available = raw === null ? [...REASONING_EFFORTS]
  : Array.isArray(raw) && raw.every(v =>
    typeof v === 'string' && REASONING_EFFORTS.includes(v as ExplicitReasoningEffort))
    ? [...new Set(raw as ExplicitReasoningEffort[])] : [];
const efforts = available.filter(e => !mandatory || e !== 'none');
// Object.hasOwn distinguishes absent from explicit null; malformed present
// metadata gets selection:'unknown', never the null/all semantics.
```

  Give `ModelCompatibilityFault` a static AppError message and report. Build
  limits only when required blockers are empty. Update pricing helpers with the
  conservative applicable-override/internal-reasoning checks from policy;
  return no Calendar evidence rather than guessing a price.
- [ ] **4. Expand the deterministic matrix and run green**:
  valid absent/null/empty/unknown effort lists; mandatory none; absent reasoning
  parameter; default with no metadata; endpoint missing/excluded; input/output
  modality missing/excluded; missing model; null/unsafe/fractional/zero context
  and output; below/exact cap limits; fixed assets/message count/floor overflow;
  unavailable versus incompatible precedence; tools without prices; prices without
  tools; zero known prices; dynamic/negative/invalid prices; mismatched frozen
  pin; override at/below/above ceiling; separate internal reasoning rate.
  Assert context isn't lowered, output isn't raised, and required privacy flags
  aren't changed. Add architecture/endpoints to old valid catalogue fixtures.
  Run `npm test -- test/model/catalogue.spec.ts test/model/model-compatibility.spec.ts`.
  Expected PASS with no HTTP/inference in pure tests.
- [ ] **5. Commit**: `feat(model): evaluate catalogue compatibility with precise blockers`.
  Stage only the three files above.

### Task 3: Bounded acquisition and one activation gate

**Files**
- Modify: `backend/src/model/catalogue.ts`, `backend/src/model/index.ts`
- Modify: `backend/src/app.service.ts:prepareConfigurationSnapshot`
- Test: `backend/test/model/catalogue.spec.ts`
- Test: `backend/test/assembly/admin-config.spec.ts`
- Test: `backend/src/scripts/import-config.spec.ts`

- [ ] **1. Add a red non-inference acquisition test** to catalogue spec:

```ts
it('reads public metadata without sending a saved key and rejects redirects', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }));
  const signal = new AbortController().signal;
  const snapshot = await readModelCatalogue(signal, 1000, fetcher);
  expect(snapshot.entries).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(
    'https://openrouter.ai/api/v1/models?output_modalities=all');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
});
```

  Import `readModelCatalogue` from `src/model/catalogue.js`.
- [ ] **2. Run red**: `npm test -- test/model/catalogue.spec.ts -t "public metadata"`.
  Expected FAIL: missing export.
- [ ] **3. Implement acquisition and make `loadModelLimits` use the evaluator**.
  Use `AbortSignal.any([outer, AbortSignal.timeout(Math.min(timeoutMs, 10000))])`,
  `readJson` and the fixed URL/byte/entry limits. Check pre-abort before fetch and
  recheck abort before returning. No saved-key header. Validate whole data shape;
  no caught error may return partial success.

```ts
const signal = AbortSignal.any([outer, AbortSignal.timeout(Math.min(timeoutMs, 10_000))]);
signal.throwIfAborted();
const response = await fetcher(`${OPENROUTER_BASE}/models?output_modalities=all`, {
  method: 'GET', redirect: 'error', signal,
});
if (!response.ok) {
  await response.body?.cancel().catch(() => undefined);
  throw new AppError('CONFIGURATION_ERROR', 'The model catalogue is unavailable.', false);
}
const raw = object(await readJson(response, TRANSPORT_LIMITS.catalogueBytes));
// Validate raw.data as a complete <=2000-entry array before projection/evaluation.
```

  Separate model-evidence evaluation from assets so public evaluation always has
  `chatFloor`, while old direct `loadModelLimits` tests still consume limits.
  Pass assets as the optional final loader argument from production snapshot
  preparation. For configured candidates, move the early generic
  `assertChatFloor`/`assertFixedContextFits` rejection into the shared typed
  evaluation path so check and save report the same floor blocker rather than
  CONFIG_ACTIVATION_UNAVAILABLE. Reuse those helpers, do not duplicate their
  estimator. Check the fixed constraints before network acquisition, returning
  only their concrete blockers when they already fail; proceed with catalogue
  evidence otherwise. Keep the existing local fixed checks when missing
  model/key produces an unconfigured snapshot. No `lastPrepared`/publication
  changes here.
  With assets supplied, acquisition errors also become a ModelCompatibilityFault:
  compute the real chatFloor, use unavailable/invalid catalogue code, null
  capacities/cap, unknown optional capabilities and unverified pricing; never
  propagate the raw exception. This gives save the same safe unavailable report
  as check, rather than falling back to a vague activation error.
- [ ] **4. Add body-hang/timeout/abort/HTTP/shape/size tests and run green**.
  Use fake timers and abort-aware fixture streams; assert cancellation releases
  the reader. Cover 4 MiB+1, >2,000 entries, duplicate IDs, malformed JSON,
  invalid arrays, redirects, 429/503 and fetch rejection; none returns raw errors.
  Update old exact URL/header assertions to intentional unauthenticated GET.
  Prove startup/import/save preparation all reach the same evaluator and
  incompatible preparation does not publish.
  Run `npm test -- test/model/catalogue.spec.ts test/assembly/admin-config.spec.ts src/scripts/import-config.spec.ts`.
- [ ] **5. Commit**: `feat(model): reuse bounded catalogue gate for configuration preparation`.
  Stage only this task's source/spec paths.

### Task 4: Shared effort/cap serialization on every request path

**Files**
- Modify: `backend/src/model/policy.ts`
- Modify: `backend/src/model/calendar-policy.ts`
- Modify: `backend/src/model/web-native.ts`
- Test: `backend/test/model/{policy.spec.ts,calendar-policy.spec.ts,web-native.spec.ts,adapter.spec.ts,calendar-stream.spec.ts}`

- [ ] **1. Write a failing actual serialized-body test** in policy spec:

```ts
it('sends explicit effort and the verified equivalent total cap without legacy cap leakage', () => {
  const c = { ...config, openRouter: {
    ...config.openRouter, reasoningEffort: 'high' as const,
  } };
  const l = { ...limits, supportsMaxTokens: false,
    outputCapParameter: 'max_completion_tokens' as const };
  const body = JSON.parse(JSON.stringify(buildBody(c, l, request())));
  expect(body).toMatchObject({
    model: 'fixture/model', max_completion_tokens: 2048,
    reasoning: { effort: 'high', exclude: true },
    provider: { data_collection: 'deny', require_parameters: true },
    transforms: [],
  });
  expect(body.max_tokens).toBeUndefined();
  expect(body.reasoning_effort).toBeUndefined();
});
```

- [ ] **2. Run red**: `npm test -- test/model/policy.spec.ts -t "verified equivalent"`.
  Expected FAIL: old `supportsMaxTokens` guard rejects alternative or effort absent.
- [ ] **3. Extend the shared serializer, not individual POST transports**:

```ts
// providerParameters receives the bound limits as its third required argument.
const cap = verifiedOutputCap(limits);
if (cap === null) throw new AppError('CONFIGURATION_ERROR',
  'The model configuration is unavailable.', false);
const effort = c.openRouter.reasoningEffort;
// Add this constructor option only for a validated explicit setting:
// ...(effort === 'provider-default' ? {} :
//   { modelKwargs: { reasoning: { effort, exclude: true } } })
const params: Record<string, unknown> = model.invocationParams({});
if (cap === 'max_completion_tokens') {
  delete params.max_tokens;
  params.max_completion_tokens = r.maxOutputTokens;
}
```

  Keep existing session/trace clearing, plugins off, Anthropic caching behavior,
  finite request guards, user attribution and no `stream_options`.
  Replace `!supportsMaxTokens` guards with `verifiedOutputCap(...) === null`.
  Pass bound limits from `buildBody`, `buildCalendarBody`, and web-native body
  closure. Validate runtime effort vocabulary before serializing; never let an
  unknown internal setting fall back silently. Default payload remains unchanged.
  Web-only requests must also reject missing/mismatched verified cap evidence.
- [ ] **4. Add parameterized request-path tests and run green**.
  Test all seven explicit efforts/default and both cap types on text,
  Calendar/V2/skill/composite, and web-only requests. Use `skillRequest`,
  `calendarBinding`, `calendarLimits` from `test/model/calendar-fixtures.ts`
  for Calendar bodies, and injectable native-stream fetch for web bodies.
  Automatic retries preserve byte-equivalent model/effort/cap; no reasoning
  field for default. Reasoning-only frames must not surface as deltas/logs/
  archive data. Empty-content `length` remains truncated, never fabricated text
  or an automatic billed replay. Run `npm test -- test/model/`.
- [ ] **5. Commit**: `feat(model): bind reasoning effort and output caps across adapters`.
  Stage the three production files and only the named modified specs.

### Task 5: Protected listing/check and independently revalidated saves

**Files**
- Modify: `backend/src/admin-config/{admin-config.service.ts,admin-config.controller.ts,errors.ts}`
- Modify: `backend/src/app.service.ts` (inject existing fetcher)
- Modify: `backend/src/http/configure-private-http.ts` (exact optional-warming exclusions)
- Modify: `backend/test/admin-config/fixtures.ts` (inject fetcher without changing defaults)
- Create: `backend/test/admin-config/model-compatibility.spec.ts`
- Test: `backend/test/admin-config/{authorization.spec.ts,admin-config-api.spec.ts,admin-config.integration.spec.ts}`
- Test: `backend/test/assembly/admin-config.spec.ts`

Also test the real private middleware in `backend/test/auth/authority-http.spec.ts`
and `backend/test/http/private-boundary.spec.ts`; controller-only checks are not
proof that owner warming was skipped.

- [ ] **1. Write a red service test** with no credential decryption/inference:

```ts
import { expect, it, vi } from 'vitest';
import { serviceFixture, actor, settings } from './fixtures.js';

it('checks a draft without activation, decryption, CAS, or tool dispatch', async () => {
  const f = serviceFixture();
  f.fetchImpl.mockResolvedValue(Response.json({ data: [{
    id: 'fixture/model', name: 'Fixture',
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    endpoints: ['/api/v1/chat/completions'],
    context_length: 131072, top_provider: { max_completion_tokens: 8192 },
    supported_parameters: ['max_tokens'],
  }] }));
  const decrypt = vi.spyOn(f.credentials, 'decrypt');
  const draft = settings();
  draft.openRouter.modelId = 'fixture/model';
  const result = await f.service.checkModelCompatibility({
    protocolVersion: 1, expectedRevision: 1, settings: draft,
  }, actor);
  expect(result.report.status).toBe('catalogue-compatible');
  expect(result.report.warnings).toContain('CREDENTIAL_NOT_CONFIGURED');
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect(f.fetchImpl.mock.calls[0][1]?.method).toBe('GET');
  expect(decrypt).not.toHaveBeenCalled();
  expect(f.activation.prepare).not.toHaveBeenCalled();
  expect(f.activation.publish).not.toHaveBeenCalled();
  expect(f.repository.compareAndSwap).not.toHaveBeenCalled();
  expect(f.stored()?.revision).toBe(1);
});
```

- [ ] **2. Run red**: `npm test -- test/admin-config/model-compatibility.spec.ts`.
  Expected FAIL: missing service method.
- [ ] **3. Add thin controller routes and service orchestration**.
  Inject `fetcher?: typeof fetch` defaulting to fetch; production passes
  `this.ports.fetcher`. Add `models(actor)` and
  `checkModelCompatibility(raw, actor)`:

```ts
@Get('models')
models(@Query() query: unknown) {
  noQuery(query);
  return this.service.models(this.actor());
}
@Post('model-compatibility')
@HttpCode(200)
check(@Body() body: unknown, @Query() query: unknown) {
  noQuery(query);
  return this.service.checkModelCompatibility(body, this.actor());
}
```

  In `configure-private-http.ts`, replace only the optional warming call after
  authentication/super-admin admission:

```ts
const modelMetadataOnly =
  (req.method === 'GET' && path === '/api/admin/config/models') ||
  (req.method === 'POST' && path === '/api/admin/config/model-compatibility');
if (!modelMetadataOnly) await o.prepareOwner?.(p);
// Keep o.identities.attach/run and every preceding auth/origin/account check.
```

  Service sequence: assertActor → strict parse/bootstrap-budget validation →
  stored revision read/assert → acquire validation → fresh catalogue/evaluate →
  finally release → read/assert revision again → bounded response echo/time.
  Catalogue fetch failure becomes unable-to-verify report with safe code and
  null observation/capacities, not activation or save. Local floor failures also
  return report; move duplicated `settingsOrFault` floor policy into shared
  evaluation while retaining schema field errors. Listing uses one cached
  projection and single in-flight refresh promise, cleared on settlement.
  Use server `now`; cache strictly `< observed+60000`, no stale fallback.
  Reuse validation limiter for admin network preparations, not mutation queue.
  Keep save queue/CAS/write-uncertainty logic unchanged.

  Preserve typed failures in existing `prepare` settlement:

```ts
if (settled?.ok) return settled.value;
if (settled && !settled.ok && settled.error instanceof ModelCompatibilityFault) {
  throw new AdminConfigFault(
    settled.error.report.status === 'incompatible' ? 'MODEL_INCOMPATIBLE' : 'MODEL_UNVERIFIED',
    null, [], settled.error.report);
}
throw new AdminConfigFault('CONFIG_ACTIVATION_UNAVAILABLE');
```

  `AdminConfigFault` optional fourth report argument only emits validated closed
  compatibility data; all other errors unchanged. Status mapping:
  MODEL_INCOMPATIBLE 422, MODEL_UNVERIFIED/MODEL_CATALOGUE_UNAVAILABLE 503.
  Add only appropriate retryable unavailable errors. Do not forward caught
  exception messages, raw causes, URLs, or provider bodies.
- [ ] **4. Add races/security/failure tests and run green**.
  Check→catalogue changes→save rejects before CAS and active pointer unchanged;
  forged client flags rejected; delayed check vs credential revision rejects
  conflict; check during held save cannot overwrite `lastPrepared`; check doesn't
  enqueue mutation/writable ownership; limiter release/TTL exact boundary/
  single-flight/overflow/timeout. Exercise both new routes for 401/403 users,
  actor service denial before repository/fetch, no-store/no ETag/nosniff,
  untrusted origin/TLS, query, compressed/oversized body and rate budgets.
  Use existing authenticated private-route fixture for unauthenticated 401;
  `authorization.spec.ts` alone tests actor denial but is not auth middleware proof.
  In actual middleware tests make `prepareOwner` throw if called for the two
  metadata routes; prove super-admin succeeds, user/unauthenticated requests
  still fail, unrelated private routes still prepare, and no Calendar provider/
  connection/discovery or personalization call occurs. Do not skip authentication
  storage or current account admission to achieve this isolation.
  Run `npm test -- test/admin-config/ test/assembly/admin-config.spec.ts test/assembly/config-drain.spec.ts test/auth/authority-http.spec.ts test/http/private-boundary.spec.ts`.
- [ ] **5. Commit**: `feat(admin): expose catalogue-only model checks with safe save admission`.
  Stage the exact source/spec/fixture files in this task.

### Task 6: Reuse the bounded browser client for list/check

**Files**
- Modify: `frontend/src/api/admin-config-client.ts`
- Test: `frontend/src/features/admin-config/admin-config-client.test.ts`
- Fixture: `frontend/src/features/admin-config/testing/fixtures.ts`

- [ ] **1. Add this red transport test** using the existing publicConfig fixture:

```ts
it('treats compatibility POST timeout as read-only rather than an uncertain save', async () => {
  const ctrl = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
  const client = createAdminConfigClient({ fetch: fetcher, baseUrl: '/api' });
  const pending = client.checkModelCompatibility({
    protocolVersion: 1, expectedRevision: 1, settings: publicConfig().settings,
  }, ctrl.signal);
  const rejected = expect(pending).rejects.toMatchObject({
    code: 'ABORTED', uncertain: false,
  });
  ctrl.abort();
  await rejected;
  expect(fetcher.mock.calls[0][0]).toBe('/api/admin/config/model-compatibility');
});
```

- [ ] **2. Run red**: `npm test -- src/features/admin-config/admin-config-client.test.ts -t "compatibility POST"`.
  Expected FAIL: missing client method.
- [ ] **3. Parameterize the existing request function only where needed**:

```diff
-async function readBoundedJson(response: Response): Promise<unknown> {
+async function readBoundedJson(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
-    if (size > MAX_RESPONSE_BYTES) {
+    if (size > maxBytes) {
-  async function request(
+  async function request<T>(
     method: 'GET' | 'PUT' | 'POST',
     path: string,
     body: string | undefined,
     signal: AbortSignal | undefined,
     mutation: boolean,
-  ): Promise<PublicAdminConfig> {
+    guard: (value: unknown) => value is T,
+    maxBytes = MAX_RESPONSE_BYTES,
+  ): Promise<T> {
-        payload = await readBoundedJson(response);
+        payload = await readBoundedJson(response, maxBytes);
-      if (!isPublicAdminConfig(payload)) {
+      if (!guard(payload)) {
```

  Existing read/save/credential calls append `isPublicAdminConfig`. Add these
  complete methods to the existing returned client object:

```ts
async models(signal) {
  return request('GET', ADMIN_CONFIG_ROUTES.models, undefined, signal,
    false, isModelCatalogueResponse, 1_048_576);
},
async checkModelCompatibility(requestBody, signal) {
  return request('POST', ADMIN_CONFIG_ROUTES.modelCompatibility,
    JSON.stringify(assertSaveRequest(requestBody)), signal,
    false, isModelCompatibilityResponse);
},
```

  Retain the rest of the current function body and safe error path. Preserve optional
  structured save report on `AdminConfigClientError` as
  `compatibility: ModelCompatibilityReport | null`; no raw body field.
- [ ] **4. Add/execute parser/limit/error tests**:
  fresh list/check response guards; exact route/method/body; credentials same-origin;
  1 MiB list accepted only within bound, 1 MiB+1 rejected; check64KiB+1 rejected;
  unknown effort/status/reason/candidate/extra fields rejected; error report
  preserved/redacted; read-only failure never uncertain; existing mutation
  uncertainty remains. Update all existing AdminConfigClient fixture literals to
  implement the two newly required methods with deterministic fixtures.
  Run `npm test -- src/features/admin-config/admin-config-client.test.ts`.
- [ ] **5. Commit**: `feat(admin-ui): add bounded catalogue and compatibility client methods`.
  Stage the client and its exact test/fixture changes.

### Task 7: Exact draft/result isolation and save gating in the reducer

**Files**
- Modify: `frontend/src/features/admin-config/config-edit-state.ts`
- Test: `frontend/src/features/admin-config/config-edit-state.test.ts`

- [ ] **1. Write a red reducer test**:

```ts
it('resets effort and invalidates a result even when the model changes away and back', () => {
  let s = createEditState(publicConfig());
  s = editReducer(s, { type: 'edit', path: 'openRouter.reasoningEffort', value: 'high' });
  const originalId = String(s.fields['openRouter.modelId']);
  const before = s.checkEpoch;
  s = editReducer(s, { type: 'edit', path: 'openRouter.modelId', value: 'fixture/new' });
  expect(s.fields['openRouter.reasoningEffort']).toBe('provider-default');
  s = editReducer(s, { type: 'edit', path: 'openRouter.modelId', value: originalId });
  expect(s.checkEpoch).toBeGreaterThan(before);
  expect(s.compatibility).toBeNull();
});
```

- [ ] **2. Run red**: `npm test -- src/features/admin-config/config-edit-state.test.ts -t "away and back"`.
  Expected FAIL: effort reset/check epoch absent.
- [ ] **3. Add the minimum reducer data/actions and selectors**:
  `checkEpoch: number`, `compatibility: ModelCompatibilityResponse | null`,
  `checkPending: boolean`, `checkError: string | null`.
  Actions: `checkStarted {epoch,key}`, `checkFinished {epoch,key,response}`,
  `checkFailed {epoch,key,code}`, `checkInvalidated`.
  Export `compatibilityKey(state)`, `requiresCompatibilityCheck(state)`,
  `hasMatchingCompatibility(state, now)`, and `saveLocked(state, now)`.
  Key uses normalized fields in `editableFields` order and baseline revision;
  invalid conversion yields null. Add effort to editable field catalog as enum
  for draft conversion/dirty coverage (render dynamically in next task).
  Preserve all existing raw numeric/history-floor logic and dirty overlay.

```ts
if (action.path === 'openRouter.modelId' &&
    action.value !== state.fields['openRouter.modelId']) {
  fields['openRouter.reasoningEffort'] = 'provider-default';
}
// Every relevant edit clears the result and increments the epoch immediately,
// even if the next parsed settings happen to match an older candidate.
// On completion, return state unchanged unless epoch and current key both match.
```

  Invalidate on credential begin/success, not by copying candidate secrets;
  retain dirty fields on credentialSaved. A read-only check failure only clears
  check state; never call `isUncertainFailure` for it.
- [ ] **4. Add and execute race/save tests**:
  model/effort/each chat-field/raw-invalid edit; exact expiry at expiresAt;
  A/B out-of-order and same-candidate two checks; old credential revision;
  returned different candidate; reload/save reset; catalogue refresh invalidation;
  changed model requires success but title-only baseline edit can save;
  initial blank setup; incompatible/unable/expired reports never enable save;
  check failure doesn't set `uncertain` or discard fields.
  Run `npm test -- src/features/admin-config/config-edit-state.test.ts`.
- [ ] **5. Commit**: `feat(admin-ui): fence compatibility results to exact draft revisions`.
  Stage only the two files.

### Task 8: Native searchable model selector, effort, check/result UI

**Files**
- Create: `frontend/src/features/admin-config/ModelSelectionFields.tsx`
- Modify: `frontend/src/features/admin-config/{ConfigFields.tsx,AdminDashboard.tsx,admin-config.css}`
- Test: `frontend/src/features/admin-config/admin-dashboard.test.ts`
- Fixture: `frontend/src/features/admin-config/testing/dashboard-browser.tsx`

- [ ] **1. Add a red SSR test** (import `ModelSelectionFields`):

```ts
it('keeps an exact missing configured ID and does not invent effort options', () => {
  const html = renderToStaticMarkup(createElement(ModelSelectionFields, {
    models: [], modelId: 'vendor/missing', effort: 'provider-default',
    loading: false, error: null, disabled: false, errors: [],
    onChange: () => undefined, onRetry: () => undefined,
  }));
  expect(html).toContain('vendor/missing');
  expect(html).toContain('not in current catalogue');
  expect(html).toContain('Provider default');
  expect(html).not.toContain('value="high"');
  expect(html).toContain('Search models');
  expect(html).toContain('Thinking effort');
  expect(html).toContain('for="admin-field-openRouter-modelId"');
});
```

  Props above are the complete presentational selector interface:
  `models: ModelCatalogueItem[]`, `modelId: string`, `effort: ReasoningEffort`,
  booleans loading/disabled, `error: string|null`, field errors,
  `onChange(path,value)` matching ConfigFields, `onRetry():void`.
- [ ] **2. Run red**: `npm test -- src/features/admin-config/admin-dashboard.test.ts -t "missing configured ID"`.
  Expected FAIL: new component absent.
- [ ] **3. Implement only native controls and existing page orchestration**.
  Component filters names/IDs with native `toLowerCase().includes`, always
  retains selected option, uses `catalogueEfforts` **projection supplied by server**
  rather than model heuristics, and renders labeled effort options/default.
  Use existing CSS classes/fieldDomId patterns; no UI dependency or bespoke
  combobox state machine. In `ConfigFields`, suppress generic model/effort
  controls for the OpenRouter section while retaining fixed privacy copy.
  `AdminDashboard` mounts the selector there, loads catalogue for super-admin
  only, and exposes read-only “Check compatibility” and safe result copy.
  Separate listing/check AbortControllers and epoch refs from mutation tracking.
  Refresh/retry never saves; edits continue to be possible while check is held.
  Call reducer `checkInvalidated` and abort on relevant change/credential begin.
  `onBusy` credential callback invalidates on true; baseline success changes key.
  Close/unmount aborts both read-only requests and increments epochs.
  A small cleanup-safe timeout updates UI at result expiry (<=60s); `saveLocked`
  also checks current time in the click handler, so a sleeping tab cannot bypass it.

```tsx
<label htmlFor="admin-model-search">Search models</label>
<input id="admin-model-search" type="search" maxLength={200}
  value={search} disabled={disabled}
  onChange={event => setSearch(event.target.value)}
  aria-describedby="admin-model-search-help" />
<p id="admin-model-search-help">Search names or exact model IDs; selection is a draft.</p>
{/* Native selects use fieldDomId, controlled values, labels and help/error IDs. */}
```

  Do not automatically replace/remove a configured missing ID/effort. A missing
  effort remains visibly selected/disabled until user resets; model change alone
  intentionally resets the draft. Ordinary users must neither fetch catalogue
  nor render config controls. Keep page save/mutation protections and capability
  refresh. Show optional structured save rejection in the same safe results area.
- [ ] **4. Run SSR/reducer/client checks and extend the closed browser fixture**:
  search zero matches/selected retention; exact IDs/readable names; null/all/
  absent/mandatory efforts; failed listing retry; no silent model substitution;
  key-only save clears success but retains dirty fields; check button cannot
  execute Save; stale result never enables Save; focus/help/errors/result status
  announcements; keyboard search/native select/effort/Check/Save and narrow viewport.
  Add explicit mocks for all browser/client literals.
  Run `npm test -- src/features/admin-config/`; expected PASS.
  Browser interaction is performed only against the closed fixture, not an
  application session; final command/location appears in Task 10.
- [ ] **5. Commit**: `feat(admin-ui): add searchable model selection and catalogue-only checks`.
  Stage only the component, three production UI files and named specs/fixtures.

### Task 9: Prove immutable binding and regress the real production seams

**Files**
- Test: `backend/test/runtime/text-config.spec.ts`
- Fixture: `backend/test/model/config-snapshot.ts`
- Test: `backend/test/voice/session/config-snapshots.spec.ts`
- Test: `backend/test/model/{calendar-policy.spec.ts,calendar-stream.spec.ts,adapter.spec.ts}`
- Test: `backend/test/runtime/{web-search-loop.spec.ts,calendar-memory-voice.spec.ts}`
- Locate production memory-first fixture tests by the exact required test names
  in root AGENTS.md; modify only a necessary existing fixture assertion, not runtime
  implementations unless an observed test proves snapshot propagation is broken.

- [ ] **1. Add a red acceptance/publication test**:

```ts
it('keeps accepted effort across publication and uses new effort for the next attempt', async () => {
  const a = textSnapshot(1, {}, 'fixture/model', 'fixture-A',
    'aurvin-dev-user', 'high');
  const b = textSnapshot(2, {}, 'fixture/model', 'fixture-B',
    'aurvin-dev-user', 'low');
  const h = textConfigFixture(a);
  try {
    const first = await h.submit();
    h.publish(b);
    await h.execute(first);
    const second = await h.submit('Next', first.sessionId);
    await h.execute(second);
    expect(h.fetcher.mock.calls.map(call =>
      JSON.parse(String(call[1]?.body)).reasoning))
      .toEqual([{ effort: 'high', exclude: true }, { effort: 'low', exclude: true }]);
  } finally { await h.dispose(); }
});
```

- [ ] **2. Run red**: `npm test -- test/runtime/text-config.spec.ts -t "accepted effort"`.
  Expected FAIL: fixture's sixth argument not used/effort absent.
- [ ] **3. Extend only the existing snapshot fixture parameter**:

```ts
// Append sixth optional parameter without changing existing positional callers:
// reasoningEffort: ReasoningEffort = 'provider-default'
settings.openRouter.reasoningEffort = reasoningEffort;
```

  Existing production snapshots should already carry effort from Tasks 1/4.
  If a path reconstructs `openRouter` field-by-field and drops it, fix that one
  shared projection and test every caller; do not add per-turn configuration
  reads. Verify the complete path checklist:
  durable text → attempt adapter; memory-first text → attempt adapter;
  automatic retry; explicit retry; live voice admission/reconnect → submitLiveTurn;
  Calendar legacy/V2/native skill and schema repair/provider retry;
  composite Calendar/web; web-only native tool continuation.
- [ ] **4. Add integration assertions and run focused green**:
  in-flight tool rounds retain model+effort when config publishes midway;
  explicit retry gets the new pair and retains original input linkage;
  duplicate idempotency keeps the original pair; new call captures current pair,
  existing/reconnected call retains previous snapshot.
  Inject reasoning strings/details into SSE fixtures and assert none appears in
  emitted deltas, persisted messages/checkpoints/metadata, logs, TTS or tool context.
  Keep usage counts without private content. Test empty `length` truncation on
  text, native and voice boundaries without automatic new inference.
  Run `npm test -- test/runtime/text-config.spec.ts test/model/ test/voice/session/config-snapshots.spec.ts test/runtime/web-search-loop.spec.ts test/runtime/calendar-memory-voice.spec.ts`.
  Also run the required production-route Calendar suites by exact names in Task10.
- [ ] **5. Commit**: `test(model): cover effort binding across retries voice and tool rounds`.
  Stage only the named modified specs/fixtures and any proven narrow projection
  fix, explicitly named in the handoff.

### Task 10: Integrated verification, documentation, and stop

**Files**
- Modify: `README.md` only for concise feature/setup/limitations documentation.
- Do not edit this workflow's `goal.md` or `state.md`; orchestrator owns them.
- Future verification records/report locations require orchestrator assignment;
  do not invent ownership during implementation.

- [ ] **1. Check changed-file ownership and docs**.
  Document searchable catalogue, effort default/migration, “Check compatibility”
  as non-inference/static only, saved credentials remaining server-side, new-call
  snapshot behavior, no guaranteed tool reasoning continuity, and required
  independent save revalidation. Keep absence of paid certification explicit.
  Validate local links and source path references.
- [ ] **2. Run final backend commands individually in `backend`**:

```text
npm run build
npm run lint
npm test
npm run test:e2e
```

  Record exit codes, passed/failed/skipped counts and reasons. Native e2e requires
  **operator-supplied isolated** `AURVIN_TEST_MONGODB_URI` and
  `AURVIN_TEST_DB_PREFIX=aurvin_p2_test_`, replica-set capabilities where required.
  Never read a running application's URI/.env to unblock it. Missing prerequisite
  → report skipped/unverified, not passed. No paid/live fallback. Azure product/
  topology remains uncertified; no `test:azure` empty discovery claim.
- [ ] **3. Run final frontend commands individually in `frontend`**:

```text
npm run build
npm run lint
npm test
```

  Record actual results; Node/SSR tests are not browser interaction proof.
- [ ] **4. Exercise the closed browser fixture if local fixture-server startup is
  authorized**, never restart the application. Use a new unused loopback port:
  in `frontend`,
  `npm run dev -- --host 127.0.0.1 --port 5197 --strictPort`.
  Open
  `http://127.0.0.1:5197/src/features/admin-config/testing/dashboard-browser.html`.
  Fixture mocks all network/provider/config paths; fail if it tries an application
  API or paid endpoint. Check native keyboard navigation, focus, labels, errors,
  narrow-screen wrapping, saved-missing-ID retention, exact effort set, held
  result races and no saves during checks. Record assertions, not just a
  screenshot. If startup/browser is not authorized/available, report not run.
- [ ] **5. Run required Calendar critical-path regressions from root AGENTS.md**.
  Locate owning spec paths with exact-name grep; run the owning full specs, not
  a fabricated native certification. Include blocked-storage prepared reads and
  repeated owner preparation, held archive continuations, essential barrier
  ordering, W1–W4 crash windows, pinned-ID reconciliation, competing tabs,
  concurrent confirmations, cancellation windows, exact expiry and invalidation.
  Run `npm test -- test/performance/calendar-tool-latency.spec.ts` and distinguish
  synthetic waves from `performance.now()` observations. These fixtures prove
  unchanged safety/order and no new catalogue/config I/O on warm inference paths,
  not a wall-clock SLA or provider integration.
- [ ] **6. Commit documentation only after meaningful checks**:
  `git add -- README.md`, then
  `git commit -m "docs: explain catalogue-only model admission and effort limits"`.
  Do not hide failures by calling review passed; unified review remains skipped.
- [ ] **7. Report and stop**.
  Report exact commit set, environment, changed paths, planned versus actually run
  checks, native/live/browser skips, migration behavior and external unknowns.
  No live inference/Calendar/Deepgram/OpenRouter/LiveKit certification, deployment,
  or production-readiness claim. New paid/service testing needs separate explicit
  authorization with bounded costs/data exposure.

## Planning self-check and handoff checklist

- [x] All seven approved acceptance criteria map to Tasks 1–10.
- [x] All three shared provider serializer call sites and three POST transports
  traced; runtime text, memory-first, voice, retries and tool rounds covered.
- [x] Strict stored compatibility and parser/frontend mirrors included.
- [x] No curated model allowlist, paid probe, private-reasoning archive, speech
  model change, new dependency, or unrelated refactor.
- [x] Read-only check cannot mutate `lastPrepared`, save, CAS, activate, execute
  tools, or warm/read Calendar owner data through the auth middleware.
- [x] Missing/ambiguous evidence, null/absent effort semantics, equivalent cap,
  output/reasoning caveats and optional-tool pricing downgrade are explicit.
- [x] Exact candidate/revision/epoch/expiry isolation plus independent save gate.
- [x] Backend/frontend final commands and native/live/browser limitations named.
- [x] Review recorded skipped; implementation remains unauthorized.

No unresolved product decision is needed to start a later authorized implementation.
Provider-specific routing/behavior evidence remains intentionally unknown rather
than “fixed” by a model-name exception or inference during a catalogue-only check.
