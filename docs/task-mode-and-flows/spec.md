# Task mode and Flows — spec and plan

Status: **Approved 25 Nov 2026 — Phase A in progress.** Nothing here authorizes provisioning, paid live checks, or deployment.

Inspiration: Gemini Agent / Task mode (goal → visible plan → tool steps → approval before changes) and Google Workspace Studio flows (starter + steps, described in plain words, run in the background). This is an original Aurvin feature built on Aurvin's own runtime; it does not copy either product's UI.

Roadmap fit: Phase A is the core of **Release 3 — Agent execution** (task plan and timeline, tool activity, approval cards enforced by backend policy, cancellation, execution history). Phase B is the automations part of **Release 8** ([release-plan.md](../roadmap/release-plan.md)). Both stay behind `frontend/src/app/feature-flags.ts` (`agents`, `automations`) until verified.

Decisions already made (24 Nov 2026): Task mode first, then flows on the same runner; spec before code; flow starters = manual, schedule, calendar event, web page change.

---

## 1. What the user gets

### Phase A — Task mode (in chat)

```
[ Task ◉ ]  Plan a planning call with Priya next week and find 3 venues
───────────────────────────────────────────────────────────────
Aurvin · Task                                          [Stop]
  ✓ Check both calendars for free 1-hour slots next week
  ✓ Search venues near the office (3 sources)
  ▸ Compare price and capacity …
  ○ Create the event                      needs your approval
───────────────────────────────────────────────────────────────
  Create "Planning call" Tue 2 Dec 10:00–11:00 on Work?
  [Approve]  [Skip step]  [Stop task]
```

- A **Task** toggle in the composer (explicit — no surprise multi-step cost). Off = today's chat, unchanged.
- Aurvin first shows a short **plan** (max 8 steps), then runs it immediately. Read steps run without asking.
- Each step streams live status: queued → running → done / skipped / failed, with tool activity (web sources, calendar reads) shown as today.
- **Any step that changes data stops for approval.** Today that is only Calendar create (it already has a confirmation/proposal flow with a durable pre-effect barrier — reused, not rebuilt). Email/doc writes join after Release 6.
- **Stop** cancels between or during steps (existing turn cancel). Completed steps stay visible.
- The final answer is a normal assistant message; the plan/timeline is saved with it and re-renders from history.

### Phase B — Flows (Automations page)

```
Automations › New flow
  "Every weekday at 8, brief me on today's meetings and news about the attendees' companies"
  ─ Starter   Schedule · Mon–Fri 08:00 · Asia/Kolkata
  ─ Step 1    Calendar · list today's events
  ─ Step 2    Web search · news per attendee company   (max 5)
  ─ Step 3    Ask Aurvin · write a one-screen briefing from steps 1–2
  ─ Deliver   New chat "Morning brief · 25 Nov" + sidebar badge
  [Test run]  [Turn on]
```

- **Describe to build:** Aurvin drafts the starter and steps from a sentence; the user edits the form, runs a **Test run** (interactive, as a Task), then turns it on.
- **Starters:** Manual (Run button, or "run my morning brief" in chat) · Schedule (daily / weekdays / weekly / every N hours, with time zone) · Calendar event (N minutes before/after events matching a filter) · Web page change (check a URL every ≥ 60 min, fire when its content changes).
- **Steps:** a tool step (Calendar read, Web search/fetch, Environment), an **Ask Aurvin** step (model reasoning over earlier outputs), and **Deliver**. Steps reference earlier outputs as `{{trigger.*}}` / `{{step2.output}}`.
- **Run history** per flow: status, duration, cost, and a link to the delivered chat.
- **Unattended write rule:** a background run never performs a write by itself. A write step pauses the run as *Needs approval*, badges the sidebar, and expires after 24 h if not approved.

## 2. Design

### 2.1 One runner for both

```
            Task toggle (chat)          Flow starter (manual/schedule/calendar/web)
                   │                                   │
           planner call → plan               definition → fixed plan
                   └──────────────┬────────────────────┘
                             TaskRunner
           for each step: bounded step turn through the existing model/tool loop
           read step → run · write step → pause for approval · cancel → stop
                                  │
                stream events (live)   +   one async write per step boundary
```

