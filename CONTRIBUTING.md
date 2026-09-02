# Contributing to TulipFarm

Thanks for taking the time to contribute. This guide covers everything you need to get a
local dev environment running, make a change, and open a pull request.

Please also read the [Code of Conduct](CODE_OF_CONDUCT.md). Found a security
vulnerability? See [SECURITY.md](SECURITY.md) instead of opening a public issue.

> If you only want to **run** TulipFarm, don't clone this repo — use the
> [one-line installer](https://tulipfarm.site/docs/installation) or
> [Docker Compose](https://tulipfarm.site/docs/deploy/docker-compose). This guide is for
> people changing TulipFarm's code.

## Local development setup

**Prerequisites**

| | |
| --- | --- |
| **Node.js** | `26.5.0` — pinned in `.node-version`. Use `fnm`, `nvm`, or `mise`. |
| **pnpm** | `11.5.3`. Never npm or yarn — the lockfile is pnpm's. |
| **Docker** | Docker Desktop or Docker Engine, with the Compose v2 plugin. |

Postgres always runs as the bundled `pgvector/pgvector:pg17` container — the same image CI
and production use, so local dev can't drift from the tested path.

```bash
git clone https://github.com/TulipFarm/tulipfarm.git
cd tulipfarm

bash scripts/setup-dev.sh   # starts Postgres, inits soul repo, writes .env.local — no prompts
pnpm install
pnpm dev                    # api :4010, web :4000, worker :4020, integration-worker :4030
```

Open `http://localhost:4000` and log in with the dev admin `setup-dev.sh` seeds:

```text
email:    admin@tulipfarm.dev
password: tulipfarm-dev
```

Run a single app with `pnpm dev:api`, `pnpm dev:web`, `pnpm dev:worker`, or
`pnpm dev:integration-worker`. Start over from a clean slate with `pnpm reset:dev`.

Full walkthrough (soul repo internals, headless admin seeding, marketplace branch testing,
troubleshooting): **[Local development](https://tulipfarm.site/docs/development)** on the
docs site.

## Making a change

1. **Read the nearest `AGENTS.md`.** Every app and package has one with local conventions —
   it's the authoritative guide for that directory. The root [AGENTS.md](AGENTS.md) has the
   full repo layout and the test-verification tiers (don't run the full `pnpm test` suite
   for a small change — it's the slowest way to get a signal; see the "Verifying your work"
   section).
2. **Match the code style.** [Biome](https://biomejs.dev) is the only linter/formatter —
   no ESLint, no Prettier. A pre-commit hook auto-fixes staged files, so conforming code
   makes it a no-op:
   ```bash
   pnpm exec biome check --write .
   ```
3. **Add tests** for behavior you change or add. Vitest, colocated as `*.test.ts` next to
   the source. Run just what you touched:
   ```bash
   pnpm --filter @tulipfarm/api test apps/api/src/your-file.test.ts
   ```
4. **Before opening a PR**, run the full gate once — it's what CI runs, cached and fast on
   a repeat run:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test
   ```

Complete conventions (migrations, API route schemas, terminology rules, where things live):
**[Development workflow](https://tulipfarm.site/docs/development/workflow)** on the docs
site.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), enforced locally by a
`commit-msg` hook and again by CI on the PR title:

```
type(scope): subject
```

`type` is one of `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`,
`style`, `revert`. Imperative mood, no trailing period, under ~72 characters. Use the body
to explain *why*, not *what* — the diff already shows what. One logical change per commit.

## Opening a pull request

1. Branch from `main`.
2. Keep the PR scoped to one logical change — smaller PRs review faster.
3. Title the PR the same way as a commit message: `type(scope): subject`. CI rejects titles
   that don't match.
4. Fill in the PR template: a short summary of what changed and why, and a test plan
   listing the commands you actually ran (or manual steps / screenshots for UI changes).
5. CI runs lint, typecheck, and tests automatically. Fix red checks before requesting
   review.
6. A maintainer reviews and merges — releases are cut separately (see
   [docs/RELEASES.md](docs/RELEASES.md)), so you don't need to bump versions or touch the
   changelog yourself.

## Reporting bugs and requesting features

Open a [GitHub issue](https://github.com/TulipFarm/tulipfarm/issues/new/choose) using the
bug report or feature request template. For a bug, include:

- What you expected vs. what happened
- Steps to reproduce
- Your install method (installer / Compose / source) and TulipFarm version
- Relevant logs (`docker compose logs app`, or terminal output for a source checkout)

Not sure if something is a bug? Open an issue anyway with what you're seeing — we'll help
you sort it out.

## Questions

If something in this guide is wrong or missing, that's a documentation bug — please open an
issue or a PR fixing it.
