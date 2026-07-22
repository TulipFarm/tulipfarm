# Storage — Agent Conventions

`@tulipfarm/storage` — PostgreSQL repositories, transaction helpers, outbox/inbox, and
blob/vector/cache provider ports. **Scaffold today:** `src/index.ts` is `export {}`. tsconfig
extends `@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). Domain
packages read/write through this package's repository and transaction ports; they never read
another owner's tables directly.
