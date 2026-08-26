# API app

`@tulipfarm/api` is the Fastify HTTP API. It owns routes, OpenAPI exposure,
PostgreSQL persistence composition, auth, Soul Git writes, and Worker callback ports.

## Read on / Skip

- **Read on if** you touch API routes, migrations, auth/session behavior, Soul-backed HTTP or
  Tool writes, integration auth/install, Run submission, SSE, or `/api/v1/internal/*`.
- **Skip if** the task is UI-only ([`../web/AGENTS.md`](../web/AGENTS.md)), Worker execution
  ([`../worker/AGENTS.md`](../worker/AGENTS.md)), shared state machines
  ([`../../packages/run-kernel/AGENTS.md`](../../packages/run-kernel/AGENTS.md)), or shared
  runtime logic ([agent-runtime](../../packages/agent-runtime/AGENTS.md)).

## Map

| Path | Owns |
| --- | --- |
| `src/app.ts`, `src/index.ts` | App composition, dependency wiring, boot lifecycle. Per-feature wiring belongs in that feature's own `compose.ts`; both files are at their size cap. |
| [`src/auth/`](src/auth/AGENTS.md) | Sessions, CSRF, passwords, users, invites, API tokens. |
| [`src/identity/`](src/identity/AGENTS.md) | Principals, OIDC, step-up, API clients. |
| `src/chat/`, `src/conversations/` | Chat routes, Turn persistence, durable stream handoff. |
| `src/runs/` | Persisted Run event SSE, cursor resume, cancellation. |
| `src/runtime/` | Durable invocation callers, Routine invocation resolution, Soul write gateway composition. |
| `src/internal/` | Service-only Worker callbacks for Context, Tools, delivery, completion. `subagent-context.ts` assembles the Conversation-less sub-agent Context; `turn-host.ts` splits `RunAuthority` (no Turn) from `TurnAuthority` (has one). `route-family.ts` registers the whole service-principal plane — put new internal families there, not in `app.ts`. |
| `src/curator/` | The Curator's internal routes, the admin-only shadow review route, composition, and the `curator-sweep` schedule, and nothing else. Reasoning is `@tulipfarm/curator`, minting/pinning/revalidation is `@tulipfarm/curator-host`, tables are `packages/storage`, the model call is the Worker's. |
| `src/tools/` | ToolRegistry, batch execution, truncation, declarative egress sync. |
| `src/platform/` | Platform Tools that need the API's own services. `delegate-tool.ts` hands work to a Soul Agent (which gets a Conversation); `spawn-tool.ts` + `subagent-{run,answers}.ts` spawn an ad-hoc helper the caller defines inline, which gets none. Both park the calling Turn on a child-Run wait. |
| `src/resources/`, `src/soul/` | Resource CRUD and Soul HTTP routes/Tools; domain logic lives in `@tulipfarm/soul`. |
| `src/integrations/` | Manifest catalog, connect auth, install, post-connect hooks. |
| `src/guardrails/` | Guardrail config loading and `soul.synced` reload wiring only. |
| `src/knowledge/`, `src/knowledge-sources/` | Knowledge routes/Tools and ingestion API; repositories and OKF live in `@tulipfarm/knowledge`. |
| `src/memory/`, `src/kv/`, `src/secrets/` | Memory Document composition, its read-only route and erasure; scoped KV; secret storage routes. |
| `src/authz/` | `route-gate.ts` — the sole HTTP path to `decideEffectivePermission`; self-governed routes. |
| `src/approvals/`, `src/broker/` | Approval routes and Tool effect dispatch composition. |
| `src/tasks/` | Task routes, ranking. System-created human work items — no user-facing create route. |
| `src/kill-switches/` | Operator-armed emergency stop over mutating effects; admin-gated routes. |
| `src/surfaces/`, `src/forms/` | Tulip Surface Protocol and form APIs. |
| `src/ingress/`, `src/triggers/`, `src/schedule/` | Ingress, triggers, schedules. |
| `src/admin/`, `src/setup/`, `src/onboarding/`, `src/system/` | Admin, setup, health. |
| `src/pg-migrations/` | Boot-applied PostgreSQL schema migrations. |
| `src/test/` | API test helpers. |

## Rules

- Persistence is PostgreSQL only (`pg.Pool` in prod, PGlite in tests); repos take `Queryable`.
  API may enqueue work, but pg-boss consumers live in the Worker.
- Soul down-sync stays in this process: it pulls the API-authored worktree, then emits
  `soul.synced` for API-local reload subscribers. Do not move it to the Worker.
- Each feature route module uses `register<Feature>Routes(app, deps, requireAuth, requireAuthorization)`;
  both gates precede any optional param and are wired in `buildApp` with dependency checks.
- A protected route **declares** a `RouteAuthorization` and lets `requireAuthorization` decide; it
  never compares `user.role` in the handler (ADR authorization-design D4). The declaration's
  `fallback` is mandatory — a missing authorizer must never widen access. Reflect each new action
  in `identity/roles.ts`, or the role-catalog fitness test fails.
  `scripts/route-authorization.test.ts` pins the remaining inline checks as a list that can only shrink.
- API tests use `buildApp` + Fastify `inject`; never start a real server. Fake repos should be
  real classes; mock `node:fs` at top level when a route does filesystem I/O.
- Run API tests through the workspace script, e.g. `pnpm --filter @tulipfarm/api test src/auth`.
  A root `vitest run` can skip package config or pick up stale `apps/api/dist/` CJS files.
