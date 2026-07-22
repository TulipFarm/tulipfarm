# Memory — Agent Conventions

`@tulipfarm/memory` — scoped, versioned memory assertions, confirmations, provenance,
supersession, and expiry. **Scaffold today:** `src/index.ts` is `export {}`. tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`, `@tulipfarm/storage`,
`@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). Durable
writes require explicit confirmation; nothing in this package infers or persists unscoped memory.
