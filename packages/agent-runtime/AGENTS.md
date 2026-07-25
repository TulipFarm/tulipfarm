# Agent Runtime — Agent Conventions

`@tulipfarm/agent-runtime` — Context assembly, iterative model/tool loop, model profiles,
compaction, budgets, and delegation orchestration. tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

## Layout

| Path | What |
| --- | --- |
| `src/ports/model.ts` | Provider-neutral model invocation boundary. |
| `src/models/` | ModelProfile routing, constraint-equivalent fallback chains, usage/cost evidence. |
| `src/context/` | Instruction precedence, Context assembly, compaction, manifests. |
| `src/skills/` | Skill resolution: exact versions, trust tiers, scanning, ability intersection. |
| `src/loop/` | Bounded durable Tool loop + checkpoints; the broker is the only effect path. |
| `src/delegation/` | Helper Agents as child Runs: read-only start, narrowing, detach, Artifacts. |
| `src/evals/` | Versioned eval suites and the publication activation gate. |
| `test/security/` | Adversarial injection / non-amplification corpus. |

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`,
`@tulipfarm/run-kernel`, `@tulipfarm/tool-broker`, `@tulipfarm/knowledge`, `@tulipfarm/memory`,
`@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This
package submits child-Run commands through the public `run-kernel` port; `run-kernel` never
imports this package.
