# Utils (`@tulipfarm/utils`)

Shared pure utility functions. It currently exposes only an empty `src/index.ts` barrel.

## Read on / Skip

- **Read on if** you add a side-effect-free helper used by multiple packages.
- **Skip if** the helper needs I/O, app state, or belongs to one package only.

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Public utility barrel; currently `export {}`. |

## Rules

- Pure functions only: no side effects, app imports, or I/O dependencies.
- Group by domain files such as `src/string.ts` or `src/date.ts`; re-export from `src/index.ts`.
- Colocate `*.test.ts` and unit-test each function.
