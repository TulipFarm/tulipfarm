# Sandbox — Agent Conventions

`@tulipfarm/sandbox` — isolated execution request contract, backend ports, workspace/assets, and
egress and compute controls. **Scaffold today:** `src/index.ts` is `export {}`. tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`, `@tulipfarm/storage`,
`@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). Production
composition must inject an isolated microVM/service backend; local execution is never a
production isolation boundary.
