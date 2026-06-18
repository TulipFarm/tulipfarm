<p align="center">
  <img src="brand/tulipfarm-banner.png" alt="TulipFarm" width="100%" />
</p>

<h1 align="center">TulipFarm</h1>

<p align="center">
  <strong>The business agent harness.</strong><br/>
  Your business' control panel where autonomous agents run your operations.
</p>

## Local Development

### Prerequisites

- **Node.js** (see `.node-version`)
- **pnpm** (`npm install -g pnpm`)
- **Homebrew** (for macOS)
- **PostgreSQL 17 + pgvector** (installed and started via the setup script)

### Quick Start

App processes always run **native** in dev (`pnpm dev`, hot reload); Postgres is the
developer's choice. Pick one of the two datastore options below (both satisfy AC-006).

1. **Provision Postgres** — choose one:

   **Option A — native Postgres (Homebrew/apt):**
   ```bash
   bash scripts/setup-dev.sh
   ```
   Installs PostgreSQL 17 + pgvector, starts the service, creates the `tulipfarm`
   database and the soul directory, and generates `.env.local` with bootstrap secrets.

   **Option B — bundled Postgres via Docker Compose** (same `pgvector/pgvector:pg17`
   image CI tests; nothing else from the stack runs):
   ```bash
   cp .env.example .env   # provides POSTGRES_PASSWORD for the container
   docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile bundled up -d postgres
   ```
   Then set the datastore URL in `.env.local` (the dev override exposes Postgres on
   `localhost:5432`):
   ```bash
   DATABASE_URL=postgresql://tulipfarm:<POSTGRES_PASSWORD>@localhost:5432/tulipfarm
   ```
   (`<POSTGRES_PASSWORD>` is the value from the `.env` you just copied.)

2. **Verify the datastore is running:**
   ```bash
   psql tulipfarm -c 'select 1'                       # Option A
   pg_isready -h localhost -p 5432 -U tulipfarm       # Option B
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
- Initializes a local `./soul` git repository with the required directory structure
- Generates `.env.local` with random bootstrap secrets (`ENCRYPTION_KEY`, `JWT_SECRET`, `WEBHOOK_SIGNING_SECRET`)

**Manual adjustments:** Edit `.env.local` to customize the datastore or add optional variables like `GIT_REMOTE_URL` for syncing soul changes to a remote repository.

### Soul Repository

The `./soul` directory is a local git repository that stores your system configuration (resources, routines, agents, skills, integrations). By default, it is local-only. To enable remote sync:

1. Create a private GitHub repository for your soul
2. Add the remote and set `GIT_REMOTE_URL` in `.env.local`:
   ```bash
   cd soul
   git remote add origin https://github.com/your-org/your-soul.git
   git push -u origin main
   ```
3. Update `.env.local`: `GIT_REMOTE_URL=https://github.com/your-org/your-soul.git`

### Stopping Services

To stop PostgreSQL:
```bash
brew services stop postgresql@17                                              # Option A
docker compose -f docker-compose.yml -f docker-compose.dev.yml down           # Option B (keeps data)
```

To stop the dev servers, press `Ctrl+C` in the terminal running `pnpm dev`.
