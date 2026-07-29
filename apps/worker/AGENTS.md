# Worker App — Agent Conventions

`@tulipfarm/worker` — durable Run dispatch, Agent/Tool States, timers, reconciliation, and
projections. Composition-only: this app wires published packages together and must not
reimplement package-owned logic. tsconfig extends `@tulipfarm/tsconfig/node.json`. See root
`AGENTS.md` for commands/lint.

## Running it

`pnpm dev:worker` (tsx watch) or `node dist/worker.cjs` (the bundle the Dockerfile emits, run by
the `worker` compose service). Requires `DATABASE_URL`; every `WORKER_*` variable has a default —
see `.env.local.example`.

## Composition root (`src/main.ts`)

Three independent loops share one `pg.Pool`. A failing loop backs off on its own without stopping
the others: a stuck delivery target must never stop Runs from progressing.

| Loop | Drives | Interval |
| --- | --- | --- |
| `run-dispatch` | `RunDispatcher` — reclaim expired leases, claim queued Runs, drive each to terminal | `WORKER_RUN_POLL_MS` |
| `wait-sweep` | `WaitTimerSweeper` — resolve waits whose deadline passed and requeue their Runs | `WORKER_WAIT_SWEEP_MS` |
| `outbox-delivery` | `EventOutboxDispatcher` — drain accepted events to their delivery targets | `WORKER_OUTBOX_POLL_MS` |

Supporting modules: `config.ts` (validate before any connection opens), `db.ts` (`pg` wiring —
a deliberate local copy, since an app may not import another app), `preflight.ts` (schema floor),
`loop.ts` (abortable, backing-off loop), `executors.ts` / `delivery.ts` (registries),
`probe-server.ts` (`/livez`, `/readyz`), `shutdown.ts` (drain).

## Invariants

- **Never migrate.** `apps/api` owns `schema_version`; the worker refuses to start below
  `REQUIRED_SCHEMA_VERSION` (`src/config.ts`). Raise that constant whenever a migration lands that
  the worker's queries depend on.
- **Fail closed, loudly.** Boot failures `process.exit(1)`. An unregistered Run source releases to
  `needs_reconciliation` naming the missing executor — never a silent success, never an
  unexplained failure.
- **Exit non-zero on an unsafe drain.** `SIGTERM` aborts the loops and awaits in-flight batches
  within `WORKER_DRAIN_TIMEOUT_MS`; a timed-out drain exits 1 so the orchestrator sees it.
- **Leases are the only claim.** Every transition is CAS-guarded on `(expectedVersion,
  expectedStatus)`; a worker that dies without releasing is recovered by `reclaimExpired`, not by
  anyone forcing a status.
- Registries (`RunExecutorRegistry`, `DeliveryTargetRegistry`) are empty today. Executors land in
  PR 3, delivery targets in PR 6.

`src/agent-state.ts` (Agent State execution around the bounded Agent loop), `src/conversation-turn.ts`
(durable Turn completion), and `src/recovery/` stay unwired: `buildInput` has no implementation and
`TurnCompletionStore` has neither an implementation nor a table. They belong to PR 3.

## Tests

`src/*.test.ts` are unit suites. `test/process/` boots the **bundled** worker as a real child
process against a scratch PGlite served over the wire protocol (`@electric-sql/pglite-socket`) on
an ephemeral port — probes, schema-floor refusal, claim/release, `SIGTERM` drain, and recovery of
a Run a killed worker abandoned. Run with `--maxWorkers=1`.

## Imports

May import: `schema`, `authz`, `audit`, `secrets`, `run-kernel`, `tool-broker`, `agent-runtime`,
`knowledge`, `memory`, `surface`, `integrations`, `sandbox`, `storage`, `observability`,
`constants` (all under `@tulipfarm/*`). See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This app
never imports another application (`apps/api`, `apps/integration-worker`, `apps/web`).
