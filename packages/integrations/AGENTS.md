# Integrations — Agent Conventions

`@tulipfarm/integrations` — internal integration adapter contracts, event normalization,
delivery, source ACL adapters, sync checkpoints, and identity mapping. **Scaffold today:**
`src/index.ts` is `export {}`. tsconfig extends `@tulipfarm/tsconfig/base.json`. See root
`AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`,
`@tulipfarm/tool-broker`, `@tulipfarm/storage`, `@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This
package implements the Tool adapter interface owned by `@tulipfarm/tool-broker`; the broker never
imports Integration implementations. Integration events must resolve the external principal —
never borrow a Conversation owner's identity.
