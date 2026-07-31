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

## Executing a turn (`src/turn/`)

`TurnDriver` (`turn/driver.ts`) runs one turn end to end and owns nothing else: it announces the
turn, resolves the Context **once**, hands the built `AgentLoopInput` to `AgentStateRunner`,
persists the result through `ConversationTurnCompleter`, and closes the stream. Because it holds no
policy, the same path serves web, Slack, Telegram, and any channel added later.

Two orderings are load-bearing. `turn.finished` is emitted **after** completion is durable, so a
reader that sees it can fetch the Message it names. And Context is resolved before the loop starts,
so `context.assembled` is evidence of what the model was actually given — never a second resolution
that might differ.

`TurnEventWriter` (`turn/run-events.ts`) is the only way a turn reaches a reader. The event type
fixes the audience and the payload is validated against `@tulipfarm/schema`'s published schema, so
a writer cannot widen who sees what. Its projection of `AgentLoopEvent` is deliberately narrow:
the loop contributes only model text and calls it refused before dispatch, because the driver holds
the wait id and `messageId`, and the `ToolDispatchPort` holds the Tool arguments and output a
`tool.call`/`tool.result` pair needs. **That is why a secret passed as a Tool argument cannot reach
a participant's stream — keep the projection narrow.**

`RunOutcome` (`run-dispatcher.ts`) says how the executor left the Run. `waiting` parks it for the
wait sweep; `cancelled` means `RunCancellationManager` is already driving the transition and the
dispatcher must **not** write a status of its own.

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
- Registries (`RunExecutorRegistry`, `DeliveryTargetRegistry`) are empty today. Executors are
  registered as PR 3 lands them; delivery targets in PR 6.

`TurnContextPort` and `TurnCompletionStore` have no implementation yet — the API's internal turn
host backs both, and registering the `chat` executor is what connects them.

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
