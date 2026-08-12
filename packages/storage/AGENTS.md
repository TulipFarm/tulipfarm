# Storage — Agent Conventions

`@tulipfarm/storage` — PostgreSQL repositories, transaction helpers, outbox/inbox, and
blob/vector/cache provider ports. **Today:** `src/ports/` defines the provider-neutral
`TransactionPort`/`Queryable`, `BlobPort`, `VectorPort`, `CachePort`, and `QueueAcceleratorPort`
contracts (no `pg`/SDK types leak across the boundary), and `src/soul/` defines the Soul
publication record/projection/outbox/activation-history port (`SoulPublicationStore`, plus an
in-memory implementation with real rollback) that `@tulipfarm/soul` drives. `src/artifacts/` owns
the append-only `artifacts`, `state_output_bindings`, and `artifact_lineage` tables
(`ArtifactStore`, plus `MemoryArtifactStore`) that `@tulipfarm/run-kernel` drives. `src/runs/`
owns the `runs`, `run_states`, `run_attempts`, `run_lineage`, `run_waits`, and
`run_wait_signals` tables
(`RunStore`, `WaitStore`, plus `MemoryWaitStore`), including resume-token digests and
lock-guarded wait resolution. A Run's `source` selects its Worker executor independently from the
canonical Routine identity pinned in `bundle`. The write-once `run_budgets` ledger
(`BudgetStore`), lock-guarded `run_concurrency_keys`/`run_concurrency_slots` tables
(`ConcurrencyStore`), authority-immutable, detach-final `run_child_links` table
(`ChildLinkStore`), plus the append-only, audience-scoped `run_events` stream with a gapless
per-Run sequence (`RunEventStore`). tsconfig extends `@tulipfarm/tsconfig/base.json`. See root
`AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). Domain
packages read/write through this package's repository and transaction ports; they never read
another owner's tables directly.

## Soul publication storage

- `actor_principal_id` is required for every publication. Do not add anonymous publish paths or
  migration defaults except to carry old local rows forward.
- Dead-lettering is evidence (`dead_lettered_at` + reason) on a publication, not a new terminal
  stage. Keep the last successful stage intact so drain can diagnose where it stopped.
- Activation is monotonic by `publication_sequence`; never update `soul_active_bundles` without
  preserving stale-activation refusal and `soul_bundle_activations` history.
- Bundle retention must stay negative-list safe: delete only when no active alias, activation
  record, Run, Audit event, or non-dead-lettered publication references the digest.
- If a storage rule repeats a contract from schema/Soul, derive or reference the owner. This
  codebase's recurring defect is one contract described in two places, drifting.
