# Run Kernel — Agent Conventions

`@tulipfarm/run-kernel` — Run and State state machines, attempts, scheduling, durable waits,
retries, cancellation, child Runs, and concurrency. **Today:** `src/model` (state machines),
`src/lease` (worker leases), `src/outputs` (AJV-validated typed State outputs + canonical hashes),
`src/artifacts` (immutable Artifact publish/read with ACL, classification, retention, redaction,
and tamper checks), `src/lineage` (named State-output mappings resolved into downstream
Context), and `src/waits`, `src/timers`, `src/resume` (durable timer/event/Approval/human-task/
form/child-Run waits with `first`/`all`/`quorum`/window aggregation, deadline sweeps, and
unguessable one-use resume tokens), and `src/limits`, `src/budgets`, `src/concurrency`
(narrowest-wins limit resolution, non-amplifying Agent requests, durable per-Run budget ledgers
with a declared exhaustion disposition, and `serialize`/`queue`/`coalesce`/`reject`/`supersede`
target-concurrency admission over a deterministic target key), and `src/children`, `src/cancel`,
`src/reconcile-state` (never-broadening child authority with explicit detach, cancellation that
cancels future work and parks in-flight effects, and evidence-driven reconciliation where an
ambiguous effect never becomes `cancelled`), and `src/resilience` (crash/duplicate/recovery proofs
over a `SimulatedRunStore` that injects failure before and after each durable write). tsconfig extends `@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/audit`, `@tulipfarm/storage`,
`@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). Every
Chat turn and automation is a durable Run through this package; it never imports
`@tulipfarm/agent-runtime` (the agent runtime submits child-Run commands through this package's
public port, not the reverse).

`src/artifacts` has a production consumer: `apps/api`'s invocation gateway publishes every request
Artifact through `ArtifactService` inside the transaction that creates the Run, and PR 3's worker
reads it back as `service:run-executor`. Artifact rows are append-only (a trigger rejects
UPDATE/DELETE), so an ACL or classification must be correct on the first write — there is no
correcting write.
