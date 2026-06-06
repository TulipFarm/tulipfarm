# API App — Agent Conventions

## Directory Structure

Each feature domain gets its own directory under `src/`:

```
src/
  auth/           # session, CSRF, users, API tokens
  secrets/        # secret storage
  soul/           # soul git operations (commit, push)
    resource-types/ # resource type CRUD
  migrations/     # data migrations
```

## Route Convention

Every feature directory has a single `routes.ts`:

```
<feature>/
  routes.ts       # registerXxxRoutes(app, deps, requireAuth)
  routes.test.ts  # vitest integration tests using buildApp + inject
  schemas.ts      # shared JSON Schema objects (if needed)
```

- Register function name: `register<Feature>Routes`
- Always accept `requireAuth: PreHandler` as last arg for protected routes
- Wire in `app.ts` inside `buildApp` — guarded by required dep checks

## Test Convention

Tests use `buildApp` + Fastify `inject`. Never spin a real server.

Fake dependencies implement the real interface (class, not `vi.fn()` object) for repos. For services without a defined interface (e.g. `GitSyncService`, `SoulLoader`), use a plain object with `vi.fn()` methods cast via `as unknown as T`.

Mock `node:fs` / `node:fs/promises` with `vi.mock` at the top of the test file when the route does filesystem I/O.

## Adding a New Feature

1. Create `src/<feature>/` directory
2. Add `routes.ts` with `registerXxxRoutes`
3. Add `routes.test.ts`
4. Import + wire in `app.ts` → add optional dep to `AppOptions` if needed
5. Pass dep from `index.ts` → `buildApp`
