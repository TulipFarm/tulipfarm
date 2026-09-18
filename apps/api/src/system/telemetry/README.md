# Product telemetry

Deployment-local reporting of adoption and configured feature inventory.
The API gathers the inventory because it owns live Soul loading.
The Worker consumes the scheduled tick and calls the authenticated dispatcher.

## Files

- `compose.ts` adapts current Soul, user, native installation and public-origin readers.
- `routes.ts` declares administrator preferences and service-only dispatch.
- `schedule.ts` publishes a five-minute pg-boss tick in production.
- `routes.test.ts` verifies administrator gates, candidate preview and saved levels.

## Shared ownership

The event contract and reporter live in `@tulipfarm/observability`.
`ProductTelemetryStore` in `@tulipfarm/storage` owns the singleton database row.
Migration 123 creates that table.
No telemetry settings or identity files are written into the runtime Soul.

## Reporting policy

Level 0 sends one mandatory bootstrap after completed setup.
Level 1 adds daily aggregate counts.
Level 2 adds bounded names of configured items and connected providers.
The environment can narrow the saved optional level.
Empty environment values mean the documented defaults.
An invalid level narrows optional reporting to zero.
Only production sends requests; development still supports preview and preferences.

## Setup

The wizard records its optional choice atomically with reporter completion after setup.
Its request body is optional for compatibility with earlier clients.
New headless setup saves the environment default after creating its administrator.
Existing completed deployments initialize with optional sharing unconfigured.
A restart during the wizard does not complete telemetry setup.
Every internal tick reconciles the explicit completed-setup marker.
Recovery without a saved completion choice leaves optional sharing unconfigured.

## Delivery

The scheduled tick does not contain a payload.
The dispatcher prepares and commits at most one pending event before sending it.
Failed requests retain that event ID and bounded exponential backoff.
Missed snapshot periods coalesce into the next current snapshot.
The singleton row lock serializes replicas, delivery and preference changes.
The network attempt has a five-second abort and refuses redirects.
A downgrade removes pending optional data above the new effective level.
The last mandatory report remains available for administrator inspection.
Network errors never expose payloads, credentials or endpoint error details in logs.

## Inventory

Counts use loaded resource types, user agents and routines.
Available bundled Skills use the same enabled overlay as the product UI.
Seeded bundled names are excluded from user Skill counts and names.
Integration providers combine enabled MCP definitions, enabled native Slack connections,
and live GitHub installation state. Disabled MCP definitions, retired provider connections,
and catalog-only entries are not counted. MCP endpoint URLs, labels and account details are
not added to telemetry; the existing provider names and aggregate count fields are unchanged.
Inventories are sorted, deduplicated and truncated to the event byte ceiling.
