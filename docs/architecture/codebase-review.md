# Codebase review: cons, risks and cleanup plan

Snapshot of `main` at `02c685d` on 27 November 2026. Read-only review by three parallel analysts (backend core, backend edges, frontend), spot-checked by the tech lead. Nothing in this document has been changed in code yet.

It complements [current-state.md](current-state.md), [module-boundaries.md](module-boundaries.md) and [target-state.md](target-state.md). Several cons below are direct breaches of the rules in `module-boundaries.md`.

## Summary

| Area | Verdict |
| --- | --- |
| Overall shape | Sound module map on paper (NestJS backend, React feature folders, LangGraph runtime, Mongo repositories), but the code has outgrown it. Size is concentrated in a handful of god files. |
| Biggest risk | The four largest backend classes sit on the Calendar tool critical path, which `AGENTS.md` protects with a long list of required checks. They are the most valuable and the most dangerous to split. |
| Layering | Dependencies run the wrong way in several places (contracts → persistence, persistence → chat-runtime, model → chat-runtime). |
| Extensibility | No plugin or tool contract. Calendar and web search are bolted into the runtime; a third integration means copying files and editing central wiring. |
| Duplication | Hand-copied HTTP helpers in the backend; hand-copied backend contracts in the frontend with drift checks for voice only. |
| Formatting | Prettier is configured but has never been applied: nearly every backend file fails `prettier --check`. The frontend has no formatter at all. Lint has two rules per package. |
| Tests | Backend logic is heavily tested. Frontend pure state is well tested, but no React component has a render test, so splitting components is unguarded. |

Size: about 80k lines of backend source and 46k lines of frontend source, excluding tests.

## 1. Architecture cons

### 1.1 God files and classes

| File | Lines | Problem |
| --- | --- | --- |
| `backend/src/chat-runtime/durable-chat-runtime.ts` | 3362 | One class (`:148`) with 58 methods and 70 imports: admission, generation, finalization and recovery in one place. |
| `backend/src/chat-runtime/calendar-loop.ts` | 2925 | Calendar tool loop, 46 methods. Only 3 specs import it directly. |
| `backend/src/chat-runtime/memory-text.ts` | 2783 | Memory-first text runtime, 86 imports. |
| `backend/src/plugins/google-calendar/connection.ts` | 1987 | `GoogleCalendarConnections` (`:150`) implements four ports at once: consent, grant install, settings, disconnect, listing, target resolution and lifecycle epochs. |
| `backend/src/app.service.ts` | 1406 | Composition root that is also a service (see 1.2). |
| `backend/src/chat-runtime/calendar-recovery.ts` | 1147 | Crash recovery for Calendar. Guarded by a single spec. |
| `frontend/src/features/canvas/canvas-artifacts.ts` | 2309 | Parsing, validation and artifact shaping for every canvas type. |
| `frontend/src/features/chat/state/use-chat.ts` | 1349 | One hook with about 35 hook calls: streaming, session list, submission recovery, memory save. |
| `frontend/src/features/chat/state/chat-reducer.ts` | 1309 | One reducer for every chat concern. |
| `frontend/src/api/calendar-protocol.ts`, `voice-protocol.ts` | 1325, 1053 | Every type, guard and route for a feature in one module. |
| `frontend/src/features/canvas/renderers/mermaid-renderer.tsx`, `chart-renderer.tsx` | 1223, 951 | Renderers that also parse and lay out. |
| `frontend/src/features/admin-config/AdminDashboard.tsx` | 1076 | Reducer (`:191`), helpers (`:141`, `:187`), DOM focus helper (`:202`) and a 22-`useState` component in one file. |
| `frontend/src/styles/chat.css` | 3277 | One global stylesheet; `admin-config.css` is 1705 lines. No scoping. |

### 1.2 `AppService` is both the composition root and a service

`backend/src/app.service.ts` wires persistence, runtime, plugins and voice, and also runs logic itself:

- config snapshot publish and drain (`:1000-1120`)
- Calendar lifecycle and invalidation redaction (`:875-1000`)
- voice bridge and LiveKit assembly (`:1259-1404`)
- an ephemeral sweep timer (`:1209`) and admin accounting (`:735`)
- the Nest scaffold leftover `getHello()` (`:1406`), still served by `app.controller.ts:28`

Its constructor is private and takes `overrides: Partial<AssemblyPorts>` (`:362`), so tests reach it through 46 referencing files. `AGENTS.md` requires one composition owner; that is right, but the owner should only wire.

### 1.3 Dependencies point the wrong way

