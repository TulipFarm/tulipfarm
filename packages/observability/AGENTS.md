# Observability (`@tulipfarm/observability`)

OTel conventions, metrics, health/readiness, redaction, logs, resilience, resource reporting,
and provider-neutral telemetry ports.

## Read on / Skip

- **Read on if** you touch telemetry, capability checks, readiness, log redaction, or resilience.
- **Skip if** you need app-specific logging calls or audit evidence (`../audit/AGENTS.md`).

## Map

| Path | Owns |
| --- | --- |
| `src/ports/` | `TelemetryPort` and capability catalog. |
| `src/logs.ts` | Structured log redaction helpers. |
| `src/resources.ts` | Resource metadata helpers. |
| `src/backpressure.ts`, `src/resilience.ts`, `src/prune.ts` | Operational health helpers. |

## Rules

- Foundation package: imports no other TulipFarm runtime package; see
  [`dependency-rules.md`](../../docs/architecture/dependency-rules.md).
- `CAPABILITY_IDS`, `CAPABILITY_CLASSIFICATIONS`, and `assertRequiredCapabilities` classify SPEC
  §22 backends; PostgreSQL is the sole correctness-critical capability.