A **flow run is a task run whose plan comes from the definition** instead of the planner. Everything else — step execution, approvals, cancellation, limits, persistence, timeline UI — is shared.

### 2.2 Planning

- A separate, structured model call (JSON-schema output) produces `{ goal, steps: [{ id, title, effect: 'read' | 'write' | 'answer', toolHint? }] }`, max 8 steps, titles ≤ 120 chars.
- It is **not** a new native tool inside the chat loop: that loop asserts an exact tool list per request ([calendar-policy.ts](../../backend/src/model/calendar-policy.ts) `assertTools` / `assertCompositeTools`), and normal chat's prompt caching relies on that list being stable.
- Plans with a single `answer` step fall back to a normal chat turn (no timeline noise for simple questions).

### 2.3 Step execution

- Each step runs as one **bounded step turn** through the existing shared model/tool loop (`CalendarLoop` composite path: Calendar, Web, Environment, memory tools) with a synthesized input: goal, step N of M, the step instruction, and bounded summaries of earlier steps (≤ 2 KB each, ≤ 8 KB total).
- Existing per-turn budgets apply **per step** (e.g. web: 5 searches, 5 fetches, 45 s deadline). The task adds its own outer budgets (§2.6).
- **A2 investigation result (25 Nov 2026):** separate hidden step turns are not cheap. The only internal-message path (`visibility: 'internal'`) is coupled to live voice across `finalization.ts`, `reconciliation.ts`, `history.ts` and the context assembler. **Decision: a task runs inside one accepted turn** (one visible user message, one assistant message). `MemoryText.execute` runs the planner call, emits `task-plan`, then drives the existing loop with the plan in context and emits `task-step` transitions. Consequences:
  - Budgets are per task, not per step: the task turn gets the §2.6 task budgets (3 min, 12 model attempts) in place of the normal turn's run timeout; web limits stay per turn.
  - Crash/restart follows the existing turn semantics (interrupted → explicit Retry creates a new attempt linked to the same input). "Continue from the next unfinished step" is deferred.
  - No second runtime and no new persistence owner.
- **Progress decision (25 Nov 2026): inferred from tool activity, no extra model calls.** A model-reported progress tool does not fit: one turn allows at most 8 model dispatches and 6 logical tools (`CALENDAR_LIMITS`, schema-capped), and the loop allows one tool call per model reply, so a progress call per step would exceed the cap for an ordinary 4-step task. Each planned step carries a `tool` family (`calendar` / `web` / `environment` / `none`); [task-tracker.ts](../../backend/src/chat-runtime/task-tracker.ts) advances on matching stream events (`calendar-*`, `web-*`, `weather-view`), marks a write step `awaiting_approval` on a `calendar-clarification` proposal, and closes remaining steps when the turn ends (used tool → done, unused tool → skipped). Ceiling: two consecutive same-family steps tick together.

### 2.4 Approvals enforced by backend policy

- **Phase A (as built):** Task mode adds no new write path. The only write tool (Calendar create) keeps its existing backend-enforced proposal → confirmation → durable pre-effect barrier, so an unapproved create cannot dispatch inside or outside a task. A task's write step shows *Needs your approval*; the confirmation reply is an ordinary turn (never sent as a new task).
- `requiresApproval` in [task.ts](../../backend/src/contracts/task.ts) (fail-closed allowlist) is reserved for Phase B unattended runs, where no user is present to confirm.
- Calendar create keeps its current proposal → confirmation → durable pre-effect barrier → pinned-ID read-back. The task's approval card **is** that proposal; approving it resumes the task. No parallel approval system.
- Editing arguments in the approval card creates a new proposal (old one invalidated), never mutates an approved one.

### 2.5 Reliability rules (from AGENTS.md, applied)

- **Memory-first:** task state (plan, cursor, step summaries) lives in server memory; no DB read/write before model dispatch. One consolidated, bounded, async write per step boundary; a save failure never blocks the next read step.
- **Write steps** keep the existing durable pre-effect evidence; if that evidence is failed/uncertain, do not send.
- **One active task per session** (same rule as one active generation attempt); competing tabs see the running task.
- **Crash/restart:** a task interrupted mid-run is marked *interrupted* on reconciliation, not silently resumed. The user can **Retry** (existing explicit retry: a new attempt linked to the same accepted input). Resuming from the next unfinished step is deferred (§2.3). A write step whose dispatch was ambiguous reconciles by pinned provider ID (existing Calendar recovery) before anything else.
- Distinct terminal states: completed, cancelled, failed (provider / tool / persistence), interrupted, expired (approval timeout), budget-exceeded.
- No private model reasoning is stored; step summaries are model-visible outputs only.

