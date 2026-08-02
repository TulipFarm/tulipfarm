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
  lib/
    api.ts              # fetch-based API client (cookie+CSRF+Bearer), throws ApiError(status, msg, path)
    schema.ts           # JSON-Schema helpers: formFields/listColumns/detailFields/renderValue
    agents.ts  skills.ts  # typed wrappers over /api/v1/agents, /api/v1/skills (+ scan/audit/install)
    utils.ts  nav.ts  badges.ts   # cn(); sidebar nav config; mocked badge counts
    chat/               # chat SSE wire contract (types.ts: ChatEvent incl. guardrail_block) + parser (sse-client.ts) + timeline reducer (reducer.ts)
    surface/            # Tulip Surface Protocol browser integration
  components/
    app-sidebar.tsx     # persistent sidebar (8 sections, responsive mobile drawer)
    theme-toggle.tsx    # [data-theme] + localStorage toggle
    empty-state.tsx  states.tsx  resource-panel.tsx   # empty / error+not-found / header+breadcrumb
    resource-form.tsx   # schema-driven create/edit form (write side)
    schema-table.tsx  detail-view.tsx                 # schema-driven list / detail (read side)
    link-combobox.tsx   # searchable combobox for x-links fields
    markdown-view.tsx   # renders agent/skill markdown body
    surface-artifact.tsx # native trusted React renderer for Surface Artifacts
    chat/parts.tsx      # renders timeline parts (text/tool/plan/…) incl. the guardrail_block alert (ruby)
    ui/*.tsx            # vendored shadcn primitives (flat)
  routes/
    _app.tsx            # pathless layout: sidebar + <Outlet/>
    _app._index.tsx     # Chat welcome (default /)
    _app.resources.$type._index.tsx / .new.tsx / .$id.tsx / .$id.edit.tsx   # list/create/detail/edit
    _app.agents._index.tsx / .$name.tsx     # agents list + detail (read-only)
    _app.skills._index.tsx / .$name.tsx / .install.tsx   # skills list + detail + SkillAudit install
    _app.<section>.tsx  # Routines/Approvals/Knowledge/Integrations/Settings (shell, still mocked)
components.json         # shadcn config (rsc:false, css app/app.css, ~ aliases)
vite.config.ts          # remix({ssr:false}) + tailwindcss() + ~ alias
vitest.config.ts        # @vitejs/plugin-react (NOT the Remix plugin) + jsdom + ~ alias
```

Resources, Agents, and Skills are wired to the real API. Routines/Approvals/Knowledge/
Integrations/Settings are still shell placeholders. Badge counts remain mocked (`lib/badges.ts`).

## Adding a route / page

1. Create `app/routes/<name>.tsx` using Remix's filename convention. Section pages nest under the
   `_app` layout (`_app.<segment>.tsx`).
2. Export a default **component**; render child routes via `<Outlet />`.
3. **SPA mode: no server `loader`/`action`.** For client data use `clientLoader` and read with
   `useLoaderData<typeof clientLoader>()`. Server-only Remix exports are unavailable.
4. Navigate with Remix `<Link>` / `<NavLink>`, not raw `<a>`.

## Data fetching (API client)

All API calls go through `app/lib/api.ts` — never call `fetch` ad-hoc from a route.

- `apiGet(path)` / `apiWrite(method, path, body, opts?)` wrap `fetch` with `credentials:"include"`
  (session cookie), echo the non-httpOnly `csrf_token` cookie as the `x-csrf-token` header on
  writes, and add `Authorization: Bearer` from `VITE_API_TOKEN` when set.
- Failures throw `ApiError(status, message, path?)`. The `path` is the JSON Pointer from a 422
  validation error — routes map it to per-field highlights; map 409 to a concurrency banner.
- Fetch inside `clientLoader` (runs in the browser). Typed helpers live in `lib/api.ts`
  (resource records/types), `lib/agents.ts`, and `lib/skills.ts` (scan / audit / install).

## Schema-driven resource UI

A resource type's list, detail, create, and edit screens are **zero-code** — driven entirely by
the type's JSON Schema fetched from the API. The logic lives in `lib/schema.ts`:

- `formFields` / `listColumns` / `detailFields` derive ordered field descriptors from the schema
  (dropping system/auto-id/read-only fields as appropriate); `renderValue` formats a value for read.
- `resource-form.tsx` renders inputs by JSON-Schema kind: string→text, number/integer→number,
  boolean→checkbox, `enum`→select, `format: date`/`date-time`→date picker, array/object→JSON
  textarea (parse-checked), and `x-links`→`LinkCombobox`. `x-immutable` fields lock in edit mode.
- Validation is server-authoritative: render the API's 422 `path`/message, don't reimplement rules.

**To support a new field kind:** add detection in `resolveKind` (`lib/schema.ts`), a render case in
`resource-form.tsx`, and a `renderValue` case for the read side.

## Conventions

- Never call secure-context-only browser APIs directly. Production is served over plain HTTP from a
  LAN IP, where APIs such as `crypto.randomUUID` and `navigator.clipboard` are unavailable. Use
  `~/lib/uuid` and `~/lib/clipboard`, or add a guarded helper before introducing another API. The
  repository guard runs as `pnpm check:secure-context`; neither localhost nor jsdom reproduces this
  deployment context.

- shadcn primitives live in `app/components/ui` (app-local). `@tulipfarm/ui` remains the home for
  **cross-app** shared components (not used here).
- Reserve ruby (`--primary`) for brand/primary; coral/signal red (`--destructive`) for danger
  only — keep ruby on ≤10% of any screen. Containers `rounded-none`, interactive `rounded-sm/md`.
- Badge counts are **mocked** (`lib/badges.ts`) in the V1 shell — wire to the API downstream.
- **Never call secure-context-only browser APIs directly.** Prod is served over plain http from a
  LAN IP, a NON-secure context where `crypto.randomUUID`, `crypto.subtle`, `navigator.clipboard`,
  service workers, etc. are `undefined` and throw. Use `~/lib/uuid` (`randomUUID`) and
  `~/lib/clipboard` (`copyText`); add a guarded helper before reaching for a new one. Enforced by
  `pnpm check:secure-context` (CI, Lint job). Note that neither localhost dev nor the jsdom suite
  can reproduce this — both are always secure contexts.
- The API CORS-allows the web origin at `VITE_PORT` (default `:4000`); the API itself is `:4010`.

## Tests

Vitest with a dedicated `vitest.config.ts` (`@vitejs/plugin-react` + `jsdom`) — it must **not**
load the Remix Vite plugin. Colocate `*.test.tsx`. Components using `<Link>`/`<NavLink>`/`<Outlet>`
need a router context: wrap with `createRemixStub` from `@remix-run/testing`.

Known pre-existing issue: the `~/` path alias isn't resolved in web's vitest config, which can
cause widespread unrelated test failures. If web tests fail broadly and don't relate to your
change, verify against a clean baseline (main) before treating it as a regression you caused.

## Prod serving (nginx)

`pnpm --filter @tulipfarm/web build` emits `build/client/` (incl. `index.html`). Serve it static
with a history-API fallback so client routes resolve on refresh:

```nginx
root /srv/tulipfarm/web/build/client;
location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; try_files $uri =404; }
location /        { try_files $uri $uri/ /index.html; }
```
