# Worker App — Agent Conventions

`@tulipfarm/worker` — durable Run dispatch, Agent/Tool States, timers, reconciliation, and
projections. Composition-only: this app wires published packages together and must not
reimplement package-owned logic. tsconfig extends `@tulipfarm/tsconfig/node.json`. See root
`AGENTS.md` for commands/lint.

## Running it

`pnpm dev:worker` (tsx watch) or `node dist/worker.cjs` (the bundle the Dockerfile emits, run by
the `worker` compose service). Requires `DATABASE_URL`, `INTERNAL_API_URL` and
`WORKER_API_CREDENTIAL`; every `WORKER_*` variable has a default — see `.env.local.example`.

In a container the last one and `ENCRYPTION_KEY` need not be set at all: `data-dir.ts` reads them
back from the data volume the API wrote them to (`worker.env` and `secrets.env`, one owner each),
which is what lets a compose file with no `.env` execute a turn. The environment always wins, and
nothing is invented here — a value on neither the environment nor the volume stays missing, and
`loadConfig` names it.

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

Three Run sources are registered, keyed by the Run's dedicated `source` column through
`RunExecutorRegistry.sourceOf`: `chat` (`turn/chat-executor.ts`) and `integration`
(`turn/integration-executor.ts`), plus `routine` (`routine/executor.ts`). Source is independent of
the Routine id in the pinned bundle, so a published Routine can carry its canonical identity
without changing which executor owns it. The Integration executor classifies its delivery and then
hands the Run to **the same** chat executor instance, so a Slack turn and a web turn are answered by
one code path.

The Routine executor opens only the Run's exact signed bundle and reconstructs manual input from
its immutable request Artifact. It owns the deterministic capabilities: `branch` graphs, durable
`wait` timers, and the bounded fan-out and loop constructs (`parallel`, `foreach`, `repeat_until`).
Two rules make it replay-safe. Each successor is persisted before its predecessor succeeds, so a
crash between the two writes replays through `ensureState` without duplicate work. And a fan-out
unit is addressed by a durable occurrence key (`routineOccurrenceKey` — `${parent}#${unit}/${state}`)
derived from the pinned collection, never from a counter this process holds, so progress is
*replayed* off the durable State rows rather than tracked in memory: there is no second progress
ledger to fall out of step with them.

A `wait` opens its timer through `DurableWaitManager` in this process — the wait id is derived from
`(runId, occurrence key)`, so a worker that died between creating the wait and parking the State
finds its own wait instead of opening a second one — and returns `waiting`, which parks the Run
holding no lease. The `wait-sweep` loop above resolves the deadline and requeues the Run; the
executor then replays the chain from the top against the durable rows. An expired timer takes the
State's authored `onError` path for `wait_timed_out`, or parks. An `event` wait is refused
(`unsupported_wait`): nothing in this process delivers that signal, and opening it would strand the
Run.

A `tool` State is planned in the run-kernel (`planToolDispatch` — arguments, idempotency key, and
effect id all derived from the Run and the durable occurrence key) and then decided by
`routine/tool-port.ts`, this app's only Tool authority for Routines. Everything that decides the
call is read from the Run's own pinned bundle: the ToolContract it names, and the Guardrails
compiled into engine rules by `compileGuardrailPolicy`. The bundle digest is recorded as the
effect's `guardrailRevision`, so the evidence names the exact policy the Run is bound to. Order is
fail-closed: authorize, then reserve in the effect ledger, then dispatch — a denial never reaches
an adapter, and a replayed Run finds its own reserved effect instead of writing a second one. A
confirmed effect succeeds; a definitive refusal takes the State's authored `onError` path for
`tool_<reason>` and fails the Run when no handler claims it; everything else parks. **Two pieces
are absent in production and both park rather than improvise:** no source supplies the Run's
`authorityLayers` (so the broker denies), and the adapter map is empty until installed-Integration
context has an owner in this process (so an authorized dispatch parks on `adapter_not_found`).
An intent the broker sends to a human still parks with `routine:approval_required`: that approval
is bound to the *effect*, and nothing persists one yet.

