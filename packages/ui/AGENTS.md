# UI — Agent Conventions

`@tulipfarm/ui` — shared React component library. **Scaffold today:** `src/index.ts` is
`export {}`. React `18 || 19` is a peer dependency (consumers provide it). tsconfig extends
`@tulipfarm/tsconfig/remix.json`. No build step — consumers import source via the workspace.
See root `AGENTS.md` for commands/lint.

## Convention (when adding components)

- One directory per component: `src/<Component>/<Component>.tsx`, re-exported from the barrel
  `src/index.ts` (`export { Button } from "./Button"`).
- Colocate tests (`<Component>.test.tsx`) and any component-local styles.
- Keep components presentational and dependency-light — no app or server imports.
- Align the styling approach with `apps/web` once one is chosen (none yet).
