# Unit B0 spike: checkpointer, edit and regenerate

Status: findings recorded 27 November 2026 (phase 1). Plan reference: `docs/release-1/plan.md` section 4 (Checkpointer). Review: skipped.

## Question

Do LangGraph checkpoint-restored messages change what the model sees when a turn is regenerated (new attempt, same user message) or edited (new turn whose user message supersedes the old one)?

## Findings

1. **The checkpointer holds no transcript.** `TurnState` (`backend/src/agent/state.ts`) has only replace-value channels: `input`, `boundary`, `result`, `sealed`, `rebase`, calendar cursor/seal/refs. There is no `messages` channel. `backend/test/runtime/graph.spec.ts` already asserts `not.toHaveProperty('messages')`. Each attempt invokes the graph with a fresh `{ input, result: null, sealed: false, rebase: null }` (`durable-chat-runtime.ts` around lines 2105 and 2550), on the per-session thread (`graphConfig` in `finalization.ts`). Nothing from a replaced turn can leak through checkpoint restore, so no rebase marker and no checkpoint deletion is needed. The plan's fallback (the `rebase` channel) is not required.
2. **Context is application-selected.** Both paths build the model context from the manifest of original message references: memory-first `MemoryFirstFoundation.context()` (`memory-first-foundation.ts`, filter `eligible`) and durable `checkBoundary` over `acceptedHistory` (`history.ts`), both consumed by `selectReferences` (`context/reference-selection.ts`).
3. **Regenerate of a completed turn breaks selection today.** `selectReferences` accepts, for the turn being generated, only its user input and throws `inconsistent()` for any other record of that turn. A completed earlier answer of the same turn (always eligible) would therefore fail the context build, not duplicate. Retry never hit this because failed or cancelled answers are ineligible. Test: `regenerate in flight: ...` in `backend/src/chat-runtime/revision-history.spec.ts`.
4. **Exactly-once input holds.** Finalization builds the target manifest from `history` (the prompt manifest, which excludes the current turn's old answers) plus the input plus the new assistant. After a regenerate the old answer is out of the new manifest, and the next turn reads only the newer answer.
5. **Edit needs whole-turn exclusion.** The edited turn's user message and all attempt outputs must be dropped from later context. The new user message's `supersedes` names the old user message; every record of that turn is hidden.

## Decision

One pure rule, in `backend/src/chat-runtime/history.ts`:

- `supersededIds(records)`: ids named by any `supersedes`, plus every record of the turn whose user message was superseded.
- `contextRecords(records, currentTurnId)`: drops superseded ids and any non-user record of the turn being generated.
- `acceptedHistory` already applies `contextRecords` (no behaviour change without `supersedes`).
- Ordered guards for both runtimes: `reviseRefusal(facts)` (epoch, live or canvas-only, latest turn, compaction, active attempt, attempt cap 5, bounds, unchanged edit). `MemoryText.retry` and `DurableChatRuntime.acceptRetry` will call this one entry in phase 2; no third path.

## Open points for phase 2

- `memory-first-foundation.ts context()` and `records()` also need `contextRecords(records, turnId)`. The file is outside Unit B's listed ownership; phase 2 makes a one-line change there and reports it as a deviation.
- `messageRecordSchema` is strict, so `supersedes` is a local type alias until Unit 0 lands (`RevisableRecord`); the spec strips it before calling the real builders. Swap for the contract field in phase 2.
- Error codes `REVISION_NOT_LATEST` and `REVISION_TOO_OLD` are plain strings in `ReviseRefusal` until Unit 0 adds them to `AppErrorCode`.
