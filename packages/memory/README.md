# @tulipfarm/memory

Scoped, versioned Memory engine. This package owns the domain rules for Assertions, Pending
Memory, Episodes, recall filtering, extraction screening, Contradictions, procedural corrections,
Forget, Erase, and telemetry-safe Memory metrics.

## What belongs here

- `MemoryAssertion` and `MemoryStore` contracts.
- Scope authorization via `authorizeMemoryScope`.
- `rememberMemory`, `rememberProceduralCorrection`, `forgetMemory`, and `eraseMemory`.
- Pending Memory confirmation/denial/expiry contracts.
- Recall-time scope and Knowledge-evidence reauthorization.
- Extraction candidate screening and proposal-to-Pending-Memory flow.
- Contradiction safety rules: scoped, trust-ranked, offered-ids-only invalidation.
- Episode contracts shared with API storage, including scope-access telemetry.
- Metric/span names and redaction-safe telemetry helpers.

## What does not belong here

- PostgreSQL implementations, pgvector, SQL, queues, routes, or HTTP shapes. Those live in
  `apps/api/src/memory/`.
- LLM providers, embedding providers, or guardrail implementations. They are ports supplied by the
  composing app.
- Knowledge retrieval implementation. Memory only accepts an evidence-authorization port.
- UI copy or Settings routes.

## Dependency rules

Allowed imports are only the root allowlist in
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md):
`@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`, `@tulipfarm/storage`, and
`@tulipfarm/observability`. Do not import from `apps/*`, `@tulipfarm/knowledge`, `@tulipfarm/llm`,
or provider SDKs.

## Invariants

- Scope authorization checks the scope owner identity; caller authority never widens it.
- Inferred statements are never durable until their scope owner confirms Pending Memory.
- Recall reauthorizes scope and Knowledge evidence before ranking/truncation returns results.
- Exclusions are reason counts only; withheld content never reaches candidates, counts, telemetry,
  or audit safe metadata.
- Contradictions close valid intervals; they do not overwrite or delete Assertions.
- `procedural` Assertions only come from explicit human corrections.
- Forget clears statement text and entities but keeps the tombstone row.
- Erase hard-deletes the Assertion and every derived Memory copy the store can reach.
- Telemetry labels/attributes are bounded enums/counts only. Never emit statement, subject,
  Episode summary, chunk text, entity, query, principal id, business id, Assertion id, Pending
  Memory id, Conversation id, Run id, or Episode id.