`module-boundaries.md` says contracts are the lowest layer and modules don't reach into each other. Today:

- `backend/src/contracts/calendar-accounting.ts:5` and `contracts/repositories.ts:29` import `CasConfirmation` and `ConfirmedRecord` from `persistence/confirmed-record.js`.
- Five persistence files import from chat-runtime, http, plugins or voice (`calendar-retention`, `memory-calendar-reader`, `memory-text-archive`, `memory-web-records`, `web-search-connections`).
- Nine chat-runtime files, including `ports.ts` and `durable-chat-runtime.ts`, import from plugins, voice, http or operations. The port file depends on the adapters it is meant to abstract.
- Ten `model/` files import from chat-runtime, persistence or http. `model/calendar-*` (adapter, policy, repair, stream, validation) is Calendar feature code inside the generic model gateway.
- `process.env` is read in eight source files outside `environment/` and `platform/`.

No cycle-detection tool has been run; with these edges, cycles are likely.

### 1.4 Calendar is a feature smeared across layers

Calendar code lives in `chat-runtime/calendar-*` (about 6k lines), `persistence/calendar-*` (about 5k), `model/calendar-*`, `context/calendar-context.ts`, `plugins/google-calendar/` and `http/calendar-boundary.ts`. There is no vertical module, so a Calendar change touches every layer and its HTTP policy is split across two folders.

### 1.5 No plugin or tool contract

- There is no `Plugin` or tool interface. `plugins/google-calendar` (19 files) and `plugins/web-search` (12 files) have the same shape by copy: identical `ConfigurableModuleBuilder` modules (`google-calendar/module.ts:34-60`, `web-search/module.ts:26-50`), and each has its own controller, OAuth, callback page and connection.
- `module-boundaries.md` rule 6 already records this: "only the Google Calendar loop exists; a general registry is planned". Releases 5 and 6 add more integrations, which makes this the most important structural gap.

### 1.6 Nest dependency injection is mostly nominal

Providers are lambdas handed in from `app.service.ts`. Only `AppController` and `VoiceSessionController` are registered in `app.module.ts:107`. Other controllers arrive through module options, and `configure-*-http.ts` files hand-wire Express middleware outside Nest guards, pipes and filters. Validation, auth checks and body parsing are therefore reimplemented per feature (see 3.1).

### 1.7 Frontend structure

- Inconsistent folders inside features: test harnesses live in `testing/`, `integration-tests/` or `api/testing/`; state lives in `state/` for chat and voice but in root `*-state.ts` files elsewhere.
- `frontend/src/components/` holds chat-specific UI (Composer, Transcript, MessageItem, Sidebar, TaskCard) beside the `ui/` primitives and `features/chat`, so the boundary between "shared" and "chat" is unclear.
- Voice is split three ways: transport in `api/livekit-voice-client.ts` (814 lines) and `api/voice-*`, controller and audio in `features/voice/`.
- Canvas support grows by editing `canvas-artifacts.ts`, `diagram-parsers.ts` and several feature flags rather than registering a renderer.

### 1.8 Contracts are duplicated between backend and frontend

Frontend protocol modules copy backend types and guards by hand (for example `api/analytics-protocol.ts:11` "Mirrors the backend AccountingTotals contract", `api/admin-config-protocol.ts:29`). There is no shared package. Drift is caught only for voice, by `api/testing/voice-fixtures.test.ts:62-66` reading the backend contract files as text. Calendar, web search, admin config and analytics have no drift check.

## 2. SOLID breaches

| Principle | Where |
| --- | --- |
| Single responsibility | Every file in 1.1; `configure-admin-http.ts` mixes routing, auth and body parsing. |
| Open/closed | New tools and plugins require editing `DurableChatRuntime`, `CalendarLoop`, `app.service.ts` and `app.module.ts`. New canvas types require editing `canvas-artifacts.ts`. |
| Liskov | No notable breaches found. Inheritance is rare. |
| Interface segregation | `GoogleCalendarConnections` implements four ports in one class. Frontend protocol modules export every guard and type from one file. |
| Dependency inversion | `AppService` builds concrete collaborators; `chat-runtime/ports.ts` imports adapters; React components call concrete API clients directly. |

## 3. Unnecessary and duplicated code

### 3.1 Duplicated helpers (verified by grep)

