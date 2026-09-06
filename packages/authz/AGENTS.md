# Authz (`@tulipfarm/authz`)

Principals, roles, AccessGrants, guardrails, guests, JIT grants, approval binding, and
authority-intersection decision evidence.

## Read on / Skip

- **Read on if** you touch permission decisions, grants, roles, guardrails, or identity mapping.
- **Skip if** you need audit persistence (`../audit/AGENTS.md`) or route/session auth
  (`../../apps/api/AGENTS.md`).

## Map

| Path | Owns |
| --- | --- |
| `src/principals.ts`, `src/roles.ts`, `src/grants.ts` | Principal, role, and grant primitives. |
| `src/effective.ts` | Authority-intersection permission decisions. |
| `src/teams.ts` | Team lifecycle, membership, leave, and actor-capability invariants. |
| `src/team-authority.ts` | Live Team inheritance, evidence, and delegated assignment bounds. |
| `src/asset-ownership.ts` | Shared asset ownership, Team access projection, and owner Approval orchestration. |
| `src/guardrails/` | Guardrail policy, risk ceilings, DLP, and default-deny evaluation. |
| `src/approval/` | Approval intent binding and approver decision rules. |
| `src/ports/` | Provider-neutral identity resolution boundary. |
| `test/security-matrix/` | Security matrix fixtures. |

## Rules

- May import `@tulipfarm/schema` and `@tulipfarm/observability`; see
  [`dependency-rules.md`](../../docs/architecture/dependency-rules.md) and
  [`boundaries.md`](../../docs/architecture/boundaries.md).
- This package is the sole owner for authority-intersection decisions; do not reimplement them.
- Team service inputs carry already-resolved company and exact-Team admin capabilities; HTTP
  authorization remains outside this package.
- Team archive/delete delegates to the repository's atomic lifecycle transition; never add a
  separate asset-reference precheck.
