# Memory core

Host-independent knowledge and personal-memory algorithms. This private
workspace package is not a new external API or a standalone deployment.
Knowledge and personal memory remain distinct stores; neither cached text
nor a memory document grants access.

```text
host request and authority
           |
           v
core algorithm -- explicit ports --> host / Postgres / provider
```

The package owns browser-safe contracts, isolated parsing and chunking,
document lifecycle, search fusion and sessions, bounded retrieval,
embedding work, personal-memory replacement, and quoted-evidence
reconciliation. Existing Knowledge and Conversations import paths forward
their moved exports.

## Entry points

The root export and the `contracts`, `personal-memory-contracts`,
`compaction-contracts`, and `retrieval-contracts` exports are browser-safe.
Node domain entry points are `parser`, `documents/*`, `search`, `retrieval`,
`embedding-provider`, `embeddings`, and `memory/*`. Import a specific
`ports/*` module for its interface rather than depending on host types.

Core must not import another `@tulipfarm/*` package, Postgres, Temporal,
or ambient environment configuration. The repository lint fence enforces
this rule. Parser subprocess isolation remains part of the parser, not
a replacement for host permission checks.

## Port contracts

| Port                                                                            | Caller-visible responsibility                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [TenantRuntime](src/ports/tenant-runtime.ts)                                    | One tenant transaction with an opaque context and optional deadline. Preserve callback errors and roll back failed work. |
| [KnowledgeRepository](src/ports/knowledge-repository.ts)                        | Named source, document, revision, publication, chunk, proof, and work transitions.                                       |
| [RetrievalRepository](src/ports/retrieval-repository.ts)                        | Ordered citation anchors and budgeted nearby passages; it does not authorize them.                                       |
| [LexicalIndex](src/ports/lexical-index.ts)                                      | Eligible publications and ranked keyword candidates.                                                                     |
| [VectorIndex](src/ports/vector-index.ts)                                        | Eligible vector publications, bounded counts, and nearest candidates.                                                    |
| [SearchSessions](src/ports/search-sessions.ts)                                  | Actor-owned live sessions, expiry, candidate persistence, and eligibility-filtered pages.                                |
| [EmbeddingRepository](src/ports/embedding-repository.ts)                        | Profiles, jobs, cache entries, attempts, claims, retries, and vector publication.                                        |
| [MemoryRepository](src/ports/memory-repository.ts)                              | Revision compare-and-swap and requester-scoped pending-step removal.                                                     |
| [MemoryReconciliationRepository](src/ports/memory-reconciliation-repository.ts) | Maintenance progress, ownership, manual-edit fences, and monotonic watermarks.                                           |
| [TranscriptSource](src/ports/transcript-source.ts)                              | Only eligible direct requester text after the applicable coverage and manual-edit cutoffs.                               |
| [Authorizer](src/ports/authorizer.ts)                                           | Typed allow/deny decisions. Missing or malformed decisions fail closed; a denial retains its error identity.             |
| [KnowledgeAuthorization](src/ports/knowledge-authorization.ts)                  | Bind admission and source/document/file/conversation/task proof checks to the host transaction.                          |
| [EligibilityFilter](src/ports/eligibility-filter.ts)                            | Produce a storage-specific eligibility predicate from host selection. Core does not render SQL.                          |
| [CorpusProvider](src/ports/corpus-provider.ts)                                  | Discover items, fetch content, and report permission evidence. Evidence is not an access grant.                          |
| [EmbeddingProvider](src/ports/embedding-provider.ts)                            | Return explicit dispatch, usage, model/vector, and error outcomes for a batch.                                           |
| [Summarizer](src/ports/summarizer.ts)                                           | Policy, measurement, window, and purpose-scoped summarization with a host fence.                                         |
| [UsageMeter](src/ports/runtime.ts)                                              | Cost calculation, reservation, dispatch/outcome settlement, and usage recording.                                         |
| [Clock, Telemetry, FeatureFlags, EgressPolicy](src/ports/runtime.ts)            | Explicit domain time, import diagnostics, actor/tenant feature selection, and protected-operation egress guards.         |

