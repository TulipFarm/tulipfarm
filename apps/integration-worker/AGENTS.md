# Integration worker

`@tulipfarm/integration-worker` owns Integration ingress, sync, delivery, retries,
reconciliation, and rate limits for channel workers.

## Read on / Skip

- **Read on if** your task touches Slack/GitHub ingress, delivery retry,
  channel loops, worker credentials, probes, or integration-worker process tests.
- **Skip if** you are changing Run execution (`../worker/AGENTS.md`), HTTP routes or migrations
  (`../api/AGENTS.md`), Integration contracts (`../../packages/integrations/AGENTS.md`), or UI
  (`../web/AGENTS.md`).

## Map

| Path | Owns |
| --- | --- |
| `src/main.ts` | Composition root: schema preflight, probes, loops, shutdown. |
| `src/config.ts`, `src/data-dir.ts` | Env/defaults and volume-backed worker credential loading. |
| `src/channels/` | Channel loop registration; add `DrainableLoop`s here. |
| `src/channels/delivery-poll-loop.ts` | Leased, generation-fenced reply delivery and durable retry deadlines. |
| `src/oim-ingress/` | OIM registration recovery, polling, websocket supervision, and durable inbox cycle. |
| `src/oim-knowledge/` | Durable selected-scope Knowledge subscription checks, completed-sync evidence, and drainable polling loop. |
| `src/consumer-readiness.ts` | Readiness from recent successful OIM consumer cycles, not provider-health claims. |
| `src/oim-runtime.ts`, `src/oim-worker-host.ts` | Production OIM composition and internal host. |
| `src/slack/` | Transport scaffolds exported by `src/index.ts`. |
| `src/github/` | Provider-specific Integration worker code. |
| `src/internal/` | Internal API client/host ports. |
| `test/process/` | Real compiled-process tests over PGlite socket. |

## Rules

- Composition-only: wire `@tulipfarm/*` packages; do not reimplement package-owned logic.
- Requires `DATABASE_URL`, `INTERNAL_API_URL`, and `INTEGRATION_WORKER_API_CREDENTIAL`.
- In containers, `data-dir.ts` may read `integration-worker.env`; env wins, nothing is invented.
- This app never migrates; wait for the schema floor and fail closed like `apps/worker`.
- Validate shared persisted identity and hosting authority before loops/probes; mismatches and
  unsupported hosted trust fail startup without replacing the association.
- OIM operation hosts recheck the expected canonical manifest digest, package companions, current
  Connection, and credential lease immediately before each provider request.
- Serve `/livez` and `/readyz`; drain cleanly on `SIGTERM`/`SIGINT`.
- Declared OIM WebSocket ingress is unsupported and rejected; do not imply the dormant supervisor is live.
- Slack Socket Mode ingress and delivery polling register loops through `src/channels/`.
- The Slack credential watcher owns and drains all loops before replacing bot/app credentials.
- Uncertain Slack posts reconcile provider receipts; never blindly replay `chat.postMessage`.
- Every Slack `events_api` envelope passes `channels/mention-gate.ts` before the adapter; the gate
  is a required dispatch dependency, never an option.
- `src/db.ts` is a deliberate local `pg` copy; apps must not import other apps.
- Keep `src/index.ts` as the public barrel for transport scaffolds, separate from `main.ts`.
- `test/process/` boots the compiled process; expand when loops claim work.
- May import only allowed `@tulipfarm/*` packages, never another app; see dependency rules below.

See [`../../docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md).
