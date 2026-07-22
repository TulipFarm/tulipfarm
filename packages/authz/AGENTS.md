# Authz — Agent Conventions

`@tulipfarm/authz` — principals, custom roles, AccessGrants, field/destination/data/audience
guardrails, and authority-intersection decision evidence. **Today:** `src/ports/identity.ts`
defines the provider-neutral external identity resolution boundary. tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for
commands/lint.

May import: `@tulipfarm/schema`, `@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md) and
[`docs/architecture/boundaries.md`](../../docs/architecture/boundaries.md) for the full contract —
this package is the sole accountable owner for authority-intersection decisions; no other package
reimplements them.
