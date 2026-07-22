# Integration Worker App — Agent Conventions

`@tulipfarm/integration-worker` — Integration ingress, sync, delivery, retries, reconciliation,
and rate limits. Composition-only: this app wires published packages together and must not
reimplement package-owned logic. **Scaffold today:** `src/index.ts` is `export {}`. tsconfig
extends `@tulipfarm/tsconfig/node.json`. See root `AGENTS.md` for commands/lint.

May import: `schema`, `authz`, `audit`, `run-kernel`, `tool-broker`, `integrations`, `storage`,
`observability` (all under `@tulipfarm/*`). See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This app
never imports another application (`apps/api`, `apps/worker`, `apps/web`).
