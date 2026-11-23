# Isolated voice architecture screening

This standalone package does not modify the Aurvin application. Default commands are offline.
The three candidates are actual Aurvin, actual LiveKit Agents, and actual managed Deepgram Voice Agent protocol.
The managed candidate currently blocks live BYO because required controls are unsupported.

## Setup (this directory only)

- Node 24.18.0 / Windows x64 is the researched host; install using `npm ci`.
- Run `npm run build`, `npm run lint`, and `npm test`.
- Run `npm run corpus:generate` once. It uses local System.Speech, never a paid voice API.
- A preexisting audio directory is not overwritten. Preserve its manifest and hashes for comparisons.
- Silero native readiness belongs to the P2 offline VAD check, not package installation success.
- Backend dependencies and a verified current `backend/dist/` must already exist for Aurvin.
  This tooling never rebuilds or writes under backend. Stale builds yield BASELINE_BUILD_STALE.

## Independent offline commands

- `npm run bench:aurvin`
- `npm run bench:livekit-agents`
- `npm run bench:deepgram-agent`
- `npm run bench` (sequential all-candidate dry-run)

Dry-run imports no credentials into a candidate, opens no DB, room, socket, or provider connection,
and reports capabilities unknown/unrun rather than inventing timings.
Missing implementation modules remain explicitly CANDIDATE_NOT_IMPLEMENTED until their worker lands.

## Credential import and isolation

Live mode reads `backend/.env` or `--env-file=absolute-path` into a private map, with process env taking precedence.
It never updates process.env, .env, source configuration, or source DB settings.
Optional `--read-stored-config` reads only config/aurvin and decrypts with the existing server routine,
then closes that source client before admission. It does not access chats, calendars, or application users.
Missing secrets must be supplied through the chat's private secret tool, never pasted into reports/commands.
Aurvin uses an aurvin_voice_arch_<uuid> database, a synthetic account, real assets, and a read-only in-memory config repo.
No public listener, proxy/tunnel, service deployment, or production migration is performed.

## Live authorization and finite envelope

Only the execution worker runs a freshly authorized pilot. Add --live and --authorization=absolute-path
to an independent or all-candidate command. The JSON authorization is nonsecret and binds nonce,
approvalReference, issuedAtMs, expiresAtMs, sourceHash, configHash, corpusHash, lockHash,
maxUsd=2, maxTurns=18, maxActiveMs=900000, version=1.
TTL is at most 15 minutes, issuance is at most five minutes old, and the nonce is consumed once.
An existing nonce claim or evidence directory is not deleted to authorize a rerun.

One candidate runs at a time, up to six submitted inputs each. Warmups, errors, cancellations, and
barge-in inputs all count. One model dispatch per input; no hidden retries, greeting, speculation,
fallback, tools, or allowance transfer from a blocked candidate.
The whole conservative reservation uses a fresh OpenRouter model catalogue and includes speech,
managed-agent buffer, media buffer and a 10% margin. Missing/unsupported pricing blocks live work.
Reservations are not a provider-enforced invoice cap; unknown invoice components remain unknown.

## Reports and cleanup

Immutable JSON and Markdown go to results/<runId>/<candidate>/ and results/<runId>/report.md.
All artifacts pass schema and secret checks before being written. Raw credentials and provider payloads are excluded.
Final verification uses --publish-reports for all three candidates to create the three folder report.md files
and this package's main report.md. Recompile retained results with
`npm run bench:compile -- --run-id=<run-uuid> --publish-reports`.
Never point the compiler at a different run or merge multiple pilots.

End owned sessions, stop sockets/participants, drain the executor, and delete only rooms claimed by this run.
Retain the uniquely named benchmark DB and evidence identifiers. No broad DB/room cleanup exists.
Uncertain shutdown blocks further paid work and remains visible in the report.

## Interpretation and future audible evaluation

Receipt of decoded non-silent 24 kHz PCM is not speaker audibility or proven heard-prefix delivery.
Aurvin BENCHMARK_UNPROVEN_PLAYBACK and VOICE_DELIVERY_UNKNOWN remain incomplete outcomes.
Aurvin pauses/recoveries are not pooled with uninterrupted warm-session results.
Model/TTS stage metrics and semantics remain null/unknown unless directly observed/verified.
Separate cold setup, onset, hesitation, interruption and completion/proof groups.
A 100 ms decoded quiet cutoff plus 1000 ms stale-tail window is a headless observation, not a DAC measurement.
Uncorrelated new response audio during that window leaves interruption attribution unknown.
The sample is too small for a stable p95/SLA, p99, capacity, or migration decision.
Future browser evaluation needs separate authorization and AudioWorklet/acoustic loopback timing,
heard-prefix/completion proof, and a larger matched corpus; this pilot does not perform it.
Unified review was skipped, not passed.
