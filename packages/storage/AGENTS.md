# Storage — Agent Conventions

`@tulipfarm/storage` — PostgreSQL repositories, transaction helpers, outbox/inbox, and
blob/vector/cache provider ports. **Today:** `src/ports/` defines the provider-neutral
`TransactionPort`/`Queryable`, `BlobPort`, `VectorPort`, `CachePort`, and `QueueAcceleratorPort`
contracts (no `pg`/SDK types leak across the boundary), and `src/soul/` defines the Soul
publication record/projection/outbox port (`SoulPublicationStore`, plus an in-memory
implementation with real rollback) that `@tulipfarm/soul` drives. tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). Domain
packages read/write through this package's repository and transaction ports; they never read
another owner's tables directly.
