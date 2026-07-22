# Tool Broker — Agent Conventions

`@tulipfarm/tool-broker` — Tool catalog, typed intent, authorization/risk/approval pipeline,
effect ledger, dry run, and reconciliation. **Scaffold today:** `src/index.ts` is `export {}`.
tsconfig extends `@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`, `@tulipfarm/secrets`,
`@tulipfarm/sandbox`, `@tulipfarm/storage`, `@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This
package consumes policy/DLP decisions and credential leases; it never reimplements or broadens
them. It exposes the Tool adapter interface that `@tulipfarm/integrations` implements — this
package never imports Integration implementations.
