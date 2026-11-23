# Environment Tool — Consolidated Completion Report

**Report date:** 19 November 2026  
**Branch:** `codex/personalization-location-m1`  
**Implementation span:** `3c6f28e` (Milestone 0) through `a4d9cd1` (Milestone 3)  
**Plans covered:** [Milestone 0](milestone-0-request-environment-foundation/plan.md), [Milestone 1](milestone-1-personalization-location/plan.md), [Milestone 2](milestone-2-environment-tool/plan.md), [Milestone 3](milestone-3-weather-canvas/plan.md)  
**Status:** All four plans are implemented and committed. Focused backend and frontend verification passes. The full backend routine suite remains environment-limited and is not a clean gate in this checkout; details are recorded below.  
**Tracking note:** The original plans retain their authored task checkboxes; this report is the consolidated completion record.

---

## 1. Executive summary

The environment-tool program now provides an end-to-end, privacy-bounded path from browser context to structured weather presentation:

- Zero-permission browser IANA timezone capture and fail-closed trusted proxy geolocation hints.
- Optional city-level personalization location with explicit, click-only browser geolocation and coarse reverse geocoding.
- A directly advertised built-in `get_environment` native tool for exact local datetime, location resolution, and cached Open-Meteo weather, sharing one `WeatherView` contract with presentation.
- Structured Weather Canvas cards across text SSE, persisted messages, live voice frames, voice navigation, inline `Change city`, and voice-first auto-open.
- Stable prompt-prefix and zero-pre-model-DB-I/O invariants preserved. Volatile time/location/weather data travels through the tool path, not the system prompt prefix.
- Weather presentation remains separate from model-authored Canvas artifacts: structured weather travels only over `weather-view` SSE events and `weather.frame` voice frames, never through `canvas.artifact`.

The work is committed on one feature branch with focused commits per task. No external infrastructure was provisioned and no production deployment was performed.

---

## 2. Delivered capabilities by milestone

| Milestone | Delivered outcome | Primary verification |
| --- | --- | --- |
| **0 — Request environment foundation** | Browser timezone header; request-scoped environment store; trusted proxy geo extraction; text and live-voice propagation; runtime timezone precedence fix. | 3 backend files / 15 tests; 1 frontend file / 6 tests. |
| **1 — Personalization location** | Optional `SavedUserLocation`; legacy-document default; Nominatim reverse geocode endpoint; click-only browser geolocation; Location card and reducer. | 4 backend files / 20 tests; 1 frontend file / 10 tests. |
| **2 — `get_environment` and weather service** | Built-in native tool; 4-tier location precedence; cached Open-Meteo weather; partial success; Calendar timezone alignment; runtime and web-only-loop integration; policy instructions. | 8 backend files / 27 tests. |
| **3 — Structured Weather Canvas** | Assistant-only `weatherView` persistence; `weather-view` SSE; `weather.frame` live voice; weather Canvas ownership; renderer, inline cards, auto-open, `Change city`; `control_canvas` support. | 3 backend files / 10 tests; 7 frontend files / 34 focused tests; full frontend suite 117 files / 979 tests. |

---

## 3. End-to-end flow

1. **Browser context capture**
   - The frontend reads the browser IANA timezone without permissions and attaches it as `X-Aurvin-Time-Zone` on submit, retry, and voice-session creation.
   - Optional browser geolocation runs only after the user clicks **Detect my location**.

2. **Request admission**
   - Backend `RequestEnvironmentStore` validates the timezone and extracts geo hints only from a trusted proxy ingress.
   - Raw IPs are not retained; geo placeholders and untrusted headers are rejected.

3. **Personalization**
   - The user may save a city-level `SavedUserLocation`; coordinates are rounded to two decimal places (roughly 1 km city precision).
   - Legacy documents without `location` read as `location: null` with no migration.
   - Location is deliberately excluded from `userPersonalizationMessage()` so the cacheable prompt prefix remains byte-stable.

4. **On-demand environment lookup**
   - `get_environment` is advertised as a direct built-in tool, not a plugin skill.
   - Location resolution order: explicit city → saved personalization location → trusted edge geo → unknown.
   - Datetime is computed locally in the active timezone; weather is fetched from cached Open-Meteo services.
   - Weather failure is partial: datetime and location can still succeed.

