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
  tools/          # central ToolRegistry, batch executor, result truncation
  guardrails/     # reload-on-soul.synced wiring only; the guards live in @tulipfarm/agent-runtime
  platform/       # platform-tier tool implementations + tool-result helpers
  hooks/          # this app's grant to the @tulipfarm/sandbox isolate (worker entrypoint + factory)
  knowledge/      # RAG: pages, chunks, pgvector + tsvector search; governance block
  kv/             # generic scoped key-value store (system/user/agent) — see kv/README.md
  memory/         # per-user working memory
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
