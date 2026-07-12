# Soul — Agent Conventions

`@tulipfarm/soul` — loads "soul" artifacts from a local directory and keeps them synced with a
git remote. Implements `specs/SOUL.md`. See root `AGENTS.md` for commands/lint.

> The runtime `soul/` directory at the repo root is a **separate git repo** (created by
> `scripts/setup-dev.sh`). This package is the loader/sync *engine* — don't write package code
> into that data repo.

## Public API (`src/index.ts`)

- **`SoulLoader`** — reads artifacts from disk into in-memory maps; `load()` / reload. Root YAML
  configs are exposed as fields: `llmConfig` (from `soul.yaml`'s nested `llm:` key),
  `guardrailsConfig`, `manifest` (the full parsed `soul.yaml`).
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
integrations/<name>/config.yaml
soul.yaml   guardrails.yaml   # repo-root manifests (optional); soul.yaml's `llm:` key holds LLM config
```

Resource schemas are checked with `validateResourceSchema` (`@tulipfarm/schema`) on load.
Parsing is fault-tolerant: a bad file is logged and skipped, and the loader stays up.

## File map

- `soul-loader.ts` — the `load*` readers + frontmatter parsing + hook-hash tracking; `llmConfig` is
  derived from `manifest.llm` after `soul.yaml` loads (not a separate file read).
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
pull/commit/push divergence cases. In route tests that touch soul git config, spy on
`GitSyncService.prototype.configureRemote`/`getStatus` (don't hit real git), and use
`soulConfigFs.readFile`/`writeFile` (not raw `node:fs`).

## Git-sync gotchas

- Remote/credential env vars are `SOUL_GIT_REMOTE_URL` / `SOUL_GIT_CREDENTIAL` (soul-scoped,
  matches `SOUL_PATH`) — not `GIT_REMOTE_URL`/`GIT_CREDENTIALS`. Watch for stale references when
  touching `.env.local.example`, `specs/SOUL.md`, `specs/INSTALLATION.md`, docs mdx, or secret keys.
- `GitSyncService` reads its remote from env at boot; a remote set later via Settings → Soul UI
  persists to `soul.yaml` + a secret — boot must also read that persisted config, or the UI-set
  remote is silently dropped on restart.
- `bootSync()` must never throw (a bad/stale remote in `soul.yaml` previously crash-looped the
  server on boot) — but `configureRemote()` (backs `PUT /soul/git-config`) must keep throwing so
  the route can 400 on bad credentials. Fix boot-time resilience at the boot call site, not by
  swallowing errors inside the shared methods.
- Auth is HTTPS-only: `authUrl()` in `git-sync.ts` injects `SOUL_GIT_CREDENTIAL` (a PAT) as
  `https://<token>@host/...`. No SSH keygen/agent support — an SSH remote URL will fail.
- Soul-repo commits are always authored as `BOT_GIT_NAME`/`BOT_GIT_EMAIL` (`tulipfarm-bot`),
  regardless of whose PAT authenticates the push.
