# Web app

`@tulipfarm/web` is the Remix 2 SPA frontend on React 19 and Vite. It owns product routes, client
data loading, schema-driven resource UI, and browser rendering of Surface Artifacts.

## Read on / Skip

- **Read on if** you touch Remix routes, React screens, client loaders, browser API calls,
  schema-driven forms/tables, chat UI, navigation, theme, or Vite/Vitest config.
- **Skip if** the task is API behavior ([`../api`](../api/AGENTS.md)), the editor
  ([`editor`](../../packages/editor/AGENTS.md)), or Surface contracts ([`surface`](../../packages/surface/AGENTS.md)).

## Map

| Path | Owns |
| --- | --- |
| `app/root.tsx`, `app/app.css`, `app/tokens.css` | Document shell, no-flash theme script, fonts, HydrateFallback; Tailwind v4 OKLCH `[data-theme]` tokens. |
| `app/routes/` | Remix SPA routes under `_app`; Chat is `/`. |
| `app/components/activity/` | Filters, timeline, detail panel for the merged Activity feed. |
| `app/components/settings/` | Panels for `_app.settings.*`; the Memory panel is read-only by contract. |
| `app/components/farm/`, `app/lib/farm.ts` | `/farm` tulip canvas, season/legend strips, crop metadata, its parallel Soul read. |
| `app/components/page-shell.tsx` | The one page frame: breadcrumb, `h1`, meta, actions, width. Every route uses it. |
| `app/components/app-sidebar.tsx`, `app/components/sidebar-command.tsx` | The shell's one nav column and its ⌘K/`/` destination finder. |
| `app/components/agents/` | Roster list, row, capability panel, and starters for `/agents`. |
| `app/components/skills/` | Catalog, reach badge, capability/package/audience panels, marketplace browser. |
| `app/components/resources/` | Stat strip, catalog table, schema summary for `/resources`. |
| `app/components/routines/` | Catalog, row, canvas, run/dry-run, effects and bounds panels for `/routines`. |
| `app/components/integrations/` | Brand-tile card grid, vendored colour logos, the `···` menu, and the `?view=` preview sheet for `/integrations`. The one sanctioned card grid — see DESIGN.md "The integrations catalog". |
| `app/components/ui/` | Vendored shadcn primitives for this app only, plus `combobox.tsx` — hand-rolled, because `cmdk` forces its own input `id` and breaks `<label htmlFor>`. |
| `app/lib/api.ts` | API client with cookies, CSRF header, optional bearer token, `ApiError`. |
| `app/lib/schema.ts` | JSON-Schema field detection, list/detail/form metadata, value rendering, shared formatters. |
| `app/lib/resource-catalog.ts` | Joins types with record totals; derives the two-way link graph. |
| `app/lib/routines/` | `graph.ts` projects the canvas, `facts.ts` derives every stated fact, `dry-run.ts` drives `analyze`. |
| `app/lib/chat/`, `app/lib/surface/` | Chat SSE types/parser/reducer; Surface Protocol browser integration. |
| `app/lib/agents.ts`, `app/lib/skills.ts` | Typed API wrappers; `agent-capabilities.ts` and `skill-facts.ts` derive reach, capability facts, and grouping from declared frontmatter. |
| `app/lib/activity-feed.ts` | Interleaves the Activity log and Runs feeds into one newest-first timeline. |
| `app/lib/nav.ts`, `app/lib/badges.ts` | Flat sidebar/settings destinations, page titles, and mocked V1 badge counts. |
| `app/lib/kill-switches.ts` | Emergency-stop client; scope picker comes from the API's enforceable list. |
| `vite.config.ts`, `vitest.config.ts`, `components.json` | SPA Remix/Vite, jsdom Vitest, shadcn. |

## Rules

- Remix runs in SPA mode (`remix({ ssr: false })`): no server `loader`/`action`, use
  `clientLoader` and `useLoaderData<typeof clientLoader>()`, and navigate with `<Link>`/`<NavLink>`.
