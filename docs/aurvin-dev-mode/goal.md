# Goal: Aurvin User and Dev modes

Port the User / Dev workflow from SayCart (`SayCart/Con-Comm`) to Aurvin. SayCart is a read-only reference. Unlike SayCart, Aurvin's controls live only on its Config page.

## Config and authorization

- In **Manage Aurvin → Config**, show an **Enable dev mode** checkbox and, when enabled, a separate **User / Dev** selector in the same location. Neither control appears in chat or voice UI. Both controls are available only to an authenticated `super-admin` with full account access.
- **Enable dev mode** is a saved Aurvin Config setting, off by default, including for existing configurations with no value. Follow the existing Config save and activation flow. Unsaved or failed changes do not take effect.
- Enabling diagnostics starts in **User** mode. The active selection is server-owned and scoped to the current authenticated super-admin session, not to a chat or browser tab. It follows the admin between text and live voice; it resets to User at sign-in, on server restart, or when the setting is turned off. The saved enablement setting persists across restarts. If already enabled when a session starts, its first eligible turn announces User.
- An ordinary user, unauthenticated or restricted account, or legacy role assumption cannot read or change the mode or activate diagnostics by sending a prefix or request field. Enforce this at the settings and turn boundaries, not just in the UI. Turning the setting off stops diagnostics for newly admitted turns, including on an already-open voice connection. In-flight turns keep their admitted mode.

## Model behavior

- If the feature is off or the caller is ineligible, preserve Aurvin's existing system prompt and user-message handling: no new instructions, mode indicator, or prefix.
- While enabled for an eligible session, add system guidance explaining both behaviors. **User** preserves Aurvin's ordinary behavior. **Dev** gives observable diagnostics about the current conversation (what Aurvin did, which documented behavior applied, and what can or cannot be inferred from available events). Dev questions and replies can appear in normal conversation history, but Dev turns must not execute tools or disclose secrets, raw confidential system instructions, private reasoning, or another user's data. Do not copy SayCart's confidentiality override.
- Keep the current mode authoritative in server-generated model context for every eligible turn. On the **first eligible user turn** after enablement or a successful mode change, add a prefix to the current model-bound user message: `[Current mode: User]` or `[Current mode: Dev]`, followed by a newline and the original message. Selecting the same mode again does not re-arm the prefix. If changes occur before the next turn, only the latest committed mode is announced.
- Text and final live-voice utterances share one pending announcement per authenticated session. Dictation consumes it only when the resulting text is sent. Do not consume it on config navigation, partial speech, rejected input, or a cancelled turn that never reaches model dispatch. Consumption is atomic across text and live voice. Retries of the same admitted turn may reuse its model context; they do not consume another turn's announcement.
- Prefixes and extra instructions are model-only. The original user text or transcript remains unchanged in storage, history, exports, compaction, and the UI. Keep the instructions short and budget the added prompt text. Ordinary turns retain the existing streaming, tool, and memory-first paths. Reuse the existing inference call: no extra model call, database operation, network round trip, or asynchronous work for mode handling before dispatch. When off or ineligible, add no prompt tokens. Verify the turn's call counts with deterministic fixtures rather than claiming a live latency measurement.

## Acceptance criteria

| ID | Expected result |
| --- | --- |
| AC1 | Only an authenticated full-access super admin sees both controls on Config; the selector is available only when enabled. The backend denies unauthorized reads/writes and ignores or rejects attempts to inject a mode. |
| AC2 | Existing Config records default to off. A confirmed save enables/disables the feature, and new turns after disabling have the original prompt behavior. Normal users' prompts never change. |
| AC3 | A session begins in User. Enablement, User → Dev, and Dev → User mark exactly the next eligible model-bound user turn once; unchanged selections, invalid input, and partial dictation do not. The latest committed change wins before dispatch. |
| AC4 | Text and live voice share the same mode and one-shot announcement. Competing admissions do not duplicate it. A new authenticated session cannot inherit active Dev mode or a pending Dev prefix. |
| AC5 | The model receives the conditional instructions and the correct trusted mode, including on follow-up turns without a prefix. No injected prefix or instructions enter persisted conversation data. Dev turns cannot execute tools; normal User mode retains existing behavior. |

## Scope limits

No changes to SayCart, new role or permission model, voice architecture changes, deployment, or live/paid provider tests. Use deterministic test fixtures. MAW runs with `--skip research,review`; planning, worker execution, and final verification remain required.