Repository operations accept named positional tuples to retain the existing
SQL bindings and ordering. Their declared result is
[`RepositoryResult`](src/ports/repository-result.ts): `rows` and nullable
`rowCount`. Driver-private metadata is allowed. A missing row or conflicting
write is not an unsupported-operation fallback; an adapter must implement
the operation or throw its error.

Opaque contexts stay within their transaction. Adapters must not silently
open another transaction or commit individual steps. Reconciliation calls
the model outside the transaction, then checks revisions and watermarks in
a new fenced transaction before applying anything.

## Searchability, freshness and parse failures

A document becomes keyword-searchable as soon as its lexical publication
exists. Search eligibility requires only `lexical_publication_id`; vector
results join the same ranking once the embedding publication is ready, so
embeddings never delay keyword search.

Search hits carry `freshness`: `indexedAt` (when the current publication was
built), `observedAt` (when the indexed revision was observed),
`sourceRevision` (provider revision for external sources, otherwise null) and
`sourceSyncedAt` (the source's last completed sync, or null). Retrieval
documents and `knowledge.read` expose `indexedAt`, `sourceRevision` and
`sourceSyncedAt`, and the tool instructions ask the model to say "indexed as
of" when recency matters. Common migration `0008` adds
`tf_knowledge_sources.synced_at`, set by a trigger when a provider sync
completes.

`parseKnowledgeDocument` retries transient process failures (spawn, abnormal
exit, invalid output, memory sampling) up to `parserRetry.attempts` times with
exponential backoff from `parserRetry.initialDelayMs`. Timeouts and memory
limits fail at once because the same bytes fail the same way. Hosts that queue
parse work retry provider and transient failures with their own exponential
backoff (local Knowledge: 30 seconds doubling, capped at one hour, 8 attempts).

When the converter rejects a document as `unsupported` or `malformed` but the
bytes are valid UTF-8 text without binary markers, the parser indexes the raw
text instead. The result profile then has `fallback` set to the original
failure, and the Knowledge source failures endpoint
(`GET /v1/workspaces/:workspaceId/knowledge/sources/:sourceId/failures`, source
owner only) lists it as `raw-text` next to items that stayed unsearchable.

## Authority and host responsibilities

The host resolves the current principal, locks authority, binds tenant/schema
identity, supplies membership/source/file/conversation/task decisions, and
owns provider ACL tables. Core retains proof freshness, expiry/binding checks,
final evidence rechecks, and fail-closed handling. Supplying a repository,
content, vector, or provider permission report never grants authority.

Google, Slack, GitHub, and Atlassian transports, default source selection,
recap push publication, file/original access, credits, Bud cleanup,
recommendation invalidation, and Temporal composition remain host-owned.
Content access and scheduling use existing host callbacks and engine entry
points, not invented remote-fetch or job-runner behavior. Phase 1 preserves
the host embedding model/profile and its 1,536 dimensions.

## Reference adapters and conformance

`adapters/in-memory` exports `createInMemoryMemoryAdapters({ clock })`.
It provides the three personal-memory storage ports, fixture seeding, and
tenant transactions. It is not a default host authorizer or a simulated
Postgres/FTS/HNSW implementation. The clock supplies epoch milliseconds.
Stored timestamp comparisons preserve microseconds; precision beyond six
fractional digits is rejected explicitly.

Seed fixtures before opening a transaction. Contexts expire when their
callback ends, same-tenant re-entry is rejected, and failures/deadlines
discard the transaction snapshot. Unrelated tenants have independent queues.

`testing/memory-conformance` exports the same three port suites for the
reference and actual Postgres adapters. A fixture supplies isolated state,
`ids`, `seed(input)`, `run(operation)`, and the `memory`, `reconciliation`,
and `transcript` factories. The harness checks port fields, not a driver's
result prototype, and compares timestamps without discarding microseconds.
Keep the distributed harness in build inputs: dependent test caches use
the core build hash.

Build before running core tests:

```sh
pnpm exec turbo run build --filter=@tulipfarm/memory-core
pnpm --filter @tulipfarm/memory-core test
```

Postgres and Temporal integration tests remain in the host and must not
be replaced by reference-adapter tests. See
[the extraction decision](../../docs/adr/0001-memory-core-extraction.md) and
[milestone reports](../../reports/memory-core/STATUS.md).
