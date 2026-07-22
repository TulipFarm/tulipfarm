# Run Kernel — Agent Conventions

`@tulipfarm/run-kernel` — Run and State state machines, attempts, scheduling, durable waits,
retries, cancellation, child Runs, and concurrency. **Scaffold today:** `src/index.ts` is
`export {}`. tsconfig extends `@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for
commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/audit`, `@tulipfarm/storage`,
`@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). Every
Chat turn and automation is a durable Run through this package; it never imports
`@tulipfarm/agent-runtime` (the agent runtime submits child-Run commands through this package's
public port, not the reverse).
