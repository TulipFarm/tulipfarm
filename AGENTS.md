# AGENTS.md

Guidance for AI coding agents working in this repo. Read before editing.

> **Terminology is binding.** Use the canonical names in
> [`metadata/terminologies.md`](metadata/terminologies.md) for every concept, at
> every layer (code, DB, REST, URL, UI, docs). When unsure what to call something,
> that file decides — it also lists banned/retired synonyms and the rename backlog.

## What this is

TulipFarm — AI-native business operating system. pnpm + Turborepo monorepo.

- **Node**: `26.5.0` (see `.node-version`) · **Package manager**: `pnpm@11.5.3` (never use npm/yarn)
- **Workspaces**: `apps/*`, `packages/*`

## Layout

| Path | What |
| --- | --- |
| [`apps/api`](apps/api/AGENTS.md) | Fastify API server. PostgreSQL (pgvector + pg-boss), migration-on-boot, soul git store. |
| [`apps/web`](apps/web/AGENTS.md) | Remix + React web UI. |
| [`apps/docs`](apps/docs/AGENTS.md) | Fumadocs public documentation site (static export). Prompt-first docs conventions. |
| [`apps/worker`](apps/worker/AGENTS.md) | Durable Run dispatch, Agent/Tool States, timers, reconciliation, projections. |
| [`apps/integration-worker`](apps/integration-worker/AGENTS.md) | Integration ingress, sync, delivery, retries, reconciliation. |
| [`packages/llm`](packages/llm/AGENTS.md) | LLM provider abstraction + tiered fallback chains (`@tulipfarm/llm`). |
| [`packages/soul`](packages/soul/AGENTS.md) | Soul artifact loader + git sync (`@tulipfarm/soul`). |
| [`packages/secrets`](packages/secrets/AGENTS.md) | Encrypted secret storage + key rotation (`@tulipfarm/secrets`). |
| [`packages/schema`](packages/schema/AGENTS.md) | Config schemas (LLM, guardrails, agent, resource) + validators + resource transforms (`@tulipfarm/schema`). |
| [`packages/authz`](packages/authz/AGENTS.md) | Principals, roles, grants, authority intersection, policy evidence (`@tulipfarm/authz`). |
| [`packages/audit`](packages/audit/AGENTS.md) | Audit events, hash chaining, sealing/export/retention, lineage (`@tulipfarm/audit`). |
| [`packages/run-kernel`](packages/run-kernel/AGENTS.md) | Run/State state machines, waits, retries, child Runs (`@tulipfarm/run-kernel`). |
| [`packages/tool-broker`](packages/tool-broker/AGENTS.md) | Tool catalog, intent/effect orchestration, approvals, reconciliation (`@tulipfarm/tool-broker`). |
| [`packages/agent-runtime`](packages/agent-runtime/AGENTS.md) | Context assembly, bounded Tool loop, model profiles, delegation (`@tulipfarm/agent-runtime`). |
| [`packages/knowledge`](packages/knowledge/AGENTS.md) | ACL-preserving source ingestion, retrieval, provenance (`@tulipfarm/knowledge`). |
| [`packages/memory`](packages/memory/AGENTS.md) | Scoped, versioned memory assertions and supersession (`@tulipfarm/memory`). |
| [`packages/surface`](packages/surface/AGENTS.md) | Tulip Surface Protocol contracts, catalog, Artifacts, interactions, linting, and renderer interfaces (`@tulipfarm/surface`). |
| [`packages/surface-web`](packages/surface-web/AGENTS.md) | Native trusted React renderer (`@tulipfarm/surface-web`). |
| `packages/surface-slack` | Native Slack Block Kit renderer (`@tulipfarm/surface-slack`). |
| `packages/surface-telegram` | Native Telegram message renderer (`@tulipfarm/surface-telegram`). |
| `packages/surface-github` | Native GitHub comment and Check Run renderer (`@tulipfarm/surface-github`). |
| [`packages/integrations`](packages/integrations/AGENTS.md) | Integration adapter contracts, event normalization, identity mapping (`@tulipfarm/integrations`). |
| [`packages/sandbox`](packages/sandbox/AGENTS.md) | Isolated execution request contract and backend ports (`@tulipfarm/sandbox`). |
| [`packages/storage`](packages/storage/AGENTS.md) | PostgreSQL repositories, outbox/inbox, blob/vector/cache ports (`@tulipfarm/storage`). |
| [`packages/observability`](packages/observability/AGENTS.md) | OTel conventions, metrics, health/readiness, redaction (`@tulipfarm/observability`). |
| [`packages/ui`](packages/ui/AGENTS.md) | Shared React components (`@tulipfarm/ui`). |
| [`packages/types`](packages/types/AGENTS.md) | Shared TypeScript types (`@tulipfarm/types`). |
| [`packages/utils`](packages/utils/AGENTS.md) | Shared utilities (`@tulipfarm/utils`). |
| [`packages/constants`](packages/constants/AGENTS.md) | Shared env-aware constants (`@tulipfarm/constants`). |
| [`packages/tsconfig`](packages/tsconfig/AGENTS.md) | Shared `tsconfig` bases (`@tulipfarm/tsconfig`). |
| `soul/` | Separate git repo created by `setup-dev.sh` (not part of this monorepo): resources, routines, agents, skills, integrations. |
| `scripts/setup-dev.sh` | Bootstraps PostgreSQL + pgvector + soul + `.env.local`. |

