# Constants — Agent Conventions

`@tulipfarm/constants` — shared, environment-aware constants. tsconfig extends
`@tulipfarm/tsconfig/base.json`. Consumed by `@tulipfarm/soul`. See root `AGENTS.md` for
commands/lint.

Today it exports `BOT_GIT_NAME` and `BOT_GIT_EMAIL` (the soul bot's git identity).

## Convention

- Env-aware constants follow `export const X = process.env.X ?? "<default>";`.
- Export from `src/index.ts`; group by domain as the file grows.
- **No secrets here** — anything sensitive belongs in `@tulipfarm/secrets`. This package holds
  build-visible, non-sensitive defaults only.
