# Release 1: conversation search index migration

Status: procedure written 27 November 2026. **Not yet measured**: no staging-sized copy, native MongoDB, or Azure run has been done. Fill in the measurement table before the `conversationSearch` flag is enabled.

## What changes

- One new index on `messages`: `{ userId: 1, content: 'text' }`, name `user_content_text`, `default_language: 'none'` (`SEARCH_INDEXES` in `backend/src/persistence/indexes.ts`).
- It is created by `setupIndexes` at startup with the other indexes. `createIndex` with identical keys and options is idempotent.
- MongoDB allows one text index per collection; this one is reserved for search. All roles are indexed. `visibility: 'internal'`, ephemeral, deleted and non-active chats are excluded at query time, not in the index (no partial filter, so it works wherever text indexes work).
- No data migration. Existing messages are indexed by the build.
- The endpoint is `GET /api/sessions/search`; limits: `limit` max 20 (default 10), `q` 2 to 100 characters, 3 s `maxTimeMS`, 100 candidate messages per page, 30 requests per user per minute per process.

## Procedure

1. Restore or copy a staging-sized `messages` collection into an isolated database (never production data).
2. Start the backend once against it; record index build duration and `db.messages.stats().indexSizes.user_content_text`.
3. Run representative searches; record p95 latency.
4. Enable `conversationSearch` only after the numbers are acceptable.

| Measurement | Value |
| --- | --- |
| Messages in the copy | not measured |
| Index build time | not measured |
| Index size (bytes, per million messages) | not measured |
| Search p95 latency | not measured |
| Rollback exercised | not run |

## Rollback

`db.messages.dropIndex('user_content_text')` (index only, no data changes). While the index is missing, the endpoint returns title results with `degraded: true` and the UI shows a title-only notice. Note that the next backend start recreates the index unless the `SEARCH_INDEXES` entry is removed first.

## Azure / Cosmos DB

No Azure profile is admitted and text-index support is unverified (AGENTS.md R1). Only the `native-mongodb` profile is admitted, so message search runs there; any future profile must be constructed with `new MongoSearch(store, { text: false })` (title-only, `degraded: true`) until text indexes are verified with primary documentation and an isolated service test.

## Known limits

- Memory-first: a message is searchable only after its consolidated save; the UI says so.
- Message pages use a ranked offset (`skip` up to 500), not a keyset, because results are ordered by text score. Ranking can drift between pages while new messages are saved.
- Title search is a bounded, regex-escaped, case-insensitive scan over one user's active sessions.