### 2.6 Limits (proposed — owning plan verifies)

| Limit | Task mode | Flow run (unattended) |
| --- | --- | --- |
| Steps per plan | 8 | 8 |
| Step summary carried forward | 2 KB each, 8 KB total | same |
| Task wall-clock (excluding approval wait) | 3 min | 5 min |
| Model attempts per task | 12 | 12 |
| Approval wait | until the user leaves / cancels | 24 h, then *expired* |
| Flows per user | — | 20 |
| Minimum schedule interval | — | 15 min (web change: 60 min) |
| Runs per user per day | — | 50 |
| Cost cap per run / per user per day | config, shown in run history | config; a run that would exceed it is skipped and recorded |

### 2.7 Stream / API contract (versioned)

New stream events in `contracts/stream.ts` (versioned per Release 3's "versioned agent event contract"):

- `task-plan` `{ version: 1, taskId, goal, steps[] }`
- `task-step` `{ version: 1, taskId, stepId, status: 'queued'|'running'|'awaiting_approval'|'done'|'skipped'|'failed', summary?, proposalId? }`
- `completed.task` — final bounded snapshot for history replay.

HTTP (Phase A): `POST /sessions/:id/turns` gains `task: true` (not `mode`, which stays an unknown field: internally `mode` means text vs. voice); `POST /sessions/:id/turns/:turnId/steps/:stepId/skip`; Stop and Retry reuse the existing cancel/retry routes; approval reuses the Calendar proposal confirmation path.

HTTP (Phase B): `GET/POST /automations`, `GET/PATCH/DELETE /automations/:id`, `POST /automations/:id/run`, `POST /automations/draft` (describe-to-build), `GET /automations/:id/runs`. All server-side identity; no user ID from the client.

### 2.8 Persistence

| Data | Where | Bound |
| --- | --- | --- |
| Task run (plan, step statuses, summaries, approvals, causal links to turn/attempt/proposal) | `metadata` (lifecycle evidence; matches its stated purpose) | 1 doc per task, ≤ 32 KB |
| Timeline for history | assistant message metadata (snapshot) | ≤ 8 KB |
| Flow definitions + schedule state (`nextRunAt`, `lease`, `lastRunAt`, change hash for web starter, fired keys for calendar starter) | **new `automations` collection** | ≤ 16 KB per doc; fired keys capped at 200 |
| Flow runs | `metadata` (same task-run shape, `source: 'flow'`) | retention 30 days |

Indexes: `automations {ownerUserId, updatedAt}`, `automations {enabled, nextRunAt}`. Needs a migration note in `operations.md`. Azure remains uncertified (R1); nothing here assumes Cosmos semantics.

### 2.9 Scheduler (Phase B) — why not BullMQ + Redis yet

The admitted topology is **one `single-process` executor per database**. A job queue solves multi-instance coordination we do not support. So:

- Enabled flows are loaded into an **in-memory schedule index** at startup (cold-start rehydration, the allowed exception) and updated on every create/edit/disable.
- A 30 s in-process tick picks due flows from memory, claims each with a CAS on `automations.lease` (guards against the leftover-sentinel takeover case), runs it, and writes `lastRunAt/nextRunAt` after the run.
- **Missed runs** while the server was down run **once** on startup (not N times), recorded as `catch-up`.
- **Calendar starter:** polls the owner's Calendar every 5 min for events in the next window via the existing read port (fresh read), dedupes by `eventId + start`.
- **Web change starter:** fetches the URL through the existing web fetch tool, normalizes the text, compares a SHA-256 hash; counts against the user's web budget.
- `ponytail:` in-process timer + Mongo lease; ceiling = single instance, ≤ ~1k active flows. Upgrade path = BullMQ + Redis when multi-instance is admitted (the Release 8 roadmap entry).

### 2.10 Security and privacy

- Runs execute as the owning user resolved server-side (WorkOS auth exists); OpenRouter `user` set on every attempt.
- A flow whose Calendar or web connection is revoked fails closed and notifies; it never restores revoked authority.
- Prompt-injection guard: content from web pages/calendar is data, never instructions; a step cannot add new write steps to its own plan. Flow plans are fixed at definition time; task plans are fixed after planning (re-planning is out of scope for v1).
- Logs carry IDs only — no message, tool, or page payloads.

### 2.11 Out of scope (v1)

Plan editing before run, mid-task re-planning, parallel steps, multi-agent view, email/Docs/Chat steps (after Release 6), sharing flows between users, external webhooks as starters.

## 3. Plan

Prerequisite: fix the failing suites listed in [feature-status.md](../roadmap/feature-status.md) (compaction-runtime, session-affinity, calendar suites). Task mode drives the same loop; known-red suites would hide regressions.

### Phase A — Task mode (Release 3 core)

| # | Work | Owner area | Done when |
| --- | --- | --- | --- |
| A1 | Contracts: `task-plan` / `task-step` events, task-run record schema, tool `effect` registry, limits constants | `contracts` (P1) | **Done 25 Nov:** [task.ts](../../backend/src/contracts/task.ts) (+ step `tool` family), events in `streamEventSchema`, `completed.task` snapshot, `task-plan` accounting purpose. |
| A2 | Investigate internal step input on the shared loop (§2.3), then `TaskRunner` in `chat-runtime`: planner call, step loop, summaries, outer budgets, cancel, skip | `chat-runtime`, `model` | **Done 25 Nov (single turn, inferred progress):** [task-planner.ts](../../backend/src/model/task-planner.ts) (accounting settles in background), [task-tracker.ts](../../backend/src/chat-runtime/task-tracker.ts), wiring in `MemoryText.execute`, plan as a system message in [referenced-context-assembler.ts](../../backend/src/context/referenced-context-assembler.ts). Memory-first path only; durable path and voice run normal chat. **Phase A completion (27 Nov):** `TaskBudget` in [task-tracker.ts](../../backend/src/chat-runtime/task-tracker.ts) spends one attempt for the planner and one per loop dispatch (Calendar loop `beforeModel`, native tool loop) and stops with `STORAGE_BUDGET_EXCEEDED` / snapshot outcome `budget_exceeded` at 12 attempts or 3 min (checked between dispatches; one in-flight dispatch is still bounded by the turn run timeout, so effective wall-clock is the smaller). Step summaries: the model-visible prose a step produced, taken when the next step starts, ≤ 2 KB each and ≤ 8 KB total (UTF-8 bytes), streamed on `task-step` and shown live; **not saved** with the message (keeps the saved snapshot small) and not re-fed to the model (the single turn already holds its own text). Skip: `TaskTracker.skip` + `MemoryText.skipTaskStep`. Planner accounting now waits for the turn's consolidated save (`runAfterSave`) so a task turn touches no storage before then. |
| A3 | Approval binding: write steps pause on the existing Calendar proposal; resume on confirmation; reject unapproved write dispatch | `chat-runtime` | **Done via existing Calendar flow** (§2.4); step shows `awaiting_approval` + `proposalId`. Remaining steps after a write do not resume after confirmation (single-turn ceiling). |
| A4 | Persistence: task-run doc in `metadata`, snapshot on assistant message, reconciliation → *interrupted*, Retry | `persistence` | **Snapshot done 25 Nov:** `task` on the assistant `MessageRecord` (≤ 8 steps, assistant-only), saved in the one consolidated memory-first write, returned by memory history and `toVisibleMessage`, validated client-side; counted in the streaming output-byte check. Retry keeps Task mode. **Terminal outcomes (27 Nov):** the snapshot gains optional `outcome` (`cancelled` / `failed` / `interrupted` / `budget_exceeded`; absent = completed); a task aborted in flight (disconnect, drain, unsafe exit) is closed `interrupted` and never silently resumed; the client keeps the card with a distinct notice. **Task-run doc in `metadata`: deliberately not added** (Phase A has one turn, one assistant message and one consolidated write, so a second document would add a persistence owner and a cross-collection write for no reader; revisit with Phase B run history). A crash that loses memory leaves only the accepted user message, which is the existing interrupted-turn semantics. Durable path and live voice never carry a task. |
| A5 | HTTP: `task: true`, skip route; central wiring in `app.service.ts` | `http`, P9 wiring | **Done (27 Nov):** `task: true`; `POST /sessions/:id/turns/:turnId/steps/:stepId/skip` (body `{ attemptId }` strict, step id `^s[1-8]$`, identity server-resolved, no storage access, `204`; `ChatRuntime.skipTaskStep` optional, forwarded by `observedRuntime`). No `app.service.ts` change. Skip only affects a **queued** step of the **running** task (else `NOT_FOUND` / `INVALID_REQUEST`): it marks the step skipped, and the tracker never advances onto it. Ceiling: it cannot stop the model from calling that tool in the same turn; writes remain gated by the proposal/confirmation flow. |
| A6 | Frontend: composer toggle, plan/timeline card, approval card, Stop/Skip/Continue, history re-render, loading/empty/error states | `features/chat` | **Done (behind `taskMode` flag, off):** [task-protocol.ts](../../frontend/src/api/task-protocol.ts), reducer `TASK_EVENT`, [TaskCard.tsx](../../frontend/src/components/TaskCard.tsx), composer toggle. Stop = existing cancel. History re-render done (A4). **27 Nov:** per-step Skip button on queued steps of the live task (own pending "Skipping…" and inline error state), live step summaries, outcome notice for stopped/interrupted/failed/budget tasks (on the partial answer, or standalone when no text streamed). Continue is not in the spec's contract (Phase A has no resume; §2.3/§2.5), so it is not built. Not run in a browser this round. |
| A7 | Docs + flag: feature-status entry, operations note | docs | This spec updated; feature-status entry pending release approval (flag stays off). |

**Phase A verification (25 Nov 2026, deterministic fixtures only — no live OpenRouter, browser, or native MongoDB):** backend new tests 22 pass (`task.spec.ts`, `task-planner.spec.ts`, `task-tracker.spec.ts`, `task-mode-runtime.spec.ts`); full backend suite 14 failures in 3 files (4,380 pass), all present on the untouched baseline (performance timing caps, built-assembly suite) — baseline had 22 failures in 4 files; backend build type-check clean; lint clean on changed files. Frontend: 1132/1132 tests, lint no new warnings, build passes. Review skipped (not passed).

**Phase A completion round (27 Nov 2026, same constraints):** new deterministic checks pass: `test/runtime/task-mode-phase-a.spec.ts` 7 (answer-only fallback, ordered read steps, stop, competing tabs, crash → interrupted + retry, budget-exceeded wall-clock, Skip route/runtime), `test/performance/task-mode-latency.spec.ts` 1 (prepared task read step with storage blocked), `test/performance/task-mode-calendar.spec.ts` 3 (write step pauses + one create after approval, unapproved write refused, ambiguous create reconciles by pinned ID), `task-tracker.spec.ts` +5 (summary bounds, skip, outcomes, attempt and wall-clock budget), `routes.e2e-spec.ts` +1 (skip route), frontend +3 (outcome/Skip/summary/client). Backend full suite: 4,398 pass, 18 fail in 7 files; 14 are the known baseline (11 `durable-latency`, 2 `calendar-voice-latency`, 1 `calendar-simplification.built`), the other 4 (`launcher`, `local-guard`, `local-recovery`, `local-open`: local-lifetime lock timeouts/worker exit under parallel load) pass when run alone (17/17). Build and lint clean (existing warnings only). Frontend 1,136/1,136, build and lint (no new warnings in changed files). Findings fixed on the way: a plan that mislabels a write as `read` showed *Done* for a pending proposal (now `awaiting_approval` whenever a proposal arrives), and the planner's accounting write touched storage during the turn (now deferred until the turn's save settles; lost only if the process stops first). Not run: browser, live OpenRouter, native MongoDB.

