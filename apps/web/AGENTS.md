# Web app

`@tulipfarm/web` is the Remix 2 SPA frontend on React 19 and Vite. It owns product routes,
client data loading, schema-driven resource UI, and browser rendering of Surface Artifacts.

## Read on / Skip

- **Read on if** you touch Remix routes, React screens, client loaders, browser API calls,
  schema-driven forms/tables, chat UI, navigation, theme, or Vite/Vitest web config.
- **Skip if** the task is API behavior ([`../api/AGENTS.md`](../api/AGENTS.md)), the shared
  rich-text editor ([`../../packages/editor/AGENTS.md`](../../packages/editor/AGENTS.md)), or
  Surface protocol contracts ([`../../packages/surface/AGENTS.md`](../../packages/surface/AGENTS.md)).

## Map

| Path | Owns |
| --- | --- |
| `app/root.tsx` | Document shell, no-flash theme script, fonts, HydrateFallback. |
| `app/app.css`, `app/tokens.css` | Tailwind v4 import, OKLCH tokens, `[data-theme]` variables. |
| `app/routes/` | Remix SPA routes under `_app`; Chat is `/`. |
| `app/components/` | App-local layout, state, resource, markdown, chat, and Surface components. |
| `app/components/activity/` | Filters, timeline, and detail panel for the merged Activity feed. |
| `app/components/design-guide/` | Section groups and shared wrappers for the development-only `/design-guide` route. |
| `app/components/settings/` | Panels mounted by `_app.settings.*` routes; the Memory panel is read-only by contract. |
| `app/components/farm/` | The `/farm` perspective tulip field canvas and its season/legend strips. |
| `app/components/ui/` | Vendored shadcn primitives for this app only. |
| `app/lib/api.ts` | API client with cookies, CSRF header, optional bearer token, `ApiError`. |
| `app/lib/schema.ts` | JSON-Schema field detection, list/detail/form metadata, value rendering. |
| `app/lib/chat/` | Chat SSE event types, parser, and timeline reducer. |
| `app/lib/surface/` | Tulip Surface Protocol browser integration. |
| `app/lib/agents.ts`, `app/lib/skills.ts` | Typed API wrappers for Agents and Skills. |
| `app/lib/farm.ts` | Crop metadata, the parallel Soul read behind `/farm`, and season thresholds. |
| `app/lib/activity-feed.ts` | Interleaves the Activity log and Runs keyset feeds into one newest-first timeline. |
| `app/lib/nav.ts`, `app/lib/badges.ts` | Sidebar navigation and mocked V1 badge counts. |
| `app/lib/kill-switches.ts` | Emergency-stop client; the scope picker is built from the API's enforceable list. |
| `components.json` | shadcn config. |
| `vite.config.ts`, `vitest.config.ts` | SPA Remix/Vite and jsdom Vitest config. |
| `public/`, `scripts/` | Static files and web-local scripts. |

## Rules

- Remix runs in SPA mode (`remix({ ssr: false })`): no server `loader` or `action`. Use
  `clientLoader` and `useLoaderData<typeof clientLoader>()`.
- Use Remix `<Link>` / `<NavLink>`, not raw `<a>` for app navigation.
- All API calls go through `app/lib/api.ts`; never call `fetch` ad hoc from routes.
- Gate admin UI on `isBusinessAdmin` / `useIsAdmin`, never on `user.role`: an access level granted
  from People & access confers admin authority without rewriting the account role. Operate items
  except Inbox are `adminOnly`; visibility comes from that session flag, not a GET per section.
- A section page's one `h1` comes from `SectionShell` and is `sr-only`, because the top bar already
  names the page. A route drilled into from a section names itself instead; `_app.business.access`
  covers its own tab children.
- `apiWrite` must send cookies, `x-csrf-token` from the non-httpOnly `csrf_token` cookie, and
  optional `Authorization: Bearer` from `VITE_API_TOKEN`.
- Render API validation errors from `ApiError.path` as field errors; map `409` to a concurrency
  banner. Do not duplicate server validation rules.
- Resource list/detail/create/edit screens are zero-code from JSON Schema. To add a field kind,
  update `resolveKind`, `resource-form.tsx`, and read-side `renderValue`.
- Never call secure-context-only browser APIs directly. Prod is plain HTTP on a LAN IP; use
  `~/lib/uuid`, `~/lib/clipboard`, or add a guarded helper. Guard: `pnpm check:secure-context`.
- Theme uses `[data-theme="dark"]` on `<html>`, not shadcn `.dark`; keep the no-flash init script.
- Keep design neutral, flat, compact, and hairline. Use coral `--primary` only for brand/primary
  and `--destructive` only for danger; prefer restrained `rounded-sm/md` surfaces.
- `app/components/ui` is app-local shadcn. A component only becomes shared once a second app needs
  it; there is no shared React package to reach for.
- Badge counts in `app/lib/badges.ts` are mocked in the V1 shell.
- `/farm` draws one tulip per Soul artifact. Everything it encodes must be a fact `app/lib/farm.ts`
  can point at — colour is kind from the `data-*` palette, the bed is that kind's real share, the
  head is a real dormant state, and position comes from a hash of the planting id, never
  `Math.random`. The canvas is `aria-hidden`, so `CropLegend` is the accessible counterpart and must
  keep publishing the same links.
- Only what the **business** made earns a tulip. Two API fields lie about this: every shipped skill
  reports `provenance: "bundled"` and every shipped integration reports `installed: true`. Count
  skills with `provenance !== "bundled"` and integrations with `status === "connected"`, or a brand
  new instance claims a farm it never planted.
- `/farm`'s skyline — treeline, windmill, barn — is scenery, not data: it is drawn only in
  `--muted-foreground`, never a crop colour. The two facts it does carry are the business name on
  the barn (unsigned when the instance has none) and sails that turn only while something is
  planted. It stands on `Field.skyY`, above the tallest bloom, and is dropped entirely when the
  crop leaves no headroom.
- `/farm` is full bleed: `FULL_BLEED_MODES` in `app/lib/nav.ts` suppresses its context panel and the
  collapse toggle. Add a mode there rather than special-casing `AppSidebar`.
- `?mock=N` on `/farm` draws a pretend field from `app/lib/farm.mock.ts`, for reviewing the visuals
  on an instance that has planted nothing. It is gated on `import.meta.env.DEV` and the page labels
  itself while it is on. Never import that module from the real load path.
- Web Vitest must use `vitest.config.ts` with `@vitejs/plugin-react` and jsdom, not the Remix Vite
  plugin. Components with Remix routing primitives need `createRemixStub`.
- Known issue: broad web test failures can come from `~/` alias resolution; compare with a clean
  baseline before treating unrelated failures as regressions.
- Production serves `build/client/` statically with a history-API fallback to `/index.html`.
- `pnpm build` writes `.br`/`.gz` siblings next to every compressible asset; the API serves them via
  `@fastify/static`'s `preCompressed`. Keep any new build step ordered after `remix vite:build`.
- `HydrateFallback` is prerendered into `index.html`, so it paints before any JS. Keep it static —
  no hooks, no data, no imports — and re-run the build so the CSP hashes stay in sync.

See [`DESIGN.md`](../../DESIGN.md) for component and design conventions. Token values stay
canonical in `app/tokens.css`.
