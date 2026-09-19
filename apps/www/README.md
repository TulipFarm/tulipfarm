# @tulipfarm/www

TulipFarm's static public website at **https://tulipfarm.site**. Documentation is a separate
application at **https://docs.tulipfarm.site/**. This application owns the homepage, prepared
browser-only examples, `/deploy`, installer downloads, deployment assets, and published schemas.
No running product instance, database, model credentials, or Next.js server is needed.

The homepage pairs a concise promise with an illustrated request-to-result flow. A readable
request passes through the TulipFarm handoff to a real Surface Web result, not a fabricated app
screen. The customer result is visible immediately, including in exported HTML. Selecting another
example shows its result; replay walks through Describe, Build, and Use. Reset returns to Describe.
The later sections use distinct authority and routine diagrams rather than repeated data panels.

The public pages and shared navigation use locally hosted DM Sans. Its SIL Open Font License
is included at `public/fonts/DM-Sans-OFL.txt`; the font comes from the Google Fonts DM Sans
distribution. Real product previews keep Inter. Setup code uses the system monospace font, so
entering the guide does not require additional font downloads. The build-time social image uses
Next's bundled font and the local brand mark.

`public/images/examples/` contains lossless WebP captures of the local product's actual chat UI
with unsent prepared requests. The captures show no generated answers. The foreground results
come from the validated sample Artifacts, not those chats. Capture through the supported UI,
collapse unrelated recent chats, and crop out account details and local diagnostics before
publishing. All three images preload locally; switching examples must not send network requests.
Captures are secondary evidence inside a native disclosure, not the main demonstration. On narrow
screens the illustrated flow stacks vertically. If a capture fails, its disclosure shows an error;
the request and sample result remain available independently.

## Local work

```bash
pnpm dev:www                         # http://localhost:5100
pnpm --filter @tulipfarm/www build    # apps/www/out/
WRANGLER_SEND_METRICS=false pnpm --filter @tulipfarm/www preview # local Pages runtime
pnpm --filter @tulipfarm/www test:browser # acceptance against the built export
pnpm docs:test                       # shared URL, schema, docs, and deployment contracts
```

The deployment route puts host choices beside the assistant prompt, then expands the guided
checklist to the full content width. Its model, defaults, conditional steps, download links, and
documentation anchors still come from the deployment manifests. It imports no Fumadocs UI.
`app/deploy/deploy.css` owns the layout and reduced-motion behavior.

Setup controls remain disabled until hydration. With missing or failed scripts, the page links to
the written setup docs and keeps the deployment prompt readable for manual copying. Clipboard
errors show a visible recovery message. Checklist progress is local to the page and is not a
claim that the visitor's server has been checked.

`test:browser` starts the local Pages runtime with telemetry disabled and uses one browser worker.
It checks the exported visitor experience, redirects, response types, and real downloads.
To run the same checks against an authorized hosted Pages preview, set `WWW_PREVIEW_URL` to its
origin. Local-runtime checks do not replace the hosted cutover checks below.

## Independent generation

The website's build and dev scripts run these presteps explicitly, not through implicit pnpm
`prebuild` hooks:

1. `tsx scripts/generate-deploy-assets.ts` renders `deploy.txt` and generated target assets.
2. `pnpm generate:plan-schema` and `pnpm generate:pack-schema` refresh the committed editor schemas.
3. `node scripts/sync-public-assets.mjs` copies distribution bytes into `public/`.
4. After **`next build`**, `node scripts/sync-public-assets.mjs --out` copies the same bytes into
   the export again. Next emits the `/deploy` RSC payload as `out/deploy.txt`; the final copy must
   overwrite it with the actual readable deployment guide.

`scripts/public-site/deployment-input.ts` is the shared build-time filesystem collector.
`@tulipfarm/deploy-render` is the single pure renderer for the wizard, text guide, and documentation.
The documentation build writes only its MDX pages and never modifies this application's output.
No application imports another application.

## Published URL inventory

These paths remain on **https://tulipfarm.site**:

