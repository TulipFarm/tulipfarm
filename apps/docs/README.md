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
| `lib/shared.ts` | Site name, routes, GitHub config |
| `lib/layout.shared.tsx` | Shared layout options |
| `app/(home)` | Landing page route group |
| `app/docs` | Documentation layout and pages |
| `app/api/search` | Search index, statically generated (Orama) |
| `source.config.ts` | Fumadocs MDX config (frontmatter schema etc.) |

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
