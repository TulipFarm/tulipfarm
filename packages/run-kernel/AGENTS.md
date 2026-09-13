# Run kernel (`@tulipfarm/run-kernel`)
Durable Run and State machines: attempts, scheduling, waits, retries, cancellation, child Runs,
typed outputs, Artifacts, limits, budgets, and concurrency.

## Read on / Skip
- **Read on if** you touch Run/State transitions, invocation, Artifacts, leases, waits, timers, resume tokens, budgets, limits, child Runs, cancellation, or reconciliation.
- **Skip if** you touch Agent prompts/loops, Tool adapters, API routes, or Worker dispatch.

## Map
| Path | Owns |
| --- | --- |
| `src/model/`, `src/routine/`, `src/triggers/` | Run/State, Routine, and trigger models. `triggers/dispatch.ts` matches an event envelope to a Trigger and starts the Run; `triggers/matcher.ts` owns the authored `filter` expression and the specificity tie-break. |
| `src/invocation/` | Persist-first Run/request-Artifact gateway and PostgreSQL adapter. |
| `src/{lease,interruption,outputs,artifacts,lineage}.ts` | Leases, ownership-loss control flow, typed outputs, Artifacts, lineage. |
| `src/{waits,timers,resume,effect-retry-waits}.ts` | Durable waits, deadline sweeps, retry timers, one-use resume tokens. |
| `src/{limits,budgets,concurrency}.ts` | Limits, budget ledgers, concurrency admission. |
| `src/{children,cancel,reconcile-state}.ts` | Child Runs, cancellation, reconciliation. |
| `src/routine/{executor,tool-outcome}.ts` | Shared Routine orchestration and fenced Tool-State outcomes used by Worker and Eval. |
| `src/child-completion.ts` | Signalling a parent's durable wait when its child Run terminates. |
| `src/child-sweep.ts` | Reconciling child completions whose signal never landed, including cancellations. |
| `src/resilience/` | Crash/duplicate/recovery proofs over `SimulatedRunStore`. |

## Rules
- May import only `@tulipfarm/schema`, `audit`, `storage`, and `observability`; see [dependency rules](../../docs/architecture/dependency-rules.md).
- Every Chat turn and automation is a durable Run here; never import `@tulipfarm/agent-runtime`.
- `src/invocation` is composed by API: publish the request Artifact through `ArtifactService` in the same transaction that creates the Run; Worker reads it as `service:run-executor`.
- Artifact rows are append-only; ACL and classification must be correct on first write.
- Routine Runs require `RoutineInvocationResolver`; fail closed before Run id allocation unless
  exact bundle identity and canonical start State resolve from verified active Soul publication.
- Never interchange Run-level `concurrency.ts` admission with expiry-bounded per-State `routine/concurrency-lease.ts` exclusion.
- Authored limits reach `LimitSet` only through `routine/authored-limits.ts`; never cast authored limits.
- `routine/limit-enforcement.ts` must assign every `LIMIT_KEYS` entry to `bounds`, `retry`, or the Routine budget ledger; see `scripts/routine-limit-coverage.test.ts`.
- Child authority never broadens; detach must be explicit. Cancellation parks in-flight effects; ambiguous evidence never becomes `cancelled`.
- A child link carries the `callId` that spawned it, so a replayed Tool call adopts the child it
  already made. `conversationId` is not a substitute — it is minted fresh on every replay.
- A parent waits on its child through the durable wait on the link (`resume`), never by polling.
  `signalChildCompletion` is its only resolver and must tolerate `not_awaited`: a detached child
  has no parent to wake.
- `resumeIfResolved` takes the caller's own `runId`, not just a wait id, and refuses a wait naming
  another Run. Holding a wait id must never be enough to requeue somebody else's Run.
