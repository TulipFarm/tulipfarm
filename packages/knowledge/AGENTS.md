# Knowledge — Agent Conventions

`@tulipfarm/knowledge` — ACL-preserving source ingestion, indexing, retrieval, provenance,
invalidation, and deletion propagation. tsconfig extends `@tulipfarm/tsconfig/base.json`. See root
`AGENTS.md` for commands/lint.

## Layout

- `src/source.ts` — `KnowledgeSourceRecord` (ACL, provenance, revision, classification, status,
  verification) and the source store; `knowledgeSourceFromDefinition` keeps runtime records in
  lockstep with the authored `KnowledgeSource`.
- `src/acl.ts` — `decideSourceAccess`, the single seam where a source becomes an access decision.
  Default-deny on every path; live checks never fall back to a cached ACL.
- `src/indexing.ts` — index port taking the *authorized* source set; an empty set returns nothing.
- `src/retrieve.ts` — authorize → rank → re-check, with a cache whose key binds principal and
  Guardrail/Context epochs and whose hits are re-authorized before being served.
- `src/invalidate.ts` / `src/delete.ts` / `src/staleness.ts` — durable, resumable invalidation of
  derived artifacts; deletion/revocation/revision propagation; stale-ACL revalidation sweeps.
- `src/provenance.ts` — `authorizeSynthesis`: every citation reauthorized at its cited revision, a
  single failure denies the whole conclusion.
- `test/security/` — source/role/revoke/delete/cache/provider matrices plus side-channel
  assertions (nothing about a withheld source reaches candidates, citations, or audit payloads).

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`, `@tulipfarm/storage`,
`@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This is
the sole accountable owner for source ACL enforcement: authorization must run before ranking or
candidate exposure, never after.
