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
| `src/turn/` | Integration turn executor. Chat Turn execution moved to [`packages/turn-executor`](../../packages/turn-executor/AGENTS.md). |
| `src/routine/` | Routine executor plus Tool, Agent, and approval ports. |
| `src/curator/` | Curator Run executor (resolve pinned context, reason once, submit raw output) and the `curator-sweep` fan-out. |
| `src/internal/` | HTTP ports back to `/api/v1/internal/*`; Run identity is re-derived by API. |
| `src/tools/` | In-process Tool host for co-locatable families, and the routing dispatcher. |
| `src/files/`, `src/knowledge/` | The worker's own `FileService` and `KnowledgeService`, and the `file-index` job that extracts a File's text into Knowledge. |
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
- Registered Run sources are `chat`, `integration`, `routine`, and `curator`; unknown sources
  reconcile.
- The Curator executor holds no judgement: it never chooses inputs, validates output, or applies
  effects. The API re-derives all of that from the job's own manifest.
- `curator-sweep` (*/5, bare pg-boss, scheduled by the API) is deterministic maintenance only: it
  reconciles Tasks, then asks the API to mint one Run per user with a backlog. Its queue name is a
  plain string shared with `apps/api/src/curator/sweep-schedule.ts` — rename both or neither.
- `file-index` runs here rather than in the API because indexing a File means running a PDF parser
  over a stranger's bytes, which does not belong in the process terminating HTTP requests. Its
  queue name is a plain string shared with `apps/api/src/files/knowledge-bridge.ts` — rename both
  or neither. Every refusal is an outcome, never a throw: a File deleted while its job queued must
  not retry forever. It reconciles after writing as well as before: until the Page exists, a
  delete, a withdrawal or a revoke has nothing to act on, so all three are re-asked once it does.
- Integration Runs classify delivery, then hand real turns to the same chat executor as web chat.
- Routine execution reads only the Run's exact signed bundle and immutable request Artifact.
- Routine replay safety depends on persisting successors first and durable occurrence keys.
- Wait ids derive from `(runId, occurrence key)`; `event` waits are refused as `unsupported_wait`.
- Routine `tool` States are the only Routine Tool authority: authorize, reserve, then dispatch.
- A Routine Tool intent carries the objects the pinned ToolContract's `spec.targets` declares, so a
  grant can name one Record; a declared target the arguments cannot answer refuses the State.
- No `authorityLayers` source and no adapter map both park; do not add provider side routes here.
- Routine `agent` States use the authored Agent version, same AgentLoop, and pinned Context.
- Routine Agent States expose no Tools, use deployment default guardrails, and record null output.
- Agent `instructions.md` is a Soul companion hash, not bundled prompt text; use personality.
- Approval resume tokens never cross to the worker; replay by wait id and State occurrence.
- Tools hosted in `src/tools/` must clear `localDispatchRefusal`; boot fails rather than weaken it.
- The File family is hosted here so `file_create` renders model-authored content outside the
  process serving people's requests. Omitting `imagePolicy` is unreachable, not degraded: the
  context `Pick` cannot reach `upload`, its only reader.
- Authority for a co-located Tool is still read from the API per Run, never derived here, and is
  cached for one dispatch attempt only; `main.ts` evicts it when the attempt settles.
- A State's `concurrencyKey` is held by a durable expiry-bounded lease; a contender queues on a
  durable backoff timer in `routine/concurrency-guard.ts` and parks only at the bounded ceiling.
- A fired concurrency backoff resumes *into* the State body; only `wait`/`approval` States resume
  past themselves, so never route a `waiting` row through `resumeWait` without checking.
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
- Gate rejections throw `ProviderUnavailableError` from `@tulipfarm/llm`; a worker-local error
  class classifies as a generic `model_error` and the participant is told nothing useful.
- `test/process/` boots the bundled worker; run these tests with `--maxWorkers=1`.
- Worker process tests can leak dev env through `apps/worker/.env.local`; check before blaming code.
- May import listed `@tulipfarm/*` packages, never another app; see dependency rules below.
- Soul access is only signed-bundle reads; never load live Soul, alias, publish, or git sync.
- `BrokerRoutineToolPort` gets a `MutationKillSwitchGuard` reading the same table as the API, so an
  operator's stop covers Worker-dispatched effects too. Its audit port only logs: the API owns the
  audit ledger, and the denial's durable evidence is the Run's own event ledger.

See [`../../docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md).