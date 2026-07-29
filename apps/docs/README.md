# @tulipfarm/docs

TulipFarm documentation site (specs/DOCS.md DOC-V1-001). Built with
[Fumadocs](https://fumadocs.dev) on Next.js with
[static export](https://nextjs.org/docs/app/guides/static-exports) — `next build`
emits a fully static site to `out/`, deployed separately from the app.

## Commands

```bash
pnpm --filter @tulipfarm/docs dev        # dev server on http://localhost:4020
pnpm --filter @tulipfarm/docs build      # static export to apps/docs/out/
pnpm --filter @tulipfarm/docs start      # serve the built out/ locally
pnpm --filter @tulipfarm/docs lint       # biome check
pnpm --filter @tulipfarm/docs typecheck  # fumadocs-mdx + next typegen + tsc
```

## Layout

| Path | Description |
| --- | --- |
| `content/docs/` | MDX content (DOC-V1-002 fills this in) |
| `lib/source.ts` | Content source adapter (`loader()`) |
| `lib/shared.ts` | `SITE_URL`, site name, routes, GitHub config |
| `lib/layout.shared.tsx` | Shared layout options |
| `app/(home)` | Landing page route group |
| `app/docs` | Documentation layout and pages |
| `app/api/search` | Search index, statically generated (Orama) |
| `source.config.ts` | Fumadocs MDX config (frontmatter schema etc.) |
| `scripts/sync-public-assets.mjs` | Copies the install assets into `public/` before build/dev |

## Published install assets

The site is the distribution point for the installer and the Compose file, so
`https://tulipfarm.site/install.sh` works. `scripts/sync-public-assets.mjs` runs ahead of
`next build` and `next dev` (chained in `package.json` — **not** a `prebuild` hook, which
pnpm does not run by default) and copies these byte-identical from the repo root:

| Served at | Source |
| --- | --- |
| `/install.sh` | `scripts/install.sh` |
| `/install.ps1` | `scripts/install.ps1` |
| `/docker-compose.yml` | `docker-compose.yml` |
| `/env.example` | `.env.example` |

The copies are gitignored. `public/_headers` serves them as `text/plain` so a browser
renders a script instead of downloading it. `.env.example` is renamed because Cloudflare
Pages does not serve dot-prefixed files; `remote_url()` in the installer maps the name
back. `scripts/site-url.test.ts` (run by `pnpm architecture:test`) fails if a source path
here stops existing or if the installer fetches something the site does not publish.

## Deployment — Cloudflare Pages (git integration)

The site deploys via Cloudflare Pages connected to this repository. One-time
dashboard setup (Workers & Pages → Create → Pages → Connect to Git):

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Build command | `pnpm install --frozen-lockfile && pnpm --filter @tulipfarm/docs build` |
| Build output directory | `apps/docs/out` |
| Root directory | `/` (repo root — monorepo install needs the workspace) |
| Environment variable | `NODE_VERSION=24` |

pnpm is auto-detected from the root `package.json` `packageManager` field.
Pages serve as clean URLs (`/docs` → `docs.html`) — Cloudflare Pages handles
this natively; no redirect config needed.
