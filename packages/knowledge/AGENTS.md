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
| `src/source.ts`, `src/acl.ts` | Source records/store and `decideSourceAccess`. |
| `src/indexing.ts`, `src/retrieve.ts` | Authorized indexing and authorize -> rank -> re-check. |
| `src/{invalidate,delete,staleness}.ts` | Invalidation, deletion, stale-ACL sweeps. |
| `src/provenance.ts` | `authorizeSynthesis` citation reauthorization. |
| `src/types.ts`, `src/chunk.ts` | Shared page/chunk/space/search shapes and text chunking. |
| `src/*-repo.ts`, `src/repo.ts` | PostgreSQL repositories for pages, revisions, chunks, links, spaces. |
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
- Retrieval cache keys bind principal plus Guardrail/Context epochs; reauthorize cache hits.
- Reauthorize every citation at its cited revision; one failed citation denies the conclusion.
- Nothing about a withheld source may reach candidates, citations, or audit payloads.
- Confluence uses the same `knowledge_source_*` ports as Slack. Missing or stale captured ACL
  snapshots deny; re-sync/deletion removes indexed chunks before content can reappear.
- Notion, Google Docs, and Google Drive use the same ACL path. Link-shared Google content is not a
  wildcard grant; domain shares need explicit mappings; unverifiable Notion readers deny.