Still open in Phase A: steps after a write do not resume after confirmation (single-turn ceiling, §2.4); task wall-clock is not a timer abort; Skip cannot prevent the model from using a tool; summaries are not persisted. Review skipped (not passed).

### Phase B — Flows (Release 8 automations)

| # | Work | Done when |
| --- | --- | --- |
| B1 | Contracts: flow definition (starter union, steps, variables), run record `source: 'flow'`, limits | Schema tests |
| B2 | `automations` collection, indexes, migration note, CRUD API, describe-to-build draft endpoint | Native-Mongo tests (when operator URI is supplied) + fixtures |
| B3 | Scheduler: in-memory index, tick, lease CAS, catch-up-once, manual + schedule starters | Fake-clock tests |
| B4 | Calendar-event starter (poll, dedupe, revoked-connection fail-closed) | Fixture tests |
| B5 | Web-change starter (fetch, normalize, hash, budget) | Fixture tests |
| B6 | Unattended approval: pause, sidebar badge, 24 h expiry | Tests below |
| B7 | Frontend: Automations page (flag on), builder form, Test run, run history, notifications | `npm test` + build + lint |

### Required checks (deterministic fixtures — not live-service certification)

- `task plan with only an answer step falls back to a normal chat turn`
- `read steps run without approval and stream task-step transitions in order`
- `write step pauses on a calendar proposal and creates once after approval`
- `unapproved write tool call is refused by the runner`
- `stop during a running step cancels and keeps completed step summaries`
- `competing tabs keep one active task per session`
- `crash mid-task reconciles to interrupted; retry creates a new attempt linked to the same input`
- `ambiguous create inside a task reconciles by pinned ID without another POST` (extends the existing W1–W4 cases)
- `step summaries stay within 2 KB each and 8 KB total`
- `task stops with budget-exceeded at the model-attempt or wall-clock limit`
- `prepared task read steps dispatch with application storage blocked` (memory-first)
- B: `missed schedule runs once after restart`, `lease prevents a double run`, `calendar starter fires once per event`, `web starter fires only on content change`, `unattended write step expires after 24 h without effect`, `revoked connection fails closed without restoring authority`.
- Existing AGENTS.md tool-path checks must stay green.

