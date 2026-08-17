# @tulipfarm/memory

A user's memory is **one Markdown page**. This package owns its grammar, its section vocabulary's
budgets, the delta algebra that edits it, its hashing and revisions, the `update_memory` Tool, and
telemetry-safe Memory metrics.

The page is stored rendered, in `user_memory.document`, and injected whole into every turn — so
there is no relevance recall, no embedding, no ranking, and nothing to get stale.

## What belongs here

- The document grammar: six ordered sections, one fact per line, no nested headings.
- `applyMemoryDelta` / `replaceMemorySection` and the canonical-line rule they share.
- `renderMemoryDocument` and its lossless inverse `parseMemoryDocument`.
- `MemoryDocumentRepo` — the transactional read/apply/replace surface and its DDL.
- `update_memory`, the sole model-facing write.
- Metric/span names and redaction-safe telemetry helpers.

## What does not belong here

- Route shapes, HTTP, queues, or composition. Those live in `apps/api/src/memory/`.
- LLM or embedding providers. The document needs neither.
- Knowledge retrieval, or UI copy.

## Dependency rules

Allowed imports are only the root allowlist in
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md):
`@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`, `@tulipfarm/storage`, and
`@tulipfarm/observability`. Do not import from `apps/*`, `@tulipfarm/knowledge`, `@tulipfarm/llm`,
or provider SDKs.

## Invariants

- A user's document is theirs alone; no read or write crosses `(business_id, user_id)`.
- A Tool may only add and remove named entries. Removals run **before** additions, so naming one
  entry in both keeps it.
- `replaceSection` requires the hash of the section the caller read, and a writer type excluding
  `"tool"`. A DB CHECK enforces the second, because the `writer` column is caller-supplied.
- Every mutation writes a revision, so an erasure has to clear the history and not just the page.
- An over-budget mutation is rejected whole; the previous document survives unchanged.
- Telemetry labels/attributes are bounded enums/counts only. Never emit document text, section
  content, principal id, business id, Conversation id, or Run id.
