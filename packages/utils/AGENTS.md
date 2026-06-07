# Utils — Agent Conventions

`@tulipfarm/utils` — shared pure utility functions. **Scaffold today:** `src/index.ts` is
`export {}`. tsconfig extends `@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

## Convention (when adding utilities)

- Pure functions only — no side effects, no app or I/O dependencies.
- Group by domain (`src/string.ts`, `src/array.ts`, `src/date.ts`, …); re-export from
  `src/index.ts`.
- Colocate `*.test.ts` and unit-test each function.