5. **Structured presentation**
   - A successful weather lookup yields a validated `WeatherView`.
   - Text path: `weather-view` SSE plus `completed.weatherView`; assistant message stores optional `weatherView`.
   - Live voice path: `weather.frame` after scoped turn/attempt checks.
   - Frontend folds live voice frames into Weather workspaces, merges archived and live cards by turn/alias, and renders a scrollable structured Canvas card.

6. **Interaction**
   - Text mode shows a compact inline `CanvasArtifactCard`; Canvas does not auto-open.
   - Live voice auto-opens a new weather card once and respects manual dismissal.
   - `Change city` submits a text follow-up; the Personalization shortcut opens saved-location controls.
   - `control_canvas` can show, scroll, fullscreen, or close an owned Weather Canvas; zoom is unsupported in scroll mode.

---

## 4. Milestone records

### Milestone 0 — Request Environment Foundation

**Goal:** capture browser timezone and trusted proxy geo without permissions or raw-IP retention, and propagate a client timezone through text and live voice.

**Delivered**

- `RequestEnvironment` extraction for normalized IANA timezones and loopback/TLS-gated Cloudflare/Vercel geo headers.
- `RequestEnvironmentStore` using `AsyncLocalStorage` plus a `WeakMap` fallback.
- CORS allowance for `X-Aurvin-Time-Zone`; HTTP submit/retry and voice-session creation forwarding.
- Runtime propagation through `DurableChatRuntime` and `MemoryTextRuntime` with precedence `clientTimeZone → calendar.trustedTimeZone → Etc/UTC`.
- Idempotency payload hashes preserved; request environment is not stored in strict JSON bodies or recovery records.
- Browser `detectBrowserTimeZone()` and non-clobbering header merge.
- Assembly fixture warm-up fix so the `admin-http` authority checks no longer boot cold.

**Key invariants**

- Invalid, multi-value, overlong, or control-character timezones are rejected.
- Untrusted peers cannot inject proxy geo headers; raw IPs are never retained.
- The change does not add a pre-model database read.

**Commits:** `3c6f28e` (feature), `670110f` (assembly fixture warm-up). Plan-only/docs commits: `40ca78b`, `643b894`.

**Focused verification:** 3 backend files / 15 tests; 1 frontend file / 6 tests. The plan’s recorded status also notes backend build/lint pass and frontend build/lint/test pass at the milestone point.

### Milestone 1 — Personalization Location and Click-Only Geolocation

**Goal:** add optional city-level location to personalization without injecting it into the prompt prefix or adding pre-model database I/O.

**Delivered**

- Backend `SavedUserLocation` contract with field/coordinate bounds, paired-coordinate rule, two-decimal rounding, and legacy MongoDB default of `null`.
- `userPersonalizationMessage()` and prefix estimates remain blind to `location`.
- Bounded OpenStreetMap Nominatim reverse-geocode client: 5-second timeout, 64 KiB response cap, no redirects, fixed User-Agent, city-level `zoom=10`, closed `LOCATION_UNAVAILABLE` failure.
- Authenticated `POST /api/personalization/reverse-geocode` behind strict JSON/no-query/no-store middleware.
- Frontend protocol/client support for saved location and reverse geocoding.
- Explicit click-only browser geolocation helper (`enableHighAccuracy: false`); manual city/region/country edits clear stale coordinates.
- Accessible Location card with detection, clear, coordinate hint, and error states.
- Reducer handling for detection busy state, stale-response suppression, validation, and dirty tracking.

**Key invariants**

- The user’s location never enters the plain personalization prompt prefix.
- Exact coordinates are not exposed as saved data; only coarse two-decimal values are retained.
- Detection never runs on mount or page load.
- Upstream/geocoder errors do not leak raw coordinates or provider details.

**Commits:** `20e9e1d`, `739953a`, `1956d34`, `94bf685`, `e09dfcb`, `24e5382`, `a8a76ca`, `b4af973`, `b6a2da1`, `1a40851`.

**Focused verification:** 4 backend files / 20 tests; 1 frontend file / 10 tests.

### Milestone 2 — `get_environment`, Cached Open-Meteo, and Calendar Timezone Alignment

**Goal:** add the built-in environment tool, shared weather contract, cached weather service, and timezone alignment across native execution paths.

**Delivered**

