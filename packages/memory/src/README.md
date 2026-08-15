# memory/ — Memory API adapter, tools, recall, and extraction

Durable Memory for the API app. The old key/value surface still presents a tiny, always-relevant
Core Block of personal facts, but the live storage engine is `@tulipfarm/memory`: scoped,
versioned Assertions, Pending Memory, Episodes, Point-in-time Recall, Contradictions, Forget, and
Erase. Tenant/business source material still belongs in Knowledge; Memory stores durable recalled
facts and history derived for an authorized scope.

## Layers

- **`assertion-view.ts`** — `MemoryAssertionView` (an Assertion as the keyed KV surface sees it) and
  the `MemoryRepo` interface. `assertValidAssertion` is the hard write-time guard. The legacy
  `PgWorkingMemoryRepo` is gone; the `working_memory` table it read still exists, kept one release
  as the cutover's recovery path (see `backfill.pg.test.ts`), but nothing reads it any more.
- **`engine-repo.ts`** — `EngineMemoryRepo`, the live `MemoryRepo`. Implements the
  same interface on top of `@tulipfarm/memory`, so every entry is a scoped, versioned Assertion.
- **`assertion-store.ts` / `pending-store.ts`** — the Postgres `MemoryStore` and
  `PendingMemoryStore` implementations (tables `memory_assertions`, `memory_evidence`,
  `memory_pending`). Interfaces live in the package, implementations here, mirroring
  `PgKnowledgeSourceStore`.
- **`service.ts`** — `MemoryService` owns the write policy: oversize rejection, last-write
  LRU, and the dual cap (≤100 entries **and** ≤ the derived total-char budget; oldest-written
  evicted first). The repo stays a dumb CRUD store.
- **`tool-result.ts`** — the `ToolCallResult` contract (`ok`/`err`). Handlers always resolve, never
  throw, so a bad call is returned to the model for self-correction.
- **`tools.ts`** — `update_memory` / `delete_memory` / `recall_memory` / `remember_correction`
  `PlatformTool` defs: plain JSON Schema + LLM-facing guidance + handlers. Exported as
  `MEMORY_TOOLS`. A tool whose service is not wired is left *unregistered* rather than registered
  to report itself unavailable — `recall_memory` needs a `MemoryRecallService`,
  `remember_correction` a `MemoryLifecycleService`.
- **`recall-index.ts` / `recall-service.ts` / `embedder.ts`** — relevance recall. See *Recall*
  below.
- **`episode-store.ts`** — the Postgres `MemoryEpisodeStore` implementation (tables
  `memory_episodes`, `memory_chunks`). Episodes are historical summaries with decisions/outcomes;
  chunks make them reachable through the same M2 recall tier as Assertions.
- **`lifecycle-service.ts`** — user-facing procedural correction, Forget, and Erase composition.
  The package still owns the authorization and audit contract; this wires the Postgres stores.
- **`ai-toolset.ts`** — `buildMemoryToolSet(ctx)` adapts the tools to the Vercel AI SDK tool loop;
  `execute` closes over the per-request user.
- **`routes.ts`** — `registerMemoryRoutes` exposes the caller's own memory to the web UI
  (Settings → Memory): `GET /api/v1/memory` (list + `maxValueChars`), `PUT /api/v1/memory/:key`
  (edit value only — 404 if the key is absent, 422 over `MAX_VALUE_CHARS`, preserves
  `writtenByAgentId`), `DELETE /api/v1/memory/:key`,
  `POST /api/v1/memory/corrections`, `POST /api/v1/memory/assertions/:id/forget`, and
  `DELETE /api/v1/memory/assertions/:id`.

## Storage engine

Entries are stored as `user_private` Assertions in `@tulipfarm/memory`, not as flat KV rows. The
KV surface above the repo — `MemoryService`, the two tools, the three routes, Settings →
Memory — is unchanged; what changes is underneath:

| KV concept | Assertion |
| --- | --- |
| `key` | `subject` |
| `value` | `statement` |
| `createdAt` | `validFrom` — carried across edits, so an edit does not read as newly true |
| `lastWrittenAt` | `updatedAt` — the LRU ordering `MemoryService` consumes |
| edit | a new version that **supersedes** the prior one, which stays queryable |
| delete | a **tombstone** (`status = 'forgotten'`, statement cleared), not a row drop |

