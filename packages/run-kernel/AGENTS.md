# Run kernel (`@tulipfarm/run-kernel`)
Durable Run and State machines: attempts, scheduling, waits, retries, cancellation, child Runs,
typed outputs, Artifacts, limits, budgets, and concurrency.

## Read on / Skip
- **Read on if** you touch Run/State transitions, invocation, Artifacts, leases, waits, timers,
  resume tokens, budgets, limits, child Runs, cancellation, or reconciliation.
- **Skip if** you touch Agent prompts/loops (`../agent-runtime/AGENTS.md`), Tool adapters
  (`../tool-broker/AGENTS.md`), API routes (`../../apps/api/AGENTS.md`), or Worker dispatch.

## Map
| Path | Owns |
| --- | --- |
| `src/model/`, `src/routine/`, `src/triggers/` | Run/State, Routine, and trigger models. |
| `src/invocation/` | Persist-first Run/request-Artifact gateway and PostgreSQL adapter. |
| `src/{lease,outputs,artifacts,lineage}.ts` | Leases, typed outputs, Artifacts, lineage. |
| `src/{waits,timers,resume}.ts` | Durable waits, deadline sweeps, one-use resume tokens. |
| `src/{limits,budgets,concurrency}.ts` | Limits, budget ledgers, concurrency admission. |
| `src/{children,cancel,reconcile-state}.ts` | Child Runs, cancellation, reconciliation. |
| `src/resilience/` | Crash/duplicate/recovery proofs over `SimulatedRunStore`. |

## Rules
- May import only `@tulipfarm/schema`, `audit`, `storage`, and `observability`; see
  [dependency rules](../../docs/architecture/dependency-rules.md).
- Every Chat turn and automation is a durable Run here; never import `@tulipfarm/agent-runtime`.
- `src/invocation` is composed by API: publish the request Artifact through `ArtifactService` in
  the same transaction that creates the Run; Worker reads it as `service:run-executor`.
- Artifact rows are append-only; ACL and classification must be correct on first write.
- Routine Runs require `RoutineInvocationResolver`; fail closed before Run id allocation unless
  exact bundle identity and canonical start State resolve from verified active Soul publication.
- Child authority never broadens; detach must be explicit. Cancellation parks in-flight effects.
  Ambiguous effect evidence never becomes `cancelled`.
