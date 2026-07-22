# Knowledge — Agent Conventions

`@tulipfarm/knowledge` — ACL-preserving source ingestion, indexing, retrieval, provenance,
invalidation, and deletion propagation. **Scaffold today:** `src/index.ts` is `export {}`.
tsconfig extends `@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`, `@tulipfarm/storage`,
`@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This is
the sole accountable owner for source ACL enforcement: authorization must run before ranking or
candidate exposure, never after.
