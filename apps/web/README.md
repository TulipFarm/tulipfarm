# @tulipfarm/web

The TulipFarm browser app: a Vite + React single-page app. UI components come from
[`@tulipfarm/sprout`](https://github.com/TulipFarm/sprout) (imported per component, e.g.
`@tulipfarm/sprout/button`); components sprout does not have live in `src/components/`.

```sh
pnpm --filter @tulipfarm/web dev        # http://localhost:5173, API at http://localhost:3001
pnpm --filter @tulipfarm/web build      # dist/, plus dist/version.json
pnpm --filter @tulipfarm/web typecheck
pnpm --filter @tulipfarm/web test       # unit tests; *.browser.mjs files run individually
```

## Build settings

All are read when the app is built (`import.meta.env`), not at runtime.

| Variable                        | Default                                                             | Purpose                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_URL`                  | `http://localhost:3001` in dev, the page's own origin in production | Public API origin. Set it when the API is not served under `/v1` on the app's origin.                                                                                                   |
| `VITE_SUPPORT_EMAIL`            | unset                                                               | Support address on the Help page. Unset hides the contact section. Self-host: `TULIPFARM_SUPPORT_EMAIL`.                                                                                |
| `VITE_AGENT_AVATAR_URL`         | unset                                                               | Origin serving agent avatar artwork at `/avatar/<object>/<color>.svg`. Unset shows each agent's initial instead. Self-host: `TULIPFARM_AGENT_AVATAR_URL`.                               |
| `VITE_WEBSITE_URL`              | unset                                                               | Public website origin. When set, the analytics consent banner links to `<origin>/privacy/`, and the consent cookie is shared with the website when the app is on one of its subdomains. |
| `VITE_DOCS_URL`                 | unset                                                               | Public documentation origin for the model setup guide link (default `https://docs.tulipfarm.ai`) and for scrubbing documentation URLs from analytics properties.                        |
| `VITE_TULIPFARM_WEB_EXTENSIONS` | unset (none)                                                        | Comma-separated web extensions to bundle; see below.                                                                                                                                    |
| `TULIPFARM_RELEASE_BUILD`       | unset                                                               | `1` makes `build` read the release identity from `version.json` and fail without one.                                                                                                   |

## Feature flags

`useFlag(flag)` (`src/lib/feature-flags.ts`) reads `GET /v1/feature-flags?workspace=<slug>`, which
the API evaluates for the signed-in user with `featureFlagSnapshot` from `@tulipfarm/observability`
(the flag provider extension, then `FEATURE_FLAG_*` and `FEATURE_FLAGS_OFF`, then the default).
Until the API answers, or if it fails, a flag uses its declared default for the build: on in
development builds, off in production builds.

## Web extensions

`src/extensions.ts` declares every entry an extension may replace, with the open-source default:

| Entry       | Default                                                       | Replaced by                                                                                                                              |
| ----------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `analytics` | `noopBrowserAnalytics`: no consent banner, script, or request | A `BrowserAnalytics` client (product analytics, error reports). The app calls it through `guardBrowserAnalytics`.                        |
| `credits`   | Renders nothing; self-hosted workspaces are unmetered         | A sidebar credit balance component (`{ workspaceId, slug }`). Use `creditsAreUnlimited` to hide it when `available`/`granted` is `null`. |
| `usage`     | `null`: no Settings → Usage route or navigation entry         | A page component; the route `/$workspaceSlug/settings/usage` and its navigation entries appear.                                          |

Extensions are chosen at build time. `VITE_TULIPFARM_WEB_EXTENSIONS` lists module specifiers
(package names resolvable from `apps/web`, or paths relative to `apps/web`), each default-exporting
an extension. Vite compiles them into `virtual:tulipfarm-web-extensions`; the registry applies them
in order before the first render, then seals. Two extensions cannot override the same entry.

```ts
// my-web-extension/src/index.tsx
import { defineWebExtension } from '@tulipfarm/extensions/web';

export default defineWebExtension({
  name: 'my-analytics',
  register(registrar) {
    registrar.override('analytics', createMyBrowserAnalytics());
  },
});
```

```sh
VITE_TULIPFARM_WEB_EXTENSIONS=@acme/tulipfarm-web-extension pnpm --filter @tulipfarm/web build
```

An analytics client must keep consent: report `configured()` as true only when installed, send
nothing until `choose(true)`, and honour Do Not Track / Global Privacy Control. The vendor-neutral
consent cookie and URL scrubbing helpers are in `src/lib/browser-analytics.ts`.

## Self-hosting

`apps/web/Dockerfile` builds the app and serves it with Caddy using `self-host/Caddyfile`, which
also proxies `/v1` to the API on the same origin. See `self-host/compose.yaml` (`web` service).