Each app and package has its own `AGENTS.md` with local conventions — read the nearest one.

## Commands

Run from repo root. Turbo fans out across workspaces.

```bash
pnpm install            # frozen install in CI: pnpm install --frozen-lockfile
pnpm dev                # api :4010, web :4000, worker :4020 (durable Run dispatch), integration-worker :4030 (Slack/Telegram ingress)
pnpm dev:api            # api only
pnpm dev:web            # web only
pnpm dev:worker         # worker only
pnpm dev:integration-worker # integration-worker only
pnpm dev:docs           # docs site on :4020 — same port as worker; do not run both at once
pnpm lint               # biome check across all workspaces (turbo-cached, ~1s warm)
pnpm typecheck          # tsc --noEmit across all workspaces (turbo-cached)
pnpm test               # vitest run — UNCACHED and ~5min+; prefer --filter, see "Verifying your work"
pnpm build              # turbo build
pnpm reset:dev          # wipe local db + soul, then re-run setup (clean slate)
```

Single workspace: `pnpm --filter @tulipfarm/api <script>`. **Default to this for `test` and
`typecheck`** — see [Verifying your work](#verifying-your-work) for what each scope costs.

## Verifying your work

**Match the check to the blast radius of the diff.** Re-running the whole gate after every edit is
the most expensive habit in this repo: the full suite costs minutes, while the loop below costs
seconds. Escalate through the tiers — reach Tier 3 once, at the end, not after each change.

Tests use **Vitest** (`*.test.ts` colocated with source). Most workspaces pass with no tests
(`--passWithNoTests`).

### Tier 1 — after every edit (~1s)

Biome on the paths you touched. Nothing else.

```bash
pnpm exec biome check --write apps/web/app/components/chat
```

### Tier 2 — after a coherent unit of work (~5-15s)

Typecheck and test **only the workspaces you changed**, narrowed to the affected files. A bare
positional arg to `vitest run` is a path filter.

```bash
pnpm --filter @tulipfarm/web typecheck
pnpm --filter @tulipfarm/web test app/components/chat
```

**This is the loop you should be in almost all of the time.** When unsure of coverage, widen the
path filter before widening the workspace filter.

### Tier 3 — once, before handing work back or opening a PR

```bash
pnpm lint && pnpm typecheck                     # turbo-cached, seconds on repeat
pnpm --filter @tulipfarm/web test               # repeat --filter per touched workspace
```

Run bare `pnpm test` **only** when the change is genuinely repo-wide — a shared export in
`packages/*` consumed everywhere, `turbo.json`, `biome.json`, a `tsconfig` base, or a root
dependency bump. For everything else it is pure waiting.

### What each check actually costs

Measured on this repo, warm install, idle machine. Use it to reason before you spend.

| Command | Scope | Cost |
| --- | --- | --- |
| `pnpm exec biome check <dir>` | changed dir | **0.7s** |
| `pnpm lint` (cache hit) | 31 workspaces | **0.1s** |
| `pnpm typecheck` (cache hit) | 31 workspaces | **1.7s** |
| `pnpm --filter @tulipfarm/web test <path>` | 13 files | **2.1s** |
| `pnpm --filter @tulipfarm/web typecheck` | 1 workspace | **4.8s** |
| `pnpm --filter @tulipfarm/web test` | 90 files | **8.0s** |
| `pnpm typecheck` (cold) | 31 workspaces | **13s** |
| `pnpm --filter @tulipfarm/api test` | 229 files | **71s** |
| `pnpm --filter @tulipfarm/integration-worker test` | 20 files | **75s** |
| `pnpm --filter @tulipfarm/worker test` | 44 files | **141s** |
| `pnpm test` (root) | 30 workspaces | **~5min idle, far worse under load** |

`lint` and `typecheck` are turbo-cached and only re-run the workspaces whose files changed —
invalidation does **not** cascade to dependents, so a one-package edit costs well under a second.
That is why Tier 3 keeps them but not `pnpm test`.

Two things drive that last row, and neither improves by re-running:

- **`test` is `cache: false` in `turbo.json`, and that is correct — do not "optimise" it.** Every
  package is consumed straight from source (`main: src/index.ts`; no package has a `build` script),
  so there is no build artifact for a `dependsOn: ["^build"]` edge to hang on. The only edge that
  would carry a dependency's source hash into a dependent's test hash is `dependsOn: ["^test"]`,
  which would force every filtered run to walk the whole dependency graph first — penalising the
  Tier 2 loop that should be the common case. Caching `test` without such an edge is worse than
  useless: a change in `packages/*` would leave dependents' caches valid and hand you a green run
  that never executed. So a root `pnpm test` is always ~30 cold `vitest` processes. Scope it
  instead.
- **`worker`, `integration-worker` and `api` are ~93% of the total.** `worker` alone is 141s of
  genuine waiting — it spawns real child processes and drives timers, not compile overhead
  (transform is only 5.9s of it). If you did not touch those three, running them buys nothing.

### CI does not run what Tier 3 runs

Do not justify a local full-suite run with "CI runs the same" — it does not. `ci.yml` computes a
changed-paths filter (`code` / `docs` / `non_docs`), skips unit tests entirely for markdown-only
diffs, excludes `@tulipfarm/docs` from lint and typecheck, and splits tests into **parallel** jobs
with the api suite sharded across a matrix. A serial root `pnpm test` is strictly slower than CI and
tells you nothing extra.

### Before believing a failure

A failing suite is not automatically a regression. Check, in this order:

1. **Re-run that suite alone.** Vitest hook timeouts (default 10s) fire spuriously when many
   workspaces run in parallel on a loaded machine. Suites that time out under `turbo test` routinely
   pass standalone in under 2s.
2. **Check for local-only env leakage.** `apps/worker/.env.local` is a gitignored symlink to the
   repo-root env file. `apps/worker/test/process/**` spawns a real worker that calls
   `loadEnv({ path: ".env.local" })`, so your dev `TF_DATA_DIR` can reach a child process that CI
   would never give one. Move the symlink aside to reproduce CI conditions.
3. **Only then** treat it as yours — confirm by stashing your diff and re-running.

### Documentation-only changes

When the diff contains only documentation, do not run `pnpm lint`, `pnpm typecheck`, `pnpm test`,
or `pnpm build`. Run only targeted documentation checks needed for the changed files, such as link,
formatting, example, or task-specific contract checks. Explicit task instructions override this
exception.

### Do not

- Re-run a tier after an edit that cannot change its result (comments, markdown, a `console.log`).
- Run `pnpm build` unless you changed build config or need `dist/` output — `typecheck` already
  catches type errors and is far cheaper.
- Batch a full gate into a "just to be safe" habit. Safety comes from the *right* check, not more of
  them; an unnecessary 5-minute suite is 5 minutes not spent reading the failure you already have.

## Lint / format — Biome (read this to avoid churn)

Single source of truth: `biome.json` (Biome 2.4.16). **No ESLint, no Prettier.** Do not add them.

Auto-fix before hand-fixing:

```bash
pnpm exec biome check --write .       # lint + format + organize imports
pnpm exec biome check .               # check only, no writes
```

`pre-commit` hook (lefthook → lint-staged) runs `biome check --write` on staged files. Write code that already conforms so the hook is a no-op.

### Formatting rules (match exactly)

- **Indent**: 2 spaces (not tabs)
- **Line width**: 100 — wrap before it
- **Quotes**: double `"`
- **Semicolons**: always
- **Trailing commas**: `es5` (arrays/objects yes, function args no)
- **Imports**: auto-organized/sorted — don't hand-order; let Biome sort

### Lint rules — common trip-ups

Config is `recommended: true` only. **Verified to fire** under it (these bite agents most — write to satisfy up front):

- **No `any`** (`noExplicitAny`) — type it, or use `unknown` + narrowing.
- **No non-null `!` assertions** (`noNonNullAssertion`) — narrow instead.
- **`const` over `let`** (`useConst`) when never reassigned.
- **Template literals** over string concat (`useTemplate`).
- **`import type`** for type-only imports (`useImportType`) — Biome auto-fixes; write it anyway.
- Recommended set also covers: no unreachable code, no fallthrough `switch`, self-closing JSX, list `key` (web).

**NOT enabled** (recommended set does not include them, so lint won't flag — but still good practice): `noUnusedImports`, `noUnusedVariables`, `noConsole`. Remove dead imports/vars you create regardless; prefer the app logger over `console`.

If a rule genuinely must be broken, add a scoped suppression on the line — never disable the rule globally:

```ts
// biome-ignore lint/suspicious/noExplicitAny: <reason>
```

## Conventions

- **TypeScript everywhere.** Extend shared config from `@tulipfarm/tsconfig`.
- **Surgical edits** — touch only what the task needs; don't reformat or refactor adjacent code.
- **No new deps** without need; check `package.json` for existing ones first.
- Migrations: `apps/api/src/migrations/` run on boot — add new ones there.
- Env: copy `.env.local.example` → `.env.local`; never commit secrets.

### Product testing must use product surfaces

- For manual, acceptance, or end-to-end testing of Soul-backed behavior, create and update Soul
  artifacts exclusively through the agentic Chat or the supported UI.
- Never prepare a test by directly creating or editing YAML, Markdown, or configuration files in
  the runtime `soul/` repository. This includes shell redirects, patches, scripts, and copied
  fixtures for Resources, Routines, Agents, Skills, or Integrations.
- Exercise the same Chat/UI path a user would take. If that path cannot create the required test
  state, treat it as a product gap instead of bypassing it with a direct Soul filesystem write.
- Isolated automated unit/integration fixtures outside the runtime `soul/` repository remain
  allowed; this rule governs product-flow setup against the real Soul repository.

### Manual QA against the real dev environment must use the UI, not curl

- When manually verifying a feature against the running dev API/web servers (real dev DB, not a
  test fixture), drive it through the actual product surface — the web UI (use the Chrome browser
  tools if the user is signed in there) — not `curl`/raw HTTP calls.
- This matches the product-testing rule above: exercise the same path a real user would take.
  Automated tests (Vitest, Fastify `inject`) may still call routes directly — this rule is about
  manual/exploratory QA against the live dev environment specifically.
- Reserve `curl` against the dev API for documented credential/setup flows already spelled out
  above (e.g. the login example under "Test with curl"), not for feature QA.

## API route schemas (OpenAPI)

Every Fastify route **must** have a `schema` option. The spec at `/api/v1/openapi.json` is auto-generated from these schemas — no schema means the endpoint is invisible in docs.

When adding or modifying a route:

1. Add/update the `schema` object on the route with `description`, `tags`, `body`/`params`/`querystring`, and `response` (all status codes the handler can return).
2. If the response shape is shared across routes, define it in `apps/api/src/auth/schemas.ts` (or a domain-level `schemas.ts` for future domains) and import it — don't inline duplicate schemas.
3. Protected routes must include `security: [{ sessionCookie: [] }, { bearerToken: [] }]`.
4. Verify the spec is updated: `curl http://localhost:4010/api/v1/openapi.json | jq '.paths'` should include the new/changed path.

## Local Dev Credentials

No admin is auto-seeded on plain `pnpm dev` — `bootstrapFromEnv` (`apps/api/src/setup/bootstrap.ts`)
is a no-op unless `ADMIN_EMAIL` + `ADMIN_PASSWORD` are set, and `bootstrapAdmin`
(`apps/api/src/auth/users/index.ts`, the dev-default `admin@tulipfarm.dev`/`password123` seeder) is
exported but never called from `index.ts` — its "sign-in-ready with zero setup" comment does not
reflect current wiring. On first boot with no users, the web app falls through to the `/setup`
wizard (`apps/web/app/routes/setup.tsx`) — create the admin account there.

To headless-seed a known admin instead, set `ADMIN_EMAIL` + `ADMIN_PASSWORD` (+ `LLM_API_KEY` for
the full headless seed) before starting the API — see `apps/api/src/setup/bootstrap.ts`.

### Start API

```bash
pnpm --filter @tulipfarm/api dev
```

### Test with curl

```bash
# Login + save cookie (after creating the admin via the /setup wizard, or headless-seeding one)
curl -c /tmp/tulip.txt -X POST http://localhost:4010/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<your-admin-email>","password":"<your-admin-password>"}'

# Authenticated requests
curl -b /tmp/tulip.txt "http://localhost:4010/api/v1/auth/tokens"
curl -b /tmp/tulip.txt "http://localhost:4010/api/v1/auth/tokens?limit=2"
curl -b /tmp/tulip.txt "http://localhost:4010/api/v1/auth/tokens?limit=2&cursor=<nextCursor>"
```

## Git

- Never `git commit` unless explicitly asked.
- Work on the current branch.
- PR titles must follow Conventional Commits (CI-enforced): `type(scope): subject` — type ∈ `feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert` (e.g. `feat(approvals): add live badge`).

### Commit message convention

- Follow Conventional Commits: `type(scope): subject` — same type set as PR titles.
- Subject: imperative mood, no trailing period, under ~72 chars.
- Body (optional): explain *why*, not what — the diff already shows what changed.
- One logical change per commit; don't bundle unrelated fixes.

### PR description guidelines

- Title: Conventional Commits format, matches the commit convention above.
- Summary: 1-3 bullets on what changed and why — link the driving issue/ticket if one exists.
- Test plan: bulleted checklist of how the change was verified (commands run, manual steps, screenshots for UI).
- Keep it scoped to the diff — no unrelated context dumps.
