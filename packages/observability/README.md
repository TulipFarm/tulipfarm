# Observability

Shared operational observability and product-reporting contracts.
This foundation package imports no other TulipFarm runtime package.

## Operational telemetry

`src/ports/telemetry.ts` defines logging, counters and span ports.
`src/ai-export.ts` supplies dependency-free OTLP exporters.
`src/logs.ts` owns structured log metadata and redaction.
`src/resources.ts` samples process resource use.
Operational telemetry is configured and retained by the instance operator.
Product reports never forward operational traces or logs.

## Product telemetry

`src/product-telemetry.ts` is the versioned wire contract.
It contains the event types, field allowlists and URL sanitization.
The collector vendors this portable contract in its independent repository.
Contract changes require matching collector validation and compatibility tests.

Level 0 describes the instance at bootstrap, including business identity.
Level 1 adds daily counts; Level 2 adds bounded inventory names.
Inventory lists exclude Record contents, prompts and schema bodies.
The format rejects unknown properties instead of forwarding them.
The serialized size limit accounts for UTF-8 transport and UTF-16 Table properties.

`src/product-telemetry-reporter.ts` owns reporting policy and delivery orchestration.
It uses injected storage, metadata and inventory callbacks.
The API supplies local domain reads; the Worker triggers delivery.
The storage package persists deployment identity, preferences and pending reports.
The reporter never writes into the Soul.

## Runtime behavior

Production enables network delivery; development and tests do not report.
The deployment level caps the administrator's saved sharing choice.
New setup saves the choice before optional reports can be sent.
Existing installations need an explicit settings save for optional reports.
Bootstrap reporting is mandatory and has no application opt-out.
Collector outages cannot prevent startup or product operations.
Pending reports retain stable event identifiers across retries.
A downgrade removes pending optional data above the new level.

## Verification

Run `pnpm --filter @tulipfarm/observability test` from the repository root.
Run `pnpm --filter @tulipfarm/observability typecheck` for package types.
The contract suite exercises field allowlists, URL secrets and total size limits.
Reporter tests exercise persisted state, preferences, retries and failures.
PostgreSQL tests live with API migrations and use the migrated PGlite fixture.
Collector sink tests and deployment instructions live in telemetry-collector.

## Further reading

See `AGENTS.md` for ownership and binding package rules.
See `../../docs/plans/2026-09-14-product-telemetry-design.md` for the implementation plan.
See `../../apps/docs/content/docs/security/telemetry.mdx` for the public sharing policy.
