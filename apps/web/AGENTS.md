# Web App — Agent Conventions

`@tulipfarm/web` — Remix (v2) + React 19 + Vite frontend. Dev server on `:4000` (`VITE_PORT`).
See root `AGENTS.md` for monorepo commands, Biome rules, and git policy.

## Stack

- **Remix 2.17** via the Vite plugin — SSR + file-based routing. ESM (`"type": "module"`).
- **React 19** (`react` + `react-dom`).
- tsconfig extends `@tulipfarm/tsconfig/remix.json` (JSX `react-jsx`, DOM libs, bundler resolution).
- No CSS framework chosen yet — decide one before adding substantial UI (open decision).

## Structure

```
app/
  root.tsx        # SSR document shell: <Meta> <Links> <Outlet> <ScrollRestoration> <Scripts>
  routes/         # (add) file-based routes — does not exist yet
vite.config.ts    # Remix plugin; port via VITE_PORT (default 4000)
```

Only `app/root.tsx` exists today — this is greenfield, so establish patterns deliberately.

## Adding a route / page

1. Create `app/routes/<name>.tsx` using Remix's filename convention (`_index.tsx`,
   `dashboard.tsx`, `settings.profile.tsx` for nested/flat segments).
2. Export a default **component** for the UI; render child routes via `<Outlet />`.
3. For data, export a `loader` (and `action` for mutations) and read it with
   `useLoaderData<typeof loader>()`. Keep server-only code inside these — everything else
   ships to the client.
4. Navigate with Remix `<Link>` / `<Form>`, not raw `<a>` / `fetch`.

## Conventions

- Shared components belong in `@tulipfarm/ui` — add it as a `workspace:*` dependency when you
  need it (not wired yet).
- The API CORS-allows the web origin at `VITE_PORT` (default `:4000`); the API itself is `:4010`.

## Tests

Vitest (`vitest run --passWithNoTests`) — none yet. When adding components, set up
`@testing-library/react` + `jsdom` and colocate `*.test.tsx`.
