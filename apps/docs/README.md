# @tulipfarm/docs

Documentation at **https://docs.tulipfarm.site**, built with Fumadocs and Next.js static export.
All reading paths stay under `/docs`; the domain root redirects to `/docs`. The website and
deployment entry live independently in [`../www`](../www/README.md) at https://tulipfarm.site.

## Commands

```bash
pnpm dev:docs                          # http://localhost:5000
pnpm --filter @tulipfarm/docs build     # apps/docs/out/
pnpm --filter @tulipfarm/docs start     # serve the export locally
pnpm --filter @tulipfarm/docs lint
pnpm --filter @tulipfarm/docs typecheck
pnpm docs:test
```

## Ownership

| Path | Owns |
| --- | --- |
| `content/docs/` | Documentation content and navigation |
| `lib/source.ts` | Fumadocs source and machine-readable page text |
| `lib/shared.ts` | Re-exports the import-free public origin constants |
| `lib/remark-site-url.ts` | `{{DOCS_URL}}` for documentation; `{{SITE_URL}}` for website/downloads |
| `app/docs/` | Reading layout and pages |
| `app/api/search/` | Static search index; result paths stay local to `/docs` |
| `app/og/`, `app/llms*`, `app/sitemap.ts`, `app/robots.ts` | Documentation discovery and metadata |
| `scripts/generate-deploy-docs.ts` | Documentation-only rendering from `deploy/` |
| `scripts/clean-public-assets.mjs` | Removes retired local distribution copies before export |
| `public/_redirects`, `public/_headers` | Cloudflare Pages routing and response headers |

Both sites read deployment manifests through `scripts/public-site/deployment-input.ts` and render
them through `@tulipfarm/deploy-render`. This build writes only documentation pages. It does not
generate or publish installers, Compose, environment files, `deploy.txt`, or editor schemas.
Those remain at their published **website** URLs and are owned by www. Generate schemas with
`pnpm --filter @tulipfarm/www generate:plan-schema` or `generate:pack-schema`.

## Cloudflare Pages

Create a separate **Pages** project, not a Workers/Next.js-server deployment.

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | Repository root |
| Build command | `pnpm install --frozen-lockfile && pnpm --filter @tulipfarm/docs build` |
| Output directory | `apps/docs/out` |
| `NODE_VERSION` | `26.5.0` (keep aligned with `.node-version`) |
| `PNPM_VERSION` | `11.5.3` (keep aligned with root `packageManager`) |
| Custom domain | `docs.tulipfarm.site` |

Cloudflare Pages serves extensionless URLs from exported `.html` files. The `_redirects` file
adds only explicit ownership redirects; there is no SPA catch-all. `404.html` must remain in the
export so unknown paths return a real not-found response. Do not configure a dashboard rule that
redirects `/docs` back to the website.

Canonical metadata, OG links, robots, sitemap, and LLM discovery use the documentation origin.
Search uses the documentation site's `/api/search`; its public CORS header also permits cached
clients following the website's legacy search redirect.

Before connecting production domains, follow the [website cutover checklist](../www/README.md#cutover).
A successful local export does not verify Cloudflare redirects or prove a domain was moved.