Writes through the KV surface land as `confirmed` / `user_stated` / `preference` with
`origin = explicit`. Inferred memory remains disabled for this surface (`KV_MEMORY_SETTINGS`) so no
unconfirmed statement can bypass the confirmation gate. Extraction uses separate
`EXTRACTION_MEMORY_SETTINGS`, where inferred candidates are enabled but can only become Pending
Memory.

Migration v33 creates the tables and backfills every `working_memory` row. It is replay-safe and
leaves the legacy table in place. `backfill.pg.test.ts` exercises the upgrade path (the ordinary
suite migrates from empty and would never touch it); `engine-repo.pg.test.ts` re-runs the legacy
repo's contract against the new engine.

## Recall

Memory reaches a turn through two tiers, because one does not fit both jobs. The always-on
`<memory>` block must be small and stable enough to prompt-cache; everything older or more
situational is reached by relevance instead.

| Tier | What | Where |
| --- | --- | --- |
| Core | Every entry, rendered in full | `<memory>` — unchanged |
| Retrieved | Top-5 by relevance to the newest user message | `<recalled-memory>` |
| On demand | Whatever the agent asks for | `recall_memory` tool |

`PgMemoryRecallIndex` supplies candidates from three arms — lexical (a generated `tsvector`, so it
cannot drift from the statement), entity overlap, and pgvector cosine distance — fused by
Reciprocal Rank Fusion and then reweighted by recency and importance in `@tulipfarm/memory`'s
`rank.ts`. Ranking is deliberately pure and knows nothing about authorization: `recallMemory`
widens the candidate set, authorizes **every** candidate, and only then truncates to the caller's
limit, so a withheld assertion can never consume a slot or leak through ordering.

Migration v34 adds the index columns. `embedder.ts` declares the single `MemoryEmbedder` interface
used for both indexing and querying — one interface, because vectors from two different models are
not comparable. `EmbeddingService` satisfies it structurally, so no adapter exists.

Embedding happens on write, after the row is committed, and is best-effort: a provider that is
absent, slow, or failing degrades ranking but never blocks a user from recording a memory. Inactive
assertions are skipped, so superseding does not re-embed unchanged text.

The retrieved tier is likewise best-effort — `ChatTurnContextResolver` swallows a recall failure
rather than failing the turn, and recalls nothing for a Run acting as an Integration or an Agent,
since durable memory belongs to a person.

## Episodes

Episodes remember what happened, not what is true. A Conversation Episode is derived from the
existing compaction summary in `chat/compaction.ts`; recording it never asks the LLM to summarize a
second time. A Run Episode is recorded from the completed turn the Worker reports through the
internal host, using the already-durable reply as the summary and the completion status as the
outcome.

Migration v35 adds `memory_episodes` plus `memory_chunks`. The episode row carries summary,
decisions, outcome, source, and the same scope-owner columns as Assertions. Each episode also has
an episodic Assertion projection; chunk hits return that projection's assertion id, so
`recallMemory` still authorizes every candidate through `authorizeMemoryScope` before ranking or
rendering it. This is why a decision from Chat A can appear in Chat B for the same
`user_private`, `user_agent`, or `business` scope, while another user or Agent sees nothing.

Chunk indexing is best-effort like Assertion embedding. Lexical chunks keep Episodes recallable
when embeddings are absent, and an embedding failure never fails compaction or turn completion.

## Extraction and the confirmation gate

Explicit writes (`update_memory`, `remember_correction`, the `/api/v1/memory` routes) commit
immediately — the user asked. Everything the assistant merely *notices* goes through a gate instead.

`InternalTurnHost.completeTurn` hands each finished turn to `MemoryExtractionService`, detached and
never awaited: extraction costs an LLM call, so blocking on it would put that latency in front of
the user, and letting it reject would fail a turn that already succeeded. Two conditions narrow what
is mined at all — only `succeeded` turns (a half-failed turn is an unreliable record of what anyone
meant) and only Runs whose subject is a user (there is no owner to attribute otherwise).

