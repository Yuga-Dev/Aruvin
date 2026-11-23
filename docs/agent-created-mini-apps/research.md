# Agent-Created Mini-Apps & Self-Authored Tools for Aurvin

**Technical Research, Architecture & Integration Blueprint**  
*Prepared: 18 November 2026 | Status: Research & Proposal (No implementation committed)*

---

## Executive Summary & Recommendation

**Verdict:** Giving Aurvin the ability to create persistent, cross-session **"Mini-Apps"** (user-scoped structured trackers with self-authored read/write interfaces) is **high-value and well-suited to Aurvin**, provided it is built as **declarative, schema-driven data apps** rather than arbitrary code generation or physical database collection sprawl.

### Core Architectural Decision

1. **Use two fixed MongoDB collections (`mini_apps` + `mini_app_records`), never `db.createCollection()` per app.**  
   Partition logically by `(userId, appId)` inside bounded collections registered in `COLLECTIONS` (`backend/src/contracts/collections.ts`) with fixed compound indexes in `APP_INDEXES` (`backend/src/persistence/indexes.ts`). Creating physical MongoDB collections per app triggers WiredTiger metadata/RAM overhead, breaks `APP_INDEXES` governance, and violates Azure Cosmos DB limits (25 containers/database on shared-throughput RU; 100 per serverless account).
2. **Keep the native LLM `tools` array static; route through Aurvin's skill-discovery pattern or 5 fixed meta-tools.**  
   Dynamically adding per-app tools (`log_diet`, `read_diet`, ...) to the model's `tools` array invalidates provider KV prompt caches and degrades tool-selection accuracy as the catalog grows. Reuse Aurvin's `activate_skill` + `call_tool` architecture (`backend/src/contracts/calendar-tools.ts`, `backend/src/chat-runtime/calendar-skills.ts`) with a compact, sorted catalog cached in memory during `AppService.prepareOwner` (`backend/src/app.service.ts:666`) so pre-model DB latency remains **zero**.
3. **Prevent duplicate apps with a 3-stage creation gate and a structured Identity & Routing Descriptor.**  
   Require a **Scope Check** (Preferences vs. Conversational Memory vs. Mini-App), a **Backend Candidate Check** (`CANDIDATE_EXISTS` blocking duplicate creation across synonyms like *diet log* vs. *calorie tracker*), and an explicit **Identity Descriptor** containing `canonicalSlug`, `aliases`, `domainEntity`, `granularity`, positive `useWhen` triggers, negative `doNotUseFor` boundaries, and `usagePulse`.
4. **Upgrade "Read & Write" to a safe Query/Aggregation DSL + Idempotent CRUD + Additive Schema Evolution.**  
   Instead of raw MongoDB queries (NoSQL injection / ReDoS risk) or dumping hundreds of rows into context (LLM arithmetic errors), compile a Zod-validated Query AST into bounded `$match`/`$group` pipelines on the server. Validate writes dynamically against stored schemas, enforce idempotency keys on retries, support `update`/`delete` corrections, and allow backward-compatible `schemaVersion` field additions.

---

## 1. Usefulness, Market Gap & Prior Art

### 1.1 Why Unstructured Chat Memory Is Not Enough

Aurvin already supports durable transcripts, context compaction summaries, and per-user personalization (`user_personalization`). Those solve conversational continuity and tone—**not** longitudinal, quantitative personal state:

- **Precision loss under compaction:** Compaction summaries preserve narrative gist, not exact tables. Asking *"How many grams of protein did I average over the last 14 days?"* fails when half the entries are compressed into prose like *"The user logged several high-protein lunches in early November."*
- **LLM arithmetic and recall fragility:** Even if raw logs stay in context, LLMs lose accuracy summing or filtering across dozens of unstructured turns, and PubMed/PMC evaluations of multimodal LLMs for dietary assessment show ~35–37% Mean Absolute Percentage Error (MAPE) when estimating energy/calories and portion weights without grounded structured pipelines. Separating **natural-language extraction** (LLM) from **deterministic storage and aggregation** (backend code) fixes both reliability and user trust.
- **The long-tail personal software gap:** Users want lightweight trackers for diet, hydration, migraines/symptoms, gym lifts, expenses, reading notes, or pet medications—none of which justify writing and maintaining dedicated first-party NestJS plugins for each niche.

### 1.2 Academic & Industry Landscape

