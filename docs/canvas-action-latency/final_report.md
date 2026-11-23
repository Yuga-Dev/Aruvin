# Canvas action latency — 12 November 2026

## Outcome

Resumed and completed the interrupted focused fix without recreating its edits.
Memory-first text/live voice dispatch can use history prepared when opening a
conversation or admitting a microphone session. First live binding/duplicate
lookup no longer accidentally falls through to database reads just because its
memory owner has not yet been instantiated.

`show_canvas` queues navigation before execute-time full-context rebuilding or
result-capacity preflights. The paired result is staged afterwards; subsequent
model dispatch still checks full context bounds. Canvas controls have their own
bounded FIFO, independent of unrelated ordinary-control publish waits. Ownership,
schema, lifecycle, cancellation and queue checks remain; actual external-mutation
durability barriers are unchanged. Existing asynchronous save behavior is reused.
“Requested” means queued, **not** confirmed browser display.

Two defects in the interrupted edits were corrected during resumption: preparation
must be best-effort even for synchronous runtime errors when reading the archive;
and memory preparation on reservations applies only to eligible memory-first voice,
not legacy durable voice. Both have runnable regression coverage.

## Verification environment and evidence

Windows, Node `v24.19.0`, installed Vitest `4.1.11`. Baseline commit:
`b9cfaf72e770fe2c5889ac795ca7b357dc40365c`. Deterministic fake database/provider
fixtures only; database integration environment variables were blanked for broad
suites. No live calls, external database mutations, provisioning or deployment.
Review **skipped** by instruction; frontend unchanged, so frontend checks not run.

- `npm run build`: passed.
- `npm run lint`: exit 0, existing warnings (including unbound-method warnings);
  not a warning-free result.
- Focused text/Canvas/control files: **45 passed**.
- Focused voice follow-up/long-answer/overflow cases: **4 passed**, one unrelated
  AppService test excluded by name filter (not counted as passing).
- Cold HTTP/live preparation, synchronous archive fallback, and both legacy voice
  critical-path cases: **5 passed**.
- Consolidated final focused run across all five changed test files: **65 passed,
  1 excluded** using `-t '^(?!.*falls back to durable runtime)' --maxWorkers=1`.
- Final full routine run: **3268 passed, 34 failed, 10 skipped**, one worker-exit
  error; 358 passed files, seven failed, two skipped. Not a green suite.
- Final `npm run test:e2e -- --maxWorkers=4`: **35 passed, 8 failed, 140 skipped**;
  three passed files, one failed, 44 skipped. Not a green suite.
- `git diff --check`: passed (line-ending conversion warnings only).

### Baseline replay

Detached temporary baseline worktree used the same installed dependencies and
copied regression tests, without modifying baseline implementation or resetting
the active checkout. Canvas queue isolation, preflight ordering, retained pairing,
and both first-voice variants failed against baseline and passed on the fix.
Cold HTTP/live regressions failed because submission performed **15/16 additional
fake database commands**, respectively; both pass with zero additional commands
through first dispatch after preparation. The earlier direct-preparation test
also fails on baseline because that method did not yet exist; the HTTP/live tests
provide the behavioral comparison instead.

The synchronous preparation regression was observed failing on inherited edits
before its correction. Legacy voice's existing regression exposed the over-broad
reservation preparation and passes after restricting preparation to memory voice.
No claim is made about an unavailable pre-interruption red run.

### Broad-suite failures

The completed pre-final routine run (`npm test -- --maxWorkers=4`) reported
**3268 passed, 33 failed, 10 skipped, one worker-exit error**. Its new legacy-voice
failure was fixed and independently rerun successfully. All other **32** failed
tests were reproduced in seven unchanged baseline suites: local lifetime guard
(3), local persistence opening (3), Calendar asset instruction (1), built-module
path resolution (1), Calendar confirmation wording (4), BSON redaction (1), and
durable-latency bounds/context gates (19). Baseline selected run: 32 failed,
72 passed. These were not changed or waived.