An `agent` State is where a Routine asks an Agent something. It is planned in the run-kernel
(`planAgentInvocation` — which Agent, at which authored version, over the input resolved from the
Context by the same rules every other State uses, against the output schema the State declared) and
answered by `routine/agent-port.ts`. Everything that decides the question is read from the Run's own
pinned bundle: the Agent at exactly the authored version (a bundle carrying another parks as
`agent_version_mismatch` rather than answering with a different Agent), its personality, and the
ModelProfile it names — so a Run that waited through three publications still asks the Agent it was
minted against. It then runs the **same** `AgentLoop` a chat turn runs, over the same Context
manifest and the same guardrail stages. A definitive failure takes the State's authored `onError`
path under `agent_<reason>` and fails the Run when nothing claims it; a cancelling Run is left to
`RunCancellationManager`; everything else parks.

**Four limits are real and none is papered over.** The State exposes **no Tools** — a Routine's
effects belong to its `tool` States, where the Broker authorizes and the effect ledger reserves them,
and a second dispatch path beside the one the author declared is exactly what this executor must not
grow; the loop's dispatch port denies every call. The guardrail policy is the deployment default
(`DEFAULT_GUARDRAILS`), because no Soul publishes a prompt policy into the bundle yet — the recorded
`guardrailDigest` is the policy that actually ran, never one that did not. The Agent's
`instructions.md` body is a Soul **companion** file (hash only, not carried in the bundle), so the
prompt is built from `spec.personality`. And State outputs are still not plumbed: every settled
State records `{ output: null }`, so `${states.X.output}` resolves null for an `agent` State exactly
as it does for every other type — threading only this one would make a replayed, already-succeeded
State fail to re-derive it.

An `approval` State is the approval that does exist. The wait is planned here, by the run-kernel
(`planApprovalWait` — the authored deadline and `approverRoles` become a bounded wait allowing
`role:<role>` principals), and registered on the other side of `routine/approval-port.ts`: the API
opens the wait and the approval row in one transaction, so a decision surface and a parked Run are
never half-created. The **resume token never crosses that hop** — it is the capability to resume
this Run once, and it stays with the process that redeems it, so this side learns only the wait's
id. Idempotent by State occurrence at both ends (the wait id is `routineWaitId(runId, stateKey)`),
so a worker that died between opening the approval and parking the State replays into its own
approval instead of asking a second human. On replay the executor reads the decision back:
`approved` continues through the authored transition, `denied` takes the authored
`approval_rejected` path and fails the Run when nothing claims it, and an expiry is nobody's
decision — it parks as `routine:wait_expired` rather than being read as either answer.

**Who may decide is fail-closed and narrower than authoring allows.** The deployment's only role
authority today is a user's own recorded role (`admin`/`member`), so a State naming any other
`approverRoles` has no members and every decision on it is refused until a role store exists.

Other State types with effects and Context roots the request Artifact cannot reconstruct are
claimed and parked as `needs_reconciliation`; they are never interpreted as successful or
dispatched through a second authority. A satisfied `any`/`quorum` join that still names units to cancel is refused for
the same reason — this executor can settle a unit but cannot cancel one parked on a live timer.

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

`TurnGuardrails` (`turn/guardrails.ts`) enforces all three stages here, because this is where the
turn actually executes — enforcement that lived in the API guarded web and nothing else. The policy
is never read from the Soul: it arrives **with** the Context, already validated, and is rebuilt into
the same guards the API compiled. `configure` then compares its own revision against the Context's
`guardrailDigest` and **throws** on a mismatch, before the first event — a turn whose evidence names
a policy it is not enforcing is refused, not run.

