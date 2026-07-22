# Observability — Agent Conventions

`@tulipfarm/observability` — OTel conventions, metrics, health/readiness, correlation and
redaction helpers. **Today:** `src/ports/` defines the provider-neutral `TelemetryPort` and the
typed capability catalog (`CAPABILITY_IDS`, `CAPABILITY_CLASSIFICATIONS`,
`assertRequiredCapabilities`) that classifies the ten SPEC §22 backends required-vs-optional —
PostgreSQL is the sole correctness-critical capability. tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

This is a foundation package: it imports no other TulipFarm runtime package (see
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md)).
