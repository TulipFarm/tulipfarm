# Types (`@tulipfarm/types`)

Shared TypeScript-only types. It currently exposes only an empty `src/index.ts` barrel.

## Read on / Skip

- **Read on if** a type is shared across multiple packages.
- **Skip if** the type is local to one package; keep it with that package.

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Public type barrel; currently `export {}`. |

## Rules

- Type-only package: no runtime code.
- Group by domain in separate files and re-export from `src/index.ts`.
- Consumers should use `import type { ... } from "@tulipfarm/types"`.
