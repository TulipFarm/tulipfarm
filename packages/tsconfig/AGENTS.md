# tsconfig — Agent Conventions

`@tulipfarm/tsconfig` — shared TypeScript config bases. Config-only: no `src/`, no build, no
tests. Profiles are exposed via `package.json` `exports`. See root `AGENTS.md` for commands/lint.

## Profiles & actual usage

| File | Adds | Used by |
| --- | --- | --- |
| `base.json` | `strict`, ES2022 target/lib, `esModuleInterop`, `skipLibCheck`, `resolveJsonModule` | every `packages/*` library (`llm`, `soul`, `secrets`, `validation`, `types`, `utils`, `constants`) |
| `node.json` | base + `module` / `moduleResolution: NodeNext` | `apps/api` |
| `remix.json` | base + `jsx: react-jsx`, DOM libs, `module: ESNext`, `moduleResolution: bundler` | `apps/web`, `packages/ui` |

## Convention

- A consumer's `tsconfig.json` should `extends` exactly one profile and add only what's local.
- **Changing a profile affects every consumer above** — change deliberately and run a full
  `pnpm typecheck` before finishing.
- Add a new target as a new `<name>.json` and register it in `package.json` `exports`.
