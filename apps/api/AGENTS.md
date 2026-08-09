# API App — Agent Conventions

## Directory Structure

Each feature domain gets its own directory under `src/`:

```
src/
  auth/           # session, CSRF, users, API tokens
  chat/           # conversations, messages, turn submission; POST /chat streams the Run's events
  conversations/  # durable Turns: ConversationService + PgConversationStore (channel-agnostic)
  runtime/        # API invocation callers and transaction-composition tests
  resources/      # resource type + data CRUD, per-type Postgres tables, write-pipeline
  tools/          # central ToolRegistry, batch executor, result truncation, declarative/ egress
  guardrails/     # reload-on-soul.synced wiring only; the guards live in @tulipfarm/agent-runtime
  platform/       # platform-tier tool implementations + tool-result helpers
  hooks/          # this app's grant to the @tulipfarm/sandbox isolate (worker entrypoint + factory)
  knowledge/      # RAG: pages, chunks, pgvector + tsvector search; governance block
  kv/             # generic scoped key-value store (system/user/agent) — see kv/README.md
  memory/         # per-user Memory (Assertions)
  secrets/        # secret storage
  soul/           # soul git ops (commit, push) + agents/, skills/, resource-types/ CRUD
  runs/           # persisted Run event SSE stream (GET /api/v1/runs/:id/events, cursor recovery) + cancellation
  identity/       # principals, API clients, channel identity links + the single-use bind flow
  internal/       # /api/v1/internal/* — the turn machinery the Worker calls back into (service-only)
  pg-migrations/  # Postgres schema migrations (applied on boot)
```

All persistence is Postgres (`pg.Pool` in prod, PGlite in tests) via thin repos taking a
`Queryable`. The API may enqueue durable work, but pg-boss consumers run in the Worker. The one
periodic task that remains in this process is Soul down-sync: it pulls the same filesystem worktree
the API authors, then emits `soul.synced` to API-local reload subscribers. Moving that timer to the
Worker would either pull into its unshared container filesystem or introduce concurrent Git writers
on one worktree. No other datastore.

`soul/` now has one subdir per soul-backed resource (`agents/`, `skills/`, `resource-types/`),
each with its own `routes.ts` (HTTP) **and** `tools.ts` (LLM tools). `skills/` also has
`audit.ts` (SkillAudit LLM safety review for the install flow).

## Route Convention

Every feature directory has a single `routes.ts`:

```
<feature>/
  routes.ts       # registerXxxRoutes(app, deps, requireAuth)
  routes.test.ts  # vitest integration tests using buildApp + inject
  schemas.ts      # shared JSON Schema objects (if needed)
```

- Register function name: `register<Feature>Routes`
- Always accept `requireAuth: PreHandler` as last arg for protected routes
- Wire in `app.ts` inside `buildApp` — guarded by required dep checks

## Test Convention

Tests use `buildApp` + Fastify `inject`. Never spin a real server.

Fake dependencies implement the real interface (class, not `vi.fn()` object) for repos. For services without a defined interface (e.g. `GitSyncService`, `SoulLoader`), use a plain object with `vi.fn()` methods cast via `as unknown as T`.

Mock `node:fs` / `node:fs/promises` with `vi.mock` at the top of the test file when the route does filesystem I/O.

Always run tests via `pnpm test` (turbo, per-package). A bare root `pnpm exec vitest run` skips
per-package vitest config (e.g. missing jsdom setup) and gives false failures. Stale CJS files in
`apps/api/dist/` can also get picked up by vitest when run from repo root — if a failure looks
unrelated to your change, confirm by scoping the run to the touched package before assuming a
regression.

`@electric-sql/pglite`'s `vector` export moved packages between versions: pre-0.5 it's
`@electric-sql/pglite/vector`; 0.5.x+ moved it to `@electric-sql/pglite-pgvector` (same `vector`
export). Check this import path when bumping pglite.

## Adding a New Feature

1. Create `src/<feature>/` directory
2. Add `routes.ts` with `registerXxxRoutes`
3. Add `routes.test.ts`
4. Import + wire in `app.ts` → add optional dep to `AppOptions` if needed
5. Pass dep from `index.ts` → `buildApp`

## LLM Tools (`src/tools/`)

The chat turn exposes capabilities to the model as tools. All tools flow through one central
`ToolRegistry` (`tools/registry.ts`); per request `registry.buildToolSet(ctx)` produces the AI
SDK `ToolSet`. Tools are defined as plain `ToolDef` objects (`tools/types.ts`):

```ts
interface ToolDef {
  name: string;            // unique, snake_case (e.g. "record_create")
  tier: "system" | "platform" | "integration";
  mutating: boolean;       // false = read (parallelizable), true = write (sequential)
  description: string;     // LLM-facing
  inputSchema: Record<string, unknown>;  // plain JSON Schema, AJV-validated at call time
  execute: (args, ctx: RequestContext) => Promise<ToolCallResult>;
}
```