| Helper | Copies |
| --- | --- |
| `headerValues`, `loopbackPeer` | `http/calendar-boundary.ts:10,20` and `plugins/google-calendar/controller-http.ts:47,57` |
| `isLoopbackPeer` | `admin-config/configure-admin-http.ts:143` (third copy of the loopback check) |
| `collectJson` | `admin-config/configure-admin-http.ts:159` and `plugins/google-calendar/controller-http.ts:236` |
| Bounded body readers | `readBounded` in `credential-validation.ts:215`, `fixed-assets.ts:75`, `oauth-http.ts:65`; `readBoundedJson` in `weather-service.ts:146`, `reverse-geocode.ts:48`; `readBoundedText` in `calendar-api-http.ts:186` |

These are trust-boundary checks. Keeping several copies in step is a security risk, not just untidiness.

### 3.2 Leftovers and clutter

- `AppService.getHello()` and `AppController.getHello()`, asserted by `app.controller.spec.ts:103`: Nest scaffold.
- Tracked repo-root documents unrelated to the code: `CONVERSATION_LATENCY_RESEARCHER_2.md`, `voice-modes-prd.md`.
- Frontend browser harnesses inside `src`, type-checked by every build through `tsconfig.app.json` `include: ["src"]`: `google-calendar/testing/calendar-browser.tsx` (918 lines), `auth/integration-tests/auth-browser.tsx` (757), `fixture-api.ts` (657), web-search and stream-render harnesses, and two near-duplicate `admin-config` dashboard harnesses (`testing/dashboard-browser.tsx` and `integration-tests/dashboard-browser.tsx`).
- Not dead, keep: `backend/src/benchmark/` (wired to `npm run benchmark`), `backend/src/scripts/*` (operator scripts referenced by docs and tests), `frontend/src/app/feature-flags.ts` (deliberate release gates), the 67 `ponytail:` markers.
- No dead-export scan (`knip`, `ts-prune`) has been run; unused exports are unknown.

### 3.3 Lint warnings that are real defects

oxlint warns, and these are behaviour bugs rather than style:

- `frontend/src/features/admin-config/AdminDashboard.tsx:304`, `:361`: state set inside an effect; `:1013`: `Date.now()` during render.
- `frontend/src/features/chat/ChatView.tsx:521-522`: state set inside an effect on a value that changes every render.
- `frontend/src/features/plugins/google-calendar/GoogleCalendarPanel.tsx:156`, `:160`: missing effect dependencies.

## 4. Readability, naming, formatting and comments

- **Formatting is not enforced anywhere.** Backend `.prettierrc` has only `singleQuote` and `trailingComma`; `prettier --check` fails on about 880 of 908 backend files even ignoring line endings. There is no `format:check` script, no CI, no pre-commit hook, no `.editorconfig` and no `.gitattributes` (with `core.autocrlf=true`). The frontend has no formatter at all. Code is hand-formatted: one-line method bodies (`app.service.ts:1208`), 57 lines over 140 characters in `durable-chat-runtime.ts` alone.
- **Lint is thin.** Both packages use oxlint with two configured rules. `no-explicit-any` is off. No naming-convention or complexity rules.
- **Naming.** Class names such as `MemoryText` describe a noun, not a role (it is a runtime). Methods like `prepareWebOwner` need the surrounding file to understand. A naming pass needs an agreed convention first; renames across ESM `.js` import specifiers are noisy.
- **Comments.** The per-file header is mandatory under `AGENTS.md` and stays. Inline comment density is high in `calendar-loop.ts`, `durable-chat-runtime.ts`, `live-voice-controller.ts` (22 inline) and `canvas-artifacts.ts` (29 inline), and low elsewhere. Trimming is mostly a voice, canvas and Calendar-runtime job.
- **TypeScript settings.** `strictPropertyInitialization: false` in the backend.

## 5. Test-suite cons

- Backend specs are split between `backend/test/` (about 407) and co-located `backend/src/**/*.spec.ts` (about 56), with no rule for which goes where.
- `calendar-recovery.ts` (1147 lines) has one spec; `calendar-loop.ts` (2925 lines) has three importing specs. Splitting either needs characterization tests first.
- The frontend runs Vitest in a Node environment with no DOM. No React component has a render test, so splitting `AdminDashboard.tsx`, `ChatView.tsx`, `CanvasPanel` or the renderers is protected only by `tsc -b`.
- Native MongoDB suites skip without operator-supplied prerequisites, so routine runs never exercise real persistence.

## 6. Recommended patterns, and what to avoid

**Use where it removes real duplication or editing hot spots:**