- Strict `WeatherView` schema with 12 KiB backend cap, validated WMO codes, bounded hourly/daily arrays, and fixed Open-Meteo attribution.
- Frozen `get_environment` JSON Schema, native tool definition, and strict argument/result contracts.
- WMO code-to-condition map.
- `WeatherProvider` port and `OpenMeteoWeatherProvider` with:
  - 24-hour geocoding cache and 15-minute forecast cache;
  - bounded LRU capacity (256 entries);
  - 5-second timeout and 256 KiB response cap;
  - injectable fetcher/URLs/API key for tests and deployment.
- Pure executor with datetime, four-tier location precedence, partial-success weather, and `WeatherView` projection.
- Model validation, repair feedback, historical-call validation, context admission, and fixed-tool prefix accounting.
- Calendar default-timezone alignment: explicit `AURVIN_GOOGLE_CALENDAR_TIME_ZONE` wins; otherwise validated `clientTimeZone` is used; `Etc/UTC` is the final fallback.
- `requestGeo` propagation through HTTP and voice; bootstrap weather-provider wiring.
- `get_environment` execution in both `CalendarLoop` and the web-only/tool-capable text loop.
- `onWeatherView` hook for Milestone 3 presentation.
- System policy covering direct use, batching, freshness, weather fallback, and Dev-mode exclusion.
- Native-tool catalogue assertions updated from three to four built-ins.

**Key invariants**

- Stable datetime/day/timezone context stays in the prefix; volatile or rich location/weather values travel only through the tool.
- No pre-model database read is added; saved location comes from cached personalization memory.
- One tool call per decision; Dev mode never dispatches `get_environment`.
- Weather failure cannot erase a successful datetime/location result.
- Explicit location overrides saved and edge-derived location.

**Commits:** `02dab22`, `bf21703`, `7dfa7db`, `309b145`, `9ddfad0`, `800767c`, `fa6f0d8`, `e4ecfc8`, `8d1a6fb`, `be61b37`, `792db49`.

**Focused verification:** 8 backend files / 27 tests.

### Milestone 3 — Structured Weather Canvas

**Goal:** deliver structured Weather Canvas cards across persistence, text SSE, live voice, navigation, inline follow-ups, and voice-first auto-open.

**Delivered**

- Assistant-only optional `weatherView` on `MessageRecord` and visible messages.
- `hasCanvasContent()` recognition and assistant projection forwarding.
- SSE `weather-view` events and `completed.weatherView`.
- Bounded live `weather.frame` payloads (16 KiB UTF-8, live-only, dictation rejected).
- `canvas.inventory` weather ownership and `ownsCanvas()` authorization for archive/live IDs.
- Runtime capture through `MemoryTerminal`, async terminal persistence, promoted publication, replay, and output-capacity accounting.
- Live voice forwarding from streamed weather events.
- Strict frontend protocol mirror with safe Open-Meteo attribution and a 14 KiB view cap.
- Weather workspace folding/merging, archived/live aliases, and bounded inventory ownership.
- Scrollable Weather Canvas renderer with:
  - WMO inline SVG icons;
  - location source badge;
  - inline `Change city` form and Personalization shortcut;
  - current conditions and metrics;
  - hourly strip;
  - multi-day temperature range bars;
  - Open-Meteo CC BY 4.0 attribution;
  - snapshot-keyed error boundary.
- Structured `CanvasPanel` mode without pan/zoom/code/copy/download controls.
- Chat reducer fencing by session/turn/attempt/sequence; terminal attachment; active artifact migration.
- Inline text-mode cards, voice transcript modal cards, and weather-aware voice grouping.
- Live voice reducer/controller weather frames with sequence, epoch, attempt, cancelled-response, and turn/response scoping.
- Voice-first auto-open, dismissal stickiness, scroll-mode presentation, and `Change city` submission.
- Concise spoken-weather system guidance with no duplicate fenced visuals.

**Key security and presentation invariants**

- `canvas.artifact` remains limited to `mermaid`, `chart`, `svg`, and `calendar`; weather cannot be spoofed through model-authored prose.
- Structured weather is accepted only through validated SSE/voice payloads.
- Open-Meteo attribution URL is pinned to `https://open-meteo.com/`.
- Weather Canvas IDs require an owned assistant record with `weatherView`.
- Weather mode is a normal scroll surface, never a pan/zoom stage.
- Text mode never auto-opens Canvas; voice auto-open is one-time per workspace.

**Commits:** `85a3ac8`, `f43e153`, `4c5cd11`, `9d51b18`, `a81c6a0`, `b528062`, `8af4f71`, `86da040`, `6f1dc21`, `d782263`, `a4d9cd1`.