- A test needing the full schema calls `makeMigratedPglite()`, never `makePglite()` +
  `runPgMigrations()`. The latter replayed all migrations per test and was half the suite's
  runtime; the helper restores a per-worker snapshot instead, for the same isolation.
  `src/test/pglite-snapshot.test.ts` fails the build if the slow pair comes back.
- PGlite pgvector imports changed across versions: check `@electric-sql/pglite/vector` versus
  `@electric-sql/pglite-pgvector` when bumping PGlite.
- `apps/api/src` is capped by `scripts/control-plane-size.test.ts`: new domain logic belongs in the
  owning package. PGlite repository tests stay here even when the repository does not, because this
  app owns the migrations that build the tables.
- A Record mutation and its history snapshot are one `ResourceRepo` call, committed on one
  transaction. There is no separate `appendHistory`: a committed Record with no history entry is an
  audit gap, and the route emits its domain event only after that call returns.
- Tools return `ok(data)` or `err(code, message)`, never throw; ToolRegistry validates
  JSON Schema before execution. Read batches run in parallel; mutating batches are serial.
- Every write to the authored Soul tree goes through `SoulWriter.apply()` (ADR-007) — routes, Tools
  and installers alike. There is no other door, and `scripts/soul-write-gateway.test.ts` fails CI on
  a new bypass. Raw `fs` writes plus a commit are not an alternative.
- **Every Tool that writes a Skill is two calls: audit, then confirm.** The first validates, runs
  SkillAudit and parks the exact bytes in `soul/skills/drafts.ts`, writing nothing; the second takes
  only the name and that one-use token, and `classify` makes it the call that mutates and asks a
  human. Never let the confirming call re-read a body — an Agent would then have benign text audited
  and different text written under the approval the report earned. `skill_create`, `skill_update`
  and `skill_install` all share this shape.
- Third-party provider Tools come from Integration manifest `egress`, not handwritten TypeScript;
  `tools/github/` and `tools/slack/` are exceptions.
- Every `EffectDispatcher` built here is given the `MutationKillSwitchGuard` from `src/index.ts`.
  The guard shipped inert once — present, unit-tested, and constructed nowhere — so
  `scripts/mutation-kill-switch.test.ts` now pins it installed.
- `ENFORCEABLE_SCOPE_KINDS` (`src/kill-switches/service.ts`) is the list of scopes a guard can
  actually evaluate, and arming anything else is refused with 422. Widen it only after a dispatch
  site supplies the matching identity, never to make the picker look complete.
- Guardrail enforcement lives in `@tulipfarm/agent-runtime` and the Worker. API owns config loading
  and must ship `guardrailPolicy`; missing or invalid config falls back to `DEFAULT_GUARDRAILS`.
  `guardrail_forge` (`platform/guardrail-tool.ts`) is the only authoring surface: it merges one
  guard into `guardrails.yaml` through `SoulWriter`, then re-inits `GuardrailsService`. A Turn's
  Context reads that service, never the published bundle, so skipping the re-init would commit a
  Guardrail that guards nothing until the next restart.
- A Run-minting request must go through `DurableInvocationGateway.start()` with a real request
  Artifact. Never pass a `payloadRef` that names nothing.
- The Curator's model call belongs to the Worker, never this process. `POST /internal/curator/*/effects`
  accepts raw model output plus the `contextDigest` it was produced from, then reloads the pinned
  inputs and re-derives every decision. A Worker-authored effect is not trusted input.
- `curator:<kind>:<subject-kind>:<subject-id>` is a reserved Task dedupe namespace. `tasks/tools.ts`
  rejects it from Agents so a Proposal's identity cannot be forged or resurrected from a Tool call.
- `GET /curator/shadow` is admin-gated and user-facing, so it registers in `app.ts` — never in the
  internal route family, which is service-only by contract. Disclosure is `projectShadowEffect`'s
  decision, not the route's: a memory patch or Proposal goes out in full only to its own subject.
- The Curator reports through `DOMAIN_EVENTS.CURATOR_OBSERVED` and never holds a `MetricsSink`.
  `observability/events.ts` maps it to metrics. Emit no subject id: an operator dashboard must not
  become a way to read who learned what. Reporting can never fail the work it describes.
- Chat turns are persisted only through `ChatTurnSubmitter`; no turn executes in this process.
  Stopping a turn cancels its Run.
- Routine invocations resolve only through `runtime/invocation-definitions.ts`; never fall back to
  the live Soul checkout, legacy registry, or `bundle.routineId`.
- Integration connect flows are manifest-declared. Adding an integration must not add a bespoke
  route; extend `packages/soul/src/types.ts` if auth step kinds are insufficient.
- Integration callback origin comes from `PUBLIC_API_URL`, never request `Host`; `PUBLIC_URL` is the
  web redirect origin only.
- `integrations/connection-writer.ts` is the only `connection.yaml` writer; it must merge, seal
  secret env values to `secret://` refs, commit, and reload Soul.
- Third-party integration installs copy only regular `manifest.yml` and `setup-guide.md`; manifests
  must stay declarative, https-only for provider URLs, and non-executable.
- Clone every caller-supplied Git source through `withGitSourceClone` from `@tulipfarm/integrations`
  (`src/git-source/`); do not fork SSRF policy and never return git's stderr to a caller.

See [Integration authoring](../../docs/architecture/building-an-integration.md).