- **Extract collaborators** (facade split) for `DurableChatRuntime`: admission, generation, finalization, recovery. Make the accepted → generating → finalizing → completed/failed lifecycle an explicit **state machine** rather than scattered checks.
- **Split `AppService` into Nest providers** (`RuntimeConfigService`, `CalendarLifecycleService`, `VoiceAssembly`), leaving a single composition owner that only wires.
- **Strategy / registry for tools**: a small `ChatTool` port that Calendar and web search implement, so the runtime stops naming them.
- **Registry for canvas renderers** keyed by artifact type.
- **Custom hooks and slice reducers** on the frontend: split `use-chat.ts` by concern and `chat-reducer.ts` into slices under one root reducer; `useDashboardState` plus section components for the admin dashboard.
- **One shared HTTP boundary module** for peer, header, JSON-body and bounded-read helpers.

**Avoid (over-engineering for this codebase):** a generic plugin framework while there are two plugins, a DI container on the frontend, Redux, an interface for every class, or an adapter layer over the protocol guards (the guards already are the adapter).

## 7. Cleanup plan

Ranked by value against risk. Every step is behaviour-preserving except 2, which fixes defects and goes in its own commit.

| # | Step | Risk | Guards | Blocked by peer work? |
| --- | --- | --- | --- | --- |
| 1 | Extract shared backend HTTP-boundary helpers (3.1) | Low-medium | `test/http/*`, `test/admin-config/*`, `test/plugins/*` | No |
| 2 | Fix the five lint-flagged React defects (3.3) | Medium | oxlint, build, manual check | `ChatView.tsx` is being edited in `release-2-split-export` |
| 3 | Move frontend browser harnesses out of `src`, delete the duplicate dashboard harness | Low | build | No |
| 4 | Split `calendar-protocol.ts` and `voice-protocol.ts` into types / guards / routes behind the same exports; add contract drift checks for every protocol | Low | protocol tests | `api/protocol.ts` and `client.ts` are being edited in `release-1-unit-0` |
| 5 | Move `CasConfirmation`/`ConfirmedRecord` into `contracts/`; remove `getHello` and repo-root clutter | Low | build, `app.controller.spec.ts`, e2e | `release-5-m1` edits `contracts/` |
| 6 | Split `AppService` into providers with one composition owner | Medium | `test/operations`, assembly specs | No |
| 7 | Split `canvas-artifacts.ts` and add a renderer registry | Medium | `canvas*.test.ts` | `release-2-split-export` edits canvas |
| 8 | Split `chat-reducer.ts` and `use-chat.ts` | Medium-high | chat-state tests | Consumers overlap `release-1-unit-0` |
| 9 | Add component render tests, then split `AdminDashboard.tsx` and `ChatView.tsx` | Medium | new tests (needs a DOM test dependency) | `ChatView.tsx` overlaps `release-2-split-export` |
| 10 | Group Calendar into a vertical module; add a `ChatTool` port | High | full `AGENTS.md` critical-path checklist | Coordinate with Releases 5 and 6 |
| 11 | Split `DurableChatRuntime`, `CalendarLoop`, `calendar-recovery`, `MemoryText`, `GoogleCalendarConnections` | **High** | characterization tests first, then every required check in `AGENTS.md` "Tool execution critical path" | Coordinate |
| 12 | Repo-wide Prettier (with `printWidth`, `endOfLine`, `.gitattributes`), frontend formatter, `format:check`, naming and complexity lint rules | Low logic, high merge | full suites | Touches every file: do last, when no worktree is dirty |

Peer work as of this snapshot: `release-1-unit-0` (frontend API and `MessageItem`), `release-2-split-export` (App, ChatView, canvas), `release-5-m1` (contracts, persistence memory audit), `release-5-m2` (user-memory client), `backend-test-fixes` (`vitest.config.ts`, performance and operations specs).

## 8. Decisions

Decided on 27 November 2026:

1. **Scope:** the first pass covers steps 1–7 only. The critical-path splits (10–11) and frontend state splits (8–9) come later as separate guarded passes.
2. **Timing:** the refactor starts only after `release-1-unit-0`, `release-2-split-export`, `release-5-m1`, `release-5-m2` and `backend-test-fixes` have merged to `main`.
3. **Formatting:** one formatting-only commit at the end (step 12), with Prettier `printWidth`/`endOfLine`, `.gitattributes`, a frontend formatter and a `format:check` script.
4. **Comments:** remove narrating inline comments; keep the mandatory file headers and `ponytail:` notes.

Still open:

5. Naming convention to adopt before any rename pass.
6. Test layout: all backend specs in `test/`, or co-located?
7. May the frontend gain a DOM test dependency (jsdom with Testing Library) and the repo gain `knip` for a dead-export scan?
