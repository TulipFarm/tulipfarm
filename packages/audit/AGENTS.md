# Audit — Agent Conventions

`@tulipfarm/audit` — canonical audit events, hash chaining, sealing/export/retention interfaces,
and lineage queries. **Scaffold today:** `src/index.ts` is `export {}`. tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/storage`, `@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This
package is the sole accountable owner for append-only, hash-linked evidence; no other package
writes audit records directly.
