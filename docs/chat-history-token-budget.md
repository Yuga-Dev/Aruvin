# Chat history token budget and derived context floor

## Outcome and scope

Chat now has an explicit saved-history limit, `chat.maxHistoryTokens`, defaulting to **10,000**. The context total is validated against a floor computed from the loaded fixed assets, so a configuration cannot promise history that the fixed prompt, tool schemas, output reserve, and safety margin already consume. Runtime history admission is fail-closed: an over-limit chat returns `CONTEXT_BUDGET_EXCEEDED` with a history-specific message and never evicts, truncates, or summarizes messages.

This note covers the setting, estimator, floor, admin behavior, and enforcement boundaries. It does not change persistence, checkpoints, retry/cancellation semantics, or provider routing.

## Configuration

| Field | Meaning |
| --- | --- |
| `chat.maxHistoryTokens` | Admission-estimate ceiling for saved history after the fixed prefix, including prior user/assistant turns, tool results, and the current user input. Minimum 10,000; default 10,000. |
| `MAX_HISTORY_TOKENS` | Legacy import environment name for the same value. It is ignored at normal startup like other legacy manageable names and read only by the explicit one-time import. |
| `chat.maxContextTokens` | Total context budget. It must be at least the server-computed floor. |
| `chat.maxMessagesInContext` | Separate message-count cap; unchanged. |

The browser admin form raises `chat.maxContextTokens` live when the operator raises `chat.maxHistoryTokens`. The backend validates strictly on save and does not auto-raise a stored value.

## Deterministic prefix estimate

`backend/src/context/prefix-estimate.ts` computes a worst-case fixed prefix from the assets actually loaded at runtime:

- `system.md` instructions and `product_knowledge.md` product background;
- maximum admitted custom instructions (1,500 characters, including the 6,000-byte UTF-8 ceiling);
- a fixed sample environment message with a long representative time zone and weekday, so the number does not change from day to day;
- the larger of the text and voice response-mode selector messages;
- worst-case native tool schemas: `activate_skill`, `call_tool`, `control_canvas`, and `web_tool`, regardless of current plugin state.

The estimator is the shared byte-based prompt estimate (UTF-8 JSON bytes + 32 bytes per message + 256 tokens of global framing), applied to the prefix segments. It is deliberately conservative and is **not a provider tokenizer**. The 10,000-token history value is an admission estimate, not a tokenizer count; a real tokenizer would produce a different number.

`minContextTokens = prefixTokens + maxHistoryTokens + maxOutputTokens + modelMarginTokens`. The prefix breakdown is reported separately as fixed assets, personalization, and tool schemas.

## Runtime enforcement

Each assembled prompt is split at an explicit `prefixCount` boundary. History is every message after the fixed prefix, including the current user input and Calendar tool call/result groups. `historyTokens = estimate(history)`; the 256-token global framing belongs to the prefix so the total estimate stays consistent. If `historyTokens > maxHistoryTokens`, admission returns `CONTEXT_BUDGET_EXCEEDED` with a history-specific message. The existing total-prompt and message-count checks remain as backstops.

The text path (`referenced-context-assembler.ts`), the Calendar path (`calendar-context.ts`, counting tool results and reinserted historical groups), and the web paths (`web-context.ts` for composite turns and the web-only loop in `memory-text.ts`) enforce the same rule. Neither path removes or summarizes history.

## Admin read and defaults

`PublicAdminConfig.chatFloor` returns the computed minimum and breakdown from the backend:

```text
chatFloor = {
  minContextTokens, prefixTokens,
  breakdown: { fixed, personalization, tools },
  historyTokens,
  reserves: { maxOutputTokens, modelMarginTokens }
}
```

The browser renders these values instead of duplicating the estimator. It compares the edited context total against `chatFloor.prefixTokens + history + output + margin` and annotates the context/history/reserve fields when the total is below that minimum.

A fresh install has no stored document and projects a default `maxContextTokens` computed from the loaded assets, not the historical 16,384 placeholder. Stored configurations created before this setting was added parse with the 10,000 default; a stored total below the floor is readable in the admin UI but fails activation and save validation with a configuration error whose message names the computed minimum and breakdown. Operators must raise the total or lower the history budget.

## Verification

Deterministic backend coverage in `backend/test/context/history-budget.spec.ts`, `backend/test/context/calendar-context.spec.ts`, and `backend/src/admin-config/admin-config.service.spec.ts` covers:

- 9,999 rejected and 10,000 accepted by configuration, 10,000-token history accepted and 10,001 rejected at runtime;
- prefix excluded from history and history excluded from prefix;
- total below the floor rejected, exactly at the floor accepted, floor + 1 accepted;
- maximum personalization and worst-case tool schemas included;
- Calendar and web tool results counted in history;
- a fresh-install default computed from real loaded assets and satisfying the floor.

Frontend coverage in `frontend/src/features/admin-config/config-edit-state.test.ts` covers the live context auto-raise, the 10,000 minimum, and floor rejection. Package build, lint, and test results are recorded in the task handoff report; this note does not claim a live provider, native-database, or staging check.
