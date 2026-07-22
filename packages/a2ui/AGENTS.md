# A2UI — Agent Conventions

`@tulipfarm/a2ui` — safe presentation schemas, Artifact representation, signed action
descriptors, and form contracts. **Scaffold today:** `src/index.ts` is `export {}`. tsconfig
extends `@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`, `@tulipfarm/observability`.
See [`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md).
Surfaces are data Artifacts, never generated executable UI or business logic.
