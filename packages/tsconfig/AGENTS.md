# tsconfig (`@tulipfarm/tsconfig`)

Shared TypeScript config bases. Config-only: no `src/`, build, or tests.

## Read on / Skip

- **Read on if** you change TS compiler profiles or add a new runtime target.
- **Skip if** you only need a consumer's local `tsconfig.json`; read that package's `AGENTS.md`.

## Map

| File | Adds | Used by |
| --- | --- | --- |
| `base.json` | Strict ES2022 base, interop, JSON. | `apps/docs`; base packages. |
| `node.json` | NodeNext module settings. | API, worker, integration worker apps. |
| `remix.json` | React JSX, DOM libs, bundler resolution. | web, editor, surface-web, ui. |
| `package.json` | Exports the profiles above. | All profile consumers. |

## Rules

- "Base packages" means every `packages/*` workspace except editor, surface-web, and ui.
- A consumer's `tsconfig.json` should extend exactly one profile and add only local settings.
- **Changing a profile affects every consumer above**; change deliberately and run full typecheck.
- Add a new target as `<name>.json` and register it in `package.json` `exports`.
