# Storage — Agent Conventions

`@tulipfarm/storage` — PostgreSQL repositories, transaction helpers, outbox/inbox, and
blob/vector/cache provider ports. **Today:** `src/ports/` defines the provider-neutral
`TransactionPort`/`Queryable`, `BlobPort`, `VectorPort`, `CachePort`, and `QueueAcceleratorPort`
contracts (no `pg`/SDK types leak across the boundary), and `src/soul/` defines the Soul
publication record/projection/outbox port (`SoulPublicationStore`, plus an in-memory
implementation with real rollback) that `@tulipfarm/soul` drives. `src/artifacts/` owns the
append-only `artifacts`, `state_output_bindings`, and `artifact_lineage` tables (`ArtifactStore`,
plus `MemoryArtifactStore`) that `@tulipfarm/run-kernel` drives. `src/runs/` owns the `runs`,
`run_states`, `run_attempts`, `run_lineage`, `run_waits`, and `run_wait_signals` tables
(`RunStore`, `WaitStore`, plus `MemoryWaitStore`), including resume-token digests and
lock-guarded wait resolution. A Run's `source` selects its Worker executor independently from the
canonical Routine identity pinned in `bundle`. The write-once `run_budgets` ledger (`BudgetStore`)
and lock-guarded `run_concurrency_keys`/`run_concurrency_slots` tables (`ConcurrencyStore`), plus the
authority-immutable, detach-final `run_child_links` table (`ChildLinkStore`), plus the append-only,
audience-scoped `run_events` stream with a gapless per-Run sequence (`RunEventStore`). tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). Domain
packages read/write through this package's repository and transaction ports; they never read
another owner's tables directly.
