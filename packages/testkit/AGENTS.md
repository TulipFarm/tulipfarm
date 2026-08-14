# Testkit (`@tulipfarm/testkit`)

Deterministic helpers, fakes, and fixtures for tests across package boundaries.
Development-only: production dependencies must never import it.

## Read on / Skip

- **Read on if** you need shared test clocks, IDs, scripted fakes, failure injection, or PG helpers.
- **Skip if** the helper is production code or specific to one package's private tests.

## Map

| Path | Owns |
| --- | --- |
| `src/clock.ts`, `src/ids.ts` | Deterministic clocks and monotonic IDs. |
| `src/scripted.ts`, `src/failure.ts` | Scripted calls and failure injection. |
| `src/model.ts`, `src/tool.ts`, `src/integration-adapter.ts` | Generic adapter fakes. |
| `src/postgres.ts` | Structural `pg`/PGlite-compatible test helpers. |

## Rules

- Keep clocks, identifiers, scripts, and failure plans instance-local and deterministic.
- Make unscripted calls and undeclared failure boundaries fail loudly; never add silent fallbacks.
- Keep adapter fakes generic until their owning production contracts exist.
- Keep PostgreSQL helpers compatible with structural `pg` clients and PGlite.
- Never include protected payloads or Secrets in injected error messages.
