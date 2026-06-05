<p align="center">
  <img src="brand/tulipfarm-banner.png" alt="TulipFarm" width="100%" />
</p>

<h1 align="center">TulipFarm</h1>

<p align="center">
  <strong>The AI-native business operating system.</strong><br/>
  Replace 15+ SaaS tools with one platform where autonomous agents run your operations.
</p>

## Local Development

### Prerequisites

- **Node.js** (see `.node-version`)
- **pnpm** (`npm install -g pnpm`)
- **Homebrew** (for macOS)
- **MongoDB 8.0** and **Redis** (installed and started via the setup script)

### Quick Start

1. **Initialize local environment:**
   ```bash
   bash scripts/setup-dev.sh
   ```
   This installs MongoDB 8.0 and Redis via Homebrew, starts the services, creates the `./soul` directory, and generates a `.env.local` file with bootstrap secrets.

2. **Verify services are running:**
   ```bash
   mongosh --eval 'db.version()'
   redis-cli ping
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
- Installs MongoDB Community Edition 8.0
- Installs and starts Redis
- Initializes a local `./soul` git repository with the required directory structure
- Generates `.env.local` with random bootstrap secrets (`ENCRYPTION_KEY`, `JWT_SECRET`, `WEBHOOK_SIGNING_SECRET`)

**Manual adjustments:** Edit `.env.local` to customize datastores or add optional variables like `GIT_REMOTE_URL` for syncing soul changes to a remote repository.

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

To stop MongoDB and Redis:
```bash
brew services stop mongodb-community@8.0
brew services stop redis
```

To stop the dev servers, press `Ctrl+C` in the terminal running `pnpm dev`.