A blocked input or output does not fail the turn: the State is settled through
`AgentStateRunner.settle` (`claimed → running → succeeded`) and the guard's message is persisted as
the reply, so a refused Slack message and a refused web message read the same. A blocked **Tool
call** is different — it comes back to the model as a `denied` dispatch result and the turn
continues. Blocks are recorded twice on purpose: `guardrail.decision` is operator evidence naming
the guard; `guardrail.blocked` is what a participant sees and omits the guard's identity, so a
refusal never teaches a reader which pattern to write around. The tool-call stage emits only the
operator event.

`RunOutcome` (`run-dispatcher.ts`) says how the executor left the Run. `waiting` parks it for the
wait sweep; `cancelled` means `RunCancellationManager` is already driving the transition and the
dispatcher must **not** write a status of its own.

## Executing a delivery (`src/turn/integration-executor.ts`)

A verified Integration delivery is acknowledged and stored as a Run by the API before anything
interprets it; this executor is where it is interpreted. It asks the internal delivery host
(`internal/delivery-host.ts`) what the delivery is, runs the Integration's own `classify(ctx)` in
this process's sandbox, and turns the answer into a Turn, a recorded Integration event, or a
recorded refusal. Every path ends in exactly **one** `delivery.classified` event, keyed
`${runId}:0:classified` — "why did Slack not reply?" is answered by a row, never by its absence.

The classifier runs here rather than in the API because it is untrusted per-Integration code and
the API is the process holding every credential and every table. `hooks/ingress-hook-worker.ts` is
this app's grant to the isolate, and it grants **nothing** — the API's entrypoint grants a resource
lookup because its resource hooks need one. The two bundles must keep different basenames: the
Dockerfile lays both flat in `/app`, and `resolveHookWorkerPath` finds a sandbox by looking for a
sibling file, so sharing a name would silently hand a classifier the API's grant.

Two things never cross from the API to this process: the **bind link** offered to an unlinked
sender (a credential — the executor is told only that the sender was unlinked) and the **reply
text** (read back out of the durable conversation; this side says which attempt finished and how,
never the words). The reply is posted at least once — making the effect exactly-once is the Tool
Broker's reconciliation story, not a second ledger here.

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
- `RunExecutorRegistry` holds `chat`, `integration`, and `routine`; `DeliveryTargetRegistry` is empty
  (delivery targets land in PR 6), and the Routine Tool port's adapter map is empty for the same
  reason — never register an adapter here that reaches a provider by a route other than an
  installed Integration.

`TurnContextPort`, `TurnCompletionStore`, and the delivery host are all backed over HTTP by the
API's `/api/v1/internal/*` routes (`internal/turn-host.ts`, `internal/delivery-host.ts`). The
caller states **which Run, never as whom**: authority is re-derived from the Run's recorded
identity on the API side, so a worker credential cannot escalate past what the Run was minted with.
PR 4 replaces those handlers with in-worker implementations; the ports do not change.

## Tests

`src/*.test.ts` are unit suites. `test/process/` boots the **bundled** worker as a real child
process against a scratch PGlite served over the wire protocol (`@electric-sql/pglite-socket`) on
an ephemeral port — probes, schema-floor refusal, claim/release, `SIGTERM` drain, and recovery of
a Run a killed worker abandoned. Run with `--maxWorkers=1`.

## Imports

May import: `schema`, `authz`, `audit`, `secrets`, `run-kernel`, `tool-broker`, `agent-runtime`,
`knowledge`, `memory`, `surface`, `integrations`, `sandbox`, `soul`, `storage`, `observability`,
`constants` (all under `@tulipfarm/*`). See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This app
never imports another application (`apps/api`, `apps/integration-worker`, `apps/web`).

The `soul` edge is narrow: execution may read a Run's exact immutable bundle through
`PgBundleStore` and verify its signature. The Worker must never load the live Soul checkout,
resolve an active alias, publish a changeset, or run Git sync.