`LlmMemoryExtractor` proposes candidates on the quick tier. What comes back is untrusted, so
`candidatesFromResponse` clamps every number and coerces every enum rather than believing the model
— a returned `confidence: 5` would otherwise sail straight past the confidence floor.

Candidates are then screened by `screenMemoryCandidate` in `@tulipfarm/memory`, deliberately *not*
here, so the rules cannot be bypassed by swapping the extraction model. It refuses:

| Reason | Why |
|---|---|
| `imperative` | Memory records what is true, never what to do. This is the poisoning defence. |
| `procedural_not_inferable` | Behaviour-changing memory only ever comes from an explicit human correction. |
| `low_confidence` | A review queue people stop reading is worse than no queue. |
| `prompt_injection` | Screened by the turn's own `GuardrailsService`, not a second detector that would drift. |
| `oversize_statement` / `oversize_subject` / `empty` | Malformed. |

Survivors land in `memory_pending` and **never** in `memory_assertions`. The only path from one to
the other is a person answering `POST /api/v1/memory/pending/:pendingId`. The engine reauthorizes
the deciding principal against the target scope, so a stranger's confirm confirms nothing and leaves
the record for its owner — and the route answers it identically to an unknown id, because
distinguishing the two would confirm that a guessed `pendingId` exists.

Denial deletes the record and stores nothing. Unanswered candidates expire, and `purgeExpired`
removes them.

## Procedural corrections, Forget, and Erase

Procedural Memory is deliberately narrow. The only write path is an explicit human correction:
`POST /api/v1/memory/corrections` records a `procedural` Assertion with `origin = explicit` and
`trustTier = user_stated`. Background Memory Extraction still refuses `procedural` candidates before
they can become Pending Memory, so an assistant cannot infer a standing behavior change.

Forget and Erase are different operations:

| Operation | Guarantee |
|---|---|
| Forget | Sets `status = 'forgotten'`, clears statement text/entities, and leaves the tombstone row for lineage. Recall excludes it even for `validAt` queries. |
| Erase | Hard-deletes the Assertion and cascades through `memory_evidence`, Pending Memory references, in-place recall material, `memory_episodes`, and `memory_chunks`. |

The Erase cascade is content-aware as well as key-aware: if an Episode summary, decision, outcome,
or chunk copied the erased statement, the Episode projection and chunks are removed too. The audit
event records only scope, version, and abstract counts — never the erased statement, evidence refs,
or Assertion id. HTTP routes collapse unauthorized and missing Assertions into the same 404 body so
an Erase attempt cannot become an existence oracle.

## Contradictions and time

Contradiction handling overwrites nothing and deletes nothing. When a newly confirmed statement
makes a stored one untrue, the old row's *valid interval* is closed rather than removed: "Works at
Acme" becomes true-until-March instead of becoming false. `recallMemory({ validAt })` can then
answer what was true at a past moment, which is the only reason preserving the row is worth
anything.

`validTo` is set to the instant the **new** fact began, not to the moment we noticed — so a query
between the two answers with the old fact rather than with neither. The interval is half-open, so
the handover instant belongs to the new fact alone.

A historical query deliberately bypasses the recall index (it holds only active rows, so ranking
through it would drop exactly the assertions being asked about) and is not narrowed by expiry, which
governs how long a belief is kept rather than when it was true.

Judging *whether* two statements contradict needs a model, so it is a port —
`LlmContradictionJudge` here, `MemoryContradictionPort` in the engine. Its output is untrusted and
holds the weakest authority the design allows: it returns ids, and everything that makes the
operation safe lives in `@tulipfarm/memory` where no change of model can reach it.

| Rule | Why |
|---|---|
| Never crosses a scope | The query is scoped at the source, so another user's memory is unreachable, not merely rejected. |
| Only ids that were offered | A judge naming anything else is answering a question nobody asked. |
| Only equal-or-lower trust | Otherwise one inferred sentence could quietly retire something the user stated outright. |
| Explicit edits skip it | The caller already named exactly what it replaces. |
| A failing judge invalidates nothing | A stale fact beside a current one is visible and recoverable; a wrongly closed interval is not. |

