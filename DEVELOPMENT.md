# Development

## Prerequisites

- Node.js: the version in [`.node-version`](.node-version) (26).
- pnpm 11.5.3: `npm install --global pnpm@11.5.3`.
- Docker with Docker Compose, for local dependencies.

## Set up

```sh
pnpm install --frozen-lockfile
pnpm lint
```

## Local dependencies

[`compose.yaml`](compose.yaml) runs the development services, bound to
`127.0.0.1` with local-only credentials:

| Service                        | Port |
| ------------------------------ | ---- |
| PostgreSQL with pgvector       | 5432 |
| Temporal                       | 7233 |
| Temporal UI                    | 8233 |
| RustFS (S3-compatible storage) | 9000 |

[`infra/postgres/init.sql`](infra/postgres/init.sql) creates the `tulipfarm` and
`temporal` databases on first start.

```sh
pnpm infra:up     # start and wait for health checks
pnpm infra:down   # stop
```

Agent web search and page reads are off unless `FIRECRAWL_ENDPOINT` points at a
Firecrawl-compatible API. Export it before `pnpm dev:setup` to write it to
the API and worker env files. Authenticated services also take
`FIRECRAWL_API_KEY` or `FIRECRAWL_API_KEY_FILE`. Temporal Cloud takes
`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TLS=true`, and
`TEMPORAL_API_KEY` or `TEMPORAL_API_KEY_FILE`; setup copies the resolved values
to the service env files. With these unset, local defaults are unchanged.
See [`self-host/README.md`](self-host/README.md#public-web).

The API and worker start only when the model catalog serves at least one
model, so export a provider key such as `ANTHROPIC_API_KEY` before `pnpm dev`.
The shipped catalog ([`packages/config/catalog/models.json`](packages/config/catalog/models.json))
skips models whose key is unset; `MODEL_CATALOG_FILE` or `MODEL_CATALOG`
replaces it. See [`packages/config/README.md`](packages/config/README.md#configuration).

## Commands

| Command             | What it does                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ |
| `pnpm dev`          | Start dependencies, set up the database, and run all apps                            |
| `pnpm build`        | Build all workspaces                                                                 |
| `pnpm lint`         | Check formatting, run Oxlint, the `tooling/` tests, and the documentation link check |
| `pnpm lint:fix`     | Apply Oxlint fixes                                                                   |
| `pnpm format`       | Format files with Oxfmt                                                              |
| `pnpm format:check` | Check formatting without writing changes                                             |
| `pnpm typecheck`    | Type-check all workspaces                                                            |
| `pnpm test`         | Run tests in all workspaces                                                          |
| `pnpm test:<group>` | Run one CI test group: `apps`, `memory`, `integrations`, or `platform`               |
| `pnpm check`        | Check only what changed since `origin/main` (`--base=<ref>` to change)               |
| `pnpm check:full`   | Build, type-check, test, and lint everything, and validate the Compose files         |

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `pnpm lint`,
`pnpm typecheck`, and the four test groups as parallel jobs on GitHub-hosted
runners for every pull request and push to `main`. Each group is a `test:<group>`
script in `package.json`. Every tested workspace belongs to exactly one group, and
`tooling/test-groups.test.mjs` fails the lint job when a workspace or a CI job is
missing. [`.github/workflows/images.yml`](.github/workflows/images.yml)
builds the container images for GHCR; it stays disabled until the first release.
[`.github/workflows/sprout-upgrade.yml`](.github/workflows/sprout-upgrade.yml)
upgrades `@tulipfarm/sprout` when Sprout publishes a release: Copilot migrates
the code from the changelog and source diff, following
[`.github/sprout-upgrade/PROMPT.md`](.github/sprout-upgrade/PROMPT.md), and the
workflow opens a pull request, as a draft if any check fails. If the upgrade
passes, a second Copilot run follows
[`.github/sprout-upgrade/ADOPT.md`](.github/sprout-upgrade/ADOPT.md) to replace
hand-rolled code with components the release added, and opens that as a
separate pull request stacked on the upgrade.

## Layout

- `apps/`: deployable applications.
- `packages/`: shared domain code and configuration.
- `infra/`: local infrastructure configuration.
- `tooling/`: repository check runner, lint rules, and local verification scripts.