## 4. Decisions (answered 25 Nov 2026)

1. **Toggle vs automatic** — explicit Task toggle for the first version. Automatic suggestion may follow later.
2. **Plan before run** — no Start click: the plan is shown and runs immediately; write steps stay gated by approval.
3. **Flow delivery** — a new chat in the sidebar (+ badge). Email waits for Release 6.
4. **Scheduler** — in-process (§2.9) now; BullMQ + Redis only when multi-instance is admitted. The Release 8 roadmap line should be updated when Phase B starts.
5. **Limits** — §2.6 values accepted as starting values.

## 5. Local trial (26 Nov 2026)

Live run on the developer machine: backend `npm run start:dev` against the local MongoDB, Vite dev server, real OpenRouter model `baidu/ernie-5.5-flash-preview:free` (cost reported 0), `taskMode` flag on for the run only (not committed). Driven through the API (`curl` + SSE) and a headless Chrome over the DevTools protocol. Account had environment tools only (no web search, no Calendar connection).

| # | Finding | Fix |
| --- | --- | --- |
| 1 | No plan: the planner used exactly its 512-token cap; the reasoning model ran out before finishing the JSON, so the turn fell back to normal chat. | Planner gets the normal reply budget (`min(budgets.maxOutputTokens, limits.outputTokens)`); `finish_reason: length` records `truncated` and yields no plan. |
| 2 | Plan named web search (not enabled); the main model then tried a missing tool and answered "That plugin or tool is not available." | Planner prompt lists only tools this turn has; a plan naming any other tool is rejected (normal chat). |
| 3 | With the plan as raw JSON plus a strict "skip unavailable tools" rule, the model claimed it had no weather tool. | Plan message is numbered titles with real tool names (`get_environment`, `web_tool`, Calendar plugin); skip only if no tool can do the step. |
| 4 | Drafting steps labelled `write`. | Prompt: `write` only creates/changes a calendar event; a tool-less `write` is relabelled `read`. |
| 5 | Two consecutive environment steps: one weather event ticked only the first; the second showed Skipped. | On completion a read step whose tool family was seen in use closes as done (never a write). |

After the fixes: API runs produced bounded plans using only available tools, live step ticks, and complete answers; the browser run showed the toggle, the live card (Waiting), all steps Done on completion, the same card after reload + reopening the chat, and no console errors.

Remaining limits: a tool call that emits no stream event (a date-only `get_environment`) is invisible to progress, so its step can show Skipped; plan quality varies run to run with this free preview model; Calendar create/approval and web search were not exercised (not configured on this account).
