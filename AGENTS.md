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
pnpm lint               # biome check across all workspaces
pnpm typecheck          # tsc --noEmit across all workspaces
pnpm test               # vitest run
pnpm build              # turbo build
pnpm reset:dev          # wipe local db + soul, then re-run setup (clean slate)
```

Single workspace: `pnpm --filter @tulipfarm/api <script>`.

## Before marking work done

For changes that affect code or build inputs, run all three — CI runs the same and blocks merge:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Tests use **Vitest** (`*.test.ts` colocated with source). `pnpm test` passes with no tests (`--passWithNoTests`).

### Documentation-only changes

When the diff contains only documentation, do not run `pnpm lint`, `pnpm typecheck`, `pnpm test`,
or `pnpm build`. Run only targeted documentation checks needed for the changed files, such as link,
formatting, example, or task-specific contract checks. Explicit task instructions override this
exception.

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
