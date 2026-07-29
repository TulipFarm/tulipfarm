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
config questions unless the host port is occupied, in which case it suggests a free port
and asks you to confirm it. Re-running is the upgrade path (preserves secrets + data).

**Linux / macOS:**
```bash
curl -fsSL https://tulipfarm.site/install.sh | sudo bash
```
On Linux with no engine it auto-installs Podman; on macOS install Docker Desktop or
Podman first.

**Windows (WSL2)** — from PowerShell:
```powershell
irm https://tulipfarm.site/install.ps1 | iex
```
Verifies WSL2 + a distro, then runs the Linux installer inside WSL.

Overrides (env vars): `TF_VERSION` (image tag, default `latest`), `TF_PORT` (default
`8080`), `TF_INSTALL_DIR` (default `/opt/tulipfarm`), `TF_RUNTIME` (`docker`|`podman`),
`TF_BASE_URL`/`TF_REF`. Full guide: see `apps/docs/content/docs/installation.mdx`.
An explicit `TF_PORT` also moves an existing install to that host port without rotating
its generated secrets.

> `TF_VERSION=<tag>` pins the app image. The site serves the compose file from the tip of
> `main`; to install an exact ref instead, set
> `TF_BASE_URL=https://raw.githubusercontent.com/TulipFarm/tulipfarm` together with
> `TF_REF=<tag-or-branch>`. To test a local build, set `TF_LOCAL_SRC=1`.

