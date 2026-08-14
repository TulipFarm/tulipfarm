# Web app

`@tulipfarm/web` is the Remix 2 SPA frontend on React 19 and Vite. It owns product routes,
client data loading, schema-driven resource UI, and browser rendering of Surface Artifacts.

## Read on / Skip

- **Read on if** you touch Remix routes, React screens, client loaders, browser API calls,
  schema-driven forms/tables, chat UI, navigation, theme, or Vite/Vitest web config.
- **Skip if** the task is API behavior ([`../api/AGENTS.md`](../api/AGENTS.md)), shared React UI
  ([`../../packages/ui/AGENTS.md`](../../packages/ui/AGENTS.md)), or Surface protocol contracts
  ([`../../packages/surface/AGENTS.md`](../../packages/surface/AGENTS.md)).

## Map

| Path | Owns |
| --- | --- |
| `app/root.tsx` | Document shell, no-flash theme script, fonts, HydrateFallback. |
| `app/app.css`, `app/tokens.css` | Tailwind v4 import, OKLCH tokens, `[data-theme]` variables. |
| `app/routes/` | Remix SPA routes under `_app`; Chat is `/`. |
| `app/components/` | App-local layout, state, resource, markdown, chat, and Surface components. |
| `app/components/ui/` | Vendored shadcn primitives for this app only. |
| `app/lib/api.ts` | API client with cookies, CSRF header, optional bearer token, `ApiError`. |
| `app/lib/schema.ts` | JSON-Schema field detection, list/detail/form metadata, value rendering. |
| `app/lib/chat/` | Chat SSE event types, parser, and timeline reducer. |
| `app/lib/surface/` | Tulip Surface Protocol browser integration. |
| `app/lib/agents.ts`, `app/lib/skills.ts` | Typed API wrappers for Agents and Skills. |
| `app/lib/nav.ts`, `app/lib/badges.ts` | Sidebar navigation and mocked V1 badge counts. |
| `components.json` | shadcn config. |
| `vite.config.ts`, `vitest.config.ts` | SPA Remix/Vite and jsdom Vitest config. |
| `public/`, `scripts/` | Static files and web-local scripts. |

## Rules

- Remix runs in SPA mode (`remix({ ssr: false })`): no server `loader` or `action`. Use
  `clientLoader` and `useLoaderData<typeof clientLoader>()`.
- Use Remix `<Link>` / `<NavLink>`, not raw `<a>` for app navigation.
- All API calls go through `app/lib/api.ts`; never call `fetch` ad hoc from routes.
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
- `app/components/ui` is app-local shadcn. Put cross-app shared components in `@tulipfarm/ui`.
- Badge counts in `app/lib/badges.ts` are mocked in the V1 shell.
- Web Vitest must use `vitest.config.ts` with `@vitejs/plugin-react` and jsdom, not the Remix Vite
  plugin. Components with Remix routing primitives need `createRemixStub`.
- Known issue: broad web test failures can come from `~/` alias resolution; compare with a clean
  baseline before treating unrelated failures as regressions.
- Production serves `build/client/` statically with a history-API fallback to `/index.html`.

See [`.agents/skills/tulipfarm-design-system`](../../.agents/skills/tulipfarm-design-system) for
component and design conventions.
