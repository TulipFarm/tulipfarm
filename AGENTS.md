# AGENTS.md

Guidance for AI coding agents working in this repo. Read before editing.

## What this is

TulipFarm — AI-native business operating system. pnpm + Turborepo monorepo.

- **Node**: see `.node-version` · **Package manager**: `pnpm@11.1.3` (never use npm/yarn)
- **Workspaces**: `apps/*`, `packages/*`

## Layout

| Path | What |
| --- | --- |
| [`apps/api`](apps/api/AGENTS.md) | Fastify API server. MongoDB, migration-on-boot, soul git store. |
| [`apps/web`](apps/web/AGENTS.md) | Remix + React web UI. |
| [`packages/llm`](packages/llm/AGENTS.md) | LLM provider abstraction + tiered fallback chains (`@tulipfarm/llm`). |
| [`packages/soul`](packages/soul/AGENTS.md) | Soul artifact loader + git sync (`@tulipfarm/soul`). |
| [`packages/secrets`](packages/secrets/AGENTS.md) | Encrypted secret storage + key rotation (`@tulipfarm/secrets`). |
| [`packages/validation`](packages/validation/AGENTS.md) | Schema validation + resource transforms (`@tulipfarm/validation`). |
| [`packages/ui`](packages/ui/AGENTS.md) | Shared React components (`@tulipfarm/ui`). |
| [`packages/types`](packages/types/AGENTS.md) | Shared TypeScript types (`@tulipfarm/types`). |
| [`packages/utils`](packages/utils/AGENTS.md) | Shared utilities (`@tulipfarm/utils`). |
| [`packages/constants`](packages/constants/AGENTS.md) | Shared env-aware constants (`@tulipfarm/constants`). |
| [`packages/tsconfig`](packages/tsconfig/AGENTS.md) | Shared `tsconfig` bases (`@tulipfarm/tsconfig`). |
| `soul/` | Separate git repo created by `setup-dev.sh` (not part of this monorepo): resources, routines, agents, skills, integrations. |
| `scripts/setup-dev.sh` | Bootstraps MongoDB + Redis + soul + `.env.local`. |

Each app and package has its own `AGENTS.md` with local conventions — read the nearest one.

## Commands

Run from repo root. Turbo fans out across workspaces.

```bash
pnpm install            # frozen install in CI: pnpm install --frozen-lockfile
pnpm dev                # api on :4010, web on :4000
pnpm dev:api            # api only
pnpm dev:web            # web only
pnpm lint               # biome check across all workspaces
pnpm typecheck          # tsc --noEmit across all workspaces
pnpm test               # vitest run
pnpm build              # turbo build
```

Single workspace: `pnpm --filter @tulipfarm/api <script>`.

## Before marking work done

Run all three — CI runs the same and blocks merge:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Tests use **Vitest** (`*.test.ts` colocated with source). `pnpm test` passes with no tests (`--passWithNoTests`).

## Lint / format — Biome (read this to avoid churn)

Single source of truth: `biome.json` (Biome 1.9.4). **No ESLint, no Prettier.** Do not add them.

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

## API route schemas (OpenAPI)

Every Fastify route **must** have a `schema` option. The spec at `/api/v1/openapi.json` is auto-generated from these schemas — no schema means the endpoint is invisible in docs.

When adding or modifying a route:

1. Add/update the `schema` object on the route with `description`, `tags`, `body`/`params`/`querystring`, and `response` (all status codes the handler can return).
2. If the response shape is shared across routes, define it in `apps/api/src/auth/schemas.ts` (or a domain-level `schemas.ts` for future domains) and import it — don't inline duplicate schemas.
3. Protected routes must include `security: [{ sessionCookie: [] }, { bearerToken: [] }]`.
4. Verify the spec is updated: `curl http://localhost:4010/api/v1/openapi.json | jq '.paths'` should include the new/changed path.

## Local Dev Credentials

Default seed credentials for local dev (used by `scripts/setup-dev.sh`):

- **Email**: `admin@example.com`
- **Password**: `mypassword`

### Start API

```bash
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=mypassword pnpm --filter @tulipfarm/api dev
```

### Test with curl

```bash
# Login + save cookie
curl -c /tmp/tulip.txt -X POST http://localhost:4010/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"mypassword"}'

# Authenticated requests
curl -b /tmp/tulip.txt "http://localhost:4010/api/v1/auth/tokens"
curl -b /tmp/tulip.txt "http://localhost:4010/api/v1/auth/tokens?limit=2"
curl -b /tmp/tulip.txt "http://localhost:4010/api/v1/auth/tokens?limit=2&cursor=<nextCursor>"
```

## Git

- Never `git commit` unless explicitly asked.
- Work on the current branch.
