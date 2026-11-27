# Feature status

**Statuses:** Planned · In progress · Implemented · Tested · Production verified · Blocked.

"Tested" means automated tests exist and passed on 16 November 2026 (Node 24.21.0). Nothing here is **Production verified**: no live deployment, provider drill or browser end-to-end run has been done for Aurvin.

## Baseline features (before Release 0)

| Feature | Status | Evidence and notes |
| --- | --- | --- |
| Text chat: streaming, cancel, retry, terminal outcomes, recovery after refresh, save state | Tested | Frontend chat suites pass; backend runtime suites pass except the 3 known failures below |
| Sessions: list, rename, pin, delete | Tested | |
| WorkOS login, password reset, forced password change, roles | Tested | Needs WorkOS settings to run for real |
| Manage Aurvin (settings, encrypted credentials) | Tested | |
| User administration | Tested | |
| Analytics tab (super-admin usage and cost by date range) | Tested | Built in `a286301`; `admin-analytics.spec.ts` (4) and `analytics-state.test.ts` (9) pass on 27 November 2026 (Node 24.21.0). See [admin-analytics](../admin-analytics/README.md) |
| Google Calendar: connect, multiple calendars, availability, create with confirmation | Tested | Edit, reschedule and delete are Planned (Release 6) |
| Dictation (Deepgram) | Tested | Offline fixtures only |
| Live voice (LiveKit) | Implemented | No live LiveKit drill has been run |
| Canvas: diagrams, charts, SVG, calendar; copy and download | Tested | Diagram types beyond flowchart and sequence aren't confirmed to render correctly |
| Safe Markdown (no HTML injection) | Tested | No tables or nested lists yet |
| Operations: readiness, admission, drain, recovery, accounting | Tested | Backend `launcher.spec.ts` fails (predates Release 0) |
| Azure database support | Blocked | Service details unknown |

## Release 0

| Feature | Status | Evidence |
| --- | --- | --- |
| Design tokens (dark default + light), contrast-checked | Tested | `styles/tokens.test.ts` |
| Theme switch: System / Dark / Light, saved per browser | Tested | `app/theme/theme.test.ts`; visual check in both themes |
| Aurvin branding (temporary emblem until official logo files arrive) | Tested | Brand assertions in Sidebar, EmptyState and auth tests |
| Flag-aware sidebar navigation (Integrations, Settings) | Tested | `app/navigation.test.ts`, `components/Sidebar.test.ts` |
| Command palette (Ctrl/Cmd+K) | Tested | `components/CommandPalette.test.ts`; visual check |
| Design-system primitives (`ui/`) | Tested | `ui/ui.test.ts` |
| Shared dialog focus trap (ConfirmDialog, palette) | Tested | ConfirmDialog suite unchanged and passing |

## Added 23 November 2026 (feature port)

Checked on 23 November 2026 (Node 24.21.0) with deterministic fixtures only. Each needs its provider settings in Manage Aurvin before it does anything for real.

| Feature | Status | Evidence and notes |
| --- | --- | --- |
| User memory: saved profile sections, "memory updated" pill, temporary chats purged on exit | Tested | `docs/user-memory-context/`; frontend personalization and chat suites |
| Personalization: location and response style | Tested | `docs/user-personalization/`, `docs/environment-tool/` |
| Web search and page fetch (TinyFish) | Tested | `docs/web-search/`, `docs/web-search-tinyfish-auth/`; no live provider run |
| Environment tool: time, location, weather Canvas | Tested | `docs/environment-tool/` |
| Dev mode (User / Dev workflow on the Config page) | Tested | `docs/aurvin-dev-mode/` |
| Context compaction and chat history token budget | Implemented | `docs/context-compaction-memory/`, `docs/chat-history-token-budget.md`; 7 tests in `compaction-runtime.spec.ts` fail |
| Prompt-cache compaction fixes, model selection compatibility | Tested | `docs/prompt-cache-compaction-fixes/`, `docs/model-selection-compatibility/`; `session-affinity.spec.ts` has 5 failures |
| Voice Canvas control and navigation | Tested | `docs/voice-canvas-control/`, `docs/voice-canvas-navigation/` |
| Calendar tool and Canvas action latency work | Implemented | `docs/calendar-tool-latency/`, `docs/canvas-action-latency/`; several calendar suites fail (see Known issues) |
| Voice architecture benchmark (`benchmarks/voice-architectures`) | Tested | Own package: type-check clean, 140 tests pass; no live provider run |

## Hidden behind flags (Planned)

Home, Projects (R5), Agents (R3), Memory (R5), Workspace (R2), Automations (R8).

## Known issues

| Issue | Status |
| --- | --- |
| After the 23 November feature port, 79 backend tests in 21 files fail. The same tests fail in the ported source before integration, so none are caused by the merge. Main groups: `durable-latency` (timing gates, flaky), multi-calendar integration (`acceptance`, `authority`, `accounting-recovery`), `compaction-runtime`, `session-affinity`, calendar assembly/HTTP/confirmation suites, `operations/launcher`, `persistence/local-open`, `finalization-repair` | Blocked (needs investigation) |
| Backend e2e, Azure and behavior suites not run | Needs MongoDB and provider credentials |
| Browser end-to-end tests never run | Planned |
| Frontend bundle is 1.19 MB (warning existed before Release 0) | Planned: code-split in Release 2 |