**Compose by hand** (Portainer, Coolify, Dokploy, Unraid, or a plain `docker compose`) —
grab `docker-compose.yml` from <https://tulipfarm.site/docker-compose.yml> and run it
as-is; no `.env` and no key generation are needed.
The app generates its bootstrap secrets on first boot and persists them to the
`tulipfarm-data` volume, so **back that volume up** — it holds the key that decrypts every
secret the instance stores. The bundled database uses the default password `tulipfarm`
(safe only because port 5432 is never published — don't publish it); set
`POSTGRES_PASSWORD` to change it. For TLS, put a reverse proxy in front and set
`PUBLIC_URL` to the external `https://` origin. See the header of `docker-compose.yml` for
every knob.

## Local Development

### Prerequisites

- **Node.js** (see `.node-version`)
- **pnpm** (`npm install -g pnpm`)
- **Docker** (Docker Desktop or Docker Engine, with the Compose v2 plugin)

### Quick Start

Postgres always runs as the bundled `pgvector/pgvector:pg17` container — the same image CI
and production use, so dev cannot drift from the tested path. App processes run on the host
(`pnpm dev`, hot reload).

1. **Provision Postgres** — run the setup script:
   ```bash
   bash scripts/setup-dev.sh
   ```
   It starts the container (exposed on `localhost:5432`, password generated into `.env`),
   wires `DATABASE_URL` into `.env.local`, initializes the soul directory, and generates the
   rest of `.env.local`. No prompts.

2. **Verify the datastore is running:**
   ```bash
   pg_isready -h localhost -p 5432 -U tulipfarm
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
- Starts the bundled PostgreSQL 17 + pgvector container on `localhost:5432`
- Generates `POSTGRES_PASSWORD` into `.env` and points `DATABASE_URL` at the container
- Initializes the soul git repository at `~/.tulipfarm/soul` with the required directory structure
- Generates `.env.local` with random bootstrap env config (`ENCRYPTION_KEY`, `JWT_SECRET`, `WEBHOOK_SIGNING_SECRET`)

**Manual adjustments:** Edit `.env.local` to customize the datastore or add optional variables like `SOUL_GIT_REMOTE_URL` for syncing soul changes to a remote repository.

### Soul Repository

The soul lives at `~/.tulipfarm/soul` — a git repository that stores your system configuration (resources, routines, agents, skills, integrations). By default, it is local-only. To enable remote sync:

1. Create a private GitHub repository for your soul
2. Add the remote and set `SOUL_GIT_REMOTE_URL` in `.env.local`:
   ```bash
   git -C ~/.tulipfarm/soul remote add origin https://github.com/your-org/your-soul.git
   git -C ~/.tulipfarm/soul push -u origin main
   ```
3. Update `.env.local`: `SOUL_GIT_REMOTE_URL=https://github.com/your-org/your-soul.git`

Or configure it from the Settings UI setup wizard, which persists the remote + credential and syncs immediately (no restart needed).

### Testing a marketplace branch (integrations / skills)

The marketplace endpoints clone their source repo per request, so you can point an instance
at any repo **and branch** without code changes — useful for testing an integrations or
skills branch before merging it to main:

```bash
# integrations marketplace (default: tulipfarm/integrations, remote default branch)
INTEGRATIONS_MARKETPLACE_SOURCE=tulipfarm/integrations#my-feature-branch

# skills marketplace (default: tulipfarm/skills)
MARKETPLACE_SOURCE=tulipfarm/skills#my-feature-branch
```

Accepted forms: `owner/repo`, `owner/repo#branch-or-tag`, a full `https://` git URL (also with
`#ref`), or `file:///abs/path` for a local checkout. Set in `.env.local` for local dev; on a
hosted instance (e.g. Azure App Service) set the app setting and restart:

```bash
az webapp config appsettings set -n <app> -g <rg> \
  --settings INTEGRATIONS_MARKETPLACE_SOURCE=tulipfarm/integrations#my-feature-branch
```

Installs record provenance (source URL + resolved commit SHA + content hash) in
`integrations-lock.json` / `skills-lock.json`; the marketplace shows **Update** when the
locked hash differs from the source's current content — reinstalling from a branch and later
from main both flow through the same update path.

### Updating TulipFarm (self-host)

Releases publish the image `ghcr.io/tulipfarm/tulipfarm:v<version>` (+ `:latest` for stable).
Updates are always **manual** (no auto-update by design):

- **OCI lane (installer):** re-run the install command — it preserves `.env` and the Postgres
  volume, pulls the pinned `TULIPFARM_VERSION` (default `latest`), and restarts.
- **Compose by hand:** `docker compose pull && docker compose up -d`.
- **Azure App Service (sitecontainer on `:latest`):** `az webapp restart -n <app> -g <rg>` —
  the restart pulls the newest image.
- **Pinned installs:** bump `TULIPFARM_VERSION` in `.env`, then pull + up.

**Database migrations run automatically on boot** — pulling a new image applies pending
schema migrations before the API starts serving. The corollaries:

- There are **no down-migrations**: rolling back to an older image after a migration ran
  requires restoring a database backup, not just repointing the image tag.
- A failed boot migration restart-loops the app — fix forward (patched release) or restore.
- **Back up before updating**: `pg_dump` the database (or rely on your managed Postgres
  point-in-time restore) so a bad update is a restore away from recovery.

Installed **integrations and skills** update independently of the app: the marketplace pages
show an **Update** button when the source repo has newer content (lock-hash comparison).
Updating a connected integration restarts its MCP server automatically.

### Stopping Services

To stop PostgreSQL (keeps the data volume):
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

To stop the dev servers, press `Ctrl+C` in the terminal running `pnpm dev`.

## Commits & Releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org/). They're
enforced in two places: a `commit-msg` git hook (commitlint, via lefthook) locally, and
the **PR Title** check in CI. The commit/PR `type` drives the next version bump.

Releases use a release PR and a gated publication pipeline. A maintainer requests an exact
version:

```bash
pnpm release 0.5.0
```

The command dispatches **Prepare release**, which opens a PR containing only the generated
`package.json` and `CHANGELOG.md` changes. Merging that PR automatically validates the merge
commit, builds one immutable multi-architecture candidate image, runs Compose parity against that
exact image, promotes it to `v<version>` and `latest`, and creates the Git tag and GitHub Release.
The GitHub Release is created last; no post-merge command or approval is required.

See [docs/RELEASES.md](docs/RELEASES.md) for setup, retry semantics, and the complete release
contract.

### Canary / prereleases

Prereleases use the same release-PR and verification path. Pass the complete version:

```bash
pnpm release:canary 0.5.0-alpha.0
pnpm release:canary 0.5.0-beta.0
```

They are marked as prereleases on GitHub and publish `ghcr.io/tulipfarm/tulipfarm:v<version>`
without moving `latest`.