- **Return contract:** never throw — return `ok(data)` or `err(code, message)` (`tools/types.ts`).
  Error codes: `validation_error | oversize_value | not_found | internal_error`.
- **Validation:** the registry AJV-compiles `inputSchema` and returns `err("validation_error")`
  before `execute` runs — don't re-validate inside the handler.
- **Batching** (`tools/batch-executor.ts`): tool calls in one model step run in parallel when all
  are reads; if any is `mutating`, the whole batch runs sequentially. 30s per-call timeout.
- **Truncation** (`tools/truncate.ts`): list-shaped results are capped (~20 items) for the LLM
  context with `{ total_count, truncated: true }`; the full result is kept for the SSE UI event.
- **Soul-backed writes:** tools that mutate the soul repo (`resources/`, `soul/*/tools.ts`) wrap
  the write in `GitSyncService.withSync(commitMsg)` so each change is committed + pushed.

**To add a tool:** define a `ToolDef` in the owning feature's `tools.ts`, then register it in
`tools/setup.ts` (`buildToolRegistry`). Group module tool arrays by tier (e.g. `PLATFORM_TOOLS`).
Existing tools by category: system resource/agent/skill/resource-type CRUD (`resources/`,
`soul/*/`), platform UI/routing/soul-batch (`platform/tools.ts`), memory (`memory/tools.ts`),
knowledge (`knowledge/tools.ts`), kv (`kv/tools.ts` — agent-scoped `kv_get`/`kv_set`/`kv_delete`/`kv_list`),
time (`platform/tools.ts` — `get_current_time`, a fresh reading when a long turn outlives the
turn-start `<current-context>` block).

**Do not add a tool for a third-party provider.** `tools/declarative/` builds Tools from an
Integration manifest's `egress` block, so a provider is added by writing a manifest
([`docs/architecture/building-an-integration.md`](../../docs/architecture/building-an-integration.md)),
not TypeScript. `tools/github/` and `tools/slack/` are the exceptions, not the pattern.

These do not go through `buildToolRegistry`, because what they publish depends on which
integrations are connected *now*: `tools/declarative/sync.ts` reconciles them against the live
registry at boot and again on every connect, disconnect, and uninstall — a disconnect unregisters
exactly the Tools it added, so an agent cannot keep calling a provider whose credential was just
revoked. They still take the same governed `EffectStore.reserve` → `EffectDispatcher.dispatch` path
the hand-written families do; declarative authorship changes who writes an integration, not how far
the platform trusts it.

## Context & streaming

- **System prompt**: `assembleSystemPrompt(ctx)` now lives in `@tulipfarm/agent-runtime` (the
  Worker assembles prompts and may not import this app). It is a pure, synchronous, fixed-order
  block builder — the caller resolves every input (personality, memory, governance docs…) and
  passes it in, so the rendered prefix is deterministic and prompt-cacheable. This app keeps
  `chat/system-prompt.ts`, the adapter that projects Soul artifacts into its `AssembleContext`.
  See `packages/agent-runtime/src/context/README.md` for block order and budgets.
- **Durable SSE** (`runs/events.ts`): `POST /api/v1/chat` submits the turn and then *reads* the
  Run's persisted `run_events`, frame for frame the same stream `GET /api/v1/runs/:id/events`
  serves — so a dropped connection reattaches by cursor (`?after=`, or `Last-Event-ID`) and loses
  nothing, because the Worker is executing the Run regardless. Authorization is re-checked every
  poll, and the stream ends on the Run's own terminal status. This is now the *only* streaming
  path — the in-process `chat/stream-hub.ts`/`stream-resume.ts` buffers went with the Routine
  engine they were kept for.
