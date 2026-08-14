# Worker

`@tulipfarm/worker` drives durable Run dispatch, Agent/Tool States, timers,
reconciliation, turn execution, delivery classification, projections, and outbox delivery.

## Read on / Skip

- **Read on if** your task touches Run dispatch, waits, Routine States, turn execution,
  worker probes, reconciliation, integration delivery classification, or worker process tests.
- **Skip if** you are changing HTTP routes/auth/migrations/soul publishing (`../api/AGENTS.md`),
  channel ingress and retries (`../integration-worker/AGENTS.md`), or UI (`../web/AGENTS.md`).

## Map

| Path | Owns |
| --- | --- |
| `src/main.ts` | Composition root: run dispatch, wait sweep, outbox loops, probes, shutdown. |
| `src/config.ts`, `src/data-dir.ts` | Env/defaults, schema floor, worker credentials/secrets. |
| `src/db.ts`, `src/preflight.ts`, `src/loop.ts` | Local `pg`, schema check, backing-off loops. |
| `src/executors.ts`, `src/delivery.ts` | Run source and delivery target registries. |
| `src/turn/` | Chat/integration turn executors, Context, guardrails, events, completion. |
| `src/routine/` | Routine executor plus Tool, Agent, and approval ports. |
| `src/internal/` | HTTP ports back to `/api/v1/internal/*`; Run identity is re-derived by API. |
| `src/hooks/` | Sandbox worker bundle for Integration delivery classification. |
| `src/recovery/` | Reconciliation helpers for abandoned or parked work. |
| `test/process/` | Real bundled-worker process tests over PGlite socket. |
| `test/e2e/` | End-to-end worker flows. |

## Rules

- Composition-only: wire `@tulipfarm/*` packages; do not reimplement package-owned logic.
- Requires `DATABASE_URL`, `INTERNAL_API_URL`, and a real minted `WORKER_API_CREDENTIAL`.
- In containers, `data-dir.ts` may read `worker.env`/`secrets.env`; env wins, nothing is invented.
- The placeholder API credential boots but makes chat silently park at `needs_reconciliation`.
- `needs_reconciliation` with `invoke` still `pending` usually means bad credential or bad reclaim.
- Three loops share one `pg.Pool`; one failing loop must back off without stopping the others.
- Never migrate here; API owns `schema_version`; raise `REQUIRED_SCHEMA_VERSION` when needed.
- Boot fails closed with `process.exit(1)`; unsafe drain timeout exits non-zero.
- Leases/CAS are the only claim; recover expired leases, never force statuses.
- Registered Run sources are `chat`, `integration`, and `routine`; unknown sources reconcile.
- Integration Runs classify delivery, then hand real turns to the same chat executor as web chat.
- Routine execution reads only the Run's exact signed bundle and immutable request Artifact.
- Routine replay safety depends on persisting successors first and durable occurrence keys.
- Wait ids derive from `(runId, occurrence key)`; `event` waits are refused as `unsupported_wait`.
- Routine `tool` States are the only Routine Tool authority: authorize, reserve, then dispatch.
- No `authorityLayers` source and no adapter map both park; do not add provider side routes here.
- Routine `agent` States use the authored Agent version, same AgentLoop, and pinned Context.
- Routine Agent States expose no Tools, use deployment default guardrails, and record null output.
- Agent `instructions.md` is a Soul companion hash, not bundled prompt text; use personality.
- Approval resume tokens never cross to the worker; replay by wait id and State occurrence.
- Approval role authority only knows recorded `admin`/`member`; other roles fail closed.
- Unsupported effect States and live-timer join cancellations park, never pretend success.
- Chat `invoke` may start `pending` or `waiting`; reclaim through ready/claimed before running.
- Emit `turn.finished` only after durable completion; resolve Context exactly once before loop.
- `TurnEventWriter` is the only participant event path; keep Tool args/results out of it.
- Guardrails arrive with Context; digest mismatch throws before the first event.
- Blocked input/output settles with a guard reply; blocked Tool calls return denied to the model.
- Delivery classification emits exactly one `delivery.classified` event per Run.
- Delivery classifier isolate gets no grants; keep API and worker hook bundle basenames distinct.
- Bind links and reply text never cross from API to worker; replies are at-least-once.
- Effort inference happens once per Run for `auto`; classifier tokens are unmetered.
- `test/process/` boots the bundled worker; run these tests with `--maxWorkers=1`.
- Worker process tests can leak dev env through `apps/worker/.env.local`; check before blaming code.
- May import listed `@tulipfarm/*` packages, never another app; see dependency rules below.
- Soul access is only signed-bundle reads; never load live Soul, alias, publish, or git sync.

See [`../../docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md).
