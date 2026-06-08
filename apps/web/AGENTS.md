# Web App — Agent Conventions

`@tulipfarm/web` — Remix (v2) **SPA** + React 19 + Vite frontend. Dev server on `:4000`
(`VITE_PORT`). See root `AGENTS.md` for monorepo commands, Biome rules, and git policy.

## Stack

- **Remix 2.17 in SPA mode** (`remix({ ssr: false })`) — client-rendered, file-based routing,
  served as static files by nginx in prod. ESM (`"type": "module"`).
- **React 19** (`react` + `react-dom`).
- **Tailwind v4** (CSS-first `@theme`, no PostCSS/JS config) via `@tailwindcss/vite`; design
  tokens (oklch) in `app/app.css`. `tailwind-merge` v3 + `tw-animate-css`.
- **shadcn/ui** copied-in to `app/components/ui` (config in `components.json`). Strip shadcn's
  default shadows — the design language is flat/hairline (OpenCode-style, ruby brand).
- **Lucide** icons; **JetBrains Mono** is the only font (`@fontsource-variable/jetbrains-mono`,
  imported as a side-effect in `root.tsx`).
- **Dark mode** via `[data-theme="dark"]` on `<html>` (NOT shadcn's `.dark`), persisted to
  `localStorage`; a no-flash init script in `root.tsx` sets it pre-hydration. Toggle in Settings.
- tsconfig extends `@tulipfarm/tsconfig/remix.json`; path alias `~/* → app/*` (tsconfig `paths`
  + vite `resolve.alias`). DOM/CSS module + fontsource types declared in `app/globals.d.ts`.

## Structure

```
app/
  root.tsx              # document shell + no-flash theme script + HydrateFallback (becomes index.html)
  app.css               # Tailwind v4 import + oklch tokens (:root / [data-theme=dark]) + @theme inline
  globals.d.ts          # vite/client + fontsource module declarations
  lib/{utils,nav,badges}.ts   # cn(); sidebar nav config; mocked badge counts
  components/
    app-sidebar.tsx     # persistent sidebar (8 sections, responsive mobile drawer)
    theme-toggle.tsx    # [data-theme] + localStorage toggle
    empty-state.tsx     # shared bracket-marker empty state
    ui/button.tsx       # vendored shadcn primitive (flat)
  routes/
    _app.tsx            # pathless layout: sidebar + <Outlet/>
    _app._index.tsx     # Chat welcome (default /)
    _app.<section>.tsx  # Resources/Agents/Routines/Approvals/Knowledge/Integrations/Settings
components.json         # shadcn config (rsc:false, css app/app.css, ~ aliases)
vite.config.ts          # remix({ssr:false}) + tailwindcss() + ~ alias
vitest.config.ts        # @vitejs/plugin-react (NOT the Remix plugin) + jsdom + ~ alias
```

## Adding a route / page

1. Create `app/routes/<name>.tsx` using Remix's filename convention. Section pages nest under the
   `_app` layout (`_app.<segment>.tsx`).
2. Export a default **component**; render child routes via `<Outlet />`.
3. **SPA mode: no server `loader`/`action`.** For client data use `clientLoader` and read with
   `useLoaderData<typeof clientLoader>()`. Server-only Remix exports are unavailable.
4. Navigate with Remix `<Link>` / `<NavLink>`, not raw `<a>`.

## Conventions

- shadcn primitives live in `app/components/ui` (app-local). `@tulipfarm/ui` remains the home for
  **cross-app** shared components (not used here).
- Reserve ruby (`--primary`) for brand/primary; coral/signal red (`--destructive`) for danger
  only — keep ruby on ≤10% of any screen. Containers `rounded-none`, interactive `rounded-sm/md`.
- Badge counts are **mocked** (`lib/badges.ts`) in the V1 shell — wire to the API downstream.
- The API CORS-allows the web origin at `VITE_PORT` (default `:4000`); the API itself is `:4010`.

## Tests

Vitest with a dedicated `vitest.config.ts` (`@vitejs/plugin-react` + `jsdom`) — it must **not**
load the Remix Vite plugin. Colocate `*.test.tsx`. Components using `<Link>`/`<NavLink>`/`<Outlet>`
need a router context: wrap with `createRemixStub` from `@remix-run/testing`.

## Prod serving (nginx)

`pnpm --filter @tulipfarm/web build` emits `build/client/` (incl. `index.html`). Serve it static
with a history-API fallback so client routes resolve on refresh:

```nginx
root /srv/tulipfarm/web/build/client;
location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; try_files $uri =404; }
location /        { try_files $uri $uri/ /index.html; }
```
