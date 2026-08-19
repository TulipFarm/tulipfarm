<p align="center">
  <img src="brand/tulipfarm-banner.png" alt="TulipFarm" width="100%" />
</p>

<h1 align="center">TulipFarm</h1>

<p align="center">
  <strong>The business agent harness.</strong><br/>
  Your business' control panel where autonomous agents run your operations.
</p>

<p align="center">
  <img src="https://shieldcn.dev/badge/status-research%20preview-orange.svg" alt="Research Preview" />
  <img src="https://shieldcn.dev/github/release/TulipFarm/tulipfarm.svg?label=docker" alt="Docker Version" />
  <a href="https://tulipfarm.site"><img src="https://shieldcn.dev/badge/website-tulipfarm.site-blue.svg" alt="Website" /></a>
  <a href="LICENSE"><img src="https://shieldcn.dev/badge/license-MIT-lightgrey.svg" alt="License: MIT" /></a>
</p>

<p align="center">
  <a href="https://tulipfarm.site/docs">Documentation</a> ·
  <a href="#install-self-host">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

## What is TulipFarm

TulipFarm is a self-hosted control panel where autonomous agents run your business
operations. You **describe what you want in chat** — "track our customers", "create a
support agent", "review this pull request" — and agents build and run it for you. You do
not configure it by editing files or writing code.

It runs entirely on your own infrastructure, against your own model provider keys. Nothing
about your business data leaves your instance unless an agent's job is to send it somewhere
you've authorized.

## Features

Once a model is configured, everything below is created by asking for it in chat:

- **Resource types** — the things your business tracks. Describe one and its tables, forms,
  and list screens appear.
- **Agents** — named owners for a job, each with its own instructions, tools, and bounded
  authority.
- **Routines** — repeatable operations that run on a schedule, on an event, or on request.
- **Knowledge** — a wiki your agents read from and cite, with provenance attached to every
  answer.
- **Skills** — installable capability packages from a git repository, audited before they
  run.
- **Integrations** — reach your agents where work already happens: GitHub, Slack, Telegram,
  Notion, Confluence, and Google Workspace ship in the box, and any provider can be added as
  a manifest.

See the [full documentation](https://tulipfarm.site/docs) for a guided tour, or
[Using TulipFarm](https://tulipfarm.site/docs/using-tulipfarm) for how these fit together.

## Architecture

A TulipFarm instance has two halves:

- **The soul** — a git-backed configuration store. Your resource schemas, agents, skills,
  routines, and integrations live here as files. Agents write to the soul when you ask them
  to build something; the git history is your audit trail.
- **The runtime** — the API and workers that load the soul, store your records, index your
  knowledge, and run agent turns against your configured LLM providers.

The codebase is a TypeScript pnpm/Turborepo monorepo:

| App / package | What it does |
| --- | --- |
| `apps/api` | Fastify API server. PostgreSQL (pgvector + pg-boss), migration-on-boot, soul git store. |
| `apps/web` | Remix + React web UI. |
| `apps/worker` | Durable Run dispatch, Agent/Tool States, timers, reconciliation. |
| `apps/integration-worker` | Integration ingress, sync, delivery, retries, reconciliation. |
| `packages/*` | Domain packages (auth, agent runtime, tool broker, knowledge, memory, soul, and more) — see [AGENTS.md](AGENTS.md) for the full layout. |

Accepted architecture decisions and the boundaries between packages are recorded in
[`docs/architecture`](docs/architecture/decision-index.md).

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
`TF_BASE_URL`/`TF_REF`. See the
[installation guide](https://tulipfarm.site/docs/self-hosting/install) for every option.
An explicit `TF_PORT` also moves an existing install to that host port without rotating
its generated secrets.

> `TF_VERSION=<tag>` pins the app image. The site serves the compose file from the tip of
> `main`; to install an exact ref instead, set
> `TF_BASE_URL=https://raw.githubusercontent.com/TulipFarm/tulipfarm` together with
> `TF_REF=<tag-or-branch>`. To test a local build, set `TF_LOCAL_SRC=1`.

**Compose by hand** (Portainer, Coolify, Dokploy, Unraid, or a plain `docker compose`) —
grab `docker-compose.yml` from <https://tulipfarm.site/docker-compose.yml> and run it
as-is; no `.env` and no key generation are needed. See the header of `docker-compose.yml`
for every knob (TLS, `POSTGRES_PASSWORD`, `PUBLIC_URL`).

**Updating**: releases publish `ghcr.io/tulipfarm/tulipfarm:v<version>` (+ `:latest` for
stable). Updates are always **manual** (no auto-update by design) — re-run the install
command, or `docker compose pull && docker compose up -d`. Database migrations run
automatically on boot; there are **no down-migrations**, so back up before updating. See
the [update guide](https://tulipfarm.site/docs/self-hosting/updating) for the full procedure and
every deployment target.

**Uninstall permanently** (deletes the database, soul, secrets, backups, volumes, and
TulipFarm images after a typed confirmation):
```bash
curl -fsSL https://tulipfarm.site/uninstall.sh | bash
```
See the [uninstall guide](https://tulipfarm.site/docs/self-hosting/uninstall) before running it.

> You never need to clone this repository to run TulipFarm — every path above pulls a
> published image. The source tree here is for contributors — see
> [CONTRIBUTING.md](CONTRIBUTING.md).

## Security & secrets

- The app generates its bootstrap secrets on first boot and persists them to the
  `tulipfarm-data` volume — **back that volume up**, it holds the key that decrypts every
  secret the instance stores.
- The bundled database uses a default password, safe only because port 5432 is never
  published by default — don't publish it; set `POSTGRES_PASSWORD` to change it.
- Secrets (integration credentials, API keys) are stored encrypted and only decrypted
  immediately before an authorized use — see
  [`packages/secrets`](packages/secrets/AGENTS.md) and the
  [security docs](https://tulipfarm.site/docs/security).
- Found a vulnerability? See [SECURITY.md](SECURITY.md) — please don't file a public issue.

## Contributing

Bug reports, feature requests, and PRs are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, how the test/lint gates work, commit
conventions, and how to open a PR. Please also read the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Releases

Releases use a release PR and a gated publication pipeline; a maintainer requests an exact
version with `pnpm release 0.5.0`. See [docs/RELEASES.md](docs/RELEASES.md) for the
complete release contract, and [CONTRIBUTING.md](CONTRIBUTING.md#commit-messages) for the
commit convention that drives it.

## License

[MIT](LICENSE)
