# UI (`@tulipfarm/ui`)

Shared React component library. It currently exposes only an empty `src/index.ts` barrel.

## Read on / Skip

- **Read on if** you add reusable, presentational React components shared across surfaces.
- **Skip if** you build a product screen or route; use `../../apps/web/AGENTS.md` instead.

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Public component barrel; currently `export {}`. |

## Rules

- React `18 || 19` is a peer dependency; consumers provide it.
- Components go in `src/<Component>/<Component>.tsx` and re-export from `src/index.ts`.
- Colocate tests and component-local styles.
- Keep components presentational and dependency-light: no app or server imports.
- Align styling with `apps/web` once one is chosen.
