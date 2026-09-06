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
| `app/components/page-shell.tsx`, `app/lib/page-chrome-context.tsx` | The one page frame; publishes its title and portals actions into the shell's single chrome bar. |
| `app/components/app-sidebar.tsx`, `app/components/sidebar-command.tsx` | The shell's one nav column and its ⌘K/`/` destination finder. |
| `app/components/agents/` | Roster list, row, capability panel, and starters for `/agents`. |
| `app/components/skills/` | Catalog, reach badge, capability/package/audience panels, marketplace browser. |
| `app/components/resources/` | Stat strip, catalog table, schema summary for `/resources`. |
| `app/components/routines/` | Catalog, row, canvas, run/dry-run, effects and bounds panels for `/routines`. |
| `app/components/integrations/` | Brand-tile card grid, vendored colour logos, the `···` menu, and the `?view=` preview sheet for `/integrations`. The one sanctioned card grid — see DESIGN.md "The integrations catalog". |
| `app/components/ui/` | Vendored shadcn primitives for this app only, plus `combobox.tsx` — hand-rolled, because `cmdk` forces its own input `id` and breaks `<label htmlFor>`. `select.tsx` is a thin native `<select>` wrapper; deprecated (see Rules), kept only until its 16 existing callers migrate. |
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
| `scripts/` | Post-build steps, in order: app-shell modulepreload injection, CSP hashing, precompression. |

## Rules

- **Never start a request from inside a state updater.** React may invoke an updater more than
  once for a single change, so `setState(prev => { post(...); ... })` fires the request twice — the
  chat composer stored every upload as two Files this way. Compute the next state purely, then do
  the work after `setState`. Read the current value from a ref when the decision needs it.

- **Documents render in the tab, never through a hosted viewer.** `files/office-embed.tsx` draws
  `.docx`/`.pptx` at full fidelity (lazily imported, falling back to `office-preview`'s outline).
  A hosted viewer — `gview`, Office Online — cannot reach a self-hosted instance, needs the File
  publicly downloadable, and ships private documents off the box. See that file's TSDoc.

- Remix runs in SPA mode (`remix({ ssr: false })`): no server `loader`/`action`, use
  `clientLoader` and `useLoaderData<typeof clientLoader>()`, and navigate with `<Link>`/`<NavLink>`
  from `~/components/ui/link`, never `@remix-run/react` — it prefetches on intent, and a
  `clientLoader` sits inside its route module, so module weight delays data, not just paint. Keep
  heavy leaves (Tiptap, transcript) split; assert on them with `findBy*`.
- API calls go through `app/lib/api.ts`, never ad-hoc `fetch`. `apiWrite` sends cookies,
  `x-csrf-token` from the `csrf_token` cookie, and optional `Authorization: Bearer` from
  `VITE_API_TOKEN`. Render `ApiError.path` as field errors and map `409` to a concurrency banner.
- Gate admin UI on `isBusinessAdmin`/`useIsAdmin`, never `user.role` — People & access grants admin
  authority without rewriting the role. Operator items except Inbox are `adminOnly`.
- Every route renders `PageShell` and names itself once via `title`; the shell publishes that
  string into the one 40px chrome bar and keeps one `sr-only` `h1`. Actions portal into the bar and
  must render in place when no slot exists. Never add a second bar or visible `h1`. The workspace
  is full-width with one shared set of gutters — empty, error and 404 included. Reading text,
  forms and focused tasks cap their own measure; dense lists, grids and canvases do not. Empty
  Chat centres its composer; after the first message, the same composer docks below the transcript.
- Theme is `[data-theme="dark"]` on `<html>`, not shadcn `.dark`; keep the no-flash init script.
  Keep design neutral, compact, hairline; depth is the four-step `--elevation-*` ladder and never
  an arbitrary `shadow-[…]`. `--primary` is near-black ink for the one committing action, coral
  `--brand` is identity only, `--destructive` danger only. `app/components/ui` is app-local shadcn until a second app needs it.
- Import icons through `components/icons.tsx`; that module must use `reicon-react/icons/*`, never
  the package barrel, which becomes a 16.6MB Vite dev prebundle. Keep Shiki behind the dynamic
  `import("./shiki")` boundary so blank Chat never optimizes syntax grammars.
- The sidebar has two contextual modes: `SIDEBAR_GROUPS` is what a reader *does*;
  `SETTINGS_GROUPS` replaces it on Settings-owned routes. Settings mode keeps the same shell,
  adds Back to app and local filtering, and `/settings` redirects to its first visible
  destination. Never add a rail or second shell column; deeper hierarchy stays in-page.
  Product headings are disclosures persisted under `sidebar-group:<heading>`, and that is the
  only thing allowed to hide a product destination — the 56px width collapse still hides none.
  No promotion or growth card interrupts either navigation mode.
  On desktop the sidebar is the quiet outer frame around one inset, rounded work surface; Search
  and New chat are icon controls in its header, Farm is pinned directly above Settings, and
  divider bands must not split its sections.
  `sidebar-command.tsx` searches destinations and open chats only;
  a row shows `+` only where `NavItem.create` names a real create route, and the link sits outside
  the `NavLink` so the row's accessible name stays the destination's.
- **Shape is the party rule.** A circle is somebody (person or Agent, `ui/avatar.tsx`'s `Avatar`);
  a square is a Team (`TeamAvatar`, keyed on the slug). Never a Team in a circle or a bare "Team"
  badge; never a squared-off person. `PartyAvatar` in `components/access/access-bits.tsx` applies
  this from a `Party` — extend it rather than branching on a principal prefix at a call site.
  DESIGN.md §9, *Component hierarchy*.
- Never use `ui/select.tsx` (a native `<select>`) for new dropdowns, even a short fixed list —
  it renders the OS's own unstyled popover, off-brand and un-themeable. Use `ui/combobox.tsx`'s
  `Combobox` instead, as `model-chains/model-sheet.tsx` does; for a closed enum (not free text
  like a model id), give it a `"code — label"` option list and validate `onCommit` against it,
  reverting unmatched input, the way `_app.business.profile.tsx`'s currency picker does. Existing
  `ui/select.tsx` callers are a migration backlog, not a precedent to copy.
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
  static (no hooks, data, imports), with only the outer frame and centered TulipFarm mark; never
  restore fake shell controls. Rebuild so the CSP hashes stay in sync. Anything editing
  `index.html` runs before `generate-csp-header.ts`, whose hashes would otherwise describe a stale
  file and refuse to boot.

See [`DESIGN.md`](../../DESIGN.md); tokens stay canonical in `app/tokens.css`.