| Path | Source |
| --- | --- |
| `/install.sh` | `scripts/install.sh` |
| `/uninstall.sh` | `scripts/uninstall.sh` |
| `/install.ps1` | `scripts/install.ps1` |
| `/docker-compose.yml` | `docker-compose.yml` |
| `/env.example` | `.env.example` |
| `/deploy.txt` | `deploy/deploy.txt`, generated from the deployment manifests |
| `/kubernetes-values.yaml` | `deploy/targets/kubernetes/values.yaml`, generated |
| `/azure-containerapp.yaml` | `deploy/targets/azure-container-apps/containerapp.yaml`, generated |
| `/schemas/plan/v1.schema.json` | TypeBox Plan schema, via `scripts/generate-plan-schema.ts` |
| `/schemas/pack/v1.schema.json` | TypeBox Pack schema, via `scripts/generate-pack-schema.ts` |

Copies are byte-identical to their sources. `.env.example` is served as `env.example` because
Pages does not serve dot-prefixed files. `_headers` keeps scripts and deployment text readable as
UTF-8 and schemas as JSON. Do not move downloads to the documentation origin or retype their contents.

`public/_redirects` permanently redirects legacy `/docs` and `/docs.html` to the documentation
origin's `/`, and `/docs/*` to `/*` there. Reading links use `/self-hosting/...`,
`/administration/...`, `/using-tulipfarm/...`, `/reference/...`, and `/security/...` without a
`/docs` prefix. `/api/search`, `/og/docs/*`, `/llms.txt`, `/llms-full.txt`, and `/llms.mdx/*`
redirect to the documentation origin with their paths unchanged. Browser fragments are inherited
when the redirect target has no fragment, preserving bookmarks to headings. Unknown paths are not
rewritten to the homepage.

## Cloudflare Pages

Use a **Pages** project connected to this repository. Do not select a Workers deployment or an
adapter requiring request-time Next.js execution.

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | Repository root |
| Build command | `pnpm install --frozen-lockfile && pnpm --filter @tulipfarm/www build` |
| Output directory | `apps/www/out` |
| `NODE_VERSION` | `26.5.0` (keep aligned with `.node-version`) |
| `PNPM_VERSION` | `11.5.3` (keep aligned with root `packageManager`) |
| Custom domain | `tulipfarm.site` |

Pages clean URLs serve exported `.html` files without suffixes. Keep the generated `404.html`;
do not add `/* /index.html 200` or a redirect-all dashboard rule. `_headers` and `_redirects` are
copied from `public/` into the export and take effect on Pages, not on a generic local file server.
Use the separate [documentation Pages configuration](../docs/README.md#cloudflare-pages).

## Cutover

An authorized operator performs these steps; repository changes do not modify DNS or production.

1. Build both exports independently from a clean checkout using the pinned tools. Check the
   website's scripts, Compose, environment file, generated deployment assets, and schemas against
   their sources. Confirm `/deploy.txt` begins with the deployment guide, never an RSC payload.
2. Publish both to **Cloudflare Pages previews**. Review the prepared examples and Start building
   journey on phone and desktop, including keyboard use, reduced motion, and no product/model
   requests. Follow the deployment wizard's managed and bundled database paths.
3. On Pages, check redirect status and destination for `/docs`, a deep `/docs/...#heading`,
   `/api/search`, `/og/docs/.../image.png`, and every LLM endpoint. Check `/docs.html` clean-URL
   behavior. Ensure unknown routes return **404**, not a successful homepage.
4. Check response content types, actual downloaded bytes, schema `$id` values, canonicals,
   sitemap ownership, search results, and links in both directions. A local static server cannot
   establish Pages header or redirect behavior.
5. Connect and verify `docs.tulipfarm.site` first. Preserve the existing website deployment until
   the replacement publishes every distribution path. Then attach `tulipfarm.site` to www.
6. Repeat the redirect, download, metadata, search, and deployment smoke checks on the real
   domains. Keep the previous Pages deployment available for rollback; do not point docs back at
   the website's `/docs` redirects.

Record preview evidence and production cutover separately. A merged change or local build is not
evidence that either production origin has changed.
