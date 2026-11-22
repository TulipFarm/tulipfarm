# Memory core

Host-independent knowledge algorithms, plus the personal-memory contracts and
transcript helpers that chat uses with Keep. This private workspace package is
not a new external API or a standalone deployment. Personal memory itself lives
in Keep; neither cached text nor a memory document grants access.

```text
host request and authority
           |
           v
core algorithm -- explicit ports --> host / Postgres / provider
```

The package owns browser-safe contracts, isolated parsing and chunking,
document lifecycle, search sessions over the external Knowledge index, bounded
retrieval, and the transcript chunking that background learning reads.
Existing Knowledge and Conversations import paths forward
their moved exports.

## Entry points

The root export and the `contracts`, `personal-memory-contracts`,
`compaction-contracts`, and `retrieval-contracts` exports are browser-safe.
Node domain entry points are `parser`, `documents/*`, `search`, `retrieval`,
and `memory/*`. Import a specific
`ports/*` module for its interface rather than depending on host types.

Core must not import another `@tulipfarm/*` package, Postgres, Temporal,
or ambient environment configuration. The repository lint fence enforces
this rule. Parser subprocess isolation remains part of the parser, not
a replacement for host permission checks.

`parser` also exports `readKnowledgeSegments`. It returns a document's text as
one segment per page, slide or sheet, with recognised media in place, for
callers such as chat that read a document without indexing it.

`recognise` is the one recognition entry point for Knowledge, chat and
tasks. Each file gets one session, which:

- dedupes units by sha256;
- reads the host's cache first, and writes each new result with the SHA-256 of
  the file it came from (`source`), so the host can drop results no file holds;
- runs at most 4 units at once;
- returns one outcome per unit.

With `images: true` (the host's workspace `images` flag) the shared rules also
apply:

- at most `mediaLimits.recognitionsPerFile` (100) units, with `limit` gaps after that;
- a `MediaRecognitionUnavailable` thrown for one unit, such as a failed credit
  reservation, is a `recognition-unavailable` gap for that unit only;
- recognised text is labelled `[Recognised image]`;
- a standalone PNG, JPEG, GIF, WebP or BMP is parsed as one recognised passage
  (engine `image`), so Knowledge search finds its text.

## Port contracts

| Port                                                                            | Caller-visible responsibility                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [TenantRuntime](src/ports/tenant-runtime.ts)                                    | One tenant transaction with an opaque context and optional deadline. Preserve callback errors and roll back failed work. |
| [KnowledgeRepository](src/ports/knowledge-repository.ts)                        | Named source, document, revision, publication, chunk, proof, and work transitions.                                       |
| [RetrievalRepository](src/ports/retrieval-repository.ts)                        | Ordered citation anchors and budgeted nearby passages; it does not authorize them.                                       |
| [SearchSessions](src/ports/search-sessions.ts)                                  | Eligible publications, actor-owned live sessions, expiry, candidate persistence, and eligibility-filtered pages.         |
| [MemoryReconciliationRepository](src/ports/memory-reconciliation-repository.ts) | Maintenance progress, ownership, and per-step progress of background learning.                                           |
| [TranscriptSource](src/ports/transcript-source.ts)                              | Only eligible direct requester text after the applicable coverage and manual-edit cutoffs.                               |
| [Authorizer](src/ports/authorizer.ts)                                           | Typed allow/deny decisions. Missing or malformed decisions fail closed; a denial retains its error identity.             |
| [KnowledgeAuthorization](src/ports/knowledge-authorization.ts)                  | Bind admission and source/document/file/conversation/task proof checks to the host transaction.                          |
| [EligibilityFilter](src/ports/eligibility-filter.ts)                            | Produce a storage-specific eligibility predicate from host selection. Core does not render SQL.                          |
| [CorpusProvider](src/ports/corpus-provider.ts)                                  | Discover items, fetch content, and report permission evidence. Evidence is not an access grant.                          |
| [Summarizer](src/ports/summarizer.ts)                                           | Policy, measurement, window, and purpose-scoped summarization with a host fence.                                         |
| [Clock, Telemetry, FeatureFlags, EgressPolicy](src/ports/runtime.ts)            | Explicit domain time, import diagnostics, actor/tenant feature selection, and protected-operation egress guards.         |

Repository operations accept named positional tuples to retain the existing
SQL bindings and ordering. Their declared result is
[`RepositoryResult`](src/ports/repository-result.ts): `rows` and nullable
`rowCount`. Driver-private metadata is allowed. A missing row or conflicting
write is not an unsupported-operation fallback; an adapter must implement
the operation or throw its error.

Opaque contexts stay within their transaction. Adapters must not silently
open another transaction or commit individual steps.

## Searchability, freshness and parse failures

Keep, the external Knowledge index, answers every search. A document is
eligible once its current publication (`lexical_publication_id`) exists, and
it appears in results once Keep holds that publication. A readable document
Keep has not indexed yet is left out and makes the result `partial`. When
Keep is not configured or cannot answer, search fails with
`KnowledgeSearchUnavailable`; there is no local fallback.

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
For GitHub sources it also lists provider items that failed before becoming a
document (for example `too-large` or a fetch error), with a null `documentId`.
GitHub `denied` coverage markers record missing permissions, not failures, so
the list excludes them.

## Authority and host responsibilities

The host resolves the current principal, locks authority, binds tenant/schema
identity, supplies membership/source/file/conversation/task decisions, and
owns provider ACL tables. Core retains proof freshness, expiry/binding checks,
final evidence rechecks, and fail-closed handling. Supplying a repository,
content, index, or provider permission report never grants authority.

Google, Slack, GitHub, and Atlassian transports, default source selection,
recap push publication, file/original access, credits, Bud cleanup,
recommendation invalidation, and Temporal composition remain host-owned.
Content access and scheduling use existing host callbacks and engine entry
points, not invented remote-fetch or job-runner behavior.

## Conformance

`testing/memory-conformance` exports the reconciliation and transcript port
suites that the Postgres adapters run. A fixture supplies isolated state,
`ids`, `seed(input)`, `run(operation)`, and the `reconciliation` and
`transcript` factories. The harness checks port fields, not a driver's
result prototype, and compares timestamps without discarding microseconds.
Keep the distributed harness in build inputs: dependent test caches use
the core build hash.

Build before running core tests:

```sh
pnpm exec turbo run build --filter=@tulipfarm/memory-core
pnpm --filter @tulipfarm/memory-core test
```

Postgres and Temporal integration tests remain in the host. See
[the extraction decision](../../docs/adr/0001-memory-core-extraction.md) and
[milestone reports](../../reports/memory-core/STATUS.md).
