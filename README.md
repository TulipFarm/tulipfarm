<p align="center">
  <img src="brand/tulipfarm-banner.png" alt="TulipFarm" width="100%" />
</p>

<h1 align="center">TulipFarm</h1>

<p align="center">
  <strong>The business agent harness.</strong><br/>
  Your business' control panel where autonomous agents run your operations.
</p>

## Install (self-host)

One line stands up the full stack (the `app` image + bundled PostgreSQL 17 + pgvector)
with Docker or Podman, generates all secrets, and prints the setup-wizard URL — zero
config questions. Re-running is the upgrade path (preserves `.env` + data).

**Linux / macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/TulipFarm/tulipfarm/main/scripts/get.tulipfarm.sh | sudo bash
```
On Linux with no engine it auto-installs Podman; on macOS install Docker Desktop or
Podman first (the no-VM native lane is not yet available).

**Windows (WSL2)** — from PowerShell:
```powershell
irm https://raw.githubusercontent.com/TulipFarm/tulipfarm/main/scripts/install.ps1 | iex
```
Verifies WSL2 + a distro, then runs the Linux installer inside WSL.

Overrides (env vars): `TF_VERSION` (image tag, default `latest`), `TF_PORT` (default
`8080`), `TF_INSTALL_DIR` (default `/opt/tulipfarm`), `TF_RUNTIME` (`docker`|`podman`),
`TF_BASE_URL`/`TF_REF`. Full guide: see `apps/docs/content/docs/installation.mdx`.

> To install a specific version or branch, set `TF_VERSION=<tag>` or `TF_REF=<branch>` before running the installer. To test a local build, set `TF_LOCAL_SRC=1`.

## Local Development

### Prerequisites

- **Node.js** (see `.node-version`)
- **pnpm** (`npm install -g pnpm`)
- **Homebrew** (for macOS)
- **PostgreSQL 17 + pgvector** (installed and started via the setup script)

### Quick Start

App processes always run **native** in dev (`pnpm dev`, hot reload); Postgres is the
developer's choice (both options satisfy AC-006).

1. **Provision Postgres** — run the setup script:
   ```bash
   bash scripts/setup-dev.sh
   ```
   It **prompts** for how to run Postgres:

   - **Docker** (default) — starts the bundled `pgvector/pgvector:pg17` container (the
     same image CI/prod use), exposed on `localhost:5432`, and wires `DATABASE_URL`
     (with a generated `POSTGRES_PASSWORD` in `.env`) into `.env.local`.
   - **Native** — installs PostgreSQL 17 + pgvector via Homebrew/apt/yum, starts the
     service, and creates the `tulipfarm` database.

   Either way it initializes the soul directory and generates `.env.local` with
   bootstrap secrets. For a non-interactive run, preset the choice:
   ```bash
   DB_MODE=docker bash scripts/setup-dev.sh   # or DB_MODE=native
   ```

2. **Verify the datastore is running:**
   ```bash
   psql tulipfarm -c 'select 1'                       # native
   pg_isready -h localhost -p 5432 -U tulipfarm       # docker
   ```

3. **Install dependencies and start development:**
   ```bash
   pnpm install
   pnpm dev
   ```
   - API will start on `http://localhost:4010` (default, configurable via `PORT` env var)
   - Web UI will start on `http://localhost:4000` (default, configurable via `VITE_PORT` env var)

   **Individual app development:**
   ```bash
   pnpm dev:api   # Run only the API server
   pnpm dev:web   # Run only the Web UI
   ```

4. **Check API health:**
   ```bash
   curl http://localhost:4010/health
   ```

### Environment Setup

The `scripts/setup-dev.sh` script automatically:
- Installs and starts PostgreSQL 17 + pgvector
- Creates the `tulipfarm` database
- Initializes the soul git repository at `~/.tulipfarm/soul` with the required directory structure
- Generates `.env.local` with random bootstrap secrets (`ENCRYPTION_KEY`, `JWT_SECRET`, `WEBHOOK_SIGNING_SECRET`)

**Manual adjustments:** Edit `.env.local` to customize the datastore or add optional variables like `GIT_REMOTE_URL` for syncing soul changes to a remote repository.

### Soul Repository

The soul lives at `~/.tulipfarm/soul` — a git repository that stores your system configuration (resources, routines, agents, skills, integrations). By default, it is local-only. To enable remote sync:

1. Create a private GitHub repository for your soul
2. Add the remote and set `GIT_REMOTE_URL` in `.env.local`:
   ```bash
   git -C ~/.tulipfarm/soul remote add origin https://github.com/your-org/your-soul.git
   git -C ~/.tulipfarm/soul push -u origin main
   ```
3. Update `.env.local`: `GIT_REMOTE_URL=https://github.com/your-org/your-soul.git`

### Stopping Services

To stop PostgreSQL:
```bash
brew services stop postgresql@17                                              # native
docker compose -f docker-compose.yml -f docker-compose.dev.yml down           # docker (keeps data)
```

To stop the dev servers, press `Ctrl+C` in the terminal running `pnpm dev`.

## Commits & Releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org/). They're
enforced in two places: a `commit-msg` git hook (commitlint, via lefthook) locally, and
the **PR Title** check in CI. The commit/PR `type` drives the next version bump.

Releases are cut with [`release-it`](https://github.com/release-it/release-it) +
`@release-it/conventional-changelog` (config in `.release-it.json`): it derives the
version from the commit history, writes `CHANGELOG.md`, bumps `package.json`, commits,
tags `v<version>`, pushes, and creates the GitHub Release. Pushing the `v*` tag triggers
the `publish-image` job in `ci.yml`, which builds and pushes the multi-arch Docker image
to GHCR (`ghcr.io/tulipfarm/app:<version>` + `:latest`) after the `compose-parity` health
gate — so the image ships as a consequence of the release. Two equivalent ways to cut one:

- **CI (recommended):** run the **Release** workflow from the Actions tab
  (`workflow_dispatch`). Optionally choose the bump (`auto`/`patch`/`minor`/`major`) or a
  dry run. For the tag push to trigger image publishing, set a `RELEASE_TOKEN` repo secret
  (a PAT/GitHub App token with `contents: write`) — pushes made with the default
  `GITHUB_TOKEN` do not trigger other workflows.
- **Local:** from a clean `main`, run `pnpm release` (needs a `GITHUB_TOKEN` env var for
  the GitHub Release). Add `--dry-run` to preview, or `patch`/`minor`/`major` to override
  the computed bump.

### Canary / prereleases

To cut a prerelease from any branch, pass the prerelease identifier to
`release:canary`:

```bash
pnpm release:canary alpha   # -> v0.1.0-alpha.0, then v0.1.0-alpha.1, ...
pnpm release:canary beta    # -> v0.1.0-beta.0
```

It runs `release-it --no-git.requireBranch --preRelease <id>`, so it works off
feature branches and marks the GitHub Release as a prerelease. The `v*` tag still
triggers the image publish, but `publish-image` only moves `:latest` for **stable**
tags — prerelease tags (those containing a `-`) publish only
`ghcr.io/tulipfarm/app:<version>`.
