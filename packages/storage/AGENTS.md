# Storage (`@tulipfarm/storage`)

Repository and port owner for PostgreSQL-backed state: transactions, auth, Runs, Artifacts, Soul
publication, approvals, integrations, events, and blob/vector/cache/queue ports.

## Read on / Skip
- **Read on if** you change repository contracts, table access, transactions, or storage ports.
- **Skip if** you change business rules; read that domain package's `AGENTS.md` first.

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Public exports; do not mirror the list here. |
| `src/ports/` | Transaction/query (incl. `withTransaction`), blob, vector, cache, queue ports. |
| `src/soul/` | Soul publication records, projection, outbox, activation history. |
| `src/artifacts/` | Append-only Artifacts, State Output Bindings, lineage. |
| `src/runs/` | Runs, States, Attempts, waits/signals, budgets, concurrency, children, events. |
| `src/auth/` | Principals, roles, sessions, guests, JIT users, recertification, identities. |
| `src/integrations/` | Integration install/state and channel inbound/delivery stores. |
| `src/approvals/`, `src/events/` | Approval persistence and generic event store. |
| `src/kill-switches/` | Durable mutation kill switches backing the effect-plane emergency stop. |
| `src/curator/` | Curator jobs, pinned input manifests and context pins, effect ledger, per-user work queue, daily spend admission, the claim-and-reserve mint transaction, stale-job reconciliation, and the read-only shadow review queries (`review.ts`, which writes nothing by design). |
| `src/system/` | Deployment-local public origin settings that must not travel with Soul. |
| `src/pagination.ts`, `src/vector-search.ts` | Cursor paging and pgvector index/distance SQL shared by every repository. |

## Rules

- May import only allowed dependencies, currently `@tulipfarm/schema` and
  `@tulipfarm/observability`; see [dependency rules](../../docs/architecture/dependency-rules.md).
- No `pg` or provider SDK types may leak through `src/ports/` contracts.
- Domain packages use repository/transaction ports; they never read another owner's tables directly.
- If a storage rule repeats schema/Soul contracts, derive or reference the owner instead of copying.
- `actor_principal_id` is required for every Soul publication; no anonymous publish paths except
  migrations that carry old local rows forward.
- Dead-lettering is evidence (`dead_lettered_at` + reason), not a terminal publication stage.
- Soul activation is monotonic by `publication_sequence`; preserve stale-activation refusal and
  `soul_bundle_activations` history.
- Bundle retention must be negative-list safe: delete only when no active alias, activation record,
  Run, Audit event, or non-dead-lettered publication references the digest.
- Run `source` selects the Worker executor independently from the canonical Routine in `bundle`.
- Run budgets are write-once; concurrency and wait resolution are lock-guarded.
- Child links are authority-immutable and detach-final; Run events are append-only,
  audience-scoped, and gapless per Run.
- Kill switch rows are never deleted or re-enabled: standing one down stamps `disabled_at`, because
  whether a stop was live at a given instant is incident evidence.
- A Curator effect carries an immutable execution mode, and a `shadow` effect may never rest in
  `pending` (DB CHECK `curator_effect_shadow_is_terminal`). Enabling the Curator must not be able to
  apply output that was only ever reasoned about in shadow.
