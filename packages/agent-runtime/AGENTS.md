# Agent Runtime — Agent Conventions

`@tulipfarm/agent-runtime` — Context assembly, iterative model/tool loop, model profiles,
compaction, budgets, and delegation orchestration. **Scaffold today:** `src/index.ts` is
`export {}`. tsconfig extends `@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for
commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`,
`@tulipfarm/run-kernel`, `@tulipfarm/tool-broker`, `@tulipfarm/knowledge`, `@tulipfarm/memory`,
`@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This
package submits child-Run commands through the public `run-kernel` port; `run-kernel` never
imports this package.
