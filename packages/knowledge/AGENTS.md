# Knowledge (`@tulipfarm/knowledge`)
ACL-preserving source ingestion, indexing, retrieval, provenance, invalidation, and deletion
propagation. This is the sole accountable owner for source ACL enforcement.

## Read on / Skip
- **Read on if** you touch source records, source ACLs, indexing, retrieval caches, citation auth,
  revocation/deletion propagation, or stale-ACL sweeps.
- **Skip if** you touch memory assertions (`../memory/AGENTS.md`), integration ingress
  (`../integrations/AGENTS.md`), storage ports (`../storage/AGENTS.md`), or authz primitives.

## Map
| Path | Owns |
| --- | --- |
| `src/source.ts`, `src/acl.ts`, `src/subject.ts` | Source records/store, the `decideKnowledgeAccess` gate, and the Page/Source subject projections. |
| `src/indexing.ts`, `src/retrieve.ts` | Authorized indexing and authorize -> rank -> re-check. |
| `src/graph-expand.ts` | Bounded hop walk over `knowledge_links` and the banded hop-decay score. |
| `src/graphrag/` | GraphRAG: LLM extraction, deterministic clustering, community summaries, local/global search, graph repo and invalidation. |
| `src/{invalidate,delete,staleness}.ts` | Invalidation, deletion, stale-ACL sweeps. |
| `src/provenance.ts` | `authorizeSynthesis` citation reauthorization. |
| `src/types.ts`, `src/chunk.ts` | Shared page/chunk/space/search shapes and text chunking. |
| `src/*-repo.ts`, `src/repo.ts` | PostgreSQL repositories for pages, revisions, chunks, links, spaces, ACL entries. |
| `src/okf/` | OKF page parse, cross-page link extraction, index synthesis. |
| `src/connectors/` | Connector seam, registry, sample/stub connectors, sync state. |
| `src/{index-service,page-search-adapter,rerank,retrieval-config,embedding-backfill}.ts` | Indexing, page search, ranking config, embedding backfill. |
| `test/security/` | Source/role/revoke/delete/cache/provider and side-channel matrices. |

## Rules
- May import only `@tulipfarm/schema`, `authz`, `audit`, `storage`, and `observability`; see
  [dependency rules](../../docs/architecture/dependency-rules.md).
- Repositories take a `Queryable` from `@tulipfarm/storage`; they never open their own pool. The
  PGlite-backed repository tests stay in `apps/api`, which owns the migrations that build the
  tables under test.
- Authorize before ranking or candidate exposure, never after. Default-deny every ACL path; live
  checks never fall back to cached ACLs.
- Authored Pages are Sources whose provider is TulipFarm. `pageSubject()`/`sourceSubject()` project
  both onto one `decideKnowledgeAccess`; a second ACL evaluator is a defect. Authored ACLs are
  read live from our own tables, so they project as a fresh `snapshot` with a finite max age —
  never an infinite one, which would fail open on a malformed timestamp.
- Retrieval cache keys bind principal plus Guardrail/Context epochs; reauthorize cache hits.
- An edge is not a grant. `graph-expand` admits a neighbour only if the authorization pass already
  passed it, walks *out of* readable pages only, and caps **admitted** pages rather than walked
  ones — capping the walk would let a withheld page displace a visible one. Hop decay keeps
  `hopDecay < bandFloor` so the score bands stay disjoint and a deeper hop cannot outrank a
  shallower one whatever a reranker does with the number.
- Reauthorize every citation at its cited revision; one failed citation denies the conclusion.
- A community summary is blended text: no per-principal filter can un-mix it after the model wrote
  it. Build one only over `isBroadlyReadable()` chunks, revalidate every provenance chunk at query
  time, and withhold the whole summary if any one is denied — no redaction, no partial render, no
  hint that something was left out. `src/graphrag/` never re-implements the gate; it takes the
  decision as an injected port.
- GraphRAG provenance is assigned by this code from the chunk it fed the model, never read out of
  model output. Extraction takes one chunk at a time for exactly that reason.
- `@tulipfarm/llm` is not importable here, so both models arrive as ports
  (`GraphExtractionPort`, `GraphSummaryPort`, `GlobalAnswerPort`).- Nothing about a withheld source may reach candidates, citations, or audit payloads.
- Confluence uses the same `knowledge_source_*` ports as Slack. Missing or stale captured ACL
  snapshots deny; re-sync/deletion removes indexed chunks before content can reappear.
- Notion, Google Docs, and Google Drive use the same ACL path. Link-shared Google content is not a
  wildcard grant; domain shares need explicit mappings; unverifiable Notion readers deny.
