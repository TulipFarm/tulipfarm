# @tulipfarm/mcp-catalog

A list of official MCP servers for popular apps. Each record gives the app's category, the teams that use it, how to sign in, and icon keys. TulipFarm's Integrations page is built from it, and any project can use it.

## The rule: official servers only

An app is listed only if the company behind the app publishes or endorses the server. Each record links to that proof in `official.evidence`, such as the maker's own docs, blog post or GitHub organisation. Community wrappers aren't listed, however popular they are.

## Records

There's one JSON file per app in `apps/<id>.json`, checked against [`schemas/app.v1.json`](schemas/app.v1.json) (built from `src/schema.ts`).

```jsonc
{
  "$schema": "../schemas/app.v1.json",
  "id": "freshdesk",
  "name": "Freshdesk",
  "maker": "Freshworks",
  "homepage": "https://www.freshworks.com/freshdesk/",
  "category": "support",
  "teams": ["support"],
  "summary": "Search and update tickets in Freshdesk",
  "capabilities": ["Search, create, and update tickets", "Reply to and add notes on tickets"],
  "official": { "evidence": "https://support.freshdesk.com/…" },
  "docs": "https://support.freshdesk.com/…",
  "remote": {
    "url": "https://{subdomain}.freshdesk.com/mcp",
    "transport": "streamable-http",
    "auth": "api-key",
    "headers": [
      { "name": "Authorization", "value": "{key}", "description": "Freshdesk API key from Profile settings" },
    ],
    "variables": [{ "name": "subdomain", "description": "Your Freshdesk subdomain", "example": "acme" }],
  },
  "icons": { "color": "#25C16F" },
  "supportedBy": ["lindy", "gumloop", "n8n"],
}
```

- **`remote`** is the hosted server, and apps should prefer it. `auth` is `oauth`, `api-key`, `none` or `unknown`.
- **`{key}`** in a header value is the person's API key. It's allowed only when `auth` is `api-key`.
- **`variables`** are the per-account parts of the URL or header values, such as a subdomain. Every `{placeholder}` except `{key}` must be declared, and every declared variable must be used.
- **`packages`** are the official npm, PyPI or OCI packages, for apps without a hosted server or for running one yourself.
- **`checked`** is the last date the probe reached the server. **`unreachableSince`** is set while it can't be reached, and apps should hide those records.
- **`supportedBy`** lists the other agent products that offer the app. It shows how widely the app is used.
- **`featured`** marks the apps to show first.

```ts
import { iconUrls, isHosted, mcpCatalog, mcpCatalogApp, mcpCatalogAppByEndpoint } from '@tulipfarm/mcp-catalog';

mcpCatalogApp('linear')?.remote?.url; // 'https://mcp.linear.app/mcp'
mcpCatalogAppByEndpoint('https://acme.freshdesk.com/mcp')?.id; // 'freshdesk'
```

## Icons

No logo files are stored here. Each record has up to three keys:

- `lobehub`: a [@lobehub/icons](https://github.com/lobehub/lobe-icons) component name.
- `simpleIcons`: a [Simple Icons](https://simpleicons.org) slug.
- `color`: the brand colour, for a letter tile when neither icon exists.

`iconUrls(app)` returns CDN URLs for both. The `icon-keys/` lists hold every key each project ships; tests reject keys that aren't in them.

## Add an app

1. Find the maker's own announcement or docs for the server. Without one, the app can't be listed.
2. Copy a similar file in `apps/`, then fill it in. The file name must match `id`.
3. Run `pnpm test` and `pnpm probe <id>`, then `pnpm exec oxfmt apps`.

## Keeping it fresh

`.github/workflows/mcp-catalog-refresh.yml` runs every Monday. It opens one pull request for a person to review:

- `scripts/probe.mjs` checks every hosted server and fills in `checked`, `unreachableSince` and any `unknown` sign-in types.
- `scripts/icon-keys.mjs` refreshes the icon key lists.
- `scripts/discover.mjs` lists new servers from the official MCP Registry that are published under a company's domain.

Records with `variables` can't be probed, because the URL differs for each account.

## Licence

Same as this repository. Brand names and logos belong to their owners.