## Observability and privacy

Memory emits provider-neutral telemetry through `@tulipfarm/observability` and the API's
`createObservabilityTelemetryPort`, which writes safe metric/span rows to the existing observability
event spine. Telemetry is best-effort: exporter or DB failures never change Memory behavior.

Metric names:

| Area | Metrics |
|---|---|
| Recall | `tulipfarm.memory.recall.requests`, `tulipfarm.memory.recall.latency_ms`, `tulipfarm.memory.recall.results`, `tulipfarm.memory.recall.exclusions` |
| Extraction | `tulipfarm.memory.extraction.candidates`, `tulipfarm.memory.extraction.screening_refusals` |
| Confirmation queue | `tulipfarm.memory.confirmation.decisions`, `tulipfarm.memory.pending.depth`, `tulipfarm.memory.pending.oldest_age_ms` |
| Episodes | `tulipfarm.memory.episodes.writes`, `tulipfarm.memory.episodes.access`, `tulipfarm.memory.episodes.chunks`, `tulipfarm.memory.episodes.recall_candidates` |
| Contradictions | `tulipfarm.memory.contradictions.detected`, `tulipfarm.memory.contradictions.invalidated`, `tulipfarm.memory.contradictions.judge_failures` |
| Lifecycle | `tulipfarm.memory.assertions.writes`, `tulipfarm.memory.forget.operations`, `tulipfarm.memory.erase.operations`, `tulipfarm.memory.erase.cascade_counts`, `tulipfarm.memory.erase.cascade_failures` |

Span names are `tulipfarm.memory.recall`, `tulipfarm.memory.extraction`,
`tulipfarm.memory.confirmation`, `tulipfarm.memory.contradiction`,
`tulipfarm.memory.forget`, `tulipfarm.memory.erase`, `tulipfarm.memory.episode.write`, and
`tulipfarm.memory.episode.recall`.

Labels and span attributes are bounded enums and counts only: outcome, reason, scope,
memory type, Trust Tier, queue, source type (`conversation` or `run`), chunk type (`summary`,
`decision`, or `outcome`), ranked/Point-in-time flags, and counts. They never include statements,
subjects, Episode summaries, chunk text, entity names, query text, Pending Memory ids, Assertion
ids, Episode ids, Conversation ids, Run ids, business ids, or principal ids.
`packages/memory/src/telemetry.test.ts` structurally captures emitted telemetry across save,
recall, extraction, episode authorization denial, confirmation, contradiction, and Erase and
asserts known content strings appear nowhere in metric labels or span attributes.
`episode-store.pg.test.ts` does the same for the Postgres Episode write + chunk recall path.

## Caps (`limits.ts`)

`MAX_ENTRIES=100`, `MAX_VALUE_CHARS=256` (a larger single value is long-form → rejected
toward `create_knowledge_page`), `MAX_TOTAL_CHARS = MAX_ENTRIES × MAX_VALUE_CHARS` (derived
aggregate ceiling), `MAX_TOOL_STEPS=25`. Count and per-value are the binding caps.

## Wiring

`index.ts` builds `EngineMemoryRepo` + `MemoryService` and passes them into `buildApp`,
which threads the service into `registerChatRoutes`. The chat turn (`chat/turn.ts`) binds
`buildMemoryToolSet(ctx)` as `streamText` `tools` and persists tool-call/tool-result steps via
`onStepFinish`. Tools are scoped to the authenticated user (`user._id`). `index.ts` wires the same
observability telemetry port into the KV engine repo, recall service, Episode store, extraction
service, and lifecycle service.

The greenfield baseline in `pg-migrations/index.ts` creates the unique `{userId,key}` index plus
`{userId,lastWrittenAt}` for per-user LRU listing.

## Out of scope (here)

`<memory>` block injection into the system prompt (CONTEXT-ENGINE), the knowledge tools, and the
broader tool-runtime execution dynamics (parallel-read/sequential-write, result truncation) live
elsewhere. This module is the store + the two write tools.
