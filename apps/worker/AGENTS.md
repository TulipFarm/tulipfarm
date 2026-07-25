# Worker App — Agent Conventions

`@tulipfarm/worker` — durable Run dispatch, Agent/Tool States, timers, reconciliation, and
projections. Composition-only: this app wires published packages together and must not
reimplement package-owned logic. Today: Run/event dispatchers, `src/agent-state.ts` (Agent State
execution around the bounded Agent loop), and `src/conversation-turn.ts` (durable Turn
completion). tsconfig
extends `@tulipfarm/tsconfig/node.json`. See root `AGENTS.md` for commands/lint.

May import: `schema`, `authz`, `audit`, `secrets`, `run-kernel`, `tool-broker`, `agent-runtime`,
`knowledge`, `memory`, `a2ui`, `integrations`, `sandbox`, `storage`, `observability` (all under
`@tulipfarm/*`). See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This app
never imports another application (`apps/api`, `apps/integration-worker`, `apps/web`).