The initial completed `npm run test:e2e` reported **35 passed, 8 failed, 140
skipped** across 48 files. All eight failures were reproduced in baseline
`test/assembly/voice-bootstrap.e2e-spec.ts` (22 passed, 8 failed), involving
assembled STT/turn dispatch and downstream completion assertions. Native database
tests were skipped, not certified. Full voice performance discovery also encounters
a worker exit in its unchanged AppService fallback test; the baseline reproduces
that worker exit. An unrestricted first routine attempt timed out at 120 seconds;
later concurrency was bounded. A post-correction unrestricted e2e attempt exited
134 with a native Node crash, and a two-worker attempt timed out at 120 seconds
after reproducing the same eight voice-bootstrap failures; neither is a pass.
The final four-worker e2e run then completed with the same eight baseline failures.

The final routine run has **32 reproduced baseline assertion failures plus two
5-second timeouts** in unchanged `follow-up-50-test-budget` cases. Targeted runs
with the default timeout failed both on this checkout and one of two on baseline;
with an explicit 20-second timeout, both cases passed on both implementations.
This is evidence of timing sensitivity, not permission to report the default
full suite as passing. No unrelated assertions or timeout defaults were modified.

## Remaining critical-path limits

- **Universal cold-path zero database I/O is not met.** Direct cold submissions,
  preparation racing submission, expired/evicted clean memory, stale mutation
  state, recovery and incompatible durable history retain safe hydration/durable
  fallbacks. History is not dropped to make the metric appear zero.
- HTTP history opening and existing-session voice admission intentionally perform
  bounded hydration before input submission. Preparation failure does not hide a
  read-only text archive, but does not grant memory inference readiness either.
- Legacy durable mode still uses database ownership/account fencing, decision
  persistence and checkpointing. Immediate Canvas dispatch without storage gates
  is demonstrated for the actual admitted **memory-first** path, not all fallback
  modes. Actual external mutations keep their durable barriers.
- In-memory context assembly/token budgeting and model request serialization are
  still necessary before inference. No zero CPU-cost or wall-clock-zero claim.
- Canvas still waits for preceding Canvas publishes; LiveKit/network/browser work
  and display latency are unmeasured. Independent application lanes cannot remove
  downstream transport congestion. No browser benchmark or deployment claim.
- Presentation may be queued before later result staging/context fails; bounded
  staging is not bypassed. The context-failure regression verifies retained
  requested pairing, failure terminal state, and no duplicate presentation.

## Files and commit set

Verified implementation: `b16aeaf` on baseline
`b9cfaf72e770fe2c5889ac795ca7b357dc40365c`. The subsequent documentation-only
commit contains this report and `state.md`; its hash is supplied in the handoff.
No unrelated files staged. The temporary detached baseline worktree is retained
at `~/AppData/Local/Temp/opencode/canvas-latency-baseline` for evidence;
its dependencies are a junction to this checkout, not a new install.

Changed implementation/test files:

- `backend/src/chat-runtime/calendar-loop.ts`
- `backend/src/chat-runtime/durable-chat-runtime.ts`
- `backend/src/chat-runtime/execution-reservations.ts`
- `backend/src/chat-runtime/memory-text.ts`
- `backend/src/chat-runtime/ports.ts`
- `backend/src/http/chat-http.service.ts`
- `backend/src/operations/observed-runtime.ts`
- `backend/src/voice/transport/livekit-control.ts`
- `backend/test/performance/memory-first-text.spec.ts`
- `backend/test/performance/memory-first-voice.spec.ts`
- `backend/test/performance/memory-text-archive.spec.ts`
- `backend/test/runtime/canvas-navigation.spec.ts`
- `backend/test/voice/transport/livekit-control.spec.ts`

Documentation: `docs/canvas-action-latency/state.md` and
`docs/canvas-action-latency/final_report.md`.
