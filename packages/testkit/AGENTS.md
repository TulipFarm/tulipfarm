# Testkit — Agent Conventions

`@tulipfarm/testkit` provides deterministic helpers for tests across package boundaries. It is a
development-only package: production dependencies must never import it. See root `AGENTS.md` for
commands, formatting, and lint rules.

- Keep clocks, identifiers, scripts, and failure plans instance-local and deterministic.
- Make unscripted calls and undeclared failure boundaries fail loudly; never add silent fallbacks.
- Keep adapter fakes generic until their owning production contracts exist.
- Keep PostgreSQL helpers compatible with structural `pg` clients and PGlite.
- Never include protected payloads or Secrets in injected error messages.
