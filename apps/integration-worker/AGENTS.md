# Integration Worker App — Agent Conventions

`@tulipfarm/integration-worker` — Integration ingress, sync, delivery, retries, reconciliation,
and rate limits. Composition-only: this app wires published packages together and must not
reimplement package-owned logic. tsconfig extends `@tulipfarm/tsconfig/node.json`. See root
`AGENTS.md` for commands/lint.

## Running it

`pnpm --filter @tulipfarm/integration-worker dev` (tsx watch) or `node dist/main.js` (built via
`tsc`) / the bundle a future Dockerfile entrypoint emits. Requires `DATABASE_URL`;
`INTEGRATION_WORKER_PORT` (default `4030`) and `INTEGRATION_WORKER_DRAIN_TIMEOUT_MS` (default
`15_000`) have defaults — see `src/config.ts`.

## Composition root (`src/main.ts`)

Boot skeleton only, mirroring `apps/worker`'s own PR1 shape: wait for the schema floor
(`preflight.ts`, same fail-closed check as `apps/worker` — this process never migrates), serve
`/livez`+`/readyz` (`probe-server.ts`), drain cleanly on `SIGTERM`/`SIGINT` (`shutdown.ts`). **No
consumer loop is registered yet** — `loops` in `main.ts` is an empty array. Slack Socket Mode,
Telegram long-poll, and delivery retry each land in their own future PR and only need to push a
`DrainableLoop` onto that array.

`db.ts` is a deliberate local copy of the same `pg` wiring `apps/worker` uses — an application may
not import another application, and `@tulipfarm/storage` owns only the provider-neutral port, not
the connection.

`src/index.ts` stays the public export barrel for the Slack/Telegram transport scaffolds
(`slack/`, `telegram/`) — unrelated to `main.ts`, the same split `apps/worker` keeps between its
own `index.ts` and `main.ts`.

## Tests

`test/process/` boots the compiled process as a real child against a scratch PGlite served over
the wire protocol, mirroring `apps/worker/test/process/` — probes and schema-floor refusal today;
claim/release and recovery tests land once a consumer loop exists to claim anything.

## Imports

May import: `schema`, `authz`, `audit`, `run-kernel`, `tool-broker`, `integrations`, `storage`,
`observability` (all under `@tulipfarm/*`). See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This app
never imports another application (`apps/api`, `apps/worker`, `apps/web`).
