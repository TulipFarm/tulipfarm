# Constants (`@tulipfarm/constants`)

Shared, environment-aware, non-sensitive constants and process-wide defaults.

## Read on / Skip

- **Read on if** you touch build-visible env defaults or shared Postgres pool tuning.
- **Skip if** a value is sensitive; use `../secrets/AGENTS.md` instead.

## Map

| Path | Owns |
| --- | --- |
| `src/index.ts` | Bot git identity, `DEPLOYMENT_BUSINESS_ID`, and public exports. |
| `src/pg-pool.ts` | Shared `pg` pool limits and timeout defaults. |

## Rules

- Env-aware constants follow `export const X = process.env.X ?? "<default>";`.
- No secrets here. This package holds build-visible, non-sensitive defaults only.
- `DEPLOYMENT_BUSINESS_ID` must stay shared by API and worker; an app may not import another app.
