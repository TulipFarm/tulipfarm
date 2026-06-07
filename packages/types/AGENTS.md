# Types — Agent Conventions

`@tulipfarm/types` — shared TypeScript types. **Scaffold today:** `src/index.ts` is `export {}`.
Type-only — no runtime code, no build. tsconfig extends `@tulipfarm/tsconfig/base.json`.
See root `AGENTS.md` for commands/lint.

## Convention (when adding types)

- Group by domain in separate files (`src/auth.ts`, `src/soul.ts`, `src/llm.ts`, …) and
  re-export everything from `src/index.ts`.
- Consume with `import type { … } from "@tulipfarm/types"` (Biome's `useImportType`).
- Put a type here only when it's shared across packages; keep package-local types in-package.