- Static business/identity facts (e.g. `soul.yaml`'s `businessName`/`businessDescription`) belong
  in the **system prompt** (`assembleSystemPrompt`), not `memory/` working_memory — don't route
  them through working_memory just because onboarding captured them at runtime.

## Submitting a turn (`conversations/`, `runtime/`, `chat/turn-submit.ts`)

Every request that mints a Run goes through `DurableInvocationGateway.start()`, which takes the
payload plus the `payloadSchemaRef` it claims to satisfy (registered in `@tulipfarm/schema`'s
`INVOCATION_REQUEST_SCHEMAS`) and commits the Run, its first State, and an immutable request
Artifact in one transaction. The gateway and PostgreSQL adapter are owned by
`@tulipfarm/run-kernel`; this app only composes them with its database and Artifact store. Never
pass a `payloadRef` that names nothing — the Artifact is what makes a Run reconstructable after a
crash.

The invocation source (`manual`, `schedule`, `integration`, and so on) records what accepted the
request. The Run source (`chat`, `integration`, `routine`) selects the Worker executor and is stored
separately from the pinned bundle's canonical Routine id. Do not route work through
`bundle.routineId`.

Routine invocations resolve only through `runtime/invocation-definitions.ts`: it verifies the
business's active signed Soul bundle, selects the published canonical Routine, and pins the exact
bundle digest, stable Routine id/version, and authored start State before the Run is created. Never
fall back to the live Soul checkout or the legacy Routine registry. Missing or invalid active
publication means no Run. The HMAC verification material is the durable auto-generated Secret
`soul-bundle.signing-key`, resolved during API boot.

A chat turn is persisted by exactly one `ChatTurnSubmitter` (declared and implemented in
`chat/turn-submit.ts`): no turn machinery in this app writes a user Message, so a new entrypoint
must submit through this port rather than writing its own. `durableTurnSubmitter` writes the Turn,
the Message carrying its `turn_id`, and the Run; a replayed `Idempotency-Key` resolves to the Turn
that already answered the request and the route returns `409` with its `runId`. Non-chat callers
use `runtime/invocation-callers.ts` (`integrationInvoker`, `manualRoutineTrigger`).

**No turn executes in this process.** Submission mints the Run and the request Artifact; the Worker
loads that Artifact and runs the turn. Stopping one is therefore cancelling its Run
(`POST /api/v1/chat/runs/:runId/stop` → `runs/cancel.ts`), which halts the turn in whichever
process holds it — not closing a connection this one is holding.

`internal/` is the other half: `/api/v1/internal/*` serves the Worker the Context, Tool dispatch,
delivery classification, and Turn completion it cannot yet do itself. Those handlers take **which
Run**, never **as whom** — authority is re-derived from the Run's recorded identity, so a worker
credential cannot escalate past what the Run was minted with. PR 4 moves the implementations into
the Worker; the ports do not change.

## Guardrails (`src/guardrails/`)

Three guard stages wrap a turn (GR-V1-001/002/003) — **input** before the model is asked anything,
**tool-call** before dispatch, **output** before the answer is persisted. Guards return
`pass | transform | block`, run in array order, first `block` short-circuits, each bounded by a 5s
timeout (timeout/throw → skip-as-pass + log). An input/output block answers with the guard's
message; a tool-call block returns a denial the LLM sees (the turn continues).

**Enforcement is not here.** `GuardrailsService` and the guards live in
**`@tulipfarm/agent-runtime`**, and the Worker applies all three stages inside the turn it executes
(`apps/worker/src/turn/guardrails.ts`) — that is the only way a Slack or Telegram turn is guarded
identically to a web one. What this app owns is the policy: it reads it, validates it, and **ships
it with the resolved Context** (`internal/turn-context.ts` sets `guardrailPolicy` alongside
`guardrailDigest`), so the Worker rebuilds the identical guards rather than deriving a second
policy of its own. A Context that resolves no service still ships `DEFAULT_GUARDRAILS`, never an
empty policy. `guardrails/reload.ts` — the `soul.synced` subscription that re-reads the config —
also stays, because that is composition, not policy.

The service is built from `soul/guardrails.yaml` (validated by `@tulipfarm/schema`
`validateGuardrailsConfig`); an absent **or invalid** config falls back to `DEFAULT_GUARDRAILS` —
fail-safe, never unguarded, never crashing. Wired in `index.ts` (construct → `init` after
`buildApp` → `registerGuardrailsReload` on `soul.synced`) and passed through
`AppOptions.guardrailsService`. Built-in guards: `prompt_injection` (input), `content_filter`
(output), `tool_blocklist` (tool-call) — all pattern-only (no LLM). See
`packages/agent-runtime/src/guardrails/README.md`.

## Integration auth (`src/integrations/auth-broker.ts`, `auth-routes.ts`)

Connect flows are **declared, not coded**. A manifest's `auth` block is an ordered list of steps
(`fields`, `app_manifest`, `oauth2`, `install`) resolved through `resolveAuthSteps`
(`@tulipfarm/soul`), which also derives that list for legacy manifests that only declare
`required_env`/`oauth` — so there is never a second code path for old manifests. **Adding an
integration must not add a route.** If a provider needs something the step kinds cannot express,
extend the contract in `packages/soul/src/types.ts`; do not add a bespoke route beside it.

Two routes serve every integration:

- `POST /api/v1/integrations/:name/auth/start/:step` (authed) → `collect_fields | redirect |
  form_post`, i.e. what the browser must do next.
- `GET /api/v1/integrations/auth/callback` — **one callback for all integrations, deliberately
  unauthenticated.** Providers validate the redirect URI against what was registered, so the path
  cannot vary per integration; the slug and step index travel in the `state`. It is unauthenticated
  because a cross-site top-level navigation from the provider never carries our
  `SameSite=Strict` session cookie.

State lives in `integration_auth_requests` rather than a stateless signed token because PKCE
requires the `code_verifier` to stay server-side, and
because a row can be **consumed once** — `UPDATE ... WHERE consumed_at IS NULL AND expires_at >
now()`, mirroring `oidc_auth_requests`. A captured callback URL is therefore not replayable.

The callback origin comes from `PUBLIC_API_URL` (`resolveAuthEndpoints`), never from the request
`Host`, which an attacker controls. `PUBLIC_URL` is the *web* origin and is only where the operator
is redirected back to.

`connection-writer.ts` is the **only** writer of `connection.yaml`: it merges rather than replaces
(a later step must not erase what an earlier one wrote), seals every secret env into the secrets
store so the git-committed file holds only `secret://` refs, then commits and reloads Soul. Secret
env names come from `authSecretEnvNames`, which covers the *derived* refresh-token name — sealing
must cover exactly what the broker writes, or a live credential is committed in plaintext to the
user's soul repo.

### Adding an integration

Write `integrations/<slug>/manifest.yml`. **Add no routes and no TypeScript.** Slack and GitHub are
the worked examples: Slack is `app_manifest` → `fields` → `oauth2`, GitHub is `app_manifest` (with
an `exchange` that redeems GitHub's one-time code for the App credentials) → `install`.

Post-connect wiring — anything that must happen once credentials exist — goes in the shared
`onConnected` hook in `app.ts`, not in a route. Both current cases are genuine domain logic that
the broker should not know about:

- `ensureDefaultSlackRoute` (`slack-binding.ts`) — creates the default channel route.
- `ensureGitHubInstallation` (`github-install.ts`) — records the `integration_apps` /
  `integrations` / `integration_access_grants` rows for an installation. It **fails soft**: it runs
  after credentials are committed, so throwing would show an error for an App that is connected.

Credentials are sealed under `integration.<slug>.<ENV>`. GitHub's App credentials are read back by
name-by-role through `INTEGRATION_APPS` (`packages/secrets/src/integration-registry.ts`), which
points at those same keys — if you rename an env var in `integrations/github/manifest.yml`, update
that registry or the App connects but cannot mint a single token. `bundled-auth.test.ts` guards the
shipped manifests, and `github-auth-flow.test.ts` / `slack-auth-flow.test.ts` drive them end to end.

### Catalog and third-party installs

`integrations/registry.yml` is the curated catalog folded into `GET /api/v1/integrations`. That one
endpoint returns installed integrations and curated-but-not-yet-installed ones in a single list,
distinguished by `installed` — there is no separate marketplace endpoint, because everything
bundled in the image is already installed and the axis that matters is *connected*, not *installed*.
Discovery stays authoritative for what exists — a bundled integration missing from the registry is
still listed, just without a display title — so an entry there is presentation metadata plus, for a
third-party integration, the git `source` to clone. Being listed grants no trust: a curated entry
installs through exactly the same path as a URL pasted by hand.

A registry entry and a manifest may both carry `icon`, a [Simple Icons](https://simpleicons.org)
slug that `brand-icon.ts` resolves server-side into a bare SVG path (`iconPath`). Resolution is
server-side because the package is 25MB and because an integration cloned at runtime has no build
step to bundle into. Not every brand is present — Slack, Microsoft Teams, and Salesforce were
removed on trademark request — so the monogram fallback is a normal state. Never point a brand at a
lookalike slug to dodge it.

`POST /api/v1/integrations/inspect` previews a repo and `POST /api/v1/integrations/install` writes
one integration into the soul repo (`install.ts`), recording provenance in `integrations-lock.json`.
Only `manifest.yml` and `setup-guide.md` are copied, and both must be **regular files** — a
symlinked guide would otherwise publish host files to the operator's own git remote. The loader
reads the integrations directory and never consults the lock, so a failed install rolls its
directory back rather than leaving something that boots.

Third-party manifests must be **purely declarative** — `validateThirdPartyManifest`
(`packages/soul/src/integration-trust.ts`) rejects `ts-code` egress, a stdio MCP server (which is a
spawned local process), and `ingress.handler`, and requires every provider URL to be `https://`.
Installing an integration must never mean running a stranger's code, so if you add a manifest field
that names something executable, add it to that validator in the same change. Note the consequence:
third-party integrations cannot declare ingress in this version.

`isAllowedSource`/`cloneToTemp` live in `apps/api/src/soul/git-source.ts` and are shared with
Skills. That is the SSRF allowlist — keep it in one place; two copies would eventually disagree
about what is safe to hand to `git clone`.