| System / Paper | Core Mechanism | Who Authors Schema / Logic | Strengths | Gaps Addressed by Aurvin Mini-Apps |
| :--- | :--- | :--- | :--- | :--- |
| **LATM** ([arXiv:2305.17126](https://arxiv.org/abs/2305.17126), Cai et al. 2023) | Splits **Tool Maker** (heavy LLM writes Python tools) and **Tool User** (lighter model reuses cached functions) | LLM (Python code) | Cuts repeated reasoning cost via functional caching | Arbitrary generated Python introduces sandbox/security complexity; not a multi-session database UX |
| **CREATOR** ([arXiv:2305.14318](https://arxiv.org/abs/2305.14318), Qian et al. 2023) | Disentangles abstract tool schema design from concrete execution | LLM (code + schema) | Separates planning from operational execution | Designed for single-problem reasoning, not durable user-owned multi-session state |
| **Voyager** ([arXiv:2305.16291](https://arxiv.org/abs/2305.16291), Wang et al. 2023) | Lifelong skill library with iterative error feedback & composition | LLM (JS skills) | Compositional reuse without forgetting | Game/sandbox code library rather than typed user personal records |
| **Letta / MemGPT** ([Letta Memory Blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks)) | Tiered core memory blocks (`human`, `persona`, custom) self-edited by the agent + archival search | Developer defines blocks; agent edits text | Explicit block orthogonality & self-editing | Blocks are character-bounded text/prose rather than typed tabular schemas with server aggregations |
| **Mem0** ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)) | Automatic fact extraction + vector/graph deduplication (`ADD`/`UPDATE`/`DELETE`) | Background extraction pipeline | Low-friction preference & fact extraction | Unstructured semantic facts; awkward for exact numeric queries (*"sum expenses in Oct"*) |
| **Zep / Graphiti** ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)) | Bi-temporal knowledge graph tracking entity/fact validity windows | Background ingestion pipeline | Great for evolving facts & CRM audit history | Heavy graph machinery; lacks user-customizable tabular schemas or Canvas views |
| **Notion AI Databases** | User-defined database tables + AI autofill/Q&A | Human creates properties manually | Transparent, inspectable human UI | High manual setup friction; no seamless voice-first conversational creation & logging |
| **Malleable Software** ([Geoffrey Litt](https://www.geoffreylitt.com/2023/03/25/llm-end-user-programming.html)) | LLMs lower end-user programming slope for bespoke personal trackers | User + LLM iteratively | Matches real human workflows cleanly | Usually standalone prototypes without Aurvin's auth, durability, Voice, and Canvas |
| **Aurvin Mini-Apps (Proposed)** | Declarative JSON schemas + safe Query/Write engine + Canvas + Live Voice | **Aurvin proposes; User confirms; Backend enforces** | Zero sandboxed code risk; zero pre-model DB reads; Voice + Text + Canvas | Requires disciplined deduplication, schema evolution, and aggregation DSL |

### 1.3 Why "Declarative Data Apps" Beat "Generated Code Tools"

In your framing, *"Aurvin defines its read tool and write tool, defines the parameters and description, and calls them against MongoDB."* That phrasing captures the **sweet spot**: Aurvin does **not** need to synthesize executable JavaScript or Python functions. Instead, Aurvin synthesizes a **declarative App Specification (Schema + Routing Descriptor)**, and a battle-tested, deterministic TypeScript runtime executes all validation, persistence, and aggregation safely.

---

## 2. Database & Storage Architecture

### 2.1 Why Creating a New MongoDB Collection Per Mini-App Fails

Spawning physical MongoDB collections dynamically (`db.createCollection("diet_user123")`) is a well-documented MongoDB anti-pattern ([MongoDB Data Models](https://www.mongodb.com/docs/manual/applications/data-models/#polymorphic-pattern)):

1. **WiredTiger RAM & File-Handle Exhaustion:** MongoDB stores namespace metadata and allocates disk/index structures (including the mandatory `_id` index) for every collection. At 500 users × 10 apps = 5,000+ collections, catalog memory and OS file-handle pressure degrade cache hit ratios across the entire database.
2. **Azure Cosmos DB Hard Limits (Verified):** [AGENTS.md](../../AGENTS.md) explicitly notes that Azure deployment compatibility is unresolved and must be respected before introducing new persistence patterns. Per [Azure Cosmos DB Service Quotas & Limits](https://learn.microsoft.com/en-us/azure/cosmos-db/concepts-limits):
   - **Cosmos DB for MongoDB (RU, Shared Throughput):** Hard cap of **25 containers (collections) per database**.
   - **Cosmos DB (Serverless):** Hard cap of **100 collections per account**.
   - **Cosmos DB for MongoDB (vCore):** Caps at **1,000 collections per cluster**.
   Dynamic physical collections would exhaust RU shared throughput with just a handful of test users.
3. **Breaks Aurvin's Governance Model:** Aurvin strictly enumerates all persistence collections in `COLLECTIONS` (`backend/src/contracts/collections.ts`) and creates deterministic non-unique/unique indexes upfront via `APP_INDEXES` (`backend/src/persistence/indexes.ts`). Dynamic collections cannot be cleanly indexed, audited for `userId` isolation, backed up, or purged on `onUserDeactivated(userId)`.

### 2.2 Recommended Design: Two Bounded Collections (Polymorphic + Attribute Hybrid)

Model every mini-app inside **two fixed collections** registered in `COLLECTIONS`:

#### Collection 1: `mini_apps` (Definitions & Routing Catalog)
One bounded document per user-owned mini-app (enforce `budgets.maxDocumentBytes` via `assertBytes`, e.g., max 32 active apps per user, max 24 fields per app):

```json
{
  "_id": "mini-app:u_123:app_diet_01",
  "schemaVersion": 1,
  "userId": "u_123",
  "appId": "app_diet_01",
  "canonicalSlug": "diet_nutrition_log",
  "name": "Diet & Nutrition Log",
  "status": "active",
  "revision": 3,
  "appSchemaVersion": 2,
  "descriptor": {
    "domainEntity": "meal_intake_event",
    "granularity": "One record represents a single meal, snack, or beverage intake event.",
    "aliases": ["diet tracker", "food log", "calorie counter", "macros log"],
    "useWhen": "User wants to log food/drink consumed, track calories or protein/carbs/fat, or query daily/weekly nutrition summaries.",
    "doNotUseFor": "Grocery shopping lists, restaurant wishlists, workout logs, or body weight weigh-ins.",
    "exampleUtterances": [
      "Log 2 boiled eggs and black coffee for breakfast",
      "How much protein did I eat today?"
    ]
  },
  "fields": [
    { "key": "item", "type": "string", "required": true, "maxLength": 200, "description": "Food or beverage name" },
    { "key": "meal_type", "type": "enum", "required": false, "values": ["breakfast", "lunch", "dinner", "snack"], "default": "snack" },
    { "key": "calories", "type": "number", "required": false, "min": 0, "max": 10000, "unit": "kcal" },
    { "key": "protein_g", "type": "number", "required": false, "min": 0, "max": 1000, "unit": "g" },
    { "key": "notes", "type": "string", "required": false, "maxLength": 500 }
  ],
  "defaultSort": { "field": "recordedAt", "direction": "desc" },
  "usagePulse": { "recordCount": 42, "lastRecordedAt": "2026-11-18T06:40:00.000Z" },
  "createdAt": "2026-10-20T09:00:00.000Z",
  "updatedAt": "2026-11-18T06:40:00.000Z"
}
```

#### Collection 2: `mini_app_records` (Polymorphic User Entries + Attribute Pairs)
Combines MongoDB's **Polymorphic Pattern** (typed `data` map keyed by `appId`) with a compact **Attribute Pattern** projection (`attrs: [{ k, v }]` for filterable scalar fields, per [MongoDB Attribute Pattern](https://www.mongodb.com/docs/manual/applications/data-model-attribute-pattern/)) so arbitrary user-defined fields can be filtered quickly via a single compound multikey index without creating per-field indexes:

```json
{
  "_id": "mini-rec:u_123:app_diet_01:rec_991",
  "userId": "u_123",
  "appId": "app_diet_01",
  "recordId": "rec_991",
  "appSchemaVersion": 2,
  "recordedAt": "2026-11-18T08:15:00.000Z",
  "source": { "mode": "voice", "sessionId": "sess_abc", "turnId": "turn_7", "attemptId": "att_1" },
  "idempotencyKey": "u_123:turn_7:app_diet_01:write_0",
  "data": {
    "item": "2 boiled eggs and black coffee",
    "meal_type": "breakfast",
    "calories": 160,
    "protein_g": 12
  },
  "attrs": [
    { "k": "meal_type", "v": "breakfast" },
    { "k": "calories", "v": 160 },
    { "k": "protein_g", "v": 12 }
  ],
  "deletedAt": null,
  "createdAt": "2026-11-18T08:15:02.100Z",
  "updatedAt": "2026-11-18T08:15:02.100Z"
}
```

#### Fixed Indexes in `APP_INDEXES`
- `mini_apps`:
  - `{ userId: 1, canonicalSlug: 1 }` (`unique: true`, prevents duplicate slugs at the DB layer)
  - `{ userId: 1, status: 1, updatedAt: -1 }` (fast owner warmup on `prepareOwner`)
- `mini_app_records`:
  - `{ userId: 1, appId: 1, deletedAt: 1, recordedAt: -1, recordId: -1 }` (bounded range/time queries & cursor pagination)
  - `{ userId: 1, appId: 1, recordId: 1 }` (`unique: true`, direct update/delete lookup)
  - `{ userId: 1, appId: 1, idempotencyKey: 1 }` (`unique: true`, prevents duplicate writes on retry/recovery)
  - `{ userId: 1, appId: 1, "attrs.k": 1, "attrs.v": 1 }` (Attribute Pattern filter index across arbitrary user-defined fields)

---

## 3. Tooling Strategy, Context Caching & Safe Read/Write Engine

### 3.1 Why Never Mutate the Native `tools` Array

Anthropic's engineering research on [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents), [Writing Effective Tools for AI Agents](https://www.anthropic.com/engineering/writing-tools-for-agents), and [Advanced Tool Use / Tool Search](https://www.anthropic.com/news/advanced-tool-use) converges on three empirical findings:
- **Prompt Caching Sensitivity:** Changing the top-level `tools` array per user or mid-conversation invalidates provider KV prefix caches. Keeping core tool declarations frozen preserves prefix hits across turns and users; deferring tool schemas until needed reduces tool-definition token overhead by >85% in large catalogs while keeping only 3–5 relevant schemas active.
- **Selection Accuracy Degradation ("Context Rot"):** Flooding the model with 20–50 similar read/write tool schemas degrades routing precision.
- **Provider Schema Quirks Already Discovered in Aurvin:** As documented in `backend/src/contracts/calendar-tools.ts:227`, Anthropic-family endpoints via OpenRouter reject top-level `oneOf`/`anyOf`/`allOf` in native tool schemas before the model even runs. Static, flat native tool envelopes validated server-side by Zod avoid provider rejections completely.

### 3.2 Reusing Aurvin's `activate_skill` + `call_tool` (Compact Catalog + On-Demand Disclosure)

Instead of generating top-level tools per mini-app, expose Mini-Apps as a **first-class built-in skill namespace** (`mini-apps`) or a fixed set of **5 static native/skill actions**:

| Tool / Action | Purpose | Behavior & Guardrails |
| :--- | :--- | :--- |
| `app_activate` (or `activate_skill`) | Load full schema & recent pulse for one or more mini-apps | Zero DB I/O if cached in memory; returns field types, units, enums, `appSchemaVersion`, and top 3 sample records for context grounding |
| `app_create` | Propose/create a new Mini-App schema | Runs **3-stage duplicate detection** first; returns `CANDIDATE_EXISTS` if an existing app overlaps; creates draft/confirmed app with CAS |
| `app_write` | Insert, update, or soft-delete a record (`op: "create" | "update" | "delete"`) | Compiles & validates `data` against stored schema; enforces `idempotencyKey`, unit/range bounds, and `maxDocumentBytes` |
| `app_query` | Structured read & deterministic aggregation | Accepts only a strictly typed **Query AST** (`dateRange`, field filters, `sort`, `limit <= 50`, `aggregate: { op, field, groupBy }`) |
| `app_evolve` | Safely add/rename optional fields or aliases | CAS on `revision`; increments `appSchemaVersion`; preserves backward compatibility for older records |

**How this solves the "create and use in the same turn" requirement:**  
When a user says *"Start tracking my diet — I just had 2 eggs and toast for breakfast"*, Aurvin does **not** need a backend restart or tool re-registration:
1. Turn step 1: `app_create` validates uniqueness, saves `diet_nutrition_log` (either directly on explicit user request like *"Start tracking..."* or via a lightweight preview confirmation), updates the in-memory registry synchronously (identical to `PersonalizationService.save`), and returns `appId` + schema revision.
2. Turn step 2 (same turn!): Aurvin immediately calls `app_write` referencing `appId: "app_diet_01"` to record the breakfast entry—zero schema reload lag, zero `tools` array mutation.

### 3.3 Runtime Schema Compilation & Safe Query AST

- **Runtime Validation (`Zod` vs `Ajv`):** Aurvin already standardizes on `zod` (`backend/package.json`). Because mini-app field types should remain **intentionally constrained** (for both Canvas rendering and Cosmos/Mongo indexing: `string`, `number`, `integer`, `boolean`, `date`, `datetime`, `enum`, `string[]`), a small deterministic compiler (`buildRecordZodSchema(fields)`) in TypeScript can translate stored field definitions directly into strict `z.object(...).strict()` schemas in ~60 lines—avoiding any external dependency while preserving Aurvin's structured repair diagnostics (`ARGUMENTS_INVALID` with field-level hints, just like `calendar-tools.ts`). *(If full arbitrary JSON Schema draft support is ever needed later, `Ajv` with a compiled-validator `Map` keyed by `${appId}:${appSchemaVersion}` is the drop-in upgrade.)*
- **NoSQL-Injection-Proof Query & Aggregation DSL:** Never allow the LLM to pass MongoDB `$`-prefixed operators. Define a strict Zod AST:
  - `dateRange?: { from?: ISO8601, to?: ISO8601 }` → bound to `recordedAt`
  - `filters?: Array<{ field: string, op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains', value: string | number | boolean | string[] }>` (max 8 clauses, compiled explicitly to `attrs` / `data.<validatedFieldKey>` where `validatedFieldKey` is strictly checked against `app.fields`, blocking `$` or `.` keys and escaping regex metacharacters for `contains`)
  - `aggregate?: { groupBy?: 'day' | 'week' | 'month' | string, metrics: Array<{ op: 'count' | 'sum' | 'avg' | 'min' | 'max', field?: string }> }`
  - `limit`: capped at `50` for raw rows, `90` buckets for aggregations.
  This computes exact calorie/protein sums or weekly averages in MongoDB/TypeScript—**zero LLM math errors** and **bounded context tokens**.

---

## 4. Preventing Duplicate Apps & Unambiguous Cross-Session Identification

This is the single hardest UX and agent-engineering challenge in your proposal. Without discipline, an agent creates `diet_log` in Session 1, `food_intake` in Session 3, and `calorie_tracker` in Session 8.

### 4.1 Three-Layer Duplicate Prevention Pipeline

#### Layer 1: Scope & Intent Disambiguation (System Policy)
Before Aurvin even considers creating an app, enforce clear boundaries across Aurvin's three persistence mechanisms:
- **Tone, style, standing persona rules** → `user_personalization` (`customInstructions`).
- **One-off narrative facts or context** (*"I'm vegetarian"*, *"My meeting is in London next week"*) → conversational / compaction memory.
- **Recurring, structured, queryable items** (*"Track my meals"*, *"Log my migraine triggers"*, *"Track books I've read"*) → **Mini-App**.

#### Layer 2: Mandatory Pre-Creation Candidate Gate (Backend-Enforced)
Even if Aurvin forgets to check its catalog, `app_create` performs a deterministic pre-flight check across all of the user's `mini_apps` (typically 0–32 records, already in memory):
1. **Lexical & Morphological Match:** Normalize `canonicalSlug`, `name`, `aliases`, `domainEntity`, and `field.key` lists (lowercasing, singularization, stopword removal, Jaccard/BM25 token overlap).
2. **Synonym & Domain Cluster Match + Optional LLM Arbiter:** If token overlap or embedding similarity exceeds a threshold (e.g., `score >= 0.45` lexical or cosine `>= 0.78`), **reject automatic creation** with a structured, actionable error:
   ```json
   {
     "code": "CANDIDATE_EXISTS",
     "message": "A similar mini-app already exists. Activate and inspect it before creating a new app, or pass confirmDistinctFrom if intentionally separate.",
     "candidates": [
       { "appId": "app_diet_01", "canonicalSlug": "diet_nutrition_log", "matchReason": "shared domain keywords: meal, calories, food", "recordCount": 42 }
     ]
   }
   ```
3. **Evolve Rather Than Fork:** If the user asks to track a new attribute on an existing domain (*"Now also log fiber with my meals"*), Aurvin calls `app_evolve` on `app_diet_01` instead of spinning up a separate `fiber_tracker`.

#### Layer 3: User Confirmation Preview (Poka-Yoke Gate)
Just like Aurvin's `calendar_create_event` shows a confirmation preview before mutating external state, creating a brand-new mini-app (especially when Aurvin infers the need implicitly vs. explicit user command) should show a concise **App Proposal Card**:
- App Name & Description
- Tracked Fields & Units (`item`, `meal_type`, `calories (kcal)`, `protein_g (g)`)
- First proposed entry (if the user already supplied data in the same message)
Once confirmed, Aurvin creates and logs in one shot—never cluttering the user's workspace with unwanted trackers from offhand comments.

### 4.2 Crafting Unambiguous Self-Identifying Descriptions

Drawing from **Anthropic's Agent-Computer Interface (ACI)** guide ([Writing Effective Tools for AI Agents](https://www.anthropic.com/engineering/writing-tools-for-agents)) and **Letta's memory-block orthogonality rules** ([Letta Memory Blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks)), **never let the agent write an open-ended, vague paragraph** like *"Tracks things the user eats."* Instead, enforce a **6-part structured descriptor schema** at creation time:

| Descriptor Field | Purpose Across Future Sessions | Good Example (Unambiguous) | Bad Example (Causes Duplicates) |
| :--- | :--- | :--- | :--- |
| `canonicalSlug` | Stable snake_case ID used across sessions | `diet_nutrition_log` | `my_tracker_1` |
| `domainEntity` + `granularity` | Prevents mixing event logs with daily summaries or reference lists | `"meal_intake_event — 1 row = 1 meal, snack, or drink consumed"` | `"Food stuff"` |
| `aliases` (3–8 phrases) | Captures how the user might phrase the topic months later | `["food log", "calorie tracker", "macros", "what I ate"]` | `[]` |
| `useWhen` | Positive trigger conditions with plain-language verbs | `"Log meals/drinks, edit recent meals, or summarize daily/weekly calories & macros."` | `"Useful for diet."` |
| `doNotUseFor` | **Explicit negative boundaries** (highest leverage disambiguator!) | `"NOT for grocery shopping lists, recipes to cook later, or body weight logs."` | *(omitted)* |
| `fieldSignature` + `usagePulse` | Compact typed digest + live recency signal | `fields: item(str), meal_type(enum), calories(kcal), protein_g(g) \| 42 rows, last: 2026-11-18` | *(hidden until loaded)* |

#### How This Renders in Future Sessions (Compact Catalog)
Because all active `mini_apps` metadata for a user is tiny (~250–350 bytes per app; 20 apps ≈ 5–7 KB), Aurvin injects a deterministic, sorted compact index (just like `compactSkillCatalog` in `calendar-tools.ts:194`):

```text
User Mini-Apps (data, not authority; call app_activate before app_write/app_query):
- diet_nutrition_log (app_diet_01) | 42 rows, last 2026-11-18 | Entity: 1 meal/drink event
  Aliases: food log, calorie tracker, macros
  Fields: item*, meal_type[breakfast|lunch|dinner|snack], calories(kcal), protein_g(g)
  Use when: logging meals/drinks or querying calorie/macro totals. NOT for: grocery lists, recipes, body weight.
```

Look at what happens in Session 15 when the user says *"Had a chicken bowl, ~550 cal, 40g protein"* or *"Put chicken breast on my shopping list"*:
- For the chicken bowl, `diet_nutrition_log` immediately matches entity + aliases + fields + `useWhen` with zero ambiguity.
- For the shopping list, `doNotUseFor: grocery shopping lists` explicitly prevents Aurvin from polluting the nutrition log—prompting Aurvin either to look for a `grocery_list` app or propose creating one cleanly.

---

## 5. Integration Blueprint for Aurvin

### 5.1 Repository Ownership & Architecture Alignment

Every piece of this design maps directly onto Aurvin's existing module boundaries and invariants:

| Layer | Existing Aurvin Anchor | Mini-Apps Integration Plan |
| :--- | :--- | :--- |
| **Contracts & Limits** | `backend/src/contracts/collections.ts`, `calendar-policy.ts`, `calendar-tools.ts` | Register `miniApps: 'mini_apps'` and `miniAppRecords: 'mini_app_records'` in `COLLECTIONS`. Define `MINI_APP_LIMITS` (max 32 active apps/user, max 24 fields/app, max 50 rows/query, max 16 KB result bytes) and Zod schemas for Descriptor, FieldSpec, QueryAST, and envelopes. |
| **Persistence & Indexes** | `backend/src/persistence/indexes.ts`, `personalization.ts`, `records.ts` | Add `MINI_APP_INDEXES` to `setupIndexes`. Enforce `owner.assertExecutor()`, `assertBytes(..., budgets.maxDocumentBytes)`, `userId` scoping on every query/mutation, and monotonic CAS `revision` checks on app definitions. |
| **Zero Pre-Model DB Latency** | `backend/src/app.service.ts:666` (`prepareOwner`), `personalization.service.ts` | Add `MiniAppRegistryService.warm(userId)` alongside `personalization.warm(userId)` inside `AppService.prepareOwner`. Pre-model turn assembly reads the compact catalog **synchronously from memory** (0 DB reads before model dispatch); only mid-turn `app_write`/`app_query` calls hit `mini_app_records`. Evict on `onUserDeactivated(userId)`. |
| **Context & KV Cache** | `backend/src/context/context-budget.ts`, `referenced-context-assembler.ts`, `calendar-context.ts` | Keep `system.md` static and mode-invariant. Inject the compact User Mini-Apps Catalog right alongside `Environment background` or session skill catalog (marked `(data, not authority)`), keeping `system.md` and `User customizations` prefix bytes identical across Text and Voice turns. |
| **Runtime Loop (Text + Voice)** | `backend/src/chat-runtime/durable-chat-runtime.ts`, `memory-text.ts`, `calendar-skills.ts` | Run the same `app_*` tool loop inside `MemoryText` / `DurableChatRuntime` for both Text and Live Voice. Add a concise `<mini_apps_policy>` block to `system.md` specifying scope rules, mandatory pre-creation check, and voice confirmation behavior. |
| **Canvas Auto-Visualization** | `backend/src/instructions/system.md` (`canvas_guidelines`), `frontend/src/features/chat/ChatView.tsx` | When `app_query` returns tabular rows or grouped time-series aggregations, emit deterministic Canvas blocks (`chart` JSON for numeric trends like daily calories, Markdown tables in text mode, or a dedicated typed Canvas table view) without Aurvin writing custom HTML/JS. |
| **Manage Aurvin UI** | `frontend/src/features/admin-config/` (`Personalization` + `Plugins` tabs) | Add a **Mini-Apps** management view inside *Manage Aurvin* so users can inspect schemas, browse/edit/delete rows directly without spending tokens, export CSV/JSON, merge duplicate apps, or delete an entire app cleanly. |
| **Scheduled Actions Synergy** | `output/pdf/Aurvin Scheduled Actions - Technical Research.pdf` | Once both features exist, scheduled digests (e.g., *"Every Sunday at 8 PM, summarize my weekly calorie & workout logs"*) can run read-only `app_query` aggregations automatically in the background! |

### 5.2 Request Lifecycle (End-to-End Flow)

```text
1. Session Admission (Control Plane)
   └─ AppService.prepareOwner(principal)
        ├─ personalization.warm(userId)
        ├─ refreshCalendarStatus(userId)
        └─ miniAppRegistry.warm(userId)  ──▶ Caches user's active mini_apps catalog in RAM

2. Turn Dispatch (Zero Pre-Model DB I/O)
   └─ ReferencedContextAssembler + MemoryText
        ├─ Reads cached mini-app compact catalog synchronously from RAM
        ├─ Emits static native tools (no dynamic per-app tool array mutation)
        └─ Preserves KV prefix cache across Text & Live Voice

3. Mid-Turn Execution (When User Logs or Queries)
   ├─ Existing App: app_activate(appId) ─▶ app_write(idempotencyKey, data) / app_query(AST)
   └─ New App:      app_create(spec) ─▶ 3-Stage Dedup Check
                       ├─ Overlap found ─▶ CANDIDATE_EXISTS (instructs reuse or app_evolve)
                       └─ Distinct      ─▶ Proposal/Confirm ─▶ Persist mini_apps + update RAM cache
                                                               └─ Immediately usable via app_write!

4. Post-Turn Presentation
   └─ Text reply or Voice summary + Optional Canvas Chart/Table + Manage Aurvin UI persistence
```

---

## 6. Phased Implementation Roadmap & Verification Gates

### Recommended Phasing (Ponytail Minimal Progression)

- **Phase A — Core Registry & Safe CRUD (Text Chat MVP):**
  - Two MongoDB collections (`mini_apps`, `mini_app_records`) + `APP_INDEXES`.
  - Five fixed actions (`app_create`, `app_activate`, `app_write`, `app_query`, `app_evolve`) using Aurvin's existing bounded repair loop (`ARGUMENTS_INVALID` / `CANDIDATE_EXISTS`).
  - Dynamic Zod validator builder + safe Query/Aggregation AST compiler.
  - Lexical/synonym deduplication gate + Canvas `chart`/table output.
- **Phase B — User Control & Hardening:**
  - `prepareOwner` memory-first warmup + CAS concurrency + `onUserDeactivated` cleanup.
  - *Manage Aurvin → Mini-Apps* UI tab (browse records, inline manual edit/delete, CSV/JSON export, archive/delete app).
  - Optional embedding/LLM duplicate arbiter for subtle semantic overlaps (e.g., *"Migraine Diary"* vs. *"Headache Log"*).
- **Phase C — Live Voice & Scheduled Synergy:**
  - Voice quick-logging (*"Log 45 min run, 6 km"*) with concise spoken confirmations and silent Canvas summaries.
  - Read-only `app_query` hooks for Scheduled Actions weekly/monthly review digests.

### Required Verification Matrix (Before Shipping)

1. **Cross-Tenant & Security Isolation:** Verify all reads, writes, updates, deletes, and aggregations reject missing/mismatched `userId`; fuzz `app_query` AST with NoSQL injection payloads (`$where`, `$ne`, `$regex` ReDoS strings, prototype keys `__proto__`, nested `.` paths) and confirm deterministic rejection.
2. **Duplicate Prevention Evaluation Suite:** Replay 30+ multi-session paraphrased prompt sequences (e.g., *"track my lunches"* → *"log breakfast"* → *"how many calories today"* → *"add protein tracking"* → *"separate grocery list"*) and verify zero unintended duplicate app creation.
3. **Memory-First & KV Cache Invariance:** Assert zero DB calls on `mini_apps`/`mini_app_records` before model dispatch on ordinary chat turns (mirroring Aurvin's blocked-storage test discipline); verify `tools` array and leading system prefix stay byte-identical when no mini-app is created.
4. **Idempotency & Concurrency:** Test duplicate `idempotencyKey` retries, concurrent tab updates (`revision` CAS conflict), and `app_evolve` backward compatibility against historical records.
5. **Native MongoDB & Bounded Budget Checks:** Run native replica-set integration tests via `AURVIN_TEST_MONGODB_URI` verifying compound indexes, byte-limit rejection (`maxDocumentBytes`), and query result caps.

---

## Evidence Scope & References

*Scope Note: Codebase anchors and existing Aurvin behavior were verified directly from repository source files. External capabilities and limits reflect published vendor documentation and peer-reviewed/preprint research papers. Runtime latency, LLM duplicate-prevention accuracy, and Azure Cosmos DB parity require measurement in Aurvin's test harness prior to production admission.*

1. Cai et al. (2023), *Large Language Models as Tool Makers (LATM)* — [https://arxiv.org/abs/2305.17126](https://arxiv.org/abs/2305.17126)
2. Qian et al. (2023), *CREATOR: Tool Creation for Disentangling Abstract and Concrete Reasoning of Large Language Models* — [https://arxiv.org/abs/2305.14318](https://arxiv.org/abs/2305.14318)
3. Wang et al. (2023), *Voyager: An Open-Ended Embodied Agent with Large Language Models* — [https://arxiv.org/abs/2305.16291](https://arxiv.org/abs/2305.16291)
4. Anthropic Engineering, *Building Effective Agents* — [https://www.anthropic.com/engineering/building-effective-agents](https://www.anthropic.com/engineering/building-effective-agents)
5. Anthropic Engineering, *Writing Effective Tools for AI Agents* — [https://www.anthropic.com/engineering/writing-tools-for-agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
6. Anthropic, *Introducing Advanced Tool Use (Tool Search & Deferred Loading)* — [https://www.anthropic.com/news/advanced-tool-use](https://www.anthropic.com/news/advanced-tool-use)
7. Letta Documentation, *Memory Blocks (Core Memory)* — [https://docs.letta.com/v1-sdk/memory/memory-blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks)
8. *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory* — [https://arxiv.org/abs/2504.19413](https://arxiv.org/abs/2504.19413)
9. *Zep: A Temporal Knowledge Graph Architecture for Agent Memory* — [https://arxiv.org/abs/2501.13956](https://arxiv.org/abs/2501.13956)
10. Geoffrey Litt (2023), *Malleable Software in the Age of LLMs* — [https://www.geoffreylitt.com/2023/03/25/llm-end-user-programming.html](https://www.geoffreylitt.com/2023/03/25/llm-end-user-programming.html)
11. MongoDB Manual, *Polymorphic Pattern* — [https://www.mongodb.com/docs/manual/applications/data-models/#polymorphic-pattern](https://www.mongodb.com/docs/manual/applications/data-models/#polymorphic-pattern)
12. MongoDB Manual, *Attribute Pattern* — [https://www.mongodb.com/docs/manual/applications/data-model-attribute-pattern/](https://www.mongodb.com/docs/manual/applications/data-model-attribute-pattern/)
13. Microsoft Learn, *Azure Cosmos DB Service Quotas and Limits* — [https://learn.microsoft.com/en-us/azure/cosmos-db/concepts-limits](https://learn.microsoft.com/en-us/azure/cosmos-db/concepts-limits)
