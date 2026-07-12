# API App — Agent Conventions

## Directory Structure

Each feature domain gets its own directory under `src/`:

```
src/
  auth/           # session, CSRF, users, API tokens
  chat/           # conversations, messages, streaming chat turn + durable SSE resume
  context/        # deterministic system-prompt assembly (assembleSystemPrompt)
  resources/      # resource type + data CRUD, per-type Postgres tables, write-pipeline
  tools/          # central ToolRegistry, batch executor, result truncation
  guardrails/     # 3-stage guard framework (input/tool-call/output) + pattern guards — see guardrails/README.md
  platform/       # platform-tier tool implementations + tool-result helpers
  hooks/          # isolated-vm hook sandbox + worker
  knowledge/      # RAG: pages, chunks, pgvector + tsvector search; governance block
  kv/             # generic scoped key-value store (system/user/agent) — see kv/README.md
  memory/         # per-user working memory
  secrets/        # secret storage
  soul/           # soul git ops (commit, push) + agents/, skills/, resource-types/ CRUD
  pg-migrations/  # Postgres schema migrations (applied on boot)
```

All persistence is Postgres (`pg.Pool` in prod, PGlite in tests) via thin repos taking a
`Queryable`; async work runs on in-process pg-boss. No other datastore.

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
knowledge (`knowledge/tools.ts`), kv (`kv/tools.ts` — agent-scoped `kv_get`/`kv_set`/`kv_delete`/`kv_list`).

## Context & streaming

- **System prompt** (`context/assemble.ts`): `assembleSystemPrompt(ctx)` is a pure, synchronous,
  fixed-order block builder — the caller resolves every input (personality, memory, governance
  docs…) and passes it in, so the rendered prefix is deterministic and prompt-cacheable. See
  `context/README.md` for block order and budgets.
- **Durable SSE** (`chat/`): the chat turn streams via an in-memory `StreamHub` (`stream-hub.ts`)
  while persisting each event to the `stream_resume` table (`stream-resume.ts`). Reconnects replay
  from `Last-Event-ID`; `stream-gc.ts` expires old buffers on pg-boss.
- Static business/identity facts (e.g. `soul.yaml`'s `businessName`/`businessDescription`) belong
  in the **system prompt** (`assembleSystemPrompt`), not `memory/` working_memory — don't route
  them through working_memory just because onboarding captured them at runtime.

## Guardrails (`src/guardrails/`)

Three guard stages wrap the chat turn (GR-V1-001/002) — **input** (`chat/routes.ts`, before
`streamText`), **tool-call** (`tools/registry.ts` `buildToolSet` callback, before the approval
gate), **output** (`chat/producer.ts`, buffer-then-scan each assistant text segment). Guards
return `pass | transform | block`, run in array order, first `block` short-circuits, each bounded
by a 5s timeout (timeout/throw → skip-as-pass + log). Input/output blocks emit a `guardrail_block`
SSE event + `finish`; a tool-call block returns a denial the LLM sees (the turn continues).

`GuardrailsService` (`service.ts`) is built from `soul/guardrails.yaml` (validated by
`@tulipfarm/schema` `validateGuardrailsConfig`); an absent **or invalid** config falls back to
`DEFAULT_GUARDRAILS` (`default-policy.ts`) — fail-safe, never unguarded, never crashing. Wired in
`index.ts` (construct → `init` after `buildApp` → `registerGuardrailsReload` on `soul.synced`) and
passed through `AppOptions.guardrailsService`. Built-in guards (`guards/`): `prompt_injection`
(input), `content_filter` (output), `tool_blocklist` (tool-call) — all pattern-only (no LLM). The
config schema lives in `@tulipfarm/schema` (apps/api can't import TypeBox). See
`guardrails/README.md`.