- API calls go through `app/lib/api.ts`, never ad-hoc `fetch`. `apiWrite` sends cookies,
  `x-csrf-token` from the `csrf_token` cookie, and optional `Authorization: Bearer` from
  `VITE_API_TOKEN`. Render `ApiError.path` as field errors and map `409` to a concurrency banner.
- Gate admin UI on `isBusinessAdmin`/`useIsAdmin`, never `user.role` — People & access grants admin
  authority without rewriting the role. Operator items except Inbox are `adminOnly`.
- Every route renders `PageShell` and names itself once via `title`; never a second `h1`. One
  column, `max-w-7xl`, on every page — empty, error and 404 included, which is why `EmptyState` is
  content and `ErrorState` renders the shell. Content caps its measure, never the page. A titled
  `Panel` names its own `<section>`; do not re-add `aria-labelledby` per feature.
- Theme is `[data-theme="dark"]` on `<html>`, not shadcn `.dark`; keep the no-flash init script.
  Keep design neutral, flat, compact, hairline; coral `--primary` is brand only, `--destructive`
  danger only. `app/components/ui` is app-local shadcn until a second app needs it.
- The sidebar is one flat list: `SIDEBAR_GROUPS` is what a reader *does*, `SETTINGS_GROUPS` what
  they *configure* via `/settings`. Never add a rail or second shell column; a section needing
  hierarchy owns it in-page, as `/knowledge` does. Headings are disclosures persisted under
  `sidebar-group:<heading>`, and that is the only thing allowed to hide a destination — the 56px
  width collapse still hides none. `sidebar-command.tsx` searches destinations and open chats only;
  a row shows `+` only where `NavItem.create` names a real create route, and the link sits outside
  the `NavLink` so the row's accessible name stays the destination's.
- Resource list/detail/create/edit are zero-code from JSON Schema; a new field kind means
  `resolveKind`, `resource-form.tsx`, and `renderValue`. A count the caller may not read is `null`
  and renders `—`, never `0`. See DESIGN.md §9, *Data grids*. Never call secure-context-only browser
  APIs (prod is plain HTTP on a LAN IP): use `~/lib/uuid` or `~/lib/clipboard`, guarded by
  `pnpm check:secure-context`.
- Declared frontmatter must reach the screen: Fastify strips whatever the *response* schema omits,
  so check it before calling anything a UI gap. Absent agent limits render *unrestricted*; absent
  Skill capabilities render *none declared* — a Skill widens no agent. DESIGN.md §9.
- `/farm` draws one tulip per Soul artifact and every visual must be a fact `app/lib/farm.ts` can
  point at: colour is kind, the bed is that kind's share, the head a real dormant state, position a
  hash of the planting id, never `Math.random`. The canvas is `aria-hidden`, so `CropLegend` must
  publish the same links; the skyline is scenery in `--muted-foreground`, never a crop colour.
  Only what the **business** made earns a tulip, and two API fields lie: shipped skills report
  `provenance: "bundled"`, integrations `installed: true` — count `provenance !== "bundled"` and
  `status === "connected"`. DEV-only `?mock=N` draws `app/lib/farm.mock.ts`.
- Vitest uses `vitest.config.ts` (`@vitejs/plugin-react` + jsdom), never the Remix Vite plugin;
  routing primitives need `createRemixStub`. Broad failures usually mean `~/` alias resolution.
- Production serves `build/client/` with a history-API fallback to `/index.html`; `pnpm build`
  writes the `.br`/`.gz` siblings `@fastify/static` serves via `preCompressed`, so order any new
  build step after `remix vite:build`. `HydrateFallback` is prerendered into `index.html` — keep it
  static (no hooks, data, imports) and rebuild so the CSP hashes stay in sync.

See [`DESIGN.md`](../../DESIGN.md); tokens stay canonical in `app/tokens.css`.