**Focused verification:** 3 backend files / 10 tests; 7 frontend files / 34 tests; full frontend suite 117 files / 979 tests.

---

## 5. Cross-milestone invariants

- **Prompt-cache stability:** `environmentContextMessage` keeps the stable date/day/timezone tuple. Rich location and weather values are tool-only, and `location` is excluded from the personalization prefix.
- **Zero pre-model database I/O:** request environment and personalization caches are server-memory reads; the environment tool adds no pre-dispatch persistence.
- **Privacy:** no raw IP retention; trusted proxy geo only; coarse personalization coordinates; no upstream geocoder error text in client responses.
- **Boundedness:** 16 KiB tool arguments/results; 12 KiB backend `WeatherView`; 14 KiB frontend view guard; 16 KiB weather voice frames; bounded caches and Canvas workspaces.
- **Failure isolation:** weather is partial-success; invalid presentation cannot fail chat or voice; Canvas render errors are contained by a weather boundary.
- **Security boundary:** structured weather bypasses `canvas.artifact`; only validated SSE and voice frames can create a Weather Canvas.
- **Authority:** `get_environment` is unavailable in Dev mode; Canvas navigation requires owned records; persistence remains assistant-only.

---

## 6. Verification evidence

### Current commands

| Directory | Command | Result |
| --- | --- | --- |
| `backend` | `npm run build` | Pass |
| `backend` | `npm run lint` | Pass, warnings only |
| `backend` | Focused environment/personalization/weather suite (18 files) | 18 files / 72 tests pass |
| `backend` | `npm test` | 4,178 passed · 72 failed · 14 skipped |
| `frontend` | `npm run build` | Pass |
| `frontend` | `npm run lint` | Pass, warnings only |
| `frontend` | `npm test` | 117 files / 979 tests pass |

The focused suite combines the Milestone 0–3 backend specs, including:

- `backend/src/platform/environment/request-environment.spec.ts`
- `backend/test/http/request-environment-http.spec.ts`
- `backend/test/runtime/request-environment-runtime.spec.ts`
- `backend/test/personalization/reverse-geocode.spec.ts`
- `backend/test/personalization/personalization-service.spec.ts`
- `backend/test/context/personalization-context.spec.ts`
- `backend/test/runtime/personalization-runtime.spec.ts`
- `backend/test/contracts/weather-view.spec.ts`
- `backend/test/contracts/environment-tools.spec.ts`
- `backend/test/environment/weather-service.spec.ts`
- `backend/test/environment/environment-tool.spec.ts`
- `backend/test/environment/weather-bootstrap.spec.ts`
- `backend/test/runtime/calendar-timezone.spec.ts`
- `backend/test/runtime/environment-tool-calendar.spec.ts`
- `backend/test/runtime/environment-tool-text.spec.ts`
- `backend/src/contracts/weather-wire.spec.ts`
- `backend/src/chat-runtime/weather-canvas-runtime.spec.ts`
- `backend/src/voice/agent/weather-voice-frame.spec.ts`

Frontend-focused coverage includes timezone, personalization, weather protocol/workspace/renderer/panel/chat-state/live-voice integration, and style contracts.

### Full backend suite caveat

The current full backend run is **not clean**: 72 failures across 19 files. Failures are concentrated in areas requiring native storage or external prerequisites, performance-baseline suites, and older assembly/Calendar fixtures. Examples observed:

- assembly and multi-calendar HTTP tests returning `503 Service Unavailable` where storage initialization is unavailable;
- native persistence/local-open tests;
- performance baseline and latency-cap comparisons;
- `calendar-simplification.built.spec.ts` missing a built `/dist/...` fixture;
- older Calendar/memory fixtures with stale expectations;
- `calendar-memory-voice` and `finalization-repair` fixture mismatches.

Milestone 0’s recorded baseline was 61 failures across 16 files at parent `078dc20`, attributed to the same performance/native-Mongo/assembly categories. The current tree reports 72 failures across 19 files. A parent-commit re-baseline was not repeated after Milestones 1–3. A clean full backend gate still requires the operator-supplied MongoDB prerequisites and a refreshed/qualified performance baseline.

No Milestone 3 weather spec appears in the failing set.

### Not exercised

