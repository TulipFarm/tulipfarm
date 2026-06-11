# Soul — Agent Conventions

`@tulipfarm/soul` — loads "soul" artifacts from a local directory and keeps them synced with a
git remote. Implements `specs/SOUL.md`. See root `AGENTS.md` for commands/lint.

> The runtime `soul/` directory at the repo root is a **separate git repo** (created by
> `scripts/setup-dev.sh`). This package is the loader/sync *engine* — don't write package code
> into that data repo.

## Public API (`src/index.ts`)

- **`SoulLoader`** — reads artifacts from disk into in-memory maps; `load()` / reload. Root YAML
  configs are exposed as fields: `llmConfig`, `guardrailsConfig`, `manifest`.
- **`GitSyncService`** — `bootSync`, `pull`, `commit`, `push`, `withSync(message)` (commit +
  best-effort push around a write — used by the API's soul-backed tools), periodic sync.
- **`runSoulMigrations()`** + type `SoulMigration`.
- Types: `SoulAgent`, `SoulSkill`, `SoulResource`, `SoulRoutine`, `SoulIntegration`.

## On-disk layout (what `SoulLoader` reads)

```
agents/<name>/AGENT.md            # markdown + optional YAML frontmatter
skills/<name>/SKILL.md
resources/<name>/schema.yml       # + optional hooks.ts (SHA256-hashed for integrity)
routines/<name>/routine.yaml      # + optional hooks.ts
integrations/<name>/connection.yaml
llm.config.yaml   soul.yaml   guardrails.yaml   # repo-root manifests (optional)
```

Resource schemas are checked with `validateResourceSchema` (`@tulipfarm/validation`) on load.
Parsing is fault-tolerant: a bad file is logged and skipped, and the loader stays up.

## File map

- `soul-loader.ts` — the five `load*` readers + frontmatter parsing + hook-hash tracking.
- `git-sync.ts` — sync engine. Divergence rule (SOUL-V1-004): upstream wins on genuine
  divergence, but **un-pushed local commits are preserved** (retry push, don't blind-reset).
  Commits use `BOT_GIT_NAME` / `BOT_GIT_EMAIL` from `@tulipfarm/constants`.
- `migrations/index.ts` — the `SOUL_MIGRATIONS` array; `soul-migrations.ts` runs pending ones.

## How to extend

- **New artifact type:** add a `load<Type>` reader (read its subdir, parse, validate), store it
  in a map, and export its interface from `types.ts`.
- **New migration:** append to `SOUL_MIGRATIONS` with a monotonic `version`, a `description`, and
  an async `up(soulPath)`.

## Tests

Vitest, colocated. Mock `node:fs` / `simple-git`; cover loader degradation and the
pull/commit/push divergence cases.
