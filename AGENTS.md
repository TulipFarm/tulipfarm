# AGENTS.md

Guidance for AI coding agents working in this repo. Read before editing.

## What this is

TulipFarm — AI-native business operating system. pnpm + Turborepo monorepo.

- **Node**: see `.node-version` · **Package manager**: `pnpm@11.1.3` (never use npm/yarn)
- **Workspaces**: `apps/*`, `packages/*`

## Layout

| Path                   | What                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `apps/api`             | Fastify API server. MongoDB, migration-on-boot, soul git store.                           |
| `apps/web`             | Web UI.                                                                                   |
| `packages/tsconfig`    | Shared `tsconfig` bases (`@tulipfarm/tsconfig`).                                          |
| `packages/types`       | Shared TypeScript types.                                                                  |
| `packages/ui`          | Shared UI components.                                                                     |
| `packages/utils`       | Shared utilities.                                                                         |
| `soul/`                | Local git repo holding system config (resources, routines, agents, skills, integrations). |
| `scripts/setup-dev.sh` | Bootstraps MongoDB + Redis + soul + `.env.local`.                                         |

## Commands

Run from repo root. Turbo fans out across workspaces.

```bash
pnpm install            # frozen install in CI: pnpm install --frozen-lockfile
pnpm dev                # api on :4001, web on :4000
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

## Git

- Never `git commit` unless explicitly asked.
- Work on the current branch.