- Live Open-Meteo or Nominatim network calls.
- Real browser geolocation permission prompts and browser visual inspection.
- Real LiveKit voice media, OpenRouter inference, or staging topology.
- Native MongoDB/Azure persistence certification.
- Production deployment or public access.

The UI and voice checks are deterministic Node tests, including `react-dom/server` rendering and controller fixtures. They do not certify live provider behavior or a wall-clock SLA.

---

## 7. Known limitations and recommended follow-ups

1. **Full backend gate:** provide the documented native MongoDB test environment and rerun the full suite; classify or refresh the legacy performance/assembly baselines.
2. **Live provider smoke:** run authorized, bounded staging checks for Nominatim, Open-Meteo, OpenRouter, and LiveKit.
3. **Browser validation:** verify permission denial, repeated detection, mobile Location card layout, and Weather Canvas responsiveness in a real browser.
4. **Cache scope:** weather and geocode caches are process-local; multi-instance deployment needs an explicit shared-cache or per-instance policy.
5. **Production access:** authentication and access-control decisions remain outside this program; no public deployment was authorized.

---

## 8. Commit ledger

**Milestone 0**
- `3c6f28e` — browser timezone header and request environment foundation
- `670110f` — assembly fixture warm-up

**Milestone 1**
- `20e9e1d` — SavedUserLocation contract and legacy default
- `739953a` — location omission invariant
- `1956d34` — bounded Nominatim client
- `94bf685` — reverse-geocode endpoint
- `e09dfcb` — frontend location protocol
- `24e5382` — frontend reverse-geocode client
- `a8a76ca` — click-driven browser geolocation
- `b4af973` — location reducer and validation
- `b6a2da1` — LocationCard and panel wiring
- `1a40851` — admin fixture correction

**Milestone 2**
- `02dab22` — bounded WeatherView schema
- `bf21703` — get_environment schema and native registration
- `7dfa7db` — WMO map and cached Open-Meteo provider
- `309b145` — environment executor
- `9ddfad0` — model validation, repair, and context admission
- `800767c` — Calendar timezone alignment
- `fa6f0d8` — requestGeo and bootstrap weather provider
- `e4ecfc8` — CalendarLoop execution and onWeatherView
- `8d1a6fb` — web-only/tool-capable text path
- `be61b37` — system environment policy
- `792db49` — native-tool assertion updates

**Milestone 3**
- `85a3ac8` — weather wire and persistence contracts
- `f43e153` — runtime persistence, SSE, and Canvas ownership
- `4c5cd11` — live weather frames and voice guidance
- `9d51b18` — frontend protocol mirror
- `a81c6a0` — weather workspace, artifacts, and inventory
- `b528062` — renderer, icons, and styles
- `8af4f71` — structured CanvasPanel mode
- `86da040` — chat state, SSE dispatch, and inline cards
- `6f1dc21` — live voice auto-open and Change city
- `d782263` — backend/frontend voice contract parity
- `a4d9cd1` — Open-Meteo CC BY 4.0 attribution

---

## 9. Primary artifacts

| Area | Key files |
| --- | --- |
| Request environment | `backend/src/platform/environment/request-environment.ts`, `request-environment-store.ts`, `frontend/src/api/client-timezone.ts` |
| Personalization location | `backend/src/contracts/personalization.ts`, `backend/src/personalization/reverse-geocode.ts`, `frontend/src/features/personalization/LocationCard.tsx` |
| Environment tool | `backend/src/contracts/environment-tools.ts`, `backend/src/environment/environment-tool.ts`, `backend/src/environment/weather-service.ts` |
| Weather contract | `backend/src/contracts/weather-view.ts` |
| Persistence and wire | `backend/src/contracts/message.ts`, `stream.ts`, `voice-wire.ts`, `backend/src/chat-runtime/memory-text.ts` |
| Frontend weather | `frontend/src/api/weather-protocol.ts`, `frontend/src/features/canvas/weather-workspace.ts`, `renderers/weather-view-renderer.tsx` |
| Canvas and chat wiring | `frontend/src/features/canvas/CanvasPanel.tsx`, `frontend/src/features/chat/ChatView.tsx`, `frontend/src/features/chat/state/chat-reducer.ts` |
| Voice wiring | `backend/src/voice/agent/agent-voice-adapter.ts`, `frontend/src/features/voice/state/live-voice-controller.ts`, `live-voice-reducer.ts` |
| Policy | `backend/src/instructions/system.md` |
